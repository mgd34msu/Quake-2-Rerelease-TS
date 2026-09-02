// g_newdm.c
// pmack
// june 1998
//
// RERELEASE CONTENT PORT -- the doppelganger decoy (item_doppleganger,
// placed by q2kctf2.bsp), ported from src/rogue/g_newdm.ts (rogue's own
// g_newdm.c) via the same merge src/game/g_newdm.ts performs.
//
// ONLY the doppelganger slice of g_newdm.c is ported. The rest of that file
// -- `InitGameRules` / the `DMGame` dispatch table and the `randomrespawn`
// item-substitution helpers -- selects rogue's alternate deathmatch
// rulesets (RDM_TAG / RDM_DEATHBALL, i.e. dm_tag.c / dm_ball.c). Neither
// ruleset exists in this module (there is no `gamerules` cvar and no
// dm_tag.ts / dm_ball.ts here), and no classname in this module's game dir
// needs them, so porting the table would add a dead dispatch layer that
// nothing could ever populate.
//
// The four spawn-point helpers at the bottom (FindSpawnPoint,
// CheckSpawnPoint, CheckGroundSpawnPoint, SpawnGrow_Spawn) are rogue's, and
// live in rogue/g_spawn.c / rogue/g_monster.c rather than g_newdm.c. They
// are carried HERE rather than added to this module's g_spawn.ts/
// g_monster.ts because the doppelganger is their only consumer in this
// module: rogue's other callers are the medic commander and the carrier's
// monster spawners, which this module does not host.

