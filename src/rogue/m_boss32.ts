/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_boss32.c (GNU GPL v2 or later).
*/
/*
==============================================================================

Makron -- Final Boss

==============================================================================
*/
//
// rogue/m_boss32.c vs baseq2/m_boss32.c: banner swap plus one addition --
// SP_monster_makron sets `self->monsterinfo.aiflags |= AI_IGNORE_SHOTS;`
// right after walkmonster_start(self) (rogue/m_boss32.c:849-851, wrapped in
// "//PMM"/"//pmm" markers). Everything else is copied from
// src/game/m_boss32.ts with sibling imports repointed at the flat
// src/rogue/ layout.

import { AngleVectors, random, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorSet, VectorSubtract, vec3, vec3_origin, type Vec3 } from "../shared/math";
import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_BODY,
  CHAN_VOICE,
  CHAN_WEAPON,
  CONTENTS_LAVA,
  CONTENTS_MONSTER,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  EF_BLASTER,
  MZ2_MAKRON_BFG,
  MZ2_MAKRON_BLASTER_1,
  MZ2_MAKRON_RAILGUN_1,
  YAW,
} from "../shared/q_shared";
import {
  AI_IGNORE_SHOTS,
  AI_STAND_GROUND,
  AS_MELEE,
  AS_MISSILE,
  AS_SLIDING,
  AS_STRAIGHT,
  DamageT,
  DEAD_DEAD,
  type EdictT,
  FL_FLY,
  FRAMETIME,
  g_edicts,
  gameCvars,
  GIB_METALLIC,
  GIB_ORGANIC,
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
import { monster_fire_bfg, monster_fire_blaster, monster_fire_railgun, walkmonster_start } from "./g_monster";
import { G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles, vectoyaw } from "./g_utils";
import { ThrowGib, ThrowHead } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import * as FRAME from "./m_boss32_frames";

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

let sound_pain4 = 0;
let sound_pain5 = 0;
let sound_pain6 = 0;
let sound_death = 0;
let sound_step_left = 0;
let sound_step_right = 0;
let sound_attack_bfg = 0;
let sound_brainsplorch = 0;
let sound_prerailgun = 0;
let sound_popup = 0;
let sound_taunt1 = 0;
let sound_taunt2 = 0;
let sound_taunt3 = 0;
let sound_hit = 0;

function makron_taunt(self: EdictT): void {
  const r = random();
  if (r <= 0.3) gi.sound(self, CHAN_AUTO, sound_taunt1, 1, ATTN_NONE, 0);
  else if (r <= 0.6) gi.sound(self, CHAN_AUTO, sound_taunt2, 1, ATTN_NONE, 0);
  else gi.sound(self, CHAN_AUTO, sound_taunt3, 1, ATTN_NONE, 0);
}

//
// stand
//

const makron_frames_stand: MframeT[] = Array.from({ length: 60 }, () => mkframe(ai_stand, 0));
const makron_move_stand = mkmove(FRAME.FRAME_stand201, FRAME.FRAME_stand260, makron_frames_stand);

function makron_stand(self: EdictT): void {
  self.monsterinfo.currentmove = makron_move_stand;
}

const makron_frames_run: MframeT[] = [
  mkframe(ai_run, 3, makron_step_left),
  mkframe(ai_run, 12),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8),
  mkframe(ai_run, 8, makron_step_right),
  mkframe(ai_run, 6),
  mkframe(ai_run, 12),
  mkframe(ai_run, 9),
  mkframe(ai_run, 6),
  mkframe(ai_run, 12),
];
const makron_move_run = mkmove(FRAME.FRAME_walk204, FRAME.FRAME_walk213, makron_frames_run);

function makron_hit(self: EdictT): void {
  gi.sound(self, CHAN_AUTO, sound_hit, 1, ATTN_NONE, 0);
}

function makron_popup(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_popup, 1, ATTN_NONE, 0);
}

function makron_step_left(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step_left, 1, ATTN_NORM, 0);
}

