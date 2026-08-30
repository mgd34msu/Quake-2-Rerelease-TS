// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_tank.cpp / m_tank.h -- TANK / TANK COMMANDER (2023 Quake II re-release /
// "KEX" engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/
// m_tank.cpp (1,163 lines, C++17) and m_tank.h (305 lines, 294-entry frame
// enum -- generated mechanically from the header). Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// FORWARD-REFERENCED HANDLERS (see m_chick.ts's/m_parasite.ts's identical
// pattern)
// ============================================================================
// The C++ source forward-declares five functions (tank_refire_rocket,
// tank_doattack_rocket, tank_reattack_blaster at the top; tank_walk and
// tank_run individually, right before their sections) because their
// mframe_t/mmove_t tables reference them before their own definitions. All
// five are ported as plain hoisted `function` declarations. `tank_walk`/
// `tank_run` (MONSTERINFO_WALK/RUN) additionally get a separate
// `_registered` RegisterMonsterinfoWalk/Run binding used only for the
// `self.monsterinfo.walk`/`.run` assignments in SP_monster_tank; `tank_
// refire_rocket`/`tank_doattack_rocket`/`tank_reattack_blaster` are pure
// mmove_t endfunc targets, never monsterinfo-assigned, so they need no
// RegisterX wrapper at all.
//
// ============================================================================
// Use_Boss3 -- OUT OF SCOPE, throwing stub, cited
// ============================================================================
// `void Use_Boss3(edict_t*, edict_t*, edict_t*)` is forward-declared in this
// file (m_tank.cpp:1119) immediately before SP_monster_tank_stand assigns it
// to `self->use`, but its real body lives in m_boss3.cpp (the Jorg/final-
// boss chain) -- genuinely outside this task's six-monster scope (m_boss3.ts
// is not one of them and does not exist yet). `monster_tank_stand` is a
// decorative N64-only entity ("just stands and cycles in one place until
// targeted, then teleports away") that a mapper must explicitly place and
// then explicitly `use` to ever reach this code path; nothing in this port
// line's spawn tables auto-triggers it. Local throwing stub, cited -- a
// future m_boss3.ts unit should replace it with a real import.
//
// ============================================================================
// EXTERNAL DEPENDENCIES PORTED FOR REAL (imported from m_supertank.ts, this
// task's own canonical body)
// ============================================================================
// `PredictAim`, `monster_fire_heat`, `blocked_checkplat` are all imported
// from m_supertank.ts (this task's file scope) rather than duplicated --
// see that file's header for the ROGUE/xatrix placement-mismatch rationale.
// `M_AdjustBlindfireTarget` ([Paril-KEX], g_local.h has no declaration for
// it at all -- it's a plain `static`-less helper defined and used entirely
// within this one file) is ported locally, real, not a stub.
//
// ============================================================================
// KEX-only content vs. the legacy (vanilla Q2) src/game/m_tank.ts port
// ============================================================================
// - Tank Commander: `strcmp(self->classname, "monster_tank_commander")`
//   branches for health (1000 vs 750, both *st.health_multiplier)/gib_health
//   (-225 vs -200)/pain sound/skinnum(2) are present in the LEGACY port too,
//   but KEX adds SPAWNFLAG_TANK_COMMANDER_GUARDIAN (8, "N64 tank commander is
//   a chonky boy": forces s.scale=1.5 if unset and health=1500) and
//   SPAWNFLAG_TANK_COMMANDER_HEAT_SEEKING (16: TankRocket fires
//   monster_fire_heat instead of monster_fire_rocket, using self.accel
//   (default 0.075) as the turn_fraction).
// - Blindfire (ROGUE PMM content): `tank_attack`'s entire AS_BLIND branch,
//   `TankBlaster`/`TankRocket`'s `blindfire`/`M_AdjustBlindfireTarget`
//   three-attempt retry ladder, and `tank_blind_check`'s `AI_MANUAL_
//   STEERING` ideal_yaw override are absent from vanilla Q2's tank, which
//   fires exactly one predicted/unpredicted shot with no retry logic.
// - `tank_reattack_blaster`'s/`tank_refire_rocket`'s
//   `AI_MANUAL_STEERING`-cleanup early-outs are new (needed only because
//   blindfire exists).
// - `AI_IGNORE_SHOTS` and `monsterinfo.blindfire = true` set unconditionally
//   in SP_monster_tank are new.
// - `tank_die`'s "dropped arm" gib-on-first-hit-but-not-dead-yet
//   (self.style as a one-shot flag, ThrowGib'd with real velocity/avelocity)
//   is a [Paril-KEX] addition; vanilla only drops the arm as part of the
//   gib-death gib list, never earlier.
// - `monster_tank_stand`/`Think_TankStand`/`Use_Boss3` (the N64 "chonky
//   Jorg-teleport" easter egg) does not exist in vanilla Q2 at all.
// - `tank_attack`'s three-tier range-based weapon selection
//   (<=125/<=250/else) with `M_CheckClearShot` gating per weapon and a
//   tesla_mine exclusion for the chaingun is a full KEX rewrite; vanilla's
//   attack selection is a much simpler two-way range check with no clear-
//   shot gating at all.
// - `#if 0`-guarded `tank_move_start_walk`/`tank_move_stop_walk`/
//   `tank_move_stop_run` are dropped per PORTING.md's "#if 0 blocks are
//   dropped silently."

import { vec3, VectorCopy, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, CHAN_BODY, ATTN_NORM, ATTN_IDLE } from "../shared/q_shared";
import { SvflagsT, SolidT, EffectsT, MASK_PROJECTILE, CvarFlagsT } from "../kexapi/game";
import { MonsterMuzzleflashIdT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type ThinkFn,
  type UseFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  HOLD_FOREVER,
  random_time,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_hz } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { frandom, crandom, brandom, YAW } from "./q_std";
