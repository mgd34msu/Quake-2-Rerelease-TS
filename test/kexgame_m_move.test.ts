/*
Unit tests for the kex m_move.cpp port (src/kexgame/m_move.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file wires
up its own fake KexGameImports/KexGameExports and never relies on another
test file having run first. Modeled directly after
test/kexgame_g_phys.test.ts's own fake-imports fixture (same
traceImpl/pointcontentsImpl mutable-hook pattern), extended with:
  - a "flat floor at world Z" trace fake (`makeFlatFloorTrace`) that clips a
    box trace's downward motion at a configurable world Z plane, used to
    drive SV_movestep's step/dropoff logic realistically instead of
    hand-scripting every individual gi.trace call;
  - a direction-aware variant (`makeChaseDirTrace`) that additionally makes
    the floor disappear for specific horizontal headings, used to drive
    SV_NewChaseDir's direction-preference tests without touching randomness;
  - m_move.ts's own test-only seams (`__setM_CheckGroundForTests`,
    `__setM_CatagorizePositionForTests`) standing in for M_CheckGround/
    M_CatagorizePosition, which are g_monster.ts's own (concurrent,
    not-yet-landed) responsibility -- see m_move.ts's file header
    ("EXTERNAL DEPENDENCIES NOT YET PORTED (g_monster.cpp)") for why these
    two specifically get a test seam instead of a plain throwing stub.

Scope (12+ cases, each citing the exact C++ line range it exercises):
  - M_ChangeYaw (m_move.cpp:919-958): positive-direction clamp to yaw_speed,
    negative-direction clamp, and the 360-degree wrap-around short path.
  - M_CheckBottom_Fast_Generic (m_move.cpp:20-41): all-corners-solid early
    accept, verified by never calling gi.trace at all.
  - M_CheckBottom_Slow_Generic (m_move.cpp:43-129): corner-quadrant
    pass/fail against the STEPSIZE(18) threshold, and the
    allow_any_step_height ([Paril-KEX] SUPER_STEP) mid-point early accept
    that skips the quadrant loop entirely.
  - SV_movestep (m_move.cpp:613-885), reached via M_walkmove: flat-ground
    advance (a full successful step), and dropoff rejection when the
    step-down probe finds no floor at all (m_move.cpp:730-747).
  - SV_flystep (m_move.cpp:443-599), reached via M_walkmove on a FL_SWIM
    entity: refuses to leave water when the target point isn't wet
    (m_move.cpp:557-567), and completes the move when it stays wet.
  - SV_flystep's enemy-height-adjust branch (m_move.cpp:466-538), reached
    via M_walkmove on a FL_FLY entity: halves the horizontal move and adds
    vertical thrust toward a higher enemy.
  - SV_NewChaseDir (m_move.cpp:1034-1144), reached via M_MoveToGoal: the
    direct-diagonal route is tried before anything else, and (on a fully
    blocked scripted map) every candidate direction is exhausted down to
    the turnaround fallback, both deterministically (no dependency on the
    function's own internal brandom() calls, which are never reached in
    either scripted scenario -- see the comment on each test).
*/

import { describe, test, expect } from "bun:test";
import { vec3, type Vec3, VectorCopy } from "../src/shared/math";
import { CplaneT, type CvarT } from "../src/shared/q_shared";
import type { KexEdictT, KexGameExports, KexGameImports, KexTraceT } from "../src/kexapi/game";
import { GAME_API_VERSION, ContentsT, SvflagsT, SolidT, WaterLevelT } from "../src/kexapi/game";
import {
  type EdictT,
  MonsterAiFlagsT,
  EntFlagsT,
  SPAWNFLAG_MONSTER_SUPER_STEP,
} from "../src/kexgame/g_local";
import {
  defaultEdict,
  gi,
  game,
  level,
  g_edicts,
  SetGameImports,
  SetGameExports,
  SetGEdicts,
} from "../src/kexgame/g_main_globals";
import { Gtime_from_ms, Gtime_from_sec, Gtime_add } from "../src/kexgame/gtime";
import {
  M_CheckBottom_Fast_Generic,
  M_CheckBottom_Slow_Generic,
  M_ChangeYaw,
  M_walkmove,
  M_MoveToGoal,
  __setM_CheckGroundForTests,
  __setM_CatagorizePositionForTests,
} from "../src/kexgame/m_move";

