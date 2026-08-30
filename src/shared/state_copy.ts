// Struct-copy helpers for entity_state_t and player_state_t (PORTING.md:
// "struct copies need explicit clone helpers"). Canonical home for these --
// previously hand-unrolled and duplicated across src/server/sv_ents.ts and
// src/server/sv_init.ts (Phase-2 sequencing item 1: consolidate before the
// KEX field widening lands).
//
// Lives in its own module rather than beside EntityStateT/PlayerStateT in
// q_shared.ts: q_shared.ts is imported by shared/math.ts (PITCH/YAW/ROLL/
// M_PI/CplaneT), and these helpers need VectorCopy from math.ts, so putting
// them in q_shared.ts would introduce a runtime import cycle between the two
// modules.
import { VectorCopy } from "./math";
import { EntityStateT, PlayerStateT } from "./q_shared";

export function cloneEntityStateInto(src: EntityStateT, dst: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  VectorCopy(src.old_origin, dst.old_origin);
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  dst.effects = src.effects;
  dst.renderfx = src.renderfx;
  dst.solid = src.solid;
  dst.sound = src.sound;
  dst.event = src.event;
}

export function cloneEntityState(src: EntityStateT): EntityStateT {
  const dst = new EntityStateT();
  cloneEntityStateInto(src, dst);
  return dst;
}

export function clonePlayerState(ps: PlayerStateT): PlayerStateT {
  const c = new PlayerStateT();
  c.pmove.pm_type = ps.pmove.pm_type;
  c.pmove.origin.set(ps.pmove.origin);
  c.pmove.velocity.set(ps.pmove.velocity);
  c.pmove.pm_flags = ps.pmove.pm_flags;
  c.pmove.pm_time = ps.pmove.pm_time;
  c.pmove.gravity = ps.pmove.gravity;
  c.pmove.delta_angles.set(ps.pmove.delta_angles);
  VectorCopy(ps.viewangles, c.viewangles);
  VectorCopy(ps.viewoffset, c.viewoffset);
  VectorCopy(ps.kick_angles, c.kick_angles);
  VectorCopy(ps.gunangles, c.gunangles);
  VectorCopy(ps.gunoffset, c.gunoffset);
  c.gunindex = ps.gunindex;
  c.gunframe = ps.gunframe;
  c.blend.set(ps.blend);
  c.fov = ps.fov;
  c.rdflags = ps.rdflags;
  c.stats.set(ps.stats);
  return c;
}