import { vec3_add, vec3_sub, vec3_length, vec3_normalized, vec3_muls, AngleVectors_destructured, vectoangles, vectoyaw } from "./q_vec3";
import { G_FreeEdict } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_walk, ai_run, ai_charge, ai_move, range_to, visible } from "./g_ai";
import {
  M_SetAnimation,
  M_AllowSpawn,
  M_ShouldReactToPain,
  M_ProjectFlashSource,
  M_CheckClearShot,
  monster_dead,
  walkmonster_start,
  monster_fire_blaster,
  monster_fire_rocket,
  monster_fire_bullet,
} from "./g_monster";
import { ThrowGib, ThrowGibs, type GibDefT } from "./g_misc";
import { monsterFlashOffset } from "./m_flash";
import { PredictAim, monster_fire_heat, blocked_checkplat } from "./m_supertank";
import {
  RegisterThink,
  RegisterUse,
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_tank.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_stand01 = 0;
export const FRAME_stand02 = 1;
export const FRAME_stand03 = 2;
export const FRAME_stand04 = 3;
export const FRAME_stand05 = 4;
export const FRAME_stand06 = 5;
export const FRAME_stand07 = 6;
export const FRAME_stand08 = 7;
export const FRAME_stand09 = 8;
export const FRAME_stand10 = 9;
export const FRAME_stand11 = 10;
export const FRAME_stand12 = 11;
export const FRAME_stand13 = 12;
export const FRAME_stand14 = 13;
export const FRAME_stand15 = 14;
export const FRAME_stand16 = 15;
export const FRAME_stand17 = 16;
export const FRAME_stand18 = 17;
export const FRAME_stand19 = 18;
export const FRAME_stand20 = 19;
export const FRAME_stand21 = 20;
export const FRAME_stand22 = 21;
export const FRAME_stand23 = 22;
export const FRAME_stand24 = 23;
export const FRAME_stand25 = 24;
export const FRAME_stand26 = 25;
export const FRAME_stand27 = 26;
export const FRAME_stand28 = 27;
export const FRAME_stand29 = 28;
export const FRAME_stand30 = 29;
export const FRAME_walk01 = 30;
export const FRAME_walk02 = 31;
export const FRAME_walk03 = 32;
export const FRAME_walk04 = 33;
export const FRAME_walk05 = 34;
export const FRAME_walk06 = 35;
export const FRAME_walk07 = 36;
export const FRAME_walk08 = 37;
export const FRAME_walk09 = 38;
export const FRAME_walk10 = 39;
export const FRAME_walk11 = 40;
export const FRAME_walk12 = 41;
export const FRAME_walk13 = 42;
export const FRAME_walk14 = 43;
export const FRAME_walk15 = 44;
export const FRAME_walk16 = 45;
export const FRAME_walk17 = 46;
export const FRAME_walk18 = 47;
export const FRAME_walk19 = 48;
export const FRAME_walk20 = 49;
export const FRAME_walk21 = 50;
export const FRAME_walk22 = 51;
export const FRAME_walk23 = 52;
export const FRAME_walk24 = 53;
export const FRAME_walk25 = 54;
export const FRAME_attak101 = 55;
export const FRAME_attak102 = 56;
export const FRAME_attak103 = 57;
export const FRAME_attak104 = 58;
export const FRAME_attak105 = 59;
export const FRAME_attak106 = 60;
export const FRAME_attak107 = 61;
export const FRAME_attak108 = 62;
export const FRAME_attak109 = 63;
export const FRAME_attak110 = 64;
export const FRAME_attak111 = 65;
export const FRAME_attak112 = 66;
export const FRAME_attak113 = 67;
export const FRAME_attak114 = 68;
export const FRAME_attak115 = 69;
export const FRAME_attak116 = 70;
export const FRAME_attak117 = 71;
export const FRAME_attak118 = 72;
export const FRAME_attak119 = 73;
export const FRAME_attak120 = 74;
export const FRAME_attak121 = 75;
export const FRAME_attak122 = 76;
export const FRAME_attak201 = 77;
export const FRAME_attak202 = 78;
export const FRAME_attak203 = 79;
export const FRAME_attak204 = 80;
export const FRAME_attak205 = 81;
export const FRAME_attak206 = 82;
export const FRAME_attak207 = 83;
export const FRAME_attak208 = 84;
export const FRAME_attak209 = 85;
export const FRAME_attak210 = 86;
export const FRAME_attak211 = 87;
export const FRAME_attak212 = 88;
export const FRAME_attak213 = 89;
export const FRAME_attak214 = 90;
export const FRAME_attak215 = 91;
export const FRAME_attak216 = 92;
export const FRAME_attak217 = 93;
export const FRAME_attak218 = 94;
export const FRAME_attak219 = 95;
export const FRAME_attak220 = 96;
export const FRAME_attak221 = 97;
export const FRAME_attak222 = 98;
export const FRAME_attak223 = 99;
export const FRAME_attak224 = 100;
export const FRAME_attak225 = 101;
export const FRAME_attak226 = 102;
export const FRAME_attak227 = 103;
export const FRAME_attak228 = 104;
export const FRAME_attak229 = 105;
export const FRAME_attak230 = 106;
export const FRAME_attak231 = 107;
export const FRAME_attak232 = 108;
export const FRAME_attak233 = 109;
export const FRAME_attak234 = 110;
export const FRAME_attak235 = 111;
export const FRAME_attak236 = 112;
export const FRAME_attak237 = 113;
export const FRAME_attak238 = 114;
export const FRAME_attak301 = 115;
export const FRAME_attak302 = 116;
export const FRAME_attak303 = 117;
export const FRAME_attak304 = 118;
export const FRAME_attak305 = 119;
export const FRAME_attak306 = 120;
export const FRAME_attak307 = 121;
export const FRAME_attak308 = 122;
export const FRAME_attak309 = 123;
export const FRAME_attak310 = 124;
export const FRAME_attak311 = 125;
export const FRAME_attak312 = 126;
export const FRAME_attak313 = 127;
export const FRAME_attak314 = 128;
export const FRAME_attak315 = 129;
export const FRAME_attak316 = 130;
export const FRAME_attak317 = 131;
export const FRAME_attak318 = 132;
export const FRAME_attak319 = 133;
export const FRAME_attak320 = 134;
export const FRAME_attak321 = 135;
export const FRAME_attak322 = 136;
export const FRAME_attak323 = 137;
export const FRAME_attak324 = 138;
export const FRAME_attak325 = 139;
export const FRAME_attak326 = 140;
export const FRAME_attak327 = 141;
export const FRAME_attak328 = 142;
export const FRAME_attak329 = 143;
export const FRAME_attak330 = 144;
export const FRAME_attak331 = 145;
export const FRAME_attak332 = 146;
export const FRAME_attak333 = 147;
export const FRAME_attak334 = 148;
export const FRAME_attak335 = 149;
export const FRAME_attak336 = 150;
export const FRAME_attak337 = 151;
export const FRAME_attak338 = 152;
export const FRAME_attak339 = 153;
export const FRAME_attak340 = 154;
export const FRAME_attak341 = 155;
export const FRAME_attak342 = 156;
export const FRAME_attak343 = 157;
export const FRAME_attak344 = 158;
export const FRAME_attak345 = 159;
export const FRAME_attak346 = 160;
export const FRAME_attak347 = 161;
export const FRAME_attak348 = 162;
export const FRAME_attak349 = 163;
export const FRAME_attak350 = 164;
export const FRAME_attak351 = 165;
export const FRAME_attak352 = 166;
export const FRAME_attak353 = 167;
export const FRAME_attak401 = 168;
export const FRAME_attak402 = 169;
export const FRAME_attak403 = 170;
export const FRAME_attak404 = 171;
export const FRAME_attak405 = 172;
export const FRAME_attak406 = 173;
export const FRAME_attak407 = 174;
export const FRAME_attak408 = 175;
export const FRAME_attak409 = 176;
export const FRAME_attak410 = 177;
export const FRAME_attak411 = 178;
export const FRAME_attak412 = 179;
export const FRAME_attak413 = 180;
export const FRAME_attak414 = 181;
export const FRAME_attak415 = 182;
export const FRAME_attak416 = 183;
export const FRAME_attak417 = 184;
export const FRAME_attak418 = 185;
export const FRAME_attak419 = 186;
export const FRAME_attak420 = 187;
export const FRAME_attak421 = 188;
export const FRAME_attak422 = 189;
export const FRAME_attak423 = 190;
export const FRAME_attak424 = 191;
export const FRAME_attak425 = 192;
export const FRAME_attak426 = 193;
export const FRAME_attak427 = 194;
export const FRAME_attak428 = 195;
export const FRAME_attak429 = 196;
export const FRAME_pain101 = 197;
export const FRAME_pain102 = 198;
export const FRAME_pain103 = 199;
export const FRAME_pain104 = 200;
export const FRAME_pain201 = 201;
export const FRAME_pain202 = 202;
export const FRAME_pain203 = 203;
export const FRAME_pain204 = 204;
export const FRAME_pain205 = 205;
export const FRAME_pain301 = 206;
export const FRAME_pain302 = 207;
export const FRAME_pain303 = 208;
export const FRAME_pain304 = 209;
export const FRAME_pain305 = 210;
export const FRAME_pain306 = 211;
export const FRAME_pain307 = 212;
export const FRAME_pain308 = 213;
export const FRAME_pain309 = 214;
export const FRAME_pain310 = 215;
export const FRAME_pain311 = 216;
export const FRAME_pain312 = 217;
export const FRAME_pain313 = 218;
export const FRAME_pain314 = 219;
export const FRAME_pain315 = 220;
export const FRAME_pain316 = 221;
export const FRAME_death101 = 222;
export const FRAME_death102 = 223;
export const FRAME_death103 = 224;
export const FRAME_death104 = 225;
export const FRAME_death105 = 226;
export const FRAME_death106 = 227;
export const FRAME_death107 = 228;
export const FRAME_death108 = 229;
export const FRAME_death109 = 230;
export const FRAME_death110 = 231;
export const FRAME_death111 = 232;
export const FRAME_death112 = 233;
export const FRAME_death113 = 234;
export const FRAME_death114 = 235;
export const FRAME_death115 = 236;
export const FRAME_death116 = 237;
export const FRAME_death117 = 238;
export const FRAME_death118 = 239;
export const FRAME_death119 = 240;
export const FRAME_death120 = 241;
export const FRAME_death121 = 242;
export const FRAME_death122 = 243;
export const FRAME_death123 = 244;
export const FRAME_death124 = 245;
export const FRAME_death125 = 246;
export const FRAME_death126 = 247;
export const FRAME_death127 = 248;
export const FRAME_death128 = 249;
export const FRAME_death129 = 250;
export const FRAME_death130 = 251;
export const FRAME_death131 = 252;
export const FRAME_death132 = 253;
export const FRAME_recln101 = 254;
export const FRAME_recln102 = 255;
export const FRAME_recln103 = 256;
export const FRAME_recln104 = 257;
export const FRAME_recln105 = 258;
export const FRAME_recln106 = 259;
export const FRAME_recln107 = 260;
export const FRAME_recln108 = 261;
export const FRAME_recln109 = 262;
export const FRAME_recln110 = 263;
export const FRAME_recln111 = 264;
export const FRAME_recln112 = 265;
export const FRAME_recln113 = 266;
export const FRAME_recln114 = 267;
export const FRAME_recln115 = 268;
export const FRAME_recln116 = 269;
export const FRAME_recln117 = 270;
export const FRAME_recln118 = 271;
export const FRAME_recln119 = 272;
export const FRAME_recln120 = 273;
export const FRAME_recln121 = 274;
export const FRAME_recln122 = 275;
export const FRAME_recln123 = 276;
export const FRAME_recln124 = 277;
export const FRAME_recln125 = 278;
export const FRAME_recln126 = 279;
export const FRAME_recln127 = 280;
export const FRAME_recln128 = 281;
export const FRAME_recln129 = 282;
export const FRAME_recln130 = 283;
export const FRAME_recln131 = 284;
export const FRAME_recln132 = 285;
export const FRAME_recln133 = 286;
export const FRAME_recln134 = 287;
export const FRAME_recln135 = 288;
export const FRAME_recln136 = 289;
export const FRAME_recln137 = 290;
export const FRAME_recln138 = 291;
export const FRAME_recln139 = 292;
export const FRAME_recln140 = 293;

export const MODEL_SCALE = 1.0;

const SPAWNFLAG_TANK_COMMANDER_GUARDIAN: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_TANK_COMMANDER_HEAT_SEEKING: SpawnFlags = SpawnFlags_from(16);

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

function cvarOrDefault(name: string, defaultValue: string): { value: number } {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
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

let sound_thud = 0;
let sound_pain = 0;
let sound_pain2 = 0;
let sound_idle = 0;
let sound_die = 0;
let sound_step = 0;
let sound_sight = 0;
let sound_windup = 0;
let sound_strike = 0;

// ---------------------------------------------------------------------------
// misc (m_tank.cpp:31-58)
// ---------------------------------------------------------------------------

const tank_sight = RegisterMonsterinfoSight("tank_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
});

function tank_footstep(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_step, 1, ATTN_NORM, 0);
}

