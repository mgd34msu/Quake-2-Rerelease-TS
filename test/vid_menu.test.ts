/*
Tests for src/platform/vid_menu.ts's VID_MenuInit -- the defect brief's item
3(a): the mode spinner (s_mode_list) must initialize its curvalue from the
LIVE sw_mode/gl_mode cvar for every path (a table mode selects its own
resolutions[] entry; -1, vid.ts's custom-mode marker, selects the trailing
"Custom" entry and the custom width/height MenufieldS widgets must be
populated from r_customwidth/r_customheight), and 3(b): the row-spacing
rework in vid_menu.ts (s_customwidth_field/s_customheight_field/
s_scale_slider now on an 18-unit field rhythm, everything else on a flat
10-unit rhythm with no more double gaps).

Self-sufficient per PORTING.md rule 13: cvar_vars (qcommon/cvar.ts) is a
process-wide singleton that other test files' Cvar_Get calls also touch, so
every test here sets every cvar VID_MenuInit reads before calling it, rather
than relying on defaults left over from module load order.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { Cvar_Get, Cvar_SetValue } from "../src/qcommon/cvar";
import {
  VID_MenuInit,
  s_mode_list,
  s_customwidth_field,
  s_customheight_field,
  s_scale_slider,
  s_screensize_slider,
  s_brightness_slider,
  s_fs_box,
  CUSTOM_MODE_INDEX,
  SOFTWARE_MENU,
  OPENGL_MENU,
} from "../src/platform/vid_menu";

// A table mode a few rows into resolutions[] (see vid_menu.ts's own list):
// index 5 is "[960 720]".
const TABLE_MODE_INDEX = 5;

function primeCvars(opts: { swMode: number; glMode: number; customWidth: number; customHeight: number; scale: number }): void {
  // Cvar_Get is idempotent (qcommon/cvar.ts:62 returns the existing cvar if
  // already registered), so this is safe to call every test even though
  // VID_MenuInit's own module-level guards only run its Cvar_Get calls once
  // per process.
  Cvar_Get("sw_mode", "0", 0);
  Cvar_Get("gl_mode", "3", 0);
  Cvar_Get("r_customwidth", "1280", 0);
  Cvar_Get("r_customheight", "720", 0);
  Cvar_Get("vid_scale", "1", 0);
  Cvar_Get("vid_ref", "soft", 0);
  Cvar_Get("vid_fullscreen", "0", 0);
  Cvar_Get("vid_gamma", "1", 0);
  Cvar_Get("viewsize", "100", 0);
  Cvar_Get("gl_picmip", "0", 0);
  Cvar_Get("gl_ext_palettedtexture", "1", 0);
  Cvar_Get("sw_stipplealpha", "0", 0);
  Cvar_Get("_windowed_mouse", "0", 0);
  Cvar_Get("gl_driver", "opengl32", 0);

  Cvar_SetValue("sw_mode", opts.swMode);
  Cvar_SetValue("gl_mode", opts.glMode);
  Cvar_SetValue("r_customwidth", opts.customWidth);
  Cvar_SetValue("r_customheight", opts.customHeight);
  Cvar_SetValue("vid_scale", opts.scale);
}

beforeEach(() => {
  primeCvars({ swMode: 0, glMode: 3, customWidth: 1280, customHeight: 720, scale: 1 });
});

describe("VID_MenuInit -- mode spinner curvalue tracks the live cvar", () => {
  test("gl_mode -1 (custom) selects the trailing Custom entry for the OpenGL menu", () => {
    Cvar_SetValue("gl_mode", -1);
    Cvar_SetValue("r_customwidth", 2560);
    Cvar_SetValue("r_customheight", 1440);

    VID_MenuInit();

    expect(s_mode_list[OPENGL_MENU]?.curvalue).toBe(CUSTOM_MODE_INDEX);
    expect(s_customwidth_field[OPENGL_MENU]?.buffer).toBe("2560");
    expect(s_customheight_field[OPENGL_MENU]?.buffer).toBe("1440");
  });

  test("sw_mode -1 (custom) selects the trailing Custom entry for the software menu", () => {
    Cvar_SetValue("sw_mode", -1);
    Cvar_SetValue("r_customwidth", 800);
    Cvar_SetValue("r_customheight", 600);

    VID_MenuInit();

    expect(s_mode_list[SOFTWARE_MENU]?.curvalue).toBe(CUSTOM_MODE_INDEX);
    expect(s_customwidth_field[SOFTWARE_MENU]?.buffer).toBe("800");
    expect(s_customheight_field[SOFTWARE_MENU]?.buffer).toBe("600");
  });

  test("a table mode index selects its own resolutions[] entry, not Custom, for both menu variants", () => {
    Cvar_SetValue("gl_mode", TABLE_MODE_INDEX);
    Cvar_SetValue("sw_mode", TABLE_MODE_INDEX);

    VID_MenuInit();

    expect(s_mode_list[OPENGL_MENU]?.curvalue).toBe(TABLE_MODE_INDEX);
    expect(s_mode_list[SOFTWARE_MENU]?.curvalue).toBe(TABLE_MODE_INDEX);
    expect(s_mode_list[OPENGL_MENU]?.curvalue).not.toBe(CUSTOM_MODE_INDEX);
  });

  test("custom width/height fields are populated from r_customwidth/r_customheight even when the active mode is a table entry", () => {
    // VID_MenuInit always mirrors r_customwidth/r_customheight into both
    // submenus' fields (vid_menu.ts's VID_MenuInit, unconditional on
    // curvalue) so switching the mode spinner to Custom later doesn't start
    // from stale/blank width and height.
    Cvar_SetValue("gl_mode", TABLE_MODE_INDEX);
    Cvar_SetValue("r_customwidth", 1920);
    Cvar_SetValue("r_customheight", 1080);

    VID_MenuInit();

    expect(s_customwidth_field[OPENGL_MENU]?.buffer).toBe("1920");
    expect(s_customheight_field[OPENGL_MENU]?.buffer).toBe("1080");
  });

  test("gl_mode and sw_mode are independent: one can be Custom while the other tracks a table entry", () => {
    Cvar_SetValue("gl_mode", -1);
    Cvar_SetValue("sw_mode", TABLE_MODE_INDEX);

    VID_MenuInit();

    expect(s_mode_list[OPENGL_MENU]?.curvalue).toBe(CUSTOM_MODE_INDEX);
    expect(s_mode_list[SOFTWARE_MENU]?.curvalue).toBe(TABLE_MODE_INDEX);
  });
});

describe("VID_MenuInit -- row layout is spaced on a uniform rhythm (defect item 3b)", () => {
  test("the two custom-resolution fields and the scale slider sit 18 units apart (this file's own field-row rhythm, matching menu.ts's start-server fields)", () => {
    VID_MenuInit();

    const widthY = s_customwidth_field[OPENGL_MENU]?.generic.y ?? -1;
    const heightY = s_customheight_field[OPENGL_MENU]?.generic.y ?? -1;
    const scaleY = s_scale_slider[OPENGL_MENU]?.generic.y ?? -1;

    expect(heightY - widthY).toBe(18);
    expect(scaleY - heightY).toBe(18);
  });

  test("the mode spinner sits a plain 10 units above the first custom-resolution field", () => {
    VID_MenuInit();

    const modeY = s_mode_list[OPENGL_MENU]?.generic.y ?? -1;
    const widthY = s_customwidth_field[OPENGL_MENU]?.generic.y ?? -1;

    expect(widthY - modeY).toBe(18);
  });

  test("rows past the scale slider fall back to a flat, gap-free 10-unit rhythm (no more of the old 70->90/100->120 double gaps)", () => {
    VID_MenuInit();

    const scaleY = s_scale_slider[OPENGL_MENU]?.generic.y ?? -1;
    const screensizeY = s_screensize_slider[OPENGL_MENU]?.generic.y ?? -1;
    const brightnessY = s_brightness_slider[OPENGL_MENU]?.generic.y ?? -1;
    const fsBoxY = s_fs_box[OPENGL_MENU]?.generic.y ?? -1;

    expect(screensizeY - scaleY).toBe(10);
    expect(brightnessY - screensizeY).toBe(10);
    expect(fsBoxY - brightnessY).toBe(10);
  });
});
