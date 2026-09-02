/*
Test support module, not a port of any .c file.

Builds a minimal-but-structurally-valid IBSP version 38 buffer (the format
read by src/qcommon/cmodel.ts's CM_LoadMap) so integration tests can exercise
real map loading without any copyrighted id Software map data. Byte offsets
and struct sizes are taken from src/qcommon/qfiles.ts (itself ported from
quake-2-c/qcommon/qfiles.h).

The generated map is a hollow, axis-aligned cube room: empty space for
|x|,|y|,|z| < ROOM_HALF, solid everywhere outside that. The BSP tree is a
simple 6-node chain, one node per wall plane: at each node, the "still
inside relative to this wall" branch continues to the next node, and the
"outside this wall" branch goes straight to the solid leaf. The last node's
"inside" branch reaches the empty leaf. Each wall also gets its own
single-sided brush (attached to the solid leaf) so CM_ClipBoxToBrush has
real geometry to clip traces against and report a plane normal from.
*/

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
  IDBSPHEADER_EXT,
  BSPVERSION,
  DHEADER_T_SIZE,
  DMODEL_T_SIZE,
  DPLANE_T_SIZE,
  DNODE_T_SIZE,
  TEXINFO_T_SIZE,
  DLEAF_T_SIZE,
  DBRUSHSIDE_T_SIZE,
  DBRUSH_T_SIZE,
  DAREA_T_SIZE,
  DVERTEX_T_SIZE,
  DEDGE_T_SIZE,
  DFACE_T_SIZE,
  MAXLIGHTMAPS,
  DBRUSHSIDE_EXT_T_SIZE,
  LEAFBRUSH_EXT_SIZE,
  DEDGE_EXT_T_SIZE,
  DFACE_EXT_T_SIZE,
  LEAFFACE_EXT_SIZE,
  DLEAF_EXT_T_SIZE,
  DNODE_EXT_T_SIZE,
} from "../../src/qcommon/qfiles";
import { CONTENTS_SOLID } from "../../src/shared/q_shared";

// half-extent of the empty interior; solid begins at |axis| >= ROOM_HALF
export const ROOM_HALF = 64;

interface WallPlane {
  normal: [number, number, number];
  dist: number;
  type: number;
}

// six wall planes, one per axis direction. Positive-facing walls (+X/+Y/+Z)
// use an inward-pointing (negative) normal with type 3+axis; negative-facing
// walls use an outward-pointing (positive) normal with type axis -- matching
// the type<3-means-axis-aligned-positive-normal convention CM_InitBoxHull
// uses for its own synthetic box planes in cmodel.ts. `d = dot(normal,p) -
// dist` is negative on the solid side of each plane and non-negative on the
// empty side.
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

const SOLID_LEAF = 0;
const EMPTY_LEAF = 1;

function buildLump(count: number, itemSize: number, write: (view: DataView, base: number, i: number) => void): Uint8Array {
  const buf = new Uint8Array(count * itemSize);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < count; i++) write(view, i * itemSize, i);
  return buf;
}

function stringBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function writeFixedString(view: DataView, base: number, s: string, maxLen: number): void {
  for (let i = 0; i < maxLen; i++) {
    view.setUint8(base + i, i < s.length ? s.charCodeAt(i) : 0);
  }
}

/*
Builds the full IBSP buffer. Lump order in the file is arbitrary (only the
header's fileofs/filelen matter); lumps CM_LoadMap never reads (VERTEXES,
FACES, LIGHTING, LEAFFACES, EDGES, SURFEDGES, POP) are emitted empty.
*/
export const WORLDSPAWN_ONLY_ENTITIES = '{\n"classname" "worldspawn"\n}\n';

