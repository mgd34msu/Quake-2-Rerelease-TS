// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newweap.c -- the bulk of the ROGUE mission pack's new weapon
// primitives (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newweap.cpp
// (1,646 lines, C++17) in full: fire_flechette (ETF rifle bolt), the prox
// mine's full arm/live/explode state machine, fire_player_melee
// (chainfist), the nuke item's fuse/quake/explode sequence, the tesla
// trap's arm/zap-tick/explode sequence, the heatbeam's beam-tracing/damage
// primitive, fire_blaster2 (rogue's second, green blaster bolt), and the
// disintegrator/"tracker" homing projectile plus its pain-daemon
// damage-over-time follow-up.
//
// ============================================================================
// NOT CALLED FROM THIS FILE -- checked by grep, not assumed
// ============================================================================
// The porting brief for this unit suggested `MarkTeslaArea`/`CheckForBadArea`/
// `TargetTesla`/`SpawnBadArea` (rogue/g_rogue_newai.cpp, already landed in
// "./g_rogue_newai"), `findradius2` (rogue/g_rogue_utils.cpp, already landed
// in "./g_rogue_utils"), `T_RadiusClassDamage`/`cleanupHealTarget`
// (rogue/g_rogue_combat.cpp, already landed in "./g_rogue_combat"), and
// `monster_muzzleflash` (g_monster.ts) as candidates this file might need.
// `grep`ing the actual 1,646-line C++ source top to bottom for each name
// found none of them called anywhere in this file -- confirmed, not
// assumed. Only `T_RadiusNukeDamage` (from "./g_rogue_combat", used by
// `Nuke_Explode`) is actually used. The tesla/prox "bad area" marking these
// functions provide is wired up by monster AI code (already real in
// g_rogue_newai.ts), not by this file's projectile/trap code.
//
// ============================================================================
// p_weapon.ts EXPORT WIDENING (two one-line changes, no behavior change)
// ============================================================================
// `fire_nuke` needs `P_DamageModifier` (p_weapon.cpp:35-57, ROGUE's own
// damage-multiplier-for-quad/double helper) exactly the way the C++ source
// calls it directly (`int damage_modifier = P_DamageModifier(self);`) --
// p_weapon.ts already ports this function for real, but only as a local,
// unexported helper (its own weapon-fire dispatch calls it internally
// before invoking each `fire_frames` callback). It is now `export function
// P_DamageModifier(...)` instead of `function P_DamageModifier(...)` --
// nothing else about it changed. Likewise `Weapon_PowerupSound`
// (p_weapon.cpp:656-675) is called directly by p_rogue_weapon.ts's
// `weapon_etf_rifle_fire`/`Heatbeam_Fire` (mirroring the vanilla
// Weapon_Blaster/Weapon_HyperBlaster/etc. call sites already in p_weapon.ts
// itself) -- widened from `function` to `export function`, no other change.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `flechette_touch` (g_rogue_newweap.cpp:10-39) and `tracker_touch`
//   (g_rogue_newweap.cpp:1509-1559) both guard their `PlayerNoise(self->owner,
//   ...)` call with `if (self->client)` -- the PROJECTILE's own `client`
//   field, which is always null for these entities (they are never
//   player-controlled) -- instead of `if (self->owner && self->owner->client)`
//   like `blaster2_touch` correctly does two hundred lines later in the same
//   file. This makes the PlayerNoise call dead in practice for both
//   functions. Ported literally (the `self.client !== null` guard is kept,
//   not "fixed" to check the owner), matching this port line's mandate.
// - `blaster2_touch` (g_rogue_newweap.cpp:1316-1372): the C++ source branches
//   on `if (self->owner) {...} else {...}` around every `T_Damage`/
//   `T_RadiusDamage` call, but `fire_blaster2` unconditionally sets
//   `bolt->owner = self` and nothing ever clears it afterwards for this
//   entity type -- the `else` branch is dead in every real call path. Ported
//   as the always-true branch only, using a `must(self.owner, ...)` unwrap
//   once at the top (this port's non-nullable `T_Damage`/`T_RadiusDamage`
//   `attacker: EdictT` parameter can't take the C++ else-branch's
//   `self->owner` literal-null value anyway, so this collapse is required
//   for the file to type-check, not merely a style choice -- but it changes
//   zero observable behavior, since that branch could never execute).
// - `fire_beams` (g_rogue_newweap.cpp:1157-1288, the heatbeam trace/damage
//   primitive) takes an `offset` parameter and a `te_impact` parameter that
//   are both accepted but never read anywhere in the C++ body (every
//   temp-entity write inside hardcodes its own event id; `te_beam` is the
//   only one of the three trailing parameters actually used). Ported with
//   both named `_offset`/`_te_impact` to flag them as intentionally unused,
//   not dropped from the signature (both call sites in `fire_heatbeam` still
//   pass them, matching the C++ source's own dead-argument-passing).
// - `fire_blaster2` (g_rogue_newweap.cpp:1374-1416) takes a `hyper: boolean`
//   parameter that is never read in the body -- ported as `_hyper`, kept in
//   the signature (this port line's convention: preserve dead C parameters).
// - `prox_land` (g_rogue_newweap.cpp:290-414) computes `dir = vectoangles(...);
//   AngleVectors(dir, forward, right, up);` and never reads `forward`/
//   `right`/`up` afterwards -- a dead computation (matches g_rogue_phys.ts's
//   own "dead C store, kept out" precedent). Not ported (the `AngleVectors`
//   call has no other side effect to preserve).
// - `Prox_Field_Touch`/`prox_open` (g_rogue_newweap.cpp:150-286) both reach
//   `search`/`prox` fields (`prox->teammaster`, etc.) via unconditional
//   dereferences the C++ type system doesn't flag (raw pointers) but this
//   port's nullable `EdictT | null` fields do -- ported via the local
//   `must()` helper below (throws with context on the impossible-in-practice
//   null case, matching g_weapon.ts's own `requireOwner`/`requireEnemy`
//   idiom, generalized to any `EdictT | null` field instead of one named
//   helper per field).
//
// ============================================================================
// DEVIATIONS (structural, not behavioral)
// ============================================================================
// - Every C++ `vec3_t` operator chain (`a + b`, `a - b`, `a * scalar`,
//   `.normalize()`, `.dot()`) becomes an explicit `vec3_add`/`vec3_sub`/
//   `vec3_muls`/`vec3_normalized`/`vec3_dot` call from "../q_vec3", per
//   PORTING.md's copy-explicit-value convention.
// - `level.time + FRAME_TIME_S` (no InitGame-set `FRAME_TIME_S` global exists
//   in this port line yet) becomes `Gtime_add(level.time,
//   Gtime_from_ms(gi.frame_time_ms))`, matching g_rogue_monster.ts's/
//   g_phys.ts's identical precedent.
// - `modFromId`/`cvarBool`/`cvarInt`/`giTraceline`/`traceEdict` are local,
//   unexported per-file duplicates of the identical helpers already real in
//   g_weapon.ts/g_combat.ts/etc, matching this port line's established
//   tiny-helper-duplication convention (see g_items.ts's own `GTmax`
//   precedent, cited throughout this port line's rogue/*.ts files).
// - `fire_beams`'s bubble-trail block reassigns a local `effectiveEndpos`
//   instead of mutating `tr.endpos` in place (the C++ source does
//   `tr.endpos = pos;` mid-function) -- functionally identical, since
//   nothing reads `tr.endpos` again afterwards except through this same
//   local.

