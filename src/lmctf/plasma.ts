/*
 * M82 Plasma Rifle Source
 *
 * Copyright (C) 1999  Team HOSTILE
 *
 * Copyright (C) 1999  LMCTF 5.0
 *
 * created by James "SWKiD" Tomaschke
 */

// Ports lmctf60/plasma.c (578 lines) + plasma.h -- LM_CTF's signature
// dual-mode plasma rifle: WEAP_PLASMA's own alternate-fire toggle between a
// single bouncing "reflect" bolt (MOVETYPE_REFLECT, a lmctf60-only movetype
// added in g_local.h/g_phys.c) and a three-way "spread" shot.
//
// STATUS: complete -- every function plasma.c defines is ported:
// plasma_reflect_touch, plasma_spread_touch, Spawn_Goop,
// fire_plasma_reflect, fire_plasma_spread, fire_plasma, Use_PLASMA, and
// Weapon_PLASMA_Generic. `Weapon_Plasma` itself (the concrete entry point
// with FRAME_* literals and the pause_frames/fire_frames arrays,
// `weapon_plasma_fire`, and the "weapon_plasma" itemlist entry) is defined
// in p_weapon.c and g_items.c, NOT plasma.c -- confirmed by grep across the
// whole lmctf60 tree (p_weapon.c:2216 `void Weapon_Plasma`,
// g_items.c:1762 `"weapon_plasma"` itemlist entry) -- those are unit A's
// (p_weapon.ts/g_items.ts foundation-partial completion), not ported here.
//
// Several functions call into g_combat.c/p_weapon.c symbols this unit does
// not own (T_RadiusDamage, PlayerNoise, ChangeWeapon, NoAmmoWeaponChange --
// none exist in src/lmctf yet, confirmed immediately before writing this
// file). Per .orch/preferences.md rule 12, those stay local throwing stubs
// cited to their C source below, same treatment as g_runes.ts.
// T_Damage/G_Spawn/G_FreeEdict/vectoangles/AngleVectors/FindItem/
// ITEM_INDEX have already landed in the foundation and are imported for
// real.

import { AngleVectors, vec3, VectorClear, VectorCopy, VectorMA, VectorScale, VectorSet, type Vec3 } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  ATTN_STATIC,
  BUTTON_ATTACK,
  CHAN_BODY,
  CHAN_ITEM,
  CHAN_VOICE,
  CHAN_WEAPON,
  type CplaneT,
  type CsurfaceT,
  EF_ANIM_ALLFAST,
  EF_IONRIPPER,
  MASK_SHOT,
  MulticastT,
  PMF_DUCKED,
  PRINT_HIGH,
  Q_stricmp,
  RF_TRANSLUCENT,
  SURF_SKY,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { SolidT, SVF_DEADMONSTER } from "./game";
import {
  ANIM_ATTACK,
  ANIM_REVERSE,
  DAMAGE_ENERGY,
  type EdictT,
  type GItemT,
  IT_AMMO,
  MovetypeT,
  PNOISE_IMPACT,
  WeaponstateT,
  gameCvars,
  gi,
  level,
  svc_temp_entity,
} from "./g_local";
import { FindItem, ITEM_INDEX } from "./g_items";
import { G_FreeEdict, G_Spawn, vectoangles } from "./g_utils";
import { T_Damage } from "./g_combat";

//==============================================================================
// Plasma Rifle Configuration File
//==============================================================================

// plasma.h:5-6
//Bat
//release 5.0 was at 2.8

// plasma.h:8-9 -- superseded below (dead, commented out in the C source
// itself; not reproduced, same "#if 0 blocks dropped silently" rule as
// bat.ts/g_runes.ts).
//#define PLASMA_DAMAGE_MULTIPLIER	2.8
//#define PLASMA_SPLASH_RADIUS		70

export const PLASMA_SPREAD_DAMAGE = 28;
export const PLASMA_BOUNCE_DAMAGE = 39;
export const PLASMA_SPLASH_RADIUS = 70;

