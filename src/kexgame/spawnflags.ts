// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Ported from g_local.h's `spawnflags_t` (lines ~184-235 of the 2023 kex
// game module, ~/Projects/quake2-rerelease-dll/rerelease/g_local.h):
//
//   struct spawnflags_t {
//       uint32_t value;
//       explicit constexpr spawnflags_t(uint32_t v) : value(v) {}
//       explicit operator uint32_t() const;
//       constexpr bool any() const { return !!value; }
//       constexpr bool has(const spawnflags_t &flags) const { return !!(value & flags.value); }
//       constexpr bool has_all(const spawnflags_t &flags) const { return (value & flags.value) == flags.value; }
//       constexpr bool operator!() const { return !value; }
//       operator==, !=
//       operator~, |, &, ^, |=, &=, ^=
//   };
//
// Scope note: this file ports only the generic uint32 wrapper and its
// methods/operators, exactly as briefed. The reserved-bit constants that
// follow it in g_local.h (SPAWNFLAG_NOT_EASY, SPAWNFLAG_EDITOR_MASK, etc.)
// and the `""_spawnflag` / `""_spawnflag_bit` user-defined-literal factories
// that validate against that mask are declared alongside the rest of the
// edict/spawn system in g_local.h and are out of scope for this foundation
// unit — they will land with the g_local.ts port. At that point the C++
// literal suffixes (`0x00010000_spawnflag`, `4_spawnflag_bit`) become plain
// calls to `SpawnFlags_from(v)` / a `SpawnFlags_fromBit(bit)` helper that
// throws the same "reserved spawnflag" error the C++ literal operators do.
//
// DEVIATIONS FROM THE C++ SOURCE:
//
// - Design: branded `number` + free functions, per the brief and matching
//   this module's `GTime` (gtime.ts) and the repo's general free-function
//   idiom for value types (vec3 in shared/math.ts; q_vec3.ts here).
// - `explicit operator uint32_t()` (the C++ cast back to a raw uint32) is
//   `SpawnFlags_value()` below; a branded `number` already widens to
//   `number` for free anywhere a plain number is expected, so this
//   accessor exists purely for symmetry/documentation, like
//   `Gtime_milliseconds`.
// - `operator!()` (`!value`) is the logical negation of `any()`; ported as
//   `SpawnFlags_none()` rather than a bare `!`, since TS has no operator
//   overloading and `!spawnflags` would just test object truthiness (always
//   true for a non-zero *branded number*, but misleading to write).
// - `==`/`!=` are not ported as functions: a `SpawnFlags` value is a
//   `number` at runtime, so `a === b` / `a !== b` already do the right
//   thing, exactly like GTime's comparisons.
// - Bitwise operators (`~`, `|`, `&`, `^`) always re-brand through
//   `>>> 0` so the stored value stays in uint32 range; JS's bitwise
//   operators otherwise produce signed int32 results (e.g. `~0` is `-1`,
//   not `0xFFFFFFFF`). This matches `uint32_t` wraparound semantics.
// - The C++ compound-assignment operators (`|=`, `&=`, `^=`) mutate
//   `*this`; since `SpawnFlags` is an immutable branded number (not an
//   object with fields to mutate), they are not ported as separate
//   mutating functions — callers reassign, e.g.
//   `flags = SpawnFlags_or(flags, SPAWNFLAG_NOT_EASY)`, the same pattern
//   used for GTime's `+=`/`-=`.

/** Branded uint32. A `SpawnFlags` is a `number` at runtime — `===`/`!==`
 *  work directly. */
declare const __spawnflagsBrand: unique symbol;
export type SpawnFlags = number & { readonly [__spawnflagsBrand]: true };

// The one sanctioned cast in this module — see the deviations note above.
function brand(v: number): SpawnFlags {
  return (v >>> 0) as SpawnFlags;
}

/** spawnflags_t(uint32_t v) — explicit constructor from a raw value. */
export function SpawnFlags_from(v: number): SpawnFlags {
  return brand(v);
}

/** A zero spawnflags value (no flags set). */
export const SPAWNFLAGS_NONE: SpawnFlags = brand(0);

/** spawnflags_t::operator uint32_t() — explicit cast back to a raw value.
 *  Zero-cost: see the deviations note above. */
export function SpawnFlags_value(f: SpawnFlags): number {
  return f;
}

/** spawnflags_t's any() method — has any flags at all (`!!value`). */
export function SpawnFlags_any(f: SpawnFlags): boolean {
  return f !== 0;
}

/** spawnflags_t::operator!() — has no flags at all (`!value`). */
export function SpawnFlags_none(f: SpawnFlags): boolean {
  return f === 0;
}

/** spawnflags_t::has(flags) — has any of the given flags (`!!(a & b)`). */
export function SpawnFlags_has(f: SpawnFlags, flags: SpawnFlags): boolean {
  return (f & flags) !== 0;
}

/** spawnflags_t::has_all(flags) — has all of the given flags (`(a & b) == b`). */
export function SpawnFlags_has_all(f: SpawnFlags, flags: SpawnFlags): boolean {
  return (f & flags) === flags;
}

/** spawnflags_t::operator~() — bitwise complement, re-branded to uint32. */
export function SpawnFlags_not(f: SpawnFlags): SpawnFlags {
  return brand(~f);
}

/** spawnflags_t::operator|(v2) */
export function SpawnFlags_or(a: SpawnFlags, b: SpawnFlags): SpawnFlags {
  return brand(a | b);
}

/** spawnflags_t::operator&(v2) */
export function SpawnFlags_and(a: SpawnFlags, b: SpawnFlags): SpawnFlags {
  return brand(a & b);
}

/** spawnflags_t::operator^(v2) */
export function SpawnFlags_xor(a: SpawnFlags, b: SpawnFlags): SpawnFlags {
  return brand(a ^ b);
}
