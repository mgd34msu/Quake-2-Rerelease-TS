/*
Unit tests for the LM_CTF (Loki's Minions CTF) flag capture chain
(g_ctffunc.ts's ctf_flagtouch/ctf_playerdropflag/ctf_resetflagandplayer and
everything they pull in: ctf_ResetFlagProps/ctf_spawnflag/ctf_flagsearch/
ctf_getteamflag/ctf_flagathome/ctf_TossEnt/Drop_Flag_Think/
ctf_deletespawnpointsnearflag/ctf_validateflags), the health item family
(g_items.ts's Pickup_Health/MegaHealth_think/SP_item_health*), and
target_blaster's real fire_blaster/blaster_touch (g_weapon.ts/g_target.ts).

Self-sufficient per .orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Harness modeled after test/lmctf_client.test.ts's fake-GameImports
pattern (same shape, independently constructed here).
*/

import { describe, expect, test } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, CsurfaceT, CvarT, EF_COLOR_SHELL } from "../src/shared/q_shared";
import type { GameImports, GTraceT } from "../src/lmctf/game";
import { SolidT } from "../src/lmctf/game";
import { GetGameAPI } from "../src/lmctf/g_main";
import {
  EdictT,
  GClientT,
  SetGEdicts,
  g_edicts,
  game,
  gameCvars,
  globals,
  level,
  SetRedFlag,
  SetBlueFlag,
  CTF_SCORE_BALANCE,
} from "../src/lmctf/g_local";
import {
  CTF_CAPTURE_BONUS_CARRIER,
  CTF_CAPTURE_BONUS_TEAM,
  CTF_TEAM_BLUE,
  CTF_TEAM_RED,
  ctf_flagtouch,
  ctf_playerdropflag,
  ctf_resetflagandplayer,
  ctf_flagwave,
} from "../src/lmctf/g_ctffunc";
import { MatchStatesT, SetMatchState } from "../src/lmctf/g_tourney";
import {
  FindItemByClassname,
  ITEM_INDEX,
  InitItems,
  Pickup_Health,
  MegaHealth_think,
  SP_item_health,
  SP_item_health_small,
  SP_item_health_mega,
  HEALTH_IGNORE_MAX,
} from "../src/lmctf/g_items";
import { SP_target_blaster, use_target_blaster } from "../src/lmctf/g_target";
import { fire_blaster } from "../src/lmctf/g_weapon";

// ---------------------------------------------------------------------------
// fake GameImports (same shape as test/lmctf_client.test.ts's harness)
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

const MAXENTITIES = 64;
const MAXCLIENTS = 8;

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
  // Well past every assist-window default (kill_carrier_time/
  // return_flag_time/defend_flag_time all default to 0) so a fresh
  // player's untouched timestamps don't spuriously satisfy
  // `level.time < timestamp + N` in ctf_flagtouch's assist checks.
  level.time = 1000;

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.ctfflags = fakeCvar(0);
  gameCvars.refset = fakeCvar(0);
  gameCvars.skinset = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;
  globals.edicts = g_edicts;

  traceQueue = [];
  SetRedFlag(null);
  SetBlueFlag(null);
  SetMatchState(MatchStatesT.MATCH_NONE);
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

// Builds a real "flag" entity directly (bypassing ctf_spawnflag's map-entity
// search machinery, which this test suite does not need) -- same ITEMLIST
// "flag" GItemT every real flag uses (FindItemByClassname("flag")).
function makeFlag(i: number, team: number, atHome: boolean): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makeFlag: no such edict");
  ent.inuse = true;
  ent.classname = "flag";
  ent.flagteam = team;
  ent.item = FindItemByClassname("flag");
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.homeposition[0] = team === CTF_TEAM_RED ? -500 : 500;
  ent.s.origin[0] = atHome ? ent.homeposition[0] : ent.homeposition[0] + 1000;
  ent.droptime = 0;
  ent.owner = null;
  if (team === CTF_TEAM_RED) SetRedFlag(ent);
  else SetBlueFlag(ent);
  return ent;
}

