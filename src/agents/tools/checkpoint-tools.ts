import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { formatRelativeTimestamp } from "../../infra/format-time/format-relative.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  findCheckpointByLabel,
  listCheckpointsSorted,
  updateCheckpointEntry,
} from "../sandbox/checkpoint-registry.js";
import { resetStrideCounter } from "../sandbox/checkpoint-stride.js";
import type { CheckpointConfig, CheckpointEntry } from "../sandbox/checkpoint-types.js";
import {
  createCheckpoint,
  findLastSuccessfulCheckpoint,
  resolveCheckpointConfig,
  restoreCheckpoint,
} from "../sandbox/checkpoint.js";
import { execDocker } from "../sandbox/docker.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const log = createSubsystemLogger("agents/tools/checkpoint");

export type CheckpointToolContext = {
  sessionKey: string;
  containerName: string;
  dockerRunArgs?: string[];
  checkpointConfig?: Partial<CheckpointConfig>;
};

/**
 * `checkpoint_save` — Explicitly save a named checkpoint with a label and optional description.
 * The agent calls this when it wants to save state before trying something risky.
 */
function createCheckpointSaveTool(ctx: CheckpointToolContext): AnyAgentTool {
  return {
    label: "Checkpoint Save",
    name: "checkpoint_save",
    description:
      "Save the current sandbox state as a named checkpoint. Use this before attempting risky operations so you can roll back if needed. Returns the checkpoint ID.",
    parameters: Type.Object({
      label: Type.String({
        description:
          "Short human-readable name for this checkpoint (e.g. 'before-firefox-config', 'initial-state'). Used to identify and restore it later.",
      }),
      description: Type.Optional(
        Type.String({
          description:
            "Optional description of the current state or why you are saving this checkpoint.",
        }),
      ),
    }),
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const label = readStringParam(params, "label", { required: true, label: "label" });
      const description = readStringParam(params, "description");

      const config = resolveCheckpointConfig(ctx.checkpointConfig);
      if (!config.enabled) {
        log.warn(`checkpoint_save called but checkpoints are disabled: session=${ctx.sessionKey}`);
        return jsonResult({
          success: false,
          error: "Checkpoints are not enabled for this session.",
        });
      }

      // Use a synthetic toolCallId for agent-driven checkpoints.
      const agentToolCallId = toolCallId ?? randomUUID();

      const entry = await createCheckpoint({
        containerName: ctx.containerName,
        sessionKey: ctx.sessionKey,
        toolCallId: agentToolCallId,
        toolName: "checkpoint_save",
        phase: "after",
        config,
        label,
        source: "agent",
        description,
      }).catch((err) => {
        log.warn(`checkpoint_save failed: ${String(err)}`);
        return null;
      });

      if (!entry) {
        return jsonResult({
          success: false,
          error: "Failed to create checkpoint. The container may not be running.",
        });
      }

      log.info(
        `Agent checkpoint saved: id=${entry.id} label=${label} container=${ctx.containerName} session=${ctx.sessionKey}`,
      );

      return jsonResult({
        success: true,
        checkpoint_id: entry.id,
        label: entry.label,
        created_at: new Date(entry.createdAtMs).toISOString(),
        message: `Checkpoint "${label}" saved (id: ${entry.id}). You can restore it later with checkpoint_restore.`,
      });
    },
  };
}

/**
 * `checkpoint_list` — List all available checkpoints with their metadata.
 * Helps the agent understand what rollback points are available.
 */
function createCheckpointListTool(ctx: CheckpointToolContext): AnyAgentTool {
  return {
    label: "Checkpoint List",
    name: "checkpoint_list",
    description:
      "List all available checkpoints for the current sandbox session, sorted newest first. Shows ID, label, timestamp, source, and description.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _args) => {
      const config = resolveCheckpointConfig(ctx.checkpointConfig);
      if (!config.enabled) {
        return jsonResult({
          checkpoints: [],
          message: "Checkpoints are not enabled for this session.",
        });
      }

      const entries = await listCheckpointsSorted(ctx.containerName).catch(() => []);

      const checkpoints = entries.map((e) => ({
        id: e.id,
        label: e.label ?? null,
        source: e.source ?? "auto",
        created_at: new Date(e.createdAtMs).toISOString(),
        relative_time: formatRelativeTimestamp(e.createdAtMs),
        tool: e.toolName,
        restorable: e.restorable,
        description: e.description ?? null,
        exploration_attempts: e.explorationLog?.length ?? 0,
      }));

      return jsonResult({
        checkpoints,
        total: checkpoints.length,
        message:
          checkpoints.length === 0
            ? "No checkpoints available."
            : `${checkpoints.length} checkpoint(s) available. Use checkpoint_restore to roll back.`,
      });
    },
  };
}

