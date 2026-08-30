// g_turret.c

import {
  AngleVectors,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import { ATTN_NORM, CHAN_WEAPON, M_PI, MASK_MONSTERSOLID, PITCH, RF_FRAMELERP, YAW } from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { visible, FindTarget } from "./g_ai";
import { SolidT, SVF_MONSTER } from "./game";
import {
  AI_DUCKED,
  AI_LOST_SIGHT,
  AI_STAND_GROUND,
  DamageT,
  type EdictT,
  FL_NO_KNOCKBACK,
  FL_TEAMSLAVE,
  FRAMETIME,
  gameCvars,
  gi,
  level,
  MOD_CRUSH,
  MovetypeT,
  st,
} from "./g_local";
import { FindItemByClassname } from "./g_items";
import { fire_rocket } from "./g_weapon";
import { monster_use } from "./g_monster";
import { G_FreeEdict, G_PickTarget, vectoangles, vtos } from "./g_utils";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// g_turret.c declares these extern with a 4-arg infantry_die while the real
// m_infantry.c definition takes 5 (trailing unused `point`); C linkage never
// checks. The port passes vec3_origin for the unused parameter.
import { infantry_die, infantry_stand } from "./m_infantry";

export function AnglesNormalize(vec: Vec3): void {
  while (vec[0] > 360) vec[0] -= 360;
  while (vec[0] < 0) vec[0] += 360;
  while (vec[1] > 360) vec[1] -= 360;
  while (vec[1] < 0) vec[1] += 360;
}

export function SnapToEights(x: number): number {
  let v = x * 8.0;
  if (v > 0.0) v += 0.5;
  else v -= 0.5;
  return 0.125 * Math.trunc(v);
}

export function turret_blocked(self: EdictT, other: EdictT): void {
  if (other.takedamage) {
    const teammaster = self.teammaster;
    if (teammaster === null) return; // C assumes teammaster is always set once teamed
    const attacker = teammaster.owner !== null ? teammaster.owner : teammaster;
    T_Damage(other, self, attacker, vec3_origin, other.s.origin, vec3_origin, teammaster.dmg, 10, 0, MOD_CRUSH);
  }
}

/*QUAKED turret_breach (0 0 0) ?
This portion of the turret can change both pitch and yaw.
The model  should be made with a flat pitch.
It (and the associated base) need to be oriented towards 0.
Use "angle" to set the starting angle.

"speed"		default 50
"dmg"		default 10
"angle"		point this forward
"target"	point this at an info_notnull at the muzzle tip
"minpitch"	min acceptable pitch angle : default -30
"maxpitch"	max acceptable pitch angle : default 30
"minyaw"	min acceptable yaw angle   : default 0
"maxyaw"	max acceptable yaw angle   : default 360
*/

export function turret_breach_fire(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  const start = vec3();

  AngleVectors(self.s.angles, f, r, u);
  VectorMA(self.s.origin, self.move_origin[0], f, start);
  VectorMA(start, self.move_origin[1], r, start);
  VectorMA(start, self.move_origin[2], u, start);

  const damage = (100 + random() * 50) | 0;
  const speed = (550 + 50 * cvarNum(gameCvars.skill)) | 0;

  const teammaster = self.teammaster;
  if (teammaster === null || teammaster.owner === null) return; // C assumes both are set
  fire_rocket(teammaster.owner, start, f, damage, speed, 150, damage);
  gi.positioned_sound(start, self, CHAN_WEAPON, gi.soundindex("weapons/rocklf1a.wav"), 1, ATTN_NORM, 0);
}

export function turret_breach_think(self: EdictT): void {
  const current_angles = vec3();
  const delta = vec3();

  VectorCopy(self.s.angles, current_angles);
  AnglesNormalize(current_angles);

  AnglesNormalize(self.move_angles);
  if (self.move_angles[PITCH] > 180) self.move_angles[PITCH] -= 360;

  // clamp angles to mins & maxs
  if (self.move_angles[PITCH] > self.pos1[PITCH]) self.move_angles[PITCH] = self.pos1[PITCH];
  else if (self.move_angles[PITCH] < self.pos2[PITCH]) self.move_angles[PITCH] = self.pos2[PITCH];

  if (self.move_angles[YAW] < self.pos1[YAW] || self.move_angles[YAW] > self.pos2[YAW]) {
    let dmin = Math.abs(self.pos1[YAW] - self.move_angles[YAW]);
    if (dmin < -180) dmin += 360;
    else if (dmin > 180) dmin -= 360;
    let dmax = Math.abs(self.pos2[YAW] - self.move_angles[YAW]);
    if (dmax < -180) dmax += 360;
    else if (dmax > 180) dmax -= 360;
    if (Math.abs(dmin) < Math.abs(dmax)) self.move_angles[YAW] = self.pos1[YAW];
    else self.move_angles[YAW] = self.pos2[YAW];
  }

  VectorSubtract(self.move_angles, current_angles, delta);
  if (delta[0] < -180) delta[0] += 360;
  else if (delta[0] > 180) delta[0] -= 360;
  if (delta[1] < -180) delta[1] += 360;
  else if (delta[1] > 180) delta[1] -= 360;
  delta[2] = 0;

  if (delta[0] > self.speed * FRAMETIME) delta[0] = self.speed * FRAMETIME;
  if (delta[0] < -1 * self.speed * FRAMETIME) delta[0] = -1 * self.speed * FRAMETIME;
  if (delta[1] > self.speed * FRAMETIME) delta[1] = self.speed * FRAMETIME;
  if (delta[1] < -1 * self.speed * FRAMETIME) delta[1] = -1 * self.speed * FRAMETIME;

  VectorScale(delta, 1.0 / FRAMETIME, self.avelocity);

  self.nextthink = level.time + FRAMETIME;

  for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) {
    ent.avelocity[1] = self.avelocity[1];
  }

  // if we have a driver, adjust his velocities
  if (self.owner !== null) {
    const owner = self.owner;
    const target = vec3();
    const dir = vec3();

    // angular is easy, just copy ours
    owner.avelocity[0] = self.avelocity[0];
    owner.avelocity[1] = self.avelocity[1];

    // x & y
    let angle = self.s.angles[1] + owner.move_origin[1];
    angle *= (M_PI * 2) / 360;
    target[0] = SnapToEights(self.s.origin[0] + Math.cos(angle) * owner.move_origin[0]);
    target[1] = SnapToEights(self.s.origin[1] + Math.sin(angle) * owner.move_origin[0]);
    target[2] = owner.s.origin[2];

    VectorSubtract(target, owner.s.origin, dir);
    owner.velocity[0] = (dir[0] * 1.0) / FRAMETIME;
    owner.velocity[1] = (dir[1] * 1.0) / FRAMETIME;

    // z
    angle = self.s.angles[PITCH] * ((M_PI * 2) / 360);
    const target_z = SnapToEights(self.s.origin[2] + owner.move_origin[0] * Math.tan(angle) + owner.move_origin[2]);

    const diff = target_z - owner.s.origin[2];
    owner.velocity[2] = (diff * 1.0) / FRAMETIME;

    if (self.spawnflags & 65536) {
      turret_breach_fire(self);
      self.spawnflags &= ~65536;
    }
  }
}

