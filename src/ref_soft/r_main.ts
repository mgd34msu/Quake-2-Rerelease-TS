/*
Copyright (C) 1997-2001 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

Ported from ref_soft/r_main.c (GNU GPL v2 or later). `Sys_Error`/
`Com_Printf` at the bottom of the C original are only compiled
`#ifndef REF_HARD_LINKED` (so q_shared.c/q_shwin.c can link when this
renderer is built as a standalone DLL); this port is always hard-linked
into a single bun process (src/qcommon/q_shared.ts and src/platform/sys.ts
already own those symbols), so that whole section is dropped -- reported
dropped branch, matching PORTING.md's "#ifdef ... take the portable path"
rule applied to a link-time (not OS) ifdef.

`R_ImageList_f` (the `imagelist` console command) is ported in r_image.ts
and registered/unregistered here exactly as the C does.

`#if id386` branches (Sys_MakeCodeWriteable/Sys_SetFPCW in R_Init) are
dropped per PORTING.md's portable-path rule.

Cross-module mutable state: every r_local.h extern r_main.c is the C sole
writer of is owned by r_local.ts and assigned through its setters, since an
imported `let` binding is read-only to the importer. That covers
`currentmodel`/`currententity` (R_DrawEntitiesOnList/R_DrawBEntitiesOnList),
`insubmodel`/`r_clipflags`/`r_dlightframecount` (R_DrawBEntitiesOnList, read
by r_rast.ts/r_light.ts), `r_cnumsurfs`/`surfaces`/`surface_p`/`surf_max`/
`r_surfsonstack`/`r_maxedgesseen`/`r_maxsurfsseen`/`r_numallocatededges`/
`auxedges`/`r_edges` (R_NewMap/R_EdgeDrawing, consumed by r_edge.ts's
R_BeginEdgeFrame/R_ScanEdges and filled by r_rast.ts), `r_notexture_mip`
(R_InitTextures, read by r_image.ts/r_model.ts as the texture-not-found
fallback), `r_aliasuvscale`, and `r_oldviewcluster`/`r_visframecount`
(R_MarkLeaves, read by r_bsp.ts's R_RecursiveWorldNode). `r_viewcluster` is
written through r_misc.ts's `SetViewCluster`, which forwards to the same
r_local.ts binding.

R_NewMap/R_EdgeDrawing's C bodies swap between malloc'd and stack-array
surface/edge buffers. `surf_max`/`edge_max` are end *pointers* in C and index
bounds here, and the C biases the surface array with `surfaces--` so index 0
is a dummy; the port allocates one extra slot instead. The `ledges`/`lsurfs`
stack arrays live at the same address every frame in C, so they are allocated
once per size here rather than per frame.

`R_SetSky` fills in `r_skytexinfo`, which r_rast.ts owns and exports -- the
same array R_InitSkyBox/R_RenderFace draw with (r_local.h calls it
`sky_texinfo`).

`R_ScreenShot_f`/`WritePCX`/`SetScreenshotWriter` live in r_misc.ts (r_misc.c
is their true C home); this file just wires `R_Register`'s
`ri.Cmd_AddCommand("screenshot", ...)` to the import.
*/

import {
  AngleVectors,
  DotProduct,
  PerpendicularVector,
  RotatePointAroundVector,
  VectorCopy,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
  BOX_ON_PLANE_SIDE,
  type Vec3,
  vec3,
  vec3_origin,
} from "../shared/math";
import { CONTENTS_SOLID, CVAR_ARCHIVE, CVAR_USERINFO, Com_sprintf, ERR_FATAL, PRINT_ALL, RDF_NOWORLDMODEL, RF_BEAM, RF_TRANSLUCENT, type CvarT } from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import type { RefExports, RefImports, EntityT, RefdefT, DrawColorT } from "../client/ref";
import { API_VERSION } from "../client/ref";
import {
  AMP,
  AMP2,
  CYCLE,
  REF_VERSION,
  RserrT,
  base_vpn,
  base_vright,
  base_vup,
  blanktable,
  BMODEL_FULLY_CLIPPED,
  d_8to24table,
  intsintable,
  modelorg,
  pfrustum_indexes,
  r_entorigin,
  r_newrefdef,
  r_origin,
  r_refdef,
  ri,
  rCvars,
  SetRefImports,
  sintable,
  sw_state,
  auxedges,
  currententity,
  currentmodel,
  r_cnumsurfs,
  r_numallocatededges,
  r_oldviewcluster,
  r_surfsonstack,
  r_visframecount,
  surf_max,
  surfaces,
  SetAliasUvScale,
  SetAuxEdges,
  SetClipflags,
  SetCnumSurfs,
  SetCurrentEntity,
  SetCurrentModel,
  SetDlightFrameCount,
  SetEdges,
  SetInsubmodel,
  SetMaxEdgesSeen,
  SetMaxSurfsSeen,
  SetNotextureMip,
  SetNumAllocatedEdges,
  SetOldViewCluster,
  SetSurfMax,
  SetSurfaceP,
  SetSurfaces,
  SetSurfsOnStack,
  SetVisFrameCount,
  EdgeT,
  SurfT,
  view_clipplanes,
  vid,
  vpn,
  vright,
  vup,
  SIN_BUFFER_SIZE,
} from "./r_local";
import {
  isMleaf,
  Mod_ClusterPVS,
  Mod_FreeAll,
  Mod_Init,
  Mod_Modellist_f,
  ModtypeT,
  ModelT,
  ImageT,
  R_BeginRegistration,
  R_EndRegistration,
  R_RegisterModel,
  type MnodeOrLeaf,
  ImagetypeT,
} from "./r_model";
import { r_worldmodel, R_DrawSolidClippedSubmodelPolygons, R_DrawSubmodelPolygons, R_RenderWorld, R_RotateBmodel } from "./r_bsp";
import { Draw_Char, Draw_ColorPic, Draw_FadeScreen, Draw_Fill, Draw_FindPic, Draw_GetPicSize, Draw_InitLocal, Draw_Pic, Draw_StretchPic, Draw_StretchPicRegion, Draw_StretchRaw, Draw_TileClear } from "./r_draw";
import { LoadPCX, R_FindImage, R_ImageList_f, R_InitImages, R_RegisterSkin, R_RegisterRawPic, R_ShutdownImages } from "./r_image";
import { R_BeginEdgeFrame, R_ScanEdges, R_SurfacePatch } from "./r_edge";
import { r_skytexinfo } from "./r_rast";
import { D_FlushCaches, R_InitCaches } from "./r_surf";
import { D_SetZBuffer, D_WarpScreen } from "./r_scan";
import { R_LightPoint, R_PushDlights } from "./r_light";
import { R_PrintAliasStats, R_PrintDSpeeds, R_PrintTimes, R_ScreenShot_f, R_SetupFrame, R_TransformFrustum, SetTimeRef, SetViewCluster, r_dowarp, r_framecount, r_viewcluster } from "./r_misc";
import { R_DrawSprite } from "./r_sprite";
import { R_AliasDrawModel } from "./r_alias";
import { R_DrawParticles } from "./r_part";
import { R_DrawAlphaSurfaces, R_IMFlatShadedQuad } from "./r_poly";
import { SWimp_AppActivate, SWimp_EndFrame, SWimp_Init, SWimp_SetMode, SWimp_SetPalette, SWimp_Shutdown } from "../platform/swimp";
import { Sys_Milliseconds } from "../platform/sys";

