// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
// g_sphere.c
// pmack
// april 1998
//
// g_rogue_sphere.c -- the ROGUE mission pack's owned "buddy" spheres (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_sphere.cpp
// (710 lines, C++17) in full: the defender sphere (actively finds and
// shoots at enemies), the hunter sphere (waits until the owner drops below
// 25% health, then tracks whoever hurt them, with an optional "sam raimi
// cam" out-of-body-experience effect), and the vengeance sphere (kills
// whoever killed the owner) -- their movement (`sphere_fly`/`sphere_chase`),
// pain/die/think state machines, and their `Sphere_Spawn`/`Own_Sphere`/
// `Defender_Launch`/`Hunter_Launch`/`Vengeance_Launch` spawn entry points.
//
// ============================================================================
// DOPPELGANGER -- NOT this file's job, checked by grep
// ============================================================================
// This file's `sphere_touch`/`vengeance_touch`/`hunter_touch`/`hunter_pain`/
// `vengeance_pain`/`Sphere_Spawn` all branch on `SPHERE_DOPPLEGANGER`, and
// `Sphere_Spawn` accepts a `teammaster`-owned sphere for that case -- but
// the actual `Doppelganger_Spawn`/doppelganger entity logic that SETS that
// spawnflag lives entirely in rogue/g_rogue_newdm.cpp (confirmed by
// `grep`ping every .cpp under rerelease/rogue/ for "Doppelganger" --
// g_rogue_items.cpp, g_rogue_newdm.cpp, and this file are the only three
// hits, and this file only ever READS the flag, never sets it or spawns a
// doppelganger). g_rogue_newdm.cpp is the "dm/items" cluster's territory,
// out of this unit's scope -- not ported here.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `defender_shoot(self, enemy)` (g_rogue_sphere.cpp:278-303) takes an
//   `enemy` parameter, uses it for the `inuse`/`health`/`== self->owner`
//   checks, but its visibility check reads `self->enemy` instead --
//   `if (!visible(self, self->enemy)) return;`, NOT `visible(self, enemy)`.
//   Ported literally (the `self.enemy` field, not the `enemy` parameter, is
//   what gates visibility) -- in every real call site (`defender_think`
//   passes `self.enemy` as the `enemy` argument), the two happen to be the
//   same value, so this is not currently observable, but it is preserved as
//   written per this port line's mandate.
// - `hunter_pain`'s sam-raimi-cam block (g_rogue_sphere.cpp:355-397) sets
//   `owner->movetype = MOVETYPE_FLYMISSILE;` again inside `hunter_think`'s
//   own sam-raimi block a moment later -- both this file's `hunter_pain`
//   and `hunter_think` are ported with that apparent redundancy intact
//   (not merged into one assignment).
// - `sphere_fire` (g_rogue_sphere.cpp:170-192) is a real function in this
//   file but has no caller anywhere in g_rogue_sphere.cpp itself (verified
//   by grep) -- ported anyway since this file is its declared home; wire-up
//   (if any) belongs to whichever future unit calls it.
//
// ============================================================================
// DEVIATIONS (structural, not behavioral)
// ============================================================================
// - `vengeance_touch`/`hunter_touch` are declared further down in the C++
//   source (after `sphere_fire`) but `sphere_fire` assigns
//   `self->touch = vengeance_touch;` -- valid in C++ via the file's own
//   forward declarations. TS `const` bindings have no such forward
//   visibility, so `sphere_touch`/`vengeance_touch`/`hunter_touch` are
//   moved earlier in this file (defined right after the
//   explode/die helpers, before `sphere_fly`/`sphere_chase`/`sphere_fire`)
//   -- pure reordering, no behavior change, and each function's own doc
//   comment still cites its real C++ line range.
// - `modFromId`/`cvarBool`/`cvarInt`/`must` are local, unexported per-file
//   duplicates of the identical helpers already real in g_weapon.ts/
//   g_combat.ts/g_rogue_newweap.ts, matching this port line's established
//   tiny-helper-duplication convention.
// - Every C++ `vec3_t` operator chain becomes an explicit `vec3_add`/
//   `vec3_sub`/`vec3_muls`/`vec3_normalized` call from "../q_vec3", per
//   PORTING.md's copy-explicit-value convention.

