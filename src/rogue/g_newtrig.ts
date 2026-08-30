// g_newtrig.c
// pmack
// october 1997
//
// Pack-only file (no baseq2 sibling): trigger_teleport (moved here from the
// base game's teleport spawn in this rerelease tree) plus trigger_disguise,
// which marks touching entities with FL_DISGUISED so monsters won't
// recognize them (see g_newai.ts's has_valid_enemy / disguise checks).

import { vec3_origin, VectorClear, VectorCompare, VectorCopy } from "../shared/math";
import {
  ANGLE2SHORT,
  type CplaneT,
  type CsurfaceT,
  EntityEventT,
  MulticastT,
  PMF_TIME_TELEPORT,
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import { type EdictT, FL_DISGUISED, gi, MovetypeT, svc_temp_entity } from "./g_local";
import { G_Find, G_SetMovedir, KillBox } from "./g_utils";

const TELEPORT_PLAYER_ONLY = 1;
const TELEPORT_SILENT = 2;
const TELEPORT_CTF_ONLY = 4;
const TELEPORT_START_ON = 8;

/*QUAKED info_teleport_destination (.5 .5 .5) (-16 -16 -24) (16 16 32)
Destination marker for a teleporter.
*/
export function SP_info_teleport_destination(_self: EdictT): void {}

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
export function trigger_teleport_touch(
  self: EdictT,
  other: EdictT,
  _plane: CplaneT | null,
  _surf: CsurfaceT | null,
): void {
  // (self->spawnflags & TELEPORT_PLAYER_ONLY) && -- commented out in the C
  if (other.client === null) return;

  if (self.delay) return;

  const dest = G_Find(null, "targetname", self.target ?? "");
  if (dest === null) {
    gi.dprintf("Teleport Destination not found!\n");
    return;
  }

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_TELEPORT_EFFECT);
  gi.WritePosition(other.s.origin);
  gi.multicast(other.s.origin, MulticastT.MULTICAST_PVS);

  // unlink to make sure it can't possibly interfere with KillBox
  gi.unlinkentity(other);

  VectorCopy(dest.s.origin, other.s.origin);
  VectorCopy(dest.s.origin, other.s.old_origin);
  other.s.origin[2] += 10;

  // clear the velocity and hold them in place briefly
  VectorClear(other.velocity);
  if (other.client !== null) {
    other.client.ps.pmove.pm_time = 160 >> 3; // hold time
    other.client.ps.pmove.pm_flags |= PMF_TIME_TELEPORT;

    // draw the teleport splash at source and on the player
    other.s.event = EntityEventT.EV_PLAYER_TELEPORT;

    // set angles
    for (let i = 0; i < 3; i++) {
      other.client.ps.pmove.delta_angles[i] = ANGLE2SHORT(
        dest.s.angles[i]! - other.client.resp.cmd_angles[i]!,
      );
    }

    VectorClear(other.client.ps.viewangles);
    VectorClear(other.client.v_angle);
  }

  VectorClear(other.s.angles);

  // kill anything at the destination
  KillBox(other);

  gi.linkentity(other);
}

export function trigger_teleport_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.delay) self.delay = 0;
  else self.delay = 1;
}

export function SP_trigger_teleport(self: EdictT): void {
  if (!self.wait) self.wait = 0.2;

  self.delay = 0;

  if (self.targetname) {
    self.use = trigger_teleport_use;
    if (!(self.spawnflags & TELEPORT_START_ON)) self.delay = 1;
  }

  self.touch = trigger_teleport_touch;

  self.solid = SolidT.SOLID_TRIGGER;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  // self.flags |= FL_NOCLIENT; -- commented out in the C

  if (VectorCompare(self.s.angles, vec3_origin) === 0) G_SetMovedir(self.s.angles, self.movedir);

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}

// ***************************
// TRIGGER_DISGUISE
// ***************************

/*QUAKED trigger_disguise (.5 .5 .5) ? TOGGLE START_ON REMOVE
Anything passing through this trigger when it is active will
be marked as disguised.

TOGGLE - field is turned off and on when used.
START_ON - field is active when spawned.
REMOVE - field removes the disguise
*/

export function trigger_disguise_touch(
  self: EdictT,
  other: EdictT,
  _plane: CplaneT | null,
  _surf: CsurfaceT | null,
): void {
  if (other.client !== null) {
    if (self.spawnflags & 4) other.flags &= ~FL_DISGUISED;
    else other.flags |= FL_DISGUISED;
  }
}

export function trigger_disguise_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.solid === SolidT.SOLID_NOT) self.solid = SolidT.SOLID_TRIGGER;
  else self.solid = SolidT.SOLID_NOT;

  gi.linkentity(self);
}

export function SP_trigger_disguise(self: EdictT): void {
  if (self.spawnflags & 2) self.solid = SolidT.SOLID_TRIGGER;
  else self.solid = SolidT.SOLID_NOT;

  self.touch = trigger_disguise_touch;
  self.use = trigger_disguise_use;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags = SVF_NOCLIENT;

  gi.setmodel(self, self.model ?? "");
  gi.linkentity(self);
}
