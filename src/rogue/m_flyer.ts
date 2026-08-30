/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from rogue/m_flyer.c (GNU GPL v2 or later).

rogue/m_flyer.c vs baseq2/m_flyer.c: adds a kamikaze variant spawned via a
new SP_monster_kamikaze (same file, mass 100 instead of 50, EF_ROCKET
effect bit, maxs shortened to 16x16x16 from 16x16x32 for both variants --
"used to be 32 tall .. was WAY too big"). Any flyer with mass > 50 routes
run/walk/stand/melee into a new flyer_move_kamikaze move (flyer_kamikaze_
check computes realrange() to the enemy each frame and self-destructs
within 90 units, dealing 50 radius damage via T_Damage and crediting the
spawning carrier's monsterinfo.monster_slots), and flyer_blocked (new)
detonates the kamikaze immediately when physically blocked instead of just
stopping. Normal (mass 50) flyers gain a skill-scaled circle-strafe attack
choice (flyer_move_attack3, "the daedalus strafes more"-style tuning
shared with m_hover.c) alongside the base's straight attack2, wired via
flyer_attack and finished via the existing hover_reattack-style
attack_state dispatch. flyer_pain now returns immediately for kamikazes
("kamikaze's don't feel pain"). flyer_fire/flyer_die gain the pack's usual
enemy-inuse guard. A commented-out pair of debug functions (showme1/showme2)
in rogue/m_flyer.c is left inert in the source and not ported, matching its
own dead state.
*/
/*
==============================================================================

flyer

==============================================================================
*/
// m_flyer.c

import { AngleVectors, random, vec3, vec3_origin, VectorCopy, VectorMA, VectorSet, VectorSubtract, type Vec3 } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  CHAN_VOICE,
  CHAN_WEAPON,
  EF_HYPERBLASTER,
  EF_ROCKET,
  MulticastT,
  MZ2_FLYER_BLASTER_1,
  MZ2_FLYER_BLASTER_2,
  Q_stricmp,
  TempEventT,
} from "../shared/q_shared";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range } from "./g_ai";
import {
  AI_STAND_GROUND,
  AS_SLIDING,
  AS_STRAIGHT,
  DAMAGE_RADIUS,
  type EdictT,
  gameCvars,
  gi,
  level,
  MELEE_DISTANCE,
  MframeT,
  MmoveT,
  MOD_UNKNOWN,
  MovetypeT,
  RANGE_MELEE,
  svc_temp_entity,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { flymonster_start, monster_fire_blaster } from "./g_monster";
import { G_FreeEdict, G_ProjectSource } from "./g_utils";
import { fire_hit } from "./g_weapon";
import { T_Damage } from "./g_combat";
import { SolidT } from "./game";
import { monsterFlashOffset } from "./m_flash";
// ROGUE -- the pack's shared blocked-check/range AI helpers (g_newai.c -- RG-systems' SCOPE)
import { blocked_checkshot, realrange } from "./g_newai";
import {
  ACTION_attack1,
  ACTION_attack2,
  ACTION_run,
  FRAME_attak101,
  FRAME_attak106,
  FRAME_attak107,
  FRAME_attak118,
  FRAME_attak119,
  FRAME_attak121,
  FRAME_attak201,
  FRAME_attak204,
  FRAME_attak207,
  FRAME_attak210,
  FRAME_attak217,
  FRAME_bankl01,
  FRAME_bankl07,
  FRAME_bankr01,
  FRAME_bankr07,
  FRAME_defens01,
  FRAME_defens06,
  FRAME_pain101,
  FRAME_pain109,
  FRAME_pain201,
  FRAME_pain204,
  FRAME_pain301,
  FRAME_pain304,
  FRAME_rollf01,
  FRAME_rollf09,
  FRAME_rollr01,
  FRAME_rollr02,
  FRAME_rollr06,
  FRAME_rollr09,
  FRAME_stand01,
  FRAME_stand45,
  FRAME_start01,
  FRAME_start06,
  FRAME_stop01,
  FRAME_stop07,
  MODEL_SCALE,
} from "./m_flyer_frames";

// Per-file local mirroring g_items.ts's own cvarNum (module-local there too,
// so not exported).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function mframe(
  aifunc: MframeT["aifunc"],
  dist: number,
  thinkfunc: MframeT["thinkfunc"] = null,
): MframeT {
  const f = new MframeT();
  f.aifunc = aifunc;
  f.dist = dist;
  f.thinkfunc = thinkfunc;
  return f;
}

