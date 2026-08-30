// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_combat.c -- ROGUE mission pack combat additions (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_combat.cpp
// (145 lines, C++17) in full: `cleanupHealTarget`, `T_RadiusNukeDamage`
// (nuke item explosion -- ignores walls, two-tier falloff, screen-flash
// timers on nearby players), `T_RadiusClassDamage` (radius damage that
// exempts a named classname, used by the disintegrator).
//
// ============================================================================
// cleanupHealTarget -- re-exported, not re-implemented
// ============================================================================
// m_medic.ts already ports `cleanupHealTarget` for real (its own file
// header explains why: the medic needs it directly, and every primitive
// its body touches was already landed). This file's declared C++ home is
// rogue/g_rogue_combat.cpp:13-18, so it is re-exported from here too,
// without duplicating the four-line body a second time. g_combat.ts's own
// import of `cleanupHealTarget` (from "./m_medic") is unaffected by this
// file landing -- it already points at the real implementation.
//
// ============================================================================
// STUB SWAP: g_combat.ts's MarkTeslaArea/TargetTesla are NOT swapped here
// ============================================================================
// g_combat.ts's local throwing stubs for `MarkTeslaArea`/`TargetTesla` cite
// rogue/g_rogue_newai.cpp:1019/1472 (NOT this file) as their real home --
// verified by reading g_rogue_combat.cpp above in full (neither function
// appears in it). Both belong to g_rogue_newai.ts; swapped there, not here.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - Vec3 operator chains (`v = ent->mins + ent->maxs; v = ent->s.origin +
//   (v * 0.5f); v = inflictor->s.origin - v;`) become explicit
//   vec3_add/vec3_muls/vec3_sub calls per PORTING.md's copy-explicit-value
//   convention -- no behavioral change, `v` is never aliased.
// - `max(a, b)` on two `gtime_t` values: a local `GTmax` helper, matching
//   g_items.ts's own identical precedent (`Math.max` would widen the
//   branded `GTime` back to plain `number`).
// - T_RadiusNukeDamage's second loop (`ent = g_edicts + 1; while (ent) {
//   if (client && nuke_time-not-already-set-this-frame && inuse) { ...;
//   ent++; } else ent = nullptr; }`) is NOT a "skip already-handled clients,
//   keep scanning" loop despite reading like one -- the `else` branch sets
//   `ent = nullptr`, ending the `while` entirely. So this scan starts at
//   player slot 1 and stops dead at the FIRST slot that fails the
//   condition (disconnected, not a client, or already touched by the first
//   loop's `findradius` pass this frame) -- any connected player *after*
//   that point in the slot list is silently skipped. Ported literally as a
//   `for` loop that `break`s (not `continue`s) on the failing condition;
//   this is a genuine upstream quirk, not a transcription bug, and is kept
//   bug-for-bug per this port line's mandate.

import { type Vec3, vec3 } from "../../shared/math";
import { vec3_add, vec3_sub, vec3_muls, vec3_length } from "../q_vec3";
import { type EdictT, type ModT, EntFlagsT, DamageflagsT } from "../g_local";
import { SvflagsT, MASK_SOLID } from "../../kexapi/game";
import { gi, g_edicts, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec, type GTime } from "../gtime";
import { findradius } from "../g_utils";
import { T_Damage, CanDamage } from "../g_combat";
import { cleanupHealTarget, realrange } from "../m_medic";

export { cleanupHealTarget };

/** GTime is a branded number (see gtime.ts); `Math.max` would widen it back
 *  to plain `number`, matching g_items.ts's own identical local `GTmax`. */
function GTmax(a: GTime, b: GTime): GTime {
  return a >= b ? a : b;
}

/**
 * rogue/g_rogue_combat.cpp:34-105 `void T_RadiusNukeDamage(edict_t
 * *inflictor, edict_t *attacker, float damage, edict_t *ignore, float
 * radius, mod_t mod)`. Like T_RadiusDamage, but ignores walls (skips
 * CanDamage) up to `killzone` (== radius), does a flat 10,000 points, then
 * falls off linearly out to `killzone2` (== radius * 2). Also sets
 * `client.nuke_time` screen-flash timers on nearby (and, per the quirky
 * second loop below, some not-so-nearby) players.
 */
