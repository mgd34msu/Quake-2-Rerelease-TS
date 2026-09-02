// g_newweap.c
//
// Rogue's new weapon projectiles: ETF rifle flechettes, proximity mines,
// the nuke, tesla mines, the heatbeam, the green "blaster2" bolt (used by
// the defender sphere and various monsters), the tracker (disruptor) bolt,
// and player melee (chainfist).
//
// Dropped per PORTING.md's "#ifdef ... take the portable path; list dropped
// branches": `INCLUDE_FLAMETHROWER` and `INCLUDE_INCENDIARY` are
// `//`-commented-out at the top of the C file, so the flamethrower
// (fire_remove/fire_flame/fire_maintain/flameshooter_*/fire_burst_*/
// FireThink/StartFire) and the incendiary grenade (fire_incendiary_grenade)
// are dead code in this build variant and are not ported. The commented-out
// `tracker_boom_think`/`tracker_boom_spawn` block (wrapped in a C block
// comment in the source) is dead code for the same reason and is likewise
// not ported.

import {
  AngleVectors,
  crandom,
  DotProduct,
  random,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCompare,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  VectorLength,
  RotatePointAroundVector,
  type Vec3,
} from "../shared/math";
import {
  AREA_SOLID,
  ATTN_IDLE,
  ATTN_NONE,
  MAX_EDICTS,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_ITEM,
  CHAN_NO_PHS_ADD,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_WATER,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EF_ANIM_ALLFAST,
  EF_GIB,
  EF_GRENADE,
  EF_PLASMA,
  EF_TRAP,
  EF_TRACKER,
  EF_TRACKERTRAIL,
  MASK_SHOT,
  MASK_WATER,
  MulticastT,
  MZ_NUKE1,
  MZ_NUKE2,
  MZ_NUKE4,
  MZ_NUKE8,
  PITCH,
  RF_FULLBRIGHT,
  RF_IR_VISIBLE,
  SURF_SKY,
  TempEventT,
} from "../shared/q_shared";
import { type Edict, SolidT, SVF_DAMAGEABLE, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  DAMAGE_DESTROY_ARMOR,
  DAMAGE_ENERGY,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_NO_POWER_ARMOR,
  DAMAGE_NO_REG_ARMOR,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  FL_MECHANICAL,
  FL_SWIM,
  FRAMETIME,
  gameCvars,
  gi,
  globals,
  g_edicts,
  level,
  MOD_BLASTER2,
  MOD_CHAINFIST,
  MOD_DEFENDER_SPHERE,
  MOD_ETF_RIFLE,
  MOD_HEATBEAM,
  MOD_NUKE,
  MOD_PHALANX,
  MOD_PROX,
  MOD_RIPPER,
  MOD_TESLA,
  MOD_TRACKER,
  MOD_TRAP,
  MovetypeT,
  PNOISE_IMPACT,
  PNOISE_WEAPON,
  svc_muzzleflash,
  svc_temp_entity,
  world,
} from "./g_local";
import { findradius, G_FreeEdict, G_Spawn, vectoangles, vectoangles2, vectoyaw } from "./g_utils";
import { T_Damage, T_RadiusDamage, T_RadiusNukeDamage } from "./g_combat";
import { Grenade_Explode } from "./g_weapon";
import { P_DamageModifier, PlayerNoise } from "./p_weapon";
import { infront, visible as visibleLocal } from "./g_ai";
import { BecomeExplosion1 } from "./g_misc";
import { M_ChangeYaw } from "./m_move";
import { SP_item_foodcube } from "./g_items";

function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0]!;
  return g_edicts[ent.s.number]!;
}

// RERELEASE CONTENT PORT -- g_weapon.c's `check_dodge` is `static` there, so
// this file carries its own copy.
//
// DEVIATION FROM src/rogue/g_newweap.ts: rogue widens monsterinfo.dodge to
// four arguments (it passes the trace through so rogue's M_MonsterDodge can
// decide duck vs sidestep). This module keeps vanilla 3.21's three-argument
// dodge -- CTF ships no monsters and no rogue monster AI, so there is
// nothing here that could read the fourth argument, and widening the field
// would ripple through every m_*.ts dodge handler for no gain. The trace is
// still computed; it is simply not passed on.
function check_dodge(self: EdictT, start: Vec3, dir: Vec3, speed: number): void {
  // easy mode only ducks one quarter the time
  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;
  if (skill === 0) {
    if (random() > 0.25) return;
  }

  const end = vec3();
  VectorMA(start, 8192, dir, end);
  const tr = gi.trace(start, null, null, end, self, MASK_SHOT);
  if (tr.ent !== null) {
    const hit = traceEdict(tr.ent);
    if ((hit.svflags & SVF_MONSTER) !== 0 && hit.health > 0 && hit.monsterinfo.dodge !== null && infront(hit, self)) {
      const v = vec3();
      VectorSubtract(tr.endpos, start, v);
      const eta = (VectorLength(v) - hit.maxs[0]) / speed;
      hit.monsterinfo.dodge(hit, self, eta);
    }
  }
}


function requireField(what: string, cond: boolean): void {
  if (!cond) throw new Error(`${what} (C dereferences it unconditionally here)`);
}

// **************************
// ETF RIFLE
// **************************

/*
========================
fire_flechette
========================
*/
export function flechette_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  // C checks self->client here (always null for a projectile) -- preserved
  // bug-for-bug rather than the presumably-intended self->owner->client.
  if (self.client !== null) {
    requireField("flechette_touch: self.owner", self.owner !== null);
    PlayerNoise(self.owner!, self.s.origin, PNOISE_IMPACT);
  }

  if (other.takedamage) {
    requireField("flechette_touch: self.owner", self.owner !== null);
    requireField("flechette_touch: plane", plane !== null);
    T_Damage(
      other,
      self,
      self.owner!,
      self.velocity,
      self.s.origin,
      plane!.normal,
      self.dmg,
      self.dmg_radius,
      DAMAGE_NO_REG_ARMOR,
      MOD_ETF_RIFLE,
    );
  } else {
    const dir = vec3();
    if (plane === null) VectorClear(dir);
    else VectorScale(plane.normal, 256, dir);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_FLECHETTE);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(dir);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  }

  G_FreeEdict(self);
}

export function fire_flechette(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, kick: number): void {
  VectorNormalize(dir);

  const flechette = G_Spawn();
  VectorCopy(start, flechette.s.origin);
  VectorCopy(start, flechette.s.old_origin);
  vectoangles2(dir, flechette.s.angles);

  VectorScale(dir, speed, flechette.velocity);
  flechette.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  flechette.clipmask = MASK_SHOT;
  flechette.solid = SolidT.SOLID_BBOX;
  flechette.s.renderfx = RF_FULLBRIGHT;
  VectorClear(flechette.mins);
  VectorClear(flechette.maxs);

  flechette.s.modelindex = gi.modelindex("models/proj/flechette/tris.md2");

  flechette.owner = self;
  flechette.touch = flechette_touch;
  flechette.nextthink = level.time + 8000 / speed;
  flechette.think = G_FreeEdict;
  flechette.dmg = damage;
  flechette.dmg_radius = kick;

  gi.linkentity(flechette);

  if (self.client !== null) check_dodge(self, flechette.s.origin, dir, speed);
}

// **************************
// PROX
// **************************

export const PROX_TIME_TO_LIVE = 45; // 45, 30, 15, 10
export const PROX_TIME_DELAY = 0.5;
export const PROX_BOUND_SIZE = 96;
export const PROX_DAMAGE_RADIUS = 192;
export const PROX_HEALTH = 20;
export const PROX_DAMAGE = 90;

