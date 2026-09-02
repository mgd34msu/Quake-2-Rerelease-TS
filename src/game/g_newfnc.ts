// Mission-pack func_* entities layered onto this module's own g_func.ts
// (which is owned by another unit and not edited here):
//   - func_plat2 comes from src/rogue/g_func.ts's "PLAT 2 -- ROGUE" section.
//     It shares plumbing with vanilla func_plat (Move_Calc, the STATE_*
//     enumerants, plat_spawn_inside_trigger's shape) but is spawned,
//     blocked, used and moved entirely by its own copies of those helpers
//     here, since src/game/g_func.ts cannot be edited by this unit. Its
//     "danger area" bad_area markers are spawned via `SpawnBadArea`,
//     implemented in src/game/g_newai.ts (another unit's SCOPE) -- imported
//     here exactly as rogue's own g_func.ts imports it.
//   - rotating_light comes from src/xatrix/g_func.ts's tail section.
//
// Faithful, line-by-line ports of both; deviations are called out inline.

import {
  type Vec3,
  vec3,
  vec3_origin,
  VectorClear,
  VectorCopy,
  VectorSet,
  random,
} from "../shared/math";
import {
  ATTN_STATIC,
  CHAN_NO_PHS_ADD,
  CHAN_VOICE,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  EF_SPINNINGLIGHTS,
  MulticastT,
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_MONSTER } from "./game";
import {
  DamageT,
  type EdictT,
  FL_TEAMSLAVE,
  g_edicts,
  gameCvars,
  gi,
  globals,
  level,
  MOD_CRUSH,
  MovetypeT,
  st,
  svc_temp_entity,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { T_Damage } from "./g_combat";
import { Move_Calc } from "./g_func";
// SpawnBadArea is implemented in g_newai.ts, owned by another unit in this
// port effort (not yet landed as of this file's writing -- see the port
// report). Imported the same way rogue's own g_func.ts imports it.
import { SpawnBadArea } from "./g_newai";
import { G_Find, G_FreeEdict, G_Spawn, G_UseTargets } from "./g_utils";
import { registerSaveFunction } from "./g_save";

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// plat states, matching src/game/g_func.ts's own (private) STATE_* values.
const STATE_TOP = 0;
const STATE_BOTTOM = 1;
const STATE_UP = 2;
const STATE_DOWN = 3;

const PLAT_LOW_TRIGGER = 1;

// ROGUE
const PLAT2_TOGGLE = 2;
const PLAT2_TOP = 4;
// PLAT2_TRIGGER_TOP/PLAT2_TRIGGER_BOTTOM are documented on func_plat2's
// QUAKED line but never read anywhere in the shipped rogue g_func.c
// (plat2_hit_top/plat2_hit_bottom always call G_UseTargets unconditionally)
// -- preserved as unused spawnflag bits, matching the C source's own dead
// declarations.
const PLAT2_TRIGGER_TOP = 8;
const PLAT2_TRIGGER_BOTTOM = 16;
void PLAT2_TRIGGER_TOP;
void PLAT2_TRIGGER_BOTTOM;

/*
RERELEASE CONTENT PORT -- bit 8 is START_ACTIVE on re-release content.

rogue/g_rogue_func.cpp:10 renames the bit this file calls PLAT2_TRIGGER_TOP:
    constexpr spawnflags_t SPAWNFLAGS_PLAT2_START_ACTIVE = 8_spawnflag;
and reads it in SP_func_plat2 (rogue/g_rogue_func.cpp:391), where rogue's
own g_func.c:54 had a bare targetname test:

    vanilla     if (ent->targetname)
    re-release  if (ent->targetname && !(ent->spawnflags & SPAWNFLAGS_PLAT2_START_ACTIVE))

A plat2 that has BOTH a targetname and this bit therefore takes the ELSE
branch in the re-release: it gets its "start moving" inside trigger, and
(without PLAT2_TOP) starts down at STATE_BOTTOM instead of parked at
STATE_TOP waiting to be activated by name.

Safe to read here, by the same argument 7c68b1a used for
SPAWNFLAG_COOP_ONLY (0x4000): the bit is DEAD in 3.21. This file's note
directly above says so -- shipped rogue g_func.c declares
PLAT2_TRIGGER_TOP and never reads it -- so nothing in vanilla can observe
the bit, and honouring it cannot change any 1997 behaviour.

Confirmed against both content trees rather than argued: of 130 func_plat2
entities across the 1997 tree's id paks (baseq2 pak0/pak1, xatrix, rogue,
ctf), ZERO carry a targetname together with bit 8. Of 143 in the re-release
pak, exactly THREE do -- hangar1 "hg_plat1", jail1 "trust_fall" and
xcompnd2 "return_plat", all spawnflags 9 -- and those are precisely the
three maps the cross-module sweep flagged (classic parked the plat at
STATE_TOP, the re-release module started it at STATE_BOTTOM).
*/
const PLAT2_START_ACTIVE = 8;
const PLAT2_BOX_LIFT = 32;

// plat2flags bits (distinct from the spawnflags above).
const PLAT2_CALLED = 1;
const PLAT2_MOVING = 2;
const PLAT2_WAITING = 4;

//==========================================================
// func_plat2 -- src/rogue/g_func.ts
//==========================================================

function Touch_Plat_Center2(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // this requires monsters to actively trigger plats, not just step on them.
  if (other.health <= 0) return;

  // PMM - don't let non-monsters activate plat2s
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) return;

  plat2_operate(ent, other);
}

