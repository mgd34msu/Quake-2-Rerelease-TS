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

Ported from ref_soft/r_misc.c (GNU GPL v2 or later). `D_Patch`/
`R_SetUpFrustumIndexes`/`R_ViewChanged` are static internal helpers (not
declared in r_local.h) and are not stubbed individually, per this module's
former header comment. `R_SurfacePatch` is also defined here in the C
original (duplicate of r_edge.c's copy, both no-ops under the portable
`#ifndef id386`/`#if !id386` guard) -- attributed to r_edge.ts instead per
that module's own header comment, so it is not ported a second time here.

`R_TransformPlane`'s `float *normal, float *dist` out params become a
returned `{ normal, dist }` object per PORTING.md's out-param convention.

`D_Patch`'s body is entirely inside `#if id386` (including the
`colormap = vid.colormap;` line -- verified against the C source line by
line), so under the portable path it is a true no-op; ported as such and
still called from D_ViewChanged for structural fidelity. Dropped id386
branch: the `Sys_MakeCodeWriteable`/`R_Surf8Patch`/`D_Aff8Patch` asm-patch
calls.

Cross-module mutable state: R_ViewChanged/R_SetupFrame recompute most of
r_local.h's per-frame scalars every frame, and an imported `let` binding is
read-only to the importer, so each one is written through its owner's setter:
`xcenter`/`ycenter`/`xscale`/`yscale`/`xscaleinv`/`yscaleinv`/`xscaleshrink`/
`yscaleshrink`/`aliasx*`/`aliasy*`/`verticalFieldOfView`/`xOrigin`/`yOrigin`
through r_local.ts's grouped `R_SetViewScales`, `scale_for_mip`/`d_minmip`/
`d_zrowbytes` through its `D_SetMipState`, `r_framecount`/`r_dowarp`/
`r_viewleaf`/`r_viewcluster` through its individual setters; `d_viewbuffer`/
`r_screenwidth`/`d_zwidth` through r_scan.ts's `D_SetViewBuffer`/
`D_SetZBufferWidth`; `d_vrect*`/`d_pix_*` through r_part.ts's
`D_SetParticleClipRect`/`D_SetParticlePixRange`; and the surface cache's
`d_roverwrapped`/`d_initial_rover` through r_surf.ts's `D_SetInitialRover`.
`r_viewleaf`/`r_viewcluster`/`r_framecount`/`r_dowarp`/`SetViewCluster` are
re-exported here because r_main.ts already reaches them through this module.

The C original assigns `d_minmip` from sw_mipcap at the end of R_SetupFrame,
after R_ViewChanged has already run; here it is folded into D_ViewChanged's
`D_SetMipState` call. Nothing between the two points reads it and the value
comes from the same cvar either way, so the result is identical.

`screenedge`/`view_clipplanes`/`pfrustum_indexes`/`vpn`/`vright`/`vup`/
`modelorg`/`r_origin`/`base_vpn`/`base_vright`/`base_vup`/`r_refdef`/
`d_scantable`/`zspantable`/`d_scalemip` are all r_local.ts `const` bindings
whose *contents* this file mutates in place, which crosses the module
boundary fine -- no setter is needed for any of these.
*/

import { AngleVectors, DotProduct, VectorCopy, VectorNormalize, type Vec3, vec3 } from "../shared/math";
import { M_PI, PRINT_ALL, RDF_NOWORLDMODEL, RDF_UNDERWATER } from "../shared/q_shared";
import { PLANE_ANYZ } from "../qcommon/qfiles";
import { Sys_Milliseconds } from "../platform/sys";
import {
  base_vpn,
  base_vright,
  base_vup,
  d_scalemip,
  d_scantable,
  modelorg,
  pfrustum_indexes,
  r_newrefdef,
  r_origin,
  r_amodels_drawn,
  r_dowarp,
  r_framecount,
  r_refdef,
  r_viewcluster,
  r_viewleaf,
  r_warpbuffer,
  ri,
  rCvars,
  screenedge,
  scale_for_mip,
  sw_state,
  xscale,
  yscale,
  D_SetMipState,
  R_SetViewScales,
  SetDowarp,
  SetFrameCount,
  SetViewCluster,
  SetViewLeaf,
  view_clipplanes,
  vid,
  vpn,
  vright,
  vup,
  WARP_HEIGHT,
  WARP_WIDTH,
  XCENTERING,
  YCENTERING,
  zspantable,
} from "./r_local";
import { Mod_PointInLeaf, type MplaneT } from "./r_model";
import type * as RBspModule from "./r_bsp";
import type * as RSurfModule from "./r_surf";
import { Draw_Fill } from "./r_draw";
import { D_SetViewBuffer, D_SetZBufferWidth, d_pzbuffer, d_zwidth, r_screenwidth } from "./r_scan";
import { D_SetParticleClipRect, D_SetParticlePixRange } from "./r_part";

