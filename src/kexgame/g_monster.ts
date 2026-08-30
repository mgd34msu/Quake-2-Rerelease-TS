// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_monster.c -- monster utility functions (2023 Quake II re-release / "KEX"
// engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/g_monster.cpp
// (1,649 lines, C++17): the monster_fire_* weapon-wrapper family,
// M_CheckGround/M_CatagorizePosition/M_WorldEffects/M_droptofloor* (the three
// throwing stubs g_phys.ts left pending -- see this file's stub-swap section
// below), M_SetEffects/M_SetAnimation/M_MoveFrame, M_ProcessPain (the KEX
// deferred-pain-queue drain), monster_think/monster_use/monster_dead*,
// monster_triggered_*/monster_death_use, monster_start/monster_start_go and
// the walk/fly/swim monster start wrappers, G_Monster_ScaleCoopHealth/
// G_Monster_CheckCoopHealthScaling, and trigger_health_relay. Behavioral
// code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// STUB SWAP: g_phys.ts's three throwing stubs are now real imports from here
// ============================================================================
// g_phys.ts's header ("CROSS-DEPENDENCIES NOT YET PORTED") named exactly
// three functions it could not port faithfully because this file did not
// exist yet: M_CheckGround(ent, mask), M_CatagorizePosition(self, in_point),
// M_WorldEffects(ent). All three are real exports below; g_phys.ts's own
// three local throwing stubs and its now-satisfied cross-dependency note are
// removed, replaced with `import { M_CheckGround, M_CatagorizePosition,
// M_WorldEffects } from "./g_monster"`. This creates a real, sanctioned
// import cycle: g_phys.ts now imports these three from g_monster.ts, while
// g_monster.ts imports G_GetClipMask from g_phys.ts (M_droptofloor,
// G_FixStuckObject). Exactly the same shape as the already-sanctioned
// g_utils.ts<->g_phys.ts cycle documented in g_phys.ts's own header: every
// cross-module symbol on both sides is a hoisted `export function`
// declaration (or a top-level `const` whose initializer is only READ inside
// a closure body, never at module-init time -- e.g. `monster_think`'s
// `RegisterThink(...)` call captures `M_CheckGround`/`M_CatagorizePosition`/
// `M_WorldEffects` by reference in a closure that isn't invoked until a real
// game frame runs, long after both modules have finished linking). No TDZ
// hazard. Verified end-to-end by `bunx tsc --noEmit` and `bun test` actually
// importing both files together.
//
// g_phys.ts's own header documented one more open question this file
// resolves: "M_CatagorizePosition's out-param signature ... this stub's
// signature drops the two out-params in favor of mutating `self` directly
// once implemented." RULING: `M_CatagorizePosition(self, in_point)` mutates
// `self.waterlevel`/`self.watertype` directly and returns `void` -- matching
// every real call site in the whole rerelease tree (g_phys.cpp's own three
// call sites, and this file's own four), which all pass `ent->waterlevel`/
// `ent->watertype` (the entity's OWN fields) as the C++ by-reference
// out-params. There is no call site anywhere that passes a DIFFERENT
// entity's water state, so the two-out-param C++ signature is pure
// boilerplate for "write back into self" -- dropped, not preserved, per
// PORTING.md's "C reference out-params that always alias the same field die
// at the call site" precedent (already used by AngleVectors's `forward`/
// `right`/`up` in-place mutation, and `M_droptofloor_generic`'s `origin`
// below, which DOES keep its out-param because different call sites pass
// genuinely different origins).
//
// NOTE: g_utils.ts ALSO has a throwing stub for `G_MonsterKilled(self)`
// (g_monster.cpp:613, its own header line 65: "future src/kexgame/
// g_monster.ts") that this file's real `G_MonsterKilled` export below could
// satisfy. It is deliberately NOT swapped here -- this unit's file scope is
// g_monster.ts + g_phys.ts's stub swap + the test file, and g_utils.ts is
// not in that list. A future unit should replace g_utils.ts's local stub
// with `import { G_MonsterKilled } from "./g_monster"`, mirroring exactly
// the g_phys.ts swap done in THIS unit.
//
// ============================================================================
// M_CheckClearShot's TWO C++ OVERLOADS -> ONE function with an optional
// out-param
// ============================================================================
// `bool M_CheckClearShot(edict_t*, const vec3_t&, vec3_t& start)` and `bool
// M_CheckClearShot(edict_t*, const vec3_t&)` (the second just discards the
// computed start) collapse to one function, `start` an optional Vec3
// out-param mutated via `VectorCopy` when supplied -- the same "C reference
// out-param that isn't always wanted" shape `AngleVectors`'s nullable
// `forward`/`right`/`up` params already established in q_vec3.ts.
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY (declared/defined in g_local.h,
// not g_monster.cpp, but needed here first)
// ============================================================================
// - `gi.traceline(start, end, passent, mask)` (g_local.h:136-139): an inline
//   `game_import_t` convenience method wrapping `trace(start, nullptr,
//   nullptr, end, passent, mask)`. Not part of this port's `KexGameImports`
//   (src/kexapi/game.ts mirrors the DLL-facing `game_import_t` from game.h,
//   not g_local.h's header-only convenience wrappers) and not ported
//   anywhere else in src/kexgame/ yet (grepped every file). Ported here as
//   the local `giTraceline` helper, exactly the trivial wrapper the header
//   itself is.
// - `G_PowerUpExpiring`/`G_PowerUpExpiringRelative` (g_local.h:2640-2647):
//   same placement-mismatch treatment as g_utils.ts's own `G_FindByString`
//   note and this file's own header precedent -- declared/defined in
//   g_local.h, needed first by this file's `M_SetEffects` (g_monster.cpp's
//   own scope), ported locally.
//
// ============================================================================
// `st` (spawn_temp_t) -- NOT a shared global anywhere in this port line yet
// ============================================================================
// `monster_start`'s `if (st.item) self->item = FindItemByClassname(st.item);`
// reads the C++ global `extern spawn_temp_t st;`, populated by
// ED_ParseField during entity spawning (g_spawn.cpp). No src/kexgame/
// g_spawn.ts exists yet (confirmed by directory listing), so there is no
// shared home for that global to live in, and this unit's file scope does
// not include creating one in g_main_globals.ts. A local, file-scoped `st:
// { item: string | null }` placeholder stands in -- only the one field this
// file actually reads -- permanently `{ item: null }` (no setter is
// exported; nothing in this port line can populate it yet). This means
// `monster_start`'s `if (st.item)` branch is always false today, so
// `FindItemByClassname` (itself an unported g_items.cpp stub, see below) is
// never actually reached by any real call path -- an honest, documented
// consequence of the missing upstream global, not a silent behavior change:
// once g_spawn.ts lands and wires up a real `st`, this placeholder should be
// deleted and replaced with a shared import.
//
// ============================================================================
// CROSS-DEPENDENCIES NOT YET PORTED
// ============================================================================
// g_monster.cpp calls into several other, not-yet-ported C++ files (grepped
// quake2-rerelease-dll/rerelease/*.cpp for each symbol's real definition,
// not just its g_local.h declaration):
//   - fire_bullet/fire_shotgun/fire_blaster/fire_flechette/fire_grenade/
//     fire_rocket/fire_rail/fire_bfg -> g_weapon.cpp (future g_weapon.ts).
//     Reached only through this file's own monster_fire_* wrappers.
//   - FoundTarget                    -> g_ai.cpp:484 (future g_ai.ts).
//   - M_CheckAttack                  -> g_ai.cpp:1093 (future g_ai.ts).
//     `monster_start`'s `MONSTERINFO_CHECKATTACK(M_CheckAttack)` default
//     assignment is preserved (`self.monsterinfo.checkattack ??=
//     M_CheckAttack`-shaped), so the stub is registered under its real save
//     name via RegisterMonsterinfoCheckattack -- once g_ai.ts lands, delete
//     this file's stub and let g_ai.ts's own real implementation register
//     under the same name instead (mirroring the g_phys.ts swap pattern).
//   - M_walkmove                     -> m_move.cpp:1479 (future m_move.ts).
//     Reached by monster_start_go's stuck-check/nudge logic.
//   - FindItemByClassname/Drop_Item  -> g_items.cpp (future g_items.ts).
//     FindItemByClassname is unreachable today (see the `st` note above);
//     Drop_Item is reached by monster_death_use whenever a dying monster
//     carries an item.
//   - cleanupHealTarget              -> m_medic.cpp (ROGUE mission pack;
//     out of this port line's current scope). Reached only by
//     M_ProcessPain's AI_MEDIC branch.
// Each is a local, unexported (fire_*/FoundTarget/M_walkmove/
// FindItemByClassname/Drop_Item/cleanupHealTarget) or save-registered
// (M_CheckAttack) throwing stub, naming itself and the file that owns the
// real implementation, per PORTING.md's "a function you cannot port
// faithfully is a reported deviation, not a TODO". None of these are
// exercised by this unit's own test suite (its fixtures stick to
// M_CheckGround/M_CatagorizePosition/M_WorldEffects/M_droptofloor/
// M_ProcessPain/M_SetAnimation/monster_death_use, per this unit's brief).
//
// `stationarymonster_start` is a SPECIAL case, not the usual "future file"
// stub: it is declared in g_local.h:2240 and called from m_insane.cpp:686,
// but grepping every single *.cpp in the shipped rerelease source tree for
// its definition (not just callers) finds NOTHING -- it does not exist
// anywhere in this codebase. This is a genuine hole in the upstream C++
// source, not a porting gap on this side; ported as a throwing stub that
// says exactly that, rather than guessing at a body that was never shipped.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `trigger_health_relay`: `SP_trigger_health_relay` validates `self.speed`
//   as a 0-100 PERCENTAGE ("has bad \"speed\" (health percentage); must be
//   between 0 and 100"), but `trigger_health_relay_use` compares it directly
//   against `percent_health` (`other->health / other->max_health`, a 0-1
//   FRACTION via `clamp(...,0.f,1.f)`) with no /100 anywhere. A relay
//   configured with e.g. `speed 50` (the documented "half health" case)
//   never fires, since a 0-1 fraction is never > 50. This looks like a
//   genuine pre-existing bug in the shipped C++ source (verified by reading
//   the whole function twice); preserved exactly, not fixed, per the
//   bug-for-bug mandate.
// - `dodge`'s attacker parameter (`MonsterinfoDodgeFn`) is typed non-null
//   (`attacker: EdictT`), but the C++ call site passes `ent->owner`
//   (`edict_t *`, nullable in the struct's own type). `M_CheckDodgeFilter`
//   below adds an explicit `if (ent.owner === null) return ...Skip` guard
//   before calling `dodge` -- a real projectile with `SVF_PROJECTILE|
//   FL_DODGE` set always has an owner in practice (whoever fired it), so
//   this is a type-safety-driven addition that should never actually change
//   behavior, not a cast.
// - `M_ProcessPain`'s `e->die(e, e->monsterinfo.damage_inflictor,
//   e->monsterinfo.damage_attacker, ...)` similarly reads two
//   `EdictT | null` fields into non-null `DieFn`/`PainFn` parameters.
//   g_combat.ts's `T_Damage` (g_combat.ts:1026-1030, 1057-1061) always sets
//   `damage_attacker`/`damage_inflictor` to real, non-null entities in the
//   SAME statement group that increments `damage_blood` -- so by the time
//   `M_ProcessPain`'s own top-of-function `if (!e.monsterinfo.damage_blood)
//   return;` guard lets execution through, both fields are guaranteed
//   non-null. Ported as an explicit runtime null-check that THROWS if that
//   invariant is ever violated (never silently narrows via `!`/`as`), per
//   this port's zero-cast policy -- a defect elsewhere would surface loudly
//   here instead of passing a bogus null through to a `DieFn`/`PainFn` body
//   that assumes non-null.
// - `monster_start_go`'s spawn-dead simulation loop is `for (size_t i =
//   move->firstframe; i < move->lastframe; i++)` -- strictly LESS than
//   `lastframe`, so the move table's own last frame's thinkfunc never runs
//   during the spawn-dead simulation (only frames `[firstframe,
//   lastframe)`). Verified against the actual C++ source twice; preserved
//   exactly as an apparent off-by-one, not "corrected" to `<=`.
// - `M_MoveFrame`'s post-endfunc `move = self->monsterinfo.active_move.
//   pointer();` re-read is followed immediately by unchecked pointer use in
//   the C++ source (no null check -- UB if `active_move` somehow became
//   null). TS requires a null check to keep using `move.firstframe` etc.
//   afterward; ported as a THROW (not a silent early return) if this ever
//   happens, documenting the implicit non-null invariant the C++ source
//   relies on without a defensive early-out.
//
// ============================================================================
// SAVE-REGISTERED FUNCTIONS (via g_save_registry.ts)
// ============================================================================
// Every function the C++ source wraps in a THINK(...)/USE(...) macro is
// registered under its exact C++ name: monster_dead_think (THINK),
// monster_think (THINK), monster_use (USE), monster_triggered_spawn
// (THINK), monster_triggered_spawn_use (USE), monster_triggered_think
// (THINK), walkmonster_start_go/flymonster_start_go/swimmonster_start_go
// (THINK), trigger_health_relay_use (USE), plus M_CheckAttack (registered
// as the stub it currently is, see above) under
// SAVE_FUNC_MONSTERINFO_CHECKATTACK's real name via
// RegisterMonsterinfoCheckattack. Plain `void`-returning C++ functions with
// no THINK/USE/etc. wrapper (monster_dead, monster_triggered_start,
// monster_death_use, monster_start, monster_start_go, G_FixStuckObject,
// walkmonster_start/flymonster_start/swimmonster_start,
// SP_trigger_health_relay, and every M_*/G_Monster_* helper) are plain
// exported functions, not save-registered, matching the C++ source's own
// lack of a SAVE_FUNC_* wrapper on them.

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import {
  type KexEdictT,
  type KexTraceT,
  type PathRequest,
  type PathInfo,
  type BoxEdictsFilterT,
  ContentsT,
  SvflagsT,
  SolidT,
  SolidityAreaT,
  BoxEdictsResultT,
  MASK_MONSTERSOLID,
  MASK_PROJECTILE,
  MASK_SOLID,
  MASK_WATER,
  WaterLevelT,
  EffectsT,
  RenderfxT,
  ServerCommandT,
  ServerFlagsT,
  KexMulticastT,
  MonsterMuzzleflashIdT,
  CvarFlagsT,
  SoundchanT,
  ATTN_NORM,
  PathReturnCode,
  PathLinkType,
  PathFlags,
  rgba_red,
  rgba_blue,
} from "../kexapi/game";
import {
  type EdictT,
  type GitemT,
  type MmoveT,
  type ModT,
  type ThinkFn,
  type UseFn,
  type MonsterinfoCheckattackFn,
  MovetypeT,
  EntFlagsT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  CombatStyleT,
  ItemIdT,
  ModIdT,
  DamageflagsT,
  StuckResultT,
  HOLD_FOREVER,
  HACKFLAG_ATTACK_PLAYER,
  HACKFLAG_END_CUTSCENE,
  SPAWNFLAG_MONSTER_AMBUSH,
  SPAWNFLAG_MONSTER_TRIGGER_SPAWN,
  SPAWNFLAG_MONSTER_DEAD,
  SPAWNFLAG_MONSTER_NO_DROP,
  SPAWNFLAG_MONSTER_SCENIC,
  SPAWNFLAG_FIXBOT_FIXIT,
  SPAWNFLAG_FIXBOT_TAKEOFF,
  SPAWNFLAG_FIXBOT_LANDING,
  AI_SPAWNED_MASK,
  random_time,
} from "./g_local";
import { gi, globals, g_edicts, level } from "./g_main_globals";
import {
  GTIME_ZERO,
  Gtime_add,
  Gtime_subtract,
  Gtime_from_ms,
  Gtime_from_sec,
  Gtime_from_hz,
  Gtime_milliseconds,
  Gtime_seconds,
  type GTime,
} from "./gtime";
import { type SpawnFlags, SpawnFlags_has, SpawnFlags_from, SpawnFlags_and, SpawnFlags_or, SpawnFlags_not } from "./spawnflags";
import {
  vec3_origin,
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_mulEqs,
  vec3_dot,
  vec3_length,
  vec3_lengthSquared,
  vec3_normalized,
  AngleVectors,
  vectoyaw,
  G_ProjectSource,
} from "./q_vec3";
import { YAW, clamp, frandom, brandom, irandom } from "./q_std";
import { G_FreeEdict, G_FindByString, G_PickTarget, G_UseTargets, KillBox } from "./g_utils";
import { T_Damage } from "./g_combat";
import { G_GetClipMask } from "./g_phys";
import { M_walkmove } from "./m_move";
import { G_FixStuckObject_Generic } from "./p_move";
import type { StuckObjectTraceFn } from "./bg_local";
import { RegisterThink, RegisterUse, RegisterMonsterinfoCheckattack } from "./g_save_registry";

// ---------------------------------------------------------------------------
// small local helpers -- see file header for each
// ---------------------------------------------------------------------------

function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

/** See g_phys.ts's own "FRAME_TIME_S" note -- same gap, same workaround. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** EDICT_NUM idiom -- see g_phys.ts's own `traceEdict` for the full rationale. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** g_local.h:136-139 `game_import_t::traceline` -- see file header. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** g_local.h:2640-2647 -- see file header. */
function G_PowerUpExpiringRelative(left: GTime): boolean {
  const ms = Gtime_milliseconds(left);
  return ms > 3000 || ms % 1000 < 500;
}
function G_PowerUpExpiring(time: GTime): boolean {
  return G_PowerUpExpiringRelative(Gtime_subtract(time, level.time));
}

/** `st.item` (spawn_temp_t) placeholder -- see file header. */
const st: { item: string | null } = { item: null };

// ---------------------------------------------------------------------------
// monster weapons (g_monster.cpp:6-138)
// ---------------------------------------------------------------------------

export function monster_muzzleflash(self: EdictT, start: Vec3, id: MonsterMuzzleflashIdT): void {
  if (id <= 255) gi.WriteByte(ServerCommandT.svc_muzzleflash2);
  else gi.WriteByte(ServerCommandT.svc_muzzleflash3);

  gi.WriteEntity(self);

  if (id <= 255) gi.WriteByte(id);
  else gi.WriteShort(id);

  gi.multicast(start, KexMulticastT.MULTICAST_PHS, false);
}

const MOD_UNKNOWN: ModT = { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false };
const MOD_BLASTER: ModT = { id: ModIdT.MOD_BLASTER, friendly_fire: false, no_point_loss: false };

export function monster_fire_bullet(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  fire_bullet(self, start, dir, damage, kick, hspread, vspread, MOD_UNKNOWN);
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_shotgun(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  count: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  fire_shotgun(self, start, aimdir, damage, kick, hspread, vspread, count, MOD_UNKNOWN);
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_blaster(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
  effect: EffectsT,
): void {
  fire_blaster(self, start, dir, damage, speed, effect, MOD_BLASTER);
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_flechette(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  fire_flechette(self, start, dir, damage, speed, Math.trunc(damage / 2));
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_grenade(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
  right_adjust: number,
  up_adjust: number,
): void {
  fire_grenade(self, start, aimdir, damage, speed, Gtime_from_sec(2.5), damage + 40, right_adjust, up_adjust, true);
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_rocket(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  fire_rocket(self, start, dir, damage, speed, damage + 20, damage);
  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_railgun(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  if ((gi.pointcontents(start) & MASK_SOLID) !== 0) return;

  fire_rail(self, start, aimdir, damage, kick);

  monster_muzzleflash(self, start, flashtype);
}

export function monster_fire_bfg(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  _kick: number,
  damage_radius: number,
  flashtype: MonsterMuzzleflashIdT,
): void {
  fire_bfg(self, start, aimdir, damage, speed, damage_radius);
  monster_muzzleflash(self, start, flashtype);
}

/** [Paril-KEX] g_monster.cpp:87-90 */
export function M_ProjectFlashSource(self: EdictT, offset: Vec3, forward: Vec3, right: Vec3): Vec3 {
  return G_ProjectSource(self.s.origin, self.s.scale !== 0 ? vec3_muls(offset, self.s.scale) : offset, forward, right);
}

const CLEARSHOT_MASK: ContentsT = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;

/**
 * [Paril-KEX] g_monster.cpp:92-138 -- collapses the C++ source's two
 * overloads into one function with an optional `start` out-param; see file
 * header.
 */
export function M_CheckClearShot(self: EdictT, offset: Vec3, start?: Vec3): boolean {
  if (!self.enemy) return false;

  const real_angles = vec3(self.s.angles[0], self.ideal_yaw, 0);
  const f = vec3();
  const r = vec3();
  AngleVectors(real_angles, f, r, null);
  const computedStart = M_ProjectFlashSource(self, offset, f, r);
  if (start !== undefined) VectorCopy(computedStart, start);

  const is_blind =
    self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND ||
    (self.monsterinfo.aiflags & (MonsterAiFlagsT.AI_MANUAL_STEERING | MonsterAiFlagsT.AI_LOST_SIGHT)) !== 0n;

  let target: Vec3 = is_blind
    ? self.monsterinfo.blind_fire_target
    : vec3_add(self.enemy.s.origin, vec3(0, 0, self.enemy.viewheight));

  let tr = giTraceline(computedStart, target, self, CLEARSHOT_MASK);

  if (traceEdict(tr.ent) === self.enemy || traceEdict(tr.ent).client !== null || (tr.fraction > 0.8 && !tr.startsolid)) {
    return true;
  }

  if (!is_blind) {
    target = self.enemy.s.origin;

    tr = giTraceline(computedStart, target, self, CLEARSHOT_MASK);

    if (traceEdict(tr.ent) === self.enemy || traceEdict(tr.ent).client !== null || (tr.fraction > 0.8 && !tr.startsolid)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// M_CheckGround (g_monster.cpp:140-188)
// ---------------------------------------------------------------------------

export function M_CheckGround(ent: EdictT, mask: ContentsT): void {
  if ((ent.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) !== 0n) return;

  // PGM
  if (ent.velocity[2] * ent.gravityVector[2] < -100) {
    ent.groundentity = null;
    return;
  }

  // if the hull point one-quarter unit down is solid the entity is on ground
  const point = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + 0.25 * ent.gravityVector[2]);

  const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, point, ent, mask);

  // check steepness
  // PGM
  if (ent.gravityVector[2] < 0) {
    // normal gravity
    if (trace.plane.normal[2] < 0.7 && !trace.startsolid) {
      ent.groundentity = null;
      return;
    }
  } else {
    // inverted gravity
    if (trace.plane.normal[2] > -0.7 && !trace.startsolid) {
      ent.groundentity = null;
      return;
    }
  }
  // PGM

  if (!trace.startsolid && !trace.allsolid) {
    VectorCopy(trace.endpos, ent.s.origin);
    const hit = traceEdict(trace.ent);
    ent.groundentity = hit;
    ent.groundentity_linkcount = hit.linkcount;
    ent.velocity[2] = 0;
  }
}

// ---------------------------------------------------------------------------
// M_CatagorizePosition (g_monster.cpp:190-225) -- see file header's ruling
// ---------------------------------------------------------------------------

// The C++ writes through two reference out-params (waterlevel&, watertype&).
// Most call sites (g_phys.cpp x3, g_monster.cpp x4) pass the entity's own
// fields, but m_move.cpp:721 passes LOCALS (end_waterlevel/end_watertype)
// and must NOT touch the entity -- so the faithful collapse is a
// value-returning core, with self-aliasing call sites assigning the result
// back explicitly. (Supersedes this file's earlier mutate-self ruling.)
export function M_CatagorizePosition(
  self: EdictT,
  in_point: Vec3,
): { waterlevel: WaterLevelT; watertype: ContentsT } {
  const point = vec3(
    in_point[0],
    in_point[1],
    self.gravityVector[2] > 0 ? in_point[2] + self.maxs[2] - 1 : in_point[2] + self.mins[2] + 1,
  );

  let cont = gi.pointcontents(point);

  if ((cont & MASK_WATER) === 0) {
    return { waterlevel: WaterLevelT.WATER_NONE, watertype: ContentsT.CONTENTS_NONE };
  }

  const watertype = cont;
  let waterlevel = WaterLevelT.WATER_FEET;
  point[2] += 26;
  cont = gi.pointcontents(point);
  if ((cont & MASK_WATER) === 0) return { waterlevel, watertype };

  waterlevel = WaterLevelT.WATER_WAIST;
  point[2] += 22;
  cont = gi.pointcontents(point);
  if ((cont & MASK_WATER) !== 0) waterlevel = WaterLevelT.WATER_UNDER;
  return { waterlevel, watertype };
}

/** The self-aliasing form every g_phys/g_monster C++ call site uses. */
export function M_CatagorizePositionSelf(self: EdictT, in_point: Vec3): void {
  const r = M_CatagorizePosition(self, in_point);
  self.waterlevel = r.waterlevel;
  self.watertype = r.watertype;
}

// ---------------------------------------------------------------------------
// M_ShouldReactToPain (g_monster.cpp:227-233)
// ---------------------------------------------------------------------------

export function M_ShouldReactToPain(self: EdictT, mod: ModT): boolean {
  if ((self.monsterinfo.aiflags & (MonsterAiFlagsT.AI_DUCKED | MonsterAiFlagsT.AI_COMBAT_POINT)) !== 0n) return false;

  const skill = cvarOrDefault("skill", "1");
  return mod.id === ModIdT.MOD_CHAINFIST || Math.trunc(skill.value) < 3;
}

// ---------------------------------------------------------------------------
// M_WorldEffects (g_monster.cpp:235-333)
// ---------------------------------------------------------------------------

export function M_WorldEffects(ent: EdictT): void {
  if (ent.health > 0) {
    if ((ent.flags & EntFlagsT.FL_SWIM) === 0n) {
      if (ent.waterlevel < WaterLevelT.WATER_UNDER) {
        ent.air_finished = Gtime_add(level.time, Gtime_from_sec(12));
      } else if (ent.air_finished < level.time) {
        // drown!
        if (ent.pain_debounce_time < level.time) {
          let dmg = 2 + 2 * Math.floor(Gtime_seconds(Gtime_subtract(level.time, ent.air_finished)));
          if (dmg > 15) dmg = 15;
          T_Damage(
            ent,
            g_edicts[0],
            g_edicts[0],
            vec3_origin,
            ent.s.origin,
            vec3_origin,
            dmg,
            0,
            DamageflagsT.DAMAGE_NO_ARMOR,
            { id: ModIdT.MOD_WATER, friendly_fire: false, no_point_loss: false },
          );
          ent.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(1));
        }
      }
    } else {
      if (ent.waterlevel > WaterLevelT.WATER_NONE) {
        ent.air_finished = Gtime_add(level.time, Gtime_from_sec(9));
      } else if (ent.air_finished < level.time) {
        // suffocate!
        if (ent.pain_debounce_time < level.time) {
          let dmg = 2 + 2 * Math.floor(Gtime_seconds(Gtime_subtract(level.time, ent.air_finished)));
          if (dmg > 15) dmg = 15;
          T_Damage(
            ent,
            g_edicts[0],
            g_edicts[0],
            vec3_origin,
            ent.s.origin,
            vec3_origin,
            dmg,
            0,
            DamageflagsT.DAMAGE_NO_ARMOR,
            { id: ModIdT.MOD_WATER, friendly_fire: false, no_point_loss: false },
          );
          ent.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(1));
        }
      }
    }
  }

  if (ent.waterlevel === WaterLevelT.WATER_NONE) {
    if ((ent.flags & EntFlagsT.FL_INWATER) !== 0n) {
      gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_out.wav"), 1, ATTN_NORM, 0);
      ent.flags &= ~EntFlagsT.FL_INWATER;
    }
  } else {
    if ((ent.watertype & ContentsT.CONTENTS_LAVA) !== 0 && (ent.flags & EntFlagsT.FL_IMMUNE_LAVA) === 0n) {
      if (ent.damage_debounce_time < level.time) {
        ent.damage_debounce_time = Gtime_add(level.time, Gtime_from_ms(100));
        T_Damage(
          ent,
          g_edicts[0],
          g_edicts[0],
          vec3_origin,
          ent.s.origin,
          vec3_origin,
          10 * ent.waterlevel,
          0,
          DamageflagsT.DAMAGE_NONE,
          { id: ModIdT.MOD_LAVA, friendly_fire: false, no_point_loss: false },
        );
      }
    }
    if ((ent.watertype & ContentsT.CONTENTS_SLIME) !== 0 && (ent.flags & EntFlagsT.FL_IMMUNE_SLIME) === 0n) {
      if (ent.damage_debounce_time < level.time) {
        ent.damage_debounce_time = Gtime_add(level.time, Gtime_from_ms(100));
        T_Damage(
          ent,
          g_edicts[0],
          g_edicts[0],
          vec3_origin,
          ent.s.origin,
          vec3_origin,
          4 * ent.waterlevel,
          0,
          DamageflagsT.DAMAGE_NONE,
          { id: ModIdT.MOD_SLIME, friendly_fire: false, no_point_loss: false },
        );
      }
    }

    if ((ent.flags & EntFlagsT.FL_INWATER) === 0n) {
      if ((ent.watertype & ContentsT.CONTENTS_LAVA) !== 0) {
        if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0 && ent.health > 0) {
          if (frandom() <= 0.5) gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/lava1.wav"), 1, ATTN_NORM, 0);
          else gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/lava2.wav"), 1, ATTN_NORM, 0);
        } else {
          gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
        }
      } else if ((ent.watertype & ContentsT.CONTENTS_SLIME) !== 0) {
        gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
      } else if ((ent.watertype & ContentsT.CONTENTS_WATER) !== 0) {
        gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
      }

      ent.flags |= EntFlagsT.FL_INWATER;
      ent.damage_debounce_time = GTIME_ZERO;
    }
  }
}

// ---------------------------------------------------------------------------
// M_droptofloor_generic / M_droptofloor (g_monster.cpp:335-391)
// ---------------------------------------------------------------------------

/**
 * `origin` is mutated in place, matching the C++ `vec3_t &origin` reference
 * parameter (see file header -- unlike M_CatagorizePosition, real call sites
 * genuinely pass different origins, so the out-param is kept).
 */
export function M_droptofloor_generic(
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  ceiling: boolean,
  ignore: EdictT | null,
  mask: ContentsT,
  allow_partial: boolean,
): boolean {
  // PGM
  if (gi.trace(origin, mins, maxs, origin, ignore, mask).startsolid) {
    if (!ceiling) origin[2] += 1;
    else origin[2] -= 1;
  }

  const end = vec3(origin[0], origin[1], origin[2] + (ceiling ? 256 : -256));
  // PGM

  const trace = gi.trace(origin, mins, maxs, end, ignore, mask);

  if (trace.fraction === 1 || trace.allsolid || (!allow_partial && trace.startsolid)) return false;

  VectorCopy(trace.endpos, origin);

  return true;
}

export function M_droptofloor(ent: EdictT): boolean {
  const mask = G_GetClipMask(ent);

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_MONSTER_NO_DROP)) {
    if (!M_droptofloor_generic(ent.s.origin, ent.mins, ent.maxs, ent.gravityVector[2] > 0, ent, mask, true)) return false;
  } else {
    if (gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, ent, mask).startsolid) return false;
  }

  gi.linkentity(ent);
  M_CheckGround(ent, mask);
  M_CatagorizePosition(ent, ent.s.origin);

  return true;
}

// ---------------------------------------------------------------------------
// M_SetEffects (g_monster.cpp:393-456)
// ---------------------------------------------------------------------------

export function M_SetEffects(ent: EdictT): void {
  ent.s.effects &= ~(EffectsT.EF_COLOR_SHELL | EffectsT.EF_POWERSCREEN | EffectsT.EF_DOUBLE | EffectsT.EF_QUAD | EffectsT.EF_PENT | EffectsT.EF_FLIES);
  ent.s.renderfx &= ~(RenderfxT.RF_SHELL_RED | RenderfxT.RF_SHELL_GREEN | RenderfxT.RF_SHELL_BLUE | RenderfxT.RF_SHELL_DOUBLE);

  ent.s.sound = 0;
  ent.s.loop_attenuation = 0;

  // we're gibbed
  if ((ent.s.renderfx & RenderfxT.RF_LOW_PRIORITY) !== 0) return;

  if (ent.monsterinfo.weapon_sound && ent.health > 0) {
    ent.s.sound = ent.monsterinfo.weapon_sound;
    ent.s.loop_attenuation = ATTN_NORM;
  } else if (ent.monsterinfo.engine_sound) {
    ent.s.sound = ent.monsterinfo.engine_sound;
  }

  if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_RESURRECTING) !== 0n) {
    ent.s.effects |= EffectsT.EF_COLOR_SHELL;
    ent.s.renderfx |= RenderfxT.RF_SHELL_RED;
  }

  ent.s.renderfx |= RenderfxT.RF_DOT_SHADOW;

  // no power armor/powerup effects if we died
  if (ent.health <= 0) return;

  if (ent.powerarmor_time > level.time) {
    if (ent.monsterinfo.power_armor_type === ItemIdT.IT_ITEM_POWER_SCREEN) {
      ent.s.effects |= EffectsT.EF_POWERSCREEN;
    } else if (ent.monsterinfo.power_armor_type === ItemIdT.IT_ITEM_POWER_SHIELD) {
      ent.s.effects |= EffectsT.EF_COLOR_SHELL;
      ent.s.renderfx |= RenderfxT.RF_SHELL_GREEN;
    }
  }

  // PMM - new monster powerups
  if (ent.monsterinfo.quad_time > level.time) {
    if (G_PowerUpExpiring(ent.monsterinfo.quad_time)) ent.s.effects |= EffectsT.EF_QUAD;
  }

  if (ent.monsterinfo.double_time > level.time) {
    if (G_PowerUpExpiring(ent.monsterinfo.double_time)) ent.s.effects |= EffectsT.EF_DOUBLE;
  }

  if (ent.monsterinfo.invincible_time > level.time) {
    if (G_PowerUpExpiring(ent.monsterinfo.invincible_time)) ent.s.effects |= EffectsT.EF_PENT;
  }
}

