// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_boss32.c -- Makron, the Final Boss (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_boss32.cpp (827 lines) +
// m_boss32.h (502 lines, frame-index enum + MODEL_SCALE -- the biggest frame
// table of this porting batch: 491 FRAME_ constants), C++17. Owns
// `MakronToss`/`MakronSpawn`/`MakronPrecache`, the cross-file wiring Jorg's
// death (`m_boss31.ts`'s `jorg_dead`) calls into to launch the final boss --
// matching the split already established by the legacy 3.21 port at
// `src/game/m_boss31.ts`/`m_boss32.ts`.
//
// ============================================================================
// FRAME-TABLE QUIRK (bug-for-bug, not a porting mistake)
// ============================================================================
// `makron_frames_walk[]` (m_boss32.cpp:168-179) is defined but NEVER
// referenced -- `makron_move_walk`'s `MMOVE_T` (m_boss32.cpp:180) points at
// `makron_frames_run` instead (the two arrays are otherwise identical except
// `ai_walk` vs `ai_run`). Ported faithfully as dead code: `makron_frames_walk`
// exists below, exported so it isn't flagged unused, but `makron_move_walk`
// wires to `makron_frames_run` exactly like the source. Similarly, the frame
// ranges `FRAME_walk201-203`/`FRAME_walk214-217`, `FRAME_stand01-51` (Jorg's
// own stand range, reused verbatim in this shared rider skeleton's enum),
// and `FRAME_jump01-13`/`FRAME_death301-320` are declared in `m_boss32.h`
// but never referenced by any `mmove_t` in this file (`makron_frames_death3`
// -- the only would-be user of `FRAME_death301-320` -- is `#if 0`-guarded,
// m_boss32.cpp:388-412, and dropped silently per this port line's `#if 0`
// convention).
//
// ============================================================================
// LOCALLY-PORTED SHARED INFRA
// ============================================================================
// `M_CheckGib` (g_local.h:3521-3529) is duplicated locally, unexported,
// matching m_soldier.ts's own placement-mismatch treatment for the same
// inline C++ function.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - Vec3 arithmetic chains use q_vec3.ts's functional helpers, not C++
//   operator overloads.
// - `mkframe`/`mkMove` are small local builders for `MframeT`/`MmoveT`,
//   matching m_soldier.ts's/m_boss31.ts's precedent exactly.
// - `M_SetAnimation`'s C++ default `instant = true` (g_local.h:2211) is
//   passed explicitly at every call site (this file's port has no default),
//   matching every real call site's omission of the argument in the C++.
// - `MakronToss`'s loop `for (size_t i = 0; i < 2; i++)` over
//   `level.health_bar_entities` uses the literal `2` (matching the C++
//   exactly), not `level.health_bar_entities.length`, even though both are
//   presently equal -- bug-for-bug fidelity over derived-value "cleanup".
// - `MakronSpawn`'s trailing `self.s.frame = self.monsterinfo.nextframe =
//   FRAME_active01; // FIXME: why????` keeps the source's own `FIXME`
//   comment verbatim -- this is the original author's own uncertainty about
//   the line, not a porting note.

import { type Vec3, vec3 } from "../shared/math";
import { AngleVectors, vectoangles, vectoyaw, vec3_add, vec3_sub, vec3_muls, vec3_normalized } from "./q_vec3";
import { MonsterMuzzleflashIdT, EffectsT, SolidT, SvflagsT, SoundchanT, ATTN_NORM, ATTN_NONE } from "../kexapi/game";
import { ServerCommandT, KexMulticastT } from "../kexapi/game";
import {
  type EdictT,
  MonsterAiFlagsT,
  MovetypeT,
  ModIdT,
  GibTypeT,
} from "./g_local";
import { gi, level } from "./g_main_globals";
import { st } from "./g_spawn";
import type { ModT } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterThink,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, AI_GetSightClient, M_CheckAttack_Base, FoundTarget } from "./g_ai";
import {
  M_ShouldReactToPain,
  monster_fire_blaster,
  monster_fire_railgun,
  monster_fire_bfg,
  M_ProjectFlashSource,
  M_SetAnimation,
  M_AllowSpawn,
  monster_dead,
  walkmonster_start,
} from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGib, ThrowGibs } from "./g_misc";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { frandom } from "./q_std";