//===================================================================

export let skyname = "";
export let skyrotate = 0;
export const skyaxis: Vec3 = vec3();

const MINSURFACES = 1000; // NUMSTACKSURFACES (r_local.ts)
const MINEDGES = 2000; // NUMSTACKEDGES (r_local.ts)
const NUMSTACKSURFACES = 1000;
const NUMSTACKEDGES = 2000;

// r_main.c's own file-scope cvars that rCvars (r_local.ts) has no field
// for -- see this file's header comment.
let sw_allow_modex: CvarT | null = null;
let r_novis: CvarT | null = null;
let sw_lockpvs: CvarT | null = null;

//===================================================================

// C overlays image_t's header directly onto a raw byte buffer
// (`r_notexture_mip = (image_t *)&r_notexture_buffer`) and hand-computes
// pixel offsets into the tail of that same buffer; there is no pointer
// arithmetic in TS, so the same width/height/four-mip-level data is carried
// by a real ImageT instead of a byte-buffer overlay.
/*
==================
R_InitTextures
==================
*/
function R_InitTextures(): void {
  // create a simple checkerboard texture for the default
  const pixels: Uint8Array[] = [new Uint8Array(16 * 16), new Uint8Array(8 * 8), new Uint8Array(4 * 4), new Uint8Array(2 * 2)];

  for (let m = 0; m < 4; m++) {
    const size = 16 >> m;
    const dest = pixels[m];
    let di = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        dest[di++] = (y < size >> 1) !== (x < size >> 1) ? 0 : 0xff;
      }
    }
  }

  const image = new ImageT();
  image.name = "notexture";
  image.type = ImagetypeT.it_wall;
  image.width = 16;
  image.height = 16;
  image.pixels = pixels;
  SetNotextureMip(image);
}

/*
================
R_InitTurb
================
*/
export function R_InitTurb(): void {
  // C hardcodes 1280 here; the tables now scale with MAXWIDTH (mode 10)
  for (let i = 0; i < SIN_BUFFER_SIZE; i++) {
    sintable[i] = AMP + Math.sin(((i * 3.14159 * 2) / CYCLE)) * AMP;
    intsintable[i] = AMP2 + Math.sin(((i * 3.14159 * 2) / CYCLE)) * AMP2; // AMP2, not 20
    blanktable[i] = 0; //PGM
  }
}

