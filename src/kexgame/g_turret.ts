// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_turret.c -- the three-part turret entity family (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_turret.cpp (661 lines,
// C++17): AnglesNormalize, turret_blocked, turret_breach_fire,
// turret_breach_think, turret_breach_finish_init, SP_turret_breach,
// SP_turret_base, turret_driver_die, turret_driver_think,
// turret_driver_link, SP_turret_driver, and the ROGUE-era
// turret_brain_think/turret_brain_link/turret_brain_deactivate/
// turret_brain_activate/SP_turret_invisible_brain family. Behavioral code,
// ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/g_utils.ts headers).
//
// ============================================================================
// `st` (spawn_temp_t) -- permanently-default placeholder, per-file duplicate
// ============================================================================
// Same treatment as g_trigger.ts/g_target.ts/g_misc.ts's own `st` locals:
// `spawn_temp_t` has no canonical home yet (no src/kexgame/g_spawn.ts exists
// -- confirmed by directory listing), so this file carries its own
// permanently-zeroed `SpawnTempT` object, read (never meaningfully written)
// by SP_turret_breach/SP_turret_base/SP_turret_driver.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (throwing stubs, cited)
// ============================================================================
// - `infantry_die`/`infantry_stand`/`infantry_pain`/`infantry_setskin`/
//   `InfantryPrecache` -> m_infantry.cpp (monster content, excluded from this
//   porting round -- confirmed by directory listing: no src/kexgame/
//   m_infantry.ts exists, matching the brief's "monster/mission-pack content
//   dirs" exclusion). `SP_turret_driver` calls `InfantryPrecache()`
//   unconditionally on every non-deathmatch invocation, so `SP_turret_driver`
//   genuinely always throws today for a non-deathmatch spawn -- an honest
//   consequence of the missing monster unit, not a silent behavior change,
//   mirroring g_cmds.ts's own "Cmd_Spawn_f... always throws" precedent for
//   the identical kind of gap. `turret_driver_die`'s tail call to
//   `infantry_die` is reached only if a real infantry-shaped driver entity
//   ever exists, which -- given the above -- it cannot yet.
// - `monster_think`/`monster_use` -> REAL, landed imports from g_monster.ts
//   (not stubbed).
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `player_skinnum_t`/pointer-cast patterns do not appear in this file (that
//   concern belongs to g_main.ts's Entity_UpdateState family instead).
// - `AnglesNormalize(vec3_t &vec)` mutates its argument by reference in C++;
//   `Vec3` is a `Float32Array` here, so in-place mutation of indices 0/1
//   (pitch/yaw only -- the C++ function never touches index 2) is the
//   direct, reference-preserving equivalent, not a functional-style copy.
// - `edictFmt`/`frameTimeAsGtime`/`cvarInt` local helpers: duplicated
//   per-file, not imported, matching every other landed kexgame module's own
//   established precedent (see g_func.ts/g_phys.ts headers).
// - Vec3 "copy" sites (`self->s.old_origin = self->s.origin`-shaped C++
//   value-semantics assignments) use `vec3(v[0], v[1], v[2])`, matching
//   p_client.ts's/g_weapon.ts's own established idiom for the same concern
//   (a `Vec3` is a mutable `Float32Array`; a bare `=` would alias instead of
//   copy).
// - `noUncheckedIndexedAccess` is off project-wide (tsconfig.json), so plain
//   `Vec3` indexing (`v[0]`) already types as `number`, matching every other
//   landed file's convention of never needing a non-null assertion there.

import { vec3, type Vec3 } from "../shared/math";
import {
  type EdictT,
  type ThinkFn,
  type UseFn,
  type DieFn,
  type MoveinfoBlockedFn,
  type SpawnTempT,
  type ModT,
  EntFlagsT,
  ModIdT,
  MonsterAiFlagsT,
  MovetypeT,
  DamageflagsT,
} from "./g_local";
import { ShadowLightTypeT, SolidT, SoundchanT, SvflagsT, ATTN_NORM, MASK_MONSTERSOLID, MASK_SHOT, type CvarFlagsT } from "../kexapi/game";
import { RegisterThink, RegisterUse, RegisterDie, RegisterMoveinfoBlocked } from "./g_save_registry";
import { gi, level } from "./g_main_globals";
import { G_PickTarget, G_FreeEdict } from "./g_utils";
import { T_Damage } from "./g_combat";
import { fire_rocket } from "./g_weapon";
import { FindTarget, visible } from "./g_ai";
import { G_FixStuckObject, monster_think, monster_use } from "./g_monster";
import { FindItemByClassname } from "./g_items";
import { AngleVectors, vectoangles, vec3_origin, vec3_sub, vec3_add, vec3_muls } from "./q_vec3";
import { frandom } from "./q_std";
import { type GTime, GTIME_ZERO, Gtime_add, Gtime_from_ms, Gtime_from_sec } from "./gtime";
import { SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_not, type SpawnFlags } from "./spawnflags";

// ---------------------------------------------------------------------------
// small local helpers -- duplicated per-file, see file header
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = 0): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

