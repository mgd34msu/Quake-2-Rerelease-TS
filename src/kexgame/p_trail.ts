// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_trail.c -- the player trail (2023 Quake II re-release / "KEX" engine).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/p_trail.cpp (153
// lines, C++17): PlayerTrail_Spawn (static helper), PlayerTrail_Destroy,
// PlayerTrail_Add, PlayerTrail_Pick. Behavioral code, ported bug-for-bug per
// this port line's house conventions (see g_monster.ts/g_utils.ts headers).
//
// This is a two-way list of points where each player has recently been,
// used by monsters for pursuit (`chain` = next, `enemy` = prev, per the
// C++ source's own doc comment above `PlayerTrail_Spawn`). The list lives
// in `gclient_t.trail_head`/`.trail_tail` (per-client, not global), so it
// survives across multiple simultaneous clients.
//
// The C++ header (g_local.h:2383-2385) declares exactly three public
// functions: `PlayerTrail_Add`, `PlayerTrail_Destroy`, `PlayerTrail_Pick`.
// There is no `PlayerTrail_Init` anywhere in this source tree (grepped
// g_local.h and every .cpp under quake2-rerelease-dll/rerelease -- zero
// matches) -- the brief's "PlayerTrail_Init/Add/Destroy/Pick" naming
// appears to be an approximation of `PlayerTrail_Spawn` (the static,
// non-exported head-allocation helper `PlayerTrail_Add` calls). Ported
// here as `PlayerTrail_Spawn`, matching the real C++ name, not invented as
// an "Init".
//
// ============================================================================
// PlayerTrail_Destroy: canonicalized HERE (2026-08-30 cleanup sweep)
// ============================================================================
// p_hud.ts used to carry an independent, identical copy of this function
// (ported before this file existed for real, under the "self-contained,
// port it here" precedent). Now that p_trail.ts is this function's real
// C++ home and has landed, p_hud.ts imports/re-exports it from here instead
// of keeping its own copy; p_client.ts's existing
// `import { ... PlayerTrail_Destroy } from "./p_hud"` is unaffected.
//
// ============================================================================
// IMPORT: `visible` from g_ai.ts -- real, sanctioned, two-way cycle
// ============================================================================
// `PlayerTrail_Pick`'s "from that marker, find the first one we can see"
// branch (p_trail.cpp:148) calls `visible(self, marker)` -- g_ai.cpp's own
// function (g_ai.ts:550, real, landed, a substantive BSP-trace/PVS check,
// not a tiny helper worth duplicating). g_ai.ts, in turn, imports
// `PlayerTrail_Pick` from THIS file (its own former local throwing stub,
// now swapped for a real import as part of this same unit). This closes a
// real, sanctioned import cycle, exactly the same shape as g_utils.ts's
// documented cycles with g_phys.ts/g_combat.ts/p_client.ts: every
// cross-module symbol on both sides (`visible`, `PlayerTrail_Pick`) is a
// hoisted `export function` declaration, never a top-level `const`
// evaluated at module-init time, and both are only ever invoked from
// inside another function's body at real game-frame time, long after both
// modules have finished linking. No TDZ hazard. Verified end-to-end by
// `bunx tsc --noEmit` and `bun test` actually importing both files
// together.
//
// ============================================================================
// PlayerTrail_Add: now REAL here; p_client.ts's own copy is a STALE STUB,
// not swapped (p_client.ts is out of this unit's write scope)
// ============================================================================
// p_client.ts carries its own local, unexported throwing stub for
// `PlayerTrail_Add` (cited "pending p_trail.ts, see p_trail.cpp"), called
// from `ClientEndServerFrame`'s "not in deathmatch" tail
// (`if (!deathmatchEnabled()) PlayerTrail_Add(ent);`). p_client.ts is
// explicitly off this unit's file list (owned by a concurrent agent) --
// per this unit's own brief, EVERY p_client.cpp/p_weapon.cpp cross-
// dependency is treated as an unported stub regardless of that file's
// current on-disk state (it is being edited concurrently and its state is
// not stable to build against). The real, canonical `PlayerTrail_Add`
// below is this unit's genuine contribution to p_trail.cpp's own scope;
// swapping p_client.ts's stub for an import from here is left to a future
// unit with write access to p_client.ts, mirroring g_monster.ts's own
// "not swapped here, future unit's job" precedent for g_utils.ts's
// G_MonsterKilled stub.
//
// ============================================================================
// OTHER DEVIATIONS
// ============================================================================
// - `PlayerTrail_Spawn`'s C++ signature returns a raw `edict_t*`; ported
//   with the same signature (`EdictT`), non-exported (`static` in the
//   C++ source, called only by `PlayerTrail_Add` in the same file).
// - `size_t len` computed by walking `trail_tail->chain` links, compared
//   against `TRAIL_LENGTH` (8): ported as a plain `number` loop counter,
//   no overflow concern at this scale.
// - `trail->s.origin = player->s.old_origin` (C++ struct-copy assignment):
//   `VectorCopy`-equivalent element-wise copy into the `Vec3` (a
//   `Float32Array`), per this port line's "never return fresh arrays on
//   hot paths, mutate in place" convention (PORTING.md's `Vec3` note).

