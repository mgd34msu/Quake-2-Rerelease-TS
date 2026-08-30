// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_insane.cpp / m_insane.h -- INSANE (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_insane.cpp (693 lines, C++17)
// and m_insane.h (294 lines, 291-entry frame enum plus MODEL_SCALE).
// Behavioral code, ported bug-for-bug per PORTING.md.
//
// This is a full KEX rewrite of the legacy vanilla-Q2 `misc_insane` this
// directory's own src/game/m_insane.ts already ports (the two files are NOT
// meant to be diffed line-for-line -- KEX added a QUIET spawnflag, the
// `insane_shake`/`insane_moan`/`insane_scream` sound gates, an
// `attack_finished`-based debounce so moan/scream aren't retriggered every
// frame, `monster_footstep` thinkfuncs threaded through walk/crawl/pain/
// death frames, `M_AllowSpawn`, `M_CheckGib`/`ThrowGibs`-based death, health
// scaled by `st.health_multiplier`, and the crucified-monster path now
// calling `stationarymonster_start` -- see this file's own note on that
// below -- instead of `flymonster_start`).
//
// ============================================================================
// stationarymonster_start -- DOCUMENTED UPSTREAM HOLE, not a porting gap
// ============================================================================
// SP_misc_insane's CRUCIFIED branch (m_insane.cpp:683-687) sets
// `self->flags |= FL_NO_KNOCKBACK | FL_STATIONARY;` then calls
// `stationarymonster_start(self)`. `stationarymonster_start` is declared in
// g_local.h:2240 but, per g_monster.ts's own header note and its throwing
// stub at the bottom of that file, has NO definition anywhere in the shipped
// rerelease source tree (verified there by grepping every *.cpp for the
// body, not just callers) -- a genuine hole in the upstream C++ source. This
// file calls `stationarymonster_start` exactly as the C++ does (imported
// from g_monster.ts, not reimplemented or worked around here); calling
// `SP_misc_insane` with the CRUCIFIED spawnflag set will throw that stub's
// error, exactly mirroring the C++ side's own dead end.
//
// ============================================================================
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see m_gladiator.ts header
// ============================================================================
// - `monster_footstep` (g_local.h:3282, `inline`) and `M_CheckGib`
//   (g_local.h:3521, `inline`) are trivial header-only helpers with no
//   rogue dependency -- reimplemented locally, exactly m_gladiator.ts's/
//   m_berserk.ts's own copies.
//
// ============================================================================
// OTHER NOTED DEVIATIONS / QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - `insane_shrink` (m_insane.cpp:75-80) is commented in its own C++ source
//   as "unused atm because it breaks N64" -- dead code in the shipped
//   source, not called from anywhere in this file. Ported as an unexported,
//   unreferenced function (matching the C++'s own reachability) with a
//   `void insane_shrink;`-style suppression comment rather than silently
//   dropped, per PORTING.md's "dead code that still compiles in C++ gets a
//   TS body too, not a deletion."
// - `cached_soundindex` fields port as plain per-file `let sound_x = 0`
//   module variables, matching m_gladiator.ts/m_supertank.ts's precedent.
// - `insane_moan`/`insane_scream` gate on `self.monsterinfo.attack_finished
//   < level.time` (a debounce field reused here for an unrelated purpose,
//   exactly as the C++ comment "Paril: don't moan every second" documents)
//   -- NOT gated when `self.spawnflags` has QUIET, in which case the sound
//   plays not at all (`insane_shake`/`insane_moan`/`insane_scream` all
//   early-return on QUIET before touching `attack_finished`).
// - `insane_pain`'s crawl-pain frame range check ADDS `FRAME_stand1..
//   FRAME_stand40` to the crawl/low-stand ranges the legacy port already
//   had (m_insane.cpp:507) -- a genuine KEX behavior change, not a mistake;
//   preserved exactly.
// - `SP_misc_insane` calls the real `M_AllowSpawn` (g_monster.ts) as its
//   very first statement -- absent from the legacy vanilla port entirely.
// - `self.health = 100 * st.health_multiplier` (KEX) vs. legacy's bare
//   `100` -- KEX's skill-scaling infrastructure, ported per its own
//   integer-truncation convention (`Math.trunc`) matching every other
//   landed KEX monster file (m_supertank.ts, etc.).
// - `insane_die`'s crucified branch calls `insane_dead(self)` directly
//   (which itself calls the shared `monster_dead` from g_monster.ts,
//   setting MOVETYPE_TOSS/SVF_DEADMONSTER/etc. unconditionally) even though
//   the crucified branch of `insane_dead` sets `self.flags |= FL_FLY`
//   instead of retargeting mins/maxs/movetype -- `monster_dead` still forces
//   `movetype = MOVETYPE_TOSS` right after, so a crucified corpse ends up
//   both FL_FLY and MOVETYPE_TOSS simultaneously. This looks like a
//   pre-existing quirk in the shipped C++ source (`insane_dead` and
//   `monster_dead` stepping on each other), preserved exactly, not fixed.

