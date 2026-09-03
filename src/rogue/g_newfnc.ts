// g_newfnc.c
//
// Pack-only functions (no baseq2 sibling): func_door_secret2 (a
// pmack-authored secret door variant of func_door_secret that slides in an
// arbitrary quadrant instead of hardcoded directions) and func_force_wall
// (a telefragging particle-wall barrier).

import {
  AngleVectors,
  random,
  vec3,
  vec3_origin,
  type Vec3,
  VectorAdd,
  VectorCopy,
  VectorScale,
  VectorSet,
} from "../shared/math";
import {
  ATTN_STATIC,
  CHAN_NO_PHS_ADD,
  CHAN_VOICE,
  type CplaneT,
  type CsurfaceT,
  EF_SPINNINGLIGHTS,
  MulticastT,
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  DamageT,
  type EdictT,
  FL_TEAMSLAVE,
  gi,
  level,
  MOD_CRUSH,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { Move_Calc } from "./g_func";
import { G_FreeEdict, G_SetMovedir, G_UseTargets, KillBox } from "./g_utils";
import { T_Damage } from "./g_combat";
import { registerSaveFunction } from "./g_save";

/*
=============================================================================

SECRET DOORS

=============================================================================
*/

const SEC_OPEN_ONCE = 1; // stays open
const SEC_1ST_LEFT = 2; // 1st move is left of arrow
const SEC_1ST_DOWN = 4; // 1st move is down from arrow
const SEC_NO_SHOOT = 8; // only opened by trigger
const SEC_YES_SHOOT = 16; // shootable even if targeted
const SEC_MOVE_RIGHT = 32;
const SEC_MOVE_FORWARD = 64;

export function fd_secret_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.flags & FL_TEAMSLAVE) return;

  // trigger all paired doors
  for (let ent: EdictT | null = self; ent !== null; ent = ent.teamchain) {
    Move_Calc(ent, ent.moveinfo.start_origin, fd_secret_move1);
  }
}

export function fd_secret_killed(
  self: EdictT,
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  point: Vec3,
): void {
  self.health = self.max_health;
  self.takedamage = DamageT.DAMAGE_NO;

  if (self.flags & FL_TEAMSLAVE && self.teammaster !== null && self.teammaster.takedamage !== DamageT.DAMAGE_NO) {
    fd_secret_killed(self.teammaster, inflictor, attacker, damage, point);
  } else {
    fd_secret_use(self, inflictor, attacker);
  }
}

// Wait after first movement...
export function fd_secret_move1(self: EdictT): void {
  self.nextthink = level.time + 1.0;
  self.think = fd_secret_move2;
}

// Start moving sideways w/sound...
export function fd_secret_move2(self: EdictT): void {
  Move_Calc(self, self.moveinfo.end_origin, fd_secret_move3);
}

// Wait here until time to go back...
export function fd_secret_move3(self: EdictT): void {
  if (!(self.spawnflags & SEC_OPEN_ONCE)) {
    self.nextthink = level.time + self.wait;
    self.think = fd_secret_move4;
  }
}

// Move backward...
export function fd_secret_move4(self: EdictT): void {
  Move_Calc(self, self.moveinfo.start_origin, fd_secret_move5);
}

// Wait 1 second...
export function fd_secret_move5(self: EdictT): void {
  self.nextthink = level.time + 1.0;
  self.think = fd_secret_move6;
}

export function fd_secret_move6(self: EdictT): void {
  Move_Calc(self, self.move_origin, fd_secret_done);
}

export function fd_secret_done(self: EdictT): void {
  if (!self.targetname || self.spawnflags & SEC_YES_SHOOT) {
    self.health = 1;
    self.takedamage = DamageT.DAMAGE_YES;
    self.die = fd_secret_killed;
  }
}

export function secret_blocked(self: EdictT, other: EdictT): void {
  if (!(self.flags & FL_TEAMSLAVE)) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 0, 0, MOD_CRUSH);
  }
}

