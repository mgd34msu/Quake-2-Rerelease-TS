// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Ported from q_vec3.h (548 lines, 2023 kex game module,
// ~/Projects/quake2-rerelease-dll/rerelease/q_vec3.h). C++'s `vec3_t` is a
// `{ float x, y, z; }` struct with 17 overloaded operators and full
// `constexpr` value semantics (every arithmetic operator returns a new
// `vec3_t` by value; `+=`/`-=`/`*=`/`/=`/`scale()`/`normalize()` mutate
// `*this` and return a reference to it). TS has neither operator
// overloading nor copy-on-assign value semantics for objects, so both
// halves port as explicit free functions over this repo's existing `Vec3`
// convention (`Float32Array`, from `../shared/math.ts`):
//
// - C++ operators/methods that return `vec3_t` BY VALUE become functions
//   that allocate and return a FRESH `Vec3` (via `vec3()`), never a
//   parameter or a cached array. This is the repo's documented
//   value-semantics trap (PORTING.md: shared-Float32Array aliasing bugs)
//   — every function below that mirrors a by-value C++ return is written
//   to never hand back one of its inputs.
// - C++ operators/methods that mutate `*this` and return a reference
//   (`operator+=`, `scale()`, `normalize()`, ...) become functions that
//   mutate their first `Vec3` argument in place and return that same
//   reference — this matches `src/shared/math.ts`'s existing out-param
//   convention (`VectorAdd(a, b, out)`, `VectorNormalize(v)`) for the
//   mutating half of the API, per the brief's "reuse the repo's existing
//   vec3 convention" instruction.
// - Free functions in the header (`AngleVectors`, `ClearBounds`,
//   `ProjectPointOnPlane`, `ClipVelocity`, `slerp`, ...) keep their exact
//   C++ names. `vec3_t` *methods* (`dot`, `scaled`, `cross`, `normalized`,
//   ...) become `vec3_`-prefixed free functions taking the receiver as an
//   explicit first argument, since C++ member-function call syntax has no
//   TS equivalent.
//
// Naming key for the mutating half (no direct C++ equivalent spelling,
// since TS has no `+=`/`*=` operator overloading):
//   vec3_addEq / vec3_subEq / vec3_divEq / vec3_divEqs / vec3_mulEqs
//     ↔ operator+= / operator-= / operator/=(vec3_t) / operator/=(T) / operator*=(T)
//   vec3_scale(v, other)  ↔ vec3_t::scale(other)       (mutating, elementwise)
//   vec3_normalize(v)     ↔ vec3_t::normalize()         (mutating, returns length)
//
// DEVIATIONS FROM THE C++ SOURCE:
//
// - `operator[]` (bounds-checked index access, throwing `std::out_of_range`
//   for `i > 2`) is not ported: `Vec3` is already a `Float32Array`, whose
//   native `v[0]`/`v[1]`/`v[2]` indexing is exactly what every call site in
//   this codebase already uses (see `src/shared/math.ts`). No caller in
//   this codebase indexes a vec3 with a variable that could be out of
//   range, so the throwing behavior has nothing to protect against here.
// - `dot`/`cross`/etc. are reimplemented from scratch rather than calling
//   `src/shared/math.ts`'s `DotProduct`/`CrossProduct` (numerically
//   identical, since both ultimately port the same `game/q_shared.h`
//   macros). Kept separate on purpose: this module is the seed of the
//   *kex* game port, which evolves independently of the legacy
//   `src/shared/math.ts` used by baseq2/ctf/xatrix/rogue — a future change
//   to the legacy header should not silently ripple into kex semantics.
// - `ClearBounds` in q_vec3.h uses `±std::numeric_limits<float>::infinity()`
//   as the sentinel — NOT the `±99999` sentinel that `src/shared/math.ts`'s
//   `ClearBounds` (ported from `game/q_shared.c`) uses. This is a genuine,
//   deliberate difference between the two source headers (confirmed by
//   reading both bodies), not a porting slip; infinity is preserved here.
// - `ProjectPointOnPlane`/`PerpendicularVector` return `vec3_t` BY VALUE in
//   q_vec3.h, unlike `src/shared/math.ts`'s versions of the same
//   algorithms (ported from `game/q_shared.c`), which take a `dst` out
//   parameter. Ported here as value-returning per this header, per the
//   fresh-array rule above.
// - `AngleVectors`'s five C-compat overloads that accept `nullptr_t` in
//   various argument positions exist only so old C call sites can pass a
//   literal `nullptr` where the "real" overload wants a `vec3_t&`
//   reference. TS's `Vec3 | null` union already expresses "may be absent"
//   directly, so only the canonical pointer-style overload
//   (`AngleVectors(angles, forward, right, up)`, each `Vec3 | null`) is
//   ported, plus the "for destructuring" value-returning overload
//   (`AngleVectors_destructured`).
// - `mat3_t = std::array<std::array<float, 3>, 3>` becomes a local `Mat3`
//   tuple-of-tuples type, private to this module (`R_ConcatRotations` and
//   `RotatePointAroundVector` are its only two consumers in this header).
// - The `fmt::formatter<vec3_t>` specialization (fmtlib pretty-printing)
//   does NOT port — G_Fmt/fmtlib is explicitly out of scope for the TS
//   port (see q_std.ts); a template literal
//   (`` `${v[0]} ${v[1]} ${v[2]}` ``) replaces it at any call site.
// - No vec3-specific `lerp` exists in q_vec3.h (only `slerp`); the generic
//   scalar `lerp<T>` template lives in q_std.h and is ported to
//   `q_std.ts` as `lerp(from, to, t)`, not duplicated here.

