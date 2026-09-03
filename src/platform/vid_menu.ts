/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from linux/vid_menu.c (GNU GPL v2 or later) -- the video options
menu (driver/mode/screensize/brightness/fullscreen widgets, apply/defaults).
The per-platform variants (linux/win32/irix) are near-identical; the linux
one is ported per PORTING.md's platform-track rule.

Deviations:
- resolutions[] gains the v1.0.0 RC modern-display set (see vid.ts's mode
  table -- modes 11-19) past the C-era 4:3/1080p table, plus a "Custom"
  entry past the last real mode: selecting it writes sw_mode/gl_mode = -1
  (vid.ts's custom-mode index) instead of a table index, backed by two new
  MTYPE_FIELD widgets (s_customwidth_field/s_customheight_field) bound to
  r_customwidth/r_customheight. No C-original or q2repro equivalent for any
  of this (see vid.ts's header comment on VID_GetModeInfo) -- new widgets,
  not a fidelity deviation from an existing one.
- a "resolution scale" slider (s_scale_slider), bound to vid_scale, is new
  for the same reason -- see vid.ts's VID_GetScale header comment.
- "software X11" and "default OpenGL" driver choices remain listed for
  fidelity, but VID_LoadRefresh (vid.ts) statically links the one software
  refresh, so applying them falls back to soft with a console message.
- M_PopMenu/M_ForceMenuOff live in client/menu.ts, which imports this
  module for M_Menu_Video_f; the value cycle is broken here (the less
  fundamental side) with the sanctioned lazy require() idiom.
- VID_MenuKey gains Field_Key/isField routing (mirroring client/menu.ts's
  own Default_MenuKey) so the two new custom-resolution fields are editable
  -- the real linux/vid_menu.c's VID_MenuKey never needed this (it has no
  MTYPE_FIELD widgets at all), so this is new behavior for new widgets, not
  a changed behavior for an existing one.
*/

import {
  QMF_GRAYED,
  MenuframeworkS,
  MenufieldS,
  MenulistS,
  MenusliderS,
  MenuactionS,
  MTYPE_SPINCONTROL,
  MTYPE_SLIDER,
  MTYPE_ACTION,
  MTYPE_FIELD,
  QMF_NUMBERSONLY,
} from "../client/qmenu";
import {
  Field_Key,
  isField,
  Menu_AddItem,
  Menu_AdjustCursor,
  Menu_Center,
  Menu_KeepBelow,
  Menu_Draw,
  Menu_ItemAtCursor,
  Menu_SelectItem,
  Menu_SlideItem,
} from "../client/qmenu_impl";
import { K_ESCAPE, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, K_ENTER } from "../client/keys";
import { Cvar_Get, Cvar_Set, Cvar_SetValue, Cvar_VariableValue } from "../qcommon/cvar";
import { CVAR_ARCHIVE, CVAR_FILES, type CvarT } from "../shared/q_shared";
import { viddef } from "../client/vid";
import { re } from "../client/client";
import { VID_ClampCustomHeight, VID_ClampCustomWidth, VID_ClampScale, VID_SCALE_DEFAULT, VID_SCALE_MAX, VID_SCALE_MIN } from "./vid_scale";

const REF_SOFT = 0;
const REF_SOFTX11 = 1;
const REF_OPENGL = 2;

let vid_ref: CvarT | null = null;
let vid_fullscreen: CvarT | null = null;
let vid_gamma: CvarT | null = null;
let scr_viewsize: CvarT | null = null;

let gl_mode: CvarT | null = null;
let gl_driver: CvarT | null = null;
let gl_picmip: CvarT | null = null;
// v1.1.0 shadow mapping. ref_gl's R_Register owns the canonical
// registration; these holders exist so the video menu still works in a
// session where the GL renderer never started (same reason gl_mode/sw_mode
// are lazily registered here).
let gl_shadowmaps: CvarT | null = null;
let gl_shadowmap_res: CvarT | null = null;
let gl_shaders: CvarT | null = null;
let gl_ext_palettedtexture: CvarT | null = null;

let sw_mode: CvarT | null = null;
let sw_stipplealpha: CvarT | null = null;

let _windowed_mouse: CvarT | null = null;

// client/menu.ts imports this module; resolve its M_PopMenu/M_ForceMenuOff
// lazily to break the value cycle (see file header).
function menuMod(): { M_PopMenu: () => void; M_ForceMenuOff: () => void } {
  return require("../client/menu");
}

/*
====================================================================

MENU INTERACTION

====================================================================
*/
// Exported (was module-private): test/vid_menu.test.ts drives VID_MenuInit
// with various cvar states and inspects these widgets' curvalue/buffer
// fields directly, the same way test/cl_menu.test.ts pokes qmenu widgets.
export const SOFTWARE_MENU = 0;
export const OPENGL_MENU = 1;

const s_software_menu = new MenuframeworkS();
const s_opengl_menu = new MenuframeworkS();
let s_current_menu: MenuframeworkS = s_software_menu;
let s_current_menu_index = 0;

export const s_mode_list: MenulistS[] = [new MenulistS(), new MenulistS()];
const s_ref_list: MenulistS[] = [new MenulistS(), new MenulistS()];
const s_tq_slider = new MenusliderS();
export const s_screensize_slider: MenusliderS[] = [new MenusliderS(), new MenusliderS()];
export const s_brightness_slider: MenusliderS[] = [new MenusliderS(), new MenusliderS()];
export const s_fs_box: MenulistS[] = [new MenulistS(), new MenulistS()];
// "hud scale": scr_scale (0 = auto, q2repro's get_auto_scale tier -- 2x for
// any height from 720 up, 4x from 2160 -- else a fixed 1x..4x). Mike's
// 2026-09-02 play-test at 1280x960: "hud is MASSIVE" / "why so scaled up?"
// -- the auto tier doubles the classic HUD, crosshair and kfont text there,
// and the only way to pick a size was the console. Row index = scr_scale.
export const s_hudscale_box: MenulistS[] = [new MenulistS(), new MenulistS()];
const hudscale_names = ["auto", "1x", "2x", "3x", "4x"];
const s_stipple_box = new MenulistS();
const s_paletted_texture_box = new MenulistS();
const s_windowed_mouse = new MenulistS();
// v1.0.0 RC: custom resolution (mode -1) + render-resolution scale -- see
// this file's header comment and vid.ts's VID_GetModeInfo/VID_GetScale.
export const s_customwidth_field: MenufieldS[] = [new MenufieldS(), new MenufieldS()];
export const s_customheight_field: MenufieldS[] = [new MenufieldS(), new MenufieldS()];
export const s_scale_slider: MenusliderS[] = [new MenusliderS(), new MenusliderS()];
// QoL addition (Mike, 2026-09-01): "scale to fullscreen" toggle, cvar
// vid_scale_fit (see vid.ts's VID_GetScaleFit) -- default on, so a low-res
// vid_scale pick fills the screen instead of sitting as a small crisp
// rectangle in the corner. Exported for the same reason s_scale_slider and
// friends already are: test/vid_menu.test.ts drives this module's widgets
// directly.
export const s_scale_fit_box: MenulistS[] = [new MenulistS(), new MenulistS()];
// v1.1.0 shadow mapping (ref_gl/gl_shadowmap.ts): an on/off toggle plus a
// per-light resolution cap. OpenGL-submenu only, exactly like s_tq_slider
// and s_paletted_texture_box -- the software renderer has no shader path to
// hang a depth map off, so the rows simply do not exist there rather than
// appearing greyed for a renderer that can never satisfy them. Within the
// OpenGL submenu they ARE greyed (with a statusbar note) when gl_shaders is
// 0, since that is a state the player can get back out of. Exported for
// test/vid_menu.test.ts, same precedent as the widgets above.
export const s_shadows_box = new MenulistS();
export const s_shadow_quality_slider = new MenusliderS();
export const s_apply_action: MenuactionS[] = [new MenuactionS(), new MenuactionS()];
export const s_defaults_action: MenuactionS[] = [new MenuactionS(), new MenuactionS()];

function DriverCallback(): void {
  const other = s_current_menu_index === 0 ? 1 : 0;
  s_ref_list[other].curvalue = s_ref_list[s_current_menu_index].curvalue;

  if (s_ref_list[s_current_menu_index].curvalue < 2) {
    s_current_menu = s_software_menu;
    s_current_menu_index = 0;
  } else {
    s_current_menu = s_opengl_menu;
    s_current_menu_index = 1;
  }
}

function ScreenSizeCallback(s: unknown): void {
  if (!(s instanceof MenusliderS)) return;
  Cvar_SetValue("viewsize", s.curvalue * 10);
}

function BrightnessCallback(s: unknown): void {
  if (!(s instanceof MenusliderS)) return;

  if (s_current_menu_index === 0) s_brightness_slider[1].curvalue = s_brightness_slider[0].curvalue;
  else s_brightness_slider[0].curvalue = s_brightness_slider[1].curvalue;

  const refName = vid_ref ? vid_ref.string.toLowerCase() : "";
  if (refName === "soft" || refName === "softx") {
    const gamma = 0.8 - (s.curvalue / 10.0 - 0.5) + 0.5;
    Cvar_SetValue("vid_gamma", gamma);
  }
}

// QoL addition (Mike, 2026-09-01): colloquial + aspect-ratio mode labels.
// Owner's brief, followed precisely:
// - the WxH numbers stay the primary text, always;
// - a ####p colloquial name is appended ONLY for the four standards in
//   P_NAME_BY_DIMENSIONS below -- no invented names ("4K", "HD", "QHD", ...);
// - aspect ratio is the reduced W:H fraction (GCD), except: near-16:9
//   (tolerance ~0.01, catches 1366x768's imprecise-but-colloquial 16:9) and
//   exact 8:5 (=1.6, e.g. 1440x900/1920x1200) canonicalize to "16:9"/"16:10";
//   2560x1080 and 3440x1440 are special-cased to "21:9" -- their true reduced
//   ratios (64:27, 43:18) don't literally equal 21:9, but that's the
//   marketing convention these two ultrawide resolutions are sold under.
function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function aspectLabel(width: number, height: number): string {
  if ((width === 2560 && height === 1080) || (width === 3440 && height === 1440)) return "21:9"; // marketing convention, see comment above
  if (Math.abs(width / height - 16 / 9) <= 0.01) return "16:9";
  if (width * 5 === height * 8) return "16:10"; // exact 8:5
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

const P_NAME_BY_DIMENSIONS: Record<string, string> = {
  "1280x720": "720p",
  "1920x1080": "1080p",
  "2560x1440": "1440p",
  "3840x2160": "2160p",
};

export function modeLabel(width: number, height: number): string {
  const key = `${width}x${height}`;
  const pname = P_NAME_BY_DIMENSIONS[key];
  const aspect = aspectLabel(width, height);
  return `${key} (${pname ? `${pname}, ${aspect}` : aspect})`;
}

// Hoisted out of VID_MenuInit (module scope, not a local) so ApplyChanges
// can reference CUSTOM_MODE_INDEX without recomputing/duplicating the list.
// Mirrors vid.ts's vid_modes table index-for-index for modes 0-19, plus one
// trailing "Custom" entry that maps to mode -1 instead of a table index --
// see this file's header comment. The W/H pairs and their order are
// unchanged from the pre-QoL-patch bracket-padded list above (only the
// display STRING changed, per modeLabel's own header comment) -- sw_mode/
// gl_mode are written as raw indices into this array, so length and index
// order must stay byte-for-byte identical.
const RESOLUTION_DIMENSIONS: readonly (readonly [number, number])[] = [
  [320, 240],
  [400, 300],
  [512, 384],
  [640, 480],
  [800, 600],
  [960, 720],
  [1024, 768],
  [1152, 864],
  [1280, 720],
  [1280, 960],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1600, 1200],
  [1920, 1080],
  [1920, 1200],
  [2048, 1536],
  [2560, 1080],
  [2560, 1440],
  [3440, 1440],
  [3840, 2160],
];
const resolutions = [...RESOLUTION_DIMENSIONS.map(([w, h]) => modeLabel(w, h)), "[Custom   ]"];
export const CUSTOM_MODE_INDEX = resolutions.length - 1;

// QoL addition (Mike, 2026-09-01): slider live value readouts -- see
// MenusliderS.valueFormatter in qmenu.ts. Display-only; the real cvar
// writes stay in ApplyChanges/ScreenSizeCallback/BrightnessCallback below.
// Each transform mirrors its slider's own callback/ApplyChanges math
// exactly -- a formatter that drifts from the real write is worse than no
// formatter at all (it shows the player a false number). Exported (new
// functions, no original-C-name collision) so test/vid_menu.test.ts can
// drive them directly, same precedent as this file's own widget-array
// exports.
export function ScaleFormatter(curvalue: number): string {
  const scale = curvalue / 10;
  // Bug fix (Mike, 2026-09-02): this used to compare against VID_SCALE_MAX,
  // which was a correct proxy for "native" only because MAX and DEFAULT
  // both happened to be 1.0 -- now that MAX is 2.0 (supersampling, see
  // vid_scale.ts's header comment), "native" has to key off DEFAULT
  // (always 1.0) directly, not off whatever the top of the slider's range
  // happens to be.
  const native = scale === VID_SCALE_DEFAULT ? " (native)" : "";
  return `${scale.toFixed(2)}x${native}`;
}

export function ScreenSizeFormatter(curvalue: number): string {
  return `${curvalue * 10}%`;
}

export function BrightnessFormatter(curvalue: number): string {
  // mirrors BrightnessCallback/ApplyChanges: 0.8 - (curvalue/10 - 0.5) + 0.5
  // reduces to 1.8 - curvalue/10.
  return (1.8 - curvalue / 10).toFixed(2);
}

// gl_shadowmap.ts's per-light resolution cap, as the three steps the menu
// offers. Index is the slider's curvalue; the value is texels per edge.
export const SHADOW_QUALITY_RES = [256, 512, 1024];
const SHADOW_QUALITY_LABELS = ["low", "medium", "high"];

// Same "never a bare number" rule as the other formatters in this block: the
// player sees the quality name AND the texel size it actually buys.
export function ShadowQualityFormatter(curvalue: number): string {
  const idx = Math.max(0, Math.min(SHADOW_QUALITY_RES.length - 1, Math.round(curvalue)));
  return `${SHADOW_QUALITY_LABELS[idx]} (${SHADOW_QUALITY_RES[idx]}px)`;
}

// Maps a live gl_shadowmap_res value onto the nearest slider step, so a
// value set from the console (or an older config) still shows up on a real
// step instead of snapping the slider to 0.
export function ShadowQualityIndexFor(resolution: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < SHADOW_QUALITY_RES.length; i++) {
    const step = SHADOW_QUALITY_RES[i];
    if (step === undefined) continue;
    const delta = Math.abs(step - resolution);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

// Shown in place of the quality readout when gl_shaders is 0. QMF_GRAYED is
// an MTYPE_ACTION-only visual in this codebase (see menu.ts's own note at
// s_content_skill_list) -- on a spin control or slider it is an honest
// marker the drawing code ignores -- so the row has to say so in the one
// place the player is actually looking: its value.
export const SHADOW_UNAVAILABLE = "unavailable";
export function ShadowUnavailableFormatter(): string {
  return SHADOW_UNAVAILABLE;
}

const TQ_LABELS = ["lowest", "low", "medium", "high"];
export function TextureQualityFormatter(curvalue: number): string {
  const idx = Math.max(0, Math.min(TQ_LABELS.length - 1, Math.round(curvalue)));
  return `${TQ_LABELS[idx]} (picmip ${3 - idx})`;
}

function ResetDefaults(): void {
  VID_MenuInit();
}

function ApplyChanges(): void {
  /*
  ** make values consistent
  */
  const other = s_current_menu_index === 0 ? 1 : 0;
  s_fs_box[other].curvalue = s_fs_box[s_current_menu_index].curvalue;
  s_hudscale_box[other].curvalue = s_hudscale_box[s_current_menu_index].curvalue;
  s_brightness_slider[other].curvalue = s_brightness_slider[s_current_menu_index].curvalue;
  s_ref_list[other].curvalue = s_ref_list[s_current_menu_index].curvalue;
  // r_customwidth/r_customheight/vid_scale are single global cvars, unlike
  // sw_mode/gl_mode -- mirror the active submenu's widgets into the other
  // one's, same as fs_box/brightness/ref_list above, so whichever submenu
  // is active when Apply is pressed writes the same values either way.
  s_customwidth_field[other].buffer = s_customwidth_field[s_current_menu_index].buffer;
  s_customheight_field[other].buffer = s_customheight_field[s_current_menu_index].buffer;
  s_scale_slider[other].curvalue = s_scale_slider[s_current_menu_index].curvalue;
  s_scale_fit_box[other].curvalue = s_scale_fit_box[s_current_menu_index].curvalue;

  /*
  ** invert sense so greater = brighter, and scale to a range of 0.5 to 1.3
  */
  const gamma = 0.8 - (s_brightness_slider[s_current_menu_index].curvalue / 10.0 - 0.5) + 0.5;

  Cvar_SetValue("vid_gamma", gamma);
  Cvar_SetValue("sw_stipplealpha", s_stipple_box.curvalue);
  Cvar_SetValue("gl_picmip", 3 - s_tq_slider.curvalue);
  Cvar_SetValue("vid_fullscreen", s_fs_box[s_current_menu_index].curvalue);
  Cvar_SetValue("scr_scale", s_hudscale_box[s_current_menu_index].curvalue);
  Cvar_SetValue("gl_ext_palettedtexture", s_paletted_texture_box.curvalue);
  // CUSTOM_MODE_INDEX (the list's trailing "Custom" entry) writes -1
  // (vid.ts's custom-mode index), never the raw list index -- see this
  // file's header comment.
  const swSel = s_mode_list[SOFTWARE_MENU].curvalue;
  Cvar_SetValue("sw_mode", swSel === CUSTOM_MODE_INDEX ? -1 : swSel);
  const glSel = s_mode_list[OPENGL_MENU].curvalue;
  Cvar_SetValue("gl_mode", glSel === CUSTOM_MODE_INDEX ? -1 : glSel);
  Cvar_SetValue("r_customwidth", VID_ClampCustomWidth(parseInt(s_customwidth_field[s_current_menu_index].buffer, 10)));
  Cvar_SetValue("r_customheight", VID_ClampCustomHeight(parseInt(s_customheight_field[s_current_menu_index].buffer, 10)));
  Cvar_SetValue("vid_scale", VID_ClampScale(s_scale_slider[s_current_menu_index].curvalue / 10));
  Cvar_SetValue("vid_scale_fit", s_scale_fit_box[s_current_menu_index].curvalue);
  Cvar_SetValue("_windowed_mouse", s_windowed_mouse.curvalue);
  Cvar_SetValue("gl_shadowmaps", s_shadows_box.curvalue);
  Cvar_SetValue("gl_shadowmap_res", SHADOW_QUALITY_RES[Math.max(0, Math.min(SHADOW_QUALITY_RES.length - 1, Math.round(s_shadow_quality_slider.curvalue)))] ?? 512);

  switch (s_ref_list[s_current_menu_index].curvalue) {
    case REF_SOFT:
      Cvar_Set("vid_ref", "soft");
      break;
    case REF_SOFTX11:
      Cvar_Set("vid_ref", "softx");
      break;
    case REF_OPENGL:
      Cvar_Set("vid_ref", "gl");
      Cvar_Set("gl_driver", "opengl32");
      break;
    default:
      break;
  }

  menuMod().M_ForceMenuOff();
}

/*
** VID_MenuInit
*/
export function VID_MenuInit(): void {
  const refs = ["[software      ]", "[software X11  ]", "[default OpenGL]"];
  const yesno_names = ["no", "yes"];

  if (!gl_driver) gl_driver = Cvar_Get("gl_driver", "opengl32", 0);
  // q2repro src/refresh/texture.c:1261: `gl_picmip = Cvar_Get("gl_picmip", "0", CVAR_FILES);`
  if (!gl_picmip) gl_picmip = Cvar_Get("gl_picmip", "0", CVAR_FILES);
  // Bug fix (Mike, 2026-09-01, Part G cvar-persistence audit): these were
  // registered with flags=0 here. gl_rmain.ts/r_main.ts each register the
  // SAME name with CVAR_ARCHIVE, but only when that renderer actually
  // initializes (R_Init) -- which never happens for gl_mode in an
  // all-software session, or for sw_mode in a session that boots straight
  // into gl (vid_ref=gl in config.cfg). Cvar_Get's flags OR-merge means this
  // registration can only ever ADD the archive bit, never remove it, so
  // this is a pure gap-closer: if this call is first (the renderer that
  // would have added CVAR_ARCHIVE never ran this session), the video menu's
  // own Cvar_SetValue writes to gl_mode/sw_mode (ApplyChanges below) now
  // survive to config.cfg on quit instead of being silently dropped.
  if (!gl_mode) gl_mode = Cvar_Get("gl_mode", "3", CVAR_ARCHIVE);
  if (!sw_mode) sw_mode = Cvar_Get("sw_mode", "0", CVAR_ARCHIVE);
  if (!gl_ext_palettedtexture) gl_ext_palettedtexture = Cvar_Get("gl_ext_palettedtexture", "1", CVAR_ARCHIVE);

  if (!sw_stipplealpha) sw_stipplealpha = Cvar_Get("sw_stipplealpha", "0", CVAR_ARCHIVE);

  if (!_windowed_mouse) _windowed_mouse = Cvar_Get("_windowed_mouse", "0", CVAR_ARCHIVE);

  if (!vid_ref) vid_ref = Cvar_Get("vid_ref", "soft", CVAR_ARCHIVE);
  if (!vid_fullscreen) vid_fullscreen = Cvar_Get("vid_fullscreen", "0", CVAR_ARCHIVE);
  if (!vid_gamma) vid_gamma = Cvar_Get("vid_gamma", "1", CVAR_ARCHIVE);
  if (!scr_viewsize) scr_viewsize = Cvar_Get("viewsize", "100", CVAR_ARCHIVE);

  // narrowed locals: tsc cannot see through the module-level lazy-Cvar_Get
  // guards above
  const swModeC = sw_mode, glModeC = gl_mode, viewsizeC = scr_viewsize;
  const vidRefC = vid_ref, vidFullscreenC = vid_fullscreen, vidGammaC = vid_gamma;
  const glPicmipC = gl_picmip, glPalC = gl_ext_palettedtexture;
  const stippleC = sw_stipplealpha, winMouseC = _windowed_mouse;
  if (!swModeC || !glModeC || !viewsizeC || !vidRefC || !vidFullscreenC || !vidGammaC || !glPicmipC || !glPalC || !stippleC || !winMouseC) return;

  // v1.0.0 RC: custom resolution + render-resolution scale (see this file's
  // header comment). -1 (vid.ts's custom-mode index) selects CUSTOM_MODE_INDEX
  // in the list instead of a table index.
  const customWidth = VID_ClampCustomWidth(Cvar_VariableValue("r_customwidth"));
  const customHeight = VID_ClampCustomHeight(Cvar_VariableValue("r_customheight"));
  const scale = VID_ClampScale(Cvar_VariableValue("vid_scale"));

  s_mode_list[SOFTWARE_MENU].curvalue = swModeC.value === -1 ? CUSTOM_MODE_INDEX : swModeC.value | 0;
  s_mode_list[OPENGL_MENU].curvalue = glModeC.value === -1 ? CUSTOM_MODE_INDEX : glModeC.value | 0;

  for (const field of [...s_customwidth_field, ...s_customheight_field]) {
    field.length = 4;
    field.visible_length = 4;
  }
  s_customwidth_field[SOFTWARE_MENU].buffer = String(customWidth);
  s_customwidth_field[OPENGL_MENU].buffer = String(customWidth);
  s_customheight_field[SOFTWARE_MENU].buffer = String(customHeight);
  s_customheight_field[OPENGL_MENU].buffer = String(customHeight);

  s_scale_slider[SOFTWARE_MENU].curvalue = Math.round(scale * 10);
  s_scale_slider[OPENGL_MENU].curvalue = Math.round(scale * 10);

  s_screensize_slider[SOFTWARE_MENU].curvalue = viewsizeC.value / 10;
  s_screensize_slider[OPENGL_MENU].curvalue = viewsizeC.value / 10;

  if (vidRefC.string === "soft") {
    s_current_menu_index = SOFTWARE_MENU;
    s_ref_list[0].curvalue = s_ref_list[1].curvalue = REF_SOFT;
  } else if (vidRefC.string === "softx") {
    s_current_menu_index = SOFTWARE_MENU;
    s_ref_list[0].curvalue = s_ref_list[1].curvalue = REF_SOFTX11;
  } else if (vidRefC.string === "gl") {
    s_current_menu_index = OPENGL_MENU;
    s_ref_list[s_current_menu_index].curvalue = REF_OPENGL;
  }

  s_software_menu.x = (viddef.width * 0.5) | 0;
  s_software_menu.nitems = 0;
  s_opengl_menu.x = (viddef.width * 0.5) | 0;
  s_opengl_menu.nitems = 0;

  for (let i = 0; i < 2; i++) {
    s_ref_list[i].generic.type = MTYPE_SPINCONTROL;
    s_ref_list[i].generic.name = "driver";
    s_ref_list[i].generic.x = 0;
    s_ref_list[i].generic.y = 0;
    s_ref_list[i].generic.callback = DriverCallback;
    s_ref_list[i].itemnames = refs;

    s_mode_list[i].generic.type = MTYPE_SPINCONTROL;
    s_mode_list[i].generic.name = "video mode";
    s_mode_list[i].generic.x = 0;
    s_mode_list[i].generic.y = 10;
    s_mode_list[i].itemnames = resolutions;

    // Row spacing: menu.ts's own field rows (e.g. M_Menu_StartServer_f's
    // s_timelimit_field/s_fraglimit_field/s_maxclients_field/s_hostname_field,
    // menu.ts:2163/2173/2183/2193) space consecutive MTYPE_FIELD rows 18
    // units apart, not the plain 10-unit rhythm used between two
    // MTYPE_SLIDER/MTYPE_SPINCONTROL rows -- a field draws a bordered input
    // box (Field_Draw, qmenu_impl.ts, corners at generic.y +/-4) on top of
    // its label line, so it needs more clearance than a single text row.
    // These two fields (and the slider right after them) were previously
    // packed at the plain 10-unit spacing (20/30/40), cramming them against
    // each other; switching to the established 18-unit field rhythm here
    // and resuming a flat, gap-free 10-unit rhythm for every row after (no
    // more of the old 70->90 and 100->120 double-gaps) is what "make the
    // whole menu's vertical rhythm uniform" means below -- purely this
    // port's own layout call, not C or q2repro fidelity (see file header).
    s_customwidth_field[i].generic.type = MTYPE_FIELD;
    s_customwidth_field[i].generic.name = "custom width";
    s_customwidth_field[i].generic.x = 0;
    s_customwidth_field[i].generic.y = 28;
    s_customwidth_field[i].generic.flags = QMF_NUMBERSONLY;

    s_customheight_field[i].generic.type = MTYPE_FIELD;
    s_customheight_field[i].generic.name = "custom height";
    s_customheight_field[i].generic.x = 0;
    s_customheight_field[i].generic.y = 46;
    s_customheight_field[i].generic.flags = QMF_NUMBERSONLY;

    s_scale_slider[i].generic.type = MTYPE_SLIDER;
    s_scale_slider[i].generic.x = 0;
    s_scale_slider[i].generic.y = 64;
    s_scale_slider[i].generic.name = "resolution scale";
    // Bug fix (Mike, 2026-09-02): maxvalue used to be a hardcoded 10 (i.e.
    // VID_SCALE_MAX(1.0)*10), capping the slider at "native" with nothing
    // above it -- see vid_scale.ts's header comment on why 2.0x
    // (supersampling) is now a real, allocated render size. Driven off the
    // constants directly rather than re-hardcoded, so this can't drift from
    // vid_scale.ts's own range again.
    s_scale_slider[i].minvalue = VID_SCALE_MIN * 10;
    s_scale_slider[i].maxvalue = VID_SCALE_MAX * 10;
    s_scale_slider[i].valueFormatter = ScaleFormatter;

    // QoL addition (Mike, 2026-09-01): "scale to fullscreen" -- see this
    // file's s_scale_fit_box doc comment and vid.ts's VID_GetScaleFit. No
    // .generic.callback: matches this file's existing convention (s_fs_box,
    // s_stipple_box, s_windowed_mouse, s_paletted_texture_box below all
    // commit only on "apply", not live). Cvar_VariableValue on a
    // not-yet-registered cvar returns 0, which is fine here -- VID_GetScaleFit
    // is what actually registers the "1" default, and it runs during video
    // init, before the player can ever reach this menu.
    s_scale_fit_box[i].generic.type = MTYPE_SPINCONTROL;
    s_scale_fit_box[i].generic.x = 0;
    s_scale_fit_box[i].generic.y = 74;
    s_scale_fit_box[i].generic.name = "scale to fullscreen";
    s_scale_fit_box[i].itemnames = ["1:1 pixels", "fit screen"];
    s_scale_fit_box[i].curvalue = Cvar_VariableValue("vid_scale_fit") !== 0 ? 1 : 0;

    s_screensize_slider[i].generic.type = MTYPE_SLIDER;
    s_screensize_slider[i].generic.x = 0;
    s_screensize_slider[i].generic.y = 84;
    s_screensize_slider[i].generic.name = "screen size";
    s_screensize_slider[i].minvalue = 3;
    s_screensize_slider[i].maxvalue = 12;
    s_screensize_slider[i].generic.callback = ScreenSizeCallback;
    s_screensize_slider[i].valueFormatter = ScreenSizeFormatter;

    s_brightness_slider[i].generic.type = MTYPE_SLIDER;
    s_brightness_slider[i].generic.x = 0;
    s_brightness_slider[i].generic.y = 94;
    s_brightness_slider[i].generic.name = "brightness";
    s_brightness_slider[i].generic.callback = BrightnessCallback;
    s_brightness_slider[i].minvalue = 5;
    s_brightness_slider[i].maxvalue = 13;
    s_brightness_slider[i].curvalue = (1.3 - vidGammaC.value + 0.5) * 10;
    s_brightness_slider[i].valueFormatter = BrightnessFormatter;

    s_fs_box[i].generic.type = MTYPE_SPINCONTROL;
    s_fs_box[i].generic.x = 0;
    s_fs_box[i].generic.y = 104;
    s_fs_box[i].generic.name = "fullscreen";
    s_fs_box[i].itemnames = yesno_names;
    s_fs_box[i].curvalue = vidFullscreenC.value | 0;

    s_hudscale_box[i].generic.type = MTYPE_SPINCONTROL;
    s_hudscale_box[i].generic.x = 0;
    s_hudscale_box[i].generic.y = 114;
    s_hudscale_box[i].generic.name = "hud scale";
    s_hudscale_box[i].itemnames = hudscale_names;
    s_hudscale_box[i].curvalue = Math.max(0, Math.min(hudscale_names.length - 1, Cvar_VariableValue("scr_scale") | 0));

    s_defaults_action[i].generic.type = MTYPE_ACTION;
    s_defaults_action[i].generic.name = "reset to default";
    s_defaults_action[i].generic.x = 0;
    s_defaults_action[i].generic.y = 144;
    s_defaults_action[i].generic.callback = ResetDefaults;

    s_apply_action[i].generic.type = MTYPE_ACTION;
    s_apply_action[i].generic.name = "apply";
    s_apply_action[i].generic.x = 0;
    s_apply_action[i].generic.y = 154;
    s_apply_action[i].generic.callback = ApplyChanges;
  }

  // Continuing the flat 10-unit rhythm from s_fs_box (y=94) above -- these
  // used to jump 90/100 then 120 (a 20-unit double-gap either side), the
  // same non-uniform pattern this pass is removing.
  s_stipple_box.generic.type = MTYPE_SPINCONTROL;
  s_stipple_box.generic.x = 0;
  s_stipple_box.generic.y = 124;
  s_stipple_box.generic.name = "stipple alpha";
  s_stipple_box.curvalue = stippleC.value | 0;
  s_stipple_box.itemnames = yesno_names;

  s_windowed_mouse.generic.type = MTYPE_SPINCONTROL;
  s_windowed_mouse.generic.x = 0;
  s_windowed_mouse.generic.y = 134;
  s_windowed_mouse.generic.name = "windowed mouse";
  s_windowed_mouse.curvalue = winMouseC.value | 0;
  s_windowed_mouse.itemnames = yesno_names;

  s_tq_slider.generic.type = MTYPE_SLIDER;
  s_tq_slider.generic.x = 0;
  s_tq_slider.generic.y = 124;
  s_tq_slider.generic.name = "texture quality";
  s_tq_slider.minvalue = 0;
  s_tq_slider.maxvalue = 3;
  s_tq_slider.curvalue = 3 - glPicmipC.value;
  s_tq_slider.valueFormatter = TextureQualityFormatter;

  s_paletted_texture_box.generic.type = MTYPE_SPINCONTROL;
  s_paletted_texture_box.generic.x = 0;
  s_paletted_texture_box.generic.y = 134;
  s_paletted_texture_box.generic.name = "8-bit textures";
  s_paletted_texture_box.itemnames = yesno_names;
  s_paletted_texture_box.curvalue = glPalC.value | 0;

  // v1.1.0 shadow mapping rows. gl_shadowmaps/gl_shadowmap_res are
  // registered by ref_gl's R_Register with CVAR_ARCHIVE, but the video menu
  // can be opened in a session where the GL renderer never initialized (the
  // same situation gl_mode/sw_mode are lazily registered for above), so
  // register them here too if they are missing -- identical flags, so
  // whichever call lands first wins and the value still archives.
  if (!gl_shadowmaps) gl_shadowmaps = Cvar_Get("gl_shadowmaps", "1", CVAR_ARCHIVE);
  if (!gl_shadowmap_res) gl_shadowmap_res = Cvar_Get("gl_shadowmap_res", "512", CVAR_ARCHIVE);
  if (!gl_shaders) gl_shaders = Cvar_Get("gl_shaders", "1", CVAR_FILES);
  // Read defensively rather than bailing out: an early return here would
  // abort the whole menu build below and leave the player an empty video
  // menu. The defaults used on a null cvar are the same ones registered
  // just above.
  const shadowsOn = gl_shadowmaps ? gl_shadowmaps.value !== 0 : true;
  const shadowRes = gl_shadowmap_res ? gl_shadowmap_res.value : 512;
  // Shadow maps are sampled by the per-pixel lighting shader, so with
  // gl_shaders 0 there is nothing for these rows to drive.
  const shadersOff = gl_shaders ? !gl_shaders.value : false;

  s_shadows_box.generic.type = MTYPE_SPINCONTROL;
  s_shadows_box.generic.x = 0;
  s_shadows_box.generic.y = 144;
  s_shadows_box.generic.name = "shadow mapping";
  s_shadows_box.itemnames = shadersOff ? [SHADOW_UNAVAILABLE, SHADOW_UNAVAILABLE] : yesno_names;
  s_shadows_box.curvalue = shadowsOn ? 1 : 0;

  s_shadow_quality_slider.generic.type = MTYPE_SLIDER;
  s_shadow_quality_slider.generic.x = 0;
  s_shadow_quality_slider.generic.y = 154;
  s_shadow_quality_slider.generic.name = "shadow quality";
  s_shadow_quality_slider.minvalue = 0;
  s_shadow_quality_slider.maxvalue = SHADOW_QUALITY_RES.length - 1;
  s_shadow_quality_slider.curvalue = ShadowQualityIndexFor(shadowRes);
  s_shadow_quality_slider.valueFormatter = shadersOff ? ShadowUnavailableFormatter : ShadowQualityFormatter;

  // Shadow maps are sampled by the per-pixel lighting shader, so with
  // gl_shaders 0 there is nothing for these rows to drive. Grey them and say
  // why, rather than letting the player set a value that silently does
  // nothing.
  for (const row of [s_shadows_box.generic, s_shadow_quality_slider.generic]) {
    if (shadersOff) {
      row.flags |= QMF_GRAYED;
      row.statusbar = "requires gl_shaders 1";
    } else {
      row.flags &= ~QMF_GRAYED;
      row.statusbar = null;
    }
  }

  // The two shadow rows above sit where the shared reset/apply pair was
  // (134/144), so the OpenGL submenu's own copies move down past them --
  // keeping the same flat 10-unit rhythm. The software submenu's copies stay
  // put: it has no shadow rows, so nothing displaced them there.
  const openglDefaults = s_defaults_action[OPENGL_MENU];
  const openglApply = s_apply_action[OPENGL_MENU];
  if (openglDefaults) openglDefaults.generic.y = 164;
  if (openglApply) openglApply.generic.y = 174;

  Menu_AddItem(s_software_menu, s_ref_list[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_mode_list[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_customwidth_field[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_customheight_field[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_scale_slider[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_scale_fit_box[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_screensize_slider[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_brightness_slider[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_fs_box[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_hudscale_box[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_stipple_box);
  Menu_AddItem(s_software_menu, s_windowed_mouse);

  Menu_AddItem(s_opengl_menu, s_ref_list[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_mode_list[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_customwidth_field[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_customheight_field[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_scale_slider[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_scale_fit_box[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_screensize_slider[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_brightness_slider[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_fs_box[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_hudscale_box[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_tq_slider);
  Menu_AddItem(s_opengl_menu, s_paletted_texture_box);
  Menu_AddItem(s_opengl_menu, s_shadows_box);
  Menu_AddItem(s_opengl_menu, s_shadow_quality_slider);

  Menu_AddItem(s_software_menu, s_defaults_action[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_apply_action[SOFTWARE_MENU]);
  Menu_AddItem(s_opengl_menu, s_defaults_action[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_apply_action[OPENGL_MENU]);

  Menu_Center(s_software_menu);
  Menu_Center(s_opengl_menu);
  s_opengl_menu.x -= 8;
  s_software_menu.x -= 8;

  // Both bodies start below the banner VID_MenuDraw draws at
  // viddef.height / 2 - 110 (see Menu_KeepBelow).
  if (re) {
    const { h } = re.DrawGetPicSize("m_banner_video");
    const bannerBottom = ((viddef.height / 2) | 0) - 110 + Math.max(0, h);
    Menu_KeepBelow(s_software_menu, bannerBottom);
    Menu_KeepBelow(s_opengl_menu, bannerBottom);
  }
}

/*
================
VID_MenuDraw
================
*/
export function VID_MenuDraw(): void {
  if (s_current_menu_index === 0) s_current_menu = s_software_menu;
  else s_current_menu = s_opengl_menu;

  /*
  ** draw the banner
  */
  if (re) {
    const { w } = re.DrawGetPicSize("m_banner_video");
    re.DrawPic(((viddef.width / 2) | 0) - ((w / 2) | 0), ((viddef.height / 2) | 0) - 110, "m_banner_video");
  }

  /*
  ** move cursor to a reasonable starting position
  */
  Menu_AdjustCursor(s_current_menu, 1);

  /*
  ** draw the menu
  */
  Menu_Draw(s_current_menu);
}

/*
================
VID_MenuKey
================
*/
export function VID_MenuKey(key: number): string | null {
  const m = s_current_menu;
  const sound = "misc/menu1.wav";

  // s_customwidth_field/s_customheight_field (v1.0.0 RC) are this menu's
  // first MTYPE_FIELD widgets -- the real linux/vid_menu.c's VID_MenuKey
  // never needed Field_Key routing (no field widgets at all); mirrors
  // client/menu.ts's own Default_MenuKey, see this file's header comment.
  const item = Menu_ItemAtCursor(m);
  if (item && isField(item) && Field_Key(item, key)) return null;

  switch (key) {
    case K_ESCAPE:
      menuMod().M_PopMenu();
      return null;
    case K_UPARROW:
      m.cursor--;
      Menu_AdjustCursor(m, -1);
      break;
    case K_DOWNARROW:
      m.cursor++;
      Menu_AdjustCursor(m, 1);
      break;
    case K_LEFTARROW:
      Menu_SlideItem(m, -1);
      break;
    case K_RIGHTARROW:
      Menu_SlideItem(m, 1);
      break;
    case K_ENTER:
      Menu_SelectItem(m);
      break;
    default:
      break;
  }

  return sound;
}