export function R_Register(): void {
  rCvars.sw_aliasstats = ri.Cvar_Get("sw_polymodelstats", "0", 0);
  sw_allow_modex = ri.Cvar_Get("sw_allow_modex", "1", CVAR_ARCHIVE);
  rCvars.sw_clearcolor = ri.Cvar_Get("sw_clearcolor", "2", 0);
  rCvars.sw_drawflat = ri.Cvar_Get("sw_drawflat", "0", 0);
  rCvars.sw_draworder = ri.Cvar_Get("sw_draworder", "0", 0);
  rCvars.sw_maxedges = ri.Cvar_Get("sw_maxedges", String(NUMSTACKSURFACES), 0);
  rCvars.sw_maxsurfs = ri.Cvar_Get("sw_maxsurfs", "0", 0);
  rCvars.sw_mipcap = ri.Cvar_Get("sw_mipcap", "0", 0);
  rCvars.sw_mipscale = ri.Cvar_Get("sw_mipscale", "1", 0);
  rCvars.sw_reportedgeout = ri.Cvar_Get("sw_reportedgeout", "0", 0);
  rCvars.sw_reportsurfout = ri.Cvar_Get("sw_reportsurfout", "0", 0);
  rCvars.sw_stipplealpha = ri.Cvar_Get("sw_stipplealpha", "0", CVAR_ARCHIVE);
  rCvars.sw_surfcacheoverride = ri.Cvar_Get("sw_surfcacheoverride", "0", 0);
  rCvars.sw_waterwarp = ri.Cvar_Get("sw_waterwarp", "1", 0);
  rCvars.sw_mode = ri.Cvar_Get("sw_mode", "0", CVAR_ARCHIVE);

  rCvars.r_lefthand = ri.Cvar_Get("hand", "0", CVAR_USERINFO | CVAR_ARCHIVE);
  rCvars.r_speeds = ri.Cvar_Get("r_speeds", "0", 0);
  rCvars.r_fullbright = ri.Cvar_Get("r_fullbright", "0", 0);
  rCvars.r_drawentities = ri.Cvar_Get("r_drawentities", "1", 0);
  rCvars.r_drawworld = ri.Cvar_Get("r_drawworld", "1", 0);
  rCvars.r_dspeeds = ri.Cvar_Get("r_dspeeds", "0", 0);
  rCvars.r_lightlevel = ri.Cvar_Get("r_lightlevel", "0", 0);
  rCvars.r_lerpmodels = ri.Cvar_Get("r_lerpmodels", "1", 0);
  r_novis = ri.Cvar_Get("r_novis", "0", 0);

  rCvars.vid_fullscreen = ri.Cvar_Get("vid_fullscreen", "0", CVAR_ARCHIVE);
  rCvars.vid_gamma = ri.Cvar_Get("vid_gamma", "1.0", CVAR_ARCHIVE);
  rCvars.vid_scale = ri.Cvar_Get("vid_scale", "1", CVAR_ARCHIVE);

  ri.Cmd_AddCommand("modellist", Mod_Modellist_f);
  ri.Cmd_AddCommand("screenshot", R_ScreenShot_f);
  ri.Cmd_AddCommand("imagelist", R_ImageList_f);
  // "imagelist" -- see file header comment: R_ImageList_f was never ported

  if (rCvars.sw_mode) rCvars.sw_mode.modified = true; // force us to do mode specific stuff later
  if (rCvars.vid_gamma) rCvars.vid_gamma.modified = true; // force us to rebuild the gamma table later

  //PGM
  sw_lockpvs = ri.Cvar_Get("sw_lockpvs", "0", 0);
  //PGM
}

export function R_UnRegister(): void {
  ri.Cmd_RemoveCommand("screenshot");
  ri.Cmd_RemoveCommand("imagelist");
  ri.Cmd_RemoveCommand("modellist");
  // "imagelist" -- see file header comment / R_Register
}

/*
===============
R_Init
===============
*/
export function R_Init(hInstance: unknown, wndProc: unknown): boolean {
  // ORDER DEVIATION from vanilla r_main.c (which calls Draw_GetPalette
  // later, after R_Register): the PNG->palette quantize path added for
  // rerelease-data 2D pics (r_image.ts LoadPNGQuantized) runs inside
  // Draw_InitLocal's conchars load and nearest-matches against
  // d_8to24table -- with the table still all zeros, every glyph mapped to
  // palette index 0 and console text drew solid black (found live on
  // Mike's RC pass). Vanilla's order was safe only because PCX pixels ARE
  // palette indices; the palette must now be loaded first. Draw_GetPalette
  // is self-contained (colormap.pcx read) and idempotent.
  Draw_GetPalette();
  R_InitImages();
  Mod_Init();
  Draw_InitLocal();
  R_InitTextures();

  R_InitTurb();

  view_clipplanes[0].leftedge = 1;
  view_clipplanes[1].rightedge = 1;
  view_clipplanes[1].leftedge = view_clipplanes[2].leftedge = view_clipplanes[3].leftedge = 0;
  view_clipplanes[0].rightedge = view_clipplanes[2].rightedge = view_clipplanes[3].rightedge = 0;

  r_refdef.xOrigin = 0.5;
  r_refdef.yOrigin = 0.5;

  // #if id386: Sys_MakeCodeWriteable / Sys_SetFPCW -- dropped, portable path

  SetAliasUvScale(1.0);

  R_Register();
  // Draw_GetPalette moved to the top of R_Init -- see the order-deviation
  // comment there (vanilla called it here).
  SWimp_Init(hInstance, wndProc);

  // create the window
  R_BeginFrame(0);

  ri.Con_Printf(PRINT_ALL, `ref_soft version: ${REF_VERSION}\n`);

  return true;
}

/*
===============
R_Shutdown
===============
*/
export function R_Shutdown(): void {
  // free z buffer -- r_scan.ts owns the buffer; nothing to null out here

  // free surface cache
  D_FlushCaches();

  // free colormap
  vid.colormap = null;

  R_UnRegister();
  Mod_FreeAll();
  R_ShutdownImages();

  SWimp_Shutdown();
}

/*
===============
R_NewMap
===============
*/
export function R_NewMap(): void {
  SetViewCluster(-1);

  let cnumsurfs = rCvars.sw_maxsurfs ? rCvars.sw_maxsurfs.value | 0 : 0;

  if (cnumsurfs <= MINSURFACES) cnumsurfs = MINSURFACES;
  SetCnumSurfs(cnumsurfs);

  if (cnumsurfs > NUMSTACKSURFACES) {
    // surface 0 doesn't really exist; it's just a dummy because index 0
    // is used to indicate no edge attached to surface (C biases the
    // malloc'd pointer with `surfaces--`; here the dummy is a real slot 0
    // and `surf_max` is the index bound rather than an end pointer)
    SetSurfaces(allocSurfaces(cnumsurfs));
    SetSurfaceP(0);
    SetSurfMax(cnumsurfs);
    SetSurfsOnStack(false);
    R_SurfacePatch();
  } else {
    SetSurfsOnStack(true);
  }

  SetMaxEdgesSeen(0);
  SetMaxSurfsSeen(0);

  let numallocatededges = rCvars.sw_maxedges ? rCvars.sw_maxedges.value | 0 : 0;

  if (numallocatededges < MINEDGES) numallocatededges = MINEDGES;
  SetNumAllocatedEdges(numallocatededges);

  if (numallocatededges <= NUMSTACKEDGES) {
    SetAuxEdges(null);
  } else {
    SetAuxEdges(allocEdges(numallocatededges));
  }
}

