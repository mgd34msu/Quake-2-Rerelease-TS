// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_rogue_stalker.c -- the STALKER monster (2023 Quake II re-release / "KEX"
// engine, Rogue Entertainment mission-pack content). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/m_rogue_stalker.cpp
// (1,041 lines) + m_rogue_stalker.h (104 lines, 93 FRAME_ constants +
// MODEL_SCALE), C++17. Behavioral code, ported bug-for-bug per this port
// line's house conventions (see g_monster.ts/m_soldier.ts/m_medic.ts
// headers). One spawn function, `SP_monster_stalker`, classname
// "monster_stalker".
//
// ============================================================================
// FORWARD-DECLARED C++ FUNCTIONS -> TS HOISTED `function` DECLARATIONS
// ============================================================================
// Same technique m_soldier.ts documents at its own header (lines 83-100):
// the C++ source forward-declares `stalker_do_pounce`/`stalker_walk`/
// `stalker_dodge_jump`/`stalker_swing_attack`/`stalker_jump_straightup`/
// `stalker_jump_wait_land`/`stalker_false_death`/`stalker_false_death_start`/
// `stalker_ok_to_transition`/`stalker_stand` (cpp:22-31) because its frame
// tables reference several of these as endfuncs before their own bodies
// appear later in the file. TS has no function-pointer forward declaration,
// but plain `function name(...) {}` declarations are hoisted with their full
// body, so every monsterinfo/pain/die handler below is written that way
// (with a separate `RegisterXxx("name", name)` statement immediately after),
// instead of the `const x = RegisterXxx(...)` idiom other landed files use
// when there is no forward-reference need.
//
// ============================================================================
// THE CEILING-WALK PHYSICS (physics_change hook)
// ============================================================================
// Stalkers walk on the ceiling by flipping `gravityVector[2]` positive
// (`STALKER_ON_CEILING`, cpp:32-36: `ent->gravityVector[2] > 0`).
// `gravityVector` is an already-real `Vec3` field on `EdictT`, used the same
// way by g_monster.ts/g_phys.ts -- no new field needed. `stalker_physics_change`
// (cpp:886-896, `MONSTERINFO_PHYSCHANGED`) is exactly the hook g_phys.ts:1045
// already calls (`ent.monsterinfo.physics_change`) whenever `groundentity`'s
// truthiness flips across a physics frame: "[Paril-KEX] quick patch-job to
// fix stalkers endlessly floating up into the sky" -- if the stalker is on
// the ceiling AND has no groundentity (i.e. it just fell off), flip back to
// normal gravity and rotate 180 degrees on the roll axis. Registered via
// `RegisterMonsterinfoPhyschanged` (g_save_registry.ts:468) and assigned to
// `self.monsterinfo.physics_change` in SP_monster_stalker (cpp:1023).
// `stalker_ok_to_transition` (cpp:40-133) and `stalker_jump_straightup`
// (cpp:666-694) duplicate this exact gravity-flip logic inline for their own
// voluntary ceiling<->floor transitions (jump-triggered, not the passive
// fell-off-the-ceiling safety net); `stalker_blocked` (cpp:845-884) has a
// third copy for its own blocked-while-on-ceiling case. All three are ported
// verbatim, bug-for-bug (the same flip logic genuinely appears three times in
// the C++ source, not a porting duplication).
//
// ============================================================================
// STUBBED: functions owned by the concurrent rogue-SYSTEMS porting unit
// ============================================================================
// - `monster_fire_blaster2` (stalker.cpp:475, `stalker_shoot_attack`'s ranged
//   attack): a full second blaster-bolt PROJECTILE weapon (rogue/g_rogue_monster.cpp:7
//   / rogue/g_rogue_newweap.cpp:1374), out of this unit's scope exactly like
//   m_medic.ts's own identical stub (m_medic.ts:810-812, copied verbatim here
//   with the classname adapted). Reached whenever the stalker fires its
//   ranged attack -- not a narrow corner case.
// - `blocked_checkjump`/`monster_jump_finished` (rogue/g_rogue_newai.cpp:123/101):
//   declared in g_local.h, defined in the rogue AI-systems file this unit
//   does not own. Already-landed precedent (m_berserk.ts:205-210,
//   m_gunner.ts:269, m_infantry.ts:631) stubs these the same way with the
//   same citations -- followed here verbatim (`BlockedJumpResultT` is
//   imported from the real g_local.ts enum rather than re-declared locally,
//   since g_local.ts now has it -- an improvement on the pre-existing local
//   copies, not a deviation from them).
//
// ============================================================================
// OTHER NOTES
// ============================================================================
// - `has_valid_enemy` (declared g_local.h, defined rogue/g_rogue_newai.cpp:1457-1469)
//   is a trivial 3-check body (`enemy && enemy->inuse && enemy->health >= 1`)
//   with every dependency already landed -- ported locally and unexported,
//   matching m_medic.ts's own "port the trivial ones, stub the substantial
//   ones" judgment call (see m_medic.ts header's "THE REINFORCEMENTS
//   FINDING" section for the precedent this follows).
// - `monster_footstep`/`M_CheckGib`/`giTraceline`/`mkframe`/`mkMove`
//   (g_local.h inline helpers, `gi.traceline` placement mismatch): duplicated
//   locally, unexported, matching m_soldier.ts's/m_medic.ts's/g_monster.ts's
//   own precedent verbatim (`giTraceline` copies g_monster.ts:410-412;
//   `mkframe`/`mkMove` copy m_medic.ts:536-549).
// - `skillValue()` (`skill->integer`/`skill->value` workaround, `CvarT` has
//   no cached `.integer`): local unexported copy of m_medic.ts's own
//   `skillValue()` helper (m_medic.ts:592-595).
// - `must()` null-assertion helper for the one nullable monsterinfo
//   function-field call this file makes (`self.monsterinfo.setskin(self)`
//   inside `stalker_heal`) and for narrowing `self.enemy` after
//   `has_valid_enemy` has already confirmed it non-null: same idiom
//   m_medic.ts uses (m_medic.ts:554-557).
// - The C++'s `#if 0`'d `stalker_frames_dodge_run`/`stalker_move_dodge_run`
//   (cpp:714-722) is dropped silently per PORTING.md's "#if 0 blocks are
//   dropped silently" -- verified unreferenced outside that dead block.
// - `PredictAim`/`M_CalculatePitchToFire` (rogue/g_rogue_newai.cpp, exported
//   from m_supertank.ts) and `blocked_checkplat` (m_supertank.ts) are real
//   imports, not stubs -- already landed and exported for exactly this kind
//   of reuse.
// - Grepped the full 1,041-line source for fire_prox/fire_tesla/hint_path:
//   no hits.

