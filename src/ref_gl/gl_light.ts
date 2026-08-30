/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_light.c (GNU GPL v2 or later): R_RenderDlight/
R_RenderDlights, R_MarkLights/R_PushDlights, R_LightPoint/RecursiveLightPoint,
R_AddDynamicLights, R_SetCacheState, R_BuildLightMap.

R_RenderDlight's `#if 0 ... #endif` "view is inside the dlight" branch
(the only call site that would have needed V_AddBlend, an extern the client
owns) is dropped per PORTING.md's "#if 0 blocks are dropped silently" --
it never compiled into the real engine either, so there is no gap to report
here after all (superseding this file's previous header note about it).

gl_image.ts is the QGL binding other landed gl_*.ts units (gl_warp.ts,
gl_rsurf.ts) settled on consolidating: it owns the shared `export let qgl:
QGL`/`SetQGL` pair (uninitialized until a caller sets it -- tests call
`SetQGL(new QGLRecording())`, the real renderer calls
`SetQGL(loadQGLFromSystem())`). R_RenderDlights/R_RenderDlight are this
file's only functions that call real GL entry points, so they import that
same binding rather than adding a third one.
*/

import { type Vec3, vec3, vec3_origin, DotProduct, VectorCopy, VectorSubtract, VectorLength, VectorMA, VectorScale } from "../shared/math";
import { ERR_DROP, SURF_SKY, SURF_TRANS33, SURF_TRANS66, SURF_WARP, Q_ftol } from "../shared/q_shared";
import type { DlightT } from "../client/ref";
import { ri, glCvars, r_newrefdef, r_framecount, currententity, vpn, vright, vup, r_origin, r_worldmodel } from "./gl_local";
import { qgl } from "./gl_image";
import { type MnodeOrLeaf, type MsurfaceT, type MplaneT, MAXLIGHTMAPS, isMleaf, SURF_DRAWTURB, SURF_DRAWSKY } from "./gl_model";

// OpenGL 1.1 enum values gl_light.c's R_RenderDlight/R_RenderDlights need;
// no shared GL-enum module exists yet across gl_*.ts (every other landed
// unit only records qgl calls without needing real enum values).
const GL_TRIANGLE_FAN = 0x0006;
const GL_TEXTURE_2D = 0x0de1;
const GL_SMOOTH = 0x1d01;
const GL_BLEND = 0x0be2;
const GL_ONE = 1;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;

let r_dlightframecount = 0;

const DLIGHT_CUTOFF = 64;

/*
=============================================================================

DYNAMIC LIGHTS BLEND RENDERING

=============================================================================
*/

function R_RenderDlight(light: DlightT): void {
  if (!qgl) {
    ri.Sys_Error(ERR_DROP, "R_RenderDlight: no QGL bound");
    return;
  }

  const rad = light.intensity * 0.35;

  qgl.qglBegin(GL_TRIANGLE_FAN);
  qgl.qglColor3f(light.color[0] * 0.2, light.color[1] * 0.2, light.color[2] * 0.2);

  const v = vec3();
  for (let i = 0; i < 3; i++) v[i] = light.origin[i] - vpn[i] * rad;
  qgl.qglVertex3fv(v);

  qgl.qglColor3f(0, 0, 0);
  for (let i = 16; i >= 0; i--) {
    const a = (i / 16.0) * Math.PI * 2;
    for (let j = 0; j < 3; j++) {
      v[j] = light.origin[j] + vright[j] * Math.cos(a) * rad + vup[j] * Math.sin(a) * rad;
    }
    qgl.qglVertex3fv(v);
  }

  qgl.qglEnd();
}

/*
=============
R_RenderDlights
=============
*/
export function R_RenderDlights(): void {
  if (!glCvars.gl_flashblend || !glCvars.gl_flashblend.value) return;
  if (!qgl) {
    ri.Sys_Error(ERR_DROP, "R_RenderDlights: no QGL bound");
    return;
  }

  r_dlightframecount = r_framecount + 1; // because the count hasn't advanced yet for this frame

  qgl.qglDepthMask(false);
  qgl.qglDisable(GL_TEXTURE_2D);
  qgl.qglShadeModel(GL_SMOOTH);
  qgl.qglEnable(GL_BLEND);
  qgl.qglBlendFunc(GL_ONE, GL_ONE);

  for (let i = 0; i < r_newrefdef.num_dlights; i++) {
    R_RenderDlight(r_newrefdef.dlights[i]);
  }

  qgl.qglColor3f(1, 1, 1);
  qgl.qglDisable(GL_BLEND);
  qgl.qglEnable(GL_TEXTURE_2D);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglDepthMask(true);
}

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
  if (!splitplane) {
    ri.Sys_Error(ERR_DROP, "R_MarkLights: bad node");
    return;
  }
  const dist = DotProduct(light.origin, splitplane.normal) - splitplane.dist;

  if (dist > light.intensity - DLIGHT_CUTOFF) {
    if (node.children[0]) R_MarkLights(light, bit, node.children[0]);
    return;
  }
  if (dist < -light.intensity + DLIGHT_CUTOFF) {
    if (node.children[1]) R_MarkLights(light, bit, node.children[1]);
    return;
  }

  // mark the polygons
  if (!r_worldmodel) {
    ri.Sys_Error(ERR_DROP, "R_MarkLights: no worldmodel");
    return;
  }
  for (let i = 0; i < node.numsurfaces; i++) {
    const surf = r_worldmodel.surfaces[node.firstsurface + i];
    if (surf.dlightframe !== r_dlightframecount) {
      surf.dlightbits = 0;
      surf.dlightframe = r_dlightframecount;
    }
    surf.dlightbits |= bit;
  }

  if (node.children[0]) R_MarkLights(light, bit, node.children[0]);
  if (node.children[1]) R_MarkLights(light, bit, node.children[1]);
}