// ---------------------------------------------------------------------------
// m_boss32.h frame-index enum (502 lines; anonymous enum, declaration order
// = array index, starting at 0; 491 entries total) + MODEL_SCALE.
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
export const FRAME_attak113 = 12;
export const FRAME_attak114 = 13;
export const FRAME_attak115 = 14;
export const FRAME_attak116 = 15;
export const FRAME_attak117 = 16;
export const FRAME_attak118 = 17;
export const FRAME_attak201 = 18;
export const FRAME_attak202 = 19;
export const FRAME_attak203 = 20;
export const FRAME_attak204 = 21;
export const FRAME_attak205 = 22;
export const FRAME_attak206 = 23;
export const FRAME_attak207 = 24;
export const FRAME_attak208 = 25;
export const FRAME_attak209 = 26;
export const FRAME_attak210 = 27;
export const FRAME_attak211 = 28;
export const FRAME_attak212 = 29;
export const FRAME_attak213 = 30;
export const FRAME_death01 = 31;
export const FRAME_death02 = 32;
export const FRAME_death03 = 33;
export const FRAME_death04 = 34;
export const FRAME_death05 = 35;
export const FRAME_death06 = 36;
export const FRAME_death07 = 37;
export const FRAME_death08 = 38;
export const FRAME_death09 = 39;
export const FRAME_death10 = 40;
export const FRAME_death11 = 41;
export const FRAME_death12 = 42;
export const FRAME_death13 = 43;
export const FRAME_death14 = 44;
export const FRAME_death15 = 45;
export const FRAME_death16 = 46;
export const FRAME_death17 = 47;
export const FRAME_death18 = 48;
export const FRAME_death19 = 49;
export const FRAME_death20 = 50;
export const FRAME_death21 = 51;
export const FRAME_death22 = 52;
export const FRAME_death23 = 53;
export const FRAME_death24 = 54;
export const FRAME_death25 = 55;
export const FRAME_death26 = 56;
export const FRAME_death27 = 57;
export const FRAME_death28 = 58;
export const FRAME_death29 = 59;
export const FRAME_death30 = 60;
export const FRAME_death31 = 61;
export const FRAME_death32 = 62;
export const FRAME_death33 = 63;
export const FRAME_death34 = 64;
export const FRAME_death35 = 65;
export const FRAME_death36 = 66;
export const FRAME_death37 = 67;
export const FRAME_death38 = 68;
export const FRAME_death39 = 69;
export const FRAME_death40 = 70;
export const FRAME_death41 = 71;
export const FRAME_death42 = 72;
export const FRAME_death43 = 73;
export const FRAME_death44 = 74;
export const FRAME_death45 = 75;
export const FRAME_death46 = 76;
export const FRAME_death47 = 77;
export const FRAME_death48 = 78;
export const FRAME_death49 = 79;
export const FRAME_death50 = 80;
export const FRAME_pain101 = 81;
export const FRAME_pain102 = 82;
export const FRAME_pain103 = 83;
export const FRAME_pain201 = 84;
export const FRAME_pain202 = 85;
export const FRAME_pain203 = 86;
export const FRAME_pain301 = 87;
export const FRAME_pain302 = 88;
export const FRAME_pain303 = 89;
export const FRAME_pain304 = 90;
export const FRAME_pain305 = 91;
export const FRAME_pain306 = 92;
export const FRAME_pain307 = 93;
export const FRAME_pain308 = 94;
export const FRAME_pain309 = 95;
export const FRAME_pain310 = 96;
export const FRAME_pain311 = 97;
export const FRAME_pain312 = 98;
export const FRAME_pain313 = 99;
export const FRAME_pain314 = 100;
export const FRAME_pain315 = 101;
export const FRAME_pain316 = 102;
export const FRAME_pain317 = 103;
export const FRAME_pain318 = 104;
export const FRAME_pain319 = 105;
export const FRAME_pain320 = 106;
export const FRAME_pain321 = 107;
export const FRAME_pain322 = 108;
export const FRAME_pain323 = 109;
export const FRAME_pain324 = 110;
export const FRAME_pain325 = 111;
export const FRAME_stand01 = 112;
export const FRAME_stand02 = 113;
export const FRAME_stand03 = 114;
export const FRAME_stand04 = 115;
export const FRAME_stand05 = 116;
export const FRAME_stand06 = 117;
export const FRAME_stand07 = 118;
export const FRAME_stand08 = 119;
export const FRAME_stand09 = 120;
export const FRAME_stand10 = 121;
export const FRAME_stand11 = 122;
export const FRAME_stand12 = 123;
export const FRAME_stand13 = 124;
export const FRAME_stand14 = 125;
export const FRAME_stand15 = 126;
export const FRAME_stand16 = 127;
export const FRAME_stand17 = 128;
export const FRAME_stand18 = 129;
export const FRAME_stand19 = 130;
export const FRAME_stand20 = 131;
export const FRAME_stand21 = 132;
export const FRAME_stand22 = 133;
export const FRAME_stand23 = 134;
export const FRAME_stand24 = 135;
export const FRAME_stand25 = 136;
export const FRAME_stand26 = 137;
export const FRAME_stand27 = 138;
export const FRAME_stand28 = 139;
export const FRAME_stand29 = 140;
export const FRAME_stand30 = 141;
export const FRAME_stand31 = 142;
export const FRAME_stand32 = 143;
export const FRAME_stand33 = 144;
export const FRAME_stand34 = 145;
export const FRAME_stand35 = 146;
export const FRAME_stand36 = 147;
export const FRAME_stand37 = 148;
export const FRAME_stand38 = 149;
export const FRAME_stand39 = 150;
export const FRAME_stand40 = 151;
export const FRAME_stand41 = 152;
export const FRAME_stand42 = 153;
export const FRAME_stand43 = 154;
export const FRAME_stand44 = 155;
export const FRAME_stand45 = 156;
export const FRAME_stand46 = 157;
export const FRAME_stand47 = 158;
export const FRAME_stand48 = 159;
export const FRAME_stand49 = 160;
export const FRAME_stand50 = 161;
export const FRAME_stand51 = 162;
export const FRAME_walk01 = 163;
export const FRAME_walk02 = 164;
export const FRAME_walk03 = 165;
export const FRAME_walk04 = 166;
export const FRAME_walk05 = 167;
export const FRAME_walk06 = 168;
export const FRAME_walk07 = 169;
export const FRAME_walk08 = 170;
export const FRAME_walk09 = 171;
export const FRAME_walk10 = 172;
export const FRAME_walk11 = 173;
export const FRAME_walk12 = 174;
export const FRAME_walk13 = 175;
export const FRAME_walk14 = 176;
export const FRAME_walk15 = 177;
export const FRAME_walk16 = 178;
export const FRAME_walk17 = 179;
export const FRAME_walk18 = 180;
export const FRAME_walk19 = 181;
export const FRAME_walk20 = 182;
export const FRAME_walk21 = 183;
export const FRAME_walk22 = 184;
export const FRAME_walk23 = 185;
export const FRAME_walk24 = 186;
export const FRAME_walk25 = 187;
export const FRAME_active01 = 188;
export const FRAME_active02 = 189;
export const FRAME_active03 = 190;
export const FRAME_active04 = 191;
export const FRAME_active05 = 192;
export const FRAME_active06 = 193;
export const FRAME_active07 = 194;
export const FRAME_active08 = 195;
export const FRAME_active09 = 196;
export const FRAME_active10 = 197;
export const FRAME_active11 = 198;
export const FRAME_active12 = 199;
export const FRAME_active13 = 200;
export const FRAME_attak301 = 201;
export const FRAME_attak302 = 202;
export const FRAME_attak303 = 203;
export const FRAME_attak304 = 204;
export const FRAME_attak305 = 205;
export const FRAME_attak306 = 206;
export const FRAME_attak307 = 207;
export const FRAME_attak308 = 208;
export const FRAME_attak401 = 209;
export const FRAME_attak402 = 210;
export const FRAME_attak403 = 211;
export const FRAME_attak404 = 212;
export const FRAME_attak405 = 213;
export const FRAME_attak406 = 214;
export const FRAME_attak407 = 215;
export const FRAME_attak408 = 216;
export const FRAME_attak409 = 217;
export const FRAME_attak410 = 218;
export const FRAME_attak411 = 219;
export const FRAME_attak412 = 220;
export const FRAME_attak413 = 221;
export const FRAME_attak414 = 222;
export const FRAME_attak415 = 223;
export const FRAME_attak416 = 224;
export const FRAME_attak417 = 225;
export const FRAME_attak418 = 226;
export const FRAME_attak419 = 227;
export const FRAME_attak420 = 228;
export const FRAME_attak421 = 229;
export const FRAME_attak422 = 230;
export const FRAME_attak423 = 231;
export const FRAME_attak424 = 232;
export const FRAME_attak425 = 233;
export const FRAME_attak426 = 234;
export const FRAME_attak501 = 235;
export const FRAME_attak502 = 236;
export const FRAME_attak503 = 237;
export const FRAME_attak504 = 238;
export const FRAME_attak505 = 239;
export const FRAME_attak506 = 240;
export const FRAME_attak507 = 241;
export const FRAME_attak508 = 242;
export const FRAME_attak509 = 243;
export const FRAME_attak510 = 244;
export const FRAME_attak511 = 245;
export const FRAME_attak512 = 246;
export const FRAME_attak513 = 247;
export const FRAME_attak514 = 248;
export const FRAME_attak515 = 249;
export const FRAME_attak516 = 250;
export const FRAME_death201 = 251;
export const FRAME_death202 = 252;
export const FRAME_death203 = 253;
export const FRAME_death204 = 254;
export const FRAME_death205 = 255;
export const FRAME_death206 = 256;
export const FRAME_death207 = 257;
export const FRAME_death208 = 258;
export const FRAME_death209 = 259;
export const FRAME_death210 = 260;
export const FRAME_death211 = 261;
export const FRAME_death212 = 262;
export const FRAME_death213 = 263;
export const FRAME_death214 = 264;
export const FRAME_death215 = 265;
export const FRAME_death216 = 266;
export const FRAME_death217 = 267;
export const FRAME_death218 = 268;
export const FRAME_death219 = 269;
export const FRAME_death220 = 270;
export const FRAME_death221 = 271;
export const FRAME_death222 = 272;
export const FRAME_death223 = 273;
export const FRAME_death224 = 274;
export const FRAME_death225 = 275;
export const FRAME_death226 = 276;
export const FRAME_death227 = 277;
export const FRAME_death228 = 278;
export const FRAME_death229 = 279;
export const FRAME_death230 = 280;
export const FRAME_death231 = 281;
export const FRAME_death232 = 282;
export const FRAME_death233 = 283;
export const FRAME_death234 = 284;
export const FRAME_death235 = 285;
export const FRAME_death236 = 286;
export const FRAME_death237 = 287;
export const FRAME_death238 = 288;
export const FRAME_death239 = 289;
export const FRAME_death240 = 290;
export const FRAME_death241 = 291;
export const FRAME_death242 = 292;
export const FRAME_death243 = 293;
export const FRAME_death244 = 294;
export const FRAME_death245 = 295;
export const FRAME_death246 = 296;
export const FRAME_death247 = 297;
export const FRAME_death248 = 298;
export const FRAME_death249 = 299;
export const FRAME_death250 = 300;
export const FRAME_death251 = 301;
export const FRAME_death252 = 302;
export const FRAME_death253 = 303;
export const FRAME_death254 = 304;
export const FRAME_death255 = 305;
export const FRAME_death256 = 306;
export const FRAME_death257 = 307;
export const FRAME_death258 = 308;
export const FRAME_death259 = 309;
export const FRAME_death260 = 310;
export const FRAME_death261 = 311;
export const FRAME_death262 = 312;
export const FRAME_death263 = 313;
export const FRAME_death264 = 314;
export const FRAME_death265 = 315;
export const FRAME_death266 = 316;
export const FRAME_death267 = 317;
export const FRAME_death268 = 318;
export const FRAME_death269 = 319;
export const FRAME_death270 = 320;
export const FRAME_death271 = 321;
export const FRAME_death272 = 322;
export const FRAME_death273 = 323;
export const FRAME_death274 = 324;
export const FRAME_death275 = 325;
export const FRAME_death276 = 326;
export const FRAME_death277 = 327;
export const FRAME_death278 = 328;
export const FRAME_death279 = 329;
export const FRAME_death280 = 330;
export const FRAME_death281 = 331;
export const FRAME_death282 = 332;
export const FRAME_death283 = 333;
export const FRAME_death284 = 334;
export const FRAME_death285 = 335;
export const FRAME_death286 = 336;
export const FRAME_death287 = 337;
export const FRAME_death288 = 338;
export const FRAME_death289 = 339;
export const FRAME_death290 = 340;
export const FRAME_death291 = 341;
export const FRAME_death292 = 342;
export const FRAME_death293 = 343;
export const FRAME_death294 = 344;
export const FRAME_death295 = 345;
export const FRAME_death301 = 346;
export const FRAME_death302 = 347;
export const FRAME_death303 = 348;
export const FRAME_death304 = 349;
export const FRAME_death305 = 350;
export const FRAME_death306 = 351;
export const FRAME_death307 = 352;
export const FRAME_death308 = 353;
export const FRAME_death309 = 354;
export const FRAME_death310 = 355;
export const FRAME_death311 = 356;
export const FRAME_death312 = 357;
export const FRAME_death313 = 358;
export const FRAME_death314 = 359;
export const FRAME_death315 = 360;
export const FRAME_death316 = 361;
export const FRAME_death317 = 362;
export const FRAME_death318 = 363;
export const FRAME_death319 = 364;
export const FRAME_death320 = 365;
export const FRAME_jump01 = 366;
export const FRAME_jump02 = 367;
export const FRAME_jump03 = 368;
export const FRAME_jump04 = 369;
export const FRAME_jump05 = 370;
export const FRAME_jump06 = 371;
export const FRAME_jump07 = 372;
export const FRAME_jump08 = 373;
export const FRAME_jump09 = 374;
export const FRAME_jump10 = 375;
export const FRAME_jump11 = 376;
export const FRAME_jump12 = 377;
export const FRAME_jump13 = 378;
export const FRAME_pain401 = 379;
export const FRAME_pain402 = 380;
export const FRAME_pain403 = 381;
export const FRAME_pain404 = 382;
export const FRAME_pain501 = 383;
export const FRAME_pain502 = 384;
export const FRAME_pain503 = 385;
export const FRAME_pain504 = 386;
export const FRAME_pain601 = 387;
export const FRAME_pain602 = 388;
export const FRAME_pain603 = 389;
export const FRAME_pain604 = 390;
export const FRAME_pain605 = 391;
export const FRAME_pain606 = 392;
export const FRAME_pain607 = 393;
export const FRAME_pain608 = 394;
export const FRAME_pain609 = 395;
export const FRAME_pain610 = 396;
export const FRAME_pain611 = 397;
export const FRAME_pain612 = 398;
export const FRAME_pain613 = 399;
export const FRAME_pain614 = 400;
export const FRAME_pain615 = 401;
export const FRAME_pain616 = 402;
export const FRAME_pain617 = 403;
export const FRAME_pain618 = 404;
export const FRAME_pain619 = 405;
export const FRAME_pain620 = 406;
export const FRAME_pain621 = 407;
export const FRAME_pain622 = 408;
export const FRAME_pain623 = 409;
export const FRAME_pain624 = 410;
export const FRAME_pain625 = 411;
export const FRAME_pain626 = 412;
export const FRAME_pain627 = 413;
export const FRAME_stand201 = 414;
export const FRAME_stand202 = 415;
export const FRAME_stand203 = 416;
export const FRAME_stand204 = 417;
export const FRAME_stand205 = 418;
export const FRAME_stand206 = 419;
export const FRAME_stand207 = 420;
export const FRAME_stand208 = 421;
export const FRAME_stand209 = 422;
export const FRAME_stand210 = 423;
export const FRAME_stand211 = 424;
export const FRAME_stand212 = 425;
export const FRAME_stand213 = 426;
export const FRAME_stand214 = 427;
export const FRAME_stand215 = 428;
export const FRAME_stand216 = 429;
export const FRAME_stand217 = 430;
export const FRAME_stand218 = 431;
export const FRAME_stand219 = 432;
export const FRAME_stand220 = 433;
export const FRAME_stand221 = 434;
export const FRAME_stand222 = 435;
export const FRAME_stand223 = 436;
export const FRAME_stand224 = 437;
export const FRAME_stand225 = 438;
export const FRAME_stand226 = 439;
export const FRAME_stand227 = 440;
export const FRAME_stand228 = 441;
export const FRAME_stand229 = 442;
export const FRAME_stand230 = 443;
export const FRAME_stand231 = 444;
export const FRAME_stand232 = 445;
export const FRAME_stand233 = 446;
export const FRAME_stand234 = 447;
export const FRAME_stand235 = 448;
export const FRAME_stand236 = 449;
export const FRAME_stand237 = 450;
export const FRAME_stand238 = 451;
export const FRAME_stand239 = 452;
export const FRAME_stand240 = 453;
export const FRAME_stand241 = 454;
export const FRAME_stand242 = 455;
export const FRAME_stand243 = 456;
export const FRAME_stand244 = 457;
export const FRAME_stand245 = 458;
export const FRAME_stand246 = 459;
export const FRAME_stand247 = 460;
export const FRAME_stand248 = 461;
export const FRAME_stand249 = 462;
export const FRAME_stand250 = 463;
export const FRAME_stand251 = 464;
export const FRAME_stand252 = 465;
export const FRAME_stand253 = 466;
export const FRAME_stand254 = 467;
export const FRAME_stand255 = 468;
export const FRAME_stand256 = 469;
export const FRAME_stand257 = 470;
export const FRAME_stand258 = 471;
export const FRAME_stand259 = 472;
export const FRAME_stand260 = 473;
export const FRAME_walk201 = 474;
export const FRAME_walk202 = 475;
export const FRAME_walk203 = 476;
export const FRAME_walk204 = 477;
export const FRAME_walk205 = 478;
export const FRAME_walk206 = 479;
export const FRAME_walk207 = 480;
export const FRAME_walk208 = 481;
export const FRAME_walk209 = 482;
export const FRAME_walk210 = 483;
export const FRAME_walk211 = 484;
export const FRAME_walk212 = 485;
export const FRAME_walk213 = 486;
export const FRAME_walk214 = 487;
export const FRAME_walk215 = 488;
export const FRAME_walk216 = 489;
export const FRAME_walk217 = 490;