function mmove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveT["endfunc"] = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// Used for start/stop frames.
let nextmove = 0;

let sound_sight = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_slash = 0;
let sound_sproing = 0;
let sound_die = 0;

function flyer_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}

function flyer_idle(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
}

function flyer_pop_blades(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sproing, 1, ATTN_NORM, 0);
}

// Forward references below rely on `function` hoisting -- every callback
// referenced inside a move table exists by the time this module finishes
// evaluating, regardless of textual order (unlike the C forward decls that
// are only needed to satisfy the compiler's declare-before-use rule).

const flyer_frames_stand: MframeT[] = Array.from({ length: 45 }, () => mframe(ai_stand, 0));
const flyer_move_stand = mmove(FRAME_stand01, FRAME_stand45, flyer_frames_stand, null);

const flyer_frames_walk: MframeT[] = Array.from({ length: 45 }, () => mframe(ai_walk, 5));
const flyer_move_walk = mmove(FRAME_stand01, FRAME_stand45, flyer_frames_walk, null);

const flyer_frames_run: MframeT[] = Array.from({ length: 45 }, () => mframe(ai_run, 10));
const flyer_move_run = mmove(FRAME_stand01, FRAME_stand45, flyer_frames_run, null);

// ROGUE -- kamikaze self-destruct loop
const flyer_frames_kamizake: MframeT[] = Array.from({ length: 5 }, () => mframe(ai_charge, 40, flyer_kamikaze_check));
export const flyer_move_kamikaze = mmove(FRAME_rollr02, FRAME_rollr06, flyer_frames_kamizake, flyer_kamikaze);
// ROGUE

function flyer_run(self: EdictT): void {
  // ROGUE: kamikazes (mass > 50) always route into the self-destruct loop
  if (self.mass > 50) {
    self.monsterinfo.currentmove = flyer_move_kamikaze;
  } else {
    if (self.monsterinfo.aiflags & AI_STAND_GROUND) self.monsterinfo.currentmove = flyer_move_stand;
    else self.monsterinfo.currentmove = flyer_move_run;
  }
}

function flyer_walk(self: EdictT): void {
  // ROGUE
  if (self.mass > 50) flyer_run(self);
  else self.monsterinfo.currentmove = flyer_move_walk;
}

function flyer_stand(self: EdictT): void {
  // ROGUE
  if (self.mass > 50) flyer_run(self);
  else self.monsterinfo.currentmove = flyer_move_stand;
}

// ROGUE -- kamikaze stuff

function flyer_kamikaze_explode(self: EdictT): void {
  const dir = vec3();

  if (
    self.monsterinfo.commander !== null &&
    self.monsterinfo.commander.inuse &&
    self.monsterinfo.commander.classname === "monster_carrier"
  ) {
    self.monsterinfo.commander.monsterinfo.monster_slots++;
  }

  if (self.enemy !== null) {
    VectorSubtract(self.enemy.s.origin, self.s.origin, dir);
    T_Damage(self.enemy, self, self, dir, self.s.origin, vec3_origin, 50, 50, DAMAGE_RADIUS, MOD_UNKNOWN);
  }

  flyer_die(self, null, null, 0, dir);
}

function flyer_kamikaze(self: EdictT): void {
  self.monsterinfo.currentmove = flyer_move_kamikaze;
}

function flyer_kamikaze_check(self: EdictT): void {
  // PMM - this needed because we could have gone away before we get here (blocked code)
  if (!self.inuse) return;

  if (self.enemy === null || !self.enemy.inuse) {
    flyer_kamikaze_explode(self);
    return;
  }

  self.goalentity = self.enemy;

  const dist = realrange(self, self.enemy);

  if (dist < 90) flyer_kamikaze_explode(self);
}

// rogue - kamikaze
// ROGUE

const flyer_frames_start: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, flyer_nextmove),
];
const flyer_move_start = mmove(FRAME_start01, FRAME_start06, flyer_frames_start, null);

const flyer_frames_stop: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0, flyer_nextmove),
];
const flyer_move_stop = mmove(FRAME_stop01, FRAME_stop07, flyer_frames_stop, null);

