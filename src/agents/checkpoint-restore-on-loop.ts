import { formatRelativeTimestamp } from "../infra/format-time/format-relative.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resetStrideCounter } from "./sandbox/checkpoint-stride.js";
import type { CheckpointConfig } from "./sandbox/checkpoint-types.js";
import {
  findLastSuccessfulCheckpoint,
  resolveCheckpointConfig,
  restoreCheckpoint,
} from "./sandbox/checkpoint.js";
import type { LoopDetectionResult } from "./tool-loop-detection.js";

const log = createSubsystemLogger("agents/checkpoint-restore");

export type MaybeRestoreCheckpointOnLoopParams = {
  loopResult: LoopDetectionResult;
  sessionKey: string;
  containerName?: string;
  /** Docker create args (excluding image) used to recreate the container. */
  dockerRunArgs?: string[];
  checkpointConfig?: Partial<CheckpointConfig>;
};

export type RestoreOnLoopResult =
  | { restored: false }
  | { restored: true; checkpointId: string; message: string };

/**
 * Attempts to restore the sandbox to the most recent checkpoint when a critical
 * tool-loop is detected. Resets the stride counter on success so the session can
 * continue from a clean state.
 *
 * Returns `{ restored: false }` when:
 * - The loop result is not stuck or is only a warning.
 * - No container name is provided.
 * - Checkpoints are disabled in the resolved config.
 * - No restorable checkpoint exists for the container.
 */
export async function maybeRestoreCheckpointOnLoop(
  params: MaybeRestoreCheckpointOnLoopParams,
): Promise<RestoreOnLoopResult> {
  const { loopResult, sessionKey, containerName, dockerRunArgs, checkpointConfig } = params;

  // Only act on critical stuck loops.
  if (!loopResult.stuck || loopResult.level !== "critical") {
    return { restored: false };
  }

  if (!containerName) {
    return { restored: false };
  }

  const config = resolveCheckpointConfig(checkpointConfig);
  if (!config.enabled) {
    return { restored: false };
  }

  const entry = await findLastSuccessfulCheckpoint(containerName);
  if (!entry) {
    log.warn(
      `Critical loop detected but no restorable checkpoint found: container=${containerName} session=${sessionKey}`,
    );
    return { restored: false };
  }

  log.info(
    `Restoring checkpoint on critical loop: id=${entry.id} container=${containerName} session=${sessionKey} detector=${loopResult.detector}`,
  );

  const ok = await restoreCheckpoint({ id: entry.id, containerName, dockerRunArgs });
  if (!ok) {
    log.warn(
      `Checkpoint restore failed: id=${entry.id} container=${containerName} session=${sessionKey}`,
    );
    return { restored: false };
  }

  // Reset stride so the session's next checkpoint cycle starts fresh.
  resetStrideCounter(sessionKey);

  const relativeTime = formatRelativeTimestamp(entry.createdAtMs);
  const message = `⚠️ Detected stuck loop (${loopResult.detector}). Sandbox has been restored to checkpoint from ${relativeTime} (tool: ${entry.toolName}). Please try a different approach.`;
  log.info(
    `Checkpoint restore succeeded: id=${entry.id} container=${containerName} session=${sessionKey}`,
  );
  return { restored: true, checkpointId: entry.id, message };
}
