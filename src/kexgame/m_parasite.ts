// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_parasite.cpp / m_parasite.h -- PARASITE (2023 Quake II re-release /
// "KEX" engine). Ported from ~/Projects/quake2-rerelease-dll/rerelease/
// m_parasite.cpp (965 lines, C++17) and m_parasite.h (139 lines, 126-entry
// frame enum -- generated mechanically from the header). Behavioral code,
// ported bug-for-bug per PORTING.md.
//
// ============================================================================
// FORWARD-REFERENCED HANDLERS (see m_chick.ts's identical pattern)
// ============================================================================
// The C++ source forward-declares SEVEN functions at its top
// (parasite_stand, parasite_start_run, parasite_run, parasite_walk,
// parasite_end_fidget, parasite_do_fidget, parasite_refidget) for the same
// reason m_chick.ts's five were: their mmove_t/mframe_t tables reference
// them before their own C++ definitions. All seven are ported as plain
// hoisted `function` declarations (order-independent in TS/JS regardless of
// textual position); `parasite_stand` (MONSTERINFO_STAND) and
// `parasite_start_run` (MONSTERINFO_RUN) additionally get a separate
// `_registered` RegisterMonsterinfoStand/Run binding used only for the
// `self.monsterinfo.stand`/`.run` assignments in SP_monster_parasite -- same
// underlying logic, real save-name, no ordering hazard. The other five
// (parasite_run, parasite_walk, parasite_end_fidget, parasite_do_fidget,
// parasite_refidget) are pure mmove_t endfunc targets, never assigned to a
// monsterinfo field, so per g_local_types.ts's "frame-function fields are
// plain" rule they need no RegisterX wrapper at all.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (throwing stub, cited) -- matches
// this porting round's sibling convention (see m_mutant.ts's identical
// citation)
// ============================================================================
// `blocked_jump_result_t blocked_checkjump(edict_t*, float)`
// (rogue/g_rogue_newai.cpp:123-~230+) is a large, generic, non-monster-
// specific nav-path subsystem; local throwing stub, cited, matching
// m_mutant.ts/m_berserk.ts/m_gunner.ts/m_infantry.ts's own identical
// ruling. `parasite_blocked` calls it as its primary branch and falls back
// to `blocked_checkplat` (imported for real from m_supertank.ts) if it
// returns NO_JUMP -- an honest gap, matching m_mutant.ts's.
// `parasite_jump_up`/`parasite_jump_down`/`parasite_jump_wait_land`/
// `parasite_move_jump_up`/`parasite_move_jump_down`/`parasite_jump` (the
// ROGUE jump-up/down tables `blocked_checkjump` would dispatch to) are still
// ported for real below -- only unreachable via the stubbed path today, per
// m_mutant.ts's/m_gunner.ts's precedent.
// `monster_jump_finished` (rogue/g_rogue_newai.cpp:101) IS ported for real
// here (small, self-contained, no nav_path dependency), matching
// m_mutant.ts's own choice -- `parasite_jump_wait_land` uses its return
// value directly.
// `PredictAim`/`blocked_checkplat`: imported for real from m_supertank.ts,
// this task's own canonical body (in scope, unlike the rogue functions
// above).
//
// ============================================================================
// KEX-only content vs. the legacy (vanilla Q2) src/game/m_parasite.ts port
// ============================================================================
// - The ENTIRE proboscis "drain" attack (fire_proboscis, proboscis_touch,
//   proboscis_think, proboscis_reset, proboscis_die, proboscis_segment_draw,
//   parasite_get_proboscis_start, parasite_charge_proboscis, the
//   parasite_break_offsets/parasite_drain_offsets per-frame projection
//   tables, and the entire parasite_move_break/parasite_move_fire_proboscis
//   frame tables) is a full [Paril-KEX] rewrite. Vanilla Q2's parasite fires
//   a single instant-hit "sting" that does one lump of damage and heals the
//   parasite once; KEX's version spawns two real sub-entities (a `tip`
//   projectile that flies out, sticks to whatever it hits, and a `segment`
//   beam entity that visually connects the parasite's mouth to the tip via
//   `postthink`/`RF_BEAM`), then either explodes into a multi-frame "break"
//   animation (hit a wall) or locks onto the target and drains 2 HP/10Hz
//   tick from the victim into the parasite (capped at max_health) until the
//   target dies, moves out of reach, or the parasite is interrupted, at
//   which point the tip retracts (2x speed) back into the parasite's mouth.
// - `g_athena_parasite_miss_chance` (0.1) / `g_athena_parasite_proboscis_
//   speed` (1250) / `g_athena_parasite_proboscis_retract_modifier` (2.0) are
//   new KEX-only tuning constants (the "athena" prefix is this KEX
//   rerelease's internal codename artifact, preserved verbatim).
// - `monsterinfo.can_jump`/`drop_height`/`jump_height` (256/68) and the
//   entire ROGUE jump-up/jump-down blocked-response kit are new; vanilla
//   parasite never jumps.
// - `parasite_blocked` (blocked_checkplat/blocked_checkjump) is new; vanilla
//   has no blocked callback.
// - `#if 0`-guarded `parasite_frames_stop_run`/`parasite_frames_stop_walk`/
//   `parasite_search` are dropped per PORTING.md's "#if 0 blocks are dropped
//   silently."

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, CHAN_WEAPON, CHAN_AUTO, ATTN_NORM, RF_BEAM } from "../shared/q_shared";
import { SvflagsT, SolidT, ContentsT, MASK_PROJECTILE, MASK_SOLID, type KexTraceT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  type PrethinkFn,
  type TouchFn,
  type DieFn,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  MovetypeT,
  ModIdT,
  GibTypeT,
  EntFlagsT,
  BlockedJumpResultT,
  DamageflagsT,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_from_hz } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "./spawnflags";
