import { resetStrideCounter } from "../../agents/sandbox/checkpoint-stride.js";
import {
  findLastSuccessfulCheckpoint,
  restoreCheckpoint,
} from "../../agents/sandbox/checkpoint.js";
import { resolveSandboxContext } from "../../agents/sandbox/context.js";
import { formatRelativeTimestamp } from "../../infra/format-time/format-relative.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handles the /undo command: restores the sandbox to the most recent checkpoint.
 * Replies with a confirmation message or an appropriate error.
 */
export const handleUndoCommand: CommandHandler = async (params) => {
  const commandBody = params.command.commandBodyNormalized;
  if (commandBody !== "/undo" && !commandBody.startsWith("/undo ")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  // Resolve sandbox context to get container name and checkpoint config.
  const sandboxCtx = await resolveSandboxContext({
    config: params.cfg,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
  }).catch(() => null);

  if (!sandboxCtx?.checkpoint?.config.enabled || !sandboxCtx.containerName) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Undo is not available — no sandbox checkpoint is configured for this session.",
      },
    };
  }

  const { containerName } = sandboxCtx;

  const entry = await findLastSuccessfulCheckpoint(containerName).catch(() => null);
  if (!entry) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ No checkpoint available to restore." },
    };
  }

  const ok = await restoreCheckpoint({ id: entry.id, containerName }).catch(() => false);
  if (!ok) {
    return {
      shouldContinue: false,
      reply: { text: "❌ Failed to restore checkpoint. Please check sandbox status." },
    };
  }

  // Reset stride so the next checkpoint cycle starts fresh after the restore.
  resetStrideCounter(params.sessionKey);

  const relativeTime = formatRelativeTimestamp(entry.createdAtMs);
  return {
    shouldContinue: false,
    reply: {
      text: `✅ Sandbox restored to checkpoint from ${relativeTime} (tool: ${entry.toolName}). The last mutating change has been undone.`,
    },
  };
};
