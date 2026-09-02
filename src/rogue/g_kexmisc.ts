// g_kexmisc.ts -- the misc/light/animation world entities that exist ONLY in
// the 2023 re-release game DLL, translated into the Ground Zero (rogue)
// module.
//
// Source: our own sibling src/game/g_kexmisc.ts (which translated
// src/kexgame/g_misc.ts, this repo's port of
// quake2-rerelease-dll/rerelease/g_misc.cpp). The g_misc.cpp line references
// below are the ones src/kexgame/g_misc.ts itself records. Ported rather than
// imported for the reason spelled out in g_kexent.ts's header: the five game
// modules in this tree are hard forks with structurally different EdictT
// types and no cross-module imports.
//
// Classnames landed in this file, with the shipped rogue maps that place them
// (verified by scanning the entity lump of every rogue .bsp, both the 1998
// discs and the re-release versions in the shipped pak):
//   dynamic_light   -- rmine1, rware1, rware2
//   func_animation  -- rware1, rhangar2, rsewer2
//   info_landmark   -- rmine1, rlava1, rlava2
//
// TRANSLATION NOTES (apply throughout):
//   * kexgame wraps every callback in RegisterUse/RegisterThink/RegisterTouch;
//     this module uses a plain function plus a registerSaveFunction() call at
//     the tail of the file (see m_soldier.ts).
//   * kexgame's level.time is a millisecond GTime; this module's level.time is
//     a float in SECONDS and FRAMETIME (0.1) is one server frame.
//   * `SpawnFlags_has(self.spawnflags, X)` -> `(self.spawnflags & X) !== 0`.
//   * `SvflagsT.SVF_NOCLIENT` -> `SVF_NOCLIENT`; `gi.Com_Print` -> `gi.dprintf`.
//
// ===========================================================================
// PROTOCOL-34 DEGRADATIONS DOCUMENTED IN THIS FILE (see each site)
// ===========================================================================
//  * dynamic_light's shadow-light data is stored but neither the
//    CS_SHADOWLIGHTS configstring block nor RF_CASTSHADOW is usable under
//    protocol 34. See SP_dynamic_light.
//  * func_animation and info_landmark have NO degradation.

import { VectorCopy, VectorSet } from "../shared/math";
import { SolidT, SVF_NOCLIENT } from "./game";
import { type EdictT, gi, MovetypeT, st } from "./g_local";
import { kexEdictFmt } from "./g_kexent";
import { G_FreeEdict } from "./g_utils";
import { registerSaveFunction } from "./g_save";

// ===========================================================================
// dynamic_light  (g_misc.cpp:597-654 / src/kexgame/g_misc.ts)
// ===========================================================================

/** g_misc.cpp:640 -- `SPAWNFLAG_LIGHT_START_OFF`, shared with SP_light. */
const SPAWNFLAG_LIGHT_START_OFF = 1;

/**
 * g_misc.cpp:597-624 -- `static void setup_dynamic_light(edict_t *self)`.
 *
 * DEGRADATION (protocol 34), inherited verbatim from the analysis our sibling
 * src/game/g_kexmisc.ts wrote for the same entity -- BOTH halves of the
 * re-release's shadow-light presentation are unavailable here:
 *   * The configstring layout this module's family uses is
 *     shared/cs_remap.ts's CS_REMAP_OLD, whose `shadowlights` index is the -1
 *     sentinel and whose `max_shadowlights` is 0: there is no configstring
 *     block to write to, and the client-side consumer (cl_fx.ts's
 *     CL_AddShadowLights) only ever reads that block.
 *   * Stamping RF_CASTSHADOW would push a MODELINDEX-0 entity into every
 *     client frame (sv_ents.ts keeps any RF_CASTSHADOW entity regardless of
 *     model/effects/sound/event). With cls.csr.extended false the client has
 *     no special handling for it, so it reaches the renderer with a null
 *     model and ref_gl/gl_rmain.ts draws R_DrawNullModel's placeholder
 *     diamond -- a visible artifact where the re-release shows a light.
 *
 * So the one piece of shadow-light data that lives ON THE EDICT in the
 * re-release -- `itemtarget`, the name of the entity whose `style` drives this
 * light -- is still recorded, the bbox is still zeroed, the entity is still
 * linked, and its targetname/use toggle still works. Nothing is stamped into
 * renderfx and no configstring is published, so nothing renders. The eight
 * `shadowlight*` keys themselves remain parsed and available in `st` for a
 * future renderer (g_local.ts's SpawnTempT, g_save.ts's FIELDS).
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
 * `bmodel_anim.enabled` is set by ED_ParseField (g_spawn.ts) when it sees
 * `bmodel_anim_start` or `bmodel_anim_end`, matching kexgame/g_spawn.ts's own
 * field table -- see the deviation note there, since our sibling
 * src/game/g_spawn.ts omits that and frees every func_animation it spawns.
 *
 * This one DOES fully present under protocol 34: the bmodel animation drives
 * `s.frame` on a brush model, and s.frame is part of the baseline entity
 * state every protocol carries. (The per-frame advance itself lives in the
 * engine-side bmodel_anim runner, not here -- SP_func_animation only picks
 * the starting frame and wires the toggle, exactly as the re-release does.)
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
// info_landmark  (g_misc.cpp:2241-2245 / src/kexgame/g_misc.ts:2333-2336)
// ===========================================================================

/**
 * g_misc.cpp:2241-2245 -- `void SP_info_landmark(edict_t *self)`.
 *
 * A pure marker: the re-release's cross-level landmark transition reads
 * absmin/absmax off it -- rmine1/rlava1/rlava2 pair theirs up by targetname
 * (`lm_rmine1_rlava1` / `lm_rlava1_rmine1` and so on). Nothing renders and
 * nothing is transmitted, in the re-release either, so there is no
 * degradation. The classic changelevel path this module uses does not consume
 * the landmark, so the marker simply sits there; without this spawn function
 * the whole entity was being dropped with a console error instead.
 */
export function SP_info_landmark(self: EdictT): void {
  VectorCopy(self.s.origin, self.absmin);
  VectorCopy(self.s.origin, self.absmax);
}

// ---------------------------------------------------------------------------
// Savegame function registry (same idiom as the tail of m_soldier.ts)
// ---------------------------------------------------------------------------

registerSaveFunction("g_kexmisc:dynamic_light_use", dynamic_light_use);
registerSaveFunction("g_kexmisc:func_animation_use", func_animation_use);
