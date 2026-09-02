/*
Unit tests for the kex m_insane.cpp/m_actor.cpp/m_shambler.cpp/
m_guardian.cpp/m_arachnid.cpp ports (src/kexgame/m_insane.ts, m_actor.ts,
m_shambler.ts, m_guardian.ts, m_arachnid.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture, mutable
per-test `traceImpl` hook, `makeMonster`/`setupWorld`/`stepFrame`/
`pendingOrActiveMove`/`requireMmove` helpers) is copied from
test/kexgame_monsters2.test.ts's own established pattern (itself copied from
test/kexgame_monsters1.test.ts, itself from test/kexgame_g_monster.test.ts),
kept module-private per that same precedent.

Design note on reaching per-file internals without new exports: none of
these five files export their mmove tables or per-frame thinkfuncs
(insane_checkdown, actorMachineGun, ShamblerCastLightning,
guardian_fire_blaster, arachnid_rail, etc.) -- every one of those symbols is
either a plain module-private function (frame-function fields are plain, not
save-registry-typed, per g_local_types.ts) or is save-registered under its
exact C++ name via g_save_registry.ts's RegisterX family. This suite reaches
all of it through the SAME registry the real game uses for save/load:
LookupMmove/LookupThink/LookupMonsterinfoStand etc., by the literal C++
function name each file registered it under -- no new exports were added to
any of the five files for testability. Attack-fire constants are exercised
by staging the real, registry-fetched mmove table via M_SetAnimation and
stepping M_MoveFrame (forcing next_move_time to GTIME_ZERO each step,
matching kexgame_monsters2.test.ts's `stepFrame`), which runs the real
per-frame thinkfunc chain rather than reimplementing any AI.

Scope (18 cases, each citing the exact C++ line(s) it exercises):

  INSANE (m_insane.cpp):
    - mmove sanity: insane_move_down's frame array satisfies
      lastframe-firstframe+1 (MmoveT's constructor-time validator).
    - spawnflag variant: insane_stand w/ SPAWNFLAG_INSANE_CRUCIFIED (8) picks
      insane_move_cross and sets AI_STAND_GROUND (m_insane.cpp:550-556).
    - spawnflag variant: insane_stand w/ CRAWL|STAND_GROUND (4|16) picks
      insane_move_down deterministically, no RNG (m_insane.cpp:557-562).
    - distinctive: SP_misc_insane w/ CRUCIFIED calls stationarymonster_start
      (m_insane.cpp:683-687), which is defined at
      rerelease/rogue/g_rogue_monster.cpp:88-96 and lives here in
      src/kexgame/rogue/g_rogue_monster.ts. It used to be a throwing stub in
      g_monster.ts on the mistaken claim that no definition existed; the
      cross-module map sweep (test/parity_map_sweep.test.ts) found that this
      killed fourteen shipped maps under the re-release module, so this test
      now pins the real behaviour: FL_STATIONARY set, viewheight zeroed,
      think armed on stationarymonster_start_go, and no throw.

  ACTOR (m_actor.cpp):
    - mmove sanity: actor_move_attack's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: actor_run w/ AI_STAND_GROUND picks actor_stand's
      actor_move_stand instead of actor_move_run (m_actor.cpp:114-118).
    - attack-fire: actorMachineGun's monster_fire_bullet call, damage=3
      kick=4 (m_actor.cpp:233-260), reached via actor_move_attack's first
      frame (actor_fire, m_actor.cpp:339-340).

  SHAMBLER (m_shambler.cpp) -- NEW re-release monster, no legacy precedent:
    - mmove sanity: shambler_attack_magic's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: shambler_run w/ a client enemy sets AI_BRUTAL and
      (without AI_STAND_GROUND) picks shambler_move_run (m_shambler.cpp:
      163-177).
    - attack constant: ShamblerCastLightning's fire_bullet call,
      damage=irandom(8,12) (8..11 inclusive) kick=15, MOD_TESLA
      (m_shambler.cpp:287-315), reached by driving shambler_attack_magic
      through its windup/lightning-update/save-loc lead-in to its first
      ShamblerCastLightning frame (FRAME_magic09, m_shambler.cpp:317-330).

  GUARDIAN (m_guardian.cpp) -- NEW re-release monster, no legacy precedent:
    - mmove sanity: guardian_move_atk1_spin's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: guardian_attack picks guardian_move_atk2_in when
      the enemy is farther than RANGE_NEAR=440 (m_guardian.cpp:381-394).
    - guardian laser (distinctive + attack constant): guardian_laser_fire
      (guardian_move_atk2_fire's every frame, m_guardian.cpp:329-334) plays
      sound_laser then calls monster_fire_dabeam(self, 25, ...)
      (m_guardian.cpp:323-327), which is a real port (g_xatrix_monster.ts)
      -- spawns the beam entity and applies MOD_TARGET_LASER damage through
      guardian_fire_update (m_guardian.cpp:302-320).

  ARACHNID (m_arachnid.cpp) -- NEW re-release monster, no legacy precedent:
    - mmove sanity: arachnid_attack1's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: arachnid_attack picks arachnid_melee when in
      melee range and melee_debounce_time has elapsed (m_arachnid.cpp:
      261-272).
    - attack constant: arachnid_rail's monster_fire_railgun call, damage=35
      kick=100 (m_arachnid.cpp:163-195), reached by driving arachnid_attack1
      through its charge-rail lead-in to its first arachnid_rail frame
      (FRAME_rails4, m_arachnid.cpp:197-210).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, EntFlagsT, MonsterAiFlagsT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { M_SetAnimation, M_MoveFrame } from "../src/kexgame/g_monster";
import { defaultGClient } from "../src/kexgame/p_client";
import { SpawnFlags_from, SpawnFlags_or } from "../src/kexgame/spawnflags";
import {
  LookupMmove,
  LookupMonsterinfoStand,
  LookupMonsterinfoRun,
  LookupMonsterinfoAttack,
} from "../src/kexgame/g_save_registry";

// importing these five modules runs every MmoveT constructor in them; a
// throw here would fail the whole file before any test runs (the same
// "successful import IS an assertion" idiom kexgame_monsters1.test.ts uses
// for infantry's un-exported tables).
import { SP_misc_insane } from "../src/kexgame/m_insane";
import { stationarymonster_start_go } from "../src/kexgame/rogue/g_rogue_monster";
import "../src/kexgame/m_actor";
import "../src/kexgame/m_shambler";
import "../src/kexgame/m_guardian";
import "../src/kexgame/m_arachnid";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied from
// test/kexgame_monsters2.test.ts's own module-private fixture)
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

/** A "hit" trace against `target`, for tests that need gi.trace to resolve
 *  to a specific live entity (bullet/rocket/rail hitscans and fire_hit's
 *  short box-distance traces). */
