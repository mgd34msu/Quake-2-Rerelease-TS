// Test for item 6 (%bind hint lines) of the wave-B on-screen-indicators
// task: src/client/cl_scrn.ts's SCR_CenterPrint now delegates to the
// ACTIVE cgame's ParseCenterPrint when one exists (src/client/cgame/
// host.ts's new CgameExports.ParseCenterPrint/NotifyMessage members,
// wired for the kex cgame in GetKexCgameAsClassicShape) instead of always
// running its own local queue/typewriter implementation -- closing the gap
// that file's own header comment already flagged: "host.ts never wires the
// kex cgame's own ParseCenterPrint export to the live client path". The
// kex cgame's real CG_ParseCenterPrint (src/kexgame/cgame/cg_screen.ts)
// strips leading "%bind:cmd:purpose%" tokens and draws them via
// cgi.SCR_DrawBind (already wired for real in host.ts's buildCgameImports:
// "[key] purpose" via Key_GetBinding + Loc_Localize) -- this suite proves
// the delegation wiring itself, plus one real end-to-end pass of the loc
// test suite's actual retail vector ("%bind:+movedown:$m_crouch%Crouch
// here.", test/loc_print_key_expansion.test.ts's own citation) through to
// drawn characters.
//
// Self-sufficient per PORTING.md rule 13: cl_kfont_source is pinned to
// "classic" in beforeEach so this file's assertions always exercise the
// conchars-fallback draw path (re.DrawChar, one call per glyph) regardless
// of what test/cgame_host_kfont_source.test.ts leaves the shared cvar
// registry at -- bun test runs every file in one process, so cvar state is
// a real cross-file leak risk (the same reason cl_scrn_centerprint.test.ts
// pins scr_centertime/scr_printspeed in its own beforeEach).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SCR_Init, SCR_CenterPrint, SCR_CheckDrawCenterString, SCR_ClearCenterPrint } from "../src/client/cl_scrn";
import { cl, cls, setRe, ConnstateT } from "../src/client/client";
import { viddef } from "../src/client/vid";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { Key_SetBinding, Key_StringToKeynum } from "../src/client/keys_impl";
import { CG_SetActiveCgame, CG_SetActiveCgameKind, CG_GetActiveCgame, CG_DrawHUD, type CgameExports } from "../src/client/cgame/host";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";

// Same real retail vector test/loc_print_key_expansion.test.ts's own
// section 5 cites (map_crouch_here's actual loc_english.txt content).
const REAL_BIND_CENTERPRINT = "%bind:+movedown:$m_crouch%Crouch here.";

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
    RegisterRawPic: (): ImageS | null => null,
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
  Cvar_ForceSet("scr_centertime", "5.0");
  Cvar_ForceSet("scr_printspeed", "0.04");
  Cvar_ForceSet("cl_kfont_source", "classic"); // force conchars fallback -- see file header
  cls.state = ConnstateT.ca_connected;
  cl.layout = "";
  cl.playernum = 0;
});

afterEach(() => {
  CG_SetActiveCgameKind("classic"); // don't leak "kex" into another test file's default-cgame assumptions
});

describe("SCR_CenterPrint delegation", () => {
  test("classic active cgame (default): unchanged -- uses this file's own local queue, exactly like before item 6", () => {
    SCR_Init();
    SCR_CenterPrint("HELLO");
    cls.realtime = 1;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0); // the local queue drew it
  });

  test("a fake cgame that HAS ParseCenterPrint: SCR_CenterPrint hands the raw string straight to it and skips its own local queue entirely", () => {
    const calls: { str: string; isplit: number; instant: boolean }[] = [];
    const fakeCgame: CgameExports = {
      apiversion: 1,
      Init: () => undefined,
      Shutdown: () => undefined,
      DrawHUD: () => undefined,
      TouchPics: () => undefined,
      GetOwnedWeaponWheelWeapons: () => 0,
      GetWeaponWheelAmmoCount: () => -1,
      GetPowerupWheelCount: () => -1,
      GetActiveWeaponWheelWeapon: () => 0,
      ParseCenterPrint: (str, isplit, instant) => {
        calls.push({ str, isplit, instant });
      },
    };
    CG_SetActiveCgame(fakeCgame);

    SCR_CenterPrint(REAL_BIND_CENTERPRINT, false);

    expect(calls).toEqual([{ str: REAL_BIND_CENTERPRINT, isplit: 0, instant: false }]);

    // The local queue was never touched -- SCR_CheckDrawCenterString has
    // nothing to draw.
    cls.realtime = 1;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls).toEqual([]);
  });

  test("a cgame WITHOUT ParseCenterPrint (classic's real shape, no member at all): falls through to the local queue unchanged", () => {
    const fakeCgame: CgameExports = {
      apiversion: 1,
      Init: () => undefined,
      Shutdown: () => undefined,
      DrawHUD: () => undefined,
      TouchPics: () => undefined,
      GetOwnedWeaponWheelWeapons: () => 0,
      GetWeaponWheelAmmoCount: () => -1,
      GetPowerupWheelCount: () => -1,
      GetActiveWeaponWheelWeapon: () => 0,
      // ParseCenterPrint omitted entirely -- optional member.
    };
    CG_SetActiveCgame(fakeCgame);

    SCR_CenterPrint("PLAIN");
    cls.realtime = 1;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls.length).toBeGreaterThan(0);
  });
});

describe("real kex cgame end-to-end (GetKexCgameAsClassicShape's ParseCenterPrint/NotifyMessage wiring)", () => {
  test("CG_GetActiveCgame().ParseCenterPrint is defined for \"kex\" and does not throw on the real retail %bind vector", () => {
    CG_SetActiveCgameKind("kex");
    const kexCgame = CG_GetActiveCgame();
    expect(kexCgame.ParseCenterPrint).toBeDefined();
    expect(kexCgame.NotifyMessage).toBeDefined();
    expect(() => kexCgame.ParseCenterPrint!(REAL_BIND_CENTERPRINT, 0, true)).not.toThrow();
  });

  test("SCR_CenterPrint with kex active routes the real retail vector through the real kex cgame, not this file's own queue", () => {
    CG_SetActiveCgameKind("kex");
    expect(() => SCR_CenterPrint(REAL_BIND_CENTERPRINT, true)).not.toThrow();

    cls.realtime = 1;
    fake.drawCharCalls = [];
    SCR_CheckDrawCenterString();
    expect(fake.drawCharCalls).toEqual([]); // this file's own queue never saw it
  });

  test("end-to-end draw: binding +movedown, then driving CG_DrawHUD, draws readable text with the raw %bind syntax gone (bind hint expanded, not shown literally)", () => {
    CG_SetActiveCgameKind("kex");
    // Bind "ctrl" to "+movedown" via the real key-binding system (keys_impl.ts)
    // -- SCR_DrawBind (host.ts) resolves this through Key_GetBinding.
    Key_SetBinding(Key_StringToKeynum("ctrl"), "+movedown");

    SCR_CenterPrint(REAL_BIND_CENTERPRINT, true);

    fake.drawCharCalls = [];
    expect(() => CG_DrawHUD()).not.toThrow();

    const drawn = fake.drawCharCalls.map((c) => String.fromCharCode(c)).join("");
    // The raw "%bind:" wire syntax must never reach the screen literally.
    expect(drawn).not.toContain("%bind:");
    // The non-bind remainder of the centerprint text ("Crouch here.",
    // CG_ParseCenterPrint's own text-after-the-token split) IS drawn as a
    // regular line.
    expect(drawn).toContain("Crouch here.");
  });
});
