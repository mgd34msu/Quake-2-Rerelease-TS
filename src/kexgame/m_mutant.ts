// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_mutant.cpp / m_mutant.h -- MUTANT (2023 Quake II re-release / "KEX"
// engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_mutant.cpp
// (742 lines, C++17) and m_mutant.h (167 lines, 154-entry frame enum --
// generated mechanically from the header, skipping the two bare "// ROGUE"
// comment lines the anonymous enum contains between FRAME_walk23/FRAME_jump01
// and after FRAME_jump05; those comments are not enumerators and do not
// consume a frame index). Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// M_CheckGib -- placement-mismatch helper, ported locally (see m_flipper.ts/
// m_supertank.ts precedent)
// ============================================================================
//
// ============================================================================
// blocked_checkjump -- EXTERNAL DEPENDENCY NOT YET PORTED (throwing stub,
// cited) -- matches this porting round's already-landed sibling convention
// ============================================================================
// `blocked_jump_result_t blocked_checkjump(edict_t*, float)` is declared in
// g_local.h but its only body in the whole rerelease source tree is
// rogue/g_rogue_newai.cpp:123-~230+ (a large, generic, non-monster-specific
// nav-path/AI_PATHING/drop_height/jump_height subsystem shared verbatim by
// every KEX monster). This matches, symbol-for-symbol, the identical
// citation and ruling already landed by this same porting round's sibling
// units m_berserk.ts, m_gunner.ts, and m_infantry.ts: local throwing stub,
// cited to its exact source line, NOT a silent behavior change -- a future
// dedicated g_rogue_newai.ts unit should replace it. `mutant_blocked`
// (MONSTERINFO_BLOCKED) calls it as its primary branch and only falls back
// to `blocked_checkplat` (imported for real from m_supertank.ts -- see
// below) if that returns NO_JUMP, so a spawned mutant genuinely throws the
// first time something blocks its path today -- an honest gap matching the
// sibling units' own.
// `mutant_jump_up`/`mutant_jump_down`/`mutant_jump_wait_land`/
// `mutant_move_jump_up`/`mutant_move_jump_down`/`mutant_jump_updown` (the
// ROGUE jump-up/jump-down frame tables `blocked_checkjump` would dispatch to)
// are still ported for real below, exactly like m_gunner.ts's own
// `gunner_jump`/`gunner_jump2` precedent: "only unreachable via the stubbed
// blocked_checkjump path today, not deleted -- a future g_rogue_newai.ts
// unit can wire them back up with zero changes here."
// `blocked_checkplat` itself, by contrast, IS ported for real (imported from
// m_supertank.ts, this porting round's own canonical body) -- it is
// self-contained (no nav_path dependency), matching this task's own
// m_supertank.ts/m_tank.ts/m_chick.ts/m_parasite.ts precedent, independent
// of the separate concurrent monster batch's choice to stub it too.
// `monster_jump_finished` (rogue/g_rogue_newai.cpp:101, also declared in
// g_local.h) IS ported for real here, matching m_gunner.ts's/m_infantry.ts's
// choice (not m_berserk.ts's stub) -- it's a small, self-contained function
// (adjust forward velocity, check monsterinfo.jump_time) with no nav_path
// dependency, and mutant_check_landing calls it unconditionally.
//
// ============================================================================
// KEX-only content vs. the legacy (vanilla Q2) src/game/m_mutant.ts port
// ============================================================================
// - `mutant_checkattack`'s jump gate (mutant_check_jump): entirely new in
//   KEX. Vanilla mutant has no ranged/jump attack at all -- melee only. KEX
//   adds a "close the distance" leaping attack gated by SPAWNFLAG_MUTANT_
//   NOJUMPING (8), a minimum-reach check (self.absmin.z + 125 must clear the
//   enemy's absmin.z), a horizontal-distance window (100 < distance <= 265,
//   with `distance < 100` itself only disqualifying if not already trying to
//   avoid melee), an attack_finished cooldown, and a coin flip (brandom()).
// - `monsterinfo.can_jump`/`drop_height`/`jump_height` (256/68) and
//   `combat_style = COMBAT_MELEE`: all [Paril-KEX] additions, absent from
//   vanilla.
// - `AI_STINKY` (spawn-flies) is set unconditionally in SP_monster_mutant;
//   absent from vanilla.
// - `mutant_jump_touch`'s "only if moving fast enough to hurt" velocity
//   check and the KEX-added `M_CheckBottom`-driven early-abort-to-FRAME_
//   attack02 retry logic in mutant_jump_touch/mutant_check_landing are new;
//   vanilla's touch handler is a simple unconditional-damage-then-freeze.
// - Death: KEX's `ai_move_slide_right`/`ai_move_slide_left` (self-contained
//   local wrappers around M_walkmove at self.s.angles[YAW] +/- 90) replace
//   vanilla's plain `ai_move`; `mutant_shrink`'s bounding-box collapse timing
//   also differs slightly (shrinks partway through the death table, not at
//   the very end).

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, CHAN_BODY, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import { SvflagsT, SolidT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type TouchFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  CombatStyleT,
  BlockedJumpResultT,
  MELEE_DISTANCE,
  RANGE_MELEE,
  DamageflagsT,
  random_time,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { frandom, irandom, brandom, YAW } from "./q_std";
import { vec3_add, vec3_muls, vec3_dot, vec3_length, vec3_normalized, AngleVectors } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { M_CheckBottom, M_walkmove } from "./m_move";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move, range_to } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, monster_dead, walkmonster_start } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { T_Damage } from "./g_combat";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { blocked_checkplat } from "./m_supertank";
import {
  RegisterDie,
  RegisterPain,
  RegisterTouch,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoCheckattack,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_mutant.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_attack01 = 0;
export const FRAME_attack02 = 1;
export const FRAME_attack03 = 2;
export const FRAME_attack04 = 3;
export const FRAME_attack05 = 4;
export const FRAME_attack06 = 5;
export const FRAME_attack07 = 6;
export const FRAME_attack08 = 7;
export const FRAME_attack09 = 8;
export const FRAME_attack10 = 9;
export const FRAME_attack11 = 10;
export const FRAME_attack12 = 11;
export const FRAME_attack13 = 12;
export const FRAME_attack14 = 13;
export const FRAME_attack15 = 14;
export const FRAME_death101 = 15;
export const FRAME_death102 = 16;
export const FRAME_death103 = 17;
export const FRAME_death104 = 18;
export const FRAME_death105 = 19;
export const FRAME_death106 = 20;
export const FRAME_death107 = 21;
export const FRAME_death108 = 22;
export const FRAME_death109 = 23;
export const FRAME_death201 = 24;
export const FRAME_death202 = 25;
export const FRAME_death203 = 26;
export const FRAME_death204 = 27;
export const FRAME_death205 = 28;
export const FRAME_death206 = 29;
export const FRAME_death207 = 30;
export const FRAME_death208 = 31;
export const FRAME_death209 = 32;
export const FRAME_death210 = 33;
export const FRAME_pain101 = 34;
export const FRAME_pain102 = 35;
export const FRAME_pain103 = 36;
export const FRAME_pain104 = 37;
export const FRAME_pain105 = 38;
export const FRAME_pain201 = 39;
export const FRAME_pain202 = 40;
export const FRAME_pain203 = 41;
export const FRAME_pain204 = 42;
export const FRAME_pain205 = 43;
export const FRAME_pain206 = 44;
export const FRAME_pain301 = 45;
export const FRAME_pain302 = 46;
export const FRAME_pain303 = 47;
export const FRAME_pain304 = 48;
export const FRAME_pain305 = 49;
export const FRAME_pain306 = 50;
export const FRAME_pain307 = 51;
export const FRAME_pain308 = 52;
export const FRAME_pain309 = 53;
export const FRAME_pain310 = 54;
export const FRAME_pain311 = 55;
export const FRAME_run03 = 56;
export const FRAME_run04 = 57;
export const FRAME_run05 = 58;
export const FRAME_run06 = 59;
export const FRAME_run07 = 60;
export const FRAME_run08 = 61;
export const FRAME_stand101 = 62;
export const FRAME_stand102 = 63;
export const FRAME_stand103 = 64;
export const FRAME_stand104 = 65;
export const FRAME_stand105 = 66;
export const FRAME_stand106 = 67;
export const FRAME_stand107 = 68;
export const FRAME_stand108 = 69;
export const FRAME_stand109 = 70;
export const FRAME_stand110 = 71;
export const FRAME_stand111 = 72;
export const FRAME_stand112 = 73;
export const FRAME_stand113 = 74;
export const FRAME_stand114 = 75;
export const FRAME_stand115 = 76;
export const FRAME_stand116 = 77;
export const FRAME_stand117 = 78;
export const FRAME_stand118 = 79;
export const FRAME_stand119 = 80;
export const FRAME_stand120 = 81;
export const FRAME_stand121 = 82;
export const FRAME_stand122 = 83;
export const FRAME_stand123 = 84;
export const FRAME_stand124 = 85;
export const FRAME_stand125 = 86;
export const FRAME_stand126 = 87;
export const FRAME_stand127 = 88;
export const FRAME_stand128 = 89;
export const FRAME_stand129 = 90;
export const FRAME_stand130 = 91;
export const FRAME_stand131 = 92;
export const FRAME_stand132 = 93;
export const FRAME_stand133 = 94;
export const FRAME_stand134 = 95;
export const FRAME_stand135 = 96;
export const FRAME_stand136 = 97;
export const FRAME_stand137 = 98;
export const FRAME_stand138 = 99;
export const FRAME_stand139 = 100;
export const FRAME_stand140 = 101;
export const FRAME_stand141 = 102;
export const FRAME_stand142 = 103;
export const FRAME_stand143 = 104;
export const FRAME_stand144 = 105;
export const FRAME_stand145 = 106;
export const FRAME_stand146 = 107;
export const FRAME_stand147 = 108;
export const FRAME_stand148 = 109;
export const FRAME_stand149 = 110;
export const FRAME_stand150 = 111;
export const FRAME_stand151 = 112;
export const FRAME_stand152 = 113;
export const FRAME_stand153 = 114;
export const FRAME_stand154 = 115;
export const FRAME_stand155 = 116;
export const FRAME_stand156 = 117;
export const FRAME_stand157 = 118;
export const FRAME_stand158 = 119;
export const FRAME_stand159 = 120;
export const FRAME_stand160 = 121;
export const FRAME_stand161 = 122;
export const FRAME_stand162 = 123;
export const FRAME_stand163 = 124;
export const FRAME_stand164 = 125;
export const FRAME_walk01 = 126;
export const FRAME_walk02 = 127;
export const FRAME_walk03 = 128;
export const FRAME_walk04 = 129;
export const FRAME_walk05 = 130;
export const FRAME_walk06 = 131;
export const FRAME_walk07 = 132;
export const FRAME_walk08 = 133;
export const FRAME_walk09 = 134;
export const FRAME_walk10 = 135;
export const FRAME_walk11 = 136;
export const FRAME_walk12 = 137;
export const FRAME_walk13 = 138;
export const FRAME_walk14 = 139;
export const FRAME_walk15 = 140;
export const FRAME_walk16 = 141;
export const FRAME_walk17 = 142;
export const FRAME_walk18 = 143;
export const FRAME_walk19 = 144;
export const FRAME_walk20 = 145;
export const FRAME_walk21 = 146;
export const FRAME_walk22 = 147;
export const FRAME_walk23 = 148;
// ROGUE
export const FRAME_jump01 = 149;
export const FRAME_jump02 = 150;
export const FRAME_jump03 = 151;
export const FRAME_jump04 = 152;
export const FRAME_jump05 = 153;
// ROGUE

export const MODEL_SCALE = 1.0;

const SPAWNFLAG_MUTANT_NOJUMPING: SpawnFlags = SpawnFlags_from(8);

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// monster_jump_finished (rogue/g_rogue_newai.cpp:101-117) -- see file header
// ---------------------------------------------------------------------------

function monster_jump_finished(self: EdictT): boolean {
  const { forward } = AngleVectors_destructured(self.s.angles);
  const forward_velocity = vec3_muls(forward, vec3_dot(self.velocity, forward));

  if (vec3_length(forward_velocity) < 150) {
    const z_velocity = self.velocity[2];
    self.velocity = vec3_muls(forward, 150);
    self.velocity[2] = z_velocity;
  }

  return self.monsterinfo.jump_time < level.time;
}

function AngleVectors_destructured(angles: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(angles, forward, right, up);
  return { forward, right, up };
}

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts for rationale)
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

