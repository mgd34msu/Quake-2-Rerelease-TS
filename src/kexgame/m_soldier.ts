// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_soldier.c -- the SOLDIER monster family (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_soldier.cpp (2,049 lines) +
// m_soldier.h (585 lines, frame-index enum + MODEL_SCALE), C++17. Behavioral
// code, ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/g_ai.ts headers). Six spawn variants share one frame set and
// two parallel weapon-fire implementations (base/"vanilla" and the
// KEX-merged xatrix "h"/RAFAEL variant, selected at runtime by
// `self.style`): SP_monster_soldier_light, SP_monster_soldier,
// SP_monster_soldier_ss (vanilla weapons: blaster/shotgun/machinegun), and
// SP_monster_soldier_ripper/hypergun/lasergun (xatrix weapons:
// ionripper/blueblaster/dabeam-laser). SP_monster_soldier_vanilla is also
// ported (unreferenced by g_spawn.ts today, kept for source fidelity -- a
// thin `SP_monster_soldier_x` alias, matching the C++'s own dead-code-ish
// wrapper).
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED, AND HOW EACH IS HANDLED
// ============================================================================
// m_soldier.cpp calls into three generic systems that have no home yet
// anywhere in this port line's landed kexgame modules. None of g_ai.ts,
// g_monster.ts, or g_combat.ts declare them (confirmed by grep before
// writing this file), so each is ported LOCALLY here rather than imported.
//
// (1) THE ROGUE "NEW AI" DODGE/DUCK SYSTEM (rogue/g_rogue_newai.cpp) --
//     ported as REAL logic, not stubs. `self.monsterinfo.dodge =
//     M_MonsterDodge` is wired unconditionally in `SP_monster_soldier_x`,
//     and `M_MonsterDodge` is ALREADY called unconditionally from a real,
//     landed call site (`g_monster.ts`'s pain-processing path, `M_ProcessPain`
//     -> `self.monsterinfo.dodge(self, ent.owner, eta, tr, ...)` whenever a
//     bounce/toss projectile causes pain) -- exactly the "a stub that breaks
//     every caller isn't a stub, it's a landmine" situation g_ai.ts's own
//     header already establishes a precedent for (its narrowly-real
//     `monsterlost_checkhint`). A throwing stub here would make every
//     soldier that takes grenade splash damage crash. Ported instead,
//     faithfully, as local (unexported) functions, each duplicated verbatim
//     from its C++ source (not imported -- g_rogue_newai.ts does not exist
//     in this port line; matches the established "duplicated per-file, not
//     imported" convention already used by g_turret.ts's/g_phys.ts's own
//     local helpers):
//       - `blocked_checkplat(self, dist)` -- rogue/g_rogue_newai.cpp:14-88.
//       - `monster_done_dodge(self)` -- rogue/g_rogue_newai.cpp:97-103.
//       - `monster_duck_down(self)` -- rogue/g_rogue_newai.cpp:1424-1432.
//       - `monster_duck_hold(self)` -- rogue/g_rogue_newai.cpp:1434-1439.
//       - `monster_duck_up(self)` (MONSTERINFO_UNDUCK) --
//         rogue/g_rogue_newai.cpp:1442-1451.
//       - `G_SkillCheck(skills)` -- rogue/g_rogue_newai.cpp:1291-1299, a
//         tiny helper used once inside `M_MonsterDodge`.
//       - `M_MonsterDodge` (MONSTERINFO_DODGE) --
//         rogue/g_rogue_newai.cpp:1304-1422.
//     The generic CALLER that normally drives a monster into its
//     duck/attack3/attack5/trip animation chain in the first place (the
//     part of `M_MonsterDodge` that invokes `self.monsterinfo.duck(self,
//     eta)`) is itself real and ported below -- so once a real projectile
//     eta triggers it, `soldier_duck`'s animations are genuinely reachable,
//     not dead code.
// (2) TWO TRIVIAL `inline` FUNCTIONS FROM g_local.h (placement-mismatch,
//     same treatment g_monster.ts's own header documents for
//     `gi.traceline`): `monster_footstep(self)` (g_local.h:3281-3286) and
//     `M_CheckGib(self, mod)` (g_local.h:3521-3529). Ported locally,
//     verbatim, unexported.
// (3) XATRIX MISSION-PACK WEAPON PRIMITIVES (xatrix/g_xatrix_monster.cpp,
//     xatrix/g_xatrix_weapon.cpp, rogue/g_rogue_newai.cpp's `PredictAim`) --
//     `monster_fire_ionripper`, `monster_fire_blueblaster`, and
//     `monster_fire_dabeam`/`dabeam_update`: STUB SWAP (xatrix unit) --
//     g_xatrix_monster.ts has now landed as the real home of all four. The
//     local throwing stubs that used to live here are DELETED and replaced
//     with an import from "./g_xatrix_monster". `soldier_fire_xatrix`'s
//     ionripper/hyperblaster/laserbeam branches (reached only when
//     `self.style === 1`, the three xatrix-styled spawns:
//     SP_monster_soldier_ripper/hypergun/lasergun, on that specific weapon's
//     `self.count` bucket) now genuinely fire: `soldierh_laser_update`
//     (already ported for real below, unchanged) is no longer dead code.
//     `PredictAim` (rogue/g_rogue_newai.cpp, NOT xatrix) is untouched by
//     THIS swap -- it was already converted to a real import from
//     "./m_supertank" by an earlier change in this file (see this file's own
//     "PREDICTAIM SIGNATURE FIX" note below), out of this xatrix unit's
//     scope either way.
//
// ============================================================================
// FORWARD-DECLARED C++ FUNCTIONS -> TS HOISTED `function` DECLARATIONS
// ============================================================================
// The C++ source forward-declares `soldier_stand`/`soldier_run` (and relies
// on `extern const mmove_t soldier_move_trip;`) so its frame tables can
// reference an endfunc/table defined later in the file. TS has no function-
// pointer forward declaration, but plain `function` declarations (not
// `const ... = arrow`) are hoisted with their full body, so every handler
// below is written as `function name(...) {}` (or `export function` for the
// six required SP_* names and every mmove/handler this file's own test
// contract requires) rather than the `const x: XxxFn = RegisterXxx(...)`
// idiom other landed files use for handlers with no forward-reference need.
// Each `RegisterXxx("name", name)` call is a separate statement (its return
// value equals its input -- confirmed by reading g_save_registry.ts's
// `register()` -- so this is purely the save-registry side effect, safe to
// leave unused). `const` `MmoveT` tables referenced only INSIDE a function
// BODY (e.g. `soldier_move_trip` referenced inside `soldier_stand_up`) need
// no such treatment: body references are evaluated at call time, long after
// module evaluation (and thus every top-level `const`) has finished.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - Vec3 arithmetic chains (`end = start + forward*8192; end += right*r; ...`)
//   use q_vec3.ts's functional `vec3_add`/`vec3_sub`/`vec3_muls` helpers
//   (each returns a new Vec3), not the C++ operator overloads.
// - `blocked_checkplat`'s `strncmp(classname, "func_plat", 8)` compares only
//   the first 8 of "func_plat"'s 9 characters (a pre-existing id-software
//   idiom, not a typo); ported as the equivalent 8-character slice
//   comparison rather than `.startsWith("func_plat")`, to stay byte-for-byte
//   faithful (the difference is unobservable in practice -- no other
//   classname shares an 8-character "func_pla" prefix).
// - `world` (C++ global, entity index 0) is `g_edicts[0]`, matching
//   g_target.ts's/g_monster.ts's own established idiom for the same
//   comparison.
// - `traceEdict`/`giTraceline` are per-file local duplicates of the
//   identical helpers in g_monster.ts/g_phys.ts/etc., matching this port
//   line's established "duplicated per-file, not imported" convention.
// - `cached_soundindex` fields (`sound_idle`, etc.) are plain `{ index: 0 }`
//   objects assigned via a local `assignSound` helper, matching
//   g_trigger.ts's own `windsound`/`windsoundAssign` precedent for the
//   identical C++ idiom.
// - `mkframe`/`mkMove` are small local builders for `MframeT`/`MmoveT`
//   (the latter wrapped in `RegisterMmove` at each call site), standing in
//   for the C++ `{ ... }` aggregate-initializer / `MMOVE_T(name) = { ... }`
//   macro syntax.

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import { AngleVectors, vectoangles, vectoyaw, vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalize, vec3_normalized, vec3_length, vec3_any_nonzero } from "./q_vec3";
import { fixedLength } from "../shared/fixed";
import { MonsterMuzzleflashIdT, SolidT, SoundchanT, KexEdictT, type KexTraceT, EffectsT, ContentsT, MASK_MONSTERSOLID, SvflagsT, CvarFlagsT, ATTN_NORM, ATTN_IDLE } from "../kexapi/game";
import { type CvarT } from "../shared/q_shared";
import {
  type EdictT,
  MovetypeT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  MoveStateT,
  RANGE_MELEE,
  RANGE_NEAR,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  random_time,
  DUCK_INTERVAL,
  GibTypeT,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import type { ModT } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn, ThinkFn, PrethinkFn, MonsterinfoStandFn, MonsterinfoWalkFn, MonsterinfoRunFn, MonsterinfoAttackFn, MonsterinfoSightFn, MonsterinfoSetskinFn, MonsterinfoBlockedFn, MonsterinfoDuckFn, MonsterinfoUnduckFn, MonsterinfoSidestepFn, MonsterinfoDodgeFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterThink,
  RegisterPain,
  RegisterDie,
  RegisterPrethink,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMonsterinfoDuck,
  RegisterMonsterinfoUnduck,
  RegisterMonsterinfoSidestep,
  RegisterMonsterinfoDodge,
} from "./g_save_registry";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible, range_to, FoundTarget } from "./g_ai";
import {
  monster_fire_bullet,
  monster_fire_shotgun,
  monster_fire_blaster,
  M_ProjectFlashSource,
  M_CheckClearShot,
  M_SetAnimation,
  M_AllowSpawn,
  M_droptofloor,
  monster_dead,
  walkmonster_start,
} from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGibs } from "./g_misc";
import { G_FreeEdict } from "./g_utils";
import { g_edicts } from "./g_main_globals";
import { Gtime_add, Gtime_subtract, Gtime_from_sec, Gtime_from_ms, Gtime_milliseconds, type GTime } from "./gtime";
import { irandom, brandom } from "./q_std";
import { ModIdT } from "./g_local";
import { PredictAim } from "./m_supertank";
import { dabeam_update, monster_fire_dabeam, monster_fire_ionripper, monster_fire_blueblaster } from "./g_xatrix_monster";

