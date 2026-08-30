/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_aclip.c (GNU GPL v2 or later): clip routines for
drawing Alias (MD2) models directly to the screen. `R_Alias_clip_top/
bottom/left/right`/`R_AliasClip` are static internal helpers (not declared
in r_local.h) and stay module-private, per the pending stub's note.

`R_Alias_clip_left/right/top/bottom` are wrapped in `#if !id386` in the C
source with no `#else` body at all (the id386 build supplies them from a
separate .s file) -- there is no C branch to choose between here, so this
port is simply "the only version that ever had a C body," consistent with
PORTING.md's asm-duplicate rule.

Circular value import with r_alias.ts (R_Alias_clip_z calls
R_AliasProjectAndClipTestFinalVert there; r_alias.ts's R_AliasPreparePoints
calls R_AliasClipTriangle here): both sides only reference the other's
export from inside function bodies that run after module evaluation, and
both exports are hoisted `function` declarations, so this does not hit
PORTING.md's TDZ/import-cycle rule (that rule is for `const`/value bindings
read at module-init time) -- no `require()` escape hatch needed.
*/

import { R_AliasProjectAndClipTestFinalVert } from "./r_alias";
import { R_DrawTriangle } from "./r_polyse";
import { ALIAS_BOTTOM_CLIP, ALIAS_LEFT_CLIP, ALIAS_RIGHT_CLIP, ALIAS_TOP_CLIP, ALIAS_Z_CLIP, ALIAS_Z_CLIP_PLANE, FinalvertT, aliastriangleparms, r_refdef } from "./r_local";

// static finalvert_t fv[2][8];
const fv: FinalvertT[][] = [
  Array.from({ length: 8 }, () => new FinalvertT()),
  Array.from({ length: 8 }, () => new FinalvertT()),
];

function copyFinalvert(src: FinalvertT, dst: FinalvertT): void {
  dst.u = src.u;
  dst.v = src.v;
  dst.s = src.s;
  dst.t = src.t;
  dst.l = src.l;
  dst.zi = src.zi;
  dst.flags = src.flags;
  dst.xyz[0] = src.xyz[0];
  dst.xyz[1] = src.xyz[1];
  dst.xyz[2] = src.xyz[2];
}

/*
================
R_Alias_clip_z

pfv0 is the unclipped vertex, pfv1 is the z-clipped vertex
================
*/
function R_Alias_clip_z(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  const scale = (ALIAS_Z_CLIP_PLANE - pfv0.xyz[2]) / (pfv1.xyz[2] - pfv0.xyz[2]);

  out.xyz[0] = pfv0.xyz[0] + (pfv1.xyz[0] - pfv0.xyz[0]) * scale;
  out.xyz[1] = pfv0.xyz[1] + (pfv1.xyz[1] - pfv0.xyz[1]) * scale;
  out.xyz[2] = ALIAS_Z_CLIP_PLANE;

  out.s = (pfv0.s + (pfv1.s - pfv0.s) * scale) | 0;
  out.t = (pfv0.t + (pfv1.t - pfv0.t) * scale) | 0;
  out.l = (pfv0.l + (pfv1.l - pfv0.l) * scale) | 0;

  R_AliasProjectAndClipTestFinalVert(out);
}

// exported (along with R_AliasClip below) so test/ref_alias.test.ts can
// exercise a single clip plane directly and check the resulting vertex
// count/coordinates, without needing R_AliasClipTriangle's full 5-plane
// orchestration (which only exposes its result via side-effecting
// R_DrawTriangle calls).
export function R_Alias_clip_left(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v >= pfv1.v) {
    scale = (r_refdef.aliasvrect.x - pfv0.u) / (pfv1.u - pfv0.u);
    out.u = (pfv0.u + (pfv1.u - pfv0.u) * scale + 0.5) | 0;
    out.v = (pfv0.v + (pfv1.v - pfv0.v) * scale + 0.5) | 0;
    out.s = (pfv0.s + (pfv1.s - pfv0.s) * scale + 0.5) | 0;
    out.t = (pfv0.t + (pfv1.t - pfv0.t) * scale + 0.5) | 0;
    out.l = (pfv0.l + (pfv1.l - pfv0.l) * scale + 0.5) | 0;
    out.zi = (pfv0.zi + (pfv1.zi - pfv0.zi) * scale + 0.5) | 0;
  } else {
    scale = (r_refdef.aliasvrect.x - pfv1.u) / (pfv0.u - pfv1.u);
    out.u = (pfv1.u + (pfv0.u - pfv1.u) * scale + 0.5) | 0;
    out.v = (pfv1.v + (pfv0.v - pfv1.v) * scale + 0.5) | 0;
    out.s = (pfv1.s + (pfv0.s - pfv1.s) * scale + 0.5) | 0;
    out.t = (pfv1.t + (pfv0.t - pfv1.t) * scale + 0.5) | 0;
    out.l = (pfv1.l + (pfv0.l - pfv1.l) * scale + 0.5) | 0;
    out.zi = (pfv1.zi + (pfv0.zi - pfv1.zi) * scale + 0.5) | 0;
  }
}

