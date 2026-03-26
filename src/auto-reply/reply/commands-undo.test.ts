import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointEntry } from "../../agents/sandbox/checkpoint-types.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineDirectives } from "../reply/directive-handling.js";
import type { MsgContext } from "../templating.js";

// --- Mocks ---

const resolveSandboxContextMock = vi.hoisted(() => vi.fn());
vi.mock("../../agents/sandbox/context.js", () => ({
  resolveSandboxContext: resolveSandboxContextMock,
}));

const findLastSuccessfulCheckpointMock = vi.hoisted(() => vi.fn());
const restoreCheckpointMock = vi.hoisted(() => vi.fn());
vi.mock("../../agents/sandbox/checkpoint.js", () => ({
  findLastSuccessfulCheckpoint: findLastSuccessfulCheckpointMock,
  restoreCheckpoint: restoreCheckpointMock,
}));

const resetStrideCounterMock = vi.hoisted(() => vi.fn());
vi.mock("../../agents/sandbox/checkpoint-stride.js", () => ({
  resetStrideCounter: resetStrideCounterMock,
}));

import type { HandleCommandsParams } from "./commands-types.js";
import { handleUndoCommand } from "./commands-undo.js";

// --- Helpers ---

const enabledCheckpointConfig = {
  enabled: true,
  strategy: "docker-commit" as const,
  onlyMutating: true,
  maxSnapshots: 10,
  ttlMs: 3_600_000,
  skipTools: [],
};

function makeSandboxCtx(opts?: {
  checkpointEnabled?: boolean;
  containerName?: string;
}): SandboxContext {
  const containerName = opts?.containerName ?? "test-container";
  const checkpointEnabled = opts?.checkpointEnabled ?? true;
  return {
    enabled: true,
    backendId: "docker",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/ws",
    agentWorkspaceDir: "/tmp/ws",
    workspaceAccess: "rw" as const,
    runtimeId: containerName,
    runtimeLabel: containerName,
    containerName,
    containerWorkdir: "/workspace",
    docker: {} as SandboxContext["docker"],
    tools: {} as SandboxContext["tools"],
    browserAllowHostControl: false,
    checkpoint: checkpointEnabled ? { config: enabledCheckpointConfig } : undefined,
  };
}

function makeEntry(overrides?: Partial<CheckpointEntry>): CheckpointEntry {
  return {
    id: "ckpt-1",
    containerName: "test-container",
    sessionKey: "agent:main:main",
    toolCallId: "tc-1",
    toolName: "exec",
    phase: "after",
    createdAtMs: Date.now() - 120_000,
    snapshotRef: "openclaw-ckpt:ckpt-1",
    strategy: "docker-commit",
    restorable: true,
    ...overrides,
  };
}

function buildParams(commandBody: string): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
  } as MsgContext;
  return {
    ctx,
    cfg: {} as OpenClawConfig,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      ownerList: ["+1234567890"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
    },
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/ws",
    defaultGroupActivation: () => "mention" as const,
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSandboxContextMock.mockResolvedValue(makeSandboxCtx());
  findLastSuccessfulCheckpointMock.mockResolvedValue(makeEntry());
  restoreCheckpointMock.mockResolvedValue(true);
});

describe("handleUndoCommand", () => {
  it("returns null for unrelated commands", async () => {
    const result = await handleUndoCommand(buildParams("/compact"), true);
    expect(result).toBeNull();
  });

  it("returns null for empty body", async () => {
    const result = await handleUndoCommand(buildParams("/status"), true);
    expect(result).toBeNull();
  });

  it("responds with unavailable message when sandbox has no checkpoint config", async () => {
    resolveSandboxContextMock.mockResolvedValue(makeSandboxCtx({ checkpointEnabled: false }));
    const result = await handleUndoCommand(buildParams("/undo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("not available");
  });

  it("responds with unavailable message when sandboxCtx is null", async () => {
    resolveSandboxContextMock.mockResolvedValue(null);
    const result = await handleUndoCommand(buildParams("/undo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("not available");
  });

  it("responds with no checkpoint message when none exists", async () => {
    findLastSuccessfulCheckpointMock.mockResolvedValue(null);
    const result = await handleUndoCommand(buildParams("/undo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("No checkpoint available");
  });

  it("responds with failure message when restore returns false", async () => {
    restoreCheckpointMock.mockResolvedValue(false);
    const result = await handleUndoCommand(buildParams("/undo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Failed to restore checkpoint");
    expect(resetStrideCounterMock).not.toHaveBeenCalled();
  });

  it("responds with success message on successful restore", async () => {
    const result = await handleUndoCommand(buildParams("/undo"), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("✅");
    expect(result?.reply?.text).toContain("exec");
    expect(resetStrideCounterMock).toHaveBeenCalledWith("agent:main:main");
  });

  it("calls restoreCheckpoint with the correct id and container name", async () => {
    const entry = makeEntry({ id: "ckpt-99", containerName: "my-box" });
    findLastSuccessfulCheckpointMock.mockResolvedValue(entry);
    resolveSandboxContextMock.mockResolvedValue(makeSandboxCtx({ containerName: "my-box" }));

    await handleUndoCommand(buildParams("/undo"), true);

    expect(restoreCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ckpt-99", containerName: "my-box" }),
    );
  });

  it("ignores trailing whitespace after /undo", async () => {
    const result = await handleUndoCommand(buildParams("/undo   "), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("✅");
  });

  it("returns shouldContinue: false for unauthorized senders without replying", async () => {
    const params = buildParams("/undo");
    params.command.isAuthorizedSender = false;
    const result = await handleUndoCommand(params, true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
  });
});
