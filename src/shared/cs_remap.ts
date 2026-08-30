// cs_remap.ts -- ports q2repro's cs_remap_t (inc/shared/shared.h:1607-1658,
// 1660-1694) plus the cs_remap_old/cs_remap_rerelease initializers
// (src/shared/shared.c:1457-1521). Describes one configstring-index layout
// ("game family"): which CS_* block starts where, how many models/sounds/
// images/edicts/shadowlights/wheelitems that family allows, and how many
// bytes each configstring slot holds. cs_remap_q2pro_new (the Q2PRO
// extended family) is out of scope for this unit per the brief -- not
// needed until protocol work requires it.
//
// -1 marks a block that does not exist in a given family, matching
// q2repro's -1 sentinel for cs_remap_old's shadowlights/wheelweapons/
// wheelammo/wheelpowerups/cdloopcount/gamestyle fields (the classic layout
// has no room for any of them).

import {
  MAX_QPATH,
  MAX_CLIENTS,
  MAX_LIGHTSTYLES,
  MAX_ITEMS,
  MAX_GENERAL,
  MAX_EDICTS,
  MAX_MODELS,
  MAX_SOUNDS,
  MAX_IMAGES,
  CS_AIRACCEL,
  CS_MAXCLIENTS,
  CS_MAPCHECKSUM,
  CS_MODELS,
  CS_SOUNDS,
  CS_IMAGES,
  CS_LIGHTS,
  CS_ITEMS,
  CS_PLAYERSKINS,
  CS_GENERAL,
  MAX_CONFIGSTRINGS,
} from "./q_shared";

export interface CsRemapT {
  extended: boolean;

  max_edicts: number;
  max_models: number;
  max_sounds: number;
  max_images: number;
  max_shadowlights: number;
  max_wheelitems: number;

  airaccel: number;
  maxclients: number;
  mapchecksum: number;

  models: number;
  sounds: number;
  images: number;
  lights: number;
  shadowlights: number;
  items: number;
  playerskins: number;
  general: number;
  wheelweapons: number;
  wheelammo: number;
  wheelpowerups: number;
  cdloopcount: number;
  gamestyle: number;

  end: number;

  configstring_size: number;
}

// CS_REMAP_OLD mirrors q2repro's cs_remap_old (shared.c:1457-1487). Every
// field below reuses one of this repo's existing q_shared.ts CS_*/MAX_*
// constants -- this repo has so far only ever implemented the classic
// (protocol 34) configstring layout, so those constants ARE the "_OLD"
// family's values. Verified field-by-field against q2repro's *_OLD
// constants (shared.h:75-95, 1607-1622) before writing this table: every
// one matched exactly (MAX_EDICTS=1024, MAX_MODELS/SOUNDS/IMAGES=256,
// CS_AIRACCEL=29, CS_MAXCLIENTS=30, CS_MAPCHECKSUM=31, CS_MODELS=32, and
// every CS_SOUNDS/IMAGES/LIGHTS/ITEMS/PLAYERSKINS/GENERAL/MAX_CONFIGSTRINGS
// formula derived the same running totals) -- no mismatch found.
export const CS_REMAP_OLD: CsRemapT = {
  extended: false,

  max_edicts: MAX_EDICTS,
  max_models: MAX_MODELS,
  max_sounds: MAX_SOUNDS,
  max_images: MAX_IMAGES,
  max_shadowlights: 0,
  max_wheelitems: 0,

  airaccel: CS_AIRACCEL,
  maxclients: CS_MAXCLIENTS,
  mapchecksum: CS_MAPCHECKSUM,

  models: CS_MODELS,
  sounds: CS_SOUNDS,
  images: CS_IMAGES,
  lights: CS_LIGHTS,
  shadowlights: -1,
  items: CS_ITEMS,
  playerskins: CS_PLAYERSKINS,
  general: CS_GENERAL,
  wheelweapons: -1,
  wheelammo: -1,
  wheelpowerups: -1,
  cdloopcount: -1,
  gamestyle: -1,

  end: MAX_CONFIGSTRINGS,

  // q2repro's CS_MAX_STRING_LENGTH_OLD (shared.h:163) is 64 -- numerically
  // identical to q2repro's own MAX_QPATH (also 64) and to this repo's
  // MAX_QPATH (q_shared.ts:22). This repo never split them into a separate
  // constant, so MAX_QPATH doubles for both roles here without changing
  // behavior.
  configstring_size: MAX_QPATH,
};

