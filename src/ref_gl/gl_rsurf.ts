/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_rsurf.c (GNU GPL v2 or later): brush-model drawing
(R_RenderBrushPoly, R_DrawAlphaSurfaces, R_DrawInlineBModel/R_DrawBrushModel),
world drawing (R_RecursiveWorldNode/R_DrawWorld, R_MarkLeaves), the lightmap
allocator (LM_InitBlock/LM_UploadBlock/LM_AllocBlock), and the lightmap
build pipeline (GL_BuildPolygonFromSurface, GL_CreateSurfaceLightmap,
GL_BeginBuildingLightmaps/GL_EndBuildingLightmaps).

Internal helpers not declared in gl_local.h (R_TextureAnimation, DrawGLPoly,
DrawGLFlowingPoly, R_DrawTriangleOutlines, DrawGLPolyChain, R_BlendLightmaps,
DrawTextureChains, GL_RenderLightmappedPoly, R_DrawInlineBModel,
R_RecursiveWorldNode) stay module-private except where this unit's own
functions need to call them across the exported surface (R_BlendLightmaps
and R_RecursiveWorldNode are both named in the brief, so both are exported).

Dropped `#if 0` block (PORTING.md: "#if 0 blocks are dropped silently"):
WaterWarpPolyVerts/DrawGLWaterPoly/DrawGLWaterPolyLightmap are `#if 0`'d out
in the real gl_rsurf.c (dead code, superseded by gl_warp.ts's EmitWaterPolys
sin-table warp) -- not ported. The previous pending-stub file exported a
`WaterWarpPolyVerts` throwing a pending-stub error; removed, since it does not
correspond to any compiled C code.

gl_rmain.c's R_CullBox/R_RotateForEntity are imported from gl_rmain.ts
(landed after this unit; the original concurrent-port caveats are gone).

Extension-availability null-checks (`if (qglMTexCoord2fSGIS)`, `if
(qglSelectTextureSGIS)`) are kept as literal `qgl.qglMTexCoord2fSGIS` /
`qgl.qglSelectTextureSGIS` truthiness reads, matching gl_warp.ts's identical
note: QGL's interface makes these always-present, so both branches are
ported in full but the "unavailable" branch is dead code today.

