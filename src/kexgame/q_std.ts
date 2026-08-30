// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Ported from q_std.h / q_std.cpp (2023 kex game module,
// ~/Projects/quake2-rerelease-dll/rerelease/{q_std.h,q_std.cpp}) plus the
// random-number family that g_local.h declares (see the scope note below).
// Only the foundational, portable pieces are ported here, per the brief:
// string helpers, random helpers, and min/max/clamp/lerp. Everything else
// in q_std.h is either not applicable to TS or belongs to a later unit:
//
// - `g_fmt_data_t` / `G_FmtTo` / `G_Fmt` / `join_strings` (fmtlib-backed
//   formatting) do NOT port. TS template literals (`` `${a} ${b}` ``)
//   replace `G_Fmt` at every call site; there is no static-buffer aliasing
//   hazard to reproduce (PORTING.md / ARCHITECTURE.md both call this out
//   explicitly for the kex port).
// - `using byte = uint8_t;` is re-exported from `../shared/q_shared`
//   (`Byte`), which already carries the identical "documentation alias
//   only" meaning for this codebase, rather than declaring a second alias.
// - `q_countof(a)` (an `std::extent_v` compile-time array-length macro) is
//   superseded by `.length`; not portable as a runtime function.
// - `PITCH/YAW/ROLL` enum, `PI`/`PIf`, `RAD2DEG`/`DEG2RAD` ARE ported here
//   even though the brief's q_std.ts bullet does not name them explicitly,
//   because q_vec3.ts's `AngleVectors`/`RotatePointAroundVector` need them
//   and this is their true home in the C++ source (q_std.h lines ~120-147,
//   `#include`d by q_vec3.h). `PITCH`/`YAW`/`ROLL` are re-exported from
//   `../shared/q_shared` rather than redeclared, since the numeric values
//   (0/1/2) are identical to the legacy header's copy.
// - `G_AddBlend`, `LerpAngle`, `anglemod` (q_std.h ~150-193) are NOT ported
//   here: nothing in this foundation unit (gtime/spawnflags/vec3/random)
//   calls them, and `src/shared/math.ts` already carries functionally
//   equivalent legacy versions. They will be ported alongside whichever
//   kex unit needs kex's own copy (p_view/p_hud screen-blend code), at
//   which point the C++ source's minor implementation differences from the
//   legacy version (anglemod here uses `fmod`; the legacy one uses a
//   bit-truncation trick) can be checked against real call sites.
// - `COM_ParseEx` / `COM_Parse` are declared in q_std.h but are not in the
//   brief's enumerated scope; `src/shared/q_shared.ts` already has a
//   `COM_Parse` ported from the original engine's token parser. The kex
//   version's differences (custom separator set, caller-supplied buffer
//   size) are deferred to whichever unit first needs them.
//
// Scope mismatch (reported per PORTING.md: "the brief's placement wins;
// report the mismatch, don't move it"): `frandom`/`crandom`/`crandom_open`/
// `irandom`/`brandom` are actually declared in g_local.h (~lines 1788-1878),
// not q_std.h/q_std.cpp — g_local.h's comment block sits right above
// `extern edict_t *g_edicts;`, i.e. deep in the per-level game state file,
// not the "standard library" header. The brief places them in q_std.ts, so
// that's where they live; this comment records the true source location.

export type { Byte } from "../shared/q_shared";
export { PITCH, YAW, ROLL } from "../shared/q_shared";

// ---------------------------------------------------------------------------
// MATHLIB constants (q_std.h ~136-147)
// ---------------------------------------------------------------------------

/** q_std.h: `constexpr double PI = 3.14159265358979323846;` */
export const Q_PI = 3.14159265358979323846;

/** q_std.h: `constexpr float PIf = static_cast<float>(PI);` */
export const Q_PIf = Math.fround(Q_PI);

/** q_std.h: `RAD2DEG(x) = x * 180.0f / PIf` */
export function RAD2DEG(x: number): number {
  return (x * 180.0) / Q_PIf;
}

/** q_std.h: `DEG2RAD(x) = x * PIf / 180.0f` */
export function DEG2RAD(x: number): number {
  return (x * Q_PIf) / 180.0;
}

// ---------------------------------------------------------------------------
// std::min / std::max / std::clamp / lerp<T> (q_std.h ~110-118)
// ---------------------------------------------------------------------------
//
// `using std::max; using std::min;` are aliases for the standard library —
// call sites should use `Math.max`/`Math.min` directly; no wrapper is
// exported for those two since they would add nothing over the builtins.

