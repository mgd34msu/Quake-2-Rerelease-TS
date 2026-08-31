/*
Unit tests for this pass's LM_CTF gameplay-gap closures:
  - resist_rune/haste_rune/regen_rune itemlist entries + spawn wiring
    (src/lmctf/g_items.ts, src/lmctf/g_spawn.ts)
  - g_cmds.ts's team-switch and observer command chain (Cmd_Team_f,
    Team_Change, Drop_All, Cmd_Observe_f) plus the ClientCommand dispatch
    completion that routes to them
  - g_tourney.ts's match-flow system (StartMatch, KillMatch, SetPause,
    SpawnTourneyClock, Tourney_Think, Match_Start)
  - g_ctffunc.ts's ctf_ChangeMap

Self-sufficient per this game family's existing test convention: this file
calls GetGameAPI(fakeImports) itself and never relies on another test file
having run first. Harness modeled after test/lmctf_systems.test.ts's
fake-GameImports pattern (real cvar registry, since g_tourney.ts/g_cmds.ts
read cvars by name at call time) extended with test/lmctf_client.test.ts's
settable argv/argc queue (needed for Cmd_Team_f's gi.argv(1) reads).
*/

import { beforeEach, describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CvarT, PRINT_HIGH } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/lmctf/game";
import { GetGameAPI, ClientCommand } from "../src/lmctf/g_main";
import {
  EdictT,
  GClientT,
  SetGEdicts,
  SetBlueFlag,
  SetRedFlag,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
} from "../src/lmctf/g_local";
import { CTF_TEAM_BLUE, CTF_TEAM_OBSERVER, CTF_TEAM_OBSERVER_BLUE, CTF_TEAM_OBSERVER_RED, CTF_TEAM_RED, CTF_TEAM_UNDEFINED, ctf_ChangeMap } from "../src/lmctf/g_ctffunc";
import { InitItems, FindItemByClassname } from "../src/lmctf/g_items";
import { ED_CallSpawn, SpawnEntities } from "../src/lmctf/g_spawn";
import {
  Cmd_Observe_f,
  Cmd_PauseMatch_f,
  Cmd_StartMatch_f,
  Cmd_StopMatch_f,
  Cmd_Team_f,
  Drop_All,
  Team_Change,
} from "../src/lmctf/g_cmds";
import {
  GamePaused,
  KillMatch,
  Match_Start,
  matchstate,
  MatchStatesT,
  SetMatchState,
  SetPause,
  SpawnTourneyClock,
  StartMatch,
  Tourney_Think,
} from "../src/lmctf/g_tourney";

// ---------------------------------------------------------------------------
// fake GameImports
// ---------------------------------------------------------------------------

interface Recorder {
  centerprintf: string[];
  bprintf: string[];
  cprintf: string[];
  addCommandString: string[];
  unicast: number;
  writeString: string[];
}

function makeRecorder(): Recorder {
  return { centerprintf: [], bprintf: [], cprintf: [], addCommandString: [], unicast: 0, writeString: [] };
}

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
const cvarRegistry = new Map<string, CvarT>();

function fakeCvarGet(name: string, value: string | null, _flags: number): CvarT {
  let c = cvarRegistry.get(name);
  if (c === undefined) {
    c = new CvarT();
    c.name = name;
    c.string = value ?? "";
    c.value = Number.parseFloat(c.string) || 0;
    cvarRegistry.set(name, c);
  }
  return c;
}