function R_Alias_clip_right(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v >= pfv1.v) {
    scale = (r_refdef.aliasvrectright - pfv0.u) / (pfv1.u - pfv0.u);
    out.u = (pfv0.u + (pfv1.u - pfv0.u) * scale + 0.5) | 0;
    out.v = (pfv0.v + (pfv1.v - pfv0.v) * scale + 0.5) | 0;
    out.s = (pfv0.s + (pfv1.s - pfv0.s) * scale + 0.5) | 0;
    out.t = (pfv0.t + (pfv1.t - pfv0.t) * scale + 0.5) | 0;
    out.l = (pfv0.l + (pfv1.l - pfv0.l) * scale + 0.5) | 0;
    out.zi = (pfv0.zi + (pfv1.zi - pfv0.zi) * scale + 0.5) | 0;
  } else {
    scale = (r_refdef.aliasvrectright - pfv1.u) / (pfv0.u - pfv1.u);
    out.u = (pfv1.u + (pfv0.u - pfv1.u) * scale + 0.5) | 0;
    out.v = (pfv1.v + (pfv0.v - pfv1.v) * scale + 0.5) | 0;
    out.s = (pfv1.s + (pfv0.s - pfv1.s) * scale + 0.5) | 0;
    out.t = (pfv1.t + (pfv0.t - pfv1.t) * scale + 0.5) | 0;
    out.l = (pfv1.l + (pfv0.l - pfv1.l) * scale + 0.5) | 0;
    out.zi = (pfv1.zi + (pfv0.zi - pfv1.zi) * scale + 0.5) | 0;
  }
}

function R_Alias_clip_top(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v >= pfv1.v) {
    scale = (r_refdef.aliasvrect.y - pfv0.v) / (pfv1.v - pfv0.v);
    out.u = (pfv0.u + (pfv1.u - pfv0.u) * scale + 0.5) | 0;
    out.v = (pfv0.v + (pfv1.v - pfv0.v) * scale + 0.5) | 0;
    out.s = (pfv0.s + (pfv1.s - pfv0.s) * scale + 0.5) | 0;
    out.t = (pfv0.t + (pfv1.t - pfv0.t) * scale + 0.5) | 0;
    out.l = (pfv0.l + (pfv1.l - pfv0.l) * scale + 0.5) | 0;
    out.zi = (pfv0.zi + (pfv1.zi - pfv0.zi) * scale + 0.5) | 0;
  } else {
    scale = (r_refdef.aliasvrect.y - pfv1.v) / (pfv0.v - pfv1.v);
    out.u = (pfv1.u + (pfv0.u - pfv1.u) * scale + 0.5) | 0;
    out.v = (pfv1.v + (pfv0.v - pfv1.v) * scale + 0.5) | 0;
    out.s = (pfv1.s + (pfv0.s - pfv1.s) * scale + 0.5) | 0;
    out.t = (pfv1.t + (pfv0.t - pfv1.t) * scale + 0.5) | 0;
    out.l = (pfv1.l + (pfv0.l - pfv1.l) * scale + 0.5) | 0;
    out.zi = (pfv1.zi + (pfv0.zi - pfv1.zi) * scale + 0.5) | 0;
  }
}

function R_Alias_clip_bottom(pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT): void {
  let scale: number;

  if (pfv0.v >= pfv1.v) {
    scale = (r_refdef.aliasvrectbottom - pfv0.v) / (pfv1.v - pfv0.v);
    out.u = (pfv0.u + (pfv1.u - pfv0.u) * scale + 0.5) | 0;
    out.v = (pfv0.v + (pfv1.v - pfv0.v) * scale + 0.5) | 0;
    out.s = (pfv0.s + (pfv1.s - pfv0.s) * scale + 0.5) | 0;
    out.t = (pfv0.t + (pfv1.t - pfv0.t) * scale + 0.5) | 0;
    out.l = (pfv0.l + (pfv1.l - pfv0.l) * scale + 0.5) | 0;
    out.zi = (pfv0.zi + (pfv1.zi - pfv0.zi) * scale + 0.5) | 0;
  } else {
    scale = (r_refdef.aliasvrectbottom - pfv1.v) / (pfv0.v - pfv1.v);
    out.u = (pfv1.u + (pfv0.u - pfv1.u) * scale + 0.5) | 0;
    out.v = (pfv1.v + (pfv0.v - pfv1.v) * scale + 0.5) | 0;
    out.s = (pfv1.s + (pfv0.s - pfv1.s) * scale + 0.5) | 0;
    out.t = (pfv1.t + (pfv0.t - pfv1.t) * scale + 0.5) | 0;
    out.l = (pfv1.l + (pfv0.l - pfv1.l) * scale + 0.5) | 0;
    out.zi = (pfv1.zi + (pfv0.zi - pfv1.zi) * scale + 0.5) | 0;
  }
}