function flyer_stop(self: EdictT): void {
  self.monsterinfo.currentmove = flyer_move_stop;
}

function flyer_start(self: EdictT): void {
  self.monsterinfo.currentmove = flyer_move_start;
}

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const flyer_frames_rollright: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const flyer_move_rollright = mmove(FRAME_rollr01, FRAME_rollr09, flyer_frames_rollright, null);

const flyer_frames_rollleft: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const flyer_move_rollleft = mmove(FRAME_rollf01, FRAME_rollf09, flyer_frames_rollleft, null);

const flyer_frames_pain3: MframeT[] = Array.from({ length: 4 }, () => mframe(ai_move, 0));
const flyer_move_pain3 = mmove(FRAME_pain301, FRAME_pain304, flyer_frames_pain3, flyer_run);

const flyer_frames_pain2: MframeT[] = Array.from({ length: 4 }, () => mframe(ai_move, 0));
const flyer_move_pain2 = mmove(FRAME_pain201, FRAME_pain204, flyer_frames_pain2, flyer_run);

const flyer_frames_pain1: MframeT[] = Array.from({ length: 9 }, () => mframe(ai_move, 0));
const flyer_move_pain1 = mmove(FRAME_pain101, FRAME_pain109, flyer_frames_pain1, flyer_run);

// Defined but never wired to a monsterinfo hook in the original C either --
// dead code kept for fidelity.
const flyer_frames_defense: MframeT[] = [
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0), // Hold this frame
  mframe(ai_move, 0),
  mframe(ai_move, 0),
  mframe(ai_move, 0),
];
const flyer_move_defense = mmove(FRAME_defens01, FRAME_defens06, flyer_frames_defense, null);

const flyer_frames_bankright: MframeT[] = Array.from({ length: 7 }, () => mframe(ai_move, 0));
const flyer_move_bankright = mmove(FRAME_bankr01, FRAME_bankr07, flyer_frames_bankright, null);

const flyer_frames_bankleft: MframeT[] = Array.from({ length: 7 }, () => mframe(ai_move, 0));
const flyer_move_bankleft = mmove(FRAME_bankl01, FRAME_bankl07, flyer_frames_bankleft, null);

function flyer_fire(self: EdictT, flash_number: number): void {
  const start = vec3();
  const forward = vec3();
  const right = vec3();
  const end = vec3();
  const dir = vec3();
  let effect: number;

  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  if (self.s.frame === FRAME_attak204 || self.s.frame === FRAME_attak207 || self.s.frame === FRAME_attak210) effect = EF_HYPERBLASTER;
  else effect = 0;
  AngleVectors(self.s.angles, forward, right, null);
  G_ProjectSource(self.s.origin, monsterFlashOffset()[flash_number], forward, right, start);

  VectorCopy(self.enemy.s.origin, end);
  end[2] += self.enemy.viewheight;
  VectorSubtract(end, start, dir);

  monster_fire_blaster(self, start, dir, 1, 1000, flash_number, effect);
}

function flyer_fireleft(self: EdictT): void {
  flyer_fire(self, MZ2_FLYER_BLASTER_1);
}

function flyer_fireright(self: EdictT): void {
  flyer_fire(self, MZ2_FLYER_BLASTER_2);
}

const flyer_frames_attack2: MframeT[] = [
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, -10, flyer_fireleft), // left gun
  mframe(ai_charge, -10, flyer_fireright), // right gun
  mframe(ai_charge, -10, flyer_fireleft), // left gun
  mframe(ai_charge, -10, flyer_fireright), // right gun
  mframe(ai_charge, -10, flyer_fireleft), // left gun
  mframe(ai_charge, -10, flyer_fireright), // right gun
  mframe(ai_charge, -10, flyer_fireleft), // left gun
  mframe(ai_charge, -10, flyer_fireright), // right gun
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
];
const flyer_move_attack2 = mmove(FRAME_attak201, FRAME_attak217, flyer_frames_attack2, flyer_run);

// ROGUE -- PMM: circle strafe frames
const flyer_frames_attack3: MframeT[] = [
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10, flyer_fireleft), // left gun
  mframe(ai_charge, 10, flyer_fireright), // right gun
  mframe(ai_charge, 10, flyer_fireleft), // left gun
  mframe(ai_charge, 10, flyer_fireright), // right gun
  mframe(ai_charge, 10, flyer_fireleft), // left gun
  mframe(ai_charge, 10, flyer_fireright), // right gun
  mframe(ai_charge, 10, flyer_fireleft), // left gun
  mframe(ai_charge, 10, flyer_fireright), // right gun
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
  mframe(ai_charge, 10),
];
export const flyer_move_attack3 = mmove(FRAME_attak201, FRAME_attak217, flyer_frames_attack3, flyer_run);
// ROGUE