import { vec3, type Vec3 } from "../shared/math";
import { AngleVectors, vec3_sub, vec3_length, vec3_add, vec3_muls, vec3_normalized, vectoangles } from "./q_vec3";
import { type CvarT, YAW, ROLL } from "../shared/q_shared";
import {
  MonsterMuzzleflashIdT,
  SoundchanT,
  EffectsT,
  CvarFlagsT,
  ATTN_NORM,
  ATTN_IDLE,
  MASK_PROJECTILE,
  MASK_WATER,
  MASK_SOLID,
  MASK_MONSTERSOLID,
  ContentsT,
  SolidT,
  type KexTraceT,
} from "../kexapi/game";
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
  RegisterMonsterinfoMelee,
  RegisterMonsterinfoSight,
  RegisterMonsterinfoIdle,
  RegisterMonsterinfoSetskin,
  RegisterMonsterinfoBlocked,
  RegisterMonsterinfoDodge,
  RegisterMonsterinfoPhyschanged,
} from "./g_save_registry";
import { type EdictT, MonsterAiFlagsT, MonsterAttackStateT, ModIdT, BlockedJumpResultT, GibTypeT, MovetypeT, random_time } from "./g_local";
import { gi, level, g_edicts } from "./g_main_globals";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { ai_stand, ai_walk, ai_run, ai_move, ai_charge, visible, FoundTarget } from "./g_ai";
import { M_ProjectFlashSource, M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, monster_dead, walkmonster_start } from "./g_monster";
import { ThrowGibs } from "./g_misc";
import { G_FreeEdict } from "./g_utils";
import { fire_hit } from "./g_weapon";
import { st } from "./g_spawn";
import { M_ChangeYaw } from "./m_move";
import { Gtime_add, Gtime_from_ms, Gtime_from_sec, type GTime } from "./gtime";
import { frandom, irandom, crandom } from "./q_std";
import { PredictAim, M_CalculatePitchToFire, blocked_checkplat } from "./m_supertank";
import { blocked_checkjump as RealBlockedCheckjump, monster_jump_finished as RealMonsterJumpFinished } from "./rogue/g_rogue_newai";
import { monster_fire_blaster2 as RealMonsterFireBlaster2 } from "./rogue/g_rogue_monster";

// ---------------------------------------------------------------------------
// m_rogue_stalker.h frame-index enum (104 lines; anonymous enum, declaration
// order = array index, starting at 0) + MODEL_SCALE.
// ---------------------------------------------------------------------------

