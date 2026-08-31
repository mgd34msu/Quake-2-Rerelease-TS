/*
Tests for BSPX DECOUPLED_LM consumption in the GL renderer (src/ref_gl/
gl_model.ts, gl_rsurf.ts, gl_light.ts) and the software renderer's per-
surface fullbright fallback for a DECOUPLED_LM map (src/ref_soft/r_model.ts)
-- see this unit's brief: q2repro's src/refresh/surf.c build_surface_poly's
`if (bsp->lm_decoupled)` branch and src/common/bsp.c's BSP_ParseDecoupledLM/
BSP_RecursiveLightPoint are the reference this port's selection logic
matches; q2repro has no software renderer at all (verified: no sw_*.c or
*soft* anywhere under ~/Projects/qsrc/q2repro/src/), which is why the
software-renderer half of this file only tests that the map still loads and
renders (fullbright), not any attempt at real decoupled lighting support.

Self-sufficient per PORTING.md rule 13: each test initializes the globals it
reads (SetRefImports, Mod_Init/Mod_FreeAll, SetQGL, SetNoTexture) and does
not depend on another test file having run first.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { vec3 } from "../src/shared/math";
import { CplaneT } from "../src/shared/q_shared";
import { buildBoxRoomBsp } from "./support/bsp_builder";
import * as qcommonBspx from "../src/qcommon/bspx";
import * as qfiles from "../src/qcommon/qfiles";

// ---------------------------------------------------------------------------
// shared fixture helper: appends a synthetic BSPX directory + DECOUPLED_LM
// lump after a bsp_builder.ts buffer, matching qcommon/bspx.ts's
// parseBspxDirectory/parseDecoupledLM on-disk layout exactly (BSPX magic,
// numlumps, one 32-byte xlump_t naming "DECOUPLED_LM", then numfaces*40
// bytes of per-face lmWidth/lmHeight/lightofs/axis/offset). All lightofs
// fields are the 0xffffffff "no lightmap" sentinel -- bsp_builder.ts's
// LUMP_LIGHTING is always empty (0 bytes), so any other offset would be
// flagged out-of-bounds/corrupted by parseDecoupledLM, which is not what
// these tests are checking (real rerelease data has plenty of faces with a
// null lightofs too -- verified against baseq2/maps/base1.bsp: 457 of
// 16787).
// ---------------------------------------------------------------------------

interface FaceLm {
  width: number;
  height: number;
  axis0: [number, number, number];
  offset0: number;
  axis1: [number, number, number];
  offset1: number;
}

function appendDecoupledLm(bsp: Uint8Array, faces: FaceLm[]): Uint8Array {
  const XLUMP_NAME_LEN = 24;
  const XLUMP_T_SIZE = XLUMP_NAME_LEN + 4 + 4;
  const DECOUPLED_LM_BYTES = 40;

  // parseBspxDirectory 4-byte-aligns `searchPos` before reading the magic
  // (matching BSP_ParseExtensionHeader) -- bsp_builder.ts's lump data isn't
  // guaranteed to already land on a 4-byte boundary, so this must too.
  const dirStart = (bsp.length + 3) & ~3;
  const dirSize = 4 + 4 + XLUMP_T_SIZE;
  const lumpDataStart = dirStart + dirSize;
  const lumpDataSize = faces.length * DECOUPLED_LM_BYTES;

  const out = new Uint8Array(lumpDataStart + lumpDataSize);
  out.set(bsp, 0);
  const view = new DataView(out.buffer);

  // BSPX header: magic 'BSPX', numlumps
  out[dirStart] = "B".charCodeAt(0);
  out[dirStart + 1] = "S".charCodeAt(0);
  out[dirStart + 2] = "P".charCodeAt(0);
  out[dirStart + 3] = "X".charCodeAt(0);
  view.setUint32(dirStart + 4, 1, true);

  // one xlump_t: name, fileofs, filelen
  const xlumpBase = dirStart + 8;
  const name = "DECOUPLED_LM";
  for (let i = 0; i < XLUMP_NAME_LEN; i++) out[xlumpBase + i] = i < name.length ? name.charCodeAt(i) : 0;
  view.setUint32(xlumpBase + XLUMP_NAME_LEN, lumpDataStart, true);
  view.setUint32(xlumpBase + XLUMP_NAME_LEN + 4, lumpDataSize, true);

  // DECOUPLED_LM lump data
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const base = lumpDataStart + i * DECOUPLED_LM_BYTES;
    view.setInt16(base, f.width, true);
    view.setInt16(base + 2, f.height, true);
    view.setUint32(base + 4, 0xffffffff, true); // lightofs sentinel, see header comment
    let p = base + 8;
    view.setFloat32(p, f.axis0[0], true);
    view.setFloat32(p + 4, f.axis0[1], true);
    view.setFloat32(p + 8, f.axis0[2], true);
    p += 12;
    view.setFloat32(p, f.offset0, true);
    p += 4;
    view.setFloat32(p, f.axis1[0], true);
    view.setFloat32(p + 4, f.axis1[1], true);
    view.setFloat32(p + 8, f.axis1[2], true);
    p += 12;
    view.setFloat32(p, f.offset1, true);
  }

  return out;
}

const SIX_BOX_FACES: FaceLm[] = [
  { width: 10, height: 12, axis0: [1, 0, 0], offset0: 2, axis1: [0, 1, 0], offset1: 3 },
  { width: 20, height: 8, axis0: [0, 0, 1], offset0: -1, axis1: [1, 0, 0], offset1: 0.5 },
  { width: 5, height: 5, axis0: [0, 1, 0], offset0: 0, axis1: [0, 0, 1], offset1: 0 },
  { width: 6, height: 7, axis0: [1, 0, 0], offset0: 1, axis1: [0, 0, 1], offset1: 1 },
  { width: 30, height: 30, axis0: [0, 1, 0], offset0: 4, axis1: [1, 0, 0], offset1: 4 },
  { width: 3, height: 30, axis0: [1, 0, 0], offset0: 0, axis1: [0, 1, 0], offset1: 0 },
];

// ---------------------------------------------------------------------------
// GL renderer: src/ref_gl/gl_model.ts, gl_rsurf.ts, gl_light.ts
// ---------------------------------------------------------------------------

describe("GL renderer -- BSPX DECOUPLED_LM", () => {
  const filesGl = new Map<string, Uint8Array>();

  function registerGl(name: string, data: Uint8Array): void {
    filesGl.set(name, data);
  }

  function makeFakeRiGl(): RefImports {
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
        const data = filesGl.get(name);
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

  let glLocal: typeof import("../src/ref_gl/gl_local");
  let glImage: typeof import("../src/ref_gl/gl_image");
  let glModel: typeof import("../src/ref_gl/gl_model");
  let glRsurf: typeof import("../src/ref_gl/gl_rsurf");
  let glLight: typeof import("../src/ref_gl/gl_light");
  let qgl: typeof import("../src/ref_gl/qgl");

  beforeEach(async () => {
    glLocal = await import("../src/ref_gl/gl_local");
    glImage = await import("../src/ref_gl/gl_image");
    glModel = await import("../src/ref_gl/gl_model");
    glRsurf = await import("../src/ref_gl/gl_rsurf");
    glLight = await import("../src/ref_gl/gl_light");
    qgl = await import("../src/ref_gl/qgl");

    glLocal.SetRefImports(makeFakeRiGl());
    glModel.Mod_Init();
    glModel.Mod_FreeAll();

    const fakeTex = new glLocal.ImageT();
    fakeTex.width = 64;
    fakeTex.height = 64;
    glLocal.SetNoTexture(fakeTex);

    glImage.SetQGL(new qgl.QGLRecording());
  });

  // -- unit-level selection math (no BSP file loading) ---------------------

  test("surfaceLightmapDims: classic face derives smax/tmax from extents (extents>>4)+1", () => {
    const surf = new glModel.MsurfaceT();
    surf.extents = [64, 32]; // 4 texels x 2 texels of margin -> (64>>4)+1=5, (32>>4)+1=3
    expect(glModel.surfaceLightmapDims(surf)).toEqual([5, 3]);
  });

  test("surfaceLightmapDims: DECOUPLED_LM face uses lm_width/lm_height directly, ignoring extents", () => {
    const surf = new glModel.MsurfaceT();
    surf.extents = [999, 999]; // would give a very different classic answer
    surf.decoupledLm = { width: 12, height: 7, axis: [vec3(1, 0, 0), vec3(0, 1, 0)], offset: [0, 0] };
    expect(glModel.surfaceLightmapDims(surf)).toEqual([12, 7]);
  });

  test("GL_BuildPolygonFromSurface: classic lightmap texcoords use texinfo.vecs/texturemins/light_s*16 grid", () => {
    const model = new glModel.ModelT();
    model.vertexes = [new glModel.MvertexT(), new glModel.MvertexT(), new glModel.MvertexT(), new glModel.MvertexT()];
    model.vertexes[0].position = vec3(0, 0, 0);
    model.vertexes[1].position = vec3(16, 0, 0);
    model.vertexes[2].position = vec3(16, 16, 0);
    model.vertexes[3].position = vec3(0, 16, 0);
    // edges[0] is an unused dummy: GL_BuildPolygonFromSurface's vertex
    // lookup treats a surfedge value of exactly 0 as "negative" (`lindex >
    // 0` is false for 0), same as the real BSP convention this port keeps
    // byte-for-byte -- surfedges below start at 1 to name each edge
    // unambiguously in its forward direction.
    model.edges = [new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT()];
    model.edges[1].v = [0, 1];
    model.edges[2].v = [1, 2];
    model.edges[3].v = [2, 3];
    model.edges[4].v = [3, 0];
    model.surfedges = [1, 2, 3, 4];
    glLocal.SetCurrentModel(model);

    const texinfo = new glModel.MtexinfoT();
    texinfo.vecs = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
    const fakeImage = new glLocal.ImageT();
    fakeImage.width = 64;
    fakeImage.height = 64;
    texinfo.image = fakeImage;

    const fa = new glModel.MsurfaceT();
    fa.texinfo = texinfo;
    fa.numedges = 4;
    fa.firstedge = 0;
    fa.texturemins = [0, 0];
    fa.light_s = 2;
    fa.light_t = 1;

    glRsurf.GL_BuildPolygonFromSurface(fa);

    expect(fa.polys?.numverts).toBe(4);
    const row0 = fa.polys?.verts[0];
    // vertex 0 = (0,0,0): ls = 0 - 0 + 2*16 + 8 = 40, /(128*16) = 40/2048
    expect(row0?.[5]).toBeCloseTo(40 / 2048, 6);
    // lt = 0 - 0 + 1*16 + 8 = 24, /(128*16) = 24/2048
    expect(row0?.[6]).toBeCloseTo(24 / 2048, 6);
  });

  test("GL_BuildPolygonFromSurface: DECOUPLED_LM face uses lm_axis/lm_offset directly (no texturemins/*16), differs from classic on the same geometry", () => {
    const model = new glModel.ModelT();
    model.vertexes = [new glModel.MvertexT(), new glModel.MvertexT(), new glModel.MvertexT(), new glModel.MvertexT()];
    model.vertexes[0].position = vec3(0, 0, 0);
    model.vertexes[1].position = vec3(16, 0, 0);
    model.vertexes[2].position = vec3(16, 16, 0);
    model.vertexes[3].position = vec3(0, 16, 0);
    // edges[0] is an unused dummy: GL_BuildPolygonFromSurface's vertex
    // lookup treats a surfedge value of exactly 0 as "negative" (`lindex >
    // 0` is false for 0), same as the real BSP convention this port keeps
    // byte-for-byte -- surfedges below start at 1 to name each edge
    // unambiguously in its forward direction.
    model.edges = [new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT(), new glModel.MedgeT()];
    model.edges[1].v = [0, 1];
    model.edges[2].v = [1, 2];
    model.edges[3].v = [2, 3];
    model.edges[4].v = [3, 0];
    model.surfedges = [1, 2, 3, 4];
    glLocal.SetCurrentModel(model);

    const texinfo = new glModel.MtexinfoT();
    texinfo.vecs = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
    const fakeImage = new glLocal.ImageT();
    fakeImage.width = 64;
    fakeImage.height = 64;
    texinfo.image = fakeImage;

    const fa = new glModel.MsurfaceT();
    fa.texinfo = texinfo;
    fa.numedges = 4;
    fa.firstedge = 0;
    fa.texturemins = [0, 0]; // deliberately left set -- must be ignored on this branch
    fa.light_s = 2;
    fa.light_t = 1;
    const axis0 = vec3(0.0625, 0, 0); // 1/16, matching a plausible decoupled scale
    const axis1 = vec3(0, 0.0625, 0);
    fa.decoupledLm = { width: 4, height: 4, axis: [axis0, axis1], offset: [1, 2] };

    glRsurf.GL_BuildPolygonFromSurface(fa);

    const row0 = fa.polys?.verts[0]; // vertex (0,0,0)
    // ls = dot((0,0,0), axis0) + offset0 = 0 + 1 = 1; += light_s(2) += 0.5 -> 3.5; /BLOCK_WIDTH(128)
    expect(row0?.[5]).toBeCloseTo(3.5 / 128, 6);
    // lt = 0 + 2 = 2; += light_t(1) += 0.5 -> 3.5; /BLOCK_HEIGHT(128)
    expect(row0?.[6]).toBeCloseTo(3.5 / 128, 6);

    const row1 = fa.polys?.verts[1]; // vertex (16,0,0)
    // ls = dot((16,0,0),(0.0625,0,0)) + 1 = 1 + 1 = 2; += 2 += 0.5 -> 4.5; /128
    expect(row1?.[5]).toBeCloseTo(4.5 / 128, 6);

    // sanity: this is NOT the classic-branch answer for the same vertex/light_s/light_t
    expect(row0?.[5]).not.toBeCloseTo((0 - 0 + 2 * 16 + 8) / (128 * 16), 6);
  });

  // -- loader-level parsing (qcommon/bspx.ts) -------------------------------
  //
  // NOTE: no Mod_ForName-driven full-brush-load test here. gl_model.ts's
  // Mod_LoadBrushModel enforces "the world model must be mod_known[0]", a
  // module-level singleton that is NOT reset per test file (Mod_Init only
  // clears mod_novis; Mod_FreeAll only frees a slot whose extradatasize was
  // actually set, which a load that throws before completing never
  // reaches) -- verified empirically: `bun test test/gl_model.test.ts
  // test/bspx_renderer.test.ts` throws "Loaded a brush model after the
  // world" the moment this file's own Mod_ForName call runs, because
  // gl_model.test.ts's own box-room test already permanently claimed slot
  // 0 for the rest of the process. This is the same class of constraint
  // ref_model.test.ts documents for the software renderer's identical
  // mod_known/Mod_LoadBrushModel pair (see this file's software-renderer
  // describe block below) -- a second file's brush-model load simply isn't
  // safe to add. The loader's actual per-face wiring (Mod_LoadFaces reading
  // loadmodel.bspx.decoupledLm.faces[surfnum] and populating
  // MsurfaceT.decoupledLm/samples) is exercised here one level down
  // instead: parseBspxDirectory/parseDecoupledLM (the exact functions
  // Mod_LoadBrushModel calls) against a real box-room-shaped buffer, plus
  // GL_CreateSurfaceLightmap/GL_BuildPolygonFromSurface directly above and
  // below, which is the same selection logic Mod_LoadFaces invokes per
  // face -- together this covers everything Mod_LoadFaces's override block
  // does without needing the singleton loader entry point. Real BSP
  // verification (does this actually work against genuine rerelease
  // data survive the full trip) was done loader-level too, against
  // baseq2/maps/base1.bsp's real bytes (see this unit's report).

  test("parseBspxDirectory: classic box room (no BSPX bytes appended) returns null, exactly like a BSP with no extension lump", () => {
    const bsp = buildBoxRoomBsp(undefined, { renderable: true });
    const dir = qcommonBspx.parseBspxDirectory(bsp, bsp.length, bsp.length);
    expect(dir).toBeNull();
  });

  test("parseBspxDirectory + parseDecoupledLM: DECOUPLED_LM appended to a box room round-trips every face's width/height/axis/offset exactly", () => {
    const bsp = buildBoxRoomBsp(undefined, { renderable: true });
    const full = appendDecoupledLm(bsp, SIX_BOX_FACES);

    const header = qfiles.readDheader(new DataView(full.buffer, full.byteOffset, full.byteLength), 0);
    const lumpsEnd = header.lumps.reduce((max, l) => Math.max(max, l.fileofs + l.filelen), 0);
    const dir = qcommonBspx.parseBspxDirectory(full, lumpsEnd, full.length);
    expect(dir).not.toBeNull();

    const dlm = dir?.lumps.get("DECOUPLED_LM");
    expect(dlm).toBeDefined();
    if (!dlm) throw new Error("DECOUPLED_LM lump not found");

    const numfaces = header.lumps[qfiles.LUMP_FACES].filelen / qfiles.DFACE_T_SIZE;
    const result = qcommonBspx.parseDecoupledLM(full, dlm.fileofs, dlm.filelen, numfaces, header.lumps[qfiles.LUMP_LIGHTING].filelen);
    expect(result).not.toBeNull();
    expect(result?.possiblyCorrupted).toBe(false);
    expect(result?.faces.length).toBe(6);

    for (let i = 0; i < 6; i++) {
      const face = result?.faces[i];
      const expected = SIX_BOX_FACES[i];
      expect(face?.lmWidth).toBe(expected.width);
      expect(face?.lmHeight).toBe(expected.height);
      expect(face?.lightofs).toBeNull(); // sentinel, see appendDecoupledLm's comment
      expect(face?.lmAxis[0]).toEqual(expected.axis0);
      expect(face?.lmAxis[1]).toEqual(expected.axis1);
      expect(face?.lmOffset[0]).toBeCloseTo(expected.offset0, 5);
      expect(face?.lmOffset[1]).toBeCloseTo(expected.offset1, 5);
    }
  });

  test("GL_CreateSurfaceLightmap: allocates the shared atlas block sized to decoupledLm.width/height, not a classic-extents-derived size", () => {
    glRsurf.LM_InitBlock();

    const texinfo = new glModel.MtexinfoT();
    texinfo.flags = 0;

    const surf = new glModel.MsurfaceT();
    surf.flags = 0;
    surf.texinfo = texinfo;
    surf.extents = [999, 999]; // would give a very different classic smax/tmax
    surf.decoupledLm = { width: 12, height: 7, axis: [vec3(1, 0, 0), vec3(0, 1, 0)], offset: [0, 0] };
    surf.styles = [255, 255, 255, 255]; // no styles -- R_BuildLightMap's fullbright path

    glRsurf.GL_CreateSurfaceLightmap(surf);

    // LM_InitBlock left a clean 128-wide atlas: the first allocation of any
    // size always lands at (0,0) regardless of width/height, so this alone
    // doesn't prove much -- the real proof is that it did NOT throw
    // allocating a 12x7 block (it would have tried to allocate a wildly
    // different, likely also-fitting-but-WRONG size derived from
    // extents=999 if the decoupled branch weren't wired in), and that the
    // atlas's column-height bookkeeping now reflects a 12-wide, 7-tall
    // allocation, not a 63-wide, 63-tall one ((999>>4)+1 = 63).
    expect(surf.light_s).toBe(0);
    expect(surf.light_t).toBe(0);
    const second = glRsurf.LM_AllocBlock(1, 1);
    expect(second).toEqual({ ok: true, x: 12, y: 0 }); // packed right next to the 12-wide decoupled block, not a 63-wide one
  });

  // -- R_LightPoint (gl_light.ts's RecursiveLightPoint) ---------------------

  test("R_LightPoint: DECOUPLED_LM surface samples via lm_axis/lm_offset/lm_width instead of the classic texinfo/extents grid", () => {
    const model = new glModel.ModelT();
    model.lightdata = new Uint8Array(64);

    const surf = new glModel.MsurfaceT();
    surf.flags = 0;
    surf.styles = [0, 255, 255, 255];
    surf.decoupledLm = { width: 4, height: 4, axis: [vec3(1, 0, 0), vec3(0, 1, 0)], offset: [0, 0] };
    // texel (2,1) in a 4-wide grid -> offset 3*(1*4+2) = 18
    const texelOffset = 3 * (1 * 4 + 2);
    surf.samples = model.lightdata;
    surf.samples[texelOffset] = 100;
    surf.samples[texelOffset + 1] = 150;
    surf.samples[texelOffset + 2] = 200;
    model.surfaces = [surf];

    const cplane = new CplaneT();
    cplane.normal = vec3(0, 0, 1);
    cplane.dist = 0;
    cplane.type = 2;
    surf.plane = cplane;

    const node = new glModel.MnodeT();
    node.contents = glModel.CONTENTS_NODE;
    node.plane = cplane;
    node.children = [new glModel.MleafT(), new glModel.MleafT()];
    node.firstsurface = 0;
    node.numsurfaces = 1;

    model.nodes = [node];
    model.numnodes = 1;

    glLocal.SetWorldModel(model);
    glLocal.r_newrefdef.lightstyles[0] = { rgb: vec3(1, 1, 1), white: 1 };

    // start above the surface (z=10, plane at z=0, normal +Z means "in
    // front" is z>0), end below it (z=-10) -- straddles the plane, and the
    // crossing point's (x,y) = (2,1) matches decoupledLm.axis/offset above.
    const color = vec3();
    glLight.R_LightPoint(vec3(2, 1, 10), color);

    expect(color[0]).toBeCloseTo(100 / 255, 4);
    expect(color[1]).toBeCloseTo(150 / 255, 4);
    expect(color[2]).toBeCloseTo(200 / 255, 4);

    glLocal.SetWorldModel(null);
  });

  test("R_LightPoint: classic (non-decoupled) surface still samples via texinfo/texturemins/extents unaffected", () => {
    const model = new glModel.ModelT();
    model.lightdata = new Uint8Array(64);

    const texinfo = new glModel.MtexinfoT();
    texinfo.vecs = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];

    const surf = new glModel.MsurfaceT();
    surf.flags = 0;
    surf.styles = [0, 255, 255, 255];
    surf.texinfo = texinfo;
    surf.texturemins = [0, 0];
    surf.extents = [64, 64]; // smax = (64>>4)+1 = 5
    // point (18,17) -> ds=(18-0)>>4=1, dt=(17-0)>>4=1 -> offset 3*(1*5+1)=18
    const texelOffset = 3 * (1 * 5 + 1);
    surf.samples = model.lightdata;
    surf.samples[texelOffset] = 10;
    surf.samples[texelOffset + 1] = 20;
    surf.samples[texelOffset + 2] = 30;
    model.surfaces = [surf];

    const cplane = new CplaneT();
    cplane.normal = vec3(0, 0, 1);
    cplane.dist = 0;
    cplane.type = 2;
    surf.plane = cplane;

    const node = new glModel.MnodeT();
    node.contents = glModel.CONTENTS_NODE;
    node.plane = cplane;
    node.children = [new glModel.MleafT(), new glModel.MleafT()];
    node.firstsurface = 0;
    node.numsurfaces = 1;

    model.nodes = [node];
    model.numnodes = 1;

    glLocal.SetWorldModel(model);
    glLocal.r_newrefdef.lightstyles[0] = { rgb: vec3(1, 1, 1), white: 1 };

    const color = vec3();
    glLight.R_LightPoint(vec3(18, 17, 10), color);

    expect(color[0]).toBeCloseTo(10 / 255, 4);
    expect(color[1]).toBeCloseTo(20 / 255, 4);
    expect(color[2]).toBeCloseTo(30 / 255, 4);

    glLocal.SetWorldModel(null);
  });
});

// ---------------------------------------------------------------------------
// Software renderer: src/ref_soft/r_model.ts -- per-surface fullbright
// fallback (loads and renders, no whole-map refusal)
// ---------------------------------------------------------------------------

describe("Software renderer -- BSPX DECOUPLED_LM fullbright fallback", () => {
  const filesSoft = new Map<string, Uint8Array>();
  let conPrints: string[] = [];

  function registerSoft(name: string, data: Uint8Array): void {
    filesSoft.set(name, data);
  }

  function makeFakeRiSoft(): RefImports {
    return {
      Sys_Error(_level: number, str: string): never {
        throw new Error(str);
      },
      Cmd_AddCommand: () => undefined,
      Cmd_RemoveCommand: () => undefined,
      Cmd_Argc: () => 0,
      Cmd_Argv: () => "",
      Cmd_ExecuteText: () => undefined,
      Con_Printf: (_level: number, str: string) => {
        conPrints.push(str);
      },
      FS_LoadFile: (name: string) => {
        const data = filesSoft.get(name);
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

  // Mod_LoadBrushModel enforces "the world model must be mod_known[0]", a
  // module-level singleton (mod_known/mod_numknown/loadmodel) that
  // Mod_FreeAll() never actually frees for a brush model (its
  // extradatasize is only set after a load completes, past the point
  // this unit's own refusal throws) -- and test/ref_model.test.ts already
  // permanently claims that singleton the moment it runs anywhere in the
  // same `bun test` invocation (verified empirically: `bun test
  // test/ref_model.test.ts test/bspx_renderer.test.ts` reports "Loaded a
  // brush model after the world" the instant this describe block's own
  // Mod_ForName call runs). r_model.ts's relative `import ... from
  // "./r_local"` always resolves to the plain (query-string-free) module
  // regardless of what specifier this file imports r_model.ts itself
  // under, so importing r_model.ts through a private, file-scoped query
  // string gives this describe block its OWN independent
  // mod_known/mod_numknown/loadmodel (a fresh top-level module instance --
  // verified empirically the same way) while still sharing the plain
  // r_local.ts's `ri` binding every other test file already configures
  // through SetRefImports, same as normal.
  let rLocal: typeof import("../src/ref_soft/r_local");
  let rModel: typeof import("../src/ref_soft/r_model");

  // A fresh query string per test, not just per file: within this describe
  // block, two tests sharing one busted r_model.ts instance would collide
  // with EACH OTHER the exact same way (mod_known[0] claimed by the first
  // test's load never gets freed for the second's differently-named one).
  // Built from a concatenation rather than a literal so tsc can't try (and
  // fail) to resolve module type declarations for a query-stringed path --
  // the runtime import below still receives the real string.
  let isolationCounter = 0;

  beforeEach(async () => {
    isolationCounter++;
    conPrints = [];
    rLocal = await import("../src/ref_soft/r_local");
    rModel = await import("../src/ref_soft/r_model" + "?bspx_renderer_test_isolation_" + isolationCounter);

    rLocal.SetRefImports(makeFakeRiSoft());
    rModel.Mod_Init();
    rModel.Mod_FreeAll();
  });

  test("Mod_ForName: BSPX DECOUPLED_LM box room loads successfully with a one-time fullbright-fallback warning (no whole-map refusal)", () => {
    const name = "maps/decoupled.bsp";
    registerSoft(name, appendDecoupledLm(buildBoxRoomBsp(undefined, { renderable: true }), SIX_BOX_FACES));

    const model = rModel.Mod_ForName(name, false);

    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    // loads all 6 faces -- no whole-map refusal.
    expect(model.numsurfaces).toBe(6);
    expect(rModel.loadmodel.bspx?.decoupledLm).not.toBeNull();

    // exactly one summary warning explaining the fullbright degrade, not a
    // Sys_Error/thrown refusal.
    const warnings = conPrints.filter((s) => s.includes("DECOUPLED_LM") && s.includes("fullbright"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/does not consume BSPX data/);
  });

  test("Mod_ForName: classic box room (no BSPX) is never rejected by the DECOUPLED_LM check, and Mod_LoadFaces populates all 6 faces", () => {
    const name = "maps/classic.bsp";
    registerSoft(name, buildBoxRoomBsp(undefined, { renderable: true }));

    const model = rModel.Mod_ForName(name, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    expect(model.bspx).toBeNull();
    // 6, not 12: r_rast.ts's R_InitSkyBox (called at the very end of
    // Mod_LoadBrushModel) resolves its own `modelMod()` lazy binding back
    // to r_rast.ts's own copy of that circular link, which -- unlike this
    // file's own r_model.ts import above -- was never repointed at this
    // test's isolated instance, so its 6 appended sky faces land on the
    // ordinary shared r_model.ts module instead of this one. That's a
    // test-harness isolation artifact (see this describe block's own
    // comment), not something a real process ever does (it only ever has
    // one r_model.ts instance) -- Mod_LoadFaces itself, which this test
    // actually exercises, still populates all 6 real faces right here.
    expect(model.numsurfaces).toBe(6);
  });
});