// R_EdgeDrawing's `ledges`/`lsurfs` are C stack arrays reused at the same
// address every frame; allocated once per size here rather than per frame.
let stackEdges: EdgeT[] = [];
let stackSurfaces: SurfT[] = [];

function allocEdges(count: number): EdgeT[] {
  return Array.from({ length: count }, () => new EdgeT());
}

function allocSurfaces(count: number): SurfT[] {
  // one extra for the index-0 dummy -- see R_NewMap
  return Array.from({ length: count + 1 }, () => new SurfT());
}

/*
===============
R_MarkLeaves

Mark the leaves and nodes that are in the PVS for the current
cluster
===============
*/
function R_MarkLeaves(): void {
  if (r_oldviewcluster === r_viewcluster && !(r_novis && r_novis.value) && r_viewcluster !== -1) return;

  // development aid to let you run around and see exactly where
  // the pvs ends
  if (sw_lockpvs && sw_lockpvs.value) return;

  SetVisFrameCount(r_visframecount + 1);
  SetOldViewCluster(r_viewcluster);

  if (!r_worldmodel) return;

  if ((r_novis && r_novis.value) || r_viewcluster === -1 || !r_worldmodel.vis) {
    // mark everything
    for (let i = 0; i < r_worldmodel.numleafs; i++) r_worldmodel.leafs[i].visframe = r_visframecount;
    for (let i = 0; i < r_worldmodel.numnodes; i++) r_worldmodel.nodes[i].visframe = r_visframecount;
    return;
  }

  const vis = Mod_ClusterPVS(r_viewcluster, r_worldmodel);

  for (let i = 0; i < r_worldmodel.numleafs; i++) {
    const leaf = r_worldmodel.leafs[i];
    const cluster = leaf.cluster;
    if (cluster === -1) continue;
    if (vis[cluster >> 3] & (1 << (cluster & 7))) {
      let node: MnodeOrLeaf | null = leaf;
      do {
        if (node.visframe === r_visframecount) break;
        node.visframe = r_visframecount;
        node = node.parent;
      } while (node);
    }
  }
}

/*
** R_DrawNullModel
**
** IMPLEMENT THIS!
*/
function R_DrawNullModel(): void {}

/*
=============
R_DrawEntitiesOnList
=============
*/
function R_DrawEntitiesOnList(): void {
  if (!(rCvars.r_drawentities && rCvars.r_drawentities.value)) return;

  let translucent_entities = false;

  // all bmodels have already been drawn by the edge list
  for (let i = 0; i < r_newrefdef.num_entities; i++) {
    const ent = r_newrefdef.entities[i];
    SetCurrentEntity(ent);

    if (ent.flags & RF_TRANSLUCENT) {
      translucent_entities = true;
      continue;
    }

    drawOneEntity(ent);
  }

  if (!translucent_entities) return;

  for (let i = 0; i < r_newrefdef.num_entities; i++) {
    const ent = r_newrefdef.entities[i];
    SetCurrentEntity(ent);

    if (!(ent.flags & RF_TRANSLUCENT)) continue;

    drawOneEntity(ent);
  }
}

function drawOneEntity(ent: EntityT): void {
  if (ent.flags & RF_BEAM) {
    modelorg[0] = -r_origin[0];
    modelorg[1] = -r_origin[1];
    modelorg[2] = -r_origin[2];
    VectorCopy(vec3_origin, r_entorigin);
    R_DrawBeam(ent);
    return;
  }

  const handle = ent.model;
  if (handle === null || !(handle instanceof ModelT)) {
    SetCurrentModel(null);
    R_DrawNullModel();
    return;
  }

  SetCurrentModel(handle);
  VectorCopy(ent.origin, r_entorigin);
  VectorSubtract(r_origin, r_entorigin, modelorg);

  switch (handle.type) {
    case ModtypeT.mod_sprite:
      R_DrawSprite();
      break;
    case ModtypeT.mod_alias:
      R_AliasDrawModel();
      break;
    default:
      break;
  }
}

/*
=============
R_BmodelCheckBBox
=============
*/
function R_BmodelCheckBBox(minmaxs: Float32Array): number {
  let clipflags = 0;

  for (let i = 0; i < 4; i++) {
    // generate accept and reject points
    // FIXME: do with fast look-ups or integer tests based on the sign bit
    // of the floating point values
    const clip = view_clipplanes[i];
    const idx = pfrustum_indexes[i];

    const rejectpt: Vec3 = vec3(minmaxs[idx[0]], minmaxs[idx[1]], minmaxs[idx[2]]);

    let d = DotProduct(rejectpt, clip.normal);
    d -= clip.dist;

    if (d <= 0) return BMODEL_FULLY_CLIPPED;

    const acceptpt: Vec3 = vec3(minmaxs[idx[3]], minmaxs[idx[4]], minmaxs[idx[5]]);

    d = DotProduct(acceptpt, clip.normal);
    d -= clip.dist;

    if (d <= 0) clipflags |= 1 << i;
  }

  return clipflags;
}

