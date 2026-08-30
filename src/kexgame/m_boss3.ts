// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// m_boss3.c -- the "monster_boss3_stand" prop-shell (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/m_boss3.cpp (61 lines, no
// separate header). This is the pre-Makron statue seen in the Jorg/Makron
// arena: it just stands and cycles its idle animation until targeted, at
// which point it teleport-hides itself (a real Makron edict is spawned
// separately elsewhere, e.g. via `m_boss32.ts`'s `MakronToss`, not by this
// file). Its idle cycle reuses Makron's own `FRAME_stand201`/`FRAME_stand260`
// range, imported from `./m_boss32` -- matching the legacy 3.21 precedent
// (`src/game/m_boss3.ts` imports `src/game/m_boss32_frames.ts`).
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `gi.WriteByte`/`WritePosition`/`multicast` temp-entity broadcast uses
//   this port line's `ServerCommandT`/`KexTempEventT`/`KexMulticastT` enums
//   (kexapi/game.ts), matching every other file's established idiom for the
//   same C++ `svc_temp_entity`/`TE_*`/`MULTICAST_*` triple.
// - `self->mins = { -32, -32, 0 };` / `self->maxs = { 32, 32, 90 };` become
//   `vec3(...)` assignments, per this port line's Vec3 convention.

import { vec3 } from "../shared/math";
import { ServerCommandT, KexMulticastT, KexTempEventT, SolidT, SvflagsT } from "../kexapi/game";
import { type EdictT, MovetypeT } from "./g_local";
import { gi, level } from "./g_main_globals";
import type { ThinkFn, UseFn } from "./g_local_types";
import { RegisterThink, RegisterUse } from "./g_save_registry";
import { M_AllowSpawn } from "./g_monster";
import { G_FreeEdict } from "./g_utils";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { FRAME_stand201, FRAME_stand260 } from "./m_boss32";

/** m_boss3.cpp:15-23 `USE(Use_Boss3)`. */
export function Use_Boss3(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_BOSSTPORT);
  gi.WritePosition(self.s.origin);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PHS, false);

  // just hide, don't kill ent so we can trigger it again
  self.svflags |= SvflagsT.SVF_NOCLIENT;
  self.solid = SolidT.SOLID_NOT;
}
RegisterUse("Use_Boss3", Use_Boss3);

/** m_boss3.cpp:25-32 `THINK(Think_Boss3Stand)`. */
export function Think_Boss3Stand(self: EdictT): void {
  if (self.s.frame === FRAME_stand260) self.s.frame = FRAME_stand201;
  else self.s.frame++;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
}
RegisterThink("Think_Boss3Stand", Think_Boss3Stand);

/**
 * m_boss3.cpp:34-63 `SP_monster_boss3_stand`.
 *
 * QUAKED monster_boss3_stand (1 .5 0) (-32 -32 0) (32 32 90)
 * Just stands and cycles in one place until targeted, then teleports away.
 */
export function SP_monster_boss3_stand(self: EdictT): void {
  if (!M_AllowSpawn(self)) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/boss3/rider/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.s.frame = FRAME_stand201;

  gi.soundindex("misc/bigtele.wav");

  self.mins = vec3(-32, -32, 0);
  self.maxs = vec3(32, 32, 90);

  self.use = Use_Boss3;
  self.think = Think_Boss3Stand;
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
  gi.linkentity(self);
}