function makron_step_right(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step_right, 1, ATTN_NORM, 0);
}

function makron_brainsplorch(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_brainsplorch, 1, ATTN_NORM, 0);
}

function makron_prerailgun(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_prerailgun, 1, ATTN_NORM, 0);
}

// makron_frames_walk is defined (matching m_boss32.c's table, using ai_walk)
// but makron_move_walk below actually points at makron_frames_run, exactly
// as m_boss32.c does -- a faithfully preserved bug/quirk in the original,
// not a transcription error here.
const makron_frames_walk: MframeT[] = [
  mkframe(ai_walk, 3, makron_step_left),
  mkframe(ai_walk, 12),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 8, makron_step_right),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 12),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 12),
];
const makron_move_walk = mkmove(FRAME.FRAME_walk204, FRAME.FRAME_walk213, makron_frames_run);

function makron_walk(self: EdictT): void {
  self.monsterinfo.currentmove = makron_move_walk;
}

function makron_run(self: EdictT): void {
  if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = makron_move_stand;
  else self.monsterinfo.currentmove = makron_move_run;
}

const makron_frames_pain6: MframeT[] = [
  ...Array.from({ length: 15 }, () => mkframe(ai_move, 0)),
  mkframe(ai_move, 0, makron_popup),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0, makron_taunt),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const makron_move_pain6 = mkmove(FRAME.FRAME_pain601, FRAME.FRAME_pain627, makron_frames_pain6, makron_run);

const makron_frames_pain5: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const makron_move_pain5 = mkmove(FRAME.FRAME_pain501, FRAME.FRAME_pain504, makron_frames_pain5, makron_run);

const makron_frames_pain4: MframeT[] = Array.from({ length: 4 }, () => mkframe(ai_move, 0));
const makron_move_pain4 = mkmove(FRAME.FRAME_pain401, FRAME.FRAME_pain404, makron_frames_pain4, makron_run);

const makron_frames_death2: MframeT[] = [
  mkframe(ai_move, -15),
  mkframe(ai_move, 3),
  mkframe(ai_move, -12),
  mkframe(ai_move, 0, makron_step_left),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 11),
  mkframe(ai_move, 12),
  mkframe(ai_move, 11, makron_step_right),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 5),
  mkframe(ai_move, 7),
  mkframe(ai_move, 6, makron_step_left),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -6),
  mkframe(ai_move, -4),
  mkframe(ai_move, -6, makron_step_right),
  mkframe(ai_move, -4),
  mkframe(ai_move, -4, makron_step_left),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, -5),
  mkframe(ai_move, -3, makron_step_right),
  mkframe(ai_move, -8),
  mkframe(ai_move, -3, makron_step_left),
  mkframe(ai_move, -7),
  mkframe(ai_move, -4),
  mkframe(ai_move, -4, makron_step_right),
  mkframe(ai_move, -6),
  mkframe(ai_move, -7),
  mkframe(ai_move, 0, makron_step_left),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 27, makron_hit),
  mkframe(ai_move, 26),
  mkframe(ai_move, 0, makron_brainsplorch),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const makron_move_death2 = mkmove(FRAME.FRAME_death201, FRAME.FRAME_death295, makron_frames_death2, makron_dead);

const makron_frames_death3: MframeT[] = Array.from({ length: 20 }, () => mkframe(ai_move, 0));
const makron_move_death3 = mkmove(FRAME.FRAME_death301, FRAME.FRAME_death320, makron_frames_death3);

const makron_frames_sight: MframeT[] = Array.from({ length: 13 }, () => mkframe(ai_move, 0));
const makron_move_sight = mkmove(FRAME.FRAME_active01, FRAME.FRAME_active13, makron_frames_sight, makron_run);

function makronBFG(self: EdictT): void {
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const dir = vec3();
  const vec = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_MAKRON_BFG], forward, right, start);

  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, vec);
  vec[2] += self.enemy.viewheight;
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);
  gi.sound(self, CHAN_VOICE, sound_attack_bfg, 1, ATTN_NORM, 0);
  monster_fire_bfg(self, start, dir, 50, 300, 100, 300, MZ2_MAKRON_BFG);
}

