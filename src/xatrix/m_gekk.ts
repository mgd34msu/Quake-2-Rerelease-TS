/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from xatrix/m_gekk.c (GNU GPL v2 or later).

Pack-only monster (no baseq2 counterpart) -- fresh port, following
../game and ../ctf's conventions.

Real C bugs preserved bug-for-bug (per PORTING.md/preferences.md rule 3),
documented at each site below:
  - `gekk_check_melee`'s `if (!self->enemy && self->enemy->health <= 0)`
    is dead code (looks like a `||`/`&&` typo), but harmless: the function
    is only reached after gekk_checkattack has already confirmed
    self->enemy is non-null and alive.
  - `gekk_swim`'s `if (gekk_checkattack)` tests the function pointer's
    truthiness (always non-null, so always true) instead of calling
    `gekk_checkattack(self)`; C's dangling-else then binds the `else` to
    the *inner* `if`, not the outer one. Net effect: the inner if/else
    always runs unconditionally, and gekk_checkattack is never actually
    invoked from here.
  - `gekk_pain`'s `if (!self->flags & FL_SWIM)` binds `!` tighter than `&`,
    so it evaluates as `(!self->flags) & FL_SWIM` which is always 0
    (FL_SWIM = 0x2, and `!x` is 0 or 1) -- `self->flags |= FL_SWIM` in that
    branch is dead code, never executed.
*/
/*
	xatrix
	gekk.c
*/