// import-cycle rule (PORTING.md): r_bsp.ts already statically imports
// R_TransformFrustum from this file, and r_edge.ts (which r_surf.ts's own
// dependency chain reaches back through) statically imports it too, so a
// static import back from here to r_bsp.ts/r_surf.ts would close a value
// cycle. r_bsp.ts/r_surf.ts are also out of this brief's SCOPE, so this
// file -- not the "less fundamental" side the rule would normally pick --
// is the one that has to break the cycle; resolved lazily instead, same
// idiom as r_model.ts's rMainMod()/rSurfMod()/rImageMod() and r_rast.ts's
// bspMod().
function bspMod(): typeof RBspModule {
  return require("./r_bsp");
}
function surfMod(): typeof RSurfModule {
  return require("./r_surf");
}

// r_misc.c's own file-scope statics (not declared in r_local.h).
const NUM_MIPS = 4;
const basemip: [number, number, number] = [1.0, 0.5 * 0.8, 0.25 * 0.8];

// `r_viewleaf`/`r_viewcluster`/`r_framecount`/`r_dowarp` are r_local.h
// externs owned by r_local.ts; re-exported here because r_main.ts already
// reaches them through this module.
export { r_viewleaf, r_viewcluster, r_framecount, r_dowarp, SetViewCluster } from "./r_local";

let d_aflatcolor = 0;

// r_misc.c's `unsigned char *alias_colormap;` -- module-static, not an
// r_local.h extern.
let alias_colormap: Uint8Array | null = null;

/*
================
D_Patch

Entirely `#if id386` in the C original (see file header comment) -- a true
no-op on the portable path.
================
*/
function d_minmipForCvar(): number {
  const sw_mipcap = rCvars.sw_mipcap;
  let v = sw_mipcap ? sw_mipcap.value | 0 : 0;
  if (v > 3) v = 3;
  else if (v < 0) v = 0;
  return v;
}

function D_Patch(): void {
  // no-op on the portable (non-id386) path
}

/*
================
D_ViewChanged
================
*/
export function D_ViewChanged(): void {
  D_SetMipState(yscale > xscale ? yscale : xscale, d_minmipForCvar(), vid.width * 2);

  D_SetZBufferWidth(vid.width);

  let d_pix_min = (r_refdef.vrect.width / 320) | 0;
  if (d_pix_min < 1) d_pix_min = 1;

  let d_pix_max = ((r_refdef.vrect.width / (320.0 / 4.0) + 0.5) | 0);
  const d_pix_shift = 8 - ((r_refdef.vrect.width / 320.0 + 0.5) | 0);
  if (d_pix_max < 1) d_pix_max = 1;

  D_SetParticlePixRange(d_pix_min, d_pix_max, d_pix_shift);
  D_SetParticleClipRect(r_refdef.vrect.x, r_refdef.vrect.y, r_refdef.vrectright - d_pix_max, r_refdef.vrectbottom - d_pix_max);

  for (let i = 0; i < vid.height; i++) {
    d_scantable[i] = i * r_screenwidth;
    zspantable[i] = d_pzbuffer ? d_pzbuffer.subarray(i * d_zwidth) : null;
  }

  // clear Z-buffer and color-buffers if we're doing the gallery
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) {
    if (d_pzbuffer) d_pzbuffer.fill(-1); // 0xffff as signed 16-bit
    const clearcolor = rCvars.sw_clearcolor ? (rCvars.sw_clearcolor.value | 0) & 0xff : 0;
    Draw_Fill(r_newrefdef.x, r_newrefdef.y, r_newrefdef.width, r_newrefdef.height, clearcolor);
  }

  alias_colormap = vid.colormap;

  D_Patch();
}

