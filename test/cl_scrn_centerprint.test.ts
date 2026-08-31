// Regression coverage for divergence-audit findings #29/#30/#31 (cl_scrn.ts's
// centerprint model) -- see that file's own "CENTER PRINTING" section header
// for the full citation trail (quake2-rerelease-dll/rerelease/cg_screen.cpp's
// CG_QueueCenterPrint/CG_ParseCenterPrint/CG_DrawCenterString/
// CG_CheckDrawCenterString, and this codebase's own already-ported-but-dead
// copy at src/kexgame/cgame/cg_screen.ts).
//
//   #29 -- a rotating MAX_CENTER_PRINTS=4 buffer: a non-instant print queues
//          behind whatever's currently displaying instead of overwriting it;
//          an instant print still flushes the queue back to slot 0.
//   #30 -- scr_centertime's clock starts when the print FINISHES displaying
//          (first draw for instant, end of type-out for non-instant), not
//          at SCR_CenterPrint/parse time; default changed 2.5 -> 5.0.
//   #31 -- non-instant prints type out one codepoint per scr_printspeed
//          SECONDS (default "0.04", not vanilla's "8" characters/second),
//          with a blinking cursor glyph (10 or 11) at the reveal point.
//
// Self-sufficient per PORTING.md rule 13: `re` is set to a fresh spying fake
// (or null) per test, cls is cleared, and the two cvars this suite depends
// on are pinned via Cvar_ForceSet in beforeEach so another test file's
// mutation of scr_centertime/scr_printspeed can never leak in.
//
// SCR_CheckDrawCenterString is exported by cl_scrn.ts specifically for this
// file -- it is the exact same per-frame entry point SCR_UpdateScreen's
// 3D-refresh branch already calls in production, so driving it directly
// here exercises the real rotate/reveal/expire path, not a reimplementation
// of it.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { SCR_Init, SCR_CenterPrint, SCR_CheckDrawCenterString, SCR_ClearCenterPrint } from "../src/client/cl_scrn";
import { cls, setRe } from "../src/client/client";
import { viddef } from "../src/client/vid";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";