/** `st` (spawn_temp_t) -- see file header. */
const st: SpawnTempT = {
  sky: null,
  skyrotate: 0,
  skyaxis: vec3(0, 0, 0),
  skyautorotate: 1,
  nextmap: null,
  lip: 0,
  distance: 0,
  height: 0,
  noise: null,
  pausetime: 0,
  item: null,
  gravity: null,
  minyaw: 0,
  maxyaw: 0,
  minpitch: 0,
  maxpitch: 0,
  sl: {
    data: { lighttype: ShadowLightTypeT.point, radius: 0, resolution: 0, intensity: 1, fade_start: 0, fade_end: 0, lightstyle: -1, coneangle: 45, conedirection: vec3(0, 0, 0) },
    lightstyletarget: null,
  },
  music: null,
  instantitems: 0,
  radius: 0,
  hub_map: false,
  achievement: null,
  goals: null,
  image: null,
  fade_start_dist: 96,
  fade_end_dist: 384,
  start_items: null,
  no_grapple: 0,
  health_multiplier: 1.0,
  reinforcements: null,
  noise_start: null,
  noise_middle: null,
  noise_end: null,
  loop_count: 0,
  keys_specified: new Set<string>(),
};

// ---------------------------------------------------------------------------
// unported cross-deps (throwing stubs) -- see file header
// ---------------------------------------------------------------------------

