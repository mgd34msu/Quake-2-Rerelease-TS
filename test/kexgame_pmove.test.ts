// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Tests for src/kexgame/p_move.ts (KEX Pmove) and G_FixStuckObject_Generic.
// Each test cites the exact C++ behavior in
// ~/Projects/quake2-rerelease-dll/rerelease/p_move.cpp it pins.

import { describe, expect, test } from "bun:test";
import { vec3, type Vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";
import { Pmove, G_FixStuckObject_Generic } from "../src/kexgame/p_move";
import type { PmConfigT } from "../src/kexgame/bg_local";
import { StuckResultT } from "../src/kexgame/g_local";
import {
  type KexPmoveT,
  type KexPmoveStateT,
  type KexUsercmdT,
  type KexTraceT,
  type KexEdictT,
  type KexEntityStateT,
  type SvEntityT,
  type Vec4,
  ContentsT,
  WaterLevelT,
  KexPmTypeT,
  PmflagsT,
  ButtonT,
  KexEntityEventT,
  SolidT,
  MAX_ITEMS,
} from "../src/kexapi/game";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully-populated, inert stand-in for a real server-side edict, used only
 *  so `trace.ent` / `pm.groundentity` can be a real truthy `KexEdictT` in
 *  tests that need "am I standing on something" (p_move.cpp:1014
 *  `pm->groundentity = trace.ent;`) to actually read as grounded. */
function makeFixtureEdict(number: number): KexEdictT {
  const s: KexEntityStateT = {
    number,
    origin: vec3(),
    angles: vec3(),
    old_origin: vec3(),
    modelindex: 0,
    modelindex2: 0,
    modelindex3: 0,
    modelindex4: 0,
    frame: 0,
    skinnum: 0,
    effects: 0n,
    renderfx: 0,
    solid: 0,
    sound: 0,
    event: KexEntityEventT.EV_NONE,
    alpha: 0,
    scale: 0,
    instance_bits: 0,
    loop_volume: 0,
    loop_attenuation: 0,
    owner: 0,
    old_frame: 0,
  };
  const sv: SvEntityT = {
    init: false,
    ent_flags: 0n,
    buttons: ButtonT.BUTTON_NONE,
    spawnflags: 0,
    item_id: 0,
    armor_type: 0,
    armor_value: 0,
    health: 0,
    max_health: 0,
    starting_health: 0,
    weapon: 0,
    team: 0,
    lobby_usernum: 0,
    respawntime: 0,
    viewheight: 0,
    last_attackertime: 0,
    waterlevel: WaterLevelT.WATER_NONE,
    viewangles: vec3(),
    viewforward: vec3(),
    velocity: vec3(),
    start_origin: vec3(),
    end_origin: vec3(),
    enemy: null,
    ground_entity: null,
    classname: null,
    targetname: null,
    netname: "",
    inventory: new Int32Array(MAX_ITEMS),
    armor_info: [],
  };
  return {
    s,
    client: null,
    sv,
    inuse: true,
    linked: true,
    linkcount: 0,
    areanum: 0,
    areanum2: 0,
    svflags: 0,
    mins: vec3(),
    maxs: vec3(),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid: SolidT.SOLID_BSP,
    clipmask: 0,
    owner: null,
  };
}

const WORLD_EDICT = makeFixtureEdict(0);

function makeOpenTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(end[0], end[1], end[2]),
    plane: new CplaneT(),
    surface: null,
    contents: ContentsT.CONTENTS_NONE,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

/** Fabricated trace shape used to wire up `KexPmoveT.trace`/`.clip`; richer
 *  than bg_local.ts's `PmTraceFn` seam (adds the content mask) purely so test
 *  fixtures can distinguish "ladder probe" queries (p_move.cpp:1128, the only
 *  call site in the whole file that passes `CONTENTS_LADDER` explicitly). */
type FixtureTraceFn = (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, mask: ContentsT) => KexTraceT;

/** Flat, infinite floor at `floorZ` with normal straight up (0,0,1);
 *  everything else open. Mirrors PM_CatagorizePosition's downward probe
 *  (p_move.cpp:977-991: `point = origin; point.z -= 0.25;`) -- a trace whose
 *  start/end share (x, y) and whose end crosses `floorZ` from above reports a
 *  ground hit; every other query (duck-clearance checks, ladder probes,
 *  step-slide horizontal moves) is open space. */
function makeFlatGroundTrace(floorZ: number, groundEnt: KexEdictT | null = WORLD_EDICT): FixtureTraceFn {
  return (start, _mins, _maxs, end) => {
    const tr = makeOpenTrace(end);
    if (start[0] === end[0] && start[1] === end[1] && end[2] <= floorZ && start[2] >= floorZ - 0.01) {
      tr.fraction = 0.5;
      tr.endpos = vec3(end[0], end[1], floorZ);
      tr.plane.normal[2] = 1;
      tr.ent = groundEnt;
    }
    return tr;
  };
}

/** Open everywhere except a ladder plane 1 unit in front of the player along
 *  +X, only reported to queries that actually pass `CONTENTS_LADDER`
 *  (p_move.cpp:1128 `PM_Trace(pml.origin, pm->mins, pm->maxs, spot,
 *  CONTENTS_LADDER)`). */
function makeLadderTrace(): FixtureTraceFn {
  return (start, _mins, _maxs, end, mask) => {
    const tr = makeOpenTrace(end);
    if (mask & ContentsT.CONTENTS_LADDER) {
      tr.fraction = 0.5;
      tr.contents = ContentsT.CONTENTS_LADDER;
      tr.plane.normal[0] = -1;
      tr.endpos = vec3(start[0] + (end[0] - start[0]) * 0.5, start[1], start[2]);
    }
    return tr;
  };
}

function makePmoveState(overrides: Partial<KexPmoveStateT> = {}): KexPmoveStateT {
  return {
    pm_type: KexPmTypeT.PM_NORMAL,
    origin: vec3(0, 0, 0),
    velocity: vec3(0, 0, 0),
    pm_flags: PmflagsT.PMF_NONE,
    pm_time: 0,
    gravity: 800,
    delta_angles: vec3(0, 0, 0),
    viewheight: 0,
    ...overrides,
  };
}

function makeUsercmd(overrides: Partial<KexUsercmdT> = {}): KexUsercmdT {
  return {
    msec: 100,
    buttons: ButtonT.BUTTON_NONE,
    angles: vec3(0, 0, 0),
    forwardmove: 0,
    sidemove: 0,
    server_frame: 0,
    ...overrides,
  };
}

function makePmove(options: {
  state?: Partial<KexPmoveStateT>;
  cmd?: Partial<KexUsercmdT>;
  traceFn?: FixtureTraceFn;
  pointcontents?: (point: Vec3) => ContentsT;
  snapinitial?: boolean;
} = {}): KexPmoveT {
  const traceFn = options.traceFn ?? ((_s, _mi, _ma, end) => makeOpenTrace(end));
  const pointFn = options.pointcontents ?? (() => ContentsT.CONTENTS_NONE);

  return {
    s: makePmoveState(options.state),
    cmd: makeUsercmd(options.cmd),
    snapinitial: options.snapinitial ?? false,
    touch: { num: 0, traces: [] },
    viewangles: vec3(0, 0, 0),
    mins: vec3(-16, -16, -24),
    maxs: vec3(16, 16, 32),
    groundentity: null,
    groundplane: new CplaneT(),
    watertype: ContentsT.CONTENTS_NONE,
    waterlevel: WaterLevelT.WATER_NONE,
    player: null,
    trace: (start, mins, maxs, end, _passent, mask) => traceFn(start, mins ?? vec3(), maxs ?? vec3(), end, mask),
    clip: (start, mins, maxs, end, mask) => traceFn(start, mins ?? vec3(), maxs ?? vec3(), end, mask),
    pointcontents: pointFn,
    viewoffset: vec3(0, 0, 0),
    screen_blend: new Float32Array(4) as Vec4,
    rdflags: 0,
    jump_sound: false,
    step_clip: false,
    impact_delta: 0,
  };
}

// ---------------------------------------------------------------------------
// Pmove
// ---------------------------------------------------------------------------

describe("Pmove — stationary on flat ground", () => {
  test("standing still with no input stays exactly put (p_move.cpp:897-912)", () => {
    // PM_AirMove's "walking on ground" branch zeroes velocity.z, and since
    // wishvel is zero (no input) it returns before ever calling
    // PM_StepSlideMove: "if (!pml.velocity[0] && !pml.velocity[1]) return;"
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1) },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm);

    expect(pm.s.origin[0]).toBeCloseTo(0, 5);
    expect(pm.s.origin[1]).toBeCloseTo(0, 5);
    expect(pm.s.origin[2]).toBeCloseTo(0.1, 5);
    expect(pm.groundentity).not.toBeNull();
  });
});

