/*
Test for src/platform/vid_scale.ts's "scale to fullscreen" toggle additions
(Mike, 2026-09-01): VID_CalcCenteredRect, VID_CalcBlitRect, VID_CalcOutputSize.

Self-sufficient per PORTING.md rule 13: every function under test is pure
(no cvars, no globals, no SDL), so this file needs no setup/teardown at all.
*/

import { describe, test, expect } from "bun:test";
import {
  VID_CalcCenteredRect,
  VID_CalcBlitRect,
  VID_CalcOutputSize,
  VID_CalcScaledRect,
  VID_CalcRenderSize,
  VID_ClampScale,
  VID_SCALE_MIN,
  VID_SCALE_MAX,
  VID_SCALE_DEFAULT,
} from "../src/platform/vid_scale";

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

// Bug fix (Mike, 2026-09-02, owner's play-test report -- his exact video
// mode/display pairing: gl_mode 9 (1280x960, 4:3) fullscreen on a 1920x1080
// (16:9) desktop): the owner's screenshot showed this rendered UNSCALED in
// the top-left corner with the rest of the screen black -- "fit screen" not
// applied at all. VID_CalcBlitRect/VID_CalcScaledRect/VID_CalcCenteredRect
// were already correct pure math (confirmed here); the bug was entirely in
// the SDL/glimp wiring around them (see src/platform/sdl.ts's
// desktopDisplaySize and src/ref_gl/gl_rmain.ts's R_BeginFrame restart
// condition) -- these pin the geometry those call sites feed into, at the
// owner's own numbers, so a future regression in the wiring still has a
// correct target to compare against.
describe("VID_CalcBlitRect -- the owner's own numbers (1280x960 mode, 1920x1080 fullscreen desktop)", () => {
  test("fit ON: 1440x1080 centered at x=240 (matches this unit's own verification run)", () => {
    const rect = VID_CalcBlitRect(1280, 960, 1920, 1080, true);
    expect(rect).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });

  test("fit OFF (\"1:1 pixels\"): unscaled 1280x960, centered at x=320,y=60", () => {
    const rect = VID_CalcBlitRect(1280, 960, 1920, 1080, false);
    expect(rect).toEqual({ x: 320, y: 60, w: 1280, h: 960 });
  });
});

describe("VID_ClampScale -- range extended to 2.0x (supersampling), owner's play-test report", () => {
  // "you max out the scale at 1.0x ... how exactly are we supposed to be
  // able to scale the screen up if it fucking ends at 1.0x?" -- MAX used to
  // equal DEFAULT (1.0); this pins the extended range and the fact DEFAULT
  // ("native") did not move.
  test("MIN/MAX/DEFAULT", () => {
    expect(VID_SCALE_MIN).toBe(0.1);
    expect(VID_SCALE_MAX).toBe(2.0);
    expect(VID_SCALE_DEFAULT).toBe(1.0);
  });

  test("values above the old 1.0 ceiling are no longer clamped down to it", () => {
    expect(VID_ClampScale(1.5)).toBe(1.5);
    expect(VID_ClampScale(2.0)).toBe(2.0);
  });

  test("values above the new 2.0 ceiling still clamp", () => {
    expect(VID_ClampScale(2.5)).toBe(2.0);
    expect(VID_ClampScale(100)).toBe(2.0);
  });

  test("below-MIN and non-finite inputs are unaffected by the range change", () => {
    expect(VID_ClampScale(0.01)).toBe(0.1);
    expect(VID_ClampScale(NaN)).toBe(1.0);
    expect(VID_ClampScale(-1)).toBe(0.1);
  });
});

describe("VID_CalcRenderSize -- supersampling at 2x allocates a render target LARGER than the display", () => {
  test("the owner's own mode at 2x: 1280x960 -> 2560x1920 render target", () => {
    expect(VID_CalcRenderSize(1280, 960, 2.0)).toEqual({ width: 2560, height: 1920 });
  });

  test("1x (native) is unchanged: render size equals display size", () => {
    expect(VID_CalcRenderSize(1280, 960, 1.0)).toEqual({ width: 1280, height: 960 });
  });

  test("0.5x still downsamples as before -- the range extension didn't touch the <1.0 path", () => {
    expect(VID_CalcRenderSize(1280, 960, 0.5)).toEqual({ width: 640, height: 480 });
  });

  test("1.5x (a step the slider's own 0.1 granularity now reaches)", () => {
    expect(VID_CalcRenderSize(1280, 960, 1.5)).toEqual({ width: 1920, height: 1440 });
  });

  test("a 2x render target blitted back down via VID_CalcBlitRect still fits/centers correctly (fit ON, owner's numbers)", () => {
    const render = VID_CalcRenderSize(1280, 960, 2.0);
    const rect = VID_CalcBlitRect(render.width, render.height, 1920, 1080, true);
    // same 4:3-into-16:9 aspect ratio as the 1x case, just downsampled from
    // a larger source -- the destination rect is identical either way.
    expect(rect).toEqual({ x: 240, y: 0, w: 1440, h: 1080 });
  });
});
