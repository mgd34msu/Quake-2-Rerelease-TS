// g_sphere.c
// pmack
// april 1998
//
// defender - actively finds and shoots at enemies
// hunter - waits until < 25% health and vore ball tracks person who hurt you
// vengeance - kills person who killed you.
//
// The "sam raimi cam" bit in hunter_pain detaches the owning player's view
// from their body and rides the hunter sphere instead (classic EvilDead2
// homage) -- ported as-is, including the commented-out debug prints.

import { VectorClear, VectorCompare, VectorCopy, VectorLength, VectorNormalize, VectorScale, VectorSet, VectorSubtract, vec3, vec3_origin } from "../shared/math";
import type { Vec3 } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_BODY,
  type CplaneT,
  type CsurfaceT,
  DF_FORCE_RESPAWN,
  EF_BLASTER,
  EF_ROCKET,
  EF_TRACKER,
  MASK_SHOT,
  RF_FULLBRIGHT,
  RF_IR_VISIBLE,
  SURF_SKY,
  YAW,
} from "../shared/q_shared";
import { SolidT } from "./game";
import {
  DAMAGE_DESTROY_ARMOR,
  DamageT,
  type EdictT,
  FL_SAM_RAIMI,
  FRAMETIME,
  GIB_ORGANIC,
  gameCvars,
  gi,
  level,
  MOD_DOPPLE_HUNTER,
  MOD_DOPPLE_VENGEANCE,
  MOD_HUNTER_SPHERE,
  MOD_VENGEANCE_SPHERE,
  MovetypeT,
  SPHERE_DEFENDER,
  SPHERE_DOPPLEGANGER,
  SPHERE_HUNTER,
  SPHERE_TYPE,
  SPHERE_VENGEANCE,
  world,
} from "./g_local";
import { visible } from "./g_ai";
import { T_Damage, T_RadiusDamage } from "./g_combat";
import { BecomeExplosion1, ThrowGib } from "./g_misc";
import { LookAtKiller } from "./p_client";
import { M_ChangeYaw } from "./m_move";
import { G_FreeEdict, G_Spawn, vectoangles2 } from "./g_utils";
import { fire_blaster2 } from "./g_newweap";

const DEFENDER_LIFESPAN = 30;
const HUNTER_LIFESPAN = 30;
const VENGEANCE_LIFESPAN = 30;
const MINIMUM_FLY_TIME = 15;

function requireOwner(self: EdictT, what: string): EdictT {
  if (self.owner === null) {
    throw new Error(`${what}: self.owner is null (C dereferences it unconditionally here)`);
  }
  return self.owner;
}

function requireEnemy(self: EdictT, what: string): EdictT {
  if (self.enemy === null) {
    throw new Error(`${what}: self.enemy is null (C dereferences it unconditionally here)`);
  }
  return self.enemy;
}

// *************************
// General Sphere Code
// *************************

export function sphere_think_explode(self: EdictT): void {
  if (self.owner !== null && self.owner.client !== null && !(self.spawnflags & SPHERE_DOPPLEGANGER)) {
    self.owner.client.owned_sphere = null;
  }
  BecomeExplosion1(self);
}

export function sphere_explode(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  _damage: number,
  _point: Vec3,
): void {
  // if(self->owner && self->owner->client)
  //   gi.cprintf(self->owner, PRINT_HIGH, "Sphere timed out\n");
  sphere_think_explode(self);
}

// sphere_if_idle_die - if the sphere is not currently attacking, blow up.
export function sphere_if_idle_die(
  self: EdictT,
  _inflictor: EdictT,
  _attacker: EdictT,
  _damage: number,
  _point: Vec3,
): void {
  if (self.enemy === null) {
    sphere_think_explode(self);
  }
}

// *************************
// Sphere Movement
// *************************

export function sphere_fly(self: EdictT): void {
  if (level.time >= self.wait) {
    sphere_think_explode(self);
    return;
  }

  const owner = requireOwner(self, "sphere_fly");
  const dest = vec3();
  VectorCopy(owner.s.origin, dest);
  dest[2] = owner.absmax[2]! + 4;

  if (level.time === Math.trunc(level.time)) {
    if (!visible(self, owner)) {
      VectorCopy(dest, self.s.origin);
      gi.linkentity(self);
      return;
    }
  }

  const dir = vec3();
  VectorSubtract(dest, self.s.origin, dir);
  VectorScale(dir, 5, self.velocity);
}