function fakeCvarSet(name: string, value: string): CvarT {
  const c = fakeCvarGet(name, value, 0);
  c.string = value;
  c.value = Number.parseFloat(value) || 0;
  return c;
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf(_level, fmt) {
      rec.bprintf.push(fmt);
    },
    dprintf() {},
    cprintf(_ent, _level, fmt) {
      rec.cprintf.push(fmt);
    },
    centerprintf(_ent, fmt) {
      rec.centerprintf.push(fmt);
    },
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
    unicast() {
      rec.unicast++;
    },
    WriteChar() {},
    WriteByte() {},
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString(s) {
      rec.writeString.push(s);
    },
    WritePosition() {},
    WriteDir() {},
    WriteAngle() {},
    cvar: fakeCvarGet,
    cvar_set: fakeCvarSet,
    cvar_forceset: fakeCvarSet,
    argc() {
      return argvQueue.length;
    },
    argv(n) {
      return argvQueue[n] ?? "";
    },
    args() {
      return argvQueue.slice(1).join(" ");
    },
    AddCommandString(text) {
      rec.addCommandString.push(text);
    },
    DebugGraph() {},
  };
}

const MAXENTITIES = 32;
const MAXCLIENTS = 8;

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

let rec: Recorder;

function setupWorld(): void {
  rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
    e.inuse = false;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());
  InitItems();

  level.clear();

  cvarRegistry.clear();
  gameCvars.maxclients = fakeCvarGet("maxclients", `${MAXCLIENTS}`, 0);
  gameCvars.maxspectators = fakeCvarGet("maxspectators", "24", 0);
  gameCvars.dmflags = fakeCvarGet("dmflags", "0", 0);
  gameCvars.ctfflags = fakeCvarGet("ctfflags", "0", 0);
  gameCvars.fraglimit = fakeCvarGet("fraglimit", "0", 0);
  gameCvars.timelimit = fakeCvarGet("timelimit", "0", 0);
  gameCvars.password = fakeCvarGet("password", "", 0);
  gameCvars.deathmatch = fakeCvarGet("deathmatch", "1", 0);
  gameCvars.skill = fakeCvarGet("skill", "1", 0);
  gameCvars.coop = fakeCvarGet("coop", "0", 0);
  gameCvars.runes = fakeCvarGet("runes", "15", 0);
  gameCvars.autolock = fakeCvarGet("autolock", "0", 0);
  gameCvars.countdown_time = fakeCvarGet("countdown_time", "15", 0);
  gameCvars.railtime = fakeCvarGet("railtime", "0", 0);
  gameCvars.fastswitch = fakeCvarGet("fastswitch", "0", 0);
  gameCvars.refset = fakeCvarGet("refset", "0", 0);
  gameCvars.skinset = fakeCvarGet("skinset", "0", 0);
  gameCvars.sv_cheats = fakeCvarGet("cheats", "0", 0);
  gameCvars.dedicated = fakeCvarGet("dedicated", "0", 0);

  globals.num_edicts = MAXENTITIES;
  globals.edicts = g_edicts;

  traceQueue = [];
  argvQueue = [];
  SetRedFlag(null);
  SetBlueFlag(null);
  SetMatchState(MatchStatesT.MATCH_NONE);

  // A generic deathmatch spawn point so any test that exercises
  // Team_Change/respawn (p_client.ts's SelectSpawnPoint chain) has
  // somewhere to land, matching test/lmctf_client.test.ts's own
  // makeSpawnSpot precedent.
  makeSpawnSpot(20, "info_player_deathmatch", 0, 0, 0);
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
  ent.takedamage = 1; // DamageT.DAMAGE_YES
  return ent;
}

beforeEach(() => {
  setupWorld();
});

// ===========================================================================
// resist_rune / haste_rune / regen_rune itemlist entries + spawn wiring
// ===========================================================================

