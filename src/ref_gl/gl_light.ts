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

import { type Vec3, vec3, vec3_origin, DotProduct, VectorCopy, VectorAdd, VectorSubtract, VectorLength, VectorMA, VectorScale } from "../shared/math";
import { ERR_DROP, SURF_SKY, SURF_TRANS33, SURF_TRANS66, SURF_WARP, Q_ftol } from "../shared/q_shared";
import type { DlightT } from "../client/ref";
import { ri, glCvars, r_newrefdef, r_framecount, currententity, vpn, vright, vup, r_origin, r_worldmodel } from "./gl_local";
import { qgl } from "./gl_image";
import { type MnodeOrLeaf, type MsurfaceT, type MplaneT, MAXLIGHTMAPS, isMleaf, SURF_DRAWTURB, SURF_DRAWSKY, surfaceLightmapDims } from "./gl_model";
import { type LightgridT, lookupLightgrid } from "../qcommon/bspx";
import { GL_UsingPerPixelLighting, MAX_SHADER_LIGHTS } from "./gl_shader";

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

    if (surf.decoupledLm) {
      // q2repro's src/common/bsp.c BSP_RecursiveLightPoint samples every
      // face (classic or decoupled) via lm_axis/lm_offset/lm_width/
      // lm_height unconditionally, and never references surf->texinfo at
      // all for that -- this branch matches that: it runs BEFORE the
      // `!tex` guard below (a decoupled face's lm_axis/lm_offset stand
      // fully on their own, same as q2repro's reference). This port keeps
      // the classic branch below byte-for-byte and only substitutes this
      // selection for a DECOUPLED_LM face. Sampling stays nearest-neighbor
      // (matching this function's classic branch, not q2repro's bilinear
      // GL_SampleLightPoint) -- see gl_model.ts's MsurfaceT.decoupledLm.
      const dlm = surf.decoupledLm;
      const ds = DotProduct(mid, dlm.axis[0]) + dlm.offset[0];
      const dt = DotProduct(mid, dlm.axis[1]) + dlm.offset[1];

      if (ds < 0 || ds > dlm.width - 1) continue;
      if (dt < 0 || dt > dlm.height - 1) continue;

      if (!surf.samples) return 0;

      const s = ds | 0;
      const t = dt | 0;

      const lightmap = surf.samples;
      VectorCopy(vec3_origin, pointcolor);

      let lightmapOffset = 3 * (t * dlm.width + s);
      for (let maps = 0; maps < MAXLIGHTMAPS && surf.styles[maps] !== 255; maps++) {
        const scale = vec3();
        const style = r_newrefdef.lightstyles[surf.styles[maps]];
        const modulate = glCvars.gl_modulate ? glCvars.gl_modulate.value : 1;
        for (let i2 = 0; i2 < 3; i2++) scale[i2] = modulate * style.rgb[i2];

        pointcolor[0] += lightmap[lightmapOffset + 0] * scale[0] * (1.0 / 255);
        pointcolor[1] += lightmap[lightmapOffset + 1] * scale[1] * (1.0 / 255);
        pointcolor[2] += lightmap[lightmapOffset + 2] * scale[2] * (1.0 / 255);

        lightmapOffset += 3 * dlm.width * dlm.height;
      }

      return 1;
    }

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

function lerpVector2(a: Vec3, b: Vec3, t0: number, t1: number, out: Vec3): void {
  // q2repro inc/shared/shared.h: #define LerpVector2(a,b,c,d,e) ((e)[0]=(c)*(a)[0]+(d)*(b)[0], ...)
  out[0] = t0 * a[0] + t1 * b[0];
  out[1] = t0 * a[1] + t1 * b[1];
  out[2] = t0 * a[2] + t1 * b[2];
}

