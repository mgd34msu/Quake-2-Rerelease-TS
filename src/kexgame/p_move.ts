// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_move.cpp -- the KEX player movement code (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/p_move.cpp (1,708 lines, C++17).
// This is exported by BOTH the game module and the cgame module (see
// ./bg_local.ts's "THE TRACE SEAM" note).
//
// BEHAVIORAL PORT: bug-for-bug fidelity per PORTING.md -- every quirk below is
// cited against the exact C++ lines it preserves. No "improvements".
//
// ============================================================================
// FULL FLOAT POSITIONS -- NOT the legacy 1/8-unit pmove
// ============================================================================
// This is the KEX contract (see ../kexapi/game.ts's `KexPmoveStateT`: "kex ...
// uses float (not fixed 12.3 int16) origin and velocity"). `pml.origin` /
// `pml.velocity` / `pm->s.origin` / `pm->s.velocity` are plain `Vec3`
// (Float32Array) values throughout; nothing here rounds to 1/8-unit
// increments, and none of the legacy `src/qcommon/pmove.ts` helpers are
// imported or reused, per the brief.
//
// ============================================================================
// NO MODULE-GLOBAL `pm` / `pml` -- closures instead
// ============================================================================
// The C++ source keeps `pmove_t *pm` and `pml_t pml` as FILE-SCOPE globals
// that every `PM_*` function reaches into directly; `Pmove()` just reassigns
// `pm = pmove;` and zeroes `pml` at the top of every call. Per the brief's
// explicit instruction for the trace-function seam ("preserve ... as a
// function parameter/config object, NOT a module-global import"), and to
// avoid re-introducing the exact same anti-pattern for the REST of the
// per-call state (which would make this module's internal helpers
// unavoidably stateful and non-reentrant, unlike everything else in this
// port), `pm` (the caller's `KexPmoveT`), `pml` (this call's local movement
// state, mirroring `pml_t`), and `config` (`PmConfigT`, see bg_local.ts) are
// declared as ordinary local variables at the top of the exported `Pmove()`
// function, and every `PM_*` helper below is a nested function CLOSING OVER
// those three locals -- never reading a module-level mutable value. Two
// functions (`PM_StepSlideMove_Generic`, `G_FixStuckObject_Generic`) are
// genuinely stateless per the C++ header's own declared signature (bg_local.h
// takes `trace` as an explicit parameter for both) and are ported as ordinary
// top-level exported functions, exactly mirroring that signature.
//
// ============================================================================
// PM_ClipVelocity -> reused as q_vec3.ts's SlideClipVelocity (verified identical)
// ============================================================================
// p_move.cpp declares its OWN local `PM_ClipVelocity(in, normal, out,
// overbounce)`:
//   backoff = in.dot(normal) * overbounce;
//   for (i=0;i<3;i++) { out[i] = in[i] - normal[i]*backoff; if (|out[i]| <
//   STOP_EPSILON) out[i] = 0; }
// q_vec3.ts's `SlideClipVelocity(inVec, normal, overbounce)` (ported earlier
// from q_vec3.h, a SEPARATE C++ source file) implements the exact same
// formula, just returning a fresh value instead of writing through an
// out-param -- verified line-by-line: `backoff = dot*overbounce; out = in -
// normal*backoff`, then the identical per-component `STOP_EPSILON` zeroing
// loop. (q_vec3.h ALSO has a *different*, unrelated function confusingly also
// named `ClipVelocity` -- a reflection formula, `out = (in +
// normal*(-2*dot))*(overbounce-1)` -- already ported as q_vec3.ts's
// `ClipVelocity`; that one is NOT used here, since it is not what
// `PM_ClipVelocity` in p_move.cpp actually computes.) Every `PM_ClipVelocity`
// call site below therefore calls `SlideClipVelocity` directly rather than
// duplicating a byte-identical local copy; call sites that used the C++
// out-param to write back into their own input variable (`PM_ClipVelocity(v,
// n, v, k)`) instead reassign: `v = SlideClipVelocity(v, n, k)`.
//
// ============================================================================
// G_AddBlend -- now in q_std.ts (2026-08-30 cleanup sweep)
// ============================================================================
// Previously ported as a local, non-exported copy in this file (q_std.h
// deferred it; this unit's file list was fixed to bg_local.ts/p_move.ts/the
// test file only). p_view.ts later needed the same function and carried its
// own identical local copy for the same reason. Consolidated into q_std.ts
// per both files' header notes; imported from there now.
//
// ============================================================================
// PRESERVED QUIRKS (bug-for-bug, cited)
// ============================================================================
// 1. G_FixStuckObject_Generic's `good_positions` sort is a genuine off-by-one
//    in the C++ source (p_move.cpp:144-150):
//      std::sort(&good_positions[0], &good_positions[num_good_positions - 1], ...)
//    `std::sort(first, last)` sorts the HALF-OPEN range [first, last) --
//    passing `&arr[num-1]` as `last` means the sort only ever touches indices
//    [0, num-2]; the LAST candidate found (index num-1) is never compared
//    against anything and is left exactly where it was appended, even if it
//    has the smallest `distance` of all of them. `good_positions[0]` (whatever
//    ends up there after that partial sort) is used unconditionally
//    afterward. Reproduced exactly below: only `good_positions.slice(0, n-1)`
//    is sorted; index `n-1` is left untouched.
// 2. PM_GetWaterLevel takes a `position` parameter but only uses it for the
//    FIRST (WATER_FEET) sample point (p_move.cpp:940-942); the two deeper
//    samples (WATER_WAIST / WATER_UNDER, p_move.cpp:950,955) read `pml.origin`
//    directly instead of the parameter, even though the function is called
//    with a DIFFERENT vector in `PM_CheckSpecialMovement`
//    (`PM_GetWaterLevel(trace.endpos, ...)`, p_move.cpp:1192) than in
//    `PM_CatagorizePosition` (`PM_GetWaterLevel(pml.origin, ...)`,
//    p_move.cpp:1056). Reproduced exactly below -- `PM_GetWaterLevel` is a
//    closure over `pml`, so this falls out naturally without any extra
//    plumbing.
// 3. Landing-trick and stair-clip thresholds, `pm_config.n64_physics`
//    branching, and every magic constant (JUMP height 270, STEPSIZE reused
//    from ../kexapi/game.ts, MIN_STEP_NORMAL 0.7, trick-jump velocity/time
//    thresholds 100/0.9/64, PMF_TIME_LAND time 128, waterjump time 2048, ...)
//    are transcribed exactly, each cited at its call site below.
//
// ============================================================================
// DEVIATION (not a preserved quirk -- a real behavior choice, reported)
// ============================================================================
// PM_StepSlideMove_Generic's "duplicate clip plane" branch (p_move.cpp:371-380)
// nudges `pml.origin` -- the FILE-SCOPE GLOBAL -- directly, instead of the
// `origin` reference parameter the function itself operates on everywhere
// else, DESPITE the function's own doc comment two lines above its definition
// (p_move.cpp:280-282): "made generic so you can run this without needing a
// pml/pm". Every other line in the function reads/writes only `origin`/
// `velocity`/`mins`/`maxs`/`touch`/`trace_func` -- this one is the sole
// exception, and it is observably different from "nudge `origin`" at exactly
// one real call site: `PM_CheckSpecialMovement`'s water-jump dry-run
// simulation (p_move.cpp:1173), which passes a LOCAL `waterjump_origin` that
// is NOT `pml.origin`. In the real engine, hitting this branch during that
// 0.1s-step simulate-ahead loop would incorrectly perturb the LIVE player
// origin by a few hundredths of a unit instead of the throwaway simulation
// vector. Since this port's `PM_StepSlideMove_Generic` has the exact
// parameterized signature bg_local.h declares (no `pml` in scope at all -- see
// "NO MODULE-GLOBAL pm/pml" above), faithfully reproducing this exact
// aliasing bug would require reintroducing a real mutable module-global
// purely to carry it, which is precisely the anti-pattern this unit's brief
// says to avoid. This port nudges the `origin` PARAMETER instead (matching
// the function's own stated intent, and matching its ONE common call site,
// `PM_StepSlideMove_()`, exactly, since there `origin === pml.origin` by
// construction anyway). Net effect: identical to the C++ source on every real
// player-movement frame; differs only inside the water-jump feasibility
// simulation, and only in the rare case where that simulation's step-slide
// hits the same clip plane twice in one step -- flagged here for the record,
// not silently "improved".

