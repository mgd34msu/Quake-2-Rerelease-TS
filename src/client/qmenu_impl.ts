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

// Viewport-scrolling addition (Mike, 2026-09-02): qmenu has no notion of a
// menu taller than the screen -- Menu_Draw just drew every item, so rows
// past the bottom edge (or, in principle, above the top) were invisible and
// unreachable at small video modes (menu_controllers at 320x240/400x300 is
// the concrete case this fixes; menu.ts's Keys screen had the same class of
// bug). Menu_ComputeWindow below decides, from viddef.height and the menu's
// own y, which item indices fit; Menu_Draw shifts drawing by the result
// (see there) and draws small indicator glyphs when rows are hidden above
// or below.
//
// Indicator glyphs are plain ASCII '^'/'v' via the same DrawChar path as
// everything else in this file, not a dedicated glyph-atlas index: this
// mirrors console_impl.ts's own back-scroll indicator (a row of '^' chars
// drawn with re.DrawChar when the console is scrolled back), and sidesteps
// the exact problem Slider_Draw's DEVIATION comment above already hit --
// the rerelease conchars atlas ships several of the "special" glyph cells
// (128-130) completely empty, so an obscure index picked without checking
// the actual asset can render as nothing. Plain ASCII glyphs are guaranteed
// present (every menu label already renders through them).
const ARROW_UP_CHAR = "^".charCodeAt(0);
const ARROW_DOWN_CHAR = "v".charCodeAt(0);

export interface MenuWindowT {
  /** false when every item already fits between menu.y and the statusbar --
   *  Menu_Draw then draws exactly as it did before this feature existed. */
  scrollActive: boolean;
  /** first visible item index (inclusive). */
  firstIndex: number;
  /** last visible item index (exclusive). */
  lastIndex: number;
  /** more items exist above firstIndex. */
  showUp: boolean;
  /** more items exist at/after lastIndex. */
  showDown: boolean;
  /** the menu's own per-item row stride, in pixels (derived from the items). */
  rowHeight: number;
  /** pixels to add to `menu.y` while drawing rows [firstIndex, lastIndex). */
  yOffset: number;
}

