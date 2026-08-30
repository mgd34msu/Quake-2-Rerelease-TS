// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_items.cpp -- the single xatrix (Ground Zero mission pack) item,
// `item_foodcube` (the trap weapon's "digested corpse" drop). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_items.cpp (30
// lines, C++17): `SP_item_foodcube`. Behavioral code, ported bug-for-bug
// per PORTING.md.
//
// Not a map-placed "SP_" spawn entry in the usual g_spawn.ts sense: the only
// call site anywhere in the source tree is g_xatrix_weapon.cpp's
// `Trap_Think` (`SP_item_foodcube(best)`, on a freshly `G_Spawn()`-ed
// entity, not something ED_ParseEdict ever routes a map-placed
// "item_foodcube" through) -- so this file does not need registration in
// g_spawn.ts's spawn table to be reachable; g_xatrix_weapon.ts's own
// `Trap_Think` imports and calls it directly, exactly like the C++.

import type { EdictT } from "./g_local";
import { HEALTH_IGNORE_MAX } from "./g_local";
import { EffectsT, CvarFlagsT } from "../kexapi/game";
import { gi } from "./g_main_globals";
import { G_FreeEdict } from "./g_utils";
import { SpawnItem, GetItemByIndex } from "./g_items";
import { ItemIdT, SPAWNFLAG_ITEM_DROPPED } from "./g_local";
import { SpawnFlags_or } from "./spawnflags";

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  const c = gi.cvar(name, def, flags);
  return c !== null && c.value !== 0;
}
function deathmatchEnabled(): boolean {
  return cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
}

/**
 * `void SP_item_foodcube(edict_t *self)` (g_xatrix_items.cpp:7-31).
 */
export function SP_item_foodcube(self: EdictT): void {
  if (deathmatchEnabled() && cvarBool("g_no_health", "0")) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/objects/trapfx/tris.md2";
  const item = GetItemByIndex(ItemIdT.IT_HEALTH_SMALL);
  if (item === null) throw new Error("SP_item_foodcube: GetItemByIndex(IT_HEALTH_SMALL) returned null (invariant violated)");
  SpawnItem(self, item);
  self.spawnflags = SpawnFlags_or(self.spawnflags, SPAWNFLAG_ITEM_DROPPED);
  self.style = HEALTH_IGNORE_MAX;
  self.classname = "item_foodcube";
  self.s.effects |= EffectsT.EF_GIB;

  // Paril: set pickup noise for foodcube based on amount
  if (self.count < 10) self.noise_index = gi.soundindex("items/s_health.wav");
  else if (self.count < 25) self.noise_index = gi.soundindex("items/n_health.wav");
  else if (self.count < 50) self.noise_index = gi.soundindex("items/l_health.wav");
  else self.noise_index = gi.soundindex("items/m_health.wav");
}
