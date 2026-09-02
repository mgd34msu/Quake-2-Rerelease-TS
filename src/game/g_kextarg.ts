// g_kextarg.ts -- the target_* world entities that exist ONLY in the 2023
// re-release game DLL, translated into the classic (3.21) module.
//
// Source of every line here: src/kexgame/g_target.ts (this repo's port of
// quake2-rerelease-dll/rerelease/g_target.cpp). Each function carries the
// g_target.cpp line reference that src/kexgame/g_target.ts itself records.
//
// Classnames landed in this file:
//   target_poi, target_sky, target_light, target_music, target_story,
//   target_camera, target_gravity, target_soundfx, target_autosave,
//   target_healthbar, target_crossunit_target, target_crossunit_trigger,
//   target_achievement
//
// TRANSLATION NOTES (apply throughout):
//   * kexgame wraps every callback in RegisterUse/RegisterThink; the classic
//     module uses plain functions plus registerSaveFunction() at the file tail.
//   * kexgame's level.time is a millisecond GTime; the classic level.time is a
//     float in SECONDS with FRAMETIME (0.1) as one server frame.
//     `Gtime_from_ms(100)` / `Gtime_from_hz(10)` -> FRAMETIME;
//     `Gtime_from_sec(x)` -> x; `GTIME_ZERO` -> 0.
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `deathmatchEnabled()` -> the classic `deathmatch->value` idiom, here
//     wrapped as kexDeathmatch() in g_kexent.ts.
//   * `gi.Com_Print` -> `gi.dprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * target_poi        -- full server-side POI selection/stage bookkeeping, no
//                         compass/objective HUD to present it. See SP_target_poi.
//  * target_story      -- state kept, no CONFIG_STORY_INDEX configstring slot.
//  * target_healthbar  -- full bar registration/validation, no HUD slot.
//  * target_achievement-- entity and target wiring, no svc_achievement message.
//  * target_light      -- full colour-lerp state machine, no RF_CUSTOM_LIGHT
//                         consumer under a non-extended configstring layout.
//  * target_camera     -- intermission camera runs; three rerelease-only
//                         side effects are absent. See use_target_camera.
//  * target_sky        -- works, with one readback deviation (see g_kexent.ts).
//  * target_music / target_gravity / target_soundfx / target_autosave /
//    target_crossunit_* -- no degradation.

import { AngleVectors, DotProduct, VectorAdd, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorScale, VectorSet, VectorSubtract, vec3, type Vec3 } from "../shared/math";
import {
  ATTN_NORM,
  BUTTON_ANY,
  CHAN_AUTO,
  CHAN_VOICE,
  CS_CDTRACK,
  CS_GENERAL,
  CS_SKY,
  CS_SKYAXIS,
  CS_SKYROTATE,
  EntityEventT,
  MASK_SOLID,
  MAX_CLIENTS,
  PITCH,
  PRINT_HIGH,
  RF_CUSTOM_LIGHT,
  RF_MINLIGHT,
  ROLL,
  YAW,
} from "../shared/q_shared";
import { SolidT, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  type EdictT,
  FRAMETIME,
  game,
  gi,
  g_edicts,
  level,
  MovetypeT,
  SFL_CROSS_TRIGGER_MASK,
  st,
} from "./g_local";
import {
  kexBrandom,
  kexClient,
  kexDeathmatch,
  kexLevel,
  kexLightStyleString,
  MAX_HEALTH_BARS,
} from "./g_kexent";
import { G_Find, G_FreeEdict, G_PickTarget, G_Spawn, G_UseTargets } from "./g_utils";
import { MoveClientToIntermission } from "./p_hud";
import { respawn } from "./p_client";
import { G_SetClientFrame } from "./p_view";
import { registerSaveFunction } from "./g_save";

// ---------------------------------------------------------------------------
// hackflags (rerelease g_local.h's `hackflag_t`) -- read off the edict's
// `hackflags` field, which the shared EdictT already declares.
// ---------------------------------------------------------------------------

/** g_local.h: allow the player to skip a target_camera sequence. */
const HACKFLAG_SKIPPABLE = 1;
/** g_local.h: fade the camera dummy out as if teleporting. */
const HACKFLAG_TELEPORT_OUT = 2;
/** g_local.h: fire the end-of-unit message when the camera starts. */
const HACKFLAG_END_OF_UNIT = 4;

// ===========================================================================
// target_camera  (g_target.cpp:1120-1365 / src/kexgame/g_target.ts:1188-1412)
// ===========================================================================

/**
 * g_target.cpp:1120-1136 -- `static void camera_lookat_pathtarget(...)`.
 * Points `dest` (an angles triple) from `origin` at the entity named by
 * `self->pathtarget`.
 */
function camera_lookat_pathtarget(self: EdictT, origin: Vec3, dest: Vec3): void {
  if (self.pathtarget === null) return;

  const pt = G_Find(null, "targetname", self.pathtarget);
  if (pt === null) return;

  const delta = vec3();
  VectorSubtract(pt.s.origin, origin, delta);
  const d = (delta[0] ?? 0) * (delta[0] ?? 0) + (delta[1] ?? 0) * (delta[1] ?? 0);
  let yaw: number;
  let pitch: number;

  if (d === 0) {
    yaw = 0;
    pitch = (delta[2] ?? 0) > 0 ? 90 : -90;
  } else {
    yaw = Math.atan2(delta[1] ?? 0, delta[0] ?? 0) * (180 / Math.PI);
    pitch = Math.atan2(delta[2] ?? 0, Math.sqrt(d)) * (180 / Math.PI);
  }

  dest[YAW] = yaw;
  dest[PITCH] = -pitch;
  dest[ROLL] = 0;
}

/**
 * g_target.cpp:1256-1273 -- `THINK(target_camera_dummy_think)`.
 *
 * DEVIATION: the rerelease calls `SetXyspeed(...)` before G_SetClientFrame so
 * the fake player picks run frames while it still has velocity. The classic
 * p_view.ts keeps `xyspeed` module-private and exports no setter (this port
 * does not own p_view.ts), so the dummy's frame selection uses whatever
 * xyspeed the last real ClientEndServerFrame left behind. Cosmetic only, on
 * an entity that only exists for the duration of a cutscene.
 *
 * DEGRADATION (protocol 34): the HACKFLAG_TELEPORT_OUT alpha fade writes
 * `s.alpha`, which the delta cannot carry -- the dummy pops out instead of
 * fading. The timestamp countdown itself runs correctly.
 */