// Full RefExports fake (every member implemented, no `as`/partial cast --
// same convention test/cgame_draw.test.ts and test/client_types.test.ts
// use). Only DrawChar is actually exercised by cl_scrn.ts's centerprint
// drawer.
function makeFakeRe(): RefExports & { drawCharCalls: number[] } {
  const fake = {
    drawCharCalls: [] as number[],
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: (_x: number, _y: number, _w: number, _h: number, _name: string, _color: DrawColorT) => undefined,
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar(_x: number, _y: number, c: number) {
      fake.drawCharCalls.push(c);
    },
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return fake;
}

// A non-cursor draw call is a printable character; the cursor glyph is
// literally frame index 10 or 11 (10 + ((realtime>>8)&1)), which cl_scrn.ts
// always draws LAST for the line being typed. Strip it off if present so
// tests can assert on the revealed text plus a separate cursor flag.
function decodeDrawn(codes: number[]): { text: string; cursor: boolean } {
  const last = codes[codes.length - 1];
  if (last === 10 || last === 11) {
    return { text: codes.slice(0, -1).map((c) => String.fromCharCode(c)).join(""), cursor: true };
  }
  return { text: codes.map((c) => String.fromCharCode(c)).join(""), cursor: false };
}

let fake: RefExports & { drawCharCalls: number[] };

beforeAll(() => {
  SCR_Init(); // registers scr_centertime/scr_printspeed (Cvar_Get is idempotent)
});

beforeEach(() => {
  cls.clear();
  SCR_ClearCenterPrint(); // module-private queue state -- must not bleed across tests
  fake = makeFakeRe();
  setRe(fake);
  viddef.width = 320;
  viddef.height = 240;
  // Pin this suite's two cvars regardless of what any other test file left
  // them at.
  Cvar_ForceSet("scr_centertime", "5.0");
  Cvar_ForceSet("scr_printspeed", "0.04");
});

describe("SCR_CenterPrint / SCR_CheckDrawCenterString -- rerelease centerprint model", () => {
  test("finding #30: an instant print's scr_centertime clock starts at first DRAW, not at SCR_CenterPrint time", () => {
    cls.realtime = 1000;
    SCR_CenterPrint("HELLO"); // instant=true default

    // 4999ms after creation, but this is the first-ever draw call -- the
    // 5s timer only starts now. Vanilla's 2.5s-from-creation semantics
    // would already have expired this by now; the rerelease semantics
    // must not have.
    cls.realtime = 1000 + 4999;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls).text).toBe("HELLO");

    // Still within 5s of THAT first draw.
    cls.realtime = 1000 + 4999 + 4999;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls).text).toBe("HELLO");

    // Past 5s from the first draw: gone.
    cls.realtime = 1000 + 4999 + 5001;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls).toEqual([]);
  });

  test("finding #29: a non-instant print queues behind whatever is currently displaying instead of overwriting it", () => {
    cls.realtime = 0;
    SCR_CenterPrint("AB", false); // slot 0, starts typing immediately
    SCR_CenterPrint("CD", false); // must queue behind slot 0, not replace it

    // Reveal "AB" one character per scr_printspeed (40ms) tick.
    cls.realtime = 41;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "A", cursor: true });

    cls.realtime = 82;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    // Fully typed on this tick -- draws the whole line plus the cursor,
    // and marks the slot finished (5s clock starts now: 82 + 5000).
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "AB", cursor: true });

    // Still within "AB"'s 5s display window: "CD" must not appear yet.
    cls.realtime = 5000;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls).text).toBe("AB");

    // Past "AB"'s time_off (82 + 5000 = 5082): rotates to "CD", which
    // starts its own fresh type-out (its stale timeTick from creation is
    // long past, so this same call reveals its first character).
    cls.realtime = 5083;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "C", cursor: true });
  });

  test("finding #29: an instant print flushes the queue and takes slot 0 immediately, ahead of anything queued", () => {
    cls.realtime = 0;
    SCR_CenterPrint("QUEUED", false); // slot 0, non-instant, not yet drawn/finished

    // An instant print arrives before "QUEUED" was ever drawn.
    SCR_CenterPrint("URGENT"); // instant=true: flushes the queue, takes slot 0

    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "URGENT", cursor: false });

    // "QUEUED" was discarded, not merely delayed: once URGENT expires,
    // nothing is left to rotate to.
    cls.realtime = 5001; // URGENT's time_off is 0 + 5000 (first draw was at t=0)
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls).toEqual([]);
  });

  test("finding #31: multi-line non-instant prints type out one line at a time, each recognized by its own newline split", () => {
    cls.realtime = 0;
    SCR_CenterPrint("HI\nBY", false);

    // First tick reveals line 0's first (and only) character; line 1 is
    // not drawn at all yet (CG_DrawCenterString breaks after currentLine).
    cls.realtime = 41;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "H", cursor: true });

    cls.realtime = 82;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "HI", cursor: true }); // line 0 finished revealing

    // Next tick moves onto line 1 ("BY"), revealing its first character.
    // The reference draws every already-finished line ahead of the one
    // currently typing too (cg_screen.cpp's draw loop runs i=0..current_line
    // and only breaks AFTER drawing current_line), so line 0's "HI" is
    // still drawn alongside line 1's in-progress "B".
    cls.realtime = 123;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "HIB", cursor: true });
  });

  test("finding #31: scr_printspeed is actually read -- a slower cvar value delays each reveal tick", () => {
    Cvar_ForceSet("scr_printspeed", "1.0"); // 1 full second per character
    cls.realtime = 0;
    SCR_CenterPrint("AB", false);

    // Under the default 0.04s/char this would already show "A" by now;
    // under 1.0s/char no character has been revealed yet -- only the
    // blinking cursor (drawn at the reveal point even with zero characters
    // typed so far, matching the reference's own `buffer[0]?...:blinkyX`).
    cls.realtime = 500;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "", cursor: true });

    cls.realtime = 1001;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(decodeDrawn(fake.drawCharCalls)).toEqual({ text: "A", cursor: true });
  });
});
