import { afterEach, describe, expect, it } from "vitest";
import {
  getStrideCount,
  resetStrideCounter,
  shouldCheckpointAtStride,
} from "./checkpoint-stride.js";

// Use unique session keys per test to avoid cross-test interference.
let testSessionCounter = 0;
function nextSession(): string {
  testSessionCounter += 1;
  return `test-session-${testSessionCounter}`;
}

afterEach(() => {
  // Ensure counters don't bleed across tests even if a session key is reused.
  for (let i = 1; i <= testSessionCounter; i++) {
    resetStrideCounter(`test-session-${i}`);
  }
});

describe("getStrideCount", () => {
  it("returns 0 for a new session", () => {
    const key = nextSession();
    expect(getStrideCount(key)).toBe(0);
  });
});

describe("shouldCheckpointAtStride", () => {
  it("returns true on every call when stride=1", () => {
    const key = nextSession();
    for (let i = 1; i <= 5; i++) {
      expect(shouldCheckpointAtStride(key, 1)).toBe(true);
    }
  });

  it("returns true on every Nth call when stride=N", () => {
    const key = nextSession();
    const stride = 3;
    // Calls 1 and 2 should return false; call 3 returns true.
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=1
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=2
    expect(shouldCheckpointAtStride(key, stride)).toBe(true); // count=3
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=4
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=5
    expect(shouldCheckpointAtStride(key, stride)).toBe(true); // count=6
  });

  it("returns true on every other call when stride=2", () => {
    const key = nextSession();
    expect(shouldCheckpointAtStride(key, 2)).toBe(false); // count=1
    expect(shouldCheckpointAtStride(key, 2)).toBe(true); // count=2
    expect(shouldCheckpointAtStride(key, 2)).toBe(false); // count=3
    expect(shouldCheckpointAtStride(key, 2)).toBe(true); // count=4
  });

  it("treats stride < 1 as stride=1 (checkpoint every call)", () => {
    const key = nextSession();
    expect(shouldCheckpointAtStride(key, 0)).toBe(true);
    expect(shouldCheckpointAtStride(key, -5)).toBe(true);
  });

  it("treats non-integer stride as stride=1", () => {
    const key = nextSession();
    expect(shouldCheckpointAtStride(key, 1.5)).toBe(true);
  });

  it("increments the stride count on each call", () => {
    const key = nextSession();
    expect(getStrideCount(key)).toBe(0);
    shouldCheckpointAtStride(key, 5);
    expect(getStrideCount(key)).toBe(1);
    shouldCheckpointAtStride(key, 5);
    expect(getStrideCount(key)).toBe(2);
  });
});

describe("resetStrideCounter", () => {
  it("resets the counter to 0", () => {
    const key = nextSession();
    shouldCheckpointAtStride(key, 3);
    shouldCheckpointAtStride(key, 3);
    expect(getStrideCount(key)).toBe(2);
    resetStrideCounter(key);
    expect(getStrideCount(key)).toBe(0);
  });

  it("resetting causes the next call to start from 1 again", () => {
    const key = nextSession();
    const stride = 3;
    shouldCheckpointAtStride(key, stride); // count=1
    shouldCheckpointAtStride(key, stride); // count=2
    resetStrideCounter(key);
    // After reset, count restarts from 0 => first call is count=1 (not 3rd)
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=1 again
    expect(shouldCheckpointAtStride(key, stride)).toBe(false); // count=2
    expect(shouldCheckpointAtStride(key, stride)).toBe(true); // count=3
  });
});

describe("independent session counters", () => {
  it("different sessions have independent counters", () => {
    const keyA = nextSession();
    const keyB = nextSession();

    shouldCheckpointAtStride(keyA, 3); // A: count=1
    shouldCheckpointAtStride(keyA, 3); // A: count=2
    shouldCheckpointAtStride(keyA, 3); // A: count=3

    // Session B has not been touched yet
    expect(getStrideCount(keyB)).toBe(0);

    shouldCheckpointAtStride(keyB, 3); // B: count=1
    expect(getStrideCount(keyA)).toBe(3);
    expect(getStrideCount(keyB)).toBe(1);
  });

  it("resetting one session does not affect another", () => {
    const keyA = nextSession();
    const keyB = nextSession();
    shouldCheckpointAtStride(keyA, 2);
    shouldCheckpointAtStride(keyB, 2);
    resetStrideCounter(keyA);
    expect(getStrideCount(keyA)).toBe(0);
    expect(getStrideCount(keyB)).toBe(1);
  });
});
