/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_edge.c (GNU GPL v2 or later). R_SurfacePatch/
R_EdgeCodeStart/R_EdgeCodeEnd are the portable (`#ifndef id386`) no-op
bodies in the C original; r_misc.c also defines a duplicate no-op
R_SurfacePatch under its own `#if !id386` guard (an apparent leftover
duplicate in the original source) -- this module is treated as the single
owner of the three since r_local.h lists them together right after
`R_Surf8Start`/`R_Surf16Start`.

Statics not declared in r_local.h (R_CleanupSpan, R_LeadingEdgeBackwards,
R_TrailingEdge, R_LeadingEdge, R_GenerateSpans, R_GenerateSpansBackward,
D_MipLevelForScale, D_FlatFillSurface, D_CalcGradients, D_BackgroundSurf,
D_TurbulentSurf, D_SkySurf, D_SolidSurf, D_DrawflatSurfaces) are ported here
as module-private (unexported) functions.

Pointer-arithmetic reshapings (reported in the unit report):
- `surf_t *surface_p`/`edge_t *edge_p`/`edge_max` (C pointers walking the
  `surfaces[]`/`r_edges[]` arrays) become plain number indices/counters.
  `edge_p`/`r_edges`/`edge_max` turn out to be pure bookkeeping that only
  matters to r_bsp.c/r_poly.c's (pending, out of this unit's scope) edge
  allocator -- r_edge.c itself never dereferences `r_edges[]` by position --
  so they are reset here for fidelity but otherwise unused for now.
  `surface_p` IS read by this file's own D_DrawSurfaces/D_DrawflatSurfaces
  as the active-surface-stack upper bound, so it stays a shared local.
- `espan_t *span_p, *max_span_p` and R_ScanEdges's stack-local `basespans`
  byte array become a module-level `EspanT[]` pool (`spanPool`) sized
  MAXSPANS, allocated fresh each R_ScanEdges call (matching the C array's
  stack lifetime), with `span_p`/`max_span_p` as indices into it and
  `allocSpan()` replacing `span = span_p++`.
- `edge_t *edge` list walks (R_InsertNewEdges/R_RemoveEdges/R_StepActiveU/
  R_GenerateSpans*) stay intrusive linked lists via EdgeT.next/prev/
  nextremove, unchanged from pointers since EdgeT is already a class with
  object identity.
- The 4x-unrolled `goto`-based search/step loops in R_InsertNewEdges and
  R_StepActiveU are ported as plain loops (output-identical; the unroll is
  a pure micro-optimization). Likewise D_DrawflatSurfaces's per-surface
  flat color, which the C computes as `(int)s->msurf & 0xFF` (the low byte
  of the msurface_t pointer): msurf is an object reference here, not an
  address, so a per-MsurfaceT incrementing id (via WeakMap) substitutes as
  "a stable arbitrary color derived from surface identity" -- reported
  deviation, not a pointer-bit-pattern match.

Cross-module mutable state: the per-surface rasterizer gradients
(`d_sdivz*`/`d_tdivz*`/`sadjust`/`tadjust`/`bbextent*`/`d_zistep*`/
`d_ziorigin`) and the texture source (`cacheblock`/`cachewidth`) are written
here (D_CalcGradients/D_BackgroundSurf/D_TurbulentSurf/D_SkySurf/D_SolidSurf)
and read by r_scan.ts's span drawers, which owns them; this file calls its
`D_Set*` setters, since an imported `let` binding is read-only to the
importer. `currententity`/`r_drawnpolycount`/`surface_p`/`edge_p`/`edge_max`
are r_local.h externs owned by r_local.ts and written through its setters --
`surface_p`/`edge_p` in particular are the same counters r_rast.ts advances
while filling `surfaces[]`/`r_edges[]`, which this file then consumes.
`currententity` is re-exported here because r_surf.ts reaches it through this
module for R_TextureAnimation.
*/