import { vec3, VectorCopy, type Vec3 } from "../shared/math";
import { PITCH, YAW, ROLL, clamp, G_AddBlend } from "./q_std";
import {
  vec3_add,
  vec3_sub,
  vec3_muls,
  vec3_mulEqs,
  vec3_addEq,
  vec3_dot,
  vec3_cross,
  vec3_normalize,
  vec3_length,
  vec3_lengthSquared,
  SlideClipVelocity,
  AngleVectors,
} from "./q_vec3";
import {
  type KexPmoveT,
  type KexTraceT,
  type KexTouchListT,
  type KexCsurfaceT,
  ContentsT,
  MASK_SOLID,
  MASK_DEADSOLID,
  MASK_PLAYERSOLID,
  MASK_WATER,
  MASK_CURRENT,
  SurfflagsT,
  WaterLevelT,
  KexPmTypeT,
  PmflagsT,
  ButtonT,
  RefdefFlagsT,
  MAXTOUCH,
  STEPSIZE,
} from "../kexapi/game";
import { StuckResultT } from "./g_local";
import { PM_CONFIG_DEFAULT, type PmConfigT, type PmTraceFn, type StuckObjectTraceFn } from "./bg_local";

// ---------------------------------------------------------------------------
// movement tuning constants (p_move.cpp:181-189) -- plain file-scope
// constants in the C++ source too (never mutated anywhere in this file), so
// module-level `const` here carries no "hidden state" risk unlike `pm`/`pml`.
// ---------------------------------------------------------------------------

const pm_stopspeed = 100;
const pm_maxspeed = 300;
const pm_duckspeed = 100;
const pm_accelerate = 10;
const pm_wateraccelerate = 10;
const pm_friction = 6;
const pm_waterfriction = 1;
const pm_waterspeed = 400;
const pm_laddermod = 0.5;

const MIN_STEP_NORMAL = 0.7; // p_move.cpp:265 -- can't step up onto very steep slopes
const MAX_CLIP_PLANES = 5; // p_move.cpp:266

// ---------------------------------------------------------------------------
// G_FixStuckObject_Generic (p_move.cpp:9-154)
// ---------------------------------------------------------------------------

interface SideCheck {
  readonly normal: readonly [number, number, number];
  readonly mins: readonly [number, number, number];
  readonly maxs: readonly [number, number, number];
}

/** p_move.cpp:21-31 `side_checks[]`. */
const SIDE_CHECKS: readonly SideCheck[] = [
  { normal: [0, 0, 1], mins: [-1, -1, 0], maxs: [1, 1, 0] },
  { normal: [0, 0, -1], mins: [-1, -1, 0], maxs: [1, 1, 0] },
  { normal: [1, 0, 0], mins: [0, -1, -1], maxs: [0, 1, 1] },
  { normal: [-1, 0, 0], mins: [0, -1, -1], maxs: [0, 1, 1] },
  { normal: [0, 1, 0], mins: [-1, 0, -1], maxs: [1, 0, 1] },
  { normal: [0, -1, 0], mins: [-1, 0, -1], maxs: [1, 0, 1] },
];

/**
 * p_move.cpp:9-154. Attempts to un-stick `origin` (mutated in place, matching
 * the C++ `vec3_t &origin` reference parameter) by probing six axis-aligned
 * directions for clearance. See file header's preserved-quirk (1) for the
 * sort-range off-by-one this reproduces exactly.
 */
export function G_FixStuckObject_Generic(origin: Vec3, own_mins: Vec3, own_maxs: Vec3, trace: StuckObjectTraceFn): StuckResultT {
  if (!trace(origin, own_mins, own_maxs, origin).startsolid) {
    return StuckResultT.GOOD_POSITION;
  }

  const good_positions: { distance: number; origin: Vec3 }[] = [];

  for (let sn = 0; sn < SIDE_CHECKS.length; sn++) {
    const side = SIDE_CHECKS[sn];
    let start = vec3(origin[0], origin[1], origin[2]);
    const mins = vec3(0, 0, 0);
    const maxs = vec3(0, 0, 0);

    for (let n = 0; n < 3; n++) {
      if (side.normal[n] < 0) start[n] += own_mins[n];
      else if (side.normal[n] > 0) start[n] += own_maxs[n];

      if (side.mins[n] === -1) mins[n] = own_mins[n];
      else if (side.mins[n] === 1) mins[n] = own_maxs[n];

      if (side.maxs[n] === -1) maxs[n] = own_mins[n];
      else if (side.maxs[n] === 1) maxs[n] = own_maxs[n];
    }

    let tr = trace(start, mins, maxs, start);

    let needed_epsilon_fix = -1;
    let needed_epsilon_dir = 0;

    if (tr.startsolid) {
      for (let e = 0; e < 3; e++) {
        if (side.normal[e] !== 0) continue;

        const ep_start = vec3(start[0], start[1], start[2]);
        ep_start[e] += 1;

        tr = trace(ep_start, mins, maxs, ep_start);

        if (!tr.startsolid) {
          start = ep_start;
          needed_epsilon_fix = e;
          needed_epsilon_dir = 1;
          break;
        }

        ep_start[e] -= 2;
        tr = trace(ep_start, mins, maxs, ep_start);

        if (!tr.startsolid) {
          start = ep_start;
          needed_epsilon_fix = e;
          needed_epsilon_dir = -1;
          break;
        }
      }
    }

    // no good
    if (tr.startsolid) continue;

    const opposite_start = vec3(origin[0], origin[1], origin[2]);
    const other_side = SIDE_CHECKS[sn ^ 1];

    for (let n = 0; n < 3; n++) {
      if (other_side.normal[n] < 0) opposite_start[n] += own_mins[n];
      else if (other_side.normal[n] > 0) opposite_start[n] += own_maxs[n];
    }

    if (needed_epsilon_fix >= 0) opposite_start[needed_epsilon_fix] += needed_epsilon_dir;

    // potentially a good side; start from our center, push back to the
    // opposite side to find how much clearance we have
    tr = trace(start, mins, maxs, opposite_start);

    // ???
    if (tr.startsolid) continue;

    // check the delta
    const end = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    // push us very slightly away from the wall
    end[0] += side.normal[0] * 0.125;
    end[1] += side.normal[1] * 0.125;
    end[2] += side.normal[2] * 0.125;

    // calculate delta
    const delta = vec3_sub(end, opposite_start);
    const new_origin = vec3_add(origin, delta);

    if (needed_epsilon_fix >= 0) new_origin[needed_epsilon_fix] += needed_epsilon_dir;

    tr = trace(new_origin, own_mins, own_maxs, new_origin);

    // bad
    if (tr.startsolid) continue;

    good_positions.push({ origin: new_origin, distance: vec3_lengthSquared(delta) });
  }

  if (good_positions.length > 0) {
    // See file header preserved-quirk (1): only indices [0, n-2] are ever
    // sorted; index n-1 is left exactly where it was appended.
    const n = good_positions.length;
    if (n > 1) {
      const sortable = good_positions.slice(0, n - 1);
      sortable.sort((a, b) => a.distance - b.distance);
      for (let i = 0; i < sortable.length; i++) good_positions[i] = sortable[i];
    }

    VectorCopy(good_positions[0].origin, origin);

    return StuckResultT.FIXED;
  }

  return StuckResultT.NO_GOOD_POSITION;
}