function infantry_die(_self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void {
  throw new Error("infantry_die: not yet ported (monster content dir, pending m_infantry.ts, see m_infantry.cpp)");
}
function infantry_stand(_self: EdictT): void {
  throw new Error("infantry_stand: not yet ported (monster content dir, pending m_infantry.ts, see m_infantry.cpp)");
}
function infantry_pain(_self: EdictT, _other: EdictT, _kick: number, _damage: number, _mod: ModT): void {
  throw new Error("infantry_pain: not yet ported (monster content dir, pending m_infantry.ts, see m_infantry.cpp)");
}
function infantry_setskin(_self: EdictT): void {
  throw new Error("infantry_setskin: not yet ported (monster content dir, pending m_infantry.ts, see m_infantry.cpp)");
}
function InfantryPrecache(): void {
  throw new Error(
    "InfantryPrecache: not yet ported (monster content dir, pending m_infantry.ts, see m_infantry.cpp) -- SP_turret_driver's only caller always reaches this outside deathmatch",
  );
}

// ---------------------------------------------------------------------------
// AnglesNormalize (g_turret.cpp:9-19)
// ---------------------------------------------------------------------------

/** g_turret.cpp:9-19: `void AnglesNormalize(vec3_t &vec)`. Mutates `vec` in place -- see file header. */
export function AnglesNormalize(vec: Vec3): void {
  while (vec[0] > 360) vec[0] -= 360;
  while (vec[0] < 0) vec[0] += 360;
  while (vec[1] > 360) vec[1] -= 360;
  while (vec[1] < 0) vec[1] += 360;
}

// ---------------------------------------------------------------------------
// turret_blocked (g_turret.cpp:21-33)
// ---------------------------------------------------------------------------

/** g_turret.cpp:21-33: `MOVEINFO_BLOCKED(turret_blocked)`. */
export const turret_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("turret_blocked", (self: EdictT, other: EdictT): void => {
  if (other.takedamage) {
    if (self.teammaster === null) throw new Error("turret_blocked: self.teammaster is null -- the C++ source dereferences it unconditionally here");
    const attacker = self.teammaster.owner !== null ? self.teammaster.owner : self.teammaster;
    const mod: ModT = { id: ModIdT.MOD_CRUSH, friendly_fire: false, no_point_loss: false };
    T_Damage(other, self, attacker, vec3_origin, other.s.origin, vec3_origin, self.teammaster.dmg, 10, DamageflagsT.DAMAGE_NONE, mod);
  }
});

// ---------------------------------------------------------------------------
// turret_breach (g_turret.cpp:35-257)
// ---------------------------------------------------------------------------

const SPAWNFLAG_TURRET_BREACH_FIRE: SpawnFlags = SpawnFlags_from(65536);

/** g_turret.cpp:51-72: `void turret_breach_fire(edict_t *self)`. */
export function turret_breach_fire(self: EdictT): void {
  const f = vec3();
  const r = vec3();
  const u = vec3();
  AngleVectors(self.s.angles, f, r, u);

  const start = vec3(
    self.s.origin[0] + f[0] * self.move_origin[0] + r[0] * self.move_origin[1] + u[0] * self.move_origin[2],
    self.s.origin[1] + f[1] * self.move_origin[0] + r[1] * self.move_origin[1] + u[1] * self.move_origin[2],
    self.s.origin[2] + f[2] * self.move_origin[0] + r[2] * self.move_origin[1] + u[2] * self.move_origin[2],
  );

  const damage = self.count ? self.count : Math.trunc(frandom(100, 150));
  const speed = 550 + 50 * cvarInt("skill", "1");

  if (self.teammaster === null) throw new Error("turret_breach_fire: self.teammaster is null -- the C++ source dereferences it unconditionally here");
  if (self.teammaster.owner === null) throw new Error("turret_breach_fire: self.teammaster.owner is null -- the C++ source dereferences it unconditionally here");
  const owner = self.teammaster.owner;
  const rocketOwner = owner.activator !== null ? owner.activator : owner;
  const rocket = fire_rocket(rocketOwner, start, f, damage, speed, 150, damage);
  rocket.s.scale = self.teammaster.dmg_radius;

  gi.positioned_sound(start, self, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/rocklf1a.wav"), 1, ATTN_NORM, 0);
}

/** g_turret.cpp:74-191: `THINK(turret_breach_think)`. */
export const turret_breach_think: ThinkFn = RegisterThink("turret_breach_think", (self: EdictT): void => {
  const current_angles = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
  AnglesNormalize(current_angles);

  AnglesNormalize(self.move_angles);
  if (self.move_angles[0] > 180) self.move_angles[0] -= 360;

  // clamp angles to mins & maxs
  if (self.move_angles[0] > self.pos1[0]) self.move_angles[0] = self.pos1[0];
  else if (self.move_angles[0] < self.pos2[0]) self.move_angles[0] = self.pos2[0];

  if (self.move_angles[1] < self.pos1[1] || self.move_angles[1] > self.pos2[1]) {
    let dmin = Math.abs(self.pos1[1] - self.move_angles[1]);
    if (dmin < -180) dmin += 360;
    else if (dmin > 180) dmin -= 360;
    let dmax = Math.abs(self.pos2[1] - self.move_angles[1]);
    if (dmax < -180) dmax += 360;
    else if (dmax > 180) dmax -= 360;
    if (Math.abs(dmin) < Math.abs(dmax)) self.move_angles[1] = self.pos1[1];
    else self.move_angles[1] = self.pos2[1];
  }

  const delta = vec3(self.move_angles[0] - current_angles[0], self.move_angles[1] - current_angles[1], self.move_angles[2] - current_angles[2]);
  if (delta[0] < -180) delta[0] += 360;
  else if (delta[0] > 180) delta[0] -= 360;
  if (delta[1] < -180) delta[1] += 360;
  else if (delta[1] > 180) delta[1] -= 360;
  delta[2] = 0;

  const frameTimeS = gi.frame_time_s;
  if (delta[0] > self.speed * frameTimeS) delta[0] = self.speed * frameTimeS;
  if (delta[0] < -1 * self.speed * frameTimeS) delta[0] = -1 * self.speed * frameTimeS;
  if (delta[1] > self.speed * frameTimeS) delta[1] = self.speed * frameTimeS;
  if (delta[1] < -1 * self.speed * frameTimeS) delta[1] = -1 * self.speed * frameTimeS;

  if (self.teammaster === null) throw new Error("turret_breach_think: self.teammaster is null -- the C++ source dereferences it unconditionally here");
  for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) {
    if (ent.noise_index) {
      if (delta[0] || delta[1]) {
        ent.s.sound = ent.noise_index;
        ent.s.loop_attenuation = ATTN_NORM;
      } else {
        ent.s.sound = 0;
      }
    }
  }

  self.avelocity = vec3_muls(delta, 1.0 / frameTimeS);

  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  for (let ent: EdictT | null = self.teammaster; ent !== null; ent = ent.teamchain) {
    ent.avelocity[1] = self.avelocity[1];
  }

  // if we have a driver, adjust his velocities
  if (self.owner !== null) {
    const owner = self.owner;

    // angular is easy, just copy ours
    owner.avelocity[0] = self.avelocity[0];
    owner.avelocity[1] = self.avelocity[1];

    // x & y
    let angle = self.s.angles[1] + owner.move_origin[1];
    angle *= (Math.PI * 2) / 360;
    const target = vec3(self.s.origin[0] + Math.cos(angle) * owner.move_origin[0], self.s.origin[1] + Math.sin(angle) * owner.move_origin[0], owner.s.origin[2]);

    const dir = vec3_sub(target, owner.s.origin);
    owner.velocity[0] = (dir[0] * 1.0) / frameTimeS;
    owner.velocity[1] = (dir[1] * 1.0) / frameTimeS;

    // z
    angle = self.s.angles[0] * ((Math.PI * 2) / 360);
    const target_z = self.s.origin[2] + owner.move_origin[0] * Math.tan(angle) + owner.move_origin[2];

    const diff = target_z - owner.s.origin[2];
    owner.velocity[2] = (diff * 1.0) / frameTimeS;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BREACH_FIRE)) {
      turret_breach_fire(self);
      self.spawnflags = SpawnFlags_and(self.spawnflags, SpawnFlags_not(SPAWNFLAG_TURRET_BREACH_FIRE));
    }
  }
});

