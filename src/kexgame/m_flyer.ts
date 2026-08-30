// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_flyer.c -- the FLYER monster (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_flyer.cpp (784
// lines) + m_flyer.h (161 lines, frame-index enum + MODEL_SCALE), C++17.
// Behavioral code, ported bug-for-bug per this port line's house
// conventions (see g_monster.ts/m_soldier.ts/m_flipper.ts headers). Two
// spawn variants share this file's frame set and logic:
// `SP_monster_flyer` (the flying blade/blaster monster) and
// `SP_monster_kamikaze` (ROGUE's suicide flier -- literally
// `SP_monster_flyer` with `EF_ROCKET` pre-set on `self.s.effects`, per
// m_flyer.cpp:773-784).
//
// ============================================================================
// NO DODGE/DUCK WIRING -- verified from source, not assumed
// ============================================================================
// Unlike m_soldier/m_gunner/m_infantry/m_chick/m_berserk, `SP_monster_flyer`
// never assigns `self->monsterinfo.dodge` (grepped the whole of m_flyer.cpp
// -- no `.dodge =` anywhere). Flyer is a pure flying monster with no duck
// animation in its frame set (no FRAME_duck* in m_flyer.h), so it never
// participates in the rogue-newai dodge/duck system at all. Nothing is
// imported from m_soldier.ts for this reason.
//
// ============================================================================
// `realrange` -- ROGUE cross-dependency, ported for REAL (not a stub)
// ============================================================================
// `flyer_kamikaze_check` (m_flyer.cpp:253-275) calls `realrange(self,
// self->enemy)` every `ai_charge` frame of the kamikaze move to decide when
// to detonate (`dist < 90`). `realrange` is declared in g_local.h:2557 but
// its only definition anywhere in the rerelease tree is ROGUE's
// rogue/g_rogue_newai.cpp:914-921 (a future src/kexgame/g_rogue_newai.ts
// this port line hasn't landed yet) -- a one-line body:
// `return (self->s.origin - other->s.origin).length();`. Unlike a genuinely
// narrow ROGUE-only gap, this one is unconditionally reached on EVERY frame
// of the kamikaze attack for the `SP_monster_kamikaze` spawn variant (and
// for any `monster_flyer` with `EF_ROCKET` set, e.g. by a mapper) -- a
// throwing stub here would make that entire spawn variant crash on its
// first `ai_charge` frame, the same "unconditionally reachable narrow-file
// cross-dep" situation m_soldier.ts's own header precedent (the rogue-newai
// dodge system) and this file's own task brief call out explicitly. Ported
// for real, locally, unexported, verbatim from its one-line C++ body.
//
// ============================================================================
// monster_footstep / M_CheckGib -- NOT needed here
// ============================================================================
// Neither trivial g_local.h inline is used by this file: no frame in
// m_flyer.h's set is a footstep frame, and `flyer_die` (m_flyer.cpp:631-652)
// has no `M_CheckGib` gib/no-gib branch at all -- it unconditionally plays
// the death sound, a TE_EXPLOSION1 temp entity, halves `s.skinnum`, throws
// six gibs, and clears `self->touch`. Ported exactly that way, no gib-check
// helper duplicated.

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import { SolidT, EffectsT, MonsterMuzzleflashIdT, KexTempEventT, KexMulticastT, ServerCommandT, SplashColorT, type KexTraceT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MovetypeT,
  ModIdT,
  DamageflagsT,
  EntFlagsT,
  GibTypeT,
  MELEE_DISTANCE,
  RANGE_MELEE,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { frandom, irandom, brandom } from "./q_std";
import { AngleVectors, vectoangles, vec3_add, vec3_sub, vec3_muls, vec3_normalize, vec3_normalized, vec3_length, vec3_origin } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move, range_to, visible } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, M_ProjectFlashSource, monster_fire_blaster, flymonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { T_Damage } from "./g_combat";
import { monsterFlashOffset } from "./m_flash";
import {
  RegisterDie,
  RegisterPain,
  RegisterTouch,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_flyer.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_start01 = 0;
export const FRAME_start02 = 1;
export const FRAME_start03 = 2;
export const FRAME_start04 = 3;
export const FRAME_start05 = 4;
export const FRAME_start06 = 5;
export const FRAME_stop01 = 6;
export const FRAME_stop02 = 7;
export const FRAME_stop03 = 8;
export const FRAME_stop04 = 9;
export const FRAME_stop05 = 10;
export const FRAME_stop06 = 11;
export const FRAME_stop07 = 12;
export const FRAME_stand01 = 13;
export const FRAME_stand02 = 14;
export const FRAME_stand03 = 15;
export const FRAME_stand04 = 16;
export const FRAME_stand05 = 17;
export const FRAME_stand06 = 18;
export const FRAME_stand07 = 19;
export const FRAME_stand08 = 20;
export const FRAME_stand09 = 21;
export const FRAME_stand10 = 22;
export const FRAME_stand11 = 23;
export const FRAME_stand12 = 24;
export const FRAME_stand13 = 25;
export const FRAME_stand14 = 26;
export const FRAME_stand15 = 27;
export const FRAME_stand16 = 28;
export const FRAME_stand17 = 29;
export const FRAME_stand18 = 30;
export const FRAME_stand19 = 31;
export const FRAME_stand20 = 32;
export const FRAME_stand21 = 33;
export const FRAME_stand22 = 34;
export const FRAME_stand23 = 35;
export const FRAME_stand24 = 36;
export const FRAME_stand25 = 37;
export const FRAME_stand26 = 38;
export const FRAME_stand27 = 39;
export const FRAME_stand28 = 40;
export const FRAME_stand29 = 41;
export const FRAME_stand30 = 42;
export const FRAME_stand31 = 43;
export const FRAME_stand32 = 44;
export const FRAME_stand33 = 45;
export const FRAME_stand34 = 46;
export const FRAME_stand35 = 47;
export const FRAME_stand36 = 48;
export const FRAME_stand37 = 49;
export const FRAME_stand38 = 50;
export const FRAME_stand39 = 51;
export const FRAME_stand40 = 52;
export const FRAME_stand41 = 53;
export const FRAME_stand42 = 54;
export const FRAME_stand43 = 55;
export const FRAME_stand44 = 56;
export const FRAME_stand45 = 57;
export const FRAME_attak101 = 58;
export const FRAME_attak102 = 59;
export const FRAME_attak103 = 60;
export const FRAME_attak104 = 61;
export const FRAME_attak105 = 62;
export const FRAME_attak106 = 63;
export const FRAME_attak107 = 64;
export const FRAME_attak108 = 65;
export const FRAME_attak109 = 66;
export const FRAME_attak110 = 67;
export const FRAME_attak111 = 68;
export const FRAME_attak112 = 69;
export const FRAME_attak113 = 70;
export const FRAME_attak114 = 71;
export const FRAME_attak115 = 72;
export const FRAME_attak116 = 73;
export const FRAME_attak117 = 74;
export const FRAME_attak118 = 75;
export const FRAME_attak119 = 76;
export const FRAME_attak120 = 77;
export const FRAME_attak121 = 78;
export const FRAME_attak201 = 79;
export const FRAME_attak202 = 80;
export const FRAME_attak203 = 81;
export const FRAME_attak204 = 82;
export const FRAME_attak205 = 83;
export const FRAME_attak206 = 84;
export const FRAME_attak207 = 85;
export const FRAME_attak208 = 86;
export const FRAME_attak209 = 87;
export const FRAME_attak210 = 88;
export const FRAME_attak211 = 89;
export const FRAME_attak212 = 90;
export const FRAME_attak213 = 91;
export const FRAME_attak214 = 92;
export const FRAME_attak215 = 93;
export const FRAME_attak216 = 94;
export const FRAME_attak217 = 95;
export const FRAME_bankl01 = 96;
export const FRAME_bankl02 = 97;
export const FRAME_bankl03 = 98;
export const FRAME_bankl04 = 99;
export const FRAME_bankl05 = 100;
export const FRAME_bankl06 = 101;
export const FRAME_bankl07 = 102;
export const FRAME_bankr01 = 103;
export const FRAME_bankr02 = 104;
export const FRAME_bankr03 = 105;
export const FRAME_bankr04 = 106;
export const FRAME_bankr05 = 107;
export const FRAME_bankr06 = 108;
export const FRAME_bankr07 = 109;
export const FRAME_rollf01 = 110;
export const FRAME_rollf02 = 111;
export const FRAME_rollf03 = 112;
export const FRAME_rollf04 = 113;
export const FRAME_rollf05 = 114;
export const FRAME_rollf06 = 115;
export const FRAME_rollf07 = 116;
export const FRAME_rollf08 = 117;
export const FRAME_rollf09 = 118;
export const FRAME_rollr01 = 119;
export const FRAME_rollr02 = 120;
export const FRAME_rollr03 = 121;
export const FRAME_rollr04 = 122;
export const FRAME_rollr05 = 123;
export const FRAME_rollr06 = 124;
export const FRAME_rollr07 = 125;
export const FRAME_rollr08 = 126;
export const FRAME_rollr09 = 127;
export const FRAME_defens01 = 128;
export const FRAME_defens02 = 129;
export const FRAME_defens03 = 130;
export const FRAME_defens04 = 131;
export const FRAME_defens05 = 132;
export const FRAME_defens06 = 133;
export const FRAME_pain101 = 134;
export const FRAME_pain102 = 135;
export const FRAME_pain103 = 136;
export const FRAME_pain104 = 137;
export const FRAME_pain105 = 138;
export const FRAME_pain106 = 139;
export const FRAME_pain107 = 140;
export const FRAME_pain108 = 141;
export const FRAME_pain109 = 142;
export const FRAME_pain201 = 143;
export const FRAME_pain202 = 144;
export const FRAME_pain203 = 145;
export const FRAME_pain204 = 146;
export const FRAME_pain301 = 147;
export const FRAME_pain302 = 148;
export const FRAME_pain303 = 149;
export const FRAME_pain304 = 150;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// realrange -- see file header. rogue/g_rogue_newai.cpp:914-921.
// ---------------------------------------------------------------------------

function realrange(self: EdictT, other: EdictT): number {
  const dir = vec3_sub(self.s.origin, other.s.origin);
  return vec3_length(dir);
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts's identical precedent)
// ---------------------------------------------------------------------------

function frame(aifunc: MframeAifuncFn | null, dist = 0, thinkfunc: MframeThinkfuncFn | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}

function move(firstframe: number, lastframe: number, frames: MframeT[], endfunc: MmoveEndfuncFn | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frames;
  m.endfunc = endfunc;
  return m;
}

function mod(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

let sound_sight = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_slash = 0;
let sound_sproing = 0;
let sound_die = 0;

// ---------------------------------------------------------------------------
// sight / idle / pop_blades (m_flyer.cpp:32-45)
// ---------------------------------------------------------------------------

const flyer_sight = RegisterMonsterinfoSight("flyer_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const flyer_idle = RegisterMonsterinfoIdle("flyer_idle", (self: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
});

function flyer_pop_blades(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sproing, 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// stand / walk / run (m_flyer.cpp:47-227)
// ---------------------------------------------------------------------------

const flyer_frames_stand: MframeT[] = Array.from({ length: 45 }, () => frame(ai_stand));
const flyer_move_stand = RegisterMmove("flyer_move_stand", move(FRAME_stand01, FRAME_stand45, flyer_frames_stand));

const flyer_frames_walk: MframeT[] = Array.from({ length: 45 }, () => frame(ai_walk, 5));
const flyer_move_walk = RegisterMmove("flyer_move_walk", move(FRAME_stand01, FRAME_stand45, flyer_frames_walk));

const flyer_frames_run: MframeT[] = Array.from({ length: 45 }, () => frame(ai_run, 10));
const flyer_move_run = RegisterMmove("flyer_move_run", move(FRAME_stand01, FRAME_stand45, flyer_frames_run));

// forward-referenced: used as a VALUE by flyer_move_kamikaze's frame array
// (below) before its own textual definition -- a hoisted `function`
// declaration, matching the C++ source's own forward prototype
// (m_flyer.cpp:29, `void flyer_kamikaze_check(edict_t *self);`).
function flyer_kamikaze_check(self: EdictT): void {
  // PMM - this needed because we could have gone away before we get here (blocked code)
  if (!self.inuse) return;

  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) {
    flyer_kamikaze_explode(self);
    return;
  }

  self.s.angles = vec3(vectoangles(vec3_sub(enemy.s.origin, self.s.origin))[0], self.s.angles[1], self.s.angles[2]);

  self.goalentity = enemy;

  const dist = realrange(self, enemy);

  if (dist < 90) flyer_kamikaze_explode(self);
}

const flyer_frames_kamizake: MframeT[] = [
  frame(ai_charge, 40, flyer_kamikaze_check),
  frame(ai_charge, 40, flyer_kamikaze_check),
  frame(ai_charge, 40, flyer_kamikaze_check),
  frame(ai_charge, 40, flyer_kamikaze_check),
  frame(ai_charge, 40, flyer_kamikaze_check),
];
// endfunc `flyer_kamikaze` is also forward-referenced (defined below,
// m_flyer.cpp:248-251) -- hoisted `function`.
const flyer_move_kamikaze = RegisterMmove("flyer_move_kamikaze", move(FRAME_rollr02, FRAME_rollr06, flyer_frames_kamizake, flyer_kamikaze));

const flyer_run = RegisterMonsterinfoRun("flyer_run", (self: EdictT): void => {
  if (self.mass > 50) M_SetAnimation(self, flyer_move_kamikaze, true);
  else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, flyer_move_stand, true);
  else M_SetAnimation(self, flyer_move_run, true);
});

const flyer_walk = RegisterMonsterinfoWalk("flyer_walk", (self: EdictT): void => {
  if (self.mass > 50) flyer_run(self);
  else M_SetAnimation(self, flyer_move_walk, true);
});

const flyer_stand = RegisterMonsterinfoStand("flyer_stand", (self: EdictT): void => {
  if (self.mass > 50) flyer_run(self);
  else M_SetAnimation(self, flyer_move_stand, true);
});

// ---------------------------------------------------------------------------
// ROGUE - kamikaze stuff (m_flyer.cpp:229-275)
// ---------------------------------------------------------------------------

function flyer_kamikaze_explode(self: EdictT): void {
  let dir: Vec3 = vec3_origin;

  const commander = self.monsterinfo.commander;
  if (commander !== null && commander.inuse && commander.classname === "monster_carrier") {
    commander.monsterinfo.monster_slots++;
  }

  const enemy = self.enemy;
  if (enemy !== null) {
    dir = vec3_sub(enemy.s.origin, self.s.origin);
    T_Damage(enemy, self, self, dir, self.s.origin, vec3_origin, 50, 50, DamageflagsT.DAMAGE_RADIUS, mod(ModIdT.MOD_UNKNOWN));
  }

  // C++ passes nullptr for inflictor/attacker here (m_flyer.cpp:245); DieFn's
  // shared TS signature (g_local_types.ts) is non-nullable across every
  // die() handler in this port line, and flyer_die's body below never reads
  // either parameter (matching its C++ body, which also ignores both) --
  // `self` is an inert placeholder, zero behavioral difference.
  flyer_die(self, self, self, 0, dir, mod(ModIdT.MOD_EXPLOSIVE));
}

// hoisted (used as a VALUE above by flyer_move_kamikaze before this point).
function flyer_kamikaze(self: EdictT): void {
  M_SetAnimation(self, flyer_move_kamikaze, true);
}

// ---------------------------------------------------------------------------
// pain3 / pain2 / pain1 (m_flyer.cpp:305-332; #if 0 blocks skipped, see below)
// ---------------------------------------------------------------------------
// m_flyer.cpp:277-303 (flyer_frames_rollright/rollleft) and :334-366
// (flyer_frames_defense/bankright/bankleft) are `#if 0`-disabled dead C++
// source -- never compiled, never registered as an mmove, unreachable by
// construction. Not ported (nothing to port: dead code in the source
// itself), matching PORTING.md's "don't port disabled C++" precedent.

const flyer_frames_pain3: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const flyer_move_pain3 = RegisterMmove("flyer_move_pain3", move(FRAME_pain301, FRAME_pain304, flyer_frames_pain3, flyer_run));

const flyer_frames_pain2: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const flyer_move_pain2 = RegisterMmove("flyer_move_pain2", move(FRAME_pain201, FRAME_pain204, flyer_frames_pain2, flyer_run));

const flyer_frames_pain1: MframeT[] = Array.from({ length: 9 }, () => frame(ai_move));
const flyer_move_pain1 = RegisterMmove("flyer_move_pain1", move(FRAME_pain101, FRAME_pain109, flyer_frames_pain1, flyer_run));

// ---------------------------------------------------------------------------
// ranged attack (m_flyer.cpp:368-442)
// ---------------------------------------------------------------------------

function flyer_fire(self: EdictT, flash_number: MonsterMuzzleflashIdT): void {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return; // PGM

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  const end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
  const dir = vec3_sub(end, start);
  vec3_normalize(dir); // vec3_t::normalize() mutates in place, m_flyer.cpp:384

  monster_fire_blaster(self, start, dir, 1, 1000, flash_number, self.s.frame % 4 !== 0 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER);
}

function flyer_fireleft(self: EdictT): void {
  flyer_fire(self, MonsterMuzzleflashIdT.MZ2_FLYER_BLASTER_1);
}

function flyer_fireright(self: EdictT): void {
  flyer_fire(self, MonsterMuzzleflashIdT.MZ2_FLYER_BLASTER_2);
}

const flyer_frames_attack2: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, -10, flyer_fireleft), // left gun
  frame(ai_charge, -10, flyer_fireright), // right gun
  frame(ai_charge, -10, flyer_fireleft), // left gun
  frame(ai_charge, -10, flyer_fireright), // right gun
  frame(ai_charge, -10, flyer_fireleft), // left gun
  frame(ai_charge, -10, flyer_fireright), // right gun
  frame(ai_charge, -10, flyer_fireleft), // left gun
  frame(ai_charge, -10, flyer_fireright), // right gun
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const flyer_move_attack2 = RegisterMmove("flyer_move_attack2", move(FRAME_attak201, FRAME_attak217, flyer_frames_attack2, flyer_run));

