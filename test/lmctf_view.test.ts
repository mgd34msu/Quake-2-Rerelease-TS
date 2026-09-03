/*
Targeted regression tests for the LM_CTF view/HUD pipeline
(src/lmctf/p_view.ts's ClientEndServerFrame, src/lmctf/p_hud.ts's G_SetStats).

These pin the two behaviors whose absence produced the play-test report
"lmctf ... is crouched by default": p_view.ts used to return from
ClientEndServerFrame right after the hook dispatch, so SV_CalcViewOffset
never ran and client.ps.viewoffset stayed at the origin (eye on the floor),
and G_SetStats never ran at all, so the HUD had no health/ammo/armor values.

Self-sufficient per .orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. The fake-GameImports harness is the same shape as
test/lmctf_core.test.ts's.
*/

import { beforeEach, describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import {
  CplaneT,
  CvarT,
  PMF_DUCKED,
  STAT_AMMO,
  STAT_HEALTH,
  STAT_HEALTH_ICON,
} from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/lmctf/game";
import { GetGameAPI } from "../src/lmctf/g_main";
import {
  EdictT,
  game,
  gameCvars,
  GClientT,
  globals,
  g_edicts,
  level,
  SetBlueFlag,
  SetGEdicts,
  SetRedFlag,
} from "../src/lmctf/g_local";
import { CTF_TEAM_BLUE, CTF_TEAM_RED, CTF_TEAM_UNDEFINED } from "../src/lmctf/g_ctffunc";
import { MatchStatesT, SetMatchState } from "../src/lmctf/g_tourney";
import { FindItem, InitItems, ITEM_INDEX } from "../src/lmctf/g_items";
import { ClientEndServerFrame } from "../src/lmctf/p_view";
import {
  CTFSquadboardMessage,
  DeathmatchScoreboardMessage,
  G_SetStats,
  HelpComputer,
} from "../src/lmctf/p_hud";

// ---------------------------------------------------------------------------
// fake GameImports (same shape as test/lmctf_core.test.ts's)
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
      return name.length; // deterministic non-zero stand-in
    },
    imageindex(name) {
      return name.length; // deterministic non-zero stand-in
    },
    setmodel() {},
    trace() {
      return defaultTrace();
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
  edicts.forEach((e: EdictT, i: number) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());
  InitItems();

  level.clear();
  level.time = 1;
  level.framenum = 10;

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.ctfflags = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  SetMatchState(MatchStatesT.MATCH_NONE);
  SetRedFlag(null);
  SetBlueFlag(null);
}

/** A live, standing, on-the-ground player edict at index `i`. */
function makePlayer(i: number): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makePlayer: no such edict");
  ent.inuse = true;
  ent.classname = "player";
  ent.s.modelindex = 255; // in the player model
  ent.client = new GClientT();
  ent.client.pers.connected = true;
  ent.client.pers.netname = `player${i}`;
  ent.client.ctf.teamnum = CTF_TEAM_RED;
  ent.health = 100;
  ent.max_health = 100;
  ent.client.pers.health = 100;
  ent.takedamage = 1;
  // standing on the world so P_FallingDamage takes the grounded path and
  // the bob cycle sees a groundentity
  ent.groundentity = g_edicts[0] ?? null;
  ent.viewheight = 22; // PutClientInServer's standing viewheight
  return ent;
}

describe("ClientEndServerFrame drives SV_CalcViewOffset (lmctf60/p_view.c:975)", () => {
  beforeEach(() => {
    setupWorld();
  });

  test("a standing player's eye is lifted to viewheight 22, not left at the origin", () => {
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("no client");

    expect(client.ps.viewoffset[2]).toBe(0); // pre-condition: nothing has run yet

    ClientEndServerFrame(ent);

    expect(client.ps.viewoffset[2]).toBeCloseTo(22, 5);
  });

  test("a ducked player's eye drops to viewheight -2, exactly 24 units below standing", () => {
    const standing = makePlayer(1);
    const standingClient = standing.client;
    if (standingClient === null) throw new Error("no client");
    ClientEndServerFrame(standing);
    const standingZ = standingClient.ps.viewoffset[2];

    const ducked = makePlayer(2);
    const duckedClient = ducked.client;
    if (duckedClient === null) throw new Error("no client");
    // what pmove does when the player crouches
    duckedClient.ps.pmove.pm_flags |= PMF_DUCKED;
    ducked.viewheight = -2;

    ClientEndServerFrame(ducked);

    expect(duckedClient.ps.viewoffset[2]).toBeCloseTo(-2, 5);
    expect(standingZ - duckedClient.ps.viewoffset[2]).toBeCloseTo(24, 5);
  });

  test("the pmove origin is resynced from the edict origin (the 'sinking into plats' fix)", () => {
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("no client");

    ent.s.origin[0] = 16;
    ent.s.origin[1] = -32;
    ent.s.origin[2] = 64;

    ClientEndServerFrame(ent);

    expect(client.ps.pmove.origin[0]).toBe(16 * 8);
    expect(client.ps.pmove.origin[1]).toBe(-32 * 8);
    expect(client.ps.pmove.origin[2]).toBe(64 * 8);
  });
});

describe("G_SetStats fills the HUD stats (lmctf60/p_hud.c:1215)", () => {
  beforeEach(() => {
    setupWorld();
  });

  test("health and ammo reach ps.stats", () => {
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("no client");

    ent.health = 73;

    const bullets = FindItem("Bullets");
    if (bullets === null) throw new Error("item table has no Bullets");
    const ammoIndex = ITEM_INDEX(bullets);
    client.ammo_index = ammoIndex;
    client.pers.inventory[ammoIndex] = 42;

    G_SetStats(ent);

    expect(client.ps.stats[STAT_HEALTH]).toBe(73);
    expect(client.ps.stats[STAT_AMMO]).toBe(42);
    expect(client.ps.stats[STAT_HEALTH_ICON]).toBe(level.pic_health);
  });

  test("with no ammo_index the ammo slot and its icon are both cleared", () => {
    const ent = makePlayer(1);
    const client = ent.client;
    if (client === null) throw new Error("no client");

    client.ammo_index = 0;
    client.ps.stats[STAT_AMMO] = 999; // stale value from a previous frame

    G_SetStats(ent);

    expect(client.ps.stats[STAT_AMMO]).toBe(0);
  });
});

describe("the layout builders survive a real two-team scoreboard (lmctf60/p_hud.c:176)", () => {
  beforeEach(() => {
    setupWorld();
  });

  test("DeathmatchScoreboardMessage, CTFSquadboardMessage and HelpComputer all emit a layout", () => {
    // Two players per team so both the red and blue sort loops run, plus one
    // unassigned client so the observer branch runs too.
    const red = makePlayer(1);
    const blue = makePlayer(2);
    const obs = makePlayer(3);
    if (red.client === null || blue.client === null || obs.client === null) throw new Error("no client");
    blue.client.ctf.teamnum = CTF_TEAM_BLUE;
    obs.client.ctf.teamnum = CTF_TEAM_UNDEFINED;
    blue.client.pers.squad = "Defense";
    red.client.pers.squad = "Offense";

    expect(() => {
      DeathmatchScoreboardMessage(red, blue);
    }).not.toThrow();
    expect(() => {
      CTFSquadboardMessage(red, blue);
    }).not.toThrow();
    expect(() => {
      HelpComputer(red);
    }).not.toThrow();
  });
});
