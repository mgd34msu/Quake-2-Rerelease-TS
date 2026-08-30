// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_items.c -- rogue-specific item pickup/use logic (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_items.cpp (228
// lines, C++17).
//
// ============================================================================
// MOST OF THIS FILE'S SOURCE IS ALREADY PORTED FOR REAL -- IN g_items.ts
// ============================================================================
// Per this port line's "small cross-file functions ported here for real"
// precedent (g_items.ts's own header, "SMALL CROSS-FILE FUNCTIONS PORTED
// HERE FOR REAL" section), a prior unit already transcribed 10 of this
// file's 12 top-level functions directly into g_items.ts, verified against
// this exact C++ source (not against a copy of a copy):
//   - `Pickup_Nuke`          (rogue/g_rogue_items.cpp:8)   -> g_items.ts:565 (unexported)
//   - `Use_IR`               (rogue/g_rogue_items.cpp:33)  -> g_items.ts:585 (unexported)
//   - `Use_Double`           (rogue/g_rogue_items.cpp:42)  -> g_items.ts:593 (unexported)
//   - `Pickup_Doppleganger`  (rogue/g_rogue_items.cpp:90)  -> g_items.ts:601 (unexported)
//   - `Pickup_Sphere`        (rogue/g_rogue_items.cpp:109) -> g_items.ts:619 (unexported)
//   - `Use_Defender`         (rogue/g_rogue_items.cpp:146) -> g_items.ts:646 (unexported)
//   - `Use_Hunter`           (rogue/g_rogue_items.cpp:159) -> g_items.ts:657 (unexported)
//   - `Use_Vengeance`        (rogue/g_rogue_items.cpp:172) -> g_items.ts:668 (unexported)
//   - `Item_TriggeredSpawn`  (rogue/g_rogue_items.cpp:191) -> g_items.ts:1601 (exported)
//   - `SetTriggeredSpawn`    (rogue/g_rogue_items.cpp:217) -> g_items.ts:1623 (exported)
// All ten are wired into g_items.ts's own 43-entry `itemlist` (or, for
// `Item_TriggeredSpawn`/`SetTriggeredSpawn`, called unconditionally from
// `SpawnItem` for every `SPAWNFLAG_ITEM_TRIGGER_SPAWN` item) -- reachable
// in every real game today, not stubs. The eight `Pickup_*`/`Use_*`
// handlers are NOT exported from g_items.ts (file-local, itemlist-only,
// same as most of that file's other handler functions), so this file
// cannot re-export them without an additional g_items.ts edit outside this
// unit's authorized scope (only the two `DoRandomRespawn`/`Tag_PickupToken`
// stub swaps, per the brief) -- documented here instead, matching this
// port line's "re-export, don't duplicate" mandate in spirit (there is
// nothing left to duplicate: the real bodies already exist, once, in their
// one correct home).
//
// ============================================================================
// THIS FILE'S ACTUAL CONTENT: THE TWO REMAINING FUNCTIONS
// ============================================================================
// `Use_Nuke` (rogue/g_rogue_items.cpp:51) and `Use_Doppleganger`
// (rogue/g_rogue_items.cpp:65) are the only two top-level functions in this
// C++ source NOT already ported anywhere -- g_items.ts's own header
// explicitly flags both as throwing stubs "pending g_rogue_newweap.ts"/
// "pending g_rogue_spawn.ts/g_rogue_newdm.ts". Ported for real below, each
// depending on functions that live in OTHER, not-yet-landed clusters:
//   - `Use_Nuke` needs `fire_nuke` (rogue/g_rogue_newweap.cpp:770) -- the
//     WEAPONS cluster (a different concurrent unit's file scope). Left as
//     a local throwing stub, cited to its real file.
//   - `Use_Doppleganger` needs `FindSpawnPoint`/`CheckGroundSpawnPoint`
//     (rogue/g_rogue_spawn.cpp:79/139) -- the FUNC/TRIG/TARG/SPAWN cluster
//     (also a different concurrent unit) -- AND `SpawnGrow_Spawn`
//     (rogue/g_rogue_spawn.cpp:200, same cluster) -- AND `fire_doppleganger`
//     (rogue/g_rogue_newdm.cpp:242), which IS in this unit's scope and IS
//     real (imported from `./g_rogue_newdm`, not stubbed).
// `Use_Nuke`/`Use_Doppleganger` themselves are real, matching this port
// line's "ported for real, deps that stay stubs" precedent (see
// g_items.ts's own identical treatment of `Use_Defender`/`Use_Hunter`/
// `Use_Vengeance` depending on the still-unported `Defender_Launch`/
// `Hunter_Launch`/`Vengeance_Launch`).
//
// ============================================================================
// NOT SWAPPED (out of this unit's edit scope) -- reported to the coordinator
// ============================================================================
// g_items.ts's own local throwing stubs for `Use_Nuke`/`Use_Doppleganger`
// are SEPARATE copies from the real ones below (not the same function
// object) -- g_items.ts is off-limits to this unit beyond its two
// authorized stub swaps (`DoRandomRespawn`/`Tag_PickupToken`), so those two
// stubs are NOT swapped for imports from here. Once the weapons cluster
// lands `fire_nuke` and the func/trig/targ/spawn cluster lands
// `FindSpawnPoint`/`CheckGroundSpawnPoint`/`SpawnGrow_Spawn` for real, the
// coordinator can either (a) swap g_items.ts's two stubs for imports from
// here, or (b) update this file's own two local stubs to import the real
// versions -- whichever lands first determines which direction makes
// sense; reported, not decided, here.