// Plasma Spread Range (max angle off line of sight) -- 10 degrees (radians).
// Declared in plasma.h; never referenced anywhere in the lmctf60 tree
// (checked by grep), ported for header fidelity only.
export const PLASMA_SPREAD_RANGE = 0.1745;

// Plasma Projectile Speeds -- plasma.h:21-22's 650 values are dead
// (commented out in the C source, replaced by the 1200 values below,
// "-bat"); not reproduced.
//#define	PLASMA_REFLECT_SPEED	650
//#define	PLASMA_SPREAD_SPEED	650
export const PLASMA_REFLECT_SPEED = 1200;
export const PLASMA_SPREAD_SPEED = 1200;

export const PLASMA_CELLS_PER_SHOT = 10;

// Model/Sprite Information
export const PLASMA_SPRITE_FLY = "sprites/s_plasma1.sp2";
export const PLASMA_SPRITE_HIT = "sprites/s_plasma2.sp2";
export const PLASMA_MODEL_VIEW = "models/weapons/v_plasma/tris.md2";
export const PLASMA_MODEL_WORLD = "models/weapons/g_plasma/tris.md2";

// Sound
export const PLASMA_SOUND_BOUNCE = "weapons/plasma/bounce.wav";
export const PLASMA_SOUND_EMPTY = "weapons/plasma/empty.wav";
export const PLASMA_SOUND_FIRE1 = "weapons/plasma/fire1.wav";
export const PLASMA_SOUND_FIRE2 = "weapons/plasma/fire2.wav";
export const PLASMA_SOUND_FLYBY = "weapons/plasma/flyby.wav";
export const PLASMA_SOUND_HIT = "weapons/plasma/hit.wav";
export const PLASMA_SOUND_IDLE = "weapons/plasma/idle.wav";
export const PLASMA_SOUND_PICKUP = "misc/w_pkup.wav";
export const PLASMA_SOUND_VENT = "weapons/plasma/vent.wav";

// Misc
export const PLASMA_ICON = "w_plasma";
export const PLASMA_PICKUP = "Plasma Rifle";
export const MOD_PLASMA = 34;
// #define MOD_PLASMA2 35 -- commented out in the C source, never defined.

// Precache -- plasma.h's PLASMA_PRECACHE macro is a compile-time string
// concatenation (adjacent C string literals); ported as an array of the
// same strings in the same order for whatever precache pass consumes it
// (g_items.c's itemlist precache field for "weapon_plasma" -- unit A's
// g_items.ts, not this file).
export const PLASMA_PRECACHE = [
  PLASMA_SOUND_BOUNCE,
  PLASMA_SOUND_EMPTY,
  PLASMA_SOUND_FIRE1,
  PLASMA_SOUND_FIRE2,
  PLASMA_SOUND_FLYBY,
  PLASMA_SOUND_HIT,
  PLASMA_SOUND_IDLE,
  PLASMA_SOUND_PICKUP,
  PLASMA_SOUND_VENT,
  PLASMA_MODEL_VIEW,
  PLASMA_MODEL_WORLD,
  PLASMA_SPRITE_FLY,
  PLASMA_SPRITE_HIT,
].join(" ");

// plasma.c:24: `//bat #define PLASMA_INDEX 18` -- declared, never
// referenced anywhere in plasma.c or the rest of the lmctf60 tree (checked
// by grep, same as bat.ts's MAX_RAILTIME/Observer_Show_Menu). Ported for
// header fidelity only.
export const PLASMA_INDEX = 18;

// plasma.c:17-19 -- FRAME_FIRE_FIRST/FRAME_IDLE_FIRST/FRAME_DEACTIVATE_FIRST
// are computed from the FRAME_ACTIVATE_LAST/FRAME_FIRE_LAST/FRAME_IDLE_LAST
// parameters Weapon_PLASMA_Generic receives (below), not fixed constants.

