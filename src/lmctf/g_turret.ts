// g_turret.c
//
// rogue/g_turret.c vs baseq2/g_turret.c: a diagnostic dprintf when
// turret_breach_finish_init's G_PickTarget() call fails (additive; this
// path already didn't dereference a null target_ent), and a new
// turret_brain_* family (turret_brain_think/_link/_deactivate/_activate,
// SP_turret_invisible_brain) -- an invisible turret "driver" that fires at
// the center of its enemy's bounding box instead of a visible
// turret_driver's origin, letting mappers make unmanned turrets that shoot
// at func_trains and similar bmodel targets. This file is g_turret.c (the
// turret_breach/turret_base/turret_driver mount), not m_turret.c (the
// monster_turret body, this round's own file).

import {
  AngleVectors,
  random,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorScale,
  VectorSet,
  VectorSubtract,
} from "../shared/math";
import { ATTN_NORM, CHAN_WEAPON, M_PI, MASK_MONSTERSOLID, MASK_SHOT, PITCH, RF_FRAMELERP, YAW } from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { visible, FindTarget } from "./g_ai";
import { type Edict, SolidT, SVF_MONSTER } from "./game";
import {
  AI_DUCKED,
  AI_LOST_SIGHT,
  AI_STAND_GROUND,
  DamageT,
  type EdictT,
  FL_NO_KNOCKBACK,
  FL_TEAMSLAVE,
  FRAMETIME,
  g_edicts,
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

// trace_t.ent recovery idiom (see g_monster.ts's/g_ai.ts's own copy):
// sv_world.c defaults an unset trace.ent to the world edict, never NULL, so
// a null GTraceT.ent here falls back to g_edicts[0] the same way.
// Module-local per PORTING.md.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
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
    } else {
      gi.dprintf(`could not find target entity for ${self.classname} at ${vtos(self.s.origin)}\n`);
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

//============
// ROGUE

// invisible turret drivers so we can have unmanned turrets.
// originally designed to shoot at func_trains and such, so they
// fire at the center of the bounding box, rather than the entity's
// origin.

export function turret_brain_think(self: EdictT): void {
  const target = vec3();
  const endpos = vec3();

  self.nextthink = level.time + FRAMETIME;

  if (self.enemy !== null) {
    if (!self.enemy.inuse) self.enemy = null;
    else if (self.enemy.takedamage && self.enemy.health <= 0) self.enemy = null;
  }

  if (self.enemy === null) {
    if (!FindTarget(self)) return;
    self.monsterinfo.trail_time = level.time;
    self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
  } else {
    if (self.target_ent === null) return; // C assumes target_ent is always set by turret_brain_link

    VectorAdd(self.enemy.absmax, self.enemy.absmin, endpos);
    VectorScale(endpos, 0.5, endpos);

    const trace = gi.trace(self.target_ent.s.origin, vec3_origin, vec3_origin, endpos, self.target_ent, MASK_SHOT);
    if (trace.fraction === 1 || traceEdict(trace.ent) === self.enemy) {
      if (self.monsterinfo.aiflags & AI_LOST_SIGHT) {
        self.monsterinfo.trail_time = level.time;
        self.monsterinfo.aiflags &= ~AI_LOST_SIGHT;
      }
    } else {
      self.monsterinfo.aiflags |= AI_LOST_SIGHT;
      return;
    }
  }

  if (self.target_ent === null) return; // C assumes target_ent is always set by turret_brain_link

  // let the turret know where we want it to aim
  VectorCopy(endpos, target);
  const dir = vec3();
  VectorSubtract(target, self.target_ent.s.origin, dir);
  vectoangles(dir, self.target_ent.move_angles);

  // decide if we should shoot
  if (level.time < self.monsterinfo.attack_finished) return;

  let reaction_time: number;
  if (self.delay) reaction_time = self.delay;
  else reaction_time = (3 - cvarNum(gameCvars.skill)) * 1.0;
  if (level.time - self.monsterinfo.trail_time < reaction_time) return;

  self.monsterinfo.attack_finished = level.time + reaction_time + 1.0;
  //FIXME how do we really want to pass this along?
  self.target_ent.spawnflags |= 65536;
}

// =================
// =================
export function turret_brain_link(self: EdictT): void {
  const vec = vec3();

  if (self.killtarget) {
    self.enemy = G_PickTarget(self.killtarget);
  }

  self.think = turret_brain_think;
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

// =================
// =================
export function turret_brain_deactivate(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.think = null;
  self.nextthink = 0;
}

// =================
// =================
export function turret_brain_activate(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (self.enemy === null) {
    self.enemy = activator;
  }

  // wait at least 3 seconds to fire.
  self.monsterinfo.attack_finished = level.time + 3;
  self.use = turret_brain_deactivate;

  self.think = turret_brain_link;
  self.nextthink = level.time + FRAMETIME;
}

/*QUAKED turret_invisible_brain (1 .5 0) (-16 -16 -16) (16 16 16)
Invisible brain to drive the turret.

Does not search for targets. If targeted, can only be turned on once
and then off once. After that they are completely disabled.

"delay" the delay between firing (default ramps for skill level)
"Target" the turret breach
"Killtarget" the item you want it to attack.
Target the brain if you want it activated later, instead of immediately. It will wait 3 seconds
before firing to acquire the target.
*/
export function SP_turret_invisible_brain(self: EdictT): void {
  if (!self.killtarget) {
    gi.dprintf("turret_invisible_brain with no killtarget!\n");
    G_FreeEdict(self);
    return;
  }
  if (!self.target) {
    gi.dprintf("turret_invisible_brain with no target!\n");
    G_FreeEdict(self);
    return;
  }

  if (self.targetname) {
    self.use = turret_brain_activate;
  } else {
    self.think = turret_brain_link;
    self.nextthink = level.time + FRAMETIME;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.linkentity(self);
}

// ROGUE
//============

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks restores a real think/use function
// instead of null (see g_save.ts's registerSaveFunction name registry).
// This round only registers the new turret_brain_* additions above; the
// file's pre-existing turret_breach/turret_driver functions were not
// previously registered and are left as-is (outside this round's SCOPE).
// -------------------------------------------------------------------------

import { registerSaveFunction } from "./g_save";

registerSaveFunction("g_turret:turret_brain_think", turret_brain_think);
registerSaveFunction("g_turret:turret_brain_link", turret_brain_link);
registerSaveFunction("g_turret:turret_brain_deactivate", turret_brain_deactivate);
registerSaveFunction("g_turret:turret_brain_activate", turret_brain_activate);
