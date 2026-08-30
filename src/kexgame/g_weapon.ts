// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_weapon.c -- weapon effect functions shared by the player and monster
// weapon code (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_weapon.cpp (1,216 lines,
// C++17): fire_hit (melee), pierce_trace + pierce_args_t::mark/restore
// (real infrastructure, not stubs -- see "PIERCE_TRACE / GETUNICASTKEY"
// below), fire_lead + fire_lead_pierce_t, fire_bullet, fire_shotgun,
// fire_blaster + blaster_touch, fire_grenade + Grenade_Explode/
// Grenade_Touch/Grenade4_Think, fire_grenade2, fire_rocket + rocket_touch,
// binary_positional_search(_r), fire_rail_pierce_t, GetUnicastKey (real,
// see below), fire_rail, bfg_laser_pos/bfg_laser_update/bfg_spawn_laser/
// bfg_explode/bfg_touch/bfg_laser_pierce_t/bfg_think/fire_bfg,
// disintegrator_touch/fire_disintegrator. Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// PIERCE_TRACE / GETUNICASTKEY -- this file is their real C++ home; g_target.ts
// now imports both instead of keeping its own duplicate
// ============================================================================
// `pierce_trace`/`pierce_args_t::mark`/`pierce_args_t::restore` are DEFINED
// in g_weapon.cpp:88-111/g_local.h:3562-3587, and `GetUnicastKey` is defined
// in g_weapon.cpp:820-828. Before this unit landed, g_target.ts (whose own
// target_laser_think reaches both on every think tick) had already ported
// narrow, real, LOCAL copies of all four -- its own file header explicitly
// flagged this as "declared in g_local.h but DEFINED in g_weapon.cpp -- a
// file that hasn't landed in this port line yet", with a promise that a
// future g_weapon.ts landing should reconcile it.
//
// This unit is that reconciliation: `pierceTrace`, `markPierce`,
// `restorePierce`, and `GetUnicastKey` are exported for real from HERE (the
// function's actual C++ home) and g_target.ts's own four local copies are
// DELETED, replaced with `import { pierceTrace, markPierce, restorePierce,
// GetUnicastKey } from "./g_weapon"`. One implementation now owns each of
// these four symbols; g_target.ts's own `giTraceline`/`traceEdict`/
// `modFromId`/`cvarInt` helpers are untouched (those are the ordinary
// per-file "tiny header-only wrapper, duplicated on purpose" idiom this
// port line already uses everywhere -- see this file's own copies of the
// same four below -- and were never the source of truth for anything
// g_target.ts's own header called out as a real cross-file logic
// dependency). Verified identical behavior by diffing the moved bodies
// character-for-character against g_target.ts's pre-move versions before
// deleting them, and by re-running g_target.ts's own committed test suite
// (`target_laser_think`'s debounce-window test, which exercises
// pierceTrace/markPierce/restorePierce every tick) against the new import.
//
// ============================================================================
// CROSS-DEPENDENCIES NOT YET PORTED (throwing stubs, cited)
// ============================================================================
// - G_ShouldPlayersCollide -> p_client.cpp:2996: WAS a local throwing stub
//   here (g_utils.ts carried an identical one for the same reason); both
//   have since been swapped for real imports from src/kexgame/p_client.ts,
//   which has landed -- see the import site's own comment below.
// - PlayerNoise -> p_weapon.cpp:149 (future src/kexgame/p_weapon.ts). Called
//   only under `if (self->client)` / `if (ent->owner->client)` guards
//   throughout this file (fire_lead's gun-puff branch, blaster_touch,
//   Grenade_Explode, rocket_touch, bfg_touch) -- same reasoning as above,
//   never reached by a monster-fired shot.
//
// ============================================================================
// fire_flechette / fire_prox -- NOT in this file; ROGUE mission pack, out of
// scope (same treatment as g_monster.ts's own cleanupHealTarget note)
// ============================================================================
// g_local.h:2530-2531 DECLARES `fire_flechette`/`fire_prox`, and
// g_monster.cpp:47-51's `monster_fire_flechette` calls the former, but
// neither is DEFINED anywhere in g_weapon.cpp (verified: grepped the whole
// 1,216-line file for both names -- zero matches) or anywhere else in the
// base rerelease tree. Their real bodies live in
// rogue/g_rogue_newweap.cpp:41 (`fire_flechette`) and
// rogue/g_rogue_newweap.cpp:431 (`fire_prox`) -- the ROGUE mission-pack
// source tree, out of this port line's current scope (no src/kexgame/
// rogue/ exists yet). Neither is exported from this file. g_monster.ts's
// own `monster_fire_flechette` wrapper already had a local `fire_flechette`
// throwing stub citing (incorrectly) "pending g_weapon.ts, see
// g_local.h:2530"; this unit corrects that citation to point at the real
// ROGUE owner instead of implying a future g_weapon.ts landing would ever
// satisfy it (it can't -- this file has no such definition to import). See
// this unit's own report for the exact diff.
//
// ============================================================================
// fire_hit's self->enemy / touch handlers' owner->client -- unconditional
// C++ pointer dereferences preserved as explicit invariant checks
// ============================================================================
// `fire_hit` dereferences `self->enemy` unconditionally throughout (never
// null-checked in the C++ -- callers are melee monster attacks that always
// set `enemy` first). `blaster_touch`/`Grenade_Explode`/`Grenade_Touch`/
// `rocket_touch`/`bfg_touch` all dereference `ent->owner`/`self->owner`
// unconditionally the same way (`if (ent->owner->client)`). Both become
// `requireEnemy(self, ctx)`/`requireOwner(ent, ctx)` local helpers that
// throw a descriptive "invariant violated" error instead of segfaulting --
// the exact same treatment g_target.ts's own `requireActivator` helper
// already established for `self->activator`.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG (read twice against the shipped source, not
// "fixed")
// ============================================================================
// - `pierce_trace`'s `own_start` is computed every loop iteration but never
//   read again (every retrace uses the SAME original `start`, not
//   `own_start`) -- a genuine, intentional-looking quirk in the shipped
//   source (g_weapon.cpp:88-108), preserved verbatim; already documented by
//   g_target.ts's own pre-move header and re-verified here.
// - `fire_lead`'s RAII destructor is emulated with an EXPLICIT
//   `restorePierce(pierce)` call at the very end of the function, in
//   addition to the explicit `restore()` call the C++ source itself makes
//   mid-function (right before the second `pierce_trace`, undoing whatever
//   the first clear-shot-check trace pierced). C++'s `fire_lead_pierce_t
//   args` is a plain local variable; its destructor fires automatically
//   when `fire_lead` returns, restoring whatever the SECOND `pierce_trace`
//   pierced too (dead-monster corpses a bullet passed through). Since
//   `restorePierce` already resets `num_pierced` to 0 and is therefore a
//   safe no-op when nothing is currently pierced, calling it a second time
//   unconditionally at function end reproduces the destructor's effect
//   exactly without needing try/finally.
// - `fire_lead_pierce_t::hit`'s water-redirection branch recomputes `dir`
//   from `end - start` using the STRUCT's own fixed `start` MEMBER (the
//   original muzzle position passed into `fire_lead`), not `pierce_trace`'s
//   own local `start` parameter (which walks forward on each retrace
//   iteration) -- preserved via the closure-captured `state.start`, never
//   the trace-local start.
// - `bfg_think`'s `bfg_laser_pierce_t args` is declared FRESH INSIDE the
//   `findradius` loop body (one per candidate entity), so its destructor
//   fires at the END OF EACH LOOP ITERATION, not once after the whole loop.
//   `restorePierce(pierce)` is called once per iteration here, immediately
//   after that iteration's own `pierce_trace` call and TE_BFG_LASER write,
//   matching that per-iteration destructor timing exactly (a laser pierced
//   entity is restored before the NEXT candidate entity's laser is even
//   traced, not held pierced for the whole loop).
// - `GetUnicastKey`'s uint32 wraparound (`if (!key) return key = 1; return
//   key++;`) is preserved with `>>> 0` truncation to unsigned 32-bit on
//   every increment, matching C++'s `uint32_t` overflow-wraps-to-0-then-
//   resets-to-1 behavior exactly (moved verbatim from g_target.ts's own
//   pre-move copy, itself already correct).
// - `fire_grenade`'s monster-vs-non-monster branch spawns genuinely
//   different models/think functions (`Grenade_Explode` + spinning
//   `avelocity` for a monster-thrown grenade vs. `Grenade4_Think`'s own
//   speed-fraction-lerped tumble animation for a player-thrown one) --
//   preserved as two real, different code paths, not collapsed.
// - `rocket_touch`'s `ThrowGibs` debris call only fires OUTSIDE deathmatch
//   and coop (`if (!deathmatch->integer && !coop->integer)`), and only when
//   the trace surface exists and isn't warp/trans33/trans66/flowing --
//   preserved as written.
// - `bfg_touch` backs the origin up by `velocity * (-1 * gi.frame_time_s)`
//   (a plain `number`, read directly off `gi`, not a `GTime`) before
//   switching model/effects to the lingering explosion sprite -- read
//   directly from `gi.frame_time_s`, no gtime conversion needed.