import { type Vec3, vec3 } from "../../shared/math";
import { PITCH, YAW, ROLL } from "../../shared/q_shared";
import type { EdictT, GClientT, GitemT } from "../g_local";
import { AngleVectors, vec3_add, vec3_muls } from "../q_vec3";
import { fire_doppleganger } from "./g_rogue_newdm";

function requireClient(ent: EdictT, fnName: string): GClientT {
  if (ent.client === null) {
    throw new Error(`${fnName}: called against a non-client entity (${ent.classname ?? "?"}) -- the C++ source dereferences ->client unconditionally here`);
  }
  return ent.client;
}

/** rogue/g_rogue_newweap.cpp:770: `void fire_nuke(edict_t *self, const
 *  vec3_t &start, const vec3_t &aimdir, int speed)` -- weapons cluster,
 *  not this unit's file scope. See file header's "THIS FILE'S ACTUAL
 *  CONTENT" note. */
function fire_nuke(_self: EdictT, _start: Vec3, _aimdir: Vec3, _speed: number): void {
  throw new Error("fire_nuke: not yet ported (pending g_rogue_newweap.ts, see rogue/g_rogue_newweap.cpp:770)");
}

/** rogue/g_rogue_spawn.cpp:79: `bool FindSpawnPoint(const vec3_t
 *  &startPoint, const vec3_t &mins, const vec3_t &maxs, vec3_t
 *  &spawnPoint, float dist, bool inSolidCheck)` -- func/trig/targ/spawn
 *  cluster, not this unit's file scope. */
function FindSpawnPoint(_startPoint: Vec3, _mins: Vec3, _maxs: Vec3, _spawnPointOut: [Vec3], _dist: number): boolean {
  throw new Error("FindSpawnPoint: not yet ported (pending g_rogue_spawn.ts, see rogue/g_rogue_spawn.cpp:79)");
}

/** rogue/g_rogue_spawn.cpp:139: `bool CheckGroundSpawnPoint(const vec3_t
 *  &origin, const vec3_t &entMins, const vec3_t &entMaxs, float height,
 *  int drop)` -- func/trig/targ/spawn cluster, not this unit's file scope. */
function CheckGroundSpawnPoint(_origin: Vec3, _entMins: Vec3, _entMaxs: Vec3, _height: number, _drop: number): boolean {
  throw new Error("CheckGroundSpawnPoint: not yet ported (pending g_rogue_spawn.ts, see rogue/g_rogue_spawn.cpp:139)");
}

/** rogue/g_rogue_spawn.cpp:200: `edict_t *SpawnGrow_Spawn(const vec3_t
 *  &startpos, float start_size, float end_size)` -- func/trig/targ/spawn
 *  cluster, not this unit's file scope. */
function SpawnGrow_Spawn(_startpos: Vec3, _start_size: number, _end_size: number): void {
  throw new Error("SpawnGrow_Spawn: not yet ported (pending g_rogue_spawn.ts, see rogue/g_rogue_spawn.cpp:200)");
}

/** rogue/g_rogue_items.cpp:51-63: `void Use_Nuke(edict_t *ent, gitem_t *item)`. */
export function Use_Nuke(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Nuke");
  client.pers.inventory[item.id]--;

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  const start = ent.s.origin;
  const speed = 100;
  fire_nuke(ent, start, forward, speed);
}

/** rogue/g_rogue_items.cpp:65-88: `void Use_Doppleganger(edict_t *ent, gitem_t *item)`. */
export function Use_Doppleganger(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Doppleganger");

  const ang = vec3(0, 0, 0);
  ang[PITCH] = 0;
  ang[YAW] = client.v_angle[YAW];
  ang[ROLL] = 0;
  const forward = vec3();
  const right = vec3();
  AngleVectors(ang, forward, right, null);

  const createPt = vec3_add(ent.s.origin, vec3_muls(forward, 48));

  const spawnPtBox: [Vec3] = [vec3()];
  if (!FindSpawnPoint(createPt, ent.mins, ent.maxs, spawnPtBox, 32)) return;
  const spawnPt = spawnPtBox[0];

  if (!CheckGroundSpawnPoint(spawnPt, ent.mins, ent.maxs, 64, -1)) return;

  client.pers.inventory[item.id]--;

  SpawnGrow_Spawn(spawnPt, 24, 48);
  fire_doppleganger(ent, spawnPt, forward);
}