// ---------------------------------------------------------------------------
// m_soldier.h frame-index enum (585 lines; anonymous enum, declaration
// order = array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_attak101 = 0;
export const FRAME_attak102 = 1;
export const FRAME_attak103 = 2;
export const FRAME_attak104 = 3;
export const FRAME_attak105 = 4;
export const FRAME_attak106 = 5;
export const FRAME_attak107 = 6;
export const FRAME_attak108 = 7;
export const FRAME_attak109 = 8;
export const FRAME_attak110 = 9;
export const FRAME_attak111 = 10;
export const FRAME_attak112 = 11;
export const FRAME_attak201 = 12;
export const FRAME_attak202 = 13;
export const FRAME_attak203 = 14;
export const FRAME_attak204 = 15;
export const FRAME_attak205 = 16;
export const FRAME_attak206 = 17;
export const FRAME_attak207 = 18;
export const FRAME_attak208 = 19;
export const FRAME_attak209 = 20;
export const FRAME_attak210 = 21;
export const FRAME_attak211 = 22;
export const FRAME_attak212 = 23;
export const FRAME_attak213 = 24;
export const FRAME_attak214 = 25;
export const FRAME_attak215 = 26;
export const FRAME_attak216 = 27;
export const FRAME_attak217 = 28;
export const FRAME_attak218 = 29;
export const FRAME_attak301 = 30;
export const FRAME_attak302 = 31;
export const FRAME_attak303 = 32;
export const FRAME_attak304 = 33;
export const FRAME_attak305 = 34;
export const FRAME_attak306 = 35;
export const FRAME_attak307 = 36;
export const FRAME_attak308 = 37;
export const FRAME_attak309 = 38;
export const FRAME_attak401 = 39;
export const FRAME_attak402 = 40;
export const FRAME_attak403 = 41;
export const FRAME_attak404 = 42;
export const FRAME_attak405 = 43;
export const FRAME_attak406 = 44;
export const FRAME_duck01 = 45;
export const FRAME_duck02 = 46;
export const FRAME_duck03 = 47;
export const FRAME_duck04 = 48;
export const FRAME_duck05 = 49;
export const FRAME_pain101 = 50;
export const FRAME_pain102 = 51;
export const FRAME_pain103 = 52;
export const FRAME_pain104 = 53;
export const FRAME_pain105 = 54;
export const FRAME_pain201 = 55;
export const FRAME_pain202 = 56;
export const FRAME_pain203 = 57;
export const FRAME_pain204 = 58;
export const FRAME_pain205 = 59;
export const FRAME_pain206 = 60;
export const FRAME_pain207 = 61;
export const FRAME_pain301 = 62;
export const FRAME_pain302 = 63;
export const FRAME_pain303 = 64;
export const FRAME_pain304 = 65;
export const FRAME_pain305 = 66;
export const FRAME_pain306 = 67;
export const FRAME_pain307 = 68;
export const FRAME_pain308 = 69;
export const FRAME_pain309 = 70;
export const FRAME_pain310 = 71;
export const FRAME_pain311 = 72;
export const FRAME_pain312 = 73;
export const FRAME_pain313 = 74;
export const FRAME_pain314 = 75;
export const FRAME_pain315 = 76;
export const FRAME_pain316 = 77;
export const FRAME_pain317 = 78;
export const FRAME_pain318 = 79;
export const FRAME_pain401 = 80;
export const FRAME_pain402 = 81;
export const FRAME_pain403 = 82;
export const FRAME_pain404 = 83;
export const FRAME_pain405 = 84;
export const FRAME_pain406 = 85;
export const FRAME_pain407 = 86;
export const FRAME_pain408 = 87;
export const FRAME_pain409 = 88;
export const FRAME_pain410 = 89;
export const FRAME_pain411 = 90;
export const FRAME_pain412 = 91;
export const FRAME_pain413 = 92;
export const FRAME_pain414 = 93;
export const FRAME_pain415 = 94;
export const FRAME_pain416 = 95;
export const FRAME_pain417 = 96;
export const FRAME_run01 = 97;
export const FRAME_run02 = 98;
export const FRAME_run03 = 99;
export const FRAME_run04 = 100;
export const FRAME_run05 = 101;
export const FRAME_run06 = 102;
export const FRAME_run07 = 103;
export const FRAME_run08 = 104;
export const FRAME_run09 = 105;
export const FRAME_run10 = 106;
export const FRAME_run11 = 107;
export const FRAME_run12 = 108;
export const FRAME_runs01 = 109;
export const FRAME_runs02 = 110;
export const FRAME_runs03 = 111;
export const FRAME_runs04 = 112;
export const FRAME_runs05 = 113;
export const FRAME_runs06 = 114;
export const FRAME_runs07 = 115;
export const FRAME_runs08 = 116;
export const FRAME_runs09 = 117;
export const FRAME_runs10 = 118;
export const FRAME_runs11 = 119;
export const FRAME_runs12 = 120;
export const FRAME_runs13 = 121;
export const FRAME_runs14 = 122;
export const FRAME_runs15 = 123;
export const FRAME_runs16 = 124;
export const FRAME_runs17 = 125;
export const FRAME_runs18 = 126;
export const FRAME_runt01 = 127;
export const FRAME_runt02 = 128;
export const FRAME_runt03 = 129;
export const FRAME_runt04 = 130;
export const FRAME_runt05 = 131;
export const FRAME_runt06 = 132;
export const FRAME_runt07 = 133;
export const FRAME_runt08 = 134;
export const FRAME_runt09 = 135;
export const FRAME_runt10 = 136;
export const FRAME_runt11 = 137;
export const FRAME_runt12 = 138;
export const FRAME_runt13 = 139;
export const FRAME_runt14 = 140;
export const FRAME_runt15 = 141;
export const FRAME_runt16 = 142;
export const FRAME_runt17 = 143;
export const FRAME_runt18 = 144;
export const FRAME_runt19 = 145;
export const FRAME_stand101 = 146;
export const FRAME_stand102 = 147;
export const FRAME_stand103 = 148;
export const FRAME_stand104 = 149;
export const FRAME_stand105 = 150;
export const FRAME_stand106 = 151;
export const FRAME_stand107 = 152;
export const FRAME_stand108 = 153;
export const FRAME_stand109 = 154;
export const FRAME_stand110 = 155;
export const FRAME_stand111 = 156;
export const FRAME_stand112 = 157;
export const FRAME_stand113 = 158;
export const FRAME_stand114 = 159;
export const FRAME_stand115 = 160;
export const FRAME_stand116 = 161;
export const FRAME_stand117 = 162;
export const FRAME_stand118 = 163;
export const FRAME_stand119 = 164;
export const FRAME_stand120 = 165;
export const FRAME_stand121 = 166;
export const FRAME_stand122 = 167;
export const FRAME_stand123 = 168;
export const FRAME_stand124 = 169;
export const FRAME_stand125 = 170;
export const FRAME_stand126 = 171;
export const FRAME_stand127 = 172;
export const FRAME_stand128 = 173;
export const FRAME_stand129 = 174;
export const FRAME_stand130 = 175;
export const FRAME_stand301 = 176;
export const FRAME_stand302 = 177;
export const FRAME_stand303 = 178;
export const FRAME_stand304 = 179;
export const FRAME_stand305 = 180;
export const FRAME_stand306 = 181;
export const FRAME_stand307 = 182;
export const FRAME_stand308 = 183;
export const FRAME_stand309 = 184;
export const FRAME_stand310 = 185;
export const FRAME_stand311 = 186;
export const FRAME_stand312 = 187;
export const FRAME_stand313 = 188;
export const FRAME_stand314 = 189;
export const FRAME_stand315 = 190;
export const FRAME_stand316 = 191;
export const FRAME_stand317 = 192;
export const FRAME_stand318 = 193;
export const FRAME_stand319 = 194;
export const FRAME_stand320 = 195;
export const FRAME_stand321 = 196;
export const FRAME_stand322 = 197;
export const FRAME_stand323 = 198;
export const FRAME_stand324 = 199;
export const FRAME_stand325 = 200;
export const FRAME_stand326 = 201;
export const FRAME_stand327 = 202;
export const FRAME_stand328 = 203;
export const FRAME_stand329 = 204;
export const FRAME_stand330 = 205;
export const FRAME_stand331 = 206;
export const FRAME_stand332 = 207;
export const FRAME_stand333 = 208;
export const FRAME_stand334 = 209;
export const FRAME_stand335 = 210;
export const FRAME_stand336 = 211;
export const FRAME_stand337 = 212;
export const FRAME_stand338 = 213;
export const FRAME_stand339 = 214;
export const FRAME_walk101 = 215;
export const FRAME_walk102 = 216;
export const FRAME_walk103 = 217;
export const FRAME_walk104 = 218;
export const FRAME_walk105 = 219;
export const FRAME_walk106 = 220;
export const FRAME_walk107 = 221;
export const FRAME_walk108 = 222;
export const FRAME_walk109 = 223;
export const FRAME_walk110 = 224;
export const FRAME_walk111 = 225;
export const FRAME_walk112 = 226;
export const FRAME_walk113 = 227;
export const FRAME_walk114 = 228;
export const FRAME_walk115 = 229;
export const FRAME_walk116 = 230;
export const FRAME_walk117 = 231;
export const FRAME_walk118 = 232;
export const FRAME_walk119 = 233;
export const FRAME_walk120 = 234;
export const FRAME_walk121 = 235;
export const FRAME_walk122 = 236;
export const FRAME_walk123 = 237;
export const FRAME_walk124 = 238;
export const FRAME_walk125 = 239;
export const FRAME_walk126 = 240;
export const FRAME_walk127 = 241;
export const FRAME_walk128 = 242;
export const FRAME_walk129 = 243;
export const FRAME_walk130 = 244;
export const FRAME_walk131 = 245;
export const FRAME_walk132 = 246;
export const FRAME_walk133 = 247;
export const FRAME_walk201 = 248;
export const FRAME_walk202 = 249;
export const FRAME_walk203 = 250;
export const FRAME_walk204 = 251;
export const FRAME_walk205 = 252;
export const FRAME_walk206 = 253;
export const FRAME_walk207 = 254;
export const FRAME_walk208 = 255;
export const FRAME_walk209 = 256;
export const FRAME_walk210 = 257;
export const FRAME_walk211 = 258;
export const FRAME_walk212 = 259;
export const FRAME_walk213 = 260;
export const FRAME_walk214 = 261;
export const FRAME_walk215 = 262;
export const FRAME_walk216 = 263;
export const FRAME_walk217 = 264;
export const FRAME_walk218 = 265;
export const FRAME_walk219 = 266;
export const FRAME_walk220 = 267;
export const FRAME_walk221 = 268;
export const FRAME_walk222 = 269;
export const FRAME_walk223 = 270;
export const FRAME_walk224 = 271;
export const FRAME_death101 = 272;
export const FRAME_death102 = 273;
export const FRAME_death103 = 274;
export const FRAME_death104 = 275;
export const FRAME_death105 = 276;
export const FRAME_death106 = 277;
export const FRAME_death107 = 278;
export const FRAME_death108 = 279;
export const FRAME_death109 = 280;
export const FRAME_death110 = 281;
export const FRAME_death111 = 282;
export const FRAME_death112 = 283;
export const FRAME_death113 = 284;
export const FRAME_death114 = 285;
export const FRAME_death115 = 286;
export const FRAME_death116 = 287;
export const FRAME_death117 = 288;
export const FRAME_death118 = 289;
export const FRAME_death119 = 290;
export const FRAME_death120 = 291;
export const FRAME_death121 = 292;
export const FRAME_death122 = 293;
export const FRAME_death123 = 294;
export const FRAME_death124 = 295;
export const FRAME_death125 = 296;
export const FRAME_death126 = 297;
export const FRAME_death127 = 298;
export const FRAME_death128 = 299;
export const FRAME_death129 = 300;
export const FRAME_death130 = 301;
export const FRAME_death131 = 302;
export const FRAME_death132 = 303;
export const FRAME_death133 = 304;
export const FRAME_death134 = 305;
export const FRAME_death135 = 306;
export const FRAME_death136 = 307;
export const FRAME_death201 = 308;
export const FRAME_death202 = 309;
export const FRAME_death203 = 310;
export const FRAME_death204 = 311;
export const FRAME_death205 = 312;
export const FRAME_death206 = 313;
export const FRAME_death207 = 314;
export const FRAME_death208 = 315;
export const FRAME_death209 = 316;
export const FRAME_death210 = 317;
export const FRAME_death211 = 318;
export const FRAME_death212 = 319;
export const FRAME_death213 = 320;
export const FRAME_death214 = 321;
export const FRAME_death215 = 322;
export const FRAME_death216 = 323;
export const FRAME_death217 = 324;
export const FRAME_death218 = 325;
export const FRAME_death219 = 326;
export const FRAME_death220 = 327;
export const FRAME_death221 = 328;
export const FRAME_death222 = 329;
export const FRAME_death223 = 330;
export const FRAME_death224 = 331;
export const FRAME_death225 = 332;
export const FRAME_death226 = 333;
export const FRAME_death227 = 334;
export const FRAME_death228 = 335;
export const FRAME_death229 = 336;
export const FRAME_death230 = 337;
export const FRAME_death231 = 338;
export const FRAME_death232 = 339;
export const FRAME_death233 = 340;
export const FRAME_death234 = 341;
export const FRAME_death235 = 342;
export const FRAME_death301 = 343;
export const FRAME_death302 = 344;
export const FRAME_death303 = 345;
export const FRAME_death304 = 346;
export const FRAME_death305 = 347;
export const FRAME_death306 = 348;
export const FRAME_death307 = 349;
export const FRAME_death308 = 350;
export const FRAME_death309 = 351;
export const FRAME_death310 = 352;
export const FRAME_death311 = 353;
export const FRAME_death312 = 354;
export const FRAME_death313 = 355;
export const FRAME_death314 = 356;
export const FRAME_death315 = 357;
export const FRAME_death316 = 358;
export const FRAME_death317 = 359;
export const FRAME_death318 = 360;
export const FRAME_death319 = 361;
export const FRAME_death320 = 362;
export const FRAME_death321 = 363;
export const FRAME_death322 = 364;
export const FRAME_death323 = 365;
export const FRAME_death324 = 366;
export const FRAME_death325 = 367;
export const FRAME_death326 = 368;
export const FRAME_death327 = 369;
export const FRAME_death328 = 370;
export const FRAME_death329 = 371;
export const FRAME_death330 = 372;
export const FRAME_death331 = 373;
export const FRAME_death332 = 374;
export const FRAME_death333 = 375;
export const FRAME_death334 = 376;
export const FRAME_death335 = 377;
export const FRAME_death336 = 378;
export const FRAME_death337 = 379;
export const FRAME_death338 = 380;
export const FRAME_death339 = 381;
export const FRAME_death340 = 382;
export const FRAME_death341 = 383;
export const FRAME_death342 = 384;
export const FRAME_death343 = 385;
export const FRAME_death344 = 386;
export const FRAME_death345 = 387;
export const FRAME_death401 = 388;
export const FRAME_death402 = 389;
export const FRAME_death403 = 390;
export const FRAME_death404 = 391;
export const FRAME_death405 = 392;
export const FRAME_death406 = 393;
export const FRAME_death407 = 394;
export const FRAME_death408 = 395;
export const FRAME_death409 = 396;
export const FRAME_death410 = 397;
export const FRAME_death411 = 398;
export const FRAME_death412 = 399;
export const FRAME_death413 = 400;
export const FRAME_death414 = 401;
export const FRAME_death415 = 402;
export const FRAME_death416 = 403;
export const FRAME_death417 = 404;
export const FRAME_death418 = 405;
export const FRAME_death419 = 406;
export const FRAME_death420 = 407;
export const FRAME_death421 = 408;
export const FRAME_death422 = 409;
export const FRAME_death423 = 410;
export const FRAME_death424 = 411;
export const FRAME_death425 = 412;
export const FRAME_death426 = 413;
export const FRAME_death427 = 414;
export const FRAME_death428 = 415;
export const FRAME_death429 = 416;
export const FRAME_death430 = 417;
export const FRAME_death431 = 418;
export const FRAME_death432 = 419;
export const FRAME_death433 = 420;
export const FRAME_death434 = 421;
export const FRAME_death435 = 422;
export const FRAME_death436 = 423;
export const FRAME_death437 = 424;
export const FRAME_death438 = 425;
export const FRAME_death439 = 426;
export const FRAME_death440 = 427;
export const FRAME_death441 = 428;
export const FRAME_death442 = 429;
export const FRAME_death443 = 430;
export const FRAME_death444 = 431;
export const FRAME_death445 = 432;
export const FRAME_death446 = 433;
export const FRAME_death447 = 434;
export const FRAME_death448 = 435;
export const FRAME_death449 = 436;
export const FRAME_death450 = 437;
export const FRAME_death451 = 438;
export const FRAME_death452 = 439;
export const FRAME_death453 = 440;
export const FRAME_death501 = 441;
export const FRAME_death502 = 442;
export const FRAME_death503 = 443;
export const FRAME_death504 = 444;
export const FRAME_death505 = 445;
export const FRAME_death506 = 446;
export const FRAME_death507 = 447;
export const FRAME_death508 = 448;
export const FRAME_death509 = 449;
export const FRAME_death510 = 450;
export const FRAME_death511 = 451;
export const FRAME_death512 = 452;
export const FRAME_death513 = 453;
export const FRAME_death514 = 454;
export const FRAME_death515 = 455;
export const FRAME_death516 = 456;
export const FRAME_death517 = 457;
export const FRAME_death518 = 458;
export const FRAME_death519 = 459;
export const FRAME_death520 = 460;
export const FRAME_death521 = 461;
export const FRAME_death522 = 462;
export const FRAME_death523 = 463;
export const FRAME_death524 = 464;
export const FRAME_death601 = 465;
export const FRAME_death602 = 466;
export const FRAME_death603 = 467;
export const FRAME_death604 = 468;
export const FRAME_death605 = 469;
export const FRAME_death606 = 470;
export const FRAME_death607 = 471;
export const FRAME_death608 = 472;
export const FRAME_death609 = 473;
export const FRAME_death610 = 474;
export const FRAME_stand401 = 475;
export const FRAME_stand402 = 476;
export const FRAME_stand403 = 477;
export const FRAME_stand404 = 478;
export const FRAME_stand405 = 479;
export const FRAME_stand406 = 480;
export const FRAME_stand407 = 481;
export const FRAME_stand408 = 482;
export const FRAME_stand409 = 483;
export const FRAME_stand410 = 484;
export const FRAME_stand411 = 485;
export const FRAME_stand412 = 486;
export const FRAME_stand413 = 487;
export const FRAME_stand414 = 488;
export const FRAME_stand415 = 489;
export const FRAME_stand416 = 490;
export const FRAME_stand417 = 491;
export const FRAME_stand418 = 492;
export const FRAME_stand419 = 493;
export const FRAME_stand420 = 494;
export const FRAME_stand421 = 495;
export const FRAME_stand422 = 496;
export const FRAME_stand423 = 497;
export const FRAME_stand424 = 498;
export const FRAME_stand425 = 499;
export const FRAME_stand426 = 500;
export const FRAME_stand427 = 501;
export const FRAME_stand428 = 502;
export const FRAME_stand429 = 503;
export const FRAME_stand430 = 504;
export const FRAME_stand431 = 505;
export const FRAME_stand432 = 506;
export const FRAME_stand433 = 507;
export const FRAME_stand434 = 508;
export const FRAME_stand435 = 509;
export const FRAME_stand436 = 510;
export const FRAME_stand437 = 511;
export const FRAME_stand438 = 512;
export const FRAME_stand439 = 513;
export const FRAME_stand440 = 514;
export const FRAME_stand441 = 515;
export const FRAME_stand442 = 516;
export const FRAME_stand443 = 517;
export const FRAME_stand444 = 518;
export const FRAME_stand445 = 519;
export const FRAME_stand446 = 520;
export const FRAME_stand447 = 521;
export const FRAME_stand448 = 522;
export const FRAME_stand449 = 523;
export const FRAME_stand450 = 524;
export const FRAME_stand451 = 525;
export const FRAME_stand452 = 526;
export const FRAME_stand201 = 527;
export const FRAME_stand202 = 528;
export const FRAME_stand203 = 529;
export const FRAME_stand204 = 530;
export const FRAME_stand205 = 531;
export const FRAME_stand206 = 532;
export const FRAME_stand207 = 533;
export const FRAME_stand208 = 534;
export const FRAME_stand209 = 535;
export const FRAME_stand210 = 536;
export const FRAME_stand211 = 537;
export const FRAME_stand212 = 538;
export const FRAME_stand213 = 539;
export const FRAME_stand214 = 540;
export const FRAME_stand215 = 541;
export const FRAME_stand216 = 542;
export const FRAME_stand217 = 543;
export const FRAME_stand218 = 544;
export const FRAME_stand219 = 545;
export const FRAME_stand220 = 546;
export const FRAME_stand221 = 547;
export const FRAME_stand222 = 548;
export const FRAME_stand223 = 549;
export const FRAME_stand224 = 550;
export const FRAME_stand225 = 551;
export const FRAME_stand226 = 552;
export const FRAME_stand227 = 553;
export const FRAME_stand228 = 554;
export const FRAME_stand229 = 555;
export const FRAME_stand230 = 556;
export const FRAME_stand231 = 557;
export const FRAME_stand232 = 558;
export const FRAME_stand233 = 559;
export const FRAME_stand234 = 560;
export const FRAME_stand235 = 561;
export const FRAME_stand236 = 562;
export const FRAME_stand237 = 563;
export const FRAME_stand238 = 564;
export const FRAME_stand239 = 565;
export const FRAME_stand240 = 566;
export const FRAME_attak501 = 567;
export const FRAME_attak502 = 568;
export const FRAME_attak503 = 569;
export const FRAME_attak504 = 570;
export const FRAME_attak505 = 571;
export const FRAME_attak506 = 572;
export const FRAME_attak507 = 573;
export const FRAME_attak508 = 574;