import {
  MAXSPANS,
  base_vpn,
  base_vright,
  base_vup,
  d_minmip,
  d_scalemip,
  edge_aftertail,
  edge_head,
  edge_tail,
  modelorg,
  newedges,
  r_newrefdef,
  r_numallocatededges,
  r_origin,
  r_refdef,
  r_worldentity,
  rCvars,
  removeedges,
  scale_for_mip,
  surfaces,
  vpn,
  vright,
  vup,
  xcenter,
  xscaleinv,
  ycenter,
  yscaleinv,
  currententity,
  edge_max,
  edge_p,
  r_drawnpolycount,
  surface_p,
  SetCurrentEntity,
  SetDrawnPolyCount,
  SetEdgeMax,
  SetEdgeP,
  SetSurfaceP,
  EdgeT,
  EspanT,
  type SurfcacheT,
  type SurfT,
} from "./r_local";
import { SURF_DRAWBACKGROUND, SURF_DRAWSKYBOX, SURF_DRAWTURB, type MsurfaceT } from "./r_model";
import { SURF_FLOWING, SURF_WARP } from "../shared/q_shared";
import { DotProduct, VectorCopy, VectorScale, VectorSubtract, type Vec3, vec3, vec3_origin } from "../shared/math";
import { R_RotateBmodel } from "./r_bsp";
import { R_TransformFrustum, TransformVector } from "./r_misc";
import { D_CacheSurface } from "./r_surf";
import { D_DrawSpans16, D_DrawZSpans, D_SetCacheSource, D_SetStGradients, D_SetZGradients, NonTurbulent8, Turbulent8, d_viewbuffer, r_screenwidth } from "./r_scan";

// #ifndef id386 -- portable (non-x86-asm) no-op bodies
export function R_SurfacePatch(): void {
  // no-op on the portable (non-x86-asm) path
}

export function R_EdgeCodeStart(): void {
  // no-op on the portable (non-x86-asm) path
}

export function R_EdgeCodeEnd(): void {
  // no-op on the portable (non-x86-asm) path
}

//===========================================================================
// file statics (r_edge.c)

let r_currentkey = 0;
let current_iv = 0;
let fv = 0;

let edge_head_u_shift20 = 0;
let edge_tail_u_shift20 = 0;

let pdrawfunc: (() => void) | null = null;

let miplevel = 0;

// r_edge.c's own `edge_t edge_sentinel;` -- unlike edge_head/edge_tail/
// edge_aftertail (shared via r_local.ts, referenced by future siblings),
// r_local.h never declares this one `extern`; only R_ScanEdges touches it.
const edge_sentinel: EdgeT = new EdgeT();

// r_edge.c's `vec3_t transformed_modelorg, world_transformed_modelorg,
// local_modelorg;` -- module-private, not declared in r_local.h.
const transformed_modelorg: Vec3 = vec3();
const world_transformed_modelorg: Vec3 = vec3();
const local_modelorg: Vec3 = vec3();

// `currententity`/`r_drawnpolycount`/`surface_p`/`edge_p`/`edge_max` are
// r_local.h externs owned by r_local.ts; re-exported because r_surf.ts reads
// `currententity` through this module.
export { currententity } from "./r_local";

// `espan_t *span_p, *max_span_p` plus R_ScanEdges's stack-local `basespans`
// byte array, reshaped into an index-addressed pool -- see file header.
let spanPool: EspanT[] = [];
let span_p = 0;
let max_span_p = 0;

function allocSpan(): EspanT {
  const span = spanPool[span_p];
  span_p++;
  return span;
}

function activeSurfaces(): SurfT[] {
  if (surfaces === null) throw new Error("r_edge: surfaces array not allocated");
  return surfaces;
}

/*
===============================================================================

EDGE SCANNING

===============================================================================
*/

/*
==============
R_BeginEdgeFrame
==============
*/
export function R_BeginEdgeFrame(): void {
  SetEdgeP(0);
  SetEdgeMax(r_numallocatededges);

  SetSurfaceP(2); // background is surface 1, surface 0 is a dummy
  const surfacesArr = activeSurfaces();
  surfacesArr[1].spans = null; // no background spans yet
  surfacesArr[1].flags = SURF_DRAWBACKGROUND;

  // put the background behind everything in the world
  if (rCvars.sw_draworder !== null && rCvars.sw_draworder.value) {
    pdrawfunc = R_GenerateSpansBackward;
    surfacesArr[1].key = 0;
    r_currentkey = 1;
  } else {
    pdrawfunc = R_GenerateSpans;
    surfacesArr[1].key = 0x7fffffff;
    r_currentkey = 0;
  }

  for (let v = r_refdef.vrect.y; v < r_refdef.vrectbottom; v++) {
    newedges[v] = null;
    removeedges[v] = null;
  }
}

