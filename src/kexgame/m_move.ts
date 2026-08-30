// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_move.c -- monster movement (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/m_move.cpp
// (1,502 lines, C++17): M_CheckBottom (+ its Fast/Slow_Generic halves),
// SV_movestep, the fly/swim movement family (SV_flystep/SV_alternate_flystep
// and their small helpers), M_ChangeYaw, SV_StepDirection, SV_FixCheckBottom,
// SV_NewChaseDir, SV_CloseEnough, the bot-pathing hooks (M_NavPathToGoal/
// M_MoveToPath), M_MoveToGoal, M_walkmove, and ai_check_move.
//
// BEHAVIORAL PORT: bug-for-bug fidelity per PORTING.md. Every genuine
// behavior difference from the legacy vanilla port (src/game/m_move.ts) is
// cited at its call site; this header collects the load-bearing ones.
//
// ============================================================================
// M_MoveFrame BOUNDARY FINDING
// ============================================================================
// The brief flagged this as needing verification: `M_MoveFrame` is NOT in
// m_move.cpp. Grepping quake2-rerelease-dll/rerelease/*.cpp confirms its only
// definition is g_monster.cpp:492 (called from g_monster.cpp:1001), with zero
// occurrences anywhere in m_move.cpp. It belongs to the future g_monster.ts
// unit, not this one -- correctly left untouched here.
//
// ============================================================================
// "KEX bbox cache" -- not present
// ============================================================================
// The brief hedged M_CheckBottom's description with "(with the KEX bbox
// cache if present)". No such cache exists anywhere in this source: the KEX
// rewrite splits the fast/slow halves into two free functions
// (`M_CheckBottom_Fast_Generic`/`M_CheckBottom_Slow_Generic`, both declared
// in g_local.h:2486-2487 and thus part of this file's public surface, ported
// as exported functions below) that `M_CheckBottom` itself composes -- no
// memoization, no per-entity cached result. Reporting the negative per the
// brief's own "verify" instruction.
//
// ============================================================================
// STUB INVENTORY -- cross-file dependencies
// ============================================================================
// g_ai.cpp (not yet a TS unit): `visible` (g_local.h:2307/g_ai.cpp:392),
// `FacingIdeal` (g_local.h:2308/g_ai.cpp:895), `FoundTarget`
// (g_local.h:2304/g_ai.cpp:484), `range_to` (g_local.h:2302/g_ai.cpp:380).
// Plain throwing stubs; none of this unit's own tests exercise the branches
// that reach them (see each stub's own comment for exactly which branch and
// why the test suite avoids it).
//
// rogue/g_rogue_newai.cpp (not yet a TS unit): `TargetTesla`
// (g_local.h:2572/line 1472) is a plain throwing stub, reached only when
// `CheckForBadArea` actually finds a "bad_area" entity -- this unit's tests
// never spawn one. `CheckForBadArea` itself (g_local.h:2559/line 1003) is
// ported for REAL instead of stubbed -- see its own comment below for why
// that's faithful and not a shortcut.
//
// g_monster.cpp (CONCURRENT unit, not yet landed as of this port round):
// `M_CheckGround` (g_local.h:2207/line 140) and `M_CatagorizePosition`
// (g_local.h:2204/line 190) are called UNCONDITIONALLY from SV_movestep's
// own body -- there is no way to reach a successful move, or exercise the
// water-refusal branch, while they throw. Per the brief's own concurrency
// note ("if you both stub each other's functions, use the throwing-stub
// pattern and the coordinator reconciles at commit"), these still throw BY
// DEFAULT; the only difference from a plain stub is a reassignable
// module-private binding plus an exported test-only setter, so this unit's
// OWN test file can substitute a minimal fake and exercise SV_movestep's/
// SV_flystep's own logic in isolation. See the "EXTERNAL DEPENDENCIES"
// comment above their definitions for the full rationale.
//
// ============================================================================
// EXPORTED BEYOND g_local.h's PUBLIC SURFACE
// ============================================================================
// g_local.h's "m_move.c" section (lines 2483-2493) declares exactly 8 public
// symbols: M_CheckBottom_Fast_Generic, M_CheckBottom_Slow_Generic,
// M_CheckBottom, SV_CloseEnough, M_walkmove, M_MoveToGoal, M_ChangeYaw,
// ai_check_move. Everything else in m_move.cpp is C++ file-scope (no header
// declaration) -- SV_movestep, SV_StepDirection, SV_FixCheckBottom,
// SV_NewChaseDir, M_MoveToPath, M_NavPathToGoal, SV_flystep,
// SV_alternate_flystep, G_IdealHoverPosition, IsBadAhead,
// SV_flystep_testvisposition. This port exports SV_movestep, SV_StepDirection,
// SV_FixCheckBottom, and SV_NewChaseDir anyway (kept module-private:
// M_MoveToPath, M_NavPathToGoal, the fly-step family, IsBadAhead,
// G_IdealHoverPosition) -- this mirrors g_phys.ts's own precedent, which
// exports SV_TestEntityPosition/SV_PushEntity/SV_Push/SV_Physics_Pusher/
// SV_Physics_None/SV_Physics_Noclip/SV_Physics_Toss/SV_Physics_Step despite
// none of them appearing in g_local.h's "g_phys.c" section either. Needed
// here specifically so this unit's test file can exercise SV_movestep's
// step/dropoff/water logic and SV_NewChaseDir's direction-preference order
// directly, the same way g_phys.ts's tests reach its own file-scope helpers.
//
// ============================================================================
// anglemod / LerpAngle -- kex's OWN copy, ported here (not q_std.ts)
// ============================================================================
// q_std.ts's own header explicitly defers porting kex's `anglemod`/
// `LerpAngle` (q_std.h:176-190, fmod-based -- NOT src/shared/math.ts's
// bit-truncation version already used by the legacy vanilla port) to
// "whichever kex unit needs kex's own copy". M_ChangeYaw/SV_NewChaseDir
// (anglemod) and SV_alternate_flystep's buzzard-pitch code (LerpAngle) are
// exactly that need. Since this unit's brief scopes files to m_move.ts + its
// test file only, both are ported here as file-local (unexported) helpers
// rather than promoted into q_std.ts; a future unit that also needs kex's
// copy should promote them there instead of writing a third copy.
//
// ============================================================================
// `new_bad` (m_move.cpp:9) -- file-scope C++ global with no external reader
// ============================================================================
// `edict_t *new_bad;` is declared at file scope ("used for communications
// out of sv_movestep to say what entity is blocking us") but grepping the
// whole quake2-rerelease-dll tree shows it is written in SV_movestep and
// read only two lines later, in the same function -- never from any other
// translation unit. Ported as an ordinary local variable inside SV_movestep
// instead of a module-level export; nothing observable changes.
//
// ============================================================================
// A FAITHFULLY-PORTED SOURCE BUG: SV_movestep's second startsolid retry
// ============================================================================
// m_move.cpp:689-693: when `fwd_trace.startsolid`, the C++ source mutates
// `start_up` (not `start_fwd`) by another step down, then re-traces from the
// UNCHANGED `start_fwd` -- so the mutation has no effect on the retraced
// result at all (this looks like a copy/paste of the `up_trace.startsolid`
// branch a few lines above, which correctly mutates `start_up` because that
// IS the trace origin being retried). Ported literally: the retry trace
// below uses the untouched `start_fwd`, and the `start_up` bump is dead
// code, exactly like the source.
//
// ============================================================================
// SV_alternate_flystep / G_IdealHoverPosition / IsBadAhead
// ============================================================================
// AI_ALTERNATE_FLY monsters' hover-position/steering logic
// (m_move.cpp:145-599) is ported in full (no cross-file stubs needed beyond
// `visible`, reached only when `fly_pinned` is set) but is not directly
// exercised by this unit's own test suite (module-private, reached only via
// SV_flystep when AI_ALTERNATE_FLY is set on the entity) -- the brief's test
// list asks for the plain FL_FLY/FL_SWIM path (SV_flystep's own i==0 enemy
// branch), which this test suite does cover.

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import {
  type KexEdictT,
  type PathRequest,
  ContentsT,
  SvflagsT,
  SolidT,
  WaterLevelT,
  MASK_MONSTERSOLID,
  MASK_SOLID,
  MASK_WATER,
  STEPSIZE,
  RenderfxT,
  PathFlags,
  PathReturnCode,
  CvarFlagsT,
} from "../kexapi/game";
import {
  type EdictT,
  MonsterAiFlagsT,
  EntFlagsT,
  MonsterAttackStateT,
  CombatStyleT,
  SPAWNFLAG_MONSTER_SUPER_STEP,
  RANGE_NEAR,
  random_time,
} from "./g_local";
import { M_CheckGround as RealM_CheckGround, M_CatagorizePosition as RealM_CatagorizePosition } from "./g_monster";
import { visible, FacingIdeal, FoundTarget, range_to } from "./g_ai";
import { gi, level, g_edicts } from "./g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_subtract, Gtime_scale, Gtime_from_ms, Gtime_from_sec, type GTime } from "./gtime";
import { SpawnFlags_has } from "./spawnflags";
import {
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_negate,
  vec3_scaled,
  vec3_length,
  vec3_lengthSquared,
  vec3_normalized,
  vec3_normalized_len,
  vec3_dot,
  vec3_any_nonzero,
  AngleVectors,
  AngleVectors_destructured,
  boxes_intersect,
  SlideClipVelocity,
  vectoyaw,
  vectoangles,
  slerp,
} from "./q_vec3";
import { YAW, PITCH, Q_PIf, frandom, crandom, brandom, irandom } from "./q_std";
import { G_TouchTriggers, G_TouchProjectiles } from "./g_utils";
import { G_Impact, G_GetClipMask } from "./g_phys";
import { TargetTesla, CheckForBadArea } from "./rogue/g_rogue_newai";

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/** `vec3_t x = y;` copy-construct from a persistent field -- Vec3 is a
 *  mutable Float32Array (reference type) in TS, so every "copy this field's
 *  current value" spot in the C++ source needs an explicit fresh allocation
 *  to avoid aliasing the live field. */
