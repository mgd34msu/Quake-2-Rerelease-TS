// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_phys.c -- entity physics (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/g_phys.cpp
// (1,041 lines, C++17): SV_TestEntityPosition, SV_CheckVelocity, SV_RunThink,
// G_Impact, SV_FlyMove, SV_AddGravity, the pushmove family (SV_PushEntity/
// SV_Push/SV_Physics_Pusher), SV_Physics_None/Noclip/Toss/Step,
// G_RunBmodelAnimation, G_RunEntity, plus G_GetClipMask ([Paril-KEX]).
//
// BEHAVIORAL PORT: bug-for-bug fidelity per PORTING.md. This file is a near-
// total rewrite of the legacy vanilla port (src/game/g_phys.ts) -- almost
// every function below differs from its legacy counterpart in some
// observable way. Every genuine behavior difference is cited at its exact
// call site with the C++ line range; this header collects the load-bearing
// ones so a reviewer doesn't have to diff function-by-function to find them.
//
// ============================================================================
// g_utils.ts <-> g_phys.ts: a real, sanctioned import cycle
// ============================================================================
// g_utils.ts's G_TouchProjectiles/KillBox call G_Impact/G_GetClipMask (this
// file); this file's SV_PushEntity/SV_Push/SV_Physics_Step call
// G_TouchTriggers/G_TouchProjectiles (g_utils.ts) -- exactly mirroring the
// C++ source, where g_utils.cpp and g_phys.cpp call into each other freely
// through a shared header (g_local.h) with no notion of a compilation-unit
// cycle at all. This unit REPLACES g_utils.ts's two throwing stubs
// (`G_Impact`, `G_GetClipMask`, both documented in that file's own header as
// "pending g_phys.ts") with real imports from here -- see the diff at the
// bottom of this header. This is a genuine value cycle between two ES
// modules, but PORTING.md's require()-workaround is for cycles that break
// module INIT (TDZ on a `const` needed before the other side has run). That
// does not apply here: every cross-module symbol on both sides is an
// `export function` declaration. Function declarations are hoisted and live
// as soon as each module is linked, before either module's top-level body
// runs -- so by the time either file's own top-level code executes (there is
// none here that calls across the cycle), both sides' functions are already
// callable. Verified end-to-end by `bunx tsc --noEmit` and `bun test`
// actually importing both files together (see this unit's own test file).
//
// ============================================================================
// MAJOR KEX REWRITES VS. THE LEGACY/VANILLA PORT (src/game/g_phys.ts)
// ============================================================================
// - G_GetClipMask (g_phys.cpp:30-56) is NEW: every clip-mask lookup in this
//   file (SV_TestEntityPosition, SV_PushEntity, KillBox via g_utils.ts) goes
//   through it instead of the legacy `ent.clipmask || MASK_SOLID` fallback.
//   It layers default masks per SVF_MONSTER/SVF_PROJECTILE/otherwise, then
//   strips CONTENTS_MONSTER|CONTENTS_PLAYER for non-solid/trigger entities
//   and for dead monsters/players.
// - SV_CheckVelocity (g_phys.cpp:81-90) rescales by MAGNITUDE
//   (`velocity = (velocity/speed) * sv_maxvelocity`) instead of the legacy
//   per-axis clamp. A diagonal velocity that exceeds sv_maxvelocity in
//   magnitude but not on any single axis is now clamped; the legacy version
//   would have left it untouched.
// - SV_RunThink's clock is a `GTime` (integer milliseconds, gtime.ts) with
//   exact comparisons (`thinktime > level.time`) -- no epsilon fuzz. The
//   legacy port's `level.time + 0.001` float-epsilon hack does not exist
//   here and is not needed: GTime has no float rounding to guard against.
// - G_Impact (renamed from the legacy port's `SV_Impact`, matching the C++
//   source's own name) additionally fires touch for a SOLID_NOT entity that
//   has FL_ALWAYS_TOUCH set (g_phys.cpp:126,129) -- legacy only checked
//   `solid != SOLID_NOT`.
// - SV_FlyMove (g_phys.cpp:140-172) no longer implements its own bump-loop:
//   it delegates entirely to p_move.ts's already-ported
//   `PM_StepSlideMove_Generic` (shared with player movement), then walks the
//   resulting touch list to set groundentity (plane normal z > 0.7), call
//   G_Impact per touch, and honor FL_KILL_VELOCITY. Return type is `void`
//   (no more "blocked" bitmask -- nothing in this file's callers used the
//   old return value anyway).
// - SV_AddGravity (g_phys.cpp:180-183) adds along `ent.gravityVector`
//   (defaults to (0,0,-1), see g_main_globals.ts's defaultEdict) scaled by
//   `ent.gravity * level.gravity * gi.frame_time_s`, not a flat Z-axis
//   subtraction -- entities with a non-default gravityVector (gravity-flip
//   mechanics) fall in a different direction.
// - SV_PushEntity (g_phys.cpp:200-235): nudges the resting origin a half
//   unit along the impact plane's normal (`trace.endpos + normal*0.5`, NOT
//   in legacy); triggers G_Impact on `trace.startsolid` too, not just
//   `fraction != 1`; unconditionally resets `ent.gravity = 1.0` every push
//   (a live PGM line, not a dead FIXME comment); recurses (matching the C++
//   source's own recursive retry) instead of looping.
// - SV_Push (g_phys.cpp:258-405): the legacy "clamp move to 1/8 units for
//   client prediction" preprocessing step is GONE -- verified absent from
//   this KEX source, moves are used at full float precision. Uses
//   `check.linked` directly (KexEdictT field) instead of legacy's
//   `area.prev` proxy. The per-rider `client.ps.pmove.delta_angles[YAW] +=
//   amove[YAW]` update is DISABLED (g_phys.cpp:327-333, "Paril: disabled
//   because in vanilla delta_angles are never lerped") -- for a client
//   rider, amove's yaw contribution to their view is simply dropped; only
//   non-client riders get `s.angles[YAW] += amove[YAW]`. A NEW [Paril-KEX]
//   hack (g_phys.cpp:349-357) treats a blocked client entity with
//   `!takedamage` (a dead player's "skull" spectator-cam body) as NOT
//   blocking -- it's silently moved back to its pre-push position and
//   treated as pushed-ok, so elevators/doors don't jam on player corpses.
//   The final revert-to-old-position fallback (g_phys.cpp:366-369) restores
//   from the actually-saved `old_position` local, fixing the legacy port's
//   own documented FIXME ("this doesn't acount for rotation") where
//   subtracting `move` a second time was not a true inverse once `move2`
//   (the rotation-induced offset) had also been applied.
// - SV_Physics_Pusher (g_phys.cpp:415-464): the legacy "bump all
//   `nextthink` times when blocked" step does not exist in this source at
//   all. In its place, a REAL `retry:` goto IS live in this KEX version
//   (not `#if 0`'d, unlike the vanilla source's dead copy of the same
//   idea): after calling the blocked handler, if the obstacle has since
//   been freed (`!obstacle.inuse`), the whole push attempt restarts from
//   the top. Ported as a `for (;;)` loop with `continue` standing in for
//   `goto retry`.
// - SV_Physics_Toss (g_phys.cpp:515-687) is a near-total rewrite: an early
//   return while resting on ground is now gated on `ent.gravity > 0` (a
//   documented "PGM - gravity hack"); MOVETYPE_WALLBOUNCE (Rafael/ripper-gun
//   projectiles) is a third gravity-exempt movetype alongside FLY/
//   FLYMISSILE; a single push-and-clip attempt becomes a bounded
//   `num_tries = 5` sub-step loop (only MOVETYPE_TOSS actually loops --
//   every other movetype still breaks after one bounce, per the C++
//   source's own `if (movetype != MOVETYPE_TOSS) break;` at the loop's
//   tail); `trace.allsolid` gets its own "just assume that's our ground,
//   don't build up velocity" early-out; WALLBOUNCE re-derives `s.angles`
//   from the post-clip velocity every bounce (`vectoangles`); the "stop if
//   basically resting" threshold now also requires `!(FL_NO_STANDING) ||
//   trace.ent.solid == SOLID_BSP`; SVF_MONSTER entities run
//   M_CatagorizePosition/M_WorldEffects both on the early on-ground return
//   AND after moving (not ported here -- see "CROSS-DEPENDENCIES" below);
//   and a dropped key landing in slime/lava gets a random relaunch impulse
//   to prevent a softlock (g_phys.cpp:676-679).
// - SV_Physics_Step (g_phys.cpp:734-877): `M_CheckGround` now takes the
//   clip mask and is called TWICE (once up front if airborne, again after
//   moving); a NaN-velocity guard was added (g_phys.cpp:761-762, "FIXME:
//   figure out how or why this is happening"); dead monsters get half
//   ground friction (`friction *= 0.5f` when `ent.deadflag`); a hit-the-
//   ground sound no longer plays directly -- it sets `s.event = EV_FOOTSTEP`
//   for the client to render; `G_TouchProjectiles` runs after every move;
//   `ent.gravity` is unconditionally reset to 1.0 every frame the entity
//   actually moved (a PGM comment: "G_TouchTriggers will set it back if
//   appropriate"); `G_TouchTriggers` is skipped on the very first level
//   frame on N64 maps (an "avoid doors opening at level start" hack); and a
//   Stalker-specific `monsterinfo.physics_change` hook fires when
//   `groundentity`'s truthiness flips across the frame. The legacy port's
//   `M_CheckBottom`-gated friction guard for resting dead monsters does not
//   exist in this source at all -- verified absent by reading the whole
//   function; not reproduced.
// - G_RunBmodelAnimation (g_phys.cpp:880-937) is entirely NEW: advances a
//   bmodel's `s.frame` per its `bmodel_anim` config (forwards/backwards/
//   random, with an alternate-state variant and a next_tick gtime gate).
//   Ran automatically by G_RunEntity for every entity with
//   `bmodel_anim.enabled`, ahead of the movetype dispatch.
// - G_RunEntity (g_phys.cpp:947-1041) adds a MOVETYPE_STEP safety net absent
//   from legacy: after the movetype dispatch, if the entity actually moved,
//   it re-traces from the new origin back to the frame-start origin and, if
//   that trace is stuck in solid, snaps the origin back -- guards against
//   SV_Physics_Step or a think function leaving a stepping entity wedged.
//   The `#if 0`'d disintegrator block (g_phys.cpp:1015-1037) is dropped per
//   PORTING.md's "#if 0 blocks are dropped silently".
//
// ============================================================================
// CROSS-DEPENDENCIES -- M_CheckGround/M_CatagorizePosition/M_WorldEffects
// NOW REAL IMPORTS from src/kexgame/g_monster.ts (stub swap)
// ============================================================================
// Previously three local throwing stubs (see git history): M_CheckGround
// (g_monster.cpp:140), M_CatagorizePosition (g_monster.cpp:190),
// M_WorldEffects (g_monster.cpp:235). src/kexgame/g_monster.ts has now
// landed with real implementations of all three, so this file imports them
// directly. M_CatagorizePosition's out-param question the old stub's own
// comment flagged ("this stub's signature drops the two out-params in favor
// of mutating self directly once implemented") is now settled: g_monster.ts
// mutates `self.waterlevel`/`self.watertype` in place and takes just
// `(self, in_point)` -- exactly what this file's three call sites below
// already pass (`M_CatagorizePosition(ent, ent.s.origin)`), so NONE of this
// file's own call sites needed to change.
//
// This creates a real, sanctioned import cycle: this file now imports
// M_CheckGround/M_CatagorizePosition/M_WorldEffects from g_monster.ts, while
// g_monster.ts imports G_GetClipMask from THIS file (for M_droptofloor and
// G_FixStuckObject). Exactly the same shape as the already-sanctioned
// g_utils.ts<->g_phys.ts cycle documented above: every cross-module symbol
// on both sides is a hoisted `export function` declaration, never a
// top-level `const` evaluated at module-init time. Verified end-to-end by
// `bunx tsc --noEmit` and `bun test` importing both files together.
//
// ============================================================================
// CROSS-DEPENDENCIES NOT YET PORTED
// ============================================================================
// One function this file calls is still defined in an other, not-yet-ported
// C++ file:
//   - SV_Physics_NewToss(ent) -> rerelease/rogue/g_rogue_phys.cpp (future src/rogue/, PORTING.md's rogue/->src/rogue/ mapping)
//     (forward-declared in g_phys.cpp:26 as `// PGM`, but its actual body
//     lives in the ROGUE mission-pack's own physics file, out of scope for
//     this base-game unit; only reachable via MOVETYPE_NEWTOSS.)
// It does not exist yet in src/rogue/. Per PORTING.md's "a function you
// cannot port faithfully is a reported deviation, not a TODO", it remains a
// local, unexported stub that throws, naming itself and the file that owns
// the real implementation. Reached only by MOVETYPE_NEWTOSS, which this
// unit's own test suite does not exercise. Replace with a real import once
// src/rogue/ lands.
//
// ============================================================================
// FRAME_TIME_S -- not yet a real global either
// ============================================================================
// g_local.h:468-469 declares `extern gtime_t FRAME_TIME_S/FRAME_TIME_MS`,
// set once in InitGame (g_main.cpp:415: `FRAME_TIME_S = FRAME_TIME_MS =
// gtime_t::from_ms(gi.frame_time_ms)`) and never changed again. g_main.ts
// has not landed in this port line yet (g_local.ts's own header already
// flags this exact gap for `SERVER_TICK_RATE`/`FRAME_TIME_S`/
// `FRAME_TIME_MS`, "these take frameTimeMs as an explicit parameter instead
// of reaching for a global that does not exist"). Since `gi.frame_time_ms`
// is available and by contract never changes mid-game, `frameTimeAsGtime()`
// below recomputes the identical value on demand rather than caching a
// global that has nowhere to be initialized yet.
//
// ============================================================================
// OTHER NOTED DEVIATIONS
// ============================================================================
// - `sv_maxvelocity`/`sv_gravity`/`sv_stopspeed` are real `cvar_t*` globals
//   in the C++ source, registered once in InitGame (g_main.cpp:233-238) and
//   read as bare pointers thereafter. No InitGame-equivalent has landed in
//   this port line yet (same gap g_utils.ts's own `coopEnabled()` helper
//   already works around), so each is looked up via `gi.cvar(name, default,
//   CVAR_NOFLAGS)` at every call site instead of a cached pointer --
//   behaviorally identical, since `Cvar_Get`/`gi.cvar` is idempotent by
//   contract (returns the already-registered cvar on every call after the
//   first). `sv_friction`/`sv_waterfriction` are NOT cvars in this source
//   (`constexpr float sv_friction = 6; constexpr float sv_waterfriction =
//   1;`, g_local.h:2498-2499) -- plain module-level constants here too.
// - `SV_Push`'s `mv` local (`edict_t *part, *mv;`) is declared in the C++
//   source but never referenced anywhere in `SV_Physics_Pusher`'s body
//   (verified by reading the whole function) -- dead leftover from an
//   earlier version of the function; not ported (nothing would use it).