import { vec3, type Vec3 } from "../shared/math";
import { CHAN_VOICE, ATTN_IDLE } from "../shared/q_shared";
import { KexEntityEventT, SvflagsT, SolidT } from "../kexapi/game";
import {
  type EdictT,
  type MframeAifuncFn,
  type MframeThinkfuncFn,
  type MmoveEndfuncFn,
  type ModT,
  MframeT,
  MmoveT,
  MonsterAiFlagsT,
  EntFlagsT,
  ModIdT,
  GibTypeT,
  MovetypeT,
  random_time,
} from "./g_local";
import { ai_stand, ai_walk, ai_move } from "./g_ai";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has, SpawnFlags_has_all, SpawnFlags_or } from "./spawnflags";
import { frandom, brandom, irandom, random_element } from "./q_std";
import { st } from "./g_spawn";
import { G_FreeEdict } from "./g_utils";
import { M_SetAnimation, M_AllowSpawn, walkmonster_start, stationarymonster_start, monster_dead } from "./g_monster";
import { ThrowGibs, type GibDefT } from "./g_misc";
import {
  RegisterDie,
  RegisterPain,
  RegisterMonsterinfoStand,
  RegisterMonsterinfoWalk,
  RegisterMonsterinfoRun,
  RegisterMmove,
} from "./g_save_registry";

// ---------------------------------------------------------------------------
// m_insane.h frame constants (generated from the enum, see file header)
// ---------------------------------------------------------------------------

export const FRAME_stand1 = 0;
export const FRAME_stand40 = 39;
export const FRAME_stand41 = 40;
export const FRAME_stand59 = 58;
export const FRAME_stand60 = 59;
export const FRAME_stand65 = 64;
export const FRAME_stand94 = 93;
export const FRAME_stand96 = 95;
export const FRAME_stand99 = 98;
export const FRAME_stand100 = 99;
export const FRAME_stand160 = 159;
export const FRAME_walk27 = 160;
export const FRAME_walk39 = 172;
export const FRAME_walk1 = 173;
export const FRAME_walk26 = 198;
export const FRAME_st_pain2 = 199;
export const FRAME_st_pain12 = 209;
export const FRAME_st_death2 = 210;
export const FRAME_st_death18 = 226;
export const FRAME_crawl1 = 227;
export const FRAME_crawl9 = 235;
export const FRAME_cr_pain2 = 236;
export const FRAME_cr_pain10 = 244;
export const FRAME_cr_death10 = 245;
export const FRAME_cr_death16 = 251;
export const FRAME_cross1 = 252;
export const FRAME_cross15 = 266;
export const FRAME_cross16 = 267;
export const FRAME_cross30 = 281;

export const MODEL_SCALE = 1.0;

const SPAWNFLAG_INSANE_CRAWL: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_INSANE_CRUCIFIED: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAG_INSANE_STAND_GROUND: SpawnFlags = SpawnFlags_from(16);
const SPAWNFLAG_INSANE_ALWAYS_STAND: SpawnFlags = SpawnFlags_from(32);
const SPAWNFLAG_INSANE_QUIET: SpawnFlags = SpawnFlags_from(64);

