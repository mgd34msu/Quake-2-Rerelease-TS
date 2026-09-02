/*
Test support for src/ref_soft/r_model.ts (ported from ref_soft/r_model.c).

Self-contained: builds its own minimal IBSP v38 and MD2/SP2 buffers directly
(rather than reusing test/support/bsp_builder.ts, which is shaped for
cmodel.ts's collision lumps -- brushes/brushsides/areas -- none of which
Mod_LoadBrushModel reads; and whose single dummy texinfo entry would trigger
a R_FindImage call this file needs to avoid for its node/leaf tree test, see
below) and fakes the `ri` (RefImports) engine callback table Mod_ForName
needs, per PORTING.md's "test files are self-sufficient" rule.

r_image.ts's R_FindImage, r_rast.ts's R_InitSkyBox, r_main.ts's R_NewMap,
and r_surf.ts's D_FlushCaches are all real, landed implementations now (none
of the "still a PendingPort stub" state this file's tests were originally
written against remains) -- but they still run against this file's own
fake, minimal `ri` (RefImports) table, which doesn't provide everything a
real engine boot would, so a full Mod_LoadBrushModel or R_BeginRegistration
run can still throw partway through for an unrelated reason (a missing fake
`ri` method, a file the fake FS_LoadFile doesn't have registered, etc) --
but only *after* mutating the model object in place (JS objects are
references), so the tests below tolerate either outcome (throw or clean
return) and then inspect the already-populated model via the exported
`mod_known`/`mod_inline` arrays. The one BSP used for the node/leaf gold
test below deliberately has zero texinfo/faces entries so Mod_LoadTexinfo's
per-entry loop (which calls R_FindImage) never executes, letting
Mod_LoadBrushModel run all the way to its final call (R_InitSkyBox, the
last line of the function) with every node/leaf/plane/submodel field
already correctly populated.
*/

import { afterAll, describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports } from "../src/ref_soft/r_local";
import { vec3 } from "../src/shared/math";
import { CONTENTS_SOLID } from "../src/shared/q_shared";
import { Mod_FreeAll,
  Mod_TestFreeAllKnown,
  Mod_ForName,
  Mod_PointInLeaf,
  Mod_ClusterPVS,
  Mod_Init,
  mod_known,
  mod_inline,
  ModtypeT,
  isMleaf,
  ParsedMd2T,
  ParsedSp2T,
  IDALIASHEADER,
  IDSPRITEHEADER,
  ALIAS_VERSION,
  SPRITE_VERSION,
  MAX_MD2SKINS,
} from "../src/ref_soft/r_model";
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
  DMODEL_T_SIZE,
  DPLANE_T_SIZE,
  DNODE_T_SIZE,
  DLEAF_T_SIZE,
  MAX_MAP_LEAFS,
} from "../src/qcommon/qfiles";

// ---------------------------------------------------------------------------
// fake `ri` -- FS_LoadFile serves buffers registered by name; Sys_Error
// throws a plain Error carrying the message so tests can match on it and
// tell it apart from an unrelated error a real sibling function (R_FindImage,
// R_InitSkyBox, etc) throws against this file's minimal fake `ri`.
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

// Rule 13: leave r_model.ts's mod_known/mod_inline table exactly as empty as
// a fresh process would. This file's error-path tests (unknown fileid,
// not-found-with-crash, bad sprite version) leave mod_known slots holding a
// NAME with extradatasize 0 -- the one thing Mod_FreeAll cannot reclaim --
// and a leftover slot 0 pushes a LATER file's world model into mod_known[1],
// tripping Mod_LoadBrushModel's "Loaded a brush model after the world" guard
// there (test/mod_leaf_marksurfaces.test.ts is the file that noticed). See
// Mod_TestFreeAllKnown's own comment in r_model.ts.
afterAll(() => {
  Mod_TestFreeAllKnown();
});

beforeEach(() => {
  SetRefImports(makeFakeRi());
  Mod_Init(); // fills mod_novis with 0xff, matching r_main.c's startup sequence
  Mod_TestFreeAllKnown(); // not Mod_FreeAll -- see the afterAll above
});

// ---------------------------------------------------------------------------
// minimal IBSP v38 builder for Mod_LoadBrushModel: a hollow axis-aligned box
// room built from six wall planes and a six-node chain (one node per wall),
// exactly like test/support/bsp_builder.ts's buildBoxRoomBsp -- but scoped
// to the lumps Mod_LoadBrushModel actually reads (no brushes/areas, which
// only cmodel.ts's CM_LoadMap needs), and with zero texinfo/faces so
// Mod_LoadTexinfo's R_FindImage call never fires (see file header).
// ---------------------------------------------------------------------------

