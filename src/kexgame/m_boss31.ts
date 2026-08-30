// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_boss31.c -- Jorg, the Cyborg boss (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_boss31.cpp (642 lines) +
// m_boss31.h (199 lines, frame-index enum + MODEL_SCALE), C++17. Jorg's
// death (`jorg_dead`) tosses his own head to spawn Makron -- see
// `m_boss32.ts` for `MakronToss`/`MakronSpawn`/`MakronPrecache` (Jorg's
// death sequence is a real, reachable call site into that file, matching
// the split already established by the legacy 3.21 port at
// `src/game/m_boss31.ts`/`m_boss32.ts`).
//
// ============================================================================
// CROSS-FILE WIRING (Jorg -> Makron)
// ============================================================================
// `jorg_dead` (m_boss31.cpp:526-550) calls `MakronToss(self)` unconditionally
// after throwing Jorg's gibs -- this is the real spawn trigger for the final
// boss, not decoration. `SP_monster_jorg` also calls `MakronPrecache()`
// (m_boss31.cpp:597) so Makron's assets are loaded even though Makron
// himself doesn't exist as an edict yet. Both are imported from
// `./m_boss32`, matching the legacy precedent (`src/game/m_boss31.ts:57`
// `import { MakronPrecache, MakronToss } from "./m_boss32";`).
//
// ============================================================================
// LOCALLY-DUPLICATED SHARED INFRA (not yet homed anywhere importable)
// ============================================================================
// `PredictAim` (rogue/g_rogue_newai.cpp:1083-1135) is duplicated here
// verbatim from its real, working implementation in `m_infantry.ts`
// (`m_infantry.ts:506-567`) -- matching this port line's established
// "duplicated per-file, not imported" convention for rogue-newai helpers
// (m_soldier.ts's own header documents the identical treatment for
// `blocked_checkplat`/`M_MonsterDodge`/etc.). Used here for
// `jorg_firebullet_left`/`_right`'s hitscan lead (bolt_speed 0, matching the
// C++'s hitscan call with speed 0).
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `BossExplode` (rogue/g_rogue_newai.cpp:1575-1610, referenced by Jorg's
//   death frame 1 as a forward-declared `extern`) is IMPORTED (not
//   duplicated) from `m_supertank.ts`, which already owns the one real,
//   exported port -- matching the legacy precedent exactly
//   (`src/game/m_boss31.ts:56` `import { BossExplode } from "./m_supertank";`).
// - Vec3 arithmetic chains use q_vec3.ts's functional helpers, not C++
//   operator overloads, per this port line's established convention.
// - `world`/`traceEdict`/`giTraceline` are per-file local duplicates,
//   matching m_soldier.ts's/m_infantry.ts's own established idiom.
// - `cached_soundindex` fields are plain `{ index: 0 }` objects assigned via
//   a local `assignSound` helper, matching m_soldier.ts's precedent.
// - `mkframe`/`mkMove` are small local builders for `MframeT`/`MmoveT`,
//   matching m_soldier.ts's precedent exactly (same field shapes).
// - Forward-declared C++ functions (jorg_dead referenced by
//   jorg_move_death before its own definition; jorg_reattack1 referenced by
//   jorg_move_attack1; jorg_attack1 referenced by jorg_move_start_attack1)
//   become hoisted `function` declarations rather than `const` arrows,
//   matching m_soldier.ts's documented rationale (TS has no function-pointer
//   forward declaration, but `function` declarations hoist their full body).
// - `M_SetAnimation`'s C++ default `instant = true` (g_local.h:2211) is
//   passed explicitly at every call site (the TS port's `instant` parameter
//   has no default, per g_monster.ts's own signature) -- every C++ call in
//   this file omits the argument, so every TS call site here passes `true`.

import { type Vec3, vec3 } from "../shared/math";
import { AngleVectors, vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalized, vec3_length } from "./q_vec3";
import { MonsterMuzzleflashIdT, KexEdictT, type KexTraceT, ContentsT, MASK_SOLID, MASK_PROJECTILE, ATTN_NORM, SoundchanT } from "../kexapi/game";
import {
  type EdictT,
  MonsterAiFlagsT,
  MovetypeT,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  ModIdT,
  GibTypeT,
} from "./g_local";
import { SolidT } from "../kexapi/game";
import { gi, level } from "./g_main_globals";
import { g_edicts } from "./g_main_globals";
import { st } from "./g_spawn";
import type { ModT } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoCheckattack,
} from "./g_save_registry";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible, M_CheckAttack_Base } from "./g_ai";
import { M_ShouldReactToPain, monster_fire_bullet, monster_fire_bfg, M_ProjectFlashSource, M_SetAnimation, M_AllowSpawn, walkmonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGibs } from "./g_misc";
import { G_FreeEdict } from "./g_utils";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { frandom } from "./q_std";
import { BossExplode } from "./m_supertank";
import { MakronPrecache, MakronToss } from "./m_boss32";
import { ServerCommandT, KexMulticastT, KexTempEventT } from "../kexapi/game";

