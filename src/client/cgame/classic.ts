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
// Init/Shutdown are still no-ops: cl_scrn.ts's SCR_Init still owns the
// classic HUD's cvar registration directly. TouchPics is now real (see its
// own comment below) -- cl_scrn.ts's SCR_TouchPics still owns the crosshair
// pic precache, a non-HUD concern this unit's brief scoped out; see
// cl_scrn.ts's own note on it.

import { STAT_LAYOUTS } from "../../shared/q_shared";
import { SCR_DrawStats, SCR_DrawLayout, CL_DrawInventory, sb_nums, fullScreenHudPane, type HudPaneT } from "./classic_hud";
import type { CgameImports, CgameExports } from "./host";
import { CGAME_API_VERSION } from "./host";

export function GetClassicCgameAPI(imports: CgameImports): CgameExports {
  return {
    apiversion: CGAME_API_VERSION,

    Init() {
      // TODO(phase 4 continuation): no-op until cl_scrn.ts's SCR_Init
      // (cvar registration, etc.) moves behind this interface.
    },

    Shutdown() {
      // TODO(phase 4 continuation): see Init() above.
    },

    // `seat` IS honored now (Mike's v1.1.0 ruling: local splitscreen works
    // under the classic ruleset too -- "it's all the same engine now").
    //
    // The reference classic cgame ignores this parameter -- q2repro's
    // CGC_DrawHUD (src/client/cgame_classic.c:856-858) opens with "Note:
    // isplit is ignored, due to missing split screen support" and never reads
    // it, because that engine renders exactly one viewport. This port renders
    // one HUD pass per local seat (cl_scrn.ts's SCR_DrawSeatViews), so
    // ignoring it is what left two 3D panes under one full-screen status bar.
    // This is therefore a DOCUMENTED COMPAT ADDITION over the reference, not a
    // fidelity break: with no seat (every single-viewport frame, which is
    // every frame the reference engine has) the pane is the whole display and
    // the arithmetic in classic_hud.ts is bit-identical to what it was.
    //
    // Only `seat`'s RECT is used, and only as an origin+size. `isplit` picks
    // a per-seat HUD-state slot in the kex cgame (hud_data[isplit],
    // cg_screen.cpp:107); this cgame keeps no such per-seat state -- its
    // centerprint/notify queues live in cl_scrn.ts and stay seat 0's, matching
    // what sv_seats.ts already documents about seat-directed server messages
    // being written and discarded.
    //
    // NOT passed as a safe-area inset: see classic_hud.ts's HUD PANE note.
    // The rect's origin is only ever ADDED to a coordinate. Conflating the two
    // is what previously pushed the kex path's bottom-anchored HUD elements a
    // whole pane off the bottom (host.ts's kexSeatHudSafe).
    DrawHUD(playernum, ps, data, seat) {
      const pane: HudPaneT = seat ? { x: seat.x, y: seat.y, width: seat.width, height: seat.height } : fullScreenHudPane();
      SCR_DrawStats(imports, ps, playernum, pane);
      if (ps.stats[STAT_LAYOUTS] & 1) SCR_DrawLayout(imports, ps, playernum, data.layout, pane);
      if (ps.stats[STAT_LAYOUTS] & 2) CL_DrawInventory(imports, ps, data.inventory, pane);
    },

    // The sb_nums half of cl_scrn.ts's former SCR_TouchPics -- moved behind
    // this member per that file's own TODO ("exactly the kind of thing
    // KexCgameExports.TouchPics() exists for"). Goes through the host import
    // surface (Draw_RegisterPic) rather than `re.RegisterPic` directly,
    // matching every other classic-cgame member's use of `imports` instead
    // of reaching into client/renderer globals.
    TouchPics() {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 11; j++) imports.Draw_RegisterPic(sb_nums[i][j]);
    },

    // cgame_classic.c only stubs GetOwnedWeaponWheelWeapons (always 0,
    // CGC_GetOwnedWeaponWheelWeapons) -- the other three wheel accessors
    // aren't part of the real classic cgame's export table at all; this
    // port's CgameExports interface is narrower than KexCgameExports but
    // still requires every implementer to provide the same members, so
    // these are harmless stubs. In practice cl_wheel.ts's logic never opens
    // the kex wheel/carousel while the classic cgame is active (gated by
    // src/client/cl_input.ts's cl_weapnext/cl_weapprev dispatch on
    // CG_GetActiveCgameKind() === "kex"), so these are never actually
    // reached during real play.
    GetOwnedWeaponWheelWeapons() {
      return 0;
    },
    GetWeaponWheelAmmoCount() {
      return -1; // -1 == "unlimited/untracked", cl_wheel.ts's own has_ammo convention
    },
    GetPowerupWheelCount() {
      return 0;
    },
    GetActiveWeaponWheelWeapon() {
      return -1;
    },
  };
}