function tank_thud(self: EdictT): void {
  gi.sound(self, CHAN_BODY, sound_thud, 1, ATTN_NORM, 0);
}

function tank_windup(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_windup, 1, ATTN_NORM, 0);
}

const tank_idle = RegisterMonsterinfoIdle("tank_idle", (self: EdictT): void => {
  gi.sound(self, CHAN_VOICE, sound_idle, 1, ATTN_IDLE, 0);
});

// ---------------------------------------------------------------------------
// stand (m_tank.cpp:64-101)
// ---------------------------------------------------------------------------

const tank_frames_stand: MframeT[] = Array.from({ length: 30 }, () => frame(ai_stand));
const tank_move_stand = RegisterMmove("tank_move_stand", move(FRAME_stand01, FRAME_stand30, tank_frames_stand));

const tank_stand = RegisterMonsterinfoStand("tank_stand", (self: EdictT): void => {
  M_SetAnimation(self, tank_move_stand, true);
});

// ---------------------------------------------------------------------------
// walk (m_tank.cpp:103-153) -- forward-referenced, see file header
// m_tank.cpp:109-117's `#if 0`-guarded tank_move_start_walk is dropped.
// ---------------------------------------------------------------------------

function tank_walk(self: EdictT): void {
  M_SetAnimation(self, tank_move_walk, true);
}

