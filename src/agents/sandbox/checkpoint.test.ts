import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before any imports
const { TEST_REGISTRY_PATH } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-checkpoint-test-"));
  return {
    TEST_REGISTRY_PATH: path.join(baseDir, "checkpoints.json"),
  };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: require("node:path").dirname(TEST_REGISTRY_PATH),
  SANDBOX_REGISTRY_PATH: require("node:path").join(
    require("node:path").dirname(TEST_REGISTRY_PATH),
    "containers.json",
  ),
  SANDBOX_BROWSER_REGISTRY_PATH: require("node:path").join(
    require("node:path").dirname(TEST_REGISTRY_PATH),
    "browsers.json",
  ),
  SANDBOX_CHECKPOINT_REGISTRY_PATH: TEST_REGISTRY_PATH,
  SANDBOX_CHECKPOINT_OVERLAY_DIR: require("node:path").join(
    require("node:path").dirname(TEST_REGISTRY_PATH),
    "checkpoints",
  ),
}));

const execDockerMock = vi.fn();
const execDockerRawMock = vi.fn();
vi.mock("./docker.js", () => ({
  execDocker: (...args: unknown[]) => execDockerMock(...args),
  execDockerRaw: (...args: unknown[]) => execDockerRawMock(...args),
}));

// Mock overlay and memory modules so we don't need real filesystem/docker for these tests.
vi.mock("./checkpoint-overlay.js", () => ({
  createOverlayCheckpoint: vi.fn().mockResolvedValue(null),
  isOverlaySupported: vi.fn().mockResolvedValue(false),
  removeOverlayArtifacts: vi.fn().mockResolvedValue(undefined),
  restoreOverlayCheckpoint: vi.fn().mockResolvedValue(false),
}));

vi.mock("./checkpoint-memory.js", () => ({
  saveMemorySnapshot: vi.fn().mockResolvedValue(null),
  restoreMemorySnapshot: vi.fn().mockResolvedValue(true),
  removeMemorySnapshot: vi.fn().mockResolvedValue(undefined),
}));

import { readCheckpointRegistry } from "./checkpoint-registry.js";
import type { CheckpointConfig } from "./checkpoint-types.js";
import {
  createCheckpoint,
  DEFAULT_CHECKPOINT_CONFIG,
  findLastSuccessfulCheckpoint,
  isMutatingTool,
  removeCheckpointImage,
  resolveCheckpointConfig,
  resolveEffectiveStrategy,
  restoreCheckpoint,
} from "./checkpoint.js";

function makeConfig(overrides?: Partial<CheckpointConfig>): CheckpointConfig {
  return {
    ...DEFAULT_CHECKPOINT_CONFIG,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  execDockerMock.mockReset();
  execDockerRawMock.mockReset();
  execDockerMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  execDockerRawMock.mockResolvedValue({
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    code: 0,
  });
});

describe("isMutatingTool", () => {
  it("identifies mutating tools correctly", () => {
    expect(isMutatingTool("exec")).toBe(true);
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool("write")).toBe(true);
    expect(isMutatingTool("edit")).toBe(true);
    expect(isMutatingTool("apply_patch")).toBe(true);
  });

  it("identifies read-only tools as not mutating", () => {
    expect(isMutatingTool("read")).toBe(false);
    expect(isMutatingTool("browser")).toBe(false);
    expect(isMutatingTool("web_search")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isMutatingTool("EXEC")).toBe(true);
    expect(isMutatingTool("READ")).toBe(false);
  });
});

describe("resolveCheckpointConfig", () => {
  it("returns defaults when called with no args", () => {
    const cfg = resolveCheckpointConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.strategy).toBe("docker-commit");
    expect(cfg.maxSnapshots).toBe(10);
    expect(cfg.ttlMs).toBe(3_600_000);
    expect(cfg.skipTools).toEqual(["read", "browser", "web_search"]);
  });

  it("merges partial overrides with defaults", () => {
    const cfg = resolveCheckpointConfig({ enabled: true, maxSnapshots: 5 });
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxSnapshots).toBe(5);
    expect(cfg.strategy).toBe("docker-commit");
  });
});

