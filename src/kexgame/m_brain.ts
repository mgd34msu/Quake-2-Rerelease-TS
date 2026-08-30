// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_brain.c -- the BRAIN monster (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_brain.cpp (796
// lines, C++17) + m_brain.h (233 lines, frame-index enum + MODEL_SCALE): the
// full stand/idle/walk/run/pain/duck/death frame-animation system, the
// vanilla two-hit claw melee (attack1) and chest/tentacle melee (attack2),
// the RAFAEL/xatrix chest+tongue-pull+tentacle combo melee (attack3), the
// RAFAEL/xatrix dual-eye laser beam attack (attack4) and its attack
// dispatcher, brain_pain/brain_die/brain_setskin/brain_dead, and
// SP_monster_brain. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_soldier.ts headers).
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED, AND HOW EACH IS HANDLED
// ============================================================================
// - `monster_fire_dabeam`/`dabeam_update` (xatrix/g_xatrix_monster.cpp:112/84):
//   STUB SWAP (xatrix unit) -- g_xatrix_monster.ts has now landed as the real
//   home of both. The local throwing stubs that used to live here are
//   DELETED and replaced with `import { dabeam_update, monster_fire_dabeam }
//   from "./g_xatrix_monster"`. `brain_attack`'s laser branch
//   (`brain_move_attack4`, reached at long range or on a 50% coin flip at
//   close range whenever `!SPAWNFLAG_BRAIN_NO_LASERS`) now genuinely fires:
//   `brain_left_eye_laser_update`/`brain_right_eye_laser_update` (already
//   ported for real below, unchanged) are no longer dead code.
// - `brain_right_eye_laser_update`/`brain_left_eye_laser_update` (the two
//   PRETHINK callbacks passed to `monster_fire_dabeam`) ARE ported for real
//   below, even though the stub above means `monster_fire_dabeam` never
//   actually schedules them today -- matching m_gunner.ts's own
//   `gunner_jump_now`/`gunner_jump2_now` precedent ("port for real code that
//   is only reachable via a currently-stubbed path, not deleted"). Each is
//   registered under its real save name via `RegisterPrethink` so a future
//   xatrix unit can wire `monster_fire_dabeam` straight through with zero
//   changes here.
// - `PredictAim` (rogue/g_rogue_newai.cpp:1083): imported for real from
//   m_supertank.ts, this porting batch's canonical exported home (see that
//   file's own header) -- not re-implemented locally.
// - `monster_duck_down`/`monster_duck_hold`/`monster_duck_up`/
//   `monster_done_dodge`/`M_MonsterDodge` (rogue/g_rogue_newai.cpp /
//   rogue/g_rogue_monster.cpp): imported for real from m_soldier.ts, this
//   porting batch's canonical exported home for the shared rogue-newai
//   duck/dodge infrastructure (per this unit's brief) -- never re-registered
//   here, since g_save_registry.ts's monsterinfo_duck/unduck/dodge
//   registries are global and name-keyed and would throw on a second
//   registration under the same name.
// - `monster_footstep(edict_t*)` (g_local.h:3282, `inline`) and
//   `M_CheckGib(edict_t*, const mod_t&)` (g_local.h:3521, `inline`): trivial
//   one-liners, duplicated locally rather than imported -- same treatment as
//   every other file in this porting batch (m_gunner.ts/m_soldier.ts).
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG (see inline citations)
// ============================================================================
// - `brain_move_attack2` and `brain_move_attack3` (m_brain.cpp:370/557) both
//   use the IDENTICAL frame range `FRAME_attak201..FRAME_attak217` despite
//   having different per-frame think-func hookups (attack2 is the vanilla
//   chest+tentacle combo; attack3 is the RAFAEL chest+tongue-pull+tentacle
//   combo) -- preserved exactly, not a typo to "fix".
// - `brain_move_run` and `brain_move_attack4` (m_brain.cpp:607/572) both
//   reuse `FRAME_walk101..FRAME_walk111` (the walk1 range) for entirely
//   different frame arrays/think-funcs -- also preserved exactly.
// - `brain_right_eye_laser_update`/`brain_left_eye_laser_update`
//   (m_brain.cpp:478/499) are asymmetric: only the LEFT eye's prethink calls
//   `dabeam_update(laser, false)` at the end; the right eye's does not. This
//   looks like a copy-paste artifact in the original source but is preserved
//   verbatim per this port line's bug-for-bug mandate.
// - `brain_attack`'s RANGE_NEAR branch (m_brain.cpp:575-587): at long range,
//   the laser attack fires unconditionally if lasers aren't disabled, but if
//   SPAWNFLAG_BRAIN_NO_LASERS IS set, `brain_attack` does nothing at all at
//   long range (no melee fallback) -- ported as-is, not "fixed" to fall back
//   to melee.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `cached_soundindex` fields port as `{ index: 0 }` mutable boxes assigned
//   via a local `assignSound` helper, matching m_gunner.ts's precedent.
// - `PredictAim` keeps its two C++ output pointer params (`aimdir`/
//   `aimpoint`, either nullable) exactly as m_supertank.ts's real export
//   already ports them -- both eye-laser prethinks here only want `aimdir`,
//   so `aimpoint` is passed `null`.
// - `st.was_key_specified(key)` is inlined as `st.keys_specified.has(key)`
//   per g_local_types.ts's own documented scope note for that member.
// - Vec3 "copy" sites use `vec3(v[0], v[1], v[2])`, matching every other
//   file in this porting batch's established idiom (Vec3 is a mutable
//   Float32Array; a bare `=` would alias).

