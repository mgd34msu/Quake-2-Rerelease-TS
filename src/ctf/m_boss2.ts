/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_boss2.c (GNU GPL v2 or later).
*/
/*
==============================================================================

boss2

==============================================================================
*/

import { AngleVectors, random, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_VOICE,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  MZ2_BOSS2_MACHINEGUN_L1,
  MZ2_BOSS2_MACHINEGUN_R1,
  MZ2_BOSS2_ROCKET_1,
  MZ2_BOSS2_ROCKET_2,
  MZ2_BOSS2_ROCKET_3,
  MZ2_BOSS2_ROCKET_4,
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
  FL_IMMUNE_LASER,
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
import { type Edict, SolidT, SVF_DEADMONSTER } from "./game";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, infront, range as monsterRange } from "./g_ai";
import { flymonster_start, monster_fire_bullet, monster_fire_rocket } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, vectoyaw } from "./g_utils";
import { monsterFlashOffset } from "./m_flash";
// m_boss2.c only forward-declares `void BossExplode (edict_t *self);`; the
// one real definition lives in m_supertank.c and is reused here via extern
// linkage in the original C -- see m_supertank.ts's BossExplode for the body.
import { BossExplode } from "./m_supertank";
import * as FRAME from "./m_boss2_frames";

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

function mkmove(
  firstframe: number,
  lastframe: number,
  frame: MframeT[],
  endfunc: ((self: EdictT) => void) | null = null,
  allowFrameCountMismatch = false,
): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.allowFrameCountMismatch = allowFrameCountMismatch;
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
let sound_death = 0;
let sound_search1 = 0;

function boss2_search(self: EdictT): void {
  if (random() < 0.5) gi.sound(self, CHAN_VOICE, sound_search1, 1, ATTN_NONE, 0);
}

function Boss2Rocket(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();

  AngleVectors(self.s.angles, forward, right, null);

  if (self.enemy === null) return; // C assumes self->enemy is set here

  // 1
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_ROCKET_1], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_BOSS2_ROCKET_1);

  // 2
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_ROCKET_2], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_BOSS2_ROCKET_2);

  // 3
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_ROCKET_3], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_BOSS2_ROCKET_3);

  // 4
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_ROCKET_4], forward, right, start);
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  monster_fire_rocket(self, start, dir, 50, 500, MZ2_BOSS2_ROCKET_4);
}

function boss2_firebullet_right(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  if (self.enemy === null) return; // C assumes self->enemy is set here

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_MACHINEGUN_R1], forward, right, start);

  VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);
  target[2] += self.enemy.viewheight;
  VectorSubtract(target, start, forward);
  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_BOSS2_MACHINEGUN_R1);
}

function boss2_firebullet_left(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const target = vec3();
  const start = vec3();

  if (self.enemy === null) return; // C assumes self->enemy is set here

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_BOSS2_MACHINEGUN_L1], forward, right, start);

  VectorMA(self.enemy.s.origin, -0.2, self.enemy.velocity, target);

  target[2] += self.enemy.viewheight;
  VectorSubtract(target, start, forward);
  VectorNormalize(forward);

  monster_fire_bullet(self, start, forward, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MZ2_BOSS2_MACHINEGUN_L1);
}

const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;

function Boss2MachineGun(self: EdictT): void {
  boss2_firebullet_left(self);
  boss2_firebullet_right(self);
}

const boss2_frames_stand: MframeT[] = Array.from({ length: 21 }, () => mkframe(ai_stand, 0));
const boss2_move_stand = mkmove(FRAME.FRAME_stand30, FRAME.FRAME_stand50, boss2_frames_stand);

const boss2_frames_fidget: MframeT[] = Array.from({ length: 30 }, () => mkframe(ai_stand, 0));
// C bug, not a porting error: m_boss2.c defines FRAME_stand30=0 and
// FRAME_stand1=21 (m_boss2.h:24,45) and then declares
// `mmove_t boss2_move_fidget = {FRAME_stand1, FRAME_stand30, ...}` (m_boss2.c:213),
// i.e. firstframe(21) > lastframe(0) -- an inverted range in the original
// data, independent of the 30-row frame table. Preserved byte-for-byte.
const boss2_move_fidget = mkmove(FRAME.FRAME_stand1, FRAME.FRAME_stand30, boss2_frames_fidget, null, true);