export const MODEL_SCALE = 1.2;

// ---------------------------------------------------------------------------
// cached_soundindex fields -- see file header.
// ---------------------------------------------------------------------------

interface CachedSoundIndex {
  index: number;
}
function mkSound(): CachedSoundIndex {
  return { index: 0 };
}
function assignSound(cache: CachedSoundIndex, name: string): void {
  cache.index = gi.soundindex(name);
}

const sound_idle = mkSound();
const sound_sight1 = mkSound();
const sound_sight2 = mkSound();
const sound_pain_light = mkSound();
const sound_pain = mkSound();
const sound_pain_ss = mkSound();
const sound_death_light = mkSound();
const sound_death = mkSound();
const sound_death_ss = mkSound();
const sound_cock = mkSound();

// ---------------------------------------------------------------------------
// Locally-ported shared infra -- see file header sections (1) and (2).
// ---------------------------------------------------------------------------

/** g_local.h:3281-3286 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  if (self.groundentity !== null) self.s.event = 2 /* EV_OTHER_FOOTSTEP, see kexapi/game.ts EntityEventT */;
}

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

/** EDICT_NUM idiom -- see g_monster.ts's/g_phys.ts's own `traceEdict` for the full rationale. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** g_local.h:136-139 `game_import_t::traceline` -- see g_monster.ts's own `giTraceline` for the full rationale. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** rogue/g_rogue_newai.cpp:97-103. See file header (1). */
/** rogue/g_rogue_monster.cpp:98. EXPORTED, same cross-file reason as
 *  `monster_duck_up` above: m_berserk.ts's own copy was a throwing stub
 *  despite being genuinely reachable from berserk_run/berserk_melee/
 *  berserk_attack, so it imports this real implementation instead. Not
 *  save-registry-typed (never RegisterX'd anywhere in this porting batch),
 *  so there is no duplicate-registration risk from infantry.ts/gunner.ts
 *  keeping their own identical local copies -- only berserk's throwing one
 *  needed replacing. */