function copyVec3(v: Vec3): Vec3 {
  return vec3(v[0], v[1], v[2]);
}

/** EDICT_NUM idiom (PORTING.md): recovers the game-private EdictT from a
 *  trace's/BoxEdicts' engine-visible KexEdictT. A null `ent` (not set by the
 *  raw collision model) falls back to the world edict, matching gi.trace's
 *  own documented contract (see g_phys.ts's identical `traceEdict` helper). */
function edictFrom(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

/** See g_phys.ts's identical helper and its file header's
 *  "sv_maxvelocity/sv_gravity/sv_stopspeed" note -- no InitGame-equivalent
 *  has landed yet, so cvars are looked up per call instead of cached. */
function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

/** See g_phys.ts's identical `frameTimeAsGtime` helper and its file header's
 *  "FRAME_TIME_S" note -- no InitGame-set FRAME_TIME_S global exists yet. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/** q_std.h:185 -- kex's OWN anglemod (fmod-based). See this file's header
 *  ("anglemod / LerpAngle") for why this lives here instead of q_std.ts.
 *  JS's `%` matches C's `fmod` sign behavior for finite operands, so this is
 *  a direct transliteration, not an approximation. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** q_std.h:176 -- kex's OWN LerpAngle. See this file's header for placement. */
function LerpAngle(a2: number, a1In: number, frac: number): number {
  let a1 = a1In;
  if (a1 - a2 > 180) a1 -= 360;
  if (a1 - a2 < -180) a1 += 360;
  return a2 + frac * (a1 - a2);
}

// ---------------------------------------------------------------------------
// EXTERNAL DEPENDENCIES NOT YET PORTED (g_ai.cpp)
// ---------------------------------------------------------------------------
// See this file's header ("STUB INVENTORY") for the reached-branch analysis
// backing "this unit's tests don't exercise these":
//   - `visible`: only reached from SV_alternate_flystep when fly_pinned is
//     set (not exercised -- see "SV_alternate_flystep" header note) and from
//     M_MoveToPath/SV_movestep's tesla-block, both gated on `ent.enemy`
//     being set, which this unit's SV_NewChaseDir/M_MoveToGoal tests never
//     do (they chase a bare goalentity, not an enemy).
//   - `FacingIdeal`: only reached from SV_StepDirection when classname does
//     NOT start with "monster_widow" (m_move.cpp:994) -- this unit's tests
//     that route through SV_StepDirection use that classname to take the
//     legitimate bypass branch instead of adding a mock.
//   - `FoundTarget`: only reached when `ent.bad_area` was already non-null
//     on entry (the "no longer in a bad area" recovery branch) -- never true
//     for a freshly-constructed test fixture.
//   - `range_to`: only reached from M_MoveToPath after its own `!self.enemy`
//     early-out, which every test fixture here takes instead.

// (g_ai.ts landed -- the four former throwing stubs are now real imports;
// see the import at the top of the file.)

// ---------------------------------------------------------------------------
// TargetTesla / CheckForBadArea (rogue/g_rogue_newai.cpp:1472, 1003-1013) --
// now real imports from "./rogue/g_rogue_newai"
// ---------------------------------------------------------------------------
// TargetTesla was a local throwing stub. CheckForBadArea was ported here as
// a faithful, forward-compatible substitute using a `classname ===
// "bad_area"` check (since `badarea_touch` didn't exist as a value anywhere
// in this port yet -- the real body's `hit->touch == badarea_touch`
// function-pointer identity check had no TS analogue at the time). Now that
// rogue/g_rogue_newai.ts has landed with a real `badarea_touch` and the
// real touch-identity-based `CheckForBadArea`, both are real imports from
// there instead of the local substitute/stub above.

// ---------------------------------------------------------------------------
// EXTERNAL DEPENDENCIES NOT YET PORTED (g_monster.cpp -- concurrent unit)
// ---------------------------------------------------------------------------
// See this file's header ("STUB INVENTORY") for the full rationale: both are
// called unconditionally from SV_movestep's own body, so a plain throwing
// stub would make the successful-move and water-refusal paths untestable.
// Each gets a reassignable module-private binding plus an exported
// test-only setter; production code never calls the setter.

// Default = the real g_monster.ts implementation; the test-only setter
// below still lets fixtures inject fakes.
let M_CheckGroundImpl: (ent: EdictT, mask: ContentsT) => void = RealM_CheckGround;

function M_CheckGround(ent: EdictT, mask: ContentsT): void {
  M_CheckGroundImpl(ent, mask);
}

/** TEST-ONLY SEAM -- see the "EXTERNAL DEPENDENCIES" comment above.
 *  Production code must never call this. */
export function __setM_CheckGroundForTests(fn: (ent: EdictT, mask: ContentsT) => void): void {
  M_CheckGroundImpl = fn;
}

let M_CatagorizePositionImpl: (self: EdictT, in_point: Vec3) => { waterlevel: WaterLevelT; watertype: ContentsT } =
  RealM_CatagorizePosition;

function M_CatagorizePosition(self: EdictT, in_point: Vec3): { waterlevel: WaterLevelT; watertype: ContentsT } {
  return M_CatagorizePositionImpl(self, in_point);
}

/** TEST-ONLY SEAM -- see the "EXTERNAL DEPENDENCIES" comment above.
 *  Production code must never call this. */
export function __setM_CatagorizePositionForTests(
  fn: (self: EdictT, in_point: Vec3) => { waterlevel: WaterLevelT; watertype: ContentsT },
): void {
  M_CatagorizePositionImpl = fn;
}

// ---------------------------------------------------------------------------
// M_CheckBottom (m_move.cpp:11-141)
// ---------------------------------------------------------------------------

/**
 * m_move.cpp:20-41. If every corner point straight down (or up, for
 * inverted gravity) from the bbox is solid world, the entity is trivially
 * standing on solid ground -- skip the more expensive quadrant traces.
 */
export function M_CheckBottom_Fast_Generic(absmins: Vec3, absmaxs: Vec3, ceiling: boolean): boolean {
  const start = vec3();
  start[2] = ceiling ? absmaxs[2] + 1 : absmins[2] - 1;

  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      start[0] = x ? absmaxs[0] : absmins[0];
      start[1] = y ? absmaxs[1] : absmins[1];
      if (gi.pointcontents(start) !== ContentsT.CONTENTS_SOLID) return false;
    }
  }

  return true;
}

/**
 * m_move.cpp:43-129. The real check: a trace straight down from the
 * midpoint, then one trace per bbox quadrant, each of which must land
 * within STEPSIZE of the midpoint's landing height (or the entity is
 * considered to be hanging off an edge that isn't a staircase).
 * `allow_any_step_height` ([Paril-KEX], SPAWNFLAG_MONSTER_SUPER_STEP) skips
 * the quadrant checks entirely once the midpoint trace lands anywhere.
 */
