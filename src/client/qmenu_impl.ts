// qmenu.c -- the generic menu widget toolkit. Named qmenu_impl.ts, not
// qmenu.ts, because qmenu.h's type surface already owns that basename
// (MenuframeworkS/MenuCommonS/etc. in qmenu.ts) -- a deliberate exception to
// PORTING.md's "same basename" rule, reported per this unit's brief.
// Action_DoEnter/Action_Draw/Field_DoEnter/Field_Draw/Menu_DrawStatusBar/
// Menulist_DoEnter/MenuList_Draw/Separator_Draw/Slider_DoSlide/Slider_Draw/
// SpinControl_DoEnter/SpinControl_DoSlide/SpinControl_Draw are internal to
// qmenu.c (not declared in qmenu.h) and stay module-private here too.
//
// `#define Draw_Char re.DrawChar` / `#define Draw_Fill re.DrawFill` --
// ref_gl/ is not ported (PORTING.md), so `re` is `RefExports | null` and
// stays null with no GL renderer constructed. Every drawing entry point
// here early-returns on `!re` instead of null-derefing, matching the
// precedent in cl_tent.ts's CL_RegisterTEntModels -- reported deviation
// from the C, which never null-checks `re`.
import { viddef } from "./vid";
import { re } from "./client";
import { Sys_Milliseconds } from "../platform/sys";
import {
  K_TAB,
  K_ENTER,
  K_ESCAPE,
  K_SPACE,
  K_BACKSPACE,
  K_LEFTARROW,
  K_DEL,
  K_KP_HOME,
  K_KP_UPARROW,
  K_KP_PGUP,
  K_KP_LEFTARROW,
  K_KP_5,
  K_KP_RIGHTARROW,
  K_KP_END,
  K_KP_DOWNARROW,
  K_KP_PGDN,
  K_KP_ENTER,
  K_KP_INS,
  K_KP_DEL,
  K_KP_SLASH,
  K_KP_MINUS,
  K_KP_PLUS,
} from "./keys";
import {
  MAXMENUITEMS,
  MTYPE_SLIDER,
  MTYPE_LIST,
  MTYPE_ACTION,
  MTYPE_SPINCONTROL,
  MTYPE_SEPARATOR,
  MTYPE_FIELD,
  QMF_LEFT_JUSTIFY,
  QMF_GRAYED,
  QMF_NUMBERSONLY,
  type MenuframeworkS,
  type MenuCommonS,
  type MenufieldS,
  type MenusliderS,
  type MenulistS,
  type MenuactionS,
  type MenuseparatorS,
  type MenuItemU,
} from "./qmenu";

const RCOLUMN_OFFSET = 16;
const LCOLUMN_OFFSET = -16;
const VID_WIDTH = () => viddef.width;
const VID_HEIGHT = () => viddef.height;

function DrawChar(x: number, y: number, c: number): void {
  if (re) re.DrawChar(x, y, c);
}
function DrawFill(x: number, y: number, w: number, h: number, c: number): void {
  if (re) re.DrawFill(x, y, w, h, c);
}

export function isField(item: MenuItemU): item is MenufieldS {
  return item.generic.type === MTYPE_FIELD;
}
function isSlider(item: MenuItemU): item is MenusliderS {
  return item.generic.type === MTYPE_SLIDER;
}
export function isList(item: MenuItemU): item is MenulistS {
  return item.generic.type === MTYPE_LIST;
}
function isSpinControl(item: MenuItemU): item is MenulistS {
  return item.generic.type === MTYPE_SPINCONTROL;
}
function isAction(item: MenuItemU): item is MenuactionS {
  return item.generic.type === MTYPE_ACTION;
}
function isSeparator(item: MenuItemU): item is MenuseparatorS {
  return item.generic.type === MTYPE_SEPARATOR;
}

// qmenu.ts types `generic.parent` as `MenuframeworkS | null` (it starts
// unset until Menu_AddItem runs). Every real call path adds an item to its
// menu before ever drawing/keying it, so this is a type-narrowing helper
// only, not a behavior change -- the C never null-checks `parent` either
// (it would be undefined behavior if this were ever violated).
function parentOf(generic: MenuCommonS): MenuframeworkS {
  if (generic.parent === null) {
    throw new Error("qmenu item has no parent -- Menu_AddItem must run before Draw/Key");
  }
  return generic.parent;
}

