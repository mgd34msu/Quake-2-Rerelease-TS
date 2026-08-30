// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newtrig.c -- additional trigger_ entities from the ROGUE mission
// pack (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newtrig.cpp (189
// lines, C++17): `info_teleport_destination` (a no-op marker entity --
// `trigger_teleport` reads its `s.origin`/`s.angles` directly via
// `G_PickTarget`, never calls any function on it), `trigger_teleport` (a
// standalone teleporter trigger volume, distinct from g_misc.ts's
// `misc_teleporter` disc + its own teleporter_touch), and
// `trigger_disguise` (marks anything passing through it `FL_DISGUISED` so
// monster AI won't recognize it as an enemy). Behavioral code, ported
// bug-for-bug per PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 3 SP_* in the C++ source, 3 exported here
// ============================================================================
// `grep -c '^void SP_' g_rogue_newtrig.cpp` = 3: SP_info_teleport_destination,
// SP_trigger_teleport, SP_trigger_disguise.
//
// ============================================================================
// NOT THE SAME AS g_misc.ts's `misc_teleporter`/`teleporter_touch`
// ============================================================================
// g_misc.ts already ports a teleporter (`misc_teleporter` disc +
// `teleporter_touch`, its own save-registered name) that resolves its
// destination via `G_FindByString(null, "targetname", self.target)`, unlinks
// the toucher first, respects NO_TELEPORT_EFFECT, calls
// `CTFPlayerResetGrapple`, and re-derives `client.v_forward` via
// `AngleVectors`. This file's `trigger_teleport_touch` is a DIFFERENT,
// independently-declared C++ function under a different save name --
// it resolves its destination via `G_PickTarget` (random pick among
// same-targetname destinations, not "first match"), never unlinks the
// toucher, always fires the teleport effect unconditionally (no
// NO_TELEPORT_EFFECT spawnflag exists on this entity), sends its own
// svc_temp_entity/TE_TELEPORT_EFFECT event at the SOURCE point (something
// `teleporter_touch` leaves entirely to `s.event`), and never touches CTF
// grapple state or `v_forward`. Ported side-by-side, not merged.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `trigger_teleport_touch`'s C++ body checks `!(other->client)` once (an
//   early return) and then, a few lines later, checks `if (other->client)`
//   again around the `pm_time`/`pm_flags`/`s.event`/`delta_angles`/
//   `viewangles`/`v_angle` block -- the second check is dead code (already
//   guaranteed true by the first), preserved verbatim rather than
//   flattened, matching this port line's "preserve redundant-but-harmless
//   C++ conditions" precedent (see g_rogue_newai.ts's `blocked_checkjump`
//   header note for the identical rationale). Likewise `KillBox(other,
//   !!other->client)` is ported as `KillBox(other, other.client !== null)`
//   rather than hardcoding `true`, for the same reason.
// - The unused/commented-out spawnflags in the C++ source
//   (`SPAWNFLAG_TELEPORT_PLAYER_ONLY`, `SPAWNFLAG_TELEPORT_SILENT`,
//   `SPAWNFLAG_TELEPORT_CTF_ONLY`, `SPAWNFLAG_DISGUISE_TOGGLE`) are not
//   declared here either -- they were never referenced by the C++ source
//   (all commented out there too), so there is nothing to port.
// - `SP_trigger_teleport`'s `if (self->s.angles) G_SetMovedir(...)` reads
//   `vec3_t::operator bool()` (any component nonzero) -- ported as
//   `vec3_any_nonzero(self.s.angles)`, matching g_func.ts's own
//   `door_secret_use` "origin truthiness" precedent cited in that file's
//   header.
// - `SP_trigger_teleport`'s/`SP_trigger_disguise`'s `gi.setmodel(self,
//   self->model)` calls have no null guard in the C++ source -- ported via
//   a `must()`-style throw rather than a silent skip, matching
//   g_turret.ts's `SP_turret_breach` precedent.

import { vec3 } from "../../shared/math";
import { type KexTraceT, ServerCommandT, KexTempEventT, KexMulticastT, KexEntityEventT, SolidT, SvflagsT, PmflagsT } from "../../kexapi/game";
import { type EdictT, EntFlagsT, MovetypeT } from "../g_local";
import { gi, level } from "../g_main_globals";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "../spawnflags";
import { vec3_sub, vec3_any_nonzero } from "../q_vec3";
import { YAW } from "../q_std";
import { G_PickTarget, G_SetMovedir, KillBox } from "../g_utils";
import { RegisterTouch, RegisterUse, type TouchFn, type UseFn } from "../g_save_registry";

/*QUAKED info_teleport_destination (.5 .5 .5) (-16 -16 -24) (16 16 32)
Destination marker for a teleporter.
*/
/** rogue/g_rogue_newtrig.cpp:12-14 `void SP_info_teleport_destination(edict_t *self)`.
 *  Deliberately empty -- `trigger_teleport_touch`/`G_PickTarget` read this
 *  entity's `s.origin`/`s.angles` directly; nothing else is ever done to it. */
export function SP_info_teleport_destination(_self: EdictT): void {
  // intentionally empty -- see doc comment above.
}

// unused; broken?
// const SPAWNFLAG_TELEPORT_PLAYER_ONLY: SpawnFlags = SpawnFlags_from(1);
// unused
// const SPAWNFLAG_TELEPORT_SILENT: SpawnFlags = SpawnFlags_from(2);
// unused
// const SPAWNFLAG_TELEPORT_CTF_ONLY: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAG_TELEPORT_START_ON: SpawnFlags = SpawnFlags_from(8);

