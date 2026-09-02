/*
Test support for src/ref_gl/gl_model.ts and src/ref_gl/gl_light.ts (ported
from ref_gl/gl_model.c and ref_gl/gl_light.c).

Self-sufficient per PORTING.md rule 13: every test below initializes the
globals it reads (SetRefImports, Mod_Init, Mod_FreeAll, SetNoTexture) in its
own beforeEach, and does not rely on another test file having run first.

Reuses test/support/bsp_builder.ts's buildBoxRoomBsp({renderable:true}) for
the brush-model suite (node/leaf tree, GL polygon build, submodel count) --
unlike ref_soft/r_model.ts's own test file, this one does not need to avoid
texinfo/faces: GL_FindImage (gl_image.ts) is a real, fully implemented
function now, but a synthetic BSP's texture names never resolve to a real
file on disk, so gl_model.ts's Mod_LoadTexinfo falls back to r_notexture on
the resulting null return (see gl_model.ts's file header), so a fake
width/height texture registered via SetNoTexture is enough to let the whole
brush-model load run to completion, including GL_BuildPolygonFromSurface.
*/

import { afterAll, describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports, SetNoTexture, ImageT } from "../src/ref_gl/gl_local";
import { SetQGL } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";
import { vec3 } from "../src/shared/math";
import { CplaneT, CONTENTS_SOLID } from "../src/shared/q_shared";
import {
  Mod_FreeAll,
  Mod_TestFreeAllKnown,
  Mod_ForName,
  Mod_PointInLeaf,
  Mod_Init,
  mod_inline,
  ModtypeT,
  isMleaf,
  ParsedMd2T,
  ParsedSp2T,
  IDALIASHEADER,
  ALIAS_VERSION,
  IDSPRITEHEADER,
  SPRITE_VERSION,
  MAX_MD2SKINS,
  MtexinfoT,
  MsurfaceT,
  MnodeT,
  MleafT,
} from "../src/ref_gl/gl_model";
import { R_BuildLightMap, R_MarkLights } from "../src/ref_gl/gl_light";
import { ModelT } from "../src/ref_gl/gl_model";
import { SetWorldModel, r_newrefdef, glCvars } from "../src/ref_gl/gl_local";
import { LightstyleT } from "../src/client/ref";
import { buildBoxRoomBsp, ROOM_HALF } from "./support/bsp_builder";

// ---------------------------------------------------------------------------
// fake `ri` -- FS_LoadFile serves buffers registered by name; Sys_Error
// throws a plain Error carrying the message so tests can match on it.
// ---------------------------------------------------------------------------

const files = new Map<string, Uint8Array>();

