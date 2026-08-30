// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_hover.c -- the HOVER/DAEDALUS monster family (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_hover.cpp (662 lines) +
// m_hover.h (216 lines, frame-index enum + MODEL_SCALE), C++17. Behavioral
// code, ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/m_soldier.ts headers). One spawn function, `SP_monster_hover`,
// serves two classnames -- "monster_hover" and "monster_daedalus" (both
// route to it in g_spawn.ts, an already-landed wiring this unit does not
// touch) -- selected at spawn time by `self.classname`, mirroring the C++'s
// own `strcmp(self->classname, "monster_daedalus")` branch.
//
// ============================================================================
// WHAT THIS MONSTER DOES NOT USE (confirmed by reading the whole C++ source
// before writing this file)
// ============================================================================
// Unlike m_soldier.ts/m_gunner.ts/m_infantry.ts/m_chick.ts/m_berserk.ts,
// hover_cpp never wires `monsterinfo.dodge`, `.duck`, `.unduck`, or
// `.blocked` -- it is a flying monster driven entirely by
// `flymonster_start`/`flymonster_start_go` (g_monster.ts, already real) plus
// the generic `AI_ALTERNATE_FLY` hover-position steering in g_ai.ts/
// m_move.ts/g_phys.ts (all already real, already gated on that flag). So
// none of the rogue-newai dodge/duck family (owned by m_soldier.ts) or
// `blocked_checkplat` (owned by m_supertank.ts) is imported or duplicated
// here -- there is nothing to import.
//
// ============================================================================
// EXTERNAL DEPENDENCY NOT PORTED: monster_fire_blaster2 (ROGUE mission pack)
// ============================================================================
// `hover_fire_blaster`'s daedalus branch (self->mass >= 200, i.e. every
// monster_daedalus -- SP_monster_hover always sets mass=225 for that
// classname, m_hover.cpp:614) calls `monster_fire_blaster2`. That function's
// only definition anywhere in the source tree is
// rerelease/rogue/g_rogue_monster.cpp:7 (a two-line wrapper around
// `fire_blaster2`, itself defined in rerelease/rogue/g_rogue_newweap.cpp --
// a ROGUE mission-pack file, genuinely out of this unit's scope, which names
// only m_hover.cpp/.h as sources). Kept as a local, unexported, cited
// throwing stub -- matching m_soldier.ts's own precedent for its xatrix
// ionripper/blueblaster/dabeam family (m_soldier.ts header: "a narrower gap
// than [an unconditionally-reachable landmine], affecting three of six
// spawn variants' attack animations only"). Here the shape is identical:
// affects only the daedalus half of this file's two spawn variants' attack
// animation, not the base hover, and not pain/death/movement for either.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `hover_gib`/`hover_dying`/`hover_dead`/`hover_deadthink`/`hover_die`'s
//   `ThrowGibs`/`M_CheckGib` calls use g_misc.ts's/this file's own local
//   copy respectively, matching m_soldier.ts's established idioms exactly
//   (`M_CheckGib` duplicated locally, unexported, per g_local.h:3521-3529;
//   `ThrowGibs` imported for real from g_misc.ts).
// - `cached_soundindex` fields use the same local `mkSound`/`assignSound`
//   plain-object idiom as m_soldier.ts/g_trigger.ts.
// - `mkframe`/`mkMove` are the same small local MframeT/MmoveT builders as
//   m_soldier.ts, standing in for the C++ `{ ... }` aggregate-initializer
//   syntax; every `MMOVE_T(name) = { first, last, frames, endfunc }` becomes
//   `const name = RegisterMmove("name", mkMove(first, last, frames,
//   endfunc))`, which validates `frames.length === last - first + 1` at
//   import time (MmoveT's setter, g_local_types.ts).
// - `M_SetAnimation`'s C++ default `bool instant = true` (g_local.h:2211) is
//   NOT a default in the TS signature (`M_SetAnimation(self, move, instant)`,
//   3 required args, g_monster.ts) -- every 2-arg C++ call site in this file
//   (e.g. `M_SetAnimation(self, &hover_move_stand)`) is therefore ported as
//   `M_SetAnimation(self, hover_move_stand, true)`, matching the default the
//   C++ omitted. No call site in m_hover.cpp passes an explicit `false`.
// - `strcmp(self->classname, "monster_daedalus") == 0` -> `self.classname
//   === "monster_daedalus"`.
// - `st.was_key_specified("power_armor_type"/"power_armor_power")` ->
//   `st.keys_specified.has(...)`, per g_local_types.ts's own SpawnTempT note
//   ("call sites can inline `st.keys_specified.has(key)` directly").
// - The dead `#if 0`-guarded circle-strafe-v2 frame tables
//   (`hover_frames_start_attack2`/`hover_move_start_attack2`,
//   `hover_frames_end_attack2`/`hover_move_end_attack2`, m_hover.cpp:333-355)
//   are genuinely `#if 0`'d out in the C++ source itself -- dead code that
//   never compiles into the real DLL. Not ported, matching how this port
//   line treats any other `#if 0` block (there is no live reference to port
//   against).
//
// ============================================================================
// Frame-table count: 11 (stand, walk, run, pain1, pain2, pain3, death1,
// start_attack, attack1, end_attack, attack2).
// ============================================================================

