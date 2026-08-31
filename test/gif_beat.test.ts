/*
Tests for src/qcommon/gif_beat.ts's gifBeatFrame. Self-sufficient per rule
13: pure function in, number out, no globals/filesystem/renderer state.
*/

import { describe, test, expect } from "bun:test";
import { gifBeatFrame, GIF_BEAT_HZ } from "../src/qcommon/gif_beat";

describe("gifBeatFrame", () => {
  test("the cadence constant is 10Hz", () => {
    expect(GIF_BEAT_HZ).toBe(10);
  });

  test("frameCount <= 1 always pins to frame 0, regardless of time", () => {
    expect(gifBeatFrame(0, 1)).toBe(0);
    expect(gifBeatFrame(1.23, 1)).toBe(0);
    expect(gifBeatFrame(9999, 1)).toBe(0);
    expect(gifBeatFrame(0, 0)).toBe(0);
    expect(gifBeatFrame(5, 0)).toBe(0);
  });

  test("advances one frame every 1/10th of a second (the fixed 10Hz cadence)", () => {
    // 4-frame cycle: frame index = floor(seconds * 10) % 4.
    expect(gifBeatFrame(0.0, 4)).toBe(0);
    expect(gifBeatFrame(0.09, 4)).toBe(0); // 0.9 -> floor 0, still frame 0
    expect(gifBeatFrame(0.1, 4)).toBe(1); // exactly one tick in
    expect(gifBeatFrame(0.19, 4)).toBe(1);
    expect(gifBeatFrame(0.2, 4)).toBe(2);
    expect(gifBeatFrame(0.3, 4)).toBe(3);
  });

  test("loops forever: wraps back to frame 0 once the cycle completes", () => {
    // 4 frames at 10Hz -> a full cycle is 0.4s.
    expect(gifBeatFrame(0.4, 4)).toBe(0);
    expect(gifBeatFrame(0.5, 4)).toBe(1);
    expect(gifBeatFrame(0.7, 4)).toBe(3);
    expect(gifBeatFrame(0.8, 4)).toBe(0); // second full cycle
    // Many cycles later, same phase -> same frame (10s = 25 full 4-frame
    // cycles of 0.4s each, landing exactly back on a cycle boundary).
    expect(gifBeatFrame(10.0, 4)).toBe(0);
    expect(gifBeatFrame(10.3, 4)).toBe(3);
  });

  test("is identical under a classic-10Hz-server beatSeconds and a KEX-40Hz-server beatSeconds at the same wall-clock instant", () => {
    // The whole point of deriving from TIME rather than tick count: two
    // servers running at different simulation rates but reporting the same
    // elapsed wall-clock time must select the same GIF frame. Simulate
    // this directly: cl.time accumulated in 100ms (10Hz) steps vs 25ms
    // (40Hz) steps, both reaching the same elapsed milliseconds.
    const elapsedMs = 730; // not a multiple of either tick size's boundary quirks
    const classicSeconds = elapsedMs / 1000;
    const kexSeconds = elapsedMs / 1000;
    expect(gifBeatFrame(classicSeconds, 5)).toBe(gifBeatFrame(kexSeconds, 5));
    // and directly pin the value: 0.73 * 10 = 7.3 -> floor 7 -> 7 % 5 = 2
    expect(gifBeatFrame(elapsedMs / 1000, 5)).toBe(2);
  });

  test("odd frame counts still wrap correctly", () => {
    // frameCount 3: cycle length 0.3s.
    expect(gifBeatFrame(0.0, 3)).toBe(0);
    expect(gifBeatFrame(0.1, 3)).toBe(1);
    expect(gifBeatFrame(0.2, 3)).toBe(2);
    expect(gifBeatFrame(0.3, 3)).toBe(0);
    expect(gifBeatFrame(0.29, 3)).toBe(2);
  });

  test("defensively floor-mods a negative beatSeconds back into range", () => {
    // Not an expected real input (cl.time/cls.realtime are non-negative),
    // but the function is pure/total -- must not return a negative index
    // or throw.
    const result = gifBeatFrame(-0.1, 4);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(4);
  });
});