/*
=============
R_PrintTimes

`c_faceclip`/`r_polycount` (part of the C format string) are r_rast.c
file-scope counters with no r_local.h declaration, so the printed line is
simplified to just the millisecond count -- reported deviation. `r_time1` is
r_main.c's own local captured at the top of R_RenderFrame; `SetTimeRef` is the
real cross-file setter (r_main.ts calls it), not a test-only shim.
=============
*/
let r_time1Ref = 0;
export function SetTimeRef(t: number): void {
  r_time1Ref = t;
}

export function R_PrintTimes(): void {
  const r_time2 = Sys_Milliseconds();
  const ms = r_time2 - r_time1Ref;
  ri.Con_Printf(PRINT_ALL, `${ms} ms\n`);
}

/*
=============
R_PrintDSpeeds

The C format string's dp_time/rw_time/db_time/se_time/de_time/da_time
fields are r_local.h externs that nothing in this port ever writes (the
per-stage Sys_Milliseconds captures around R_EdgeDrawing were dropped) --
simplified to the overall millisecond count only. Reported deviation.
=============
*/
export function R_PrintDSpeeds(): void {
  const r_time2 = Sys_Milliseconds();
  ri.Con_Printf(PRINT_ALL, `${r_time2 - r_time1Ref} ms\n`);
}

/*
=============
R_PrintAliasStats

=============
*/
export function R_PrintAliasStats(): void {
  ri.Con_Printf(PRINT_ALL, `${r_amodels_drawn} polygon model drawn\n`);
}

/*
===================
R_TransformFrustum
===================
*/
export function R_TransformFrustum(): void {
  const v: Vec3 = vec3();
  const v2: Vec3 = vec3();

  for (let i = 0; i < 4; i++) {
    v[0] = screenedge[i].normal[2];
    v[1] = -screenedge[i].normal[0];
    v[2] = screenedge[i].normal[1];

    v2[0] = v[1] * vright[0] + v[2] * vup[0] + v[0] * vpn[0];
    v2[1] = v[1] * vright[1] + v[2] * vup[1] + v[0] * vpn[1];
    v2[2] = v[1] * vright[2] + v[2] * vup[2] + v[0] * vpn[2];

    VectorCopy(v2, view_clipplanes[i].normal);

    view_clipplanes[i].dist = DotProduct(modelorg, v2);
  }
}

/*
================
TransformVector

Portable (`#ifndef id386`) path only -- see file header comment for the
dropped `__declspec(naked)` x86 asm half of this guard.
================
*/
export function TransformVector(inV: Vec3, out: Vec3): void {
  out[0] = DotProduct(inV, vright);
  out[1] = DotProduct(inV, vup);
  out[2] = DotProduct(inV, vpn);
}

/*
================
R_TransformPlane
================
*/
export function R_TransformPlane(p: MplaneT): { normal: Vec3; dist: number } {
  const d = DotProduct(r_origin, p.normal);
  const dist = p.dist - d;
  const normal: Vec3 = vec3();
  // TODO: when we have rotating entities, this will need to use the view matrix
  TransformVector(p.normal, normal);
  return { normal, dist };
}

/*
===============
R_SetUpFrustumIndexes
===============
*/
function R_SetUpFrustumIndexes(): void {
  for (let i = 0; i < 4; i++) {
    const pindex: number[] = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 3; j++) {
      if (view_clipplanes[i].normal[j] < 0) {
        pindex[j] = j;
        pindex[j + 3] = j + 3;
      } else {
        pindex[j] = j + 3;
        pindex[j + 3] = j;
      }
    }

    pfrustum_indexes[i] = pindex;
  }
}