import { vec3, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_normalize } from "./q_vec3";
import { MonsterMuzzleflashIdT, SolidT, EffectsT, SoundchanT, ATTN_NORM, KexMulticastT, KexTempEventT, ServerCommandT } from "../kexapi/game";
import {
  type EdictT,
  MovetypeT,
  MonsterAiFlagsT,
  MonsterAttackStateT,
  GibTypeT,
  ItemIdT,
  ModIdT,
} from "./g_local";
import type { ModT } from "./g_local_types";
import { MframeT, MmoveT, MmoveEndfuncFn, PainFn, DieFn, ThinkFn } from "./g_local_types";
import {
  RegisterMmove,
  RegisterThink,
  RegisterPain,
  RegisterDie,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoSetskin,
} from "./g_save_registry";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible } from "./g_ai";
import { monster_fire_blaster, M_ProjectFlashSource, M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, flymonster_start } from "./g_monster";
import { monsterFlashOffset } from "./m_flash";
import { ThrowGibs } from "./g_misc";
import { G_FreeEdict } from "./g_utils";
import { gi, level } from "./g_main_globals";
import { st } from "./g_spawn";
import { Gtime_add, Gtime_from_sec, Gtime_from_ms, type GTime } from "./gtime";
import { frandom, brandom } from "./q_std";

