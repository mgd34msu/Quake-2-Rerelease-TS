/*
Unit tests for the kex cgame port (src/kexgame/cgame/cg_main.ts,
src/kexgame/cgame/cg_screen.ts, src/kexgame/cgame/cg_local.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexCgameImports (never relies on another test file having
run first) and creates a fresh fake-imports object (with its own spy arrays
and cvar/configstring maps) per test, calling `GetCGameAPI(imports)` inside
each test rather than sharing one module-level instance -- cg_main.ts/
cg_screen.ts/cg_local.ts hold module-scope singleton state (the shared `cgi`
table, `hud_data`, the registered cvar handles), so each test re-establishes
that state from a clean fixture instead of depending on ordering.

Scope (14 cases, each citing the exact C++ line range it exercises):
  - GetCGameAPI (cg_main.cpp:96-124): apiversion 2022 (kexapi/game.ts's
    CGAME_API_VERSION, NOT host.ts's own minimal-seam version), every
    KexCgameExports slot present as a function, GetExtension always null
    (cg_main.cpp:10-13).
  - GetActiveWeaponWheelWeapon (cg_main.cpp:37-40): direct
    STAT_ACTIVE_WHEEL_WEAPON stat read.
  - GetOwnedWeaponWheelWeapons (cg_main.cpp:42-45): the
    (uint16)stats[W1] | ((uint16)stats[W2] << 16) bit layout, verified
    against hand-packed uint16 halves including a value that is negative
    when stored in the backing Int16Array (bit-pattern round-trip, not just
    small positive numbers).
  - GetWeaponWheelAmmoCount (cg_main.cpp:47-55): round-tripped against
    p_hud.ts's own G_SetAmmoStat encoder (bg_local.h:159-163/165-168), plus
    the AMMO_VALUE_INFINITE -> -1 sentinel translation.
  - GetPowerupWheelCount (cg_main.cpp:57-60): round-tripped against
    p_hud.ts's G_SetPowerupStat encoder (bg_local.h:187-190/192-195).
  - GetHitMarkerDamage (cg_main.cpp:62-65): direct STAT_HIT_MARKER read.
  - Null player_state_t: every stat-reading KexCgameExports member throws
    (this port's "unconditional C++ dereference -> explicit throw"
    convention), matching g_main.ts's own Pmove-wrapper precedent.
  - Pmove: throws on a null pmove (cg_main.cpp:104: `cglobals.Pmove =
    Pmove;`, an unconditional C++ dereference).
  - GetMonsterFlashOffset (cg_main.cpp:80-86): copies m_flash.ts's
    monsterFlashOffset() table entry into the output Vec3 for id=0, a
    middle id, and MZ2_LAST; throws (via cgi.Com_Error) one past the last
    valid id.
  - CG_LayoutFlags (cg_screen.cpp:83-86): returns ps->stats[STAT_LAYOUTS]
    verbatim.
  - ParseConfigString / InitCGame (cg_main.cpp:19-27, 67-73): Init() reads
    CONFIG_N64_PHYSICS/CS_AIRACCEL via get_configstring without throwing;
    ParseConfigString accepts both indices without throwing.
  - ParseCenterPrint (cg_screen.cpp:386-496): splits a multi-line string
    into `lines` (observed indirectly via the decorative console echo,
    cg_screen.cpp:422-452) and never throws for the %bind:-prefixed form
    (cg_screen.cpp:404-420).
  - TouchPics (cg_screen.cpp:1755-1764): registers all 22 sb_nums pics plus
    "inventory".
  - DrawHUD (cg_screen.cpp:1717-1747) end-to-end: a CS_STATUSBAR layout
    string containing "hnum" actually reaches CG_DrawField -> SCR_DrawPic
    with the correct sb_nums glyph name for a given STAT_HEALTH value --
    proves the whole GetCGameAPI -> CG_DrawHUD -> CG_ExecuteLayoutString ->
    CG_DrawField data path, not just the isolated stat-read functions.
*/