import { frandom, crandom_open, brandom, YAW } from "./q_std";
import { vec3_add, vec3_sub, vec3_muls, vec3_dot, vec3_normalize, vec3_normalized, AngleVectors, AngleVectors_destructured, vectoangles } from "./q_vec3";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { st } from "./g_spawn";
import { ai_stand, ai_run, ai_walk, ai_charge, ai_move } from "./g_ai";
import { M_SetAnimation, M_AllowSpawn, M_ShouldReactToPain, M_ProjectFlashSource, M_CheckClearShot, monster_dead, walkmonster_start } from "./g_monster";
import { T_Damage } from "./g_combat";
import { ThrowGibs, type GibDefT } from "./g_misc";
import { PredictAim, blocked_checkplat } from "./m_supertank";
import { blocked_checkjump } from "./rogue/g_rogue_newai";
import {
  RegisterThink,
  RegisterDie,
  RegisterPain,
  RegisterTouch,
  RegisterPrethink,
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
// m_parasite.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_break01 = 0;
export const FRAME_break02 = 1;
export const FRAME_break03 = 2;
export const FRAME_break04 = 3;
export const FRAME_break05 = 4;
export const FRAME_break06 = 5;
export const FRAME_break07 = 6;
export const FRAME_break08 = 7;
export const FRAME_break09 = 8;
export const FRAME_break10 = 9;
export const FRAME_break11 = 10;
export const FRAME_break12 = 11;
export const FRAME_break13 = 12;
export const FRAME_break14 = 13;
export const FRAME_break15 = 14;
export const FRAME_break16 = 15;
export const FRAME_break17 = 16;
export const FRAME_break18 = 17;
export const FRAME_break19 = 18;
export const FRAME_break20 = 19;
export const FRAME_break21 = 20;
export const FRAME_break22 = 21;
export const FRAME_break23 = 22;
export const FRAME_break24 = 23;
export const FRAME_break25 = 24;
export const FRAME_break26 = 25;
export const FRAME_break27 = 26;
export const FRAME_break28 = 27;
export const FRAME_break29 = 28;
export const FRAME_break30 = 29;
export const FRAME_break31 = 30;
export const FRAME_break32 = 31;
export const FRAME_death101 = 32;
export const FRAME_death102 = 33;
export const FRAME_death103 = 34;
export const FRAME_death104 = 35;
export const FRAME_death105 = 36;
export const FRAME_death106 = 37;
export const FRAME_death107 = 38;
export const FRAME_drain01 = 39;
export const FRAME_drain02 = 40;
export const FRAME_drain03 = 41;
export const FRAME_drain04 = 42;
export const FRAME_drain05 = 43;
export const FRAME_drain06 = 44;
export const FRAME_drain07 = 45;
export const FRAME_drain08 = 46;
export const FRAME_drain09 = 47;
export const FRAME_drain10 = 48;
export const FRAME_drain11 = 49;
export const FRAME_drain12 = 50;
export const FRAME_drain13 = 51;
export const FRAME_drain14 = 52;
export const FRAME_drain15 = 53;
export const FRAME_drain16 = 54;
export const FRAME_drain17 = 55;
export const FRAME_drain18 = 56;
export const FRAME_pain101 = 57;
export const FRAME_pain102 = 58;
export const FRAME_pain103 = 59;
export const FRAME_pain104 = 60;
export const FRAME_pain105 = 61;
export const FRAME_pain106 = 62;
export const FRAME_pain107 = 63;
export const FRAME_pain108 = 64;
export const FRAME_pain109 = 65;
export const FRAME_pain110 = 66;
export const FRAME_pain111 = 67;
export const FRAME_run01 = 68;
export const FRAME_run02 = 69;
export const FRAME_run03 = 70;
export const FRAME_run04 = 71;
export const FRAME_run05 = 72;
export const FRAME_run06 = 73;
export const FRAME_run07 = 74;
export const FRAME_run08 = 75;
export const FRAME_run09 = 76;
export const FRAME_run10 = 77;
export const FRAME_run11 = 78;
export const FRAME_run12 = 79;
export const FRAME_run13 = 80;
export const FRAME_run14 = 81;
export const FRAME_run15 = 82;
export const FRAME_stand01 = 83;
export const FRAME_stand02 = 84;
export const FRAME_stand03 = 85;
export const FRAME_stand04 = 86;
export const FRAME_stand05 = 87;
export const FRAME_stand06 = 88;
export const FRAME_stand07 = 89;
export const FRAME_stand08 = 90;
export const FRAME_stand09 = 91;
export const FRAME_stand10 = 92;
export const FRAME_stand11 = 93;
export const FRAME_stand12 = 94;
export const FRAME_stand13 = 95;
export const FRAME_stand14 = 96;
export const FRAME_stand15 = 97;
export const FRAME_stand16 = 98;
export const FRAME_stand17 = 99;
export const FRAME_stand18 = 100;
export const FRAME_stand19 = 101;
export const FRAME_stand20 = 102;
export const FRAME_stand21 = 103;
export const FRAME_stand22 = 104;
export const FRAME_stand23 = 105;
export const FRAME_stand24 = 106;
export const FRAME_stand25 = 107;
export const FRAME_stand26 = 108;
export const FRAME_stand27 = 109;
export const FRAME_stand28 = 110;
export const FRAME_stand29 = 111;
export const FRAME_stand30 = 112;
export const FRAME_stand31 = 113;
export const FRAME_stand32 = 114;
export const FRAME_stand33 = 115;
export const FRAME_stand34 = 116;
export const FRAME_stand35 = 117;
export const FRAME_jump01 = 118;
export const FRAME_jump02 = 119;
export const FRAME_jump03 = 120;
export const FRAME_jump04 = 121;
export const FRAME_jump05 = 122;
export const FRAME_jump06 = 123;
export const FRAME_jump07 = 124;
export const FRAME_jump08 = 125;

export const MODEL_SCALE = 1.0;

const g_athena_parasite_miss_chance = 0.1;
const g_athena_parasite_proboscis_speed = 1250;
const g_athena_parasite_proboscis_retract_modifier = 2.0;

function M_CheckGib(self: EdictT, mod: ModT): boolean {
  if (self.deadflag) {
    if (mod.id === ModIdT.MOD_CRUSH) return true;
  }
  return self.health <= self.gib_health;
}

function monster_footstep(_self: EdictT): void {
  // [Paril-KEX] g_local.h:3282 -- see m_chick.ts's identical local copy.
  // (parasite's own frame tables reference this the same way chick's do.)
}

function monster_jump_finished(self: EdictT): boolean {
  const { forward } = AngleVectors_destructured(self.s.angles);
  const forward_velocity = vec3_muls(forward, vec3_dot(self.velocity, forward));

  if (Math.hypot(forward_velocity[0], forward_velocity[1], forward_velocity[2]) < 150) {
    const z_velocity = self.velocity[2];
    self.velocity = vec3_muls(forward, 150);
    self.velocity[2] = z_velocity;
  }

  return self.monsterinfo.jump_time < level.time;
}

// blocked_checkjump is now a real import from "./rogue/g_rogue_newai" --
// see file header for the swap note.

// ---------------------------------------------------------------------------
// local mframe_t / mmove_t helpers (see m_flipper.ts for rationale)
// ---------------------------------------------------------------------------

function frame(aifunc: MframeAifuncFn | null, dist = 0, thinkfunc: MframeThinkfuncFn | null = null, lerp_frame = -1): MframeT {
  return { aifunc, dist, thinkfunc, lerp_frame };
}

function move(firstframe: number, lastframe: number, frames: MframeT[], endfunc: MmoveEndfuncFn | null = null): MmoveT {
  const m = new MmoveT();
  m.firstframe = firstframe;
  m.lastframe = lastframe;
  m.frame = frames;
  m.endfunc = endfunc;
  return m;
}

let sound_pain1 = 0;
let sound_pain2 = 0;
let sound_die = 0;
let sound_launch = 0;
let sound_impact = 0;
let sound_suck = 0;
let sound_reelin = 0;
let sound_sight = 0;
let sound_tap = 0;
let sound_scratch = 0;
let sound_search = 0;

function parasite_launch(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_launch, 1, ATTN_NORM, 0);
}