// ---------------------------------------------------------------------------
// PLACEMENT-MISMATCH FUNCTIONS PORTED LOCALLY -- see file header
// ---------------------------------------------------------------------------

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

let sound_fist = 0;
let sound_shake = 0;
let sound_moan = 0;
const sound_scream: number[] = new Array(8).fill(0);

function insane_fist(self: EdictT): void {
  gi.sound(self, CHAN_VOICE, sound_fist, 1, ATTN_IDLE, 0);
}

function insane_shake(self: EdictT): void {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_QUIET)) gi.sound(self, CHAN_VOICE, sound_shake, 1, ATTN_IDLE, 0);
}

function insane_moan(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_QUIET)) return;

  // Paril: don't moan every second
  if (self.monsterinfo.attack_finished < level.time) {
    gi.sound(self, CHAN_VOICE, sound_moan, 1, ATTN_IDLE, 0);
    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(3)));
  }
}

function insane_scream(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_QUIET)) return;

  // Paril: don't moan every second
  if (self.monsterinfo.attack_finished < level.time) {
    gi.sound(self, CHAN_VOICE, random_element(sound_scream), 1, ATTN_IDLE, 0);
    self.monsterinfo.attack_finished = Gtime_add(level.time, random_time(Gtime_from_sec(1), Gtime_from_sec(3)));
  }
}

// Paril: unused atm because it breaks N64. may fix later. Dead code in the
// shipped C++ source too (never called from anywhere in m_insane.cpp);
// preserved rather than dropped, per PORTING.md.
function insane_shrink(self: EdictT): void {
  self.maxs = vec3(self.maxs[0], self.maxs[1], 0);
  self.svflags |= SvflagsT.SVF_DEADMONSTER;
  gi.linkentity(self);
}
void insane_shrink; // see comment above: reachable in the C++ source, unreferenced here too

// ---------------------------------------------------------------------------
// stand / cross (m_insane.cpp:82-124, 393-437, 550-567)
// ---------------------------------------------------------------------------

const insane_frames_stand_normal: MframeT[] = [
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand),
  frame(ai_stand, 0, insane_checkdown),
];
const insane_move_stand_normal = RegisterMmove("insane_move_stand_normal", move(FRAME_stand60, FRAME_stand65, insane_frames_stand_normal, insane_stand));

const insane_frames_stand_insane: MframeT[] = [
  frame(ai_stand, 0, insane_shake),
  ...Array.from({ length: 28 }, () => frame(ai_stand)),
  frame(ai_stand, 0, insane_checkdown),
];
const insane_move_stand_insane = RegisterMmove("insane_move_stand_insane", move(FRAME_stand65, FRAME_stand94, insane_frames_stand_insane, insane_stand));

const insane_frames_uptodown: MframeT[] = [
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, insane_moan),
  frame(ai_move), // , 0, monster_duck_down -- see m_soldier.ts header (1); commented out in the C++ source too
  frame(ai_move),

  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),

  frame(ai_move, 2.7),
  frame(ai_move, 4.1),
  frame(ai_move, 6),
  frame(ai_move, 7.6),
  frame(ai_move, 3.6),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, insane_fist),
  frame(ai_move),
  frame(ai_move),

  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, insane_fist),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
];
const insane_move_uptodown = RegisterMmove("insane_move_uptodown", move(FRAME_stand1, FRAME_stand40, insane_frames_uptodown, insane_onground));

const insane_frames_downtoup: MframeT[] = [
  frame(ai_move, -0.7), // 41
  frame(ai_move, -1.2), // 42
  frame(ai_move, -1.5), // 43
  frame(ai_move, -4.5), // 44
  frame(ai_move, -3.5), // 45
  frame(ai_move, -0.2), // 46
  frame(ai_move), // 47
  frame(ai_move, -1.3), // 48
  frame(ai_move, -3), // 49
  frame(ai_move, -2), // 50
  frame(ai_move), // , 0, monster_duck_up -- see comment above; 51
  frame(ai_move), // 52
  frame(ai_move), // 53
  frame(ai_move, -3.3), // 54
  frame(ai_move, -1.6), // 55
  frame(ai_move, -0.3), // 56
  frame(ai_move), // 57
  frame(ai_move), // 58
  frame(ai_move), // 59
];
const insane_move_downtoup = RegisterMmove("insane_move_downtoup", move(FRAME_stand41, FRAME_stand59, insane_frames_downtoup, insane_stand));