import type { Vec3 } from "../shared/math";
import { type EdictT, MovetypeT } from "./g_local";
import { g_edicts, game, globals, level } from "./g_main_globals";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { visible } from "./g_ai";
import { Gtime_nonzero } from "./gtime";

const TRAIL_LENGTH = 8;

function vectorCopy(src: Vec3, dst: Vec3): void {
  dst[0] = src[0];
  dst[1] = src[1];
  dst[2] = src[2];
}

// ---------------------------------------------------------------------------
// PlayerTrail_Spawn (p_trail.cpp:30-66, `static edict_t *PlayerTrail_Spawn`)
// ---------------------------------------------------------------------------

/** places a new entity at the head of the player trail. the tail entity
 *  may be moved to the front if the length is at the end. */
function PlayerTrail_Spawn(owner: EdictT): EdictT {
  const client = owner.client;
  if (client === null) {
    throw new Error("PlayerTrail_Spawn: called against an entity with no .client set -- the C++ source dereferences owner->client unconditionally here");
  }

  let len = 0;
  for (let tail = client.trail_tail; tail !== null; tail = tail.chain) len++;

  let trail: EdictT;

  if (len === TRAIL_LENGTH) {
    // move the tail to the head
    if (client.trail_tail === null) {
      throw new Error("PlayerTrail_Spawn: trail_tail is null with len === TRAIL_LENGTH -- invariant violated (the C++ source dereferences it unconditionally here)");
    }
    trail = client.trail_tail;
    client.trail_tail = trail.chain;
    if (client.trail_tail !== null) client.trail_tail.enemy = null;
    trail.chain = null;
    trail.enemy = null;
  } else {
    // spawn a new head
    trail = G_Spawn();
    trail.classname = "player_trail";
  }

  // link as new head
  if (client.trail_head !== null) client.trail_head.chain = trail;
  trail.enemy = client.trail_head;
  client.trail_head = trail;

  // if there's no tail, we become the tail too
  if (client.trail_tail === null) client.trail_tail = trail;

  return trail;
}

// ---------------------------------------------------------------------------
// PlayerTrail_Destroy (p_trail.cpp:70-81) -- real duplicate, see file header
// ---------------------------------------------------------------------------

/** destroys all player trail entities in the map. we don't want these to
 *  stay around across level loads. */
export function PlayerTrail_Destroy(player: EdictT | null): void {
  for (let i = 0; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.classname === "player_trail") {
      if (player === null || e.owner === player) G_FreeEdict(e);
    }
  }

  if (player !== null) {
    const client = player.client;
    if (client !== null) {
      client.trail_head = null;
      client.trail_tail = null;
    }
  } else {
    for (let i = 0; i < game.maxclients; i++) {
      const cl = game.clients[i];
      if (cl !== undefined) {
        cl.trail_head = null;
        cl.trail_tail = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PlayerTrail_Add (p_trail.cpp:85-99)
// ---------------------------------------------------------------------------

/** check to see if we can add a new player trail spot for this player. */
export function PlayerTrail_Add(player: EdictT): void {
  const client = player.client;
  if (client === null) {
    throw new Error("PlayerTrail_Add: called against an entity with no .client set -- the C++ source dereferences player->client unconditionally here");
  }

  // if we can still see the head, we don't want a new one.
  if (client.trail_head !== null && visible(player, client.trail_head)) return;
  // don't spawn trails in intermission, if we're dead, if we're noclipping or not on ground yet
  else if (
    Gtime_nonzero(level.intermissiontime) ||
    player.health <= 0 ||
    player.movetype === MovetypeT.MOVETYPE_NOCLIP ||
    player.groundentity === null
  ) {
    return;
  }

  const trail = PlayerTrail_Spawn(player);
  vectorCopy(player.s.old_origin, trail.s.origin);
  trail.timestamp = level.time;
  trail.owner = player;
}

// ---------------------------------------------------------------------------
// PlayerTrail_Pick (p_trail.cpp:103-153)
// ---------------------------------------------------------------------------

/** pick a trail node that matches the player we're hunting that is visible
 *  to us. */
export function PlayerTrail_Pick(self: EdictT, next: boolean): EdictT | null {
  const hunted = self.enemy;

  // not player or doesn't have a trail yet
  if (hunted === null || hunted.client === null || hunted.client.trail_head === null) return null;

  // find which marker head that was dropped while we
  // were searching for this enemy
  let marker: EdictT | null;

  for (marker = hunted.client.trail_head; marker !== null; marker = marker.enemy) {
    if (marker.timestamp <= self.monsterinfo.trail_time) continue;
    break;
  }

  if (next) {
    // find the marker we're closest to
    let closest_dist = Infinity;
    let closest: EdictT | null = null;

    for (let m2 = marker; m2 !== null; m2 = m2.enemy) {
      const dx = m2.s.origin[0] - self.s.origin[0];
      const dy = m2.s.origin[1] - self.s.origin[1];
      const dz = m2.s.origin[2] - self.s.origin[2];
      const len = dx * dx + dy * dy + dz * dz;

      if (len < closest_dist) {
        closest_dist = len;
        closest = m2;
      }
    }

    // should never happen
    if (closest === null) return null;

    // use the next one from the closest one
    marker = closest.chain;
  } else {
    // from that marker, find the first one we can see
    for (; marker !== null && !visible(self, marker); marker = marker.enemy) continue;
  }

  return marker;
}
