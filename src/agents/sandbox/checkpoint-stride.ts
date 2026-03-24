/**
 * Per-session stride counter for checkpoint creation.
 *
 * Tracks how many mutating tool calls have been made per session so that
 * checkpoints can be created only every Nth call (stride-based throttling).
 */

/** In-memory counter of mutating tool calls per session. */
const strideCounts = new Map<string, number>();

/**
 * Increments the per-session mutating tool call counter and returns true when
 * the counter is a multiple of `stride` (i.e., a checkpoint should be created).
 *
 * With stride=1 (the default), returns true on every call.
 * With stride=3, returns true on calls 3, 6, 9, …
 *
 * @param sessionKey - Unique key identifying the agent session.
 * @param stride     - How often to checkpoint (must be >= 1; values < 1 are treated as 1).
 */
export function shouldCheckpointAtStride(sessionKey: string, stride: number): boolean {
  const effectiveStride = Number.isInteger(stride) && stride >= 1 ? stride : 1;
  const current = (strideCounts.get(sessionKey) ?? 0) + 1;
  strideCounts.set(sessionKey, current);
  return current % effectiveStride === 0;
}

/**
 * Resets the stride counter for a session.
 * Call this when a session is reset or destroyed.
 */
export function resetStrideCounter(sessionKey: string): void {
  strideCounts.delete(sessionKey);
}

/**
 * Returns the current stride count for a session (number of mutating tool calls recorded).
 * Returns 0 for unknown / newly-created sessions.
 */
export function getStrideCount(sessionKey: string): number {
  return strideCounts.get(sessionKey) ?? 0;
}
