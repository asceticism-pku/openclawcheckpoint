import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  saveMemorySnapshot,
  restoreMemorySnapshot,
  removeMemorySnapshot,
} from "./checkpoint-memory.js";
import {
  createOverlayCheckpoint,
  isOverlaySupported,
  removeOverlayArtifacts,
  restoreOverlayCheckpoint,
} from "./checkpoint-overlay.js";
import {
  addCheckpointEntry,
  listCheckpoints,
  pruneByTotalSize,
  pruneCheckpointsAfter,
  pruneOldCheckpoints,
  removeCheckpointEntry,
} from "./checkpoint-registry.js";
import type { CheckpointConfig, CheckpointEntry, CheckpointStrategy } from "./checkpoint-types.js";
import { execDocker } from "./docker.js";

const log = createSubsystemLogger("sandbox/checkpoint");

/** Default configuration values for checkpoints. */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: false,
  strategy: "docker-commit",
  onlyMutating: true,
  maxSnapshots: 10,
  ttlMs: 3_600_000, // 1 hour
  skipTools: ["read", "browser", "web_search"],
};

/** Tools that are considered mutating (modify container filesystem or state). */
const MUTATING_TOOLS = new Set([
  "exec",
  "bash",
  "write",
  "edit",
  "apply_patch",
  "process",
  "nodes",
]);

/** Returns true if the named tool mutates container state. */
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName.trim().toLowerCase());
}

/** Resolve CheckpointConfig with defaults applied. */
export function resolveCheckpointConfig(cfg?: Partial<CheckpointConfig>): CheckpointConfig {
  return {
    enabled: cfg?.enabled ?? DEFAULT_CHECKPOINT_CONFIG.enabled,
    strategy: cfg?.strategy ?? DEFAULT_CHECKPOINT_CONFIG.strategy,
    onlyMutating: cfg?.onlyMutating ?? DEFAULT_CHECKPOINT_CONFIG.onlyMutating,
    maxSnapshots: cfg?.maxSnapshots ?? DEFAULT_CHECKPOINT_CONFIG.maxSnapshots,
    ttlMs: cfg?.ttlMs ?? DEFAULT_CHECKPOINT_CONFIG.ttlMs,
    skipTools: cfg?.skipTools ?? DEFAULT_CHECKPOINT_CONFIG.skipTools,
    checkpointStride: cfg?.checkpointStride ?? 1,
    adaptiveStride: cfg?.adaptiveStride ?? false,
    maxTotalSizeBytes: cfg?.maxTotalSizeBytes,
    memoryCheckpoint: cfg?.memoryCheckpoint ?? true,
  };
}

/**
 * Resolves the effective checkpoint strategy to use.
 *
 * - `"docker-commit"` / `"criu"`: returned as-is (criu remains unimplemented; callers handle it).
 * - `"overlay"`: returned as-is.
 * - `"auto"`: probe the container to decide.  Uses `overlay` when supported, otherwise
 *   falls back to `docker-commit`.
 */
export async function resolveEffectiveStrategy(
  strategy: CheckpointStrategy,
  containerName: string,
): Promise<"docker-commit" | "overlay" | "criu"> {
  if (strategy === "auto") {
    const supported = await isOverlaySupported(containerName);
    return supported ? "overlay" : "docker-commit";
  }
  if (strategy === "overlay" || strategy === "docker-commit" || strategy === "criu") {
    return strategy;
  }
  // Fallback for any future values.
  return "docker-commit";
}

type CreateCheckpointParams = {
  containerName: string;
  sessionKey: string;
  toolCallId: string;
  toolName: string;
  phase: "before" | "after";
  config: CheckpointConfig;
  /** Human/agent-readable label for this checkpoint. */
  label?: string;
  /** Source of this checkpoint creation. */
  source?: "auto" | "agent" | "user";
  /** Agent's description of the state at this checkpoint. */
  description?: string;
};