export type ClipFn = (pfv0: FinalvertT, pfv1: FinalvertT, out: FinalvertT) => void;

export function R_AliasClip(inArr: FinalvertT[], outArr: FinalvertT[], flag: number, count: number, clip: ClipFn): number {
  let k = 0;
  let j = count - 1;

  for (let i = 0; i < count; j = i, i++) {
    const oldflags = inArr[j].flags & flag;
    const flags = inArr[i].flags & flag;

    if (flags && oldflags) continue;
    if (oldflags ^ flags) {
      clip(inArr[j], inArr[i], outArr[k]);
      outArr[k].flags = 0;
      if (outArr[k].u < r_refdef.aliasvrect.x) outArr[k].flags |= ALIAS_LEFT_CLIP;
      if (outArr[k].v < r_refdef.aliasvrect.y) outArr[k].flags |= ALIAS_TOP_CLIP;
      if (outArr[k].u > r_refdef.aliasvrectright) outArr[k].flags |= ALIAS_RIGHT_CLIP;
      if (outArr[k].v > r_refdef.aliasvrectbottom) outArr[k].flags |= ALIAS_BOTTOM_CLIP;
      k++;
    }
    if (!flags) {
      copyFinalvert(inArr[i], outArr[k]);
      k++;
    }
  }

  return k;
}

/*
================
R_AliasClipTriangle
================
*/
export function R_AliasClipTriangle(index0: FinalvertT, index1: FinalvertT, index2: FinalvertT): void {
  // copy vertexes and fix seam texture coordinates
  copyFinalvert(index0, fv[0][0]);
  copyFinalvert(index1, fv[0][1]);
  copyFinalvert(index2, fv[0][2]);

  // clip
  let clipflags = fv[0][0].flags | fv[0][1].flags | fv[0][2].flags;

  let pingpong: number;
  let k: number;

  if (clipflags & ALIAS_Z_CLIP) {
    k = R_AliasClip(fv[0], fv[1], ALIAS_Z_CLIP, 3, R_Alias_clip_z);
    if (k === 0) return;

    pingpong = 1;
    clipflags = fv[1][0].flags | fv[1][1].flags | fv[1][2].flags;
  } else {
    pingpong = 0;
    k = 3;
  }

  if (clipflags & ALIAS_LEFT_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_LEFT_CLIP, k, R_Alias_clip_left);
    if (k === 0) return;
    pingpong ^= 1;
  }

  if (clipflags & ALIAS_RIGHT_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_RIGHT_CLIP, k, R_Alias_clip_right);
    if (k === 0) return;
    pingpong ^= 1;
  }

  if (clipflags & ALIAS_BOTTOM_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_BOTTOM_CLIP, k, R_Alias_clip_bottom);
    if (k === 0) return;
    pingpong ^= 1;
  }

  if (clipflags & ALIAS_TOP_CLIP) {
    k = R_AliasClip(fv[pingpong], fv[pingpong ^ 1], ALIAS_TOP_CLIP, k, R_Alias_clip_top);
    if (k === 0) return;
    pingpong ^= 1;
  }

  for (let i = 0; i < k; i++) {
    const vert = fv[pingpong][i];
    if (vert.u < r_refdef.aliasvrect.x) vert.u = r_refdef.aliasvrect.x;
    else if (vert.u > r_refdef.aliasvrectright) vert.u = r_refdef.aliasvrectright;

    if (vert.v < r_refdef.aliasvrect.y) vert.v = r_refdef.aliasvrect.y;
    else if (vert.v > r_refdef.aliasvrectbottom) vert.v = r_refdef.aliasvrectbottom;

    vert.flags = 0;
  }

  // draw triangles
  for (let i = 1; i < k - 1; i++) {
    aliastriangleparms.a = fv[pingpong][0];
    aliastriangleparms.b = fv[pingpong][i];
    aliastriangleparms.c = fv[pingpong][i + 1];
    R_DrawTriangle();
  }
}