/*
===============
R_ViewChanged

Called every time the vid structure or r_refdef changes.
Guaranteed to be called before the first refresh
===============
*/
function R_ViewChanged(vr: { x: number; y: number; width: number; height: number }): void {
  r_refdef.vrect.x = vr.x;
  r_refdef.vrect.y = vr.y;
  r_refdef.vrect.width = vr.width;
  r_refdef.vrect.height = vr.height;

  r_refdef.horizontalFieldOfView = 2 * Math.tan((r_newrefdef.fov_x / 360) * M_PI);
  const verticalFieldOfView = 2 * Math.tan((r_newrefdef.fov_y / 360) * M_PI);

  r_refdef.fvrectx = r_refdef.vrect.x;
  r_refdef.fvrectx_adj = r_refdef.vrect.x - 0.5;
  r_refdef.vrect_x_adj_shift20 = (r_refdef.vrect.x << 20) + (1 << 19) - 1;
  r_refdef.fvrecty = r_refdef.vrect.y;
  r_refdef.fvrecty_adj = r_refdef.vrect.y - 0.5;
  r_refdef.vrectright = r_refdef.vrect.x + r_refdef.vrect.width;
  r_refdef.vrectright_adj_shift20 = (r_refdef.vrectright << 20) + (1 << 19) - 1;
  r_refdef.fvrectright = r_refdef.vrectright;
  r_refdef.fvrectright_adj = r_refdef.vrectright - 0.5;
  r_refdef.vrectrightedge = r_refdef.vrectright - 0.99;
  r_refdef.vrectbottom = r_refdef.vrect.y + r_refdef.vrect.height;
  r_refdef.fvrectbottom = r_refdef.vrectbottom;
  r_refdef.fvrectbottom_adj = r_refdef.vrectbottom - 0.5;

  // r_aliasuvscale is always 1.0 (R_Init) so aliasvrect mirrors vrect
  r_refdef.aliasvrect.x = r_refdef.vrect.x | 0;
  r_refdef.aliasvrect.y = r_refdef.vrect.y | 0;
  r_refdef.aliasvrect.width = r_refdef.vrect.width | 0;
  r_refdef.aliasvrect.height = r_refdef.vrect.height | 0;
  r_refdef.aliasvrectright = r_refdef.aliasvrect.x + r_refdef.aliasvrect.width;
  r_refdef.aliasvrectbottom = r_refdef.aliasvrect.y + r_refdef.aliasvrect.height;

  const xOrigin = r_refdef.xOrigin;
  const yOrigin = r_refdef.yOrigin;

  // values for perspective projection
  // if math were exact, the values would range from 0.5 to to range+0.5
  // hopefully they wll be in the 0.000001 to range+.999999 and truncate
  // the polygon rasterization will never render in the first row or column
  // but will definately render in the [range] row and column, so adjust the
  // buffer origin to get an exact edge to edge fill
  const xcenter = r_refdef.vrect.width * XCENTERING + r_refdef.vrect.x - 0.5;
  const ycenter = r_refdef.vrect.height * YCENTERING + r_refdef.vrect.y - 0.5;

  const xscaleLocal = r_refdef.vrect.width / r_refdef.horizontalFieldOfView;
  const yscaleLocal = xscaleLocal;
  const xscaleshrink = (r_refdef.vrect.width - 6) / r_refdef.horizontalFieldOfView;

  R_SetViewScales({
    xcenter,
    ycenter,
    xscale: xscaleLocal,
    yscale: yscaleLocal,
    xscaleinv: 1.0 / xscaleLocal,
    yscaleinv: 1.0 / yscaleLocal,
    xscaleshrink,
    yscaleshrink: xscaleshrink,
    aliasxscale: xscaleLocal,
    aliasyscale: yscaleLocal,
    aliasxcenter: xcenter,
    aliasycenter: ycenter,
    verticalFieldOfView,
    xOrigin,
    yOrigin,
  });

  // left side clip
  screenedge[0].normal[0] = -1.0 / (xOrigin * r_refdef.horizontalFieldOfView);
  screenedge[0].normal[1] = 0;
  screenedge[0].normal[2] = 1;
  screenedge[0].type = PLANE_ANYZ;

  // right side clip
  screenedge[1].normal[0] = 1.0 / ((1.0 - xOrigin) * r_refdef.horizontalFieldOfView);
  screenedge[1].normal[1] = 0;
  screenedge[1].normal[2] = 1;
  screenedge[1].type = PLANE_ANYZ;

  // top side clip
  screenedge[2].normal[0] = 0;
  screenedge[2].normal[1] = -1.0 / (yOrigin * verticalFieldOfView);
  screenedge[2].normal[2] = 1;
  screenedge[2].type = PLANE_ANYZ;

  // bottom side clip
  screenedge[3].normal[0] = 0;
  screenedge[3].normal[1] = 1.0 / ((1.0 - yOrigin) * verticalFieldOfView);
  screenedge[3].normal[2] = 1;
  screenedge[3].type = PLANE_ANYZ;

  for (let i = 0; i < 4; i++) VectorNormalize(screenedge[i].normal);

  D_ViewChanged();
}

