// cgame activation -- ARCHITECTURE.md phase 4 closure: the client now picks
// the active cgame (classic vs kex) off the connected server's declared
// protocol family (cl_parse.ts's CL_ParseServerData, mirroring q2repro's
// cgame.c:425-437 "rerelease server -> load the game's cgame; classic server
// -> builtin classic"), reverts to classic on disconnect (cl_main.ts's
// CL_Disconnect), and the kex adapter's DrawHUD (host.ts's
// GetKexCgameAsClassicShape) is now a REAL call into the kex cgame's own
// CG_DrawHUD -- built from a KexPlayerStateT/CgServerDataT view assembled
// from the classic client state, the exact inverse of
// src/server/bindings/kex.ts's syncPlayerStateKexToEngine.
//
// Three groups of coverage, matching this unit's brief:
//   A. kind selection off CL_ParseServerData's protocol family (+ the
//      disconnect-reverts-to-classic seam).
//   B. kexPlayerStateViewFromClassic / kexServerDataViewFromClassic field
//      spot checks -- pure functions, no engine state touched.
//   C. DrawHUD/TouchPics actually dispatch to a DIFFERENT real
//      implementation depending on the active kind (not just "doesn't
//      throw either way").
//
// Self-sufficient per preferences.md rule 13: every test sets the kind/cls
// state it depends on directly rather than relying on suite order, and
// group C's TouchPics tests install their own fake `re` (setRe) and restore
// it to null afterward so later files see the same default other test files
// already assume (cgame_draw.test.ts's own precedent).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  CG_GetActiveCgame,
  CG_GetActiveCgameKind,
  CG_SetActiveCgameKind,
  CG_DrawHUD,
  CG_TouchPics,
  kexPlayerStateViewFromClassic,
  kexServerDataViewFromClassic,
  kexPmTypeFromEngine,
  type ClassicHudDataT,
} from "../src/client/cgame/host";
import { CL_ParseServerData } from "../src/client/cl_parse";
import { CL_Disconnect } from "../src/client/cl_main";
import { cls, cl, setRe, ConnstateT } from "../src/client/client";
import type { RefExports, ImageS } from "../src/client/ref";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_RERELEASE } from "../src/qcommon/qcommon";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteString } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import { PlayerStateT, PmTypeT } from "../src/shared/q_shared";
import { KexPmTypeT, MAX_STATS as KEX_MAX_STATS } from "../src/kexapi/game";

function resetNetMessage(): void {
  SZ_Clear(net_message);
  net_message.readcount = 0;
}

// Builds a full, standalone CL_ParseServerData wire buffer: CL_ParseServerData
// itself reads the leading protocol long directly (before ever touching
// `cls.codec`), so this writes that long, then the codec-specific body.
function buildClassicServerDataMessage(clientnum: number): void {
  resetNetMessage();
  MSG_WriteLong(net_message, PROTOCOL_VERSION); // 34, read directly by CL_ParseServerData
  MSG_WriteLong(net_message, 1); // servercount
  MSG_WriteByte(net_message, 0); // attractloop
  MSG_WriteString(net_message, "baseq2"); // gamedir
  MSG_WriteShort(net_message, clientnum);
  MSG_WriteString(net_message, "activation test level");
  MSG_BeginReading(net_message);
}

// Same idea for the kex/1038 family: Q2REPRO_CODEC.writeServerData writes ITS
// OWN leading opcode+protocol long (q2repro.ts's own convention, see
// test/protocol_serverdata.test.ts's roundTrip helper) -- skip those 5 bytes
// since CL_ParseServerData's own MSG_ReadLong above already covers the
// protocol number, then feed the rest into net_message.
function buildKexServerDataMessage(clientnum: number): void {
  resetNetMessage();
  MSG_WriteLong(net_message, PROTOCOL_VERSION_RERELEASE); // 1038, read directly by CL_ParseServerData

  const scratch = new SizeBuf();
  SZ_Init(scratch, new Uint8Array(4096), 4096);
  Q2REPRO_CODEC.writeServerData(scratch, {
    servercount: 1,
    attractloop: false,
    gamedir: "kex",
    clientnum,
    levelname: "base1",
    serverState: 0,
  });
  net_message.data.set(scratch.data.subarray(5, scratch.cursize), net_message.cursize);
  net_message.cursize += scratch.cursize - 5;
  MSG_BeginReading(net_message);
}

// ---------------------------------------------------------------------------
// A. kind selection off CL_ParseServerData's protocol family
// ---------------------------------------------------------------------------

