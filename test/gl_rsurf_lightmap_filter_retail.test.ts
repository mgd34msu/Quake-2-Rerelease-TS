/*
GL issue #2 (finding 7, .orch/followups.md): "ERROR: R_BuildLightMap called
for non-lit surface" was observed once on a real map load (mguhub session).
gl_light.ts's R_BuildLightMap has the same guard vanilla's own
R_BuildLightMap has (`tex.flags & (SURF_SKY|SURF_TRANS33|SURF_TRANS66|
SURF_WARP)` -> ERR_DROP) -- vanilla never reaches it because every caller
filters those texinfo classes before calling in. This suite drives the REAL
GL model loader AND the real per-frame render dispatch (R_DrawWorld/
R_RecursiveWorldNode/DrawTextureChains/R_BlendLightmaps for the world,
R_DrawBrushModel/R_DrawInlineBModel for every inline bmodel/submodel) against
every real retail maps/mgu*.bsp in pak0.pak, with all culling disabled
(r_nocull/gl_cull_nodes) and PVS bypassed (r_novis) for maximum surface
coverage -- not just the load path the existing gl_model_retail_qbsp_sweep
suite already covers (that suite never draws a frame, so it can't catch a
render-dispatch-only bug like this one).

Investigation (this unit, cited in the coordinator's report): a hand-rolled
BSP parse of all 28 real mgu*.bsp maps found SURF_WARP and SURF_TRANS33/66
texinfo on many submodels (moving/rotating water and window brush entities
are ordinary Quake 2 content, not a rerelease-only thing) but zero SURF_SKY
faces on any submodel in any of the 28 maps -- the mguhub.bsp session that
produced the error must have hit a path this static per-map scan couldn't
see (a live, per-frame dispatch condition, not a structural "which surface
touches R_BuildLightMap at all" gap in this port's own code as currently
read). This suite is the render-time reproduction attempt the investigation
needed: if the bug is real and still live, it should throw here; if the
existing filters already hold under real data end to end, that is also a
citable, evidenced result for the report rather than a guess.

No copyrighted map data is committed -- pak0.pak is read directly from the
user's local retail install (skips itself if absent), matching every other
retail-gated test's convention (see test/gl_model_retail_qbsp_sweep.test.ts).
*/

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { RefImports } from "../src/client/ref";
import { EntityT } from "../src/client/ref";
import { SetRefImports, SetNoTexture, ImageT, r_worldmodel, glCvars, r_newrefdef, SetCurrentModel, SetViewClusters } from "../src/ref_gl/gl_local";
import { SetQGL } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";
import { Mod_Init, R_BeginRegistration, R_EndRegistration, mod_inline, Mod_FreeAll, Mod_Free, mod_known } from "../src/ref_gl/gl_model";
import { R_DrawWorld, R_DrawBrushModel, R_MarkLeaves, resetLightmapBlockSizeForTesting } from "../src/ref_gl/gl_rsurf";
import { CvarT, SURF_SKY, SURF_WARP, SURF_TRANS33, SURF_TRANS66 } from "../src/shared/q_shared";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

interface PakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPakDirectory(pakPath: string): { data: Buffer; entries: PakEntry[] } {
  const data = readFileSync(pakPath);
  const entries: PakEntry[] = [];
  if (data.toString("ascii", 0, 4) === "PACK") {
    const dirofs = data.readInt32LE(4);
    const dirlen = data.readInt32LE(8);
    const numEntries = dirlen / 64;
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = dirofs + i * 64;
      const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
      const name = rawName.replace(/\0.*$/, "");
      const filepos = data.readInt32LE(entryOffset + 56);
      const filelen = data.readInt32LE(entryOffset + 60);
      entries.push({ name, filepos, filelen });
    }
  }
  return { data, entries };
}

const pak = havePak ? readPakDirectory(PAK_PATH) : null;
const mguMaps = pak ? pak.entries.filter((e) => /^maps\/mgu.*\.bsp$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)) : [];

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
      if (!pak) return { length: -1, data: null };
      const entry = pak.entries.find((e) => e.name === name);
      if (!entry) return { length: -1, data: null };
      const bytes = new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen);
      return { length: bytes.length, data: bytes };
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

function truthyCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

// Draws the world plus every real inline bmodel/submodel the loaded map
// carries, from six extreme viewpoints (+-X/+-Y/+-Z far outside any real
// map's bounds) so every planar surface's backface test (R_DrawInlineBModel's
// own `dot` check, R_RecursiveWorldNode's PVS-independent plane-side check)
// goes both ways at least once across the sweep -- maximum real-dispatch
// surface coverage without needing a hand-built camera path through the
// level.
function renderFromEveryAngle(): void {
  const offsets: [number, number, number][] = [
    [100000, 0, 0],
    [-100000, 0, 0],
    [0, 100000, 0],
    [0, -100000, 0],
    [0, 0, 100000],
    [0, 0, -100000],
  ];

  for (const [ox, oy, oz] of offsets) {
    r_newrefdef.vieworg[0] = ox;
    r_newrefdef.vieworg[1] = oy;
    r_newrefdef.vieworg[2] = oz;
    R_MarkLeaves();
    R_DrawWorld();

    if (!r_worldmodel) continue;
    for (let i = 1; i < mod_inline.length; i++) {
      const sub = mod_inline[i];
      if (!sub || sub.nummodelsurfaces === 0) continue;
      SetCurrentModel(sub);
      const e = new EntityT();
      e.origin[0] = ox;
      e.origin[1] = oy;
      e.origin[2] = oz;
      R_DrawBrushModel(e);
    }
  }
}

