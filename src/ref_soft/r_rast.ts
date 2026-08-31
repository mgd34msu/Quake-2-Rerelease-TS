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

Ported from ref_soft/r_rast.c (GNU GPL v2 or later). `#if !id386` is the only
build of R_EmitEdge/R_ClipEdge that ever existed as portable C (the `#else`
half of that guard is x86 `__declspec(naked)` asm and is dropped per
PORTING.md's "#ifdef id386 ... take the portable path"). `R_EmitSkyBox`/
`R_EmitCachedEdge` are static internal helpers (not declared in r_local.h)
and stay unexported, matching this file's own former header comment.

`c_faceclip`/`r_polycount` are r_rast.c file-scope counters that r_local.ts
never declared; they stay module state here. The r_local.h externs this file
writes -- `surface_p`/`edge_p`/`r_outofsurfaces`/`r_outofedges`/
`r_alpha_surfaces` -- are owned by r_local.ts and reassigned through its
setters, since an imported `let` binding is read-only to the importer.

`r_currentkey` (real home r_edge.c) and `r_currentbkey` (real home r_bsp.c)
are read and written from both this file and r_bsp.ts, so they are ported as
the `rKey` holder object below: property mutation on a shared object crosses
module boundaries where rebinding a `let` does not.

`r_skytexinfo` is r_local.h's `sky_texinfo`, exported from here (R_SetSky in
r_main.ts fills in the images R_InitSkyBox/R_RenderFace draw with).
`loadmodel` is r_model.c's own global, read by R_InitSkyBox and resolved
lazily from r_model.ts per PORTING.md's import-cycle rule -- r_model.ts
already resolves this module to make the R_InitSkyBox call.
*/

import { type Vec3, vec3, DotProduct, VectorSubtract, VectorCopy } from "../shared/math";
import { fixedLength } from "../shared/fixed";
import { CplaneT, SURF_SKY, SURF_TRANS33, SURF_TRANS66 } from "../shared/q_shared";
import {
  type BedgeT,
  type ClipplaneT,
  r_refdef,
  vpn,
  vright,
  vup,
  modelorg,
  r_origin,
  view_clipplanes,
  newedges,
  removeedges,
  r_edges,
  edge_max,
  surfaces,
  surf_max,
  r_framecount,
  insubmodel,
  r_clipflags,
  currentmodel,
  currententity,
  r_pcurrentvertbase,
  surface_p,
  edge_p,
  r_outofsurfaces,
  r_outofedges,
  r_alpha_surfaces,
  SetSurfaceP,
  SetEdgeP,
  SetOutOfSurfaces,
  SetOutOfEdges,
  SetAlphaSurfaces,
  NEAR_CLIP,
  xscale,
  yscale,
  xcenter,
  ycenter,
  xscaleinv,
  yscaleinv,
} from "./r_local";
import { MedgeT, MsurfaceT, MtexinfoT, type MplaneT, MvertexT, SURF_DRAWSKYBOX, SURF_EXTENTS_SKIP } from "./r_model";
import type * as ModelModule from "./r_model";

// import-cycle rule (PORTING.md): r_model.ts statically resolves this module
// to call R_InitSkyBox, so `loadmodel` is read back lazily rather than with a
// static import the other way.
function modelMod(): typeof ModelModule {
  return require("./r_model");
}

//===========================================================================
// r_rast.c's own file-scope statics (not declared in r_local.h -- see this
// file's header comment for the ones that *are* r_local.h externs).

let cacheoffset = 0;

export let c_faceclip = 0;
export let r_polycount = 0;


// r_currentkey's real home is r_edge.c, r_currentbkey's is r_bsp.c; neither
// is exported by r_local.ts today (see header comment) -- shared here as a
// mutable holder object so r_bsp.ts can read/write the same counters.
export const rKey = {
  current: 0, // r_currentkey
  currentB: 0, // r_currentbkey
};

let r_pedge: MedgeT | null = null;

