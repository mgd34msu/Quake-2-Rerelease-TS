/*
Unit tests for the kex m_medic.cpp/m_brain.cpp/m_flyer.cpp/m_hover.cpp/
m_float.cpp ports (src/kexgame/m_medic.ts, m_brain.ts, m_flyer.ts,
m_hover.ts, m_float.ts) plus the real `cleanupHealTarget` now exported from
m_medic.ts (formerly throwing stubs in g_combat.ts/g_monster.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture,
mutable per-test `traceImpl` hook, `makeMonster`/`setupWorld`/`stepFrame`/
`pendingOrActiveMove` helpers) is copied verbatim from
test/kexgame_monsters1.test.ts's own established pattern (itself copied from
test/kexgame_g_monster.test.ts), kept module-private per that same
precedent.

IMPORT-ORDER GOTCHA: importing any of this batch's five files as the very
first static import in a module triggers a real, pre-existing TDZ crash
(`ReferenceError: Cannot access 'ai_stand' before initialization` at
m_soldier.ts's own top-level frame-table construction, or the parallel one
reachable via m_infantry.ts) -- a latent circular-import ordering fragility
between g_ai.ts/m_soldier.ts/g_monster.ts that predates this batch but is
newly *reachable* now that g_monster.ts/g_combat.ts import m_medic.ts (for
the real `cleanupHealTarget`), which itself imports m_soldier.ts's
duck/dodge family. Verified fix, matching test/kexgame_monsters1.test.ts's
own import order exactly: importing `{ M_SetAnimation, M_MoveFrame }` from
g_monster.ts BEFORE any of this batch's five files resolves it (confirmed by
running this file standalone, not just as part of the full suite). Import
order below preserves that.

Design note on how attack-fire functions are reached: m_medic.ts/m_brain.ts
export their real mmove tables and monsterinfo handlers directly (matching
m_soldier.ts's precedent); m_flyer.ts/m_hover.ts/m_float.ts export far
fewer symbols (mostly FRAME_* constants and SP_monster_*), so their
private stand/run/attack-table symbols are fetched the same way
test/kexgame_monsters2.test.ts's own design note describes: through the
SAME save-data registry the real game uses for save/load
(`LookupMmove`/`LookupMonsterinfoStand`/`LookupMonsterinfoRun`), by the
literal C++-derived name each file registered it under -- no new exports
were added to any of the three files for testability. Every case drives the
real, exported (or registry-fetched) `M_SetAnimation`/`M_MoveFrame` from
g_monster.ts, forcing `monsterinfo.next_move_time` to GTIME_ZERO each step
exactly like kexgame_monsters1.test.ts's `stepFrame`.

Scope (17 cases, each citing the exact C++ line(s) it exercises):

  MEDIC (m_medic.cpp):
    - mmove sanity: medic_move_attackBlaster's frame array satisfies
      lastframe-firstframe+1 (m_medic.h's FRAME_attack3..FRAME_attack14
      enum + MmoveT's constructor-time validator, g_local_types.ts:509-545).
    - animation transition: medic_stand -> medic_run changes
      monsterinfo.active_move (m_medic.cpp's medic_stand/medic_run,
      ~m_medic.cpp:434-525).
    - attack-fire: medic_fire_blaster's FRAME_attack9 branch calls
      monster_fire_blaster with damage=6, speed=1000 (m_medic.cpp:631-634),
      reached by driving medic_move_attackBlaster directly via
      M_SetAnimation/M_MoveFrame to its 7th frame (0-indexed 6, absolute
      frame FRAME_attack3+6 === FRAME_attack9), observed via the real
      spawned "bolt" projectile's `.dmg`/`.velocity` fields.
    - heal-target acquisition: medic_FindDeadMonster finds a nearby, dead,
      non-claimed, visible SVF_MONSTER within its search radius
      (m_medic.cpp's FindDeadMonster body, ported at m_medic.ts:959-992).
    - heal-target abort: abortHeal's real, now-non-throwing
      cleanupHealTarget(self.enemy) clears the target's
      monsterinfo.healer/AI_RESURRECTING/takedamage state, cleanupHeal
      reassigns self.enemy/goalentity to a live oldenemy via HuntTarget, and
      abortHeal itself clears the medic's own AI_MEDIC flag and
      medicTries (rogue/g_rogue_combat.cpp:13-18's cleanupHealTarget body,
      m_medic.ts:889-946's abortHeal/cleanupHeal).

  BRAIN (m_brain.cpp):
    - mmove sanity: brain_move_attack1's frame array satisfies
      lastframe-firstframe+1 (m_brain.h's FRAME_attak101..FRAME_attak118
      enum + MmoveT's constructor-time validator).
    - animation transition: brain_stand -> brain_run changes
      monsterinfo.active_move (m_brain.cpp's brain_stand/brain_run).
    - tentacle/melee damage: brain_hit_right's fire_hit call,
      damage=irandom(15,20) (15..19 inclusive, q_std.ts's
      min-inclusive/max-exclusive semantics), kick=40 (m_brain.cpp:279-286,
      confirmed against the real C++ source at m_brain.cpp:282), reached by
      driving brain_move_attack1 directly via M_SetAnimation/M_MoveFrame to
      its 8th frame (0-indexed 7), the one whose thinkfunc is
      brain_hit_right.

  FLYER (m_flyer.cpp):
    - mmove sanity: flyer_move_attack2's frame array satisfies
      lastframe-firstframe+1 (fetched via LookupMmove since it's not
      directly exported -- only the genuinely-dead-code flyer_move_attack3
      is, per this batch's own header note in m_flyer.ts).
    - animation transition: flyer_stand -> flyer_run changes
      monsterinfo.active_move (both fetched via LookupMonsterinfoStand/Run
      by their registered C++ names, m_flyer.cpp's flyer_stand/flyer_run).
    - attack-fire: flyer_fireleft's monster_fire_blaster call, damage=1,
      speed=1000 (m_flyer.cpp:386), reached by driving flyer_move_attack2
      directly to its 4th frame (0-indexed 3), the first
      ai_charge/flyer_fireleft frame.

  HOVER (m_hover.cpp):
    - mmove sanity: hover_move_attack1's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: hover_stand -> hover_run changes
      monsterinfo.active_move (fetched via LookupMonsterinfoStand/Run,
      m_hover.cpp's hover_stand/hover_run).
    - attack-fire: hover_fire_blaster's mass<200 (non-daedalus) branch calls
      monster_fire_blaster, damage=1, speed=1000 (m_hover.cpp:402), reached
      by driving hover_move_attack1 directly to its very first frame (index
      0 is already an ai_charge/hover_fire_blaster frame).

  FLOATER (m_float.cpp):
    - mmove sanity: floater_move_attack1's frame array satisfies
      lastframe-firstframe+1 (fetched via LookupMmove, module-private in
      m_float.ts).
    - animation transition: floater_stand -> floater_run changes
      monsterinfo.active_move (fetched via LookupMonsterinfoStand/Run,
      m_float.cpp's floater_stand/floater_run).
    - attack-fire: floater_fire_blaster's monster_fire_blaster call,
      damage=1, speed=1000 (m_float.cpp:56), reached by driving
      floater_move_attack1 directly to its 4th frame (0-indexed 3), the
      first ai_charge/floater_fire_blaster frame.

Manual wiring, not SP_monster_X: none of these tests call SP_monster_medic/
SP_monster_brain/SP_monster_flyer/SP_monster_hover/SP_monster_floater
directly, for the same reason test/kexgame_monsters1.test.ts's own header
gives -- those pull in walkmonster_start/flymonster_start's full
ground-check/link/coop-health-scaling pipeline, already covered elsewhere
(kexgame_g_monster.test.ts). Each test hand-wires only the monsterinfo
fields/handlers and entity bbox/origin state a given assertion needs.
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { vec3_length } from "../src/kexgame/q_vec3";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, MonsterAiFlagsT, MovetypeT } from "../src/kexgame/g_local";
import { defaultEdict, gi, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "../src/kexgame/gtime";
import { M_SetAnimation, M_MoveFrame } from "../src/kexgame/g_monster";
import { LookupMmove, LookupMonsterinfoStand, LookupMonsterinfoRun } from "../src/kexgame/g_save_registry";

import { medic_move_attackBlaster, medic_stand, medic_run, medic_FindDeadMonster, abortHeal, FRAME_attack9 } from "../src/kexgame/m_medic";
import { brain_move_attack1, brain_stand, brain_run } from "../src/kexgame/m_brain";
import "../src/kexgame/m_flyer";
import "../src/kexgame/m_hover";
import "../src/kexgame/m_float";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied verbatim from
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

/** The move a monsterinfo.stand/run/etc. handler just selected. */
function pendingOrActiveMove(self: EdictT) {
  return self.monsterinfo.next_move ?? self.monsterinfo.active_move;
}

