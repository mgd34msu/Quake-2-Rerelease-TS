// p_trail.c
//
// g_local.h calls this file "g_ptrail.c", which does not exist; grepping
// the C tree shows these functions are defined in p_trail.c.

/*
==============================================================================

PLAYER TRAIL

==============================================================================

This is a circular list containing the a list of points of where
the player has been recently.  It is used by monsters for pursuit.

.origin		the spot
.owner		forward link
.aiment		backward link
*/

import { vec3, type Vec3, VectorCopy, VectorSubtract } from "../shared/math";
import type { CvarT } from "../shared/q_shared";
import { type EdictT, gameCvars, level } from "./g_local";
import { visible } from "./g_ai";
import { G_Spawn, vectoyaw } from "./g_utils";

// a per-file local mirrors g_items.ts's own cvarNum (module-local there too,
// so not reusable) rather than inventing a shared helper outside this
// file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

const TRAIL_LENGTH = 8;

function NEXT(n: number): number {
  return (n + 1) & (TRAIL_LENGTH - 1);
}
function PREV(n: number): number {
  return (n - 1) & (TRAIL_LENGTH - 1);
}

let trail: EdictT[] = [];
let trail_head = 0;
let trail_active = false;

export function PlayerTrail_Init(): void {
  if (cvarNum(gameCvars.deathmatch) /* FIXME || coop */) return;

  trail = [];
  for (let n = 0; n < TRAIL_LENGTH; n++) {
    const t = G_Spawn();
    t.classname = "player_trail";
    trail.push(t);
  }

  trail_head = 0;
  trail_active = true;
}

export function PlayerTrail_Add(spot: Vec3): void {
  if (!trail_active) return;

  const marker = trail[trail_head];
  VectorCopy(spot, marker.s.origin);

  marker.timestamp = level.time;

  const temp = vec3();
  VectorSubtract(spot, trail[PREV(trail_head)].s.origin, temp);
  marker.s.angles[1] = vectoyaw(temp);

  trail_head = NEXT(trail_head);
}

export function PlayerTrail_New(spot: Vec3): void {
  if (!trail_active) return;

  PlayerTrail_Init();
  PlayerTrail_Add(spot);
}

export function PlayerTrail_PickFirst(self: EdictT): EdictT | null {
  if (!trail_active) return null;

  let marker = trail_head;
  for (let n = TRAIL_LENGTH; n; n--) {
    if (trail[marker].timestamp <= self.monsterinfo.trail_time) marker = NEXT(marker);
    else break;
  }

  if (visible(self, trail[marker])) {
    return trail[marker];
  }

  if (visible(self, trail[PREV(marker)])) {
    return trail[PREV(marker)];
  }

  return trail[marker];
}

export function PlayerTrail_PickNext(self: EdictT): EdictT | null {
  if (!trail_active) return null;

  let marker = trail_head;
  for (let n = TRAIL_LENGTH; n; n--) {
    if (trail[marker].timestamp <= self.monsterinfo.trail_time) marker = NEXT(marker);
    else break;
  }

  return trail[marker];
}

export function PlayerTrail_LastSpot(): EdictT | null {
  return trail[PREV(trail_head)] ?? null;
}