import {
  AngleVectors,
  random,
  vec3,
  vec3_origin,
  VectorClear,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSet,
  VectorSubtract,
  type Vec3,
} from "../shared/math";
import {
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  type CplaneT,
  type CsurfaceT,
  MASK_SHOT,
  RF_FULLBRIGHT,
  SURF_SKY,
} from "../shared/q_shared";
import {
  AI_DUCKED,
  AI_HOLD_FRAME,
  AI_STAND_GROUND,
  AS_MELEE,
  AS_MISSILE,
  DamageT,
  DAMAGE_ENERGY,
  DEAD_DEAD,
  type EdictT,
  FL_SWIM,
  gameCvars,
  gi,
  GIB_ORGANIC,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MOD_GEKK,
  MovetypeT,
  PNOISE_IMPACT,
  RANGE_MELEE,
  RANGE_NEAR,
} from "./g_local";
import { SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range } from "./g_ai";
import { T_Damage } from "./g_combat";
import { ThrowGibACID, ThrowHeadACID } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { walkmonster_start } from "./g_monster";
import { PlayerNoise } from "./p_weapon";
import { G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { M_CheckBottom } from "./m_move";
import * as FRAME from "./m_gekk_frames";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// C dereferences `ent->owner` unconditionally in loogie_touch; every real
// call site (fire_loogie) sets `owner` to the firing entity immediately
// after G_Spawn(), so this narrows a "always actually set" nullable field
// with a thrown error instead of an unchecked deref, matching g_weapon.ts's
// established precedent.
function requireOwner(ent: EdictT): EdictT {
  if (ent.owner === null) {
    throw new Error("owner is null (C dereferences it unconditionally here)");
  }
  return ent.owner;
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

function mm(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

let sound_swing = 0;
let sound_hit = 0;
let sound_hit2 = 0;
let sound_death = 0;
let sound_pain1 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_step1 = 0;
let sound_step2 = 0;
let sound_step3 = 0;
let sound_thud = 0;
let sound_chantlow = 0;
let sound_chantmid = 0;
let sound_chanthigh = 0;

//
// CHECKATTACK
//

function gekk_check_melee(self: EdictT): boolean {
  // C: `if (!self->enemy && self->enemy->health <= 0) return false;`
  // Dead code (a copy/paste bug -- `&&` where `||` was likely intended,
  // matching gekk_checkattack's own guard): gekk_check_melee is only ever
  // called after gekk_checkattack has confirmed self.enemy is non-null and
  // alive, so the left operand here is always false and the buggy
  // null-deref branch never taken. Preserved as a no-op guard.
  if (self.enemy === null) return false;
  if (range(self, self.enemy) === RANGE_MELEE) return true;
  return false;
}

function gekk_check_jump(self: EdictT): boolean {
  if (self.enemy === null) return false; // C assumes self->enemy is set here

  if (self.absmin[2] > self.enemy.absmin[2] + 0.75 * self.enemy.size[2]) return false;

  if (self.absmax[2] < self.enemy.absmin[2] + 0.25 * self.enemy.size[2]) return false;

  const v = vec3(self.s.origin[0] - self.enemy.s.origin[0], self.s.origin[1] - self.enemy.s.origin[1], 0);
  const distance = VectorLength(v);

  if (distance < 100) {
    return false;
  }
  if (distance > 100) {
    if (random() < 0.9) return false;
  }

  return true;
}

function gekk_check_jump_close(self: EdictT): boolean {
  if (self.enemy === null) return true; // C assumes self->enemy is set here

  const v = vec3(self.s.origin[0] - self.enemy.s.origin[0], self.s.origin[1] - self.enemy.s.origin[1], 0);
  const distance = VectorLength(v);

  if (distance < 100) {
    return self.s.origin[2] < self.enemy.s.origin[2];
  }

  return true;
}

function gekk_checkattack(self: EdictT): boolean {
  if (self.enemy === null || self.enemy.health <= 0) return false;

  if (gekk_check_melee(self)) {
    self.monsterinfo.attack_state = AS_MELEE;
    return true;
  }

  if (gekk_check_jump(self)) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  if (gekk_check_jump_close(self) && !self.waterlevel) {
    self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  return false;
}

//
// SOUNDS
//

function gekk_step(self: EdictT): void {
  // C: `n = (rand() + 1) % 3;` -- the +1 offset only phase-shifts which raw
  // values land in which bucket, not the uniformity of the result.
  const n = Math.floor(Math.random() * 3);
  if (n === 0) gi.sound(self, CHAN_VOICE, sound_step1, 1, ATTN_NORM, 0);
  else if (n === 1) gi.sound(self, CHAN_VOICE, sound_step2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_step3, 1, ATTN_NORM, 0);
}

function gekk_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function gekk_search(self: EdictT): void {
  if (self.spawnflags & 8) {
    const r = random();
    if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_chantlow, 1, ATTN_NORM, 0);
    else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_chantmid, 1, ATTN_NORM, 0);
    else gi.sound(self, CHAN_VOICE, sound_chanthigh, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
  }

  self.health += 10 + 10 * random();
  if (self.health > self.max_health) self.health = self.max_health;

  if (self.health < self.max_health / 4) self.s.skinnum = 2;
  else if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
}

function gekk_swing(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_swing, 1, ATTN_NORM, 0);
}

function gekk_face(self: EdictT): void {
  self.monsterinfo.currentmove = gekk_move_run;
}

//
// STAND
//

function ai_stand2(self: EdictT, dist: number): void {
  if (self.spawnflags & 8) {
    ai_move(self, dist);
    if (!(self.spawnflags & 1) && self.monsterinfo.idle && level.time > self.monsterinfo.idle_time) {
      if (self.monsterinfo.idle_time) {
        self.monsterinfo.idle(self);
        self.monsterinfo.idle_time = level.time + 15 + random() * 15;
      } else {
        self.monsterinfo.idle_time = level.time + random() * 15;
      }
    }
  } else {
    ai_stand(self, dist);
  }
}

const gekk_frames_stand: MframeT[] = [
  ...Array.from({ length: 38 }, () => mf(ai_stand2, 0, null)),
  mf(ai_stand2, 0, gekk_check_underwater),
];
const gekk_move_stand = mm(FRAME.FRAME_stand_01, FRAME.FRAME_stand_39, gekk_frames_stand);

const gekk_frames_standunderwater: MframeT[] = [
  mf(ai_stand2, 0, null),
  mf(ai_stand2, 0, null),
  mf(ai_stand2, 0, null),
  mf(ai_stand2, 0, gekk_check_underwater),
];
const gekk_move_standunderwater = mm(FRAME.FRAME_amb_01, FRAME.FRAME_amb_04, gekk_frames_standunderwater);

function gekk_swim_loop(self: EdictT): void {
  self.flags |= FL_SWIM;
  self.monsterinfo.currentmove = gekk_move_swim_loop;
}

const gekk_frames_swim: MframeT[] = [
  mf(ai_run, 16, null),
  mf(ai_run, 16, null),
  mf(ai_run, 16, null),
  mf(ai_run, 16, gekk_swim),
];
const gekk_move_swim_loop = mm(FRAME.FRAME_amb_01, FRAME.FRAME_amb_04, gekk_frames_swim, gekk_swim_loop);

const gekk_frames_swim_start: MframeT[] = [
  mf(ai_run, 14, null),
  mf(ai_run, 14, null),
  mf(ai_run, 14, null),
  mf(ai_run, 14, null),
  mf(ai_run, 16, null),
  mf(ai_run, 16, null),
  mf(ai_run, 16, null),
  mf(ai_run, 18, null),
  mf(ai_run, 18, gekk_hit_left),
  mf(ai_run, 18, null),

  mf(ai_run, 20, null),
  mf(ai_run, 20, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 24, gekk_hit_right),
  mf(ai_run, 24, null),
  mf(ai_run, 26, null),
  mf(ai_run, 26, null),
  mf(ai_run, 24, null),
  mf(ai_run, 24, null),

  mf(ai_run, 22, gekk_bite),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 22, null),
  mf(ai_run, 18, null),
  mf(ai_run, 18, null),

  mf(ai_run, 18, null),
  mf(ai_run, 18, null),
];
const gekk_move_swim_start = mm(FRAME.FRAME_swim_01, FRAME.FRAME_swim_32, gekk_frames_swim_start, gekk_swim_loop);

function gekk_swim(self: EdictT): void {
  // C: `if (gekk_checkattack)` tests the function pointer's truthiness
  // (always non-null -> always true) rather than calling
  // gekk_checkattack(self); the dangling `else` then binds to the inner
  // `if`. Net effect: the inner if/else runs unconditionally and
  // gekk_checkattack is never actually invoked here. Preserved bug-for-bug.
  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (!self.enemy.waterlevel && random() > 0.7) water_to_land(self);
  else self.monsterinfo.currentmove = gekk_move_swim_start;
}

function gekk_stand(self: EdictT): void {
  if (self.waterlevel) self.monsterinfo.currentmove = gekk_move_standunderwater;
  else self.monsterinfo.currentmove = gekk_move_stand;
}

function gekk_chant(self: EdictT): void {
  self.monsterinfo.currentmove = gekk_move_chant;
}

//
// IDLE
//

function gekk_idle_loop(self: EdictT): void {
  if (random() > 0.75 && self.health < self.max_health) self.monsterinfo.nextframe = FRAME.FRAME_idle_01;
}

const gekk_frames_idle: MframeT[] = [
  mf(ai_stand2, 0, gekk_search),
  ...Array.from({ length: 30 }, () => mf(ai_stand2, 0, null)),
  mf(ai_stand2, 0, gekk_idle_loop),
];
const gekk_move_idle = mm(FRAME.FRAME_idle_01, FRAME.FRAME_idle_32, gekk_frames_idle, gekk_stand);
const gekk_move_idle2 = mm(FRAME.FRAME_idle_01, FRAME.FRAME_idle_32, gekk_frames_idle, gekk_face);

const gekk_frames_idle2: MframeT[] = [
  mf(ai_move, 0, gekk_search),
  ...Array.from({ length: 30 }, () => mf(ai_move, 0, null)),
  mf(ai_move, 0, gekk_idle_loop),
];
const gekk_move_chant = mm(FRAME.FRAME_idle_01, FRAME.FRAME_idle_32, gekk_frames_idle2, gekk_chant);

function gekk_idle(self: EdictT): void {
  if (!self.waterlevel) self.monsterinfo.currentmove = gekk_move_idle;
  else self.monsterinfo.currentmove = gekk_move_swim_start;
  // gi.sound (self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

//
// WALK
//

const gekk_frames_walk: MframeT[] = [
  mf(ai_walk, 3.849, gekk_check_underwater),
  mf(ai_walk, 19.606, null),
  mf(ai_walk, 25.583, null),
  mf(ai_walk, 34.625, gekk_step),
  mf(ai_walk, 27.365, null),
  mf(ai_walk, 28.48, null),
];
const gekk_move_walk = mm(FRAME.FRAME_run_01, FRAME.FRAME_run_06, gekk_frames_walk);

function gekk_walk(self: EdictT): void {
  self.monsterinfo.currentmove = gekk_move_walk;
}

//
// RUN
//

function gekk_run_start(self: EdictT): void {
  if (self.waterlevel) self.monsterinfo.currentmove = gekk_move_swim_start;
  else self.monsterinfo.currentmove = gekk_move_run_start;
}

function gekk_run(self: EdictT): void {
  if (self.waterlevel) {
    self.monsterinfo.currentmove = gekk_move_swim_start;
    return;
  } else {
    if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = gekk_move_stand;
    else self.monsterinfo.currentmove = gekk_move_run;
  }
}

const gekk_frames_run: MframeT[] = [
  mf(ai_run, 3.849, gekk_check_underwater),
  mf(ai_run, 19.606, null),
  mf(ai_run, 25.583, null),
  mf(ai_run, 34.625, gekk_step),
  mf(ai_run, 27.365, null),
  mf(ai_run, 28.48, null),
];
const gekk_move_run = mm(FRAME.FRAME_run_01, FRAME.FRAME_run_06, gekk_frames_run);

const gekk_frames_run_st: MframeT[] = [mf(ai_run, 0.212, null), mf(ai_run, 19.753, null)];
const gekk_move_run_start = mm(FRAME.FRAME_stand_01, FRAME.FRAME_stand_02, gekk_frames_run_st, gekk_run);

//
// MELEE
//

function gekk_hit_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, 15 + Math.floor(Math.random() * 5), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
  }
}