export const MODEL_SCALE = 1.0;

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

const sound_pain4 = mkSound();
const sound_pain5 = mkSound();
const sound_pain6 = mkSound();
const sound_death = mkSound();
const sound_step_left = mkSound();
const sound_step_right = mkSound();
const sound_attack_bfg = mkSound();
const sound_brainsplorch = mkSound();
const sound_prerailgun = mkSound();
const sound_popup = mkSound();
const sound_taunt1 = mkSound();
const sound_taunt2 = mkSound();
const sound_taunt3 = mkSound();
const sound_hit = mkSound();

// ---------------------------------------------------------------------------
// Locally-ported shared infra -- see file header.
// ---------------------------------------------------------------------------

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// mkframe/mkMove local builders -- see file header.
// ---------------------------------------------------------------------------

type Aifunc = (self: EdictT, dist: number) => void;
type Thinkfunc = (self: EdictT) => void;

function mkframe(aifunc: Aifunc | null, dist = 0, thinkfunc: Thinkfunc | null = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveEndfuncFn | null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frame;
  m.endfunc = endfunc;
  return m;
}

// ---------------------------------------------------------------------------
// makron_taunt (m_boss32.cpp:38-49)
// ---------------------------------------------------------------------------

export function makron_taunt(self: EdictT): void {
  const r = frandom();
  if (r <= 0.3) gi.sound(self, SoundchanT.CHAN_AUTO, sound_taunt1.index, 1, ATTN_NONE, 0);
  else if (r <= 0.6) gi.sound(self, SoundchanT.CHAN_AUTO, sound_taunt2.index, 1, ATTN_NONE, 0);
  else gi.sound(self, SoundchanT.CHAN_AUTO, sound_taunt3.index, 1, ATTN_NONE, 0);
}