/*
================
secret_touch

Prints messages
================
*/
export function secret_touch(
  self: EdictT,
  other: EdictT,
  _plane: CplaneT | null,
  _surf: CsurfaceT | null,
): void {
  if (other.health <= 0) return;

  if (other.client === null) return;

  if (self.monsterinfo.attack_finished > level.time) return;

  self.monsterinfo.attack_finished = level.time + 2;

  if (self.message) {
    gi.centerprintf(other, self.message);
    // fixme - put this sound back??
    // gi.sound(other, CHAN_BODY, "misc/talk.wav", 1, ATTN_NORM);
  }
}

/*QUAKED func_door_secret2 (0 .5 .8) ? open_once 1st_left 1st_down no_shoot always_shoot slide_right slide_forward
Basic secret door. Slides back, then to the left. Angle determines direction.

FLAGS:
open_once = not implemented yet
1st_left = 1st move is left/right of arrow
1st_down = 1st move is forwards/backwards
no_shoot = not implemented yet
always_shoot = even if targeted, keep shootable
reverse_left = the sideways move will be to right of arrow
reverse_back = the to/fro move will be forward

VALUES:
wait = # of seconds before coming back (5 default)
dmg  = damage to inflict when blocked (2 default)

*/
export function SP_func_door_secret2(ent: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  let lrSize: number;
  let fbSize: number;

  ent.moveinfo.sound_start = gi.soundindex("doors/dr1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("doors/dr1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("doors/dr1_end.wav");

  if (!ent.dmg) ent.dmg = 2;

  AngleVectors(ent.s.angles, forward, right, up);
  VectorCopy(ent.s.origin, ent.move_origin);
  VectorCopy(ent.s.angles, ent.move_angles);

  G_SetMovedir(ent.s.angles, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  gi.setmodel(ent, ent.model ?? "");

  if (ent.move_angles[1] === 0 || ent.move_angles[1] === 180) {
    lrSize = ent.size[1]!;
    fbSize = ent.size[0]!;
  } else if (ent.move_angles[1] === 90 || ent.move_angles[1] === 270) {
    lrSize = ent.size[0]!;
    fbSize = ent.size[1]!;
  } else {
    gi.dprintf("Secret door not at 0,90,180,270!\n");
    lrSize = ent.size[0]!;
    fbSize = ent.size[1]!;
  }

  if (ent.spawnflags & SEC_MOVE_FORWARD) {
    VectorScale(forward, fbSize, forward);
  } else {
    VectorScale(forward, fbSize * -1, forward);
  }

  if (ent.spawnflags & SEC_MOVE_RIGHT) {
    VectorScale(right, lrSize, right);
  } else {
    VectorScale(right, lrSize * -1, right);
  }

  if (ent.spawnflags & SEC_1ST_DOWN) {
    VectorAdd(ent.s.origin, forward, ent.moveinfo.start_origin);
    VectorAdd(ent.moveinfo.start_origin, right, ent.moveinfo.end_origin);
  } else {
    VectorAdd(ent.s.origin, right, ent.moveinfo.start_origin);
    VectorAdd(ent.moveinfo.start_origin, forward, ent.moveinfo.end_origin);
  }

  ent.touch = secret_touch;
  ent.blocked = secret_blocked;
  ent.use = fd_secret_use;
  ent.moveinfo.speed = 50;
  ent.moveinfo.accel = 50;
  ent.moveinfo.decel = 50;

  if (!ent.targetname || ent.spawnflags & SEC_YES_SHOOT) {
    ent.health = 1;
    ent.max_health = ent.health;
    ent.takedamage = DamageT.DAMAGE_YES;
    ent.die = fd_secret_killed;
  }
  if (!ent.wait) ent.wait = 5; // 5 seconds before closing

  gi.linkentity(ent);
}

// ==================================================

const FWALL_START_ON = 1;

export function force_wall_think(self: EdictT): void {
  if (!self.wait) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_FORCEWALL);
    gi.WritePosition(self.pos1);
    gi.WritePosition(self.pos2);
    gi.WriteByte(self.style);
    gi.multicast(self.offset, MulticastT.MULTICAST_PVS);
  }

  self.think = force_wall_think;
  self.nextthink = level.time + 0.1;
}