// m_player.h player-model animation frame numbers Weapon_PLASMA_Generic
// switches on directly (not passed as parameters). A full m_player_frames.ts
// port for lmctf60 does not exist yet and is out of this unit's SCOPE (not
// one of this brief's listed files); these eight literals are the only
// m_player.h frame constants plasma.c touches, inlined here with their C
// line citations rather than pulled in via a new file this unit was not
// asked to create.
const FRAME_attack1 = 46; // lmctf60/m_player.h:51
const FRAME_attack8 = 53; // lmctf60/m_player.h:58
const FRAME_pain301 = 62; // lmctf60/m_player.h:67
const FRAME_pain304 = 65; // lmctf60/m_player.h:70
const FRAME_crattak1 = 160; // lmctf60/m_player.h:165
const FRAME_crattak9 = 168; // lmctf60/m_player.h:173
const FRAME_crpain1 = 169; // lmctf60/m_player.h:174
const FRAME_crpain4 = 172; // lmctf60/m_player.h:177

// ---------------------------------------------------------------------
// Cross-dependencies into files this unit does not own. Unit A owns
// g_combat.ts (T_RadiusDamage addition) and p_weapon.ts's foundation-
// partial completion (PlayerNoise/ChangeWeapon/NoAmmoWeaponChange -- the
// current p_weapon.ts partial's own header already flags
// ChangeWeapon/NoAmmoWeaponChange as missing dependencies it needs too).
// Each stub throws if actually invoked and cites its C source plus the
// ctf-ancestor TS file with the real implementation's signature.
// ---------------------------------------------------------------------

function T_RadiusDamage(
  _inflictor: EdictT,
  _attacker: EdictT,
  _damage: number,
  _ignore: EdictT | null,
  _radius: number,
  _mod: number,
): void {
  throw new Error("T_RadiusDamage not yet ported (lmctf60/g_combat.c; owned by unit A's g_combat.ts completion)");
}

function PlayerNoise(_who: EdictT, _where: Vec3, _type: number): void {
  throw new Error("PlayerNoise not yet ported (lmctf60/p_weapon.c:51; owned by unit A's p_weapon.ts completion)");
}

function ChangeWeapon(_ent: EdictT): void {
  throw new Error("ChangeWeapon not yet ported (lmctf60/p_weapon.c; owned by unit A's p_weapon.ts completion)");
}

function NoAmmoWeaponChange(_ent: EdictT): void {
  throw new Error("NoAmmoWeaponChange not yet ported (lmctf60/p_weapon.c; owned by unit A's p_weapon.ts completion)");
}

// ---------------------------------------------------------------------

// plasma.c:26: `int quadmeister = 0;` -- file-scope global, read by
// plasma_reflect_touch/plasma_spread_touch and written by
// Weapon_PLASMA_Generic every frame the weapon thinks. Module-level `let`
// mirrors the C global exactly (same cross-function mutable-state shape as
// g_runes.ts's `runeThinkForward`).
let quadmeister = false;