// PMM - circle strafe frames (m_flyer.cpp:420-442)
const flyer_frames_attack3: MframeT[] = [
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10, flyer_fireleft), // left gun
  frame(ai_charge, 10, flyer_fireright), // right gun
  frame(ai_charge, 10, flyer_fireleft), // left gun
  frame(ai_charge, 10, flyer_fireright), // right gun
  frame(ai_charge, 10, flyer_fireleft), // left gun
  frame(ai_charge, 10, flyer_fireright), // right gun
  frame(ai_charge, 10, flyer_fireleft), // left gun
  frame(ai_charge, 10, flyer_fireright), // right gun
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
];
// NOTE: `flyer_move_attack3` is built (m_flyer.cpp:442) but never assigned
// anywhere in this file -- verified by grepping the whole of m_flyer.cpp for
// `flyer_move_attack3`, only the MMOVE_T definition itself matches. Genuine
// dead code in the C++ source (the circle-strafe variant is built but never
// wired to `flyer_attack`, which always picks between melee and
// `flyer_move_attack2`). Ported anyway for source fidelity (it's live,
// compiled code, just unreferenced), matching this file's own treatment of
// every other real MMOVE_T table.
export const flyer_move_attack3 = RegisterMmove("flyer_move_attack3", move(FRAME_attak201, FRAME_attak217, flyer_frames_attack3, flyer_run));

