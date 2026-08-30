/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from linux/vid_menu.c (GNU GPL v2 or later) -- the video options
menu (driver/mode/screensize/brightness/fullscreen widgets, apply/defaults).
The per-platform variants (linux/win32/irix) are near-identical; the linux
one is ported per PORTING.md's platform-track rule.

Deviations:
- resolutions[] gains "[1920 1080]" to match the mode-10 entry vid.ts adds
  past the C-era 4:3 table.
- "software X11" and "default OpenGL" driver choices remain listed for
  fidelity, but VID_LoadRefresh (vid.ts) statically links the one software
  refresh, so applying them falls back to soft with a console message.
- M_PopMenu/M_ForceMenuOff live in client/menu.ts, which imports this
  module for M_Menu_Video_f; the value cycle is broken here (the less
  fundamental side) with the sanctioned lazy require() idiom.
*/

import {
  MenuframeworkS,
  MenulistS,
  MenusliderS,
  MenuactionS,
  MTYPE_SPINCONTROL,
  MTYPE_SLIDER,
  MTYPE_ACTION,
} from "../client/qmenu";
import {
  Menu_AddItem,
  Menu_AdjustCursor,
  Menu_Center,
  Menu_Draw,
  Menu_SelectItem,
  Menu_SlideItem,
} from "../client/qmenu_impl";
import { K_ESCAPE, K_UPARROW, K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW, K_ENTER } from "../client/keys";
import { Cvar_Get, Cvar_Set, Cvar_SetValue } from "../qcommon/cvar";
import { CVAR_ARCHIVE, type CvarT } from "../shared/q_shared";
import { viddef } from "../client/vid";
import { re } from "../client/client";

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
const SOFTWARE_MENU = 0;
const OPENGL_MENU = 1;

const s_software_menu = new MenuframeworkS();
const s_opengl_menu = new MenuframeworkS();
let s_current_menu: MenuframeworkS = s_software_menu;
let s_current_menu_index = 0;

const s_mode_list: MenulistS[] = [new MenulistS(), new MenulistS()];
const s_ref_list: MenulistS[] = [new MenulistS(), new MenulistS()];
const s_tq_slider = new MenusliderS();
const s_screensize_slider: MenusliderS[] = [new MenusliderS(), new MenusliderS()];
const s_brightness_slider: MenusliderS[] = [new MenusliderS(), new MenusliderS()];
const s_fs_box: MenulistS[] = [new MenulistS(), new MenulistS()];
const s_stipple_box = new MenulistS();
const s_paletted_texture_box = new MenulistS();
const s_windowed_mouse = new MenulistS();
const s_apply_action: MenuactionS[] = [new MenuactionS(), new MenuactionS()];
const s_defaults_action: MenuactionS[] = [new MenuactionS(), new MenuactionS()];

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

function ResetDefaults(): void {
  VID_MenuInit();
}

