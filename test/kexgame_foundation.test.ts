// Unit tests for src/kexgame/{gtime,spawnflags,q_vec3,q_std}.ts — the
// foundation value types the rest of the 103k-line kex game port builds on.
// See src/kexgame/*.ts for provenance and deviations from the C++ source
// (~/Projects/quake2-rerelease-dll/rerelease/{g_local.h,q_vec3.h,q_std.h}).

import { describe, expect, test } from "bun:test";
import {
  type GTime,
  GTIME_ZERO,
  Gtime_from_ms,
  Gtime_from_sec,
  Gtime_from_min,
  Gtime_from_hz,
  Gtime_milliseconds,
  Gtime_seconds,
  Gtime_secondsInt,
  Gtime_minutes,
  Gtime_minutesInt,
  Gtime_frames,
  Gtime_nonzero,
  Gtime_negate,
  Gtime_add,
  Gtime_subtract,
  Gtime_scale,
  Gtime_divide,
} from "../src/kexgame/gtime";
import {
  type SpawnFlags,
  SPAWNFLAGS_NONE,
  SpawnFlags_from,
  SpawnFlags_value,
  SpawnFlags_any,
  SpawnFlags_none,
  SpawnFlags_has,
  SpawnFlags_has_all,
  SpawnFlags_not,
  SpawnFlags_or,
  SpawnFlags_and,
  SpawnFlags_xor,
} from "../src/kexgame/spawnflags";
import {
  vec3_origin,
  vec3_equals,
  vec3_equals_epsilon,
  vec3_not_equals,
  vec3_any_nonzero,
  vec3_dot,
  vec3_scaled,
  vec3_scale,
  vec3_sub,
  vec3_add,
  vec3_div,
  vec3_divs,
  vec3_muls,
  vec3_negate,
  vec3_subEq,
  vec3_addEq,
  vec3_divEq,
  vec3_divEqs,
  vec3_mulEqs,
  vec3_lengthSquared,
  vec3_length,
  vec3_normalized,
  vec3_normalized_len,
  vec3_normalize,
  vec3_cross,
  AngleVectors,
  AngleVectors_destructured,
  ClearBounds,
  AddPointToBounds,
  ProjectPointOnPlane,
  PerpendicularVector,
  RotatePointAroundVector,
  closest_point_to_box,
  distance_between_boxes,
  boxes_intersect,
  STOP_EPSILON,
  ClipVelocity,
  SlideClipVelocity,
  vectoyaw,
  vectoangles,
  G_ProjectSource,
  G_ProjectSource2,
  slerp,
} from "../src/kexgame/q_vec3";
import { vec3, type Vec3 } from "../src/shared/math";
import {
  frandom,
  crandom,
  crandom_open,
  irandom,
  brandom,
  random_index,
  random_element,
  clamp,
  lerp,
  Q_strlcpy,
  Q_strlcat,
} from "../src/kexgame/q_std";

// ===========================================================================
// gtime.ts
// ===========================================================================

describe("gtime — factories", () => {
  test("from_ms round-trips", () => {
    const t = Gtime_from_ms(1500);
    expect(Gtime_milliseconds(t)).toBe(1500);
  });

  test("from_ms truncates a fractional argument (mirrors int64_t narrowing)", () => {
    expect(Gtime_milliseconds(Gtime_from_ms(1500.9))).toBe(1500);
    expect(Gtime_milliseconds(Gtime_from_ms(-1500.9))).toBe(-1500);
  });

  test("from_sec converts seconds to milliseconds, truncated", () => {
    expect(Gtime_milliseconds(Gtime_from_sec(1.5))).toBe(1500);
    expect(Gtime_milliseconds(Gtime_from_sec(0.1234))).toBe(123); // trunc(123.4)
  });

  test("from_min converts minutes to milliseconds, truncated", () => {
    expect(Gtime_milliseconds(Gtime_from_min(2))).toBe(120000);
    expect(Gtime_milliseconds(Gtime_from_min(0.5))).toBe(30000);
  });

  test("from_hz converts a tick rate to a period in milliseconds", () => {
    expect(Gtime_milliseconds(Gtime_from_hz(10))).toBe(100);
    expect(Gtime_milliseconds(Gtime_from_hz(40))).toBe(25);
  });

  test("GTIME_ZERO is the default-constructed value", () => {
    expect(Gtime_milliseconds(GTIME_ZERO)).toBe(0);
    expect(Gtime_nonzero(GTIME_ZERO)).toBe(false);
  });
});