export const FRAME_idle01 = 0;
export const FRAME_idle02 = 1;
export const FRAME_idle03 = 2;
export const FRAME_idle04 = 3;
export const FRAME_idle05 = 4;
export const FRAME_idle06 = 5;
export const FRAME_idle07 = 6;
export const FRAME_idle08 = 7;
export const FRAME_idle09 = 8;
export const FRAME_idle10 = 9;
export const FRAME_idle11 = 10;
export const FRAME_idle12 = 11;
export const FRAME_idle13 = 12;
export const FRAME_idle14 = 13;
export const FRAME_idle15 = 14;
export const FRAME_idle16 = 15;
export const FRAME_idle17 = 16;
export const FRAME_idle18 = 17;
export const FRAME_idle19 = 18;
export const FRAME_idle20 = 19;
export const FRAME_idle21 = 20;
export const FRAME_idle201 = 21;
export const FRAME_idle202 = 22;
export const FRAME_idle203 = 23;
export const FRAME_idle204 = 24;
export const FRAME_idle205 = 25;
export const FRAME_idle206 = 26;
export const FRAME_idle207 = 27;
export const FRAME_idle208 = 28;
export const FRAME_idle209 = 29;
export const FRAME_idle210 = 30;
export const FRAME_idle211 = 31;
export const FRAME_idle212 = 32;
export const FRAME_idle213 = 33;
export const FRAME_walk01 = 34;
export const FRAME_walk02 = 35;
export const FRAME_walk03 = 36;
export const FRAME_walk04 = 37;
export const FRAME_walk05 = 38;
export const FRAME_walk06 = 39;
export const FRAME_walk07 = 40;
export const FRAME_walk08 = 41;
export const FRAME_jump01 = 42;
export const FRAME_jump02 = 43;
export const FRAME_jump03 = 44;
export const FRAME_jump04 = 45;
export const FRAME_jump05 = 46;
export const FRAME_jump06 = 47;
export const FRAME_jump07 = 48;
export const FRAME_run01 = 49;
export const FRAME_run02 = 50;
export const FRAME_run03 = 51;
export const FRAME_run04 = 52;
export const FRAME_attack01 = 53;
export const FRAME_attack02 = 54;
export const FRAME_attack03 = 55;
export const FRAME_attack04 = 56;
export const FRAME_attack05 = 57;
export const FRAME_attack06 = 58;
export const FRAME_attack07 = 59;
export const FRAME_attack08 = 60;
export const FRAME_attack11 = 61;
export const FRAME_attack12 = 62;
export const FRAME_attack13 = 63;
export const FRAME_attack14 = 64;
export const FRAME_attack15 = 65;
export const FRAME_pain01 = 66;
export const FRAME_pain02 = 67;
export const FRAME_pain03 = 68;
export const FRAME_pain04 = 69;
export const FRAME_death01 = 70;
export const FRAME_death02 = 71;
export const FRAME_death03 = 72;
export const FRAME_death04 = 73;
export const FRAME_death05 = 74;
export const FRAME_death06 = 75;
export const FRAME_death07 = 76;
export const FRAME_death08 = 77;
export const FRAME_death09 = 78;
export const FRAME_twitch01 = 79;
export const FRAME_twitch02 = 80;
export const FRAME_twitch03 = 81;
export const FRAME_twitch04 = 82;
export const FRAME_twitch05 = 83;
export const FRAME_twitch06 = 84;
export const FRAME_twitch07 = 85;
export const FRAME_twitch08 = 86;
export const FRAME_twitch09 = 87;
export const FRAME_twitch10 = 88;
export const FRAME_reactive01 = 89;
export const FRAME_reactive02 = 90;
export const FRAME_reactive03 = 91;
export const FRAME_reactive04 = 92;

export const MODEL_SCALE = 1.0;

// ---------------------------------------------------------------------------
// mkframe/mkMove/giTraceline -- local builders, matching m_medic.ts:536-549 /
// g_monster.ts:410-412 verbatim (see file header).
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

function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

// ---------------------------------------------------------------------------
// Trivial g_local.h inlines, duplicated locally (see file header).
// ---------------------------------------------------------------------------

/** g_local.h:3281-3286 `inline void monster_footstep(edict_t *self)`. */
function monster_footstep(self: EdictT): void {
  if (self.groundentity !== null) self.s.event = 2 /* EV_OTHER_FOOTSTEP */;
}

/** g_local.h:3521-3529 `inline bool M_CheckGib(edict_t *self, const mod_t &mod)`. */
function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

/** rogue/g_rogue_newai.cpp:1457-1469. Trivial, all deps already landed --
 *  ported for real, matching m_medic.ts's "port the trivial ones" judgment. */
function has_valid_enemy(self: EdictT): boolean {
  if (self.enemy === null) return false;
  if (!self.enemy.inuse) return false;
  if (self.enemy.health < 1) return false;
  return true;
}

/** m_medic.ts:592-595 verbatim (`skill->value`, `CvarT` has no cached `.integer`). */
function skillValue(): number {
  const c: CvarT | null = gi.cvar("skill", "1", CvarFlagsT.CVAR_LATCH);
  return c === null ? 1 : c.value;
}

/** m_medic.ts:554-557 verbatim. */
function must<T>(fn: T | null, name: string, self: EdictT): T {
  if (fn === null) throw new Error(`m_rogue_stalker: ${name} is null for ${self.classname ?? "?"}`);
  return fn;
}

// ---------------------------------------------------------------------------
// blocked_checkjump/monster_jump_finished/monster_fire_blaster2: formerly
// local throwing stubs here ("owned by the concurrent rogue-SYSTEMS
// porting unit") -- rogue/g_rogue_newai.ts and rogue/g_rogue_monster.ts
// have since landed with real, exported versions of all three; swapped
// for delegating imports (2026-08-30 stale-comment sweep).
// ---------------------------------------------------------------------------

function blocked_checkjump(self: EdictT, dist: number): BlockedJumpResultT {
  return RealBlockedCheckjump(self, dist);
}

function monster_jump_finished(self: EdictT): boolean {
  return RealMonsterJumpFinished(self);
}

function monster_fire_blaster2(self: EdictT, start: Vec3, dir: Vec3, damage: number, speed: number, flashtype: MonsterMuzzleflashIdT, effect: EffectsT): void {
  RealMonsterFireBlaster2(self, start, dir, damage, speed, flashtype, effect);
}

// ---------------------------------------------------------------------------
// STALKER_ON_CEILING (cpp:32-36). Exported: the test suite checks this
// directly for the ceiling-flip finding.
// ---------------------------------------------------------------------------

export function STALKER_ON_CEILING(ent: EdictT): boolean {
  return ent.gravityVector[2] > 0;
}

// ---------------------------------------------------------------------------
// stalker_ok_to_transition (cpp:38-133).
// ---------------------------------------------------------------------------