export function monster_done_dodge(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_DODGING;
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  }
}

/** rogue/g_rogue_newai.cpp:1424-1432. See file header (1). */
/** EXPORTED (see `monster_duck_up`'s comment above for the cross-file
 *  rationale): m_berserk.ts imports this, replacing what was a throwing
 *  stub there despite being genuinely reachable (wired into
 *  berserk_frames_duck's thinkfuncs). */
export function monster_duck_down(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DUCKED;
  self.maxs[2] = self.monsterinfo.base_height - 32;
  self.takedamage = true;
  self.monsterinfo.next_duck_time = Gtime_add(level.time, DUCK_INTERVAL);
  gi.linkentity(self);
}

/** rogue/g_rogue_newai.cpp:1434-1439. See file header (1). EXPORTED, same
 *  reason as `monster_duck_down` above. */
export function monster_duck_hold(self: EdictT): void {
  if (level.time >= self.monsterinfo.duck_wait_time) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
  } else {
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
  }
}

/**
 * rogue/g_rogue_newai.cpp:1442-1451 `MONSTERINFO_UNDUCK(monster_duck_up)`.
 * See file header (1). EXPORTED: this is monster-agnostic rogue-newai
 * infrastructure, not soldier-specific -- m_infantry.ts and m_gunner.ts
 * import it from here rather than keeping their own local copies, which
 * would otherwise register a SECOND `monster_duck_up` under the identical
 * name in g_save_registry.ts's global, name-keyed monsterinfo_unduck
 * registry and throw ("duplicate ... registration") the moment more than
 * one of these three files is imported in the same process -- exactly what
 * the real game's g_spawn.ts does by importing every monster file. Soldier
 * was picked as the canonical owner (arbitrary but stable) since all three
 * ports were verified functionally identical modulo GTime-arithmetic style.
 */
export function monster_duck_up(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) === 0n) return;

  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_DUCKED;
  self.maxs[2] = self.monsterinfo.base_height;
  self.takedamage = true;
  if (self.monsterinfo.next_duck_time > level.time) {
    self.monsterinfo.next_duck_time = Gtime_add(level.time, Gtime_from_ms(Gtime_milliseconds(Gtime_subtract(self.monsterinfo.next_duck_time, level.time)) / 2));
  }
  gi.linkentity(self);
}
RegisterMonsterinfoUnduck("monster_duck_up", monster_duck_up);

/** rogue/g_rogue_newai.cpp:14-88 `bool blocked_checkplat(edict_t *self, float dist)`. See file header (1). */
function blocked_checkplat(self: EdictT, dist: number): boolean {
  const enemy = self.enemy;
  if (enemy === null) return false;

  let playerPosition: number;
  if (enemy.absmin[2] >= self.absmax[2]) playerPosition = 1;
  else if (enemy.absmax[2] <= self.absmin[2]) playerPosition = -1;
  else playerPosition = 0;

  if (playerPosition === 0) return false;

  let plat: EdictT | null = null;

  if (self.groundentity !== null && self.groundentity !== g_edicts[0]) {
    if ((self.groundentity.classname ?? "").slice(0, 8) === "func_pla") plat = self.groundentity;
  }

  if (plat === null) {
    const forward = vec3(0, 0, 0);
    AngleVectors(self.s.angles, forward, null, null);
    const pt1 = vec3_add(self.s.origin, vec3_muls(forward, dist));
    const pt2 = vec3(pt1[0], pt1[1], pt1[2] - 384);

    const trace = giTraceline(pt1, pt2, self, MASK_MONSTERSOLID);
    if (trace.fraction < 1 && !trace.allsolid && !trace.startsolid && trace.ent !== null) {
      const hit = traceEdict(trace.ent);
      if ((hit.classname ?? "").slice(0, 8) === "func_pla") plat = hit;
    }
  }

  if (plat !== null && plat.use !== null) {
    if (playerPosition === 1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === MoveStateT.STATE_BOTTOM) ||
        (self.groundentity !== plat && plat.moveinfo.state === MoveStateT.STATE_TOP)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    } else if (playerPosition === -1) {
      if (
        (self.groundentity === plat && plat.moveinfo.state === MoveStateT.STATE_TOP) ||
        (self.groundentity !== plat && plat.moveinfo.state === MoveStateT.STATE_BOTTOM)
      ) {
        plat.use(plat, self, self);
        return true;
      }
    }
  }

  return false;
}

/** g_phys.ts's/g_ai.ts's own `cvarOrDefault` -- duplicated per-file, see file header. */
function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) throw new Error(`gi.cvar(${name}) returned null`);
  return c;
}

/** rogue/g_rogue_newai.cpp:1291-1299 `inline bool G_SkillCheck(...)`. See file header (1). */
function G_SkillCheck(skills: readonly [number, number, number, number]): boolean {
  const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
  if (4 < skillInt) return true; // skills.size() < skill->integer, size is always 4 here
  const skillSwitch = skills[Math.max(0, Math.min(3, skillInt))];
  return skillSwitch === 1.0 ? true : Math.random() < skillSwitch;
}

/**
 * rogue/g_rogue_newai.cpp:1304-1422 `MONSTERINFO_DODGE(M_MonsterDodge)`. See
 * file header (1). EXPORTED for the identical reason as `monster_duck_up`
 * above: m_infantry.ts/m_gunner.ts import this instead of registering their
 * own duplicate under the same "M_MonsterDodge" name, which would otherwise
 * throw a duplicate-registration error in g_save_registry.ts's
 * monsterinfo_dodge registry the moment more than one of these files loads
 * together (the real game imports all of them from g_spawn.ts).
 */
export function M_MonsterDodge(self: EdictT, attacker: EdictT, eta: GTime, tr: KexTraceT | null, gravity: boolean): void {
  const r = Math.random();
  let height: number;
  let ducker = false;
  let dodger = false;

  if (self.health < 1) return;

  if (self.monsterinfo.duck !== null && self.monsterinfo.unduck !== null && !gravity) ducker = true;
  if (self.monsterinfo.sidestep !== null && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) === 0n) dodger = true;

  if (!ducker && !dodger) return;

  if (self.enemy === null) {
    self.enemy = attacker;
    FoundTarget(self);
  }

  if (eta < Gtime_from_ms(gi.frame_time_ms) || eta > Gtime_from_sec(2.5)) return;

  if (r > 0.5) return;

  if (ducker && tr !== null) {
    height = self.absmax[2] - 32 - 1;
    if (!dodger && (tr.endpos[2] <= height || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n)) return;
  } else {
    height = self.absmax[2];
  }

  if (dodger) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DODGING) !== 0n) return;

    if (!ducker || tr === null || tr.endpos[2] <= height || (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) {
      if (!G_SkillCheck([0.25, 0.5, 1.0, 1.0])) {
        self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(800), Gtime_from_ms(1400)));
        return;
      }

      if (tr !== null) {
        const right = vec3(0, 0, 0);
        AngleVectors(self.s.angles, null, right, null);
        const diff = vec3_sub(tr.endpos, self.s.origin);
        self.monsterinfo.lefty = vec3_dot(right, diff) < 0 ? false : true;
      } else {
        self.monsterinfo.lefty = brandom();
      }

      const sidestep = self.monsterinfo.sidestep;
      if (sidestep !== null && sidestep(self)) {
        if (ducker && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) {
          const unduck = self.monsterinfo.unduck;
          if (unduck !== null) unduck(self);
        }

        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DODGING;
        self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
        self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(400), Gtime_from_sec(2.0)));
      }
      return;
    }
  }

  if (ducker && tr !== null && eta < Gtime_from_ms(500)) {
    if (self.monsterinfo.next_duck_time > level.time) return;

    monster_done_dodge(self);

    const duck = self.monsterinfo.duck;
    if (duck !== null && duck(self, eta)) {
      if (self.monsterinfo.duck_wait_time < level.time) self.monsterinfo.duck_wait_time = Gtime_add(level.time, eta);

      monster_duck_down(self);

      const skillInt = Math.trunc(cvarOrDefault("skill", "1").value);
      if (skillInt === 0) self.monsterinfo.duck_wait_time = Gtime_add(self.monsterinfo.duck_wait_time, random_time(Gtime_from_ms(500), Gtime_from_ms(1000)));
      else if (skillInt === 1) self.monsterinfo.duck_wait_time = Gtime_add(self.monsterinfo.duck_wait_time, random_time(Gtime_from_ms(100), Gtime_from_ms(350)));
    }

    self.monsterinfo.dodge_time = Gtime_add(level.time, random_time(Gtime_from_ms(200), Gtime_from_ms(700)));
  }
}
RegisterMonsterinfoDodge("M_MonsterDodge", M_MonsterDodge);

// ---------------------------------------------------------------------------
// XATRIX MISSION-PACK PRIMITIVES -- real imports from g_xatrix_monster.ts.
// See file header (3).
// ---------------------------------------------------------------------------

// PredictAim is now a real import from "./m_supertank" -- see file header's
// "PREDICTAIM SIGNATURE FIX" note (this file's own stub had a stale
// 7-parameter signature missing the real `aimpoint` out-param; the one call
// site below now passes `null` for it, matching every other real call site
// in this port line).

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see file header.
// ---------------------------------------------------------------------------

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveEndfuncFn | null, sidestep_scale = 0): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  m.sidestep_scale = sidestep_scale;
  return m;
}

// ---------------------------------------------------------------------------
// soldier_start_charge / soldier_stop_charge / soldier_idle / soldier_cock /
// soldierh_hyper_laser_sound_start / soldierh_hyper_laser_sound_end
// (m_soldier.cpp:26-73)
// ---------------------------------------------------------------------------

export function soldier_start_charge(self: EdictT): void {
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_CHARGING;
}

export function soldier_stop_charge(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_CHARGING;
}

export function soldier_idle(self: EdictT): void {
  if (Math.random() > 0.8) gi.sound(self, SoundchanT.CHAN_VOICE, sound_idle.index, 1, ATTN_IDLE, 0);
}

export function soldier_cock(self: EdictT): void {
  if (self.s.frame === FRAME_stand322) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_cock.index, 1, ATTN_IDLE, 0);
  else gi.sound(self, SoundchanT.CHAN_WEAPON, sound_cock.index, 1, ATTN_NORM, 0);

  // [Paril-KEX] reset cockness
  self.dmg = 0;
}

export function soldierh_hyper_laser_sound_start(self: EdictT): void {
  if (self.style === 1) {
    if (self.count >= 2 && self.count < 4) self.monsterinfo.weapon_sound = gi.soundindex("weapons/hyprbl1a.wav");
  }
}