/*
`renderable` adds the lumps cmodel.ts never reads but the software renderer
needs: 24 vertexes / 25 edges / 24 surfedges forming one inward-facing quad
per wall, a face per wall hung off that wall's BSP node, a per-wall texinfo,
and leaffaces marking all six from the empty leaf. Off by default so the
collision-only tests that already use this builder keep their exact lumps.
Node/leaf bounds are also filled in, because R_RecursiveWorldNode frustum-culls
on them and an all-zero box rejects everything.
*/
export interface BoxRoomOptions {
  renderable?: boolean;
  /*
  Give the empty leaf a strict interior sub-range of the leafface lump
  (firstleafface 2, numleaffaces 3) instead of the whole thing. Off by
  default so every existing caller keeps its exact lumps. Real retail maps
  are full of leafs shaped like this; the synthetic default (0..6, i.e. the
  entire lump) can't tell a leaf that stores its own range apart from one
  that stores the whole tail of the shared array.
  */
  partialLeafFaces?: boolean;
  /*
  Emit this many EXTRA submodels after the world model, so cmodel.ts's
  numcmodels ends up at 1 + inlineModels and CM_InlineModel("*1") ..
  CM_InlineModel("*<inlineModels>") resolve instead of Com_Erroring with
  "bad number". Each extra submodel is the same box rooted at node 0 (a real
  map's inline models are separate brush-model subtrees; nothing that reads
  them here cares which subtree they point at, only that the index exists).
  Zero by default, so every existing caller keeps its exact lumps.
  */
  inlineModels?: number;
}

const PARTIAL_FIRST_LEAFFACE = 2;
const PARTIAL_NUM_LEAFFACES = 3;

// in-plane (s, t) axes per wall, chosen so that s x t == the wall's inward
// normal.
function wallAxes(): Array<{ s: [number, number, number]; t: [number, number, number] }> {
  return [
    { s: [0, 0, 1], t: [0, 1, 0] }, // +X wall
    { s: [0, 1, 0], t: [0, 0, 1] }, // -X wall
    { s: [1, 0, 0], t: [0, 0, 1] }, // +Y wall
    { s: [0, 0, 1], t: [1, 0, 0] }, // -Y wall
    { s: [0, 1, 0], t: [1, 0, 0] }, // +Z wall
    { s: [1, 0, 0], t: [0, 1, 0] }, // -Z wall
  ];
}

/*
The four corners of wall i, wound clockwise about its inward normal -- i.e.
counter-clockwise seen from the solid side. That is the direction r_rast.c's
R_RenderFace needs: it decides leading vs trailing edge from `ceilv0 >
r_ceilv1`, so the opposite winding emits every surface's entering edge on the
right and its leaving edge on the left, R_GenerateSpans reads that as an
inverted span, and the surface produces no spans at all.
*/
function wallCorners(i: number): Array<[number, number, number]> {
  const plane = wallPlanes()[i];
  const axes = wallAxes()[i];
  const h = ROOM_HALF;
  const center: [number, number, number] = [plane.normal[0] * plane.dist, plane.normal[1] * plane.dist, plane.normal[2] * plane.dist];
  const corner = (su: number, tv: number): [number, number, number] => [
    center[0] + axes.s[0] * su * h + axes.t[0] * tv * h,
    center[1] + axes.s[1] * su * h + axes.t[1] * tv * h,
    center[2] + axes.s[2] * su * h + axes.t[2] * tv * h,
  ];
  return [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)];
}