function Action_DoEnter(a: MenuactionS): void {
  if (a.generic.callback) a.generic.callback(a);
}

function Action_Draw(a: MenuactionS): void {
  if (!re) return;
  const parent = parentOf(a.generic);
  if (a.generic.flags & QMF_LEFT_JUSTIFY) {
    if (a.generic.flags & QMF_GRAYED) Menu_DrawStringDark(a.generic.x + parent.x + LCOLUMN_OFFSET, a.generic.y + parent.y, a.generic.name ?? "");
    else Menu_DrawString(a.generic.x + parent.x + LCOLUMN_OFFSET, a.generic.y + parent.y, a.generic.name ?? "");
  } else {
    if (a.generic.flags & QMF_GRAYED) Menu_DrawStringR2LDark(a.generic.x + parent.x + LCOLUMN_OFFSET, a.generic.y + parent.y, a.generic.name ?? "");
    else Menu_DrawStringR2L(a.generic.x + parent.x + LCOLUMN_OFFSET, a.generic.y + parent.y, a.generic.name ?? "");
  }
  if (a.generic.ownerdraw) a.generic.ownerdraw(a);
}

function Field_DoEnter(f: MenufieldS): boolean {
  if (f.generic.callback) {
    f.generic.callback(f);
    return true;
  }
  return false;
}

function Field_Draw(f: MenufieldS): void {
  if (!re) return;
  const parent = parentOf(f.generic);

  if (f.generic.name) Menu_DrawStringR2LDark(f.generic.x + parent.x + LCOLUMN_OFFSET, f.generic.y + parent.y, f.generic.name);

  const tempbuffer = f.buffer.slice(f.visible_offset, f.visible_offset + f.visible_length);

  DrawChar(f.generic.x + parent.x + 16, f.generic.y + parent.y - 4, 18);
  DrawChar(f.generic.x + parent.x + 16, f.generic.y + parent.y + 4, 24);

  DrawChar(f.generic.x + parent.x + 24 + f.visible_length * 8, f.generic.y + parent.y - 4, 20);
  DrawChar(f.generic.x + parent.x + 24 + f.visible_length * 8, f.generic.y + parent.y + 4, 26);

  for (let i = 0; i < f.visible_length; i++) {
    DrawChar(f.generic.x + parent.x + 24 + i * 8, f.generic.y + parent.y - 4, 19);
    DrawChar(f.generic.x + parent.x + 24 + i * 8, f.generic.y + parent.y + 4, 25);
  }

  Menu_DrawString(f.generic.x + parent.x + 24, f.generic.y + parent.y, tempbuffer);

  if (Menu_ItemAtCursor(parent) === f) {
    const offset = f.visible_offset ? f.visible_length : f.cursor;

    if ((Sys_Milliseconds() / 250) & 1) {
      DrawChar(f.generic.x + parent.x + (offset + 2) * 8 + 8, f.generic.y + parent.y, 11);
    } else {
      DrawChar(f.generic.x + parent.x + (offset + 2) * 8 + 8, f.generic.y + parent.y, 32);
    }
  }
}

