// Regression coverage for Mike's "You found a secret!" report
// (.orch/followups.md finding 4, ".orch/preferences.md rules 13-21" gate):
// under the kex cgame, the loc_print-driven centerprint (svc_print's
// PRINT_CENTER level -- q2repro's game.h:150 "centerprint without a
// separate function (loc variants only)", src/kexgame/g_utils.ts's
// G_PrintActivationMessage -> gi.Loc_Print -> PF_cprintf -> svc_print,
// exactly mirroring rerelease-dll's g_utils.cpp:125-130) (a) NEVER expired
// and (b) rendered illegibly at real display resolutions. Two independent
// root causes, both in src/client/cgame/host.ts:
//
//   #1 -- CgameImports.CL_ClientRealTime() was hardcoded to `return 0`.
//        src/kexgame/cgame/cg_screen.ts's CG_CheckDrawCenterString expires
//        a finished centerprint with
//        `center.finished && center.time_off < CGI().CL_ClientRealTime()`,
//        where `time_off` was set (once, at first draw) to
//        `CL_ClientRealTime() + scr_centertime*1000` -- a fixed POSITIVE
//        constant. With CL_ClientRealTime() stuck at 0, that comparison
//        (`positive constant < 0`) was permanently false: the message
//        never disappeared. Fixed to return cls.realtime (Sys_Milliseconds,
//        already this client's own "always increasing, never paused-
//        masked" wall clock -- q2repro's real CG_CL_ClientRealTime returns
//        com_localTime, the identical concept, src/common/common.c:141/1138).
//
//   #2 -- GetKexCgameAsClassicShape's DrawHUD adapter hardcoded hud_vrect to
//        the FULL real-pixel viddef surface and `scale` to a literal `1`,
//        with no renderer-level compensating scale anywhere in this port
//        (q2repro's own mechanism is a renderer-level R_SetScale applied
//        once per frame, src/client/screen.c's SCR_Draw2D). Every kfont
//        glyph (drawKfontChar's `ch.w * scale` / `ch.h * scale`) therefore
//        drew at its native, unscaled atlas pixel size regardless of
//        display resolution -- illegibly thin at any modern (>=720p)
//        display. Fixed by computing a real upscale factor (autoHudUpscale/
//        hudUpscaleFactor, ported from q2repro's get_auto_scale/
//        R_ClampScale, src/refresh/draw.c:266-301) and threading it through
//        BOTH hud_vrect (shrunk to q2repro's own "pre-scale" dimensions)
//        and DrawHUD's own `scale` parameter -- algebraically equivalent to
//        q2repro's separate renderer-level multiply, since every position/
//        size formula inside cg_screen.ts already multiplies by its own
//        `scale` parameter (see kexHudVrect's doc comment in host.ts for
//        the full derivation).
//
// Self-sufficient per preferences.md rule 13: every test resets cls/viddef/
// the scr_scale cvar/the active cgame kind in its own beforeEach/afterEach;
// none relies on another test file (or another test in this file) having
// run first.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  CG_SetActiveCgameKind,
  CG_DrawHUD,
  autoHudUpscale,
  hudUpscaleFactor,
  kexHudVrect,
} from "../src/client/cgame/host";
import { SCR_CenterPrint, SCR_ClearCenterPrint } from "../src/client/cl_scrn";
import { cl, cls, setRe, ConnstateT } from "../src/client/client";
import { viddef } from "../src/client/vid";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";

const CONCHAR_WIDTH = 8;

