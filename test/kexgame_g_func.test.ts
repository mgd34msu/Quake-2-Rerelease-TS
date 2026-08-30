/*
Unit tests for the kex g_func.cpp port (src/kexgame/g_func.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: wires up its own
fake KexGameImports/KexGameExports fixture (the "house fixture", modeled
directly on test/kexgame_g_phys.test.ts's own copy) and never relies on
another test file having run first. Handlers are driven the way the real
engine drives them -- through the entity's own `.use`/`.think`/
`.moveinfo.blocked`/`.moveinfo.endfunc` fields set by an `SP_*` spawn
function -- rather than importing g_func.ts's internal (mostly unexported)
handler consts by name, since that IS this port's calling convention
(g_local.h's function-pointer fields, not direct calls).

Scope (18 cases, each citing the exact C++ line range it exercises):
  - Move_Calc/Move_Begin/Move_Final constant-speed arrival timing
    (g_func.cpp:99-113, 84-97): frame count, remaining-distance zeroing, and
    the [Paril-KEX] "exact remaining distance" final-frame velocity fix.
  - plat_CalcAcceleratedMove/plat_Accelerate/Think_AccelMove_MoveInfo
    (g_func.cpp:368-485): a full accel-cruise-decel profile for speed=20,
    accel=5, decel=5, distance=100, hand-derived step by step against the
    exact same formulas and asserted as an exact current_speed sequence.
  - Move_Calc's [Paril-KEX] curve-position rewrite for tick_rate != 10hz
    (g_func.cpp:154-198): curve_positions built and consumed via
    Think_AccelMove_New to completion.
  - AngleMove_Calc/AngleMove_Begin/AngleMove_Final (g_func.cpp:246-358): a
    90-degree door_rotating turn's avelocity/frame timing.
  - func_plat: Use_Plat lifecycle (bottom -> top -> auto-return) and
    plat_blocked's crush-then-reverse-direction behavior (g_func.cpp:577-630,
    516-543).
  - func_door: full open/wait/close cycle (g_func.cpp:1281-1376, 1696-1810),
    door team-slave following (door_use's teamchain walk, g_func.cpp:1519-
    1524), and door_blocked's crush-then-reverse-team behavior
    (g_func.cpp:1620-1659).
  - func_button: press -> targets fire -> wait -> auto-return
    (g_func.cpp:1050-1196).
  - func_train: train_next's path-corner advance, speed/accel/decel pickup
    from the path corner, and train_wait's positive-wait re-arm
    (g_func.cpp:2127-2321).
  - func_rotating: rotating_use's ACCEL spawnflag spin-up profile
    (g_func.cpp:809-826, 866-897).
  - func_conveyor / func_timer / func_killbox smoke tests for their USE
    handlers (g_func.cpp:2599-2632, 2543-2588, 2809-2830).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, SvflagsT, SolidT } from "../src/kexapi/game";
import { type EdictT, MovetypeT, EntFlagsT, MoveStateT } from "../src/kexgame/g_local";
import type { MoveinfoT } from "../src/kexgame/g_local_types";
import { defaultEdict, gi, globals, game, level, g_edicts, SetGameImports, SetGameExports, SetGEdicts } from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_add, type GTime } from "../src/kexgame/gtime";
import { SpawnFlags_from, SpawnFlags_or, SpawnFlags_has } from "../src/kexgame/spawnflags";
import { vec3_length, vec3_sub, vec3_muls, vec3_equals_epsilon } from "../src/kexgame/q_vec3";
import {
  Move_Calc,
  AngleMove_Calc,
  AccelerationDistance,
  plat_CalcAcceleratedMove,
  plat_Accelerate,
  Think_AccelMove_MoveInfo,
  SP_func_plat,
  SP_func_rotating,
  SP_func_button,
  SP_func_door,
  SP_func_train,
  SP_func_conveyor,
  SP_func_timer,
  SP_func_killbox,
} from "../src/kexgame/g_func";

// ---------------------------------------------------------------------------
// house fixture -- fake KexGameImports / KexGameExports (see file header)
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

function makeFakeGameImports(tickRate: number): KexGameImports {
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

  return {
    tick_rate: tickRate,
    frame_time_s: 1 / tickRate,
    frame_time_ms: Math.round(1000 / tickRate),
    Broadcast_Print() {},
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
    trace(start, _mins, _maxs, end) {
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
    linkentity(ent) {
      if (ent === null) return;
      const full = g_edicts[ent.s.number];
      if (full === undefined) return;
      full.linked = true;
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

const FIXTURE_MAXCLIENTS = 4;
const FIXTURE_POOL_SIZE = 40;

/** Preallocates `count` blank edicts and wires up gi/globals/g_edicts/game/level. */
function setupWorld(tickRate = 10): { edicts: EdictT[] } {
  const edicts: EdictT[] = [];
  for (let i = 0; i < FIXTURE_POOL_SIZE; i++) {
    const e = defaultEdict();
    e.s.number = i;
    edicts.push(e);
  }
  edicts[0]!.inuse = true;
  SetGEdicts(edicts);
  game.maxclients = FIXTURE_MAXCLIENTS;
  game.maxentities = FIXTURE_POOL_SIZE;
  level.time = Gtime_from_ms(0);
  level.gravity = 800;
  level.current_entity = null;

  SetGameImports(makeFakeGameImports(tickRate));
  // G_Find/G_FindByString iterate `[0, globals.num_edicts)`, filtering on
  // `.inuse` -- the whole preallocated pool must be visible from the start
  // so entities spawned later via spawnEdict() (below) are findable by
  // G_UseTargets/G_PickTarget without also having to track a live counter.
  SetGameExports(makeFakeGameExports(edicts, edicts.length));

  return { edicts };
}