let sound_swing = 0;
let sound_hit = 0;
let sound_hit2 = 0;
let sound_death = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;
let sound_search = 0;
let sound_step1 = 0;
let sound_step2 = 0;
let sound_step3 = 0;
let sound_thud = 0;

function mutant_step(self: EdictT): void {
  const n = irandom(3);
  if (n === 0) gi.sound(self, CHAN_BODY, sound_step1, 1, ATTN_NORM, 0);
  else if (n === 1) gi.sound(self, CHAN_BODY, sound_step2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_BODY, sound_step3, 1, ATTN_NORM, 0);
}

const mutant_sight = RegisterMonsterinfoSight("mutant_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const mutant_search = RegisterMonsterinfoSearch("mutant_search", (self: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
});

function mutant_swing(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_swing, 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// stand (m_mutant.cpp:64-127)
// ---------------------------------------------------------------------------

const mutant_frames_stand: MframeT[] = Array.from({ length: 51 }, () => frame(ai_stand));
const mutant_move_stand = RegisterMmove("mutant_move_stand", move(FRAME_stand101, FRAME_stand151, mutant_frames_stand));

const mutant_stand = RegisterMonsterinfoStand("mutant_stand", (self: EdictT): void => {
  M_SetAnimation(self, mutant_move_stand, true);
});

// ---------------------------------------------------------------------------
// idle (m_mutant.cpp:129-160)
// ---------------------------------------------------------------------------

function mutant_idle_loop(self: EdictT): void {
  if (frandom() < 0.75) self.monsterinfo.nextframe = FRAME_stand155;
}

const mutant_frames_idle: MframeT[] = [
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand), // scratch loop start
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, mutant_idle_loop), // scratch loop end
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
];
const mutant_move_idle = RegisterMmove("mutant_move_idle", move(FRAME_stand152, FRAME_stand164, mutant_frames_idle, (self: EdictT): void => mutant_stand(self)));