export function Field_Key(field: MenufieldS, key: number): boolean {
  let k = key;

  switch (k) {
    case K_KP_SLASH:
      k = "/".charCodeAt(0);
      break;
    case K_KP_MINUS:
      k = "-".charCodeAt(0);
      break;
    case K_KP_PLUS:
      k = "+".charCodeAt(0);
      break;
    case K_KP_HOME:
      k = "7".charCodeAt(0);
      break;
    case K_KP_UPARROW:
      k = "8".charCodeAt(0);
      break;
    case K_KP_PGUP:
      k = "9".charCodeAt(0);
      break;
    case K_KP_LEFTARROW:
      k = "4".charCodeAt(0);
      break;
    case K_KP_5:
      k = "5".charCodeAt(0);
      break;
    case K_KP_RIGHTARROW:
      k = "6".charCodeAt(0);
      break;
    case K_KP_END:
      k = "1".charCodeAt(0);
      break;
    case K_KP_DOWNARROW:
      k = "2".charCodeAt(0);
      break;
    case K_KP_PGDN:
      k = "3".charCodeAt(0);
      break;
    case K_KP_INS:
      k = "0".charCodeAt(0);
      break;
    case K_KP_DEL:
      k = ".".charCodeAt(0);
      break;
  }

  // C: `if (key > 127) switch (key) { case K_DEL: default: return false; }`
  // -- every arm of that inner switch returns false, so it collapses to a
  // plain range check with no behavior change.
  if (k > 127) return false;

  // Clipboard paste (ctrl+V / shift+Insert) is dropped here: the C reads
  // keys.c's `qboolean keydown[256]` global and calls Sys_GetClipboardData(),
  // and neither primitive is ported yet (keys_impl.ts/platform/sys.ts) --
  // reported omission, not a TODO.

  switch (k) {
    case K_KP_LEFTARROW:
    case K_LEFTARROW:
    case K_BACKSPACE:
      if (field.cursor > 0) {
        field.buffer = field.buffer.slice(0, field.cursor - 1) + field.buffer.slice(field.cursor);
        field.cursor--;

        if (field.visible_offset) {
          field.visible_offset--;
        }
      }
      break;

    case K_KP_DEL:
    case K_DEL:
      // Unreachable in the original: K_DEL is remapped to nothing above and
      // is caught by the `k > 127` check before reaching here; K_KP_DEL was
      // already turned into '.' by the remap switch. Kept for fidelity.
      field.buffer = field.buffer.slice(0, field.cursor) + field.buffer.slice(field.cursor + 1);
      break;

    case K_KP_ENTER:
    case K_ENTER:
    case K_ESCAPE:
    case K_TAB:
      return false;

    case K_SPACE:
    default: {
      const isDigit = k >= 48 && k <= 57;
      if (!isDigit && field.generic.flags & QMF_NUMBERSONLY) return false;

      if (field.cursor < field.length) {
        field.buffer = field.buffer.slice(0, field.cursor) + String.fromCharCode(k) + field.buffer.slice(field.cursor);
        field.cursor++;

        if (field.cursor > field.visible_length) {
          field.visible_offset++;
        }
      }
    }
  }

  return true;
}

export function Menu_AddItem(menu: MenuframeworkS, item: MenuItemU): void {
  if (menu.nitems === 0) menu.nslots = 0;

  if (menu.nitems < MAXMENUITEMS) {
    menu.items[menu.nitems] = item;
    item.generic.parent = menu;
    menu.nitems++;
  }

  menu.nslots = Menu_TallySlots(menu);
}

/*
** Menu_AdjustCursor
**
** This function takes the given menu, the direction, and attempts
** to adjust the menu's cursor so that it's at the next available
** slot.
*/
export function Menu_AdjustCursor(m: MenuframeworkS, dir: number): void {
  // see if it's in a valid spot
  if (m.cursor >= 0 && m.cursor < m.nitems) {
    const citem = Menu_ItemAtCursor(m);
    if (citem !== null) {
      if (citem.generic.type !== MTYPE_SEPARATOR) return;
    }
  }

  // it's not in a valid spot, so crawl in the direction indicated until we
  // find a valid spot
  if (dir === 1) {
    for (;;) {
      const citem = Menu_ItemAtCursor(m);
      if (citem && citem.generic.type !== MTYPE_SEPARATOR) break;
      m.cursor += dir;
      if (m.cursor >= m.nitems) m.cursor = 0;
    }
  } else {
    for (;;) {
      const citem = Menu_ItemAtCursor(m);
      if (citem && citem.generic.type !== MTYPE_SEPARATOR) break;
      m.cursor += dir;
      if (m.cursor < 0) m.cursor = m.nitems - 1;
    }
  }
}

export function Menu_Center(menu: MenuframeworkS): void {
  const last = menu.items[menu.nitems - 1];
  let height = last ? last.generic.y : 0;
  height += 10;

  menu.y = (VID_HEIGHT() - height) / 2;
}

