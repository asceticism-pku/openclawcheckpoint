import fs from "node:fs/promises";
import { writeJsonAtomic } from "../../infra/json-files.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import type { CheckpointConfig, CheckpointEntry, CheckpointRegistry } from "./checkpoint-types.js";
import { SANDBOX_CHECKPOINT_REGISTRY_PATH } from "./constants.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCheckpointEntry(value: unknown): value is CheckpointEntry {
  return isRecord(value) && typeof value.id === "string" && typeof value.containerName === "string";
}

function isCheckpointRegistry(value: unknown): value is CheckpointRegistry {
  if (!isRecord(value)) {
    return false;
  }
  const maybeEntries = value.entries;
  return Array.isArray(maybeEntries) && maybeEntries.every(isCheckpointEntry);
}

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: SANDBOX_CHECKPOINT_REGISTRY_PATH,
    allowReentrant: false,
  });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function readRegistryFile(): Promise<CheckpointRegistry> {
  try {
    const raw = await fs.readFile(SANDBOX_CHECKPOINT_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isCheckpointRegistry(parsed)) {
      return parsed;
    }
    return { entries: [] };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { entries: [] };
    }
    return { entries: [] };
  }
}

async function writeRegistryFile(registry: CheckpointRegistry): Promise<void> {
  await writeJsonAtomic(SANDBOX_CHECKPOINT_REGISTRY_PATH, registry, { trailingNewline: true });
}

export async function readCheckpointRegistry(): Promise<CheckpointRegistry> {
  return readRegistryFile();
}

export async function addCheckpointEntry(entry: CheckpointEntry): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    registry.entries.push(entry);
    await writeRegistryFile(registry);
  });
}

export async function removeCheckpointEntry(id: string): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    const next = registry.entries.filter((e) => e.id !== id);
    if (next.length === registry.entries.length) {
      return;
    }
    await writeRegistryFile({ entries: next });
  });
}

export async function listCheckpoints(containerName: string): Promise<CheckpointEntry[]> {
  const registry = await readRegistryFile();
  return registry.entries.filter((e) => e.containerName === containerName);
}

export async function pruneCheckpointsAfter(
  containerName: string,
  afterTimestamp: number,
): Promise<CheckpointEntry[]> {
  let pruned: CheckpointEntry[] = [];
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    const kept: CheckpointEntry[] = [];
    for (const entry of registry.entries) {
      if (entry.containerName === containerName && entry.createdAtMs > afterTimestamp) {
        pruned.push(entry);
      } else {
        kept.push(entry);
      }
    }
    if (pruned.length > 0) {
      await writeRegistryFile({ entries: kept });
    }
  });
  return pruned;
}

export async function findCheckpointByLabel(
  containerName: string,
  label: string,
): Promise<CheckpointEntry | null> {
  const registry = await readRegistryFile();
  const matches = registry.entries.filter(
    (e) => e.containerName === containerName && e.label === label,
  );
  if (matches.length === 0) {
    return null;
  }
  // Return the most recently created match.
  matches.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return matches[0] ?? null;
}

export async function listCheckpointsSorted(containerName: string): Promise<CheckpointEntry[]> {
  const registry = await readRegistryFile();
  const entries = registry.entries.filter((e) => e.containerName === containerName);
  entries.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return entries;
}

export async function updateCheckpointEntry(
  id: string,
  updates: Partial<Pick<CheckpointEntry, "explorationLog" | "description">>,
): Promise<boolean> {
  let found = false;
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    const idx = registry.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      return;
    }
    found = true;
    const existing = registry.entries[idx];
    if (existing) {
      registry.entries[idx] = { ...existing, ...updates };
    }
    await writeRegistryFile(registry);
  });
  return found;
}

/**
 * Prunes checkpoints for a container when their cumulative `sizeBytes` exceeds
 * `maxTotalSizeBytes`. Removes oldest entries first until within budget.
 *
 * Returns the list of pruned entries (callers are responsible for removing
 * the corresponding snapshot artifacts).
 */
export async function pruneByTotalSize(
  containerName: string,
  maxTotalSizeBytes: number,
): Promise<CheckpointEntry[]> {
  let pruned: CheckpointEntry[] = [];
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    const forContainer = registry.entries.filter((e) => e.containerName === containerName);
    const others = registry.entries.filter((e) => e.containerName !== containerName);

    // Sort ascending by creation time so we prune oldest first.
    forContainer.sort((a, b) => a.createdAtMs - b.createdAtMs);

    let totalBytes = forContainer.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);

    if (totalBytes <= maxTotalSizeBytes) {
      return;
    }

    const kept: CheckpointEntry[] = [];
    for (const entry of forContainer) {
      if (totalBytes > maxTotalSizeBytes) {
        pruned.push(entry);
        totalBytes -= entry.sizeBytes ?? 0;
      } else {
        kept.push(entry);
      }
    }

    if (pruned.length > 0) {
      await writeRegistryFile({ entries: [...others, ...kept] });
    }
  });
  return pruned;
}

export async function pruneOldCheckpoints(
  containerName: string,
  config: CheckpointConfig,
): Promise<CheckpointEntry[]> {
  let pruned: CheckpointEntry[] = [];
  await withRegistryLock(async () => {
    const registry = await readRegistryFile();
    const forContainer = registry.entries.filter((e) => e.containerName === containerName);
    const others = registry.entries.filter((e) => e.containerName !== containerName);

    const nowMs = Date.now();
    const cutoffMs = nowMs - config.ttlMs;

    // Separate expired (by TTL) from still-valid
    const expired = forContainer.filter((e) => e.createdAtMs < cutoffMs);
    let valid = forContainer.filter((e) => e.createdAtMs >= cutoffMs);

    // Trim to maxSnapshots (remove oldest first)
    let excess: CheckpointEntry[] = [];
    if (valid.length > config.maxSnapshots) {
      // Sort ascending by creation time so oldest are at front
      valid.sort((a, b) => a.createdAtMs - b.createdAtMs);
      excess = valid.slice(0, valid.length - config.maxSnapshots);
      valid = valid.slice(valid.length - config.maxSnapshots);
    }

    pruned = [...expired, ...excess];
    if (pruned.length > 0) {
      await writeRegistryFile({ entries: [...others, ...valid] });
    }
  });
  return pruned;
}