export function M_CheckBottom_Slow_Generic(
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
  ignore: EdictT,
  mask: ContentsT,
  ceiling: boolean,
  allow_any_step_height: boolean,
): boolean {
  const stepQuadrantSize = vec3_muls(vec3_sub(maxs, mins), 0.5);
  stepQuadrantSize[2] = 0;
  const halfStepQuadrant = vec3_muls(stepQuadrantSize, 0.5);
  const halfStepQuadrantMins = vec3_negate(halfStepQuadrant);

  const start = vec3(origin[0], origin[1], 0);
  const stop = vec3(origin[0], origin[1], 0);

  if (!ceiling) {
    start[2] = origin[2] + mins[2];
    stop[2] = start[2] - STEPSIZE * 2;
  } else {
    start[2] = origin[2] + maxs[2];
    stop[2] = start[2] + STEPSIZE * 2;
  }

  const minsNoZ = vec3(mins[0], mins[1], 0);
  const maxsNoZ = vec3(maxs[0], maxs[1], 0);

  let trace = gi.trace(start, minsNoZ, maxsNoZ, stop, ignore, mask);

  if (trace.fraction === 1.0) return false;

  if (allow_any_step_height) return true;

  start[0] = origin[0] + (mins[0] + maxs[0]) * 0.5;
  stop[0] = start[0];
  start[1] = origin[1] + (mins[1] + maxs[1]) * 0.5;
  stop[1] = start[1];

  const mid = trace.endpos[2];

  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      const quadrantStart = copyVec3(start);
      quadrantStart[0] += x ? halfStepQuadrant[0] : -halfStepQuadrant[0];
      quadrantStart[1] += y ? halfStepQuadrant[1] : -halfStepQuadrant[1];

      const quadrantEnd = vec3(quadrantStart[0], quadrantStart[1], stop[2]);

      trace = gi.trace(quadrantStart, halfStepQuadrantMins, halfStepQuadrant, quadrantEnd, ignore, mask);

      if (ceiling) {
        if (trace.fraction === 1.0 || trace.endpos[2] - mid > STEPSIZE) return false;
      } else {
        if (trace.fraction === 1.0 || mid - trace.endpos[2] > STEPSIZE) return false;
      }
    }
  }

  return true;
}

/** m_move.cpp:131-141. Returns false if any part of the bottom of the
 *  entity is off an edge that is not a staircase. */
export function M_CheckBottom(ent: EdictT): boolean {
  const absmins = vec3_add(ent.s.origin, ent.mins);
  const absmaxs = vec3_add(ent.s.origin, ent.maxs);

  if (M_CheckBottom_Fast_Generic(absmins, absmaxs, ent.gravityVector[2] > 0)) return true;

  const mask: ContentsT =
    (ent.svflags & SvflagsT.SVF_MONSTER) !== 0
      ? MASK_MONSTERSOLID
      : MASK_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;

  return M_CheckBottom_Slow_Generic(
    ent.s.origin,
    ent.mins,
    ent.maxs,
    ent,
    mask,
    ent.gravityVector[2] > 0,
    SpawnFlags_has(ent.spawnflags, SPAWNFLAG_MONSTER_SUPER_STEP),
  );
}

// ---------------------------------------------------------------------------
// IsBadAhead (m_move.cpp:145-169) -- ROGUE
// ---------------------------------------------------------------------------

/** Recomputes AngleVectors twice for the same `self.s.angles` -- a faithfully
 *  ported redundancy from the C++ source (m_move.cpp:156,160), not a bug
 *  introduced here. */
function IsBadAhead(self: EdictT, bad: EdictT, move: Vec3): boolean {
  const dir = vec3_normalized(vec3_sub(bad.s.origin, self.s.origin));
  const forward1 = vec3();
  AngleVectors(self.s.angles, forward1, null, null);
  const dpBad = vec3_dot(forward1, dir);

  const moveCopy = vec3_normalized(move);
  const forward2 = vec3();
  AngleVectors(self.s.angles, forward2, null, null);
  const dpMove = vec3_dot(forward2, moveCopy);

  if (dpBad < 0 && dpMove < 0) return true;
  if (dpBad > 0 && dpMove > 0) return true;

  return false;
}

// ---------------------------------------------------------------------------
// G_IdealHoverPosition (m_move.cpp:171-196) -- static
// ---------------------------------------------------------------------------

function G_IdealHoverPosition(ent: EdictT): Vec3 {
  if (
    (!ent.enemy && (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) === 0n) ||
    (ent.monsterinfo.aiflags &
      (MonsterAiFlagsT.AI_COMBAT_POINT | MonsterAiFlagsT.AI_SOUND_TARGET | MonsterAiFlagsT.AI_HINT_PATH | MonsterAiFlagsT.AI_PATHING)) !==
      0n
  ) {
    return vec3(0, 0, 0); // go right for the center
  }

  const theta = frandom(2 * Q_PIf);
  let phi: number;

  // buzzards pick half sphere
  if (ent.monsterinfo.fly_above) {
    phi = Math.acos(0.7 + frandom(0.3));
  } else if (ent.monsterinfo.fly_buzzard || (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    phi = Math.acos(frandom());
  } else {
    // non-buzzards pick a level around the center
    phi = Math.acos(crandom() * 0.06);
  }

  const d = vec3(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta), Math.cos(phi));

  return vec3_muls(d, frandom(ent.monsterinfo.fly_min_distance, ent.monsterinfo.fly_max_distance));
}

// ---------------------------------------------------------------------------
// SV_flystep_testvisposition (m_move.cpp:198-211) -- static
// ---------------------------------------------------------------------------