import { vec3, type Vec3, VectorCopy, LerpAngle } from "../shared/math";
import { AngleVectors, vec3_add, vec3_equals, vec3_length, vec3_muls, vec3_normalize, vec3_normalized, vec3_origin, vec3_sub, vectoangles, closest_point_to_box, distance_between_boxes } from "./q_vec3";
import { clamp, crandom, frandom, irandom } from "./q_std";
import {
  ATTN_NORM,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  type KexEdictT,
  type KexTraceT,
  KexMulticastT,
  KexTempEventT,
  MASK_OPAQUE,
  MASK_PROJECTILE,
  MASK_SOLID,
  MASK_WATER,
  MODELINDEX_WORLD,
  RenderfxT,
  RF_BEAM_LIGHTNING,
  ServerCommandT,
  SolidT,
  SoundchanT,
  SplashColorT,
  SurfflagsT,
  SvflagsT,
} from "../kexapi/game";
import {
  DamageflagsT,
  type EdictT,
  EntFlagsT,
  GibTypeT,
  MAX_PIERCE,
  type ModT,
  ModIdT,
  MovetypeT,
  type PierceArgsT,
  type PierceHitFn,
  type ThinkFn,
  type TouchFn,
} from "./g_local";
import { RegisterThink, RegisterTouch } from "./g_save_registry";
import { gi, g_edicts, game, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_hz, Gtime_from_sec, type GTime } from "./gtime";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "./spawnflags";
import { G_Spawn, G_FreeEdict, findradius } from "./g_utils";
import { T_Damage, T_RadiusDamage, CanDamage, CheckTeamDamage } from "./g_combat";
import { ThrowGibs, type GibDefT } from "./g_misc";

// ---------------------------------------------------------------------------
// small per-file helpers (see file header: duplicated on purpose, per this
// port line's established convention for tiny header-only wrappers)
// ---------------------------------------------------------------------------

/** EDICT_NUM idiom -- see g_phys.ts's/g_monster.ts's/g_target.ts's own `traceEdict`. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** `mod_t`'s implicit single-argument constructor (g_local.h:1081-1093). */
function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** `game_import_t::traceline` convenience wrapper (g_local.h:136-139). */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}
function deathmatchEnabled(): boolean {
  return cvarInt("deathmatch", "0") !== 0;
}
function coopEnabled(): boolean {
  return cvarInt("coop", "0", CvarFlagsT.CVAR_LATCH) !== 0;
}
function instagibEnabled(): boolean {
  return cvarInt("g_instagib", "0") !== 0;
}

/** `active_players()` (g_local.h:3426-3437): inuse, connected players. */
function* active_players(): Generator<EdictT> {
  for (let i = 1; i <= game.maxclients; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse || ent.client === null || !ent.client.pers.connected) continue;
    yield ent;
  }
}

/** See file header's "unconditional pointer dereferences" note. */
function requireEnemy(self: EdictT, context: string): EdictT {
  if (self.enemy === null) throw new Error(`${context}: self.enemy is null (invariant violated -- caller must set it before calling)`);
  return self.enemy;
}
function requireOwner(ent: EdictT, context: string): EdictT {
  if (ent.owner === null) throw new Error(`${context}: ent.owner is null (invariant violated -- always set by the fire_* spawn function immediately before this can run)`);
  return ent.owner;
}

// G_ShouldPlayersCollide -- formerly a local throwing stub here (see file
// header, "CROSS-DEPENDENCIES NOT YET PORTED"), now a real import.
// src/kexgame/p_client.ts has landed with a real, exported
// G_ShouldPlayersCollide (its genuine C++ home) -- g_utils.ts already made
// this exact swap for its own former local stub (see that file's "STUB
// SWAP" note); this is the second, independent duplicate the header
// mentioned, swapped for real in the 2026-08-30 cleanup sweep. Every
// fire_*/fire_lead call site's `if (self.client !== null &&
// !G_ShouldPlayersCollide(true))` guard was previously an unconditional
// throw whenever a real PLAYER fired a weapon (not just a coop-only edge
// case) -- monster-fired shots never reached it (self.client === null
// short-circuits), which is why this unit's own monster-shaped test
// fixtures never tripped it.
import { G_ShouldPlayersCollide } from "./p_client";

import { PlayerNoise } from "./p_weapon";

/** [Paril-KEX] player_noise_t (g_local.h) -- only PNOISE_IMPACT is used in this file. */
const PNOISE_IMPACT = 1;

// ---------------------------------------------------------------------------
// fire_hit
// ---------------------------------------------------------------------------

/**
 * g_weapon.cpp:12-81: `bool fire_hit(edict_t *self, vec3_t aim, int damage,
 * int kick)`. Used for all impact (hit/punch/slash) attacks. See file
 * header for the `requireEnemy` invariant-check treatment of `self->enemy`.
 */