function stalker_ok_to_transition(self: EdictT): boolean {
  let max_dist: number;
  let margin: number;

  if (STALKER_ON_CEILING(self)) {
    // [Paril-KEX] if we get knocked off the ceiling, always fall downwards
    if (self.groundentity === null) return true;

    max_dist = -384;
    margin = self.mins[2] - 8;
  } else {
    // her stalkers are just better
    if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_SPAWNED_WIDOW) !== 0n) max_dist = 256;
    else max_dist = 180;
    margin = self.maxs[2] + 8;
  }

  const pt = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2] + max_dist);
  let trace = gi.trace(self.s.origin, self.mins, self.maxs, pt, self, MASK_MONSTERSOLID);
  const traceEnt = () => (trace.ent !== null ? g_edicts[trace.ent.s.number] : null);

  if (trace.fraction === 1.0 || (trace.contents & ContentsT.CONTENTS_SOLID) === 0 || traceEnt() !== g_edicts[0]) {
    if (STALKER_ON_CEILING(self)) {
      if (trace.plane.normal[2] < 0.9) return false;
    } else {
      if (trace.plane.normal[2] > -0.9) return false;
    }
  }

  const end_height = trace.endpos[2];

  // check the four corners, tracing only to the endpoint of the center trace (vertically).
  const corners: [number, number][] = [
    [self.absmin[0], self.absmin[1]],
    [self.absmax[0], self.absmin[1]],
    [self.absmax[0], self.absmax[1]],
    [self.absmin[0], self.absmax[1]],
  ];

  for (const [x, y] of corners) {
    const pt2 = vec3(x, y, trace.endpos[2] + margin); // give a little margin of error to allow slight inclines
    const start2 = vec3(x, y, self.s.origin[2]);
    trace = giTraceline(start2, pt2, self, MASK_MONSTERSOLID);
    if (trace.fraction === 1.0 || (trace.contents & ContentsT.CONTENTS_SOLID) === 0 || traceEnt() !== g_edicts[0]) return false;
    if (Math.abs(end_height + margin - trace.endpos[2]) > 8) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// SIGHT
// ---------------------------------------------------------------------------

let sound_pain = 0;
let sound_die = 0;
let sound_sight = 0;
let sound_punch_hit1 = 0;
let sound_punch_hit2 = 0;
let sound_idle = 0;

export function stalker_sight(self: EdictT, _other: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_sight, 1, ATTN_NORM, 0);
}
RegisterMonsterinfoSight("stalker_sight", stalker_sight);

// ---------------------------------------------------------------------------
// IDLE
// ---------------------------------------------------------------------------

function stalker_idle_noise(self: EdictT): void {
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_idle, 0.5, ATTN_IDLE, 0);
}

const stalker_frames_idle: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, stalker_idle_noise),
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
export const stalker_move_idle = RegisterMmove("stalker_move_idle", mkMove(FRAME_idle01, FRAME_idle21, stalker_frames_idle, stalker_stand));

const stalker_frames_idle2: MframeT[] = [
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
export const stalker_move_idle2 = RegisterMmove("stalker_move_idle2", mkMove(FRAME_idle201, FRAME_idle213, stalker_frames_idle2, stalker_stand));

export function stalker_idle(self: EdictT): void {
  if (frandom() < 0.35) M_SetAnimation(self, stalker_move_idle, true);
  else M_SetAnimation(self, stalker_move_idle2, true);
}
RegisterMonsterinfoIdle("stalker_idle", stalker_idle);

// ---------------------------------------------------------------------------
// STAND
// ---------------------------------------------------------------------------

const stalker_frames_stand: MframeT[] = [
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand),
  mkframe(ai_stand, 0, stalker_idle_noise),
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
export const stalker_move_stand = RegisterMmove("stalker_move_stand", mkMove(FRAME_idle01, FRAME_idle21, stalker_frames_stand, stalker_stand));

export function stalker_stand(self: EdictT): void {
  if (frandom() < 0.25) M_SetAnimation(self, stalker_move_stand, true);
  else M_SetAnimation(self, stalker_move_idle2, true);
}
RegisterMonsterinfoStand("stalker_stand", stalker_stand);

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------

const stalker_frames_run: MframeT[] = [mkframe(ai_run, 13, monster_footstep), mkframe(ai_run, 17), mkframe(ai_run, 21, monster_footstep), mkframe(ai_run, 18)];
export const stalker_move_run = RegisterMmove("stalker_move_run", mkMove(FRAME_run01, FRAME_run04, stalker_frames_run, null));

export function stalker_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, stalker_move_stand, true);
  else M_SetAnimation(self, stalker_move_run, true);
}
RegisterMonsterinfoRun("stalker_run", stalker_run);

// ---------------------------------------------------------------------------
// WALK
// ---------------------------------------------------------------------------

const stalker_frames_walk: MframeT[] = [
  mkframe(ai_walk, 4, monster_footstep),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 5),
  mkframe(ai_walk, 4, monster_footstep),
  mkframe(ai_walk, 6),
  mkframe(ai_walk, 8),
  mkframe(ai_walk, 4),
];
export const stalker_move_walk = RegisterMmove("stalker_move_walk", mkMove(FRAME_walk01, FRAME_walk08, stalker_frames_walk, stalker_walk));

export function stalker_walk(self: EdictT): void {
  M_SetAnimation(self, stalker_move_walk, true);
}
RegisterMonsterinfoWalk("stalker_walk", stalker_walk);

// ---------------------------------------------------------------------------
// FALSE DEATH
// ---------------------------------------------------------------------------

const stalker_frames_reactivate: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move, 0, monster_footstep)];
export const stalker_move_false_death_end = RegisterMmove("stalker_move_false_death_end", mkMove(FRAME_reactive01, FRAME_reactive04, stalker_frames_reactivate, stalker_run));

function stalker_reactivate(self: EdictT): void {
  self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_STAND_GROUND;
  M_SetAnimation(self, stalker_move_false_death_end, true);
}