let r_leftclipped = false;
let r_rightclipped = false;
let makeleftedge = false;
let makerightedge = false;
let r_nearzionly = false;
let r_lastvertvalid = false;
let r_emitted = 0;
let r_nearzi = 0;
let r_u1 = 0;
let r_v1 = 0;
let r_lzi1 = 0;
let r_ceilv1 = 0;

// exposed purely for test introspection (R_ClipEdge's hand-computed
// intersection point, per this unit's brief).
export let r_leftenter = new MvertexT();
export let r_leftexit = new MvertexT();
export let r_rightenter = new MvertexT();
export let r_rightexit = new MvertexT();

// !!! if these are changed, they must be changed in asm_draw.h too !!!
const FULLY_CLIPPED_CACHED = 0x80000000;
const FRAMECOUNT_MASK = 0x7fffffff;

function TransformVector(inV: Vec3, out: Vec3): void {
  out[0] = DotProduct(inV, vright);
  out[1] = DotProduct(inV, vup);
  out[2] = DotProduct(inV, vpn);
}

//===========================================================================
// sky box (r_rast.c's own file-scope statics)

const skybox_planes = fixedLength("skybox_planes", 12, [2, -128, 0, -128, 2, 128, 1, 128, 0, 128, 1, -128]);
// ported verbatim: 1-based, signed-for-winding-direction indices
const box_surfedges = fixedLength(
  "box_surfedges",
  24,
  [1, 2, 3, 4, -1, 5, 6, 7, 8, 9, -6, 10, -2, -7, -9, 11, 12, -3, -11, -8, -12, -10, -5, -4],
);
const box_edges = fixedLength("box_edges", 24, [1, 2, 2, 3, 3, 4, 4, 1, 1, 5, 5, 6, 6, 2, 7, 8, 8, 6, 5, 7, 8, 3, 7, 4]);
const box_faces = fixedLength("box_faces", 6, [0, 0, 2, 2, 2, 0]);
const box_vecs: [Vec3, Vec3][] = fixedLength("box_vecs", 6, [
  [vec3(0, -1, 0), vec3(-1, 0, 0)],
  [vec3(0, 1, 0), vec3(0, 0, -1)],
  [vec3(0, -1, 0), vec3(1, 0, 0)],
  [vec3(1, 0, 0), vec3(0, 0, -1)],
  [vec3(0, -1, 0), vec3(0, 0, -1)],
  [vec3(-1, 0, 0), vec3(0, 0, -1)],
]);
const box_verts: Vec3[] = fixedLength("box_verts", 8, [
  vec3(-1, -1, -1),
  vec3(-1, 1, -1),
  vec3(1, 1, -1),
  vec3(1, -1, -1),
  vec3(-1, -1, 1),
  vec3(-1, 1, 1),
  vec3(1, -1, 1),
  vec3(1, 1, 1),
]);

let r_skyframe = -1;
let r_skyfaces: MsurfaceT[] = [];
const r_skyplanes: MplaneT[] = [new CplaneT(), new CplaneT(), new CplaneT(), new CplaneT(), new CplaneT(), new CplaneT()];
// r_local.h's `sky_texinfo` is this same storage (R_SetSky, r_main.ts, fills
// in the images); exported so that write lands on what R_RenderFace draws.
export const r_skytexinfo: MtexinfoT[] = [new MtexinfoT(), new MtexinfoT(), new MtexinfoT(), new MtexinfoT(), new MtexinfoT(), new MtexinfoT()];
let r_skyverts: MvertexT[] = [];
let r_skyedges: MedgeT[] = [];

