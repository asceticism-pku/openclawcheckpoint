import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before any imports
const { TEST_REGISTRY_PATH } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-checkpoint-registry-test-"));
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
}));

import fs from "node:fs/promises";
import {
  addCheckpointEntry,
  findCheckpointByLabel,
  listCheckpointsSorted,
  updateCheckpointEntry,
} from "./checkpoint-registry.js";
import type { CheckpointEntry } from "./checkpoint-types.js";

function makeEntry(overrides?: Partial<CheckpointEntry>): CheckpointEntry {
  return {
    id: `ckpt-${Math.random().toString(36).slice(2)}`,
    containerName: "test-container",
    sessionKey: "test-session",
    toolCallId: "tc-1",
    toolName: "exec",
    phase: "after",
    createdAtMs: Date.now(),
    snapshotRef: "openclaw-ckpt:test",
    strategy: "docker-commit",
    restorable: true,
    source: "auto",
    ...overrides,
  };
}

beforeEach(async () => {
  // Remove the registry file before each test for a clean slate
  await fs.unlink(TEST_REGISTRY_PATH).catch(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("findCheckpointByLabel", () => {
  it("returns null when no checkpoints exist", async () => {
    const result = await findCheckpointByLabel("test-container", "my-label");
    expect(result).toBeNull();
  });

  it("returns null when no checkpoint has the given label", async () => {
    const entry = makeEntry({ label: "other-label" });
    await addCheckpointEntry(entry);

    const result = await findCheckpointByLabel("test-container", "my-label");
    expect(result).toBeNull();
  });

  it("returns the entry when a matching label is found", async () => {
    const entry = makeEntry({ label: "my-label" });
    await addCheckpointEntry(entry);

    const result = await findCheckpointByLabel("test-container", "my-label");
    expect(result?.id).toBe(entry.id);
    expect(result?.label).toBe("my-label");
  });

  it("returns the most recent entry when multiple entries share the same label", async () => {
    const older = makeEntry({ id: "ckpt-old", label: "my-label", createdAtMs: 1000 });
    const newer = makeEntry({ id: "ckpt-new", label: "my-label", createdAtMs: 2000 });
    await addCheckpointEntry(older);
    await addCheckpointEntry(newer);

    const result = await findCheckpointByLabel("test-container", "my-label");
    expect(result?.id).toBe("ckpt-new");
  });

  it("only returns entries for the given containerName", async () => {
    const entry = makeEntry({ label: "my-label", containerName: "other-container" });
    await addCheckpointEntry(entry);

    const result = await findCheckpointByLabel("test-container", "my-label");
    expect(result).toBeNull();
  });
});

describe("listCheckpointsSorted", () => {
  it("returns an empty array when no checkpoints exist", async () => {
    const result = await listCheckpointsSorted("test-container");
    expect(result).toEqual([]);
  });

  it("returns checkpoints sorted newest first", async () => {
    const a = makeEntry({ id: "ckpt-a", createdAtMs: 1000 });
    const b = makeEntry({ id: "ckpt-b", createdAtMs: 3000 });
    const c = makeEntry({ id: "ckpt-c", createdAtMs: 2000 });
    await addCheckpointEntry(a);
    await addCheckpointEntry(b);
    await addCheckpointEntry(c);

    const result = await listCheckpointsSorted("test-container");
    expect(result.map((e) => e.id)).toEqual(["ckpt-b", "ckpt-c", "ckpt-a"]);
  });

  it("only returns entries for the given containerName", async () => {
    const entry = makeEntry({ containerName: "other-container" });
    await addCheckpointEntry(entry);

    const result = await listCheckpointsSorted("test-container");
    expect(result).toHaveLength(0);
  });
});

describe("updateCheckpointEntry", () => {
  it("returns false when checkpoint does not exist", async () => {
    const result = await updateCheckpointEntry("nonexistent-id", { description: "updated" });
    expect(result).toBe(false);
  });

  it("returns true and updates description when checkpoint exists", async () => {
    const entry = makeEntry({ id: "ckpt-update" });
    await addCheckpointEntry(entry);

    const result = await updateCheckpointEntry("ckpt-update", {
      description: "new description",
    });
    expect(result).toBe(true);

    // Verify via listCheckpointsSorted
    const all = await listCheckpointsSorted("test-container");
    const found = all.find((e) => e.id === "ckpt-update");
    expect(found?.description).toBe("new description");
  });

  it("appends to explorationLog correctly", async () => {
    const entry = makeEntry({ id: "ckpt-log", explorationLog: ["[FAILED] first attempt"] });
    await addCheckpointEntry(entry);

    await updateCheckpointEntry("ckpt-log", {
      explorationLog: ["[FAILED] first attempt", "[FAILED] second attempt"],
    });

    const all = await listCheckpointsSorted("test-container");
    const found = all.find((e) => e.id === "ckpt-log");
    expect(found?.explorationLog).toEqual(["[FAILED] first attempt", "[FAILED] second attempt"]);
  });

  it("does not modify other entries", async () => {
    const entry1 = makeEntry({ id: "ckpt-1", label: "label-1" });
    const entry2 = makeEntry({ id: "ckpt-2", label: "label-2" });
    await addCheckpointEntry(entry1);
    await addCheckpointEntry(entry2);

    await updateCheckpointEntry("ckpt-1", { description: "modified" });

    const all = await listCheckpointsSorted("test-container");
    const entry2After = all.find((e) => e.id === "ckpt-2");
    expect(entry2After?.description).toBeUndefined();
  });
});
