/*
Test for viewport scrolling in the menu framework (src/client/qmenu.ts's
MenuframeworkS.scrollTop, src/client/qmenu_impl.ts's Menu_ComputeWindow and
the scrolling behavior it drives inside Menu_Draw).

Defect this closes: qmenu had no notion of a menu taller than the screen --
Menu_Draw drew every item regardless of viddef.height, so rows past the
bottom edge were invisible and unreachable at small video modes (the
concrete case is menu.ts's Controllers screen at 320x240/400x300, and the
Keys screen had the same class of bug). Menu_ComputeWindow decides which
item indices are visible; Menu_Draw shifts drawing by the result and draws
'^'/'v' indicator glyphs when rows are hidden above/below.

Self-sufficient per PORTING.md rule 13 and this suite's own precedent
(qmenu_slider_readout.test.ts): fabricates its own MenuframeworkS/items
rather than reaching into any real per-screen menu (menu.ts is NOT
imported here -- at the time this file was written, menu.ts transitively
pulled in src/ctf/g_items.ts, which a concurrent unit had mid-edit and
missing an export, breaking any test that imports menu.ts; this file
sidesteps that entirely by testing the framework directly, which is also
just the right level for pure window-math coverage).
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { setRe } from "../src/client/client";
import { viddef } from "../src/client/vid";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { MenuframeworkS, MenuactionS, MTYPE_ACTION } from "../src/client/qmenu";
import { Menu_AddItem, Menu_Draw, Menu_ComputeWindow, Menu_AdjustCursor } from "../src/client/qmenu_impl";

interface DrawCharCall {
  x: number;
  y: number;
  c: number;
}
interface DrawFillCall {
  x: number;
  y: number;
  w: number;
  h: number;
  c: number;
}

// Full RefExports fake, same convention as qmenu_slider_readout.test.ts's
// makeFakeRe / cgame_draw.test.ts's makeFakeRe.
function makeFakeRe(): RefExports & { drawCharCalls: DrawCharCall[]; drawFillCalls: DrawFillCall[] } {
  const fake = {
    drawCharCalls: [] as DrawCharCall[],
    drawFillCalls: [] as DrawFillCall[],

    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (): ImageS | null => null,
    RegisterRawPic: (): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: (_name: string) => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar(x: number, y: number, c: number) {
      fake.drawCharCalls.push({ x, y, c });
    },
    DrawTileClear: () => undefined,
    DrawFill(x: number, y: number, w: number, h: number, c: number) {
      fake.drawFillCalls.push({ x, y, w, h, c });
    },
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    SetGifBeatSeconds: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return fake;
}

const ARROW_UP = "^".charCodeAt(0);
const ARROW_DOWN = "v".charCodeAt(0);

/** Builds a menu of `n` plain MTYPE_ACTION rows at a constant `rowHeight`
 *  stride starting at y=0, mirroring how every real screen (Controllers,
 *  Keys, Options, ...) lays its items out. */
function buildActionMenu(n: number, rowHeight: number, menuY: number): { menu: MenuframeworkS; items: MenuactionS[] } {
  const menu = new MenuframeworkS();
  menu.x = 100;
  menu.y = menuY;
  const items: MenuactionS[] = [];
  for (let i = 0; i < n; i++) {
    const item = new MenuactionS();
    item.generic.type = MTYPE_ACTION;
    item.generic.name = `row ${i}`;
    item.generic.x = 0;
    item.generic.y = i * rowHeight;
    Menu_AddItem(menu, item);
    items.push(item);
  }
  return { menu, items };
}

const restoreViddef = { width: 0, height: 0 };
beforeEach(() => {
  restoreViddef.width = viddef.width;
  restoreViddef.height = viddef.height;
  setRe(null);
});

function restoreVid() {
  viddef.width = restoreViddef.width;
  viddef.height = restoreViddef.height;
}