/*
================
R_InitSkyBox
================
*/
export function R_InitSkyBox(): void {
  const loadmodel = modelMod().loadmodel;

  r_skyfaces = [];
  for (let i = 0; i < 6; i++) r_skyfaces.push(new MsurfaceT());
  loadmodel.surfaces.push(...r_skyfaces);
  loadmodel.numsurfaces += 6;

  r_skyverts = [];
  for (let i = 0; i < 8; i++) r_skyverts.push(new MvertexT());
  loadmodel.vertexes.push(...r_skyverts);
  loadmodel.numvertexes += 8;

  r_skyedges = [];
  for (let i = 0; i < 12; i++) r_skyedges.push(new MedgeT());
  loadmodel.edges.push(...r_skyedges);
  loadmodel.numedges += 12;

  for (let i = 0; i < 24; i++) loadmodel.surfedges.push(0);
  loadmodel.numsurfedges += 24;

  // Vanilla's R_InitSkyBox (ref_soft/r_rast.c:117-129) appends its 6
  // faces/8 verts/12 edges/24 surfedges via POINTER ARITHMETIC into slack
  // space at the tail of loadmodel->{surfaces,vertexes,edges,surfedges} --
  // Hunk-allocated up front at a fixed MAX_MAP_FACES/VERTS/EDGES/SURFEDGES
  // size regardless of how many the BSP lumps actually used, with the
  // Sys_Error below as a genuine bounds check against overrunning that
  // fixed allocation on a real classic (16-bit-index, <=65536-vert) map
  // already sized right up to those constants.
  //
  // This port's loadmodel.{surfaces,vertexes,edges,surfedges} are plain
  // growable arrays (`.push()` above, r_model.ts's Mod_Load* throughout) --
  // there is no fixed-size allocation for this check to guard, so it can
  // never fire for a real overrun; it only reproduces vanilla's *numeric*
  // threshold, which retail's QBSP-extended-format "Call of the Machine"
  // maps are specifically allowed to exceed elsewhere in this same loader
  // (see qcommon/qfiles.ts's header comment: MAX_MAP_VERTS/FACES/EDGES are
  // "no longer enforced as a load-rejection cap" anywhere else in this
  // codebase, replaced by cross-reference bounds checks the way q2repro's
  // BSP_Load does -- cmodel.ts/gl_model.ts/r_model.ts already dropped the
  // equivalent whole-map rejection). Verified real: maps/mgu4m2.bsp
  // (78458 verts / 72903 faces / 152341 edges) and maps/mguhub.bsp (79538 /
  // 72159 / 153281) both legitimately exceed MAX_MAP_VERTS=65536 /
  // MAX_MAP_FACES=65536 / MAX_MAP_EDGES=128000 and already load everywhere
  // else in this same r_model.ts pipeline; only this now-vestigial count
  // check (a leftover of a buffer that doesn't exist in this port) rejected
  // them, as a whole-map ERR_DROP no less -- the same failure mode the
  // Mod_LoadBrushModel graceful-refusal blocks above (SURF_EXTENTS_SKIP,
  // the DECOUPLED_LM fullbright fallback) were written to eliminate. Dropped
  // rather than "grown" to a new numeric bound: every possible replacement
  // constant would be exactly as arbitrary as this one, since nothing
  // downstream depends on one.

  for (let i = 0; i < 6; i++) {
    const face = r_skyfaces[i];
    const plane = r_skyplanes[i];
    plane.normal[skybox_planes[i * 2]] = 1;
    plane.dist = skybox_planes[i * 2 + 1];

    VectorCopy(box_vecs[i][0], r_skytexinfo[i].vecs[0]);
    VectorCopy(box_vecs[i][1], r_skytexinfo[i].vecs[1]);

    face.plane = plane;
    face.numedges = 4;
    face.flags = box_faces[i] | SURF_DRAWSKYBOX;
    face.firstedge = loadmodel.numsurfedges - 24 + i * 4;
    face.texinfo = r_skytexinfo[i];
    face.texturemins[0] = -128;
    face.texturemins[1] = -128;
    face.extents[0] = 256;
    face.extents[1] = 256;
  }

  for (let i = 0; i < 24; i++) {
    const value = box_surfedges[i] > 0 ? loadmodel.numedges - 13 + box_surfedges[i] : -(loadmodel.numedges - 13 + -box_surfedges[i]);
    loadmodel.surfedges[loadmodel.numsurfedges - 24 + i] = value;
  }

  for (let i = 0; i < 12; i++) {
    r_skyedges[i].v[0] = loadmodel.numvertexes - 9 + box_edges[i * 2 + 0];
    r_skyedges[i].v[1] = loadmodel.numvertexes - 9 + box_edges[i * 2 + 1];
    r_skyedges[i].cachededgeoffset = 0;
  }
}