import { vec3, type Vec3 } from "../shared/math";
import { PITCH, YAW, ROLL, DEG2RAD, Q_PIf } from "./q_std";

// ---------------------------------------------------------------------------
// vec3_origin — `constexpr vec3_t vec3_origin{};` (q_vec3.h line 169)
// ---------------------------------------------------------------------------
// Treat as read-only by convention, same as `src/shared/math.ts`'s
// `vec3_origin`: nothing in the type system stops mutation of a
// `Float32Array`, but no call site should ever write through this
// reference.
export const vec3_origin: Vec3 = vec3(0, 0, 0);

// ---------------------------------------------------------------------------
// vec3_t methods → vec3_-prefixed free functions
// ---------------------------------------------------------------------------

/** vec3_t::equals(v) — exact equality. */
export function vec3_equals(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** vec3_t::equals(v, epsilon) — per-axis absolute-difference tolerance. */
export function vec3_equals_epsilon(a: Vec3, b: Vec3, epsilon: number): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon && Math.abs(a[2] - b[2]) <= epsilon;
}

/** vec3_t::operator!=(v) */
export function vec3_not_equals(a: Vec3, b: Vec3): boolean {
  return !vec3_equals(a, b);
}

/** vec3_t::operator bool() — `x || y || z` (true if any component is non-zero). */
export function vec3_any_nonzero(v: Vec3): boolean {
  return v[0] !== 0 || v[1] !== 0 || v[2] !== 0;
}

/** vec3_t::dot(v) */
export function vec3_dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** vec3_t::scaled(v) — elementwise multiply, FRESH result. */
export function vec3_scaled(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] * b[0], a[1] * b[1], a[2] * b[2]);
}

/** vec3_t::scale(v) — elementwise multiply, MUTATES `v` in place (mirrors
 *  `*this = this->scaled(v); return *this;`) and returns it. */
export function vec3_scale(v: Vec3, other: Vec3): Vec3 {
  v[0] *= other[0];
  v[1] *= other[1];
  v[2] *= other[2];
  return v;
}

/** vec3_t::operator-(v) — binary subtract, FRESH result. */
export function vec3_sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** vec3_t::operator+(v), FRESH result. */
export function vec3_add(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
}

/** vec3_t::operator/(v) — elementwise divide, FRESH result. */
export function vec3_div(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[0] / b[0], a[1] / b[1], a[2] / b[2]);
}

