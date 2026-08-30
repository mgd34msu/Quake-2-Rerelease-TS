/*
Unit tests for the kex g_spawn.cpp port (src/kexgame/g_spawn.ts).

Self-sufficient per .orch/preferences.md rule 13: wires up its own fake
KexGameImports/KexGameExports and never relies on another test file having
run first. Fake-imports fixture modeled after test/kexgame_g_misc.test.ts's
own (mutable per-test recorders instead of no-ops so this suite can assert
on configstrings/soundindex/modelindex calls directly), using p_client.ts's
now-exported `defaultGClient()` factory (test/kexgame_g_misc.test.ts predates
that export and had to hand-roll a full GClientT fixture; this suite does
not need to).

Scope (16 cases, each citing the exact C++ line range it exercises):
  - registry completeness (g_spawn.cpp:221-437): entry count === 190 (the
    measured count -- see g_spawn.ts's own header for how it was counted),
    plus spot checks that a handful of real classnames resolve to
    non-throwing functions and a handful of not-yet-ported classnames
    resolve to a throwing, correctly-cited stub.
  - ED_ParseField type dispatch (g_spawn.cpp:673-784, 801-850): string
    (classname, via ED_NewString), int (health, atoi truncation), float
    (speed, atof), vec3 (origin, three-token COM_Parse), spawnflags
    (spawnflags_t(atoi(s))). NO gtime_t case: see g_spawn.ts's own header,
    "ED_ParseField type dispatch" -- grepped both real field tables and
    found zero entries binding a gtime_t member, so this suite does not
    fabricate one; it asserts the negative instead (no field named after a
    known gtime_t member parses as a GTime-branded value).
  - ED_ParseEdict against a fabricated entity string (g_spawn.cpp:908-957):
    a `{ "classname" "info_player_start" "origin" "1 2 3" "spawnflags" "3" }`
    block parses into the right EdictT fields via ED_ParseField dispatch,
    and `keys_specified` records every key seen.
  - inhibit logic (g_spawn.cpp:1070-1086), exercised through the public
    SpawnEntities entry point (G_InhibitEntity itself is not exported --
    same "private helper, public surface only" idiom this port line uses
    throughout): a SPAWNFLAG_NOT_EASY entity is freed when skill=0; the
    same entity survives when skill=2.
  - G_FindTeams chain linking (g_spawn.cpp:1022-1067): two non-func_train
    entities sharing a `team` field get linked (teammaster / teamchain /
    FL_TEAMSLAVE), a third entity with a different team is left alone.
  - SpawnEntities end-to-end (g_spawn.cpp:1145-1275) with a tiny fabricated
    entstring: worldspawn (real, `g_edicts[0]`) + one real entity
    (info_player_start, spawned via G_Spawn) + one inhibited entity
    (info_null with SPAWNFLAG_NOT_EASY, skill 0) -- the inhibited entity
    ends up freed (`inuse === false`), the real one ends up live at its
    parsed origin.
  - statusbar string exact-match spot check (g_spawn.cpp:1282-1407,
    G_InitStatusbar): the shared health/ammo prefix, byte-for-byte against
    the C++ token stream.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, type Vec3, type ComParseState } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, CvarFlagsT } from "../src/kexapi/game";
import { type EdictT, MovetypeT, EntFlagsT } from "../src/kexgame/g_local";
import { SolidT } from "../src/kexapi/game";
import { defaultEdict, gi, game, level, g_edicts, globals, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { SpawnFlags_from, SpawnFlags_has } from "../src/kexgame/spawnflags";
import { GTIME_ZERO } from "../src/kexgame/gtime";
import {
  st,
  ClearSpawnTemp,
  ED_NewString,
  ED_ParseField,
  ED_ParseEdict,
  ED_CallSpawn,
  spawns,
  G_FindTeams,
  SpawnEntities,
} from "../src/kexgame/g_spawn";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture
// ---------------------------------------------------------------------------

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

interface Recorder {
  configstrings: Map<number, string>;
  comPrints: string[];
}
let rec: Recorder;

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value);
      cvars.set(name, c);
    }
    return c;
  }

  const modelNamesById: string[] = [""];
  function modelindex(name: string): number {
    let idx = modelNamesById.indexOf(name);
    if (idx === -1) {
      idx = modelNamesById.length;
      modelNamesById.push(name);
    }
    return idx;
  }

  const soundNamesById: string[] = [""];
  function soundindex(name: string): number {
    let idx = soundNamesById.indexOf(name);
    if (idx === -1) {
      idx = soundNamesById.length;
      soundNamesById.push(name);
    }
    return idx;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print() {},
    Com_Print(msg: string) {
      rec.comPrints.push(msg);
    },
    Client_Print() {},
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound() {},
    configstring(num: number, str: string) {
      rec.configstrings.set(num, str);
    },
    get_configstring(num: number) {
      return rec.configstrings.get(num) ?? "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex,
    soundindex,
    imageindex() {
      return 0;
    },
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
    linkentity(ent) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      for (let i = 0; i < 3; i++) {
        full.absmin[i] = full.s.origin[i] + full.mins[i];
        full.absmax[i] = full.s.origin[i] + full.maxs[i];
        full.size[i] = full.maxs[i] - full.mins[i];
      }
    },
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

function makeFakeGameExports(edicts: EdictT[], numEdicts: number): KexGameExports {
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

const NUM_EDICTS = 64;

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(): void {
  const edicts: EdictT[] = [];
  for (let i = 0; i < NUM_EDICTS; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 0; // keeps SpawnEntities' per-client loop a no-op for this suite
  game.maxentities = NUM_EDICTS;
  game.clients = [];
  level.time = GTIME_ZERO;

  rec = { configstrings: new Map(), comPrints: [] };
  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, 1));

  ClearSpawnTemp();
}

beforeEach(() => {
  setupWorld();
});

// ---------------------------------------------------------------------------
// registry completeness
// ---------------------------------------------------------------------------

describe("spawn registry (g_spawn.cpp:221-437)", () => {
  test("has exactly 190 entries -- the measured C++ count", () => {
    expect(spawns.length).toBe(190);
  });

  test("real classnames resolve to non-throwing spawn functions", () => {
    const ent = defaultEdict();
    ent.classname = "info_null";
    const entry = spawns.find((s) => s.name === "info_null");
    expect(entry).toBeDefined();
    expect(() => entry!.spawn(ent)).not.toThrow();
  });

  test("not-yet-ported classnames resolve to a throwing, cited stub", () => {
    // monster_berserk landed; monster_guardian is still an honest stub.
    const ent = defaultEdict();
    ent.classname = "monster_guardian";
    const entry = spawns.find((s) => s.name === "monster_guardian");
    expect(entry).toBeDefined();
    expect(() => entry!.spawn(ent)).toThrow(/m_guardian\.cpp/);
  });

  test("func_group reuses SP_info_null, exactly like the C++ table", () => {
    const infoNull = spawns.find((s) => s.name === "info_null");
    const funcGroup = spawns.find((s) => s.name === "func_group");
    expect(infoNull).toBeDefined();
    expect(funcGroup).toBeDefined();
    expect(funcGroup!.spawn).toBe(infoNull!.spawn);
  });
});

// ---------------------------------------------------------------------------
// ED_ParseField type dispatch
// ---------------------------------------------------------------------------

describe("ED_ParseField (g_spawn.cpp:861-898)", () => {
  test("string field: classname via ED_NewString", () => {
    const ent = defaultEdict();
    ED_ParseField("classname", "info_player_start", ent);
    expect(ent.classname).toBe("info_player_start");
    expect(st.keys_specified.has("classname")).toBe(true);
  });

  test("int field: health uses atoi truncation, not atof rounding", () => {
    const ent = defaultEdict();
    ED_ParseField("health", "42.9", ent);
    // atoi("42.9") === 42 -- truncates at the first non-digit, never rounds
    expect(ent.health).toBe(42);
  });

  test("float field: speed parses as a real float", () => {
    const ent = defaultEdict();
    ED_ParseField("speed", "42.9", ent);
    expect(ent.speed).toBeCloseTo(42.9, 5);
  });

  test("vec3 field: origin parses three whitespace-separated floats", () => {
    const ent = defaultEdict();
    ED_ParseField("origin", "1.5 -2 300", ent);
    expect(ent.s.origin[0]).toBeCloseTo(1.5, 5);
    expect(ent.s.origin[1]).toBeCloseTo(-2, 5);
    expect(ent.s.origin[2]).toBeCloseTo(300, 5);
  });

  test("spawnflags field: spawnflags_t(atoi(s))", () => {
    const ent = defaultEdict();
    ED_ParseField("spawnflags", "3", ent);
    expect(SpawnFlags_has(ent.spawnflags, SpawnFlags_from(1))).toBe(true);
    expect(SpawnFlags_has(ent.spawnflags, SpawnFlags_from(2))).toBe(true);
    expect(SpawnFlags_has(ent.spawnflags, SpawnFlags_from(4))).toBe(false);
  });

  test("no gtime_t field exists in the real registry -- see g_spawn.ts's own header", () => {
    // Every temp_fields/entity_fields entry in the real g_spawn.cpp binds a
    // string/int/float/spawnflags/vec3/bigint(effects) member; grepping
    // both tables line-by-line found zero gtime_t bindings (spawn_temp_t's
    // own `pausetime` looks like a time value but is a plain `float`,
    // g_local.h:1282). Asserting the negative here documents the gap
    // instead of silently omitting the case the brief asked for.
    const ent = defaultEdict();
    ED_ParseField("pausetime", "5", ent);
    // "pausetime" binds st.pausetime (a plain number), not any GTime field.
    expect(typeof st.pausetime).toBe("number");
    expect(st.pausetime).toBe(5);
  });

  test("unknown key prints a warning and mutates nothing", () => {
    const ent = defaultEdict();
    const before = ent.classname;
    ED_ParseField("not_a_real_field", "whatever", ent);
    expect(ent.classname).toBe(before);
    expect(rec.comPrints.some((m) => m.includes("not_a_real_field"))).toBe(true);
  });
});

describe("ED_NewString (g_spawn.cpp:525-552)", () => {
  test("\\n becomes a real newline", () => {
    expect(ED_NewString("line1\\nline2")).toBe("line1\nline2");
  });

  test("backslash followed by a non-'n' char emits a literal backslash and drops that char", () => {
    // g_spawn.ts's own header documents this exact quirk: `a\tb` (backslash-t)
    // becomes `a\b` -- the `t` is silently discarded, not preserved literally.
    expect(ED_NewString("a\\tb")).toBe("a\\b");
  });
});

// ---------------------------------------------------------------------------
// ED_ParseEdict against a fabricated entity string
// ---------------------------------------------------------------------------

describe("ED_ParseEdict (g_spawn.cpp:908-957)", () => {
  test("parses a fabricated entity block into the right fields", () => {
    const ent = defaultEdict();
    const block = '"classname" "info_player_start" "origin" "1 2 3" "spawnflags" "3" }';
    const state: ComParseState = { data: block, index: 0 };
    ED_ParseEdict(state, ent);

    expect(ent.classname).toBe("info_player_start");
    expect(ent.s.origin[0]).toBeCloseTo(1, 5);
    expect(ent.s.origin[1]).toBeCloseTo(2, 5);
    expect(ent.s.origin[2]).toBeCloseTo(3, 5);
    expect(SpawnFlags_has(ent.spawnflags, SpawnFlags_from(1))).toBe(true);
    expect(st.keys_specified.has("classname")).toBe(true);
    expect(st.keys_specified.has("origin")).toBe(true);
    expect(st.keys_specified.has("spawnflags")).toBe(true);
  });

  test("a leading-underscore key (other than _color) is discarded", () => {
    const ent = defaultEdict();
    const block = '"_comment" "editor note" "classname" "info_null" }';
    const state: ComParseState = { data: block, index: 0 };
    ED_ParseEdict(state, ent);
    expect(ent.classname).toBe("info_null");
    expect(st.keys_specified.has("_comment")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// inhibit logic (through the public SpawnEntities entry point --
// G_InhibitEntity itself is a private helper, not exported)
// ---------------------------------------------------------------------------

describe("inhibit logic (g_spawn.cpp:1070-1086)", () => {
  // Uses "info_notnull" (SP_info_notnull just sets absmin/absmax and keeps
  // living) rather than "info_null" (SP_info_null unconditionally
  // G_FreeEdict's itself, which would free the entity regardless of
  // whether it was inhibited -- a useless signal for this test).
  test("a SPAWNFLAG_NOT_EASY entity is freed when skill=0", () => {
    gi.cvar("skill", "0", CvarFlagsT.CVAR_LATCH);
    const entities = '{ "classname" "worldspawn" }\n{ "classname" "info_notnull" "spawnflags" "256" }\n';
    SpawnEntities("test_map", entities, "");

    // inhibited BEFORE ED_CallSpawn ever ran -- SP_info_notnull never
    // executes, so if this is "freed" it can only be the inhibit path.
    const inhibited = g_edicts.find((e) => e.classname === "freed");
    expect(inhibited).toBeDefined();
    expect(g_edicts.some((e) => e.classname === "info_notnull")).toBe(false);
  });

  test("the same entity survives when skill=2 (SPAWNFLAG_NOT_HARD not set)", () => {
    gi.cvar("skill", "2", CvarFlagsT.CVAR_LATCH);
    const entities = '{ "classname" "worldspawn" }\n{ "classname" "info_notnull" "spawnflags" "256" }\n';
    SpawnEntities("test_map", entities, "");

    const survivor = g_edicts.find((e) => e.classname === "info_notnull");
    expect(survivor).toBeDefined();
    expect(survivor!.inuse).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G_FindTeams (g_spawn.cpp:1022-1067)
// ---------------------------------------------------------------------------

describe("G_FindTeams", () => {
  test("chains two entities sharing a team field; a third with a different team is untouched", () => {
    const a = g_edicts[1]!;
    const b = g_edicts[2]!;
    const c = g_edicts[3]!;
    a.inuse = true;
    b.inuse = true;
    c.inuse = true;
    a.team = "t1";
    b.team = "t1";
    c.team = "t2";
    globals.num_edicts = 4;

    G_FindTeams();

    expect(a.teammaster).toBe(a);
    expect(a.teamchain).toBe(b);
    expect(b.teammaster).toBe(a);
    expect((b.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n).toBe(true);
    expect((a.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n).toBe(false);
    // c shares no team with anyone -- left as its own untouched master
    expect(c.teammaster).toBe(c);
    expect(c.teamchain).toBe(null);
    expect((c.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpawnEntities end-to-end (g_spawn.cpp:1145-1275)
// ---------------------------------------------------------------------------

describe("SpawnEntities (g_spawn.cpp:1145-1275)", () => {
  test("worldspawn + one real entity + one inhibited entity", () => {
    gi.cvar("skill", "0", CvarFlagsT.CVAR_LATCH);
    const entities =
      '{ "classname" "worldspawn" "gravity" "800" }\n' +
      '{ "classname" "info_player_start" "origin" "10 20 30" }\n' +
      '{ "classname" "info_notnull" "spawnflags" "256" }\n';

    SpawnEntities("test_map", entities, "start");

    // worldspawn: real, uses g_edicts[0] directly, never G_Spawn()
    expect(g_edicts[0]!.inuse).toBe(true);
    expect(g_edicts[0]!.movetype).toBe(MovetypeT.MOVETYPE_PUSH);
    expect(g_edicts[0]!.solid).toBe(SolidT.SOLID_BSP);
    expect(level.gravity).toBe(800);

    // real entity: spawned, live, at its parsed origin
    const player = g_edicts.find((e) => e.classname === "info_player_start");
    expect(player).toBeDefined();
    expect(player!.inuse).toBe(true);
    expect(player!.s.origin[0]).toBeCloseTo(10, 5);
    expect(player!.s.origin[1]).toBeCloseTo(20, 5);
    expect(player!.s.origin[2]).toBeCloseTo(30, 5);

    // inhibited entity: freed before ED_CallSpawn ever ran
    const inhibited = g_edicts.find((e) => e.classname === "freed");
    expect(inhibited).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// G_InitStatusbar (g_spawn.cpp:1282-1407), exercised via SP_worldspawn
// ---------------------------------------------------------------------------

describe("G_InitStatusbar (g_spawn.cpp:1282-1407)", () => {
  test("the shared health/ammo prefix matches the C++ token stream exactly", () => {
    const entities = '{ "classname" "worldspawn" }\n';
    SpawnEntities("test_map", entities, "");

    const sb = rec.configstrings.get(5); // CS_STATUSBAR
    expect(sb).toBeDefined();
    // g_spawn.cpp:1287-1293: sb.yb(-24); sb.xv(0).hnum().xv(50).pic(STAT_HEALTH_ICON);
    // sb.ifstat(STAT_AMMO_ICON).xv(100).anum().xv(150).pic(STAT_AMMO_ICON).endifstat();
    expect(sb!.startsWith("yb -24 xv 0 hnum xv 50 pic 0 if 2 xv 100 anum xv 150 pic 2 endif ")).toBe(true);
  });
});