/*
==============
R_InsertNewEdges

Adds the edges in the linked list edgestoadd, adding them to the edges in the
linked list edgelist.  edgestoadd is assumed to be sorted on u, and non-empty (this is actually newedges[v]).  edgelist is assumed to be sorted on u, with a
sentinel at the end (actually, this is the active edge table starting at
edge_head.next).
==============
*/
export function R_InsertNewEdges(edgestoaddIn: EdgeT, edgelistIn: EdgeT): void {
  let edgestoadd: EdgeT | null = edgestoaddIn;
  let edgelist = edgelistIn;

  do {
    const next_edge: EdgeT | null = edgestoadd.next;

    while (edgelist.u < edgestoadd.u) {
      const next: EdgeT | null = edgelist.next;
      if (next === null) break; // contract: edgelist always ends in a sentinel
      edgelist = next;
    }

    // insert edgestoadd before edgelist
    edgestoadd.next = edgelist;
    edgestoadd.prev = edgelist.prev;
    if (edgelist.prev !== null) edgelist.prev.next = edgestoadd;
    edgelist.prev = edgestoadd;

    edgestoadd = next_edge;
  } while (edgestoadd !== null);
}

/*
==============
R_RemoveEdges
==============
*/
export function R_RemoveEdges(pedgeIn: EdgeT): void {
  let pedge: EdgeT | null = pedgeIn;

  do {
    if (pedge.next !== null) pedge.next.prev = pedge.prev;
    if (pedge.prev !== null) pedge.prev.next = pedge.next;
    pedge = pedge.nextremove;
  } while (pedge !== null);
}

/*
==============
R_StepActiveU
==============
*/
export function R_StepActiveU(pedgeIn: EdgeT): void {
  let pedge: EdgeT | null = pedgeIn;

  while (pedge !== null) {
    pedge.u += pedge.u_step;

    if (pedge.prev !== null && pedge.u < pedge.prev.u) {
      if (pedge === edge_aftertail) return;

      const pnext_edge: EdgeT | null = pedge.next;

      // pull the edge out of the edge list
      if (pedge.next !== null) pedge.next.prev = pedge.prev;
      if (pedge.prev !== null) pedge.prev.next = pedge.next;

      // find out where the edge goes in the edge list
      let pwedge: EdgeT | null = pedge.prev !== null ? pedge.prev.prev : null;
      while (pwedge !== null && pwedge.u > pedge.u) {
        pwedge = pwedge.prev;
      }

      // put the edge back into the edge list
      if (pwedge !== null) {
        pedge.next = pwedge.next;
        pedge.prev = pwedge;
        if (pedge.next !== null) pedge.next.prev = pedge;
        pwedge.next = pedge;
      }

      pedge = pnext_edge;
      if (pedge === edge_tail) return;
      continue; // pedge steps for the first time on the next pass
    }

    pedge = pedge.next;
  }
}

/*
==============
R_CleanupSpan
==============
*/
function R_CleanupSpan(): void {
  const surfacesArr = activeSurfaces();

  // now that we've reached the right edge of the screen, we're done with any
  // unfinished surfaces, so emit a span for whatever's on top
  const first: SurfT | null = surfacesArr[1].next;
  if (first === null) throw new Error("r_edge: active surface stack corrupt");

  const iu = edge_tail_u_shift20;
  if (iu > first.last_u) {
    const span = allocSpan();
    span.u = first.last_u;
    span.count = iu - span.u;
    span.v = current_iv;
    span.pnext = first.spans;
    first.spans = span;
  }

  // reset spanstate for all surfaces in the surface stack
  let surf: SurfT = first;
  for (;;) {
    surf.spanstate = 0;
    const next: SurfT | null = surf.next;
    if (next === null) throw new Error("r_edge: active surface stack corrupt");
    surf = next;
    if (surf === surfacesArr[1]) break;
  }
}