/*
================
R_EmitSkyBox
================
*/
function R_EmitSkyBox(): void {
  if (insubmodel) return; // submodels should never have skies
  if (r_skyframe === r_framecount) return; // already set this frame

  r_skyframe = r_framecount;

  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 3; j++) {
      r_skyverts[i].position[j] = r_origin[j] + box_verts[i][j] * 128;
    }
  }

  for (let i = 0; i < 6; i++) {
    r_skyplanes[i].dist = skybox_planes[i * 2 + 1] > 0 ? r_origin[skybox_planes[i * 2]] + 128 : r_origin[skybox_planes[i * 2]] - 128;
  }

  for (let i = 0; i < 6; i++) {
    r_skytexinfo[i].vecs[0][3] = -DotProduct(r_origin, r_skytexinfo[i].vecs[0]);
    r_skytexinfo[i].vecs[1][3] = -DotProduct(r_origin, r_skytexinfo[i].vecs[1]);
  }

  const oldkey = rKey.current;
  rKey.current = 0x7ffffff0;
  for (let i = 0; i < 6; i++) {
    R_RenderFace(r_skyfaces[i], 15);
  }
  rKey.current = oldkey; // bsp sorting order
}

/*
================
R_EmitEdge
================
*/
export function R_EmitEdge(pv0: MvertexT, pv1: MvertexT): void {
  let u0: number;
  let v0: number;
  let lzi0: number;
  let ceilv0: number;

  if (r_lastvertvalid) {
    u0 = r_u1;
    v0 = r_v1;
    lzi0 = r_lzi1;
    ceilv0 = r_ceilv1;
  } else {
    const local0 = vec3();
    const transformed0 = vec3();
    VectorSubtract(pv0.position, modelorg, local0);
    TransformVector(local0, transformed0);

    if (transformed0[2] < NEAR_CLIP) transformed0[2] = NEAR_CLIP;

    lzi0 = 1.0 / transformed0[2];

    let scale = xscale * lzi0;
    u0 = xcenter + scale * transformed0[0];
    if (u0 < r_refdef.fvrectx_adj) u0 = r_refdef.fvrectx_adj;
    if (u0 > r_refdef.fvrectright_adj) u0 = r_refdef.fvrectright_adj;

    scale = yscale * lzi0;
    v0 = ycenter - scale * transformed0[1];
    if (v0 < r_refdef.fvrecty_adj) v0 = r_refdef.fvrecty_adj;
    if (v0 > r_refdef.fvrectbottom_adj) v0 = r_refdef.fvrectbottom_adj;

    ceilv0 = Math.ceil(v0);
  }

  const local1 = vec3();
  const transformed1 = vec3();
  VectorSubtract(pv1.position, modelorg, local1);
  TransformVector(local1, transformed1);

  if (transformed1[2] < NEAR_CLIP) transformed1[2] = NEAR_CLIP;

  r_lzi1 = 1.0 / transformed1[2];

  let scale = xscale * r_lzi1;
  r_u1 = xcenter + scale * transformed1[0];
  if (r_u1 < r_refdef.fvrectx_adj) r_u1 = r_refdef.fvrectx_adj;
  if (r_u1 > r_refdef.fvrectright_adj) r_u1 = r_refdef.fvrectright_adj;

  scale = yscale * r_lzi1;
  r_v1 = ycenter - scale * transformed1[1];
  if (r_v1 < r_refdef.fvrecty_adj) r_v1 = r_refdef.fvrecty_adj;
  if (r_v1 > r_refdef.fvrectbottom_adj) r_v1 = r_refdef.fvrectbottom_adj;

  if (r_lzi1 > lzi0) lzi0 = r_lzi1;

  if (lzi0 > r_nearzi) r_nearzi = lzi0; // for mipmap finding

  // for right edges, all we want is the effect on 1/z
  if (r_nearzionly) return;

  r_emitted = 1;

  r_ceilv1 = Math.ceil(r_v1);

  // create the edge
  if (ceilv0 === r_ceilv1) {
    // we cache unclipped horizontal edges as fully clipped
    if (cacheoffset !== 0x7fffffff) {
      cacheoffset = FULLY_CLIPPED_CACHED | (r_framecount & FRAMECOUNT_MASK);
    }
    return; // horizontal edge
  }

  if (!r_edges) throw new Error("R_EmitEdge: r_edges not initialized");

  const side = ceilv0 > r_ceilv1 ? 1 : 0;

  const edge = r_edges[edge_p];
  SetEdgeP(edge_p + 1);

  edge.owner = r_pedge;
  edge.nearzi = lzi0;

  let v: number;
  let v2: number;
  let u: number;
  let u_step: number;

  if (side === 0) {
    // trailing edge (go from p1 to p2)
    v = ceilv0;
    v2 = r_ceilv1 - 1;

    edge.surfs[0] = surface_p;
    edge.surfs[1] = 0;

    u_step = (r_u1 - u0) / (r_v1 - v0);
    u = u0 + (v - v0) * u_step;
  } else {
    // leading edge (go from p2 to p1)
    v2 = ceilv0 - 1;
    v = r_ceilv1;

    edge.surfs[0] = 0;
    edge.surfs[1] = surface_p;

    u_step = (u0 - r_u1) / (v0 - r_v1);
    u = r_u1 + (v - r_v1) * u_step;
  }

  edge.u_step = u_step * 0x100000;
  edge.u = u * 0x100000 + 0xfffff;

  // we need to do this to avoid stepping off the edges if a very nearly
  // horizontal edge is less than epsilon above a scan, and numeric error
  // causes it to incorrectly extend to the scan, and the extension of the
  // line goes off the edge of the screen
  if (edge.u < r_refdef.vrect_x_adj_shift20) edge.u = r_refdef.vrect_x_adj_shift20;
  if (edge.u > r_refdef.vrectright_adj_shift20) edge.u = r_refdef.vrectright_adj_shift20;

  // sort the edge in normally
  let u_check = edge.u;
  if (edge.surfs[0]) u_check++; // sort trailers after leaders

  const head = newedges[v];
  if (!head || head.u >= u_check) {
    edge.next = head;
    newedges[v] = edge;
  } else {
    let pcheck = head;
    while (pcheck.next && pcheck.next.u < u_check) pcheck = pcheck.next;
    edge.next = pcheck.next;
    pcheck.next = edge;
  }

  edge.nextremove = removeedges[v2];
  removeedges[v2] = edge;
}