const tank_frames_walk: MframeT[] = [
  frame(ai_walk, 4),
  frame(ai_walk, 5),
  frame(ai_walk, 3),
  frame(ai_walk, 2),
  frame(ai_walk, 5),
  frame(ai_walk, 5),
  frame(ai_walk, 4),
  frame(ai_walk, 4, tank_footstep),
  frame(ai_walk, 3),
  frame(ai_walk, 5),
  frame(ai_walk, 4),
  frame(ai_walk, 5),
  frame(ai_walk, 7),
  frame(ai_walk, 7),
  frame(ai_walk, 6),
  frame(ai_walk, 6, tank_footstep),
];
const tank_move_walk = RegisterMmove("tank_move_walk", move(FRAME_walk05, FRAME_walk20, tank_frames_walk));

// m_tank.cpp:139-148's `#if 0`-guarded tank_move_stop_walk is dropped.

const tank_walk_registered = RegisterMonsterinfoWalk("tank_walk", tank_walk);

// ---------------------------------------------------------------------------
// run (m_tank.cpp:155-222) -- forward-referenced, see file header
// ---------------------------------------------------------------------------

function tank_run(self: EdictT): void {
  if (self.enemy !== null && self.enemy.client !== null) self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BRUTAL;
  else self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BRUTAL;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, tank_move_stand, true);
    return;
  }

  if (self.monsterinfo.active_move === tank_move_walk || self.monsterinfo.active_move === tank_move_start_run) {
    M_SetAnimation(self, tank_move_run, true);
  } else {
    M_SetAnimation(self, tank_move_start_run, true);
  }
}

const tank_frames_start_run: MframeT[] = [frame(ai_run), frame(ai_run, 6), frame(ai_run, 6), frame(ai_run, 11, tank_footstep)];
const tank_move_start_run = RegisterMmove("tank_move_start_run", move(FRAME_walk01, FRAME_walk04, tank_frames_start_run, tank_run));

const tank_frames_run: MframeT[] = [
  frame(ai_run, 4),
  frame(ai_run, 5),
  frame(ai_run, 3),
  frame(ai_run, 2),
  frame(ai_run, 5),
  frame(ai_run, 5),
  frame(ai_run, 4),
  frame(ai_run, 4, tank_footstep),
  frame(ai_run, 3),
  frame(ai_run, 5),
  frame(ai_run, 4),
  frame(ai_run, 5),
  frame(ai_run, 7),
  frame(ai_run, 7),
  frame(ai_run, 6),
  frame(ai_run, 6, tank_footstep),
];
const tank_move_run = RegisterMmove("tank_move_run", move(FRAME_walk05, FRAME_walk20, tank_frames_run));

// m_tank.cpp:189-198's `#if 0`-guarded tank_move_stop_run is dropped.

const tank_run_registered = RegisterMonsterinfoRun("tank_run", tank_run);

// ---------------------------------------------------------------------------
// pain (m_tank.cpp:224-306)
// ---------------------------------------------------------------------------

const tank_frames_pain1: MframeT[] = Array.from({ length: 4 }, () => frame(ai_move));
const tank_move_pain1 = RegisterMmove("tank_move_pain1", move(FRAME_pain101, FRAME_pain104, tank_frames_pain1, tank_run));

const tank_frames_pain2: MframeT[] = Array.from({ length: 5 }, () => frame(ai_move));
const tank_move_pain2 = RegisterMmove("tank_move_pain2", move(FRAME_pain201, FRAME_pain205, tank_frames_pain2, tank_run));

const tank_frames_pain3: MframeT[] = [
  frame(ai_move, -7),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 3),
  frame(ai_move),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, tank_footstep),
];
const tank_move_pain3 = RegisterMmove("tank_move_pain3", move(FRAME_pain301, FRAME_pain316, tank_frames_pain3, tank_run));

const tank_pain = RegisterPain("tank_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (mod.id !== ModIdT.MOD_CHAINFIST && damage <= 10) return;

  if (level.time < self.pain_debounce_time) return;

  if (mod.id !== ModIdT.MOD_CHAINFIST) {
    if (damage <= 30 && frandom() > 0.2) return;

    // don't go into pain while attacking
    if (self.s.frame >= FRAME_attak301 && self.s.frame <= FRAME_attak330) return;
    if (self.s.frame >= FRAME_attak101 && self.s.frame <= FRAME_attak116) return;
  }

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (self.count) gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  // PMM - blindfire cleanup
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
  // pmm

  if (damage <= 30) M_SetAnimation(self, tank_move_pain1, true);
  else if (damage <= 60) M_SetAnimation(self, tank_move_pain2, true);
  else M_SetAnimation(self, tank_move_pain3, true);
});

