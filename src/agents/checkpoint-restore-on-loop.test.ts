import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointEntry } from "./sandbox/checkpoint-types.js";

// --- Mocks ---

const findLastSuccessfulCheckpointMock = vi.hoisted(() => vi.fn());
const restoreCheckpointMock = vi.hoisted(() => vi.fn());
const resolveCheckpointConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox/checkpoint.js", () => ({
  findLastSuccessfulCheckpoint: findLastSuccessfulCheckpointMock,
  restoreCheckpoint: restoreCheckpointMock,
  resolveCheckpointConfig: resolveCheckpointConfigMock,
}));

const resetStrideCounterMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox/checkpoint-stride.js", () => ({
  resetStrideCounter: resetStrideCounterMock,
}));

const updateCheckpointEntryMock = vi.hoisted(() => vi.fn());

vi.mock("./sandbox/checkpoint-registry.js", () => ({
  updateCheckpointEntry: updateCheckpointEntryMock,
}));

import { maybeRestoreCheckpointOnLoop } from "./checkpoint-restore-on-loop.js";
import type { LoopDetectionResult } from "./tool-loop-detection.js";

const enabledConfig = {
  enabled: true,
  strategy: "docker-commit" as const,
  onlyMutating: true,
  maxSnapshots: 10,
  ttlMs: 3_600_000,
  skipTools: [],
};

const disabledConfig = { ...enabledConfig, enabled: false };

const makeEntry = (overrides?: Partial<CheckpointEntry>): CheckpointEntry => ({
  id: "ckpt-1",
  containerName: "test-container",
  sessionKey: "test:session",
  toolCallId: "tc-1",
  toolName: "exec",
  phase: "after",
  createdAtMs: Date.now() - 60_000,
  snapshotRef: "openclaw-ckpt:ckpt-1",
  strategy: "docker-commit",
  restorable: true,
  ...overrides,
});

const criticalLoop: LoopDetectionResult = {
  stuck: true,
  level: "critical",
  detector: "global_circuit_breaker",
  count: 30,
  message: "CRITICAL: global circuit breaker triggered",
};

const warningLoop: LoopDetectionResult = {
  stuck: true,
  level: "warning",
  detector: "generic_repeat",
  count: 12,
  message: "Loop warning",
};

const notStuck: LoopDetectionResult = { stuck: false };

beforeEach(() => {
  resolveCheckpointConfigMock.mockReturnValue(enabledConfig);
  findLastSuccessfulCheckpointMock.mockResolvedValue(makeEntry());
  restoreCheckpointMock.mockResolvedValue(true);
  resetStrideCounterMock.mockReset();
  updateCheckpointEntryMock.mockReset();
  updateCheckpointEntryMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("maybeRestoreCheckpointOnLoop", () => {
  it("returns { restored: false } when loop result is not stuck", async () => {
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: notStuck,
      sessionKey: "s1",
      containerName: "c1",
    });
    expect(result.restored).toBe(false);
    expect(findLastSuccessfulCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns { restored: false } when loop level is warning (not critical)", async () => {
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: warningLoop,
      sessionKey: "s1",
      containerName: "c1",
    });
    expect(result.restored).toBe(false);
    expect(findLastSuccessfulCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns { restored: false } when no containerName is provided", async () => {
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
    });
    expect(result.restored).toBe(false);
    expect(findLastSuccessfulCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns { restored: false } when checkpoint config is disabled", async () => {
    resolveCheckpointConfigMock.mockReturnValue(disabledConfig);
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
      checkpointConfig: { enabled: false },
    });
    expect(result.restored).toBe(false);
    expect(findLastSuccessfulCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns { restored: false } when no restorable checkpoint exists", async () => {
    findLastSuccessfulCheckpointMock.mockResolvedValue(null);
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
    });
    expect(result.restored).toBe(false);
    expect(restoreCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns { restored: false } when restoreCheckpoint returns false", async () => {
    restoreCheckpointMock.mockResolvedValue(false);
    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
    });
    expect(result.restored).toBe(false);
    expect(resetStrideCounterMock).not.toHaveBeenCalled();
  });

  it("restores successfully on critical loop with existing checkpoint", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    findLastSuccessfulCheckpointMock.mockResolvedValue(entry);

    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "session:main",
      containerName: "my-container",
    });

    expect(result.restored).toBe(true);
    if (result.restored) {
      expect(result.checkpointId).toBe("ckpt-42");
      expect(result.message).toContain("global_circuit_breaker");
      expect(result.message).toContain("⚠️");
      expect(result.message).toContain("exec");
    }
    expect(restoreCheckpointMock).toHaveBeenCalledWith({
      id: "ckpt-42",
      containerName: "my-container",
      dockerRunArgs: undefined,
    });
  });

  it("resets the stride counter after a successful restore", async () => {
    await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "session:stride-test",
      containerName: "c1",
    });
    expect(resetStrideCounterMock).toHaveBeenCalledWith("session:stride-test");
  });

  it("passes dockerRunArgs through to restoreCheckpoint", async () => {
    const args = ["--net=host", "--privileged"];
    await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
      dockerRunArgs: args,
    });
    expect(restoreCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ dockerRunArgs: args }),
    );
  });

  it("records the loop reason in the checkpoint exploration log before restoring", async () => {
    const entry = makeEntry({ id: "ckpt-42", explorationLog: [] });
    findLastSuccessfulCheckpointMock.mockResolvedValue(entry);

    await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
    });

    expect(updateCheckpointEntryMock).toHaveBeenCalledWith(
      "ckpt-42",
      expect.objectContaining({
        explorationLog: expect.arrayContaining([expect.stringContaining("global_circuit_breaker")]),
      }),
    );
  });

  it("includes exploration log in the returned message on successful restore", async () => {
    const entry = makeEntry({
      id: "ckpt-42",
      explorationLog: ["[FAILED] earlier approach"],
    });
    findLastSuccessfulCheckpointMock.mockResolvedValue(entry);

    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
    });

    expect(result.restored).toBe(true);
    if (result.restored) {
      expect(result.message).toContain("earlier approach");
      expect(result.message).toContain("Previous exploration attempts");
    }
  });

  it("still restores even if updateCheckpointEntry fails", async () => {
    updateCheckpointEntryMock.mockRejectedValue(new Error("registry error"));

    const result = await maybeRestoreCheckpointOnLoop({
      loopResult: criticalLoop,
      sessionKey: "s1",
      containerName: "c1",
    });

    // Should still restore despite the exploration log update failing
    expect(result.restored).toBe(true);
    expect(restoreCheckpointMock).toHaveBeenCalled();
  });
});