/*
==============
R_LeadingEdgeBackwards
==============
*/
function R_LeadingEdgeBackwards(edge: EdgeT): void {
  const surfacesArr = activeSurfaces();

  // it's adding a new surface in, so find the correct place
  const surf = surfacesArr[edge.surfs[1]];

  // don't start a span if this is an inverted span, with the end
  // edge preceding the start edge (that is, we've already seen the
  // end edge)
  surf.spanstate++;
  if (surf.spanstate !== 1) return;

  const surf2Start: SurfT | null = surfacesArr[1].next;
  if (surf2Start === null) throw new Error("r_edge: active surface stack corrupt");
  let surf2: SurfT = surf2Start;

  let newtop = false;
  if (surf.key > surf2.key) {
    newtop = true;
  } else if (surf.insubmodel && surf.key === surf2.key) {
    // must be two bmodels in the same leaf; don't care, because they'll
    // never be farthest anyway
    newtop = true;
  }

  if (!newtop) {
    for (;;) {
      for (;;) {
        const next: SurfT | null = surf2.next;
        if (next === null) throw new Error("r_edge: active surface stack corrupt");
        surf2 = next;
        if (!(surf.key < surf2.key)) break;
      }

      if (surf.key === surf2.key && !surf.insubmodel) {
        // if it's two surfaces on the same plane, the one that's already
        // active is in front, so keep going unless it's a bmodel
        continue;
      }
      break;
    }
  } else {
    // emit a span (obscures current top)
    const iu = edge.u >> 20;

    if (iu > surf2.last_u) {
      const span = allocSpan();
      span.u = surf2.last_u;
      span.count = iu - span.u;
      span.v = current_iv;
      span.pnext = surf2.spans;
      surf2.spans = span;
    }

    // set last_u on the new span
    surf.last_u = iu;
  }

  // insert before surf2
  surf.next = surf2;
  surf.prev = surf2.prev;
  if (surf2.prev !== null) surf2.prev.next = surf;
  surf2.prev = surf;
}

/*
==============
R_TrailingEdge
==============
*/
function R_TrailingEdge(surf: SurfT, edge: EdgeT): void {
  // don't generate a span if this is an inverted span, with the end
  // edge preceding the start edge (that is, we haven't seen the
  // start edge yet)
  surf.spanstate--;
  if (surf.spanstate !== 0) return;

  const surfacesArr = activeSurfaces();
  if (surf === surfacesArr[1].next) {
    // emit a span (current top going away)
    const iu = edge.u >> 20;
    if (iu > surf.last_u) {
      const span = allocSpan();
      span.u = surf.last_u;
      span.count = iu - span.u;
      span.v = current_iv;
      span.pnext = surf.spans;
      surf.spans = span;
    }

    // set last_u on the surface below
    if (surf.next !== null) surf.next.last_u = iu;
  }

  if (surf.prev !== null) surf.prev.next = surf.next;
  if (surf.next !== null) surf.next.prev = surf.prev;
}

// the identical bmodel 1/z tie-break formula R_LeadingEdge inlines twice in
// the C original (copy-pasted verbatim both times); factored out since it
// is exactly the same computation both times, not a restructuring of
// control flow.
function zTieBreakPrefersHere(surf: SurfT, surf2: SurfT, edgeU: number): boolean {
  const fu = (edgeU - 0xfffff) * (1.0 / 0x100000);
  const newzi = surf.d_ziorigin + fv * surf.d_zistepv + fu * surf.d_zistepu;
  const newzibottom = newzi * 0.99;

  const testzi = surf2.d_ziorigin + fv * surf2.d_zistepv + fu * surf2.d_zistepu;

  if (newzibottom >= testzi) return true;

  const newzitop = newzi * 1.01;
  if (newzitop >= testzi) {
    if (surf.d_zistepu >= surf2.d_zistepu) return true;
  }
  return false;
}

/*
==============
R_LeadingEdge
==============
*/
function R_LeadingEdge(edge: EdgeT): void {
  if (edge.surfs[1] === 0) return;

  const surfacesArr = activeSurfaces();

  // it's adding a new surface in, so find the correct place
  const surf = surfacesArr[edge.surfs[1]];

  // don't start a span if this is an inverted span, with the end
  // edge preceding the start edge (that is, we've already seen the
  // end edge)
  surf.spanstate++;
  if (surf.spanstate !== 1) return;

  const surf2Start: SurfT | null = surfacesArr[1].next;
  if (surf2Start === null) throw new Error("r_edge: active surface stack corrupt");
  let surf2: SurfT = surf2Start;

  let newtop = false;
  if (surf.key < surf2.key) {
    newtop = true;
  } else if (surf.insubmodel && surf.key === surf2.key) {
    // must be two bmodels in the same leaf; sort on 1/z
    if (zTieBreakPrefersHere(surf, surf2, edge.u)) newtop = true;
  }

  if (!newtop) {
    for (;;) {
      for (;;) {
        const next: SurfT | null = surf2.next;
        if (next === null) throw new Error("r_edge: active surface stack corrupt");
        surf2 = next;
        if (!(surf.key > surf2.key)) break;
      }

      if (surf.key === surf2.key) {
        // if it's two surfaces on the same plane, the one that's already
        // active is in front, so keep going unless it's a bmodel
        if (!surf.insubmodel) continue;

        // must be two bmodels in the same leaf; sort on 1/z
        if (zTieBreakPrefersHere(surf, surf2, edge.u)) break;
        continue;
      }

      break;
    }
  } else {
    // emit a span (obscures current top)
    const iu = edge.u >> 20;

    if (iu > surf2.last_u) {
      const span = allocSpan();
      span.u = surf2.last_u;
      span.count = iu - span.u;
      span.v = current_iv;
      span.pnext = surf2.spans;
      surf2.spans = span;
    }

    // set last_u on the new span
    surf.last_u = iu;
  }

  // insert before surf2
  surf.next = surf2;
  surf.prev = surf2.prev;
  if (surf2.prev !== null) surf2.prev.next = surf;
  surf2.prev = surf;
}