// ---------------------------------------------------------------------------
// m_boss31.h frame-index enum (199 lines; anonymous enum, declaration order
// = array index, starting at 0) + MODEL_SCALE.
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

const sound_pain1 = mkSound();
const sound_pain2 = mkSound();
const sound_pain3 = mkSound();
const sound_idle = mkSound();
const sound_death = mkSound();
const sound_search1 = mkSound();
const sound_search2 = mkSound();
const sound_search3 = mkSound();
const sound_attack1 = mkSound();
const sound_attack1_loop = mkSound();
const sound_attack1_end = mkSound();
const sound_attack2 = mkSound();
const sound_bfg_fire = mkSound();
const sound_firegun = mkSound();
const sound_step_left = mkSound();
const sound_step_right = mkSound();
const sound_death_hit = mkSound();

// ---------------------------------------------------------------------------
// Locally-duplicated shared infra -- see file header.
// ---------------------------------------------------------------------------

/** EDICT_NUM idiom -- see g_monster.ts's/m_soldier.ts's own `traceEdict` for the full rationale. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** g_local.h:136-139 `game_import_t::traceline` -- see g_monster.ts's own `giTraceline` for the full rationale. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

/** rogue/g_rogue_newai.cpp:1083-1135. Duplicated verbatim from m_infantry.ts's
 *  real implementation -- see file header. Used by jorg's hitscan
 *  machineguns with `bolt_speed = 0`. */
function PredictAim(
  self: EdictT,
  target: EdictT | null,
  start: Vec3,
  bolt_speed: number,
  eyeHeightIn: boolean,
  offset: number,
  aimdir: Vec3 | null,
  aimpoint: Vec3 | null,
): void {
  if (!target || !target.inuse) {
    if (aimdir) {
      aimdir[0] = 0;
      aimdir[1] = 0;
      aimdir[2] = 0;
    }
    return;
  }

  let eye_height = eyeHeightIn;
  let dir = vec3_sub(target.s.origin, start);
  if (eye_height) dir[2] += target.viewheight;
  let dist = vec3_length(dir);

  const tr = giTraceline(start, vec3_add(start, dir), self, MASK_PROJECTILE);

  if (traceEdict(tr.ent) !== target) {
    eye_height = !eye_height;
    dir = vec3_sub(target.s.origin, start);
    if (eye_height) dir[2] += target.viewheight;
    dist = vec3_length(dir);
  }

  const time = bolt_speed !== 0 ? dist / bolt_speed : 0;

  let vec = vec3_add(target.s.origin, vec3_muls(target.velocity, time - offset));

  if (vec3_dot(vec3_normalized(dir), vec3_normalized(vec3_sub(vec, start))) < 0) {
    vec = vec3(target.s.origin[0], target.s.origin[1], target.s.origin[2]);
  } else {
    if (giTraceline(start, vec, null, MASK_SOLID).fraction < 0.9) {
      vec = vec3(target.s.origin[0], target.s.origin[1], target.s.origin[2]);
    }
  }

  if (eye_height) vec[2] += target.viewheight;

  if (aimdir) {
    const ad = vec3_normalized(vec3_sub(vec, start));
    aimdir[0] = ad[0];
    aimdir[1] = ad[1];
    aimdir[2] = ad[2];
  }
  if (aimpoint) {
    aimpoint[0] = vec[0];
    aimpoint[1] = vec[1];
    aimpoint[2] = vec[2];
  }
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
// jorg_attack1_end_sound / jorg_idle / jorg_death_hit / jorg_step_left/right
// (m_boss31.cpp:34-144)
// ---------------------------------------------------------------------------

function jorg_attack1_end_sound(self: EdictT): void {
  if (self.monsterinfo.weapon_sound !== 0) {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_attack1_end.index, 1, ATTN_NORM, 0);
    self.monsterinfo.weapon_sound = 0;
  }
}

