/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from qcommon/qfiles.h (GNU GPL v2 or later).

qfiles.h: quake file formats

Only the .BSP format structures are ported here (the ones cmodel.c reads).
The .pak (dpackfile_t/dpackheader_t), .pcx (pcx_t), .MD2 (dstvert_t/
dtriangle_t/dtrivertx_t/daliasframe_t/dmdl_t), .SP2 (dsprframe_t/dsprite_t),
and .WAL (miptex_t) formats are not read by cmodel.c and are not trivial
filler (they are real formats with real callers) -- they are deferred to the
future model/image-loading units (src/qcommon/files.ts's PAK reader,
src/client or src/ref_* WAL/MD2/SP2 loaders). Reported per brief.

CONTENTS_ and SURF_ constants are deliberately not redefined here: qfiles.h
duplicates q_shared.h's copy verbatim ("these definitions also need to be in
q_shared.h!"), and src/shared/q_shared.ts already exports them from that
side of the duplication.

Binary structures are parsed from a DataView with explicit little-endian
reads, struct-by-struct, at the same byte offsets as the C layout (see
PORTING.md: "Binary file formats ... parsed from ArrayBuffer with DataView").
Parsed structs are returned as plain interfaces (read-only parse results,
never mutated in place the way the mutable cmodel.ts runtime structures are),
which is why they are typed as `interface` rather than the `class` used for
q_shared.ts's stateful structs.
*/

// upper design bounds
// leaffaces, leafbrushes, planes, and verts are still bounded by
// 16 bit short limits
export const MAX_MAP_MODELS = 1024;
export const MAX_MAP_BRUSHES = 8192;
export const MAX_MAP_ENTITIES = 2048;
export const MAX_MAP_ENTSTRING = 0x40000;
export const MAX_MAP_TEXINFO = 8192;

export const MAX_MAP_AREAS = 256;
export const MAX_MAP_AREAPORTALS = 1024;
// q2repro inc/common/cmodel.h:25 -- bit-packed portal-state buffer size used
// by CM_WritePortalBits/CM_SetPortalStates (the SSV2/SAV2 kex savegame
// container's on-disk portal encoding, one bit per portal instead of the
// legacy one-byte-per-portal CM_WritePortalState/CM_ReadPortalState layout).
export const MAX_MAP_PORTAL_BYTES = 128;
export const MAX_MAP_PLANES = 65536;
export const MAX_MAP_NODES = 65536;
export const MAX_MAP_BRUSHSIDES = 65536;
export const MAX_MAP_LEAFS = 65536;
export const MAX_MAP_VERTS = 65536;
export const MAX_MAP_FACES = 65536;
export const MAX_MAP_LEAFFACES = 65536;
export const MAX_MAP_LEAFBRUSHES = 65536;
export const MAX_MAP_PORTALS = 65536;
export const MAX_MAP_EDGES = 128000;
export const MAX_MAP_SURFEDGES = 256000;
export const MAX_MAP_LIGHTING = 0x200000;
export const MAX_MAP_VISIBILITY = 0x100000;

// key / value pair sizes
export const MAX_KEY = 32;
export const MAX_VALUE = 1024;

//=============================================================================

export interface LumpT {
  fileofs: number;
  filelen: number;
}
export const LUMP_T_SIZE = 8;

export const LUMP_ENTITIES = 0;
export const LUMP_PLANES = 1;
export const LUMP_VERTEXES = 2;
export const LUMP_VISIBILITY = 3;
export const LUMP_NODES = 4;
export const LUMP_TEXINFO = 5;
export const LUMP_FACES = 6;
export const LUMP_LIGHTING = 7;
export const LUMP_LEAFS = 8;
export const LUMP_LEAFFACES = 9;
export const LUMP_LEAFBRUSHES = 10;
export const LUMP_EDGES = 11;
export const LUMP_SURFEDGES = 12;
export const LUMP_MODELS = 13;
export const LUMP_BRUSHES = 14;
export const LUMP_BRUSHSIDES = 15;
export const LUMP_POP = 16;
export const LUMP_AREAS = 17;
export const LUMP_AREAPORTALS = 18;
export const HEADER_LUMPS = 19;

export interface DheaderT {
  ident: number;
  version: number;
  lumps: LumpT[];
}
export const DHEADER_T_SIZE = 4 + 4 + HEADER_LUMPS * LUMP_T_SIZE;

