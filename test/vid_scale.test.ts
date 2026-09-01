/*
Test for src/platform/vid_scale.ts's "scale to fullscreen" toggle additions
(Mike, 2026-09-01): VID_CalcCenteredRect, VID_CalcBlitRect, VID_CalcOutputSize.

Self-sufficient per PORTING.md rule 13: every function under test is pure
(no cvars, no globals, no SDL), so this file needs no setup/teardown at all.
*/

import { describe, test, expect } from "bun:test";
import { VID_CalcCenteredRect, VID_CalcBlitRect, VID_CalcOutputSize, VID_CalcScaledRect } from "../src/platform/vid_scale";

describe("VID_CalcCenteredRect -- 1:1 crisp-pixel centering, no stretch", () => {
  test("equal size: centers at (0,0), unscaled", () => {
    expect(VID_CalcCenteredRect(1280, 720, 1280, 720)).toEqual({ x: 0, y: 0, w: 1280, h: 720 });
  });

  test("render smaller than display: centered with letterbox/pillarbox margins, render's own size preserved", () => {
    // the owner's own brief case: 720p render inside a 4K fullscreen display
    expect(VID_CalcCenteredRect(1280, 720, 3840, 2160)).toEqual({ x: 1280, y: 720, w: 1280, h: 720 });
  });

  test("render larger than display: centered with negative offsets (symmetrically cropped), render's own size preserved", () => {
    expect(VID_CalcCenteredRect(3840, 2160, 1280, 720)).toEqual({ x: -1280, y: -720, w: 3840, h: 2160 });
  });

  test("degenerate render size (zero/negative/non-finite) falls back to an unscaled full-display rect", () => {
    expect(VID_CalcCenteredRect(0, 720, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(VID_CalcCenteredRect(1280, -1, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(VID_CalcCenteredRect(NaN, 720, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("degenerate display size (zero/negative/non-finite) collapses width/height to 0", () => {
    expect(VID_CalcCenteredRect(1280, 720, 0, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 1080 });
    expect(VID_CalcCenteredRect(1280, 720, -1, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 1080 });
    expect(VID_CalcCenteredRect(1280, 720, NaN, 1080)).toEqual({ x: 0, y: 0, w: 0, h: 1080 });
  });
});

describe("VID_CalcBlitRect -- fit true delegates to VID_CalcScaledRect, fit false to VID_CalcCenteredRect", () => {
  test("the owner's own fullscreen brief case, fit ON: 1280x720 render into a 3840x2160 (16:9) display fills it completely", () => {
    const rect = VID_CalcBlitRect(1280, 720, 3840, 2160, true);
    expect(rect).toEqual({ x: 0, y: 0, w: 3840, h: 2160 });
    expect(rect).toEqual(VID_CalcScaledRect(1280, 720, 3840, 2160));
  });

  test("the owner's own fullscreen brief case, fit OFF: same render/display centers at the render's own 1280x720 size", () => {
    const rect = VID_CalcBlitRect(1280, 720, 3840, 2160, false);
    expect(rect).toEqual({ x: 1280, y: 720, w: 1280, h: 720 });
    expect(rect).toEqual(VID_CalcCenteredRect(1280, 720, 3840, 2160));
  });

  test("mismatched aspect ratio, fit ON, still letterboxes (stretch-to-fill semantics unchanged)", () => {
    // 4:3 render into a 16:9 display: fit ON pillarboxes
    const rect = VID_CalcBlitRect(640, 480, 1920, 1080, true);
    expect(rect).toEqual(VID_CalcScaledRect(640, 480, 1920, 1080));
    expect(rect.w).toBeLessThan(1920);
  });
});

describe("VID_CalcOutputSize -- fullscreen output surface is always the native display size", () => {
  test("windowed: returns the mode's own size regardless of native display size", () => {
    expect(VID_CalcOutputSize(1280, 720, 3840, 2160, false)).toEqual({ width: 1280, height: 720 });
    expect(VID_CalcOutputSize(1920, 1080, 640, 480, false)).toEqual({ width: 1920, height: 1080 }); // even when "native" is smaller than the mode
  });

  test("fullscreen: returns the native display size, not the mode size -- the owner's own brief case (1280x720 mode on a 4K screen)", () => {
    expect(VID_CalcOutputSize(1280, 720, 3840, 2160, true)).toEqual({ width: 3840, height: 2160 });
  });

  test("fullscreen with a degenerate/unknown native display size falls back to the mode size", () => {
    expect(VID_CalcOutputSize(1280, 720, 0, 0, true)).toEqual({ width: 1280, height: 720 });
    expect(VID_CalcOutputSize(1280, 720, NaN, NaN, true)).toEqual({ width: 1280, height: 720 });
    expect(VID_CalcOutputSize(1280, 720, -1, 2160, true)).toEqual({ width: 1280, height: 720 });
  });

  test("fullscreen rounds a non-integer native display size", () => {
    expect(VID_CalcOutputSize(1280, 720, 3839.6, 2160.4, true)).toEqual({ width: 3840, height: 2160 });
  });
});