function SV_flystep_testvisposition(start: Vec3, end: Vec3, starta: Vec3, startb: Vec3, ent: EdictT): boolean {
  const tr = gi.trace(start, null, null, end, ent, MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP);

  if (tr.fraction === 1.0) {
    const tr2 = gi.trace(starta, ent.mins, ent.maxs, startb, ent, MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP);
    if (tr2.fraction === 1.0) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// SV_alternate_flystep (m_move.cpp:213-440) -- static, ROGUE/[Paril-KEX]
// ---------------------------------------------------------------------------

function SV_alternate_flystep(ent: EdictT, _move: Vec3, _relink: boolean, _current_bad: EdictT | null): boolean {
  // swimming monsters just follow their velocity in the air
  if ((ent.flags & EntFlagsT.FL_SWIM) !== 0n && ent.waterlevel < WaterLevelT.WATER_UNDER) return true;

  if (
    ent.monsterinfo.fly_position_time <= level.time ||
    (ent.enemy !== null && ent.monsterinfo.fly_pinned && !visible(ent, ent.enemy, true))
  ) {
    ent.monsterinfo.fly_pinned = false;
    ent.monsterinfo.fly_position_time = Gtime_add(level.time, random_time(Gtime_from_sec(3), Gtime_from_sec(10)));
    ent.monsterinfo.fly_ideal_position = G_IdealHoverPosition(ent);
  }

  let towardsOrigin = vec3();
  let towardsVelocity = vec3();

  const { vec: dir, len: currentSpeedInit } = vec3_normalized_len(ent.velocity);
  let currentSpeed = currentSpeedInit;

  if (Number.isNaN(dir[0]) || Number.isNaN(dir[1]) || Number.isNaN(dir[2])) return false;

  if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) !== 0n) {
    towardsOrigin =
      ent.monsterinfo.nav_path.returnCode === PathReturnCode.TraversalPending
        ? copyVec3(ent.monsterinfo.nav_path.secondMovePoint)
        : copyVec3(ent.monsterinfo.nav_path.firstMovePoint);
  } else if (
    ent.enemy !== null &&
    (ent.monsterinfo.aiflags &
      (MonsterAiFlagsT.AI_COMBAT_POINT | MonsterAiFlagsT.AI_SOUND_TARGET | MonsterAiFlagsT.AI_LOST_SIGHT)) ===
      0n
  ) {
    towardsOrigin = copyVec3(ent.enemy.s.origin);
    towardsVelocity = copyVec3(ent.enemy.velocity);
  } else if (ent.goalentity !== null) {
    towardsOrigin = copyVec3(ent.goalentity.s.origin);
  } else {
    // what we're going towards probably died or something
    if (currentSpeed !== 0) {
      if (currentSpeed > 0) currentSpeed = Math.max(0, currentSpeed - ent.monsterinfo.fly_acceleration);
      else if (currentSpeed < 0) currentSpeed = Math.min(0, currentSpeed + ent.monsterinfo.fly_acceleration);

      VectorCopy(vec3_muls(dir, currentSpeed), ent.velocity);
    }

    return true;
  }

  let wantedPos: Vec3;

  if (ent.monsterinfo.fly_pinned) {
    wantedPos = copyVec3(ent.monsterinfo.fly_ideal_position);
  } else if (
    (ent.monsterinfo.aiflags &
      (MonsterAiFlagsT.AI_PATHING | MonsterAiFlagsT.AI_COMBAT_POINT | MonsterAiFlagsT.AI_SOUND_TARGET | MonsterAiFlagsT.AI_LOST_SIGHT)) !==
    0n
  ) {
    wantedPos = copyVec3(towardsOrigin);
  } else {
    wantedPos = vec3_add(vec3_add(towardsOrigin, vec3_muls(towardsVelocity, 0.25)), ent.monsterinfo.fly_ideal_position);
  }

  // find a place we can fit in from here
  const fitTrace = gi.trace(
    towardsOrigin,
    vec3(-8, -8, -8),
    vec3(8, 8, 8),
    wantedPos,
    ent,
    MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP,
  );

  if (!fitTrace.allsolid) wantedPos = copyVec3(fitTrace.endpos);

  const destDiff = vec3_sub(wantedPos, ent.s.origin);

  if (destDiff[2] > ent.mins[2] && destDiff[2] < ent.maxs[2]) destDiff[2] = 0;

  const { vec: wantedDirInit, len: distToWanted } = vec3_normalized_len(destDiff);
  let wantedDir = wantedDirInit;

  if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) === 0n) {
    ent.ideal_yaw = vectoyaw(vec3_normalized(vec3_sub(towardsOrigin, ent.s.origin)));
  }

  // check if we're blocked from moving this way from where we are
  const blockTrace = gi.trace(
    ent.s.origin,
    ent.mins,
    ent.maxs,
    vec3_add(ent.s.origin, vec3_muls(wantedDir, ent.monsterinfo.fly_acceleration)),
    ent,
    MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP,
  );

  const yawAngles = vec3(0, ent.s.angles[YAW], 0);
  const aimFwd = vec3();
  const aimRgt = vec3();
  const aimUp = vec3();
  AngleVectors(yawAngles, aimFwd, aimRgt, aimUp);

  // it's a fairly close block, so we may want to shift more dramatically
  if (blockTrace.fraction < 0.25) {
    const bottomVisible = SV_flystep_testvisposition(
      vec3_add(ent.s.origin, vec3(0, 0, ent.mins[2])),
      wantedPos,
      ent.s.origin,
      vec3_add(ent.s.origin, vec3(0, 0, ent.mins[2] - ent.monsterinfo.fly_acceleration)),
      ent,
    );
    const topVisible = SV_flystep_testvisposition(
      vec3_add(ent.s.origin, vec3(0, 0, ent.maxs[2])),
      wantedPos,
      ent.s.origin,
      vec3_add(ent.s.origin, vec3(0, 0, ent.maxs[2] + ent.monsterinfo.fly_acceleration)),
      ent,
    );

    // top & bottom are same, so we need to try right/left
    if (bottomVisible === topVisible) {
      const leftStart = vec3_sub(vec3_add(ent.s.origin, vec3_scaled(aimFwd, ent.maxs)), vec3_scaled(aimRgt, ent.maxs));
      const rightStart = vec3_add(vec3_add(ent.s.origin, vec3_scaled(aimFwd, ent.maxs)), vec3_scaled(aimRgt, ent.maxs));

      const leftVisible =
        gi.trace(leftStart, null, null, wantedPos, ent, MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP).fraction === 1.0;
      const rightVisible =
        gi.trace(rightStart, null, null, wantedPos, ent, MASK_SOLID | ContentsT.CONTENTS_MONSTERCLIP).fraction === 1.0;

      if (leftVisible !== rightVisible) {
        wantedDir = rightVisible ? vec3_add(wantedDir, aimRgt) : vec3_sub(wantedDir, aimRgt);
      } else {
        // we're probably stuck, push us directly away
        wantedDir = copyVec3(blockTrace.plane.normal);
      }
    } else {
      wantedDir = topVisible ? vec3_add(wantedDir, aimUp) : vec3_sub(wantedDir, aimUp);
    }

    wantedDir = vec3_normalized(wantedDir);
  }

  // the closer we are to zero, the more we can change dir.
  // if we're pushed past our max speed we shouldn't turn at all.
  let turnFactor: number;

  const thrustersEngaged =
    (ent.monsterinfo.fly_thrusters && !ent.monsterinfo.fly_pinned) ||
    (ent.monsterinfo.aiflags & (MonsterAiFlagsT.AI_PATHING | MonsterAiFlagsT.AI_COMBAT_POINT | MonsterAiFlagsT.AI_LOST_SIGHT)) !== 0n;

  if (thrustersEngaged && vec3_dot(dir, wantedDir) > 0.0) {
    turnFactor = 0.45;
  } else {
    turnFactor = Math.min(1, 0.84 + 0.08 * (currentSpeed / ent.monsterinfo.fly_speed));
  }

  let finalDir = vec3_any_nonzero(dir) ? dir : wantedDir;

  if (Number.isNaN(finalDir[0]) || Number.isNaN(finalDir[1]) || Number.isNaN(finalDir[2])) return false;

  // swimming monsters don't exit water voluntarily, and flying monsters
  // don't enter water voluntarily (but will try to leave it)
  let badMovementDirection = false;

  if ((ent.flags & EntFlagsT.FL_SWIM) !== 0n) {
    badMovementDirection = (gi.pointcontents(vec3_add(ent.s.origin, vec3_muls(wantedDir, currentSpeed))) & ContentsT.CONTENTS_WATER) === 0;
  } else if ((ent.flags & EntFlagsT.FL_FLY) !== 0n && ent.waterlevel < WaterLevelT.WATER_UNDER) {
    badMovementDirection = (gi.pointcontents(vec3_add(ent.s.origin, vec3_muls(wantedDir, currentSpeed))) & ContentsT.CONTENTS_WATER) !== 0;
  }

  if (badMovementDirection) {
    if (ent.monsterinfo.fly_recovery_time < level.time) {
      ent.monsterinfo.fly_recovery_dir = vec3_normalized(vec3(crandom(), crandom(), crandom()));
      ent.monsterinfo.fly_recovery_time = Gtime_add(level.time, Gtime_from_sec(1));
    }

    wantedDir = copyVec3(ent.monsterinfo.fly_recovery_dir);
  }

  if (vec3_any_nonzero(dir) && turnFactor > 0) {
    finalDir = vec3_normalized(slerp(dir, wantedDir, 1.0 - turnFactor));
  }

  // the closer we are to the wanted position, we want to slow down so we
  // don't fly past it.
  let speedFactor: number;

  if (
    !ent.enemy ||
    (ent.monsterinfo.fly_thrusters && !ent.monsterinfo.fly_pinned) ||
    (ent.monsterinfo.aiflags & (MonsterAiFlagsT.AI_PATHING | MonsterAiFlagsT.AI_COMBAT_POINT | MonsterAiFlagsT.AI_LOST_SIGHT)) !== 0n
  ) {
    speedFactor = 1.0;
  } else if (vec3_dot(aimFwd, wantedDir) < -0.25 && vec3_any_nonzero(dir)) {
    speedFactor = 0.0;
  } else {
    speedFactor = Math.min(1, distToWanted / ent.monsterinfo.fly_speed);
  }

  if (badMovementDirection) speedFactor = -speedFactor;

  let accel = ent.monsterinfo.fly_acceleration;

  // if we're flying away from our destination, apply reverse thrusters
  if (vec3_dot(finalDir, wantedDir) < 0.25) accel *= 2.0;

  let wantedSpeed = ent.monsterinfo.fly_speed * speedFactor;

  if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_MANUAL_STEERING) !== 0n) wantedSpeed = 0;

  // change speed
  if (currentSpeed > wantedSpeed) currentSpeed = Math.max(wantedSpeed, currentSpeed - accel);
  else if (currentSpeed < wantedSpeed) currentSpeed = Math.min(wantedSpeed, currentSpeed + accel);

  if (
    Number.isNaN(finalDir[0]) ||
    Number.isNaN(finalDir[1]) ||
    Number.isNaN(finalDir[2]) ||
    Number.isNaN(currentSpeed)
  ) {
    return false;
  }

  // commit
  VectorCopy(vec3_muls(finalDir, currentSpeed), ent.velocity);

  // for buzzards, set their pitch
  if (ent.enemy && (ent.monsterinfo.fly_buzzard || (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n)) {
    const d = vec3_normalized(vec3_sub(ent.s.origin, towardsOrigin));
    const dAngles = vectoangles(d);
    ent.s.angles[PITCH] = LerpAngle(ent.s.angles[PITCH], -dAngles[PITCH], gi.frame_time_s * 4.0);
  } else {
    ent.s.angles[PITCH] = 0;
  }

  return true;
}