export function jorg_search(self: EdictT): void {
  const r = frandom();
  if (r <= 0.3) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search1.index, 1, ATTN_NORM, 0);
  else if (r <= 0.6) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search2.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_search3.index, 1, ATTN_NORM, 0);
}
RegisterMonsterinfoSearch("jorg_search", jorg_search);

export function jorg_idle(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_idle.index, 1, ATTN_NORM, 0);
}

export function jorg_death_hit(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_death_hit.index, 1, ATTN_NORM, 0);
}

export function jorg_step_left(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_step_left.index, 1, ATTN_NORM, 0);
}

export function jorg_step_right(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_step_right.index, 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// STAND (m_boss31.cpp:71-151)
// ---------------------------------------------------------------------------

const jorg_frames_stand: MframeT[] = [
  mkframe(ai_stand, 0, jorg_idle),
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

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 19),
  mkframe(ai_stand, 11, jorg_step_left),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 6),
  mkframe(ai_stand, 9, jorg_step_right),
  mkframe(ai_stand),

  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, -2),
  mkframe(ai_stand, -17, jorg_step_left),
  mkframe(ai_stand),
  mkframe(ai_stand, -12),
  mkframe(ai_stand, -14, jorg_step_right), // FRAME_stand51
];
export const jorg_move_stand = RegisterMmove("jorg_move_stand", mkMove(FRAME_stand01, FRAME_stand51, jorg_frames_stand, null));

export function jorg_stand(self: EdictT): void {
  M_SetAnimation(self, jorg_move_stand, true);
  jorg_attack1_end_sound(self);
}
RegisterMonsterinfoStand("jorg_stand", jorg_stand);

// ---------------------------------------------------------------------------
// RUN / WALK (m_boss31.cpp:153-228)
// ---------------------------------------------------------------------------

const jorg_frames_run: MframeT[] = [
  mkframe(ai_run, 17, jorg_step_left),
  mkframe(ai_run),
  mkframe(ai_run),
  mkframe(ai_run),
  mkframe(ai_run, 12),
  mkframe(ai_run, 8),
  mkframe(ai_run, 10),
  mkframe(ai_run, 33, jorg_step_right),
  mkframe(ai_run),
  mkframe(ai_run),
  mkframe(ai_run),
  mkframe(ai_run, 9),
  mkframe(ai_run, 9),
  mkframe(ai_run, 9),
];
export const jorg_move_run = RegisterMmove("jorg_move_run", mkMove(FRAME_walk06, FRAME_walk19, jorg_frames_run, null));

// m_boss31.cpp:174-183 `#if 0`-guarded jorg_frames_start_walk / jorg_move_start_walk -- dropped, dead code in the source.

const jorg_frames_walk: MframeT[] = [
  mkframe(ai_walk, 17),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk, 12),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 10),
  mkframe(ai_walk, 33),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, 9),
];
export const jorg_move_walk = RegisterMmove("jorg_move_walk", mkMove(FRAME_walk06, FRAME_walk19, jorg_frames_walk, null));

// m_boss31.cpp:203-213 `#if 0`-guarded jorg_frames_end_walk / jorg_move_end_walk -- dropped, dead code in the source.

