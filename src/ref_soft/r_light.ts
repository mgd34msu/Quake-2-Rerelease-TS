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

Ported from ref_soft/r_light.c (GNU GPL v2 or later). `R_MarkLights`/
`RecursiveLightPoint`/`R_AddDynamicLights`/`R_BuildLightMap` are static
internal helpers (not declared in r_local.h); `R_MarkLights` and
`R_BuildLightMap` are exported anyway (not exported in the C original)
purely so this unit's tests can drive them directly, per this unit's brief.
`R_DLightPoint` is declared in r_local.h but has no definition anywhere in
ref_soft's .c or .asm sources (dead/stale declaration, like r_surf.c's
R_DrawSurfaceBlock8/16) -- reported omission, no stub exists for it.

Cross-module mutable state: `r_dlightframecount` is an r_local.h extern owned
by r_local.ts, written here by R_PushDlights and also by R_DrawBEntitiesOnList
(r_main.ts), so both go through its setter. `currententity`/`r_worldmodel` are
read (never written) here and imported through r_bsp.ts, which re-exports
r_local.ts's bindings.
*/

import { type Vec3, vec3, vec3_origin, DotProduct, VectorCopy, VectorMA, VectorSubtract, VectorLength } from "../shared/math";
import { MAXLIGHTMAPS } from "../qcommon/qfiles";
import type { DlightT } from "../client/ref";
import { type MnodeOrLeaf, type MplaneT, type ModelT, isMleaf, SURF_DRAWSKY, SURF_DRAWTURB } from "./r_model";
import { r_newrefdef, r_drawsurf, rCvars, r_dlightframecount, r_framecount, SetDlightFrameCount, VID_CBITS } from "./r_local";
import { currententity, r_worldmodel } from "./r_bsp";

/*
=============================================================================

DYNAMIC LIGHTS

=============================================================================
*/



/*
=============
R_MarkLights
=============
*/
export function R_MarkLights(light: DlightT, bit: number, node: MnodeOrLeaf): void {
  if (isMleaf(node)) return;

  const splitplane = node.plane;
  if (!splitplane) throw new Error("R_MarkLights: node has no plane");

  const dist = DotProduct(light.origin, splitplane.normal) - splitplane.dist;

  let i = light.intensity;
  if (i < 0) i = -i;

  if (dist > i) {
    const child = node.children[0];
    if (child) R_MarkLights(light, bit, child);
    return;
  }
  if (dist < -i) {
    const child = node.children[1];
    if (child) R_MarkLights(light, bit, child);
    return;
  }

  // mark the polygons
  if (!r_worldmodel) throw new Error("R_MarkLights: r_worldmodel not set");
  for (let idx = 0; idx < node.numsurfaces; idx++) {
    const surf = r_worldmodel.surfaces[node.firstsurface + idx];
    if (surf.dlightframe !== r_dlightframecount) {
      surf.dlightbits = 0;
      surf.dlightframe = r_dlightframecount;
    }
    surf.dlightbits |= bit;
  }

  const c0 = node.children[0];
  if (c0) R_MarkLights(light, bit, c0);
  const c1 = node.children[1];
  if (c1) R_MarkLights(light, bit, c1);
}

/*
=============
R_PushDlights
=============
*/
export function R_PushDlights(model: ModelT): void {
  SetDlightFrameCount(r_framecount);

  for (let i = 0; i < r_newrefdef.num_dlights; i++) {
    const l = r_newrefdef.dlights[i];
    R_MarkLights(l, 1 << i, model.nodes[model.firstnode]);
  }
}

/*
=============================================================================

LIGHT SAMPLING

=============================================================================
*/

let pointcolor: Vec3 = vec3();
let lightplane: MplaneT | null = null;
let lightspot: Vec3 = vec3();