import { vec3, type Vec3 } from "../../shared/math";
import {
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_normalized,
  vec3_length,
  vec3_negate,
  vec3_any_nonzero,
  vec3_equals,
  vec3_dot,
  vec3_origin,
  AngleVectors_destructured,
  vectoangles,
  closest_point_to_box,
  boxes_intersect,
} from "../q_vec3";
import { type EdictT, EntFlagsT, MovetypeT, type ModT, ModIdT, DamageflagsT, PlayerNoiseT, random_time } from "../g_local";
import {
  type KexTraceT,
  type KexEdictT,
  type BoxEdictsFilterT,
  SolidT,
  SvflagsT,
  ContentsT,
  SurfflagsT,
  EffectsT,
  RenderfxT,
  SolidityAreaT,
  BoxEdictsResultT,
  ServerCommandT,
  KexTempEventT,
  KexMulticastT,
  SoundchanT,
  PlayerMuzzleT,
  CvarFlagsT,
  MASK_PROJECTILE,
  MASK_WATER,
  MODELINDEX_WORLD,
  MAX_EDICTS,
  ATTN_NORM,
  ATTN_NONE,
} from "../../kexapi/game";
import { gi, g_edicts, level, globals } from "../g_main_globals";
import { Gtime_add, Gtime_subtract, Gtime_from_sec, Gtime_from_ms, Gtime_from_hz, Gtime_seconds, Gtime_divide, Gtime_nonzero, type GTime, GTIME_ZERO } from "../gtime";
import { frandom, crandom } from "../q_std";
import type { ThinkFn, TouchFn, DieFn } from "../g_local_types";
import { RegisterThink, RegisterTouch, RegisterDie } from "../g_save_registry";
import { G_Spawn, G_FreeEdict, findradius } from "../g_utils";
import { visible } from "../g_ai";
import { T_Damage, T_RadiusDamage, CanDamage, CheckTeamDamage } from "../g_combat";
import { BecomeExplosion1 } from "../g_misc";
import { G_ShouldPlayersCollide } from "../p_client";
import { PlayerNoise, P_DamageModifier } from "../p_weapon";
import { Grenade_Explode } from "../g_weapon";
import { T_RadiusNukeDamage } from "./g_rogue_combat";

// ---------------------------------------------------------------------------
// small per-file helpers (see file header "DEVIATIONS")
// ---------------------------------------------------------------------------

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

function deathmatchEnabled(): boolean {
  return cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
}

/** `game_import_t::traceline` convenience wrapper (g_local.h:136-139), local
 *  duplicate matching g_weapon.ts's own identical helper. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** `trace_t::ent` (`KexEdictT | null`) -> the game-side `EdictT`, falling
 *  back to the world edict for a null trace target -- local duplicate
 *  matching g_weapon.ts's/g_rogue_phys.ts's own identical helper. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** Unwraps a `EdictT | null` field the C++ source dereferences
 *  unconditionally (raw pointer, never actually null on this call path) --
 *  see file header "QUIRKS PRESERVED BUG-FOR-BUG". */
function must(v: EdictT | null, ctx: string): EdictT {
  if (v === null) throw new Error(`g_rogue_newweap: ${ctx} is null (invariant violated -- unconditional C++ dereference)`);
  return v;
}

// ============================================================================
// fire_flechette (rogue/g_rogue_newweap.cpp:5-78)
// ============================================================================

/** rogue/g_rogue_newweap.cpp:10-39 `TOUCH(flechette_touch)`. */
export const flechette_touch: TouchFn = RegisterTouch("flechette_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // NOTE: checks self.client (always null for this projectile), not
  // self.owner.client -- upstream quirk, see file header.
  if (self.client !== null) {
    PlayerNoise(must(self.owner, "flechette_touch: self.owner"), self.s.origin, PlayerNoiseT.PNOISE_IMPACT);
  }

  if (other.takedamage) {
    T_Damage(
      other,
      self,
      must(self.owner, "flechette_touch: self.owner"),
      self.velocity,
      self.s.origin,
      tr.plane.normal,
      self.dmg,
      Math.trunc(self.dmg_radius),
      DamageflagsT.DAMAGE_NO_REG_ARMOR,
      modFromId(ModIdT.MOD_ETF_RIFLE),
    );
  } else {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_FLECHETTE);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(tr.plane.normal);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);
  }

  G_FreeEdict(self);
});

/** rogue/g_rogue_newweap.cpp:41-78 `void fire_flechette(...)`. */
export function fire_flechette(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, kick: number): void {
  const flechette = G_Spawn();
  flechette.s.origin = vec3(start[0], start[1], start[2]);
  flechette.s.old_origin = vec3(start[0], start[1], start[2]);
  flechette.s.angles = vectoangles(dir);
  flechette.velocity = vec3_muls(dir, speed);
  flechette.svflags |= SvflagsT.SVF_PROJECTILE;
  flechette.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  flechette.clipmask = MASK_PROJECTILE;
  flechette.flags |= EntFlagsT.FL_DODGE;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) flechette.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  flechette.solid = SolidT.SOLID_BBOX;
  flechette.s.renderfx = RenderfxT.RF_FULLBRIGHT;
  flechette.s.modelindex = gi.modelindex("models/proj/flechette/tris.md2");

  flechette.owner = self;
  flechette.touch = flechette_touch;
  flechette.nextthink = Gtime_add(level.time, Gtime_from_sec(8000 / speed));
  flechette.think = G_FreeEdict;
  flechette.dmg = damage;
  flechette.dmg_radius = kick;

  gi.linkentity(flechette);

  const tr = giTraceline(self.s.origin, flechette.s.origin, flechette, flechette.clipmask);
  if (tr.fraction < 1.0) {
    flechette.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    flechette_touch(flechette, traceEdict(tr.ent), tr, false);
  }
}

// ============================================================================
// PROX (rogue/g_rogue_newweap.cpp:80-498)
// ============================================================================

const PROX_TIME_TO_LIVE = Gtime_from_sec(45); // 45, 30, 15, 10
const PROX_TIME_DELAY = Gtime_from_ms(500);
const PROX_BOUND_SIZE = 96;
const PROX_DAMAGE_RADIUS = 192;
const PROX_HEALTH = 20;
const PROX_DAMAGE = 90;

/** rogue/g_rogue_newweap.cpp:93-128 `THINK(Prox_Explode)`. Also called
 *  directly (not just as a `.think` assignment) by several functions below,
 *  matching the C++ source's own mixed usage. */
export const Prox_Explode: ThinkFn = RegisterThink("Prox_Explode", (ent: EdictT): void => {
  // free the trigger field
  // PMM - changed teammaster to "mover" .. owner of the field is the prox
  if (ent.teamchain !== null && ent.teamchain.owner === ent) G_FreeEdict(ent.teamchain);

  let owner = ent;
  if (ent.teammaster !== null) {
    owner = ent.teammaster;
    PlayerNoise(owner, ent.s.origin, PlayerNoiseT.PNOISE_IMPACT);
  }

  // play quad sound if appropriate
  if (ent.dmg > PROX_DAMAGE) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

  ent.takedamage = false;
  T_RadiusDamage(ent, owner, ent.dmg, ent, PROX_DAMAGE_RADIUS, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_PROX));

  const origin = vec3_add(ent.s.origin, vec3_muls(ent.velocity, -0.02));
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(ent.groundentity !== null ? KexTempEventT.TE_GRENADE_EXPLOSION : KexTempEventT.TE_ROCKET_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(ent);
});

/** rogue/g_rogue_newweap.cpp:132-146 `DIE(prox_die)`. */
export const prox_die: DieFn = RegisterDie("prox_die", (self: EdictT, inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  // if set off by another prox, delay a little (chained explosions)
  if (inflictor.classname !== "prox_mine") {
    self.takedamage = false;
    Prox_Explode(self);
  } else {
    self.takedamage = false;
    self.think = Prox_Explode;
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  }
});

/** rogue/g_rogue_newweap.cpp:150-183 `TOUCH(Prox_Field_Touch)`. */
export const Prox_Field_Touch: TouchFn = RegisterTouch("Prox_Field_Touch", (ent: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) return;

  // trigger the prox mine if it's still there, and still mine.
  const prox = must(ent.owner, "Prox_Field_Touch: ent.owner");

  // teammate avoidance
  if (CheckTeamDamage(must(prox.teammaster, "Prox_Field_Touch: prox.teammaster"), other)) return;

  if (!deathmatchEnabled() && other.client !== null) return;

  if (other === prox) return; // don't set self off

  if (prox.think === Prox_Explode) return; // we're set to blow!

  if (prox.teamchain === ent) {
    gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/proxwarn.wav"), 1, ATTN_NORM, 0);
    prox.think = Prox_Explode;
    prox.nextthink = Gtime_add(level.time, PROX_TIME_DELAY);
    return;
  }

  ent.solid = SolidT.SOLID_NOT;
  G_FreeEdict(ent);
});