function registerFile(name: string, data: Uint8Array): void {
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

// Rule 13: leave gl_model.ts's mod_known/mod_inline table exactly as empty
// as a fresh process would. The "Mod_ForName: dispatch and error paths"
// describe below loads models that Sys_Error out partway, which leaves
// mod_known slots holding a NAME with extradatasize 0 -- the one thing
// Mod_FreeAll cannot reclaim -- and a leftover slot 0 pushes a LATER file's
// world model into mod_known[1], tripping Mod_LoadBrushModel's "Loaded a
// brush model after the world" guard there (test/mod_leaf_marksurfaces.test.ts
// is the file that noticed). See Mod_TestFreeAllKnown's own comment.
afterAll(() => {
  Mod_TestFreeAllKnown();
});

beforeEach(() => {
  SetRefImports(makeFakeRi());
  Mod_Init();
  Mod_TestFreeAllKnown(); // not Mod_FreeAll -- see the afterAll above

  // GL_FindImage (gl_image.ts) is real now, but a synthetic BSP's texture
  // names never resolve to a real file on disk, so gl_model.ts's
  // Mod_LoadTexinfo/Mod_LoadAliasModel/Mod_LoadSpriteModel fall back to
  // r_notexture on that null return -- give it real dimensions so
  // GL_BuildPolygonFromSurface's `s /= image.width` doesn't divide by a
  // null image.
  const fakeTex = new ImageT();
  fakeTex.width = 64;
  fakeTex.height = 64;
  SetNoTexture(fakeTex);

  // gl_image.ts owns the shared QGL binding other landed gl_*.ts units
  // consolidated on; gl_rsurf.ts's real GL_BeginBuildingLightmaps/
  // GL_EndBuildingLightmaps call into it (GL_EnableMultitexture/
  // GL_SelectTexture/GL_Bind/qglTexParameterf/qglTexImage2D) while building
  // Mod_LoadFaces's lightmaps -- wire up a recording fake so brush model
  // loading can run to completion without a real GL context.
  SetQGL(new QGLRecording());
});

// ---------------------------------------------------------------------------
// minimal MD2 builder: header + 1 st vert + 1 triangle + 1 frame (1 vertex)
// + a 2-vertex triangle-strip glcmds block + 1 skin name.
// ---------------------------------------------------------------------------

function buildTestMd2WithGlcmds(): Uint8Array {
  const DMDL_HEADER_SIZE = 68;
  const ofsSt = DMDL_HEADER_SIZE;
  const ofsTris = ofsSt + 4; // 1 dstvert_t (2 shorts)
  const ofsFrames = ofsTris + 12; // 1 dtriangle_t (6 shorts)
  const frameSize = 40 + 1 * 4; // daliasframe_t header + 1 dtrivertx_t
  const ofsGlcmds = ofsFrames + frameSize;

  // one triangle strip of 3 verts: [3, s0,t0,idx0, s1,t1,idx1, s2,t2,idx2, 0]
  const glcmds = [3, 111, 211, 0, 112, 212, 1, 113, 213, 2, 0];
  const numGlcmds = glcmds.length;

  const ofsSkins = ofsGlcmds + numGlcmds * 4;
  const skinBytes = 64;
  const ofsEnd = ofsSkins + skinBytes;

  const buf = new Uint8Array(ofsEnd);
  const view = new DataView(buf.buffer);

  view.setInt32(0, IDALIASHEADER, true);
  view.setInt32(4, ALIAS_VERSION, true);
  view.setInt32(8, 32, true); // skinwidth
  view.setInt32(12, 32, true); // skinheight
  view.setInt32(16, frameSize, true); // framesize
  view.setInt32(20, 1, true); // num_skins
  view.setInt32(24, 1, true); // num_xyz
  view.setInt32(28, 1, true); // num_st
  view.setInt32(32, 1, true); // num_tris
  view.setInt32(36, numGlcmds, true); // num_glcmds
  view.setInt32(40, 1, true); // num_frames
  view.setInt32(44, ofsSkins, true); // ofs_skins
  view.setInt32(48, ofsSt, true); // ofs_st
  view.setInt32(52, ofsTris, true); // ofs_tris
  view.setInt32(56, ofsFrames, true); // ofs_frames
  view.setInt32(60, ofsGlcmds, true); // ofs_glcmds
  view.setInt32(64, ofsEnd, true); // ofs_end

  view.setInt16(ofsSt, 0, true);
  view.setInt16(ofsSt + 2, 0, true);

  view.setInt16(ofsTris, 0, true);
  view.setInt16(ofsTris + 2, 0, true);
  view.setInt16(ofsTris + 4, 0, true);
  view.setInt16(ofsTris + 6, 0, true);
  view.setInt16(ofsTris + 8, 0, true);
  view.setInt16(ofsTris + 10, 0, true);

  view.setFloat32(ofsFrames, 1, true);
  view.setFloat32(ofsFrames + 4, 1, true);
  view.setFloat32(ofsFrames + 8, 1, true);
  view.setFloat32(ofsFrames + 12, 0, true);
  view.setFloat32(ofsFrames + 16, 0, true);
  view.setFloat32(ofsFrames + 20, 0, true);
  const name = "frame1";
  for (let i = 0; i < name.length; i++) view.setUint8(ofsFrames + 24 + i, name.charCodeAt(i));
  view.setUint8(ofsFrames + 40, 1);
  view.setUint8(ofsFrames + 41, 2);
  view.setUint8(ofsFrames + 42, 3);
  view.setUint8(ofsFrames + 43, 7);

  for (let i = 0; i < numGlcmds; i++) view.setInt32(ofsGlcmds + i * 4, glcmds[i], true);

  const skin = "models/test/skin.pcx";
  for (let i = 0; i < skin.length; i++) view.setUint8(ofsSkins + i, skin.charCodeAt(i));

  return buf;
}

function buildTestSp2(numFrames: 0): Uint8Array {
  const buf = new Uint8Array(12);
  const view = new DataView(buf.buffer);
  view.setInt32(0, IDSPRITEHEADER, true);
  view.setInt32(4, SPRITE_VERSION, true);
  view.setInt32(8, numFrames, true);
  return buf;
}

// ---------------------------------------------------------------------------
// Mod_LoadBrushModel enforces "the world model must be mod_known[0]"; this
// must be the first test in the file that actually reaches Mod_LoadBrushModel
// (same file-ordering rule ref_soft/test/ref_model.test.ts documents).
// ---------------------------------------------------------------------------

describe("Mod_LoadBrushModel: node/leaf tree, GL polygons, submodels over a renderable box room", () => {
  const name = "maps/testroom.bsp";
  registerFile(name, buildBoxRoomBsp(undefined, { renderable: true }));

  test("loads planes/nodes/leafs/submodels; node/leaf tree walks correctly", () => {
    const model = Mod_ForName(name, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    expect(model.type).toBe(ModtypeT.mod_brush);
    expect(model.numsubmodels).toBe(1);
    expect(model.numplanes).toBe(6);
    expect(model.numnodes).toBe(6);
    expect(model.numleafs).toBe(2);
    expect(model.numsurfaces).toBe(6);
    expect(model.numedges).toBe(25);

    const insideLeaf = Mod_PointInLeaf(vec3(0, 0, 0), model);
    expect(isMleaf(insideLeaf)).toBe(true);
    expect(insideLeaf.contents & CONTENTS_SOLID).toBe(0);

    const wallLeaf = Mod_PointInLeaf(vec3(200, 0, 0), model);
    expect(wallLeaf.contents & CONTENTS_SOLID).toBe(CONTENTS_SOLID);

    // submodel 0 is the whole map: firstnode 0, bounds padded by a pixel
    const inline0 = mod_inline[0];
    expect(inline0.firstnode).toBe(0);
    expect(inline0.mins[0]).toBeCloseTo(-ROOM_HALF - 1);
    expect(inline0.maxs[0]).toBeCloseTo(ROOM_HALF + 1);
  });

  test("Mod_LoadFaces builds one GlpolyT per face with vert count == numedges", () => {
    // fresh beforeEach means this test must load the world map itself
    // (Mod_LoadBrushModel requires mod_known[0]); it does not reuse state
    // from the describe block's first test.
    const model = Mod_ForName(name, false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not found");

    expect(model.surfaces.length).toBe(6);
    for (const surf of model.surfaces) {
      expect(surf.numedges).toBe(4);
      expect(surf.polys).not.toBeNull();
      if (!surf.polys) continue;
      expect(surf.polys.numverts).toBe(4);
      expect(surf.polys.verts.length).toBe(4);
      // each vertex row is (xyz, s,t, lightmap-s,lightmap-t) = 7 floats
      for (const row of surf.polys.verts) expect(row.length).toBe(7);
    }
  });
});

describe("Mod_ForName: dispatch and error paths", () => {
  test("NULL name throws Sys_Error", () => {
    expect(() => Mod_ForName("", false)).toThrow(/NULL name/);
  });

  test("unrecognized fileid throws Sys_Error", () => {
    const buf = new Uint8Array(16);
    new DataView(buf.buffer).setInt32(0, 0xdeadbeef | 0, true);
    registerFile("models/bad.dat", buf);
    expect(() => Mod_ForName("models/bad.dat", false)).toThrow(/unknown fileid/);
  });

  test("not found without crash returns null, with crash throws", () => {
    expect(Mod_ForName("models/missing.md2", false)).toBeNull();
    expect(() => Mod_ForName("models/missing2.md2", true)).toThrow(/not found/);
  });
});

describe("Mod_LoadAliasModel: hand-built minimal MD2 with a glcmds triangle strip", () => {
  test("parses frame/vertex/triangle counts and the raw glcmds strip", () => {
    registerFile("models/test0.md2", buildTestMd2WithGlcmds());
    const model = Mod_ForName("models/test0.md2", false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");

    expect(model.type).toBe(ModtypeT.mod_alias);
    expect(model.extradata).toBeInstanceOf(ParsedMd2T);
    if (!(model.extradata instanceof ParsedMd2T)) throw new Error("extradata not ParsedMd2T");

    expect(model.extradata.num_frames).toBe(1);
    expect(model.extradata.num_xyz).toBe(1);
    expect(model.extradata.num_tris).toBe(1);
    expect(model.extradata.num_st).toBe(1);
    expect(model.extradata.frames[0].verts.length).toBe(1);
    expect(model.extradata.triangles[0].index_xyz).toEqual([0, 0, 0]);
    expect(model.extradata.num_skins).toBe(1);
    expect(model.extradata.skinnames[0]).toBe("models/test/skin.pcx");

    // brush/alias models get a synthetic mins/maxs box in gl_model.c's own
    // Mod_LoadAliasModel (ref_soft's port has no equivalent).
    expect(model.mins).toEqual(vec3(-32, -32, -32));
    expect(model.maxs).toEqual(vec3(32, 32, 32));

    // decode the raw glcmds ints into the documented MD2 strip/fan layout:
    // a nonzero count (positive = triangle strip, negative = fan) followed
    // by `|count|` (s, t, vertexindex) int triples, terminated by a 0 count.
    const glcmds = model.extradata.glcmds;
    let idx = 0;
    const strips: Array<{ kind: "strip" | "fan"; indices: number[] }> = [];
    for (;;) {
      const count = glcmds[idx++];
      if (count === 0) break;
      const n = Math.abs(count);
      const indices: number[] = [];
      for (let v = 0; v < n; v++) {
        idx += 2; // s, t
        indices.push(glcmds[idx++]);
      }
      strips.push({ kind: count > 0 ? "strip" : "fan", indices });
    }

    expect(strips.length).toBe(1);
    expect(strips[0].kind).toBe("strip");
    expect(strips[0].indices).toEqual([0, 1, 2]);
    expect(idx).toBe(glcmds.length); // fully consumed, terminator included
  });
});

describe("Mod_LoadSpriteModel", () => {
  test("0-frame sprite loads fully", () => {
    registerFile("sprites/test.sp2", buildTestSp2(0));
    const model = Mod_ForName("sprites/test.sp2", false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");
    expect(model.type).toBe(ModtypeT.mod_sprite);
    expect(model.extradata).toBeInstanceOf(ParsedSp2T);
    if (model.extradata instanceof ParsedSp2T) {
      expect(model.extradata.numframes).toBe(0);
    }
  });

  test("wrong version throws Sys_Error", () => {
    const buf = new Uint8Array(12);
    const view = new DataView(buf.buffer);
    view.setInt32(0, IDSPRITEHEADER, true);
    view.setInt32(4, 999, true);
    view.setInt32(8, 0, true);
    registerFile("sprites/badversion.sp2", buf);
    expect(() => Mod_ForName("sprites/badversion.sp2", false)).toThrow(/wrong version number/);
  });
});

describe("Mod_Init / MAX_MD2SKINS", () => {
  test("Mod_Init does not throw", () => {
    expect(() => Mod_Init()).not.toThrow();
  });

  test("MAX_MD2SKINS matches qfiles.h", () => {
    expect(MAX_MD2SKINS).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// R_BuildLightMap (gl_light.ts): combine two lightmap styles into the GL
// RGBA block format, hand-computed.
// ---------------------------------------------------------------------------

describe("R_BuildLightMap: combines two styles into the GL RGBA block format", () => {
  test("matches a hand-computed 2x2 texel block", () => {
    const surf = new MsurfaceT();
    surf.texinfo = new MtexinfoT();
    surf.extents = [16, 16]; // smax = tmax = (16>>4)+1 = 2 -> 2x2 = 4 texels
    surf.styles = [0, 1, 255, 255];

    // style 0 samples (4 texels x RGB), then style 1 samples immediately after
    surf.samples = new Uint8Array([
      10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, // style 0
      2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, // style 1
    ]);

    // r_newrefdef.lightstyles is populated by gl_model.ts's
    // GL_BeginBuildingLightmaps in real use; build it directly here since
    // this test exercises R_BuildLightMap in isolation. gl_modulate/
    // gl_monolightmap need to be unset (null): R_BuildLightMap falls back
    // to modulate=1 and monolightmap="0", matching this test's hand
    // computation below (scale 1.0 and 0.5 respectively) -- rule 13:
    // glCvars (src/ref_gl/gl_local.ts) is a process-wide singleton other
    // test files' real R_Register() calls populate (e.g.
    // test/cvar_parity.test.ts registers gl_modulate="2"), so pin this
    // test's own precondition instead of assuming nothing else in the run
    // has ever registered it (same pattern as test/gl_rmain.test.ts's own
    // `glCvars.r_nocull = null` and test/gl_mesh.test.ts's own resets).
    glCvars.gl_modulate = null;
    glCvars.gl_monolightmap = null;
    r_newrefdef.lightstyles = [];
    for (let i = 0; i < 2; i++) {
      const ls = new LightstyleT();
      ls.rgb = i === 0 ? vec3(1, 1, 1) : vec3(0.5, 0.5, 0.5);
      ls.white = i === 0 ? 3 : 1.5;
      r_newrefdef.lightstyles.push(ls);
    }
    r_newrefdef.num_dlights = 0;

    const smax = 2;
    const tmax = 2;
    const dest = new Uint8Array(smax * tmax * 4);
    R_BuildLightMap(surf, dest, smax * 4);

    // hand-computed: blocklight[i] = style0[i] * 1.0 + style1[i] * 0.5
    const expectedRGBA = [
      [11, 22, 33, 33],
      [44, 55, 66, 66],
      [77, 88, 99, 99],
      [110, 121, 132, 132],
    ];
    for (let i = 0; i < 4; i++) {
      expect(Array.from(dest.subarray(i * 4, i * 4 + 4))).toEqual(expectedRGBA[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// R_MarkLights (gl_light.ts): radius-based dlight marking over a fabricated
// two-level node tree, including the cutoff pruning branch.
// ---------------------------------------------------------------------------

describe("R_MarkLights: radius marking on fabricated nodes", () => {
  test("prunes the far branch and marks only the surface within DLIGHT_CUTOFF range", () => {
    const surf0 = new MsurfaceT();
    const surf1 = new MsurfaceT();

    const planeRoot = new CplaneT();
    planeRoot.normal = vec3(1, 0, 0);
    planeRoot.dist = 0;

    const planeChild = new CplaneT();
    planeChild.normal = vec3(0, 1, 0);
    planeChild.dist = 0;

    const leafB = new MleafT();
    const leafC = new MleafT();
    const leafD = new MleafT();

    const childNode = new MnodeT();
    childNode.plane = planeChild;
    childNode.firstsurface = 1;
    childNode.numsurfaces = 1;
    childNode.children = [leafC, leafD];

    const rootNode = new MnodeT();
    rootNode.plane = planeRoot;
    rootNode.firstsurface = 0;
    rootNode.numsurfaces = 1;
    rootNode.children = [childNode, leafB];

    const fakeModel = new ModelT();
    fakeModel.surfaces = [surf0, surf1];
    fakeModel.nodes = [rootNode, childNode];
    SetWorldModel(fakeModel);

    const light = { origin: vec3(1000, 10, 0), color: vec3(1, 1, 1), intensity: 200, lightScale: 1, cone: null, resolution: 0 };
    const bit = 1 << 3;

    R_MarkLights(light, bit, rootNode);

    // root: dist along (1,0,0) is 1000, comfortably beyond
    // intensity-DLIGHT_CUTOFF (136) -> pruned to children[0] only, root's
    // own surface (surf0) is never marked and leafB's side is never visited.
    expect(surf0.dlightbits & bit).toBe(0);

    // childNode: dist along (0,1,0) is 10, within [-136, 136] -> marks its
    // own surface (surf1).
    expect(surf1.dlightbits & bit).toBe(bit);
  });
});