describe("cgame activation -- kind selection off CL_ParseServerData's protocol family", () => {
  beforeEach(() => {
    CG_SetActiveCgameKind("classic");
    cls.state = ConnstateT.ca_connected;
  });

  test("protocol 34 (classic) activates the classic cgame kind", () => {
    CG_SetActiveCgameKind("kex"); // start from the opposite kind so this proves a real flip
    buildClassicServerDataMessage(0);
    CL_ParseServerData();
    expect(CG_GetActiveCgameKind()).toBe("classic");
  });

  test("protocol 1038 (kex/rerelease) activates the kex cgame kind", () => {
    expect(CG_GetActiveCgameKind()).toBe("classic"); // default, set by beforeEach
    buildKexServerDataMessage(0);
    CL_ParseServerData();
    expect(CG_GetActiveCgameKind()).toBe("kex");
  });

  test("a kex connection followed by a classic reconnection flips the kind back", () => {
    buildKexServerDataMessage(0);
    CL_ParseServerData();
    expect(CG_GetActiveCgameKind()).toBe("kex");

    buildClassicServerDataMessage(0);
    CL_ParseServerData();
    expect(CG_GetActiveCgameKind()).toBe("classic");
  });

  test("CL_Disconnect reverts the active cgame kind to classic", () => {
    CG_SetActiveCgameKind("kex");
    cls.state = ConnstateT.ca_connected;
    CL_Disconnect();
    expect(CG_GetActiveCgameKind()).toBe("classic");
  });

  test("CL_Disconnect is a no-op (kind included) when already disconnected", () => {
    CG_SetActiveCgameKind("kex");
    cls.state = ConnstateT.ca_disconnected;
    CL_Disconnect();
    expect(CG_GetActiveCgameKind()).toBe("kex"); // early-return path never reaches the reset
  });
});

// ---------------------------------------------------------------------------
// B. kexPlayerStateViewFromClassic / kexServerDataViewFromClassic -- pure
//    conversion functions, the direct inverse of kex.ts's
//    syncPlayerStateKexToEngine.
// ---------------------------------------------------------------------------

describe("kexPlayerStateViewFromClassic -- field spot checks (inverse of kex.ts's syncPlayerStateKexToEngine)", () => {
  test("pmove.origin/velocity: int16 12.3 fixed-point -> float, the inverse of the forward `* 8` scale", () => {
    const ps = new PlayerStateT();
    ps.pmove.origin.set([80, -160, 8]); // 10, -20, 1 world units
    ps.pmove.velocity.set([800, 0, -8]); // 100, 0, -1 world units

    const view = kexPlayerStateViewFromClassic(ps);

    expect(Array.from(view.pmove.origin)).toEqual([10, -20, 1]);
    expect(Array.from(view.pmove.velocity)).toEqual([100, 0, -1]);
  });

  test("pmove.delta_angles: int16 short-angle -> float degrees via SHORT2ANGLE, the inverse of the forward ANGLE2SHORT", () => {
    const ps = new PlayerStateT();
    ps.pmove.delta_angles.set([32768, 16384, 0]); // 180, 90, 0 degrees (SHORT2ANGLE convention)

    const view = kexPlayerStateViewFromClassic(ps);

    expect(view.pmove.delta_angles[0]).toBeCloseTo(-180, 3); // int16 wraps 32768 -> -32768 -> -180
    expect(view.pmove.delta_angles[1]).toBeCloseTo(90, 3);
    expect(view.pmove.delta_angles[2]).toBeCloseTo(0, 3);
  });

  test("pmove.pm_flags/pm_time/gravity copy straight through; viewheight defaults to 0 (no classic source field)", () => {
    const ps = new PlayerStateT();
    ps.pmove.pm_flags = 5;
    ps.pmove.pm_time = 12;
    ps.pmove.gravity = 800;

    const view = kexPlayerStateViewFromClassic(ps);

    expect(view.pmove.pm_flags).toBe(5);
    expect(view.pmove.pm_time).toBe(12);
    expect(view.pmove.gravity).toBe(800);
    expect(view.pmove.viewheight).toBe(0);
  });

  test("stats widen 32 -> 64: the first 32 slots survive, the kex-only tail is zero-filled (not garbage)", () => {
    const ps = new PlayerStateT();
    ps.stats[0] = 42;
    ps.stats[13] = 3; // STAT_LAYOUTS, arbitrary non-zero spot check
    ps.stats[31] = -7;

    const view = kexPlayerStateViewFromClassic(ps);

    expect(view.stats.length).toBe(KEX_MAX_STATS);
    expect(view.stats[0]).toBe(42);
    expect(view.stats[13]).toBe(3);
    expect(view.stats[31]).toBe(-7);
    for (let i = 32; i < KEX_MAX_STATS; i++) expect(view.stats[i]).toBe(0);
  });

  test("viewangles/gunskin/gunrate/team_id/blend/damage_blend copy by value, not by reference", () => {
    const ps = new PlayerStateT();
    ps.viewangles.set([1, 2, 3]);
    ps.gunskin = 4;
    ps.gunrate = 20;
    ps.team_id = 2;
    ps.blend.set([1, 0, 0, 0.5]);
    ps.damage_blend.set([0, 1, 0, 0.25]);

    const view = kexPlayerStateViewFromClassic(ps);

    expect(Array.from(view.viewangles)).toEqual([1, 2, 3]);
    expect(view.gunskin).toBe(4);
    expect(view.gunrate).toBe(20);
    expect(view.team_id).toBe(2);
    expect(Array.from(view.screen_blend)).toEqual([1, 0, 0, 0.5]);
    expect(Array.from(view.damage_blend)).toEqual([0, 1, 0, 0.25]);

    // mutating the source afterward must not retroactively change the view
    ps.viewangles[0] = 999;
    expect(view.viewangles[0]).toBe(1);
  });

  test("kexPmTypeFromEngine: 1:1 name-match round trip for every legacy PmTypeT except the lossy PM_SPECTATOR<->PM_NOCLIP collapse", () => {
    expect(kexPmTypeFromEngine(PmTypeT.PM_NORMAL)).toBe(KexPmTypeT.PM_NORMAL);
    expect(kexPmTypeFromEngine(PmTypeT.PM_SPECTATOR)).toBe(KexPmTypeT.PM_SPECTATOR);
    expect(kexPmTypeFromEngine(PmTypeT.PM_DEAD)).toBe(KexPmTypeT.PM_DEAD);
    expect(kexPmTypeFromEngine(PmTypeT.PM_GIB)).toBe(KexPmTypeT.PM_GIB);
    expect(kexPmTypeFromEngine(PmTypeT.PM_FREEZE)).toBe(KexPmTypeT.PM_FREEZE);
  });
});