/*
===============
LightGridPoint

Ported from q2repro's src/refresh/world.c GL_LightGridPoint: looks up the
8 octree samples surrounding `start` via qcommon/bspx.ts's lookupLightgrid
(the TS port of BSP_LookupLightgrid), averages over any occluded corners,
then trilinearly interpolates across the cube. Returns false (leaving
`color` untouched) when the grid is empty, gl_lightgrid is off, or every
corner sample is occluded -- callers fall back to the classic per-face
lightmap sample in that case, matching GL_LightPoint_'s call order.

DEVIATION (rule 16/17, documented): the C GL_LightGridPoint ends with
`GL_AdjustColor(color)`, which folds in q2repro's per-pixel-lighting
infrastructure (gl_static.entity_modulate, lm.add/lm.scale) that this
vanilla-derived renderer never ported (gl_light.ts has no equivalent
state). This port keeps only GL_AdjustColor's final `VectorScale(color,
1/255, color)` step, which brings the grid's raw byte-range samples into
the same units RecursiveLightPoint's classic branch already uses for
`pointcolor` (that branch's own texel accumulation multiplies by
`(1.0 / 255)` inline). This keeps the two branches' outputs on a
consistent scale for the dlight-add and gl_modulate steps that follow in
R_LightPoint, at the cost of dropping q2repro's extra per-pixel-lighting
brightness adjustment (which has no observable effect here since this
renderer has no per-pixel-lighting path to modulate).

ROOT-CAUSE FIX (overbright LIGHTGRID_OCTREE lighting, .orch/followups.md
"overbright model lighting" item): q2repro's GL_LightGridPoint multiplies
each raw grid sample by `style->white` (src/refresh/world.c:101), and in
q2repro that field is a single MONOCHROME per-style intensity written
verbatim by its own `V_AddLightStyle(style, value)`
(q2repro src/client/view.c:217-223) from `CL_AddLightStyles`'s
char-to-float map (q2repro src/client/effects.c:74:
`(c-'a')/('m'-'a')`, full-bright 'm' == 1.0, range ~0..2.08).

This port's `LightstyleT.white` is NOT that value -- it is vanilla's
`ls->white = r+g+b` (quake-2-c client/cl_view.c:138, kept byte-for-byte
in this port's V_AddLightStyle, cl_view.ts). Vanilla's own
`CL_RunLightStyles` (quake-2-c client/cl_fx.c:77-88, ported unchanged as
CL_RunLightStyles in cl_fx.ts) always sets `value[0]=value[1]=value[2]`
equal, so `white` is exactly 3x q2repro's monochrome value (full-bright
white == 3, not 1). Every OTHER vanilla-derived consumer of `.white`
(R_SetCacheState/this file, gl_rsurf.ts's cached_light comparisons,
ref_soft's r_surf.ts lightadj*128) only uses it as an opaque
change-detection key or an already-vanilla-scaled multiplier, so the x3
is harmless there -- it is faithful to vanilla. But THIS function was
ported from q2repro, which expects the un-tripled monochrome value, so
using `style.white` here over-brightened every LIGHTGRID_OCTREE sample by
~3x (compounding further with multiple stacked light styles per grid
corner, and with any single style's map value above 1.0 for
'n'..'z' chars) -- this is q2repro's own `.orch/followups.md`-reported
"shadelight up to ~5.6 vs vanilla's <=~1" defect.

Fix: use `style.rgb[0]` instead of `style.white`. CL_RunLightStyles's
r=g=b invariant (the only call site, cl_fx.ts:490) means `rgb[0]` always
holds the exact un-tripled per-style value q2repro's `style->white`
would hold -- restoring parity with q2repro's observable brightness
without touching vanilla's own `.white` semantics (still needed
unmodified by the other consumers listed above).
===============
*/
export function LightGridPoint(grid: LightgridT, start: Vec3, color: Vec3): boolean {
  if (!grid.numleafs || !(glCvars.gl_lightgrid && glCvars.gl_lightgrid.value)) return false;

  const point = vec3((start[0] - grid.mins[0]) * grid.scale[0], (start[1] - grid.mins[1]) * grid.scale[1], (start[2] - grid.mins[2]) * grid.scale[2]);

  // C: `VectorCopy(point, point_i)` assigns float vec3_t into a uint32_t[3]
  // -- an implicit truncating conversion. Grid-relative points are expected
  // non-negative, so Math.trunc reproduces that truncation; an out-of-range
  // negative point simply misses lookupLightgrid's bounds check below,
  // matching the C lookup's own failure mode for out-of-grid points.
  const point_i: [number, number, number] = [Math.trunc(point[0]), Math.trunc(point[1]), Math.trunc(point[2])];

  const samples: Vec3[] = [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()];
  const avg = vec3();
  let mask = 0;
  let numsamples = 0;

  for (let i = 0; i < 8; i++) {
    const tmp: [number, number, number] = [point_i[0] + ((i >> 0) & 1), point_i[1] + ((i >> 1) & 1), point_i[2] + ((i >> 2) & 1)];

    const s = lookupLightgrid(grid, tmp);
    if (!s) continue;

    let j = 0;
    for (; j < grid.numstyles && s[j].style !== 255; j++) {
      const style = r_newrefdef.lightstyles[s[j].style];
      if (!style) break;
      // style.rgb[0] (== rgb[1] == rgb[2] by CL_RunLightStyles's r=g=b
      // invariant), NOT style.white (== r+g+b, vanilla's un-normalized
      // sum -- see this function's header comment for the full citation).
      VectorMA(samples[i], style.rgb[0], vec3(s[j].rgb[0], s[j].rgb[1], s[j].rgb[2]), samples[i]);
    }

    // count non-occluded samples
    if (j) {
      mask |= 1 << i;
      VectorAdd(avg, samples[i], avg);
      numsamples++;
    }
  }

  if (!mask) return false;

  // replace occluded samples with average
  if (mask !== 255) {
    VectorScale(avg, 1.0 / numsamples, avg);
    for (let i = 0; i < 8; i++) {
      if (!(mask & (1 << i))) VectorCopy(avg, samples[i]);
    }
  }

  // trilinear interpolation
  const fx = point[0] - point_i[0];
  const fy = point[1] - point_i[1];
  const fz = point[2] - point_i[2];

  const bx = 1.0 - fx;
  const by = 1.0 - fy;
  const bz = 1.0 - fz;

  const lerp_x: Vec3[] = [vec3(), vec3(), vec3(), vec3()];
  const lerp_y: Vec3[] = [vec3(), vec3()];

  lerpVector2(samples[0], samples[1], bx, fx, lerp_x[0]);
  lerpVector2(samples[2], samples[3], bx, fx, lerp_x[1]);
  lerpVector2(samples[4], samples[5], bx, fx, lerp_x[2]);
  lerpVector2(samples[6], samples[7], bx, fx, lerp_x[3]);

  lerpVector2(lerp_x[0], lerp_x[1], by, fy, lerp_y[0]);
  lerpVector2(lerp_x[2], lerp_x[3], by, fy, lerp_y[1]);

  lerpVector2(lerp_y[0], lerp_y[1], bz, fz, color);

  // GL_AdjustColor's final normalization step only -- see the deviation
  // note in this function's header comment.
  VectorScale(color, 1.0 / 255, color);

  return true;
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

  // q2repro's GL_LightPoint_ always runs its BSP trace first (for
  // lightspot/lightplane side effects, mirrored above by
  // RecursiveLightPoint), then tries LIGHTGRID_OCTREE BEFORE falling back
  // to the trace's own per-face lightmap sample (GL_SampleLightPoint,
  // mirrored by RecursiveLightPoint's `pointcolor` here).
  const grid = r_worldmodel.bspx ? r_worldmodel.bspx.lightgrid : null;
  if (grid && LightGridPoint(grid, p, color)) {
    // grid hit -- color already filled in by LightGridPoint.
  } else if (r === -1) VectorCopy(vec3_origin, color);
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

// Vanilla sized this 34*34*3 (headroom over the classic 256-unit extents
// cap, max smax/tmax ~17). Bumped to 128*128*3 to cover DECOUPLED_LM faces,
// whose lm_width/lm_height come straight from the BSPX lump instead of the
// 256-unit-extents-derived grid (real rerelease data: up to 32x36 -- a
// single FACE's own lightmap dimensions, unrelated to and much smaller than
// gl_rsurf.ts's BLOCK_WIDTH/BLOCK_HEIGHT, the shared ATLAS page a face's
// lightmap gets packed into via GL_CreateSurfaceLightmap/surfaceLightmapDims;
// this buffer's cap tracks the former, not the latter, and doesn't need to
// grow when the atlas page size does).
const s_blocklights = new Float32Array(128 * 128 * 3);

/*
===============
R_AddDynamicLights

NOTE: this still iterates the classic texinfo-vecs/texturemins/16-unit grid
(smax/tmax below, NOT surfaceLightmapDims) even for a DECOUPLED_LM face --
q2repro's dynamic-light equivalent is architecturally per-vertex
(GL_SampleLightPoint from vbo texcoords), not a grid walk like this one, so
there is no reference selection logic to port here. The practical effect is
a dynamic light's glow falls off using the surface's classic-extents grid
placement rather than the decoupled lightmap's texel grid -- a minor visual
inaccuracy on decoupled surfaces (dynamic light halo slightly misaligned),
not a bounds or crash risk (this loop's own smax/tmax stay within
s_blocklights regardless, since the copy loop in R_BuildLightMap below is
the one iterating the (possibly larger) decoupled dimensions). The primary
goal -- correct STATIC baked lighting on decoupled maps -- is unaffected.
*/
function R_AddDynamicLights(surf: MsurfaceT): void {
  const smax = (surf.extents[0] >> 4) + 1;
  const tmax = (surf.extents[1] >> 4) + 1;
  const tex = surf.texinfo;
  const plane = surf.plane;
  if (!tex || !plane) return;

  // A dynamic light must be applied exactly once. When the per-pixel
  // lighting shader is live it already applies the first MAX_SHADER_LIGHTS
  // dlights per fragment (gl_shader.ts's calc_dynamic_lights), so baking
  // those same lights into the lightmap here would double them -- and
  // because the classic path only touches surfaces R_MarkLights flagged,
  // the doubling stops at surface boundaries and paints hard-edged
  // polygon-shaped brightness steps across otherwise flat walls (reproduced
  // live on base1's dyn_target_01 cone light; `gl_dynamic 0` made them
  // vanish while the per-pixel lighting stayed).
  //
  // q2repro guards the equivalent call with a blanket
  // `!gl_backend->use_per_pixel_lighting()` (surf.c:243). This port skips
  // only the light INDICES the shader actually covers instead: q2repro's
  // GLSL array is sized to its full MAX_DLIGHTS, whereas MAX_SHADER_LIGHTS
  // here is 8, so a blanket skip would silently drop the 9th and later
  // dlights from world surfaces entirely rather than merely un-doubling
  // them. Documented departure, strictly narrower than the reference's.
  const perPixelHandled = GL_UsingPerPixelLighting() ? Math.min(r_newrefdef.num_dlights, MAX_SHADER_LIGHTS) : 0;

  for (let lnum = 0; lnum < r_newrefdef.num_dlights; lnum++) {
    if (lnum < perPixelHandled) continue; // already applied per-fragment by the shader
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

  const [smax, tmax] = surfaceLightmapDims(surf);
  const size = smax * tmax;
  // C: sizeof(s_blocklights)>>4 -- BYTES, not element count (this port's
  // enlarged buffer makes that (128*128*3*4)>>4 = 12288, not vanilla's 867
  // -- see s_blocklights's own comment for why. Still a genuine backstop:
  // a face whose lightmap is bigger than the shared atlas block itself
  // (BLOCK_WIDTH*BLOCK_HEIGHT) can never legitimately fit here).
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
