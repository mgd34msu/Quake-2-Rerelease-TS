/*
Unit tests for the LM_CTF (Loki's Minions CTF) game family's offhand-hook
priority feature (src/lmctf/p_weapon.ts's hook chain, src/lmctf/g_cmds.ts's
Cmd_Hook_f/Cmd_Unhook_f dispatch, src/lmctf/g_ctffunc.ts's ctf_hook_abort/
ctf_validateplayer) plus the supporting foundation (g_combat.ts's T_Damage,
g_tourney.ts's match-state queries, g_items.ts's partial item table).

Self-sufficient per .orch/preferences.md rule 13: this file calls
GetGameAPI(fakeImports) itself and never relies on another test file having
run first. Modeled after test/ctf_core.test.ts's fake-GameImports pattern.
*/

import { describe, expect, test } from "bun:test";
import { AngleVectors, vec3, VectorAdd, VectorLength, VectorScale, VectorSet } from "../src/shared/math";
import { CplaneT, CsurfaceT, CvarT, PRINT_HIGH, SURF_SKY } from "../src/shared/q_shared";
import type { Edict, GameImports, GTraceT } from "../src/lmctf/game";
import { GetGameAPI } from "../src/lmctf/g_main";
import {
  CTF_NO_GRAP_DAMAGE,
  CTF_OFFHAND_HOOK,
  CTF_TEAM_ARMOR_PROTECT,
  CTF_TEAM_NOTEAMS,
  EdictT,
  GClientT,
  MovetypeT,
  MOD_CTF_GRAPPLE,
  SetGEdicts,
  WeaponstateT,
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
import { CTF_TEAM_ANYTEAM, CTF_TEAM_BLUE, CTF_TEAM_RED, CTF_TEAM_UNDEFINED, ctf_hook_abort, ctf_validateplayer } from "../src/lmctf/g_ctffunc";
import { Cmd_Hook_f, Cmd_Unhook_f, ForceCommand, OnSameTeam } from "../src/lmctf/g_cmds";
import { Draw_Hook, fire_hook, GRAPPLE_FIRE_HOOK_SPEED, GRAPPLE_PULL_SPEED, Grapple_Bolt_Think, hook_die, hook_touch, P_ProjectSource, Weapon_Hook_Fire } from "../src/lmctf/p_weapon";
import { CheckTeamDamage, T_Damage } from "../src/lmctf/g_combat";
import { FindItem, InitItems, ITEM_INDEX } from "../src/lmctf/g_items";
import { GamePaused, Match_InCountdown, matchstate, MatchStatesT, SetMatchState } from "../src/lmctf/g_tourney";

// ---------------------------------------------------------------------------
// fake GameImports
// ---------------------------------------------------------------------------

interface Recorder {
  writeByte: number[];
  writeString: string[];
  sound: string[];
  linkentity: Edict[];
  unicast: number;
}

function makeRecorder(): Recorder {
  return { writeByte: [], writeString: [], sound: [], linkentity: [], unicast: 0 };
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

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf() {},
    centerprintf() {},
    sound(_ent, _channel, soundIdx) {
      rec.sound.push(String(soundIdx));
    },
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
    linkentity(ent) {
      rec.linkentity.push(ent);
    },
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
    WriteByte(c) {
      rec.writeByte.push(c);
    },
    WriteShort() {},
    WriteLong() {},
    WriteFloat() {},
    WriteString(s) {
      rec.writeString.push(s);
    },
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

function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = MAXCLIENTS;
  game.maxentities = MAXENTITIES;
  game.clients = Array.from({ length: MAXCLIENTS }, () => new GClientT());
  InitItems(); // re-assert game.num_items after game.clear() -- see g_items.ts

  level.clear();

  gameCvars.maxclients = fakeCvar(MAXCLIENTS);
  gameCvars.dmflags = fakeCvar(0);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(1);
  gameCvars.coop = fakeCvar(0);
  gameCvars.ctfflags = fakeCvar(0);

  globals.num_edicts = MAXENTITIES;

  traceQueue = [];
  argvQueue = [];
  SetMatchState(MatchStatesT.MATCH_NONE);
  SetRedFlag(null);
  SetBlueFlag(null);

  return rec;
}

function setCtfFlags(value: number): void {
  gameCvars.ctfflags = fakeCvar(value);
}

function makePlayer(i: number, teamnum = CTF_TEAM_RED): EdictT {
  const ent = g_edicts[i];
  if (ent === undefined) throw new Error("makePlayer: no such edict");
  ent.inuse = true;
  ent.classname = "player";
  ent.client = new GClientT();
  ent.client.pers.connected = true;
  ent.client.pers.netname = `player${i}`;
  ent.client.ctf.teamnum = teamnum;
  ent.health = 100;
  ent.max_health = 100;
  ent.takedamage = 1; // DamageT.DAMAGE_YES -- a real player entity always has this set
  return ent;
}

// Reads a field through a real function call boundary so TypeScript's
// control-flow literal-narrowing (from an earlier `x.field = SomeLiteral`
// assignment) does not leak into a later read after an intervening call
// whose effect on `field` the type checker cannot see through.
function currentWeaponstate(client: GClientT): WeaponstateT {
  return client.weaponstate;
}

function grantHook(ent: EdictT): void {
  const it = FindItem("Grappling Hook");
  if (it === null) throw new Error("test setup: Grappling Hook item missing");
  if (ent.client === null) throw new Error("grantHook: entity has no client");
  ent.client.pers.inventory[ITEM_INDEX(it)] = 1;
}

// ===========================================================================
// Command dispatch (Cmd_Hook_f / Cmd_Unhook_f)
// ===========================================================================

describe("Cmd_Hook_f dispatch", () => {
  test("observers (MOVETYPE_NOCLIP) can never hook", () => {
    setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    grantHook(ent);
    Cmd_Hook_f(ent);
    expect(ent.client?.hook ?? null).toBeNull();
  });

  test("offhand mode with hook owned and not equipped fires Weapon_Hook_Fire directly", () => {
    setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    grantHook(ent);
    expect(ent.client?.pers.weapon ?? null).not.toBe(FindItem("Grappling Hook"));

    Cmd_Hook_f(ent);

    expect(ent.client?.hook ?? null).not.toBeNull();
    expect(ent.client?.hookstate).toBe(1);
  });

  test("THE PRIORITY BEHAVIOR: firing the offhand hook never changes the equipped weapon", () => {
    setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    grantHook(ent);
    if (ent.client === null) throw new Error("no client");
    ent.client.pers.weapon = null; // "equipped weapon" is unset (e.g. blaster-equivalent) in this partial port

    const weaponBefore = ent.client.pers.weapon;
    Cmd_Hook_f(ent);
    expect(ent.client.pers.weapon).toBe(weaponBefore);

    // Also verify directly against Weapon_Hook_Fire, the offhand fire/pull
    // entry point itself (called every frame independent of weapon state):
    const weaponBefore2 = ent.client.pers.weapon;
    Weapon_Hook_Fire(ent);
    expect(ent.client.pers.weapon).toBe(weaponBefore2);
  });

  test("when the hook IS the equipped weapon, +hook forwards to +attack via ForceCommand (weapon untouched)", () => {
    const rec = setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    grantHook(ent);
    const hookItem = FindItem("Grappling Hook");
    if (ent.client === null || hookItem === null) throw new Error("setup");
    ent.client.pers.weapon = hookItem;
    level.level_name = "lmctf09"; // ForceCommand refuses to stuff before a map is loaded

    Cmd_Hook_f(ent);

    expect(ent.client.hook).toBeNull(); // Weapon_Hook_Fire was never called
    expect(ent.client.pers.weapon).toBe(hookItem); // equipped weapon still the hook item itself, untouched
    expect(rec.writeString).toContain("+attack\n");
  });

  test("no hook owned prints 'You have no hook.' and does not fire", () => {
    setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    // no grantHook() call -- inventory stays at its zero default
    Cmd_Hook_f(ent);
    expect(ent.client?.hook ?? null).toBeNull();
  });

  test("classic (non-offhand) mode calls the item's own `use` instead of Weapon_Hook_Fire", () => {
    setupWorld();
    setCtfFlags(0); // CTF_OFFHAND_HOOK unset
    const ent = makePlayer(1);
    grantHook(ent);
    let useCalled = false;
    const it = FindItem("grappling hook");
    if (it === null) throw new Error("setup");
    it.use = () => {
      useCalled = true;
    };
    Cmd_Hook_f(ent);
    expect(useCalled).toBe(true);
    expect(ent.client?.hook ?? null).toBeNull(); // Weapon_Hook_Fire not invoked in classic mode
    it.use = null; // reset shared ITEMLIST mutation for other tests
  });
});

describe("Cmd_Unhook_f dispatch", () => {
  test("when the hook is NOT the equipped weapon, -unhook aborts the hook directly", () => {
    setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    grantHook(ent);
    if (ent.client === null) throw new Error("setup");
    ent.client.hookstate = 2;
    ent.client.hook = g_edicts[5] ?? null;
    Cmd_Unhook_f(ent);
    expect(ent.client.hookstate).toBe(0);
    expect(ent.client.hook).toBeNull();
  });

  test("when the hook IS the equipped weapon, -unhook forwards to -attack instead of aborting", () => {
    const rec = setupWorld();
    setCtfFlags(CTF_OFFHAND_HOOK);
    const ent = makePlayer(1);
    grantHook(ent);
    const hookItem = FindItem("Grappling Hook");
    if (ent.client === null || hookItem === null) throw new Error("setup");
    ent.client.pers.weapon = hookItem;
    ent.client.hookstate = 2;
    level.level_name = "lmctf09";
    Cmd_Unhook_f(ent);
    expect(ent.client.hookstate).toBe(2); // NOT aborted -- forwarded instead
    expect(rec.writeString).toContain("-attack\n");
  });

  test("CTF_OFFHAND_HOOK unset: Cmd_Unhook_f is a no-op (matches the C source's absent else-branch)", () => {
    setupWorld();
    setCtfFlags(0);
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    ent.client.hookstate = 2;
    ent.client.hook = g_edicts[5] ?? null;
    Cmd_Unhook_f(ent);
    expect(ent.client.hookstate).toBe(2); // untouched
  });
});

// ===========================================================================
// Weapon_Hook_Fire state machine (fire chain + pull physics)
// ===========================================================================

describe("Weapon_Hook_Fire state 0 -> 1 (launch)", () => {
  test("spawns the bolt, sets isfiring, and advances hookstate to 1", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    ent.viewheight = 22;

    Weapon_Hook_Fire(ent);

    expect(ent.client.hookstate).toBe(1);
    expect(ent.client.isfiring).toBe(1);
    expect(ent.client.hook).not.toBeNull();
    expect(ent.client.hook?.movetype).toBe(MovetypeT.MOVETYPE_FLYMISSILE);
  });

  test("captures hookangle from the current view angle only on the very first frame", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    ent.client.v_angle = vec3(10, 20, 0);

    Weapon_Hook_Fire(ent);
    expect(Array.from(ent.client.hookangle)).toEqual([10, 20, 0]);

    ent.client.v_angle = vec3(99, 99, 0); // changing view angle after launch...
    Weapon_Hook_Fire(ent); // ...state 1 now, does not re-capture hookangle
    expect(Array.from(ent.client.hookangle)).toEqual([10, 20, 0]);
  });

  test("the bolt fires at GRAPPLE_FIRE_HOOK_SPEED (800 u/s)", () => {
    setupWorld();
    const ent = makePlayer(1);
    Weapon_Hook_Fire(ent);
    const hook = ent.client?.hook;
    if (hook === undefined || hook === null) throw new Error("no hook spawned");
    expect(VectorLength(hook.velocity)).toBeCloseTo(GRAPPLE_FIRE_HOOK_SPEED, 0);
  });
});

