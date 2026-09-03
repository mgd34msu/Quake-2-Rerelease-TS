// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
// Ported from rogue/m_turret.c (GNU GPL v2 or later).
/*
==============================================================================

TURRET

==============================================================================
*/
//
// The stationary wall-mounted turret. Unlike every other monster in this
// pack it has no locomotion state machine at all -- ai_walk/ai_run here only
// drive the aim-and-ready animation, the entity itself never calls
// M_walkmove/M_MoveToGoal (it never uses m_move2.ts), and
// monsterinfo.aiflags carries AI_MANUAL_STEERING so the generic AI code
// never tries to path it around. `stationarymonster_start` (rogue's own
// g_monster.c addition, not present in baseq2) is the spawn helper that
// replaces walkmonster_start/flymonster_start for this entity.
//
// SPAWN_HEATBEAM is #define'd (0x0040, aliased into SPAWN_WEAPONCHOICE) but
// SP_monster_turret unconditionally converts it to SPAWN_BLASTER before any
// other logic runs (`self->spawnflags &= ~SPAWN_HEATBEAM; self->spawnflags
// |= SPAWN_BLASTER;`) -- the shipped rogue turret can never actually fire a
// heatbeam, so no monster_fire_heat call exists anywhere in this file. This
// matches the original C exactly; it is not a deviation introduced by the
// port.

