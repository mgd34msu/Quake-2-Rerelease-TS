// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_spawn.c -- the ROGUE mission pack's monster-spawning helper suite
// (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_spawn.cpp (367
// lines, C++17): `CreateMonster`/`CreateFlyMonster`/`CreateGroundMonster`
// (used by the carrier, medic_commander, and black widow to summon
// reinforcements), `FindSpawnPoint`/`CheckSpawnPoint`/`CheckGroundSpawnPoint`
// (the placement-validation primitives those three call), and
// `SpawnGrow_Spawn` (the "growing marker" decal shown at a reinforcement's
// spawn point right before it appears).
//
// ============================================================================
// ALREADY REAL ELSEWHERE -- re-exported, not re-implemented
// ============================================================================
// `CreateGroundMonster`, `FindSpawnPoint`, `CheckSpawnPoint`,
// `CheckGroundSpawnPoint`, and `SpawnGrow_Spawn` (rogue/g_rogue_spawn.cpp:
// 60-73, 79-100, 112-127, 139-151, 200-251) are already ported for real,
// locally, inside m_medic.ts -- see that file's own header, "THE
// REINFORCEMENTS FINDING" section, for why: no src/kexgame/rogue/*.ts
// existed when the medic_commander's reinforcement-calling path needed
// them, so m_medic.ts ported all five (plus `realrange`, whose real home is
// rogue/g_rogue_newai.cpp, not this file) as narrowly-scoped local helpers
// rather than leaving the whole reinforcement chain stubbed. All five are
// re-exported below from their real implementation rather than duplicated a
// second time, per this port line's "import, don't duplicate" rule (see
// g_rogue_newai.ts's own header for the identical precedent with
// `realrange`/`PickCoopTarget`).
//
// NOTE FOR THE COORDINATOR: m_rogue_carrier.ts and m_rogue_widow.ts (both
// landed before this file existed) each carry their OWN unexported, local
// copies of `CreateMonster`/`CreateFlyMonster` (and m_rogue_widow.ts also
// locally re-derives `CheckSpawnPoint`/`CheckGroundSpawnPoint`/
// `FindSpawnPoint`/`M_SlotsLeft`, plus `Widowlegs_Spawn`/`widowlegs_think`,
// rogue/g_rogue_spawn.cpp:265-367) -- the same "no canonical home existed
// yet" situation m_medic.ts documents for itself. Those two files are
// outside this unit's scope (owned by the monster-cluster agents, not the
// FUNC/TRIGGER/TARGET/SPAWN cluster this file belongs to) and are NOT
// edited here. A future consolidation pass could point them at this file's
// exports instead, but since none of their copies are save-registered
// under a colliding name (all are plain, unexported functions), there is
// no correctness defect today -- just duplicated source text worth
// flagging.
//
// `Widowlegs_Spawn`/`widowlegs_think`/`ThrowMoreStuff`/`ThrowSmallStuff`/
// `ThrowWidowGibLoc`/`ThrowWidowGibSized` (rogue/g_rogue_spawn.cpp:
// 253-367, plus three forward-declared-but-not-defined-in-this-TU gib
// helpers) are NOT ported here -- they are black-widow-boss-specific decor
// (the widow's severed leg prop, thrown after her death), out of this
// unit's brief (which scopes this file to exactly: `CreateMonster`,
// `CreateFlyMonster`, `CreateGroundMonster`, `FindSpawnPoint`,
// `CheckSpawnPoint`, `CheckGroundSpawnPoint`, `SpawnGrow_Spawn`), and (per
// the note above) already independently ported inside m_rogue_widow.ts,
// whose own file is the correct home for a boss-specific prop regardless.
//
// ============================================================================
// CreateMonster / CreateFlyMonster -- ported for real, fresh, in this file
// ============================================================================
// `CreateMonster` (rogue/g_rogue_spawn.cpp:31-47) is the vec3-angle-driven
// ground-monster spawn primitive m_medic.ts's `CreateGroundMonster`
// specializes (that function's own body is `CreateMonster`'s exact
// implementation, inlined directly rather than calling out to a separate
// `CreateMonster`, per m_medic.ts's own header note on collapsing the two).
// This file ports `CreateMonster` as its own standalone, callable function
// (matching the C++ source's actual declaration, not re-deriving it from
// `CreateGroundMonster`), since `CreateFlyMonster` below calls it directly,
// unguarded by any ground-check.
//
// `CreateFlyMonster` (rogue/g_rogue_spawn.cpp:49-55) is the airborne
// counterpart -- used by the widow/carrier bosses (out of this unit's
// monster-cluster scope), but its own declared home is this file, so it is
// ported for real here regardless of whether any in-scope caller reaches it
// yet.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `CreateMonster`'s C++ body sets `newEnt->gravityVector = { 0, 0, -1 };`
//   unconditionally, even though every caller in this port line already
//   defaults to that same downward gravity vector at entity-creation time
//   (see g_utils.ts's `G_Spawn`) -- kept as an explicit assignment anyway,
//   bug-for-bug, matching the C++ source's own redundant-but-harmless
//   write.

import { vec3, type Vec3 } from "../../shared/math";
import { RenderfxT } from "../../kexapi/game";
import { type EdictT, MonsterAiFlagsT } from "../g_local";
import { G_Spawn } from "../g_utils";
import { ED_CallSpawn } from "../g_spawn";
import { CreateGroundMonster, FindSpawnPoint, CheckSpawnPoint, CheckGroundSpawnPoint, SpawnGrow_Spawn, realrange } from "../m_medic";

export { CreateGroundMonster, FindSpawnPoint, CheckSpawnPoint, CheckGroundSpawnPoint, SpawnGrow_Spawn, realrange };

/**
 * rogue/g_rogue_spawn.cpp:31-47 `edict_t *CreateMonster(const vec3_t
 * &origin, const vec3_t &angles, const char *classname)`. Spawns a new
 * entity of `classname` at `origin`/`angles`, marks it `AI_DO_NOT_COUNT`
 * (reinforcements never count toward the level's monster total), and runs
 * it through `ED_CallSpawn` -- the same generic entity-construction path
 * every map-parsed entity goes through.
 */
export function CreateMonster(origin: Vec3, angles: Vec3, classname: string): EdictT {
  const newEnt = G_Spawn();

  newEnt.s.origin = vec3(origin[0], origin[1], origin[2]);
  newEnt.s.angles = vec3(angles[0], angles[1], angles[2]);
  newEnt.classname = classname;
  newEnt.monsterinfo.aiflags |= MonsterAiFlagsT.AI_DO_NOT_COUNT;

  newEnt.gravityVector = vec3(0, 0, -1);
  ED_CallSpawn(newEnt);
  newEnt.s.renderfx |= RenderfxT.RF_IR_VISIBLE;

  return newEnt;
}

/**
 * rogue/g_rogue_spawn.cpp:49-55 `edict_t *CreateFlyMonster(const vec3_t
 * &origin, const vec3_t &angles, const vec3_t &mins, const vec3_t &maxs,
 * const char *classname)`. Used by the carrier/widow bosses to summon
 * airborne reinforcements -- validates the spawn volume is clear
 * (`CheckSpawnPoint`, no ground-flatness requirement, unlike
 * `CreateGroundMonster`) before actually creating the monster.
 */
export function CreateFlyMonster(origin: Vec3, angles: Vec3, mins: Vec3, maxs: Vec3, classname: string): EdictT | null {
  if (!CheckSpawnPoint(origin, mins, maxs)) return null;

  return CreateMonster(origin, angles, classname);
}