function flagItemIndex(): number {
  const item = FindItemByClassname("flag");
  if (item === null) throw new Error("flag item not found");
  return ITEM_INDEX(item);
}

// ===========================================================================
// The flag capture chain (ctf_flagtouch/ctf_playerdropflag/ctf_resetflagandplayer)
// ===========================================================================

describe("ctf_flagtouch", () => {
  test("an invalid toucher (no client) cannot touch a flag", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, true);
    const notAPlayer = g_edicts[10];
    if (notAPlayer === undefined) throw new Error("no edict");
    notAPlayer.inuse = true;
    notAPlayer.classname = "not_a_player";

    expect(ctf_flagtouch(flag, notAPlayer)).toBe(false);
    expect(flag.owner).toBeNull();
  });

  test("matchstate >= MATCH_RAILGUN_COUNTDOWN blocks every touch", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, true);
    const enemy = makePlayer(1, CTF_TEAM_BLUE);
    SetMatchState(MatchStatesT.MATCH_RAILGUN_COUNTDOWN);

    expect(ctf_flagtouch(flag, enemy)).toBe(false);
    expect(flag.owner).toBeNull();

    SetMatchState(MatchStatesT.MATCH_NONE); // don't pollute later tests
  });

  test("touching your own at-home flag while not carrying anything does nothing", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, true);
    const owner = makePlayer(1, CTF_TEAM_RED);
    const scoreBefore = owner.client?.resp.score ?? -1;

    expect(ctf_flagtouch(flag, owner)).toBe(false);
    expect(owner.client?.resp.score).toBe(scoreBefore);
    expect(flag.owner).toBeNull();
  });

  test("touching your own flag away from home returns it (return-ping)", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, false); // dropped away from home
    const returner = makePlayer(1, CTF_TEAM_RED);
    // ctf_ResetFlagProps ends with a trace-to-floor that snaps s.origin to
    // tr.endpos; queue it to land exactly on homeposition (the fake
    // trace() otherwise always returns the origin-default (0,0,0)).
    traceQueue.push({ ...defaultTrace(), endpos: vec3(flag.homeposition[0], flag.homeposition[1], flag.homeposition[2]) });

    expect(ctf_flagtouch(flag, returner)).toBe(false);
    // ctf_resetflagandplayer copies homeposition back into s.origin.
    expect(flag.s.origin[0]).toBe(flag.homeposition[0]);
    expect(returner.client?.resp.score).toBe(1); // STATS_RETURNS + 1 score, C source's literal `+= 1`
    expect(returner.client?.return_flag_time).toBe(level.time);
  });

  test("touching an enemy flag picks it up: owner set, inventory incremented, glow shell applied", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, true);
    const thief = makePlayer(1, CTF_TEAM_BLUE);

    expect(ctf_flagtouch(flag, thief)).toBe(true);
    expect(flag.owner).toBe(thief);
    expect(flag.solid).toBe(SolidT.SOLID_NOT);
    expect(thief.client?.pers.inventory[flagItemIndex()]).toBe(1);
    expect((thief.s.effects & EF_COLOR_SHELL) !== 0).toBe(true);
  });

  test("a frozen enemy flag (refset bit) cannot be picked up", () => {
    setupWorld();
    gameCvars.refset = fakeCvar(1); // CTF_RED_FLAG_FROZEN (lmctf60/q_shared.h)
    const flag = makeFlag(20, CTF_TEAM_RED, true);
    const thief = makePlayer(1, CTF_TEAM_BLUE);

    expect(ctf_flagtouch(flag, thief)).toBe(false);
    expect(flag.owner).toBeNull();
  });

  test("capturing: carrying the enemy flag home scores the carrier and resets the enemy flag", () => {
    setupWorld();
    const redFlag = makeFlag(20, CTF_TEAM_RED, true); // home base being touched
    const blueFlag = makeFlag(21, CTF_TEAM_BLUE, false); // the "stolen" flag, away from its own home
    const carrier = makePlayer(1, CTF_TEAM_RED);
    if (carrier.client === null) throw new Error("no client");
    carrier.client.pers.inventory[flagItemIndex()] = 1; // carrying the (single, shared) flag item
    blueFlag.owner = carrier;
    traceQueue.push({ ...defaultTrace(), endpos: vec3(blueFlag.homeposition[0], blueFlag.homeposition[1], blueFlag.homeposition[2]) });

    expect(ctf_flagtouch(redFlag, carrier)).toBe(false); // "Can't pick up your own flag" -- capture happens, return is still false
    expect(carrier.client.resp.score).toBe(CTF_CAPTURE_BONUS_CARRIER + CTF_CAPTURE_BONUS_TEAM); // carrier bonus + own team-bonus share (sole red teammate)
    expect(blueFlag.s.origin[0]).toBe(blueFlag.homeposition[0]); // otherflag reset to home
  });

  test("a capture awards a kill-carrier assist to a teammate within the 6-second window", () => {
    setupWorld();
    const redFlag = makeFlag(20, CTF_TEAM_RED, true);
    const blueFlag = makeFlag(21, CTF_TEAM_BLUE, false);
    const carrier = makePlayer(1, CTF_TEAM_RED);
    const assister = makePlayer(2, CTF_TEAM_RED);
    if (carrier.client === null || assister.client === null) throw new Error("no client");
    carrier.client.pers.inventory[flagItemIndex()] = 1;
    blueFlag.owner = carrier;
    assister.client.kill_carrier_time = level.time - 3; // inside the 6-second window

    ctf_flagtouch(redFlag, carrier);

    // assist: +1 score, kill_carrier_time cleared -- PLUS the flat (not
    // divided) CTF_CAPTURE_BONUS_TEAM every red teammate gets from the
    // team-score loop (ctf_findplayer walks every red player, including
    // the assister, and each one gets the full scorebonus).
    expect(assister.client.resp.score).toBe(1 + CTF_CAPTURE_BONUS_TEAM);
    expect(assister.client.kill_carrier_time).toBe(0);
  });

  test("CTF_SCORE_BALANCE scales the team-capture bonus by relative team size", () => {
    setupWorld();
    gameCvars.ctfflags = fakeCvar(CTF_SCORE_BALANCE);
    const redFlag = makeFlag(20, CTF_TEAM_RED, true);
    const blueFlag = makeFlag(21, CTF_TEAM_BLUE, false);
    const carrier = makePlayer(1, CTF_TEAM_RED); // lone red player
    makePlayer(2, CTF_TEAM_BLUE);
    makePlayer(3, CTF_TEAM_BLUE);
    if (carrier.client === null) throw new Error("no client");
    carrier.client.pers.inventory[flagItemIndex()] = 1;
    blueFlag.owner = carrier;

    ctf_flagtouch(redFlag, carrier);

    // redcount=1(+1 base)=2, bluecount=2(+1 base)=3 per ctf_flagtouch's own
    // count-from-1 loop; red capturing -> scorebonus = TEAM * bluecount / redcount.
    const expectedTeamBonus = Math.trunc((CTF_CAPTURE_BONUS_TEAM * 3) / 2);
    expect(carrier.client.resp.score).toBe(CTF_CAPTURE_BONUS_CARRIER + expectedTeamBonus);
  });
});