export function fire_hit(self: EdictT, aim: Vec3, damage: number, kick: number): boolean {
  const enemy = requireEnemy(self, "fire_hit");

  // see if enemy is in range
  const range = distance_between_boxes(enemy.absmin, enemy.absmax, self.absmin, self.absmax);
  if (range > aim[0]) return false;

  if (!(aim[1] > self.mins[0] && aim[1] < self.maxs[0])) {
    // this is a side hit so adjust the "right" value out to the edge of their bbox
    if (aim[1] < 0) aim[1] = enemy.mins[0];
    else aim[1] = enemy.maxs[0];
  }

  const point = closest_point_to_box(self.s.origin, enemy.absmin, enemy.absmax);

  // check that we can hit the point on the bbox
  let tr = giTraceline(self.s.origin, point, self, MASK_PROJECTILE);
  let hitEnt: EdictT = traceEdict(tr.ent);

  if (tr.fraction < 1) {
    if (!hitEnt.takedamage) return false;
    // if it will hit any client/monster then hit the one we wanted to hit
    if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) !== 0 || hitEnt.client !== null) hitEnt = enemy;
  }

  // check that we can hit the player from the point
  tr = giTraceline(point, enemy.s.origin, self, MASK_PROJECTILE);
  if (tr.fraction < 1) {
    const secondHit = traceEdict(tr.ent);
    if (!secondHit.takedamage) return false;
    if ((secondHit.svflags & SvflagsT.SVF_MONSTER) !== 0 || secondHit.client !== null) hitEnt = enemy;
    else hitEnt = secondHit;
  }

  const { forward, right, up } = angleVectorsAll(self.s.angles);
  let aimPoint = vec3_add(self.s.origin, vec3_muls(forward, range));
  aimPoint = vec3_add(aimPoint, vec3_muls(right, aim[1]));
  aimPoint = vec3_add(aimPoint, vec3_muls(up, aim[2]));
  const dir = vec3_sub(aimPoint, enemy.s.origin);

  // do the damage
  T_Damage(hitEnt, self, self, dir, aimPoint, vec3_origin, damage, Math.trunc(kick / 2), DamageflagsT.DAMAGE_NO_KNOCKBACK, modFromId(ModIdT.MOD_HIT));

  if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && hitEnt.client === null) return false;

  // do our special form of knockback here
  let v = vec3_muls(vec3_add(enemy.absmin, enemy.absmax), 0.5);
  v = vec3_sub(v, aimPoint);
  vec3_normalize(v);
  enemy.velocity = vec3_add(enemy.velocity, vec3_muls(v, kick));
  if (enemy.velocity[2] > 0) enemy.groundentity = null;
  return true;
}

/** `AngleVectors` all-three-out-params convenience -- fire_hit is the only
 *  call site in this file that needs all three at once. */
function angleVectorsAll(angles: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(angles, forward, right, up);
  return { forward, right, up };
}

// ---------------------------------------------------------------------------
// pierce_trace / pierce_args_t::mark / pierce_args_t::restore -- see file
// header ("PIERCE_TRACE / GETUNICASTKEY")
// ---------------------------------------------------------------------------

/** g_local.h:3562-3567: `pierce_args_t::mark`. */
export function markPierce(pierce: PierceArgsT, ent: EdictT): boolean {
  if (pierce.num_pierced === MAX_PIERCE) return false;

  pierce.pierced[pierce.num_pierced] = ent;
  pierce.pierce_solidities[pierce.num_pierced] = ent.solid;
  pierce.num_pierced++;

  ent.solid = SolidT.SOLID_NOT;
  gi.linkentity(ent);

  return true;
}

/** g_local.h:3579-3587: `pierce_args_t::restore` -- see file header for its
 *  RAII-emulation timing at each of this file's own call sites. */
export function restorePierce(pierce: PierceArgsT): void {
  for (let i = 0; i < pierce.num_pierced; i++) {
    const ent = pierce.pierced[i];
    if (ent === null) continue;
    ent.solid = pierce.pierce_solidities[i];
    gi.linkentity(ent);
  }
  pierce.num_pierced = 0;
}

/** g_weapon.cpp:88-108: `void pierce_trace(...)` -- see file header for the
 *  real, intentional `own_start`-never-read-again quirk this preserves. */
export function pierceTrace(start: Vec3, end: Vec3, ignore: EdictT | null, pierce: PierceArgsT, mask: ContentsT): void {
  let loopCount = 8192; // MAX_EDICTS
  const ownEnd = vec3(end[0], end[1], end[2]);
  const maskBox: [ContentsT] = [mask];

  while (--loopCount !== 0) {
    pierce.tr = giTraceline(start, ownEnd, ignore, maskBox[0]);

    // didn't hit anything, so we're done
    if (pierce.tr.ent === null || pierce.tr.fraction === 1.0) return;

    // hit callback said we're done
    if (!pierce.hit(maskBox, ownEnd)) return;
  }

  gi.Com_Print("runaway pierce_trace\n");
}

// ---------------------------------------------------------------------------
// fire_lead / fire_bullet / fire_shotgun
// ---------------------------------------------------------------------------

interface FireLeadState {
  self: EdictT;
  start: Vec3; // FIXED muzzle start -- see file header's "water-redirection" quirk note
  aimdir: Vec3;
  damage: number;
  kick: number;
  hspread: number;
  vspread: number;
  mod: ModT;
  te_impact: number; // -1 means "no impact effect" (used for MOD_TESLA)
  water: boolean;
  water_start: Vec3;
}

/** g_weapon.cpp:113-239: `struct fire_lead_pierce_t : pierce_args_t` -- its `hit()` override. */
function makeFireLeadHit(pierce: PierceArgsT, state: FireLeadState): PierceHitFn {
  return (mask: [ContentsT], end: Vec3): boolean => {
    const tr = pierce.tr;

    // see if we hit water
    if ((tr.contents & MASK_WATER) !== 0) {
      state.water = true;
      state.water_start = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

      // CHECK: is this compare ever true? (preserved verbatim from the C++ comment)
      if (state.te_impact !== -1 && !vec3_equals(state.start, tr.endpos)) {
        let color: SplashColorT;

        if ((tr.contents & ContentsT.CONTENTS_WATER) !== 0) {
          if (tr.surface !== null && tr.surface.name === "brwater") color = SplashColorT.SPLASH_BROWN_WATER;
          else color = SplashColorT.SPLASH_BLUE_WATER;
        } else if ((tr.contents & ContentsT.CONTENTS_SLIME) !== 0) color = SplashColorT.SPLASH_SLIME;
        else if ((tr.contents & ContentsT.CONTENTS_LAVA) !== 0) color = SplashColorT.SPLASH_LAVA;
        else color = SplashColorT.SPLASH_UNKNOWN;

        if (color !== SplashColorT.SPLASH_UNKNOWN) {
          gi.WriteByte(ServerCommandT.svc_temp_entity);
          gi.WriteByte(KexTempEventT.TE_SPLASH);
          gi.WriteByte(8);
          gi.WritePosition(tr.endpos);
          gi.WriteDir(tr.plane.normal);
          gi.WriteByte(color);
          gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
        }

        // change bullet's course when it enters water
        const dirAngles = vectoangles(vec3_sub(end, state.start));
        const { forward, right, up } = angleVectorsAll(dirAngles);
        const r = crandom() * state.hspread * 2;
        const u = crandom() * state.vspread * 2;
        let newEnd = vec3_add(state.water_start, vec3_muls(forward, 8192));
        newEnd = vec3_add(newEnd, vec3_muls(right, r));
        newEnd = vec3_add(newEnd, vec3_muls(up, u));
        VectorCopy(newEnd, end);
      }

      // re-trace ignoring water this time
      mask[0] = mask[0] & ~MASK_WATER;
      return true;
    }

    const hitEnt = traceEdict(tr.ent);

    // did we hit a hurtable entity?
    if (hitEnt.takedamage) {
      T_Damage(
        hitEnt,
        state.self,
        state.self,
        state.aimdir,
        tr.endpos,
        tr.plane.normal,
        state.damage,
        state.kick,
        state.mod.id === ModIdT.MOD_TESLA ? DamageflagsT.DAMAGE_ENERGY : DamageflagsT.DAMAGE_BULLET,
        state.mod,
      );

      // only deadmonster is pierceable, or actual dead monsters that
      // haven't been made non-solid yet
      if ((hitEnt.svflags & SvflagsT.SVF_DEADMONSTER) !== 0 || (hitEnt.health <= 0 && (hitEnt.svflags & SvflagsT.SVF_MONSTER) !== 0)) {
        if (!markPierce(pierce, hitEnt)) return false;
        return true;
      }
    } else {
      // send gun puff / flash; don't mark the sky
      const isSky = tr.surface !== null && ((tr.surface.flags & SurfflagsT.SURF_SKY) !== 0 || tr.surface.name.startsWith("sky"));
      if (state.te_impact !== -1 && !isSky) {
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(state.te_impact);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);

        if (state.self.client !== null) PlayerNoise(state.self, tr.endpos, PNOISE_IMPACT);
      }
    }

    // hit a solid, so we're stopping here
    return false;
  };
}

