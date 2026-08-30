import { describe, expect, test } from "bun:test";
import { Pmove } from "../src/qcommon/pmove";
import { PmoveT, TraceT, CplaneT, PmTypeT, PMF_DUCKED, PMF_ON_GROUND } from "../src/shared/q_shared";
import { type Vec3, VectorCopy } from "../src/shared/math";

// A stub world: open space, nothing solid (fraction 1, no plane hit), optionally
// with a flat floor directly underfoot so PM_CatagorizePosition reports ground.
function makeStubTrace(grounded: boolean): (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceT {
  return (_start, _mins, _maxs, end) => {
    const t = new TraceT();
    t.allsolid = false;
    t.startsolid = false;
    t.fraction = 1;
    VectorCopy(end, t.endpos);
    t.plane = new CplaneT();
    t.plane.normal[2] = 1;
    t.surface = null;
    t.contents = 0;
    t.ent = grounded ? {} : null;
    return t;
  };
}

function stubPointcontents(): number {
  return 0; // CONTENTS_EMPTY
}

function newPmove(grounded: boolean): PmoveT {
  const pm = new PmoveT();
  pm.trace = makeStubTrace(grounded);
  pm.pointcontents = stubPointcontents;
  return pm;
}

describe("Pmove — spectator flight", () => {
  test("moves origin in the commanded direction", () => {
    const pm = newPmove(false);
    pm.s.pm_type = PmTypeT.PM_SPECTATOR;
    pm.cmd.forwardmove = 400;
    pm.cmd.msec = 100;

    Pmove(pm);

    // forward at zero view angles is +X; origin is stored in 1/8 units.
    expect(pm.s.origin[0]).toBeGreaterThan(0);
    expect(pm.s.origin[1]).toBe(0);
  });
});

describe("Pmove — PM_NORMAL gravity", () => {
  test("velocity z decreases across repeated frames while airborne", () => {
    const pm = newPmove(false);
    pm.s.pm_type = PmTypeT.PM_NORMAL;
    pm.s.gravity = 800;
    pm.cmd.msec = 100;

    let lastVz = pm.s.velocity[2];
    for (let frame = 0; frame < 5; frame++) {
      Pmove(pm);
      expect(pm.s.velocity[2]).toBeLessThan(lastVz);
      lastVz = pm.s.velocity[2];
    }
  });
});

describe("Pmove — duck", () => {
  test("sets PMF_DUCKED and lowers maxs when grounded and upmove < 0", () => {
    const pm = newPmove(true);
    pm.s.pm_type = PmTypeT.PM_NORMAL;
    pm.s.gravity = 800;
    pm.cmd.msec = 100;

    // frame 1: establish PMF_ON_GROUND via PM_CatagorizePosition
    Pmove(pm);
    expect(pm.s.pm_flags & PMF_ON_GROUND).not.toBe(0);
    expect(pm.s.pm_flags & PMF_DUCKED).toBe(0);
    expect(pm.maxs[2]).toBe(32);

    // frame 2: hold duck while grounded
    pm.cmd.upmove = -10;
    Pmove(pm);

    expect(pm.s.pm_flags & PMF_DUCKED).not.toBe(0);
    expect(pm.maxs[2]).toBe(4);
  });
});

describe("Pmove — angle clamping", () => {
  test("clamps pitch to 89 or 271 degrees", () => {
    const pm = newPmove(false);
    pm.s.pm_type = PmTypeT.PM_NORMAL;
    // a large positive short angle maps (via SHORT2ANGLE) to a steep pitch
    pm.cmd.angles[0] = 20000;

    Pmove(pm);

    expect(pm.viewangles[0] === 89 || pm.viewangles[0] === 271).toBe(true);
  });
});

describe("Pmove — origin snapping", () => {
  test("round-trips within 0.125 units when stationary", () => {
    const pm = newPmove(true);
    pm.s.pm_type = PmTypeT.PM_NORMAL;
    pm.s.gravity = 800;
    pm.s.origin[0] = 80; // 10.0 world units, already 0.125-aligned
    pm.s.origin[1] = 0;
    pm.s.origin[2] = 0;
    pm.cmd.msec = 100;

    const before = [pm.s.origin[0], pm.s.origin[1], pm.s.origin[2]];
    Pmove(pm);

    for (let i = 0; i < 3; i++) {
      expect(Math.abs(pm.s.origin[i] * 0.125 - before[i] * 0.125)).toBeLessThanOrEqual(0.125);
    }
  });
});

describe("Pmove — stability", () => {
  test("no NaN in origin/velocity after 100 mixed-command frames", () => {
    const pm = newPmove(true);
    pm.s.pm_type = PmTypeT.PM_NORMAL;
    pm.s.gravity = 800;

    for (let frame = 0; frame < 100; frame++) {
      pm.cmd.msec = 50 + (frame % 5) * 10;
      pm.cmd.forwardmove = (frame % 7) * 100 - 300;
      pm.cmd.sidemove = (frame % 5) * 100 - 200;
      pm.cmd.upmove = frame % 3 === 0 ? -10 : frame % 3 === 1 ? 30 : 0;
      pm.cmd.angles[0] = (frame * 137) % 65536;
      pm.cmd.angles[1] = (frame * 271) % 65536;
      pm.snapinitial = frame % 20 === 0;

      Pmove(pm);

      for (let i = 0; i < 3; i++) {
        expect(Number.isNaN(pm.s.origin[i])).toBe(false);
        expect(Number.isNaN(pm.s.velocity[i])).toBe(false);
      }
    }
  });
});