export function sphere_chase(self: EdictT, stupidChase: boolean): void {
  const enemy = self.enemy;
  if (level.time >= self.wait || (enemy !== null && enemy.health < 1)) {
    sphere_think_explode(self);
    return;
  }
  const target = requireEnemy(self, "sphere_chase");

  const dest = vec3();
  VectorCopy(target.s.origin, dest);
  if (target.client !== null) dest[2] += target.viewheight;

  const dir = vec3();
  if (visible(self, target) || stupidChase) {
    // if moving, hunter sphere uses active sound
    if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_active.wav");

    VectorSubtract(dest, self.s.origin, dir);
    VectorNormalize(dir);
    vectoangles2(dir, self.s.angles);
    VectorScale(dir, 500, self.velocity);
    VectorCopy(dest, self.monsterinfo.saved_goal);
  } else if (VectorCompare(self.monsterinfo.saved_goal, vec3_origin) !== 0) {
    VectorSubtract(target.s.origin, self.s.origin, dir);
    VectorNormalize(dir);
    vectoangles2(dir, self.s.angles);

    // if lurking, hunter sphere uses lurking sound
    self.s.sound = gi.soundindex("spheres/h_lurk.wav");
    VectorClear(self.velocity);
  } else {
    VectorSubtract(self.monsterinfo.saved_goal, self.s.origin, dir);
    const dist = VectorNormalize(dir);

    if (dist > 1) {
      vectoangles2(dir, self.s.angles);

      if (dist > 500) VectorScale(dir, 500, self.velocity);
      else if (dist < 20) VectorScale(dir, dist / FRAMETIME, self.velocity);
      else VectorScale(dir, dist, self.velocity);

      // if moving, hunter sphere uses active sound
      if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_active.wav");
    } else {
      VectorSubtract(target.s.origin, self.s.origin, dir);
      VectorNormalize(dir);
      vectoangles2(dir, self.s.angles);

      // if not moving, hunter sphere uses lurk sound
      if (!stupidChase) self.s.sound = gi.soundindex("spheres/h_lurk.wav");

      VectorClear(self.velocity);
    }
  }
}

// *************************
// Attack related stuff
// *************************

export function sphere_fire(self: EdictT, enemy: EdictT | null): void {
  if (level.time >= self.wait || enemy === null) {
    sphere_think_explode(self);
    return;
  }

  const dest = vec3();
  VectorCopy(enemy.s.origin, dest);
  self.s.effects |= EF_ROCKET;

  const dir = vec3();
  VectorSubtract(dest, self.s.origin, dir);
  VectorNormalize(dir);
  vectoangles2(dir, self.s.angles);
  VectorScale(dir, 1000, self.velocity);

  self.touch = vengeance_touch;
  self.think = sphere_think_explode;
  self.nextthink = self.wait;
}

export function sphere_touch(
  self: EdictT,
  other: EdictT,
  plane: CplaneT | null,
  surf: CsurfaceT | null,
  mod: number,
): void {
  if (self.spawnflags & SPHERE_DOPPLEGANGER) {
    if (other === self.teammaster) return;

    self.takedamage = DamageT.DAMAGE_NO;
    self.owner = self.teammaster;
    self.teammaster = null;
  } else {
    if (other === self.owner) return;
    // PMM - don't blow up on bodies
    if (other.classname === "bodyque") return;
  }

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self, "sphere_touch");
  if (other.takedamage) {
    if (plane === null) throw new Error("sphere_touch: plane is null (C dereferences plane->normal unconditionally)");
    T_Damage(other, self, owner, self.velocity, self.s.origin, plane.normal, 10000, 1, DAMAGE_DESTROY_ARMOR, mod);
  } else {
    T_RadiusDamage(self, owner, 512, self.owner, 256, mod);
  }

  sphere_think_explode(self);
}

export function vengeance_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (self.spawnflags & SPHERE_DOPPLEGANGER) sphere_touch(self, other, plane, surf, MOD_DOPPLE_VENGEANCE);
  else sphere_touch(self, other, plane, surf, MOD_VENGEANCE_SPHERE);
}