function RecursiveLightPoint(node: MnodeOrLeaf, start: Vec3, end: Vec3): number {
  if (isMleaf(node)) return -1; // didn't hit anything

  // calculate mid point
  const plane = node.plane;
  if (!plane) throw new Error("RecursiveLightPoint: node has no plane");

  const front = DotProduct(start, plane.normal) - plane.dist;
  const back = DotProduct(end, plane.normal) - plane.dist;
  const side = front < 0 ? 1 : 0;
  const backSide = back < 0 ? 1 : 0;

  if (backSide === side) {
    const child = node.children[side];
    if (!child) return -1;
    return RecursiveLightPoint(child, start, end);
  }

  const frac = front / (front - back);
  const mid = vec3(start[0] + (end[0] - start[0]) * frac, start[1] + (end[1] - start[1]) * frac, start[2] + (end[2] - start[2]) * frac);
  if (plane.type < 3) mid[plane.type] = plane.dist; // axial planes

  // go down front side
  const nearChild = node.children[side];
  const r = nearChild ? RecursiveLightPoint(nearChild, start, mid) : -1;
  if (r >= 0) return r; // hit something

  if (backSide === side) return -1; // didn't hit anything

  // check for impact on this node
  VectorCopy(mid, lightspot);
  lightplane = plane;

  if (!r_worldmodel) throw new Error("RecursiveLightPoint: r_worldmodel not set");

  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = r_worldmodel.surfaces[node.firstsurface + i];

    if (surf.flags & (SURF_DRAWTURB | SURF_DRAWSKY)) continue; // no lightmaps

    const tex = surf.texinfo;
    if (!tex) continue;

    const s = (DotProduct(mid, tex.vecs[0]) + tex.vecs[0][3]) | 0;
    const t = (DotProduct(mid, tex.vecs[1]) + tex.vecs[1][3]) | 0;
    if (s < surf.texturemins[0] || t < surf.texturemins[1]) continue;

    let ds = (s - surf.texturemins[0]) | 0;
    let dt = (t - surf.texturemins[1]) | 0;

    if (ds > surf.extents[0] || dt > surf.extents[1]) continue;

    if (!surf.samples) return 0;

    ds >>= 4;
    dt >>= 4;

    let lightmapOffset = dt * ((surf.extents[0] >> 4) + 1) + ds;
    VectorCopy(vec3_origin, pointcolor);

    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const samp = surf.samples[lightmapOffset] * (1.0 / 255); // adjust for gl scale
      const scales = r_newrefdef.lightstyles[surf.styles[maps]].rgb;
      VectorMA(pointcolor, samp, scales, pointcolor);
      lightmapOffset += ((surf.extents[0] >> 4) + 1) * ((surf.extents[1] >> 4) + 1);
    }

    return 1;
  }

  // go down back side
  const farChild = node.children[side === 0 ? 1 : 0];
  if (!farChild) return -1;
  return RecursiveLightPoint(farChild, mid, end);
}

/*
===============
R_LightPoint
===============
*/
export function R_LightPoint(p: Vec3, color: Vec3): void {
  if (!r_worldmodel) throw new Error("R_LightPoint: r_worldmodel not set");

  if (!r_worldmodel.lightdata) {
    color[0] = color[1] = color[2] = 1.0;
    return;
  }

  const end = vec3(p[0], p[1], p[2] - 2048);

  const r = RecursiveLightPoint(r_worldmodel.nodes[0], p, end);

  if (r === -1) {
    VectorCopy(vec3_origin, color);
  } else {
    VectorCopy(pointcolor, color);
  }

  // add dynamic lights
  if (!currententity) throw new Error("R_LightPoint: currententity not set");

  for (let lnum = 0; lnum < r_newrefdef.num_dlights; lnum++) {
    const dl = r_newrefdef.dlights[lnum];
    const dist = vec3();
    VectorSubtract(currententity.origin, dl.origin, dist);
    let add = dl.intensity - VectorLength(dist);
    add *= 1.0 / 256;
    if (add > 0) {
      VectorMA(color, add, dl.color, color);
    }
  }
}