/*
===============
R_SetupFrame
===============
*/
export function R_SetupFrame(): void {
  if (rCvars.r_fullbright && rCvars.r_fullbright.modified) {
    rCvars.r_fullbright.modified = false;
    surfMod().D_FlushCaches(); // so all lighting changes
  }

  SetFrameCount(r_framecount + 1);

  // build the transformation matrix for the given view angles
  VectorCopy(r_refdef.vieworg, modelorg);
  VectorCopy(r_refdef.vieworg, r_origin);

  AngleVectors(r_refdef.viewangles, vpn, vright, vup);

  // current viewleaf
  if (!(r_newrefdef.rdflags & RDF_NOWORLDMODEL)) {
    const leaf = Mod_PointInLeaf(r_origin, bspMod().r_worldmodel);
    SetViewLeaf(leaf);
    SetViewCluster(leaf.cluster);
  }

  const sw_waterwarp = rCvars.sw_waterwarp;
  if (sw_waterwarp && sw_waterwarp.value && r_newrefdef.rdflags & RDF_UNDERWATER) {
    SetDowarp(true);
  } else {
    SetDowarp(false);
  }

  let vrect: { x: number; y: number; width: number; height: number };
  if (r_dowarp) {
    // warp into off screen buffer
    vrect = {
      x: 0,
      y: 0,
      width: r_newrefdef.width < WARP_WIDTH ? r_newrefdef.width : WARP_WIDTH,
      height: r_newrefdef.height < WARP_HEIGHT ? r_newrefdef.height : WARP_HEIGHT,
    };

    D_SetViewBuffer(r_warpbuffer, WARP_WIDTH);
  } else {
    vrect = {
      x: r_newrefdef.x,
      y: r_newrefdef.y,
      width: r_newrefdef.width,
      height: r_newrefdef.height,
    };

    D_SetViewBuffer(vid.buffer, vid.rowbytes);
  }

  R_ViewChanged(vrect);

  // start off with just the four screen edge clip planes
  R_TransformFrustum();
  R_SetUpFrustumIndexes();

  // save base values
  VectorCopy(vpn, base_vpn);
  VectorCopy(vright, base_vright);
  VectorCopy(vup, base_vup);

  // d_setup
  surfMod().D_SetInitialRover();

  const mipscale = rCvars.sw_mipscale ? rCvars.sw_mipscale.value : 1;
  for (let i = 0; i < NUM_MIPS - 1; i++) d_scalemip[i] = basemip[i] * mipscale;

  d_aflatcolor = 0;
}

/*
============================================================================

						SCREEN SHOTS

============================================================================
*/