export function hunter_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  // don't blow up if you hit the world.... sheesh.
  if (other === world()) return;

  if (self.owner !== null) {
    // if owner is flying with us, make sure they stop too.
    const owner = self.owner;
    if (owner.flags & FL_SAM_RAIMI) {
      VectorClear(owner.velocity);
      owner.movetype = MovetypeT.MOVETYPE_NONE;
      gi.linkentity(owner);
    }
  }

  if (self.spawnflags & SPHERE_DOPPLEGANGER) sphere_touch(self, other, plane, surf, MOD_DOPPLE_HUNTER);
  else sphere_touch(self, other, plane, surf, MOD_HUNTER_SPHERE);
}

export function defender_shoot(self: EdictT, enemy: EdictT): void {
  if (!enemy.inuse || enemy.health <= 0) return;

  if (enemy === self.owner) return;

  const dir = vec3();
  VectorSubtract(enemy.s.origin, self.s.origin, dir);
  VectorNormalize(dir);

  if (self.monsterinfo.attack_finished > level.time) return;

  // C checks self->enemy here, not the `enemy` parameter -- preserved as-is.
  if (self.enemy === null || !visible(self, self.enemy)) return;

  const start = vec3();
  VectorCopy(self.s.origin, start);
  start[2] += 2;
  fire_blaster2(requireOwner(self, "defender_shoot"), start, dir, 10, 1000, EF_BLASTER, false);

  self.monsterinfo.attack_finished = level.time + 0.4;
}

// *************************
// Activation Related Stuff
// *************************

