/**
 * In-memory session state checkpointing for OpenClaw agent sessions.
 *
 * When the container filesystem is checkpointed, the agent's in-memory session
 * state (tool call history, loop detection state) should also be saved so that
 * on restore the agent can resume from exactly the same decision context.
 *
 * The snapshot is serialized as a JSON file stored on the host filesystem
 * alongside the container checkpoint artifacts.
 *
 * ## Usage
 * - Call `saveMemorySnapshot()` after creating a container checkpoint.
 * - Call `restoreMemorySnapshot()` after restoring a container checkpoint to
 *   reinstate the corresponding session state.
 * - The path to the snapshot file is stored in `CheckpointEntry.memorySnapshotPath`
 *   so it can be located at restore time.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  getDiagnosticSessionState,
  type SessionState,
  type ToolCallRecord,
} from "../../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getStrideCount } from "./checkpoint-stride.js";
import { SANDBOX_CHECKPOINT_OVERLAY_DIR } from "./constants.js";

const log = createSubsystemLogger("sandbox/checkpoint-memory");

/**
 * Serializable snapshot of the session's in-memory state at the time a
 * checkpoint is created.  This is the subset of `SessionState` needed to
 * restore the agent's context on rollback.
 */
export type SessionMemorySnapshot = {
  /** Checkpoint ID this snapshot is associated with. */
  checkpointId: string;
  /** Session key for the agent session. */
  sessionKey: string;
  /** Ordered history of tool calls recorded by the loop detector. */
  toolCallHistory: ToolCallRecord[];
  /** Current stride counter value for checkpoint throttling. */
  strideCount: number;
  /** Timestamp when the snapshot was created (ms since epoch). */
  createdAtMs: number;
};

/**
 * Returns the host directory for memory snapshot files.
 * Uses the same per-container overlay directory for colocation.
 */
async function ensureMemoryDir(containerName: string): Promise<string> {
  const safeName = containerName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const dir = path.join(SANDBOX_CHECKPOINT_OVERLAY_DIR, safeName);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Captures the current in-memory session state and writes it to disk.
 *
 * @param containerName  - Container associated with this checkpoint.
 * @param checkpointId   - UUID of the container checkpoint being created.
 * @param sessionKey     - Key identifying the agent session.
 * @returns Path to the snapshot JSON file, or null on failure.
 */
export async function saveMemorySnapshot(
  containerName: string,
  checkpointId: string,
  sessionKey: string,
): Promise<string | null> {
  try {
    const state: SessionState = getDiagnosticSessionState({ sessionKey });
    const strideCount = getStrideCount(sessionKey);

    const snapshot: SessionMemorySnapshot = {
      checkpointId,
      sessionKey,
      toolCallHistory: state.toolCallHistory ? [...state.toolCallHistory] : [],
      strideCount,
      createdAtMs: Date.now(),
    };

    const dir = await ensureMemoryDir(containerName);
    const snapshotPath = path.join(dir, `${checkpointId}.memory.json`);
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

    log.debug(
      `Memory snapshot saved: id=${checkpointId} session=${sessionKey} historyLen=${snapshot.toolCallHistory.length}`,
    );
    return snapshotPath;
  } catch (err) {
    log.warn(
      `Failed to save memory snapshot for checkpoint=${checkpointId} session=${sessionKey}: ${String(err)}`,
    );
    return null;
  }
}

/**
 * Reads a memory snapshot from disk.
 *
 * @param snapshotPath - Path returned by `saveMemorySnapshot`.
 * @returns Parsed snapshot, or null if the file is missing or invalid.
 */
export async function readMemorySnapshot(
  snapshotPath: string,
): Promise<SessionMemorySnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).checkpointId === "string"
    ) {
      return parsed as SessionMemorySnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Restores the in-memory session state from a previously saved snapshot.
 *
 * After this call, `getDiagnosticSessionState({ sessionKey })` will return a
 * state object with the restored `toolCallHistory`.  The stride counter is NOT
 * reset here — callers should call `resetStrideCounter(sessionKey)` separately
 * after restore if they want a clean stride count.
 *
 * @param snapshotPath - Path to the snapshot file (from `CheckpointEntry.memorySnapshotPath`).
 * @returns true on success, false on failure.
 */
export async function restoreMemorySnapshot(snapshotPath: string): Promise<boolean> {
  const snapshot = await readMemorySnapshot(snapshotPath);
  if (!snapshot) {
    log.warn(`Memory snapshot not found or invalid: path=${snapshotPath}`);
    return false;
  }

  try {
    const state: SessionState = getDiagnosticSessionState({ sessionKey: snapshot.sessionKey });
    // Restore the tool call history.
    state.toolCallHistory = [...snapshot.toolCallHistory];
    log.debug(
      `Memory snapshot restored: id=${snapshot.checkpointId} session=${snapshot.sessionKey} historyLen=${snapshot.toolCallHistory.length}`,
    );
    return true;
  } catch (err) {
    log.warn(`Failed to restore memory snapshot: path=${snapshotPath}: ${String(err)}`);
    return false;
  }
}

/**
 * Removes the memory snapshot file for a checkpoint from the host filesystem.
 * Non-fatal — logs warnings on failure.
 */
export async function removeMemorySnapshot(snapshotPath: string): Promise<void> {
  try {
    await fs.unlink(snapshotPath);
  } catch (err) {
    log.warn(`Failed to remove memory snapshot path=${snapshotPath}: ${String(err)}`);
  }
}