function hitTrace(end: Vec3, target: EdictT, fraction = 0.5): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: target,
    plane2: new CplaneT(),
    surface2: null,
  };
}

let traceImpl: (start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passent: KexEdictT | null, mask: number) => KexTraceT =
  (_start, _mins, _maxs, end) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

interface Recorder {
  soundCalls: string[];
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
    Com_Print() {},
    Client_Print() {},
    Center_Print() {},
    sound(_ent, _channel, soundIdx) {
      rec.soundCalls.push(soundNamesById[soundIdx] ?? `#${soundIdx}`);
    },
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
    soundindex,
    imageindex() {
      return 0;
    },
    setmodel() {},
    trace(start, mins, maxs, end, passent, mask) {
      return traceImpl(start, mins, maxs, end, passent, mask);
    },
    clip(_entity, _start, _mins, _maxs, end) {
      return noHitTrace(end);
    },
    pointcontents(point) {
      return pointcontentsImpl(point);
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

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(numEdicts: number): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < 16; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = 4;
  game.maxentities = 16;
  level.time = GTIME_ZERO;
  level.gravity = 800;
  level.total_monsters = 0;
  level.killed_monsters = 0;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;
  rec = { soundCalls: [] };

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts };
}

/** A live, non-world monster entity with sane physics defaults, a typical
 *  monster bbox, and takedamage on (matches every fire_hit/T_Damage call
 *  site's expectations). */
