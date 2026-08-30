// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Ported from g_local.h's `gtime_t` (lines ~287-462 of the 2023 kex game
// module, ~/Projects/quake2-rerelease-dll/rerelease/g_local.h). C++ source:
//
//   struct gtime_t {
//   private:
//       int64_t _ms = 0;
//       constexpr explicit gtime_t(const int64_t &ms) : _ms(ms) {}
//   public:
//       static constexpr gtime_t from_ms(const int64_t &ms);
//       template<T> static constexpr gtime_t from_sec(const T &s);   // int64_t(s * 1000)
//       template<T> static constexpr gtime_t from_min(const T &s);   // int64_t(s * 60000)
//       static constexpr gtime_t from_hz(const uint64_t &hz);        // from_ms(int64_t((1.0/hz)*1000))
//       template<T = float> constexpr T minutes() const;             // _ms / 60000, truncated for integer T
//       template<T = float> constexpr T seconds() const;             // _ms / 1000, truncated for integer T
//       constexpr const int64_t &milliseconds() const;
//       int64_t frames() const;                                      // _ms / gi.frame_time_ms
//       constexpr explicit operator bool() const;                    // !!_ms
//       constexpr gtime_t operator-() const;
//       operator+, operator-, operator+=, operator-= (gtime_t with gtime_t)
//       operator*, operator/, operator*=, operator/= (gtime_t with scalar T)
//       operator==, !=, <, >, <=, >=
//   };
//   // user literals: 5000_ms, 5_sec, 2_min, 10_hz
//
// DEVIATIONS FROM THE C++ SOURCE:
//
// - Design: a branded `number` (milliseconds, integer) rather than a class.
//   ARCHITECTURE.md's "Porting standards" section is explicit: "`gtime_t`
//   ports as a branded int64-ms type, never float seconds" — this is the
//   locked decision, not a class wrapping a private field. A branded number
//   also gives native `<`, `>`, `<=`, `>=`, `===`, `!==` for free (a `GTime`
//   *is* a `number` at runtime, so JS's own relational/equality operators
//   already do the right thing) — unlike Vec3, no comparison helpers are
//   needed at all. This is a deliberate improvement over a class, which
//   would need explicit `.equals()`/`.lessThan()` methods since JS classes
//   don't get operator overloading either.
// - Milliseconds are stored as a plain `number`, not `bigint`, even though
//   C++ uses `int64_t`. `number` is exact for integers up to 2^53
//   (Number.MAX_SAFE_INTEGER), which is roughly 285,616 years of
//   millisecond ticks — no game clock will ever approach that. `bigint`
//   would force every arithmetic/comparison call site in the kex port to
//   use `n` suffixes and lose access to `Math.trunc`/plain arithmetic
//   operators for no real benefit. Never represent time as float seconds
//   (that's the bug class this type exists to prevent).
// - Constructing a `GTime` from a raw `number` requires exactly one `as
//   GTime` cast, confined to the private `brand()` helper below. This is
//   the branded-primitive equivalent of `vec3()`'s array allocation: the
//   one sanctioned choke point through which values enter the type. No
//   other file in this module (or any future caller) needs a cast.
// - `template<T> minutes()/seconds()` becomes two exported functions each
//   (a float variant matching the C++ default `T = float`, and an `*Int`
//   variant matching the truncating integer instantiation), since TS has
//   no return-type-polymorphic templates.
// - `frames()` reads the C++ global `gi.frame_time_ms` (game-import
//   singleton). `gi` has not been ported yet in this foundation unit (it
//   is g_local.h/g_main.c machinery, not a value type), so `Gtime_frames`
//   takes `frameTimeMs` as an explicit parameter instead of reaching for a
//   global that does not exist yet. Future call sites in the kex port will
//   pass `gi.frame_time_ms`.
// - Arithmetic operators that mutate `*this` in C++ (`+=`, `-=`, `*=`,
//   `/=`) become plain functions returning a new branded value (see the
//   Vec3 value-semantics note in q_vec3.ts / PORTING.md) rather than
//   mutating a caller's variable — a `number`-based brand cannot be
//   mutated through a reference anyway, so callers reassign:
//   `level.time = Gtime_add(level.time, FRAME_TIME_MS)`.
// - User-defined literals (`5000_ms`, `5_sec`, `2_min`, `10_hz`) have no TS
//   equivalent; call the factory functions directly (`Gtime_from_ms(5000)`).