/** rogue/g_rogue_newweap.cpp:187-201 `THINK(prox_seek)`. */
export const prox_seek: ThinkFn = RegisterThink("prox_seek", (ent: EdictT): void => {
  if (level.time > Gtime_from_sec(ent.wait)) {
    Prox_Explode(ent);
  } else {
    ent.s.frame++;
    if (ent.s.frame > 13) ent.s.frame = 9;
    ent.think = prox_seek;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

/** rogue/g_rogue_newweap.cpp:205-286 `THINK(prox_open)`. */
export const prox_open: ThinkFn = RegisterThink("prox_open", (ent: EdictT): void => {
  if (ent.s.frame === 9) {
    // end of opening animation
    // set the owner to null so the owner can walk through it. needs to be
    // done here so the owner doesn't get stuck on it while it's opening if
    // fired at point blank wall
    ent.s.sound = 0;

    if (deathmatchEnabled()) ent.owner = null;

    if (ent.teamchain !== null) ent.teamchain.touch = Prox_Field_Touch;

    let search: EdictT | null = null;
    while ((search = findradius(search, ent.s.origin, PROX_DAMAGE_RADIUS + 10)) !== null) {
      const classname = search.classname;
      if (classname === null) continue; // tag token and other weird shit

      // teammate avoidance
      if (ent.teammaster !== null && CheckTeamDamage(search, ent.teammaster)) continue;

      // if it's a monster or player with health > 0
      // or it's a player start point
      // and we can see it
      // blow up
      const monsterOrPlayerAlive = ((search.svflags & SvflagsT.SVF_MONSTER) !== 0 || (deathmatchEnabled() && (search.client !== null || classname === "prox_mine"))) && search.health > 0;
      const dmSpawnPoint = deathmatchEnabled() && (classname.startsWith("info_player_") || classname === "misc_teleporter_dest" || classname.startsWith("item_flag_"));

      if (search !== ent && (monsterOrPlayerAlive || dmSpawnPoint) && visible(search, ent)) {
        gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/proxwarn.wav"), 1, ATTN_NORM, 0);
        Prox_Explode(ent);
        return;
      }
    }

    if (cvarBool("g_dm_strong_mines", "0")) {
      ent.wait = Gtime_seconds(Gtime_add(level.time, PROX_TIME_TO_LIVE));
    } else {
      switch (Math.trunc(ent.dmg / PROX_DAMAGE)) {
        case 1:
          ent.wait = Gtime_seconds(Gtime_add(level.time, PROX_TIME_TO_LIVE));
          break;
        case 2:
          ent.wait = Gtime_seconds(Gtime_add(level.time, Gtime_from_sec(30)));
          break;
        case 4:
          ent.wait = Gtime_seconds(Gtime_add(level.time, Gtime_from_sec(15)));
          break;
        case 8:
          ent.wait = Gtime_seconds(Gtime_add(level.time, Gtime_from_sec(10)));
          break;
        default:
          ent.wait = Gtime_seconds(Gtime_add(level.time, PROX_TIME_TO_LIVE));
          break;
      }
    }

    ent.think = prox_seek;
    ent.nextthink = Gtime_add(level.time, Gtime_from_ms(200));
  } else {
    if (ent.s.frame === 0) gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/proxopen.wav"), 1, ATTN_NORM, 0);
    ent.s.frame++;
    ent.think = prox_open;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

/** rogue/g_rogue_newweap.cpp:290-414 `TOUCH(prox_land)`. See file header's
 *  "DEVIATIONS" note on the dropped dead `AngleVectors` computation. */
export const prox_land: TouchFn = RegisterTouch("prox_land", (ent: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  let movetype: MovetypeT = MovetypeT.MOVETYPE_NONE;
  let stick_ok = false;

  // must turn off owner so owner can shoot it and set it off -- moved to
  // prox_open so owner can get away from it if fired at pointblank range
  // into wall
  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(ent);
    return;
  }

  if (vec3_any_nonzero(tr.plane.normal)) {
    const land_point = vec3_add(ent.s.origin, vec3_muls(tr.plane.normal, -10.0));
    if ((gi.pointcontents(land_point) & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0) {
      Prox_Explode(ent);
      return;
    }
  }

  const PROX_STOP_EPSILON = 0.1;

  if (!vec3_any_nonzero(tr.plane.normal) || (other.svflags & SvflagsT.SVF_MONSTER) !== 0 || other.client !== null || (other.flags & EntFlagsT.FL_DAMAGEABLE) !== 0n) {
    if (other !== ent.teammaster) Prox_Explode(ent);
    return;
  } else if (other !== g_edicts[0]) {
    // Here we need to check to see if we can stop on this entity.
    // Note that plane can be all-zero.

    // PMM - code stolen from g_phys (ClipVelocity)
    if (other.movetype === MovetypeT.MOVETYPE_PUSH && tr.plane.normal[2] > 0.7) stick_ok = true;
    else stick_ok = false;

    const backoff = vec3_dot(ent.velocity, tr.plane.normal) * 1.5;
    const out = vec3();
    for (let i = 0; i < 3; i++) {
      const change = tr.plane.normal[i] * backoff;
      out[i] = ent.velocity[i] - change;
      if (out[i] > -PROX_STOP_EPSILON && out[i] < PROX_STOP_EPSILON) out[i] = 0;
    }

    if (out[2] > 60) return;

    movetype = MovetypeT.MOVETYPE_BOUNCE;

    // if we're here, we're going to stop on an entity
    if (stick_ok) {
      // it's a happy entity
      ent.velocity = vec3();
      ent.avelocity = vec3();
    } else {
      // no-stick. teflon time
      if (tr.plane.normal[2] > 0.7) {
        Prox_Explode(ent);
        return;
      }
      return;
    }
  } else if (other.s.modelindex !== MODELINDEX_WORLD) {
    return;
  }

  let dir = vectoangles(tr.plane.normal);

  if ((gi.pointcontents(ent.s.origin) & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME)) !== 0) {
    Prox_Explode(ent);
    return;
  }

  ent.svflags &= ~SvflagsT.SVF_PROJECTILE;

  const field = G_Spawn();
  field.s.origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  field.mins = vec3(-PROX_BOUND_SIZE, -PROX_BOUND_SIZE, -PROX_BOUND_SIZE);
  field.maxs = vec3(PROX_BOUND_SIZE, PROX_BOUND_SIZE, PROX_BOUND_SIZE);
  field.movetype = MovetypeT.MOVETYPE_NONE;
  field.solid = SolidT.SOLID_TRIGGER;
  field.owner = ent;
  field.classname = "prox_field";
  field.teammaster = ent;
  gi.linkentity(field);

  ent.velocity = vec3();
  ent.avelocity = vec3();
  // rotate to vertical
  dir = vec3(dir[0] + 90, dir[1], dir[2]); // PITCH
  ent.s.angles = dir;
  ent.takedamage = true;
  ent.movetype = movetype; // either bounce or none, depending on whether we stuck to something
  ent.die = prox_die;
  ent.teamchain = field;
  ent.health = PROX_HEALTH;
  ent.nextthink = level.time;
  ent.think = prox_open;
  ent.touch = null;
  ent.solid = SolidT.SOLID_BBOX;

  gi.linkentity(ent);
});

/** rogue/g_rogue_newweap.cpp:416-427 `THINK(Prox_Think)`. */
export const Prox_Think: ThinkFn = RegisterThink("Prox_Think", (self: EdictT): void => {
  if (self.timestamp <= level.time) {
    Prox_Explode(self);
    return;
  }

  self.s.angles = vectoangles(vec3_normalized(self.velocity));
  self.s.angles[0] -= 90; // PITCH
  self.nextthink = level.time;
});

/** rogue/g_rogue_newweap.cpp:431-498 `void fire_prox(...)`. */
export function fire_prox(self: EdictT, start: Vec3, aimdir: Vec3, prox_damage_multiplier: number, speed: number): void {
  const dirAngles = vectoangles(aimdir);
  const { forward: _forward, right, up } = AngleVectors_destructured(dirAngles);

  const prox = G_Spawn();
  prox.s.origin = vec3(start[0], start[1], start[2]);
  prox.velocity = vec3_muls(aimdir, speed);

  const gravityAdjustment = level.gravity / 800;

  prox.velocity = vec3_add(prox.velocity, vec3_muls(up, (200 + crandom() * 10.0) * gravityAdjustment));
  prox.velocity = vec3_add(prox.velocity, vec3_muls(right, crandom() * 10.0));

  prox.s.angles = vec3(dirAngles[0] - 90, dirAngles[1], dirAngles[2]); // PITCH
  prox.movetype = MovetypeT.MOVETYPE_BOUNCE;
  prox.solid = SolidT.SOLID_BBOX;
  prox.svflags |= SvflagsT.SVF_PROJECTILE;
  prox.s.effects |= EffectsT.EF_GRENADE;
  prox.flags |= EntFlagsT.FL_DODGE | EntFlagsT.FL_TRAP;
  prox.clipmask = MASK_PROJECTILE | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) prox.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  prox.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  // FIXME - this needs to be bigger. Has other effects, though. Maybe have
  // to change origin to compensate so it sinks in correctly. Also in
  // lavacheck, might have to up the distance
  prox.mins = vec3(-6, -6, -6);
  prox.maxs = vec3(6, 6, 6);
  prox.s.modelindex = gi.modelindex("models/weapons/g_prox/tris.md2");
  prox.owner = self;
  prox.teammaster = self;
  prox.touch = prox_land;
  prox.think = Prox_Think;
  prox.nextthink = level.time;
  prox.dmg = PROX_DAMAGE * prox_damage_multiplier;
  prox.classname = "prox_mine";
  prox.flags |= EntFlagsT.FL_DAMAGEABLE;
  prox.flags |= EntFlagsT.FL_MECHANICAL;

  switch (prox_damage_multiplier) {
    case 1:
      prox.timestamp = Gtime_add(level.time, PROX_TIME_TO_LIVE);
      break;
    case 2:
      prox.timestamp = Gtime_add(level.time, Gtime_from_sec(30));
      break;
    case 4:
      prox.timestamp = Gtime_add(level.time, Gtime_from_sec(15));
      break;
    case 8:
      prox.timestamp = Gtime_add(level.time, Gtime_from_sec(10));
      break;
    default:
      prox.timestamp = Gtime_add(level.time, PROX_TIME_TO_LIVE);
      break;
  }

  gi.linkentity(prox);
}

// ============================================================================
// MELEE WEAPONS (rogue/g_rogue_newweap.cpp:500-589)
// ============================================================================

interface PlayerMeleeDataT {
  self: EdictT;
  start: Vec3;
  aim: Vec3;
  reach: number;
}

/**
 * rogue/g_rogue_newweap.cpp:512-540 `static BoxEdictsResult_t
 * fire_player_melee_BoxFilter(...)`. `data` is captured via closure instead
 * of threaded through gi.BoxEdicts's `filter_data`/`void*` parameter --
 * matches g_monster.ts's `M_CheckDodge`/g_trigger.ts's
 * `makeLatchedTriggerFilter` precedent (avoids an `as PlayerMeleeDataT` cast
 * on the `unknown` filter-data value).
 */
function fire_player_melee_BoxFilter(data: PlayerMeleeDataT, check: KexEdictT | null): BoxEdictsResultT {
  if (check === null) return BoxEdictsResultT.Skip;
  const full = g_edicts[check.s.number];
  if (full === undefined) return BoxEdictsResultT.Skip;

  if (!full.inuse || !full.takedamage || full === data.self) return BoxEdictsResultT.Skip;

  // check distance
  const closest_point_to_check = closest_point_to_box(data.start, vec3_add(full.s.origin, full.mins), vec3_add(full.s.origin, full.maxs));
  const closest_point_to_self = closest_point_to_box(closest_point_to_check, vec3_add(data.self.s.origin, data.self.mins), vec3_add(data.self.s.origin, data.self.maxs));

  // C++ computes `dir = closest_point_to_check - closest_point_to_self;
  // len = dir.normalize();` then, in the branch below, REASSIGNS `dir` to an
  // unrelated normalized vector -- only `len` from this first computation is
  // ever read, so the first `dir` value itself is dropped here (dead once
  // `len` is taken).
  const len = vec3_length(vec3_sub(closest_point_to_check, closest_point_to_self));

  if (len > data.reach) return BoxEdictsResultT.Skip;

  // check angle if we aren't intersecting
  const shrink = vec3(2, 2, 2);
  if (!boxes_intersect(vec3_add(full.absmin, shrink), vec3_sub(full.absmax, shrink), vec3_add(data.self.absmin, shrink), vec3_sub(data.self.absmax, shrink))) {
    const dir = vec3_normalized(vec3_sub(vec3_muls(vec3_add(full.absmin, full.absmax), 0.5), data.start));
    if (vec3_dot(dir, data.aim) < 0.7) return BoxEdictsResultT.Skip;
  }

  return BoxEdictsResultT.Keep;
}

/** rogue/g_rogue_newweap.cpp:542-589 `bool fire_player_melee(...)`. */
export function fire_player_melee(self: EdictT, start: Vec3, aim: Vec3, reach: number, damage: number, kick: number, mod: ModT): boolean {
  const MAX_HIT = 4;

  const reach_vec = vec3(reach - 1, reach - 1, reach - 1);
  const targets: (KexEdictT | null)[] = new Array(MAX_HIT).fill(null);

  const data: PlayerMeleeDataT = { self, start, aim, reach };
  const filter: BoxEdictsFilterT = (check) => fire_player_melee_BoxFilter(data, check);

  // find all the things we could maybe hit
  const num = gi.BoxEdicts(vec3_sub(self.absmin, reach_vec), vec3_add(self.absmax, reach_vec), targets, MAX_HIT, SolidityAreaT.AREA_SOLID, filter, null);

  if (num === 0) return false;

  let was_hit = false;

  for (let i = 0; i < num; i++) {
    const raw = targets[i];
    if (raw === null || raw === undefined) continue;
    const hit = g_edicts[raw.s.number];
    if (hit === undefined || !hit.inuse || !hit.takedamage) continue;
    if (!CanDamage(self, hit)) continue;

    // do the damage
    const closest_point_to_check = closest_point_to_box(start, vec3_add(hit.s.origin, hit.mins), vec3_add(hit.s.origin, hit.maxs));

    if ((hit.svflags & SvflagsT.SVF_MONSTER) !== 0) hit.pain_debounce_time = Gtime_subtract(hit.pain_debounce_time, random_time(Gtime_from_ms(5), Gtime_from_ms(75)));

    if (mod.id === ModIdT.MOD_CHAINFIST) {
      T_Damage(hit, self, self, aim, closest_point_to_check, vec3_negate(aim), damage, Math.trunc(kick / 2), DamageflagsT.DAMAGE_DESTROY_ARMOR | DamageflagsT.DAMAGE_NO_KNOCKBACK, mod);
    } else {
      T_Damage(hit, self, self, aim, closest_point_to_check, vec3_negate(aim), damage, Math.trunc(kick / 2), DamageflagsT.DAMAGE_NO_KNOCKBACK, mod);
    }

    was_hit = true;
  }

  return was_hit;
}

// ============================================================================
// NUKE (rogue/g_rogue_newweap.cpp:591-814)
// ============================================================================

const NUKE_DELAY = Gtime_from_sec(4);
const NUKE_TIME_TO_LIVE = Gtime_from_sec(6);
const NUKE_RADIUS = 512;
const NUKE_DAMAGE = 400;
const NUKE_QUAKE_TIME = Gtime_from_sec(3);
const NUKE_QUAKE_STRENGTH = 100;

/** rogue/g_rogue_newweap.cpp:602-632 `THINK(Nuke_Quake)`. */
export const Nuke_Quake: ThinkFn = RegisterThink("Nuke_Quake", (self: EdictT): void => {
  if (self.last_move_time < level.time) {
    gi.positioned_sound(self.s.origin, self, SoundchanT.CHAN_AUTO, self.noise_index, 0.75, ATTN_NONE, 0);
    self.last_move_time = Gtime_add(level.time, Gtime_from_ms(500));
  }

  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.client === null) continue;
    if (e.groundentity === null) continue;

    e.groundentity = null;
    e.velocity[0] += crandom() * 150;
    e.velocity[1] += crandom() * 150;
    e.velocity[2] = self.speed * (100.0 / e.mass);
  }

  if (level.time < self.timestamp) {
    self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  } else {
    G_FreeEdict(self);
  }
});

/** rogue/g_rogue_newweap.cpp:634-665 `static void Nuke_Explode(edict_t
 *  *ent)`. */
function Nuke_Explode(ent: EdictT): void {
  const teammaster = must(ent.teammaster, "Nuke_Explode: ent.teammaster");
  if (teammaster.client !== null) PlayerNoise(teammaster, ent.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  T_RadiusNukeDamage(ent, teammaster, ent.dmg, ent, ent.dmg_radius, modFromId(ModIdT.MOD_NUKE));

  if (ent.dmg > NUKE_DAMAGE) gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

  gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, gi.soundindex("weapons/grenlx1a.wav"), 1, ATTN_NONE, 0);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_NUKEBLAST);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_ALL, false);

  // become a quake
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.noise_index = gi.soundindex("world/rumble.wav");
  ent.think = Nuke_Quake;
  ent.speed = NUKE_QUAKE_STRENGTH;
  ent.timestamp = Gtime_add(level.time, NUKE_QUAKE_TIME);
  ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  ent.last_move_time = GTIME_ZERO;
}

