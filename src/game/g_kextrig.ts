// g_kextrig.ts -- the trigger_*, func_eye and info_nav_lock world entities
// that exist ONLY in the 2023 re-release game DLL, translated into the classic
// (3.21) module.
//
// Sources (this repo's ports of the rerelease C++):
//   src/kexgame/g_trigger.ts  -> trigger_fog, trigger_coop_relay,
//                                trigger_flashlight
//   src/kexgame/g_func.ts     -> func_eye
//   src/kexgame/g_monster.ts  -> trigger_health_relay
//   src/kexgame/bots/bot_utils.ts -> info_nav_lock
//
// TRANSLATION NOTES (apply throughout):
//   * kexgame wraps every callback in RegisterUse/RegisterThink/RegisterTouch;
//     the classic module uses plain functions plus registerSaveFunction() at
//     the file tail (see m_soldier.ts).
//   * kexgame's TouchFn is `(self, other, tr, otherTouchingSelf)`; the classic
//     touch signature is `(self, other, plane, surf)`. None of the touches
//     here read the trace or the flag, so every translation is exact.
//   * kexgame's level.time is a millisecond GTime; the classic level.time is a
//     float in SECONDS, FRAMETIME (0.1) is one server frame.
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `gi.Com_Print` -> `gi.dprintf`; `giLocCenterPrint` -> `gi.centerprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * trigger_fog        -- fires, targets and holds fully correct per-client
//                          fog state; protocol 34 has no fog message, so the
//                          view is unfogged. See trigger_fog_touch.
//  * trigger_flashlight -- the FL_FLASHLIGHT bit toggles and the on/off sounds
//                          play; no beam is drawn. See P_ToggleFlashlight.
//  * info_nav_lock      -- the FL_LOCKED bit toggles; no classic door tests it.
//  * trigger_coop_relay / trigger_health_relay / func_eye -- no degradation.

import {
  AngleVectors,
  anglemod,
  VectorCopy,
  VectorLength,
  VectorNormalize,
  VectorSet,
  VectorSubtract,
  vec3,
  type Vec3,
} from "../shared/math";
import { AREA_SOLID, ATTN_STATIC, CHAN_AUTO, MAX_EDICTS, YAW } from "../shared/q_shared";
import { type Edict, SolidT, SVF_NOCLIENT } from "./game";
import type { CplaneT, CsurfaceT } from "../shared/q_shared";
import { type EdictT, FRAMETIME, gi, g_edicts, level, MovetypeT, st } from "./g_local";
import {
  FL_KEX_FLASHLIGHT,
  FL_KEX_LOCKED,
  kexActivePlayers,
  kexClamp,
  kexCoop,
  kexEdictFmt,
} from "./g_kexent";
import { G_Find, G_FreeEdict, G_PickTarget, G_UseTargets, vectoangles } from "./g_utils";
import { InitTrigger } from "./g_trigger";
import { registerSaveFunction } from "./g_save";

// ===========================================================================
// trigger_flashlight  (g_trigger.cpp:928-973 / src/kexgame/g_trigger.ts:863-902)
// ===========================================================================

/** g_trigger.cpp:928 -- `SPAWNFLAG_FLASHLIGHT_CLIPPED`. */
const SPAWNFLAG_FLASHLIGHT_CLIPPED = 1;

/**
 * g_items.cpp:2164-2177 -- `void P_ToggleFlashlight(edict_t *ent, bool state)`.
 *
 * Ported in full: the rerelease body is exactly "if the bit already matches
 * the requested state, do nothing; otherwise flip FL_FLASHLIGHT and play the
 * matching on/off sample". Both halves work here -- FL_KEX_FLASHLIGHT is
 * declared in g_kexent.ts on a free entity-flag bit, and gi.sound /
 * gi.soundindex are classic imports.
 *
 * DEGRADATION (protocol 34): the LIGHT itself is not drawn. In the rerelease
 * the flashlight beam comes from p_view.cpp's per-frame P_AddFlashlight,
 * which traces from the eye and emits a TE_FLASHLIGHT temp entity while the
 * flag is set. The classic p_view.ts has no such per-frame emitter (and this
 * port does not own p_view.ts), so nothing lights up. The flag state and the
 * audible on/off feedback are correct.
 */
function P_ToggleFlashlight(ent: EdictT, state: boolean): void {
  if (((ent.flags & FL_KEX_FLASHLIGHT) !== 0) === state) return;

  ent.flags ^= FL_KEX_FLASHLIGHT;

  gi.sound(
    ent,
    CHAN_AUTO,
    gi.soundindex((ent.flags & FL_KEX_FLASHLIGHT) !== 0 ? "items/flashlight_on.wav" : "items/flashlight_off.wav"),
    1,
    ATTN_STATIC,
    0,
  );
}

/**
 * g_trigger.cpp:934-960 -- `TOUCH(trigger_flashlight_touch)`.
 *
 * DEVIATION: the CLIPPED spawnflag's `gi.clip(self, ...)` precise-hull test is
 * dropped. `gi.clip` is a KEX-only game import (there is no classic
 * equivalent, and the classic module has no SVF_HULL either), so the clipped
 * variant behaves like the unclipped one: the trigger fires on bbox overlap
 * rather than on brush-accurate overlap. That makes the trigger slightly more
 * eager at the edges of a non-box brush; it never makes it fail to fire.
 */
function trigger_flashlight_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (other.client === null) return;

  // (rerelease CLIPPED gi.clip() precise-hull rejection omitted -- see above)

  if (self.style === 1) {
    P_ToggleFlashlight(other, true);
  } else if (self.style === 2) {
    P_ToggleFlashlight(other, false);
  } else {
    const v = other.velocity;
    const lenSq = (v[0] ?? 0) * (v[0] ?? 0) + (v[1] ?? 0) * (v[1] ?? 0) + (v[2] ?? 0) * (v[2] ?? 0);
    if (lenSq > 32) {
      const forward = vec3();
      VectorCopy(v, forward);
      VectorNormalize(forward);
      const dot =
        (forward[0] ?? 0) * (self.movedir[0] ?? 0) +
        (forward[1] ?? 0) * (self.movedir[1] ?? 0) +
        (forward[2] ?? 0) * (self.movedir[2] ?? 0);
      P_ToggleFlashlight(other, dot > 0);
    }
  }
}

/**
 * g_trigger.cpp:962-973 -- `void SP_trigger_flashlight(edict_t *self)`.
 *
 * QUAKED trigger_flashlight (.5 .5 .5) ? CLIPPED
 * "style" 1 forces the flashlight on, 2 forces it off, 0 toggles by the
 * player's direction of travel relative to the trigger's angle.
 */
export function SP_trigger_flashlight(self: EdictT): void {
  if (self.s.angles[YAW] === 0) self.s.angles[YAW] = 360;
  InitTrigger(self);
  self.touch = trigger_flashlight_touch;
  self.movedir[2] = st.height;

  // The rerelease precaches these through its item table (the flashlight is
  // an inventory item there). The classic module has no flashlight item, so
  // they are precached here, where they are used.
  gi.soundindex("items/flashlight_on.wav");
  gi.soundindex("items/flashlight_off.wav");

  // (rerelease `self->svflags |= SVF_HULL` on CLIPPED omitted -- no classic
  //  SVF_HULL; see trigger_flashlight_touch's deviation note)

  gi.linkentity(self);
}

// ===========================================================================
// trigger_fog  (g_trigger.cpp:1014-1195 / src/kexgame/g_trigger.ts:905-1032)
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
 * The classic ClientPersistantT declares none of those three, and this port
 * does not own g_local.ts, so the same state lives here keyed by the player's
 * edict number (1..maxclients). The exact declarations to move into
 * ClientPersistantT are listed in the port report.
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
  // The state the client has already been told about -- p_client.cpp's
  // `client->fog` / `client->heightfog`, the other half of
  // P_ForceFogTransition's converged-state guard. Zeroed on first use, the
  // same value kexgame's ClientPersistantT starts these at.
  fog: KexWantedFog;
  heightfog: KexWantedHeightFog;
};

const ZERO_FOG: KexWantedFog = { density: 0, r: 0, g: 0, b: 0, sky_factor: 0 };
const ZERO_HEIGHTFOG: KexWantedHeightFog = { start: [0, 0, 0, 0], end: [0, 0, 0, 0], falloff: 0, density: 0 };

function copyFog(f: KexWantedFog): KexWantedFog {
  return { density: f.density, r: f.r, g: f.g, b: f.b, sky_factor: f.sky_factor };
}

function copyHeightFog(h: KexWantedHeightFog): KexWantedHeightFog {
  return {
    falloff: h.falloff,
    density: h.density,
    start: [h.start[0], h.start[1], h.start[2], h.start[3]],
    end: [h.end[0], h.end[1], h.end[2], h.end[3]],
  };
}

const kexClientFog = new Map<number, KexClientFogState>();

/** Per-client fog state, created on first use. Exposed for the eventual move. */
export function KexClientFogState(player: EdictT): KexClientFogState {
  const key = player.s.number;
  let s = kexClientFog.get(key);
  if (s === undefined) {
    s = {
      fog_transition_time: 0,
      wanted_fog: null,
      wanted_heightfog: null,
      fog: copyFog(ZERO_FOG),
      heightfog: copyHeightFog(ZERO_HEIGHTFOG),
    };
    kexClientFog.set(key, s);
  }
  return s;
}

/**
 * p_client.cpp:1788-1910 -- `[Paril-KEX] void P_ForceFogTransition(edict_t *ent, bool instant)`,
 * the classic module's copy of src/kexgame/p_view.ts's function of the same
 * name.
 *
 * Two halves in the re-release: a converged-state guard (return early when
 * the client already has the fog it wants) and, when they differ, the svc_fog
 * packet write. The guard is ported here verbatim; the packet write goes
 * through the optional `gi.fog()` import instead of inline gi.Write* calls,
 * because the svc_fog opcode and its bit assignments are re-release wire
 * vocabulary the frozen v3 GameImports cannot name -- src/server/bindings/
 * legacy.ts's PF_Fog holds the encoder, and mirrors kexgame's
 * `sendFogTransition` byte for byte.
 *
 * THERE IS NO INTERPOLATION HERE, in this module or in kexgame's. The server
 * sends the destination state plus a BIT_TIME duration and the CLIENT lerps
 * from what it currently has toward it; the game module only ever tracks the
 * two endpoints. `transitionMs` is that duration, or null when the change is
 * instant (a spawn, or the INSTANTANEOUS spawnflag) or the trigger carries no
 * delay -- exactly kexgame's `!instant && Gtime_nonzero(fog_transition_time)`
 * condition, with its same trunc-to-milliseconds and 0..65535 clamp.
 *
 * On a narrow session gi.fog() is a no-op (PF_Fog's own gate), so nothing
 * reaches the wire and a vanilla client never sees an opcode it cannot parse.
 * The state still converges either way, so a client's tracked fog is correct
 * regardless of whether the session could transmit it.
 */
export function P_ForceFogTransition(ent: EdictT, instant: boolean): void {
  if (ent.client === null) return;

  const cs = KexClientFogState(ent);
  const wantedFog = cs.wanted_fog ?? ZERO_FOG;
  const wantedHf = cs.wanted_heightfog ?? ZERO_HEIGHTFOG;

  if (fogEquals(cs.fog, wantedFog) && heightFogEquals(cs.heightfog, wantedHf)) return;

  const rawMs = Math.trunc(cs.fog_transition_time * 1000);
  const transitionMs = instant || rawMs === 0 ? null : Math.min(Math.max(rawMs, 0), 65535);

  gi.fog?.(
    ent,
    {
      density: cs.fog.density,
      r: cs.fog.r,
      g: cs.fog.g,
      b: cs.fog.b,
      sky_factor: cs.fog.sky_factor,
      hf_falloff: cs.heightfog.falloff,
      hf_density: cs.heightfog.density,
      hf_start: cs.heightfog.start,
      hf_end: cs.heightfog.end,
    },
    {
      density: wantedFog.density,
      r: wantedFog.r,
      g: wantedFog.g,
      b: wantedFog.b,
      sky_factor: wantedFog.sky_factor,
      hf_falloff: wantedHf.falloff,
      hf_density: wantedHf.density,
      hf_start: wantedHf.start,
      hf_end: wantedHf.end,
    },
    transitionMs,
  );

  // `ent->client->fog = ent->client->pers.wanted_fog;` -- a C struct copy.
  // Copied field-by-field for the same reason kexgame's sendFogTransition
  // does it: these are reference types here, and aliasing them would let a
  // later trigger_fog touch mutate the acknowledged state too, breaking the
  // guard above.
  cs.fog = copyFog(wantedFog);
  cs.heightfog = copyHeightFog(wantedHf);
}

function fogEquals(a: KexWantedFog, b: KexWantedFog): boolean {
  return a.density === b.density && a.r === b.r && a.g === b.g && a.b === b.b && a.sky_factor === b.sky_factor;
}

function heightFogEquals(a: KexWantedHeightFog, b: KexWantedHeightFog): boolean {
  return (
    a.falloff === b.falloff &&
    a.density === b.density &&
    a.start[0] === b.start[0] &&
    a.start[1] === b.start[1] &&
    a.start[2] === b.start[2] &&
    a.start[3] === b.start[3] &&
    a.end[0] === b.end[0] &&
    a.end[1] === b.end[1] &&
    a.end[2] === b.end[2] &&
    a.end[3] === b.end[3]
  );
}

/**
 * p_client.cpp:2476-2483 -- the `[Paril-KEX] set up world fog & send it
 * instantly` block PutClientInServer runs after placing the player. Mirrors
 * src/kexgame/p_client.ts's copy: the worldspawn fog_* / heightfog_* keys
 * become this client's wanted state and go out in one instant transition.
 */
export function P_SetupWorldFog(ent: EdictT, world: EdictT): void {
  const cs = KexClientFogState(ent);
  cs.wanted_fog = {
    density: world.fog.density,
    r: world.fog.color[0] ?? 0,
    g: world.fog.color[1] ?? 0,
    b: world.fog.color[2] ?? 0,
    sky_factor: world.fog.sky_factor,
  };
  cs.wanted_heightfog = {
    start: [
      world.heightfog.start_color[0] ?? 0,
      world.heightfog.start_color[1] ?? 0,
      world.heightfog.start_color[2] ?? 0,
      world.heightfog.start_dist,
    ],
    end: [
      world.heightfog.end_color[0] ?? 0,
      world.heightfog.end_color[1] ?? 0,
      world.heightfog.end_color[2] ?? 0,
      world.heightfog.end_dist,
    ],
    falloff: world.heightfog.falloff,
    density: world.heightfog.density,
  };
  P_ForceFogTransition(ent, true);
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
 * across the trigger's movedir axis, the FORCE/direction-of-travel on-vs-off
 * decision, and both AFFECT_FOG and AFFECT_HEIGHTFOG payloads.
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
// trigger_coop_relay  (g_trigger.cpp:1206-1333 / src/kexgame/g_trigger.ts:1035-1160)
// ===========================================================================

/** g_trigger.cpp:1206 -- `SPAWNFLAG_COOP_RELAY_AUTO_FIRE`. */
const SPAWNFLAG_COOP_RELAY_AUTO_FIRE = 1;

/** g_trigger.cpp:1212-1216 -- `inline bool trigger_coop_relay_filter(edict_t *player)`. */
function trigger_coop_relay_filter(player: EdictT): boolean {
  return (
    player.health <= 0 ||
    player.deadflag !== 0 ||
    player.movetype === MovetypeT.MOVETYPE_NOCLIP ||
    (player.client !== null && player.client.resp.spectator) ||
    player.s.modelindex !== 255 // MODELINDEX_PLAYER
  );
}

/** `boxes_intersect` (rerelease q_std.h) -- AABB overlap test. */
function boxes_intersect(aMin: Vec3, aMax: Vec3, bMin: Vec3, bMax: Vec3): boolean {
  for (let i = 0; i < 3; i++) {
    if ((aMin[i] ?? 0) > (bMax[i] ?? 0)) return false;
    if ((aMax[i] ?? 0) < (bMin[i] ?? 0)) return false;
  }
  return true;
}

/** g_trigger.cpp:1218-1243 -- `static bool trigger_coop_relay_can_use(...)`. */
function trigger_coop_relay_can_use(self: EdictT, _activator: EdictT | null): boolean {
  // not coop, so act like a standard trigger_relay minus the message
  if (!kexCoop()) return true;

  // coop; scan for all alive players, print appropriate message
  // to those in/out of range
  let can_use = true;

  for (const player of kexActivePlayers()) {
    // dead or spectator, don't count them
    if (trigger_coop_relay_filter(player)) continue;

    if (boxes_intersect(player.absmin, player.absmax, self.absmin, self.absmax)) continue;

    if (self.timestamp < level.time) gi.centerprintf(player, self.map ?? "");
    can_use = false;
  }

  return can_use;
}

/** g_trigger.cpp:1245-1260 -- `USE(trigger_coop_relay_use)`. */
function trigger_coop_relay_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (!trigger_coop_relay_can_use(self, activator)) {
    if (self.timestamp < level.time && activator !== null) gi.centerprintf(activator, self.message ?? "");

    self.timestamp = level.time + 5;
    return;
  }

  const msg = self.message;
  self.message = null;
  G_UseTargets(self, activator);
  self.message = msg;
}

/**
 * g_trigger.cpp:1272-1306 -- `THINK(trigger_coop_relay_think)`.
 *
 * DEVIATION (mechanical, not behavioral): the rerelease passes a
 * `BoxEdictsFilter_t` callback to gi.BoxEdicts so the engine returns only
 * matching players. The classic gi.BoxEdicts (src/game/game.ts) takes no
 * filter, so the same predicate is applied to the returned list here. The set
 * of entities considered is identical; only where the filtering happens moves.
 */
function trigger_coop_relay_think(self: EdictT): void {
  let num_active = 0;
  for (const player of kexActivePlayers()) {
    if (!trigger_coop_relay_filter(player)) num_active++;
  }

  const raw: Edict[] = [];
  const count = gi.BoxEdicts(self.absmin, self.absmax, raw, MAX_EDICTS, AREA_SOLID);

  const hit: EdictT[] = [];
  for (let i = 0; i < count; i++) {
    const e = raw[i];
    if (e === undefined) continue;
    const ent = e as EdictT;
    if (ent.client === null) continue;
    if (trigger_coop_relay_filter(ent)) continue;
    hit.push(ent);
  }
  const n = hit.length;

  if (n === num_active) {
    const msg = self.message;
    self.message = null;
    // g_trigger.cpp:1281 -- `G_UseTargets(self, &g_edicts[1]);`, i.e. player 1.
    G_UseTargets(self, g_edicts[1] ?? null);
    self.message = msg;

    G_FreeEdict(self);
    return;
  } else if (n !== 0 && self.timestamp < level.time) {
    for (const p of hit) gi.centerprintf(p, self.message ?? "");

    for (const player of kexActivePlayers()) {
      if (!hit.includes(player)) gi.centerprintf(player, self.map ?? "");
    }

    self.timestamp = level.time + 5;
  }

  self.nextthink = level.time + self.wait;
}

/**
 * g_trigger.cpp:1308-1333 -- `void SP_trigger_coop_relay(edict_t *self)`.
 *
 * QUAKED trigger_coop_relay (.5 .5 .5) ? AUTO_FIRE
 * Fires its targets only once every live coop player is inside it.
 *
 * No degradation: gi.centerprintf and gi.BoxEdicts are both classic. The two
 * default messages are the rerelease's localization keys and are passed
 * through verbatim, exactly as the rerelease passes them -- the classic client
 * prints them literally rather than looking them up, since protocol 34 has no
 * localized-print path.
 */
export function SP_trigger_coop_relay(self: EdictT): void {
  if (self.targetname !== null && self.spawnflags & SPAWNFLAG_COOP_RELAY_AUTO_FIRE) {
    gi.dprintf(`${self.classname ?? "?"}: targetname and auto-fire are mutually exclusive\n`);
  }

  InitTrigger(self);

  if (self.message === null) self.message = "$g_coop_wait_for_players";
  if (self.map === null) self.map = "$g_coop_players_waiting_for_you";
  if (self.wait === 0) self.wait = 1;

  if (self.spawnflags & SPAWNFLAG_COOP_RELAY_AUTO_FIRE) {
    self.think = trigger_coop_relay_think;
    self.nextthink = level.time + self.wait;
  } else {
    self.use = trigger_coop_relay_use;
  }
  self.svflags |= SVF_NOCLIENT;
  gi.linkentity(self);
}

// ===========================================================================
// trigger_health_relay  (g_monster.cpp:1611-1650 /
//                        src/kexgame/g_monster.ts:2026-2071)
// ===========================================================================

/**
 * g_monster.cpp:1611-1631 -- `USE(trigger_health_relay_use)`.
 *
 * PRESERVED QUIRK (present in the shipped C++, kept on purpose): the spawn
 * function validates `speed` as a percentage in 0-100, but the comparison here
 * is against a 0-1 fraction, so any `speed` above 1 fires on the first use.
 */
function trigger_health_relay_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  if (other === null) return; // real call sites always pass the health-tracked entity

  const percent_health = kexClamp(other.health / other.max_health, 0, 1);

  // not ready to trigger yet
  if (percent_health > self.speed) return;

  // fire!
  G_UseTargets(self, activator);

  // kill self
  G_FreeEdict(self);
}

/**
 * g_monster.cpp:1633-1650 -- `void SP_trigger_health_relay(edict_t *self)`.
 *
 * QUAKED trigger_health_relay (1.0 1.0 0.0) (-8 -8 -8) (8 8 8)
 * Special type of relay that fires when a linked object is reduced beyond a
 * certain amount of health. It fires once, then frees itself.
 *
 * No degradation: everything this entity does is server-side targeting.
 */
export function SP_trigger_health_relay(self: EdictT): void {
  if (self.targetname === null) {
    gi.dprintf(`${self.classname ?? "?"} missing targetname\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.speed < 0 || self.speed > 100) {
    gi.dprintf(
      `${self.classname ?? "?"} has bad "speed" (health percentage); must be between 0 and 100, inclusive\n`,
    );
    G_FreeEdict(self);
    return;
  }

  self.svflags |= SVF_NOCLIENT;
  self.use = trigger_health_relay_use;
}