import {
  AngleVectors,
  anglemod,
  DotProduct,
  random,
  vec3,
  vec3_origin,
  VectorCompare,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
  type Vec3,
} from "../shared/math";
import {
  ATTN_NORM,
  CHAN_VOICE,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WINDOW,
  type CvarT,
  EF_BLASTER,
  MASK_SHOT,
  MulticastT,
  MZ2_TURRET_BLASTER,
  MZ2_TURRET_MACHINEGUN,
  MZ2_TURRET_ROCKET,
  PITCH,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import { ai_run, ai_stand, ai_walk, FindTarget, range, visible } from "./g_ai";
import { Move_Calc } from "./g_func";
import {
  AI_DO_NOT_COUNT,
  AI_GOOD_GUY,
  AI_IGNORE_SHOTS,
  AI_MANUAL_STEERING,
  AS_BLIND,
  AS_MISSILE,
  AS_STRAIGHT,
  DamageT,
  type EdictT,
  FL_MECHANICAL,
  FL_TEAMSLAVE,
  g_edicts,
  gameCvars,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_MELEE,
  svc_temp_entity,
  world,
} from "./g_local";
import { type Edict, SolidT, SVF_MONSTER } from "./game";
import { ThrowDebris } from "./g_misc";
import { monster_fire_blaster, monster_fire_bullet, monster_fire_rocket, stationarymonster_start } from "./g_monster";
import { vectoangles2 } from "./g_newai";
import { G_FreeEdict, G_Spawn, G_UseTargets } from "./g_utils";
import * as F from "./m_turret_frames";

// trace_t.ent recovery idiom (see g_monster.ts's/g_ai.ts's own copy):
// sv_world.c defaults an unset trace.ent to the world edict, never NULL, so
// a null GTraceT.ent here falls back to g_edicts[0] the same way.
// Module-local per PORTING.md.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// m_turret.c's own #defines -- local to this file, not shared with any
// sibling (per the coordinator's brief).
const SPAWN_BLASTER = 0x0008;
const SPAWN_MACHINEGUN = 0x0010;
const SPAWN_ROCKET = 0x0020;
const SPAWN_HEATBEAM = 0x0040;
const SPAWN_WEAPONCHOICE = 0x0078;
const SPAWN_INSTANT_WEAPON = 0x0050;
const SPAWN_WALL_UNIT = 0x0080;

// mirrors g_monster.ts's own module-local `cvarNum` (not reusable outside
// this file's SCOPE, per the established house pattern -- see m_gladiator.ts).
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function mf(
  aifunc: ((self: EdictT, dist: number) => void) | null,
  dist: number,
  thinkfunc: ((self: EdictT) => void) | null = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function TurretAim(self: EdictT): void {
  const end = vec3();
  const dir = vec3();
  const ang = vec3();
  let move: number;
  let idealPitch: number;
  let idealYaw: number;
  let current: number;
  let speed: number;

  // gi.dprintf("turret_aim: %d %d\n", self->s.frame, self->monsterinfo.nextframe);

  if (self.enemy === null || self.enemy === world()) {
    if (!FindTarget(self)) return;
  }
  if (self.enemy === null) return; // C trusts FindTarget's post-condition here
  const enemy = self.enemy;

  // if turret is still in inactive mode, ready the gun, but don't aim
  if (self.s.frame < F.FRAME_active01) {
    turret_ready_gun(self);
    return;
  }
  // if turret is still readying, don't aim.
  if (self.s.frame < F.FRAME_run01) return;

  // PMM - blindfire aiming here
  if (self.monsterinfo.currentmove === turret_move_fire_blind) {
    VectorCopy(self.monsterinfo.blind_fire_target, end);
    if (enemy.s.origin[2] < self.monsterinfo.blind_fire_target[2]) end[2] += enemy.viewheight + 10;
    else end[2] += enemy.mins[2] - 10;
  } else {
    VectorCopy(enemy.s.origin, end);
    if (enemy.client !== null) end[2] += enemy.viewheight;
  }

  VectorSubtract(end, self.s.origin, dir);
  vectoangles2(dir, ang);

  //
  // Clamp first
  //

  idealPitch = ang[PITCH];
  idealYaw = ang[YAW];

  // C: `int orientation; orientation = self->offset[1];` truncates the
  // float offset component to int.
  const orientation = self.offset[1] | 0;
  switch (orientation) {
    case -1: // up		pitch: 0 to 90
      if (idealPitch < -90) idealPitch += 360;
      if (idealPitch > -5) idealPitch = -5;
      break;
    case -2: // down		pitch: -180 to -360
      if (idealPitch > -90) idealPitch -= 360;
      if (idealPitch < -355) idealPitch = -355;
      else if (idealPitch > -185) idealPitch = -185;
      break;
    case 0: // +X		pitch: 0 to -90, -270 to -360 (or 0 to 90)
      if (idealPitch < -180) idealPitch += 360;

      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;

      //			yaw: 270 to 360, 0 to 90
      //			yaw: -90 to 90 (270-360 == -90-0)
      if (idealYaw > 180) idealYaw -= 360;
      if (idealYaw > 85) idealYaw = 85;
      else if (idealYaw < -85) idealYaw = -85;
      break;
    case 90: // +Y	pitch: 0 to 90, -270 to -360 (or 0 to 90)
      if (idealPitch < -180) idealPitch += 360;

      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;

      //			yaw: 0 to 180
      if (idealYaw > 270) idealYaw -= 360;
      if (idealYaw > 175) idealYaw = 175;
      else if (idealYaw < 5) idealYaw = 5;

      break;
    case 180: // -X	pitch: 0 to 90, -270 to -360 (or 0 to 90)
      if (idealPitch < -180) idealPitch += 360;

      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;

      //			yaw: 90 to 270
      if (idealYaw > 265) idealYaw = 265;
      else if (idealYaw < 95) idealYaw = 95;

      break;
    case 270: // -Y	pitch: 0 to 90, -270 to -360 (or 0 to 90)
      if (idealPitch < -180) idealPitch += 360;

      if (idealPitch > 85) idealPitch = 85;
      else if (idealPitch < -85) idealPitch = -85;

      //			yaw: 180 to 360
      if (idealYaw < 90) idealYaw += 360;
      if (idealYaw > 355) idealYaw = 355;
      else if (idealYaw < 185) idealYaw = 185;
      break;
    default:
      break;
  }

  //
  // adjust pitch
  //
  current = self.s.angles[PITCH];
  speed = self.yaw_speed;

  if (idealPitch !== current) {
    move = idealPitch - current;

    while (move >= 360) move -= 360;
    if (move >= 90) {
      move = move - 360;
    }

    while (move <= -360) move += 360;
    if (move <= -90) {
      move = move + 360;
    }

    if (move > 0) {
      if (move > speed) move = speed;
    } else {
      if (move < -speed) move = -speed;
    }

    self.s.angles[PITCH] = anglemod(current + move);
  }

  //
  // adjust yaw
  //
  current = self.s.angles[YAW];
  speed = self.yaw_speed;

  if (idealYaw !== current) {
    move = idealYaw - current;

    //		while(move >= 360)
    //			move -= 360;
    if (move >= 180) {
      move = move - 360;
    }

    //		while(move <= -360)
    //			move += 360;
    if (move <= -180) {
      move = move + 360;
    }

    if (move > 0) {
      if (move > speed) move = speed;
    } else {
      if (move < -speed) move = -speed;
    }

    self.s.angles[YAW] = anglemod(current + move);
  }
}

function turret_sight(_self: EdictT, _other: EdictT): void {}

function turret_search(_self: EdictT): void {}

const turret_frames_stand: MframeT[] = [mf(ai_stand, 0, null), mf(ai_stand, 0, null)];
const turret_move_stand = new MmoveT();
turret_move_stand.firstframe = F.FRAME_stand01;
turret_move_stand.lastframe = F.FRAME_stand02;
turret_move_stand.frame = turret_frames_stand;
turret_move_stand.endfunc = null;

function turret_stand(self: EdictT): void {
  // gi.dprintf("turret_stand\n");
  self.monsterinfo.currentmove = turret_move_stand;
}

const turret_frames_ready_gun: MframeT[] = [
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),

  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),
  mf(ai_stand, 0, null),

  mf(ai_stand, 0, null),
];
const turret_move_ready_gun = new MmoveT();
turret_move_ready_gun.firstframe = F.FRAME_active01;
turret_move_ready_gun.lastframe = F.FRAME_run01;
turret_move_ready_gun.frame = turret_frames_ready_gun;
turret_move_ready_gun.endfunc = turret_run;