import { vec3, type Vec3, VectorCopy } from "../shared/math";
import {
  type KexTraceT,
  type KexEdictT,
  type KexTouchListT,
  ContentsT,
  SvflagsT,
  SolidT,
  MASK_MONSTERSOLID,
  MASK_PROJECTILE,
  MASK_SHOT,
  MASK_WATER,
  WaterLevelT,
  KexEntityEventT,
  CvarFlagsT,
  SoundchanT,
} from "../kexapi/game";
import {
  type EdictT,
  MovetypeT,
  EntFlagsT,
  ItemFlagsT,
  MonsterAiFlagsT,
  SPAWNFLAG_ITEM_DROPPED,
  BmodelAnimstyleT,
} from "./g_local";
import { gi, globals, g_edicts, level } from "./g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_from_ms, type GTime } from "./gtime";
import { SpawnFlags_has } from "./spawnflags";
import {
  vec3_origin,
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_divs,
  vec3_negate,
  vec3_addEq,
  vec3_mulEqs,
  vec3_dot,
  vec3_length,
  vec3_scaled,
  vec3_equals,
  AngleVectors,
  ClipVelocity,
  SlideClipVelocity,
  vectoangles,
} from "./q_vec3";
import { YAW, clamp, crandom_open, irandom } from "./q_std";
import { PM_StepSlideMove_Generic } from "./p_move";
import type { PmTraceFn } from "./bg_local";
import { G_TouchTriggers, G_TouchProjectiles } from "./g_utils";
import { M_CheckGround, M_CatagorizePosition, M_WorldEffects } from "./g_monster";
import type { CvarT } from "../shared/q_shared";

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/** See file header's "sv_maxvelocity/sv_gravity/sv_stopspeed" note. */
function cvarOrDefault(name: string, defaultValue: string): CvarT {
  const c = gi.cvar(name, defaultValue, CvarFlagsT.CVAR_NOFLAGS);
  if (c === null) {
    // gi.cvar is documented never to return null for a well-formed
    // registration; this is a defensive fallback, not a real C++ path.
    throw new Error(`gi.cvar(${name}) returned null`);
  }
  return c;
}