function mustLookupMmove(name: string) {
  const m = LookupMmove(name);
  if (m === null) throw new Error(`test setup: LookupMmove(${JSON.stringify(name)}) returned null -- was it registered under a different name?`);
  return m;
}

function mustLookupStand(name: string) {
  const f = LookupMonsterinfoStand(name);
  if (f === null) throw new Error(`test setup: LookupMonsterinfoStand(${JSON.stringify(name)}) returned null`);
  return f;
}

function mustLookupRun(name: string) {
  const f = LookupMonsterinfoRun(name);
  if (f === null) throw new Error(`test setup: LookupMonsterinfoRun(${JSON.stringify(name)}) returned null`);
  return f;
}

// ---------------------------------------------------------------------------
// MEDIC (m_medic.cpp)
// ---------------------------------------------------------------------------

describe("medic", () => {
  test("mmove sanity: medic_move_attackBlaster's frame count matches lastframe-firstframe+1 (m_medic.h FRAME_attack3..FRAME_attack14, MmoveT ctor validation)", () => {
    expect(medic_move_attackBlaster.frame.length).toBe(medic_move_attackBlaster.lastframe - medic_move_attackBlaster.firstframe + 1);
    expect(medic_move_attackBlaster.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: medic_stand -> medic_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = medic_stand;
    self.monsterinfo.run = medic_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: medic_fire_blaster's FRAME_attack9 branch calls monster_fire_blaster(damage=6, speed=1000) (m_medic.cpp:631-634)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(200, 0, 0));
    self.enemy = enemy;

    // medic_move_attackBlaster's 4th frame (0-indexed 3, FRAME_attack6) is
    // medic_quick_attack, a frandom()-gated redirect to a different move
    // entirely -- non-deterministic, so this test seeds active_move/s.frame
    // directly one frame before the target instead of stepping through it
    // from firstframe (M_MoveFrame's real behavior for an in-range frame is
    // a plain s.frame++ + that frame's thinkfunc, g_monster.ts:1033-1041,
    // so this is equivalent to having walked there without the randomness).
    // The following frame is FRAME_attack9, medic_fire_blaster's damage=6
    // branch.
    self.monsterinfo.active_move = medic_move_attackBlaster;
    self.s.frame = FRAME_attack9 - 1;
    stepFrame(self, 1);

    expect(self.s.frame).toBe(FRAME_attack9);
    const bolt = g_edicts.find((e) => e.inuse && e.classname === "bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.dmg).toBe(6);
    expect(vec3_length(bolt!.velocity)).toBeGreaterThan(999);
    expect(vec3_length(bolt!.velocity)).toBeLessThan(1001);
  });

  test("heal-target acquisition: medic_FindDeadMonster finds a nearby dead, unclaimed, visible SVF_MONSTER (m_medic.cpp's FindDeadMonster, m_medic.ts:959-992)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const corpse = makeMonster(2, vec3(200, 0, 0));
    corpse.health = -10; // dead
    corpse.monsterinfo.healer = null;
    corpse.monsterinfo.badMedic1 = null;
    corpse.monsterinfo.badMedic2 = null;

    const found = medic_FindDeadMonster(self);

    expect(found).toBe(corpse);
  });

  test("heal-target abort: abortHeal's real cleanupHealTarget clears the target's healer/AI_RESURRECTING/takedamage, and abortHeal itself clears the medic's own AI_MEDIC/medicTries (rogue/g_rogue_combat.cpp:13-18, m_medic.ts:889-946)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const patient = makeMonster(2, vec3(50, 0, 0));
    const oldenemy = makeMonster(3, vec3(100, 100, 0));

    patient.monsterinfo.healer = self;
    patient.takedamage = false;
    patient.monsterinfo.aiflags |= MonsterAiFlagsT.AI_RESURRECTING;

    self.enemy = patient;
    self.oldenemy = oldenemy; // live -> cleanupHeal's HuntTarget branch, no FindTarget needed
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MEDIC;
    self.monsterinfo.medicTries = 3;

    abortHeal(self, false, false, false);

    expect(patient.monsterinfo.healer).toBeNull();
    expect(patient.takedamage).toBe(true);
    expect(patient.monsterinfo.aiflags & MonsterAiFlagsT.AI_RESURRECTING).toBe(0n);
    expect(self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC).toBe(0n);
    expect(self.monsterinfo.medicTries).toBe(0);
    expect(self.enemy).toBe(oldenemy);
    expect(self.goalentity).toBe(oldenemy);
  });
});