export function jorg_walk(self: EdictT): void {
  M_SetAnimation(self, jorg_move_walk, true);
}
RegisterMonsterinfoWalk("jorg_walk", jorg_walk);

export function jorg_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, jorg_move_stand, true);
  else M_SetAnimation(self, jorg_move_run, true);

  jorg_attack1_end_sound(self);
}
RegisterMonsterinfoRun("jorg_run", jorg_run);

// ---------------------------------------------------------------------------
// PAIN (m_boss31.cpp:230-271, 398-459)
// ---------------------------------------------------------------------------

const jorg_frames_pain3: MframeT[] = [
  mkframe(ai_move, -28),
  mkframe(ai_move, -6),
  mkframe(ai_move, -3, jorg_step_left),
  mkframe(ai_move, -9),
  mkframe(ai_move, 0, jorg_step_right),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -7),
  mkframe(ai_move, 1),
  mkframe(ai_move, -11),
  mkframe(ai_move, -4),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 10),
  mkframe(ai_move, 11),
  mkframe(ai_move),
  mkframe(ai_move, 10),
  mkframe(ai_move, 3),
  mkframe(ai_move, 10),
  mkframe(ai_move, 7, jorg_step_left),
  mkframe(ai_move, 17),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, jorg_step_right),
];
const jorg_move_pain3 = RegisterMmove("jorg_move_pain3", mkMove(FRAME_pain301, FRAME_pain325, jorg_frames_pain3, jorg_run));

const jorg_frames_pain2: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const jorg_move_pain2 = RegisterMmove("jorg_move_pain2", mkMove(FRAME_pain201, FRAME_pain203, jorg_frames_pain2, jorg_run));

const jorg_frames_pain1: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const jorg_move_pain1 = RegisterMmove("jorg_move_pain1", mkMove(FRAME_pain101, FRAME_pain103, jorg_frames_pain1, jorg_run));

// ---------------------------------------------------------------------------
// DEATH (m_boss31.cpp:273-325, 526-560)
// ---------------------------------------------------------------------------

const jorg_frames_death1: MframeT[] = [
  mkframe(ai_move, 0, BossExplode),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -2),
  mkframe(ai_move, -5),
  mkframe(ai_move, -8),
  mkframe(ai_move, -15, jorg_step_left),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -11),
  mkframe(ai_move, -25),
  mkframe(ai_move, -10, jorg_step_right),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -21),
  mkframe(ai_move, -10),
  mkframe(ai_move, -16, jorg_step_left),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 22),
  mkframe(ai_move, 33, jorg_step_left),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 28),
  mkframe(ai_move, 28, jorg_step_right),
  mkframe(ai_move),
  mkframe(ai_move),

  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, -19),
  mkframe(ai_move, 0, jorg_death_hit),
  mkframe(ai_move),
  mkframe(ai_move), // FRAME_death50
];
const jorg_move_death = RegisterMmove("jorg_move_death", mkMove(FRAME_death01, FRAME_death50, jorg_frames_death1, jorg_dead));

// ---------------------------------------------------------------------------
// ATTACK (m_boss31.cpp:327-397, 469-524)
// ---------------------------------------------------------------------------

const jorg_frames_attack2: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge, 0, jorgBFG),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
];
const jorg_move_attack2 = RegisterMmove("jorg_move_attack2", mkMove(FRAME_attak201, FRAME_attak213, jorg_frames_attack2, jorg_run));

const jorg_frames_start_attack1: MframeT[] = [
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
  mkframe(ai_charge),
];
const jorg_move_start_attack1 = RegisterMmove("jorg_move_start_attack1", mkMove(FRAME_attak101, FRAME_attak108, jorg_frames_start_attack1, jorg_attack1));

const jorg_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 0, jorg_firebullet),
  mkframe(ai_charge, 0, jorg_firebullet),
  mkframe(ai_charge, 0, jorg_firebullet),
  mkframe(ai_charge, 0, jorg_firebullet),
  mkframe(ai_charge, 0, jorg_firebullet),
  mkframe(ai_charge, 0, jorg_firebullet),
];
const jorg_move_attack1 = RegisterMmove("jorg_move_attack1", mkMove(FRAME_attak109, FRAME_attak114, jorg_frames_attack1, jorg_reattack1));