describe("Weapon_Hook_Fire state 2 (pull physics) vs hand-computed bands", () => {
  // Places the hook EXACTLY `distance` units from Weapon_Hook_Fire's own
  // computed muzzle point (P_ProjectSource with the same offset/angle
  // inputs it uses), rather than from ent.s.origin -- Weapon_Hook_Fire adds
  // an (8, 8, viewheight-8) muzzle offset before computing `speed`, which
  // would otherwise skew every band boundary by a few units.
  function primeHookAt(ent: EdictT, distance: number): EdictT {
    if (ent.client === null) throw new Error("setup");
    const hook = g_edicts[10];
    if (hook === undefined) throw new Error("setup");
    hook.inuse = true;
    hook.owner = ent;
    ent.s.origin = vec3(0, 0, 0);
    // viewheight = 8 zeroes P_ProjectSource's Z offset (`ent.viewheight - 8`
    // = 0) and, since v_angle is level (pitch 0), forward/right have no Z
    // component either -- so `start`'s Z coordinate matches ent.origin's Z
    // exactly regardless of the X/Y muzzle-offset skew, keeping these
    // distance-band assertions independent of that skew.
    ent.viewheight = 8;
    ent.gravity = 1.0; // G_InitEdict's default for a real spawned entity
    ent.client.v_angle = vec3(0, 0, 0);

    const forward = vec3();
    const right = vec3();
    const offset = vec3();
    const start = vec3();
    AngleVectors(ent.client.v_angle, forward, right, null);
    VectorSet(offset, 8, 8, ent.viewheight - 8);
    P_ProjectSource(ent.client, ent.s.origin, offset, forward, right, start);

    const placed = vec3();
    VectorScale(forward, distance, placed);
    VectorAdd(start, placed, placed);
    hook.s.origin = placed;

    ent.client.hook = hook;
    ent.client.hookstate = 2;
    return hook;
  }

  test("distance > 120: velocity magnitude is exactly GRAPPLE_PULL_SPEED (800), gravity applied", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 200);
    gameCvars.sv_gravity = fakeCvar(800);
    Weapon_Hook_Fire(ent);
    // BUG-FOR-BUG (lmctf60/p_weapon.c, preserved -- see p_weapon.ts's
    // Weapon_Hook_Fire doc comment): addGravity(ent) modifies `ent.velocity`
    // in place, but the very next statement (outside this band's branch)
    // unconditionally does `VectorCopy(dir, ent.velocity)`, overwriting
    // whatever addGravity just did. The call is real and matches the C
    // source exactly, but its effect on the final velocity is always
    // discarded -- gravity never actually reaches the player's velocity
    // here. `ent.velocity[2]` therefore stays exactly what `dir[2]` was
    // (0, per primeHookAt's viewheight-8 note), not -80.
    expect(VectorLength(ent.velocity)).toBeCloseTo(GRAPPLE_PULL_SPEED, 0);
    expect(ent.velocity[2]).toBeCloseTo(0, 0);
  });

  test("distance in (100,120]: velocity magnitude is distance*5, no gravity added", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 110);
    gameCvars.sv_gravity = fakeCvar(800);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(110 * 5, -1);
  });

  test("distance in (80,100]: velocity magnitude is distance*4", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 90);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(90 * 4, -1);
  });

  test("distance in (40,80]: velocity magnitude is distance*3", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 60);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(60 * 3, -1);
  });

  test("distance in (20,40]: velocity magnitude is distance*2", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 30);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(30 * 2, -1);
  });

  test("distance in (10,20]: velocity magnitude is distance*1", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 15);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(15, -1);
  });

  test("distance <= 10: no band matches, velocity stays a unit vector (never fully locks like ThreeWave's HANG state)", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 5);
    Weapon_Hook_Fire(ent);
    expect(VectorLength(ent.velocity)).toBeCloseTo(1, 1);
  });

  test("oldvelocity mirrors velocity every frame (fall-damage suppression)", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 200);
    Weapon_Hook_Fire(ent);
    expect(Array.from(ent.client?.oldvelocity ?? [])).toEqual(Array.from(ent.velocity));
  });

  test("hooklength tracks the live distance every frame (no smoothing)", () => {
    setupWorld();
    const ent = makePlayer(1);
    primeHookAt(ent, 150);
    Weapon_Hook_Fire(ent);
    expect(ent.client?.hooklength).toBeCloseTo(150, 0);
  });

  test("if client.hook is somehow null in state 2, hookstate resets to 0", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    ent.client.hookstate = 2;
    ent.client.hook = null;
    Weapon_Hook_Fire(ent);
    expect(ent.client.hookstate).toBe(0);
  });

  test("a moving hook_target updates the bolt's rendered position via hook_offset tracking", () => {
    setupWorld();
    const ent = makePlayer(1);
    const hook = primeHookAt(ent, 200);
    const target = g_edicts[11];
    if (target === undefined) throw new Error("setup");
    target.absmin = vec3(50, 0, 0);
    hook.hook_target = target;
    hook.hook_offset = vec3(3, 0, 0);
    Weapon_Hook_Fire(ent);
    expect(Array.from(hook.s.origin)).toEqual([53, 0, 0]);
  });
});

