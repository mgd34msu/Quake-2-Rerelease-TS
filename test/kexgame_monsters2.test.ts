/*
Unit tests for the kex m_flipper.cpp/m_supertank.cpp/m_mutant.cpp/
m_chick.cpp/m_parasite.cpp/m_tank.cpp ports (src/kexgame/m_flipper.ts,
m_supertank.ts, m_mutant.ts, m_chick.ts, m_parasite.ts, m_tank.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture,
mutable per-test `traceImpl` hook, `makeMonster`/`setupWorld`/`stepFrame`/
`pendingOrActiveMove` helpers) is copied from test/kexgame_monsters1.test.ts's
own established pattern (itself copied from test/kexgame_g_monster.test.ts),
kept module-private per that same precedent.

Design note on reaching per-file internals without new exports: none of
these six files export their mmove tables, per-frame thinkfuncs (flipper_bite,
mutant_hit_left, ChickSlash, ChickRocket, TankMachineGun, TankBlaster,
TankRocket, supertankMachineGun, parasite_fire_proboscis, proboscis_think,
etc.), or forward-referenced stand/run handlers directly -- every one of
those symbols is either a plain module-private function (frame-function
fields are plain, not save-registry-typed, per g_local_types.ts) or is
save-registered under its exact C++ name via g_save_registry.ts's RegisterX
family. This suite reaches all of it through the SAME registry the real game
uses for save/load: `LookupMmove`/`LookupThink`/`LookupMonsterinfoStand` etc.,
by the literal C++ function name each file registered it under -- no new
exports were added to any of the six files for testability. Attack-fire
constants are exercised by staging the real, registry-fetched mmove table via
M_SetAnimation and stepping M_MoveFrame (forcing next_move_time to GTIME_ZERO
each step, exactly like kexgame_monsters1.test.ts's `stepFrame`), which runs
the real per-frame thinkfunc chain rather than reimplementing any AI.

Scope (24 cases, each citing the exact C++ line(s) it exercises):

  FLIPPER (m_flipper.cpp):
    - mmove sanity: flipper_move_attack's frame array satisfies
      lastframe-firstframe+1 (m_flipper.h's FRAME_flpbit01..20 enum +
      MmoveT's constructor-time validator, g_local_types.ts:509-545).
    - animation transition: flipper_stand -> flipper_start_run changes
      monsterinfo.active_move/next_move (m_flipper.cpp:29-32, 129-132).
    - attack-fire: flipper_bite's fire_hit call, damage=5 kick=0
      (m_flipper.cpp:152-156), reached by driving flipper_move_attack to its
      14th frame (0-indexed 13, FRAME_flpbit14).

  SUPERTANK (m_supertank.cpp):
    - mmove sanity: supertank_move_attack1's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: supertank_stand -> supertank_run (no
      AI_STAND_GROUND) changes active_move to supertank_move_run
      (m_supertank.cpp:114-117, 177-183).
    - attack-fire: supertankMachineGun's monster_fire_bullet call, damage=6
      kick=4 (m_supertank.cpp:489-509), reached by driving
      supertank_move_attack1 (every frame is supertankMachineGun,
      m_supertank.cpp:367-375).
    - distinctive: blocked_checkplat's `if (!self->enemy) return false;`
      early return (rogue/g_rogue_newai.cpp:21-22), ported for real in this
      file and reused by m_tank.ts/m_chick.ts/m_mutant.ts/m_parasite.ts.

  MUTANT (m_mutant.cpp):
    - mmove sanity: mutant_move_attack's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: mutant_stand -> mutant_run changes active_move
      (m_mutant.cpp:124-127, 214-220).
    - attack-fire: mutant_hit_left's fire_hit call, damage=irandom(5,15)
      (5..14 inclusive), kick=100 (m_mutant.cpp:226-236), reached by driving
      mutant_move_attack to its 3rd frame (0-indexed 2, FRAME_attack11).
    - distinctive: mutant_checkattack's jump gate (mutant_check_jump,
      m_mutant.cpp:384-430) -- melee range always wins (AS_MELEE); a target
      365 units away (mutant_check_jump's own `distance > 265` cutoff)
      deterministically refuses to jump regardless of RNG.

  CHICK (m_chick.cpp):
    - mmove sanity: chick_move_slash's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: chick_stand -> chick_run changes active_move to
      chick_move_start_run (m_chick.cpp:123-126, 177-196: active_move is
      neither chick_move_walk nor chick_move_start_run yet, so the first
      run() call takes the `else` branch).
    - attack-fire: ChickSlash's fire_hit call, damage=irandom(10,16)
      (10..15 inclusive), kick=100 (m_chick.cpp:402-407), reached by driving
      chick_move_slash to its 2nd frame (0-indexed 1, FRAME_attak205).
    - distinctive: chick_duck's "if we're shooting don't dodge" branch
      (m_chick.cpp:758-771) -- when active_move is chick_move_start_attack1,
      chick_duck calls monsterinfo.unduck and returns false instead of
      staging chick_move_duck.

  PARASITE (m_parasite.cpp):
    - mmove sanity: parasite_move_fire_proboscis's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: parasite_stand -> parasite_start_run changes
      active_move (m_parasite.cpp:147-150, 181-187).
    - attack constants: parasite_fire_proboscis's fire_proboscis call uses
      g_athena_parasite_proboscis_speed (1250, m_parasite.cpp:15,621-632),
      observed on the real spawned tip entity via self.proboscus.
    - distinctive (REQUIRED): proboscis_think's style===1 "succ & drain"
      branch (m_parasite.cpp:493-536) -- 2 damage to the victim, +2 health to
      the owner parasite (capped at max_health), and the timestamp advanced
      by exactly 10Hz (100ms).

  TANK (m_tank.cpp):
    - mmove sanity: tank_move_attack_chain's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: tank_stand -> tank_run changes active_move to
      tank_move_start_run (m_tank.cpp:98-101, 200-222).
    - attack-fire: TankMachineGun's monster_fire_bullet call, damage=20
      kick=4 (m_tank.cpp:504-542), reached by driving tank_move_attack_chain
      to its 6th frame (0-indexed 5, FRAME_attak406, the first of 19
      consecutive TankMachineGun frames, m_tank.cpp:737).
    - distinctive (REQUIRED): tank_attack's AS_BLIND blindfire branch
      (m_tank.cpp:810-854) -- sets AI_MANUAL_STEERING and stages either
      tank_move_attack_fire_rocket or tank_move_attack_blast when the dice
      (chance=1.0 for a fresh blind_fire_delay) say to shoot.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, MonsterAiFlagsT, MonsterAttackStateT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, GTIME_ZERO } from "../src/kexgame/gtime";
import { M_SetAnimation, M_MoveFrame } from "../src/kexgame/g_monster";
import {
  LookupMmove,
  LookupThink,
  LookupMonsterinfoStand,
  LookupMonsterinfoRun,
  LookupMonsterinfoAttack,
  LookupMonsterinfoCheckattack,
  LookupMonsterinfoDuck,
  LookupMonsterinfoBlocked,
} from "../src/kexgame/g_save_registry";

// importing these six modules runs every MmoveT constructor in them; a
// throw here would fail the whole file before any test runs (the same
// "successful import IS an assertion" idiom kexgame_monsters1.test.ts uses
// for infantry's un-exported tables).
import "../src/kexgame/m_flipper";
import "../src/kexgame/m_supertank";
import "../src/kexgame/m_mutant";
import "../src/kexgame/m_chick";
import "../src/kexgame/m_parasite";
import "../src/kexgame/m_tank";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied from
// test/kexgame_monsters1.test.ts's own module-private fixture)
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
 *  to a specific live entity (bullet/rocket hitscans and fire_hit's short
 *  box-distance traces). */
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