// ===========================================================================
// func_eye  (g_func.cpp:2554-2688 / src/kexgame/g_func.ts:2557-2688)
// ===========================================================================

/**
 * g_func.cpp:2556 -- `SPAWNFLAG_FUNC_EYE_FIRED_TARGETS`, bit 17, internal use
 * only (the rerelease sets it on the entity at runtime to remember that it
 * has already fired).
 */
const SPAWNFLAG_FUNC_EYE_FIRED_TARGETS = 1 << 16;

/** g_func.cpp:2558-2637 -- `THINK(func_eye_think)`. */
function func_eye_think(self: EdictT): void {
  // find enemy to track
  let closest_dist = 0;
  let closest_player: EdictT | null = null;

  for (const player of kexActivePlayers()) {
    const raw = vec3();
    VectorSubtract(player.s.origin, self.s.origin, raw);
    const dist = VectorLength(raw);
    const dir = vec3();
    VectorCopy(raw, dir);
    VectorNormalize(dir);

    const dot =
      (dir[0] ?? 0) * (self.movedir[0] ?? 0) +
      (dir[1] ?? 0) * (self.movedir[1] ?? 0) +
      (dir[2] ?? 0) * (self.movedir[2] ?? 0);
    if (dot < self.yaw_speed) continue;
    if (dist >= self.dmg_radius) continue;

    if (closest_player === null || dist < closest_dist) {
      closest_player = player;
      closest_dist = dist;
    }
  }

  self.enemy = closest_player;

  // tracking player
  const wanted_angles = vec3();

  const fwd = vec3();
  const rgt = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, fwd, rgt, up);

  const eye_pos = vec3();
  VectorCopy(self.s.origin, eye_pos);
  for (let i = 0; i < 3; i++) {
    eye_pos[i] =
      (eye_pos[i] ?? 0) +
      (fwd[i] ?? 0) * (self.move_origin[0] ?? 0) +
      (rgt[i] ?? 0) * (self.move_origin[1] ?? 0) +
      (up[i] ?? 0) * (self.move_origin[2] ?? 0);
  }

  if (self.enemy !== null) {
    if (!(self.spawnflags & SPAWNFLAG_FUNC_EYE_FIRED_TARGETS)) {
      G_UseTargets(self, self.enemy);
      self.spawnflags |= SPAWNFLAG_FUNC_EYE_FIRED_TARGETS;
    }

    const dir = vec3();
    VectorSubtract(self.enemy.s.origin, eye_pos, dir);
    VectorNormalize(dir);
    vectoangles(dir, wanted_angles);

    self.s.frame = 2;
    self.timestamp = level.time + self.wait;
  } else {
    if (self.timestamp <= level.time) {
      // return to neutral
      VectorCopy(self.move_angles, wanted_angles);
      self.s.frame = 0;
    } else {
      VectorCopy(self.s.angles, wanted_angles);
    }
  }

  for (let i = 0; i < 2; i++) {
    const current = anglemod(self.s.angles[i] ?? 0);
    const ideal = wanted_angles[i] ?? 0;

    if (current === ideal) continue;

    let move = ideal - current;

    if (ideal > current) {
      if (move >= 180) move = move - 360;
    } else {
      if (move <= -180) move = move + 360;
    }
    if (move > 0) {
      if (move > self.speed) move = self.speed;
    } else {
      if (move < -self.speed) move = -self.speed;
    }

    self.s.angles[i] = anglemod(current + move);
  }

  self.nextthink = level.time + FRAMETIME;
}