const tank_setskin = RegisterMonsterinfoSetskin("tank_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
});

// ---------------------------------------------------------------------------
// [Paril-KEX] blindfire target adjustment (m_tank.cpp:316-351)
// ---------------------------------------------------------------------------

function M_AdjustBlindfireTarget(self: EdictT, start: Vec3, target: Vec3, right: Vec3, outDir: Vec3): boolean {
  let trace = gi.trace(start, null, null, target, self, MASK_PROJECTILE);

  // blindfire has different fail criteria for the trace
  if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
    VectorCopy(vec3_normalized(vec3_sub(target, start)), outDir);
    return true;
  }

  // try shifting the target to the left a little (to help counter large offset)
  const left_target = vec3_sub(target, vec3_muls(right, 20));
  trace = gi.trace(start, null, null, left_target, self, MASK_PROJECTILE);

  if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
    VectorCopy(vec3_normalized(vec3_sub(left_target, start)), outDir);
    return true;
  }

  // ok, that failed. try to the right
  const right_target = vec3_add(target, vec3_muls(right, 20));
  trace = gi.trace(start, null, null, right_target, self, MASK_PROJECTILE);
  if (!(trace.startsolid || trace.allsolid || trace.fraction < 0.5)) {
    VectorCopy(vec3_normalized(vec3_sub(right_target, start)), outDir);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// attacks (m_tank.cpp:353-542)
// ---------------------------------------------------------------------------

function TankBlaster(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const blindfire = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n;

  let flash_number: MonsterMuzzleflashIdT;
  if (self.s.frame === FRAME_attak110) flash_number = MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1;
  else if (self.s.frame === FRAME_attak113) flash_number = MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_2;
  else flash_number = MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_3;

  const { forward, right } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  // pmm - blindfire support
  const dir = vec3();

  // PMM
  if (blindfire) {
    const target = self.monsterinfo.blind_fire_target;
    if (!M_AdjustBlindfireTarget(self, start, target, right, dir)) return;
  } else {
    PredictAim(self, self.enemy, start, 0, false, 0, dir, null);
  }
  // pmm

  monster_fire_blaster(self, start, dir, 30, 800, flash_number, EffectsT.EF_BLASTER);
}

function TankStrike(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_strike, 1, ATTN_NORM, 0);
}

function TankRocket(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const blindfire = (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n;

  let flash_number: MonsterMuzzleflashIdT;
  if (self.s.frame === FRAME_attak324) flash_number = MonsterMuzzleflashIdT.MZ2_TANK_ROCKET_1;
  else if (self.s.frame === FRAME_attak327) flash_number = MonsterMuzzleflashIdT.MZ2_TANK_ROCKET_2;
  else flash_number = MonsterMuzzleflashIdT.MZ2_TANK_ROCKET_3;

  const { forward, right } = AngleVectors_destructured(self.s.angles);

  // [Paril-KEX] scale
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  let rocketSpeed: number;
  if (self.speed) rocketSpeed = self.speed;
  else if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TANK_COMMANDER_HEAT_SEEKING)) rocketSpeed = 500;
  else rocketSpeed = 650;

  // PMM
  const target = blindfire ? self.monsterinfo.blind_fire_target : self.enemy.s.origin;
  // pmm

  let vec: Vec3;
  let dir: Vec3;

  // PGM
  // PMM - blindfire shooting
  if (blindfire) {
    vec = vec3(target[0], target[1], target[2]);
    dir = vec3_sub(vec, start);
  }
  // pmm
  // don't shoot at feet if they're above me.
  else if (frandom() < 0.66 || start[2] < self.enemy.absmin[2]) {
    vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
    vec[2] += self.enemy.viewheight;
    dir = vec3_sub(vec, start);
  } else {
    vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
    vec[2] = self.enemy.absmin[2] + 1;
    dir = vec3_sub(vec, start);
  }
  // PGM

  //======
  // PMM - lead target (not when blindfiring)
  // 20, 35, 50, 65 chance of leading
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  if (!blindfire && frandom() < 0.2 + (3 - skillInt) * 0.15) {
    const dirOut = vec3(dir[0], dir[1], dir[2]);
    PredictAim(self, self.enemy, start, rocketSpeed, false, 0, dirOut, vec);
    dir = dirOut;
  }
  // PMM - lead target
  //======

  dir = vec3_normalized(dir);

  // pmm blindfire doesn't check target (done in checkattack)
  // paranoia, make sure we're not shooting a target right next to us
  if (blindfire) {
    // blindfire has different fail criteria for the trace
    if (M_AdjustBlindfireTarget(self, start, vec, right, dir)) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TANK_COMMANDER_HEAT_SEEKING)) {
        monster_fire_heat(self, start, dir, 50, rocketSpeed, flash_number, self.accel);
      } else {
        monster_fire_rocket(self, start, dir, 50, rocketSpeed, flash_number);
      }
    }
  } else {
    const trace = gi.trace(start, null, null, vec, self, MASK_PROJECTILE);

    if (trace.fraction > 0.5 || trace.ent === null || trace.ent.solid !== SolidT.SOLID_BSP) {
      if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TANK_COMMANDER_HEAT_SEEKING)) {
        monster_fire_heat(self, start, dir, 50, rocketSpeed, flash_number, self.accel);
      } else {
        monster_fire_rocket(self, start, dir, 50, rocketSpeed, flash_number);
      }
    }
  }
}

function TankMachineGun(self: EdictT): void {
  if (self.enemy === null || !self.enemy.inuse) return; // PGM

  const flash_number: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_TANK_MACHINEGUN_1 + (self.s.frame - FRAME_attak406);

  const { forward: fwdSrc, right: rightSrc } = AngleVectors_destructured(self.s.angles);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], fwdSrc, rightSrc);

  const dir = vec3();
  if (self.enemy !== null) {
    const vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
    vec[2] += self.enemy.viewheight;
    const rel = vec3_sub(vec, start);
    const ang = vectoangles(rel);
    dir[0] = ang[0];
  } else {
    dir[0] = 0;
  }
  if (self.s.frame <= FRAME_attak415) dir[1] = self.s.angles[1] - 8 * (self.s.frame - FRAME_attak411);
  else dir[1] = self.s.angles[1] + 8 * (self.s.frame - FRAME_attak419);
  dir[2] = 0;

  const { forward } = AngleVectors_destructured(dir);

  monster_fire_bullet(self, start, forward, 20, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_number);
}