/** vec3_t::operator/(T) — scalar divide, FRESH result. */
export function vec3_divs(a: Vec3, scalar: number): Vec3 {
  return vec3(a[0] / scalar, a[1] / scalar, a[2] / scalar);
}

/** vec3_t::operator*(T) — scalar multiply, FRESH result. */
export function vec3_muls(a: Vec3, scalar: number): Vec3 {
  return vec3(a[0] * scalar, a[1] * scalar, a[2] * scalar);
}

/** vec3_t::operator-() — unary negate, FRESH result. */
export function vec3_negate(a: Vec3): Vec3 {
  return vec3(-a[0], -a[1], -a[2]);
}

/** vec3_t::operator-=(v) — MUTATES `v` in place, returns it. */
export function vec3_subEq(v: Vec3, other: Vec3): Vec3 {
  v[0] -= other[0];
  v[1] -= other[1];
  v[2] -= other[2];
  return v;
}

/** vec3_t::operator+=(v) — MUTATES `v` in place, returns it. */
export function vec3_addEq(v: Vec3, other: Vec3): Vec3 {
  v[0] += other[0];
  v[1] += other[1];
  v[2] += other[2];
  return v;
}

/** vec3_t::operator/=(v) — elementwise, MUTATES `v` in place, returns it. */
export function vec3_divEq(v: Vec3, other: Vec3): Vec3 {
  v[0] /= other[0];
  v[1] /= other[1];
  v[2] /= other[2];
  return v;
}

/** vec3_t::operator/=(T) — scalar, MUTATES `v` in place, returns it. */
export function vec3_divEqs(v: Vec3, scalar: number): Vec3 {
  v[0] /= scalar;
  v[1] /= scalar;
  v[2] /= scalar;
  return v;
}

/** vec3_t::operator*=(T) — scalar, MUTATES `v` in place, returns it. */
export function vec3_mulEqs(v: Vec3, scalar: number): Vec3 {
  v[0] *= scalar;
  v[1] *= scalar;
  v[2] *= scalar;
  return v;
}

/** vec3_t::lengthSquared() — `this->dot(*this)`. */
export function vec3_lengthSquared(v: Vec3): number {
  return vec3_dot(v, v);
}

/** vec3_t::length() — `sqrtf(lengthSquared())`. */
export function vec3_length(v: Vec3): number {
  return Math.sqrt(vec3_lengthSquared(v));
}

/** vec3_t::normalized() — FRESH result; even the `len == 0` branch returns
 *  a copy in C++ (return-by-value always copies), so this never returns
 *  the input reference either. */
export function vec3_normalized(v: Vec3): Vec3 {
  const len = vec3_length(v);
  return len ? vec3_muls(v, 1 / len) : vec3(v[0], v[1], v[2]);
}

/** vec3_t::normalized(float &len) — the C++ out-param `len` becomes a
 *  second field on the returned object; `vec` is a FRESH result. */
export function vec3_normalized_len(v: Vec3): { vec: Vec3; len: number } {
  const len = vec3_length(v);
  const vecOut = len ? vec3_muls(v, 1 / len) : vec3(v[0], v[1], v[2]);
  return { vec: vecOut, len };
}

/** vec3_t::normalize() — MUTATES `v` in place, returns the pre-normalize length. */
export function vec3_normalize(v: Vec3): number {
  const len = vec3_length(v);
  if (len) {
    const invLen = 1 / len;
    v[0] *= invLen;
    v[1] *= invLen;
    v[2] *= invLen;
  }
  return len;
}

/** vec3_t::cross(v), FRESH result. */
export function vec3_cross(a: Vec3, b: Vec3): Vec3 {
  return vec3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
}

// ---------------------------------------------------------------------------
// Free functions (exact C++ names)
// ---------------------------------------------------------------------------

/** AngleVectors(angles, forward*, right*, up*) — mutates whichever of
 *  `forward`/`right`/`up` are non-null in place, matching the C++ pointer
 *  out-params exactly (a `null` argument means "don't compute this one"). */