function flyer_slash_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 0);
  fire_hit(self, aim, 5, 0);
  gi.sound(self, CHAN_WEAPON, sound_slash, 1, ATTN_NORM, 0);
}

function flyer_slash_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 0);
  fire_hit(self, aim, 5, 0);
  gi.sound(self, CHAN_WEAPON, sound_slash, 1, ATTN_NORM, 0);
}

const flyer_frames_start_melee: MframeT[] = [
  mframe(ai_charge, 0, flyer_pop_blades),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
];
const flyer_move_start_melee = mmove(FRAME_attak101, FRAME_attak106, flyer_frames_start_melee, flyer_loop_melee);

const flyer_frames_end_melee: MframeT[] = Array.from({ length: 3 }, () => mframe(ai_charge, 0));
const flyer_move_end_melee = mmove(FRAME_attak119, FRAME_attak121, flyer_frames_end_melee, flyer_run);

const flyer_frames_loop_melee: MframeT[] = [
  mframe(ai_charge, 0), // Loop Start
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, flyer_slash_left), // Left Wing Strike
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0, flyer_slash_right), // Right Wing Strike
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0),
  mframe(ai_charge, 0), // Loop Ends
];
const flyer_move_loop_melee = mmove(FRAME_attak107, FRAME_attak118, flyer_frames_loop_melee, flyer_check_melee);

function flyer_loop_melee(self: EdictT): void {
  /*	if (random() <= 0.5)
			self.monsterinfo.currentmove = flyer_move_attack1;
		else */
  self.monsterinfo.currentmove = flyer_move_loop_melee;
}

// ROGUE -- circle-strafe attack choice replaces the base's unconditional attack2
function flyer_attack(self: EdictT): void {
  let chance: number;
  // 0% chance of circle in easy
  // 50% chance in normal
  // 75% chance in hard
  // 86.67% chance in nightmare

  if (self.mass > 50) {
    flyer_run(self);
    return;
  }

  const skill = cvarNum(gameCvars.skill);
  if (skill === 0) chance = 0;
  else chance = 1.0 - 0.5 / skill;

  if (random() > chance) {
    self.monsterinfo.attack_state = AS_STRAIGHT;
    self.monsterinfo.currentmove = flyer_move_attack2;
  } else {
    // circle strafe
    if (random() <= 0.5) self.monsterinfo.lefty = 1 - self.monsterinfo.lefty; // switch directions
    self.monsterinfo.attack_state = AS_SLIDING;
    self.monsterinfo.currentmove = flyer_move_attack3;
  }
}
// ROGUE

// Defined but never called anywhere in the original C either (not even from
// SP_monster_flyer) -- dead code kept for fidelity.
function flyer_setstart(self: EdictT): void {
  nextmove = ACTION_run;
  self.monsterinfo.currentmove = flyer_move_start;
}

function flyer_nextmove(self: EdictT): void {
  if (nextmove === ACTION_attack1) self.monsterinfo.currentmove = flyer_move_start_melee;
  else if (nextmove === ACTION_attack2) self.monsterinfo.currentmove = flyer_move_attack2;
  else if (nextmove === ACTION_run) self.monsterinfo.currentmove = flyer_move_run;
}

function flyer_melee(self: EdictT): void {
  // ROGUE
  if (self.mass > 50) flyer_run(self);
  else self.monsterinfo.currentmove = flyer_move_start_melee;
}

function flyer_check_melee(self: EdictT): void {
  if (self.enemy !== null && range(self, self.enemy) === RANGE_MELEE) {
    if (random() <= 0.8) self.monsterinfo.currentmove = flyer_move_loop_melee;
    else self.monsterinfo.currentmove = flyer_move_end_melee;
  } else self.monsterinfo.currentmove = flyer_move_end_melee;
}