export function soldierh_hyper_laser_sound_end(self: EdictT): void {
  if (self.monsterinfo.weapon_sound !== 0) {
    if (self.count >= 2 && self.count < 4) gi.sound(self, SoundchanT.CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
    self.monsterinfo.weapon_sound = 0;
  }
}

// ---------------------------------------------------------------------------
// STAND (m_soldier.cpp:79-219)
// ---------------------------------------------------------------------------

const soldier_frames_stand1: MframeT[] = [
  mkframe(ai_stand, 0, soldier_idle),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
];
export const soldier_move_stand1 = RegisterMmove("soldier_move_stand1", mkMove(FRAME_stand101, FRAME_stand130, soldier_frames_stand1, soldier_stand));

const soldier_frames_stand2: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, monster_footstep),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, monster_footstep),
];
export const soldier_move_stand2 = RegisterMmove("soldier_move_stand2", mkMove(FRAME_stand201, FRAME_stand240, soldier_frames_stand2, soldier_stand));

const soldier_frames_stand3: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand, 0, soldier_cock),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
];
export const soldier_move_stand3 = RegisterMmove("soldier_move_stand3", mkMove(FRAME_stand301, FRAME_stand339, soldier_frames_stand3, soldier_stand));

export function soldier_stand(self: EdictT): void {
  const r = Math.random();

  if (self.monsterinfo.active_move !== soldier_move_stand1 || r < 0.6) M_SetAnimation(self, soldier_move_stand1, true);
  else if (r < 0.8) M_SetAnimation(self, soldier_move_stand2, true);
  else M_SetAnimation(self, soldier_move_stand3, true);
  soldierh_hyper_laser_sound_end(self);
}
RegisterMonsterinfoStand("soldier_stand", soldier_stand);

// ---------------------------------------------------------------------------
// WALK (m_soldier.cpp:225-289)
// ---------------------------------------------------------------------------

export function soldier_walk1_random(self: EdictT): void {
  if (Math.random() > 0.1) self.monsterinfo.nextframe = FRAME_walk101;
}

const soldier_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 2, monster_footstep),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 1),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 3, monster_footstep),
  mkframe(ai_walk, -1, soldier_walk1_random),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
];
export const soldier_move_walk1 = RegisterMmove("soldier_move_walk1", mkMove(FRAME_walk101, FRAME_walk133, soldier_frames_walk1, null));

const soldier_frames_walk2: MframeT[] = [
  mkframe(ai_walk, 4, monster_footstep),
  mkframe(ai_walk, 4),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 1, monster_footstep),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 7),
];
export const soldier_move_walk2 = RegisterMmove("soldier_move_walk2", mkMove(FRAME_walk209, FRAME_walk218, soldier_frames_walk2, null));

export function soldier_walk(self: EdictT): void {
  // [Paril-KEX] during N64 cutscene, always use fast walk or we bog down the line
  if ((self.hackflags & 4 /* HACKFLAG_END_CUTSCENE */) === 0 && Math.random() < 0.5) M_SetAnimation(self, soldier_move_walk1, true);
  else M_SetAnimation(self, soldier_move_walk2, true);
}
RegisterMonsterinfoWalk("soldier_walk", soldier_walk);

// ---------------------------------------------------------------------------
// RUN (m_soldier.cpp:295-335)
// ---------------------------------------------------------------------------

const soldier_frames_start_run: MframeT[] = [mkframe(ai_run, 7), mkframe(ai_run, 5)];
export const soldier_move_start_run = RegisterMmove("soldier_move_start_run", mkMove(FRAME_run01, FRAME_run02, soldier_frames_start_run, soldier_run));

const soldier_frames_run: MframeT[] = [
  mkframe(ai_run, 10),
  mkframe(ai_run, 11, (self) => {
    monster_done_dodge(self);
    monster_footstep(self);
  }),
  mkframe(ai_run, 11),
  mkframe(ai_run, 16),
  mkframe(ai_run, 10, monster_footstep),
  mkframe(ai_run, 15, monster_done_dodge),
];
export const soldier_move_run = RegisterMmove("soldier_move_run", mkMove(FRAME_run03, FRAME_run08, soldier_frames_run, null));

export function soldier_run(self: EdictT): void {
  monster_done_dodge(self);
  soldierh_hyper_laser_sound_end(self);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, soldier_move_stand1, true);
    return;
  }

  if (
    self.monsterinfo.active_move === soldier_move_walk1 ||
    self.monsterinfo.active_move === soldier_move_walk2 ||
    self.monsterinfo.active_move === soldier_move_start_run ||
    self.monsterinfo.active_move === soldier_move_run
  ) {
    M_SetAnimation(self, soldier_move_run, true);
  } else {
    M_SetAnimation(self, soldier_move_start_run, true);
  }
}
RegisterMonsterinfoRun("soldier_run", soldier_run);

// ---------------------------------------------------------------------------
// PAIN (m_soldier.cpp:341-464)
// ---------------------------------------------------------------------------

const soldier_frames_pain1: MframeT[] = [mkframe(ai_move, -3), mkframe(ai_move, 4), mkframe(ai_move, 1), mkframe(ai_move, 1), mkframe(ai_move)];
export const soldier_move_pain1 = RegisterMmove("soldier_move_pain1", mkMove(FRAME_pain101, FRAME_pain105, soldier_frames_pain1, soldier_run));

const soldier_frames_pain2: MframeT[] = [
  mkframe(ai_move, -13),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
];
export const soldier_move_pain2 = RegisterMmove("soldier_move_pain2", mkMove(FRAME_pain201, FRAME_pain207, soldier_frames_pain2, soldier_run));

const soldier_frames_pain3: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, 10),
  mkframe(ai_move, -4, monster_footstep),
  mkframe(ai_move, -1),
  mkframe(ai_move, -3),
  mkframe(ai_move),
  mkframe(ai_move, 3),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 1),
  mkframe(ai_move),
  mkframe(ai_move, 1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 4),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2, monster_footstep),
];
export const soldier_move_pain3 = RegisterMmove("soldier_move_pain3", mkMove(FRAME_pain301, FRAME_pain318, soldier_frames_pain3, soldier_run));

const soldier_frames_pain4: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -10),
  mkframe(ai_move, -6),
  mkframe(ai_move, 8),
  mkframe(ai_move, 4),
  mkframe(ai_move, 1),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move, 5),
  mkframe(ai_move, 2),
  mkframe(ai_move, -1),
  mkframe(ai_move, -1),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move),
];
export const soldier_move_pain4 = RegisterMmove("soldier_move_pain4", mkMove(FRAME_pain401, FRAME_pain417, soldier_frames_pain4, soldier_run));

export function soldier_pain(self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void {
  monster_done_dodge(self);
  soldier_stop_charge(self);

  // if we're blind firing, this needs to be turned off here
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;

  if (level.time < self.pain_debounce_time) {
    if (
      self.velocity[2] > 100 &&
      (self.monsterinfo.active_move === soldier_move_pain1 || self.monsterinfo.active_move === soldier_move_pain2 || self.monsterinfo.active_move === soldier_move_pain3)
    ) {
      if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
      M_SetAnimation(self, soldier_move_pain4, true);
      soldierh_hyper_laser_sound_end(self);
    }
    return;
  }

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const n = self.count | 1;
  if (n === 1) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain_light.index, 1, ATTN_NORM, 0);
  else if (n === 3) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain_ss.index, 1, ATTN_NORM, 0);

  if (self.velocity[2] > 100) {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
    M_SetAnimation(self, soldier_move_pain4, true);
    soldierh_hyper_laser_sound_end(self);
    return;
  }

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  const r = Math.random();

  if (r < 0.33) M_SetAnimation(self, soldier_move_pain1, true);
  else if (r < 0.66) M_SetAnimation(self, soldier_move_pain2, true);
  else M_SetAnimation(self, soldier_move_pain3, true);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
  soldierh_hyper_laser_sound_end(self);
}
RegisterPain("soldier_pain", soldier_pain);

/** g_monster.ts's real, landed `M_ShouldReactToPain` re-declared here would create an import cycle risk; imported instead. */
import { M_ShouldReactToPain } from "./g_monster";

export function soldier_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1;
  else self.s.skinnum &= ~1;
}
RegisterMonsterinfoSetskin("soldier_setskin", soldier_setskin);

// ---------------------------------------------------------------------------
// ATTACK (m_soldier.cpp:474-1218)
// ---------------------------------------------------------------------------

const blaster_flash = [
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_1,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_2,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_3,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_4,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_5,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_6,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_7,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_8,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_9,
] as const;
const shotgun_flash = [
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_1,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_2,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_3,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_4,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_5,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_6,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_7,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_8,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_SHOTGUN_9,
] as const;
const machinegun_flash = [
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_1,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_2,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_3,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_4,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_5,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_6,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_7,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_8,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_9,
] as const;
const ripper_flash = [
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_1,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_2,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_3,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_4,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_5,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_6,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_7,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_8,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_RIPPER_9,
] as const;
const hyper_flash = [
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_1,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_2,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_3,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_4,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_5,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_6,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_7,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_8,
  MonsterMuzzleflashIdT.MZ2_SOLDIER_HYPERGUN_9,
] as const;

export function soldier_fire_vanilla(self: EdictT, flash_number: number, angle_limited: boolean): void {
  let flash_index: MonsterMuzzleflashIdT;
  if (self.count < 2) flash_index = blaster_flash[flash_number];
  else if (self.count < 4) flash_index = shotgun_flash[flash_number];
  else flash_index = machinegun_flash[flash_number];

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_index], forward, right);

  let aim: Vec3;

  if (flash_number === 5 || flash_number === 6) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD_LOCAL)) return;
    aim = forward;
  } else {
    const enemy = self.enemy;
    if (enemy === null || !enemy.inuse) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
      return;
    }

    let end: Vec3;
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) end = self.monsterinfo.blind_fire_target;
    else end = enemy.s.origin;
    end = vec3(end[0], end[1], end[2] + enemy.viewheight);
    aim = vec3_sub(end, start);

    if (angle_limited) {
      const aim_norm = vec3_normalized(aim);
      const angle = vec3_dot(aim_norm, forward);
      if (angle < 0.5) {
        if (level.time >= self.monsterinfo.fire_wait) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
        else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
        return;
      }
    }

    const dir = vectoangles(aim);
    const fw2 = vec3(0, 0, 0);
    const rt2 = vec3(0, 0, 0);
    const up2 = vec3(0, 0, 0);
    AngleVectors(dir, fw2, rt2, up2);

    const r = crandom_local() * 1000;
    const u = crandom_local() * 500;

    end = vec3_add(start, vec3_muls(fw2, 8192));
    end = vec3_add(end, vec3_muls(rt2, r));
    end = vec3_add(end, vec3_muls(up2, u));

    aim = vec3_normalized(vec3_sub(end, start));
  }

  if (self.count <= 1) {
    monster_fire_blaster(self, start, aim, 5, 600, flash_index, 8n /* EF_BLASTER, see kexapi/game.ts */);
  } else if (self.count <= 3) {
    monster_fire_shotgun(self, start, aim, 2, 1, 1500, 750, 9, flash_index);
    // [Paril-KEX] indicates to soldier that he must cock
    self.dmg = 1;
  } else {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HOLD_FRAME) === 0n) {
      self.monsterinfo.fire_wait = Gtime_add(level.time, random_time(Gtime_from_ms(300), Gtime_from_ms(1100)));
    }

    monster_fire_bullet(self, start, aim, 2, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, flash_index);

    if (level.time >= self.monsterinfo.fire_wait) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
    else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
  }
}

