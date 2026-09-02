/*
LOCAL SPLITSCREEN UNDER THE CLASSIC RULESET -- the classic cgame's HUD pane.

Companion to test/splitscreen_seats.test.ts, which pins the same property for
the KEX cgame's side of the seam (hud_vrect / hud_safe / per-seat scale, its
"per-seat HUD geometry" block). This file pins the CLASSIC cgame's side: that
cgame's DrawHUD used to accept `seat` and ignore it -- matching q2repro's
CGC_DrawHUD, whose own comment is "Note: isplit is ignored, due to missing
split screen support" -- so a split under the classic ruleset drew N 3D panes
underneath ONE full-screen status bar, and the New Game seat row was gated to
the kex ruleset because of it. Mike's v1.1.0 ruling removed that gate ("it's
all the same engine now, why would we not be able to play with the legacy
ruleset in split screen?"), so the rect has to be honored for real.

WHAT IS PINNED HERE
  1. Every anchor token the layout interpreter has (xl/xr/xv/yt/yb/yv, plus
     the `client`/`ctf` blocks that compute their own xv/yv) resolves against
     the SEAT'S pane rather than the display.
  2. Bottom-anchored elements -- the whole v3.19 status bar is bottom
     anchored -- land at the bottom of their OWN pane. This is the classic
     mirror of the kex-side defect splitscreen_seats.test.ts already pins:
     the pane origin is ADDED to a coordinate, never subtracted as though it
     were a safe-area inset.
  3. The scrolling inventory overlay centers in the pane.
  4. The single-viewport path is UNCHANGED: with no seat, every draw call is
     byte-identical to the same call against a full-screen pane, which is the
     arithmetic the code had before the parameter existed.

Self-sufficient per .orch/preferences.md rule 13: no retail data, no
renderer, no server. The classic cgame is driven directly with a capturing
CgameImports, and every global it reads (viddef, cls.state,
cl.refresh_prepped) is installed in beforeEach and restored in afterEach.
The layout fixtures deliberately use only tokens that draw through the
IMPORT SURFACE (picn / hnum / num / the inventory), never the
console_impl.ts DrawString path ("string"/"client"/"ctf" text), so no
RefExports has to exist for this suite to run.
*/

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import { GetClassicCgameAPI } from "../src/client/cgame/classic";
import { buildCgameImports, CG_SetActiveCgameKind, type CgameImports, type CgameSeatT, type ClassicHudDataT } from "../src/client/cgame/host";
import { fullScreenHudPane } from "../src/client/cgame/classic_hud";
import { SplitscreenLayout, SPLIT_LAYOUT_AUTO, SPLIT_LAYOUT_SIDE_BY_SIDE, CL_Seats_SetActiveForTests, CL_Seats_Viewports } from "../src/client/cl_seats";
import { SCR_Init, SCR_CenterPrint, SCR_CheckDrawCenterString, SCR_ClearCenterPrint } from "../src/client/cl_scrn";
import { viddef } from "../src/client/vid";
import { cl, cls, ConnstateT, setRe } from "../src/client/client";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";
import { PlayerStateT, STAT_HEALTH, STAT_LAYOUTS, STAT_SELECTED_ITEM, MAX_ITEMS, CS_STATUSBAR } from "../src/shared/q_shared";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface PicDraw {
  x: number;
  y: number;
  name: string;
}
interface CharDraw {
  x: number;
  y: number;
  num: number;
}

interface Capture {
  imports: CgameImports;
  pics: PicDraw[];
  chars: CharDraw[];
}

/* The real import surface with only the members this suite observes swapped
   for capturing ones -- the same "wrap the real thing, don't stand in for it"
   shape test/cgame_host.test.ts uses for CG_DrawHUD dispatch. Everything the
   layout interpreter calls that is NOT swapped (CL_ServerFrame, etc.) keeps
   its real implementation. */