/**
 * g_weapon.cpp:248-318: `static void fire_lead(...)`. Internal support
 * routine for bullet/pellet weapons. See file header's "fire_lead's RAII
 * destructor is emulated" quirk note for the explicit double-`restorePierce`.
 */
function fire_lead(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number, te_impact: number, hspread: number, vspread: number, mod: ModT): void {
  const state: FireLeadState = {
    self,
    start: vec3(start[0], start[1], start[2]),
    aimdir,
    damage,
    kick,
    hspread,
    vspread,
    mod,
    te_impact,
    water: false,
    water_start: vec3(),
  };
  let mask: ContentsT = MASK_PROJECTILE | MASK_WATER;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) mask &= ~ContentsT.CONTENTS_PLAYER;

  // special case: we started in water.
  if ((gi.pointcontents(start) & MASK_WATER) !== 0) {
    state.water = true;
    state.water_start = vec3(start[0], start[1], start[2]);
    mask &= ~MASK_WATER;
  }

  const pierce: PierceArgsT = {
    pierced: new Array<EdictT | null>(MAX_PIERCE).fill(null),
    pierce_solidities: new Array<number>(MAX_PIERCE).fill(0),
    num_pierced: 0,
    tr: giTraceline(self.s.origin, self.s.origin, self, mask),
    hit: () => false,
  };
  pierce.hit = makeFireLeadHit(pierce, state);

  // check initial firing position
  pierceTrace(self.s.origin, start, self, pierce, mask);

  // we're clear, so do the second pierce
  if (pierce.tr.fraction === 1.0) {
    restorePierce(pierce);

    const dirAngles = vectoangles(aimdir);
    const { forward, right, up } = angleVectorsAll(dirAngles);

    const r = crandom() * hspread;
    const u = crandom() * vspread;
    let end = vec3_add(start, vec3_muls(forward, 8192));
    end = vec3_add(end, vec3_muls(right, r));
    end = vec3_add(end, vec3_muls(up, u));

    pierceTrace(pierce.tr.endpos, end, self, pierce, mask);
  }

  // if went through water, determine where the end is and make a bubble trail
  if (state.water && te_impact !== -1) {
    let dir = vec3_sub(pierce.tr.endpos, state.water_start);
    dir = vec3_normalized(dir);
    let pos = vec3_add(pierce.tr.endpos, vec3_muls(dir, -2));
    const world = g_edicts[0];

    if ((gi.pointcontents(pos) & MASK_WATER) !== 0) {
      pierce.tr = { ...pierce.tr, endpos: pos };
    } else {
      const passent = pierce.tr.ent !== null && traceEdict(pierce.tr.ent) !== world ? traceEdict(pierce.tr.ent) : null;
      pierce.tr = giTraceline(pos, state.water_start, passent, MASK_WATER);
    }

    pos = vec3_muls(vec3_add(state.water_start, pierce.tr.endpos), 0.5);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_BUBBLETRAIL);
    gi.WritePosition(state.water_start);
    gi.WritePosition(pierce.tr.endpos);
    gi.multicast(pos, KexMulticastT.MULTICAST_PVS, false);
  }

  // emulate fire_lead_pierce_t's destructor firing at scope exit -- see file header
  restorePierce(pierce);
}

/** g_weapon.cpp:328-331: `void fire_bullet(...)`. Fires a single round. */
export function fire_bullet(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number, hspread: number, vspread: number, mod: ModT): void {
  fire_lead(self, start, aimdir, damage, kick, mod.id === ModIdT.MOD_TESLA ? -1 : KexTempEventT.TE_GUNSHOT, hspread, vspread, mod);
}

/** g_weapon.cpp:340-344: `void fire_shotgun(...)`. Shoots shotgun pellets. */
export function fire_shotgun(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number, hspread: number, vspread: number, count: number, mod: ModT): void {
  for (let i = 0; i < count; i++) fire_lead(self, start, aimdir, damage, kick, KexTempEventT.TE_SHOTGUN, hspread, vspread, mod);
}

// ---------------------------------------------------------------------------
// fire_blaster
// ---------------------------------------------------------------------------

/** g_weapon.cpp:353-380: `TOUCH(blaster_touch)`. */
export const blaster_touch: TouchFn = RegisterTouch("blaster_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // PMM - crash prevention
  const owner = requireOwner(self, "blaster_touch");
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  if (other.takedamage) {
    T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_ENERGY, modFromId(self.style));
  } else {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(self.style !== ModIdT.MOD_BLUEBLASTER ? KexTempEventT.TE_BLASTER : KexTempEventT.TE_BLUEHYPERBLASTER);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(tr.plane.normal);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);
  }

  G_FreeEdict(self);
});

/** g_weapon.cpp:382-418: `void fire_blaster(...)`. Fires a single blaster bolt. */
export function fire_blaster(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: EffectsT, mod: ModT): void {
  const bolt = G_Spawn();
  bolt.svflags = SvflagsT.SVF_PROJECTILE;
  bolt.s.origin = vec3(start[0], start[1], start[2]);
  bolt.s.old_origin = vec3(start[0], start[1], start[2]);
  bolt.s.angles = vectoangles(dir);
  bolt.velocity = vec3_muls(dir, speed);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) bolt.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  bolt.flags |= EntFlagsT.FL_DODGE;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  bolt.s.modelindex = gi.modelindex("models/objects/laser/tris.md2");
  bolt.s.sound = gi.soundindex("misc/lasfly.wav");
  bolt.owner = self;
  bolt.touch = blaster_touch;
  bolt.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  bolt.style = mod.id;
  gi.linkentity(bolt);

  const tr = giTraceline(self.s.origin, bolt.s.origin, bolt, bolt.clipmask);
  if (tr.fraction < 1.0) {
    bolt.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    blaster_touch(bolt, traceEdict(tr.ent), tr, false);
  }
}

// ---------------------------------------------------------------------------
// fire_grenade / fire_grenade2
// ---------------------------------------------------------------------------