// ---------------------------------------------------------------------------
// M_AllowSpawn (g_monster.cpp:458-463)
// ---------------------------------------------------------------------------

export function M_AllowSpawn(_self: EdictT): boolean {
  const deathmatch = cvarOrDefault("deathmatch", "0");
  const ai_allow_dm_spawn = cvarOrDefault("ai_allow_dm_spawn", "0");

  if (deathmatch.value !== 0 && ai_allow_dm_spawn.value === 0) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// M_SetAnimation (g_monster.cpp:465-490)
// ---------------------------------------------------------------------------

/**
 * `move` is a non-nullable `MmoveT`, matching every real call site (always a
 * concrete named move table, never null) and the header's own "NB: always
 * use M_SetAnimation" doc comment.
 */
export function M_SetAnimation(self: EdictT, move: MmoveT, instant: boolean): void {
  // [Paril-KEX] free the beams if we switch animations.
  if (self.beam) {
    G_FreeEdict(self.beam);
    self.beam = null;
  }

  if (self.beam2) {
    G_FreeEdict(self.beam2);
    self.beam2 = null;
  }

  // instant switches will cause active_move to change on the next frame
  if (instant) {
    self.monsterinfo.active_move = move;
    self.monsterinfo.next_move = null;
    return;
  }

  // these wait until the frame is ready to be finished
  self.monsterinfo.next_move = move;
}

// ---------------------------------------------------------------------------
// M_MoveFrame (g_monster.cpp:492-611)
// ---------------------------------------------------------------------------

export function M_MoveFrame(self: EdictT): void {
  let move = self.monsterinfo.active_move;

  // [Paril-KEX] high tick rate adjustments; monsters still only step frames
  // and run thinkfuncs at 10hz, but will run aifuncs at full speed with
  // distance spread over 10hz
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  // time to run next 10hz move yet?
  let run_frame = self.monsterinfo.next_move_time <= level.time;

  // we asked nicely to switch frames when the timer ran up
  if (run_frame && self.monsterinfo.next_move !== null && self.monsterinfo.active_move !== self.monsterinfo.next_move) {
    M_SetAnimation(self, self.monsterinfo.next_move, true);
    move = self.monsterinfo.active_move;
  }

  if (move === null) return;

  // no, but maybe we were explicitly forced into another move (pain, death, etc)
  if (!run_frame) {
    run_frame = self.s.frame < move.firstframe || self.s.frame > move.lastframe;
  }

  if (run_frame) {
    // [Paril-KEX] allow next_move and nextframe to work properly after an endfunc
    let explicit_frame = false;

    if (self.monsterinfo.nextframe && self.monsterinfo.nextframe >= move.firstframe && self.monsterinfo.nextframe <= move.lastframe) {
      self.s.frame = self.monsterinfo.nextframe;
      self.monsterinfo.nextframe = 0;
    } else {
      if (self.s.frame === move.lastframe) {
        if (move.endfunc) {
          move.endfunc(self);

          if (self.monsterinfo.next_move !== null) {
            M_SetAnimation(self, self.monsterinfo.next_move, true);

            if (self.monsterinfo.nextframe) {
              self.s.frame = self.monsterinfo.nextframe;
              self.monsterinfo.nextframe = 0;
              explicit_frame = true;
            }
          }

          // regrab move, endfunc is very likely to change it
          move = self.monsterinfo.active_move;
          if (move === null) {
            // See file header's M_MoveFrame quirk note: the C++ source has
            // no null check here at all (UB if this ever happened); this
            // throws instead of silently continuing with a null move.
            throw new Error(`M_MoveFrame: active_move became null after endfunc -- ${self.classname ?? "?"}`);
          }

          // check for death
          if ((self.svflags & SvflagsT.SVF_DEADMONSTER) !== 0) return;
        }
      }

      if (self.s.frame < move.firstframe || self.s.frame > move.lastframe) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
        self.s.frame = move.firstframe;
      } else if (!explicit_frame) {
        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HOLD_FRAME) === 0n) {
          self.s.frame++;
          if (self.s.frame > move.lastframe) self.s.frame = move.firstframe;
        }
      }
    }

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HIGH_TICK_RATE) !== 0n) {
      self.monsterinfo.next_move_time = level.time;
    } else {
      self.monsterinfo.next_move_time = Gtime_add(level.time, Gtime_from_hz(10));
    }

    if (
      self.monsterinfo.nextframe &&
      !(self.monsterinfo.nextframe >= move.firstframe && self.monsterinfo.nextframe <= move.lastframe)
    ) {
      self.monsterinfo.nextframe = 0;
    }
  }

  // NB: frame thinkfunc can be called on the same frame as the animation changing

  const index = self.s.frame - move.firstframe;
  const frame = move.frame[index];
  if (frame === undefined) {
    throw new Error(
      `M_MoveFrame: frame index ${index} out of range for active_move (firstframe=${move.firstframe}, lastframe=${move.lastframe}) -- ${self.classname ?? "?"}`,
    );
  }

  if (frame.aifunc) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HOLD_FRAME) === 0n) {
      let dist = frame.dist * self.monsterinfo.scale;
      dist /= gi.tick_rate / 10;
      frame.aifunc(self, dist);
    } else {
      frame.aifunc(self, 0);
    }
  }

  if (run_frame && frame.thinkfunc) frame.thinkfunc(self);

  if (frame.lerp_frame !== -1) {
    self.s.renderfx |= RenderfxT.RF_OLD_FRAME_LERP;
    self.s.old_frame = frame.lerp_frame;
  }
}