import { vec3, type Vec3 } from "../shared/math";
import { type EdictT, type ModT, type PainFn, type DieFn, DamageflagsT, GibTypeT, ModIdT, MonsterAiFlagsT, MovetypeT, MELEE_DISTANCE, RANGE_NEAR, ItemIdT } from "./g_local";
import { ATTN_IDLE, ATTN_NORM, KexEntityEventT, KexMulticastT, KexTempEventT, MASK_PROJECTILE, ServerCommandT, SolidT, SoundchanT, SvflagsT } from "../kexapi/game";
import {
  RegisterMmove,
  RegisterPain,
  RegisterDie,
  RegisterPrethink,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMonsterinfoAttack,
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoSearch,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoDuck,
} from "./g_save_registry";
import { monster_duck_down, monster_duck_hold, monster_duck_up, M_MonsterDodge } from "./m_soldier";
import { PredictAim } from "./m_supertank";
import type { MframeT, PrethinkFn } from "./g_local_types";
import { MmoveT } from "./g_local_types";
import { gi, level } from "./g_main_globals";
import { ai_charge, ai_move, ai_run, ai_stand, ai_walk, range_to, visible } from "./g_ai";
import { M_AllowSpawn, M_ProjectFlashSource, M_SetAnimation, M_ShouldReactToPain, monster_dead, walkmonster_start } from "./g_monster";
import { ThrowGibs } from "./g_misc";
import { fire_hit } from "./g_weapon";
import { T_Damage } from "./g_combat";
import { AngleVectors_destructured, vec3_add, vec3_length, vec3_muls, vec3_sub, vectoangles } from "./q_vec3";
import { vec3_origin } from "../shared/math";
import { dabeam_update, monster_fire_dabeam } from "./g_xatrix_monster";
import { G_FreeEdict } from "./g_utils";
import { frandom, irandom } from "./q_std";
import { Gtime_add, Gtime_from_sec, type GTime } from "./gtime";
import { st } from "./g_spawn";

// ---------------------------------------------------------------------------
// m_brain.h frame index constants -- only the FRAME_ entries this file's own
// logic references (see m_gunner.ts/m_gladiator.ts precedent for why the
// full enum isn't transcribed). Values derived by counting the anonymous
// enum in m_brain.h sequentially from FRAME_walk101=0 (11 walk1, 40 walk2,
// 18 attak1, 17 attak2, 21 pain1, 8 pain2, 6 pain3, 18 death1, 5 death2, 8
// duck, 8 defens [unused, #if 0'd in the C++], 60 stand) -- cross-checked
// against every MMOVE_T's own frame-count validator below (MmoveT throws at
// module-load time on a mismatch; a `bun -e` smoke import after this file
// was fully written confirmed all 12 tables pass).
// ---------------------------------------------------------------------------
const FRAME_walk101 = 0;
const FRAME_walk111 = 10;
const FRAME_attak101 = 53;
const FRAME_attak118 = 70;
const FRAME_attak201 = 71;
const FRAME_attak217 = 87;
const FRAME_pain101 = 88;
const FRAME_pain121 = 108;
const FRAME_pain201 = 109;
const FRAME_pain208 = 116;
const FRAME_pain301 = 117;
const FRAME_pain306 = 122;
const FRAME_death101 = 123;
const FRAME_death118 = 140;
const FRAME_death201 = 141;
const FRAME_death205 = 145;
const FRAME_duck01 = 146;
const FRAME_duck08 = 153;
const FRAME_stand01 = 162;
const FRAME_stand30 = 191;
const FRAME_stand31 = 192;
const FRAME_stand60 = 221;