/*
==============
R_GenerateSpans
==============
*/
function R_GenerateSpans(): void {
  const surfacesArr = activeSurfaces();

  // clear active surfaces to just the background surface
  surfacesArr[1].next = surfacesArr[1];
  surfacesArr[1].prev = surfacesArr[1];
  surfacesArr[1].last_u = edge_head_u_shift20;

  // generate spans
  let edge: EdgeT | null = edge_head.next;
  while (edge !== null && edge !== edge_tail) {
    if (edge.surfs[0] !== 0) {
      // it has a left surface, so a surface is going away for this span
      const surf = surfacesArr[edge.surfs[0]];

      R_TrailingEdge(surf, edge);

      if (edge.surfs[1] === 0) {
        edge = edge.next;
        continue;
      }
    }

    R_LeadingEdge(edge);
    edge = edge.next;
  }

  R_CleanupSpan();
}

/*
==============
R_GenerateSpansBackward
==============
*/
function R_GenerateSpansBackward(): void {
  const surfacesArr = activeSurfaces();

  // clear active surfaces to just the background surface
  surfacesArr[1].next = surfacesArr[1];
  surfacesArr[1].prev = surfacesArr[1];
  surfacesArr[1].last_u = edge_head_u_shift20;

  // generate spans
  let edge: EdgeT | null = edge_head.next;
  while (edge !== null && edge !== edge_tail) {
    if (edge.surfs[0] !== 0) R_TrailingEdge(surfacesArr[edge.surfs[0]], edge);

    if (edge.surfs[1] !== 0) R_LeadingEdgeBackwards(edge);

    edge = edge.next;
  }

  R_CleanupSpan();
}

/*
==============
R_ScanEdges

Input:
newedges[] array
	this has links to edges, which have links to surfaces

Output:
Each surface has a linked list of its visible spans
==============
*/
export function R_ScanEdges(): void {
  // C sizes `basespans` (MAXSPANS*sizeof(espan_t)+CACHE_SIZE bytes) as a
  // stack-local array and cache-aligns a pointer into it; ported as a
  // freshly-allocated EspanT pool with the same per-call lifetime -- see
  // file header comment.
  spanPool = new Array<EspanT>(MAXSPANS);
  for (let i = 0; i < MAXSPANS; i++) spanPool[i] = new EspanT();

  max_span_p = MAXSPANS - r_refdef.vrect.width;
  span_p = 0;

  // clear active edges to just the background edges around the whole screen
  // FIXME: most of this only needs to be set up once
  edge_head.u = r_refdef.vrect.x << 20;
  edge_head_u_shift20 = edge_head.u >> 20;
  edge_head.u_step = 0;
  edge_head.prev = null;
  edge_head.next = edge_tail;
  edge_head.surfs[0] = 0;
  edge_head.surfs[1] = 1;

  edge_tail.u = (r_refdef.vrectright << 20) + 0xfffff;
  edge_tail_u_shift20 = edge_tail.u >> 20;
  edge_tail.u_step = 0;
  edge_tail.prev = edge_head;
  edge_tail.next = edge_aftertail;
  edge_tail.surfs[0] = 1;
  edge_tail.surfs[1] = 0;

  edge_aftertail.u = -1; // force a move
  edge_aftertail.u_step = 0;
  edge_aftertail.next = edge_sentinel;
  edge_aftertail.prev = edge_tail;

  // FIXME: do we need this now that we clamp x in r_draw.c?
  edge_sentinel.u = 2000 << 24; // make sure nothing sorts past this
  edge_sentinel.prev = edge_aftertail;

  //
  // process all scan lines
  //
  const surfacesArr = activeSurfaces();
  const bottom = r_refdef.vrectbottom - 1;

  let iv = r_refdef.vrect.y;
  for (; iv < bottom; iv++) {
    current_iv = iv;
    fv = iv;

    // mark that the head (background start) span is pre-included
    surfacesArr[1].spanstate = 1;

    const ne = newedges[iv];
    if (ne !== null) {
      const firstActive = edge_head.next;
      if (firstActive !== null) R_InsertNewEdges(ne, firstActive);
    }

    if (pdrawfunc !== null) pdrawfunc();

    // flush the span list if we can't be sure we have enough spans left for
    // the next scan
    if (span_p > max_span_p) {
      D_DrawSurfaces();

      // clear the surface span pointers
      for (let i = 1; i < surface_p; i++) surfacesArr[i].spans = null;

      span_p = 0;
    }

    const re = removeedges[iv];
    if (re !== null) R_RemoveEdges(re);

    const firstActive = edge_head.next;
    if (firstActive !== null && firstActive !== edge_tail) R_StepActiveU(firstActive);
  }

  // do the last scan (no need to step or sort or remove on the last scan)

  current_iv = iv;
  fv = iv;

  // mark that the head (background start) span is pre-included
  surfacesArr[1].spanstate = 1;

  const ne = newedges[iv];
  if (ne !== null) {
    const firstActive = edge_head.next;
    if (firstActive !== null) R_InsertNewEdges(ne, firstActive);
  }

  if (pdrawfunc !== null) pdrawfunc();

  // draw whatever's left in the span list
  D_DrawSurfaces();
}