// ---------------------------------------------------------------------------
// melee attack (m_flyer.cpp:445-586)
// ---------------------------------------------------------------------------

function flyer_slash_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 0);
  if (!fire_hit(self, aim, 5, 0)) self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(1.5));
  gi.sound(self, CHAN_WEAPON, sound_slash, 1, ATTN_NORM, 0);
}

function flyer_slash_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 0);
  if (!fire_hit(self, aim, 5, 0)) self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(1.5));
  gi.sound(self, CHAN_WEAPON, sound_slash, 1, ATTN_NORM, 0);
}

// forward-referenced by flyer_move_start_melee's endfunc below -- hoisted.
function flyer_loop_melee(self: EdictT): void {
  M_SetAnimation(self, flyer_move_loop_melee, true);
}

const flyer_frames_start_melee: MframeT[] = [
  frame(ai_charge, 0, flyer_pop_blades),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const flyer_move_start_melee = RegisterMmove("flyer_move_start_melee", move(FRAME_attak101, FRAME_attak106, flyer_frames_start_melee, flyer_loop_melee));

const flyer_frames_end_melee: MframeT[] = [frame(ai_charge), frame(ai_charge), frame(ai_charge)];
const flyer_move_end_melee = RegisterMmove("flyer_move_end_melee", move(FRAME_attak119, FRAME_attak121, flyer_frames_end_melee, flyer_run));

const flyer_frames_loop_melee: MframeT[] = [
  frame(ai_charge), // Loop Start
  frame(ai_charge),
  frame(ai_charge, 0, flyer_slash_left), // Left Wing Strike
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, flyer_slash_right), // Right Wing Strike
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge), // Loop Ends
];
// forward-referenced endfunc `flyer_check_melee` -- hoisted (defined below,
// m_flyer.cpp:573-586).
const flyer_move_loop_melee = RegisterMmove("flyer_move_loop_melee", move(FRAME_attak107, FRAME_attak118, flyer_frames_loop_melee, flyer_check_melee));