const MODEL_SCALE = 1.0;

const SPAWNFLAG_BRAIN_NO_LASERS = 8;

// dabeam_update / monster_fire_dabeam: real imports from g_xatrix_monster.ts
// -- see file header "STUB SWAP (xatrix unit)".

// ---------------------------------------------------------------------------
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see file header
// ---------------------------------------------------------------------------

/** g_local.h:3282 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  if (self.groundentity !== null) self.s.event = KexEntityEventT.EV_OTHER_FOOTSTEP;
}

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

// ---------------------------------------------------------------------------
// small local helpers -- duplicated per-file, see m_gunner.ts precedent
// ---------------------------------------------------------------------------

interface CachedSoundindex {
  index: number;
}
function cachedSoundindex(): CachedSoundindex {
  return { index: 0 };
}
function assignSound(cached: CachedSoundindex, name: string): void {
  cached.index = gi.soundindex(name);
}
function mkframe(aifunc: MframeT["aifunc"], dist = 0, thinkfunc: MframeT["thinkfunc"] = null): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame: -1 };
}
function mkMove(firstframe: number, lastframe: number, frame: MframeT[], endfunc: MmoveT["endfunc"]): MmoveT {
  return Object.assign(new MmoveT(), { firstframe, lastframe, frame, endfunc });
}

const sound_chest_open = cachedSoundindex();
const sound_tentacles_extend = cachedSoundindex();
const sound_tentacles_retract = cachedSoundindex();
const sound_death = cachedSoundindex();
const sound_idle1 = cachedSoundindex();
const sound_idle2 = cachedSoundindex();
const sound_idle3 = cachedSoundindex();
const sound_pain1 = cachedSoundindex();
const sound_pain2 = cachedSoundindex();
const sound_sight = cachedSoundindex();
const sound_search = cachedSoundindex();
const sound_melee1 = cachedSoundindex();
const sound_melee2 = cachedSoundindex();
const sound_melee3 = cachedSoundindex();

export const brain_sight = RegisterMonsterinfoSight("brain_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight.index, 1, ATTN_NORM, 0);
});

export const brain_search = RegisterMonsterinfoSearch("brain_search", (self: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_search.index, 1, ATTN_NORM, 0);
});

// ---------------------------------------------------------------------------
// stand / idle
// ---------------------------------------------------------------------------

const brain_frames_stand: MframeT[] = new Array(30).fill(null).map(() => mkframe(ai_stand));
export const brain_move_stand = RegisterMmove("brain_move_stand", mkMove(FRAME_stand01, FRAME_stand30, brain_frames_stand, null));

export const brain_stand = RegisterMonsterinfoStand("brain_stand", (self: EdictT): void => {
  M_SetAnimation(self, brain_move_stand, false);
});

const brain_frames_idle: MframeT[] = new Array(30).fill(null).map(() => mkframe(ai_stand));
export const brain_move_idle = RegisterMmove("brain_move_idle", mkMove(FRAME_stand31, FRAME_stand60, brain_frames_idle, (self: EdictT) => brain_stand(self)));

export const brain_idle = RegisterMonsterinfoIdle("brain_idle", (self: EdictT): void => {
  gi.sound(self, SoundchanT.CHAN_AUTO, sound_idle3.index, 1, ATTN_IDLE, 0);
  M_SetAnimation(self, brain_move_idle, false);
});

// ---------------------------------------------------------------------------
// walk
// ---------------------------------------------------------------------------

const brain_frames_walk1: MframeT[] = [
  mkframe(ai_walk, 7),
  mkframe(ai_walk, 2),
  mkframe(ai_walk, 3),
  mkframe(ai_walk, 3, monster_footstep),
  mkframe(ai_walk, 1),
  mkframe(ai_walk),
  mkframe(ai_walk),
  mkframe(ai_walk, 9),
  mkframe(ai_walk, -4),
  mkframe(ai_walk, -1, monster_footstep),
  mkframe(ai_walk, 2),
];
export const brain_move_walk1 = RegisterMmove("brain_move_walk1", mkMove(FRAME_walk101, FRAME_walk111, brain_frames_walk1, null));

export const brain_walk = RegisterMonsterinfoWalk("brain_walk", (self: EdictT): void => {
  M_SetAnimation(self, brain_move_walk1, false);
});

// ---------------------------------------------------------------------------
// pain
// ---------------------------------------------------------------------------

const brain_frames_pain3: MframeT[] = [mkframe(ai_move, -2), mkframe(ai_move, 2), mkframe(ai_move, 1), mkframe(ai_move, 3), mkframe(ai_move), mkframe(ai_move, -4)];
export const brain_move_pain3 = RegisterMmove("brain_move_pain3", mkMove(FRAME_pain301, FRAME_pain306, brain_frames_pain3, (self: EdictT) => brain_run(self)));

const brain_frames_pain2: MframeT[] = [
  mkframe(ai_move, -2),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 3),
  mkframe(ai_move, 1),
  mkframe(ai_move, -2),
];
export const brain_move_pain2 = RegisterMmove("brain_move_pain2", mkMove(FRAME_pain201, FRAME_pain208, brain_frames_pain2, (self: EdictT) => brain_run(self)));

const brain_frames_pain1: MframeT[] = [
  mkframe(ai_move, -6),
  mkframe(ai_move, -2),
  mkframe(ai_move, -6, monster_footstep),
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
  mkframe(ai_move, 2),
  mkframe(ai_move),
  mkframe(ai_move, 2),
  mkframe(ai_move, 1),
  mkframe(ai_move, 7),
  mkframe(ai_move),
  mkframe(ai_move, 3, monster_footstep),
  mkframe(ai_move, -1),
];
export const brain_move_pain1 = RegisterMmove("brain_move_pain1", mkMove(FRAME_pain101, FRAME_pain121, brain_frames_pain1, (self: EdictT) => brain_run(self)));

// ---------------------------------------------------------------------------
// duck (PMM - new dodge)
// ---------------------------------------------------------------------------

const brain_frames_duck: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move, -2, (self: EdictT) => {
    monster_duck_down(self);
    monster_footstep(self);
  }),
  mkframe(ai_move, 17, monster_duck_hold),
  mkframe(ai_move, -3),
  mkframe(ai_move, -1, monster_duck_up),
  mkframe(ai_move, -5),
  mkframe(ai_move, -6),
  mkframe(ai_move, -6, monster_footstep),
];
export const brain_move_duck = RegisterMmove("brain_move_duck", mkMove(FRAME_duck01, FRAME_duck08, brain_frames_duck, (self: EdictT) => brain_run(self)));

export const brain_duck = RegisterMonsterinfoDuck("brain_duck", (self: EdictT, _eta: GTime): boolean => {
  M_SetAnimation(self, brain_move_duck, false);
  return true;
});

// ---------------------------------------------------------------------------
// death
// ---------------------------------------------------------------------------

function brain_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const brain_frames_death2: MframeT[] = [mkframe(ai_move), mkframe(ai_move, 0, monster_footstep), mkframe(ai_move, 0, brain_shrink), mkframe(ai_move, 9), mkframe(ai_move)];
export const brain_move_death2 = RegisterMmove("brain_move_death2", mkMove(FRAME_death201, FRAME_death205, brain_frames_death2, (self: EdictT) => brain_dead(self)));

const brain_frames_death1: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_move, -2),
  mkframe(ai_move, 9, (self: EdictT) => {
    brain_shrink(self);
    monster_footstep(self);
  }),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, monster_footstep),
  mkframe(ai_move),
  mkframe(ai_move),
];
export const brain_move_death1 = RegisterMmove("brain_move_death1", mkMove(FRAME_death101, FRAME_death118, brain_frames_death1, (self: EdictT) => brain_dead(self)));

// ---------------------------------------------------------------------------
// melee (attack1 -- vanilla claw combo)
// ---------------------------------------------------------------------------

function brain_swing_right(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_melee1.index, 1, ATTN_NORM, 0);
}

/** m_brain.cpp:279-286. Damage constant: `irandom(15, 20)` kick 40. */
function brain_hit_right(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.maxs[0], 8);
  if (fire_hit(self, aim, irandom(15, 20), 40)) {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_melee3.index, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  }
}