function parasite_reel_in(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_reelin, 1, ATTN_NORM, 0);
}

const parasite_sight = RegisterMonsterinfoSight("parasite_sight", (self: EdictT, _other: EdictT): void => {
  gi.sound(self, CHAN_WEAPON, sound_sight, 1, ATTN_NORM, 0);
});

function parasite_tap(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_tap, 0.75, 2.75, 0);
}

function parasite_scratch(self: EdictT): void {
  gi.sound(self, CHAN_WEAPON, sound_scratch, 0.75, 2.75, 0);
}

// m_parasite.cpp:63-68's `#if 0`-guarded parasite_search is dropped per
// PORTING.md's "#if 0 blocks are dropped silently."

// ---------------------------------------------------------------------------
// forward-referenced handlers -- see file header
// ---------------------------------------------------------------------------

function parasite_stand(self: EdictT): void {
  M_SetAnimation(self, parasite_move_stand, true);
}

function parasite_start_run(self: EdictT): void {
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, parasite_move_stand, true);
  else M_SetAnimation(self, parasite_move_start_run, true);
}

function parasite_run(self: EdictT): void {
  if (self.proboscus !== null && self.proboscus.style !== 2) proboscis_retract(self.proboscus);

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_STAND_GROUND) !== 0n) M_SetAnimation(self, parasite_move_stand, true);
  else M_SetAnimation(self, parasite_move_run, true);
}

function parasite_walk(self: EdictT): void {
  M_SetAnimation(self, parasite_move_walk, true);
}

function parasite_end_fidget(self: EdictT): void {
  M_SetAnimation(self, parasite_move_end_fidget, true);
}

function parasite_do_fidget(self: EdictT): void {
  M_SetAnimation(self, parasite_move_fidget, true);
}

function parasite_refidget(self: EdictT): void {
  if (frandom() <= 0.8) M_SetAnimation(self, parasite_move_fidget, true);
  else M_SetAnimation(self, parasite_move_end_fidget, true);
}

const parasite_idle = RegisterMonsterinfoIdle("parasite_idle", (self: EdictT): void => {
  if (self.enemy !== null) return;

  M_SetAnimation(self, parasite_move_start_fidget, true);
});

// ---------------------------------------------------------------------------
// stand (m_parasite.cpp:70-150)
// ---------------------------------------------------------------------------

const parasite_frames_start_fidget: MframeT[] = [frame(ai_stand), frame(ai_stand), frame(ai_stand), frame(ai_stand)];
const parasite_move_start_fidget = RegisterMmove(
  "parasite_move_start_fidget",
  move(FRAME_stand18, FRAME_stand21, parasite_frames_start_fidget, parasite_do_fidget),
);

const parasite_frames_fidget: MframeT[] = [
  frame(ai_stand, 0, parasite_scratch),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_scratch),
  frame(ai_stand),
  frame(ai_stand),
];
const parasite_move_fidget = RegisterMmove("parasite_move_fidget", move(FRAME_stand22, FRAME_stand27, parasite_frames_fidget, parasite_refidget));

const parasite_frames_end_fidget: MframeT[] = [
  frame(ai_stand, 0, parasite_scratch),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
];
const parasite_move_end_fidget = RegisterMmove(
  "parasite_move_end_fidget",
  move(FRAME_stand28, FRAME_stand35, parasite_frames_end_fidget, parasite_stand),
);