import { vec3, type Vec3 } from "../../shared/math";
import { vec3_add, vec3_sub, vec3_muls, vec3_normalized, vec3_normalized_len, vec3_length, vec3_any_nonzero, vectoangles, vectoyaw } from "../q_vec3";
import { type EdictT, type ModT, ModIdT, EntFlagsT, MovetypeT, DamageflagsT, SPHERE_DEFENDER, SPHERE_HUNTER, SPHERE_VENGEANCE, SPHERE_DOPPLEGANGER, SPHERE_TYPE } from "../g_local";
import { type SpawnFlags, SpawnFlags_has, SpawnFlags_and } from "../spawnflags";
import { type KexTraceT, SolidT, SurfflagsT, EffectsT, RenderfxT, SoundchanT, CvarFlagsT, MASK_PROJECTILE, ATTN_NORM } from "../../kexapi/game";
import { gi, g_edicts, level } from "../g_main_globals";
import { Gtime_add, Gtime_subtract, Gtime_from_sec, Gtime_from_ms, Gtime_from_hz, Gtime_seconds, Gtime_nonzero, GTIME_ZERO } from "../gtime";
import type { ThinkFn, TouchFn, PainFn, DieFn } from "../g_local_types";
import { RegisterThink, RegisterTouch, RegisterPain, RegisterDie } from "../g_save_registry";
import { G_Spawn, G_FreeEdict } from "../g_utils";
import { visible } from "../g_ai";
import { M_ChangeYaw } from "../m_move";
import { T_Damage, T_RadiusDamage } from "../g_combat";
import { BecomeExplosion1, ThrowGibs, type GibDefT } from "../g_misc";
import { LookAtKiller } from "../p_client";
import { fire_blaster2 } from "./g_rogue_newweap";

const DEFENDER_LIFESPAN = Gtime_from_sec(30);
const HUNTER_LIFESPAN = Gtime_from_sec(30);
const VENGEANCE_LIFESPAN = Gtime_from_sec(30);
const MINIMUM_FLY_TIME = Gtime_from_sec(15);

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

/** Unwraps a `EdictT | GClientT | null` field the C++ source dereferences
 *  unconditionally (raw pointer, never actually null on this call path). */
function must<T>(v: T | null, ctx: string): T {
  if (v === null) throw new Error(`g_rogue_sphere: ${ctx} is null (invariant violated -- unconditional C++ dereference)`);
  return v;
}

// ---------------------------------------------------------------------------
// General Sphere Code (rogue/g_rogue_sphere.cpp:23-53)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:29-36 `THINK(sphere_think_explode)`. Also
 *  called directly (not just as a `.think` assignment) by several functions
 *  below, matching the C++ source's own mixed usage. */
export const sphere_think_explode: ThinkFn = RegisterThink("sphere_think_explode", (self: EdictT): void => {
  if (self.owner !== null && self.owner.client !== null && !SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    self.owner.client.owned_sphere = null;
  }
  BecomeExplosion1(self);
});

/** rogue/g_rogue_sphere.cpp:41-44 `DIE(sphere_explode)`. */
export const sphere_explode: DieFn = RegisterDie("sphere_explode", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  sphere_think_explode(self);
});

/** rogue/g_rogue_sphere.cpp:49-53 `DIE(sphere_if_idle_die)` -- if the
 *  sphere is not currently attacking, blow up. */
export const sphere_if_idle_die: DieFn = RegisterDie("sphere_if_idle_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
  if (self.enemy === null) sphere_think_explode(self);
});