function brain_swing_left(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_BODY, sound_melee2.index, 1, ATTN_NORM, 0);
}

function brain_hit_left(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, self.mins[0], 8);
  if (fire_hit(self, aim, irandom(15, 20), 40)) {
    gi.sound(self, SoundchanT.CHAN_WEAPON, sound_melee3.index, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  }
}

const brain_frames_attack1: MframeT[] = [
  mkframe(ai_charge, 8),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 0, monster_footstep),
  mkframe(ai_charge, -3, brain_swing_right),
  mkframe(ai_charge),
  mkframe(ai_charge, -5),
  mkframe(ai_charge, -7, brain_hit_right),
  mkframe(ai_charge),
  mkframe(ai_charge, 6, brain_swing_left),
  mkframe(ai_charge, 1),
  mkframe(ai_charge, 2, brain_hit_left),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, -1),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -11, monster_footstep),
];
export const brain_move_attack1 = RegisterMmove("brain_move_attack1", mkMove(FRAME_attak101, FRAME_attak118, brain_frames_attack1, (self: EdictT) => brain_run(self)));

// ---------------------------------------------------------------------------
// melee (attack2 -- vanilla chest/tentacle combo)
// ---------------------------------------------------------------------------

function brain_chest_open(self: EdictT): void {
  self.count = 0;
  self.monsterinfo.power_armor_type = ItemIdT.IT_NULL;
  gi.sound(self, SoundchanT.CHAN_BODY, sound_chest_open.index, 1, ATTN_NORM, 0);
}