export function Menu_Draw(menu: MenuframeworkS): void {
  // draw contents
  for (let i = 0; i < menu.nitems; i++) {
    const item = menu.items[i];
    if (!item) continue;

    if (isField(item)) Field_Draw(item);
    else if (isSlider(item)) Slider_Draw(item);
    else if (isList(item)) MenuList_Draw(item);
    else if (isSpinControl(item)) SpinControl_Draw(item);
    else if (isAction(item)) Action_Draw(item);
    else if (isSeparator(item)) Separator_Draw(item);
  }

  const item = Menu_ItemAtCursor(menu);

  if (item && item.generic.cursordraw) {
    item.generic.cursordraw(item);
  } else if (menu.cursordraw) {
    menu.cursordraw(menu);
  } else if (item && item.generic.type !== MTYPE_FIELD) {
    const frame = 12 + ((Sys_Milliseconds() / 250) & 1);
    if (item.generic.flags & QMF_LEFT_JUSTIFY) {
      DrawChar(menu.x + item.generic.x - 24 + item.generic.cursor_offset, menu.y + item.generic.y, frame);
    } else {
      DrawChar(menu.x + item.generic.cursor_offset, menu.y + item.generic.y, frame);
    }
  }

  if (item) {
    if (item.generic.statusbarfunc) item.generic.statusbarfunc(item);
    else if (item.generic.statusbar) Menu_DrawStatusBar(item.generic.statusbar);
    else Menu_DrawStatusBar(menu.statusbar);
  } else {
    Menu_DrawStatusBar(menu.statusbar);
  }
}

function Menu_DrawStatusBar(str: string | null): void {
  if (!re) return;
  if (str) {
    const l = str.length;
    const maxcol = VID_WIDTH() / 8;
    const col = maxcol / 2 - l / 2;

    DrawFill(0, VID_HEIGHT() - 8, VID_WIDTH(), 8, 4);
    Menu_DrawString(col * 8, VID_HEIGHT() - 8, str);
  } else {
    DrawFill(0, VID_HEIGHT() - 8, VID_WIDTH(), 8, 0);
  }
}

export function Menu_DrawString(x: number, y: number, string: string): void {
  if (!re) return;
  for (let i = 0; i < string.length; i++) {
    DrawChar(x + i * 8, y, string.charCodeAt(i));
  }
}

export function Menu_DrawStringDark(x: number, y: number, string: string): void {
  if (!re) return;
  for (let i = 0; i < string.length; i++) {
    DrawChar(x + i * 8, y, string.charCodeAt(i) + 128);
  }
}

export function Menu_DrawStringR2L(x: number, y: number, string: string): void {
  if (!re) return;
  for (let i = 0; i < string.length; i++) {
    DrawChar(x - i * 8, y, string.charCodeAt(string.length - i - 1));
  }
}

export function Menu_DrawStringR2LDark(x: number, y: number, string: string): void {
  if (!re) return;
  for (let i = 0; i < string.length; i++) {
    DrawChar(x - i * 8, y, string.charCodeAt(string.length - i - 1) + 128);
  }
}

export function Menu_ItemAtCursor(m: MenuframeworkS): MenuItemU | null {
  if (m.cursor < 0 || m.cursor >= m.nitems) return null;
  return m.items[m.cursor];
}

export function Menu_SelectItem(s: MenuframeworkS): boolean {
  const item = Menu_ItemAtCursor(s);

  if (item) {
    if (isField(item)) return Field_DoEnter(item);
    if (isAction(item)) {
      Action_DoEnter(item);
      return true;
    }
    // MTYPE_LIST/MTYPE_SPINCONTROL: Menulist_DoEnter/SpinControl_DoEnter
    // calls are commented out in the C original too -- dead code, kept
    // private below for fidelity but never invoked from here.
    if (isList(item)) return false;
    if (isSpinControl(item)) return false;
  }
  return false;
}

export function Menu_SetStatusBar(m: MenuframeworkS, string: string | null): void {
  m.statusbar = string;
}

export function Menu_SlideItem(s: MenuframeworkS, dir: number): void {
  const item = Menu_ItemAtCursor(s);

  if (item) {
    if (isSlider(item)) Slider_DoSlide(item, dir);
    else if (isSpinControl(item)) SpinControl_DoSlide(item, dir);
  }
}

export function Menu_TallySlots(menu: MenuframeworkS): number {
  let total = 0;

  for (let i = 0; i < menu.nitems; i++) {
    const item = menu.items[i];
    if (!item) continue;

    // C's `const char **itemnames` is NULL-terminated and walked by hand;
    // itemnames is a plain `string[]` here, so `.length` is the item count.
    if (isList(item)) total += item.itemnames.length;
    else total++;
  }

  return total;
}