function tank_blind_check(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    const aim = vec3_sub(self.monsterinfo.blind_fire_target, self.s.origin);
    self.ideal_yaw = vectoyaw(aim);
  }
}

const tank_frames_attack_blast: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, -1),
  frame(ai_charge, -2),
  frame(ai_charge, -1),
  frame(ai_charge, -1, tank_blind_check),
  frame(ai_charge),
  frame(ai_charge, 0, TankBlaster), // 10
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, TankBlaster),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, TankBlaster), // 16
];
const tank_move_attack_blast = RegisterMmove(
  "tank_move_attack_blast",
  move(FRAME_attak101, FRAME_attak116, tank_frames_attack_blast, (self: EdictT): void => tank_reattack_blaster(self)),
);

const tank_frames_reattack_blast: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, TankBlaster),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, TankBlaster), // 16
];
const tank_move_reattack_blast = RegisterMmove(
  "tank_move_reattack_blast",
  move(FRAME_attak111, FRAME_attak116, tank_frames_reattack_blast, (self: EdictT): void => tank_reattack_blaster(self)),
);

const tank_frames_attack_post_blast: MframeT[] = [
  frame(ai_move), // 17
  frame(ai_move),
  frame(ai_move, 2),
  frame(ai_move, 3),
  frame(ai_move, 2),
  frame(ai_move, -2, tank_footstep), // 22
];
const tank_move_attack_post_blast = RegisterMmove(
  "tank_move_attack_post_blast",
  move(FRAME_attak117, FRAME_attak122, tank_frames_attack_post_blast, tank_run),
);

function tank_reattack_blaster(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    M_SetAnimation(self, tank_move_attack_post_blast, true);
    return;
  }

  if (self.enemy !== null && visible(self, self.enemy) && self.enemy.health > 0 && frandom() <= 0.6) {
    M_SetAnimation(self, tank_move_reattack_blast, true);
    return;
  }
  M_SetAnimation(self, tank_move_attack_post_blast, true);
}

function tank_poststrike(self: EdictT): void {
  self.enemy = null;
  // [Paril-KEX]
  self.monsterinfo.pausetime = HOLD_FOREVER;
  if (self.monsterinfo.stand !== null) self.monsterinfo.stand(self);
}

const tank_frames_attack_strike: MframeT[] = [
  frame(ai_move, 3),
  frame(ai_move, 2),
  frame(ai_move, 2),
  frame(ai_move, 1),
  frame(ai_move, 6),
  frame(ai_move, 7),
  frame(ai_move, 9, tank_footstep),
  frame(ai_move, 2),
  frame(ai_move, 1),
  frame(ai_move, 2),
  frame(ai_move, 2, tank_footstep),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, -2),
  frame(ai_move, -2),
  frame(ai_move, 0, tank_windup),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, TankStrike),
  frame(ai_move),
  frame(ai_move, -1),
  frame(ai_move, -1),
  frame(ai_move, -1),
  frame(ai_move, -1),
  frame(ai_move, -1),
  frame(ai_move, -3),
  frame(ai_move, -10),
  frame(ai_move, -10),
  frame(ai_move, -2),
  frame(ai_move, -3),
  frame(ai_move, -2, tank_footstep),
];
const tank_move_attack_strike = RegisterMmove(
  "tank_move_attack_strike",
  move(FRAME_attak201, FRAME_attak238, tank_frames_attack_strike, tank_poststrike),
);

const tank_frames_attack_pre_rocket: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge), // 10

  frame(ai_charge),
  frame(ai_charge, 1),
  frame(ai_charge, 2),
  frame(ai_charge, 7),
  frame(ai_charge, 7),
  frame(ai_charge, 7, tank_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge), // 20

  frame(ai_charge, -3),
];
const tank_move_attack_pre_rocket = RegisterMmove(
  "tank_move_attack_pre_rocket",
  move(FRAME_attak301, FRAME_attak321, tank_frames_attack_pre_rocket, (self: EdictT): void => tank_doattack_rocket(self)),
);

const tank_frames_attack_fire_rocket: MframeT[] = [
  frame(ai_charge, -3, tank_blind_check), // Loop Start	22
  frame(ai_charge),
  frame(ai_charge, 0, TankRocket), // 24
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, 0, TankRocket),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge, -1, TankRocket), // 30	Loop End
];
const tank_move_attack_fire_rocket = RegisterMmove(
  "tank_move_attack_fire_rocket",
  move(FRAME_attak322, FRAME_attak330, tank_frames_attack_fire_rocket, (self: EdictT): void => tank_refire_rocket(self)),
);

const tank_frames_attack_post_rocket: MframeT[] = [
  frame(ai_charge), // 31
  frame(ai_charge, -1),
  frame(ai_charge, -1),
  frame(ai_charge),
  frame(ai_charge, 2),
  frame(ai_charge, 3),
  frame(ai_charge, 4),
  frame(ai_charge, 2),
  frame(ai_charge),
  frame(ai_charge), // 40

  frame(ai_charge),
  frame(ai_charge, -9),
  frame(ai_charge, -8),
  frame(ai_charge, -7),
  frame(ai_charge, -1),
  frame(ai_charge, -1, tank_footstep),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge), // 50

  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const tank_move_attack_post_rocket = RegisterMmove(
  "tank_move_attack_post_rocket",
  move(FRAME_attak331, FRAME_attak353, tank_frames_attack_post_rocket, tank_run),
);

const tank_frames_attack_chain: MframeT[] = [
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  ...Array.from({ length: 19 }, () => frame(null, 0, TankMachineGun)),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
  frame(ai_charge),
];
const tank_move_attack_chain = RegisterMmove("tank_move_attack_chain", move(FRAME_attak401, FRAME_attak429, tank_frames_attack_chain, tank_run));