const parasite_frames_stand: MframeT[] = [
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
  frame(ai_stand),
  frame(ai_stand, 0, parasite_tap),
];
const parasite_move_stand = RegisterMmove("parasite_move_stand", move(FRAME_stand01, FRAME_stand17, parasite_frames_stand, parasite_stand));

const parasite_stand_registered = RegisterMonsterinfoStand("parasite_stand", parasite_stand);

// ---------------------------------------------------------------------------
// run / walk (m_parasite.cpp:152-239)
// ---------------------------------------------------------------------------

const parasite_frames_run: MframeT[] = [
  frame(ai_run, 30),
  frame(ai_run, 30),
  frame(ai_run, 22, monster_footstep),
  frame(ai_run, 19, monster_footstep),
  frame(ai_run, 24),
  frame(ai_run, 28, monster_footstep),
  frame(ai_run, 25, monster_footstep),
];
const parasite_move_run = RegisterMmove("parasite_move_run", move(FRAME_run03, FRAME_run09, parasite_frames_run));

const parasite_frames_start_run: MframeT[] = [frame(ai_run), frame(ai_run, 30)];
const parasite_move_start_run = RegisterMmove("parasite_move_start_run", move(FRAME_run01, FRAME_run02, parasite_frames_start_run, parasite_run));

// m_parasite.cpp:169-179's `#if 0`-guarded parasite_move_stop_run is dropped.

const parasite_start_run_registered = RegisterMonsterinfoRun("parasite_start_run", parasite_start_run);

const parasite_frames_walk: MframeT[] = [
  frame(ai_walk, 30),
  frame(ai_walk, 30),
  frame(ai_walk, 22, monster_footstep),
  frame(ai_walk, 19, monster_footstep),
  frame(ai_walk, 24),
  frame(ai_walk, 28, monster_footstep),
  frame(ai_walk, 25, monster_footstep),
];
const parasite_move_walk = RegisterMmove("parasite_move_walk", move(FRAME_run03, FRAME_run09, parasite_frames_walk, parasite_walk));

const parasite_frames_start_walk: MframeT[] = [frame(ai_walk, 0), frame(ai_walk, 30, parasite_walk)];
const parasite_move_start_walk = RegisterMmove("parasite_move_start_walk", move(FRAME_run01, FRAME_run02, parasite_frames_start_walk));

// m_parasite.cpp:219-229's `#if 0`-guarded parasite_move_stop_walk is dropped.

const parasite_start_walk = RegisterMonsterinfoWalk("parasite_start_walk", (self: EdictT): void => {
  M_SetAnimation(self, parasite_move_start_walk, true);
});

// ---------------------------------------------------------------------------
// proboscis reset/die (m_parasite.cpp:241-253)
// ---------------------------------------------------------------------------

// hard reset on proboscis; like we never existed
const proboscis_reset: MframeThinkfuncFn = RegisterThink("proboscis_reset", (self: EdictT): void => {
  if (self.owner !== null) self.owner.proboscus = null;
  if (self.proboscus !== null) G_FreeEdict(self.proboscus);
  G_FreeEdict(self);
});

const proboscis_die: DieFn = RegisterDie(
  "proboscis_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, _damage: number, _point: Vec3, mod: ModT): void => {
    if (mod.id === ModIdT.MOD_CRUSH) proboscis_reset(self);
  },
);

// ---------------------------------------------------------------------------
// break / retract (m_parasite.cpp:255-354)
// ---------------------------------------------------------------------------

function parasite_break_wait(self: EdictT): void {
  // prob exploded?
  if (self.proboscus !== null && self.proboscus.style !== 3) {
    self.monsterinfo.nextframe = FRAME_break19;
  } else if (brandom()) {
    // don't get hurt
    parasite_reel_in(self);
    self.monsterinfo.nextframe = FRAME_break31;
  }
}

function proboscis_retract(self: EdictT): void {
  // start retract animation
  if (self.owner !== null && self.owner.monsterinfo.active_move === parasite_move_fire_proboscis) {
    self.owner.monsterinfo.nextframe = FRAME_drain12;
  }

  // mark as retracting
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  // come back real hard
  if (self.style !== 2) self.speed *= g_athena_parasite_proboscis_retract_modifier;
  self.style = 2;
  gi.linkentity(self);
}

function parasite_break_retract(self: EdictT): void {
  if (self.proboscus !== null) proboscis_retract(self.proboscus);
}

function parasite_break_sound(self: EdictT): void {
  if (frandom() < 0.5) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));
}

function parasite_charge_proboscis(self: EdictT, dist: number): void {
  if (self.s.frame >= FRAME_break01 && self.s.frame <= FRAME_break32) ai_move(self, dist);
  else ai_charge(self, dist);

  if (self.proboscus !== null && self.proboscus.proboscus !== null) proboscis_segment_draw(self.proboscus.proboscus);
}

function parasite_break_noise(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_search, 1, ATTN_NORM, 0);
}

const parasite_frames_break: MframeT[] = [
  frame(parasite_charge_proboscis),
  frame(parasite_charge_proboscis, -3, parasite_break_noise),
  frame(parasite_charge_proboscis, 1),
  frame(parasite_charge_proboscis, 2),
  frame(parasite_charge_proboscis, -3),
  frame(parasite_charge_proboscis, 1),
  frame(parasite_charge_proboscis, 1),
  frame(parasite_charge_proboscis, 3),
  frame(parasite_charge_proboscis, 0, parasite_break_noise),
  frame(parasite_charge_proboscis, -18),
  frame(parasite_charge_proboscis, 3),
  frame(parasite_charge_proboscis, 9),
  frame(parasite_charge_proboscis, 6),
  frame(parasite_charge_proboscis),
  frame(parasite_charge_proboscis, -18),
  frame(parasite_charge_proboscis),
  frame(parasite_charge_proboscis, 8, parasite_break_retract),
  frame(parasite_charge_proboscis, 9),
  frame(parasite_charge_proboscis, 0, parasite_break_wait),
  frame(parasite_charge_proboscis, -18, parasite_break_sound),
  frame(parasite_charge_proboscis),
  frame(parasite_charge_proboscis), // airborne
  frame(parasite_charge_proboscis), // airborne
  frame(parasite_charge_proboscis), // slides
  frame(parasite_charge_proboscis), // slides
  frame(parasite_charge_proboscis), // slides
  frame(parasite_charge_proboscis), // slides
  frame(parasite_charge_proboscis, 4),
  frame(parasite_charge_proboscis, 11),
  frame(parasite_charge_proboscis, -2),
  frame(parasite_charge_proboscis, -5),
  frame(parasite_charge_proboscis, 1),
];
const parasite_move_break = RegisterMmove("parasite_move_break", move(FRAME_break01, FRAME_break32, parasite_frames_break, parasite_start_run));