describe("kexServerDataViewFromClassic -- CgServerDataT assembly from ClassicHudDataT", () => {
  test("layout string passes through unchanged; inventory narrows Int32Array -> Int16Array losslessly", () => {
    const data: ClassicHudDataT = {
      layout: "xl 0 yb -24 pic 0",
      inventory: Int32Array.from([0, 1, 2, 300, 32767]),
    };

    const view = kexServerDataViewFromClassic(data);

    expect(view.layout).toBe(data.layout);
    expect(view.inventory).toBeInstanceOf(Int16Array);
    expect(Array.from(view.inventory)).toEqual([0, 1, 2, 300, 32767]);
  });
});

// ---------------------------------------------------------------------------
// C. DrawHUD/TouchPics actually dispatch to a DIFFERENT real implementation
//    per active kind.
// ---------------------------------------------------------------------------

function makeFakeRe(): RefExports & { registerPicCalls: string[] } {
  const fake = {
    registerPicCalls: [] as string[],
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic(name: string): ImageS | null {
      fake.registerPicCalls.push(name);
      return null;
    },
    RegisterRawPic: (): ImageS | null => null,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: -1, h: -1 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: () => undefined,
    DrawStretchPicRegion: () => undefined,
    DrawChar: () => undefined,
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

describe("CG_DrawHUD -- dispatches to a real, different implementation per active kind", () => {
  beforeEach(() => {
    cls.state = ConnstateT.ca_connected; // below ca_active: keeps classic's real SCR_DrawStats/SCR_DrawLayout a safe no-op (cgame_host.test.ts's own precedent)
    cl.layout = "";
    cl.playernum = 0;
  });

  afterEach(() => {
    CG_SetActiveCgameKind("classic");
  });

  test("classic kind: CG_DrawHUD reaches the real classic DrawHUD without throwing", () => {
    CG_SetActiveCgameKind("classic");
    expect(() => CG_DrawHUD()).not.toThrow();
  });

  test("kex kind: CG_DrawHUD reaches the real kex DrawHUD (full ps/data conversion + kex.DrawHUD call) without throwing", () => {
    CG_SetActiveCgameKind("kex");
    expect(() => CG_DrawHUD()).not.toThrow();
  });

  test("the active cgame's DrawHUD function identity differs between the two kinds -- the registry really swaps implementations", () => {
    CG_SetActiveCgameKind("classic");
    const classicDrawHUD = CG_GetActiveCgame().DrawHUD;

    CG_SetActiveCgameKind("kex");
    const kexDrawHUD = CG_GetActiveCgame().DrawHUD;

    expect(kexDrawHUD).not.toBe(classicDrawHUD);
  });
});

describe("CG_TouchPics -- dispatches to a real, different implementation per active kind", () => {
  let fake: ReturnType<typeof makeFakeRe>;

  beforeEach(() => {
    fake = makeFakeRe();
    setRe(fake);
  });

  afterEach(() => {
    setRe(null);
    CG_SetActiveCgameKind("classic");
  });

  test("classic kind: TouchPics registers the sb_nums digit pics, not the kex-only 'inventory' pic", () => {
    CG_SetActiveCgameKind("classic");
    CG_TouchPics();

    expect(fake.registerPicCalls).toContain("num_0");
    expect(fake.registerPicCalls).toContain("anum_9");
    expect(fake.registerPicCalls).not.toContain("inventory");
  });

  test("kex kind: TouchPics registers the kex-only 'inventory' pic -- proof the real kex CG_TouchPics ran, not classic's", () => {
    CG_SetActiveCgameKind("kex");
    CG_TouchPics();

    expect(fake.registerPicCalls).toContain("inventory");
  });
});