function turret_ready_gun(self: EdictT): void {
  self.monsterinfo.currentmove = turret_move_ready_gun;
}

const turret_frames_seek: MframeT[] = [mf(ai_walk, 0, TurretAim), mf(ai_walk, 0, TurretAim)];
const turret_move_seek = new MmoveT();
turret_move_seek.firstframe = F.FRAME_run01;
turret_move_seek.lastframe = F.FRAME_run02;
turret_move_seek.frame = turret_frames_seek;
turret_move_seek.endfunc = null;

function turret_walk(self: EdictT): void {
  if (self.s.frame < F.FRAME_run01) turret_ready_gun(self);
  else self.monsterinfo.currentmove = turret_move_seek;
}

const turret_frames_run: MframeT[] = [mf(ai_run, 0, TurretAim), mf(ai_run, 0, TurretAim)];
const turret_move_run = new MmoveT();
turret_move_run.firstframe = F.FRAME_run01;
turret_move_run.lastframe = F.FRAME_run02;
turret_move_run.frame = turret_frames_run;
turret_move_run.endfunc = turret_run;

function turret_run(self: EdictT): void {
  if (self.s.frame < F.FRAME_run01) turret_ready_gun(self);
  else self.monsterinfo.currentmove = turret_move_run;
}

// **********************
//  ATTACK
// **********************

const TURRET_BULLET_DAMAGE = 4;
// Ported for C fidelity even though it is never referenced anywhere in this
// file -- SPAWN_HEATBEAM is unconditionally converted to SPAWN_BLASTER in
// SP_monster_turret (see the file header comment), so the heat-beam damage
// constant is dead in the shipped C source too.
const TURRET_HEAT_DAMAGE = 4;
void TURRET_HEAT_DAMAGE;

