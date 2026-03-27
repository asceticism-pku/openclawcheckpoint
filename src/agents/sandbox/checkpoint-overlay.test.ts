import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before any imports
const { TEST_OVERLAY_DIR } = vi.hoisted(() => {
  const path = require("node:path");
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const baseDir = mkdtempSync(path.join(tmpdir(), "openclaw-overlay-test-"));
  return { TEST_OVERLAY_DIR: baseDir };
});

vi.mock("./constants.js", () => ({
  SANDBOX_STATE_DIR: TEST_OVERLAY_DIR,
  SANDBOX_REGISTRY_PATH: path.join(TEST_OVERLAY_DIR, "containers.json"),
  SANDBOX_BROWSER_REGISTRY_PATH: path.join(TEST_OVERLAY_DIR, "browsers.json"),
  SANDBOX_CHECKPOINT_REGISTRY_PATH: path.join(TEST_OVERLAY_DIR, "checkpoints.json"),
  SANDBOX_CHECKPOINT_OVERLAY_DIR: path.join(TEST_OVERLAY_DIR, "checkpoints"),
}));

const execDockerMock = vi.fn();
const execDockerRawMock = vi.fn();
vi.mock("./docker.js", () => ({
  execDocker: (...args: unknown[]) => execDockerMock(...args),
  execDockerRaw: (...args: unknown[]) => execDockerRawMock(...args),
}));

import {
  createOverlayCheckpoint,
  readOverlayMeta,
  removeOverlayArtifacts,
  isOverlaySupported,
} from "./checkpoint-overlay.js";

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

describe("createOverlayCheckpoint", () => {
  it("returns null when docker diff shows no changes", async () => {
    execDockerMock.mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    const result = await createOverlayCheckpoint("my-container", "test-id-1", null);
    expect(result).toBeNull();
  });

  it("returns null when docker diff fails", async () => {
    execDockerMock.mockRejectedValueOnce(new Error("docker diff failed"));
    const result = await createOverlayCheckpoint("my-container", "test-id-2", null);
    expect(result).toBeNull();
  });

  it("creates tar and meta files for changed paths", async () => {
    // docker diff returns some changed files
    execDockerMock.mockResolvedValueOnce({
      stdout: "A /etc/newfile.conf\nC /etc/existing.conf\nD /tmp/deleted.txt\n",
      stderr: "",
      code: 0,
    });
    // docker cp raw calls (one per changed file)
    execDockerRawMock.mockResolvedValue({
      stdout: Buffer.from("fake-tar-content"),
      stderr: Buffer.from(""),
      code: 0,
    });

    const result = await createOverlayCheckpoint("test-container", "overlay-id-3", null);
    expect(result).not.toBeNull();
    expect(result!.changedPaths).toContain("/etc/newfile.conf");
    expect(result!.changedPaths).toContain("/etc/existing.conf");
    expect(result!.deletedPaths).toContain("/tmp/deleted.txt");
    expect(result!.tarPath).toContain("overlay-id-3.tar.gz");
    expect(result!.metaPath).toContain("overlay-id-3.meta.json");
  });

  it("writes correct sidecar metadata", async () => {
    execDockerMock.mockResolvedValueOnce({
      stdout: "A /workspace/app.py\nD /tmp/old.log\n",
      stderr: "",
      code: 0,
    });
    execDockerRawMock.mockResolvedValue({
      stdout: Buffer.from("data"),
      stderr: Buffer.from(""),
      code: 0,
    });

    const id = "meta-test-id";
    const parentId = "parent-id-123";
    await createOverlayCheckpoint("meta-container", id, parentId);

    const meta = await readOverlayMeta("meta-container", id);
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe(id);
    expect(meta!.containerName).toBe("meta-container");
    expect(meta!.parentCheckpointId).toBe(parentId);
    expect(meta!.changedPaths).toContain("/workspace/app.py");
    expect(meta!.deletedPaths).toContain("/tmp/old.log");
  });

  it("handles only deleted files (no changed paths) by skipping tar", async () => {
    execDockerMock.mockResolvedValueOnce({
      stdout: "D /tmp/deleted.txt\n",
      stderr: "",
      code: 0,
    });

    const result = await createOverlayCheckpoint("del-container", "del-id", null);
    // Only deletions — no changed files to tar, but we still create the meta.
    expect(result).not.toBeNull();
    expect(result!.changedPaths).toHaveLength(0);
    expect(result!.deletedPaths).toContain("/tmp/deleted.txt");
    expect(result!.sizeBytes).toBe(0);
    // execDockerRaw should NOT have been called (no files to cp)
    expect(execDockerRawMock).not.toHaveBeenCalled();
  });
});

describe("readOverlayMeta", () => {
  it("returns null when meta file does not exist", async () => {
    const result = await readOverlayMeta("nonexistent-container", "nonexistent-id");
    expect(result).toBeNull();
  });
});

describe("removeOverlayArtifacts", () => {
  it("does not throw when files do not exist", async () => {
    await expect(removeOverlayArtifacts("ghost-container", "ghost-id")).resolves.toBeUndefined();
  });

  it("removes tar and meta files when they exist", async () => {
    // Create actual temp files to verify removal.
    const overlayDir = path.join(TEST_OVERLAY_DIR, "checkpoints", "cleanup_container");
    await fs.mkdir(overlayDir, { recursive: true });
    const tarPath = path.join(overlayDir, "cleanup-id.tar.gz");
    const metaPath = path.join(overlayDir, "cleanup-id.meta.json");
    await fs.writeFile(tarPath, "fake");
    await fs.writeFile(metaPath, "{}");

    await removeOverlayArtifacts("cleanup_container", "cleanup-id");

    await expect(fs.access(tarPath)).rejects.toThrow();
    await expect(fs.access(metaPath)).rejects.toThrow();
  });
});

describe("isOverlaySupported", () => {
  it("returns true when docker diff succeeds", async () => {
    execDockerMock.mockResolvedValueOnce({ stdout: "", stderr: "", code: 0 });
    const result = await isOverlaySupported("my-container");
    expect(result).toBe(true);
    expect(execDockerMock).toHaveBeenCalledWith(["diff", "my-container"]);
  });

  it("returns false when docker diff throws", async () => {
    execDockerMock.mockRejectedValueOnce(new Error("unsupported"));
    const result = await isOverlaySupported("my-container");
    expect(result).toBe(false);
  });
});