/** rogue/g_rogue_newweap.cpp:667-676 `DIE(nuke_die)`. */
export const nuke_die: DieFn = RegisterDie("nuke_die", (self: EdictT, _inflictor: EdictT, attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  self.takedamage = false;
  if (attacker.classname === "nuke") {
    G_FreeEdict(self);
    return;
  }
  Nuke_Explode(self);
});

/** rogue/g_rogue_newweap.cpp:678-757 `THINK(Nuke_Think)`. */
export const Nuke_Think: ThinkFn = RegisterThink("Nuke_Think", (ent: EdictT): void => {
  const default_atten = 1.8;
  const nuke_damage_multiplier = Math.trunc(ent.dmg / NUKE_DAMAGE);
  let attenuation: number;
  let muzzleflash: number;

  switch (nuke_damage_multiplier) {
    case 1:
      attenuation = default_atten / 1.4;
      muzzleflash = PlayerMuzzleT.MZ_NUKE1;
      break;
    case 2:
      attenuation = default_atten / 2.0;
      muzzleflash = PlayerMuzzleT.MZ_NUKE2;
      break;
    case 4:
      attenuation = default_atten / 3.0;
      muzzleflash = PlayerMuzzleT.MZ_NUKE4;
      break;
    case 8:
      attenuation = default_atten / 5.0;
      muzzleflash = PlayerMuzzleT.MZ_NUKE8;
      break;
    default:
      attenuation = default_atten;
      muzzleflash = PlayerMuzzleT.MZ_NUKE1;
      break;
  }

  if (ent.wait < Gtime_seconds(level.time)) {
    Nuke_Explode(ent);
  } else if (level.time >= Gtime_subtract(Gtime_from_sec(ent.wait), NUKE_TIME_TO_LIVE)) {
    ent.s.frame++;

    if (ent.s.frame > 11) ent.s.frame = 6;

    if ((gi.pointcontents(ent.s.origin) & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0) {
      Nuke_Explode(ent);
      return;
    }

    ent.think = Nuke_Think;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
    ent.health = 1;
    ent.owner = null;

    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(muzzleflash);
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);

    if (ent.timestamp <= level.time) {
      if (Gtime_subtract(Gtime_from_sec(ent.wait), level.time) <= Gtime_divide(NUKE_TIME_TO_LIVE, 2.0)) {
        gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
        ent.timestamp = Gtime_add(level.time, Gtime_from_ms(300));
      } else {
        gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
        ent.timestamp = Gtime_add(level.time, Gtime_from_ms(500));
      }
    }
  } else {
    if (ent.timestamp <= level.time) {
      gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
      ent.timestamp = Gtime_add(level.time, Gtime_from_sec(1));
    }
    ent.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  }
});