export function Prox_Explode(ent: EdictT): void {
  // free the trigger field
  // PMM - changed teammaster to "mover" .. owner of the field is the prox
  if (ent.teamchain !== null && ent.teamchain.owner === ent) G_FreeEdict(ent.teamchain);

  let owner = ent;
  if (ent.teammaster !== null) {
    owner = ent.teammaster;
    PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);
  }

  // play quad sound if appopriate
  if (ent.dmg > PROX_DAMAGE) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

  ent.takedamage = DamageT.DAMAGE_NO;
  T_RadiusDamage(ent, owner, ent.dmg, ent, PROX_DAMAGE_RADIUS, MOD_PROX);

  const origin = vec3();
  VectorMA(ent.s.origin, -0.02, ent.velocity, origin);
  gi.WriteByte(svc_temp_entity);
  if (ent.groundentity !== null) gi.WriteByte(TempEventT.TE_GRENADE_EXPLOSION);
  else gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(ent);
}

export function prox_die(self: EdictT, inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  // if set off by another prox, delay a little (chained explosions)
  if (inflictor.classname !== "prox") {
    self.takedamage = DamageT.DAMAGE_NO;
    Prox_Explode(self);
  } else {
    self.takedamage = DamageT.DAMAGE_NO;
    self.think = Prox_Explode;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function Prox_Field_Touch(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (!(other.svflags & SVF_MONSTER) && other.client === null) return;

  // trigger the prox mine if it's still there, and still mine.
  const prox = ent.owner;
  requireField("Prox_Field_Touch: ent.owner", prox !== null);

  if (other === prox) return; // don't set self off

  if (prox!.think === Prox_Explode) {
    // we're set to blow!
    return;
  }

  if (prox!.teamchain === ent) {
    gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/proxwarn.wav"), 1, ATTN_NORM, 0);
    prox!.think = Prox_Explode;
    prox!.nextthink = level.time + PROX_TIME_DELAY;
    return;
  }

  ent.solid = SolidT.SOLID_NOT;
  G_FreeEdict(ent);
}

export function prox_seek(ent: EdictT): void {
  if (level.time > ent.wait) {
    Prox_Explode(ent);
  } else {
    ent.s.frame++;
    if (ent.s.frame > 13) ent.s.frame = 9;
    ent.think = prox_seek;
    ent.nextthink = level.time + 0.1;
  }
}

export function prox_open(ent: EdictT): void {
  if (ent.s.frame === 9) {
    // end of opening animation
    // set the owner to NULL so the owner can shoot it, etc.  needs to be done here so the owner
    // doesn't get stuck on it while it's opening if fired at point blank wall
    ent.s.sound = 0;
    ent.owner = null;
    if (ent.teamchain !== null) ent.teamchain.touch = Prox_Field_Touch;

    let search: EdictT | null = null;
    while ((search = findradius(search, ent.s.origin, PROX_DAMAGE_RADIUS + 10)) !== null) {
      if (search.classname === null) continue; // tag token and other weird shit

      // if it's a monster or player with health > 0
      // or it's a player start point
      // and we can see it
      // blow up
      const isLiveTarget = ((search.svflags & SVF_MONSTER) !== 0 || search.client !== null) && search.health > 0;
      const isDmSpawn =
        gameCvars.deathmatch !== null &&
        gameCvars.deathmatch.value !== 0 &&
        (search.classname === "info_player_deathmatch" ||
          search.classname === "info_player_start" ||
          search.classname === "info_player_coop" ||
          search.classname === "misc_teleporter_dest");

      if ((isLiveTarget || isDmSpawn) && visibleLocal(search, ent)) {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/proxwarn.wav"), 1, ATTN_NORM, 0);
        Prox_Explode(ent);
        return;
      }
    }

    if (gameCvars.strong_mines !== null && gameCvars.strong_mines.value) {
      ent.wait = level.time + PROX_TIME_TO_LIVE;
    } else {
      switch ((ent.dmg / PROX_DAMAGE) | 0) {
        case 1:
          ent.wait = level.time + PROX_TIME_TO_LIVE;
          break;
        case 2:
          ent.wait = level.time + 30;
          break;
        case 4:
          ent.wait = level.time + 15;
          break;
        case 8:
          ent.wait = level.time + 10;
          break;
        default:
          ent.wait = level.time + PROX_TIME_TO_LIVE;
          break;
      }
    }

    ent.think = prox_seek;
    ent.nextthink = level.time + 0.2;
  } else {
    if (ent.s.frame === 0) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/proxopen.wav"), 1, ATTN_NORM, 0);
    ent.s.frame++;
    ent.think = prox_open;
    ent.nextthink = level.time + 0.05;
  }
}

export function prox_land(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  // must turn off owner so owner can shoot it and set it off
  // moved to prox_open so owner can get away from it if fired at pointblank range into
  // wall

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(ent);
    return;
  }

  if (plane !== null) {
    const land_point = vec3();
    VectorMA(ent.s.origin, -10.0, plane.normal, land_point);
    if (gi.pointcontents(land_point) & (CONTENTS_SLIME | CONTENTS_LAVA)) {
      Prox_Explode(ent);
      return;
    }
  }

  let movetype: MovetypeT = MovetypeT.MOVETYPE_NONE;

  if ((other.svflags & SVF_MONSTER) !== 0 || other.client !== null || (other.svflags & SVF_DAMAGEABLE) !== 0) {
    if (other !== ent.teammaster) Prox_Explode(ent);
    return;
  } else if (other !== world()) {
    // Here we need to check to see if we can stop on this entity.
    // Note that plane can be NULL
    const STOP_EPSILON = 0.1;

    if (plane === null) {
      // Since we can't tell what's going to happen, just blow up
      Prox_Explode(ent);
      return;
    }

    const stickOk = other.movetype === MovetypeT.MOVETYPE_PUSH && plane.normal[2]! > 0.7;

    const out = vec3();
    const backoff = DotProduct(ent.velocity, plane.normal) * 1.5;
    for (let i = 0; i < 3; i++) {
      const change = plane.normal[i]! * backoff;
      out[i] = ent.velocity[i]! - change;
      if (out[i]! > -STOP_EPSILON && out[i]! < STOP_EPSILON) out[i] = 0;
    }

    if (out[2]! > 60) return;

    movetype = MovetypeT.MOVETYPE_BOUNCE;

    // if we're here, we're going to stop on an entity
    if (stickOk) {
      // it's a happy entity
      VectorCopy(vec3_origin, ent.velocity);
      VectorCopy(vec3_origin, ent.avelocity);
    } else {
      // no-stick.  teflon time
      if (plane.normal[2]! > 0.7) {
        Prox_Explode(ent);
        return;
      }
      return;
    }
  } else if (other.s.modelindex !== 1) {
    return;
  }

  requireField("prox_land: plane", plane !== null);
  const dir = vec3();
  vectoangles2(plane!.normal, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  if (gi.pointcontents(ent.s.origin) & (CONTENTS_LAVA | CONTENTS_SLIME)) {
    Prox_Explode(ent);
    return;
  }

  const field = G_Spawn();

  VectorCopy(ent.s.origin, field.s.origin);
  VectorClear(field.velocity);
  VectorClear(field.avelocity);
  VectorSet(field.mins, -PROX_BOUND_SIZE, -PROX_BOUND_SIZE, -PROX_BOUND_SIZE);
  VectorSet(field.maxs, PROX_BOUND_SIZE, PROX_BOUND_SIZE, PROX_BOUND_SIZE);
  field.movetype = MovetypeT.MOVETYPE_NONE;
  field.solid = SolidT.SOLID_TRIGGER;
  field.owner = ent;
  field.classname = "prox_field";
  field.teammaster = ent;
  gi.linkentity(field);

  VectorClear(ent.velocity);
  VectorClear(ent.avelocity);
  // rotate to vertical
  dir[PITCH] = dir[PITCH]! + 90;
  VectorCopy(dir, ent.s.angles);
  ent.takedamage = DamageT.DAMAGE_AIM;
  ent.movetype = movetype; // either bounce or none, depending on whether we stuck to something
  ent.die = prox_die;
  ent.teamchain = field;
  ent.health = PROX_HEALTH;
  ent.nextthink = level.time + 0.05;
  ent.think = prox_open;
  ent.touch = null;
  ent.solid = SolidT.SOLID_BBOX;

  gi.linkentity(ent);
}

export function fire_prox(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, speed: number): void {
  const damage_multiplier = damage;
  const dir = vec3();
  vectoangles2(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const prox = G_Spawn();
  VectorCopy(start, prox.s.origin);
  VectorScale(aimdir, speed, prox.velocity);
  VectorMA(prox.velocity, 200 + crandom() * 10.0, up, prox.velocity);
  VectorMA(prox.velocity, crandom() * 10.0, right, prox.velocity);
  VectorCopy(dir, prox.s.angles);
  prox.s.angles[PITCH] = prox.s.angles[PITCH]! - 90;
  prox.movetype = MovetypeT.MOVETYPE_BOUNCE;
  prox.solid = SolidT.SOLID_BBOX;
  prox.s.effects |= EF_GRENADE;
  prox.clipmask = MASK_SHOT | CONTENTS_LAVA | CONTENTS_SLIME;
  prox.s.renderfx |= RF_IR_VISIBLE;
  VectorSet(prox.mins, -6, -6, -6);
  VectorSet(prox.maxs, 6, 6, 6);
  prox.s.modelindex = gi.modelindex("models/weapons/g_prox/tris.md2");
  prox.owner = self;
  prox.teammaster = self;
  prox.touch = prox_land;
  prox.think = Prox_Explode;
  prox.dmg = PROX_DAMAGE * damage_multiplier;
  prox.classname = "prox";
  prox.svflags |= SVF_DAMAGEABLE;
  prox.flags |= FL_MECHANICAL;

  switch (damage_multiplier) {
    case 1:
      prox.nextthink = level.time + PROX_TIME_TO_LIVE;
      break;
    case 2:
      prox.nextthink = level.time + 30;
      break;
    case 4:
      prox.nextthink = level.time + 15;
      break;
    case 8:
      prox.nextthink = level.time + 10;
      break;
    default:
      prox.nextthink = level.time + PROX_TIME_TO_LIVE;
      break;
  }

  gi.linkentity(prox);
}

// **************************
// MELEE WEAPONS
// **************************

export function fire_player_melee(
  self: EdictT,
  start: Vec3,
  aim: Vec3,
  reach: number,
  damage: number,
  kick: number,
  quiet: number,
  mod: number,
): void {
  const v = vec3();
  vectoangles2(aim, v);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(v, forward, right, up);
  VectorNormalize(forward);
  const point = vec3();
  VectorMA(start, reach, forward, point);

  // see if the hit connects
  const tr = gi.trace(start, null, null, point, self, MASK_SHOT);
  if (tr.fraction === 1.0) {
    if (!quiet) gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/swish.wav"), 1, ATTN_NORM, 0);
    return;
  }

  const hit = traceEdict(tr.ent);
  if (hit.takedamage === DamageT.DAMAGE_YES || hit.takedamage === DamageT.DAMAGE_AIM) {
    // pull the player forward if you do damage
    VectorMA(self.velocity, 75, forward, self.velocity);
    VectorMA(self.velocity, 75, up, self.velocity);

    // do the damage
    // FIXME - make the damage appear at right spot and direction
    if (mod === MOD_CHAINFIST) {
      T_Damage(
        hit,
        self,
        self,
        vec3_origin,
        hit.s.origin,
        vec3_origin,
        damage,
        (kick / 2) | 0,
        DAMAGE_DESTROY_ARMOR | DAMAGE_NO_KNOCKBACK,
        mod,
      );
    } else {
      T_Damage(hit, self, self, vec3_origin, hit.s.origin, vec3_origin, damage, (kick / 2) | 0, DAMAGE_NO_KNOCKBACK, mod);
    }

    if (!quiet) gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/meatht.wav"), 1, ATTN_NORM, 0);
  } else {
    if (!quiet) gi.sound(self, CHAN_WEAPON, gi.soundindex("weapons/tink1.wav"), 1, ATTN_NORM, 0);

    const pt = vec3();
    VectorScale(tr.plane.normal, 256, pt);
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_GUNSHOT);
    gi.WritePosition(tr.endpos);
    gi.WriteDir(pt);
    gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);
  }
}

// **************************
// NUKE
// **************************

export const NUKE_DELAY = 4;
export const NUKE_TIME_TO_LIVE = 6;
export const NUKE_RADIUS = 512;
export const NUKE_DAMAGE = 400;
export const NUKE_QUAKE_TIME = 3;
export const NUKE_QUAKE_STRENGTH = 100;

export function Nuke_Quake(self: EdictT): void {
  if (self.last_move_time < level.time) {
    gi.positioned_sound(self.s.origin, self, CHAN_AUTO, self.noise_index, 0.75, ATTN_NONE, 0);
    self.last_move_time = level.time + 0.5;
  }

  for (let i = 1; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e === undefined) continue;
    if (!e.inuse) continue;
    if (e.client === null) continue;
    if (e.groundentity === null) continue;

    e.groundentity = null;
    e.velocity[0] = e.velocity[0]! + crandom() * 150;
    e.velocity[1] = e.velocity[1]! + crandom() * 150;
    e.velocity[2] = self.speed * (100.0 / e.mass);
  }

  if (level.time < self.timestamp) self.nextthink = level.time + FRAMETIME;
  else G_FreeEdict(self);
}