/** g_func.cpp:2639-2652 -- `THINK(func_eye_setup)`. */
function func_eye_setup(self: EdictT): void {
  const eye_pos = self.pathtarget !== null ? G_PickTarget(self.pathtarget) : null;

  if (eye_pos === null) {
    gi.dprintf(`${kexEdictFmt(self)}: bad target\n`);
  } else {
    VectorSubtract(eye_pos.s.origin, self.s.origin, self.move_origin);
  }

  VectorCopy(self.move_origin, self.movedir);
  VectorNormalize(self.movedir);

  self.think = func_eye_think;
  self.nextthink = level.time + FRAMETIME;
}

/**
 * g_func.cpp:2654-2688 -- `void SP_func_eye(edict_t *ent)`.
 *
 * QUAKED func_eye (0 .5 .8) ?
 * A brush-model eye that tracks the nearest player inside "radius" and within
 * "yaw_speed" of its facing, firing its targets the first time it acquires one.
 *
 * No degradation: this is a brush model turning on s.angles and switching
 * s.frame, both of which protocol 34 carries in full.
 *
 * TIME NOTE: the rerelease multiplies `speed` (degrees per tick) by its 0.01 s
 * frame time and rethinks every tick; the classic module multiplies by
 * FRAMETIME (0.1 s) and rethinks every classic frame, giving the same degrees
 * per second at one tenth the sample rate.
 */
