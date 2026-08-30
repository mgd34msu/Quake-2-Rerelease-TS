/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_draw.c (GNU GPL v2 or later).

`draw_chars` (`image_t *draw_chars;`) is this file's own global in the C
source; gl_image.ts's GL_Bind reads it via a static import back into this
file (an intentional two-way import cycle -- see gl_image.ts's header
comment for why that's safe here).

`r_rawpalette` is `extern unsigned r_rawpalette[256];` in gl_draw.c but
defined in gl_rmain.c (R_SetPalette's target) -- a sibling unit, still a
pending stub at the time (real now, out of this unit's SCOPE). Declared here as a zero-initialized
holder with a `SetRawPalette` setter (mirrors gl_local.ts's `ri`/
SetRefImports pattern) for that future unit to wire R_SetPalette to.

The `gl_config.renderer == GL_RENDERER_MCD || (gl_config.renderer &
GL_RENDERER_RENDITION)` alpha-test workaround condition appears four times
in the original, verbatim each time; factored into one local helper here
since PORTING.md's "no new project-wide pattern" concern doesn't cover a
same-file, behavior-preserving extraction of a literal repeated expression.
*/

import { ERR_FATAL, PRINT_ALL, Com_sprintf } from "../shared/q_shared";
import type { ImageT } from "./gl_local";
import { d_8to24table, gl_config, gl_tex_solid_format, glCvars, GL_RENDERER_MCD, GL_RENDERER_RENDITION, ri, vid } from "./gl_local";
import {
  GL_ALPHA_TEST,
  GL_BLEND,
  GL_Bind,
  GL_COLOR_INDEX,
  GL_COLOR_INDEX8_EXT,
  GL_FindImage,
  GL_LINEAR,
  GL_NEAREST,
  GL_QUADS,
  GL_RGBA,
  GL_TEXTURE_2D,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_UNSIGNED_BYTE,
  Scrap_Upload,
  qgl,
  scrap_dirty,
} from "./gl_image";
import { ImagetypeT } from "./gl_local";

export let draw_chars: ImageT | null = null;

export let r_rawpalette: Uint32Array = new Uint32Array(256);
export function SetRawPalette(palette: Uint32Array): void {
  r_rawpalette.set(palette);
}

function mcdOrRenditionAlphaTestQuirk(): boolean {
  return gl_config.renderer === GL_RENDERER_MCD || (gl_config.renderer & GL_RENDERER_RENDITION) !== 0;
}

/*
===============
Draw_InitLocal
===============
*/
export function Draw_InitLocal(): void {
  // load console characters (don't bilerp characters)
  draw_chars = GL_FindImage("pics/conchars.pcx", ImagetypeT.it_pic);
  if (draw_chars) {
    GL_Bind(draw_chars.texnum);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
  }
}

/*
================
Draw_Char

Draws one 8*8 graphics character with 0 being transparent.
It can be clipped to the top of the screen to allow the console to be
smoothly scrolled off.
================
*/
export function Draw_Char(x: number, y: number, num: number): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  num = num | 0;
  const n = num & 255;

  if ((n & 127) === 32) return; // space
  if (y <= -8) return; // totally off screen

  const row = n >>> 4;
  const col = n & 15;

  const frow = row * 0.0625;
  const fcol = col * 0.0625;
  const size = 0.0625;

  GL_Bind(draw_chars ? draw_chars.texnum : 0);

  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(fcol, frow);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(fcol + size, frow);
  qgl.qglVertex2f(x + 8, y);
  qgl.qglTexCoord2f(fcol + size, frow + size);
  qgl.qglVertex2f(x + 8, y + 8);
  qgl.qglTexCoord2f(fcol, frow + size);
  qgl.qglVertex2f(x, y + 8);
  qgl.qglEnd();
}

/*
=============
Draw_FindPic
=============
*/
export function Draw_FindPic(pic: string): ImageT | null {
  if (pic[0] !== "/" && pic[0] !== "\\") {
    const fullname = Com_sprintf("pics/%s.pcx", pic);
    return GL_FindImage(fullname, ImagetypeT.it_pic);
  }
  return GL_FindImage(pic.slice(1), ImagetypeT.it_pic);
}

/*
=============
Draw_GetPicSize
=============
*/
export function Draw_GetPicSize(name: string): { w: number; h: number } {
  const gl = Draw_FindPic(name);
  if (!gl) return { w: -1, h: -1 };
  return { w: gl.width, h: gl.height };
}

/*
=============
Draw_StretchPic
=============
*/
export function Draw_StretchPic(x: number, y: number, w: number, h: number, pic: string): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const gl = Draw_FindPic(pic);
  if (!gl) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${pic}\n`);
    return;
  }

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !gl.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(gl.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(gl.sl, gl.tl);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(gl.sh, gl.tl);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f(gl.sh, gl.th);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(gl.sl, gl.th);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}

/*
=============
Draw_Pic
=============
*/
export function Draw_Pic(x: number, y: number, pic: string): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  const gl = Draw_FindPic(pic);
  if (!gl) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${pic}\n`);
    return;
  }

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !gl.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(gl.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(gl.sl, gl.tl);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(gl.sh, gl.tl);
  qgl.qglVertex2f(x + gl.width, y);
  qgl.qglTexCoord2f(gl.sh, gl.th);
  qgl.qglVertex2f(x + gl.width, y + gl.height);
  qgl.qglTexCoord2f(gl.sl, gl.th);
  qgl.qglVertex2f(x, y + gl.height);
  qgl.qglEnd();

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}

