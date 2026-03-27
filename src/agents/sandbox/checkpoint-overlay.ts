/**
 * OverlayFS-based checkpoint strategy for OpenClaw sandboxes.
 *
 * Instead of a full `docker commit` (which snapshots the entire container filesystem),
 * the overlay strategy captures only the files that changed since the container was
 * created — an incremental diff snapshot.
 *
 * ## Checkpoint creation
 * 1. Run `docker diff <container>` to obtain the list of changed paths (Added / Changed / Deleted).
 * 2. For added/changed paths, create a tar.gz archive **inside** the container via
 *    `docker exec <container> tar -czf /tmp/_openclaw_ckpt.tar.gz -C / <paths>` and then copy
 *    the archive to the host via `docker cp`.
 * 3. Store a JSON sidecar `<id>.meta.json` alongside the tar with the list of deleted paths so
 *    they can be removed on restore.
 *
 * ## Checkpoint restore
 * Restores the container to the state captured by a specific checkpoint.  Because each overlay
 * checkpoint only stores *changes* relative to the base container image, restore must replay
 * the full chain from root to target:
 *
 * 1. Stop and remove the current container.
 * 2. Recreate from the base image (the original image used when the container was created).
 * 3. Start the container.
 * 4. Walk the ancestry chain (root — target) and for each step:
 *    a. Copy the tar.gz into the container via `docker cp`.
 *    b. Extract it via `docker exec tar -xzf`.
 *    c. Remove any paths listed in the deleted-paths sidecar.
 *
 * ## Incremental chain
 * Each overlay entry stores a `parentCheckpointId` pointing to its parent in the chain.  The
 * chain is resolved at restore time from the registry.
 *
 * ## Performance
 * Only changed files are archived — for typical benchmark tasks this is orders of magnitude
 * smaller than a full docker commit snapshot.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { SANDBOX_CHECKPOINT_OVERLAY_DIR } from "./constants.js";
import { execDocker } from "./docker.js";

const log = createSubsystemLogger("sandbox/checkpoint-overlay");

/** Temp file path used inside the container during checkpoint creation/restore. */
const CONTAINER_TEMP_TAR = "/tmp/_openclaw_ckpt_overlay.tar.gz";

/** JSON sidecar stored alongside each overlay tar. */
export type OverlayMeta = {
  id: string;
  containerName: string;
  parentCheckpointId: string | null;
  deletedPaths: string[];
  changedPaths: string[];
  createdAtMs: number;
};

/** Result of a successful overlay checkpoint creation. */
export type OverlayCheckpointArtifact = {
  /** Path to the gzipped tar on the host filesystem. */
  tarPath: string;
  /** Path to the JSON sidecar metadata file. */
  metaPath: string;
  /** Size of the tar file in bytes. */
  sizeBytes: number;
  /** List of paths that were added or changed. */
  changedPaths: string[];
  /** List of paths that were deleted. */
  deletedPaths: string[];
};

/**
 * Returns the host directory used for overlay checkpoint artifacts for a given container.
 * Creates the directory if it does not already exist.
 */
async function ensureOverlayDir(containerName: string): Promise<string> {
  // Sanitize container name for use as a directory name component.
  const safeName = containerName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = path.join(SANDBOX_CHECKPOINT_OVERLAY_DIR, safeName);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Parses the output of `docker diff <container>`.
 *
 * Each line is of the form:
 *   A /path/to/added/file
 *   C /path/to/changed/file
 *   D /path/to/deleted/file
 */
function parseDiffOutput(stdout: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const type = line[0];
    const filePath = line.slice(2).trim();
    if (!filePath) {
      continue;
    }
    if (type === "A" || type === "C") {
      changed.push(filePath);
    } else if (type === "D") {
      deleted.push(filePath);
    }
  }
  return { changed, deleted };
}

/**
 * Creates an overlay checkpoint for the given container.
 *
 * Runs `docker diff` to get the list of changed files, then creates a tar archive
 * inside the container using `docker exec tar` and copies it to the host with
 * `docker cp`. This produces a valid POSIX tar in a single pass — no stream
 * concatenation issues.
 *
 * @param containerName - Running container to checkpoint.
 * @param checkpointId  - UUID for this checkpoint (caller supplies for registry consistency).
 * @param parentCheckpointId - ID of the parent checkpoint in the incremental chain, or null for root.
 * @returns Artifact metadata, or null if creation failed or no changes exist.
 */
