// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_float.cpp / m_float.h -- the FLOATER ("technician") monster (2023 Quake
// II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_float.cpp (716 lines, C++17)
// and m_float.h (259 lines, frame-index enum + MODEL_SCALE). Behavioral
// code, ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/m_soldier.ts/m_flipper.ts headers). A flying monster
// (`flymonster_start`, AI_ALTERNATE_FLY) with a blaster ranged attack, a
// claw ("wham") melee attack, and a zap melee attack -- no cross-file
// dependencies were left unported; every helper this file calls
// (monster_fire_blaster, M_ProjectFlashSource, fire_hit, T_Damage,
// ThrowGibs, flymonster_start, monsterFlashOffset) is already a real,
// landed export.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `floater_die` (m_float.cpp:619-638) NEVER calls `M_CheckGib`/plays a
//   death animation -- it unconditionally plays the death sound, a
//   TE_EXPLOSION1 burst, halves `s.skinnum`, and gibs, regardless of
//   overkill damage. The source's own death mframe_t table
//   (`floater_frames_death`, m_float.cpp:322-339) and third pain table
//   (`floater_frames_pain3`, m_float.cpp:364-380) are wrapped in `#if 0` --
//   genuinely dead code in the C++ itself, confirmed unreachable from any
//   call site. `floater_dead` (m_float.cpp:609-617) is likewise dead code
//   (nothing calls it once the death move is `#if 0`'d out) -- ported here,
//   verbatim, unexported and unreferenced, matching the established
//   "keep dead code for source fidelity" precedent (m_soldier.ts's
//   SP_monster_soldier_vanilla).
// - `self->gib_health = -80` (m_float.cpp:686) is a dead field: nothing
//   ever reads `gib_health` since `floater_die` never calls `M_CheckGib`.
//   Set anyway, for fidelity.
// - `floater_pain` (m_float.cpp:572-599): `n = irandom(3)` yields 0, 1, or
//   2, but is only ever tested via `n == 0` -- a genuine 1-in-3 vs 2-in-3
//   split between the "pain1" and "pain2" sound/animation pairs, NOT a
//   50/50 coin flip. Preserved exactly.
// - `floater_move_walk`/`floater_move_run` (m_float.cpp:382-436, 438-492)
//   both reuse the FRAME_stand101..FRAME_stand152 range (the same 52
//   frames as `floater_move_stand1`) with entirely different mframe
//   tables (`ai_walk` dist=5 / `ai_run` dist=13 respectively, vs
//   `ai_stand` for the stand move) -- the model data is shared, only the
//   aifunc/dist differs. Preserved exactly, not deduplicated.
// - `floater_move_attack1`/`floater_move_attack1a` (m_float.cpp:217-252)
//   share the identical FRAME_attak101..FRAME_attak114 range and both fire
//   `floater_fire_blaster` on the same 7 interior frames; the only
//   difference is `dist` (0 vs 10, for the PMM circle-strafe variant
//   selected by `floater_attack`'s 50/50 coin flip).
// - `floater_zap`'s muzzle offset (m_float.cpp:518-544) is a raw inline
//   `vec3_t{18.5f, -0.9f, 10}`, NOT looked up via
//   `monsterFlashOffset()[MZ2_FLOAT_BLASTER_1]` the way `floater_fire_blaster`
//   does -- the source's own "FIXME use a flash" comments confirm this is
//   deliberate leftover, not an oversight to fix. Preserved exactly.
// - `floater_fire_blaster`'s hyperblaster effect (m_float.cpp:56) is gated
//   `(self->s.frame % 4) ? EF_NONE : EF_HYPERBLASTER` -- i.e. the effect is
//   ADDED on frames where `frame % 4 === 0`, not the more intuitive
//   inverse. Preserved exactly.

import { vec3, vec3_origin, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import { vec3_sub, vec3_normalized, AngleVectors } from "./q_vec3";
import { SvflagsT, SolidT, EffectsT, MonsterMuzzleflashIdT, ServerCommandT, KexTempEventT, KexMulticastT, SplashColorT } from "../kexapi/game";
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
  GibTypeT,
  DamageflagsT,
  MELEE_DISTANCE,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, GTIME_ZERO } from "./gtime";