// ---------------------------------------------------------------------------
// PM_RecordTrace (p_move.cpp:268-278)
// ---------------------------------------------------------------------------

function PM_RecordTrace(touch: KexTouchListT, tr: KexTraceT): void {
  if (touch.num === MAXTOUCH) return;

  for (let i = 0; i < touch.num; i++) {
    if (touch.traces[i].ent === tr.ent) return;
  }

  touch.traces[touch.num] = tr;
  touch.num++;
}

// ---------------------------------------------------------------------------
// PM_StepSlideMove_Generic (p_move.cpp:280-434)
// ---------------------------------------------------------------------------

/**
 * p_move.cpp:280-434. "[Paril-KEX] made generic so you can run this without
 * needing a pml/pm." Mutates `origin`/`velocity` in place (C++ reference
 * params). See file header's "DEVIATION" note for the one place this
 * knowingly does not reproduce the C++ source's `pml.origin` aliasing bug.
 */
export function PM_StepSlideMove_Generic(
  origin: Vec3,
  velocity: Vec3,
  frametime: number,
  mins: Vec3,
  maxs: Vec3,
  touch: KexTouchListT,
  has_time: boolean,
  trace_func: PmTraceFn,
): void {
  const numbumps = 4;
  const primal_velocity = vec3(velocity[0], velocity[1], velocity[2]);
  let numplanes = 0;
  const planes: Vec3[] = [];
  let time_left = frametime;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    const end = vec3(origin[0] + time_left * velocity[0], origin[1] + time_left * velocity[1], origin[2] + time_left * velocity[2]);

    let trace = trace_func(origin, mins, maxs, end);

    if (trace.allsolid) {
      // entity is trapped in another solid
      velocity[2] = 0; // don't build up falling damage
      PM_RecordTrace(touch, trace);
      return;
    }

    // [Paril-KEX] experimental attempt to fix stray collisions on curved
    // surfaces; easiest to see on q2dm1 by running/jumping against the sides
    // of the curved map.
    if (trace.surface2) {
      const clipped_a = SlideClipVelocity(velocity, trace.plane.normal, 1.01);
      const clipped_b = SlideClipVelocity(velocity, trace.plane2.normal, 1.01);

      let better = false;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(clipped_a[i]) < Math.abs(clipped_b[i])) {
          better = true;
          break;
        }
      }

      if (better) {
        trace.plane = trace.plane2;
        trace.surface = trace.surface2;
      }
    }

    if (trace.fraction > 0) {
      // actually covered some distance
      VectorCopy(trace.endpos, origin);
      numplanes = 0;
    }

    if (trace.fraction === 1) break; // moved the entire distance

    // save entity for contact
    PM_RecordTrace(touch, trace);

    time_left -= time_left * trace.fraction;

    // slide along this plane
    if (numplanes >= MAX_CLIP_PLANES) {
      // this shouldn't really happen
      velocity[0] = velocity[1] = velocity[2] = 0;
      break;
    }

    // if this is the same plane we hit before, nudge origin out along it,
    // which fixes some epsilon issues with non-axial planes (xswamp, q2dm1
    // sometimes...)
    let i = 0;
    let hitDuplicate = false;
    for (i = 0; i < numplanes; i++) {
      if (vec3_dot(trace.plane.normal, planes[i]) > 0.99) {
        // See file header "DEVIATION": C++ nudges the file-scope `pml.origin`
        // global here; this ports nudging the `origin` parameter instead.
        origin[0] += trace.plane.normal[0] * 0.01;
        origin[1] += trace.plane.normal[1] * 0.01;
        G_FixStuckObject_Generic(origin, mins, maxs, trace_func);
        hitDuplicate = true;
        break;
      }
    }

    if (hitDuplicate) continue;

    planes[numplanes] = vec3(trace.plane.normal[0], trace.plane.normal[1], trace.plane.normal[2]);
    numplanes++;

    // modify original_velocity so it parallels all of the clip planes
    for (i = 0; i < numplanes; i++) {
      const clipped = SlideClipVelocity(velocity, planes[i], 1.01);
      VectorCopy(clipped, velocity);

      let j = 0;
      for (j = 0; j < numplanes; j++) {
        if (j !== i) {
          if (vec3_dot(velocity, planes[j]) < 0) break; // not ok
        }
      }
      if (j === numplanes) break;
    }

    if (i !== numplanes) {
      // go along this plane
    } else {
      // go along the crease
      if (numplanes !== 2) {
        velocity[0] = velocity[1] = velocity[2] = 0;
        break;
      }
      const dir = vec3_cross(planes[0], planes[1]);
      const d = vec3_dot(dir, velocity);
      VectorCopy(vec3_muls(dir, d), velocity);
    }

    // if velocity is against the original velocity, stop dead to avoid tiny
    // oscillations in sloping corners
    if (vec3_dot(velocity, primal_velocity) <= 0) {
      velocity[0] = velocity[1] = velocity[2] = 0;
      break;
    }
  }

  if (has_time) {
    VectorCopy(primal_velocity, velocity);
  }
}

// ---------------------------------------------------------------------------
// Local pmove state -- pml_t (p_move.cpp:160-173)
// ---------------------------------------------------------------------------

interface PmlT {
  origin: Vec3; // full float precision
  velocity: Vec3; // full float precision

  forward: Vec3;
  right: Vec3;
  up: Vec3;
  frametime: number;

  groundsurface: KexCsurfaceT | null;
  groundcontents: ContentsT;

  previous_origin: Vec3;
  start_velocity: Vec3;
}

/**
 * p_move.cpp:1568-1708 `Pmove(pmove_t *pmove)`. Can be called by either the
 * server (game module) or the client (cgame module) -- see ./bg_local.ts's
 * "THE TRACE SEAM" note; `pmove.trace`/`.clip`/`.pointcontents` are supplied
 * by the caller. `config` ports the `pm_config` global as an explicit
 * parameter (see bg_local.ts's `PmConfigT` doc comment for why).
 */