function stalker_heal(self: EdictT): void {
  const sk = Math.trunc(skillValue());
  if (sk === 2) self.health += 2;
  else if (sk === 3) self.health += 3;
  else self.health++;

  must(self.monsterinfo.setskin, "monsterinfo.setskin", self)(self);

  if (self.health >= self.max_health) {
    self.health = self.max_health;
    stalker_reactivate(self);
  }
}

const stalker_frames_false_death: MframeT[] = [
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
  mkframe(ai_move, 0, stalker_heal),
];
export const stalker_move_false_death = RegisterMmove("stalker_move_false_death", mkMove(FRAME_twitch01, FRAME_twitch10, stalker_frames_false_death, stalker_false_death));

function stalker_false_death(self: EdictT): void {
  M_SetAnimation(self, stalker_move_false_death, true);
}

const stalker_frames_false_death_start: MframeT[] = [
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
export const stalker_move_false_death_start = RegisterMmove("stalker_move_false_death_start", mkMove(FRAME_death01, FRAME_death09, stalker_frames_false_death_start, stalker_false_death));

function stalker_false_death_start(self: EdictT): void {
  self.s.angles[ROLL] = 0;
  self.gravityVector = vec3(0, 0, -1);

  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
  M_SetAnimation(self, stalker_move_false_death_start, true);
}

// ---------------------------------------------------------------------------
// PAIN
// ---------------------------------------------------------------------------

const stalker_frames_pain: MframeT[] = [mkframe(ai_move), mkframe(ai_move), mkframe(ai_move), mkframe(ai_move)];
export const stalker_move_pain = RegisterMmove("stalker_move_pain", mkMove(FRAME_pain01, FRAME_pain04, stalker_frames_pain, stalker_run));

export function stalker_pain(self: EdictT, _other: EdictT, _kick: number, damage: number, mod: ModT): void {
  if (self.deadflag) return;
  if (self.groundentity === null) return;

  // if we're reactivating or false dying, ignore the pain.
  if (self.monsterinfo.active_move === stalker_move_false_death_end || self.monsterinfo.active_move === stalker_move_false_death_start) return;

  if (self.monsterinfo.active_move === stalker_move_false_death) {
    stalker_reactivate(self);
    return;
  }

  if (self.health > 0 && self.health < self.max_health / 4) {
    if (frandom() < 0.3) {
      if (!STALKER_ON_CEILING(self) || stalker_ok_to_transition(self)) {
        stalker_false_death_start(self);
        return;
      }
    }
  }

  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  gi.sound(self, SoundchanT.CHAN_VOICE, sound_pain, 1, ATTN_NORM, 0);

  if (mod.id === ModIdT.MOD_CHAINFIST || damage > 10) {
    // stalker should dodge jump periodically to help avoid damage.
    if (self.groundentity !== null && frandom() < 0.5) stalker_dodge_jump(self);
    else if (M_ShouldReactToPain(self, mod)) M_SetAnimation(self, stalker_move_pain, true); // no pain anims in nightmare
  }
}
RegisterPain("stalker_pain", stalker_pain);

export function stalker_setskin(self: EdictT): void {
  self.s.skinnum = self.health < self.max_health / 2 ? 1 : 0;
}
RegisterMonsterinfoSetskin("stalker_setskin", stalker_setskin);

// ---------------------------------------------------------------------------
// STALKER ATTACK (ranged)
// ---------------------------------------------------------------------------

function stalker_shoot_attack(self: EdictT): void {
  if (!has_valid_enemy(self)) return;
  const enemy = must(self.enemy, "enemy", self);

  if (self.groundentity !== null && frandom() < 0.33) {
    const toEnemy = vec3_sub(enemy.s.origin, self.s.origin);
    const dist = vec3_length(toEnemy);

    if (dist > 256 || frandom() < 0.5) stalker_do_pounce(self, enemy.s.origin);
    else stalker_jump_straightup(self);
  }

  const f = vec3();
  const r = vec3();
  AngleVectors(self.s.angles, f, r, null);
  const offset = vec3(24, 0, 6);
  const start = M_ProjectFlashSource(self, offset, f, r);

  let dir = vec3_sub(enemy.s.origin, start);
  let end: Vec3;
  if (frandom() < 0.3) {
    const aimdir = vec3();
    const aimpoint = vec3();
    PredictAim(self, enemy, start, 1000, true, 0, aimdir, aimpoint);
    dir = aimdir;
    end = aimpoint;
  } else {
    end = vec3(enemy.s.origin[0], enemy.s.origin[1], enemy.s.origin[2]);
  }

  const trace = giTraceline(start, end, self, MASK_PROJECTILE);
  const traceEnt = trace.ent !== null ? g_edicts[trace.ent.s.number] : null;
  if (traceEnt === enemy || traceEnt === g_edicts[0]) {
    const ndir = vec3_normalized(dir);
    monster_fire_blaster2(self, start, ndir, 5, 800, MonsterMuzzleflashIdT.MZ2_STALKER_BLASTER, EffectsT.EF_BLASTER);
  }
}

function stalker_shoot_attack2(self: EdictT): void {
  if (frandom() < 0.5) stalker_shoot_attack(self);
}

const stalker_frames_shoot: MframeT[] = [mkframe(ai_charge, 13), mkframe(ai_charge, 17, stalker_shoot_attack), mkframe(ai_charge, 21), mkframe(ai_charge, 18, stalker_shoot_attack2)];
export const stalker_move_shoot = RegisterMmove("stalker_move_shoot", mkMove(FRAME_run01, FRAME_run04, stalker_frames_shoot, stalker_run));

export function stalker_attack_ranged(self: EdictT): void {
  if (!has_valid_enemy(self)) return;

  // PMM - circle strafe stuff
  if (frandom() > 0.5) {
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_STRAIGHT;
  } else {
    if (frandom() <= 0.5) self.monsterinfo.lefty = !self.monsterinfo.lefty; // switch directions
    self.monsterinfo.attack_state = MonsterAttackStateT.AS_SLIDING;
  }
  M_SetAnimation(self, stalker_move_shoot, true);
}
RegisterMonsterinfoAttack("stalker_attack_ranged", stalker_attack_ranged);

// ---------------------------------------------------------------------------
// CLOSE COMBAT
// ---------------------------------------------------------------------------

const MELEE_DISTANCE = 50;

function stalker_swing_attack(self: EdictT): void {
  const aim = vec3(MELEE_DISTANCE, 0, 0);
  if (fire_hit(self, aim, irandom(5, 10), 50)) {
    if (self.s.frame < FRAME_attack08) gi.sound(self, SoundchanT.CHAN_WEAPON, sound_punch_hit2, 1, ATTN_NORM, 0);
    else gi.sound(self, SoundchanT.CHAN_WEAPON, sound_punch_hit1, 1, ATTN_NORM, 0);
  } else {
    self.monsterinfo.melee_debounce_time = Gtime_add(level.time, Gtime_from_ms(800));
  }
}

const stalker_frames_swing_l: MframeT[] = [
  mkframe(ai_charge, 2),
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 6),
  mkframe(ai_charge, 10, monster_footstep),
  mkframe(ai_charge, 5, stalker_swing_attack),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5),
  mkframe(ai_charge, 5, monster_footstep), // stalker_swing_check_l
];
export const stalker_move_swing_l = RegisterMmove("stalker_move_swing_l", mkMove(FRAME_attack01, FRAME_attack08, stalker_frames_swing_l, stalker_run));