// ---------------------------------------------------------------------------
// G_MonsterKilled (g_monster.cpp:613-647) -- see file header's stub-swap note
// ---------------------------------------------------------------------------

export function G_MonsterKilled(self: EdictT): void {
  level.killed_monsters++;

  const coop = cvarOrDefault("coop", "0");
  if (coop.value !== 0 && self.enemy !== null && self.enemy.client !== null) {
    self.enemy.client.resp.score++;
  }

  const g_debug_monster_kills = cvarOrDefault("g_debug_monster_kills", "0");
  if (g_debug_monster_kills.value !== 0) {
    let found = false;

    for (let i = 0; i < level.monsters_registered.length; i++) {
      if (level.monsters_registered[i] === self) {
        level.monsters_registered[i] = null;
        found = true;
        break;
      }
    }

    if (!found) {
      gi.Center_Print(g_edicts[1] ?? null, "found missing monster?");
    }

    if (level.killed_monsters === level.total_monsters) {
      gi.Center_Print(g_edicts[1] ?? null, "all monsters dead");
    }
  }
}

// ---------------------------------------------------------------------------
// M_ProcessPain (g_monster.cpp:649-744) -- the KEX deferred-pain queue drain
// ---------------------------------------------------------------------------

export function M_ProcessPain(e: EdictT): void {
  if (!e.monsterinfo.damage_blood) return;

  if (e.health <= 0) {
    // ROGUE
    if ((e.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
      if (e.enemy !== null && e.enemy.inuse && (e.enemy.svflags & SvflagsT.SVF_MONSTER) !== 0) {
        cleanupHealTarget(e.enemy);
      }

      // clean up self
      e.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
    }
    // ROGUE

    if (!e.deadflag) {
      e.enemy = e.monsterinfo.damage_attacker;

      // ROGUE
      // ROGUE - free up slot for spawned monster if it's spawned
      if ((e.monsterinfo.aiflags & MonsterAiFlagsT.AI_SPAWNED_CARRIER) !== 0n) {
        if (e.monsterinfo.commander !== null && e.monsterinfo.commander.inuse && e.monsterinfo.commander.classname === "monster_carrier") {
          e.monsterinfo.commander.monsterinfo.monster_slots++;
        }
        e.monsterinfo.commander = null;
      }
      if ((e.monsterinfo.aiflags & MonsterAiFlagsT.AI_SPAWNED_WIDOW) !== 0n) {
        // need to check this because we can have variable numbers of coop players
        const commander = e.monsterinfo.commander;
        if (commander !== null && commander.inuse && (commander.classname ?? "").slice(0, 13) === "monster_widow") {
          if (commander.monsterinfo.monster_used > 0) commander.monsterinfo.monster_used--;
          e.monsterinfo.commander = null;
        }
      }

      if ((e.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n && !SpawnFlags_has(e.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
        G_MonsterKilled(e);
      }

      e.touch = null;
      monster_death_use(e);
    }

    // See file header's null-guard note: T_Damage always sets both fields
    // together with damage_blood, so this is an invariant check, not a real
    // runtime branch.
    const damageInflictor = e.monsterinfo.damage_inflictor;
    const damageAttacker = e.monsterinfo.damage_attacker;
    if (damageInflictor === null || damageAttacker === null) {
      throw new Error(`M_ProcessPain: damage_inflictor/damage_attacker unset despite nonzero damage_blood -- ${e.classname ?? "?"}`);
    }
    if (e.die) {
      e.die(e, damageInflictor, damageAttacker, e.monsterinfo.damage_blood, e.monsterinfo.damage_from, e.monsterinfo.damage_mod);
    }

    // [Paril-KEX] medic commander only gets his slots back after the monster
    // is gibbed, since we can revive them
    if (e.health <= e.gib_health) {
      if ((e.monsterinfo.aiflags & MonsterAiFlagsT.AI_SPAWNED_MEDIC_C) !== 0n) {
        const commander = e.monsterinfo.commander;
        if (commander !== null && commander.inuse && commander.classname === "monster_medic_commander") {
          commander.monsterinfo.monster_used -= e.monsterinfo.monster_slots;
        }
        e.monsterinfo.commander = null;
      }
    }

    if (e.inuse && e.health > e.gib_health && e.monsterinfo.active_move !== null && e.s.frame === e.monsterinfo.active_move.lastframe) {
      e.s.frame -= irandom(1, 3);

      if (e.groundentity && e.movetype === MovetypeT.MOVETYPE_TOSS && (e.flags & EntFlagsT.FL_STATIONARY) === 0n) {
        e.s.angles[1] += brandom() ? 4.5 : -4.5;
      }
    }
  } else {
    if (e.pain) {
      const attacker = e.monsterinfo.damage_attacker;
      if (attacker === null) {
        throw new Error(`M_ProcessPain: damage_attacker unset despite nonzero damage_blood -- ${e.classname ?? "?"}`);
      }
      e.pain(e, attacker, e.monsterinfo.damage_knockback, e.monsterinfo.damage_blood, e.monsterinfo.damage_mod);
    }
  }

  if (!e.inuse) return;

  if (e.monsterinfo.setskin) e.monsterinfo.setskin(e);

  e.monsterinfo.damage_blood = 0;
  e.monsterinfo.damage_knockback = 0;
  e.monsterinfo.damage_attacker = e.monsterinfo.damage_inflictor = null;

  // [Paril-KEX] fire health target
  if (e.healthtarget) {
    const target = e.target;
    e.target = e.healthtarget;
    G_UseTargets(e, e.enemy);
    e.target = target;
  }
}

// ---------------------------------------------------------------------------
// Monster utility functions: monster_dead_think / monster_dead (g_monster.cpp:746-792)
// ---------------------------------------------------------------------------

export const monster_dead_think: ThinkFn = RegisterThink("monster_dead_think", (self: EdictT): void => {
  // flies
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STINKY) !== 0n && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STUNK) === 0n) {
    if (!self.fly_sound_debounce_time) {
      self.fly_sound_debounce_time = Gtime_add(level.time, random_time(Gtime_from_sec(5), Gtime_from_sec(15)));
    } else if (self.fly_sound_debounce_time < level.time) {
      if (!self.s.sound) {
        self.s.effects |= EffectsT.EF_FLIES;
        self.s.sound = gi.soundindex("infantry/inflies1.wav");
        self.fly_sound_debounce_time = Gtime_add(level.time, Gtime_from_sec(60));
      } else {
        self.s.effects &= ~EffectsT.EF_FLIES;
        self.s.sound = 0;
        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STUNK;
      }
    }
  }

  if (!self.monsterinfo.damage_blood) {
    if (self.monsterinfo.active_move !== null && self.s.frame !== self.monsterinfo.active_move.lastframe) {
      self.s.frame++;
    }
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** Plain function -- no THINK()/save-registration in the C++ source. */
export function monster_dead(self: EdictT): void {
  self.think = monster_dead_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.monsterinfo.damage_blood = 0;
  self.fly_sound_debounce_time = GTIME_ZERO;
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_STUNK;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// projectile dodge / path-visibility helpers (g_monster.cpp:794-906)
// ---------------------------------------------------------------------------

function projectile_infront(self: EdictT, other: EdictT): boolean {
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  const vec = vec3_normalized(vec3_sub(other.s.origin, self.s.origin));
  return vec3_dot(vec, forward) > 0.35;
}

/**
 * [Paril-KEX] g_monster.cpp:846-854. `self` is captured via closure instead
 * of threaded through gi.BoxEdicts's `filter_data`/`void*` parameter -- a TS
 * closure already has lexical access to `self`, unlike the C++ function
 * pointer the real `BoxEdictsFilter_t` signature requires; this avoids an
 * `as EdictT` cast on the `unknown` filter-data value for no behavioral
 * difference (`M_CheckDodge` is the only caller and only ever passes `self`
 * for that same purpose).
 */
function M_CheckDodge(self: EdictT): void {
  // we recently made a valid dodge, don't try again for a bit
  if (self.monsterinfo.dodge_time > level.time) return;

  const filter: BoxEdictsFilterT = (entRaw) => M_CheckDodge_BoxEdictsFilter(self, entRaw);

  const mins = vec3_sub(self.absmin, vec3(512, 512, 512));
  const maxs = vec3_add(self.absmax, vec3(512, 512, 512));

  gi.BoxEdicts(mins, maxs, [], 0, SolidityAreaT.AREA_SOLID, filter, null);
}

function M_CheckDodge_BoxEdictsFilter(self: EdictT, entRaw: KexEdictT | null): BoxEdictsResultT {
  if (entRaw === null) return BoxEdictsResultT.Skip;
  const ent = traceEdict(entRaw);

  // not a valid projectile
  if ((ent.svflags & SvflagsT.SVF_PROJECTILE) === 0 || (ent.flags & EntFlagsT.FL_DODGE) === 0n) return BoxEdictsResultT.Skip;

  // not moving
  if (vec3_lengthSquared(ent.velocity) < 16) return BoxEdictsResultT.Skip;

  // projectile is behind us, we can't see it
  if (!projectile_infront(self, ent)) return BoxEdictsResultT.Skip;

  // will it hit us within 1 second? gives us enough time to dodge
  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, vec3_add(ent.s.origin, ent.velocity), ent, ent.clipmask);

  if (traceEdict(tr.ent) === self) {
    // see file header's ent.owner-nullability note
    if (ent.owner === null || self.monsterinfo.dodge === null) return BoxEdictsResultT.Skip;

    const v = vec3_sub(tr.endpos, ent.s.origin);
    const eta = Gtime_from_sec(vec3_length(v) / vec3_length(ent.velocity));

    self.monsterinfo.dodge(self, ent.owner, eta, tr, ent.movetype === MovetypeT.MOVETYPE_BOUNCE || ent.movetype === MovetypeT.MOVETYPE_TOSS);

    return BoxEdictsResultT.End;
  }

  return BoxEdictsResultT.Skip;
}

const PATHVIS_MASK: ContentsT = MASK_SOLID | ContentsT.CONTENTS_PROJECTILECLIP | ContentsT.CONTENTS_MONSTERCLIP | ContentsT.CONTENTS_PLAYERCLIP;

function CheckPathVisibility(start: Vec3, end: Vec3): boolean {
  let tr = giTraceline(start, end, null, PATHVIS_MASK);

  const valid = tr.fraction === 1.0;

  if (!valid) {
    // try raising some of the points
    let can_raise_start = false;
    let can_raise_end = false;
    const raised_start = vec3_add(start, vec3(0, 0, 16));
    const raised_end = vec3_add(end, vec3(0, 0, 16));

    if (giTraceline(start, raised_start, null, PATHVIS_MASK).fraction === 1.0) can_raise_start = true;
    if (giTraceline(end, raised_end, null, PATHVIS_MASK).fraction === 1.0) can_raise_end = true;

    // try raised start -> end
    if (can_raise_start) {
      tr = giTraceline(raised_start, end, null, PATHVIS_MASK);
      if (tr.fraction === 1.0) return true;
    }

    // try start -> raised end
    if (can_raise_end) {
      tr = giTraceline(start, raised_end, null, PATHVIS_MASK);
      if (tr.fraction === 1.0) return true;
    }

    // try both raised
    if (can_raise_start && can_raise_end) {
      tr = giTraceline(raised_start, raised_end, null, PATHVIS_MASK);
      if (tr.fraction === 1.0) return true;
    }
  }

  return valid;
}

// ---------------------------------------------------------------------------
// monster_think (g_monster.cpp:908-1010)
// ---------------------------------------------------------------------------

// `static vec3_t points[64];` -- module-scoped, reused across calls exactly
// like the C++ static local.
const DEBUG_PATH_POINTS: Vec3[] = Array.from({ length: 64 }, () => vec3());

export const monster_think: ThinkFn = RegisterThink("monster_think", (self: EdictT): void => {
  // [Paril-KEX] monster sniff testing; if we can make an unobstructed path
  // to the player, murder ourselves.
  const g_debug_monster_kills = cvarOrDefault("g_debug_monster_kills", "0");
  if (g_debug_monster_kills.value !== 0) {
    const player1 = g_edicts[1];
    if (player1 !== undefined && player1.inuse) {
      const enemy_trace = giTraceline(self.s.origin, player1.s.origin, self, ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_WINDOW | ContentsT.CONTENTS_DEADMONSTER);

      if (enemy_trace.fraction < 1.0 && traceEdict(enemy_trace.ent) === player1) {
        T_Damage(self, player1, player1, vec3(0, 0, -1), self.s.origin, vec3(0, 0, -1), 9999, 9999, DamageflagsT.DAMAGE_NO_PROTECTION, {
          id: ModIdT.MOD_BFG_BLAST,
          friendly_fire: false,
          no_point_loss: false,
        });
      } else {
        if (self.disintegrator_time <= level.time) {
          const request: PathRequest = {
            start: vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]),
            goal: vec3(player1.s.origin[0], player1.s.origin[1], player1.s.origin[2]),
            pathFlags: PathFlags.All,
            moveDist: 4.0,
            debugging: { drawTime: 0 },
            nodeSearch: { ignoreNodeFlags: true, minHeight: 0, maxHeight: 0, radius: 9999 },
            traversals: { dropHeight: 9999, jumpHeight: 9999 },
            pathPoints: { array: DEBUG_PATH_POINTS, count: DEBUG_PATH_POINTS.length },
          };

          const info: PathInfo = {
            numPathPoints: 0,
            pathDistSqr: 0,
            firstMovePoint: vec3(),
            secondMovePoint: vec3(),
            pathLinkType: PathLinkType.Walk,
            returnCode: PathReturnCode.StartPathErrors,
          };

          if (gi.GetPathToGoal(request, info)) {
            if (
              info.returnCode !== PathReturnCode.NoStartNode &&
              info.returnCode !== PathReturnCode.NoGoalNode &&
              info.returnCode !== PathReturnCode.NoPathFound &&
              info.returnCode !== PathReturnCode.NoNavAvailable &&
              info.numPathPoints < DEBUG_PATH_POINTS.length
            ) {
              const enemyFoot = vec3(player1.s.origin[0], player1.s.origin[1], player1.s.origin[2] + player1.mins[2]);
              const selfFoot = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + self.mins[2]);

              if (
                CheckPathVisibility(enemyFoot, DEBUG_PATH_POINTS[info.numPathPoints - 1]) &&
                CheckPathVisibility(selfFoot, DEBUG_PATH_POINTS[0])
              ) {
                let i = 0;
                for (; i < info.numPathPoints - 1; i++) {
                  if (!CheckPathVisibility(DEBUG_PATH_POINTS[i], DEBUG_PATH_POINTS[i + 1])) break;
                }

                if (i === info.numPathPoints - 1) {
                  T_Damage(self, player1, player1, vec3(0, 0, 1), self.s.origin, vec3(0, 0, 1), 9999, 9999, DamageflagsT.DAMAGE_NO_PROTECTION, {
                    id: ModIdT.MOD_BFG_BLAST,
                    friendly_fire: false,
                    no_point_loss: false,
                  });
                } else {
                  self.disintegrator_time = Gtime_add(level.time, Gtime_from_ms(500));
                }
              } else {
                self.disintegrator_time = Gtime_add(level.time, Gtime_from_ms(500));
              }
            } else {
              self.disintegrator_time = Gtime_add(level.time, Gtime_from_sec(1));
            }
          } else {
            self.disintegrator_time = Gtime_add(level.time, Gtime_from_sec(1));
          }
        }
      }

      if (!self.deadflag && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n) {
        gi.Draw_Bounds(self.absmin, self.absmax, rgba_red, gi.frame_time_s, false);
      }
    }
  }

  self.s.renderfx &= ~(RenderfxT.RF_STAIR_STEP | RenderfxT.RF_OLD_FRAME_LERP);

  M_ProcessPain(self);

  // pain/die above freed us
  if (!self.inuse || self.think !== monster_think) return;

  if ((self.hackflags & HACKFLAG_ATTACK_PLAYER) !== 0) {
    const player1 = g_edicts[1];
    if (!self.enemy && player1 !== undefined && player1.inuse) {
      self.enemy = player1;
      FoundTarget(self);
    }
  }

  if (self.health > 0 && self.monsterinfo.dodge !== null && (globals.server_flags & ServerFlagsT.SERVER_FLAG_LOADING) === 0) {
    M_CheckDodge(self);
  }

  M_MoveFrame(self);
  if (self.linkcount !== self.monsterinfo.linkcount) {
    self.monsterinfo.linkcount = self.linkcount;
    M_CheckGround(self, G_GetClipMask(self));
  }
  M_CatagorizePositionSelf(self, self.s.origin);
  M_WorldEffects(self);
  M_SetEffects(self);
});