describe("Weapon_Hook_Fire default/bug branch", () => {
  test("an out-of-range hookstate aborts the hook (mirrors the C source's own 'bug' comment)", () => {
    setupWorld();
    const ent = makePlayer(1);
    grantHook(ent);
    if (ent.client === null) throw new Error("setup");
    ent.client.hookstate = 99;
    ent.client.hook = g_edicts[5] ?? null;
    Weapon_Hook_Fire(ent);
    expect(ent.client.hookstate).toBe(0);
    expect(ent.client.hook).toBeNull();
  });
});

// ===========================================================================
// hook_touch (detach/abort conditions + damage)
// ===========================================================================

describe("hook_touch", () => {
  function makeBolt(owner: EdictT): EdictT {
    const bolt = g_edicts[8];
    if (bolt === undefined) throw new Error("setup");
    bolt.inuse = true;
    bolt.owner = owner;
    bolt.classname = "noclass";
    if (owner.client !== null) owner.client.hook = bolt;
    return bolt;
  }

  test("touching your own owner is ignored (no abort, no damage)", () => {
    setupWorld();
    const owner = makePlayer(1);
    const bolt = makeBolt(owner);
    hook_touch(bolt, owner, null, null);
    expect(owner.client?.hookstate).toBe(0); // untouched
  });

  test("touching an invalid classname (not player/bodyque/worldspawn/func*/info_flag*) aborts", () => {
    setupWorld();
    const owner = makePlayer(1);
    const bolt = makeBolt(owner);
    const junk = g_edicts[9];
    if (junk === undefined || owner.client === null) throw new Error("setup");
    junk.classname = "item_health";
    owner.client.hook = bolt;
    hook_touch(bolt, junk, null, null);
    expect(owner.client.hook).toBeNull(); // ctf_hook_abort freed it
  });

  test("touching worldspawn is valid (does not abort) and locks hook_target", () => {
    setupWorld();
    const owner = makePlayer(1);
    const bolt = makeBolt(owner);
    const wall = g_edicts[9];
    if (wall === undefined) throw new Error("setup");
    wall.classname = "worldspawn";
    hook_touch(bolt, wall, null, null);
    expect(bolt.hook_target).toBe(wall);
  });

  test("hitting the sky (SURF_SKY) aborts the hook", () => {
    setupWorld();
    const owner = makePlayer(1);
    const bolt = makeBolt(owner);
    const wall = g_edicts[9];
    if (wall === undefined || owner.client === null) throw new Error("setup");
    wall.classname = "worldspawn";
    owner.client.hook = bolt;
    const skySurf = new CsurfaceT();
    skySurf.flags = SURF_SKY;
    hook_touch(bolt, wall, null, skySurf);
    expect(owner.client.hook).toBeNull();
  });

  test("hitting a teammate aborts the hook (no damage, no latch)", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const teammate = makePlayer(2, CTF_TEAM_RED);
    const bolt = makeBolt(owner);
    hook_touch(bolt, teammate, null, null);
    expect(owner.client?.hook ?? null).toBeNull();
    expect(bolt.hook_target).toBeNull();
  });

  test("hitting an enemy player deals 8/8 bonus damage on first contact", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    const bolt = makeBolt(owner);
    const healthBefore = enemy.health;
    hook_touch(bolt, enemy, null, null);
    expect(enemy.health).toBe(healthBefore - 8);
    expect(bolt.hook_target).toBe(enemy);
  });

  test("continuous contact deals 1/1 damage only every 7th framenum, not every touch", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    const bolt = makeBolt(owner);
    hook_touch(bolt, enemy, null, null); // first hit: 8 damage, locks hook_target
    const healthAfterFirst = enemy.health;

    level.framenum = 1; // not a multiple of 7
    hook_touch(bolt, enemy, null, null);
    expect(enemy.health).toBe(healthAfterFirst); // no additional damage yet

    level.framenum = 7; // multiple of 7
    hook_touch(bolt, enemy, null, null);
    expect(enemy.health).toBe(healthAfterFirst - 1);
  });

  test("CTF_NO_GRAP_DAMAGE suppresses damage against clients but not against non-clients", () => {
    setupWorld();
    setCtfFlags(CTF_NO_GRAP_DAMAGE);
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    const bolt = makeBolt(owner);
    const healthBefore = enemy.health;
    hook_touch(bolt, enemy, null, null);
    expect(enemy.health).toBe(healthBefore); // no damage: CTF_NO_GRAP_DAMAGE + other.client !== null

    // Fresh owner/bolt: the bolt above already latched hook_target onto
    // `enemy`, and hook_touch ignores any further target once locked -- a
    // second, independent bolt is needed to exercise the other.client ===
    // null path.
    const owner2 = makePlayer(3, CTF_TEAM_RED);
    const bolt2 = g_edicts[16];
    if (bolt2 === undefined) throw new Error("setup");
    bolt2.inuse = true;
    bolt2.owner = owner2;
    if (owner2.client !== null) owner2.client.hook = bolt2;

    const wall = g_edicts[9];
    if (wall === undefined) throw new Error("setup");
    wall.classname = "worldspawn";
    wall.health = 500;
    hook_touch(bolt2, wall, null, null); // other.client === null -- damage still allowed
    // wall has no client, so T_Damage runs against it regardless of the flag;
    // wall.takedamage defaults to 0 (DAMAGE_NO) so T_Damage's own early
    // return means health is untouched here too -- this assertion instead
    // confirms hook_touch did not abort/throw on a non-client target and
    // still latched onto it.
    expect(bolt2.hook_target).toBe(wall);
  });

  test("touching an already-dead body aborts the hook", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    enemy.deadflag = 2; // DEAD_DEAD
    const bolt = makeBolt(owner);
    hook_touch(bolt, enemy, null, null);
    expect(owner.client?.hook ?? null).toBeNull();
  });

  test("a locked hook_target ignores touches from any other entity", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    const other = makePlayer(3, CTF_TEAM_BLUE);
    const bolt = makeBolt(owner);
    hook_touch(bolt, enemy, null, null);
    expect(bolt.hook_target).toBe(enemy);
    hook_touch(bolt, other, null, null); // ignored: hook_target already locked to `enemy`
    expect(bolt.hook_target).toBe(enemy);
  });

  test("first-ever latch captures hook_offset and switches solid to SOLID_TRIGGER", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    enemy.absmin = vec3(10, 20, 30);
    const bolt = makeBolt(owner);
    bolt.s.origin = vec3(15, 25, 35);
    hook_touch(bolt, enemy, null, null);
    expect(Array.from(bolt.hook_offset)).toEqual([5, 5, 5]);
    expect(bolt.solid).toBe(1 /* SolidT.SOLID_TRIGGER */);
  });
});

