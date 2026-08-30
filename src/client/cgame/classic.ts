// classic cgame -- the built-in cgame implementation that serves the
// legacy client modules (ARCHITECTURE.md phase 4). Precedent: q2repro's
// src/client/cgame_classic.c (GPLv2), specifically its GetClassicCGameAPI
// factory and CGC_DrawHUD.
//
// This step is a bare pass-through, not an extraction: DrawHUD calls the
// EXISTING SCR_DrawStats/SCR_DrawLayout functions in cl_scrn.ts (now
// exported for this purpose) in the same order and under the same
// condition SCR_UpdateScreen used to apply inline, before those functions
// (and the ~8k lines of cl_tent/cl_fx/cl_newfx/cl_inv alongside them) move
// behind this interface for real. Init/Shutdown are no-ops for the same
// reason: cl_scrn.ts's SCR_Init still owns all of the classic HUD's
// cvar/pic registration directly.
//
// GetClassicCgameAPI's `imports` parameter is unused today (this
// pass-through never needs to call back into the engine through the cgame
// import table -- SCR_DrawStats/SCR_DrawLayout already read cl/cls/re
// directly) but is kept on the signature to match the real cgame-factory
// shape (q2repro's GetClassicCGameAPI(cgame_import_t *import)) that later
// phase-4 work will actually need.

import { cl } from "../client";
import { STAT_LAYOUTS } from "../../shared/q_shared";
import { SCR_DrawStats, SCR_DrawLayout } from "../cl_scrn";
import type { CgameImports, CgameExports } from "./host";
import { CGAME_API_VERSION } from "./host";

export function GetClassicCgameAPI(_imports: CgameImports): CgameExports {
  return {
    apiversion: CGAME_API_VERSION,

    Init() {
      // TODO(phase 4 continuation): no-op until cl_scrn.ts's SCR_Init
      // (cvar registration, TouchPics, etc.) moves behind this interface.
    },

    Shutdown() {
      // TODO(phase 4 continuation): see Init() above.
    },

    DrawHUD() {
      // Pixel-identical pass-through: same call order and the same
      // condition SCR_UpdateScreen (cl_scrn.ts) applied inline before this
      // seam existed. Do not reorder or add conditions without re-checking
      // against SCR_UpdateScreen's history.
      SCR_DrawStats();
      if (cl.frame.playerstate.stats[STAT_LAYOUTS] & 1) SCR_DrawLayout();
    },
  };
}