// ---------------------------------------------------------------------------
// monster_use (g_monster.cpp:1012-1037)
// ---------------------------------------------------------------------------

export const monster_use: UseFn = RegisterUse("monster_use", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (self.enemy) return;
  if (self.health <= 0) return;
  if (!activator) return;
  if ((activator.flags & EntFlagsT.FL_NOTARGET) !== 0n) return;
  if (activator.client === null && (activator.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) === 0n) return;
  if ((activator.flags & EntFlagsT.FL_DISGUISED) !== 0n) return; // PGM

  // delay reaction so if the monster is teleported, its sound is still heard
  self.enemy = activator;
  FoundTarget(self);
});

// ---------------------------------------------------------------------------
// monster_triggered_* (g_monster.cpp:1039-1142)
// ---------------------------------------------------------------------------

export const monster_triggered_spawn: ThinkFn = RegisterThink("monster_triggered_spawn", (self: EdictT): void => {
  self.s.origin[2] += 1;

  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.air_finished = Gtime_add(level.time, Gtime_from_sec(12));
  gi.linkentity(self);

  KillBox(self, false);

  monster_start_go(self);

  // RAFAEL
  if (self.classname === "monster_fixbot") {
    const fixbotFlags = SpawnFlags_or(SpawnFlags_or(SPAWNFLAG_FIXBOT_LANDING, SPAWNFLAG_FIXBOT_TAKEOFF), SPAWNFLAG_FIXBOT_FIXIT);
    if (SpawnFlags_has(self.spawnflags, fixbotFlags)) {
      self.enemy = null;
      return;
    }
  }
  // RAFAEL

  if (
    self.enemy &&
    !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH) &&
    (self.enemy.flags & EntFlagsT.FL_NOTARGET) === 0n &&
    (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) === 0n
  ) {
    // ROGUE
    if ((self.enemy.flags & EntFlagsT.FL_DISGUISED) === 0n) {
      // ROGUE
      FoundTarget(self);
      // ROGUE
    } else {
      // PMM - just in case, make sure to clear the enemy so FindTarget doesn't get confused
      self.enemy = null;
    }
    // ROGUE
  } else {
    self.enemy = null;
  }
});