function flyer_set_fly_parameters(self: EdictT, melee: boolean): void {
  if (melee) {
    // engage thrusters for a slice
    self.monsterinfo.fly_pinned = false;
    self.monsterinfo.fly_thrusters = true;
    self.monsterinfo.fly_position_time = Gtime_from_sec(0);
    self.monsterinfo.fly_acceleration = 20.0;
    self.monsterinfo.fly_speed = 210.0;
    self.monsterinfo.fly_min_distance = 0.0;
    self.monsterinfo.fly_max_distance = 10.0;
  } else {
    self.monsterinfo.fly_thrusters = false;
    self.monsterinfo.fly_acceleration = 15.0;
    self.monsterinfo.fly_speed = 165.0;
    self.monsterinfo.fly_min_distance = 45.0;
    self.monsterinfo.fly_max_distance = 200.0;
  }
}

const flyer_attack = RegisterMonsterinfoAttack("flyer_attack", (self: EdictT): void => {
  if (self.mass > 50) {
    flyer_run(self);
    return;
  }

  // TS non-null guard; `enemy` is always live when MONSTERINFO_ATTACK is
  // invoked (M_CheckAttack's invariant), matching m_infantry.ts's identical
  // idiom for the same C++ precondition. C++'s own `self->enemy &&` checks
  // below become redundant once narrowed and are dropped.
  const enemy = self.enemy;
  if (enemy === null) return;

  const range = range_to(self, enemy);

  if (visible(self, enemy) && range <= 225.0 && frandom() > (range / 225.0) * 0.35) {
    // fly-by slicing!
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    M_SetAnimation(self, flyer_move_start_melee, true);
    flyer_set_fly_parameters(self, true);
  } else {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    M_SetAnimation(self, flyer_move_attack2, true);
  }

  // [Paril-KEX] for alternate fly mode, sometimes we'll pin us
  // down, kind of like a pseudo-stand ground
  if (!self.monsterinfo.fly_pinned && brandom() && visible(self, enemy)) {
    self.monsterinfo.fly_pinned = true;
    // C++: max(fly_position_time, fly_position_time + 1.7_sec) -- the max is
    // always the RHS since 1.7s > 0 (m_flyer.cpp:551), so this collapses to
    // a plain add.
    self.monsterinfo.fly_position_time = Gtime_add(self.monsterinfo.fly_position_time, Gtime_from_sec(1.7));

    if (brandom()) self.monsterinfo.fly_ideal_position = vec3_add(self.s.origin, vec3_muls(self.velocity, frandom())); // pin to our current position
    else self.monsterinfo.fly_ideal_position = vec3_add(self.monsterinfo.fly_ideal_position, enemy.s.origin); // make un-relative
  }

  // if we're currently pinned, fly_position_time will unpin us eventually
});