// ---------------------------------------------------------------------------
// fake KexGameImports / KexGameExports fixture (same shape as
// test/kexgame_g_phys.test.ts's own fixture)
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

type TraceImplT = (
  start: Vec3,
  mins: Vec3 | null,
  maxs: Vec3 | null,
  end: Vec3,
  passent: KexEdictT | null,
  mask: number,
) => KexTraceT;

let traceImpl: TraceImplT = (_start, _mins, _maxs, end) => noHitTrace(end);
let pointcontentsImpl: (point: Vec3) => number = () => 0;

function makeFakeGameImports(): KexGameImports {
  const cvars = new Map<string, CvarT>();
  function getCvar(name: string, value: string): CvarT {
    let c = cvars.get(name);
    if (c === undefined) {
      c = { name, string: value, value: Number(value), modified: false } as CvarT;
      cvars.set(name, c);
    }
    return c;
  }

  return {
    tick_rate: 10,
    frame_time_s: 0.1,
    frame_time_ms: 100,
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
    // Always empty: none of this file's tests spawn a "bad_area" trigger,
    // so CheckForBadArea's real gi.BoxEdicts-backed implementation
    // (m_move.ts) always returns null here, exactly like a level with no
    // active tesla mines.
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

/** Preallocates blank edicts and wires up gi/globals/g_edicts/game/level;
 *  also resets the M_CheckGround/M_CatagorizePosition test seams to safe,
 *  inert defaults (dry ground everywhere, no groundentity change) so a test
 *  that doesn't care about them doesn't have to touch them. */
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
  level.time = Gtime_from_ms(5000);
  level.gravity = 800;

  traceImpl = (_start, _mins, _maxs, end) => noHitTrace(end);
  pointcontentsImpl = () => 0;

  __setM_CatagorizePositionForTests(() => ({ waterlevel: WaterLevelT.WATER_NONE, watertype: ContentsT.CONTENTS_NONE }));
  __setM_CheckGroundForTests((ent) => {
    ent.groundentity = g_edicts[0]!;
    ent.groundentity_linkcount = g_edicts[0]!.linkcount;
  });

  SetGameImports(makeFakeGameImports());
  SetGameExports(makeFakeGameExports(edicts, numEdicts));

  return { edicts };
}

/** A live, ground-walking monster with sane physics defaults. */
function makeMonster(index: number, classname = "monster_test"): EdictT {
  const e = g_edicts[index]!;
  e.inuse = true;
  e.classname = classname;
  e.svflags = SvflagsT.SVF_MONSTER;
  e.solid = SolidT.SOLID_BBOX;
  e.mins = vec3(-16, -16, -24);
  e.maxs = vec3(16, 16, 32);
  e.gravityVector = vec3(0, 0, -1);
  e.gravity = 1;
  e.health = 100;
  e.max_health = 100;
  e.yaw_speed = 20;
  return e;
}

// ---------------------------------------------------------------------------
// trace fakes
// ---------------------------------------------------------------------------

/** A world made of one flat floor at world Z `floorZ`: any box trace whose
 *  bottom (origin.z + mins.z) would cross below `floorZ` gets clipped there;
 *  everything else (including all-horizontal moves, since flat ground never
 *  obstructs horizontal motion in these tests) passes through untouched. */
function makeFlatFloorTrace(floorZ: number): TraceImplT {
  return (start, mins, _maxs, end) => {
    const bottomOffset = mins ? mins[2] : 0;
    const startBottom = start[2] + bottomOffset;
    const endBottom = end[2] + bottomOffset;

    if (endBottom < floorZ) {
      const totalDz = startBottom - endBottom;
      const fraction = totalDz > 0 ? Math.max(0, Math.min(1, (startBottom - floorZ) / totalDz)) : 0;
      const endpos = vec3(
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction,
        start[2] + (end[2] - start[2]) * fraction,
      );
      const plane = new CplaneT();
      plane.normal = vec3(0, 0, 1);
      return {
        allsolid: false,
        startsolid: startBottom < floorZ,
        fraction,
        endpos,
        plane,
        surface: null,
        contents: ContentsT.CONTENTS_SOLID,
        ent: null,
        plane2: new CplaneT(),
        surface2: null,
      };
    }

    return noHitTrace(end);
  };
}

/** Like makeFlatFloorTrace, but the floor only exists for headings the
 *  caller allows -- used to drive SV_NewChaseDir's direction preference
 *  deterministically. "Heading" is measured from `origin` to the trace's
 *  own start point (a box trace's start already encodes which direction the
 *  caller walked to get there), not from the trace's own start/end delta,
 *  since vertical step-down probes have near-zero horizontal delta. */
function makeChaseDirTrace(origin: Vec3, allowedYawDeg: number, toleranceDeg: number): TraceImplT {
  const flat = makeFlatFloorTrace(-24);
  const noFloor = makeFlatFloorTrace(-1_000_000);

  function angleDelta(a: number, b: number): number {
    let d = (a - b) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  return (start, mins, maxs, end, passent, mask) => {
    const dx = start[0] - origin[0];
    const dy = start[1] - origin[1];
    if (Math.hypot(dx, dy) > 0.5) {
      const yawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (Math.abs(angleDelta(yawDeg, allowedYawDeg)) > toleranceDeg) {
        return noFloor(start, mins, maxs, end, passent, mask);
      }
    }
    return flat(start, mins, maxs, end, passent, mask);
  };
}

// ---------------------------------------------------------------------------
// M_ChangeYaw (m_move.cpp:919-958)
// ---------------------------------------------------------------------------

describe("M_ChangeYaw", () => {
  test("clamps a positive turn to yaw_speed / (tick_rate/10)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.s.angles[1] = 0; // YAW
    e.ideal_yaw = 90;
    e.yaw_speed = 30; // speed = 30 / (10/10) = 30
    M_ChangeYaw(e);
    expect(e.s.angles[1]).toBeCloseTo(30);
  });

  test("clamps a negative turn to -yaw_speed / (tick_rate/10)", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.s.angles[1] = 90;
    e.ideal_yaw = 0;
    e.yaw_speed = 30;
    M_ChangeYaw(e);
    // move = 0 - 90 = -90, clamped to -30
    expect(e.s.angles[1]).toBeCloseTo(60);
  });

  test("takes the short way across the 0/360 wrap instead of the long way", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.s.angles[1] = 350;
    e.ideal_yaw = 10;
    e.yaw_speed = 1000; // effectively unclamped for this small a move
    M_ChangeYaw(e);
    // ideal(10) < current(350) -> move = 10-350 = -340 <= -180 -> +360 = 20
    // (the "long way" would have been -340 degrees; the short way is +20)
    expect(e.s.angles[1]).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// M_CheckBottom_Fast_Generic (m_move.cpp:20-41)
// ---------------------------------------------------------------------------

describe("M_CheckBottom_Fast_Generic", () => {
  test("all four corners solid -> true, without ever calling gi.trace", () => {
    setupWorld(1);
    pointcontentsImpl = () => ContentsT.CONTENTS_SOLID;
    traceImpl = () => {
      throw new Error("gi.trace should not be called on the fast-path success case");
    };
    const absmins = vec3(-16, -16, -24);
    const absmaxs = vec3(16, 16, 32);
    expect(M_CheckBottom_Fast_Generic(absmins, absmaxs, false)).toBe(true);
  });

  test("any corner not solid -> false", () => {
    setupWorld(1);
    let calls = 0;
    pointcontentsImpl = () => {
      calls++;
      // the 3rd corner probed (x=1,y=0) is empty
      return calls === 3 ? 0 : ContentsT.CONTENTS_SOLID;
    };
    const absmins = vec3(-16, -16, -24);
    const absmaxs = vec3(16, 16, 32);
    expect(M_CheckBottom_Fast_Generic(absmins, absmaxs, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M_CheckBottom_Slow_Generic (m_move.cpp:43-129)
// ---------------------------------------------------------------------------

describe("M_CheckBottom_Slow_Generic", () => {
  const origin = vec3(0, 0, 0);
  const mins = vec3(-16, -16, -24);
  const maxs = vec3(16, 16, 32);

  test("[Paril-KEX] allow_any_step_height accepts on the mid-point trace alone, skipping quadrants", () => {
    setupWorld(1);
    const ent = makeMonster(1);
    let traceCalls = 0;
    traceImpl = (_start, _m, _mx, end) => {
      traceCalls++;
      // the mid-point trace finds a floor far below STEPSIZE(18) -- would
      // fail the quadrant check, but allow_any_step_height skips it.
      return { ...noHitTrace(end), fraction: 0.5, endpos: vec3(end[0], end[1], -500) };
    };
    const result = M_CheckBottom_Slow_Generic(origin, mins, maxs, ent, ContentsT.CONTENTS_SOLID, false, true);
    expect(result).toBe(true);
    expect(traceCalls).toBe(1);
  });

  test("mid-point trace with no floor at all -> false", () => {
    setupWorld(1);
    const ent = makeMonster(1);
    traceImpl = (_start, _m, _mx, end) => noHitTrace(end); // fraction 1 == no floor
    expect(M_CheckBottom_Slow_Generic(origin, mins, maxs, ent, ContentsT.CONTENTS_SOLID, false, false)).toBe(false);
  });

  test("all four quadrant corners within STEPSIZE of the mid-point -> true", () => {
    setupWorld(1);
    const ent = makeMonster(1);
    let call = 0;
    traceImpl = (_start, _m, _mx, end) => {
      call++;
      // call 1: mid-point trace, lands at z=-30. calls 2-5: quadrant
      // corners, each within STEPSIZE(18) of -30.
      const z = call === 1 ? -30 : -35;
      return { ...noHitTrace(end), fraction: 0.5, endpos: vec3(end[0], end[1], z) };
    };
    expect(M_CheckBottom_Slow_Generic(origin, mins, maxs, ent, ContentsT.CONTENTS_SOLID, false, false)).toBe(true);
  });

  test("one quadrant corner farther than STEPSIZE from the mid-point -> false", () => {
    setupWorld(1);
    const ent = makeMonster(1);
    let call = 0;
    traceImpl = (_start, _m, _mx, end) => {
      call++;
      const z = call === 1 ? -30 : call === 3 ? -80 : -35; // 3rd quadrant corner is 50 units off
      return { ...noHitTrace(end), fraction: 0.5, endpos: vec3(end[0], end[1], z) };
    };
    expect(M_CheckBottom_Slow_Generic(origin, mins, maxs, ent, ContentsT.CONTENTS_SOLID, false, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SV_movestep (m_move.cpp:613-885), reached via M_walkmove
// ---------------------------------------------------------------------------

describe("SV_movestep via M_walkmove -- ground monster", () => {
  test("flat-ground advance: a normal step succeeds and moves the entity forward", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.s.origin = vec3(0, 0, 0); // feet (origin+mins.z) sit exactly at world Z -24
    e.groundentity = g_edicts[0]!;
    pointcontentsImpl = (p) => (p[2] <= -24 ? ContentsT.CONTENTS_SOLID : 0);
    traceImpl = makeFlatFloorTrace(-24);

    const moved = M_walkmove(e, 0 /* east */, 10);

    expect(moved).toBe(true);
    expect(e.s.origin[0]).toBeCloseTo(10, 1);
    expect(e.groundentity).not.toBeNull();
  });

  test("dropoff rejection: the step-down probe finds no floor at all -> move refused, origin unchanged", () => {
    setupWorld(1);
    const e = makeMonster(1);
    e.s.origin = vec3(0, 0, 0);
    e.groundentity = g_edicts[0]!;
    pointcontentsImpl = () => 0; // nothing solid anywhere
    traceImpl = makeFlatFloorTrace(-1_000_000); // no floor within any reasonable probe distance

    const before = vec3(e.s.origin[0], e.s.origin[1], e.s.origin[2]);
    const moved = M_walkmove(e, 0, 10);

    expect(moved).toBe(false);
    expect(e.s.origin[0]).toBeCloseTo(before[0]);
    expect(e.s.origin[1]).toBeCloseTo(before[1]);
    expect(e.s.origin[2]).toBeCloseTo(before[2]);
  });
});

// ---------------------------------------------------------------------------
// SV_flystep (m_move.cpp:443-599), reached via M_walkmove -- water monster
// ---------------------------------------------------------------------------

describe("SV_movestep via M_walkmove -- FL_SWIM monster (m_move.cpp:557-567)", () => {
  test("refuses to leave water: target point isn't wet -> move rejected", () => {
    setupWorld(1);
    const e = makeMonster(1, "monster_gekk");
    e.flags = EntFlagsT.FL_SWIM;
    e.waterlevel = WaterLevelT.WATER_FEET; // < WATER_WAIST
    e.s.origin = vec3(0, 0, 0);
    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end); // move itself is unobstructed
    pointcontentsImpl = () => 0; // but the target point is dry

    const before = vec3(e.s.origin[0], e.s.origin[1], e.s.origin[2]);
    const moved = M_walkmove(e, 0, 10);

    expect(moved).toBe(false);
    expect(e.s.origin[0]).toBeCloseTo(before[0]);
  });

  test("stays wet -> move completes normally", () => {
    setupWorld(1);
    const e = makeMonster(1, "monster_gekk");
    e.flags = EntFlagsT.FL_SWIM;
    e.waterlevel = WaterLevelT.WATER_FEET;
    e.s.origin = vec3(0, 0, 0);
    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end);
    pointcontentsImpl = () => ContentsT.CONTENTS_WATER;

    const moved = M_walkmove(e, 0, 10);

    expect(moved).toBe(true);
    expect(e.s.origin[0]).toBeCloseTo(10, 1);
  });
});

// ---------------------------------------------------------------------------
// SV_flystep's enemy-height-adjust branch (m_move.cpp:466-538)
// ---------------------------------------------------------------------------

describe("SV_flystep via M_walkmove -- FL_FLY monster adjusts height toward its enemy", () => {
  test("climbs toward a higher enemy, halving the horizontal component", () => {
    setupWorld(1);
    const e = makeMonster(1, "monster_flyer");
    e.flags = EntFlagsT.FL_FLY;
    e.s.origin = vec3(0, 0, 0);
    e.waterlevel = WaterLevelT.WATER_NONE;

    const enemy = g_edicts[2]!;
    enemy.inuse = true;
    enemy.s.origin = vec3(500, 0, 100); // 100 units higher
    e.enemy = enemy;

    traceImpl = (_s, _mn, _mx, end) => noHitTrace(end); // fully unobstructed
    pointcontentsImpl = () => 0; // no water anywhere

    const moved = M_walkmove(e, 0 /* east, dist=10 -> move=(10,0,0) */, 10);

    expect(moved).toBe(true);
    // dz = 0 - 100 = -100 < 0 -> newMove *= 0.5; newMove.z += -max(-dist, dz)
    //   = -max(-10, -100) = 10
    expect(e.s.origin[0]).toBeCloseTo(5, 1); // horizontal halved
    expect(e.s.origin[2]).toBeCloseTo(10, 1); // climbed toward the enemy
  });
});

// ---------------------------------------------------------------------------
// SV_NewChaseDir (m_move.cpp:1034-1144), reached via M_MoveToGoal
// ---------------------------------------------------------------------------

describe("SV_NewChaseDir via M_MoveToGoal -- direction preference order", () => {
  test("tries the direct diagonal route before anything else", () => {
    setupWorld(2);
    // "monster_widow" bypasses SV_StepDirection's FacingIdeal check
    // (m_move.cpp:994, strncmp(...,"monster_widow",13)) -- see this file's
    // header for why: FacingIdeal is a g_ai.ts stub not landed yet.
    const e = makeMonster(1, "monster_widow");
    e.s.origin = vec3(0, 0, 0);
    e.groundentity = g_edicts[0]!;
    e.ideal_yaw = 200; // the "bump around" initial attempt; deliberately blocked below

    const goal = g_edicts[2]!;
    goal.inuse = true;
    goal.classname = "target_goal";
    goal.s.origin = vec3(1000, 1000, 0); // deltax>10, deltay>10 -> direct tdir=45
    e.goalentity = goal;

    // far future, so M_MoveToGoal's own "straight shot" block (which would
    // call the FacingIdeal stub directly, not through SV_StepDirection) is
    // skipped entirely.
    e.monsterinfo.bad_move_time = Gtime_add(level.time, Gtime_from_sec(100));

    pointcontentsImpl = (p) => (p[2] <= -24 ? ContentsT.CONTENTS_SOLID : 0);
    // only headings within 10 degrees of 45 (the direct diagonal route)
    // have any floor; every other heading -- including 200, the initial
    // "bump around" attempt, and every SV_NewChaseDir fallback candidate
    // except the direct route -- walks off into a bottomless pit.
    traceImpl = makeChaseDirTrace(vec3(0, 0, 0), 45, 10);

    M_MoveToGoal(e, 10);

    // proves the direct route (45 degrees) was the one that actually
    // succeeded, before any of SV_NewChaseDir's later fallback candidates
    // (whose ordering depends on brandom()) were ever tried.
    expect(e.ideal_yaw).toBeCloseTo(45);
    expect(e.s.origin[0]).toBeGreaterThan(0);
    expect(e.s.origin[1]).toBeGreaterThan(0);
    expect(e.s.origin[0]).toBeCloseTo(e.s.origin[1], 1); // pure 45-degree diagonal
  });

  test("on a fully blocked map, exhausts every candidate down to the turnaround fallback", () => {
    setupWorld(2);
    const e = makeMonster(1, "monster_widow");
    e.s.origin = vec3(0, 0, 0);
    e.groundentity = g_edicts[0]!;
    e.ideal_yaw = 0; // olddir=0, turnaround=anglemod(0-180)=180

    const goal = g_edicts[2]!;
    goal.inuse = true;
    goal.classname = "target_goal";
    goal.s.origin = vec3(1000, 1000, 0); // direct route tdir=45 (also blocked here)
    e.goalentity = goal;

    e.monsterinfo.bad_move_time = Gtime_add(level.time, Gtime_from_sec(100));

    pointcontentsImpl = (p) => (p[2] <= -24 ? ContentsT.CONTENTS_SOLID : 0);
    // every heading is a dropoff except due west (180, the turnaround) --
    // the direct route, both individual axis attempts, olddir, and all 8
    // compass-sweep directions are blocked identically regardless of which
    // order SV_NewChaseDir's internal brandom() calls try them in, so this
    // is deterministic: only the final turnaround fallback can succeed.
    traceImpl = makeChaseDirTrace(vec3(0, 0, 0), 180, 10);

    M_MoveToGoal(e, 10);

    expect(e.ideal_yaw).toBeCloseTo(180);
    expect(e.s.origin[0]).toBeLessThan(0);
    expect(e.s.origin[1]).toBeCloseTo(0, 1);
  });
});