// little-endian "IBSP"
export const IDBSPHEADER = ("P".charCodeAt(0) << 24) + ("S".charCodeAt(0) << 16) + ("B".charCodeAt(0) << 8) + "I".charCodeAt(0);

export const BSPVERSION = 38;

export interface DmodelT {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number]; // for sounds or lights
  headnode: number;
  firstface: number;
  numfaces: number; // submodels just draw faces without walking the bsp tree
}
export const DMODEL_T_SIZE = 48;

export interface DvertexT {
  point: [number, number, number];
}
export const DVERTEX_T_SIZE = 12;

// 0-2 are axial planes
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;

// 3-5 are non-axial planes snapped to the nearest
export const PLANE_ANYX = 3;
export const PLANE_ANYY = 4;
export const PLANE_ANYZ = 5;

// planes (x&~1) and (x&~1)+1 are always opposites

export interface DplaneT {
  normal: [number, number, number];
  dist: number;
  type: number; // PLANE_X - PLANE_ANYZ ?remove? trivial to regenerate
}
export const DPLANE_T_SIZE = 20;

export interface DnodeT {
  planenum: number;
  children: [number, number]; // negative numbers are -(leafs+1), not nodes
  mins: [number, number, number]; // for frustom culling
  maxs: [number, number, number];
  firstface: number;
  numfaces: number; // counting both sides
}
export const DNODE_T_SIZE = 28;

export interface TexinfoT {
  vecs: [[number, number, number, number], [number, number, number, number]]; // [s/t][xyz offset]
  flags: number; // miptex flags + overrides
  value: number; // light emission, etc
  texture: string; // texture name (textures/*.wal)
  nexttexinfo: number; // for animations, -1 = end of chain
}
export const TEXINFO_T_SIZE = 76;

// note that edge 0 is never used, because negative edge nums are used for
// counterclockwise use of the edge in a face
export interface DedgeT {
  v: [number, number]; // vertex numbers
}
export const DEDGE_T_SIZE = 4;

export const MAXLIGHTMAPS = 4;
export interface DfaceT {
  planenum: number;
  side: number;
  firstedge: number; // we must support > 64k edges
  numedges: number;
  texinfo: number;
  styles: [number, number, number, number]; // lighting info
  lightofs: number; // start of [numstyles*surfsize] samples
}
export const DFACE_T_SIZE = 20;

export interface DleafT {
  contents: number; // OR of all brushes (not needed?)
  cluster: number;
  area: number;
  mins: [number, number, number]; // for frustum culling
  maxs: [number, number, number];
  firstleafface: number;
  numleaffaces: number;
  firstleafbrush: number;
  numleafbrushes: number;
}
export const DLEAF_T_SIZE = 28;

export interface DbrushsideT {
  planenum: number; // facing out of the leaf
  texinfo: number;
}
export const DBRUSHSIDE_T_SIZE = 4;

export interface DbrushT {
  firstside: number;
  numsides: number;
  contents: number;
}
export const DBRUSH_T_SIZE = 12;

export const ANGLE_UP = -1;
export const ANGLE_DOWN = -2;

// the visibility lump consists of a header with a count, then
// byte offsets for the PVS and PHS of each cluster, then the raw
// compressed bit vectors
export const DVIS_PVS = 0;
export const DVIS_PHS = 1;

// dvis_t is not parsed into a plain object the way the other structs are:
// in the C original it is a `dvis_t *` cast directly over the raw
// map_visibility buffer (the trailing `bitofs[8][2]` is only a declared
// capacity, not the real one -- the real length is `numclusters`, read from
// the buffer itself). This port keeps that same aliasing: read the header
// fields directly out of a DataView over the live map_visibility buffer.
export function dvisNumClusters(view: DataView): number {
  return view.getInt32(0, true);
}

export function dvisBitofs(view: DataView, cluster: number, which: number): number {
  return view.getInt32(4 + (cluster * 2 + which) * 4, true);
}

// each area has a list of portals that lead into other areas
// when portals are closed, other areas may not be visible or
// hearable even if the vis info says that it should be
export interface DareaportalT {
  portalnum: number;
  otherarea: number;
}
export const DAREAPORTAL_T_SIZE = 8;

export interface DareaT {
  numareaportals: number;
  firstareaportal: number;
}
export const DAREA_T_SIZE = 8;