// ---------------------------------------------------------------------------
// SV_flystep (m_move.cpp:443-599) -- static; flying monsters don't step up
// ---------------------------------------------------------------------------

function SV_flystep(ent: EdictT, move: Vec3, relink: boolean, current_bad: EdictT | null): boolean {
  if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n) {
    if (SV_alternate_flystep(ent, move, relink, current_bad)) return true;
  }

  const oldorg = copyVec3(ent.s.origin);

  // fixme: move to monsterinfo -- we want the carrier to stay a certain
  // distance off the ground, to help prevent him from shooting his fliers,
  // who spawn in below him
  const minheight = ent.classname === "monster_carrier" ? 104 : 40;

  // try one move with vertical motion, then one without
  for (let i = 0; i < 2; i++) {
    let newMove = copyVec3(move);

    if (i === 0 && ent.enemy) {
      if (!ent.goalentity) ent.goalentity = ent.enemy;

      const goalPosition =
        (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_PATHING) !== 0n
          ? ent.monsterinfo.nav_path.firstMovePoint
          : ent.goalentity.s.origin;

      const dz = ent.s.origin[2] - goalPosition[2];
      const dist = vec3_length(move);

      if (ent.goalentity.client) {
        if (dz > minheight) {
          newMove = vec3_muls(newMove, 0.5);
          newMove[2] -= dist;
        }
        if (!((ent.flags & EntFlagsT.FL_SWIM) !== 0n && ent.waterlevel < WaterLevelT.WATER_WAIST)) {
          if (dz < minheight - 10) {
            newMove = vec3_muls(newMove, 0.5);
            newMove[2] += dist;
          }
        }
      } else {
        // RAFAEL
        if (ent.classname === "monster_fixbot") {
          if (ent.s.frame >= 105 && ent.s.frame <= 120) {
            if (dz > 12) newMove[2]--;
            else if (dz < -12) newMove[2]++;
          } else if (ent.s.frame >= 31 && ent.s.frame <= 88) {
            if (dz > 12) newMove[2] -= 12;
            else if (dz < -12) newMove[2] += 12;
          } else {
            if (dz > 12) newMove[2] -= 8;
            else if (dz < -12) newMove[2] += 8;
          }
        } else {
          if (dz > 0) {
            newMove = vec3_muls(newMove, 0.5);
            newMove[2] -= Math.min(dist, dz);
          } else if (dz < 0) {
            newMove = vec3_muls(newMove, 0.5);
            newMove[2] += -Math.max(-dist, dz);
          }
        }
      }
    }

    const neworg = vec3_add(ent.s.origin, newMove);
    const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, neworg, ent, MASK_MONSTERSOLID);

    // fly monsters don't enter water voluntarily
    if ((ent.flags & EntFlagsT.FL_FLY) !== 0n) {
      if (!ent.waterlevel) {
        const test = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2] + ent.mins[2] + 1);
        if ((gi.pointcontents(test) & MASK_WATER) !== 0) return false;
      }
    }

    // swim monsters don't exit water voluntarily
    if ((ent.flags & EntFlagsT.FL_SWIM) !== 0n) {
      if (ent.waterlevel < WaterLevelT.WATER_WAIST) {
        const test = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2] + ent.mins[2] + 1);
        if ((gi.pointcontents(test) & MASK_WATER) === 0) return false;
      }
    }

    if (trace.fraction === 1 && !trace.allsolid && !trace.startsolid) {
      VectorCopy(trace.endpos, ent.s.origin);

      if (!current_bad && CheckForBadArea(ent)) {
        VectorCopy(oldorg, ent.s.origin);
      } else {
        if (relink) {
          gi.linkentity(ent);
          G_TouchTriggers(ent);
        }
        return true;
      }
    }

    G_Impact(ent, trace);

    if (!ent.enemy) break;
  }

  return false;
}

// ---------------------------------------------------------------------------
// SV_movestep (m_move.cpp:601-885, exported beyond g_local.h -- see header)
// ---------------------------------------------------------------------------

/**
 * Called by monster program code. The move will be adjusted for slopes and
 * stairs, but if the move isn't possible, no move is done and false is
 * returned.
 */