/** m_brain.cpp:331-339. Damage constant: `irandom(10, 15)` kick -600
 *  (negative kick pulls the target toward the brain). */
function brain_tentacle_attack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 8);
  if (fire_hit(self, aim, irandom(10, 15), -600)) {
    self.count = 1;
  } else {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
  }
  gi.sound(self, SoundchanT.CHAN_WEAPON, sound_tentacles_retract.index, 1, ATTN_NORM, 0);
}

function brain_chest_closed(self: EdictT): void {
  self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SCREEN;
  if (self.count !== 0) {
    self.count = 0;
    M_SetAnimation(self, brain_move_attack1, false);
  }
}

const brain_frames_attack2: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0, brain_chest_open),
  mkframe(ai_charge),
  mkframe(ai_charge, 13, brain_tentacle_attack),
  mkframe(ai_charge),
  mkframe(ai_charge, 2),
  mkframe(ai_charge),
  mkframe(ai_charge, -9, brain_chest_closed),
  mkframe(ai_charge),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, -6),
];
export const brain_move_attack2 = RegisterMmove("brain_move_attack2", mkMove(FRAME_attak201, FRAME_attak217, brain_frames_attack2, (self: EdictT) => brain_run(self)));

export const brain_melee = RegisterMonsterinfoMelee("brain_melee", (self: EdictT): void => {
  if (frandom() <= 0.5) M_SetAnimation(self, brain_move_attack1, false);
  else M_SetAnimation(self, brain_move_attack2, false);
});

// ---------------------------------------------------------------------------
// RAFAEL -- attack3 (chest/tongue-pull/tentacle combo)
// ---------------------------------------------------------------------------

/** m_brain.cpp:381-398. */
function brain_tounge_attack_ok(start: Vec3, end: Vec3): boolean {
  const dir = vec3_sub(start, end);
  if (vec3_length(dir) > 512) return false;

  const angles = vectoangles(dir);
  if (angles[0] < -180) angles[0] += 360;
  if (Math.abs(angles[0]) > 30) return false;

  return true;
}

/** m_brain.cpp:400-446. Damage constant: fixed 5, DAMAGE_NO_KNOCKBACK,
 *  MOD_BRAINTENTACLE. Pulls the enemy toward the brain at 1200 u/s after
 *  landing. */
function brain_tounge_attack(self: EdictT): void {
  if (self.enemy === null) return;

  const { forward: f, right: r } = AngleVectors_destructured(self.s.angles);
  const offset = vec3(24, 0, 16);
  const start = M_ProjectFlashSource(self, offset, f, r);

  let end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);
  if (!brain_tounge_attack_ok(start, end)) {
    end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.maxs[2] - 8);
    if (!brain_tounge_attack_ok(start, end)) {
      end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2] + self.enemy.mins[2] + 8);
      if (!brain_tounge_attack_ok(start, end)) return;
    }
  }
  end = vec3(self.enemy.s.origin[0], self.enemy.s.origin[1], self.enemy.s.origin[2]);

  const tr = gi.trace(start, null, null, end, self, MASK_PROJECTILE);
  if (tr.ent !== self.enemy) return;

  const damage = 5;
  gi.sound(self, SoundchanT.CHAN_WEAPON, sound_tentacles_retract.index, 1, ATTN_NORM, 0);

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_PARASITE_ATTACK);
  gi.WriteEntity(self);
  gi.WritePosition(start);
  gi.WritePosition(end);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  const dir = vec3_sub(start, end);
  T_Damage(self.enemy, self, self, dir, self.enemy.s.origin, vec3_origin, damage, 0, DamageflagsT.DAMAGE_NO_KNOCKBACK, {
    id: ModIdT.MOD_BRAINTENTACLE,
    friendly_fire: false,
    no_point_loss: false,
  });

  // pull the enemy in
  self.s.origin[2] += 1;
  const { forward } = AngleVectors_destructured(self.s.angles);
  self.enemy.velocity = vec3_muls(forward, -1200);
}

