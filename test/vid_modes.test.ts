// Force headless SDL before ANY import can reach the FFI layer -- mirrors
// test/glimp.test.ts/test/sdl_platform.test.ts's own banner comment on why
// this must run first. Nothing in this file actually arms the SDL backend
// (no SDL_SetBackendEnabled(true) call anywhere below), but vid.ts's import
// chain pulls in src/platform/sdl.ts transitively, so this stays defensive
// insurance against ever opening a real window on the host.
process.env.SDL_VIDEODRIVER = "dummy";
process.env.SDL_AUDIODRIVER = "dummy";
Bun.env.SDL_VIDEODRIVER = "dummy";
Bun.env.SDL_AUDIODRIVER = "dummy";

/*
Tests for the v1.0.0 RC "more video modes / custom resolution / resolution
scaling" unit: src/platform/vid.ts's extended mode table and custom-mode
(-1) support, plus src/platform/vid_scale.ts's pure scaling math (also used
directly by src/platform/sdl.ts and src/platform/glimp.ts at runtime -- see
those files' header comments).

Per this project's rule 13: self-sufficient, no reliance on any other test
file having run first. r_customwidth/r_customheight/vid_scale are read
through the real global cvar registry (src/qcommon/cvar.ts's module-level
`cvar_vars` map, shared process-wide across every test file in a bun test
run), so every test that depends on a specific value sets it explicitly via
Cvar_Set/Cvar_SetValue immediately before asserting, rather than assuming
Cvar_Get's default ever won the registration race -- Cvar_Get only applies
its default the first time a cvar is created; verify with
`bun test test/vid_modes.test.ts` alone if in doubt.

HEADLESS LIMITS: this file verifies the mode table, the custom-mode cvar
plumbing, and the scaling math in isolation. It does not and cannot verify
that a real display actually shows a scaled/letterboxed image -- SDL's
"dummy" video driver has no real window surface to inspect pixels on (see
glimp.ts/sdl.ts's own header comments on why GL contexts and real windows
are untestable here). See this unit's report for the two manual checks
(720p rendered fullscreen on a 1080p display, once per renderer) this
implies for Mike's RC checklist.
*/

import { describe, test, expect } from "bun:test";
import { Cvar_Set, Cvar_SetValue } from "../src/qcommon/cvar";
import { VID_GetModeInfo, VID_GetScale, VID_ClampCustomWidth, VID_ClampCustomHeight, VID_ClampScale, VID_CalcRenderSize, VID_CalcScaledRect } from "../src/platform/vid";
import { CUSTOM_WIDTH_MIN, CUSTOM_WIDTH_MAX, CUSTOM_HEIGHT_MIN, CUSTOM_HEIGHT_MAX, CUSTOM_WIDTH_DEFAULT, CUSTOM_HEIGHT_DEFAULT, VID_SCALE_MIN, VID_SCALE_MAX } from "../src/platform/vid_scale";

describe("src/platform/vid.ts -- mode table integrity", () => {
  test("every table mode (0-19) resolves to a positive, finite width/height", () => {
    for (let mode = 0; mode <= 19; mode++) {
      const info = VID_GetModeInfo(mode);
      expect(info).not.toBeNull();
      expect(Number.isFinite(info?.width)).toBe(true);
      expect(Number.isFinite(info?.height)).toBe(true);
      expect(info?.width).toBeGreaterThan(0);
      expect(info?.height).toBeGreaterThan(0);
    }
  });

  test("the vanilla-era table (modes 0-10) keeps its original resolutions -- never renumbered", () => {
    expect(VID_GetModeInfo(0)).toEqual({ width: 320, height: 240 });
    expect(VID_GetModeInfo(3)).toEqual({ width: 640, height: 480 });
    expect(VID_GetModeInfo(9)).toEqual({ width: 1600, height: 1200 });
    expect(VID_GetModeInfo(10)).toEqual({ width: 1920, height: 1080 });
  });

  test("the v1.0.0 RC modern-display set (modes 11-19) matches the brief's list, appended past mode 10", () => {
    expect(VID_GetModeInfo(11)).toEqual({ width: 1280, height: 720 });
    expect(VID_GetModeInfo(12)).toEqual({ width: 1366, height: 768 });
    expect(VID_GetModeInfo(13)).toEqual({ width: 1440, height: 900 });
    expect(VID_GetModeInfo(14)).toEqual({ width: 1600, height: 900 });
    expect(VID_GetModeInfo(15)).toEqual({ width: 1920, height: 1200 });
    expect(VID_GetModeInfo(16)).toEqual({ width: 2560, height: 1080 });
    expect(VID_GetModeInfo(17)).toEqual({ width: 2560, height: 1440 });
    expect(VID_GetModeInfo(18)).toEqual({ width: 3440, height: 1440 });
    expect(VID_GetModeInfo(19)).toEqual({ width: 3840, height: 2160 });
  });

  test("indices past the table (and other negatives) are invalid, distinct from -1's custom-mode meaning", () => {
    expect(VID_GetModeInfo(20)).toBeNull();
    expect(VID_GetModeInfo(999)).toBeNull();
    expect(VID_GetModeInfo(-2)).toBeNull();
  });
});

