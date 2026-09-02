// g_newdm.c
// pmack
// june 1998
//
// General deathmatch-variant plumbing: the DMGame dispatch table (which
// swaps in Tag_*/DBall_* hooks based on the "gamerules" cvar), the random
// item substitution used by the "randomrespawn" dmflag, and the
// doppelganger decoy fired by the disruptor's alt-fire (see g_newweap.ts).
//
// `dm_game_rt DMGame;` is declared in g_local.h and, per this session's
// sibling RG-core unit, its type (`DmGameRt`) and singleton (`DMGame`) are
// declared in g_local.ts (the header-owning module) rather than here --
// this file only populates the singleton's fields, matching the C split
// between the shared header and the .c file that defines the behaviour.

import { AngleVectors, anglemod, random, VectorClear, VectorCopy, VectorLength, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import { DF_NO_MINES, DF_NO_NUKES, DF_NO_SPHERES, type EntityStateT, PITCH, RF_IR_VISIBLE, YAW } from "../shared/q_shared";
import { SolidT, SVF_DAMAGEABLE } from "./game";
import {
  ARMOR_SHARD,
  DamageT,
  DMGame,
  DmGameRt,
  type EdictT,
  FRAMETIME,
  game,
  gameCvars,
  type GItemT,
  gi,
  IT_AMMO,
  IT_ARMOR,
  IT_KEY,
  IT_NOT_GIVEABLE,
  IT_POWERUP,
  IT_WEAPON,
  level,
  MovetypeT,
  RDM_TAG,
  SPHERE_DOPPLEGANGER,
  SPHERE_HUNTER,
  SPHERE_VENGEANCE,
} from "./g_local";
import { itemlist, Pickup_Adrenaline, Pickup_Armor, Pickup_Health, Pickup_PowerArmor, PrecacheItem } from "./g_items";
import { ED_CallSpawn } from "./g_spawn";
import { G_Spawn, vectoangles2 } from "./g_utils";
import { BecomeExplosion1 } from "./g_misc";
import { M_ChangeYaw } from "./m_move";
import { FRAME_stand01, FRAME_stand40 } from "./m_player_frames";
import { Sphere_Spawn } from "./g_sphere";
import { Tag_ChangeDamage, Tag_DogTag, Tag_GameInit, Tag_PlayerDeath, Tag_PlayerDisconnect, Tag_PlayerEffects, Tag_PostInitSetup, Tag_Score } from "./dm_tag";

// ****************************
// General DM Stuff
// ****************************

export function InitGameRules(): void {
  // clear out the game rule structure before we start
  Object.assign(DMGame, new DmGameRt());

  if (gameCvars.gamerules !== null && gameCvars.gamerules.value) {
    const gameNum = gameCvars.gamerules.value | 0;
    switch (gameNum) {
      case RDM_TAG:
        DMGame.GameInit = Tag_GameInit;
        DMGame.PostInitSetup = Tag_PostInitSetup;
        DMGame.PlayerDeath = Tag_PlayerDeath;
        DMGame.Score = Tag_Score;
        DMGame.PlayerEffects = Tag_PlayerEffects;
        DMGame.DogTag = Tag_DogTag;
        DMGame.PlayerDisconnect = Tag_PlayerDisconnect;
        DMGame.ChangeDamage = Tag_ChangeDamage;
        break;
      /*
      case RDM_DEATHBALL:
        DMGame.GameInit = DBall_GameInit;
        DMGame.ChangeKnockback = DBall_ChangeKnockback;
        DMGame.ChangeDamage = DBall_ChangeDamage;
        DMGame.ClientBegin = DBall_ClientBegin;
        DMGame.SelectSpawnPoint = DBall_SelectSpawnPoint;
        DMGame.PostInitSetup = DBall_PostInitSetup;
        DMGame.CheckDMRules = DBall_CheckDMRules;
        break;
      */
      // reset gamerules if it's not a valid number
      default:
        gameCvars.gamerules.value = 0;
        break;
    }
  }

  // if we're set up to play, initialize the game as needed.
  if (DMGame.GameInit) DMGame.GameInit();
}

//=================
//=================
const IT_TYPE_MASK = IT_WEAPON | IT_AMMO | IT_POWERUP | IT_ARMOR | IT_KEY;

function requireItem(ent: EdictT, what: string): GItemT {
  if (ent.item === null) throw new Error(`${what}.item is null (C dereferences it unconditionally here)`);
  return ent.item;
}

export function FindSubstituteItem(ent: EdictT): string | null {
  const item = requireItem(ent, "FindSubstituteItem: ent");

  // there are only two classes of power armor, and we don't want
  // to give out power screens. therefore, power shields should
  // remain power shields. (powerscreens shouldn't be there at all...)
  if (item.pickup === Pickup_PowerArmor) return null;

  // health is special case
  if (item.pickup === Pickup_Health || item.pickup === Pickup_Adrenaline) {
    // health pellets stay health pellets
    if (ent.classname === "item_health_small") return null;

    const rnd = random();
    if (rnd < 0.6) return "item_health";
    else if (rnd < 0.9) return "item_health_large";
    else if (rnd < 0.99) return "item_adrenaline";
    else return "item_health_mega";
  }
  // armor is also special case
  else if (item.pickup === Pickup_Armor) {
    // armor shards stay armor shards
    if (item.tag === ARMOR_SHARD) return null;

    const rnd = random();
    if (rnd < 0.6) return "item_armor_jacket";
    else if (rnd < 0.9) return "item_armor_combat";
    else return "item_armor_body";
  }

  // we want to stay within the item class
  let myflags = item.flags & IT_TYPE_MASK;
  if (myflags & IT_AMMO && myflags & IT_WEAPON) myflags = IT_AMMO;

  let count = 0;

  const dmflagsValue = gameCvars.dmflags === null ? 0 : (gameCvars.dmflags.value | 0);
  const list = itemlist();

  // first pass, count the matching items
  for (let i = 0; i < game.num_items; i++) {
    const it = list[i];
    if (it === undefined) continue;
    let itflags = it.flags;

    if (!itflags || itflags & IT_NOT_GIVEABLE) continue;

    // prox,grenades,etc should count as ammo.
    if (itflags & IT_AMMO && itflags & IT_WEAPON) itflags = IT_AMMO;

    // don't respawn spheres if they're dmflag disabled.
    if (dmflagsValue & DF_NO_SPHERES) {
      if (
        ent.classname === "item_sphere_vengeance" ||
        ent.classname === "item_sphere_hunter" ||
        ent.classname === "item_spehre_defender"
      ) {
        continue;
      }
    }

    if (dmflagsValue & DF_NO_NUKES && ent.classname === "ammo_nuke") continue;

    if (dmflagsValue & DF_NO_MINES && (ent.classname === "ammo_prox" || ent.classname === "ammo_tesla")) continue;

    if ((itflags & IT_TYPE_MASK) === (myflags & IT_TYPE_MASK)) count++;
  }

  if (!count) return null;

  const pick = Math.ceil(random() * count);
  count = 0;

  // second pass, pick one.
  for (let i = 0; i < game.num_items; i++) {
    const it = list[i];
    if (it === undefined) continue;
    let itflags = it.flags;

    if (!itflags || itflags & IT_NOT_GIVEABLE) continue;

    // prox,grenades,etc should count as ammo.
    if (itflags & IT_AMMO && itflags & IT_WEAPON) itflags = IT_AMMO;

    if (dmflagsValue & DF_NO_NUKES && ent.classname === "ammo_nuke") continue;

    if (dmflagsValue & DF_NO_MINES && (ent.classname === "ammo_prox" || ent.classname === "ammo_tesla")) continue;

    if ((itflags & IT_TYPE_MASK) === (myflags & IT_TYPE_MASK)) {
      count++;
      if (pick === count) return it.classname;
    }
  }

  return null;
}

//=================
//=================
export function DoRandomRespawn(ent: EdictT): EdictT | null {
  const classname = FindSubstituteItem(ent);
  if (classname === null) return null;

  gi.unlinkentity(ent);

  const newEnt = G_Spawn();
  newEnt.classname = classname;
  VectorCopy(ent.s.origin, newEnt.s.origin);
  VectorCopy(ent.s.old_origin, newEnt.s.old_origin);
  VectorCopy(ent.mins, newEnt.mins);
  VectorCopy(ent.maxs, newEnt.maxs);

  VectorSet(newEnt.gravityVector, 0, 0, -1);

  ED_CallSpawn(newEnt);

  newEnt.s.renderfx |= RF_IR_VISIBLE;

  return newEnt;
}

//=================
//=================
export function PrecacheForRandomRespawn(): void {
  const list = itemlist();
  for (let i = 0; i < game.num_items; i++) {
    const it = list[i];
    if (it === undefined) continue;
    const itflags = it.flags;

    if (!itflags || itflags & IT_NOT_GIVEABLE) continue;

    PrecacheItem(it);
  }
}

// ***************************
//  DOPPLEGANGER
// ***************************

export function doppleganger_die(
  self: EdictT,
  _inflictor: EdictT,
  attacker: EdictT,
  _damage: number,
  _point: Vec3,
): void {
  if (self.enemy !== null && self.enemy !== self.teammaster) {
    const dir = vec3();
    VectorSubtract(self.enemy.s.origin, self.s.origin, dir);
    const dist = VectorLength(dir);

    let sphere: EdictT | null;
    if (dist > 768) {
      sphere = Sphere_Spawn(self, SPHERE_HUNTER | SPHERE_DOPPLEGANGER);
    } else {
      //if(dist > 256)
      sphere = Sphere_Spawn(self, SPHERE_VENGEANCE | SPHERE_DOPPLEGANGER);
    }
    // C calls sphere->pain(...) unconditionally here, with no NULL check.
    if (sphere === null || sphere.pain === null) {
      throw new Error("doppleganger_die: sphere/sphere.pain is null (C dereferences it unconditionally here)");
    }
    sphere.pain(sphere, attacker, 0, 0);
    // else
    //   T_RadiusClassDamage (self, self->teammaster, 175, "doppleganger", 384, MOD_DOPPLE_EXPLODE);
  }

  if (self.teamchain !== null) BecomeExplosion1(self.teamchain);
  BecomeExplosion1(self);
}

export function doppleganger_pain(self: EdictT, other: EdictT, _kick: number, _damage: number): void {
  self.enemy = other;
}

export function doppleganger_timeout(self: EdictT): void {
  // T_RadiusClassDamage (self, self->teammaster, 140, "doppleganger", 256, MOD_DOPPLE_EXPLODE);

  if (self.teamchain !== null) BecomeExplosion1(self.teamchain);
  BecomeExplosion1(self);
}

export function body_think(self: EdictT): void {
  if (Math.abs(self.ideal_yaw - anglemod(self.s.angles[YAW]!)) < 2) {
    if (self.timestamp < level.time) {
      const r = random();
      if (r < 0.1) {
        self.ideal_yaw = random() * 350.0;
        self.timestamp = level.time + 1;
      }
    }
  } else {
    M_ChangeYaw(self);
  }

  self.s.frame++;
  if (self.s.frame > FRAME_stand40) self.s.frame = FRAME_stand01;

  self.nextthink = level.time + 0.1;
}

export function fire_doppleganger(ent: EdictT, start: Vec3, aimdir: Vec3): void {
  const dir = vec3();
  const forward = vec3();
  const right = vec3();
  const up = vec3();

  vectoangles2(aimdir, dir);
  AngleVectors(dir, forward, right, up);

  const base = G_Spawn();
  VectorCopy(start, base.s.origin);
  VectorCopy(dir, base.s.angles);
  VectorClear(base.velocity);
  VectorClear(base.avelocity);
  base.movetype = MovetypeT.MOVETYPE_TOSS;
  base.solid = SolidT.SOLID_BBOX;
  base.s.renderfx |= RF_IR_VISIBLE;
  base.s.angles[PITCH] = 0;
  VectorSet(base.mins, -16, -16, -24);
  VectorSet(base.maxs, 16, 16, 32);
  // base.s.modelindex = gi.modelindex("models/objects/dopplebase/tris.md2");
  base.s.modelindex = 0;
  base.teammaster = ent;
  base.svflags |= SVF_DAMAGEABLE;
  base.takedamage = DamageT.DAMAGE_AIM;
  base.health = 30;
  base.pain = doppleganger_pain;
  base.die = doppleganger_die;

  // FIXME - remove with style
  base.nextthink = level.time + 30;
  base.think = doppleganger_timeout;

  base.classname = "doppleganger";

  gi.linkentity(base);

  const body = G_Spawn();
  const number = body.s.number;
  copyEntityState(ent.s, body.s);
  body.s.sound = 0;
  body.s.event = 0;
  // body.s.modelindex2 = 0; // no attached items (CTF flag, etc)
  body.s.number = number;
  body.yaw_speed = 30;
  body.ideal_yaw = 0;
  VectorCopy(start, body.s.origin);
  body.s.origin[2] += 8;
  body.think = body_think;
  body.nextthink = level.time + FRAMETIME;
  gi.linkentity(body);

  base.teamchain = body;
  body.teammaster = base;
}

// `body->s = ent->s;` is a full entity_state_t struct copy in C -- field by
// field, same treatment as p_client.ts's private copyEntityState (this
// module can't import that private helper, so it gets its own copy per the
// convention already established there).
function copyEntityState(src: EntityStateT, dst: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  VectorCopy(src.old_origin, dst.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.instance_bits = src.instance_bits;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
  dst.owner = src.owner;
  dst.old_frame = src.old_frame;
  dst.morefx = src.morefx;
}

// -------------------------------------------------------------------------
// Savegame function registry -- the doppleganger's edict callbacks (see
// g_save.ts's registerSaveFunction name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction } from "./g_save";

registerSaveFunction("g_newdm:doppleganger_die", doppleganger_die);
registerSaveFunction("g_newdm:doppleganger_pain", doppleganger_pain);
registerSaveFunction("g_newdm:doppleganger_timeout", doppleganger_timeout);
registerSaveFunction("g_newdm:body_think", body_think);