function TurretFire(self: EdictT): void {
  const forward = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();
  let time: number;
  let dist: number;
  let chance: number;
  let rocketSpeed = 0;

  TurretAim(self);

  if (self.enemy === null || !self.enemy.inuse) return;
  const enemy = self.enemy;

  VectorSubtract(enemy.s.origin, self.s.origin, dir);
  VectorNormalize(dir);
  AngleVectors(self.s.angles, forward, null, null);
  chance = DotProduct(dir, forward);
  if (chance < 0.98) {
    // gi.dprintf("off-angle\n");
    return;
  }

  chance = random();

  // rockets fire less often than the others do.
  if (self.spawnflags & SPAWN_ROCKET) {
    chance = chance * 3;

    rocketSpeed = 550;
    if (cvarNum(gameCvars.skill) === 2) {
      rocketSpeed += 200 * random();
    } else if (cvarNum(gameCvars.skill) === 3) {
      rocketSpeed += 100 + 200 * random();
    }
  } else if (self.spawnflags & SPAWN_BLASTER) {
    if (cvarNum(gameCvars.skill) === 0) rocketSpeed = 600;
    else if (cvarNum(gameCvars.skill) === 1) rocketSpeed = 800;
    else rocketSpeed = 1000;
    chance = chance * 2;
  }

  // up the fire chance 20% per skill level.
  chance = chance - 0.2 * cvarNum(gameCvars.skill);

  if (/*chance < 0.5 && */ visible(self, enemy)) {
    VectorCopy(self.s.origin, start);
    VectorCopy(enemy.s.origin, end);

    // aim for the head.
    if (enemy.client !== null) end[2] += enemy.viewheight;
    else end[2] += 22;

    VectorSubtract(end, start, dir);
    dist = VectorLength(dir);

    // check for predictive fire if distance less than 512
    if (!(self.spawnflags & SPAWN_INSTANT_WEAPON) && dist < 512) {
      chance = random();
      // ramp chance. easy - 50%, avg - 60%, hard - 70%, nightmare - 80%
      chance += (3 - cvarNum(gameCvars.skill)) * 0.1;
      if (chance < 0.8) {
        // lead the target....
        time = dist / 1000;
        VectorMA(end, time, enemy.velocity, end);
        VectorSubtract(end, start, dir);
      }
    }

    VectorNormalize(dir);
    const trace = gi.trace(start, vec3_origin, vec3_origin, end, self, MASK_SHOT);
    if (traceEdict(trace.ent) === enemy || traceEdict(trace.ent) === world()) {
      if (self.spawnflags & SPAWN_BLASTER) {
        monster_fire_blaster(self, start, dir, 20, rocketSpeed, MZ2_TURRET_BLASTER, EF_BLASTER);
      } else if (self.spawnflags & SPAWN_MACHINEGUN) {
        monster_fire_bullet(
          self,
          start,
          dir,
          TURRET_BULLET_DAMAGE,
          0,
          DEFAULT_BULLET_HSPREAD,
          DEFAULT_BULLET_VSPREAD,
          MZ2_TURRET_MACHINEGUN,
        );
      } else if (self.spawnflags & SPAWN_ROCKET) {
        if (dist * trace.fraction > 72) {
          monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_TURRET_ROCKET);
        }
      }
    }
  }
}

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD (each monster/weapon module
// keeps its own copy -- see m_gunner.ts/m_soldier.ts/p_weapon.ts's identical
// comment).
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

// PMM
function TurretFireBlind(self: EdictT): void {
  const forward = vec3();
  const start = vec3();
  const end = vec3();
  const dir = vec3();
  let dist: number;
  let chance: number;
  let rocketSpeed = 0;

  TurretAim(self);

  if (self.enemy === null || !self.enemy.inuse) return;
  const enemy = self.enemy;

  VectorSubtract(self.monsterinfo.blind_fire_target, self.s.origin, dir);
  VectorNormalize(dir);
  AngleVectors(self.s.angles, forward, null, null);
  chance = DotProduct(dir, forward);
  if (chance < 0.98) {
    // gi.dprintf("off-angle\n");
    return;
  }

  if (self.spawnflags & SPAWN_ROCKET) {
    rocketSpeed = 550;
    if (cvarNum(gameCvars.skill) === 2) {
      rocketSpeed += 200 * random();
    } else if (cvarNum(gameCvars.skill) === 3) {
      rocketSpeed += 100 + 200 * random();
    }
  }

  VectorCopy(self.s.origin, start);
  VectorCopy(self.monsterinfo.blind_fire_target, end);

  if (enemy.s.origin[2] < self.monsterinfo.blind_fire_target[2]) end[2] += enemy.viewheight + 10;
  else end[2] += enemy.mins[2] - 10;

  VectorSubtract(end, start, dir);
  dist = VectorLength(dir);
  void dist; // C: computed but never referenced afterward (dead store in the original too)

  VectorNormalize(dir);

  if (self.spawnflags & SPAWN_BLASTER) monster_fire_blaster(self, start, dir, 20, 1000, MZ2_TURRET_BLASTER, EF_BLASTER);
  else if (self.spawnflags & SPAWN_ROCKET) monster_fire_rocket(self, start, dir, 50, rocketSpeed, MZ2_TURRET_ROCKET);
}
//pmm

const turret_frames_fire: MframeT[] = [
  mf(ai_run, 0, TurretFire),
  mf(ai_run, 0, TurretAim),
  mf(ai_run, 0, TurretAim),
  mf(ai_run, 0, TurretAim),
];
const turret_move_fire = new MmoveT();
turret_move_fire.firstframe = F.FRAME_pow01;
turret_move_fire.lastframe = F.FRAME_pow04;
turret_move_fire.frame = turret_frames_fire;
turret_move_fire.endfunc = turret_run;

//PMM

// the blind frames need to aim first
const turret_frames_fire_blind: MframeT[] = [
  mf(ai_run, 0, TurretAim),
  mf(ai_run, 0, TurretAim),
  mf(ai_run, 0, TurretAim),
  mf(ai_run, 0, TurretFireBlind),
];
const turret_move_fire_blind = new MmoveT();
turret_move_fire_blind.firstframe = F.FRAME_pow01;
turret_move_fire_blind.lastframe = F.FRAME_pow04;
turret_move_fire_blind.frame = turret_frames_fire_blind;
turret_move_fire_blind.endfunc = turret_run;
//pmm

function turret_attack(self: EdictT): void {
  let r: number;
  let chance: number;

  if (self.s.frame < F.FRAME_run01) {
    turret_ready_gun(self);
    // PMM
  } else if (self.monsterinfo.attack_state !== AS_BLIND) {
    self.monsterinfo.nextframe = F.FRAME_pow01;
    self.monsterinfo.currentmove = turret_move_fire;
  } else {
    // setup shot probabilities
    if (self.monsterinfo.blind_fire_delay < 1.0) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < 7.5) chance = 0.4;
    else chance = 0.1;

    r = random();

    // minimum of 3 seconds, plus 0-4, after the shots are done - total time should be max less than 7.5
    self.monsterinfo.blind_fire_delay += 0.4 + 3.0 + random() * 4.0;
    // don't shoot at the origin
    if (VectorCompare(self.monsterinfo.blind_fire_target, vec3_origin) !== 0) return;

    // don't shoot if the dice say not to
    if (r > chance) return;

    self.monsterinfo.nextframe = F.FRAME_pow01;
    self.monsterinfo.currentmove = turret_move_fire_blind;
  }
  // pmm
}