export function T_RadiusNukeDamage(inflictor: EdictT, attacker: EdictT, damage: number, ignore: EdictT | null, radius: number, mod: ModT): void {
  const killzone = radius;
  const killzone2 = radius * 2.0;

  let ent: EdictT | null = null;
  while ((ent = findradius(ent, inflictor.s.origin, killzone2)) !== null) {
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;
    if (!ent.inuse) continue;
    if (!(ent.client !== null || (ent.svflags & SvflagsT.SVF_MONSTER) !== 0 || (ent.flags & EntFlagsT.FL_DAMAGEABLE) !== 0n)) continue;

    const mid = vec3_muls(vec3_add(ent.mins, ent.maxs), 0.5);
    const center = vec3_add(ent.s.origin, mid);
    const v = vec3_sub(inflictor.s.origin, center);
    const len = vec3_length(v);

    let points: number;
    if (len <= killzone) {
      if (ent.client !== null) ent.flags |= EntFlagsT.FL_NOGIB;
      points = 10000;
    } else if (len <= killzone2) {
      points = (damage / killzone) * (killzone2 - len);
    } else {
      points = 0;
    }

    if (points > 0) {
      if (ent.client !== null) ent.client.nuke_time = Gtime_add(level.time, Gtime_from_sec(2));
      const dir = vec3_sub(ent.s.origin, inflictor.s.origin);
      T_Damage(ent, inflictor, attacker, dir, inflictor.s.origin, vec3(0, 0, 0), Math.trunc(points), Math.trunc(points), DamageflagsT.DAMAGE_RADIUS, mod);
    }
  }

  // cycle through players -- see file header's "DEVIATIONS" note: this is a
  // scan that STOPS (not skips) at the first slot failing the condition.
  const nukeMark = Gtime_add(level.time, Gtime_from_sec(2));
  for (let i = 1; ; i++) {
    const player = g_edicts[i];
    if (player === undefined) break;
    if (player.client !== null && player.client.nuke_time !== nukeMark && player.inuse) {
      const tr = gi.trace(inflictor.s.origin, null, null, player.s.origin, inflictor, MASK_SOLID);
      if (tr.fraction === 1.0) {
        player.client.nuke_time = nukeMark;
      } else {
        const dist = realrange(player, inflictor);
        if (dist < 2048) {
          player.client.nuke_time = GTmax(player.client.nuke_time, Gtime_add(level.time, Gtime_from_sec(1.5)));
        } else {
          player.client.nuke_time = GTmax(player.client.nuke_time, Gtime_add(level.time, Gtime_from_sec(1)));
        }
      }
    } else {
      break;
    }
  }
}

/**
 * rogue/g_rogue_combat.cpp:114-143 `void T_RadiusClassDamage(edict_t
 * *inflictor, edict_t *attacker, float damage, char *ignoreClass, float
 * radius, mod_t mod)`. Like T_RadiusDamage, but exempts any entity whose
 * `classname` equals `ignoreClass` (the disintegrator uses this to avoid
 * damaging other disintegrator-spawned entities).
 */
export function T_RadiusClassDamage(inflictor: EdictT, attacker: EdictT, damage: number, ignoreClass: string, radius: number, mod: ModT): void {
  let ent: EdictT | null = null;
  while ((ent = findradius(ent, inflictor.s.origin, radius)) !== null) {
    if (ent.classname !== null && ent.classname === ignoreClass) continue;
    if (!ent.takedamage) continue;

    const mid = vec3_muls(vec3_add(ent.mins, ent.maxs), 0.5);
    const center = vec3_add(ent.s.origin, mid);
    const v = vec3_sub(inflictor.s.origin, center);

    let points = damage - 0.5 * vec3_length(v);
    if (ent === attacker) points = points * 0.5;

    if (points > 0) {
      if (CanDamage(ent, inflictor)) {
        const dir = vec3_sub(ent.s.origin, inflictor.s.origin);
        T_Damage(ent, inflictor, attacker, dir, inflictor.s.origin, vec3(0, 0, 0), Math.trunc(points), Math.trunc(points), DamageflagsT.DAMAGE_RADIUS, mod);
      }
    }
  }
}