// ---------------------------------------------------------------------------
// BRAIN (m_brain.cpp)
// ---------------------------------------------------------------------------

describe("brain", () => {
  test("mmove sanity: brain_move_attack1's frame count matches lastframe-firstframe+1 (m_brain.h FRAME_attak101..FRAME_attak118, MmoveT ctor validation)", () => {
    expect(brain_move_attack1.frame.length).toBe(brain_move_attack1.lastframe - brain_move_attack1.firstframe + 1);
    expect(brain_move_attack1.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: brain_stand -> brain_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = brain_stand;
    self.monsterinfo.run = brain_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("tentacle/melee damage: brain_hit_right's fire_hit call, damage=irandom(15,20) kick=40 (m_brain.cpp:279-286, confirmed at m_brain.cpp:282)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0)); // overlapping bboxes -- well within melee range
    self.enemy = enemy;

    // fire_hit only performs two short box-distance traces; resolving every
    // trace to a hit against `enemy` is safe here, matching
    // kexgame_monsters1.test.ts's berserk/gladiator melee precedent.
    traceImpl = (_start, _mins, _maxs, end) => ({
      allsolid: false,
      startsolid: false,
      fraction: 0.5,
      endpos: vec3(end[0], end[1], end[2]),
      plane: new CplaneT(),
      surface: null,
      contents: 0,
      ent: enemy,
      plane2: new CplaneT(),
      surface2: null,
    });

    // brain_frames_attack1's 8th frame (0-indexed 7) is brain_hit_right.
    M_SetAnimation(self, brain_move_attack1, true);
    stepFrame(self, 8);

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(15);
    expect(damageDealt).toBeLessThanOrEqual(19); // irandom(15,20): min-inclusive, max-exclusive
  });
});

// ---------------------------------------------------------------------------
// FLYER (m_flyer.cpp)
// ---------------------------------------------------------------------------

describe("flyer", () => {
  const flyer_move_attack2 = mustLookupMmove("flyer_move_attack2");
  const flyer_stand = mustLookupStand("flyer_stand");
  const flyer_run = mustLookupRun("flyer_run");

  test("mmove sanity: flyer_move_attack2's frame count matches lastframe-firstframe+1 (LookupMmove-fetched, module-private in m_flyer.ts)", () => {
    expect(flyer_move_attack2.frame.length).toBe(flyer_move_attack2.lastframe - flyer_move_attack2.firstframe + 1);
    expect(flyer_move_attack2.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: flyer_stand -> flyer_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = flyer_stand;
    self.monsterinfo.run = flyer_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: flyer_fireleft's monster_fire_blaster call, damage=1 speed=1000 (m_flyer.cpp:386)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(200, 0, 0));
    self.enemy = enemy;

    // flyer_frames_attack2's 4th frame (0-indexed 3) is the first
    // ai_charge/flyer_fireleft frame.
    M_SetAnimation(self, flyer_move_attack2, true);
    stepFrame(self, 4);

    const bolt = g_edicts.find((e) => e.inuse && e.classname === "bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.dmg).toBe(1);
    expect(vec3_length(bolt!.velocity)).toBeGreaterThan(999);
    expect(vec3_length(bolt!.velocity)).toBeLessThan(1001);
  });
});

// ---------------------------------------------------------------------------
// HOVER (m_hover.cpp)
// ---------------------------------------------------------------------------

describe("hover", () => {
  const hover_move_attack1 = mustLookupMmove("hover_move_attack1");
  const hover_stand = mustLookupStand("hover_stand");
  const hover_run = mustLookupRun("hover_run");

  test("mmove sanity: hover_move_attack1's frame count matches lastframe-firstframe+1", () => {
    expect(hover_move_attack1.frame.length).toBe(hover_move_attack1.lastframe - hover_move_attack1.firstframe + 1);
    expect(hover_move_attack1.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: hover_stand -> hover_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = hover_stand;
    self.monsterinfo.run = hover_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: hover_fire_blaster's mass<200 branch calls monster_fire_blaster(damage=1, speed=1000) (m_hover.cpp:402)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(200, 0, 0));
    self.enemy = enemy;
    self.mass = 150; // base hover, not the mass>=200 daedalus/monster_fire_blaster2 branch

    // hover_frames_attack1's very first frame is already an
    // ai_charge/hover_fire_blaster frame.
    M_SetAnimation(self, hover_move_attack1, true);
    stepFrame(self, 1);

    const bolt = g_edicts.find((e) => e.inuse && e.classname === "bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.dmg).toBe(1);
    expect(vec3_length(bolt!.velocity)).toBeGreaterThan(999);
    expect(vec3_length(bolt!.velocity)).toBeLessThan(1001);
  });
});

// ---------------------------------------------------------------------------
// FLOATER (m_float.cpp)
// ---------------------------------------------------------------------------

describe("floater", () => {
  const floater_move_attack1 = mustLookupMmove("floater_move_attack1");
  const floater_stand = mustLookupStand("floater_stand");
  const floater_run = mustLookupRun("floater_run");

  test("mmove sanity: floater_move_attack1's frame count matches lastframe-firstframe+1 (LookupMmove-fetched, module-private in m_float.ts)", () => {
    expect(floater_move_attack1.frame.length).toBe(floater_move_attack1.lastframe - floater_move_attack1.firstframe + 1);
    expect(floater_move_attack1.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: floater_stand -> floater_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = floater_stand;
    self.monsterinfo.run = floater_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: floater_fire_blaster's monster_fire_blaster call, damage=1 speed=1000 (m_float.cpp:56)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(200, 0, 0));
    self.enemy = enemy;

    // floater_frames_attack1's 4th frame (0-indexed 3) is the first
    // ai_charge/floater_fire_blaster frame.
    M_SetAnimation(self, floater_move_attack1, true);
    stepFrame(self, 4);

    const bolt = g_edicts.find((e) => e.inuse && e.classname === "bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.dmg).toBe(1);
    expect(vec3_length(bolt!.velocity)).toBeGreaterThan(999);
    expect(vec3_length(bolt!.velocity)).toBeLessThan(1001);
  });
});