/** q_std.h: `template<T> constexpr T clamp(...)` via `using std::clamp;`
 *  (std::clamp semantics: assumes `lo <= hi`; behavior is otherwise
 *  unspecified in C++ if that's violated, so this does not defend against it). */
export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** q_std.h: `template<T> constexpr T lerp(T from, T to, float t) { return
 *  (to * t) + (from * (1.f - t)); }`. Kept in this exact operand order
 *  (rather than the more common `from + t * (to - from)`) for bit-for-bit
 *  fidelity with the C++ floating-point rounding, even though the two
 *  forms are algebraically identical. */
export function lerp(from: number, to: number, t: number): number {
  return to * t + from * (1 - t);
}

// ---------------------------------------------------------------------------
// BSD string utilities (q_std.cpp ~213-280)
// ---------------------------------------------------------------------------
//
// `Q_strcasecmp`/`Q_strncasecmp` are re-exported rather than duplicated:
// `src/shared/q_shared.ts` already ports byte-identical case-insensitive
// comparisons (same algorithm: uppercase 'a'-'z' before comparing, stop at
// NUL) from the original engine's q_shared.c. The kex copy in q_std.cpp is
// functionally identical.
export { Q_strcasecmp, Q_strncasecmp } from "../shared/q_shared";

/**
 * q_std.cpp: `size_t Q_strlcpy(char *dst, const char *src, size_t siz)` —
 * copies `src` into a fixed `siz`-byte buffer, truncating to `siz - 1`
 * characters and always NUL-terminating (unless `siz == 0`), returning
 * `strlen(src)` so the caller can detect truncation via `retval >= siz`.
 *
 * TS strings are immutable and have no fixed-size buffer to write into
 * (PORTING.md's "mutate a char* in place" idiom: return the new value
 * instead). This returns the truncated result together with the full
 * source length, the two pieces of information a C caller could observe
 * (the buffer's final contents, and the truncation-detecting return value).
 */
export function Q_strlcpy(src: string, siz: number): { result: string; srcLength: number } {
  if (siz === 0) return { result: "", srcLength: src.length };
  return { result: src.slice(0, siz - 1), srcLength: src.length };
}

/**
 * q_std.cpp: `size_t Q_strlcat(char *dst, const char *src, size_t siz)` —
 * appends `src` onto `dst`, where `siz` is `dst`'s *total* buffer capacity
 * (not remaining space), truncating and always NUL-terminating, returning
 * the length the fully-appended string would have had.
 *
 * Ported under the simplifying assumption that `dst` is already a
 * well-formed string of length `<= siz` (true for every TS call site,
 * since there are no raw fixed-size buffers here to have already
 * overflowed `dst` itself before this call).
 */
export function Q_strlcat(dst: string, src: string, siz: number): { result: string; srcLength: number } {
  if (siz === 0 || dst.length >= siz) {
    return { result: dst, srcLength: dst.length + src.length };
  }
  const available = siz - dst.length - 1;
  const appended = available > 0 ? src.slice(0, available) : "";
  return { result: dst + appended, srcLength: dst.length + src.length };
}

// ---------------------------------------------------------------------------
// Random-number helpers (declared in g_local.h — see the scope-mismatch
// note above). Backed by `Math.random()`; determinism across runs is
// explicitly not a goal here (PORTING.md idiom map), matching the C++
// source's own `std::mt19937 mt_rand` (seeded per-process, not
// reproducible across engine versions either).
// ---------------------------------------------------------------------------

/**
 * g_local.h: `frandom()` — uniform float `[0, 1)`.
 * g_local.h: `frandom(float max_exclusive)` — uniform float `[0, max_exclusive)`.
 * g_local.h: `frandom(float min_inclusive, float max_exclusive)` — uniform
 * float `[min_inclusive, max_exclusive)`. Verified against
 * `std::uniform_real_distribution<float>(lo, hi)`, which is half-open
 * `[lo, hi)`; `Math.random()` is likewise half-open `[0, 1)`, so each
 * overload below is a direct affine transform of `Math.random()`.
 */
export function frandom(): number;
export function frandom(max_exclusive: number): number;
export function frandom(min_inclusive: number, max_exclusive: number): number;
export function frandom(a?: number, b?: number): number {
  if (a === undefined) return Math.random();
  if (b === undefined) return Math.random() * a;
  return a + Math.random() * (b - a);
}

