// g_kextarg.ts -- the target_* world entities that exist ONLY in the 2023
// re-release game DLL, translated into the Ground Zero (rogue) module.
//
// Source: our own sibling src/game/g_kextarg.ts (which translated
// src/kexgame/g_target.ts, this repo's port of
// quake2-rerelease-dll/rerelease/g_target.cpp). The g_target.cpp line
// references below are the ones src/kexgame/g_target.ts itself records.
// Ported rather than imported -- see g_kexent.ts's header for why.
//
// Classnames landed in this file, with the shipped rogue maps that place them:
//   target_poi -- rmine1, rmine2, rlava2 (and rboss, rhangar1, rsewer2, ...)
//
// TRANSLATION NOTES:
//   * kexgame wraps every callback in RegisterUse/RegisterThink; this module
//     uses plain functions plus registerSaveFunction() at the file tail.
//   * kexgame's level.time is a millisecond GTime; this module's level.time is
//     a float in SECONDS with FRAMETIME (0.1) as one server frame.
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `deathmatchEnabled()` -> the `deathmatch->value` idiom, wrapped as
//     kexDeathmatch() in g_kexent.ts.
//   * `gi.Com_Print` -> `gi.dprintf`.

import { VectorCopy, type Vec3 } from "../shared/math";
import { SVF_NOCLIENT } from "./game";
import { type EdictT, FRAMETIME, gi, level, st } from "./g_local";
import { kexDeathmatch, kexLevel } from "./g_kexent";
import { G_FreeEdict } from "./g_utils";
import { registerSaveFunction } from "./g_save";

// ===========================================================================
// target_poi  (g_target.cpp:1593-1803 / src/kexgame/g_target.ts:1595-1774)
// ===========================================================================

/** g_target.cpp:1593-1596 -- target_poi spawnflags. */
const SPAWNFLAG_POI_NEAREST = 1;
const SPAWNFLAG_POI_DUMMY = 2;
const SPAWNFLAG_POI_DYNAMIC = 4;
const SPAWNFLAG_POI_DISABLED = 8;

/** kexapi/game.ts's `PathFlags.All` (`static_cast<uint32_t>(-1)`), spelled
 *  as a local literal because nothing in this tree imports from src/kexapi --
 *  the same rule src/game/g_kextarg.ts follows for the identical constant. */
const PATH_FLAGS_ALL = 0xffffffff;

/** kexapi/game.ts's `PathReturnCode::NoNavAvailable` (8) -- "no nav file
 *  available for this map", the one failure distance_to_poi treats
 *  differently from every other. Spelled locally, same reason. */
const PATH_RETURN_NO_NAV_AVAILABLE = 8;

/**
 * The node-search settings the re-release path query at this call site uses
 * (g_target.cpp:1604-1607): ignore node flags, a 128-unit vertical band, a
 * 1024-unit radius, and a 64-unit move distance under PathFlags::All.
 * Identical to src/game/g_kextarg.ts's compassPathQueryDefaults().
 */
function compassPathQueryDefaults(): { moveDist: number; pathFlags: number; ignoreNodeFlags: boolean; minHeight: number; maxHeight: number; radius: number } {
  return { moveDist: 64, pathFlags: PATH_FLAGS_ALL, ignoreNodeFlags: true, minHeight: 128, maxHeight: 128, radius: 1024 };
}

/**
 * g_target.cpp:1599-1621 -- `static float distance_to_poi(...)`.
 *
 * The re-release asks the engine's nav mesh for a WALKED path length, so a
 * teamed target_poi carrying SPAWNFLAG_POI_NEAREST picks the one that is
 * actually nearest to walk to rather than the one nearest through a wall.
 * Three outcomes, exactly as in the C++:
 *   - path found              -> its squared length (`info.pathDistSqr`)
 *   - no nav data for the map -> straight-line squared distance
 *   - nav data, but no route  -> infinity (this POI is unreachable)
 *
 * `gi.get_path_to_goal` being ABSENT is the second case, not the third: an
 * import table with no nav-mesh entry point is precisely "no nav available",
 * and that was this function's whole behavior before the hook was named in
 * this tree's game.ts. Body identical to src/game/g_kextarg.ts's -- copied in,
 * not imported, per this file's header.
 */