//=============================================================================
// parse helpers

// reads up to maxLen bytes starting at offset, stopping at the first NUL --
// mirrors treating a fixed C char[] field as a NUL-terminated string.
function readCString(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function readLump(view: DataView, offset: number): LumpT {
  return {
    fileofs: view.getInt32(offset, true),
    filelen: view.getInt32(offset + 4, true),
  };
}

export function readDheader(view: DataView, offset: number): DheaderT {
  const ident = view.getInt32(offset, true);
  const version = view.getInt32(offset + 4, true);
  const lumps: LumpT[] = [];
  for (let i = 0; i < HEADER_LUMPS; i++) {
    lumps.push(readLump(view, offset + 8 + i * LUMP_T_SIZE));
  }
  return { ident, version, lumps };
}

export function readDmodel(view: DataView, offset: number): DmodelT {
  return {
    mins: [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)],
    maxs: [view.getFloat32(offset + 12, true), view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true)],
    origin: [view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true), view.getFloat32(offset + 32, true)],
    headnode: view.getInt32(offset + 36, true),
    firstface: view.getInt32(offset + 40, true),
    numfaces: view.getInt32(offset + 44, true),
  };
}

export function readDplane(view: DataView, offset: number): DplaneT {
  return {
    normal: [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)],
    dist: view.getFloat32(offset + 12, true),
    type: view.getInt32(offset + 16, true),
  };
}

export function readDnode(view: DataView, offset: number): DnodeT {
  return {
    planenum: view.getInt32(offset, true),
    children: [view.getInt32(offset + 4, true), view.getInt32(offset + 8, true)],
    mins: [view.getInt16(offset + 12, true), view.getInt16(offset + 14, true), view.getInt16(offset + 16, true)],
    maxs: [view.getInt16(offset + 18, true), view.getInt16(offset + 20, true), view.getInt16(offset + 22, true)],
    firstface: view.getUint16(offset + 24, true),
    numfaces: view.getUint16(offset + 26, true),
  };
}

export function readTexinfo(view: DataView, offset: number): TexinfoT {
  return {
    vecs: [
      [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true), view.getFloat32(offset + 12, true)],
      [view.getFloat32(offset + 16, true), view.getFloat32(offset + 20, true), view.getFloat32(offset + 24, true), view.getFloat32(offset + 28, true)],
    ],
    flags: view.getInt32(offset + 32, true),
    value: view.getInt32(offset + 36, true),
    texture: readCString(view, offset + 40, 32),
    nexttexinfo: view.getInt32(offset + 72, true),
  };
}

export function readDleaf(view: DataView, offset: number): DleafT {
  return {
    contents: view.getInt32(offset, true),
    cluster: view.getInt16(offset + 4, true),
    area: view.getInt16(offset + 6, true),
    mins: [view.getInt16(offset + 8, true), view.getInt16(offset + 10, true), view.getInt16(offset + 12, true)],
    maxs: [view.getInt16(offset + 14, true), view.getInt16(offset + 16, true), view.getInt16(offset + 18, true)],
    firstleafface: view.getUint16(offset + 20, true),
    numleaffaces: view.getUint16(offset + 22, true),
    firstleafbrush: view.getUint16(offset + 24, true),
    numleafbrushes: view.getUint16(offset + 26, true),
  };
}

export function readDbrushside(view: DataView, offset: number): DbrushsideT {
  return {
    planenum: view.getUint16(offset, true),
    texinfo: view.getInt16(offset + 2, true),
  };
}

export function readDbrush(view: DataView, offset: number): DbrushT {
  return {
    firstside: view.getInt32(offset, true),
    numsides: view.getInt32(offset + 4, true),
    contents: view.getInt32(offset + 8, true),
  };
}

export function readDareaportal(view: DataView, offset: number): DareaportalT {
  return {
    portalnum: view.getInt32(offset, true),
    otherarea: view.getInt32(offset + 4, true),
  };
}

export function readDarea(view: DataView, offset: number): DareaT {
  return {
    numareaportals: view.getInt32(offset, true),
    firstareaportal: view.getInt32(offset + 4, true),
  };
}

// LUMP_LEAFBRUSHES/LUMP_LEAFFACES have no named struct in qfiles.h -- they are
// raw `unsigned short` arrays.
export function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