/*
=============
R_PushDlights
=============
*/
export function R_PushDlights(): void {
  if (glCvars.gl_flashblend && glCvars.gl_flashblend.value) return;

  r_dlightframecount = r_framecount + 1; // because the count hasn't advanced yet for this frame

  if (!r_worldmodel || r_worldmodel.nodes.length === 0) return;
  for (let i = 0; i < r_newrefdef.num_dlights; i++) {
    R_MarkLights(r_newrefdef.dlights[i], 1 << i, r_worldmodel.nodes[0]);
  }
}

/*
=============================================================================

LIGHT SAMPLING

=============================================================================
*/

let pointcolor: Vec3 = vec3();
let lightplane: MplaneT | null = null; // used as shadow plane
export const lightspot: Vec3 = vec3(); // gl_mesh.c reads this for shadow decal placement (extern vec3_t lightspot)

function RecursiveLightPoint(node: MnodeOrLeaf, start: Vec3, end: Vec3): number {
  if (isMleaf(node)) return -1; // didn't hit anything

  const plane = node.plane;
  if (!plane) return -1;

  // FIXME: optimize for axial
  const front = DotProduct(start, plane.normal) - plane.dist;
  const back = DotProduct(end, plane.normal) - plane.dist;
  const side = front < 0 ? 1 : 0;

  if ((back < 0 ? 1 : 0) === side) {
    const child = node.children[side];
    return child ? RecursiveLightPoint(child, start, end) : -1;
  }

  const frac = front / (front - back);
  const mid = vec3(start[0] + (end[0] - start[0]) * frac, start[1] + (end[1] - start[1]) * frac, start[2] + (end[2] - start[2]) * frac);

  // go down front side
  const frontChild = node.children[side];
  const r = frontChild ? RecursiveLightPoint(frontChild, start, mid) : -1;
  if (r >= 0) return r; // hit something

  if ((back < 0 ? 1 : 0) === side) return -1; // didn't hit anything

  // check for impact on this node
  VectorCopy(mid, lightspot);
  lightplane = plane;

  if (!r_worldmodel) return -1;
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

    ds = ds >> 4;
    dt = dt >> 4;

    const lightmap = surf.samples;
    VectorCopy(vec3_origin, pointcolor);

    let lightmapOffset = 3 * (dt * ((surf.extents[0] >> 4) + 1) + ds);
    for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
      const scale = vec3();
      const style = r_newrefdef.lightstyles[surf.styles[maps]];
      const modulate = glCvars.gl_modulate ? glCvars.gl_modulate.value : 1;
      for (let i2 = 0; i2 < 3; i2++) scale[i2] = modulate * style.rgb[i2];

      pointcolor[0] += lightmap[lightmapOffset + 0] * scale[0] * (1.0 / 255);
      pointcolor[1] += lightmap[lightmapOffset + 1] * scale[1] * (1.0 / 255);
      pointcolor[2] += lightmap[lightmapOffset + 2] * scale[2] * (1.0 / 255);

      lightmapOffset += 3 * ((surf.extents[0] >> 4) + 1) * ((surf.extents[1] >> 4) + 1);
    }

    return 1;
  }

  // go down back side
  const backChild = node.children[side === 0 ? 1 : 0];
  return backChild ? RecursiveLightPoint(backChild, mid, end) : -1;
}