/*
=========================================================================

SURFACE FILLING

=========================================================================
*/

/*
=============
D_MipLevelForScale
=============
*/
function D_MipLevelForScale(scale: number): number {
  let lmiplevel: number;

  if (scale >= d_scalemip[0]) lmiplevel = 0;
  else if (scale >= d_scalemip[1]) lmiplevel = 1;
  else if (scale >= d_scalemip[2]) lmiplevel = 2;
  else lmiplevel = 3;

  if (lmiplevel < d_minmip) lmiplevel = d_minmip;

  return lmiplevel;
}

/*
==============
D_FlatFillSurface

Simple single color fill with no texture mapping
==============
*/
function D_FlatFillSurface(surf: SurfT, color: number): void {
  if (d_viewbuffer === null) return;
  const buffer = d_viewbuffer;

  for (let span = surf.spans; span !== null; span = span.pnext) {
    const rowBase = r_screenwidth * span.v;
    const u2 = span.u + span.count - 1;
    for (let u = span.u; u <= u2; u++) {
      buffer[rowBase + u] = color;
    }
  }
}

/*
==============
D_CalcGradients
==============
*/
function D_CalcGradients(pface: MsurfaceT): void {
  const texinfo = pface.texinfo;
  if (texinfo === null) throw new Error("r_edge: surface has no texinfo");

  const mipscale = 1.0 / (1 << miplevel);

  const p_saxis = vec3();
  const p_taxis = vec3();
  TransformVector(texinfo.vecs[0], p_saxis);
  TransformVector(texinfo.vecs[1], p_taxis);

  let t = xscaleinv * mipscale;
  const sdivzstepu = p_saxis[0] * t;
  const tdivzstepu = p_taxis[0] * t;

  t = yscaleinv * mipscale;
  const sdivzstepv = -p_saxis[1] * t;
  const tdivzstepv = -p_taxis[1] * t;

  const sdivzorigin = p_saxis[2] * mipscale - xcenter * sdivzstepu - ycenter * sdivzstepv;
  const tdivzorigin = p_taxis[2] * mipscale - xcenter * tdivzstepu - ycenter * tdivzstepv;

  const p_temp1 = vec3();
  VectorScale(transformed_modelorg, mipscale, p_temp1);

  const t2 = 0x10000 * mipscale;
  let sadjust = Math.trunc(
    Math.trunc(DotProduct(p_temp1, p_saxis) * 0x10000 + 0.5) - ((pface.texturemins[0] << 16) >> miplevel) + texinfo.vecs[0][3] * t2,
  );
  let tadjust = Math.trunc(
    Math.trunc(DotProduct(p_temp1, p_taxis) * 0x10000 + 0.5) - ((pface.texturemins[1] << 16) >> miplevel) + texinfo.vecs[1][3] * t2,
  );

  // PGM - changing flow speed for non-warping textures.
  if (texinfo.flags & SURF_FLOWING) {
    if (texinfo.flags & SURF_WARP) {
      sadjust = Math.trunc(sadjust + 0x10000 * (-128 * (r_newrefdef.time * 0.25 - Math.trunc(r_newrefdef.time * 0.25))));
    } else {
      sadjust = Math.trunc(sadjust + 0x10000 * (-128 * (r_newrefdef.time * 0.77 - Math.trunc(r_newrefdef.time * 0.77))));
    }
  }
  // PGM

  //
  // -1 (-epsilon) so we never wander off the edge of the texture
  //
  const bbextents = ((pface.extents[0] << 16) >> miplevel) - 1;
  const bbextentt = ((pface.extents[1] << 16) >> miplevel) - 1;

  D_SetStGradients({ sdivzstepu, tdivzstepu, sdivzstepv, tdivzstepv, sdivzorigin, tdivzorigin, sadjust, tadjust, bbextents, bbextentt });
}