const jorg_frames_end_attack1: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
const jorg_move_end_attack1 = RegisterMmove("jorg_move_end_attack1", mkMove(FRAME_attak115, FRAME_attak118, jorg_frames_end_attack1, jorg_run));

function jorg_reattack1(self: EdictT): void {
  if (self.enemy !== null && visible(self, self.enemy)) {
    if (frandom() < 0.9) M_SetAnimation(self, jorg_move_attack1, true);
    else {
      M_SetAnimation(self, jorg_move_end_attack1, true);
      jorg_attack1_end_sound(self);
    }
  } else {
    M_SetAnimation(self, jorg_move_end_attack1, true);
    jorg_attack1_end_sound(self);
  }
}

function jorg_attack1(self: EdictT): void {
  M_SetAnimation(self, jorg_move_attack1, true);
}

export function jorg_pain(self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void {
  if (level.time < self.pain_debounce_time) return;

  // Lessen the chance of him going into his pain frames if he takes little damage
  if (mod.id !== ModIdT.MOD_CHAINFIST) {
    if (damage <= 40) if (frandom() <= 0.6) return;

    // If he's entering his attack1 or using attack1, lessen the chance of him going into pain
    if (self.s.frame >= FRAME_attak101 && self.s.frame <= FRAME_attak108) if (frandom() <= 0.005) return;

    if (self.s.frame >= FRAME_attak109 && self.s.frame <= FRAME_attak114) if (frandom() <= 0.00005) return;

    if (self.s.frame >= FRAME_attak201 && self.s.frame <= FRAME_attak208) if (frandom() <= 0.005) return;
  }

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  let do_pain3 = false;

  if (damage > 50) {
    if (damage <= 100) {
      gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NORM, 0);
    } else {
      if (frandom() <= 0.3) {
        do_pain3 = true;
        gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain3.index, 1, ATTN_NORM, 0);
      }
    }
  }

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  jorg_attack1_end_sound(self);

  if (damage <= 50) M_SetAnimation(self, jorg_move_pain1, true);
  else if (damage <= 100) M_SetAnimation(self, jorg_move_pain2, true);
  else if (do_pain3) M_SetAnimation(self, jorg_move_pain3, true);
}
RegisterPain("jorg_pain", jorg_pain);

export function jorg_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
}
RegisterMonsterinfoSetskin("jorg_setskin", jorg_setskin);

function jorgBFG(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_JORG_BFG_1], forward, right);

  if (self.enemy === null) return;
  const vec = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.viewheight);
  const dir = vec3_normalized(vec3_sub(vec, start));
  gi.sound(self, SoundchanT.CHAN_WEAPON, sound_bfg_fire.index, 1, ATTN_NORM, 0);
  monster_fire_bfg(self, start, dir, 50, 300, 100, 200, MonsterMuzzleflashIdT.MZ2_JORG_BFG_1);
}

function jorg_firebullet_right(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_JORG_MACHINEGUN_R1], forward, right);
  const aim = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, false, -0.2, aim, null);
  monster_fire_bullet(self, start, aim, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MonsterMuzzleflashIdT.MZ2_JORG_MACHINEGUN_R1);
}

function jorg_firebullet_left(self: EdictT): void {
  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const start = M_ProjectFlashSource(self, monsterFlashOffset()[MonsterMuzzleflashIdT.MZ2_JORG_MACHINEGUN_L1], forward, right);
  const aim = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, false, 0.2, aim, null);
  monster_fire_bullet(self, start, aim, 6, 4, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MonsterMuzzleflashIdT.MZ2_JORG_MACHINEGUN_L1);
}

function jorg_firebullet(self: EdictT): void {
  jorg_firebullet_left(self);
  jorg_firebullet_right(self);
}