export const monster_triggered_spawn_use: UseFn = RegisterUse(
  "monster_triggered_spawn_use",
  (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
    // we have a one frame delay here so we don't telefrag the guy who activated us
    self.think = monster_triggered_spawn;
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    if (activator && activator.client !== null && (self.hackflags & HACKFLAG_END_CUTSCENE) === 0) {
      self.enemy = activator;
    }
    self.use = monster_use;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_SCENIC)) {
      M_droptofloor(self);

      self.nextthink = GTIME_ZERO;
      if (self.think) self.think(self);

      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH)) {
        monster_use(self, other, activator);
      }

      for (let i = 0; i < 30; i++) {
        if (self.think) self.think(self);
        self.monsterinfo.next_move_time = GTIME_ZERO;
      }
    }
  },
);

export const monster_triggered_think: ThinkFn = RegisterThink("monster_triggered_think", (self: EdictT): void => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n) {
    gi.Draw_Bounds(self.absmin, self.absmax, rgba_blue, gi.frame_time_s, false);
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
});

export function monster_triggered_start(self: EdictT): void {
  self.solid = SolidT.SOLID_NOT;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.nextthink = GTIME_ZERO;
  self.use = monster_triggered_spawn_use;

  const g_debug_monster_kills = cvarOrDefault("g_debug_monster_kills", "0");
  if (g_debug_monster_kills.value !== 0) {
    self.think = monster_triggered_think;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(1));
  }

  if (
    self.targetname === null ||
    (G_FindByString(null, "target", self.targetname) === null &&
      G_FindByString(null, "pathtarget", self.targetname) === null &&
      G_FindByString(null, "deathtarget", self.targetname) === null &&
      G_FindByString(null, "itemtarget", self.targetname) === null &&
      G_FindByString(null, "healthtarget", self.targetname) === null &&
      G_FindByString(null, "combattarget", self.targetname) === null)
  ) {
    gi.Com_Print(`${self.classname ?? "?"}: is trigger spawned, but has no targetname or no entity to spawn it\n`);
  }
}