/*
==============
D_BackgroundSurf

The grey background filler seen when there is a hole in the map
==============
*/
function D_BackgroundSurf(s: SurfT): void {
  // set up a gradient for the background surface that places it
  // effectively at infinity distance from the viewpoint
  D_SetZGradients(0, 0, -0.9);

  const clearcolor = rCvars.sw_clearcolor !== null ? rCvars.sw_clearcolor.value : 0;
  D_FlatFillSurface(s, Math.trunc(clearcolor) & 0xff);
  D_DrawZSpans(s.spans);
}

/*
=================
D_TurbulentSurf
=================
*/
function D_TurbulentSurf(s: SurfT): void {
  D_SetZGradients(s.d_zistepu, s.d_zistepv, s.d_ziorigin);

  const msurf = s.msurf;
  if (msurf === null) throw new Error("r_edge: surf has no msurf");
  miplevel = 0;

  const texinfo = msurf.texinfo;
  if (texinfo === null) throw new Error("r_edge: surf has no texinfo");
  const image = texinfo.image;
  D_SetCacheSource(image !== null ? image.pixels[0] : null, 64);

  if (s.insubmodel) {
    // FIXME: we don't want to do all this for every polygon!
    // TODO: store once at start of frame
    const entity = s.entity;
    if (entity === null) throw new Error("r_edge: insubmodel surf has no entity");
    SetCurrentEntity(entity); // FIXME: make this passed in to R_RotateBmodel ()
    VectorSubtract(r_origin, entity.origin, local_modelorg);
    TransformVector(local_modelorg, transformed_modelorg);

    R_RotateBmodel(); // FIXME: don't mess with the frustum, make entity passed in
  }

  D_CalcGradients(msurf);

  //============
  //PGM
  // textures that aren't warping are just flowing. Use NonTurbulent8 instead
  if (!(texinfo.flags & SURF_WARP)) NonTurbulent8(s.spans);
  else Turbulent8(s.spans);
  //PGM
  //============

  D_DrawZSpans(s.spans);

  if (s.insubmodel) {
    //
    // restore the old drawing state
    // FIXME: we don't want to do this every time!
    // TODO: speed up
    //
    SetCurrentEntity(null); // &r_worldentity;
    VectorCopy(world_transformed_modelorg, transformed_modelorg);
    VectorCopy(base_vpn, vpn);
    VectorCopy(base_vup, vup);
    VectorCopy(base_vright, vright);
    R_TransformFrustum();
  }
}

/*
==============
D_SkySurf
==============
*/
function D_SkySurf(s: SurfT): void {
  const msurf = s.msurf;
  if (msurf === null) throw new Error("r_edge: surf has no msurf");
  miplevel = 0;
  const texinfo = msurf.texinfo;
  if (texinfo === null || texinfo.image === null) return;
  // cachewidth is the sky image's own row stride, not vanilla's hardcoded
  // 256: the rerelease ships 512x512 skies too, and r_rast.ts's
  // R_SetSkyTextureSize has already widened this face's texture window to
  // match, so the two have to agree or every span samples the wrong row.
  D_SetCacheSource(texinfo.image.pixels[0], texinfo.image.width);

  D_SetZGradients(s.d_zistepu, s.d_zistepv, s.d_ziorigin);

  D_CalcGradients(msurf);

  D_DrawSpans16(s.spans);

  // set up a gradient for the background surface that places it
  // effectively at infinity distance from the viewpoint
  D_SetZGradients(0, 0, -0.9);

  D_DrawZSpans(s.spans);
}

