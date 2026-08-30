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

Ported from ref_soft/r_poly.c (GNU GPL v2 or later). `R_ClearPolyList`/
`R_DrawPolyList` are declared in r_local.h but have no definition anywhere
in ref_soft's .c or .asm sources (dead/stale declarations, like r_surf.c's
R_DrawSurfaceBlock8/16) -- reported omission, no stub exists for either.
The `R_DrawSpanlet*`/`R_Polygon*`/`R_DrawPoly`/`R_BuildPolygonFromSurface`
helpers are non-static in the C original but never called outside this
file (R_ClipAndDrawPoly is the only cross-file entry point, called by
r_sprite.c via a manual `extern` -- not declared in r_local.h either), so
they stay module-private here; `R_ClipPolyFace` is exported anyway purely
so this unit's tests can drive it directly, per this unit's brief (same
shape as r_light.ts's precedent for R_MarkLights/R_BuildLightMap).

`vec5_t` (`float[5]`: xyz + s + t) is ported as a plain `Float32Array(5)`
rather than a class -- it is pure position+texcoord data walked in tight
clipping loops, and `.subarray(0, 3)` gives a zero-copy `Vec3` view for the
vector-math helpers.

Cross-module mutable state: `cachewidth`/`cacheblock`, the ten `d_sdivz*`/
`d_tdivz*`/`sadjust`/`tadjust`/`bbextent*` and three `d_zistep*`/`d_ziorigin`
gradients are r_local.h externs owned by r_scan.ts; R_DrawPoly/
R_PolygonCalculateGradients write them through its `D_Set*` setters and
R_PolygonDrawSpans reads the bindings back, which is the same single set of
globals r_scan.c's own span drawers use. `currentmodel` and `r_alpha_surfaces`
are owned by r_local.ts -- the latter matters: r_rast.ts's R_RenderFace is the
producer that chains surfaces onto it and R_DrawAlphaSurfaces here is the
consumer that walks and clears the list, so they must be the same list.

`r_turb_turb` (`extern int *r_turb_turb;`, real storage in r_scan.c,
reassigned by both r_scan.c and this file's R_PolygonDrawSpans to point at
`sintable + offset`) is ported as a private (table, offset) pair here, the
same reshaping r_scan.ts applied to its own copy: the pointer is rewritten
before every use, so nothing crosses between the two files.
*/

import { type Vec3, vec3, vec3_origin, DotProduct, VectorSubtract, VectorCopy, CrossProduct, VectorNormalize } from "../shared/math";
import { ERR_DROP, SURF_TRANS66, SURF_WARP, SURF_FLOWING } from "../shared/q_shared";
import type { MsurfaceT } from "./r_model";
import { SURF_PLANEBACK } from "./r_model";
import { D_CacheSurface } from "./r_surf";
import { r_worldmodel } from "./r_bsp";
import {
  MAXWORKINGVERTS,
  MAXHEIGHT,
  DS_SPAN_LIST_END,
  NEAR_CLIP,
  CYCLE,
  SPEED,
  PolydescT,
  EmitpointT,
  type ClipplaneT,
  view_clipplanes,
  rCvars,
  ri,
  r_origin,
  r_refdef,
  r_newrefdef,
  vup,
  vright,
  vpn,
  modelorg,
  xcenter,
  ycenter,
  xscale,
  yscale,
  xscaleinv,
  yscaleinv,
  sintable,
  vid,
  d_scantable,
  currentmodel,
  r_alpha_surfaces,
  SetCurrentModel,
  SetAlphaSurfaces,
} from "./r_local";
import {
  bbextentt,
  bbextents,
  cacheblock,
  cachewidth,
  d_pzbuffer,
  d_sdivzorigin,
  d_sdivzstepu,
  d_sdivzstepv,
  d_tdivzorigin,
  d_tdivzstepu,
  d_tdivzstepv,
  d_viewbuffer,
  d_ziorigin,
  d_zistepu,
  d_zistepv,
  d_zwidth,
  sadjust,
  tadjust,
  D_SetCacheSource,
  D_SetStGradients,
  D_SetZGradients,
} from "./r_scan";
import { TransformVector } from "./r_misc";

const AFFINE_SPANLET_SIZE = 16;
const AFFINE_SPANLET_SIZE_BITS = 4;

export const r_polydesc: PolydescT = new PolydescT();

export const r_clip_verts: [Float32Array[], Float32Array[]] = [
  Array.from({ length: MAXWORKINGVERTS + 2 }, () => new Float32Array(5)),
  Array.from({ length: MAXWORKINGVERTS + 2 }, () => new Float32Array(5)),
];

let clip_current = 0;

let r_polyblendcolor = 0;

let r_turb_turbTable: number[] = sintable;
let r_turb_turbOffset = 0;

interface SpanletVarsT {
  pbase: Uint8Array | null;
  pdest: Uint8Array | null;
  pdestIdx: number;
  pz: Int16Array | null;
  pzIdx: number;
  s: number;
  t: number;
  sstep: number;
  tstep: number;
  izi: number;
  izistep: number;
  izistepTimes2: number;
  spancount: number;
  u: number;
  v: number;
}

const s_spanletvars: SpanletVarsT = {
  pbase: null,
  pdest: null,
  pdestIdx: 0,
  pz: null,
  pzIdx: 0,
  s: 0,
  t: 0,
  sstep: 0,
  tstep: 0,
  izi: 0,
  izistep: 0,
  izistepTimes2: 0,
  spancount: 0,
  u: 0,
  v: 0,
};

interface PolySpanT {
  u: number;
  v: number;
  count: number;
}

let s_polygon_spans: PolySpanT[] = [];
let s_minindex = 0;
let s_maxindex = 0;

/*
** R_DrawSpanletOpaque
*/
function R_DrawSpanletOpaque(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;

  do {
    const ts = sv.s >> 16;
    const tt = sv.t >> 16;

    const btemp = sv.pbase[ts + tt * cachewidth];
    if (btemp !== 255) {
      if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
        sv.pz[sv.pzIdx] = sv.izi >> 16;
        sv.pdest[sv.pdestIdx] = btemp;
      }
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.s = (sv.s + sv.sstep) | 0;
    sv.t = (sv.t + sv.tstep) | 0;
    sv.spancount--;
  } while (sv.spancount > 0);
}

/*
** R_DrawSpanletTurbulentStipple33
*/
function R_DrawSpanletTurbulentStipple33(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;

  let pdestIdx = sv.pdestIdx;
  let pzIdx = sv.pzIdx;
  let izi = sv.izi;

  if (sv.v & 1) {
    sv.pdestIdx += sv.spancount;
    sv.pzIdx += sv.spancount;

    if (sv.spancount === AFFINE_SPANLET_SIZE) sv.izi = (sv.izi + (sv.izistep << AFFINE_SPANLET_SIZE_BITS)) | 0;
    else sv.izi = (sv.izi + sv.izistep * sv.izistep) | 0;

    if (sv.u & 1) {
      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }

    sv.sstep = (sv.sstep * 2) | 0;
    sv.tstep = (sv.tstep * 2) | 0;

    while (sv.spancount > 0) {
      const sturb = ((sv.s + r_turb_turbTable[r_turb_turbOffset + ((sv.t >> 16) & (CYCLE - 1))]) >> 16) & 63;
      const tturb = ((sv.t + r_turb_turbTable[r_turb_turbOffset + ((sv.s >> 16) & (CYCLE - 1))]) >> 16) & 63;

      const btemp = sv.pbase[sturb + (tturb << 6)];

      if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;

      izi = (izi + sv.izistepTimes2) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx += 2;
      pzIdx += 2;
      sv.spancount -= 2;
    }
  }
}

/*
** R_DrawSpanletTurbulentStipple66
*/
function R_DrawSpanletTurbulentStipple66(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;

  let pdestIdx = sv.pdestIdx;
  let pzIdx = sv.pzIdx;
  let izi = sv.izi;

  if (!(sv.v & 1)) {
    sv.pdestIdx += sv.spancount;
    sv.pzIdx += sv.spancount;

    if (sv.spancount === AFFINE_SPANLET_SIZE) sv.izi = (sv.izi + (sv.izistep << AFFINE_SPANLET_SIZE_BITS)) | 0;
    else sv.izi = (sv.izi + sv.izistep * sv.izistep) | 0;

    if (sv.u & 1) {
      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }

    sv.sstep = (sv.sstep * 2) | 0;
    sv.tstep = (sv.tstep * 2) | 0;

    while (sv.spancount > 0) {
      const sturb = ((sv.s + r_turb_turbTable[r_turb_turbOffset + ((sv.t >> 16) & (CYCLE - 1))]) >> 16) & 63;
      const tturb = ((sv.t + r_turb_turbTable[r_turb_turbOffset + ((sv.s >> 16) & (CYCLE - 1))]) >> 16) & 63;

      const btemp = sv.pbase[sturb + (tturb << 6)];

      if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;

      izi = (izi + sv.izistepTimes2) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx += 2;
      pzIdx += 2;
      sv.spancount -= 2;
    }
  } else {
    sv.pdestIdx += sv.spancount;
    sv.pzIdx += sv.spancount;

    if (sv.spancount === AFFINE_SPANLET_SIZE) sv.izi = (sv.izi + (sv.izistep << AFFINE_SPANLET_SIZE_BITS)) | 0;
    else sv.izi = (sv.izi + sv.izistep * sv.izistep) | 0;

    while (sv.spancount > 0) {
      const sturb = ((sv.s + r_turb_turbTable[r_turb_turbOffset + ((sv.t >> 16) & (CYCLE - 1))]) >> 16) & 63;
      const tturb = ((sv.t + r_turb_turbTable[r_turb_turbOffset + ((sv.s >> 16) & (CYCLE - 1))]) >> 16) & 63;

      const btemp = sv.pbase[sturb + (tturb << 6)];

      if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;

      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }
  }
}

/*
** R_DrawSpanletTurbulentBlended66/33
*/
function R_DrawSpanletTurbulentBlended66(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;
  const alphamap = vid.alphamap;
  if (alphamap === null) return;

  do {
    const sturb = ((sv.s + r_turb_turbTable[r_turb_turbOffset + ((sv.t >> 16) & (CYCLE - 1))]) >> 16) & 63;
    const tturb = ((sv.t + r_turb_turbTable[r_turb_turbOffset + ((sv.s >> 16) & (CYCLE - 1))]) >> 16) & 63;

    const btemp = sv.pbase[sturb + (tturb << 6)];

    if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
      sv.pdest[sv.pdestIdx] = alphamap[btemp * 256 + sv.pdest[sv.pdestIdx]];
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.s = (sv.s + sv.sstep) | 0;
    sv.t = (sv.t + sv.tstep) | 0;
    sv.spancount--;
  } while (sv.spancount > 0);
}

function R_DrawSpanletTurbulentBlended33(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;
  const alphamap = vid.alphamap;
  if (alphamap === null) return;

  do {
    const sturb = ((sv.s + r_turb_turbTable[r_turb_turbOffset + ((sv.t >> 16) & (CYCLE - 1))]) >> 16) & 63;
    const tturb = ((sv.t + r_turb_turbTable[r_turb_turbOffset + ((sv.s >> 16) & (CYCLE - 1))]) >> 16) & 63;

    const btemp = sv.pbase[sturb + (tturb << 6)];

    if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
      sv.pdest[sv.pdestIdx] = alphamap[btemp + sv.pdest[sv.pdestIdx] * 256];
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.s = (sv.s + sv.sstep) | 0;
    sv.t = (sv.t + sv.tstep) | 0;
    sv.spancount--;
  } while (sv.spancount > 0);
}

/*
** R_DrawSpanlet33 / R_DrawSpanletConstant33 / R_DrawSpanlet66
*/
function R_DrawSpanlet33(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;
  const alphamap = vid.alphamap;
  if (alphamap === null) return;

  do {
    const ts = sv.s >> 16;
    const tt = sv.t >> 16;

    const btemp = sv.pbase[ts + tt * cachewidth];

    if (btemp !== 255) {
      if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
        sv.pdest[sv.pdestIdx] = alphamap[btemp + sv.pdest[sv.pdestIdx] * 256];
      }
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.s = (sv.s + sv.sstep) | 0;
    sv.t = (sv.t + sv.tstep) | 0;
    sv.spancount--;
  } while (sv.spancount > 0);
}

function R_DrawSpanletConstant33(): void {
  const sv = s_spanletvars;
  if (sv.pdest === null || sv.pz === null) return;
  const alphamap = vid.alphamap;
  if (alphamap === null) return;

  do {
    if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
      sv.pdest[sv.pdestIdx] = alphamap[r_polyblendcolor + sv.pdest[sv.pdestIdx] * 256];
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.spancount--;
  } while (sv.spancount > 0);
}

function R_DrawSpanlet66(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;
  const alphamap = vid.alphamap;
  if (alphamap === null) return;

  do {
    const ts = sv.s >> 16;
    const tt = sv.t >> 16;

    const btemp = sv.pbase[ts + tt * cachewidth];

    if (btemp !== 255) {
      if (sv.pz[sv.pzIdx] <= sv.izi >> 16) {
        sv.pdest[sv.pdestIdx] = alphamap[btemp * 256 + sv.pdest[sv.pdestIdx]];
      }
    }

    sv.izi = (sv.izi + sv.izistep) | 0;
    sv.pdestIdx++;
    sv.pzIdx++;
    sv.s = (sv.s + sv.sstep) | 0;
    sv.t = (sv.t + sv.tstep) | 0;
    sv.spancount--;
  } while (sv.spancount > 0);
}

/*
** R_DrawSpanlet33Stipple
*/
function R_DrawSpanlet33Stipple(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;

  let pdestIdx = sv.pdestIdx;
  let pzIdx = sv.pzIdx;
  let izi = sv.izi;

  if ((r_polydesc.stipple_parity ^ (sv.v & 1)) !== 0) {
    sv.pdestIdx += sv.spancount;
    sv.pzIdx += sv.spancount;

    if (sv.spancount === AFFINE_SPANLET_SIZE) sv.izi = (sv.izi + (sv.izistep << AFFINE_SPANLET_SIZE_BITS)) | 0;
    else sv.izi = (sv.izi + sv.izistep * sv.izistep) | 0;

    if ((r_polydesc.stipple_parity ^ (sv.u & 1)) !== 0) {
      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }

    sv.sstep = (sv.sstep * 2) | 0;
    sv.tstep = (sv.tstep * 2) | 0;

    while (sv.spancount > 0) {
      const s = sv.s >> 16;
      const t = sv.t >> 16;

      const btemp = sv.pbase[s + t * cachewidth];

      if (btemp !== 255) {
        if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;
      }

      izi = (izi + sv.izistepTimes2) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx += 2;
      pzIdx += 2;
      sv.spancount -= 2;
    }
  }
}

/*
** R_DrawSpanlet66Stipple
*/
function R_DrawSpanlet66Stipple(): void {
  const sv = s_spanletvars;
  if (sv.pbase === null || sv.pdest === null || sv.pz === null) return;

  let pdestIdx = sv.pdestIdx;
  let pzIdx = sv.pzIdx;
  let izi = sv.izi;

  sv.pdestIdx += sv.spancount;
  sv.pzIdx += sv.spancount;

  if (sv.spancount === AFFINE_SPANLET_SIZE) sv.izi = (sv.izi + (sv.izistep << AFFINE_SPANLET_SIZE_BITS)) | 0;
  else sv.izi = (sv.izi + sv.izistep * sv.izistep) | 0;

  if ((r_polydesc.stipple_parity ^ (sv.v & 1)) !== 0) {
    if ((r_polydesc.stipple_parity ^ (sv.u & 1)) !== 0) {
      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }

    sv.sstep = (sv.sstep * 2) | 0;
    sv.tstep = (sv.tstep * 2) | 0;

    while (sv.spancount > 0) {
      const s = sv.s >> 16;
      const t = sv.t >> 16;

      const btemp = sv.pbase[s + t * cachewidth];

      if (btemp !== 255) {
        if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;
      }

      izi = (izi + sv.izistepTimes2) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx += 2;
      pzIdx += 2;
      sv.spancount -= 2;
    }
  } else {
    while (sv.spancount > 0) {
      const s = sv.s >> 16;
      const t = sv.t >> 16;

      const btemp = sv.pbase[s + t * cachewidth];

      if (btemp !== 255) {
        if (sv.pz[pzIdx] <= izi >> 16) sv.pdest[pdestIdx] = btemp;
      }

      izi = (izi + sv.izistep) | 0;
      sv.s = (sv.s + sv.sstep) | 0;
      sv.t = (sv.t + sv.tstep) | 0;

      pdestIdx++;
      pzIdx++;
      sv.spancount--;
    }
  }
}

/*
** R_ClipPolyFace
**
** Clips the winding at clip_verts[clip_current] and changes clip_current.
** Throws out the back side.
*/
export function R_ClipPolyFace(nump: number, pclipplane: ClipplaneT): number {
  const dists = new Float32Array(MAXWORKINGVERTS + 3);
  const clipdist = pclipplane.dist;
  const pclipnormal = pclipplane.normal;

  let inBuf: number;
  let outBuf: number;
  if (clip_current) {
    inBuf = 1;
    outBuf = 0;
    clip_current = 0;
  } else {
    inBuf = 0;
    outBuf = 1;
    clip_current = 1;
  }

  const inVerts = r_clip_verts[inBuf];
  const outVerts = r_clip_verts[outBuf];

  for (let i = 0; i < nump; i++) {
    dists[i] = DotProduct(inVerts[i].subarray(0, 3), pclipnormal) - clipdist;
  }

  // handle wraparound case
  dists[nump] = dists[0];
  inVerts[nump].set(inVerts[0]);

  // clip the winding
  let outcount = 0;

  for (let i = 0; i < nump; i++) {
    if (dists[i] >= 0) {
      outVerts[outcount].set(inVerts[i]);
      outcount++;
    }

    if (dists[i] === 0 || dists[i + 1] === 0) continue;

    if (dists[i] > 0 === dists[i + 1] > 0) continue;

    // split it into a new vertex
    const frac = dists[i] / (dists[i] - dists[i + 1]);

    const instep = inVerts[i];
    const vert2 = inVerts[i + 1];
    const outstep = outVerts[outcount];

    outstep[0] = instep[0] + frac * (vert2[0] - instep[0]);
    outstep[1] = instep[1] + frac * (vert2[1] - instep[1]);
    outstep[2] = instep[2] + frac * (vert2[2] - instep[2]);
    outstep[3] = instep[3] + frac * (vert2[3] - instep[3]);
    outstep[4] = instep[4] + frac * (vert2[4] - instep[4]);

    outcount++;
  }

  return outcount;
}

/*
** R_PolygonDrawSpans
*/
function R_PolygonDrawSpans(pspan: PolySpanT[], iswater: boolean): void {
  s_spanletvars.pbase = cacheblock;

  if (iswater) {
    r_turb_turbTable = sintable;
    r_turb_turbOffset = Math.trunc(r_newrefdef.time * SPEED) & (CYCLE - 1);
  }

  const sdivzspanletstepu = d_sdivzstepu * AFFINE_SPANLET_SIZE;
  const tdivzspanletstepu = d_tdivzstepu * AFFINE_SPANLET_SIZE;
  const zispanletstepu = d_zistepu * AFFINE_SPANLET_SIZE;

  // we count on FP exceptions being turned off to avoid range problems
  s_spanletvars.izistep = Math.trunc(d_zistepu * 0x8000 * 0x10000) | 0;
  s_spanletvars.izistepTimes2 = (s_spanletvars.izistep * 2) | 0;

  if (d_viewbuffer === null || d_pzbuffer === null) return;
  s_spanletvars.pdest = d_viewbuffer;
  s_spanletvars.pz = d_pzbuffer;

  let idx = 0;

  do {
    const pspanCur = pspan[idx];

    s_spanletvars.pdestIdx = d_scantable[pspanCur.v] + pspanCur.u;
    s_spanletvars.pzIdx = d_zwidth * pspanCur.v + pspanCur.u;
    s_spanletvars.u = pspanCur.u;
    s_spanletvars.v = pspanCur.v;

    let count = pspanCur.count;

    if (count > 0) {
      const du = pspanCur.u;
      const dv = pspanCur.v;

      let sdivz = d_sdivzorigin + dv * d_sdivzstepv + du * d_sdivzstepu;
      let tdivz = d_tdivzorigin + dv * d_tdivzstepv + du * d_tdivzstepu;

      let zi = d_ziorigin + dv * d_zistepv + du * d_zistepu;
      let z = 0x10000 / zi;
      // we count on FP exceptions being turned off to avoid range problems
      s_spanletvars.izi = Math.trunc(zi * 0x8000 * 0x10000) | 0;

      s_spanletvars.s = (Math.trunc(sdivz * z) + sadjust) | 0;
      s_spanletvars.t = (Math.trunc(tdivz * z) + tadjust) | 0;

      if (!iswater) {
        if (s_spanletvars.s > bbextents) s_spanletvars.s = bbextents;
        else if (s_spanletvars.s < 0) s_spanletvars.s = 0;

        if (s_spanletvars.t > bbextentt) s_spanletvars.t = bbextentt;
        else if (s_spanletvars.t < 0) s_spanletvars.t = 0;
      }

      let snext = 0;
      let tnext = 0;

      do {
        // calculate s and t at the far end of the span
        if (count >= AFFINE_SPANLET_SIZE) s_spanletvars.spancount = AFFINE_SPANLET_SIZE;
        else s_spanletvars.spancount = count;

        count -= s_spanletvars.spancount;

        if (count) {
          // calculate s/z, t/z, zi->fixed s and t at far end of span,
          // calculate s and t steps across span by shifting
          sdivz += sdivzspanletstepu;
          tdivz += tdivzspanletstepu;
          zi += zispanletstepu;
          z = 0x10000 / zi;

          snext = (Math.trunc(sdivz * z) + sadjust) | 0;
          tnext = (Math.trunc(tdivz * z) + tadjust) | 0;

          if (!iswater) {
            if (snext > bbextents) snext = bbextents;
            else if (snext < AFFINE_SPANLET_SIZE) snext = AFFINE_SPANLET_SIZE;

            if (tnext > bbextentt) tnext = bbextentt;
            else if (tnext < AFFINE_SPANLET_SIZE) tnext = AFFINE_SPANLET_SIZE;
          }

          s_spanletvars.sstep = (snext - s_spanletvars.s) >> AFFINE_SPANLET_SIZE_BITS;
          s_spanletvars.tstep = (tnext - s_spanletvars.t) >> AFFINE_SPANLET_SIZE_BITS;
        } else {
          // calculate s/z, t/z, zi->fixed s and t at last pixel in span (so
          // can't step off polygon), clamp, calculate s and t steps across
          // span by division, biasing steps low so we don't run off the
          // texture
          const spancountminus1 = s_spanletvars.spancount - 1;
          sdivz += d_sdivzstepu * spancountminus1;
          tdivz += d_tdivzstepu * spancountminus1;
          zi += d_zistepu * spancountminus1;
          z = 0x10000 / zi;
          snext = (Math.trunc(sdivz * z) + sadjust) | 0;
          tnext = (Math.trunc(tdivz * z) + tadjust) | 0;

          if (!iswater) {
            if (snext > bbextents) snext = bbextents;
            else if (snext < AFFINE_SPANLET_SIZE) snext = AFFINE_SPANLET_SIZE;

            if (tnext > bbextentt) tnext = bbextentt;
            else if (tnext < AFFINE_SPANLET_SIZE) tnext = AFFINE_SPANLET_SIZE;
          }

          if (s_spanletvars.spancount > 1) {
            s_spanletvars.sstep = Math.trunc((snext - s_spanletvars.s) / (s_spanletvars.spancount - 1));
            s_spanletvars.tstep = Math.trunc((tnext - s_spanletvars.t) / (s_spanletvars.spancount - 1));
          }
        }

        if (iswater) {
          s_spanletvars.s = s_spanletvars.s & ((CYCLE << 16) - 1);
          s_spanletvars.t = s_spanletvars.t & ((CYCLE << 16) - 1);
        }

        if (r_polydesc.drawspanlet) r_polydesc.drawspanlet();

        s_spanletvars.s = snext;
        s_spanletvars.t = tnext;
      } while (count > 0);
    }

    idx++;
  } while (pspan[idx].count !== DS_SPAN_LIST_END);
}

/*
** R_PolygonScanLeftEdge
**
** Goes through the polygon and scans the left edge, filling in
** screen coordinate data for the spans
*/
function R_PolygonScanLeftEdge(): void {
  const pverts = r_polydesc.pverts;
  if (pverts === null) return;

  let spanIdx = 0;

  let i = s_minindex;
  if (i === 0) i = r_polydesc.nump;

  let lmaxindex = s_maxindex;
  if (lmaxindex === 0) lmaxindex = r_polydesc.nump;

  let vtop = Math.ceil(pverts[i].v);

  do {
    const pvert = pverts[i];
    const pnext = pverts[i - 1];

    const vbottom = Math.ceil(pnext.v);

    if (vtop < vbottom) {
      const du = pnext.u - pvert.u;
      const dv = pnext.v - pvert.v;

      const slope = du / dv;
      const u_step = Math.trunc(slope * 0x10000) | 0;
      let u = (Math.trunc((pvert.u + slope * (vtop - pvert.v)) * 0x10000) | 0) + (0x10000 - 1);
      const itop = Math.trunc(vtop);
      const ibottom = Math.trunc(vbottom);

      for (let v = itop; v < ibottom; v++) {
        s_polygon_spans[spanIdx].u = u >> 16;
        s_polygon_spans[spanIdx].v = v;
        u = (u + u_step) | 0;
        spanIdx++;
      }
    }

    vtop = vbottom;

    i--;
    if (i === 0) i = r_polydesc.nump;
  } while (i !== lmaxindex);
}

/*
** R_PolygonScanRightEdge
**
** Goes through the polygon and scans the right edge, filling in
** count values.
*/
function R_PolygonScanRightEdge(): void {
  const pverts = r_polydesc.pverts;
  if (pverts === null) return;

  let spanIdx = 0;

  let i = s_minindex;

  let vvert = pverts[i].v;
  if (vvert < r_refdef.fvrecty_adj) vvert = r_refdef.fvrecty_adj;
  if (vvert > r_refdef.fvrectbottom_adj) vvert = r_refdef.fvrectbottom_adj;

  let vtop = Math.ceil(vvert);

  do {
    const pvert = pverts[i];
    const pnext = pverts[i + 1];

    let vnext = pnext.v;
    if (vnext < r_refdef.fvrecty_adj) vnext = r_refdef.fvrecty_adj;
    if (vnext > r_refdef.fvrectbottom_adj) vnext = r_refdef.fvrectbottom_adj;

    const vbottom = Math.ceil(vnext);

    if (vtop < vbottom) {
      let uvert = pvert.u;
      if (uvert < r_refdef.fvrectx_adj) uvert = r_refdef.fvrectx_adj;
      if (uvert > r_refdef.fvrectright_adj) uvert = r_refdef.fvrectright_adj;

      let unext = pnext.u;
      if (unext < r_refdef.fvrectx_adj) unext = r_refdef.fvrectx_adj;
      if (unext > r_refdef.fvrectright_adj) unext = r_refdef.fvrectright_adj;

      const du = unext - uvert;
      const dv = vnext - vvert;
      const slope = du / dv;
      const u_step = Math.trunc(slope * 0x10000) | 0;
      let u = (Math.trunc((uvert + slope * (vtop - vvert)) * 0x10000) | 0) + (0x10000 - 1);
      const itop = Math.trunc(vtop);
      const ibottom = Math.trunc(vbottom);

      for (let v = itop; v < ibottom; v++) {
        s_polygon_spans[spanIdx].count = (u >> 16) - s_polygon_spans[spanIdx].u;
        u = (u + u_step) | 0;
        spanIdx++;
      }
    }

    vtop = vbottom;
    vvert = vnext;

    i++;
    if (i === r_polydesc.nump) i = 0;
  } while (i !== s_maxindex);

  s_polygon_spans[spanIdx].count = DS_SPAN_LIST_END; // mark the end of the span list
}

/*
** R_ClipAndDrawPoly
*/
export function R_ClipAndDrawPoly(alpha: number, isturbulent: boolean, textured: boolean): void {
  if (!textured) {
    r_polydesc.drawspanlet = R_DrawSpanletConstant33;
  } else {
    // choose the correct spanlet routine based on alpha
    if (alpha === 1) {
      // isturbulent is ignored because we know that turbulent surfaces
      // can't be opaque
      r_polydesc.drawspanlet = R_DrawSpanletOpaque;
    } else {
      if (rCvars.sw_stipplealpha !== null && rCvars.sw_stipplealpha.value !== 0) {
        if (isturbulent) {
          r_polydesc.drawspanlet = alpha > 0.33 ? R_DrawSpanletTurbulentStipple66 : R_DrawSpanletTurbulentStipple33;
        } else {
          r_polydesc.drawspanlet = alpha > 0.33 ? R_DrawSpanlet66Stipple : R_DrawSpanlet33Stipple;
        }
      } else {
        if (isturbulent) {
          r_polydesc.drawspanlet = alpha > 0.33 ? R_DrawSpanletTurbulentBlended66 : R_DrawSpanletTurbulentBlended33;
        } else {
          r_polydesc.drawspanlet = alpha > 0.33 ? R_DrawSpanlet66 : R_DrawSpanlet33;
        }
      }
    }
  }

  // clip to the frustum in worldspace
  let nump = r_polydesc.nump;
  clip_current = 0;

  for (let i = 0; i < 4; i++) {
    nump = R_ClipPolyFace(nump, view_clipplanes[i]);
    if (nump < 3) return;
    if (nump > MAXWORKINGVERTS) {
      ri.Sys_Error(ERR_DROP, `R_ClipAndDrawPoly: too many points: ${nump}`);
    }
  }

  // transform vertices into viewspace and project
  const verts = r_clip_verts[clip_current];
  const outverts: EmitpointT[] = Array.from({ length: MAXWORKINGVERTS + 3 }, () => new EmitpointT());
  const local = vec3();
  const transformed = vec3();

  for (let i = 0; i < nump; i++) {
    const pv = verts[i];
    VectorSubtract(pv.subarray(0, 3), r_origin, local);
    TransformVector(local, transformed);

    if (transformed[2] < NEAR_CLIP) transformed[2] = NEAR_CLIP;

    const pout = outverts[i];
    pout.zi = 1.0 / transformed[2];

    pout.s = pv[3];
    pout.t = pv[4];

    let scale = xscale * pout.zi;
    pout.u = xcenter + scale * transformed[0];

    scale = yscale * pout.zi;
    pout.v = ycenter - scale * transformed[1];
  }

  // draw it
  r_polydesc.nump = nump;
  r_polydesc.pverts = outverts;

  R_DrawPoly(isturbulent);
}

/*
** R_BuildPolygonFromSurface
*/
function R_BuildPolygonFromSurface(fa: MsurfaceT): void {
  r_polydesc.nump = 0;

  if (currentmodel === null || fa.texinfo === null || fa.plane === null) return;

  // reconstruct the polygon
  const pedges = currentmodel.edges;
  const lnumverts = fa.numedges;
  const tmins: [number, number] = [0, 0];

  const pverts = r_clip_verts[0];

  for (let i = 0; i < lnumverts; i++) {
    const lindex = currentmodel.surfedges[fa.firstedge + i];

    let vec: Vec3;
    if (lindex > 0) {
      const r_pedge = pedges[lindex];
      vec = currentmodel.vertexes[r_pedge.v[0]].position;
    } else {
      const r_pedge = pedges[-lindex];
      vec = currentmodel.vertexes[r_pedge.v[1]].position;
    }

    pverts[i].set(vec, 0);
  }

  VectorCopy(fa.texinfo.vecs[0].subarray(0, 3), r_polydesc.vright);
  VectorCopy(fa.texinfo.vecs[1].subarray(0, 3), r_polydesc.vup);
  VectorCopy(fa.plane.normal, r_polydesc.vpn);
  VectorCopy(r_origin, r_polydesc.viewer_position);

  if ((fa.flags & SURF_PLANEBACK) !== 0) {
    VectorSubtract(vec3_origin, r_polydesc.vpn, r_polydesc.vpn);
  }

  // PGM 09/16/98 -- flowing (scrolling) surfaces take the same raw-image
  // path as warped ones; routing them through D_CacheSurface's lightmap
  // cache instead produced the "D_SCAlloc: bad cache width" crash on
  // flowing transparent surfaces (3.20/3.21 fix).
  if ((fa.texinfo.flags & (SURF_WARP | SURF_FLOWING)) !== 0) {
    if (fa.texinfo.image === null) return;
    r_polydesc.pixels = fa.texinfo.image.pixels[0];
    r_polydesc.pixel_width = fa.texinfo.image.width;
    r_polydesc.pixel_height = fa.texinfo.image.height;
  } else {
    const scache = D_CacheSurface(fa, 0);

    r_polydesc.pixels = scache.data;
    r_polydesc.pixel_width = scache.width;
    r_polydesc.pixel_height = scache.height;

    tmins[0] = fa.texturemins[0];
    tmins[1] = fa.texturemins[1];
  }

  r_polydesc.dist = DotProduct(r_polydesc.vpn, pverts[0].subarray(0, 3));

  r_polydesc.s_offset = fa.texinfo.vecs[0][3] - tmins[0];
  r_polydesc.t_offset = fa.texinfo.vecs[1][3] - tmins[1];

  // scrolling texture addition
  if ((fa.texinfo.flags & SURF_FLOWING) !== 0) {
    r_polydesc.s_offset += -128 * (r_newrefdef.time * 0.25 - Math.trunc(r_newrefdef.time * 0.25));
  }

  r_polydesc.nump = lnumverts;
}

/*
** R_DrawPoly
**
** Polygon drawing function. Uses the polygon described in r_polydesc
** to calculate edges and gradients, then renders the resultant spans.
**
** This should NOT be called externally since it doesn't do clipping!
*/
function R_DrawPoly(iswater: boolean): void {
  const pverts = r_polydesc.pverts;
  if (pverts === null) return;

  // find the top and bottom vertices, and make sure there's at least one
  // scan to draw
  let ymin = 999999.9;
  let ymax = -999999.9;

  for (let i = 0; i < r_polydesc.nump; i++) {
    const v = pverts[i].v;

    if (v < ymin) {
      ymin = v;
      s_minindex = i;
    }

    if (v > ymax) {
      ymax = v;
      s_maxindex = i;
    }
  }

  ymin = Math.ceil(ymin);
  ymax = Math.ceil(ymax);

  if (ymin >= ymax) return; // doesn't cross any scans at all

  D_SetCacheSource(r_polydesc.pixels, r_polydesc.pixel_width);

  // copy the first vertex to the last vertex, so we don't have to deal with
  // wrapping
  const nump = r_polydesc.nump;
  pverts[nump] = pverts[0];

  const spans: PolySpanT[] = Array.from({ length: MAXHEIGHT + 1 }, () => ({ u: 0, v: 0, count: 0 }));
  s_polygon_spans = spans;

  R_PolygonCalculateGradients();
  R_PolygonScanLeftEdge();
  R_PolygonScanRightEdge();

  R_PolygonDrawSpans(s_polygon_spans, iswater);
}

/*
** R_PolygonCalculateGradients
*/
function R_PolygonCalculateGradients(): void {
  const p_normal = vec3();
  const p_saxis = vec3();
  const p_taxis = vec3();

  TransformVector(r_polydesc.vpn, p_normal);
  TransformVector(r_polydesc.vright, p_saxis);
  TransformVector(r_polydesc.vup, p_taxis);

  const distinv = 1.0 / (-DotProduct(r_polydesc.viewer_position, r_polydesc.vpn) + r_polydesc.dist);

  const sdivzstepu = p_saxis[0] * xscaleinv;
  const sdivzstepv = -p_saxis[1] * yscaleinv;
  const sdivzorigin = p_saxis[2] - xcenter * sdivzstepu - ycenter * sdivzstepv;

  const tdivzstepu = p_taxis[0] * xscaleinv;
  const tdivzstepv = -p_taxis[1] * yscaleinv;
  const tdivzorigin = p_taxis[2] - xcenter * tdivzstepu - ycenter * tdivzstepv;

  const zistepu = p_normal[0] * xscaleinv * distinv;
  const zistepv = -p_normal[1] * yscaleinv * distinv;
  const ziorigin = p_normal[2] * distinv - xcenter * zistepu - ycenter * zistepv;

  D_SetZGradients(zistepu, zistepv, ziorigin);

  D_SetStGradients({
    sdivzstepu,
    tdivzstepu,
    sdivzstepv,
    tdivzstepv,
    sdivzorigin,
    tdivzorigin,
    sadjust: (Math.trunc((DotProduct(r_polydesc.viewer_position, r_polydesc.vright) + r_polydesc.s_offset) * 0x10000)) | 0,
    tadjust: (Math.trunc((DotProduct(r_polydesc.viewer_position, r_polydesc.vup) + r_polydesc.t_offset) * 0x10000)) | 0,
    // -1 (-epsilon) so we never wander off the edge of the texture
    bbextents: ((r_polydesc.pixel_width << 16) - 1) | 0,
    bbextentt: ((r_polydesc.pixel_height << 16) - 1) | 0,
  });
}

/*
** R_DrawAlphaSurfaces
*/
export function R_DrawAlphaSurfaces(): void {
  let s = r_alpha_surfaces;

  SetCurrentModel(r_worldmodel);

  modelorg[0] = -r_origin[0];
  modelorg[1] = -r_origin[1];
  modelorg[2] = -r_origin[2];

  while (s !== null) {
    R_BuildPolygonFromSurface(s);

    const warpFlags = s.texinfo !== null ? s.texinfo.flags : 0;

    if ((warpFlags & SURF_TRANS66) !== 0) {
      R_ClipAndDrawPoly(0.6, (warpFlags & SURF_WARP) !== 0, true);
    } else {
      R_ClipAndDrawPoly(0.3, (warpFlags & SURF_WARP) !== 0, true);
    }

    s = s.nextalphasurface;
  }

  SetAlphaSurfaces(null);
}

/*
** R_IMFlatShadedQuad
*/
export function R_IMFlatShadedQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: number, alpha: number): void {
  r_polydesc.nump = 4;
  VectorCopy(r_origin, r_polydesc.viewer_position);

  const verts = r_clip_verts[0];
  verts[0].set(a, 0);
  verts[1].set(b, 0);
  verts[2].set(c, 0);
  verts[3].set(d, 0);

  verts[0][3] = 0;
  verts[1][3] = 0;
  verts[2][3] = 0;
  verts[3][3] = 0;

  verts[0][4] = 0;
  verts[1][4] = 0;
  verts[2][4] = 0;
  verts[3][4] = 0;

  const s0 = vec3();
  const s1 = vec3();
  VectorSubtract(d, c, s0);
  VectorSubtract(c, b, s1);
  CrossProduct(s0, s1, r_polydesc.vpn);
  VectorNormalize(r_polydesc.vpn);

  r_polydesc.dist = DotProduct(r_polydesc.vpn, verts[0].subarray(0, 3));

  r_polyblendcolor = color;

  R_ClipAndDrawPoly(alpha, false, false);
}