const flyer_melee = RegisterMonsterinfoMelee("flyer_melee", (self: EdictT): void => {
  if (self.mass > 50) flyer_run(self);
  else {
    M_SetAnimation(self, flyer_move_start_melee, true);
    flyer_set_fly_parameters(self, true);
  }
});

// hoisted: referenced as flyer_move_loop_melee's endfunc above, before this
// point.
function flyer_check_melee(self: EdictT): void {
  // TS non-null guard -- see flyer_attack's identical note.
  if (self.enemy !== null && range_to(self, self.enemy) <= RANGE_MELEE) {
    if (self.monsterinfo.melee_debounce_time <= level.time) {
      M_SetAnimation(self, flyer_move_loop_melee, true);
      return;
    }
  }

  M_SetAnimation(self, flyer_move_end_melee, true);
  flyer_set_fly_parameters(self, false);
}

// ---------------------------------------------------------------------------
// pain / setskin / die (m_flyer.cpp:588-652)
// ---------------------------------------------------------------------------

const flyer_pain = RegisterPain("flyer_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, modIn: ModT): void => {
  // pmm - kamikaze's don't feel pain
  if (self.mass !== 50) return;
  // pmm

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const n = irandom(3);
  if (n === 0) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (n === 1) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, modIn)) return; // no pain anims in nightmare

  flyer_set_fly_parameters(self, false);

  if (n === 0) M_SetAnimation(self, flyer_move_pain1, true);
  else if (n === 1) M_SetAnimation(self, flyer_move_pain2, true);
  else M_SetAnimation(self, flyer_move_pain3, true);
});