export function turret_breach_finish_init(self: EdictT): void {
  // get and save info for muzzle location
  if (!self.target) {
    gi.dprintf(`${self.classname} at ${vtos(self.s.origin)} needs a target\n`);
  } else {
    self.target_ent = G_PickTarget(self.target);
    if (self.target_ent !== null) {
      VectorSubtract(self.target_ent.s.origin, self.s.origin, self.move_origin);
      G_FreeEdict(self.target_ent);
    }
  }

  if (self.teammaster !== null) self.teammaster.dmg = self.dmg;
  self.think = turret_breach_think;
  turret_breach_think(self);
}

export function SP_turret_breach(self: EdictT): void {
  self.solid = SolidT.SOLID_BSP;
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.setmodel(self, self.model ?? "");

  if (!self.speed) self.speed = 50;
  if (!self.dmg) self.dmg = 10;

  if (!st.minpitch) st.minpitch = -30;
  if (!st.maxpitch) st.maxpitch = 30;
  if (!st.maxyaw) st.maxyaw = 360;

  self.pos1[PITCH] = -1 * st.minpitch;
  self.pos1[YAW] = st.minyaw;
  self.pos2[PITCH] = -1 * st.maxpitch;
  self.pos2[YAW] = st.maxyaw;

  self.ideal_yaw = self.s.angles[YAW];
  self.move_angles[YAW] = self.ideal_yaw;

  self.blocked = turret_blocked;

  self.think = turret_breach_finish_init;
  self.nextthink = level.time + FRAMETIME;
  gi.linkentity(self);
}

/*QUAKED turret_base (0 0 0) ?
This portion of the turret changes yaw only.
MUST be teamed with a turret_breach.
*/

export function SP_turret_base(self: EdictT): void {
  self.solid = SolidT.SOLID_BSP;
  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.setmodel(self, self.model ?? "");
  self.blocked = turret_blocked;
  gi.linkentity(self);
}

/*QUAKED turret_driver (1 .5 0) (-16 -16 -24) (16 16 32)
Must NOT be on the team with the rest of the turret parts.
Instead it must target the turret_breach.
*/

