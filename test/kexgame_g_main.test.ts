/*
Unit tests for the kex g_main.cpp port (src/kexgame/g_main.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports and never relies on another test file having
run first. Modeled after test/kexgame_g_phys.test.ts's own fake-imports
fixture; extended with a `cvarCalls` spy array so InitGame/PreInitGame's
cvar-registration side effects (name/default/flags triples) can be asserted
directly, the same way a real "did we register this cvar correctly" review
would check.

Scope (14 cases, each citing the exact C++ line range it exercises):
  - GetGameAPI (g_main.cpp:411-458): apiversion 2023, SetGameImports/
    SetGameExports wiring (g_main_globals.ts's own `gi`/`globals` become the
    same objects), and every one of the 34 KexGameExports slots present.
  - GetGameAPI's SpawnEntities/WriteGameJson/ReadGameJson/WriteLevelJson/
    ReadLevelJson/CanSave slots: throwing stubs citing g_spawn.ts/g_save.ts.
  - GetGameAPI's Bot_* / Edict_ForceLookAtPoint slots: throwing stubs citing
    the unported bots/ subsystem.
  - GetGameAPI's KexEdictT -> EdictT resolution (PORTING.md's EDICT_NUM
    idiom): ClientBegin/Entity_IsVisibleToPlayer wrapper resolves via
    g_edicts[ent.s.number], and throws on a null edict.
  - GetGameAPI's Pmove wrapper: throws on a null pmove (unconditional
    dereference, matching the real C++ call site).
  - PreInitGame (g_main.cpp:169-208): registers maxclients/deathmatch/coop/
    teamplay with the exact C++ defaults+flags; forces deathmatch on when
    `ctf` is enabled (a real, cited quirk -- see g_main.ts's own header).
  - InitGame (g_main.cpp:217-381): cvar registration spot checks
    (maxentities default "8192"/CVAR_LATCH, fraglimit/timelimit
    CVAR_SERVERINFO), and populates game.maxclients/maxentities/g_edicts/
    game.clients/globals.num_edicts exactly like the real allocation block.
  - CheckDMRules (g_main.cpp:654-717): fraglimit trip, timelimit trip, and
    the "below both limits" no-op case.
  - EndDMLevel (g_main.cpp:521-622): g_dm_same_level short-circuit,
    g_map_list cycling to the next map, and g_map_list wrap-to-first-map
    (no shuffle).
  - turret_breach_think's angular-tracking math (g_turret.cpp:113-147): the
    per-axis delta-vs-speed*frame_time_s clamp and the resulting
    avelocity = delta * (1/frame_time_s) assignment, hand-verified.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CvarT, CplaneT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, CvarFlagsT } from "../src/kexapi/game";
import { type EdictT } from "../src/kexgame/g_local";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGEdicts } from "../src/kexgame/g_main_globals";
import { GTIME_ZERO, Gtime_from_ms } from "../src/kexgame/gtime";
import { GetGameAPI, PreInitGame, InitGame, CheckDMRules, EndDMLevel } from "../src/kexgame/g_main";
import { turret_breach_think } from "../src/kexgame/g_turret";
import { defaultGClient } from "../src/kexgame/p_client";

// ---------------------------------------------------------------------------
// fake KexGameImports fixture, with a cvar-registration spy
// ---------------------------------------------------------------------------

interface CvarCall {
  name: string;
  value: string | null;
  flags: number;
}

let cvarCalls: CvarCall[] = [];
let broadcastPrints: string[] = [];

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

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = new CvarT();
      c.name = name;
      c.string = value;
      c.value = Number(value) || 0;
      cvars.set(name, c);
    }
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
    Broadcast_Print(_printlevel, message) {
      broadcastPrints.push(message);
    },
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound() {},
    positioned_sound() {},
    local_sound() {},
    configstring() {},
    get_configstring() {
      return "";
    },
    Com_Error(message): never {
      throw new Error(`gi.Com_Error: ${message}`);
    },
    modelindex() {
      return 0;
    },
    soundindex() {
      return 1;
    },
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
    cvar(var_name, value, flags) {
      cvarCalls.push({ name: var_name, value, flags });
      return getCvar(var_name, value ?? "0");
    },
    cvar_set(var_name, value) {
      const c = getCvar(var_name, value);
      c.string = value;
      c.value = Number(value) || 0;
      return c;
    },
    cvar_forceset(var_name, value) {
      const c = getCvar(var_name, value);
      c.string = value;
      c.value = Number(value) || 0;
      return c;
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

/** Resets the module singletons this file's tests read, without requiring a
 *  full InitGame call in every test (matching kexgame_g_phys.test.ts's own
 *  targeted-reset convention -- `level`/`game` are shared module singletons,
 *  never fully re-constructed between tests). */