describe("src/platform/vid.ts -- custom mode (-1) via r_customwidth/r_customheight", () => {
  test("mode -1 reflects the current r_customwidth/r_customheight values", () => {
    Cvar_Set("r_customwidth", "1280");
    Cvar_Set("r_customheight", "800");
    expect(VID_GetModeInfo(-1)).toEqual({ width: 1280, height: 800 });
  });

  test("a value above the sane ceiling clamps down (q2repro's own VID_GetFullscreen bound: w/h <= 8192)", () => {
    Cvar_SetValue("r_customwidth", 99999);
    Cvar_SetValue("r_customheight", 50000);
    expect(VID_GetModeInfo(-1)).toEqual({ width: CUSTOM_WIDTH_MAX, height: CUSTOM_HEIGHT_MAX });
  });

  test("a value below the sane floor clamps up (q2repro's own VID_GetFullscreen bound: w >= 320, h >= 240)", () => {
    Cvar_SetValue("r_customwidth", 1);
    Cvar_SetValue("r_customheight", 0);
    expect(VID_GetModeInfo(-1)).toEqual({ width: CUSTOM_WIDTH_MIN, height: CUSTOM_HEIGHT_MIN });
  });

  test("a non-numeric cvar value (atof-style parse failure, string cvars default to 0) clamps to the sane floor rather than corrupting the mode lookup", () => {
    Cvar_Set("r_customwidth", "not-a-number");
    Cvar_Set("r_customheight", "also-not-a-number");
    const info = VID_GetModeInfo(-1);
    expect(info).not.toBeNull();
    expect(Number.isFinite(info?.width)).toBe(true);
    expect(Number.isFinite(info?.height)).toBe(true);
    expect(info?.width).toBeGreaterThanOrEqual(CUSTOM_WIDTH_MIN);
    expect(info?.height).toBeGreaterThanOrEqual(CUSTOM_HEIGHT_MIN);
  });

  test("exact boundary values pass through unclamped", () => {
    Cvar_SetValue("r_customwidth", CUSTOM_WIDTH_MIN);
    Cvar_SetValue("r_customheight", CUSTOM_HEIGHT_MAX);
    expect(VID_GetModeInfo(-1)).toEqual({ width: CUSTOM_WIDTH_MIN, height: CUSTOM_HEIGHT_MAX });
  });
});

describe("src/platform/vid_scale.ts -- VID_ClampCustomWidth/VID_ClampCustomHeight (pure)", () => {
  test("clamps below the floor, above the ceiling, and passes through in range", () => {
    expect(VID_ClampCustomWidth(CUSTOM_WIDTH_MIN - 1)).toBe(CUSTOM_WIDTH_MIN);
    expect(VID_ClampCustomWidth(CUSTOM_WIDTH_MAX + 1)).toBe(CUSTOM_WIDTH_MAX);
    expect(VID_ClampCustomWidth(1920)).toBe(1920);
    expect(VID_ClampCustomHeight(CUSTOM_HEIGHT_MIN - 1)).toBe(CUSTOM_HEIGHT_MIN);
    expect(VID_ClampCustomHeight(CUSTOM_HEIGHT_MAX + 1)).toBe(CUSTOM_HEIGHT_MAX);
  });

  test("non-finite input (NaN/Infinity) falls back to the default rather than propagating", () => {
    expect(VID_ClampCustomWidth(NaN)).toBe(CUSTOM_WIDTH_DEFAULT);
    expect(VID_ClampCustomWidth(Infinity)).toBe(CUSTOM_WIDTH_DEFAULT);
    expect(VID_ClampCustomHeight(-Infinity)).toBe(CUSTOM_HEIGHT_DEFAULT);
  });

  test("fractional input rounds to the nearest integer resolution", () => {
    expect(VID_ClampCustomWidth(1920.6)).toBe(1921);
    expect(VID_ClampCustomHeight(1079.4)).toBe(1079);
  });
});