function makeCapture(statusbar: string): Capture {
  const pics: PicDraw[] = [];
  const chars: CharDraw[] = [];
  const base = buildCgameImports();
  const imports: CgameImports = {
    ...base,
    CL_FrameValid: () => true,
    get_configstring: (index: number) => (index === CS_STATUSBAR ? statusbar : `cs${index}`),
    CL_GetKeyBinding: () => "k",
    // Captured at Draw_PicScaled/Draw_CharScaled, the two members
    // classic_hud.ts's hudPic/hudChar actually call now that the classic
    // layout program carries a HUD scale (see that file's SCALE TERM note).
    // x/y here are REAL pixels -- the scale has already been applied -- which
    // is the space every assertion below is written in.
    Draw_PicScaled: (x: number, y: number, _scale: number, name: string) => {
      pics.push({ x, y, name });
    },
    Draw_CharScaled: (x: number, y: number, _scale: number, num: number) => {
      chars.push({ x, y, num });
    },
    Com_Print: () => {},
  };
  return { imports, pics, chars };
}

function makePlayerState(layoutBits: number): PlayerStateT {
  const ps = new PlayerStateT();
  ps.stats[STAT_HEALTH] = 100;
  ps.stats[STAT_LAYOUTS] = layoutBits;
  ps.stats[STAT_SELECTED_ITEM] = 0;
  return ps;
}

function emptyData(): ClassicHudDataT {
  return { layout: "", inventory: new Int32Array(MAX_ITEMS) };
}

function seatFrom(isplit: number, r: { x: number; y: number; width: number; height: number }): CgameSeatT {
  return { isplit, x: r.x, y: r.y, width: r.width, height: r.height };
}

/** Every anchor the interpreter has, one uniquely-named pic per anchor. */
const ANCHOR_LAYOUT = ["xl 8 yt 12 picn topleft", "xr -40 yb -30 picn bottomright", "xv 0 yv 0 picn centered", "xl 0 yt 0 picn origin"].join(" ");

function picNamed(pics: PicDraw[], name: string): PicDraw {
  const hit = pics.find((p) => p.name === name);
  if (!hit) throw new Error(`no pic named ${name} was drawn (got: ${pics.map((p) => p.name).join(", ")})`);
  return hit;
}

// ---------------------------------------------------------------------------