// ---------------------------------------------------------------------------
// proboscis tip touch/think/segment-draw (m_parasite.cpp:356-464)
// ---------------------------------------------------------------------------

const proboscis_touch: TouchFn = RegisterTouch(
  "proboscis_touch",
  (self: EdictT, other: EdictT, tr: KexTraceT, _otherTouchingSelf: boolean): void => {
    // owner isn't trying to probe any more, don't touch anything
    if (self.owner === null || self.owner.monsterinfo.active_move !== parasite_move_fire_proboscis) return;

    let p: Vec3;

    // hit what we want to succ
    if ((other.svflags & SvflagsT.SVF_PLAYER) !== 0 || other === self.owner.enemy) {
      if (tr.startsolid) {
        p = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
      } else {
        p = vec3_sub(tr.endpos, vec3_muls(vec3_normalized(vec3_sub(self.s.origin, tr.endpos)), 12));
      }

      self.owner.monsterinfo.nextframe = FRAME_drain06;
      self.movetype = MovetypeT.MOVETYPE_NONE;
      self.solid = SolidT.SOLID_NOT;
      self.style = 1;
      // stick to this guy
      self.move_origin = vec3_sub(p, other.s.origin);
      self.enemy = other;
      self.s.alpha = 0.35;
      gi.sound(self, CHAN_WEAPON, sound_suck, 1, ATTN_NORM, 0);
    } else {
      p = vec3_add(tr.endpos, tr.plane.normal);
      // hit monster, don't suck but do small damage and retract immediately
      if ((other.svflags & (SvflagsT.SVF_MONSTER | SvflagsT.SVF_DEADMONSTER)) !== 0) {
        proboscis_retract(self);
      } else {
        // hit wall; stick to it and do break animation
        self.owner.monsterinfo.active_move = parasite_move_break;
        self.movetype = MovetypeT.MOVETYPE_NONE;
        self.solid = SolidT.SOLID_NOT;
        self.style = 1;
        self.owner.s.angles[YAW] = self.s.angles[YAW];
      }
    }

    if (other.takedamage) {
      T_Damage(other, self, self.owner, tr.plane.normal, tr.endpos, tr.plane.normal, 5, 0, DamageflagsT.DAMAGE_NONE, {
        id: ModIdT.MOD_UNKNOWN,
        friendly_fire: false,
        no_point_loss: false,
      });
    }

    gi.positioned_sound(tr.endpos, self.owner, CHAN_AUTO, sound_impact, 1, ATTN_NORM, 0);

    self.s.origin = p;
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s)); // start doing stuff on next frame
    gi.linkentity(self);
  },
);

// from break01
const parasite_break_offsets: readonly Vec3[] = [
  vec3(7.0, 0, 7.0),
  vec3(6.3, 14.5, 4.0),
  vec3(8.5, 0, 5.6),
  vec3(5.0, -15.25, 4.0),
  vec3(9.5, -1.8, 5.9),
  vec3(6.2, 14.0, 4.0),
  vec3(12.25, 7.5, 1.4),
  vec3(13.8, 0, -2.4),
  vec3(13.8, 0, -4.0),
  vec3(0.1, 0, -0.7),
  vec3(5.0, 0, 3.7),
  vec3(11.0, 0, 4.0),
  vec3(13.5, 0, -4.0),
  vec3(13.5, 0, -4.0),
  vec3(0.2, 0, -0.7),
  vec3(3.9, 0, 3.6),
  vec3(8.5, 0, 5.0),
  vec3(14.0, 0, -4.0),
  vec3(14.0, 0, -4.0),
  vec3(0.1, 0, -0.5),
];

// from drain01
const parasite_drain_offsets: readonly Vec3[] = [
  vec3(-1.7, 0, 1.2),
  vec3(-2.2, 0, -0.6),
  vec3(7.7, 0, 7.2),
  vec3(7.2, 0, 5.7),
  vec3(6.2, 0, 7.8),
  vec3(4.7, 0, 6.7),
  vec3(5.0, 0, 9.0),
  vec3(5.0, 0, 7.0),
  vec3(5.0, 0, 10.5),
  vec3(4.5, 0, 9.7),
  vec3(1.5, 0, 12.0),
  vec3(2.9, 0, 11.0),
  vec3(2.1, 0, 7.6),
];

function parasite_get_proboscis_start(self: EdictT): Vec3 {
  const { forward: f, right: r } = AngleVectors_destructured(self.s.angles);
  let offset: Vec3;
  if (self.s.frame >= FRAME_break01 && self.s.frame < FRAME_break01 + parasite_break_offsets.length) {
    offset = parasite_break_offsets[self.s.frame - FRAME_break01];
  } else if (self.s.frame >= FRAME_drain01 && self.s.frame < FRAME_drain01 + parasite_drain_offsets.length) {
    offset = parasite_drain_offsets[self.s.frame - FRAME_drain01];
  } else {
    offset = vec3(8, 0, 6);
  }
  return M_ProjectFlashSource(self, offset, f, r);
}