export function SP_func_eye(ent: EdictT): void {
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  if (ent.model !== null) gi.setmodel(ent, ent.model);

  if (!st.radius) ent.dmg_radius = 512;
  else ent.dmg_radius = st.radius;

  if (!ent.speed) ent.speed = 45;

  if (!ent.yaw_speed) ent.yaw_speed = 0.5;

  ent.speed *= FRAMETIME;
  VectorCopy(ent.s.angles, ent.move_angles);

  ent.wait = 1.0;

  if (ent.pathtarget !== null) {
    ent.think = func_eye_setup;
    ent.nextthink = level.time + FRAMETIME;
  } else {
    ent.think = func_eye_think;
    ent.nextthink = level.time + FRAMETIME;

    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(ent.move_angles, forward, right, up);
    VectorCopy(forward, ent.movedir);

    const move_origin = vec3();
    VectorCopy(ent.move_origin, move_origin);
    for (let i = 0; i < 3; i++) {
      ent.move_origin[i] =
        (ent.movedir[i] ?? 0) * (move_origin[0] ?? 0) +
        (right[i] ?? 0) * (move_origin[1] ?? 0) +
        (up[i] ?? 0) * (move_origin[2] ?? 0);
    }
  }

  gi.linkentity(ent);
}

// ===========================================================================
// info_nav_lock  (bot_utils.cpp:382-413 /
//                 src/kexgame/bots/bot_utils.ts:90-124)
// ===========================================================================