// ===========================================================================
// ctf_hook_abort / hook_die (detach)
// ===========================================================================

describe("ctf_hook_abort", () => {
  test("resets hookstate/hooklength and frees the hook entity", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    // index 20 is well past G_FreeEdict's protected range
    // (0..maxclients+BODY_QUEUE_SIZE = 0..12 with MAXCLIENTS=4), so
    // G_FreeEdict actually clears/frees it instead of silently refusing.
    const hook = g_edicts[20];
    if (hook === undefined) throw new Error("setup");
    hook.inuse = true;
    ent.client.hook = hook;
    ent.client.hookstate = 2;
    ent.client.hooklength = 55;

    ctf_hook_abort(ent);

    expect(ent.client.hookstate).toBe(0);
    expect(ent.client.hooklength).toBe(0);
    expect(ent.client.hook).toBeNull();
    expect(hook.inuse).toBe(false);
  });

  test("is a no-op on a null entity or an entity with no client", () => {
    setupWorld();
    expect(() => ctf_hook_abort(null)).not.toThrow();
    const nonClient = g_edicts[7];
    if (nonClient === undefined) throw new Error("setup");
    expect(() => ctf_hook_abort(nonClient)).not.toThrow();
  });

  test("stops firing (WEAPON_READY) only when the hook is the current weapon and mid-fire", () => {
    setupWorld();
    const ent = makePlayer(1);
    grantHook(ent);
    if (ent.client === null) throw new Error("setup");
    ent.client.pers.weapon = FindItem("Grappling Hook");
    ent.client.weaponstate = WeaponstateT.WEAPON_FIRING;
    ctf_hook_abort(ent);
    expect(currentWeaponstate(ent.client) === WeaponstateT.WEAPON_READY).toBe(true);
  });

  test("hook_die (shot down) aborts exactly like a manual unhook", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    const hook = g_edicts[6];
    if (hook === undefined) throw new Error("setup");
    hook.owner = ent;
    ent.client.hook = hook;
    ent.client.hookstate = 1;
    hook_die(hook, ent, ent, 59, vec3());
    expect(ent.client.hookstate).toBe(0);
    expect(ent.client.hook).toBeNull();
  });
});