function makeMonster(index: number, origin: Vec3 = vec3(0, 0, 0)): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.gravity = 1;
  e.gravityVector = vec3(0, 0, -1);
  e.classname = "test_monster";
  e.solid = SolidT.SOLID_BBOX;
  e.movetype = MovetypeT.MOVETYPE_STEP;
  e.svflags |= SvflagsT.SVF_MONSTER;
  e.takedamage = true;
  e.health = 100;
  e.max_health = 100;
  e.mins = vec3(-16, -16, -24);
  e.maxs = vec3(16, 16, 32);
  e.s.origin = vec3(origin[0], origin[1], origin[2]);
  // T_Damage's M_ReactToDamage path calls FoundTarget/HuntTarget on a
  // damaged SVF_MONSTER entity, which throws if monsterinfo.stand/run are
  // null -- harmless no-op defaults, overwritten by tests that need the
  // real handlers.
  e.monsterinfo.stand = () => {};
  e.monsterinfo.run = () => {};
  gi.linkentity(e);
  return e;
}

/** Forces exactly one M_MoveFrame animation step regardless of level.time
 *  pacing. */
function stepFrame(self: EdictT, times = 1): void {
  for (let i = 0; i < times; i++) {
    self.monsterinfo.next_move_time = GTIME_ZERO;
    M_MoveFrame(self);
  }
}

/** The move a monsterinfo.stand/run/etc. handler just selected, whether
 *  M_SetAnimation used instant=true (active_move updates synchronously) or
 *  instant=false (only next_move is staged). */
function pendingOrActiveMove(self: EdictT) {
  return self.monsterinfo.next_move ?? self.monsterinfo.active_move;
}

/** Fetches a save-registered mmove table by its exact C++ name, failing the
 *  test immediately (not silently skipping) if the name isn't registered --
 *  a wrong/renamed literal here would otherwise pass as "undefined equals
 *  undefined". */
function requireMmove(name: string) {
  const m = LookupMmove(name);
  if (m === null) throw new Error(`LookupMmove("${name}") returned null -- not registered`);
  return m;
}

// ---------------------------------------------------------------------------
// INSANE (m_insane.cpp)
// ---------------------------------------------------------------------------

describe("insane", () => {
  test("mmove sanity: insane_move_down's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("insane_move_down");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("spawnflag variant: insane_stand w/ CRUCIFIED (8) picks insane_move_cross and sets AI_STAND_GROUND (m_insane.cpp:550-556)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.spawnflags = SpawnFlags_from(8); // SPAWNFLAG_INSANE_CRUCIFIED
    const stand = LookupMonsterinfoStand("insane_stand");
    expect(stand).not.toBeNull();

    stand!(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("insane_move_cross"));
    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n).toBe(true);
  });

  test("spawnflag variant: insane_stand w/ CRAWL|STAND_GROUND (4|16) picks insane_move_down deterministically (m_insane.cpp:557-562)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.spawnflags = SpawnFlags_or(SpawnFlags_from(4), SpawnFlags_from(16)); // CRAWL|STAND_GROUND
    const stand = LookupMonsterinfoStand("insane_stand");
    expect(stand).not.toBeNull();

    stand!(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("insane_move_down"));
  });

  test("distinctive: SP_misc_insane w/ CRUCIFIED runs the real stationarymonster_start (rogue/g_rogue_monster.cpp:88-96), no throw", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.spawnflags = SpawnFlags_from(8); // SPAWNFLAG_INSANE_CRUCIFIED

    expect(() => SP_misc_insane(self)).not.toThrow();

    // rogue/g_rogue_monster.cpp:88-96:
    //   self->flags |= FL_STATIONARY;
    //   self->think = stationarymonster_start_go;
    //   monster_start(self);
    //   self->viewheight = 0;   // "fix viewheight"
    expect(self.flags & EntFlagsT.FL_STATIONARY).not.toBe(0n);
    expect(self.viewheight).toBe(0);
    expect(self.think).toBe(stationarymonster_start_go);
  });
});

// ---------------------------------------------------------------------------
// ACTOR (m_actor.cpp)
// ---------------------------------------------------------------------------

describe("actor", () => {
  test("mmove sanity: actor_move_attack's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("actor_move_attack");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: actor_run w/ AI_STAND_GROUND picks actor_stand's actor_move_stand instead of actor_move_run (m_actor.cpp:114-118)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
    const run = LookupMonsterinfoRun("actor_run");
    expect(run).not.toBeNull();

    run!(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("actor_move_stand"));
  });

  test("attack-fire: actorMachineGun's monster_fire_bullet call, damage=3 kick=4 (m_actor.cpp:233-260)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    // actor_move_attack's very first frame is { ai_charge, -2, actor_fire }
    // (m_actor.cpp:339-340), which calls actorMachineGun unconditionally.
    // FRAME_attak01 is 0, coinciding with defaultEdict's own s.frame=0
    // default, so self.s.frame is forced out of range first -- otherwise
    // M_MoveFrame sees it as already "in range" and increments past index 0
    // without ever running it (see M_MoveFrame's own firstframe-snap branch,
    // g_monster.ts).
    M_SetAnimation(self, requireMmove("actor_move_attack"), true);
    self.s.frame = -1;
    stepFrame(self);

    expect(enemy.health).toBe(97); // 100 - damage(3)
  });
});