// **********************
//  PAIN
// **********************

function turret_pain(_self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  return;
}

// **********************
//  DEATH
// **********************

function turret_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  const forward = vec3();
  const start = vec3();

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_PLAIN_EXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PHS);

  AngleVectors(self.s.angles, forward, null, null);
  VectorMA(self.s.origin, 1, forward, start);

  ThrowDebris(self, "models/objects/debris1/tris.md2", 1, start);
  ThrowDebris(self, "models/objects/debris1/tris.md2", 2, start);
  ThrowDebris(self, "models/objects/debris1/tris.md2", 1, start);
  ThrowDebris(self, "models/objects/debris1/tris.md2", 2, start);

  if (self.teamchain !== null) {
    const base = self.teamchain;
    base.solid = SolidT.SOLID_BBOX;
    base.takedamage = DamageT.DAMAGE_NO;
    base.movetype = MovetypeT.MOVETYPE_NONE;
    gi.linkentity(base);
  }

  if (self.target !== null) {
    if (self.enemy !== null && self.enemy.inuse) G_UseTargets(self, self.enemy);
    else G_UseTargets(self, self);
  }

  G_FreeEdict(self);
}

// **********************
//  WALL SPAWN
// **********************

function turret_wall_spawn(turret: EdictT): void {
  const ent = G_Spawn();
  VectorCopy(turret.s.origin, ent.s.origin);
  VectorCopy(turret.s.angles, ent.s.angles);

  // C: `int angle; angle = ent->s.angles[1];` truncates the float to int.
  let angle = ent.s.angles[1] | 0;
  if (ent.s.angles[0] === 90) angle = -1;
  else if (ent.s.angles[0] === 270) angle = -2;
  switch (angle) {
    case -1:
      VectorSet(ent.mins, -16, -16, -8);
      VectorSet(ent.maxs, 16, 16, 0);
      break;
    case -2:
      VectorSet(ent.mins, -16, -16, 0);
      VectorSet(ent.maxs, 16, 16, 8);
      break;
    case 0:
      VectorSet(ent.mins, -8, -16, -16);
      VectorSet(ent.maxs, 0, 16, 16);
      break;
    case 90:
      VectorSet(ent.mins, -16, -8, -16);
      VectorSet(ent.maxs, 16, 0, 16);
      break;
    case 180:
      VectorSet(ent.mins, 0, -16, -16);
      VectorSet(ent.maxs, 8, 16, 16);
      break;
    case 270:
      VectorSet(ent.mins, -16, 0, -16);
      VectorSet(ent.maxs, 16, 8, 16);
      break;
    default:
      break;
  }

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;

  ent.teammaster = turret;
  turret.teammaster = turret;
  turret.teamchain = ent;
  ent.teamchain = null;
  ent.flags |= FL_TEAMSLAVE;
  ent.owner = turret;

  ent.s.modelindex = gi.modelindex("models/monsters/turretbase/tris.md2");

  gi.linkentity(ent);
}