// ===========================================================================
// Grapple_Bolt_Think (sound-cue scheduling)
// ===========================================================================

describe("Grapple_Bolt_Think", () => {
  test("schedules an in-flight sound every 0.4s while nothing is latched and hooklength > 126", () => {
    setupWorld();
    const owner = makePlayer(1);
    if (owner.client === null) throw new Error("setup");
    owner.client.hooklength = 200;
    const bolt = g_edicts[8];
    if (bolt === undefined) throw new Error("setup");
    bolt.owner = owner;
    bolt.hook_target = null;
    level.time = 10;
    Grapple_Bolt_Think(bolt);
    expect(bolt.nextthink).toBeCloseTo(10.4, 5);
    expect(bolt.think).toBe(Grapple_Bolt_Think);
  });

  test("schedules a retracting sound every 0.8s once latched, still hooklength > 126", () => {
    setupWorld();
    const owner = makePlayer(1);
    if (owner.client === null) throw new Error("setup");
    owner.client.hooklength = 200;
    const bolt = g_edicts[8];
    const target = g_edicts[9];
    if (bolt === undefined || target === undefined) throw new Error("setup");
    bolt.owner = owner;
    bolt.hook_target = target;
    level.time = 10;
    Grapple_Bolt_Think(bolt);
    expect(bolt.nextthink).toBeCloseTo(10.8, 5);
  });

  test("goes silent (no re-schedule) once hooklength drops to <= 126", () => {
    setupWorld();
    const owner = makePlayer(1);
    if (owner.client === null) throw new Error("setup");
    owner.client.hooklength = 100;
    const bolt = g_edicts[8];
    if (bolt === undefined) throw new Error("setup");
    bolt.owner = owner;
    bolt.nextthink = 999;
    Grapple_Bolt_Think(bolt);
    expect(bolt.nextthink).toBe(0);
    expect(bolt.think).toBeNull();
  });
});