export function force_wall_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (!self.wait) {
    self.wait = 1;
    self.think = null;
    self.nextthink = 0;
    self.solid = SolidT.SOLID_NOT;
    gi.linkentity(self);
  } else {
    self.wait = 0;
    self.think = force_wall_think;
    self.nextthink = level.time + 0.1;
    self.solid = SolidT.SOLID_BSP;
    KillBox(self); // Is this appropriate?
    gi.linkentity(self);
  }
}

/*QUAKED func_force_wall (1 0 1) ? start_on
A vertical particle force wall. Turns on and solid when triggered.
If someone is in the force wall when it turns on, they're telefragged.

start_on - forcewall begins activated. triggering will turn it off.
style - color of particles to use.
	208: green, 240: red, 241: blue, 224: orange
*/
export function SP_func_force_wall(ent: EdictT): void {
  gi.setmodel(ent, ent.model ?? "");

  ent.offset[0] = (ent.absmax[0]! + ent.absmin[0]!) / 2;
  ent.offset[1] = (ent.absmax[1]! + ent.absmin[1]!) / 2;
  ent.offset[2] = (ent.absmax[2]! + ent.absmin[2]!) / 2;

  ent.pos1[2] = ent.absmax[2]!;
  ent.pos2[2] = ent.absmax[2]!;
  if (ent.size[0]! > ent.size[1]!) {
    ent.pos1[0] = ent.absmin[0]!;
    ent.pos2[0] = ent.absmax[0]!;
    ent.pos1[1] = ent.offset[1]!;
    ent.pos2[1] = ent.offset[1]!;
  } else {
    ent.pos1[0] = ent.offset[0]!;
    ent.pos2[0] = ent.offset[0]!;
    ent.pos1[1] = ent.absmin[1]!;
    ent.pos2[1] = ent.absmax[1]!;
  }

  if (!ent.style) ent.style = 208;

  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.wait = 1;

  if (ent.spawnflags & FWALL_START_ON) {
    ent.solid = SolidT.SOLID_BSP;
    ent.think = force_wall_think;
    ent.nextthink = level.time + 0.1;
  } else {
    ent.solid = SolidT.SOLID_NOT;
  }

  ent.use = force_wall_use;

  ent.svflags = SVF_NOCLIENT;

  gi.linkentity(ent);
}


// =====================================================================
// RE-RELEASE CONTENT PORT -- two xatrix (The Reckoning) func_* entities the
// re-release build of the maps this module hosts places, copied verbatim
// (comments included) from our sibling src/game/g_newfnc.ts, which in turn
// ported them from src/xatrix/g_func.ts.
//
// rotating_light is placed by refinery/xhangar2/xship; func_object_repair
// is the prop monster_fixbot welds (xcompnd1). Neither classname exists in
// any 1998-era Ground Zero map, so both are inert for existing content.
// =====================================================================

//==========================================================
// rotating_light -- src/xatrix/g_func.ts
//==========================================================

/*QUAKED rotating_light (0 .5 .8) (-8 -8 -8) (8 8 8) START_OFF ALARM
"health"	if set, the light may be killed.
*/

// RAFAEL
// note to self
// the lights will take damage from explosions
// this could leave a player in total darkness very bad

const ROTATING_LIGHT_START_OFF = 1;

function rotating_light_alarm(self: EdictT): void {
  if ((self.spawnflags & ROTATING_LIGHT_START_OFF) !== 0) {
    self.think = null;
    self.nextthink = 0;
  } else {
    gi.sound(self, CHAN_NO_PHS_ADD + CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    self.nextthink = level.time + 1;
  }
}

function rotating_light_killed(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(30);
  gi.WritePosition(self.s.origin);
  gi.WriteDir(vec3_origin);
  // `rand()&7` -> a uniform 0-7 byte; determinism across runs is not a goal
  // (PORTING.md), so this uses the shared random() helper instead of a
  // ported C rand().
  gi.WriteByte(0xe0 + (Math.floor(random() * 8) | 0));
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  self.s.effects &= ~EF_SPINNINGLIGHTS;
  self.use = null;

  self.think = G_FreeEdict;
  self.nextthink = level.time + 0.1;
}

function rotating_light_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if ((self.spawnflags & ROTATING_LIGHT_START_OFF) !== 0) {
    self.spawnflags &= ~ROTATING_LIGHT_START_OFF;
    self.s.effects |= EF_SPINNINGLIGHTS;

    if ((self.spawnflags & 2) !== 0) {
      self.think = rotating_light_alarm;
      self.nextthink = level.time + 0.1;
    }
  } else {
    self.spawnflags |= ROTATING_LIGHT_START_OFF;
    self.s.effects &= ~EF_SPINNINGLIGHTS;
  }
}