describe("ctf_playerdropflag", () => {
  test("drops the carried enemy flag: tosses it, sets droptime/owner, wires drop_temp_touch", () => {
    setupWorld();
    const carrier = makePlayer(1, CTF_TEAM_RED);
    if (carrier.client === null) throw new Error("no client");
    carrier.client.v_angle[1] = 0; // facing +X, AngleVectors default
    const blueFlag = makeFlag(21, CTF_TEAM_BLUE, true); // the flag red's carrier is holding
    const flagItem = FindItemByClassname("flag");
    if (flagItem === null) throw new Error("flag item not found");

    // C source's own comment, preserved by g_ctffunc.ts's port: the `item`
    // parameter is never read inside ctf_playerdropflag's body -- passed
    // here only to satisfy the signature.
    ctf_playerdropflag(carrier, flagItem);

    expect(blueFlag.owner).toBe(carrier);
    expect(blueFlag.droptime).toBe(level.time);
    expect(blueFlag.touch).not.toBeNull();
    expect(blueFlag.think).not.toBeNull();
  });

  test("no-ops for a null player or a player with no client", () => {
    setupWorld();
    const flag = makeFlag(21, CTF_TEAM_BLUE, true);
    const item = flag.item;
    if (item === null) throw new Error("no item");

    expect(() => ctf_playerdropflag(null, item)).not.toThrow();

    const noClient = g_edicts[10];
    if (noClient === undefined) throw new Error("no edict");
    noClient.inuse = true;
    expect(() => ctf_playerdropflag(noClient, item)).not.toThrow();
    expect(flag.owner).toBeNull(); // untouched by either no-op call
  });
});