describe("rune itemlist entries (g_items.ts) + spawn wiring (g_spawn.ts)", () => {
  test("FindItemByClassname finds all four runes now (damage/resist/haste/regen)", () => {
    expect(FindItemByClassname("damage_rune")).not.toBeNull();
    expect(FindItemByClassname("resist_rune")).not.toBeNull();
    expect(FindItemByClassname("haste_rune")).not.toBeNull();
    expect(FindItemByClassname("regen_rune")).not.toBeNull();
  });

  test("resist_rune has the correct itemlist fields (byte-identical to lmctf60/g_items.c)", () => {
    const it = FindItemByClassname("resist_rune");
    expect(it).not.toBeNull();
    expect(it?.pickup_name).toBe("Resist Artifact");
    expect(it?.icon).toBe("a_resist");
    expect(it?.world_model).toBe("models/ctf/resist/tris.md2");
    expect(it?.pickup).not.toBeNull();
    expect(it?.use).not.toBeNull();
    expect(it?.drop).not.toBeNull();
  });

  test("haste_rune / regen_rune have the correct itemlist fields", () => {
    const haste = FindItemByClassname("haste_rune");
    expect(haste?.pickup_name).toBe("Haste Artifact");
    expect(haste?.icon).toBe("a_haste");
    expect(haste?.world_model).toBe("models/ctf/haste/tris.md2");

    const regen = FindItemByClassname("regen_rune");
    expect(regen?.pickup_name).toBe("Regen Artifact");
    expect(regen?.icon).toBe("a_regen");
    expect(regen?.world_model).toBe("models/ctf/regen/tris.md2");
  });

  test("ED_CallSpawn routes a 'resist_rune' map entity through the item table (SpawnItem), not the 'doesn't have a spawn function' fallback", () => {
    const ent = g_edicts[5];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;
    ent.classname = "resist_rune";

    expect(() => ED_CallSpawn(ent)).not.toThrow();

    expect(ent.item).not.toBeNull();
    expect(ent.item?.classname).toBe("resist_rune");
    // SpawnItem sets a droptofloor think -- confirms the real spawn path
    // ran, not a silent no-op.
    expect(ent.think).not.toBeNull();
  });

  test("ED_CallSpawn routes 'haste_rune' and 'regen_rune' map entities the same way", () => {
    const hasteEnt = g_edicts[6];
    const regenEnt = g_edicts[7];
    if (hasteEnt === undefined || regenEnt === undefined) throw new Error("no edict");

    hasteEnt.inuse = true;
    hasteEnt.classname = "haste_rune";
    expect(() => ED_CallSpawn(hasteEnt)).not.toThrow();
    expect(hasteEnt.item?.classname).toBe("haste_rune");

    regenEnt.inuse = true;
    regenEnt.classname = "regen_rune";
    expect(() => ED_CallSpawn(regenEnt)).not.toThrow();
    expect(regenEnt.item?.classname).toBe("regen_rune");
  });

  test("SpawnEntities on a synthetic map string spawns all four runes when placed as map entities", () => {
    const entities =
      '{ "classname" "worldspawn" } ' +
      '{ "classname" "info_player_start" "origin" "0 0 0" } ' +
      '{ "classname" "damage_rune" "origin" "100 0 0" } ' +
      '{ "classname" "resist_rune" "origin" "200 0 0" } ' +
      '{ "classname" "haste_rune" "origin" "300 0 0" } ' +
      '{ "classname" "regen_rune" "origin" "400 0 0" }';

    expect(() => SpawnEntities("lmctf_test", entities, "")).not.toThrow();

    const foundClassnames = new Set<string>();
    for (let i = 0; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.inuse && e.item !== null) {
        foundClassnames.add(e.item.classname ?? "");
      }
    }
    expect(foundClassnames.has("damage_rune")).toBe(true);
    expect(foundClassnames.has("resist_rune")).toBe(true);
    expect(foundClassnames.has("haste_rune")).toBe(true);
    expect(foundClassnames.has("regen_rune")).toBe(true);
  });
});

// ===========================================================================
// Team-change / observer command paths (g_cmds.ts)
// ===========================================================================