/*
=============
Draw_TileClear

This repeats a 64*64 tile graphic to fill the screen around a sized down
refresh window.
=============
*/
export function Draw_TileClear(x: number, y: number, w: number, h: number, pic: string): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const image = Draw_FindPic(pic);
  if (!image) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${pic}\n`);
    return;
  }

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !image.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(image.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(x / 64.0, y / 64.0);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f((x + w) / 64.0, y / 64.0);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f((x + w) / 64.0, (y + h) / 64.0);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(x / 64.0, (y + h) / 64.0);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}

/*
=============
Draw_Fill

Fills a box of pixels with a single color
=============
*/
export function Draw_Fill(x: number, y: number, w: number, h: number, c: number): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  if (c >>> 0 > 255) {
    ri.Sys_Error(ERR_FATAL, "Draw_Fill: bad color");
  }

  qgl.qglDisable(GL_TEXTURE_2D);

  const table = new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);
  qgl.qglColor3f(table[c * 4 + 0] / 255.0, table[c * 4 + 1] / 255.0, table[c * 4 + 2] / 255.0);

  qgl.qglBegin(GL_QUADS);
  qgl.qglVertex2f(x, y);
  qgl.qglVertex2f(x + w, y);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  qgl.qglColor3f(1, 1, 1);
  qgl.qglEnable(GL_TEXTURE_2D);
}

//=============================================================================

/*
================
Draw_FadeScreen
================
*/
export function Draw_FadeScreen(): void {
  qgl.qglEnable(GL_BLEND);
  qgl.qglDisable(GL_TEXTURE_2D);
  qgl.qglColor4f(0, 0, 0, 0.8);
  qgl.qglBegin(GL_QUADS);

  qgl.qglVertex2f(0, 0);
  qgl.qglVertex2f(vid.width, 0);
  qgl.qglVertex2f(vid.width, vid.height);
  qgl.qglVertex2f(0, vid.height);

  qgl.qglEnd();
  qgl.qglColor4f(1, 1, 1, 1);
  qgl.qglEnable(GL_TEXTURE_2D);
  qgl.qglDisable(GL_BLEND);
}

//====================================================================

/*
=============
Draw_StretchRaw

The original gates the 8-bit paletted-texture upload path on
`!qglColorTableEXT` (a driver-capability probe QGL can't represent -- see
gl_image.ts's header comment on this same collapse); here it becomes the
`gl_ext_palettedtexture` cvar check instead, so the RGBA path (the one this
port can actually exercise/test) is the one taken unless that extension is
explicitly enabled.
=============
*/
export function Draw_StretchRaw(x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts).
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  GL_Bind(0);

  let hscale: number;
  let trows: number;
  if (rows <= 256) {
    hscale = 1;
    trows = rows;
  } else {
    hscale = rows / 256.0;
    trows = 256;
  }
  const t = (rows * hscale) / 256;

  if (!qgl.qglColorTableEXT) { // C gl_draw.c:344: if ( !qglColorTableEXT )
    const image32 = new Uint32Array(256 * 256);
    for (let i = 0; i < trows; i++) {
      const row = (i * hscale) | 0;
      if (row > rows) break;
      const source = cols * row;
      const fracstep = ((cols * 0x10000) / 256) | 0;
      let frac = fracstep >>> 1;
      for (let j = 0; j < 256; j++) {
        image32[i * 256 + j] = r_rawpalette[data[source + (frac >>> 16)]];
        frac = (frac + fracstep) >>> 0;
      }
    }
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, gl_tex_solid_format, 256, 256, 0, GL_RGBA, GL_UNSIGNED_BYTE, image32);
  } else {
    const image8 = new Uint8Array(256 * 256);
    for (let i = 0; i < trows; i++) {
      const row = (i * hscale) | 0;
      if (row > rows) break;
      const source = cols * row;
      const fracstep = ((cols * 0x10000) / 256) | 0;
      let frac = fracstep >>> 1;
      for (let j = 0; j < 256; j++) {
        image8[i * 256 + j] = data[source + (frac >>> 16)];
        frac = (frac + fracstep) >>> 0;
      }
    }
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, 256, 256, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, image8);
  }

  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk();
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(0, 0);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(1, 0);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f(1, t);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(0, t);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}