describe("ctf_resetflagandplayer", () => {
  test("resets flag position/props and strips the flag from a carrying player's inventory", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, false); // away from home
    const carrier = makePlayer(1, CTF_TEAM_BLUE);
    if (carrier.client === null) throw new Error("no client");
    carrier.client.pers.inventory[flagItemIndex()] = 1;
    carrier.s.effects |= EF_COLOR_SHELL;
    carrier.s.modelindex3 = 42;
    traceQueue.push({ ...defaultTrace(), endpos: vec3(flag.homeposition[0], flag.homeposition[1], flag.homeposition[2]) });

    expect(ctf_resetflagandplayer(flag, carrier)).toBe(true);
    expect(flag.s.origin[0]).toBe(flag.homeposition[0]);
    expect(carrier.client.pers.inventory[flagItemIndex()]).toBe(0);
    expect((carrier.s.effects & EF_COLOR_SHELL) !== 0).toBe(false);
    expect(carrier.s.modelindex3).toBe(0);
  });
});

describe("ctf_flagwave auto-return", () => {
  test("a flag dropped 30+ seconds ago with no valid carrier auto-returns for real", () => {
    setupWorld();
    const flag = makeFlag(20, CTF_TEAM_RED, false); // dropped away from home
    flag.droptime = level.time - 31;
    flag.owner = null; // no valid carrier
    traceQueue.push({ ...defaultTrace(), endpos: vec3(flag.homeposition[0], flag.homeposition[1], flag.homeposition[2]) });

    expect(() => ctf_flagwave(flag)).not.toThrow();
    expect(flag.s.origin[0]).toBe(flag.homeposition[0]); // really reset now, not a documented throw
  });
});

// ===========================================================================
// Health item family (g_items.ts)
// ===========================================================================