const makron_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, makronBFG), // FIXME: BFG Attack here
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const makron_move_attack3 = mkmove(FRAME.FRAME_attak301, FRAME.FRAME_attak308, makron_frames_attack3, makron_run);

const makron_frames_attack4: MframeT[] = [
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  ...Array.from({ length: 17 }, () => mkframe(ai_move, 0, MakronHyperblaster)),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const makron_move_attack4 = mkmove(FRAME.FRAME_attak401, FRAME.FRAME_attak426, makron_frames_attack4, makron_run);

const makron_frames_attack5: MframeT[] = [
  mkframe(ai_charge, 0, makron_prerailgun),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0),
  mkframe(ai_charge, 0, MakronSaveloc),
  mkframe(ai_move, 0, MakronRailgun), // Fire railgun
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
  mkframe(ai_move, 0),
];
const makron_move_attack5 = mkmove(FRAME.FRAME_attak501, FRAME.FRAME_attak516, makron_frames_attack5, makron_run);

function MakronSaveloc(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here
  VectorCopy(self.enemy.s.origin, self.pos1); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
}

// FIXME: He's not firing from the proper Z
function MakronRailgun(self: EdictT): void {
  const start = vec3();
  const dir = vec3();
  const forward = vec3();
  const right = vec3();

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[MZ2_MAKRON_RAILGUN_1], forward, right, start);

  // calc direction to where we targted
  VectorSubtract(self.pos1, start, dir);
  VectorNormalize(dir);

  monster_fire_railgun(self, start, dir, 50, 100, MZ2_MAKRON_RAILGUN_1);
}

// FIXME: This is all wrong. He's not firing at the proper angles.
function MakronHyperblaster(self: EdictT): void {
  const dir = vec3();
  const vec = vec3();
  const start = vec3();
  const forward = vec3();
  const right = vec3();

  const flash_number = MZ2_MAKRON_BLASTER_1 + (self.s.frame - FRAME.FRAME_attak405);

  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  if (self.enemy !== null) {
    VectorCopy(self.enemy.s.origin, vec);
    vec[2] += self.enemy.viewheight;
    VectorSubtract(vec, start, vec);
    vectoangles(vec, vec);
    dir[0] = vec[0];
  } else {
    dir[0] = 0;
  }
  if (self.s.frame <= FRAME.FRAME_attak413) dir[1] = self.s.angles[1] - 10 * (self.s.frame - FRAME.FRAME_attak413);
  else dir[1] = self.s.angles[1] + 10 * (self.s.frame - FRAME.FRAME_attak421);
  dir[2] = 0;

  AngleVectors(dir, forward, null, null);

  monster_fire_blaster(self, start, forward, 15, 1000, MZ2_MAKRON_BLASTER_1, EF_BLASTER);
}

function makron_pain(self: EdictT, _other: EdictT, _kick: number, damage: number): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames
  if (damage <= 25) {
    if (random() < 0.2) return;
  }

  self.pain_debounce_time = level.time + 3;
  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  if (damage <= 40) {
    gi.sound(self, CHAN_VOICE, sound_pain4, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = makron_move_pain4;
  } else if (damage <= 110) {
    gi.sound(self, CHAN_VOICE, sound_pain5, 1, ATTN_NONE, 0);
    self.monsterinfo.currentmove = makron_move_pain5;
  } else {
    if (damage <= 150) {
      if (random() <= 0.45) {
        gi.sound(self, CHAN_VOICE, sound_pain6, 1, ATTN_NONE, 0);
        self.monsterinfo.currentmove = makron_move_pain6;
      }
    } else if (random() <= 0.35) {
      gi.sound(self, CHAN_VOICE, sound_pain6, 1, ATTN_NONE, 0);
      self.monsterinfo.currentmove = makron_move_pain6;
    }
  }
}