function crandom_local(): number {
  return Math.random() * 2 - 1;
}

export function soldierh_laser_update(self: EdictT): void {
  const owner = self.owner;
  if (owner === null) return;

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(owner.s.angles, forward, right, up);
  let start = owner.s.origin;
  const tempvec = monsterFlashOffset()[owner.radius_dmg];
  start = vec3_add(start, vec3_muls(forward, tempvec[0]));
  start = vec3_add(start, vec3_muls(right, tempvec[1]));
  start = vec3_add(start, vec3_muls(up, tempvec[2] + 6));

  const aimdir = vec3(forward[0], forward[1], forward[2]);
  if (!owner.deadflag) PredictAim(owner, owner.enemy, start, 0, false, crandom_local() * 0.05 + 0.15, aimdir, null);

  self.s.origin = start;
  self.movedir = aimdir;
  gi.linkentity(self);
  dabeam_update(self, false);
}
RegisterPrethink("soldierh_laser_update", soldierh_laser_update);

export function soldierh_laserbeam(self: EdictT, flash_index: number): void {
  self.radius_dmg = flash_index;
  monster_fire_dabeam(self, 1, false, soldierh_laser_update);
}

export function soldier_fire_xatrix(self: EdictT, flash_number: number, angle_limited: boolean): void {
  let flash_index: MonsterMuzzleflashIdT;
  if (self.count < 2) flash_index = ripper_flash[flash_number];
  else if (self.count < 4) flash_index = hyper_flash[flash_number];
  else flash_index = machinegun_flash[flash_number];

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_index], forward, right);

  let aim: Vec3;

  if (flash_number === 5 || flash_number === 6) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_MONSTER_DEAD_LOCAL)) return;
    aim = forward;
  } else {
    const enemy = self.enemy;
    if (enemy === null || !enemy.inuse) {
      self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
      return;
    }

    let end: Vec3;
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) end = self.monsterinfo.blind_fire_target;
    else end = enemy.s.origin;
    end = vec3(end[0], end[1], end[2] + enemy.viewheight);
    aim = vec3_sub(end, start);

    if (angle_limited) {
      const aim_norm = vec3_normalized(aim);
      const angle = vec3_dot(aim_norm, forward);
      if (angle < 0.5) {
        if (level.time >= self.monsterinfo.fire_wait) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
        else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
        return;
      }
    }

    const dir = vectoangles(aim);
    const fw2 = vec3(0, 0, 0);
    const rt2 = vec3(0, 0, 0);
    const up2 = vec3(0, 0, 0);
    AngleVectors(dir, fw2, rt2, up2);

    const r = crandom_local() * 100;
    const u = crandom_local() * 50;
    end = vec3_add(start, vec3_muls(fw2, 8192));
    end = vec3_add(end, vec3_muls(rt2, r));
    end = vec3_add(end, vec3_muls(up2, u));

    aim = vec3_normalized(vec3_sub(end, start));
  }

  if (self.count <= 1) {
    // RAFAEL 24-APR-98: dropped the damage from 15 to 5
    monster_fire_ionripper(self, start, aim, 5, 600, flash_index, 1048576n /* EF_IONRIPPER, see kexapi/game.ts */);
  } else if (self.count <= 3) {
    monster_fire_blueblaster(self, start, aim, 1, 600, flash_index, 4194304n /* EF_BLUEHYPERBLASTER, see kexapi/game.ts */);
  } else {
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_HOLD_FRAME) === 0n) {
      self.monsterinfo.fire_wait = Gtime_add(level.time, random_time(Gtime_from_ms(300), Gtime_from_ms(1100)));
    }

    soldierh_laserbeam(self, flash_index);

    if (level.time >= self.monsterinfo.fire_wait) self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;
    else self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_HOLD_FRAME;
  }
}

export function soldier_fire(self: EdictT, flash_number: number, angle_limited: boolean): void {
  if (self.style === 1) soldier_fire_xatrix(self, flash_number, angle_limited);
  else soldier_fire_vanilla(self, flash_number, angle_limited);
}

// ATTACK1 (blaster/shotgun)

export function soldier_fire1(self: EdictT): void {
  soldier_fire(self, 0, false);
}

export function soldier_attack1_refire1(self: EdictT): void {
  if (self.count <= 0) self.monsterinfo.nextframe = FRAME_attak110;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MANUAL_STEERING;
    return;
  }

  const enemy = self.enemy;
  if (enemy === null) return;
  if (self.count > 1) return;
  if (enemy.health <= 0) return;

  if ((Math.random() < 0.5 && visible(self, enemy)) || range_to(self, enemy) <= RANGE_MELEE) self.monsterinfo.nextframe = FRAME_attak102;
  else self.monsterinfo.nextframe = FRAME_attak110;
}

export function soldier_attack1_refire2(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;
  if (self.count < 2) return;
  if (enemy.health <= 0) return;

  if (((self.radius_dmg !== 0 || Math.random() < 0.5) && visible(self, enemy)) || range_to(self, enemy) <= RANGE_MELEE) {
    self.monsterinfo.nextframe = FRAME_attak102;
    self.radius_dmg = 0;
  }
}

function soldier_attack1_shotgun_check(self: EdictT): void {
  if (self.dmg !== 0) {
    self.monsterinfo.nextframe = FRAME_attak106;
    // [Paril-KEX] indicate that we should force a refire
    self.radius_dmg = 1;
  }
}

function soldier_blind_check(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) {
    const aim = vec3_sub(self.monsterinfo.blind_fire_target, self.s.origin);
    self.ideal_yaw = vectoyaw(aim);
  }
}

const soldier_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0, soldier_blind_check),
  mkframe(ai_charge, 0, soldier_attack1_shotgun_check),
  mkframe(ai_charge, 0, soldier_fire1),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_attack1_refire1),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge, 0, soldier_attack1_refire2),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const soldier_move_attack1 = RegisterMmove("soldier_move_attack1", mkMove(FRAME_attak101, FRAME_attak112, soldier_frames_attack1, soldier_run));

function soldierh_hyper_refire1(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  if (self.count >= 2 && self.count < 4) {
    if (Math.random() < 0.7 && visible(self, enemy)) self.s.frame = FRAME_attak103;
  }
}

function soldierh_hyperripper1(self: EdictT): void {
  if (self.count < 4) soldier_fire(self, 0, false);
}

const soldierh_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0, soldier_blind_check),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_charge, 0, soldier_fire1),
  mkframe(ai_charge, 0, soldierh_hyperripper1),
  mkframe(ai_charge, 0, soldierh_hyperripper1),
  mkframe(ai_charge, 0, soldier_attack1_refire1),
  mkframe(ai_charge, 0, soldierh_hyper_refire1),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge, 0, soldier_attack1_refire2),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_end),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const soldierh_move_attack1 = RegisterMmove("soldierh_move_attack1", mkMove(FRAME_attak101, FRAME_attak112, soldierh_frames_attack1, soldier_run));

// ATTACK2 (blaster/shotgun)

export function soldier_fire2(self: EdictT): void {
  soldier_fire(self, 1, false);
}

export function soldier_attack2_refire1(self: EdictT): void {
  if (self.count <= 0) self.monsterinfo.nextframe = FRAME_attak216;

  const enemy = self.enemy;
  if (enemy === null) return;
  if (self.count > 1) return;
  if (enemy.health <= 0) return;

  if ((Math.random() < 0.5 && visible(self, enemy)) || range_to(self, enemy) <= RANGE_MELEE) self.monsterinfo.nextframe = FRAME_attak204;
}

export function soldier_attack2_refire2(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;
  if (self.count < 2) return;
  if (enemy.health <= 0) return;

  // RAFAEL
  if (
    ((self.radius_dmg !== 0 || Math.random() < 0.5) && visible(self, enemy)) ||
    ((self.style === 0 || self.count < 4) && range_to(self, enemy) <= RANGE_MELEE)
  ) {
    self.monsterinfo.nextframe = FRAME_attak204;
    self.radius_dmg = 0;
  }
}

function soldier_attack2_shotgun_check(self: EdictT): void {
  if (self.dmg !== 0) {
    self.monsterinfo.nextframe = FRAME_attak210;
    self.radius_dmg = 1;
  }
}

const soldier_frames_attack2: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_attack2_shotgun_check),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_fire2),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_attack2_refire1),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_attack2_refire2),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const soldier_move_attack2 = RegisterMmove("soldier_move_attack2", mkMove(FRAME_attak201, FRAME_attak218, soldier_frames_attack2, soldier_run));

function soldierh_hyper_refire2(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null) return;

  if (self.count < 2) return;
  if (self.count < 4) {
    if (Math.random() < 0.7 && visible(self, enemy)) self.s.frame = FRAME_attak205;
  }
}

function soldierh_hyperripper2(self: EdictT): void {
  if (self.count < 4) soldier_fire(self, 1, false);
}

const soldierh_frames_attack2: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_charge, 0, soldier_fire2),
  mkframe(ai_charge, 0, soldierh_hyperripper2),
  mkframe(ai_charge, 0, soldierh_hyperripper2),
  mkframe(ai_charge, 0, soldier_attack2_refire1),
  mkframe(ai_charge, 0, soldierh_hyper_refire2),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_cock),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldier_attack2_refire2),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_end),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const soldierh_move_attack2 = RegisterMmove("soldierh_move_attack2", mkMove(FRAME_attak201, FRAME_attak218, soldierh_frames_attack2, soldier_run));

// ATTACK3 (duck and shoot)

export function soldier_fire3(self: EdictT): void {
  soldier_fire(self, 2, false);
}

function soldierh_hyperripper3(self: EdictT): void {
  if (self.s.skinnum >= 6 && self.count < 4) soldier_fire(self, 2, false);
}

export function soldier_attack3_refire(self: EdictT): void {
  if (self.dmg !== 0) monster_duck_hold(self);
  else if (Gtime_add(level.time, Gtime_from_ms(400)) < self.monsterinfo.duck_wait_time) self.monsterinfo.nextframe = FRAME_attak303;
}

const soldier_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 0, monster_duck_down),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_charge, 0, soldier_fire3),
  mkframe(ai_charge, 0, soldierh_hyperripper3),
  mkframe(ai_charge, 0, soldierh_hyperripper3),
  mkframe(ai_charge, 0, soldier_attack3_refire),
  mkframe(ai_charge, 0, monster_duck_up),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_end),
  mkframe(ai_charge),
];
export const soldier_move_attack3 = RegisterMmove("soldier_move_attack3", mkMove(FRAME_attak301, FRAME_attak309, soldier_frames_attack3, soldier_run));

// ATTACK4 (machinegun)

export function soldier_fire4(self: EdictT): void {
  soldier_fire(self, 3, false);
}

const soldier_frames_attack4: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_charge, 0, soldier_fire4),
  mkframe(ai_charge, 0, soldierh_hyper_laser_sound_end),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
export const soldier_move_attack4 = RegisterMmove("soldier_move_attack4", mkMove(FRAME_attak401, FRAME_attak406, soldier_frames_attack4, soldier_run));

// ATTACK6 (run & shoot)

export function soldier_fire8(self: EdictT): void {
  soldier_fire(self, 7, true);
}