/*
=================
plasma_reflect_touch (lmctf60/plasma.c:31)

If it hit the sky, vanish. Otherwise: if it hit something damageable, deal
direct damage and switch to the "hit" sprite/animation to die out over
0.1s; if it hit world geometry instead, play a bounce sound + blue spark
temp-entity effect and deal radius damage (the projectile itself is NOT
destroyed on a bounce -- MOVETYPE_REFLECT keeps it moving, matching
fire_plasma_reflect's comment that this movetype "does not stop projectile
when it hits a ground plane").
=================
*/
export function plasma_reflect_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  let damage: number;

  // If hit the sky, remove from world
  if (surf !== null && (surf.flags & SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // Damage Decay
  // determine damage (max 3.0s * 7 = max 21 damage)
  // if time is adjusted, must also adjust the constant

  //bat.  This think stuff is messing me up, so I am taking it out.
  //self->dmg= 7 + (self->nextthink - level.time) * 7 * PLASMA_DAMAGE_MULTIPLIER;

  //bat
  if (quadmeister) {
    damage = PLASMA_BOUNCE_DAMAGE * 4;
  } else {
    damage = PLASMA_BOUNCE_DAMAGE;
  }

  if (self.owner !== null && self.owner.client !== null) {
    PlayerNoise(self.owner, self.s.origin, PNOISE_IMPACT);
  }

  if (other.takedamage) {
    if (self.owner === null || plane === null) {
      throw new Error("plasma_reflect_touch: self.owner/plane null on a damageable hit (lmctf60/plasma.c:61 dereferences both unconditionally)");
    }
    T_Damage(other, self, self.owner, self.velocity, self.s.origin, plane.normal, damage, 1, DAMAGE_ENERGY, MOD_PLASMA);

    ///T_Damage (other, self, self->owner, self->velocity,
    //         self->s.origin, plane->normal, self->dmg, 1,
    //	  DAMAGE_ENERGY, MOD_PLASMA);

    // play hit sound
    gi.sound(self, CHAN_BODY, gi.soundindex(PLASMA_SOUND_HIT), 1, ATTN_IDLE, 0);

    self.solid = SolidT.SOLID_NOT;
    self.touch = null;
    VectorMA(self.s.origin, -1 * FRAMETIME_PLASMA, self.velocity, self.s.origin);
    VectorClear(self.velocity);

    // Run Plasma Hit Animation
    self.s.modelindex = gi.modelindex(PLASMA_SPRITE_HIT);
    self.s.frame = 0;
    self.s.sound = 0;
    self.think = G_FreeEdict;
    self.nextthink = level.time + 0.1;
  } else {
    // fx to do when it bounces off something
    // play reflection sound
    gi.sound(self, CHAN_BODY, gi.soundindex(PLASMA_SOUND_BOUNCE), 1, ATTN_STATIC, 0);

    if (plane === null) {
      throw new Error("plasma_reflect_touch: plane null on a bounce (lmctf60/plasma.c:93 dereferences plane->normal unconditionally)");
    }

    // Draw blue sparks
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_LASER_SPARKS);
    gi.WriteByte(32); // ammount
    gi.WritePosition(self.s.origin);
    gi.WriteDir(plane.normal);
    gi.WriteByte(176); // stecki's choice of id's blue
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

    //T_RadiusDamage(self,self->owner,32,NULL,32,MOD_PLASMA);
    //-bat
    if (self.owner === null) {
      throw new Error("plasma_reflect_touch: self.owner null on a bounce (lmctf60/plasma.c:99 dereferences self->owner unconditionally)");
    }
    T_RadiusDamage(self, self.owner, damage, null, damage + PLASMA_SPLASH_RADIUS, MOD_PLASMA);
  }
}