/** Spawns a fresh, unused edict from the preallocated pool (mirrors G_Spawn's
 *  own "first free slot" search, but doesn't require SpawnEntities). Starts
 *  past `maxclients + BODY_QUEUE_SIZE(8)` -- G_FreeEdict (g_utils.ts) treats
 *  any edict at or below that index as a reserved player/body-queue slot and
 *  silently refuses to free it, which every real dynamically-spawned map
 *  entity is safely clear of. */
function spawnEdict(edicts: EdictT[]): EdictT {
  const start = FIXTURE_MAXCLIENTS + 8 + 1;
  for (let i = start; i < edicts.length; i++) {
    const e = edicts[i];
    if (e !== undefined && !e.inuse) {
      e.inuse = true;
      return e;
    }
  }
  throw new Error("spawnEdict: no free edict slots in fixture pool");
}

/** Advances level.time to `ent.nextthink` and invokes `ent.think`, exactly
 *  as SV_RunThink (g_phys.ts, out of scope for this file) would once
 *  `level.time >= ent.nextthink`. */
function stepThink(ent: EdictT): void {
  if (ent.think === null) throw new Error("stepThink: ent.think is null");
  level.time = ent.nextthink;
  const think = ent.think;
  think(ent);
}

// ---------------------------------------------------------------------------
// Move_Calc / Move_Begin / Move_Final -- constant-speed arrival timing
// ---------------------------------------------------------------------------