describe("gl_rsurf.ts + gl_light.ts -- R_BuildLightMap's non-lit-surface guard under real render dispatch (retail mgu*.bsp, skipped if the retail install isn't present)", () => {
  // rule 13 (leak found at regate hygiene pass): glCvars is a module-private
  // singleton (src/ref_gl/gl_local.ts) shared by every ref_gl test file in
  // this process -- the fields below were being overwritten with test-only
  // truthyCvar(...) objects (and nulls) and never restored, so whichever
  // cvar values this file's LAST test run happened to leave behind (most
  // notably gl_dynamic truthy) silently became every LATER file's ambient
  // default for the rest of the `bun test` process. Confirmed: gl_dynamic
  // left truthy here made test/gl_rsurf.test.ts's own R_BlendLightmaps
  // depth/blend-state test (which never touches gl_dynamic itself) take the
  // "render dynamic lightmaps" branch and issue one extra, unexpected
  // GL_Bind -- reproducing exactly the "spurious GL_Bind, no vertex output"
  // symptom resetLightmapSurfacesForTesting's own header describes, but from
  // this file's cvar leak rather than a leftover lightmap_surfaces chain.
  const savedCvars = {
    r_drawworld: glCvars.r_drawworld,
    gl_drawworld: glCvars.gl_drawworld,
    r_nocull: glCvars.r_nocull,
    gl_cull_nodes: glCvars.gl_cull_nodes,
    r_novis: glCvars.r_novis,
    gl_novis: glCvars.gl_novis,
    gl_lockpvs: glCvars.gl_lockpvs,
    gl_dynamic: glCvars.gl_dynamic,
    gl_lightmap: glCvars.gl_lightmap,
  };

  beforeEach(() => {
    SetRefImports(makeFakeRi());
    const fakeTex = new ImageT();
    fakeTex.width = 64;
    fakeTex.height = 64;
    SetNoTexture(fakeTex);
    SetQGL(new QGLRecording());

    // disable every form of culling/PVS gating so the render dispatch below
    // reaches as much real geometry as possible -- this test is about
    // whether R_BuildLightMap ever gets called for the WRONG surface class,
    // not about correct frustum/PVS culling (covered elsewhere).
    glCvars.r_drawworld = truthyCvar(1);
    glCvars.gl_drawworld = null; // falls back to r_drawworld above (R_DrawWorld's own OR-gate)
    glCvars.r_nocull = truthyCvar(1);
    glCvars.gl_cull_nodes = truthyCvar(0);
    glCvars.r_novis = truthyCvar(1);
    glCvars.gl_novis = null;
    glCvars.gl_lockpvs = null;
    glCvars.gl_dynamic = truthyCvar(1); // exercise the dynamic-lightmap-rebuild path too, not just static
    glCvars.gl_lightmap = null;

    r_newrefdef.rdflags = 0;
    r_newrefdef.time = 0;
    SetViewClusters(0, 0, -2, -2); // force R_MarkLeaves's cluster-changed check to re-run every call
  });

  afterEach(() => {
    glCvars.r_drawworld = savedCvars.r_drawworld;
    glCvars.gl_drawworld = savedCvars.gl_drawworld;
    glCvars.r_nocull = savedCvars.r_nocull;
    glCvars.gl_cull_nodes = savedCvars.gl_cull_nodes;
    glCvars.r_novis = savedCvars.r_novis;
    glCvars.gl_novis = savedCvars.gl_novis;
    glCvars.gl_lockpvs = savedCvars.gl_lockpvs;
    glCvars.gl_dynamic = savedCvars.gl_dynamic;
    glCvars.gl_lightmap = savedCvars.gl_lightmap;
  });

  // rule 13/21 (regate hygiene, found 2026-09-01 chasing a full-suite
  // crash): this loads all 28 real retail maps (world + every inline
  // submodel) through gl_model.ts's real Mod_Init/R_BeginRegistration and
  // never freed any of it -- unlike every other model-loader test file in
  // this codebase. See test/r_model_retail_qbsp_sweep.test.ts's identical
  // fix and citation for the full measured crash (RSS past 110GB, killed
  // by SIGTRAP/exit 133 partway through a from-scratch full-suite run).
  // This file additionally RENDERS every map from six viewpoints (not just
  // loads it), so its own retained footprint is the largest of the three
  // retail sweep files fixed in that same pass.
  afterAll(() => {
    Mod_FreeAll();
    Mod_Free(mod_known[0]); // world model: Mod_FreeAll only frees entries with a nonzero extradatasize
    // Rule 13's second half: don't IMPOSE an ordering either. Loading these
    // retail mgu*.bsp maps runs GL_BeginBuildingLightmaps, which resizes
    // gl_rsurf.ts's module-private lightmap atlas to 1024x1024 for any map
    // carrying a BSPX DECOUPLED_LM lump and leaves it there -- LM_InitBlock
    // only zeroes the array, it does not restore the size. That silently
    // changed the packing arithmetic test/gl_rsurf.test.ts's LM_AllocBlock
    // case measures (it got x=64,y=0 instead of x=0,y=64), since that file
    // runs right after this one.
    resetLightmapBlockSizeForTesting();
  });

  test.skipIf(!havePak)("every real retail mgu*.bsp: full render dispatch (world + every submodel, six viewpoints) never throws", () => {
    Mod_Init();

    const results: { name: string; ok: boolean; reason?: string }[] = [];
    for (const entry of mguMaps) {
      const bareName = entry.name.replace(/^maps\//, "").replace(/\.bsp$/, "");
      try {
        R_BeginRegistration(bareName);
        R_EndRegistration();
        renderFromEveryAngle();
        results.push({ name: entry.name, ok: true });
      } catch (err) {
        results.push({ name: entry.name, ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
      // rule 21 (regate hygiene, 2026-09-01): same GC-checkpoint fix as
      // test/r_model_retail_qbsp_sweep.test.ts's identical loop (see its
      // comment for the full measured crash this avoids) -- this loop is
      // the heaviest of the three retail sweeps fixed in that pass, since it
      // also renders every map from six viewpoints on top of loading it.
      if (typeof Bun !== "undefined") Bun.gc(true);
    }

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      console.log("gl_rsurf_lightmap_filter_retail failures:", JSON.stringify(failures, null, 2));
    }
    expect(failures).toEqual([]);
  },
  // rule 13/21 (regate hygiene, measured 2026-09-01): this loads and fully
  // renders all 28 real retail mgu*.bsp maps synchronously (no awaits), so
  // bun:test's timeout can only be DETECTED after the call returns, never
  // used to preempt it mid-flight -- a slow host doesn't fail fast here, it
  // just reports a late failure. Measured 226976ms in a full-suite run on a
  // host under real, unrelated heavy CPU load (unrelated processes pinning
  // several cores for hours; see this session's own load-average finding),
  // well past the previous 120000ms budget, with zero actual assertion
  // failures once it finished -- a contention artifact, not a defect in
  // this test or the code it exercises. Generous fixed budget instead of
  // chasing a moving contention target (same philosophy as test/jpg_retail
  // .test.ts's own per-test timeout comment).
  400000);

  test.skipIf(!havePak)("mguhub.bsp specifically: sky/warp surfaces carry no lightmap allocation after a full render pass, ordinary lit surfaces do", () => {
    const entry = mguMaps.find((e) => e.name === "maps/mguhub.bsp");
    expect(entry).toBeDefined();
    if (!entry) return;

    Mod_Init();
    R_BeginRegistration("mguhub");
    R_EndRegistration();
    renderFromEveryAngle();

    expect(r_worldmodel).not.toBeNull();
    if (!r_worldmodel) return;

    const skyOrWarpOrTrans = SURF_SKY | SURF_WARP | SURF_TRANS33 | SURF_TRANS66;
    let skyWarpTransCount = 0;
    let litCount = 0;
    let litWithRealAllocation = 0;

    for (const surf of r_worldmodel.surfaces) {
      const flags = surf.texinfo ? surf.texinfo.flags : 0;
      if (flags & skyOrWarpOrTrans) {
        skyWarpTransCount++;
        // never touched by GL_CreateSurfaceLightmap/R_BuildLightMap's
        // lightmap-coordinate assignment -- still at MsurfaceT's own
        // constructor defaults.
        expect(surf.light_s).toBe(0);
        expect(surf.light_t).toBe(0);
        expect(surf.lightmaptexturenum).toBe(0);
      } else if (surf.samples) {
        litCount++;
        if (surf.light_s !== 0 || surf.light_t !== 0 || surf.lightmaptexturenum !== 0) litWithRealAllocation++;
      }
    }

    // positive control: this map really does have sky/warp/trans texinfo
    // faces (confirmed against the real BSP data -- 1575 SURF_SKY-textured
    // faces, 32 SURF_WARP faces on submodel 80) and really does have
    // ordinary lit surfaces that got real, non-default lightmap atlas
    // coordinates -- otherwise the zero-checks above would be vacuous.
    expect(skyWarpTransCount).toBeGreaterThan(0);
    expect(litCount).toBeGreaterThan(0);
    expect(litWithRealAllocation).toBeGreaterThan(0);
  }, 120000); // same contention headroom rationale as the sweep test above, one map instead of 28
});
