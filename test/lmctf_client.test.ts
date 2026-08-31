/*
Unit tests for the LM_CTF (Loki's Minions CTF) game family's core-file
continuation unit: team assignment/spawn selection (p_client.ts's
Team_To_Join/TeamJoin/Num_Of_Players/SelectSpawnPoint chain, g_ctffunc.ts's
ctf_SetEntTeamEx), the map entity-string parse-and-spawn engine (g_spawn.ts's
ED_CallSpawn/SpawnEntities/spawns registry), the flag entity spawn chain now
reachable through g_spawn+g_items+p_client, the g_save.ts JSON save-format
round trip, and ClientCommand dispatch for the commands this unit's files
own.

Self-sufficient per .orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Harness modeled after test/lmctf_core.test.ts's fake-GameImports
pattern (same shape, independently constructed here).
*/

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CsurfaceT, CvarT } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/lmctf/game";
import { GetGameAPI, ClientCommand } from "../src/lmctf/g_main";
import {
  EdictT,
  GClientT,
  SetGEdicts,
  blueflag,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  redflag,
  SetBlueFlag,
  SetRedFlag,
} from "../src/lmctf/g_local";
import {
  CTF_TEAM_BLUE,
  CTF_TEAM_RED,
  CTF_TEAM_UNDEFINED,
  ctf_findplayer,
  ctf_SetEntTeamEx,
} from "../src/lmctf/g_ctffunc";
import { Cmd_Hook_f } from "../src/lmctf/g_cmds";
import { FindItem, InitItems, ITEM_INDEX } from "../src/lmctf/g_items";
import {
  Num_Of_Players,
  PutClientInServer,
  SelectAnySpawnPoint,
  SelectDeathmatchSpawnPoint,
  SelectSpawnPoint,
  SelectTeamSpawnPoint,
  Team_To_Join,
  TeamJoin,
} from "../src/lmctf/p_client";
import { ED_CallSpawn, SP_info_flag_blue, SP_info_flag_red, SpawnEntities, spawns } from "../src/lmctf/g_spawn";
import {
  deserializeClientPersistent,
  deserializeEdict,
  deserializeGame,
  serializeClientPersistent,
  serializeEdict,
  serializeGame,
} from "../src/lmctf/g_save";

// ---------------------------------------------------------------------------
// fake GameImports (same shape as test/lmctf_core.test.ts's harness)
// ---------------------------------------------------------------------------

function defaultTrace(): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

let traceQueue: GTraceT[] = [];
function nextTrace(): GTraceT {
  const queued = traceQueue.shift();
  return queued !== undefined ? queued : defaultTrace();
}

let argvQueue: string[] = [];

function makeFakeGameImports(): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf() {},
    centerprintf() {},
    sound() {},
    positioned_sound() {},
    configstring() {},
    error(fmt): never {
      throw new Error(`gi.error: ${fmt}`);
    },
    modelindex() {
      return 1;
    },
    soundindex(name) {
      return name.length;
    },
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace() {
      return nextTrace();
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
    Pmove() {},
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
    cvar() {
      return null;
    },
    cvar_set() {
      return null;
    },
    cvar_forceset() {
      return null;
    },
    argc() {
      return argvQueue.length;
    },
    argv(n) {
      return argvQueue[n] ?? "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 32;
const MAXCLIENTS = 4;

function setupWorld(): void {
  GetGameAPI(makeFakeGameImports());

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());
  InitItems();

  level.clear();

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.ctfflags = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;
  globals.edicts = g_edicts;

  traceQueue = [];
  argvQueue = [];
  SetRedFlag(null);
  SetBlueFlag(null);
}

function makePlayer(i: number, teamnum: number): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makePlayer: no such edict");
  ent.inuse = true;
  ent.classname = "player";
  ent.client = game.clients[i - 1] ?? new GClientT();
  ent.client.pers.connected = true;
  ent.client.pers.netname = `player${i}`;
  ent.client.ctf.teamnum = teamnum;
  ent.health = 100;
  ent.max_health = 100;
  ent.takedamage = 1;
  return ent;
}

function makeSpawnSpot(i: number, classname: string, x: number, y: number, z: number): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makeSpawnSpot: no such edict");
  ent.inuse = true;
  ent.classname = classname;
  ent.s.origin[0] = x;
  ent.s.origin[1] = y;
  ent.s.origin[2] = z;
  return ent;
}

// ===========================================================================
// Team assignment
// ===========================================================================