function tank_refire_rocket(self: EdictT): void {
  // PMM - blindfire cleanup
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    M_SetAnimation(self, tank_move_attack_post_rocket, true);
    return;
  }
  // pmm

  if (self.enemy !== null && self.enemy.health > 0 && visible(self, self.enemy) && frandom() <= 0.4) {
    M_SetAnimation(self, tank_move_attack_fire_rocket, true);
    return;
  }
  M_SetAnimation(self, tank_move_attack_post_rocket, true);
}

function tank_doattack_rocket(self: EdictT): void {
  M_SetAnimation(self, tank_move_attack_fire_rocket, true);
}

const tank_attack = RegisterMonsterinfoAttack("tank_attack", (self: EdictT): void => {
  // PMM
  if (self.enemy === null || !self.enemy.inuse) return;

  if (self.enemy.health <= 0) {
    M_SetAnimation(self, tank_move_attack_strike, true);
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BRUTAL;
    return;
  }

  // PMM
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
    // setup shot probabilities
    let chance: number;
    if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(1)) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(7.5)) chance = 0.4;
    else chance = 0.1;

    const r = frandom();

    self.monsterinfo.blind_fire_delay = Gtime_add(self.monsterinfo.blind_fire_delay, Gtime_add(Gtime_from_sec(5.2), random_time(Gtime_from_sec(3))));

    // don't shoot at the origin
    if (
      self.monsterinfo.blind_fire_target[0] === 0 &&
      self.monsterinfo.blind_fire_target[1] === 0 &&
      self.monsterinfo.blind_fire_target[2] === 0
    ) {
      return;
    }

    // don't shoot if the dice say not to
    if (r > chance) return;

    const rocket_visible = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_ROCKET_1]);
    const blaster_visible = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1]);

    if (!rocket_visible && !blaster_visible) return;

    const use_rocket = rocket_visible && blaster_visible ? brandom() : rocket_visible;

    // turn on manual steering to signal both manual steering and blindfire
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;

    if (use_rocket) {
      M_SetAnimation(self, tank_move_attack_fire_rocket, true);
    } else {
      M_SetAnimation(self, tank_move_attack_blast, true);
      self.monsterinfo.nextframe = FRAME_attak108;
    }

    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(3), Gtime_from_sec(5)));
    self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(5)); // no pain for a while
    return;
  }
  // pmm

  const vec = vec3_sub(self.enemy.s.origin, self.s.origin);
  const rangeVal = vec3_length(vec);

  const r = frandom();

  if (rangeVal <= 125) {
    const can_machinegun =
      (self.enemy.classname === null || self.enemy.classname !== "tesla_mine") &&
      M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_MACHINEGUN_5]);

    if (can_machinegun && r < 0.5) M_SetAnimation(self, tank_move_attack_chain, true);
    else if (M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1])) M_SetAnimation(self, tank_move_attack_blast, true);
  } else if (rangeVal <= 250) {
    const can_machinegun =
      (self.enemy.classname === null || self.enemy.classname !== "tesla_mine") &&
      M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_MACHINEGUN_5]);

    if (can_machinegun && r < 0.25) M_SetAnimation(self, tank_move_attack_chain, true);
    else if (M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1])) M_SetAnimation(self, tank_move_attack_blast, true);
  } else {
    const can_machinegun = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_MACHINEGUN_5]);
    const can_rocket = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_ROCKET_1]);

    if (can_machinegun && r < 0.33) {
      M_SetAnimation(self, tank_move_attack_chain, true);
    } else if (can_rocket && r < 0.66) {
      M_SetAnimation(self, tank_move_attack_pre_rocket, true);
      self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(5)); // no pain for a while
    } else if (M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1])) {
      M_SetAnimation(self, tank_move_attack_blast, true);
    }
  }
});

// ---------------------------------------------------------------------------
// death (m_tank.cpp:897-1017)
// ---------------------------------------------------------------------------

function tank_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -16);
  self.maxs = vec3(16, 16, -0);
  monster_dead(self);
}

function tank_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const tank_frames_death1: MframeT[] = [
  frame(ai_move, -7),
  frame(ai_move, -2),
  frame(ai_move, -2),
  frame(ai_move, 1),
  frame(ai_move, 3),
  frame(ai_move, 6),
  frame(ai_move, 1),
  frame(ai_move, 1),
  frame(ai_move, 2),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, -2),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, -3),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, -4),
  frame(ai_move, -6),
  frame(ai_move, -4),
  frame(ai_move, -5),
  frame(ai_move, -7, tank_shrink),
  frame(ai_move, -15, tank_thud),
  frame(ai_move, -5),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
];
const tank_move_death = RegisterMmove("tank_move_death", move(FRAME_death101, FRAME_death132, tank_frames_death1, tank_dead));

const tank_die = RegisterDie(
  "tank_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

      self.s.skinnum = Math.trunc(self.s.skinnum / 2);

      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/sm_meat/tris.md2" },
        { gibname: "models/objects/gibs/sm_metal/tris.md2", count: 3, type: GibTypeT.GIB_METALLIC },
        { gibname: "models/objects/gibs/gear/tris.md2", type: GibTypeT.GIB_METALLIC },
        { gibname: "models/monsters/tank/gibs/foot.md2", count: 2, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC },
        { gibname: "models/monsters/tank/gibs/thigh.md2", count: 2, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC },
        { gibname: "models/monsters/tank/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
        { gibname: "models/monsters/tank/gibs/head.md2", type: GibTypeT.GIB_HEAD | GibTypeT.GIB_SKINNED },
      ];
      ThrowGibs(self, damage, gibs);

      if (!self.style) {
        ThrowGib(self, "models/monsters/tank/gibs/barm.md2", damage, GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT, self.s.scale);
      }

      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    // [Paril-KEX] dropped arm
    if (!self.style) {
      self.style = 1;

      const { right: rgt, up } = AngleVectors_destructured(self.s.angles);

      const arm_gib = ThrowGib(self, "models/monsters/tank/gibs/barm.md2", damage, GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT, self.s.scale);
      if (arm_gib !== null) {
        arm_gib.s.origin = vec3(
          self.s.origin[0] + rgt[0] * -16 + up[0] * 23,
          self.s.origin[1] + rgt[1] * -16 + up[1] * 23,
          self.s.origin[2] + rgt[2] * -16 + up[2] * 23,
        );
        arm_gib.s.old_origin = vec3(arm_gib.s.origin[0], arm_gib.s.origin[1], arm_gib.s.origin[2]);
        arm_gib.avelocity = vec3(crandom() * 15, crandom() * 15, 180);
        arm_gib.velocity = vec3(up[0] * 100 + rgt[0] * -120, up[1] * 100 + rgt[1] * -120, up[2] * 100 + rgt[2] * -120);
        arm_gib.s.angles = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
        arm_gib.s.angles[2] = -90;
        arm_gib.s.skinnum = Math.trunc(arm_gib.s.skinnum / 2);
        gi.linkentity(arm_gib);
      }
    }

    // regular death
    gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;

    M_SetAnimation(self, tank_move_death, true);
  },
);