// ---------------------------------------------------------------------------
// monster_death_use (g_monster.cpp:1144-1182)
// ---------------------------------------------------------------------------

export function monster_death_use(self: EdictT): void {
  self.flags &= ~(EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM);
  self.monsterinfo.aiflags &= MonsterAiFlagsT.AI_DOUBLE_TROUBLE | MonsterAiFlagsT.AI_GOOD_GUY | MonsterAiFlagsT.AI_STINKY | AI_SPAWNED_MASK;

  if (self.item) {
    const dropped = Drop_Item(self, self.item);

    if (self.itemtarget) {
      dropped.target = self.itemtarget;
      self.itemtarget = null;
    }

    self.item = null;
  }

  if (self.deathtarget) self.target = self.deathtarget;

  if (self.target) G_UseTargets(self, self.enemy);

  // [Paril-KEX] fire health target
  if (self.healthtarget) {
    self.target = self.healthtarget;
    G_UseTargets(self, self.enemy);
  }
}

// ---------------------------------------------------------------------------
// G_Monster_ScaleCoopHealth / G_Monster_CheckCoopHealthScaling (g_monster.cpp:1184-1219)
// ---------------------------------------------------------------------------

/** [Paril-KEX] adjust the monster's health from how many active players we have */
export function G_Monster_ScaleCoopHealth(self: EdictT): void {
  // already scaled
  if (self.monsterinfo.health_scaling >= level.coop_scale_players) return;

  // this is just to fix monsters that change health after spawning... looking at you, soldiers
  if (!self.monsterinfo.base_health) self.monsterinfo.base_health = self.max_health;

  const delta = level.coop_scale_players - self.monsterinfo.health_scaling;
  const additional_health = Math.trunc(delta * (self.monsterinfo.base_health * level.coop_health_scaling));

  self.health = Math.max(1, self.health + additional_health);
  self.max_health += additional_health;

  self.monsterinfo.health_scaling = level.coop_scale_players;
}