import { frandom, irandom } from "./q_std";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, flymonster_start, monster_fire_blaster, M_ProjectFlashSource } from "./g_monster";
import { fire_hit } from "./g_weapon";
import { T_Damage } from "./g_combat";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { SpawnFlags_from, SpawnFlags_has, type SpawnFlags } from "./spawnflags";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_float.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_actvat01 = 0;
export const FRAME_actvat02 = 1;
export const FRAME_actvat03 = 2;
export const FRAME_actvat04 = 3;
export const FRAME_actvat05 = 4;
export const FRAME_actvat06 = 5;
export const FRAME_actvat07 = 6;
export const FRAME_actvat08 = 7;
export const FRAME_actvat09 = 8;
export const FRAME_actvat10 = 9;
export const FRAME_actvat11 = 10;
export const FRAME_actvat12 = 11;
export const FRAME_actvat13 = 12;
export const FRAME_actvat14 = 13;
export const FRAME_actvat15 = 14;
export const FRAME_actvat16 = 15;
export const FRAME_actvat17 = 16;
export const FRAME_actvat18 = 17;
export const FRAME_actvat19 = 18;
export const FRAME_actvat20 = 19;
export const FRAME_actvat21 = 20;
export const FRAME_actvat22 = 21;
export const FRAME_actvat23 = 22;
export const FRAME_actvat24 = 23;
export const FRAME_actvat25 = 24;
export const FRAME_actvat26 = 25;
export const FRAME_actvat27 = 26;
export const FRAME_actvat28 = 27;
export const FRAME_actvat29 = 28;
export const FRAME_actvat30 = 29;
export const FRAME_actvat31 = 30;
export const FRAME_attak101 = 31;
export const FRAME_attak102 = 32;
export const FRAME_attak103 = 33;
export const FRAME_attak104 = 34;
export const FRAME_attak105 = 35;
export const FRAME_attak106 = 36;
export const FRAME_attak107 = 37;
export const FRAME_attak108 = 38;
export const FRAME_attak109 = 39;
export const FRAME_attak110 = 40;
export const FRAME_attak111 = 41;
export const FRAME_attak112 = 42;
export const FRAME_attak113 = 43;
export const FRAME_attak114 = 44;
export const FRAME_attak201 = 45;
export const FRAME_attak202 = 46;
export const FRAME_attak203 = 47;
export const FRAME_attak204 = 48;
export const FRAME_attak205 = 49;
export const FRAME_attak206 = 50;
export const FRAME_attak207 = 51;
export const FRAME_attak208 = 52;
export const FRAME_attak209 = 53;
export const FRAME_attak210 = 54;
export const FRAME_attak211 = 55;
export const FRAME_attak212 = 56;
export const FRAME_attak213 = 57;
export const FRAME_attak214 = 58;
export const FRAME_attak215 = 59;
export const FRAME_attak216 = 60;
export const FRAME_attak217 = 61;
export const FRAME_attak218 = 62;
export const FRAME_attak219 = 63;
export const FRAME_attak220 = 64;
export const FRAME_attak221 = 65;
export const FRAME_attak222 = 66;
export const FRAME_attak223 = 67;
export const FRAME_attak224 = 68;
export const FRAME_attak225 = 69;
export const FRAME_attak301 = 70;
export const FRAME_attak302 = 71;
export const FRAME_attak303 = 72;
export const FRAME_attak304 = 73;
export const FRAME_attak305 = 74;
export const FRAME_attak306 = 75;
export const FRAME_attak307 = 76;
export const FRAME_attak308 = 77;
export const FRAME_attak309 = 78;
export const FRAME_attak310 = 79;
export const FRAME_attak311 = 80;
export const FRAME_attak312 = 81;
export const FRAME_attak313 = 82;
export const FRAME_attak314 = 83;
export const FRAME_attak315 = 84;
export const FRAME_attak316 = 85;
export const FRAME_attak317 = 86;
export const FRAME_attak318 = 87;
export const FRAME_attak319 = 88;
export const FRAME_attak320 = 89;
export const FRAME_attak321 = 90;
export const FRAME_attak322 = 91;
export const FRAME_attak323 = 92;
export const FRAME_attak324 = 93;
export const FRAME_attak325 = 94;
export const FRAME_attak326 = 95;
export const FRAME_attak327 = 96;
export const FRAME_attak328 = 97;
export const FRAME_attak329 = 98;
export const FRAME_attak330 = 99;
export const FRAME_attak331 = 100;
export const FRAME_attak332 = 101;
export const FRAME_attak333 = 102;
export const FRAME_attak334 = 103;
export const FRAME_death01 = 104;
export const FRAME_death02 = 105;
export const FRAME_death03 = 106;
export const FRAME_death04 = 107;
export const FRAME_death05 = 108;
export const FRAME_death06 = 109;
export const FRAME_death07 = 110;
export const FRAME_death08 = 111;
export const FRAME_death09 = 112;
export const FRAME_death10 = 113;
export const FRAME_death11 = 114;
export const FRAME_death12 = 115;
export const FRAME_death13 = 116;
export const FRAME_pain101 = 117;
export const FRAME_pain102 = 118;
export const FRAME_pain103 = 119;
export const FRAME_pain104 = 120;
export const FRAME_pain105 = 121;
export const FRAME_pain106 = 122;
export const FRAME_pain107 = 123;
export const FRAME_pain201 = 124;
export const FRAME_pain202 = 125;
export const FRAME_pain203 = 126;
export const FRAME_pain204 = 127;
export const FRAME_pain205 = 128;
export const FRAME_pain206 = 129;
export const FRAME_pain207 = 130;
export const FRAME_pain208 = 131;
export const FRAME_pain301 = 132;
export const FRAME_pain302 = 133;
export const FRAME_pain303 = 134;
export const FRAME_pain304 = 135;
export const FRAME_pain305 = 136;
export const FRAME_pain306 = 137;
export const FRAME_pain307 = 138;
export const FRAME_pain308 = 139;
export const FRAME_pain309 = 140;
export const FRAME_pain310 = 141;
export const FRAME_pain311 = 142;
export const FRAME_pain312 = 143;
export const FRAME_stand101 = 144;
export const FRAME_stand102 = 145;
export const FRAME_stand103 = 146;
export const FRAME_stand104 = 147;
export const FRAME_stand105 = 148;
export const FRAME_stand106 = 149;
export const FRAME_stand107 = 150;
export const FRAME_stand108 = 151;
export const FRAME_stand109 = 152;
export const FRAME_stand110 = 153;
export const FRAME_stand111 = 154;
export const FRAME_stand112 = 155;
export const FRAME_stand113 = 156;
export const FRAME_stand114 = 157;
export const FRAME_stand115 = 158;
export const FRAME_stand116 = 159;
export const FRAME_stand117 = 160;
export const FRAME_stand118 = 161;
export const FRAME_stand119 = 162;
export const FRAME_stand120 = 163;
export const FRAME_stand121 = 164;
export const FRAME_stand122 = 165;
export const FRAME_stand123 = 166;
export const FRAME_stand124 = 167;
export const FRAME_stand125 = 168;
export const FRAME_stand126 = 169;
export const FRAME_stand127 = 170;
export const FRAME_stand128 = 171;
export const FRAME_stand129 = 172;
export const FRAME_stand130 = 173;
export const FRAME_stand131 = 174;
export const FRAME_stand132 = 175;
export const FRAME_stand133 = 176;
export const FRAME_stand134 = 177;
export const FRAME_stand135 = 178;
export const FRAME_stand136 = 179;
export const FRAME_stand137 = 180;
export const FRAME_stand138 = 181;
export const FRAME_stand139 = 182;
export const FRAME_stand140 = 183;
export const FRAME_stand141 = 184;
export const FRAME_stand142 = 185;
export const FRAME_stand143 = 186;
export const FRAME_stand144 = 187;
export const FRAME_stand145 = 188;
export const FRAME_stand146 = 189;
export const FRAME_stand147 = 190;
export const FRAME_stand148 = 191;
export const FRAME_stand149 = 192;
export const FRAME_stand150 = 193;
export const FRAME_stand151 = 194;
export const FRAME_stand152 = 195;
export const FRAME_stand201 = 196;
export const FRAME_stand202 = 197;
export const FRAME_stand203 = 198;
export const FRAME_stand204 = 199;
export const FRAME_stand205 = 200;
export const FRAME_stand206 = 201;
export const FRAME_stand207 = 202;
export const FRAME_stand208 = 203;
export const FRAME_stand209 = 204;
export const FRAME_stand210 = 205;
export const FRAME_stand211 = 206;
export const FRAME_stand212 = 207;
export const FRAME_stand213 = 208;
export const FRAME_stand214 = 209;
export const FRAME_stand215 = 210;
export const FRAME_stand216 = 211;
export const FRAME_stand217 = 212;
export const FRAME_stand218 = 213;
export const FRAME_stand219 = 214;
export const FRAME_stand220 = 215;
export const FRAME_stand221 = 216;
export const FRAME_stand222 = 217;
export const FRAME_stand223 = 218;
export const FRAME_stand224 = 219;
export const FRAME_stand225 = 220;
export const FRAME_stand226 = 221;
export const FRAME_stand227 = 222;
export const FRAME_stand228 = 223;
export const FRAME_stand229 = 224;
export const FRAME_stand230 = 225;
export const FRAME_stand231 = 226;
export const FRAME_stand232 = 227;
export const FRAME_stand233 = 228;
export const FRAME_stand234 = 229;
export const FRAME_stand235 = 230;
export const FRAME_stand236 = 231;
export const FRAME_stand237 = 232;
export const FRAME_stand238 = 233;
export const FRAME_stand239 = 234;
export const FRAME_stand240 = 235;
export const FRAME_stand241 = 236;
export const FRAME_stand242 = 237;
export const FRAME_stand243 = 238;
export const FRAME_stand244 = 239;
export const FRAME_stand245 = 240;
export const FRAME_stand246 = 241;
export const FRAME_stand247 = 242;
export const FRAME_stand248 = 243;
export const FRAME_stand249 = 244;
export const FRAME_stand250 = 245;
export const FRAME_stand251 = 246;
export const FRAME_stand252 = 247;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts precedent)
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