// ===========================================================================
// fire_hook / Draw_Hook
// ===========================================================================

describe("fire_hook", () => {
  test("spawns a bolt with the standard grapple bolt properties", () => {
    setupWorld();
    const owner = makePlayer(1);
    const bolt = fire_hook(owner, vec3(0, 0, 0), vec3(1, 0, 0), GRAPPLE_FIRE_HOOK_SPEED);
    expect(bolt.owner).toBe(owner);
    expect(bolt.health).toBe(59);
    expect(bolt.dmg).toBe(2);
    expect(bolt.touch).toBe(hook_touch);
    expect(bolt.die).toBe(hook_die);
  });

  test("a point-blank obstruction (trace fraction < 1.0) registers a touch on the very first frame", () => {
    setupWorld();
    const owner = makePlayer(1, CTF_TEAM_RED);
    const enemy = makePlayer(2, CTF_TEAM_BLUE);
    const tr = defaultTrace();
    tr.fraction = 0.1;
    tr.ent = enemy;
    traceQueue = [tr];
    const bolt = fire_hook(owner, vec3(0, 0, 0), vec3(1, 0, 0), GRAPPLE_FIRE_HOOK_SPEED);
    expect(bolt.hook_target).toBe(enemy); // hook_touch ran synchronously inside fire_hook
  });
});