describe("Pmove — gravity", () => {
  test("an airborne pmove's Z velocity decreases every frame (p_move.cpp:921-923)", () => {
    // PM_AirMove, "not on ground" branch: `pml.velocity[2] -= pm->s.gravity * pml.frametime;`
    const pm = makePmove({
      state: { origin: vec3(0, 0, 10000), gravity: 800 },
      traceFn: makeFlatGroundTrace(-100000), // never touches ground
    });

    let lastVz = pm.s.velocity[2];
    for (let frame = 0; frame < 5; frame++) {
      Pmove(pm);
      expect(pm.s.velocity[2]).toBeLessThan(lastVz);
      lastVz = pm.s.velocity[2];
    }
  });
});

describe("Pmove — jump", () => {
  test("jumping from the ground sets velocity.z to exactly the 270 constant (p_move.cpp:1098-1102)", () => {
    // gravity=0 isolates the JUMP_HEIGHT constant from the same-frame gravity
    // integration that PM_AirMove applies right after PM_CheckJump runs.
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1), gravity: 0 },
      cmd: { buttons: ButtonT.BUTTON_JUMP },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm);

    expect(pm.s.velocity[2]).toBe(270);
    expect(pm.s.pm_flags & PmflagsT.PMF_JUMP_HELD).toBeTruthy();
  });

  test("holding jump does not re-add the impulse every frame (PMF_JUMP_HELD, p_move.cpp:1078-1079)", () => {
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1), gravity: 0 },
      cmd: { buttons: ButtonT.BUTTON_JUMP },
      traceFn: makeFlatGroundTrace(-100000), // stays airborne once jumped, so groundentity does not re-arm PMF_JUMP_HELD
    });

    Pmove(pm);
    const afterFirstJump = pm.s.velocity[2];
    Pmove(pm);

    expect(pm.s.velocity[2]).toBe(afterFirstJump);
  });
});