// PGM - plat2's change the trigger field, so this returns the trigger it
// spawned (vanilla's own plat_spawn_inside_trigger in src/game/g_func.ts
// returns void; this is a standalone copy for func_plat2's own use, since
// that file cannot be edited here).
function plat2_spawn_inside_trigger(ent: EdictT): EdictT {
  const trigger = G_Spawn();
  trigger.touch = Touch_Plat_Center2;
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.enemy = ent;

  const tmin = vec3();
  const tmax = vec3();

  tmin[0] = ent.mins[0] + 25;
  tmin[1] = ent.mins[1] + 25;
  tmin[2] = ent.mins[2];

  tmax[0] = ent.maxs[0] - 25;
  tmax[1] = ent.maxs[1] - 25;
  tmax[2] = ent.maxs[2] + 8;

  tmin[2] = tmax[2] - (ent.pos1[2] - ent.pos2[2] + st.lip);

  if ((ent.spawnflags & PLAT_LOW_TRIGGER) !== 0) tmax[2] = tmin[2] + 8;

  if (tmax[0] - tmin[0] <= 0) {
    tmin[0] = (ent.mins[0] + ent.maxs[0]) * 0.5;
    tmax[0] = tmin[0] + 1;
  }
  if (tmax[1] - tmin[1] <= 0) {
    tmin[1] = (ent.mins[1] + ent.maxs[1]) * 0.5;
    tmax[1] = tmin[1] + 1;
  }

  VectorCopy(tmin, trigger.mins);
  VectorCopy(tmax, trigger.maxs);

  gi.linkentity(trigger);

  return trigger;
}

function plat2_spawn_danger_area(ent: EdictT): void {
  const mins = vec3(ent.mins[0], ent.mins[1], ent.mins[2]);
  const maxs = vec3(ent.maxs[0], ent.maxs[1], ent.maxs[2]);
  maxs[2] = ent.mins[2] + 64;

  SpawnBadArea(mins, maxs, 0, ent);
}

function plat2_kill_danger_area(ent: EdictT): void {
  let t: EdictT | null = null;
  while ((t = G_Find(t, "classname", "bad_area")) !== null) {
    if (t.owner === ent) G_FreeEdict(t);
  }
}

function plat2_hit_top(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_TOP;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_down;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) === 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_down;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  G_UseTargets(ent, ent);
}