/*
=================
plasma_spread_touch (lmctf60/plasma.c:107)

Same shape as plasma_reflect_touch but for a "goop" spread bolt: ignores
other "goop" entities entirely (no self-collision between the three spread
bolts), and always plays the blue-spark effect on a non-damage hit (the
reflect variant only does that on an actual bounce -- the spread variant's
C source has the spark block unconditionally in its else-branch too, so
this matches).
=================
*/
export function plasma_spread_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  let damage: number;

  // If hit the sky, remove from world
  if (surf !== null && (surf.flags & SURF_SKY) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // Don't collide with other plasma goops
  if (Q_stricmp(other.classname ?? "", "goop") === 0) return;

  //bat
  if (quadmeister) {
    damage = PLASMA_SPREAD_DAMAGE * 4;
  } else {
    damage = PLASMA_SPREAD_DAMAGE;
  }

  if (self.owner !== null && self.owner.client !== null) {
    PlayerNoise(self.owner, self.s.origin, PNOISE_IMPACT);
  }

  // If can damage, hurt it
  if (other.takedamage) {
    //T_Damage (other, self, self->owner, self->velocity,
    //          self->s.origin, plane->normal, self->dmg, 1,
    //	  DAMAGE_ENERGY, MOD_PLASMA);
    if (self.owner === null || plane === null) {
      throw new Error("plasma_spread_touch: self.owner/plane null on a damageable hit (lmctf60/plasma.c:138 dereferences both unconditionally)");
    }
    T_Damage(other, self, self.owner, self.velocity, self.s.origin, plane.normal, damage, 1, DAMAGE_ENERGY, MOD_PLASMA);
  } else {
    // otherwise, splash damage
    //-bat
    //T_RadiusDamage(self,self->owner,self->dmg,NULL, self->dmg+PLASMA_SPLASH_RADIUS,MOD_PLASMA);
    //T_RadiusDamage(self,self->owner,32,NULL,32,MOD_PLASMA);

    //-bat added sparks to this too.
    // Draw blue sparks
    if (plane === null) {
      throw new Error("plasma_spread_touch: plane null on a splash hit (lmctf60/plasma.c:152 dereferences plane->normal unconditionally)");
    }
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_LASER_SPARKS);
    gi.WriteByte(32); // ammount
    gi.WritePosition(self.s.origin);
    gi.WriteDir(plane.normal);
    gi.WriteByte(176); // stecki's choice of id's blue
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

    if (self.owner === null) {
      throw new Error("plasma_spread_touch: self.owner null on a splash hit (lmctf60/plasma.c:158 dereferences self->owner unconditionally)");
    }
    T_RadiusDamage(self, self.owner, damage, null, damage + PLASMA_SPLASH_RADIUS, MOD_PLASMA);
  }
  // play hit sound
  gi.sound(self, CHAN_BODY, gi.soundindex(PLASMA_SOUND_HIT), 1, ATTN_IDLE, 0); // idle static none

  self.solid = SolidT.SOLID_NOT;
  self.touch = null;
  VectorMA(self.s.origin, -1 * FRAMETIME_PLASMA, self.velocity, self.s.origin);
  VectorClear(self.velocity);

  // Run Plasma Hit Animation
  self.s.modelindex = gi.modelindex(PLASMA_SPRITE_HIT);
  self.s.frame = 0;
  self.s.sound = 0;
  self.think = G_FreeEdict;
  self.nextthink = level.time + 0.1;
}

// lmctf60/g_local.h: `FRAMETIME` is 0.1 -- already defined there, but
// plasma.c includes g_local.h directly, so this is the same value under a
// locally-scoped name to avoid importing g_local.ts's FRAMETIME purely for
// two call sites; kept equal by citation rather than by re-export.
const FRAMETIME_PLASMA = 0.1; // lmctf60/g_local.h: `#define FRAMETIME 0.1`

/*
=================
Spawn_Goop (lmctf60/plasma.c:181)

Spawns the shared plasma projectile entity both fire modes build on top of.
=================
*/
export function Spawn_Goop(ent: EdictT, start: Vec3): EdictT {
  const goop = G_Spawn();

  goop.owner = ent;
  goop.clipmask = MASK_SHOT;
  goop.solid = SolidT.SOLID_BBOX;
  goop.svflags = SVF_DEADMONSTER;

  VectorCopy(start, goop.s.origin);
  goop.classname = "goop";

  //goop->s.effects|=	EF_BLUEHYPERBLASTER | EF_ANIM_ALLFAST;
  //bat to get rid of the blue flag effect
  goop.s.effects |= EF_IONRIPPER | EF_ANIM_ALLFAST;
  goop.s.renderfx = RF_TRANSLUCENT;
  goop.s.modelindex = gi.modelindex(PLASMA_SPRITE_FLY);
  goop.s.sound = gi.soundindex(PLASMA_SOUND_FLYBY);

  return goop;
}