export function SV_movestep(ent: EdictT, moveIn: Vec3, relink: boolean): boolean {
  let move = moveIn;

  // PMM - who cares about bad areas if you're dead?
  let current_bad: EdictT | null = null;

  if (ent.health > 0) {
    current_bad = CheckForBadArea(ent);
    if (current_bad) {
      ent.bad_area = current_bad;

      if (ent.enemy && ent.enemy.classname === "tesla_mine") {
        // if the tesla is in front of us, back up...
        if (IsBadAhead(ent, current_bad, move)) move = vec3_muls(move, -1);
      }
    } else if (ent.bad_area) {
      // if we're no longer in a bad area, get back to business.
      ent.bad_area = null;
      if (ent.oldenemy) {
        ent.enemy = ent.oldenemy;
        ent.goalentity = ent.oldenemy;
        FoundTarget(ent);
      }
    }
  }

  // flying monsters don't step up
  if ((ent.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) !== 0n) {
    return SV_flystep(ent, move, relink, current_bad);
  }

  // try the move
  const oldorg = copyVec3(ent.s.origin);

  // push down from a step height above the wished position
  let stepsize: number;
  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_MONSTER_SUPER_STEP) && ent.health > 0) {
    stepsize = 64;
  } else if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_NOSTEP) === 0n) {
    stepsize = STEPSIZE;
  } else {
    stepsize = 1;
  }
  stepsize += 0.75;

  const mask: ContentsT =
    (ent.svflags & SvflagsT.SVF_MONSTER) !== 0
      ? MASK_MONSTERSOLID
      : MASK_SOLID | ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER;

  let start_up = vec3_add(oldorg, vec3_muls(ent.gravityVector, -1 * stepsize));
  start_up = copyVec3(gi.trace(oldorg, ent.mins, ent.maxs, start_up, ent, mask).endpos);

  const end_up = vec3_add(start_up, move);

  let up_trace = gi.trace(start_up, ent.mins, ent.maxs, end_up, ent, mask);

  if (up_trace.startsolid) {
    start_up = vec3_add(start_up, vec3_muls(ent.gravityVector, -1 * stepsize));
    up_trace = gi.trace(start_up, ent.mins, ent.maxs, end_up, ent, mask);
  }

  const start_fwd = copyVec3(oldorg);
  const end_fwd = vec3_add(start_fwd, move);

  let fwd_trace = gi.trace(start_fwd, ent.mins, ent.maxs, end_fwd, ent, mask);

  if (fwd_trace.startsolid) {
    // Faithfully ported source bug -- see this file's header
    // ("A FAITHFULLY-PORTED SOURCE BUG"): mutating `start_up` here has no
    // effect on this retrace, which still reads from the unchanged
    // `start_fwd`. Not fixed; matches m_move.cpp:691-692 exactly.
    start_up = vec3_add(start_up, vec3_muls(ent.gravityVector, -1 * stepsize));
    fwd_trace = gi.trace(start_fwd, ent.mins, ent.maxs, end_fwd, ent, mask);
  }

  // pick the one that went farther
  const chosen_forward = up_trace.fraction > fwd_trace.fraction ? up_trace : fwd_trace;

  if (chosen_forward.startsolid || chosen_forward.allsolid) return false;

  let steps = 1;
  let stepped = false;

  if (up_trace.fraction > fwd_trace.fraction) steps = 2;

  // step us down
  const end = vec3_add(chosen_forward.endpos, vec3_muls(ent.gravityVector, steps * stepsize));
  const trace = gi.trace(chosen_forward.endpos, ent.mins, ent.maxs, end, ent, mask);

  if (Math.abs(ent.s.origin[2] - trace.endpos[2]) > 8) stepped = true;

  // Paril: improved the water handling here. monsters are okay with
  // stepping into water up to their waist.
  if (ent.waterlevel <= WaterLevelT.WATER_WAIST) {
    const { waterlevel: end_waterlevel, watertype: end_watertype } = M_CatagorizePosition(ent, trace.endpos);

    // don't go into deep liquids or slime/lava voluntarily
    if ((end_watertype & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0 || end_waterlevel > WaterLevelT.WATER_WAIST) {
      return false;
    }
  }

  if (trace.fraction === 1) {
    // if monster had the ground pulled out, go ahead and fall
    if ((ent.flags & EntFlagsT.FL_PARTIALGROUND) !== 0n) {
      VectorCopy(vec3_add(ent.s.origin, move), ent.s.origin);
      if (relink) {
        gi.linkentity(ent);
        G_TouchTriggers(ent);
      }
      ent.groundentity = null;
      return true;
    }
    // [Paril-KEX] allow dead monsters to "fall" off of edges in their death animation
    else if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_MONSTER_SUPER_STEP) && ent.health > 0) {
      return false; // walked off an edge
    }
  }

  // [Paril-KEX] if we didn't move at all (or barely moved), don't count it
  if (vec3_length(vec3_sub(trace.endpos, oldorg)) < vec3_length(move) * 0.05) {
    ent.monsterinfo.bad_move_time = Gtime_add(level.time, Gtime_from_ms(1000));

    if (ent.monsterinfo.bump_time < level.time && chosen_forward.fraction < 1.0) {
      // adjust ideal_yaw to move against the object we hit and try again
      const dir = SlideClipVelocity(
        AngleVectors_destructured(vec3(0, ent.ideal_yaw, 0)).forward,
        chosen_forward.plane.normal,
        1.0,
      );
      const new_yaw = vectoyaw(dir);

      if (vec3_lengthSquared(dir) > 0.1 && ent.ideal_yaw !== new_yaw) {
        ent.ideal_yaw = new_yaw;
        ent.monsterinfo.random_change_time = Gtime_add(level.time, Gtime_from_ms(100));
        ent.monsterinfo.bump_time = Gtime_add(level.time, Gtime_from_ms(200));
        return true;
      }
    }

    return false;
  }

  // check point traces down for dangling corners
  VectorCopy(trace.endpos, ent.s.origin);

  // PMM - don't bother with bad areas if we're dead
  if (ent.health > 0) {
    // use AI_BLOCKED to tell the calling layer that we're now mad at a tesla
    const new_bad = CheckForBadArea(ent);
    if (!current_bad && new_bad) {
      if (new_bad.owner) {
        if (new_bad.owner.classname === "tesla_mine") {
          if (!ent.enemy || !ent.enemy.inuse) {
            TargetTesla(ent, new_bad.owner);
            ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
          } else if (ent.enemy.classname === "tesla_mine") {
            // matches the C++ source's empty else-if body
          } else if (ent.enemy && ent.enemy.client) {
            if (!visible(ent, ent.enemy, true)) {
              TargetTesla(ent, new_bad.owner);
              ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
            }
          } else {
            TargetTesla(ent, new_bad.owner);
            ent.monsterinfo.aiflags |= MonsterAiFlagsT.AI_BLOCKED;
          }
        }
      }

      VectorCopy(oldorg, ent.s.origin);
      return false;
    }
  }

  if (!M_CheckBottom(ent)) {
    // entity had floor mostly pulled out from underneath it and is trying
    // to correct
    if ((ent.flags & EntFlagsT.FL_PARTIALGROUND) !== 0n) {
      if (relink) {
        gi.linkentity(ent);
        G_TouchTriggers(ent);
      }
      return true;
    }

    // walked off an edge that wasn't a stairway
    VectorCopy(oldorg, ent.s.origin);
    return false;
  }

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_MONSTER_SUPER_STEP) && ent.health > 0) {
    if (!ent.groundentity || ent.groundentity.solid === SolidT.SOLID_BSP) {
      if (edictFrom(trace.ent).solid !== SolidT.SOLID_BSP) {
        // walked off an edge
        VectorCopy(oldorg, ent.s.origin);
        M_CheckGround(ent, G_GetClipMask(ent));
        return false;
      }
    }
  }

  // [Paril-KEX]
  M_CheckGround(ent, G_GetClipMask(ent));

  if (!ent.groundentity) {
    // walked off an edge
    VectorCopy(oldorg, ent.s.origin);
    M_CheckGround(ent, G_GetClipMask(ent));
    return false;
  }

  if ((ent.flags & EntFlagsT.FL_PARTIALGROUND) !== 0n) {
    ent.flags &= ~EntFlagsT.FL_PARTIALGROUND;
  }
  ent.groundentity = edictFrom(trace.ent);
  ent.groundentity_linkcount = ent.groundentity.linkcount;

  // the move is ok
  if (relink) {
    gi.linkentity(ent);

    // [Paril-KEX] this is something N64 does to avoid doors opening at the
    // start of a level, which triggers some monsters to spawn.
    if (!level.is_n64 || level.time > frameTimeAsGtime()) {
      G_TouchTriggers(ent);
    }
  }

  if (stepped) ent.s.renderfx |= RenderfxT.RF_STAIR_STEP;

  if (trace.fraction < 1.0) G_Impact(ent, trace);

  return true;
}

// ---------------------------------------------------------------------------
// ai_check_move (m_move.cpp:888-909)
// ---------------------------------------------------------------------------

/** Check if a movement would succeed, without actually committing to it. */
export function ai_check_move(self: EdictT, dist: number): boolean {
  if (cvarOrDefault("ai_movement_disabled", "0").value !== 0) return false;

  const yaw = (self.s.angles[YAW] * Q_PIf * 2) / 360;
  const move = vec3(Math.cos(yaw) * dist, Math.sin(yaw) * dist, 0);

  const old_origin = copyVec3(self.s.origin);

  if (!SV_movestep(self, move, false)) return false;

  VectorCopy(old_origin, self.s.origin);
  gi.linkentity(self);
  return true;
}

// ---------------------------------------------------------------------------
// M_ChangeYaw (m_move.cpp:919-958)
// ---------------------------------------------------------------------------

export function M_ChangeYaw(ent: EdictT): void {
  const current = anglemod(ent.s.angles[YAW]);
  const ideal = ent.ideal_yaw;

  if (current === ideal) return;

  let move = ideal - current;
  // [Paril-KEX] high tick rate
  const speed = ent.yaw_speed / (gi.tick_rate / 10);

  if (ideal > current) {
    if (move >= 180) move = move - 360;
  } else {
    if (move <= -180) move = move + 360;
  }

  if (move > 0) {
    if (move > speed) move = speed;
  } else {
    if (move < -speed) move = -speed;
  }

  ent.s.angles[YAW] = anglemod(current + move);
}

// ---------------------------------------------------------------------------
// SV_StepDirection (m_move.cpp:969-1015, exported beyond g_local.h)
// ---------------------------------------------------------------------------

/** Turns to the movement direction, and walks the current distance if
 *  facing it. */
export function SV_StepDirection(ent: EdictT, yawDeg: number, dist: number, allow_no_turns: boolean): boolean {
  if (!ent.inuse) return true; // PGM g_touchtrigger free problem

  const old_ideal_yaw = ent.ideal_yaw;
  const old_current_yaw = ent.s.angles[YAW];

  ent.ideal_yaw = yawDeg;
  M_ChangeYaw(ent);

  const yawRad = (yawDeg * Q_PIf * 2) / 360;
  const move = vec3(Math.cos(yawRad) * dist, Math.sin(yawRad) * dist, 0);

  const oldorigin = copyVec3(ent.s.origin);
  if (SV_movestep(ent, move, false)) {
    ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
    if (!ent.inuse) return true; // PGM g_touchtrigger free problem

    if (ent.classname === null || !ent.classname.startsWith("monster_widow")) {
      if (!FacingIdeal(ent)) {
        // not turned far enough, so don't take the step but still turn
        VectorCopy(oldorigin, ent.s.origin);
        M_CheckGround(ent, G_GetClipMask(ent));
        return allow_no_turns; // [Paril-KEX]
      }
    }

    gi.linkentity(ent);
    G_TouchTriggers(ent);
    G_TouchProjectiles(ent, oldorigin);
    return true;
  }

  gi.linkentity(ent);
  G_TouchTriggers(ent);
  ent.ideal_yaw = old_ideal_yaw;
  ent.s.angles[YAW] = old_current_yaw;
  return false;
}

// ---------------------------------------------------------------------------
// SV_FixCheckBottom (m_move.cpp:1023-1026, exported beyond g_local.h)
// ---------------------------------------------------------------------------

export function SV_FixCheckBottom(ent: EdictT): void {
  ent.flags |= EntFlagsT.FL_PARTIALGROUND;
}

// ---------------------------------------------------------------------------
// SV_NewChaseDir (m_move.cpp:1034-1144, exported beyond g_local.h)
// ---------------------------------------------------------------------------

const DI_NODIR = -1;