// ---------------------------------------------------------------------------
// STAND (m_boss32.cpp:55-122)
// ---------------------------------------------------------------------------

const makron_frames_stand: MframeT[] = [
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),

  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),

  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),

  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),

  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),

  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand),
  mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), mkframe(ai_stand), // FRAME_stand260
];
export const makron_move_stand = RegisterMmove("makron_move_stand", mkMove(FRAME_stand201, FRAME_stand260, makron_frames_stand, null));

export function makron_stand(self: EdictT): void {
  M_SetAnimation(self, makron_move_stand, true);
}
RegisterMonsterinfoStand("makron_stand", makron_stand);

// ---------------------------------------------------------------------------
// RUN / WALK (m_boss32.cpp:124-193)
// ---------------------------------------------------------------------------

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
export const makron_move_run = RegisterMmove("makron_move_run", mkMove(FRAME_walk204, FRAME_walk213, makron_frames_run, null));

export function makron_hit(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_AUTO, sound_hit.index, 1, ATTN_NONE, 0);
}

export function makron_popup(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_popup.index, 1, ATTN_NONE, 0);
}

export function makron_step_left(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_step_left.index, 1, ATTN_NORM, 0);
}

export function makron_step_right(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_step_right.index, 1, ATTN_NORM, 0);
}