describe("src/platform/vid.ts -- VID_GetScale/VID_ClampScale (vid_scale cvar, bad-value clamping)", () => {
  test("VID_GetScale reflects the live vid_scale cvar, clamped", () => {
    Cvar_SetValue("vid_scale", 0.5);
    expect(VID_GetScale()).toBeCloseTo(0.5, 6);
  });

  test("a value above 1.0 clamps to VID_SCALE_MAX -- no supersampling", () => {
    Cvar_SetValue("vid_scale", 4);
    expect(VID_GetScale()).toBe(VID_SCALE_MAX);
  });

  test("a zero, negative, or non-numeric value clamps to VID_SCALE_MIN or the default, never 0", () => {
    Cvar_SetValue("vid_scale", 0);
    expect(VID_GetScale()).toBe(VID_SCALE_MIN);
    Cvar_SetValue("vid_scale", -1);
    expect(VID_GetScale()).toBe(VID_SCALE_MIN);
    Cvar_Set("vid_scale", "garbage");
    expect(VID_GetScale()).toBeGreaterThanOrEqual(VID_SCALE_MIN);
  });

  test("VID_ClampScale (pure) treats every non-finite input (NaN or either Infinity) as the default 1.0", () => {
    expect(VID_ClampScale(NaN)).toBe(1.0);
    expect(VID_ClampScale(Infinity)).toBe(1.0);
    expect(VID_ClampScale(-Infinity)).toBe(1.0);
  });
});

describe("src/platform/vid_scale.ts -- VID_CalcRenderSize (display size * scale -> render size)", () => {
  test("scale 1.0 passes the display size through unchanged (the default, pre-existing-behavior case)", () => {
    expect(VID_CalcRenderSize(1920, 1080, 1.0)).toEqual({ width: 1920, height: 1080 });
  });

  test("scale 0.5 halves both axes, rounded", () => {
    expect(VID_CalcRenderSize(1920, 1080, 0.5)).toEqual({ width: 960, height: 540 });
  });

  test("an odd display size rounds rather than truncating or throwing", () => {
    expect(VID_CalcRenderSize(1281, 721, 0.5)).toEqual({ width: 641, height: 361 });
  });

  test("degenerate display dimensions (zero/negative/non-finite) fall back to a 1x1 minimum instead of dividing by zero", () => {
    expect(VID_CalcRenderSize(0, 1080, 0.5)).toEqual({ width: 1, height: 540 });
    expect(VID_CalcRenderSize(1920, -5, 0.5)).toEqual({ width: 960, height: 1 });
    expect(VID_CalcRenderSize(NaN, NaN, 0.5)).toEqual({ width: 1, height: 1 });
  });

  test("an out-of-range scale is clamped before being applied", () => {
    expect(VID_CalcRenderSize(1000, 1000, 5)).toEqual({ width: 1000, height: 1000 }); // clamped to 1.0
    expect(VID_CalcRenderSize(1000, 1000, 0)).toEqual({ width: 100, height: 100 }); // clamped to VID_SCALE_MIN (0.1)
  });
});

describe("src/platform/vid_scale.ts -- VID_CalcScaledRect (source rect -> aspect-preserving letterboxed dest rect)", () => {
  test("matching aspect ratio fills the destination exactly -- no bars", () => {
    expect(VID_CalcScaledRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(VID_CalcScaledRect(1920, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("a narrower-than-display source pillarboxes (bars on the sides, y stays 0)", () => {
    // 4:3 render (1024x768) inside a 16:9 display (1920x1080): height-bound,
    // scale = 1080/768 = 1.40625, w = 1024*1.40625 = 1440, centered.
    const rect = VID_CalcScaledRect(1024, 768, 1920, 1080);
    expect(rect.y).toBe(0);
    expect(rect.h).toBe(1080);
    expect(rect.w).toBe(1440);
    expect(rect.x).toBe((1920 - 1440) / 2);
  });

  test("a taller-than-display source letterboxes (bars on top/bottom, x stays 0)", () => {
    // 16:9 render (1920x1080) inside a 4:3 display (1600x1200): width-bound,
    // scale = 1600/1920 = 0.8333, h = 1080*0.8333 = 900, centered.
    const rect = VID_CalcScaledRect(1920, 1080, 1600, 1200);
    expect(rect.x).toBe(0);
    expect(rect.w).toBe(1600);
    expect(rect.h).toBe(900);
    expect(rect.y).toBe((1200 - 900) / 2);
  });

  test("the concrete RC-checklist case: 1280x720 rendered, presented on a 1920x1080 display, fills exactly", () => {
    expect(VID_CalcScaledRect(1280, 720, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("degenerate/zero-sized inputs fall back to the full destination rect instead of throwing or dividing by zero", () => {
    expect(() => VID_CalcScaledRect(0, 0, 1920, 1080)).not.toThrow();
    expect(VID_CalcScaledRect(0, 0, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(VID_CalcScaledRect(1280, 720, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(VID_CalcScaledRect(NaN, 720, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });
});