/*QUAKED trigger_teleport (.5 .5 .5) ? player_only silent ctf_only start_on
Any object touching this will be transported to the corresponding
info_teleport_destination entity. You must set the "target" field,
and create an object with a "targetname" field that matches.

If the trigger_teleport has a targetname, it will only teleport
entities when it has been fired.

player_only: only players are teleported
silent: <not used right now>
ctf_only: <not used right now>
start_on: when trigger has targetname, start active, deactivate when used.
*/
/** rogue/g_rogue_newtrig.cpp:37-97 `TOUCH(trigger_teleport_touch)`. See file
 *  header's "DEVIATIONS" note on the redundant `other.client` re-check. */
const trigger_teleport_touch: TouchFn = RegisterTouch("trigger_teleport_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client === null) return;

  if (self.delay) return;

  const dest = G_PickTarget(self.target);
  if (dest === null) {
    gi.Com_Print("Teleport Destination not found!\n");
    return;
  }

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_TELEPORT_EFFECT);
  gi.WritePosition(other.s.origin);
  gi.multicast(other.s.origin, KexMulticastT.MULTICAST_PVS, false);

  other.s.origin = vec3(dest.s.origin[0], dest.s.origin[1], dest.s.origin[2]);
  other.s.old_origin = vec3(dest.s.origin[0], dest.s.origin[1], dest.s.origin[2]);
  other.s.origin[2] += 10;

  // clear the velocity and hold them in place briefly
  other.velocity = vec3(0, 0, 0);

  if (other.client !== null) {
    other.client.ps.pmove.pm_time = 160; // hold time
    other.client.ps.pmove.pm_flags |= PmflagsT.PMF_TIME_TELEPORT;

    // draw the teleport splash at source and on the player
    other.s.event = KexEntityEventT.EV_PLAYER_TELEPORT;

    // set angles
    other.client.ps.pmove.delta_angles = vec3_sub(dest.s.angles, other.client.resp.cmd_angles);

    other.client.ps.viewangles = vec3(0, 0, 0);
    other.client.v_angle = vec3(0, 0, 0);
  }

  other.s.angles = vec3(0, 0, 0);

  gi.linkentity(other);

  // kill anything at the destination
  KillBox(other, other.client !== null);

  // [Paril-KEX] move sphere, if we own it
  if (other.client !== null && other.client.owned_sphere !== null) {
    const sphere = other.client.owned_sphere;
    sphere.s.origin = vec3(other.s.origin[0], other.s.origin[1], other.absmax[2]);
    sphere.s.angles[YAW] = other.s.angles[YAW];
    gi.linkentity(sphere);
  }
});

/** rogue/g_rogue_newtrig.cpp:99-105 `USE(trigger_teleport_use)`. */
const trigger_teleport_use: UseFn = RegisterUse("trigger_teleport_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.delay = self.delay ? 0 : 1;
});

/** rogue/g_rogue_newtrig.cpp:107-131 `void SP_trigger_teleport(edict_t *self)`. */
export function SP_trigger_teleport(self: EdictT): void {
  if (!self.wait) self.wait = 0.2;

  self.delay = 0;

  if (self.targetname !== null) {
    self.use = trigger_teleport_use;
    if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_TELEPORT_START_ON)) self.delay = 1;
  }

  self.touch = trigger_teleport_touch;

  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;

  if (vec3_any_nonzero(self.s.angles)) G_SetMovedir(self.s.angles, self.movedir);

  if (self.model === null) throw new Error("SP_trigger_teleport: self.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(self, self.model);
  gi.linkentity(self);
}

// ***************************
// TRIGGER_DISGUISE
// ***************************

/*QUAKED trigger_disguise (.5 .5 .5) ? TOGGLE START_ON REMOVE
Anything passing through this trigger when it is active will
be marked as disguised.

TOGGLE - field is turned off and on when used. (Paril N.B.: always the case)
START_ON - field is active when spawned.
REMOVE - field removes the disguise
*/

// unused
// const SPAWNFLAG_DISGUISE_TOGGLE: SpawnFlags = SpawnFlags_from(1);
const SPAWNFLAG_DISGUISE_START_ON: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAG_DISGUISE_REMOVE: SpawnFlags = SpawnFlags_from(4);

/** rogue/g_rogue_newtrig.cpp:151-160 `TOUCH(trigger_disguise_touch)`. */
const trigger_disguise_touch: TouchFn = RegisterTouch("trigger_disguise_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client !== null) {
    if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DISGUISE_REMOVE)) other.flags &= ~EntFlagsT.FL_DISGUISED;
    else other.flags |= EntFlagsT.FL_DISGUISED;
  }
});

/** rogue/g_rogue_newtrig.cpp:162-170 `USE(trigger_disguise_use)`. */
const trigger_disguise_use: UseFn = RegisterUse("trigger_disguise_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (self.solid === SolidT.SOLID_NOT) self.solid = SolidT.SOLID_TRIGGER;
  else self.solid = SolidT.SOLID_NOT;

  gi.linkentity(self);
});

/** rogue/g_rogue_newtrig.cpp:172-189 `void SP_trigger_disguise(edict_t *self)`. */
export function SP_trigger_disguise(self: EdictT): void {
  if (!level.disguise_icon) level.disguise_icon = gi.imageindex("i_disguise");

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_DISGUISE_START_ON)) self.solid = SolidT.SOLID_TRIGGER;
  else self.solid = SolidT.SOLID_NOT;

  self.touch = trigger_disguise_touch;
  self.use = trigger_disguise_use;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags = SvflagsT.SVF_NOCLIENT;

  if (self.model === null) throw new Error("SP_trigger_disguise: self.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(self, self.model);
  gi.linkentity(self);
}