export function makron_brainsplorch(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_brainsplorch.index, 1, ATTN_NORM, 0);
}

export function makron_prerailgun(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_WEAPON, sound_prerailgun.index, 1, ATTN_NORM, 0);
}

/** m_boss32.cpp:168-179 -- defined but unused; see file header's frame-table quirk note. */
export const makron_frames_walk: MframeT[] = [
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
/** m_boss32.cpp:180 -- wired to `makron_frames_run`, NOT `makron_frames_walk` above. See file header. */
export const makron_move_walk = RegisterMmove("makron_move_walk", mkMove(FRAME_walk204, FRAME_walk213, makron_frames_run, null));

export function makron_walk(self: EdictT): void {
  M_SetAnimation(self, makron_move_walk, true);
}
RegisterMonsterinfoWalk("makron_walk", makron_walk);

export function makron_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, makron_move_stand, true);
  else M_SetAnimation(self, makron_move_run, true);
}
RegisterMonsterinfoRun("makron_run", makron_run);

// ---------------------------------------------------------------------------
// PAIN (m_boss32.cpp:195-240, 568-618)
// ---------------------------------------------------------------------------

const makron_frames_pain6: MframeT[] = [
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),

  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),
  mkframe(ai_move, 0, makron_popup),
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),

  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),
  mkframe(ai_move, 0, makron_taunt),
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), // FRAME_pain627
];
const makron_move_pain6 = RegisterMmove("makron_move_pain6", mkMove(FRAME_pain601, FRAME_pain627, makron_frames_pain6, makron_run));