import {
  anglemod,
  AngleVectors,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCompare,
  VectorCopy,
  VectorLength,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import {
  CONTENTS_PLAYERCLIP,
  CONTENTS_SOLID,
  EF_SPHERETRANS,
  type EntityStateT,
  MASK_MONSTERSOLID,
  MASK_WATER,
  PITCH,
  RF_IR_VISIBLE,
  YAW,
} from "../shared/q_shared";
import { type Edict, SolidT, SVF_DAMAGEABLE } from "./game";
import {
  DamageT,
  type EdictT,
  FRAMETIME,
  g_edicts,
  gi,
  level,
  MovetypeT,
  SPHERE_DOPPLEGANGER,
  SPHERE_HUNTER,
  SPHERE_VENGEANCE,
  world,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { M_ChangeYaw } from "./m_move";
import { FRAME_stand01, FRAME_stand40 } from "./m_player_frames";
import { Sphere_Spawn } from "./g_sphere";
import { G_FreeEdict, G_Spawn, vectoangles2 } from "./g_utils";

// `tr.ent`'s C default is the world edict for a trace that hit nothing;
// this port's GTraceT.ent is `Edict | null`. Same helper as g_weapon.ts's.
function traceEdict(ent: Edict | null): EdictT {
  const e = ent === null ? g_edicts[0] : g_edicts[ent.s.number];
  if (e === undefined) gi.error("g_newdm: trace returned an out-of-range edict");
  return e;
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
// field, same treatment as p_client.ts's private copyEntityState (that one
// is module-private there, so this file gets its own copy per the
// convention already established between those two files).
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

// ****************************
// SPAWN POINT VALIDATION -- rogue/g_spawn.c
// ****************************

// rogue/g_local.h's own `#define STEPSIZE 18`, mirrored here (m_move.ts
// declares its copy module-locally, same as vanilla's m_move.c does).
const STEPSIZE_SPAWN = 18;

// FindSpawnPoint
// PMM - this is used by the medic commander (possibly by the carrier) to
// find a good spawn point if the startpoint is bad, try above the
// startpoint for a bit
export function FindSpawnPoint(startpoint: Vec3, mins: Vec3, maxs: Vec3, spawnpoint: Vec3, maxMoveUp: number): boolean {
  const tr = gi.trace(startpoint, mins, maxs, startpoint, null, MASK_MONSTERSOLID | CONTENTS_PLAYERCLIP);
  if (tr.startsolid || tr.allsolid || traceEdict(tr.ent) !== world()) {
    const top = vec3();
    VectorCopy(startpoint, top);
    top[2] += maxMoveUp;

    const tr2 = gi.trace(top, mins, maxs, startpoint, null, MASK_MONSTERSOLID);
    if (tr2.startsolid || tr2.allsolid) {
      return false;
    }
    VectorCopy(tr2.endpos, spawnpoint);
    return true;
  }
  VectorCopy(startpoint, spawnpoint);
  return true;
}

// FIXME - all of this needs to be tweaked to handle the new gravity rules
// if we ever want to spawn stuff on the roof

// CheckSpawnPoint
// PMM - checks volume to make sure we can spawn a monster there (is it
// solid?) This is all fliers should need
export function CheckSpawnPoint(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  if (VectorCompare(mins, vec3_origin) !== 0 || VectorCompare(maxs, vec3_origin) !== 0) {
    return false;
  }

  const tr = gi.trace(origin, mins, maxs, origin, null, MASK_MONSTERSOLID);
  if (tr.startsolid || tr.allsolid) {
    return false;
  }
  if (traceEdict(tr.ent) !== world()) {
    return false;
  }
  return true;
}

// CheckGroundSpawnPoint
// PMM - used for walking monsters: is there a ground within the specified
// height of the origin, is the ground non-water, and is the ground flat
// enough to walk on?
export function CheckGroundSpawnPoint(
  origin: Vec3,
  entMins: Vec3,
  entMaxs: Vec3,
  height: number,
  gravity: number,
): boolean {
  if (!CheckSpawnPoint(origin, entMins, entMaxs)) return false;

  // FIXME - this is too conservative about angled surfaces
  const stop = vec3();
  VectorCopy(origin, stop);
  // FIXME - gravity vector
  stop[2] = origin[2] + entMins[2] - height;

  let tr = gi.trace(origin, entMins, entMaxs, stop, null, MASK_MONSTERSOLID | MASK_WATER);
  // it's not going to be all solid or start solid, since that's checked above

  if (tr.fraction < 1 && (tr.contents & MASK_MONSTERSOLID) !== 0) {
    // we found a non-water surface down there somewhere. now we need to
    // check to make sure it's not too sloped -- algorithm straight out of
    // m_move.c:M_CheckBottom()

    // first, do the midpoint trace
    const mins = vec3();
    const maxs = vec3();
    VectorAdd(tr.endpos, entMins, mins);
    VectorAdd(tr.endpos, entMaxs, maxs);

    // first, do the easy flat check
    const start = vec3();
    // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
    if (gravity > 0) {
      start[2] = maxs[2] + 1;
    } else {
      start[2] = mins[2] - 1;
    }

    let allSolid = true;
    for (let x = 0; x <= 1 && allSolid; x++) {
      for (let y = 0; y <= 1 && allSolid; y++) {
        start[0] = x !== 0 ? maxs[0] : mins[0];
        start[1] = y !== 0 ? maxs[1] : mins[1];
        if (gi.pointcontents(start) !== CONTENTS_SOLID) allSolid = false;
      }
    }
    if (allSolid) {
      // if it passed all four above checks, we're done
      return true;
    }

    // check it for real
    const start2 = vec3();
    const stop2 = vec3();
    start2[0] = stop2[0] = (mins[0] + maxs[0]) * 0.5;
    start2[1] = stop2[1] = (mins[1] + maxs[1]) * 0.5;
    start2[2] = mins[2];

    tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

    if (tr.fraction === 1) return false;
    let mid: number;
    let bottom: number;

    if (gravity < 0) {
      start2[2] = mins[2];
      stop2[2] = start2[2] - STEPSIZE_SPAWN - STEPSIZE_SPAWN;
      mid = bottom = tr.endpos[2] + entMins[2];
    } else {
      start2[2] = maxs[2];
      stop2[2] = start2[2] + STEPSIZE_SPAWN + STEPSIZE_SPAWN;
      mid = bottom = tr.endpos[2] - entMaxs[2];
    }

    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start2[0] = stop2[0] = x !== 0 ? maxs[0] : mins[0];
        start2[1] = stop2[1] = y !== 0 ? maxs[1] : mins[1];

        tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

        // PGM
        // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
        if (gravity > 0) {
          if (tr.fraction !== 1 && tr.endpos[2] < bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || tr.endpos[2] - mid > STEPSIZE_SPAWN) {
            return false;
          }
        } else {
          if (tr.fraction !== 1 && tr.endpos[2] > bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || mid - tr.endpos[2] > STEPSIZE_SPAWN) {
            return false;
          }
        }
      }
    }

    return true; // we can land on it, it's ok
  }

  // otherwise, it's either water (bad) or not there (too far)
  return false;
}

// ****************************
// SPAWNGROW stuff -- rogue/g_monster.c
// ****************************

const SPAWNGROW_LIFESPAN = 0.3;

function spawngrow_think(self: EdictT): void {
  for (let i = 0; i < 2; i++) {
    self.s.angles[0] = Math.floor(Math.random() * 360);
    self.s.angles[1] = Math.floor(Math.random() * 360);
    self.s.angles[2] = Math.floor(Math.random() * 360);
  }
  if (level.time < self.wait && self.s.frame < 2) self.s.frame++;
  if (level.time >= self.wait) {
    if (self.s.effects & EF_SPHERETRANS) {
      G_FreeEdict(self);
      return;
    } else if (self.s.frame > 0) {
      self.s.frame--;
    } else {
      G_FreeEdict(self);
      return;
    }
  }
  self.nextthink += FRAMETIME;
}

export function SpawnGrow_Spawn(startpos: Vec3, size: number): void {
  const ent = G_Spawn();
  VectorCopy(startpos, ent.s.origin);
  for (let i = 0; i < 2; i++) {
    ent.s.angles[0] = Math.floor(Math.random() * 360);
    ent.s.angles[1] = Math.floor(Math.random() * 360);
    ent.s.angles[2] = Math.floor(Math.random() * 360);
  }
  ent.solid = SolidT.SOLID_NOT;
  ent.s.renderfx = RF_IR_VISIBLE;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.classname = "spawngro";

  let lifespan: number;
  if (size <= 1) {
    lifespan = SPAWNGROW_LIFESPAN;
    ent.s.modelindex = gi.modelindex("models/items/spawngro2/tris.md2");
  } else if (size === 2) {
    ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
    lifespan = 2;
  } else {
    ent.s.modelindex = gi.modelindex("models/items/spawngro/tris.md2");
    lifespan = SPAWNGROW_LIFESPAN;
  }

  ent.think = spawngrow_think;

  ent.wait = level.time + lifespan;
  ent.nextthink = level.time + FRAMETIME;
  if (size !== 2) ent.s.effects |= EF_SPHERETRANS;
  gi.linkentity(ent);
}
