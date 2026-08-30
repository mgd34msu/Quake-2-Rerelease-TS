// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_chase.c -- the spectator chase camera (2023 Quake II re-release / "KEX"
// engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_chase.cpp (171 lines,
// C++17): UpdateChaseCam, ChaseNext, ChasePrev, GetChaseTarget. Behavioral
// code, ported bug-for-bug per this port line's house conventions (see
// g_monster.ts/g_utils.ts headers).
//
// ============================================================================
// `gi.traceline` -- placement-mismatch helper, duplicated locally
// ============================================================================
// `gi.traceline(start, end, passent, mask)` (g_local.h:136-139, an inline
// `game_import_t` convenience wrapper around `gi.trace(start, nullptr,
// nullptr, end, passent, mask)`) is not part of this port's
// `KexGameImports` (src/kexapi/game.ts mirrors the DLL-facing
// `game_import_t`, not g_local.h's header-only convenience wrappers).
// g_monster.ts already ported this exact wrapper locally as `giTraceline`
// (its own file header documents the same reasoning); duplicated here
// rather than imported, per this port line's "duplicate the tiny
// unexported helper" convention (g_utils.ts's G_ShouldPlayersCollide note)
// -- g_chase.ts has no other reason to depend on g_monster.ts.
// `EdictT extends KexEdictT` (g_local_types.ts), so no cast is needed
// passing an `EdictT` anywhere `gi.*` expects a `KexEdictT`.
//
// ============================================================================
// `LocCenter_Print` -- placement-mismatch helper, duplicated locally
// ============================================================================
// `gi.LocCenter_Print(ent, base, ...)` (g_local.h) has no counterpart on
// `KexGameImports` -- only `gi.Loc_Print(ent, level, base, args, num_args)`
// exists there. Same treatment as g_trigger.ts's/p_client.ts's identical
// `giLocCenterPrint` local helper (duplicated per-file by this port line's
// own established convention, not shared via a common module -- see
// g_utils.ts's file header for the general rule this repeats).
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `ChaseNext`/`ChasePrev`'s `i = ent->client->chase_target - g_edicts`
//   (raw pointer-difference edict-index arithmetic) ports as
//   `ent.client.chase_target.s.number` (the EDICT_NUM idiom this whole
//   port line already uses everywhere a C++ file computes an edict's index
//   from its address -- see g_monster.ts's/g_phys.ts's own `traceEdict`
//   note). The C++ `do { ... } while (e != ent->client->chase_target)`
//   loop is ported as an explicit `do`/`while` with the same loop-exit
//   condition (compares by entity reference, not by index, matching `e !=
//   ent->client->chase_target` exactly).
// - `AngleVectors(angles, forward, right, nullptr)` then
//   `forward.normalize()`: ported as two calls, `AngleVectors` (out-param
//   mutation into `forward`) then `vec3_normalize(forward)` (in-place,
//   matching q_vec3.ts's own established idiom for this exact C++ pattern
//   -- see g_monster.ts's/g_ai.ts's own call sites).
// - `o = ownerv + (forward * -30)`, `goal += (forward * 2)`, etc.: C++
//   `vec3_t` operator overloads on stack-local temporaries. Not a hot
//   path (once per chase-camera update, per spectator, per server frame)
//   so these port as ordinary fresh-`Vec3`-returning `vec3_add`/
//   `vec3_muls` calls rather than in-place mutation, matching this port
//   line's existing non-hot-path idiom (e.g. g_target.ts's own
//   non-mutating vector arithmetic in similarly once-per-frame contexts).
// - `trace.endpos`/`ent->s.origin`/`client->ps.pmove.delta_angles`/
//   `client->ps.viewangles`/`client->v_angle` assignments (C++ struct-copy
//   `vec3_t` assignment) port as element-wise copies into the existing
//   `Float32Array`, per PORTING.md's "never return fresh arrays on hot
//   paths, mutate in place" convention for a field that's read elsewhere
//   by reference (`VectorCopy` idiom).

import { vec3, type Vec3 } from "../shared/math";
import { PITCH, ROLL, YAW } from "../shared/q_shared";
import type { EdictT } from "./g_local";
import { g_edicts, game, gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { AngleVectors, vec3_add, vec3_muls, vec3_normalize, vec3_sub } from "./q_vec3";
import { type ContentsT, type KexTraceT, KexPmTypeT, MASK_SOLID, PmflagsT, PrintTypeT } from "../kexapi/game";

/** g_local.h:136-139 `game_import_t::traceline` -- see file header. */
function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT): KexTraceT {
  return gi.trace(start, null, null, end, passent, mask);
}

function VectorCopy(src: Vec3, dst: Vec3): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
}

/** g_local.h's `LocCenter_Print(e, base, ...args)` convenience wrapper --
 *  see file header. */
function giLocCenterPrint(e: EdictT | null, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(e, PrintTypeT.PRINT_CENTER, base, args.map(String), args.length);
}

// ---------------------------------------------------------------------------
// UpdateChaseCam (g_chase.cpp:5-97)
// ---------------------------------------------------------------------------