/** rogue/g_rogue_newweap.cpp:759-768 `TOUCH(nuke_bounce)`. */
export const nuke_bounce: TouchFn = RegisterTouch("nuke_bounce", (ent: EdictT, _other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (tr.surface !== null && tr.surface.id !== 0) {
    if (frandom() > 0.5) gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("weapons/hgrenb1a.wav"), 1, ATTN_NORM, 0);
    else gi.sound(ent, SoundchanT.CHAN_BODY, gi.soundindex("weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
  }
});

/** rogue/g_rogue_newweap.cpp:770-814 `void fire_nuke(...)`. */
export function fire_nuke(self: EdictT, start: Vec3, aimdir: Vec3, speed: number): void {
  const dirAngles = vectoangles(aimdir);
  const { right, up } = AngleVectors_destructured(dirAngles);
  const damage_modifier = P_DamageModifier(self);

  const nuke = G_Spawn();
  nuke.s.origin = vec3(start[0], start[1], start[2]);
  nuke.velocity = vec3_muls(aimdir, speed);
  nuke.velocity = vec3_add(nuke.velocity, vec3_muls(up, 200 + crandom() * 10.0));
  nuke.velocity = vec3_add(nuke.velocity, vec3_muls(right, crandom() * 10.0));
  nuke.movetype = MovetypeT.MOVETYPE_BOUNCE;
  nuke.clipmask = MASK_PROJECTILE;
  nuke.solid = SolidT.SOLID_BBOX;
  nuke.s.effects |= EffectsT.EF_GRENADE;
  nuke.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  nuke.mins = vec3(-8, -8, 0);
  nuke.maxs = vec3(8, 8, 16);
  nuke.s.modelindex = gi.modelindex("models/weapons/g_nuke/tris.md2");
  nuke.owner = self;
  nuke.teammaster = self;
  nuke.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  nuke.wait = Gtime_seconds(Gtime_add(Gtime_add(level.time, NUKE_DELAY), NUKE_TIME_TO_LIVE));
  nuke.think = Nuke_Think;
  nuke.touch = nuke_bounce;

  nuke.health = 10000;
  nuke.takedamage = true;
  nuke.flags |= EntFlagsT.FL_DAMAGEABLE;
  nuke.dmg = NUKE_DAMAGE * damage_modifier;
  if (damage_modifier === 1) nuke.dmg_radius = NUKE_RADIUS;
  else nuke.dmg_radius = NUKE_RADIUS + NUKE_RADIUS * (0.25 * damage_modifier);
  // this yields 1.0, 1.5, 2.0, 3.0 times radius

  nuke.classname = "nuke";
  nuke.die = nuke_die;

  gi.linkentity(nuke);
}

// ============================================================================
// TESLA (rogue/g_rogue_newweap.cpp:816-1151)
// ============================================================================

const TESLA_TIME_TO_LIVE = Gtime_from_sec(30);
const TESLA_DAMAGE_RADIUS = 128;
const TESLA_DAMAGE = 3;
const TESLA_KNOCKBACK = 8;
const TESLA_ACTIVATE_TIME = Gtime_from_sec(3);
const TESLA_EXPLOSION_DAMAGE_MULT = 50; // amount damage is multiplied by for underwater explosions
const TESLA_EXPLOSION_RADIUS = 200;

/** rogue/g_rogue_newweap.cpp:830-857 `void tesla_remove(edict_t *self)`. */
export function tesla_remove(self: EdictT): void {
  self.takedamage = false;
  if (self.teamchain !== null) {
    let cur: EdictT | null = self.teamchain;
    while (cur !== null) {
      const next: EdictT | null = cur.teamchain;
      G_FreeEdict(cur);
      cur = next;
    }
  } else if (Gtime_nonzero(self.air_finished)) {
    gi.Com_Print("tesla_mine without a field!\n");
  }

  self.owner = self.teammaster; // Going away, set the owner correctly.
  // PGM - grenade explode does damage to self->enemy
  self.enemy = null;

  // play quad sound if quadded and an underwater explosion
  if (self.dmg_radius !== 0 && self.dmg > TESLA_DAMAGE * TESLA_EXPLOSION_DAMAGE_MULT) {
    gi.sound(self, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
  }

  Grenade_Explode(self);
}

/** rogue/g_rogue_newweap.cpp:859-862 `DIE(tesla_die)`. */
export const tesla_die: DieFn = RegisterDie("tesla_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  tesla_remove(self);
});

/** rogue/g_rogue_newweap.cpp:864-869 `void tesla_blow(edict_t *self)`. */
export function tesla_blow(self: EdictT): void {
  self.dmg *= TESLA_EXPLOSION_DAMAGE_MULT;
  self.dmg_radius = TESLA_EXPLOSION_RADIUS;
  tesla_remove(self);
}

/** rogue/g_rogue_newweap.cpp:871-873 `TOUCH(tesla_zap)` -- deliberately
 *  empty (the trigger volume's only job is to exist so
 *  `tesla_think_active`'s BoxEdicts sweep finds nearby entities). */
export const tesla_zap: TouchFn = RegisterTouch("tesla_zap", (_self: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  // intentionally empty -- see doc comment above.
});

/**
 * rogue/g_rogue_newweap.cpp:875-901 `static BoxEdictsResult_t
 * tesla_think_active_BoxFilter(...)`. `self` is captured via closure instead
 * of threaded through gi.BoxEdicts's `filter_data`/`void*` parameter --
 * matches g_monster.ts's `M_CheckDodge` precedent (avoids an `as EdictT`
 * cast on the `unknown` filter-data value).
 */
function tesla_think_active_BoxFilter(self: EdictT, check: KexEdictT | null): BoxEdictsResultT {
  if (check === null) return BoxEdictsResultT.Skip;
  const full = g_edicts[check.s.number];
  if (full === undefined) return BoxEdictsResultT.Skip;

  if (full === self) return BoxEdictsResultT.Skip;
  if (full.health < 1) return BoxEdictsResultT.Skip;
  // don't hit teammates
  if (full.client !== null) {
    if (!deathmatchEnabled()) return BoxEdictsResultT.Skip;
    if (self.teammaster !== null && CheckTeamDamage(full, self.teammaster)) return BoxEdictsResultT.Skip;
  }
  if ((full.svflags & SvflagsT.SVF_MONSTER) === 0 && (full.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && full.client === null) return BoxEdictsResultT.Skip;

  // don't hit other teslas in SP/coop
  if (!deathmatchEnabled() && full.classname !== null && (full.flags & EntFlagsT.FL_TRAP) !== 0n) return BoxEdictsResultT.Skip;

  return BoxEdictsResultT.Keep;
}

/** rogue/g_rogue_newweap.cpp:903-977 `THINK(tesla_think_active)`. The loop
 *  body re-checks (with slightly different logic than the filter above --
 *  e.g. `CheckTeamDamage(hit, self.teamchain.owner)` here vs.
 *  `CheckTeamDamage(full, self.teammaster)` in the filter) every candidate
 *  the filter already approved -- ported literally, both checks kept
 *  distinct, matching the C++ source's own belt-and-suspenders redundancy. */
export const tesla_think_active: ThinkFn = RegisterThink("tesla_think_active", (self: EdictT): void => {
  if (level.time > self.air_finished) {
    tesla_remove(self);
    return;
  }

  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + 16);

  const teamchain = must(self.teamchain, "tesla_think_active: self.teamchain");

  const touch: (KexEdictT | null)[] = new Array(MAX_EDICTS).fill(null);
  const filter: BoxEdictsFilterT = (check) => tesla_think_active_BoxFilter(self, check);
  const num = gi.BoxEdicts(teamchain.absmin, teamchain.absmax, touch, MAX_EDICTS, SolidityAreaT.AREA_SOLID, filter, null);

  for (let i = 0; i < num; i++) {
    // if the tesla died while zapping things, stop zapping.
    if (!self.inuse) break;

    const raw = touch[i];
    if (raw === null || raw === undefined) continue;
    const hit = g_edicts[raw.s.number];
    if (hit === undefined || !hit.inuse) continue;
    if (hit === self) continue;
    if (hit.health < 1) continue;
    // don't hit teammates
    if (hit.client !== null) {
      if (!deathmatchEnabled()) continue;
      if (CheckTeamDamage(hit, teamchain.owner ?? self)) continue;
    }
    if ((hit.svflags & SvflagsT.SVF_MONSTER) === 0 && (hit.flags & EntFlagsT.FL_DAMAGEABLE) === 0n && hit.client === null) continue;

    const tr = giTraceline(start, hit.s.origin, self, MASK_PROJECTILE);
    if (tr.fraction === 1 || traceEdict(tr.ent) === hit) {
      const dir = vec3_sub(hit.s.origin, start);

      // PMM - play quad sound if it's above the "normal" damage
      if (self.dmg > TESLA_DAMAGE) gi.sound(self, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

      // PGM - don't do knockback to walking monsters
      if ((hit.svflags & SvflagsT.SVF_MONSTER) !== 0 && (hit.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) {
        T_Damage(hit, self, self.owner ?? self, dir, tr.endpos, tr.plane.normal, self.dmg, 0, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_TESLA));
      } else {
        T_Damage(hit, self, self.owner ?? self, dir, tr.endpos, tr.plane.normal, self.dmg, TESLA_KNOCKBACK, DamageflagsT.DAMAGE_NONE, modFromId(ModIdT.MOD_TESLA));
      }

      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(KexTempEventT.TE_LIGHTNING);
      gi.WriteEntity(self); // source entity
      gi.WriteEntity(hit); // destination entity
      gi.WritePosition(start);
      gi.WritePosition(tr.endpos);
      gi.multicast(start, KexMulticastT.MULTICAST_PVS, false);
    }
  }

  if (self.inuse) {
    self.think = tesla_think_active;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

/** rogue/g_rogue_newweap.cpp:979-1033 `THINK(tesla_activate)`. */
export const tesla_activate: ThinkFn = RegisterThink("tesla_activate", (self: EdictT): void => {
  if ((gi.pointcontents(self.s.origin) & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_WATER)) !== 0) {
    tesla_blow(self);
    return;
  }

  // only check for spawn points in deathmatch
  if (deathmatchEnabled()) {
    let search: EdictT | null = null;
    while ((search = findradius(search, self.s.origin, 1.5 * TESLA_DAMAGE_RADIUS)) !== null) {
      const classname = search.classname;
      // [Paril-KEX] don't allow traps to be placed near flags or teleporters
      if (
        classname !== null &&
        (classname.startsWith("info_player_") || classname === "misc_teleporter_dest" || classname.startsWith("item_flag_")) &&
        visible(search, self)
      ) {
        BecomeExplosion1(self);
        return;
      }
    }
  }

  const trigger = G_Spawn();
  trigger.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  trigger.mins = vec3(-TESLA_DAMAGE_RADIUS, -TESLA_DAMAGE_RADIUS, self.mins[2]);
  trigger.maxs = vec3(TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS);
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.owner = self;
  trigger.touch = tesla_zap;
  trigger.classname = "tesla trigger";
  // doesn't need to be marked as a teamslave since the move code for bounce
  // looks for teamchains
  gi.linkentity(trigger);

  self.s.angles = vec3();
  // clear the owner if in deathmatch
  if (deathmatchEnabled()) self.owner = null;
  self.teamchain = trigger;
  self.think = tesla_think_active;
  self.nextthink = Gtime_add(level.time, Gtime_from_ms(gi.frame_time_ms));
  self.air_finished = Gtime_add(level.time, TESLA_TIME_TO_LIVE);
});

/** rogue/g_rogue_newweap.cpp:1035-1075 `THINK(tesla_think)`. */
export const tesla_think: ThinkFn = RegisterThink("tesla_think", (ent: EdictT): void => {
  if ((gi.pointcontents(ent.s.origin) & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0) {
    tesla_remove(ent);
    return;
  }

  ent.s.angles = vec3();

  if (ent.s.frame === 0) gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/teslaopen.wav"), 1, ATTN_NORM, 0);

  ent.s.frame++;
  if (ent.s.frame > 14) {
    ent.s.frame = 14;
    ent.think = tesla_activate;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    if (ent.s.frame > 9) {
      if (ent.s.frame === 10) {
        if (ent.owner !== null && ent.owner.client !== null) {
          PlayerNoise(ent.owner, ent.s.origin, PlayerNoiseT.PNOISE_WEAPON);
        }
        ent.s.skinnum = 1;
      } else if (ent.s.frame === 12) {
        ent.s.skinnum = 2;
      } else if (ent.s.frame === 14) {
        ent.s.skinnum = 3;
      }
    }
    ent.think = tesla_think;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  }
});

/** rogue/g_rogue_newweap.cpp:1077-1092 `TOUCH(tesla_lava)`. */
export const tesla_lava: TouchFn = RegisterTouch("tesla_lava", (ent: EdictT, _other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if ((tr.contents & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0) {
    tesla_blow(ent);
    return;
  }

  if (vec3_any_nonzero(ent.velocity)) {
    if (frandom() > 0.5) gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/hgrenb1a.wav"), 1, ATTN_NORM, 0);
    else gi.sound(ent, SoundchanT.CHAN_VOICE, gi.soundindex("weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
  }
});

/** rogue/g_rogue_newweap.cpp:1094-1151 `void fire_tesla(...)`. */
export function fire_tesla(self: EdictT, start: Vec3, aimdir: Vec3, tesla_damage_multiplier: number, speed: number): void {
  const dirAngles = vectoangles(aimdir);
  const { right, up } = AngleVectors_destructured(dirAngles);

  const tesla = G_Spawn();
  tesla.s.origin = vec3(start[0], start[1], start[2]);
  tesla.velocity = vec3_muls(aimdir, speed);

  const gravityAdjustment = level.gravity / 800;

  tesla.velocity = vec3_add(tesla.velocity, vec3_muls(up, (200 + crandom() * 10.0) * gravityAdjustment));
  tesla.velocity = vec3_add(tesla.velocity, vec3_muls(right, crandom() * 10.0));

  tesla.s.angles = vec3();
  tesla.movetype = MovetypeT.MOVETYPE_BOUNCE;
  tesla.solid = SolidT.SOLID_BBOX;
  tesla.s.effects |= EffectsT.EF_GRENADE;
  tesla.s.renderfx |= RenderfxT.RF_IR_VISIBLE;
  tesla.mins = vec3(-12, -12, 0);
  tesla.maxs = vec3(12, 12, 20);
  tesla.s.modelindex = gi.modelindex("models/weapons/g_tesla/tris.md2");

  tesla.owner = self; // PGM - we don't want it owned by self YET.
  tesla.teammaster = self;

  tesla.wait = Gtime_seconds(Gtime_add(level.time, TESLA_TIME_TO_LIVE));
  tesla.think = tesla_think;
  tesla.nextthink = Gtime_add(level.time, TESLA_ACTIVATE_TIME);

  // blow up on contact with lava & slime code
  tesla.touch = tesla_lava;

  if (deathmatchEnabled()) {
    // PMM - lowered from 50 - 7/29/1998
    tesla.health = 20;
  } else {
    tesla.health = 50; // FIXME - change depending on skill?
  }

  tesla.takedamage = true;
  tesla.die = tesla_die;
  tesla.dmg = TESLA_DAMAGE * tesla_damage_multiplier;
  tesla.classname = "tesla_mine";
  tesla.flags |= EntFlagsT.FL_DAMAGEABLE | EntFlagsT.FL_TRAP;
  tesla.clipmask = (MASK_PROJECTILE | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA) & ~ContentsT.CONTENTS_DEADMONSTER;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) tesla.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  tesla.flags |= EntFlagsT.FL_MECHANICAL;

  gi.linkentity(tesla);
}

// ============================================================================
// HEATBEAM (rogue/g_rogue_newweap.cpp:1153-1303)
// ============================================================================

/**
 * rogue/g_rogue_newweap.cpp:1157-1288 `static void fire_beams(...)`. See
 * file header's "QUIRKS PRESERVED BUG-FOR-BUG" note on `_offset`/
 * `_te_impact` being accepted but unused, and "DEVIATIONS" on the
 * `effectiveEndpos` local replacing an in-place `tr.endpos` mutation.
 */
function fire_beams(self: EdictT, start: Vec3, _offset: Vec3, aimdir: Vec3, damageIn: number, kick: number, te_beam: number, _te_impact: number, mod: ModT): void {
  let damage = damageIn;
  let water = false;
  let underwater = false;
  let water_start = vec3();
  let content_mask = MASK_PROJECTILE | MASK_WATER;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) content_mask &= ~ContentsT.CONTENTS_PLAYER;

  const dirAngles = vectoangles(aimdir);
  const { forward } = AngleVectors_destructured(dirAngles);

  const end = vec3_add(start, vec3_muls(forward, 8192));

  if ((gi.pointcontents(start) & MASK_WATER) !== 0) {
    underwater = true;
    water_start = vec3(start[0], start[1], start[2]);
    content_mask &= ~MASK_WATER;
  }

  let tr = giTraceline(start, end, self, content_mask);

  // see if we hit water
  if ((tr.contents & MASK_WATER) !== 0) {
    water = true;
    water_start = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

    if (!vec3_equals(start, tr.endpos)) {
      gi.WriteByte(ServerCommandT.svc_temp_entity);
      gi.WriteByte(KexTempEventT.TE_HEATBEAM_SPARKS);
      gi.WritePosition(water_start);
      gi.WriteDir(tr.plane.normal);
      gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
    }
    // re-trace ignoring water this time
    tr = giTraceline(water_start, end, self, content_mask & ~MASK_WATER);
  }
  const endpoint = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);

  // halve the damage if target underwater
  if (water) damage = Math.trunc(damage / 2);

  // send gun puff / flash
  if (!(tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0)) {
    if (tr.fraction < 1.0) {
      const hitEnt = traceEdict(tr.ent);
      if (hitEnt.takedamage) {
        T_Damage(hitEnt, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, DamageflagsT.DAMAGE_ENERGY, mod);
      } else if (!water && !(tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0)) {
        // This is the truncated steam entry -- uses 1+1+2 extra bytes of data
        gi.WriteByte(ServerCommandT.svc_temp_entity);
        gi.WriteByte(KexTempEventT.TE_HEATBEAM_STEAM);
        gi.WritePosition(tr.endpos);
        gi.WriteDir(tr.plane.normal);
        gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);

        if (self.client !== null) PlayerNoise(self, tr.endpos, PlayerNoiseT.PNOISE_IMPACT);
      }
    }
  }

  // if went through water, determine where the end and make a bubble trail
  let effectiveEndpos = tr.endpos;
  if (water || underwater) {
    const dir = vec3_normalized(vec3_sub(tr.endpos, water_start));
    const probe = vec3_add(tr.endpos, vec3_muls(dir, -2));
    if ((gi.pointcontents(probe) & MASK_WATER) !== 0) {
      effectiveEndpos = probe;
    } else {
      const retr = giTraceline(probe, water_start, traceEdict(tr.ent), MASK_WATER);
      effectiveEndpos = retr.endpos;
    }

    const mid = vec3_muls(vec3_add(water_start, effectiveEndpos), 0.5);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_BUBBLETRAIL2);
    gi.WritePosition(water_start);
    gi.WritePosition(effectiveEndpos);
    gi.multicast(mid, KexMulticastT.MULTICAST_PVS, false);
  }

  const beam_endpt: Vec3 = !underwater && !water ? effectiveEndpos : endpoint;

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(te_beam);
  gi.WriteEntity(self);
  gi.WritePosition(start);
  gi.WritePosition(beam_endpt);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_ALL, false);
}

/** rogue/g_rogue_newweap.cpp:1297-1303 `void fire_heatbeam(...)`. Fires a
 *  single heat beam. Zap. */
export function fire_heatbeam(self: EdictT, start: Vec3, aimdir: Vec3, offset: Vec3, damage: number, kick: number, monster: boolean): void {
  if (monster) {
    fire_beams(self, start, offset, aimdir, damage, kick, KexTempEventT.TE_MONSTER_HEATBEAM, KexTempEventT.TE_HEATBEAM_SPARKS, modFromId(ModIdT.MOD_HEATBEAM));
  } else {
    fire_beams(self, start, offset, aimdir, damage, kick, KexTempEventT.TE_HEATBEAM, KexTempEventT.TE_HEATBEAM_SPARKS, modFromId(ModIdT.MOD_HEATBEAM));
  }
}

// ============================================================================
// BLASTER 2 (rogue/g_rogue_newweap.cpp:1305-1416)
// ============================================================================

/** rogue/g_rogue_newweap.cpp:1316-1372 `TOUCH(blaster2_touch)`. See file
 *  header's "QUIRKS PRESERVED BUG-FOR-BUG" note on the collapsed
 *  `if (self->owner) {...} else {...}` split. */
export const blaster2_touch: TouchFn = RegisterTouch("blaster2_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  const owner = must(self.owner, "blaster2_touch: self.owner");
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PlayerNoiseT.PNOISE_IMPACT);

  if (other.takedamage) {
    // the only time players will be firing blaster2 bolts is from the
    // defender sphere.
    const mod = modFromId(owner.client !== null ? ModIdT.MOD_DEFENDER_SPHERE : ModIdT.MOD_BLASTER2);

    const damagestat = owner.takedamage;
    owner.takedamage = false;
    if (self.dmg >= 5) T_RadiusDamage(self, owner, self.dmg * 2, other, self.dmg_radius, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_UNKNOWN));
    T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg, 1, DamageflagsT.DAMAGE_ENERGY, mod);
    owner.takedamage = damagestat;
  } else {
    // PMM - yeowch this will get expensive
    if (self.dmg >= 5) T_RadiusDamage(self, owner, self.dmg * 2, owner, self.dmg_radius, DamageflagsT.DAMAGE_ENERGY, modFromId(ModIdT.MOD_UNKNOWN));

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_BLASTER2);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(tr.plane.normal);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);
  }

  G_FreeEdict(self);
});

