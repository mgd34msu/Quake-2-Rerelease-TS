/*
Unit tests for the four rules the cross-module map sweep
(test/parity_map_sweep.test.ts) turned up and this port fixed, plus the
token-size rule behind the fourth. Each test states the C citation it is
pinning; the sweep itself proves the same rules end-to-end on the real
shipped maps, and is retail-gated. These are not.

  1. src/game/g_trigger.ts  -- InitTrigger / SP_trigger_multiple must not
     call gi.setmodel for a trigger with no brush model (g_trigger.cpp:21-24).
  2. src/game/g_newfnc.ts   -- func_plat2 spawnflag bit 8 is START_ACTIVE on
     re-release content (rogue/g_rogue_func.cpp:10, :391).
  3. src/game/p_client.ts   -- SelectSpawnPoint puts the player at the world
     origin instead of dropping the server when a map has no spawn point at
     all (p_client.cpp, SelectSpawnPoint's single-player branch).
  4. src/shared/math.ts + src/kexgame/q_std.ts -- COM_Parse's token cap is
     vanilla's 128 (q_shared.h:70) for src/game/ and the re-release's 512
     (game.h:122) for src/kexgame/.
*/

import { describe, expect, test } from "bun:test";
import { vec3, COM_Parse, type ComParseState } from "../src/shared/math";
import { COM_Parse as COM_Parse_kex, MAX_TOKEN_CHARS as KEX_MAX_TOKEN_CHARS } from "../src/kexgame/q_std";
import { CplaneT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { SolidT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, g_edicts, game, globals, level, SetGEdicts, st } from "../src/game/g_local";
import { InitTrigger, SP_trigger_multiple } from "../src/game/g_trigger";
import { SP_func_plat2 } from "../src/game/g_newfnc";
import { SelectSpawnPoint } from "../src/game/p_client";

// ---------------------------------------------------------------------------
// Fake GameImports -- same shape as test/g_func.test.ts's buildFakeImports,
// with gi.setmodel recording its calls so a test can assert it was NOT made.
// ---------------------------------------------------------------------------

interface SetmodelCallT {
  readonly num: number;
  readonly name: string;
}

let setmodelCalls: SetmodelCallT[] = [];

function defaultTrace(end: import("../src/shared/math").Vec3): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

function buildFakeImports(): GameImports {
  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: () => {},
    error: (fmt: string): never => {
      throw new Error(fmt);
    },
    modelindex: () => 0,
    soundindex: () => 0,
    imageindex: () => 0,
    setmodel: (ent, name) => {
      setmodelCalls.push({ num: ent.s.number, name });
    },
    trace: (_start, _mins, _maxs, end, _passent) => defaultTrace(end),
    pointcontents: () => 0,
    inPVS: () => true,
    inPHS: () => true,
    SetAreaPortalState: () => {},
    AreasConnected: () => true,
    linkentity: () => {},
    unlinkentity: () => {},
    BoxEdicts: () => 0,
    Pmove: () => {},
    multicast: () => {},
    unicast: () => {},
    WriteChar: () => {},
    WriteByte: () => {},
    WriteShort: () => {},
    WriteLong: () => {},
    WriteFloat: () => {},
    WriteString: () => {},
    WritePosition: () => {},
    WriteDir: () => {},
    WriteAngle: () => {},
    cvar: () => null,
    cvar_set: () => null,
    cvar_forceset: () => null,
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
  };
}

const MAXENTITIES = 32;

function setupWorld(): EdictT[] {
  GetGameAPI(buildFakeImports());

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();
  st.clear();

  globals.num_edicts = MAXENTITIES;
  setmodelCalls = [];
  return edicts;
}

// ---------------------------------------------------------------------------
// 1. a trigger with no brush model
// ---------------------------------------------------------------------------