const mutant_idle = RegisterMonsterinfoIdle("mutant_idle", (self: EdictT): void => {
  M_SetAnimation(self, mutant_move_idle, true);
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
});

// ---------------------------------------------------------------------------
// walk (m_mutant.cpp:162-198)
// ---------------------------------------------------------------------------

const mutant_frames_walk: MframeT[] = [
  frame(ai_walk, 3),
  frame(ai_walk, 1),
  frame(ai_walk, 5),
  frame(ai_walk, 10),
  frame(ai_walk, 13),
  frame(ai_walk, 10),
  frame(ai_walk),
  frame(ai_walk, 5),
  frame(ai_walk, 6),
  frame(ai_walk, 16),
  frame(ai_walk, 15),
  frame(ai_walk, 6),
];
const mutant_move_walk = RegisterMmove("mutant_move_walk", move(FRAME_walk05, FRAME_walk16, mutant_frames_walk));

function mutant_walk_loop(self: EdictT): void {
  M_SetAnimation(self, mutant_move_walk, true);
}

const mutant_frames_start_walk: MframeT[] = [frame(ai_walk, 5), frame(ai_walk, 5), frame(ai_walk, -2), frame(ai_walk, 1)];
const mutant_move_start_walk = RegisterMmove(
  "mutant_move_start_walk",
  move(FRAME_walk01, FRAME_walk04, mutant_frames_start_walk, mutant_walk_loop),
);