/** check all active monsters' scaling */
export function G_Monster_CheckCoopHealthScaling(): void {
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined) continue;
    if (!ent.inuse) continue;
    if ((ent.flags & EntFlagsT.FL_COOP_HEALTH_SCALE) === 0n) continue;
    if (ent.health <= 0) continue;
    G_Monster_ScaleCoopHealth(ent);
  }
}

// ---------------------------------------------------------------------------
// monster_start (g_monster.cpp:1221-1330)
// ---------------------------------------------------------------------------

const SPAWNFLAG_MONSTER_FUBAR: SpawnFlags = SpawnFlags_from(4);

export function monster_start(self: EdictT): boolean {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return false;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_SCENIC)) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_GOOD_GUY;
  }

  // [Paril-KEX] n64
  if ((self.hackflags & (HACKFLAG_END_CUTSCENE | HACKFLAG_ATTACK_PLAYER)) !== 0) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;
  }

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_FUBAR) && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) === 0n) {
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_MONSTER_FUBAR));
    self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_MONSTER_AMBUSH);
  }

  // [Paril-KEX] simplify other checks
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;
  }

  // ROGUE
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DO_NOT_COUNT) === 0n && !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD)) {
    const g_debug_monster_kills = cvarOrDefault("g_debug_monster_kills", "0");
    if (g_debug_monster_kills.value !== 0) {
      level.monsters_registered[level.total_monsters] = self;
    }
    // ROGUE
    level.total_monsters++;
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  self.svflags |= SvflagsT.SVF_MONSTER;
  self.takedamage = true;
  self.air_finished = Gtime_add(level.time, Gtime_from_sec(12));
  self.use = monster_use;
  self.max_health = self.health;
  self.clipmask = MASK_MONSTERSOLID;
  self.deadflag = false;
  self.svflags &= ~SvflagsT.SVF_DEADMONSTER;
  self.flags &= ~EntFlagsT.FL_ALIVE_KNOCKBACK_ONLY;
  self.flags |= EntFlagsT.FL_COOP_HEALTH_SCALE;
  VectorCopy(self.s.origin, self.s.old_origin);
  self.monsterinfo.initial_power_armor_type = self.monsterinfo.power_armor_type;
  self.monsterinfo.max_power_armor_power = self.monsterinfo.power_armor_power;

  if (!self.monsterinfo.checkattack) self.monsterinfo.checkattack = M_CheckAttack;

  const ai_model_scale = cvarOrDefault("ai_model_scale", "0");
  if (ai_model_scale.value > 0) self.s.scale = ai_model_scale.value;

  if (self.s.scale) {
    self.monsterinfo.scale *= self.s.scale;
    vec3_mulEqs(self.mins, self.s.scale);
    vec3_mulEqs(self.maxs, self.s.scale);
    self.mass *= self.s.scale;
  }

  // set combat style if unset
  if (self.monsterinfo.combat_style === CombatStyleT.COMBAT_UNKNOWN) {
    if (!self.monsterinfo.attack && self.monsterinfo.melee) self.monsterinfo.combat_style = CombatStyleT.COMBAT_MELEE;
    else self.monsterinfo.combat_style = CombatStyleT.COMBAT_MIXED;
  }

  if (st.item) {
    self.item = FindItemByClassname(st.item);
    if (!self.item) gi.Com_Print(`${self.classname ?? "?"}: bad item: ${st.item}\n`);
  }

  // randomize what frame they start on
  if (self.monsterinfo.active_move !== null) {
    self.s.frame = irandom(self.monsterinfo.active_move.firstframe, self.monsterinfo.active_move.lastframe + 1);
  }

  // PMM - get this so I don't have to do it in all of the monsters
  self.monsterinfo.base_height = self.maxs[2];

  // Paril: monsters' old default viewheight (25) is all messed up for
  // certain monsters. Calculate from maxs to make a bit more sense.
  if (!self.viewheight) self.viewheight = Math.trunc(self.maxs[2] - 8);

  // PMM - clear these
  self.monsterinfo.quad_time = GTIME_ZERO;
  self.monsterinfo.double_time = GTIME_ZERO;
  self.monsterinfo.invincible_time = GTIME_ZERO;

  // set base health & set base scaling to 1 player
  self.monsterinfo.base_health = self.health;
  self.monsterinfo.health_scaling = 1;

  // [Paril-KEX] co-op health scale
  G_Monster_ScaleCoopHealth(self);

  return true;
}

// ---------------------------------------------------------------------------
// G_FixStuckObject (g_monster.cpp:1332-1348)
// ---------------------------------------------------------------------------

export function G_FixStuckObject(self: EdictT, check: Vec3): StuckResultT {
  const mask = G_GetClipMask(self);
  const trace_func: StuckObjectTraceFn = (start, mins, maxs, end) => gi.trace(start, mins, maxs, end, self, mask);
  const result = G_FixStuckObject_Generic(check, self.mins, self.maxs, trace_func);

  if (result === StuckResultT.NO_GOOD_POSITION) return result;

  VectorCopy(check, self.s.origin);

  if (result === StuckResultT.FIXED) {
    gi.Com_Print(`fixed stuck ${self.classname ?? "?"}\n`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// monster_start_go (g_monster.cpp:1350-1556)
// ---------------------------------------------------------------------------

const STUCK_ADJUST = [0, -1, 1, -2, 2, -4, 4, -8, 8];

export function monster_start_go(self: EdictT): void {
  // Paril: moved here so this applies to swim/fly monsters too
  if ((self.flags & EntFlagsT.FL_STATIONARY) === 0n) {
    const check = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);

    // [Paril-KEX] different nudge method; see if any of the bbox sides are
    // clear, if so we can see how much headroom we have in that direction
    // and shift us. most of the monsters stuck in solids will only be stuck
    // on one side, which conveniently leaves only one side not in a solid;
    // this won't fix monsters stuck in a corner though.
    let is_stuck: boolean;

    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n || (self.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) !== 0n) {
      is_stuck = gi.trace(self.s.origin, self.mins, self.maxs, self.s.origin, self, MASK_MONSTERSOLID).startsolid;
    } else {
      is_stuck = !M_droptofloor(self) || !M_walkmove(self, 0, 0);
    }

    if (is_stuck) {
      if (G_FixStuckObject(self, check) !== StuckResultT.NO_GOOD_POSITION) {
        if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
          is_stuck = gi.trace(self.s.origin, self.mins, self.maxs, self.s.origin, self, MASK_MONSTERSOLID).startsolid;
        } else if ((self.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) {
          M_droptofloor(self);
        }
        is_stuck = false;
      }
    }

    // last ditch effort: brute force
    if (is_stuck) {
      // Paril: try nudging them out. this fixes monsters stuck in very
      // shallow slopes.
      let walked = false;

      for (let y = 0; !walked && y < 3; y++) {
        for (let x = 0; !walked && x < 3; x++) {
          for (let z = 0; !walked && z < 3; z++) {
            self.s.origin[0] = check[0] + STUCK_ADJUST[x];
            self.s.origin[1] = check[1] + STUCK_ADJUST[y];
            self.s.origin[2] = check[2] + STUCK_ADJUST[z];

            if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
              is_stuck = gi.trace(self.s.origin, self.mins, self.maxs, self.s.origin, self, MASK_MONSTERSOLID).startsolid;

              if (!is_stuck) walked = true;
            } else if ((self.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) {
              M_droptofloor(self);
              walked = M_walkmove(self, 0, 0);
            }
          }
        }
      }
    }

    if (is_stuck) {
      gi.Com_Print(`WARNING: ${self.classname ?? "?"} stuck in solid\n`);
    }
  }

  if (self.health <= 0) return;

  VectorCopy(self.s.origin, self.s.old_origin);

  // check for target to combat_point and change to combattarget
  if (self.target) {
    let notcombat = false;
    let fixup = false;
    let target: EdictT | null = null;

    for (;;) {
      target = G_FindByString(target, "targetname", self.target);
      if (target === null) break;
      if (target.classname === "point_combat") {
        self.combattarget = self.target;
        fixup = true;
      } else {
        notcombat = true;
      }
    }
    if (notcombat && self.combattarget) {
      gi.Com_Print(`${self.classname ?? "?"}: has target with mixed types\n`);
    }
    if (fixup) self.target = null;
  }

  // validate combattarget
  if (self.combattarget) {
    let target: EdictT | null = null;

    for (;;) {
      target = G_FindByString(target, "targetname", self.combattarget);
      if (target === null) break;
      if (target.classname !== "point_combat") {
        gi.Com_Print(`${self.classname ?? "?"} has a bad combattarget ${self.combattarget} (${target.classname ?? "?"})\n`);
      }
    }
  }

  // allow spawning dead
  const spawn_dead = SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD);

  if (self.target) {
    self.goalentity = self.movetarget = G_PickTarget(self.target);
    if (!self.movetarget) {
      gi.Com_Print(`${self.classname ?? "?"}: can't find target ${self.target}\n`);
      self.target = null;
      self.monsterinfo.pausetime = HOLD_FOREVER;
      if (!spawn_dead && self.monsterinfo.stand) self.monsterinfo.stand(self);
    } else if (self.movetarget.classname === "path_corner") {
      if (self.goalentity !== null) {
        const v = vec3_sub(self.goalentity.s.origin, self.s.origin);
        self.ideal_yaw = self.s.angles[YAW] = vectoyaw(v);
      }
      if (!spawn_dead && self.monsterinfo.walk) self.monsterinfo.walk(self);
      self.target = null;
    } else {
      self.goalentity = self.movetarget = null;
      self.monsterinfo.pausetime = HOLD_FOREVER;
      if (!spawn_dead && self.monsterinfo.stand) self.monsterinfo.stand(self);
    }
  } else {
    self.monsterinfo.pausetime = HOLD_FOREVER;
    if (!spawn_dead && self.monsterinfo.stand) self.monsterinfo.stand(self);
  }

  if (spawn_dead) {
    // to spawn dead, we'll mimick them dying naturally
    self.health = 0;

    const f = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);

    if (self.die) {
      self.die(self, self, self, 0, vec3_origin, { id: ModIdT.MOD_SUICIDE, friendly_fire: false, no_point_loss: false });
    }

    if (!self.inuse) return;

    if (self.monsterinfo.setskin) self.monsterinfo.setskin(self);

    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SPAWNED_DEAD;

    const move = self.monsterinfo.active_move;

    if (move !== null) {
      // See file header's off-by-one quirk note: strictly `< lastframe`, not `<=`.
      for (let i = move.firstframe; i < move.lastframe; i++) {
        self.s.frame = i;

        const thinkfunc = move.frame[i - move.firstframe]?.thinkfunc;
        if (thinkfunc) thinkfunc(self);

        if (!self.inuse) return;
      }

      if (move.endfunc) move.endfunc(self);

      if (!self.inuse) return;

      if (self.monsterinfo.start_frame) self.s.frame = self.monsterinfo.start_frame;
      else self.s.frame = move.lastframe;
    }

    VectorCopy(f, self.s.origin);
    gi.linkentity(self);

    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_SPAWNED_DEAD;
  } else {
    self.think = monster_think;
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_SPAWNED_ALIVE;
  }
}