function Nuke_Explode(ent: EdictT): void {
  requireField("Nuke_Explode: ent.teammaster", ent.teammaster !== null);
  if (ent.teammaster!.client !== null) PlayerNoise(ent.teammaster!, ent.s.origin, PNOISE_IMPACT);

  T_RadiusNukeDamage(ent, ent.teammaster!, ent.dmg, ent, ent.dmg_radius, MOD_NUKE);

  if (ent.dmg > NUKE_DAMAGE) gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

  gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("weapons/grenlx1a.wav"), 1, ATTN_NONE, 0);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_NUKEBLAST);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_ALL);

  // become a quake
  ent.svflags |= SVF_NOCLIENT;
  ent.noise_index = gi.soundindex("world/rumble.wav");
  ent.think = Nuke_Quake;
  ent.speed = NUKE_QUAKE_STRENGTH;
  ent.timestamp = level.time + NUKE_QUAKE_TIME;
  ent.nextthink = level.time + FRAMETIME;
  ent.last_move_time = 0;
}

export function nuke_die(self: EdictT, _inflictor: EdictT, attacker: EdictT | null, _damage: number, _point: Vec3): void {
  self.takedamage = DamageT.DAMAGE_NO;
  if (attacker !== null && attacker.classname === "nuke") {
    G_FreeEdict(self);
    return;
  }
  Nuke_Explode(self);
}

export function Nuke_Think(ent: EdictT): void {
  const default_atten = 1.8;
  let attenuation: number;
  let muzzleflash: number;

  const damage_multiplier = (ent.dmg / NUKE_DAMAGE) | 0;
  switch (damage_multiplier) {
    case 1:
      attenuation = default_atten / 1.4;
      muzzleflash = MZ_NUKE1;
      break;
    case 2:
      attenuation = default_atten / 2.0;
      muzzleflash = MZ_NUKE2;
      break;
    case 4:
      attenuation = default_atten / 3.0;
      muzzleflash = MZ_NUKE4;
      break;
    case 8:
      attenuation = default_atten / 5.0;
      muzzleflash = MZ_NUKE8;
      break;
    default:
      attenuation = default_atten;
      muzzleflash = MZ_NUKE1;
      break;
  }

  if (ent.wait < level.time) {
    Nuke_Explode(ent);
  } else if (level.time >= ent.wait - NUKE_TIME_TO_LIVE) {
    ent.s.frame++;
    if (ent.s.frame > 11) ent.s.frame = 6;

    if (gi.pointcontents(ent.s.origin) & (CONTENTS_SLIME | CONTENTS_LAVA)) {
      Nuke_Explode(ent);
      return;
    }

    ent.think = Nuke_Think;
    ent.nextthink = level.time + 0.1;
    ent.health = 1;
    ent.owner = null;

    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(g_edicts.indexOf(ent));
    gi.WriteByte(muzzleflash);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

    if (ent.timestamp <= level.time) {
      if (ent.wait - level.time <= NUKE_TIME_TO_LIVE / 2.0) {
        gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
        ent.timestamp = level.time + 0.3;
      } else {
        gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
        ent.timestamp = level.time + 0.5;
      }
    }
  } else {
    if (ent.timestamp <= level.time) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, gi.soundindex("weapons/nukewarn2.wav"), 1, attenuation, 0);
      ent.timestamp = level.time + 1.0;
    }
    ent.nextthink = level.time + FRAMETIME;
  }
}