const proboscis_think: MframeThinkfuncFn = RegisterThink("proboscis_think", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s)); // start doing stuff on next frame

  // retracting; keep pulling until we hit the parasite
  if (self.style === 2) {
    if (self.owner === null) return;
    const start = parasite_get_proboscis_start(self.owner);
    const dirRaw = vec3_sub(self.s.origin, start);
    const dist = vec3_normalize(dirRaw);
    const dir = dirRaw;

    if (dist <= self.speed * 2 * gi.frame_time_s) {
      // reached target; free self on next frame, let parasite know
      self.style = 3;
      self.think = proboscis_reset;
      self.s.origin = vec3(start[0], start[1], start[2]);
      gi.linkentity(self);
      return;
    }

    // pull us in
    self.s.origin = vec3_sub(self.s.origin, vec3_muls(dir, self.speed * gi.frame_time_s));
    gi.linkentity(self);
  }
  // stuck on target; do damage, suck health and check if target goes away
  else if (self.style === 1) {
    if (self.enemy === null) {
      // stuck in wall
    } else if (!self.enemy.inuse || self.enemy.health <= 0 || !self.enemy.takedamage) {
      // target gone, retract early
      proboscis_retract(self);
    } else if (self.owner !== null) {
      // update our position
      self.s.origin = vec3_add(self.enemy.s.origin, self.move_origin);

      const start = parasite_get_proboscis_start(self.owner);

      self.s.angles = vectoangles(vec3_normalized(vec3_sub(self.s.origin, start)));

      // see if we got cut by the world
      const tr = gi.trace(start, null, null, self.s.origin, null, MASK_SOLID);

      if (tr.fraction !== 1.0) {
        // blocked, so retract
        proboscis_retract(self);
        self.s.origin = vec3(self.s.old_origin[0], self.s.old_origin[1], self.s.old_origin[2]);
      } else {
        // succ & drain
        if (self.timestamp <= level.time) {
          T_Damage(self.enemy, self, self.owner, tr.plane.normal, tr.endpos, tr.plane.normal, 2, 0, DamageflagsT.DAMAGE_NONE, {
            id: ModIdT.MOD_UNKNOWN,
            friendly_fire: false,
            no_point_loss: false,
          });
          self.owner.health = Math.min(self.owner.max_health, self.owner.health + 2);
          if (self.owner.monsterinfo.setskin !== null) self.owner.monsterinfo.setskin(self.owner);
          self.timestamp = Gtime_add(level.time, Gtime_from_hz(10));
        }
      }

      gi.linkentity(self);
    }
  }
  // flying
  else if (self.style === 0) {
    if (self.owner === null) return;
    // owner gone away?
    if (self.owner.enemy === null || !self.owner.enemy.inuse || self.owner.enemy.health <= 0) {
      proboscis_retract(self);
      return;
    }

    // if we're well behind our target and missed by 2x velocity, be smart
    // enough to pull in automatically
    const to_target_raw = vec3_sub(self.s.origin, self.owner.enemy.s.origin);
    const dist_to_target = vec3_normalize(to_target_raw);

    if (dist_to_target > (self.speed * 2) / 15) {
      const from_owner = vec3_normalized(vec3_sub(self.s.origin, self.owner.s.origin));
      const dot = vec3_dot(to_target_raw, from_owner);

      if (dot > 0) {
        proboscis_retract(self);
        return;
      }
    }
  }
});

const proboscis_segment_draw: PrethinkFn = RegisterPrethink("proboscis_segment_draw", (self: EdictT): void => {
  if (self.owner === null || self.owner.owner === null) return;
  const start = parasite_get_proboscis_start(self.owner.owner);

  self.s.origin = vec3(start[0], start[1], start[2]);
  self.s.old_origin = vec3_sub(self.owner.s.origin, vec3_muls(vec3_normalized(vec3_sub(self.owner.s.origin, start)), 8));
  gi.linkentity(self);
});

function fire_proboscis(self: EdictT, start: Vec3, dir: Vec3, speed: number): void {
  const tip = G_Spawn();
  tip.s.angles = vectoangles(dir);
  tip.s.modelindex = gi.modelindex("models/monsters/parasite/tip/tris.md2");
  tip.movetype = MovetypeT.MOVETYPE_FLYMISSILE;
  tip.owner = self;
  self.proboscus = tip;
  tip.clipmask = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;
  tip.s.origin = vec3(start[0], start[1], start[2]);
  tip.s.old_origin = vec3(start[0], start[1], start[2]);
  tip.speed = speed;
  tip.velocity = vec3_muls(dir, speed);
  tip.solid = SolidT.SOLID_BBOX;
  tip.takedamage = true;
  tip.flags |= EntFlagsT.FL_NO_DAMAGE_EFFECTS | EntFlagsT.FL_NO_KNOCKBACK;
  tip.die = proboscis_die;
  tip.touch = proboscis_touch;
  tip.think = proboscis_think;
  tip.nextthink = Gtime_add(level.time, Gtime_from_sec(gi.frame_time_s)); // start doing stuff on next frame
  tip.svflags |= SvflagsT.SVF_PROJECTILE;

  const segment = G_Spawn();
  segment.s.modelindex = gi.modelindex("models/monsters/parasite/segment/tris.md2");
  segment.s.renderfx |= RF_BEAM;
  segment.postthink = proboscis_segment_draw;

  tip.proboscus = segment;
  segment.owner = tip;

  const tr = gi.trace(tip.s.origin, null, null, vec3_add(tip.s.origin, vec3_muls(tip.velocity, gi.frame_time_s)), self, tip.clipmask);
  if (tr.startsolid) {
    tr.plane.normal = vec3_muls(dir, -1);
    tr.endpos = vec3(start[0], start[1], start[2]);
    if (tip.touch !== null) tip.touch(tip, tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0], tr, false);
  } else if (tr.fraction < 1.0) {
    if (tip.touch !== null) tip.touch(tip, tr.ent !== null ? g_edicts[tr.ent.s.number] : g_edicts[0], tr, false);
  }

  segment.s.origin = vec3(start[0], start[1], start[2]);
  segment.s.old_origin = vec3_add(tip.s.origin, vec3_muls(vec3_normalized(vec3_sub(tip.s.origin, start)), 8));

  gi.linkentity(tip);
  gi.linkentity(segment);
}

