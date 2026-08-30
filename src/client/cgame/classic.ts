// classic cgame -- the built-in cgame implementation that serves the
// legacy client modules (ARCHITECTURE.md phase 4). Precedent: q2repro's
// src/client/cgame_classic.c (GPLv2), specifically its GetClassicCGameAPI
// factory and CGC_DrawHUD.
//
// The HUD/layout-string interpreter itself (SCR_ExecuteLayoutString,
// SCR_DrawStats, SCR_DrawLayout, SCR_DrawField and CL_DrawInventory) now
// lives in ./classic_hud.ts, extracted from cl_scrn.ts/cl_inv.ts -- see that
// file's own top-of-file comment for the host-import-surface boundary the
// extraction drew. DrawHUD below is just the same call order/conditions
// SCR_UpdateScreen used to apply inline (cl_scrn.ts, before this seam
// existed): stats unconditionally, layout when STAT_LAYOUTS bit 0 is set,
// inventory when STAT_LAYOUTS bit 1 is set. Do not reorder or add
// conditions without re-checking against SCR_UpdateScreen's history.
//
// Init/Shutdown are still no-ops: cl_scrn.ts's SCR_Init still owns all of
// the classic HUD's cvar/pic registration directly (SCR_TouchPics stays
// there too -- it also precaches the crosshair pic, a non-HUD concern this
// unit's brief scoped out; see cl_scrn.ts's own note on it).

import { STAT_LAYOUTS } from "../../shared/q_shared";
import { SCR_DrawStats, SCR_DrawLayout, CL_DrawInventory } from "./classic_hud";
import type { CgameImports, CgameExports } from "./host";
import { CGAME_API_VERSION } from "./host";

export function GetClassicCgameAPI(imports: CgameImports): CgameExports {
  return {
    apiversion: CGAME_API_VERSION,

    Init() {
      // TODO(phase 4 continuation): no-op until cl_scrn.ts's SCR_Init
      // (cvar registration, TouchPics, etc.) moves behind this interface.
    },

    Shutdown() {
      // TODO(phase 4 continuation): see Init() above.
    },

    DrawHUD(playernum, ps, data) {
      SCR_DrawStats(imports, ps, playernum);
      if (ps.stats[STAT_LAYOUTS] & 1) SCR_DrawLayout(imports, ps, playernum, data.layout);
      if (ps.stats[STAT_LAYOUTS] & 2) CL_DrawInventory(imports, ps, data.inventory);
    },
  };
}