export function UpdateChaseCam(ent: EdictT): void {
  const client = ent.client;
  if (client === null) {
    throw new Error("UpdateChaseCam: called against an entity with no .client set -- the C++ source dereferences ent->client unconditionally here");
  }

  // is our chase target gone?
  const chaseTarget = client.chase_target;
  if (chaseTarget === null) {
    throw new Error("UpdateChaseCam: called with no chase_target set -- the C++ source dereferences ent->client->chase_target unconditionally here");
  }
  if (!chaseTarget.inuse || (chaseTarget.client !== null && chaseTarget.client.resp.spectator)) {
    const old = client.chase_target;
    ChaseNext(ent);
    if (client.chase_target === old) {
      client.chase_target = null;
      client.ps.pmove.pm_flags &= ~(PmflagsT.PMF_NO_POSITIONAL_PREDICTION | PmflagsT.PMF_NO_ANGULAR_PREDICTION);
      return;
    }
  }

  const targ = client.chase_target;
  if (targ === null || targ.client === null) {
    throw new Error("UpdateChaseCam: chase_target has no .client set -- the C++ source dereferences targ->client unconditionally here");
  }

  const ownerv = vec3(targ.s.origin[0], targ.s.origin[1], targ.s.origin[2]);
  ownerv[2] += targ.viewheight;

  const angles = vec3(targ.client.v_angle[0], targ.client.v_angle[1], targ.client.v_angle[2]);
  if (angles[PITCH] > 56) angles[PITCH] = 56;

  const forward = vec3();
  const right = vec3();
  AngleVectors(angles, forward, right, null);
  vec3_normalize(forward);

  let o = vec3_add(ownerv, vec3_muls(forward, -30));

  if (o[2] < targ.s.origin[2] + 20) o[2] = targ.s.origin[2] + 20;

  // jump animation lifts
  if (targ.groundentity === null) o[2] += 16;

  let trace = giTraceline(ownerv, o, targ, MASK_SOLID);

  let goal = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2]);

  goal = vec3_add(goal, vec3_muls(forward, 2));

  // pad for floors and ceilings
  o = vec3(goal[0], goal[1], goal[2]);
  o[2] += 6;
  trace = giTraceline(goal, o, targ, MASK_SOLID);
  if (trace.fraction < 1) {
    goal = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2]);
    goal[2] -= 6;
  }

  o = vec3(goal[0], goal[1], goal[2]);
  o[2] -= 6;
  trace = giTraceline(goal, o, targ, MASK_SOLID);
  if (trace.fraction < 1) {
    goal = vec3(trace.endpos[0], trace.endpos[1], trace.endpos[2]);
    goal[2] += 6;
  }

  if (targ.deadflag) client.ps.pmove.pm_type = KexPmTypeT.PM_DEAD;
  else client.ps.pmove.pm_type = KexPmTypeT.PM_FREEZE;

  VectorCopy(goal, ent.s.origin);

  const deltaAngles = vec3_sub(targ.client.v_angle, client.resp.cmd_angles);
  VectorCopy(deltaAngles, client.ps.pmove.delta_angles);

  if (targ.deadflag) {
    client.ps.viewangles[ROLL] = 40;
    client.ps.viewangles[PITCH] = -15;
    client.ps.viewangles[YAW] = targ.client.killer_yaw;
  } else {
    VectorCopy(targ.client.v_angle, client.ps.viewangles);
    VectorCopy(targ.client.v_angle, client.v_angle);
    AngleVectors(client.v_angle, client.v_forward, null, null);
  }

  ent.viewheight = 0;
  client.ps.pmove.pm_flags |= PmflagsT.PMF_NO_POSITIONAL_PREDICTION | PmflagsT.PMF_NO_ANGULAR_PREDICTION;
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// ChaseNext (g_chase.cpp:99-122)
// ---------------------------------------------------------------------------

export function ChaseNext(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.chase_target === null) return;

  let i = client.chase_target.s.number;
  let e: EdictT;

  do {
    i++;
    if (i > game.maxclients) i = 1;
    e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.client === null || !e.client.resp.spectator) break;
  } while (e !== client.chase_target);

  client.chase_target = e;
  client.update_chase = true;
}

// ---------------------------------------------------------------------------
// ChasePrev (g_chase.cpp:124-147)
// ---------------------------------------------------------------------------

export function ChasePrev(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.chase_target === null) return;

  let i = client.chase_target.s.number;
  let e: EdictT;

  do {
    i--;
    if (i < 1) i = game.maxclients;
    e = g_edicts[i];
    if (e === undefined || !e.inuse) continue;
    if (e.client === null || !e.client.resp.spectator) break;
  } while (e !== client.chase_target);

  client.chase_target = e;
  client.update_chase = true;
}

// ---------------------------------------------------------------------------
// GetChaseTarget (g_chase.cpp:149-171)
// ---------------------------------------------------------------------------

export function GetChaseTarget(ent: EdictT): void {
  for (let i = 1; i <= game.maxclients; i++) {
    const other = g_edicts[i];
    if (other !== undefined && other.inuse && other.client !== null && !other.client.resp.spectator) {
      const client = ent.client;
      if (client === null) {
        throw new Error("GetChaseTarget: called against an entity with no .client set -- the C++ source dereferences ent->client unconditionally here");
      }
      client.chase_target = other;
      client.update_chase = true;
      UpdateChaseCam(ent);
      return;
    }
  }

  const client = ent.client;
  if (client === null) {
    throw new Error("GetChaseTarget: called against an entity with no .client set -- the C++ source dereferences ent->client unconditionally here");
  }

  if (client.chase_msg_time <= level.time) {
    giLocCenterPrint(ent, "$g_no_players_chase");
    client.chase_msg_time = Gtime_add(level.time, Gtime_from_sec(5));
  }
}