// ---------------------------------------------------------------------------
// SHAMBLER (m_shambler.cpp) -- NEW re-release monster
// ---------------------------------------------------------------------------

describe("shambler", () => {
  test("mmove sanity: shambler_attack_magic's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("shambler_attack_magic");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: shambler_run w/ a client enemy sets AI_BRUTAL and picks shambler_move_run (m_shambler.cpp:163-177)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    const enemy = makeMonster(2, vec3(100, 0, 0));
    enemy.client = defaultGClient();
    self.enemy = enemy;

    const run = LookupMonsterinfoRun("shambler_run");
    expect(run).not.toBeNull();

    run!(self);

    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BRUTAL) !== 0n).toBe(true);
    expect(pendingOrActiveMove(self)).toBe(requireMmove("shambler_move_run"));
  });

  test("attack constant: ShamblerCastLightning's fire_bullet call, damage=irandom(8,12) kick=15, MOD_TESLA (m_shambler.cpp:287-315)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    // a uniform "always hit the enemy" trace, matching m_flipper.ts's/
    // m_mutant.ts's own attack-fire test fixtures -- covers
    // M_CheckClearShot's clear-shot check, PredictAim's internal traces, and
    // fire_bullet's own hitscan trace all at once.
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    M_SetAnimation(self, requireMmove("shambler_attack_magic"), true);
    // frame-by-frame lead-in (m_shambler.cpp:317-330): 0=windup, 1-4=
    // lightning_update, 5=ShamblerSaveLoc (sets monsterinfo.nextframe to
    // FRAME_magic09, index 8), 6=ShamblerCastLightning (the first one, at
    // the jumped-to frame). 7 total steps reaches it.
    stepFrame(self, 7);

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(8);
    expect(damageDealt).toBeLessThanOrEqual(11); // irandom(8,12): min-inclusive, max-exclusive
  });
});

// ---------------------------------------------------------------------------
// GUARDIAN (m_guardian.cpp) -- NEW re-release monster
// ---------------------------------------------------------------------------

describe("guardian", () => {
  test("mmove sanity: guardian_move_atk1_spin's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("guardian_move_atk1_spin");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: guardian_attack picks guardian_move_atk2_in when the enemy is farther than RANGE_NEAR=440 (m_guardian.cpp:381-394)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(1000, 0, 0));
    self.enemy = enemy;

    const attack = LookupMonsterinfoAttack("guardian_attack");
    expect(attack).not.toBeNull();

    attack!(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("guardian_move_atk2_in"));
  });

  test("guardian laser: guardian_laser_fire plays sound_laser then calls the now-real monster_fire_dabeam(self, 25, ...) (m_guardian.cpp:323-327), spawning a beam entity and applying MOD_TARGET_LASER damage through guardian_fire_update (m_guardian.cpp:302-320)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(50, 0, 0));
    self.enemy = enemy;

    // monster_fire_dabeam (g_xatrix_monster.cpp:112-142, now a real port --
    // no longer the throwing stub this test used to document) runs
    // guardian_fire_update once (dabeam_update(laser, false), no damage)
    // then its own final dabeam_update(beam_ptr, true) pass. Each
    // dabeam_update call that hits something burns exactly 3 gi.trace
    // calls: a throwaway self-trace seed, the real beam trace, and a
    // post-mark retrace that ends the pierce loop (see this file's own
    // kexgame_xatrix.test.ts "dabeam_update" tests for the identical
    // idiom). So the real hit is call #2 of the false-damage pass and call
    // #5 of the true-damage pass.
    let calls = 0;
    traceImpl = (_start, _mins, _maxs, end) => {
      calls++;
      if (calls === 2 || calls === 5) return hitTrace(end, enemy, 0.5);
      return noHitTrace(end);
    };

    // guardian_move_atk2_fire's every frame calls guardian_laser_fire
    // (m_guardian.cpp:329-334).
    M_SetAnimation(self, requireMmove("guardian_move_atk2_fire"), true);

    stepFrame(self);

    // guardian_laser_fire passes `secondary = self.s.frame & 1`
    // (m_guardian.cpp:327); M_SetAnimation lands s.frame on
    // FRAME_atk2_fire1 = 177 (odd), so this is the SECONDARY beam
    // (self.beam2), not self.beam (g_xatrix_monster.cpp:113,124-125).
    expect(self.s.frame % 2).toBe(1);
    expect(rec.soundCalls.length).toBe(1); // gi.sound(sound_laser) ran
    expect(self.beam).toBeNull(); // primary beam untouched -- this shot used the secondary slot
    expect(self.beam2).not.toBeNull(); // monster_fire_dabeam's G_Spawn
    expect(self.beam2!.dmg).toBe(25);
    expect(self.beam2!.owner).toBe(self);
    // guardian_fire_update's own dabeam_update(laser, false) call does not
    // damage; only monster_fire_dabeam's trailing dabeam_update(beam_ptr,
    // true) call does (g_xatrix_monster.cpp:141).
    expect(enemy.health).toBe(75); // 100 - 25 dmg, MOD_TARGET_LASER
  });
});

