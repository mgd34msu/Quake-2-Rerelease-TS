/*
Unit tests for the kex m_soldier.cpp/m_infantry.cpp/m_gunner.cpp/m_berserk.cpp/
m_gladiator.cpp ports (src/kexgame/m_soldier.ts, m_infantry.ts, m_gunner.ts,
m_berserk.ts, m_gladiator.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. The fixture (fake gi/game/level fixture,
mutable per-test `traceImpl` hook, `makeMonster`/`setupWorld` helpers) is
copied from test/kexgame_g_monster.test.ts's own established pattern rather
than importing it (that file keeps its fixture module-private).

Design note on how attack-fire functions are reached: none of the five
monster files export their per-frame thinkfuncs directly (except where a
function is genuinely shared across two mmove tables, e.g. gladiator's
`GladiatorMelee`/`GladiatorGun`, which the m_gladiator.ts/gladb variant both
reference). Rather than reimplement each monster's full AI decision tree,
these tests drive the REAL, exported `M_SetAnimation`/`M_MoveFrame` from
g_monster.ts directly against each monster's own exported mmove table (or,
for soldier/infantry where the fire path is reached through the exported
monsterinfo handler instead), forcing `monsterinfo.next_move_time` to
GTIME_ZERO before each step so `run_frame` is always true regardless of
`level.time` -- this tests pacing-independent behavior (the frame's
thinkfunc firing with the right constants), not frame-pacing itself, which
is already covered by kexgame_g_monster.test.ts's own M_MoveFrame suite.

Scope (21 cases, each citing the exact C++ line(s) it exercises):

  SOLDIER (m_soldier.cpp):
    - mmove sanity: soldier_move_run's frame array satisfies
      lastframe-firstframe+1 (m_soldier.h's FRAME_run03..FRAME_run08 enum +
      MmoveT's constructor-time validator, g_local_types.ts:509-545).
    - animation transition: soldier_stand -> soldier_run changes
      monsterinfo.active_move (m_soldier.cpp's soldier_stand/soldier_run).
    - attack-fire: soldier_fire1's blaster branch calls monster_fire_blaster
      with damage=5, speed=600 (m_soldier.cpp:562), observed via the real
      spawned "bolt" projectile's `.dmg`/`.velocity` fields (g_weapon.ts's
      real `fire_blaster`).
    - pain skip: soldier_pain's `level.time < pain_debounce_time` early
      return leaves active_move untouched and plays no sound
      (m_soldier.cpp:415-428).

  INFANTRY (m_infantry.cpp):
    - mmove sanity: importing m_infantry.ts (done at this file's top)
      already ran all 17 MmoveT constructors; none of infantry's tables are
      exported (by design -- see g_turret.ts's cross-file contract, which
      only needs the five monsterinfo-level handlers), so the successful
      import IS the assertion (per this task's brief: "already enforced at
      load -- assert import succeeds").
    - animation transition: infantry_stand -> (self.monsterinfo.run, i.e.
      infantry_run) changes active_move (m_infantry.cpp's infantry_stand/
      infantry_run).
    - attack-fire: InfantryMachineGun's monster_fire_bullet call, damage=3,
      kick=4, hspread=DEFAULT_BULLET_HSPREAD(300), vspread=
      DEFAULT_BULLET_VSPREAD(500) (m_infantry.cpp:313), reached by routing
      through the real, exported `infantry_stand`, and the real
      `self.monsterinfo.attack` (`infantry_attack`, wired by
      `SP_monster_infantry`... not called here, wired by hand instead --
      see "manual wiring, not SP_monster_X" note below) into
      infantry_move_attack1, whose every frame's thinkfunc is
      InfantryMachineGun.
    - pain skip: infantry_pain's `level.time < pain_debounce_time` early
      return leaves active_move untouched and plays no sound
      (m_infantry.cpp:211-219). `self.think` is left as the harness default
      (not `monster_think`), which deterministically skips the
      frandom()<0.33 dodge branch inside the skip path -- avoiding the
      cited `M_MonsterDodge`/rogue-nav-AI throwing stub entirely, per the
      infantry fork's own flagged risk.

  GUNNER (m_gunner.cpp):
    - mmove sanity: gunner_move_fire_chain's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: gunner_stand -> gunner_run changes active_move.
    - attack-fire: GunnerFire's monster_fire_bullet call, damage=3, kick=4,
      hspread=300, vspread=500 (m_gunner.cpp:391), reached by driving
      gunner_move_fire_chain directly via M_SetAnimation/M_MoveFrame (every
      frame in that table is GunnerFire).
    - pain skip: gunner_pain's `level.time < pain_debounce_time` early
      return leaves active_move untouched and plays no sound
      (m_gunner.cpp:258-261).

  BERSERK (m_berserk.cpp):
    - mmove sanity: berserk_move_attack_spike's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: berserk_stand -> berserk_run changes
      active_move.
    - attack-fire: berserk_attack_spike's fire_hit call, damage=irandom(5,11)
      (5..10 inclusive, q_std.ts's min-inclusive/max-exclusive semantics),
      kick=80 (m_berserk.cpp:161), reached by driving
      berserk_move_attack_spike directly via M_SetAnimation/M_MoveFrame to
      its 4th frame (0-indexed 3), the one whose thinkfunc is
      berserk_attack_spike.
    - pain skip: berserk_pain's `level.time < pain_debounce_time` early
      return leaves active_move untouched and plays no sound
      (m_berserk.cpp:509-512).

  GLADIATOR (m_gladiator.cpp):
    - mmove sanity: gladiator_move_attack_melee's frame array satisfies
      lastframe-firstframe+1.
    - animation transition: gladiator_stand -> gladiator_run changes
      active_move.
    - attack-fire (melee): GladiatorMelee's fire_hit call, damage=
      irandom(20,25) (20..24 inclusive), kick=300 (m_gladiator.cpp:110).
    - attack-fire (railgun): GladiatorGun's monster_fire_railgun call,
      damage=50, kick=100 (m_gladiator.cpp:155).
    - pain skip: gladiator_pain's `level.time < pain_debounce_time` early
      return (with velocity[2] <= 100, so it doesn't switch to the air-pain
      move either) leaves active_move untouched and plays no sound
      (m_gladiator.cpp:272-279).

Manual wiring, not SP_monster_X: none of these tests call SP_monster_soldier/
SP_monster_infantry/SP_monster_gunner/SP_monster_berserk/SP_monster_gladiator
directly -- those pull in walkmonster_start/monster_start/monster_start_go's
full ground-check/link/coop-health-scaling pipeline, which is already the
real, landed g_monster.ts behavior under test elsewhere
(kexgame_g_monster.test.ts). Instead, each test hand-wires only the
monsterinfo fields/handlers and entity bbox/origin state a given assertion
needs, directly against the real exported handler functions -- matching
this suite's `makeMonster` precedent of a minimally-live entity rather than
a fully spawned one.
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

import { soldier_move_run, soldier_move_start_run, soldier_stand, soldier_run, soldier_fire1, soldier_pain } from "../src/kexgame/m_soldier";
import { SP_monster_infantry, infantry_stand, infantry_pain } from "../src/kexgame/m_infantry";
import { gunner_stand, gunner_run, gunner_move_fire_chain, gunner_pain } from "../src/kexgame/m_gunner";
import { berserk_stand, berserk_run, berserk_move_attack_spike, berserk_pain } from "../src/kexgame/m_berserk";
import { gladiator_stand, gladiator_run, gladiator_move_attack_melee, GladiatorMelee, GladiatorGun, gladiator_pain } from "../src/kexgame/m_gladiator";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (copied from
// test/kexgame_g_monster.test.ts's own module-private fixture)
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
 *  to a specific live entity (bullet/railgun hitscans and fire_hit's two
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
  // Harmless no-op defaults: T_Damage's M_ReactToDamage path calls
  // FoundTarget/HuntTarget on a damaged SVF_MONSTER entity, which throws if
  // monsterinfo.stand/run are null. Tests that exercise a specific
  // monster's real stand/run handlers overwrite these afterward.
  e.monsterinfo.stand = () => {};
  e.monsterinfo.run = () => {};
  gi.linkentity(e);
  return e;
}

/** Forces exactly one M_MoveFrame animation step regardless of level.time
 *  pacing (monsterinfo.next_move_time gates real pacing; this suite tests
 *  the frame-reached BEHAVIOR, which kexgame_g_monster.test.ts's own suite
 *  already covers the pacing for). */