/**
 * `checkpoint_restore` — Restore to a specific checkpoint by ID or label.
 * Records the reason in the exploration log. Returns confirmation and diff summary.
 */
function createCheckpointRestoreTool(ctx: CheckpointToolContext): AnyAgentTool {
  return {
    label: "Checkpoint Restore",
    name: "checkpoint_restore",
    description:
      "Restore the sandbox to a previously saved checkpoint. Provide either checkpoint_id or label. The reason for restoring is recorded so future restores can show what has already been tried.",
    parameters: Type.Object({
      checkpoint_id: Type.Optional(
        Type.String({
          description: "The checkpoint ID returned by checkpoint_save or checkpoint_list.",
        }),
      ),
      label: Type.Optional(
        Type.String({
          description:
            "The label of the checkpoint to restore (if checkpoint_id is not provided). Uses the most recent checkpoint with that label.",
        }),
      ),
      reason: Type.String({
        description:
          "Why you are restoring this checkpoint. Describe what you tried and why it failed. This is recorded so you know what approaches have already been tried from this restore point.",
      }),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const checkpointId = readStringParam(params, "checkpoint_id");
      const label = readStringParam(params, "label");
      const reason = readStringParam(params, "reason", { required: true, label: "reason" });

      const config = resolveCheckpointConfig(ctx.checkpointConfig);
      if (!config.enabled) {
        return jsonResult({
          success: false,
          error: "Checkpoints are not enabled for this session.",
        });
      }

      // Resolve which checkpoint to restore.
      let resolvedId: string | null = null;
      let resolvedLabel: string | null = null;
      let targetEntry: CheckpointEntry | null = null;

      if (checkpointId) {
        resolvedId = checkpointId;
        // Fetch entry to populate label for display.
        const entries = await listCheckpointsSorted(ctx.containerName).catch(() => []);
        targetEntry = entries.find((e) => e.id === checkpointId) ?? null;
        resolvedLabel = targetEntry?.label ?? null;
      } else if (label) {
        const found = await findCheckpointByLabel(ctx.containerName, label).catch(() => null);
        if (!found) {
          return jsonResult({
            success: false,
            error: `No checkpoint found with label "${label}". Use checkpoint_list to see available checkpoints.`,
          });
        }
        resolvedId = found.id;
        resolvedLabel = found.label ?? null;
        targetEntry = found;
      } else {
        // Fall back to last restorable checkpoint.
        const last = await findLastSuccessfulCheckpoint(ctx.containerName).catch(() => null);
        if (!last) {
          return jsonResult({
            success: false,
            error: "No checkpoints available. Use checkpoint_save first.",
          });
        }
        resolvedId = last.id;
        resolvedLabel = last.label ?? null;
        targetEntry = last;
      }

      // Record the failed approach in the exploration log before restoring.
      const existingLog = targetEntry?.explorationLog ?? [];
      const logEntry = `[FAILED] ${reason}`;
      const updatedLog = [...existingLog, logEntry];

      if (targetEntry) {
        await updateCheckpointEntry(resolvedId, {
          explorationLog: updatedLog,
        }).catch((err) => {
          log.warn(`Failed to update exploration log for checkpoint ${resolvedId}: ${String(err)}`);
        });
      }

      log.info(
        `Agent restoring checkpoint: id=${resolvedId} label=${resolvedLabel ?? "none"} reason="${reason}" container=${ctx.containerName} session=${ctx.sessionKey}`,
      );

      const ok = await restoreCheckpoint({
        id: resolvedId,
        containerName: ctx.containerName,
        dockerRunArgs: ctx.dockerRunArgs,
      }).catch((err) => {
        log.warn(`checkpoint_restore failed: ${String(err)}`);
        return false;
      });

      if (!ok) {
        return jsonResult({
          success: false,
          error: `Failed to restore checkpoint ${resolvedId}. It may have been pruned or the container may be unavailable.`,
        });
      }

      // Reset stride so the next checkpoint cycle starts fresh after restore.
      resetStrideCounter(ctx.sessionKey);

      // Use the updated log we built before the restore.
      const explorationLog = updatedLog;

      const labelDisplay = resolvedLabel ? `"${resolvedLabel}"` : resolvedId;
      const relativeTime = targetEntry
        ? formatRelativeTimestamp(targetEntry.createdAtMs)
        : "unknown time";

      let message = `✅ Sandbox restored to checkpoint ${labelDisplay} (${relativeTime}).`;
      if (explorationLog.length > 0) {
        message += `\n\nPrevious exploration attempts from this checkpoint:\n`;
        message += explorationLog.map((entry, i) => `${i + 1}. ${entry}`).join("\n");
        message += `\n\nPlease try a different approach.`;
      }

      log.info(
        `Agent checkpoint restore succeeded: id=${resolvedId} container=${ctx.containerName} session=${ctx.sessionKey}`,
      );

      return jsonResult({
        success: true,
        checkpoint_id: resolvedId,
        label: resolvedLabel,
        restored_from: relativeTime,
        exploration_log: explorationLog,
        message,
      });
    },
  };
}

/**
 * `checkpoint_diff` — Compare current container state with a checkpoint.
 * Returns list of added/modified/deleted files since that checkpoint.
 */
function createCheckpointDiffTool(ctx: CheckpointToolContext): AnyAgentTool {
  return {
    label: "Checkpoint Diff",
    name: "checkpoint_diff",
    description:
      "Compare the current sandbox state with a checkpoint to see what files have changed (added, modified, deleted). Provide either checkpoint_id or label.",
    parameters: Type.Object({
      checkpoint_id: Type.Optional(
        Type.String({ description: "The checkpoint ID to diff against." }),
      ),
      label: Type.Optional(
        Type.String({ description: "The label of the checkpoint to diff against." }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const checkpointId = readStringParam(params, "checkpoint_id");
      const label = readStringParam(params, "label");

      const config = resolveCheckpointConfig(ctx.checkpointConfig);
      if (!config.enabled) {
        return jsonResult({
          success: false,
          error: "Checkpoints are not enabled for this session.",
        });
      }

      // Resolve which checkpoint to diff against.
      let resolvedEntry = null;

      if (checkpointId) {
        const entries = await listCheckpointsSorted(ctx.containerName).catch(() => []);
        resolvedEntry = entries.find((e) => e.id === checkpointId) ?? null;
        if (!resolvedEntry) {
          return jsonResult({
            success: false,
            error: `No checkpoint found with id "${checkpointId}". Use checkpoint_list to see available checkpoints.`,
          });
        }
      } else if (label) {
        resolvedEntry = await findCheckpointByLabel(ctx.containerName, label).catch(() => null);
        if (!resolvedEntry) {
          return jsonResult({
            success: false,
            error: `No checkpoint found with label "${label}". Use checkpoint_list to see available checkpoints.`,
          });
        }
      } else {
        resolvedEntry = await findLastSuccessfulCheckpoint(ctx.containerName).catch(() => null);
        if (!resolvedEntry) {
          return jsonResult({
            success: false,
            error: "No checkpoints available to diff against.",
          });
        }
      }

      // Run docker diff on the current container.
      // Note: docker diff shows all changes since the container was created from its base image,
      // not just changes since the specific checkpoint. If multiple checkpoints have been created
      // and restored, this reflects the cumulative diff from the current container's creation point.
      let diffLines: string[] = [];
      try {
        const result = await execDocker(["diff", ctx.containerName]);
        diffLines = result.stdout
          .split("\n")
          .map((l: string) => l.trim())
          .filter(Boolean);
      } catch (err) {
        log.warn(`docker diff failed for container=${ctx.containerName}: ${String(err)}`);
        return jsonResult({
          success: false,
          error: `Failed to run docker diff: ${String(err)}`,
        });
      }

      const added = diffLines.filter((l) => l.startsWith("A ")).map((l) => l.slice(2));
      const modified = diffLines.filter((l) => l.startsWith("C ")).map((l) => l.slice(2));
      const deleted = diffLines.filter((l) => l.startsWith("D ")).map((l) => l.slice(2));

      const labelDisplay = resolvedEntry.label ? `"${resolvedEntry.label}"` : resolvedEntry.id;
      const relativeTime = formatRelativeTimestamp(resolvedEntry.createdAtMs);

      return jsonResult({
        success: true,
        checkpoint_id: resolvedEntry.id,
        label: resolvedEntry.label ?? null,
        checkpoint_time: relativeTime,
        added,
        modified,
        deleted,
        total_changes: added.length + modified.length + deleted.length,
        message:
          diffLines.length === 0
            ? `No changes since checkpoint ${labelDisplay} (${relativeTime}).`
            : `${added.length} added, ${modified.length} modified, ${deleted.length} deleted since checkpoint ${labelDisplay} (${relativeTime}).`,
      });
    },
  };
}

/**
 * Creates all checkpoint agent tools for use in the tool list.
 * These are gated behind sandbox + checkpoint config being enabled.
 */
export function createCheckpointTools(ctx: CheckpointToolContext): AnyAgentTool[] {
  return [
    createCheckpointSaveTool(ctx),
    createCheckpointListTool(ctx),
    createCheckpointRestoreTool(ctx),
    createCheckpointDiffTool(ctx),
  ];
}