export function soldier_attack6_refire1(self: EdictT): void {
  monster_done_dodge(self);
  soldier_stop_charge(self);

  const enemy = self.enemy;
  if (enemy === null) return;
  if (self.count > 1) return;

  if (enemy.health <= 0 || range_to(self, enemy) < RANGE_NEAR || !visible(self, enemy)) {
    soldier_run(self);
    return;
  }

  if (Math.random() < 0.25) self.monsterinfo.nextframe = FRAME_runs03;
  else soldier_run(self);
}

export function soldier_attack6_refire2(self: EdictT): void {
  monster_done_dodge(self);
  soldier_stop_charge(self);

  const enemy = self.enemy;
  if (enemy === null || self.count <= 0) return;

  if (enemy.health <= 0 || (self.radius_dmg === 0 && range_to(self, enemy) < RANGE_NEAR) || !visible(self, enemy)) {
    soldierh_hyper_laser_sound_end(self);
    return;
  }

  if (self.radius_dmg !== 0 || Math.random() < 0.25) {
    self.monsterinfo.nextframe = FRAME_runs03;
    self.radius_dmg = 0;
  }
}

function soldier_attack6_shotgun_check(self: EdictT): void {
  if (self.dmg !== 0) {
    self.monsterinfo.nextframe = FRAME_runs09;
    self.radius_dmg = 1;
  }
}

function soldierh_hyperripper8(self: EdictT): void {
  if (self.s.skinnum >= 6 && self.count < 4) soldier_fire(self, 7, true);
}

const soldier_frames_attack6: MframeT[] = [
  mkframe(ai_run, 10, soldier_start_charge),
  mkframe(ai_run, 4, soldier_attack6_shotgun_check),
  mkframe(ai_run, 12, soldierh_hyper_laser_sound_start),
  mkframe(ai_run, 11, (self) => {
    soldier_fire8(self);
    monster_footstep(self);
  }),
  mkframe(ai_run, 13, (self) => {
    soldierh_hyperripper8(self);
    monster_done_dodge(self);
  }),
  mkframe(ai_run, 18, soldierh_hyperripper8),
  mkframe(ai_run, 15, monster_footstep),
  mkframe(ai_run, 14, soldier_attack6_refire1),
  mkframe(ai_run, 11),
  mkframe(ai_run, 8, monster_footstep),
  mkframe(ai_run, 11, soldier_cock),
  mkframe(ai_run, 12),
  mkframe(ai_run, 12, monster_footstep),
  mkframe(ai_run, 17, soldier_attack6_refire2),
];
export const soldier_move_attack6 = RegisterMmove("soldier_move_attack6", mkMove(FRAME_runs01, FRAME_runs14, soldier_frames_attack6, soldier_run, 0.65));

export function soldier_attack(self: EdictT): void {
  monster_done_dodge(self);

  // PMM - blindfire!
  if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_BLIND) {
    let chance: number;
    if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(1)) chance = 1.0;
    else if (self.monsterinfo.blind_fire_delay < Gtime_from_sec(7.5)) chance = 0.4;
    else chance = 0.1;

    const r = Math.random();

    self.monsterinfo.blind_fire_delay = Gtime_add(self.monsterinfo.blind_fire_delay, Gtime_add(Gtime_from_sec(4.1), random_time(Gtime_from_sec(3))));

    if (!vec3_any_nonzero(self.monsterinfo.blind_fire_target)) return;
    if (r > chance) return;

    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_MANUAL_STEERING;

    if (self.style === 1) M_SetAnimation(self, soldierh_move_attack1, true);
    else M_SetAnimation(self, soldier_move_attack1, true);
    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(1.5), Gtime_from_sec(2.5)));
    return;
  }

  const enemy = self.enemy;
  if (enemy === null) return;

  const r = Math.random();

  if (
    (self.monsterinfo.aiflags & (MonsterAiFlagsT.AI_BLOCKED | MonsterAiFlagsT.AI_STAND_GROUND)) === 0n &&
    r < 0.25 &&
    self.count <= 3 &&
    range_to(self, enemy) >= RANGE_NEAR * 0.5
  ) {
    M_SetAnimation(self, soldier_move_attack6, true);
  } else {
    if (self.count < 4) {
      let attack1_possible: boolean;

      if (self.style === 0 && self.count >= 2 && self.count <= 3 && range_to(self, enemy) <= RANGE_NEAR * 0.65) attack1_possible = false;
      else attack1_possible = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_1]);

      const attack2_possible = M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SOLDIER_BLASTER_2]);

      if (attack1_possible && (!attack2_possible || Math.random() < 0.5)) {
        if (self.style === 1) M_SetAnimation(self, soldierh_move_attack1, true);
        else M_SetAnimation(self, soldier_move_attack1, true);
      } else if (attack2_possible) {
        if (self.style === 1) M_SetAnimation(self, soldierh_move_attack2, true);
        else M_SetAnimation(self, soldier_move_attack2, true);
      }
    } else if (M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_4])) {
      M_SetAnimation(self, soldier_move_attack4, true);
    }
  }
}
RegisterMonsterinfoAttack("soldier_attack", soldier_attack);

// ---------------------------------------------------------------------------
// SIGHT (m_soldier.cpp:1224-1249)
// ---------------------------------------------------------------------------

export function soldier_sight(self: EdictT, other: EdictT): void {
  if (Math.random() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight1.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight2.index, 1, ATTN_NORM, 0);

  const enemy = self.enemy;
  if (enemy !== null && range_to(self, enemy) >= RANGE_NEAR && visible(self, enemy)) {
    if (self.style === 1 || Math.random() > 0.75) {
      if (self.count < 4) M_SetAnimation(self, soldier_move_attack6, true);
      else if (M_CheckClearShot(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_SOLDIER_MACHINEGUN_4])) M_SetAnimation(self, soldier_move_attack4, true);
    }
  }
  void other;
}
RegisterMonsterinfoSight("soldier_sight", soldier_sight);

// ---------------------------------------------------------------------------
// DUCK (m_soldier.cpp:1252-1360)
// ---------------------------------------------------------------------------

const soldier_frames_duck: MframeT[] = [
  mkframe(ai_move, 5, monster_duck_down),
  mkframe(ai_move, -1, monster_duck_hold),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0, monster_duck_up),
  mkframe(ai_move, 5),
];
export const soldier_move_duck = RegisterMmove("soldier_move_duck", mkMove(FRAME_duck01, FRAME_duck05, soldier_frames_duck, soldier_run));

export function soldier_stand_up(self: EdictT): void {
  soldierh_hyper_laser_sound_end(self);
  M_SetAnimation(self, soldier_move_trip, false);
  self.monsterinfo.nextframe = FRAME_runt08;
}

function soldier_prone_shoot_ok(self: EdictT): boolean {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return false;

  const fwd = vec3(0, 0, 0);
  AngleVectors(self.s.angles, fwd, null, null);

  let diff = vec3_sub(enemy.s.origin, self.s.origin);
  diff = vec3(diff[0], diff[1], 0);
  diff = vec3_normalized(diff);

  const v = vec3_dot(fwd, diff);
  return v >= 0.8;
}

function ai_soldier_move(self: EdictT, dist: number): void {
  ai_move(self, dist);

  if (!soldier_prone_shoot_ok(self)) {
    soldier_stand_up(self);
  }
}

export function soldier_fire5(self: EdictT): void {
  soldier_fire(self, 8, true);
}

function soldierh_hyperripper5(self: EdictT): void {
  if (self.style !== 0 && self.count < 4) soldier_fire(self, 8, true);
}

const soldier_frames_attack5: MframeT[] = [
  mkframe(ai_move, 18, monster_duck_down),
  mkframe(ai_move, 11, monster_footstep),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_soldier_move),
  mkframe(ai_soldier_move, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_soldier_move, 0, soldier_fire5),
  mkframe(ai_soldier_move, 0, soldierh_hyperripper5),
  mkframe(ai_soldier_move, 0, soldierh_hyperripper5),
];
export const soldier_move_attack5 = RegisterMmove("soldier_move_attack5", mkMove(FRAME_attak501, FRAME_attak508, soldier_frames_attack5, soldier_stand_up));

function monster_check_prone(self: EdictT): void {
  // we're a shotgun guard waiting to cock
  if (self.style === 0 && self.count >= 2 && self.count <= 3 && self.dmg !== 0) return;

  if (!soldier_prone_shoot_ok(self)) return;

  M_SetAnimation(self, soldier_move_attack5, false);
}

const soldier_frames_trip: MframeT[] = [
  mkframe(ai_move, 10),
  mkframe(ai_move, 2, monster_check_prone),
  mkframe(ai_move, 18, monster_duck_down),
  mkframe(ai_move, 11, monster_footstep),
  mkframe(ai_move, 9),
  mkframe(ai_move, -11, monster_footstep),
  mkframe(ai_move, -2),
  mkframe(ai_move, 0),
  mkframe(ai_move, 6),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0),
  mkframe(ai_move, 1),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_move, 0, monster_duck_up),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2, monster_footstep),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),
  mkframe(ai_move, 0),
];
export const soldier_move_trip = RegisterMmove("soldier_move_trip", mkMove(FRAME_runt01, FRAME_runt19, soldier_frames_trip, soldier_run));

// ---------------------------------------------------------------------------
// BLOCKED (m_soldier.cpp:1362-1371)
// ---------------------------------------------------------------------------

export function soldier_blocked(self: EdictT, dist: number): boolean {
  if ((self.monsterinfo.aiflags & (MonsterAiFlagsT.AI_DODGING | MonsterAiFlagsT.AI_DUCKED)) !== 0n) return false;
  return blocked_checkplat(self, dist);
}
RegisterMonsterinfoBlocked("soldier_blocked", soldier_blocked);

// ---------------------------------------------------------------------------
// DEATH (m_soldier.cpp:1377-1730)
// ---------------------------------------------------------------------------

export function soldier_fire6(self: EdictT): void {
  soldier_fire(self, 5, false);
  if (self.dmg !== 0) self.monsterinfo.nextframe = FRAME_death126;
}

export function soldier_fire7(self: EdictT): void {
  soldier_fire(self, 6, false);
}

export function soldier_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  monster_dead(self);
}
RegisterThink("soldier_dead", soldier_dead);

function soldier_death_shrink(self: EdictT): void {
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  self.maxs[2] = 0;
  gi.linkentity(self);
}

const soldier_frames_death1: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10, soldier_death_shrink),
  mkframe(ai_move, -5),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move, 0, soldierh_hyper_laser_sound_start),
  mkframe(ai_move, 0, soldier_fire6),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, soldier_fire7),
  mkframe(ai_move, 0, soldierh_hyper_laser_sound_end),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_death1 = RegisterMmove("soldier_move_death1", mkMove(FRAME_death101, FRAME_death136, soldier_frames_death1, soldier_dead));

const soldier_frames_death2: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0, soldier_death_shrink),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_death2 = RegisterMmove("soldier_move_death2", mkMove(FRAME_death201, FRAME_death235, soldier_frames_death2, soldier_dead));

const soldier_frames_death3: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0, soldier_death_shrink),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_death3 = RegisterMmove("soldier_move_death3", mkMove(FRAME_death301, FRAME_death345, soldier_frames_death3, soldier_dead));