function parasite_fire_proboscis(self: EdictT): void {
  if (self.proboscus !== null && self.proboscus.style !== 2) proboscis_reset(self.proboscus);

  const start = parasite_get_proboscis_start(self);

  const dir = vec3();
  PredictAim(self, self.enemy, start, g_athena_parasite_proboscis_speed, false, crandom_open() * g_athena_parasite_miss_chance, dir, null);

  fire_proboscis(self, start, dir, g_athena_parasite_proboscis_speed);
}

function parasite_proboscis_wait(self: EdictT): void {
  // loop frames while we wait
  if (self.s.frame === FRAME_drain04) self.monsterinfo.nextframe = FRAME_drain05;
  else self.monsterinfo.nextframe = FRAME_drain04;
}

function parasite_proboscis_pull_wait(self: EdictT): void {
  // prob exploded?
  if (self.proboscus === null || self.proboscus.style === 3) {
    self.monsterinfo.nextframe = FRAME_drain14;
    return;
  }

  // being pulled in, so wait until we get destroyed
  if (self.s.frame === FRAME_drain12) self.monsterinfo.nextframe = FRAME_drain13;
  else self.monsterinfo.nextframe = FRAME_drain12;

  if (self.proboscus.style !== 2) proboscis_retract(self.proboscus);
}

const parasite_frames_fire_proboscis: MframeT[] = [
  frame(parasite_charge_proboscis, 0, parasite_launch),
  frame(parasite_charge_proboscis),
  frame(parasite_charge_proboscis, 15, parasite_fire_proboscis), // Target hits
  frame(parasite_charge_proboscis, 0, parasite_proboscis_wait), // drain
  frame(parasite_charge_proboscis, 0, parasite_proboscis_wait), // drain
  frame(parasite_charge_proboscis, 0), // drain
  frame(parasite_charge_proboscis, 0), // drain
  frame(parasite_charge_proboscis, -2), // drain
  frame(parasite_charge_proboscis, -2), // drain
  frame(parasite_charge_proboscis, -3), // drain
  frame(parasite_charge_proboscis, -2), // drain
  frame(parasite_charge_proboscis, 0, parasite_proboscis_pull_wait), // drain
  frame(parasite_charge_proboscis, -1, parasite_proboscis_pull_wait), // drain
  frame(parasite_charge_proboscis, 0, parasite_reel_in), // let go
  frame(parasite_charge_proboscis, -2),
  frame(parasite_charge_proboscis, -2),
  frame(parasite_charge_proboscis, -3),
  frame(parasite_charge_proboscis),
];
const parasite_move_fire_proboscis = RegisterMmove(
  "parasite_move_fire_proboscis",
  move(FRAME_drain01, FRAME_drain18, parasite_frames_fire_proboscis, parasite_start_run),
);

const parasite_attack = RegisterMonsterinfoAttack("parasite_attack", (self: EdictT): void => {
  if (!M_CheckClearShot(self, parasite_drain_offsets[0])) return;

  if (self.proboscus !== null && self.proboscus.style !== 2) proboscis_retract(self.proboscus);

  M_SetAnimation(self, parasite_move_fire_proboscis, true);
});

// ================
// ROGUE
function parasite_jump_down(self: EdictT): void {
  const { forward, up } = AngleVectors_destructured(self.s.angles);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 100));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 300));
}

function parasite_jump_up(self: EdictT): void {
  const { forward, up } = AngleVectors_destructured(self.s.angles);
  self.velocity = vec3_add(self.velocity, vec3_muls(forward, 200));
  self.velocity = vec3_add(self.velocity, vec3_muls(up, 450));
}

function parasite_jump_wait_land(self: EdictT): void {
  if (self.groundentity === null) {
    self.monsterinfo.nextframe = self.s.frame;

    if (monster_jump_finished(self)) self.monsterinfo.nextframe = self.s.frame + 1;
  } else {
    self.monsterinfo.nextframe = self.s.frame + 1;
  }
}

const parasite_frames_jump_up: MframeT[] = [
  frame(ai_move, -8),
  frame(ai_move, -8),
  frame(ai_move, -8),
  frame(ai_move, -8, parasite_jump_up),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, parasite_jump_wait_land),
  frame(ai_move),
];
const parasite_move_jump_up = RegisterMmove("parasite_move_jump_up", move(FRAME_jump01, FRAME_jump08, parasite_frames_jump_up, parasite_run));

const parasite_frames_jump_down: MframeT[] = [
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, parasite_jump_down),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, parasite_jump_wait_land),
  frame(ai_move),
];
const parasite_move_jump_down = RegisterMmove("parasite_move_jump_down", move(FRAME_jump01, FRAME_jump08, parasite_frames_jump_down, parasite_run));

function parasite_jump(self: EdictT, result: BlockedJumpResultT): void {
  if (self.enemy === null) return;

  if (result === BlockedJumpResultT.JUMP_JUMP_UP) M_SetAnimation(self, parasite_move_jump_up, true);
  else M_SetAnimation(self, parasite_move_jump_down, true);
}

/*
===
Blocked
===
*/
const parasite_blocked = RegisterMonsterinfoBlocked("parasite_blocked", (self: EdictT, dist: number): boolean => {
  const result = blocked_checkjump(self, dist);
  if (result !== BlockedJumpResultT.NO_JUMP) {
    if (result !== BlockedJumpResultT.JUMP_TURN) parasite_jump(self, result);
    return true;
  }

  if (blocked_checkplat(self, dist)) return true;

  return false;
});
// ROGUE
// ================