/** rogue/g_rogue_newweap.cpp:1374-1416 `void fire_blaster2(...)`. Fires a
 *  single green blaster bolt. Used by monsters, generally. */
export function fire_blaster2(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, effect: EffectsT, _hyper: boolean): void {
  const bolt = G_Spawn();
  bolt.s.origin = vec3(start[0], start[1], start[2]);
  bolt.s.old_origin = vec3(start[0], start[1], start[2]);
  bolt.s.angles = vectoangles(dir);
  bolt.velocity = vec3_muls(dir, speed);
  bolt.svflags |= SvflagsT.SVF_PROJECTILE;
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_PROJECTILE;
  bolt.flags |= EntFlagsT.FL_DODGE;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) bolt.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  if (effect !== 0n) bolt.s.effects |= EffectsT.EF_TRACKER;
  bolt.dmg_radius = 128;
  bolt.s.modelindex = gi.modelindex("models/objects/laser/tris.md2");
  bolt.s.skinnum = 2;
  bolt.s.scale = 2.5;
  bolt.touch = blaster2_touch;

  bolt.owner = self;
  bolt.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  gi.linkentity(bolt);

  const tr = giTraceline(self.s.origin, bolt.s.origin, bolt, bolt.clipmask);
  if (tr.fraction < 1.0) {
    bolt.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    blaster2_touch(bolt, traceEdict(tr.ent), tr, false);
  }
}