function makeFakeRe(): RefExports & { drawCharCalls: { x: number; y: number; c: number }[] } {
  const fake = {
    drawCharCalls: [] as { x: number; y: number; c: number }[],
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
    DrawStretchPicRegion: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _name: string,
      _srcX: number,
      _srcY: number,
      _srcW: number,
      _srcH: number,
      _color: DrawColorT,
    ) => undefined,
    DrawChar(x: number, y: number, c: number) {
      fake.drawCharCalls.push({ x, y, c });
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

let fake: ReturnType<typeof makeFakeRe>;

beforeEach(() => {
  cls.clear();
  SCR_ClearCenterPrint();
  fake = makeFakeRe();
  setRe(fake);
  viddef.width = 320;
  viddef.height = 240;
  Cvar_ForceSet("scr_scale", "0"); // this cvar's own registered default (auto)
  Cvar_ForceSet("scr_centertime", "5.0");
  Cvar_ForceSet("scr_printspeed", "0.04");
  // Forces ensureActiveKfont() to the conchars fallback (no retail .kfont
  // asset needed for this suite) -- same convention test/cl_scrn_bind_hint
  // .test.ts uses. scr_usekfont (the kexgame-internal cvar) stays at its
  // real default ("1"), so CG_DrawHUDString still routes through
  // cgi.SCR_DrawFontString -> drawFontStringDispatch -> drawConcharLines,
  // which DOES scale inter-character spacing by `scale` (CONCHAR_WIDTH *
  // scale per character) even though the glyph bitmap itself stays native
  // 8x8 -- see host.ts's own "KNOWN GAP" comment on drawConcharLines. That
  // per-glyph-bitmap gap is real, pre-existing, and out of this unit's
  // scope (it fires only with scr_usekfont forced to 0, not the default
  // kfont path Mike's actual bug report is about); the spacing this suite
  // measures is what actually changes end to end when hudUpscaleFactor's
  // return value changes, so it is what proves the wiring fix, not a
  // reimplementation of drawKfontChar's own (already-correct, untouched)
  // `ch.w * scale` glyph-size math.
  Cvar_ForceSet("cl_kfont_source", "classic");
  cls.state = ConnstateT.ca_connected;
  cl.layout = "";
  cl.playernum = 0;
});

afterEach(() => {
  CG_SetActiveCgameKind("classic"); // don't leak "kex" into another file's default-cgame assumptions
  Cvar_ForceSet("scr_scale", "0");
});

describe("root cause #1: CL_ClientRealTime wall-clock TTL (finding 4)", () => {
  test("a kex-cgame centerprint DOES expire once scr_centertime elapses on the real wall clock", () => {
    CG_SetActiveCgameKind("kex");
    cls.realtime = 1000;
    SCR_CenterPrint("You found a secret!", true);

    // First draw -- the 5s clock starts NOW (cg_screen.cpp's own
    // "clock starts at first draw, not at parse time" semantics, already
    // pinned for the classic fallback path by cl_scrn_centerprint.test.ts's
    // finding #30 case; this proves the SAME semantics hold end to end for
    // the kex path now that CL_ClientRealTime is wired for real).
    fake.drawCharCalls = [];
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0);

    // Still within the 5s window.
    fake.drawCharCalls = [];
    cls.realtime = 1000 + 4999;
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0);

    // Past scr_centertime (5000ms) since the first draw: gone. BEFORE THE
    // FIX this assertion always failed -- CL_ClientRealTime() permanently
    // returned 0, so `time_off (a fixed positive constant) < 0` was
    // permanently false and the message never expired.
    fake.drawCharCalls = [];
    cls.realtime = 1000 + 5001;
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBe(0);
  });

  test("a shorter scr_centertime expires proportionally sooner -- proves real elapsed time drives expiry, not a hardcoded frame count", () => {
    Cvar_ForceSet("scr_centertime", "1.0");
    CG_SetActiveCgameKind("kex");
    cls.realtime = 0;
    SCR_CenterPrint("short-lived", true);

    fake.drawCharCalls = [];
    CG_DrawHUD(); // first draw -- time_off = 0 + 1000

    fake.drawCharCalls = [];
    cls.realtime = 999;
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0);

    fake.drawCharCalls = [];
    cls.realtime = 1001;
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBe(0);
  });

  test("does not expire early: a print that just started must still be showing well before scr_centertime elapses", () => {
    CG_SetActiveCgameKind("kex");
    cls.realtime = 500000; // large, nonzero base -- CL_ClientRealTime must track cls.realtime, not some independent zero-based clock
    SCR_CenterPrint("still here", true);

    fake.drawCharCalls = [];
    CG_DrawHUD(); // first draw, time_off = 500000 + 5000

    fake.drawCharCalls = [];
    cls.realtime = 500000 + 100;
    CG_DrawHUD();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0);
  });
});