describe("Menu_ComputeWindow -- menus that fit render unchanged", () => {
  test("no viddef configured (height 0): never scrolls, whole menu visible", () => {
    viddef.width = 0;
    viddef.height = 0;
    const { menu } = buildActionMenu(5, 10, 0);
    const win = Menu_ComputeWindow(menu);
    expect(win.scrollActive).toBe(false);
    expect(win.firstIndex).toBe(0);
    expect(win.lastIndex).toBe(5);
    expect(win.yOffset).toBe(0);
    expect(win.showUp).toBe(false);
    expect(win.showDown).toBe(false);
    restoreVid();
  });

  test("content shorter than the available space: no scroll, all rows visible", () => {
    viddef.width = 640;
    viddef.height = 480;
    // Controllers-shaped: menu.y = 140, 35 rows * 9px = 315 tall content,
    // available = (480-8)-140 = 332 -- fits with room to spare.
    const { menu } = buildActionMenu(35, 9, 140);
    const win = Menu_ComputeWindow(menu);
    expect(win.scrollActive).toBe(false);
    expect(win.firstIndex).toBe(0);
    expect(win.lastIndex).toBe(35);
    expect(win.yOffset).toBe(0);
    restoreVid();
  });

  test("Menu_Draw draws a fitting menu byte-identical to no-scroll math (pixel-identity guarantee)", () => {
    viddef.width = 640;
    viddef.height = 480;
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, items } = buildActionMenu(4, 10, 50);
    menu.cursor = 1;

    Menu_Draw(menu);

    // Action_Draw for a right-justified (default) action draws its name via
    // Menu_DrawStringR2L at (item.x + parent.x + LCOLUMN_OFFSET, item.y + parent.y).
    // With parent.x=100, LCOLUMN_OFFSET=-16: label anchor x = 100-16 = 84.
    for (let i = 0; i < items.length; i++) {
      const expectedY = menu.y + i * 10;
      const rowChars = fake.drawCharCalls.filter((c) => c.y === expectedY);
      expect(rowChars.length).toBeGreaterThan(0);
    }
    // no indicator glyphs anywhere -- this menu never scrolls
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_UP)).toBe(false);
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_DOWN)).toBe(false);
    // menu.y itself is restored after the draw (temporarily mutated during
    // drawing so custom cursordraw callbacks -- see menu.ts's Keys screen --
    // pick up the same coordinate shift; must never leak past Menu_Draw)
    expect(menu.y).toBe(50);
    restoreVid();
  });
});