const flyer_setskin = RegisterMonsterinfoSetskin("flyer_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

// hoisted: called BY VALUE from `flyer_kamikaze_explode` above, before this
// point (function bodies calling other module consts are fine regardless of
// order, but this one is also referenced structurally alongside the other
// forward-declared kamikaze helpers, so kept as a hoisted function for
// consistency with the C++ source's own forward-prototype block,
// m_flyer.cpp:30).
function flyer_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, _modIn: ModT): void {
  gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  const gibs: GibDefT[] = [
    { gibname: "models/objects/gibs/sm_metal/tris.md2", count: 2 },
    { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 2 },
    { gibname: "models/monsters/flyer/gibs/base.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/flyer/gibs/gun.md2", count: 2, type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/flyer/gibs/wing.md2", count: 2, type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/flyer/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
  ];
  ThrowGibs(self, damage, gibs);

  self.touch = null;
}

// PMM - kamikaze code .. blow up if blocked (m_flyer.cpp:654-670)
const flyer_blocked = RegisterMonsterinfoBlocked("flyer_blocked", (self: EdictT, _dist: number): boolean => {
  // kamikaze = 100, normal = 50
  if (self.mass === 100) {
    flyer_kamikaze_check(self);

    // if the above didn't blow us up (i.e. I got blocked by the player)
    if (self.inuse) T_Damage(self, self, self, vec3_origin, self.s.origin, vec3_origin, 9999, 100, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_UNKNOWN));

    return true;
  }

  return false;
});