function flyer_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number): void {
  // ROGUE -- pmm - kamikaze's don't feel pain
  if (self.mass !== 50) return;
  // ROGUE

  if (self.health < self.max_health / 2) self.s.skinnum = 1;

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = level.time + 3;
  if (cvarNum(gameCvars.skill) === 3) return; // no pain anims in nightmare

  // C: `n = rand() % 3;` -- house `Math.floor(Math.random() * N)` idiom for
  // raw rand() (see PORTING.md).
  const n = Math.floor(Math.random() * 3);
  if (n === 0) {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = flyer_move_pain1;
  } else if (n === 1) {
    gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = flyer_move_pain2;
  } else {
    gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
    self.monsterinfo.currentmove = flyer_move_pain3;
  }
}

// rogue/m_flyer.c calls this directly with NULL inflictor/attacker from
// flyer_kamikaze_explode, so (unlike the `die` field's own signature) the
// two middle parameters accept null; a function accepting a wider parameter
// type than `EdictT.die` requires is still assignable to that field.
function flyer_die(self: EdictT, _inflictor: EdictT | null, _attacker: EdictT | null, _damage: number, _point: Vec3): void {
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  BecomeExplosion1(self);
}

// ROGUE -- PMM: kamikaze code .. blow up if blocked
function flyer_blocked(self: EdictT, _dist: number): boolean {
  const origin = vec3();

  // kamikaze = 100, normal = 50
  if (self.mass === 100) {
    flyer_kamikaze_check(self);

    // if the above didn't blow us up (i.e. I got blocked by the player)
    if (self.inuse) {
      if (
        self.monsterinfo.commander !== null &&
        self.monsterinfo.commander.inuse &&
        self.monsterinfo.commander.classname === "monster_carrier"
      ) {
        self.monsterinfo.commander.monsterinfo.monster_slots++;
      }

      VectorMA(self.s.origin, -0.02, self.velocity, origin);
      gi.WriteByte(svc_temp_entity);
      gi.WriteByte(TempEventT.TE_ROCKET_EXPLOSION);
      gi.WritePosition(origin);
      gi.multicast(self.s.origin, MulticastT.MULTICAST_PHS);

      G_FreeEdict(self);
    }
    return true;
  }
  // we're a normal flyer
  if (blocked_checkshot(self, 0.25 + 0.05 * cvarNum(gameCvars.skill))) return true;

  return false;
}
// ROGUE

