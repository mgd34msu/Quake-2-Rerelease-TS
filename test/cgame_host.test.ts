// cgame host seam (ARCHITECTURE.md phase 4, step 1) -- verifies the host
// initializes with the classic cgame as the default active cgame, and that
// CG_DrawHUD's dispatch actually reaches whichever cgame is registered as
// active (spy/flag pattern, following test/sv_game.test.ts's precedent of
// exercising the real seam rather than mocking the module graph).
//
// Self-sufficient per preferences.md rule 13: cls.state stays below
// ca_active for every test here, which keeps the real SCR_DrawStats/
// SCR_DrawLayout call (classic_hud.ts's SCR_ExecuteLayoutString bails out
// immediately unless imports.CL_FrameValid() -- cls.state === ca_active &&
// cl.refresh_prepped, host.ts -- is true) a safe no-op regardless of what
// other test files have left in the shared cl/cls singletons.

import { describe, expect, test } from "bun:test";
import { CG_DrawHUD, CG_GetActiveCgame, CG_SetActiveCgame, CGAME_API_VERSION, buildCgameImports, type CgameExports } from "../src/client/cgame/host";
import { GetClassicCgameAPI } from "../src/client/cgame/classic";
import { cls, ConnstateT } from "../src/client/client";

describe("cgame host", () => {
  test("initializes with the classic cgame registered as the default active cgame", () => {
    const active = CG_GetActiveCgame();
    expect(active).not.toBeNull();
    expect(active.apiversion).toBe(CGAME_API_VERSION);
    expect(typeof active.Init).toBe("function");
    expect(typeof active.Shutdown).toBe("function");
    expect(typeof active.DrawHUD).toBe("function");
  });

  test("CG_DrawHUD dispatches to whichever cgame is currently active", () => {
    let called = false;
    const fake: CgameExports = {
      apiversion: CGAME_API_VERSION,
      Init() {},
      Shutdown() {},
      DrawHUD() {
        called = true;
      },
      TouchPics() {},
      GetOwnedWeaponWheelWeapons: () => 0,
      GetWeaponWheelAmmoCount: () => -1,
      GetPowerupWheelCount: () => 0,
      GetActiveWeaponWheelWeapon: () => -1,
    };

    CG_SetActiveCgame(fake);
    CG_DrawHUD();

    expect(called).toBe(true);
    expect(CG_GetActiveCgame()).toBe(fake);
  });

  test("dispatch reaches the classic cgame's real DrawHUD (SCR_DrawStats/SCR_DrawLayout pass-through)", () => {
    expect(cls.state).not.toBe(ConnstateT.ca_active); // guard: keeps the pass-through a safe no-op below

    const classic = GetClassicCgameAPI(buildCgameImports());
    let reachedClassic = false;

    // Wraps (rather than replaces) the real classic implementation, so the
    // flag proves dispatch reached classic's actual DrawHUD body -- not
    // just a fake standing in for it. Forwards the real (playernum, ps,
    // data) CG_DrawHUD supplies rather than dropping them: classic.ts's
    // DrawHUD now actually reads ps.stats, so calling it with no arguments
    // would crash instead of no-op'ing like the old bare pass-through did.
    CG_SetActiveCgame({
      apiversion: classic.apiversion,
      Init: classic.Init,
      Shutdown: classic.Shutdown,
      DrawHUD(playernum, ps, data) {
        reachedClassic = true;
        classic.DrawHUD(playernum, ps, data);
      },
      TouchPics: classic.TouchPics,
      GetOwnedWeaponWheelWeapons: classic.GetOwnedWeaponWheelWeapons,
      GetWeaponWheelAmmoCount: classic.GetWeaponWheelAmmoCount,
      GetPowerupWheelCount: classic.GetPowerupWheelCount,
      GetActiveWeaponWheelWeapon: classic.GetActiveWeaponWheelWeapon,
    });

    expect(() => CG_DrawHUD()).not.toThrow();
    expect(reachedClassic).toBe(true);
  });

  test("buildCgameImports wires the implemented subset to real engine state", () => {
    const imports = buildCgameImports();

    expect(imports.CL_FrameTime()).toBe(cls.frametime);
    expect(imports.tick_rate).toBe(10);
    expect(imports.frame_time_ms).toBe(100);
    expect(imports.frame_time_s).toBeCloseTo(0.1);

    // Stubs return safe defaults rather than throwing.
    expect(imports.CL_GetClientPic(0)).toBe("");
    expect(imports.GetExtension("anything")).toBeNull();
    expect(imports.CL_InAutoDemoLoop()).toBe(false);
  });

  test("get_configstring bounds-checks like q2repro's CG_get_configstring", () => {
    const imports = buildCgameImports();
    expect(() => imports.get_configstring(-1)).toThrow();
  });
});