describe("Draw_Hook", () => {
  test("does not broadcast a cable shorter than 64 units", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    Draw_Hook(ent, vec3(0, 0, 0), vec3(10, 0, 0));
    expect(rec.writeByte.length).toBe(0);
  });

  test("broadcasts TE_GRAPPLE_CABLE for a cable longer than 64 units", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    Draw_Hook(ent, vec3(0, 0, 0), vec3(200, 0, 0));
    expect(rec.writeByte.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// ForceCommand
// ===========================================================================

describe("ForceCommand", () => {
  test("refuses to stuff text before a level is loaded", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    level.level_name = "";
    ForceCommand(ent, "+attack\n");
    expect(rec.unicast).toBe(0);
  });

  test("stuffs the command once a level is loaded", () => {
    const rec = setupWorld();
    const ent = makePlayer(1);
    level.level_name = "lmctf09";
    ForceCommand(ent, "+attack\n");
    expect(rec.unicast).toBe(1);
    expect(rec.writeString).toContain("+attack\n");
  });
});

// ===========================================================================
// OnSameTeam / CTF_TEAM_NOTEAMS
// ===========================================================================

describe("OnSameTeam", () => {
  test("two players with the same teamnum are on the same team", () => {
    setupWorld();
    const a = makePlayer(1, CTF_TEAM_RED);
    const b = makePlayer(2, CTF_TEAM_RED);
    expect(OnSameTeam(a, b)).toBe(true);
  });

  test("CTF_TEAM_NOTEAMS forces false even for matching teamnums", () => {
    setupWorld();
    setCtfFlags(CTF_TEAM_NOTEAMS);
    const a = makePlayer(1, CTF_TEAM_RED);
    const b = makePlayer(2, CTF_TEAM_RED);
    expect(OnSameTeam(a, b)).toBe(false);
  });
});

// ===========================================================================
// T_Damage / CheckTeamDamage (the hook's damage path)
// ===========================================================================

describe("T_Damage via the hook's damage path", () => {
  test("Match_InCountdown suppresses ALL damage, including hook damage", () => {
    setupWorld();
    SetMatchState(MatchStatesT.MATCH_COUNTDOWN);
    const attacker = makePlayer(1, CTF_TEAM_RED);
    const targ = makePlayer(2, CTF_TEAM_BLUE);
    targ.takedamage = 1;
    const before = targ.health;
    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), vec3(), vec3(0, 0, 1), 8, 8, 4 /* DAMAGE_ENERGY */, MOD_CTF_GRAPPLE);
    expect(targ.health).toBe(before);
  });

  test("CTF_TEAM_ARMOR_PROTECT blocks armor-check but CheckTeamDamage still applies for teammates", () => {
    setupWorld();
    setCtfFlags(CTF_TEAM_ARMOR_PROTECT);
    const attacker = makePlayer(1, CTF_TEAM_RED);
    const targ = makePlayer(2, CTF_TEAM_RED); // same team
    targ.takedamage = 1;
    const before = targ.health;
    T_Damage(targ, attacker, attacker, vec3(1, 0, 0), vec3(), vec3(0, 0, 1), 8, 8, 4, MOD_CTF_GRAPPLE);
    expect(targ.health).toBe(before); // CheckTeamDamage returns true -> no damage applied
  });

  test("hitting a flag carrier sets attacker.client.hit_carrier_time", () => {
    setupWorld();
    const attacker = makePlayer(1, CTF_TEAM_RED);
    const carrier = makePlayer(2, CTF_TEAM_BLUE);
    carrier.takedamage = 1;
    const flag = g_edicts[15];
    if (flag === undefined) throw new Error("setup");
    flag.owner = carrier;
    SetRedFlag(flag);
    level.time = 42;

    T_Damage(carrier, attacker, attacker, vec3(1, 0, 0), vec3(), vec3(0, 0, 1), 8, 8, 4, MOD_CTF_GRAPPLE);

    expect(attacker.client?.hit_carrier_time).toBe(42);
  });

  test("CheckTeamDamage allows self-damage even between the same 'team' (targ === attacker)", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_RED);
    expect(CheckTeamDamage(ent, ent)).toBe(false);
  });

  test("CheckTeamDamage is bypassed during MATCH_RAILGUN_INPLAY (team damage allowed)", () => {
    setupWorld();
    SetMatchState(MatchStatesT.MATCH_RAILGUN_INPLAY);
    const a = makePlayer(1, CTF_TEAM_RED);
    const b = makePlayer(2, CTF_TEAM_RED);
    expect(CheckTeamDamage(a, b)).toBe(false);
  });
});