/*
================
R_ClipEdge
================
*/
export function R_ClipEdge(pv0: MvertexT, pv1: MvertexT, clip: ClipplaneT | null): void {
  if (clip !== null) {
    let c: ClipplaneT | null = clip;
    do {
      const d0 = DotProduct(pv0.position, c.normal) - c.dist;
      const d1 = DotProduct(pv1.position, c.normal) - c.dist;

      if (d0 >= 0) {
        // point 0 is unclipped
        if (d1 >= 0) {
          // both points are unclipped
          continue;
        }

        // only point 1 is clipped
        // we don't cache clipped edges
        cacheoffset = 0x7fffffff;

        const f = d0 / (d0 - d1);
        const clipvert = new MvertexT();
        clipvert.position[0] = pv0.position[0] + f * (pv1.position[0] - pv0.position[0]);
        clipvert.position[1] = pv0.position[1] + f * (pv1.position[1] - pv0.position[1]);
        clipvert.position[2] = pv0.position[2] + f * (pv1.position[2] - pv0.position[2]);

        if (c.leftedge) {
          r_leftclipped = true;
          r_leftexit = clipvert;
        } else if (c.rightedge) {
          r_rightclipped = true;
          r_rightexit = clipvert;
        }

        R_ClipEdge(pv0, clipvert, c.next);
        return;
      } else {
        // point 0 is clipped
        if (d1 < 0) {
          // both points are clipped
          // we do cache fully clipped edges
          if (!r_leftclipped) {
            cacheoffset = FULLY_CLIPPED_CACHED | (r_framecount & FRAMECOUNT_MASK);
          }
          return;
        }

        // only point 0 is clipped
        r_lastvertvalid = false;

        // we don't cache partially clipped edges
        cacheoffset = 0x7fffffff;

        const f = d0 / (d0 - d1);
        const clipvert = new MvertexT();
        clipvert.position[0] = pv0.position[0] + f * (pv1.position[0] - pv0.position[0]);
        clipvert.position[1] = pv0.position[1] + f * (pv1.position[1] - pv0.position[1]);
        clipvert.position[2] = pv0.position[2] + f * (pv1.position[2] - pv0.position[2]);

        if (c.leftedge) {
          r_leftclipped = true;
          r_leftenter = clipvert;
        } else if (c.rightedge) {
          r_rightclipped = true;
          r_rightenter = clipvert;
        }

        R_ClipEdge(clipvert, pv1, c.next);
        return;
      }
    } while ((c = c.next) !== null);
  }

  // add the edge
  R_EmitEdge(pv0, pv1);
}

