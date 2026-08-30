// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// Save-data name registry -- the TS replacement for g_local.h's
// `save_data_tag_t` / `save_data_list_t` / `save_data_t<T, Tag>` machinery
// (g_local.h:487-613) and the `SAVE_DATA_FUNC`/`MMOVE_T`/`THINK`/`TOUCH`/
// `USE`/`PAIN`/`DIE`/`MONSTERINFO_*`/`MOVEINFO_*` macros that register every
// think/use/pain/die/touch/prethink/moveinfo-*/monsterinfo-* function with
// it (g_local.h:1330-1770).
//
// ============================================================================
// WHAT THE C++ SOURCE DOES
// ============================================================================
// Each macro (e.g. `THINK(foo)`) expands to a function declaration PLUS a
// `static const save_data_list_t save__foo("foo", SAVE_FUNC_THINK,
// reinterpret_cast<const void *>(foo));` -- a global, name-tagged linked-list
// node constructed at static-init time, before `main()`. `save_data_t<T,
// Tag>` (the actual field TYPE used on `edict_t`/`monsterinfo_t`, e.g.
// `save_think_t think;`) wraps a raw function pointer together with a
// pointer back to that list node, found via `save_data_list_t::fetch(ptr,
// tag)` -- an O(n) reverse lookup from pointer VALUE back to registered
// name, gated by `tag` so a `SAVE_FUNC_THINK` pointer can never collide with
// a `SAVE_FUNC_USE` pointer of the same address. JSON/binary saves persist
// the NAME (`list->name`), not the pointer; loading a save re-resolves the
// name back to the live function pointer through the same list.
//
// ============================================================================
// WHY THIS PORTS AS 25 SEPARATE MAPS, NOT ONE TAGGED LIST
// ============================================================================
// TS function values have no address to reverse-lookup and no way to be
// "the same pointer, different tag" the way two unrelated C function
// pointers can alias in a `reinterpret_cast`; a plain `Map<string,
// Function>` keyed by name (the legacy vanilla port's approach, see
// src/game/g_save.ts) already solves 90% of the problem. This unit's brief
// asks for something stronger, matching the KEX idiom's own type safety:
// "one registry per function-pointer KIND, typed by that kind's signature
// -- the C++ tags them by type too via save_data_tag_t". So instead of one
// `Map<string, Function>` shared across every kind (which would let a
// `RegisterThink`-registered function be looked up through
// `LookupUse` with no type error), this module builds one INDEPENDENT
// `Map` per kind, each closed over that kind's exact function-type alias
// (imported from ./g_local_types.ts, where each alias already corresponds
// 1:1 to a `save_*_t` field). `save_data_tag_t`'s role -- keeping the 25
// kinds from colliding -- is played by TS's static type system instead of a
// runtime enum value: `RegisterThink`/`LookupThink`/`NameOfThink` only ever
// accept/return `ThinkFn`, so a `UseFn` cannot be silently stored or
// retrieved through them. `SAVE_DATA_MMOVE` (the one non-function kind --
// whole `mmove_t` frame tables) gets the same treatment via `MmoveT`.
//
// ============================================================================
// API SHAPE
// ============================================================================
// Every kind exposes exactly three functions, mirroring the brief's
// "RegisterThink(name, fn)... each returning the function for
// assignment-site ergonomics" requirement plus explicit lookup-by-name and
// name-of-function reverse lookup:
//   RegisterX(name, value): value       -- register, return value unchanged
//                                           (so `const foo_think =
//                                           RegisterThink("foo_think", (self)
//                                           => {...})` both registers AND
//                                           assigns in one expression, the
//                                           same ergonomics `MMOVE_T(n)` /
//                                           `THINK(n)` give the C++ side).
//                                           Throws on a duplicate name
//                                           (mirroring the C++ assert that
//                                           two `save_data_list_t` nodes
//                                           never share a name+tag pair).
//   LookupX(name): value | null         -- name -> value, or null if unknown.
//   NameOfX(value): string | null       -- value -> its registered name (the
//                                           reverse direction), or null for
//                                           an unregistered value or `null`
//                                           input (mirrors `save_data_t::name()`
//                                           returning `"null"` for an unset
//                                           pointer, except this returns the
//                                           TS-idiomatic `null` instead of the
//                                           string `"null"`).
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - No `fetch`/pointer-address lookup: TS values ARE their own map keys (via
//   reference identity in the reverse `Map<T, string>`), so there is nothing
//   analogous to `save_data_list_t::fetch`'s linear scan to port.
// - No `save_data_tag_t` enum value is ported (see g_local.ts's own note on
//   this) -- the 25 exported name pairs below collectively play that role.
// - `save_data_t::operator()` (the invoke-wrapper convenience for calling
//   through the wrapped pointer) is not ported: callers already hold a
//   plain, directly-callable TS function value (there is no wrapper object
//   to unwrap first, unlike the C++ `save_data_t<T,Tag>` field type).

import type { EdictT, ModT, MmoveT } from "./g_local_types";
import type { GTime } from "./gtime";
import type { KexTraceT } from "../kexapi/game";
import type {
  MoveinfoBlockedFn,
  MoveinfoEndfuncFn,
  MonsterinfoAttackFn,
  MonsterinfoBlockedFn,
  MonsterinfoCheckattackFn,
  MonsterinfoDodgeFn,
  MonsterinfoDuckFn,
  MonsterinfoIdleFn,
  MonsterinfoMeleeFn,
  MonsterinfoPhyschangedFn,
  MonsterinfoRunFn,
  MonsterinfoSearchFn,
  MonsterinfoSetskinFn,
  MonsterinfoSidestepFn,
  MonsterinfoSightFn,
  MonsterinfoStandFn,
  MonsterinfoUnduckFn,
  MonsterinfoWalkFn,
  PainFn,
  PrethinkFn,
  ThinkFn,
  TouchFn,
  UseFn,
  DieFn,
} from "./g_local_types";

// Re-exported purely so a caller of this module never needs a second import
// from g_local_types.ts just to spell out a registered function's type.
export type {
  MoveinfoBlockedFn,
  MoveinfoEndfuncFn,
  MonsterinfoAttackFn,
  MonsterinfoBlockedFn,
  MonsterinfoCheckattackFn,
  MonsterinfoDodgeFn,
  MonsterinfoDuckFn,
  MonsterinfoIdleFn,
  MonsterinfoMeleeFn,
  MonsterinfoPhyschangedFn,
  MonsterinfoRunFn,
  MonsterinfoSearchFn,
  MonsterinfoSetskinFn,
  MonsterinfoSidestepFn,
  MonsterinfoSightFn,
  MonsterinfoStandFn,
  MonsterinfoUnduckFn,
  MonsterinfoWalkFn,
  PainFn,
  PrethinkFn,
  ThinkFn,
  TouchFn,
  UseFn,
  DieFn,
};

// Unused-otherwise imports kept for the doc comments' type references above
// and to keep this module self-contained if a future kind needs them.
export type { EdictT, GTime, KexTraceT, ModT, MmoveT };

// ---------------------------------------------------------------------------
// generic per-kind registry factory
// ---------------------------------------------------------------------------

interface Registry<T> {
  register(name: string, value: T): T;
  lookup(name: string): T | null;
  nameOf(value: T | null): string | null;
}

function makeRegistry<T extends object>(kind: string): Registry<T> {
  const byName = new Map<string, T>();
  const nameByValue = new Map<T, string>();

  return {
    register(name: string, value: T): T {
      if (byName.has(name)) {
        throw new Error(`g_save_registry: duplicate ${kind} registration for name "${name}"`);
      }
      byName.set(name, value);
      nameByValue.set(value, name);
      return value;
    },
    lookup(name: string): T | null {
      return byName.get(name) ?? null;
    },
    nameOf(value: T | null): string | null {
      if (value === null) return null;
      return nameByValue.get(value) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// SAVE_DATA_MMOVE
// ---------------------------------------------------------------------------

const mmoveRegistry = makeRegistry<MmoveT>("mmove");
export function RegisterMmove(name: string, value: MmoveT): MmoveT {
  return mmoveRegistry.register(name, value);
}
export function LookupMmove(name: string): MmoveT | null {
  return mmoveRegistry.lookup(name);
}
export function NameOfMmove(value: MmoveT | null): string | null {
  return mmoveRegistry.nameOf(value);
}

// ---------------------------------------------------------------------------
// SAVE_FUNC_PRETHINK / THINK / TOUCH / USE / PAIN / DIE
// ---------------------------------------------------------------------------

const prethinkRegistry = makeRegistry<PrethinkFn>("prethink");
export function RegisterPrethink(name: string, fn: PrethinkFn): PrethinkFn {
  return prethinkRegistry.register(name, fn);
}
export function LookupPrethink(name: string): PrethinkFn | null {
  return prethinkRegistry.lookup(name);
}
export function NameOfPrethink(fn: PrethinkFn | null): string | null {
  return prethinkRegistry.nameOf(fn);
}

const thinkRegistry = makeRegistry<ThinkFn>("think");
export function RegisterThink(name: string, fn: ThinkFn): ThinkFn {
  return thinkRegistry.register(name, fn);
}
export function LookupThink(name: string): ThinkFn | null {
  return thinkRegistry.lookup(name);
}
export function NameOfThink(fn: ThinkFn | null): string | null {
  return thinkRegistry.nameOf(fn);
}

const touchRegistry = makeRegistry<TouchFn>("touch");
export function RegisterTouch(name: string, fn: TouchFn): TouchFn {
  return touchRegistry.register(name, fn);
}
export function LookupTouch(name: string): TouchFn | null {
  return touchRegistry.lookup(name);
}
export function NameOfTouch(fn: TouchFn | null): string | null {
  return touchRegistry.nameOf(fn);
}

const useRegistry = makeRegistry<UseFn>("use");
export function RegisterUse(name: string, fn: UseFn): UseFn {
  return useRegistry.register(name, fn);
}
export function LookupUse(name: string): UseFn | null {
  return useRegistry.lookup(name);
}
export function NameOfUse(fn: UseFn | null): string | null {
  return useRegistry.nameOf(fn);
}

const painRegistry = makeRegistry<PainFn>("pain");
export function RegisterPain(name: string, fn: PainFn): PainFn {
  return painRegistry.register(name, fn);
}
export function LookupPain(name: string): PainFn | null {
  return painRegistry.lookup(name);
}
export function NameOfPain(fn: PainFn | null): string | null {
  return painRegistry.nameOf(fn);
}

const dieRegistry = makeRegistry<DieFn>("die");
export function RegisterDie(name: string, fn: DieFn): DieFn {
  return dieRegistry.register(name, fn);
}
export function LookupDie(name: string): DieFn | null {
  return dieRegistry.lookup(name);
}
export function NameOfDie(fn: DieFn | null): string | null {
  return dieRegistry.nameOf(fn);
}

// ---------------------------------------------------------------------------
// SAVE_FUNC_MOVEINFO_ENDFUNC / MOVEINFO_BLOCKED
// ---------------------------------------------------------------------------

const moveinfoEndfuncRegistry = makeRegistry<MoveinfoEndfuncFn>("moveinfo_endfunc");
export function RegisterMoveinfoEndfunc(name: string, fn: MoveinfoEndfuncFn): MoveinfoEndfuncFn {
  return moveinfoEndfuncRegistry.register(name, fn);
}
export function LookupMoveinfoEndfunc(name: string): MoveinfoEndfuncFn | null {
  return moveinfoEndfuncRegistry.lookup(name);
}
export function NameOfMoveinfoEndfunc(fn: MoveinfoEndfuncFn | null): string | null {
  return moveinfoEndfuncRegistry.nameOf(fn);
}

const moveinfoBlockedRegistry = makeRegistry<MoveinfoBlockedFn>("moveinfo_blocked");
export function RegisterMoveinfoBlocked(name: string, fn: MoveinfoBlockedFn): MoveinfoBlockedFn {
  return moveinfoBlockedRegistry.register(name, fn);
}
export function LookupMoveinfoBlocked(name: string): MoveinfoBlockedFn | null {
  return moveinfoBlockedRegistry.lookup(name);
}
export function NameOfMoveinfoBlocked(fn: MoveinfoBlockedFn | null): string | null {
  return moveinfoBlockedRegistry.nameOf(fn);
}

// ---------------------------------------------------------------------------
// SAVE_FUNC_MONSTERINFO_* (11 "stand"-shaped kinds + 5 rogue-era kinds)
// ---------------------------------------------------------------------------

const monsterinfoStandRegistry = makeRegistry<MonsterinfoStandFn>("monsterinfo_stand");
export function RegisterMonsterinfoStand(name: string, fn: MonsterinfoStandFn): MonsterinfoStandFn {
  return monsterinfoStandRegistry.register(name, fn);
}
export function LookupMonsterinfoStand(name: string): MonsterinfoStandFn | null {
  return monsterinfoStandRegistry.lookup(name);
}
export function NameOfMonsterinfoStand(fn: MonsterinfoStandFn | null): string | null {
  return monsterinfoStandRegistry.nameOf(fn);
}

const monsterinfoIdleRegistry = makeRegistry<MonsterinfoIdleFn>("monsterinfo_idle");
export function RegisterMonsterinfoIdle(name: string, fn: MonsterinfoIdleFn): MonsterinfoIdleFn {
  return monsterinfoIdleRegistry.register(name, fn);
}
export function LookupMonsterinfoIdle(name: string): MonsterinfoIdleFn | null {
  return monsterinfoIdleRegistry.lookup(name);
}
export function NameOfMonsterinfoIdle(fn: MonsterinfoIdleFn | null): string | null {
  return monsterinfoIdleRegistry.nameOf(fn);
}

const monsterinfoSearchRegistry = makeRegistry<MonsterinfoSearchFn>("monsterinfo_search");
export function RegisterMonsterinfoSearch(name: string, fn: MonsterinfoSearchFn): MonsterinfoSearchFn {
  return monsterinfoSearchRegistry.register(name, fn);
}
export function LookupMonsterinfoSearch(name: string): MonsterinfoSearchFn | null {
  return monsterinfoSearchRegistry.lookup(name);
}
export function NameOfMonsterinfoSearch(fn: MonsterinfoSearchFn | null): string | null {
  return monsterinfoSearchRegistry.nameOf(fn);
}

const monsterinfoWalkRegistry = makeRegistry<MonsterinfoWalkFn>("monsterinfo_walk");
export function RegisterMonsterinfoWalk(name: string, fn: MonsterinfoWalkFn): MonsterinfoWalkFn {
  return monsterinfoWalkRegistry.register(name, fn);
}
export function LookupMonsterinfoWalk(name: string): MonsterinfoWalkFn | null {
  return monsterinfoWalkRegistry.lookup(name);
}
export function NameOfMonsterinfoWalk(fn: MonsterinfoWalkFn | null): string | null {
  return monsterinfoWalkRegistry.nameOf(fn);
}

const monsterinfoRunRegistry = makeRegistry<MonsterinfoRunFn>("monsterinfo_run");
export function RegisterMonsterinfoRun(name: string, fn: MonsterinfoRunFn): MonsterinfoRunFn {
  return monsterinfoRunRegistry.register(name, fn);
}
export function LookupMonsterinfoRun(name: string): MonsterinfoRunFn | null {
  return monsterinfoRunRegistry.lookup(name);
}
export function NameOfMonsterinfoRun(fn: MonsterinfoRunFn | null): string | null {
  return monsterinfoRunRegistry.nameOf(fn);
}

const monsterinfoDodgeRegistry = makeRegistry<MonsterinfoDodgeFn>("monsterinfo_dodge");
export function RegisterMonsterinfoDodge(name: string, fn: MonsterinfoDodgeFn): MonsterinfoDodgeFn {
  return monsterinfoDodgeRegistry.register(name, fn);
}
export function LookupMonsterinfoDodge(name: string): MonsterinfoDodgeFn | null {
  return monsterinfoDodgeRegistry.lookup(name);
}
export function NameOfMonsterinfoDodge(fn: MonsterinfoDodgeFn | null): string | null {
  return monsterinfoDodgeRegistry.nameOf(fn);
}

const monsterinfoAttackRegistry = makeRegistry<MonsterinfoAttackFn>("monsterinfo_attack");
export function RegisterMonsterinfoAttack(name: string, fn: MonsterinfoAttackFn): MonsterinfoAttackFn {
  return monsterinfoAttackRegistry.register(name, fn);
}
export function LookupMonsterinfoAttack(name: string): MonsterinfoAttackFn | null {
  return monsterinfoAttackRegistry.lookup(name);
}
export function NameOfMonsterinfoAttack(fn: MonsterinfoAttackFn | null): string | null {
  return monsterinfoAttackRegistry.nameOf(fn);
}

const monsterinfoMeleeRegistry = makeRegistry<MonsterinfoMeleeFn>("monsterinfo_melee");
export function RegisterMonsterinfoMelee(name: string, fn: MonsterinfoMeleeFn): MonsterinfoMeleeFn {
  return monsterinfoMeleeRegistry.register(name, fn);
}
export function LookupMonsterinfoMelee(name: string): MonsterinfoMeleeFn | null {
  return monsterinfoMeleeRegistry.lookup(name);
}
export function NameOfMonsterinfoMelee(fn: MonsterinfoMeleeFn | null): string | null {
  return monsterinfoMeleeRegistry.nameOf(fn);
}

const monsterinfoSightRegistry = makeRegistry<MonsterinfoSightFn>("monsterinfo_sight");
export function RegisterMonsterinfoSight(name: string, fn: MonsterinfoSightFn): MonsterinfoSightFn {
  return monsterinfoSightRegistry.register(name, fn);
}
export function LookupMonsterinfoSight(name: string): MonsterinfoSightFn | null {
  return monsterinfoSightRegistry.lookup(name);
}
export function NameOfMonsterinfoSight(fn: MonsterinfoSightFn | null): string | null {
  return monsterinfoSightRegistry.nameOf(fn);
}

const monsterinfoCheckattackRegistry = makeRegistry<MonsterinfoCheckattackFn>("monsterinfo_checkattack");
export function RegisterMonsterinfoCheckattack(name: string, fn: MonsterinfoCheckattackFn): MonsterinfoCheckattackFn {
  return monsterinfoCheckattackRegistry.register(name, fn);
}
export function LookupMonsterinfoCheckattack(name: string): MonsterinfoCheckattackFn | null {
  return monsterinfoCheckattackRegistry.lookup(name);
}
export function NameOfMonsterinfoCheckattack(fn: MonsterinfoCheckattackFn | null): string | null {
  return monsterinfoCheckattackRegistry.nameOf(fn);
}

const monsterinfoSetskinRegistry = makeRegistry<MonsterinfoSetskinFn>("monsterinfo_setskin");
export function RegisterMonsterinfoSetskin(name: string, fn: MonsterinfoSetskinFn): MonsterinfoSetskinFn {
  return monsterinfoSetskinRegistry.register(name, fn);
}
export function LookupMonsterinfoSetskin(name: string): MonsterinfoSetskinFn | null {
  return monsterinfoSetskinRegistry.lookup(name);
}
export function NameOfMonsterinfoSetskin(fn: MonsterinfoSetskinFn | null): string | null {
  return monsterinfoSetskinRegistry.nameOf(fn);
}

const monsterinfoBlockedRegistry = makeRegistry<MonsterinfoBlockedFn>("monsterinfo_blocked");
export function RegisterMonsterinfoBlocked(name: string, fn: MonsterinfoBlockedFn): MonsterinfoBlockedFn {
  return monsterinfoBlockedRegistry.register(name, fn);
}
export function LookupMonsterinfoBlocked(name: string): MonsterinfoBlockedFn | null {
  return monsterinfoBlockedRegistry.lookup(name);
}
export function NameOfMonsterinfoBlocked(fn: MonsterinfoBlockedFn | null): string | null {
  return monsterinfoBlockedRegistry.nameOf(fn);
}

const monsterinfoDuckRegistry = makeRegistry<MonsterinfoDuckFn>("monsterinfo_duck");
export function RegisterMonsterinfoDuck(name: string, fn: MonsterinfoDuckFn): MonsterinfoDuckFn {
  return monsterinfoDuckRegistry.register(name, fn);
}
export function LookupMonsterinfoDuck(name: string): MonsterinfoDuckFn | null {
  return monsterinfoDuckRegistry.lookup(name);
}
export function NameOfMonsterinfoDuck(fn: MonsterinfoDuckFn | null): string | null {
  return monsterinfoDuckRegistry.nameOf(fn);
}

const monsterinfoUnduckRegistry = makeRegistry<MonsterinfoUnduckFn>("monsterinfo_unduck");
export function RegisterMonsterinfoUnduck(name: string, fn: MonsterinfoUnduckFn): MonsterinfoUnduckFn {
  return monsterinfoUnduckRegistry.register(name, fn);
}
export function LookupMonsterinfoUnduck(name: string): MonsterinfoUnduckFn | null {
  return monsterinfoUnduckRegistry.lookup(name);
}
export function NameOfMonsterinfoUnduck(fn: MonsterinfoUnduckFn | null): string | null {
  return monsterinfoUnduckRegistry.nameOf(fn);
}

const monsterinfoSidestepRegistry = makeRegistry<MonsterinfoSidestepFn>("monsterinfo_sidestep");
export function RegisterMonsterinfoSidestep(name: string, fn: MonsterinfoSidestepFn): MonsterinfoSidestepFn {
  return monsterinfoSidestepRegistry.register(name, fn);
}
export function LookupMonsterinfoSidestep(name: string): MonsterinfoSidestepFn | null {
  return monsterinfoSidestepRegistry.lookup(name);
}
export function NameOfMonsterinfoSidestep(fn: MonsterinfoSidestepFn | null): string | null {
  return monsterinfoSidestepRegistry.nameOf(fn);
}

const monsterinfoPhyschangedRegistry = makeRegistry<MonsterinfoPhyschangedFn>("monsterinfo_physicschange");
export function RegisterMonsterinfoPhyschanged(name: string, fn: MonsterinfoPhyschangedFn): MonsterinfoPhyschangedFn {
  return monsterinfoPhyschangedRegistry.register(name, fn);
}
export function LookupMonsterinfoPhyschanged(name: string): MonsterinfoPhyschangedFn | null {
  return monsterinfoPhyschangedRegistry.lookup(name);
}
export function NameOfMonsterinfoPhyschanged(fn: MonsterinfoPhyschangedFn | null): string | null {
  return monsterinfoPhyschangedRegistry.nameOf(fn);
}
