/*
Task: "the sky rotates when the map says it should not" -- worldspawn's
skyautorotate key (default 1) makes CS_SKYROTATE's write side family-
dependent: q2repro's own CL_SetSky (src/client/precache.c:374) parses
CS_SKYROTATE as "<rotate> <autorotate>" (two tokens) whenever the session is
on the wide/rerelease configstring layout, and as a bare "<rotate>" float
otherwise. src/kexgame/g_spawn.ts's SP_worldspawn already wrote the
two-token form unconditionally; src/game/g_spawn.ts (the CLASSIC 3.21
module, which also has to run WIDE-layout rerelease content when a session
widens) used to write ONLY the bare float, dropping skyautorotate on the
floor for a classic-module session running rerelease content.

Self-sufficient per the project's own "self-sufficient test files" rule:
wires up its own minimal fake GameImports (classic module) and
KexGameImports/KexGameExports (kex module) rather than importing another
test file's fixtures. The kex-module fixture is a trimmed copy of
test/kexgame_g_spawn.test.ts's own makeFakeGameImports/makeFakeGameExports/
setupWorld, cited at each function.

Two checks:
  1. PARITY (wide layout): the same worldspawn skyrotate/skyaxis/
     skyautorotate keys produce byte-identical CS_SKYROTATE content out of
     both game modules. The fixture values (rotate=250, autorotate=0,
     axis="0 0 1") are the real values measured in the retail install's
     maps/base1.bsp worldspawn (see this task's own verification script) --
     a 1997 map, re-released with a FIXED 250-degree sky offset that must
     never spin.
  2. NARROW FIDELITY: on the classic/narrow layout (no gi.extended_layout,
     matching every 1997 session and matching this port's existing
     buildFakeImports fixtures elsewhere, which never stub it), the classic
     module keeps emitting exactly the old bare `%f` string -- proving the
     new two-token branch is unreachable for 1997 content, not just unused.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { EdictT, game, gameCvars, globals, level, SetGEdicts, st as classicSt } from "../src/game/g_local";
import { SpawnEntities as ClassicSpawnEntities } from "../src/game/g_spawn";
import { InitItems } from "../src/game/g_items";

import type { KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION } from "../src/kexapi/game";
import { type EdictT as KexEdictImpl } from "../src/kexgame/g_local";
import { defaultEdict, game as kexGame, level as kexLevel, SetGameImports, SetGameExports, SetGEdicts as kexSetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO } from "../src/kexgame/gtime";
import { SpawnEntities as KexSpawnEntities } from "../src/kexgame/g_spawn";

// ---------------------------------------------------------------------------
// CLASSIC module fixture (trimmed copy of test/g_spawn.test.ts's own shape)
// ---------------------------------------------------------------------------

interface ClassicRecorder {
  configstring: Array<{ num: number; str: string }>;
  error: string[];
  wide: boolean;
}

function fakeCvar(value: number, str = ""): CvarT {
  const c = new CvarT();
  c.value = value;
  c.string = str;
  return c;
}

function buildClassicImports(rec: ClassicRecorder): GameImports {
  const trace: GTraceT = {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };

  return {
    bprintf: () => {},
    dprintf: () => {},
    cprintf: () => {},
    centerprintf: () => {},
    sound: () => {},
    positioned_sound: () => {},
    configstring: (num: number, str: string) => {
      rec.configstring.push({ num, str });
    },
    error: (fmt: string): never => {
      rec.error.push(fmt);
      throw new Error(fmt);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 1,
    setmodel: () => {},
    trace: () => trace,
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
    cvar: () => fakeCvar(0),
    cvar_set: (name: string, value: string) => {
      return fakeCvar(0, value);
    },
    cvar_forceset: (name: string, value: string) => {
      return fakeCvar(0, value);
    },
    argc: () => 0,
    argv: () => "",
    args: () => "",
    AddCommandString: () => {},
    DebugGraph: () => {},
    // task's own gate: this module mirrors sv_init.ts's session-wide
    // "content-driven layout choice" through this optional hook.
    extended_layout: () => rec.wide,
  };
}

const MAXENTITIES = 64;
const MAXCLIENTS = 1;

function setupClassicWorld(rec: ClassicRecorder): void {
  GetGameAPI(buildClassicImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.num_items = 0;

  level.clear();
  classicSt.clear();

  for (const key of Object.keys(gameCvars) as Array<keyof typeof gameCvars>) {
    gameCvars[key] = null;
  }
  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.coop = fakeCvar(0);

  globals.num_edicts = MAXCLIENTS + 1;
}

// ---------------------------------------------------------------------------
// KEX module fixture (trimmed copy of test/kexgame_g_spawn.test.ts's own
// makeFakeGameImports/makeFakeGameExports/setupWorld)
// ---------------------------------------------------------------------------

interface KexRecorder {
  configstrings: Map<number, string>;
}
let kexRec: KexRecorder;

function noHitTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

function makeKexImports(): KexGameImports {
  function getCvar(name: string, value: string): CvarT {
    const c = new CvarT();
    c.name = name;
    c.string = value;
    c.value = Number(value);
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound() {},
    configstring(num: number, str: string) {
      kexRec.configstrings.set(num, str);
    },
    get_configstring(num: number) {
      return kexRec.configstrings.get(num) ?? "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex: () => 1,
    soundindex: () => 1,
    imageindex: () => 1,
    setmodel() {},
    trace(_start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    clip(_entity, _start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    pointcontents() {
      return 0;
    },
    inPVS() {
      return false;
    },
    inPHS() {
      return false;
    },
    SetAreaPortalState() {},
    AreasConnected() {
      return false;
    },
    linkentity() {},
    unlinkentity() {},
    BoxEdicts() {
      return 0;
    },
    multicast() {},
    unicast() {},
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString() {},
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    WriteEntity() {},
    TagMalloc() {
      return null;
    },
    TagFree() {},
    FreeTags() {},
    cvar(var_name, value) {
      return getCvar(var_name, value ?? "0");
    },
    cvar_set(var_name, value) {
      return getCvar(var_name, value);
    },
    cvar_forceset(var_name, value) {
      return getCvar(var_name, value);
    },
    argc() {
      return 0;
    },
    argv() {
      return "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
    GetExtension() {
      return null;
    },
    Bot_RegisterEdict() {},
    Bot_UnRegisterEdict() {},
    Bot_MoveToPoint() {
      return 0;
    },
    Bot_FollowActor() {
      return 0;
    },
    GetPathToGoal() {
      return false;
    },
    Loc_Print() {},
    Draw_Line() {},
    Draw_Point() {},
    Draw_Circle() {},
    Draw_Bounds() {},
    Draw_Sphere() {},
    Draw_OrientedWorldText() {},
    Draw_StaticWorldText() {},
    Draw_Cylinder() {},
    Draw_Ray() {},
    Draw_Arrow() {},
    ReportMatchDetails_Multicast() {},
    ServerFrame() {
      return 0;
    },
    SendToClipBoard() {},
    Info_ValueForKey() {
      return 0;
    },
    Info_RemoveKey() {
      return false;
    },
    Info_SetValueForKey() {
      return false;
    },
  };
}

function makeKexExports(edicts: KexEdictImpl[], numEdicts: number): KexGameExports {
  return {
    apiversion: GAME_API_VERSION,
    PreInit() {},
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGameJson() {
      return null;
    },
    ReadGameJson() {},
    WriteLevelJson() {
      return null;
    },
    ReadLevelJson() {},
    CanSave() {
      return true;
    },
    ClientChooseSlot() {
      return null;
    },
    ClientConnect() {
      return false;
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    PrepFrame() {},
    ServerCommand() {},
    edicts,
    num_edicts: numEdicts,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove() {},
    GetExtension() {
      return null;
    },
    Bot_SetWeapon() {},
    Bot_TriggerEdict() {},
    Bot_UseItem() {},
    Bot_GetItemID() {
      return 0;
    },
    Edict_ForceLookAtPoint() {},
    Bot_PickedUpItem() {
      return false;
    },
    Entity_IsVisibleToPlayer() {
      return false;
    },
    GetShadowLightData() {
      return null;
    },
  };
}

const KEX_NUM_EDICTS = 64;

function setupKexWorld(): void {
  const edicts: KexEdictImpl[] = [];
  for (let i = 0; i < KEX_NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  kexSetGEdicts(edicts);
  kexGame.maxclients = 0;
  kexGame.maxentities = KEX_NUM_EDICTS;
  kexGame.clients = [];
  kexLevel.time = GTIME_ZERO;

  kexRec = { configstrings: new Map() };
  SetGameImports(makeKexImports());
  SetGameExports(makeKexExports(edicts, 1));
}

// ---------------------------------------------------------------------------
// The measured retail fixture: maps/base1.bsp's real worldspawn keys (see
// this task's own PACK/BSP-entity-lump extraction script) -- a 1997 map
// carrying a FIXED (non-spinning) 250-degree sky offset.
// ---------------------------------------------------------------------------

const SKY_ENTITY_KEYS = '"sky" "unit1_" "skyrotate" "250" "skyaxis" "0 0 1" "skyautorotate" "0"';

describe("CS_SKYROTATE emission parity: classic module (g_spawn.ts) vs kex module (kexgame/g_spawn.ts)", () => {
  test("WIDE layout: both modules emit the identical two-token '<rotate> <autorotate>' string for the same worldspawn keys", () => {
    // classic module, wide session
    const classicRec: ClassicRecorder = { configstring: [], error: [], wide: true };
    setupClassicWorld(classicRec);
    InitItems();
    const entities = `{ "classname" "worldspawn" ${SKY_ENTITY_KEYS} }`;
    ClassicSpawnEntities("base1", entities, "");
    const classicSkyRotate = classicRec.configstring.find((c) => c.num === 4 /* CS_SKYROTATE */)?.str;

    // kex module (always wide -- it has no narrow mode)
    setupKexWorld();
    KexSpawnEntities("base1", entities, "");
    const kexSkyRotate = kexRec.configstrings.get(4 /* CS_SKYROTATE */);

    expect(classicSkyRotate).toBeDefined();
    expect(kexSkyRotate).toBeDefined();
    expect(classicSkyRotate).toBe(kexSkyRotate);
    expect(classicSkyRotate).toBe("250 0");
  });
});

describe("CS_SKYROTATE emission: classic module (g_spawn.ts), NARROW layout", () => {
  test("without gi.extended_layout (every 1997-content session): CS_SKYROTATE stays the bare Com_sprintf('%f', ...) form, exactly as before this task", () => {
    const classicRec: ClassicRecorder = { configstring: [], error: [], wide: false };
    setupClassicWorld(classicRec);
    InitItems();
    const entities = `{ "classname" "worldspawn" ${SKY_ENTITY_KEYS} }`;
    ClassicSpawnEntities("base1", entities, "");
    const skyRotate = classicRec.configstring.find((c) => c.num === 4 /* CS_SKYROTATE */)?.str;

    // Com_sprintf("%f", 250) -- six decimal places, no autorotate token at
    // all, even though the entity string above sets skyautorotate=0.
    expect(skyRotate).toBe("250.000000");
  });
});