describe("Pmove — landing transitions (PM_CatagorizePosition, p_move.cpp:1023-1047)", () => {
  test("a fast upward-moving landing on a flat, non-ducked, non-n64 surface sets PMF_TIME_TRICK for 64ms (p_move.cpp:1028-1032)", () => {
    // msec=10 (< the 64ms trick window) so the "drop timing counter" block
    // later in the same Pmove() call (p_move.cpp:1649-1658, `pm->s.pm_time
    // -= pm->cmd.msec`) does not immediately consume the flag it just set --
    // see the next test for that countdown mechanic pinned directly.
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1), velocity: vec3(0, 0, 150), gravity: 0, pm_flags: PmflagsT.PMF_NONE },
      cmd: { msec: 10 },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm);

    expect(pm.s.pm_flags & PmflagsT.PMF_TIME_TRICK).toBeTruthy();
    expect(pm.s.pm_time).toBe(64 - 10);
  });

  test("landing while already ducked sets PMF_TIME_LAND for 128ms, then the same frame's countdown consumes cmd.msec of it (p_move.cpp:1042-1046, 1649-1658)", () => {
    const config: PmConfigT = { airaccel: 0, n64_physics: false };
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1), velocity: vec3(0, 0, 0), gravity: 0, pm_flags: PmflagsT.PMF_DUCKED },
      cmd: { buttons: ButtonT.BUTTON_CROUCH, msec: 100 },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm, config);

    expect(pm.s.pm_flags & PmflagsT.PMF_TIME_LAND).toBeTruthy();
    expect(pm.s.pm_flags & PmflagsT.PMF_TIME_TRICK).toBeFalsy();
    // set to 128 by PM_CatagorizePosition, then p_move.cpp:1657
    // (`pm->s.pm_time -= pm->cmd.msec;`) subtracts this frame's 100ms.
    expect(pm.s.pm_time).toBe(128 - 100);
  });

  test("n64_physics landings always set PMF_TIME_LAND, even when not ducked (p_move.cpp:1042, pm_config.n64_physics)", () => {
    const config: PmConfigT = { airaccel: 0, n64_physics: true };
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1), velocity: vec3(0, 0, 0), gravity: 0, pm_flags: PmflagsT.PMF_NONE },
      cmd: { msec: 100 },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm, config);

    expect(pm.s.pm_flags & PmflagsT.PMF_TIME_LAND).toBeTruthy();
    expect(pm.s.pm_time).toBe(128 - 100);
  });
});