// ============================================================================
// TRACKER (rogue/g_rogue_newweap.cpp:1418-1646)
// ============================================================================

const TRACKER_DAMAGE_FLAGS: DamageflagsT = DamageflagsT.DAMAGE_NO_POWER_ARMOR | DamageflagsT.DAMAGE_ENERGY | DamageflagsT.DAMAGE_NO_KNOCKBACK;
const TRACKER_IMPACT_FLAGS: DamageflagsT = DamageflagsT.DAMAGE_NO_POWER_ARMOR | DamageflagsT.DAMAGE_ENERGY;
const TRACKER_DAMAGE_TIME = Gtime_from_ms(500);

const pain_normal: Vec3 = vec3(0, 0, 1);

/** rogue/g_rogue_newweap.cpp:1427-1480 `THINK(tracker_pain_daemon_think)`. */
export const tracker_pain_daemon_think: ThinkFn = RegisterThink("tracker_pain_daemon_think", (self: EdictT): void => {
  if (!self.inuse) return;

  const enemy = must(self.enemy, "tracker_pain_daemon_think: self.enemy");

  if (Gtime_subtract(level.time, self.timestamp) > TRACKER_DAMAGE_TIME) {
    if (enemy.client === null) enemy.s.effects &= ~EffectsT.EF_TRACKERTRAIL;
    G_FreeEdict(self);
    return;
  }

  if (enemy.health > 0) {
    const center = vec3_muls(vec3_add(enemy.absmax, enemy.absmin), 0.5);

    T_Damage(enemy, self, must(self.owner, "tracker_pain_daemon_think: self.owner"), vec3_origin, center, pain_normal, self.dmg, 0, TRACKER_DAMAGE_FLAGS, modFromId(ModIdT.MOD_TRACKER));

    // if we kill the player, we'll be removed.
    if (self.inuse) {
      // if we killed a monster, gib them.
      if (enemy.health < 1) {
        const hurt = enemy.gib_health !== 0 ? -enemy.gib_health : 500;

        T_Damage(enemy, self, must(self.owner, "tracker_pain_daemon_think: self.owner"), vec3_origin, center, pain_normal, hurt, 0, TRACKER_DAMAGE_FLAGS, modFromId(ModIdT.MOD_TRACKER));
      }

      self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));

      if (enemy.client !== null) enemy.client.tracker_pain_time = self.nextthink;
      else enemy.s.effects |= EffectsT.EF_TRACKERTRAIL;
    }
  } else {
    if (enemy.client === null) enemy.s.effects &= ~EffectsT.EF_TRACKERTRAIL;
    G_FreeEdict(self);
  }
});