export function AngleVectors(angles: Vec3, forward: Vec3 | null, right: Vec3 | null, up: Vec3 | null): void {
  let angle = angles[YAW] * ((Q_PIf * 2) / 360);
  const sy = Math.sin(angle);
  const cy = Math.cos(angle);
  angle = angles[PITCH] * ((Q_PIf * 2) / 360);
  const sp = Math.sin(angle);
  const cp = Math.cos(angle);
  angle = angles[ROLL] * ((Q_PIf * 2) / 360);
  const sr = Math.sin(angle);
  const cr = Math.cos(angle);

  if (forward) {
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;
  }
  if (right) {
    right[0] = -1 * sr * sp * cy + -1 * cr * -sy;
    right[1] = -1 * sr * sp * sy + -1 * cr * cy;
    right[2] = -1 * sr * cp;
  }
  if (up) {
    up[0] = cr * sp * cy + -sr * -sy;
    up[1] = cr * sp * sy + -sr * cy;
    up[2] = cr * cp;
  }
}

/** AngleVectors(angles) "for destructuring" overload — FRESH forward/right/up. */
export function AngleVectors_destructured(angles: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(angles, forward, right, up);
  return { forward, right, up };
}

/** ClearBounds(mins, maxs) — MUTATES both in place. Uses `±Infinity`
 *  sentinels, per q_vec3.h — see the deviations note above (this differs
 *  from the legacy `src/shared/math.ts` version's `±99999`). */
export function ClearBounds(mins: Vec3, maxs: Vec3): void {
  mins[0] = mins[1] = mins[2] = Infinity;
  maxs[0] = maxs[1] = maxs[2] = -Infinity;
}

/** AddPointToBounds(v, mins, maxs) — MUTATES `mins`/`maxs` in place. */
export function AddPointToBounds(v: Vec3, mins: Vec3, maxs: Vec3): void {
  for (let i = 0; i < 3; i++) {
    const val = v[i];
    if (val < mins[i]) mins[i] = val;
    if (val > maxs[i]) maxs[i] = val;
  }
}

/** ProjectPointOnPlane(p, normal) — FRESH result (value-returning in
 *  q_vec3.h, unlike the legacy out-param version). */
export function ProjectPointOnPlane(p: Vec3, normal: Vec3): Vec3 {
  const inv_denom = 1.0 / vec3_dot(normal, normal);
  const d = vec3_dot(normal, p) * inv_denom;
  return vec3_sub(p, vec3_muls(vec3_muls(normal, inv_denom), d));
}

/** PerpendicularVector(src) — FRESH result. Assumes `src` is normalized. */
export function PerpendicularVector(src: Vec3): Vec3 {
  let pos = 0;
  let minelem = 1.0;

  for (let i = 0; i < 3; i++) {
    if (Math.abs(src[i]) < minelem) {
      pos = i;
      minelem = Math.abs(src[i]);
    }
  }
  const tempvec = vec3(0, 0, 0);
  tempvec[pos] = 1.0;

  return vec3_normalized(ProjectPointOnPlane(tempvec, src));
}

// mat3_t = std::array<std::array<float, 3>, 3> — local to this file; only
// R_ConcatRotations and RotatePointAroundVector use it.
type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

/** R_ConcatRotations(in1, in2) — FRESH matrix result (value-returning in
 *  q_vec3.h, unlike the legacy out-param version in `src/shared/math.ts`). */