function gekk_hit_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, 15 + Math.floor(Math.random() * 5), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit2, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
  }
}

function gekk_check_refire(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse || self.enemy.health <= 0) return;

  if (random() < cvarNum(gameCvars.skill) * 0.1) {
    if (range(self, self.enemy) === RANGE_MELEE) {
      if (self.s.frame === FRAME.FRAME_clawatk3_09) self.monsterinfo.currentmove = gekk_move_attack2;
      else if (self.s.frame === FRAME.FRAME_clawatk5_09) self.monsterinfo.currentmove = gekk_move_attack1;
    }
  }
}

function loogie_touch(self: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === self.owner) return;

  if (surf !== null && surf.flags & SURF_SKY) {
    G_FreeEdict(self);
    return;
  }

  const owner = requireOwner(self);
  if (owner.client) PlayerNoise(owner, self.s.origin, PNOISE_IMPACT);

  // plane can be NULL here (loogie_touch is reached via fire_loogie's own
  // immediate self-trace call, which passes NULL); C dereferences
  // plane->normal unconditionally in the takedamage branch, a latent null
  // deref in the original -- falls back to vec3_origin, matching
  // g_weapon.ts's blaster_touch precedent for the identical situation.
  const normal = plane === null ? vec3_origin : plane.normal;

  if (other.takedamage) {
    T_Damage(other, self, owner, self.velocity, self.s.origin, normal, self.dmg, 1, DAMAGE_ENERGY, MOD_GEKK);
  }

  G_FreeEdict(self);
}