const makron_frames_pain5: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const makron_move_pain5 = RegisterMmove("makron_move_pain5", mkMove(FRAME_pain501, FRAME_pain504, makron_frames_pain5, makron_run));

const makron_frames_pain4: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const makron_move_pain4 = RegisterMmove("makron_move_pain4", mkMove(FRAME_pain401, FRAME_pain404, makron_frames_pain4, makron_run));

// ---------------------------------------------------------------------------
// Makron Torso -- this needs to be spawned in (m_boss32.cpp:242-287)
// ---------------------------------------------------------------------------

export function makron_torso_think(self: EdictT): void {
  self.s.frame++;
  if (self.s.frame >= 365) self.s.frame = 346;

  self.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));

  if (self.s.angles[0] > 0) self.s.angles[0] = Math.max(0.0, self.s.angles[0] - 15);
}
RegisterThink("makron_torso_think", makron_torso_think);

export function makron_torso(ent: EdictT): void {
  ent.s.frame = 346;
  ent.s.modelindex = gi.modelindex("models/monsters/boss3/rider/tris.md2");
  ent.s.skinnum = 1;
  ent.think = makron_torso_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
  ent.s.sound = gi.soundindex("makron/spine.wav");
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.s.effects |= EffectsT.EF_GIB;

  const forward = vec3(0, 0, 0);
  const up = vec3(0, 0, 0);
  AngleVectors(ent.s.angles, forward, null, up);
  ent.velocity = vec3_add(ent.velocity, vec3_muls(up, 120));
  ent.velocity = vec3_add(ent.velocity, vec3_muls(forward, -120));
  ent.s.origin = vec3_add(ent.s.origin, vec3_muls(forward, -10));
  ent.s.angles[0] = 90;
  ent.avelocity = vec3(0, 0, 0);
  gi.linkentity(ent);
}

export function makron_spawn_torso(self: EdictT): void {
  const tempent = ThrowGib(self, "models/monsters/boss3/rider/tris.md2", 0, GibTypeT.GIB_NONE, self.s.scale);
  if (tempent === null) return;
  tempent.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  tempent.s.angles = vec3(self.s.angles[0], self.s.angles[1], self.s.angles[2]);
  self.maxs[2] -= tempent.maxs[2];
  tempent.s.origin[2] += self.maxs[2] - 15;
  makron_torso(tempent);
}

// ---------------------------------------------------------------------------
// DEATH (m_boss32.cpp:289-412, 647-693)
// ---------------------------------------------------------------------------

const makron_frames_death2: MframeT[] = [
  mkframe(ai_move, -15),
  mkframe(ai_move, 3),
  mkframe(ai_move, -12),
  mkframe(ai_move, 0, makron_step_left),
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
  mkframe(ai_move, 11),
  mkframe(ai_move, 12),
  mkframe(ai_move, 11, makron_step_right),
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
  mkframe(ai_move, 5),
  mkframe(ai_move, 7),
  mkframe(ai_move, 6, makron_step_left),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -1),
  mkframe(ai_move, 2),

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
  mkframe(ai_move, -6),
  mkframe(ai_move, -4),
  mkframe(ai_move, -6, makron_step_right),
  mkframe(ai_move, -4),
  mkframe(ai_move, -4, makron_step_left),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
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
  mkframe(ai_move, -2),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move),

  mkframe(ai_move, 27, makron_hit),
  mkframe(ai_move, 26),
  mkframe(ai_move, 0, makron_brainsplorch),
  mkframe(ai_move),
  mkframe(ai_move), // FRAME_death295
];
const makron_move_death2 = RegisterMmove("makron_move_death2", mkMove(FRAME_death201, FRAME_death295, makron_frames_death2, makron_dead));

