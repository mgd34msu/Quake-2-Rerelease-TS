/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_model.h (types) and ref_gl/gl_model.c (Mod_Init,
Mod_ClearAll, Mod_ForName, Mod_PointInLeaf, Mod_ClusterPVS, Mod_Modellist_f,
Mod_Free, Mod_FreeAll, every brush/alias/sprite lump loader, and
R_BeginRegistration/R_RegisterModel/R_EndRegistration) -- GNU GPL v2 or later.

d*_t structures are on-disk representations (qfiles.ts/cmodel.ts already own
the BSP ones); m*_t structures here are the GL renderer's own in-memory
ones -- byte-for-byte the C mnode_t/mleaf_t/msurface_t/etc, distinct from
ref_soft/r_model.ts's identically-named classes (each renderer keeps its own
copy of these structs in the original C, right down to msurface_t growing
GL-only fields like light_s/light_t/dlight_s/dlight_t/lightmapchain that the
software renderer's msurface_t doesn't have).

Hunk_Begin/Hunk_Alloc/Hunk_End/Hunk_Free (the four functions the previous
pending stub carried) are deleted outright rather than ported, per
PORTING.md's "Z_Malloc/Hunk_* -> plain allocation" idiom: every Mod_Load*
helper below just constructs JS objects/arrays directly (mirroring
ref_soft/r_model.ts's identical choice), and `loadmodel.extradatasize` is
set to the loaded file's byte length as a stand-in for Hunk_End()'s byte
count (same substitution r_model.ts makes, see its own Mod_ForName).

GL_BuildPolygonFromSurface / GL_CreateSurfaceLightmap / GL_BeginBuildingLightmaps
/ GL_EndBuildingLightmaps are, in the original C, all defined in gl_rsurf.c
and merely forward-declared inside gl_model.c so Mod_LoadFaces can call
them. gl_rsurf.ts landed for real (concurrently with this unit) and exports
all four, so Mod_LoadFaces below imports and calls them directly rather than
duplicating them here. gl_rsurf.ts's own GL_CreateSurfaceLightmap still
called local stand-ins for gl_light.c's R_SetCacheState/
R_BuildLightMap (its own header comment notes this as a follow-up: "Replace
with real imports once gl_light.ts lands" -- this unit is that gl_light.ts,
but wiring gl_rsurf.ts's call sites to it is that other unit's file to edit,
out of this unit's SCOPE). Until that follow-up lands, `safeCreateSurfaceLightmap`
below tolerated that the same way `safeFindImage` did
GL_FindImage's, so the rest of Mod_LoadFaces (and Mod_LoadBrushModel's
later lump loaders) still runs to completion.

GL_FindImage (gl_image.ts) is fully implemented now (landed concurrently
with this unit), so `safeFindImage` below is mostly a defensive no-op in
practice; it is kept as written (treating any thrown error the same as a
NULL return) since a genuine "image not found" is a normal, non-exceptional
outcome the C code already handles via a NULL check, and there is no reason
to keep any special-casing now that it is rarely,
if ever, hit.
*/

import { type Vec3, vec3, DotProduct, VectorLength, VectorCopy } from "../shared/math";
import { CplaneT, CONTENTS_SOLID, SURF_SKY, SURF_WARP, SURF_TRANS33, SURF_TRANS66, ERR_DROP, PRINT_ALL, Com_sprintf } from "../shared/q_shared";
import {
  type LumpT,
  MAX_MAP_LEAFS,
  MAX_MAP_SURFEDGES,
  IDBSPHEADER,
  BSPVERSION,
  DVERTEX_T_SIZE,
  DEDGE_T_SIZE,
  DFACE_T_SIZE,
  DNODE_T_SIZE,
  DLEAF_T_SIZE,
  DPLANE_T_SIZE,
  DMODEL_T_SIZE,
  TEXINFO_T_SIZE,
  DVIS_PVS,
  LUMP_VERTEXES,
  LUMP_EDGES,
  LUMP_SURFEDGES,
  LUMP_LIGHTING,
  LUMP_PLANES,
  LUMP_TEXINFO,
  LUMP_FACES,
  LUMP_LEAFFACES,
  LUMP_VISIBILITY,
  LUMP_LEAFS,
  LUMP_NODES,
  LUMP_MODELS,
  readDheader,
  readDmodel,
  readDplane,
  readDnode,
  readDleaf,
  readTexinfo,
  dvisNumClusters,
  dvisBitofs,
} from "../qcommon/qfiles";
import { parseBspxDirectory, parseDecoupledLM, parseLightgrid, type DecoupledLmResultT, type LightgridT } from "../qcommon/bspx";
import {
  ri,
  type ImageT,
  ImagetypeT,
  r_notexture,
  r_worldmodel,
  SetWorldModel,
  currentmodel,
  SetCurrentModel,
  registration_sequence,
  SetRegistrationSequence,
  r_viewcluster,
  r_viewcluster2,
  r_oldviewcluster2,
  SetViewClusters,
  MAX_LBM_HEIGHT,
} from "./gl_local";
import { GL_FindImage, GL_FreeUnusedImages } from "./gl_image";
import { GL_SubdivideSurface } from "./gl_warp";
import { GL_BuildPolygonFromSurface, GL_CreateSurfaceLightmap, GL_BeginBuildingLightmaps, GL_EndBuildingLightmaps } from "./gl_rsurf";

// mplane_t is byte-for-byte the same struct as q_shared.ts's CplaneT
// (cplane_t) -- see r_model.ts's identical MplaneT alias and comment.
export type MplaneT = CplaneT;

export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4;
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_UNDERWATER = 0x80;

// !!! if this is changed, it must be changed in asm_draw.h too !!! (C
// comment on mvertex_t/medge_t; the x86 asm path is dropped project-wide
// per PORTING.md, kept here only as the original context for the comment)
export class MvertexT {
  position: Vec3 = vec3();
}

export const MAXLIGHTMAPS = 4;

export class MedgeT {
  v: [number, number] = [0, 0];
  cachededgeoffset = 0;
}

export class MtexinfoT {
  vecs: [Float32Array, Float32Array] = [new Float32Array(4), new Float32Array(4)];
  flags = 0;
  numframes = 0;
  next: MtexinfoT | null = null; // animation chain
  image: ImageT | null = null;
}

export const VERTEXSIZE = 7;

// variable sized in C (`float verts[4][VERTEXSIZE]` is a flexible tail,
// Hunk_Alloc'd to fit `numverts`); modeled as a growable array of
// VERTEXSIZE-length rows (xyz s1t1 s2t2) rather than a fixed C array.
export class GlpolyT {
  next: GlpolyT | null = null;
  chain: GlpolyT | null = null;
  numverts = 0;
  flags = 0; // for SURF_UNDERWATER (not needed anymore?)
  verts: Float32Array[] = [];
}

export class MsurfaceT {
  visframe = 0; // should be drawn when node is crossed

  plane: MplaneT | null = null;
  flags = 0;

  firstedge = 0; // look up in model->surfedges[], negative numbers
  numedges = 0; // are backwards edges

  texturemins: [number, number] = [0, 0];
  extents: [number, number] = [0, 0];

  light_s = 0;
  light_t = 0; // gl lightmap coordinates
  dlight_s = 0;
  dlight_t = 0; // gl lightmap coordinates for dynamic lightmaps

  polys: GlpolyT | null = null; // multiple if warped
  texturechain: MsurfaceT | null = null;
  lightmapchain: MsurfaceT | null = null;

  texinfo: MtexinfoT | null = null;

  // lighting info
  dlightframe = 0;
  dlightbits = 0;

  lightmaptexturenum = 0;
  styles: number[] = new Array<number>(MAXLIGHTMAPS).fill(0);
  cached_light: number[] = new Array<number>(MAXLIGHTMAPS).fill(0); // values currently used in lightmap
  samples: Uint8Array | null = null; // [numstyles*surfsize]
}

export const CONTENTS_NODE = -1;

// mnode_t/mleaf_t share a leading "common with leaf"/"common with node"
// field prefix in C so a node's `children[2]` can point at either;
// `contents !== CONTENTS_NODE` is the C idiom for telling them apart.
// Modeled as a discriminated union over that field, matching r_model.ts's
// identical MnodeOrLeaf/isMleaf pair.
export type MnodeOrLeaf = MnodeT | MleafT;

export function isMleaf(n: MnodeOrLeaf): n is MleafT {
  return n.contents !== CONTENTS_NODE;
}

export class MnodeT {
  // common with leaf
  contents: number = CONTENTS_NODE;
  visframe = 0;

  minmaxs: number[] = new Array<number>(6).fill(0); // for bounding box culling

  parent: MnodeT | null = null;

  // node specific
  plane: MplaneT | null = null;
  children: [MnodeOrLeaf | null, MnodeOrLeaf | null] = [null, null];

  firstsurface = 0;
  numsurfaces = 0;
}

export class MleafT {
  // common with node
  contents = 0; // will be a negative contents number
  visframe = 0;

  minmaxs: number[] = new Array<number>(6).fill(0);

  parent: MnodeT | null = null;

  // leaf specific
  cluster = 0;
  area = 0;

  firstmarksurface: MsurfaceT[] = []; // slice into model.marksurfaces starting here
  nummarksurfaces = 0;
}

//===================================================================

export const MAX_MD2SKINS = 32;

export enum ModtypeT {
  mod_bad,
  mod_brush,
  mod_sprite,
  mod_alias,
}

// mmodel_t: gl_model.h's own in-memory submodel record, distinct from
// qfiles.ts's DmodelT (the raw on-disk dmodel_t) -- it carries two fields
// (`radius`, `visleafs`) that only exist after Mod_LoadSubmodels computes/
// copies them, so it cannot reuse DmodelT directly (see RadiusFromBounds
// below and this unit's report for `visleafs`, which the original C never
// actually initializes).
export interface MmodelT {
  mins: Vec3;
  maxs: Vec3;
  origin: Vec3;
  radius: number;
  headnode: number;
  visleafs: number;
  firstface: number;
  numfaces: number;
}

export class ModelT {
  name = ""; // MAX_QPATH

  registration_sequence = 0;

  type: ModtypeT = ModtypeT.mod_bad;
  numframes = 0;

  flags = 0;

  // volume occupied by the model graphics
  mins: Vec3 = vec3();
  maxs: Vec3 = vec3();
  radius = 0;

  // solid volume for clipping
  clipbox = false;
  clipmins: Vec3 = vec3();
  clipmaxs: Vec3 = vec3();

  // brush model
  firstmodelsurface = 0;
  nummodelsurfaces = 0;
  lightmap = 0; // only for submodels

  numsubmodels = 0;
  submodels: MmodelT[] = [];

  numplanes = 0;
  planes: MplaneT[] = [];

  numleafs = 0; // number of visible leafs, not counting 0
  leafs: MleafT[] = [];

  numvertexes = 0;
  vertexes: MvertexT[] = [];

  numedges = 0;
  edges: MedgeT[] = [];

  numnodes = 0;
  firstnode = 0;
  nodes: MnodeT[] = [];

  numtexinfo = 0;
  texinfo: MtexinfoT[] = [];

  numsurfaces = 0;
  surfaces: MsurfaceT[] = [];

  numsurfedges = 0;
  surfedges: number[] = [];

  nummarksurfaces = 0;
  marksurfaces: MsurfaceT[] = [];

  // dvis_t is aliased over the raw visibility lump, not parsed into a
  // struct -- see qfiles.ts's dvisNumClusters/dvisBitofs, which read
  // straight out of this buffer (mirrors r_model.ts's ModelT.vis).
  vis: Uint8Array | null = null;

  lightdata: Uint8Array | null = null;

  // for alias models and skins
  skins: (ImageT | null)[] = new Array<ImageT | null>(MAX_MD2SKINS).fill(null);

  extradatasize = 0;
  extradata: unknown = null; // opaque cache blob owned by this file's alias/sprite/brush loaders

  // BSPX extension data (see qcommon/bspx.ts). null for every classic BSP
  // (no BSPX directory at all) and for any BSPX directory that doesn't
  // carry DECOUPLED_LM/LIGHTGRID_OCTREE. PARSED ONLY -- neither lump is
  // wired into the actual lightmap-building/sampling pipeline yet (see
  // Mod_LoadBrushModel's BSPX block below for the exact scope boundary).
  bspx: { decoupledLm: DecoupledLmResultT | null; lightgrid: LightgridT | null } | null = null;

  // mirrors `memset(mod, 0, sizeof(*mod))` (Mod_Free/R_EndRegistration) per
  // PORTING.md's clear()-for-memset convention.
  clear(): void {
    Object.assign(this, new ModelT());
  }
}

// gl_model.c's own #define MAX_MOD_KNOWN is 512 (ref_soft/r_model.c's is
// 256 -- the two engines picked different limits for the same purpose).
const MAX_MOD_KNOWN = 512;
export const mod_known: ModelT[] = Array.from({ length: MAX_MOD_KNOWN }, () => new ModelT());
let mod_numknown = 0;
// the inline * models from the current map are kept seperate
export const mod_inline: ModelT[] = Array.from({ length: MAX_MOD_KNOWN }, () => new ModelT());

let modfilelen = 0;

const mod_novis = new Uint8Array(MAX_MAP_LEAFS / 8);

// mutable "current load" pointers, mirroring r_model.c's loadmodel/mod_base
// globals (reassigned across every Mod_Load* helper call, never read before
// Mod_ForName assigns them).
export let loadmodel: ModelT = new ModelT();
let mod_view: DataView = new DataView(new ArrayBuffer(0));

function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// reads up to maxLen bytes starting at offset, stopping at the first NUL --
// same helper as qfiles.ts's private readCString / r_model.ts's own copy.
function readCString(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// gl_image.ts's GL_FindImage is real and returns null for a missing image,
// exactly the C NULL return every caller here already handles.
function safeFindImage(name: string, type: ImagetypeT): ImageT | null {
  return GL_FindImage(name, type);
}

/*
===============
Mod_PointInLeaf
===============
*/
export function Mod_PointInLeaf(p: Vec3, model: ModelT): MleafT {
  if (!model || model.nodes.length === 0) {
    ri.Sys_Error(ERR_DROP, "Mod_PointInLeaf: bad model");
  }

  let node: MnodeOrLeaf = model.nodes[0];
  for (;;) {
    if (isMleaf(node)) return node;
    const plane: MplaneT | null = node.plane;
    if (!plane) {
      ri.Sys_Error(ERR_DROP, "Mod_PointInLeaf: bad model");
    }
    const d: number = DotProduct(p, plane.normal) - plane.dist;
    const child: MnodeOrLeaf | null = d > 0 ? node.children[0] : node.children[1];
    if (!child) {
      ri.Sys_Error(ERR_DROP, "Mod_PointInLeaf: bad model");
    }
    node = child;
  }
}

/*
===================
Mod_DecompressVis
===================
*/
const decompressedVis = new Uint8Array(MAX_MAP_LEAFS / 8);

function Mod_DecompressVis(vis: Uint8Array, inOffset: number): Uint8Array {
  const view = new DataView(vis.buffer, vis.byteOffset, vis.byteLength);
  const row = (dvisNumClusters(view) + 7) >> 3;

  let outIdx = 0;
  let inIdx = inOffset;
  do {
    if (vis[inIdx] !== 0) {
      decompressedVis[outIdx++] = vis[inIdx++];
      continue;
    }

    let c = vis[inIdx + 1];
    inIdx += 2;
    while (c > 0) {
      decompressedVis[outIdx++] = 0;
      c--;
    }
  } while (outIdx < row);

  return decompressedVis;
}

/*
==============
Mod_ClusterPVS
==============
*/
export function Mod_ClusterPVS(cluster: number, model: ModelT): Uint8Array {
  if (cluster === -1 || !model.vis) return mod_novis;
  const view = new DataView(model.vis.buffer, model.vis.byteOffset, model.vis.byteLength);
  const offset = dvisBitofs(view, cluster, DVIS_PVS);
  return Mod_DecompressVis(model.vis, offset);
}

//===============================================================================

/*
================
Mod_Modellist_f
================
*/
export function Mod_Modellist_f(): void {
  let total = 0;
  ri.Con_Printf(PRINT_ALL, "Loaded models:\n");
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    if (mod.name === "") continue;
    ri.Con_Printf(PRINT_ALL, `${String(mod.extradatasize).padStart(8)} : ${mod.name}\n`);
    total += mod.extradatasize;
  }
  ri.Con_Printf(PRINT_ALL, `Total resident: ${total}\n`);
}

/*
===============
Mod_Init
===============
*/
export function Mod_Init(): void {
  mod_novis.fill(0xff);
}

// Mod_ClearAll is declared in gl_model.h but has no function body anywhere
// in the ref_gl tree (confirmed by grepping the whole tree) -- a dead
// declaration, exactly like ref_soft/r_model.ts's identical Mod_ClearAll.
// Nothing to port; the C declaration is bodyless, so a caller reaching it is
// a bug in the (nonexistent) original.
export function Mod_ClearAll(): void {
  throw new Error("Mod_ClearAll: bodyless declaration in the C source; no caller should reach it");
}

/*
==================
Mod_ForName

Loads in a model for the given name
==================
*/
export function Mod_ForName(name: string, crash: boolean): ModelT | null {
  if (!name || name.length === 0) {
    ri.Sys_Error(ERR_DROP, "Mod_ForName: NULL name");
  }

  //
  // inline models are grabbed only from worldmodel
  //
  if (name[0] === "*") {
    const i = atoi(name.slice(1));
    if (i < 1 || !r_worldmodel || i >= r_worldmodel.numsubmodels) {
      ri.Sys_Error(ERR_DROP, "bad inline model number");
    }
    return mod_inline[i];
  }

  //
  // search the currently loaded models
  //
  for (let i = 0; i < mod_numknown; i++) {
    if (mod_known[i].name === name) return mod_known[i];
  }

  //
  // find a free model slot spot
  //
  let i = 0;
  for (; i < mod_numknown; i++) {
    if (mod_known[i].name === "") break; // free spot
  }
  if (i === mod_numknown) {
    if (mod_numknown === MAX_MOD_KNOWN) {
      ri.Sys_Error(ERR_DROP, "mod_numknown == MAX_MOD_KNOWN");
    }
    mod_numknown++;
  }
  const mod = mod_known[i];
  mod.name = name;

  //
  // load the file
  //
  const { length, data: buf } = ri.FS_LoadFile(mod.name);
  modfilelen = length;
  if (!buf) {
    if (crash) {
      ri.Sys_Error(ERR_DROP, `Mod_NumForName: ${mod.name} not found`);
    }
    mod.name = "";
    return null;
  }

  loadmodel = mod;

  //
  // fill it in
  //
  mod_view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // call the apropriate loader
  const ident = mod_view.getInt32(0, true);

  switch (ident) {
    case IDALIASHEADER:
      Mod_LoadAliasModel(mod, buf);
      break;

    case IDSPRITEHEADER:
      Mod_LoadSpriteModel(mod, buf);
      break;

    case IDBSPHEADER:
      Mod_LoadBrushModel(mod, buf);
      break;

    default:
      ri.Sys_Error(ERR_DROP, `Mod_NumForName: unknown fileid for ${mod.name}`);
  }

  loadmodel.extradatasize = buf.length; // stands in for Hunk_End()'s byte count -- see file header

  ri.FS_FreeFile(buf);

  return mod;
}

/*
===============================================================================

					BRUSHMODEL LOADING

===============================================================================
*/

/*
=================
Mod_LoadLighting

Unlike ref_soft/r_model.ts's Mod_LoadLighting, the GL renderer keeps the
full 24 bit RGB lighting data as-is (no brightest-component reduction to 8
bit) -- msurface_t.samples offsets index straight into this buffer in
triples, see Mod_LoadFaces/R_BuildLightMap.
=================
*/
function Mod_LoadLighting(l: LumpT): void {
  if (!l.filelen) {
    loadmodel.lightdata = null;
    return;
  }
  const out = new Uint8Array(l.filelen);
  for (let i = 0; i < l.filelen; i++) out[i] = mod_view.getUint8(l.fileofs + i);
  loadmodel.lightdata = out;
}

/*
=================
Mod_LoadVisibility
=================
*/
function Mod_LoadVisibility(l: LumpT): void {
  if (!l.filelen) {
    loadmodel.vis = null;
    return;
  }
  const out = new Uint8Array(l.filelen);
  for (let i = 0; i < l.filelen; i++) out[i] = mod_view.getUint8(l.fileofs + i);
  loadmodel.vis = out;
  // the C original re-byteswaps numclusters/bitofs in place here; a no-op on
  // this little-endian-only port (dvisNumClusters/dvisBitofs already read
  // little-endian values directly out of this buffer).
}

/*
=================
Mod_LoadVertexes
=================
*/
function Mod_LoadVertexes(l: LumpT): void {
  if (l.filelen % DVERTEX_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DVERTEX_T_SIZE;
  const out: MvertexT[] = [];
  for (let i = 0; i < count; i++) {
    const base = l.fileofs + i * DVERTEX_T_SIZE;
    const v = new MvertexT();
    v.position[0] = mod_view.getFloat32(base, true);
    v.position[1] = mod_view.getFloat32(base + 4, true);
    v.position[2] = mod_view.getFloat32(base + 8, true);
    out.push(v);
  }
  loadmodel.vertexes = out;
  loadmodel.numvertexes = count;
}

/*
=================
RadiusFromBounds
=================
*/
function RadiusFromBounds(mins: Vec3, maxs: Vec3): number {
  const corner = vec3();
  for (let i = 0; i < 3; i++) {
    corner[i] = Math.abs(mins[i]) > Math.abs(maxs[i]) ? Math.abs(mins[i]) : Math.abs(maxs[i]);
  }
  return VectorLength(corner);
}

/*
=================
Mod_LoadSubmodels
=================
*/
function Mod_LoadSubmodels(l: LumpT): void {
  if (l.filelen % DMODEL_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DMODEL_T_SIZE;
  const out: MmodelT[] = [];
  for (let i = 0; i < count; i++) {
    const din = readDmodel(mod_view, l.fileofs + i * DMODEL_T_SIZE);
    // spread the mins / maxs by a pixel
    const mins = vec3(din.mins[0] - 1, din.mins[1] - 1, din.mins[2] - 1);
    const maxs = vec3(din.maxs[0] + 1, din.maxs[1] + 1, din.maxs[2] + 1);
    out.push({
      mins,
      maxs,
      origin: vec3(din.origin[0], din.origin[1], din.origin[2]),
      radius: RadiusFromBounds(mins, maxs),
      headnode: din.headnode,
      // the original never initializes mmodel_t.visleafs anywhere in
      // Mod_LoadSubmodels (confirmed against gl_model.c) -- it relies on
      // Hunk_Alloc's backing memory already being zero. Assumed zero here
      // too, matching that implicit precondition; see this unit's report.
      visleafs: 0,
      firstface: din.firstface,
      numfaces: din.numfaces,
    });
  }
  loadmodel.submodels = out;
  loadmodel.numsubmodels = count;
}

/*
=================
Mod_LoadEdges
=================
*/
function Mod_LoadEdges(l: LumpT): void {
  if (l.filelen % DEDGE_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DEDGE_T_SIZE;
  const out: MedgeT[] = [];
  for (let i = 0; i < count; i++) {
    const base = l.fileofs + i * DEDGE_T_SIZE;
    const e = new MedgeT();
    e.v[0] = mod_view.getUint16(base, true);
    e.v[1] = mod_view.getUint16(base + 2, true);
    out.push(e);
  }
  loadmodel.edges = out;
  loadmodel.numedges = count;
}

/*
=================
Mod_LoadTexinfo
=================
*/
function Mod_LoadTexinfo(l: LumpT): void {
  if (l.filelen % TEXINFO_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / TEXINFO_T_SIZE;
  const out: MtexinfoT[] = [];
  for (let i = 0; i < count; i++) out.push(new MtexinfoT());
  loadmodel.texinfo = out;
  loadmodel.numtexinfo = count;

  for (let i = 0; i < count; i++) {
    const din = readTexinfo(mod_view, l.fileofs + i * TEXINFO_T_SIZE);
    const t = out[i];

    for (let j = 0; j < 4; j++) {
      t.vecs[0][j] = din.vecs[0][j];
      t.vecs[1][j] = din.vecs[1][j];
    }

    t.flags = din.flags;
    const next = din.nexttexinfo;
    t.next = next > 0 ? out[next] : null;

    const name = Com_sprintf("textures/%s.wal", din.texture);
    const image = safeFindImage(name, ImagetypeT.it_wall);
    if (!image) {
      ri.Con_Printf(PRINT_ALL, `Couldn't load ${name}\n`);
      t.image = r_notexture;
    } else {
      t.image = image;
    }
  }

  // count animation frames
  for (let i = 0; i < count; i++) {
    const t = out[i];
    t.numframes = 1;
    let step = t.next;
    while (step && step !== t) {
      t.numframes++;
      step = step.next;
    }
  }
}

/*
================
CalcSurfaceExtents

Fills in s->texturemins[] and s->extents[]. Unlike ref_soft/r_model.ts's
identically-named helper, the GL original has no "Bad surface extents"
check and no "take at least one cache block" clamp -- both are specific to
the software rasterizer's surface cache and are commented out/absent in
gl_model.c's own CalcSurfaceExtents.
================
*/
function CalcSurfaceExtents(s: MsurfaceT): void {
  const mins = [999999, 999999];
  const maxs = [-99999, -99999];

  const tex = s.texinfo;
  if (!tex) {
    ri.Sys_Error(ERR_DROP, "CalcSurfaceExtents: no texinfo");
    return;
  }

  for (let i = 0; i < s.numedges; i++) {
    const e = loadmodel.surfedges[s.firstedge + i];
    const v = e >= 0 ? loadmodel.vertexes[loadmodel.edges[e].v[0]] : loadmodel.vertexes[loadmodel.edges[-e].v[1]];

    for (let j = 0; j < 2; j++) {
      const val = v.position[0] * tex.vecs[j][0] + v.position[1] * tex.vecs[j][1] + v.position[2] * tex.vecs[j][2] + tex.vecs[j][3];
      if (val < mins[j]) mins[j] = val;
      if (val > maxs[j]) maxs[j] = val;
    }
  }

  for (let i = 0; i < 2; i++) {
    const bmin = Math.floor(mins[i] / 16);
    const bmax = Math.ceil(maxs[i] / 16);

    s.texturemins[i] = bmin * 16;
    s.extents[i] = (bmax - bmin) * 16;
  }
}

function safeCreateSurfaceLightmap(surf: MsurfaceT): void {
  GL_CreateSurfaceLightmap(surf); // gl_rsurf.ts imports the real gl_light.ts pair now
}

/*
=================
Mod_LoadFaces
=================
*/
function Mod_LoadFaces(l: LumpT): void {
  if (l.filelen % DFACE_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DFACE_T_SIZE;
  const out: MsurfaceT[] = [];
  for (let i = 0; i < count; i++) out.push(new MsurfaceT());
  loadmodel.surfaces = out;
  loadmodel.numsurfaces = count;

  SetCurrentModel(loadmodel);

  GL_BeginBuildingLightmaps(loadmodel);

  for (let surfnum = 0; surfnum < count; surfnum++) {
    const base = l.fileofs + surfnum * DFACE_T_SIZE;
    const s = out[surfnum];

    s.firstedge = mod_view.getInt32(base + 4, true);
    s.numedges = mod_view.getInt16(base + 8, true);
    s.flags = 0;
    s.polys = null;

    const planenum = mod_view.getUint16(base, true);
    const side = mod_view.getInt16(base + 2, true);
    if (side) s.flags |= SURF_PLANEBACK;

    s.plane = loadmodel.planes[planenum];

    const ti = mod_view.getInt16(base + 10, true);
    if (ti < 0 || ti >= loadmodel.numtexinfo) ri.Sys_Error(ERR_DROP, "MOD_LoadBmodel: bad texinfo number");
    s.texinfo = loadmodel.texinfo[ti];

    CalcSurfaceExtents(s);

    // lighting info
    for (let i = 0; i < MAXLIGHTMAPS; i++) s.styles[i] = mod_view.getUint8(base + 12 + i);
    const lightofs = mod_view.getInt32(base + 16, true);
    s.samples = lightofs === -1 ? null : loadmodel.lightdata ? loadmodel.lightdata.subarray(lightofs) : null;

    // set the drawing flags
    if (s.texinfo.flags & SURF_WARP) {
      s.flags |= SURF_DRAWTURB;
      s.extents[0] = 16384;
      s.extents[1] = 16384;
      s.texturemins[0] = -8192;
      s.texturemins[1] = -8192;
      GL_SubdivideSurface(s); // cut up polygon for warps
    }

    // create lightmaps and polygons
    if (!(s.texinfo.flags & (SURF_SKY | SURF_TRANS33 | SURF_TRANS66 | SURF_WARP))) safeCreateSurfaceLightmap(s);

    if (!(s.texinfo.flags & SURF_WARP)) GL_BuildPolygonFromSurface(s);
  }

  GL_EndBuildingLightmaps();
}

/*
=================
Mod_SetParent
=================
*/
function Mod_SetParent(node: MnodeOrLeaf, parent: MnodeT | null): void {
  node.parent = parent;
  if (isMleaf(node)) return;
  const c0 = node.children[0];
  const c1 = node.children[1];
  if (c0) Mod_SetParent(c0, node);
  if (c1) Mod_SetParent(c1, node);
}

/*
=================
Mod_LoadNodes
=================
*/
function Mod_LoadNodes(l: LumpT): void {
  if (l.filelen % DNODE_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DNODE_T_SIZE;
  const out: MnodeT[] = [];
  for (let i = 0; i < count; i++) out.push(new MnodeT());
  loadmodel.nodes = out;
  loadmodel.numnodes = count;

  for (let i = 0; i < count; i++) {
    const din = readDnode(mod_view, l.fileofs + i * DNODE_T_SIZE);
    const n = out[i];

    for (let j = 0; j < 3; j++) {
      n.minmaxs[j] = din.mins[j];
      n.minmaxs[3 + j] = din.maxs[j];
    }

    n.plane = loadmodel.planes[din.planenum];
    n.firstsurface = din.firstface;
    n.numsurfaces = din.numfaces;
    n.contents = CONTENTS_NODE; // differentiate from leafs

    for (let j = 0; j < 2; j++) {
      const p = din.children[j];
      if (p >= 0) n.children[j] = loadmodel.nodes[p];
      else n.children[j] = loadmodel.leafs[-1 - p];
    }
  }

  Mod_SetParent(loadmodel.nodes[0], null); // sets nodes and leafs
}

/*
=================
Mod_LoadLeafs
=================
*/
function Mod_LoadLeafs(l: LumpT): void {
  if (l.filelen % DLEAF_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DLEAF_T_SIZE;
  const out: MleafT[] = [];
  for (let i = 0; i < count; i++) out.push(new MleafT());
  loadmodel.leafs = out;
  loadmodel.numleafs = count;

  for (let i = 0; i < count; i++) {
    const din = readDleaf(mod_view, l.fileofs + i * DLEAF_T_SIZE);
    const lf = out[i];

    for (let j = 0; j < 3; j++) {
      lf.minmaxs[j] = din.mins[j];
      lf.minmaxs[3 + j] = din.maxs[j];
    }

    lf.contents = din.contents;
    lf.cluster = din.cluster;
    lf.area = din.area;

    lf.firstmarksurface = loadmodel.marksurfaces.slice(din.firstleafface);
    lf.nummarksurfaces = din.numleaffaces;

    // gl underwater warp: dropped, wrapped in `#if 0` in the original
    // (CONTENTS_WATER/SLIME/LAVA/THINWATER SURF_UNDERWATER flagging) --
    // dead code, never compiled into the real engine either.
  }
}

/*
=================
Mod_LoadMarksurfaces
=================
*/
function Mod_LoadMarksurfaces(l: LumpT): void {
  if (l.filelen % 2) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / 2;
  const out: MsurfaceT[] = [];
  for (let i = 0; i < count; i++) {
    const j = mod_view.getInt16(l.fileofs + i * 2, true);
    if (j < 0 || j >= loadmodel.numsurfaces) ri.Sys_Error(ERR_DROP, "Mod_ParseMarksurfaces: bad surface number");
    out.push(loadmodel.surfaces[j]);
  }
  loadmodel.marksurfaces = out;
  loadmodel.nummarksurfaces = count;
}

/*
=================
Mod_LoadSurfedges
=================
*/
function Mod_LoadSurfedges(l: LumpT): void {
  if (l.filelen % 4) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / 4;
  if (count < 1 || count >= MAX_MAP_SURFEDGES) {
    ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: bad surfedges count in ${loadmodel.name}: ${count}`);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(mod_view.getInt32(l.fileofs + i * 4, true));
  loadmodel.surfedges = out;
  loadmodel.numsurfedges = count;
}

/*
=================
Mod_LoadPlanes
=================
*/
function Mod_LoadPlanes(l: LumpT): void {
  if (l.filelen % DPLANE_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DPLANE_T_SIZE;
  const out: MplaneT[] = [];
  for (let i = 0; i < count; i++) {
    const din = readDplane(mod_view, l.fileofs + i * DPLANE_T_SIZE);
    const p = new CplaneT();
    let bits = 0;
    for (let j = 0; j < 3; j++) {
      p.normal[j] = din.normal[j];
      if (p.normal[j] < 0) bits |= 1 << j;
    }
    p.dist = din.dist;
    p.type = din.type;
    p.signbits = bits;
    out.push(p);
  }
  loadmodel.planes = out;
  loadmodel.numplanes = count;
}

/*
=================
Mod_LoadBrushModel
=================
*/
function Mod_LoadBrushModel(mod: ModelT, buffer: Uint8Array): void {
  loadmodel.type = ModtypeT.mod_brush;
  if (loadmodel !== mod_known[0]) {
    ri.Sys_Error(ERR_DROP, "Loaded a brush model after the world");
  }

  const header = readDheader(mod_view, 0);
  if (header.version !== BSPVERSION) {
    ri.Sys_Error(ERR_DROP, `Mod_LoadBrushModel: ${mod.name} has wrong version number (${header.version} should be ${BSPVERSION})`);
  }

  // the C original's manual byteswap-in-place loop over the header ints is a
  // no-op on this little-endian-only port; every Load* helper below reads
  // its own fields through a little-endian DataView instead (mod_view, set
  // by Mod_ForName before this function runs).

  // load into heap
  Mod_LoadVertexes(header.lumps[LUMP_VERTEXES]);
  Mod_LoadEdges(header.lumps[LUMP_EDGES]);
  Mod_LoadSurfedges(header.lumps[LUMP_SURFEDGES]);
  Mod_LoadLighting(header.lumps[LUMP_LIGHTING]);
  Mod_LoadPlanes(header.lumps[LUMP_PLANES]);
  Mod_LoadTexinfo(header.lumps[LUMP_TEXINFO]);
  Mod_LoadFaces(header.lumps[LUMP_FACES]);
  Mod_LoadMarksurfaces(header.lumps[LUMP_LEAFFACES]);
  Mod_LoadVisibility(header.lumps[LUMP_VISIBILITY]);
  Mod_LoadLeafs(header.lumps[LUMP_LEAFS]);
  Mod_LoadNodes(header.lumps[LUMP_NODES]);
  Mod_LoadSubmodels(header.lumps[LUMP_MODELS]);
  mod.numframes = 2; // regular and alternate animation

  // BSPX extension directory -- not part of q2repro's bsp.c (which this
  // renderer's Load* functions above are otherwise NOT ported from: this
  // is vanilla-shape gl_model.c). Parse-and-report only, see qcommon/bspx.ts's
  // header comment and ModelT.bspx's comment above for exactly what's not
  // wired up (the lightmap-building and lighting-sampling pipeline still
  // ignores decoupled lightmaps and the lightgrid entirely).
  {
    const lumpsEnd = header.lumps.reduce((max, l) => Math.max(max, l.fileofs + l.filelen), 0);
    const bspxDir = parseBspxDirectory(buffer, lumpsEnd, buffer.length);
    let decoupledLm: DecoupledLmResultT | null = null;
    let lightgrid: LightgridT | null = null;

    if (bspxDir) {
      const lightingLump = header.lumps[LUMP_LIGHTING];

      const dlm = bspxDir.lumps.get("DECOUPLED_LM");
      if (dlm) {
        decoupledLm = parseDecoupledLM(buffer, dlm.fileofs, dlm.filelen, loadmodel.numsurfaces, lightingLump.filelen);
        if (decoupledLm) ri.Con_Printf(PRINT_ALL, `${mod.name}: DECOUPLED_LM lump present (${decoupledLm.faces.length} faces)\n`);
      }

      const lightgridLump = bspxDir.lumps.get("LIGHTGRID_OCTREE");
      if (lightgridLump) {
        lightgrid = parseLightgrid(buffer, lightgridLump.fileofs, lightgridLump.filelen, lightingLump.filelen > 0);
        if (lightgrid) ri.Con_Printf(PRINT_ALL, `${mod.name}: LIGHTGRID_OCTREE lump present (${lightgrid.numleafs} leafs, ${lightgrid.numsamples} samples)\n`);
      }
    }

    loadmodel.bspx = decoupledLm || lightgrid ? { decoupledLm, lightgrid } : null;
  }

  //
  // set up the submodels
  //
  for (let i = 0; i < mod.numsubmodels; i++) {
    const bm = mod.submodels[i];
    const starmod = mod_inline[i];

    starmod.clear();
    Object.assign(starmod, loadmodel); // *starmod = *loadmodel; (shallow struct copy)
    // C's `*starmod = *loadmodel` copies the embedded vec3_t arrays BY
    // VALUE; Object.assign shares the Float32Array references, so every
    // submodel's VectorCopy below wrote into ONE shared bounds array --
    // all inline models (and the world) ended up with the LAST submodel's
    // mins/maxs, and R_CullBox culled movers by the wrong box (the
    // view-dependent vanishing-elevator bug). Re-own the vec3 fields.
    starmod.mins = vec3(loadmodel.mins[0], loadmodel.mins[1], loadmodel.mins[2]);
    starmod.maxs = vec3(loadmodel.maxs[0], loadmodel.maxs[1], loadmodel.maxs[2]);
    starmod.clipmins = vec3(loadmodel.clipmins[0], loadmodel.clipmins[1], loadmodel.clipmins[2]);
    starmod.clipmaxs = vec3(loadmodel.clipmaxs[0], loadmodel.clipmaxs[1], loadmodel.clipmaxs[2]);

    starmod.firstmodelsurface = bm.firstface;
    starmod.nummodelsurfaces = bm.numfaces;
    starmod.firstnode = bm.headnode;
    if (starmod.firstnode >= loadmodel.numnodes) {
      ri.Sys_Error(ERR_DROP, `Inline model ${i} has bad firstnode`);
    }

    VectorCopy(bm.maxs, starmod.maxs);
    VectorCopy(bm.mins, starmod.mins);
    starmod.radius = bm.radius;

    if (i === 0) {
      Object.assign(loadmodel, starmod); // *loadmodel = *starmod;
      // same by-value semantics for the copy-back (see above)
      loadmodel.mins = vec3(starmod.mins[0], starmod.mins[1], starmod.mins[2]);
      loadmodel.maxs = vec3(starmod.maxs[0], starmod.maxs[1], starmod.maxs[2]);
      loadmodel.clipmins = vec3(starmod.clipmins[0], starmod.clipmins[1], starmod.clipmins[2]);
      loadmodel.clipmaxs = vec3(starmod.clipmaxs[0], starmod.clipmaxs[1], starmod.clipmaxs[2]);
    }

    starmod.numleafs = bm.visleafs;
  }
}

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

// qfiles.ts's own report defers the MD2/SP2 formats to a future unit;
// gl_model.c's brush/alias/sprite loading is itself pending, so these are
// declared locally rather than blocked on that future unit -- same values
// as ref_soft/r_model.ts's identical constants (both engines share the one
// on-disk MD2/SP2 format).
export const IDALIASHEADER = ("2".charCodeAt(0) << 24) + ("P".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
export const ALIAS_VERSION = 8;
export const MAX_TRIANGLES = 4096;
export const MAX_VERTS = 2048;
export const MAX_FRAMES = 512;
export const MAX_SKINNAME = 64;

export const IDSPRITEHEADER = ("2".charCodeAt(0) << 24) + ("S".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
export const SPRITE_VERSION = 2;

// dsprframe_t: int width, height, origin_x, origin_y (16 bytes) + char
// name[MAX_SKINNAME] (64 bytes) = 80 bytes. dsprite_t header (ident,
// version, numframes) is 12 bytes before the frames array.
const DSPRFRAME_T_SIZE = 16 + MAX_SKINNAME;
const DSPRITE_HEADER_SIZE = 12;

// dmdl_t parsed in full up front (this port has no raw-Hunk-memory
// equivalent to re-read from later); ModelT.extradata holds this object for
// alias models the same way the C original's `mod->extradata` holds the
// (partially filled, then fully filled) `pheader` Hunk block.
class DstvertT {
  s = 0;
  t = 0;
}

class DtriangleT {
  index_xyz: [number, number, number] = [0, 0, 0];
  index_st: [number, number, number] = [0, 0, 0];
}

class DtrivertxT {
  v: [number, number, number] = [0, 0, 0];
  lightnormalindex = 0;
}

class DaliasframeT {
  scale: [number, number, number] = [0, 0, 0];
  translate: [number, number, number] = [0, 0, 0];
  name = "";
  verts: DtrivertxT[] = [];
}

// exported (beyond gl_model.h's surface) so tests can narrow
// ModelT.extradata -- same test-introspection rationale as mod_known/
// mod_inline above and r_model.ts's identical ParsedMd2T.
export class ParsedMd2T {
  ident = 0;
  version = 0;
  skinwidth = 0;
  skinheight = 0;
  framesize = 0;
  num_skins = 0;
  num_xyz = 0;
  num_st = 0;
  num_tris = 0;
  num_glcmds = 0;
  num_frames = 0;
  skinnames: string[] = [];
  stverts: DstvertT[] = [];
  triangles: DtriangleT[] = [];
  frames: DaliasframeT[] = [];
  // raw glcmds ints, exactly as gl_model.c stores them (a flat int array --
  // the triangle-strip/fan command format they encode is interpreted at
  // render time by gl_mesh.c, not at load time here).
  glcmds: number[] = [];
}

/*
=================
Mod_LoadAliasModel
=================
*/
function Mod_LoadAliasModel(mod: ModelT, buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const version = view.getInt32(4, true); // dmdl_t.version
  if (version !== ALIAS_VERSION) {
    ri.Sys_Error(ERR_DROP, `${mod.name} has wrong version number (${version} should be ${ALIAS_VERSION})`);
  }

  const hdr = new ParsedMd2T();
  mod.extradata = hdr; // attach immediately -- see class comment above

  hdr.ident = view.getInt32(0, true);
  hdr.version = version;
  hdr.skinwidth = view.getInt32(8, true);
  hdr.skinheight = view.getInt32(12, true);
  hdr.framesize = view.getInt32(16, true);
  hdr.num_skins = view.getInt32(20, true);
  hdr.num_xyz = view.getInt32(24, true);
  hdr.num_st = view.getInt32(28, true);
  hdr.num_tris = view.getInt32(32, true);
  hdr.num_glcmds = view.getInt32(36, true);
  hdr.num_frames = view.getInt32(40, true);
  const ofs_skins = view.getInt32(44, true);
  const ofs_st = view.getInt32(48, true);
  const ofs_tris = view.getInt32(52, true);
  const ofs_frames = view.getInt32(56, true);
  const ofs_glcmds = view.getInt32(60, true); // (ofs_end at offset 64 is unread -- only used by Hunk_Alloc's sizing, which this port doesn't need)

  if (hdr.skinheight > MAX_LBM_HEIGHT) ri.Sys_Error(ERR_DROP, `model ${mod.name} has a skin taller than ${MAX_LBM_HEIGHT}`);
  if (hdr.num_xyz <= 0) ri.Sys_Error(ERR_DROP, `model ${mod.name} has no vertices`);
  if (hdr.num_xyz > MAX_VERTS) ri.Sys_Error(ERR_DROP, `model ${mod.name} has too many vertices`);
  if (hdr.num_st <= 0) ri.Sys_Error(ERR_DROP, `model ${mod.name} has no st vertices`);
  if (hdr.num_tris <= 0) ri.Sys_Error(ERR_DROP, `model ${mod.name} has no triangles`);
  if (hdr.num_frames <= 0) ri.Sys_Error(ERR_DROP, `model ${mod.name} has no frames`);

  //
  // load base s and t vertices (not used in gl version)
  //
  for (let i = 0; i < hdr.num_st; i++) {
    const o = ofs_st + i * 4;
    const st = new DstvertT();
    st.s = view.getInt16(o, true);
    st.t = view.getInt16(o + 2, true);
    hdr.stverts.push(st);
  }

  //
  // load triangle lists
  //
  for (let i = 0; i < hdr.num_tris; i++) {
    const o = ofs_tris + i * 12;
    const t = new DtriangleT();
    t.index_xyz = [view.getInt16(o, true), view.getInt16(o + 2, true), view.getInt16(o + 4, true)];
    t.index_st = [view.getInt16(o + 6, true), view.getInt16(o + 8, true), view.getInt16(o + 10, true)];
    hdr.triangles.push(t);
  }

  //
  // load the frames
  //
  for (let i = 0; i < hdr.num_frames; i++) {
    const fo = ofs_frames + i * hdr.framesize;
    const fr = new DaliasframeT();
    fr.scale = [view.getFloat32(fo, true), view.getFloat32(fo + 4, true), view.getFloat32(fo + 8, true)];
    fr.translate = [view.getFloat32(fo + 12, true), view.getFloat32(fo + 16, true), view.getFloat32(fo + 20, true)];
    fr.name = readCString(view, fo + 24, 16);
    // verts are all 8 bit, so no swapping needed
    for (let v = 0; v < hdr.num_xyz; v++) {
      const vo = fo + 40 + v * 4;
      const vert = new DtrivertxT();
      vert.v = [view.getUint8(vo), view.getUint8(vo + 1), view.getUint8(vo + 2)];
      vert.lightnormalindex = view.getUint8(vo + 3);
      fr.verts.push(vert);
    }
    hdr.frames.push(fr);
  }

  mod.type = ModtypeT.mod_alias;

  //
  // load the glcmds
  //
  for (let i = 0; i < hdr.num_glcmds; i++) {
    hdr.glcmds.push(view.getInt32(ofs_glcmds + i * 4, true));
  }

  // register all skins
  for (let i = 0; i < hdr.num_skins; i++) {
    hdr.skinnames.push(readCString(view, ofs_skins + i * MAX_SKINNAME, MAX_SKINNAME));
  }
  for (let i = 0; i < hdr.num_skins; i++) {
    mod.skins[i] = safeFindImage(hdr.skinnames[i], ImagetypeT.it_skin);
  }

  mod.mins[0] = -32;
  mod.mins[1] = -32;
  mod.mins[2] = -32;
  mod.maxs[0] = 32;
  mod.maxs[1] = 32;
  mod.maxs[2] = 32;
}

/*
==============================================================================

SPRITE MODELS

==============================================================================
*/

class DsprframeT {
  width = 0;
  height = 0;
  origin_x = 0;
  origin_y = 0;
  name = "";
}

export class ParsedSp2T {
  ident = 0;
  version = 0;
  numframes = 0;
  frames: DsprframeT[] = [];
}

/*
=================
Mod_LoadSpriteModel
=================
*/
function Mod_LoadSpriteModel(mod: ModelT, buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const sp = new ParsedSp2T();
  sp.ident = view.getInt32(0, true);
  sp.version = view.getInt32(4, true);
  sp.numframes = view.getInt32(8, true);

  if (sp.version !== SPRITE_VERSION) {
    ri.Sys_Error(ERR_DROP, `${mod.name} has wrong version number (${sp.version} should be ${SPRITE_VERSION})`);
  }
  if (sp.numframes > MAX_MD2SKINS) {
    ri.Sys_Error(ERR_DROP, `${mod.name} has too many frames (${sp.numframes} > ${MAX_MD2SKINS})`);
  }

  for (let i = 0; i < sp.numframes; i++) {
    const o = DSPRITE_HEADER_SIZE + i * DSPRFRAME_T_SIZE;
    const f = new DsprframeT();
    f.width = view.getInt32(o, true);
    f.height = view.getInt32(o + 4, true);
    f.origin_x = view.getInt32(o + 8, true);
    f.origin_y = view.getInt32(o + 12, true);
    f.name = readCString(view, o + 16, MAX_SKINNAME);
    sp.frames.push(f);
    mod.skins[i] = safeFindImage(f.name, ImagetypeT.it_sprite);
  }

  mod.type = ModtypeT.mod_sprite;
  mod.extradata = sp;
}

//=============================================================================

/*
@@@@@@@@@@@@@@@@@@@@@
R_BeginRegistration

Specifies the model that will be used as the world
@@@@@@@@@@@@@@@@@@@@@
*/
export function R_BeginRegistration(model: string): void {
  SetRegistrationSequence(registration_sequence + 1);
  SetViewClusters(r_viewcluster, r_viewcluster2, -1, r_oldviewcluster2); // force markleafs

  const fullname = Com_sprintf("maps/%s.bsp", model);

  const flushmap = ri.Cvar_Get("flushmap", "0", 0);
  if (mod_known[0].name !== fullname || (flushmap && flushmap.value)) {
    Mod_Free(mod_known[0]);
  }
  SetWorldModel(R_RegisterModel(fullname));

  SetViewClusters(-1, r_viewcluster2, -1, r_oldviewcluster2);
}

/*
@@@@@@@@@@@@@@@@@@@@@
R_RegisterModel
@@@@@@@@@@@@@@@@@@@@@
*/
export function R_RegisterModel(name: string): ModelT | null {
  const mod = Mod_ForName(name, false);
  if (mod) {
    mod.registration_sequence = registration_sequence;

    // register any images used by the models
    if (mod.type === ModtypeT.mod_sprite) {
      const spr = mod.extradata;
      if (spr instanceof ParsedSp2T) {
        for (let i = 0; i < spr.numframes; i++) {
          mod.skins[i] = safeFindImage(spr.frames[i].name, ImagetypeT.it_sprite);
        }
      }
    } else if (mod.type === ModtypeT.mod_alias) {
      const hdr = mod.extradata;
      if (hdr instanceof ParsedMd2T) {
        for (let i = 0; i < hdr.num_skins; i++) {
          mod.skins[i] = safeFindImage(hdr.skinnames[i], ImagetypeT.it_skin);
        }
        mod.numframes = hdr.num_frames;
      }
    } else if (mod.type === ModtypeT.mod_brush) {
      for (let i = 0; i < mod.numtexinfo; i++) {
        const image = mod.texinfo[i].image;
        if (image) image.registration_sequence = registration_sequence;
      }
    }
  }
  return mod;
}

/*
@@@@@@@@@@@@@@@@@@@@@
R_EndRegistration
@@@@@@@@@@@@@@@@@@@@@
*/
export function R_EndRegistration(): void {
  for (let i = 0; i < mod_numknown; i++) {
    const mod = mod_known[i];
    if (mod.name === "") continue;
    if (mod.registration_sequence !== registration_sequence) {
      // don't need this model
      Mod_Free(mod);
    }
  }

  GL_FreeUnusedImages();
}

//=============================================================================

/*
================
Mod_Free
================
*/
export function Mod_Free(mod: ModelT): void {
  mod.clear();
}

/*
================
Mod_FreeAll
================
*/
export function Mod_FreeAll(): void {
  for (let i = 0; i < mod_numknown; i++) {
    if (mod_known[i].extradatasize) Mod_Free(mod_known[i]);
  }
}
