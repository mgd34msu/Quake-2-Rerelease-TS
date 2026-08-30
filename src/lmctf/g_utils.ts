// Ports a SUBSET of lmctf60/g_utils.c -- diff-derived from src/ctf/g_utils.ts
// (lmctf60/g_utils.c vs quake-2/ctf/g_utils.c: 237-line diff of 635 total).
//
// STATUS: G_FreeEdict, G_Spawn, and G_InitEdict are ported here -- the three
// g_utils.c functions the offhand-hook priority feature depends on
// (g_ctffunc.ts's ctf_hook_abort frees the hook bolt entity through
// G_FreeEdict; p_weapon.ts's fire_hook spawns it through G_Spawn, which
// itself calls G_InitEdict). G_Spawn/G_InitEdict are byte-identical to
// src/ctf/g_utils.ts's versions (the only lmctf60 diff is a `0.5` ->
// `0.5f` float-literal suffix with no behavior change).
//
// The rest of g_utils.c (G_Find, G_PickTarget, G_UseTargets, findradius,
// findallradius -- an LM_CTF addition per g_local.h's diff --,
// G_ProjectSource, G_SetMovedir, vtos, G_TouchTriggers, G_TouchSolids,
// KillBox, and every timer helper) is NOT ported. This file will need to be
// replaced wholesale once g_utils.c gets its own full diff-driven pass.

import type { Vec3 } from "../shared/math";
import { M_PI, PITCH, ROLL, YAW } from "../shared/q_shared";
import { BODY_QUEUE_SIZE, type EdictT, g_edicts, game, gameCvars, gi, globals, level } from "./g_local";

/*
=================
vectoangles (lmctf60/g_utils.c) -- byte-identical baseq2 math to
src/ctf/g_utils.ts's vectoangles. Needed by p_weapon.ts's fire_hook to
orient the hook bolt's model along its firing direction.
=================
*/
export function vectoangles(vec: Vec3, angles: Vec3): void {
  let yaw: number;
  let pitch: number;

  if (vec[1] === 0 && vec[0] === 0) {
    yaw = 0;
    pitch = vec[2] > 0 ? 90 : 270;
  } else {
    if (vec[0]) {
      yaw = Math.trunc((Math.atan2(vec[1], vec[0]) * 180) / M_PI);
    } else if (vec[1] > 0) {
      yaw = 90;
    } else {
      yaw = -90;
    }
    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
    pitch = Math.trunc((Math.atan2(vec[2], forward) * 180) / M_PI);
    if (pitch < 0) pitch += 360;
  }

  angles[PITCH] = -pitch;
  angles[YAW] = yaw;
  angles[ROLL] = 0;
}

/*
=================
G_ProjectSource (lmctf60/g_utils.c) -- byte-identical baseq2 math to
src/ctf/g_utils.ts's G_ProjectSource. Needed by p_weapon.ts's
P_ProjectSource (used by Weapon_Hook_Fire to compute the hook's muzzle
point).
=================
*/
export function G_ProjectSource(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  result[0] = point[0] + forward[0] * distance[0] + right[0] * distance[1];
  result[1] = point[1] + forward[1] * distance[0] + right[1] * distance[1];
  result[2] = point[2] + forward[2] * distance[0] + right[2] * distance[1] + distance[2];
}

/*
=================
G_InitEdict (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts
=================
*/
export function G_InitEdict(e: EdictT): void {
  e.inuse = true;
  e.classname = "noclass";
  e.gravity = 1.0;
  // `e - g_edicts` (pointer offset) recovered by identity lookup instead of
  // address arithmetic, same as src/ctf/g_utils.ts's G_InitEdict.
  e.s.number = g_edicts.indexOf(e);
}

/*
=================
G_Spawn (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts aside
from the dead `0.5` -> `0.5f` literal-suffix change noted above.
=================
*/
export function G_Spawn(): EdictT {
  const maxclients = gameCvars.maxclients === null ? 0 : gameCvars.maxclients.value;

  let i = maxclients + 1;
  for (; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e !== undefined && !e.inuse && (e.freetime < 2 || level.time - e.freetime > 0.5)) {
      G_InitEdict(e);
      return e;
    }
  }

  if (i === game.maxentities) {
    gi.error("ED_Alloc: no free edicts");
  }

  globals.num_edicts++;
  const e = g_edicts[i];
  if (e === undefined) {
    throw new Error(`G_Spawn: g_edicts has no preallocated slot at index ${i}`);
  }
  G_InitEdict(e);
  return e;
}

/*
=================
G_FreeEdict (lmctf60/g_utils.c:467)

Identical to src/ctf/g_utils.ts's G_FreeEdict -- lmctf60's only change from
the ctf ancestor is a commented-out (never compiled) LM_JORM debug assert
block that is not reproduced here since it is dead code even in the C
source (a comment, not an #ifdef branch).

Marks the edict as free. Refuses to free the world/client/body-queue
range of the g_edicts array (indices 0..maxclients+BODY_QUEUE_SIZE),
matching the C pointer-arithmetic bound `(ed - g_edicts) <=
(maxclients->value + BODY_QUEUE_SIZE)` exactly via `g_edicts.indexOf(ed)`.
=================
*/
export function G_FreeEdict(ed: EdictT): void {
  gi.unlinkentity(ed); // unlink from world

  const maxclients = gameCvars.maxclients === null ? 0 : gameCvars.maxclients.value;
  const index = g_edicts.indexOf(ed);
  if (index <= maxclients + BODY_QUEUE_SIZE) {
    //		gi.dprintf("tried to free special edict\n");
    return;
  }

  ed.clear(); // memset (ed, 0, sizeof(*ed))
  ed.classname = "freed";
  ed.freetime = level.time;
  ed.inuse = false;
}