// m_boss32.cpp:388-412 `#if 0`-guarded makron_frames_death3 / makron_move_death3 -- dropped, dead code in the source.

const makron_frames_sight: MframeT[] = [
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move),
  mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), // FRAME_active13
];
const makron_move_sight = RegisterMmove("makron_move_sight", mkMove(FRAME_active01, FRAME_active13, makron_frames_sight, makron_run));

function makronBFG(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_MAKRON_BFG], forward, right);

  if (self.enemy === null) return;
  const vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(vec, start));
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_attack_bfg.index, 1, ATTN_NORM, 0);
  monster_fire_bfg(self, start, dir, 50, 300, 100, 300, MonsterMuzzleflashIdT.MZ2_MAKRON_BFG);
}

const makron_frames_attack3: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, makronBFG),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
const makron_move_attack3 = RegisterMmove("makron_move_attack3", mkMove(FRAME_attak301, FRAME_attak308, makron_frames_attack3, makron_run));

const makron_frames_attack4: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move, 0, MakronHyperblaster), // fire
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move), // FRAME_attak426
];
const makron_move_attack4 = RegisterMmove("makron_move_attack4", mkMove(FRAME_attak401, FRAME_attak426, makron_frames_attack4, makron_run));

const makron_frames_attack5: MframeT[] = [
  mkframe(ai_charge, 0, makron_prerailgun),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, MakronSaveloc),
  mkframe(ai_move, 0, MakronRailgun), // Fire railgun
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move), // FRAME_attak516
];
const makron_move_attack5 = RegisterMmove("makron_move_attack5", mkMove(FRAME_attak501, FRAME_attak516, makron_frames_attack5, makron_run));

function MakronSaveloc(self: EdictT): void {
  if (self.enemy === null) return;
  self.pos1 = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]); // save for aiming the shot
  self.pos1[2] += self.enemy.viewheight;
}

function MakronRailgun(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_MAKRON_RAILGUN_1], forward, right);

  // calc direction to where we targeted
  const dir = vec3_normalized(vec3_sub(self.pos1, start));

  monster_fire_railgun(self, start, dir, 50, 100, MonsterMuzzleflashIdT.MZ2_MAKRON_RAILGUN_1);
}

function MakronHyperblaster(self: EdictT): void {
  const flash_number: MonsterMuzzleflashIdT = MonsterMuzzleflashIdT.MZ2_MAKRON_BLASTER_1 + (self.s.frame - FRAME_attak405);

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[flash_number], forward, right);

  const dir = vec3(0, 0, 0);
  if (self.enemy !== null) {
    const vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
    const angles = vectoangles(vec3_sub(vec, start));
    dir[0] = angles[0];
  } else {
    dir[0] = 0;
  }
  if (self.s.frame <= FRAME_attak413) dir[1] = self.s.angles[1] - 10 * (self.s.frame - FRAME_attak413);
  else dir[1] = self.s.angles[1] + 10 * (self.s.frame - FRAME_attak421);
  dir[2] = 0;

  const blastForward = vec3(0, 0, 0);
  AngleVectors(dir, blastForward, null, null);

  monster_fire_blaster(self, start, blastForward, 15, 1000, flash_number, EffectsT.EF_BLASTER);
}

export function makron_pain(self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void {
  if (self.monsterinfo.active_move === makron_move_sight) return;

  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames
  if (mod.id !== ModIdT.MOD_CHAINFIST && damage <= 25) {
    if (frandom() < 0.2) return;
  }

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  let do_pain6 = false;

  if (damage <= 40) {
    gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain4.index, 1, ATTN_NONE, 0);
  } else if (damage <= 110) {
    gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain5.index, 1, ATTN_NONE, 0);
  } else {
    if (damage <= 150) {
      if (frandom() <= 0.45) {
        do_pain6 = true;
        gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain6.index, 1, ATTN_NONE, 0);
      }
    } else {
      if (frandom() <= 0.35) {
        do_pain6 = true;
        gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain6.index, 1, ATTN_NONE, 0);
      }
    }
  }

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (damage <= 40) M_SetAnimation(self, makron_move_pain4, true);
  else if (damage <= 110) M_SetAnimation(self, makron_move_pain5, true);
  else if (do_pain6) M_SetAnimation(self, makron_move_pain6, true);
}
RegisterPain("makron_pain", makron_pain);

export function makron_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
}
RegisterMonsterinfoSetskin("makron_setskin", makron_setskin);

export function makron_sight(self: EdictT, _other: EdictT): void {
  M_SetAnimation(self, makron_move_sight, true);
}
RegisterMonsterinfoSight("makron_sight", makron_sight);