/**
 * g_local.h: `crandom()` — uniform float `[-1, 1)`. Verified from
 * `std::uniform_real_distribution<float>(-1.f, 1.f)`: closed on the min,
 * open on the max — the C++ comment even flags this explicitly ("note:
 * closed on min but not max, to match vanilla behavior"). `Math.random() *
 * 2 - 1` reproduces the same half-open range exactly: `Math.random() ∈
 * [0,1)` ⇒ `*2 ∈ [0,2)` ⇒ `-1 ∈ [-1,1)`.
 */
export function crandom(): number {
  return Math.random() * 2 - 1;
}

// nextafterf(-1.f, 0.f) — the float32 value one ULP above -1.0 (verified by
// direct bit manipulation: decrementing the raw int32 bit pattern of a
// negative float32 moves it toward zero by one ULP; confirmed numerically
// to be -0.9999999403953552, matching the well-known nextafterf(-1,0)
// constant). Needed for `crandom_open`'s open lower bound below.
const f32Buf = new Float32Array(1);
const i32Buf = new Int32Array(f32Buf.buffer);
function nextAfterFloat32TowardZero(x: number): number {
  f32Buf[0] = x;
  if (f32Buf[0] === 0) return 0;
  i32Buf[0] += x > 0 ? -1 : 1;
  return f32Buf[0];
}
const CRANDOM_OPEN_LOW = nextAfterFloat32TowardZero(-1);

/**
 * g_local.h: `crandom_open()` — uniform float `(-1, 1)`, open on *both*
 * ends. C++: `std::uniform_real_distribution<float>(std::nextafterf(-1.f,
 * 0.f), 1.f)`, i.e. half-open `[nextafterf(-1,0), 1)`, which excludes
 * exactly -1 and excludes 1 — the open interval `(-1, 1)` to float32
 * precision.
 */
export function crandom_open(): number {
  return CRANDOM_OPEN_LOW + Math.random() * (1 - CRANDOM_OPEN_LOW);
}

/**
 * g_local.h: `irandom()` — raw uint32 (`mt_rand()` directly, the full
 * 32-bit output range `[0, 2^32)`).
 * g_local.h: `irandom(int32_t max_exclusive)` — uniform int `[0,
 * max_exclusive)`; returns 0 if `max_exclusive <= 0`.
 * g_local.h: `irandom(int32_t min_inclusive, int32_t max_exclusive)` —
 * uniform int `[min_inclusive, max_exclusive)` via
 * `std::uniform_int_distribution<int32_t>(min, max - 1)` (inclusive on
 * both ends of `[min, max-1]`, which is exactly `[min, max)`); always
 * returns `min_inclusive` when `min_inclusive == max_exclusive - 1`
 * (single-element range — documented explicitly in the C++ comment).
 * Undefined behavior in C++ if `min_inclusive > max_exclusive - 1`; not
 * specially handled here either, matching that.
 */
export function irandom(): number;
export function irandom(max_exclusive: number): number;
export function irandom(min_inclusive: number, max_exclusive: number): number;
export function irandom(a?: number, b?: number): number {
  if (a === undefined) {
    // raw uint32 from the RNG
    return Math.floor(Math.random() * 0x100000000) >>> 0;
  }
  let min_inclusive: number;
  let max_exclusive: number;
  if (b === undefined) {
    if (a <= 0) return 0;
    min_inclusive = 0;
    max_exclusive = a;
  } else {
    min_inclusive = a;
    max_exclusive = b;
  }
  if (min_inclusive === max_exclusive - 1) return min_inclusive;
  return min_inclusive + Math.floor(Math.random() * (max_exclusive - min_inclusive));
}

/**
 * g_local.h: `random_index(container)` — `irandom(std::size(container))`.
 */
export function random_index(length: number): number {
  return irandom(length);
}

/**
 * g_local.h: `random_element(container)` — `*(begin + random_index(...))`.
 */
export function random_element<T>(container: readonly T[]): T {
  const value = container[random_index(container.length)];
  if (value === undefined) {
    throw new Error("random_element: empty container");
  }
  return value;
}

/**
 * g_local.h: `brandom()` — `irandom(2) == 0`; a fair coin flip.
 */
export function brandom(): boolean {
  return irandom(2) === 0;
}
