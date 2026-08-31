/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_model.h (types) and ref_soft/r_model.c (the Mod_
family plus R_BeginRegistration/R_RegisterModel/R_EndRegistration, stubbed)
-- GNU GPL v2 or later.

d*_t structures are on-disk representations (qfiles.ts/cmodel.ts already own
the BSP ones); m*_t structures here are the software renderer's in-memory
ones.

Deviation from the C source layout: `image_t` is declared in r_local.h in
the original (right before `#include "r_model.h"`), not in r_model.h. The
brief for this unit places it here instead, alongside model_t/msurface_t/
mnode_t/mleaf_t/medge_t/mtexinfo_t. Per PORTING.md ("the brief's placement
wins; report the mismatch, don't move it") it stays here; r_local.ts imports
it from this module.
*/

import { type Vec3, vec3, DotProduct, VectorLength } from "../shared/math";
import { CplaneT, CONTENTS_SOLID, SURF_SKY, SURF_WARP, SURF_FLOWING, ERR_DROP, PRINT_ALL, PRINT_DEVELOPER, Com_sprintf } from "../shared/q_shared";
import {
  type LumpT,
  type DmodelT,
  MAX_MAP_LEAFS,
  MAXLIGHTMAPS,
  IDBSPHEADER,
  IDBSPHEADER_EXT,
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
  DEDGE_EXT_T_SIZE,
  DFACE_EXT_T_SIZE,
  LEAFFACE_EXT_SIZE,
  DLEAF_EXT_T_SIZE,
  DNODE_EXT_T_SIZE,
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
  readDedgeExt,
  readDfaceExt,
  readDleafExt,
  readDnodeExt,
  readUint32,
  dvisNumClusters,
  dvisBitofs,
} from "../qcommon/qfiles";
import { parseBspxDirectory, parseDecoupledLM, parseLightgrid, type DecoupledLmResultT, type LightgridT } from "../qcommon/bspx";
import { type SurfcacheT, ri, r_notexture_mip, r_worldmodel, MAX_LBM_HEIGHT, SetWorldModel, SetOldViewCluster } from "./r_local";
import type * as RImageModule from "./r_image";
import type * as RRastModule from "./r_rast";
import type * as RMainModule from "./r_main";
import type * as RSurfModule from "./r_surf";

// r_image.ts/r_rast.ts/r_main.ts/r_surf.ts are reached lazily (via Bun's
// synchronous require, not a static top-level import) rather than statically
// imported here, the same way files.ts reaches cvar.ts/cmd.ts (see that
// file's comment for the general pattern). r_rast.ts's own module body
// declares module-scope values built with `new MvertexT()`/`new MsurfaceT()`
// (types owned by *this* file); a static r_model.ts -> r_rast.ts edge closes
// a cycle back through r_rast.ts's existing r_model.ts import, reaching
// r_rast.ts's top-level `new MvertexT()` before this file's own MvertexT
// class declaration has run ("Cannot access 'MvertexT' before
// initialization"). r_main.ts/r_image.ts/r_surf.ts are made lazy too for the
// same reason (r_main.ts already statically imports R_BeginRegistration/
// R_EndRegistration/R_RegisterModel from this file, and r_image.ts imports
// ImageT/ImagetypeT from here as values). None of those four files are in
// this unit's SCOPE to fix directly, so every edge into them is made lazy
// here instead: each call below happens from inside a function body (never
// at this file's own module top level), by which point the whole module
// graph has finished loading via its own working static paths, so the lazy
// require just returns the same cached module. `import type` above is
// compile-time only (erased), so it adds no runtime edge.
function rImageMod(): typeof RImageModule {
  return require("./r_image");
}
function rRastMod(): typeof RRastModule {
  return require("./r_rast");
}
function rMainMod(): typeof RMainModule {
  return require("./r_main");
}
function rSurfMod(): typeof RSurfModule {
  return require("./r_surf");
}

// mplane_t is byte-for-byte the same struct as q_shared.ts's CplaneT
// (cplane_t): vec3_t normal; float dist; byte type; byte signbits.
// (C's trailing byte pad[2] is dropped the same way CplaneT already drops
// it -- see that class's comment -- it exists only for the unported x86 asm
// BoxOnPlaneSide.) Reused directly rather than duplicated.
export type MplaneT = CplaneT;

export const SIDE_FRONT = 0;
export const SIDE_BACK = 1;
export const SIDE_ON = 2;

// FIXME: differentiate from texinfo SURF_ flags
export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4; // sky brush face
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_DRAWSKYBOX = 0x80; // sky box
export const SURF_FLOW = 0x100; // PGM

// This port only -- no classic-engine equivalent. Set by CalcSurfaceExtents
// (below) on a face whose plain geometry/texture-axis extents genuinely
// exceed this renderer's surface cache: vanilla ref_soft/r_surf.c's own
// D_SCAlloc hard-errors ("D_SCAlloc: bad cache width %d") on any
// r_drawsurf.surfwidth (== surface->extents[0] at mip 0) over 256, and
// R_BuildLightMap's blocklights scratch buffer is sized for
// smax*tmax <= 1024 (r_light.ts) -- both are real, load-bearing capacity
// limits of the classic PC engine's software rasterizer, not just a
// mapper convention (see CalcSurfaceExtents's own comment for the measured
// real-content case, the Q64/N64 remaster map set, that trips this).
// R_RenderFace/R_RenderBmodelFace (r_rast.ts) skip queuing a flagged face
// for rasterization entirely, so the rest of the map still renders instead
// of the whole load failing or a later D_CacheSurface call crashing.
export const SURF_EXTENTS_SKIP = 0x200;

// qfiles.h constants r_model.h depends on that qfiles.ts has not ported yet
// (that module's own report defers MD2/SP2/WAL formats to a future unit;
// r_model.c's brush/alias/sprite loading is itself pending, so these are
// declared locally rather than blocked on that future unit).
export const MIPLEVELS = 4;
export const MAX_MD2SKINS = 32;

// .MD2 (dmdl_t and friends) and .SP2 (dsprite_t/dsprframe_t) struct offsets
// from qcommon/qfiles.h, ported here per this unit's brief since qfiles.ts's
// own report explicitly defers the MD2/SP2 formats to "the future
// model/image-loading units" -- this is that unit. Byte offsets below are
// computed from the C struct layouts (all fields are 4-byte aligned ints/
// floats, no padding).
export const IDALIASHEADER = ("2".charCodeAt(0) << 24) + ("P".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
export const ALIAS_VERSION = 8;
export const MAX_TRIANGLES = 4096;
export const MAX_VERTS = 2048;
export const MAX_FRAMES = 512;
export const MAX_SKINNAME = 64;

// dmdl_t: 17 consecutive `int` fields, 4 bytes each, 68 bytes total.
const DMDL_T_SIZE = 68;

export const IDSPRITEHEADER = ("2".charCodeAt(0) << 24) + ("S".charCodeAt(0) << 16) + ("D".charCodeAt(0) << 8) + "I".charCodeAt(0);
export const SPRITE_VERSION = 2;

// dsprframe_t: int width, height, origin_x, origin_y (16 bytes) + char
// name[MAX_SKINNAME] (64 bytes) = 80 bytes. dsprite_t header (ident,
// version, numframes) is 12 bytes before the frames array.
const DSPRFRAME_T_SIZE = 16 + MAX_SKINNAME;
const DSPRITE_HEADER_SIZE = 12;

//
// in memory representation
//
export class MvertexT {
  position: Vec3 = vec3();
}

export enum ImagetypeT {
  it_skin,
  it_sprite,
  it_wall,
  it_pic,
  it_sky,
}

// skins will be outline flood filled and mip mapped
// pics and sprites with alpha will be outline flood filled
// pic won't be mip mapped
export class ImageT {
  name = ""; // game path, including extension
  type: ImagetypeT = ImagetypeT.it_skin;
  width = 0;
  height = 0;
  transparent = false; // true if any 255 pixels in image
  registration_sequence = 0; // 0 = free
  pixels: (Uint8Array | null)[] = [null, null, null, null]; // mip levels
}

export class MedgeT {
  v: [number, number] = [0, 0];
  cachededgeoffset = 0;
}

export class MtexinfoT {
  vecs: [Float32Array, Float32Array] = [new Float32Array(4), new Float32Array(4)];
  mipadjust = 0;
  image: ImageT | null = null;
  flags = 0;
  numframes = 0;
  next: MtexinfoT | null = null; // animation chain
}

export class MsurfaceT {
  visframe = 0; // should be drawn when node is crossed

  dlightframe = 0;
  dlightbits = 0;

  plane: MplaneT | null = null;
  flags = 0;

  firstedge = 0; // look up in model->surfedges[], negative numbers
  numedges = 0; // are backwards edges

  // surface generation data
  cachespots: (SurfcacheT | null)[] = new Array<SurfcacheT | null>(MIPLEVELS).fill(null);

  texturemins: [number, number] = [0, 0];
  extents: [number, number] = [0, 0];

  texinfo: MtexinfoT | null = null;

  // lighting info
  styles: number[] = new Array<number>(4).fill(0); // MAXLIGHTMAPS
  samples: Uint8Array | null = null; // [numstyles*surfsize]

  nextalphasurface: MsurfaceT | null = null;

  // This port only -- not in vanilla's msurface_t. Vanilla's
  // R_RenderFace/R_RenderBmodelFace push straight onto the file-scope
  // r_alpha_surfaces stack (`fa->nextalphasurface = r_alpha_surfaces;
  // r_alpha_surfaces = fa;`) with no guard against the same surface being
  // pushed twice in one frame. That's normally impossible in vanilla's own
  // data (a world surface belongs to exactly one BSP node, visited once;
  // a bmodel's own surfaces are only walked once per R_DrawBEntitiesOnList
  // entity) -- but retail's "Call of the Machine" content includes entities
  // whose modelindex resolves (legitimately, per protocol: CS_MODELS+1 is
  // always the map itself) to the WORLD model, e.g. maps/mgu6m3.bsp's
  // entities #82-85 (modelindex 1) and #28 (modelindex 8, likewise
  // resolving to the world -- see r_rast.ts's R_RenderFace/
  // R_RenderBmodelFace comment for the full citation). R_DrawBEntitiesOnList
  // then walks the world's ENTIRE surface list once per such entity, and a
  // second push of the same still-queued MsurfaceT turns the singly linked
  // list into a self-cycle (`X.next = X`) on the very next push --
  // `nextalphasurface = r_alpha_surfaces` executes while r_alpha_surfaces
  // still points at that same object -- which hangs R_DrawAlphaSurfaces's
  // `while (s !== null)` forever. Real vanilla C, given the identical
  // pointer-reuse data, corrupts its list exactly the same way (this is a
  // property of the linked-list algorithm, not a translation bug), so per
  // the FIDELITY RAZOR (rule 17: never let UB/aliasing-shaped behavior
  // diverge from the original's observable, playable outcome) this frame
  // stamp makes the enqueue idempotent per frame instead of reproducing an
  // unplayable permanent freeze.
  alphaframe = -1;
}

export const CONTENTS_NODE = -1;

// mnode_t and mleaf_t are two independent C structs that share a leading
// "common with leaf"/"common with node" field prefix so a node's
// `children[2]` can point at either; contents !== CONTENTS_NODE is the C
// idiom for telling them apart (`if (node->contents != CONTENTS_NODE) ...
// leaf`). Modeled here as a discriminated union over that same field
// instead of a cast.
export type MnodeOrLeaf = MnodeT | MleafT;

export function isMleaf(n: MnodeOrLeaf): n is MleafT {
  return n.contents !== CONTENTS_NODE;
}

export class MnodeT {
  // common with leaf
  contents: number = CONTENTS_NODE; // CONTENTS_NODE, to differentiate from leafs
  visframe = 0; // node needs to be traversed if current

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
  contents = 0; // will be something other than CONTENTS_NODE
  visframe = 0; // node needs to be traversed if current

  minmaxs: number[] = new Array<number>(6).fill(0); // for bounding box culling

  parent: MnodeT | null = null;

  // leaf specific
  cluster = 0;
  area = 0;

  firstmarksurface: MsurfaceT[] = []; // slice into model.marksurfaces starting here
  nummarksurfaces = 0;
  key = 0; // BSP sequence number for leaf's contents
}

//===================================================================

//
// Whole model
//
export enum ModtypeT {
  mod_bad,
  mod_brush,
  mod_sprite,
  mod_alias,
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

  // solid volume for clipping (sent from server)
  clipbox = false;
  clipmins: Vec3 = vec3();
  clipmaxs: Vec3 = vec3();

  // brush model
  firstmodelsurface = 0;
  nummodelsurfaces = 0;

  numsubmodels = 0;
  submodels: DmodelT[] = [];

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
  // straight out of this buffer.
  vis: Uint8Array | null = null;

  lightdata: Uint8Array | null = null;

  // for alias models and sprites
  skins: (ImageT | null)[] = new Array<ImageT | null>(MAX_MD2SKINS).fill(null);
  extradata: unknown = null; // opaque cache blob owned by the (unported) alias/sprite loaders
  extradatasize = 0;

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

export let registration_sequence = 0;
export function SetRegistrationSequence(v: number): void {
  registration_sequence = v;
}

// r_worldmodel/r_oldviewcluster are declared as `extern` in r_local.h and
// actually *defined* in r_main.c; r_local.ts owns both for the whole
// renderer, and R_BeginRegistration below assigns them through its setters
// (an imported `let` binding is read-only to the importer -- the same
// situation as g_local.ts's SetGEdicts, see PORTING.md's globals section).

const MAX_MOD_KNOWN = 256;
// Exported beyond r_model.h's surface purely for test introspection: several
// call sites below (R_InitSkyBox, D_FlushCaches, R_NewMap, R_FindImage) are
// pending stubs in sibling ref_soft units at the time, so a full Mod_ForName/
// R_BeginRegistration call can throw partway through -- after it has already
// mutated the model object in place. Exposing the backing array lets tests
// inspect that mutated state the same way cmodel.ts exposes
// CM_MarkMapLoadedForTesting for an analogous reason.
export const mod_known: ModelT[] = Array.from({ length: MAX_MOD_KNOWN }, () => new ModelT());
let mod_numknown = 0;
// the inline * models from the current map are kept seperate
export const mod_inline: ModelT[] = Array.from({ length: MAX_MOD_KNOWN }, () => new ModelT());

let modfilelen = 0;

const mod_novis = new Uint8Array(MAX_MAP_LEAFS / 8);

// mutable "current load" pointers, mirroring r_model.c's loadmodel/mod_base
// globals (reassigned across every Mod_Load* helper call, never read before
// Mod_ForName assigns them -- see cmodel.ts's cmod_view for the same
// dummy-default-instead-of-null pattern).
export let loadmodel: ModelT = new ModelT();
let mod_view: DataView = new DataView(new ArrayBuffer(0));

let r_leaftovis: number[] = [];
let r_vistoleaf: number[] = [];
let r_numvisleafs = 0;

function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// reads up to maxLen bytes starting at offset, stopping at the first NUL --
// same helper as qfiles.ts's private readCString, duplicated here since that
// one isn't exported and this module reads its own (MD2/SP2) formats.
function readCString(view: DataView, offset: number, maxLen: number): string {
  let s = "";
  for (let i = 0; i < maxLen; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/*
===============
Mod_Modellist_f
===============
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

// Mod_ClearAll/Mod_Extradata/Mod_TouchModel are declared in r_model.h but
// have no function body anywhere in ref_soft's .c files (dead declarations
// -- confirmed by grepping the whole ref_soft tree). There is nothing to
// port, so these fail hard if reached; a caller reaching them is itself a
// bug in the (nonexistent) original.
export function Mod_ClearAll(): void {
  throw new Error("Mod_ClearAll: bodyless declaration in the C source; no caller should reach it");
}

export function Mod_Extradata(mod: ModelT): unknown {
  throw new Error("Mod_Extradata: bodyless declaration in the C source; no caller should reach it");
}

export function Mod_TouchModel(name: string): void {
  throw new Error("Mod_TouchModel: bodyless declaration in the C source; no caller should reach it");
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
    case IDBSPHEADER_EXT:
      Mod_LoadBrushModel(mod, buf);
      break;

    default:
      ri.Sys_Error(ERR_DROP, `Mod_NumForName: unknown fileid for ${mod.name}`);
  }

  // NOT PORTED HERE: q2repro src/refresh/models.c:1632-1636 (`#if USE_MD5`)
  // calls MOD_LoadMD5(model) at exactly this point when model->type ==
  // MOD_ALIAS. src/ref_gl/gl_model.ts's Mod_ForName does the same (its own
  // Mod_LoadMD5, wired to a real ModelT.skeleton field and a skinned CPU
  // draw path in gl_mesh.ts). This software renderer intentionally has no
  // equivalent: q2repro's MD5 code (md5_model_t/model_t.skeleton, defined
  // in src/refresh/gl.h:439-470, a GL-refresh-PRIVATE header) and its
  // runtime skinning (src/refresh/mesh.c:739-908) live entirely inside
  // q2repro's single GL-only refresh module -- q2repro ships no software
  // renderer at all, so there is no C source anywhere to port a soft-MD5
  // loading or rendering path FROM. Per this unit's brief ("if genuinely
  // out of q2repro's scope, document that with the C citation rather than
  // silently skipping"): this is that documentation. ModelT below
  // deliberately carries no `skeleton` field -- adding one with nothing to
  // populate or render it would be dead weight, not fidelity.

  loadmodel.extradatasize = buf.length; // stands in for Hunk_End()'s byte count -- see report

  return mod;
}

/*
===============
Mod_PointInLeaf
===============
*/
export function Mod_PointInLeaf(p: Vec3, model: ModelT | null): MleafT {
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

  // the C original's `if (!in)` ("no vis info, make all visible") branch is
  // dead code on the only real call path: Mod_ClusterPVS already returns
  // mod_novis directly when `model->vis` is NULL, before computing a
  // pointer into it, so `in` here is never NULL. Dropped; see report.
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

/*
===============================================================================

					BRUSHMODEL LOADING

===============================================================================
*/

/*
=================
Mod_LoadLighting

Converts the 24 bit lighting down to 8 bit
by taking the brightest component
=================
*/
function Mod_LoadLighting(l: LumpT): void {
  if (!l.filelen) {
    loadmodel.lightdata = null;
    return;
  }
  const size = Math.floor(l.filelen / 3);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const base = l.fileofs + i * 3;
    const r = mod_view.getUint8(base);
    const g = mod_view.getUint8(base + 1);
    const b = mod_view.getUint8(base + 2);
    if (r > g && r > b) out[i] = r;
    else if (g > r && g > b) out[i] = g;
    else out[i] = b;
  }
  loadmodel.lightdata = out;
}

/*
================
R_NumberLeafs
================
*/
function R_NumberLeafs(node: MnodeOrLeaf): void {
  if (isMleaf(node)) {
    const leafnum = loadmodel.leafs.indexOf(node);
    if (node.contents & CONTENTS_SOLID) return;
    r_leaftovis[leafnum] = r_numvisleafs;
    r_vistoleaf[r_numvisleafs] = leafnum;
    r_numvisleafs++;
    return;
  }

  const c0 = node.children[0];
  const c1 = node.children[1];
  if (c0) R_NumberLeafs(c0);
  if (c1) R_NumberLeafs(c1);
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
  // this little-endian-only port, same rationale as cmodel.ts's
  // CMod_LoadVisibility comment (dvisNumClusters/dvisBitofs already read the
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
  // C over-allocates by 8 entries "extra for skybox" (R_InitSkyBox appends
  // synthetic verts past `numvertexes` into that spare Hunk capacity without
  // reallocating); JS arrays grow dynamically, so no pre-padding is needed
  // here -- dropped, see report.
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
Mod_LoadSubmodels
=================
*/
function Mod_LoadSubmodels(l: LumpT): void {
  if (l.filelen % DMODEL_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DMODEL_T_SIZE;
  const out: DmodelT[] = [];
  for (let i = 0; i < count; i++) {
    const din = readDmodel(mod_view, l.fileofs + i * DMODEL_T_SIZE);
    out.push({
      // spread the mins / maxs by a pixel
      mins: [din.mins[0] - 1, din.mins[1] - 1, din.mins[2] - 1],
      maxs: [din.maxs[0] + 1, din.maxs[1] + 1, din.maxs[2] + 1],
      origin: [din.origin[0], din.origin[1], din.origin[2]],
      headnode: din.headnode,
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
Mod_LoadEdgesExt

QBSP extended format (bsp_template.c's BSP_LoadEdgesExt): both v[0]/v[1]
widen from uint16 to uint32, and gain the vertnum bounds check bsp.c's
classic reader never had (BSP_ENSURE(vertnum < numvertexes, "Bad vertnum")).
Call order dependency: needs loadmodel.numvertexes already set (Vertexes
loads before Edges in bsp_lumps[]).
=================
*/
function Mod_LoadEdgesExt(l: LumpT): void {
  if (l.filelen % DEDGE_EXT_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DEDGE_EXT_T_SIZE;
  const out: MedgeT[] = [];
  for (let i = 0; i < count; i++) {
    const din = readDedgeExt(mod_view, l.fileofs + i * DEDGE_EXT_T_SIZE);
    const e = new MedgeT();
    for (let j = 0; j < 2; j++) {
      if (din.v[j] >= loadmodel.numvertexes) ri.Sys_Error(ERR_DROP, "Bad vertnum");
      e.v[j] = din.v[j];
    }
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

    // C's `for (j=0;j<8;j++) out->vecs[0][j] = LittleFloat(in->vecs[0][j]);`
    // relies on vecs[0] and vecs[1] being one contiguous 8-float block in
    // memory (float vecs[2][4]) to copy both sub-vectors via a single loop
    // that indexes past vecs[0]'s own bound -- a real quirk of the original,
    // not reproducible over two separate typed arrays. Copying both vecs
    // directly below is the same net effect (both fully copied).
    for (let j = 0; j < 4; j++) {
      t.vecs[0][j] = din.vecs[0][j];
      t.vecs[1][j] = din.vecs[1][j];
    }

    let len1 = VectorLength(t.vecs[0]);
    const len2 = VectorLength(t.vecs[1]);
    len1 = (len1 + len2) / 2;
    if (len1 < 0.32) t.mipadjust = 4;
    else if (len1 < 0.49) t.mipadjust = 3;
    else if (len1 < 0.99) t.mipadjust = 2;
    else t.mipadjust = 1;

    t.flags = din.flags;

    const next = din.nexttexinfo;
    if (next > 0) t.next = out[next];

    const name = Com_sprintf("textures/%s.wal", din.texture);
    let image = rImageMod().R_FindImage(name, ImagetypeT.it_wall);
    if (!image) {
      image = r_notexture_mip; // texture not found
      t.flags = 0;
    }
    t.image = image;
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

Fills in s->texturemins[] and s->extents[]

Deviation from vanilla ref_soft/r_surf.c (see PrescanClassicSurfaceExtents
and SURF_EXTENTS_SKIP's own comment for the full rationale): the original
calls `ri.Sys_Error(ERR_DROP, "Bad surface extents")` here, which aborts
loading the WHOLE map. That is real vanilla behavior for content the
classic PC software rasterizer's surface cache genuinely cannot represent
(D_SCAlloc's own "bad cache width" hard error backs this up -- this is not
merely a load-time convention), but real content exists that trips it on
only a MINORITY of a map's faces (measured: baseq2/maps/q64/*.bsp, the
N64 remaster set, violates on 150-275 of several thousand faces per map --
see the prescan's own measurements). Refusing to load the entire map over
a few dozen faces is a worse degrade than the original's own "Bad surface
extents" text implies is necessary: this per-face SURF_EXTENTS_SKIP flag
(consumed by r_rast.ts's R_RenderFace/R_RenderBmodelFace, which never
queue a flagged face for rasterization) keeps the rest of the map
rendering. The one-time summary warning that used to accompany the abort
now accompanies this instead -- see PrescanClassicSurfaceExtents.
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
    if (s.extents[i] < 16) s.extents[i] = 16; // take at least one cache block
    if (!(tex.flags & (SURF_WARP | SURF_SKY)) && s.extents[i] > 256) {
      s.flags |= SURF_EXTENTS_SKIP;
    }
  }
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

  for (let surfnum = 0; surfnum < count; surfnum++) {
    const base = l.fileofs + surfnum * DFACE_T_SIZE;
    const s = out[surfnum];

    s.firstedge = mod_view.getInt32(base + 4, true);
    s.numedges = mod_view.getInt16(base + 8, true);
    if (s.numedges < 3) ri.Sys_Error(ERR_DROP, `Surface with ${s.numedges} edges`);
    s.flags = 0;

    const planenum = mod_view.getUint16(base, true);
    const side = mod_view.getInt16(base + 2, true);
    if (side) s.flags |= SURF_PLANEBACK;

    s.plane = loadmodel.planes[planenum];
    // classic dface_t's texinfo field is `unsigned short` on disk (q2repro's
    // own classic BSP_LoadFaces reads it via BSP_Short(), an unsigned 16-bit
    // read -- see bsp_template.c). A signed getInt16 read here silently
    // turned any texinfo index >= 32768 negative (with no bounds check at
    // all here, unlike gl_model.ts's sibling function); retail's
    // classic-ident maps/mgu*.bsp entries (not every mgu map is QBSP -- see
    // qfiles.ts's IDBSPHEADER_EXT comment) can exceed that threshold. Fixed
    // to getUint16 to match q2repro; no observable change for any texinfo
    // count under 32768 (every currently-passing map), since the top bit is
    // never set.
    const ti = mod_view.getUint16(base + 10, true);
    if (ti >= loadmodel.numtexinfo) ri.Sys_Error(ERR_DROP, "MOD_LoadBmodel: bad texinfo number");
    s.texinfo = loadmodel.texinfo[ti];

    CalcSurfaceExtents(s);

    // lighting info is converted from 24 bit on disk to 8 bit
    for (let i = 0; i < MAXLIGHTMAPS; i++) s.styles[i] = mod_view.getUint8(base + 12 + i);
    const lightofs = mod_view.getInt32(base + 16, true);
    if (lightofs === -1) s.samples = null;
    else s.samples = loadmodel.lightdata ? loadmodel.lightdata.subarray(Math.floor(lightofs / 3)) : null;

    // set the drawing flags flag
    if (!s.texinfo.image) continue;
    if (s.texinfo.flags & SURF_SKY) {
      s.flags |= SURF_DRAWSKY;
      continue;
    }

    if (s.texinfo.flags & SURF_WARP) {
      s.flags |= SURF_DRAWTURB;
      s.extents[0] = 16384;
      s.extents[1] = 16384;
      s.texturemins[0] = -8192;
      s.texturemins[1] = -8192;
      continue;
    }

    // this marks flowing surfaces as turbulent, but with the new SURF_FLOW flag.
    if (s.texinfo.flags & SURF_FLOWING) {
      s.flags |= SURF_DRAWTURB | SURF_FLOW;
      s.extents[0] = 16384;
      s.extents[1] = 16384;
      s.texturemins[0] = -8192;
      s.texturemins[1] = -8192;
      continue;
    }
  }
}

/*
=================
Mod_LoadFacesExt

QBSP extended format (bsp_template.c's BSP_LoadFacesExt): planenum/numedges/
texinfo widen from uint16 to uint32 (firstedge/lightofs stay 4-byte signed
reads in both formats), drawflags replaces the classic reader's `side`
boolean (already pre-masked to DSURF_PLANEBACK by readDfaceExt -- same
truthiness test as the classic `if (side)`), and gains the planenum/
surfedges/texinfo bounds checks bsp.c's classic reader never had. Uses the
same CalcSurfaceExtents (SURF_EXTENTS_SKIP flagging, not a hard error -- see
that function's own comment) as the classic loader above.
Call order dependency: needs loadmodel.numplanes, .numtexinfo and
.numsurfedges already set (Planes/Texinfo/SurfEdges all load before Faces
in this branch's own sequence).
=================
*/
function Mod_LoadFacesExt(l: LumpT): void {
  if (l.filelen % DFACE_EXT_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DFACE_EXT_T_SIZE;
  const out: MsurfaceT[] = [];
  for (let i = 0; i < count; i++) out.push(new MsurfaceT());
  loadmodel.surfaces = out;
  loadmodel.numsurfaces = count;

  for (let surfnum = 0; surfnum < count; surfnum++) {
    const din = readDfaceExt(mod_view, l.fileofs + surfnum * DFACE_EXT_T_SIZE);
    const s = out[surfnum];

    if (din.planenum >= loadmodel.numplanes) ri.Sys_Error(ERR_DROP, "Bad planenum");
    if (din.numedges < 3 || din.numedges > 4096 || din.firstedge + din.numedges > loadmodel.numsurfedges) {
      ri.Sys_Error(ERR_DROP, "Bad surfedges");
    }
    if (din.texinfo >= loadmodel.numtexinfo) ri.Sys_Error(ERR_DROP, "Bad texinfo");

    s.firstedge = din.firstedge;
    s.numedges = din.numedges;
    s.flags = 0;
    if (din.drawflags) s.flags |= SURF_PLANEBACK;

    s.plane = loadmodel.planes[din.planenum];
    s.texinfo = loadmodel.texinfo[din.texinfo];

    CalcSurfaceExtents(s);

    // lighting info is converted from 24 bit on disk to 8 bit
    for (let i = 0; i < MAXLIGHTMAPS; i++) s.styles[i] = din.styles[i];
    if (din.lightofs === -1) s.samples = null;
    else s.samples = loadmodel.lightdata ? loadmodel.lightdata.subarray(Math.floor(din.lightofs / 3)) : null;

    // set the drawing flags flag
    if (!s.texinfo.image) continue;
    if (s.texinfo.flags & SURF_SKY) {
      s.flags |= SURF_DRAWSKY;
      continue;
    }

    if (s.texinfo.flags & SURF_WARP) {
      s.flags |= SURF_DRAWTURB;
      s.extents[0] = 16384;
      s.extents[1] = 16384;
      s.texturemins[0] = -8192;
      s.texturemins[1] = -8192;
      continue;
    }

    // this marks flowing surfaces as turbulent, but with the new SURF_FLOW flag.
    if (s.texinfo.flags & SURF_FLOWING) {
      s.flags |= SURF_DRAWTURB | SURF_FLOW;
      s.extents[0] = 16384;
      s.extents[1] = 16384;
      s.texturemins[0] = -8192;
      s.texturemins[1] = -8192;
      continue;
    }
  }
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
Mod_LoadNodesExt

QBSP extended format (bsp_template.c's BSP_LoadNodesExt). planenum and both
children stay 32-bit reads in both formats (only mins/maxs/firstface/
numfaces widen); gains the planenum/faces/child bounds checks bsp.c's
classic reader never had (BSP_ENSURE "Bad planenum" / "Bad faces" /
"Bad leafnum" / "Bad nodenum").
Call order dependency: needs loadmodel.numplanes, .numsurfaces and
.numleafs already set (Planes/Faces/Leafs all load before Nodes in this
branch's own sequence).
=================
*/
function Mod_LoadNodesExt(l: LumpT): void {
  if (l.filelen % DNODE_EXT_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DNODE_EXT_T_SIZE;
  const out: MnodeT[] = [];
  for (let i = 0; i < count; i++) out.push(new MnodeT());
  loadmodel.nodes = out;
  loadmodel.numnodes = count;

  for (let i = 0; i < count; i++) {
    const din = readDnodeExt(mod_view, l.fileofs + i * DNODE_EXT_T_SIZE);
    const n = out[i];

    if (din.planenum >= loadmodel.numplanes) ri.Sys_Error(ERR_DROP, "Bad planenum");
    if (din.firstface + din.numfaces > loadmodel.numsurfaces) ri.Sys_Error(ERR_DROP, "Bad faces");

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
      if (p >= 0) {
        if (p >= count) ri.Sys_Error(ERR_DROP, "Bad nodenum");
        n.children[j] = out[p];
      } else {
        const leafnum = -1 - p;
        if (leafnum >= loadmodel.numleafs) ri.Sys_Error(ERR_DROP, "Bad leafnum");
        n.children[j] = loadmodel.leafs[leafnum];
      }
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
  }
}

/*
=================
Mod_LoadLeafsExt

QBSP extended format (bsp_template.c's BSP_LoadLeafsExt). cluster/area/
firstleafface/numleaffaces widen from int16/uint16 to uint32; firstleafbrush/
numleafbrushes also widen but this renderer has no leafbrush concept and
never reads them (mirrors readDleafExt's own comment). cluster's -1 (solid
leaf) sentinel is already normalized by readDleafExt; otherwise falls back to
cluster 0 when the map has no vis lump (bsp.c: "map has no vis, use 0 as
default"), else validates against the vis header's own numclusters
(BSP_ENSURE "Bad cluster"). area gets no bounds check, matching the existing
classic Mod_LoadLeafs (this file has no areas/areaportals state to check
against -- that is cmodel.ts-only). Gains the firstleafface+numleaffaces
bounds check bsp.c's classic reader never had ("Bad leaffaces").
Call order dependency: needs loadmodel.vis and .marksurfaces already set
(Visibility loads before Leafs in this branch's own sequence; LeafFaces
loads before Leafs too).
=================
*/
function Mod_LoadLeafsExt(l: LumpT): void {
  if (l.filelen % DLEAF_EXT_T_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / DLEAF_EXT_T_SIZE;
  const out: MleafT[] = [];
  for (let i = 0; i < count; i++) out.push(new MleafT());
  loadmodel.leafs = out;
  loadmodel.numleafs = count;

  for (let i = 0; i < count; i++) {
    const din = readDleafExt(mod_view, l.fileofs + i * DLEAF_EXT_T_SIZE);
    const lf = out[i];

    for (let j = 0; j < 3; j++) {
      lf.minmaxs[j] = din.mins[j];
      lf.minmaxs[3 + j] = din.maxs[j];
    }

    lf.contents = din.contents;
    lf.area = din.area;

    if (din.cluster === -1) {
      // solid leafs use special -1 cluster
      lf.cluster = -1;
    } else if (loadmodel.vis === null) {
      // map has no vis, use 0 as default
      lf.cluster = 0;
    } else {
      const visView = new DataView(loadmodel.vis.buffer, loadmodel.vis.byteOffset, loadmodel.vis.byteLength);
      if (din.cluster >= dvisNumClusters(visView)) ri.Sys_Error(ERR_DROP, "Bad cluster");
      lf.cluster = din.cluster;
    }

    if (din.firstleafface + din.numleaffaces > loadmodel.marksurfaces.length) ri.Sys_Error(ERR_DROP, "Bad leaffaces");

    lf.firstmarksurface = loadmodel.marksurfaces.slice(din.firstleafface);
    lf.nummarksurfaces = din.numleaffaces;
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
  // classic LUMP_LEAFFACES is an `unsigned short` array on disk (q2repro's
  // own classic BSP_LoadLeafFaces reads it via BSP_Short(), an unsigned
  // 16-bit read -- see bsp_template.c). A signed getInt16 read here silently
  // turned any facenum >= 32768 negative; retail's classic-ident
  // maps/mgu*.bsp entries (not every mgu map is QBSP -- see qfiles.ts's
  // IDBSPHEADER_EXT comment) reach 43290+ faces, well over that threshold.
  // Fixed to getUint16 to match q2repro; no observable change for any face
  // count under 32768 (every currently-passing map), since the top bit is
  // never set.
  const out: MsurfaceT[] = [];
  for (let i = 0; i < count; i++) {
    const j = mod_view.getUint16(l.fileofs + i * 2, true);
    if (j >= loadmodel.numsurfaces) ri.Sys_Error(ERR_DROP, "Mod_ParseMarksurfaces: bad surface number");
    out.push(loadmodel.surfaces[j]);
  }
  loadmodel.marksurfaces = out;
  loadmodel.nummarksurfaces = count;
}

/*
=================
Mod_LoadMarksurfacesExt

QBSP extended format (bsp_template.c's BSP_LoadMarksurfacesExt): the raw
facenum array widens from uint16 to uint32. Same bounds check as the
existing classic Mod_LoadMarksurfaces above, same error message.
Call order dependency: needs loadmodel.numsurfaces already set (Faces loads
before LeafFaces in this branch's own sequence).
=================
*/
function Mod_LoadMarksurfacesExt(l: LumpT): void {
  if (l.filelen % LEAFFACE_EXT_SIZE) ri.Sys_Error(ERR_DROP, `MOD_LoadBmodel: funny lump size in ${loadmodel.name}`);
  const count = l.filelen / LEAFFACE_EXT_SIZE;
  const out: MsurfaceT[] = [];
  for (let i = 0; i < count; i++) {
    const j = readUint32(mod_view, l.fileofs + i * LEAFFACE_EXT_SIZE);
    if (j >= loadmodel.numsurfaces) ri.Sys_Error(ERR_DROP, "Mod_ParseMarksurfaces: bad surface number");
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
PrescanClassicSurfaceExtents

Runs CalcSurfaceExtents's own texture-axis bounding-box math over every
face in the raw LUMP_FACES data, WITHOUT allocating any MsurfaceT objects,
purely to print ONE up-front summary warning if any face will end up
flagged SURF_EXTENTS_SKIP by CalcSurfaceExtents itself once Mod_LoadFaces
actually runs (excluding SURF_WARP/SURF_SKY, same exclusion
CalcSurfaceExtents applies). This function does not mutate anything and no
longer aborts loading -- see SURF_EXTENTS_SKIP's own comment on
r_model.ts's SURF_ flag block for why a whole-map refusal was replaced
with a per-face skip. Keeping this separate prescan (rather than counting
inside CalcSurfaceExtents's own per-face loop) is what makes the warning a
single map-level summary instead of one line per offending face.

`extended` selects the QBSP record layout (DFACE_EXT_T_SIZE, readDfaceExt)
for a QBSP map instead of the classic 20-byte dface_t -- this function has
no reference in bsp.c at all (it is a re-ts-only diagnostic prescan, not a
port of anything in q2repro), so it just needs to read whichever on-disk
face record Mod_LoadFaces/Mod_LoadFacesExt is about to read, the same way
those two functions themselves branch on format.
=================
*/
function PrescanClassicSurfaceExtents(mod: ModelT, l: LumpT, extended: boolean): void {
  const recordSize = extended ? DFACE_EXT_T_SIZE : DFACE_T_SIZE;
  if (l.filelen % recordSize) return; // Mod_LoadFaces/Mod_LoadFacesExt reports this exact error itself
  const count = l.filelen / recordSize;

  let violations = 0;
  let worstExtent = 0;

  for (let surfnum = 0; surfnum < count; surfnum++) {
    let firstedge: number;
    let numedges: number;
    let ti: number;
    if (extended) {
      const din = readDfaceExt(mod_view, l.fileofs + surfnum * recordSize);
      firstedge = din.firstedge;
      numedges = din.numedges;
      ti = din.texinfo;
    } else {
      const base = l.fileofs + surfnum * recordSize;
      firstedge = mod_view.getInt32(base + 4, true);
      numedges = mod_view.getInt16(base + 8, true);
      ti = mod_view.getUint16(base + 10, true);
    }
    if (ti >= loadmodel.numtexinfo) continue; // Mod_LoadFaces/Mod_LoadFacesExt reports this exact error itself
    const tex = loadmodel.texinfo[ti];
    if (tex.flags & (SURF_WARP | SURF_SKY)) continue;

    const mins = [999999, 999999];
    const maxs = [-99999, -99999];

    for (let i = 0; i < numedges; i++) {
      const e = loadmodel.surfedges[firstedge + i];
      const v = e >= 0 ? loadmodel.vertexes[loadmodel.edges[e].v[0]] : loadmodel.vertexes[loadmodel.edges[-e].v[1]];

      for (let j = 0; j < 2; j++) {
        const val = v.position[0] * tex.vecs[j][0] + v.position[1] * tex.vecs[j][1] + v.position[2] * tex.vecs[j][2] + tex.vecs[j][3];
        if (val < mins[j]) mins[j] = val;
        if (val > maxs[j]) maxs[j] = val;
      }
    }

    for (let j = 0; j < 2; j++) {
      const bmin = Math.floor(mins[j] / 16);
      const bmax = Math.ceil(maxs[j] / 16);
      const extent = (bmax - bmin) * 16;
      if (extent > 256) {
        violations++;
        if (extent > worstExtent) worstExtent = extent;
      }
    }
  }

  if (violations > 0) {
    ri.Con_Printf(
      PRINT_ALL,
      `${mod.name}: ${violations} surface(s) exceed the software renderer's 256-unit surface-extents cap (worst: ${worstExtent} units) and will not be drawn (SURF_EXTENTS_SKIP) -- the classic PC engine's surface cache genuinely cannot represent surfaces this large (see D_SCAlloc's "bad cache width" hard error, vanilla ref_soft/r_surf.c); this content (e.g. the Q64/N64 remaster map set) was authored for a different renderer entirely. Load with the OpenGL renderer for full geometry.\n`,
    );
  }
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
  // ident dispatch mirrors bsp.c's Q_ERR_UNKNOWN_FORMAT default case: only
  // classic IBSP and extended QBSP are recognized (Mod_ForName's own switch
  // already only reaches this function for those two idents, but the check
  // is repeated here so this function stays correct standalone), same
  // dispatch cmodel.ts's CM_LoadMap and gl_model.ts's Mod_LoadBrushModel
  // already perform.
  const extended = header.ident === IDBSPHEADER_EXT;
  if (header.ident !== IDBSPHEADER && !extended) {
    ri.Sys_Error(ERR_DROP, `Mod_LoadBrushModel: ${mod.name} unknown BSP fileid`);
  }
  if (header.version !== BSPVERSION) {
    ri.Sys_Error(ERR_DROP, `Mod_LoadBrushModel: ${mod.name} has wrong version number (${header.version} should be ${BSPVERSION})`);
  }

  // the C original's manual byteswap-in-place loop over the header ints is a
  // no-op on this little-endian-only port; every Load* helper below reads
  // its own fields through a little-endian DataView instead (mod_view, set
  // by Mod_ForName before this function runs).

  if (extended) {
    Mod_LoadPlanes(header.lumps[LUMP_PLANES]);
    Mod_LoadTexinfo(header.lumps[LUMP_TEXINFO]);
    Mod_LoadLighting(header.lumps[LUMP_LIGHTING]);
    Mod_LoadVertexes(header.lumps[LUMP_VERTEXES]);
    Mod_LoadEdgesExt(header.lumps[LUMP_EDGES]);
    Mod_LoadSurfedges(header.lumps[LUMP_SURFEDGES]);
  } else {
    // load into heap
    Mod_LoadVertexes(header.lumps[LUMP_VERTEXES]);
    Mod_LoadEdges(header.lumps[LUMP_EDGES]);
    Mod_LoadSurfedges(header.lumps[LUMP_SURFEDGES]);
    Mod_LoadLighting(header.lumps[LUMP_LIGHTING]);
    Mod_LoadPlanes(header.lumps[LUMP_PLANES]);
    Mod_LoadTexinfo(header.lumps[LUMP_TEXINFO]);
  }

  // BSPX extension directory -- not part of any r_model.c this file is
  // otherwise ported from (vanilla software renderer has no such concept).
  // Parsed here, BEFORE Mod_LoadFaces/Mod_LoadFacesExt, purely to detect
  // DECOUPLED_LM/LIGHTGRID_OCTREE up front (see the graceful-refusal block
  // right below this one) -- `numfaces` is computed directly from the face
  // lump's size (format-aware: DFACE_EXT_T_SIZE for a QBSP map, per this
  // function's own `extended` dispatch above) rather than read from
  // `loadmodel.numsurfaces`, which isn't set until Mod_LoadFaces/
  // Mod_LoadFacesExt runs a few lines down. Otherwise parse-and-report only:
  // this renderer's lightmap-building/lighting-sampling pipeline (r_light.ts/
  // r_surf.ts) still ignores decoupled lightmaps and the lightgrid entirely
  // -- see the graceful-refusal block's comment for why that isn't fixed
  // here (there is no reference software renderer to port a fix from).
  {
    const lumpsEnd = header.lumps.reduce((max, l) => Math.max(max, l.fileofs + l.filelen), 0);
    const bspxDir = parseBspxDirectory(buffer, lumpsEnd, buffer.length);
    let decoupledLm: DecoupledLmResultT | null = null;
    let lightgrid: LightgridT | null = null;

    if (bspxDir) {
      const lightingLump = header.lumps[LUMP_LIGHTING];
      const faceRecordSize = extended ? DFACE_EXT_T_SIZE : DFACE_T_SIZE;
      const numfaces = header.lumps[LUMP_FACES].filelen / faceRecordSize;

      const dlm = bspxDir.lumps.get("DECOUPLED_LM");
      if (dlm) {
        decoupledLm = parseDecoupledLM(buffer, dlm.fileofs, dlm.filelen, numfaces, lightingLump.filelen);
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

  // BSPX DECOUPLED_LM maps: q2repro (the only rerelease-era reference this
  // port has) HAS NO SOFTWARE RENDERER AT ALL (verified: no
  // src/refresh/*soft*, no sw_*.c anywhere in ~/Projects/qsrc/q2repro) --
  // there is no reference "how does the soft path handle DECOUPLED_LM"
  // behavior to port, faithfully or otherwise, and this renderer's
  // lighting pipeline (r_light.ts/r_surf.ts) never reads BSPX data, so a
  // DECOUPLED_LM face's real per-texel lighting cannot be reproduced here
  // without a rewrite of the surface-cache/lightmap pipeline (it assumes
  // one texel grid, scale 16, shared by both texture and lightmap
  // sampling -- DECOUPLED_LM's whole point on the GL side is a SEPARATE
  // lightmap axis/scale/offset from the texture's own, which this
  // renderer's data model has no room for).
  //
  // This was previously a whole-map refusal (ERR_DROP). Real data shows
  // that is a worse degrade than necessary: a DECOUPLED_LM map's classic
  // dface_t lightofs field is -1 for every face (verified against
  // baseq2/maps/base1.bsp: all 16787 faces) -- and this renderer's own
  // R_BuildLightMap (r_light.ts) ALREADY treats lightofs===-1 (surf.samples
  // === null) as "no static lightmap data", clearing blocklights to 0,
  // which the bound/invert/shift step at the end of R_BuildLightMap turns
  // into the renderer's ordinary MAXIMUM-brightness encoding -- i.e. a
  // ready-made, pre-existing, faithful-to-vanilla fullbright fallback for
  // exactly this case (the same path any classic lightofs===-1 brush,
  // decoupled or not, has always taken). So DECOUPLED_LM surfaces render
  // with correct geometry and textures, just flat/fullbright-shaded
  // instead of properly lit -- a per-surface flat-shade fallback, not a
  // per-map refusal -- and need no code change at all beyond not refusing
  // to load. (Some DECOUPLED_LM remaster maps -- verified real:
  // baseq2/maps/rhangar1.bsp, q2dm3.bsp, rlava1.bsp, rlava2.bsp,
  // rmine1.bsp -- separately also have a handful of surfaces whose plain
  // geometry/texture-axis extents exceed the classic 256-unit cap; those
  // are caught and skipped independently by SURF_EXTENTS_SKIP below, same
  // as the non-BSPX Q64 case, not by this block.)
  if (loadmodel.bspx?.decoupledLm) {
    ri.Con_Printf(
      PRINT_ALL,
      `${mod.name}: this map uses BSPX decoupled lightmaps (DECOUPLED_LM, ${loadmodel.bspx.decoupledLm.faces.length} faces) -- the software renderer does not consume BSPX data, so affected surfaces render fullbright (flat-shaded) instead of properly lit; load with the OpenGL renderer for correct lighting\n`,
    );
  }

  // Classic (non-BSPX) content whose raw geometry/texture-axis extents
  // genuinely exceed vanilla's 256-unit surface-cache cap -- verified
  // real: baseq2/maps/q64/*.bsp (the N64 remaster set, no BSPX at all)
  // violates the cap on 150-275 surfaces per map (measured: outpost.bsp
  // 177/4205, core.bsp 259/4528, dm1.bsp 35/824). q2repro has no software
  // renderer to port a raised-cap fix from (verified, same as the
  // DECOUPLED_LM note above), and raising the cap here for real would mean
  // growing this renderer's own fixed-size surface cache / blocklights
  // buffers (r_light.ts/r_surf.ts) well past their vanilla-derived sizes
  // to admit geometry the classic PC engine's surface cache was never
  // built for (Q64's geometry was authored for the N64's own bespoke
  // renderer, not this one; see SURF_EXTENTS_SKIP's own comment for the
  // hard D_SCAlloc/blocklights capacity limits that make this a genuine
  // constraint, not just a convention) -- that would be new capability,
  // not a faithful port.
  //
  // Previously this was a whole-map up-front refusal (mirroring the
  // DECOUPLED_LM block above); it is now CalcSurfaceExtents flagging only
  // the individual offending faces SURF_EXTENTS_SKIP (r_rast.ts's
  // R_RenderFace/R_RenderBmodelFace never queue them for rasterization),
  // so the rest of a Q64-style map still renders. This prescan runs the
  // same extents math BEFORE Mod_LoadFaces allocates anything purely to
  // print one map-level summary warning up front instead of the flag
  // silently doing its work face-by-face with no visible signal at all.
  PrescanClassicSurfaceExtents(mod, header.lumps[LUMP_FACES], extended);

  // The extended (QBSP) branch below follows bsp.c's bsp_lumps[] table order
  // rather than the classic branch's order, because the wider Ext loaders
  // cross-validate against lumps that must already be loaded (see each
  // Mod_Load*Ext function's own header comment for its specific dependency)
  // -- see cmodel.ts's CM_LoadMap for the same pattern.
  if (extended) {
    Mod_LoadVisibility(header.lumps[LUMP_VISIBILITY]);
    Mod_LoadFacesExt(header.lumps[LUMP_FACES]);
    Mod_LoadMarksurfacesExt(header.lumps[LUMP_LEAFFACES]);
    Mod_LoadLeafsExt(header.lumps[LUMP_LEAFS]);
    Mod_LoadNodesExt(header.lumps[LUMP_NODES]);
    Mod_LoadSubmodels(header.lumps[LUMP_MODELS]);
  } else {
    Mod_LoadFaces(header.lumps[LUMP_FACES]);
    Mod_LoadMarksurfaces(header.lumps[LUMP_LEAFFACES]);
    Mod_LoadVisibility(header.lumps[LUMP_VISIBILITY]);
    Mod_LoadLeafs(header.lumps[LUMP_LEAFS]);
    Mod_LoadNodes(header.lumps[LUMP_NODES]);
    Mod_LoadSubmodels(header.lumps[LUMP_MODELS]);
  }
  r_numvisleafs = 0;
  R_NumberLeafs(loadmodel.nodes[0]);

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

    starmod.maxs[0] = bm.maxs[0];
    starmod.maxs[1] = bm.maxs[1];
    starmod.maxs[2] = bm.maxs[2];
    starmod.mins[0] = bm.mins[0];
    starmod.mins[1] = bm.mins[1];
    starmod.mins[2] = bm.mins[2];

    if (i === 0) {
      Object.assign(loadmodel, starmod); // *loadmodel = *starmod;
      // same by-value semantics for the copy-back (see above)
      loadmodel.mins = vec3(starmod.mins[0], starmod.mins[1], starmod.mins[2]);
      loadmodel.maxs = vec3(starmod.maxs[0], starmod.maxs[1], starmod.maxs[2]);
      loadmodel.clipmins = vec3(starmod.clipmins[0], starmod.clipmins[1], starmod.clipmins[2]);
      loadmodel.clipmaxs = vec3(starmod.clipmaxs[0], starmod.clipmaxs[1], starmod.clipmaxs[2]);
    }
  }

  rRastMod().R_InitSkyBox();
}

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

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

// exported (beyond r_model.h's surface) so tests can narrow ModelT.extradata
// -- the same test-introspection rationale as mod_known/mod_inline above.
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
    mod.skins[i] = rImageMod().R_FindImage(hdr.skinnames[i], ImagetypeT.it_skin);
  }
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

  // byte swap everything
  for (let i = 0; i < sp.numframes; i++) {
    const o = DSPRITE_HEADER_SIZE + i * DSPRFRAME_T_SIZE;
    const f = new DsprframeT();
    f.width = view.getInt32(o, true);
    f.height = view.getInt32(o + 4, true);
    f.origin_x = view.getInt32(o + 8, true);
    f.origin_y = view.getInt32(o + 12, true);
    f.name = readCString(view, o + 16, MAX_SKINNAME);
    sp.frames.push(f);
    mod.skins[i] = rImageMod().R_FindImage(f.name, ImagetypeT.it_sprite);
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
  registration_sequence++;
  SetOldViewCluster(-1); // force markleafs
  const fullname = Com_sprintf("maps/%s.bsp", model);

  rSurfMod().D_FlushCaches();
  // explicitly free the old map if different
  // this guarantees that mod_known[0] is the world map
  const flushmap = ri.Cvar_Get("flushmap", "0", 0);
  if (mod_known[0].name !== fullname || (flushmap && flushmap.value)) {
    Mod_Free(mod_known[0]);
  }
  SetWorldModel(R_RegisterModel(fullname));
  rMainMod().R_NewMap();
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
          mod.skins[i] = rImageMod().R_FindImage(spr.frames[i].name, ImagetypeT.it_sprite);
        }
      }
    } else if (mod.type === ModtypeT.mod_alias) {
      const hdr = mod.extradata;
      if (hdr instanceof ParsedMd2T) {
        for (let i = 0; i < hdr.num_skins; i++) {
          mod.skins[i] = rImageMod().R_FindImage(hdr.skinnames[i], ImagetypeT.it_skin);
        }
        //PGM
        mod.numframes = hdr.num_frames;
        //PGM
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
    // else: "make sure it is paged in" (Com_PageInMemory) has no equivalent
    // here -- extradata is a parsed object, not a raw Hunk byte buffer, so
    // there is nothing to page-touch. Dropped; see report.
  }

  rImageMod().R_FreeUnusedImages();
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