export function turret_driver_die(self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number): void {
  // level the gun
  if (self.target_ent !== null) self.target_ent.move_angles[0] = 0;

  // remove the driver from the end of them team chain
  if (self.target_ent !== null && self.target_ent.teammaster !== null) {
    let ent: EdictT = self.target_ent.teammaster;
    while (ent.teamchain !== self && ent.teamchain !== null) ent = ent.teamchain;
    ent.teamchain = null;
  }
  self.teammaster = null;
  self.flags &= ~FL_TEAMSLAVE;

  if (self.target_ent !== null) {
    self.target_ent.owner = null;
    if (self.target_ent.teammaster !== null) self.target_ent.teammaster.owner = null;
  }

  infantry_die(self, inflictor, attacker, damage, vec3_origin);
}

export function turret_driver_think(self: EdictT): void {
  const target = vec3();
  const dir = vec3();

  self.nextthink = level.time + FRAMETIME;

  if (self.enemy !== null && (!self.enemy.inuse || self.enemy.health <= 0)) self.enemy = null;

  if (self.enemy === null) {
    if (!FindTarget(self)) return;
    self.monsterinfo.trail_time = level.time;
    self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
  } else {
    if (visible(self, self.enemy)) {
      if (self.monsterinfo.aiflags & AI_LOST_SIGHT) {
        self.monsterinfo.trail_time = level.time;
        self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
      }
    } else {
      self.monsterinfo.aiflags |= AI_LOST_SIGHT;
      return;
    }
  }

  if (self.target_ent === null || self.enemy === null) return;

  // let the turret know where we want it to aim
  VectorCopy(self.enemy.s.origin, target);
  target[2] += self.enemy.viewheight;
  VectorSubtract(target, self.target_ent.s.origin, dir);
  vectoangles(dir, self.target_ent.move_angles);

  // decide if we should shoot
  if (level.time < self.monsterinfo.attack_finished) return;

  const reaction_time = (3 - cvarNum(gameCvars.skill)) * 1.0;
  if (level.time - self.monsterinfo.trail_time < reaction_time) return;

  self.monsterinfo.attack_finished = level.time + reaction_time + 1.0;
  //FIXME how do we really want to pass this along?
  self.target_ent.spawnflags |= 65536;
}

export function turret_driver_link(self: EdictT): void {
  const vec = vec3();

  self.think = turret_driver_think;
  self.nextthink = level.time + FRAMETIME;

  self.target_ent = G_PickTarget(self.target);
  if (self.target_ent === null) return; // C assumes G_PickTarget always succeeds here
  self.target_ent.owner = self;
  if (self.target_ent.teammaster !== null) self.target_ent.teammaster.owner = self;
  VectorCopy(self.target_ent.s.angles, self.s.angles);

  vec[0] = self.target_ent.s.origin[0] - self.s.origin[0];
  vec[1] = self.target_ent.s.origin[1] - self.s.origin[1];
  vec[2] = 0;
  self.move_origin[0] = VectorLength(vec);

  VectorSubtract(self.s.origin, self.target_ent.s.origin, vec);
  vectoangles(vec, vec);
  AnglesNormalize(vec);
  self.move_origin[1] = vec[1];

  self.move_origin[2] = self.s.origin[2] - self.target_ent.s.origin[2];

  // add the driver to the end of them team chain
  if (self.target_ent.teammaster !== null) {
    let ent = self.target_ent.teammaster;
    while (ent.teamchain !== null) ent = ent.teamchain;
    ent.teamchain = self;
    self.teammaster = self.target_ent.teammaster;
  }
  self.flags |= FL_TEAMSLAVE;
}

export function SP_turret_driver(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/infantry/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);

  self.health = 100;
  self.gib_health = 0;
  self.mass = 200;
  self.viewheight = 24;

  self.die = turret_driver_die;
  self.monsterinfo.stand = infantry_stand;

  self.flags |= FL_NO_KNOCKBACK;

  level.total_monsters++;

  self.svflags |= SVF_MONSTER;
  self.s.renderfx |= RF_FRAMELERP;
  self.takedamage = DamageT.DAMAGE_AIM;
  self.use = monster_use;
  self.clipmask = MASK_MONSTERSOLID;
  VectorCopy(self.s.origin, self.s.old_origin);
  self.monsterinfo.aiflags |= AI_STAND_GROUND | AI_DUCKED;

  if (st.item) {
    self.item = FindItemByClassname(st.item);
    if (!self.item) gi.dprintf(`${self.classname} at ${vtos(self.s.origin)} has bad item: ${st.item}\n`);
  }

  self.think = turret_driver_link;
  self.nextthink = level.time + FRAMETIME;

  gi.linkentity(self);
}