/** g_turret.cpp:193-216: `THINK(turret_breach_finish_init)`. */
export const turret_breach_finish_init: ThinkFn = RegisterThink("turret_breach_finish_init", (self: EdictT): void => {
  // get and save info for muzzle location
  if (self.target === null) {
    gi.Com_Print(`${edictFmt(self)}: needs a target\n`);
  } else {
    self.target_ent = G_PickTarget(self.target);
    if (self.target_ent !== null) {
      self.move_origin = vec3_sub(self.target_ent.s.origin, self.s.origin);
      G_FreeEdict(self.target_ent);
      self.target_ent = null;
    } else {
      gi.Com_Print(`${edictFmt(self)}: could not find target entity "${self.target}"\n`);
    }
  }

  if (self.teammaster === null) throw new Error("turret_breach_finish_init: self.teammaster is null -- the C++ source dereferences it unconditionally here");
  self.teammaster.dmg = self.dmg;
  self.teammaster.dmg_radius = self.dmg_radius; // scale
  self.think = turret_breach_think;
  self.think(self);
});

/** g_turret.cpp:218-257: `void SP_turret_breach(edict_t *self)`. */
export function SP_turret_breach(self: EdictT): void {
  self.solid = SolidT.SOLID_BSP;
  self.movetype = MovetypeT.MOVETYPE_PUSH;

  if (st.noise !== null) self.noise_index = gi.soundindex(st.noise);

  if (self.model === null) throw new Error("SP_turret_breach: self.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(self, self.model);

  if (!self.speed) self.speed = 50;
  if (!self.dmg) self.dmg = 10;

  if (!st.minpitch) st.minpitch = -30;
  if (!st.maxpitch) st.maxpitch = 30;
  if (!st.maxyaw) st.maxyaw = 360;

  self.pos1[0] = -1 * st.minpitch;
  self.pos1[1] = st.minyaw;
  self.pos2[0] = -1 * st.maxpitch;
  self.pos2[1] = st.maxyaw;

  // scale used for rocket scale
  self.dmg_radius = self.s.scale;
  self.s.scale = 0;

  self.ideal_yaw = self.s.angles[1];
  self.move_angles[1] = self.ideal_yaw;

  self.moveinfo.blocked = turret_blocked;

  self.think = turret_breach_finish_init;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// turret_base (g_turret.cpp:259-275)
// ---------------------------------------------------------------------------

/** g_turret.cpp:264-275: `void SP_turret_base(edict_t *self)`. */
export function SP_turret_base(self: EdictT): void {
  self.solid = SolidT.SOLID_BSP;
  self.movetype = MovetypeT.MOVETYPE_PUSH;

  if (st.noise !== null) self.noise_index = gi.soundindex(st.noise);

  if (self.model === null) throw new Error("SP_turret_base: self.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(self, self.model);
  self.moveinfo.blocked = turret_blocked;
  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// turret_driver (g_turret.cpp:277-463)
// ---------------------------------------------------------------------------

/** g_turret.cpp:287-321: `DIE(turret_driver_die)`. */
export const turret_driver_die: DieFn = RegisterDie("turret_driver_die", (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3, mod: ModT): void => {
  if (!self.deadflag) {
    if (self.target_ent === null) throw new Error("turret_driver_die: self.target_ent is null -- the C++ source dereferences it unconditionally here");
    const targetEnt = self.target_ent;

    // level the gun
    targetEnt.move_angles[0] = 0;

    // remove the driver from the end of the team chain
    if (targetEnt.teammaster === null) throw new Error("turret_driver_die: self.target_ent.teammaster is null -- the C++ source dereferences it unconditionally here");
    let ent: EdictT = targetEnt.teammaster;
    while (ent.teamchain !== self) {
      if (ent.teamchain === null) throw new Error("turret_driver_die: walked off the end of the team chain without finding self");
      ent = ent.teamchain;
    }
    ent.teamchain = null;
    self.teammaster = null;
    self.flags &= ~EntFlagsT.FL_TEAMSLAVE;

    targetEnt.owner = null;
    if (targetEnt.teammaster !== null) targetEnt.teammaster.owner = null;

    targetEnt.moveinfo.blocked = null;

    // clear pitch
    self.s.angles[0] = 0;
    self.movetype = MovetypeT.MOVETYPE_STEP;

    self.think = monster_think;
  }

  infantry_die(self, inflictor, attacker, damage, point, mod);

  G_FixStuckObject(self, self.s.origin);
  const vel = vec3();
  AngleVectors(self.s.angles, vel, null, null);
  self.velocity = vec3_muls(vel, -50);
  self.velocity[2] += 110;
});

/** g_turret.cpp:325-376: `THINK(turret_driver_think)`. */
export const turret_driver_think: ThinkFn = RegisterThink("turret_driver_think", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (self.enemy !== null && (!self.enemy.inuse || self.enemy.health <= 0)) self.enemy = null;

  if (self.enemy === null) {
    if (!FindTarget(self)) return;
    self.monsterinfo.trail_time = level.time;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;
  } else {
    if (visible(self, self.enemy)) {
      if (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) {
        self.monsterinfo.trail_time = level.time;
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;
      }
    } else {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_LOST_SIGHT;
      return;
    }
  }

  if (self.target_ent === null) throw new Error("turret_driver_think: self.target_ent is null -- the C++ source dereferences it unconditionally here");
  if (self.enemy === null) throw new Error("turret_driver_think: self.enemy is null -- invariant violated (FindTarget/visible path above must set it)");

  // let the turret know where we want it to aim
  const target = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_sub(target, self.target_ent.s.origin);
  self.target_ent.move_angles = vectoangles(dir);

  // decide if we should shoot
  if (level.time < self.monsterinfo.attack_finished) return;

  const reaction_time = Gtime_from_sec(3 - cvarInt("skill", "1"));
  if (level.time - self.monsterinfo.trail_time < reaction_time) return;

  self.monsterinfo.attack_finished = Gtime_add(Gtime_add(level.time, reaction_time), Gtime_from_sec(1));
  // FIXME how do we really want to pass this along?
  self.target_ent.spawnflags = SpawnFlags_or(self.target_ent.spawnflags, SPAWNFLAG_TURRET_BREACH_FIRE);
});

/** g_turret.cpp:378-409: `THINK(turret_driver_link)`. */
export const turret_driver_link: ThinkFn = RegisterThink("turret_driver_link", (self: EdictT): void => {
  self.think = turret_driver_think;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (self.target === null) throw new Error("turret_driver_link: self.target is null -- the C++ source dereferences it unconditionally here");
  const targetEnt = G_PickTarget(self.target);
  if (targetEnt === null) throw new Error("turret_driver_link: G_PickTarget found no entity -- the C++ source dereferences the result unconditionally here");
  self.target_ent = targetEnt;
  targetEnt.owner = self;
  if (targetEnt.teammaster === null) throw new Error("turret_driver_link: target_ent.teammaster is null -- the C++ source dereferences it unconditionally here");
  targetEnt.teammaster.owner = self;
  self.s.angles = vec3(targetEnt.s.angles[0], targetEnt.s.angles[1], targetEnt.s.angles[2]);

  const vec = vec3(targetEnt.s.origin[0] - self.s.origin[0], targetEnt.s.origin[1] - self.s.origin[1], 0);
  self.move_origin[0] = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);

  let vec2 = vec3_sub(self.s.origin, targetEnt.s.origin);
  vec2 = vectoangles(vec2);
  AnglesNormalize(vec2);
  self.move_origin[1] = vec2[1];

  self.move_origin[2] = self.s.origin[2] - targetEnt.s.origin[2];

  // add the driver to the end of the team chain
  let ent: EdictT = targetEnt.teammaster;
  while (ent.teamchain !== null) ent = ent.teamchain;
  ent.teamchain = self;
  self.teammaster = targetEnt.teammaster;
  self.flags |= EntFlagsT.FL_TEAMSLAVE;
});

/** g_turret.cpp:413-463: `void SP_turret_driver(edict_t *self)`. */
export function SP_turret_driver(self: EdictT): void {
  if (cvarInt("deathmatch", "0")) {
    G_FreeEdict(self);
    return;
  }

  InfantryPrecache();

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/infantry/tris.md2");
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);

  self.health = self.max_health = 100;
  self.gib_health = -40;
  self.mass = 200;
  self.viewheight = 24;

  self.pain = infantry_pain;
  self.die = turret_driver_die;
  self.monsterinfo.stand = infantry_stand;

  self.flags |= EntFlagsT.FL_NO_KNOCKBACK;

  if (cvarInt("g_debug_monster_kills", "0")) level.monsters_registered[level.total_monsters] = self;
  level.total_monsters++;

  self.svflags |= SvflagsT.SVF_MONSTER;
  self.takedamage = true;
  self.use = monster_use;
  self.clipmask = MASK_MONSTERSOLID;
  self.s.old_origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
  self.monsterinfo.setskin = infantry_setskin;

  if (st.item !== null) {
    self.item = FindItemByClassname(st.item);
    if (self.item === null) gi.Com_Print(`${edictFmt(self)}: bad item: ${st.item}\n`);
  }

  self.think = turret_driver_link;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  gi.linkentity(self);
}

// ============================================================================
// ROGUE -- invisible turret drivers (g_turret.cpp:465-661)
// ============================================================================

const SPAWNFLAG_TURRET_BRAIN_IGNORE_SIGHT: SpawnFlags = SpawnFlags_from(1);

/** g_turret.cpp:475-543: `THINK(turret_brain_think)`. */
export const turret_brain_think: ThinkFn = RegisterThink("turret_brain_think", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (self.enemy !== null) {
    if (!self.enemy.inuse) self.enemy = null;
    else if (self.enemy.takedamage && self.enemy.health <= 0) self.enemy = null;
  }

  if (self.enemy === null) {
    if (!FindTarget(self)) return;
    self.monsterinfo.trail_time = level.time;
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;
  }

  if (self.enemy === null) throw new Error("turret_brain_think: self.enemy is null after FindTarget succeeded -- invariant violated");
  const endpos = vec3_muls(vec3_add(self.enemy.absmax, self.enemy.absmin), 0.5);

  if (self.target_ent === null) throw new Error("turret_brain_think: self.target_ent is null -- the C++ source dereferences it unconditionally here");

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TURRET_BRAIN_IGNORE_SIGHT)) {
    const trace = gi.trace(self.target_ent.s.origin, null, null, endpos, self.target_ent, MASK_SHOT);
    if (trace.fraction === 1 || trace.ent === self.enemy) {
      if (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) {
        self.monsterinfo.trail_time = level.time;
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_LOST_SIGHT;
      }
    } else {
      self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_LOST_SIGHT;
      return;
    }
  }

  // let the turret know where we want it to aim
  const dir = vec3_sub(endpos, self.target_ent.s.origin);
  self.target_ent.move_angles = vectoangles(dir);

  // decide if we should shoot
  if (level.time < self.monsterinfo.attack_finished) return;

  const reaction_time = self.delay ? Gtime_from_sec(self.delay) : Gtime_from_sec(3 - cvarInt("skill", "1"));
  if (level.time - self.monsterinfo.trail_time < reaction_time) return;

  self.monsterinfo.attack_finished = Gtime_add(Gtime_add(level.time, reaction_time), Gtime_from_sec(1));
  // FIXME how do we really want to pass this along?
  self.target_ent.spawnflags = SpawnFlags_or(self.target_ent.spawnflags, SPAWNFLAG_TURRET_BREACH_FIRE);
});