const ROOM_HALF = 64;
const SOLID_LEAF = 0;
const EMPTY_LEAF = 1;

interface WallPlane {
  normal: [number, number, number];
  dist: number;
  type: number;
}

function wallPlanes(): WallPlane[] {
  const h = ROOM_HALF;
  return [
    { normal: [-1, 0, 0], dist: -h, type: 3 }, // +X wall
    { normal: [1, 0, 0], dist: -h, type: 0 }, // -X wall
    { normal: [0, -1, 0], dist: -h, type: 4 }, // +Y wall
    { normal: [0, 1, 0], dist: -h, type: 1 }, // -Y wall
    { normal: [0, 0, -1], dist: -h, type: 5 }, // +Z wall
    { normal: [0, 0, 1], dist: -h, type: 2 }, // -Z wall
  ];
}

function buildLump(count: number, itemSize: number, write: (view: DataView, base: number, i: number) => void): Uint8Array {
  const buf = new Uint8Array(count * itemSize);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < count; i++) write(view, i * itemSize, i);
  return buf;
}

function buildTestBrushBsp(): Uint8Array {
  const planes = wallPlanes();

  const planesLump = buildLump(planes.length, DPLANE_T_SIZE, (view, base, i) => {
    const p = planes[i];
    view.setFloat32(base, p.normal[0], true);
    view.setFloat32(base + 4, p.normal[1], true);
    view.setFloat32(base + 8, p.normal[2], true);
    view.setFloat32(base + 12, p.dist, true);
    view.setInt32(base + 16, p.type, true);
  });

  const nodeCount = 6;
  const nodesLump = buildLump(nodeCount, DNODE_T_SIZE, (view, base, i) => {
    const insideChild = i === nodeCount - 1 ? -1 - EMPTY_LEAF : i + 1;
    const outsideChild = -1 - SOLID_LEAF;
    view.setInt32(base, i, true); // planenum
    view.setInt32(base + 4, insideChild, true); // children[0]
    view.setInt32(base + 8, outsideChild, true); // children[1]
    view.setInt16(base + 12, 0, true);
    view.setInt16(base + 14, 0, true);
    view.setInt16(base + 16, 0, true);
    view.setInt16(base + 18, 0, true);
    view.setInt16(base + 20, 0, true);
    view.setInt16(base + 22, 0, true);
    view.setUint16(base + 24, 0, true); // firstface
    view.setUint16(base + 26, 0, true); // numfaces
  });

  const leafsLump = buildLump(2, DLEAF_T_SIZE, (view, base, i) => {
    const solid = i === SOLID_LEAF;
    view.setInt32(base, solid ? CONTENTS_SOLID : 0, true); // contents
    view.setInt16(base + 4, solid ? -1 : 0, true); // cluster
    view.setInt16(base + 6, solid ? 0 : 1, true); // area
    view.setInt16(base + 8, 0, true);
    view.setInt16(base + 10, 0, true);
    view.setInt16(base + 12, 0, true);
    view.setInt16(base + 14, 0, true);
    view.setInt16(base + 16, 0, true);
    view.setInt16(base + 18, 0, true);
    view.setUint16(base + 20, 0, true); // firstleafface
    view.setUint16(base + 22, 0, true); // numleaffaces
    view.setUint16(base + 24, 0, true); // firstleafbrush (unread by r_model.ts)
    view.setUint16(base + 26, 0, true); // numleafbrushes (unread by r_model.ts)
  });

  const modelsLump = buildLump(1, DMODEL_T_SIZE, (view, base) => {
    const h = ROOM_HALF;
    view.setFloat32(base, -h, true);
    view.setFloat32(base + 4, -h, true);
    view.setFloat32(base + 8, -h, true);
    view.setFloat32(base + 12, h, true);
    view.setFloat32(base + 16, h, true);
    view.setFloat32(base + 20, h, true);
    view.setFloat32(base + 24, 0, true);
    view.setFloat32(base + 28, 0, true);
    view.setFloat32(base + 32, 0, true);
    view.setInt32(base + 36, 0, true); // headnode
    view.setInt32(base + 40, 0, true); // firstface
    view.setInt32(base + 44, 0, true); // numfaces
  });

  const empty = new Uint8Array(0);
  const entitiesLump = new TextEncoder().encode('{\n"classname" "worldspawn"\n}\n');

  const lumpOrder: Array<{ index: number; data: Uint8Array }> = [
    { index: LUMP_ENTITIES, data: entitiesLump },
    { index: LUMP_PLANES, data: planesLump },
    { index: LUMP_VERTEXES, data: empty },
    { index: LUMP_VISIBILITY, data: empty },
    { index: LUMP_NODES, data: nodesLump },
    { index: LUMP_TEXINFO, data: empty }, // 0 entries -- avoids R_FindImage
    { index: LUMP_FACES, data: empty },
    { index: LUMP_LIGHTING, data: empty },
    { index: LUMP_LEAFS, data: leafsLump },
    { index: LUMP_LEAFFACES, data: empty },
    { index: LUMP_LEAFBRUSHES, data: empty },
    { index: LUMP_EDGES, data: empty },
    { index: LUMP_SURFEDGES, data: empty },
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
    const info = lumpInfo[i];
    outView.setInt32(8 + i * 8, info.fileofs, true);
    outView.setInt32(8 + i * 8 + 4, info.filelen, true);
  }

  return out;
}