export function nuke_bounce(ent: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (random() > 0.5) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb1a.wav"), 1, ATTN_NORM, 0);
  else gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
}

export function fire_nuke(self: EdictT, start: Vec3, aimdir: Vec3, speed: number): void {
  const damage_modifier = P_DamageModifier(self) | 0;

  const dir = vec3();
  vectoangles2(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const nuke = G_Spawn();
  VectorCopy(start, nuke.s.origin);
  VectorScale(aimdir, speed, nuke.velocity);

  VectorMA(nuke.velocity, 200 + crandom() * 10.0, up, nuke.velocity);
  VectorMA(nuke.velocity, crandom() * 10.0, right, nuke.velocity);
  VectorClear(nuke.avelocity);
  VectorClear(nuke.s.angles);
  nuke.movetype = MovetypeT.MOVETYPE_BOUNCE;
  nuke.clipmask = MASK_SHOT;
  nuke.solid = SolidT.SOLID_BBOX;
  nuke.s.effects |= EF_GRENADE;
  nuke.s.renderfx |= RF_IR_VISIBLE;
  VectorSet(nuke.mins, -8, -8, 0);
  VectorSet(nuke.maxs, 8, 8, 16);
  nuke.s.modelindex = gi.modelindex("models/weapons/g_nuke/tris.md2");
  nuke.owner = self;
  nuke.teammaster = self;
  nuke.nextthink = level.time + FRAMETIME;
  nuke.wait = level.time + NUKE_DELAY + NUKE_TIME_TO_LIVE;
  nuke.think = Nuke_Think;
  nuke.touch = nuke_bounce;

  nuke.health = 10000;
  nuke.takedamage = DamageT.DAMAGE_YES;
  nuke.svflags |= SVF_DAMAGEABLE;
  nuke.dmg = NUKE_DAMAGE * damage_modifier;
  if (damage_modifier === 1) nuke.dmg_radius = NUKE_RADIUS;
  else nuke.dmg_radius = NUKE_RADIUS + NUKE_RADIUS * (0.25 * damage_modifier);
  // this yields 1.0, 1.5, 2.0, 3.0 times radius

  nuke.classname = "nuke";
  nuke.die = nuke_die;

  gi.linkentity(nuke);
}

// **************************
// TESLA
// **************************

export const TESLA_TIME_TO_LIVE = 30;
export const TESLA_DAMAGE_RADIUS = 128;
export const TESLA_DAMAGE = 3;
export const TESLA_KNOCKBACK = 8;
export const TESLA_ACTIVATE_TIME = 3;
export const TESLA_EXPLOSION_DAMAGE_MULT = 50;
export const TESLA_EXPLOSION_RADIUS = 200;

export function tesla_remove(self: EdictT): void {
  self.takedamage = DamageT.DAMAGE_NO;
  if (self.teamchain !== null) {
    let cur: EdictT | null = self.teamchain;
    while (cur !== null) {
      const next: EdictT | null = cur.teamchain;
      G_FreeEdict(cur);
      cur = next;
    }
  } else if (self.air_finished) {
    gi.dprintf("tesla without a field!\n");
  }

  self.owner = self.teammaster; // Going away, set the owner correctly.
  // PGM - grenade explode does damage to self->enemy
  self.enemy = null;

  // play quad sound if quadded and an underwater explosion
  if (self.dmg_radius && self.dmg > TESLA_DAMAGE * TESLA_EXPLOSION_DAMAGE_MULT) {
    gi.sound(self, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
  }

  Grenade_Explode(self);
}

export function tesla_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  tesla_remove(self);
}

export function tesla_blow(self: EdictT): void {
  self.dmg = self.dmg * TESLA_EXPLOSION_DAMAGE_MULT;
  self.dmg_radius = TESLA_EXPLOSION_RADIUS;
  tesla_remove(self);
}

export function tesla_zap(_self: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {}

export function tesla_think_active(self: EdictT): void {
  requireField("tesla_think_active: self.teamchain", self.teamchain !== null);

  if (level.time > self.air_finished) {
    tesla_remove(self);
    return;
  }

  const start = vec3();
  VectorCopy(self.s.origin, start);
  start[2] += 16;

  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(self.teamchain!.absmin, self.teamchain!.absmax, touch, MAX_EDICTS, AREA_SOLID);
  for (let i = 0; i < num; i++) {
    // if the tesla died while zapping things, stop zapping.
    if (!self.inuse) break;

    const hitRef = touch[i];
    if (hitRef === undefined) continue;
    const hit = g_edicts[hitRef.s.number];
    if (hit === undefined) continue;
    if (!hit.inuse) continue;
    if (hit === self) continue;
    if (hit.health < 1) continue;
    // don't hit clients in single-player or coop
    if (hit.client !== null) {
      const coopVal = gameCvars.coop !== null && gameCvars.coop.value !== 0;
      const dmVal = gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0;
      if (coopVal || !dmVal) continue;
    }
    if (!(hit.svflags & (SVF_MONSTER | SVF_DAMAGEABLE)) && hit.client === null) continue;

    const tr = gi.trace(start, vec3_origin, vec3_origin, hit.s.origin, self, MASK_SHOT);
    const trEnt = traceEdict(tr.ent);
    if (tr.fraction === 1 || trEnt === hit) {
      const dir = vec3();
      VectorSubtract(hit.s.origin, start, dir);

      // PMM - play quad sound if it's above the "normal" damage
      if (self.dmg > TESLA_DAMAGE) gi.sound(self, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);

      requireField("tesla_think_active: self.teammaster", self.teammaster !== null);
      // PGM - don't do knockback to walking monsters
      if ((hit.svflags & SVF_MONSTER) !== 0 && !(hit.flags & (FL_FLY | FL_SWIM))) {
        T_Damage(hit, self, self.teammaster!, dir, tr.endpos, tr.plane.normal, self.dmg, 0, 0, MOD_TESLA);
      } else {
        T_Damage(hit, self, self.teammaster!, dir, tr.endpos, tr.plane.normal, self.dmg, TESLA_KNOCKBACK, 0, MOD_TESLA);
      }

      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_LIGHTNING);
      gi.WriteShort(g_edicts.indexOf(hit)); // destination entity
      gi.WriteShort(g_edicts.indexOf(self)); // source entity
      gi.WritePosition(tr.endpos);
      gi.WritePosition(start);
      gi.multicast(start, MulticastT.MULTICAST_PVS);
    }
  }

  if (self.inuse) {
    self.think = tesla_think_active;
    self.nextthink = level.time + FRAMETIME;
  }
}

export function tesla_activate(self: EdictT): void {
  if (gi.pointcontents(self.s.origin) & (CONTENTS_SLIME | CONTENTS_LAVA | CONTENTS_WATER)) {
    tesla_blow(self);
    return;
  }

  // only check for spawn points in deathmatch
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    let search: EdictT | null = null;
    while ((search = findradius(search, self.s.origin, 1.5 * TESLA_DAMAGE_RADIUS)) !== null) {
      // if it's a monster or player with health > 0
      // or it's a deathmatch start point
      // and we can see it
      // blow up
      if (search.classname !== null) {
        if (
          (search.classname === "info_player_deathmatch" ||
            search.classname === "info_player_start" ||
            search.classname === "info_player_coop" ||
            search.classname === "misc_teleporter_dest") &&
          visibleLocal(search, self)
        ) {
          tesla_remove(self);
          return;
        }
      }
    }
  }

  const trigger = G_Spawn();
  VectorCopy(self.s.origin, trigger.s.origin);
  VectorSet(trigger.mins, -TESLA_DAMAGE_RADIUS, -TESLA_DAMAGE_RADIUS, self.mins[2]!);
  VectorSet(trigger.maxs, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS, TESLA_DAMAGE_RADIUS);
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.owner = self;
  trigger.touch = tesla_zap;
  trigger.classname = "tesla trigger";
  // doesn't need to be marked as a teamslave since the move code for bounce looks for teamchains
  gi.linkentity(trigger);

  VectorClear(self.s.angles);
  // clear the owner if in deathmatch
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) self.owner = null;
  self.teamchain = trigger;
  self.think = tesla_think_active;
  self.nextthink = level.time + FRAMETIME;
  self.air_finished = level.time + TESLA_TIME_TO_LIVE;
}

