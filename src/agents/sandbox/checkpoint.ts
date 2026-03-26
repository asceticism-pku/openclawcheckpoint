import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  addCheckpointEntry,
  listCheckpoints,
  pruneCheckpointsAfter,
  pruneOldCheckpoints,
  removeCheckpointEntry,
} from "./checkpoint-registry.js";
import type { CheckpointConfig, CheckpointEntry } from "./checkpoint-types.js";
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
  if (!cfg) {
    return { ...DEFAULT_CHECKPOINT_CONFIG };
  }
  return {
    enabled: cfg.enabled ?? DEFAULT_CHECKPOINT_CONFIG.enabled,
    strategy: cfg.strategy ?? DEFAULT_CHECKPOINT_CONFIG.strategy,
    onlyMutating: cfg.onlyMutating ?? DEFAULT_CHECKPOINT_CONFIG.onlyMutating,
    maxSnapshots: cfg.maxSnapshots ?? DEFAULT_CHECKPOINT_CONFIG.maxSnapshots,
    ttlMs: cfg.ttlMs ?? DEFAULT_CHECKPOINT_CONFIG.ttlMs,
    skipTools: cfg.skipTools ?? DEFAULT_CHECKPOINT_CONFIG.skipTools,
    checkpointStride: cfg.checkpointStride ?? 1,
  };
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
 * Creates a checkpoint using docker-commit strategy.
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

  if (config.strategy !== "docker-commit") {
    log.warn(`Checkpoint strategy "${config.strategy}" is not supported in Phase 1; skipping.`);
    return null;
  }

  const id = randomUUID();
  const snapshotRef = `openclaw-ckpt:${id}`;

  try {
    await execDocker(["commit", containerName, snapshotRef]);
  } catch (err) {
    log.warn(
      `docker commit failed for container=${containerName} snapshot=${snapshotRef}: ${String(err)}`,
    );
    return null;
  }

  const entry: CheckpointEntry = {
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
    ...(params.label !== undefined ? { label: params.label } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    source: params.source ?? "auto",
  };

  try {
    await addCheckpointEntry(entry);
  } catch (err) {
    log.warn(`Failed to persist checkpoint entry id=${id}: ${String(err)}`);
    // Still return the entry — the image was committed successfully.
  }

  try {
    const pruned = await pruneOldCheckpoints(containerName, config);
    for (const p of pruned) {
      await removeCheckpointImage(p.snapshotRef);
      await removeCheckpointEntry(p.id).catch((rmErr) => {
        log.warn(`Failed to remove pruned checkpoint entry id=${p.id}: ${String(rmErr)}`);
      });
    }
  } catch (err) {
    log.warn(`Checkpoint pruning failed for container=${containerName}: ${String(err)}`);
  }

  log.debug(
    `Checkpoint created: id=${id} container=${containerName} tool=${normalizedToolName} phase=${phase}`,
  );

  return entry;
}

type RestoreCheckpointParams = {
  id: string;
  containerName: string;
  /** Docker create args (excluding image) used to recreate the container. */
  dockerRunArgs?: string[];
};

/**
 * Restores container state from a docker-commit checkpoint.
 * Stops and removes the current container, creates a new one from the committed image.
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

  if (entry.strategy !== "docker-commit") {
    log.warn(
      `Restore strategy "${entry.strategy}" is not supported in Phase 1: id=${id} container=${containerName}`,
    );
    return false;
  }

  try {
    // Stop the running container (ignore failure — it may already be stopped)
    await execDocker(["stop", containerName], { allowFailure: true });

    // Remove the current container
    await execDocker(["rm", containerName]);

    // Recreate the container from the committed snapshot image
    const runArgs = params.dockerRunArgs ?? [];
    await execDocker(["create", "--name", containerName, ...runArgs, entry.snapshotRef]);
    await execDocker(["start", containerName]);
  } catch (err) {
    log.warn(`Failed to restore checkpoint id=${id} container=${containerName}: ${String(err)}`);
    return false;
  }

  // Prune checkpoints created after this restored checkpoint (they are now invalid)
  try {
    const pruned = await pruneCheckpointsAfter(containerName, entry.createdAtMs);
    for (const p of pruned) {
      await removeCheckpointImage(p.snapshotRef);
      await removeCheckpointEntry(p.id).catch((rmErr) => {
        log.warn(`Failed to remove post-restore checkpoint entry id=${p.id}: ${String(rmErr)}`);
      });
    }
  } catch (err) {
    log.warn(`Post-restore pruning failed for container=${containerName}: ${String(err)}`);
  }

  log.debug(`Checkpoint restored: id=${id} container=${containerName}`);
  return true;
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