describe("Team_To_Join / TeamJoin", () => {
  test("balances a new player onto the team with fewer players", () => {
    setupWorld();
    makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_RED);
    const joiner = makePlayer(3, CTF_TEAM_UNDEFINED);

    expect(Team_To_Join(joiner)).toBe(CTF_TEAM_BLUE);
  });

  test("even teams tie-break to red (documented redscore/bluescore-always-0 deviation)", () => {
    setupWorld();
    makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_BLUE);
    const joiner = makePlayer(3, CTF_TEAM_UNDEFINED);

    expect(Team_To_Join(joiner)).toBe(CTF_TEAM_RED);
  });

  test("TeamJoin assigns a fresh CTF_TEAM_UNDEFINED player to the balanced team", () => {
    setupWorld();
    makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_RED);
    const joiner = makePlayer(3, CTF_TEAM_UNDEFINED);

    TeamJoin(joiner);

    expect(joiner.client?.ctf.teamnum).toBe(CTF_TEAM_BLUE);
  });

  test("TeamJoin re-affirms an already-defined team via ctf_SetEntTeamEx", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);

    TeamJoin(ent);

    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED);
  });

  test("Num_Of_Players counts only the requested team and excludes the passed-in entity", () => {
    setupWorld();
    const a = makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_RED);
    makePlayer(3, CTF_TEAM_BLUE);

    expect(Num_Of_Players(a, CTF_TEAM_RED)).toBe(1); // self excluded
    expect(Num_Of_Players(a, CTF_TEAM_BLUE)).toBe(1);
  });
});

describe("ctf_SetEntTeamEx", () => {
  test("clamps an out-of-range team value to CTF_TEAM_UNDEFINED", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);

    ctf_SetEntTeamEx(ent, 9999, 0);

    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_UNDEFINED);
  });

  test("assigns a valid team directly", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_UNDEFINED);

    ctf_SetEntTeamEx(ent, CTF_TEAM_BLUE, 1);

    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_BLUE);
  });
});

// ===========================================================================
// Spawn point selection
// ===========================================================================

describe("Spawn point selection", () => {
  test("SelectTeamSpawnPoint returns null when no matching team markers exist", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);

    expect(SelectTeamSpawnPoint(ent)).toBeNull();
  });

  test("SelectTeamSpawnPoint picks the info_player_red marker farthest from other players", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);
    makeSpawnSpot(5, "info_player_red", 0, 0, 0);
    makeSpawnSpot(6, "info_player_red", 1000, 0, 0);
    // an enemy sits right on top of the near spot
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    enemy.s.origin[0] = 0;
    enemy.s.origin[1] = 0;
    enemy.s.origin[2] = 0;
    enemy.health = 100;

    const spot = SelectTeamSpawnPoint(ent);
    expect(spot).not.toBeNull();
    expect(spot?.s.origin[0]).toBe(1000);
  });

  test("SelectAnySpawnPoint falls back to a deathmatch spot when no team spot exists", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);
    makeSpawnSpot(5, "info_player_deathmatch", 42, 0, 0);

    const spot = SelectAnySpawnPoint(ent);
    expect(spot).not.toBeNull();
    expect(spot?.classname).toBe("info_player_deathmatch");
  });

  test("SelectDeathmatchSpawnPoint finds a registered info_player_deathmatch spot", () => {
    setupWorld();
    makeSpawnSpot(5, "info_player_deathmatch", 7, 8, 9);

    const spot = SelectDeathmatchSpawnPoint();
    expect(spot?.s.origin[0]).toBe(7);
  });

  test("SelectSpawnPoint errors clearly when no spawn point exists anywhere", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);
    const origin = vec3();
    const angles = vec3();

    expect(() => SelectSpawnPoint(ent, origin, angles)).toThrow(/Couldn't find spawn point/);
  });

  test("PutClientInServer spawns a player at a found spawn point and links them", () => {
    setupWorld();
    makeSpawnSpot(5, "info_player_deathmatch", 100, 200, 300);
    const ent = makePlayer(1, CTF_TEAM_RED);

    PutClientInServer(ent);

    expect(ent.inuse).toBe(true);
    expect(ent.classname).toBe("player");
    expect(ent.client).not.toBeNull();
    // spawn origin[2] gets +9 per SelectSpawnPoint, then +1 in PutClientInServer
    expect(ent.s.origin[2]).toBe(310);
  });
});

// ===========================================================================
// g_spawn.ts registry / map entity string parsing
// ===========================================================================