/*
=================
fire_plasma_reflect (lmctf60/plasma.c:210)

Unique code to fire a bouncy plasma goop. Uses MOVETYPE_REFLECT (MOVETYPE_BOUNCE
without gravity and friction, and does not stop the projectile when it hits
a ground plane -- defined in g_phys.c, outside this unit's scope).
=================
*/
export function fire_plasma_reflect(self: EdictT, _start: Vec3, dir: Vec3): void {
  self.movetype = MovetypeT.MOVETYPE_REFLECT; // new movetype (MOVETYPE_BOUNCE
  // without gravity and friction,
  // and does not stop projectile
  // when it hits a ground plane)

  VectorScale(dir, PLASMA_REFLECT_SPEED, self.velocity);
  VectorCopy(self.velocity, self.s.angles); // needed for post touch

  //Not sure what this even does????
  //if (deathmatch->value)
  //	self->dmg = 15 * PLASMA_BOUNCE_DAMAGE;
  //else
  //	self->dmg = 20 * PLASMA_BOUNCE_DAMAGE;

  //-bat
  self.dmg = PLASMA_BOUNCE_DAMAGE;

  self.touch = plasma_reflect_touch;

  self.think = G_FreeEdict; // change this to handle
  //self->nextthink = level.time + 3.0;		//  sprite animation?
  self.nextthink = level.time + 1.5;

  gi.linkentity(self);
}

/*
=================
fire_plasma_spread (lmctf60/plasma.c:244)

Unique code to fire a spread of three bolts, each with 1/3 the damage of
one initial bouncy bolt (per the doc comment -- the C source's own
`dmg = 1` per-bolt assignment below does not actually implement "1/3",
that math lives entirely in plasma_spread_touch's PLASMA_SPREAD_DAMAGE
constant instead; the doc comment and the dead commented-out
`7 + 9 * PLASMA_SPREAD_DAMAGE` block are stale, preserved as comments
only).
=================
*/
export function fire_plasma_spread(goop_c: EdictT, _start: Vec3, dirIn: Vec3): void {
  const goop_l = Spawn_Goop(goop_c.owner as EdictT, goop_c.s.origin);
  const goop_r = Spawn_Goop(goop_c.owner as EdictT, goop_c.s.origin);
  const angles: Vec3 = vec3();
  const dir: Vec3 = vec3(dirIn[0], dirIn[1], dirIn[2]);

  goop_l.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  goop_c.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  goop_r.movetype = MovetypeT.MOVETYPE_FLYMISSILE;

  VectorClear(goop_l.mins);
  VectorClear(goop_l.maxs);
  VectorClear(goop_c.mins);
  VectorClear(goop_c.maxs);
  VectorClear(goop_r.mins);
  VectorClear(goop_r.maxs);

  goop_l.dmg = 1;
  goop_c.dmg = 1;
  goop_r.dmg = 1;

  //bat  this really shouldn't even matter???
  //if(is_quad)
  //{
  //	goop_l->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE * 4;
  //	goop_c->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE * 4;
  //	goop_r->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE * 4;
  //}
  //else
  //{
  //	goop_l->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE;
  //	goop_c->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE;
  //	goop_r->dmg=	7 + 9 * PLASMA_SPREAD_DAMAGE;
  //}

  // center spread, line of sight
  VectorScale(dir, PLASMA_SPREAD_SPEED, goop_c.velocity);
  vectoangles(dir, angles);

  // right spread, has 10+ in yaw
  angles[YAW] -= 10;
  AngleVectors(angles, dir, null, null);
  VectorScale(dir, PLASMA_SPREAD_SPEED, goop_r.velocity);

  // left spread, has 10- in yaw
  angles[YAW] += 20;
  AngleVectors(angles, dir, null, null);
  VectorScale(dir, PLASMA_SPREAD_SPEED, goop_l.velocity);

  goop_l.touch = plasma_spread_touch;
  goop_c.touch = plasma_spread_touch;
  goop_r.touch = plasma_spread_touch;

  goop_l.think = G_FreeEdict;
  goop_c.think = G_FreeEdict;
  goop_r.think = G_FreeEdict;
  goop_l.nextthink = level.time + 3.0;
  goop_c.nextthink = level.time + 3.0;
  goop_r.nextthink = level.time + 3.0;

  gi.linkentity(goop_l);
  gi.linkentity(goop_c);
  gi.linkentity(goop_r);
}