export function R_ConcatRotations(in1: Mat3, in2: Mat3): Mat3 {
  return [
    [
      in1[0][0] * in2[0][0] + in1[0][1] * in2[1][0] + in1[0][2] * in2[2][0],
      in1[0][0] * in2[0][1] + in1[0][1] * in2[1][1] + in1[0][2] * in2[2][1],
      in1[0][0] * in2[0][2] + in1[0][1] * in2[1][2] + in1[0][2] * in2[2][2],
    ],
    [
      in1[1][0] * in2[0][0] + in1[1][1] * in2[1][0] + in1[1][2] * in2[2][0],
      in1[1][0] * in2[0][1] + in1[1][1] * in2[1][1] + in1[1][2] * in2[2][1],
      in1[1][0] * in2[0][2] + in1[1][1] * in2[1][2] + in1[1][2] * in2[2][2],
    ],
    [
      in1[2][0] * in2[0][0] + in1[2][1] * in2[1][0] + in1[2][2] * in2[2][0],
      in1[2][0] * in2[0][1] + in1[2][1] * in2[1][1] + in1[2][2] * in2[2][1],
      in1[2][0] * in2[0][2] + in1[2][1] * in2[1][2] + in1[2][2] * in2[2][2],
    ],
  ];
}

/** RotatePointAroundVector(dir, point, degrees) — FRESH result. */
export function RotatePointAroundVector(dir: Vec3, point: Vec3, degrees: number): Vec3 {
  const vf = vec3(dir[0], dir[1], dir[2]);
  const vr = PerpendicularVector(dir);
  const vup = vec3_cross(vr, vf);

  const m: Mat3 = [
    [vr[0], vup[0], vf[0]],
    [vr[1], vup[1], vf[1]],
    [vr[2], vup[2], vf[2]],
  ];

  const im: Mat3 = [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];

  const rad = DEG2RAD(degrees);
  const zrot: Mat3 = [
    [Math.cos(rad), Math.sin(rad), 0],
    [-Math.sin(rad), Math.cos(rad), 0],
    [0, 0, 1],
  ];

  const rot = R_ConcatRotations(R_ConcatRotations(m, zrot), im);

  return vec3(
    rot[0][0] * point[0] + rot[0][1] * point[1] + rot[0][2] * point[2],
    rot[1][0] * point[0] + rot[1][1] * point[1] + rot[1][2] * point[2],
    rot[2][0] * point[0] + rot[2][1] * point[1] + rot[2][2] * point[2],
  );
}

/** closest_point_to_box(from, absmins, absmaxs) — FRESH result. */
export function closest_point_to_box(from: Vec3, absmins: Vec3, absmaxs: Vec3): Vec3 {
  return vec3(
    from[0] < absmins[0] ? absmins[0] : from[0] > absmaxs[0] ? absmaxs[0] : from[0],
    from[1] < absmins[1] ? absmins[1] : from[1] > absmaxs[1] ? absmaxs[1] : from[1],
    from[2] < absmins[2] ? absmins[2] : from[2] > absmaxs[2] ? absmaxs[2] : from[2],
  );
}

/** distance_between_boxes(absminsa, absmaxsa, absminsb, absmaxsb) */
export function distance_between_boxes(absminsa: Vec3, absmaxsa: Vec3, absminsb: Vec3, absmaxsb: Vec3): number {
  let len = 0;
  for (let i = 0; i < 3; i++) {
    if (absmaxsa[i] < absminsb[i]) {
      const d = absmaxsa[i] - absminsb[i];
      len += d * d;
    } else if (absminsa[i] > absmaxsb[i]) {
      const d = absminsa[i] - absmaxsb[i];
      len += d * d;
    }
  }
  return Math.sqrt(len);
}

/** boxes_intersect(amins, amaxs, bmins, bmaxs) */
export function boxes_intersect(amins: Vec3, amaxs: Vec3, bmins: Vec3, bmaxs: Vec3): boolean {
  return (
    amins[0] <= bmaxs[0] &&
    amaxs[0] >= bmins[0] &&
    amins[1] <= bmaxs[1] &&
    amaxs[1] >= bmins[1] &&
    amins[2] <= bmaxs[2] &&
    amaxs[2] >= bmins[2]
  );
}

/** STOP_EPSILON — `constexpr float STOP_EPSILON = 0.1f;` */
export const STOP_EPSILON = 0.1;

/** ClipVelocity(in, normal, overbounce) — "slide off of the impacting
 *  object". FRESH result. */