function distance_to_poi(start: Vec3, end: Vec3): number {
  const straightLine = (): number => {
    const dx = (end[0] ?? 0) - (start[0] ?? 0);
    const dy = (end[1] ?? 0) - (start[1] ?? 0);
    const dz = (end[2] ?? 0) - (start[2] ?? 0);
    return dx * dx + dy * dy + dz * dz;
  };

  const query = gi.get_path_to_goal;
  if (query === undefined) return straightLine();

  const result = query({ ...compassPathQueryDefaults(), start, goal: end, points: null, maxPoints: 0 });

  if (result.found) return result.pathDistSqr;
  if (result.returnCode === PATH_RETURN_NO_NAV_AVAILABLE) return straightLine();
  return Infinity;
}

/** g_target.cpp:1623-1759 -- `USE(target_poi_use)`. */
function target_poi_use(entIn: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  const lvl = kexLevel();
  let ent: EdictT | null = entIn;

  // we were disabled, so remove the disable check
  if (ent.spawnflags & SPAWNFLAG_POI_DISABLED) ent.spawnflags = ent.spawnflags & ~SPAWNFLAG_POI_DISABLED;

  // early stage check
  if (ent.count !== 0 && lvl.current_poi_stage > ent.count) return;

  // teamed POIs work a bit differently
  if (ent.team !== null) {
    const poi_master = ent.teammaster;
    ent = null;

    let best_distance = Infinity;
    let best_style = Number.MAX_SAFE_INTEGER;
    let dummy_fallback: EdictT | null = null;

    for (let poi: EdictT | null = poi_master; poi !== null; poi = poi.teamchain) {
      if (poi.spawnflags & SPAWNFLAG_POI_DISABLED) continue;

      if (poi.spawnflags & SPAWNFLAG_POI_DUMMY) {
        dummy_fallback = poi;
        continue;
      } else if (poi.count !== 0 && lvl.current_poi_stage > poi.count) continue;
      else if (poi.style > best_style) continue;

      const dist = activator !== null ? distance_to_poi(activator.s.origin, poi.s.origin) : Infinity;

      const masterNearest = poi_master !== null && (poi_master.spawnflags & SPAWNFLAG_POI_NEAREST) !== 0;

      // we have one already and it's farther away, don't bother
      if (masterNearest && ent !== null && dist > best_distance) continue;

      // found a better style; overwrite dist
      if (poi.style < best_style) {
        // unless we weren't reachable...
        if (masterNearest && !Number.isFinite(dist)) continue;

        best_style = poi.style;
        if (masterNearest) best_distance = dist;
        ent = poi;
        continue;
      }

      // if we're picking by nearest, check distance
      if (masterNearest) {
        if (dist < best_distance) {
          best_distance = dist;
          ent = poi;
          continue;
        }
      } else {
        // not picking by distance, so it's order of appearance
        ent = poi;
      }
    }

    // no valid POI found; this isn't always an error, some valid
    // techniques may require this to happen.
    if (ent === null) {
      if (dummy_fallback !== null && dummy_fallback.spawnflags & SPAWNFLAG_POI_DYNAMIC) ent = dummy_fallback;
      else return;
    }

    // copy over POI stage value
    if (ent.count !== 0) {
      if (lvl.current_poi_stage <= ent.count) lvl.current_poi_stage = ent.count;
    }
  } else {
    if (ent.count !== 0) {
      if (lvl.current_poi_stage <= ent.count) lvl.current_poi_stage = ent.count;
      else return; // this POI is not part of our current stage
    }
  }

  // dummy POI; not valid
  if (
    ent.classname === "target_poi" &&
    ent.spawnflags & SPAWNFLAG_POI_DUMMY &&
    !(ent.spawnflags & SPAWNFLAG_POI_DYNAMIC)
  ) {
    return;
  }

  lvl.valid_poi = true;
  VectorCopy(ent.s.origin, lvl.current_poi);
  lvl.current_poi_image = ent.noise_index;

  if (ent.classname === "target_poi" && ent.spawnflags & SPAWNFLAG_POI_DYNAMIC) {
    lvl.current_dynamic_poi = null;

    // pick the dummy POI, since it isn't supposed to get freed
    for (let m: EdictT | null = ent.teammaster; m !== null; m = m.teamchain) {
      if (m.spawnflags & SPAWNFLAG_POI_DUMMY) {
        lvl.current_dynamic_poi = m;
        break;
      }
    }

    if (lvl.current_dynamic_poi === null) {
      gi.dprintf(`can't activate poi for ${ent.classname ?? "?"}; need DUMMY in chain\n`);
    }
  } else {
    lvl.current_dynamic_poi = null;
  }
}