function fire_loogie(self: EdictT, start: Vec3, dirIn: Vec3, damage: number, speed: number): void {
  const dir = vec3();
  VectorCopy(dirIn, dir);
  VectorNormalize(dir);

  const loogie = G_Spawn();
  VectorCopy(start, loogie.s.origin);
  VectorCopy(start, loogie.s.old_origin);
  vectoangles(dir, loogie.s.angles);
  VectorScale(dir, speed, loogie.velocity);
  loogie.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  loogie.clipmask = MASK_SHOT;
  loogie.solid = SolidT.SOLID_BBOX;
  // C literally ORs in RF_FULLBRIGHT (a renderfx constant, value 8) here
  // rather than an EF_* effect bit -- a namespace mix-up in the original,
  // numerically harmless since EF_BLASTER is also 0x8. Preserved verbatim.
  loogie.s.effects |= RF_FULLBRIGHT;
  VectorClear(loogie.mins);
  VectorClear(loogie.maxs);

  loogie.s.modelindex = gi.modelindex("models/objects/loogy/tris.md2");
  loogie.owner = self;
  loogie.touch = loogie_touch;
  loogie.nextthink = level.time + 2;
  loogie.think = G_FreeEdict;
  loogie.dmg = damage;
  gi.linkentity(loogie);

  const tr = gi.trace(self.s.origin, null, null, loogie.s.origin, loogie, MASK_SHOT);
  if (tr.fraction < 1.0) {
    VectorMA(loogie.s.origin, -10, dir, loogie.s.origin);
    if (loogie.touch) loogie.touch(loogie, self, null, null);
  }
}

function loogie(self: EdictT): void {
  const gekkoffset = vec3(-18, -0.8, 24);

  if (!self.enemy || self.enemy.health <= 0) return;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);
  const start = vec3();
  G_ProjectSource(self.s.origin, gekkoffset, forward, right, start);

  VectorMA(start, 2, up, start);

  const end = vec3();
  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  const dir = vec3();
  VectorSubtract(end, start, dir);

  fire_loogie(self, start, dir, 5, 550);
}

function reloogie(self: EdictT): void {
  if (random() > 0.8 && self.health < self.max_health) {
    self.monsterinfo.currentmove = gekk_move_idle2;
    return;
  }

  if (self.enemy === null) return; // C assumes self->enemy is set here
  if (self.enemy.health >= 0) {
    if (random() > 0.7 && range(self, self.enemy) === RANGE_NEAR) self.monsterinfo.currentmove = gekk_move_spit;
  }
}

const gekk_frames_spit: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),

  mf(ai_charge, 0, loogie),
  mf(ai_charge, 0, reloogie),
];
const gekk_move_spit = mm(FRAME.FRAME_spit_01, FRAME.FRAME_spit_07, gekk_frames_spit, gekk_run_start);

const gekk_frames_attack1: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),

  mf(ai_charge, 0, gekk_hit_left),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),

  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gekk_check_refire),
];
const gekk_move_attack1 = mm(FRAME.FRAME_clawatk3_01, FRAME.FRAME_clawatk3_09, gekk_frames_attack1, gekk_run_start);

const gekk_frames_attack2: MframeT[] = [
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gekk_hit_left),

  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gekk_hit_right),

  mf(ai_charge, 0, null),
  mf(ai_charge, 0, null),
  mf(ai_charge, 0, gekk_check_refire),
];
const gekk_move_attack2 = mm(FRAME.FRAME_clawatk5_01, FRAME.FRAME_clawatk5_09, gekk_frames_attack2, gekk_run_start);

function gekk_check_underwater(self: EdictT): void {
  if (self.waterlevel) land_to_water(self);
}

const gekk_frames_leapatk: MframeT[] = [
  mf(ai_charge, 0.0, null),
  mf(ai_charge, -0.387, null),
  mf(ai_charge, -1.113, null),
  mf(ai_charge, -0.237, null),
  mf(ai_charge, 6.72, gekk_jump_takeoff),
  mf(ai_charge, 6.414, null),
  mf(ai_charge, 0.163, null),
  mf(ai_charge, 28.316, null),
  mf(ai_charge, 24.198, null),
  mf(ai_charge, 31.742, null),
  mf(ai_charge, 35.977, gekk_check_landing),
  mf(ai_charge, 12.303, gekk_stop_skid),
  mf(ai_charge, 20.122, gekk_stop_skid),
  mf(ai_charge, -1.042, gekk_stop_skid),
  mf(ai_charge, 2.556, gekk_stop_skid),
  mf(ai_charge, 0.544, gekk_stop_skid),
  mf(ai_charge, 1.862, gekk_stop_skid),
  mf(ai_charge, 1.224, gekk_stop_skid),

  mf(ai_charge, -0.457, gekk_check_underwater),
];
const gekk_move_leapatk = mm(FRAME.FRAME_leapatk_01, FRAME.FRAME_leapatk_19, gekk_frames_leapatk, gekk_run_start);

const gekk_frames_leapatk2: MframeT[] = [
  mf(ai_charge, 0.0, null),
  mf(ai_charge, -0.387, null),
  mf(ai_charge, -1.113, null),
  mf(ai_charge, -0.237, null),
  mf(ai_charge, 6.72, gekk_jump_takeoff2),
  mf(ai_charge, 6.414, null),
  mf(ai_charge, 0.163, null),
  mf(ai_charge, 28.316, null),
  mf(ai_charge, 24.198, null),
  mf(ai_charge, 31.742, null),
  mf(ai_charge, 35.977, gekk_check_landing),
  mf(ai_charge, 12.303, gekk_stop_skid),
  mf(ai_charge, 20.122, gekk_stop_skid),
  mf(ai_charge, -1.042, gekk_stop_skid),
  mf(ai_charge, 2.556, gekk_stop_skid),
  mf(ai_charge, 0.544, gekk_stop_skid),
  mf(ai_charge, 1.862, gekk_stop_skid),
  mf(ai_charge, 1.224, gekk_stop_skid),

  mf(ai_charge, -0.457, gekk_check_underwater),
];
const gekk_move_leapatk2 = mm(FRAME.FRAME_leapatk_01, FRAME.FRAME_leapatk_19, gekk_frames_leapatk2, gekk_run_start);