describe("Pmove — ducking (PM_CheckDuck / PM_SetDimensions, p_move.cpp:1310-1418)", () => {
  test("holding crouch while grounded shrinks maxs.z to 4 and sets viewheight to -2 (p_move.cpp:1328-1332)", () => {
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1) },
      cmd: { buttons: ButtonT.BUTTON_CROUCH },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm);

    expect(pm.maxs[2]).toBe(4);
    expect(pm.s.viewheight).toBe(-2);
    expect(pm.s.pm_flags & PmflagsT.PMF_DUCKED).toBeTruthy();
  });

  test("n64_physics disables ducking even while crouch is held and grounded (p_move.cpp:1380-1384, `!pm_config.n64_physics`)", () => {
    const config: PmConfigT = { airaccel: 0, n64_physics: true };
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0.1) },
      cmd: { buttons: ButtonT.BUTTON_CROUCH },
      traceFn: makeFlatGroundTrace(0),
    });

    Pmove(pm, config);

    expect(pm.maxs[2]).toBe(32);
    expect(pm.s.pm_flags & PmflagsT.PMF_DUCKED).toBeFalsy();
  });
});

describe("Pmove — ladder detection (PM_CheckSpecialMovement, p_move.cpp:1121-1130)", () => {
  test("a CONTENTS_LADDER hit directly ahead sets PMF_ON_LADDER", () => {
    const pm = makePmove({
      state: { origin: vec3(0, 0, 0), gravity: 0 }, // gravity=0 short-circuits the waterjump code that follows
      traceFn: makeLadderTrace(),
    });

    Pmove(pm);

    expect(pm.s.pm_flags & PmflagsT.PMF_ON_LADDER).toBeTruthy();
  });
});

describe("Pmove — water levels (PM_GetWaterLevel, p_move.cpp:929-961)", () => {
  // origin.z = 100, standing (mins.z=-24, viewheight=22 -> sample2=46,
  // sample1=23): feet sample at z=77, waist sample at z=99, under sample at
  // z=122 (see PM_GetWaterLevel's own citation in p_move.ts). gravity=0
  // isolates the sampling geometry from gravity integration; the small
  // water-drift PM_WaterMove itself applies when airborne with no input
  // (p_move.cpp:805-806, wishvel.z -= 60) is well inside the >=10-unit
  // margin between each threshold below.
  function waterPm(waterSurfaceZ: number): KexPmoveT {
    return makePmove({
      state: { origin: vec3(0, 0, 100), gravity: 0 },
      traceFn: (_s, _mi, _ma, end) => makeOpenTrace(end), // no floor anywhere
      pointcontents: (point) => (point[2] < waterSurfaceZ ? ContentsT.CONTENTS_WATER : ContentsT.CONTENTS_NONE),
    });
  }

  test("dry everywhere -> WATER_NONE", () => {
    const pm = waterPm(0);
    Pmove(pm);
    expect(pm.waterlevel).toBe(WaterLevelT.WATER_NONE);
  });

  test("wet at the feet sample only -> WATER_FEET", () => {
    const pm = waterPm(85);
    Pmove(pm);
    expect(pm.waterlevel).toBe(WaterLevelT.WATER_FEET);
  });

  test("wet at feet and waist samples -> WATER_WAIST", () => {
    const pm = waterPm(110);
    Pmove(pm);
    expect(pm.waterlevel).toBe(WaterLevelT.WATER_WAIST);
  });

  test("wet at feet, waist, and the top sample -> WATER_UNDER", () => {
    const pm = waterPm(130);
    Pmove(pm);
    expect(pm.waterlevel).toBe(WaterLevelT.WATER_UNDER);
  });
});