/*
=================
fire_plasma (lmctf60/plasma.c:318)

If "reflect" is truthy, fires a bouncy shot; otherwise fires a spread.
"start" and "dir" are set up by the caller (p_weapon.c's
weapon_plasma_fire, unit A's pending p_weapon.ts work), not here.

Both branches deduct the exact same ammo amount (PLASMA_CELLS_PER_SHOT - 1
= 9); preserved as written even though the branching on `reflect` makes it
look like it should differ -- it does not, in the C source either.
=================
*/
export function fire_plasma(ent: EdictT, start: Vec3, dir: Vec3, reflect: number): void {
  const goop = Spawn_Goop(ent, start);

  // give it some thickness for the bounce
  VectorSet(goop.mins, -12, -12, -12);
  VectorSet(goop.maxs, 12, 12, 12);

  if (ent.client === null) {
    throw new Error("fire_plasma: ent.client is null (lmctf60/plasma.c:330 dereferences ent->client unconditionally)");
  }

  if (reflect) {
    fire_plasma_reflect(goop, start, dir);
    //bat
    ent.client.pers.inventory[ent.client.ammo_index] -= PLASMA_CELLS_PER_SHOT - 1;
  } else {
    fire_plasma_spread(goop, start, dir);
    //bat
    ent.client.pers.inventory[ent.client.ammo_index] -= PLASMA_CELLS_PER_SHOT - 1;
  }
}

/*
=================
Use_PLASMA (lmctf60/plasma.c:349)

A copy of Use_Weapon (g_items.c, not this file) that additionally toggles
the plasma rifle's fire mode when it is already the active weapon, instead
of doing nothing. Meant to replace Use_Weapon as the plasma rifle
itemlist entry's `use` callback (g_items.c's "weapon_plasma" entry --
unit A's pending work, not ported here).
=================
*/
export function Use_PLASMA(ent: EdictT, item: GItemT): void {
  ///////// FIXME /////////
  if (ent.client === null) {
    throw new Error("Use_PLASMA: ent.client is null (lmctf60/plasma.c:356 dereferences ent->client unconditionally)");
  }
  // if we're already using it, switch modes
  if (item === ent.client.pers.weapon) {
    // see if you have the other weapon
    // if yes, switch
    // else return
    // simple hack for demo
    ent.client.plasma_mode = ent.client.plasma_mode ? 0 : 1;

    if (ent.client.plasma_mode) {
      gi.cprintf(ent, PRINT_HIGH, "bounce plasma\n");
    } else {
      gi.cprintf(ent, PRINT_HIGH, "spread plasma\n");
    }

    return;
  }
  /////////////////////////

  if (item.ammo !== null && !(gameCvars.g_select_empty !== null && gameCvars.g_select_empty.value) && (item.flags & IT_AMMO) === 0) {
    const ammo_item = FindItem(item.ammo);
    if (ammo_item === null) {
      throw new Error("Use_PLASMA: FindItem(item.ammo) returned null (lmctf60/plasma.c:374-375 dereferences ammo_item unconditionally next)");
    }
    const ammo_index = ITEM_INDEX(ammo_item);

    if (!ent.client.pers.inventory[ammo_index]) {
      gi.cprintf(ent, PRINT_HIGH, `No ${ammo_item.pickup_name ?? ""} for ${item.pickup_name ?? ""}.\n`);
      return;
    }

    if (ent.client.pers.inventory[ammo_index] < item.quantity) {
      gi.cprintf(ent, PRINT_HIGH, `Not enough ${ammo_item.pickup_name ?? ""} for ${item.pickup_name ?? ""}.\n`);
      return;
    }
  }

  // change to this weapon when down
  ent.client.newweapon = item;
}