function makron_sight(self: EdictT, _other: EdictT): void {
  self.monsterinfo.currentmove = makron_move_sight;
}

function makron_attack(self: EdictT): void {
  if (self.enemy === null) return; // C assumes self->enemy is set here

  const vec = vec3();
  VectorSubtract(self.enemy.s.origin, self.s.origin, vec);
  // range mirrors m_boss32.c's local of the same name: computed but, like
  // the original, never consulted below.
  const range = VectorLength(vec);

  const r = random();

  if (r <= 0.3) self.monsterinfo.currentmove = makron_move_attack3;
  else if (r <= 0.6) self.monsterinfo.currentmove = makron_move_attack4;
  else self.monsterinfo.currentmove = makron_move_attack5;
}

/*
---
Makron Torso. This needs to be spawned in
---
*/

function makron_torso_think(self: EdictT): void {
  if (++self.s.frame < 365) {
    self.nextthink = level.time + FRAMETIME;
  } else {
    self.s.frame = 346;
    self.nextthink = level.time + FRAMETIME;
  }
}

function makron_torso(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.solid = SolidT.SOLID_NOT;
  VectorSet(ent.mins, -8, -8, 0);
  VectorSet(ent.maxs, 8, 8, 8);
  ent.s.frame = 346;
  ent.s.modelindex = gi.modelindex("models/monsters/boss3/rider/tris.md2");
  ent.think = makron_torso_think;
  ent.nextthink = level.time + 2 * FRAMETIME;
  ent.s.sound = gi.soundindex("makron/spine.wav");
  gi.linkentity(ent);
}

//
// death
//

function makron_dead(self: EdictT): void {
  VectorSet(self.mins, -60, -60, 0);
  VectorSet(self.maxs, 60, 60, 72);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SVF_DEADMONSTER;
  self.nextthink = 0;
  gi.linkentity(self);
}

function makron_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3): void {
  self.s.sound = 0;
  // check for gib
  if (self.health <= self.gib_health) {
    gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    for (let n = 0; n < 1 /*4*/; n++) ThrowGib(self, "models/objects/gibs/sm_meat/tris.md2", damage, GIB_ORGANIC);
    for (let n = 0; n < 4; n++) ThrowGib(self, "models/objects/gibs/sm_metal/tris.md2", damage, GIB_METALLIC);
    ThrowHead(self, "models/objects/gibs/gear/tris.md2", damage, GIB_METALLIC);
    self.deadflag = DEAD_DEAD;
    return;
  }

  if (self.deadflag === DEAD_DEAD) return;

  // regular death
  gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NONE, 0);
  self.deadflag = DEAD_DEAD;
  self.takedamage = DamageT.DAMAGE_YES;

  const tempent = G_Spawn();
  VectorCopy(self.s.origin, tempent.s.origin);
  VectorCopy(self.s.angles, tempent.s.angles);
  tempent.s.origin[1] -= 84;
  makron_torso(tempent);

  self.monsterinfo.currentmove = makron_move_death2;
}