export async function createOverlayCheckpoint(
  containerName: string,
  checkpointId: string,
  parentCheckpointId: string | null,
): Promise<OverlayCheckpointArtifact | null> {
  // 1. Get the diff.
  let diffResult: { stdout: string };
  try {
    diffResult = await execDocker(["diff", containerName]);
  } catch (err) {
    log.warn(`docker diff failed for container=${containerName}: ${String(err)}`);
    return null;
  }

  const { changed, deleted } = parseDiffOutput(diffResult.stdout);

  // If nothing changed and nothing was deleted, there is nothing to snapshot.
  if (changed.length === 0 && deleted.length === 0) {
    log.debug(`No changes detected for container=${containerName}; skipping overlay checkpoint.`);
    return null;
  }

  const overlayDir = await ensureOverlayDir(containerName);
  const tarPath = path.join(overlayDir, `${checkpointId}.tar.gz`);
  const metaPath = path.join(overlayDir, `${checkpointId}.meta.json`);

  // 2. Create the tar archive inside the container using `docker exec tar` and copy it out.
  //    Strip leading slashes so paths are relative to the `-C /` root.
  if (changed.length > 0) {
    try {
      const relPaths = changed.map((p) => (p.startsWith("/") ? p.slice(1) : p));

      // Build the archive inside the container.
      await execDocker([
        "exec",
        containerName,
        "tar",
        "-czf",
        CONTAINER_TEMP_TAR,
        "--ignore-failed-read",
        "-C",
        "/",
        ...relPaths,
      ]);

      // Copy the archive from the container to the host filesystem.
      await execDocker(["cp", `${containerName}:${CONTAINER_TEMP_TAR}`, tarPath]);

      // Remove the temp file inside the container.
      await execDocker(["exec", containerName, "rm", "-f", CONTAINER_TEMP_TAR], {
        allowFailure: true,
      });
    } catch (err) {
      log.warn(`Overlay tar creation failed for container=${containerName}: ${String(err)}`);
      await fs.unlink(tarPath).catch(() => undefined);
      return null;
    }
  }

  // 3. Measure the tar size (0 if no changed files).
  let sizeBytes = 0;
  if (changed.length > 0) {
    try {
      const stat = await fs.stat(tarPath);
      sizeBytes = stat.size;
    } catch {
      sizeBytes = 0;
    }
  }

  // 4. Write the sidecar metadata.
  const meta: OverlayMeta = {
    id: checkpointId,
    containerName,
    parentCheckpointId,
    deletedPaths: deleted,
    changedPaths: changed,
    createdAtMs: Date.now(),
  };
  try {
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  } catch (err) {
    log.warn(`Failed to write overlay meta for container=${containerName}: ${String(err)}`);
    await fs.unlink(tarPath).catch(() => undefined);
    return null;
  }

  log.debug(
    `Overlay checkpoint created: id=${checkpointId} container=${containerName} changed=${changed.length} deleted=${deleted.length} sizeBytes=${sizeBytes}`,
  );

  return { tarPath, metaPath, sizeBytes, changedPaths: changed, deletedPaths: deleted };
}

/**
 * Reads the sidecar metadata for an overlay checkpoint.
 */
export async function readOverlayMeta(
  containerName: string,
  checkpointId: string,
): Promise<OverlayMeta | null> {
  try {
    const overlayDir = await ensureOverlayDir(containerName);
    const metaPath = path.join(overlayDir, `${checkpointId}.meta.json`);
    const raw = await fs.readFile(metaPath, "utf-8");
    return JSON.parse(raw) as OverlayMeta;
  } catch {
    return null;
  }
}

/**
 * Applies a single overlay checkpoint layer to a running container.
 *
 * 1. Copies the tar archive from the host into the container and extracts it via `docker exec tar`.
 * 2. Removes any deleted paths listed in the sidecar metadata.
 */
async function applyOverlayLayer(
  containerName: string,
  checkpointId: string,
  overlayDir: string,
): Promise<boolean> {
  const tarPath = path.join(overlayDir, `${checkpointId}.tar.gz`);
  const metaPath = path.join(overlayDir, `${checkpointId}.meta.json`);

  // Read metadata to get the list of deleted paths.
  let meta: OverlayMeta | null = null;
  try {
    const raw = await fs.readFile(metaPath, "utf-8");
    meta = JSON.parse(raw) as OverlayMeta;
  } catch {
    log.warn(`Could not read overlay meta for checkpoint=${checkpointId}; skipping deletions.`);
  }

  // Copy tar back in if it exists (may be absent when there were no changed files).
  let tarExists = false;
  try {
    await fs.access(tarPath);
    tarExists = true;
  } catch {
    tarExists = false;
  }

  if (tarExists) {
    try {
      // Copy the archive from the host into the container.
      await execDocker(["cp", tarPath, `${containerName}:${CONTAINER_TEMP_TAR}`]);

      // Extract the archive relative to the container root.
      await execDocker(["exec", containerName, "tar", "-xzf", CONTAINER_TEMP_TAR, "-C", "/"]);

      // Remove the temp file inside the container.
      await execDocker(["exec", containerName, "rm", "-f", CONTAINER_TEMP_TAR], {
        allowFailure: true,
      });
    } catch (err) {
      log.warn(
        `Failed to apply overlay tar for checkpoint=${checkpointId} container=${containerName}: ${String(err)}`,
      );
      return false;
    }
  }

  // Remove deleted paths.
  if (meta && meta.deletedPaths.length > 0) {
    for (const deletedPath of meta.deletedPaths) {
      try {
        await execDocker(["exec", containerName, "rm", "-rf", deletedPath], {
          allowFailure: true,
        });
      } catch {
        // Non-fatal: the path may already be absent.
      }
    }
  }

  return true;
}