/** `float d[3]` in the C++ source only ever writes/reads indices 1 and 2 --
 *  `d[0]` is genuinely dead (uninitialized, never read). Ported literally as
 *  a 3-tuple with index 0 unused, matching the source instead of
 *  "improving" it into a 2-element array. */
export function SV_NewChaseDir(actor: EdictT, pos: Vec3, dist: number): boolean {
  const olddir = anglemod(Math.trunc(actor.ideal_yaw / 45) * 45);
  const turnaround = anglemod(olddir - 180);

  const deltax = pos[0] - actor.s.origin[0];
  const deltay = pos[1] - actor.s.origin[1];

  const d: [number, number, number] = [0, 0, 0];
  if (deltax > 10) d[1] = 0;
  else if (deltax < -10) d[1] = 180;
  else d[1] = DI_NODIR;

  if (deltay < -10) d[2] = 270;
  else if (deltay > 10) d[2] = 90;
  else d[2] = DI_NODIR;

  // try direct route
  if (d[1] !== DI_NODIR && d[2] !== DI_NODIR) {
    let tdir: number;
    if (d[1] === 0) tdir = d[2] === 90 ? 45 : 315;
    else tdir = d[2] === 90 ? 135 : 215;

    if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist, false)) return true;
  }

  // try other directions
  if (brandom() || Math.abs(deltay) > Math.abs(deltax)) {
    const tmp = d[1];
    d[1] = d[2];
    d[2] = tmp;
  }

  if (d[1] !== DI_NODIR && d[1] !== turnaround && SV_StepDirection(actor, d[1], dist, false)) return true;
  if (d[2] !== DI_NODIR && d[2] !== turnaround && SV_StepDirection(actor, d[2], dist, false)) return true;

  // ROGUE
  if (actor.monsterinfo.blocked) {
    if (actor.inuse && actor.health > 0 && (actor.monsterinfo.aiflags & MonsterAiFlagsT.AI_TARGET_ANGER) === 0n) {
      // if block "succeeds", the actor will not move or turn.
      if (actor.monsterinfo.blocked(actor, dist)) {
        actor.monsterinfo.move_block_counter = -2;
        return true;
      }

      // we couldn't step; instead of running endlessly in our current spot,
      // try switching to node navigation temporarily to get to where we
      // need to go.
      if (
        (actor.monsterinfo.aiflags &
          (MonsterAiFlagsT.AI_LOST_SIGHT |
            MonsterAiFlagsT.AI_COMBAT_POINT |
            MonsterAiFlagsT.AI_TARGET_ANGER |
            MonsterAiFlagsT.AI_PATHING |
            MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT |
            MonsterAiFlagsT.AI_NO_PATH_FINDING)) ===
        0n
      ) {
        if (++actor.monsterinfo.move_block_counter > 2) {
          actor.monsterinfo.aiflags |= MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
          actor.monsterinfo.move_block_change_time = Gtime_add(level.time, Gtime_from_sec(3));
          actor.monsterinfo.move_block_counter = 0;
        }
      }
    }
  }
  // ROGUE

  // there is no direct path to the player, so pick another direction
  if (olddir !== DI_NODIR && SV_StepDirection(actor, olddir, dist, false)) return true;

  if (brandom()) {
    // randomly determine direction of search
    for (let tdir = 0; tdir <= 315; tdir += 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist, false)) return true;
    }
  } else {
    for (let tdir = 315; tdir >= 0; tdir -= 45) {
      if (tdir !== turnaround && SV_StepDirection(actor, tdir, dist, false)) return true;
    }
  }

  if (turnaround !== DI_NODIR && SV_StepDirection(actor, turnaround, dist, false)) return true;

  actor.ideal_yaw = frandom(0, 360); // can't move; pick a random yaw...

  // if a bridge was pulled out from underneath a monster, it may not have a
  // valid standing position at all
  if (!M_CheckBottom(actor)) SV_FixCheckBottom(actor);

  return false;
}

// ---------------------------------------------------------------------------
// SV_CloseEnough (m_move.cpp:1152-1164)
// ---------------------------------------------------------------------------