describe("gtime — accessors", () => {
  test("seconds()/secondsInt() match the float vs truncated-integer templates", () => {
    const t = Gtime_from_ms(2500);
    expect(Gtime_seconds(t)).toBeCloseTo(2.5, 10);
    expect(Gtime_secondsInt(t)).toBe(2);
  });

  test("minutes()/minutesInt() match the float vs truncated-integer templates", () => {
    const t = Gtime_from_ms(90000);
    expect(Gtime_minutes(t)).toBeCloseTo(1.5, 10);
    expect(Gtime_minutesInt(t)).toBe(1);
  });

  test("frames() divides by an explicit frame_time_ms (gi not ported yet)", () => {
    const t = Gtime_from_ms(1000);
    expect(Gtime_frames(t, 25)).toBe(40);
    expect(Gtime_frames(t, 100)).toBe(10);
  });

  test("nonzero() matches operator bool()", () => {
    expect(Gtime_nonzero(Gtime_from_ms(0))).toBe(false);
    expect(Gtime_nonzero(Gtime_from_ms(1))).toBe(true);
    expect(Gtime_nonzero(Gtime_from_ms(-1))).toBe(true);
  });
});

describe("gtime — arithmetic and comparisons", () => {
  test("negate/add/subtract", () => {
    const a = Gtime_from_ms(1000);
    const b = Gtime_from_ms(300);
    expect(Gtime_milliseconds(Gtime_add(a, b))).toBe(1300);
    expect(Gtime_milliseconds(Gtime_subtract(a, b))).toBe(700);
    expect(Gtime_milliseconds(Gtime_negate(a))).toBe(-1000);
  });

  test("scale/divide truncate toward zero like the C++ static_cast<int64_t>", () => {
    const a = Gtime_from_ms(1000);
    expect(Gtime_milliseconds(Gtime_scale(a, 1.5))).toBe(1500);
    expect(Gtime_milliseconds(Gtime_divide(a, 3))).toBe(333); // trunc(333.33..)
  });

  test("native comparison operators work directly on GTime (branded number)", () => {
    const a = Gtime_from_ms(100);
    const b = Gtime_from_ms(200);
    const c = Gtime_from_ms(100);
    expect(a < b).toBe(true);
    expect(b > a).toBe(true);
    expect(a <= c).toBe(true);
    expect(a >= c).toBe(true);
    expect(a === c).toBe(true);
    expect(a !== b).toBe(true);
  });

  test("edge case: zero and negative times compare correctly", () => {
    const zero = GTIME_ZERO;
    const negative = Gtime_from_ms(-500);
    const positive = Gtime_from_ms(500);
    expect(negative < zero).toBe(true);
    expect(zero < positive).toBe(true);
    expect(negative < positive).toBe(true);
  });

  test("GTime widens to number without a cast at call sites", () => {
    const t: GTime = Gtime_from_ms(42);
    const asNumber: number = t; // no cast required — this is the point of branding a number
    expect(asNumber).toBe(42);
  });
});

// ===========================================================================
// spawnflags.ts
// ===========================================================================