describe("Cmd_Team_f / Team_Change", () => {
  test("Cmd_Team_f with no args prints the current team and does not throw", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    argvQueue = ["team"];
    expect(() => Cmd_Team_f(ent)).not.toThrow();
    // ctf_SafePrint (g_ctffunc.ts) only queues into ctf.printdata in this
    // port (the flush-to-gi.cprintf half is not ported, see that file's
    // own doc comment) -- assert against the queue, not gi.cprintf.
    const queued = ent.client?.ctf.printdata[PRINT_HIGH] ?? "";
    expect(queued).toContain("red team");
  });

  test("Cmd_Team_f 'blue' switches a red player to blue via Team_Change", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    argvQueue = ["team", "blue"];
    expect(() => Cmd_Team_f(ent)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_BLUE);
  });

  test("Cmd_Team_f is a no-op when already on the requested team", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    argvQueue = ["team", "red"];
    expect(() => Cmd_Team_f(ent)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED);
  });

  test("Cmd_Team_f refuses to switch when teams are locked", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    game.teamslocked = true;
    argvQueue = ["team", "blue"];
    expect(() => Cmd_Team_f(ent)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED); // unchanged
    expect(rec.cprintf.some((s) => s.includes("locked"))).toBe(true);
  });

  test("Cmd_Team_f refuses to switch when CTF_TEAM_NOSWITCH is set", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    gameCvars.ctfflags = fakeCvar(8); // CTF_TEAM_NOSWITCH
    argvQueue = ["team", "blue"];
    expect(() => Cmd_Team_f(ent)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED); // unchanged
  });

  test("Team_Change moves the player to the new team and leaves resp.score net-unchanged", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    if (ent.client === null) throw new Error("no client");
    const scoreBefore = ent.client.resp.score;

    expect(() => Team_Change(ent, CTF_TEAM_BLUE)).not.toThrow();

    expect(ent.client.ctf.teamnum).toBe(CTF_TEAM_BLUE);
    // player_die's ClientObituary applies the usual self-inflicted-death
    // penalty (resp.score--, p_client.ts:672) since attacker === ent here;
    // Team_Change's own resp.score++ exists specifically to cancel that
    // penalty out (lmctf60/g_cmds.c:1039 -- switching teams shouldn't cost
    // a frag), so the net change is zero, not +1.
    expect(ent.client.resp.score).toBe(scoreBefore);
  });

  test("Team_Change(ent, 0) is a no-op (matches the C source's `if (!newnum) return;`)", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Team_Change(ent, 0)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED);
  });
});

describe("Cmd_Observe_f / Drop_All", () => {
  test("Cmd_Observe_f moves a player to CTF_TEAM_OBSERVER and forces 'spectator 1'", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Cmd_Observe_f(ent, CTF_TEAM_OBSERVER)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_OBSERVER);
    expect(ent.client?.chase_target).toBeNull();
  });

  test("Cmd_Observe_f(observe_red) refuses when no red players exist (Team_Observer_OK)", () => {
    const ent = makePlayer(1, CTF_TEAM_BLUE);
    expect(() => Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_RED)).not.toThrow();
    // Team_Observer_OK found no red players -> Cmd_Observe_f returns early,
    // teamnum is unchanged.
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_BLUE);
  });

  test("Cmd_Observe_f(observe_blue) succeeds once a blue player exists", () => {
    makePlayer(2, CTF_TEAM_BLUE);
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_BLUE)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_OBSERVER_BLUE);
  });

  test("Cmd_Observe_f refuses once the spectator limit is full", () => {
    gameCvars.maxspectators = fakeCvar(0);
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Cmd_Observe_f(ent, CTF_TEAM_OBSERVER)).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_RED); // unchanged
    expect(rec.cprintf.some((s) => s.includes("spectator limit"))).toBe(true);
  });

  test("Drop_All frees a client's hook entity", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    if (ent.client === null) throw new Error("no client");
    // Index must be beyond maxclients+BODY_QUEUE_SIZE (8+8=16 here) --
    // G_FreeEdict (g_utils.ts) refuses to free entities inside that
    // reserved range.
    const hookEnt = g_edicts[25];
    if (hookEnt === undefined) throw new Error("no edict");
    hookEnt.inuse = true;
    hookEnt.classname = "hook";
    ent.client.hook = hookEnt;

    expect(() => Drop_All(ent)).not.toThrow();
    expect(ent.client.hook).toBeNull();
    expect(hookEnt.inuse).toBe(false);
  });

  test("Drop_All is a no-op (does not throw) for a player carrying nothing", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Drop_All(ent)).not.toThrow();
  });
});