// ---------------------------------------------------------------------------
// minimal MD2 builder: header + 1 st vert + 1 triangle + 1 frame (1 vertex)
// + 1 skin name, byte-by-byte per qcommon/qfiles.h's dmdl_t/dstvert_t/
// dtriangle_t/daliasframe_t/dtrivertx_t offsets.
// ---------------------------------------------------------------------------

function buildTestMd2(numSkins: 0 | 1): Uint8Array {
  const DMDL_HEADER_SIZE = 68;
  const ofsSt = DMDL_HEADER_SIZE;
  const ofsTris = ofsSt + 4; // 1 dstvert_t (2 shorts)
  const ofsFrames = ofsTris + 12; // 1 dtriangle_t (6 shorts)
  const frameSize = 40 + 1 * 4; // daliasframe_t header + 1 dtrivertx_t
  const ofsGlcmds = ofsFrames + frameSize;
  const ofsSkins = ofsGlcmds; // 0 glcmds
  const skinBytes = numSkins * 64;
  const ofsEnd = ofsSkins + skinBytes;

  const buf = new Uint8Array(ofsEnd);
  const view = new DataView(buf.buffer);

  view.setInt32(0, IDALIASHEADER, true); // ident
  view.setInt32(4, ALIAS_VERSION, true); // version
  view.setInt32(8, 32, true); // skinwidth
  view.setInt32(12, 32, true); // skinheight
  view.setInt32(16, frameSize, true); // framesize
  view.setInt32(20, numSkins, true); // num_skins
  view.setInt32(24, 1, true); // num_xyz
  view.setInt32(28, 1, true); // num_st
  view.setInt32(32, 1, true); // num_tris
  view.setInt32(36, 0, true); // num_glcmds
  view.setInt32(40, 1, true); // num_frames
  view.setInt32(44, ofsSkins, true); // ofs_skins
  view.setInt32(48, ofsSt, true); // ofs_st
  view.setInt32(52, ofsTris, true); // ofs_tris
  view.setInt32(56, ofsFrames, true); // ofs_frames
  view.setInt32(60, ofsGlcmds, true); // ofs_glcmds
  view.setInt32(64, ofsEnd, true); // ofs_end

  // dstvert_t
  view.setInt16(ofsSt, 0, true);
  view.setInt16(ofsSt + 2, 0, true);

  // dtriangle_t
  view.setInt16(ofsTris, 0, true);
  view.setInt16(ofsTris + 2, 0, true);
  view.setInt16(ofsTris + 4, 0, true);
  view.setInt16(ofsTris + 6, 0, true);
  view.setInt16(ofsTris + 8, 0, true);
  view.setInt16(ofsTris + 10, 0, true);

  // daliasframe_t
  view.setFloat32(ofsFrames, 1, true);
  view.setFloat32(ofsFrames + 4, 1, true);
  view.setFloat32(ofsFrames + 8, 1, true);
  view.setFloat32(ofsFrames + 12, 0, true);
  view.setFloat32(ofsFrames + 16, 0, true);
  view.setFloat32(ofsFrames + 20, 0, true);
  const name = "frame1";
  for (let i = 0; i < name.length; i++) view.setUint8(ofsFrames + 24 + i, name.charCodeAt(i));
  // dtrivertx_t at ofsFrames+40
  view.setUint8(ofsFrames + 40, 1);
  view.setUint8(ofsFrames + 41, 2);
  view.setUint8(ofsFrames + 42, 3);
  view.setUint8(ofsFrames + 43, 7);

  if (numSkins === 1) {
    const skin = "models/test/skin.pcx";
    for (let i = 0; i < skin.length; i++) view.setUint8(ofsSkins + i, skin.charCodeAt(i));
  }

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

// Mod_LoadBrushModel enforces "the world model must be mod_known[0]" (see
// its own Sys_Error check, ported faithfully below); the very first
// Mod_ForName call anywhere in this file that actually reaches an IBSP
// loader must therefore be this one, before any other test claims slot 0.
// Every assertion below reads state Mod_LoadBrushModel populates *before*
// its final call (R_InitSkyBox) -- R_InitSkyBox is a real, landed
// implementation now, but it can still error against this fake `ri`
// (per the file header) -- that outcome is caught and ignored either way.
describe("Mod_LoadBrushModel: node/leaf tree over a hand-built IBSP", () => {
  const name = "maps/testroom.bsp";
  registerFile(name, buildTestBrushBsp());

  test("loads planes/nodes/leafs/submodels; node/leaf tree walks correctly; counts match the source lumps", () => {
    try {
      Mod_ForName(name, false);
    } catch {
      // R_InitSkyBox is the last statement in Mod_LoadBrushModel -- it's a
      // real, landed implementation now, but it may still not run cleanly
      // against this fake `ri`; either way, everything asserted below was
      // already set before this call runs.
    }

    const model = mod_known.find((m) => m.name === name);
    expect(model).toBeDefined();
    if (!model) throw new Error("model not found");

    expect(model.type).toBe(ModtypeT.mod_brush);
    expect(model.numsubmodels).toBe(1);
    expect(model.numplanes).toBe(6);
    expect(model.numnodes).toBe(6);
    expect(model.numleafs).toBe(2);
    // the source BSP's FACES/EDGES lumps are empty, so every surface/edge
    // present comes from Mod_LoadBrushModel's closing R_InitSkyBox call,
    // which appends the 6 skybox faces / 8 verts / 12 edges.
    expect(model.numsurfaces).toBe(6);
    expect(model.numedges).toBe(12);

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

    // no VISIBILITY lump was supplied -- Mod_ClusterPVS must fall back to
    // the all-visible mod_novis buffer for both the "-1" and "no vis data"
    // cases.
    expect(model.vis).toBeNull();
    const pvs = Mod_ClusterPVS(-1, model);
    expect(pvs.length).toBe(MAX_MAP_LEAFS / 8);
    expect(pvs.every((b) => b === 0xff)).toBe(true);
    expect(Mod_ClusterPVS(0, model).every((b) => b === 0xff)).toBe(true);
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

describe("Mod_LoadAliasModel: hand-built minimal MD2", () => {
  test("parses frame/vertex/triangle counts (0 skins)", () => {
    registerFile("models/test0.md2", buildTestMd2(0));
    const model = Mod_ForName("models/test0.md2", false);
    expect(model).not.toBeNull();
    if (!model) throw new Error("model not returned");
    expect(model.type).toBe(ModtypeT.mod_alias);
    expect(model.extradata).toBeInstanceOf(ParsedMd2T);
    if (model.extradata instanceof ParsedMd2T) {
      expect(model.extradata.num_frames).toBe(1);
      expect(model.extradata.num_xyz).toBe(1);
      expect(model.extradata.num_tris).toBe(1);
      expect(model.extradata.num_st).toBe(1);
      expect(model.extradata.frames[0].verts.length).toBe(1);
      expect(model.extradata.triangles[0].index_xyz).toEqual([0, 0, 0]);
    }
  });

  test("1 skin: still parses frame/vertex/triangle counts and reads the skin name", () => {
    registerFile("models/test1.md2", buildTestMd2(1));
    // R_FindImage (r_image.ts) is a real, landed implementation now (see
    // file header), but may still error against this fake `ri`; either
    // way, Mod_LoadAliasModel attaches ModelT.extradata before this loop
    // runs.
    try {
      Mod_ForName("models/test1.md2", false);
    } catch {
      // ignored -- see above
    }

    const model = mod_known.find((m) => m.name === "models/test1.md2");
    expect(model).toBeDefined();
    if (!model || !(model.extradata instanceof ParsedMd2T)) throw new Error("model/extradata not found");
    expect(model.extradata.num_frames).toBe(1);
    expect(model.extradata.num_xyz).toBe(1);
    expect(model.extradata.num_tris).toBe(1);
    expect(model.extradata.num_skins).toBe(1);
    expect(model.extradata.skinnames[0]).toBe("models/test/skin.pcx");
  });
});

describe("Mod_LoadSpriteModel", () => {
  test("0-frame sprite loads fully with no pending sibling calls", () => {
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

describe("Mod_Init", () => {
  test("fills mod_novis with 0xff (checked indirectly via Mod_ClusterPVS in the brush-model test above)", () => {
    expect(() => Mod_Init()).not.toThrow();
  });
});

describe("MAX_MD2SKINS sanity", () => {
  test("matches qfiles.h", () => {
    expect(MAX_MD2SKINS).toBe(32);
  });
});