describe("classic cgame HUD pane -- anchors resolve against the seat, not the display", () => {
  let savedWidth = 0;
  let savedHeight = 0;
  let savedState = ConnstateT.ca_uninitialized;
  let savedPrepped = false;

  beforeEach(() => {
    savedWidth = viddef.width;
    savedHeight = viddef.height;
    savedState = cls.state;
    savedPrepped = cl.refresh_prepped;
    viddef.width = 1280;
    viddef.height = 960;
  });

  afterEach(() => {
    viddef.width = savedWidth;
    viddef.height = savedHeight;
    cls.state = savedState;
    cl.refresh_prepped = savedPrepped;
  });

  test("fullScreenHudPane is the whole display -- the rect the single-viewport path has always implicitly used", () => {
    expect(fullScreenHudPane()).toEqual({ x: 0, y: 0, width: 1280, height: 960 });
  });

  test("with NO seat at a sub-720p render size, every anchor lands exactly where the pre-splitscreen arithmetic put it", () => {
    // 640x480 is below the auto HUD-scale tier's 720p threshold, so the scale
    // is 1 and this is the LITERAL pre-scale, pre-pane arithmetic: viddef.width
    // + n, trunc(viddef.width / 2) - 160 + n, etc. Pinned at this size on
    // purpose -- it is the identity case classic_hud.ts's SCALE TERM note
    // promises, and the reason a 640x480 (or 1280x960-at-vid_scale-0.5)
    // session is byte-for-byte unchanged by the scale term.
    viddef.width = 640;
    viddef.height = 480;
    const cap = makeCapture(ANCHOR_LAYOUT);
    GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData());

    expect(picNamed(cap.pics, "topleft")).toEqual({ x: 8, y: 12, name: "topleft" });
    expect(picNamed(cap.pics, "bottomright")).toEqual({ x: 640 - 40, y: 480 - 30, name: "bottomright" });
    expect(picNamed(cap.pics, "centered")).toEqual({ x: 640 / 2 - 160, y: 480 / 2 - 120, name: "centered" });
    expect(picNamed(cap.pics, "origin")).toEqual({ x: 0, y: 0, name: "origin" });
  });

  test("with NO seat at 1280x960, every anchor is the same expression against the PRE-SCALE pane, times the 2x tier", () => {
    // The same four anchors, at a display size whose auto tier is 2. The pane
    // handed to the layout program is 1280/2 x 960/2, and every coordinate is
    // multiplied on the way out -- so an `xr -40` element sits 40 VIRTUAL
    // units (80 real pixels) in from the right edge, and the 320x240 island
    // covers twice the screen it used to. That is the whole fix: at this size
    // the kex cgame has always drawn its HUD at 2x and the classic one drew at
    // 1x.
    const cap = makeCapture(ANCHOR_LAYOUT);
    GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData());

    expect(picNamed(cap.pics, "topleft")).toEqual({ x: 8 * 2, y: 12 * 2, name: "topleft" });
    expect(picNamed(cap.pics, "bottomright")).toEqual({ x: (640 - 40) * 2, y: (480 - 30) * 2, name: "bottomright" });
    expect(picNamed(cap.pics, "centered")).toEqual({ x: (640 / 2 - 160) * 2, y: (480 / 2 - 120) * 2, name: "centered" });
    expect(picNamed(cap.pics, "origin")).toEqual({ x: 0, y: 0, name: "origin" });
  });

  test("passing the full-screen rect as a seat is indistinguishable from passing no seat at all", () => {
    const ps = makePlayerState(0);

    const noSeat = makeCapture(ANCHOR_LAYOUT);
    GetClassicCgameAPI(noSeat.imports).DrawHUD(0, ps, emptyData());

    const wholeScreenSeat = makeCapture(ANCHOR_LAYOUT);
    GetClassicCgameAPI(wholeScreenSeat.imports).DrawHUD(0, ps, emptyData(), seatFrom(0, { x: 0, y: 0, width: 1280, height: 960 }));

    expect(wholeScreenSeat.pics).toEqual(noSeat.pics);
    expect(wholeScreenSeat.chars).toEqual(noSeat.chars);
  });

  test("a seat's anchors are its pane's: the bottom-right quadrant draws in the bottom-right quadrant", () => {
    const pane = { x: 640, y: 480, width: 640, height: 480 };
    const cap = makeCapture(ANCHOR_LAYOUT);
    GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData(), seatFrom(3, pane));

    expect(picNamed(cap.pics, "topleft")).toEqual({ x: 640 + 8, y: 480 + 12, name: "topleft" });
    expect(picNamed(cap.pics, "bottomright")).toEqual({ x: 640 + 640 - 40, y: 480 + 480 - 30, name: "bottomright" });
    expect(picNamed(cap.pics, "centered")).toEqual({ x: 640 + 320 - 160, y: 480 + 240 - 120, name: "centered" });
    // An unanchored draw starts at the top-left of the PANE, not of the screen.
    expect(picNamed(cap.pics, "origin")).toEqual({ x: 640, y: 480, name: "origin" });
  });

  test("the pane origin is ADDED, never subtracted as a safe-area inset -- the classic mirror of the kex hud_safe defect", () => {
    // The kex path once passed a seat's rect where cg_screen.ts expected an
    // INSET, which subtracted the pane's y from every bottom-anchored
    // position and displaced it a whole pane upward (splitscreen_seats
    // .test.ts pins that arithmetic). Nothing in this file may do the same:
    // for a bottom pane, a bottom-anchored element must be BELOW the pane's
    // top edge, not above it.
    const bottomPane = { x: 0, y: 480, width: 1280, height: 480 };
    const cap = makeCapture("xl 8 yb -32 picn ammo");
    GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData(), seatFrom(1, bottomPane));

    const ammo = picNamed(cap.pics, "ammo");
    expect(ammo.y).toBe(480 + 480 - 32);
    expect(ammo.y).toBeGreaterThan(bottomPane.y);
    expect(ammo.y).toBeLessThan(bottomPane.y + bottomPane.height);
    // The displacement the defect produced, spelled out so it cannot return.
    expect(ammo.y).not.toBe(bottomPane.height - 32);
  });

  test("the real v3.19 status bar shape (yb-anchored health/ammo/armor) lands along each pane's own bottom edge, in every pane of a 4-way split", () => {
    // The shape baseq2's CS_STATUSBAR actually carries: three yb-anchored
    // number fields across the bottom. `hnum` routes through SCR_DrawField,
    // which draws its digits with Draw_Pic, so this exercises the same
    // production path a live frame does.
    const statusbar = "yb -24 xv 0 hnum xv 100 num 3 0 xv 200 num 3 0";
    const seats = SplitscreenLayout(4, 1280, 960, SPLIT_LAYOUT_AUTO);
    expect(seats.length).toBe(4);

    for (let i = 0; i < seats.length; i++) {
      const pane = seats[i]!;
      const cap = makeCapture(statusbar);
      GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData(), seatFrom(i, pane));

      expect(cap.pics.length).toBeGreaterThan(0);
      for (const pic of cap.pics) {
        // Inside its own pane horizontally and vertically...
        expect(pic.x).toBeGreaterThanOrEqual(pane.x);
        expect(pic.x).toBeLessThan(pane.x + pane.width);
        expect(pic.y).toBeGreaterThanOrEqual(pane.y);
        expect(pic.y).toBeLessThan(pane.y + pane.height);
        // ...and in its bottom quarter, which is where a status bar belongs.
        expect(pic.y).toBeGreaterThan(pane.y + pane.height * 0.75);
      }
    }
  });

  test("two side-by-side seats draw the same status bar into disjoint halves -- neither pane's HUD reaches into the other", () => {
    const statusbar = "yb -24 xv 0 hnum";
    const seats = SplitscreenLayout(2, 1280, 960, SPLIT_LAYOUT_SIDE_BY_SIDE);

    const left = makeCapture(statusbar);
    GetClassicCgameAPI(left.imports).DrawHUD(0, makePlayerState(0), emptyData(), seatFrom(0, seats[0]!));
    const right = makeCapture(statusbar);
    GetClassicCgameAPI(right.imports).DrawHUD(1, makePlayerState(0), emptyData(), seatFrom(1, seats[1]!));

    expect(left.pics.length).toBeGreaterThan(0);
    expect(left.pics.length).toBe(right.pics.length);

    const leftMaxX = Math.max(...left.pics.map((p) => p.x));
    const rightMinX = Math.min(...right.pics.map((p) => p.x));
    expect(leftMaxX).toBeLessThan(seats[1]!.x);
    expect(rightMinX).toBeGreaterThanOrEqual(seats[1]!.x);

    // Same layout, same offsets: the right pane's HUD is the left pane's
    // translated by exactly the pane origin, nothing else.
    const dx = seats[1]!.x - seats[0]!.x;
    for (let i = 0; i < left.pics.length; i++) {
      expect(right.pics[i]!.x).toBe(left.pics[i]!.x + dx);
      expect(right.pics[i]!.y).toBe(left.pics[i]!.y);
    }
  });

  test("the layout string (STAT_LAYOUTS bit 0) honors the pane too, not just the status bar", () => {
    const pane = { x: 640, y: 0, width: 640, height: 960 };
    const cap = makeCapture(""); // empty status bar; only the layout draws
    const data: ClassicHudDataT = { layout: "xv 0 yv 0 picn scoreboard", inventory: new Int32Array(MAX_ITEMS) };
    GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(1), data, seatFrom(1, pane));

    expect(picNamed(cap.pics, "scoreboard")).toEqual({ x: 640 + 320 - 160, y: 480 - 120, name: "scoreboard" });
  });

  test("the inventory overlay (STAT_LAYOUTS bit 1) centers its 256x240 panel in the pane", () => {
    const pane = { x: 0, y: 480, width: 640, height: 480 };
    const cap = makeCapture("");
    const inventory = new Int32Array(MAX_ITEMS);
    inventory[0] = 1;
    const ps = makePlayerState(2);
    GetClassicCgameAPI(cap.imports).DrawHUD(0, ps, { layout: "", inventory }, seatFrom(2, pane));

    const panel = picNamed(cap.pics, "inventory");
    expect(panel.x).toBe(Math.floor((640 - 256) / 2));
    expect(panel.y).toBe(480 + Math.floor((480 - 240) / 2) + 8); // +8: the panel's own offset

    // Its text rows are inside the pane as well.
    expect(cap.chars.length).toBeGreaterThan(0);
    for (const ch of cap.chars) {
      expect(ch.x).toBeGreaterThanOrEqual(pane.x);
      expect(ch.x).toBeLessThan(pane.x + pane.width);
      expect(ch.y).toBeGreaterThanOrEqual(pane.y);
      expect(ch.y).toBeLessThan(pane.y + pane.height);
    }
  });

  test("no pane's HUD escapes the display, at every seat count the layout defines", () => {
    const statusbar = "yb -24 xv 0 hnum xl 8 yt 8 picn corner xr -32 yb -32 picn far";
    for (const count of [1, 2, 3, 4]) {
      const seats = SplitscreenLayout(count, 1280, 960, SPLIT_LAYOUT_AUTO);
      for (let i = 0; i < seats.length; i++) {
        const pane = seats[i]!;
        const cap = makeCapture(statusbar);
        GetClassicCgameAPI(cap.imports).DrawHUD(0, makePlayerState(0), emptyData(), seatFrom(i, pane));
        for (const pic of cap.pics) {
          expect(pic.x).toBeGreaterThanOrEqual(0);
          expect(pic.y).toBeGreaterThanOrEqual(0);
          expect(pic.x).toBeLessThan(1280);
          expect(pic.y).toBeLessThan(960);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The engine centerprint, which the CLASSIC path draws itself
// ---------------------------------------------------------------------------
//
// Under the kex ruleset a centerprint never reaches cl_scrn.ts's own drawer:
// SCR_CenterPrint hands the string to the kex cgame's ParseCenterPrint, whose
// CG_DrawCenterString draws it inside that seat's hud_vrect. The classic cgame
// has no ParseCenterPrint member, so classic sessions fall through to
// cl_scrn.ts's own queue -- which centered on the DISPLAY, putting seat 0's
// message across the pane divider in a split. It now centers in seat 0's pane,
// which is the same place the kex path puts it.

function makeCapturingRe(): RefExports & { chars: { x: number; y: number; c: number }[] } {
  const fake = {
    chars: [] as { x: number; y: number; c: number }[],
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
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _sx: number, _sy: number, _sw: number, _sh: number, _color: DrawColorT) => undefined,
    DrawChar(x: number, y: number, c: number) {
      fake.chars.push({ x, y, c });
    },
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
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

describe("classic engine centerprint -- centered in seat 0's pane, not across the divider", () => {
  let savedWidth = 0;
  let savedHeight = 0;
  let re: RefExports & { chars: { x: number; y: number; c: number }[] };

  beforeEach(() => {
    savedWidth = viddef.width;
    savedHeight = viddef.height;
    viddef.width = 1280;
    viddef.height = 960;
    SCR_Init();
    // The classic cgame exposes no ParseCenterPrint, which is what routes a
    // centerprint to cl_scrn.ts's own drawer -- pinned here so another suite
    // that switched the host to the kex cgame cannot leak into this one.
    CG_SetActiveCgameKind("classic");
    cls.clear();
    SCR_ClearCenterPrint();
    re = makeCapturingRe();
    setRe(re);
    CL_Seats_SetActiveForTests(1);
  });

  afterEach(() => {
    CL_Seats_SetActiveForTests(1);
    SCR_ClearCenterPrint();
    setRe(null);
    viddef.width = savedWidth;
    viddef.height = savedHeight;
  });

  test("with one seat the centerprint is centered on the display, exactly as before", () => {
    cls.realtime = 1000;
    SCR_CenterPrint("HI");
    SCR_CheckDrawCenterString();

    expect(re.chars.length).toBe(2);
    expect(re.chars[0]!.x).toBe(Math.trunc((1280 - 2 * 8) / 2));
    expect(re.chars[0]!.y).toBe(Math.trunc(960 * 0.35));
  });

  test("with four seats it is centered in SEAT 0's pane -- inside the top-left quadrant, not on the divider", () => {
    CL_Seats_SetActiveForTests(4);
    const pane = CL_Seats_Viewports()[0]!;

    cls.realtime = 1000;
    SCR_CenterPrint("HI");
    SCR_CheckDrawCenterString();

    expect(re.chars.length).toBe(2);
    const first = re.chars[0]!;
    expect(first.x).toBe(pane.x + Math.trunc((pane.width - 2 * 8) / 2));
    expect(first.y).toBe(pane.y + Math.trunc(pane.height * 0.35));

    // Wholly inside seat 0's pane.
    for (const ch of re.chars) {
      expect(ch.x).toBeGreaterThanOrEqual(pane.x);
      expect(ch.x).toBeLessThan(pane.x + pane.width);
      expect(ch.y).toBeGreaterThanOrEqual(pane.y);
      expect(ch.y).toBeLessThan(pane.y + pane.height);
    }
    // And genuinely moved: the display-centered position is in a different pane.
    expect(first.x).not.toBe(Math.trunc((1280 - 2 * 8) / 2));
  });
});