export function body_gib(self: EdictT): void {
  gi.sound(self, CHAN_BODY, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
  for (let n = 0; n < 4; n++) {
    ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", 50, GIB_ORGANIC);
  }
  ThrowGib(self, "models/objects/gibs/skull/tris.md2", 50, GIB_ORGANIC);
}

export function hunter_pain(self: EdictT, other: EdictT, _kick: number, _damage: number): void {
  if (self.enemy !== null) return;

  const owner = self.owner;

  if (!(self.spawnflags & SPHERE_DOPPLEGANGER)) {
    if (owner !== null && owner.health > 0) return;

    // PMM
    if (other === owner) {
      return;
    }
  } else {
    // if fired by a doppleganger, set it to 10 second timeout
    self.wait = level.time + MINIMUM_FLY_TIME;
  }

  if (self.wait - level.time < MINIMUM_FLY_TIME) self.wait = level.time + MINIMUM_FLY_TIME;
  self.s.effects |= EF_BLASTER | EF_TRACKER;
  self.touch = hunter_touch;
  self.enemy = other;

  // if we're not owned by a player, no sam raimi
  // if we're spawned by a doppleganger, no sam raimi
  if (self.spawnflags & SPHERE_DOPPLEGANGER || !(owner !== null && owner.client !== null)) return;

  // sam raimi cam is disabled if FORCE_RESPAWN is set.
  // sam raimi cam is also disabled if huntercam->value is 0.
  const dmflagsValue = gameCvars.dmflags === null ? 0 : gameCvars.dmflags.value | 0;
  if (!(dmflagsValue & DF_FORCE_RESPAWN) && gameCvars.huntercam !== null && gameCvars.huntercam.value) {
    const dir = vec3();
    VectorSubtract(other.s.origin, self.s.origin, dir);
    const dist = VectorLength(dir);

    if (owner !== null && dist >= 192) {
      // detach owner from body and send him flying
      owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;

      // gib like we just died, even though we didn't, really.
      body_gib(owner);

      // move the sphere to the owner's current viewpoint.
      // we know it's a valid spot (or will be momentarily)
      VectorCopy(owner.s.origin, self.s.origin);
      self.s.origin[2] += owner.viewheight;

      // move the player's origin to the sphere's new origin
      VectorCopy(self.s.origin, owner.s.origin);
      VectorCopy(self.s.angles, owner.s.angles);
      const ownerClient = owner.client;
      if (ownerClient === null) throw new Error("hunter_pain: owner.client is null (C dereferences it unconditionally)");
      VectorCopy(self.s.angles, ownerClient.v_angle);
      VectorClear(owner.mins);
      VectorClear(owner.maxs);
      VectorSet(owner.mins, -5, -5, -5);
      VectorSet(owner.maxs, 5, 5, 5);
      ownerClient.ps.fov = 140;
      owner.s.modelindex = 0;
      owner.s.modelindex2 = 0;
      owner.viewheight = 8;
      owner.solid = SolidT.SOLID_NOT;
      owner.flags |= FL_SAM_RAIMI;
      gi.linkentity(owner);

      // PMM - set bounding box so we don't clip out of world
      self.solid = SolidT.SOLID_BBOX;
      gi.linkentity(self);
    }
    // else
    //   gi.dprintf("too close for sam raimi cam\n");
  }
}

export function defender_pain(self: EdictT, other: EdictT, _kick: number, _damage: number): void {
  // PMM
  if (other === self.owner) {
    return;
  }
  self.enemy = other;
}

export function vengeance_pain(self: EdictT, other: EdictT, _kick: number, _damage: number): void {
  if (self.enemy !== null) return;

  if (!(self.spawnflags & SPHERE_DOPPLEGANGER)) {
    const owner = requireOwner(self, "vengeance_pain");
    if (owner.health >= 25) return;

    // PMM
    if (other === owner) {
      return;
    }
  } else {
    self.wait = level.time + MINIMUM_FLY_TIME;
  }

  if (self.wait - level.time < MINIMUM_FLY_TIME) self.wait = level.time + MINIMUM_FLY_TIME;
  self.s.effects |= EF_ROCKET;
  self.touch = vengeance_touch;
  self.enemy = other;
}

// *************************
// Think Functions
// *************************

export function defender_think(self: EdictT): void {
  if (self.owner === null) {
    G_FreeEdict(self);
    return;
  }

  // if we've exited the level, just remove ourselves.
  if (level.intermissiontime) {
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
    if (self.enemy.health > 0) {
      defender_shoot(self, self.enemy);
    } else {
      self.enemy = null;
    }
  }
  // else {
  //   self->ideal_yaw += 3;
  //   M_ChangeYaw(self);
  // }

  sphere_fly(self);

  if (self.inuse) self.nextthink = level.time + 0.1;
}

export function hunter_think(self: EdictT): void {
  // if we've exited the level, just remove ourselves.
  if (level.intermissiontime) {
    sphere_think_explode(self);
    return;
  }

  const owner = self.owner;
  if (owner === null && !(self.spawnflags & SPHERE_DOPPLEGANGER)) {
    G_FreeEdict(self);
    return;
  }

  if (owner !== null) {
    self.ideal_yaw = owner.s.angles[YAW]!;
  } else if (self.enemy !== null) {
    // fired by doppleganger
    const dir = vec3();
    VectorSubtract(self.enemy.s.origin, self.s.origin, dir);
    const ang = vec3();
    vectoangles2(dir, ang);
    self.ideal_yaw = ang[YAW]!;
  }

  M_ChangeYaw(self);

  if (self.enemy !== null) {
    sphere_chase(self, false);

    // deal with sam raimi cam
    if (owner !== null && owner.flags & FL_SAM_RAIMI) {
      if (self.inuse) {
        owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
        LookAtKiller(owner, self, self.enemy);
        // owner is flying with us, move him too
        owner.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
        owner.viewheight = self.s.origin[2]! - owner.s.origin[2]!;
        VectorCopy(self.s.origin, owner.s.origin);
        VectorCopy(self.velocity, owner.velocity);
        VectorClear(owner.mins);
        VectorClear(owner.maxs);
        gi.linkentity(owner);
      } else {
        // sphere timed out
        VectorClear(owner.velocity);
        owner.movetype = MovetypeT.MOVETYPE_NONE;
        gi.linkentity(owner);
      }
    }
  } else {
    sphere_fly(self);
  }

  if (self.inuse) self.nextthink = level.time + 0.1;
}

export function vengeance_think(self: EdictT): void {
  // if we've exited the level, just remove ourselves.
  if (level.intermissiontime) {
    sphere_think_explode(self);
    return;
  }

  if (self.owner === null && !(self.spawnflags & SPHERE_DOPPLEGANGER)) {
    G_FreeEdict(self);
    return;
  }

  if (self.enemy !== null) {
    // sphere_fire(self, self.owner.enemy);
    sphere_chase(self, true);
  } else {
    sphere_fly(self);
  }

  if (self.inuse) self.nextthink = level.time + 0.1;
}

// *************************
// Spawning / Creation
// *************************

export function Sphere_Spawn(owner: EdictT, spawnflags: number): EdictT | null {
  const sphere = G_Spawn();
  VectorCopy(owner.s.origin, sphere.s.origin);
  sphere.s.origin[2] = owner.absmax[2]!;
  sphere.s.angles[YAW] = owner.s.angles[YAW]!;
  sphere.solid = SolidT.SOLID_BBOX;
  sphere.clipmask = MASK_SHOT;
  sphere.s.renderfx = RF_FULLBRIGHT | RF_IR_VISIBLE;
  sphere.movetype = MovetypeT.MOVETYPE_FLYMISSILE;

  if (spawnflags & SPHERE_DOPPLEGANGER) sphere.teammaster = owner.teammaster;
  else sphere.owner = owner;

  sphere.classname = "sphere";
  sphere.yaw_speed = 40;
  sphere.monsterinfo.attack_finished = 0;
  sphere.spawnflags = spawnflags; // need this for the HUD to recognize sphere
  //PMM
  sphere.takedamage = DamageT.DAMAGE_NO;

  switch (spawnflags & SPHERE_TYPE) {
    case SPHERE_DEFENDER:
      sphere.s.modelindex = gi.modelindex("models/items/defender/tris.md2");
      // PMM - this doesn't work, causes problems with other stuff
      // sphere.s.modelindex2 = gi.modelindex("models/items/shell/tris.md2") | 0x80;
      sphere.s.modelindex2 = gi.modelindex("models/items/shell/tris.md2");
      sphere.s.sound = gi.soundindex("spheres/d_idle.wav");
      sphere.pain = defender_pain;
      sphere.wait = level.time + DEFENDER_LIFESPAN;
      sphere.die = sphere_explode;
      sphere.think = defender_think;
      break;
    case SPHERE_HUNTER:
      sphere.s.modelindex = gi.modelindex("models/items/hunter/tris.md2");
      sphere.s.sound = gi.soundindex("spheres/h_idle.wav");
      sphere.wait = level.time + HUNTER_LIFESPAN;
      sphere.pain = hunter_pain;
      sphere.die = sphere_if_idle_die;
      sphere.think = hunter_think;
      break;
    case SPHERE_VENGEANCE:
      sphere.s.modelindex = gi.modelindex("models/items/vengnce/tris.md2");
      sphere.s.sound = gi.soundindex("spheres/v_idle.wav");
      sphere.wait = level.time + VENGEANCE_LIFESPAN;
      sphere.pain = vengeance_pain;
      sphere.die = sphere_if_idle_die;
      sphere.think = vengeance_think;
      VectorSet(sphere.avelocity, 30, 30, 0);
      break;
    default:
      gi.dprintf("Tried to create an invalid sphere\n");
      G_FreeEdict(sphere);
      return null;
  }

  sphere.nextthink = level.time + 0.1;

  gi.linkentity(sphere);

  return sphere;
}

// Own_Sphere - attach the sphere to the client so we can
//		directly access it later
export function Own_Sphere(self: EdictT, sphere: EdictT | null): void {
  if (sphere === null) return;

  // ownership only for players
  if (self.client !== null) {
    // if they don't have one
    if (self.client.owned_sphere === null) {
      self.client.owned_sphere = sphere;
    }
    // they already have one, take care of the old one
    else {
      if (self.client.owned_sphere.inuse) {
        G_FreeEdict(self.client.owned_sphere);
        self.client.owned_sphere = sphere;
      } else {
        self.client.owned_sphere = sphere;
      }
    }
  }
}

export function Defender_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_DEFENDER);
  Own_Sphere(self, sphere);
}

export function Hunter_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_HUNTER);
  Own_Sphere(self, sphere);
}

export function Vengeance_Launch(self: EdictT): void {
  const sphere = Sphere_Spawn(self, SPHERE_VENGEANCE);
  Own_Sphere(self, sphere);
}

// -------------------------------------------------------------------------
// Savegame function registry -- registered from g_save.ts's
// populateSaveRegistry() rather than at this file's top level; see the note
// at the bottom of g_newweap.ts for the module-initialization cycle that
// forces it.
// -------------------------------------------------------------------------