function Makron_CheckAttack(self: EdictT): boolean {
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

  // enemy_infront mirrors m_boss32.c's local of the same name: computed but,
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

//
// monster_makron
//

export function MakronPrecache(): void {
  sound_pain4 = gi.soundindex("makron/pain3.wav");
  sound_pain5 = gi.soundindex("makron/pain2.wav");
  sound_pain6 = gi.soundindex("makron/pain1.wav");
  sound_death = gi.soundindex("makron/death.wav");
  sound_step_left = gi.soundindex("makron/step1.wav");
  sound_step_right = gi.soundindex("makron/step2.wav");
  sound_attack_bfg = gi.soundindex("makron/bfg_fire.wav");
  sound_brainsplorch = gi.soundindex("makron/brain1.wav");
  sound_prerailgun = gi.soundindex("makron/rail_up.wav");
  sound_popup = gi.soundindex("makron/popup.wav");
  sound_taunt1 = gi.soundindex("makron/voice4.wav");
  sound_taunt2 = gi.soundindex("makron/voice3.wav");
  sound_taunt3 = gi.soundindex("makron/voice.wav");
  sound_hit = gi.soundindex("makron/bhit.wav");

  gi.modelindex("models/monsters/boss3/rider/tris.md2");
}

/*QUAKED monster_makron (1 .5 0) (-30 -30 0) (30 30 90) Ambush Trigger_Spawn Sight
*/
export function SP_monster_makron(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  MakronPrecache();

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss3/rider/tris.md2");
  VectorSet(self.mins, -30, -30, 0);
  VectorSet(self.maxs, 30, 30, 90);

  self.health = 3000;
  self.gib_health = -2000;
  self.mass = 500;

  self.pain = makron_pain;
  self.die = makron_die;
  self.monsterinfo.stand = makron_stand;
  self.monsterinfo.walk = makron_walk;
  self.monsterinfo.run = makron_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = makron_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = makron_sight;
  self.monsterinfo.checkattack = Makron_CheckAttack;

  gi.linkentity(self);

  // self.monsterinfo.currentmove = makron_move_stand;
  self.monsterinfo.currentmove = makron_move_sight;
  self.monsterinfo.scale = FRAME.MODEL_SCALE;

  walkmonster_start(self);

  // ROGUE (rogue/m_boss32.c:849-851, "//PMM"/"//pmm")
  self.monsterinfo.aiflags |= AI_IGNORE_SHOTS;
}

/*
=================
MakronSpawn

=================
*/
function MakronSpawn(self: EdictT): void {
  SP_monster_makron(self);

  // jump at player
  const player = level.sight_client;
  if (player === null) return;

  const vec = vec3();
  VectorSubtract(player.s.origin, self.s.origin, vec);
  self.s.angles[YAW] = vectoyaw(vec);
  VectorNormalize(vec);
  VectorMA(vec3_origin, 400, vec, self.velocity);
  self.velocity[2] = 200;
  self.groundentity = null;
}

/*
=================
MakronToss

Jorg is just about dead, so set up to launch Makron out
=================
*/
export function MakronToss(self: EdictT): void {
  const ent = G_Spawn();
  ent.nextthink = level.time + 0.8;
  ent.think = MakronSpawn;
  ent.target = self.target;
  VectorCopy(self.s.origin, ent.s.origin);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_boss32:makron_torso_think", makron_torso_think);
registerSaveFunction("m_boss32:makron_pain", makron_pain);
registerSaveFunction("m_boss32:makron_die", makron_die);
registerSaveFunction("m_boss32:MakronSpawn", MakronSpawn);
registerSaveFunction("m_boss32:makron_stand", makron_stand);
registerSaveFunction("m_boss32:makron_walk", makron_walk);
registerSaveFunction("m_boss32:makron_run", makron_run);
registerSaveFunction("m_boss32:makron_attack", makron_attack);
registerSaveFunction("m_boss32:makron_sight", makron_sight);
registerSaveFunction("m_boss32:Makron_CheckAttack", Makron_CheckAttack);
registerSaveMmove("m_boss32:makron_move_stand", makron_move_stand);
registerSaveMmove("m_boss32:makron_move_run", makron_move_run);
registerSaveMmove("m_boss32:makron_move_walk", makron_move_walk);
registerSaveMmove("m_boss32:makron_move_pain6", makron_move_pain6);
registerSaveMmove("m_boss32:makron_move_pain5", makron_move_pain5);
registerSaveMmove("m_boss32:makron_move_pain4", makron_move_pain4);
registerSaveMmove("m_boss32:makron_move_death2", makron_move_death2);
registerSaveMmove("m_boss32:makron_move_death3", makron_move_death3);
registerSaveMmove("m_boss32:makron_move_sight", makron_move_sight);
registerSaveMmove("m_boss32:makron_move_attack3", makron_move_attack3);
registerSaveMmove("m_boss32:makron_move_attack4", makron_move_attack4);
registerSaveMmove("m_boss32:makron_move_attack5", makron_move_attack5);