export function tesla_think(ent: EdictT): void {
  if (gi.pointcontents(ent.s.origin) & (CONTENTS_SLIME | CONTENTS_LAVA)) {
    tesla_remove(ent);
    return;
  }
  VectorClear(ent.s.angles);

  if (!ent.s.frame) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/teslaopen.wav"), 1, ATTN_NORM, 0);

  ent.s.frame++;
  if (ent.s.frame > 14) {
    ent.s.frame = 14;
    ent.think = tesla_activate;
    ent.nextthink = level.time + 0.1;
  } else {
    if (ent.s.frame > 9) {
      if (ent.s.frame === 10) {
        if (ent.owner !== null && ent.owner.client !== null) {
          PlayerNoise(ent.owner, ent.s.origin, PNOISE_WEAPON); // PGM
        }
        ent.s.skinnum = 1;
      } else if (ent.s.frame === 12) {
        ent.s.skinnum = 2;
      } else if (ent.s.frame === 14) {
        ent.s.skinnum = 3;
      }
    }
    ent.think = tesla_think;
    ent.nextthink = level.time + 0.1;
  }
}

export function tesla_lava(ent: EdictT, _other: EdictT, plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (plane !== null) {
    const land_point = vec3();
    VectorMA(ent.s.origin, -20.0, plane.normal, land_point);
    if (gi.pointcontents(land_point) & (CONTENTS_SLIME | CONTENTS_LAVA)) {
      tesla_blow(ent);
      return;
    }
  }
  if (random() > 0.5) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb1a.wav"), 1, ATTN_NORM, 0);
  else gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/hgrenb2a.wav"), 1, ATTN_NORM, 0);
}

export function fire_tesla(self: EdictT, start: Vec3, aimdir: Vec3, damage: number, speed: number): void {
  const damage_multiplier = damage;
  const dir = vec3();
  vectoangles2(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const tesla = G_Spawn();
  VectorCopy(start, tesla.s.origin);
  VectorScale(aimdir, speed, tesla.velocity);
  VectorMA(tesla.velocity, 200 + crandom() * 10.0, up, tesla.velocity);
  VectorMA(tesla.velocity, crandom() * 10.0, right, tesla.velocity);
  VectorClear(tesla.s.angles);
  tesla.movetype = MovetypeT.MOVETYPE_BOUNCE;
  tesla.solid = SolidT.SOLID_BBOX;
  tesla.s.effects |= EF_GRENADE;
  tesla.s.renderfx |= RF_IR_VISIBLE;
  VectorSet(tesla.mins, -12, -12, 0);
  VectorSet(tesla.maxs, 12, 12, 20);
  tesla.s.modelindex = gi.modelindex("models/weapons/g_tesla/tris.md2");

  tesla.owner = self; // PGM - we don't want it owned by self YET.
  tesla.teammaster = self;

  tesla.wait = level.time + TESLA_TIME_TO_LIVE;
  tesla.think = tesla_think;
  tesla.nextthink = level.time + TESLA_ACTIVATE_TIME;

  // blow up on contact with lava & slime code
  tesla.touch = tesla_lava;

  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    // PMM - lowered from 50 - 7/29/1998
    tesla.health = 20;
  } else {
    tesla.health = 30; // FIXME - change depending on skill?
  }

  tesla.takedamage = DamageT.DAMAGE_YES;
  tesla.die = tesla_die;
  tesla.dmg = TESLA_DAMAGE * damage_multiplier;
  tesla.classname = "tesla";
  tesla.svflags |= SVF_DAMAGEABLE;
  tesla.clipmask = MASK_SHOT | CONTENTS_SLIME | CONTENTS_LAVA;
  tesla.flags |= FL_MECHANICAL;

  gi.linkentity(tesla);
}

// **************************
//	HEATBEAM
// **************************

function fire_beams(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  offset: Vec3,
  damageIn: number,
  kick: number,
  te_beam: number,
  _te_impact: number,
  mod: number,
): void {
  let damage = damageIn;
  let water = false;
  let underwater = false;
  let content_mask = MASK_SHOT | MASK_WATER;

  const dir = vec3();
  vectoangles2(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const end = vec3();
  VectorMA(start, 8192, forward, end);

  const water_start = vec3();
  if (gi.pointcontents(start) & MASK_WATER) {
    underwater = true;
    VectorCopy(start, water_start);
    content_mask &= ~MASK_WATER;
  }

  let tr = gi.trace(start, null, null, end, self, content_mask);

  // see if we hit water
  if (tr.contents & MASK_WATER) {
    water = true;
    VectorCopy(tr.endpos, water_start);

    if (VectorCompare(start, tr.endpos) === 0) {
      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_HEATBEAM_SPARKS);
      gi.WritePosition(water_start);
      gi.WriteDir(tr.plane.normal);
      gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);
    }
    // re-trace ignoring water this time
    tr = gi.trace(water_start, null, null, end, self, MASK_SHOT);
  }
  const endpoint = vec3();
  VectorCopy(tr.endpos, endpoint);

  // halve the damage if target underwater
  if (water) damage = (damage / 2) | 0;

  // send gun puff / flash
  if (!(tr.surface !== null && tr.surface.flags & SURF_SKY)) {
    if (tr.fraction < 1.0) {
      const hit = traceEdict(tr.ent);
      if (hit.takedamage) {
        T_Damage(hit, self, self, aimdir, tr.endpos, tr.plane.normal, damage, kick, DAMAGE_ENERGY, mod);
      } else {
        requireField("fire_beams: tr.surface", tr.surface !== null);
        if (!water && !tr.surface!.name.startsWith("sky")) {
          // This is the truncated steam entry - uses 1+1+2 extra bytes of data
          gi.WriteByte(svc_temp_entity);
          gi.WriteByte(TempEventT.TE_HEATBEAM_STEAM);
          gi.WritePosition(tr.endpos);
          gi.WriteDir(tr.plane.normal);
          gi.multicast(tr.endpos, MulticastT.MULTICAST_PVS);

          if (self.client !== null) PlayerNoise(self, tr.endpos, PNOISE_IMPACT);
        }
      }
    }
  }

  // if went through water, determine where the end and make a bubble trail
  if (water || underwater) {
    const dir2 = vec3();
    VectorSubtract(tr.endpos, water_start, dir2);
    VectorNormalize(dir2);
    const pos = vec3();
    VectorMA(tr.endpos, -2, dir2, pos);
    if (gi.pointcontents(pos) & MASK_WATER) {
      VectorCopy(pos, tr.endpos);
    } else {
      const trEnt2 = traceEdict(tr.ent);
      tr = gi.trace(pos, null, null, water_start, trEnt2, MASK_WATER);
    }

    const mid = vec3();
    VectorAdd(water_start, tr.endpos, mid);
    VectorScale(mid, 0.5, mid);

    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_BUBBLETRAIL2);
    gi.WritePosition(water_start);
    gi.WritePosition(tr.endpos);
    gi.multicast(mid, MulticastT.MULTICAST_PVS);
  }

  const beam_endpt = vec3();
  if (!underwater && !water) VectorCopy(tr.endpos, beam_endpt);
  else VectorCopy(endpoint, beam_endpt);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(te_beam);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WritePosition(start);
  gi.WritePosition(beam_endpt);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_ALL);
}