function stepFrame(self: EdictT, times = 1): void {
  for (let i = 0; i < times; i++) {
    self.monsterinfo.next_move_time = GTIME_ZERO;
    M_MoveFrame(self);
  }
}

/** The move a monsterinfo.stand/run/etc. handler just selected, whether it
 *  used M_SetAnimation's instant=true (active_move updates synchronously)
 *  or instant=false (only next_move is staged until a real M_MoveFrame
 *  promotes it). Reading this instead of forcing an M_MoveFrame call avoids
 *  the transition tests below accidentally running a real movement aifunc
 *  (ai_run/ai_charge) with no enemy/goalentity set up, which is a
 *  legitimate way for those aifuncs to change monsterinfo state again on
 *  their own (out of scope for an animation-*selection* test). */
function pendingOrActiveMove(self: EdictT) {
  return self.monsterinfo.next_move ?? self.monsterinfo.active_move;
}

// ---------------------------------------------------------------------------
// SOLDIER (m_soldier.cpp)
// ---------------------------------------------------------------------------

describe("soldier", () => {
  test("mmove sanity: soldier_move_run's frame count matches lastframe-firstframe+1 (m_soldier.h FRAME_run03..FRAME_run08, MmoveT ctor validation)", () => {
    expect(soldier_move_run.frame.length).toBe(soldier_move_run.lastframe - soldier_move_run.firstframe + 1);
    expect(soldier_move_run.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: soldier_stand -> soldier_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = soldier_stand;
    self.monsterinfo.run = soldier_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
    expect(afterRun).toBe(soldier_move_start_run);
  });

  test("attack-fire: soldier_fire1's blaster branch calls monster_fire_blaster(damage=5, speed=600) (m_soldier.cpp:562)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(200, 0, 0));
    self.enemy = enemy;
    self.count = 0; // count < 2 -> blaster branch

    soldier_fire1(self);

    const bolt = g_edicts.find((e) => e.inuse && e.classname === "bolt");
    expect(bolt).toBeDefined();
    expect(bolt!.dmg).toBe(5);
    expect(vec3_length(bolt!.velocity)).toBeGreaterThan(599);
    expect(vec3_length(bolt!.velocity)).toBeLessThan(601);
  });

  test("pain skip: soldier_pain's debounce early return leaves active_move untouched and plays no sound (m_soldier.cpp:415-428)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.velocity = vec3(0, 0, 0); // not the velocity[2]>100 branch
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
    self.monsterinfo.active_move = soldier_move_run;

    soldier_pain(self, self, 0, 5, { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.monsterinfo.active_move).toBe(soldier_move_run);
    expect(rec.soundCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INFANTRY (m_infantry.cpp)
// ---------------------------------------------------------------------------

describe("infantry", () => {
  test("mmove sanity: importing m_infantry.ts succeeded, proving all 17 MmoveT tables passed row-count validation (infantry's tables are module-private by design, see g_turret.ts's 5-symbol contract)", () => {
    expect(typeof infantry_stand).toBe("function");
    expect(typeof infantry_pain).toBe("function");
  });

  test("animation transition: infantry_stand -> infantry_run (via monsterinfo, wired by the real SP_monster_infantry) changes active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    SP_monster_infantry(self);
    expect(self.monsterinfo.stand).toBe(infantry_stand);
    expect(self.monsterinfo.run).not.toBeNull();

    self.monsterinfo.stand!(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();
    expect(afterStand!.frame.length).toBe(afterStand!.lastframe - afterStand!.firstframe + 1);

    self.monsterinfo.run!(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: InfantryMachineGun's monster_fire_bullet call, damage=3 kick=4 hspread=300 vspread=500 (m_infantry.cpp:313)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    SP_monster_infantry(self);
    self.enemy = enemy;
    self.count = 1; // infantry_attack: self.count truthy -> infantry_move_attack1 (m_infantry.cpp routing)

    // infantry_attack's own M_CheckClearShot precondition needs a clear
    // (no-hit) trace, which is the harness default -- fire the real,
    // exported monsterinfo.attack (infantry_attack) while it's still clear.
    self.monsterinfo.attack!(self);

    // Now switch the fixture's trace to resolve any FAR trace (the actual
    // ~8192-unit bullet shot) as a hit against `enemy`, while short traces
    // (the muzzle-offset checks fire_bullet also performs) stay clear --
    // matching fire_lead's real trace pattern (g_weapon.ts:510-589).
    traceImpl = (start, _mins, _maxs, end) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return dist > 1000 ? hitTrace(end, enemy) : noHitTrace(end);
    };

    // infantry_move_attack1 is staged (M_SetAnimation(..., false)). Step 1
    // promotes it to active_move and (s.frame starting outside its range)
    // resets s.frame to firstframe (FRAME_attak101, index 0: ai_charge, no
    // thinkfunc). Step 2 advances to index 1 (footstep/firetime bookkeeping,
    // still no fire). Step 3 advances to index 2 (FRAME_attak103), whose
    // thinkfunc is `infantry_fire`, which calls InfantryMachineGun
    // (m_infantry.cpp:272-314's `attack1` frame table).
    stepFrame(self, 3);

    expect(enemy.health).toBe(97); // 100 - damage(3)
  });

  test("pain skip: infantry_pain's debounce early return leaves active_move untouched and plays no sound (m_infantry.cpp:211-219)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.think = null; // not monster_think -> the frandom()<0.33 dodge branch inside the skip path never runs
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
    self.monsterinfo.active_move = null;

    infantry_pain(self, self, 0, 5, { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.monsterinfo.active_move).toBeNull();
    expect(rec.soundCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GUNNER (m_gunner.cpp)
// ---------------------------------------------------------------------------

describe("gunner", () => {
  test("mmove sanity: gunner_move_fire_chain's frame count matches lastframe-firstframe+1", () => {
    expect(gunner_move_fire_chain.frame.length).toBe(gunner_move_fire_chain.lastframe - gunner_move_fire_chain.firstframe + 1);
    expect(gunner_move_fire_chain.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: gunner_stand -> gunner_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = gunner_stand;
    self.monsterinfo.run = gunner_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: GunnerFire's monster_fire_bullet call, damage=3 kick=4 hspread=300 vspread=500 (m_gunner.cpp:391)", () => {
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

    // Every frame of gunner_move_fire_chain is GunnerFire
    // (m_gunner.cpp:533-540 equivalent frame array) -- drive it directly
    // via the real, exported M_SetAnimation/M_MoveFrame rather than
    // gunner_attack's full blind-fire/grenade-vs-chaingun routing logic.
    M_SetAnimation(self, gunner_move_fire_chain, true);
    stepFrame(self);

    expect(enemy.health).toBe(97); // 100 - damage(3)
  });

  test("pain skip: gunner_pain's debounce early return leaves active_move untouched and plays no sound (m_gunner.cpp:258-261)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
    self.monsterinfo.active_move = gunner_move_fire_chain;

    gunner_pain(self, self, 0, 5, { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.monsterinfo.active_move).toBe(gunner_move_fire_chain);
    expect(rec.soundCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BERSERK (m_berserk.cpp)
// ---------------------------------------------------------------------------

describe("berserk", () => {
  test("mmove sanity: berserk_move_attack_spike's frame count matches lastframe-firstframe+1", () => {
    expect(berserk_move_attack_spike.frame.length).toBe(berserk_move_attack_spike.lastframe - berserk_move_attack_spike.firstframe + 1);
    expect(berserk_move_attack_spike.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: berserk_stand -> berserk_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = berserk_stand;
    self.monsterinfo.run = berserk_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire: berserk_attack_spike's fire_hit call, damage=irandom(5,11) kick=80 (m_berserk.cpp:161)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0)); // overlapping bboxes -- well within melee range
    self.enemy = enemy;

    // fire_hit only performs two short box-distance traces; resolving every
    // trace to a hit against `enemy` is safe here (unlike the far-hitscan
    // monsters above) since nothing else calls gi.trace in this path.
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    // berserk_frames_attack_spike (m_berserk.cpp's frame array): index 0-1
    // are plain ai_charge, index 2 is berserk_swing (sound only), index 3
    // is berserk_attack_spike (the fire_hit call). Drive the real, exported
    // table directly rather than berserk_melee's coin-flip spike-vs-club
    // routing.
    M_SetAnimation(self, berserk_move_attack_spike, true);
    stepFrame(self, 4);

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(5);
    expect(damageDealt).toBeLessThanOrEqual(10); // irandom(5,11): min-inclusive, max-exclusive
  });

  test("pain skip: berserk_pain's debounce early return leaves active_move untouched and plays no sound (m_berserk.cpp:509-512)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
    self.monsterinfo.active_move = berserk_move_attack_spike;

    berserk_pain(self, self, 0, 5, { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.monsterinfo.active_move).toBe(berserk_move_attack_spike);
    expect(rec.soundCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GLADIATOR (m_gladiator.cpp)
// ---------------------------------------------------------------------------

describe("gladiator", () => {
  test("mmove sanity: gladiator_move_attack_melee's frame count matches lastframe-firstframe+1", () => {
    expect(gladiator_move_attack_melee.frame.length).toBe(gladiator_move_attack_melee.lastframe - gladiator_move_attack_melee.firstframe + 1);
    expect(gladiator_move_attack_melee.allowFrameCountMismatch).toBe(false);
  });

  test("animation transition: gladiator_stand -> gladiator_run changes monsterinfo.active_move", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.monsterinfo.stand = gladiator_stand;
    self.monsterinfo.run = gladiator_run;

    self.monsterinfo.stand(self);
    const afterStand = pendingOrActiveMove(self);
    expect(afterStand).not.toBeNull();

    self.monsterinfo.run(self);
    const afterRun = pendingOrActiveMove(self);

    expect(afterRun).not.toBeNull();
    expect(afterRun).not.toBe(afterStand);
  });

  test("attack-fire (melee): GladiatorMelee's fire_hit call, damage=irandom(20,25) kick=300 (m_gladiator.cpp:110)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(20, 0, 0));
    self.enemy = enemy;
    traceImpl = (_start, _mins, _maxs, end) => hitTrace(end, enemy);

    GladiatorMelee(self);

    const damageDealt = 100 - enemy.health;
    expect(damageDealt).toBeGreaterThanOrEqual(20);
    expect(damageDealt).toBeLessThanOrEqual(24); // irandom(20,25): min-inclusive, max-exclusive
  });

  test("attack-fire (railgun): GladiatorGun's monster_fire_railgun call, damage=50 kick=100 (m_gladiator.cpp:155)", () => {
    setupWorld(4);
    const self = makeMonster(1, vec3(0, 0, 0));
    const enemy = makeMonster(2, vec3(0, 500, 0));
    self.enemy = enemy;
    self.pos1 = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);

    // Railgun beams pierce every entity along their path unconditionally
    // (fire_rail's real pierce-hit callback, unlike fire_lead's bullet
    // callback, never stops at a live, non-dead monster) -- markPierce sets
    // the hit entity's `.solid` to SOLID_NOT for the remainder of the trace
    // so a real retrace from the pierce point onward can't hit it a second
    // time. The fake trace mirrors that check so the pierce loop
    // terminates after exactly one real hit, instead of re-hitting `enemy`
    // on every iteration until MAX_PIERCE.
    traceImpl = (start, _mins, _maxs, end) => {
      if (enemy.solid === SolidT.SOLID_NOT) return noHitTrace(end);
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const dz = end[2] - start[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      return dist > 1000 ? hitTrace(end, enemy) : noHitTrace(end);
    };

    GladiatorGun(self);

    expect(enemy.health).toBe(50); // 100 - damage(50)
  });

  test("pain skip: gladiator_pain's debounce early return (velocity[2]<=100, so no air-pain switch either) leaves active_move untouched and plays no sound (m_gladiator.cpp:272-279)", () => {
    setupWorld(4);
    const self = makeMonster(1);
    self.velocity = vec3(0, 0, 0);
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
    self.monsterinfo.active_move = gladiator_move_attack_melee;

    gladiator_pain(self, self, 0, 5, { id: 0, friendly_fire: false, no_point_loss: false });

    expect(self.monsterinfo.active_move).toBe(gladiator_move_attack_melee);
    expect(rec.soundCalls.length).toBe(0);
  });
});