/*
================
R_EmitCachedEdge
================
*/
function R_EmitCachedEdge(): void {
  if (!r_edges) throw new Error("R_EmitCachedEdge: r_edges not initialized");
  if (!r_pedge) throw new Error("R_EmitCachedEdge: r_pedge not set");

  const pedge_t = r_edges[r_pedge.cachededgeoffset];

  if (!pedge_t.surfs[0]) {
    pedge_t.surfs[0] = surface_p;
  } else {
    pedge_t.surfs[1] = surface_p;
  }

  if (pedge_t.nearzi > r_nearzi) r_nearzi = pedge_t.nearzi; // for mipmap finding

  r_emitted = 1;
}

/*
================
R_RenderFace
================
*/
export function R_RenderFace(fa: MsurfaceT, clipflags: number): void {
  if (!fa.texinfo) throw new Error("R_RenderFace: surface has no texinfo");

  // This port only -- see r_model.ts's SURF_EXTENTS_SKIP comment: this
  // face's extents exceed the surface cache's real capacity (D_SCAlloc's
  // own hard "bad cache width" limit), so it is never queued for
  // rasterization at all (never reaches D_CacheSurface/D_SolidSurf), the
  // same way SURF_TRANS33/66 below never reaches the edge renderer either.
  if (fa.flags & SURF_EXTENTS_SKIP) return;

  // translucent surfaces are not drawn by the edge renderer
  if (fa.texinfo.flags & (SURF_TRANS33 | SURF_TRANS66)) {
    fa.nextalphasurface = r_alpha_surfaces;
    SetAlphaSurfaces(fa);
    return;
  }

  // sky surfaces encountered in the world will cause the
  // environment box surfaces to be emitted
  if (fa.texinfo.flags & SURF_SKY) {
    R_EmitSkyBox();
    return;
  }

  if (!surfaces) throw new Error("R_RenderFace: surfaces not initialized");

  // skip out if no more surfs
  if (surface_p >= surf_max) {
    SetOutOfSurfaces(r_outofsurfaces + 1);
    return;
  }

  // ditto if not enough edges left, or switch to auxedges if possible
  if (edge_p + fa.numedges + 4 >= edge_max) {
    SetOutOfEdges(r_outofedges + fa.numedges);
    return;
  }

  c_faceclip++;

  // set up clip planes
  let pclip: ClipplaneT | null = null;
  let mask = 0x08;
  for (let i = 3; i >= 0; i--, mask >>= 1) {
    if (clipflags & mask) {
      view_clipplanes[i].next = pclip;
      pclip = view_clipplanes[i];
    }
  }

  if (!currentmodel) throw new Error("R_RenderFace: currentmodel not set");
  if (!r_pcurrentvertbase) throw new Error("R_RenderFace: r_pcurrentvertbase not set");

  // push the edges through
  r_emitted = 0;
  r_nearzi = 0;
  r_nearzionly = false;
  makeleftedge = false;
  makerightedge = false;
  const pedges = currentmodel.edges;
  r_lastvertvalid = false;

  for (let i = 0; i < fa.numedges; i++) {
    let lindex = currentmodel.surfedges[fa.firstedge + i];
    let v0: MvertexT;
    let v1: MvertexT;

    if (lindex > 0) {
      r_pedge = pedges[lindex];
      v0 = r_pcurrentvertbase[r_pedge.v[0]];
      v1 = r_pcurrentvertbase[r_pedge.v[1]];
    } else {
      lindex = -lindex;
      r_pedge = pedges[lindex];
      v0 = r_pcurrentvertbase[r_pedge.v[1]];
      v1 = r_pcurrentvertbase[r_pedge.v[0]];
    }

    // if the edge is cached, we can just reuse the edge
    if (!insubmodel) {
      if (r_pedge.cachededgeoffset & FULLY_CLIPPED_CACHED) {
        if ((r_pedge.cachededgeoffset & FRAMECOUNT_MASK) === r_framecount) {
          r_lastvertvalid = false;
          continue;
        }
      } else if (r_edges && edge_p > r_pedge.cachededgeoffset && r_edges[r_pedge.cachededgeoffset].owner === r_pedge) {
        R_EmitCachedEdge();
        r_lastvertvalid = false;
        continue;
      }
    }

    // assume it's cacheable
    cacheoffset = edge_p;
    r_leftclipped = false;
    r_rightclipped = false;
    R_ClipEdge(v0, v1, pclip);
    r_pedge.cachededgeoffset = cacheoffset;

    if (r_leftclipped) makeleftedge = true;
    if (r_rightclipped) makerightedge = true;
    r_lastvertvalid = true;
  }

  // this is a dummy to give the caching mechanism someplace to write to
  const tedge = new MedgeT();

  // if there was a clip off the left edge, add that edge too
  if (makeleftedge) {
    r_pedge = tedge;
    r_lastvertvalid = false;
    R_ClipEdge(r_leftexit, r_leftenter, pclip ? pclip.next : null);
  }

  // if there was a clip off the right edge, get the right r_nearzi
  if (makerightedge) {
    r_pedge = tedge;
    r_lastvertvalid = false;
    r_nearzionly = true;
    R_ClipEdge(r_rightexit, r_rightenter, view_clipplanes[1].next);
  }

  // if no edges made it out, return without posting the surface
  if (!r_emitted) return;

  r_polycount++;

  const s = surfaces[surface_p];
  s.msurf = fa;
  s.nearzi = r_nearzi;
  s.flags = fa.flags;
  s.insubmodel = insubmodel;
  s.spanstate = 0;
  s.entity = currententity;
  s.key = rKey.current;
  rKey.current++;
  s.spans = null;

  const pplane = fa.plane;
  if (!pplane) throw new Error("R_RenderFace: surface has no plane");
  const p_normal = vec3();
  TransformVector(pplane.normal, p_normal);
  const distinv = 1.0 / (pplane.dist - DotProduct(modelorg, pplane.normal));

  s.d_zistepu = p_normal[0] * xscaleinv * distinv;
  s.d_zistepv = -p_normal[1] * yscaleinv * distinv;
  s.d_ziorigin = p_normal[2] * distinv - xcenter * s.d_zistepu - ycenter * s.d_zistepv;

  SetSurfaceP(surface_p + 1);
}