describe("spawnflags — has/has_all/any truth table", () => {
  const BIT0 = SpawnFlags_from(0x1);
  const BIT1 = SpawnFlags_from(0x2);
  const BIT2 = SpawnFlags_from(0x4);
  const BIT0_1 = SpawnFlags_or(BIT0, BIT1);

  test("any() is false only for zero", () => {
    expect(SpawnFlags_any(SPAWNFLAGS_NONE)).toBe(false);
    expect(SpawnFlags_any(BIT0)).toBe(true);
  });

  test("operator!() equivalent (none()) is the exact complement of any()", () => {
    expect(SpawnFlags_none(SPAWNFLAGS_NONE)).toBe(true);
    expect(SpawnFlags_none(BIT0)).toBe(false);
  });

  test("has() — true if ANY of the given bits are set", () => {
    expect(SpawnFlags_has(BIT0_1, BIT0)).toBe(true);
    expect(SpawnFlags_has(BIT0_1, BIT1)).toBe(true);
    expect(SpawnFlags_has(BIT0_1, BIT2)).toBe(false);
    expect(SpawnFlags_has(BIT0_1, SpawnFlags_or(BIT1, BIT2))).toBe(true); // any overlap
  });

  test("has_all() — true only if ALL of the given bits are set", () => {
    expect(SpawnFlags_has_all(BIT0_1, BIT0)).toBe(true);
    expect(SpawnFlags_has_all(BIT0_1, BIT0_1)).toBe(true);
    expect(SpawnFlags_has_all(BIT0_1, SpawnFlags_or(BIT0, BIT2))).toBe(false); // BIT2 missing
    expect(SpawnFlags_has_all(SPAWNFLAGS_NONE, BIT0)).toBe(false);
    expect(SpawnFlags_has_all(BIT0, SPAWNFLAGS_NONE)).toBe(true); // (a & 0) == 0 is vacuously true
  });

  test("full truth table across all 8 combinations of 3 bits", () => {
    const bits = [BIT0, BIT1, BIT2];
    for (let mask = 0; mask < 8; mask++) {
      let flags: SpawnFlags = SPAWNFLAGS_NONE;
      for (let i = 0; i < 3; i++) {
        if (mask & (1 << i)) flags = SpawnFlags_or(flags, bits[i]!);
      }
      for (let i = 0; i < 3; i++) {
        const expected = (mask & (1 << i)) !== 0;
        expect(SpawnFlags_has(flags, bits[i]!)).toBe(expected);
      }
      expect(SpawnFlags_any(flags)).toBe(mask !== 0);
    }
  });
});

describe("spawnflags — bitwise operators", () => {
  test("not() re-brands to uint32 (no leaked sign bit)", () => {
    const notNone = SpawnFlags_not(SPAWNFLAGS_NONE);
    expect(SpawnFlags_value(notNone)).toBe(0xffffffff);
  });

  test("and/or/xor match native bitwise semantics", () => {
    const a = SpawnFlags_from(0b1100);
    const b = SpawnFlags_from(0b1010);
    expect(SpawnFlags_value(SpawnFlags_and(a, b))).toBe(0b1000);
    expect(SpawnFlags_value(SpawnFlags_or(a, b))).toBe(0b1110);
    expect(SpawnFlags_value(SpawnFlags_xor(a, b))).toBe(0b0110);
  });

  test("SpawnFlags is a branded number: === works natively", () => {
    expect(SpawnFlags_from(5) === SpawnFlags_from(5)).toBe(true);
    expect(SpawnFlags_from(5) === SpawnFlags_from(6)).toBe(false);
  });
});

// ===========================================================================
// q_vec3.ts
// ===========================================================================

describe("vec3 — fresh-array guarantee (value-semantics trap)", () => {
  test("vec3_add never returns an input reference; mutating the result leaves sources untouched", () => {
    const a = vec3(1, 2, 3);
    const b = vec3(4, 5, 6);
    const result = vec3_add(a, b);
    expect(result).not.toBe(a);
    expect(result).not.toBe(b);
    result[0] = 999;
    expect(a[0]).toBe(1);
    expect(b[0]).toBe(4);
  });

  test("vec3_normalized returns a fresh copy even in the zero-length branch", () => {
    const zero = vec3(0, 0, 0);
    const result = vec3_normalized(zero);
    expect(result).not.toBe(zero);
    result[0] = 42;
    expect(zero[0]).toBe(0);
  });

  test("vec3_cross, vec3_sub, vec3_scaled, vec3_negate, vec3_muls, vec3_divs all return fresh arrays", () => {
    const a = vec3(1, 0, 0);
    const b = vec3(0, 1, 0);
    const fns: Array<() => Vec3> = [
      () => vec3_cross(a, b),
      () => vec3_sub(a, b),
      () => vec3_scaled(a, b),
      () => vec3_negate(a),
      () => vec3_muls(a, 2),
      () => vec3_divs(a, 2),
      () => vec3_div(a, vec3(1, 1, 1)),
    ];
    for (const fn of fns) {
      const r = fn();
      expect(r).not.toBe(a);
      expect(r).not.toBe(b);
    }
  });

  test("mutating helpers (Eq suffix) DO mutate their first argument and return that same reference", () => {
    const v = vec3(1, 1, 1);
    const ref = vec3_addEq(v, vec3(1, 2, 3));
    expect(ref).toBe(v);
    expect(Array.from(v)).toEqual([2, 3, 4]);
  });
});