/**
 * Creates a checkpoint using the configured strategy.
 *
 * Supports `"docker-commit"` (full filesystem snapshot) and `"overlay"`
 * (incremental diff snapshot). The `"auto"` strategy is resolved to one of
 * these based on runtime capability detection.
 *
 * When `config.memoryCheckpoint` is true (the default), also saves the
 * in-memory session state in parallel with the container snapshot.
 *
 * Returns the CheckpointEntry or null if skipped.
 */
export async function createCheckpoint(
  params: CreateCheckpointParams,
): Promise<CheckpointEntry | null> {
  const { containerName, sessionKey, toolCallId, toolName, phase, config } = params;

  if (!config.enabled) {
    return null;
  }

  const normalizedToolName = toolName.trim().toLowerCase();

  if (config.onlyMutating && !isMutatingTool(normalizedToolName)) {
    return null;
  }

  if (config.skipTools.some((t) => t.trim().toLowerCase() === normalizedToolName)) {
    return null;
  }

  // Resolve strategy (handles "auto").
  const effectiveStrategy = await resolveEffectiveStrategy(config.strategy, containerName);

  if (effectiveStrategy === "criu") {
    log.warn(`Checkpoint strategy "criu" is not implemented; skipping.`);
    return null;
  }

  const id = randomUUID();

  let entry: CheckpointEntry;

  if (effectiveStrategy === "overlay") {
    // Find the most recent checkpoint for this container to use as parent in the chain.
    const existing = await listCheckpoints(containerName);
    existing.sort((a, b) => b.createdAtMs - a.createdAtMs);
    const parentCheckpointId = existing[0]?.id ?? null;

    // Run container snapshot and memory snapshot in parallel.
    const [artifact, memorySnapshotPath] = await Promise.all([
      createOverlayCheckpoint(containerName, id, parentCheckpointId),
      config.memoryCheckpoint !== false
        ? saveMemorySnapshot(containerName, id, sessionKey)
        : Promise.resolve(null),
    ]);

    if (!artifact) {
      // No changes detected — nothing to snapshot.
      log.debug(
        `Overlay checkpoint skipped (no changes): container=${containerName} tool=${normalizedToolName}`,
      );
      return null;
    }

    entry = {
      id,
      containerName,
      sessionKey,
      toolCallId,
      toolName: normalizedToolName,
      phase,
      createdAtMs: Date.now(),
      // For overlay checkpoints, snapshotRef holds the base image name used to
      // recreate the container on restore. We store the *current* image so
      // restore can recreate from the same base.
      snapshotRef: `overlay:${containerName}`,
      strategy: "overlay",
      restorable: true,
      parentCheckpointId: parentCheckpointId ?? undefined,
      sizeBytes: artifact.sizeBytes,
      ...(memorySnapshotPath ? { memorySnapshotPath } : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      source: params.source ?? "auto",
    };
  } else {
    // docker-commit strategy: full filesystem snapshot.
    const snapshotRef = `openclaw-ckpt:${id}`;

    // Run docker commit and memory snapshot in parallel when memoryCheckpoint is enabled.
    let commitErr: unknown = null;
    const [, memorySnapshotPath] = await Promise.all([
      execDocker(["commit", containerName, snapshotRef]).catch((err) => {
        commitErr = err;
        return null;
      }),
      config.memoryCheckpoint !== false
        ? saveMemorySnapshot(containerName, id, sessionKey)
        : Promise.resolve(null),
    ]);

    if (commitErr) {
      const errMsg = commitErr instanceof Error ? commitErr.message : "unknown error";
      log.warn(
        `docker commit failed for container=${containerName} snapshot=${snapshotRef}: ${errMsg}`,
      );
      return null;
    }

    entry = {
      id,
      containerName,
      sessionKey,
      toolCallId,
      toolName: normalizedToolName,
      phase,
      createdAtMs: Date.now(),
      snapshotRef,
      strategy: "docker-commit",
      restorable: true,
      ...(memorySnapshotPath ? { memorySnapshotPath } : {}),
      ...(params.label !== undefined ? { label: params.label } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      source: params.source ?? "auto",
    };
  }

  try {
    await addCheckpointEntry(entry);
  } catch (err) {
    log.warn(`Failed to persist checkpoint entry id=${id}: ${String(err)}`);
    // Still return the entry — the snapshot was created successfully.
  }

  // Prune by count/TTL.
  try {
    const pruned = await pruneOldCheckpoints(containerName, config);
    await Promise.all(pruned.map((p) => removeCheckpointArtifacts(p)));
  } catch (err) {
    log.warn(`Checkpoint pruning failed for container=${containerName}: ${String(err)}`);
  }

  // Prune by total size budget if configured.
  if (config.maxTotalSizeBytes != null) {
    try {
      const pruned = await pruneByTotalSize(containerName, config.maxTotalSizeBytes);
      await Promise.all(pruned.map((p) => removeCheckpointArtifacts(p)));
    } catch (err) {
      log.warn(`Size-based pruning failed for container=${containerName}: ${String(err)}`);
    }
  }

  log.debug(
    `Checkpoint created: id=${id} strategy=${effectiveStrategy} container=${containerName} tool=${normalizedToolName} phase=${phase}`,
  );

  return entry;
}

type RestoreCheckpointParams = {
  id: string;
  containerName: string;
  /** Docker create args (excluding image) used to recreate the container. */
  dockerRunArgs?: string[];
  /** Original base image for the container. Required when restoring overlay checkpoints. */
  baseImageRef?: string;
};

/**
 * Restores container state from a checkpoint.
 *
 * Supports both `docker-commit` and `overlay` strategies.
 * When `memorySnapshotPath` is present in the entry, also restores the
 * in-memory session state.
 */
export async function restoreCheckpoint(params: RestoreCheckpointParams): Promise<boolean> {
  const { id, containerName } = params;

  const checkpoints = await listCheckpoints(containerName);
  const entry = checkpoints.find((c) => c.id === id);
  if (!entry) {
    log.warn(`Checkpoint not found: id=${id} container=${containerName}`);
    return false;
  }

  if (!entry.restorable) {
    log.warn(`Checkpoint is not restorable: id=${id} container=${containerName}`);
    return false;
  }

  let containerRestored = false;

  if (entry.strategy === "docker-commit") {
    containerRestored = await restoreDockerCommitCheckpoint(entry, params.dockerRunArgs);
  } else if (entry.strategy === "overlay") {
    containerRestored = await restoreOverlayCheckpointEntry(entry, checkpoints, params);
  } else {
    log.warn(
      `Restore strategy "${entry.strategy}" is not implemented: id=${id} container=${containerName}`,
    );
    return false;
  }

  if (!containerRestored) {
    return false;
  }

  // Restore in-memory session state if snapshot is available.
  if (entry.memorySnapshotPath) {
    const memOk = await restoreMemorySnapshot(entry.memorySnapshotPath).catch((err) => {
      log.warn(`Memory snapshot restore failed: ${String(err)}`);
      return false;
    });
    if (!memOk) {
      // Non-fatal: container was restored successfully; just log.
      log.warn(`Memory snapshot restore failed for checkpoint id=${id}; continuing.`);
    }
  }

  // Prune checkpoints created after this one (they are now invalid).
  try {
    const pruned = await pruneCheckpointsAfter(containerName, entry.createdAtMs);
    await Promise.all(pruned.map((p) => removeCheckpointArtifacts(p)));
  } catch (err) {
    log.warn(`Post-restore pruning failed for container=${containerName}: ${String(err)}`);
  }

  log.debug(`Checkpoint restored: id=${id} strategy=${entry.strategy} container=${containerName}`);
  return true;
}

/** Restores a docker-commit checkpoint. */
async function restoreDockerCommitCheckpoint(
  entry: CheckpointEntry,
  dockerRunArgs?: string[],
): Promise<boolean> {
  try {
    // Stop the running container (ignore failure — it may already be stopped).
    await execDocker(["stop", entry.containerName], { allowFailure: true });

    // Remove the current container.
    await execDocker(["rm", entry.containerName]);

    // Recreate the container from the committed snapshot image.
    const runArgs = dockerRunArgs ?? [];
    await execDocker(["create", "--name", entry.containerName, ...runArgs, entry.snapshotRef]);
    await execDocker(["start", entry.containerName]);
    return true;
  } catch (err) {
    log.warn(
      `Failed to restore docker-commit checkpoint id=${entry.id} container=${entry.containerName}: ${String(err)}`,
    );
    return false;
  }
}

/** Restores an overlay checkpoint by replaying the full ancestor chain. */
async function restoreOverlayCheckpointEntry(
  target: CheckpointEntry,
  allCheckpoints: CheckpointEntry[],
  params: RestoreCheckpointParams,
): Promise<boolean> {
  // Build the ancestor chain from root to target.
  const chain: string[] = [];
  let current: CheckpointEntry | undefined = target;
  while (current) {
    chain.unshift(current.id);
    const parentId: string | undefined = current.parentCheckpointId;
    if (!parentId) {
      break;
    }
    current = allCheckpoints.find((c) => c.id === parentId);
  }

  // Determine the base image: prefer caller-supplied, then derive from snapshotRef.
  // For overlay checkpoints, snapshotRef is `overlay:<containerName>` by convention;
  // we need the actual Docker image.  Callers should pass baseImageRef when available.
  const baseImageRef =
    params.baseImageRef ??
    // Fall back: attempt to inspect the container to get its image.
    (await resolveContainerImage(target.containerName));

  if (!baseImageRef) {
    log.warn(
      `Cannot determine base image for overlay restore: id=${target.id} container=${target.containerName}`,
    );
    return false;
  }

  return restoreOverlayCheckpoint({
    containerName: target.containerName,
    targetCheckpointId: target.id,
    baseImageRef,
    dockerRunArgs: params.dockerRunArgs,
    chain,
  });
}

/** Attempts to determine the image a container is running from via `docker inspect`. */
async function resolveContainerImage(containerName: string): Promise<string | null> {
  try {
    const result = await execDocker(["inspect", "--format", "{{.Config.Image}}", containerName]);
    const image = result.stdout.trim();
    return image || null;
  } catch (err) {
    log.debug(`docker inspect failed for container=${containerName}: ${String(err)}`);
    return null;
  }
}

/** Returns the most recent restorable checkpoint for the given container. */
export async function findLastSuccessfulCheckpoint(
  containerName: string,
): Promise<CheckpointEntry | null> {
  const checkpoints = await listCheckpoints(containerName);
  const restorable = checkpoints.filter((c) => c.restorable);
  if (restorable.length === 0) {
    return null;
  }
  // Return the most recently created
  restorable.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return restorable[0] ?? null;
}

/** Removes a committed Docker image used by a checkpoint. */
export async function removeCheckpointImage(snapshotRef: string): Promise<void> {
  try {
    await execDocker(["rmi", snapshotRef]);
  } catch (err) {
    log.warn(`Failed to remove checkpoint image ${snapshotRef}: ${String(err)}`);
  }
}

/**
 * Removes all artifacts associated with a checkpoint entry
 * (Docker image for docker-commit, overlay tar/meta for overlay, and memory snapshot).
 */
async function removeCheckpointArtifacts(entry: CheckpointEntry): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (entry.strategy === "docker-commit") {
    tasks.push(removeCheckpointImage(entry.snapshotRef));
  } else if (entry.strategy === "overlay") {
    tasks.push(removeOverlayArtifacts(entry.containerName, entry.id));
  }

  if (entry.memorySnapshotPath) {
    tasks.push(removeMemorySnapshot(entry.memorySnapshotPath));
  }

  tasks.push(
    removeCheckpointEntry(entry.id).catch((rmErr) => {
      log.warn(`Failed to remove checkpoint entry id=${entry.id}: ${String(rmErr)}`);
    }),
  );

  await Promise.all(tasks);
}