/** Branded milliseconds. A `GTime` is a `number` at runtime — comparisons
 *  and ordering (`<`, `>`, `<=`, `>=`, `===`, `!==`) work directly. */
declare const __gtimeBrand: unique symbol;
export type GTime = number & { readonly [__gtimeBrand]: true };

// The one sanctioned cast in this module — see the deviations note above.
function brand(ms: number): GTime {
  return ms as GTime;
}

/** gtime_t() default constructor: starts at zero. */
export const GTIME_ZERO: GTime = brand(0);

// ---------------------------------------------------------------------------
// Factories (gtime_t::from_ms / from_sec / from_min / from_hz)
// ---------------------------------------------------------------------------

/** gtime_t::from_ms(ms) — new time from milliseconds. */
export function Gtime_from_ms(ms: number): GTime {
  // C++ takes `int64_t` directly; a float argument would be truncated by
  // the implicit narrowing conversion at the call site. Mirror that here.
  return brand(Math.trunc(ms));
}

/** gtime_t::from_sec(s) — new time from (possibly fractional) seconds. */
export function Gtime_from_sec(s: number): GTime {
  return brand(Math.trunc(s * 1000));
}

/** gtime_t::from_min(m) — new time from (possibly fractional) minutes. */
export function Gtime_from_min(m: number): GTime {
  return brand(Math.trunc(m * 60000));
}

/** gtime_t::from_hz(hz) — new time from a tick rate in Hz. */
export function Gtime_from_hz(hz: number): GTime {
  return Gtime_from_ms(Math.trunc((1.0 / hz) * 1000));
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** gtime_t::milliseconds() — a GTime already *is* a number of milliseconds,
 *  so this is a zero-cost widening, not a cast. */
export function Gtime_milliseconds(t: GTime): number {
  return t;
}

/** gtime_t::seconds<float>() (the C++ default template argument). */
export function Gtime_seconds(t: GTime): number {
  return t / 1000;
}

/** gtime_t::seconds<IntegralT>() — truncated integer seconds. */
export function Gtime_secondsInt(t: GTime): number {
  return Math.trunc(t / 1000);
}

/** gtime_t::minutes<float>() (the C++ default template argument). */
export function Gtime_minutes(t: GTime): number {
  return t / 60000;
}

/** gtime_t::minutes<IntegralT>() — truncated integer minutes. */
export function Gtime_minutesInt(t: GTime): number {
  return Math.trunc(t / 60000);
}

/** gtime_t::frames() — `_ms / gi.frame_time_ms`. `gi` is not ported in this
 *  foundation unit; pass the current frame_time_ms explicitly. */
export function Gtime_frames(t: GTime, frameTimeMs: number): number {
  return Math.trunc(t / frameTimeMs);
}

/** gtime_t::operator bool() — true if non-zero. */
export function Gtime_nonzero(t: GTime): boolean {
  return t !== 0;
}

// ---------------------------------------------------------------------------
// Arithmetic (each returns a fresh branded value; gtime_t has value
// semantics in C++ too — every operator here returns `gtime_t` by value).
// ---------------------------------------------------------------------------

/** gtime_t::operator-() — unary negate. */
export function Gtime_negate(t: GTime): GTime {
  return brand(-t);
}

/** gtime_t::operator+(gtime_t) */
export function Gtime_add(a: GTime, b: GTime): GTime {
  return brand(a + b);
}

/** gtime_t::operator-(gtime_t) */
export function Gtime_subtract(a: GTime, b: GTime): GTime {
  return brand(a - b);
}

/** gtime_t::operator*(T) — scalar multiply; C++: from_ms(int64_t(_ms * r)). */
export function Gtime_scale(t: GTime, r: number): GTime {
  return brand(Math.trunc(t * r));
}

/** gtime_t::operator/(T) — scalar divide; C++: from_ms(int64_t(_ms / r)). */
export function Gtime_divide(t: GTime, r: number): GTime {
  return brand(Math.trunc(t / r));
}

// Comparisons (==, !=, <, >, <=, >=) are intentionally not ported as
// functions: `GTime` is `number & brand`, so `a < b`, `a >= b`, `a === b`,
// etc. already do exactly what the C++ operators do, for free.