export function jorg_attack(self: EdictT): void {
  if (frandom() <= 0.75) {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_attack1.index, 1, ATTN_NORM, 0);
    self.monsterinfo.weapon_sound = gi.soundindex("boss3/w_loop.wav");
    M_SetAnimation(self, jorg_move_start_attack1, true);
  } else {
    gi.sound(self, SoundchanT.CHAN_VOICE, sound_attack2.index, 1, ATTN_NORM, 0);
    M_SetAnimation(self, jorg_move_attack2, true);
  }
}
RegisterMonsterinfoAttack("jorg_attack", jorg_attack);

function jorg_dead(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1_BIG);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.sound = 0;
  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  ThrowGibs(self, 500, [
    { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
    { count: 2, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/boss3/jorg/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/boss3/jorg/gibs/foot.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/boss3/jorg/gibs/gun.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { count: 2, gibname: "models/monsters/boss3/jorg/gibs/thigh.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { gibname: "models/monsters/boss3/jorg/gibs/spine.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
    { count: 4, gibname: "models/monsters/boss3/jorg/gibs/tube.md2", type: GibTypeT.GIB_SKINNED },
    { count: 6, gibname: "models/monsters/boss3/jorg/gibs/spike.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/boss3/jorg/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC | GibTypeT.GIB_HEAD },
  ]);

  MakronToss(self);
}

export function jorg_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, _mod: ModT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NORM, 0);
  jorg_attack1_end_sound(self);
  self.deadflag = true;
  self.takedamage = false;
  self.count = 0;
  M_SetAnimation(self, jorg_move_death, true);
}
RegisterDie("jorg_die", jorg_die);

/** [Paril-KEX] use generic function. m_boss31.cpp:562-566. */
export function Jorg_CheckAttack(self: EdictT): boolean {
  return M_CheckAttack_Base(self, 0.4, 0.8, 0.4, 0.2, 0.0, 0.0);
}
RegisterMonsterinfoCheckattack("Jorg_CheckAttack", Jorg_CheckAttack);

/*QUAKED monster_jorg (1 .5 0) (-80 -80 0) (90 90 140) Ambush Trigger_Spawn Sight
 */
export function SP_monster_jorg(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_pain1, "boss3/bs3pain1.wav");
  assignSound(sound_pain2, "boss3/bs3pain2.wav");
  assignSound(sound_pain3, "boss3/bs3pain3.wav");
  assignSound(sound_death, "boss3/bs3deth1.wav");
  assignSound(sound_attack1, "boss3/bs3atck1.wav");
  assignSound(sound_attack1_loop, "boss3/bs3atck1_loop.wav");
  assignSound(sound_attack1_end, "boss3/bs3atck1_end.wav");
  assignSound(sound_attack2, "boss3/bs3atck2.wav");
  assignSound(sound_search1, "boss3/bs3srch1.wav");
  assignSound(sound_search2, "boss3/bs3srch2.wav");
  assignSound(sound_search3, "boss3/bs3srch3.wav");
  assignSound(sound_idle, "boss3/bs3idle1.wav");
  assignSound(sound_step_left, "boss3/step1.wav");
  assignSound(sound_step_right, "boss3/step2.wav");
  assignSound(sound_firegun, "boss3/xfire.wav");
  assignSound(sound_death_hit, "boss3/d_hit.wav");
  assignSound(sound_bfg_fire, "makron/bfg_fire.wav");

  MakronPrecache();

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/boss3/jorg/tris.md2");
  self.s.modelindex2 = gi.modelindex("models/monsters/boss3/rider/tris.md2");

  gi.modelindex("models/monsters/boss3/jorg/gibs/chest.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/foot.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/gun.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/head.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/spike.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/spine.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/thigh.md2");
  gi.modelindex("models/monsters/boss3/jorg/gibs/tube.md2");

  self.mins = vec3(-80, -80, 0);
  self.maxs = vec3(80, 80, 140);

  self.health = Math.trunc(8000 * st.health_multiplier);
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
  self.monsterinfo.setskin = jorg_setskin;
  gi.linkentity(self);

  M_SetAnimation(self, jorg_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);
  // PMM
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_IGNORE_SHOTS;
  // pmm
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DOUBLE_TROUBLE;
}