describe("Menu_ComputeWindow -- overflowing menus scroll", () => {
  function bigOverflowMenu() {
    viddef.width = 640;
    viddef.height = 240; // small mode, statusbar top = 232
    // 40 rows * 10px = 400px tall content vs. 232px available: overflows.
    return buildActionMenu(40, 10, 0);
  }

  test("initial state: cursor at 0, only the down indicator shows", () => {
    const { menu } = bigOverflowMenu();
    menu.cursor = 0;
    const win = Menu_ComputeWindow(menu);
    expect(win.scrollActive).toBe(true);
    expect(win.firstIndex).toBe(0);
    expect(win.showUp).toBe(false);
    expect(win.showDown).toBe(true);
    expect(win.lastIndex).toBeLessThan(40);
    restoreVid();
  });

  test("every row is reachable by walking the cursor down one at a time, and stays visible", () => {
    const { menu } = bigOverflowMenu();
    const n = menu.nitems;
    for (let i = 0; i < n; i++) {
      menu.cursor = i;
      Menu_AdjustCursor(menu, 1);
      const win = Menu_ComputeWindow(menu);
      expect(win.firstIndex).toBeLessThanOrEqual(menu.cursor);
      expect(menu.cursor).toBeLessThan(win.lastIndex);
    }
    restoreVid();
  });

  test("walking back up from the last row eventually clears the down indicator and re-shows the up indicator only mid-list", () => {
    const { menu } = bigOverflowMenu();
    const n = menu.nitems;
    menu.cursor = n - 1;
    let win = Menu_ComputeWindow(menu);
    expect(win.lastIndex).toBe(n);
    expect(win.showDown).toBe(false);
    expect(win.showUp).toBe(true);

    for (let i = n - 1; i >= 0; i--) {
      menu.cursor = i;
      Menu_AdjustCursor(menu, -1);
      win = Menu_ComputeWindow(menu);
      expect(win.firstIndex).toBeLessThanOrEqual(menu.cursor);
      expect(menu.cursor).toBeLessThan(win.lastIndex);
    }
    // back at row 0: up indicator gone, down indicator back
    expect(win.firstIndex).toBe(0);
    expect(win.showUp).toBe(false);
    expect(win.showDown).toBe(true);
    restoreVid();
  });

  test("scroll position is stable: re-computing the window without moving the cursor doesn't change it", () => {
    const { menu } = bigOverflowMenu();
    menu.cursor = 25;
    const first = Menu_ComputeWindow(menu);
    const second = Menu_ComputeWindow(menu);
    expect(second.firstIndex).toBe(first.firstIndex);
    expect(second.lastIndex).toBe(first.lastIndex);
    restoreVid();
  });

  test("Menu_Draw hides rows outside the window and draws both indicators when scrolled to the middle", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, items } = bigOverflowMenu();
    // contentRows works out to 21 for this menu (see the module comment),
    // so cursor 20 is still the last row of the initial [0,21) window --
    // 25 is comfortably past it, forcing top > 0 with rows left below too.
    menu.cursor = 25;
    Menu_AdjustCursor(menu, 1);

    Menu_Draw(menu);

    const win = Menu_ComputeWindow(menu); // same cursor, same result (stability test above)
    expect(win.showUp).toBe(true);
    expect(win.showDown).toBe(true);

    // rows outside [firstIndex, lastIndex) never got a name drawn
    const visibleNames = new Set(items.slice(win.firstIndex, win.lastIndex).map((it) => it.generic.name));
    const hiddenNames = items.filter((_, i) => i < win.firstIndex || i >= win.lastIndex).map((it) => it.generic.name);

    // Action_Draw draws each char of the name via DrawChar; reconstruct which
    // rows actually produced glyphs by grouping drawn chars by their y.
    // Excludes the indicator glyphs themselves, which legitimately share a y
    // with whatever row would otherwise occupy that reserved slot.
    const drawnYs = new Set(fake.drawCharCalls.filter((c) => c.c !== ARROW_UP && c.c !== ARROW_DOWN).map((c) => c.y));
    for (const it of items.slice(win.firstIndex, win.lastIndex)) {
      const absY = menu.y + win.yOffset + it.generic.y;
      expect(drawnYs.has(absY)).toBe(true);
    }
    for (let i = 0; i < items.length; i++) {
      if (i >= win.firstIndex && i < win.lastIndex) continue;
      const it = items[i];
      if (!it) continue;
      const wouldBeY = menu.y + win.yOffset + it.generic.y;
      // a hidden row's own would-be y must not coincide with any visible
      // row's drawn y (rows are on a strict grid, so this is unambiguous)
      expect(drawnYs.has(wouldBeY)).toBe(false);
    }
    expect(visibleNames.size).toBeGreaterThan(0);
    expect(hiddenNames.length).toBeGreaterThan(0);

    // both indicator glyphs were actually drawn
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_UP)).toBe(true);
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_DOWN)).toBe(true);
    restoreVid();
  });

  test("Menu_Draw at the top of an overflowing list draws only the down indicator", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu } = bigOverflowMenu();
    menu.cursor = 0;

    Menu_Draw(menu);

    expect(fake.drawCharCalls.some((c) => c.c === ARROW_UP)).toBe(false);
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_DOWN)).toBe(true);
    restoreVid();
  });

  test("Menu_Draw at the bottom of an overflowing list draws only the up indicator", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu } = bigOverflowMenu();
    menu.cursor = menu.nitems - 1;

    Menu_Draw(menu);

    expect(fake.drawCharCalls.some((c) => c.c === ARROW_UP)).toBe(true);
    expect(fake.drawCharCalls.some((c) => c.c === ARROW_DOWN)).toBe(false);
    restoreVid();
  });

  test("rebuilding the menu from scratch (nitems reset to 0) resets scroll back to the top", () => {
    const { menu } = bigOverflowMenu();
    menu.cursor = menu.nitems - 1;
    Menu_ComputeWindow(menu); // scrolls to the bottom, sets menu.scrollTop > 0
    expect(menu.scrollTop).toBeGreaterThan(0);

    // simulate a screen rebuild: reset nitems to 0 and re-add the same rows
    const n = menu.nitems;
    menu.nitems = 0;
    for (let i = 0; i < n; i++) {
      const item = new MenuactionS();
      item.generic.type = MTYPE_ACTION;
      item.generic.name = `row ${i}`;
      item.generic.x = 0;
      item.generic.y = i * 10;
      Menu_AddItem(menu, item);
    }

    expect(menu.scrollTop).toBe(0);
    restoreVid();
  });
});