/** g_turret.cpp:547-584: `THINK(turret_brain_link)`. */
export const turret_brain_link: ThinkFn = RegisterThink("turret_brain_link", (self: EdictT): void => {
  if (self.killtarget !== null) {
    self.enemy = G_PickTarget(self.killtarget);
  }

  self.think = turret_brain_think;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());

  if (self.target === null) throw new Error("turret_brain_link: self.target is null -- the C++ source dereferences it unconditionally here");
  const targetEnt = G_PickTarget(self.target);
  if (targetEnt === null) throw new Error("turret_brain_link: G_PickTarget found no entity -- the C++ source dereferences the result unconditionally here");
  self.target_ent = targetEnt;
  targetEnt.owner = self;
  if (targetEnt.teammaster === null) throw new Error("turret_brain_link: target_ent.teammaster is null -- the C++ source dereferences it unconditionally here");
  targetEnt.teammaster.owner = self;
  self.s.angles = vec3(targetEnt.s.angles[0], targetEnt.s.angles[1], targetEnt.s.angles[2]);

  const vec = vec3(targetEnt.s.origin[0] - self.s.origin[0], targetEnt.s.origin[1] - self.s.origin[1], 0);
  self.move_origin[0] = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);

  let vec2 = vec3_sub(self.s.origin, targetEnt.s.origin);
  vec2 = vectoangles(vec2);
  AnglesNormalize(vec2);
  self.move_origin[1] = vec2[1];

  self.move_origin[2] = self.s.origin[2] - targetEnt.s.origin[2];

  // add the driver to the end of the team chain, passing along activator to breach, etc
  let ent: EdictT = targetEnt.teammaster;
  while (ent.teamchain !== null) {
    ent.activator = self.activator;
    ent = ent.teamchain;
  }
  ent.activator = self.activator;

  ent.teamchain = self;
  self.teammaster = targetEnt.teammaster;
  self.flags |= EntFlagsT.FL_TEAMSLAVE;
});