/*
===================
R_FindTopnode

Find the first node that splits the given box
===================
*/
function R_FindTopnode(mins: Vec3, maxs: Vec3): MnodeOrLeaf | null {
  if (!r_worldmodel || r_worldmodel.nodes.length === 0) return null;

  let node: MnodeOrLeaf | null = r_worldmodel.nodes[0];

  for (;;) {
    if (!node || node.visframe !== r_visframecount) return null; // not visible at all

    if (isMleaf(node)) {
      if (node.contents !== CONTENTS_SOLID) return node; // non-solid leaf: visible, not BSP clipped
      return null; // in solid, so not visible
    }

    const splitplane = node.plane;
    if (!splitplane) return null;
    const sides = BOX_ON_PLANE_SIDE(mins, maxs, splitplane);

    if (sides === 3) return node; // this is the splitter

    // not split yet; recurse down the contacted side
    node = sides & 1 ? node.children[0] : node.children[1];
  }
}

/*
=============
RotatedBBox

Returns an axially aligned box that contains the input box at the given rotation
=============
*/
function RotatedBBox(mins: Vec3, maxs: Vec3, angles: Vec3, tmins: Vec3, tmaxs: Vec3): void {
  if (!angles[0] && !angles[1] && !angles[2]) {
    VectorCopy(mins, tmins);
    VectorCopy(maxs, tmaxs);
    return;
  }

  for (let i = 0; i < 3; i++) {
    tmins[i] = 99999;
    tmaxs[i] = -99999;
  }

  const forward: Vec3 = vec3();
  const right: Vec3 = vec3();
  const up: Vec3 = vec3();
  AngleVectors(angles, forward, right, up);

  const tmp: Vec3 = vec3();
  const v: Vec3 = vec3();

  for (let i = 0; i < 8; i++) {
    tmp[0] = i & 1 ? mins[0] : maxs[0];
    tmp[1] = i & 2 ? mins[1] : maxs[1];
    tmp[2] = i & 4 ? mins[2] : maxs[2];

    VectorScale(forward, tmp[0], v);
    VectorMA(v, -tmp[1], right, v);
    VectorMA(v, tmp[2], up, v);

    for (let j = 0; j < 3; j++) {
      if (v[j] < tmins[j]) tmins[j] = v[j];
      if (v[j] > tmaxs[j]) tmaxs[j] = v[j];
    }
  }
}

/*
=============
R_DrawBEntitiesOnList
=============
*/
function R_DrawBEntitiesOnList(): void {
  if (!(rCvars.r_drawentities && rCvars.r_drawentities.value)) return;

  const oldorigin: Vec3 = vec3();
  VectorCopy(modelorg, oldorigin);
  SetInsubmodel(true);
  SetDlightFrameCount(r_framecount);

  const minmaxs = new Float32Array(6);
  const mins: Vec3 = vec3();
  const maxs: Vec3 = vec3();

  for (let i = 0; i < r_newrefdef.num_entities; i++) {
    const ent = r_newrefdef.entities[i];
    SetCurrentEntity(ent);
    const handle = ent.model;
    if (handle === null || !(handle instanceof ModelT)) continue;
    SetCurrentModel(handle);
    if (handle.nummodelsurfaces === 0) continue; // clip brush only
    if (ent.flags & RF_BEAM) continue;
    if (handle.type !== ModtypeT.mod_brush) continue;

    // see if the bounding box lets us trivially reject, also sets
    // trivial accept status
    RotatedBBox(handle.mins, handle.maxs, ent.angles, mins, maxs);
    for (let j = 0; j < 3; j++) {
      minmaxs[j] = mins[j] + ent.origin[j];
      minmaxs[3 + j] = maxs[j] + ent.origin[j];
    }

    const clipflags = R_BmodelCheckBBox(minmaxs);
    if (clipflags === BMODEL_FULLY_CLIPPED) continue; // off the edge of the screen

    const topnode = R_FindTopnode(minmaxs.subarray(0, 3), minmaxs.subarray(3, 6));
    if (!topnode) continue; // no part in a visible leaf

    VectorCopy(ent.origin, r_entorigin);
    VectorSubtract(r_origin, r_entorigin, modelorg);

    // FIXME: stop transforming twice
    R_RotateBmodel();

    // calculate dynamic lighting for bmodel
    R_PushDlights(handle);

    if (!isMleaf(topnode)) {
      // not a leaf; has to be clipped to the world BSP
      SetClipflags(clipflags);
      R_DrawSolidClippedSubmodelPolygons(handle, topnode);
    } else {
      // falls entirely in one leaf, so we just put all the
      // edges in the edge list and let 1/z sorting handle
      // drawing order
      R_DrawSubmodelPolygons(handle, clipflags, topnode);
    }

    // put back world rotation and frustum clipping
    // FIXME: R_RotateBmodel should just work off base_vxx
    VectorCopy(base_vpn, vpn);
    VectorCopy(base_vup, vup);
    VectorCopy(base_vright, vright);
    VectorCopy(oldorigin, modelorg);
    R_TransformFrustum();
  }

  SetInsubmodel(false);
}