/*
================
R_RenderBmodelFace
================
*/
export function R_RenderBmodelFace(pedges: BedgeT | null, psurf: MsurfaceT): void {
  if (!psurf.texinfo) throw new Error("R_RenderBmodelFace: surface has no texinfo");

  // See R_RenderFace's identical check -- inline (bmodel) faces go through
  // CalcSurfaceExtents the same as world faces and can be flagged too.
  if (psurf.flags & SURF_EXTENTS_SKIP) return;

  if (psurf.texinfo.flags & (SURF_TRANS33 | SURF_TRANS66)) {
    psurf.nextalphasurface = r_alpha_surfaces;
    SetAlphaSurfaces(psurf);
    return;
  }

  if (!surfaces) throw new Error("R_RenderBmodelFace: surfaces not initialized");

  // skip out if no more surfs
  if (surface_p >= surf_max) {
    SetOutOfSurfaces(r_outofsurfaces + 1);
    return;
  }

  // ditto if not enough edges left, or switch to auxedges if possible
  if (edge_p + psurf.numedges + 4 >= edge_max) {
    SetOutOfEdges(r_outofedges + psurf.numedges);
    return;
  }

  c_faceclip++;

  // this is a dummy to give the caching mechanism someplace to write to
  const tedge = new MedgeT();
  r_pedge = tedge;

  // set up clip planes
  let pclip: ClipplaneT | null = null;
  let mask = 0x08;
  for (let i = 3; i >= 0; i--, mask >>= 1) {
    if (r_clipflags & mask) {
      view_clipplanes[i].next = pclip;
      pclip = view_clipplanes[i];
    }
  }

  r_emitted = 0;
  r_nearzi = 0;
  r_nearzionly = false;
  makeleftedge = false;
  makerightedge = false;
  r_lastvertvalid = false;

  let p: BedgeT | null = pedges;
  while (p) {
    r_leftclipped = false;
    r_rightclipped = false;
    const v0 = p.v[0];
    const v1 = p.v[1];
    if (!v0 || !v1) throw new Error("R_RenderBmodelFace: bedge missing vertex");
    R_ClipEdge(v0, v1, pclip);

    if (r_leftclipped) makeleftedge = true;
    if (r_rightclipped) makerightedge = true;
    p = p.pnext;
  }

  if (makeleftedge) {
    r_pedge = tedge;
    R_ClipEdge(r_leftexit, r_leftenter, pclip ? pclip.next : null);
  }

  if (makerightedge) {
    r_pedge = tedge;
    r_nearzionly = true;
    R_ClipEdge(r_rightexit, r_rightenter, view_clipplanes[1].next);
  }

  // if no edges made it out, return without posting the surface
  if (!r_emitted) return;

  r_polycount++;

  const s = surfaces[surface_p];
  s.msurf = psurf;
  s.nearzi = r_nearzi;
  s.flags = psurf.flags;
  s.insubmodel = true;
  s.spanstate = 0;
  s.entity = currententity;
  s.key = rKey.currentB;
  s.spans = null;

  const pplane = psurf.plane;
  if (!pplane) throw new Error("R_RenderBmodelFace: surface has no plane");
  const p_normal = vec3();
  TransformVector(pplane.normal, p_normal);
  const distinv = 1.0 / (pplane.dist - DotProduct(modelorg, pplane.normal));

  s.d_zistepu = p_normal[0] * xscaleinv * distinv;
  s.d_zistepv = -p_normal[1] * yscaleinv * distinv;
  s.d_ziorigin = p_normal[2] * distinv - xcenter * s.d_zistepu - ycenter * s.d_zistepv;

  SetSurfaceP(surface_p + 1);
}
