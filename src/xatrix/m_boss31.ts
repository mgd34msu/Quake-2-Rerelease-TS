/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_boss31.c (GNU GPL v2 or later).
*/
/*
==============================================================================

jorg

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_BODY,
  CHAN_VOICE,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  MZ2_JORG_BFG_1,
  MZ2_JORG_MACHINEGUN_L1,
  MZ2_JORG_MACHINEGUN_R1,
} from "../shared/q_shared";
import {
  AI_STAND_GROUND,
  AS_MELEE,
  AS_MISSILE,
  AS_SLIDING,
  AS_STRAIGHT,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  g_edicts,
  gameCvars,
  gi,
  level,
  MframeT,
  MmoveT,
  MovetypeT,
  RANGE_FAR,
  RANGE_MELEE,
  RANGE_MID,
  RANGE_NEAR,
} from "./g_local";
import { type Edict, SolidT } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, infront, range as monsterRange, visible } from "./g_ai";
import { monster_fire_bfg, monster_fire_bullet, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, vectoyaw } from "./g_utils";
import { monsterFlashOffset } from "./m_flash";
// m_boss31.c only forward-declares `void BossExplode (edict_t *self);`; the
// one real definition lives in m_supertank.c -- see m_boss2.ts for the same
// idiom (BossExplode reused via extern linkage in the original C).
import { BossExplode } from "./m_supertank";
import { MakronPrecache, MakronToss } from "./m_boss32";
import * as FRAME from "./m_boss31_frames";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function mkframe(aifunc: ((self: EdictT, dist: number) => void) | null, dist: number, thinkfunc: ((self: EdictT) => void) | null = null): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mkmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: ((self: EdictT) => void) | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// trace_t.ent recovery idiom (see g_monster.ts's traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way. Module-local per
// PORTING.md (each ported file that needs it keeps its own copy).
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_pain3 = 0;
let sound_idle = 0;
let sound_death = 0;
let sound_search1 = 0;
let sound_search2 = 0;
let sound_search3 = 0;
let sound_attack1 = 0;
let sound_attack2 = 0;
let sound_step_left = 0;
let sound_step_right = 0;
let sound_death_hit = 0;

function jorg_search(self: EdictT): void {
  const r = random();

  if (r <= 0.3) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NORM, 0);
  else if (r <= 0.6) gi.sound(self, CHAN_VOICE, sound_search2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_search3, 1, ATTN_NORM, 0);
}

//
// stand
//

const jorg_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0, jorg_idle),
    mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 19),
  mkframe(ai_stand, 11, jorg_step_left),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 6),
  mkframe(ai_stand, 9, jorg_step_right),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -2),
  mkframe(ai_stand, -17, jorg_step_left),
  mkframe(ai_stand, 0),
  mkframe(ai_stand, -12),
  mkframe(ai_stand, -14, jorg_step_right),
];
const jorg_move_stand = mkmove(FRAME.FRAME_stand01, FRAME.FRAME_stand51, jorg_frames_stand);

function jorg_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_NORM, 0);
}

function jorg_death_hit(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_death_hit, 1, ATTN_NORM, 0);
}

function jorg_step_left(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step_left, 1, ATTN_NORM, 0);
}

function jorg_step_right(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step_right, 1, ATTN_NORM, 0);
}

function jorg_stand(self: EdictT): void {
  self.monsterinfo.currentmove = jorg_move_stand;
}

const jorg_frames_run: MframeT[] = [
  mkframe(ai_run, 17, jorg_step_left),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 12),
  mkframe(ai_run, 8),
  mkframe(ai_run, 10),
  mkframe(ai_run, 33, jorg_step_right),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 0),
  mkframe(ai_run, 9),
  mkframe(ai_run, 9),
  mkframe(ai_run, 9),
];
const jorg_move_run = mkmove(FRAME.FRAME_walk06, FRAME.FRAME_walk19, jorg_frames_run);

//
// walk
//

const jorg_frames_start_walk: MframeT[] = [
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 15),
];
const jorg_move_start_walk = mkmove(FRAME.FRAME_walk01, FRAME.FRAME_walk05, jorg_frames_start_walk);

const jorg_frames_walk: MframeT[] = [
  mkframe(ai_walk, 17),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 12),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 33),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 9),
];
const jorg_move_walk = mkmove(FRAME.FRAME_walk06, FRAME.FRAME_walk19, jorg_frames_walk);

const jorg_frames_end_walk: MframeT[] = [
  mkframe(ai_walk, 11),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 0),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, -8),
];
const jorg_move_end_walk = mkmove(FRAME.FRAME_walk20, FRAME.FRAME_walk25, jorg_frames_end_walk);

function jorg_walk(self: EdictT): void {
  self.monsterinfo.currentmove = jorg_move_walk;
}

function jorg_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = jorg_move_stand;
  else self.monsterinfo.currentmove = jorg_move_run;
}

const jorg_frames_pain3: MframeT[] = [
  mkframe(ai_move, -28),
  mkframe(ai_move, -6),
  mkframe(ai_move, -3, jorg_step_left),
  mkframe(ai_move, -9),
  mkframe(ai_move, 0, jorg_step_right),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -7),
  mkframe(ai_move, 1),
  mkframe(ai_move, -11),
  mkframe(ai_move, -4),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 10),
  mkframe(ai_move, 11),
  mkframe(ai_move, 0),
  mkframe(ai_move, 10),
  mkframe(ai_move, 3),
  mkframe(ai_move, 10),
  mkframe(ai_move, 7, jorg_step_left),
  mkframe(ai_move, 17),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, jorg_step_right),
];
const jorg_move_pain3 = mkmove(FRAME.FRAME_pain301, FRAME.FRAME_pain325, jorg_frames_pain3, jorg_run);

const jorg_frames_pain2: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0)];
const jorg_move_pain2 = mkmove(FRAME.FRAME_pain201, FRAME.FRAME_pain203, jorg_frames_pain2, jorg_run);

const jorg_frames_pain1: MframeT[] = [mkframe(ai_move, 0), mkframe(ai_move, 0), mkframe(ai_move, 0)];
const jorg_move_pain1 = mkmove(FRAME.FRAME_pain101, FRAME.FRAME_pain103, jorg_frames_pain1, jorg_run);

const jorg_frames_death1: MframeT[] = [
  ...Array.from({ length: 48 }, () => mkframe(ai_move, 0)),
  mkframe(ai_move, 0, MakronToss),
  mkframe(ai_move, 0, BossExplode),
];
const jorg_move_death = mkmove(FRAME.FRAME_death01, FRAME.FRAME_death50, jorg_frames_death1, jorg_dead);

const jorg_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, jorgBFG),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const jorg_move_attack2 = mkmove(FRAME.FRAME_attak201, FRAME.FRAME_attak213, jorg_frames_attack2, jorg_run);

const jorg_frames_start_attack1: MframeT[] = Array.from({ length: 8 }, () => mkframe(ai_charge, 0));
const jorg_move_start_attack1 = mkmove(FRAME.FRAME_attak101, FRAME.FRAME_attak108, jorg_frames_start_attack1, jorg_attack1);

const jorg_frames_attack1: MframeT[] = Array.from({ length: 6 }, () => mkframe(ai_charge, 0, jorg_firebullet));
const jorg_move_attack1 = mkmove(FRAME.FRAME_attak109, FRAME.FRAME_attak114, jorg_frames_attack1, jorg_reattack1);

const jorg_frames_end_attack1: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const jorg_move_end_attack1 = mkmove(FRAME.FRAME_attak115, FRAME.FRAME_attak118, jorg_frames_end_attack1, jorg_run);

function jorg_reattack1(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (random() < 0.9) self.monsterinfo.currentmove = jorg_move_attack1;
    else {
      self.s.sound = 0;
      self.monsterinfo.currentmove = jorg_move_end_attack1;
    }
  } else {
    self.s.sound = 0;
    self.monsterinfo.currentmove = jorg_move_end_attack1;
  }
}

function jorg_attack1(self: EdictT): void {
  self.monsterinfo.currentmove = jorg_move_attack1;
}

function jorg_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  self.s.sound = 0;

  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames if he takes little damage
  if (damage <= 40) {
    if (random() <= 0.6) return;
  }

  // If he's entering his attack1 or using attack1, lessen the chance of him
  // going into pain
  if (self.s.frame >= FRAME.FRAME_attak101 && self.s.frame <= FRAME.FRAME_attak108) {
    if (random() <= 0.005) return;
  }

  if (self.s.frame >= FRAME.FRAME_attak109 && self.s.frame <= FRAME.FRAME_attak114) {
    if (random() <= 0.00005) return;
  }

  if (self.s.frame >= FRAME.FRAME_attak201 && self.s.frame <= FRAME.FRAME_attak208) {
    if (random() <= 0.005) return;
  }

  self.pain_debounce_time = level.time + 3;
  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 50) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = jorg_move_pain1;
  } else if (damage <= 100) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = jorg_move_pain2;
  } else {
    if (random() <= 0.3) {
      gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NORM, 0);
      self.monsterinfo.currentmove = jorg_move_pain3;
    }
  }
}

function jorgBFG(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_JORG_BFG_1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  gi.sound(self, CHAN_VOICE, sound_attack2, 1, ATTN_NORM, 0);
  monster_fire_bfg(self, start, dir, 50, 300, 100, 200, MZ2_JORG_BFG_1);
}

function jorg_firebullet_right(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_JORG_MACHINEGUN_R1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);
  target[2] += self.enemy.viewheight;
  VectorSubtract(target, start, forward);
  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_JORG_MACHINEGUN_R1);
}

function jorg_firebullet_left(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_JORG_MACHINEGUN_L1], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);
  target[2] += self.enemy.viewheight;
  VectorSubtract(target, start, forward);
  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_JORG_MACHINEGUN_L1);
}

const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

function jorg_firebullet(self: EdictT): void {
  jorg_firebullet_left(self);
  jorg_firebullet_right(self);
}

function jorg_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const vec = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
  // range mirrors m_boss31.c's local of the same name: computed but, like
  // the original, never consulted below.
  const range = VectorLength(vec);

  if (random() <= 0.75) {
    gi.sound(self, CHAN_VOICE, sound_attack1, 1, ATTN_NORM, 0);
    self.s.sound = gi.soundindex("boss3/w_loop.wav");
    self.monsterinfo.currentmove = jorg_move_start_attack1;
  } else {
    gi.sound(self, CHAN_VOICE, sound_attack2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = jorg_move_attack2;
  }
}

// jorg_dead's body is entirely `#if 0`'d out in m_boss31.c (the tempent /
// SP_monster_makron spawn-on-death-anim-end path never compiled into the
// original game) -- MakronToss is what actually launches Makron, wired as a
// death-frame thinkfunc above. jorg_dead itself is a faithful no-op.
function jorg_dead(_self: EdictT): void {
  // (empty -- see comment above)
}

function jorg_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.s.sound = 0;
  self.count = 0;
  self.monsterinfo.currentmove = jorg_move_death;
}

function Jorg_CheckAttack(self: EdictT): boolean {
  if (self.enemy === null) return false; // C assumes self->enemy is set here

  if (self.enemy.health > 0) {
    // see if any entities are in the way of the shot
    const spot1 = vec3();
    const spot2 = vec3();
    VectorCopy(self.s.origin, spot1);
    spot1[2] += self.viewheight;
    VectorCopy(self.enemy.s.origin, spot2);
    spot2[2] += self.enemy.viewheight;

    const tr = gi.trace(spot1, null, null, spot2, self, CONTENTS_SOLID | CONTENTS_MONSTER | CONTENTS_SLIME | CONTENTS_LAVA);

    // do we have a clear shot?
    if (traceEdict(tr.ent) !== self.enemy) return false;
  }

  const enemy_infront = infront(self, self.enemy);
  const enemy_range = monsterRange(self, self.enemy);
  const temp = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, temp);
  const enemy_yaw = vectoyaw(temp);

  self.ideal_yaw = enemy_yaw;

  // enemy_infront mirrors m_boss31.c's local of the same name: computed but,
  // like the original, never consulted below.

  // melee attack
  if (enemy_range === RANGE_MELEE) {
    if (self.monsterinfo.melee) self.monsterinfo.attack_state = AS_MELEE;
    else self.monsterinfo.attack_state = AS_MISSILE;
    return true;
  }

  // missile attack
  if (!self.monsterinfo.attack) return false;

  if (level.time < self.monsterinfo.attack_finished) return false;

  if (enemy_range === RANGE_FAR) return false;

  let chance: number;
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) {
    chance = 0.4;
  } else if (enemy_range === RANGE_MELEE) {
    chance = 0.8;
  } else if (enemy_range === RANGE_NEAR) {
    chance = 0.4;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.2;
  } else {
    return false;
  }

  if (random() < chance) {
    self.monsterinfo.attack_state = AS_MISSILE;
    self.monsterinfo.attack_finished = level.time + 2 * random();
    return true;
  }

  if (self.flags & FL_FLY) {
    if (random() < 0.3) self.monsterinfo.attack_state = AS_SLIDING;
    else self.monsterinfo.attack_state = AS_STRAIGHT;
  }

  return false;
}

/*QUAKED monster_jorg (1 .5 0) (-80 -80 0) (90 90 140) Ambush Trigger_Spawn Sight
*/
export function SP_monster_jorg(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("boss3/bs3pain1.wav");
  sound_pain2 = gi.soundindex("boss3/bs3pain2.wav");
  sound_pain3 = gi.soundindex("boss3/bs3pain3.wav");
  sound_death = gi.soundindex("boss3/bs3deth1.wav");
  sound_attack1 = gi.soundindex("boss3/bs3atck1.wav");
  sound_attack2 = gi.soundindex("boss3/bs3atck2.wav");
  sound_search1 = gi.soundindex("boss3/bs3srch1.wav");
  sound_search2 = gi.soundindex("boss3/bs3srch2.wav");
  sound_search3 = gi.soundindex("boss3/bs3srch3.wav");
  sound_idle = gi.soundindex("boss3/bs3idle1.wav");
  sound_step_left = gi.soundindex("boss3/step1.wav");
  sound_step_right = gi.soundindex("boss3/step2.wav");
  gi.soundindex("boss3/xfire.wav");
  sound_death_hit = gi.soundindex("boss3/d_hit.wav");

  MakronPrecache();

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss3/rider/tris.md2");
  self.s.modelindex2 = gi.modelindex("models/monsters/boss3/jorg/tris.md2");
  VectorSet(self.mins, -80, -80, 0);
  VectorSet(self.maxs, 80, 80, 140);

  self.health = 3000;
  self.gib_health = -2000;
  self.mass = 1000;

  self.pain = jorg_pain;
  self.die = jorg_die;
  self.monsterinfo.stand = jorg_stand;
  self.monsterinfo.walk = jorg_walk;
  self.monsterinfo.run = jorg_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = jorg_attack;
  self.monsterinfo.search = jorg_search;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;
  self.monsterinfo.checkattack = Jorg_CheckAttack;
  gi.linkentity(self);

  self.monsterinfo.currentmove = jorg_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);
}

