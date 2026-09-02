// g_kexmisc.ts -- the misc/light/marker world entities that exist ONLY in the
// 2023 re-release game DLL, translated into The Reckoning (Xatrix) module.
//
// Classnames landed in this file:
//   dynamic_light, info_landmark
//
// Both are placed by the re-release versions of this pack's own campaign maps
// (dynamic_light in w_treat/xcompnd1/xdm7/...; info_landmark in
// badlands/industry/outbase/...), and the frozen Xatrix DLL drops both with
// "<classname> doesn't have a spawn function".
//
// SOURCE: src/game/g_kexmisc.ts's SP_dynamic_light / SP_info_landmark, which
// are that module's translation of quake2-rerelease-dll/rerelease/g_misc.cpp
// (via src/kexgame/g_misc.ts). This module is a HARD FORK of src/game with its
// own EdictT and its own spawn table -- there is no cross-module import
// anywhere in the tree -- so the implementation is COPIED IN, the same way
// commit 288484f copied the sibling modules' entities into src/game.
//
// TRANSLATION NOTES (carried over from src/game/g_kexmisc.ts):
//   * kexgame wraps every callback in RegisterUse/RegisterThink; this module
//     uses a plain function plus a registerSaveFunction() call at the file
//     tail (see the tail of m_soldier.ts).
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `SvflagsT.SVF_NOCLIENT` -> `SVF_NOCLIENT`; `gi.Com_Print` -> `gi.dprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * dynamic_light -- the shadow-light data is parsed and stored, but neither
//    the CS_SHADOWLIGHTS configstring block nor RF_CASTSHADOW is usable under
//    protocol 34, so nothing renders. See SP_dynamic_light.
//  * info_landmark -- no degradation; it is a pure marker in the rerelease too.

import { VectorCopy, VectorSet } from "../shared/math";
import { SVF_NOCLIENT } from "./game";
import { type EdictT, gi, st } from "./g_local";
import { registerSaveFunction } from "./g_save";

// ===========================================================================
// dynamic_light  (g_misc.cpp:588-654 / src/game/g_kexmisc.ts:126-161)
// ===========================================================================

/** g_misc.cpp:624 -- `SPAWNFLAG_LIGHT_START_OFF`. */
const SPAWNFLAG_LIGHT_START_OFF = 1;

/**
 * g_misc.cpp:596-620 -- `static void setup_dynamic_light(edict_t *self)`.
 *
 * WHAT THE RERELEASE DOES: it stamps `RF_CASTSHADOW` into renderfx so the
 * server's "has effects" test keeps the light in the client's frame, then
 * publishes one CS_SHADOWLIGHTS configstring per light for the client's
 * CL_AddShadowLights.
 *
 * DEGRADATION (protocol 34) -- BOTH halves of that are unavailable here, for
 * exactly the reasons src/game/g_kexmisc.ts records:
 *   * The classic configstring layout is shared/cs_remap.ts's CS_REMAP_OLD,
 *     whose `shadowlights` index is the -1 sentinel and whose
 *     `max_shadowlights` is 0 -- there is no configstring block to write to,
 *     and the client-side consumer (cl_fx.ts's CL_AddShadowLights) only ever
 *     reads that block.
 *   * Stamping RF_CASTSHADOW would push a MODELINDEX-0 entity into every
 *     client frame (sv_ents.ts keeps any RF_CASTSHADOW entity regardless of
 *     model/effects/sound/event). With cls.csr.extended false the client has
 *     no special handling for it, so it reaches the renderer with a null model
 *     and ref_gl/gl_rmain.ts draws R_DrawNullModel's placeholder diamond -- a
 *     visible artifact where the rerelease shows a light.
 *
 * So the one piece of shadow-light data that lives ON THE EDICT in the
 * rerelease -- `itemtarget`, the name of the entity whose `style` drives this
 * light -- is still recorded, the bbox is still zeroed, the entity is still
 * linked, and its targetname/use toggle still works. Nothing is stamped into
 * renderfx and no configstring is published, so nothing renders. The eight
 * `shadowlight*` keys themselves are parsed into `st` (added to this module's
 * SpawnTempT and FIELDS table) and are available for a future renderer.
 */
function setup_dynamic_light(self: EdictT): void {
  // [Sam-KEX] Shadow stuff
  if (st.shadowlightradius > 0) {
    // g_misc.cpp:604-605: `self->s.renderfx = RF_CASTSHADOW;` and
    // `self->itemtarget = st.sl.lightstyletarget;`. Only the itemtarget half
    // is kept -- see the degradation note above for why RF_CASTSHADOW is not
    // stamped under protocol 34.
    self.itemtarget = st.shadowlightstyletarget;

    // g_misc.cpp:616-619
    VectorSet(self.mins, 0, 0, 0);
    VectorSet(self.maxs, 0, 0, 0);

    gi.linkentity(self);
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
// info_landmark  (g_misc.cpp:2241-2245 / src/game/g_kexmisc.ts:416-425)
// ===========================================================================

/**
 * g_misc.cpp:2241-2245 -- `void SP_info_landmark(edict_t *self)`.
 *
 * A pure marker: the rerelease's cross-level landmark transition reads
 * absmin/absmax off it. Nothing renders and nothing is transmitted, in the
 * rerelease either -- so there is no degradation. (The Xatrix module has no
 * landmark-relative level transition of its own, so the marker is inert here
 * beyond spawning cleanly instead of being dropped.)
 */
export function SP_info_landmark(self: EdictT): void {
  VectorCopy(self.s.origin, self.absmin);
  VectorCopy(self.s.origin, self.absmax);
}

// ---------------------------------------------------------------------------
// Savegame function registry (same idiom as the tail of m_soldier.ts)
// ---------------------------------------------------------------------------

registerSaveFunction("g_kexmisc:dynamic_light_use", dynamic_light_use);