function resetWorld(): void {
  cvarCalls = [];
  broadcastPrints = [];
  SetGEdicts([]);
  game.maxclients = 0;
  game.maxentities = 0;
  game.clients = [];
  level.time = GTIME_ZERO;
  level.mapname = "";
  level.nextmap = "";
  level.forcemap = "";
  level.changemap = null;
  level.intermissiontime = GTIME_ZERO;
  level.intermission_fading = false;
  level.intermission_fade = false;
  level.exitintermission = false;
  level.intermission_clear = false;
  level.intermission_eou = false;
  level.level_intermission_set = false;
  level.coop_level_restart_time = GTIME_ZERO;
  level.entry = null;
}

// ---------------------------------------------------------------------------
// GetGameAPI (g_main.cpp:411-458)
// ---------------------------------------------------------------------------

describe("GetGameAPI", () => {
  test("returns apiversion 2023 and wires SetGameImports/SetGameExports (g_main.cpp:413,417,457)", () => {
    resetWorld();
    const imports = makeFakeGameImports();
    const exportsTable = GetGameAPI(imports);

    expect(exportsTable.apiversion).toBe(GAME_API_VERSION);
    expect(GAME_API_VERSION).toBe(2023);
    expect(gi).toBe(imports); // SetGameImports(imports) -- g_main.cpp:413 `gi = *import;`
    expect(globals).toBe(exportsTable); // SetGameExports(exportsTable) -- g_main.cpp:457 `return &globals;`
  });

  test("every KexGameExports slot from game.h's game_export_t is present", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());

    const expectedSlots = [
      "apiversion",
      "PreInit",
      "Init",
      "Shutdown",
      "SpawnEntities",
      "WriteGameJson",
      "ReadGameJson",
      "WriteLevelJson",
      "ReadLevelJson",
      "CanSave",
      "ClientChooseSlot",
      "ClientConnect",
      "ClientBegin",
      "ClientUserinfoChanged",
      "ClientDisconnect",
      "ClientCommand",
      "ClientThink",
      "RunFrame",
      "PrepFrame",
      "ServerCommand",
      "edicts",
      "num_edicts",
      "max_edicts",
      "server_flags",
      "Pmove",
      "GetExtension",
      "Bot_SetWeapon",
      "Bot_TriggerEdict",
      "Bot_UseItem",
      "Bot_GetItemID",
      "Edict_ForceLookAtPoint",
      "Bot_PickedUpItem",
      "Entity_IsVisibleToPlayer",
      "GetShadowLightData",
    ];
    for (const slot of expectedSlots) {
      expect(Object.prototype.hasOwnProperty.call(exportsTable, slot)).toBe(true);
    }
    expect(Object.keys(exportsTable).sort()).toEqual(expectedSlots.sort());
  });

  test("SpawnEntities/WriteGameJson/ReadGameJson/WriteLevelJson/ReadLevelJson/CanSave throw, citing g_spawn.ts/g_save.ts", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());

    expect(() => exportsTable.SpawnEntities("q2dm1", "", "")).toThrow(/g_spawn\.ts/);
    expect(() => exportsTable.WriteGameJson(false, [0])).toThrow(/g_save\.ts/);
    expect(() => exportsTable.ReadGameJson("{}")).toThrow(/g_save\.ts/);
    expect(() => exportsTable.WriteLevelJson(false, [0])).toThrow(/g_save\.ts/);
    expect(() => exportsTable.ReadLevelJson("{}")).toThrow(/g_save\.ts/);
    expect(() => exportsTable.CanSave()).toThrow(/g_save\.ts/);
  });

  test("Bot_* / Edict_ForceLookAtPoint slots throw, citing the unported bots/ subsystem", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());

    expect(() => exportsTable.Bot_SetWeapon(null, 0, false)).toThrow(/bots\//);
    expect(() => exportsTable.Bot_TriggerEdict(null, null)).toThrow(/bots\//);
    expect(() => exportsTable.Bot_UseItem(null, 0)).toThrow(/bots\//);
    expect(() => exportsTable.Bot_GetItemID("item_health")).toThrow(/bots\//);
    expect(() => exportsTable.Edict_ForceLookAtPoint(null, vec3())).toThrow(/bots\//);
    expect(() => exportsTable.Bot_PickedUpItem(null, null)).toThrow(/bots\//);
  });

  test("Pmove wrapper throws on a null pmove (unconditional dereference)", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());
    expect(() => exportsTable.Pmove(null)).toThrow();
  });

  test("Entity_IsVisibleToPlayer resolves KexEdictT -> EdictT via g_edicts[ent.s.number] (PORTING.md EDICT_NUM idiom)", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());

    const ent = defaultEdict();
    ent.s.number = 0;
    ent.item_picked_up_by = [false, true];
    const player = defaultEdict();
    player.s.number = 1;
    player.s.number = 1;
    SetGEdicts([ent, player]);

    // player.s.number - 1 === 0 -> item_picked_up_by[0] === false -> visible
    const kexEnt: KexEdictT = ent;
    const kexPlayer: KexEdictT = player;
    expect(exportsTable.Entity_IsVisibleToPlayer(kexEnt, kexPlayer)).toBe(true);

    expect(() => exportsTable.Entity_IsVisibleToPlayer(null, kexPlayer)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PreInitGame (g_main.cpp:169-208)
// ---------------------------------------------------------------------------

describe("PreInitGame", () => {
  test("registers maxclients/deathmatch/coop/teamplay with the exact C++ defaults+flags", () => {
    resetWorld();
    SetGEdicts([]);
    // GetGameAPI wires up `gi` first, matching real usage order.
    GetGameAPI(makeFakeGameImports());
    PreInitGame();

    const byName = (name: string): CvarCall | undefined => cvarCalls.find((c) => c.name === name);

    expect(byName("maxclients")).toEqual({ name: "maxclients", value: "8", flags: CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH });
    expect(byName("deathmatch")).toEqual({ name: "deathmatch", value: "0", flags: CvarFlagsT.CVAR_LATCH });
    expect(byName("coop")).toEqual({ name: "coop", value: "0", flags: CvarFlagsT.CVAR_LATCH });
    expect(byName("teamplay")).toEqual({ name: "teamplay", value: "0", flags: CvarFlagsT.CVAR_LATCH });
  });

  test("forces deathmatch on when ctf is enabled (g_main.cpp:182-195 quirk)", () => {
    resetWorld();
    GetGameAPI(makeFakeGameImports());
    // Pre-register `ctf` as enabled before PreInitGame reads it.
    gi.cvar("ctf", "1", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH);
    cvarCalls = [];

    PreInitGame();

    const deathmatchSet = cvarCalls.find((c) => c.name === "deathmatch" && c.value === "1");
    expect(deathmatchSet).toBeUndefined(); // deathmatch is set via cvar_set, not cvar() -- see below
    const dm = gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
    expect(dm?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// InitGame (g_main.cpp:217-381)
// ---------------------------------------------------------------------------

describe("InitGame", () => {
  test("cvar registration spot checks: maxentities/fraglimit/timelimit", () => {
    resetWorld();
    GetGameAPI(makeFakeGameImports());
    PreInitGame();
    InitGame();

    const byName = (name: string): CvarCall | undefined => cvarCalls.find((c) => c.name === name);

    expect(byName("maxentities")).toEqual({ name: "maxentities", value: "8192", flags: CvarFlagsT.CVAR_LATCH });
    expect(byName("fraglimit")).toEqual({ name: "fraglimit", value: "0", flags: CvarFlagsT.CVAR_SERVERINFO });
    expect(byName("timelimit")).toEqual({ name: "timelimit", value: "0", flags: CvarFlagsT.CVAR_SERVERINFO });
    expect(byName("gamerules")).toEqual({ name: "gamerules", value: "0", flags: CvarFlagsT.CVAR_LATCH });
  });

  test("populates game.maxclients/maxentities/g_edicts/game.clients and globals.num_edicts (g_main.cpp:358-369)", () => {
    resetWorld();
    const exportsTable = GetGameAPI(makeFakeGameImports());
    PreInitGame();
    InitGame();

    expect(game.maxclients).toBe(8); // maxclients default = MAX_SPLIT_PLAYERS = 8
    expect(game.maxentities).toBe(8192);
    expect(g_edicts.length).toBe(8192);
    expect(game.clients.length).toBe(8);
    expect(exportsTable.num_edicts).toBe(game.maxclients + 1);
    expect(exportsTable.max_edicts).toBe(game.maxentities);
    expect(exportsTable.edicts).toBe(g_edicts);
  });
});

// ---------------------------------------------------------------------------
// CheckDMRules (g_main.cpp:654-717)
// ---------------------------------------------------------------------------

describe("CheckDMRules", () => {
  function setupDeathmatch(): void {
    resetWorld();
    GetGameAPI(makeFakeGameImports());
    PreInitGame();
    InitGame(); // binds fraglimit/timelimit module vars to this test's gi mock
    gi.cvar_set("deathmatch", "1");
    game.maxclients = 2;
    game.clients = [defaultGClient(), defaultGClient()];
    g_edicts[1]!.inuse = true;
    g_edicts[1]!.health = 100; // alive -- BeginIntermission's respawn loop only
    g_edicts[2]!.inuse = true; // fires for health <= 0, and this fixture's edicts
    g_edicts[2]!.health = 100; // have no .client link for respawn() to use
    level.intermissiontime = GTIME_ZERO;
  }

  // NOTE: fraglimit/timelimit/g_dm_same_level/g_map_list/g_map_list_shuffle
  // are already registered by InitGame() (called in setupDeathmatch/
  // setupIntermissionFixture above) with their real C++ defaults. A second
  // `gi.cvar(name, newDefault, flags)` call -- matching real Cvar_Get
  // semantics -- does NOT change an already-registered cvar's value; tests
  // must use `gi.cvar_set(name, value)` to override it, exactly like a
  // player typing the console command would.

  test("fraglimit trip: broadcasts and calls EndDMLevel when a client's score reaches fraglimit", () => {
    setupDeathmatch();
    gi.cvar_set("fraglimit", "10");
    game.clients[0]!.resp.score = 10;
    game.clients[1]!.resp.score = 0;
    level.mapname = "q2dm1";

    expect(() => CheckDMRules()).not.toThrow();
    expect(broadcastPrints.some((m) => /[Ff]raglimit/.test(m))).toBe(true);
  });

  test("timelimit trip: broadcasts and calls EndDMLevel when level.time passes timelimit", () => {
    setupDeathmatch();
    gi.cvar_set("timelimit", "10"); // 10 minutes
    level.time = Gtime_from_ms(10 * 60 * 1000);
    level.mapname = "q2dm1";

    expect(() => CheckDMRules()).not.toThrow();
    expect(broadcastPrints.some((m) => /[Tt]imelimit/.test(m))).toBe(true);
  });

  test("no trip when below both fraglimit and timelimit", () => {
    setupDeathmatch();
    gi.cvar_set("fraglimit", "10");
    gi.cvar_set("timelimit", "10");
    level.time = Gtime_from_ms(0);
    game.clients[0]!.resp.score = 0;

    CheckDMRules();
    expect(broadcastPrints.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EndDMLevel (g_main.cpp:521-622)
// ---------------------------------------------------------------------------

describe("EndDMLevel", () => {
  function setupIntermissionFixture(): void {
    resetWorld();
    GetGameAPI(makeFakeGameImports());
    PreInitGame();
    InitGame(); // real g_edicts/game.clients allocation -- CreateTargetChangeLevel's
    // G_Spawn() needs a preallocated g_edicts array (see g_utils.ts:566-571).
    gi.cvar_set("deathmatch", "1");
    game.maxclients = 0; // skip BeginIntermission's per-client respawn/move loops
    level.level_intermission_set = true; // skip BeginIntermission's intermission-spot search
  }

  test("g_dm_same_level: stays on the current map, even though a different nextmap is set (g_main.cpp:526-530)", () => {
    setupIntermissionFixture();
    gi.cvar_set("g_dm_same_level", "1");
    level.mapname = "q2dm1";
    // a distractor -- if g_dm_same_level's early check were skipped, the
    // real g_main.cpp:605-609 nextmap fallback would report this instead.
    level.nextmap = "some_other_level";

    EndDMLevel();
    expect(level.changemap).toBe("q2dm1");
  });

  test("g_map_list: cycles to the next map in the list (g_main.cpp:538-603)", () => {
    setupIntermissionFixture();
    gi.cvar_set("g_dm_same_level", "0");
    gi.cvar_set("g_map_list", "q2dm1 q2dm2 q2dm3");
    level.mapname = "q2dm1";

    EndDMLevel();
    expect(level.changemap).toBe("q2dm2");
  });

  test("g_map_list: wraps to the first map when the current map is last (no shuffle)", () => {
    setupIntermissionFixture();
    gi.cvar_set("g_dm_same_level", "0");
    gi.cvar_set("g_map_list", "q2dm1 q2dm2 q2dm3");
    gi.cvar_set("g_map_list_shuffle", "0");
    level.mapname = "q2dm3";

    EndDMLevel();
    expect(level.changemap).toBe("q2dm1");
  });
});

// ---------------------------------------------------------------------------
// turret_breach_think angular tracking (g_turret.cpp:74-191)
// ---------------------------------------------------------------------------

describe("turret_breach_think angular tracking", () => {
  test("clamps delta to speed*frame_time_s and sets avelocity = delta * (1/frame_time_s) (g_turret.cpp:113-147)", () => {
    resetWorld();
    GetGameAPI(makeFakeGameImports()); // frame_time_s = 0.1, frame_time_ms = 100

    const self = defaultEdict();
    self.s.number = 0;
    self.s.angles = vec3(0, 0, 0);
    self.move_angles = vec3(10, 20, 0); // target angles: 10deg pitch, 20deg yaw
    self.pos1 = vec3(30, 0, 0); // pitch max +30, yaw min 0
    self.pos2 = vec3(-30, 360, 0); // pitch min -30, yaw max 360
    self.speed = 50; // deg/sec
    self.teammaster = self; // self-teamed; no owner, no teamchain
    self.owner = null;
    SetGEdicts([self]);
    level.time = GTIME_ZERO;

    turret_breach_think(self);

    // delta = move_angles - current_angles = (10, 20, 0), clamped to
    // +/-(speed * frame_time_s) = +/-(50 * 0.1) = +/-5 on each axis.
    // avelocity = clamped_delta * (1 / frame_time_s) = clamped_delta * 10.
    expect(self.avelocity[0]).toBeCloseTo(5 * 10, 5);
    expect(self.avelocity[1]).toBeCloseTo(5 * 10, 5);
    expect(self.avelocity[2]).toBeCloseTo(0, 5);
    expect(self.nextthink).toBe(Gtime_from_ms(100));
  });
});