GL_BuildPolygonFromSurface (and GL_SubdivideSurface in gl_warp.ts) originally
Hunk_Alloc a `glpoly_t` sized to fit its vertex count; gl_model.ts's GlpolyT
is already redesigned (see that file's header comment) as a growable
`Float32Array[]` rather than a fixed C flexible-array-member struct, so no
Hunk_Alloc call is needed or made here -- `new GlpolyT()` plus a plain array
build reproduces the same populated fields. Hunk_Alloc itself remains an
not used by this file (see gl_model.ts's header).

QGL binding: `qgl`/`SetQGL` are owned by gl_image.ts (a concurrently-ported
sibling that landed mid-unit; see that file's header comment) and imported
here directly, same as gl_warp.ts does.

R_MarkLeaves's `((int*)fatvis)[i] |= ((int*)vis)[i]` word-at-a-time PVS
merge is ported as an equivalent byte-at-a-time OR over the same byte range
(identical resulting bits; avoids requiring the Uint8Array Mod_ClusterPVS
returns to be 4-byte aligned for a Uint32Array view).
*/

import { type Vec3, vec3, DotProduct, VectorAdd, VectorSubtract, VectorCopy, AngleVectors } from "../shared/math";
import { SURF_SKY, SURF_TRANS33, SURF_TRANS66, SURF_FLOWING, SURF_WARP, RF_TRANSLUCENT, RDF_NOWORLDMODEL, CONTENTS_SOLID, ERR_DROP, ERR_FATAL } from "../shared/q_shared";
import { PLANE_X, PLANE_Y, PLANE_Z, MAX_MAP_LEAFS } from "../qcommon/qfiles";
import { EntityT, LightstyleT, MAX_LIGHTSTYLES } from "../client/ref";
import {
  GlpolyT,
  VERTEXSIZE,
  MAXLIGHTMAPS,
  SURF_PLANEBACK,
  SURF_DRAWSKY,
  SURF_DRAWTURB,
  isMleaf,
  Mod_ClusterPVS,
  surfaceLightmapDims,
  type MsurfaceT,
  type MtexinfoT,
  type MnodeOrLeaf,
  type ModelT,
} from "./gl_model";
import {
  gl_state,
  r_newrefdef,
  r_world_matrix,
  glCvars,
  ri,
  gltextures,
  numgltextures,
  TEXNUM_LIGHTMAPS,
  BACKFACE_EPSILON,
  gl_tex_alpha_format,
  gl_tex_solid_format,
  r_worldmodel,
  currentmodel,
  currententity,
  SetCurrentModel,
  SetCurrentEntity,
  r_framecount,
  SetFrameCount,
  r_visframecount,
  SetVisFrameCount,
  c_brush_polys,
  SetBrushPolys,
  c_visible_lightmaps,
  c_visible_textures,
  SetVisibleCounts,
  r_viewcluster,
  r_viewcluster2,
  r_oldviewcluster,
  r_oldviewcluster2,
  SetViewClusters,
  type ImageT,
} from "./gl_local";
import { GL_Bind, GL_TexEnv, GL_EnableMultitexture, GL_SelectTexture, GL_MBind, qgl } from "./gl_image";
import { GL_UsingShaderPath, GL_UseWorldSurfaceProgram, GL_RestoreFixedFunction } from "./gl_shader";
import { EmitWaterPolys, R_AddSkySurface, R_ClearSkyBox, R_DrawSkyBox } from "./gl_warp";
import { R_BuildLightMap, R_MarkLights, R_SetCacheState } from "./gl_light";
import { R_CullBox, R_RotateForEntity } from "./gl_rmain";

// standard OpenGL 1.1/1.2 enum values (`<GL/gl.h>`) plus the SGIS
// multitexture extension's (qgl.h) -- see gl_warp.ts's identical note.
const GL_LINE_STRIP = 0x0003;
const GL_POLYGON = 0x0009;
const GL_TEXTURE_2D = 0x0de1;
const GL_DEPTH_TEST = 0x0b71;
const GL_BLEND = 0x0be2;
const GL_ZERO = 0;
const GL_ONE = 1;
const GL_SRC_COLOR = 0x0300;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_MODULATE = 0x2100;
const GL_REPLACE = 0x1e01;
const GL_RGBA = 0x1908;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_LINEAR = 0x2601;
const GL_INTENSITY8 = 0x804b;
const GL_LUMINANCE8 = 0x8040;
const GL_TEXTURE0_SGIS = 0x835e;
const GL_TEXTURE1_SGIS = 0x835f;

const LIGHTMAP_BYTES = 4;
// Lightmap atlas page size. Vanilla hardcoded this at 128x128. q2repro's
// LM_BeginBuilding (src/refresh/surf.c) instead sizes it per map: "use
// larger lightmaps for DECOUPLED_LM maps" --
//   bits = gl_lightmap_bits->integer ? Cvar_ClampInteger(...) : 8 + bsp->lm_decoupled * 2;
//   bits = min(bits, gl_config.max_texture_size_log2);
//   lm.block_size = 1 << bits;
// i.e. q2repro's own baseline is already 256x256 for every map (classic or
// not) and 1024x1024 for a BSPX DECOUPLED_LM one. This port keeps vanilla's
// 128x128 baseline for a classic (non-DECOUPLED_LM) map instead of adopting
// q2repro's 256 floor -- verified against retail that no non-DECOUPLED_LM
// map needs it (every one of the 11 Call of the Machine mgu*.bsp maps that
// overflows MAX_LIGHTMAPS below -- mgu1m1/2m1/2m3/3m1/3m2/3m3/4m1/4m2/4m3/
// 5m1/5m2 -- carries a DECOUPLED_LM BSPX lump; none of the 17 that already
// pass do), and unconditionally doubling the classic baseline turned out to
// break existing fixture tests (test/lightgrid_q64.test.ts/
// test/bspx_renderer.test.ts) that build a plain non-decoupled model via
// GL_BeginBuildingLightmaps and assert against the vanilla 128 constant --
// changing a value nothing needed isn't a faithful "lift to match", it's an
// unrelated behavior change with a test-visible regression. Only the
// DECOUPLED_LM case (bits=10, 1024x1024) is adopted from q2repro's formula.
// GL_BeginBuildingLightmaps recomputes this from the model's own
// loadmodel.bspx.decoupledLm presence (this port's equivalent of q2repro's
// bsp->lm_decoupled) each time a map loads.
//
// This port has no gl_lightmap_bits cvar and no live GL_MAX_TEXTURE_SIZE
// query wired into this file's territory (that lives in gl_rmain.ts/qgl.ts,
// out of scope here) -- the clamp is simply q2repro's own pre-clamp value
// for the DECOUPLED_LM case (1024), which is safely within the OpenGL
// spec's guaranteed minimum GL_MAX_TEXTURE_SIZE (1024 since GL 1.2, 2048
// since GL 1.3) on any real driver.
let BLOCK_WIDTH = 128;
let BLOCK_HEIGHT = 128;
const MAX_LIGHTMAPS = 128;
const GL_LIGHTMAP_FORMAT = GL_RGBA;

class GlLightmapStateT {
  internal_format = 0;
  current_lightmap_texture = 0;
  lightmap_surfaces: (MsurfaceT | null)[] = new Array(MAX_LIGHTMAPS).fill(null);
  allocated: number[] = new Array(BLOCK_WIDTH).fill(0);
  lightmap_buffer: Uint8Array = new Uint8Array(LIGHTMAP_BYTES * BLOCK_WIDTH * BLOCK_HEIGHT);
}
const gl_lms = new GlLightmapStateT();

// relative to viewpoint
const modelorg: Vec3 = vec3();

export let r_alpha_surfaces: MsurfaceT | null = null;

/*
=============================================================

	BRUSH MODELS

=============================================================
*/

/*
===============
R_TextureAnimation

Returns the proper texture for a given time and base texture
===============
*/
function R_TextureAnimation(tex: MtexinfoT | null): ImageT | null {
  if (!tex) return null;
  if (!tex.next) return tex.image;

  const frame = currententity ? currententity.frame : 0;
  let c = tex.numframes > 0 ? frame % tex.numframes : 0;
  let t = tex;
  while (c > 0 && t.next) {
    t = t.next;
    c--;
  }
  return t.image;
}

function DrawGLPoly(p: GlpolyT): void {
  qgl.qglBegin(GL_POLYGON);
  for (let i = 0; i < p.numverts; i++) {
    const v = p.verts[i];
    qgl.qglTexCoord2f(v[3], v[4]);
    qgl.qglVertex3fv(v);
  }
  qgl.qglEnd();
}

//============
//PGM
/*
================
DrawGLFlowingPoly -- version of DrawGLPoly that handles scrolling texture
================
*/
function DrawGLFlowingPoly(fa: MsurfaceT): void {
  const p = fa.polys;
  if (!p) return;

  let scroll = -64 * (r_newrefdef.time / 40.0 - Math.trunc(r_newrefdef.time / 40.0));
  if (scroll === 0.0) scroll = -64.0;

  qgl.qglBegin(GL_POLYGON);
  for (let i = 0; i < p.numverts; i++) {
    const v = p.verts[i];
    qgl.qglTexCoord2f(v[3] + scroll, v[4]);
    qgl.qglVertex3fv(v);
  }
  qgl.qglEnd();
}
//PGM
//============

/*
** R_DrawTriangleOutlines
*/
function R_DrawTriangleOutlines(): void {
  if (!glCvars.gl_showtris || !glCvars.gl_showtris.value) return;

  qgl.qglDisable(GL_TEXTURE_2D);
  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglColor4f(1, 1, 1, 1);

  for (let i = 0; i < MAX_LIGHTMAPS; i++) {
    for (let surf = gl_lms.lightmap_surfaces[i]; surf; surf = surf.lightmapchain) {
      for (let p = surf.polys; p; p = p.chain) {
        for (let j = 2; j < p.numverts; j++) {
          qgl.qglBegin(GL_LINE_STRIP);
          qgl.qglVertex3fv(p.verts[0]);
          qgl.qglVertex3fv(p.verts[j - 1]);
          qgl.qglVertex3fv(p.verts[j]);
          qgl.qglVertex3fv(p.verts[0]);
          qgl.qglEnd();
        }
      }
    }
  }

  qgl.qglEnable(GL_DEPTH_TEST);
  qgl.qglEnable(GL_TEXTURE_2D);
}

/*
** DrawGLPolyChain
*/
function DrawGLPolyChain(pIn: GlpolyT | null, soffset: number, toffset: number): void {
  if (soffset === 0 && toffset === 0) {
    for (let p = pIn; p; p = p.chain) {
      qgl.qglBegin(GL_POLYGON);
      for (let j = 0; j < p.numverts; j++) {
        const v = p.verts[j];
        qgl.qglTexCoord2f(v[5], v[6]);
        qgl.qglVertex3fv(v);
      }
      qgl.qglEnd();
    }
  } else {
    for (let p = pIn; p; p = p.chain) {
      qgl.qglBegin(GL_POLYGON);
      for (let j = 0; j < p.numverts; j++) {
        const v = p.verts[j];
        qgl.qglTexCoord2f(v[5] - soffset, v[6] - toffset);
        qgl.qglVertex3fv(v);
      }
      qgl.qglEnd();
    }
  }
}

/*
================
R_BlendLightMaps

This routine takes all the given light mapped surfaces in the world and
blends them into the framebuffer.
================
*/
export function R_BlendLightmaps(): void {
  // don't bother if we're set to fullbright
  if (glCvars.r_fullbright && glCvars.r_fullbright.value) return;
  if (!r_worldmodel || !r_worldmodel.lightdata) return;

  // task #25 (v1.1.0): activate the per-pixel dynamic-light shader for this
  // pass when available. Quake 2 world surfaces are planar, so each
  // surface's plane normal (set via qglNormal3f at each DrawGLPolyChain
  // call site below) is exact, not an approximation; no-op (false) when
  // the shader path isn't active, leaving every draw call below byte-
  // identical to the pre-existing fixed-function behavior.
  const usingShader = GL_UsingShaderPath() && GL_UseWorldSurfaceProgram(r_newrefdef.dlights, r_newrefdef.num_dlights);

  // don't bother writing Z
  qgl.qglDepthMask(false);

  // set the appropriate blending mode unless we're only looking at the lightmaps.
  if (!glCvars.gl_lightmap || !glCvars.gl_lightmap.value) {
    qgl.qglEnable(GL_BLEND);

    if (glCvars.gl_saturatelighting && glCvars.gl_saturatelighting.value) {
      qgl.qglBlendFunc(GL_ONE, GL_ONE);
    } else {
      const mono = glCvars.gl_monolightmap ? glCvars.gl_monolightmap.string.charAt(0) : "0";
      if (mono !== "0") {
        switch (mono.toUpperCase()) {
          case "I":
            qgl.qglBlendFunc(GL_ZERO, GL_SRC_COLOR);
            break;
          case "L":
            qgl.qglBlendFunc(GL_ZERO, GL_SRC_COLOR);
            break;
          case "A":
          default:
            qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
            break;
        }
      } else {
        qgl.qglBlendFunc(GL_ZERO, GL_SRC_COLOR);
      }
    }
  }

  if (currentmodel === r_worldmodel) SetVisibleCounts(0, c_visible_textures);

  // render static lightmaps first
  for (let i = 1; i < MAX_LIGHTMAPS; i++) {
    if (gl_lms.lightmap_surfaces[i]) {
      if (currentmodel === r_worldmodel) SetVisibleCounts(c_visible_lightmaps + 1, c_visible_textures);
      GL_Bind(gl_state.lightmap_textures + i);

      for (let surf = gl_lms.lightmap_surfaces[i]; surf; surf = surf.lightmapchain) {
        if (surf.polys) {
          if (usingShader && surf.plane) qgl.qglNormal3f(surf.plane.normal[0], surf.plane.normal[1], surf.plane.normal[2]);
          DrawGLPolyChain(surf.polys, 0, 0);
        }
      }
    }
  }

  let newdrawsurf: MsurfaceT | null = null;

  // render dynamic lightmaps
  if (glCvars.gl_dynamic && glCvars.gl_dynamic.value) {
    LM_InitBlock();

    GL_Bind(gl_state.lightmap_textures + 0);

    if (currentmodel === r_worldmodel) SetVisibleCounts(c_visible_lightmaps + 1, c_visible_textures);

    newdrawsurf = gl_lms.lightmap_surfaces[0];

    for (let surf = gl_lms.lightmap_surfaces[0]; surf; surf = surf.lightmapchain) {
      const [smax, tmax] = surfaceLightmapDims(surf);

      const alloc = LM_AllocBlock(smax, tmax);
      if (alloc.ok) {
        surf.dlight_s = alloc.x;
        surf.dlight_t = alloc.y;

        const offset = (surf.dlight_t * BLOCK_WIDTH + surf.dlight_s) * LIGHTMAP_BYTES;
        R_BuildLightMap(surf, gl_lms.lightmap_buffer.subarray(offset), BLOCK_WIDTH * LIGHTMAP_BYTES);
      } else {
        // upload what we have so far
        LM_UploadBlock(true);

        // draw all surfaces that use this lightmap
        let drawsurf = newdrawsurf;
        for (; drawsurf && drawsurf !== surf; drawsurf = drawsurf.lightmapchain) {
          if (drawsurf.polys) {
            if (usingShader && drawsurf.plane) qgl.qglNormal3f(drawsurf.plane.normal[0], drawsurf.plane.normal[1], drawsurf.plane.normal[2]);
            DrawGLPolyChain(drawsurf.polys, (drawsurf.light_s - drawsurf.dlight_s) * (1.0 / BLOCK_WIDTH), (drawsurf.light_t - drawsurf.dlight_t) * (1.0 / BLOCK_HEIGHT));
          }
        }

        newdrawsurf = drawsurf;

        // clear the block
        LM_InitBlock();

        // try uploading the block now
        const retry = LM_AllocBlock(smax, tmax);
        if (!retry.ok) {
          ri.Sys_Error(ERR_FATAL, `Consecutive calls to LM_AllocBlock(${smax},${tmax}) failed (dynamic)\n`);
        }
        surf.dlight_s = retry.x;
        surf.dlight_t = retry.y;

        const offset = (surf.dlight_t * BLOCK_WIDTH + surf.dlight_s) * LIGHTMAP_BYTES;
        R_BuildLightMap(surf, gl_lms.lightmap_buffer.subarray(offset), BLOCK_WIDTH * LIGHTMAP_BYTES);
      }
    }

    // draw remainder of dynamic lightmaps that haven't been uploaded yet
    if (newdrawsurf) LM_UploadBlock(true);

    for (let surf = newdrawsurf; surf; surf = surf.lightmapchain) {
      if (surf.polys) {
        if (usingShader && surf.plane) qgl.qglNormal3f(surf.plane.normal[0], surf.plane.normal[1], surf.plane.normal[2]);
        DrawGLPolyChain(surf.polys, (surf.light_s - surf.dlight_s) * (1.0 / BLOCK_WIDTH), (surf.light_t - surf.dlight_t) * (1.0 / BLOCK_HEIGHT));
      }
    }
  }

  if (usingShader) GL_RestoreFixedFunction();

  // restore state
  qgl.qglDisable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglDepthMask(true);
}

/*
================
R_RenderBrushPoly
================
*/
export function R_RenderBrushPoly(fa: MsurfaceT): void {
  SetBrushPolys(c_brush_polys + 1);

  const image = R_TextureAnimation(fa.texinfo);

  if (fa.flags & SURF_DRAWTURB) {
    if (image) GL_Bind(image.texnum);

    // warp texture, no lightmaps
    GL_TexEnv(GL_MODULATE);
    qgl.qglColor4f(gl_state.inverse_intensity, gl_state.inverse_intensity, gl_state.inverse_intensity, 1.0);
    EmitWaterPolys(fa);
    GL_TexEnv(GL_REPLACE);

    return;
  } else {
    if (image) GL_Bind(image.texnum);
    GL_TexEnv(GL_REPLACE);
  }

  //======
  //PGM
  if (fa.texinfo && fa.texinfo.flags & SURF_FLOWING) {
    DrawGLFlowingPoly(fa);
  } else if (fa.polys) {
    DrawGLPoly(fa.polys);
  }
  //PGM
  //======

  // check for lightmap modification
  let maps = 0;
  let enteredDynamicBlock = false;
  for (; maps < MAXLIGHTMAPS && fa.styles[maps] !== 255; maps++) {
    const style = r_newrefdef.lightstyles[fa.styles[maps]];
    if (style && style.white !== fa.cached_light[maps]) {
      enteredDynamicBlock = true;
      break;
    }
  }

  // dynamic this frame or dynamic previously
  if (!enteredDynamicBlock && fa.dlightframe === r_framecount) {
    enteredDynamicBlock = true;
  }

  let isDynamic = false;
  if (enteredDynamicBlock) {
    if (glCvars.gl_dynamic && glCvars.gl_dynamic.value) {
      if (fa.texinfo && !(fa.texinfo.flags & (SURF_SKY | SURF_TRANS33 | SURF_TRANS66 | SURF_WARP))) {
        isDynamic = true;
      }
    }
  }

  if (isDynamic) {
    // NOTE: when `maps` reached MAXLIGHTMAPS via the dlightframe path (no
    // early break above), C reads `fa->styles[MAXLIGHTMAPS]` -- one past
    // the array, aliasing adjacent struct memory as an implementation
    // accident. `fa.styles[maps]` here is simply `undefined` in that case,
    // which fails both comparisons below exactly like an out-of-range style
    // byte would in every real, non-corrupted case.
    if ((fa.styles[maps] >= 32 || fa.styles[maps] === 0) && fa.dlightframe !== r_framecount) {
      const [smax, tmax] = surfaceLightmapDims(fa);
      // 34*34 is vanilla's fixed relight scratch buffer, sized for the
      // classic 256-unit extents cap (max smax/tmax ~17); bumped to match
      // GL_RenderLightmappedPoly's sibling buffer below (128*128) so a
      // DECOUPLED_LM face's larger lm_width/lm_height (real rerelease data:
      // up to 32x36) doesn't overrun it. R_BuildLightMap's own
      // "Bad s_blocklights size" check (gl_light.ts) is still the actual
      // backstop against a face too big for either buffer.
      const temp = new Uint32Array(128 * 128);

      R_BuildLightMap(fa, new Uint8Array(temp.buffer), smax * 4);
      R_SetCacheState(fa);

      GL_Bind(gl_state.lightmap_textures + fa.lightmaptexturenum);

      qgl.qglTexSubImage2D(GL_TEXTURE_2D, 0, fa.light_s, fa.light_t, smax, tmax, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, temp);

      fa.lightmapchain = gl_lms.lightmap_surfaces[fa.lightmaptexturenum];
      gl_lms.lightmap_surfaces[fa.lightmaptexturenum] = fa;
    } else {
      fa.lightmapchain = gl_lms.lightmap_surfaces[0];
      gl_lms.lightmap_surfaces[0] = fa;
    }
  } else {
    fa.lightmapchain = gl_lms.lightmap_surfaces[fa.lightmaptexturenum];
    gl_lms.lightmap_surfaces[fa.lightmaptexturenum] = fa;
  }
}

/*
================
R_DrawAlphaSurfaces

Draw water surfaces and windows.
The BSP tree is waled front to back, so unwinding the chain
of alpha_surfaces will draw back to front, giving proper ordering.
================
*/
export function R_DrawAlphaSurfaces(): void {
  // go back to the world matrix
  qgl.qglLoadMatrixf(r_world_matrix);

  qgl.qglEnable(GL_BLEND);
  GL_TexEnv(GL_MODULATE);

  // the textures are prescaled up for a better lighting range, so scale it back down
  const intens = gl_state.inverse_intensity;

  for (let s = r_alpha_surfaces; s; s = s.texturechain) {
    if (s.texinfo && s.texinfo.image) GL_Bind(s.texinfo.image.texnum);
    SetBrushPolys(c_brush_polys + 1);
    if (s.texinfo && s.texinfo.flags & SURF_TRANS33) qgl.qglColor4f(intens, intens, intens, 0.33);
    else if (s.texinfo && s.texinfo.flags & SURF_TRANS66) qgl.qglColor4f(intens, intens, intens, 0.66);
    else qgl.qglColor4f(intens, intens, intens, 1);

    if (s.flags & SURF_DRAWTURB) EmitWaterPolys(s);
    else if (s.polys) DrawGLPoly(s.polys);
  }

  GL_TexEnv(GL_REPLACE);
  qgl.qglColor4f(1, 1, 1, 1);
  qgl.qglDisable(GL_BLEND);

  r_alpha_surfaces = null;
}

/*
================
DrawTextureChains
================
*/
function DrawTextureChains(): void {
  SetVisibleCounts(c_visible_lightmaps, 0);

  if (!qgl.qglSelectTextureSGIS) {
    for (let i = 0; i < numgltextures; i++) {
      const image = gltextures[i];
      if (!image.registration_sequence) continue;
      const first = image.texturechain;
      if (!first) continue;
      SetVisibleCounts(c_visible_lightmaps, c_visible_textures + 1);

      for (let s: MsurfaceT | null = first; s; s = s.texturechain) R_RenderBrushPoly(s);

      image.texturechain = null;
    }
  } else {
    for (let i = 0; i < numgltextures; i++) {
      const image = gltextures[i];
      if (!image.registration_sequence) continue;
      if (!image.texturechain) continue;
      SetVisibleCounts(c_visible_lightmaps, c_visible_textures + 1);

      for (let s: MsurfaceT | null = image.texturechain; s; s = s.texturechain) {
        if (!(s.flags & SURF_DRAWTURB)) R_RenderBrushPoly(s);
      }
    }

    GL_EnableMultitexture(false);
    for (let i = 0; i < numgltextures; i++) {
      const image = gltextures[i];
      if (!image.registration_sequence) continue;
      const first = image.texturechain;
      if (!first) continue;

      for (let s: MsurfaceT | null = first; s; s = s.texturechain) {
        if (s.flags & SURF_DRAWTURB) R_RenderBrushPoly(s);
      }

      image.texturechain = null;
    }
  }

  GL_TexEnv(GL_REPLACE);
}

function drawMultitexturedChain(surf: MsurfaceT, nv: number): void {
  // only reached from GL_RenderLightmappedPoly, which already verified the
  // extension pointer (C calls through it blindly here)
  const mtexCoord = qgl.qglMTexCoord2fSGIS;
  if (!mtexCoord) return;
  const flowing = surf.texinfo !== null && (surf.texinfo.flags & SURF_FLOWING) !== 0;
  let scroll = 0;
  if (flowing) {
    scroll = -64 * (r_newrefdef.time / 40.0 - Math.trunc(r_newrefdef.time / 40.0));
    if (scroll === 0.0) scroll = -64.0;
  }

  for (let p = surf.polys; p; p = p.chain) {
    qgl.qglBegin(GL_POLYGON);
    for (let i = 0; i < nv; i++) {
      const v = p.verts[i];
      mtexCoord(GL_TEXTURE0_SGIS, v[3] + scroll, v[4]);
      mtexCoord(GL_TEXTURE1_SGIS, v[5], v[6]);
      qgl.qglVertex3fv(v);
    }
    qgl.qglEnd();
  }
}

function GL_RenderLightmappedPoly(surf: MsurfaceT): void {
  // only called from branches that verified qglMTexCoord2fSGIS (C calls blindly)
  const mtexCoord = qgl.qglMTexCoord2fSGIS;
  if (!mtexCoord) return;
  const nv = surf.polys ? surf.polys.numverts : 0;
  const image = R_TextureAnimation(surf.texinfo);
  let lmtex = surf.lightmaptexturenum;

  let map = 0;
  let enteredDynamicBlock = false;
  for (; map < MAXLIGHTMAPS && surf.styles[map] !== 255; map++) {
    const style = r_newrefdef.lightstyles[surf.styles[map]];
    if (style && style.white !== surf.cached_light[map]) {
      enteredDynamicBlock = true;
      break;
    }
  }
  if (!enteredDynamicBlock && surf.dlightframe === r_framecount) enteredDynamicBlock = true;

  let isDynamic = false;
  if (enteredDynamicBlock) {
    if (glCvars.gl_dynamic && glCvars.gl_dynamic.value) {
      if (surf.texinfo && !(surf.texinfo.flags & (SURF_SKY | SURF_TRANS33 | SURF_TRANS66 | SURF_WARP))) {
        isDynamic = true;
      }
    }
  }

  if (isDynamic) {
    const temp = new Uint32Array(128 * 128);
    let smax: number;
    let tmax: number;

    if ((surf.styles[map] >= 32 || surf.styles[map] === 0) && surf.dlightframe !== r_framecount) {
      [smax, tmax] = surfaceLightmapDims(surf);

      R_BuildLightMap(surf, new Uint8Array(temp.buffer), smax * 4);
      R_SetCacheState(surf);

      GL_MBind(GL_TEXTURE1_SGIS, gl_state.lightmap_textures + surf.lightmaptexturenum);
      lmtex = surf.lightmaptexturenum;

      qgl.qglTexSubImage2D(GL_TEXTURE_2D, 0, surf.light_s, surf.light_t, smax, tmax, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, temp);
    } else {
      [smax, tmax] = surfaceLightmapDims(surf);

      R_BuildLightMap(surf, new Uint8Array(temp.buffer), smax * 4);

      GL_MBind(GL_TEXTURE1_SGIS, gl_state.lightmap_textures + 0);
      lmtex = 0;

      qgl.qglTexSubImage2D(GL_TEXTURE_2D, 0, surf.light_s, surf.light_t, smax, tmax, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, temp);
    }
  }

  SetBrushPolys(c_brush_polys + 1);

  if (image) GL_MBind(GL_TEXTURE0_SGIS, image.texnum);
  GL_MBind(GL_TEXTURE1_SGIS, gl_state.lightmap_textures + lmtex);

  drawMultitexturedChain(surf, nv);
}

/*
=================
R_DrawInlineBModel
=================
*/
function R_DrawInlineBModel(): void {
  if (!currentmodel) return;

  // calculate dynamic lighting for bmodel
  if (!glCvars.gl_flashblend || !glCvars.gl_flashblend.value) {
    for (let k = 0; k < r_newrefdef.num_dlights; k++) {
      R_MarkLights(r_newrefdef.dlights[k], 1 << k, currentmodel.nodes[currentmodel.firstnode]);
    }
  }

  const translucent = currententity !== null && (currententity.flags & RF_TRANSLUCENT) !== 0;

  if (translucent) {
    qgl.qglEnable(GL_BLEND);
    qgl.qglColor4f(1, 1, 1, 0.25);
    GL_TexEnv(GL_MODULATE);
  }

  // draw texture
  for (let i = 0; i < currentmodel.nummodelsurfaces; i++) {
    const psurf = currentmodel.surfaces[currentmodel.firstmodelsurface + i];
    const pplane = psurf.plane;
    if (!pplane) continue;

    // find which side of the node we are on
    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if (((psurf.flags & SURF_PLANEBACK) !== 0 && dot < -BACKFACE_EPSILON) || ((psurf.flags & SURF_PLANEBACK) === 0 && dot > BACKFACE_EPSILON)) {
      if (psurf.texinfo && psurf.texinfo.flags & (SURF_TRANS33 | SURF_TRANS66)) {
        // add to the translucent chain
        psurf.texturechain = r_alpha_surfaces;
        r_alpha_surfaces = psurf;
      } else if (Boolean(qgl.qglMTexCoord2fSGIS) && !(psurf.flags & SURF_DRAWTURB)) {
        GL_RenderLightmappedPoly(psurf);
      } else {
        GL_EnableMultitexture(false);
        R_RenderBrushPoly(psurf);
        GL_EnableMultitexture(true);
      }
    }
  }

  if (!translucent) {
    if (!qgl.qglMTexCoord2fSGIS) R_BlendLightmaps();
  } else {
    qgl.qglDisable(GL_BLEND);
    qgl.qglColor4f(1, 1, 1, 1);
    GL_TexEnv(GL_REPLACE);
  }
}

/*
=================
R_DrawBrushModel
=================
*/
export function R_DrawBrushModel(e: EntityT): void {
  if (!currentmodel || currentmodel.nummodelsurfaces === 0) return;

  SetCurrentEntity(e);
  gl_state.currenttextures[0] = -1;
  gl_state.currenttextures[1] = -1;

  const mins = vec3();
  const maxs = vec3();
  let rotated: boolean;

  if (e.angles[0] || e.angles[1] || e.angles[2]) {
    rotated = true;
    for (let i = 0; i < 3; i++) {
      mins[i] = e.origin[i] - currentmodel.radius;
      maxs[i] = e.origin[i] + currentmodel.radius;
    }
  } else {
    rotated = false;
    VectorAdd(e.origin, currentmodel.mins, mins);
    VectorAdd(e.origin, currentmodel.maxs, maxs);
  }

  if (R_CullBox(mins, maxs)) return;

  qgl.qglColor3f(1, 1, 1);
  gl_lms.lightmap_surfaces.fill(null);

  VectorSubtract(r_newrefdef.vieworg, e.origin, modelorg);
  if (rotated) {
    const temp = vec3(modelorg[0], modelorg[1], modelorg[2]);
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(e.angles, forward, right, up);
    modelorg[0] = DotProduct(temp, forward);
    modelorg[1] = -DotProduct(temp, right);
    modelorg[2] = DotProduct(temp, up);
  }

  qgl.qglPushMatrix();
  e.angles[0] = -e.angles[0]; // stupid quake bug
  e.angles[2] = -e.angles[2]; // stupid quake bug
  R_RotateForEntity(e);
  e.angles[0] = -e.angles[0]; // stupid quake bug
  e.angles[2] = -e.angles[2]; // stupid quake bug

  GL_EnableMultitexture(true);
  GL_SelectTexture(GL_TEXTURE0_SGIS);
  GL_TexEnv(GL_REPLACE);
  GL_SelectTexture(GL_TEXTURE1_SGIS);
  GL_TexEnv(GL_MODULATE);

  R_DrawInlineBModel();
  GL_EnableMultitexture(false);

  qgl.qglPopMatrix();
}

/*
=============================================================

	WORLD MODEL

=============================================================
*/

/*
================
R_RecursiveWorldNode
================
*/
export function R_RecursiveWorldNode(node: MnodeOrLeaf): void {
  if (node.contents === CONTENTS_SOLID) return; // solid
  if (node.visframe !== r_visframecount) return;
  // q2repro src/refresh/world.c:593: `gl_cull_nodes->integer ? NODE_CLIPPED :
  // NODE_UNCLIPPED` -- q2repro's BSP traversal skips the per-node frustum
  // clip test entirely when the cvar is off; this renderer's closest
  // equivalent is this per-node R_CullBox check, gated the same way.
  if ((!glCvars.gl_cull_nodes || glCvars.gl_cull_nodes.value) && R_CullBox(vec3(node.minmaxs[0], node.minmaxs[1], node.minmaxs[2]), vec3(node.minmaxs[3], node.minmaxs[4], node.minmaxs[5]))) return;

  // if a leaf node, draw stuff
  if (isMleaf(node)) {
    const pleaf = node;

    // check for door connected areas
    if (r_newrefdef.areabits) {
      if (!(r_newrefdef.areabits[pleaf.area >> 3] & (1 << (pleaf.area & 7)))) return; // not visible
    }

    for (let i = 0; i < pleaf.nummarksurfaces; i++) {
      const surf = pleaf.firstmarksurface[i];
      if (surf) surf.visframe = r_framecount;
    }

    return;
  }

  // node is just a decision point, so go down the apropriate sides

  // find which side of the node we are on
  const plane = node.plane;
  if (!plane) return;

  let dot: number;
  switch (plane.type) {
    case PLANE_X:
      dot = modelorg[0] - plane.dist;
      break;
    case PLANE_Y:
      dot = modelorg[1] - plane.dist;
      break;
    case PLANE_Z:
      dot = modelorg[2] - plane.dist;
      break;
    default:
      dot = DotProduct(modelorg, plane.normal) - plane.dist;
      break;
  }

  let side: 0 | 1;
  let sidebit: number;
  if (dot >= 0) {
    side = 0;
    sidebit = 0;
  } else {
    side = 1;
    sidebit = SURF_PLANEBACK;
  }

  // recurse down the children, front side first
  const frontChild = node.children[side];
  if (frontChild) R_RecursiveWorldNode(frontChild);

  // draw stuff
  if (r_worldmodel) {
    for (let c = 0, surfIdx = node.firstsurface; c < node.numsurfaces; c++, surfIdx++) {
      const surf = r_worldmodel.surfaces[surfIdx];
      if (!surf || surf.visframe !== r_framecount) continue;
      if ((surf.flags & SURF_PLANEBACK) !== sidebit) continue; // wrong side

      if (surf.texinfo && surf.texinfo.flags & SURF_SKY) {
        // just adds to visible sky bounds
        R_AddSkySurface(surf);
      } else if (surf.texinfo && surf.texinfo.flags & (SURF_TRANS33 | SURF_TRANS66)) {
        // add to the translucent chain
        surf.texturechain = r_alpha_surfaces;
        r_alpha_surfaces = surf;
      } else {
        if (Boolean(qgl.qglMTexCoord2fSGIS) && !(surf.flags & SURF_DRAWTURB)) {
          GL_RenderLightmappedPoly(surf);
        } else {
          // the polygon is visible, so add it to the texture sorted chain
          // FIXME: this is a hack for animation
          const image = R_TextureAnimation(surf.texinfo);
          if (image) {
            surf.texturechain = image.texturechain;
            image.texturechain = surf;
          }
        }
      }
    }
  }

  // recurse down the back side
  const backChild = node.children[side === 0 ? 1 : 0];
  if (backChild) R_RecursiveWorldNode(backChild);
}

/*
=============
R_DrawWorld
=============
*/
export function R_DrawWorld(): void {
  if (!glCvars.r_drawworld || !glCvars.r_drawworld.value) return;
  // q2repro src/refresh/main.c:1134: `gl_drawworld` (CVAR_CHEAT) is q2repro's
  // rename of this same toggle; gate on both so either hides the world.
  if (glCvars.gl_drawworld && !glCvars.gl_drawworld.value) return;
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) return;
  if (!r_worldmodel) return;

  SetCurrentModel(r_worldmodel);

  VectorCopy(r_newrefdef.vieworg, modelorg);

  // auto cycle the world frame for texture animation
  const ent = new EntityT();
  ent.frame = Math.trunc(r_newrefdef.time * 2);
  SetCurrentEntity(ent);

  gl_state.currenttextures[0] = -1;
  gl_state.currenttextures[1] = -1;

  qgl.qglColor3f(1, 1, 1);
  gl_lms.lightmap_surfaces.fill(null);
  R_ClearSkyBox();

  if (r_worldmodel.nodes.length > 0) {
    if (Boolean(qgl.qglMTexCoord2fSGIS)) {
      GL_EnableMultitexture(true);

      GL_SelectTexture(GL_TEXTURE0_SGIS);
      GL_TexEnv(GL_REPLACE);
      GL_SelectTexture(GL_TEXTURE1_SGIS);

      if (glCvars.gl_lightmap && glCvars.gl_lightmap.value) GL_TexEnv(GL_REPLACE);
      else GL_TexEnv(GL_MODULATE);

      R_RecursiveWorldNode(r_worldmodel.nodes[0]);

      GL_EnableMultitexture(false);
    } else {
      R_RecursiveWorldNode(r_worldmodel.nodes[0]);
    }
  }

  // theoretically nothing should happen in the next two functions
  // if multitexture is enabled
  DrawTextureChains();
  R_BlendLightmaps();

  R_DrawSkyBox();

  R_DrawTriangleOutlines();
}

/*
===============
R_MarkLeaves

Mark the leaves and nodes that are in the PVS for the current
cluster
===============
*/
export function R_MarkLeaves(): void {
  // q2repro src/refresh/main.c:1157: `gl_novis` is q2repro's rename of
  // vanilla's r_novis (still carried above); either cvar forces "mark
  // everything" below.
  const novis = (glCvars.r_novis && glCvars.r_novis.value) || (glCvars.gl_novis && glCvars.gl_novis.value);

  if (r_oldviewcluster === r_viewcluster && r_oldviewcluster2 === r_viewcluster2 && !novis && r_viewcluster !== -1) {
    return;
  }

  // development aid to let you run around and see exactly where the pvs ends
  if (glCvars.gl_lockpvs && glCvars.gl_lockpvs.value) return;

  SetVisFrameCount(r_visframecount + 1);
  SetViewClusters(r_viewcluster, r_viewcluster2, r_viewcluster, r_viewcluster2);

  if (!r_worldmodel) return;

  if (novis || r_viewcluster === -1 || !r_worldmodel.vis) {
    // mark everything
    for (let i = 0; i < r_worldmodel.numleafs; i++) r_worldmodel.leafs[i].visframe = r_visframecount;
    for (let i = 0; i < r_worldmodel.numnodes; i++) r_worldmodel.nodes[i].visframe = r_visframecount;
    return;
  }

  let vis = Mod_ClusterPVS(r_viewcluster, r_worldmodel);
  // may have to combine two clusters because of solid water boundaries
  if (vis && r_viewcluster2 !== r_viewcluster) {
    const copyLen = Math.floor((r_worldmodel.numleafs + 7) / 8);
    const fatvis = new Uint8Array(Math.floor(MAX_MAP_LEAFS / 8));
    fatvis.set(vis.subarray(0, copyLen));

    const vis2 = Mod_ClusterPVS(r_viewcluster2, r_worldmodel);
    if (vis2) {
      for (let i = 0; i < copyLen; i++) fatvis[i] |= vis2[i];
    }
    vis = fatvis;
  }
  if (!vis) return;

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
=============================================================================

  LIGHTMAP ALLOCATION

=============================================================================
*/

export function LM_InitBlock(): void {
  gl_lms.allocated.fill(0);
}

export function LM_UploadBlock(dynamic: boolean): void {
  const texture = dynamic ? 0 : gl_lms.current_lightmap_texture;

  GL_Bind(gl_state.lightmap_textures + texture);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  if (dynamic) {
    let height = 0;
    for (let i = 0; i < BLOCK_WIDTH; i++) {
      if (gl_lms.allocated[i] > height) height = gl_lms.allocated[i];
    }

    qgl.qglTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, BLOCK_WIDTH, height, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, gl_lms.lightmap_buffer);
  } else {
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, gl_lms.internal_format, BLOCK_WIDTH, BLOCK_HEIGHT, 0, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, gl_lms.lightmap_buffer);
    gl_lms.current_lightmap_texture++;
    if (gl_lms.current_lightmap_texture === MAX_LIGHTMAPS) {
      ri.Sys_Error(ERR_DROP, "LM_UploadBlock() - MAX_LIGHTMAPS exceeded\n");
    }
  }
}

// returns a texture number and the position inside it (`int *x, int *y`
// out-params become a returned object, matching client/ref.ts's
// DrawGetPicSize's identical `{ w, h }` idiom for multiple int out-params).
export function LM_AllocBlock(w: number, h: number): { ok: boolean; x: number; y: number } {
  let best = BLOCK_HEIGHT;
  let x = 0;

  for (let i = 0; i < BLOCK_WIDTH - w; i++) {
    let best2 = 0;
    let j = 0;

    for (; j < w; j++) {
      if (gl_lms.allocated[i + j] >= best) break;
      if (gl_lms.allocated[i + j] > best2) best2 = gl_lms.allocated[i + j];
    }
    if (j === w) {
      // this is a valid spot
      x = i;
      best = best2;
    }
  }

  if (best + h > BLOCK_HEIGHT) return { ok: false, x: 0, y: 0 };

  for (let i = 0; i < w; i++) gl_lms.allocated[x + i] = best + h;

  return { ok: true, x, y: best };
}

/*
================
GL_BuildPolygonFromSurface
================
*/
export function GL_BuildPolygonFromSurface(fa: MsurfaceT): void {
  const model = currentmodel;
  const texinfo = fa.texinfo;
  const image = texinfo ? texinfo.image : null;
  if (!model || !texinfo || !image) return;

  // reconstruct the polygon
  const lnumverts = fa.numedges;
  const total = vec3();

  const poly = new GlpolyT();
  poly.next = fa.polys;
  poly.flags = fa.flags;
  fa.polys = poly;
  poly.numverts = lnumverts;

  const rows: Float32Array[] = new Array(lnumverts);

  for (let i = 0; i < lnumverts; i++) {
    const lindex = model.surfedges[fa.firstedge + i];
    const vec = lindex > 0 ? model.vertexes[model.edges[lindex].v[0]].position : model.vertexes[model.edges[-lindex].v[1]].position;

    let s = DotProduct(vec, texinfo.vecs[0]) + texinfo.vecs[0][3];
    s /= image.width;

    let t = DotProduct(vec, texinfo.vecs[1]) + texinfo.vecs[1][3];
    t /= image.height;

    VectorAdd(total, vec, total);

    const row = new Float32Array(VERTEXSIZE);
    row[0] = vec[0];
    row[1] = vec[1];
    row[2] = vec[2];
    row[3] = s;
    row[4] = t;

    // lightmap texture coordinates
    let ls: number;
    let lt: number;
    if (fa.decoupledLm) {
      // q2repro's build_surface_poly, `if (bsp->lm_decoupled)` branch: the
      // vertex's lightmap texel coordinate comes straight from the
      // DECOUPLED_LM axis/offset (already in per-texel units, unlike
      // texinfo.vecs which are in per-world-unit/16 units below) -- no
      // texturemins subtraction or *16/8 half-texel bias in world units,
      // just a direct atlas-position shift and the same half-texel center
      // bias q2repro's normalize_surface_lmtc applies (`s = light_s + 0.5`).
      ls = DotProduct(vec, fa.decoupledLm.axis[0]) + fa.decoupledLm.offset[0];
      ls += fa.light_s;
      ls += 0.5;
      ls /= BLOCK_WIDTH;

      lt = DotProduct(vec, fa.decoupledLm.axis[1]) + fa.decoupledLm.offset[1];
      lt += fa.light_t;
      lt += 0.5;
      lt /= BLOCK_HEIGHT;
    } else {
      ls = DotProduct(vec, texinfo.vecs[0]) + texinfo.vecs[0][3];
      ls -= fa.texturemins[0];
      ls += fa.light_s * 16;
      ls += 8;
      ls /= BLOCK_WIDTH * 16;

      lt = DotProduct(vec, texinfo.vecs[1]) + texinfo.vecs[1][3];
      lt -= fa.texturemins[1];
      lt += fa.light_t * 16;
      lt += 8;
      lt /= BLOCK_HEIGHT * 16;
    }

    row[5] = ls;
    row[6] = lt;

    rows[i] = row;
  }

  poly.verts = rows;
  poly.numverts = lnumverts;
}

/*
========================
GL_CreateSurfaceLightmap
========================
*/
export function GL_CreateSurfaceLightmap(surf: MsurfaceT): void {
  if (surf.flags & (SURF_DRAWSKY | SURF_DRAWTURB)) return;

  // q2repro's LM_BuildSurface reads surf->lm_width/lm_height directly here
  // (populated either by the classic build_surface_poly derivation or by
  // BSP_ParseDecoupledLM); surfaceLightmapDims is this port's equivalent
  // selection (see gl_model.ts).
  const [smax, tmax] = surfaceLightmapDims(surf);

  let alloc = LM_AllocBlock(smax, tmax);
  if (!alloc.ok) {
    LM_UploadBlock(false);
    LM_InitBlock();
    alloc = LM_AllocBlock(smax, tmax);
    if (!alloc.ok) {
      ri.Sys_Error(ERR_FATAL, `Consecutive calls to LM_AllocBlock(${smax},${tmax}) failed\n`);
    }
  }
  surf.light_s = alloc.x;
  surf.light_t = alloc.y;

  surf.lightmaptexturenum = gl_lms.current_lightmap_texture;

  const offset = (surf.light_t * BLOCK_WIDTH + surf.light_s) * LIGHTMAP_BYTES;

  R_SetCacheState(surf);
  R_BuildLightMap(surf, gl_lms.lightmap_buffer.subarray(offset), BLOCK_WIDTH * LIGHTMAP_BYTES);
}

/*
==================
GL_BeginBuildingLightmaps

==================
*/
const beginBuildingLightstyles: LightstyleT[] = Array.from({ length: MAX_LIGHTSTYLES }, () => new LightstyleT());

export function GL_BeginBuildingLightmaps(m: ModelT): void {
  // q2repro's LM_BeginBuilding sizing (see BLOCK_WIDTH/BLOCK_HEIGHT's own
  // comment above) -- recomputed per map load since different maps carry
  // different lm_decoupled state.
  const decoupled = Boolean(m.bspx?.decoupledLm);
  const bits = decoupled ? 10 : 7;
  BLOCK_WIDTH = 1 << bits;
  BLOCK_HEIGHT = 1 << bits;
  gl_lms.allocated = new Array(BLOCK_WIDTH).fill(0);
  gl_lms.lightmap_buffer = new Uint8Array(LIGHTMAP_BYTES * BLOCK_WIDTH * BLOCK_HEIGHT);

  SetFrameCount(1); // no dlightcache

  GL_EnableMultitexture(true);
  GL_SelectTexture(GL_TEXTURE1_SGIS);

  // setup the base lightstyles so the lightmaps won't have to be regenerated
  // the first time they're seen
  for (let i = 0; i < MAX_LIGHTSTYLES; i++) {
    const ls = beginBuildingLightstyles[i];
    ls.rgb[0] = 1;
    ls.rgb[1] = 1;
    ls.rgb[2] = 1;
    ls.white = 3;
  }
  r_newrefdef.lightstyles = beginBuildingLightstyles;

  if (!gl_state.lightmap_textures) {
    gl_state.lightmap_textures = TEXNUM_LIGHTMAPS;
  }

  gl_lms.current_lightmap_texture = 1;

  const mono = glCvars.gl_monolightmap ? glCvars.gl_monolightmap.string.charAt(0).toUpperCase() : "";
  if (mono === "A") gl_lms.internal_format = gl_tex_alpha_format;
  else if (mono === "C") gl_lms.internal_format = gl_tex_alpha_format;
  else if (mono === "I") gl_lms.internal_format = GL_INTENSITY8;
  else if (mono === "L") gl_lms.internal_format = GL_LUMINANCE8;
  else gl_lms.internal_format = gl_tex_solid_format;

  // initialize the dynamic lightmap texture
  GL_Bind(gl_state.lightmap_textures + 0);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  qgl.qglTexImage2D(GL_TEXTURE_2D, 0, gl_lms.internal_format, BLOCK_WIDTH, BLOCK_HEIGHT, 0, GL_LIGHTMAP_FORMAT, GL_UNSIGNED_BYTE, new Uint32Array(BLOCK_WIDTH * BLOCK_HEIGHT));
}

/*
=======================
GL_EndBuildingLightmaps
=======================
*/
export function GL_EndBuildingLightmaps(): void {
  LM_UploadBlock(false);
  GL_EnableMultitexture(false);
}