const insane_frames_jumpdown: MframeT[] = [frame(ai_move, 0.2), frame(ai_move, 11.5), frame(ai_move, 5.1), frame(ai_move, 7.1), frame(ai_move)];
const insane_move_jumpdown = RegisterMmove("insane_move_jumpdown", move(FRAME_stand96, FRAME_stand100, insane_frames_jumpdown, insane_onground));

const insane_frames_down: MframeT[] = [
  frame(ai_move), // 100
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move), // 110
  frame(ai_move, -1.7),
  frame(ai_move, -1.6),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, insane_fist),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move), // 120
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move), // 130
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, insane_moan),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move), // 140
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move), // 150
  frame(ai_move, 0.5),
  frame(ai_move),
  frame(ai_move, -0.2, insane_scream),
  frame(ai_move),
  frame(ai_move, 0.2),
  frame(ai_move, 0.4),
  frame(ai_move, 0.6),
  frame(ai_move, 0.8),
  frame(ai_move, 0.7),
  frame(ai_move, 0, insane_checkup), // 160
];
const insane_move_down = RegisterMmove("insane_move_down", move(FRAME_stand100, FRAME_stand160, insane_frames_down, insane_onground));

const insane_frames_walk_normal: MframeT[] = [
  frame(ai_walk, 0, insane_scream),
  frame(ai_walk, 2.5),
  frame(ai_walk, 3.5),
  frame(ai_walk, 1.7),
  frame(ai_walk, 2.3),
  frame(ai_walk, 2.4),
  frame(ai_walk, 2.2, monster_footstep),
  frame(ai_walk, 4.2),
  frame(ai_walk, 5.6),
  frame(ai_walk, 3.3),
  frame(ai_walk, 2.4),
  frame(ai_walk, 0.9),
  frame(ai_walk, 0, monster_footstep),
];
const insane_move_walk_normal = RegisterMmove("insane_move_walk_normal", move(FRAME_walk27, FRAME_walk39, insane_frames_walk_normal, insane_walk));
const insane_move_run_normal = RegisterMmove("insane_move_run_normal", move(FRAME_walk27, FRAME_walk39, insane_frames_walk_normal, insane_run));

const insane_frames_walk_insane: MframeT[] = [
  frame(ai_walk, 0, insane_scream), // walk 1
  frame(ai_walk, 3.4), // walk 2
  frame(ai_walk, 3.6), // 3
  frame(ai_walk, 2.9), // 4
  frame(ai_walk, 2.2), // 5
  frame(ai_walk, 2.6, monster_footstep), // 6
  frame(ai_walk), // 7
  frame(ai_walk, 0.7), // 8
  frame(ai_walk, 4.8), // 9
  frame(ai_walk, 5.3), // 10
  frame(ai_walk, 1.1), // 11
  frame(ai_walk, 2, monster_footstep), // 12
  frame(ai_walk, 0.5), // 13
  frame(ai_walk), // 14
  frame(ai_walk), // 15
  frame(ai_walk, 4.9), // 16
  frame(ai_walk, 6.7), // 17
  frame(ai_walk, 3.8), // 18
  frame(ai_walk, 2, monster_footstep), // 19
  frame(ai_walk, 0.2), // 20
  frame(ai_walk), // 21
  frame(ai_walk, 3.4), // 22
  frame(ai_walk, 6.4), // 23
  frame(ai_walk, 5), // 24
  frame(ai_walk, 1.8, monster_footstep), // 25
  frame(ai_walk), // 26
];
const insane_move_walk_insane = RegisterMmove("insane_move_walk_insane", move(FRAME_walk1, FRAME_walk26, insane_frames_walk_insane, insane_walk));
const insane_move_run_insane = RegisterMmove("insane_move_run_insane", move(FRAME_walk1, FRAME_walk26, insane_frames_walk_insane, insane_run));