describe("createCheckpoint", () => {
  it("returns null when disabled", async () => {
    const config = makeConfig({ enabled: false });
    const result = await createCheckpoint({
      containerName: "test-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(result).toBeNull();
    expect(execDockerMock).not.toHaveBeenCalled();
  });

  it("returns null when tool is not mutating and onlyMutating=true", async () => {
    const config = makeConfig({ onlyMutating: true });
    const result = await createCheckpoint({
      containerName: "test-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "read",
      phase: "after",
      config,
    });
    expect(result).toBeNull();
    expect(execDockerMock).not.toHaveBeenCalled();
  });

  it("checkpoints non-mutating tools when onlyMutating=false", async () => {
    const config = makeConfig({ onlyMutating: false, skipTools: [] });
    const result = await createCheckpoint({
      containerName: "test-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "read",
      phase: "after",
      config,
    });
    expect(result).not.toBeNull();
    expect(execDockerMock).toHaveBeenCalledWith(
      expect.arrayContaining(["commit", "test-container"]),
    );
  });

  it("returns null when tool is in skipTools", async () => {
    const config = makeConfig({ skipTools: ["exec", "bash"] });
    const result = await createCheckpoint({
      containerName: "test-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(result).toBeNull();
    expect(execDockerMock).not.toHaveBeenCalled();
  });

  it("returns null for unsupported strategy", async () => {
    const config = makeConfig({ strategy: "criu" });
    const result = await createCheckpoint({
      containerName: "test-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(result).toBeNull();
    expect(execDockerMock).not.toHaveBeenCalled();
  });

  it("calls docker commit with correct args", async () => {
    const config = makeConfig();
    const result = await createCheckpoint({
      containerName: "my-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(result).not.toBeNull();
    expect(execDockerMock).toHaveBeenCalledWith(expect.arrayContaining(["commit", "my-container"]));
    // The snapshot ref should match openclaw-ckpt:<uuid>
    const commitArgs = execDockerMock.mock.calls[0][0] as string[];
    expect(commitArgs[0]).toBe("commit");
    expect(commitArgs[1]).toBe("my-container");
    expect(commitArgs[2]).toMatch(/^openclaw-ckpt:[0-9a-f-]+$/);
  });

  it("returns a valid CheckpointEntry on success", async () => {
    const config = makeConfig();
    const result = await createCheckpoint({
      containerName: "my-container",
      sessionKey: "test:session",
      toolCallId: "tc-abc",
      toolName: "write",
      phase: "after",
      config,
    });
    expect(result).not.toBeNull();
    expect(result!.containerName).toBe("my-container");
    expect(result!.toolCallId).toBe("tc-abc");
    expect(result!.toolName).toBe("write");
    expect(result!.phase).toBe("after");
    expect(result!.strategy).toBe("docker-commit");
    expect(result!.restorable).toBe(true);
    expect(result!.snapshotRef).toMatch(/^openclaw-ckpt:/);
  });

  it("returns null when docker commit fails", async () => {
    execDockerMock.mockRejectedValueOnce(new Error("docker commit failed"));
    const config = makeConfig();
    const result = await createCheckpoint({
      containerName: "my-container",
      sessionKey: "test:session",
      toolCallId: "tc1",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(result).toBeNull();
  });
});

describe("restoreCheckpoint", () => {
  it("stops, removes, and recreates the container", async () => {
    const config = makeConfig();
    // Create a checkpoint first
    const entry = await createCheckpoint({
      containerName: "restore-container",
      sessionKey: "test:restore",
      toolCallId: "tc-restore",
      toolName: "exec",
      phase: "after",
      config,
    });
    expect(entry).not.toBeNull();

    execDockerMock.mockReset();
    execDockerMock.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const success = await restoreCheckpoint({
      id: entry!.id,
      containerName: "restore-container",
    });

    expect(success).toBe(true);

    // Verify docker stop, rm, create, start were called
    const calls = execDockerMock.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(calls).toContain("stop");
    expect(calls).toContain("rm");
    expect(calls).toContain("create");
    expect(calls).toContain("start");
  });

  it("returns false when checkpoint not found", async () => {
    const success = await restoreCheckpoint({
      id: "nonexistent-id",
      containerName: "some-container",
    });
    expect(success).toBe(false);
    expect(execDockerMock).not.toHaveBeenCalled();
  });
});

describe("findLastSuccessfulCheckpoint", () => {
  it("returns null when no checkpoints exist", async () => {
    const result = await findLastSuccessfulCheckpoint("empty-container");
    expect(result).toBeNull();
  });

  it("returns the most recent restorable checkpoint", async () => {
    const config = makeConfig();
    await createCheckpoint({
      containerName: "find-container",
      sessionKey: "test:find",
      toolCallId: "tc-1",
      toolName: "exec",
      phase: "after",
      config,
    });
    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const entry2 = await createCheckpoint({
      containerName: "find-container",
      sessionKey: "test:find",
      toolCallId: "tc-2",
      toolName: "write",
      phase: "after",
      config,
    });

    const found = await findLastSuccessfulCheckpoint("find-container");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(entry2!.id);
  });
});

describe("pruneOldCheckpoints (via createCheckpoint)", () => {
  it("removes checkpoints exceeding maxSnapshots", async () => {
    const config = makeConfig({ maxSnapshots: 2 });
    const container = "prune-container";

    // Create 3 checkpoints (should prune down to 2)
    for (let i = 0; i < 3; i++) {
      await createCheckpoint({
        containerName: container,
        sessionKey: "test:prune",
        toolCallId: `tc-${i}`,
        toolName: "exec",
        phase: "after",
        config,
      });
      // Small delay for distinct timestamps
      await new Promise((r) => setTimeout(r, 5));
    }

    const registry = await readCheckpointRegistry();
    const entries = registry.entries.filter((e) => e.containerName === container);
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("removes checkpoints older than ttlMs", async () => {
    const config = makeConfig({ ttlMs: 1 }); // 1ms TTL — everything expires
    const container = "ttl-container";

    await createCheckpoint({
      containerName: container,
      sessionKey: "test:ttl",
      toolCallId: "tc-0",
      toolName: "exec",
      phase: "after",
      config,
    });

    await new Promise((r) => setTimeout(r, 10));

    // Create one more checkpoint — this triggers pruning of the older one
    await createCheckpoint({
      containerName: container,
      sessionKey: "test:ttl",
      toolCallId: "tc-1",
      toolName: "exec",
      phase: "after",
      config,
    });

    const registry = await readCheckpointRegistry();
    const entries = registry.entries.filter((e) => e.containerName === container);
    // The oldest entry should have been pruned
    expect(entries.length).toBeLessThan(2);
  });
});

describe("removeCheckpointImage", () => {
  it("calls docker rmi with the snapshot ref", async () => {
    await removeCheckpointImage("openclaw-ckpt:test-id");
    expect(execDockerMock).toHaveBeenCalledWith(["rmi", "openclaw-ckpt:test-id"]);
  });

  it("does not throw when docker rmi fails", async () => {
    execDockerMock.mockRejectedValueOnce(new Error("No such image"));
    await expect(removeCheckpointImage("openclaw-ckpt:missing")).resolves.toBeUndefined();
  });
});

describe("resolveEffectiveStrategy", () => {
  it("returns 'docker-commit' for docker-commit strategy", async () => {
    const result = await resolveEffectiveStrategy("docker-commit", "any-container");
    expect(result).toBe("docker-commit");
  });

  it("returns 'overlay' for overlay strategy", async () => {
    const result = await resolveEffectiveStrategy("overlay", "any-container");
    expect(result).toBe("overlay");
  });

  it("returns 'criu' for criu strategy", async () => {
    const result = await resolveEffectiveStrategy("criu", "any-container");
    expect(result).toBe("criu");
  });

  it("resolves 'auto' to 'docker-commit' when overlay is not supported", async () => {
    const { isOverlaySupported } = await import("./checkpoint-overlay.js");
    vi.mocked(isOverlaySupported).mockResolvedValueOnce(false);
    const result = await resolveEffectiveStrategy("auto", "my-container");
    expect(result).toBe("docker-commit");
  });

  it("resolves 'auto' to 'overlay' when overlay is supported", async () => {
    const { isOverlaySupported } = await import("./checkpoint-overlay.js");
    vi.mocked(isOverlaySupported).mockResolvedValueOnce(true);
    const result = await resolveEffectiveStrategy("auto", "my-container");
    expect(result).toBe("overlay");
  });
});

describe("resolveCheckpointConfig new fields", () => {
  it("sets adaptiveStride false by default", () => {
    const cfg = resolveCheckpointConfig();
    expect(cfg.adaptiveStride).toBe(false);
  });

  it("sets memoryCheckpoint true by default", () => {
    const cfg = resolveCheckpointConfig();
    expect(cfg.memoryCheckpoint).toBe(true);
  });

  it("propagates maxTotalSizeBytes when provided", () => {
    const cfg = resolveCheckpointConfig({ maxTotalSizeBytes: 100_000 });
    expect(cfg.maxTotalSizeBytes).toBe(100_000);
  });

  it("leaves maxTotalSizeBytes undefined when not provided", () => {
    const cfg = resolveCheckpointConfig();
    expect(cfg.maxTotalSizeBytes).toBeUndefined();
  });
});