function gekk_bite(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  fire_hit(self, aim, 5, 0);
}

function gekk_preattack(_self: EdictT): void {
  // underwater attack sound
  // gi.sound (self, CHAN_WEAPON, something something underwater sound, 1, ATTN_NORM, 0);
  return;
}

const gekk_frames_attack: MframeT[] = [
  mf(ai_charge, 16, gekk_preattack),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, gekk_bite),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, gekk_bite),

  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, gekk_hit_left),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, null),
  mf(ai_charge, 16, gekk_hit_right),
  mf(ai_charge, 16, null),

  mf(ai_charge, 16, null),
];
const gekk_move_attack = mm(FRAME.FRAME_attack_01, FRAME.FRAME_attack_21, gekk_frames_attack, gekk_run_start);

function gekk_melee(self: EdictT): void {
  if (self.waterlevel) {
    self.monsterinfo.currentmove = gekk_move_attack;
  } else {
    const r = random();
    if (r > 0.66) self.monsterinfo.currentmove = gekk_move_attack1;
    else self.monsterinfo.currentmove = gekk_move_attack2;
  }
}

//
// ATTACK
//

function gekk_jump_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (self.health <= 0) {
    self.touch = null;
    return;
  }

  if (other.takedamage) {
    if (VectorLength(self.velocity) > 200) {
      const normal = vec3();
      VectorCopy(self.velocity, normal);
      VectorNormalize(normal);
      const point = vec3();
      VectorMA(self.s.origin, self.maxs[0], normal, point);
      const damage = 10 + 10 * random();
      T_Damage(other, self, self, self.velocity, point, normal, damage, damage, 0, MOD_GEKK);
    }
  }

  if (!M_CheckBottom(self)) {
    if (self.groundentity) {
      self.monsterinfo.nextframe = FRAME.FRAME_leapatk_11;
      self.touch = null;
    }
    return;
  }

  self.touch = null;
}

function gekk_jump_takeoff(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  self.s.origin[2] += 1;

  // high jump
  if (gekk_check_jump(self)) {
    VectorScale(forward, 700, self.velocity);
    self.velocity[2] = 250;
  } else {
    VectorScale(forward, 250, self.velocity);
    self.velocity[2] = 400;
  }

  self.groundentity = null;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.monsterinfo.attack_finished = level.time + 3;
  self.touch = gekk_jump_touch;
}

function gekk_jump_takeoff2(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  if (self.enemy === null) return; // C assumes self->enemy is set here
  self.s.origin[2] = self.enemy.s.origin[2];

  if (gekk_check_jump(self)) {
    VectorScale(forward, 300, self.velocity);
    self.velocity[2] = 250;
  } else {
    VectorScale(forward, 150, self.velocity);
    self.velocity[2] = 300;
  }

  self.groundentity = null;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.monsterinfo.attack_finished = level.time + 3;
  self.touch = gekk_jump_touch;
}

function gekk_stop_skid(self: EdictT): void {
  if (self.groundentity) VectorClear(self.velocity);
}

function gekk_check_landing(self: EdictT): void {
  if (self.groundentity) {
    gi.sound(self, CHAN_WEAPON, sound_thud, 1, ATTN_NORM, 0);
    self.monsterinfo.attack_finished = 0;
    self.monsterinfo.aiflags &= ~AI_DUCKED;

    VectorClear(self.velocity);

    return;
  }

  // note to self
  // causing skid
  if (level.time > self.monsterinfo.attack_finished) self.monsterinfo.nextframe = FRAME.FRAME_leapatk_11;
  else self.monsterinfo.nextframe = FRAME.FRAME_leapatk_12;
}

function gekk_jump(self: EdictT): void {
  if (self.flags & FL_SWIM || self.waterlevel) {
    return;
  } else {
    if (self.enemy === null) return; // C assumes self->enemy is set here
    if (random() > 0.5 && range(self, self.enemy) >= RANGE_NEAR) self.monsterinfo.currentmove = gekk_move_spit;
    else if (random() > 0.8) self.monsterinfo.currentmove = gekk_move_spit;
    else self.monsterinfo.currentmove = gekk_move_leapatk;
  }
}

//
// PAIN
//

const gekk_frames_pain: MframeT[] = Array.from({ length: 6 }, () => mf(ai_move, 0, null));
const gekk_move_pain = mm(FRAME.FRAME_pain_01, FRAME.FRAME_pain_06, gekk_frames_pain, gekk_run_start);

const gekk_frames_pain1: MframeT[] = [
  ...Array.from({ length: 10 }, () => mf(ai_move, 0, null)),
  mf(ai_move, 0, gekk_check_underwater),
];
const gekk_move_pain1 = mm(FRAME.FRAME_pain3_01, FRAME.FRAME_pain3_11, gekk_frames_pain1, gekk_run_start);

const gekk_frames_pain2: MframeT[] = [
  ...Array.from({ length: 12 }, () => mf(ai_move, 0, null)),
  mf(ai_move, 0, gekk_check_underwater),
];
const gekk_move_pain2 = mm(FRAME.FRAME_pain4_01, FRAME.FRAME_pain4_13, gekk_frames_pain2, gekk_run_start);