const insane_frames_stand_pain: MframeT[] = [
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
];
const insane_move_stand_pain = RegisterMmove("insane_move_stand_pain", move(FRAME_st_pain2, FRAME_st_pain12, insane_frames_stand_pain, insane_run));

const insane_frames_stand_death: MframeT[] = [
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move, 0, monster_footstep),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
  frame(ai_move),
];
const insane_move_stand_death = RegisterMmove("insane_move_stand_death", move(FRAME_st_death2, FRAME_st_death18, insane_frames_stand_death, insane_dead));

const insane_frames_crawl: MframeT[] = [
  frame(ai_walk, 0, insane_scream),
  frame(ai_walk, 1.5),
  frame(ai_walk, 2.1),
  frame(ai_walk, 3.6),
  frame(ai_walk, 2, monster_footstep),
  frame(ai_walk, 0.9),
  frame(ai_walk, 3),
  frame(ai_walk, 3.4),
  frame(ai_walk, 2.4, monster_footstep),
];
const insane_move_crawl = RegisterMmove("insane_move_crawl", move(FRAME_crawl1, FRAME_crawl9, insane_frames_crawl, null));
const insane_move_runcrawl = RegisterMmove("insane_move_runcrawl", move(FRAME_crawl1, FRAME_crawl9, insane_frames_crawl, null));

const insane_frames_crawl_pain: MframeT[] = Array.from({ length: 9 }, () => frame(ai_move));
const insane_move_crawl_pain = RegisterMmove("insane_move_crawl_pain", move(FRAME_cr_pain2, FRAME_cr_pain10, insane_frames_crawl_pain, insane_run));

const insane_frames_crawl_death: MframeT[] = Array.from({ length: 7 }, () => frame(ai_move));
const insane_move_crawl_death = RegisterMmove("insane_move_crawl_death", move(FRAME_cr_death10, FRAME_cr_death16, insane_frames_crawl_death, insane_dead));

const insane_frames_cross: MframeT[] = [frame(ai_move, 0, insane_moan), ...Array.from({ length: 14 }, () => frame(ai_move))];
const insane_move_cross = RegisterMmove("insane_move_cross", move(FRAME_cross1, FRAME_cross15, insane_frames_cross, insane_cross));

const insane_frames_struggle_cross: MframeT[] = [frame(ai_move, 0, insane_scream), ...Array.from({ length: 14 }, () => frame(ai_move))];
const insane_move_struggle_cross = RegisterMmove(
  "insane_move_struggle_cross",
  move(FRAME_cross16, FRAME_cross30, insane_frames_struggle_cross, insane_cross),
);

function insane_cross(self: EdictT): void {
  if (frandom() < 0.8) M_SetAnimation(self, insane_move_cross, true);
  else M_SetAnimation(self, insane_move_struggle_cross, true);
}

// `insane_walk`/`insane_run` (and `insane_stand`, below) are plain hoisted
// `function` declarations rather than `const x = RegisterX(...)`, matching
// m_soldier.ts's `M_MonsterDodge`/`monster_duck_up` precedent: the C++ move
// tables above use these as their own `endfunc` (`insane_move_walk_normal`'s
// endfunc IS `insane_walk`, etc. -- see m_insane.cpp's own forward
// declarations at the top of the file, lines 64-71), so the plain names must
// already be usable at those tables' point of definition. A `const`
// initialized by `RegisterX(...)` is in the temporal dead zone until that
// statement runs, which is too late for the tables above; a `function`
// declaration is fully hoisted. `RegisterMonsterinfoWalk`/`Run`/`Stand` are
// called right after each definition purely for save-registry side effects.

function insane_walk(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_STAND_GROUND)) {
    // Hold Ground?
    if (self.s.frame === FRAME_cr_pain10) {
      M_SetAnimation(self, insane_move_down, true);
      return;
    }
  }
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRAWL)) M_SetAnimation(self, insane_move_crawl, true);
  else if (frandom() <= 0.5) M_SetAnimation(self, insane_move_walk_normal, true);
  else M_SetAnimation(self, insane_move_walk_insane, true);
}
RegisterMonsterinfoWalk("insane_walk", insane_walk);

