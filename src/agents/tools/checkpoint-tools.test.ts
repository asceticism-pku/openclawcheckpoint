import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointEntry } from "../sandbox/checkpoint-types.js";

// --- Mocks ---

const createCheckpointMock = vi.hoisted(() => vi.fn());
const findLastSuccessfulCheckpointMock = vi.hoisted(() => vi.fn());
const restoreCheckpointMock = vi.hoisted(() => vi.fn());
const resolveCheckpointConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../sandbox/checkpoint.js", () => ({
  createCheckpoint: createCheckpointMock,
  findLastSuccessfulCheckpoint: findLastSuccessfulCheckpointMock,
  restoreCheckpoint: restoreCheckpointMock,
  resolveCheckpointConfig: resolveCheckpointConfigMock,
}));

const findCheckpointByLabelMock = vi.hoisted(() => vi.fn());
const listCheckpointsSortedMock = vi.hoisted(() => vi.fn());
const updateCheckpointEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../sandbox/checkpoint-registry.js", () => ({
  findCheckpointByLabel: findCheckpointByLabelMock,
  listCheckpointsSorted: listCheckpointsSortedMock,
  updateCheckpointEntry: updateCheckpointEntryMock,
}));

const resetStrideCounterMock = vi.hoisted(() => vi.fn());

vi.mock("../sandbox/checkpoint-stride.js", () => ({
  resetStrideCounter: resetStrideCounterMock,
}));

const execDockerMock = vi.hoisted(() => vi.fn());

vi.mock("../sandbox/docker.js", () => ({
  execDocker: execDockerMock,
}));

import { createCheckpointTools } from "./checkpoint-tools.js";

const enabledConfig = {
  enabled: true,
  strategy: "docker-commit" as const,
  onlyMutating: true,
  maxSnapshots: 10,
  ttlMs: 3_600_000,
  skipTools: [],
};

const disabledConfig = { ...enabledConfig, enabled: false };

const ctx = {
  sessionKey: "test:session",
  containerName: "test-container",
  checkpointConfig: enabledConfig,
};

function makeEntry(overrides?: Partial<CheckpointEntry>): CheckpointEntry {
  return {
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
    source: "auto",
    ...overrides,
  };
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const tools = createCheckpointTools(ctx);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool?.execute) {
    throw new Error(`Tool ${toolName} not found or has no execute`);
  }
  const result = await tool.execute("tc-test", args, undefined, undefined);
  const textContent = result?.content?.find(
    (c): c is { type: "text"; text: string } => c.type === "text",
  );
  return textContent ? JSON.parse(textContent.text) : null;
}

