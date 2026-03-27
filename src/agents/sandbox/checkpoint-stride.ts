/**
 * Per-session stride counter for checkpoint creation.
 *
 * Tracks how many mutating tool calls have been made per session so that
 * checkpoints can be created only every Nth call (stride-based throttling).
 *
 * Also supports adaptive stride: when tool calls arrive frequently, the stride
 * interval increases automatically to reduce checkpoint overhead during rapid
 * benchmark execution; when calls slow down, the stride decreases back toward 1.
 */

/** In-memory counter of mutating tool calls per session. */
const strideCounts = new Map<string, number>();

/**
 * Per-session timing state used for adaptive stride calculation.
 * Tracks recent inter-call intervals to compute a rolling average call rate.
 */
const adaptiveState = new Map<
  string,
  { lastCallMs: number; rollingAvgIntervalMs: number; currentStride: number }
>();

/**
 * Minimum interval (ms) between tool calls considered "fast" for adaptive stride.
 * Calls arriving faster than this will increase the stride.
 */
const ADAPTIVE_FAST_THRESHOLD_MS = 2_000;

/**
 * Maximum stride the adaptive algorithm will ever use.
 */
const ADAPTIVE_MAX_STRIDE = 8;

/**
 * Minimum stride the adaptive algorithm will use (never goes below 1).
 */
const ADAPTIVE_MIN_STRIDE = 1;

/**
 * Computes the adaptive stride value for the given session based on recent call rate.
 * Updates internal state on each call.
 *
 * - If calls are arriving faster than ADAPTIVE_FAST_THRESHOLD_MS on average,
 *   the stride increments (up to ADAPTIVE_MAX_STRIDE).
 * - If calls are slower, the stride decrements back toward ADAPTIVE_MIN_STRIDE.
 */
export function computeAdaptiveStride(sessionKey: string): number {
  const nowMs = Date.now();
  const state = adaptiveState.get(sessionKey);

  if (!state) {
    // First call for this session — initialize.
    adaptiveState.set(sessionKey, {
      lastCallMs: nowMs,
      rollingAvgIntervalMs: ADAPTIVE_FAST_THRESHOLD_MS * 2,
      currentStride: ADAPTIVE_MIN_STRIDE,
    });
    return ADAPTIVE_MIN_STRIDE;
  }

  const intervalMs = nowMs - state.lastCallMs;
  // Exponential moving average with alpha=0.3 for smoothing.
  const alpha = 0.3;
  const newAvg = alpha * intervalMs + (1 - alpha) * state.rollingAvgIntervalMs;

  let newStride = state.currentStride;
  if (newAvg < ADAPTIVE_FAST_THRESHOLD_MS) {
    // Calls are fast: increase stride (checkpoint less often).
    newStride = Math.min(state.currentStride + 1, ADAPTIVE_MAX_STRIDE);
  } else {
    // Calls are slow: decrease stride toward minimum.
    newStride = Math.max(state.currentStride - 1, ADAPTIVE_MIN_STRIDE);
  }

  adaptiveState.set(sessionKey, {
    lastCallMs: nowMs,
    rollingAvgIntervalMs: newAvg,
    currentStride: newStride,
  });

  return newStride;
}

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
  adaptiveState.delete(sessionKey);
}

/**
 * Returns the current stride count for a session (number of mutating tool calls recorded).
 * Returns 0 for unknown / newly-created sessions.
 */
export function getStrideCount(sessionKey: string): number {
  return strideCounts.get(sessionKey) ?? 0;
}

/**
 * Returns the current adaptive stride value for a session without advancing the counter.
 * Returns 1 if no adaptive state exists for the session.
 */
export function getAdaptiveStride(sessionKey: string): number {
  return adaptiveState.get(sessionKey)?.currentStride ?? ADAPTIVE_MIN_STRIDE;
}