// --- wide ("rerelease") limits -------------------------------------------
//
// q2repro defines these directly as literals (shared.h:83-88, guarded
// `#if !defined(GAME3_INCLUDE)`, and shared.h:162), not derived from the
// OLD family. Defined here, not in q_shared.ts, per the brief: introduce
// the remap abstraction without changing any existing q_shared.ts constant.
export const MAX_EDICTS_WIDE = 8192; // sent as ENTITYNUM_BITS, can't be increased
export const MAX_MODELS_WIDE = 8192; // half is reserved for inline BSP models
export const MAX_SOUNDS_WIDE = 2048;
export const MAX_IMAGES_WIDE = 512; // Q2PRO extended protocol raises this further -- not this unit's concern
export const MAX_SHADOW_LIGHTS_WIDE = 256; // [Sam-KEX]
export const MAX_WHEEL_ITEMS_WIDE = 32; // bound by number of things that fit in two stats
export const CS_MAX_STRING_LENGTH_WIDE = 96;

// CS_* index bases for the wide family (shared.h:1624-1637). MAX_CLIENTS,
// MAX_LIGHTSTYLES, MAX_ITEMS, and MAX_GENERAL are unchanged between the OLD
// and wide families in q2repro, so those come from q_shared.ts unmodified;
// only the per-family MAX_MODELS/SOUNDS/IMAGES/SHADOW_LIGHTS/WHEEL_ITEMS
// above differ, and the running totals below are computed with the same
// formulas q2repro uses so they can't drift from the C macros.
const CS_AIRACCEL_WIDE = 59;
const CS_MAXCLIENTS_WIDE = 60;
const CS_MAPCHECKSUM_WIDE = 61;
const CS_MODELS_WIDE = 62;
const CS_SOUNDS_WIDE = CS_MODELS_WIDE + MAX_MODELS_WIDE;
const CS_IMAGES_WIDE = CS_SOUNDS_WIDE + MAX_SOUNDS_WIDE;
const CS_LIGHTS_WIDE = CS_IMAGES_WIDE + MAX_IMAGES_WIDE;
const CS_SHADOWLIGHTS_WIDE = CS_LIGHTS_WIDE + MAX_LIGHTSTYLES; // [Sam-KEX]
const CS_ITEMS_WIDE = CS_SHADOWLIGHTS_WIDE + MAX_SHADOW_LIGHTS_WIDE;
const CS_PLAYERSKINS_WIDE = CS_ITEMS_WIDE + MAX_ITEMS;
const CS_GENERAL_WIDE = CS_PLAYERSKINS_WIDE + MAX_CLIENTS;
const CS_WHEEL_WEAPONS_WIDE = CS_GENERAL_WIDE + MAX_GENERAL; // [Paril-KEX]
const CS_WHEEL_AMMO_WIDE = CS_WHEEL_WEAPONS_WIDE + MAX_WHEEL_ITEMS_WIDE; // [Paril-KEX]
const CS_WHEEL_POWERUPS_WIDE = CS_WHEEL_AMMO_WIDE + MAX_WHEEL_ITEMS_WIDE; // [Paril-KEX]
const CS_CD_LOOP_COUNT_WIDE = CS_WHEEL_POWERUPS_WIDE + MAX_WHEEL_ITEMS_WIDE; // [Paril-KEX]
const CS_GAME_STYLE_WIDE = CS_CD_LOOP_COUNT_WIDE + 1; // [Paril-KEX]
const MAX_CONFIGSTRINGS_WIDE = CS_GAME_STYLE_WIDE + 1;

// CS_REMAP_RERELEASE mirrors q2repro's cs_remap_rerelease (shared.c:1489-1521).
export const CS_REMAP_RERELEASE: CsRemapT = {
  extended: true,

  max_edicts: MAX_EDICTS_WIDE,
  max_models: MAX_MODELS_WIDE,
  max_sounds: MAX_SOUNDS_WIDE,
  max_images: MAX_IMAGES_WIDE,
  max_shadowlights: MAX_SHADOW_LIGHTS_WIDE,
  max_wheelitems: MAX_WHEEL_ITEMS_WIDE,

  airaccel: CS_AIRACCEL_WIDE,
  maxclients: CS_MAXCLIENTS_WIDE,
  mapchecksum: CS_MAPCHECKSUM_WIDE,

  models: CS_MODELS_WIDE,
  sounds: CS_SOUNDS_WIDE,
  images: CS_IMAGES_WIDE,
  lights: CS_LIGHTS_WIDE,
  shadowlights: CS_SHADOWLIGHTS_WIDE,
  items: CS_ITEMS_WIDE,
  playerskins: CS_PLAYERSKINS_WIDE,
  general: CS_GENERAL_WIDE,
  wheelweapons: CS_WHEEL_WEAPONS_WIDE,
  wheelammo: CS_WHEEL_AMMO_WIDE,
  wheelpowerups: CS_WHEEL_POWERUPS_WIDE,
  cdloopcount: CS_CD_LOOP_COUNT_WIDE,
  gamestyle: CS_GAME_STYLE_WIDE,

  end: MAX_CONFIGSTRINGS_WIDE,

  configstring_size: CS_MAX_STRING_LENGTH_WIDE,
};