/** See file header's "FRAME_TIME_S" note. */
function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

/**
 * Recovers the game-private EdictT from a KexTraceT's engine-visible
 * `KexEdictT`, per PORTING.md's EDICT_NUM idiom (`g_edicts[ent.s.number]`,
 * never a cast). `gi.trace()`'s own contract defaults `trace.ent` to the
 * world edict when nothing else was hit (KexTraceT's own doc comment: "not
 * set by CM_*() functions" refers to the raw collision-model level below
 * `gi.trace`'s game-facing wrapper); a null `ent` here -- only reachable
 * because the declared type allows it -- falls back to the same world edict.
 */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// ---------------------------------------------------------------------------
// G_GetClipMask (g_phys.cpp:28-56) -- [Paril-KEX]
// ---------------------------------------------------------------------------

/**
 * g_phys.cpp: `contents_t G_GetClipMask(edict_t *ent)`. Fetches the clipmask
 * for this entity; certain modifiers affect the clipping behavior of
 * objects. Formerly a throwing stub in g_utils.ts (see that file's header);
 * this is the real implementation.
 */
export function G_GetClipMask(ent: EdictT): ContentsT {
  let mask: ContentsT = ent.clipmask;

  // default masks
  if (!mask) {
    if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) mask = MASK_MONSTERSOLID;
    else if ((ent.svflags & SvflagsT.SVF_PROJECTILE) !== 0) mask = MASK_PROJECTILE;
    else mask = MASK_SHOT & ~ContentsT.CONTENTS_DEADMONSTER;
  }

  // non-solid objects (items, etc) shouldn't try to clip against players/monsters
  if (ent.solid === SolidT.SOLID_NOT || ent.solid === SolidT.SOLID_TRIGGER) {
    mask &= ~(ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER);
  }

  // monsters/players that are also dead shouldn't clip against players/monsters
  if (
    (ent.svflags & (SvflagsT.SVF_MONSTER | SvflagsT.SVF_PLAYER)) !== 0 &&
    (ent.svflags & SvflagsT.SVF_DEADMONSTER) !== 0
  ) {
    mask &= ~(ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER);
  }

  return mask;
}