const brain_frames_attack3: MframeT[] = [
  mkframe(ai_charge, 5),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -4),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, 0, brain_chest_open),
  mkframe(ai_charge, 0, brain_tounge_attack),
  mkframe(ai_charge, 13),
  mkframe(ai_charge, 0, brain_tentacle_attack),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 0, brain_tounge_attack),
  mkframe(ai_charge, -9, brain_chest_closed),
  mkframe(ai_charge),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 3),
  mkframe(ai_charge, 2),
  mkframe(ai_charge, -3),
  mkframe(ai_charge, -6),
];
// NOTE: same frame range as brain_move_attack2 -- preserved verbatim, see
// file header's "QUIRKS PRESERVED BUG-FOR-BUG" section.
export const brain_move_attack3 = RegisterMmove("brain_move_attack3", mkMove(FRAME_attak201, FRAME_attak217, brain_frames_attack3, (self: EdictT) => brain_run(self)));

// ---------------------------------------------------------------------------
// RAFAEL -- attack4 (dual-eye laser beam)
// ---------------------------------------------------------------------------

// Brain right eye center (m_brain.cpp:449-461).
const brain_reye: readonly Vec3[] = [
  vec3(0.7467, 0.23837, 34.16769),
  vec3(-1.07639, 0.23837, 33.386372),
  vec3(-1.3355, 5.3343, 32.17717),
  vec3(-0.17536, 8.84637, 30.635479),
  vec3(-2.75759, 7.80461, 30.15086),
  vec3(-5.57509, 5.15284, 30.05616),
  vec3(-7.01755, 3.26247, 30.552521),
  vec3(-7.91574, 0.6388, 33.176189),
  vec3(-3.91539, 8.28573, 33.976349),
  vec3(-0.91354, 10.93303, 34.141811),
  vec3(-0.3699, 8.9239, 34.189079),
];

// Brain left eye center (m_brain.cpp:464-476).
const brain_leye: readonly Vec3[] = [
  vec3(-3.36471, 0.32775, 33.938381),
  vec3(-5.14045, 0.49348, 32.659851),
  vec3(-5.34198, 5.64698, 31.277901),
  vec3(-4.13448, 9.27744, 29.925621),
  vec3(-6.59834, 6.81509, 29.32262),
  vec3(-8.61084, 2.52965, 29.251591),
  vec3(-9.23136, 0.09328, 29.747959),
  vec3(-11.00411, 1.93693, 32.39526),
  vec3(-7.87831, 7.64819, 33.148151),
  vec3(-4.94737, 11.43005, 33.31361),
  vec3(-4.33282, 9.44457, 33.52634),
];

/** m_brain.cpp:478-497 (PRETHINK). NOTE: unlike the left-eye version below,
 *  this one does NOT call `dabeam_update` -- preserved verbatim, see file
 *  header's "QUIRKS PRESERVED BUG-FOR-BUG" section. */
export const brain_right_eye_laser_update: PrethinkFn = RegisterPrethink("brain_right_eye_laser_update", (laser: EdictT): void => {
  const self = laser.owner;
  if (self === null) return;

  const { forward, right, up } = AngleVectors_destructured(self.s.angles);

  const eye = brain_reye[self.s.frame - FRAME_walk101] as Vec3;
  let start = vec3_add(self.s.origin, vec3_muls(right, eye[0]));
  start = vec3_add(start, vec3_muls(forward, eye[1]));
  start = vec3_add(start, vec3_muls(up, eye[2]));

  const dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, false, frandom(0.1, 0.2), dir, null);

  laser.s.origin = start;
  laser.movedir = dir;
  gi.linkentity(laser);
});

