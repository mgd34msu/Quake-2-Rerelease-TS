/*
Test for src/client/menu.ts and src/client/qmenu_impl.ts.

Self-sufficient per PORTING.md rule 13: no global boot is required for this
module (menu.ts's own module-level statics are all it touches), so each
test just resets the menu stack via M_ForceMenuOff() and fabricates its own
MenuframeworkS/widget objects rather than reaching into menu.ts's private
per-screen menus.

Covers:
  - M_PushMenu/M_PopMenu stack depth (including the "already on the stack,
    drop back" collapse) and that M_Draw dispatches to whichever draw
    function is currently on top.
  - Menu_AdjustCursor skipping separators.
  - Menu_SlideItem/Slider_DoSlide clamping to [minvalue, maxvalue].
  - M_Menu_Main_f pushing the main menu and setting cls.key_dest.
  - M_Keydown routing a keypress to the active menu's key function.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { cls, cl, KeydestT, setRe } from "../src/client/client";
import { M_PushMenu, M_PopMenu, M_ForceMenuOff, M_Draw, M_Keydown, M_Menu_Main_f } from "../src/client/menu";
import { MenuframeworkS, MenuactionS, MenuseparatorS, MenusliderS, MTYPE_ACTION, MTYPE_SEPARATOR, MTYPE_SLIDER } from "../src/client/qmenu";
import { Menu_AddItem, Menu_AdjustCursor, Menu_SlideItem, Menu_ItemAtCursor } from "../src/client/qmenu_impl";
import { API_VERSION, type RefExports } from "../src/client/ref";

beforeEach(() => {
  M_ForceMenuOff();
});

describe("M_PushMenu / M_PopMenu stack", () => {
  test("push sets key_dest to key_menu and drives M_Draw to the pushed draw function", () => {
    let drawCalls = 0;
    const draw = () => {
      drawCalls++;
    };
    const key = (_k: number): string | null => null;

    M_PushMenu(draw, key);
    expect(cls.key_dest).toBe(KeydestT.key_menu);

    M_Draw();
    expect(drawCalls).toBe(1);
  });

  test("stacking two menus: M_Draw follows the top of the stack, M_PopMenu restores the layer below", () => {
    let aCalls = 0;
    let bCalls = 0;
    const drawA = () => {
      aCalls++;
    };
    const drawB = () => {
      bCalls++;
    };
    const keyA = (): string | null => null;
    const keyB = (): string | null => null;

    M_PushMenu(drawA, keyA);
    M_PushMenu(drawB, keyB);

    M_Draw();
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);

    M_PopMenu();
    expect(cls.key_dest).toBe(KeydestT.key_menu); // one layer (A) still active

    M_Draw();
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    M_PopMenu();
    expect(cls.key_dest).toBe(KeydestT.key_game); // last layer popped -> M_ForceMenuOff

    M_Draw();
    expect(aCalls).toBe(1); // key_dest != key_menu, M_Draw is a no-op now
    expect(bCalls).toBe(1);
  });

  test("re-pushing a menu already on the stack drops back to that level instead of stacking a duplicate", () => {
    const drawA = (): void => undefined;
    const drawB = (): void => undefined;
    const drawC = (): void => undefined;
    const keyA = (): string | null => null;
    const keyB = (): string | null => null;
    const keyC = (): string | null => null;

    M_PushMenu(drawA, keyA);
    M_PushMenu(drawB, keyB);
    M_PushMenu(drawC, keyC);

    // re-push A: C and B's stack entries collapse away
    M_PushMenu(drawA, keyA);

    // a single pop should now return straight to the game, since A was
    // sitting at depth 1 (not 3) once the duplicate push collapsed the stack
    M_PopMenu();
    expect(cls.key_dest).toBe(KeydestT.key_game);
  });

  test("M_Menu_Main_f pushes the main menu and sets key_dest to key_menu", () => {
    M_Menu_Main_f();
    expect(cls.key_dest).toBe(KeydestT.key_menu);
  });
});

describe("M_Keydown routing", () => {
  test("routes a keypress to the active menu's key function with the exact keynum", () => {
    const seenKeyRec: { v: number | null } = { v: null };
    const draw = (): void => undefined;
    const key = (k: number): string | null => {
      seenKeyRec.v = k;
      return null;
    };

    M_PushMenu(draw, key);
    M_Keydown(27); // K_ESCAPE's numeric value, arbitrary here -- just a keynum

    expect(seenKeyRec.v).toBe(27);
  });

  test("does nothing when no menu is active (m_keyfunc unset)", () => {
    // M_ForceMenuOff (beforeEach) already cleared m_keyfunc; this must not throw
    expect(() => M_Keydown(27)).not.toThrow();
  });
});

describe("Menu_AdjustCursor", () => {
  function fabricateMenu(): MenuframeworkS {
    const m = new MenuframeworkS();
    const sep1 = new MenuseparatorS();
    sep1.generic.type = MTYPE_SEPARATOR;
    const action1 = new MenuactionS();
    action1.generic.type = MTYPE_ACTION;
    const sep2 = new MenuseparatorS();
    sep2.generic.type = MTYPE_SEPARATOR;
    const action2 = new MenuactionS();
    action2.generic.type = MTYPE_ACTION;

    Menu_AddItem(m, sep1); // index 0
    Menu_AddItem(m, action1); // index 1
    Menu_AddItem(m, sep2); // index 2
    Menu_AddItem(m, action2); // index 3
    return m;
  }

  test("crawls forward past a separator to the next real item", () => {
    const m = fabricateMenu();
    m.cursor = 0; // sitting on the separator at index 0

    Menu_AdjustCursor(m, 1);

    expect(m.cursor).toBe(1);
    expect(Menu_ItemAtCursor(m)?.generic.type).toBe(MTYPE_ACTION);
  });

  test("crawls backward past a separator to the previous real item", () => {
    const m = fabricateMenu();
    m.cursor = 2; // sitting on the separator at index 2

    Menu_AdjustCursor(m, -1);

    expect(m.cursor).toBe(1);
    expect(Menu_ItemAtCursor(m)?.generic.type).toBe(MTYPE_ACTION);
  });

  test("leaves the cursor alone when it is already on a real item", () => {
    const m = fabricateMenu();
    m.cursor = 3;

    Menu_AdjustCursor(m, 1);

    expect(m.cursor).toBe(3);
  });
});

describe("Slider DoSlide clamping (via Menu_SlideItem)", () => {
  function fabricateSliderMenu(min: number, max: number, start: number): { m: MenuframeworkS; slider: MenusliderS } {
    const m = new MenuframeworkS();
    const slider = new MenusliderS();
    slider.generic.type = MTYPE_SLIDER;
    slider.minvalue = min;
    slider.maxvalue = max;
    slider.curvalue = start;
    Menu_AddItem(m, slider);
    m.cursor = 0;
    return { m, slider };
  }

  test("clamps to maxvalue when sliding past the top", () => {
    const { m, slider } = fabricateSliderMenu(0, 10, 9);

    Menu_SlideItem(m, 1);
    expect(slider.curvalue).toBe(10);

    Menu_SlideItem(m, 1); // sliding further must not exceed maxvalue
    expect(slider.curvalue).toBe(10);
  });

  test("clamps to minvalue when sliding past the bottom", () => {
    const { m, slider } = fabricateSliderMenu(0, 10, 1);

    Menu_SlideItem(m, -1);
    expect(slider.curvalue).toBe(0);

    Menu_SlideItem(m, -1); // sliding further must not go below minvalue
    expect(slider.curvalue).toBe(0);
  });

  test("invokes the slider's callback with the clamped value", () => {
    const { m, slider } = fabricateSliderMenu(0, 5, 4);
    const seenRec: { v: number | null } = { v: null };
    slider.generic.callback = () => {
      seenRec.v = slider.curvalue;
    };

    Menu_SlideItem(m, 3); // 4 + 3 = 7, clamps to 5

    expect(slider.curvalue).toBe(5);
    expect(seenRec.v).toBe(5);
  });
});

// M_Draw's backdrop: q2repro (src/client/ui/menu.c Menu_Draw, ~line 2312)
// always draws a full-menu-rect background -- either menu->image or an
// opaque R_DrawFill32(menu->color) -- before any of the menu's own items,
// and q2pro.menu's "background black" (src/client/ui/q2pro.menu:59) is the
// default color every menu without its own background inherits (so the
// live console dump behind the menu never bleeds through: it's drawn under
// an opaque fill first). menu.ts:3098-3104's M_Draw is this port's
// equivalent -- it calls re.DrawFadeScreen() (a translucent black quad;
// re.DrawFill(...,0) during a cinematic) before m_drawfunc(), same
// before-content ordering. No prior test exercised this (re is never set in
// cl_menu.test.ts's other cases, so the `if (re)` branch was a no-op); these
// pin the ordering with a fake RefExports that records call order.
describe("M_Draw's backdrop is drawn before the menu's own content", () => {
  function fakeRe(calls: string[]): RefExports {
    return {
      api_version: API_VERSION,
      Init: () => true,
      Shutdown: () => {},
      BeginRegistration: () => {},
      RegisterModel: () => null,
      RegisterSkin: () => null,
      RegisterPic: () => null,
      SetSky: () => {},
      EndRegistration: () => {},
      RenderFrame: () => {},
      SupportsPerPixelLighting: () => false,
      DrawGetPicSize: () => ({ w: 0, h: 0 }),
      DrawPic: () => {},
      DrawStretchPic: () => {},
      DrawColorPic: () => {},
      DrawStretchPicRegion: () => {},
      DrawChar: () => {},
      DrawTileClear: () => {},
      DrawFill: () => {
        calls.push("DrawFill");
      },
      DrawFadeScreen: () => {
        calls.push("DrawFadeScreen");
      },
      DrawStretchRaw: () => {},
      CinematicSetPalette: () => {},
      BeginFrame: () => {},
      EndFrame: () => {},
      AppActivate: () => {},
    };
  }

  // Each test resets `re` to null and pops the menu stack in a `finally`,
  // so a thrown assertion can't leak state into later tests in this file.

  test("normal case: DrawFadeScreen fires before the pushed menu's draw function", () => {
    const calls: string[] = [];
    setRe(fakeRe(calls));
    cl.cinematictime = 0;
    try {
      M_PushMenu(
        () => calls.push("menu-draw"),
        () => null,
      );
      M_Draw();
      expect(calls).toEqual(["DrawFadeScreen", "menu-draw"]);
    } finally {
      setRe(null);
      M_ForceMenuOff();
    }
  });

  test("during a cinematic: an opaque DrawFill(...,0) replaces DrawFadeScreen, still before the menu's draw function", () => {
    const calls: string[] = [];
    setRe(fakeRe(calls));
    cl.cinematictime = 1234;
    try {
      M_PushMenu(
        () => calls.push("menu-draw"),
        () => null,
      );
      M_Draw();
      expect(calls).toEqual(["DrawFill", "menu-draw"]);
    } finally {
      setRe(null);
      cl.cinematictime = 0;
      M_ForceMenuOff();
    }
  });

  test("no menu active: M_Draw is a no-op and never touches the backdrop", () => {
    const calls: string[] = [];
    setRe(fakeRe(calls));
    M_ForceMenuOff(); // key_dest -> key_game
    try {
      M_Draw();
      expect(calls).toEqual([]);
    } finally {
      setRe(null);
    }
  });
});