describe("Pmove — spectator / noclip flight (PM_FlyMove, p_move.cpp:1213-1308)", () => {
  test("PM_SPECTATOR moves the origin forward and still clips against the world (doclip=true, p_move.cpp:1615)", () => {
    const pm = makePmove({
      state: { pm_type: KexPmTypeT.PM_SPECTATOR },
      cmd: { forwardmove: 400 },
    });

    Pmove(pm);

    expect(pm.s.origin[0]).toBeGreaterThan(0);
    expect(pm.s.origin[1]).toBeCloseTo(0, 5);
  });

  test("PM_NOCLIP moves the origin forward without any clipping (doclip=false, p_move.cpp:1303-1307)", () => {
    const pm = makePmove({
      state: { pm_type: KexPmTypeT.PM_NOCLIP },
      cmd: { forwardmove: 400 },
    });

    Pmove(pm);

    expect(pm.s.origin[0]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G_FixStuckObject_Generic (p_move.cpp:9-154)
// ---------------------------------------------------------------------------

describe("G_FixStuckObject_Generic", () => {
  const mins = vec3(-16, -16, -24);
  const maxs = vec3(16, 16, 32);

  test("returns GOOD_POSITION immediately when the starting spot is not solid (p_move.cpp:12-13)", () => {
    const origin = vec3(1, 2, 3);
    const result = G_FixStuckObject_Generic(origin, mins, maxs, (_s, _mi, _ma, end) => makeOpenTrace(end));

    expect(result).toBe(StuckResultT.GOOD_POSITION);
    expect(origin[0]).toBe(1);
    expect(origin[1]).toBe(2);
    expect(origin[2]).toBe(3);
  });

  test("nudges a stuck origin to a clear side and returns FIXED", () => {
    // "Stuck" is modeled as: solid only exactly at the original origin;
    // every probe offset by the bbox half-extents (all six side checks) is
    // clear, so every side succeeds and the FIXED result is the first side
    // (+Z) nudged by the algorithm's fixed 0.125-unit push-away
    // (p_move.cpp:122-124).
    const origin = vec3(5, 5, 5);
    const trace = (start: Vec3, end: Vec3): KexTraceT => {
      const tr = makeOpenTrace(end);
      const dx = start[0] - origin[0];
      const dy = start[1] - origin[1];
      const dz = start[2] - origin[2];
      tr.startsolid = Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001 && Math.abs(dz) < 0.001;
      return tr;
    };

    const result = G_FixStuckObject_Generic(origin, mins, maxs, (start, _mi, _ma, end) => trace(start, end));

    expect(result).toBe(StuckResultT.FIXED);
    expect(origin[0]).toBeCloseTo(5, 5);
    expect(origin[1]).toBeCloseTo(5, 5);
    expect(origin[2]).toBeCloseTo(5.125, 5);
  });

  test("returns NO_GOOD_POSITION when every probe is solid (p_move.cpp:144-153 tail)", () => {
    const origin = vec3(0, 0, 0);
    const result = G_FixStuckObject_Generic(origin, mins, maxs, (_s, _mi, _ma, end) => {
      const tr = makeOpenTrace(end);
      tr.startsolid = true;
      return tr;
    });

    expect(result).toBe(StuckResultT.NO_GOOD_POSITION);
  });
});