// jorg_move_start_walk and jorg_move_end_walk are defined (matching
// m_boss31.c's tables) but never wired to a monsterinfo callback in
// m_boss31.c either -- jorg_walk always sets jorg_move_walk directly.
// jorg_death_hit is likewise defined but never referenced by any frame
// table in the original. Dead code in the original, preserved faithfully
// rather than pruned.

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_boss31:jorg_pain", jorg_pain);
registerSaveFunction("m_boss31:jorg_die", jorg_die);
registerSaveFunction("m_boss31:jorg_stand", jorg_stand);
registerSaveFunction("m_boss31:jorg_walk", jorg_walk);
registerSaveFunction("m_boss31:jorg_run", jorg_run);
registerSaveFunction("m_boss31:jorg_attack", jorg_attack);
registerSaveFunction("m_boss31:jorg_search", jorg_search);
registerSaveFunction("m_boss31:Jorg_CheckAttack", Jorg_CheckAttack);
registerSaveMmove("m_boss31:jorg_move_stand", jorg_move_stand);
registerSaveMmove("m_boss31:jorg_move_run", jorg_move_run);
registerSaveMmove("m_boss31:jorg_move_start_walk", jorg_move_start_walk);
registerSaveMmove("m_boss31:jorg_move_walk", jorg_move_walk);
registerSaveMmove("m_boss31:jorg_move_end_walk", jorg_move_end_walk);
registerSaveMmove("m_boss31:jorg_move_pain3", jorg_move_pain3);
registerSaveMmove("m_boss31:jorg_move_pain2", jorg_move_pain2);
registerSaveMmove("m_boss31:jorg_move_pain1", jorg_move_pain1);
registerSaveMmove("m_boss31:jorg_move_death", jorg_move_death);
registerSaveMmove("m_boss31:jorg_move_attack2", jorg_move_attack2);
registerSaveMmove("m_boss31:jorg_move_start_attack1", jorg_move_start_attack1);
registerSaveMmove("m_boss31:jorg_move_attack1", jorg_move_attack1);
registerSaveMmove("m_boss31:jorg_move_end_attack1", jorg_move_end_attack1);