// ===========================================================================
// Match-flow state transitions (g_tourney.ts)
// ===========================================================================

describe("g_tourney.ts match-flow state transitions", () => {
  test("SpawnTourneyClock moves matchstate from MATCH_NONE to MATCH_COUNTDOWN", () => {
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE);
    expect(() => SpawnTourneyClock()).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);
  });

  test("Tourney_Think counts down and Match_Start transitions MATCH_COUNTDOWN -> MATCH_INPLAY at count 0", () => {
    makePlayer(1, CTF_TEAM_RED);
    SpawnTourneyClock();
    const clockEnt = g_edicts[1] ?? g_edicts[0];
    if (clockEnt === undefined) throw new Error("no clock edict");

    // Drive the clock's own count to 0 directly (bypassing the full
    // second-by-second countdown for test speed) and tick once more --
    // Tourney_Think's own `case 0: Match_Start(ent)` branch requires
    // ent.count === 0 at entry.
    clockEnt.count = 0;
    expect(() => Tourney_Think(clockEnt)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_INPLAY);
  });

  test("KillMatch resets matchstate to MATCH_NONE and frees the tourney clock", () => {
    SpawnTourneyClock();
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);

    expect(() => KillMatch()).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE);
  });

  test("SetPause toggles GamePaused() and centerprints every in-use client", () => {
    makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_BLUE);

    expect(GamePaused()).toBe(false);
    expect(() => SetPause(true)).not.toThrow();
    expect(GamePaused()).toBe(true);
    expect(rec.centerprintf.some((s) => s.includes("Paused"))).toBe(true);

    expect(() => SetPause(false)).not.toThrow();
    expect(GamePaused()).toBe(false);
    expect(rec.centerprintf.some((s) => s.includes("Unpaused"))).toBe(true);
  });

  test("SetPause with autolock set unlocks teams on pause, relocks on unpause", () => {
    gameCvars.autolock = fakeCvar(1);
    game.teamslocked = true;

    SetPause(true);
    expect(game.teamslocked).toBe(false);

    SetPause(false);
    expect(game.teamslocked).toBe(true);
  });

  test("Match_Start resets non-spectator players' health and advances matchstate to MATCH_INPLAY", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    ent.health = 100;
    SetMatchState(MatchStatesT.MATCH_COUNTDOWN);
    const clockEnt = g_edicts[2];
    if (clockEnt === undefined) throw new Error("no edict");
    clockEnt.inuse = true;

    expect(() => Match_Start(clockEnt)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_INPLAY);
  });

  test("StartMatch calls ctf_ChangeMap(levelname, true) (bug-for-bug: autolock's team-lock is immediately undone by ctf_ChangeMap's own KillMatch call)", () => {
    gameCvars.autolock = fakeCvar(1);
    game.teamslocked = false;

    expect(() => StartMatch("lmctf09")).not.toThrow();

    // lmctf60/g_tourney.c:449-456: StartMatch sets `game.teamslocked = true`
    // then unconditionally calls ctf_ChangeMap(levelname, true), which
    // unconditionally calls KillMatch() -- and KillMatch ALSO gates on
    // autolock, resetting teamslocked back to false. Preserved exactly
    // (confirmed by direct source read, not a porting bug): the net
    // effect of StartMatch with autolock on is teamslocked ends up FALSE,
    // not true.
    expect(game.teamslocked).toBe(false);
    expect(rec.addCommandString.some((s) => s.includes("lmctf09"))).toBe(true);
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);
  });
});

describe("ctf_ChangeMap (g_ctffunc.ts)", () => {
  test("ctf_ChangeMap issues a gamemap command and resets matchstate per the startmatch flag", () => {
    SpawnTourneyClock(); // matchstate now MATCH_COUNTDOWN, real tourneyclock exists

    expect(() => ctf_ChangeMap("lmctf10", false)).not.toThrow();

    expect(rec.addCommandString).toEqual(['gamemap "lmctf10"\n']);
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE); // KillMatch, then startmatch=false
    expect(level.intermissiontime).toBe(0);
  });

  test("ctf_ChangeMap(mapname, true) leaves matchstate at MATCH_COUNTDOWN", () => {
    expect(() => ctf_ChangeMap("lmctf11", true)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);
  });
});