import { describe, test, expect } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import type { KexCgameImports, KexCgameExports, KexPlayerStateT, KexPmoveStateT } from "../src/kexapi/game";
import { CvarFlagsT, LayoutFlagsT, MonsterMuzzleflashIdT, CS_AIRACCEL, MAX_STATS } from "../src/kexapi/game";
import { PlayerStatT, G_SetAmmoStat, G_SetPowerupStat, AMMO_VALUE_INFINITE, STAT_POWERUP_INFO_START } from "../src/kexgame/p_hud";
import { GetCGameAPI } from "../src/kexgame/cgame/cg_main";
import { monsterFlashOffset } from "../src/kexgame/m_flash";

// ---------------------------------------------------------------------------
// fake KexCgameImports fixture -- fresh per test (see file header)
// ---------------------------------------------------------------------------

interface FakeImports {
  imports: KexCgameImports;
  configstrings: Map<number, string>;
  drawPicCalls: { x: number; y: number; w: number; h: number; name: string }[];
  drawFontStringCalls: { str: string; x: number; y: number }[];
  registerPicCalls: string[];
  comPrints: string[];
}

function makeFakeImports(): FakeImports {
  const configstrings = new Map<number, string>();
  const drawPicCalls: { x: number; y: number; w: number; h: number; name: string }[] = [];
  const drawFontStringCalls: { str: string; x: number; y: number }[] = [];
  const registerPicCalls: string[] = [];
  const comPrints: string[] = [];
  const cvars = new Map<string, CvarT>();

  function fakeCvar(name: string, value: string | null, flags: number): CvarT {
    let c = cvars.get(name);
    if (!c) {
      c = new CvarT();
      c.name = name;
      c.string = value ?? "";
      c.value = Number.parseFloat(value ?? "0") || 0;
      c.flags = flags;
      cvars.set(name, c);
    }
    return c;
  }

  const imports: KexCgameImports = {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,

    Com_Print(msg: string): void {
      comPrints.push(msg);
    },

    get_configstring(num: number): string {
      return configstrings.get(num) ?? "";
    },

    Com_Error(message: string): never {
      throw new Error(`cgi.Com_Error: ${message}`);
    },

    TagMalloc: () => null,
    TagFree: () => {},
    FreeTags: () => {},

    cvar: fakeCvar,
    cvar_set: (name: string, value: string) => fakeCvar(name, value, CvarFlagsT.CVAR_NOFLAGS),
    cvar_forceset: (name: string, value: string) => fakeCvar(name, value, CvarFlagsT.CVAR_NOFLAGS),

    AddCommandString: () => {},
    GetExtension: () => null,

    CL_FrameValid: () => true,
    CL_FrameTime: () => 0,
    CL_ClientTime: () => 0,
    CL_ClientRealTime: () => 0,
    CL_ServerFrame: () => 0,
    CL_ServerProtocol: () => 0,
    CL_GetClientName: (index: number) => `Player${index}`,
    CL_GetClientPic: () => "",
    CL_GetClientDogtag: () => "",
    CL_GetKeyBinding: () => "",

    Draw_RegisterPic: (name: string) => {
      registerPicCalls.push(name);
      return true;
    },
    Draw_GetPicSize: (w: [number], h: [number]) => {
      w[0] = 16;
      h[0] = 16;
    },
    SCR_DrawChar: () => {},
    SCR_DrawPic: (x: number, y: number, w: number, h: number, name: string) => {
      drawPicCalls.push({ x, y, w, h, name });
    },
    SCR_DrawColorPic: () => {},

    SCR_SetAltTypeface: () => {},
    SCR_DrawFontString: (str: string, x: number, y: number) => {
      drawFontStringCalls.push({ str, x, y });
    },
    SCR_MeasureFontString: () => ({ x: 0, y: 0 }),
    SCR_FontLineHeight: () => 10,

    CL_GetTextInput: () => false,
    CL_GetWarnAmmoCount: () => 0,

    Localize: (base: string) => base,

    SCR_DrawBind: () => 0,

    CL_InAutoDemoLoop: () => false,
  };

  return { imports, configstrings, drawPicCalls, drawFontStringCalls, registerPicCalls, comPrints };
}