const mutant_walk = RegisterMonsterinfoWalk("mutant_walk", (self: EdictT): void => {
  M_SetAnimation(self, mutant_move_start_walk, true);
});

// ---------------------------------------------------------------------------
// run (m_mutant.cpp:200-220)
// ---------------------------------------------------------------------------

const mutant_frames_run: MframeT[] = [
  frame(ai_run, 40),
  frame(ai_run, 40, mutant_step),
  frame(ai_run, 24),
  frame(ai_run, 5, mutant_step),
  frame(ai_run, 17),
  frame(ai_run, 10),
];
const mutant_move_run = RegisterMmove("mutant_move_run", move(FRAME_run03, FRAME_run08, mutant_frames_run));

const mutant_run = RegisterMonsterinfoRun("mutant_run", (self: EdictT): void => {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, mutant_move_stand, true);
  else M_SetAnimation(self, mutant_move_run, true);
});

// ---------------------------------------------------------------------------
// melee (m_mutant.cpp:222-273)
// ---------------------------------------------------------------------------

function mutant_hit_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, irandom(5, 15), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(1.5));
  }
}

function mutant_hit_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, irandom(5, 15), 100)) {
    gi.sound(self, CHAN_WEAPON, sound_hit2, 1, ATTN_NORM, 0);
  } else {
    gi.sound(self, CHAN_WEAPON, sound_swing, 1, ATTN_NORM, 0);
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(1.5));
  }
}