function target_camera_dummy_think(self: EdictT): void {
  if (self.owner === null) {
    throw new Error(
      "target_camera_dummy_think: self.owner is null (invariant violated -- always set by use_target_camera before this runs)",
    );
  }

  // bit of a hack, but this will let the dummy move like a player
  self.client = self.owner.client;
  G_SetClientFrame(self);
  self.client = null;

  // alpha fade out for voops
  if ((self.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
    const dec = self.timestamp - FRAMETIME;
    self.timestamp = dec < 0 ? 0 : dec;
    self.s.alpha = Math.max(1 / 255, self.pain_debounce_time === 0 ? 0 : self.timestamp / self.pain_debounce_time);
  }

  self.nextthink = level.time + FRAMETIME;
}

/** g_target.cpp:1138-1250 -- `THINK(update_target_camera)`. */
function update_target_camera(self: EdictT): void {
  let do_skip = false;

  // only allow skipping after 2 seconds
  if ((self.hackflags & HACKFLAG_SKIPPABLE) !== 0 && level.time > 2) {
    for (let i = 0; i < game.maxclients; i++) {
      const client = g_edicts[1 + i];
      if (client === undefined || !client.inuse || client.client === null || !client.client.pers.connected) continue;

      if ((client.client.buttons & BUTTON_ANY) !== 0) {
        do_skip = true;
        break;
      }
    }
  }

  if (!do_skip && self.movetarget !== null) {
    // The rerelease steps by `move_speed * gi.frame_time_s * 0.8` once per
    // 100 Hz tick; the classic server ticks at 10 Hz, so one FRAMETIME step
    // covers the same ground per second.
    self.moveinfo.remaining_distance -= self.moveinfo.move_speed * FRAMETIME * 0.8;

    if (self.moveinfo.remaining_distance <= 0) {
      if ((self.movetarget.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
        if (self.enemy !== null) {
          self.enemy.s.event = EntityEventT.EV_PLAYER_TELEPORT;
          self.enemy.hackflags = HACKFLAG_TELEPORT_OUT;
          const teleportTime = self.movetarget.wait;
          self.enemy.pain_debounce_time = teleportTime;
          self.enemy.timestamp = teleportTime;
        }
      }

      VectorCopy(self.movetarget.s.origin, self.s.origin);
      self.nextthink = level.time + self.movetarget.wait;
      if (self.movetarget.target !== null) {
        self.movetarget = G_PickTarget(self.movetarget.target);

        if (self.movetarget !== null) {
          self.moveinfo.move_speed = self.movetarget.speed !== 0 ? self.movetarget.speed : 55;
          const d = vec3();
          VectorSubtract(self.movetarget.s.origin, self.s.origin, d);
          self.moveinfo.remaining_distance = VectorLength(d);
          self.moveinfo.distance = self.moveinfo.remaining_distance;
        }
      } else {
        self.movetarget = null;
      }

      return;
    }

    const frac = 1.0 - self.moveinfo.remaining_distance / self.moveinfo.distance;

    if (self.enemy !== null && (self.enemy.hackflags & HACKFLAG_TELEPORT_OUT) !== 0) {
      // stored, not transmitted -- see target_camera_dummy_think
      self.enemy.s.alpha = Math.max(1 / 255, frac);
    }

    const delta = vec3();
    VectorSubtract(self.movetarget.s.origin, self.s.origin, delta);
    const newpos = vec3();
    VectorSet(
      newpos,
      (self.s.origin[0] ?? 0) + (delta[0] ?? 0) * frac,
      (self.s.origin[1] ?? 0) + (delta[1] ?? 0) * frac,
      (self.s.origin[2] ?? 0) + (delta[2] ?? 0) * frac,
    );

    camera_lookat_pathtarget(self, newpos, level.intermission_angle);
    VectorCopy(newpos, level.intermission_origin);

    // move all clients to the intermission point
    for (let i = 0; i < game.maxclients; i++) {
      const client = g_edicts[1 + i];
      if (client === undefined || !client.inuse) continue;

      MoveClientToIntermission(client);
    }
  } else {
    if (self.killtarget !== null) {
      // destroy dummy player
      if (self.enemy !== null) G_FreeEdict(self.enemy);

      level.intermissiontime = 0;
      kexLevel().level_intermission_set = true;

      let t = G_Find(null, "targetname", self.killtarget);
      while (t !== null) {
        if (t.use !== null) t.use(t, self, self.activator);
        t = G_Find(t, "targetname", self.killtarget);
      }

      level.intermissiontime = level.time;

      // end of unit requires a wait
      if (level.changemap !== null && !level.changemap.includes("*")) level.exitintermission = 1;
    }

    self.think = null;
    return;
  }

  self.nextthink = level.time + FRAMETIME;
}

/**
 * g_target.cpp:1275-1353 -- `USE(use_target_camera)`.
 *
 * DEGRADATIONS / DEVIATIONS (all rerelease-only side effects with no classic
 * counterpart; every one of them is a no-op here, and the camera itself runs):
 *   * `level.intermission_server_frame = gi.ServerFrame()` -- the classic
 *     GameImports has no ServerFrame() and LevelLocalsT has no such field.
 *     Only the rerelease's own frame-accurate intermission bookkeeping reads
 *     it; the classic intermission runs off level.intermissiontime, which IS
 *     set.
 *   * `P_UseCoopInstancedItems()` -- the classic module has no coop instanced
 *     items, so the guarded "restore max health before respawn" branch is
 *     unreachable by construction (the predicate is constantly false). The
 *     unconditional `respawn(client)` for dead clients IS performed.
 *   * `G_EndOfUnitMessage()` on HACKFLAG_END_OF_UNIT -- the rerelease's
 *     end-of-unit score summary. No classic equivalent exists.
 */
function use_target_camera(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (self.sounds !== 0) gi.configstring(CS_CDTRACK, `${self.sounds}`);

  if (self.target === null) return;

  self.movetarget = G_PickTarget(self.target);

  if (self.movetarget === null) return;

  level.intermissiontime = level.time;
  level.exitintermission = 0;

  // spawn fake player dummy where we were
  if (activator !== null && activator.client !== null) {
    const dummy = G_Spawn();
    self.enemy = dummy;
    dummy.owner = activator;
    dummy.clipmask = activator.clipmask;
    VectorCopy(activator.s.origin, dummy.s.origin);
    VectorCopy(activator.s.angles, dummy.s.angles);
    dummy.groundentity = activator.groundentity;
    dummy.groundentity_linkcount = dummy.groundentity !== null ? dummy.groundentity.linkcount : 0;
    dummy.think = target_camera_dummy_think;
    dummy.nextthink = level.time + FRAMETIME;
    dummy.solid = SolidT.SOLID_BBOX;
    dummy.movetype = MovetypeT.MOVETYPE_STEP;
    VectorCopy(activator.mins, dummy.mins);
    VectorCopy(activator.maxs, dummy.maxs);
    dummy.s.modelindex = 255; // MODELINDEX_PLAYER
    dummy.s.modelindex2 = 255;
    dummy.s.skinnum = activator.s.skinnum;
    VectorCopy(activator.velocity, dummy.velocity);
    dummy.s.renderfx = RF_MINLIGHT;
    dummy.s.frame = activator.s.frame;
    gi.linkentity(dummy);
  }

  camera_lookat_pathtarget(self, self.s.origin, level.intermission_angle);
  VectorCopy(self.s.origin, level.intermission_origin);

  // move all clients to the intermission point
  for (let i = 0; i < game.maxclients; i++) {
    const client = g_edicts[1 + i];
    if (client === undefined || !client.inuse) continue;

    // respawn any dead clients
    if (client.health <= 0) {
      // (rerelease coop-instanced-items branch omitted -- see the
      //  degradation note on this function)
      respawn(client);
    }

    MoveClientToIntermission(client);
  }

  self.activator = activator;
  self.think = update_target_camera;
  self.nextthink = level.time + self.wait;
  self.moveinfo.move_speed = self.speed;

  const d = vec3();
  VectorSubtract(self.movetarget.s.origin, self.s.origin, d);
  self.moveinfo.remaining_distance = VectorLength(d);
  self.moveinfo.distance = self.moveinfo.remaining_distance;

  // (rerelease G_EndOfUnitMessage() on HACKFLAG_END_OF_UNIT omitted -- see
  //  the degradation note on this function)
}

/** g_target.cpp:1355-1365 -- `void SP_target_camera(edict_t *self)`. */
export function SP_target_camera(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_camera;
  self.svflags = SVF_NOCLIENT;
}

// ===========================================================================
// target_gravity  (g_target.cpp:1371-1381 / src/kexgame/g_target.ts:1418-1432)
// ===========================================================================

/** g_target.cpp:1371-1375 -- `USE(use_target_gravity)`. */
function use_target_gravity(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  gi.cvar_set("sv_gravity", `${self.gravity}`);
  kexLevel().gravity = self.gravity;
}

/**
 * g_target.cpp:1377-1381 -- `void SP_target_gravity(edict_t* self)`.
 *
 * QUAKED target_gravity (1 0 0) (-8 -8 -8) (8 8 8)
 * Sets sv_gravity when triggered.
 *
 * No degradation: gi.cvar_set is a classic import and sv_gravity is the
 * classic physics gravity cvar. (`level.gravity` has no classic LevelLocalsT
 * field, so the mirror lives in g_kexent.ts's kexLevel(); nothing in the
 * classic module reads it, exactly as nothing in the rerelease reads it
 * outside its own p_move.)
 */
export function SP_target_gravity(self: EdictT): void {
  self.use = use_target_gravity;
  // g_target.cpp:1380 -- `self->gravity = atof(st.gravity);`, preserving the
  // rerelease's own note that st.gravity is normally null here.
  self.gravity = Number(st.gravity ?? "0");
}

// ===========================================================================
// target_soundfx  (g_target.cpp:1387-1433 / src/kexgame/g_target.ts:1438-1476)
// ===========================================================================

/** g_target.cpp:1387-1390 -- `THINK(update_target_soundfx)`. */
function update_target_soundfx(self: EdictT): void {
  gi.positioned_sound(self.s.origin, self, CHAN_VOICE, self.noise_index, self.volume, self.attenuation, 0);
}

/** g_target.cpp:1392-1396 -- `USE(use_target_soundfx)`. */
function use_target_soundfx(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.think = update_target_soundfx;
  self.nextthink = level.time + self.delay;
}

/**
 * g_target.cpp:1398-1433 -- `void SP_target_soundfx(edict_t* self)`.
 *
 * QUAKED target_soundfx (1 0 0) (-8 -8 -8) (8 8 8)
 * Plays one of five hard-coded world ambience samples, chosen by "noise".
 *
 * No degradation: gi.positioned_sound and gi.soundindex are both classic.
 */
export function SP_target_soundfx(self: EdictT): void {
  if (self.volume === 0) self.volume = 1.0;

  if (self.attenuation === 0) self.attenuation = 1.0;
  else if (self.attenuation === -1) self.attenuation = 0; // use -1 so 0 defaults to 1

  self.noise_index = st.noise !== null ? parseInt(st.noise, 10) : 0;

  switch (self.noise_index) {
    case 1:
      self.noise_index = gi.soundindex("world/x_alarm.wav");
      break;
    case 2:
      self.noise_index = gi.soundindex("world/flyby1.wav");
      break;
    case 4:
      self.noise_index = gi.soundindex("world/amb12.wav");
      break;
    case 5:
      self.noise_index = gi.soundindex("world/amb17.wav");
      break;
    case 7:
      self.noise_index = gi.soundindex("world/bigpump2.wav");
      break;
    default:
      gi.dprintf(`${self.classname ?? "?"}: unknown noise ${self.noise_index}\n`);
      return;
  }

  self.use = use_target_soundfx;
}

// ===========================================================================
// target_light  (g_target.cpp:1440-1556 / src/kexgame/g_target.ts:1482-1592)
// ===========================================================================

/** g_target.cpp:1440-1442 -- target_light spawnflags. */
const SPAWNFLAG_TARGET_LIGHT_START_ON = 1;
const SPAWNFLAG_TARGET_LIGHT_NO_LERP = 2;
const SPAWNFLAG_TARGET_LIGHT_FLICKER = 4;

/** g_target.cpp:1444-1450 -- `THINK(target_light_flicker_think)`. */
function target_light_flicker_think(self: EdictT): void {
  if (kexBrandom()) self.svflags ^= SVF_NOCLIENT;

  self.nextthink = level.time + FRAMETIME;
}

/**
 * g_target.cpp:1453-1499 -- `THINK(target_light_think)`.
 *
 * Lerps this light's packed RGB (`self.count`) toward its dynamic_light
 * target's packed RGB (`self.chain.s.skinnum`) along the lightstyle string
 * for `self.style`, and writes the result into `self.s.skinnum` for the
 * client's RF_CUSTOM_LIGHT consumer.
 *
 * DEVIATION: the lightstyle string comes from kexLightStyleString()
 * (g_kexent.ts) rather than `gi.get_configstring(CS_LIGHTS + style)` -- the
 * classic GameImports has no configstring reader. See that function for what
 * the mirror does and does not cover.
 */
function target_light_think(self: EdictT): void {
  if (self.spawnflags & SPAWNFLAG_TARGET_LIGHT_FLICKER) target_light_flicker_think(self);

  const style = kexLightStyleString(self.style);
  self.delay += self.speed;

  const index = Math.trunc(self.delay) % style.length;
  const style_value = style.charCodeAt(index);
  const current_lerp = (style_value - 97) / (122 - 97); // 'a'=97, 'z'=122
  let lerpVal: number;

  if (!(self.spawnflags & SPAWNFLAG_TARGET_LIGHT_NO_LERP)) {
    const next_index = (index + 1) % style.length;
    const next_style_value = style.charCodeAt(next_index);
    const next_lerp = (next_style_value - 97) / (122 - 97);

    const mod_lerp = self.delay % 1.0;
    lerpVal = next_lerp * mod_lerp + current_lerp * (1 - mod_lerp);
  } else {
    lerpVal = current_lerp;
  }

  const my_rgb = self.count;
  if (self.chain === null) {
    throw new Error("target_light_think: self.chain is null (invariant violated -- see SP_target_light)");
  }
  const target_rgb = self.chain.s.skinnum;

  const my_b = (my_rgb >> 8) & 0xff;
  const my_g = (my_rgb >> 16) & 0xff;
  const my_r = (my_rgb >> 24) & 0xff;

  const target_b = (target_rgb >> 8) & 0xff;
  const target_g = (target_rgb >> 16) & 0xff;
  const target_r = (target_rgb >> 24) & 0xff;

  const backlerp = 1.0 - lerpVal;

  const b = Math.trunc(target_b * lerpVal + my_b * backlerp);
  const g = Math.trunc(target_g * lerpVal + my_g * backlerp);
  const r = Math.trunc(target_r * lerpVal + my_r * backlerp);

  self.s.skinnum = ((b << 8) | (g << 16) | (r << 24)) >>> 0;

  self.nextthink = level.time + FRAMETIME;
}

/** g_target.cpp:1501-1528 -- `USE(target_light_use)`. */
function target_light_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.health = self.health !== 0 ? 0 : 1;

  if (self.health !== 0) self.svflags &= ~SVF_NOCLIENT;
  else self.svflags |= SVF_NOCLIENT;

  if (self.health === 0) {
    self.think = null;
    self.nextthink = 0;
    return;
  }

  // has dynamic light "target"
  if (self.chain !== null) {
    self.think = target_light_think;
    self.nextthink = level.time + FRAMETIME;
  } else if (self.spawnflags & SPAWNFLAG_TARGET_LIGHT_FLICKER) {
    self.think = target_light_flicker_think;
    self.nextthink = level.time + FRAMETIME;
  }
}

/**
 * g_target.cpp:1530-1556 -- `void SP_target_light(edict_t *self)`.
 *
 * QUAKED target_light (0 1 0) (-8 -8 -8) (8 8 8) START_ON NO_LERP FLICKER
 * A togglable coloured dynamic light.
 *
 * DEGRADATION (protocol 34), TWO SEPARATE ONES, mirroring misc_flare:
 *
 * 1. THE LIGHT DOES NOT RENDER. The client's consumer
 *    (src/client/cl_ents.ts:743, `if (renderfx & RF_CUSTOM_LIGHT)`, which
 *    calls V_AddLight with the radius from s.frame and the packed colour from
 *    s.skinnum) sits inside `if (cls.csr.extended)`. For the classic family
 *    `cls.csr` is CS_REMAP_OLD with `extended: false`
 *    (src/shared/cs_remap.ts:83), so the branch is never entered.
 *    RF_CUSTOM_LIGHT itself DOES reach the client -- protocol 34's delta
 *    writes renderfx as a full Long once it exceeds 0x8000
 *    (src/qcommon/sizebuf.ts:317-320, 384) -- but nothing consumes it.
 *
 * 2. DELIBERATE DEVIATION: `self->s.modelindex = 1` (g_target.cpp:1531) is
 *    NOT set, for exactly the reason spelled out on SP_misc_flare: with the
 *    extended branch skipped, modelindex 1 resolves to the world model and
 *    hangs R_DrawAlphaSurfaces (src/client/cl_ents.ts:666-676). Left at 0 the
 *    entity is culled from client frames by sv_ents.ts:344 whenever it is not
 *    SVF_NOCLIENT anyway.
 *
 * BOTH ARE LIFTED ON A WIDE SESSION (gi.extended_layout()), for the reasons
 * SP_misc_flare's note now spells out: the client has the RF_CUSTOM_LIGHT
 * branch, it consumes the entity before the model lookup, and without the
 * restored modelindex sv_ents.ts:344 would cull the entity so the light could
 * never be drawn no matter how correct its state was. A narrow session is
 * unchanged.
 *
 * Everything else runs: the START_ON toggle, the FLICKER svflags flip, the
 * chain lookup to the dynamic_light target, the whole colour-lerp think, the
 * `speed` reciprocal, and the s.skinnum the rerelease client would read.
 *
 * DEVIATION: `if (level.is_n64) self->style += 10;` is dropped -- the classic
 * LevelLocalsT has no `is_n64` flag (the rerelease sets it from the N64
 * worldspawn), so the style offset cannot be decided here.
 */
export function SP_target_light(self: EdictT): void {
  // g_target.cpp:1531 -- `self->s.modelindex = 1;`. Wide sessions only; see
  // degradation note 2 above.
  if (gi.extended_layout?.() === true) self.s.modelindex = 1;
  self.s.renderfx = RF_CUSTOM_LIGHT;
  self.s.frame = st.radius !== 0 ? st.radius : 150;
  self.count = self.s.skinnum;
  self.svflags |= SVF_NOCLIENT;
  self.health = 0;

  if (self.target !== null) self.chain = G_PickTarget(self.target);

  if (self.spawnflags & SPAWNFLAG_TARGET_LIGHT_START_ON) target_light_use(self, self, self);

  if (self.speed === 0) self.speed = 1.0;
  else self.speed = 0.1 / self.speed;

  // (rerelease `if (level.is_n64) self->style += 10;` omitted -- see above)

  self.use = target_light_use;

  gi.linkentity(self);
}

// ===========================================================================
// target_poi  (g_target.cpp:1593-1803 / src/kexgame/g_target.ts:1595-1774)
// ===========================================================================

/** g_target.cpp:1593-1596 -- target_poi spawnflags. */
const SPAWNFLAG_POI_NEAREST = 1;
const SPAWNFLAG_POI_DUMMY = 2;
const SPAWNFLAG_POI_DYNAMIC = 4;
const SPAWNFLAG_POI_DISABLED = 8;

/** kexapi/game.ts's `PathFlags.All` (`static_cast<uint32_t>(-1)`), spelled
 *  locally for the same reason POI_OBJECTIVE below is: this module names no
 *  kex API symbol. */
const PATH_FLAGS_ALL = 0xffffffff;

/** kexapi/game.ts's `PathReturnCode::NoNavAvailable` (8) -- "no nav file
 *  available for this map", the one failure distance_to_poi treats
 *  differently from every other. Spelled locally, same reason. */
const PATH_RETURN_NO_NAV_AVAILABLE = 8;

/** g_items.cpp:1495: `constexpr size_t MAX_TEMP_POI_POINTS = 128;`. */
const MAX_TEMP_POI_POINTS = 128;

/**
 * The node-search settings BOTH re-release path queries in this file's
 * porting targets use, byte-identical between them
 * (g_target.cpp:1604-1607 and g_items.cpp:1571-1574): ignore node flags,
 * a 128-unit vertical band, a 1024-unit radius, and a 64-unit move
 * distance under PathFlags::All. Spelled once here so the two call sites
 * below cannot drift apart the way they could if each repeated the
 * literals.
 */
function compassPathQueryDefaults(): { moveDist: number; pathFlags: number; ignoreNodeFlags: boolean; minHeight: number; maxHeight: number; radius: number } {
  return { moveDist: 64, pathFlags: PATH_FLAGS_ALL, ignoreNodeFlags: true, minHeight: 128, maxHeight: 128, radius: 1024 };
}

/**
 * g_target.cpp:1599-1621 -- `static float distance_to_poi(...)`.
 *
 * The re-release asks the engine's nav mesh for a WALKED path length, so a
 * teamed target_poi picking by SPAWNFLAG_POI_NEAREST picks the one that is
 * actually nearest to walk to rather than the one nearest through a wall.
 * Three outcomes, exactly as in the C++:
 *   - path found            -> its squared length (`info.pathDistSqr`)
 *   - no nav data for the map -> straight-line squared distance
 *   - nav data, but no route  -> infinity (this POI is unreachable)
 *
 * `gi.get_path_to_goal` being ABSENT is the second case, not the third: a
 * binding with no nav-mesh entry point is precisely "no nav available", and
 * that has been this function's whole behavior until the hook landed.
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
 * The re-release compass/objective marker. 757 instances across the shipped
 * maps, so this one MUST spawn.
 *
 * DEGRADATION (protocol 34): every bit of the selection algorithm runs --
 * team scan, style priority, NEAREST distance ranking, DUMMY fallback,
 * DYNAMIC latching, and the level-wide stage counter -- and the winning POI's
 * origin and image index are recorded in the kex level state (g_kexent.ts's
 * kexLevel().current_poi / current_poi_image / current_dynamic_poi /
 * valid_poi / current_poi_stage), exactly where the rerelease records them in
 * level_locals_t. What is missing is the PRESENTATION: the rerelease draws
 * the POI as a compass arrow and objective marker from its own client-side
 * HUD layout (CG_DrawHUD's poi element, fed from those level fields through
 * the extended player_state). The classic HUD (p_hud.ts's statusbar program)
 * has no compass, no objective marker and no slot to add one, and protocol
 * 34's player_state carries no field for it. So the POI is fully tracked and
 * never shown.
 *
 * The image lookup still runs, so the "friend" / custom POI icon is
 * precached into CS_IMAGES exactly as the rerelease precaches it.
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

// ===========================================================================
// COMPASS / POI PRESENTATION
// (p_client.cpp:1771-1782 / g_items.cpp:1499-1624, via
//  src/kexgame/p_client.ts's P_SendLevelPOI and src/kexgame/g_items.ts's
//  Compass_Update / Use_Compass)
// ===========================================================================
//
// The rerelease turns the target_poi bookkeeping above into two client
// messages: svc_poi (the objective marker the client projects onto the world
// and clamps to the screen edge -- cl_scrn.ts's SCR_AddPOI/SCR_DrawPOIs) and
// svc_help_path (the breadcrumb trail -- SCR_AddHelpPath). Neither opcode
// exists in protocol 34, so on a NARROW session these emit nothing at all and
// the target_poi degradation note on SP_target_poi still describes reality.
//
// On a WIDE session (gi.extended_layout(), i.e. this map's entity lump made
// sv_init.ts's SV_ContentNeedsWideLayout fire, or the kex family) the wire
// carries both, and the classic module presents the objective marker exactly
// as the kex module does -- same key, same lifetime, same image, same colour,
// same flags, same reliable unicast. The write itself goes through the
// engine (game.ts's optional `poi()` / `help_path()` imports,
// src/server/bindings/legacy.ts's PF_Poi / PF_HelpPath) for the same reason
// trigger_fog's does: the opcode numbers and field layouts are re-release
// wire vocabulary the frozen v3 GameImports cannot name.
//
// POI_OBJECTIVE (g_local.h:946's `MAX_EDICTS`) is the WIDE layout's
// MAX_EDICTS, 8192 -- NOT the classic module's own MAX_EDICTS (1024). The
// key is a slot number in the client's POI table, and the client that
// receives it is running the wide layout by construction (this only ever
// emits on a wide session), so it has to be the number the kex module sends
// or the two modules would key the same marker differently.

/** g_local.h:946's `POI_OBJECTIVE = MAX_EDICTS`, with MAX_EDICTS being the
 *  wide layout's 8192 (shared/cs_remap.ts's MAX_EDICTS_WIDE). */
const POI_OBJECTIVE = 8192;

/** p_client.cpp:1780's colour byte -- a classic 8-bit palette index. */
const POI_COLOR = 208;

/** SvcPoiFlagsT.POI_FLAG_NONE (kexapi/game.ts:1466). Spelled locally so this
 *  module takes no dependency on the kex API surface, exactly as
 *  bindings/legacy.ts spells its own SVC_POI. */
const POI_FLAG_NONE = 0;

/**
 * p_client.cpp:1771-1782 -- `void P_SendLevelPOI(edict_t *ent)`.
 * [Paril-KEX] send player level POI.
 *
 * Byte-for-byte the same message src/kexgame/p_client.ts's P_SendLevelPOI
 * writes: key POI_OBJECTIVE, 10000 ms lifetime, the player's recorded POI
 * location, its image index, colour 208, no flags, reliable unicast.
 */
export function P_SendLevelPOI(ent: EdictT): void {
  const lvl = kexLevel();
  if (!lvl.valid_poi) return;
  if (ent.client === null) return;

  const kc = kexClient(ent);
  gi.poi?.(ent, POI_OBJECTIVE, 10000, kc.help_poi_location, kc.help_poi_image, POI_COLOR, POI_FLAG_NONE);
}

/**
 * g_items.cpp:1499-1541 -- `void Compass_Update(edict_t *ent, bool first)`.
 * Walks the player one breadcrumb further along the path Use_Compass asked
 * the nav mesh for, emitting one svc_help_path per step plus a refreshed
 * objective marker and the marker sound.
 *
 * WHAT FILLS `poi_points`: a successful nav-mesh query in Cmd_Compass_f
 * below, through the optional `gi.get_path_to_goal` import. Until that hook
 * and src/server/bindings/kex.ts's GetPathToGoal were wired to
 * src/server/nav.ts, `poi_points` was null for every client under BOTH
 * modules and this returned at the "deleted for some reason" guard, putting
 * no bytes on the wire from either. Both light up together now, and on a map
 * with no nav data (or with `sv_nav_legacy` off, the legacy family's default
 * -- see nav.ts's header) both go quiet together again.
 */
export function Compass_Update(ent: EdictT, first: boolean): void {
  if (ent.client === null) return;

  const kc = kexClient(ent);
  const points = kc.poi_points;

  // deleted for some reason
  if (points === null) return;

  if (!kc.help_draw_points) return;
  if (kc.help_draw_time >= level.time) return;

  const current = points[kc.help_draw_index];
  if (current === undefined) return;

  // don't draw too many points
  const delta = vec3();
  VectorSubtract(current, ent.s.origin, delta);
  if (VectorLength(delta) > 4096 || !gi.inPHS(ent.s.origin, current)) {
    kc.help_draw_points = false;
    return;
  }

  const dir = vec3();
  if (kc.help_draw_index === kc.help_draw_count - 1) {
    VectorSubtract(kc.help_poi_location, current, dir);
  } else {
    const next = points[kc.help_draw_index + 1];
    if (next === undefined) return;
    VectorSubtract(next, current, dir);
  }
  VectorNormalize(dir);

  gi.help_path?.(ent, first, current, dir);

  P_SendLevelPOI(ent);

  // g_items.cpp:1537's `gi.local_sound(...)`. The classic GameImports has no
  // local_sound (a KEX-only per-client sound with a dedupe key); the nearest
  // classic equivalent that reaches only this player is a positioned sound at
  // the marker, which is what the marker sound is for.
  gi.positioned_sound(current, ent, CHAN_AUTO, gi.soundindex("misc/help_marker.wav"), 1.0, ATTN_NORM, 0.0);

  // done
  if (kc.help_draw_index === kc.help_draw_count - 1) {
    kc.help_draw_points = false;
    return;
  }

  kc.help_draw_index++;
  kc.help_draw_time = level.time + 0.2;
}

/**
 * g_items.cpp:1546-1624 -- `static void Use_Compass(edict_t *ent, gitem_t *inv)`.
 *
 * The rerelease reaches this through the IT_COMPASS inventory item's use
 * function. The classic module has no compass item and no item slot to add
 * one to (the classic itemlist is a frozen, index-stable table the save
 * format depends on), so the same body is reached through a `compass` client
 * command instead -- see g_cmds.ts's ClientCommand. Same trigger for the
 * player (a bind), same effect.
 *
 * NAMED Cmd_Compass_f, not Use_Compass, on purpose: src/game/g_items.ts
 * already exports a DIFFERENT `Use_Compass` -- the rogue mission pack's
 * compass ITEM, which prints the player's origin and facing (rogue/g_items.c).
 * That one stays exactly as it is; this is the rerelease objective compass
 * and the two must not be confused for each other.
 *
 * The nav-mesh query behind the breadcrumb trail goes through the optional
 * `gi.get_path_to_goal` import (game.ts) -- the classic spelling of the
 * re-release's `gi.GetPathToGoal`, backed by the SAME src/server/nav.ts A*
 * the kex module reaches (src/server/bindings/legacy.ts's PF_GetPathToGoal).
 * With the hook absent, or with no nav data loaded for this map, the query
 * fails and this falls through to the C++'s own else-branch
 * (g_items.cpp:1617-1623): send the objective marker, play the marker sound,
 * no trail. That is exactly the behavior this function had before the hook
 * existed, so a map with no .nav file is unchanged.
 *
 * TWO SUBSTITUTIONS, both structural, neither changing the points produced:
 *
 *  - THE POINT BUFFER. The C++ lazily TagMallocs
 *    `vec3_t[MAX_TEMP_POI_POINTS + 1]` per player at TAG_LEVEL and hands
 *    `points + 1` straight to GetPathToGoal as the output pointer, so the
 *    engine writes into `points[1..]` and index 0 stays reserved for the
 *    "extra point in front of us" write near the end. There is no `+ 1`
 *    pointer view over a JS array, so this passes a fresh scratch array and
 *    copies into `points[1..]` afterward -- the same index-1-based layout.
 *    src/kexgame/g_items.ts's Use_Compass does the identical thing for the
 *    identical reason; the two produce the same buffer.
 *
 *  - THE FACING VECTOR. The re-release reads `client->v_forward`, a cached
 *    forward vector its gclient_t carries. The classic gclient_t has no such
 *    field, so the same vector is recomputed here with AngleVectors over
 *    `client.v_angle` -- which is precisely what the re-release's own
 *    ClientThink stores into v_forward each frame.
 */
export function Cmd_Compass_f(ent: EdictT): void {
  const lvl = kexLevel();

  if (!lvl.valid_poi) {
    gi.cprintf(ent, PRINT_HIGH, "No valid POI in this level.\n");
    return;
  }

  if (lvl.current_dynamic_poi !== null) {
    const dynamicPoi = lvl.current_dynamic_poi;
    if (dynamicPoi.use !== null) dynamicPoi.use(dynamicPoi, ent, ent);
  }

  const client = ent.client;
  if (client === null) return;

  const kc = kexClient(ent);
  VectorCopy(lvl.current_poi, kc.help_poi_location);
  kc.help_poi_image = lvl.current_poi_image;

  // g_items.cpp:1561-1566 -- lazily allocate this player's point buffer.
  let points = kc.poi_points;
  if (points === null) {
    points = Array.from({ length: MAX_TEMP_POI_POINTS + 1 }, () => vec3());
    kc.poi_points = points;
  }

  const query = gi.get_path_to_goal;
  const pathScratch: Vec3[] = query === undefined ? [] : Array.from({ length: MAX_TEMP_POI_POINTS }, () => vec3());

  const result =
    query === undefined
      ? null
      : query({
          ...compassPathQueryDefaults(),
          start: ent.s.origin,
          goal: lvl.current_poi,
          points: pathScratch,
          maxPoints: MAX_TEMP_POI_POINTS,
        });

  if (result !== null && result.found) {
    // g_items.cpp:1590 -- "TODO: optimize points?" (upstream's own note).
    for (let i = 0; i < pathScratch.length; i++) points[i + 1] = pathScratch[i]!;

    kc.help_draw_points = true;
    kc.help_draw_count = Math.min(result.numPathPoints, MAX_TEMP_POI_POINTS);
    kc.help_draw_index = 1;

    // g_items.cpp:1596-1602 -- remove points too close to the player so they
    // don't have to backtrack.
    for (let i = 1; i < 1 + kc.help_draw_count; i++) {
      const delta = vec3();
      VectorSubtract(points[i]!, ent.s.origin, delta);
      if (VectorLength(delta) > 192) break;
      kc.help_draw_index = i;
    }

    // g_items.cpp:1604-1615 -- create an extra point in front of us if we're
    // facing away from the first real point.
    const forward = vec3();
    AngleVectors(client.v_angle, forward, null, null);

    const toFirst = vec3();
    VectorSubtract(points[kc.help_draw_index]!, ent.s.origin, toFirst);
    VectorNormalize(toFirst);

    if (DotProduct(toFirst, forward) < 0.3) {
      const p = vec3();
      VectorMA(ent.s.origin, 64, forward, p);

      const traceStart = vec3();
      VectorCopy(ent.s.origin, traceStart);
      traceStart[2] += ent.viewheight;

      const tr = gi.trace(traceStart, null, null, p, null, MASK_SOLID);

      kc.help_draw_index--;
      kc.help_draw_count++;

      const endpos = vec3();
      VectorCopy(tr.endpos, endpos);
      if (tr.fraction < 1.0) {
        const off = vec3();
        VectorScale(tr.plane.normal, 8, off);
        VectorAdd(endpos, off, endpos);
      }

      points[kc.help_draw_index] = endpos;
    }

    kc.help_draw_time = 0;
    Compass_Update(ent, true);
    return;
  }

  // g_items.cpp:1617-1623 -- the "no path" branch.
  P_SendLevelPOI(ent);
  gi.sound(ent, CHAN_AUTO, gi.soundindex("misc/help_marker.wav"), 1.0, ATTN_NORM, 0.0);
}

// ===========================================================================
// target_music  (g_target.cpp:1809-1817 / src/kexgame/g_target.ts:1770-1778)
// ===========================================================================

/** g_target.cpp:1809-1812 -- `USE(use_target_music)`. */
function use_target_music(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  gi.configstring(CS_CDTRACK, `${self.sounds}`);
}

/**
 * g_target.cpp:1814-1817 -- `void SP_target_music(edict_t* self)`.
 *
 * QUAKED target_music (1 0 0) (-8 -8 -8) (8 8 8)
 * Switches the CD track when triggered.
 *
 * NO DEGRADATION: CS_CDTRACK is a vanilla configstring (shared/q_shared.ts:942)
 * present in CS_REMAP_OLD, and the classic client's music playback reads it.
 * This is one of the rerelease HUD/presentation family that survives intact.
 */
export function SP_target_music(self: EdictT): void {
  self.use = use_target_music;
}

// ===========================================================================
// target_healthbar  (g_target.cpp:1826-1896 / src/kexgame/g_target.ts:1782-1849)
// ===========================================================================

// bg_local.h:56-73's reserved general-configstring range, computed the same
// way src/kexgame/g_target.ts:262-273 computes it: CTF match + teaminfo +
// MAX_CLIENTS player names + 1 + the coop-respawn strings + n64 physics.
// Spelled against the CLASSIC CS_GENERAL; PF_LegacyConfigstring maps it onto
// the live layout (see use_target_healthbar).
/** src/kexgame/g_local.ts's CoopRespawnT.COOP_RESPAWN_TOTAL. */
const KEX_COOP_RESPAWN_TOTAL = 6;

const CONFIG_CTF_MATCH_INDEX = CS_GENERAL;
const CONFIG_CTF_TEAMINFO_INDEX = CONFIG_CTF_MATCH_INDEX + 1;
const CONFIG_CTF_PLAYER_NAME_INDEX = CONFIG_CTF_TEAMINFO_INDEX + 1;
const CONFIG_CTF_PLAYER_NAME_END_INDEX = CONFIG_CTF_PLAYER_NAME_INDEX + MAX_CLIENTS;
const CONFIG_COOP_RESPAWN_STRING_INDEX = CONFIG_CTF_PLAYER_NAME_END_INDEX + 1;
// bg_local.h:45's COOP_RESPAWN_TOTAL is 5 (src/kexgame/g_local.ts's
// CoopRespawnT: NONE, IN_COMBAT, BAD_AREA, BLOCKED, WAITING, NO_LIVES ->
// TOTAL). The classic module has no coop-respawn enum, so the count is
// spelled out with its source.
const CONFIG_COOP_RESPAWN_STRING_END_INDEX = CONFIG_COOP_RESPAWN_STRING_INDEX + (KEX_COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS_INDEX = CONFIG_COOP_RESPAWN_STRING_END_INDEX + 1;
/** bg_local.h:71 -- the boss health bar's label. */
const CONFIG_HEALTH_BAR_NAME_INDEX = CONFIG_N64_PHYSICS_INDEX + 1;

/**
 * g_target.cpp:1826-1853 -- `USE(use_target_healthbar)`.
 *
 * DEVIATION: the rerelease's "did my target get replaced?" sanity check
 * compares `ent->health` against `target->spawn_count`, a monotonically
 * increasing per-slot id the rerelease's G_Spawn stamps on every edict. The
 * classic EdictT has no spawn_count (reported as a wanted g_local.ts field).
 * The equivalent check here compares the EDICT IDENTITY recorded by
 * check_target_healthbar against the one G_PickTarget resolves now, which
 * catches the same failure -- the remembered monster died, was freed, and the
 * slot was reused -- because a freed edict loses its targetname and can no
 * longer be found by G_PickTarget.
 *
 * The rerelease publishes the bar's label into CONFIG_HEALTH_BAR_NAME_INDEX
 * (CS_GENERAL+266 in the extended layout) and its HUD reads that slot plus
 * the tracked monster's health to draw a boss bar. Both halves now exist for
 * the classic module too: p_hud.ts's G_SetHealthBarStat fills STAT_HEALTH_BARS
 * and the classic HUD layout grows a `health_bars` token (g_spawn.ts's
 * statusbar suffix, client/cgame/classic_hud.ts's token).
 *
 * DEGRADATION (protocol 34): the label write is GATED on the wide layout. On
 * a narrow session CS_REMAP_OLD's general block is the classic module's own
 * (CS_GENERAL+266 would collide with a classic general configstring) and
 * STAT_HEALTH_BARS cannot travel anyway, so the bar's registration,
 * validation, slot allocation and enemy tracking run server-side and nothing
 * is shown -- exactly as before.
 */
function use_target_healthbar(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const target = ent.target !== null ? G_PickTarget(ent.target) : null;

  if (target === null || ent.enemy !== target) {
    if (target !== null) {
      gi.dprintf(`${ent.classname ?? "?"}: target ${target.classname ?? "?"} changed from what it used to be\n`);
    } else gi.dprintf(`${ent.classname ?? "?"}: no target\n`);
    G_FreeEdict(ent);
    return;
  }

  const lvl = kexLevel();
  for (let i = 0; i < MAX_HEALTH_BARS; i++) {
    if (lvl.health_bar_entities[i] !== null && lvl.health_bar_entities[i] !== undefined) continue;

    ent.enemy = target;
    lvl.health_bar_entities[i] = ent;
    // g_target.cpp:1849's `gi.configstring(CONFIG_HEALTH_BAR_NAME_INDEX,
    // ent->message)`. The index is spelled against the CLASSIC CS_GENERAL
    // base on purpose: bindings/legacy.ts's PF_LegacyConfigstring translates
    // every legacy index onto the live layout, so CS_GENERAL+266 here lands
    // on the wide layout's CS_GENERAL+266 -- the exact slot the kex module's
    // CONFIG_HEALTH_BAR_NAME_INDEX names (both families share MAX_GENERAL,
    // shared/cs_remap.ts). Gated because on a narrow session that same
    // translation is the identity and the write would land in the classic
    // module's own general space.
    if (gi.extended_layout?.() === true) gi.configstring(CONFIG_HEALTH_BAR_NAME_INDEX, ent.message ?? "");
    return;
  }

  gi.dprintf(`${ent.classname ?? "?"}: too many health bars\n`);
  G_FreeEdict(ent);
}

/**
 * g_target.cpp:1855-1869 -- `THINK(check_target_healthbar)`.
 * The `ent->health = target->spawn_count` sanity stamp becomes the edict
 * identity stamp described on use_target_healthbar.
 */
function check_target_healthbar(ent: EdictT): void {
  const target = ent.target !== null ? G_PickTarget(ent.target) : null;
  if (target === null || (target.svflags & SVF_MONSTER) === 0) {
    if (target !== null) {
      gi.dprintf(`${ent.classname ?? "?"}: target ${target.classname ?? "?"} does not appear to be a monster\n`);
    }
    G_FreeEdict(ent);
    return;
  }

  // just for sanity check
  ent.enemy = target;
}

/**
 * g_target.cpp:1871-1896 -- `void SP_target_healthbar(edict_t *self)`.
 *
 * QUAKED target_healthbar (1 0 0) (-8 -8 -8) (8 8 8)
 * Boss health bar; "target" names the monster, "message" is the label.
 */
export function SP_target_healthbar(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  if (self.target === null || self.target === "") {
    gi.dprintf(`${self.classname ?? "?"}: missing target\n`);
    G_FreeEdict(self);
    return;
  }

  if (self.message === null) {
    gi.dprintf(`${self.classname ?? "?"}: missing message\n`);
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_healthbar;
  self.think = check_target_healthbar;
  // rerelease: Gtime_from_ms(25), a quarter of one classic server frame; the
  // classic clock's finest grain is FRAMETIME.
  self.nextthink = level.time + FRAMETIME;
}

// ===========================================================================
// target_autosave  (g_target.cpp:1903-1923 / src/kexgame/g_target.ts:1855-1869)
// ===========================================================================

/**
 * g_target.cpp:1903-1912 -- `USE(use_target_autosave)`.
 *
 * No degradation: gi.cvar and gi.AddCommandString are both classic imports and
 * the throttle arithmetic is a plain time comparison.
 * (`level.next_auto_save` has no classic LevelLocalsT field, so the throttle
 * lives in g_kexent.ts's kexLevel().)
 */
function use_target_autosave(_self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const cv = gi.cvar("g_athena_auto_save_min_time", "60", 0);
  const save_time = cv === null ? 60 : cv.value;

  const lvl = kexLevel();
  if (level.time - lvl.next_auto_save > save_time) {
    gi.AddCommandString("autosave\n");
    lvl.next_auto_save = level.time;
  }
}

/** g_target.cpp:1914-1923 -- `void SP_target_autosave(edict_t *self)`. */
export function SP_target_autosave(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_autosave;
}

// ===========================================================================
// target_sky  (g_target.cpp:1933-1978 / src/kexgame/g_target.ts:1888-1919)
// ===========================================================================

/**
 * g_target.cpp:1933-1956 -- `USE(use_target_sky)`.
 *
 * DEVIATION: the rerelease reads the current CS_SKYROTATE string back with
 * `gi.get_configstring` so a target_sky that sets only one of
 * rotate/autorotate preserves the other. The classic GameImports has no
 * configstring reader, so the last value written BY THIS MODULE is mirrored
 * in kexLevel().sky_rotate_mirror / sky_autorotate_mirror. Consequence,
 * spelled out in g_kexent.ts: a target_sky that sets ONLY skyautorotate emits
 * worldspawn's rotate speed as 0. Setting skyrotate (or both) is exact.
 *
 * NO OTHER DEGRADATION: CS_SKY, CS_SKYAXIS and CS_SKYROTATE are all vanilla
 * configstrings present in CS_REMAP_OLD, and the classic client honors all
 * three.
 */
function use_target_sky(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.map !== null) gi.configstring(CS_SKY, self.map);

  const lvl = kexLevel();

  if ((self.count & 3) !== 0) {
    let rotate = lvl.sky_rotate_mirror;
    let autorotate = lvl.sky_autorotate_mirror;

    if ((self.count & 1) !== 0) rotate = self.accel;
    if ((self.count & 2) !== 0) autorotate = self.style;

    lvl.sky_rotate_mirror = rotate;
    lvl.sky_autorotate_mirror = autorotate;
    gi.configstring(CS_SKYROTATE, `${rotate} ${autorotate}`);
  }

  if ((self.count & 4) !== 0) {
    gi.configstring(CS_SKYAXIS, `${self.movedir[0]} ${self.movedir[1]} ${self.movedir[2]}`);
  }
}

/**
 * g_target.cpp:1958-1978 -- `void SP_target_sky(edict_t *self)`.
 *
 * DEVIATION: the rerelease gates each of the four keys on
 * `st.keys_specified.contains(...)`, its parse-time record of which keys the
 * map actually wrote. The classic SpawnTempT has no such set, so each key is
 * gated on "did ED_ParseField leave a non-default value" instead. This differs
 * from the rerelease only for a map that explicitly writes a key's own default
 * (`skyrotate 0`, `skyautorotate 0`, `skyaxis "0 0 0"`, or an empty `sky`), in
 * which case the rerelease would republish that default and this port leaves
 * the existing configstring alone. No shipped map does that.
 */
export function SP_target_sky(self: EdictT): void {
  self.use = use_target_sky;
  if (st.sky !== null && st.sky !== "") self.map = st.sky;
  if ((st.skyaxis[0] ?? 0) !== 0 || (st.skyaxis[1] ?? 0) !== 0 || (st.skyaxis[2] ?? 0) !== 0) {
    self.count |= 4;
    VectorCopy(st.skyaxis, self.movedir);
  }
  if (st.skyrotate !== 0) {
    self.count |= 1;
    self.accel = st.skyrotate;
  }
  if (st.skyautorotate !== 0) {
    self.count |= 2;
    self.style = st.skyautorotate;
  }
}

// ===========================================================================
// target_crossunit_trigger / target_crossunit_target
// (g_target.cpp:1985-2032 / src/kexgame/g_target.ts:1918-1962)
//
// NOTE, preserved from the rerelease source: these two DO carry a deathmatch
// guard while the older target_crosslevel_* pair (already in the classic
// g_target.ts) does not. That asymmetry is in the C++ and is kept.
// ===========================================================================

/**
 * g_target.cpp:1985-1989 -- `USE(trigger_crossunit_trigger_use)`.
 *
 * `game.cross_unit_flags` is a real GameLocalsT field (added to
 * src/game/g_local.ts by the port coordinator, and serialized in g_save.ts
 * next to serverflags). It is DISTINCT from the classic `game.serverflags`,
 * which is the rerelease's `cross_level_flags` -- keeping them separate is
 * what stops the two families of cross-triggers aliasing each other.
 *
 * It has to live on GameLocalsT rather than in module state: the pair's
 * whole purpose is to carry a flag ACROSS a unit boundary, so the value
 * must survive both a level change and a save/load.
 */
function trigger_crossunit_trigger_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  game.cross_unit_flags |= self.spawnflags;
  G_FreeEdict(self);
}

/** g_target.cpp:1991-2001 -- `void SP_target_crossunit_trigger(edict_t *self)`. */
export function SP_target_crossunit_trigger(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.svflags = SVF_NOCLIENT;
  self.use = trigger_crossunit_trigger_use;
}

/** g_target.cpp:2009-2016 -- `THINK(target_crossunit_target_think)`. */
function target_crossunit_target_think(self: EdictT): void {
  if (self.spawnflags === (game.cross_unit_flags & SFL_CROSS_TRIGGER_MASK & self.spawnflags)) {
    G_UseTargets(self, self);
    G_FreeEdict(self);
  }
}

/** g_target.cpp:2018-2032 -- `void SP_target_crossunit_target(edict_t *self)`. */
export function SP_target_crossunit_target(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  if (self.delay === 0) self.delay = 1;
  self.svflags = SVF_NOCLIENT;

  self.think = target_crossunit_target_think;
  self.nextthink = level.time + self.delay;
}

// ===========================================================================
// target_achievement  (g_target.cpp:2039-2056 / src/kexgame/g_target.ts:1966-1977)
// ===========================================================================

/**
 * g_target.cpp:2039-2044 -- `USE(use_target_achievement)`.
 *
 * DEGRADATION (protocol 34): the rerelease writes an `svc_achievement`
 * server command carrying the achievement id and multicasts it to everyone.
 * Protocol 34's server-command set (src/qcommon/qcommon.ts) has no
 * svc_achievement, and neither the classic client nor the classic module's
 * `svc_*` list declares one -- writing an unknown command byte into the
 * message stream would desync every connected client's parser. So NOTHING IS
 * SENT. The achievement id is still resolved and stored on the entity, and the
 * entity's own targeting/killtarget wiring still fires.
 */
function use_target_achievement(_self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  // The rerelease body is exactly three calls:
  //   gi.WriteByte(svc_achievement);
  //   gi.WriteString(self->map);          // the achievement id, from st.achievement
  //   gi.multicast(vec3_origin, MULTICAST_ALL, true);
  // Protocol 34 has no svc_achievement, so none of them is issued -- see this
  // function's degradation note. The id stays on `self.map`.
}

/** g_target.cpp:2046-2056 -- `void SP_target_achievement(edict_t *self)`. */
export function SP_target_achievement(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.map = st.achievement;
  self.use = use_target_achievement;
}

// ===========================================================================
// target_story  (g_target.cpp:2058-2077 / src/kexgame/g_target.ts:1981-1994)
// ===========================================================================

/**
 * g_target.cpp:2058-2066 -- `USE(use_target_story)`.
 *
 * DEGRADATION (protocol 34): the rerelease publishes the story text into
 * CONFIG_STORY_INDEX (its own configstring slot in the extended layout,
 * CS_GENERAL+267) and its client HUD renders it as the between-mission story
 * card. CS_REMAP_OLD has no such slot and the classic HUD program has no story
 * element, so THE CONFIGSTRING WRITE IS SKIPPED -- writing into raw CS_GENERAL
 * space under the classic layout would collide with the classic module's own
 * general configstrings. The `story_active` flag is set exactly as the
 * rerelease sets it (in g_kexent.ts's kexLevel(), since the classic
 * LevelLocalsT has no such field), so the entity's state is queryable and its
 * targeting still works; the text is never shown.
 */
function use_target_story(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  kexLevel().story_active = self.message !== null && self.message !== "";
  // gi.configstring(CONFIG_STORY_INDEX, self.message ?? "") -- no classic
  // configstring slot; see this function's degradation note.
}

/** g_target.cpp:2068-2077 -- `void SP_target_story(edict_t *self)`. */
export function SP_target_story(self: EdictT): void {
  if (kexDeathmatch()) {
    G_FreeEdict(self);
    return;
  }

  self.use = use_target_story;
}

// ---------------------------------------------------------------------------
// Savegame function registry (same idiom as the tail of m_soldier.ts)
// ---------------------------------------------------------------------------

registerSaveFunction("g_kextarg:target_camera_dummy_think", target_camera_dummy_think);
registerSaveFunction("g_kextarg:update_target_camera", update_target_camera);
registerSaveFunction("g_kextarg:use_target_camera", use_target_camera);
registerSaveFunction("g_kextarg:use_target_gravity", use_target_gravity);
registerSaveFunction("g_kextarg:update_target_soundfx", update_target_soundfx);
registerSaveFunction("g_kextarg:use_target_soundfx", use_target_soundfx);
registerSaveFunction("g_kextarg:target_light_flicker_think", target_light_flicker_think);
registerSaveFunction("g_kextarg:target_light_think", target_light_think);
registerSaveFunction("g_kextarg:target_light_use", target_light_use);
registerSaveFunction("g_kextarg:target_poi_use", target_poi_use);
registerSaveFunction("g_kextarg:target_poi_setup", target_poi_setup);
registerSaveFunction("g_kextarg:use_target_music", use_target_music);
registerSaveFunction("g_kextarg:use_target_healthbar", use_target_healthbar);
registerSaveFunction("g_kextarg:check_target_healthbar", check_target_healthbar);
registerSaveFunction("g_kextarg:use_target_autosave", use_target_autosave);
registerSaveFunction("g_kextarg:use_target_sky", use_target_sky);
registerSaveFunction("g_kextarg:trigger_crossunit_trigger_use", trigger_crossunit_trigger_use);
registerSaveFunction("g_kextarg:target_crossunit_target_think", target_crossunit_target_think);
registerSaveFunction("g_kextarg:use_target_achievement", use_target_achievement);
registerSaveFunction("g_kextarg:use_target_story", use_target_story);