/*
=================
fire_heat

Fires a single heat beam.  Zap.
=================
*/
export function fire_heat(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  offset: Vec3,
  damage: number,
  kick: number,
  monster: boolean,
): void {
  if (monster) {
    fire_beams(self, start, aimdir, offset, damage, kick, TempEventT.TE_MONSTER_HEATBEAM, TempEventT.TE_HEATBEAM_SPARKS, MOD_HEATBEAM);
  } else {
    fire_beams(self, start, aimdir, offset, damage, kick, TempEventT.TE_HEATBEAM, TempEventT.TE_HEATBEAM_SPARKS, MOD_HEATBEAM);
  }
}

// **************************
//	BLASTER 2
// **************************

/*
=================
fire_blaster2

Fires a single green blaster bolt.  Used by monsters, generally.
=================
*/
export function blaster2_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  if (self.owner !== null && self.owner.client !== null) PlayerNoise(self.owner, self.s.origin, PNOISE_IMPACT);

  if (other.takedamage) {
    // the only time players will be firing blaster2 bolts will be from the
    // defender sphere.
    requireField("blaster2_touch: self.owner", self.owner !== null);
    const mod = self.owner!.client !== null ? MOD_DEFENDER_SPHERE : MOD_BLASTER2;

    if (self.owner !== null) {
      const damagestat = self.owner.takedamage;
      self.owner.takedamage = DamageT.DAMAGE_NO;
      if (self.dmg >= 5) T_RadiusDamage(self, self.owner, self.dmg * 3, other, self.dmg_radius, 0);
      requireField("blaster2_touch: plane", plane !== null);
      T_Damage(other, self, self.owner, self.velocity, self.s.origin, plane!.normal, self.dmg, 1, DAMAGE_ENERGY, mod);
      self.owner.takedamage = damagestat;
    }
  } else {
    // PMM - yeowch this will get expensive
    requireField("blaster2_touch: self.owner", self.owner !== null);
    if (self.dmg >= 5) T_RadiusDamage(self, self.owner!, self.dmg * 3, self.owner, self.dmg_radius, 0);

    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_BLASTER2);
    gi.WritePosition(self.s.origin);
    if (plane === null) gi.WriteDir(vec3_origin);
    else gi.WriteDir(plane.normal);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  }

  G_FreeEdict(self);
}

export function fire_blaster2(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  effect: number,
  _hyper: boolean,
): void {
  VectorNormalize(dir);

  const bolt = G_Spawn();
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles2(dir, bolt.s.angles);
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.s.effects |= effect;
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);

  if (effect) bolt.s.effects |= EF_TRACKER;
  bolt.dmg_radius = 128;
  bolt.s.modelindex = gi.modelindex("models/proj/laser2/tris.md2");
  bolt.touch = blaster2_touch;

  bolt.owner = self;
  bolt.nextthink = level.time + 2;
  bolt.think = G_FreeEdict;
  bolt.dmg = damage;
  bolt.classname = "bolt";
  gi.linkentity(bolt);

  if (self.client !== null) check_dodge(self, bolt.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, bolt, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    requireField("fire_blaster2: bolt.touch", bolt.touch !== null);
    bolt.touch!(bolt, traceEdict(tr.ent), null, null);
  }
}

// **************************
// tracker
// **************************

const TRACKER_DAMAGE_FLAGS = DAMAGE_NO_POWER_ARMOR | DAMAGE_ENERGY | DAMAGE_NO_KNOCKBACK;
const TRACKER_IMPACT_FLAGS = DAMAGE_NO_POWER_ARMOR | DAMAGE_ENERGY;
const TRACKER_DAMAGE_TIME = 0.5; // seconds

const trackerPainNormal: Vec3 = vec3();
VectorSet(trackerPainNormal, 0, 0, 1);

export function tracker_pain_daemon_think(self: EdictT): void {
  if (!self.inuse) return;

  requireField("tracker_pain_daemon_think: self.enemy", self.enemy !== null);
  const enemy = self.enemy!;

  if (level.time - self.timestamp > TRACKER_DAMAGE_TIME) {
    if (enemy.client === null) enemy.s.effects &= ~EF_TRACKERTRAIL;
    G_FreeEdict(self);
  } else {
    if (enemy.health > 0) {
      requireField("tracker_pain_daemon_think: self.owner", self.owner !== null);
      T_Damage(enemy, self, self.owner!, vec3_origin, enemy.s.origin, trackerPainNormal, self.dmg, 0, TRACKER_DAMAGE_FLAGS, MOD_TRACKER);

      // if we kill the player, we'll be removed.
      if (self.inuse) {
        // if we killed a monster, gib them.
        if (enemy.health < 1) {
          const hurt = enemy.gib_health ? -enemy.gib_health : 500;
          T_Damage(enemy, self, self.owner!, vec3_origin, enemy.s.origin, trackerPainNormal, hurt, 0, TRACKER_DAMAGE_FLAGS, MOD_TRACKER);
        }

        if (enemy.client !== null) enemy.client.tracker_pain_framenum = level.framenum + 1;
        else enemy.s.effects |= EF_TRACKERTRAIL;

        self.nextthink = level.time + FRAMETIME;
      }
    } else {
      if (enemy.client === null) enemy.s.effects &= ~EF_TRACKERTRAIL;
      G_FreeEdict(self);
    }
  }
}

export function tracker_pain_daemon_spawn(owner: EdictT, enemy: EdictT | null, damage: number): void {
  if (enemy === null) return;

  const daemon = G_Spawn();
  daemon.classname = "pain daemon";
  daemon.think = tracker_pain_daemon_think;
  daemon.nextthink = level.time + FRAMETIME;
  daemon.timestamp = level.time;
  daemon.owner = owner;
  daemon.enemy = enemy;
  daemon.dmg = damage;
}

export function tracker_explode(self: EdictT, plane: CplaneT | null): void {
  const dir = vec3();
  if (plane === null) VectorClear(dir);
  else VectorScale(plane.normal, 256, dir);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_TRACKER_EXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(self);
}

export function tracker_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  // C checks self->client here (always null for a projectile) -- preserved
  // bug-for-bug rather than the presumably-intended self->owner->client.
  if (self.client !== null) {
    requireField("tracker_touch: self.owner", self.owner !== null);
    PlayerNoise(self.owner!, self.s.origin, PNOISE_IMPACT);
  }

  if (other.takedamage) {
    requireField("tracker_touch: self.owner", self.owner !== null);
    requireField("tracker_touch: plane", plane !== null);
    const owner = self.owner!;
    if ((other.svflags & SVF_MONSTER) !== 0 || other.client !== null) {
      if (other.health > 0) {
        // knockback only for living creatures
        // PMM - kickback was times 4 .. reduced to 3
        // now this does no damage, just knockback
        T_Damage(other, self, owner, self.velocity, self.s.origin, plane!.normal, 0, self.dmg * 3, TRACKER_IMPACT_FLAGS, MOD_TRACKER);

        if (!(other.flags & (FL_FLY | FL_SWIM))) other.velocity[2] = other.velocity[2]! + 140;

        let damagetime = self.dmg * FRAMETIME;
        damagetime = damagetime / TRACKER_DAMAGE_TIME;

        tracker_pain_daemon_spawn(owner, other, damagetime | 0);
      } else {
        // lots of damage (almost autogib) for dead bodies
        T_Damage(other, self, owner, self.velocity, self.s.origin, plane!.normal, self.dmg * 4, self.dmg * 3, TRACKER_IMPACT_FLAGS, MOD_TRACKER);
      }
    } else {
      // full damage in one shot for inanimate objects
      T_Damage(other, self, owner, self.velocity, self.s.origin, plane!.normal, self.dmg, self.dmg * 3, TRACKER_IMPACT_FLAGS, MOD_TRACKER);
    }
  }

  tracker_explode(self, plane);
}