function mutant_check_refire(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse || self.enemy.health <= 0) return;

  if (self.monsterinfo.melee_debounce_time <= level.time && (frandom() < 0.5 || range_to(self, self.enemy) <= RANGE_MELEE)) {
    self.monsterinfo.nextframe = FRAME_attack09;
  }
}

const mutant_frames_attack: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, mutant_hit_left),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, mutant_hit_right),
  frame(ai_charge, 0, mutant_check_refire),
];
const mutant_move_attack = RegisterMmove("mutant_move_attack", move(FRAME_attack09, FRAME_attack15, mutant_frames_attack, (self: EdictT): void => mutant_run(self)));

const mutant_melee = RegisterMonsterinfoMelee("mutant_melee", (self: EdictT): void => {
  M_SetAnimation(self, mutant_move_attack, true);
});

// ---------------------------------------------------------------------------
// jump attack (m_mutant.cpp:275-374)
// ---------------------------------------------------------------------------

const mutant_jump_touch: TouchFn = RegisterTouch(
  "mutant_jump_touch",
  (self: EdictT, other: EdictT, _tr, _otherTouchingSelf: boolean): void => {
    if (self.health <= 0) {
      self.touch = null;
      return;
    }

    if (self.style === 1 && other.takedamage) {
      // [Paril-KEX] only if we're actually moving fast enough to hurt
      if (vec3_length(self.velocity) > 30) {
        const normal = vec3_normalized(self.velocity);
        const point = vec3_add(self.s.origin, vec3_muls(normal, self.maxs[0]));
        const damage = Math.trunc(frandom(40, 50));
        T_Damage(other, self, self, self.velocity, point, normal, damage, damage, DamageflagsT.DAMAGE_NONE, { id: ModIdT.MOD_UNKNOWN, friendly_fire: false, no_point_loss: false });
        self.style = 0;
      }
    }

    if (!M_CheckBottom(self)) {
      if (self.groundentity !== null) {
        self.monsterinfo.nextframe = FRAME_attack02;
        self.touch = null;
      }
      return;
    }

    self.touch = null;
  },
);

function mutant_jump_takeoff(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
  const forward = vec3();
  AngleVectors(self.s.angles, forward, null, null);
  self.s.origin[2] += 1;
  self.velocity = vec3_muls(forward, 425);
  self.velocity[2] = 160;
  self.groundentity = null;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DUCKED;
  self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_sec(3));
  self.style = 1;
  self.touch = mutant_jump_touch;
}

function mutant_check_landing(self: EdictT): void {
  monster_jump_finished(self);

  if (self.groundentity !== null) {
    gi.sound(self, CHAN_WEAPON, sound_thud, 1, ATTN_NORM, 0);
    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_ms(500), Gtime_from_sec(1.5)));

    if (self.monsterinfo.unduck !== null) self.monsterinfo.unduck(self);

    if (self.enemy !== null && range_to(self, self.enemy) <= RANGE_MELEE * 2 && self.monsterinfo.melee !== null) {
      self.monsterinfo.melee(self);
    }

    return;
  }

  if (level.time > self.monsterinfo.attack_finished) self.monsterinfo.nextframe = FRAME_attack02;
  else self.monsterinfo.nextframe = FRAME_attack05;
}