// ---------------------------------------------------------------------------
// SV_TestEntityPosition (g_phys.cpp:64-74)
// ---------------------------------------------------------------------------

export function SV_TestEntityPosition(ent: EdictT): EdictT | null {
  const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, ent, G_GetClipMask(ent));

  if (trace.startsolid) return g_edicts[0];

  return null;
}

// ---------------------------------------------------------------------------
// SV_CheckVelocity (g_phys.cpp:81-90)
// ---------------------------------------------------------------------------

export function SV_CheckVelocity(ent: EdictT): void {
  const sv_maxvelocity = cvarOrDefault("sv_maxvelocity", "2000");

  const speed = vec3_length(ent.velocity);
  if (speed > sv_maxvelocity.value) {
    VectorCopy(vec3_muls(vec3_divs(ent.velocity, speed), sv_maxvelocity.value), ent.velocity);
  }
}

// ---------------------------------------------------------------------------
// SV_RunThink (g_phys.cpp:99-113)
// ---------------------------------------------------------------------------

/** Runs thinking code for this frame if necessary. */
export function SV_RunThink(ent: EdictT): boolean {
  const thinktime = ent.nextthink;
  if (thinktime <= GTIME_ZERO) return true;
  if (thinktime > level.time) return true;

  ent.nextthink = GTIME_ZERO;
  if (!ent.think) gi.Com_Error("nullptr ent->think");
  ent.think(ent);

  return false;
}

// ---------------------------------------------------------------------------
// G_Impact (g_phys.cpp:117-131)
// ---------------------------------------------------------------------------

/** Two entities have touched, so run their touch functions. */
export function G_Impact(e1: EdictT, trace: KexTraceT): void {
  const e2 = traceEdict(trace.ent);

  if (e1.touch && (e1.solid !== SolidT.SOLID_NOT || (e1.flags & EntFlagsT.FL_ALWAYS_TOUCH) !== 0n)) {
    e1.touch(e1, e2, trace, false);
  }

  if (e2.touch && (e2.solid !== SolidT.SOLID_NOT || (e2.flags & EntFlagsT.FL_ALWAYS_TOUCH) !== 0n)) {
    e2.touch(e2, e1, trace, true);
  }
}

// ---------------------------------------------------------------------------
// SV_FlyMove (g_phys.cpp:140-172)
// ---------------------------------------------------------------------------

/**
 * The basic solid body movement clip that slides along multiple planes.
 * Delegates to p_move.ts's PM_StepSlideMove_Generic -- see file header.
 */
export function SV_FlyMove(ent: EdictT, time: number, mask: ContentsT): void {
  ent.groundentity = null;

  const touch: KexTouchListT = { num: 0, traces: [] };
  const trace_func: PmTraceFn = (start, mins, maxs, end) => gi.trace(start, mins, maxs, end, ent, mask);

  PM_StepSlideMove_Generic(ent.s.origin, ent.velocity, time, ent.mins, ent.maxs, touch, false, trace_func);

  for (let i = 0; i < touch.num; i++) {
    const trace = touch.traces[i];

    if (trace.plane.normal[2] > 0.7) {
      const hit = traceEdict(trace.ent);
      ent.groundentity = hit;
      ent.groundentity_linkcount = hit.linkcount;
    }

    // run the impact function
    G_Impact(ent, trace);

    // impact func requested velocity kill
    if ((ent.flags & EntFlagsT.FL_KILL_VELOCITY) !== 0n) {
      ent.flags &= ~EntFlagsT.FL_KILL_VELOCITY;
      VectorCopy(vec3_origin, ent.velocity);
    }
  }
}

// ---------------------------------------------------------------------------
// SV_AddGravity (g_phys.cpp:180-183)
// ---------------------------------------------------------------------------

export function SV_AddGravity(ent: EdictT): void {
  vec3_addEq(ent.velocity, vec3_muls(ent.gravityVector, ent.gravity * level.gravity * gi.frame_time_s));
}

// ---------------------------------------------------------------------------
// PUSHMOVE
// ---------------------------------------------------------------------------

/** SV_PushEntity (g_phys.cpp:200-235). Does not change the entity's velocity at all. */
export function SV_PushEntity(ent: EdictT, push: Vec3): KexTraceT {
  const start = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  const end = vec3_add(start, push);

  const trace = gi.trace(start, ent.mins, ent.maxs, end, ent, G_GetClipMask(ent));

  VectorCopy(vec3_add(trace.endpos, vec3_muls(trace.plane.normal, 0.5)), ent.s.origin);
  gi.linkentity(ent);

  if (trace.fraction !== 1.0 || trace.startsolid) {
    G_Impact(ent, trace);

    // if the pushed entity went away and the pusher is still there
    const traceEnt = traceEdict(trace.ent);
    if (!traceEnt.inuse && ent.inuse) {
      // move the pusher back and try again
      VectorCopy(start, ent.s.origin);
      gi.linkentity(ent);
      return SV_PushEntity(ent, push);
    }
  }

  // PGM: FIXME - is this needed?
  ent.gravity = 1.0;

  if (ent.inuse) G_TouchTriggers(ent);

  return trace;
}

class PushedT {
  ent: EdictT | null = null;
  origin: Vec3 = vec3();
  angles: Vec3 = vec3();
  rotated = false;
  yaw = 0;
}

