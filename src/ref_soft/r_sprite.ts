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

Ported from ref_soft/r_sprite.c (GNU GPL v2 or later). `#if 0`-guarded frame
range check/clamp in the C original is dropped silently per PORTING.md.

`s_psprite`/`s_psprframe` are `ParsedSp2T`/its `frames[]` element (r_model.ts's
name for `dsprite_t`/`dsprframe_t`, this unit's brief: "adapt raw-pointer
walks, report" -- `currentmodel->extradata` is `unknown` there, narrowed here
via `instanceof ParsedSp2T` the same way r_model.ts narrows its own two
sprite/alias `extradata` blobs).

`currentmodel`/`currententity` (r_local.h externs) are read from r_bsp.ts's
shadow of them rather than r_local.ts's stale copies, matching r_light.ts's
identical precedent (see that file's header comment) -- r_bsp.ts is the one
sibling every ref_soft unit agrees owns a real, currently-assignable copy of
these two fields. `r_polydesc`/`r_clip_verts` (r_local.h's shared shapes for
these but not their storage -- the real global is `polydesc_t r_polydesc;`
in r_poly.c, `extern`'d here in the original) are imported from r_poly.ts,
this port's true owner of that storage.
*/

import { vec3, VectorCopy, VectorScale, VectorInverse } from "../shared/math";
import { RF_TRANSLUCENT } from "../shared/q_shared";
import { ParsedSp2T } from "./r_model";
import { modelorg, r_entorigin, vup, vright, vpn } from "./r_local";
import { currentmodel, currententity } from "./r_bsp";
import { r_polydesc, r_clip_verts, R_ClipAndDrawPoly } from "./r_poly";

/*
** R_DrawSprite
**
** Draw currententity / currentmodel as a single texture
** mapped polygon
*/
export function R_DrawSprite(): void {
  if (currentmodel === null || currententity === null) return;

  const s_psprite = currentmodel.extradata;
  if (!(s_psprite instanceof ParsedSp2T)) return;

  currententity.frame %= s_psprite.numframes;

  const s_psprframe = s_psprite.frames[currententity.frame];

  const skin = currentmodel.skins[currententity.frame];
  r_polydesc.pixels = skin !== null ? skin.pixels[0] : null;
  r_polydesc.pixel_width = s_psprframe.width;
  r_polydesc.pixel_height = s_psprframe.height;
  r_polydesc.dist = 0;

  // generate the sprite's axes, completely parallel to the viewplane.
  VectorCopy(vup, r_polydesc.vup);
  VectorCopy(vright, r_polydesc.vright);
  VectorCopy(vpn, r_polydesc.vpn);

  // build the sprite poster in worldspace
  const right = vec3();
  const up = vec3();
  const left = vec3();
  const down = vec3();

  VectorScale(r_polydesc.vright, s_psprframe.width - s_psprframe.origin_x, right);
  VectorScale(r_polydesc.vup, s_psprframe.height - s_psprframe.origin_y, up);
  VectorScale(r_polydesc.vright, -s_psprframe.origin_x, left);
  VectorScale(r_polydesc.vup, -s_psprframe.origin_y, down);

  // invert UP vector for sprites
  VectorInverse(r_polydesc.vup);

  const pverts = r_clip_verts[0];

  pverts[0][0] = r_entorigin[0] + up[0] + left[0];
  pverts[0][1] = r_entorigin[1] + up[1] + left[1];
  pverts[0][2] = r_entorigin[2] + up[2] + left[2];
  pverts[0][3] = 0;
  pverts[0][4] = 0;

  pverts[1][0] = r_entorigin[0] + up[0] + right[0];
  pverts[1][1] = r_entorigin[1] + up[1] + right[1];
  pverts[1][2] = r_entorigin[2] + up[2] + right[2];
  pverts[1][3] = s_psprframe.width;
  pverts[1][4] = 0;

  pverts[2][0] = r_entorigin[0] + down[0] + right[0];
  pverts[2][1] = r_entorigin[1] + down[1] + right[1];
  pverts[2][2] = r_entorigin[2] + down[2] + right[2];
  pverts[2][3] = s_psprframe.width;
  pverts[2][4] = s_psprframe.height;

  pverts[3][0] = r_entorigin[0] + down[0] + left[0];
  pverts[3][1] = r_entorigin[1] + down[1] + left[1];
  pverts[3][2] = r_entorigin[2] + down[2] + left[2];
  pverts[3][3] = 0;
  pverts[3][4] = s_psprframe.height;

  r_polydesc.nump = 4;
  r_polydesc.s_offset = r_polydesc.pixel_width >> 1;
  r_polydesc.t_offset = r_polydesc.pixel_height >> 1;
  VectorCopy(modelorg, r_polydesc.viewer_position);

  r_polydesc.stipple_parity = 1;
  if ((currententity.flags & RF_TRANSLUCENT) !== 0) {
    R_ClipAndDrawPoly(currententity.alpha, false, true);
  } else {
    R_ClipAndDrawPoly(1.0, false, true);
  }
  r_polydesc.stipple_parity = 0;
}