/** See g_phys.ts's own "FRAME_TIME_S" header note -- duplicated locally,
 *  same idiom, since g_phys.ts does not export it. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

// ---------------------------------------------------------------------------
// m_hover.h frame-index enum (216 lines; anonymous enum, declaration order =
// array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_stand01 = 0;
export const FRAME_stand30 = 29;
export const FRAME_forwrd01 = 30;
export const FRAME_forwrd35 = 64;
export const FRAME_stop101 = 65;
export const FRAME_stop109 = 73;
export const FRAME_stop201 = 74;
export const FRAME_stop208 = 81;
export const FRAME_takeof01 = 82;
export const FRAME_takeof30 = 111;
export const FRAME_land01 = 112;
export const FRAME_pain101 = 113;
export const FRAME_pain128 = 140;
export const FRAME_pain201 = 141;
export const FRAME_pain212 = 152;
export const FRAME_pain301 = 153;
export const FRAME_pain309 = 161;
export const FRAME_death101 = 162;
export const FRAME_death111 = 172;
export const FRAME_backwd01 = 173;
export const FRAME_backwd24 = 196;
export const FRAME_attak101 = 197;
export const FRAME_attak102 = 198;
export const FRAME_attak103 = 199;
export const FRAME_attak104 = 200;
export const FRAME_attak105 = 201;
export const FRAME_attak106 = 202;
export const FRAME_attak107 = 203;
export const FRAME_attak108 = 204;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// mframe_t/mmove_t builders -- see file header.
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
const sound_death1 = mkSound();
const sound_death2 = mkSound();
const sound_sight = mkSound();
const sound_search1 = mkSound();
const sound_search2 = mkSound();

// ROGUE -- daedalus sounds
const daed_sound_pain1 = mkSound();
const daed_sound_pain2 = mkSound();
const daed_sound_death1 = mkSound();
const daed_sound_death2 = mkSound();
const daed_sound_sight = mkSound();
const daed_sound_search1 = mkSound();
const daed_sound_search2 = mkSound();
// ROGUE

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// hover_sight / hover_search (m_hover.cpp:34-60)
// ---------------------------------------------------------------------------

function hover_sight(self: EdictT, _other: EdictT): void {
  // PMM - daedalus sounds
  if (self.mass < 225) gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_sight.index, 1, ATTN_NORM, 0);
}
RegisterMonsterinfoSight("hover_sight", hover_sight);

function hover_search(self: EdictT): void {
  // PMM - daedalus sounds
  if (self.mass < 225) {
    if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_search1.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, sound_search2.index, 1, ATTN_NORM, 0);
  } else {
    if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_search1.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_search2.index, 1, ATTN_NORM, 0);
  }
}
RegisterMonsterinfoSearch("hover_search", hover_search);

// ---------------------------------------------------------------------------
// Frame tables (m_hover.cpp:68-355) -- forward references to hover_run/
// hover_dead/hover_attack/hover_reattack/hover_fire_blaster resolve via
// `function` hoisting, matching the C++'s own forward declarations at
// m_hover.cpp:62-66.
// ---------------------------------------------------------------------------

const hover_frames_stand: MframeT[] = new Array(30).fill(null).map(() => mkframe(ai_stand));
export const hover_move_stand = RegisterMmove("hover_move_stand", mkMove(FRAME_stand01, FRAME_stand30, hover_frames_stand, null));

const hover_frames_pain3: MframeT[] = new Array(9).fill(null).map(() => mkframe(ai_move));
export const hover_move_pain3 = RegisterMmove("hover_move_pain3", mkMove(FRAME_pain301, FRAME_pain309, hover_frames_pain3, hover_run));

const hover_frames_pain2: MframeT[] = new Array(12).fill(null).map(() => mkframe(ai_move));
export const hover_move_pain2 = RegisterMmove("hover_move_pain2", mkMove(FRAME_pain201, FRAME_pain212, hover_frames_pain2, hover_run));

const hover_frames_pain1: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move, -8),
  mkframe(ai_move, -4),
  mkframe(ai_move, -6),
  mkframe(ai_move, -4),
  mkframe(ai_move, -3),
  mkframe(ai_move, 1),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move, 3),
  mkframe(ai_move, 2),
  mkframe(ai_move, 7),
  mkframe(ai_move, 1),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 5),
  mkframe(ai_move, 3),
  mkframe(ai_move, 4),
];
export const hover_move_pain1 = RegisterMmove("hover_move_pain1", mkMove(FRAME_pain101, FRAME_pain128, hover_frames_pain1, hover_run));

const hover_frames_walk: MframeT[] = new Array(35).fill(null).map(() => mkframe(ai_walk, 4));
export const hover_move_walk = RegisterMmove("hover_move_walk", mkMove(FRAME_forwrd01, FRAME_forwrd35, hover_frames_walk, null));

const hover_frames_run: MframeT[] = new Array(35).fill(null).map(() => mkframe(ai_run, 10));
export const hover_move_run = RegisterMmove("hover_move_run", mkMove(FRAME_forwrd01, FRAME_forwrd35, hover_frames_run, null));

function hover_gib(self: EdictT): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_EXPLOSION1);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  self.s.skinnum = Math.trunc(self.s.skinnum / 2);

  ThrowGibs(self, 150, [
    { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
    { count: 2, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
    { gibname: "models/monsters/hover/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
    { count: 2, gibname: "models/monsters/hover/gibs/ring.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_METALLIC },
    { count: 2, gibname: "models/monsters/hover/gibs/foot.md2", type: GibTypeT.GIB_SKINNED },
    { gibname: "models/monsters/hover/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
  ]);
}

const hover_deadthink: ThinkFn = RegisterThink("hover_deadthink", (self: EdictT): void => {
  if (self.groundentity === null && level.time < self.timestamp) {
    self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
    return;
  }
  hover_gib(self);
});

function hover_dying(self: EdictT): void {
  if (self.groundentity !== null) {
    hover_deadthink(self);
    return;
  }

  if (brandom()) return;

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_PLAIN_EXPLOSION);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  if (brandom()) ThrowGibs(self, 120, [{ gibname: "models/objects/gibs/sm_meat/tris.md2" }]);
  else ThrowGibs(self, 120, [{ gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC }]);
}

const hover_frames_death1: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move, 0, hover_dying),
  mkframe(ai_move),
  mkframe(ai_move, 0, hover_dying),
  mkframe(ai_move),
  mkframe(ai_move, 0, hover_dying),
  mkframe(ai_move, -10, hover_dying),
  mkframe(ai_move, 3),
  mkframe(ai_move, 5, hover_dying),
  mkframe(ai_move, 4, hover_dying),
  mkframe(ai_move, 7),
];
export const hover_move_death1 = RegisterMmove("hover_move_death1", mkMove(FRAME_death101, FRAME_death111, hover_frames_death1, hover_dead));

const hover_frames_start_attack: MframeT[] = [mkframe(ai_charge, 1), mkframe(ai_charge, 1), mkframe(ai_charge, 1)];
export const hover_move_start_attack = RegisterMmove("hover_move_start_attack", mkMove(FRAME_attak101, FRAME_attak103, hover_frames_start_attack, hover_attack));

const hover_frames_attack1: MframeT[] = [mkframe(ai_charge, -10, hover_fire_blaster), mkframe(ai_charge, -10, hover_fire_blaster), mkframe(ai_charge, 0, hover_reattack)];
export const hover_move_attack1 = RegisterMmove("hover_move_attack1", mkMove(FRAME_attak104, FRAME_attak106, hover_frames_attack1, null));

const hover_frames_end_attack: MframeT[] = [mkframe(ai_charge, 1), mkframe(ai_charge, 1)];
export const hover_move_end_attack = RegisterMmove("hover_move_end_attack", mkMove(FRAME_attak107, FRAME_attak108, hover_frames_end_attack, hover_run));

// PMM - circle strafing code. The `#if 0`'d `hover_move_start_attack2`/
// `hover_move_end_attack2` (m_hover.cpp:333-355) are dead code in the C++
// source itself -- not ported, see file header.
const hover_frames_attack2: MframeT[] = [mkframe(ai_charge, 10, hover_fire_blaster), mkframe(ai_charge, 10, hover_fire_blaster), mkframe(ai_charge, 10, hover_reattack)];
export const hover_move_attack2 = RegisterMmove("hover_move_attack2", mkMove(FRAME_attak104, FRAME_attak106, hover_frames_attack2, null));
// end of circle strafe

function hover_reattack(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy !== null && enemy.health > 0 && visible(self, enemy) && frandom() <= 0.6) {
    if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_STRAIGHT) {
      M_SetAnimation(self, hover_move_attack1, true);
      return;
    } else if (self.monsterinfo.attack_state === MonsterAttackStateT.AS_SLIDING) {
      M_SetAnimation(self, hover_move_attack2, true);
      return;
    } else {
      gi.Com_Print(`hover_reattack: unexpected state ${self.monsterinfo.attack_state}\n`);
    }
  }
  M_SetAnimation(self, hover_move_end_attack, true);
}

/**
 * `monster_fire_blaster2` (ROGUE mission pack, rogue/g_rogue_monster.cpp:7)
 * -- see file header. Reached only when `self.mass >= 200` (every
 * monster_daedalus).
 */