/** g_target.cpp:1761-1776 -- `THINK(target_poi_setup)`. */
function target_poi_setup(self: EdictT): void {
  if (self.team !== null) {
    // copy dynamic/nearest over to all teammates
    if (self.spawnflags & (SPAWNFLAG_POI_NEAREST | SPAWNFLAG_POI_DYNAMIC)) {
      for (let m: EdictT | null = self.teammaster; m !== null; m = m.teamchain) {
        m.spawnflags |= self.spawnflags & (SPAWNFLAG_POI_NEAREST | SPAWNFLAG_POI_DYNAMIC);
      }
    }

    for (let m: EdictT | null = self.teammaster; m !== null; m = m.teamchain) {
      if (m.classname !== "target_poi") {
        gi.dprintf(`WARNING: ${m.classname ?? "?"} is teamed with target_poi's; unintentional\n`);
      }
    }
  }
}

/**
 * g_target.cpp:1778-1803 -- `void SP_target_poi(edict_t *self)`.
 *
 * QUAKED target_poi (1 0 0) (-4 -4 -4) (4 4 4) NEAREST DUMMY DYNAMIC DISABLED
 * The re-release compass/objective marker. Ground Zero's own maps lean on it
 * hard -- rmine1 alone teams them into `poi_nodes` / `poi_pumps` /
 * `poi_power_cube` chains with per-POI `count` stages and `style` priorities
 * -- so this one MUST spawn or those chains take the whole team down with
 * them.
 *
 * DEGRADATION (protocol 34): every bit of the selection algorithm runs --
 * team scan, style priority, NEAREST distance ranking, DUMMY fallback,
 * DYNAMIC latching, and the level-wide stage counter -- and the winning POI's
 * origin and image index are recorded in the kex level state (g_kexent.ts's
 * kexLevel().current_poi / current_poi_image / current_dynamic_poi /
 * valid_poi / current_poi_stage), exactly where the re-release records them
 * in level_locals_t. What is missing is the PRESENTATION: the re-release
 * draws the POI as a compass arrow and objective marker from its own
 * client-side HUD layout, fed from those level fields through the extended
 * player_state. This module's HUD (p_hud.ts's statusbar program) has no
 * compass, no objective marker and no slot to add one, and protocol 34's
 * player_state carries no field for it. So the POI is fully tracked and never
 * shown.
 *
 * The image lookup still runs, so the "friend" / custom POI icon is precached
 * into CS_IMAGES exactly as the re-release precaches it. (No shipped rogue
 * map sets `image` on a target_poi -- they all take the "friend" default --
 * but the key is parsed, see g_save.ts's FIELDS.)
 */
export function SP_target_poi(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.noise_index = st.image !== null ? gi.imageindex(st.image) : gi.imageindex("friend");

  self.use = target_poi_use;
  self.svflags |= SVF_NOCLIENT;
  self.think = target_poi_setup;
  self.nextthink = level.time + FRAMETIME;

  if (self.team === null) {
    if (self.spawnflags & SPAWNFLAG_POI_NEAREST) {
      gi.dprintf(`${self.classname ?? "?"} has useless spawnflag 'NEAREST'\n`);
    }
    if (self.spawnflags & SPAWNFLAG_POI_DYNAMIC) {
      gi.dprintf(`${self.classname ?? "?"} has useless spawnflag 'DYNAMIC'\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Savegame function registry (same idiom as the tail of m_soldier.ts)
// ---------------------------------------------------------------------------

registerSaveFunction("g_kextarg:target_poi_use", target_poi_use);
registerSaveFunction("g_kextarg:target_poi_setup", target_poi_setup);