const soldier_frames_death4: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 1.5),
  mkframe(ai_move, 2.5),
  mkframe(ai_move, -1.5),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -0.5),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move, 4.0),
  mkframe(ai_move, 4.0),
  mkframe(ai_move, 8.0, soldier_death_shrink),
  mkframe(ai_move, 8.0),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 5.5),

  mkframe(ai_move, 2.5),
  mkframe(ai_move, -2.0),
  mkframe(ai_move, -2.0),
];
export const soldier_move_death4 = RegisterMmove("soldier_move_death4", mkMove(FRAME_death401, FRAME_death453, soldier_frames_death4, soldier_dead));

const soldier_frames_death5: MframeT[] = [
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, soldier_death_shrink),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_death5 = RegisterMmove("soldier_move_death5", mkMove(FRAME_death501, FRAME_death524, soldier_frames_death5, soldier_dead));

const soldier_frames_death6: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, soldier_death_shrink),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_death6 = RegisterMmove("soldier_move_death6", mkMove(FRAME_death601, FRAME_death610, soldier_frames_death6, soldier_dead));

export function soldier_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, point: Vec3, mod: ModT): void {
  soldierh_hyper_laser_sound_end(self);

  // check for gib
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    if (self.beam !== null) {
      G_FreeEdict(self.beam);
      self.beam = null;
    }

    ThrowGibs(self, damage, [
      { count: 3, gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { gibname: "models/objects/gibs/bone2/tris.md2" },
      { gibname: "models/objects/gibs/bone/tris.md2" },
      { gibname: "models/monsters/soldier/gibs/arm.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/soldier/gibs/gun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/soldier/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/soldier/gibs/head.md2", type: GibTypeT.GIB_HEAD | GibTypeT.GIB_SKINNED },
    ]);
    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  self.deadflag = true;
  self.takedamage = true;

  let n = self.count | 1;

  if (n === 1) gi.sound(self, SoundchanT.CHAN_VOICE, sound_death_light.index, 1, ATTN_NORM, 0);
  else if (n === 3) gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_death_ss.index, 1, ATTN_NORM, 0);

  if (Math.abs(self.s.origin[2] + self.viewheight - point[2]) <= 4 && self.velocity[2] < 65) {
    // head shot
    M_SetAnimation(self, soldier_move_death3, true);
    return;
  }

  // if we die while on the ground, do a quicker death4
  if (self.monsterinfo.active_move === soldier_move_trip || self.monsterinfo.active_move === soldier_move_attack5) {
    M_SetAnimation(self, soldier_move_death4, true);
    self.monsterinfo.nextframe = FRAME_death413;
    soldier_death_shrink(self);
    return;
  }

  // only do the spin-death if we have enough velocity to justify it
  if (self.velocity[2] > 65 || vec3_length(self.velocity) > 150) n = irandom(5);
  else n = irandom(4);

  if (n === 0) M_SetAnimation(self, soldier_move_death1, true);
  else if (n === 1) M_SetAnimation(self, soldier_move_death2, true);
  else if (n === 2) M_SetAnimation(self, soldier_move_death4, true);
  else if (n === 3) M_SetAnimation(self, soldier_move_death5, true);
  else M_SetAnimation(self, soldier_move_death6, true);
}
RegisterDie("soldier_die", soldier_die);

// ---------------------------------------------------------------------------
// NEW DODGE CODE (m_soldier.cpp:1736-1784)
// ---------------------------------------------------------------------------

export function soldier_sidestep(self: EdictT): boolean {
  if (self.monsterinfo.active_move === soldier_move_trip || self.monsterinfo.active_move === soldier_move_attack5 || self.monsterinfo.active_move === soldier_move_pain4) {
    return false;
  }

  if (self.count <= 3) {
    if (self.monsterinfo.active_move !== soldier_move_attack6) {
      M_SetAnimation(self, soldier_move_attack6, true);
      soldierh_hyper_laser_sound_end(self);
    }
  } else {
    if (self.monsterinfo.active_move !== soldier_move_start_run && self.monsterinfo.active_move !== soldier_move_run) {
      M_SetAnimation(self, soldier_move_start_run, true);
      soldierh_hyper_laser_sound_end(self);
    }
  }

  return true;
}
RegisterMonsterinfoSidestep("soldier_sidestep", soldier_sidestep);

export function soldier_duck(self: EdictT, _eta: GTime): boolean {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_HOLD_FRAME;

  if (self.monsterinfo.active_move === soldier_move_attack6) {
    M_SetAnimation(self, soldier_move_trip, true);
  } else if (self.dmg !== 0 || brandom()) {
    M_SetAnimation(self, soldier_move_duck, true);
  } else {
    M_SetAnimation(self, soldier_move_attack3, true);
  }

  soldierh_hyper_laser_sound_end(self);
  return true;
}
RegisterMonsterinfoDuck("soldier_duck", soldier_duck);

// ---------------------------------------------------------------------------
// ROGUE: blind stand (m_soldier.cpp:1787-1831)
// ---------------------------------------------------------------------------

const soldier_frames_blind: MframeT[] = [
  mkframe(ai_move, 0, soldier_idle),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const soldier_move_blind = RegisterMmove("soldier_move_blind", mkMove(FRAME_stand101, FRAME_stand130, soldier_frames_blind, soldier_blind));

export function soldier_blind(self: EdictT): void {
  M_SetAnimation(self, soldier_move_blind, true);
}
RegisterMonsterinfoStand("soldier_blind", soldier_blind);

// ---------------------------------------------------------------------------
// SPAWN (m_soldier.cpp:1834-2049)
// ---------------------------------------------------------------------------

const SPAWNFLAG_MONSTER_DEAD_LOCAL: SpawnFlags = SpawnFlags_from(1 << 16);
const SPAWNFLAG_SOLDIER_BLIND: SpawnFlags = SpawnFlags_from(8);

export function SP_monster_soldier_x(self: EdictT): void {
  self.s.modelindex = gi.modelindex("models/monsters/soldier/tris.md2");
  self.monsterinfo.scale = MODEL_SCALE;
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  assignSound(sound_idle, "soldier/solidle1.wav");
  assignSound(sound_sight1, "soldier/solsght1.wav");
  assignSound(sound_sight2, "soldier/solsrch1.wav");
  assignSound(sound_cock, "infantry/infatck3.wav");

  gi.modelindex("models/monsters/soldier/gibs/head.md2");
  gi.modelindex("models/monsters/soldier/gibs/gun.md2");
  gi.modelindex("models/monsters/soldier/gibs/arm.md2");
  gi.modelindex("models/monsters/soldier/gibs/chest.md2");

  self.mass = 100;

  self.pain = soldier_pain;
  self.die = soldier_die;

  self.monsterinfo.stand = soldier_stand;
  self.monsterinfo.walk = soldier_walk;
  self.monsterinfo.run = soldier_run;
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.attack = soldier_attack;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = soldier_sight;
  self.monsterinfo.setskin = soldier_setskin;

  //=====
  // ROGUE
  self.monsterinfo.blocked = soldier_blocked;
  self.monsterinfo.duck = soldier_duck;
  self.monsterinfo.unduck = monster_duck_up;
  self.monsterinfo.sidestep = soldier_sidestep;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_SOLDIER_BLIND)) self.monsterinfo.stand = soldier_blind;
  // ROGUE
  //=====

  gi.linkentity(self);

  const stand = self.monsterinfo.stand;
  if (stand !== null) stand(self);

  walkmonster_start(self);
}

export function SP_monster_soldier_vanilla(self: EdictT): void {
  SP_monster_soldier_x(self);
}

/*QUAKED monster_soldier_light (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_light(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  assignSound(sound_pain_light, "soldier/solpain2.wav");
  assignSound(sound_death_light, "soldier/soldeth2.wav");
  gi.modelindex("models/objects/laser/tris.md2");
  gi.soundindex("misc/lasfly.wav");
  gi.soundindex("soldier/solatck2.wav");

  self.s.skinnum = 0;
  self.count = self.s.skinnum;
  self.health = self.max_health = 20 * healthMultiplier(self);
  self.gib_health = -30;

  // PMM - blindfire
  self.monsterinfo.blindfire = true;
}

/*QUAKED monster_soldier (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  assignSound(sound_pain, "soldier/solpain1.wav");
  assignSound(sound_death, "soldier/soldeth1.wav");
  gi.soundindex("soldier/solatck1.wav");

  self.s.skinnum = 2;
  self.count = self.s.skinnum;
  self.health = self.max_health = 30 * healthMultiplier(self);
  self.gib_health = -30;
}

/*QUAKED monster_soldier_ss (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_ss(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_x(self);

  assignSound(sound_pain_ss, "soldier/solpain3.wav");
  assignSound(sound_death_ss, "soldier/soldeth3.wav");
  gi.soundindex("soldier/solatck3.wav");

  self.s.skinnum = 4;
  self.count = self.s.skinnum;
  self.health = self.max_health = 40 * healthMultiplier(self);
  self.gib_health = -30;
}

export function SP_monster_soldier_h(self: EdictT): void {
  SP_monster_soldier_x(self);
  self.style = 1;
}

/*QUAKED monster_soldier_ripper (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_ripper(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  assignSound(sound_pain_light, "soldier/solpain2.wav");
  assignSound(sound_death_light, "soldier/soldeth2.wav");

  gi.modelindex("models/objects/boomrang/tris.md2");
  gi.soundindex("misc/lasfly.wav");
  gi.soundindex("soldier/solatck2.wav");

  self.s.skinnum = 6;
  self.count = self.s.skinnum - 6;
  self.health = self.max_health = 50 * healthMultiplier(self);
  self.gib_health = -30;

  self.monsterinfo.blindfire = true;
}

/*QUAKED monster_soldier_hypergun (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_hypergun(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  gi.modelindex("models/objects/laser/tris.md2");
  assignSound(sound_pain, "soldier/solpain1.wav");
  assignSound(sound_death, "soldier/soldeth1.wav");
  gi.soundindex("soldier/solatck1.wav");
  gi.soundindex("weapons/hyprbd1a.wav");
  gi.soundindex("weapons/hyprbl1a.wav");

  self.s.skinnum = 8;
  self.count = self.s.skinnum - 6;
  self.health = self.max_health = 60 * healthMultiplier(self);
  self.gib_health = -30;

  self.monsterinfo.blindfire = true;
}

/*QUAKED monster_soldier_lasergun (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_soldier_lasergun(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  SP_monster_soldier_h(self);

  assignSound(sound_pain_ss, "soldier/solpain3.wav");
  assignSound(sound_death_ss, "soldier/soldeth3.wav");
  gi.soundindex("soldier/solatck3.wav");

  self.s.skinnum = 10;
  self.count = self.s.skinnum - 6;
  self.health = self.max_health = 70 * healthMultiplier(self);
  self.gib_health = -30;
}

/**
 * `st.health_multiplier` (g_local.h:1306, `= 1.0f` default) -- this port
 * line's `st` spawn_temp_t global has no single owning module yet
 * (g_turret.ts/g_misc.ts/g_func.ts each keep a permanently-defaulted local
 * copy per their own file headers). Matching that established convention:
 * a local, permanently-1.0 stand-in (SP_monster_soldier_x's real callers
 * are invoked directly by game code/tests in this port line, never through
 * a live `st` parsed from a map entity block, so `st.health_multiplier` is
 * always its default here).
 */
function healthMultiplier(_self: EdictT): number {
  return 1.0;
}

// END 13-APR-98
