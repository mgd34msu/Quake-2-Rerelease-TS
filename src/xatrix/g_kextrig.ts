// g_kextrig.ts -- the trigger_* and info_nav_lock world entities that exist
// ONLY in the 2023 re-release game DLL, translated into The Reckoning (Xatrix)
// module.
//
// Classnames landed in this file:
//   trigger_fog   (placed by the re-release refinery.bsp)
//   info_nav_lock (placed by the re-release xware.bsp)
//
// The frozen Xatrix DLL drops both with "<classname> doesn't have a spawn
// function".
//
// SOURCE: src/game/g_kextrig.ts's SP_trigger_fog / SP_info_nav_lock and their
// helpers -- that module's translation of
// quake2-rerelease-dll/rerelease/g_trigger.cpp (via src/kexgame/g_trigger.ts)
// and rerelease/bots/bot_utils.cpp (via src/kexgame/bots/bot_utils.ts). This
// module is a HARD FORK of src/game with its own EdictT and its own spawn
// table -- there is no cross-module import anywhere in the tree -- so the
// implementation is COPIED IN, the same way commit 288484f copied the sibling
// modules' entities into src/game.
//
// TRANSLATION NOTES (carried over from src/game/g_kextrig.ts):
//   * kexgame wraps every callback in RegisterUse/RegisterThink/RegisterTouch;
//     this module uses plain functions plus registerSaveFunction() at the file
//     tail (see the tail of m_soldier.ts).
//   * kexgame's TouchFn is `(self, other, tr, otherTouchingSelf)`; the classic
//     touch signature is `(self, other, plane, surf)`. trigger_fog_touch reads
//     neither the trace nor the flag, so the translation is exact.
//   * kexgame's level.time is a millisecond GTime; this module's level.time is
//     a float in SECONDS.
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `gi.Com_Print` -> `gi.dprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * trigger_fog   -- fires, targets and holds fully correct per-client fog
//                     state; protocol 34 has no fog message, so the view is
//                     unfogged. See trigger_fog_touch.
//  * info_nav_lock -- the FL_LOCKED bit toggles; no Xatrix door tests it.

import { VectorCopy, VectorNormalize, VectorSet, vec3 } from "../shared/math";
import { YAW } from "../shared/q_shared";
import { SVF_NOCLIENT } from "./game";
import type { CplaneT, CsurfaceT } from "../shared/q_shared";
import { type EdictT, gi, level } from "./g_local";
import { FL_KEX_LOCKED, kexClamp, kexEdictFmt } from "./g_kexent";
import { G_Find, G_PickTarget, G_FreeEdict } from "./g_utils";
import { InitTrigger } from "./g_trigger";
import { registerSaveFunction } from "./g_save";

// ===========================================================================
// trigger_fog  (g_trigger.cpp:1014-1195 / src/game/g_kextrig.ts:160-402)
// ===========================================================================

/** g_trigger.cpp:1014-1018 -- trigger_fog spawnflags. */
const SPAWNFLAG_FOG_AFFECT_FOG = 1;
const SPAWNFLAG_FOG_AFFECT_HEIGHTFOG = 2;
const SPAWNFLAG_FOG_INSTANTANEOUS = 4;
const SPAWNFLAG_FOG_FORCE = 8;
const SPAWNFLAG_FOG_BLEND = 16;

/**
 * The rerelease keeps a player's wanted fog on `client->pers.wanted_fog`,
 * `client->pers.wanted_heightfog` and `client->pers.fog_transition_time`, and
 * its p_view.cpp interpolates from the current fog toward the wanted one over
 * the transition time, publishing the result through a KEX-only fog message.
 *
 * The Xatrix ClientPersistantT declares none of those three (it is vanilla
 * 3.21's plus this pack's own additions), so the same state lives here keyed
 * by the player's edict number (1..maxclients) -- the identical arrangement
 * src/game/g_kextrig.ts uses. Nothing under protocol 34 reads it back, so it
 * is a faithful server-side record with no consumer; see trigger_fog_touch.
 */
type KexWantedFog = { density: number; r: number; g: number; b: number; sky_factor: number };
type KexWantedHeightFog = {
  start: [number, number, number, number];
  end: [number, number, number, number];
  falloff: number;
  density: number;
};
type KexClientFogState = {
  fog_transition_time: number;
  wanted_fog: KexWantedFog | null;
  wanted_heightfog: KexWantedHeightFog | null;
};

const kexClientFog = new Map<number, KexClientFogState>();

/** Per-client fog state, created on first use. Exposed for the eventual move. */
export function KexClientFogState(player: EdictT): KexClientFogState {
  const key = player.s.number;
  let s = kexClientFog.get(key);
  if (s === undefined) {
    s = { fog_transition_time: 0, wanted_fog: null, wanted_heightfog: null };
    kexClientFog.set(key, s);
  }
  return s;
}

/** g_trigger.cpp: `lerp(from, to, t)`. */
function lerpN(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * g_trigger.cpp:1022-1168 -- `TOUCH(trigger_fog_touch)`.
 *
 * DEGRADATION (protocol 34): every branch below runs, and the resulting fog /
 * height-fog values land in the per-client state exactly as the rerelease
 * lands them in client->pers -- the wait debounce, the movetarget value-store
 * indirection, the INSTANTANEOUS zero-transition, the BLEND positional lerp
 * across the trigger's movedir axis, the FORCE/direction-of-travel
 * on-vs-off decision, and both AFFECT_FOG and AFFECT_HEIGHTFOG payloads.
 *
 * What is missing is transmission: the rerelease publishes fog through a
 * KEX-only per-client fog message (its svc_fog), and protocol 34 has no such
 * message and no player_state field that could carry density, colour, sky
 * factor or the height-fog gradient. So THE VIEW IS UNFOGGED. The entity is
 * never dropped and its state is always correct and queryable.
 */
function trigger_fog_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;
  if (self.timestamp > level.time) return;

  self.timestamp = level.time + self.wait;

  const fog_value_storage = self.movetarget !== null ? self.movetarget : self;
  const cs = KexClientFogState(other);

  if (self.spawnflags & SPAWNFLAG_FOG_INSTANTANEOUS) cs.fog_transition_time = 0;
  else cs.fog_transition_time = fog_value_storage.delay;

  if (self.spawnflags & SPAWNFLAG_FOG_BLEND) {
    const center = vec3();
    VectorSet(
      center,
      ((self.absmin[0] ?? 0) + (self.absmax[0] ?? 0)) * 0.5,
      ((self.absmin[1] ?? 0) + (self.absmax[1] ?? 0)) * 0.5,
      ((self.absmin[2] ?? 0) + (self.absmax[2] ?? 0)) * 0.5,
    );
    const half_size = vec3();
    VectorSet(
      half_size,
      ((self.size[0] ?? 0) + (other.size[0] ?? 0)) * 0.5,
      ((self.size[1] ?? 0) + (other.size[1] ?? 0)) * 0.5,
      ((self.size[2] ?? 0) + (other.size[2] ?? 0)) * 0.5,
    );
    const start = vec3();
    const end = vec3();
    const player_dist = vec3();
    for (let i = 0; i < 3; i++) {
      const md = self.movedir[i] ?? 0;
      const hs = half_size[i] ?? 0;
      start[i] = -md * hs;
      end[i] = md * hs;
      player_dist[i] = ((other.s.origin[i] ?? 0) - (center[i] ?? 0)) * Math.abs(md);
    }

    let dist = Math.hypot(
      (player_dist[0] ?? 0) - (start[0] ?? 0),
      (player_dist[1] ?? 0) - (start[1] ?? 0),
      (player_dist[2] ?? 0) - (start[2] ?? 0),
    );
    dist /= Math.hypot(
      (start[0] ?? 0) - (end[0] ?? 0),
      (start[1] ?? 0) - (end[1] ?? 0),
      (start[2] ?? 0) - (end[2] ?? 0),
    );
    dist = kexClamp(dist, 0, 1);

    if (self.spawnflags & SPAWNFLAG_FOG_AFFECT_FOG) {
      const f = fog_value_storage.fog;
      cs.wanted_fog = {
        density: lerpN(f.density_off, f.density, dist),
        r: lerpN(f.color_off[0] ?? 0, f.color[0] ?? 0, dist),
        g: lerpN(f.color_off[1] ?? 0, f.color[1] ?? 0, dist),
        b: lerpN(f.color_off[2] ?? 0, f.color[2] ?? 0, dist),
        sky_factor: lerpN(f.sky_factor_off, f.sky_factor, dist),
      };
    }

    if (self.spawnflags & SPAWNFLAG_FOG_AFFECT_HEIGHTFOG) {
      const hf = fog_value_storage.heightfog;
      cs.wanted_heightfog = {
        start: [
          lerpN(hf.start_color_off[0] ?? 0, hf.start_color[0] ?? 0, dist),
          lerpN(hf.start_color_off[1] ?? 0, hf.start_color[1] ?? 0, dist),
          lerpN(hf.start_color_off[2] ?? 0, hf.start_color[2] ?? 0, dist),
          lerpN(hf.start_dist_off, hf.start_dist, dist),
        ],
        end: [
          lerpN(hf.end_color_off[0] ?? 0, hf.end_color[0] ?? 0, dist),
          lerpN(hf.end_color_off[1] ?? 0, hf.end_color[1] ?? 0, dist),
          lerpN(hf.end_color_off[2] ?? 0, hf.end_color[2] ?? 0, dist),
          lerpN(hf.end_dist_off, hf.end_dist, dist),
        ],
        falloff: lerpN(hf.falloff_off, hf.falloff, dist),
        density: lerpN(hf.density_off, hf.density, dist),
      };
    }

    return;
  }

  let use_on = true;

  if (!(self.spawnflags & SPAWNFLAG_FOG_FORCE)) {
    const forward = vec3();
    VectorCopy(other.velocity, forward);
    const len = VectorNormalize(forward);

    // not moving enough to trip; this is so we don't trip
    // the wrong direction when on an elevator, etc.
    if (len <= 0.0001) return;

    use_on =
      (forward[0] ?? 0) * (self.movedir[0] ?? 0) +
        (forward[1] ?? 0) * (self.movedir[1] ?? 0) +
        (forward[2] ?? 0) * (self.movedir[2] ?? 0) >
      0;
  }

  if (self.spawnflags & SPAWNFLAG_FOG_AFFECT_FOG) {
    const f = fog_value_storage.fog;
    cs.wanted_fog = use_on
      ? {
          density: f.density,
          r: f.color[0] ?? 0,
          g: f.color[1] ?? 0,
          b: f.color[2] ?? 0,
          sky_factor: f.sky_factor,
        }
      : {
          density: f.density_off,
          r: f.color_off[0] ?? 0,
          g: f.color_off[1] ?? 0,
          b: f.color_off[2] ?? 0,
          sky_factor: f.sky_factor_off,
        };
  }

  if (self.spawnflags & SPAWNFLAG_FOG_AFFECT_HEIGHTFOG) {
    const hf = fog_value_storage.heightfog;
    cs.wanted_heightfog = use_on
      ? {
          start: [hf.start_color[0] ?? 0, hf.start_color[1] ?? 0, hf.start_color[2] ?? 0, hf.start_dist],
          end: [hf.end_color[0] ?? 0, hf.end_color[1] ?? 0, hf.end_color[2] ?? 0, hf.end_dist],
          falloff: hf.falloff,
          density: hf.density,
        }
      : {
          start: [
            hf.start_color_off[0] ?? 0,
            hf.start_color_off[1] ?? 0,
            hf.start_color_off[2] ?? 0,
            hf.start_dist_off,
          ],
          end: [hf.end_color_off[0] ?? 0, hf.end_color_off[1] ?? 0, hf.end_color_off[2] ?? 0, hf.end_dist_off],
          falloff: hf.falloff_off,
          density: hf.density_off,
        };
  }
}

/**
 * g_trigger.cpp:1170-1195 -- `void SP_trigger_fog(edict_t *self)`.
 *
 * QUAKED trigger_fog (.5 .5 .5) ? AFFECT_FOG AFFECT_HEIGHTFOG INSTANTANEOUS FORCE BLEND
 */
export function SP_trigger_fog(self: EdictT): void {
  if (self.s.angles[YAW] === 0) self.s.angles[YAW] = 360;

  InitTrigger(self);

  if (!(self.spawnflags & SPAWNFLAG_FOG_AFFECT_FOG) && !(self.spawnflags & SPAWNFLAG_FOG_AFFECT_HEIGHTFOG)) {
    gi.dprintf(`WARNING: ${self.classname ?? "?"} with no fog spawnflags set\n`);
  }

  if (self.target !== null) {
    self.movetarget = G_PickTarget(self.target);

    if (self.movetarget !== null) {
      if (self.movetarget.delay === 0) self.movetarget.delay = 0.5;
    }
  }

  if (self.delay === 0) self.delay = 0.5;

  self.touch = trigger_fog_touch;
}

// ===========================================================================
// info_nav_lock  (bot_utils.cpp:382-413 / src/game/g_kextrig.ts:786-843)
// ===========================================================================

/**
 * bot_utils.cpp:382-393 -- `USE(info_nav_lock_use)`.
 *
 * DEVIATIONS, both forced by this module's svflags/flags sets:
 *   * The rerelease rejects a target that is not `SVF_DOOR`. The Xatrix module
 *     has only SVF_NOCLIENT / SVF_DEADMONSTER / SVF_MONSTER, so the "is this a
 *     door" test is made by classname against the two classic door entities
 *     instead. Same set of entities in practice.
 *   * `FL_LOCKED` becomes FL_KEX_LOCKED (g_kexent.ts, a free flag bit).
 *
 * DEGRADATION: no Xatrix door code tests a locked flag -- this pack's
 * func_door is vanilla 3.21's, which has no lock concept at all -- so the
 * toggle is inert. The entity spawns, validates its targetname/target, and its
 * use wiring works.
 */
function info_nav_lock_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  let n: EdictT | null = null;

  while ((n = G_Find(n, "targetname", self.target ?? "")) !== null) {
    if (n.classname !== "func_door" && n.classname !== "func_door_rotating") {
      gi.dprintf(`${kexEdictFmt(self)} tried targeting ${kexEdictFmt(n)}, a non-door\n`);
      continue;
    }

    n.flags ^= FL_KEX_LOCKED;
  }
}

/**
 * bot_utils.cpp:395-413 -- `void SP_info_nav_lock(edict_t *self)`.
 *
 * QUAKED info_nav_lock (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
 * toggle locked state on linked entity
 */
export function SP_info_nav_lock(self: EdictT): void {
  if (self.targetname === null) {
    gi.dprintf(`${kexEdictFmt(self)} missing targetname\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.target === null) {
    gi.dprintf(`${kexEdictFmt(self)} missing target\n`);
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SVF_NOCLIENT;
  self.use = info_nav_lock_use;
}

// ---------------------------------------------------------------------------
// Savegame function registry (same idiom as the tail of m_soldier.ts)
// ---------------------------------------------------------------------------

registerSaveFunction("g_kextrig:trigger_fog_touch", trigger_fog_touch);
registerSaveFunction("g_kextrig:info_nav_lock_use", info_nav_lock_use);