/*
===============
R_LightPoint
===============
*/
export function R_LightPoint(p: Vec3, color: Vec3): void {
  if (!r_worldmodel || !r_worldmodel.lightdata) {
    color[0] = color[1] = color[2] = 1.0;
    return;
  }

  const end = vec3(p[0], p[1], p[2] - 2048);

  const r = r_worldmodel.nodes.length > 0 ? RecursiveLightPoint(r_worldmodel.nodes[0], p, end) : -1;

  if (r === -1) VectorCopy(vec3_origin, color);
  else VectorCopy(pointcolor, color);

  //
  // add dynamic lights
  //
  for (let lnum = 0; lnum < r_newrefdef.num_dlights; lnum++) {
    const dl = r_newrefdef.dlights[lnum];
    const dist = vec3();
    VectorSubtract(currententity ? currententity.origin : vec3_origin, dl.origin, dist);
    let add = dl.intensity - VectorLength(dist);
    add *= 1.0 / 256;
    if (add > 0) VectorMA(color, add, dl.color, color);
  }

  VectorScale(color, glCvars.gl_modulate ? glCvars.gl_modulate.value : 1, color);
}

//===================================================================

const s_blocklights = new Float32Array(34 * 34 * 3);

/*
===============
R_AddDynamicLights
===============
*/
function R_AddDynamicLights(surf: MsurfaceT): void {
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  const plane = surf.plane;
  if (!tex || !plane) return;

  for (let lnum = 0; lnum < r_newrefdef.num_dlights; lnum++) {
    if (!(surf.dlightbits & (1 << lnum))) continue; // not lit by this light

    const dl = r_newrefdef.dlights[lnum];
    let frad = dl.intensity;
    const fdist = DotProduct(dl.origin, plane.normal) - plane.dist;
    frad -= Math.abs(fdist);
    // rad is now the highest intensity on the plane

    let fminlight = DLIGHT_CUTOFF; // FIXME: make configurable?
    if (frad < fminlight) continue;
    fminlight = frad - fminlight;

    const impact = vec3();
    for (let i = 0; i < 3; i++) impact[i] = dl.origin[i] - plane.normal[i] * fdist;

    const local0 = DotProduct(impact, tex.vecs[0]) + tex.vecs[0][3] - surf.texturemins[0];
    const local1 = DotProduct(impact, tex.vecs[1]) + tex.vecs[1][3] - surf.texturemins[1];

    let pfBLIndex = 0;
    let ftacc = 0;
    for (let t = 0; t < tmax; t++, ftacc += 16) {
      let td = Q_ftol(local1 - ftacc);
      if (td < 0) td = -td;

      let fsacc = 0;
      for (let s = 0; s < smax; s++, fsacc += 16, pfBLIndex += 3) {
        let sd = Q_ftol(local0 - fsacc);
        if (sd < 0) sd = -sd;

        const fdist2 = sd > td ? sd + (td >> 1) : td + (sd >> 1);

        if (fdist2 < fminlight) {
          s_blocklights[pfBLIndex + 0] += (frad - fdist2) * dl.color[0];
          s_blocklights[pfBLIndex + 1] += (frad - fdist2) * dl.color[1];
          s_blocklights[pfBLIndex + 2] += (frad - fdist2) * dl.color[2];
        }
      }
    }
  }
}

/*
** R_SetCacheState
*/
export function R_SetCacheState(surf: MsurfaceT): void {
  for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
    surf.cached_light[maps] = r_newrefdef.lightstyles[surf.styles[maps]].white;
  }
}