// `pushed_t pushed[MAX_EDICTS], *pushed_p;` -- file-scope C globals, not
// `extern`'d anywhere else, module-private here too. Per PORTING.md's
// array+index precedent (already used by the legacy port), the size is
// bounded generously and grown lazily rather than pre-sized to MAX_EDICTS
// up front, since MAX_EDICTS is a large constant and this array is
// reallocated fresh per test/process anyway.
const pushed: PushedT[] = [];
let pushed_p = 0;

function pushedSlot(i: number): PushedT {
  while (pushed.length <= i) pushed.push(new PushedT());
  return pushed[i];
}

/** `edict_t *obstacle;` -- also file-scope only, module-private mutable pointer. */
let obstacle: EdictT | null = null;

/**
 * SV_Push (g_phys.cpp:258-405). Objects need to be moved back on a failed
 * push, otherwise riders would continue to slide. See file header's
 * "SV_Push" deviation note for the removed 1/8-unit clamp, the `linked`
 * field swap, the disabled client delta_angles update, and the new
 * dead-player-skull non-blocking hack.
 */
export function SV_Push(pusher: EdictT, move: Vec3, amove: Vec3): boolean {
  // find the bounding box
  const mins = vec3_add(pusher.absmin, move);
  const maxs = vec3_add(pusher.absmax, move);

  // we need this for pushing things later
  const org = vec3_negate(amove);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(org, forward, right, up);

  // save the pusher's original position
  {
    const slot = pushedSlot(pushed_p);
    slot.ent = pusher;
    VectorCopy(pusher.s.origin, slot.origin);
    VectorCopy(pusher.s.angles, slot.angles);
    slot.rotated = false;
    pushed_p++;
  }

  // move the pusher to its final position
  vec3_addEq(pusher.s.origin, move);
  vec3_addEq(pusher.s.angles, amove);
  gi.linkentity(pusher);

  // see if any solid entities are inside the final position
  for (let e = 1; e < globals.num_edicts; e++) {
    const check = g_edicts[e];
    if (check === undefined || !check.inuse) continue;
    if (
      check.movetype === MovetypeT.MOVETYPE_PUSH ||
      check.movetype === MovetypeT.MOVETYPE_STOP ||
      check.movetype === MovetypeT.MOVETYPE_NONE ||
      check.movetype === MovetypeT.MOVETYPE_NOCLIP
    )
      continue;

    if (!check.linked) continue; // not linked in anywhere

    // if the entity is standing on the pusher, it will definitely be moved
    if (check.groundentity !== pusher) {
      // see if the ent needs to be tested
      if (
        check.absmin[0] >= maxs[0] ||
        check.absmin[1] >= maxs[1] ||
        check.absmin[2] >= maxs[2] ||
        check.absmax[0] <= mins[0] ||
        check.absmax[1] <= mins[1] ||
        check.absmax[2] <= mins[2]
      )
        continue;

      // see if the ent's bbox is inside the pusher's final position
      if (!SV_TestEntityPosition(check)) continue;
    }

    if (pusher.movetype === MovetypeT.MOVETYPE_PUSH || check.groundentity === pusher) {
      // move this entity
      const slot = pushedSlot(pushed_p);
      slot.ent = check;
      VectorCopy(check.s.origin, slot.origin);
      VectorCopy(check.s.angles, slot.angles);
      slot.rotated = amove[YAW] !== 0;
      if (slot.rotated) {
        // matches `pusher->client ? ... : pusher->s.angles[YAW]` -- always
        // keyed off the PUSHER's own client/angles, not the check entity's.
        slot.yaw = pusher.client !== null ? pusher.client.ps.pmove.delta_angles[YAW] : pusher.s.angles[YAW];
      }
      pushed_p++;

      const old_position = vec3(check.s.origin[0], check.s.origin[1], check.s.origin[2]);

      // try moving the contacted entity
      vec3_addEq(check.s.origin, move);
      if (check.client !== null) {
        // Paril: disabled because in vanilla delta_angles are never
        // lerped. delta_angles can probably be lerped as long as event
        // isn't EV_PLAYER_TELEPORT or a new RDF flag is set
        // check.client.ps.pmove.delta_angles[YAW] += amove[YAW];
      } else {
        check.s.angles[YAW] += amove[YAW];
      }

      // figure movement due to the pusher's amove
      const relOrg = vec3_sub(check.s.origin, pusher.s.origin);
      const org2 = vec3(vec3_dot(relOrg, forward), -vec3_dot(relOrg, right), vec3_dot(relOrg, up));
      const move2 = vec3_sub(org2, relOrg);
      vec3_addEq(check.s.origin, move2);

      // may have pushed them off an edge
      if (check.groundentity !== pusher) check.groundentity = null;

      let block = SV_TestEntityPosition(check);

      // [Paril-KEX] this is a bit of a hack; allow dead player skulls to be
      // a blocker because otherwise elevators/doors get stuck
      if (block && check.client !== null && !check.takedamage) {
        VectorCopy(old_position, check.s.origin);
        block = null;
      }

      if (!block) {
        // pushed ok
        gi.linkentity(check);
        // impact?
        continue;
      }

      // if it is ok to leave in the old position, do it.
      // this is only relevant for riding entities, not pushed
      VectorCopy(old_position, check.s.origin);
      block = SV_TestEntityPosition(check);
      if (!block) {
        pushed_p--;
        continue;
      }
    }

    // save off the obstacle so we can call the block function
    obstacle = check;

    // move back any entities we already moved
    // go backwards, so if the same entity was pushed
    // twice, it goes back to the original position
    for (let p = pushed_p - 1; p >= 0; p--) {
      const pe = pushed[p];
      const pent = pe.ent;
      if (pent === null) continue;
      VectorCopy(pe.origin, pent.s.origin);
      VectorCopy(pe.angles, pent.s.angles);
      if (pe.rotated) {
        pent.s.angles[YAW] = pe.yaw;
      }
      gi.linkentity(pent);
    }
    return false;
  }

  // FIXME: is there a better way to handle this?
  // see if anything we moved has touched a trigger
  for (let p = pushed_p - 1; p >= 0; p--) {
    const pent = pushed[p].ent;
    if (pent !== null) G_TouchTriggers(pent);
  }

  return true;
}

