/*
Tests for two independent rule-17 renderer units:

1. LIGHTGRID_OCTREE entity lighting: q2repro's src/refresh/world.c
   GL_LightGridPoint (trilinear interpolation over the octree samples
   qcommon/bspx.ts's lookupLightgrid already walks) wired into
   src/ref_gl/gl_light.ts's R_LightPoint path, ahead of the classic
   per-face lightmap sample. See gl_light.ts's LightGridPoint/R_LightPoint
   for the exact port and its documented GL_AdjustColor deviation.

2. Q64/N64 remaster map extents: maps/q64/*.bsp carries classic (non-BSPX)
   geometry whose texture-axis extents genuinely exceed vanilla's 256-unit
   surface-extents cap on 150-275 faces per map (measured against the real
   retail data: outpost.bsp 177/4205, core.bsp 259/4528, dm1.bsp 35/824 --
   see this unit's report for the extraction method). q2repro's GL loader
   tolerates this fine (its own cap is MAX_LIGHTMAP_EXTENTS=513, and even
   that is a graceful "drop this surface's lightmap" warning, not a crash);
   this port's GL loader already tolerates it too, with NO code change
   needed, because the lightmap atlas (BLOCK_WIDTH/BLOCK_HEIGHT=128) and
   s_blocklights buffer were already sized to 128x128 by the earlier
   DECOUPLED_LM unit, comfortably covering Q64's real measured worst case
   (65x65 texels). The software renderer has no such headroom (q2repro has
   no software renderer to port a raised cap from -- confirmed hard, not
   just conventional: vanilla ref_soft/r_surf.c's D_SCAlloc errors on any
   cache width over 256) -- but a whole-map refusal was a worse degrade
   than necessary for content that only violates the cap on a minority of
   its faces. r_model.ts's CalcSurfaceExtents now flags just the offending
   faces SURF_EXTENTS_SKIP instead of throwing; r_rast.ts's
   R_RenderFace/R_RenderBmodelFace never queue a flagged face for
   rasterization, so the rest of the map still renders, with one map-level
   summary warning (PrescanClassicSurfaceExtents) instead of a thrown
   Sys_Error.

REAL-DATA NOTE (rule 17 "verify at loader+math level against the real
data"): base1.bsp's real LIGHTGRID_OCTREE lump was extracted and parsed
out-of-band via qcommon/bspx.ts's own parseBspxDirectory/parseLightgrid/
lookupLightgrid to confirm the brief's cited "1,554 leafs/186k samples"
figure and exercise a real sample lookup (see this unit's report for the
exact numbers and command). That verification is NOT reproduced as a
committed test here: the real lump is ~854KB of copyrighted retail Kex
lighting data, and PORTING.md rule 13 requires every test file to be
self-sufficient (no dependency on an external, developer-machine-only game
install path) -- the same reason test/bspx_renderer.test.ts's DECOUPLED_LM
fixtures are synthetic box rooms rather than real baseq2/maps/base1.bsp
bytes. The tests below exercise the exact same parseLightgrid/
lookupLightgrid/LightGridPoint code paths that were verified against the
real lump, using small synthetic BSPX octrees built by hand.

Self-sufficient per PORTING.md rule 13: each test/describe block
initializes the globals it reads and does not depend on another test file
having run first (verified with `bun test test/lightgrid_q64.test.ts`
alone, matching this repo's other renderer test files).
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { LightstyleT } from "../src/client/ref";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import type { LightgridT } from "../src/qcommon/bspx";
import { buildBoxRoomBsp, WORLDSPAWN_ONLY_ENTITIES } from "./support/bsp_builder";
import {
  HEADER_LUMPS,
  LUMP_ENTITIES,
  LUMP_PLANES,
  LUMP_VERTEXES,
  LUMP_VISIBILITY,
  LUMP_NODES,
  LUMP_TEXINFO,
  LUMP_FACES,
  LUMP_LIGHTING,
  LUMP_LEAFS,
  LUMP_LEAFFACES,
  LUMP_LEAFBRUSHES,
  LUMP_EDGES,
  LUMP_SURFEDGES,
  LUMP_MODELS,
  LUMP_BRUSHES,
  LUMP_BRUSHSIDES,
  LUMP_POP,
  LUMP_AREAS,
  LUMP_AREAPORTALS,
  IDBSPHEADER,
  BSPVERSION,
  DHEADER_T_SIZE,
  DPLANE_T_SIZE,
  DVERTEX_T_SIZE,
  DEDGE_T_SIZE,
  TEXINFO_T_SIZE,
  DFACE_T_SIZE,
  DNODE_T_SIZE,
  DLEAF_T_SIZE,
  DMODEL_T_SIZE,
} from "../src/qcommon/qfiles";
import { CONTENTS_SOLID } from "../src/shared/q_shared";

// q2repro src/common/bsp.h: `#define FLAG_LEAF BIT(31)` -- not exported by
// qcommon/bspx.ts (module-private), reproduced here as a literal exactly
// like bsp.c's own #define, matching lookupLightgrid's own leaf-index
// convention (`(nodenum & FLAG_LEAF)`, leaf index = `nodenum & ~FLAG_LEAF`).
const FLAG_LEAF = 0x80000000 >>> 0;

// ---------------------------------------------------------------------------
// LightGridPoint: fabricated grids exercising the trilinear-interpolation
// math directly (no BSP file parsing involved -- LightgridT is a plain
// object qcommon/bspx.ts's parseLightgrid would otherwise build for us).
// ---------------------------------------------------------------------------

describe("gl_light.ts -- LightGridPoint (fabricated grids)", () => {
  let glLocal: typeof import("../src/ref_gl/gl_local");
  let glLight: typeof import("../src/ref_gl/gl_light");

  beforeEach(async () => {
    glLocal = await import("../src/ref_gl/gl_local");
    glLight = await import("../src/ref_gl/gl_light");

    glLocal.r_newrefdef.lightstyles = [];
    for (let i = 0; i < 4; i++) glLocal.r_newrefdef.lightstyles.push(new LightstyleT());

    const on = new CvarT();
    on.value = 1;
    glLocal.glCvars.gl_lightgrid = on;
  });

  // one leaf spanning grid points [0,0,0]..[1,1,1] (8 samples, corner index
  // i = ((i>>2)&1)*4 + ((i>>1)&1)*2 + (i&1) matches BSP_LookupLightgrid's
  // `w*(h*pz+py)+px` for a 2x2x2 leaf exactly, so samples[i] IS corner i in
  // GL_LightGridPoint's own `tmp[0]=point_i[0]+((i>>0)&1)` bit order).
  function makeUnitCubeGrid(cornerRgb: Array<[number, number, number]>, styles?: number[]): LightgridT {
    return {
      scale: [1, 1, 1],
      mins: [0, 0, 0],
      size: [2, 2, 2],
      numstyles: 1,
      rootnode: FLAG_LEAF, // leaf 0
      numnodes: 0,
      numleafs: 1,
      numsamples: 8,
      nodes: [],
      leafs: [{ mins: [0, 0, 0], size: [2, 2, 2], numsamples: 8, firstsample: 0 }],
      samples: cornerRgb.map((rgb, i) => ({ style: styles ? styles[i] : 0, rgb })),
    };
  }

  test("trilinear interpolation matches independently hand-computed weights at a fractional interior point", () => {
    const corners: Array<[number, number, number]> = [
      [0, 0, 0], // 0: (0,0,0)
      [255, 0, 0], // 1: (1,0,0)
      [0, 255, 0], // 2: (0,1,0)
      [255, 255, 0], // 3: (1,1,0)
      [0, 0, 255], // 4: (0,0,1)
      [255, 0, 255], // 5: (1,0,1)
      [0, 255, 255], // 6: (0,1,1)
      [255, 255, 255], // 7: (1,1,1)
    ];
    const grid = makeUnitCubeGrid(corners);
    glLocal.r_newrefdef.lightstyles[0].white = 1; // no extra scaling -- isolate the interpolation math

    const point = vec3(0.5, 0.25, 0.75);
    const color = vec3();
    const hit = glLight.LightGridPoint(grid, point, color);
    expect(hit).toBe(true);

    // standard trilinear formula, computed independently of LightGridPoint's
    // own x-then-y-then-z LerpVector2 chain, then divided by 255 to match
    // this port's GL_AdjustColor-equivalent final normalization.
    const fx = 0.5,
      fy = 0.25,
      fz = 0.75;
    const w = (dx: number, dy: number, dz: number) => (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    let expected = 0;
    for (let i = 0; i < 8; i++) {
      const dx = i & 1,
        dy = (i >> 1) & 1,
        dz = (i >> 2) & 1;
      expected += w(dx, dy, dz) * corners[i][0];
    }
    expected /= 255;

    expect(color[0]).toBeCloseTo(expected, 5);
  });

  test("an occluded corner (style 255) is replaced by the average of the other 7 before interpolating", () => {
    const corners: Array<[number, number, number]> = [
      [255, 255, 255], // corner 0 -- will be marked occluded below
      [10, 10, 10],
      [20, 20, 20],
      [30, 30, 30],
      [40, 40, 40],
      [50, 50, 50],
      [60, 60, 60],
      [70, 70, 70],
    ];
    const styles = [255, 0, 0, 0, 0, 0, 0, 0]; // corner 0 fully occluded
    const grid = makeUnitCubeGrid(corners, styles);
    glLocal.r_newrefdef.lightstyles[0].white = 1;

    // query exactly at corner 0 (point_i=[0,0,0], fx=fy=fz=0) so the
    // trilinear weights collapse entirely onto that one corner -- isolating
    // the averaging step from the interpolation math the previous test
    // already covers. All 8 offset corners (point_i + {0,1}^3) stay inside
    // the leaf's [0,1] bounds this way, unlike querying at the far corner
    // (1,1,1), whose point_i=[1,1,1] would push 7 of the 8 lookups outside
    // this 2x2x2 leaf entirely.
    const point = vec3(0, 0, 0);
    const color = vec3();
    const hit = glLight.LightGridPoint(grid, point, color);
    expect(hit).toBe(true);

    const avg = (10 + 20 + 30 + 40 + 50 + 60 + 70) / 7;
    expect(color[0]).toBeCloseTo(avg / 255, 5);
  });

  test("two lightstyles on the same corner accumulate via VectorMA(style.white, sample.rgb) and sum", () => {
    // numstyles=2: corner 0 carries two real style entries, every other
    // corner is fully occluded in both slots -- querying exactly at corner
    // 0 (fx=fy=fz=0) collapses the trilinear weights onto corner 0 alone,
    // isolating the per-corner style-accumulation loop.
    const grid: LightgridT = {
      scale: [1, 1, 1],
      mins: [0, 0, 0],
      size: [2, 2, 2],
      numstyles: 2,
      rootnode: FLAG_LEAF,
      numnodes: 0,
      numleafs: 1,
      numsamples: 8,
      nodes: [],
      leafs: [{ mins: [0, 0, 0], size: [2, 2, 2], numsamples: 8, firstsample: 0 }],
      samples: [
        { style: 0, rgb: [100, 50, 25] },
        { style: 1, rgb: [40, 80, 120] }, // corner 0's two styles
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] }, // corners 1-7: occluded
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
        { style: 255, rgb: [255, 255, 255] },
      ],
    };
    glLocal.r_newrefdef.lightstyles[0].white = 1.5;
    glLocal.r_newrefdef.lightstyles[1].white = 0.5;

    const point = vec3(0, 0, 0); // exactly at corner 0
    const color = vec3();
    const hit = glLight.LightGridPoint(grid, point, color);
    expect(hit).toBe(true);

    // 1.5*[100,50,25] + 0.5*[40,80,120] = [170,115,97.5], then /255
    expect(color[0]).toBeCloseTo(170 / 255, 5);
    expect(color[1]).toBeCloseTo(115 / 255, 5);
    expect(color[2]).toBeCloseTo(97.5 / 255, 5);
  });

  test("an empty grid (numleafs=0) always returns false", () => {
    const grid: LightgridT = {
      scale: [1, 1, 1],
      mins: [0, 0, 0],
      size: [0, 0, 0],
      numstyles: 1,
      rootnode: 0,
      numnodes: 0,
      numleafs: 0,
      numsamples: 0,
      nodes: [],
      leafs: [],
      samples: [],
    };
    const color = vec3(9, 9, 9);
    const hit = glLight.LightGridPoint(grid, vec3(0, 0, 0), color);
    expect(hit).toBe(false);
    expect(color[0]).toBe(9); // untouched
  });

  test("gl_lightgrid cvar off disables the grid path even with a fully valid, hit grid", () => {
    const grid = makeUnitCubeGrid([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const off = new CvarT();
    off.value = 0;
    glLocal.glCvars.gl_lightgrid = off;

    const color = vec3(9, 9, 9);
    const hit = glLight.LightGridPoint(grid, vec3(0.5, 0.5, 0.5), color);
    expect(hit).toBe(false);
    expect(color[0]).toBe(9);
  });

  test("a point entirely outside every leaf (all 8 corner lookups miss) returns false", () => {
    const grid = makeUnitCubeGrid([
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 1, 1],
    ]);
    const color = vec3(9, 9, 9);
    const hit = glLight.LightGridPoint(grid, vec3(100, 100, 100), color);
    expect(hit).toBe(false);
    expect(color[0]).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// R_LightPoint: the grid takes priority over the classic per-face sample
// when it hits, per q2repro's GL_LightPoint_ call order.
// ---------------------------------------------------------------------------

describe("gl_light.ts -- R_LightPoint prioritizes LIGHTGRID_OCTREE over the classic sample", () => {
  let glLocal: typeof import("../src/ref_gl/gl_local");
  let glLight: typeof import("../src/ref_gl/gl_light");
  let glModel: typeof import("../src/ref_gl/gl_model");

  beforeEach(async () => {
    glLocal = await import("../src/ref_gl/gl_local");
    glLight = await import("../src/ref_gl/gl_light");
    glModel = await import("../src/ref_gl/gl_model");

    glLocal.r_newrefdef.lightstyles = [];
    for (let i = 0; i < 4; i++) glLocal.r_newrefdef.lightstyles.push(new LightstyleT());
    glLocal.r_newrefdef.lightstyles[0].white = 1;

    const on = new CvarT();
    on.value = 1;
    glLocal.glCvars.gl_lightgrid = on;
  });

  function makeWorldWithGrid(grid: LightgridT | null): void {
    const model = new glModel.ModelT();
    model.lightdata = new Uint8Array(1); // truthy -- R_LightPoint's early "no lightdata" guard must not fire
    model.nodes = []; // classic RecursiveLightPoint fallback resolves to (0,0,0)
    model.bspx = grid ? { decoupledLm: null, lightgrid: grid } : null;
    glLocal.SetWorldModel(model);
  }

  test("grid hit overrides the classic (empty-fallback) result", () => {
    const grid: LightgridT = {
      scale: [1, 1, 1],
      mins: [0, 0, 0],
      size: [2, 2, 2],
      numstyles: 1,
      rootnode: FLAG_LEAF,
      numnodes: 0,
      numleafs: 1,
      numsamples: 8,
      nodes: [],
      leafs: [{ mins: [0, 0, 0], size: [2, 2, 2], numsamples: 8, firstsample: 0 }],
      samples: new Array(8).fill({ style: 0, rgb: [255, 0, 0] }),
    };
    makeWorldWithGrid(grid);

    const color = vec3();
    glLight.R_LightPoint(vec3(0.5, 0.5, 0.5), color);

    // classic fallback (no nodes) would leave color at (0,0,0); the grid hit
    // must win, giving pure red (scaled by gl_modulate, default 1 when the
    // cvar isn't registered in this fake-ri harness).
    expect(color[0]).toBeGreaterThan(0);
    expect(color[1]).toBe(0);
    expect(color[2]).toBe(0);
  });

  test("grid disabled via cvar falls back to the classic result unchanged", () => {
    const grid: LightgridT = {
      scale: [1, 1, 1],
      mins: [0, 0, 0],
      size: [2, 2, 2],
      numstyles: 1,
      rootnode: FLAG_LEAF,
      numnodes: 0,
      numleafs: 1,
      numsamples: 8,
      nodes: [],
      leafs: [{ mins: [0, 0, 0], size: [2, 2, 2], numsamples: 8, firstsample: 0 }],
      samples: new Array(8).fill({ style: 0, rgb: [255, 0, 0] }),
    };
    makeWorldWithGrid(grid);
    const off = new CvarT();
    off.value = 0;
    glLocal.glCvars.gl_lightgrid = off;

    const color = vec3();
    glLight.R_LightPoint(vec3(0.5, 0.5, 0.5), color);

    // no BSP nodes at all -> RecursiveLightPoint's classic path returns -1
    // ("didn't hit anything") -> color stays at the zero fallback.
    expect(color[0]).toBe(0);
    expect(color[1]).toBe(0);
    expect(color[2]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Q64 GL loader acceptance: a surface whose extents match the REAL measured
// worst case across the retail Q64 map set (core.bsp face #4130/#4131:
// extents [1024, 960] -> smax=65, tmax=61) builds its lightmap through the
// exact same atlas allocator/lightmap-buffer code every classic surface
// uses, with no special-casing and no code change required.
// ---------------------------------------------------------------------------

describe("gl_rsurf.ts -- Q64-scale surface extents fit the existing GL lightmap atlas", () => {
  let glLocal: typeof import("../src/ref_gl/gl_local");
  let glImage: typeof import("../src/ref_gl/gl_image");
  let glModel: typeof import("../src/ref_gl/gl_model");
  let glRsurf: typeof import("../src/ref_gl/gl_rsurf");
  let qgl: typeof import("../src/ref_gl/qgl");

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

  beforeEach(async () => {
    glLocal = await import("../src/ref_gl/gl_local");
    glImage = await import("../src/ref_gl/gl_image");
    glModel = await import("../src/ref_gl/gl_model");
    glRsurf = await import("../src/ref_gl/gl_rsurf");
    qgl = await import("../src/ref_gl/qgl");

    glLocal.SetRefImports(makeFakeRi());
    glImage.SetQGL(new qgl.QGLRecording());
    glRsurf.GL_BeginBuildingLightmaps(new glModel.ModelT());
  });

  test("LM_AllocBlock accepts the real Q64 worst-case surface size (65x65) in the vanilla 128x128 atlas", () => {
    const alloc = glRsurf.LM_AllocBlock(65, 65);
    expect(alloc.ok).toBe(true);
  });

  test("LM_AllocBlock rejects a surface wider than the atlas itself (characterizes the actual cap, not a guess)", () => {
    const alloc = glRsurf.LM_AllocBlock(129, 1);
    expect(alloc.ok).toBe(false);
  });

  test("GL_CreateSurfaceLightmap builds a Q64-scale surface (extents [1024,960], smax=65/tmax=61) without throwing", () => {
    const surf = new glModel.MsurfaceT();
    surf.flags = 0;
    surf.extents = [1024, 960];
    surf.decoupledLm = null;
    surf.samples = null; // "full bright, no light data" path -- no per-texel data needed for this test
    surf.styles = [255, 255, 255, 255];
    surf.texinfo = new glModel.MtexinfoT();
    surf.texinfo.flags = 0;

    expect(() => glRsurf.GL_CreateSurfaceLightmap(surf)).not.toThrow();
    expect(surf.light_s).toBeGreaterThanOrEqual(0);
    expect(surf.light_t).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Q64 software-renderer per-face skip: r_model.ts's CalcSurfaceExtents flags
// an oversized face SURF_EXTENTS_SKIP instead of throwing "Bad surface
// extents" mid-loop; PrescanClassicSurfaceExtents prints one map-level
// summary warning up front. See test/bspx_renderer.test.ts's DECOUPLED_LM
// fullbright-fallback tests for the analogous "load succeeds, degrade
// gracefully" shape.
//
// Isolation note (same as test/bspx_renderer.test.ts's software-renderer
// describe block): Mod_LoadBrushModel enforces "the world model must be
// mod_known[0]", a module-level singleton Mod_FreeAll() never frees for a
// load that throws before completing. Each test imports r_model.ts through
// its own file-scoped query string so it gets an independent
// mod_known/mod_numknown/loadmodel instance, while still sharing the plain
// r_local.ts's `ri` binding via SetRefImports, same as every other test file.
// ---------------------------------------------------------------------------

describe("r_model.ts -- Q64-style oversized classic extents skipped per-face, not refused whole-map", () => {
  const files = new Map<string, Uint8Array>();

  function register(name: string, data: Uint8Array): void {
    files.set(name, data);
  }

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
      FS_LoadFile: (name: string) => {
        const data = files.get(name);
        if (!data) return { length: -1, data: null };
        return { length: data.length, data };
      },
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

  let rLocal: typeof import("../src/ref_soft/r_local");
  let rModel: typeof import("../src/ref_soft/r_model");
  let isolationCounter = 0;

  beforeEach(async () => {
    isolationCounter++;
    rLocal = await import("../src/ref_soft/r_local");
    rModel = await import("../src/ref_soft/r_model" + "?lightgrid_q64_test_isolation_" + isolationCounter);

    rLocal.SetRefImports(makeFakeRi());
    rModel.Mod_Init();
    rModel.Mod_FreeAll();
  });

  /*
  Builds a minimal (no BSPX, no brushes/nodes/leafs needed -- see below)
  classic IBSP with exactly one huge floor quad, sized to reproduce the real
  worst-case measured on baseq2/maps/q64/core.bsp (faces #4130/#4131):
  texture-axis extents [1024, 960]. r_model.ts's new
  PrescanClassicSurfaceExtents runs BEFORE Mod_LoadFaces/Mod_LoadNodes/
  Mod_LoadLeafs, using only the already-loaded vertexes/edges/surfedges/
  texinfo plus the raw face lump -- so nodes/leafs/models/brushes are never
  reached for this test and are left as empty lumps.
  */
  function buildOversizedQuadBsp(halfWidth: number, halfHeight: number): Uint8Array {
    const planesLump = new Uint8Array(DPLANE_T_SIZE);
    {
      const view = new DataView(planesLump.buffer);
      view.setFloat32(0, 0, true);
      view.setFloat32(4, 0, true);
      view.setFloat32(8, 1, true); // normal (0,0,1)
      view.setFloat32(12, 0, true); // dist
      view.setInt32(16, 2, true); // type: Z-axis
    }

    // one big quad on z=0, CCW seen from +Z: (-w,-h) (w,-h) (w,h) (-w,h)
    const corners: Array<[number, number]> = [
      [-halfWidth, -halfHeight],
      [halfWidth, -halfHeight],
      [halfWidth, halfHeight],
      [-halfWidth, halfHeight],
    ];
    const vertexesLump = new Uint8Array(4 * DVERTEX_T_SIZE);
    {
      const view = new DataView(vertexesLump.buffer);
      for (let i = 0; i < 4; i++) {
        view.setFloat32(i * DVERTEX_T_SIZE, corners[i][0], true);
        view.setFloat32(i * DVERTEX_T_SIZE + 4, corners[i][1], true);
        view.setFloat32(i * DVERTEX_T_SIZE + 8, 0, true);
      }
    }

    // edge 0 is the reserved dummy (a surfedge of 0 has no sign)
    const edgesLump = new Uint8Array(5 * DEDGE_T_SIZE);
    {
      const view = new DataView(edgesLump.buffer);
      const pairs: Array<[number, number]> = [
        [0, 0],
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
      ];
      for (let i = 0; i < 5; i++) {
        view.setUint16(i * DEDGE_T_SIZE, pairs[i][0], true);
        view.setUint16(i * DEDGE_T_SIZE + 2, pairs[i][1], true);
      }
    }

    const surfedgesLump = new Uint8Array(4 * 4);
    {
      const view = new DataView(surfedgesLump.buffer);
      for (let i = 0; i < 4; i++) view.setInt32(i * 4, i + 1, true); // edges 1..4, forward
    }

    const texinfoLump = new Uint8Array(TEXINFO_T_SIZE);
    {
      const view = new DataView(texinfoLump.buffer);
      view.setFloat32(0, 1, true);
      view.setFloat32(4, 0, true);
      view.setFloat32(8, 0, true);
      view.setFloat32(12, 0, true); // s axis + offset
      view.setFloat32(16, 0, true);
      view.setFloat32(20, 1, true);
      view.setFloat32(24, 0, true);
      view.setFloat32(28, 0, true); // t axis + offset
      view.setInt32(32, 0, true); // flags
      view.setInt32(36, 0, true); // value
      // texture name (32 bytes) left zeroed; nexttexinfo:
      view.setInt32(72, -1, true);
    }

    const facesLump = new Uint8Array(DFACE_T_SIZE);
    {
      const view = new DataView(facesLump.buffer);
      view.setUint16(0, 0, true); // planenum
      view.setInt16(2, 0, true); // side
      view.setInt32(4, 0, true); // firstedge
      view.setInt16(8, 4, true); // numedges
      view.setInt16(10, 0, true); // texinfo
      for (let j = 0; j < 4; j++) view.setUint8(12 + j, j === 0 ? 0 : 255); // styles
      view.setInt32(16, -1, true); // lightofs
    }

    // Minimal valid tree so Mod_LoadBrushModel's post-Mod_LoadFaces steps
    // (Mod_LoadLeafs/Mod_LoadNodes/R_NumberLeafs/Mod_LoadSubmodels) run to
    // completion now that CalcSurfaceExtents no longer aborts the load --
    // one splitting node (reusing plane 0, the quad's own supporting
    // plane) with a solid back leaf and an empty front leaf that marks the
    // one oversized face via LUMP_LEAFFACES.
    const leaffacesLump = new Uint8Array(2);
    {
      const view = new DataView(leaffacesLump.buffer);
      view.setInt16(0, 0, true); // leaf 1's one marksurface: face 0
    }

    const leafsLump = new Uint8Array(2 * DLEAF_T_SIZE);
    {
      const view = new DataView(leafsLump.buffer);
      // leaf 0: solid, no faces (BSP "back" side, below/behind the quad)
      view.setInt32(0, CONTENTS_SOLID, true);
      view.setInt16(4, -1, true); // cluster
      view.setInt16(6, 0, true); // area
      for (let j = 0; j < 3; j++) {
        view.setInt16(8 + j * 2, -8192, true); // mins
        view.setInt16(14 + j * 2, 8192, true); // maxs
      }
      view.setUint16(20, 0, true); // firstleafface
      view.setUint16(22, 0, true); // numleaffaces
      // leaf 1: empty, contains the one oversized face
      const b1 = DLEAF_T_SIZE;
      view.setInt32(b1 + 0, 0, true); // contents: CONTENTS_EMPTY
      view.setInt16(b1 + 4, 0, true); // cluster
      view.setInt16(b1 + 6, 0, true); // area
      for (let j = 0; j < 3; j++) {
        view.setInt16(b1 + 8 + j * 2, -8192, true); // mins
        view.setInt16(b1 + 14 + j * 2, 8192, true); // maxs
      }
      view.setUint16(b1 + 20, 0, true); // firstleafface
      view.setUint16(b1 + 22, 1, true); // numleaffaces
    }

    const nodesLump = new Uint8Array(DNODE_T_SIZE);
    {
      const view = new DataView(nodesLump.buffer);
      view.setInt32(0, 0, true); // planenum: reuse plane 0
      view.setInt32(4, -2, true); // children[0] (front, +Z): leaf 1 (-1-1)
      view.setInt32(8, -1, true); // children[1] (back, -Z): leaf 0 (-1-0)
      for (let j = 0; j < 3; j++) {
        view.setInt16(12 + j * 2, -8192, true); // mins
        view.setInt16(18 + j * 2, 8192, true); // maxs
      }
      view.setUint16(24, 0, true); // firstface
      view.setUint16(26, 1, true); // numfaces
    }

    const modelsLump = new Uint8Array(DMODEL_T_SIZE);
    {
      const view = new DataView(modelsLump.buffer);
      view.setFloat32(0, -halfWidth, true);
      view.setFloat32(4, -halfHeight, true);
      view.setFloat32(8, 0, true); // mins
      view.setFloat32(12, halfWidth, true);
      view.setFloat32(16, halfHeight, true);
      view.setFloat32(20, 0, true); // maxs
      view.setFloat32(24, 0, true);
      view.setFloat32(28, 0, true);
      view.setFloat32(32, 0, true); // origin
      view.setInt32(36, 0, true); // headnode: node 0
      view.setInt32(40, 0, true); // firstface
      view.setInt32(44, 1, true); // numfaces
    }

    const entitiesLump = new TextEncoder().encode(WORLDSPAWN_ONLY_ENTITIES);
    const empty = new Uint8Array(0);

    const lumpOrder: Array<{ index: number; data: Uint8Array }> = [
      { index: LUMP_ENTITIES, data: entitiesLump },
      { index: LUMP_PLANES, data: planesLump },
      { index: LUMP_VERTEXES, data: vertexesLump },
      { index: LUMP_VISIBILITY, data: empty },
      { index: LUMP_NODES, data: nodesLump },
      { index: LUMP_TEXINFO, data: texinfoLump },
      { index: LUMP_FACES, data: facesLump },
      { index: LUMP_LIGHTING, data: empty },
      { index: LUMP_LEAFS, data: leafsLump },
      { index: LUMP_LEAFFACES, data: leaffacesLump },
      { index: LUMP_LEAFBRUSHES, data: empty },
      { index: LUMP_EDGES, data: edgesLump },
      { index: LUMP_SURFEDGES, data: surfedgesLump },
      { index: LUMP_MODELS, data: modelsLump },
      { index: LUMP_BRUSHES, data: empty },
      { index: LUMP_BRUSHSIDES, data: empty },
      { index: LUMP_POP, data: empty },
      { index: LUMP_AREAS, data: empty },
      { index: LUMP_AREAPORTALS, data: empty },
    ];

    const lumpInfo: Array<{ fileofs: number; filelen: number }> = new Array(HEADER_LUMPS);
    let offset = DHEADER_T_SIZE;
    let totalDataLen = 0;
    for (const { data } of lumpOrder) totalDataLen += data.length;

    const out = new Uint8Array(DHEADER_T_SIZE + totalDataLen);
    const outView = new DataView(out.buffer);
    for (const { index, data } of lumpOrder) {
      lumpInfo[index] = { fileofs: offset, filelen: data.length };
      out.set(data, offset);
      offset += data.length;
    }

    outView.setInt32(0, IDBSPHEADER, true);
    outView.setInt32(4, BSPVERSION, true);
    for (let i = 0; i < HEADER_LUMPS; i++) {
      outView.setInt32(8 + i * 8, lumpInfo[i].fileofs, true);
      outView.setInt32(8 + i * 8 + 4, lumpInfo[i].filelen, true);
    }
    return out;
  }

  test("a face with the real Q64 worst-case extents (1024x960) loads successfully, flagged SURF_EXTENTS_SKIP, with a one-time summary warning (not the bare mid-loop crash, not a whole-map refusal)", () => {
    const name = "maps/q64test.bsp";
    const warnings: string[] = [];
    rLocal.SetRefImports({
      ...makeFakeRi(),
      Con_Printf: (_level: number, str: string) => {
        warnings.push(str);
      },
    });
    register(name, buildOversizedQuadBsp(512, 480)); // -> extents [1024, 960], matching real core.bsp's worst face

    const model = rModel.Mod_ForName(name, false);

    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    // loads the face rather than refusing the whole map.
    expect(model.numsurfaces).toBe(1);
    expect(model.surfaces[0].flags & rModel.SURF_EXTENTS_SKIP).toBeTruthy();

    // exactly one map-level summary warning, not a thrown Sys_Error.
    const capWarnings = warnings.filter((s) => s.includes("SURF_EXTENTS_SKIP"));
    expect(capWarnings.length).toBe(1);
    expect(capWarnings[0]).toMatch(/256-unit surface-extents cap/);
    expect(capWarnings[0]).not.toBe("Bad surface extents");
  });

  test("an ordinary classic map (128-unit walls, well under the cap) is never rejected by the new prescan", () => {
    const name = "maps/classic.bsp";
    register(name, buildBoxRoomBsp(undefined, { renderable: true }));

    const model = rModel.Mod_ForName(name, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");
    expect(model.numsurfaces).toBe(6);
  });
});