function turret_wake(self: EdictT): void {
  // the wall section will call this when it stops moving.
  // just return without doing anything. easiest way to have a null function.
  if (self.flags & FL_TEAMSLAVE) {
    return;
  }

  self.monsterinfo.stand = turret_stand;
  self.monsterinfo.walk = turret_walk;
  self.monsterinfo.run = turret_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = turret_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = turret_sight;
  self.monsterinfo.search = turret_search;
  self.monsterinfo.currentmove = turret_move_stand;
  self.takedamage = DamageT.DAMAGE_AIM;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  // prevent counting twice
  self.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

  gi.linkentity(self);

  stationarymonster_start(self);

  if (self.spawnflags & SPAWN_MACHINEGUN) {
    self.s.skinnum = 1;
  } else if (self.spawnflags & SPAWN_ROCKET) {
    self.s.skinnum = 2;
  }

  // but we do want the death to count
  self.monsterinfo.aiflags &= ~AI_DO_NOT_COUNT;
}

function turret_activate(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const endpos = vec3();
  const forward = vec3();

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (!self.speed) self.speed = 15;
  self.moveinfo.speed = self.speed;
  self.moveinfo.accel = self.speed;
  self.moveinfo.decel = self.speed;

  if (self.s.angles[0] === 270) {
    VectorSet(forward, 0, 0, 1);
  } else if (self.s.angles[0] === 90) {
    VectorSet(forward, 0, 0, -1);
  } else if (self.s.angles[1] === 0) {
    VectorSet(forward, 1, 0, 0);
  } else if (self.s.angles[1] === 90) {
    VectorSet(forward, 0, 1, 0);
  } else if (self.s.angles[1] === 180) {
    VectorSet(forward, -1, 0, 0);
  } else if (self.s.angles[1] === 270) {
    VectorSet(forward, 0, -1, 0);
  }

  // start up the turret
  VectorMA(self.s.origin, 32, forward, endpos);
  Move_Calc(self, endpos, turret_wake);

  const base = self.teamchain;
  if (base !== null) {
    base.movetype = MovetypeT.MOVETYPE_PUSH;
    base.speed = self.speed;
    base.moveinfo.speed = base.speed;
    base.moveinfo.accel = base.speed;
    base.moveinfo.decel = base.speed;

    // start up the wall section
    VectorMA(base.s.origin, 32, forward, endpos);
    Move_Calc(base, endpos, turret_wake);
  }

  gi.sound(self, CHAN_VOICE, gi.soundindex("world/dr_short.wav"), 1, ATTN_NORM, 0);
}