export function SV_CloseEnough(ent: EdictT, goal: EdictT, dist: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (goal.absmin[i] > ent.absmax[i] + dist) return false;
    if (goal.absmax[i] < ent.absmin[i] - dist) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// M_NavPathToGoal (m_move.cpp:1166-1277) -- static
// ---------------------------------------------------------------------------

function M_NavPathToGoal(self: EdictT, dist: number, goal: Vec3): boolean {
  // mark us as *trying* now (nav_pos is valid)
  self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_PATHING;

  // `vec3_t &path_to = ...` in the C++ source is a REFERENCE, bound once,
  // to whichever field object the ternary picks -- it does not re-evaluate
  // if `returnCode` changes later. Ported as a single alias captured once,
  // read through afterward, matching that binding-once semantics (assumes
  // gi.GetPathToGoal mutates the PathInfo's Vec3 fields in place rather than
  // replacing them, the same assumption g_main_globals.ts's own PathInfo
  // factory implies).
  const pathToRef: Vec3 =
    self.monsterinfo.nav_path.returnCode === PathReturnCode.TraversalPending
      ? self.monsterinfo.nav_path.secondMovePoint
      : self.monsterinfo.nav_path.firstMovePoint;

  if (
    (self.monsterinfo.nav_path.returnCode !== PathReturnCode.TraversalPending &&
      vec3_length(vec3_sub(pathToRef, self.s.origin)) <= vec3_length(self.size) * 0.5) ||
    self.monsterinfo.nav_path_cache_time <= level.time
  ) {
    const request: PathRequest = {
      start: copyVec3(self.s.origin),
      goal: copyVec3(goal),
      pathFlags: PathFlags.Walk,
      moveDist: dist,
      debugging: { drawTime: cvarOrDefault("g_debug_monster_paths", "0").value === 1 ? gi.frame_time_s : 0 },
      nodeSearch: { ignoreNodeFlags: false, minHeight: 0, maxHeight: 0, radius: 0 },
      traversals: { dropHeight: 0, jumpHeight: 0 },
      pathPoints: { array: null, count: 0 },
    };

    if (self.monsterinfo.can_jump || (self.flags & EntFlagsT.FL_FLY) !== 0n) {
      if (self.monsterinfo.jump_height) {
        request.pathFlags |= PathFlags.BarrierJump;
        request.traversals.jumpHeight = self.monsterinfo.jump_height;
      }
      if (self.monsterinfo.drop_height) {
        request.pathFlags |= PathFlags.WalkOffLedge;
        request.traversals.dropHeight = self.monsterinfo.drop_height;
      }
    }

    if ((self.flags & EntFlagsT.FL_FLY) !== 0n) {
      request.nodeSearch.maxHeight = request.nodeSearch.minHeight = 8192;
      request.pathFlags |= PathFlags.LongJump;
    }

    if (!gi.GetPathToGoal(request, self.monsterinfo.nav_path)) {
      // fatal error, don't bother ever trying nodes
      if (self.monsterinfo.nav_path.returnCode === PathReturnCode.NoNavAvailable) {
        self.monsterinfo.aiflags |= MonsterAiFlagsT.AI_NO_PATH_FINDING;
      }
      return false;
    }

    self.monsterinfo.nav_path_cache_time = Gtime_add(level.time, Gtime_from_sec(2));
  }

  const old_yaw = self.s.angles[YAW];
  const old_ideal_yaw = self.ideal_yaw;

  let yaw: number;
  if (
    self.monsterinfo.random_change_time >= level.time &&
    (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) === 0n
  ) {
    yaw = self.ideal_yaw;
  } else {
    yaw = vectoyaw(vec3_normalized(vec3_sub(pathToRef, self.s.origin)));
  }

  if (!SV_StepDirection(self, yaw, dist, true)) {
    if (!self.inuse) return false;

    if (self.monsterinfo.blocked && (self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TARGET_ANGER) === 0n) {
      if (self.inuse && self.health > 0) {
        // if we're blocked, the blocked function will be deferred to for yaw
        self.s.angles[YAW] = old_yaw;
        self.ideal_yaw = old_ideal_yaw;
        if (self.monsterinfo.blocked(self, dist)) return true;
      }
    }

    // try the first point
    if (self.monsterinfo.random_change_time >= level.time) {
      yaw = self.ideal_yaw;
    } else {
      yaw = vectoyaw(vec3_normalized(vec3_sub(self.monsterinfo.nav_path.firstMovePoint, self.s.origin)));
    }

    if (!SV_StepDirection(self, yaw, dist, true)) {
      // we got blocked, but all is not lost yet; do a similar bump
      // around-ish behavior to try to regain our composure
      if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_BLOCKED) !== 0n) {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
        return true;
      }

      if (self.monsterinfo.random_change_time < level.time && self.inuse) {
        self.monsterinfo.random_change_time = Gtime_add(level.time, Gtime_from_ms(1500));
        if (SV_NewChaseDir(self, pathToRef, dist)) return true;
      }

      self.monsterinfo.path_blocked_counter = Gtime_add(self.monsterinfo.path_blocked_counter, Gtime_scale(frameTimeAsGtime(), 3));
    }

    if (self.monsterinfo.path_blocked_counter > Gtime_from_ms(1500)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// M_MoveToPath (m_move.cpp:1287-1361) -- static
// ---------------------------------------------------------------------------

/** Advanced movement code that uses the bot's pathfinder if allowed and
 *  conditions are right. */
function M_MoveToPath(self: EdictT, dist: number): boolean {
  if ((self.flags & EntFlagsT.FL_STATIONARY) !== 0n) return false;
  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_NO_PATH_FINDING) !== 0n) return false;
  if (self.monsterinfo.path_wait_time > level.time) return false;
  if (!self.enemy) return false;
  if (
    self.enemy.client &&
    self.enemy.client.invisible_time > level.time &&
    self.enemy.client.invisibility_fade_time <= level.time
  ) {
    return false;
  }
  if (self.monsterinfo.attack_state >= MonsterAttackStateT.AS_MISSILE) return true;

  let style = self.monsterinfo.combat_style;

  if ((self.monsterinfo.aiflags & MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT) !== 0n) style = CombatStyleT.COMBAT_MELEE;

  if (visible(self, self.enemy, false)) {
    if ((self.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) !== 0n || style === CombatStyleT.COMBAT_RANGED) {
      // do the normal "shoot, walk, shoot" behavior...
      return false;
    } else if (style === CombatStyleT.COMBAT_MELEE) {
      // path pretty close to the enemy, then let normal Quake movement take over.
      if (
        range_to(self, self.enemy) > 240 ||
        Math.abs(self.s.origin[2] - self.enemy.s.origin[2]) > Math.max(self.maxs[2], -self.mins[2])
      ) {
        if (M_NavPathToGoal(self, dist, self.enemy.s.origin)) return true;
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
      } else {
        self.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TEMP_MELEE_COMBAT;
        return false;
      }
    } else if (style === CombatStyleT.COMBAT_MIXED) {
      // most mixed combat AI have fairly short range attacks, so try to
      // path within mid range.
      if (
        range_to(self, self.enemy) > RANGE_NEAR ||
        Math.abs(self.s.origin[2] - self.enemy.s.origin[2]) > Math.max(self.maxs[2], -self.mins[2]) * 2.0
      ) {
        if (M_NavPathToGoal(self, dist, self.enemy.s.origin)) return true;
      } else {
        return false;
      }
    }
  } else {
    // we can't see our enemy, let's see if we can path to them
    if (M_NavPathToGoal(self, dist, self.enemy.s.origin)) return true;
  }

  if (!self.inuse) return false;

  if (self.monsterinfo.nav_path.returnCode > PathReturnCode.StartPathErrors) {
    self.monsterinfo.path_wait_time = Gtime_add(level.time, Gtime_from_sec(10));
    return false;
  }

  self.monsterinfo.path_blocked_counter = Gtime_add(self.monsterinfo.path_blocked_counter, Gtime_scale(frameTimeAsGtime(), 3));

  if (self.monsterinfo.path_blocked_counter > Gtime_from_sec(5)) {
    self.monsterinfo.path_blocked_counter = GTIME_ZERO;
    self.monsterinfo.path_wait_time = Gtime_add(level.time, Gtime_from_sec(5));
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// M_MoveToGoal (m_move.cpp:1368-1472)
// ---------------------------------------------------------------------------

export function M_MoveToGoal(ent: EdictT, dist: number): void {
  if (cvarOrDefault("ai_movement_disabled", "0").value !== 0) {
    // mal: don't move, but still face toward target
    if (!FacingIdeal(ent)) M_ChangeYaw(ent);
    return;
  }

  const goal = ent.goalentity;

  if (!ent.groundentity && (ent.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) return;
  else if (!goal) return;

  // [Paril-KEX] try paths if we can't see the enemy
  if (
    (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_COMBAT_POINT) === 0n &&
    ent.monsterinfo.attack_state < MonsterAttackStateT.AS_MISSILE
  ) {
    if (M_MoveToPath(ent, dist)) {
      const reduced = Gtime_subtract(ent.monsterinfo.path_blocked_counter, frameTimeAsGtime());
      ent.monsterinfo.path_blocked_counter = reduced > GTIME_ZERO ? reduced : GTIME_ZERO;
      return;
    }
  }

  ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_PATHING;

  // [Paril-KEX] dumb hack; in some n64 maps, the corners are way too high
  // and I'm too lazy to fix them individually in maps, so here's a game fix.
  if (
    (goal.flags & EntFlagsT.FL_PARTIALGROUND) === 0n &&
    (ent.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n &&
    goal.classname !== null &&
    (goal.classname === "path_corner" || goal.classname === "point_combat")
  ) {
    const p = vec3(goal.s.origin[0], goal.s.origin[1], ent.s.origin[2]);

    if (boxes_intersect(ent.absmin, ent.absmax, p, p)) {
      // mark this so we don't do it again later
      goal.flags |= EntFlagsT.FL_PARTIALGROUND;

      if (!boxes_intersect(ent.absmin, ent.absmax, goal.s.origin, goal.s.origin)) {
        // move it if we would have touched it if the corner was lower
        goal.s.origin[2] = p[2];
        gi.linkentity(goal);
      }
    }
  }

  // [Paril-KEX] if we have a straight shot to our target, just move
  // straight instead of trying to stick to invisible guide lines
  if ((ent.monsterinfo.bad_move_time <= level.time || (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_CHARGING) !== 0n) && goal) {
    if (!FacingIdeal(ent)) {
      M_ChangeYaw(ent);
      return;
    }

    const tr = gi.trace(ent.s.origin, null, null, goal.s.origin, ent, MASK_MONSTERSOLID);

    if (tr.fraction === 1.0 || edictFrom(tr.ent) === goal) {
      if (SV_StepDirection(ent, vectoyaw(vec3_normalized(vec3_sub(goal.s.origin, ent.s.origin))), dist, false)) return;
    }

    // we didn't make a step, so don't try this for a while *unless* we're
    // going to a path corner
    if (goal.classname !== null && goal.classname !== "path_corner" && goal.classname !== "point_combat") {
      ent.monsterinfo.bad_move_time = Gtime_add(level.time, Gtime_from_sec(5));
      ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_CHARGING;
    }
  }

  // bump around...
  const randomBump =
    ent.monsterinfo.random_change_time <= level.time && // random change time is up
    irandom(4) === 1 && // random bump around
    (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_CHARGING) === 0n && // PMM - charging monsters don't deflect unless they have to
    !((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) !== 0n && ent.enemy !== null && (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_LOST_SIGHT) === 0n); // alternate fly monsters don't do this either unless they have to

  if (randomBump || !SV_StepDirection(ent, ent.ideal_yaw, dist, ent.monsterinfo.bad_move_time > level.time)) {
    if ((ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_BLOCKED) !== 0n) {
      ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
      return;
    }
    ent.monsterinfo.random_change_time = Gtime_add(level.time, random_time(Gtime_from_ms(500), Gtime_from_ms(1000)));
    SV_NewChaseDir(ent, goal.s.origin, dist);
    ent.monsterinfo.move_block_counter = 0;
  } else {
    ent.monsterinfo.bad_move_time = Gtime_subtract(ent.monsterinfo.bad_move_time, Gtime_from_ms(250));
  }
}

// ---------------------------------------------------------------------------
// M_walkmove (m_move.cpp:1479-1502)
// ---------------------------------------------------------------------------

export function M_walkmove(ent: EdictT, yawDeg: number, dist: number): boolean {
  if (cvarOrDefault("ai_movement_disabled", "0").value !== 0) return false;

  if (!ent.groundentity && (ent.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === 0n) return false;

  const yawRad = (yawDeg * Q_PIf * 2) / 360;
  const move = vec3(Math.cos(yawRad) * dist, Math.sin(yawRad) * dist, 0);

  // PMM
  const retval = SV_movestep(ent, move, true);
  ent.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_BLOCKED;
  return retval;
}