const stalker_frames_swing_r: MframeT[] = [
  mkframe(ai_charge, 4),
  mkframe(ai_charge, 6, monster_footstep),
  mkframe(ai_charge, 6, stalker_swing_attack),
  mkframe(ai_charge, 10),
  mkframe(ai_charge, 5, monster_footstep), // stalker_swing_check_r
];
export const stalker_move_swing_r = RegisterMmove("stalker_move_swing_r", mkMove(FRAME_attack11, FRAME_attack15, stalker_frames_swing_r, stalker_run));

export function stalker_attack_melee(self: EdictT): void {
  if (!has_valid_enemy(self)) return;
  if (frandom() < 0.5) M_SetAnimation(self, stalker_move_swing_l, true);
  else M_SetAnimation(self, stalker_move_swing_r, true);
}
RegisterMonsterinfoMelee("stalker_attack_melee", stalker_attack_melee);

// ---------------------------------------------------------------------------
// POUNCE
// ---------------------------------------------------------------------------

function stalker_check_lz(_self: EdictT, target: EdictT, dest: Vec3): boolean {
  if ((gi.pointcontents(dest) & MASK_WATER) !== 0 || target.waterlevel !== 0) return false;
  if (target.groundentity === null) return false;

  // check under the target's four corners; if any is not solid, bail.
  const corners: [number, number][] = [
    [target.mins[0], target.mins[1]],
    [target.maxs[0], target.mins[1]],
    [target.maxs[0], target.maxs[1]],
    [target.mins[0], target.maxs[1]],
  ];

  for (const [x, y] of corners) {
    const jumpLZ = vec3(x, y, target.mins[2] - 0.25);
    if ((gi.pointcontents(jumpLZ) & MASK_SOLID) === 0) return false;
  }

  return true;
}

function stalker_do_pounce(self: EdictT, dest: Vec3): boolean {
  let velocity = 400.1;

  // don't pounce when we're on the ceiling
  if (STALKER_ON_CEILING(self)) return false;

  const enemy = must(self.enemy, "enemy", self);
  if (!stalker_check_lz(self, enemy, dest)) return false;

  const dist = vec3_sub(dest, self.s.origin);

  // make sure we're pointing in that direction, 15deg margin of error.
  const jumpAngles = vectoangles(dist);
  if (Math.abs(jumpAngles[YAW] - self.s.angles[YAW]) > 45) return false; // not facing the player...
  if (Number.isNaN(jumpAngles[YAW])) return false; // Switch why

  self.ideal_yaw = jumpAngles[YAW];
  M_ChangeYaw(self);

  const length = vec3_length(dist);
  if (length > 450) return false; // can't jump that far...

  const jumpLZ = vec3(dest[0], dest[1], dest[2]);
  const dir = vec3_normalized(dist);

  // find a valid angle/velocity combination
  while (velocity <= 800) {
    if (M_CalculatePitchToFire(self, jumpLZ, self.s.origin, dir, velocity, 3, false, true)) break;
    velocity += 200;
  }

  // nothing found
  if (velocity > 800) return false;

  self.velocity = vec3_muls(dir, velocity);
  return true;
}

// ---------------------------------------------------------------------------
// DODGE
// ---------------------------------------------------------------------------