// PMM
// checkattack .. ignore range, just attack if available
function turret_checkattack(self: EdictT): boolean {
  const spot1 = vec3();
  const spot2 = vec3();
  let chance: number;
  let nexttime: number;

  if (self.enemy === null) return false; // C dereferences self->enemy unconditionally here
  const enemy = self.enemy;

  if (enemy.health > 0) {
    // see if any entities are in the way of the shot
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    VectorCopy(enemy.s.origin, spot2);
    spot2[2] += enemy.viewheight;

    let tr = gi.trace(
      spot1,
      null,
      null,
      spot2,
      self,
      CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA | CONTENTS_WINDOW,
    );

    // do we have a clear shot?
    if (traceEdict(tr.ent) !== enemy) {
      // PGM - we want them to go ahead and shoot at info_notnulls if they can.
      if (enemy.solid !== SolidT.SOLID_NOT || tr.fraction < 1.0) {
        // PMM - if we can't see our target, and we're not blocked by a monster, go into blind fire if available
        if (tr.ent !== null && !(tr.ent.svflags & SVF_MONSTER) && !visible(self, enemy)) {
          if (self.monsterinfo.blindfire && self.monsterinfo.blind_fire_delay <= 10.0) {
            if (level.time < self.monsterinfo.attack_finished) {
              return false;
            }
            if (level.time < self.monsterinfo.trail_time + self.monsterinfo.blind_fire_delay) {
              // wait for our time
              return false;
            } else {
              // make sure we're not going to shoot something we don't want to shoot
              tr = gi.trace(spot1, null, null, self.monsterinfo.blind_fire_target, self, CONTENTS_MONSTER);
              if (tr.allsolid || tr.startsolid || (tr.fraction < 1.0 && traceEdict(tr.ent) !== enemy)) {
                return false;
              }

              self.monsterinfo.attack_state = AS_BLIND;
              self.monsterinfo.attack_finished = level.time + 0.5 + 2 * random();
              return true;
            }
          }
        }
        // pmm
        return false;
      }
    }
  }

  if (level.time < self.monsterinfo.attack_finished) return false;

  const enemy_range = range(self, enemy);

  if (enemy_range === RANGE_MELEE) {
    // don't always melee in easy mode
    // C: `rand()&3` -- see g_misc.ts's established house style for raw rand().
    if (cvarNum(gameCvars.skill) === 0 && Math.floor(Math.random() * 4) & 3) return false;
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (self.spawnflags & SPAWN_ROCKET) {
    chance = 0.1;
    nexttime = 1.8 - 0.2 * cvarNum(gameCvars.skill);
  } else if (self.spawnflags & SPAWN_BLASTER) {
    chance = 0.35;
    nexttime = 1.2 - 0.2 * cvarNum(gameCvars.skill);
  } else {
    chance = 0.5;
    nexttime = 0.8 - 0.1 * cvarNum(gameCvars.skill);
  }

  if (cvarNum(gameCvars.skill) === 0) chance *= 0.5;
  else if (cvarNum(gameCvars.skill) > 1) chance *= 2;

  // PGM - go ahead and shoot every time if it's a info_notnull
  // PMM - added visibility check
  if ((random() < chance && visible(self, enemy)) || enemy.solid === SolidT.SOLID_NOT) {
    self.monsterinfo.attack_state = AS_MISSILE;
    //		self.monsterinfo.attack_finished = level.time + 0.3 + 2*random();
    self.monsterinfo.attack_finished = level.time + nexttime;
    return true;
  }

  self.monsterinfo.attack_state = AS_STRAIGHT;

  return false;
}

// **********************
//  SPAWN
// **********************

/*QUAKED monster_turret (1 .5 0) (-16 -16 -16) (16 16 16) Ambush Trigger_Spawn Sight Blaster MachineGun Rocket Heatbeam WallUnit

The automated defense turret that mounts on walls.
Check the weapon you want it to use: blaster, machinegun, rocket, heatbeam.
Default weapon is blaster.
When activated, wall units move 32 units in the direction they're facing.
*/
export function SP_monster_turret(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // VERSIONING -- the C source's g_showlogic/ROGUE_VERSION_STRING dprintf
  // and `self->plat2flags = ROGUE_VERSION_ID;` are commented out in the
  // original m_turret.c itself; nothing to port.

  // pre-caches
  gi.soundindex("world/dr_short.wav");
  gi.modelindex("models/objects/debris1/tris.md2");

  self.s.modelindex = gi.modelindex("models/monsters/turret/tris.md2");

  VectorSet(self.mins, -12, -12, -12);
  VectorSet(self.maxs, 12, 12, 12);
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;

  self.health = 240;
  self.gib_health = -100;
  self.mass = 250;
  self.yaw_speed = 45;

  self.flags |= FL_MECHANICAL;

  self.pain = turret_pain;
  self.die = turret_die;

  // map designer didn't specify weapon type. set it now.
  if (!(self.spawnflags & SPAWN_WEAPONCHOICE)) {
    self.spawnflags |= SPAWN_BLASTER;
    //		self.spawnflags |= SPAWN_MACHINEGUN;
    //		self.spawnflags |= SPAWN_ROCKET;
    //		self.spawnflags |= SPAWN_HEATBEAM;
  }

  if (self.spawnflags & SPAWN_HEATBEAM) {
    self.spawnflags &= ~SPAWN_HEATBEAM;
    self.spawnflags |= SPAWN_BLASTER;
  }

  if (!(self.spawnflags & SPAWN_WALL_UNIT)) {
    self.monsterinfo.stand = turret_stand;
    self.monsterinfo.walk = turret_walk;
    self.monsterinfo.run = turret_run;
    self.monsterinfo.dodge = null;
    self.monsterinfo.attack = turret_attack;
    self.monsterinfo.melee = null;
    self.monsterinfo.sight = turret_sight;
    self.monsterinfo.search = turret_search;
    self.monsterinfo.currentmove = turret_move_stand;
  }

  // PMM
  self.monsterinfo.checkattack = turret_checkattack;

  self.monsterinfo.aiflags |= AI_MANUAL_STEERING;
  self.monsterinfo.scale = F.MODEL_SCALE;
  self.gravity = 0;

  VectorCopy(self.s.angles, self.offset);
  // C: `int angle; angle=(int)self->s.angles[1];` -- explicit int truncation.
  const angle = self.s.angles[1] | 0;
  switch (angle) {
    case -1: // up
      self.s.angles[0] = 270;
      self.s.angles[1] = 0;
      self.s.origin[2] += 2;
      break;
    case -2: // down
      self.s.angles[0] = 90;
      self.s.angles[1] = 0;
      self.s.origin[2] -= 2;
      break;
    case 0:
      self.s.origin[0] += 2;
      break;
    case 90:
      self.s.origin[1] += 2;
      break;
    case 180:
      self.s.origin[0] -= 2;
      break;
    case 270:
      self.s.origin[1] -= 2;
      break;
    default:
      break;
  }

  gi.linkentity(self);

  if (self.spawnflags & SPAWN_WALL_UNIT) {
    if (self.targetname === null) {
      // gi.dprintf("Wall Unit Turret without targetname! %s\n", vtos(self->s.origin));
      G_FreeEdict(self);
      return;
    }

    self.takedamage = DamageT.DAMAGE_NO;
    self.use = turret_activate;
    turret_wall_spawn(self);
    if (!(self.monsterinfo.aiflags & AI_GOOD_GUY) && !(self.monsterinfo.aiflags & AI_DO_NOT_COUNT)) level.total_monsters++;
  } else {
    stationarymonster_start(self);
  }

  if (self.spawnflags & SPAWN_MACHINEGUN) {
    gi.soundindex("infantry/infatck1.wav");
    self.s.skinnum = 1;
  } else if (self.spawnflags & SPAWN_ROCKET) {
    gi.soundindex("weapons/rockfly.wav");
    gi.modelindex("models/objects/rocket/tris.md2");
    gi.soundindex("chick/chkatck2.wav");
    self.s.skinnum = 2;
  } else {
    if (!(self.spawnflags & SPAWN_BLASTER)) {
      self.spawnflags |= SPAWN_BLASTER;
    }
    gi.modelindex("models/objects/laser/tris.md2");
    gi.soundindex("misc/lasfly.wav");
    gi.soundindex("soldier/solatck2.wav");
  }

  // PMM  - turrets don't get mad at monsters, and visa versa
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;
  // PMM - blindfire
  if (self.spawnflags & (SPAWN_ROCKET | SPAWN_BLASTER)) self.monsterinfo.blindfire = true;
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_turret:TurretAim", TurretAim);
registerSaveFunction("m_turret:turret_sight", turret_sight);
registerSaveFunction("m_turret:turret_search", turret_search);
registerSaveFunction("m_turret:turret_stand", turret_stand);
registerSaveFunction("m_turret:turret_ready_gun", turret_ready_gun);
registerSaveFunction("m_turret:turret_walk", turret_walk);
registerSaveFunction("m_turret:turret_run", turret_run);
registerSaveFunction("m_turret:TurretFire", TurretFire);
registerSaveFunction("m_turret:TurretFireBlind", TurretFireBlind);
registerSaveFunction("m_turret:turret_attack", turret_attack);
registerSaveFunction("m_turret:turret_pain", turret_pain);
registerSaveFunction("m_turret:turret_die", turret_die);
registerSaveFunction("m_turret:turret_wake", turret_wake);
registerSaveFunction("m_turret:turret_activate", turret_activate);
registerSaveFunction("m_turret:turret_checkattack", turret_checkattack);
registerSaveMmove("m_turret:turret_move_stand", turret_move_stand);
registerSaveMmove("m_turret:turret_move_ready_gun", turret_move_ready_gun);
registerSaveMmove("m_turret:turret_move_seek", turret_move_seek);
registerSaveMmove("m_turret:turret_move_run", turret_move_run);
registerSaveMmove("m_turret:turret_move_fire", turret_move_fire);
registerSaveMmove("m_turret:turret_move_fire_blind", turret_move_fire_blind);