/** Fetches a save-registered handler by its exact C++ name, failing the
 *  test immediately (not silently skipping) if the name isn't registered --
 *  a wrong/renamed literal here would otherwise pass as "undefined equals
 *  undefined". */
function requireMmove(name: string) {
  const m = LookupMmove(name);
  if (m === null) throw new Error(`LookupMmove("${name}") returned null -- not registered`);
  return m;
}

// ---------------------------------------------------------------------------
// FLIPPER (m_flipper.cpp)
// ---------------------------------------------------------------------------

describe("flipper", () => {
  test("mmove sanity: flipper_move_attack's frame count matches lastframe-firstframe+1 (m_flipper.h FRAME_flpbit01..20)", () => {
    const m = requireMmove("flipper_move_attack");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: flipper_stand -> flipper_start_run changes monsterinfo.active_move (m_flipper.cpp:29-32,129-132)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("flipper_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("flipper_start_run")!;
    expect(self.monsterinfo.stand).not.toBeNull();
    expect(self.monsterinfo.run).not.toBeNull();

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: flipper_bite's fire_hit call, damage=5 kick=0 (m_flipper.cpp:152-156)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    M_SetAnimation(self, requireMmove("flipper_move_attack"), true);
    stepFrame(self, 14); // reaches FRAME_flpbit14 (0-indexed 13): { ai_charge, 0, flipper_bite }

    expect(enemy.health).toBe(95); // 100 - damage(5)
  });
});

// ---------------------------------------------------------------------------
// SUPERTANK (m_supertank.cpp)
// ---------------------------------------------------------------------------

describe("supertank", () => {
  test("mmove sanity: supertank_move_attack1's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("supertank_move_attack1");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: supertank_stand -> supertank_run (no AI_STAND_GROUND) changes active_move to supertank_move_run (m_supertank.cpp:114-117,177-183)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("supertank_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("supertank_run")!;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).toBe(requireMmove("supertank_move_run"));
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: supertankMachineGun's monster_fire_bullet call, damage=6 kick=4 (m_supertank.cpp:489-509)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    traceImpl = (start, _mins, _maxs, end) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return dist > 1000 ? hitTrace(end, enemy) : noHitTrace(end);
    };

    // every frame of supertank_move_attack1 is supertankMachineGun
    // (m_supertank.cpp:367-375)
    M_SetAnimation(self, requireMmove("supertank_move_attack1"), true);
    stepFrame(self);

    expect(enemy.health).toBe(94); // 100 - damage(6)
  });

  test("distinctive: blocked_checkplat's `!self.enemy` early return (rogue/g_rogue_newai.cpp:21-22), reused by m_tank.ts/m_chick.ts/m_mutant.ts/m_parasite.ts", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.enemy = null;
    const blocked = LookupMonsterinfoBlocked("supertank_blocked");
    expect(blocked).not.toBeNull();
    self.monsterinfo.blocked = blocked;

    expect(self.monsterinfo.blocked!(self, 10)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MUTANT (m_mutant.cpp)
// ---------------------------------------------------------------------------

describe("mutant", () => {
  test("mmove sanity: mutant_move_attack's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("mutant_move_attack");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: mutant_stand -> mutant_run changes active_move (m_mutant.cpp:124-127,214-220)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("mutant_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("mutant_run")!;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).toBe(requireMmove("mutant_move_run"));
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: mutant_hit_left's fire_hit call, damage=irandom(5,15) kick=100 (m_mutant.cpp:226-236)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    M_SetAnimation(self, requireMmove("mutant_move_attack"), true);
    stepFrame(self, 3); // reaches FRAME_attack11 (0-indexed 2): { ai_charge, 0, mutant_hit_left }

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(5);
    expect(damageDealt).toBeLessThanOrEqual(14); // irandom(5,15): min-inclusive, max-exclusive
  });

  test("distinctive: mutant_checkattack's jump gate (m_mutant.cpp:384-430) -- melee always wins; distance>265 always refuses to jump", () => {
    setupWorld(4);
    const checkattack = LookupMonsterinfoCheckattack("mutant_checkattack")!;
    expect(checkattack).not.toBeNull();

    // melee range: mutant_check_melee wins unconditionally (no RNG)
    const meleeSelf = makeMonster(1, vec3(0, 0, 0));
    const meleeEnemy = makeMonster(2, vec3(20, 0, 0));
    meleeEnemy.health = 100;
    meleeSelf.enemy = meleeEnemy;
    meleeSelf.monsterinfo.melee_debounce_time = GTIME_ZERO;

    expect(checkattack(meleeSelf)).toBe(true);
    expect(meleeSelf.monsterinfo.attack_state).toBe(MonsterAttackStateT.AS_MELEE);

    // too far to jump (m_mutant.cpp:406-407: `if (distance > 265) return false;`),
    // and far outside melee range too -- deterministically false regardless
    // of brandom().
    const farSelf = makeMonster(3, vec3(0, 0, 0));
    const farEnemy = makeMonster(4, vec3(400, 0, 0));
    farEnemy.health = 100;
    farSelf.enemy = farEnemy;
    farSelf.monsterinfo.melee_debounce_time = GTIME_ZERO;
    farSelf.monsterinfo.attack_finished = GTIME_ZERO;

    expect(checkattack(farSelf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CHICK (m_chick.cpp)
// ---------------------------------------------------------------------------

describe("chick", () => {
  test("mmove sanity: chick_move_slash's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("chick_move_slash");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: chick_stand -> chick_run changes active_move to chick_move_start_run (m_chick.cpp:123-126,177-196)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("chick_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("chick_run")!;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    // active_move was chick_move_stand (neither chick_move_walk nor
    // chick_move_start_run), so chick_run's `else` branch stages
    // chick_move_start_run.
    expect(afterRun).toBe(requireMmove("chick_move_start_run"));
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: ChickSlash's fire_hit call, damage=irandom(10,16) kick=100 (m_chick.cpp:402-407)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    M_SetAnimation(self, requireMmove("chick_move_slash"), true);
    stepFrame(self, 2); // reaches FRAME_attak205 (0-indexed 1): { ai_charge, 7, ChickSlash }

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(10);
    expect(damageDealt).toBeLessThanOrEqual(15); // irandom(10,16): min-inclusive, max-exclusive
  });

  test("distinctive: chick_duck's \"if we're shooting don't dodge\" branch (m_chick.cpp:758-771)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.active_move = requireMmove("chick_move_start_attack1");
    let unducked = false;
    self.monsterinfo.unduck = () => {
      unducked = true;
    };

    const duck = LookupMonsterinfoDuck("chick_duck")!;
    expect(duck).not.toBeNull();

    const result = duck(self, Gtime_from_ms(100));

    expect(result).toBe(false);
    expect(unducked).toBe(true);
    // chick_move_duck was NOT staged
    expect(pendingOrActiveMove(self)).toBe(requireMmove("chick_move_start_attack1"));
  });
});

// ---------------------------------------------------------------------------
// PARASITE (m_parasite.cpp)
// ---------------------------------------------------------------------------

describe("parasite", () => {
  test("mmove sanity: parasite_move_fire_proboscis's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("parasite_move_fire_proboscis");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: parasite_stand -> parasite_start_run changes active_move (m_parasite.cpp:147-150,181-187)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("parasite_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("parasite_start_run")!;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).toBe(requireMmove("parasite_move_start_run"));
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack constants: parasite_fire_proboscis spawns a tip at g_athena_parasite_proboscis_speed=1250 (m_parasite.cpp:15,621-632)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(300, 0, 0));
    self.enemy = enemy;

    M_SetAnimation(self, requireMmove("parasite_move_fire_proboscis"), true);
    stepFrame(self, 3); // index0=parasite_launch, index1=plain, index2=parasite_fire_proboscis

    expect(self.proboscus).not.toBeNull();
    expect(self.proboscus!.speed).toBe(1250);
    expect(self.proboscus!.inuse).toBe(true);
  });

  test("distinctive (REQUIRED): proboscis_think's drain tick -- 2 damage to victim, +2 health to owner, timestamp += 10Hz (m_parasite.cpp:493-536)", () => {
    setupWorld(4);
    const owner = makeMonster(1, vec3(0, 0, 0));
    owner.health = 50;
    owner.max_health = 100;
    const victim = makeMonster(2, vec3(0, 0, 0));
    victim.health = 100;
    owner.monsterinfo.setskin = () => {};

    const tip = g_edicts[3]!;
    tip.inuse = true;
    tip.classname = "parasite_tip";
    tip.style = 1; // stuck on target; do damage, suck health
    tip.owner = owner;
    tip.enemy = victim;
    tip.takedamage = false;
    tip.move_origin = vec3(0, 0, 0);
    tip.s.origin = vec3(victim.s.origin[0], victim.s.origin[1], victim.s.origin[2]);
    tip.s.old_origin = vec3(tip.s.origin[0], tip.s.origin[1], tip.s.origin[2]);
    tip.timestamp = GTIME_ZERO; // <= level.time -> tick fires immediately
    gi.linkentity(tip);

    const proboscisThink = LookupThink("proboscis_think")!;
    expect(proboscisThink).not.toBeNull();

    proboscisThink(tip);

    expect(victim.health).toBe(98); // 100 - 2
    expect(owner.health).toBe(52); // 50 + 2, well under max_health(100)
    expect(tip.timestamp).toBe(Gtime_add(level.time, Gtime_from_ms(100))); // 10hz
  });
});

// ---------------------------------------------------------------------------
// TANK (m_tank.cpp)
// ---------------------------------------------------------------------------

describe("tank", () => {
  test("mmove sanity: tank_move_attack_chain's frame count matches lastframe-firstframe+1", () => {
    const m = requireMmove("tank_move_attack_chain");
    expect(m.frame.length).toBe(m.lastframe - m.firstframe + 1);
    expect(m.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: tank_stand -> tank_run changes active_move to tank_move_start_run (m_tank.cpp:98-101,200-222)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = LookupMonsterinfoStand("tank_stand")!;
    self.monsterinfo.run = LookupMonsterinfoRun("tank_run")!;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).toBe(requireMmove("tank_move_start_run"));
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: TankMachineGun's monster_fire_bullet call, damage=20 kick=4 (m_tank.cpp:504-542)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    traceImpl = (start, _mins, _maxs, end) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return dist > 1000 ? hitTrace(end, enemy) : noHitTrace(end);
    };

    // tank_frames_attack_chain: 5 plain ai_charge frames, then 19
    // consecutive TankMachineGun frames starting at FRAME_attak406
    // (m_tank.cpp:731-762).
    M_SetAnimation(self, requireMmove("tank_move_attack_chain"), true);
    stepFrame(self, 6);

    expect(enemy.health).toBe(80); // 100 - damage(20)
  });

  test("distinctive (REQUIRED): tank_attack's AS_BLIND blindfire branch sets AI_MANUAL_STEERING and stages an attack move (m_tank.cpp:810-854)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    enemy.health = 100;
    self.enemy = enemy;
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_BLIND;
    self.monsterinfo.blind_fire_delay = GTIME_ZERO; // < 1_sec -> chance = 1.0
    self.monsterinfo.blind_fire_target = vec3(0, 500, 0); // non-origin
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

    const attack = LookupMonsterinfoAttack("tank_attack")!;
    expect(attack).not.toBeNull();

    attack(self);

    expect((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n).toBe(true);
    const staged = pendingOrActiveMove(self);
    expect(staged).not.toBeNull();
    expect(staged === requireMmove("tank_move_attack_fire_rocket") || staged === requireMmove("tank_move_attack_blast")).toBe(true);
    expect(self.monsterinfo.attack_finished > GTIME_ZERO).toBe(true);
  });
});