/** m_brain.cpp:499-519 (PRETHINK). */
export const brain_left_eye_laser_update: PrethinkFn = RegisterPrethink("brain_left_eye_laser_update", (laser: EdictT): void => {
  const self = laser.owner;
  if (self === null) return;

  const { forward, right, up } = AngleVectors_destructured(self.s.angles);

  const eye = brain_leye[self.s.frame - FRAME_walk101] as Vec3;
  let start = vec3_add(self.s.origin, vec3_muls(right, eye[0]));
  start = vec3_add(start, vec3_muls(forward, eye[1]));
  start = vec3_add(start, vec3_muls(up, eye[2]));

  const dir = vec3(0, 0, 0);
  PredictAim(self, self.enemy, start, 0, false, frandom(0.1, 0.2), dir, null);

  laser.s.origin = start;
  laser.movedir = dir;
  gi.linkentity(laser);
  dabeam_update(laser, false);
});

function brain_laserbeam(self: EdictT): void {
  // dis is my right eye
  monster_fire_dabeam(self, 1, false, brain_right_eye_laser_update);
  // dis is me left eye
  monster_fire_dabeam(self, 1, true, brain_left_eye_laser_update);
}

function brain_laserbeam_reattack(self: EdictT): void {
  if (frandom() < 0.5 && self.enemy !== null) {
    if (visible(self, self.enemy) && self.enemy.health > 0) {
      self.s.frame = FRAME_walk101;
    }
  }
}

const brain_frames_attack4: MframeT[] = [
  mkframe(ai_charge, 9, brain_laserbeam),
  mkframe(ai_charge, 2, brain_laserbeam),
  mkframe(ai_charge, 3, brain_laserbeam),
  mkframe(ai_charge, 3, brain_laserbeam),
  mkframe(ai_charge, 1, brain_laserbeam),
  mkframe(ai_charge, 0, brain_laserbeam),
  mkframe(ai_charge, 0, brain_laserbeam),
  mkframe(ai_charge, 10, brain_laserbeam),
  mkframe(ai_charge, -4, brain_laserbeam),
  mkframe(ai_charge, -1, brain_laserbeam),
  mkframe(ai_charge, 2, brain_laserbeam_reattack),
];
// NOTE: same frame range as brain_move_run -- preserved verbatim, see file
// header's "QUIRKS PRESERVED BUG-FOR-BUG" section.
export const brain_move_attack4 = RegisterMmove("brain_move_attack4", mkMove(FRAME_walk101, FRAME_walk111, brain_frames_attack4, (self: EdictT) => brain_run(self)));

/** m_brain.cpp:575-587 (RAFAEL). At long range, does nothing if
 *  SPAWNFLAG_BRAIN_NO_LASERS is set -- no melee fallback. Preserved as-is,
 *  see file header. */
export const brain_attack = RegisterMonsterinfoAttack("brain_attack", (self: EdictT): void => {
  if (self.enemy === null) return;
  const r = range_to(self, self.enemy);
  if (r <= RANGE_NEAR) {
    if (frandom() < 0.5) {
      M_SetAnimation(self, brain_move_attack3, false);
    } else if ((self.spawnflags & SPAWNFLAG_BRAIN_NO_LASERS) === 0) {
      M_SetAnimation(self, brain_move_attack4, false);
    }
  } else if ((self.spawnflags & SPAWNFLAG_BRAIN_NO_LASERS) === 0) {
    M_SetAnimation(self, brain_move_attack4, false);
  }
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const brain_frames_run: MframeT[] = [
  mkframe(ai_run, 9),
  mkframe(ai_run, 2),
  mkframe(ai_run, 3),
  mkframe(ai_run, 3),
  mkframe(ai_run, 1),
  mkframe(ai_run),
  mkframe(ai_run),
  mkframe(ai_run, 10),
  mkframe(ai_run, -4),
  mkframe(ai_run, -1),
  mkframe(ai_run, 2),
];
// NOTE: same frame range as brain_move_walk1 -- preserved verbatim, see file
// header's "QUIRKS PRESERVED BUG-FOR-BUG" section.
export const brain_move_run = RegisterMmove("brain_move_run", mkMove(FRAME_walk101, FRAME_walk111, brain_frames_run, null));

export const brain_run = RegisterMonsterinfoRun("brain_run", (self: EdictT): void => {
  self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SCREEN;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) {
    M_SetAnimation(self, brain_move_stand, false);
  } else {
    M_SetAnimation(self, brain_move_run, false);
  }
});

export const brain_pain: PainFn = RegisterPain("brain_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const r = frandom();

  if (r < 0.33) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NORM, 0);
  else if (r < 0.66) gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain2.index, 1, ATTN_NORM, 0);
  else gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain1.index, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  if (r < 0.33) M_SetAnimation(self, brain_move_pain1, false);
  else if (r < 0.66) M_SetAnimation(self, brain_move_pain2, false);
  else M_SetAnimation(self, brain_move_pain3, false);

  // PMM - clear duck flag
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) !== 0n) monster_duck_up(self);
});