/** g_turret.cpp:588-592: `USE(turret_brain_deactivate)`. */
export const turret_brain_deactivate: UseFn = RegisterUse("turret_brain_deactivate", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.think = null;
  self.nextthink = GTIME_ZERO;
});

/** g_turret.cpp:596-617: `USE(turret_brain_activate)`. */
export const turret_brain_activate: UseFn = RegisterUse("turret_brain_activate", (self: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (self.enemy === null) self.enemy = activator;

  // wait at least 3 seconds to fire.
  self.monsterinfo.attack_finished = self.wait ? Gtime_add(level.time, Gtime_from_sec(self.wait)) : Gtime_add(level.time, Gtime_from_sec(3));
  self.use = turret_brain_deactivate;

  // Paril NOTE: rhangar1 has a turret_invisible_brain that breaks the
  // hangar ceiling; once the final rocket explodes the barrier,
  // it attempts to print "Barrier neutralized." to the rocket owner
  // who happens to be this brain rather than the player that activated
  // the turret. this resolves this by passing it along to fire_rocket.
  self.activator = activator;

  self.think = turret_brain_link;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
});

/** g_turret.cpp:631-658: `void SP_turret_invisible_brain(edict_t *self)`. */
export function SP_turret_invisible_brain(self: EdictT): void {
  if (self.killtarget === null) {
    gi.Com_Print("turret_invisible_brain with no killtarget!\n");
    G_FreeEdict(self);
    return;
  }
  if (self.target === null) {
    gi.Com_Print("turret_invisible_brain with no target!\n");
    G_FreeEdict(self);
    return;
  }

  if (self.targetname !== null) {
    self.use = turret_brain_activate;
  } else {
    self.think = turret_brain_link;
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  gi.linkentity(self);
}
