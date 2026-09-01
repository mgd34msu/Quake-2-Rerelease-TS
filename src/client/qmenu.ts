// qmenu.h -- the generic menu widget toolkit shared by menu.c. K_TAB/
// K_ENTER/K_ESCAPE/K_SPACE/K_BACKSPACE/K_UPARROW/K_DOWNARROW/K_LEFTARROW/
// K_RIGHTARROW are #defined a second time in the C header (identical values
// to keys.h); not re-declared here since keys.ts already exports them and
// values must match project-wide -- import from keys.ts at call sites.
//
// Every function this header declares (Field_Key, Menu_AddItem,
// Menu_AdjustCursor, Menu_Center, Menu_Draw, Menu_ItemAtCursor,
// Menu_SelectItem, Menu_SetStatusBar, Menu_SlideItem, Menu_TallySlots,
// Menu_DrawString, Menu_DrawStringDark, Menu_DrawStringR2L,
// Menu_DrawStringR2LDark) is defined in qmenu.c and ported as a function in
// qmenu_impl.ts's pending stub (renamed from the header's own basename to
// avoid colliding with this type module -- see PORTING.md deviation in the
// report).

export const MAXMENUITEMS = 64;

export const MTYPE_SLIDER = 0;
export const MTYPE_LIST = 1;
export const MTYPE_ACTION = 2;
export const MTYPE_SPINCONTROL = 3;
export const MTYPE_SEPARATOR = 4;
export const MTYPE_FIELD = 5;

export const QMF_LEFT_JUSTIFY = 0x00000001;
export const QMF_GRAYED = 0x00000002;
export const QMF_NUMBERSONLY = 0x00000004;

// void *items[64] holds a pointer to one of these five structs, each of
// which embeds menucommon_s as its first field (`generic`); C code
// dispatches on `((menucommon_s *)item)->type` (one of the MTYPE_*
// constants above). Ported as a union of the five concrete item classes.
export type MenuItemU = MenufieldS | MenusliderS | MenulistS | MenuactionS | MenuseparatorS;

export class MenuframeworkS {
  x = 0;
  y = 0;
  cursor = 0;

  nitems = 0;
  nslots = 0;
  items: (MenuItemU | null)[] = new Array(MAXMENUITEMS).fill(null);

  statusbar: string | null = null;

  cursordraw: ((m: MenuframeworkS) => void) | null = null;
}

export class MenuCommonS {
  type = 0;
  name: string | null = null;
  x = 0;
  y = 0;
  parent: MenuframeworkS | null = null;
  cursor_offset = 0;
  localdata: Int32Array = new Int32Array(4);
  flags = 0; // unsigned -- QMF_*

  statusbar: string | null = null;

  callback: ((self: MenuItemU) => void) | null = null;
  statusbarfunc: ((self: MenuItemU) => void) | null = null;
  ownerdraw: ((self: MenuItemU) => void) | null = null;
  cursordraw: ((self: MenuItemU) => void) | null = null;
}

export class MenufieldS {
  generic: MenuCommonS = new MenuCommonS();

  buffer = ""; // char[80]
  cursor = 0;
  length = 0;
  visible_length = 0;
  visible_offset = 0;
}

export class MenusliderS {
  generic: MenuCommonS = new MenuCommonS();

  minvalue = 0;
  maxvalue = 0;
  curvalue = 0;

  range = 0;

  // QoL addition (Mike, 2026-09-01): optional curvalue -> display-string
  // formatter. When set, Slider_Draw (qmenu_impl.ts) draws the formatted
  // string just past the slider track, in the same row. Display-only --
  // never affects range/step/cvar writes. No formatter set = today's
  // rendering, byte-for-byte unchanged.
  valueFormatter: ((curvalue: number) => string) | null = null;
}

export class MenulistS {
  generic: MenuCommonS = new MenuCommonS();

  curvalue = 0;

  itemnames: string[] = [];
}

export class MenuactionS {
  generic: MenuCommonS = new MenuCommonS();
}

export class MenuseparatorS {
  generic: MenuCommonS = new MenuCommonS();
}