/*
===
Death Stuff Starts
===
*/

function parasite_dead(self: EdictT): void {
  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, -8);
  monster_dead(self);
}

function parasite_shrink(self: EdictT): void {
  self.maxs[2] = 0;
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}

const parasite_frames_death: MframeT[] = [
  frame(ai_move, 0, null, FRAME_stand01),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, parasite_shrink),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
];
const parasite_move_death = RegisterMmove("parasite_move_death", move(FRAME_death101, FRAME_death107, parasite_frames_death, parasite_dead));

const parasite_die = RegisterDie(
  "parasite_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    if (self.proboscus !== null && self.proboscus.style !== 2) proboscis_reset(self.proboscus);

    // check for gib
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_NORM, 0);

      self.s.skinnum = Math.trunc(self.s.skinnum / 2);

      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2" },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 3 },
        { gibname: "models/monsters/parasite/gibs/chest.md2", type: GibTypeT.GIB_SKINNED },
        { gibname: "models/monsters/parasite/gibs/bleg.md2", count: 2, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/parasite/gibs/fleg.md2", count: 2, type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_UPRIGHT },
        { gibname: "models/monsters/parasite/gibs/head.md2", type: GibTypeT.GIB_SKINNED | GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);

      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    // regular death
    gi.sound(self, CHAN_VOICE, sound_die, 1, ATTN_NORM, 0);
    self.deadflag = true;
    self.takedamage = true;
    M_SetAnimation(self, parasite_move_death, true);
  },
);

/*
===
End Death Stuff
===
*/

const parasite_frames_pain1: MframeT[] = [
  frame(ai_move, 0, null, FRAME_stand01),
  frame(ai_move),
  frame(ai_move, 0, (self: EdictT): void => {
    self.monsterinfo.nextframe = FRAME_pain105;
  }),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 6, monster_footstep),
  frame(ai_move, 16),
  frame(ai_move, -6, monster_footstep),
  frame(ai_move, -7),
  frame(ai_move),
];
const parasite_move_pain1 = RegisterMmove("parasite_move_pain1", move(FRAME_pain101, FRAME_pain111, parasite_frames_pain1, parasite_start_run));

const parasite_pain = RegisterPain("parasite_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  if (self.proboscus !== null && self.proboscus.style !== 2) proboscis_retract(self.proboscus);

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  if (frandom() < 0.5) gi.sound(self, CHAN_VOICE, sound_pain1, 1, ATTN_NORM, 0);
  else gi.sound(self, CHAN_VOICE, sound_pain2, 1, ATTN_NORM, 0);

  if (!M_ShouldReactToPain(self, mod)) return; // no pain anims in nightmare

  M_SetAnimation(self, parasite_move_pain1, true);
});

const parasite_setskin = RegisterMonsterinfoSetskin("parasite_setskin", (self: EdictT): void => {
  if (self.health < self.max_health / 2) self.s.skinnum = 1;
  else self.s.skinnum = 0;
});

const SPAWNFLAG_PARASITE_NOJUMPING: SpawnFlags = SpawnFlags_from(8);

/**
 * QUAKED monster_parasite (1 .5 0) (-16 -16 -24) (16 16 32) Ambush
 * Trigger_Spawn Sight NoJumping
 */
export function SP_monster_parasite(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_pain1 = gi.soundindex("parasite/parpain1.wav");
  sound_pain2 = gi.soundindex("parasite/parpain2.wav");
  sound_die = gi.soundindex("parasite/pardeth1.wav");
  sound_launch = gi.soundindex("parasite/paratck1.wav");
  sound_impact = gi.soundindex("parasite/paratck2.wav");
  sound_suck = gi.soundindex("parasite/paratck3.wav");
  sound_reelin = gi.soundindex("parasite/paratck4.wav");
  sound_sight = gi.soundindex("parasite/parsght1.wav");
  sound_tap = gi.soundindex("parasite/paridle1.wav");
  sound_scratch = gi.soundindex("parasite/paridle2.wav");
  sound_search = gi.soundindex("parasite/parsrch1.wav");

  gi.modelindex("models/monsters/parasite/tip/tris.md2");
  gi.modelindex("models/monsters/parasite/segment/tris.md2");

  self.s.modelindex = gi.modelindex("models/monsters/parasite/tris.md2");

  gi.modelindex("models/monsters/parasite/gibs/head.md2");
  gi.modelindex("models/monsters/parasite/gibs/chest.md2");
  gi.modelindex("models/monsters/parasite/gibs/bleg.md2");
  gi.modelindex("models/monsters/parasite/gibs/fleg.md2");

  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 24);
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;

  self.health = Math.trunc(175 * st.health_multiplier);
  self.gib_health = -50;
  self.mass = 250;

  self.pain = parasite_pain;
  self.die = parasite_die;

  self.monsterinfo.stand = parasite_stand_registered;
  self.monsterinfo.walk = parasite_start_walk;
  self.monsterinfo.run = parasite_start_run_registered;
  self.monsterinfo.attack = parasite_attack;
  self.monsterinfo.sight = parasite_sight;
  self.monsterinfo.idle = parasite_idle;
  self.monsterinfo.blocked = parasite_blocked; // PGM
  self.monsterinfo.setskin = parasite_setskin;

  gi.linkentity(self);

  M_SetAnimation(self, parasite_move_stand, true);
  self.monsterinfo.scale = MODEL_SCALE;
  self.yaw_speed = 30;
  self.monsterinfo.can_jump = !SpawnFlags_has(self.spawnflags, SPAWNFLAG_PARASITE_NOJUMPING);
  self.monsterinfo.drop_height = 256;
  self.monsterinfo.jump_height = 68;

  walkmonster_start(self);
}