/** rogue/g_rogue_newweap.cpp:1482-1497 `void
 *  tracker_pain_daemon_spawn(...)`. */
export function tracker_pain_daemon_spawn(owner: EdictT, enemy: EdictT | null, damage: number): void {
  if (enemy === null) return;

  const daemon = G_Spawn();
  daemon.classname = "pain daemon";
  daemon.think = tracker_pain_daemon_think;
  daemon.nextthink = level.time;
  daemon.timestamp = level.time;
  daemon.owner = owner;
  daemon.enemy = enemy;
  daemon.dmg = damage;
}

/** rogue/g_rogue_newweap.cpp:1499-1507 `void tracker_explode(edict_t
 *  *self)`. */
export function tracker_explode(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_TRACKER_EXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  G_FreeEdict(self);
}

/** rogue/g_rogue_newweap.cpp:1509-1559 `TOUCH(tracker_touch)`. */
export const tracker_touch: TouchFn = RegisterTouch("tracker_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other === self.owner) return;

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // NOTE: checks self.client (always null for this projectile), not
  // self.owner.client -- same upstream quirk as flechette_touch (see file
  // header).
  if (self.client !== null) {
    PlayerNoise(must(self.owner, "tracker_touch: self.owner"), self.s.origin, PlayerNoiseT.PNOISE_IMPACT);
  }

  if (other.takedamage) {
    const owner = must(self.owner, "tracker_touch: self.owner");

    if ((other.svflags & SvflagsT.SVF_MONSTER) !== 0 || other.client !== null) {
      if (other.health > 0) {
        // knockback only for living creatures -- this does no damage, just knockback
        T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, 0, self.dmg * 3, TRACKER_IMPACT_FLAGS, modFromId(ModIdT.MOD_TRACKER));

        if ((other.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) other.velocity[2] += 140;

        const damagetime = (self.dmg * 0.1) / Gtime_seconds(TRACKER_DAMAGE_TIME);

        tracker_pain_daemon_spawn(owner, other, Math.trunc(damagetime));
      } else {
        // lots of damage (almost autogib) for dead bodies
        T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg * 4, self.dmg * 3, TRACKER_IMPACT_FLAGS, modFromId(ModIdT.MOD_TRACKER));
      }
    } else {
      // full damage in one shot for inanimate objects
      T_Damage(other, self, owner, self.velocity, self.s.origin, tr.plane.normal, self.dmg, self.dmg * 3, TRACKER_IMPACT_FLAGS, modFromId(ModIdT.MOD_TRACKER));
    }
  }

  tracker_explode(self);
});

/** rogue/g_rogue_newweap.cpp:1561-1597 `THINK(tracker_fly)`. */
export const tracker_fly: ThinkFn = RegisterThink("tracker_fly", (self: EdictT): void => {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse || enemy.health < 1) {
    tracker_explode(self);
    return;
  }

  let dest: Vec3;
  // PMM - try to hunt for center of enemy, if possible and not client
  if (enemy.client !== null) {
    dest = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
  } else if (!vec3_any_nonzero(enemy.absmin) || !vec3_any_nonzero(enemy.absmax)) {
    // paranoia
    dest = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  } else {
    dest = vec3_muls(vec3_add(enemy.absmin, enemy.absmax), 0.5);
  }

  const dir = vec3_normalized(vec3_sub(dest, self.s.origin));
  self.s.angles = vectoangles(dir);
  self.velocity = vec3_muls(dir, self.speed);
  self.monsterinfo.saved_goal = dest;

  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** rogue/g_rogue_newweap.cpp:1599-1646 `void fire_tracker(...)`. */
export function fire_tracker(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, enemy: EdictT | null): void {
  const bolt = G_Spawn();
  bolt.s.origin = vec3(start[0], start[1], start[2]);
  bolt.s.old_origin = vec3(start[0], start[1], start[2]);
  bolt.s.angles = vectoangles(dir);
  bolt.velocity = vec3_muls(dir, speed);
  bolt.svflags |= SvflagsT.SVF_PROJECTILE;
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_PROJECTILE;

  // [Paril-KEX]
  if (self.client !== null && !G_ShouldPlayersCollide(true)) bolt.clipmask &= ~ContentsT.CONTENTS_PLAYER;

  bolt.solid = SolidT.SOLID_BBOX;
  bolt.speed = speed;
  bolt.s.effects = EffectsT.EF_TRACKER;
  bolt.s.sound = gi.soundindex("weapons/disrupt.wav");
  bolt.s.modelindex = gi.modelindex("models/proj/disintegrator/tris.md2");
  bolt.touch = tracker_touch;
  bolt.enemy = enemy;
  bolt.owner = self;
  bolt.dmg = damage;
  bolt.classname = "tracker";
  gi.linkentity(bolt);

  if (enemy !== null) {
    bolt.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
    bolt.think = tracker_fly;
  } else {
    bolt.nextthink = Gtime_add(level.time, Gtime_from_sec(10));
    bolt.think = G_FreeEdict;
  }

  const tr = giTraceline(self.s.origin, bolt.s.origin, bolt, bolt.clipmask);
  if (tr.fraction < 1.0) {
    bolt.s.origin = vec3_add(tr.endpos, vec3_muls(tr.plane.normal, 1));
    tracker_touch(bolt, traceEdict(tr.ent), tr, false);
  }
}