const kamikaze_touch = RegisterTouch("kamikaze_touch", (ent: EdictT, _other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  const veldir = vec3_normalized(ent.velocity);
  T_Damage(ent, ent, ent, veldir, ent.s.origin, veldir, 9999, 100, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_UNKNOWN));
});

const flyer_touch = RegisterTouch("flyer_touch", (ent: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (
    (other.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n &&
    (other.flags & EntFlagsT.FL_FLY) !== 0n &&
    ent.monsterinfo.duck_wait_time < level.time
  ) {
    ent.monsterinfo.duck_wait_time = Gtime_add(level.time, Gtime_from_sec(1));
    ent.monsterinfo.fly_thrusters = false;

    const dir = vec3_normalized(vec3_sub(ent.s.origin, other.s.origin));
    ent.velocity = vec3_muls(dir, 500.0);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_SPLASH);
    gi.WriteByte(32);
    gi.WritePosition(tr.endpos);
    gi.WriteDir(dir);
    gi.WriteByte(SplashColorT.SPLASH_SPARKS);
    gi.multicast(tr.endpos, KexMulticastT.MULTICAST_PVS, false);
  }
});

// ---------------------------------------------------------------------------
// spawn (m_flyer.cpp:698-785)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_flyer (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_flyer(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
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

  gi.modelindex("models/monsters/flyer/gibs/base.md2");
  gi.modelindex("models/monsters/flyer/gibs/wing.md2");
  gi.modelindex("models/monsters/flyer/gibs/gun.md2");
  gi.modelindex("models/monsters/flyer/gibs/head.md2");

  self.mins = vec3(-16, -16, -24);
  // PMM - shortened to 16 from 32
  self.maxs = vec3(16, 16, 16);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.viewheight = 12;

  self.monsterinfo.engine_sound = gi.soundindex("flyer/flyidle1.wav");

  self.health = Math.trunc(50 * st.health_multiplier);
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
  self.monsterinfo.blocked = flyer_blocked;
  self.monsterinfo.setskin = flyer_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, flyer_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  if ((self.s.effects & EffectsT.EF_ROCKET) !== 0n) {
    // PMM - normal flyer has mass of 50
    self.mass = 100;
    self.yaw_speed = 5;
    self.touch = kamikaze_touch;
  } else {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
    self.monsterinfo.fly_buzzard = true;
    flyer_set_fly_parameters(self, false);
    self.touch = flyer_touch;
  }

  flymonster_start(self);
}

// PMM - suicide fliers (m_flyer.cpp:773-784)
export function SP_monster_kamikaze(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.s.effects |= EffectsT.EF_ROCKET;

  SP_monster_flyer(self);
}