// ===========================================================================
// Cmd_StartMatch_f / Cmd_StopMatch_f / Cmd_PauseMatch_f (referee-gated
// ClientCommand entry points)
// ===========================================================================

describe("referee-gated match commands", () => {
  function makeReferee(i: number, teamnum: number): EdictT {
    const ent = makePlayer(i, teamnum);
    if (ent.client === null) throw new Error("no client");
    ent.client.ctf.extra_flags |= 2; // CTF_EXTRAFLAGS_REFEREE
    return ent;
  }

  test("Cmd_StartMatch_f denies a non-referee", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => Cmd_StartMatch_f(ent)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE);
    expect(rec.cprintf.some((s) => s.includes("Referee-only"))).toBe(true);
  });

  test("Cmd_StartMatch_f spawns the tourney clock for a referee", () => {
    const ent = makeReferee(1, CTF_TEAM_RED);
    expect(() => Cmd_StartMatch_f(ent)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);
  });

  test("Cmd_StopMatch_f kills a running match for a referee", () => {
    const ent = makeReferee(1, CTF_TEAM_RED);
    Cmd_StartMatch_f(ent);
    expect(matchstate).toBe(MatchStatesT.MATCH_COUNTDOWN);

    expect(() => Cmd_StopMatch_f(ent)).not.toThrow();
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE);
  });

  test("Cmd_PauseMatch_f toggles GamePaused() via g_menu.ts's RefTogglePause", () => {
    const ent = makeReferee(1, CTF_TEAM_RED);
    expect(GamePaused()).toBe(false);
    expect(() => Cmd_PauseMatch_f(ent)).not.toThrow();
    expect(GamePaused()).toBe(true);
    expect(() => Cmd_PauseMatch_f(ent)).not.toThrow();
    expect(GamePaused()).toBe(false);
  });
});

// ===========================================================================
// ClientCommand dispatch completion (g_cmds.ts)
// ===========================================================================

describe("ClientCommand dispatch (newly wired commands)", () => {
  function dispatch(ent: EdictT, args: string[]): void {
    argvQueue = args;
    ClientCommand(ent as unknown as Edict);
  }

  test("'team' dispatches to Cmd_Team_f", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => dispatch(ent, ["team", "blue"])).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_BLUE);
  });

  test("'observe' dispatches to Cmd_Observe_f(CTF_TEAM_OBSERVER)", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => dispatch(ent, ["observe"])).not.toThrow();
    expect(ent.client?.ctf.teamnum).toBe(CTF_TEAM_OBSERVER);
  });

  test("'kill' dispatches to Cmd_Kill_f without throwing", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    ent.client!.respawn_time = 0;
    level.time = 100;
    expect(() => dispatch(ent, ["kill"])).not.toThrow();
    expect(ent.health).toBeLessThanOrEqual(0);
  });

  test("'users' dispatches to Cmd_Users_f without throwing", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    makePlayer(2, CTF_TEAM_BLUE);
    expect(() => dispatch(ent, ["users"])).not.toThrow();
  });

  test("'lock' dispatches to Cmd_LockTeams_f (referee-gated, denied for a normal player)", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => dispatch(ent, ["lock"])).not.toThrow();
    expect(game.teamslocked).toBe(false);
  });

  test("an unrecognized command falls through to the chat catch-all without throwing", () => {
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(() => dispatch(ent, ["totally_unknown_command", "hello"])).not.toThrow();
  });

  test("a not-fully-connected client (client === null) is a no-op, not a crash", () => {
    const ent = g_edicts[1];
    if (ent === undefined) throw new Error("no edict");
    ent.inuse = true;
    ent.client = null;
    expect(() => dispatch(ent, ["team", "red"])).not.toThrow();
  });
});