const SPAWNFLAG_GRENADE_HAND: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_GRENADE_HELD: SpawnFlags = SpawnFlags_from(2);

/** g_weapon.cpp:428-483: `THINK(Grenade_Explode)`. */
export const Grenade_Explode: ThinkFn = RegisterThink("Grenade_Explode", (ent: EdictT): void => {
  const owner = requireOwner(ent, "Grenade_Explode");
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  // FIXME: if we are onground then raise our Z just a bit since we are a point?
  if (ent.enemy !== null) {
    const v = vec3_sub(vec3_add(ent.enemy.s.origin, vec3_muls(vec3_add(ent.enemy.mins, ent.enemy.maxs), 0.5)), ent.s.origin);
    const points = ent.dmg - 0.5 * vec3_length(v);
    const dir = vec3_sub(ent.enemy.s.origin, ent.s.origin);
    const mod = modFromId(SpawnFlags_has(ent.spawnflags, SPAWNFLAG_GRENADE_HAND) ? ModIdT.MOD_HANDGRENADE : ModIdT.MOD_GRENADE);
    T_Damage(ent.enemy, ent, owner, dir, ent.s.origin, vec3_origin, Math.trunc(points), Math.trunc(points), DamageflagsT.DAMAGE_RADIUS, mod);
  }

  const splashModId = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_GRENADE_HELD)
    ? ModIdT.MOD_HELD_GRENADE
    : SpawnFlags_has(ent.spawnflags, SPAWNFLAG_GRENADE_HAND)
      ? ModIdT.MOD_HG_SPLASH
      : ModIdT.MOD_G_SPLASH;
  T_RadiusDamage(ent, owner, ent.dmg, ent.enemy, ent.dmg_radius, DamageflagsT.DAMAGE_NONE, modFromId(splashModId));

  const origin = vec3_add(ent.s.origin, vec3_muls(ent.velocity, -0.02));
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  if (ent.waterlevel !== 0) {
    gi.WriteByte(ent.groundentity !== null ? KexTempEventT.TE_GRENADE_EXPLOSION_WATER : KexTempEventT.TE_ROCKET_EXPLOSION_WATER);
  } else {
    gi.WriteByte(ent.groundentity !== null ? KexTempEventT.TE_GRENADE_EXPLOSION : KexTempEventT.TE_ROCKET_EXPLOSION);
  }
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(ent);
});

/** g_weapon.cpp:485-514: `TOUCH(Grenade_Touch)`. */
export const Grenade_Touch: TouchFn = RegisterTouch("Grenade_Touch", (ent: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === ent.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(ent);
    return;
  }

  if (!other.takedamage) {
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_GRENADE_HAND)) {
      gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex(frandom() > 0.5 ? "weapons/hgrenb1a.wav" : "weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
    } else {
      gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/grenlb1b.wav"), 1, ATTN_NORM, 0);
    }
    return;
  }

  ent.enemy = other;
  Grenade_Explode(ent);
});

/** g_weapon.cpp:516-535: `THINK(Grenade4_Think)`. */
export const Grenade4_Think: ThinkFn = RegisterThink("Grenade4_Think", (self: EdictT): void => {
  if (level.time >= self.timestamp) {
    Grenade_Explode(self);
    return;
  }

  if (self.velocity[0] !== 0 || self.velocity[1] !== 0 || self.velocity[2] !== 0) {
    const p = self.s.angles[0];
    const z = self.s.angles[2];
    const speedFrac = clamp((self.velocity[0] * self.velocity[0] + self.velocity[1] * self.velocity[1] + self.velocity[2] * self.velocity[2]) / (self.speed * self.speed), 0, 1);
    self.s.angles = vectoangles(self.velocity);
    self.s.angles[0] = LerpAngle(p, self.s.angles[0], speedFrac);
    self.s.angles[2] = z + gi.frame_time_s * 360 * speedFrac;
  }

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

/** See g_phys.ts's own "FRAME_TIME_S" file-header note: no InitGame-set
 *  global exists yet in this port line, so it's recomputed from
 *  `gi.frame_time_ms` on demand (by contract, never changes mid-game). */
function frameTimeAsGtime(): GTime {
  return Gtime_from_hz(1 / (gi.frame_time_ms / 1000));
}

/**
 * g_weapon.cpp:537-593: `void fire_grenade(...)`. See file header's
 * "monster-vs-non-monster branch" quirk note.
 */
export function fire_grenade(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  timer: GTime,
  damage_radius: number,
  right_adjust: number,
  up_adjust: number,
  monster: boolean,
): void {
  const dirAngles = vectoangles(aimdir);
  const { right, up } = angleVectorsAll(dirAngles);

  const grenade = G_Spawn();
  grenade.s.origin = vec3(start[0], start[1], start[2]);
  grenade.velocity = vec3_muls(aimdir, speed);

  if (up_adjust !== 0) {
    const gravityAdjustment = level.gravity / 800;
    grenade.velocity = vec3_add(grenade.velocity, vec3_muls(up, up_adjust * gravityAdjustment));
  }

  if (right_adjust !== 0) {
    grenade.velocity = vec3_add(grenade.velocity, vec3_muls(right, right_adjust));
  }

  grenade.movetype = MovetypeT.MOVETYPE_BOUNCE;
  grenade.clipmask = MASK_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) grenade.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  grenade.solid = SolidT.SOLID_BBOX;
  grenade.svflags |= SvflagsT.SVF_PROJECTILE;
  grenade.flags |= EntFlagsT.FL_DODGE | EntFlagsT.FL_TRAP;
  grenade.s.effects |= EffectsT.EF_GRENADE;
  grenade.speed = speed;
  if (monster) {
    grenade.avelocity = vec3(crandom() * 360, crandom() * 360, crandom() * 360);
    grenade.s.modelindex = gi.modelindex("models/objects/grenade/tris.md2");
    grenade.nextthink = Gtime_add(level.time, timer);
    grenade.think = Grenade_Explode;
    grenade.s.effects |= EffectsT.EF_GRENADE_LIGHT;
  } else {
    grenade.s.modelindex = gi.modelindex("models/objects/grenade4/tris.md2");
    grenade.s.angles = vectoangles(grenade.velocity);
    grenade.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    grenade.timestamp = Gtime_add(level.time, timer);
    grenade.think = Grenade4_Think;
    grenade.s.renderfx |= RenderfxT.RF_MINLIGHT;
  }
  grenade.owner = self;
  grenade.touch = Grenade_Touch;
  grenade.dmg = damage;
  grenade.dmg_radius = damage_radius;
  grenade.classname = "grenade";

  gi.linkentity(grenade);
}

/** g_weapon.cpp:595-644: `void fire_grenade2(...)`. */
export function fire_grenade2(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, speed: number, timer: GTime, damage_radius: number, held: boolean): void {
  const dirAngles = vectoangles(aimdir);
  const { right, up } = angleVectorsAll(dirAngles);

  const grenade = G_Spawn();
  grenade.s.origin = vec3(start[0], start[1], start[2]);
  grenade.velocity = vec3_muls(aimdir, speed);

  const gravityAdjustment = level.gravity / 800;

  grenade.velocity = vec3_add(grenade.velocity, vec3_muls(up, (200 + crandom() * 10) * gravityAdjustment));
  grenade.velocity = vec3_add(grenade.velocity, vec3_muls(right, crandom() * 10));

  grenade.avelocity = vec3(crandom() * 360, crandom() * 360, crandom() * 360);
  grenade.movetype = MovetypeT.MOVETYPE_BOUNCE;
  grenade.clipmask = MASK_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) grenade.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  grenade.solid = SolidT.SOLID_BBOX;
  grenade.svflags |= SvflagsT.SVF_PROJECTILE;
  grenade.flags |= EntFlagsT.FL_DODGE | EntFlagsT.FL_TRAP;
  grenade.s.effects |= EffectsT.EF_GRENADE;

  grenade.s.modelindex = gi.modelindex("models/objects/grenade3/tris.md2");
  grenade.owner = self;
  grenade.touch = Grenade_Touch;
  grenade.nextthink = Gtime_add(level.time, timer);
  grenade.think = Grenade_Explode;
  grenade.dmg = damage;
  grenade.dmg_radius = damage_radius;
  grenade.classname = "hand_grenade";
  grenade.spawnflags = SPAWNFLAG_GRENADE_HAND;
  if (held) grenade.spawnflags = SpawnFlags_from(grenade.spawnflags | SPAWNFLAG_GRENADE_HELD);
  grenade.s.sound = gi.soundindex("weapons/hgrenc1b.wav");

  if (timer <= 0) {
    Grenade_Explode(grenade);
  } else {
    gi.sound(self, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/hgrent1a.wav"), 1, ATTN_NORM, 0);
    gi.linkentity(grenade);
  }
}

// ---------------------------------------------------------------------------
// fire_rocket
// ---------------------------------------------------------------------------

/** g_weapon.cpp:651-699: `TOUCH(rocket_touch)`. */
export const rocket_touch: TouchFn = RegisterTouch("rocket_touch", (ent: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === ent.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(ent);
    return;
  }

  const owner = requireOwner(ent, "rocket_touch");
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  // calculate position for the explosion entity
  const origin = vec3_add(ent.s.origin, tr.plane.normal);

  if (other.takedamage) {
    T_Damage(other, ent, owner, ent.velocity, ent.s.origin, tr.plane.normal, ent.dmg, 0, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_ROCKET));
  } else {
    // don't throw any debris in net games
    if (!deathmatchEnabled() && !coopEnabled()) {
      if (tr.surface !== null && (tr.surface.flags & (SurfflagsT.SURF_WARP | SurfflagsT.SURF_TRANS33 | SurfflagsT.SURF_TRANS66 | SurfflagsT.SURF_FLOWING)) === 0) {
        const gibs: GibDefT[] = [{ count: irandom(5), gibname: "models/objects/debris2/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_DEBRIS }];
        ThrowGibs(ent, 2, gibs);
      }
    }
  }

  T_RadiusDamage(ent, owner, ent.radius_dmg, other, ent.dmg_radius, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_R_SPLASH));

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(ent.waterlevel !== 0 ? KexTempEventT.TE_ROCKET_EXPLOSION_WATER : KexTempEventT.TE_ROCKET_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(ent);
});

/** g_weapon.cpp:701-732: `edict_t *fire_rocket(...)`. */
export function fire_rocket(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, damage_radius: number, radius_damage: number): EdictT {
  const rocket = G_Spawn();
  rocket.s.origin = vec3(start[0], start[1], start[2]);
  rocket.s.angles = vectoangles(dir);
  rocket.velocity = vec3_muls(dir, speed);
  rocket.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  rocket.svflags |= SvflagsT.SVF_PROJECTILE;
  rocket.flags |= EntFlagsT.FL_DODGE;
  rocket.clipmask = MASK_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) rocket.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  rocket.solid = SolidT.SOLID_BBOX;
  rocket.s.effects |= EffectsT.EF_ROCKET;
  rocket.s.modelindex = gi.modelindex("models/objects/rocket/tris.md2");
  rocket.owner = self;
  rocket.touch = rocket_touch;
  rocket.nextthink = Gtime_add(level.time, Gtime_from_sec(8000 / speed));
  rocket.think = G_FreeEdict;
  rocket.dmg = damage;
  rocket.radius_dmg = radius_damage;
  rocket.dmg_radius = damage_radius;
  rocket.s.sound = gi.soundindex("weapons/rockfly.wav");
  rocket.classname = "rocket";

  gi.linkentity(rocket);

  return rocket;
}