describe("g_trigger.ts -- a trigger authored with no brush model (g_trigger.cpp:21-24)", () => {
  test("InitTrigger does not call gi.setmodel when ent.model is null, but still becomes a live trigger", () => {
    const edicts = setupWorld();
    const ent = edicts[5];
    expect(ent).toBeDefined();
    if (!ent) return;
    ent.classname = "trigger_coop_relay";
    ent.model = null;

    InitTrigger(ent);

    // The whole point: PF_setmodel opens with `if (!name) gi.error("PF_setmodel:
    // NULL")`, so making this call at all drops the server.
    expect(setmodelCalls).toEqual([]);
    // Everything else InitTrigger does still happens.
    expect(ent.solid).toBe(SolidT.SOLID_TRIGGER);
  });

  test("InitTrigger still calls gi.setmodel when the trigger has a model", () => {
    const edicts = setupWorld();
    const ent = edicts[6];
    expect(ent).toBeDefined();
    if (!ent) return;
    ent.classname = "trigger_once";
    ent.model = "*17";

    InitTrigger(ent);

    expect(setmodelCalls).toEqual([{ num: 6, name: "*17" }]);
  });

  test("SP_trigger_multiple (which inlines InitTrigger's body in vanilla) carries the same guard", () => {
    const edicts = setupWorld();
    const ent = edicts[7];
    expect(ent).toBeDefined();
    if (!ent) return;
    ent.classname = "trigger_once";
    ent.model = null;

    SP_trigger_multiple(ent);

    expect(setmodelCalls).toEqual([]);
    expect(ent.solid).toBe(SolidT.SOLID_TRIGGER);
    expect(ent.touch).not.toBeNull();
  });

  test("SP_trigger_multiple still calls gi.setmodel for the ordinary brush-model case", () => {
    const edicts = setupWorld();
    const ent = edicts[8];
    expect(ent).toBeDefined();
    if (!ent) return;
    ent.classname = "trigger_multiple";
    ent.model = "*3";

    SP_trigger_multiple(ent);

    expect(setmodelCalls).toEqual([{ num: 8, name: "*3" }]);
  });
});

// ---------------------------------------------------------------------------
// 2. func_plat2 spawnflag bit 8 == START_ACTIVE
// ---------------------------------------------------------------------------

/** STATE_TOP / STATE_BOTTOM, g_local.h's move_state_t (0 / 1 in both trees). */
const STATE_TOP = 0;
const STATE_BOTTOM = 1;

function makePlat2(num: number, targetname: string | null, spawnflags: number): EdictT {
  const edicts = setupWorld();
  const ent = edicts[num];
  if (!ent) throw new Error("no edict");
  ent.classname = "func_plat2";
  ent.model = "*11";
  ent.targetname = targetname;
  ent.spawnflags = spawnflags;
  ent.mins.set([-32, -32, 0]);
  ent.maxs.set([32, 32, 16]);
  ent.size.set([64, 64, 16]);
  ent.s.origin.set([0, 0, 128]);
  SP_func_plat2(ent);
  return ent;
}

describe("g_newfnc.ts -- func_plat2 START_ACTIVE (rogue/g_rogue_func.cpp:10, :391)", () => {
  test("targetname WITHOUT bit 8 parks the plat at STATE_TOP waiting to be activated by name (vanilla rogue g_func.c:54)", () => {
    const ent = makePlat2(9, "hg_plat1", 0);
    expect(ent.moveinfo.state).toBe(STATE_TOP);
  });

  test("targetname WITH bit 8 takes the else branch and starts the plat down at STATE_BOTTOM", () => {
    // spawnflags 9 is exactly what hangar1's "hg_plat1", jail1's
    // "trust_fall" and xcompnd2's "return_plat" carry -- the only three
    // func_plat2 entities in the re-release pak with a targetname and bit 8,
    // against zero in the 1997 tree's 130.
    const ent = makePlat2(10, "hg_plat1", 9);
    expect(ent.moveinfo.state).toBe(STATE_BOTTOM);
  });

  test("no targetname is unaffected -- still the else branch, still STATE_BOTTOM", () => {
    const ent = makePlat2(11, null, 0);
    expect(ent.moveinfo.state).toBe(STATE_BOTTOM);
  });

  test("bit 8 with PLAT2_TOP (4) still honours PLAT2_TOP and stays at STATE_TOP", () => {
    const ent = makePlat2(12, "hg_plat1", 8 | 4);
    expect(ent.moveinfo.state).toBe(STATE_TOP);
  });
});

