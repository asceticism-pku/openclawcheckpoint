import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks must be hoisted before any imports ---

const createCheckpointMock = vi.fn();
const isMutatingToolMock = vi.fn();
const resolveCheckpointConfigMock = vi.fn();
const shouldCheckpointAtStrideMock = vi.fn();
const resetStrideCounterMock = vi.fn();
const getStrideCountMock = vi.fn();

vi.mock("./sandbox/checkpoint.js", () => ({
  createCheckpoint: (...args: unknown[]) => createCheckpointMock(...args),
  isMutatingTool: (...args: unknown[]) => isMutatingToolMock(...args),
  resolveCheckpointConfig: (...args: unknown[]) => resolveCheckpointConfigMock(...args),
}));

vi.mock("./sandbox/checkpoint-stride.js", () => ({
  shouldCheckpointAtStride: (...args: unknown[]) => shouldCheckpointAtStrideMock(...args),
  resetStrideCounter: (...args: unknown[]) => resetStrideCounterMock(...args),
  getStrideCount: (...args: unknown[]) => getStrideCountMock(...args),
}));

import {
  getCheckpointCounter,
  maybeCreateCheckpointAfterToolCall,
  resetCheckpointCounter,
} from "./pi-tools.after-tool-call-checkpoint.js";
import type { CheckpointConfig } from "./sandbox/checkpoint-types.js";

/** Builds a fully-resolved CheckpointConfig for test use. */
function makeResolvedConfig(overrides?: Partial<CheckpointConfig>): CheckpointConfig {
  return {
    enabled: true,
    strategy: "docker-commit",
    onlyMutating: true,
    maxSnapshots: 10,
    ttlMs: 3_600_000,
    skipTools: [],
    checkpointStride: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Sensible defaults that let most tests pass through to createCheckpoint
  resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig());
  isMutatingToolMock.mockReturnValue(true);
  shouldCheckpointAtStrideMock.mockReturnValue(true);
  createCheckpointMock.mockResolvedValue({
    id: "test-id",
    containerName: "test-container",
    sessionKey: "sk",
    toolCallId: "tc",
    toolName: "exec",
    phase: "after",
    createdAtMs: Date.now(),
    snapshotRef: "openclaw-ckpt:test-id",
    strategy: "docker-commit",
    restorable: true,
  });
});

describe("maybeCreateCheckpointAfterToolCall", () => {
  it("returns null when config.enabled is false", async () => {
    resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig({ enabled: false }));

    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns null when containerName is not provided", async () => {
    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      // containerName intentionally omitted
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("returns null when error is present (tool call failed)", async () => {
    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
      error: new Error("tool failed"),
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("skips non-mutating tools when onlyMutating is true", async () => {
    isMutatingToolMock.mockReturnValue(false);
    resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig({ onlyMutating: true }));

    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "read",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("checkpoints non-mutating tools when onlyMutating is false", async () => {
    isMutatingToolMock.mockReturnValue(false);
    resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig({ onlyMutating: false }));

    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "read",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(result).not.toBeNull();
    expect(createCheckpointMock).toHaveBeenCalled();
  });

  it("skips tools in skipTools list", async () => {
    resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig({ skipTools: ["exec"] }));

    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("creates checkpoint for mutating tools when all conditions are met", async () => {
    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "my-container",
    });

    expect(result).not.toBeNull();
    expect(createCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "my-container",
        sessionKey: "sk",
        toolCallId: "tc1",
        toolName: "exec",
        phase: "after",
      }),
    );
  });

  it("respects stride: skips when shouldCheckpointAtStride returns false", async () => {
    shouldCheckpointAtStrideMock.mockReturnValue(false);

    const result = await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(result).toBeNull();
    expect(createCheckpointMock).not.toHaveBeenCalled();
  });

  it("passes the stride from config to shouldCheckpointAtStride", async () => {
    resolveCheckpointConfigMock.mockReturnValue(makeResolvedConfig({ checkpointStride: 5 }));

    await maybeCreateCheckpointAfterToolCall({
      toolName: "exec",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(shouldCheckpointAtStrideMock).toHaveBeenCalledWith("sk", 5);
  });

  it("never throws — returns null and logs when createCheckpoint throws", async () => {
    createCheckpointMock.mockRejectedValueOnce(new Error("docker error"));

    await expect(
      maybeCreateCheckpointAfterToolCall({
        toolName: "exec",
        toolCallId: "tc1",
        sessionKey: "sk",
        containerName: "c",
      }),
    ).resolves.toBeNull();
  });

  it("normalizes tool name to lowercase before checks", async () => {
    await maybeCreateCheckpointAfterToolCall({
      toolName: "EXEC",
      toolCallId: "tc1",
      sessionKey: "sk",
      containerName: "c",
    });

    expect(isMutatingToolMock).toHaveBeenCalledWith("exec");
  });
});

describe("resetCheckpointCounter", () => {
  it("delegates to resetStrideCounter", () => {
    resetCheckpointCounter("my-session");
    expect(resetStrideCounterMock).toHaveBeenCalledWith("my-session");
  });
});

describe("getCheckpointCounter", () => {
  it("delegates to getStrideCount", () => {
    getStrideCountMock.mockReturnValue(7);
    const count = getCheckpointCounter("my-session");
    expect(count).toBe(7);
    expect(getStrideCountMock).toHaveBeenCalledWith("my-session");
  });
});