describe("g_spawn.ts ED_CallSpawn / spawns registry", () => {
  test("dispatches a known classname through the spawns[] registry", () => {
    setupWorld();
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;
    ent.classname = "info_player_deathmatch";

    expect(() => ED_CallSpawn(ent)).not.toThrow();
    expect(ent.classname).toBe("info_player_deathmatch");
  });

  test("a classname with no spawn function or item entry just logs, does not throw", () => {
    setupWorld();
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;
    ent.classname = "totally_unknown_classname";

    expect(() => ED_CallSpawn(ent)).not.toThrow();
  });

  test("damage_rune spawns for real (SP_damage_rune -> SpawnItem(damage_rune))", () => {
    setupWorld();
    const entry = spawns.find((s) => s.name === "damage_rune");
    expect(entry).toBeDefined();
    const ent = g_edicts[5];
    if (ent === undefined || entry === undefined) throw new Error("setup failed");

    expect(() => entry.spawn(ent)).not.toThrow();
    expect(ent.model).toBe("models/items/invulner/tris.md2");
    expect(ent.item).not.toBeNull();
    expect(ent.item?.classname).toBe("damage_rune");
    expect(ent.item?.pickup_name).toBe("Damage Artifact");
  });

  test("SpawnEntities parses an entity string and spawns worldspawn plus a player start", () => {
    setupWorld();
    // "info_player_start", not "info_player_deathmatch", PLUS a dedicated
    // info_flag_red/info_flag_blue pair: SpawnEntities's tail now runs
    // ctf_validateflags() for real (deathmatch is on in setupWorld()).
    // Without dedicated flag markers, ctf_spawnflag's own fallback chain
    // for CTF_TEAM_RED (lmctf60/g_ctffunc.c:420-442, ported byte-identical
    // in g_ctffunc.ts) tries info_flag_red, then info_player_deathmatch,
    // then info_player_start -- so a minimal map's lone info_player_start
    // would otherwise get cannibalized into "info_flag_red" (real,
    // faithful behavior, covered by test/lmctf_capture.test.ts). Providing
    // real flag markers here means that fallback chain is never reached,
    // keeping this test's own info_player_start intact -- exactly the
    // "entity-string parsing" fidelity this test is actually about.
    // (ctf_deletespawnpointsnearflag, the other real side effect wired
    // into this tail, only ever searches "info_player_deathmatch" -- see
    // its own doc comment -- so it can't touch "info_player_start" either
    // way.)
    const entities =
      '{ "classname" "worldspawn" } ' +
      '{ "classname" "info_player_start" "origin" "1 2 3" } ' +
      '{ "classname" "info_flag_red" "origin" "1000 0 0" } ' +
      '{ "classname" "info_flag_blue" "origin" "-1000 0 0" }';

    expect(() => SpawnEntities("testmap", entities, "")).not.toThrow();

    let found = false;
    for (let i = 0; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.classname === "info_player_start" && e.s.origin[0] === 1) {
        found = true;
      }
    }
    expect(found).toBe(true);
    expect(level.mapname).toBe("testmap");
  });
});

// ===========================================================================
// Flag entity spawn/capture chain (g_spawn + g_items + p_client reachable)
// ===========================================================================

describe("Flag entity spawn/capture chain", () => {
  test("a map-placed 'flag' classname routes through the item table (SpawnItem), not SP_flag directly", () => {
    setupWorld();
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;
    ent.classname = "flag";
    ent.s.origin[0] = 10;
    ent.s.origin[1] = 20;
    ent.s.origin[2] = 30;

    ED_CallSpawn(ent);

    // SpawnItem sets ent.item to the "flag" GItemT (SP_flag never runs
    // because the item-table check in ED_CallSpawn wins first -- see
    // g_items.ts's SP_flag doc comment for the citation). SpawnItem
    // schedules droptofloor via think/nextthink rather than calling it
    // immediately (matching the real game -- "items can't be immediately
    // dropped to floor, because they might be on an entity that hasn't
    // spawned yet").
    expect(ent.item).not.toBeNull();
    expect(ent.item?.classname).toBe("flag");
    expect(ent.think).not.toBeNull();

    // run the scheduled think to settle it onto the floor
    ent.think?.(ent);
    expect(ent.touch).not.toBeNull();
  });

  test("touching a spawned flag entity reaches the real ctf_flagtouch (enemy-flag pickup)", () => {
    setupWorld();
    const flagEnt = g_edicts[5];
    const player = makePlayer(1, CTF_TEAM_BLUE);
    if (flagEnt === undefined) throw new Error("no edict");
    flagEnt.inuse = true;
    flagEnt.classname = "flag";
    flagEnt.flagteam = CTF_TEAM_RED; // enemy flag, relative to the blue player touching it
    ED_CallSpawn(flagEnt);
    flagEnt.think?.(flagEnt); // droptofloor: assigns touch=Touch_Item

    expect(flagEnt.touch).not.toBeNull();
    expect(() => flagEnt.touch?.(flagEnt, player, null, null)).not.toThrow();

    // ctf_flagtouch's "Enemy flag" branch: picked up, owner set, inventory
    // incremented.
    expect(flagEnt.owner).toBe(player);
    expect(flagEnt.item).not.toBeNull();
    if (flagEnt.item !== null && player.client !== null) {
      expect(player.client.pers.inventory[ITEM_INDEX(flagEnt.item)]).toBe(1);
    }
  });

  test("SP_info_flag_red sets the module-level redflag reference and classname", () => {
    setupWorld();
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;

    SP_info_flag_red(ent);

    expect(ent.classname).toBe("info_flag_red");
    expect(redflag).toBe(ent);
  });

  test("SP_info_flag_blue sets the module-level blueflag reference and classname", () => {
    setupWorld();
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;

    SP_info_flag_blue(ent);

    expect(ent.classname).toBe("info_flag_blue");
    expect(blueflag).toBe(ent);
  });

  test("SP_info_flag_red frees the entity outside deathmatch", () => {
    setupWorld();
    gameCvars.deathmatch = fakeCvar(0);
    // G_FreeEdict refuses to free indices <= maxclients+BODY_QUEUE_SIZE
    // (12 with this harness's MAXCLIENTS=4); use a slot above that range.
    const ent = g_edicts[20];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;

    SP_info_flag_red(ent);

    expect(ent.inuse).toBe(false);
  });
});