function gekk_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  if (self.spawnflags & 8) {
    self.spawnflags &= ~8;
    return;
  }

  if (self.health < self.max_health / 4) self.s.skinnum = 2;
  else if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;

  gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (self.waterlevel) {
    // C: `if (!self->flags & FL_SWIM) self->flags |= FL_SWIM;` -- `!` binds
    // tighter than `&`, so this is `(!self->flags) & FL_SWIM`, always 0
    // (FL_SWIM = 0x2). The flag-set line is dead code, never executed.
    // Preserved bug-for-bug (omitted here since it provably never runs).
    self.monsterinfo.currentmove = gekk_move_pain;
  } else {
    const r = random();
    if (r > 0.5) self.monsterinfo.currentmove = gekk_move_pain1;
    else self.monsterinfo.currentmove = gekk_move_pain2;
  }
}

//
// DEATH
//

function gekk_dead(self: EdictT): void {
  // fix this because of no blocking problem
  if (self.waterlevel) {
    return;
  } else {
    VectorSet(self.mins, -16, -16, -24);
    VectorSet(self.maxs, 16, 16, -8);
    self.movetype = MovetypeT.MOVETYPE_TOSS;
    self.svflags |= SVF_DEADMONSTER;
    self.nextthink = 0;
    gi.linkentity(self);
  }
}

function gekk_gibfest(self: EdictT): void {
  const damage = 20;

  gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

  ThrowGibACID(self, "models/objects/gekkgib/pelvis/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/arm/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/arm/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/torso/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/claw/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/leg/tris.md2", damage, GIB_ORGANIC);
  ThrowGibACID(self, "models/objects/gekkgib/leg/tris.md2", damage, GIB_ORGANIC);

  ThrowHeadACID(self, "models/objects/gekkgib/head/tris.md2", damage, GIB_ORGANIC);

  self.deadflag = DEAD_DEAD;
}

function isgibfest(self: EdictT): void {
  if (random() > 0.9) gekk_gibfest(self);
}

const gekk_frames_death1: MframeT[] = [
  mf(ai_move, -5.151, null),
  mf(ai_move, -12.223, null),
  mf(ai_move, -11.484, null),
  mf(ai_move, -17.952, null),
  mf(ai_move, -6.953, null),
  mf(ai_move, -7.393, null),
  mf(ai_move, -10.713, null),
  mf(ai_move, -17.464, null),
  mf(ai_move, -11.678, null),
  mf(ai_move, -11.678, null),
];
const gekk_move_death1 = mm(FRAME.FRAME_death1_01, FRAME.FRAME_death1_10, gekk_frames_death1, gekk_dead);

const gekk_frames_death3: MframeT[] = [
  mf(ai_move, 0.0, null),
  mf(ai_move, 0.022, null),
  mf(ai_move, 0.169, null),
  mf(ai_move, -0.71, null),
  mf(ai_move, -13.446, null),
  mf(ai_move, -7.654, isgibfest),
  mf(ai_move, -31.951, null),
];
const gekk_move_death3 = mm(FRAME.FRAME_death3_01, FRAME.FRAME_death3_07, gekk_frames_death3, gekk_dead);

const gekk_frames_death4: MframeT[] = [
  mf(ai_move, 5.103, null),
  mf(ai_move, -4.808, null),
  mf(ai_move, -10.509, null),
  mf(ai_move, -9.899, null),
  mf(ai_move, 4.033, isgibfest),
  mf(ai_move, -5.197, null),
  mf(ai_move, -0.919, null),
  mf(ai_move, -8.821, null),
  mf(ai_move, -5.626, null),
  mf(ai_move, -8.865, isgibfest),
  mf(ai_move, -0.845, null),
  mf(ai_move, 1.986, null),
  mf(ai_move, 0.17, null),
  mf(ai_move, 1.339, isgibfest),
  mf(ai_move, -0.922, null),
  mf(ai_move, 0.818, null),
  mf(ai_move, -1.288, null),
  mf(ai_move, -1.408, isgibfest),
  mf(ai_move, -7.787, null),
  mf(ai_move, -3.995, null),
  mf(ai_move, -4.604, null),
  mf(ai_move, -1.715, isgibfest),
  mf(ai_move, -0.564, null),
  mf(ai_move, -0.597, null),
  mf(ai_move, 0.074, null),
  mf(ai_move, -0.309, isgibfest),
  mf(ai_move, -0.395, null),
  mf(ai_move, -0.501, null),
  mf(ai_move, -0.325, null),
  mf(ai_move, -0.931, isgibfest),
  mf(ai_move, -1.433, null),
  mf(ai_move, -1.626, null),
  mf(ai_move, 4.68, null),
  mf(ai_move, 0.56, null),
  mf(ai_move, -0.549, gekk_gibfest),
];
const gekk_move_death4 = mm(FRAME.FRAME_death4_01, FRAME.FRAME_death4_35, gekk_frames_death4, gekk_dead);

const gekk_frames_wdeath: MframeT[] = Array.from({ length: 45 }, () => mf(ai_move, 0, null));
const gekk_move_wdeath = mm(FRAME.FRAME_wdeath_01, FRAME.FRAME_wdeath_45, gekk_frames_wdeath, gekk_dead);

function gekk_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    ThrowGibACID(self, "models/objects/gekkgib/pelvis/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/arm/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/arm/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/torso/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/claw/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/leg/tris.md2", damage, GIB_ORGANIC);
    ThrowGibACID(self, "models/objects/gekkgib/leg/tris.md2", damage, GIB_ORGANIC);

    ThrowHeadACID(self, "models/objects/gekkgib/head/tris.md2", damage, GIB_ORGANIC);

    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;
  self.s.skinnum = 2;

  if (self.waterlevel) {
    self.monsterinfo.currentmove = gekk_move_wdeath;
  } else {
    const r = random();
    if (r > 0.66) self.monsterinfo.currentmove = gekk_move_death1;
    else if (r > 0.33) self.monsterinfo.currentmove = gekk_move_death3;
    else self.monsterinfo.currentmove = gekk_move_death4;
  }
}