/*
================
R_EdgeDrawing
================
*/
function R_EdgeDrawing(): void {
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) return;

  if (auxedges !== null) {
    SetEdges(auxedges);
  } else {
    if (stackEdges.length < r_numallocatededges) stackEdges = allocEdges(r_numallocatededges);
    SetEdges(stackEdges);
  }

  if (r_surfsonstack) {
    if (stackSurfaces.length < r_cnumsurfs + 1) stackSurfaces = allocSurfaces(r_cnumsurfs);
    SetSurfaces(stackSurfaces);
    SetSurfaceP(0);
    SetSurfMax(r_cnumsurfs);
    R_SurfacePatch();
  }

  R_BeginEdgeFrame();

  R_RenderWorld();

  R_DrawBEntitiesOnList();

  R_ScanEdges();
}

//=======================================================================

/*
=============
R_CalcPalette

=============
*/
let r_calcPaletteModified = false;
function R_CalcPalette(): void {
  const alpha = r_newrefdef.blend[3];
  if (alpha <= 0) {
    if (r_calcPaletteModified) {
      // set back to default
      r_calcPaletteModified = false;
      R_GammaCorrectAndSetPalette(new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength));
    }
    return;
  }

  r_calcPaletteModified = true;
  const a = alpha > 1 ? 1 : alpha;

  const premult: Vec3 = vec3(r_newrefdef.blend[0] * a * 255, r_newrefdef.blend[1] * a * 255, r_newrefdef.blend[2] * a * 255);

  const one_minus_alpha = 1.0 - a;

  const inBytes = new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);
  const palette = new Uint8Array(1024);

  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 3; j++) {
      let v = premult[j] + one_minus_alpha * inBytes[i * 4 + j];
      if (v > 255) v = 255;
      palette[i * 4 + j] = v;
    }
    palette[i * 4 + 3] = 255;
  }

  R_GammaCorrectAndSetPalette(palette);
}

//=======================================================================

function R_SetLightLevel(): void {
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL || !(rCvars.r_drawentities && rCvars.r_drawentities.value) || !currententity) {
    if (rCvars.r_lightlevel) rCvars.r_lightlevel.value = 150.0;
    return;
  }

  // save off light value for server to look at (BIG HACK!)
  const light: Vec3 = vec3();
  R_LightPoint(r_newrefdef.vieworg, light);
  if (rCvars.r_lightlevel) rCvars.r_lightlevel.value = 150.0 * light[0];
}

/*
@@@@@@@@@@@@@@@@
R_RenderFrame

@@@@@@@@@@@@@@@@
*/
function copyRefdef(dst: RefdefT, src: RefdefT): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.width = src.width;
  dst.height = src.height;
  dst.fov_x = src.fov_x;
  dst.fov_y = src.fov_y;
  VectorCopy(src.vieworg, dst.vieworg);
  VectorCopy(src.viewangles, dst.viewangles);
  dst.blend.set(src.blend);
  dst.time = src.time;
  dst.rdflags = src.rdflags;
  dst.areabits = src.areabits;
  dst.lightstyles = src.lightstyles;
  dst.num_entities = src.num_entities;
  dst.entities = src.entities;
  dst.num_dlights = src.num_dlights;
  dst.dlights = src.dlights;
  dst.num_particles = src.num_particles;
  dst.particles = src.particles;
}

export function R_RenderFrame(fd: RefdefT): void {
  copyRefdef(r_newrefdef, fd);

  if (!r_worldmodel && !(r_newrefdef.rdflags & RDF_NOWORLDMODEL)) {
    ri.Sys_Error(ERR_FATAL, "R_RenderView: NULL worldmodel");
  }

  VectorCopy(fd.vieworg, r_refdef.vieworg);
  VectorCopy(fd.viewangles, r_refdef.viewangles);

  if ((rCvars.r_speeds && rCvars.r_speeds.value) || (rCvars.r_dspeeds && rCvars.r_dspeeds.value)) {
    SetTimeRef(Sys_Milliseconds());
  }

  R_SetupFrame();

  R_MarkLeaves(); // done here so we know if we're in water

  if (r_worldmodel) R_PushDlights(r_worldmodel);

  R_EdgeDrawing();

  R_DrawEntitiesOnList();

  R_DrawParticles();

  R_DrawAlphaSurfaces();

  R_SetLightLevel();

  if (r_dowarp) D_WarpScreen();

  R_CalcPalette();

  if (rCvars.sw_aliasstats && rCvars.sw_aliasstats.value) R_PrintAliasStats();

  if (rCvars.r_speeds && rCvars.r_speeds.value) R_PrintTimes();

  if (rCvars.r_dspeeds && rCvars.r_dspeeds.value) R_PrintDSpeeds();
}

/*
** R_InitGraphics
*/
function R_InitGraphics(width: number, height: number): void {
  vid.width = width;
  vid.height = height;

  // free z buffer -- r_scan.ts's D_SetZBuffer replaces the malloc/free pair

  D_SetZBuffer(new Int16Array(width * height), width);

  R_InitCaches();

  R_GammaCorrectAndSetPalette(new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength));
}

