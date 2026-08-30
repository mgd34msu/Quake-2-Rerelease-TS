// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_func.cpp -- xatrix (Ground Zero mission pack) func_/misc entity
// family: `rotating_light` (a spinning, damageable light fixture) and
// `func_object_repair` (a weldable "object to be repaired" prop, the thing
// fixbot's welder targets). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_func.cpp (179
// lines, C++17). Behavioral code, ported bug-for-bug per PORTING.md.
//
// SP_rotating_light / SP_object_repair are NOT registered in g_spawn.ts by
// this unit (out of scope per this unit's brief -- see report's "SP list").
// g_spawn.ts already carries `unported(...)` placeholders for both
// `rotating_light` and `func_object_repair` citing this file's future path.

import { vec3, type Vec3 } from "../shared/math";
import { ATTN_NORM, ATTN_STATIC, ContentsT, EffectsT, KexMulticastT, KexTempEventT, ServerCommandT, SoundchanT, SolidT, type KexTraceT } from "../kexapi/game";
import { type DieFn, type EdictT, type ModT, type ThinkFn, type UseFn, MovetypeT } from "./g_local";
import { RegisterDie, RegisterThink, RegisterUse } from "./g_save_registry";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "./gtime";
import { G_FreeEdict, G_UseTargets } from "./g_utils";
import { irandom } from "./q_std";
import { SpawnFlags_from, SpawnFlags_has, SpawnFlags_and, SpawnFlags_not, type SpawnFlags } from "./spawnflags";

const vec3_origin = vec3(0, 0, 0);

// ---------------------------------------------------------------------------
// rotating_light (g_xatrix_func.cpp:6-113)
// ---------------------------------------------------------------------------

const SPAWNFLAG_ROTATING_LIGHT_START_OFF: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_ROTATING_LIGHT_ALARM: SpawnFlags = SpawnFlags_from(2);

/** `THINK(rotating_light_alarm)` (g_xatrix_func.cpp:18-30). */
const rotating_light_alarm: ThinkFn = RegisterThink("rotating_light_alarm", (self: EdictT): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_LIGHT_START_OFF)) {
    self.think = null;
    self.nextthink = GTIME_ZERO;
  } else {
    gi.sound(self, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, self.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  }
});

/** `DIE(rotating_light_killed)` (g_xatrix_func.cpp:32-47). */
const rotating_light_killed: DieFn = RegisterDie(
  "rotating_light_killed",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_WELDING_SPARKS);
    gi.WriteByte(30);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(vec3_origin);
    gi.WriteByte(irandom(0xe0, 0xe8));
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

    self.s.effects &= ~EffectsT.EF_SPINNINGLIGHTS;
    self.use = null;

    self.think = G_FreeEdict;
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s));
  },
);

/** `USE(rotating_light_use)` (g_xatrix_func.cpp:49-67). */
const rotating_light_use: UseFn = RegisterUse("rotating_light_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_LIGHT_START_OFF)) {
    self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_ROTATING_LIGHT_START_OFF));
    self.s.effects |= EffectsT.EF_SPINNINGLIGHTS;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_LIGHT_ALARM)) {
      self.think = rotating_light_alarm;
      self.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s));
    }
  } else {
    self.spawnflags = SpawnFlags_from(self.spawnflags | SPAWNFLAG_ROTATING_LIGHT_START_OFF);
    self.s.effects &= ~EffectsT.EF_SPINNINGLIGHTS;
  }
});

/**
 * QUAKED rotating_light (0 .5 .8) (-8 -8 -8) (8 8 8) START_OFF ALARM
 * `void SP_rotating_light(edict_t *self)` (g_xatrix_func.cpp:69-113).
 */
export function SP_rotating_light(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_STOP;
  self.solid = SolidT.SOLID_BBOX;

  self.s.modelindex = gi.modelindex("models/objects/light/tris.md2");

  self.s.frame = 0;

  self.use = rotating_light_use;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_LIGHT_START_OFF)) self.s.effects &= ~EffectsT.EF_SPINNINGLIGHTS;
  else self.s.effects |= EffectsT.EF_SPINNINGLIGHTS;

  if (!self.speed) self.speed = 32;
  // this is a real cheap way to set the radius of the light
  // self.s.frame = self.speed;

  self.health = self.health || 10;
  self.max_health = self.health;
  self.die = rotating_light_killed;
  self.takedamage = true;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ROTATING_LIGHT_ALARM)) {
    self.moveinfo.sound_start = gi.soundindex("misc/alarm.wav");
  }

  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// func_object_repair (g_xatrix_func.cpp:115-179)
// ---------------------------------------------------------------------------

/** `THINK(object_repair_fx)` (g_xatrix_func.cpp:121-137). */
const object_repair_fx: ThinkFn = RegisterThink("object_repair_fx", (ent: EdictT): void => {
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(ent.delay));

  if (ent.health <= 100) {
    ent.health++;
  } else {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_WELDING_SPARKS);
    gi.WriteByte(10);
    gi.WritePosition(ent.s.origin);
    gi.WriteDir(vec3_origin);
    gi.WriteByte(irandom(0xe0, 0xe8));
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);
  }
});

/** `THINK(object_repair_dead)` (g_xatrix_func.cpp:139-144). */
const object_repair_dead: ThinkFn = RegisterThink("object_repair_dead", (ent: EdictT): void => {
  G_UseTargets(ent, ent);
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz10());
  ent.think = object_repair_fx;
});

/** `THINK(object_repair_sparks)` (g_xatrix_func.cpp:146-164). */
const object_repair_sparks: ThinkFn = RegisterThink("object_repair_sparks", (ent: EdictT): void => {
  if (ent.health <= 0) {
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz10());
    ent.think = object_repair_dead;
    return;
  }

  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(ent.delay));

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_WELDING_SPARKS);
  gi.WriteByte(10);
  gi.WritePosition(ent.s.origin);
  gi.WriteDir(vec3_origin);
  gi.WriteByte(irandom(0xe0, 0xe8));
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);
});

/**
 * QUAKED func_object_repair (1 .5 0) (-8 -8 -8) (8 8 8)
 * `void SP_object_repair(edict_t *ent)` (g_xatrix_func.cpp:166-179).
 */
export function SP_object_repair(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_BBOX;
  ent.classname = "object_repair";
  ent.mins = vec3(-8, -8, 8);
  ent.maxs = vec3(8, 8, 8);
  ent.think = object_repair_sparks;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  ent.health = 100;
  if (!ent.delay) ent.delay = 1.0;
}

// ---------------------------------------------------------------------------
// small per-file helpers -- see file header convention note
// ---------------------------------------------------------------------------

function Gtime_from_hz10() {
  return Gtime_from_sec(0.1);
}