/*
Regression coverage for a real defect this suite's uniform-stride fixtures
above never would have caught: menu.ts's Controllers screen does NOT lay its
items out at a constant stride. Controllers_MenuBuild inserts a blank half
row between each player's block (`y += ROW` with no item added), so most
gaps are one rowHeight but some are two. An earlier version of
Menu_ComputeWindow sized the window by ITEM COUNT (available-pixels /
rowHeight, minus the two reserved indicator rows), which is only correct
when every gap is the same size -- with the double-wide gaps mixed in, that
undercounted the real pixel span of the chosen items and let the last
"visible" row's true y land past the statusbar, off the bottom of the
screen entirely (found live: built the real Controllers screen at 400x300,
scrolled to the last row, and "back" was not on screen at all). The fix
sizes the window by walking actual item.generic.y gaps instead of assuming
a constant stride. This suite mirrors that exact row shape rather than
reaching into menu.ts, per this file's own self-sufficiency rule.
*/
describe("Menu_ComputeWindow -- irregular row spacing (Controllers-shaped menu)", () => {
  const ROW = 9;

  /** n groups of `perGroup` constant-stride rows, with one extra blank ROW
   *  gap before each group after the first -- the exact shape
   *  Controllers_MenuBuild produces per player. */
  function buildGroupedMenu(groups: number, perGroup: number, menuY: number) {
    viddef.width = 400;
    viddef.height = 300;
    const menu = new MenuframeworkS();
    menu.x = 200;
    menu.y = menuY;
    const items: MenuactionS[] = [];
    let y = 0;
    for (let g = 0; g < groups; g++) {
      if (g > 0) y += ROW; // the blank row between groups
      for (let r = 0; r < perGroup; r++) {
        const item = new MenuactionS();
        item.generic.type = MTYPE_ACTION;
        item.generic.name = `g${g}r${r}`;
        item.generic.x = 0;
        item.generic.y = y;
        Menu_AddItem(menu, item);
        items.push(item);
        y += ROW;
      }
    }
    return { menu, items };
  }

  test("every visible row's real drawn y stays on screen, at every cursor position", () => {
    // 4 groups of 6 rows (24 total), menu.y = 50 -- the same shape and
    // placement as the live Controllers screen at 400x300 (gl_mode 1).
    const { menu, items } = buildGroupedMenu(4, 6, 50);
    const n = menu.nitems;
    const statusbarTop = viddef.height - 8;

    for (let c = 0; c < n; c++) {
      menu.cursor = c;
      Menu_AdjustCursor(menu, 1);
      const win = Menu_ComputeWindow(menu);

      expect(win.firstIndex).toBeLessThanOrEqual(menu.cursor);
      expect(menu.cursor).toBeLessThan(win.lastIndex);

      for (let i = win.firstIndex; i < win.lastIndex; i++) {
        const item = items[i];
        if (!item) continue;
        const drawnY = menu.y + win.yOffset + item.generic.y;
        // the defect: a "visible" row's true y landing past the statusbar
        // (or above the menu's own top) -- on screen but unreachable, or
        // scrolled off it entirely, either way not what the player sees as
        // a working row.
        expect(drawnY).toBeGreaterThanOrEqual(menu.y);
        expect(drawnY + 8).toBeLessThanOrEqual(statusbarTop);
      }
    }
    restoreVid();
  });

  test("walking all the way down and back up, the last and first rows are each actually drawn on screen", () => {
    const fake = makeFakeRe();
    setRe(fake);
    const { menu, items } = buildGroupedMenu(4, 6, 50);
    const n = menu.nitems;
    const statusbarTop = viddef.height - 8;

    menu.cursor = n - 1;
    Menu_AdjustCursor(menu, 1);
    Menu_Draw(menu);
    const winAtEnd = Menu_ComputeWindow(menu);
    expect(winAtEnd.lastIndex).toBe(n);
    const lastItem = items[n - 1];
    expect(lastItem).toBeDefined();
    const lastDrawnY = menu.y + winAtEnd.yOffset + (lastItem?.generic.y ?? 0);
    expect(lastDrawnY + 8).toBeLessThanOrEqual(statusbarTop);
    // and it actually produced glyphs at that exact row, not just math that
    // claims it should have
    expect(fake.drawCharCalls.some((c) => c.y === lastDrawnY)).toBe(true);

    menu.cursor = 0;
    Menu_AdjustCursor(menu, -1);
    Menu_Draw(menu);
    const winAtStart = Menu_ComputeWindow(menu);
    expect(winAtStart.firstIndex).toBe(0);
    expect(winAtStart.showUp).toBe(false);
    const firstDrawnY = menu.y + winAtStart.yOffset + (items[0]?.generic.y ?? 0);
    // on screen, at or after the menu's own top (the reserved indicator
    // slot at the very top is always budgeted for, even when -- as here,
    // scrolled all the way up -- there's nothing to show in it)
    expect(firstDrawnY).toBeGreaterThanOrEqual(menu.y);
    expect(fake.drawCharCalls.some((c) => c.y === firstDrawnY)).toBe(true);
    restoreVid();
  });
});