function Menulist_DoEnter(l: MenulistS): void {
  const start = l.generic.y / 10 + 1;

  l.curvalue = parentOf(l.generic).cursor - start;

  if (l.generic.callback) l.generic.callback(l);
}

function MenuList_Draw(l: MenulistS): void {
  if (!re) return;
  const parent = parentOf(l.generic);

  Menu_DrawStringR2LDark(l.generic.x + parent.x + LCOLUMN_OFFSET, l.generic.y + parent.y, l.generic.name ?? "");

  DrawFill(l.generic.x - 112 + parent.x, parent.y + l.generic.y + l.curvalue * 10 + 10, 128, 10, 16);

  let y = 0;
  for (const name of l.itemnames) {
    Menu_DrawStringR2LDark(l.generic.x + parent.x + LCOLUMN_OFFSET, l.generic.y + parent.y + y + 10, name);
    y += 10;
  }
}

function Separator_Draw(s: MenuseparatorS): void {
  if (!re) return;
  if (s.generic.name) {
    const parent = parentOf(s.generic);
    Menu_DrawStringR2LDark(s.generic.x + parent.x, s.generic.y + parent.y, s.generic.name);
  }
}

function Slider_DoSlide(s: MenusliderS, dir: number): void {
  s.curvalue += dir;

  if (s.curvalue > s.maxvalue) s.curvalue = s.maxvalue;
  else if (s.curvalue < s.minvalue) s.curvalue = s.minvalue;

  if (s.generic.callback) s.generic.callback(s);
}

const SLIDER_RANGE = 10;

function Slider_Draw(s: MenusliderS): void {
  if (!re) return;
  const parent = parentOf(s.generic);

  Menu_DrawStringR2LDark(s.generic.x + parent.x + LCOLUMN_OFFSET, s.generic.y + parent.y, s.generic.name ?? "");

  s.range = (s.curvalue - s.minvalue) / (s.maxvalue - s.minvalue);

  if (s.range < 0) s.range = 0;
  if (s.range > 1) s.range = 1;

  DrawChar(s.generic.x + parent.x + RCOLUMN_OFFSET, s.generic.y + parent.y, 128);

  let i = 0;
  for (i = 0; i < SLIDER_RANGE; i++) DrawChar(RCOLUMN_OFFSET + s.generic.x + i * 8 + parent.x + 8, s.generic.y + parent.y, 129);
  DrawChar(RCOLUMN_OFFSET + s.generic.x + i * 8 + parent.x + 8, s.generic.y + parent.y, 130);
  DrawChar(8 + RCOLUMN_OFFSET + parent.x + s.generic.x + (SLIDER_RANGE - 1) * 8 * s.range, s.generic.y + parent.y, 131);
}

function SpinControl_DoEnter(s: MenulistS): void {
  s.curvalue++;
  if (s.curvalue >= s.itemnames.length) s.curvalue = 0;

  if (s.generic.callback) s.generic.callback(s);
}

function SpinControl_DoSlide(s: MenulistS, dir: number): void {
  s.curvalue += dir;

  if (s.curvalue < 0) s.curvalue = 0;
  else if (s.curvalue >= s.itemnames.length) s.curvalue--;

  if (s.generic.callback) s.generic.callback(s);
}

function SpinControl_Draw(s: MenulistS): void {
  if (!re) return;
  const parent = parentOf(s.generic);

  if (s.generic.name) {
    Menu_DrawStringR2LDark(s.generic.x + parent.x + LCOLUMN_OFFSET, s.generic.y + parent.y, s.generic.name);
  }

  const current = s.itemnames[s.curvalue] ?? "";
  const nl = current.indexOf("\n");
  if (nl === -1) {
    Menu_DrawString(RCOLUMN_OFFSET + s.generic.x + parent.x, s.generic.y + parent.y, current);
  } else {
    Menu_DrawString(RCOLUMN_OFFSET + s.generic.x + parent.x, s.generic.y + parent.y, current.slice(0, nl));
    Menu_DrawString(RCOLUMN_OFFSET + s.generic.x + parent.x, s.generic.y + parent.y + 10, current.slice(nl + 1));
  }
}