/*
Decides which of a menu's items currently fit on screen.

The available vertical space runs from `menu.y` (unchanged -- this is where
each screen's own title/banner placement already put it, Menu_Center or a
manual assignment) down to 8px above the bottom of the screen (the statusbar
strip Menu_DrawStatusBar always paints there). If every item's row already
lies inside that span, no scrolling happens at all: firstIndex/lastIndex
cover the whole menu and yOffset is 0, so a menu that already fit renders
pixel-identical to the pre-scrolling code.

When the content is taller than the available space, one row at the top and
one at the bottom of the window are reserved for the scroll indicators
(regardless of whether either indicator actually has anything to show, so
the window size doesn't change as the player reaches either end of the
list), and `menu.scrollTop` is nudged just far enough to keep the cursor
item inside the remaining rows -- the same "scroll only when the cursor
would go off the visible edge" behavior every scrollable listbox has.
*/
export function Menu_ComputeWindow(menu: MenuframeworkS): MenuWindowT {
  const n = menu.nitems;
  const DEFAULT_EMPTY: MenuWindowT = { scrollActive: false, firstIndex: 0, lastIndex: n, showUp: false, showDown: false, rowHeight: 10, yOffset: 0 };
  if (n === 0) return DEFAULT_EMPTY;

  // viddef starts at 0x0 before Vid_Init runs (and several qmenu unit tests
  // fabricate a menu without ever touching viddef, same as they did before
  // this feature existed). Height 0 means "no real screen to overflow yet",
  // not "a screen 8 pixels shorter than the statusbar" -- treat it as an
  // unconstrained viewport rather than let a negative `available` force
  // every menu into scroll mode.
  if (VID_HEIGHT() <= 0) return DEFAULT_EMPTY;

  // Row stride: every screen in this codebase lays its items out in
  // increasing-y order with one constant step per row (9 or 10 units
  // depending on the screen -- see menu.ts's Controllers/Keys build code),
  // so the smallest positive gap between consecutive items IS that step.
  let rowHeight = 10;
  let minGap = Infinity;
  for (let i = 1; i < n; i++) {
    const a = menu.items[i - 1];
    const b = menu.items[i];
    if (!a || !b) continue;
    const gap = b.generic.y - a.generic.y;
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (minGap !== Infinity) rowHeight = minGap;

  const firstItem = menu.items[0];
  const lastItem = menu.items[n - 1];
  const topY = firstItem ? firstItem.generic.y : 0;
  const bottomY = (lastItem ? lastItem.generic.y : 0) + rowHeight;

  const statusbarTop = VID_HEIGHT() - 8;
  const available = statusbarTop - menu.y;
  const contentHeight = bottomY - topY;

  if (contentHeight <= available) {
    return { scrollActive: false, firstIndex: 0, lastIndex: n, showUp: false, showDown: false, rowHeight, yOffset: 0 };
  }

  // Pixel budget for content rows, after reserving one rowHeight-tall slot
  // at each end for the indicator glyphs (see the top-of-file comment).
  // Deliberately NOT "how many rows of a constant height fit": real menus
  // are not evenly spaced -- Controllers_MenuBuild (menu.ts) inserts a
  // half-row gap between each player's block, so a row-COUNT budget can
  // compute a window whose last item's real y falls past the screen edge.
  // Everything below sizes the window by actual pixel span instead.
  const budget = Math.max(rowHeight, available - 2 * rowHeight);

  // Grows forward from `start`, including as many items as fit in `budget`
  // pixels measured from item[start]'s own y (so item[start] always shows).
  const forwardEnd = (start: number): number => {
    const item0 = menu.items[start];
    const startY = item0 ? item0.generic.y : 0;
    let end = start;
    while (end < n) {
      const item = menu.items[end];
      const span = (item ? item.generic.y : 0) - startY + rowHeight;
      if (span > budget) break;
      end++;
    }
    return Math.max(end, start + 1);
  };

  // Grows backward from `endExclusive - 1`, the mirror of forwardEnd: as
  // many items as fit in `budget` pixels ending at that last item.
  const backwardStart = (endExclusive: number): number => {
    const lastItemAt = menu.items[endExclusive - 1];
    const lastY = lastItemAt ? lastItemAt.generic.y : 0;
    let start = endExclusive - 1;
    while (start > 0) {
      const candidate = menu.items[start - 1];
      const span = lastY - (candidate ? candidate.generic.y : 0) + rowHeight;
      if (span > budget) break;
      start--;
    }
    return start;
  };

  let top = Math.max(0, Math.min(menu.scrollTop, n - 1));
  let lastIndex = forwardEnd(top);

  if (menu.cursor >= 0 && menu.cursor < n) {
    if (menu.cursor < top) {
      // cursor moved above the window: scroll up just enough to lead with it
      top = menu.cursor;
      lastIndex = forwardEnd(top);
    } else if (menu.cursor >= lastIndex) {
      // cursor moved below the window: scroll down just enough to trail it
      lastIndex = menu.cursor + 1;
      top = backwardStart(lastIndex);
    }
  }

  top = Math.max(0, Math.min(top, n - 1));
  lastIndex = Math.max(top + 1, Math.min(lastIndex, n));
  menu.scrollTop = top;

  const firstVisible = menu.items[top];
  const yOffset = rowHeight - (firstVisible ? firstVisible.generic.y : topY);

  return {
    scrollActive: true,
    firstIndex: top,
    lastIndex,
    showUp: top > 0,
    showDown: lastIndex < n,
    rowHeight,
    yOffset,
  };
}

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
  if (menu.nitems === 0) {
    menu.nslots = 0;
    // Viewport-scrolling addition: a screen rebuild (nitems reset to 0, then
    // re-populated) starts back at the top of the list, same lifecycle as
    // nslots above -- see MenuframeworkS.scrollTop in qmenu.ts.
    menu.scrollTop = 0;
  }

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

// Keeps a centered menu body clear of the banner pic drawn above it. Vanilla
// hand-placed every menu's y against its banner; the tall custom screens
// this port added (Video, with its extra rows) are centered by Menu_Center
// instead, and at 640x480 that put the first rows up inside the banner
// (Mike's 2026-09-02 play-test screenshot: "driver" drawn over the VIDEO
// banner). `bannerBottom` is the banner's bottom edge in viddef coordinates.
export function Menu_KeepBelow(menu: MenuframeworkS, bannerBottom: number): void {
  const clearance = 8;
  if (menu.y < bannerBottom + clearance) menu.y = bannerBottom + clearance;
}

export function Menu_Draw(menu: MenuframeworkS): void {
  const win = Menu_ComputeWindow(menu);
  const originalY = menu.y;

  // Shift the whole coordinate system the item-draw functions read (they
  // all compute their y as `item.generic.y + parentOf(item.generic).y`, and
  // the fallback cursor arrow and any per-menu `cursordraw` callback below
  // read `menu.y` the same way -- e.g. menu.ts's Keys screen cursordraw)
  // by mutating `menu.y` for the duration of this draw and restoring it
  // before returning. When the menu fits (win.scrollActive is false),
  // win.yOffset is 0 and this is a no-op: byte-identical to the
  // pre-scrolling behavior.
  menu.y = originalY + win.yOffset;

  // draw contents -- only the rows the window currently shows
  for (let i = win.firstIndex; i < win.lastIndex; i++) {
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

  if (win.scrollActive) {
    // Fixed slots relative to the screen, not the item list: the up
    // indicator sits at the menu's own (unshifted) top, the down indicator
    // one rowHeight above the statusbar strip. Both stay put regardless of
    // scroll position -- the window itself never resizes as the player
    // reaches either end of the list. (Not derived from how many items are
    // currently visible: Controllers_MenuBuild's irregular row spacing --
    // a half-row gap between each player's block -- means item count and
    // pixel span don't correspond 1:1; see Menu_ComputeWindow above.)
    if (win.showUp) DrawChar(menu.x - 4, originalY, ARROW_UP_CHAR);
    if (win.showDown) DrawChar(menu.x - 4, VID_HEIGHT() - 8 - win.rowHeight, ARROW_DOWN_CHAR);
  }

  menu.y = originalY;

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

// Where a slider row's value readout goes: past the track, clear of the
// thumb. The readout was added 2026-09-01 (Slider_Draw's valueFormatter);
// long strings like "1.00x (native)" and "high (picmip 0)" need this
// clearance. Spin-control rows keep vanilla's RCOLUMN_OFFSET: the controls
// of every row start at the same column, and only a slider's readout
// extends further right.
const VALUE_COLUMN_OFFSET = RCOLUMN_OFFSET + (SLIDER_RANGE + 2) * 8 + 8;

function Slider_Draw(s: MenusliderS): void {
  if (!re) return;
  const parent = parentOf(s.generic);

  Menu_DrawStringR2LDark(s.generic.x + parent.x + LCOLUMN_OFFSET, s.generic.y + parent.y, s.generic.name ?? "");

  s.range = (s.curvalue - s.minvalue) / (s.maxvalue - s.minvalue);

  if (s.range < 0) s.range = 0;
  if (s.range > 1) s.range = 1;

  // DEVIATION from the C's char-based track (chars 128/129/130 = left cap/
  // body/right cap): the rerelease charset (pics/conchars.png in the retail
  // pak) ships those three cells completely EMPTY -- the KEX UI never used
  // character sliders -- so on rerelease data the track was invisible and
  // only the thumb (char 131, present in both charsets) floated in space
  // (found live on Mike's RC pass; q2repro sidesteps this by shipping its
  // own charset assets). The track is now a filled groove spanning the same
  // extent the chars covered, uniform across both data sets; the thumb
  // stays char 131 for the classic look.
  const trackX = s.generic.x + parent.x + RCOLUMN_OFFSET;
  const trackY = s.generic.y + parent.y;
  const trackW = (SLIDER_RANGE + 2) * 8;
  re.DrawFill(trackX + 2, trackY + 3, trackW - 4, 2, 4); // groove (dark gray)
  re.DrawFill(trackX + 2, trackY + 2, 1, 4, 4); // left end cap
  re.DrawFill(trackX + trackW - 3, trackY + 2, 1, 4, 4); // right end cap
  DrawChar(8 + RCOLUMN_OFFSET + parent.x + s.generic.x + (SLIDER_RANGE - 1) * 8 * s.range, s.generic.y + parent.y, 131);

  // QoL addition (Mike, 2026-09-01): live value readout just past the
  // track, same row -- see MenusliderS.valueFormatter in qmenu.ts. Shares
  // VALUE_COLUMN_OFFSET with SpinControl_Draw below (see that constant's
  // comment); trackX + trackW + 8 -- the track's own actual right edge --
  // is numerically identical (trackX = x + parent.x + RCOLUMN_OFFSET) but
  // is spelled out via the shared constant here for a spin row's value to
  // land on the exact same column with no separate offset to keep in sync.
  if (s.valueFormatter) {
    Menu_DrawString(s.generic.x + parent.x + VALUE_COLUMN_OFFSET, trackY, s.valueFormatter(s.curvalue));
  }
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

  // Vanilla's column: the value right after the label. A slider row's
  // readout sits past its track instead (VALUE_COLUMN_OFFSET) -- the two
  // were once forced onto one shared column, which left every spin row's
  // value floating 120 pixels out with an empty gap (Mike's 2026-09-02
  // play-test screenshots of the New Game, Video and Options screens).
  const valueX = RCOLUMN_OFFSET + s.generic.x + parent.x;
  const current = s.itemnames[s.curvalue] ?? "";
  const nl = current.indexOf("\n");
  if (nl === -1) {
    Menu_DrawString(valueX, s.generic.y + parent.y, current);
  } else {
    Menu_DrawString(valueX, s.generic.y + parent.y, current.slice(0, nl));
    Menu_DrawString(valueX, s.generic.y + parent.y + 10, current.slice(nl + 1));
  }
}