// ---------------------------------------------------------------------------
// binary_positional_search(_r) / fire_rail
// ---------------------------------------------------------------------------

type SearchCallback = (viewer: Vec3, point: Vec3, portals: boolean) => boolean;

/** g_weapon.cpp:736-750: `bool binary_positional_search_r(...)`. */
function binary_positional_search_r(viewer: Vec3, start: Vec3, end: Vec3, cb: SearchCallback, split_num: number): boolean {
  // check half-way point
  const mid = vec3_muls(vec3_add(start, end), 0.5);

  if (cb(viewer, mid, true)) return true;

  // no more splits
  if (split_num === 0) return false;

  // recursively check both sides
  return binary_positional_search_r(viewer, start, mid, cb, split_num - 1) || binary_positional_search_r(viewer, mid, end, cb, split_num - 1);
}

/**
 * g_weapon.cpp:754-762: `bool binary_positional_search(...)`. [Paril-KEX]
 * simple binary search through a line to see if any points along the line
 * (in a binary split) pass the callback.
 */
function binary_positional_search(viewer: Vec3, start: Vec3, end: Vec3, cb: SearchCallback, num_splits: number): boolean {
  // check start/end first
  if (cb(viewer, start, true) || cb(viewer, end, true)) return true;

  // recursive split
  return binary_positional_search_r(viewer, start, end, cb, num_splits);
}

interface FireRailState {
  self: EdictT;
  aimdir: Vec3;
  damage: number;
  kick: number;
  water: boolean;
}

/** g_weapon.cpp:764-817: `struct fire_rail_pierce_t : pierce_args_t` -- its `hit()` override. */
function makeFireRailHit(pierce: PierceArgsT, state: FireRailState): PierceHitFn {
  return (mask: [ContentsT], _end: Vec3): boolean => {
    const tr = pierce.tr;

    if ((tr.contents & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0) {
      mask[0] = mask[0] & ~(ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA);
      state.water = true;
      return true;
    }

    const hitEnt = traceEdict(tr.ent);

    // try to kill it first
    if (hitEnt !== state.self && hitEnt.takedamage) {
      T_Damage(hitEnt, state.self, state.self, state.aimdir, tr.endpos, tr.plane.normal, state.damage, state.kick, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_RAILGUN));
    }

    // dead, so we don't need to care about checking pierce
    if (!hitEnt.inuse || hitEnt.solid === SolidT.SOLID_NOT || hitEnt.solid === SolidT.SOLID_TRIGGER) return true;

    // ZOID--added so rail goes through SOLID_BBOX entities (gibs, etc)
    // ROGUE
    if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) !== 0 || hitEnt.client !== null || (hitEnt.flags & EntFlagsT.FL_DAMAGEABLE) !== 0n || hitEnt.solid === SolidT.SOLID_BBOX) {
      if (!markPierce(pierce, hitEnt)) return false;
      return true;
    }

    return false;
  };
}

