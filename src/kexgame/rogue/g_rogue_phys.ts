// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_phys.c -- entity physics additions from the ROGUE mission pack
// (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_phys.cpp
// (120 lines, C++17). One function: `SV_Physics_NewToss`, the toss/bounce/
// fly movement mode used by rogue projectiles (tesla, prox mine bounce,
// etc.) that need ground detection without the wall-clip-and-slide loop
// `SV_Physics_Toss` (g_phys.ts) runs -- it moves once per frame via
// `SV_FlyMove` instead of `SV_PushEntity`'s clip-and-slide iteration.
//
// ============================================================================
// STUB SWAP: g_phys.ts's SV_Physics_NewToss is now a real import from here
// ============================================================================
// g_phys.ts (line ~1166 pre-edit) declared a local, unexported, throwing
// stub for `SV_Physics_NewToss`, cited to this file, reached from its own
// `SV_RunEntity`'s MOVETYPE_NEW_TOSS case (line ~1139). That stub is now
// deleted; g_phys.ts imports the real function from here. This is a plain
// one-way import edge (g_rogue_phys.ts -> g_phys.ts for
// SV_RunThink/SV_CheckVelocity/SV_AddGravity/SV_AddRotationalFriction/
// SV_FlyMove, -> g_utils.ts for G_TouchTriggers) -- g_phys.ts does not import
// anything from this file besides SV_Physics_NewToss itself, so this is not
// a cycle.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - The C++ source assigns `wasinwater = ent->waterlevel;` near the top
//   (a `bool` receiving a `waterlevel_t` enum value -- truthy whenever the
//   entity has ANY water level, not specifically "was fully submerged") and
//   then immediately overwrites it a few lines later with
//   `wasinwater = (ent->watertype & MASK_WATER);` right before it's actually
//   read. The first assignment is a dead store with zero observable effect
//   (nothing reads `wasinwater` in between) -- dropped, not ported, matching
//   this port line's "dead C store, kept out" precedent (see g_phys.ts's own
//   `SV_Physics_Toss`, which ports the *second* (live) computation the same
//   way, as a single `const wasinwater` right before the transition check).
// - `trace_t trace;`/`vec3_t move;` for the "find out what we're sitting on"
//   probe are locals, not module state; ported as plain locals.
// - `traceEdict` (KexTraceT.ent -> EdictT, falling back to the world edict
//   for a null trace target) is a local, unexported duplicate of g_phys.ts's
//   own identical local helper -- matching this port line's established
//   per-file small-helper-duplication idiom (see m_medic.ts's header on
//   `anglemod`/`monster_footstep` for the precedent).

import { vec3, type Vec3, VectorCopy } from "../../shared/math";
import { type KexTraceT, type KexEdictT, WaterLevelT, MASK_WATER, SoundchanT } from "../../kexapi/game";
import { type EdictT, EntFlagsT } from "../g_local";
import { gi, g_edicts } from "../g_main_globals";
import { SV_RunThink, SV_CheckVelocity, SV_AddGravity, SV_AddRotationalFriction, SV_FlyMove } from "../g_phys";
import { G_TouchTriggers } from "../g_utils";

function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// `constexpr float sv_friction = 6; constexpr float sv_waterfriction = 1;`
// (g_local.h:2498-2499) -- plain constants, NOT cvars. Local duplicate of
// g_phys.ts's own identical unexported constants (same house precedent as
// this file's `traceEdict`).
const sv_friction = 6;
const sv_waterfriction = 1;

/** rogue/g_rogue_phys.cpp:16-118 `void SV_Physics_NewToss(edict_t *ent)`. */
export function SV_Physics_NewToss(ent: EdictT): void {
  // regular thinking
  SV_RunThink(ent);
  if (!ent.inuse) return;

  // if not a team captain, so movement will be handled elsewhere
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return;

  // find out what we're sitting on.
  const move = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] - 0.25);
  const trace: KexTraceT = gi.trace(ent.s.origin, ent.mins, ent.maxs, move, ent, ent.clipmask);
  if (ent.groundentity && ent.groundentity.inuse) {
    ent.groundentity = traceEdict(trace.ent);
  } else {
    ent.groundentity = null;
  }

  // if we're sitting on something flat and have no velocity of our own, return.
  if (ent.groundentity && trace.plane.normal[2] === 1.0 && ent.velocity[0] === 0 && ent.velocity[1] === 0 && ent.velocity[2] === 0) {
    return;
  }

  // store the old origin
  const old_origin: Vec3 = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);

  SV_CheckVelocity(ent);

  // add gravity
  SV_AddGravity(ent);

  if (ent.avelocity[0] !== 0 || ent.avelocity[1] !== 0 || ent.avelocity[2] !== 0) SV_AddRotationalFriction(ent);

  // add friction
  const speed = Math.hypot(ent.velocity[0], ent.velocity[1], ent.velocity[2]);
  if (ent.waterlevel) {
    // friction for water movement
    let newspeed = speed - sv_waterfriction * 6 * ent.waterlevel;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    VectorCopy(vec3(ent.velocity[0] * newspeed, ent.velocity[1] * newspeed, ent.velocity[2] * newspeed), ent.velocity);
  } else if (!ent.groundentity) {
    // friction for air movement
    let newspeed = speed - sv_friction;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    VectorCopy(vec3(ent.velocity[0] * newspeed, ent.velocity[1] * newspeed, ent.velocity[2] * newspeed), ent.velocity);
  } else {
    // use ground friction
    let newspeed = speed - sv_friction * 6;
    if (newspeed < 0) newspeed = 0;
    newspeed /= speed;
    VectorCopy(vec3(ent.velocity[0] * newspeed, ent.velocity[1] * newspeed, ent.velocity[2] * newspeed), ent.velocity);
  }

  SV_FlyMove(ent, gi.frame_time_s, ent.clipmask);
  gi.linkentity(ent);

  G_TouchTriggers(ent);

  // check for water transition
  const wasinwater = (ent.watertype & MASK_WATER) !== 0;
  ent.watertype = gi.pointcontents(ent.s.origin);
  const isinwater = (ent.watertype & MASK_WATER) !== 0;

  if (isinwater) ent.waterlevel = WaterLevelT.WATER_FEET;
  else ent.waterlevel = WaterLevelT.WATER_NONE;

  if (!wasinwater && isinwater) {
    gi.positioned_sound(old_origin, g_edicts[0], SoundchanT.CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
  } else if (wasinwater && !isinwater) {
    gi.positioned_sound(ent.s.origin, g_edicts[0], SoundchanT.CHAN_AUTO, gi.soundindex("misc/h2ohit1.wav"), 1, 1, 0);
  }

  // move teamslaves
  for (let slave = ent.teamchain; slave !== null; slave = slave.teamchain) {
    VectorCopy(ent.s.origin, slave.s.origin);
    gi.linkentity(slave);
  }
}