let sound_attack2 = 0;
let sound_attack3 = 0;
let sound_death1 = 0;
let sound_idle = 0;
let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_sight = 0;

// ---------------------------------------------------------------------------
// sight / idle (m_float.cpp:23-31)
// ---------------------------------------------------------------------------

const floater_sight = RegisterMonsterinfoSight("floater_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

const floater_idle = RegisterMonsterinfoIdle("floater_idle", (self: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
});

// ---------------------------------------------------------------------------
// floater_fire_blaster (m_float.cpp:38-57)
// ---------------------------------------------------------------------------

function floater_fire_blaster(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_FLOAT_BLASTER_1], forward, right);

  const end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(end, start));

  monster_fire_blaster(
    self,
    start,
    dir,
    1,
    1000,
    MonsterMuzzleflashIdT.MZ2_FLOAT_BLASTER_1,
    self.s.frame % 4 !== 0 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER,
  );
}

// ---------------------------------------------------------------------------
// stand (m_float.cpp:59-215)
// ---------------------------------------------------------------------------

const floater_frames_stand1: MframeT[] = Array.from({ length: 52 }, () => frame(ai_stand));
const floater_move_stand1 = RegisterMmove("floater_move_stand1", move(FRAME_stand101, FRAME_stand152, floater_frames_stand1));