const mutant_frames_jump: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge, 17),
  frame(ai_charge, 15, mutant_jump_takeoff),
  frame(ai_charge, 15),
  frame(ai_charge, 15, mutant_check_landing),
  frame(ai_charge),
  frame(ai_charge, 3),
  frame(ai_charge),
];
const mutant_move_jump = RegisterMmove("mutant_move_jump", move(FRAME_attack01, FRAME_attack08, mutant_frames_jump, (self: EdictT): void => mutant_run(self)));

const mutant_jump = RegisterMonsterinfoAttack("mutant_jump", (self: EdictT): void => {
  M_SetAnimation(self, mutant_move_jump, true);
});

// ---------------------------------------------------------------------------
// checkattack (m_mutant.cpp:376-430)
// ---------------------------------------------------------------------------

function mutant_check_melee(self: EdictT): boolean {
  return self.enemy !== null && range_to(self, self.enemy) <= RANGE_MELEE && self.monsterinfo.melee_debounce_time <= level.time;
}

function mutant_check_jump(self: EdictT): boolean {
  if (self.enemy === null) return false;

  // Paril: no harm in letting them jump down if you're below them
  // if (self.absmin[2] > (self.enemy.absmin[2] + 0.75 * self.enemy.size[2]))
  //   return false;

  // don't jump if there's no way we can reach standing height
  if (self.absmin[2] + 125 < self.enemy.absmin[2]) return false;

  const v = vec3(self.s.origin[0] - self.enemy.s.origin[0], self.s.origin[1] - self.enemy.s.origin[1], 0);
  const distance = vec3_length(v);

  // if we're not trying to avoid a melee, then don't jump
  if (distance < 100 && self.monsterinfo.melee_debounce_time <= level.time) return false;
  // only use it to close distance gaps
  if (distance > 265) return false;

  return self.monsterinfo.attack_finished < level.time && brandom();
}

const mutant_checkattack = RegisterMonsterinfoCheckattack("mutant_checkattack", (self: EdictT): boolean => {
  if (self.enemy === null || self.enemy.health <= 0) return false;

  if (mutant_check_melee(self)) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MELEE;
    return true;
  }

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_MUTANT_NOJUMPING) && mutant_check_jump(self)) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_MISSILE;
    return true;
  }

  return false;
});

// ---------------------------------------------------------------------------
// pain (m_mutant.cpp:432-496)
// ---------------------------------------------------------------------------

const mutant_frames_pain1: MframeT[] = [frame(ai_move, 4), frame(ai_move, -3), frame(ai_move, -8), frame(ai_move, 2), frame(ai_move, 5)];
const mutant_move_pain1 = RegisterMmove("mutant_move_pain1", move(FRAME_pain101, FRAME_pain105, mutant_frames_pain1, (self: EdictT): void => mutant_run(self)));

const mutant_frames_pain2: MframeT[] = [
  frame(ai_move, -24),
  frame(ai_move, 11),
  frame(ai_move, 5),
  frame(ai_move, -2),
  frame(ai_move, 6),
  frame(ai_move, 4),
];
const mutant_move_pain2 = RegisterMmove("mutant_move_pain2", move(FRAME_pain201, FRAME_pain206, mutant_frames_pain2, (self: EdictT): void => mutant_run(self)));

const mutant_frames_pain3: MframeT[] = [
  frame(ai_move, -22),
  frame(ai_move, 3),
  frame(ai_move, 3),
  frame(ai_move, 2),
  frame(ai_move, 1),
  frame(ai_move, 1),
  frame(ai_move, 6),
  frame(ai_move, 3),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move, 1),
];
const mutant_move_pain3 = RegisterMmove("mutant_move_pain3", move(FRAME_pain301, FRAME_pain311, mutant_frames_pain3, (self: EdictT): void => mutant_run(self)));