/*
===============
R_BuildLightMap

Combine and scale multiple lightmaps into the floating format in
s_blocklights, then store the result into the GL lightmap block format
(RGBA quads, `stride` bytes per texel row -- `dest` is expected to already
be positioned at the surface's lightmap origin, matching the C original's
`byte *dest` pointer already offset by the caller).
===============
*/
export function R_BuildLightMap(surf: MsurfaceT, dest: Uint8Array, stride: number): void {
  const tex = surf.texinfo;
  if (!tex) {
    ri.Sys_Error(ERR_DROP, "R_BuildLightMap: no texinfo");
    return;
  }
  if (tex.flags & (SURF_SKY | SURF_TRANS33 | SURF_TRANS66 | SURF_WARP)) {
    ri.Sys_Error(ERR_DROP, "R_BuildLightMap called for non-lit surface");
  }

  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const size = smax * tmax;
  // C: sizeof(s_blocklights)>>4 -- BYTES (float[34*34*3] = 13872 -> 867),
  // not element count (3468 -> 216, which false-errors ordinary 17x17+
  // lightmaps the moment a dynamic light or lightstyle touches them).
  if (size > (s_blocklights.length * Float32Array.BYTES_PER_ELEMENT) >> 4) {
    ri.Sys_Error(ERR_DROP, "Bad s_blocklights size");
  }

  const gl_modulate_value = glCvars.gl_modulate ? glCvars.gl_modulate.value : 1;

  if (!surf.samples) {
    // set to full bright if no light data
    for (let i = 0; i < size * 3; i++) s_blocklights[i] = 255;
  } else {
    let nummaps = 0;
    while (nummaps < MAXLIGHTMAPS && surf.styles[nummaps] !== 255) nummaps++;

    const lightmap = surf.samples;

    // add all the lightmaps
    if (nummaps === 1) {
      for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
        let blIndex = 0;
        const scale = vec3();
        const style = r_newrefdef.lightstyles[surf.styles[maps]];
        for (let i = 0; i < 3; i++) scale[i] = gl_modulate_value * style.rgb[i];

        if (scale[0] === 1.0 && scale[1] === 1.0 && scale[2] === 1.0) {
          for (let i = 0; i < size; i++, blIndex += 3) {
            s_blocklights[blIndex + 0] = lightmap[i * 3 + 0];
            s_blocklights[blIndex + 1] = lightmap[i * 3 + 1];
            s_blocklights[blIndex + 2] = lightmap[i * 3 + 2];
          }
        } else {
          for (let i = 0; i < size; i++, blIndex += 3) {
            s_blocklights[blIndex + 0] = lightmap[i * 3 + 0] * scale[0];
            s_blocklights[blIndex + 1] = lightmap[i * 3 + 1] * scale[1];
            s_blocklights[blIndex + 2] = lightmap[i * 3 + 2] * scale[2];
          }
        }
        // (a single style never advances `lightmap` between iterations in
        // the original either -- the loop body only ever runs once here
        // since `nummaps === 1`.)
      }
    } else {
      for (let i = 0; i < size * 3; i++) s_blocklights[i] = 0;

      let lightmapOffset = 0;
      for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
        let blIndex = 0;
        const scale = vec3();
        const style = r_newrefdef.lightstyles[surf.styles[maps]];
        for (let i = 0; i < 3; i++) scale[i] = gl_modulate_value * style.rgb[i];

        if (scale[0] === 1.0 && scale[1] === 1.0 && scale[2] === 1.0) {
          for (let i = 0; i < size; i++, blIndex += 3) {
            s_blocklights[blIndex + 0] += lightmap[lightmapOffset + i * 3 + 0];
            s_blocklights[blIndex + 1] += lightmap[lightmapOffset + i * 3 + 1];
            s_blocklights[blIndex + 2] += lightmap[lightmapOffset + i * 3 + 2];
          }
        } else {
          for (let i = 0; i < size; i++, blIndex += 3) {
            s_blocklights[blIndex + 0] += lightmap[lightmapOffset + i * 3 + 0] * scale[0];
            s_blocklights[blIndex + 1] += lightmap[lightmapOffset + i * 3 + 1] * scale[1];
            s_blocklights[blIndex + 2] += lightmap[lightmapOffset + i * 3 + 2] * scale[2];
          }
        }
        lightmapOffset += size * 3; // skip to next lightmap
      }
    }

    // add all the dynamic lights
    if (surf.dlightframe === r_framecount) R_AddDynamicLights(surf);
  }

  // put into texture format
  const monolightmap = glCvars.gl_monolightmap && glCvars.gl_monolightmap.string.length > 0 ? glCvars.gl_monolightmap.string[0] : "0";
  const rowStride = stride - (smax << 2);
  let blIndex = 0;
  let destIdx = 0;

  for (let i = 0; i < tmax; i++, destIdx += rowStride) {
    for (let j = 0; j < smax; j++) {
      let r = Q_ftol(s_blocklights[blIndex]);
      let g = Q_ftol(s_blocklights[blIndex + 1]);
      let b = Q_ftol(s_blocklights[blIndex + 2]);

      // catch negative lights
      if (r < 0) r = 0;
      if (g < 0) g = 0;
      if (b < 0) b = 0;

      // determine the brightest of the three color components
      let max = r > g ? r : g;
      if (b > max) max = b;

      // alpha is ONLY used for the mono lightmap case. For this reason we
      // set it to the brightest of the color components so that things
      // don't get too dim.
      let a = max;

      // rescale all the color components if the intensity of the greatest
      // channel exceeds 1.0
      if (max > 255) {
        const scaleT = 255.0 / max;
        r = r * scaleT;
        g = g * scaleT;
        b = b * scaleT;
        a = a * scaleT;
      }

      if (monolightmap !== "0") {
        // So if we are doing alpha lightmaps we need to set the R, G, and B
        // components to 0 and we need to set alpha to 1-alpha.
        switch (monolightmap) {
          case "L":
          case "I":
            r = a;
            g = 0;
            b = 0;
            break;
          case "C": {
            // try faking colored lighting
            a = 255 - (r + g + b) / 3;
            r = r * (a / 255.0);
            g = g * (a / 255.0);
            b = b * (a / 255.0);
            break;
          }
          case "A":
          default:
            r = 0;
            g = 0;
            a = 255 - a;
            break;
        }
      }

      dest[destIdx + 0] = r;
      dest[destIdx + 1] = g;
      dest[destIdx + 2] = b;
      dest[destIdx + 3] = a;

      blIndex += 3;
      destIdx += 4;
    }
  }
}
