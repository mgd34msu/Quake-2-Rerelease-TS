// g_kexmisc.ts -- the misc/light/animation world entities that exist ONLY in
// the 2023 re-release game DLL, translated into the classic (3.21) module.
//
// Source of every line here: src/kexgame/g_misc.ts (this repo's port of
// quake2-rerelease-dll/rerelease/g_misc.cpp). Each spawn function carries the
// g_misc.cpp line reference that src/kexgame/g_misc.ts itself records.
//
// Classnames landed in this file:
//   misc_flare, misc_model, dynamic_light, info_landmark, misc_hologram,
//   misc_lavaball, func_animation, info_world_text, misc_player_mannequin
//
// TRANSLATION NOTES (apply throughout):
//   * kexgame wraps every callback in RegisterUse/RegisterThink/RegisterTouch;
//     the classic module uses a plain function plus a registerSaveFunction()
//     call at the tail of the file (see m_soldier.ts).
//   * kexgame's level.time is a millisecond GTime; the classic level.time is a
//     float in SECONDS and FRAMETIME (0.1) is one server frame. kexgame's
//     `Gtime_from_hz(10)` / `Gtime_from_ms(100)` / `frameTimeAsGtime()` all
//     become FRAMETIME here. Where a rerelease think ran at the KEX 100 Hz
//     server rate, the per-second rate is preserved by scaling the per-tick
//     delta by FRAMETIME instead (see misc_hologram_think).
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `SvflagsT.SVF_NOCLIENT` -> `SVF_NOCLIENT`; `gi.Com_Print` -> `gi.dprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * s.alpha / s.scale are stored but never transmitted -- the classic delta
//    (src/qcommon/sizebuf.ts's MSG_WriteDeltaEntity) has no field for either,
//    so a rerelease entity authored translucent or scaled renders opaque and
//    full-size. Affects misc_flare, misc_hologram, misc_player_mannequin.
//  * misc_flare must NOT set `s.modelindex = 1`. See SP_misc_flare.
//  * dynamic_light's shadow-light data is stored but neither the
//    CS_SHADOWLIGHTS configstring block nor RF_CASTSHADOW is usable under
//    protocol 34. See SP_dynamic_light. -- NO LONGER UNCONDITIONAL: a
//    session on the WIDE layout has both, and setup_dynamic_light now takes
//    that path when gi.extended_layout() says so. The protocol-34 behavior
//    below is unchanged for a session that stays narrow.
//  * misc_hologram sets EF_HOLOGRAM (as morefx bit 1) only on a wide
//    session. See SP_misc_hologram.
//  * info_world_text has no draw call. See info_world_text_think.

import { anglemod, crandom, VectorCopy, VectorNormalize, VectorScale, VectorSet, vec3, type Vec3 } from "../shared/math";
import {
  CONTENTS_LAVA,
  CS_PLAYERSKINS,
  EF_GIB,
  EF_ROCKET,
  MASK_SHOT,
  MAX_CLIENTS,
  RF_CASTSHADOW,
  RF_CUSTOMSKIN,
  RF_FLARE,
  RF_FLARE_LOCK_ANGLE,
  RF_MINLIGHT,
  RF_SHELL_BLUE,
  RF_SHELL_GREEN,
  RF_SHELL_RED,
  YAW,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import type { CplaneT, CsurfaceT } from "../shared/q_shared";
import {
  AI_TARGET_ANGER,
  type EdictT,
  FRAMETIME,
  g_edicts,
  gi,
  level,
  MOD_EXPLOSIVE,
  MovetypeT,
  st,
} from "./g_local";
import { kexEdictFmt, kexFrandom, kexRandomTimeSec } from "./g_kexent";
import { BecomeExplosion1 } from "./g_misc";
import { G_Find, G_FreeEdict, G_PickTarget, G_Spawn, vectoyaw } from "./g_utils";
import { M_ChangeYaw } from "./m_move";
import {
  FRAME_flip01,
  FRAME_flip12,
  FRAME_point01,
  FRAME_point12,
  FRAME_salute01,
  FRAME_salute11,
  FRAME_stand01,
  FRAME_stand40,
  FRAME_taunt01,
  FRAME_taunt17,
  FRAME_wave01,
  FRAME_wave11,
} from "./m_player_frames";
import { T_Damage } from "./g_combat";

// ===========================================================================
// dynamic_light  (g_misc.cpp:642-668 / src/kexgame/g_misc.ts:947-981)
// ===========================================================================

/** rerelease g_misc.cpp:571 -- `SPAWNFLAG_LIGHT_START_OFF`. */
const SPAWNFLAG_LIGHT_START_OFF = 1;

/**
 * g_misc.cpp:601-624 -- `setup_dynamic_light`.
 *
 * The rerelease copies the eight parsed `shadowlight*` keys into a global
 * shadowlightinfo[] table, stamps RF_CASTSHADOW on the entity so the server's
 * "has effects" test keeps it in the client's frame, and later publishes one
 * CS_SHADOWLIGHTS configstring per light for the client's CL_AddShadowLights.
 *
 * WHICH HALF RUNS DEPENDS ON THE SESSION LAYOUT, NOT ON THE MODULE.
 *
 * WIDE layout (gi.extended_layout() true -- either the kex family, or a
 * classic session the engine widened because this very map's entity lump
 * asked for it; see sv_init.ts's SV_ContentNeedsWideLayout, which lists
 * `dynamic_light` as one of its triggers): the full rerelease path runs.
 * RF_CASTSHADOW is stamped, the eight parsed `shadowlight*` keys are copied
 * into shadowlightinfo[] below, and setup_shadow_lights publishes one
 * CS_SHADOWLIGHTS string per light once every entity has spawned. That is
 * what feeds cl_fx.ts's CL_AddShadowLights and the GL shadow pass.
 *
 * NARROW layout (a 1997-data classic session) -- BOTH halves are unavailable:
 *   * The classic configstring layout is shared/cs_remap.ts's CS_REMAP_OLD,
 *     whose `shadowlights` index is the -1 sentinel and whose
 *     `max_shadowlights` is 0: there is no configstring block to write to,
 *     and the client-side consumer (cl_fx.ts's CL_AddShadowLights) only ever
 *     reads that block.
 *   * Stamping RF_CASTSHADOW would push a MODELINDEX-0 entity into every
 *     client frame (sv_ents.ts:344 keeps any RF_CASTSHADOW entity regardless
 *     of model/effects/sound/event) for no benefit, since nothing downstream
 *     can consume it without the configstring half.
 *
 * So on the narrow layout the one piece of shadow-light data that lives ON
 * THE EDICT in the rerelease -- `itemtarget`, the name of the entity whose
 * `style` drives this light -- is still recorded, the bbox is still zeroed,
 * the entity is still linked, and its targetname/use toggle still works.
 * Nothing is stamped into renderfx and no configstring is published, so
 * nothing renders, exactly as before.
 */
function setup_dynamic_light(self: EdictT): void {
  // [Sam-KEX] Shadow stuff
  if (st.shadowlightradius > 0) {
    // g_misc.cpp:604-605: `self->s.renderfx = RF_CASTSHADOW;` and
    // `self->itemtarget = st.sl.lightstyletarget;`.
    self.itemtarget = st.shadowlightstyletarget;

    if (gi.extended_layout?.() === true && shadow_light_count < MAX_SHADOW_LIGHTS) {
      self.s.renderfx = RF_CASTSHADOW;
      const info = shadowlightinfo[shadow_light_count];
      if (info !== undefined) {
        info.entity_number = self.s.number;
        // g_misc.cpp:606-615 -- the parsed keys, with the rerelease's own
        // defaults for the two the classic `st` leaves at 0 when the map
        // omits them (resolution 512, intensity 1). fade_start/fade_end come
        // from shadowlightstartfadedistance/shadowlightendfadedistance.
        info.radius = st.shadowlightradius;
        info.resolution = st.shadowlightresolution > 0 ? st.shadowlightresolution : 512;
        info.intensity = st.shadowlightintensity > 0 ? st.shadowlightintensity : 1;
        info.fade_start = st.shadowlightstartfadedistance;
        info.fade_end = st.shadowlightendfadedistance;
        info.lightstyle = st.shadowlightstyle;
        info.coneangle = st.shadowlightconeangle > 0 ? st.shadowlightconeangle : 45;
        info.lighttype = SHADOW_LIGHT_POINT;
        VectorSet(info.conedirection, 0, 0, 0);
        shadow_light_count++;
      }
    }

    // g_misc.cpp:616-619
    VectorSet(self.mins, 0, 0, 0);
    VectorSet(self.maxs, 0, 0, 0);

    gi.linkentity(self);
  }
}

// ---------------------------------------------------------------------------
// [Sam-KEX] shadow light tracking (g_misc.cpp:507-622), translated for the
// classic module. src/kexgame/g_misc.ts keeps the identical table on
// level.shadow_light_count; the classic LevelLocalsT is the frozen 3.21
// struct and gains no field for it, so the count lives module-local here and
// is reset by G_ResetShadowLights at the top of every SpawnEntities.
//
// Only ever populated on the wide layout (setup_dynamic_light's gate), so a
// narrow session leaves this untouched and setup_shadow_lights below is a
// zero-iteration loop.
// ---------------------------------------------------------------------------

/** kexapi/game.ts's MAX_SHADOW_LIGHTS / cs_remap.ts's MAX_SHADOW_LIGHTS_WIDE. */
const MAX_SHADOW_LIGHTS = 256;
/** shadow_light_type_t: point = 0, cone = 1 (kexapi/game.ts). */
const SHADOW_LIGHT_POINT = 0;
const SHADOW_LIGHT_CONE = 1;

interface ShadowLightInfoT {
  entity_number: number;
  lighttype: number;
  radius: number;
  resolution: number;
  intensity: number;
  fade_start: number;
  fade_end: number;
  lightstyle: number;
  coneangle: number;
  conedirection: Vec3;
}

const shadowlightinfo: ShadowLightInfoT[] = Array.from({ length: MAX_SHADOW_LIGHTS }, () => ({
  entity_number: 0,
  lighttype: SHADOW_LIGHT_POINT,
  radius: 0,
  resolution: 512,
  intensity: 1,
  fade_start: 0,
  fade_end: 0,
  lightstyle: 0,
  coneangle: 45,
  conedirection: vec3(),
}));

let shadow_light_count = 0;

/** Called by g_spawn.ts's SpawnEntities before it parses a new level. */
export function G_ResetShadowLights(): void {
  shadow_light_count = 0;
}

/*
 * g_misc.cpp's `setup_shadow_lights` (src/kexgame/g_misc.ts:882-917), called
 * from SpawnEntities once every entity exists -- the cone direction and the
 * driving lightstyle are both resolved by TARGETNAME, so neither can be
 * known while the light itself is spawning.
 *
 * The published string is the same 12 semicolon-separated fields the kex
 * module writes and the same ones cl_fx.ts's CL_ParseShadowLightConfigstring
 * reads back (it drops anything that is not exactly 12 fields), so a widened
 * classic session and a kex session put byte-identical data on the wire for
 * the same map.
 *
 * gi.shadowlight is the engine's slot-addressed publisher: CS_SHADOWLIGHTS
 * has no index in the frozen v3 CS_* constants, so it cannot go through
 * gi.configstring (see game.ts's GameImports comment). On a narrow session
 * this loop never runs at all.
 */
export function setup_shadow_lights(): void {
  for (let i = 0; i < shadow_light_count; i++) {
    const info = shadowlightinfo[i];
    if (info === undefined) continue;
    const self = g_edicts[info.entity_number];
    if (self === undefined) continue;

    info.lighttype = SHADOW_LIGHT_POINT;
    VectorSet(info.conedirection, 0, 0, 0);

    if (self.target !== null) {
      const target = G_Find(null, "targetname", self.target);
      if (target !== null) {
        const dir = vec3(
          (target.s.origin[0] ?? 0) - (self.s.origin[0] ?? 0),
          (target.s.origin[1] ?? 0) - (self.s.origin[1] ?? 0),
          (target.s.origin[2] ?? 0) - (self.s.origin[2] ?? 0),
        );
        VectorNormalize(dir);
        VectorCopy(dir, info.conedirection);
        info.lighttype = SHADOW_LIGHT_CONE;
      }
    }

    if (self.itemtarget !== null) {
      const target = G_Find(null, "targetname", self.itemtarget);
      if (target !== null) info.lightstyle = target.style;
    }

    gi.shadowlight?.(
      i,
      `${self.s.number};${info.lighttype};${info.radius};${info.resolution};` +
        `${info.intensity};${info.fade_start};${info.fade_end};` +
        `${info.lightstyle};${info.coneangle};${info.conedirection[0]};` +
        `${info.conedirection[1]};${info.conedirection[2]}`,
    );
  }
}

/** g_misc.cpp:626-629 -- `USE(dynamic_light_use)`. */
function dynamic_light_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.svflags ^= SVF_NOCLIENT;
}

/**
 * g_misc.cpp:642-654 -- `void SP_dynamic_light(edict_t *self)`.
 *
 * QUAKED dynamic_light (0 1 0) (-8 -8 -8) (8 8 8) START_OFF
 */
export function SP_dynamic_light(self: EdictT): void {
  setup_dynamic_light(self);

  if (self.targetname !== null) {
    self.use = dynamic_light_use;
  }

  if (self.spawnflags & SPAWNFLAG_LIGHT_START_OFF) self.svflags ^= SVF_NOCLIENT;
}

// ===========================================================================
// func_animation  (g_misc.cpp:812-836 / src/kexgame/g_misc.ts:1080-1109)
// ===========================================================================

/** g_misc.cpp:806 -- `SPAWNFLAG_ANIMATION_START_ON`. */
const SPAWNFLAG_ANIMATION_START_ON = 1;

/** g_misc.cpp:808-811 -- `USE(func_animation_use)`. */
function func_animation_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.bmodel_anim.alternate = !self.bmodel_anim.alternate;
}

/**
 * g_misc.cpp:812-836 -- `void SP_func_animation(edict_t *self)`.
 *
 * QUAKED func_animation (0 .5 .8) ? START_ON
 * Similar to func_wall, but triggering it toggles animation state rather
 * than going on/off.
 *
 * This one DOES fully present under protocol 34: the bmodel animation drives
 * `s.frame` on a brush model, and s.frame is part of the baseline entity
 * state every protocol carries. (The per-frame advance itself lives in the
 * engine-side bmodel_anim runner, not here -- SP_func_animation only picks
 * the starting frame and wires the toggle, exactly as the rerelease does.)
 */
export function SP_func_animation(self: EdictT): void {
  if (!self.bmodel_anim.enabled) {
    gi.dprintf(`${kexEdictFmt(self)} has no animation data\n`);
    G_FreeEdict(self);
    return;
  }

  self.movetype = MovetypeT.MOVETYPE_PUSH;
  if (self.model !== null) gi.setmodel(self, self.model);
  self.solid = SolidT.SOLID_BSP;

  self.use = func_animation_use;
  self.bmodel_anim.alternate = (self.spawnflags & SPAWNFLAG_ANIMATION_START_ON) !== 0;

  if (self.bmodel_anim.alternate) self.s.frame = self.bmodel_anim.alt_start;
  else self.s.frame = self.bmodel_anim.start;

  gi.linkentity(self);
}

// ===========================================================================
// misc_flare  (g_misc.cpp:2136-2172 / src/kexgame/g_misc.ts:2222-2259)
// ===========================================================================

/** g_misc.cpp:2126-2129 -- misc_flare spawnflags. */
const SPAWNFLAG_FLARE_RED = 1;
const SPAWNFLAG_FLARE_GREEN = 2;
const SPAWNFLAG_FLARE_BLUE = 4;
const SPAWNFLAG_FLARE_LOCK_ANGLE = 8;

/** g_misc.cpp:2131-2134 -- `USE(misc_flare_use)`. */
function misc_flare_use(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.svflags ^= SVF_NOCLIENT;
  gi.linkentity(ent);
}

/**
 * g_misc.cpp:2136-2172 -- `void SP_misc_flare(edict_t *ent)`.
 *
 * QUAKED misc_flare (1.0 1.0 0.0) (-32 -32 -32) (32 32 32) RED GREEN BLUE LOCK_ANGLE
 * Creates a flare seen in the N64 version.
 *
 * DEGRADATION (protocol 34), TWO SEPARATE ONES:
 *
 * 1. THE FLARE DOES NOT RENDER. The client's flare path
 *    (src/client/cl_ents.ts:677, `if (renderfx & RF_FLARE)`) sits inside
 *    `if (cls.csr.extended)`. `cls.csr` is CS_REMAP_OLD for the classic
 *    family (`extended: false`, shared/cs_remap.ts:83), so the branch is
 *    never entered and none of the flare state -- renderfx, the packed tint
 *    in s.skinnum, the fade distances in modelindex2/modelindex3, the
 *    RF_CUSTOMSKIN image index in s.frame -- is ever consumed.
 *
 * 2. DELIBERATE DEVIATION: `self.s.modelindex = 1` (g_misc.cpp:2137) is NOT
 *    set. In the rerelease that 1 exists only to survive the server's
 *    "entity has a model" visibility test, and the client consumes the entity
 *    in the RF_FLARE branch above BEFORE the model lookup. With that branch
 *    skipped, modelindex 1 resolves to cl.model_draw[1] -- the WORLD MODEL --
 *    and handing that to the renderer re-queues every world surface onto the
 *    translucent chain, turning it into a cycle that hangs
 *    R_DrawAlphaSurfaces (documented at src/client/cl_ents.ts:666-676).
 *    Leaving modelindex at 0 means the flare has no model, no effects, no
 *    sound and no event, so sv_ents.ts:344 culls it from every frame: the
 *    entity exists, links, and honors its targetname/use toggle server-side,
 *    and nothing at all is drawn. That is strictly better than a hang.
 *
 * BOTH ARE LIFTED ON A WIDE SESSION, and that is exactly the "no further work
 * beyond restoring the modelindex" this note used to predict. When
 * gi.extended_layout() is true the client HAS the RF_FLARE branch (cls.csr.
 * extended is set), that branch intercepts the entity BEFORE the model lookup
 * and never hands modelindex 1 to the renderer, and
 * test/cl_ents_flare.test.ts pins precisely that interception. So the
 * rerelease's `s.modelindex = 1` is restored, which is what gets the entity
 * past sv_ents.ts:344's "has a model" cull and onto the wire at all --
 * without it the wide session would carry the flare's renderfx, tint, fade
 * distances and scale correctly and still draw nothing, because the server
 * would never send the entity. Narrow sessions keep modelindex 0 and behave
 * exactly as before.
 */
export function SP_misc_flare(ent: EdictT): void {
  // g_misc.cpp:2137 -- `ent->s.modelindex = 1;`. Set only on a wide session,
  // where the client's RF_FLARE branch consumes the entity before the model
  // lookup; omitted on a narrow one, where it would resolve to the world
  // model. See degradation note 2 above.
  if (gi.extended_layout?.() === true) ent.s.modelindex = 1;
  ent.s.renderfx = RF_FLARE;
  ent.solid = SolidT.SOLID_NOT;
  // s.scale is stored but not transmitted by protocol 34's delta.
  ent.s.scale = st.radius;

  if (ent.spawnflags & SPAWNFLAG_FLARE_RED) ent.s.renderfx |= RF_SHELL_RED;
  if (ent.spawnflags & SPAWNFLAG_FLARE_GREEN) ent.s.renderfx |= RF_SHELL_GREEN;
  if (ent.spawnflags & SPAWNFLAG_FLARE_BLUE) ent.s.renderfx |= RF_SHELL_BLUE;
  if (ent.spawnflags & SPAWNFLAG_FLARE_LOCK_ANGLE) ent.s.renderfx |= RF_FLARE_LOCK_ANGLE;

  if (st.image !== null && st.image !== "") {
    ent.s.renderfx |= RF_CUSTOMSKIN;
    ent.s.frame = gi.imageindex(st.image);
  }

  VectorSet(ent.mins, -32, -32, -32);
  VectorSet(ent.maxs, 32, 32, 32);

  ent.s.modelindex2 = st.fade_start_dist;
  ent.s.modelindex3 = st.fade_end_dist;

  if (ent.targetname !== null) ent.use = misc_flare_use;

  gi.linkentity(ent);
}

// ===========================================================================
// misc_hologram  (g_misc.cpp:2176-2189 / src/kexgame/g_misc.ts:2262-2280)
// ===========================================================================

/**
 * g_misc.cpp:2174-2178 -- `THINK(misc_hologram_think)`.
 *
 * The rerelease runs this every server tick at its 100 Hz rate:
 * `ent->s.angles[1] += 100 * gi.frame_time_s` with frame_time_s = 0.01, i.e.
 * 100 degrees per SECOND. The classic server ticks at 10 Hz, so the same
 * expression with FRAMETIME (0.1) yields 10 degrees per tick -- identical
 * angular velocity, one tenth the sample rate.
 */
/**
 * EF_HOLOGRAM (kexapi/game.ts:634, `bitBig(33)`) in this port's split effects
 * field: bit 33 of the rerelease uint64 is bit 1 of EntityStateT.morefx.
 * Spelled here rather than imported from kexapi so the classic module takes
 * no dependency on the kex API surface -- the same convention this file
 * already uses for its other rerelease-only constants.
 */
const MOREFX_HOLOGRAM = 1 << 1;

function misc_hologram_think(ent: EdictT): void {
  ent.s.angles[YAW] = (ent.s.angles[YAW] ?? 0) + 100 * FRAMETIME;
  ent.nextthink = level.time + FRAMETIME;
  // s.alpha is stored but not transmitted by protocol 34's delta -- the
  // hologram's flicker is computed server-side and never seen.
  ent.s.alpha = kexFrandom(0.2, 0.6);
}

/**
 * g_misc.cpp:2180-2189 -- `void SP_misc_hologram(edict_t *ent)`.
 *
 * QUAKED misc_hologram (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
 * Ship hologram seen in the N64 version.
 *
 * EF_HOLOGRAM: `ent->s.effects = EF_HOLOGRAM` (g_misc.cpp:2185) IS set, on a
 * wide session. The rerelease's EF_HOLOGRAM is bit 33 of a 64-bit effects
 * field (src/kexapi/game.ts:634, `bitBig(33)`); this port splits that field
 * into EntityStateT's 32-bit `effects` (the legacy contract, untouched) and
 * `morefx` (the high half, q_shared.ts's own DESIGN DEVIATION note), so bit
 * 33 is bit 1 of morefx -- a field the classic entity_state_t already
 * declares. It travels in the protocol 1038/4038 delta
 * (qcommon/protocol/q2repro.ts's U_MOREFX8/HI_MOREFX16) and the client
 * consumes it in cl_ents.ts's CL_AddPacketEntities, which calls
 * cl_newfx.ts's CL_HologramParticles exactly where q2repro's
 * entities.c:1065 does.
 *
 * DEGRADATION (protocol 34):
 *  * The write is GATED on gi.extended_layout(). Protocol 34's delta has no
 *    morefx field at all (vanilla.ts writes `effects` and nothing else), so
 *    on a narrow session the bit could not reach a client; leaving it unset
 *    there keeps the classic wire provably byte-identical.
 *  * s.alpha and s.scale are likewise only transmitted on a wide session, so
 *    on protocol 34 the flicker and the 0.75 downscale do not present and the
 *    hologram renders as an ordinary opaque strogg1 model.
 *
 * The model, the position, and the 100 deg/sec spin work under both.
 */
export function SP_misc_hologram(ent: EdictT): void {
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/strogg1/tris.md2");
  VectorSet(ent.mins, -16, -16, 0);
  VectorSet(ent.maxs, 16, 16, 32);
  // g_misc.cpp:2185 -- `ent->s.effects = EF_HOLOGRAM;`. See the degradation
  // note above for why this is the morefx half and why it is gated.
  if (gi.extended_layout?.() === true) ent.s.morefx |= MOREFX_HOLOGRAM;
  ent.think = misc_hologram_think;
  ent.nextthink = level.time + FRAMETIME;
  ent.s.alpha = kexFrandom(0.2, 0.6);
  ent.s.scale = 0.75;
  gi.linkentity(ent);
}

// ===========================================================================
// misc_lavaball  (g_misc.cpp:2191-2239 / src/kexgame/g_misc.ts:2283-2330)
// ===========================================================================

/** g_misc.cpp:2194 -- `SPAWNFLAG_LAVABALL_NO_EXPLODE`. */
const SPAWNFLAG_LAVABALL_NO_EXPLODE = 1;

/**
 * g_misc.cpp:2196-2211 -- `TOUCH(fire_touch)`.
 *
 * The rerelease TouchFn is `(self, other, tr, otherTouchingSelf)`; the classic
 * touch signature is `(self, other, plane, surf)`. Neither the trace nor the
 * "other touching self" flag is read here, so the translation is exact.
 */
function fire_touch(self: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  if (self.spawnflags & SPAWNFLAG_LAVABALL_NO_EXPLODE) {
    G_FreeEdict(self);
    return;
  }

  if (other.takedamage) {
    // vec3_origin for dir, self.s.origin for point, vec3_origin for normal.
    const zero = vec3();
    T_Damage(other, self, self, zero, self.s.origin, zero, 20, 0, 0, MOD_EXPLOSIVE);
  }

  if ((gi.pointcontents(self.s.origin) & CONTENTS_LAVA) !== 0) G_FreeEdict(self);
  else BecomeExplosion1(self);
}

/** g_misc.cpp:2213-2233 -- `THINK(fire_fly)`. */
function fire_fly(self: EdictT): void {
  const fireball = G_Spawn();
  // EF_FIREBALL (src/kexapi/game.ts:642) is `EF_ROCKET | EF_GIB` -- both exist
  // in the classic effects set, so this one presents in full.
  fireball.s.effects = EF_ROCKET | EF_GIB;
  fireball.s.renderfx = RF_MINLIGHT;
  fireball.solid = SolidT.SOLID_BBOX;
  fireball.movetype = MovetypeT.MOVETYPE_TOSS;
  fireball.clipmask = MASK_SHOT;
  VectorSet(
    fireball.velocity,
    crandom() * 50,
    crandom() * 50,
    self.speed * 1.75 + Math.random() * 200,
  );
  VectorSet(fireball.avelocity, crandom() * 360, crandom() * 360, crandom() * 360);
  fireball.classname = "fireball";
  gi.setmodel(fireball, "models/objects/gibs/sm_meat/tris.md2");
  VectorCopy(self.s.origin, fireball.s.origin);
  fireball.nextthink = level.time + 5;
  fireball.think = G_FreeEdict;
  fireball.touch = fire_touch;
  fireball.spawnflags = self.spawnflags;
  gi.linkentity(fireball);
  self.nextthink = level.time + kexRandomTimeSec(5);
}

/**
 * g_misc.cpp:2235-2239 -- `void SP_misc_lavaball(edict_t *self)`.
 *
 * QUAKED misc_fireball (0 .5 .8) (-8 -8 -8) (8 8 8) NO_EXPLODE
 * Lava Balls. Shamelessly copied from Quake 1, like N64 guys probably did too.
 *
 * No degradation: everything this entity emits (models, EF_ROCKET|EF_GIB
 * trails, RF_MINLIGHT, MOVETYPE_TOSS physics, T_Damage) is classic.
 */
export function SP_misc_lavaball(self: EdictT): void {
  self.classname = "fireball";
  self.nextthink = level.time + kexRandomTimeSec(5);
  self.think = fire_fly;
  if (self.speed === 0) self.speed = 185;
}

// ===========================================================================
// info_landmark  (g_misc.cpp:2241-2245 / src/kexgame/g_misc.ts:2333-2336)
// ===========================================================================

/**
 * g_misc.cpp:2241-2245 -- `void SP_info_landmark(edict_t *self)`.
 *
 * A pure marker: the rerelease's cross-level landmark transition reads
 * absmin/absmax off it. Nothing renders and nothing is transmitted, in the
 * rerelease either -- so there is no degradation.
 */
export function SP_info_landmark(self: EdictT): void {
  VectorCopy(self.s.origin, self.absmin);
  VectorCopy(self.s.origin, self.absmax);
}

// ===========================================================================
// info_world_text  (g_misc.cpp:2247-2340 / src/kexgame/g_misc.ts:2338-2429)
// ===========================================================================

/** g_misc.cpp:2247-2249 -- info_world_text spawnflags. */
const SPAWNFLAG_WORLD_TEXT_START_OFF = 1;
const SPAWNFLAG_WORLD_TEXT_TRIGGER_ONCE = 2;
const SPAWNFLAG_WORLD_TEXT_REMOVE_ON_TRIGGER = 4;

/** g_misc.cpp:2251-2274 -- `USE(info_world_text_use)`. */
function info_world_text_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (self.activator === null) {
    self.activator = activator;
    if (self.think === null) {
      throw new Error("info_world_text_use: self.think is null (invariant violated)");
    }
    self.think(self);
  } else {
    self.nextthink = 0;
    self.activator = null;
  }

  if (self.spawnflags & SPAWNFLAG_WORLD_TEXT_TRIGGER_ONCE) {
    self.use = null;
  }

  if (self.target !== null) {
    const target = G_PickTarget(self.target);
    if (target !== null && target.inuse) {
      if (target.use !== null) target.use(target, self, self);
    }
  }

  if (self.spawnflags & SPAWNFLAG_WORLD_TEXT_REMOVE_ON_TRIGGER) {
    G_FreeEdict(self);
  }
}

/**
 * kexapi game.ts:201-209's rgba_* constants, as plain [r,g,b,a] tuples. The
 * classic module has no RgbaT, and there is nothing to hand these to under
 * protocol 34 -- see info_world_text_think's degradation note -- but the
 * colour SELECTION (including the "invalid color" diagnostic on an
 * out-of-range `sounds` key) is part of the entity's behavior and is ported.
 */
type KexRgba = readonly [number, number, number, number];
const KEX_RGBA_WHITE: KexRgba = [255, 255, 255, 255];
const KEX_RGBA_RED: KexRgba = [255, 0, 0, 255];
const KEX_RGBA_BLUE: KexRgba = [0, 0, 255, 255];
const KEX_RGBA_GREEN: KexRgba = [0, 255, 0, 255];
const KEX_RGBA_YELLOW: KexRgba = [255, 255, 0, 255];
const KEX_RGBA_BLACK: KexRgba = [0, 0, 0, 255];
const KEX_RGBA_CYAN: KexRgba = [0, 255, 255, 255];
const KEX_RGBA_ORANGE: KexRgba = [116, 61, 50, 255];

/**
 * g_misc.cpp:2276-2325 -- `THINK(info_world_text_think)`.
 *
 * DEGRADATION (protocol 34): the rerelease finishes this think with
 * `gi.Draw_OrientedWorldText(...)` / `gi.Draw_StaticWorldText(...)`, two
 * KEX-only game imports that push a debug-draw command to the client each
 * frame. The classic GameImports (src/game/game.ts) has no debug-draw entry
 * at all and protocol 34 carries no equivalent message, so NOTHING IS DRAWN.
 *
 * The entity's full server-side behavior is preserved regardless: the
 * colour/size selection, the invalid-colour diagnostic, the oriented-vs-static
 * decision from `s.angles[YAW] == -3`, the activator latch, the per-frame
 * rethink, and the START_OFF / TRIGGER_ONCE / REMOVE_ON_TRIGGER wiring in
 * info_world_text_use all run exactly as the rerelease runs them.
 */
function info_world_text_think(self: EdictT): void {
  let color: KexRgba = KEX_RGBA_WHITE;

  switch (self.sounds) {
    case 0:
      color = KEX_RGBA_WHITE;
      break;
    case 1:
      color = KEX_RGBA_RED;
      break;
    case 2:
      color = KEX_RGBA_BLUE;
      break;
    case 3:
      color = KEX_RGBA_GREEN;
      break;
    case 4:
      color = KEX_RGBA_YELLOW;
      break;
    case 5:
      color = KEX_RGBA_BLACK;
      break;
    case 6:
      color = KEX_RGBA_CYAN;
      break;
    case 7:
      color = KEX_RGBA_ORANGE;
      break;
    default:
      color = KEX_RGBA_WHITE;
      gi.dprintf(`${kexEdictFmt(self)}: invalid color\n`);
      break;
  }
  if (self.message === null) {
    throw new Error(
      "info_world_text_think: self.message is null (invariant violated -- SP_info_world_text requires a message)",
    );
  }

  // g_misc.cpp:2318-2324's two draw calls, routed through the optional
  // gi.draw_oriented_world_text / gi.draw_static_world_text imports
  // (src/server/bindings/legacy.ts) into src/server/sv_debugdraw.ts -- the
  // SAME server-side buffer bindings/kex.ts hands the kex module's
  // Draw_OrientedWorldText / Draw_StaticWorldText, so this entity now
  // produces identical draw records under either module.
  //
  // Both hooks are no-ops on a narrow session, and nothing drains
  // sv_debugdraw's buffer under EITHER module (see its header ruling), so
  // this reaches parity with the kex path and still puts nothing on screen.
  // The missing piece is a renderer for the debug-primitive list.
  if (self.s.angles[YAW] === -3.0) {
    gi.draw_oriented_world_text?.(self.s.origin, self.message, color, self.size[2] ?? 0, FRAMETIME, true);
  } else {
    const textAngle = vec3();
    textAngle[YAW] = anglemod(self.s.angles[YAW] ?? 0) + 180;
    if ((textAngle[YAW] ?? 0) > 360.0) textAngle[YAW] = (textAngle[YAW] ?? 0) - 360.0;
    gi.draw_static_world_text?.(self.s.origin, textAngle, self.message, color, self.size[2] ?? 0, FRAMETIME, true);
  }

  self.nextthink = level.time + FRAMETIME;
}

/**
 * g_misc.cpp:2327-2340 -- `void SP_info_world_text(edict_t *self)`.
 *
 * QUAKED info_world_text (1.0 1.0 0.0) (-16 -16 0) (16 16 32)
 * designer placed in world text for debugging.
 */
export function SP_info_world_text(self: EdictT): void {
  if (self.message === null) {
    gi.dprintf(`${kexEdictFmt(self)}: no message\n`);
    G_FreeEdict(self);
    return; // not much point without something to print...
  }

  self.think = info_world_text_think;
  self.use = info_world_text_use;
  self.size[2] = st.radius !== 0 ? st.radius : 0.2;

  if (!(self.spawnflags & SPAWNFLAG_WORLD_TEXT_START_OFF)) {
    self.nextthink = level.time + FRAMETIME;
    self.activator = self;
  }
}

// ===========================================================================
// misc_player_mannequin  (g_misc.cpp:2342-2495 / src/kexgame/g_misc.ts:2431-2588)
// ===========================================================================

/**
 * rerelease's `gesture_type_t` (p_client.h). Only the five values
 * misc_player_mannequin_use switches on are needed.
 */
const GESTURE_FLIP_OFF = 1;
const GESTURE_SALUTE = 2;
const GESTURE_TAUNT = 3;
const GESTURE_WAVE = 4;
const GESTURE_POINT = 5;

/** g_misc.cpp:2344-2375 -- `USE(misc_player_mannequin_use)`. */
function misc_player_mannequin_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.monsterinfo.aiflags |= AI_TARGET_ANGER;
  self.enemy = activator;

  switch (self.count) {
    case GESTURE_FLIP_OFF:
      self.s.frame = FRAME_flip01;
      self.monsterinfo.nextframe = FRAME_flip12;
      break;

    case GESTURE_SALUTE:
      self.s.frame = FRAME_salute01;
      self.monsterinfo.nextframe = FRAME_salute11;
      break;

    case GESTURE_TAUNT:
      self.s.frame = FRAME_taunt01;
      self.monsterinfo.nextframe = FRAME_taunt17;
      break;

    case GESTURE_WAVE:
      self.s.frame = FRAME_wave01;
      self.monsterinfo.nextframe = FRAME_wave11;
      break;

    case GESTURE_POINT:
      self.s.frame = FRAME_point01;
      self.monsterinfo.nextframe = FRAME_point12;
      break;

    default:
      break;
  }
}

/**
 * g_misc.cpp:2377-2404 -- `THINK(misc_player_mannequin_think)`.
 *
 * The rerelease advances one animation frame every 100 ms (`Gtime_from_hz(10)`)
 * while rethinking every server tick; the classic server tick IS 100 ms, so
 * the teleport_time gate and the rethink collapse onto the same FRAMETIME
 * cadence with identical animation speed.
 */
function misc_player_mannequin_think(self: EdictT): void {
  if (self.teleport_time <= level.time) {
    self.s.frame++;

    if ((self.monsterinfo.aiflags & AI_TARGET_ANGER) === 0) {
      if (self.s.frame > FRAME_stand40) {
        self.s.frame = FRAME_stand01;
      }
    } else {
      if (self.s.frame > self.monsterinfo.nextframe) {
        self.s.frame = FRAME_stand01;
        self.monsterinfo.aiflags &= ~AI_TARGET_ANGER;
        self.enemy = null;
      }
    }

    self.teleport_time = level.time + FRAMETIME;
  }

  if (self.enemy !== null) {
    const vec = vec3();
    VectorSet(
      vec,
      self.enemy.s.origin[0] - self.s.origin[0],
      self.enemy.s.origin[1] - self.s.origin[1],
      self.enemy.s.origin[2] - self.s.origin[2],
    );
    self.ideal_yaw = vectoyaw(vec);
    M_ChangeYaw(self);
  }

  self.nextthink = level.time + FRAMETIME;
}

/** g_misc.cpp:2406-2452 -- `void SetupMannequinModel(...)`. */
export function SetupMannequinModel(
  self: EdictT,
  modelType: number,
  weapon: string | null,
  skin: string | null,
): void {
  let modelName: string | null = null;
  let defaultSkin: string | null = null;

  switch (modelType) {
    case 1: {
      self.s.skinnum = MAX_CLIENTS - 1;
      modelName = "female";
      defaultSkin = "venus";
      break;
    }

    case 2: {
      self.s.skinnum = MAX_CLIENTS - 2;
      modelName = "male";
      defaultSkin = "rampage";
      break;
    }

    case 3: {
      self.s.skinnum = MAX_CLIENTS - 3;
      modelName = "cyborg";
      defaultSkin = "oni911";
      break;
    }

    default: {
      self.s.skinnum = MAX_CLIENTS - 1;
      modelName = "female";
      defaultSkin = "venus";
      break;
    }
  }

  if (modelName !== null) {
    self.model = `players/${modelName}/tris.md2`;

    const weaponName =
      weapon !== null ? `players/${modelName}/${weapon}.md2` : `players/${modelName}/w_hyperblaster.md2`;
    self.s.modelindex2 = gi.modelindex(weaponName);

    const skinName = skin !== null ? `mannequin\\${modelName}/${skin}` : `mannequin\\${modelName}/${defaultSkin}`;
    gi.configstring(CS_PLAYERSKINS + self.s.skinnum, skinName);
  }
}

/**
 * g_misc.cpp:2454-2495 -- `void SP_misc_player_mannequin(edict_t *self)`.
 *
 * QUAKED misc_player_mannequin (1.0 1.0 0.0) (-32 -32 -32) (32 32 32)
 *  Creates a player mannequin that stands around.
 *  "distance" - gesture type used when triggered
 *  "height"   - model type (1 - 3)
 *  "goals"    - name of the weapon to use
 *  "image"    - name of the player skin to use
 *  "radius"   - how much to scale the model in-game
 *
 * DEVIATION: the rerelease guards the effects/renderfx defaults with
 * `st.keys_specified.contains("effects")` / `("renderfx")`, a parse-time set
 * of which keys the map actually wrote. The classic SpawnTempT has no such
 * set (ED_ParseField writes "effects"/"renderfx" straight onto s.effects /
 * s.renderfx). The equivalent test here is "is the field still at its
 * post-G_Spawn zero", which differs from the rerelease ONLY for a map that
 * explicitly writes `effects 0` or `renderfx 0` -- in which case both paths
 * end at the same value anyway for effects, and at RF_MINLIGHT vs 0 for
 * renderfx on an explicit `renderfx 0`. No shipped map does that.
 *
 * DEGRADATION (protocol 34): `s.scale` (the "radius" key and the
 * ai_model_scale cvar) is stored and used to scale the mannequin's server-side
 * bounding box, but the delta cannot carry it, so the model always draws at
 * 1.0 even when its collision box is larger or smaller.
 */
export function SP_misc_player_mannequin(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_BBOX;
  // g_misc.cpp:2456-2457: `if (!st.was_key_specified("effects")) self->s.effects = EF_NONE;`
  // and the same for renderfx/RF_MINLIGHT. EF_NONE is 0, so the effects half is
  // a no-op under the "still at its post-G_Spawn default" test described above
  // and is omitted; the renderfx half is kept.
  if (self.s.renderfx === 0) self.s.renderfx = RF_MINLIGHT;
  VectorSet(self.mins, -16, -16, -24);
  VectorSet(self.maxs, 16, 16, 32);
  self.yaw_speed = 30;
  self.ideal_yaw = 0;
  self.teleport_time = level.time + FRAMETIME;
  self.s.modelindex = 255; // MODELINDEX_PLAYER
  self.count = st.distance;

  SetupMannequinModel(self, st.height, st.goals, st.image);

  self.s.scale = 1.0;
  const ai_model_scale = gi.cvar("ai_model_scale", "0", 0);
  if (ai_model_scale !== null && ai_model_scale.value > 0.0) {
    self.s.scale = ai_model_scale.value;
  } else if (st.radius > 0.0) {
    self.s.scale = st.radius;
  }

  VectorScale(self.mins, self.s.scale, self.mins);
  VectorScale(self.maxs, self.s.scale, self.maxs);

  self.think = misc_player_mannequin_think;
  self.nextthink = level.time + FRAMETIME;

  if (self.targetname !== null) {
    self.use = misc_player_mannequin_use;
  }

  gi.linkentity(self);
}

// ===========================================================================
// misc_model  (g_misc.cpp:2497-2501 / src/kexgame/g_misc.ts:2590-2593)
// ===========================================================================

/**
 * g_misc.cpp:2497-2501 -- `void SP_misc_model(edict_t *ent)`.
 *
 * QUAKED misc_model (1 0 0) (-8 -8 -8) (8 8 8)
 * No degradation: gi.setmodel + gi.linkentity are both classic.
 */
export function SP_misc_model(ent: EdictT): void {
  if (ent.model !== null) gi.setmodel(ent, ent.model);
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// Savegame function registry -- so a save containing one of these entities
// restores a real think/touch/use function instead of null. Same idiom as the
// tail of m_soldier.ts.
// ---------------------------------------------------------------------------

import { registerSaveFunction } from "./g_save";

registerSaveFunction("g_kexmisc:dynamic_light_use", dynamic_light_use);
registerSaveFunction("g_kexmisc:func_animation_use", func_animation_use);
registerSaveFunction("g_kexmisc:misc_flare_use", misc_flare_use);
registerSaveFunction("g_kexmisc:misc_hologram_think", misc_hologram_think);
registerSaveFunction("g_kexmisc:fire_touch", fire_touch);
registerSaveFunction("g_kexmisc:fire_fly", fire_fly);
registerSaveFunction("g_kexmisc:info_world_text_use", info_world_text_use);
registerSaveFunction("g_kexmisc:info_world_text_think", info_world_text_think);
registerSaveFunction("g_kexmisc:misc_player_mannequin_use", misc_player_mannequin_use);
registerSaveFunction("g_kexmisc:misc_player_mannequin_think", misc_player_mannequin_think);