/*QUAKED monster_flyer (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
*/
export function SP_monster_flyer(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  // fix a map bug in jail5.bsp
  if (Q_stricmp(level.mapname, "jail5") === 0 && self.s.origin[2] === -104) {
    self.targetname = self.target;
    self.target = null;
  }

  sound_sight = gi.soundindex("flyer/flysght1.wav");
  sound_idle = gi.soundindex("flyer/flysrch1.wav");
  sound_pain1 = gi.soundindex("flyer/flypain1.wav");
  sound_pain2 = gi.soundindex("flyer/flypain2.wav");
  sound_slash = gi.soundindex("flyer/flyatck2.wav");
  sound_sproing = gi.soundindex("flyer/flyatck1.wav");
  sound_die = gi.soundindex("flyer/flydeth1.wav");

  gi.soundindex("flyer/flyatck3.wav");

  self.s.modelindex = gi.modelindex("models/monsters/flyer/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  // ROGUE: shortened to 16 from 32 -- "PMM - shortened to 16 from 32"
  VectorSet(self.maxs, 16, 16, 16);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.s.sound = gi.soundindex("flyer/flyidle1.wav");

  self.health = 50;
  self.mass = 50;

  self.pain = flyer_pain;
  self.die = flyer_die;

  self.monsterinfo.stand = flyer_stand;
  self.monsterinfo.walk = flyer_walk;
  self.monsterinfo.run = flyer_run;
  self.monsterinfo.attack = flyer_attack;
  self.monsterinfo.melee = flyer_melee;
  self.monsterinfo.sight = flyer_sight;
  self.monsterinfo.idle = flyer_idle;
  self.monsterinfo.blocked = flyer_blocked; // ROGUE

  gi.linkentity(self);

  self.monsterinfo.currentmove = flyer_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  flymonster_start(self);
}

// ROGUE -- PMM: suicide fliers
/*QUAKED monster_kamikaze (1 .5 0) (-16 -16 -24) (16 16 16) Ambush Trigger_Spawn Sight
*/
export function SP_monster_kamikaze(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  sound_sight = gi.soundindex("flyer/flysght1.wav");
  sound_idle = gi.soundindex("flyer/flysrch1.wav");
  sound_pain1 = gi.soundindex("flyer/flypain1.wav");
  sound_pain2 = gi.soundindex("flyer/flypain2.wav");
  sound_slash = gi.soundindex("flyer/flyatck2.wav");
  sound_sproing = gi.soundindex("flyer/flyatck1.wav");
  sound_die = gi.soundindex("flyer/flydeth1.wav");

  gi.soundindex("flyer/flyatck3.wav");

  self.s.modelindex = gi.modelindex("models/monsters/flyer/tris.md2");
  VectorSet(self.mins, -16, -16, -24);
  // used to be 32 tall .. was WAY too big
  VectorSet(self.maxs, 16, 16, 16);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.s.sound = gi.soundindex("flyer/flyidle1.wav");

  self.s.effects |= EF_ROCKET;

  self.health = 50;
  // PMM - normal flyer has mass of 50
  self.mass = 100;

  self.pain = flyer_pain;
  self.die = flyer_die;

  self.monsterinfo.stand = flyer_stand;
  self.monsterinfo.walk = flyer_walk;
  self.monsterinfo.run = flyer_run;
  self.monsterinfo.attack = flyer_attack;
  self.monsterinfo.melee = flyer_melee;
  self.monsterinfo.sight = flyer_sight;
  self.monsterinfo.idle = flyer_idle;

  self.monsterinfo.blocked = flyer_blocked;

  gi.linkentity(self);

  self.monsterinfo.currentmove = flyer_move_stand;
  self.monsterinfo.scale = MODEL_SCALE;

  flymonster_start(self);
}
// ROGUE

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_flyer:flyer_pain", flyer_pain);
registerSaveFunction("m_flyer:flyer_die", flyer_die);
registerSaveFunction("m_flyer:flyer_stand", flyer_stand);
registerSaveFunction("m_flyer:flyer_walk", flyer_walk);
registerSaveFunction("m_flyer:flyer_run", flyer_run);
registerSaveFunction("m_flyer:flyer_attack", flyer_attack);
registerSaveFunction("m_flyer:flyer_melee", flyer_melee);
registerSaveFunction("m_flyer:flyer_sight", flyer_sight);
registerSaveFunction("m_flyer:flyer_idle", flyer_idle);
registerSaveFunction("m_flyer:flyer_blocked", flyer_blocked);
registerSaveFunction("m_flyer:flyer_kamikaze", flyer_kamikaze);
registerSaveFunction("m_flyer:flyer_kamikaze_check", flyer_kamikaze_check);
registerSaveMmove("m_flyer:flyer_move_stand", flyer_move_stand);
registerSaveMmove("m_flyer:flyer_move_walk", flyer_move_walk);
registerSaveMmove("m_flyer:flyer_move_run", flyer_move_run);
registerSaveMmove("m_flyer:flyer_move_kamikaze", flyer_move_kamikaze);
registerSaveMmove("m_flyer:flyer_move_start", flyer_move_start);
registerSaveMmove("m_flyer:flyer_move_stop", flyer_move_stop);
registerSaveMmove("m_flyer:flyer_move_rollright", flyer_move_rollright);
registerSaveMmove("m_flyer:flyer_move_rollleft", flyer_move_rollleft);
registerSaveMmove("m_flyer:flyer_move_pain3", flyer_move_pain3);
registerSaveMmove("m_flyer:flyer_move_pain2", flyer_move_pain2);
registerSaveMmove("m_flyer:flyer_move_pain1", flyer_move_pain1);
registerSaveMmove("m_flyer:flyer_move_defense", flyer_move_defense);
registerSaveMmove("m_flyer:flyer_move_bankright", flyer_move_bankright);
registerSaveMmove("m_flyer:flyer_move_bankleft", flyer_move_bankleft);
registerSaveMmove("m_flyer:flyer_move_attack2", flyer_move_attack2);
registerSaveMmove("m_flyer:flyer_move_attack3", flyer_move_attack3);
registerSaveMmove("m_flyer:flyer_move_start_melee", flyer_move_start_melee);
registerSaveMmove("m_flyer:flyer_move_end_melee", flyer_move_end_melee);
registerSaveMmove("m_flyer:flyer_move_loop_melee", flyer_move_loop_melee);
