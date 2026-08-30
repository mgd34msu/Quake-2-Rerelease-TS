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

Ported from ref_soft/r_part.c (GNU GPL v2 or later). `#if id386 &&
!defined __linux__` guards a `__declspec(naked)` asm rewrite of both the
blend helpers and R_DrawParticle itself; per PORTING.md/this unit's brief
("port the C fallbacks for the asm blend loops") only the portable `#else`
C implementation is ported, matching r_local.h/r_edge.c's `!id386` idiom
used throughout ref_soft.

`BlendParticle33`/`BlendParticle66`/`BlendParticle100` are `static byte(int,
int)` helpers in the C original with no cross-file callers; exported here
anyway purely so this unit's tests can drive the exact alphamap index
arithmetic directly (same shape as r_light.ts's precedent for
R_MarkLights/R_BuildLightMap). R_DrawParticle's own switch calls them
directly instead of re-inlining the identical `vid.alphamap[...]` index
expressions a second time -- byte-for-byte the same arithmetic, so this
is not a behavior change. The C reference implementation additionally
resolves a `blendparticle` function-pointer local that the switch-based
body never actually calls (dead code left over from mirroring the asm
version's calling convention); that dead assignment is dropped rather than
ported verbatim, since it has no observable effect either in C or here.

Cross-module mutable state: `d_vrectx`/`d_vrecty`/`d_vrectright_particle`/
`d_vrectbottom_particle`/`d_pix_min`/`d_pix_max`/`d_pix_shift` are r_local.h
externs owned here -- D_ViewChanged (r_misc.ts) is their only writer and
R_DrawParticle their only reader -- and are set through the exported
`D_Set*` functions, since an imported `let` binding is read-only to the
importer. `xcenter`/`ycenter`/`xscaleshrink`/`yscaleshrink` are shared with
r_rast.ts/r_edge.ts, so they stay owned by r_local.ts and
D_SetParticleCenter/D_SetParticleShrink forward to its setters.
*/

import { vec3, DotProduct, VectorSubtract, VectorScale, VectorCopy } from "../shared/math";
import type { ParticleT } from "../client/ref";
import {
  PARTICLE_Z_CLIP,
  r_pright,
  r_pup,
  r_ppn,
  r_origin,
  vright,
  vup,
  vpn,
  vid,
  r_newrefdef,
  d_scantable,
  xcenter,
  ycenter,
  xscaleshrink,
  yscaleshrink,
  SetViewCenter,
  SetViewShrink,
} from "./r_local";
import { d_viewbuffer, r_screenwidth, d_pzbuffer, d_zwidth } from "./r_scan";

const PARTICLE_33 = 0;
const PARTICLE_66 = 1;
const PARTICLE_OPAQUE = 2;

interface PartparmsT {
  particle: ParticleT | null;
  level: number;
  color: number;
}

const partparms: PartparmsT = { particle: null, level: 0, color: 0 };

// `d_vrect*`/`d_pix_*` (r_local.h externs) are owned here: D_ViewChanged
// (r_misc.ts) is their only writer and R_DrawParticle their only reader.
let d_vrectx = 0;
let d_vrecty = 0;
let d_vrectright_particle = 0;
let d_vrectbottom_particle = 0;
let d_pix_min = 0;
let d_pix_max = 0;
let d_pix_shift = 0;

export function D_SetParticleCenter(xc: number, yc: number): void {
  SetViewCenter(xc, yc);
}

export function D_SetParticleShrink(xs: number, ys: number): void {
  SetViewShrink(xs, ys);
}

export function D_SetParticleClipRect(vrectx: number, vrecty: number, vrectRightParticle: number, vrectBottomParticle: number): void {
  d_vrectx = vrectx;
  d_vrecty = vrecty;
  d_vrectright_particle = vrectRightParticle;
  d_vrectbottom_particle = vrectBottomParticle;
}

export function D_SetParticlePixRange(min: number, max: number, shift: number): void {
  d_pix_min = min;
  d_pix_max = max;
  d_pix_shift = shift;
}

export function BlendParticle33(pcolor: number, dstcolor: number): number {
  const alphamap = vid.alphamap;
  //	return vid.alphamap[color + dstcolor*256];
  return alphamap === null ? pcolor : alphamap[pcolor + dstcolor * 256];
}

export function BlendParticle66(pcolor: number, dstcolor: number): number {
  const alphamap = vid.alphamap;
  //	return vid.alphamap[pcolor*256 + dstcolor];
  return alphamap === null ? pcolor : alphamap[pcolor * 256 + dstcolor];
}

export function BlendParticle100(pcolor: number, _dstcolor: number): number {
  return pcolor;
}

/*
** R_DrawParticle
**
** Yes, this is amazingly slow, but it's the C reference
** implementation and should be both robust and vaguely
** understandable. The only time this path should be
** executed is if we're debugging on x86 or if we're
** recompiling and deploying on a non-x86 platform.
*/
export function R_DrawParticle(): void {
  const pparticle = partparms.particle;
  if (pparticle === null) return;

  const level = partparms.level;

  // transform the particle
  const local = vec3();
  VectorSubtract(pparticle.origin, r_origin, local);

  const transformed = vec3();
  transformed[0] = DotProduct(local, r_pright);
  transformed[1] = DotProduct(local, r_pup);
  transformed[2] = DotProduct(local, r_ppn);

  if (transformed[2] < PARTICLE_Z_CLIP) return;

  // project the point
  // FIXME: preadjust xcenter and ycenter
  const zi = 1.0 / transformed[2];
  const u = (Math.trunc(xcenter + zi * transformed[0] + 0.5)) | 0;
  const v = (Math.trunc(ycenter - zi * transformed[1] + 0.5)) | 0;

  if (v > d_vrectbottom_particle || u > d_vrectright_particle || v < d_vrecty || u < d_vrectx) {
    return;
  }

  if (d_pzbuffer === null || d_viewbuffer === null) return;

  // compute addresses of zbuffer, framebuffer, and
  // compute the Z-buffer reference value.
  let pzIdx = d_zwidth * v + u;
  let pdestIdx = d_scantable[v] + u;
  const izi = (Math.trunc(zi * 0x8000)) | 0;

  // determine the screen area covered by the particle,
  // which also means clamping to a min and max
  let pix = izi >> d_pix_shift;
  if (pix < d_pix_min) pix = d_pix_min;
  else if (pix > d_pix_max) pix = d_pix_max;

  // render the appropriate pixels
  let count = pix;
  const color = partparms.color;

  switch (level) {
    case PARTICLE_33:
      for (; count > 0; count--, pzIdx += d_zwidth, pdestIdx += r_screenwidth) {
        //FIXME--do it in blocks of 8?
        for (let i = 0; i < pix; i++) {
          if (d_pzbuffer[pzIdx + i] <= izi) {
            d_pzbuffer[pzIdx + i] = izi;
            d_viewbuffer[pdestIdx + i] = BlendParticle33(color, d_viewbuffer[pdestIdx + i]);
          }
        }
      }
      break;

    case PARTICLE_66:
      for (; count > 0; count--, pzIdx += d_zwidth, pdestIdx += r_screenwidth) {
        for (let i = 0; i < pix; i++) {
          if (d_pzbuffer[pzIdx + i] <= izi) {
            d_pzbuffer[pzIdx + i] = izi;
            d_viewbuffer[pdestIdx + i] = BlendParticle66(color, d_viewbuffer[pdestIdx + i]);
          }
        }
      }
      break;

    default: //100
      for (; count > 0; count--, pzIdx += d_zwidth, pdestIdx += r_screenwidth) {
        for (let i = 0; i < pix; i++) {
          if (d_pzbuffer[pzIdx + i] <= izi) {
            d_pzbuffer[pzIdx + i] = izi;
            d_viewbuffer[pdestIdx + i] = BlendParticle100(color, d_viewbuffer[pdestIdx + i]);
          }
        }
      }
      break;
  }
}

/*
** R_DrawParticles
**
** Responsible for drawing all of the particles in the particle list
** throughout the world. Doesn't care if we're using the C path or
** if we're using the asm path, it simply assigns a function pointer
** and goes.
*/
export function R_DrawParticles(): void {
  VectorScale(vright, xscaleshrink, r_pright);
  VectorScale(vup, yscaleshrink, r_pup);
  VectorCopy(vpn, r_ppn);

  const particles = r_newrefdef.particles;
  const numParticles = r_newrefdef.num_particles;

  for (let i = 0; i < numParticles; i++) {
    const p = particles[i];

    if (p.alpha > 0.66) partparms.level = PARTICLE_OPAQUE;
    else if (p.alpha > 0.33) partparms.level = PARTICLE_66;
    else partparms.level = PARTICLE_33;

    partparms.particle = p;
    partparms.color = p.color;

    R_DrawParticle();
  }
}