// ---------------------------------------------------------------------------
// ARACHNID (m_arachnid.cpp) -- NEW re-release monster
// ---------------------------------------------------------------------------

describe("arachnid", () => {
  test("mmove sanity: arachnid_attack1's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("arachnid_attack1");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: arachnid_attack picks arachnid_melee in melee range with debounce elapsed (m_arachnid.cpp:261-272)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0)); // < MELEE_DISTANCE(50)
    self.enemy = enemy;
    // `melee_debounce_time < level.time` (m_arachnid.cpp:266) is a STRICT
    // inequality -- level.time must be advanced past GTIME_ZERO, or a
    // debounce/clock both left at their GTIME_ZERO defaults never compares
    // less-than.
    level.time = Gtime_from_sec(1);
    self.monsterinfo.melee_debounce_time = GTIME_ZERO;

    const attack = LookupMonsterinfoAttack("arachnid_attack");
    expect(attack).not.toBeNull();

    attack!(self);

    expect(pendingOrActiveMove(self)).toBe(requireMmove("arachnid_melee"));
  });

  test("attack constant: arachnid_rail's monster_fire_railgun call, damage=35 kick=100 (m_arachnid.cpp:163-195)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    // monster_fire_railgun's fire_rail pierces through multiple entities
    // along the beam (g_weapon.ts's pierceTrace/MAX_PIERCE loop): every
    // successful pierce hit sets the pierced entity's solid to SOLID_NOT
    // (markPierce, g_weapon.ts) before re-tracing the SAME segment to look
    // for the next entity along the beam. A traceImpl that always resolves
    // to a hit regardless of solidity would let the mock loop "pierce" the
    // same phantom entity forever, wildly over-counting damage (this is what
    // over-applies -999 health if you try the naive "always hit" mock
    // used for point-blank melee/bullet attacks elsewhere in this suite).
    // Distinguish the long-distance rail trace (matches
    // kexgame_monsters2.test.ts's own `dist > 1000 ? hit : noHit` idiom for
    // supertankMachineGun) from `ai_charge`'s own short line-of-sight
    // `visible()` checks that run every frame regardless of attack type, AND
    // stop resolving to a hit once the enemy has actually been pierced.
    traceImpl = (start, _mins, _maxs, end) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 1000 && enemy.solid !== SolidT.SOLID_NOT) return hitTrace(end, enemy);
      return noHitTrace(end);
    };

    // arachnid_frames_attack1: 0=arachnid_charge_rail (sets self.pos1),
    // 1,2=plain ai_charge, 3=arachnid_rail (the first one, FRAME_rails4,
    // m_arachnid.cpp:197-201). FRAME_rails1 is 0, coinciding with
    // defaultEdict's own s.frame=0 default, so self.s.frame is forced out of
    // range first (see the actor attack-fire test's identical note above).
    // 4 total steps then reaches arachnid_rail.
    M_SetAnimation(self, requireMmove("arachnid_attack1"), true);
    self.s.frame = -1;
    stepFrame(self, 4);

    expect(enemy.health).toBe(65); // 100 - damage(35)
  });
});
