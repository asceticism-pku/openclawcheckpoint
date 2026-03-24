import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getStrideCount,
  resetStrideCounter,
  shouldCheckpointAtStride,
} from "./sandbox/checkpoint-stride.js";
import type { CheckpointConfig, CheckpointEntry } from "./sandbox/checkpoint-types.js";
import { createCheckpoint, isMutatingTool, resolveCheckpointConfig } from "./sandbox/checkpoint.js";

const log = createSubsystemLogger("agents/tools/checkpoint");

export type MaybeCreateCheckpointParams = {
  toolName: string;
  toolCallId: string;
  sessionKey: string;
  containerName?: string;
  checkpointConfig?: Partial<CheckpointConfig>;
  error?: unknown;
};

/**
 * Fire-and-forget checkpoint creation triggered after a tool call.
 *
 * - Returns immediately (no-op) when checkpoints are disabled or no sandbox container
 *   is available.
 * - Respects `onlyMutating`: skips non-mutating tools when the flag is set.
 * - Respects `checkpointStride`: only checkpoints every Nth mutating tool call per session.
 * - Never throws — errors from `createCheckpoint` are logged as warnings.
 *
 * @returns The created `CheckpointEntry`, or `null` if skipped / errored.
 */
export async function maybeCreateCheckpointAfterToolCall(
  params: MaybeCreateCheckpointParams,
): Promise<CheckpointEntry | null> {
  const { toolName, toolCallId, sessionKey, containerName, checkpointConfig, error } = params;

  const config = resolveCheckpointConfig(checkpointConfig);

  if (!config.enabled) {
    return null;
  }

  if (!containerName) {
    return null;
  }

  // Skip when the tool call itself produced an error (we only snapshot success states).
  if (error !== undefined) {
    return null;
  }

  const normalizedToolName = toolName.trim().toLowerCase();

  if (config.onlyMutating && !isMutatingTool(normalizedToolName)) {
    return null;
  }

  if (config.skipTools.some((t) => t.trim().toLowerCase() === normalizedToolName)) {
    return null;
  }

  // Apply stride throttling — only checkpoint every Nth qualifying call.
  if (!shouldCheckpointAtStride(sessionKey, config.checkpointStride ?? 1)) {
    return null;
  }

  try {
    return await createCheckpoint({
      containerName,
      sessionKey,
      toolCallId,
      toolName: normalizedToolName,
      phase: "after",
      config,
    });
  } catch (err) {
    log.warn(
      `Checkpoint creation failed after tool=${normalizedToolName} session=${sessionKey}: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Resets the per-session mutating-tool-call stride counter.
 * Call this when a session is reset or destroyed.
 */
export function resetCheckpointCounter(sessionKey: string): void {
  resetStrideCounter(sessionKey);
}

/**
 * Returns the current per-session mutating-tool-call count (for testing / diagnostics).
 */
export function getCheckpointCounter(sessionKey: string): number {
  return getStrideCount(sessionKey);
}