function stalker_jump_straightup(self: EdictT): void {
  if (self.deadflag) return;

  if (STALKER_ON_CEILING(self)) {
    if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = -1;
      self.s.angles[ROLL] += 180.0;
      if (self.s.angles[ROLL] > 360.0) self.s.angles[ROLL] -= 360.0;
      self.groundentity = null;
    }
  } else if (self.groundentity !== null) {
    // make sure we're standing on SOMETHING...
    self.velocity[0] += crandom() * 5;
    self.velocity[1] += crandom() * 5;
    self.velocity[2] += -400 * self.gravityVector[2];
    if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = 1;
      self.s.angles[ROLL] = 180.0;
      self.groundentity = null;
    }
  }
}

const stalker_frames_jump_straightup: MframeT[] = [
  mkframe(ai_move, 1, stalker_jump_straightup),
  mkframe(ai_move, 1, stalker_jump_wait_land),
  mkframe(ai_move, -1, monster_footstep),
  mkframe(ai_move, -1),
];
export const stalker_move_jump_straightup = RegisterMmove("stalker_move_jump_straightup", mkMove(FRAME_jump04, FRAME_jump07, stalker_frames_jump_straightup, stalker_run));

/** abstraction so pain function can trigger a dodge jump too without faking
 *  the inputs to stalker_dodge. */
function stalker_dodge_jump(self: EdictT): void {
  M_SetAnimation(self, stalker_move_jump_straightup, true);
}

export function stalker_dodge(self: EdictT, attacker: EdictT, eta: GTime, _tr: KexTraceT | null, _gravity: boolean): void {
  if (self.groundentity === null || self.health <= 0) return;

  if (self.enemy === null) {
    self.enemy = attacker;
    FoundTarget(self);
    return;
  }

  // PMM - don't bother if it's going to hit anyway; fix for weird in-your-face etas
  if (eta < Gtime_from_ms(100) || eta > Gtime_from_sec(5)) return;

  if (self.timestamp > level.time) return;

  self.timestamp = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(5)));
  // this will override the foundtarget call of stalker_run
  stalker_dodge_jump(self);
}
RegisterMonsterinfoDodge("stalker_dodge", stalker_dodge);

// ---------------------------------------------------------------------------
// JUMP ONTO / OFF OF THINGS
// ---------------------------------------------------------------------------

function stalker_jump_down(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 100));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 300));
}

function stalker_jump_up(self: EdictT): void {
  const forward = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, null, up);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 200));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 450));
}

function stalker_jump_wait_land(self: EdictT): void {
  if (frandom() < 0.4 && level.time >= self.monsterinfo.attack_finished) {
    self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_ms(300));
    stalker_shoot_attack(self);
  }

  if (self.groundentity === null) {
    self.gravity = 1.3;
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) {
      self.gravity = 1;
      self.monsterinfo.nextframe = self.s.frame + 1;
    }
  } else {
    self.gravity = 1;
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

const stalker_frames_jump_up: MframeT[] = [
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),
  mkframe(ai_move, -8),
  mkframe(ai_move, 0, stalker_jump_up),
  mkframe(ai_move, 0, stalker_jump_wait_land),
  mkframe(ai_move, 0, monster_footstep),
];
export const stalker_move_jump_up = RegisterMmove("stalker_move_jump_up", mkMove(FRAME_jump01, FRAME_jump07, stalker_frames_jump_up, stalker_run));

const stalker_frames_jump_down: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move),
  mkframe(ai_move, 0, stalker_jump_down),
  mkframe(ai_move, 0, stalker_jump_wait_land),
  mkframe(ai_move, 0, monster_footstep),
];
export const stalker_move_jump_down = RegisterMmove("stalker_move_jump_down", mkMove(FRAME_jump01, FRAME_jump07, stalker_frames_jump_down, stalker_run));

/** this is only used for jumping onto or off of things. for dodge jumping,
 *  use stalker_dodge_jump. */
function stalker_jump(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;

  if (result === BlockedJumpResultT.JUMP_JUMP_UP) M_SetAnimation(self, stalker_move_jump_up, true);
  else M_SetAnimation(self, stalker_move_jump_down, true);
}

// ---------------------------------------------------------------------------
// BLOCKED
// ---------------------------------------------------------------------------

export function stalker_blocked(self: EdictT, dist: number): boolean {
  if (!has_valid_enemy(self)) return false;
  const enemy = must(self.enemy, "enemy", self);

  const onCeiling = STALKER_ON_CEILING(self);

  if (!onCeiling) {
    const result = blocked_checkjump(self, dist);
    if (result !== BlockedJumpResultT.NO_JUMP) {
      if (result !== BlockedJumpResultT.JUMP_TURN) stalker_jump(self, result);
      return true;
    }

    if (blocked_checkplat(self, dist)) return true;

    if (visible(self, enemy) && frandom() < 0.1) {
      stalker_do_pounce(self, enemy.s.origin);
      return true;
    }
  } else {
    if (stalker_ok_to_transition(self)) {
      self.gravityVector[2] = -1;
      self.s.angles[ROLL] += 180.0;
      if (self.s.angles[ROLL] > 360.0) self.s.angles[ROLL] -= 360.0;
      self.groundentity = null;
      return true;
    }
  }

  return false;
}
RegisterMonsterinfoBlocked("stalker_blocked", stalker_blocked);

// ---------------------------------------------------------------------------
// PHYSICS_CHANGE -- see file header "THE CEILING-WALK PHYSICS".
// ---------------------------------------------------------------------------