export function tracker_fly(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse || self.enemy.health < 1) {
    tracker_explode(self, null);
    return;
  }

  const dest = vec3();
  // PMM - try to hunt for center of enemy, if possible and not client
  if (self.enemy.client !== null) {
    VectorCopy(self.enemy.s.origin, dest);
    dest[2] += self.enemy.viewheight;
  } else if (VectorCompare(self.enemy.absmin, vec3_origin) !== 0 || VectorCompare(self.enemy.absmax, vec3_origin) !== 0) {
    // paranoia
    VectorCopy(self.enemy.s.origin, dest);
  } else {
    const center = vec3();
    VectorMA(vec3_origin, 0.5, self.enemy.absmin, center);
    VectorMA(center, 0.5, self.enemy.absmax, center);
    VectorCopy(center, dest);
  }

  const dir = vec3();
  VectorSubtract(dest, self.s.origin, dir);
  VectorNormalize(dir);
  vectoangles2(dir, self.s.angles);
  VectorScale(dir, self.speed, self.velocity);
  VectorCopy(dest, self.monsterinfo.saved_goal);

  self.nextthink = level.time + 0.1;
}

export function fire_tracker(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, enemy: EdictT | null): void {
  VectorNormalize(dir);

  const bolt = G_Spawn();
  VectorCopy(start, bolt.s.origin);
  VectorCopy(start, bolt.s.old_origin);
  vectoangles2(dir, bolt.s.angles);
  VectorScale(dir, speed, bolt.velocity);
  bolt.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  bolt.clipmask = MASK_SHOT;
  bolt.solid = SolidT.SOLID_BBOX;
  bolt.speed = speed;
  bolt.s.effects = EF_TRACKER;
  bolt.s.sound = gi.soundindex("weapons/disrupt.wav");
  VectorClear(bolt.mins);
  VectorClear(bolt.maxs);

  bolt.s.modelindex = gi.modelindex("models/proj/disintegrator/tris.md2");
  bolt.touch = tracker_touch;
  bolt.enemy = enemy;
  bolt.owner = self;
  bolt.dmg = damage;
  bolt.classname = "tracker";
  gi.linkentity(bolt);

  if (enemy !== null) {
    bolt.nextthink = level.time + 0.1;
    bolt.think = tracker_fly;
  } else {
    bolt.nextthink = level.time + 10;
    bolt.think = G_FreeEdict;
  }

  if (self.client !== null) check_dodge(self, bolt.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, bolt.s.origin, bolt, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(bolt.s.origin, -10, dir, bolt.s.origin);
    requireField("fire_tracker: bolt.touch", bolt.touch !== null);
    bolt.touch!(bolt, traceEdict(tr.ent), null, null);
  }
}

// =========================================================================
// RERELEASE CONTENT PORT -- XATRIX PROJECTILES (xatrix/g_weapon.c)
//
// These three belong to g_weapon.c in the xatrix source. src/game/g_weapon.ts
// is owned by another agent (which may add the MONSTER-side xatrix helpers
// there), so this module's player-weapon copies live here instead. Flagged
// to the coordinator as a possible duplicate.
//
// NOTE -- name collision across packs: xatrix/g_weapon.c also defines a
// `fire_heat` (the heat-seeking rocket) that is a COMPLETELY DIFFERENT
// function from rogue/g_newweap.c's `fire_heat` (the plasma-beam hitscan)
// already exported above. Different parameters, different behaviour, same
// name. This file keeps rogue's; xatrix's must not be added here under that
// name. Reported to the coordinator.
// =========================================================================

function requireOwner(ent: EdictT): EdictT {
  if (ent.owner === null) {
    throw new Error("xatrix projectile: self.owner is null (C dereferences it unconditionally here)");
  }
  return ent.owner;
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_ionripper (RipperGun)

export function ionripper_sparks(self: EdictT): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(0);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(0xe4 + (Math.floor(Math.random() * 4) & 3));
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(self);
}

export function ionripper_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client !== null) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  if (!other.takedamage) {
    return;
  }

  // C dereferences plane->normal unconditionally here; ionripper_touch is
  // only ever reached via SV_Impact (plane always non-NULL in practice) or
  // fire_ionripper's own immediate self-trace, which passes NULL.
  const normal = plane === null ? vec3_origin : plane.normal;
  T_Damage(other, self, owner, self.velocity, self.s.origin, normal, self.dmg, 1, DAMAGE_ENERGY, MOD_RIPPER);

  G_FreeEdict(self);
}

export function fire_ionripper(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  effect: number,
): void {
  VectorNormalize(dir);

  const ion = G_Spawn();
  VectorCopy(start, ion.s.origin);
  VectorCopy(start, ion.s.old_origin);
  vectoangles(dir, ion.s.angles);
  VectorScale(dir, speed, ion.velocity);

  // xatrix/g_weapon.c: the ion ripper blade ricochets flat off walls rather
  // than arcing under gravity, which is what MOVETYPE_WALLBOUNCE exists for
  // (stronger backoff, no gravity, re-orients to the new travel direction,
  // never settles on the ground). The enum member and g_phys.ts's four
  // WALLBOUNCE branches are both ported, so this is the real movetype now.
  ion.movetype = MovetypeT.MOVETYPE_WALLBOUNCE;
  ion.clipmask = MASK_SHOT;
  ion.solid = SolidT.SOLID_BBOX;
  ion.s.effects |= effect;

  ion.s.renderfx |= RF_FULLBRIGHT;

  VectorClear(ion.mins);
  VectorClear(ion.maxs);
  ion.s.modelindex = gi.modelindex("models/objects/boomrang/tris.md2");
  ion.s.sound = gi.soundindex("misc/lasfly.wav");
  ion.owner = self;
  ion.touch = ionripper_touch;
  ion.nextthink = level.time + 3;
  ion.think = ionripper_sparks;
  ion.dmg = damage;
  ion.dmg_radius = 100;
  gi.linkentity(ion);

  if (self.client !== null) check_dodge(self, ion.s.origin, dir, speed);

  const tr = gi.trace(self.s.origin, null, null, ion.s.origin, ion, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(ion.s.origin, -10, dir, ion.s.origin);
    if (ion.touch) ion.touch(ion, traceEdict(tr.ent), null, null);
  }
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_plasma (Phalanx)

export function plasma_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(ent);
    return;
  }

  const owner = requireOwner(ent);
  if (owner.client !== null) PlayerNoise(owner, ent.s.origin, PNOISE_IMPACT);

  // calculate position for the explosion entity
  const origin = vec3();
  VectorMA(ent.s.origin, -0.02, ent.velocity, origin);

  const normal = plane === null ? vec3_origin : plane.normal;
  if (other.takedamage) {
    T_Damage(other, ent, owner, ent.velocity, ent.s.origin, normal, ent.dmg, 0, 0, MOD_PHALANX);
  }

  T_RadiusDamage(ent, owner, ent.radius_dmg, other, ent.dmg_radius, MOD_PHALANX);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PLASMA_EXPLOSION);
  gi.WritePosition(origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  G_FreeEdict(ent);
}

export function fire_plasma(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  damage_radius: number,
  radius_damage: number,
): void {
  const plasma = G_Spawn();
  VectorCopy(start, plasma.s.origin);
  VectorCopy(dir, plasma.movedir);
  vectoangles(dir, plasma.s.angles);
  VectorScale(dir, speed, plasma.velocity);
  plasma.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  plasma.clipmask = MASK_SHOT;
  plasma.solid = SolidT.SOLID_BBOX;

  VectorClear(plasma.mins);
  VectorClear(plasma.maxs);

  plasma.owner = self;
  plasma.touch = plasma_touch;
  plasma.nextthink = level.time + 8000 / speed;
  plasma.think = G_FreeEdict;
  plasma.dmg = damage;
  plasma.radius_dmg = radius_damage;
  plasma.dmg_radius = damage_radius;
  plasma.s.sound = gi.soundindex("weapons/rockfly.wav");

  plasma.s.modelindex = gi.modelindex("sprites/s_photon.sp2");
  plasma.s.effects |= EF_PLASMA | EF_ANIM_ALLFAST;

  if (self.client !== null) check_dodge(self, plasma.s.origin, dir, speed);

  gi.linkentity(plasma);
}

