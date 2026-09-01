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
  s_scale_fit_box,
  s_screensize_slider,
  s_brightness_slider,
  s_fs_box,
  CUSTOM_MODE_INDEX,
  SOFTWARE_MENU,
  OPENGL_MENU,
  ScaleFormatter,
  ScreenSizeFormatter,
  BrightnessFormatter,
  TextureQualityFormatter,
  ShadowQualityFormatter,
  ShadowUnavailableFormatter,
  SHADOW_UNAVAILABLE,
  ShadowQualityIndexFor,
  SHADOW_QUALITY_RES,
  s_shadows_box,
  s_shadow_quality_slider,
  s_defaults_action,
  s_apply_action,
  modeLabel,
} from "../src/platform/vid_menu";
import { QMF_GRAYED } from "../src/client/qmenu";

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
  Cvar_Get("vid_scale_fit", "1", 0);
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

  test("rows past the scale slider fall back to a flat, gap-free 10-unit rhythm (no more of the old 70->90/100->120 double gaps), now including the new scale-to-fullscreen row", () => {
    VID_MenuInit();

    const scaleY = s_scale_slider[OPENGL_MENU]?.generic.y ?? -1;
    const scaleFitY = s_scale_fit_box[OPENGL_MENU]?.generic.y ?? -1;
    const screensizeY = s_screensize_slider[OPENGL_MENU]?.generic.y ?? -1;
    const brightnessY = s_brightness_slider[OPENGL_MENU]?.generic.y ?? -1;
    const fsBoxY = s_fs_box[OPENGL_MENU]?.generic.y ?? -1;

    // QoL addition (Mike, 2026-09-01): s_scale_fit_box's row was inserted
    // right after the scale slider, shifting every row from "screen size"
    // onward down by 10 -- see vid_menu.ts's VID_MenuInit doc comment.
    expect(scaleFitY - scaleY).toBe(10);
    expect(screensizeY - scaleFitY).toBe(10);
    expect(brightnessY - screensizeY).toBe(10);
    expect(fsBoxY - brightnessY).toBe(10);
  });
});

// QoL addition (Mike, 2026-09-01): slider live value readouts -- see
// src/client/qmenu.ts's MenusliderS.valueFormatter and this file's own
// ScaleFormatter/ScreenSizeFormatter/BrightnessFormatter/
// TextureQualityFormatter, each mirroring its slider's own callback/
// ApplyChanges cvar-write math exactly.
describe("vid_menu.ts formatter value tables", () => {
  test.each([
    [1, "0.10x"], // VID_SCALE_MIN * 10
    [5, "0.50x"],
    [10, "1.00x (native)"], // VID_SCALE_MAX * 10 -- the owner's own reference point
  ])("ScaleFormatter(%p) -> %p", (curvalue, expected) => {
    expect(ScaleFormatter(curvalue)).toBe(expected);
  });

  test.each([
    [3, "30%"], // minvalue
    [10, "100%"],
    [12, "120%"], // maxvalue
  ])("ScreenSizeFormatter(%p) -> %p", (curvalue, expected) => {
    expect(ScreenSizeFormatter(curvalue)).toBe(expected);
  });

  test.each([
    [5, "1.30"], // minvalue -- dimmest
    [9, "0.90"],
    [13, "0.50"], // maxvalue -- brightest
  ])("BrightnessFormatter(%p) -> %p", (curvalue, expected) => {
    expect(BrightnessFormatter(curvalue)).toBe(expected);
  });

  test.each([
    [0, "lowest (picmip 3)"], // minvalue
    [1, "low (picmip 2)"],
    [2, "medium (picmip 1)"],
    [3, "high (picmip 0)"], // maxvalue
  ])("TextureQualityFormatter(%p) -> %p", (curvalue, expected) => {
    expect(TextureQualityFormatter(curvalue)).toBe(expected);
  });
});

describe("s_scale_fit_box -- \"scale to fullscreen\" toggle (defect: postage-stamp fullscreen)", () => {
  test("defaults to curvalue 1 (\"fit screen\") on a fresh VID_MenuInit", () => {
    VID_MenuInit();

    expect(s_scale_fit_box[SOFTWARE_MENU]?.curvalue).toBe(1);
    expect(s_scale_fit_box[OPENGL_MENU]?.curvalue).toBe(1);
    expect(s_scale_fit_box[OPENGL_MENU]?.itemnames).toEqual(["1:1 pixels", "fit screen"]);
  });

  test("tracks vid_scale_fit=0 (\"1:1 pixels\") when the cvar is off", () => {
    Cvar_SetValue("vid_scale_fit", 0);

    VID_MenuInit();

    expect(s_scale_fit_box[SOFTWARE_MENU]?.curvalue).toBe(0);
    expect(s_scale_fit_box[OPENGL_MENU]?.curvalue).toBe(0);
  });
});

describe("modeLabel -- colloquial + aspect-ratio mode labels (defect: no reference point on the mode list)", () => {
  test.each([
    [1280, 720, "1280x720 (720p, 16:9)"],
    [1920, 1080, "1920x1080 (1080p, 16:9)"],
    [2560, 1440, "2560x1440 (1440p, 16:9)"],
    [3840, 2160, "3840x2160 (2160p, 16:9)"],
    [1920, 1200, "1920x1200 (16:10)"],
    [1366, 768, "1366x768 (16:9)"], // tolerance case: 1366/768 != 16/9 exactly
    [2560, 1080, "2560x1080 (21:9)"], // marketing-convention special case
    [3440, 1440, "3440x1440 (21:9)"], // marketing-convention special case
    [640, 480, "640x480 (4:3)"],
  ])("modeLabel(%p, %p) -> %p", (w, h, expected) => {
    expect(modeLabel(w, h)).toBe(expected);
  });
});