/*
==============
D_SolidSurf

Normal surface cached, texture mapped surface
==============
*/
function D_SolidSurf(s: SurfT): void {
  D_SetZGradients(s.d_zistepu, s.d_zistepv, s.d_ziorigin);

  if (s.insubmodel) {
    // FIXME: we don't want to do all this for every polygon!
    // TODO: store once at start of frame
    const entity = s.entity;
    if (entity === null) throw new Error("r_edge: insubmodel surf has no entity");
    SetCurrentEntity(entity); // FIXME: make this passed in to R_RotateBmodel ()
    VectorSubtract(r_origin, entity.origin, local_modelorg);
    TransformVector(local_modelorg, transformed_modelorg);

    R_RotateBmodel(); // FIXME: don't mess with the frustum, make entity passed in
  } else {
    SetCurrentEntity(r_worldentity);
  }

  const msurf = s.msurf;
  if (msurf === null) throw new Error("r_edge: surf has no msurf");
  const texinfo = msurf.texinfo;
  if (texinfo === null) throw new Error("r_edge: surf has no texinfo");

  miplevel = D_MipLevelForScale(s.nearzi * scale_for_mip * texinfo.mipadjust);

  // FIXME: make this passed in to D_CacheSurface
  const pcurrentcache: SurfcacheT = D_CacheSurface(msurf, miplevel);

  D_SetCacheSource(pcurrentcache.data, pcurrentcache.width);

  D_CalcGradients(msurf);

  D_DrawSpans16(s.spans);

  D_DrawZSpans(s.spans);

  if (s.insubmodel) {
    //
    // restore the old drawing state
    // FIXME: we don't want to do this every time!
    // TODO: speed up
    //
    VectorCopy(world_transformed_modelorg, transformed_modelorg);
    VectorCopy(base_vpn, vpn);
    VectorCopy(base_vup, vup);
    VectorCopy(base_vright, vright);
    R_TransformFrustum();
    SetCurrentEntity(null); // &r_worldentity;
  }
}

// D_DrawflatSurfaces's per-surface stable color: see file header comment.
let nextFlatColorId = 0;
const flatColorIds = new WeakMap<MsurfaceT, number>();
function surfaceFlatColor(s: SurfT): number {
  const msurf = s.msurf;
  if (msurf === null) return 0;
  let id = flatColorIds.get(msurf);
  if (id === undefined) {
    id = nextFlatColorId++;
    flatColorIds.set(msurf, id);
  }
  return id;
}

/*
=============
D_DrawflatSurfaces

To allow developers to see the polygon carving of the world
=============
*/
function D_DrawflatSurfaces(): void {
  const surfacesArr = activeSurfaces();

  for (let i = 1; i < surface_p; i++) {
    const s = surfacesArr[i];
    if (s.spans === null) continue;

    D_SetZGradients(s.d_zistepu, s.d_zistepv, s.d_ziorigin);

    // make a stable color for each surface by taking the low
    // bits of the msurface pointer
    D_FlatFillSurface(s, surfaceFlatColor(s) & 0xff);
    D_DrawZSpans(s.spans);
  }
}

/*
==============
D_DrawSurfaces

Rasterize all the span lists.  Guaranteed zero overdraw.
May be called more than once a frame if the surf list overflows (higher res)
==============
*/
export function D_DrawSurfaces(): void {
  // currententity = null; //&r_worldentity;
  VectorSubtract(r_origin, vec3_origin, modelorg);
  TransformVector(modelorg, transformed_modelorg);
  VectorCopy(transformed_modelorg, world_transformed_modelorg);

  const drawflat = rCvars.sw_drawflat !== null && rCvars.sw_drawflat.value !== 0;

  if (!drawflat) {
    const surfacesArr = activeSurfaces();
    for (let i = 1; i < surface_p; i++) {
      const s = surfacesArr[i];
      if (s.spans === null) continue;

      SetDrawnPolyCount(r_drawnpolycount + 1);

      if (!(s.flags & (SURF_DRAWSKYBOX | SURF_DRAWBACKGROUND | SURF_DRAWTURB))) D_SolidSurf(s);
      else if (s.flags & SURF_DRAWSKYBOX) D_SkySurf(s);
      else if (s.flags & SURF_DRAWBACKGROUND) D_BackgroundSurf(s);
      else if (s.flags & SURF_DRAWTURB) D_TurbulentSurf(s);
    }
  } else {
    D_DrawflatSurfaces();
  }

  SetCurrentEntity(null); // &r_worldentity;
  VectorSubtract(r_origin, vec3_origin, modelorg);
  R_TransformFrustum();
}