const mutant_pain = RegisterPain("mutant_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const r = frandom();
  if (r < 0.33) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else if (r < 0.66) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (r < 0.33) M_SetAnimation(self, mutant_move_pain1, true);
  else if (r < 0.66) M_SetAnimation(self, mutant_move_pain2, true);
  else M_SetAnimation(self, mutant_move_pain3, true);
});

const mutant_setskin = RegisterMonsterinfoSetskin("mutant_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

// ---------------------------------------------------------------------------
// death (m_mutant.cpp:506-587)
// ---------------------------------------------------------------------------

function mutant_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

// [Paril-KEX]
function ai_move_slide_right(self: EdictT, dist: number): void {
  M_walkmove(self, self.s.angles[YAW] + 90, dist);
}

function ai_move_slide_left(self: EdictT, dist: number): void {
  M_walkmove(self, self.s.angles[YAW] - 90, dist);
}

const mutant_frames_death1: MframeT[] = [
  frame(ai_move_slide_right),
  frame(ai_move_slide_right),
  frame(ai_move_slide_right),
  frame(ai_move_slide_right, 2),
  frame(ai_move_slide_right, 5),
  frame(ai_move_slide_right, 7, mutant_shrink),
  frame(ai_move_slide_right, 6),
  frame(ai_move_slide_right, 2),
  frame(ai_move_slide_right),
];
const mutant_move_death1 = RegisterMmove("mutant_move_death1", move(FRAME_death101, FRAME_death109, mutant_frames_death1, monster_dead));

const mutant_frames_death2: MframeT[] = [
  frame(ai_move_slide_left),
  frame(ai_move_slide_left),
  frame(ai_move_slide_left),
  frame(ai_move_slide_left, 1),
  frame(ai_move_slide_left, 3, mutant_shrink),
  frame(ai_move_slide_left, 6),
  frame(ai_move_slide_left, 8),
  frame(ai_move_slide_left, 5),
  frame(ai_move_slide_left, 2),
  frame(ai_move_slide_left),
];
const mutant_move_death2 = RegisterMmove("mutant_move_death2", move(FRAME_death201, FRAME_death210, mutant_frames_death2, monster_dead));

const mutant_die = RegisterDie(
  "mutant_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

      self.s.skinnum = Math.trunc(self.s.skinnum / 2);

      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 4 },
        { gibname: "models/monsters/mutant/gibs/hand.md2", count: 2, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/mutant/gibs/foot.md2", count: 2, type: GibTypeT.GIB_SKINNED },
        { gibname: "models/monsters/mutant/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
        { gibname: "models/monsters/mutant/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);

      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    gi.sound(self, CHAN_VOICE, sound_death, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;

    if (frandom() < 0.5) M_SetAnimation(self, mutant_move_death1, true);
    else M_SetAnimation(self, mutant_move_death2, true);
  },
);

// ================
// ROGUE
function mutant_jump_down(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 100));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 300));
}

function mutant_jump_up(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 200));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 450));
}

function mutant_jump_wait_land(self: EdictT): void {
  if (!monster_jump_finished(self) && self.groundentity === null) self.monsterinfo.nextframe = self.s.frame;
  else self.monsterinfo.nextframe = self.s.frame + 1;
}

const mutant_frames_jump_up: MframeT[] = [
  frame(ai_move, -8),
  frame(ai_move, -8, mutant_jump_up),
  frame(ai_move, 0, mutant_jump_wait_land),
  frame(ai_move),
  frame(ai_move),
];
const mutant_move_jump_up = RegisterMmove("mutant_move_jump_up", move(FRAME_jump01, FRAME_jump05, mutant_frames_jump_up, (self: EdictT): void => mutant_run(self)));

const mutant_frames_jump_down: MframeT[] = [
  frame(ai_move),
  frame(ai_move, 0, mutant_jump_down),
  frame(ai_move, 0, mutant_jump_wait_land),
  frame(ai_move),
  frame(ai_move),
];
const mutant_move_jump_down = RegisterMmove(
  "mutant_move_jump_down",
  move(FRAME_jump01, FRAME_jump05, mutant_frames_jump_down, (self: EdictT): void => mutant_run(self)),
);