/*
	duck
*/
function gekk_duck_down(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_DUCKED) return;
  self.monsterinfo.aiflags |= AI_DUCKED;
  self.maxs[2] -= 32;
  self.takedamage = DamageT.DAMAGE_YES;
  self.monsterinfo.pausetime = level.time + 1;
  gi.linkentity(self);
}

function gekk_duck_up(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DUCKED;
  self.maxs[2] += 32;
  self.takedamage = DamageT.DAMAGE_AIM;
  gi.linkentity(self);
}

function gekk_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.pausetime) self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
  else self.monsterinfo.aiflags |= AI_HOLD_FRAME;
}

const gekk_frames_lduck: MframeT[] = Array.from({ length: 13 }, () => mf(ai_move, 0, null));
const gekk_move_lduck = mm(FRAME.FRAME_lduck_01, FRAME.FRAME_lduck_13, gekk_frames_lduck, gekk_run_start);

const gekk_frames_rduck: MframeT[] = Array.from({ length: 13 }, () => mf(ai_move, 0, null));
const gekk_move_rduck = mm(FRAME.FRAME_rduck_01, FRAME.FRAME_rduck_13, gekk_frames_rduck, gekk_run_start);

function gekk_dodge(self: EdictT, attacker: EdictT, eta: number): void {
  let r = random();
  if (r > 0.25) return;

  if (!self.enemy) self.enemy = attacker;

  if (self.waterlevel) {
    self.monsterinfo.currentmove = gekk_move_attack;
    return;
  }

  const skill = cvarNum(gameCvars.skill);

  if (skill === 0) {
    r = random();
    if (r > 0.5) self.monsterinfo.currentmove = gekk_move_lduck;
    else self.monsterinfo.currentmove = gekk_move_rduck;
    return;
  }

  self.monsterinfo.pausetime = level.time + eta + 0.3;
  r = random();

  if (skill === 1) {
    if (r > 0.33) {
      r = random();
      if (r > 0.5) self.monsterinfo.currentmove = gekk_move_lduck;
      else self.monsterinfo.currentmove = gekk_move_rduck;
    } else {
      r = random();
      if (r > 0.66) self.monsterinfo.currentmove = gekk_move_attack1;
      else self.monsterinfo.currentmove = gekk_move_attack2;
    }
    return;
  }

  if (skill === 2) {
    if (r > 0.66) {
      r = random();
      if (r > 0.5) self.monsterinfo.currentmove = gekk_move_lduck;
      else self.monsterinfo.currentmove = gekk_move_rduck;
    } else {
      r = random();
      if (r > 0.66) self.monsterinfo.currentmove = gekk_move_attack1;
      else self.monsterinfo.currentmove = gekk_move_attack2;
    }
    return;
  }

  r = random();
  if (r > 0.66) self.monsterinfo.currentmove = gekk_move_attack1;
  else self.monsterinfo.currentmove = gekk_move_attack2;
}

//
// SPAWN
//

/*QUAKED monster_gekk (1 .5 0) (-24 -24 -24) (24 24 24) Ambush Trigger_Spawn Sight Chant
*/
export function SP_monster_gekk(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_swing = gi.soundindex("gek/gk_atck1.wav");
  sound_hit = gi.soundindex("gek/gk_atck2.wav");
  sound_hit2 = gi.soundindex("gek/gk_atck3.wav");
  sound_death = gi.soundindex("gek/gk_deth1.wav");
  sound_pain1 = gi.soundindex("gek/gk_pain1.wav");
  sound_sight = gi.soundindex("gek/gk_sght1.wav");
  sound_search = gi.soundindex("gek/gk_idle1.wav");
  sound_step1 = gi.soundindex("gek/gk_step1.wav");
  sound_step2 = gi.soundindex("gek/gk_step2.wav");
  sound_step3 = gi.soundindex("gek/gk_step3.wav");
  sound_thud = gi.soundindex("mutant/thud1.wav");

  sound_chantlow = gi.soundindex("gek/gek_low.wav");
  sound_chantmid = gi.soundindex("gek/gek_mid.wav");
  sound_chanthigh = gi.soundindex("gek/gek_high.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/gekk/tris.md2");
  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 24);

  gi.modelindex("models/objects/gekkgib/pelvis/tris.md2");
  gi.modelindex("models/objects/gekkgib/arm/tris.md2");
  gi.modelindex("models/objects/gekkgib/torso/tris.md2");
  gi.modelindex("models/objects/gekkgib/claw/tris.md2");
  gi.modelindex("models/objects/gekkgib/leg/tris.md2");
  gi.modelindex("models/objects/gekkgib/head/tris.md2");

  self.health = 125;
  self.gib_health = -30;
  self.mass = 300;

  self.pain = gekk_pain;
  self.die = gekk_die;

  self.monsterinfo.stand = gekk_stand;

  self.monsterinfo.walk = gekk_walk;
  self.monsterinfo.run = gekk_run_start;
  self.monsterinfo.dodge = gekk_dodge;
  self.monsterinfo.attack = gekk_jump;
  self.monsterinfo.melee = gekk_melee;
  self.monsterinfo.sight = gekk_sight;

  self.monsterinfo.search = gekk_search;
  self.monsterinfo.idle = gekk_idle;
  self.monsterinfo.checkattack = gekk_checkattack;

  gi.linkentity(self);

  self.monsterinfo.currentmove = gekk_move_stand;

  self.monsterinfo.scale = FRAME.MODEL_SCALE;
  walkmonster_start(self);

  if (self.spawnflags & 8) self.monsterinfo.currentmove = gekk_move_chant;
}