export function buildBoxRoomBsp(entityString: string = WORLDSPAWN_ONLY_ENTITIES, options: BoxRoomOptions = {}): Uint8Array {
  const renderable = options.renderable === true;
  const partialLeafFaces = options.partialLeafFaces === true;
  const planes = wallPlanes();

  // ---- PLANES (6) ----
  const planesLump = buildLump(planes.length, DPLANE_T_SIZE, (view, base, i) => {
    const p = planes[i];
    view.setFloat32(base, p.normal[0], true);
    view.setFloat32(base + 4, p.normal[1], true);
    view.setFloat32(base + 8, p.normal[2], true);
    view.setFloat32(base + 12, p.dist, true);
    view.setInt32(base + 16, p.type, true);
  });

  // ---- NODES (6), chained: node i's "inside so far" child continues to
  // node i+1 (or the empty leaf on the last node); its "outside this wall"
  // child goes straight to the solid leaf. ----
  const nodeCount = 6;
  const nodesLump = buildLump(nodeCount, DNODE_T_SIZE, (view, base, i) => {
    const insideChild = i === nodeCount - 1 ? -1 - EMPTY_LEAF : i + 1;
    const outsideChild = -1 - SOLID_LEAF;
    view.setInt32(base, i, true); // planenum
    view.setInt32(base + 4, insideChild, true); // children[0]
    view.setInt32(base + 8, outsideChild, true); // children[1]
    const b = renderable ? ROOM_HALF : 0;
    view.setInt16(base + 12, -b, true); // mins
    view.setInt16(base + 14, -b, true);
    view.setInt16(base + 16, -b, true);
    view.setInt16(base + 18, b, true); // maxs
    view.setInt16(base + 20, b, true);
    view.setInt16(base + 22, b, true);
    view.setUint16(base + 24, renderable ? i : 0, true); // firstface
    view.setUint16(base + 26, renderable ? 1 : 0, true); // numfaces
  });

  // ---- TEXINFO: entry 0 is the dummy brushsides reference; when renderable,
  // entries 1..6 carry each wall's own (s, t) axes. ----
  const axes = wallAxes();
  const texinfoLump = buildLump(renderable ? 7 : 1, TEXINFO_T_SIZE, (view, base, i) => {
    const sAxis = i === 0 ? [1, 0, 0] : axes[i - 1].s;
    const tAxis = i === 0 ? [0, 1, 0] : axes[i - 1].t;
    view.setFloat32(base, sAxis[0], true);
    view.setFloat32(base + 4, sAxis[1], true);
    view.setFloat32(base + 8, sAxis[2], true);
    view.setFloat32(base + 12, 0, true);
    view.setFloat32(base + 16, tAxis[0], true);
    view.setFloat32(base + 20, tAxis[1], true);
    view.setFloat32(base + 24, tAxis[2], true);
    view.setFloat32(base + 28, 0, true);
    view.setInt32(base + 32, 0, true); // flags
    view.setInt32(base + 36, 0, true); // value
    writeFixedString(view, base + 40, "wall", 32); // texture
    view.setInt32(base + 72, -1, true); // nexttexinfo
  });

  // ---- VERTEXES / EDGES / SURFEDGES / FACES / LEAFFACES (renderable only).
  // Edge 0 is a reserved dummy: a surfedge of 0 has no sign and so cannot
  // name a real edge. ----
  const vertexesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(24, DVERTEX_T_SIZE, (view, base, i) => {
        const p = wallCorners((i / 4) | 0)[i % 4];
        view.setFloat32(base, p[0], true);
        view.setFloat32(base + 4, p[1], true);
        view.setFloat32(base + 8, p[2], true);
      });

  const edgesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(25, DEDGE_T_SIZE, (view, base, i) => {
        if (i === 0) {
          view.setUint16(base, 0, true);
          view.setUint16(base + 2, 0, true);
          return;
        }
        const e = i - 1;
        const face = (e / 4) | 0;
        const corner = e % 4;
        view.setUint16(base, face * 4 + corner, true);
        view.setUint16(base + 2, face * 4 + ((corner + 1) % 4), true);
      });

  const surfedgesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(24, 4, (view, base, i) => {
        view.setInt32(base, i + 1, true); // edge i+1, forward
      });

  const facesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(6, DFACE_T_SIZE, (view, base, i) => {
        view.setUint16(base, i, true); // planenum
        view.setInt16(base + 2, 0, true); // side (0: front, normal points into the room)
        view.setInt32(base + 4, i * 4, true); // firstedge (into SURFEDGES)
        view.setInt16(base + 8, 4, true); // numedges
        view.setInt16(base + 10, i + 1, true); // texinfo
        for (let j = 0; j < MAXLIGHTMAPS; j++) view.setUint8(base + 12 + j, j === 0 ? 0 : 255); // styles
        view.setInt32(base + 16, -1, true); // lightofs: no lightmap data
      });

  const leaffacesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(6, 2, (view, base, i) => {
        view.setUint16(base, i, true);
      });

  // ---- LEAFS (2): leaf 0 solid (owns leafbrushes [0..5]), leaf 1 empty
  // (owns none -- its firstleafbrush is never indexed since numleafbrushes
  // is 0). ----
  const leafsLump = buildLump(2, DLEAF_T_SIZE, (view, base, i) => {
    const solid = i === SOLID_LEAF;
    view.setInt32(base, solid ? CONTENTS_SOLID : 0, true); // contents
    view.setInt16(base + 4, solid ? -1 : 0, true); // cluster
    view.setInt16(base + 6, solid ? 0 : 1, true); // area
    const b = renderable ? ROOM_HALF : 0;
    view.setInt16(base + 8, -b, true); // mins
    view.setInt16(base + 10, -b, true);
    view.setInt16(base + 12, -b, true);
    view.setInt16(base + 14, b, true); // maxs
    view.setInt16(base + 16, b, true);
    view.setInt16(base + 18, b, true);
    view.setUint16(base + 20, renderable && !solid && partialLeafFaces ? PARTIAL_FIRST_LEAFFACE : 0, true); // firstleafface
    view.setUint16(base + 22, renderable && !solid ? (partialLeafFaces ? PARTIAL_NUM_LEAFFACES : 6) : 0, true); // numleaffaces
    view.setUint16(base + 24, 0, true); // firstleafbrush
    view.setUint16(base + 26, solid ? 6 : 0, true); // numleafbrushes
  });

  // ---- LEAFBRUSHES (6): brush indices 0..5, all owned by the solid leaf ----
  const leafbrushesLump = buildLump(6, 2, (view, base, i) => {
    view.setUint16(base, i, true);
  });

  // ---- BRUSHES (6): one per wall, single-sided, CONTENTS_SOLID ----
  const brushesLump = buildLump(6, DBRUSH_T_SIZE, (view, base, i) => {
    view.setInt32(base, i, true); // firstside
    view.setInt32(base + 4, 1, true); // numsides
    view.setInt32(base + 8, CONTENTS_SOLID, true); // contents
  });

  // ---- BRUSHSIDES (6): brush i's single side references plane i ----
  const brushsidesLump = buildLump(6, DBRUSHSIDE_T_SIZE, (view, base, i) => {
    view.setUint16(base, i, true); // planenum
    view.setInt16(base + 2, 0, true); // texinfo
  });

  // ---- MODELS (1 + options.inlineModels): the whole room, rooted at node
  // 0, followed by any extra inline-model entries the caller asked for (see
  // BoxRoomOptions.inlineModels) ----
  const modelsLump = buildLump(1 + (options.inlineModels ?? 0), DMODEL_T_SIZE, (view, base) => {
    const h = ROOM_HALF;
    view.setFloat32(base, -h, true);
    view.setFloat32(base + 4, -h, true);
    view.setFloat32(base + 8, -h, true);
    view.setFloat32(base + 12, h, true);
    view.setFloat32(base + 16, h, true);
    view.setFloat32(base + 20, h, true);
    view.setFloat32(base + 24, 0, true); // origin
    view.setFloat32(base + 28, 0, true);
    view.setFloat32(base + 32, 0, true);
    view.setInt32(base + 36, 0, true); // headnode
    view.setInt32(base + 40, 0, true); // firstface (unused)
    view.setInt32(base + 44, 0, true); // numfaces (unused)
  });

  // ---- AREAS (1), AREAPORTALS (0) ----
  const areasLump = buildLump(1, DAREA_T_SIZE, (view, base) => {
    view.setInt32(base, 0, true); // numareaportals
    view.setInt32(base + 4, 0, true); // firstareaportal
  });
  const areaportalsLump = new Uint8Array(0);

  // ---- ENTITIES: worldspawn by default, caller-supplied otherwise ----
  const entitiesLump = stringBytes(entityString);

  // ---- unused-by-cmodel lumps, all empty ----
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
    { index: LUMP_LEAFBRUSHES, data: leafbrushesLump },
    { index: LUMP_EDGES, data: edgesLump },
    { index: LUMP_SURFEDGES, data: surfedgesLump },
    { index: LUMP_MODELS, data: modelsLump },
    { index: LUMP_BRUSHES, data: brushesLump },
    { index: LUMP_BRUSHSIDES, data: brushsidesLump },
    { index: LUMP_POP, data: empty },
    { index: LUMP_AREAS, data: areasLump },
    { index: LUMP_AREAPORTALS, data: areaportalsLump },
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

  // header
  outView.setInt32(0, IDBSPHEADER, true);
  outView.setInt32(4, BSPVERSION, true);
  for (let i = 0; i < HEADER_LUMPS; i++) {
    const info = lumpInfo[i];
    outView.setInt32(8 + i * 8, info.fileofs, true);
    outView.setInt32(8 + i * 8 + 4, info.filelen, true);
  }

  return out;
}