const floater_frames_stand2: MframeT[] = Array.from({ length: 52 }, () => frame(ai_stand));
const floater_move_stand2 = RegisterMmove("floater_move_stand2", move(FRAME_stand201, FRAME_stand252, floater_frames_stand2));

const floater_frames_pop: MframeT[] = Array.from({ length: 27 }, () => frame(null));
const floater_move_pop = RegisterMmove("floater_move_pop", move(FRAME_actvat05, FRAME_actvat31, floater_frames_pop, floater_run));

const floater_frames_disguise: MframeT[] = [frame(ai_stand)];
const floater_move_disguise = RegisterMmove("floater_move_disguise", move(FRAME_actvat01, FRAME_actvat01, floater_frames_disguise));

const floater_stand = RegisterMonsterinfoStand("floater_stand", (self: EdictT): void => {
  if (self.monsterinfo.active_move === floater_move_disguise) M_SetAnimation(self, floater_move_disguise, true);
  else if (frandom() <= 0.5) M_SetAnimation(self, floater_move_stand1, true);
  else M_SetAnimation(self, floater_move_stand2, true);
});

// ---------------------------------------------------------------------------
// attack1 / attack1a -- blaster, straight and circle-strafe (m_float.cpp:217-253)
// ---------------------------------------------------------------------------

const floater_frames_attack1: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge, 0, floater_fire_blaster),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const floater_move_attack1 = RegisterMmove("floater_move_attack1", move(FRAME_attak101, FRAME_attak114, floater_frames_attack1, floater_run));

// PMM - circle strafe frames
const floater_frames_attack1a: MframeT[] = [
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10, floater_fire_blaster),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
  frame(ai_charge, 10),
];
const floater_move_attack1a = RegisterMmove("floater_move_attack1a", move(FRAME_attak101, FRAME_attak114, floater_frames_attack1a, floater_run));

// ---------------------------------------------------------------------------
// attack2 -- claws (m_float.cpp:255-282)
// ---------------------------------------------------------------------------