/**
 * Restores a container to the state captured by an overlay checkpoint chain.
 *
 * The restore algorithm:
 * 1. Stop and remove the running container.
 * 2. Recreate it from the base image and start it.
 * 3. Apply each overlay layer in the chain in order (root to target).
 *
 * @param containerName     - Name of the container to restore.
 * @param targetCheckpointId - ID of the checkpoint to restore to.
 * @param baseImageRef      - The original Docker image used to create the container.
 * @param dockerRunArgs     - Additional `docker create` arguments (e.g. port/volume bindings).
 * @param chain             - Full ordered list of checkpoint IDs from root (index 0) to target
 *                            (last element), as resolved by the caller from the registry.
 */
export async function restoreOverlayCheckpoint(params: {
  containerName: string;
  targetCheckpointId: string;
  baseImageRef: string;
  dockerRunArgs?: string[];
  /** Ordered chain: [root, ..., target]. */
  chain: string[];
}): Promise<boolean> {
  const { containerName, baseImageRef, dockerRunArgs = [], chain } = params;

  if (chain.length === 0) {
    log.warn(`Empty overlay chain for container=${containerName}; cannot restore.`);
    return false;
  }

  // 1. Stop the running container (ignore if already stopped).
  await execDocker(["stop", containerName], { allowFailure: true });

  // 2. Remove the current container.
  try {
    await execDocker(["rm", containerName]);
  } catch (err) {
    log.warn(`docker rm failed for container=${containerName}: ${String(err)}`);
    return false;
  }

  // 3. Recreate from the base image.
  try {
    await execDocker(["create", "--name", containerName, ...dockerRunArgs, baseImageRef]);
    await execDocker(["start", containerName]);
  } catch (err) {
    log.warn(
      `Failed to recreate container=${containerName} from image=${baseImageRef}: ${String(err)}`,
    );
    return false;
  }

  // 4. Apply each overlay layer in order from root to target.
  const overlayDir = await ensureOverlayDir(containerName);
  for (const layerId of chain) {
    const ok = await applyOverlayLayer(containerName, layerId, overlayDir);
    if (!ok) {
      log.warn(
        `Overlay restore aborted at layer=${layerId} container=${containerName}: layer apply failed.`,
      );
      return false;
    }
  }

  log.debug(
    `Overlay checkpoint restored: target=${params.targetCheckpointId} container=${containerName} layers=${chain.length}`,
  );
  return true;
}

/**
 * Removes the overlay tar and sidecar meta files for a checkpoint from the host filesystem.
 * Non-fatal — logs warnings on failure.
 */
export async function removeOverlayArtifacts(
  containerName: string,
  checkpointId: string,
): Promise<void> {
  try {
    const overlayDir = await ensureOverlayDir(containerName);
    const tarPath = path.join(overlayDir, `${checkpointId}.tar.gz`);
    const metaPath = path.join(overlayDir, `${checkpointId}.meta.json`);
    await Promise.all([
      fs.unlink(tarPath).catch(() => undefined),
      fs.unlink(metaPath).catch(() => undefined),
    ]);
  } catch (err) {
    log.warn(`Failed to remove overlay artifacts for checkpoint=${checkpointId}: ${String(err)}`);
  }
}

/**
 * Detects whether the container runtime supports OverlayFS-based checkpointing by
 * verifying that `docker diff` succeeds on the given container.
 *
 * Used by the `"auto"` strategy resolver.
 *
 * @param containerName - A running container name to probe.
 * @returns `true` if `docker diff` succeeds (overlay is supported), `false` otherwise.
 */
export async function isOverlaySupported(containerName: string): Promise<boolean> {
  try {
    await execDocker(["diff", containerName]);
    return true;
  } catch {
    return false;
  }
}