export function ClipVelocity(inVec: Vec3, normal: Vec3, overbounce: number): Vec3 {
  const dot = vec3_dot(inVec, normal);
  let out = vec3_add(inVec, vec3_muls(normal, -2 * dot));
  out = vec3_muls(out, overbounce - 1);

  if (vec3_lengthSquared(out) < STOP_EPSILON * STOP_EPSILON) {
    out = vec3(0, 0, 0);
  }

  return out;
}

/** SlideClipVelocity(in, normal, overbounce) — FRESH result. */
export function SlideClipVelocity(inVec: Vec3, normal: Vec3, overbounce: number): Vec3 {
  const backoff = vec3_dot(inVec, normal) * overbounce;
  const out = vec3_sub(inVec, vec3_muls(normal, backoff));

  for (let i = 0; i < 3; i++) {
    if (out[i] > -STOP_EPSILON && out[i] < STOP_EPSILON) out[i] = 0;
  }

  return out;
}

/** vectoyaw(vec) */
export function vectoyaw(vec: Vec3): number {
  if (vec[PITCH] === 0) {
    if (vec[YAW] === 0) return 0;
    else if (vec[YAW] > 0) return 90;
    else return 270;
  }

  let yaw = Math.atan2(vec[YAW], vec[PITCH]) * (180 / Q_PIf);
  if (yaw < 0) yaw += 360;
  return yaw;
}

/** vectoangles(vec) — FRESH result. */
export function vectoangles(vec: Vec3): Vec3 {
  if (vec[1] === 0 && vec[0] === 0) {
    return vec[2] > 0 ? vec3(-90, 0, 0) : vec3(-270, 0, 0);
  }

  let yaw: number;
  if (vec[0]) {
    yaw = Math.atan2(vec[1], vec[0]) * (180 / Q_PIf);
  } else if (vec[1] > 0) {
    yaw = 90;
  } else {
    yaw = 270;
  }
  if (yaw < 0) yaw += 360;

  const forward = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
  let pitch = Math.atan2(vec[2], forward) * (180 / Q_PIf);
  if (pitch < 0) pitch += 360;

  return vec3(-pitch, yaw, 0);
}

/** G_ProjectSource(point, distance, forward, right) — FRESH result. */
export function G_ProjectSource(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3): Vec3 {
  let result = vec3_add(point, vec3_muls(forward, distance[0]));
  result = vec3_add(result, vec3_muls(right, distance[1]));
  result = vec3_add(result, vec3(0, 0, distance[2]));
  return result;
}

/** G_ProjectSource2(point, distance, forward, right, up) — FRESH result. */
export function G_ProjectSource2(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, up: Vec3): Vec3 {
  let result = vec3_add(point, vec3_muls(forward, distance[0]));
  result = vec3_add(result, vec3_muls(right, distance[1]));
  result = vec3_add(result, vec3_muls(up, distance[2]));
  return result;
}

/** slerp(from, to, t) — FRESH result. */
export function slerp(from: Vec3, to: Vec3, t: number): Vec3 {
  const dot = vec3_dot(from, to);
  let aFactor: number;
  let bFactor: number;

  if (Math.abs(dot) > 0.9995) {
    aFactor = 1.0 - t;
    bFactor = t;
  } else {
    const ang = Math.acos(dot);
    const sinOmega = Math.sin(ang);
    const sinAOmega = Math.sin((1.0 - t) * ang);
    const sinBOmega = Math.sin(t * ang);
    aFactor = sinAOmega / sinOmega;
    bFactor = sinBOmega / sinOmega;
  }

  return vec3_add(vec3_muls(from, aFactor), vec3_muls(to, bFactor));
}

// q_vec3.h computes angle conversions as `angles[YAW] * (PIf * 2 / 360)`
// etc. — i.e. degrees-to-radians via `PIf` directly (`AngleVectors`,
// `vectoyaw`, `vectoangles`), reusing q_std.ts's `Q_PIf` (imported above),
// which is exactly `Math.fround(Q_PI)` — the same single-precision PI the
// C++ source computes once at file scope.