function water_to_land(self: EdictT): void {
  self.flags &= ~FL_SWIM;
  self.yaw_speed = 20;
  self.viewheight = 25;

  self.monsterinfo.currentmove = gekk_move_leapatk2;

  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 24);
}

function land_to_water(self: EdictT): void {
  self.flags |= FL_SWIM;
  self.yaw_speed = 10;
  self.viewheight = 10;

  self.monsterinfo.currentmove = gekk_move_swim_start;

  VectorSet(self.mins, -24, -24, -24);
  VectorSet(self.maxs, 24, 24, 16);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_gekk:gekk_face", gekk_face);
registerSaveFunction("m_gekk:gekk_swim_loop", gekk_swim_loop);
registerSaveFunction("m_gekk:gekk_swim", gekk_swim);
registerSaveFunction("m_gekk:gekk_stand", gekk_stand);
registerSaveFunction("m_gekk:gekk_chant", gekk_chant);
registerSaveFunction("m_gekk:gekk_idle", gekk_idle);
registerSaveFunction("m_gekk:gekk_walk", gekk_walk);
registerSaveFunction("m_gekk:gekk_run_start", gekk_run_start);
registerSaveFunction("m_gekk:gekk_run", gekk_run);
registerSaveFunction("m_gekk:loogie_touch", loogie_touch);
registerSaveFunction("m_gekk:loogie", loogie);
registerSaveFunction("m_gekk:reloogie", reloogie);
registerSaveFunction("m_gekk:gekk_check_underwater", gekk_check_underwater);
registerSaveFunction("m_gekk:gekk_melee", gekk_melee);
registerSaveFunction("m_gekk:gekk_jump_touch", gekk_jump_touch);
registerSaveFunction("m_gekk:gekk_jump_takeoff", gekk_jump_takeoff);
registerSaveFunction("m_gekk:gekk_jump_takeoff2", gekk_jump_takeoff2);
registerSaveFunction("m_gekk:gekk_jump", gekk_jump);
registerSaveFunction("m_gekk:gekk_pain", gekk_pain);
registerSaveFunction("m_gekk:gekk_dead", gekk_dead);
registerSaveFunction("m_gekk:gekk_gibfest", gekk_gibfest);
registerSaveFunction("m_gekk:gekk_die", gekk_die);
registerSaveFunction("m_gekk:gekk_duck_down", gekk_duck_down);
registerSaveFunction("m_gekk:gekk_duck_up", gekk_duck_up);
registerSaveFunction("m_gekk:gekk_duck_hold", gekk_duck_hold);
registerSaveFunction("m_gekk:gekk_dodge", gekk_dodge);
registerSaveFunction("m_gekk:water_to_land", water_to_land);
registerSaveFunction("m_gekk:land_to_water", land_to_water);
registerSaveMmove("m_gekk:gekk_move_stand", gekk_move_stand);
registerSaveMmove("m_gekk:gekk_move_standunderwater", gekk_move_standunderwater);
registerSaveMmove("m_gekk:gekk_move_swim_loop", gekk_move_swim_loop);
registerSaveMmove("m_gekk:gekk_move_swim_start", gekk_move_swim_start);
registerSaveMmove("m_gekk:gekk_move_idle", gekk_move_idle);
registerSaveMmove("m_gekk:gekk_move_idle2", gekk_move_idle2);
registerSaveMmove("m_gekk:gekk_move_chant", gekk_move_chant);
registerSaveMmove("m_gekk:gekk_move_walk", gekk_move_walk);
registerSaveMmove("m_gekk:gekk_move_run", gekk_move_run);
registerSaveMmove("m_gekk:gekk_move_run_start", gekk_move_run_start);
registerSaveMmove("m_gekk:gekk_move_spit", gekk_move_spit);
registerSaveMmove("m_gekk:gekk_move_attack1", gekk_move_attack1);
registerSaveMmove("m_gekk:gekk_move_attack2", gekk_move_attack2);
registerSaveMmove("m_gekk:gekk_move_leapatk", gekk_move_leapatk);
registerSaveMmove("m_gekk:gekk_move_leapatk2", gekk_move_leapatk2);
registerSaveMmove("m_gekk:gekk_move_attack", gekk_move_attack);
registerSaveMmove("m_gekk:gekk_move_pain", gekk_move_pain);
registerSaveMmove("m_gekk:gekk_move_pain1", gekk_move_pain1);
registerSaveMmove("m_gekk:gekk_move_pain2", gekk_move_pain2);
registerSaveMmove("m_gekk:gekk_move_death1", gekk_move_death1);
registerSaveMmove("m_gekk:gekk_move_death3", gekk_move_death3);
registerSaveMmove("m_gekk:gekk_move_death4", gekk_move_death4);
registerSaveMmove("m_gekk:gekk_move_wdeath", gekk_move_wdeath);
registerSaveMmove("m_gekk:gekk_move_lduck", gekk_move_lduck);
registerSaveMmove("m_gekk:gekk_move_rduck", gekk_move_rduck);