// ===========================================================================
// Save round-trip (g_save.ts)
// ===========================================================================

describe("g_save.ts serialize/deserialize round trip", () => {
  test("serializeEdict/deserializeEdict round-trips core fields", () => {
    setupWorld();
    const src = g_edicts[5];
    if (src === undefined) throw new Error("no edict");
    src.inuse = true;
    src.classname = "func_door";
    src.health = 42;
    src.s.origin[0] = 111;
    src.s.origin[1] = 222;
    src.s.origin[2] = 333;
    src.flagteam = CTF_TEAM_RED;
    src.droptime = 12.5;

    const json = serializeEdict(src);
    const dest = new EdictT();
    deserializeEdict(dest, json);

    expect(dest.classname).toBe("func_door");
    expect(dest.health).toBe(42);
    expect(dest.s.origin[0]).toBe(111);
    expect(dest.s.origin[1]).toBe(222);
    expect(dest.s.origin[2]).toBe(333);
    expect(dest.flagteam).toBe(CTF_TEAM_RED);
    expect(dest.droptime).toBe(12.5);
  });

  test("serializeClientPersistent/deserializeClientPersistent round-trips netname and inventory", () => {
    setupWorld();
    const pers = game.clients[0]?.pers;
    if (pers === undefined) throw new Error("no client");
    pers.netname = "roundtrip";
    const hook = FindItem("Grappling Hook");
    if (hook === null) throw new Error("no hook item");
    pers.inventory[ITEM_INDEX(hook)] = 1;
    pers.squad = "Alpha";

    const json = serializeClientPersistent(pers);
    const restored = deserializeClientPersistent(json);

    expect(restored.netname).toBe("roundtrip");
    expect(restored.inventory[ITEM_INDEX(hook)]).toBe(1);
    expect(restored.squad).toBe("Alpha");
  });

  test("serializeGame/deserializeGame round-trips maxclients and per-client persistent data", () => {
    setupWorld();
    const client = game.clients[0];
    if (client === undefined) throw new Error("no client");
    client.pers.netname = "gametest";
    client.pers.health = 77;

    const json = serializeGame(false);
    game.clear();
    deserializeGame(json);

    expect(game.maxclients).toBe(MAXCLIENTS);
    expect(game.clients[0]?.pers.netname).toBe("gametest");
    expect(game.clients[0]?.pers.health).toBe(77);
  });
});

// ===========================================================================
// ClientCommand dispatch (regression: commands this unit's files route)
// ===========================================================================

describe("ClientCommand dispatch", () => {
  test("still dispatches 'hook' to Cmd_Hook_f with a fully spawned player present", () => {
    setupWorld();
    makeSpawnSpot(6, "info_player_deathmatch", 0, 0, 0);
    const ent = makePlayer(1, CTF_TEAM_RED);
    PutClientInServer(ent);
    const hook = FindItem("Grappling Hook");
    if (hook === null) throw new Error("no hook item");
    ent.client!.pers.inventory[ITEM_INDEX(hook)] = 1;

    argvQueue = ["hook"];
    expect(() => ClientCommand(ent)).not.toThrow();
  });

  test("an unrecognized command falls through without throwing", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);

    argvQueue = ["totally_unknown_command"];
    expect(() => ClientCommand(ent)).not.toThrow();
  });
});