function ApplyChanges(): void {
  /*
  ** make values consistent
  */
  const other = s_current_menu_index === 0 ? 1 : 0;
  s_fs_box[other].curvalue = s_fs_box[s_current_menu_index].curvalue;
  s_brightness_slider[other].curvalue = s_brightness_slider[s_current_menu_index].curvalue;
  s_ref_list[other].curvalue = s_ref_list[s_current_menu_index].curvalue;

  /*
  ** invert sense so greater = brighter, and scale to a range of 0.5 to 1.3
  */
  const gamma = 0.8 - (s_brightness_slider[s_current_menu_index].curvalue / 10.0 - 0.5) + 0.5;

  Cvar_SetValue("vid_gamma", gamma);
  Cvar_SetValue("sw_stipplealpha", s_stipple_box.curvalue);
  Cvar_SetValue("gl_picmip", 3 - s_tq_slider.curvalue);
  Cvar_SetValue("vid_fullscreen", s_fs_box[s_current_menu_index].curvalue);
  Cvar_SetValue("gl_ext_palettedtexture", s_paletted_texture_box.curvalue);
  Cvar_SetValue("sw_mode", s_mode_list[SOFTWARE_MENU].curvalue);
  Cvar_SetValue("gl_mode", s_mode_list[OPENGL_MENU].curvalue);
  Cvar_SetValue("_windowed_mouse", s_windowed_mouse.curvalue);

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
  const resolutions = [
    "[320 240  ]",
    "[400 300  ]",
    "[512 384  ]",
    "[640 480  ]",
    "[800 600  ]",
    "[960 720  ]",
    "[1024 768 ]",
    "[1152 864 ]",
    "[1280 960 ]", // win32 pairing: vid.ts mode 8 is 1280x960 (linux label said 1024)
    "[1600 1200]",
    "[1920 1080]",
  ];
  const refs = ["[software      ]", "[software X11  ]", "[default OpenGL]"];
  const yesno_names = ["no", "yes"];

  if (!gl_driver) gl_driver = Cvar_Get("gl_driver", "opengl32", 0);
  if (!gl_picmip) gl_picmip = Cvar_Get("gl_picmip", "0", 0);
  if (!gl_mode) gl_mode = Cvar_Get("gl_mode", "3", 0);
  if (!sw_mode) sw_mode = Cvar_Get("sw_mode", "0", 0);
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

  s_mode_list[SOFTWARE_MENU].curvalue = swModeC.value | 0;
  s_mode_list[OPENGL_MENU].curvalue = glModeC.value | 0;

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

    s_screensize_slider[i].generic.type = MTYPE_SLIDER;
    s_screensize_slider[i].generic.x = 0;
    s_screensize_slider[i].generic.y = 20;
    s_screensize_slider[i].generic.name = "screen size";
    s_screensize_slider[i].minvalue = 3;
    s_screensize_slider[i].maxvalue = 12;
    s_screensize_slider[i].generic.callback = ScreenSizeCallback;

    s_brightness_slider[i].generic.type = MTYPE_SLIDER;
    s_brightness_slider[i].generic.x = 0;
    s_brightness_slider[i].generic.y = 30;
    s_brightness_slider[i].generic.name = "brightness";
    s_brightness_slider[i].generic.callback = BrightnessCallback;
    s_brightness_slider[i].minvalue = 5;
    s_brightness_slider[i].maxvalue = 13;
    s_brightness_slider[i].curvalue = (1.3 - vidGammaC.value + 0.5) * 10;

    s_fs_box[i].generic.type = MTYPE_SPINCONTROL;
    s_fs_box[i].generic.x = 0;
    s_fs_box[i].generic.y = 40;
    s_fs_box[i].generic.name = "fullscreen";
    s_fs_box[i].itemnames = yesno_names;
    s_fs_box[i].curvalue = vidFullscreenC.value | 0;

    s_defaults_action[i].generic.type = MTYPE_ACTION;
    s_defaults_action[i].generic.name = "reset to default";
    s_defaults_action[i].generic.x = 0;
    s_defaults_action[i].generic.y = 90;
    s_defaults_action[i].generic.callback = ResetDefaults;

    s_apply_action[i].generic.type = MTYPE_ACTION;
    s_apply_action[i].generic.name = "apply";
    s_apply_action[i].generic.x = 0;
    s_apply_action[i].generic.y = 100;
    s_apply_action[i].generic.callback = ApplyChanges;
  }

  s_stipple_box.generic.type = MTYPE_SPINCONTROL;
  s_stipple_box.generic.x = 0;
  s_stipple_box.generic.y = 60;
  s_stipple_box.generic.name = "stipple alpha";
  s_stipple_box.curvalue = stippleC.value | 0;
  s_stipple_box.itemnames = yesno_names;

  s_windowed_mouse.generic.type = MTYPE_SPINCONTROL;
  s_windowed_mouse.generic.x = 0;
  s_windowed_mouse.generic.y = 72;
  s_windowed_mouse.generic.name = "windowed mouse";
  s_windowed_mouse.curvalue = winMouseC.value | 0;
  s_windowed_mouse.itemnames = yesno_names;

  s_tq_slider.generic.type = MTYPE_SLIDER;
  s_tq_slider.generic.x = 0;
  s_tq_slider.generic.y = 60;
  s_tq_slider.generic.name = "texture quality";
  s_tq_slider.minvalue = 0;
  s_tq_slider.maxvalue = 3;
  s_tq_slider.curvalue = 3 - glPicmipC.value;

  s_paletted_texture_box.generic.type = MTYPE_SPINCONTROL;
  s_paletted_texture_box.generic.x = 0;
  s_paletted_texture_box.generic.y = 70;
  s_paletted_texture_box.generic.name = "8-bit textures";
  s_paletted_texture_box.itemnames = yesno_names;
  s_paletted_texture_box.curvalue = glPalC.value | 0;

  Menu_AddItem(s_software_menu, s_ref_list[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_mode_list[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_screensize_slider[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_brightness_slider[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_fs_box[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_stipple_box);
  Menu_AddItem(s_software_menu, s_windowed_mouse);

  Menu_AddItem(s_opengl_menu, s_ref_list[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_mode_list[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_screensize_slider[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_brightness_slider[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_fs_box[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_tq_slider);
  Menu_AddItem(s_opengl_menu, s_paletted_texture_box);

  Menu_AddItem(s_software_menu, s_defaults_action[SOFTWARE_MENU]);
  Menu_AddItem(s_software_menu, s_apply_action[SOFTWARE_MENU]);
  Menu_AddItem(s_opengl_menu, s_defaults_action[OPENGL_MENU]);
  Menu_AddItem(s_opengl_menu, s_apply_action[OPENGL_MENU]);

  Menu_Center(s_software_menu);
  Menu_Center(s_opengl_menu);
  s_opengl_menu.x -= 8;
  s_software_menu.x -= 8;
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