/*
==============
WritePCX

Ported from WritePCXfile: builds the PCX byte image in memory instead of
writing it to disk directly (RefImports has no file-write entry point --
see this file's header comment / the unit report for the adaptation).
==============
*/
export function WritePCX(data: Uint8Array, width: number, height: number, rowbytes: number, palette: Uint8Array): Uint8Array {
  const out: number[] = new Array<number>(128).fill(0);

  out[0] = 0x0a; // manufacturer
  out[1] = 5; // version
  out[2] = 1; // encoding
  out[3] = 8; // bits_per_pixel
  // xmin/ymin already 0
  out[8] = (width - 1) & 0xff;
  out[9] = ((width - 1) >> 8) & 0xff;
  out[10] = (height - 1) & 0xff;
  out[11] = ((height - 1) >> 8) & 0xff;
  out[12] = width & 0xff; // hres
  out[13] = (width >> 8) & 0xff;
  out[14] = height & 0xff; // vres
  out[15] = (height >> 8) & 0xff;
  // offset 64 is pcx_t's `reserved` byte (stays 0); color_planes lives at
  // offset 65 -- this was written one byte early, producing planes=0
  // headers every standard decoder rejects (caught by the regate's
  // screenshot oracle trying to read our own soft-renderer screenshot).
  out[65] = 1; // color_planes
  out[66] = width & 0xff; // bytes_per_line
  out[67] = (width >> 8) & 0xff;
  out[68] = 2; // palette_type (not a grey scale)
  out[69] = 0;

  let pos = 0;
  for (let i = 0; i < height; i++) {
    for (let j = 0; j < width; j++) {
      const byte = data[pos];
      pos++;
      if ((byte & 0xc0) !== 0xc0) {
        out.push(byte);
      } else {
        out.push(0xc1);
        out.push(byte);
      }
    }
    pos += rowbytes - width;
  }

  out.push(0x0c); // palette ID byte
  for (let i = 0; i < 768; i++) out.push(palette[i]);

  return Uint8Array.from(out);
}

// R_ScreenShot_f writes through this hook: RefImports has no file-write entry
// point, and PORTING.md confines node:fs to src/platform, so the disk write
// itself lives in src/platform/vid.ts (VID_Init installs it here).
export type ScreenshotWriterT = (path: string, data: Uint8Array) => void;
let screenshotWriter: ScreenshotWriterT | null = null;
export function SetScreenshotWriter(fn: ScreenshotWriterT | null): void {
  screenshotWriter = fn;
}

// The free-filename probe needs the same seam. `checkname` is an absolute OS
// path built from FS_Gamedir(), which ri.FS_LoadFile -- a virtual-filesystem
// lookup relative to the search paths -- can never resolve, so it answered
// "does not exist" for every slot and every screenshot overwrote quake00.
// The C original probes the OS path directly with fopen(checkname, "rb").
export type ScreenshotExistsT = (path: string) => boolean;
let screenshotExists: ScreenshotExistsT | null = null;
export function SetScreenshotExists(fn: ScreenshotExistsT | null): void {
  screenshotExists = fn;
}

/*
==================
R_ScreenShot_f

RefImports has neither a raw file-write nor a Sys_Mkdir entry point, so the
`scrnshot` directory is created by the platform writer instead of here
(reported deviation) and the free-filename probe goes through the
platform's `SetScreenshotExists` hook in place of `fopen(checkname, "r")`.
==================
*/
export function R_ScreenShot_f(): void {
  const gamedir = ri.FS_Gamedir();
  let checkname = "";
  let i = 0;
  for (; i <= 99; i++) {
    const tens = (i / 10) | 0;
    const ones = i % 10;
    const pcxname = `quake${tens}${ones}.pcx`;
    checkname = `${gamedir}/scrnshot/${pcxname}`;
    if (!screenshotExists || !screenshotExists(checkname)) break;
  }
  if (i === 100) {
    ri.Con_Printf(PRINT_ALL, "R_ScreenShot_f: Couldn't create a PCX");
    return;
  }

  // turn the current 32 bit palette into a 24 bit palette
  const palette = new Uint8Array(768);
  for (let j = 0; j < 256; j++) {
    palette[j * 3 + 0] = sw_state.currentpalette[j * 4 + 0];
    palette[j * 3 + 1] = sw_state.currentpalette[j * 4 + 1];
    palette[j * 3 + 2] = sw_state.currentpalette[j * 4 + 2];
  }

  const pcx = WritePCX(vid.buffer, vid.width, vid.height, vid.rowbytes, palette);

  if (screenshotWriter) screenshotWriter(checkname, pcx);

  ri.Con_Printf(PRINT_ALL, `Wrote ${checkname}\n`);
}