describe("vec3 — basic operators vs hand-computed values", () => {
  const a = vec3(1, 2, 3);
  const b = vec3(4, 5, 6);

  test("dot", () => {
    expect(vec3_dot(a, b)).toBe(1 * 4 + 2 * 5 + 3 * 6); // 32
  });

  test("cross", () => {
    const c = vec3_cross(vec3(1, 0, 0), vec3(0, 1, 0));
    expect(Array.from(c)).toEqual([0, 0, 1]);
  });

  test("add/sub", () => {
    expect(Array.from(vec3_add(a, b))).toEqual([5, 7, 9]);
    expect(Array.from(vec3_sub(b, a))).toEqual([3, 3, 3]);
  });

  test("scaled (elementwise) vs muls (scalar)", () => {
    expect(Array.from(vec3_scaled(a, b))).toEqual([4, 10, 18]);
    expect(Array.from(vec3_muls(a, 2))).toEqual([2, 4, 6]);
  });

  test("length / lengthSquared", () => {
    const v = vec3(3, 4, 0);
    expect(vec3_lengthSquared(v)).toBe(25);
    expect(vec3_length(v)).toBe(5);
  });

  test("equals / equals_epsilon / not_equals", () => {
    expect(vec3_equals(vec3(1, 2, 3), vec3(1, 2, 3))).toBe(true);
    expect(vec3_equals(vec3(1, 2, 3), vec3(1, 2, 3.0001))).toBe(false);
    expect(vec3_equals_epsilon(vec3(1, 2, 3), vec3(1, 2, 3.0001), 0.001)).toBe(true);
    expect(vec3_not_equals(vec3(1, 2, 3), vec3(1, 2, 4))).toBe(true);
  });

  test("any_nonzero", () => {
    expect(vec3_any_nonzero(vec3(0, 0, 0))).toBe(false);
    expect(vec3_any_nonzero(vec3(0, 0, 1))).toBe(true);
  });

  test("normalize (mutating) returns pre-normalize length and unit-length result", () => {
    const v = vec3(3, 4, 0);
    const len = vec3_normalize(v);
    expect(len).toBe(5);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  test("normalized_len reports both the fresh unit vector and the original length", () => {
    const v = vec3(3, 4, 0);
    const { vec: unit, len } = vec3_normalized_len(v);
    expect(len).toBe(5);
    expect(unit).not.toBe(v);
    expect(unit[0]).toBeCloseTo(0.6, 6);
  });
});

describe("vec3 — geometry helpers", () => {
  test("ClipVelocity zeroes near-stop results and preserves fresh-array semantics", () => {
    const inVec = vec3(0, 0, -1);
    const normal = vec3(0, 0, 1);
    const out = ClipVelocity(inVec, normal, 1);
    expect(out).not.toBe(inVec);
    expect(Array.from(out)).toEqual([0, 0, 0]);
  });

  test("SlideClipVelocity slides velocity along a plane", () => {
    const inVec = vec3(1, 0, -1);
    const normal = vec3(0, 0, 1);
    const out = SlideClipVelocity(inVec, normal, 1);
    expect(out[2]).toBeCloseTo(0, 6);
    expect(out[0]).toBeCloseTo(1, 6);
  });

  test("vectoyaw special-cases a zero pitch axis", () => {
    expect(vectoyaw(vec3(0, 0, 0))).toBe(0);
    expect(vectoyaw(vec3(0, 5, 0))).toBe(90);
    expect(vectoyaw(vec3(0, -5, 0))).toBe(270);
  });

  test("vectoangles handles the pure-Z special case", () => {
    expect(Array.from(vectoangles(vec3(0, 0, 5)))).toEqual([-90, 0, 0]);
    expect(Array.from(vectoangles(vec3(0, 0, -5)))).toEqual([-270, 0, 0]);
  });

  test("closest_point_to_box clamps into the box", () => {
    const p = closest_point_to_box(vec3(-5, 50, 0), vec3(0, 0, 0), vec3(10, 10, 10));
    expect(Array.from(p)).toEqual([0, 10, 0]);
  });

  test("boxes_intersect / distance_between_boxes agree on separated boxes", () => {
    const aMin = vec3(0, 0, 0);
    const aMax = vec3(1, 1, 1);
    const bMin = vec3(5, 0, 0);
    const bMax = vec3(6, 1, 1);
    expect(boxes_intersect(aMin, aMax, bMin, bMax)).toBe(false);
    expect(distance_between_boxes(aMin, aMax, bMin, bMax)).toBe(4);
  });

  test("boxes_intersect is true for overlapping boxes", () => {
    const aMin = vec3(0, 0, 0);
    const aMax = vec3(2, 2, 2);
    const bMin = vec3(1, 1, 1);
    const bMax = vec3(3, 3, 3);
    expect(boxes_intersect(aMin, aMax, bMin, bMax)).toBe(true);
  });

  test("ClearBounds uses ±Infinity (deliberately different from the legacy ±99999 sentinel)", () => {
    const mins = vec3();
    const maxs = vec3();
    ClearBounds(mins, maxs);
    expect(mins[0]).toBe(Infinity);
    expect(maxs[0]).toBe(-Infinity);
    AddPointToBounds(vec3(3, -2, 7), mins, maxs);
    expect(Array.from(mins)).toEqual([3, -2, 7]);
    expect(Array.from(maxs)).toEqual([3, -2, 7]);
  });

  test("ProjectPointOnPlane and PerpendicularVector return fresh, sane results", () => {
    const normal = vec3(0, 0, 1);
    const projected = ProjectPointOnPlane(vec3(5, 5, 5), normal);
    expect(projected[2]).toBeCloseTo(0, 6);
    const perp = PerpendicularVector(vec3(0, 0, 1));
    expect(vec3_dot(perp, vec3(0, 0, 1))).toBeCloseTo(0, 6);
    expect(vec3_length(perp)).toBeCloseTo(1, 6);
  });

  test("RotatePointAroundVector: 90 degree rotation around Z maps X onto Y", () => {
    const result = RotatePointAroundVector(vec3(0, 0, 1), vec3(1, 0, 0), 90);
    expect(result[0]).toBeCloseTo(0, 5);
    expect(result[1]).toBeCloseTo(1, 5);
    expect(result[2]).toBeCloseTo(0, 5);
  });

  test("AngleVectors: identity angles give forward=+X, right=-Y, up=+Z", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(vec3(0, 0, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(1, 6);
    expect(right[1]).toBeCloseTo(-1, 6);
    expect(up[2]).toBeCloseTo(1, 6);
  });

  test("AngleVectors honors null out-params (skips computing them)", () => {
    const forward = vec3();
    AngleVectors(vec3(0, 0, 0), forward, null, null);
    expect(forward[0]).toBeCloseTo(1, 6);
  });

  test("AngleVectors_destructured matches the pointer-style overload", () => {
    const { forward, right, up } = AngleVectors_destructured(vec3(0, 90, 0));
    const forward2 = vec3();
    AngleVectors(vec3(0, 90, 0), forward2, null, null);
    expect(forward[0]).toBeCloseTo(forward2[0], 6);
    expect(right).toBeDefined();
    expect(up).toBeDefined();
  });

  test("G_ProjectSource / G_ProjectSource2", () => {
    const point = vec3(0, 0, 0);
    const forward = vec3(1, 0, 0);
    const right = vec3(0, 1, 0);
    const up = vec3(0, 0, 1);
    const p1 = G_ProjectSource(point, vec3(2, 3, 4), forward, right);
    expect(Array.from(p1)).toEqual([2, 3, 4]); // forward*2 + right*3 + {0,0,4}
    const p2 = G_ProjectSource2(point, vec3(2, 3, 4), forward, right, up);
    expect(Array.from(p2)).toEqual([2, 3, 4]);
  });

  test("slerp at t=0 and t=1 returns the endpoints; midpoint stays unit length for unit inputs", () => {
    const from = vec3(1, 0, 0);
    const to = vec3(0, 1, 0);
    const at0 = slerp(from, to, 0);
    const at1 = slerp(from, to, 1);
    expect(at0[0]).toBeCloseTo(1, 5);
    expect(at1[1]).toBeCloseTo(1, 5);
    const mid = slerp(from, to, 0.5);
    expect(vec3_length(mid)).toBeCloseTo(1, 5);
  });

  test("vec3_origin is the zero vector", () => {
    expect(Array.from(vec3_origin)).toEqual([0, 0, 0]);
  });
});

// ===========================================================================
// q_std.ts — random helpers (range bounds, 1000x loop; ranges only, not
// distribution) plus clamp/lerp/string helpers.
// ===========================================================================

describe("q_std — frandom range bounds", () => {
  test("frandom() stays within [0, 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = frandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("frandom(max) stays within [0, max)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = frandom(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });

  test("frandom(min, max) stays within [min, max)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = frandom(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(5);
    }
  });
});

describe("q_std — crandom / crandom_open range bounds", () => {
  test("crandom() stays within [-1, 1) — closed on min, open on max", () => {
    for (let i = 0; i < 1000; i++) {
      const v = crandom();
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  test("crandom_open() stays within (-1, 1) — open on both ends", () => {
    for (let i = 0; i < 1000; i++) {
      const v = crandom_open();
      expect(v).toBeGreaterThan(-1);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("q_std — irandom / brandom range bounds", () => {
  test("irandom() (raw uint32) stays within [0, 2^32)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = irandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(0x100000000);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test("irandom(max) stays within [0, max) and returns 0 for max <= 0", () => {
    expect(irandom(0)).toBe(0);
    expect(irandom(-5)).toBe(0);
    for (let i = 0; i < 1000; i++) {
      const v = irandom(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  test("irandom(min, max) stays within [min, max)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = irandom(-3, 4);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(4);
    }
  });

  test("irandom(min, max) always returns min when min == max - 1 (degenerate range)", () => {
    for (let i = 0; i < 20; i++) {
      expect(irandom(5, 6)).toBe(5);
    }
  });

  test("brandom() is always exactly true or false, both reachable over many trials", () => {
    let sawTrue = false;
    let sawFalse = false;
    for (let i = 0; i < 1000; i++) {
      const v = brandom();
      expect(typeof v).toBe("boolean");
      if (v) sawTrue = true;
      else sawFalse = true;
    }
    expect(sawTrue && sawFalse).toBe(true);
  });

  test("random_index/random_element stay within container bounds", () => {
    const container = ["a", "b", "c", "d"];
    for (let i = 0; i < 1000; i++) {
      const idx = random_index(container.length);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(container.length);
      expect(container).toContain(random_element(container));
    }
  });
});

describe("q_std — clamp / lerp", () => {
  test("clamp bounds a value into [lo, hi]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  test("lerp matches (to*t + from*(1-t))", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(2, 8, 0.25)).toBeCloseTo(3.5, 10);
  });
});

describe("q_std — Q_strlcpy / Q_strlcat truncation", () => {
  test("Q_strlcpy truncates to siz-1 and reports the full source length", () => {
    const { result, srcLength } = Q_strlcpy("hello world", 6);
    expect(result).toBe("hello");
    expect(srcLength).toBe(11);
  });

  test("Q_strlcpy with siz 0 returns empty string", () => {
    expect(Q_strlcpy("hello", 0).result).toBe("");
  });

  test("Q_strlcat appends within remaining capacity", () => {
    const { result, srcLength } = Q_strlcat("foo", "bar", 5);
    expect(result).toBe("foob"); // only 1 byte of room left (siz - len("foo") - 1)
    expect(srcLength).toBe(6);
  });
});