function monster_fire_blaster2(_self: EdictT, _start: Vec3, _dir: Vec3, _damage: number, _speed: number, _flashtype: MonsterMuzzleflashIdT, _effect: EffectsT): void {
  throw new Error("monster_fire_blaster2: not yet ported (ROGUE mission pack, see rogue/g_rogue_monster.cpp:7 + rogue/g_rogue_newweap.cpp's fire_blaster2)");
}

function hover_fire_blaster(self: EdictT): void {
  const enemy = self.enemy;
  if (enemy === null || !enemy.inuse) return; // PGM

  const forward = vec3(0, 0, 0);
  const right = vec3(0, 0, 0);
  AngleVectors(self.s.angles, forward, right, null);
  const o = monsterFlashOffset()[(self.s.frame & 1) !== 0 ? MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_2 : MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_1];
  const start = M_ProjectFlashSource(self, o, forward, right);

  const end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2] + enemy.viewheight);
  const dir = vec3_sub(end, start);
  vec3_normalize(dir); // vec3_t::normalize() mutates in place, m_hover.cpp:398

  // PGM - daedalus fires blaster2
  if (self.mass < 200) {
    monster_fire_blaster(
      self,
      start,
      dir,
      1,
      1000,
      (self.s.frame & 1) !== 0 ? MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_2 : MonsterMuzzleflashIdT.MZ2_HOVER_BLASTER_1,
      self.s.frame % 4 !== 0 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER,
    );
  } else {
    monster_fire_blaster2(
      self,
      start,
      dir,
      1,
      1000,
      (self.s.frame & 1) !== 0 ? MonsterMuzzleflashIdT.MZ2_DAEDALUS_BLASTER_2 : MonsterMuzzleflashIdT.MZ2_DAEDALUS_BLASTER,
      self.s.frame % 4 !== 0 ? EffectsT.EF_NONE : EffectsT.EF_BLASTER,
    );
  }
  // PGM
}

