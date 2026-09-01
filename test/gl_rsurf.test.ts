/*
Tests for src/ref_gl/gl_warp.ts and src/ref_gl/gl_rsurf.ts, per this unit's
brief (rule 13): self-sufficient, no reliance on any other test file having
run first. Each test sets up exactly the shared module state it reads and
resets what it mutated (QGL recording, sky bounds, r_alpha_surfaces, view
frame counters).
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3 } from "../src/shared/math";
import { CplaneT, SURF_TRANS33 } from "../src/shared/q_shared";
import { PLANE_X } from "../src/qcommon/qfiles";
import { MsurfaceT, MtexinfoT, GlpolyT, MnodeT, MleafT, ModelT, VERTEXSIZE, CONTENTS_NODE } from "../src/ref_gl/gl_model";
import { SetWorldModel, SetVisFrameCount, SetFrameCount, r_newrefdef } from "../src/ref_gl/gl_local";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { SubdividePolygon, setWarpfaceForTesting, EmitWaterPolys, ClipSkyPolygon, R_ClearSkyBox, skymins, skymaxs } from "../src/ref_gl/gl_warp";
import { LM_InitBlock, LM_AllocBlock, R_RecursiveWorldNode, R_DrawAlphaSurfaces, R_BlendLightmaps, r_alpha_surfaces } from "../src/ref_gl/gl_rsurf";
import { GL_ShutdownShaderPath } from "../src/ref_gl/gl_shader";

beforeEach(() => {
  setWarpfaceForTesting(null);
  r_newrefdef.time = 0;
  SetQGL(new QGLRecording());
});

describe("gl_rsurf.ts -- LM_AllocBlock", () => {
  test("packs rects without overlap, stacking vertically, and fails once the block is full", () => {
    LM_InitBlock();

    const first = LM_AllocBlock(64, 64);
    expect(first).toEqual({ ok: true, x: 0, y: 0 });

    // BLOCK_WIDTH=128, so a second 64-wide request re-scans columns 0..63:
    // the greedy left-to-right skyline scan finds its lowest valid shelf at
    // the same x=0 column range (already raised to height 64 by the first
    // allocation), stacking directly on top rather than moving right.
    const second = LM_AllocBlock(64, 64);
    expect(second).toEqual({ ok: true, x: 0, y: 64 });

    // a third 64-tall request at that same column now needs height 128+64,
    // exceeding BLOCK_HEIGHT (128) -- must fail without allocating anything.
    const third = LM_AllocBlock(64, 64);
    expect(third).toEqual({ ok: false, x: 0, y: 0 });
  });
});

describe("gl_rsurf.ts -- R_BlendLightmaps depth/blend state (vanilla gl_rsurf.c:315-470)", () => {
  // The lightmap blend pass re-draws polygons the texture pass already drew,
  // exactly coplanar. Vanilla relies on two things and nothing else to keep
  // that from z-fighting: qglDepthMask(0) so the second pass never writes Z,
  // and the GL_LEQUAL depth func GL_SetDefaultState left in place so a tie
  // still passes. It never touches qglDepthFunc, qglPolygonOffset, or
  // qglDepthRange here -- a "fix" that reached for any of those would be
  // papering over a position-invariance bug instead of fixing it.
  const GL_ZERO = 0;
  const GL_SRC_COLOR = 0x0300;
  const GL_SRC_ALPHA = 0x0302;
  const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
  const GL_BLEND = 0x0be2;

  function runBlendPass(): QGLRecording {
    // rule 13: gl_shaders.test.ts's GL_InitShaderPath leaves gl_shader.ts's
    // module-global shaderPathActive set, which would add qglUseProgram/
    // qglUniform1i calls here depending on file order. Force the
    // fixed-function path so this pin is order-independent.
    GL_ShutdownShaderPath();
    const rec = new QGLRecording();
    SetQGL(rec);
    const world = new ModelT();
    world.lightdata = new Uint8Array(4); // R_BlendLightmaps early-outs without it
    SetWorldModel(world);
    R_BlendLightmaps();
    SetWorldModel(null);
    return rec;
  }

  test("brackets the pass with DepthMask(0)/DepthMask(1) and the vanilla modulate blendfunc", () => {
    const names = runBlendPass().calls;
    const seq = names.map((c) => `${c.name}(${c.args.join(",")})`);

    expect(seq).toEqual([
      "qglDepthMask(false)",
      `qglEnable(${GL_BLEND})`,
      `qglBlendFunc(${GL_ZERO},${GL_SRC_COLOR})`,
      `qglDisable(${GL_BLEND})`,
      `qglBlendFunc(${GL_SRC_ALPHA},${GL_ONE_MINUS_SRC_ALPHA})`,
      "qglDepthMask(true)",
    ]);
  });

  test("never reaches for a depth-func/offset/range workaround", () => {
    const called = new Set(runBlendPass().calls.map((c) => c.name));
    expect(called.has("qglDepthFunc")).toBe(false);
    expect(called.has("qglPolygonOffset")).toBe(false);
    expect(called.has("qglDepthRange")).toBe(false);
  });
});

describe("gl_warp.ts -- SubdividePolygon", () => {
  test("splits a large quad at a SUBDIVIDE_SIZE (64 unit) x-axis boundary into two 6-vert polys", () => {
    // quad spans x in [0,100] (crosses the 64-unit boundary) and y in [0,4]
    // (under the 8-unit "too thin to bother cutting" threshold, so only the
    // x axis gets cut). Hand-traced result: one cut at x=64 produces a
    // front piece [64,100]x[0,4] and a back piece [0,64]x[0,4], each a
    // plain quad (4 verts) that no longer needs further cutting on any
    // axis -- SubdividePolygon's base case pads each with a center vertex
    // and a repeated first vertex (`numverts+2` = 6).
    const fa = new MsurfaceT();
    const texinfo = new MtexinfoT();
    texinfo.vecs = [new Float32Array([1, 0, 0, 0]), new Float32Array([0, 1, 0, 0])];
    fa.texinfo = texinfo;
    setWarpfaceForTesting(fa);

    const quad = [vec3(0, 0, 0), vec3(100, 0, 0), vec3(100, 4, 0), vec3(0, 4, 0)];
    SubdividePolygon(quad);

    const polys: GlpolyT[] = [];
    for (let p = fa.polys; p; p = p.next) polys.push(p);

    expect(polys).toHaveLength(2);
    expect(polys[0]?.numverts).toBe(6);
    expect(polys[1]?.numverts).toBe(6);
  });
});

describe("gl_warp.ts -- EmitWaterPolys", () => {
  test("records qglVertex3fv/qglTexCoord2f calls with texcoords matching the r_turbsin warp at a fixed time", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    r_newrefdef.time = 5.0;

    const os = 16;
    const ot = 32;
    const row = new Float32Array(VERTEXSIZE);
    row[0] = 1;
    row[1] = 2;
    row[2] = 3;
    row[3] = os;
    row[4] = ot;

    const poly = new GlpolyT();
    poly.numverts = 1;
    poly.verts = [row];

    const fa = new MsurfaceT();
    fa.texinfo = null; // no SURF_FLOWING -> scroll = 0
    fa.polys = poly;

    EmitWaterPolys(fa);

    // hand-computed against gl_warp.c's formula: r_turbsin[i] === 8*sin(i * 2*PI/256)
    const TURBSCALE = 256.0 / (2 * Math.PI);
    const turbsin = (i: number): number => 8 * Math.sin(((i & 255) * 2 * Math.PI) / 256);
    const idxS = Math.trunc((ot * 0.125 + 5.0) * TURBSCALE) & 255;
    const idxT = Math.trunc((os * 0.125 + 5.0) * TURBSCALE) & 255;
    const expectedS = (os + turbsin(idxS)) * (1.0 / 64);
    const expectedT = (ot + turbsin(idxT)) * (1.0 / 64);

    expect(rec.calls.map((c) => c.name)).toEqual(["qglBegin", "qglTexCoord2f", "qglVertex3fv", "qglEnd"]);
    expect(rec.calls[0]?.args).toEqual([0x0006]); // GL_TRIANGLE_FAN
    const texcoordArgs = rec.calls[1]?.args;
    expect(texcoordArgs?.[0]).toBeCloseTo(expectedS, 5);
    expect(texcoordArgs?.[1]).toBeCloseTo(expectedT, 5);
    expect(rec.calls[2]?.args).toEqual([row]);
  });
});

describe("gl_warp.ts -- ClipSkyPolygon", () => {
  test("clips a triangle straddling skyclip[5] into a +Z-face piece and a +X-face piece with hand-computed bounds", () => {
    R_ClearSkyBox();

    // skyclip[5] = (-1,0,1): d = -x+z. v0,v2 land in front (d=10), v1 lands
    // in back (d=-10) -- guaranteed split at this single stage.
    const v0 = vec3(0, 0, 10);
    const v1 = vec3(20, 0, 10);
    const v2 = vec3(0, 10, 10);

    ClipSkyPolygon([v0, v1, v2], 5);

    // front piece (axis 4, +Z "look up"): s = -y/z, t = -x/z over
    // [v0, clip(10,0,10), clip2(10,5,10), v2] -> s in [-1,0], t in [-1,0].
    expect(skymins[0][4]).toBeCloseTo(-1, 5);
    expect(skymaxs[0][4]).toBeCloseTo(0, 5);
    expect(skymins[1][4]).toBeCloseTo(-1, 5);
    expect(skymaxs[1][4]).toBeCloseTo(0, 5);

    // back piece (axis 0, +X): s = -y/x, t = z/x over
    // [clip(10,0,10), v1(20,0,10), clip2(10,5,10)] -> s in [-0.5,0], t in [0.5,1].
    expect(skymins[0][0]).toBeCloseTo(-0.5, 5);
    expect(skymaxs[0][0]).toBeCloseTo(0, 5);
    expect(skymins[1][0]).toBeCloseTo(0.5, 5);
    expect(skymaxs[1][0]).toBeCloseTo(1, 5);

    // untouched faces stay at R_ClearSkyBox's baseline
    for (const face of [1, 2, 3, 5]) {
      expect(skymins[0][face]).toBe(9999);
      expect(skymaxs[0][face]).toBe(-9999);
    }
  });
});

describe("gl_rsurf.ts -- R_RecursiveWorldNode", () => {
  test("visits front subtree before back subtree on a fabricated node/leaf tree", () => {
    R_DrawAlphaSurfaces(); // reset r_alpha_surfaces to null regardless of prior state

    SetVisFrameCount(7);
    SetFrameCount(3);

    const makeLeaf = (): MleafT => {
      const leaf = new MleafT();
      leaf.contents = 0; // non-solid
      leaf.visframe = 7;
      leaf.area = 0;
      leaf.firstmarksurface = [];
      leaf.nummarksurfaces = 0;
      return leaf;
    };

    const makePlane = (): CplaneT => {
      const plane = new CplaneT();
      plane.type = PLANE_X;
      plane.normal = vec3(1, 0, 0);
      plane.dist = -10; // dot = modelorg[0] - (-10) = 10 >= 0 regardless of modelorg
      return plane;
    };

    const surfFront = new MsurfaceT();
    surfFront.flags = 0; // matches sidebit 0
    surfFront.visframe = 3;
    const surfFrontTexinfo = new MtexinfoT();
    surfFrontTexinfo.flags = SURF_TRANS33;
    surfFront.texinfo = surfFrontTexinfo;

    const surfBack = new MsurfaceT();
    surfBack.flags = 0;
    surfBack.visframe = 3;
    const surfBackTexinfo = new MtexinfoT();
    surfBackTexinfo.flags = SURF_TRANS33;
    surfBack.texinfo = surfBackTexinfo;

    const fakeModel = new ModelT();
    fakeModel.surfaces = [surfFront, surfBack];
    SetWorldModel(fakeModel);

    const frontNode = new MnodeT();
    frontNode.contents = CONTENTS_NODE;
    frontNode.visframe = 7;
    frontNode.plane = makePlane();
    frontNode.children = [makeLeaf(), makeLeaf()];
    frontNode.firstsurface = 0;
    frontNode.numsurfaces = 1;

    const backNode = new MnodeT();
    backNode.contents = CONTENTS_NODE;
    backNode.visframe = 7;
    backNode.plane = makePlane();
    backNode.children = [makeLeaf(), makeLeaf()];
    backNode.firstsurface = 1;
    backNode.numsurfaces = 1;

    const root = new MnodeT();
    root.contents = CONTENTS_NODE;
    root.visframe = 7;
    root.plane = makePlane();
    root.children = [frontNode, backNode];
    root.numsurfaces = 0;

    R_RecursiveWorldNode(root);

    // frontNode's surface is pushed onto r_alpha_surfaces before backNode's
    // (front side recursed first, per the C source's own comment), so the
    // stack-push order leaves surfBack on top with surfFront right behind it.
    expect(r_alpha_surfaces).toBe(surfBack);
    expect(surfBack.texturechain).toBe(surfFront);
    expect(surfFront.texturechain).toBeNull();

    SetWorldModel(null);
  });
});