function plat2_hit_bottom(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_BOTTOM;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_up;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) !== 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_up;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  plat2_kill_danger_area(ent);
  G_UseTargets(ent, ent);
}

function plat2_go_down(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_DOWN;
  ent.plat2flags |= PLAT2_MOVING;

  Move_Calc(ent, ent.moveinfo.end_origin, plat2_hit_bottom);
}

function plat2_go_up(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_UP;
  ent.plat2flags |= PLAT2_MOVING;

  plat2_spawn_danger_area(ent);

  Move_Calc(ent, ent.moveinfo.start_origin, plat2_hit_top);
}

function plat2_operate(triggerEnt: EdictT, other: EdictT): void {
  const trigger = triggerEnt;
  const plat = triggerEnt.enemy; // now point at the plat, not the trigger
  if (plat === null) return; // guards TS null-safety; always set when trigger.touch === Touch_Plat_Center2

  if ((plat.plat2flags & PLAT2_MOVING) !== 0) return;

  if (plat.last_move_time + 2 > level.time) return;

  const platCenter = (trigger.absmin[2] + trigger.absmax[2]) / 2;

  let otherState: number;
  if (plat.moveinfo.state === STATE_TOP) {
    otherState = STATE_TOP;
    if ((plat.spawnflags & PLAT2_BOX_LIFT) !== 0) {
      if (platCenter > other.s.origin[2]) otherState = STATE_BOTTOM;
    } else {
      if (trigger.absmax[2] > other.s.origin[2]) otherState = STATE_BOTTOM;
    }
  } else {
    otherState = STATE_BOTTOM;
    if (other.s.origin[2] > platCenter) otherState = STATE_TOP;
  }

  plat.plat2flags = PLAT2_MOVING;

  let pauseTime: number;
  if (cvarNum(gameCvars.deathmatch) !== 0) pauseTime = 0.3;
  else pauseTime = 0.5;

  if (plat.moveinfo.state !== otherState) {
    plat.plat2flags |= PLAT2_CALLED;
    pauseTime = 0.1;
  }

  plat.last_move_time = level.time;

  if (plat.moveinfo.state === STATE_BOTTOM) {
    plat.think = plat2_go_up;
    plat.nextthink = level.time + pauseTime;
  } else {
    plat.think = plat2_go_down;
    plat.nextthink = level.time + pauseTime;
  }
}

function plat2_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  // gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, 0, MOD_CRUSH);
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);

  if (self.moveinfo.state === STATE_UP) plat2_go_down(self);
  else if (self.moveinfo.state === STATE_DOWN) plat2_go_up(self);
}

function Use_Plat2(ent: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (ent.moveinfo.state > STATE_BOTTOM) return;
  if (ent.last_move_time + 2 > level.time) return;
  // plat2_operate unconditionally dereferences its `other` param (C would
  // crash on a NULL activator here too); guarded for TS's nullable `use`
  // signature rather than left as an unchecked dereference.
  if (activator === null) return;

  for (let i = 1; i < globals.num_edicts; i++) {
    const trigger = g_edicts[i];
    if (!trigger.inuse) continue;
    if (trigger.touch === Touch_Plat_Center2 && trigger.enemy === ent) {
      plat2_operate(trigger, activator);
      return;
    }
  }
}

function plat2_activate(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.use = Use_Plat2;

  const trigger = plat2_spawn_inside_trigger(ent); // the "start moving" trigger

  trigger.maxs[0] += 10;
  trigger.maxs[1] += 10;
  trigger.mins[0] -= 10;
  trigger.mins[1] -= 10;

  gi.linkentity(trigger);

  trigger.touch = Touch_Plat_Center2; // Override trigger touch function

  plat2_go_down(ent);
}