/** g_weapon.cpp:820-828: `uint32_t GetUnicastKey()` -- see file header. */
let unicastKeyState = 1;
export function GetUnicastKey(): number {
  if (unicastKeyState === 0) {
    unicastKeyState = 1;
    return 1;
  }
  const key = unicastKeyState;
  unicastKeyState = (unicastKeyState + 1) >>> 0;
  return key;
}

/** g_weapon.cpp:835-875: `void fire_rail(...)`. */
export function fire_rail(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, kick: number): void {
  const state: FireRailState = { self, aimdir, damage, kick, water: false };
  const pierce: PierceArgsT = {
    pierced: new Array<EdictT | null>(MAX_PIERCE).fill(null),
    pierce_solidities: new Array<number>(MAX_PIERCE).fill(0),
    num_pierced: 0,
    tr: giTraceline(start, start, self, MASK_PROJECTILE),
    hit: () => false,
  };
  pierce.hit = makeFireRailHit(pierce, state);

  let mask: ContentsT = MASK_PROJECTILE | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) mask &= ~ContentsT.CONTENTS_PLAYER;

  const end = vec3_add(start, vec3_muls(aimdir, 8192));

  pierceTrace(start, end, self, pierce, mask);

  const unicast_key = GetUnicastKey();

  // send gun puff / flash
  // [Paril-KEX] this often makes double noise, so trying a slightly
  // different approach...
  for (const player of active_players()) {
    const org = vec3_add(vec3_add(player.s.origin, player.client!.ps.viewoffset), vec3(0, 0, player.client!.ps.pmove.viewheight));

    if (binary_positional_search(org, start, pierce.tr.endpos, gi.inPHS, 3)) {
      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(deathmatchEnabled() && instagibEnabled() ? KexTempEventT.TE_RAILTRAIL2 : KexTempEventT.TE_RAILTRAIL);
      gi.WritePosition(start);
      gi.WritePosition(pierce.tr.endpos);
      gi.unicast(player, false, unicast_key);
    }
  }

  if (self.client !== null) PlayerNoise(self, pierce.tr.endpos, PNOISE_IMPACT);

  // emulate fire_rail_pierce_t's destructor firing at scope exit -- see file header
  restorePierce(pierce);
}

// ---------------------------------------------------------------------------
// fire_bfg
// ---------------------------------------------------------------------------

const PIf = Math.PI;

/** g_weapon.cpp:877-889: `static vec3_t bfg_laser_pos(vec3_t p, float dist)`. */
function bfg_laser_pos(p: Vec3, dist: number): Vec3 {
  const theta = frandom(2 * PIf);
  const phi = Math.acos(crandom());

  const d = vec3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));

  return vec3_add(p, vec3_muls(d, dist));
}

/** g_weapon.cpp:891-902: `THINK(bfg_laser_update)`. */
export const bfg_laser_update: ThinkFn = RegisterThink("bfg_laser_update", (self: EdictT): void => {
  if (level.time > self.timestamp || self.owner === null || !self.owner.inuse) {
    G_FreeEdict(self);
    return;
  }

  self.s.origin = vec3(self.owner.s.origin[0], self.owner.s.origin[1], self.owner.s.origin[2]);
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(1000));
  gi.linkentity(self);
});

/** g_weapon.cpp:904-926: `static void bfg_spawn_laser(edict_t *self)`. */
function bfg_spawn_laser(self: EdictT): void {
  const end = bfg_laser_pos(self.s.origin, 256);
  const tr = giTraceline(self.s.origin, end, self, MASK_OPAQUE);

  if (tr.fraction === 1.0) return;

  const laser = G_Spawn();
  laser.s.frame = 3;
  laser.s.renderfx = RF_BEAM_LIGHTNING;
  laser.movetype = MovetypeT.MOVETYPE_NONE;
  laser.solid = SolidT.SOLID_NOT;
  laser.s.modelindex = MODELINDEX_WORLD; // must be non-zero
  laser.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  laser.s.old_origin = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
  laser.s.skinnum = 0xd0d0d0d0;
  laser.think = bfg_laser_update;
  laser.nextthink = Gtime_add(level.time, Gtime_from_hz(1000));
  laser.timestamp = Gtime_add(level.time, Gtime_from_sec(0.3));
  laser.owner = self;
  gi.linkentity(laser);
}

/** g_weapon.cpp:933-987: `THINK(bfg_explode)`. */
export const bfg_explode: ThinkFn = RegisterThink("bfg_explode", (self: EdictT): void => {
  bfg_spawn_laser(self);

  if (self.s.frame === 0) {
    // the BFG effect
    let ent: EdictT | null = null;
    for (;;) {
      ent = findradius(ent, self.s.origin, self.dmg_radius);
      if (ent === null) break;
      if (!ent.takedamage) continue;
      if (ent === self.owner) continue;
      if (!CanDamage(ent, self)) continue;
      if (self.owner !== null && !CanDamage(ent, self.owner)) continue;
      // ROGUE - make tesla hurt by bfg
      if ((ent.svflags & SvflagsT.SVF_MONSTER) === 0 && (ent.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && ent.client === null && ent.classname !== "misc_explobox") continue;
      // ZOID -- don't target players in CTF
      if (self.owner !== null && CheckTeamDamage(ent, self.owner)) continue;
      // ZOID

      const centroid = vec3_add(ent.s.origin, vec3_muls(vec3_add(ent.mins, ent.maxs), 0.5));
      const v = vec3_sub(self.s.origin, centroid);
      const dist = vec3_length(v);
      const points = self.radius_dmg * (1.0 - Math.sqrt(dist / self.dmg_radius));

      T_Damage(ent, self, requireOwner(self, "bfg_explode"), self.velocity, centroid, vec3_origin, Math.trunc(points), 0, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_BFG_EFFECT));

      // Paril: draw BFG lightning laser to enemies
      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(KexTempEventT.TE_BFG_ZAP);
      gi.WritePosition(self.s.origin);
      gi.WritePosition(centroid);
      gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);
    }
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  self.s.frame++;
  if (self.s.frame === 5) self.think = G_FreeEdict;
});

/** g_weapon.cpp:989-1025: `TOUCH(bfg_touch)`. */
export const bfg_touch: TouchFn = RegisterTouch("bfg_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self, "bfg_touch");
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  // core explosion - prevents firing it into the wall/floor
  if (other.takedamage) T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, 200, 0, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_BFG_BLAST));
  T_RadiusDamage(self, owner, 200, other, 100, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_BFG_BLAST));

  gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/bfg__x1b.wav"), 1, ATTN_NORM, 0);
  self.solid = SolidT.SOLID_NOT;
  self.touch = null;
  self.s.origin = vec3_add(self.s.origin, vec3_muls(self.velocity, -1 * gi.frame_time_s));
  self.velocity = vec3();
  self.s.modelindex = gi.modelindex("sprites/s_bfg3.sp2");
  self.s.frame = 0;
  self.s.sound = 0;
  self.s.effects &= ~EffectsT.EF_ANIM_ALLFAST;
  self.think = bfg_explode;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  self.enemy = other;

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_BFG_BIGEXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);
});

interface BfgLaserState {
  self: EdictT;
  dir: Vec3;
  damage: number;
}