beforeEach(() => {
  resolveCheckpointConfigMock.mockReturnValue(enabledConfig);
  createCheckpointMock.mockResolvedValue(
    makeEntry({ id: "new-ckpt-id", label: "test-label", source: "agent" }),
  );
  findLastSuccessfulCheckpointMock.mockResolvedValue(makeEntry());
  restoreCheckpointMock.mockResolvedValue(true);
  listCheckpointsSortedMock.mockResolvedValue([makeEntry()]);
  findCheckpointByLabelMock.mockResolvedValue(null);
  updateCheckpointEntryMock.mockResolvedValue(true);
  execDockerMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createCheckpointTools", () => {
  it("creates all four tools", () => {
    const tools = createCheckpointTools(ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain("checkpoint_save");
    expect(names).toContain("checkpoint_list");
    expect(names).toContain("checkpoint_restore");
    expect(names).toContain("checkpoint_diff");
    expect(tools).toHaveLength(4);
  });
});

describe("checkpoint_save", () => {
  it("returns success with checkpoint_id when create succeeds", async () => {
    const result = (await callTool("checkpoint_save", {
      label: "my-label",
      description: "test state",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.checkpoint_id).toBe("new-ckpt-id");
    expect(result.label).toBe("test-label");
    expect(result.message).toContain("my-label");
  });

  it("passes label, source=agent, and description to createCheckpoint", async () => {
    await callTool("checkpoint_save", { label: "my-label", description: "my desc" });

    expect(createCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "my-label",
        source: "agent",
        description: "my desc",
        toolName: "checkpoint_save",
        containerName: "test-container",
        sessionKey: "test:session",
      }),
    );
  });

  it("returns failure when checkpoints are disabled", async () => {
    resolveCheckpointConfigMock.mockReturnValue(disabledConfig);

    const result = (await callTool("checkpoint_save", { label: "x" })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain("not enabled");
  });

  it("returns failure when createCheckpoint returns null", async () => {
    createCheckpointMock.mockResolvedValue(null);

    const result = (await callTool("checkpoint_save", { label: "x" })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create checkpoint");
  });

  it("throws ToolInputError when label is missing", async () => {
    await expect(callTool("checkpoint_save", {})).rejects.toThrow("label");
  });
});

describe("checkpoint_list", () => {
  it("returns list of checkpoints", async () => {
    const entry = makeEntry({ label: "my-label", source: "agent", description: "test desc" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);

    const result = (await callTool("checkpoint_list", {})) as Record<string, unknown>;
    expect(result.total).toBe(1);
    expect(Array.isArray(result.checkpoints)).toBe(true);
    const [first] = result.checkpoints as Array<Record<string, unknown>>;
    expect(first?.id).toBe(entry.id);
    expect(first?.label).toBe("my-label");
    expect(first?.source).toBe("agent");
  });

  it("returns empty list when no checkpoints", async () => {
    listCheckpointsSortedMock.mockResolvedValue([]);

    const result = (await callTool("checkpoint_list", {})) as Record<string, unknown>;
    expect(result.total).toBe(0);
    expect(result.checkpoints).toEqual([]);
    expect(result.message).toContain("No checkpoints");
  });

  it("returns message when checkpoints disabled", async () => {
    resolveCheckpointConfigMock.mockReturnValue(disabledConfig);

    const result = (await callTool("checkpoint_list", {})) as Record<string, unknown>;
    expect(result.checkpoints).toEqual([]);
    expect(result.message).toContain("not enabled");
  });
});

describe("checkpoint_restore", () => {
  it("restores by checkpoint_id when provided", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);

    const result = (await callTool("checkpoint_restore", {
      checkpoint_id: "ckpt-42",
      reason: "test failed",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.checkpoint_id).toBe("ckpt-42");
    expect(restoreCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ckpt-42", containerName: "test-container" }),
    );
  });

  it("restores by label when checkpoint_id is not provided", async () => {
    const entry = makeEntry({ id: "ckpt-label", label: "before-config" });
    findCheckpointByLabelMock.mockResolvedValue(entry);
    listCheckpointsSortedMock.mockResolvedValue([entry]);

    const result = (await callTool("checkpoint_restore", {
      label: "before-config",
      reason: "config failed",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(findCheckpointByLabelMock).toHaveBeenCalledWith("test-container", "before-config");
    expect(restoreCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ckpt-label" }),
    );
  });

  it("falls back to last checkpoint when neither id nor label provided", async () => {
    const result = (await callTool("checkpoint_restore", {
      reason: "retrying",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(findLastSuccessfulCheckpointMock).toHaveBeenCalledWith("test-container");
  });

  it("records the reason in the exploration log before restoring", async () => {
    const entry = makeEntry({ id: "ckpt-42", explorationLog: ["[FAILED] earlier attempt"] });
    listCheckpointsSortedMock.mockResolvedValue([entry]);

    await callTool("checkpoint_restore", { checkpoint_id: "ckpt-42", reason: "new failure" });

    expect(updateCheckpointEntryMock).toHaveBeenCalledWith(
      "ckpt-42",
      expect.objectContaining({
        explorationLog: ["[FAILED] earlier attempt", "[FAILED] new failure"],
      }),
    );
  });

  it("resets the stride counter after successful restore", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);

    await callTool("checkpoint_restore", { checkpoint_id: "ckpt-42", reason: "testing" });

    expect(resetStrideCounterMock).toHaveBeenCalledWith("test:session");
  });

  it("includes exploration log in response message", async () => {
    const entry = makeEntry({
      id: "ckpt-42",
      explorationLog: ["[FAILED] approach 1"],
    });
    listCheckpointsSortedMock.mockResolvedValue([entry]);
    // After update, return updated entry with new log
    updateCheckpointEntryMock.mockResolvedValue(true);
    const updatedEntry = { ...entry, explorationLog: ["[FAILED] approach 1", "[FAILED] retry"] };
    listCheckpointsSortedMock
      .mockResolvedValueOnce([entry]) // first call to find entry
      .mockResolvedValueOnce([updatedEntry]); // second call after update

    const result = (await callTool("checkpoint_restore", {
      checkpoint_id: "ckpt-42",
      reason: "retry",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.message).toContain("Previous exploration attempts");
  });

  it("returns failure when no checkpoint found by label", async () => {
    findCheckpointByLabelMock.mockResolvedValue(null);

    const result = (await callTool("checkpoint_restore", {
      label: "nonexistent",
      reason: "testing",
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain("nonexistent");
  });

  it("returns failure when restore fails", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);
    restoreCheckpointMock.mockResolvedValue(false);

    const result = (await callTool("checkpoint_restore", {
      checkpoint_id: "ckpt-42",
      reason: "testing",
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(resetStrideCounterMock).not.toHaveBeenCalled();
  });

  it("throws ToolInputError when reason is missing", async () => {
    await expect(callTool("checkpoint_restore", {})).rejects.toThrow("reason");
  });

  it("returns failure when checkpoints disabled", async () => {
    resolveCheckpointConfigMock.mockReturnValue(disabledConfig);

    const result = (await callTool("checkpoint_restore", {
      reason: "testing",
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain("not enabled");
  });
});

describe("checkpoint_diff", () => {
  it("returns diff output with added/modified/deleted files", async () => {
    const entry = makeEntry({ id: "ckpt-42", label: "base" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);
    execDockerMock.mockResolvedValue({
      stdout: "A /home/user/new-file.txt\nC /etc/config.conf\nD /tmp/old-file.log\n",
      stderr: "",
      code: 0,
    });

    const result = (await callTool("checkpoint_diff", {
      checkpoint_id: "ckpt-42",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.added).toEqual(["/home/user/new-file.txt"]);
    expect(result.modified).toEqual(["/etc/config.conf"]);
    expect(result.deleted).toEqual(["/tmp/old-file.log"]);
    expect(result.total_changes).toBe(3);
  });

  it("returns no changes when diff is empty", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);
    execDockerMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const result = (await callTool("checkpoint_diff", {
      checkpoint_id: "ckpt-42",
    })) as Record<string, unknown>;

    expect(result.success).toBe(true);
    expect(result.total_changes).toBe(0);
    expect(result.message).toContain("No changes");
  });

  it("falls back to last checkpoint when no id/label provided", async () => {
    execDockerMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const result = (await callTool("checkpoint_diff", {})) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(findLastSuccessfulCheckpointMock).toHaveBeenCalledWith("test-container");
  });

  it("returns failure when no checkpoints available", async () => {
    findLastSuccessfulCheckpointMock.mockResolvedValue(null);

    const result = (await callTool("checkpoint_diff", {})) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.error).toContain("No checkpoints");
  });

  it("returns failure when docker diff fails", async () => {
    const entry = makeEntry({ id: "ckpt-42" });
    listCheckpointsSortedMock.mockResolvedValue([entry]);
    execDockerMock.mockRejectedValue(new Error("docker error"));

    const result = (await callTool("checkpoint_diff", {
      checkpoint_id: "ckpt-42",
    })) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.error).toContain("docker error");
  });
});
