/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/m_boss3.c (GNU GPL v2 or later).
*/
/*
==============================================================================

boss3

==============================================================================
*/

import { VectorSet } from "../shared/math";
import { MulticastT, TempEventT } from "../shared/q_shared";
import { type EdictT, FRAMETIME, gameCvars, gi, level, MovetypeT, svc_temp_entity } from "./g_local";
import { SolidT } from "./game";
import { G_FreeEdict } from "./g_utils";
// m_boss3.c includes m_boss32.h (the rider model's frame table) for its
// stand-cycle frame constants, not its own header -- see m_boss32_frames.ts.
import * as FRAME from "./m_boss32_frames";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

function Use_Boss3(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_BOSSTPORT);
  gi.WritePosition(ent.s.origin);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);
  G_FreeEdict(ent);
}

function Think_Boss3Stand(ent: EdictT): void {
  if (ent.s.frame === FRAME.FRAME_stand260) ent.s.frame = FRAME.FRAME_stand201;
  else ent.s.frame++;
  ent.nextthink = level.time + FRAMETIME;
}

/*QUAKED monster_boss3_stand (1 .5 0) (-32 -32 0) (32 32 90)

Just stands and cycles in one place until targeted, then teleports away.
*/
export function SP_monster_boss3_stand(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.solid = SolidT.SOLID_BBOX;
  self.model = "models/monsters/boss3/rider/tris.md2";
  self.s.modelindex = gi.modelindex(self.model);
  self.s.frame = FRAME.FRAME_stand201;

  gi.soundindex("misc/bigtele.wav");

  VectorSet(self.mins, -32, -32, 0);
  VectorSet(self.maxs, 32, 32, 90);

  self.use = Use_Boss3;
  self.think = Think_Boss3Stand;
  self.nextthink = level.time + FRAMETIME;
  gi.linkentity(self);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("m_boss3:Use_Boss3", Use_Boss3);
registerSaveFunction("m_boss3:Think_Boss3Stand", Think_Boss3Stand);
