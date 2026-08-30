// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_misc.c -- the ROGUE mission pack's `misc_nuke_core` entity (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_misc.cpp
// (27 lines, C++17) in full. `/*QUAKED*/` comment ported as a plain
// TS comment (no editor-hint system in this port line).
//
// ============================================================================
// SP LIST (for the coordinator -- g_spawn.ts is not edited by this unit)
// ============================================================================
// g_spawn.ts's spawn table already carries:
//   { name: "misc_nuke_core", spawn: unported("SP_misc_nuke_core", "rogue/g_rogue_misc.cpp (future src/rogue/g_rogue_misc.ts)") },
// Swap that entry's `spawn` to `SP_misc_nuke_core` exported below (real
// import from "./rogue/g_rogue_misc").

import type { EdictT } from "../g_local";
import { SvflagsT } from "../../kexapi/game";
import { gi } from "../g_main_globals";
import { RegisterUse } from "../g_save_registry";
import type { UseFn } from "../g_local_types";

/** rogue/g_rogue_misc.cpp:8-14 `USE(misc_nuke_core_use)`. */
export const misc_nuke_core_use: UseFn = RegisterUse("misc_nuke_core_use", (self: EdictT): void => {
  if ((self.svflags & SvflagsT.SVF_NOCLIENT) !== 0) {
    self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  } else {
    self.svflags |= SvflagsT.SVF_NOCLIENT;
  }
});

/*QUAKED misc_nuke_core (1 0 0) (-16 -16 -16) (16 16 16)
toggles visible/not visible. starts visible.
*/
/** rogue/g_rogue_misc.cpp:19-25 `void SP_misc_nuke_core(edict_t *ent)`. */
export function SP_misc_nuke_core(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/core/tris.md2");
  gi.linkentity(ent);

  ent.use = misc_nuke_core_use;
}