/**
 * SV_Physics_Pusher (g_phys.cpp:415-464). Bmodel objects don't interact with
 * each other, but push all box objects. See file header for the removed
 * nextthink-bump and the live `retry:` goto (ported as a loop + `continue`).
 */
export function SV_Physics_Pusher(ent: EdictT): void {
  // if not a team captain, movement will be handled elsewhere
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return;

  // make sure all team slaves can move before commiting any moves or
  // calling any think functions; if the move is blocked, all moved objects
  // will be backed out
  for (;;) {
    // retry:
    pushed_p = 0;
    let part: EdictT | null;
    for (part = ent; part; part = part.teamchain) {
      if (
        part.velocity[0] ||
        part.velocity[1] ||
        part.velocity[2] ||
        part.avelocity[0] ||
        part.avelocity[1] ||
        part.avelocity[2]
      ) {
        // object is moving
        const move = vec3_muls(part.velocity, gi.frame_time_s);
        const amove = vec3_muls(part.avelocity, gi.frame_time_s);

        if (!SV_Push(part, move, amove)) break; // move was blocked
      }
    }

    if (part) {
      // if the pusher has a "blocked" function, call it
      // otherwise, just stay in place until the obstacle is gone
      if (part.moveinfo.blocked && obstacle !== null) part.moveinfo.blocked(part, obstacle);

      if (obstacle !== null && !obstacle.inuse) continue; // goto retry
      return;
    } else {
      // the move succeeded, so call all think functions
      for (part = ent; part; part = part.teamchain) {
        // prevent entities that are on trains that have gone away from thinking!
        if (part.inuse) SV_RunThink(part);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// SV_Physics_None / SV_Physics_Noclip (g_phys.cpp:475-498)
// ---------------------------------------------------------------------------

/** Non moving objects can only think. */
export function SV_Physics_None(ent: EdictT): void {
  SV_RunThink(ent);
}

/** A moving object that doesn't obey physics. */
export function SV_Physics_Noclip(ent: EdictT): void {
  if (!SV_RunThink(ent) || !ent.inuse) return;

  vec3_addEq(ent.s.angles, vec3_muls(ent.avelocity, gi.frame_time_s));
  vec3_addEq(ent.s.origin, vec3_muls(ent.velocity, gi.frame_time_s));

  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// TOSS / BOUNCE (g_phys.cpp:515-687)
// ---------------------------------------------------------------------------

/** Toss, bounce, and fly movement. When onground, do nothing. */
export function SV_Physics_Toss(ent: EdictT): void {
  // regular thinking
  SV_RunThink(ent);
  if (!ent.inuse) return;

  // if not a team captain, movement will be handled elsewhere
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return;

  if (ent.velocity[2] > 0) ent.groundentity = null;

  // check for the groundentity going away
  if (ent.groundentity && !ent.groundentity.inuse) ent.groundentity = null;

  // if onground, return without moving
  if (ent.groundentity && ent.gravity > 0.0) {
    // PGM - gravity hack
    if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) {
      M_CatagorizePosition(ent, ent.s.origin);
      M_WorldEffects(ent);
    }
    return;
  }

  const old_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

  SV_CheckVelocity(ent);

  // add gravity
  if (
    ent.movetype !== MovetypeT.MOVETYPE_FLY &&
    ent.movetype !== MovetypeT.MOVETYPE_FLYMISSILE &&
    // RAFAEL: move type for rippergun projectile
    ent.movetype !== MovetypeT.MOVETYPE_WALLBOUNCE
  ) {
    SV_AddGravity(ent);
  }

  // move angles
  vec3_addEq(ent.s.angles, vec3_muls(ent.avelocity, gi.frame_time_s));

  // move origin
  let num_tries = 5;
  let time_left = gi.frame_time_s;
  let backoff: number;

  while (time_left) {
    if (num_tries === 0) break;
    num_tries--;

    const move = vec3_muls(ent.velocity, time_left);
    const trace = SV_PushEntity(ent, move);

    if (!ent.inuse) return;

    if (trace.fraction === 1.0) break;
    // [Paril-KEX] don't build up velocity if we're stuck. just assume that
    // the object we hit is our ground.
    else if (trace.allsolid) {
      const groundEnt = traceEdict(trace.ent);
      ent.groundentity = groundEnt;
      ent.groundentity_linkcount = groundEnt.linkcount;
      VectorCopy(vec3_origin, ent.velocity);
      VectorCopy(vec3_origin, ent.avelocity);
      break;
    }

    time_left -= time_left * trace.fraction;

    if (ent.movetype === MovetypeT.MOVETYPE_TOSS) {
      VectorCopy(SlideClipVelocity(ent.velocity, trace.plane.normal, 0.5), ent.velocity);
    } else {
      // RAFAEL
      if (ent.movetype === MovetypeT.MOVETYPE_WALLBOUNCE) backoff = 2.0;
      else backoff = 1.6;

      VectorCopy(ClipVelocity(ent.velocity, trace.plane.normal, backoff), ent.velocity);
    }

    // RAFAEL
    if (ent.movetype === MovetypeT.MOVETYPE_WALLBOUNCE) {
      VectorCopy(vectoangles(ent.velocity), ent.s.angles);
    } else {
      // stop if on ground
      if (trace.plane.normal[2] > 0.7) {
        const restingSlow =
          (ent.movetype === MovetypeT.MOVETYPE_TOSS && vec3_length(ent.velocity) < 60) ||
          (ent.movetype !== MovetypeT.MOVETYPE_TOSS && vec3_length(vec3_scaled(ent.velocity, trace.plane.normal)) < 60);

        if (restingSlow) {
          const groundEnt = traceEdict(trace.ent);
          if ((ent.flags & EntFlagsT.FL_NO_STANDING) === 0n || groundEnt.solid === SolidT.SOLID_BSP) {
            ent.groundentity = groundEnt;
            ent.groundentity_linkcount = groundEnt.linkcount;
          }
          VectorCopy(vec3_origin, ent.velocity);
          VectorCopy(vec3_origin, ent.avelocity);
          break;
        }

        // friction for tossing stuff (gibs, etc)
        if (ent.movetype === MovetypeT.MOVETYPE_TOSS) {
          vec3_mulEqs(ent.velocity, 0.75);
          vec3_mulEqs(ent.avelocity, 0.75);
        }
      }
    }

    // only toss "slides" multiple times
    if (ent.movetype !== MovetypeT.MOVETYPE_TOSS) break;
  }

  // check for water transition
  const wasinwater = (ent.watertype & MASK_WATER) !== 0;
  ent.watertype = gi.pointcontents(ent.s.origin);
  const isinwater = (ent.watertype & MASK_WATER) !== 0;

  if (isinwater) ent.waterlevel = WaterLevelT.WATER_FEET;
  else ent.waterlevel = WaterLevelT.WATER_NONE;

  if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    M_CatagorizePosition(ent, ent.s.origin);
    M_WorldEffects(ent);
  } else {
    if (!wasinwater && isinwater) {
      gi.positioned_sound(old_origin, g_edicts[0], SoundchanT.CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
    } else if (wasinwater && !isinwater) {
      gi.positioned_sound(ent.s.origin, g_edicts[0], SoundchanT.CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
    }
  }

  // prevent softlocks from keys falling into slime/lava
  if (
    isinwater &&
    (ent.watertype & (ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_LAVA)) !== 0 &&
    ent.item !== null &&
    (ent.item.flags & ItemFlagsT.IF_KEY) !== 0 &&
    SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)
  ) {
    VectorCopy(vec3(crandom_open() * 300, crandom_open() * 300, 300 + crandom_open() * 300), ent.velocity);
  }

  // move teamslaves
  for (let slave = ent.teamchain; slave; slave = slave.teamchain) {
    VectorCopy(ent.s.origin, slave.s.origin);
    gi.linkentity(slave);
  }
}

// ---------------------------------------------------------------------------
// STEPPING MOVEMENT (g_phys.cpp:697-877)
// ---------------------------------------------------------------------------

// `constexpr float sv_friction = 6; constexpr float sv_waterfriction = 1;`
// (g_local.h:2498-2499) -- plain constants, NOT cvars, unlike sv_stopspeed.
const sv_friction = 6;
const sv_waterfriction = 1;

export function SV_AddRotationalFriction(ent: EdictT): void {
  vec3_addEq(ent.s.angles, vec3_muls(ent.avelocity, gi.frame_time_s));

  const sv_stopspeed = cvarOrDefault("sv_stopspeed", "100");
  const adjustment = gi.frame_time_s * sv_stopspeed.value * sv_friction;

  for (let n = 0; n < 3; n++) {
    if (ent.avelocity[n] > 0) {
      ent.avelocity[n] -= adjustment;
      if (ent.avelocity[n] < 0) ent.avelocity[n] = 0;
    } else {
      ent.avelocity[n] += adjustment;
      if (ent.avelocity[n] > 0) ent.avelocity[n] = 0;
    }
  }
}

/**
 * Monsters freefall when they don't have a ground entity, otherwise all
 * movement is done with discrete steps. Also used for objects that have
 * become still on the ground, but will fall if the floor is pulled out from
 * under them.
 */
export function SV_Physics_Step(ent: EdictT): void {
  let hitsound = false;
  const mask = G_GetClipMask(ent);

  // airborne monsters should always check for ground
  if (!ent.groundentity) M_CheckGround(ent, mask);

  const groundentity = ent.groundentity;

  SV_CheckVelocity(ent);

  const wasonground = !!groundentity;

  if (ent.avelocity[0] || ent.avelocity[1] || ent.avelocity[2]) SV_AddRotationalFriction(ent);

  // FIXME: figure out how or why this is happening
  if (Number.isNaN(ent.velocity[0]) || Number.isNaN(ent.velocity[1]) || Number.isNaN(ent.velocity[2])) {
    VectorCopy(vec3_origin, ent.velocity);
  }

  // add gravity except:
  //   flying monsters
  //   swimming monsters who are in the water
  if (!wasonground) {
    if ((ent.flags & EntFlagsT.FL_FLY) === 0n) {
      if (!((ent.flags & EntFlagsT.FL_SWIM) !== 0n && ent.waterlevel > WaterLevelT.WATER_WAIST)) {
        if (ent.velocity[2] < level.gravity * -0.1) hitsound = true;
        if (ent.waterlevel !== WaterLevelT.WATER_UNDER) SV_AddGravity(ent);
      }
    }
  }

  // friction for flying monsters that have been given vertical velocity
  if (
    (ent.flags & EntFlagsT.FL_FLY) !== 0n &&
    ent.velocity[2] !== 0 &&
    (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) === 0n
  ) {
    const speed = Math.abs(ent.velocity[2]);
    const sv_stopspeed = cvarOrDefault("sv_stopspeed", "100");
    const control = speed < sv_stopspeed.value ? sv_stopspeed.value : speed;
    const friction = sv_friction / 3;
    let newspeed = speed - gi.frame_time_s * control * friction;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    ent.velocity[2] *= newspeed;
  }

  // friction for swimming monsters that have been given vertical velocity
  if (
    (ent.flags & EntFlagsT.FL_SWIM) !== 0n &&
    ent.velocity[2] !== 0 &&
    (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) === 0n
  ) {
    const speed = Math.abs(ent.velocity[2]);
    const sv_stopspeed = cvarOrDefault("sv_stopspeed", "100");
    const control = speed < sv_stopspeed.value ? sv_stopspeed.value : speed;
    let newspeed = speed - gi.frame_time_s * control * sv_waterfriction * ent.waterlevel;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    ent.velocity[2] *= newspeed;
  }

  if (ent.velocity[2] || ent.velocity[1] || ent.velocity[0]) {
    // apply friction
    if (
      (wasonground || (ent.flags & (EntFlagsT.FL_SWIM | EntFlagsT.FL_FLY)) !== 0n) &&
      (ent.monsterinfo.aiflags & MonsterAiFlagsT.AI_ALTERNATE_FLY) === 0n
    ) {
      const vel = ent.velocity;
      const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1]);
      if (speed) {
        let friction = sv_friction;

        // Paril: lower friction for dead monsters
        if (ent.deadflag) friction *= 0.5;

        const sv_stopspeed = cvarOrDefault("sv_stopspeed", "100");
        const control = speed < sv_stopspeed.value ? sv_stopspeed.value : speed;
        let newspeed = speed - gi.frame_time_s * control * friction;

        if (newspeed < 0) newspeed = 0;
        newspeed /= speed;

        vel[0] *= newspeed;
        vel[1] *= newspeed;
      }
    }

    const old_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

    SV_FlyMove(ent, gi.frame_time_s, mask);

    G_TouchProjectiles(ent, old_origin);

    M_CheckGround(ent, mask);

    gi.linkentity(ent);

    // PGM - reset this every time they move. G_TouchTriggers will set it
    // back if appropriate
    ent.gravity = 1.0;

    // [Paril-KEX] this is something N64 does to avoid doors opening at the
    // start of a level, which triggers some monsters to spawn.
    if (!level.is_n64 || level.time > frameTimeAsGtime()) G_TouchTriggers(ent);

    if (!ent.inuse) return;

    if (ent.groundentity && !wasonground && hitsound) ent.s.event = KexEntityEventT.EV_FOOTSTEP;
  }

  if (!ent.inuse) return; // PGM g_touchtrigger free problem

  if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    M_CatagorizePosition(ent, ent.s.origin);
    M_WorldEffects(ent);

    // [Paril-KEX] last minute hack to fix Stalker upside down gravity
    if (wasonground !== !!ent.groundentity) {
      if (ent.monsterinfo.physics_change) ent.monsterinfo.physics_change(ent);
    }
  }

  // regular thinking
  SV_RunThink(ent);
}

// ---------------------------------------------------------------------------
// G_RunBmodelAnimation (g_phys.cpp:880-937) -- [Paril-KEX], entirely new
// ---------------------------------------------------------------------------

function G_RunBmodelAnimation(ent: EdictT): void {
  const anim = ent.bmodel_anim;

  if (anim.currently_alternate !== anim.alternate) {
    anim.currently_alternate = anim.alternate;
    anim.next_tick = GTIME_ZERO;
  }

  if (level.time < anim.next_tick) return;

  const speed = anim.alternate ? anim.alt_speed : anim.speed;
  anim.next_tick = Gtime_add(level.time, Gtime_from_ms(speed));

  const style = anim.alternate ? anim.alt_style : anim.style;
  const start = anim.alternate ? anim.alt_start : anim.start;
  const end = anim.alternate ? anim.alt_end : anim.end;

  switch (style) {
    case BmodelAnimstyleT.BMODEL_ANIM_FORWARDS:
      if (end >= start) ent.s.frame++;
      else ent.s.frame--;
      break;
    case BmodelAnimstyleT.BMODEL_ANIM_BACKWARDS:
      if (end >= start) ent.s.frame--;
      else ent.s.frame++;
      break;
    case BmodelAnimstyleT.BMODEL_ANIM_RANDOM:
      ent.s.frame = irandom(start, end + 1);
      break;
  }

  const nowrap = anim.alternate ? anim.alt_nowrap : anim.nowrap;

  if (nowrap) {
    if (end >= start) ent.s.frame = clamp(ent.s.frame, start, end);
    else ent.s.frame = clamp(ent.s.frame, end, start);
  } else {
    if (ent.s.frame < start) ent.s.frame = end;
    else if (ent.s.frame > end) ent.s.frame = start;
  }
}

// ---------------------------------------------------------------------------
// G_RunEntity (g_phys.cpp:947-1041)
// ---------------------------------------------------------------------------

export function G_RunEntity(ent: EdictT): void {
  let previous_origin: Vec3 | null = null;

  if (ent.movetype === MovetypeT.MOVETYPE_STEP) {
    previous_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  }

  if (ent.prethink) ent.prethink(ent);

  // bmodel animation stuff runs first, so custom entities can override them
  if (ent.bmodel_anim.enabled) G_RunBmodelAnimation(ent);

  switch (ent.movetype) {
    case MovetypeT.MOVETYPE_PUSH:
    case MovetypeT.MOVETYPE_STOP:
      SV_Physics_Pusher(ent);
      break;
    case MovetypeT.MOVETYPE_NONE:
      SV_Physics_None(ent);
      break;
    case MovetypeT.MOVETYPE_NOCLIP:
      SV_Physics_Noclip(ent);
      break;
    case MovetypeT.MOVETYPE_STEP:
      SV_Physics_Step(ent);
      break;
    case MovetypeT.MOVETYPE_TOSS:
    case MovetypeT.MOVETYPE_BOUNCE:
    case MovetypeT.MOVETYPE_FLY:
    case MovetypeT.MOVETYPE_FLYMISSILE:
    // RAFAEL
    case MovetypeT.MOVETYPE_WALLBOUNCE:
      SV_Physics_Toss(ent);
      break;
    // ROGUE
    case MovetypeT.MOVETYPE_NEWTOSS:
      SV_Physics_NewToss(ent);
      break;
    // ROGUE
    default:
      gi.Com_Error(`SV_Physics: bad movetype ${ent.movetype}`);
  }

  // PGM
  if (previous_origin !== null && ent.movetype === MovetypeT.MOVETYPE_STEP) {
    // if we moved, check and fix origin if needed
    if (!vec3_equals(ent.s.origin, previous_origin)) {
      const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, previous_origin, ent, G_GetClipMask(ent));
      if (trace.allsolid || trace.startsolid) VectorCopy(previous_origin, ent.s.origin);
    }
  }
  // PGM

  // disintegrator stuff (g_phys.cpp:1015-1037) is `#if 0`'d out in the C++
  // source -- dropped per PORTING.md's "#if 0 blocks are dropped silently".

  if (ent.postthink) ent.postthink(ent);
}

// ---------------------------------------------------------------------------
// CROSS-DEPENDENCIES NOT YET PORTED -- see file header
// ---------------------------------------------------------------------------

function SV_Physics_NewToss(ent: EdictT): void {
  throw new Error(
    `SV_Physics_NewToss: not yet ported (rogue mission-pack only, see rerelease/rogue/g_rogue_phys.cpp; forward-declared but not defined in g_phys.cpp) -- called against ${ent.classname ?? "?"}`,
  );
}