/*QUAKED func_plat2 (0 .5 .8) ? PLAT_LOW_TRIGGER PLAT2_TOGGLE PLAT2_TOP PLAT2_TRIGGER_TOP PLAT2_TRIGGER_BOTTOM BOX_LIFT
speed	default 150

PLAT_LOW_TRIGGER - creates a short trigger field at the bottom
PLAT2_TOGGLE - plat will not return to default position.
PLAT2_TOP - plat's default position will the the top.
PLAT2_TRIGGER_TOP - plat will trigger it's targets each time it hits top
PLAT2_TRIGGER_BOTTOM - plat will trigger it's targets each time it hits bottom
BOX_LIFT - this indicates that the lift is a box, rather than just a platform

Plats are always drawn in the extended position, so they will light correctly.

If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.

"speed"	overrides default 200.
"accel" overrides default 500
"lip"	no default

If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determoveinfoned by the model's height.
*/
export function SP_func_plat2(ent: EdictT): void {
  VectorClear(ent.s.angles);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = plat2_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ent.speed *= 2;
    ent.accel *= 2;
    ent.decel *= 2;
  }

  // PMM Added to kill things it's being blocked by
  if (!ent.dmg) ent.dmg = 2;

  // pos1 is the top position, pos2 is the bottom
  VectorCopy(ent.s.origin, ent.pos1);
  VectorCopy(ent.s.origin, ent.pos2);

  if (st.height) ent.pos2[2] -= st.height - st.lip;
  else ent.pos2[2] -= ent.maxs[2] - ent.mins[2] - st.lip;

  ent.moveinfo.state = STATE_TOP;

  // rogue/g_rogue_func.cpp:391 -- see PLAT2_START_ACTIVE's note above.
  if (ent.targetname !== null && (ent.spawnflags & PLAT2_START_ACTIVE) === 0) {
    ent.use = plat2_activate;
  } else {
    ent.use = Use_Plat2;

    const trigger = plat2_spawn_inside_trigger(ent); // the "start moving" trigger

    // PGM - debugging??
    trigger.maxs[0] += 10;
    trigger.maxs[1] += 10;
    trigger.mins[0] -= 10;
    trigger.mins[1] -= 10;

    gi.linkentity(trigger);

    trigger.touch = Touch_Plat_Center2; // Override trigger touch function

    if ((ent.spawnflags & PLAT2_TOP) === 0) {
      VectorCopy(ent.pos2, ent.s.origin);
      ent.moveinfo.state = STATE_BOTTOM;
    }
  }

  gi.linkentity(ent);

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  ent.moveinfo.sound_start = gi.soundindex("plats/pt1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("plats/pt1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("plats/pt1_end.wav");
}

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

// -------------------------------------------------------------------------
// Savegame function registry -- see g_save.ts's registerSaveFunction.
// -------------------------------------------------------------------------
registerSaveFunction("g_newfnc:plat2_hit_top", plat2_hit_top);
registerSaveFunction("g_newfnc:plat2_hit_bottom", plat2_hit_bottom);
registerSaveFunction("g_newfnc:plat2_go_down", plat2_go_down);
registerSaveFunction("g_newfnc:plat2_go_up", plat2_go_up);
registerSaveFunction("g_newfnc:plat2_blocked", plat2_blocked);
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

registerSaveFunction("g_newfnc:Use_Plat2", Use_Plat2);
registerSaveFunction("g_newfnc:plat2_activate", plat2_activate);
registerSaveFunction("g_newfnc:Touch_Plat_Center2", Touch_Plat_Center2);
registerSaveFunction("g_newfnc:rotating_light_alarm", rotating_light_alarm);
registerSaveFunction("g_newfnc:rotating_light_killed", rotating_light_killed);
registerSaveFunction("g_newfnc:rotating_light_use", rotating_light_use);
registerSaveFunction("g_newfnc:object_repair_fx", object_repair_fx);
registerSaveFunction("g_newfnc:object_repair_dead", object_repair_dead);
registerSaveFunction("g_newfnc:object_repair_sparks", object_repair_sparks);
