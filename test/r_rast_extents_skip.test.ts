/*
Tests for src/ref_soft/r_rast.ts's SURF_EXTENTS_SKIP early-return in
R_RenderFace/R_RenderBmodelFace -- the rasterizer-side half of the Q64/N64
remaster per-face extents skip (see src/ref_soft/r_model.ts's
SURF_EXTENTS_SKIP and CalcSurfaceExtents comments, and
test/lightgrid_q64.test.ts's model-load-level coverage of the flag being
set). This file isolates the OTHER half: that a flagged face is never
queued for rasterization at all.

Self-sufficiency (PORTING.md rule 13): deliberately does NOT call any of
r_rast.ts's setup functions (there is no committed harness for the full
edge/surface rendering pipeline this port's own tests exercise elsewhere).
`surface_p`/`edge_p` (r_local.ts) are module-level counters other test
files running earlier in the same `bun test` process may have already
advanced (there is no per-test reset), so this asserts by BEFORE/AFTER
DIFF rather than an absolute value: a SURF_EXTENTS_SKIP face must return
without throwing and without moving either counter at all, proving
R_RenderFace/R_RenderBmodelFace returned before touching any rasterizer
state, regardless of what a previous test in the same process left behind.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";

function makeFakeRi(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand: () => undefined,
    Cmd_RemoveCommand: () => undefined,
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => undefined,
    Con_Printf: () => undefined,
    FS_LoadFile: () => ({ length: -1, data: null }),
    FS_FreeFile: () => undefined,
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => undefined,
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
  };
}

describe("r_rast.ts -- SURF_EXTENTS_SKIP intercepts a face before the rasterizer's own state is touched", () => {
  let rLocal: typeof import("../src/ref_soft/r_local");
  let rModel: typeof import("../src/ref_soft/r_model");
  let rRast: typeof import("../src/ref_soft/r_rast");

  beforeEach(async () => {
    rLocal = await import("../src/ref_soft/r_local");
    rModel = await import("../src/ref_soft/r_model");
    rRast = await import("../src/ref_soft/r_rast");
    rLocal.SetRefImports(makeFakeRi());
  });

  function makeSurf(flags: number): InstanceType<typeof rModel.MsurfaceT> {
    const surf = new rModel.MsurfaceT();
    surf.texinfo = new rModel.MtexinfoT();
    surf.flags = flags;
    surf.numedges = 4;
    return surf;
  }

  test("R_RenderFace on a SURF_EXTENTS_SKIP face returns cleanly and never touches surface_p/edge_p", () => {
    const surfaceP0 = rLocal.surface_p;
    const edgeP0 = rLocal.edge_p;

    const surf = makeSurf(rModel.SURF_EXTENTS_SKIP);
    expect(() => rRast.R_RenderFace(surf, 0)).not.toThrow();

    expect(rLocal.surface_p).toBe(surfaceP0);
    expect(rLocal.edge_p).toBe(edgeP0);
  });

  test("R_RenderBmodelFace on a SURF_EXTENTS_SKIP face returns cleanly and never touches surface_p/edge_p", () => {
    const surfaceP0 = rLocal.surface_p;
    const edgeP0 = rLocal.edge_p;

    const surf = makeSurf(rModel.SURF_EXTENTS_SKIP);
    expect(() => rRast.R_RenderBmodelFace(null, surf)).not.toThrow();

    expect(rLocal.surface_p).toBe(surfaceP0);
    expect(rLocal.edge_p).toBe(edgeP0);
  });
});