const floater_frames_attack2: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, floater_wham),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const floater_move_attack2 = RegisterMmove("floater_move_attack2", move(FRAME_attak201, FRAME_attak225, floater_frames_attack2, floater_run));

// ---------------------------------------------------------------------------
// attack3 -- zap (m_float.cpp:284-320)
// ---------------------------------------------------------------------------

const floater_frames_attack3: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, floater_zap),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const floater_move_attack3 = RegisterMmove("floater_move_attack3", move(FRAME_attak301, FRAME_attak334, floater_frames_attack3, floater_run));

// ---------------------------------------------------------------------------
// pain (m_float.cpp:341-362; floater_frames_pain3/#if 0 dead code omitted --
// see file header)
// ---------------------------------------------------------------------------

const floater_frames_pain1: MframeT[] = Array.from({ length: 7 }, () => frame(ai_move));
const floater_move_pain1 = RegisterMmove("floater_move_pain1", move(FRAME_pain101, FRAME_pain107, floater_frames_pain1, floater_run));

const floater_frames_pain2: MframeT[] = Array.from({ length: 8 }, () => frame(ai_move));
const floater_move_pain2 = RegisterMmove("floater_move_pain2", move(FRAME_pain201, FRAME_pain208, floater_frames_pain2, floater_run));

// ---------------------------------------------------------------------------
// walk / run (m_float.cpp:382-502)
// ---------------------------------------------------------------------------

const floater_frames_walk: MframeT[] = Array.from({ length: 52 }, () => frame(ai_walk, 5));
const floater_move_walk = RegisterMmove("floater_move_walk", move(FRAME_stand101, FRAME_stand152, floater_frames_walk));

const floater_walk = RegisterMonsterinfoWalk("floater_walk", (self: EdictT): void => {
  M_SetAnimation(self, floater_move_walk, true);
});

const floater_frames_run: MframeT[] = Array.from({ length: 52 }, () => frame(ai_run, 13));
const floater_move_run = RegisterMmove("floater_move_run", move(FRAME_stand101, FRAME_stand152, floater_frames_run));

function floater_run(self: EdictT): void {
  if (self.monsterinfo.active_move === floater_move_disguise) M_SetAnimation(self, floater_move_pop, true);
  else if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, floater_move_stand1, true);
  else M_SetAnimation(self, floater_move_run, true);
}
RegisterMonsterinfoRun("floater_run", floater_run);

// ---------------------------------------------------------------------------
// wham / zap melee (m_float.cpp:509-544)
// ---------------------------------------------------------------------------

function floater_wham(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  gi.sound(self, CHAN_WEAPON, sound_attack3, 1, ATTN_NORM, 0);

  if (!fire_hit(self, aim, irandom(5, 11), -50)) self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
}

function floater_zap(self: EdictT): void {
  if (self.enemy === null) return;

  const dir = vec3_sub(self.enemy.s.origin, self.s.origin);

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  // FIXME use a flash and replace these two lines with the commented one
  const offset = vec3(18.5, -0.9, 10);
  const origin = M_ProjectFlashSource(self, offset, forward, right);

  gi.sound(self, CHAN_WEAPON, sound_attack2, 1, ATTN_NORM, 0);

  // FIXME use the flash, Luke
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_SPLASH);
  gi.WriteByte(32);
  gi.WritePosition(origin);
  gi.WriteDir(dir);
  gi.WriteByte(SplashColorT.SPLASH_SPARKS);
  gi.multicast(origin, KexMulticastT.MULTICAST_PVS, false);

  T_Damage(self.enemy, self, self, dir, self.enemy.s.origin, vec3_origin, irandom(5, 11), -10, DamageflagsT.DAMAGE_ENERGY, {
    id: ModIdT.MOD_UNKNOWN,
    friendly_fire: false,
    no_point_loss: false,
  });
}

// ---------------------------------------------------------------------------
// attack / melee dispatch (m_float.cpp:546-570)
// ---------------------------------------------------------------------------

const floater_attack = RegisterMonsterinfoAttack("floater_attack", (self: EdictT): void => {
  const chance = 0.5;

  if (frandom() > chance) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
    M_SetAnimation(self, floater_move_attack1, true);
  } else {
    // circle strafe
    if (frandom() <= 0.5) self.monsterinfo.lefty = !self.monsterinfo.lefty; // switch directions
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
    M_SetAnimation(self, floater_move_attack1a, true);
  }
});