/*
=================
Weapon_PLASMA_Generic (lmctf60/plasma.c:399)

The plasma rifle's per-frame weapon-state machine, structurally the same
shape as baseq2's Weapon_Generic but with the "-bat" quad-detection
(`quadmeister`)/isfiring bookkeeping and the plasma-mode chat print on
activation folded in.
=================
*/
export function Weapon_PLASMA_Generic(
  ent: EdictT,
  FRAME_ACTIVATE_LAST: number,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_DEACTIVATE_LAST: number,
  pause_frames: number[] | null,
  fire_frames: number[],
  fire: (ent: EdictT) => void,
): void {
  const FRAME_FIRE_FIRST = FRAME_ACTIVATE_LAST + 1;
  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;
  const FRAME_DEACTIVATE_FIRST = FRAME_IDLE_LAST + 1;

  if (ent.client === null) {
    throw new Error("Weapon_PLASMA_Generic: ent.client is null (lmctf60/plasma.c:403 dereferences ent->client unconditionally)");
  }
  const client = ent.client;

  if (client.quad_framenum > level.framenum) {
    quadmeister = true;
  } else {
    quadmeister = false;
  }

  // VWep animations screw up corpses
  if (ent.deadflag || ent.s.modelindex !== 255) return;

  //bat
  client.isfiring = 0;

  if (client.weaponstate === WeaponstateT.WEAPON_DROPPING) {
    if (client.ps.gunframe === FRAME_DEACTIVATE_LAST) {
      ChangeWeapon(ent);
      return;
    } else if (FRAME_DEACTIVATE_LAST - client.ps.gunframe === 4) {
      client.anim_priority = ANIM_REVERSE;
      if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }

    client.ps.gunframe++;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    if (client.ps.gunframe === FRAME_ACTIVATE_LAST) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = FRAME_IDLE_FIRST;

      //-bat
      if (client.plasma_mode) {
        gi.cprintf(ent, PRINT_HIGH, "bounce plasma\n");
      } else {
        gi.cprintf(ent, PRINT_HIGH, "spread plasma\n");
      }

      return;
    }

    client.ps.gunframe++;
    return;
  }

  if (client.newweapon !== null && client.weaponstate !== WeaponstateT.WEAPON_FIRING) {
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = FRAME_DEACTIVATE_FIRST;

    if (FRAME_DEACTIVATE_LAST - FRAME_DEACTIVATE_FIRST < 4) {
      client.anim_priority = ANIM_REVERSE;
      if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if (((client.latched_buttons | client.buttons) & BUTTON_ATTACK) !== 0) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      if (
        !client.ammo_index ||
        (client.pers.weapon !== null && client.pers.inventory[client.ammo_index] >= client.pers.weapon.quantity)
      ) {
        client.ps.gunframe = FRAME_FIRE_FIRST;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;

        // start the animation
        client.anim_priority = ANIM_ATTACK;
        if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
          ent.s.frame = FRAME_crattak1 - 1;
          client.anim_end = FRAME_crattak9;
        } else {
          ent.s.frame = FRAME_attack1 - 1;
          client.anim_end = FRAME_attack8;
        }
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
    } else {
      if (client.ps.gunframe === FRAME_IDLE_LAST) {
        client.ps.gunframe = FRAME_IDLE_FIRST;
        return;
      }

      if (pause_frames !== null) {
        for (let n = 0; pause_frames[n]; n++) {
          if (client.ps.gunframe === pause_frames[n]) {
            // `rand()&15` -- no integer rand() helper exists in math.ts
            // (only random()/crandom()); approximated with an equivalent
            // uniform pick, matching src/ctf/p_weapon.ts's Weapon_Generic:
            // ~15/16 chance to pause, ~1/16 chance to fall through.
            if (Math.floor(Math.random() * 16) !== 0) return;
          }
        }
      }

      if (client.ps.gunframe === 35) {
        gi.sound(ent, CHAN_WEAPON, gi.soundindex(PLASMA_SOUND_VENT), 1, ATTN_NORM, 0);
      }

      client.ps.gunframe++;
      return;
    }
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    let n = 0;
    for (n = 0; fire_frames[n]; n++) {
      if (client.ps.gunframe === fire_frames[n]) {
        //bat
        if (client.quad_framenum > level.framenum) {
          gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
        }

        //bat
        client.isfiring = 1;
        fire(ent);
        break;
      }
    }

    if (!fire_frames[n]) {
      client.ps.gunframe++;
    }

    if (client.ps.gunframe === FRAME_IDLE_FIRST + 1) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
    }
  }
}

// EOF