// ---------------------------------------------------------------------------
// walkmonster_start / flymonster_start / swimmonster_start (g_monster.cpp:1558-1609)
// ---------------------------------------------------------------------------

export const walkmonster_start_go: ThinkFn = RegisterThink("walkmonster_start_go", (self: EdictT): void => {
  if (!self.yaw_speed) self.yaw_speed = 20;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_TRIGGER_SPAWN)) monster_triggered_start(self);
  else monster_start_go(self);
});

export function walkmonster_start(self: EdictT): void {
  self.think = walkmonster_start_go;
  monster_start(self);
}

export const flymonster_start_go: ThinkFn = RegisterThink("flymonster_start_go", (self: EdictT): void => {
  if (!self.yaw_speed) self.yaw_speed = 30;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_TRIGGER_SPAWN)) monster_triggered_start(self);
  else monster_start_go(self);
});

export function flymonster_start(self: EdictT): void {
  self.flags |= EntFlagsT.FL_FLY;
  self.think = flymonster_start_go;
  monster_start(self);
}

export const swimmonster_start_go: ThinkFn = RegisterThink("swimmonster_start_go", (self: EdictT): void => {
  if (!self.yaw_speed) self.yaw_speed = 30;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_TRIGGER_SPAWN)) monster_triggered_start(self);
  else monster_start_go(self);
});

export function swimmonster_start(self: EdictT): void {
  self.flags |= EntFlagsT.FL_SWIM;
  self.think = swimmonster_start_go;
  monster_start(self);
}

// ---------------------------------------------------------------------------
// trigger_health_relay (g_monster.cpp:1611-1650) -- see file header's
// preserved-bug note (speed validated 0-100, compared against a 0-1 fraction)
// ---------------------------------------------------------------------------

export const trigger_health_relay_use: UseFn = RegisterUse(
  "trigger_health_relay_use",
  (self: EdictT, other: EdictT | null, activator: EdictT | null): void => {
    if (other === null) return; // real call sites always pass the health-tracked entity

    const percent_health = clamp(other.health / other.max_health, 0, 1);

    // not ready to trigger yet
    if (percent_health > self.speed) return;

    // fire!
    G_UseTargets(self, activator);

    // kill self
    G_FreeEdict(self);
  },
);

/**
 * QUAKED trigger_health_relay (1.0 1.0 0.0) (-8 -8 -8) (8 8 8)
 * Special type of relay that fires when a linked object is reduced beyond a
 * certain amount of health. It will only fire once, and free itself
 * afterwards.
 */
export function SP_trigger_health_relay(self: EdictT): void {
  if (!self.targetname) {
    gi.Com_Print(`${self.classname ?? "?"} missing targetname\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.speed < 0 || self.speed > 100) {
    gi.Com_Print(`${self.classname ?? "?"} has bad "speed" (health percentage); must be between 0 and 100, inclusive\n`);
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.use = trigger_health_relay_use;
}

// ---------------------------------------------------------------------------
// stationarymonster_start -- see file header's special-case note
// ---------------------------------------------------------------------------

export function stationarymonster_start(self: EdictT): void {
  throw new Error(
    `stationarymonster_start: declared in g_local.h:2240 and called from m_insane.cpp:686, but has no definition anywhere in the shipped rerelease source tree (verified by grepping every *.cpp for its body, not just callers) -- a genuine hole in the upstream C++ source, not a porting gap here -- called against ${self.classname ?? "?"}`,
  );
}

// ---------------------------------------------------------------------------
// CROSS-DEPENDENCIES NOT YET PORTED -- see file header
// ---------------------------------------------------------------------------

function fire_bullet(self: EdictT, _start: Vec3, _aimdir: Vec3, _damage: number, _kick: number, _hspread: number, _vspread: number, _mod: ModT): void {
  throw new Error(`fire_bullet: not yet ported (pending g_weapon.ts, see g_weapon.cpp:328) -- called against ${self.classname ?? "?"}`);
}

function fire_shotgun(
  self: EdictT,
  _start: Vec3,
  _aimdir: Vec3,
  _damage: number,
  _kick: number,
  _hspread: number,
  _vspread: number,
  _count: number,
  _mod: ModT,
): void {
  throw new Error(`fire_shotgun: not yet ported (pending g_weapon.ts, see g_weapon.cpp:340) -- called against ${self.classname ?? "?"}`);
}

function fire_blaster(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _effect: EffectsT, _mod: ModT): void {
  throw new Error(`fire_blaster: not yet ported (pending g_weapon.ts, see g_weapon.cpp:382) -- called against ${self.classname ?? "?"}`);
}

function fire_flechette(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _kick: number): void {
  throw new Error(`fire_flechette: not yet ported (pending g_weapon.ts, see g_local.h:2530) -- called against ${self.classname ?? "?"}`);
}

function fire_grenade(
  self: EdictT,
  _start: Vec3,
  _aimdir: Vec3,
  _damage: number,
  _speed: number,
  _timer: GTime,
  _damage_radius: number,
  _right_adjust: number,
  _up_adjust: number,
  _monster: boolean,
): void {
  throw new Error(`fire_grenade: not yet ported (pending g_weapon.ts, see g_weapon.cpp:537) -- called against ${self.classname ?? "?"}`);
}

function fire_rocket(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _damage_radius: number, _radius_damage: number): EdictT {
  throw new Error(`fire_rocket: not yet ported (pending g_weapon.ts, see g_weapon.cpp:701) -- called against ${self.classname ?? "?"}`);
}

function fire_rail(self: EdictT, _start: Vec3, _aimdir: Vec3, _damage: number, _kick: number): void {
  throw new Error(`fire_rail: not yet ported (pending g_weapon.ts, see g_weapon.cpp:835) -- called against ${self.classname ?? "?"}`);
}

function fire_bfg(self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _damage_radius: number): void {
  throw new Error(`fire_bfg: not yet ported (pending g_weapon.ts, see g_weapon.cpp:1140) -- called against ${self.classname ?? "?"}`);
}

function FoundTarget(self: EdictT): void {
  throw new Error(`FoundTarget: not yet ported (pending g_ai.ts, see g_ai.cpp:484) -- called against ${self.classname ?? "?"}`);
}

/** SAVE_FUNC_MONSTERINFO_CHECKATTACK("M_CheckAttack") -- see file header. */
const M_CheckAttack: MonsterinfoCheckattackFn = RegisterMonsterinfoCheckattack("M_CheckAttack", (self: EdictT): boolean => {
  throw new Error(`M_CheckAttack: not yet ported (pending g_ai.ts, see g_ai.cpp:1093) -- called against ${self.classname ?? "?"}`);
});



function FindItemByClassname(classname: string): GitemT | null {
  throw new Error(`FindItemByClassname: not yet ported (pending g_items.ts, see g_items.cpp) -- looked up "${classname}"`);
}

function Drop_Item(self: EdictT, _item: GitemT): EdictT {
  throw new Error(`Drop_Item: not yet ported (pending g_items.ts, see g_items.cpp) -- called against ${self.classname ?? "?"}`);
}

function cleanupHealTarget(target: EdictT): void {
  throw new Error(`cleanupHealTarget: not yet ported (ROGUE mission pack, pending m_medic.ts, see m_medic.cpp) -- called against ${target.classname ?? "?"}`);
}