//===================================================================

export const blocklights = new Uint32Array(1024); // allow some very large lightmaps

/*
===============
R_AddDynamicLights
===============
*/
function R_AddDynamicLights(): void {
  const surf = r_drawsurf.surf;
  if (!surf) throw new Error("R_AddDynamicLights: r_drawsurf.surf not set");

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  if (!tex) throw new Error("R_AddDynamicLights: surface has no texinfo");
  const pplane = surf.plane;
  if (!pplane) throw new Error("R_AddDynamicLights: surface has no plane");

  for (let lnum = 0; lnum < r_newrefdef.num_dlights; lnum++) {
    if (!(surf.dlightbits & (1 << lnum))) continue; // not lit by this light

    const dl = r_newrefdef.dlights[lnum];
    let rad = dl.intensity;

    let negativeLight = false;
    if (rad < 0) {
      negativeLight = true;
      rad = -rad;
    }

    let dist = DotProduct(dl.origin, pplane.normal) - pplane.dist;
    rad -= Math.abs(dist);
    const minlightFloor = 32; // dl->minlight
    if (rad < minlightFloor) continue;
    const minlight = rad - minlightFloor;

    const impact = vec3();
    for (let i = 0; i < 3; i++) {
      impact[i] = dl.origin[i] - pplane.normal[i] * dist;
    }

    let local0 = DotProduct(impact, tex.vecs[0]) + tex.vecs[0][3];
    let local1 = DotProduct(impact, tex.vecs[1]) + tex.vecs[1][3];

    local0 -= surf.texturemins[0];
    local1 -= surf.texturemins[1];

    for (let t = 0; t < tmax; t++) {
      let td = (local1 - t * 16) | 0;
      if (td < 0) td = -td;
      for (let s = 0; s < smax; s++) {
        let sd = (local0 - s * 16) | 0;
        if (sd < 0) sd = -sd;

        dist = sd > td ? sd + (td >> 1) : td + (sd >> 1);

        if (!negativeLight) {
          if (dist < minlight) blocklights[t * smax + s] = (blocklights[t * smax + s] + (rad - dist) * 256) >>> 0;
        } else {
          if (dist < minlight) blocklights[t * smax + s] = (blocklights[t * smax + s] - (rad - dist) * 256) >>> 0;
          if (blocklights[t * smax + s] < minlight) blocklights[t * smax + s] = minlight;
        }
      }
    }
  }
}

/*
===============
R_BuildLightMap

Combine and scale multiple lightmaps into the 8.8 format in blocklights
===============
*/
export function R_BuildLightMap(): void {
  const surf = r_drawsurf.surf;
  if (!surf) throw new Error("R_BuildLightMap: r_drawsurf.surf not set");

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;

  const fullbright = rCvars.r_fullbright !== null && rCvars.r_fullbright.value !== 0;

  if (fullbright || !r_worldmodel || !r_worldmodel.lightdata) {
    for (let i = 0; i < size; i++) blocklights[i] = 0;
    return;
  }

  // clear to no light
  for (let i = 0; i < size; i++) blocklights[i] = 0;

  // add all the lightmaps
  const lightmap = surf.samples;
  if (lightmap) {
    let offset = 0;
    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = r_drawsurf.lightadj[maps]; // 8.8 fraction
      for (let i = 0; i < size; i++) {
        blocklights[i] = (blocklights[i] + lightmap[offset + i] * scale) >>> 0;
      }
      offset += size; // skip to next lightmap
    }
  }

  // add all the dynamic lights
  if (surf.dlightframe === r_framecount) R_AddDynamicLights();

  // bound, invert, and shift
  for (let i = 0; i < size; i++) {
    let t = blocklights[i] | 0;
    if (t < 0) t = 0;
    t = (255 * 256 - t) >> (8 - VID_CBITS);

    if (t < 1 << 6) t = 1 << 6;

    blocklights[i] = t;
  }
}