// ---------------------------------------------------------------------------
// 3. SelectSpawnPoint on a map with no spawn point at all
// ---------------------------------------------------------------------------

describe("p_client.ts -- SelectSpawnPoint with no usable spawn point (p_client.cpp, SP branch)", () => {
  test("a world with no info_player_start returns the world origin instead of calling gi.error", () => {
    const edicts = setupWorld();
    const ent = edicts[1];
    expect(ent).toBeDefined();
    if (!ent) return;
    game.spawnpoint = "";

    const origin = vec3(111, 222, 333);
    const angles = vec3(44, 55, 66);

    // Vanilla ends the chain with gi.error("Couldn't find spawn point %s"),
    // and this fake's `error` throws -- so a regression here fails loudly.
    expect(() => {
      SelectSpawnPoint(ent, origin, angles);
    }).not.toThrow();

    expect(Array.from(origin)).toEqual([0, 0, 0]);
    expect(Array.from(angles)).toEqual([0, 0, 0]);
  });

  test("an ordinary map is unchanged: the spawn point's origin, plus vanilla's +9 z nudge (p_client.c:911)", () => {
    const edicts = setupWorld();
    const ent = edicts[1];
    const spot = edicts[4];
    expect(ent).toBeDefined();
    expect(spot).toBeDefined();
    if (!ent || !spot) return;

    spot.inuse = true;
    spot.classname = "info_player_start";
    spot.targetname = null;
    spot.s.origin.set([128, -320, 24]);
    spot.s.angles.set([0, 90, 0]);
    game.spawnpoint = "";

    const origin = vec3(0, 0, 0);
    const angles = vec3(0, 0, 0);
    SelectSpawnPoint(ent, origin, angles);

    expect(Array.from(origin)).toEqual([128, -320, 33]);
    expect(Array.from(angles)).toEqual([0, 90, 0]);
  });
});

// ---------------------------------------------------------------------------
// 4. COM_Parse's token cap: 128 for vanilla, 512 for the re-release
// ---------------------------------------------------------------------------

/** mgu1m5's real worldspawn "start_items" value -- 151 characters. */
const MGU1M5_START_ITEMS =
  "weapon_shotgun;weapon_railgun;weapon_machinegun;weapon_chaingun;weapon_rocketlauncher;weapon_hyperblaster;weapon_supershotgun;weapon_phalanx;weapon_bfg";

describe("COM_Parse token cap -- q_shared.h:70 (128) vs game.h:122 (512)", () => {
  test("this port's own survey: the shipped value that exposed the difference is longer than 128 and shorter than 512", () => {
    expect(MGU1M5_START_ITEMS.length).toBe(151);
    expect(KEX_MAX_TOKEN_CHARS).toBe(512);
  });

  test("the shared parser still truncates a quoted token at vanilla's 128 by default", () => {
    const state: ComParseState = { data: `"${MGU1M5_START_ITEMS}"`, index: 0 };
    const token = COM_Parse(state);
    expect(token.length).toBe(128);
    // Cut mid-word, which is what made Player_GiveStartItems report an item
    // literally named "we".
    expect(token.endsWith("weapon_supershotgun;we")).toBe(true);
  });

  test("the re-release parser returns the whole value", () => {
    const state: ComParseState = { data: `"${MGU1M5_START_ITEMS}"`, index: 0 };
    expect(COM_Parse_kex(state)).toBe(MGU1M5_START_ITEMS);
  });

  test("both parsers agree on every token shorter than 128, so no vanilla behaviour moved", () => {
    const cases = ["weapon_shotgun", "info_player_start", '"a quoted value with spaces"', "*17", ""];
    for (const c of cases) {
      const a: ComParseState = { data: c, index: 0 };
      const b: ComParseState = { data: c, index: 0 };
      expect(COM_Parse_kex(b)).toBe(COM_Parse(a));
    }
  });

  test("the re-release parser still truncates at ITS cap, 512", () => {
    const long = "x".repeat(600);
    const state: ComParseState = { data: `"${long}"`, index: 0 };
    expect(COM_Parse_kex(state).length).toBe(512);
  });
});