/**
 * bot_utils.cpp:382-393 -- `USE(info_nav_lock_use)`.
 *
 * DEVIATIONS, both forced by the classic svflags/flags sets:
 *   * The rerelease rejects a target that is not `SVF_DOOR`. The classic
 *     module has only SVF_NOCLIENT / SVF_DEADMONSTER / SVF_MONSTER, so the
 *     "is this a door" test is made by classname against the two classic door
 *     entities instead. Same set of entities in practice.
 *   * `FL_LOCKED` becomes FL_KEX_LOCKED (g_kexent.ts, a free flag bit).
 *
 * DEGRADATION: no classic door code tests a locked flag -- the classic
 * func_door has no lock concept at all -- so the toggle is inert. The entity
 * spawns, validates its targetname/target, and its use wiring works.
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

registerSaveFunction("g_kextrig:trigger_flashlight_touch", trigger_flashlight_touch);
registerSaveFunction("g_kextrig:trigger_fog_touch", trigger_fog_touch);
registerSaveFunction("g_kextrig:trigger_coop_relay_use", trigger_coop_relay_use);
registerSaveFunction("g_kextrig:trigger_coop_relay_think", trigger_coop_relay_think);
registerSaveFunction("g_kextrig:trigger_health_relay_use", trigger_health_relay_use);
registerSaveFunction("g_kextrig:func_eye_think", func_eye_think);
registerSaveFunction("g_kextrig:func_eye_setup", func_eye_setup);
registerSaveFunction("g_kextrig:info_nav_lock_use", info_nav_lock_use);