// ---------------------------------------------------------------------------
// monsterinfo callbacks (m_hover.cpp:408-512)
// ---------------------------------------------------------------------------

function hover_stand(self: EdictT): void {
  M_SetAnimation(self, hover_move_stand, true);
}
RegisterMonsterinfoStand("hover_stand", hover_stand);

function hover_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, hover_move_stand, true);
  else M_SetAnimation(self, hover_move_run, true);
}
RegisterMonsterinfoRun("hover_run", hover_run);

function hover_walk(self: EdictT): void {
  M_SetAnimation(self, hover_move_walk, true);
}
RegisterMonsterinfoWalk("hover_walk", hover_walk);

function hover_start_attack(self: EdictT): void {
  M_SetAnimation(self, hover_move_start_attack, true);
}
RegisterMonsterinfoAttack("hover_start_attack", hover_start_attack);

function hover_attack(self: EdictT): void {
  let chance = 0.5;
  if (self.mass > 150) chance += 0.1; // the daedalus strafes more

  if (frandom() > chance) {
    M_SetAnimation(self, hover_move_attack1, true);
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  } else {
    // circle strafe
    if (frandom() <= 0.5) self.monsterinfo.lefty = !self.monsterinfo.lefty; // switch directions
    M_SetAnimation(self, hover_move_attack2, true);
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
  }
}

const hover_pain: PainFn = RegisterPain("hover_pain", (self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;
  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  let r = frandom();

  if (r < 0.5) {
    // PMM - daedalus sounds
    if (self.mass < 225) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_pain1.index, 1, ATTN_NORM, 0);
  } else {
    if (self.mass < 225) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_pain2.index, 1, ATTN_NORM, 0);
  }
  // PGM

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  r = frandom();

  if (damage <= 25) {
    if (r < 0.5) M_SetAnimation(self, hover_move_pain3, true);
    else M_SetAnimation(self, hover_move_pain2, true);
  } else {
    // PGM pain sequence is WAY too long
    if (r < 0.3) M_SetAnimation(self, hover_move_pain1, true);
    else M_SetAnimation(self, hover_move_pain2, true);
    // PGM
  }
});

function hover_setskin(self: EdictT): void {
  if (self.health < self.max_health / 2) self.s.skinnum |= 1; // PGM support for skins 2 & 3.
  else self.s.skinnum &= ~1; // PGM support for skins 2 & 3.
}
RegisterMonsterinfoSetskin("hover_setskin", hover_setskin);

function hover_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.think = hover_deadthink;
  self.nextthink = Gtime_add(level.time, frameTimeAsGtime());
  self.timestamp = Gtime_add(level.time, Gtime_from_sec(15));
  gi.linkentity(self);
}