// v1.1.0 shadow mapping rows (ref_gl/gl_shadowmap.ts). OpenGL-submenu only,
// greyed with a statusbar note when gl_shaders is 0.
describe("vid_menu.ts -- shadow mapping rows", () => {
  test("the two rows continue the flat 10-unit rhythm below the 8-bit-textures row", () => {
    Cvar_SetValue("gl_shaders", 1);
    VID_MenuInit();
    expect(s_shadow_quality_slider.generic.y - s_shadows_box.generic.y).toBe(10);
  });

  test("the toggle tracks gl_shadowmaps", () => {
    Cvar_Get("gl_shadowmaps", "1", 0);
    Cvar_SetValue("gl_shadowmaps", 0);
    VID_MenuInit();
    expect(s_shadows_box.curvalue).toBe(0);

    Cvar_SetValue("gl_shadowmaps", 1);
    VID_MenuInit();
    expect(s_shadows_box.curvalue).toBe(1);
  });

  test("the quality slider tracks gl_shadowmap_res, snapping a console-set value to the nearest step", () => {
    Cvar_Get("gl_shadowmap_res", "512", 0);
    for (const [res, expected] of [
      [256, 0],
      [512, 1],
      [1024, 2],
      [300, 0], // nearest step, not a snap back to 0-by-accident
      [4096, 2],
    ] as const) {
      Cvar_SetValue("gl_shadowmap_res", res);
      VID_MenuInit();
      expect(s_shadow_quality_slider.curvalue).toBe(expected);
    }
  });

  test("the slider spans exactly the three quality steps", () => {
    VID_MenuInit();
    expect(s_shadow_quality_slider.minvalue).toBe(0);
    expect(s_shadow_quality_slider.maxvalue).toBe(SHADOW_QUALITY_RES.length - 1);
  });

  test("the slider reads out a name AND its texel size -- never a bare number", () => {
    expect(ShadowQualityFormatter(0)).toBe("low (256px)");
    expect(ShadowQualityFormatter(1)).toBe("medium (512px)");
    expect(ShadowQualityFormatter(2)).toBe("high (1024px)");
    // the readout is wired to the slider, not just exported
    VID_MenuInit();
    expect(s_shadow_quality_slider.valueFormatter).toBe(ShadowQualityFormatter);
  });

  test("ShadowQualityIndexFor never returns an out-of-range step", () => {
    for (const res of [-100, 0, 1, 255, 256, 400, 512, 900, 1024, 99999]) {
      const idx = ShadowQualityIndexFor(res);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(SHADOW_QUALITY_RES.length);
    }
  });

  test("the OpenGL submenu's reset/apply rows moved below the shadow rows instead of overlapping them", () => {
    Cvar_SetValue("gl_shaders", 1);
    VID_MenuInit();

    const qualityY = s_shadow_quality_slider.generic.y;
    const defaultsY = s_defaults_action[OPENGL_MENU]?.generic.y ?? -1;
    const applyY = s_apply_action[OPENGL_MENU]?.generic.y ?? -1;

    expect(defaultsY).toBeGreaterThan(qualityY);
    expect(defaultsY - qualityY).toBe(10);
    expect(applyY - defaultsY).toBe(10);

    // no row in the OpenGL submenu shares a y with another
    const ys = [s_shadows_box.generic.y, qualityY, defaultsY, applyY];
    expect(new Set(ys).size).toBe(ys.length);
  });

  test("the software submenu's reset/apply rows are untouched -- it has no shadow rows to displace them", () => {
    VID_MenuInit();
    expect(s_defaults_action[SOFTWARE_MENU]?.generic.y).toBe(134);
    expect(s_apply_action[SOFTWARE_MENU]?.generic.y).toBe(144);
  });

  test("with gl_shaders 0 both rows SAY they are unavailable in their own value readout, not just in a flag the drawing code ignores", () => {
    Cvar_Get("gl_shaders", "1", 0);
    Cvar_SetValue("gl_shaders", 0);
    VID_MenuInit();

    // QMF_GRAYED is an MTYPE_ACTION-only visual here, so the value is the
    // only thing the player actually sees change on a spin control/slider.
    expect(s_shadows_box.itemnames).toEqual([SHADOW_UNAVAILABLE, SHADOW_UNAVAILABLE]);
    expect(s_shadow_quality_slider.valueFormatter).toBe(ShadowUnavailableFormatter);
    expect(ShadowUnavailableFormatter()).toBe(SHADOW_UNAVAILABLE);

    Cvar_SetValue("gl_shaders", 1);
    VID_MenuInit();
    expect(s_shadows_box.itemnames).toEqual(["no", "yes"]);
    expect(s_shadow_quality_slider.valueFormatter).toBe(ShadowQualityFormatter);
  });

  test("both rows are greyed with a statusbar note when gl_shaders is 0, and live again when it is 1", () => {
    Cvar_Get("gl_shaders", "1", 0);
    Cvar_SetValue("gl_shaders", 0);
    VID_MenuInit();
    for (const row of [s_shadows_box.generic, s_shadow_quality_slider.generic]) {
      expect(row.flags & QMF_GRAYED).toBe(QMF_GRAYED);
      expect(row.statusbar).toBe("requires gl_shaders 1");
    }

    Cvar_SetValue("gl_shaders", 1);
    VID_MenuInit();
    for (const row of [s_shadows_box.generic, s_shadow_quality_slider.generic]) {
      expect(row.flags & QMF_GRAYED).toBe(0);
      expect(row.statusbar).toBeNull();
    }
  });
});