const boss2_frames_walk: MframeT[] = Array.from({ length: 20 }, () => mkframe(ai_walk, 8));
const boss2_move_walk = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk20, boss2_frames_walk);

const boss2_frames_run: MframeT[] = Array.from({ length: 20 }, () => mkframe(ai_run, 8));
const boss2_move_run = mkmove(FRAME.FRAME_walk1, FRAME.FRAME_walk20, boss2_frames_run);

const boss2_frames_attack_pre_mg: MframeT[] = [
  ...Array.from({ length: 8 }, () => mkframe(ai_charge, 1)),
  mkframe(ai_charge, 1, boss2_attack_mg),
];
const boss2_move_attack_pre_mg = mkmove(FRAME.FRAME_attack1, FRAME.FRAME_attack9, boss2_frames_attack_pre_mg);

// Loop this
const boss2_frames_attack_mg: MframeT[] = [
  mkframe(ai_charge, 1, Boss2MachineGun),
  mkframe(ai_charge, 1, Boss2MachineGun),
  mkframe(ai_charge, 1, Boss2MachineGun),
  mkframe(ai_charge, 1, Boss2MachineGun),
  mkframe(ai_charge, 1, Boss2MachineGun),
  mkframe(ai_charge, 1, boss2_reattack_mg),
];
const boss2_move_attack_mg = mkmove(FRAME.FRAME_attack10, FRAME.FRAME_attack15, boss2_frames_attack_mg);

const boss2_frames_attack_post_mg: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_charge, 1));
const boss2_move_attack_post_mg = mkmove(FRAME.FRAME_attack16, FRAME.FRAME_attack19, boss2_frames_attack_post_mg, boss2_run);

const boss2_frames_attack_rocket: MframeT[] = [
  ...Array.from({ length: 12 }, () => mkframe(ai_charge, 1)),
  mkframe(ai_move, -20, Boss2Rocket),
  ...Array.from({ length: 8 }, () => mkframe(ai_charge, 1)),
];
const boss2_move_attack_rocket = mkmove(FRAME.FRAME_attack20, FRAME.FRAME_attack40, boss2_frames_attack_rocket, boss2_run);

const boss2_frames_pain_heavy: MframeT[] = Array.from({ length: 18 }, () => mkframe(ai_move, 0));
const boss2_move_pain_heavy = mkmove(FRAME.FRAME_pain2, FRAME.FRAME_pain19, boss2_frames_pain_heavy, boss2_run);

const boss2_frames_pain_light: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const boss2_move_pain_light = mkmove(FRAME.FRAME_pain20, FRAME.FRAME_pain23, boss2_frames_pain_light, boss2_run);

const boss2_frames_death: MframeT[] = [
  ...Array.from({ length: 48 }, () => mkframe(ai_move, 0)),
  mkframe(ai_move, 0, BossExplode),
];
const boss2_move_death = mkmove(FRAME.FRAME_death2, FRAME.FRAME_death50, boss2_frames_death, boss2_dead);

function boss2_stand(self: EdictT): void {
  self.monsterinfo.currentmove = boss2_move_stand;
}

function boss2_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = boss2_move_stand;
  else self.monsterinfo.currentmove = boss2_move_run;
}

function boss2_walk(self: EdictT): void {
  self.monsterinfo.currentmove = boss2_move_walk;
}

function boss2_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const vec = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
  const dist = VectorLength(vec);

  if (dist <= 125) {
    self.monsterinfo.currentmove = boss2_move_attack_pre_mg;
  } else {
    if (random() <= 0.6) self.monsterinfo.currentmove = boss2_move_attack_pre_mg;
    else self.monsterinfo.currentmove = boss2_move_attack_rocket;
  }
}

function boss2_attack_mg(self: EdictT): void {
  self.monsterinfo.currentmove = boss2_move_attack_mg;
}

function boss2_reattack_mg(self: EdictT): void {
  if (self.enemy !== null && infront(self, self.enemy)) {
    if (random() <= 0.7) self.monsterinfo.currentmove = boss2_move_attack_mg;
    else self.monsterinfo.currentmove = boss2_move_attack_post_mg;
  } else {
    self.monsterinfo.currentmove = boss2_move_attack_post_mg;
  }
}