const hover_die: DieFn = RegisterDie("hover_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
  self.s.effects = EffectsT.EF_NONE;
  self.monsterinfo.power_armor_type = ItemIdT.IT_NULL;

  if (M_CheckGib(self, mod)) {
    hover_gib(self);
    return;
  }

  if (self.deadflag) return;

  // regular death
  // PMM - daedalus sounds
  if (self.mass < 225) {
    if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, sound_death1.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, sound_death2.index, 1, ATTN_NORM, 0);
  } else {
    if (frandom() < 0.5) gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_death1.index, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_VOICE, daed_sound_death2.index, 1, ATTN_NORM, 0);
  }
  self.deadflag = true;
  self.takedamage = true;
  M_SetAnimation(self, hover_move_death1, true);
});

function hover_set_fly_parameters(self: EdictT): void {
  self.monsterinfo.fly_thrusters = false;
  self.monsterinfo.fly_acceleration = 20.0;
  self.monsterinfo.fly_speed = 120.0;
  // Icarus prefers to keep its distance, but flies slower than the flyer.
  // he never pins because of this.
  self.monsterinfo.fly_min_distance = 150.0;
  self.monsterinfo.fly_max_distance = 350.0;
}

// ---------------------------------------------------------------------------
// SP_monster_hover (m_hover.cpp:576-662) -- serves both "monster_hover" and
// "monster_daedalus" (see g_spawn.ts's own routing, untouched by this unit).
// ---------------------------------------------------------------------------

export function SP_monster_hover(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/hover/tris.md2");

  gi.modelindex("models/monsters/hover/gibs/chest.md2");
  gi.modelindex("models/monsters/hover/gibs/foot.md2");
  gi.modelindex("models/monsters/hover/gibs/head.md2");
  gi.modelindex("models/monsters/hover/gibs/ring.md2");

  self.mins = vec3(-24, -24, -24);
  self.maxs = vec3(24, 24, 32);

  self.health = Math.trunc(240 * st.health_multiplier);
  self.gib_health = -100;
  self.mass = 150;

  self.pain = hover_pain;
  self.die = hover_die;

  self.monsterinfo.stand = hover_stand;
  self.monsterinfo.walk = hover_walk;
  self.monsterinfo.run = hover_run;
  self.monsterinfo.attack = hover_start_attack;
  self.monsterinfo.sight = hover_sight;
  self.monsterinfo.search = hover_search;
  self.monsterinfo.setskin = hover_setskin;

  // PGM
  if (self.classname === "monster_daedalus") {
    self.health = Math.trunc(450 * st.health_multiplier);
    self.mass = 225;
    self.yaw_speed = 23;
    if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SCREEN;
    if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 100;
    // PMM - daedalus sounds
    self.monsterinfo.engine_sound = gi.soundindex("daedalus/daedidle1.wav");
    assignSound(daed_sound_pain1, "daedalus/daedpain1.wav");
    assignSound(daed_sound_pain2, "daedalus/daedpain2.wav");
    assignSound(daed_sound_death1, "daedalus/daeddeth1.wav");
    assignSound(daed_sound_death2, "daedalus/daeddeth2.wav");
    assignSound(daed_sound_sight, "daedalus/daedsght1.wav");
    assignSound(daed_sound_search1, "daedalus/daedsrch1.wav");
    assignSound(daed_sound_search2, "daedalus/daedsrch2.wav");
    gi.soundindex("tank/tnkatck3.wav");
    // pmm
  } else {
    self.yaw_speed = 18;
    assignSound(sound_pain1, "hover/hovpain1.wav");
    assignSound(sound_pain2, "hover/hovpain2.wav");
    assignSound(sound_death1, "hover/hovdeth1.wav");
    assignSound(sound_death2, "hover/hovdeth2.wav");
    assignSound(sound_sight, "hover/hovsght1.wav");
    assignSound(sound_search1, "hover/hovsrch1.wav");
    assignSound(sound_search2, "hover/hovsrch2.wav");
    gi.soundindex("hover/hovatck1.wav");

    self.monsterinfo.engine_sound = gi.soundindex("hover/hovidle1.wav");
  }
  // PGM

  gi.linkentity(self);

  M_SetAnimation(self, hover_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  flymonster_start(self);

  // PGM
  if (self.classname === "monster_daedalus") self.s.skinnum = 2;
  // PGM

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_ALTERNATE_FLY;
  hover_set_fly_parameters(self);
}