// ---------------------------------------------------------------------------
// Touch handlers (rogue/g_rogue_sphere.cpp:196-274) -- moved ahead of
// sphere_fly/sphere_chase/sphere_fire, see file header "DEVIATIONS"
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:196-236 `void sphere_touch(edict_t *self,
 *  edict_t *other, const trace_t &tr, mod_t mod)`. Not itself a `TouchFn`
 *  (takes an extra `mod` parameter) -- called by `vengeance_touch`/
 *  `hunter_touch` below, which are. */
function sphere_touch(self: EdictT, other: EdictT, tr: KexTraceT, mod: ModT): void {
  if (SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    if (other === self.teammaster) return;

    self.takedamage = false;
    self.owner = self.teammaster;
    self.teammaster = null;
  } else {
    if (other === self.owner) return;
    // PMM - don't blow up on bodies
    if (other.classname === "bodyque") return;
  }

  if (tr.surface !== null && (tr.surface.flags & SurfflagsT.SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  if (self.owner !== null) {
    if (other.takedamage) {
      T_Damage(other, self, self.owner, self.velocity, self.s.origin, tr.plane.normal, 10000, 1, DamageflagsT.DAMAGE_DESTROY_ARMOR, mod);
    } else {
      T_RadiusDamage(self, self.owner, 512, self.owner, 256, DamageflagsT.DAMAGE_NONE, mod);
    }
  }

  sphere_think_explode(self);
}

/** rogue/g_rogue_sphere.cpp:240-246 `TOUCH(vengeance_touch)`. */
export const vengeance_touch: TouchFn = RegisterTouch("vengeance_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) sphere_touch(self, other, tr, modFromId(ModIdT.MOD_DOPPLE_VENGEANCE));
  else sphere_touch(self, other, tr, modFromId(ModIdT.MOD_VENGEANCE_SPHERE));
});

/** rogue/g_rogue_sphere.cpp:250-274 `TOUCH(hunter_touch)`. */
export const hunter_touch: TouchFn = RegisterTouch("hunter_touch", (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  // don't blow up if you hit the world.... sheesh.
  if (other === g_edicts[0]) return;

  if (self.owner !== null) {
    // if owner is flying with us, make sure they stop too.
    const owner = self.owner;
    if ((owner.flags & EntFlagsT.FL_SAM_RAIMI) !== 0n) {
      owner.velocity = vec3();
      owner.movetype = MovetypeT.MOVETYPE_NONE;
      gi.linkentity(owner);
    }
  }

  if (SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) sphere_touch(self, other, tr, modFromId(ModIdT.MOD_DOPPLE_HUNTER));
  else sphere_touch(self, other, tr, modFromId(ModIdT.MOD_HUNTER_SPHERE));
});

// ---------------------------------------------------------------------------
// Sphere Movement (rogue/g_rogue_sphere.cpp:56-162)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:61-87 `void sphere_fly(edict_t *self)`. */
export function sphere_fly(self: EdictT): void {
  if (level.time >= Gtime_from_sec(self.wait)) {
    sphere_think_explode(self);
    return;
  }

  const owner = must(self.owner, "sphere_fly: self.owner");
  const dest = vec3(owner.s.origin[0], owner.s.origin[1], owner.absmax[2] + 4);

  const secs = Gtime_seconds(level.time);
  if (secs === Math.trunc(secs)) {
    if (!visible(self, owner)) {
      self.s.origin = dest;
      gi.linkentity(self);
      return;
    }
  }

  const dir = vec3_sub(dest, self.s.origin);
  self.velocity = vec3_muls(dir, 5);
}

/** rogue/g_rogue_sphere.cpp:91-162 `void sphere_chase(edict_t *self, int
 *  stupidChase)`. `stupidChase` ported as `boolean` (callers only ever pass
 *  the C++ literals `0`/`1`). */
export function sphere_chase(self: EdictT, stupidChase: boolean): void {
  const enemy = self.enemy;
  if (level.time >= Gtime_from_sec(self.wait) || (enemy !== null && enemy.health < 1)) {
    sphere_think_explode(self);
    return;
  }

  const target = must(enemy, "sphere_chase: self.enemy");
  const dest = target.client !== null ? vec3(target.s.origin[0], target.s.origin[1], target.s.origin[2] + target.viewheight) : vec3(target.s.origin[0], target.s.origin[1], target.s.origin[2]);

  if (visible(self, target) || stupidChase) {
    // if moving, hunter sphere uses active sound
    if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_active.wav");

    const { vec: dir } = vec3_normalized_len(vec3_sub(dest, self.s.origin));
    self.s.angles = vectoangles(dir);
    self.velocity = vec3_muls(dir, 500);
    self.monsterinfo.saved_goal = dest;
  } else if (!vec3_any_nonzero(self.monsterinfo.saved_goal)) {
    const { vec: dir } = vec3_normalized_len(vec3_sub(target.s.origin, self.s.origin));
    self.s.angles = vectoangles(dir);

    // if lurking, hunter sphere uses lurking sound
    self.s.sound = gi.soundindex("spheres/h_lurk.wav");
    self.velocity = vec3();
  } else {
    const { vec: dir, len: dist } = vec3_normalized_len(vec3_sub(self.monsterinfo.saved_goal, self.s.origin));

    if (dist > 1) {
      self.s.angles = vectoangles(dir);

      if (dist > 500) self.velocity = vec3_muls(dir, 500);
      else if (dist < 20) self.velocity = vec3_muls(dir, dist / gi.frame_time_s);
      else self.velocity = vec3_muls(dir, dist);

      // if moving, hunter sphere uses active sound
      if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_active.wav");
    } else {
      const { vec: dir2 } = vec3_normalized_len(vec3_sub(target.s.origin, self.s.origin));
      self.s.angles = vectoangles(dir2);

      // if not moving, hunter sphere uses lurk sound
      if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_lurk.wav");

      self.velocity = vec3();
    }
  }
}

// ---------------------------------------------------------------------------
// Attack related stuff (rogue/g_rogue_sphere.cpp:164-303)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:170-192 `void sphere_fire(edict_t *self,
 *  edict_t *enemy)`. See file header's "QUIRKS PRESERVED BUG-FOR-BUG" note
 *  -- unreferenced anywhere else in this file, ported anyway. */
export function sphere_fire(self: EdictT, enemy: EdictT | null): void {
  if (enemy === null || level.time >= Gtime_from_sec(self.wait)) {
    sphere_think_explode(self);
    return;
  }

  const dest = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  self.s.effects |= EffectsT.EF_ROCKET;

  const dir = vec3_normalized(vec3_sub(dest, self.s.origin));
  self.s.angles = vectoangles(dir);
  self.velocity = vec3_muls(dir, 1000);

  self.touch = vengeance_touch;
  self.think = sphere_think_explode;
  self.nextthink = Gtime_from_sec(self.wait);
}

/**
 * rogue/g_rogue_sphere.cpp:278-303 `void defender_shoot(edict_t *self,
 * edict_t *enemy)`. See file header's "QUIRKS PRESERVED BUG-FOR-BUG" note on
 * the visibility check reading `self.enemy`, not the `enemy` parameter.
 */
export function defender_shoot(self: EdictT, enemy: EdictT): void {
  if (!enemy.inuse || enemy.health <= 0) return;
  if (enemy === self.owner) return;

  const dir = vec3_normalized(vec3_sub(enemy.s.origin, self.s.origin));

  if (self.monsterinfo.attack_finished > level.time) return;
  if (!visible(self, must(self.enemy, "defender_shoot: self.enemy"))) return;

  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + 2);
  fire_blaster2(must(self.owner, "defender_shoot: self.owner"), start, dir, 10, 1000, EffectsT.EF_BLASTER, false);

  self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_ms(400));
}

// ---------------------------------------------------------------------------
// Activation Related Stuff (rogue/g_rogue_sphere.cpp:305-439)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:311-318 `void body_gib(edict_t *self)`. */
export function body_gib(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
  const gibs: GibDefT[] = [
    { count: 4, gibname: "models/objects/gibs/sm_meat/tris.md2" },
    { gibname: "models/objects/gibs/skull/tris.md2" },
  ];
  ThrowGibs(self, 50, gibs);
}

/** rogue/g_rogue_sphere.cpp:322-398 `PAIN(hunter_pain)`. */
export const hunter_pain: PainFn = RegisterPain("hunter_pain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  if (self.enemy !== null) return;

  const owner = self.owner;

  if (!SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    if (owner !== null && owner.health > 0) return;

    // PMM
    if (other === owner) return;
    // pmm
  } else {
    // if fired by a doppleganger, set it to 10 second timeout
    self.wait = Gtime_seconds(Gtime_add(level.time, MINIMUM_FLY_TIME));
  }

  if (Gtime_subtract(Gtime_from_sec(self.wait), level.time) < MINIMUM_FLY_TIME) self.wait = Gtime_seconds(Gtime_add(level.time, MINIMUM_FLY_TIME));
  self.s.effects |= EffectsT.EF_BLASTER | EffectsT.EF_TRACKER;
  self.touch = hunter_touch;
  self.enemy = other;

  // if we're not owned by a player, no sam raimi
  // if we're spawned by a doppleganger, no sam raimi
  if (SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER) || !(owner !== null && owner.client !== null)) return;

  // sam raimi cam is disabled if FORCE_RESPAWN is set.
  // sam raimi cam is also disabled if huntercam->value is 0.
  if (!cvarBool("g_dm_force_respawn", "0") && cvarBool("huntercam", "1")) {
    const dist = vec3_length(vec3_sub(other.s.origin, self.s.origin));

    if (owner !== null && dist >= 192) {
      // detach owner from body and send him flying
      owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;

      // gib like we just died, even though we didn't, really.
      body_gib(owner);

      // move the sphere to the owner's current viewpoint.
      // we know it's a valid spot (or will be momentarily)
      self.s.origin = vec3(owner.s.origin[0], owner.s.origin[1], owner.s.origin[2] + owner.viewheight);

      // move the player's origin to the sphere's new origin
      owner.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
      owner.s.angles = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
      const ownerClient = must(owner.client, "hunter_pain: owner.client");
      ownerClient.v_angle = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
      owner.mins = vec3(-5, -5, -5);
      owner.maxs = vec3(5, 5, 5);
      ownerClient.ps.fov = 140;
      owner.s.modelindex = 0;
      owner.s.modelindex2 = 0;
      owner.viewheight = 8;
      owner.solid = SolidT.SOLID_NOT;
      owner.flags |= EntFlagsT.FL_SAM_RAIMI;
      gi.linkentity(owner);

      self.solid = SolidT.SOLID_BBOX;
      gi.linkentity(self);
    }
  }
});

/** rogue/g_rogue_sphere.cpp:402-410 `PAIN(defender_pain)`. */
export const defender_pain: PainFn = RegisterPain("defender_pain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  // PMM
  if (other === self.owner) return;

  // pmm
  self.enemy = other;
});

/** rogue/g_rogue_sphere.cpp:414-439 `PAIN(vengeance_pain)`. */
export const vengeance_pain: PainFn = RegisterPain("vengeance_pain", (self: EdictT, other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  if (self.enemy !== null) return;

  if (!SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    if (self.owner !== null && self.owner.health >= 25) return;

    // PMM
    if (other === self.owner) return;
    // pmm
  } else {
    self.wait = Gtime_seconds(Gtime_add(level.time, MINIMUM_FLY_TIME));
  }

  if (Gtime_subtract(Gtime_from_sec(self.wait), level.time) < MINIMUM_FLY_TIME) self.wait = Gtime_seconds(Gtime_add(level.time, MINIMUM_FLY_TIME));
  self.s.effects |= EffectsT.EF_ROCKET;
  self.touch = vengeance_touch;
  self.enemy = other;
});

// ---------------------------------------------------------------------------
// Think Functions (rogue/g_rogue_sphere.cpp:441-574)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:447-484 `THINK(defender_think)`. */
export const defender_think: ThinkFn = RegisterThink("defender_think", (self: EdictT): void => {
  if (self.owner === null) {
    G_FreeEdict(self);
    return;
  }

  // if we've exited the level, just remove ourselves.
  if (Gtime_nonzero(level.intermissiontime)) {
    sphere_think_explode(self);
    return;
  }

  if (self.owner.health <= 0) {
    sphere_think_explode(self);
    return;
  }

  self.s.frame++;
  if (self.s.frame > 19) self.s.frame = 0;

  if (self.enemy !== null) {
    if (self.enemy.health > 0) defender_shoot(self, self.enemy);
    else self.enemy = null;
  }

  sphere_fly(self);

  if (self.inuse) self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** rogue/g_rogue_sphere.cpp:488-548 `THINK(hunter_think)`. */
export const hunter_think: ThinkFn = RegisterThink("hunter_think", (self: EdictT): void => {
  // if we've exited the level, just remove ourselves.
  if (Gtime_nonzero(level.intermissiontime)) {
    sphere_think_explode(self);
    return;
  }

  const owner = self.owner;

  if (owner === null && !SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    G_FreeEdict(self);
    return;
  }

  if (owner !== null) {
    self.ideal_yaw = owner.s.angles[1]; // YAW
  } else if (self.enemy !== null) {
    // fired by doppleganger
    const dir = vec3_sub(self.enemy.s.origin, self.s.origin);
    self.ideal_yaw = vectoyaw(dir);
  }

  M_ChangeYaw(self);

  if (self.enemy !== null) {
    sphere_chase(self, false);

    // deal with sam raimi cam
    if (owner !== null && (owner.flags & EntFlagsT.FL_SAM_RAIMI) !== 0n) {
      if (self.inuse) {
        owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
        LookAtKiller(owner, self, self.enemy);
        // owner is flying with us, move him too
        owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
        owner.viewheight = Math.trunc(self.s.origin[2] - owner.s.origin[2]);
        owner.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
        owner.velocity = vec3(self.velocity[0], self.velocity[1], self.velocity[2]);
        owner.mins = vec3();
        owner.maxs = vec3();
        gi.linkentity(owner);
      } else {
        // sphere timed out
        owner.velocity = vec3();
        owner.movetype = MovetypeT.MOVETYPE_NONE;
        gi.linkentity(owner);
      }
    }
  } else {
    sphere_fly(self);
  }

  if (self.inuse) self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** rogue/g_rogue_sphere.cpp:552-574 `THINK(vengeance_think)`. */
export const vengeance_think: ThinkFn = RegisterThink("vengeance_think", (self: EdictT): void => {
  // if we've exited the level, just remove ourselves.
  if (Gtime_nonzero(level.intermissiontime)) {
    sphere_think_explode(self);
    return;
  }

  if (self.owner === null && !SpawnFlags_has(self.spawnflags, SPHERE_DOPPLEGANGER)) {
    G_FreeEdict(self);
    return;
  }

  if (self.enemy !== null) sphere_chase(self, true);
  else sphere_fly(self);

  if (self.inuse) self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

// ---------------------------------------------------------------------------
// Spawning / Creation (rogue/g_rogue_sphere.cpp:576-711)
// ---------------------------------------------------------------------------

/** rogue/g_rogue_sphere.cpp:583-647 `edict_t *Sphere_Spawn(edict_t *owner,
 *  spawnflags_t spawnflags)`. Returns `null` for an invalid `spawnflags`
 *  combination (matching the C++ source's `default:` case, which frees the
 *  half-built sphere and returns `nullptr`). */
export function Sphere_Spawn(owner: EdictT, spawnflags: SpawnFlags): EdictT | null {
  const sphere = G_Spawn();
  sphere.s.origin = vec3(owner.s.origin[0], owner.s.origin[1], owner.absmax[2]);
  sphere.s.angles = vec3(sphere.s.angles[0], owner.s.angles[1], sphere.s.angles[2]); // YAW
  sphere.solid = SolidT.SOLID_BBOX;
  sphere.clipmask = MASK_PROJECTILE;
  sphere.s.renderfx = RenderfxT.RF_FULLBRIGHT | RenderfxT.RF_IR_VISIBLE;
  sphere.movetype = MovetypeT.MOVETYPE_FLYMISSILE;

  if (SpawnFlags_has(spawnflags, SPHERE_DOPPLEGANGER)) sphere.teammaster = owner.teammaster;
  else sphere.owner = owner;

  sphere.classname = "sphere";
  sphere.yaw_speed = 40;
  sphere.monsterinfo.attack_finished = GTIME_ZERO;
  sphere.spawnflags = spawnflags; // need this for the HUD to recognize sphere
  // PMM
  sphere.takedamage = false;

  const type = SpawnFlags_and(spawnflags, SPHERE_TYPE);

  if (type === SPHERE_DEFENDER) {
    sphere.s.modelindex = gi.modelindex("models/items/defender/tris.md2");
    sphere.s.modelindex2 = gi.modelindex("models/items/shell/tris.md2");
    sphere.s.sound = gi.soundindex("spheres/d_idle.wav");
    sphere.pain = defender_pain;
    sphere.wait = Gtime_seconds(Gtime_add(level.time, DEFENDER_LIFESPAN));
    sphere.die = sphere_explode;
    sphere.think = defender_think;
  } else if (type === SPHERE_HUNTER) {
    sphere.s.modelindex = gi.modelindex("models/items/hunter/tris.md2");
    sphere.s.sound = gi.soundindex("spheres/h_idle.wav");
    sphere.wait = Gtime_seconds(Gtime_add(level.time, HUNTER_LIFESPAN));
    sphere.pain = hunter_pain;
    sphere.die = sphere_if_idle_die;
    sphere.think = hunter_think;
  } else if (type === SPHERE_VENGEANCE) {
    sphere.s.modelindex = gi.modelindex("models/items/vengnce/tris.md2");
    sphere.s.sound = gi.soundindex("spheres/v_idle.wav");
    sphere.wait = Gtime_seconds(Gtime_add(level.time, VENGEANCE_LIFESPAN));
    sphere.pain = vengeance_pain;
    sphere.die = sphere_if_idle_die;
    sphere.think = vengeance_think;
    sphere.avelocity = vec3(30, 30, 0);
  } else {
    gi.Com_Print("Tried to create an invalid sphere\n");
    G_FreeEdict(sphere);
    return null;
  }

  sphere.nextthink = Gtime_add(level.time, Gtime_from_hz(10));

  gi.linkentity(sphere);

  return sphere;
}

/** rogue/g_rogue_sphere.cpp:653-680 `void Own_Sphere(edict_t *self, edict_t
 *  *sphere)` -- attach the sphere to the client so we can directly access
 *  it later. */
export function Own_Sphere(self: EdictT, sphere: EdictT | null): void {
  if (sphere === null) return;

  // ownership only for players
  if (self.client !== null) {
    // if they don't have one
    if (self.client.owned_sphere === null) {
      self.client.owned_sphere = sphere;
    } else {
      // they already have one, take care of the old one
      if (self.client.owned_sphere.inuse) {
        G_FreeEdict(self.client.owned_sphere);
        self.client.owned_sphere = sphere;
      } else {
        self.client.owned_sphere = sphere;
      }
    }
  }
}

/** rogue/g_rogue_sphere.cpp:684-690 `void Defender_Launch(edict_t
 *  *self)`. */
export function Defender_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_DEFENDER);
  Own_Sphere(self, sphere);
}

/** rogue/g_rogue_sphere.cpp:694-700 `void Hunter_Launch(edict_t *self)`. */
export function Hunter_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_HUNTER);
  Own_Sphere(self, sphere);
}

/** rogue/g_rogue_sphere.cpp:704-710 `void Vengeance_Launch(edict_t
 *  *self)`. */
export function Vengeance_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_VENGEANCE);
  Own_Sphere(self, sphere);
}