describe("health items", () => {
  test("Pickup_Health increases health, capped at max_health", () => {
    setupWorld();
    const healthEnt = g_edicts[20];
    if (healthEnt === undefined) throw new Error("no edict");
    healthEnt.count = 25;
    const player = makePlayer(1, CTF_TEAM_RED);
    player.health = 90;

    expect(Pickup_Health(healthEnt, player)).toBe(true);
    expect(player.health).toBe(100); // 90 + 25 clamped to max_health
  });

  test("Pickup_Health returns false when already at or above max health (no HEALTH_IGNORE_MAX)", () => {
    setupWorld();
    const healthEnt = g_edicts[20];
    if (healthEnt === undefined) throw new Error("no edict");
    healthEnt.count = 10;
    const player = makePlayer(1, CTF_TEAM_RED);
    player.health = 100;

    expect(Pickup_Health(healthEnt, player)).toBe(false);
    expect(player.health).toBe(100);
  });

  test("HEALTH_IGNORE_MAX (small stimpack) heals past max_health", () => {
    setupWorld();
    const healthEnt = g_edicts[20];
    if (healthEnt === undefined) throw new Error("no edict");
    healthEnt.count = 2;
    healthEnt.style = HEALTH_IGNORE_MAX;
    const player = makePlayer(1, CTF_TEAM_RED);
    player.health = 100;

    expect(Pickup_Health(healthEnt, player)).toBe(true);
    expect(player.health).toBe(102);
  });

  test("SP_item_health/_small/_mega wire real GItemT entries via SpawnItem(FindItem(\"Health\"))", () => {
    setupWorld();
    const a = g_edicts[20];
    const b = g_edicts[21];
    const c = g_edicts[22];
    if (a === undefined || b === undefined || c === undefined) throw new Error("no edict");

    SP_item_health(a);
    SP_item_health_small(b);
    SP_item_health_mega(c);

    expect(a.item?.pickup_name).toBe("Health");
    expect(a.count).toBe(10);
    expect(b.count).toBe(2);
    expect(b.style & HEALTH_IGNORE_MAX).not.toBe(0);
    expect(c.count).toBe(100);
  });

  test("MegaHealth_think ticks health back down toward max_health for an over-full owner", () => {
    setupWorld();
    const megaEnt = g_edicts[20];
    if (megaEnt === undefined) throw new Error("no edict");
    const player = makePlayer(1, CTF_TEAM_RED);
    player.health = 150;
    player.max_health = 100;
    megaEnt.owner = player;

    MegaHealth_think(megaEnt);

    expect(player.health).toBe(149);
    expect(megaEnt.nextthink).toBe(level.time + 1);
  });
});

// ===========================================================================
// target_blaster's real fire_blaster (g_weapon.ts) / blaster_touch
// ===========================================================================

describe("target_blaster / fire_blaster", () => {
  test("use_target_blaster fires a real bolt (MOD_TARGET_BLASTER's truthiness bug preserved: spawnflags=1)", () => {
    setupWorld();
    const target = g_edicts[20];
    if (target === undefined) throw new Error("no edict");
    target.classname = "target_blaster";
    SP_target_blaster(target);

    expect(() => use_target_blaster(target, null, null)).not.toThrow();

    let bolt: EdictT | undefined;
    for (let i = 0; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.classname === "bolt") bolt = e;
    }
    expect(bolt).toBeDefined();
    expect(bolt?.owner).toBe(target);
    expect(bolt?.dmg).toBe(15); // SP_target_blaster's default
    expect(bolt?.spawnflags).toBe(1); // preserved bug: hyper is always truthy here
  });

  test("fire_blaster's bolt applies damage to a takedamage target on touch", () => {
    setupWorld();
    const shooter = g_edicts[20];
    if (shooter === undefined) throw new Error("no edict");
    shooter.classname = "target_blaster";
    const victim = makePlayer(1, CTF_TEAM_RED);
    victim.health = 100;

    fire_blaster(shooter, shooter.s.origin, vec3(1, 0, 0), 15, 1000, 0, true);

    let bolt: EdictT | undefined;
    for (let i = 0; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.classname === "bolt") bolt = e;
    }
    if (bolt === undefined || bolt.touch === null) throw new Error("no bolt spawned");

    bolt.touch(bolt, victim, null, null);

    expect(victim.health).toBeLessThan(100);
  });

  test("fire_blaster's bolt fizzles harmlessly against a non-takedamage entity", () => {
    setupWorld();
    const shooter = g_edicts[20];
    if (shooter === undefined) throw new Error("no edict");
    shooter.classname = "target_blaster";
    const wall = g_edicts[10];
    if (wall === undefined) throw new Error("no edict");
    wall.inuse = true;
    wall.classname = "wall";
    wall.takedamage = 0;

    fire_blaster(shooter, shooter.s.origin, vec3(1, 0, 0), 15, 1000, 0, true);

    let bolt: EdictT | undefined;
    for (let i = 0; i < globals.num_edicts; i++) {
      const e = g_edicts[i];
      if (e !== undefined && e.classname === "bolt") bolt = e;
    }
    if (bolt === undefined || bolt.touch === null) throw new Error("no bolt spawned");

    expect(() => bolt?.touch?.(bolt, wall, null, null)).not.toThrow();
  });
});