export function makron_attack(self: EdictT): void {
  const r = frandom();

  if (r <= 0.3) M_SetAnimation(self, makron_move_attack3, true);
  else if (r <= 0.6) M_SetAnimation(self, makron_move_attack4, true);
  else M_SetAnimation(self, makron_move_attack5, true);
}
RegisterMonsterinfoAttack("makron_attack", makron_attack);

function makron_dead(self: EdictT): void {
  self.mins = vec3(-60, -60, 0);
  self.maxs = vec3(60, 60, 24);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
  monster_dead(self);
}

export function makron_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void {
  self.s.sound = 0;

  // check for gib
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);
    ThrowGibs(self, damage, [
      { gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { count: 4, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
      { gibname: "models/objects/gibs/gear/tris.md2", type: GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
    ]);
    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  // regular death
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NONE, 0);
  self.deadflag = true;
  self.takedamage = true;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;

  M_SetAnimation(self, makron_move_death2, true);

  makron_spawn_torso(self);

  self.mins = vec3(-60, -60, 0);
  self.maxs = vec3(60, 60, 48);
}
RegisterDie("makron_die", makron_die);

/** [Paril-KEX] use generic function. m_boss32.cpp:695-699. */
export function Makron_CheckAttack(self: EdictT): boolean {
  return M_CheckAttack_Base(self, 0.4, 0.8, 0.4, 0.2, 0.0, 0.0);
}
RegisterMonsterinfoCheckattack("Makron_CheckAttack", Makron_CheckAttack);

// ---------------------------------------------------------------------------
// monster_makron (m_boss32.cpp:701-827)
// ---------------------------------------------------------------------------

export function MakronPrecache(): void {
  assignSound(sound_pain4, "makron/pain3.wav");
  assignSound(sound_pain5, "makron/pain2.wav");
  assignSound(sound_pain6, "makron/pain1.wav");
  assignSound(sound_death, "makron/death.wav");
  assignSound(sound_step_left, "makron/step1.wav");
  assignSound(sound_step_right, "makron/step2.wav");
  assignSound(sound_attack_bfg, "makron/bfg_fire.wav");
  assignSound(sound_brainsplorch, "makron/brain1.wav");
  assignSound(sound_prerailgun, "makron/rail_up.wav");
  assignSound(sound_popup, "makron/popup.wav");
  assignSound(sound_taunt1, "makron/voice4.wav");
  assignSound(sound_taunt2, "makron/voice3.wav");
  assignSound(sound_taunt3, "makron/voice.wav");
  assignSound(sound_hit, "makron/bhit.wav");

  gi.modelindex("models/monsters/boss3/rider/tris.md2");
}

/*QUAKED monster_makron (1 .5 0) (-30 -30 0) (30 30 90) Ambush Trigger_Spawn Sight
 */
export function SP_monster_makron(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  MakronPrecache();

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss3/rider/tris.md2");
  self.mins = vec3(-30, -30, 0);
  self.maxs = vec3(30, 30, 90);

  self.health = Math.trunc(3000 * st.health_multiplier);
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
  self.monsterinfo.setskin = makron_setskin;

  gi.linkentity(self);

  // M_SetAnimation(self, &makron_move_stand);
  M_SetAnimation(self, makron_move_sight, true);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);

  // PMM
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;
  // pmm
}

/**
 * m_boss32.cpp:771-804 `THINK(MakronSpawn)`. Registered as a think function
 * even though nothing in this file ever assigns `self.think = MakronSpawn`
 * (it's called directly from `MakronToss` below) -- the C++'s `THINK()`
 * macro decoration means a live edict's `.think` pointer could still equal
 * this function at save time, so it must be name-resolvable on load.
 */
export function MakronSpawn(self: EdictT): void {
  SP_monster_makron(self);
  if (self.think !== null) self.think(self);

  // jump at player
  let player: EdictT | null;
  if (self.enemy !== null && self.enemy.inuse && self.enemy.health > 0) player = self.enemy;
  else player = AI_GetSightClient(self);

  if (player === null) return;

  const vec = vec3_sub(player.s.origin, self.s.origin);
  self.s.angles[1] = vectoyaw(vec); // YAW
  const dir = vec3_normalized(vec);
  self.velocity = vec3_muls(dir, 400);
  self.velocity[2] = 200;
  self.groundentity = null;
  self.enemy = player;
  FoundTarget(self);
  if (self.monsterinfo.sight !== null) self.monsterinfo.sight(self, self.enemy);
  self.s.frame = self.monsterinfo.nextframe = FRAME_active01; // FIXME: why????
}
RegisterThink("MakronSpawn", MakronSpawn);

/**
 * m_boss32.cpp:806-827 `MakronToss` -- Jorg is just about dead, so set up to
 * launch Makron out. Called from `m_boss31.ts`'s `jorg_dead`.
 */
export function MakronToss(self: EdictT): void {
  const ent = G_Spawn();
  ent.classname = "monster_makron";
  ent.target = self.target;
  ent.s.origin = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  ent.enemy = self.enemy;

  MakronSpawn(ent);

  // [Paril-KEX] set health bar over to Makron when we throw him out
  for (let i = 0; i < 2; i++) {
    const hb = level.health_bar_entities[i];
    if (hb !== null && hb.enemy === self) level.health_bar_entities[i] = ent;
  }
}