/*
** R_BeginFrame
*/
export function R_BeginFrame(camera_separation: number): void {
  void camera_separation;

  // rebuild the gamma correction palette if necessary
  if (rCvars.vid_gamma && rCvars.vid_gamma.modified) {
    Draw_BuildGammaTable();
    R_GammaCorrectAndSetPalette(new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength));

    rCvars.vid_gamma.modified = false;
  }

  while ((rCvars.sw_mode && rCvars.sw_mode.modified) || (rCvars.vid_fullscreen && rCvars.vid_fullscreen.modified) || (rCvars.vid_scale && rCvars.vid_scale.modified)) {
    const modeVal = rCvars.sw_mode ? rCvars.sw_mode.value : 0;
    const fsVal = rCvars.vid_fullscreen ? rCvars.vid_fullscreen.value !== 0 : false;

    const { pwidth, pheight, rserr: err } = SWimp_SetMode(vid.width, vid.height, modeVal, fsVal);

    if (err === RserrT.rserr_ok) {
      vid.width = pwidth;
      vid.height = pheight;
      R_InitGraphics(vid.width, vid.height);

      sw_state.prev_mode = modeVal;
      if (rCvars.vid_fullscreen) rCvars.vid_fullscreen.modified = false;
      if (rCvars.sw_mode) rCvars.sw_mode.modified = false;
      if (rCvars.vid_scale) rCvars.vid_scale.modified = false;
    } else if (err === RserrT.rserr_invalid_mode) {
      // clear the flags BEFORE retrying prev_mode: Cvar_SetValue re-marks
      // sw_mode modified only when the value actually changes, so a retry
      // happens for a different prev_mode while prev_mode === modeVal (the
      // C original's latent forever-loop) exits with the failure reported.
      if (rCvars.sw_mode) rCvars.sw_mode.modified = false;
      if (rCvars.vid_fullscreen) rCvars.vid_fullscreen.modified = false;
      if (rCvars.vid_scale) rCvars.vid_scale.modified = false;
      ri.Cvar_SetValue("sw_mode", sw_state.prev_mode);
      ri.Con_Printf(PRINT_ALL, "ref_soft::R_BeginFrame() - could not set mode\n");
    } else if (err === RserrT.rserr_invalid_fullscreen) {
      vid.width = pwidth;
      vid.height = pheight;
      R_InitGraphics(vid.width, vid.height);

      ri.Cvar_SetValue("vid_fullscreen", 0);
      ri.Con_Printf(PRINT_ALL, "ref_soft::R_BeginFrame() - fullscreen unavailable in this mode\n");
      sw_state.prev_mode = modeVal;
    } else {
      ri.Sys_Error(ERR_FATAL, "ref_soft::R_BeginFrame() - catastrophic mode change failure\n");
    }
  }
}

/*
** R_GammaCorrectAndSetPalette
*/
export function R_GammaCorrectAndSetPalette(palette: Uint8Array): void {
  for (let i = 0; i < 256; i++) {
    sw_state.currentpalette[i * 4 + 0] = sw_state.gammatable[palette[i * 4 + 0]];
    sw_state.currentpalette[i * 4 + 1] = sw_state.gammatable[palette[i * 4 + 1]];
    sw_state.currentpalette[i * 4 + 2] = sw_state.gammatable[palette[i * 4 + 2]];
  }

  SWimp_SetPalette(sw_state.currentpalette);
}

/*
** R_CinematicSetPalette
*/
export function R_CinematicSetPalette(palette: Uint8Array | null): void {
  // clear screen to black to avoid any palette flash
  const w = Math.abs(vid.rowbytes) >> 2;
  const view = new Int32Array(vid.buffer.buffer, vid.buffer.byteOffset, (vid.buffer.byteLength / 4) | 0);
  for (let i = 0; i < vid.height; i++) {
    const rowStart = ((i * vid.rowbytes) / 4) | 0;
    for (let j = 0; j < w; j++) view[rowStart + j] = 0;
  }
  // flush it to the screen
  SWimp_EndFrame();

  if (palette) {
    const palette32 = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) {
      palette32[i * 4 + 0] = palette[i * 3 + 0];
      palette32[i * 4 + 1] = palette[i * 3 + 1];
      palette32[i * 4 + 2] = palette[i * 3 + 2];
      palette32[i * 4 + 3] = 0xff;
    }

    R_GammaCorrectAndSetPalette(palette32);
  } else {
    R_GammaCorrectAndSetPalette(new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength));
  }
}

/*
================
Draw_BuildGammaTable
================
*/
function Draw_BuildGammaTable(): void {
  const g = rCvars.vid_gamma ? rCvars.vid_gamma.value : 1.0;

  if (g === 1.0) {
    for (let i = 0; i < 256; i++) sw_state.gammatable[i] = i;
    return;
  }

  for (let i = 0; i < 256; i++) {
    let inf = (255 * Math.pow((i + 0.5) / 255.5, g) + 0.5) | 0;
    if (inf < 0) inf = 0;
    if (inf > 255) inf = 255;
    sw_state.gammatable[i] = inf;
  }
}

/*
** R_DrawBeam
*/
const NUM_BEAM_SEGS = 6;

export function R_DrawBeam(e: EntityT): void {
  const oldorigin: Vec3 = vec3(e.oldorigin[0], e.oldorigin[1], e.oldorigin[2]);
  const origin: Vec3 = vec3(e.origin[0], e.origin[1], e.origin[2]);

  const direction: Vec3 = vec3(oldorigin[0] - origin[0], oldorigin[1] - origin[1], oldorigin[2] - origin[2]);
  const normalized_direction: Vec3 = vec3(direction[0], direction[1], direction[2]);

  if (VectorNormalize(normalized_direction) === 0) return;

  const perpvec: Vec3 = vec3();
  PerpendicularVector(perpvec, normalized_direction);
  VectorScale(perpvec, e.frame / 2, perpvec);

  const start_points: Vec3[] = [];
  const end_points: Vec3[] = [];

  for (let i = 0; i < NUM_BEAM_SEGS; i++) {
    const sp: Vec3 = vec3();
    RotatePointAroundVector(sp, normalized_direction, perpvec, (360.0 / NUM_BEAM_SEGS) * i);
    const spOrigin: Vec3 = vec3();
    VectorCopy(sp, spOrigin);
    spOrigin[0] += origin[0];
    spOrigin[1] += origin[1];
    spOrigin[2] += origin[2];
    start_points.push(spOrigin);

    const ep: Vec3 = vec3(spOrigin[0] + direction[0], spOrigin[1] + direction[1], spOrigin[2] + direction[2]);
    end_points.push(ep);
  }

  for (let i = 0; i < NUM_BEAM_SEGS; i++) {
    R_IMFlatShadedQuad(start_points[i], end_points[i], end_points[(i + 1) % NUM_BEAM_SEGS], start_points[(i + 1) % NUM_BEAM_SEGS], e.skinnum & 0xff, e.alpha);
  }
}