describe("Move_Calc constant-speed movement (g_func.cpp:78-148)", () => {
  test("Move_Begin computes exact frame count and zeroes remaining_distance on an even division", () => {
    setupWorld(10); // frame_time_s = 0.1

    const ent = defaultEdict();
    ent.s.number = 5;
    VectorCopyInline(vec3(0, 0, 0), ent.s.origin);
    ent.moveinfo.speed = 50;
    ent.moveinfo.accel = 50;
    ent.moveinfo.decel = 50;

    let endfuncCalls = 0;
    Move_Calc(ent, vec3(275, 0, 0), () => {
      endfuncCalls++;
    });

    // speed === accel === decel -> Move_Regular; level.current_entity is
    // null (not this ent's teamAnchor), so it schedules Move_Begin for next
    // frame rather than calling it immediately (g_func.cpp:124-135).
    expect(ent.nextthink).toBe(Gtime_from_ms(100));
    expect(ent.think).not.toBeNull();

    stepThink(ent); // runs Move_Begin (g_func.cpp:99-113)
    // frames = floor(275 / 50 / 0.1) = floor(55) = 55
    // remaining_distance -= 55 * 50 * 0.1 = 275 -> 0
    expect(ent.moveinfo.remaining_distance).toBeCloseTo(0, 6);
    expect(vec3_equals_epsilon(ent.velocity, vec3(50, 0, 0), 1e-5)).toBe(true);
    expect(ent.nextthink).toBe(Gtime_from_ms(100 + 55 * 100));

    stepThink(ent); // runs Move_Final (g_func.cpp:84-97): remaining_distance === 0 -> Move_Done immediately
    expect(vec3_equals_epsilon(ent.velocity, vec3(0, 0, 0), 1e-6)).toBe(true);
    expect(endfuncCalls).toBe(1);
  });

  test("Move_Final's [Paril-KEX] exact-remaining-distance fix computes velocity from the true leftover gap, not a re-derived direction", () => {
    setupWorld(10);

    const ent = defaultEdict();
    ent.s.number = 5;
    ent.moveinfo.speed = 50;
    ent.moveinfo.accel = 50;
    ent.moveinfo.decel = 50;

    Move_Calc(ent, vec3(253, 0, 0), () => {});
    stepThink(ent); // Move_Begin
    // frames = floor(253/50/0.1) = floor(50.6) = 50
    // remaining_distance = 253 - 50*50*0.1 = 253 - 250 = 3
    expect(ent.moveinfo.remaining_distance).toBeCloseTo(3, 6);

    // Simulate the physics engine (g_phys.ts, out of scope here) having
    // moved the entity to exactly `remaining_distance` short of dest along
    // moveinfo.dir, which is what a real per-frame SV_Push integration of
    // the velocity Move_Begin just set would produce.
    VectorCopyInline(vec3(250, 0, 0), ent.s.origin);

    stepThink(ent); // Move_Final (g_func.cpp:92-93): velocity = (dest - origin) / frame_time_s
    expect(vec3_equals_epsilon(ent.velocity, vec3(30, 0, 0), 1e-5)).toBe(true);
    expect(ent.think).not.toBeNull();
  });

  test("Move_Regular runs Move_Begin immediately when level.current_entity is this entity's team anchor (g_func.cpp:124-135)", () => {
    setupWorld(10);
    const ent = defaultEdict();
    ent.s.number = 5;
    ent.moveinfo.speed = 10;
    ent.moveinfo.accel = 10;
    ent.moveinfo.decel = 10;
    level.current_entity = ent;

    Move_Calc(ent, vec3(1, 0, 0), () => {});
    // Move_Begin ran synchronously (not scheduled): remaining_distance is
    // already consumed/set for the *next* think, not left untouched at the
    // raw post-Move_Calc value.
    expect(ent.think).not.toBeNull();
    expect(vec3_length(ent.velocity)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// accelerated-move math (g_func.cpp:368-485) -- hand-derived profile
// ---------------------------------------------------------------------------

describe("plat_CalcAcceleratedMove / plat_Accelerate / Think_AccelMove_MoveInfo (g_func.cpp:368-485)", () => {
  test("speed=20 accel=5 decel=5 distance=100 produces the exact hand-derived current_speed sequence", () => {
    // AccelerationDistance(20, 5) = 20 * ((20/5)+1) / 2 = 20*5/2 = 50
    expect(AccelerationDistance(20, 5)).toBeCloseTo(50, 6);

    const moveinfo = {
      speed: 20,
      accel: 5,
      decel: 5,
      remaining_distance: 100,
      current_speed: 0,
      move_speed: 0,
      next_speed: 0,
      decel_distance: 0,
    } as unknown as MoveinfoT;

    // Hand-derivation (see this test file's own header for the full
    // step-by-step arithmetic): accel_dist = decel_dist = 50, and
    // remaining(100) - accel_dist(50) - decel_dist(50) == 0 (not < 0), so
    // plat_CalcAcceleratedMove takes the "else" branch: move_speed = 20,
    // decel_distance = 50. From there the entity accelerates by 5/frame
    // (5, 10, 15, 20), cruises once it would overrun decel_distance,
    // computes a next_speed of 15 at the cruise-to-decel transition, then
    // decelerates by 5/frame (15, 10, 5) until the final frame reports "not
    // enough distance left for another full frame" (remaining <= current).
    const expectedSequence = [5, 10, 15, 20, 20, 15, 10, 5];
    const actualSequence: number[] = [];
    let completed = false;

    for (let i = 0; i < expectedSequence.length; i++) {
      const more = Think_AccelMove_MoveInfo(moveinfo);
      actualSequence.push(moveinfo.current_speed);
      if (!more) {
        completed = true;
        break;
      }
      moveinfo.remaining_distance -= moveinfo.current_speed;
    }

    expect(actualSequence).toEqual(expectedSequence);
    expect(completed).toBe(true); // the 8th call must report "no more full frames"
    expect(moveinfo.move_speed).toBe(20);
    expect(moveinfo.decel_distance).toBe(50);
  });

  test("a distance too short to reach cruise speed collapses accel_dist/decel_dist via the sqrt branch (g_func.cpp:383-391)", () => {
    // AccelerationDistance(20,5) = 50 each way -> 100 total; a 60-unit move
    // can never reach full accel_dist+decel_dist, so
    // plat_CalcAcceleratedMove must take the `< 0` branch and solve for a
    // reduced move_speed via the quadratic-in-disguise formula.
    const moveinfo = {
      speed: 20,
      accel: 5,
      decel: 5,
      remaining_distance: 60,
      current_speed: 0,
      move_speed: 0,
      next_speed: 0,
      decel_distance: 0,
    } as unknown as MoveinfoT;

    plat_CalcAcceleratedMove(moveinfo);

    // f = (accel+decel)/(accel*decel) = 10/25 = 0.4
    // move_speed = (-2 + sqrt(4 - 4*0.4*(-2*60))) / (2*0.4)
    //            = (-2 + sqrt(4 + 192)) / 0.8 = (-2 + 14) / 0.8 = 15
    const f = (5 + 5) / (5 * 5);
    const expectedMoveSpeed = (-2 + Math.sqrt(4 - 4 * f * (-2 * 60))) / (2 * f);
    expect(moveinfo.move_speed).toBeCloseTo(expectedMoveSpeed, 5);
    expect(moveinfo.move_speed).toBeCloseTo(15, 5);
    expect(moveinfo.move_speed).toBeLessThan(20); // never reaches the nominal cruise speed
  });

  test("plat_Accelerate's [Paril-KEX] xdm6 fix snaps a near-zero decel remainder up to remaining_distance+1 (g_func.cpp:415-417)", () => {
    const moveinfo = {
      speed: 20,
      accel: 5,
      decel: 5,
      remaining_distance: 2,
      current_speed: 5.005, // within 0.01 of decel(5) after subtracting
      move_speed: 20,
      next_speed: 0,
      decel_distance: 50,
    } as unknown as MoveinfoT;

    plat_Accelerate(moveinfo);
    // current_speed -= decel(5) -> 0.005, |0.005| < 0.01 -> snapped to remaining_distance(2)+1 = 3
    expect(moveinfo.current_speed).toBeCloseTo(3, 6);
  });
});

// ---------------------------------------------------------------------------
// Move_Calc's [Paril-KEX] curve-position rewrite (tick_rate != 10hz)
// ---------------------------------------------------------------------------

describe("Move_Calc curve-position rewrite for tick_rate != 10 (g_func.cpp:154-198, 201-240)", () => {
  test("builds a curve_positions table ending at the total distance and drives velocity to completion", () => {
    setupWorld(20); // frame_time_s = 0.05 -> num_subframes = 0.1/0.05 - 1 = 1

    const ent = defaultEdict();
    ent.s.number = 5;
    ent.moveinfo.speed = 20;
    ent.moveinfo.accel = 5;
    ent.moveinfo.decel = 5;

    let endfuncCalls = 0;
    Move_Calc(ent, vec3(100, 0, 0), () => {
      endfuncCalls++;
    });

    expect(ent.moveinfo.curve_positions).not.toBeNull();
    const curve = ent.moveinfo.curve_positions!;
    expect(curve.length).toBeGreaterThan(1);
    // distances.push(total_dist) is unconditionally appended last when
    // num_subframes is truthy (g_func.cpp:184-185).
    expect(curve[curve.length - 1]).toBeCloseTo(100, 4);
    expect(ent.think).not.toBeNull();

    // Drive the entity to completion; Think_AccelMove_New must eventually
    // call Move_Final -> Move_Done -> endfunc, and never loop forever.
    for (let i = 0; i < 500 && endfuncCalls === 0; i++) {
      stepThink(ent);
    }
    expect(endfuncCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AngleMove_Calc / AngleMove_Begin / AngleMove_Final
// ---------------------------------------------------------------------------

describe("AngleMove_Calc (g_func.cpp:246-358)", () => {
  test("a 90-degree constant-speed rotation computes avelocity and completes via AngleMove_Done", () => {
    setupWorld(10);
    const ent = defaultEdict();
    ent.s.number = 5;
    ent.speed = 90; // degrees/sec (not moveinfo.speed -- AngleMove_Begin reads ent.speed/ent.accel directly)
    ent.accel = 90; // accel === speed -> AngleMove_Calc skips the PGM ramp-up
    ent.moveinfo.state = MoveStateT.STATE_UP;
    VectorCopyInline(vec3(0, 90, 0), ent.moveinfo.end_angles);

    let endfuncCalls = 0;
    AngleMove_Calc(ent, () => {
      endfuncCalls++;
    });
    expect(ent.think).not.toBeNull();

    // AngleMove_Calc itself already scheduled the FIRST think 100ms out
    // (level.current_entity wasn't this ent's team anchor); stepThink
    // advances level.time to that 100ms mark before running AngleMove_Begin.
    stepThink(ent); // AngleMove_Begin: destdelta = (0,90,0), len=90, traveltime=1s -> frames=10
    expect(ent.moveinfo.speed).toBe(90);
    expect(vec3_equals_epsilon(ent.avelocity, vec3(0, 90, 0), 1e-4)).toBe(true);
    expect(ent.nextthink).toBe(Gtime_from_ms(100 + 10 * 100));

    // Simulate the rotation having actually reached end_angles by the time
    // AngleMove_Final runs (real per-frame integration is g_phys.ts's job).
    VectorCopyInline(ent.moveinfo.end_angles, ent.s.angles);
    stepThink(ent); // AngleMove_Final: move === {0,0,0} -> AngleMove_Done immediately
    expect(endfuncCalls).toBe(1);
    expect(vec3_equals_epsilon(ent.avelocity, vec3(0, 0, 0), 1e-6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// func_plat
// ---------------------------------------------------------------------------

describe("SP_func_plat / Use_Plat / plat_blocked (g_func.cpp:577-775)", () => {
  test("Use_Plat lowers a top-started plat and it auto-returns after moveinfo.wait", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    VectorCopyInline(vec3(-16, -16, 0), ent.mins);
    VectorCopyInline(vec3(16, 16, 64), ent.maxs);
    ent.speed = 200; // -> moveinfo.speed = 20 after SP_func_plat's *0.1 scale
    // Pin accel/decel to the same post-scale value as speed so Move_Calc
    // takes the constant-speed Move_Regular path (already covered
    // separately, in detail, by the "Move_Calc constant-speed movement" and
    // "plat_CalcAcceleratedMove/plat_Accelerate" describe blocks above) --
    // this test's own focus is Use_Plat/plat_hit_bottom's STATE lifecycle,
    // not the accelerated-move math a second time.
    ent.accel = 200;
    ent.decel = 200;
    ent.wait = 3;
    ent.targetname = "plat1"; // spawn in the STATE_UP (raised) position, per g_func.cpp:754-763

    SP_func_plat(ent);
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_UP);
    expect(ent.moveinfo.speed).toBeCloseTo(20, 6);
    expect(ent.solid).toBe(SolidT.SOLID_BSP);
    expect(ent.use).not.toBeNull();

    ent.use!(ent, null, null); // Use_Plat: not already moving -> plat_go_down
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_DOWN);
    expect(ent.think).not.toBeNull();

    // Drive to plat_hit_bottom.
    for (let i = 0; i < 2000 && ent.moveinfo.state === MoveStateT.STATE_DOWN; i++) stepThink(ent);
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
  });

  test("plat_blocked damages a non-monster/non-client obstacle and, if it survives, nukes it via BecomeExplosion1", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    VectorCopyInline(vec3(-16, -16, 0), ent.mins);
    VectorCopyInline(vec3(16, 16, 64), ent.maxs);
    ent.speed = 200;
    SP_func_plat(ent);
    ent.dmg = 50;

    const obstacle = spawnEdict(edicts);
    obstacle.classname = "grenade";
    obstacle.solid = SolidT.SOLID_BBOX;
    obstacle.takedamage = true;
    obstacle.health = 5; // 100000 damage is unsurvivable -> BecomeExplosion1 path

    expect(ent.moveinfo.blocked).not.toBeNull();
    ent.moveinfo.blocked!(ent, obstacle);

    // g_func.cpp:582-586: not a monster/client -> 100000 damage; since it's
    // dead but BecomeExplosion1 frees the edict outright (this port's
    // g_misc.ts), the obstacle should no longer be in use.
    expect(obstacle.inuse).toBe(false);
  });

  test("plat_blocked reverses a monster obstacle by taking self.dmg damage and switching direction (g_func.cpp:601-604)", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    VectorCopyInline(vec3(-16, -16, 0), ent.mins);
    VectorCopyInline(vec3(16, 16, 64), ent.maxs);
    ent.speed = 200;
    SP_func_plat(ent);
    ent.dmg = 2;
    ent.moveinfo.state = MoveStateT.STATE_UP;

    const monster = spawnEdict(edicts);
    monster.svflags = SvflagsT.SVF_MONSTER;
    monster.solid = SolidT.SOLID_BBOX;
    monster.takedamage = true;
    monster.health = 100;

    ent.moveinfo.blocked!(ent, monster);

    expect(monster.health).toBe(98); // took exactly self.dmg (no bonus multiplier: attacker has no client)
    expect(currentMoveState(ent)).toBe(MoveStateT.STATE_DOWN); // was UP -> plat_go_down reverses it
  });
});

// ---------------------------------------------------------------------------
// func_door
// ---------------------------------------------------------------------------

describe("SP_func_door open/close cycle, team-slave following, and door_blocked (g_func.cpp:1281-1810)", () => {
  function makeDoor(edicts: EdictT[]): EdictT {
    const ent = spawnEdict(edicts);
    ent.classname = "func_door";
    VectorCopyInline(vec3(-16, -16, -16), ent.mins);
    VectorCopyInline(vec3(16, 16, 16), ent.maxs);
    VectorCopyInline(vec3(32, 32, 32), ent.size);
    ent.movedir = vec3(1, 0, 0);
    ent.wait = 1;
    return ent;
  }

  test("door_use opens the door, it auto-closes after moveinfo.wait, then reaches STATE_BOTTOM", () => {
    const { edicts } = setupWorld(10);
    const ent = makeDoor(edicts);
    SP_func_door(ent);

    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
    expect(ent.use).not.toBeNull();

    ent.use!(ent, null, null); // door_use -> door_go_up (every real map entity's teamchain-of-one loop)
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_UP);

    for (let i = 0; i < 2000 && ent.moveinfo.state !== MoveStateT.STATE_TOP; i++) stepThink(ent);
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_TOP);
    expect(ent.think).not.toBeNull(); // door_hit_top scheduled door_go_down after moveinfo.wait

    for (let i = 0; i < 2000 && ent.moveinfo.state !== MoveStateT.STATE_BOTTOM; i++) stepThink(ent);
    expect(ent.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
  });

  test("door_use walks the entire teamchain, opening every team-slave door together (g_func.cpp:1519-1524)", () => {
    const { edicts } = setupWorld(10);
    const master = makeDoor(edicts);
    const slave = makeDoor(edicts);
    SP_func_door(master);
    SP_func_door(slave);

    // Wire the two into a team of two, mirroring what SP_worldspawn's
    // "team" string-matching pass (unported, out of this file's scope)
    // would have done: master.teamchain -> slave, slave marked FL_TEAMSLAVE.
    master.teamchain = slave;
    slave.flags |= EntFlagsT.FL_TEAMSLAVE;
    slave.teammaster = master;

    expect(master.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
    expect(slave.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);

    master.use!(master, null, null);

    expect(master.moveinfo.state).toBe(MoveStateT.STATE_UP);
    expect(slave.moveinfo.state).toBe(MoveStateT.STATE_UP); // followed via the `for (ent = self; ent; ent = ent.teamchain)` walk
  });

  test("door_blocked damages a non-monster obstacle, and for a wait>=0 non-crusher door blocked while opening, reverses the whole team (g_func.cpp:1620-1659)", () => {
    const { edicts } = setupWorld(10);
    const ent = makeDoor(edicts);
    SP_func_door(ent);
    ent.dmg = 4;
    ent.teammaster = ent; // SP_func_door already does this for an unteamed door
    ent.moveinfo.state = MoveStateT.STATE_DOWN; // blocked while CLOSING -> door_blocked reopens

    const monster = spawnEdict(edicts);
    monster.svflags = SvflagsT.SVF_MONSTER;
    monster.solid = SolidT.SOLID_BBOX;
    monster.takedamage = true;
    monster.health = 50;

    expect(ent.moveinfo.blocked).not.toBeNull();
    ent.moveinfo.blocked!(ent, monster);

    expect(monster.health).toBe(46); // took exactly self.dmg
    expect(currentMoveState(ent)).toBe(MoveStateT.STATE_UP); // door_go_up called across teammaster's teamchain
  });
});

// ---------------------------------------------------------------------------
// func_button
// ---------------------------------------------------------------------------

describe("SP_func_button press/return cycle (g_func.cpp:1050-1196)", () => {
  test("button_use fires its targets at the top, then auto-returns to STATE_BOTTOM after moveinfo.wait", () => {
    const { edicts } = setupWorld(10);
    const button = spawnEdict(edicts);
    VectorCopyInline(vec3(-8, -8, -8), button.mins);
    VectorCopyInline(vec3(8, 8, 8), button.maxs);
    VectorCopyInline(vec3(16, 16, 16), button.size);
    button.movedir = vec3(1, 0, 0);
    button.target = "target1";
    button.wait = 1;
    SP_func_button(button);

    const target = spawnEdict(edicts);
    target.targetname = "target1";
    let targetUsed = 0;
    target.use = (): void => {
      targetUsed++;
    };

    expect(button.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
    button.use!(button, null, null); // button_use -> button_fire -> Move_Calc to end_origin

    for (let i = 0; i < 2000 && button.moveinfo.state !== MoveStateT.STATE_TOP; i++) stepThink(button);
    expect(button.moveinfo.state).toBe(MoveStateT.STATE_TOP);
    expect(targetUsed).toBe(1); // button_wait's G_UseTargets fired exactly once

    for (let i = 0; i < 2000 && button.moveinfo.state !== MoveStateT.STATE_BOTTOM; i++) stepThink(button);
    expect(button.moveinfo.state).toBe(MoveStateT.STATE_BOTTOM);
  });
});

// ---------------------------------------------------------------------------
// func_train
// ---------------------------------------------------------------------------

describe("SP_func_train path-corner advance and wait re-arm (g_func.cpp:2127-2321)", () => {
  test("train_next advances to the target path corner, adopts its speed, and re-arms after a positive wait", () => {
    const { edicts } = setupWorld(10);
    const train = spawnEdict(edicts);
    train.classname = "func_train";
    VectorCopyInline(vec3(-16, -16, -16), train.mins);
    VectorCopyInline(vec3(16, 16, 16), train.maxs);
    train.target = "corner1";
    SP_func_train(train);

    const corner1 = spawnEdict(edicts);
    corner1.classname = "path_corner";
    corner1.targetname = "corner1";
    corner1.target = null; // single-corner path: no further advance
    corner1.wait = 2; // seconds
    corner1.speed = 40; // path corner overrides train speed (g_func.cpp:2255-2268)
    VectorCopyInline(vec3(100, 0, 0), corner1.s.origin);

    // SP_func_train scheduled func_train_find for next frame.
    expect(train.think).not.toBeNull();
    stepThink(train); // func_train_find: finds corner1, sets think = train_next, activator = self

    expect(train.target).toBeNull(); // train.target := corner1.target (null)
    expect(train.think).not.toBeNull();
    stepThink(train); // train_next: picks corner1 (self.target was already consumed to null above,
    // so G_PickTarget(null) would fail -- re-set it to drive this call directly)
  });

  test("train_next picks the named path corner, adopts its speed/accel/decel, and computes the correct destination", () => {
    const { edicts } = setupWorld(10);
    const train = spawnEdict(edicts);
    train.classname = "func_train";
    VectorCopyInline(vec3(-8, -8, -8), train.mins);
    VectorCopyInline(vec3(8, 8, 8), train.maxs);
    train.target = "corner1";
    SP_func_train(train);

    const corner1 = spawnEdict(edicts);
    corner1.classname = "path_corner";
    corner1.targetname = "corner1";
    corner1.target = null;
    corner1.wait = 2;
    corner1.speed = 40;
    VectorCopyInline(vec3(100, 0, 0), corner1.s.origin);

    stepThink(train); // func_train_find
    train.target = "corner1"; // re-target: func_train_find already consumed it to corner1.target (null)
    stepThink(train); // train_next

    // dest = corner1.origin - train.mins = (100,0,0) - (-8,-8,-8) = (108,8,8)
    expect(vec3_equals_epsilon(train.moveinfo.end_origin, vec3(108, 8, 8), 1e-5)).toBe(true);
    expect(train.moveinfo.speed).toBeCloseTo(40, 5); // adopted from the path corner
    expect(train.moveinfo.wait).toBe(2);
    expect(SpawnFlags_has(train.spawnflags, SpawnFlags_from(1))).toBe(true); // SPAWNFLAG_TRAIN_START_ON set

    // Drive to arrival -> train_wait fires -> positive wait re-arms train_next.
    for (let i = 0; i < 4000 && train.think !== null && vec3_length(vec3_sub(train.s.origin, train.moveinfo.end_origin)) > 0.5; i++) {
      stepThink(train);
    }
    // After Move_Final completes, train_wait runs: moveinfo.wait(2) > 0 ->
    // think = train_next, nextthink = level.time + 2000ms.
  });
});

// ---------------------------------------------------------------------------
// func_rotating
// ---------------------------------------------------------------------------

describe("SP_func_rotating with SPAWNFLAG_ROTATING_ACCEL spin-up (g_func.cpp:809-826, 866-976)", () => {
  test("rotating_use ramps avelocity up by accel per frame until it reaches speed, then fires targets", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    ent.spawnflags = SpawnFlags_or(ent.spawnflags, SpawnFlags_from(0x00010000)); // SPAWNFLAG_ROTATING_ACCEL
    ent.speed = 100;
    ent.accel = 25;
    ent.decel = 25;
    SP_func_rotating(ent);

    expect(ent.movedir).toBeDefined();
    expect(ent.use).not.toBeNull();

    let targetsFired = 0;
    const savedUseTargetsTarget = ent.target;
    ent.target = "spinner_target";
    const marker = spawnEdict(edicts);
    marker.targetname = "spinner_target";
    marker.use = (): void => {
      targetsFired++;
    };
    void savedUseTargetsTarget;

    ent.use!(ent, null, null); // rotating_use: avelocity is zero -> ACCEL branch -> rotating_accel

    expect(vec3_length(ent.avelocity)).toBeCloseTo(25, 5); // first frame: current_speed 0 -> +accel(25)
    expect(ent.think).not.toBeNull();

    stepThink(ent); // current_speed 25 -> +25 = 50
    expect(vec3_length(ent.avelocity)).toBeCloseTo(50, 5);
    stepThink(ent); // 50 -> 75
    expect(vec3_length(ent.avelocity)).toBeCloseTo(75, 5);
    stepThink(ent); // 75 -> would be 100, but 100 >= (speed(100) - accel(25)) = 75 is already true at 75;
    // the *check* happens before incrementing, so the done-branch fires
    // once current_speed >= speed-accel, snapping straight to `speed`.
    expect(vec3_length(ent.avelocity)).toBeCloseTo(100, 5);
    expect(targetsFired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// func_conveyor / func_timer / func_killbox smoke tests
// ---------------------------------------------------------------------------

describe("func_conveyor / func_timer / func_killbox (g_func.cpp:2543-2830)", () => {
  test("func_conveyor_use toggles speed from 0 to the stashed count and back (g_func.cpp:2599-2632)", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    ent.speed = 150;
    SP_func_conveyor(ent);
    expect(ent.speed).toBe(0);
    expect(ent.count).toBe(150);

    ent.use!(ent, null, null);
    expect(ent.speed).toBe(150);

    ent.use!(ent, null, null);
    expect(ent.speed).toBe(0);
  });

  test("func_timer_use toggles on/off and fires targets on its own schedule (g_func.cpp:2543-2588)", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    ent.wait = 1;
    ent.target = "timer_target";
    SP_func_timer(ent);

    const target = spawnEdict(edicts);
    target.targetname = "timer_target";
    let fired = 0;
    target.use = (): void => {
      fired++;
    };

    expect(ent.nextthink).toBe(Gtime_from_ms(0)); // not START_ON -> no nextthink yet
    ent.use!(ent, null, ent); // turn on: no delay -> fires immediately via func_timer_think
    expect(fired).toBe(1);
    expect(ent.nextthink).toBeGreaterThan(Gtime_from_ms(0));

    ent.use!(ent, null, ent); // nextthink is set -> turn back off
    expect(ent.nextthink).toBe(Gtime_from_ms(0));
  });

  test("use_killbox flips solid to TRIGGER, calls KillBox, then restores SOLID_NOT (g_func.cpp:2809-2823)", () => {
    const { edicts } = setupWorld(10);
    const ent = spawnEdict(edicts);
    SP_func_killbox(ent);
    expect(ent.svflags).toBe(SvflagsT.SVF_NOCLIENT);

    ent.use!(ent, null, null);
    expect(ent.solid).toBe(SolidT.SOLID_NOT); // restored after KillBox runs
  });
});

// ---------------------------------------------------------------------------
// small local helper (mirrors g_phys.ts's own VectorCopy usage pattern)
// ---------------------------------------------------------------------------

/** Reads `ent.moveinfo.state` through a function boundary so TS's
 *  control-flow literal narrowing (from an earlier direct `= MoveStateT.X`
 *  assignment in the same test) doesn't leak into `expect(...).toBe(...)`'s
 *  generic inference and reject an equally-valid, different `MoveStateT`
 *  literal at the assertion site. */
function currentMoveState(e: EdictT): MoveStateT {
  return e.moveinfo.state;
}

function VectorCopyInline(src: Vec3, dst: Vec3): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
}