function makePmoveState(): KexPmoveStateT {
  return { pm_type: 0, origin: vec3(), velocity: vec3(), pm_flags: 0, pm_time: 0, gravity: 0, delta_angles: vec3(), viewheight: 0 };
}

function makePlayerState(): KexPlayerStateT {
  return {
    pmove: makePmoveState(),
    viewangles: vec3(),
    viewoffset: vec3(),
    kick_angles: vec3(),
    gunangles: vec3(),
    gunoffset: vec3(),
    gunindex: 0,
    gunskin: 0,
    gunframe: 0,
    gunrate: 0,
    screen_blend: new Float32Array(4),
    damage_blend: new Float32Array(4),
    fov: 90,
    rdflags: 0,
    stats: new Int16Array(MAX_STATS),
    team_id: 0,
  };
}

// ---------------------------------------------------------------------------
// GetCGameAPI slot completeness (cg_main.cpp:96-124)
// ---------------------------------------------------------------------------

describe("GetCGameAPI", () => {
  test("returns kexapi's real apiversion (2022) and every KexCgameExports slot", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);

    expect(api.apiversion).toBe(2022);

    const fnSlots: (keyof KexCgameExports)[] = [
      "Init",
      "Shutdown",
      "DrawHUD",
      "TouchPics",
      "LayoutFlags",
      "GetActiveWeaponWheelWeapon",
      "GetOwnedWeaponWheelWeapons",
      "GetWeaponWheelAmmoCount",
      "GetPowerupWheelCount",
      "GetHitMarkerDamage",
      "Pmove",
      "ParseConfigString",
      "ParseCenterPrint",
      "ClearNotify",
      "ClearCenterprint",
      "NotifyMessage",
      "GetMonsterFlashOffset",
      "GetExtension",
    ];
    for (const slot of fnSlots) {
      expect(typeof api[slot]).toBe("function");
    }
  });

  test("GetExtension always returns null (cg_main.cpp:10-13's CG_GetExtension stub)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    expect(api.GetExtension("anything")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// weapon-wheel / hit-marker stat reads (cg_main.cpp:37-65)
// ---------------------------------------------------------------------------

describe("weapon wheel + hit marker stat reads", () => {
  test("GetActiveWeaponWheelWeapon reads STAT_ACTIVE_WHEEL_WEAPON directly (cg_main.cpp:37-40)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();
    ps.stats[PlayerStatT.STAT_ACTIVE_WHEEL_WEAPON] = 7;
    expect(api.GetActiveWeaponWheelWeapon(ps)).toBe(7);
  });

  test("GetOwnedWeaponWheelWeapons decodes the (uint16|uint16<<16) bit layout, including a value negative in the backing Int16Array (cg_main.cpp:42-45)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();

    // 0xabcd (43981) stored into a signed Int16Array wraps to -21555; the
    // decoder's `& 0xffff` must recover the unsigned bit pattern regardless.
    ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_1] = 0xabcd;
    ps.stats[PlayerStatT.STAT_WEAPONS_OWNED_2] = 0x1234;

    const expected = (0xabcd | (0x1234 << 16)) >>> 0;
    expect(api.GetOwnedWeaponWheelWeapons(ps)).toBe(expected);
  });

  test("GetWeaponWheelAmmoCount round-trips against p_hud.ts's G_SetAmmoStat encoder (bg_local.h:159-172), and maps AMMO_VALUE_INFINITE to -1", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();

    G_SetAmmoStat(ps.stats, PlayerStatT.STAT_AMMO_INFO_START, 3, 42);
    expect(api.GetWeaponWheelAmmoCount(ps, 3)).toBe(42);

    G_SetAmmoStat(ps.stats, PlayerStatT.STAT_AMMO_INFO_START, 5, AMMO_VALUE_INFINITE);
    expect(api.GetWeaponWheelAmmoCount(ps, 5)).toBe(-1);
  });

  test("GetPowerupWheelCount round-trips against p_hud.ts's G_SetPowerupStat encoder (bg_local.h:187-195)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();

    G_SetPowerupStat(ps.stats, STAT_POWERUP_INFO_START, 2, 3);
    expect(api.GetPowerupWheelCount(ps, 2)).toBe(3);
  });

  test("GetHitMarkerDamage reads STAT_HIT_MARKER directly (cg_main.cpp:62-65)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();
    ps.stats[PlayerStatT.STAT_HIT_MARKER] = 55;
    expect(api.GetHitMarkerDamage(ps)).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// null player_state_t / null pmove -- "unconditional dereference -> throw"
// ---------------------------------------------------------------------------

describe("null-pointer dereference convention", () => {
  test("every stat-reading KexCgameExports member throws on a null player_state_t", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);

    expect(() => api.GetActiveWeaponWheelWeapon(null)).toThrow();
    expect(() => api.GetOwnedWeaponWheelWeapons(null)).toThrow();
    expect(() => api.GetWeaponWheelAmmoCount(null, 0)).toThrow();
    expect(() => api.GetPowerupWheelCount(null, 0)).toThrow();
    expect(() => api.GetHitMarkerDamage(null)).toThrow();
    expect(() => api.LayoutFlags(null)).toThrow();
  });

  test("Pmove throws on a null pmove (cg_main.cpp:104: `cglobals.Pmove = Pmove;`, unconditional dereference)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    expect(() => api.Pmove(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// GetMonsterFlashOffset (cg_main.cpp:80-86)
// ---------------------------------------------------------------------------

describe("GetMonsterFlashOffset", () => {
  test("copies m_flash.ts's monsterFlashOffset() table entry into the output Vec3, for id=0, a middle id, and MZ2_LAST", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const table = monsterFlashOffset();

    for (const id of [0, MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1, MonsterMuzzleflashIdT.MZ2_LAST]) {
      const offset = vec3(999, 999, 999);
      api.GetMonsterFlashOffset(id, offset);
      expect(offset[0]).toBeCloseTo(table[id][0]);
      expect(offset[1]).toBeCloseTo(table[id][1]);
      expect(offset[2]).toBeCloseTo(table[id][2]);
    }
  });

  test("throws (via cgi.Com_Error) one past the last valid id (cg_main.cpp:82-83)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const table = monsterFlashOffset();
    expect(() => api.GetMonsterFlashOffset(table.length, vec3())).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CG_LayoutFlags (cg_screen.cpp:83-86)
// ---------------------------------------------------------------------------

describe("LayoutFlags", () => {
  test("returns ps.stats[STAT_LAYOUTS] verbatim", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    const ps = makePlayerState();
    ps.stats[PlayerStatT.STAT_LAYOUTS] = LayoutFlagsT.LAYOUTS_LAYOUT | LayoutFlagsT.LAYOUTS_HIDE_CROSSHAIR;
    expect(api.LayoutFlags(ps)).toBe(LayoutFlagsT.LAYOUTS_LAYOUT | LayoutFlagsT.LAYOUTS_HIDE_CROSSHAIR);
  });
});

// ---------------------------------------------------------------------------
// InitCGame / ParseConfigString (cg_main.cpp:19-27, 67-73)
// ---------------------------------------------------------------------------

describe("InitCGame / ParseConfigString", () => {
  test("Init() reads CONFIG_N64_PHYSICS/CS_AIRACCEL configstrings and registers HUD cvars without throwing", () => {
    const { imports, configstrings } = makeFakeImports();
    // CS_AIRACCEL is a real, exported index; the N64_PHYSICS index is
    // locally recomputed (see cg_main.ts's file header) so it isn't
    // directly settable here by name, but Init() must still tolerate an
    // unset ("") configstring for it without throwing.
    configstrings.set(CS_AIRACCEL, "10");

    const api = GetCGameAPI(imports);
    expect(() => api.Init()).not.toThrow();
    expect(() => api.Shutdown()).not.toThrow();
  });

  test("ParseConfigString accepts CS_AIRACCEL updates without throwing", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    api.Init();
    expect(() => api.ParseConfigString(CS_AIRACCEL, "20")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ParseCenterPrint (cg_screen.cpp:386-496)
// ---------------------------------------------------------------------------

describe("ParseCenterPrint", () => {
  test("splits a multi-line string into lines, echoing a bannered copy to the console, without throwing", () => {
    const { imports, comPrints } = makeFakeImports();
    const api = GetCGameAPI(imports);

    expect(() => api.ParseCenterPrint("Hello\nWorld", 0, true)).not.toThrow();

    // cg_screen.cpp:422-452: the console echo is wrapped in a decorative
    // banner (\x1D + thirty-five \x1E + \x1F) before and after the
    // reformatted text -- verify both the banner and both source lines
    // made it to Com_Print.
    const joined = comPrints.join("");
    expect(joined).toContain("\x1d");
    expect(joined).toContain("\x1f");
    expect(joined).toContain("Hello");
    expect(joined).toContain("World");
  });

  test("strips a leading %bind:key:purpose% prefix without throwing (cg_screen.cpp:404-420)", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    expect(() => api.ParseCenterPrint("%bind:+attack:Fire%Ready.", 0, true)).not.toThrow();
  });

  test("ClearCenterprint/ClearNotify never throw, before or after a parse", () => {
    const { imports } = makeFakeImports();
    const api = GetCGameAPI(imports);
    expect(() => api.ClearCenterprint(0)).not.toThrow();
    expect(() => api.ClearNotify(0)).not.toThrow();
    api.ParseCenterPrint("hi", 0, true);
    expect(() => api.ClearCenterprint(0)).not.toThrow();
    expect(() => api.ClearNotify(0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TouchPics (cg_screen.cpp:1755-1764)
// ---------------------------------------------------------------------------

describe("TouchPics", () => {
  test("registers all 22 sb_nums glyphs plus 'inventory'", () => {
    const { imports, registerPicCalls } = makeFakeImports();
    const api = GetCGameAPI(imports);
    api.TouchPics();

    expect(registerPicCalls).toContain("num_0");
    expect(registerPicCalls).toContain("num_minus");
    expect(registerPicCalls).toContain("anum_0");
    expect(registerPicCalls).toContain("anum_minus");
    expect(registerPicCalls).toContain("inventory");
    expect(registerPicCalls.length).toBe(23); // 2*11 sb_nums + "inventory"
  });
});

// ---------------------------------------------------------------------------
// DrawHUD end-to-end (cg_screen.cpp:1717-1747, via CG_ExecuteLayoutString
// and CG_DrawField)
// ---------------------------------------------------------------------------

describe("DrawHUD end-to-end", () => {
  test("a CS_STATUSBAR layout string with 'hnum' draws the health digits via sb_nums/SCR_DrawPic", () => {
    const { imports, configstrings, drawPicCalls } = makeFakeImports();
    // CS_STATUSBAR is index 5 (kexapi/game.ts) -- a minimal layout string
    // exercising the number-field path.
    configstrings.set(5, "xl 0 yb -24 hnum");

    const api = GetCGameAPI(imports);
    api.Init();

    const ps = makePlayerState();
    ps.stats[PlayerStatT.STAT_HEALTH] = 42; // > 25 -> color 0 ("green"/num_*)

    expect(() =>
      api.DrawHUD(0, { layout: "", inventory: new Int16Array(0) }, { x: 0, y: 0, width: 320, height: 240 }, { x: 0, y: 0, width: 0, height: 0 }, 1, 0, ps),
    ).not.toThrow();

    // "42" -> num_4, num_2 in row 0 (color 0 = sb_nums[0]).
    const names = drawPicCalls.map((c) => c.name);
    expect(names).toContain("num_4");
    expect(names).toContain("num_2");
  });
});