export function SP_rotating_light(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_STOP;
  self.solid = SolidT.SOLID_BBOX;

  self.s.modelindex = gi.modelindex("models/objects/light/tris.md2");

  self.s.frame = 0;

  self.use = rotating_light_use;

  if ((self.spawnflags & ROTATING_LIGHT_START_OFF) !== 0) self.s.effects &= ~EF_SPINNINGLIGHTS;
  else self.s.effects |= EF_SPINNINGLIGHTS;

  if (!self.speed) self.speed = 32;
  // this is a real cheap way
  // to set the radius of the light
  // self.s.frame = self.speed;

  if (!self.health) {
    self.health = 10;
    self.max_health = self.health;
    self.die = rotating_light_killed;
    self.takedamage = DamageT.DAMAGE_YES;
  } else {
    self.max_health = self.health;
    self.die = rotating_light_killed;
    self.takedamage = DamageT.DAMAGE_YES;
  }

  if ((self.spawnflags & 2) !== 0) {
    self.moveinfo.sound_start = gi.soundindex("misc/alarm.wav");
  }

  gi.linkentity(self);
}

/*QUAKED func_object_repair (1 .5 0) (-8 -8 -8) (8 8 8)
object to be repaired.
The default delay is 1 second
"delay" the delay in seconds for spark to occur
*/
// RERELEASE CONTENT PORT -- xatrix/g_func.c's object-repair prop, ported
// from src/xatrix/g_func.ts. This is the thing monster_fixbot flies to and
// welds: m_fixbot.ts looks for entities whose classname is the bare
// "object_repair" (NOT the map's "func_object_repair"), which is why
// SP_object_repair rewrites ent.classname below -- that rename is the
// contract between the two files, not an accident.

function object_repair_fx(ent: EdictT): void {
  ent.nextthink = level.time + ent.delay;

  if (ent.health <= 100) {
    ent.health++;
  } else {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
    gi.WriteByte(10);
    gi.WritePosition(ent.s.origin);
    gi.WriteDir(vec3_origin);
    gi.WriteByte(0xe0 + (Math.floor(random() * 8) | 0));
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  }
}

function object_repair_dead(ent: EdictT): void {
  G_UseTargets(ent, ent);
  ent.nextthink = level.time + 0.1;
  ent.think = object_repair_fx;
}

function object_repair_sparks(ent: EdictT): void {
  if (ent.health < 0) {
    ent.nextthink = level.time + 0.1;
    ent.think = object_repair_dead;
    return;
  }

  ent.nextthink = level.time + ent.delay;

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(10);
  gi.WritePosition(ent.s.origin);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(0xe0 + (Math.floor(random() * 8) | 0));
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
}

export function SP_object_repair(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.classname = "object_repair";
  // C source literally: VectorSet(ent->mins, -8, -8, 8) -- mins.z is +8,
  // not -8, giving mins.z === maxs.z (zero-height bbox on that axis).
  // Preserved exactly (xatrix/g_func.c: SP_object_repair).
  VectorSet(ent.mins, -8, -8, 8);
  VectorSet(ent.maxs, 8, 8, 8);
  ent.think = object_repair_sparks;
  ent.nextthink = level.time + 1.0;
  ent.health = 100;
  if (!ent.delay) ent.delay = 1.0;
}


registerSaveFunction("g_newfnc:rotating_light_alarm", rotating_light_alarm);
registerSaveFunction("g_newfnc:rotating_light_killed", rotating_light_killed);
registerSaveFunction("g_newfnc:rotating_light_use", rotating_light_use);
registerSaveFunction("g_newfnc:object_repair_fx", object_repair_fx);
registerSaveFunction("g_newfnc:object_repair_dead", object_repair_dead);
registerSaveFunction("g_newfnc:object_repair_sparks", object_repair_sparks);