/** g_weapon.cpp:1028-1068: `struct bfg_laser_pierce_t : pierce_args_t` -- its `hit()` override. */
function makeBfgLaserHit(pierce: PierceArgsT, state: BfgLaserState): PierceHitFn {
  return (_mask: [ContentsT], _end: Vec3): boolean => {
    const tr = pierce.tr;
    const hitEnt = traceEdict(tr.ent);

    // hurt it if we can
    if (hitEnt.takedamage && (hitEnt.flags & EntFlagsT.FL_IMMUNE_LASER) === 0n && hitEnt !== state.self.owner) {
      T_Damage(hitEnt, state.self, requireOwner(state.self, "bfg_think"), state.dir, tr.endpos, vec3_origin, state.damage, 1, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_BFG_LASER));
    }

    // if we hit something that's not a monster or player we're done
    if ((hitEnt.svflags & SvflagsT.SVF_MONSTER) === 0 && (hitEnt.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && hitEnt.client === null) {
      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(KexTempEventT.TE_LASER_SPARKS);
      gi.WriteByte(4);
      gi.WritePosition(tr.endpos);
      gi.WriteDir(tr.plane.normal);
      gi.WriteByte(state.self.s.skinnum);
      gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
      return false;
    }

    if (!markPierce(pierce, hitEnt)) return false;

    return true;
  };
}

/**
 * g_weapon.cpp:1070-1138: `THINK(bfg_think)`. See file header's
 * "per-iteration restorePierce" quirk note for why `restorePierce` is
 * called once per `findradius` loop iteration here, not once after the
 * whole loop.
 */
export const bfg_think: ThinkFn = RegisterThink("bfg_think", (self: EdictT): void => {
  const dmg = deathmatchEnabled() ? 5 : 10;

  bfg_spawn_laser(self);

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, self.s.origin, 256);
    if (ent === null) break;

    if (ent === self) continue;
    if (ent === self.owner) continue;
    if (!ent.takedamage) continue;

    // ROGUE - make tesla hurt by bfg
    if ((ent.svflags & SvflagsT.SVF_MONSTER) === 0 && (ent.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && ent.client === null && ent.classname !== "misc_explobox") continue;
    // ZOID -- don't target players in CTF
    if (self.owner !== null && CheckTeamDamage(ent, self.owner)) continue;
    // ZOID

    const point = vec3_muls(vec3_add(ent.absmin, ent.absmax), 0.5);

    let dir = vec3_sub(point, self.s.origin);
    dir = vec3_normalized(dir);

    const start = self.s.origin;
    const end = vec3_add(start, vec3_muls(dir, 2048));

    // [Paril-KEX] don't fire a laser if we're blocked by the world
    const blockTr = giTraceline(start, point, null, MASK_SOLID);

    if (blockTr.fraction < 1.0) continue;

    const state: BfgLaserState = { self, dir, damage: dmg };
    const pierce: PierceArgsT = {
      pierced: new Array<EdictT | null>(MAX_PIERCE).fill(null),
      pierce_solidities: new Array<number>(MAX_PIERCE).fill(0),
      num_pierced: 0,
      tr: giTraceline(start, start, self, ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER),
      hit: () => false,
    };
    pierce.hit = makeBfgLaserHit(pierce, state);

    pierceTrace(start, end, self, pierce, ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER | ContentsT.CONTENTS_DEADMONSTER);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_BFG_LASER);
    gi.WritePosition(self.s.origin);
    gi.WritePosition(pierce.tr.endpos);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

    // emulate bfg_laser_pierce_t's destructor firing at THIS iteration's
    // scope exit -- see file header
    restorePierce(pierce);
  }

  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** g_weapon.cpp:1140-1172: `void fire_bfg(...)`. */
export function fire_bfg(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, damage_radius: number): void {
  const bfg = G_Spawn();
  bfg.s.origin = vec3(start[0], start[1], start[2]);
  bfg.s.angles = vectoangles(dir);
  bfg.velocity = vec3_muls(dir, speed);
  bfg.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bfg.clipmask = MASK_PROJECTILE;
  bfg.svflags = SvflagsT.SVF_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) bfg.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  bfg.solid = SolidT.SOLID_BBOX;
  bfg.s.effects |= EffectsT.EF_BFG | EffectsT.EF_ANIM_ALLFAST;
  bfg.s.modelindex = gi.modelindex("sprites/s_bfg1.sp2");
  bfg.owner = self;
  bfg.touch = bfg_touch;
  bfg.radius_dmg = damage;
  bfg.dmg_radius = damage_radius;
  bfg.classname = "bfg blast";
  bfg.s.sound = gi.soundindex("weapons/bfg__l1a.wav");

  bfg.think = bfg_think;
  bfg.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  bfg.teammaster = bfg;
  bfg.teamchain = null;

  gi.linkentity(bfg);

  // NOTE: the C++ source sets `bfg->nextthink`/`bfg->think` to
  // `G_FreeEdict`/`from_sec(8000.f/speed)` immediately above this block,
  // then UNCONDITIONALLY OVERWRITES both two lines later with
  // `bfg_think`/`FRAME_TIME_S` -- the first assignment is genuine dead code
  // in the shipped source (verified by reading g_weapon.cpp:1159-1167
  // twice: no branch, no early return between the two writes). Preserved
  // faithfully by simply not performing the dead first assignment at all
  // (an unobservable no-op either way, since the second write always wins).
}

// ---------------------------------------------------------------------------
// fire_disintegrator
// ---------------------------------------------------------------------------

/** g_weapon.cpp:1174-1188: `TOUCH(disintegrator_touch)`. */
export const disintegrator_touch: TouchFn = RegisterTouch("disintegrator_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WIDOWSPLASH);
  gi.WritePosition(vec3_sub(self.s.origin, vec3_muls(self.velocity, 0.01)));
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(self);

  if ((other.svflags & (SvflagsT.SVF_MONSTER | SvflagsT.SVF_PLAYER)) !== 0) {
    other.disintegrator_time = Gtime_add(other.disintegrator_time, Gtime_from_sec(50));
    other.disintegrator = self.owner;
  }
});

/** g_weapon.cpp:1190-1217: `void fire_disintegrator(...)`. */
export function fire_disintegrator(self: EdictT, start: Vec3, forward: Vec3, speed: number): void {
  const bfg = G_Spawn();
  bfg.s.origin = vec3(start[0], start[1], start[2]);
  bfg.s.angles = vectoangles(forward);
  bfg.velocity = vec3_muls(forward, speed);
  bfg.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bfg.clipmask = MASK_PROJECTILE;
  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) bfg.clipmask &= ~ContentsT.CONTENTS_PLAYER;
  bfg.solid = SolidT.SOLID_BBOX;
  bfg.s.effects |= EffectsT.EF_TAGTRAIL | EffectsT.EF_ANIM_ALL;
  bfg.s.renderfx |= RenderfxT.RF_TRANSLUCENT;
  bfg.svflags |= SvflagsT.SVF_PROJECTILE;
  bfg.flags |= EntFlagsT.FL_DODGE;
  bfg.s.modelindex = gi.modelindex("sprites/s_bfg1.sp2");
  bfg.owner = self;
  bfg.touch = disintegrator_touch;
  bfg.nextthink = Gtime_add(level.time, Gtime_from_sec(8000 / speed));
  bfg.think = G_FreeEdict;
  bfg.classname = "disint ball";
  bfg.s.sound = gi.soundindex("weapons/bfg__l1a.wav");

  gi.linkentity(bfg);
}