export function stalker_physics_change(self: EdictT): void {
  if (STALKER_ON_CEILING(self) && self.groundentity === null) {
    self.gravityVector[2] = -1;
    self.s.angles[ROLL] += 180.0;
    if (self.s.angles[ROLL] > 360.0) self.s.angles[ROLL] -= 360.0;
  }
}
RegisterMonsterinfoPhyschanged("stalker_physics_change", stalker_physics_change);

// ---------------------------------------------------------------------------
// DEATH
// ---------------------------------------------------------------------------

function stalker_dead(self: EdictT): void {
  self.mins = vec3(-28, -28, -18);
  self.maxs = vec3(28, 28, -4);
  monster_dead(self);
}

const stalker_frames_death: MframeT[] = [
  mkframe(ai_move),
  mkframe(ai_move, -5),
  mkframe(ai_move, -10),
  mkframe(ai_move, -20),
  mkframe(ai_move, -10),
  mkframe(ai_move, -10),
  mkframe(ai_move, -5),
  mkframe(ai_move, -5),
  mkframe(ai_move, 0, monster_footstep),
];
export const stalker_move_death = RegisterMmove("stalker_move_death", mkMove(FRAME_death01, FRAME_death09, stalker_frames_death, stalker_dead));

export function stalker_die(self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void {
  // dude bit it, make him fall!
  self.movetype = MovetypeT.MOVETYPE_TOSS;
  self.s.angles[ROLL] = 0;
  self.gravityVector = vec3(0, 0, -1);

  // check for gib
  if (M_CheckGib(self, mod)) {
    gi.sound(self, SoundchanT.CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

    self.s.skinnum = Math.trunc(self.s.skinnum / 2);

    ThrowGibs(self, damage, [
      { count: 2, gibname: "models/objects/gibs/sm_meat/tris.md2" },
      { count: 2, gibname: "models/objects/gibs/sm_metal/tris.md2", type: GibTypeT.GIB_METALLIC },
      { gibname: "models/monsters/stalker/gibs/bodya.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/stalker/gibs/bodyb.md2", type: GibTypeT.GIB_SKINNED },
      { count: 2, gibname: "models/monsters/stalker/gibs/claw.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { count: 2, gibname: "models/monsters/stalker/gibs/leg.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
      { count: 2, gibname: "models/monsters/stalker/gibs/foot.md2", type: GibTypeT.GIB_SKINNED },
      { gibname: "models/monsters/stalker/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
    ]);
    self.deadflag = true;
    return;
  }

  if (self.deadflag) return;

  // regular death
  gi.sound(self, SoundchanT.CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
  self.deadflag = true;
  self.takedamage = true;
  M_SetAnimation(self, stalker_move_death, true);
}
RegisterDie("stalker_die", stalker_die);

// ---------------------------------------------------------------------------
// SPAWN
// ---------------------------------------------------------------------------

/*QUAKED monster_stalker (1 .5 0) (-28 -28 -18) (28 28 18) Ambush Trigger_Spawn Sight OnRoof NoJumping
Spider Monster

  ONROOF - Monster starts sticking to the roof.
*/

const SPAWNFLAG_STALKER_ONROOF: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_STALKER_NOJUMPING: SpawnFlags = SpawnFlags_from(16);

export function SP_monster_stalker(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_pain = gi.soundindex("stalker/pain.wav");
  sound_die = gi.soundindex("stalker/death.wav");
  sound_sight = gi.soundindex("stalker/sight.wav");
  sound_punch_hit1 = gi.soundindex("stalker/melee1.wav");
  sound_punch_hit2 = gi.soundindex("stalker/melee2.wav");
  sound_idle = gi.soundindex("stalker/idle.wav");

  // PMM - precache bolt2
  gi.modelindex("models/objects/laser/tris.md2");

  self.s.modelindex = gi.modelindex("models/monsters/stalker/tris.md2");

  gi.modelindex("models/monsters/stalker/gibs/bodya.md2");
  gi.modelindex("models/monsters/stalker/gibs/bodyb.md2");
  gi.modelindex("models/monsters/stalker/gibs/claw.md2");
  gi.modelindex("models/monsters/stalker/gibs/foot.md2");
  gi.modelindex("models/monsters/stalker/gibs/head.md2");
  gi.modelindex("models/monsters/stalker/gibs/leg.md2");

  self.mins = vec3(-28, -28, -18);
  self.maxs = vec3(28, 28, 18);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = Math.trunc(250 * st.health_multiplier);
  self.gib_health = -50;
  self.mass = 250;

  self.pain = stalker_pain;
  self.die = stalker_die;

  self.monsterinfo.stand = stalker_stand;
  self.monsterinfo.walk = stalker_walk;
  self.monsterinfo.run = stalker_run;
  self.monsterinfo.attack = stalker_attack_ranged;
  self.monsterinfo.sight = stalker_sight;
  self.monsterinfo.idle = stalker_idle;
  self.monsterinfo.dodge = stalker_dodge;
  self.monsterinfo.blocked = stalker_blocked;
  self.monsterinfo.melee = stalker_attack_melee;
  self.monsterinfo.setskin = stalker_setskin;
  self.monsterinfo.physics_change = stalker_physics_change;

  gi.linkentity(self);

  M_SetAnimation(self, stalker_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_STALKER_ONROOF)) {
    self.s.angles[ROLL] = 180;
    self.gravityVector[2] = 1;
  }

  self.monsterinfo.can_jump = !SpawnFlags_has(self.spawnflags, SPAWNFLAG_STALKER_NOJUMPING);
  self.monsterinfo.drop_height = 256;
  self.monsterinfo.jump_height = 68;

  walkmonster_start(self);
}
