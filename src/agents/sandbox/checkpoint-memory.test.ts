import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before any imports
const { TEST_MEMORY_DIR } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-memory-test-"));
  return { TEST_MEMORY_DIR: baseDir };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_MEMORY_DIR,
  SANDBOX_REGISTRY_PATH: path.join(TEST_MEMORY_DIR, "containers.json"),
  SANDBOX_BROWSER_REGISTRY_PATH: path.join(TEST_MEMORY_DIR, "browsers.json"),
  SANDBOX_CHECKPOINT_REGISTRY_PATH: path.join(TEST_MEMORY_DIR, "checkpoints.json"),
  SANDBOX_CHECKPOINT_OVERLAY_DIR: path.join(TEST_MEMORY_DIR, "checkpoints"),
}));

import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../logging/diagnostic-session-state.js";
import {
  saveMemorySnapshot,
  readMemorySnapshot,
  restoreMemorySnapshot,
  removeMemorySnapshot,
} from "./checkpoint-memory.js";
import { shouldCheckpointAtStride, resetStrideCounter } from "./checkpoint-stride.js";

beforeEach(() => {
  resetDiagnosticSessionStateForTest();
  resetStrideCounter("test-session");
});

describe("saveMemorySnapshot", () => {
  it("returns a path on success", async () => {
    const result = await saveMemorySnapshot("test-container", "ckpt-001", "test-session");
    expect(result).not.toBeNull();
    expect(result).toContain("ckpt-001.memory.json");
  });

  it("persists the tool call history", async () => {
    const state = getDiagnosticSessionState({ sessionKey: "hist-session" });
    state.toolCallHistory = [
      {
        toolName: "bash",
        argsHash: "abc123",
        toolCallId: "tc-1",
        resultHash: "res-1",
        timestamp: 1_000,
      },
      {
        toolName: "write",
        argsHash: "def456",
        toolCallId: "tc-2",
        resultHash: "res-2",
        timestamp: 2_000,
      },
    ];

    const snapshotPath = await saveMemorySnapshot("hist-container", "ckpt-hist", "hist-session");
    expect(snapshotPath).not.toBeNull();

    const snapshot = await readMemorySnapshot(snapshotPath!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.toolCallHistory).toHaveLength(2);
    expect(snapshot!.toolCallHistory[0]?.toolName).toBe("bash");
    expect(snapshot!.toolCallHistory[1]?.toolName).toBe("write");
  });

  it("persists the stride count", async () => {
    // Advance stride counter
    shouldCheckpointAtStride("stride-session", 5); // count=1
    shouldCheckpointAtStride("stride-session", 5); // count=2
    shouldCheckpointAtStride("stride-session", 5); // count=3

    const snapshotPath = await saveMemorySnapshot(
      "stride-container",
      "ckpt-stride",
      "stride-session",
    );
    expect(snapshotPath).not.toBeNull();

    const snapshot = await readMemorySnapshot(snapshotPath!);
    expect(snapshot!.strideCount).toBe(3);

    // Clean up
    resetStrideCounter("stride-session");
  });

  it("saves an empty history when no tool calls have been made", async () => {
    const snapshotPath = await saveMemorySnapshot("empty-container", "ckpt-empty", "empty-session");
    const snapshot = await readMemorySnapshot(snapshotPath!);
    expect(snapshot!.toolCallHistory).toEqual([]);
  });
});

describe("readMemorySnapshot", () => {
  it("returns null for a nonexistent path", async () => {
    const result = await readMemorySnapshot("/tmp/nonexistent/ckpt-fake.memory.json");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const dir = path.join(TEST_MEMORY_DIR, "checkpoints", "bad_container");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "bad.memory.json");
    await fs.writeFile(filePath, "not valid json");
    const result = await readMemorySnapshot(filePath);
    expect(result).toBeNull();
  });
});

describe("restoreMemorySnapshot", () => {
  it("restores tool call history into the session state", async () => {
    // Save a snapshot with known history.
    const state = getDiagnosticSessionState({ sessionKey: "restore-session" });
    state.toolCallHistory = [
      { toolName: "exec", argsHash: "h1", timestamp: 100 },
      { toolName: "edit", argsHash: "h2", timestamp: 200 },
    ];

    const snapshotPath = await saveMemorySnapshot(
      "restore-container",
      "ckpt-restore",
      "restore-session",
    );

    // Clear the state so we can verify restoration.
    state.toolCallHistory = [];

    const ok = await restoreMemorySnapshot(snapshotPath!);
    expect(ok).toBe(true);
    expect(state.toolCallHistory).toHaveLength(2);
    expect(state.toolCallHistory[0]?.toolName).toBe("exec");
    expect(state.toolCallHistory[1]?.toolName).toBe("edit");
  });

  it("returns false for a nonexistent snapshot path", async () => {
    const ok = await restoreMemorySnapshot("/tmp/ghost/ckpt-ghost.memory.json");
    expect(ok).toBe(false);
  });
});

describe("removeMemorySnapshot", () => {
  it("does not throw when file does not exist", async () => {
    await expect(removeMemorySnapshot("/tmp/no-such-file.json")).resolves.toBeUndefined();
  });

  it("removes the snapshot file when it exists", async () => {
    const snapshotPath = await saveMemorySnapshot("rm-container", "ckpt-rm", "rm-session");
    expect(snapshotPath).not.toBeNull();

    // Verify the file exists before removal.
    await expect(fs.access(snapshotPath!)).resolves.toBeUndefined();

    await removeMemorySnapshot(snapshotPath!);

    // Verify the file is gone.
    await expect(fs.access(snapshotPath!)).rejects.toThrow();
  });
});