function insane_run(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_STAND_GROUND)) {
    // Hold Ground?
    if (self.s.frame === FRAME_cr_pain10) {
      M_SetAnimation(self, insane_move_down, true);
      return;
    }
  }
  if (
    SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRAWL) ||
    (self.s.frame >= FRAME_cr_pain2 && self.s.frame <= FRAME_cr_pain10) ||
    (self.s.frame >= FRAME_crawl1 && self.s.frame <= FRAME_crawl9) ||
    (self.s.frame >= FRAME_stand99 && self.s.frame <= FRAME_stand160)
  ) {
    // Crawling?
    M_SetAnimation(self, insane_move_runcrawl, true);
  } else if (frandom() <= 0.5) {
    // Else, mix it up
    M_SetAnimation(self, insane_move_run_normal, true);
  } else {
    M_SetAnimation(self, insane_move_run_insane, true);
  }
}
RegisterMonsterinfoRun("insane_run", insane_run);

const insane_pain = RegisterPain("insane_pain", (self: EdictT, _other: EdictT, _kick: number, _damage: number, _mod: ModT): void => {
  if (level.time < self.pain_debounce_time) return;

  self.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(3));

  const r = 1 + (brandom() ? 1 : 0);
  let l: number;
  if (self.health < 25) l = 25;
  else if (self.health < 50) l = 50;
  else if (self.health < 75) l = 75;
  else l = 100;
  gi.sound(self, CHAN_VOICE, gi.soundindex(`player/male/pain${l}_${r}.wav`), 1, ATTN_IDLE, 0);

  // Don't go into pain frames if crucified.
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRUCIFIED)) {
    M_SetAnimation(self, insane_move_struggle_cross, true);
    return;
  }

  if (
    (self.s.frame >= FRAME_crawl1 && self.s.frame <= FRAME_crawl9) ||
    (self.s.frame >= FRAME_stand99 && self.s.frame <= FRAME_stand160) ||
    (self.s.frame >= FRAME_stand1 && self.s.frame <= FRAME_stand40)
  ) {
    M_SetAnimation(self, insane_move_crawl_pain, true);
  } else {
    M_SetAnimation(self, insane_move_stand_pain, true);
  }
});

function insane_onground(self: EdictT): void {
  M_SetAnimation(self, insane_move_down, true);
}

function insane_checkdown(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_ALWAYS_STAND)) return; // Always stand
  if (frandom() < 0.3) {
    if (frandom() < 0.5) M_SetAnimation(self, insane_move_uptodown, true);
    else M_SetAnimation(self, insane_move_jumpdown, true);
  }
}

function insane_checkup(self: EdictT): void {
  // If Hold_Ground and Crawl are set
  if (SpawnFlags_has_all(self.spawnflags, SpawnFlags_or(SPAWNFLAG_INSANE_CRAWL, SPAWNFLAG_INSANE_STAND_GROUND))) return;
  if (frandom() < 0.5) M_SetAnimation(self, insane_move_downtoup, true);
}

function insane_stand(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRUCIFIED)) {
    // If crucified
    M_SetAnimation(self, insane_move_cross, true);
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
  } else if (SpawnFlags_has_all(self.spawnflags, SpawnFlags_or(SPAWNFLAG_INSANE_CRAWL, SPAWNFLAG_INSANE_STAND_GROUND))) {
    // If Hold_Ground and Crawl are set
    M_SetAnimation(self, insane_move_down, true);
  } else if (frandom() < 0.5) M_SetAnimation(self, insane_move_stand_normal, true);
  else M_SetAnimation(self, insane_move_stand_insane, true);
}
RegisterMonsterinfoStand("insane_stand", insane_stand);

function insane_dead(self: EdictT): void {
  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRUCIFIED)) {
    self.flags |= EntFlagsT.FL_FLY;
  } else {
    self.mins = vec3(-16, -16, -24);
    self.maxs = vec3(16, 16, -8);
    self.movetype = MovetypeT.MOVETYPE_TOSS;
  }
  monster_dead(self);
}