const floater_melee = RegisterMonsterinfoMelee("floater_melee", (self: EdictT): void => {
  if (frandom() < 0.5) M_SetAnimation(self, floater_move_attack3, true);
  else M_SetAnimation(self, floater_move_attack2, true);
});

// ---------------------------------------------------------------------------
// pain / setskin / death (m_float.cpp:572-638)
// ---------------------------------------------------------------------------

const floater_pain = RegisterPain("floater_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  // no pain anims if poppin'
  if (self.monsterinfo.active_move === floater_move_disguise || self.monsterinfo.active_move === floater_move_pop) return;

  const n = irandom(3);
  if (n === 0) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (n === 0) M_SetAnimation(self, floater_move_pain1, true);
  else M_SetAnimation(self, floater_move_pain2, true);
});

const floater_setskin = RegisterMonsterinfoSetskin("floater_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

/** m_float.cpp:609-617 -- dead code, see file header. Ported for fidelity,
 *  unreferenced (the death mframe_t table that would call this is `#if 0`'d
 *  out in the C++ itself). */
function floater_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.nextthink = GTIME_ZERO;
  gi.linkentity(self);
}

const floater_die = RegisterDie(
  "floater_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void => {
    gi.sound(self, CHAN_VOICE, sound_death1, 1, ATTN_NORM, 0);

    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
    gi.WritePosition(self.s.origin);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    const gibs: GibDefT[] = [
      { gibname: "models/objects/gibs/sm_metal/tris.md2", count: 2 },
      { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 3 },
      { gibname: "models/monsters/float/gibs/piece.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/float/gibs/gun.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/float/gibs/base.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/float/gibs/jar.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
    ];
    ThrowGibs(self, 55, gibs);
  },
);

// ---------------------------------------------------------------------------
// spawn (m_float.cpp:640-716)
// ---------------------------------------------------------------------------

function float_set_fly_parameters(self: EdictT): void {
  self.monsterinfo.fly_thrusters = false;
  self.monsterinfo.fly_acceleration = 10.0;
  self.monsterinfo.fly_speed = 100.0;
  // Technician gets in closer because he has two melee attacks
  self.monsterinfo.fly_min_distance = 20.0;
  self.monsterinfo.fly_max_distance = 200.0;
}

const SPAWNFLAG_FLOATER_DISGUISE: SpawnFlags = SpawnFlags_from(8);

/**
 * QUAKED monster_floater (1 .5 0) (-16 -16 -24) (16 16 32) Ambush
 * Trigger_Spawn Sight Disguise
 */
export function SP_monster_floater(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_attack2 = gi.soundindex("floater/fltatck2.wav");
  sound_attack3 = gi.soundindex("floater/fltatck3.wav");
  sound_death1 = gi.soundindex("floater/fltdeth1.wav");
  sound_idle = gi.soundindex("floater/fltidle1.wav");
  sound_pain1 = gi.soundindex("floater/fltpain1.wav");
  sound_pain2 = gi.soundindex("floater/fltpain2.wav");
  sound_sight = gi.soundindex("floater/fltsght1.wav");

  gi.soundindex("floater/fltatck1.wav");

  self.monsterinfo.engine_sound = gi.soundindex("floater/fltsrch1.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/float/tris.md2");

  gi.modelindex("models/monsters/float/gibs/base.md2");
  gi.modelindex("models/monsters/float/gibs/gun.md2");
  gi.modelindex("models/monsters/float/gibs/jar.md2");
  gi.modelindex("models/monsters/float/gibs/piece.md2");

  self.mins = vec3(-24, -24, -24);
  self.maxs = vec3(24, 24, 48);

  self.health = Math.trunc(200 * st.health_multiplier);
  self.gib_health = -80;
  self.mass = 300;

  self.pain = floater_pain;
  self.die = floater_die;

  self.monsterinfo.stand = floater_stand;
  self.monsterinfo.walk = floater_walk;
  self.monsterinfo.run = floater_run;
  self.monsterinfo.attack = floater_attack;
  self.monsterinfo.melee = floater_melee;
  self.monsterinfo.sight = floater_sight;
  self.monsterinfo.idle = floater_idle;
  self.monsterinfo.setskin = floater_setskin;

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_FLOATER_DISGUISE)) M_SetAnimation(self, floater_move_disguise, true);
  else if (frandom() <= 0.5) M_SetAnimation(self, floater_move_stand1, true);
  else M_SetAnimation(self, floater_move_stand2, true);

  self.monsterinfo.scale = MODEL_SCALE;

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  float_set_fly_parameters(self);

  flymonster_start(self);
}