// ===========
// PGM
const tank_blocked = RegisterMonsterinfoBlocked("tank_blocked", (self: EdictT, dist: number): boolean => {
  return blocked_checkplat(self, dist);
});
// PGM
// ===========

// ---------------------------------------------------------------------------
// monster_tank / monster_tank_commander (m_tank.cpp:1018-1117)
// ---------------------------------------------------------------------------

/**
 * QUAKED monster_tank (1 .5 0) (-32 -32 -16) (32 32 72) Ambush Trigger_Spawn
 * Sight
 * model="models/monsters/tank/tris.md2"
 *
 * QUAKED monster_tank_commander (1 .5 0) (-32 -32 -16) (32 32 72) Ambush
 * Trigger_Spawn Sight Guardian HeatSeeking
 */
export function SP_monster_tank(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.s.modelindex = gi.modelindex("models/monsters/tank/tris.md2");
  self.mins = vec3(-32, -32, -16);
  self.maxs = vec3(32, 32, 64);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  gi.modelindex("models/monsters/tank/gibs/barm.md2");
  gi.modelindex("models/monsters/tank/gibs/head.md2");
  gi.modelindex("models/monsters/tank/gibs/chest.md2");
  gi.modelindex("models/monsters/tank/gibs/foot.md2");
  gi.modelindex("models/monsters/tank/gibs/thigh.md2");

  sound_thud = gi.soundindex("tank/tnkdeth2.wav");
  sound_idle = gi.soundindex("tank/tnkidle1.wav");
  sound_die = gi.soundindex("tank/death.wav");
  sound_step = gi.soundindex("tank/step.wav");
  sound_windup = gi.soundindex("tank/tnkatck4.wav");
  sound_strike = gi.soundindex("tank/tnkatck5.wav");
  sound_sight = gi.soundindex("tank/sight1.wav");

  gi.soundindex("tank/tnkatck1.wav");
  gi.soundindex("tank/tnkatk2a.wav");
  gi.soundindex("tank/tnkatk2b.wav");
  gi.soundindex("tank/tnkatk2c.wav");
  gi.soundindex("tank/tnkatk2d.wav");
  gi.soundindex("tank/tnkatk2e.wav");
  gi.soundindex("tank/tnkatck3.wav");

  if (self.classname === "monster_tank_commander") {
    self.health = Math.trunc(1000 * st.health_multiplier);
    self.gib_health = -225;
    self.count = 1;
    sound_pain2 = gi.soundindex("tank/pain.wav");
  } else {
    self.health = Math.trunc(750 * st.health_multiplier);
    self.gib_health = -200;
    sound_pain = gi.soundindex("tank/tnkpain2.wav");
  }

  self.monsterinfo.scale = MODEL_SCALE;

  // [Paril-KEX] N64 tank commander is a chonky boy
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_TANK_COMMANDER_GUARDIAN)) {
    if (!self.s.scale) self.s.scale = 1.5;
    self.health = Math.trunc(1500 * st.health_multiplier);
  }

  // heat seekingness
  if (!self.accel) self.accel = 0.075;

  self.mass = 500;

  self.pain = tank_pain;
  self.die = tank_die;
  self.monsterinfo.stand = tank_stand;
  self.monsterinfo.walk = tank_walk_registered;
  self.monsterinfo.run = tank_run_registered;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = tank_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = tank_sight;
  self.monsterinfo.idle = tank_idle;
  self.monsterinfo.blocked = tank_blocked; // PGM
  self.monsterinfo.setskin = tank_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, tank_move_stand, true);

  walkmonster_start(self);

  // PMM
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;
  self.monsterinfo.blindfire = true;
  // pmm
  if (self.classname === "monster_tank_commander") self.s.skinnum = 2;
}

// ---------------------------------------------------------------------------
// monster_tank_stand / Think_TankStand (m_tank.cpp:1119-1164) -- N64-only
// decorative easter egg. See file header for Use_Boss3's out-of-scope stub.
// ---------------------------------------------------------------------------

/** `void Use_Boss3(edict_t*, edict_t*, edict_t*);` -- see file header. */
const Use_Boss3: UseFn = RegisterUse("Use_Boss3", (_ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  throw new Error("Use_Boss3: not yet ported (belongs to a future m_boss3.ts unit, see m_tank.cpp:1119)");
});

const Think_TankStand: ThinkFn = RegisterThink("Think_TankStand", (ent: EdictT): void => {
  if (ent.s.frame === FRAME_stand30) ent.s.frame = FRAME_stand01;
  else ent.s.frame++;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/**
 * QUAKED monster_tank_stand (1 .5 0) (-32 -32 0) (32 32 90)
 *
 * Just stands and cycles in one place until targeted, then teleports away.
 * N64 edition!
 */
export function SP_monster_tank_stand(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/tank/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.s.frame = FRAME_stand01;
  self.s.skinnum = 2;

  gi.soundindex("misc/bigtele.wav");

  self.mins = vec3(-32, -32, -16);
  self.maxs = vec3(32, 32, 64);

  if (!self.s.scale) self.s.scale = 1.5;

  self.mins = vec3_muls(self.mins, self.s.scale);
  self.maxs = vec3_muls(self.maxs, self.s.scale);

  self.use = Use_Boss3;
  self.think = Think_TankStand;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  gi.linkentity(self);
}