export function Pmove(pmove: KexPmoveT, config: PmConfigT = PM_CONFIG_DEFAULT): void {
  const pm = pmove;

  // clear results
  pm.touch.num = 0;
  pm.viewangles[0] = 0;
  pm.viewangles[1] = 0;
  pm.viewangles[2] = 0;
  pm.s.viewheight = 0;
  pm.groundentity = null;
  pm.watertype = ContentsT.CONTENTS_NONE;
  pm.waterlevel = WaterLevelT.WATER_NONE;
  pm.screen_blend[0] = 0;
  pm.screen_blend[1] = 0;
  pm.screen_blend[2] = 0;
  pm.screen_blend[3] = 0;
  pm.rdflags = RefdefFlagsT.RDF_NONE;
  pm.jump_sound = false;
  pm.step_clip = false;
  pm.impact_delta = 0;

  // clear all pmove local vars (`pml = {};`)
  const pml: PmlT = {
    // convert origin and velocity to float values
    origin: vec3(pm.s.origin[0], pm.s.origin[1], pm.s.origin[2]),
    velocity: vec3(pm.s.velocity[0], pm.s.velocity[1], pm.s.velocity[2]),
    forward: vec3(),
    right: vec3(),
    up: vec3(),
    frametime: pm.cmd.msec * 0.001,
    groundsurface: null,
    groundcontents: ContentsT.CONTENTS_NONE,
    // save old org in case we get stuck
    previous_origin: vec3(pm.s.origin[0], pm.s.origin[1], pm.s.origin[2]),
    start_velocity: vec3(pm.s.velocity[0], pm.s.velocity[1], pm.s.velocity[2]),
  };
  pml.start_velocity = vec3(pml.velocity[0], pml.velocity[1], pml.velocity[2]);

  // -------------------------------------------------------------------------
  // nested helpers -- see file header "NO MODULE-GLOBAL pm/pml"
  // -------------------------------------------------------------------------

  function PM_Clip(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, mask: ContentsT): KexTraceT {
    return pm.clip(start, mins, maxs, end, mask);
  }

  function PM_Trace(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, maskArg: ContentsT = ContentsT.CONTENTS_NONE): KexTraceT {
    if (pm.s.pm_type === KexPmTypeT.PM_SPECTATOR) {
      return PM_Clip(start, mins, maxs, end, MASK_SOLID);
    }

    let mask = maskArg;
    if (mask === ContentsT.CONTENTS_NONE) {
      // p_move.cpp:234-239 also has an `else if (pm->s.pm_type == PM_SPECTATOR)
      // mask = MASK_SOLID;` branch here, but it is unreachable dead code even
      // in the C++ source (PM_SPECTATOR already returned at the top of this
      // function, p_move.cpp:229-230) -- TS's control-flow narrowing proves
      // the same thing at compile time (TS2367 on the equivalent comparison),
      // so it is omitted here rather than worked around; the `else` below
      // reaches the exact same `MASK_PLAYERSOLID` result either way.
      if (pm.s.pm_type === KexPmTypeT.PM_DEAD || pm.s.pm_type === KexPmTypeT.PM_GIB) mask = MASK_DEADSOLID;
      else mask = MASK_PLAYERSOLID;

      if (pm.s.pm_flags & PmflagsT.PMF_IGNORE_PLAYER_COLLISION) mask &= ~ContentsT.CONTENTS_PLAYER;
    }

    return pm.trace(start, mins, maxs, end, pm.player, mask);
  }

  // only here to satisfy pm_trace_t (p_move.cpp:249-252)
  function PM_Trace_Auto(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3): KexTraceT {
    return PM_Trace(start, mins, maxs, end);
  }

  function PM_StepSlideMove_(): void {
    PM_StepSlideMove_Generic(pml.origin, pml.velocity, pml.frametime, pm.mins, pm.maxs, pm.touch, pm.s.pm_time !== 0, PM_Trace_Auto);
  }

  /** p_move.cpp:447-535. */
  function PM_StepSlideMove(): void {
    const start_o = vec3(pml.origin[0], pml.origin[1], pml.origin[2]);
    const start_v = vec3(pml.velocity[0], pml.velocity[1], pml.velocity[2]);

    PM_StepSlideMove_();

    const down_o = vec3(pml.origin[0], pml.origin[1], pml.origin[2]);
    const down_v = vec3(pml.velocity[0], pml.velocity[1], pml.velocity[2]);

    const up = vec3(start_o[0], start_o[1], start_o[2] + STEPSIZE);

    let trace = PM_Trace(start_o, pm.mins, pm.maxs, up);
    if (trace.allsolid) return; // can't step up

    const stepSize = trace.endpos[2] - start_o[2];

    // try sliding above
    VectorCopy(trace.endpos, pml.origin);
    VectorCopy(start_v, pml.velocity);

    PM_StepSlideMove_();

    // push down the final amount
    const down = vec3(pml.origin[0], pml.origin[1], pml.origin[2] - stepSize);

    // [Paril-KEX] jitspoe suggestion for stair clip fix; store the old down
    // position, and pick a better spot for downwards trace if the start
    // origin's Z position is lower than the down end pt.
    const original_down = vec3(down[0], down[1], down[2]);

    if (start_o[2] < down[2]) down[2] = start_o[2] - 1;

    trace = PM_Trace(pml.origin, pm.mins, pm.maxs, down);
    if (!trace.allsolid) {
      // [Paril-KEX] from above, do the proper trace now
      const real_trace = PM_Trace(pml.origin, pm.mins, pm.maxs, original_down);
      VectorCopy(real_trace.endpos, pml.origin);

      // only an upwards jump is a stair clip
      if (pml.velocity[2] > 0) {
        pm.step_clip = true;
      }
    }

    const upEnd = vec3(pml.origin[0], pml.origin[1], pml.origin[2]);

    // decide which one went farther
    const down_dist = (down_o[0] - start_o[0]) * (down_o[0] - start_o[0]) + (down_o[1] - start_o[1]) * (down_o[1] - start_o[1]);
    const up_dist = (upEnd[0] - start_o[0]) * (upEnd[0] - start_o[0]) + (upEnd[1] - start_o[1]) * (upEnd[1] - start_o[1]);

    if (down_dist > up_dist || trace.plane.normal[2] < MIN_STEP_NORMAL) {
      VectorCopy(down_o, pml.origin);
      VectorCopy(down_v, pml.velocity);
    }
    // [Paril-KEX] NB: this line being commented is crucial for ramp-jumps to
    // work. thanks to Jitspoe for pointing this one out.
    else {
      //!! Special case
      // if we were walking along a plane, then we need to copy the Z over
      pml.velocity[2] = down_v[2];
    }

    // Paril: step down stairs/slopes
    if (
      pm.s.pm_flags & PmflagsT.PMF_ON_GROUND &&
      !(pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) &&
      (pm.waterlevel < WaterLevelT.WATER_WAIST || (!(pm.cmd.buttons & ButtonT.BUTTON_JUMP) && pml.velocity[2] <= 0))
    ) {
      const downStairs = vec3(pml.origin[0], pml.origin[1], pml.origin[2] - STEPSIZE);
      trace = PM_Trace(pml.origin, pm.mins, pm.maxs, downStairs);
      if (trace.fraction < 1) {
        VectorCopy(trace.endpos, pml.origin);
      }
    }
  }

  /** p_move.cpp:544-586. */
  function PM_Friction(): void {
    const vel = pml.velocity;

    const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
    if (speed < 1) {
      vel[0] = 0;
      vel[1] = 0;
      return;
    }

    let drop = 0;

    // apply ground friction
    if ((pm.groundentity && pml.groundsurface && !(pml.groundsurface.flags & SurfflagsT.SURF_SLICK)) || pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) {
      const friction = pm_friction;
      const control = speed < pm_stopspeed ? pm_stopspeed : speed;
      drop += control * friction * pml.frametime;
    }

    // apply water friction
    if (pm.waterlevel && !(pm.s.pm_flags & PmflagsT.PMF_ON_LADDER)) {
      drop += speed * pm_waterfriction * pm.waterlevel * pml.frametime;
    }

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;

    vel[0] *= newspeed;
    vel[1] *= newspeed;
    vel[2] *= newspeed;
  }

  /** p_move.cpp:595-610. */
  function PM_Accelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
    const currentspeed = vec3_dot(pml.velocity, wishdir);
    const addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) return;
    let accelspeed = accel * pml.frametime * wishspeed;
    if (accelspeed > addspeed) accelspeed = addspeed;

    pml.velocity[0] += accelspeed * wishdir[0];
    pml.velocity[1] += accelspeed * wishdir[1];
    pml.velocity[2] += accelspeed * wishdir[2];
  }

  /** p_move.cpp:612-629. */
  function PM_AirAccelerate(wishdir: Vec3, wishspeed: number, accel: number): void {
    let wishspd = wishspeed;
    if (wishspd > 30) wishspd = 30;
    const currentspeed = vec3_dot(pml.velocity, wishdir);
    const addspeed = wishspd - currentspeed;
    if (addspeed <= 0) return;
    let accelspeed = accel * wishspeed * pml.frametime;
    if (accelspeed > addspeed) accelspeed = addspeed;

    pml.velocity[0] += accelspeed * wishdir[0];
    pml.velocity[1] += accelspeed * wishdir[1];
    pml.velocity[2] += accelspeed * wishdir[2];
  }

  /** p_move.cpp:636-781. */
  function PM_AddCurrents(wishvel: Vec3): void {
    // account for ladders
    if (pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) {
      if (pm.cmd.buttons & (ButtonT.BUTTON_JUMP | ButtonT.BUTTON_CROUCH)) {
        // [Paril-KEX]: if we're underwater, use full speed on ladders
        const ladder_speed = pm.waterlevel >= WaterLevelT.WATER_WAIST ? pm_maxspeed : 200;

        if (pm.cmd.buttons & ButtonT.BUTTON_JUMP) wishvel[2] = ladder_speed;
        else if (pm.cmd.buttons & ButtonT.BUTTON_CROUCH) wishvel[2] = -ladder_speed;
      } else if (pm.cmd.forwardmove) {
        // [Paril-KEX] clamp the speed a bit so we're not too fast
        const ladder_speed = clamp(pm.cmd.forwardmove, -200, 200);

        if (pm.cmd.forwardmove > 0) {
          if (pm.viewangles[PITCH] < 15) wishvel[2] = ladder_speed;
          else wishvel[2] = -ladder_speed;
        }
        // [Paril-KEX] allow using "back" arrow to go down on ladder
        else if (pm.cmd.forwardmove < 0) {
          // if we haven't touched ground yet, remove x/y so we don't slide
          // off of the ladder
          if (!pm.groundentity) {
            wishvel[0] = 0;
            wishvel[1] = 0;
          }
          wishvel[2] = ladder_speed;
        }
      } else {
        wishvel[2] = 0;
      }

      // limit horizontal speed when on a ladder
      // [Paril-KEX] unless we're on the ground
      if (!pm.groundentity) {
        // [Paril-KEX] instead of left/right not doing anything, have them
        // move you perpendicular to the ladder plane
        if (pm.cmd.sidemove) {
          // clamp side speed so it's not jarring...
          let ladder_speed = clamp(pm.cmd.sidemove, -150, 150);

          if (pm.waterlevel < WaterLevelT.WATER_WAIST) ladder_speed *= pm_laddermod;

          // check for ladder
          const flatforward = vec3(pml.forward[0], pml.forward[1], 0);
          vec3_normalize(flatforward);

          const spot = vec3_add(pml.origin, vec3_muls(flatforward, 1));
          const trace = PM_Trace(pml.origin, pm.mins, pm.maxs, spot, ContentsT.CONTENTS_LADDER);

          if (trace.fraction !== 1 && trace.contents & ContentsT.CONTENTS_LADDER) {
            const right = vec3_cross(trace.plane.normal, vec3(0, 0, 1));

            wishvel[0] = 0;
            wishvel[1] = 0;
            vec3_addEq(wishvel, vec3_muls(right, -ladder_speed));
          }
        } else {
          if (wishvel[0] < -25) wishvel[0] = -25;
          else if (wishvel[0] > 25) wishvel[0] = 25;

          if (wishvel[1] < -25) wishvel[1] = -25;
          else if (wishvel[1] > 25) wishvel[1] = 25;
        }
      }
    }

    // add water currents
    if (pm.watertype & MASK_CURRENT) {
      const v = vec3(0, 0, 0);

      if (pm.watertype & ContentsT.CONTENTS_CURRENT_0) v[0] += 1;
      if (pm.watertype & ContentsT.CONTENTS_CURRENT_90) v[1] += 1;
      if (pm.watertype & ContentsT.CONTENTS_CURRENT_180) v[0] -= 1;
      if (pm.watertype & ContentsT.CONTENTS_CURRENT_270) v[1] -= 1;
      if (pm.watertype & ContentsT.CONTENTS_CURRENT_UP) v[2] += 1;
      if (pm.watertype & ContentsT.CONTENTS_CURRENT_DOWN) v[2] -= 1;

      let s = pm_waterspeed;
      if (pm.waterlevel === WaterLevelT.WATER_FEET && pm.groundentity) s /= 2;

      vec3_addEq(wishvel, vec3_muls(v, s));
    }

    // add conveyor belt velocities
    if (pm.groundentity) {
      const v = vec3(0, 0, 0);

      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_0) v[0] += 1;
      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_90) v[1] += 1;
      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_180) v[0] -= 1;
      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_270) v[1] -= 1;
      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_UP) v[2] += 1;
      if (pml.groundcontents & ContentsT.CONTENTS_CURRENT_DOWN) v[2] -= 1;

      vec3_addEq(wishvel, vec3_muls(v, 100));
    }
  }

  /** p_move.cpp:789-837. */
  function PM_WaterMove(): void {
    const wishvel = vec3(
      pml.forward[0] * pm.cmd.forwardmove + pml.right[0] * pm.cmd.sidemove,
      pml.forward[1] * pm.cmd.forwardmove + pml.right[1] * pm.cmd.sidemove,
      pml.forward[2] * pm.cmd.forwardmove + pml.right[2] * pm.cmd.sidemove,
    );

    if (!pm.cmd.forwardmove && !pm.cmd.sidemove && !(pm.cmd.buttons & (ButtonT.BUTTON_JUMP | ButtonT.BUTTON_CROUCH))) {
      if (!pm.groundentity) wishvel[2] -= 60; // drift towards bottom
    } else {
      if (pm.cmd.buttons & ButtonT.BUTTON_CROUCH) wishvel[2] -= pm_waterspeed * 0.5;
      else if (pm.cmd.buttons & ButtonT.BUTTON_JUMP) wishvel[2] += pm_waterspeed * 0.5;
    }

    PM_AddCurrents(wishvel);

    const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
    let wishspeed = vec3_normalize(wishdir);

    if (wishspeed > pm_maxspeed) {
      vec3_mulEqs(wishvel, pm_maxspeed / wishspeed);
      wishspeed = pm_maxspeed;
    }
    wishspeed *= 0.5;

    if (pm.s.pm_flags & PmflagsT.PMF_DUCKED && wishspeed > pm_duckspeed) {
      vec3_mulEqs(wishvel, pm_duckspeed / wishspeed);
      wishspeed = pm_duckspeed;
    }

    PM_Accelerate(wishdir, wishspeed, pm_wateraccelerate);

    PM_StepSlideMove();
  }

  /** p_move.cpp:845-927. */
  function PM_AirMove(): void {
    const fmove = pm.cmd.forwardmove;
    const smove = pm.cmd.sidemove;

    const wishvel = vec3(pml.forward[0] * fmove + pml.right[0] * smove, pml.forward[1] * fmove + pml.right[1] * smove, 0);

    PM_AddCurrents(wishvel);

    const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
    let wishspeed = vec3_normalize(wishdir);

    // clamp to server defined max speed
    const maxspeed = pm.s.pm_flags & PmflagsT.PMF_DUCKED ? pm_duckspeed : pm_maxspeed;

    if (wishspeed > maxspeed) {
      vec3_mulEqs(wishvel, maxspeed / wishspeed);
      wishspeed = maxspeed;
    }

    if (pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) {
      PM_Accelerate(wishdir, wishspeed, pm_accelerate);
      if (!wishvel[2]) {
        if (pml.velocity[2] > 0) {
          pml.velocity[2] -= pm.s.gravity * pml.frametime;
          if (pml.velocity[2] < 0) pml.velocity[2] = 0;
        } else {
          pml.velocity[2] += pm.s.gravity * pml.frametime;
          if (pml.velocity[2] > 0) pml.velocity[2] = 0;
        }
      }
      PM_StepSlideMove();
    } else if (pm.groundentity) {
      // walking on ground
      pml.velocity[2] = 0; //!!! this is before the accel
      PM_Accelerate(wishdir, wishspeed, pm_accelerate);

      // PGM -- fix for negative trigger_gravity fields
      if (pm.s.gravity > 0) pml.velocity[2] = 0;
      else pml.velocity[2] -= pm.s.gravity * pml.frametime;
      // PGM

      if (!pml.velocity[0] && !pml.velocity[1]) return;
      PM_StepSlideMove();
    } else {
      // not on ground, so little effect on velocity
      if (config.airaccel) PM_AirAccelerate(wishdir, wishspeed, config.airaccel);
      else PM_Accelerate(wishdir, wishspeed, 1);

      // add gravity
      if (pm.s.pm_type !== KexPmTypeT.PM_GRAPPLE) pml.velocity[2] -= pm.s.gravity * pml.frametime;

      PM_StepSlideMove();
    }
  }

  /**
   * p_move.cpp:929-961. See file header preserved-quirk (2): only the FIRST
   * (WATER_FEET) sample uses the `position` parameter; the deeper samples
   * read `pml.origin` directly, exactly like the C++ source.
   */
  function PM_GetWaterLevel(position: Vec3): { level: WaterLevelT; type: ContentsT } {
    let level: WaterLevelT = WaterLevelT.WATER_NONE;
    let type: ContentsT = ContentsT.CONTENTS_NONE;

    const sample2 = Math.trunc(pm.s.viewheight - pm.mins[2]);
    const sample1 = Math.trunc(sample2 / 2);

    const point = vec3(position[0], position[1], position[2] + pm.mins[2] + 1);

    let cont = pm.pointcontents(point);

    if (cont & MASK_WATER) {
      type = cont;
      level = WaterLevelT.WATER_FEET;
      point[2] = pml.origin[2] + pm.mins[2] + sample1;
      cont = pm.pointcontents(point);
      if (cont & MASK_WATER) {
        level = WaterLevelT.WATER_WAIST;
        point[2] = pml.origin[2] + pm.mins[2] + sample2;
        cont = pm.pointcontents(point);
        if (cont & MASK_WATER) level = WaterLevelT.WATER_UNDER;
      }
    }

    return { level, type };
  }

  /** p_move.cpp:968-1057. */
  function PM_CatagorizePosition(): void {
    const point = vec3(pml.origin[0], pml.origin[1], pml.origin[2] - 0.25);

    // !!ZOID changed from 100 to 180 (ramp accel)
    if (pml.velocity[2] > 180 || pm.s.pm_type === KexPmTypeT.PM_GRAPPLE) {
      pm.s.pm_flags &= ~PmflagsT.PMF_ON_GROUND;
      pm.groundentity = null;
    } else {
      const trace = PM_Trace(pml.origin, pm.mins, pm.maxs, point);
      pm.groundplane = trace.plane;
      pml.groundsurface = trace.surface;
      pml.groundcontents = trace.contents;

      // [Paril-KEX] to attempt to fix edge cases where you get stuck wedged
      // between a slope and a wall (which is irrecoverable most of the
      // time), we'll allow the player to "stand" on slopes if they are
      // right up against a wall
      let slanted_ground = trace.fraction < 1 && trace.plane.normal[2] < 0.7;

      if (slanted_ground) {
        const slant = PM_Trace(pml.origin, pm.mins, pm.maxs, vec3_add(pml.origin, trace.plane.normal));
        if (slant.fraction < 1 && !slant.startsolid) slanted_ground = false;
      }

      if (trace.fraction === 1 || (slanted_ground && !trace.startsolid)) {
        pm.groundentity = null;
        pm.s.pm_flags &= ~PmflagsT.PMF_ON_GROUND;
      } else {
        pm.groundentity = trace.ent;

        // hitting solid ground will end a waterjump
        if (pm.s.pm_flags & PmflagsT.PMF_TIME_WATERJUMP) {
          pm.s.pm_flags &= ~(PmflagsT.PMF_TIME_WATERJUMP | PmflagsT.PMF_TIME_LAND | PmflagsT.PMF_TIME_TELEPORT | PmflagsT.PMF_TIME_TRICK);
          pm.s.pm_time = 0;
        }

        if (!(pm.s.pm_flags & PmflagsT.PMF_ON_GROUND)) {
          // just hit the ground

          // [Paril-KEX]
          if (!config.n64_physics && pml.velocity[2] >= 100 && pm.groundplane.normal[2] >= 0.9 && !(pm.s.pm_flags & PmflagsT.PMF_DUCKED)) {
            pm.s.pm_flags |= PmflagsT.PMF_TIME_TRICK;
            pm.s.pm_time = 64;
          }

          // [Paril-KEX] calculate impact delta; this also fixes triple jumping
          const clipped_velocity = SlideClipVelocity(pml.velocity, pm.groundplane.normal, 1.01);

          pm.impact_delta = pml.start_velocity[2] - clipped_velocity[2];

          pm.s.pm_flags |= PmflagsT.PMF_ON_GROUND;

          if (config.n64_physics || pm.s.pm_flags & PmflagsT.PMF_DUCKED) {
            pm.s.pm_flags |= PmflagsT.PMF_TIME_LAND;
            pm.s.pm_time = 128;
          }
        }
      }

      PM_RecordTrace(pm.touch, trace);
    }

    // get waterlevel, accounting for ducking
    const { level, type } = PM_GetWaterLevel(pml.origin);
    pm.waterlevel = level;
    pm.watertype = type;
  }

  /** p_move.cpp:1064-1103. */
  function PM_CheckJump(): void {
    if (pm.s.pm_flags & PmflagsT.PMF_TIME_LAND) {
      // hasn't been long enough since landing to jump again
      return;
    }

    if (!(pm.cmd.buttons & ButtonT.BUTTON_JUMP)) {
      // not holding jump
      pm.s.pm_flags &= ~PmflagsT.PMF_JUMP_HELD;
      return;
    }

    // must wait for jump to be released
    if (pm.s.pm_flags & PmflagsT.PMF_JUMP_HELD) return;

    if (pm.s.pm_type === KexPmTypeT.PM_DEAD) return;

    if (pm.waterlevel >= WaterLevelT.WATER_WAIST) {
      // swimming, not jumping
      pm.groundentity = null;
      return;
    }

    if (pm.groundentity === null) return; // in air, so no effect

    pm.s.pm_flags |= PmflagsT.PMF_JUMP_HELD;
    pm.jump_sound = true;
    pm.groundentity = null;
    pm.s.pm_flags &= ~PmflagsT.PMF_ON_GROUND;

    const jump_height = 270;

    pml.velocity[2] += jump_height;
    if (pml.velocity[2] < jump_height) pml.velocity[2] = jump_height;
  }

  /** p_move.cpp:1110-1206. */
  function PM_CheckSpecialMovement(): void {
    if (pm.s.pm_time) return;

    pm.s.pm_flags &= ~PmflagsT.PMF_ON_LADDER;

    // check for ladder
    const flatforward = vec3(pml.forward[0], pml.forward[1], 0);
    vec3_normalize(flatforward);

    const spot = vec3_add(pml.origin, vec3_muls(flatforward, 1));
    let trace = PM_Trace(pml.origin, pm.mins, pm.maxs, spot, ContentsT.CONTENTS_LADDER);
    if (trace.fraction < 1 && trace.contents & ContentsT.CONTENTS_LADDER && pm.waterlevel < WaterLevelT.WATER_WAIST) {
      pm.s.pm_flags |= PmflagsT.PMF_ON_LADDER;
    }

    if (!pm.s.gravity) return;

    // check for water jump
    // [Paril-KEX] don't try waterjump if we're moving against where we'll hop
    if (!(pm.cmd.buttons & ButtonT.BUTTON_JUMP) && pm.cmd.forwardmove <= 0) return;

    if (pm.waterlevel !== WaterLevelT.WATER_WAIST) return;
    // [Paril-KEX]
    else if (pm.watertype & ContentsT.CONTENTS_NO_WATERJUMP) return;

    // quick check that something is even blocking us forward
    trace = PM_Trace(pml.origin, pm.mins, pm.maxs, vec3_add(pml.origin, vec3_muls(flatforward, 40)), MASK_SOLID);

    // we aren't blocked, or what we're blocked by is something we can walk up
    if (trace.fraction === 1 || trace.plane.normal[2] >= 0.7) return;

    // [Paril-KEX] improved waterjump
    const waterjump_vel = vec3_muls(flatforward, 50);
    waterjump_vel[2] = 350;

    // simulate what would happen if we jumped out here, and if we land on a
    // dry spot we're good! simulate 1 sec worth of movement
    const touches: KexTouchListT = { num: 0, traces: [] };
    const waterjump_origin = vec3(pml.origin[0], pml.origin[1], pml.origin[2]);
    const time = 0.1;
    let has_time = true;

    const iterCount = Math.min(50, Math.trunc(10 * (800 / pm.s.gravity)));
    for (let i = 0; i < iterCount; i++) {
      waterjump_vel[2] -= pm.s.gravity * time;

      if (waterjump_vel[2] < 0) has_time = false;

      PM_StepSlideMove_Generic(waterjump_origin, waterjump_vel, time, pm.mins, pm.maxs, touches, has_time, PM_Trace_Auto);
    }

    // snap down to ground
    trace = PM_Trace(waterjump_origin, pm.mins, pm.maxs, vec3_sub(waterjump_origin, vec3(0, 0, 2)), MASK_SOLID);

    // can't stand here
    if (trace.fraction === 1 || trace.plane.normal[2] < 0.7 || trace.endpos[2] < pml.origin[2]) return;

    // we're currently standing on ground, and the snapped position is a step
    if (pm.groundentity && Math.abs(pml.origin[2] - trace.endpos[2]) <= STEPSIZE) return;

    const { level } = PM_GetWaterLevel(trace.endpos);

    // the water jump spot will be under water, so we're probably hitting
    // something weird that isn't important
    if (level >= WaterLevelT.WATER_WAIST) return;

    // valid waterjump!
    pml.velocity[0] = flatforward[0] * 50;
    pml.velocity[1] = flatforward[1] * 50;
    pml.velocity[2] = 350;

    pm.s.pm_flags |= PmflagsT.PMF_TIME_WATERJUMP;
    pm.s.pm_time = 2048;
  }

  /** p_move.cpp:1213-1308. */
  function PM_FlyMove(doclip: boolean): void {
    pm.s.viewheight = doclip ? 0 : 22;

    // friction
    const speed = vec3_length(pml.velocity);
    if (speed < 1) {
      pml.velocity[0] = 0;
      pml.velocity[1] = 0;
      pml.velocity[2] = 0;
    } else {
      const friction = pm_friction * 1.5; // extra friction
      const control = speed < pm_stopspeed ? pm_stopspeed : speed;
      const drop = control * friction * pml.frametime;

      let newspeed = speed - drop;
      if (newspeed < 0) newspeed = 0;
      newspeed /= speed;

      vec3_mulEqs(pml.velocity, newspeed);
    }

    // accelerate
    const fmove = pm.cmd.forwardmove;
    const smove = pm.cmd.sidemove;

    vec3_normalize(pml.forward);
    vec3_normalize(pml.right);

    const wishvel = vec3(
      pml.forward[0] * fmove + pml.right[0] * smove,
      pml.forward[1] * fmove + pml.right[1] * smove,
      pml.forward[2] * fmove + pml.right[2] * smove,
    );

    if (pm.cmd.buttons & ButtonT.BUTTON_JUMP) wishvel[2] += pm_waterspeed * 0.5;
    if (pm.cmd.buttons & ButtonT.BUTTON_CROUCH) wishvel[2] -= pm_waterspeed * 0.5;

    const wishdir = vec3(wishvel[0], wishvel[1], wishvel[2]);
    let wishspeed = vec3_normalize(wishdir);

    // clamp to server defined max speed
    if (wishspeed > pm_maxspeed) {
      vec3_mulEqs(wishvel, pm_maxspeed / wishspeed);
      wishspeed = pm_maxspeed;
    }

    // Paril: newer clients do this
    wishspeed *= 2;

    const currentspeed = vec3_dot(pml.velocity, wishdir);
    const addspeed = wishspeed - currentspeed;

    if (addspeed > 0) {
      let accelspeed = pm_accelerate * pml.frametime * wishspeed;
      if (accelspeed > addspeed) accelspeed = addspeed;

      pml.velocity[0] += accelspeed * wishdir[0];
      pml.velocity[1] += accelspeed * wishdir[1];
      pml.velocity[2] += accelspeed * wishdir[2];
    }

    if (doclip) {
      PM_StepSlideMove();
    } else {
      // move
      pml.origin[0] += pml.velocity[0] * pml.frametime;
      pml.origin[1] += pml.velocity[1] * pml.frametime;
      pml.origin[2] += pml.velocity[2] * pml.frametime;
    }
  }

  /** p_move.cpp:1310-1338. */
  function PM_SetDimensions(): void {
    pm.mins[0] = -16;
    pm.mins[1] = -16;

    pm.maxs[0] = 16;
    pm.maxs[1] = 16;

    if (pm.s.pm_type === KexPmTypeT.PM_GIB) {
      pm.mins[2] = 0;
      pm.maxs[2] = 16;
      pm.s.viewheight = 8;
      return;
    }

    pm.mins[2] = -24;

    if (pm.s.pm_flags & PmflagsT.PMF_DUCKED || pm.s.pm_type === KexPmTypeT.PM_DEAD) {
      pm.maxs[2] = 4;
      pm.s.viewheight = -2;
    } else {
      pm.maxs[2] = 32;
      pm.s.viewheight = 22;
    }
  }

  /** p_move.cpp:1340-1355. */
  function PM_AboveWater(): boolean {
    const below = vec3(pml.origin[0], pml.origin[1], pml.origin[2] - 8);

    const solid_below = pm.trace(pml.origin, pm.mins, pm.maxs, below, pm.player, MASK_SOLID).fraction < 1;
    if (solid_below) return false;

    const water_below = pm.trace(pml.origin, pm.mins, pm.maxs, below, pm.player, MASK_WATER).fraction < 1;
    return water_below;
  }

  /** p_move.cpp:1364-1418. Sets mins, maxs, and pm->viewheight. */
  function PM_CheckDuck(): boolean {
    if (pm.s.pm_type === KexPmTypeT.PM_GIB) return false;

    let flags_changed = false;

    if (pm.s.pm_type === KexPmTypeT.PM_DEAD) {
      if (!(pm.s.pm_flags & PmflagsT.PMF_DUCKED)) {
        pm.s.pm_flags |= PmflagsT.PMF_DUCKED;
        flags_changed = true;
      }
    } else if (
      pm.cmd.buttons & ButtonT.BUTTON_CROUCH &&
      (pm.groundentity || (pm.waterlevel <= WaterLevelT.WATER_FEET && !PM_AboveWater())) &&
      !(pm.s.pm_flags & PmflagsT.PMF_ON_LADDER) &&
      !config.n64_physics
    ) {
      // duck
      if (!(pm.s.pm_flags & PmflagsT.PMF_DUCKED)) {
        // check that duck won't be blocked
        const check_maxs = vec3(pm.maxs[0], pm.maxs[1], 4);
        const trace = PM_Trace(pml.origin, pm.mins, check_maxs, pml.origin);
        if (!trace.allsolid) {
          pm.s.pm_flags |= PmflagsT.PMF_DUCKED;
          flags_changed = true;
        }
      }
    } else {
      // stand up if possible
      if (pm.s.pm_flags & PmflagsT.PMF_DUCKED) {
        // try to stand up
        const check_maxs = vec3(pm.maxs[0], pm.maxs[1], 32);
        const trace = PM_Trace(pml.origin, pm.mins, check_maxs, pml.origin);
        if (!trace.allsolid) {
          pm.s.pm_flags &= ~PmflagsT.PMF_DUCKED;
          flags_changed = true;
        }
      }
    }

    if (!flags_changed) return false;

    PM_SetDimensions();
    return true;
  }

  /** p_move.cpp:1425-1445. */
  function PM_DeadMove(): void {
    if (!pm.groundentity) return;

    // extra friction
    let forward = vec3_length(pml.velocity);
    forward -= 20;
    if (forward <= 0) {
      pml.velocity[0] = 0;
      pml.velocity[1] = 0;
      pml.velocity[2] = 0;
    } else {
      vec3_normalize(pml.velocity);
      vec3_mulEqs(pml.velocity, forward);
    }
  }

  /** p_move.cpp:1447-1455. */
  function PM_GoodPosition(): boolean {
    if (pm.s.pm_type === KexPmTypeT.PM_NOCLIP) return true;

    const trace = PM_Trace(pm.s.origin, pm.mins, pm.maxs, pm.s.origin);
    return !trace.allsolid;
  }

  /**
   * p_move.cpp:1465-1477. On exit, the origin will have a value that is in a
   * valid position.
   */
  function PM_SnapPosition(): void {
    VectorCopy(pml.velocity, pm.s.velocity);
    VectorCopy(pml.origin, pm.s.origin);

    if (PM_GoodPosition()) return;

    if (G_FixStuckObject_Generic(pm.s.origin, pm.mins, pm.maxs, PM_Trace_Auto) === StuckResultT.NO_GOOD_POSITION) {
      VectorCopy(pml.previous_origin, pm.s.origin);
      return;
    }
  }

  /** p_move.cpp:1485-1511. */
  function PM_InitialSnapPosition(): void {
    const offset = [0, -1, 1] as const;
    const base = vec3(pm.s.origin[0], pm.s.origin[1], pm.s.origin[2]);

    for (let z = 0; z < 3; z++) {
      pm.s.origin[2] = base[2] + offset[z];
      for (let y = 0; y < 3; y++) {
        pm.s.origin[1] = base[1] + offset[y];
        for (let x = 0; x < 3; x++) {
          pm.s.origin[0] = base[0] + offset[x];
          if (PM_GoodPosition()) {
            VectorCopy(pm.s.origin, pml.origin);
            VectorCopy(pm.s.origin, pml.previous_origin);
            return;
          }
        }
      }
    }
  }

  /** p_move.cpp:1519-1539. */
  function PM_ClampAngles(): void {
    if (pm.s.pm_flags & PmflagsT.PMF_TIME_TELEPORT) {
      pm.viewangles[YAW] = pm.cmd.angles[YAW] + pm.s.delta_angles[YAW];
      pm.viewangles[PITCH] = 0;
      pm.viewangles[ROLL] = 0;
    } else {
      // circularly clamp the angles with deltas
      pm.viewangles[0] = pm.cmd.angles[0] + pm.s.delta_angles[0];
      pm.viewangles[1] = pm.cmd.angles[1] + pm.s.delta_angles[1];
      pm.viewangles[2] = pm.cmd.angles[2] + pm.s.delta_angles[2];

      // don't let the player look up or down more than 90 degrees
      if (pm.viewangles[PITCH] > 89 && pm.viewangles[PITCH] < 180) pm.viewangles[PITCH] = 89;
      else if (pm.viewangles[PITCH] < 271 && pm.viewangles[PITCH] >= 180) pm.viewangles[PITCH] = 271;
    }

    AngleVectors(pm.viewangles, pml.forward, pml.right, pml.up);
  }

  /** p_move.cpp:1542-1559. [Paril-KEX] */
  function PM_ScreenEffects(): void {
    // add for contents
    const vieworg = vec3(pml.origin[0] + pm.viewoffset[0], pml.origin[1] + pm.viewoffset[1], pml.origin[2] + pm.viewoffset[2] + pm.s.viewheight);
    const contents = pm.pointcontents(vieworg);

    if (contents & (ContentsT.CONTENTS_LAVA | ContentsT.CONTENTS_SLIME | ContentsT.CONTENTS_WATER)) {
      pm.rdflags |= RefdefFlagsT.RDF_UNDERWATER;
    } else {
      pm.rdflags &= ~RefdefFlagsT.RDF_UNDERWATER;
    }

    if (contents & (ContentsT.CONTENTS_SOLID | ContentsT.CONTENTS_LAVA)) {
      G_AddBlend(1.0, 0.3, 0.0, 0.6, pm.screen_blend);
    } else if (contents & ContentsT.CONTENTS_SLIME) {
      G_AddBlend(0.0, 0.1, 0.05, 0.6, pm.screen_blend);
    } else if (contents & ContentsT.CONTENTS_WATER) {
      G_AddBlend(0.5, 0.3, 0.2, 0.4, pm.screen_blend);
    }
  }

  // -------------------------------------------------------------------------
  // main body (p_move.cpp:1599-1707)
  // -------------------------------------------------------------------------

  PM_ClampAngles();

  if (pm.s.pm_type === KexPmTypeT.PM_SPECTATOR || pm.s.pm_type === KexPmTypeT.PM_NOCLIP) {
    pm.s.pm_flags = PmflagsT.PMF_NONE;

    if (pm.s.pm_type === KexPmTypeT.PM_SPECTATOR) {
      pm.mins[0] = -8;
      pm.mins[1] = -8;
      pm.maxs[0] = 8;
      pm.maxs[1] = 8;
      pm.mins[2] = -8;
      pm.maxs[2] = 8;
    }

    PM_FlyMove(pm.s.pm_type === KexPmTypeT.PM_SPECTATOR);
    PM_SnapPosition();
    return;
  }

  if (pm.s.pm_type >= KexPmTypeT.PM_DEAD) {
    pm.cmd.forwardmove = 0;
    pm.cmd.sidemove = 0;
    pm.cmd.buttons &= ~(ButtonT.BUTTON_JUMP | ButtonT.BUTTON_CROUCH);
  }

  if (pm.s.pm_type === KexPmTypeT.PM_FREEZE) return; // no movement at all

  // set mins, maxs, and viewheight
  PM_SetDimensions();

  // catagorize for ducking
  PM_CatagorizePosition();

  if (pm.snapinitial) PM_InitialSnapPosition();

  // set groundentity, watertype, and waterlevel
  if (PM_CheckDuck()) PM_CatagorizePosition();

  if (pm.s.pm_type === KexPmTypeT.PM_DEAD) PM_DeadMove();

  PM_CheckSpecialMovement();

  // drop timing counter
  if (pm.s.pm_time) {
    if (pm.cmd.msec >= pm.s.pm_time) {
      pm.s.pm_flags &= ~(PmflagsT.PMF_TIME_WATERJUMP | PmflagsT.PMF_TIME_LAND | PmflagsT.PMF_TIME_TELEPORT | PmflagsT.PMF_TIME_TRICK);
      pm.s.pm_time = 0;
    } else {
      pm.s.pm_time -= pm.cmd.msec;
    }
  }

  if (pm.s.pm_flags & PmflagsT.PMF_TIME_TELEPORT) {
    // teleport pause stays exactly in place
  } else if (pm.s.pm_flags & PmflagsT.PMF_TIME_WATERJUMP) {
    // waterjump has no control, but falls
    pml.velocity[2] -= pm.s.gravity * pml.frametime;
    if (pml.velocity[2] < 0) {
      // cancel as soon as we are falling down again
      pm.s.pm_flags &= ~(PmflagsT.PMF_TIME_WATERJUMP | PmflagsT.PMF_TIME_LAND | PmflagsT.PMF_TIME_TELEPORT | PmflagsT.PMF_TIME_TRICK);
      pm.s.pm_time = 0;
    }

    PM_StepSlideMove();
  } else {
    PM_CheckJump();

    PM_Friction();

    if (pm.waterlevel >= WaterLevelT.WATER_WAIST) {
      PM_WaterMove();
    } else {
      const angles = vec3(pm.viewangles[0], pm.viewangles[1], pm.viewangles[2]);
      if (angles[PITCH] > 180) angles[PITCH] -= 360;
      angles[PITCH] /= 3;

      AngleVectors(angles, pml.forward, pml.right, pml.up);

      PM_AirMove();
    }
  }

  // set groundentity, watertype, and waterlevel for final spot
  PM_CatagorizePosition();

  // trick jump
  if (pm.s.pm_flags & PmflagsT.PMF_TIME_TRICK) PM_CheckJump();

  // [Paril-KEX]
  PM_ScreenEffects();

  PM_SnapPosition();
}