const insane_die = RegisterDie(
  "insane_die",
  (self: EdictT, _inflictor: EdictT, _attacker: EdictT, damage: number, _point: Vec3, mod: ModT): void => {
    if (M_CheckGib(self, mod)) {
      gi.sound(self, CHAN_VOICE, gi.soundindex("misc/udeath.wav"), 1, ATTN_IDLE, 0);
      const gibs: GibDefT[] = [
        { gibname: "models/objects/gibs/bone/tris.md2", count: 2 },
        { gibname: "models/objects/gibs/sm_meat/tris.md2", count: 4 },
        { gibname: "models/objects/gibs/head2/tris.md2", type: GibTypeT.GIB_HEAD },
      ];
      ThrowGibs(self, damage, gibs);
      self.deadflag = true;
      return;
    }

    if (self.deadflag) return;

    gi.sound(self, CHAN_VOICE, gi.soundindex(`player/male/death${irandom(1, 5)}.wav`), 1, ATTN_IDLE, 0);

    self.deadflag = true;
    self.takedamage = true;

    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRUCIFIED)) {
      insane_dead(self);
    } else {
      if (
        (self.s.frame >= FRAME_crawl1 && self.s.frame <= FRAME_crawl9) ||
        (self.s.frame >= FRAME_stand99 && self.s.frame <= FRAME_stand160)
      ) {
        M_SetAnimation(self, insane_move_crawl_death, true);
      } else {
        M_SetAnimation(self, insane_move_stand_death, true);
      }
    }
  },
);

// ---------------------------------------------------------------------------
// misc_insane (m_insane.cpp:619-692)
// ---------------------------------------------------------------------------

/**
 * QUAKED misc_insane (1 .5 0) (-16 -16 -24) (16 16 32) Ambush Trigger_Spawn
 * CRAWL CRUCIFIED STAND_GROUND ALWAYS_STAND QUIET
 */
export function SP_misc_insane(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  sound_fist = gi.soundindex("insane/insane11.wav");
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_QUIET)) {
    sound_shake = gi.soundindex("insane/insane5.wav");
    sound_moan = gi.soundindex("insane/insane7.wav");
    sound_scream[0] = gi.soundindex("insane/insane1.wav");
    sound_scream[1] = gi.soundindex("insane/insane2.wav");
    sound_scream[2] = gi.soundindex("insane/insane3.wav");
    sound_scream[3] = gi.soundindex("insane/insane4.wav");
    sound_scream[4] = gi.soundindex("insane/insane6.wav");
    sound_scream[5] = gi.soundindex("insane/insane8.wav");
    sound_scream[6] = gi.soundindex("insane/insane9.wav");
    sound_scream[7] = gi.soundindex("insane/insane10.wav");
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.s.modelindex = gi.modelindex("models/monsters/insane/tris.md2");

  self.mins = vec3(-16, -16, -24);
  self.maxs = vec3(16, 16, 32);

  self.health = Math.trunc(100 * st.health_multiplier);
  self.gib_health = -50;
  self.mass = 300;

  self.pain = insane_pain;
  self.die = insane_die;

  self.monsterinfo.stand = insane_stand;
  self.monsterinfo.walk = insane_walk;
  self.monsterinfo.run = insane_run;
  self.monsterinfo.dodge = null;
  self.monsterinfo.attack = null;
  self.monsterinfo.melee = null;
  self.monsterinfo.sight = null;
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_GOOD_GUY;

  gi.linkentity(self);

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_STAND_GROUND)) {
    // Stand Ground
    self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_STAND_GROUND;
  }

  M_SetAnimation(self, insane_move_stand_normal, true);

  self.monsterinfo.scale = MODEL_SCALE;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_INSANE_CRUCIFIED)) {
    // Crucified?
    self.flags |= EntFlagsT.FL_NO_KNOCKBACK | EntFlagsT.FL_STATIONARY;
    stationarymonster_start(self);
  } else {
    walkmonster_start(self);
  }

  self.s.skinnum = irandom(3);
}