describe("root cause #2: HUD upscale (finding 4) -- pinned against q2repro's get_auto_scale/R_ClampScale (src/refresh/draw.c:266-301)", () => {
  test("autoHudUpscale: landscape thresholds", () => {
    expect(autoHudUpscale(640, 480)).toBe(1); // below 720p
    expect(autoHudUpscale(1280, 719)).toBe(1); // just under the 720 threshold
    expect(autoHudUpscale(1280, 720)).toBe(2); // exactly 720p
    expect(autoHudUpscale(1920, 1080)).toBe(2); // common 1080p desktop resolution
    expect(autoHudUpscale(3840, 2159)).toBe(2); // just under 2160
    expect(autoHudUpscale(3840, 2160)).toBe(4); // 4K
  });

  test("autoHudUpscale: portrait thresholds (width-driven, asymmetric vs landscape per the real source)", () => {
    expect(autoHudUpscale(480, 640)).toBe(1);
    expect(autoHudUpscale(1919, 3000)).toBe(1); // width just under 1920
    expect(autoHudUpscale(1920, 3000)).toBe(2);
    expect(autoHudUpscale(3839, 4000)).toBe(2);
    expect(autoHudUpscale(3840, 4000)).toBe(4);
  });

  test("hudUpscaleFactor: scr_scale=0 (its own registered default) uses the auto tier", () => {
    viddef.width = 1920;
    viddef.height = 1080;
    Cvar_ForceSet("scr_scale", "0");
    expect(hudUpscaleFactor()).toBe(2);
  });

  test("hudUpscaleFactor: a nonzero scr_scale overrides the auto tier outright, clamped 1..10", () => {
    viddef.width = 1920;
    viddef.height = 1080; // auto tier alone would be 2

    Cvar_ForceSet("scr_scale", "5");
    expect(hudUpscaleFactor()).toBe(5);

    Cvar_ForceSet("scr_scale", "50"); // clamp ceiling
    expect(hudUpscaleFactor()).toBe(10);

    Cvar_ForceSet("scr_scale", "0.2"); // clamp floor
    expect(hudUpscaleFactor()).toBe(1);
  });

  test("kexHudVrect: pre-scale (virtual) dims are the real viddef divided by upscale, matching q2repro's scr.hud_width/height", () => {
    viddef.width = 1920;
    viddef.height = 1080;
    expect(kexHudVrect(1)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(kexHudVrect(2)).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    expect(kexHudVrect(4)).toEqual({ x: 0, y: 0, width: 480, height: 270 });
  });

  test("kexHudVrect: rounds to the nearest integer when the division isn't exact", () => {
    viddef.width = 1921;
    viddef.height = 1081;
    expect(kexHudVrect(2)).toEqual({ x: 0, y: 0, width: 961, height: 541 }); // 960.5->961, 540.5->541
  });
});

describe("end to end: centerprint draw geometry actually scales with resolution (root cause #2)", () => {
  test("glyph x-spacing for the same centerprint text scales with the resolution-driven upscale factor", () => {
    CG_SetActiveCgameKind("kex");

    // Low resolution: auto upscale = 1 (below the 720p tier).
    viddef.width = 320;
    viddef.height = 240;
    SCR_CenterPrint("AB", true);
    fake.drawCharCalls = [];
    cls.realtime = 1;
    CG_DrawHUD();
    const lowResCalls = fake.drawCharCalls.filter((c) => c.c === "A".charCodeAt(0) || c.c === "B".charCodeAt(0));
    expect(lowResCalls.length).toBe(2);
    expect(Math.abs(lowResCalls[1]!.x - lowResCalls[0]!.x)).toBe(CONCHAR_WIDTH * 1);

    // High resolution: auto upscale = 2 (1080p tier). `instant: true`
    // flushes the previous centerprint's slot outright (CG_QueueCenterPrint's
    // own "just use first index" rule for instant prints) -- no explicit
    // clear needed between the two halves of this test.
    viddef.width = 1920;
    viddef.height = 1080;
    SCR_CenterPrint("AB", true);
    fake.drawCharCalls = [];
    cls.realtime = 2;
    CG_DrawHUD();
    const hiResCalls = fake.drawCharCalls.filter((c) => c.c === "A".charCodeAt(0) || c.c === "B".charCodeAt(0));
    expect(hiResCalls.length).toBe(2);
    // BEFORE THE FIX this was also 8 (scale hardcoded to 1 regardless of
    // viddef) -- the exact "illegibly thin at modern resolutions" symptom.
    expect(Math.abs(hiResCalls[1]!.x - hiResCalls[0]!.x)).toBe(CONCHAR_WIDTH * 2);
  });
});
