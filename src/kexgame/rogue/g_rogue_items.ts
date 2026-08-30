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
// "pending g_rogue_spawn.ts/g_rogue_newdm.ts". Ported for real below:
//   - `Use_Nuke` needs `fire_nuke` (rogue/g_rogue_newweap.cpp:770) -- the
//     WEAPONS cluster. src/kexgame/rogue/g_rogue_newweap.ts has since
//     landed with a real, exported `fire_nuke`; imported for real above
//     (2026-08-30 stale-comment sweep).
//   - `Use_Doppleganger` needs `FindSpawnPoint`/`CheckGroundSpawnPoint`
//     (rogue/g_rogue_spawn.cpp:79/139) -- AND `SpawnGrow_Spawn`
//     (rogue/g_rogue_spawn.cpp:200) -- AND `fire_doppleganger`
//     (rogue/g_rogue_newdm.cpp:242), which IS in this unit's scope and IS
//     real (imported from `./g_rogue_newdm`, not stubbed).
//
// CORRECTION (2026-08-30 stale-comment sweep): `FindSpawnPoint`/
// `CheckGroundSpawnPoint`/`SpawnGrow_Spawn` are NOT actually unported --
// src/kexgame/m_medic.ts has real, exported versions of all three, cited
// to the exact same C++ lines (rogue/g_rogue_spawn.cpp:79-97/139-151/
// 684-704 respectively -- verified by reading m_medic.ts's own doc
// comments and bodies, not assumed). src/kexgame/rogue/g_rogue_spawn.ts
// (a DIFFERENT file, despite the similar name) only carries
// `CreateMonster`/`CreateFlyMonster`, unrelated functions from the same
// C++ source file -- the earlier "STILL genuinely unported" note in this
// same paragraph was wrong, having checked only that file and not
// m_medic.ts. That same earlier pass also mis-cited the real C++
// signature as `(startPoint, mins, maxs, spawnPoint&, dist,
// inSolidCheck): bool` -- the ACTUAL header declaration
// (g_local.h:2589) is `bool FindSpawnPoint(const vec3_t &startpoint,
// const vec3_t &mins, const vec3_t &maxs, vec3_t &spawnpoint, float
// maxMoveUp, bool drop = true)`, i.e. `maxMoveUp`/`drop`, not
// `dist`/`inSolidCheck` -- which DOES correspond positionally to
// m_medic.ts's `(startpoint, mins, maxs, _maxMoveUp, drop = true): Vec3 |
// null` (`_maxMoveUp` <-> `maxMoveUp`, `drop` <-> `drop`, `null` standing
// in for `false`, matching this port line's C-bool-to-nullable-return
// convention). RECONCILED (2026-08-30, KEX demo playback unit):
// `FindSpawnPoint`/`CheckGroundSpawnPoint`/`SpawnGrow_Spawn` are now real
// imports from m_medic.ts; `Use_Doppleganger` below is rewritten to the
// direct-return calling convention (`const spawnPt = FindSpawnPoint(...);
// if (spawnPt === null) return;`), matching m_medic.ts's own call sites
// (e.g. `HandleReinforcements`) and the C++ call site
// (rogue/g_rogue_items.cpp:78, which omits `drop`, taking the header's
// `= true` default -- m_medic.ts's own default matches).
// `CheckGroundSpawnPoint`/`SpawnGrow_Spawn`'s stub signatures already
// matched m_medic.ts's real ones exactly (same param names/order/types);
// only `FindSpawnPoint`'s call site needed rewriting.
//
// ============================================================================
// SWAPPED -- g_items.ts (2026-08-30, KEX demo playback unit)
// ============================================================================
// g_items.ts's own local throwing stub for `Use_Doppleganger` was a
// SEPARATE copy from the real one below (not the same function object).
// Now swapped for a delegating import from here, matching `Use_Nuke`'s
// own precedent exactly (g_items.ts's local `Use_Nuke` already delegates
// to `RogueUse_Nuke`, the real import aliased from this file) -- see
// g_items.ts's own header.

import { vec3 } from "../../shared/math";
import { PITCH, YAW, ROLL } from "../../shared/q_shared";
import type { EdictT, GClientT, GitemT } from "../g_local";
import { AngleVectors, vec3_add, vec3_muls } from "../q_vec3";
import { fire_doppleganger } from "./g_rogue_newdm";
import { fire_nuke } from "./g_rogue_newweap";
import { CheckGroundSpawnPoint, FindSpawnPoint, SpawnGrow_Spawn } from "../m_medic";

function requireClient(ent: EdictT, fnName: string): GClientT {
  if (ent.client === null) {
    throw new Error(`${fnName}: called against a non-client entity (${ent.classname ?? "?"}) -- the C++ source dereferences ->client unconditionally here`);
  }
  return ent.client;
}

// fire_nuke (rogue/g_rogue_newweap.cpp:770): WAS a local throwing stub here
// (weapons cluster, not this unit's file scope at the time) --
// src/kexgame/rogue/g_rogue_newweap.ts has since landed with a real,
// exported `fire_nuke`; imported for real above (2026-08-30 stale-comment
// sweep).

// FindSpawnPoint/CheckGroundSpawnPoint/SpawnGrow_Spawn (rogue/g_rogue_spawn.cpp:
// 79/139/200): formerly local throwing stubs here, cited to a signature
// (`FindSpawnPoint(startPoint, mins, maxs, spawnPointOut: [Vec3], dist):
// boolean`, an out-param+bool-return shape) that does NOT match the real
// C++ declaration (g_local.h:2589: `bool FindSpawnPoint(startpoint, mins,
// maxs, spawnpoint, maxMoveUp, drop = true)` -- 6 params, `drop` defaulted
// true, still out-param+bool on the C++ side) OR m_medic.ts's real, exported
// port of it (`FindSpawnPoint(startpoint, mins, maxs, _maxMoveUp, drop =
// true): Vec3 | null` -- direct-return, `null` standing in for the C++'s
// `false`). RECONCILED (2026-08-30, KEX demo playback unit): imported for
// real from m_medic.ts above; `Use_Doppleganger` below is rewritten to the
// direct-return calling convention m_medic.ts's own call sites already use
// (e.g. `HandleReinforcements`), matching the C++'s own call site
// (rogue/g_rogue_items.cpp:78, which omits the `drop` argument entirely,
// taking the header's `= true` default -- m_medic.ts's `drop = true`
// default matches). `CheckGroundSpawnPoint`/`SpawnGrow_Spawn`'s stub
// signatures already matched m_medic.ts's real ones exactly (same
// param names/order/types); only `FindSpawnPoint`'s call site needed
// rewriting.

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

  const spawnPt = FindSpawnPoint(createPt, ent.mins, ent.maxs, 32);
  if (spawnPt === null) return;

  if (!CheckGroundSpawnPoint(spawnPt, ent.mins, ent.maxs, 64, -1)) return;

  client.pers.inventory[item.id]--;

  SpawnGrow_Spawn(spawnPt, 24, 48);
  fire_doppleganger(ent, spawnPt, forward);
}