function boss2_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  // American wanted these at no attenuation
  if (damage < 10) {
    gi.sound(self, CHAN_VOICE, sound_pain3, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = boss2_move_pain_light;
  } else if (damage < 30) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = boss2_move_pain_light;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = boss2_move_pain_heavy;
  }
}

function boss2_dead(self: EdictT): void {
  VectorSet(self.mins, -56, -56, 0);
  VectorSet(self.maxs, 56, 56, 80);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function boss2_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NONE, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_NO;
  self.count = 0;
  self.monsterinfo.currentmove = boss2_move_death;
}

function Boss2_CheckAttack(self: EdictT): boolean {
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

  // enemy_infront mirrors m_boss2.c's local of the same name: computed but,
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
    chance = 0.8;
  } else if (enemy_range === RANGE_MID) {
    chance = 0.8;
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

/*QUAKED monster_boss2 (1 .5 0) (-56 -56 0) (56 56 80) Ambush Trigger_Spawn Sight
*/
export function SP_monster_boss2(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("bosshovr/bhvpain1.wav");
  sound_pain2 = gi.soundindex("bosshovr/bhvpain2.wav");
  sound_pain3 = gi.soundindex("bosshovr/bhvpain3.wav");
  sound_death = gi.soundindex("bosshovr/bhvdeth1.wav");
  sound_search1 = gi.soundindex("bosshovr/bhvunqv1.wav");

  self.s.sound = gi.soundindex("bosshovr/bhvengn1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss2/tris.md2");
  VectorSet(self.mins, -56, -56, 0);
  VectorSet(self.maxs, 56, 56, 80);

  self.health = 2000;
  self.gib_health = -200;
  self.mass = 1000;

  self.flags |= FL_IMMUNE_LASER;

  self.pain = boss2_pain;
  self.die = boss2_die;

  self.monsterinfo.stand = boss2_stand;
  self.monsterinfo.walk = boss2_walk;
  self.monsterinfo.run = boss2_run;
  self.monsterinfo.attack = boss2_attack;
  self.monsterinfo.search = boss2_search;
  self.monsterinfo.checkattack = Boss2_CheckAttack;
  gi.linkentity(self);

  self.monsterinfo.currentmove = boss2_move_stand;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  flymonster_start(self);
}

// boss2_move_fidget is defined (matching m_boss2.c's table) but never wired
// to a monsterinfo callback in m_boss2.c either -- dead code in the
// original, preserved faithfully rather than pruned.

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_boss2:boss2_pain", boss2_pain);
registerSaveFunction("m_boss2:boss2_die", boss2_die);
registerSaveFunction("m_boss2:boss2_stand", boss2_stand);
registerSaveFunction("m_boss2:boss2_walk", boss2_walk);
registerSaveFunction("m_boss2:boss2_run", boss2_run);
registerSaveFunction("m_boss2:boss2_attack", boss2_attack);
registerSaveFunction("m_boss2:boss2_search", boss2_search);
registerSaveFunction("m_boss2:Boss2_CheckAttack", Boss2_CheckAttack);
registerSaveMmove("m_boss2:boss2_move_stand", boss2_move_stand);
registerSaveMmove("m_boss2:boss2_move_fidget", boss2_move_fidget);
registerSaveMmove("m_boss2:boss2_move_walk", boss2_move_walk);
registerSaveMmove("m_boss2:boss2_move_run", boss2_move_run);
registerSaveMmove("m_boss2:boss2_move_attack_pre_mg", boss2_move_attack_pre_mg);
registerSaveMmove("m_boss2:boss2_move_attack_mg", boss2_move_attack_mg);
registerSaveMmove("m_boss2:boss2_move_attack_post_mg", boss2_move_attack_post_mg);
registerSaveMmove("m_boss2:boss2_move_attack_rocket", boss2_move_attack_rocket);
registerSaveMmove("m_boss2:boss2_move_pain_heavy", boss2_move_pain_heavy);
registerSaveMmove("m_boss2:boss2_move_pain_light", boss2_move_pain_light);
registerSaveMmove("m_boss2:boss2_move_death", boss2_move_death);