// xatrix/g_weapon.c: `// RAFAEL` -- fire_trap (thrown trap weapon)

export function Trap_Think(ent: EdictT): void {
  let best: EdictT | null = null;

  if (ent.timestamp < level.time) {
    BecomeExplosion1(ent);
    // note to self: cause explosion damage??? (verbatim C TODO, never wired)
    return;
  }

  ent.nextthink = level.time + 0.1;

  if (!ent.groundentity) return;

  // ok let's do the blood effect
  if (ent.s.frame > 4) {
    if (ent.s.frame === 5) {
      if (ent.wait === 64) gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/trapdown.wav"), 1, ATTN_IDLE, 0);

      ent.wait -= 2;
      ent.delay += level.time;

      const forward = vec3();
      const right = vec3();
      const up = vec3();
      AngleVectors(ent.s.angles, forward, right, up);

      for (let i = 0; i < 3; i++) {
        best = G_Spawn();

        if (ent.enemy !== null && ent.enemy.classname === "monster_gekk") {
          best.s.modelindex = gi.modelindex("models/objects/gekkgib/torso/tris.md2");
          best.s.effects |= TempEventT.TE_GREENBLOOD;
        } else if (ent.mass > 200) {
          best.s.modelindex = gi.modelindex("models/objects/gibs/chest/tris.md2");
          best.s.effects |= TempEventT.TE_BLOOD;
        } else {
          best.s.modelindex = gi.modelindex("models/objects/gibs/sm_meat/tris.md2");
          best.s.effects |= TempEventT.TE_BLOOD;
        }

        const vec = vec3();
        RotatePointAroundVector(vec, up, right, (360.0 / 3) * i + ent.delay);
        VectorMA(vec, ent.wait / 2, vec, vec);
        VectorAdd(vec, ent.s.origin, vec);
        VectorAdd(vec, forward, best.s.origin);

        best.s.origin[2] = ent.s.origin[2] + ent.wait;

        VectorCopy(ent.s.angles, best.s.angles);

        best.solid = SolidT.SOLID_NOT;
        best.s.effects |= EF_GIB;
        best.takedamage = DamageT.DAMAGE_YES;

        best.movetype = MovetypeT.MOVETYPE_TOSS;
        best.svflags |= SVF_MONSTER;
        best.deadflag = DEAD_DEAD;

        VectorClear(best.mins);
        VectorClear(best.maxs);

        best.watertype = gi.pointcontents(best.s.origin);
        if (best.watertype & MASK_WATER) best.waterlevel = 1;

        best.nextthink = level.time + 0.1;
        best.think = G_FreeEdict;
        gi.linkentity(best);
      }

      if (ent.wait < 19) ent.s.frame++;

      return;
    }
    ent.s.frame++;
    if (ent.s.frame === 8) {
      ent.nextthink = level.time + 1.0;
      ent.think = G_FreeEdict;

      best = G_Spawn();
      SP_item_foodcube(best);
      VectorCopy(ent.s.origin, best.s.origin);
      best.s.origin[2] += 16;
      best.velocity[2] = 400;
      best.count = ent.mass;
      gi.linkentity(best);
      return;
    }
    return;
  }

  ent.s.effects &= ~EF_TRAP;
  if (ent.s.frame >= 4) {
    ent.s.effects |= EF_TRAP;
    VectorClear(ent.mins);
    VectorClear(ent.maxs);
  }

  if (ent.s.frame < 4) ent.s.frame++;

  let oldlen = 8000;
  let target: EdictT | null = null;
  for (;;) {
    target = findradius(target, ent.s.origin, 256);
    if (target === null) break;

    if (target === ent) continue;
    if (!(target.svflags & SVF_MONSTER) && !target.client) continue;
    if (target.health <= 0) continue;
    if (!visibleLocal(ent, target)) continue;
    if (best === null) {
      best = target;
      continue;
    }
    const vec = vec3();
    VectorSubtract(ent.s.origin, target.s.origin, vec);
    const len = VectorLength(vec);
    if (len < oldlen) {
      oldlen = len;
      best = target;
    }
  }

  // pull the enemy in
  if (best !== null) {
    if (best.groundentity) {
      best.s.origin[2] += 1;
      best.groundentity = null;
    }
    const vec = vec3();
    VectorSubtract(ent.s.origin, best.s.origin, vec);
    const len = VectorLength(vec);
    if (best.client !== null) {
      VectorNormalize(vec);
      VectorMA(best.velocity, 250, vec, best.velocity);
    } else {
      best.ideal_yaw = vectoyaw(vec);
      M_ChangeYaw(best);
      const forward = vec3();
      AngleVectors(best.s.angles, forward, null, null);
      VectorScale(forward, 256, best.velocity);
    }

    gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/trapsuck.wav"), 1, ATTN_IDLE, 0);

    if (len < 32) {
      if (best.mass < 400) {
        T_Damage(best, ent, requireOwner(ent), vec3_origin, best.s.origin, vec3_origin, 100000, 1, 0, MOD_TRAP);
        ent.enemy = best;
        ent.wait = 64;
        VectorCopy(ent.s.origin, ent.s.old_origin);
        ent.timestamp = level.time + 30;
        const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
        ent.mass = deathmatch ? (best.mass / 4) | 0 : (best.mass / 10) | 0;
        // spawn the food cube
        ent.s.frame = 5;
      } else {
        BecomeExplosion1(ent);
        // note to self: cause explosion damage??? (verbatim C TODO, never wired)
        return;
      }
    }
  }
}

export function fire_trap(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  timer: number,
  damage_radius: number,
  held: boolean,
): void {
  const dir = vec3();
  vectoangles(aimdir, dir);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(dir, forward, right, up);

  const trap = G_Spawn();
  VectorCopy(start, trap.s.origin);
  VectorScale(aimdir, speed, trap.velocity);
  VectorMA(trap.velocity, 200 + crandom() * 10.0, up, trap.velocity);
  VectorMA(trap.velocity, crandom() * 10.0, right, trap.velocity);
  VectorSet(trap.avelocity, 0, 300, 0);
  trap.movetype = MovetypeT.MOVETYPE_BOUNCE;
  trap.clipmask = MASK_SHOT;
  trap.solid = SolidT.SOLID_BBOX;
  VectorSet(trap.mins, -4, -4, 0);
  VectorSet(trap.maxs, 4, 4, 8);
  trap.s.modelindex = gi.modelindex("models/weapons/z_trap/tris.md2");
  trap.owner = self;
  trap.nextthink = level.time + 1.0;
  trap.think = Trap_Think;
  trap.dmg = damage;
  trap.dmg_radius = damage_radius;
  trap.classname = "htrap";
  trap.s.sound = gi.soundindex("weapons/traploop.wav");
  trap.spawnflags = held ? 3 : 1;

  if (timer <= 0.0) {
    Grenade_Explode(trap);
  } else {
    gi.linkentity(trap);
  }

  trap.timestamp = level.time + 30;
}

// -------------------------------------------------------------------------
// Savegame function registry -- DELIBERATE DEVIATION from src/rogue/ and
// src/game/, where each file calls registerSaveFunction at its own module
// top level. This module keeps ONE central registry population, in
// g_save.ts's populateSaveRegistry(), and every callback this file installs
// on an edict is listed there.
//
// The reason is a real module-initialization cycle, not a style preference:
// g_save.ts -> p_client.ts -> p_weapon.ts -> this file. Registering at this
// file's top level runs the call while g_save.ts's own module body is still
// executing, before its `const functionRegistry` initializer has run, and
// throws "Cannot access 'functionRegistry' before initialization" -- which
// kills every entry point into this module at import time. g_save.ts calls
// populateSaveRegistry() at the END of its body, after that const exists,
// so registering from there is safe. (Same treatment in g_sphere.ts.)
// -------------------------------------------------------------------------