// ===========================================================================
// g_tourney.ts minimal slice
// ===========================================================================

describe("g_tourney.ts minimal slice", () => {
  test("GamePaused defaults to false (nothing has ported SetPause yet)", () => {
    expect(GamePaused()).toBe(false);
  });

  test("Match_InCountdown reflects the current matchstate", () => {
    SetMatchState(MatchStatesT.MATCH_COUNTDOWN);
    expect(Match_InCountdown()).toBe(true);
    SetMatchState(MatchStatesT.MATCH_NONE);
    expect(Match_InCountdown()).toBe(false);
    expect(matchstate).toBe(MatchStatesT.MATCH_NONE);
  });
});

// ===========================================================================
// ctf_validateplayer / g_ctffunc.ts foundation
// ===========================================================================

describe("ctf_validateplayer", () => {
  test("a connected, in-use player entity classnamed 'player' validates for CTF_TEAM_IGNORETEAM", () => {
    setupWorld();
    const ent = makePlayer(1);
    expect(ctf_validateplayer(ent, -4 /* CTF_TEAM_IGNORETEAM */)).toBe(true);
  });

  test("CTF_TEAM_ANYTEAM requires a defined team (> CTF_TEAM_UNDEFINED)", () => {
    setupWorld();
    const ent = makePlayer(1, CTF_TEAM_UNDEFINED);
    expect(ctf_validateplayer(ent, CTF_TEAM_ANYTEAM)).toBe(false);
    if (ent.client !== null) ent.client.ctf.teamnum = CTF_TEAM_RED;
    expect(ctf_validateplayer(ent, CTF_TEAM_ANYTEAM)).toBe(true);
  });

  test("a null entity never validates", () => {
    setupWorld();
    expect(ctf_validateplayer(null, -4)).toBe(false);
  });

  test("a disconnected client does not validate", () => {
    setupWorld();
    const ent = makePlayer(1);
    if (ent.client === null) throw new Error("setup");
    ent.client.pers.connected = false;
    expect(ctf_validateplayer(ent, -4)).toBe(false);
  });
});