/*
buildBoxRoomBspQbsp

Same box-room geometry as buildBoxRoomBsp above (see that function's own
comment for the room layout), but written in the QBSP extended format
(qfiles.ts's IDBSPHEADER_EXT): widened BrushSides/LeafBrushes/Edges/Faces/
LeafFaces/Leafs/Nodes records, per q2repro's bsp_lumps[] E()-tagged lumps.
Texinfo/Planes/Brushes/Areas/AreaPortals/Vertexes/SurfEdges stay the classic
(L()-tagged) byte layout in both formats -- same lump-loading functions read
them either way (see qfiles.ts's header comment on the Ext readers).

Used by the QBSP dual-format loader tests (test/cmodel_qbsp.test.ts,
test/gl_model_qbsp.test.ts, test/r_model_qbsp.test.ts) to verify the
extended-format path produces IDENTICAL observable behavior to
buildBoxRoomBsp's classic-format version of the same room (same trace
results, same rendered geometry) -- not just "loads without erroring".
*/
export function buildBoxRoomBspQbsp(entityString: string = WORLDSPAWN_ONLY_ENTITIES, options: BoxRoomOptions = {}): Uint8Array {
  const renderable = options.renderable === true;
  const partialLeafFaces = options.partialLeafFaces === true;
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
  // DNODE_EXT_T_SIZE (44): planenum(i32) children[2](i32) mins[3](f32)
  // maxs[3](f32) firstface(u32) numfaces(u32) -- mins/maxs/firstface/numfaces
  // are float/u32 here, unlike the classic int16 record buildBoxRoomBsp uses.
  const nodesLump = buildLump(nodeCount, DNODE_EXT_T_SIZE, (view, base, i) => {
    const insideChild = i === nodeCount - 1 ? -1 - EMPTY_LEAF : i + 1;
    const outsideChild = -1 - SOLID_LEAF;
    view.setInt32(base, i, true); // planenum
    view.setInt32(base + 4, insideChild, true); // children[0]
    view.setInt32(base + 8, outsideChild, true); // children[1]
    const b = renderable ? ROOM_HALF : 0;
    view.setFloat32(base + 12, -b, true); // mins
    view.setFloat32(base + 16, -b, true);
    view.setFloat32(base + 20, -b, true);
    view.setFloat32(base + 24, b, true); // maxs
    view.setFloat32(base + 28, b, true);
    view.setFloat32(base + 32, b, true);
    view.setUint32(base + 36, renderable ? i : 0, true); // firstface
    view.setUint32(base + 40, renderable ? 1 : 0, true); // numfaces
  });

  const axes = wallAxes();
  const texinfoLump = buildLump(renderable ? 7 : 1, TEXINFO_T_SIZE, (view, base, i) => {
    const sAxis = i === 0 ? [1, 0, 0] : axes[i - 1].s;
    const tAxis = i === 0 ? [0, 1, 0] : axes[i - 1].t;
    view.setFloat32(base, sAxis[0], true);
    view.setFloat32(base + 4, sAxis[1], true);
    view.setFloat32(base + 8, sAxis[2], true);
    view.setFloat32(base + 12, 0, true);
    view.setFloat32(base + 16, tAxis[0], true);
    view.setFloat32(base + 20, tAxis[1], true);
    view.setFloat32(base + 24, tAxis[2], true);
    view.setFloat32(base + 28, 0, true);
    view.setInt32(base + 32, 0, true); // flags
    view.setInt32(base + 36, 0, true); // value
    writeFixedString(view, base + 40, "wall", 32); // texture
    view.setInt32(base + 72, -1, true); // nexttexinfo
  });

  const vertexesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(24, DVERTEX_T_SIZE, (view, base, i) => {
        const p = wallCorners((i / 4) | 0)[i % 4];
        view.setFloat32(base, p[0], true);
        view.setFloat32(base + 4, p[1], true);
        view.setFloat32(base + 8, p[2], true);
      });

  // DEDGE_EXT_T_SIZE (8): v[0](u32) v[1](u32)
  const edgesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(25, DEDGE_EXT_T_SIZE, (view, base, i) => {
        if (i === 0) {
          view.setUint32(base, 0, true);
          view.setUint32(base + 4, 0, true);
          return;
        }
        const e = i - 1;
        const face = (e / 4) | 0;
        const corner = e % 4;
        view.setUint32(base, face * 4 + corner, true);
        view.setUint32(base + 4, face * 4 + ((corner + 1) % 4), true);
      });

  const surfedgesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(24, 4, (view, base, i) => {
        view.setInt32(base, i + 1, true);
      });

  // DFACE_EXT_T_SIZE (28): planenum(u32) drawflags(u32, pre-masked to
  // DSURF_PLANEBACK) firstedge(i32) numedges(u32) texinfo(u32) styles[4](u8)
  // lightofs(i32)
  const facesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(6, DFACE_EXT_T_SIZE, (view, base, i) => {
        view.setUint32(base, i, true); // planenum
        view.setUint32(base + 4, 0, true); // drawflags (0: not DSURF_PLANEBACK, matching the classic builder's side=0)
        view.setInt32(base + 8, i * 4, true); // firstedge
        view.setUint32(base + 12, 4, true); // numedges
        view.setUint32(base + 16, i + 1, true); // texinfo
        for (let j = 0; j < MAXLIGHTMAPS; j++) view.setUint8(base + 20 + j, j === 0 ? 0 : 255); // styles
        view.setInt32(base + 24, -1, true); // lightofs
      });

  // LEAFFACE_EXT_SIZE (4): facenum(u32), no sentinel
  const leaffacesLump = !renderable
    ? new Uint8Array(0)
    : buildLump(6, LEAFFACE_EXT_SIZE, (view, base, i) => {
        view.setUint32(base, i, true);
      });

  // DLEAF_EXT_T_SIZE (52): contents(i32) cluster(u32) area(u32) mins[3](f32)
  // maxs[3](f32) firstleafface(u32) numleaffaces(u32) firstleafbrush(u32)
  // numleafbrushes(u32)
  const leafsLump = buildLump(2, DLEAF_EXT_T_SIZE, (view, base, i) => {
    const solid = i === SOLID_LEAF;
    view.setInt32(base, solid ? CONTENTS_SOLID : 0, true); // contents
    view.setUint32(base + 4, solid ? 0xffffffff : 0, true); // cluster (-1 sentinel for the solid leaf)
    view.setUint32(base + 8, solid ? 0 : 1, true); // area
    const b = renderable ? ROOM_HALF : 0;
    view.setFloat32(base + 12, -b, true); // mins
    view.setFloat32(base + 16, -b, true);
    view.setFloat32(base + 20, -b, true);
    view.setFloat32(base + 24, b, true); // maxs
    view.setFloat32(base + 28, b, true);
    view.setFloat32(base + 32, b, true);
    view.setUint32(base + 36, renderable && !solid && partialLeafFaces ? PARTIAL_FIRST_LEAFFACE : 0, true); // firstleafface
    view.setUint32(base + 40, renderable && !solid ? (partialLeafFaces ? PARTIAL_NUM_LEAFFACES : 6) : 0, true); // numleaffaces
    view.setUint32(base + 44, 0, true); // firstleafbrush
    view.setUint32(base + 48, solid ? 6 : 0, true); // numleafbrushes
  });

  // LEAFBRUSH_EXT_SIZE (4): brushnum(u32)
  const leafbrushesLump = buildLump(6, LEAFBRUSH_EXT_SIZE, (view, base, i) => {
    view.setUint32(base, i, true);
  });

  const brushesLump = buildLump(6, DBRUSH_T_SIZE, (view, base, i) => {
    view.setInt32(base, i, true); // firstside
    view.setInt32(base + 4, 1, true); // numsides
    view.setInt32(base + 8, CONTENTS_SOLID, true); // contents
  });

  // DBRUSHSIDE_EXT_T_SIZE (8): planenum(u32) texinfo(u32, 0xffffffff sentinel)
  const brushsidesLump = buildLump(6, DBRUSHSIDE_EXT_T_SIZE, (view, base, i) => {
    view.setUint32(base, i, true); // planenum
    view.setUint32(base + 4, 0, true); // texinfo (entry 0: the dummy texinfo, same as the classic builder)
  });

  const modelsLump = buildLump(1, DMODEL_T_SIZE, (view, base) => {
    const h = ROOM_HALF;
    view.setFloat32(base, -h, true);
    view.setFloat32(base + 4, -h, true);
    view.setFloat32(base + 8, -h, true);
    view.setFloat32(base + 12, h, true);
    view.setFloat32(base + 16, h, true);
    view.setFloat32(base + 20, h, true);
    view.setFloat32(base + 24, 0, true); // origin
    view.setFloat32(base + 28, 0, true);
    view.setFloat32(base + 32, 0, true);
    view.setInt32(base + 36, 0, true); // headnode
    view.setInt32(base + 40, 0, true); // firstface (unused)
    view.setInt32(base + 44, 0, true); // numfaces (unused)
  });

  // Two entries, not one: the empty leaf above carries area index 1 (area 0
  // is the solid leaf's), and CMod_LoadLeafsExt (unlike the classic
  // CMod_LoadLeafs buildBoxRoomBsp's fixture relies on) validates every
  // leaf's area against numareas (bsp.c: BSP_ENSURE(area < bsp->numareas,
  // "Bad area")) -- a single-area AREAS lump would fail that check the
  // classic loader never performed.
  const areasLump = buildLump(2, DAREA_T_SIZE, (view, base) => {
    view.setInt32(base, 0, true); // numareaportals
    view.setInt32(base + 4, 0, true); // firstareaportal
  });
  const areaportalsLump = new Uint8Array(0);

  const entitiesLump = stringBytes(entityString);
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
    { index: LUMP_LEAFBRUSHES, data: leafbrushesLump },
    { index: LUMP_EDGES, data: edgesLump },
    { index: LUMP_SURFEDGES, data: surfedgesLump },
    { index: LUMP_MODELS, data: modelsLump },
    { index: LUMP_BRUSHES, data: brushesLump },
    { index: LUMP_BRUSHSIDES, data: brushsidesLump },
    { index: LUMP_POP, data: empty },
    { index: LUMP_AREAS, data: areasLump },
    { index: LUMP_AREAPORTALS, data: areaportalsLump },
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

  outView.setInt32(0, IDBSPHEADER_EXT, true);
  outView.setInt32(4, BSPVERSION, true);
  for (let i = 0; i < HEADER_LUMPS; i++) {
    const info = lumpInfo[i];
    outView.setInt32(8 + i * 8, info.fileofs, true);
    outView.setInt32(8 + i * 8 + 4, info.filelen, true);
  }

  return out;
}