export const brain_setskin = RegisterMonsterinfoSetskin("brain_setskin", (self: EdictT): void => {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
});

function brain_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  monster_dead(self);
}

export const brain_die: DieFn = RegisterDie("brain_die", (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
  self.s.effects = 0n; // EF_NONE
  self.monsterinfo.power_armor_type = ItemIdT.IT_NULL;

  // check for gib
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    if (self.beam !== null) {
      G_FreeEdict(self.beam);
      self.beam = null;
    }
    if (self.beam2 !== null) {
      G_FreeEdict(self.beam2);
      self.beam2 = null;
    }

    ThrowGibs(self, damage, [
      { count: 1, gibname: "models/objects/gibs/bone/tris.md2" },
      { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { count: 2, gibname: "models/monsters/brain/gibs/arm.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/brain/gibs/boot.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/brain/gibs/pelvis.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/brain/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
      { count: 2, gibname: "models/monsters/brain/gibs/door.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { gibname: "models/monsters/brain/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
    ]);

    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  // regular death
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_death.index, 1, ATTN_NORM, 0);
  self.deadflag = true;
  self.takedamage = true;
  if (frandom() <= 0.5) M_SetAnimation(self, brain_move_death1, false);
  else M_SetAnimation(self, brain_move_death2, false);
});

// ---------------------------------------------------------------------------
// SP_monster_brain
// ---------------------------------------------------------------------------

/*QUAKED monster_brain (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn Sight
 */
export function SP_monster_brain(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  assignSound(sound_chest_open, "brain/brnatck1.wav");
  assignSound(sound_tentacles_extend, "brain/brnatck2.wav");
  assignSound(sound_tentacles_retract, "brain/brnatck3.wav");
  assignSound(sound_death, "brain/brndeth1.wav");
  assignSound(sound_idle1, "brain/brnidle1.wav");
  assignSound(sound_idle2, "brain/brnidle2.wav");
  assignSound(sound_idle3, "brain/brnlens1.wav");
  assignSound(sound_pain1, "brain/brnpain1.wav");
  assignSound(sound_pain2, "brain/brnpain2.wav");
  assignSound(sound_sight, "brain/brnsght1.wav");
  assignSound(sound_search, "brain/brnsrch1.wav");
  assignSound(sound_melee1, "brain/melee1.wav");
  assignSound(sound_melee2, "brain/melee2.wav");
  assignSound(sound_melee3, "brain/melee3.wav");

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/brain/tris.md2");

  gi.modelindex("models/monsters/brain/gibs/arm.md2");
  gi.modelindex("models/monsters/brain/gibs/boot.md2");
  gi.modelindex("models/monsters/brain/gibs/chest.md2");
  gi.modelindex("models/monsters/brain/gibs/door.md2");
  gi.modelindex("models/monsters/brain/gibs/head.md2");
  gi.modelindex("models/monsters/brain/gibs/pelvis.md2");

  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);

  self.health = Math.trunc(300 * st.health_multiplier);
  self.gib_health = -150;
  self.mass = 400;

  self.pain = brain_pain;
  self.die = brain_die;

  self.monsterinfo.stand = brain_stand;
  self.monsterinfo.walk = brain_walk;
  self.monsterinfo.run = brain_run;
  // PMM
  self.monsterinfo.dodge = M_MonsterDodge;
  self.monsterinfo.duck = brain_duck;
  self.monsterinfo.unduck = monster_duck_up;
  // pmm
  // RAFAEL
  self.monsterinfo.attack = brain_attack;
  // RAFAEL
  self.monsterinfo.melee = brain_melee;
  self.monsterinfo.sight = brain_sight;
  self.monsterinfo.search = brain_search;
  self.monsterinfo.idle = brain_idle;
  self.monsterinfo.setskin = brain_setskin;

  if (!st.keys_specified.has("power_armor_type")) self.monsterinfo.power_armor_type = ItemIdT.IT_ITEM_POWER_SCREEN;
  if (!st.keys_specified.has("power_armor_power")) self.monsterinfo.power_armor_power = 100;

  gi.linkentity(self);

  M_SetAnimation(self, brain_move_stand, false);
  self.monsterinfo.scale = MODEL_SCALE;

  walkmonster_start(self);
}