//===================================================================

/*
============
R_SetSky
============
*/
// 3dstudio environment map names
const suf = fixedLength("suf", 6, ["rt", "bk", "lf", "ft", "up", "dn"]);
const r_skysideimage = fixedLength("r_skysideimage", 6, [5, 2, 4, 1, 0, 3]);

export function R_SetSky(name: string, rotate: number, axis: Vec3): void {
  skyname = name;
  skyrotate = rotate;
  VectorCopy(axis, skyaxis);

  for (let i = 0; i < 6; i++) {
    const pathname = Com_sprintf("env/%s%s.pcx", skyname, suf[r_skysideimage[i]]);
    r_skytexinfo[i].image = R_FindImage(pathname, ImagetypeT.it_sky);
  }
}

/*
===============
Draw_GetPalette
===============
*/
export function Draw_GetPalette(): void {
  const { pic, palette } = LoadPCX("pics/colormap.pcx");
  if (!pic) {
    ri.Sys_Error(ERR_FATAL, "Couldn't load pics/colormap.pcx");
  }
  vid.colormap = pic;
  vid.alphamap = pic && pic.length >= 64 * 256 + 64 * 256 ? pic.subarray(64 * 256) : pic;

  if (palette) {
    for (let i = 0; i < 256; i++) {
      const r = palette[i * 3 + 0];
      const g = palette[i * 3 + 1];
      const b = palette[i * 3 + 2];
      const bytes = new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);
      bytes[i * 4 + 0] = r;
      bytes[i * 4 + 1] = g;
      bytes[i * 4 + 2] = b;
      bytes[i * 4 + 3] = 0;
    }
  }
}

/*
@@@@@@@@@@@@@@@@@@@@@
GetRefAPI

@@@@@@@@@@@@@@@@@@@@@
*/
export function GetRefAPI(imp: RefImports): RefExports {
  SetRefImports(imp);

  return {
    api_version: API_VERSION,

    Init: (hinstance: unknown, wndproc: unknown) => R_Init(hinstance, wndproc),
    Shutdown: () => R_Shutdown(),

    BeginRegistration: (map: string) => R_BeginRegistration(map),
    RegisterModel: (name: string) => R_RegisterModel(name),
    RegisterSkin: (name: string) => R_RegisterSkin(name),
    RegisterPic: (name: string) => Draw_FindPic(name),
    RegisterRawPic: (name: string, pixels: Uint8Array, width: number, height: number) => R_RegisterRawPic(name, pixels, width, height),
    SetSky: (name: string, rotate: number, axis: Vec3) => R_SetSky(name, rotate, axis),
    EndRegistration: () => R_EndRegistration(),

    RenderFrame: (fd: RefdefT) => R_RenderFrame(fd),

    // No GL2+ program-object path exists in the software renderer (task
    // #25 is ref_gl-only per its brief) -- always false, matching a driver
    // with no GL2 program objects at all.
    SupportsPerPixelLighting: () => false,

    DrawGetPicSize: (name: string) => Draw_GetPicSize(name),
    DrawPic: (x: number, y: number, name: string) => Draw_Pic(x, y, name),
    DrawStretchPic: (x: number, y: number, w: number, h: number, name: string) => Draw_StretchPic(x, y, w, h, name),
    DrawColorPic: (x: number, y: number, w: number, h: number, name: string, color: DrawColorT) => Draw_ColorPic(x, y, w, h, name, color),
    DrawStretchPicRegion: (x: number, y: number, w: number, h: number, name: string, srcX: number, srcY: number, srcW: number, srcH: number, color: DrawColorT) =>
      Draw_StretchPicRegion(x, y, w, h, name, srcX, srcY, srcW, srcH, color),
    DrawChar: (x: number, y: number, c: number) => Draw_Char(x, y, c),
    DrawTileClear: (x: number, y: number, w: number, h: number, name: string) => Draw_TileClear(x, y, w, h, name),
    DrawFill: (x: number, y: number, w: number, h: number, c: number) => Draw_Fill(x, y, w, h, c),
    DrawFadeScreen: () => Draw_FadeScreen(),

    DrawStretchRaw: (x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array) => Draw_StretchRaw(x, y, w, h, cols, rows, data),

    CinematicSetPalette: (palette: Uint8Array | null) => R_CinematicSetPalette(palette),
    // Documented no-op: animated-GIF frame selection is GL-only by ruling
    // (see qcommon/gif.ts's own header comment and ref.ts's
    // RefExports.SetGifBeatSeconds doc comment). This renderer's own GIF
    // loader (r_image.ts's LoadGIFQuantized) only ever decodes and
    // quantizes the FIRST composited frame -- there is no second frame for
    // this renderer to ever pick, so there is nothing for this call to do.
    SetGifBeatSeconds: () => {},
    BeginFrame: (camera_separation: number) => R_BeginFrame(camera_separation),
    EndFrame: () => SWimp_EndFrame(),

    AppActivate: (activate: boolean) => SWimp_AppActivate(activate),
  };
}