function mutant_jump_updown(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;

  if (result === BlockedJumpResultT.JUMP_JUMP_UP) M_SetAnimation(self, mutant_move_jump_up, true);
  else M_SetAnimation(self, mutant_move_jump_down, true);
}

/** `blocked_jump_result_t blocked_checkjump(edict_t*, float)` -- see file
 *  header's "EXTERNAL DEPENDENCY NOT YET PORTED" section. */
function blocked_checkjump(_self: EdictT, _dist: number): BlockedJumpResultT {
  throw new Error("blocked_checkjump: not yet ported (rogue mission-pack content, see rogue/g_rogue_newai.cpp:123)");
}

/*
===
Blocked
===
*/
const mutant_blocked = RegisterMonsterinfoBlocked("mutant_blocked", (self: EdictT, dist: number): boolean => {
  const result = blocked_checkjump(self, dist);
  if (result !== BlockedJumpResultT.NO_JUMP) {
    if (result !== BlockedJumpResultT.JUMP_TURN) mutant_jump_updown(self, result);
    return true;
  }

  if (blocked_checkplat(self, dist)) return true;

  return false;
});
// ROGUE
// ================

// ---------------------------------------------------------------------------
// spawn (m_mutant.cpp:668-742)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_mutant (1 .5 0) (-32 -32 -24) (32 32 32) Ambush
 * Trigger_Spawn Sight NoJumping
 * model="models/monsters/mutant/tris.md2"
 */
export function SP_monster_mutant(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_swing = gi.soundindex("mutant/mutatck1.wav");
  sound_hit = gi.soundindex("mutant/mutatck2.wav");
  sound_hit2 = gi.soundindex("mutant/mutatck3.wav");
  sound_death = gi.soundindex("mutant/mutdeth1.wav");
  sound_idle = gi.soundindex("mutant/mutidle1.wav");
  sound_pain1 = gi.soundindex("mutant/mutpain1.wav");
  sound_pain2 = gi.soundindex("mutant/mutpain2.wav");
  sound_sight = gi.soundindex("mutant/mutsght1.wav");
  sound_search = gi.soundindex("mutant/mutsrch1.wav");
  sound_step1 = gi.soundindex("mutant/step1.wav");
  sound_step2 = gi.soundindex("mutant/step2.wav");
  sound_step3 = gi.soundindex("mutant/step3.wav");
  sound_thud = gi.soundindex("mutant/thud1.wav");

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STINKY;

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/mutant/tris.md2");

  gi.modelindex("models/monsters/mutant/gibs/head.md2");
  gi.modelindex("models/monsters/mutant/gibs/chest.md2");
  gi.modelindex("models/monsters/mutant/gibs/hand.md2");
  gi.modelindex("models/monsters/mutant/gibs/foot.md2");

  self.mins = vec3(-18, -18, -24);
  self.maxs = vec3(18, 18, 30);

  self.health = Math.trunc(300 * st.health_multiplier);
  self.gib_health = -120;
  self.mass = 300;

  self.pain = mutant_pain;
  self.die = mutant_die;

  self.monsterinfo.stand = mutant_stand;
  self.monsterinfo.walk = mutant_walk;
  self.monsterinfo.run = mutant_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = mutant_jump;
  self.monsterinfo.melee = mutant_melee;
  self.monsterinfo.sight = mutant_sight;
  self.monsterinfo.search = mutant_search;
  self.monsterinfo.idle = mutant_idle;
  self.monsterinfo.checkattack = mutant_checkattack;
  self.monsterinfo.blocked = mutant_blocked; // PGM
  self.monsterinfo.setskin = mutant_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, mutant_move_stand, true);

  self.monsterinfo.combat_style = CombatStyleT.COMBAT_MELEE;

  self.monsterinfo.scale = MODEL_SCALE;
  self.monsterinfo.can_jump = !SpawnFlags_has(self.spawnflags, SPAWNFLAG_MUTANT_NOJUMPING);
  self.monsterinfo.drop_height = 256;
  self.monsterinfo.jump_height = 68;

  walkmonster_start(self);
}
