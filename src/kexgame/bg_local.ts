// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// bg_local.h -- "both games" shared definitions (2023 Quake II re-release /
// "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/bg_local.h (263 lines, C++17).
//
// bg_local.h is a HEADER: it only DECLARES `Pmove`, `PM_StepSlideMove_Generic`,
// and `G_FixStuckObject_Generic` (their bodies live in p_move.cpp). Per this
// codebase's established header/implementation split (g_local.ts holds types,
// the sibling g_*.ts holds behavior), this file holds only the types bg_local.h
// declares; the three functions themselves are implemented and exported from
// ./p_move.ts (p_move.cpp's direct counterpart).
//
// ============================================================================
// SCOPE-MISMATCH: ammo_t / powerup_t / stuck_result_t / coop_respawn_t
// ============================================================================
// bg_local.h declares all four of these (lines 31-53 and 79-130), but they are
// ALREADY PORTED in ./g_local.ts (`AmmoT`, `PowerupT`, `StuckResultT`,
// `CoopRespawnT`) -- that unit's own file header documents taking them from
// this exact header under an identical "the brief's placement wins; report the
// mismatch, don't move it" precedent (PORTING.md). Re-declaring them here
// would fork one C++ type into two incompatible TS types. This file does NOT
// redeclare them; anything in this port line that needs them imports from
// "./g_local" instead.
//
// ============================================================================
// pm_trace_func_t / pm_trace_t / stuck_object_trace_fn_t -- THE TRACE SEAM
// ============================================================================
// bg_local.h:
//   using pm_trace_func_t = trace_t(const vec3_t &start, const vec3_t &mins,
//                                    const vec3_t &maxs, const vec3_t &end);
//   using pm_trace_t = std::function<pm_trace_func_t>;
//   using stuck_object_trace_fn_t = trace_t(const vec3_t &, const vec3_t &,
//                                             const vec3_t &, const vec3_t &);
// This is the whole point of the `std::function` parameterization: p_move.cpp
// is compiled into BOTH the game DLL and the client's cgame module, and each
// supplies a DIFFERENT trace implementation (server-side BSP+entity trace vs.
// client-side prediction trace) by passing a different callable in, never by
// p_move.cpp reaching for a module-level trace function itself. `pm_trace_t`
// (the `std::function` wrapper) needs no separate TS type -- functions are
// already first-class values in TS, so a plain function type already models
// "some callable with this signature," matching `std::function`'s role
// exactly. `stuck_object_trace_fn_t` has the IDENTICAL 4-argument signature
// (verified: both take start/mins/maxs/end and return trace_t, with no
// pass-entity or content-mask argument -- that richer signature belongs only
// to `pmove_t::trace`/`pmove_t::clip`, the KexPmoveT methods already declared
// in ../kexapi/game.ts), so it is ported as an alias of the same type rather
// than a structurally-duplicate second interface.
//
// Every function in this port line that needs a trace callback (in p_move.ts:
// `PM_StepSlideMove_Generic`, `G_FixStuckObject_Generic`, and every internal
// `Pmove()` helper via the richer `KexPmoveT.trace`/`.clip` methods already on
// the pmove object) takes it as an explicit parameter or reads it off the
// `KexPmoveT` argument passed in -- never a module-global import. This is the
// literal TS expression of the C++ `std::function` seam.

import type { Vec3 } from "../shared/math";
import type { KexTraceT } from "../kexapi/game";

/** bg_local.h: `pm_trace_func_t` / `pm_trace_t = std::function<pm_trace_func_t>`.
 *  See "THE TRACE SEAM" above -- no separate wrapper type needed for the
 *  `std::function` layer. */
export type PmTraceFn = (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => KexTraceT;

/** bg_local.h: `stuck_object_trace_fn_t` -- structurally identical to
 *  `pm_trace_func_t` (see "THE TRACE SEAM" above); aliased rather than
 *  redeclared. */
export type StuckObjectTraceFn = PmTraceFn;

// ---------------------------------------------------------------------------
// pm_config_t (bg_local.h:18-24)
// ---------------------------------------------------------------------------
// C++:
//   struct pm_config_t {
//       int32_t airaccel = 0;
//       bool    n64_physics = false;
//   };
//   extern pm_config_t pm_config;
//
// `pm_config` is a real mutable global in the C++ source (defined in
// p_move.cpp, `pm_config_t pm_config;`, later assigned from a cvar by g_main's
// init code) that `Pmove()` reads directly. Per this unit's brief -- "preserve
// [the trace function] seam as a function parameter/config object, NOT a
// module-global import" -- the identical treatment is extended to
// `pm_config`: it exists for the SAME reason the trace function does (a value
// shared between the game and cgame modules, each of which may set it
// differently), so `Pmove()` in p_move.ts takes it as an explicit parameter
// rather than reading a mutable module-global. `PM_CONFIG_DEFAULT` below
// models the struct's default member initializers for callers that don't need
// to override anything (mutable by convention only -- do not write through
// this reference; construct a fresh object to customize it, matching the
// `vec3_origin`-style "shared default, treat as read-only" precedent already
// established in q_vec3.ts).
export interface PmConfigT {
  airaccel: number; // int32_t; default 0
  n64_physics: boolean; // default false
}

export const PM_CONFIG_DEFAULT: PmConfigT = { airaccel: 0, n64_physics: false };
