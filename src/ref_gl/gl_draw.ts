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

ANIMATED GIF FRAME SELECTION (no classic-engine precedent -- see
qcommon/gif.ts's own header comment for the full design): `pickGifFrame`
is the one seam every pic-drawing function below (Draw_Pic, Draw_StretchPic,
Draw_ColorPic, Draw_StretchPicRegion, Draw_TileClear) routes its resolved
ImageT through before binding a texture or reading texcoords. It is a
no-op for anything that isn't a multi-frame animated GIF (ImageT.gifFrames
null or length < 2 -- gl_local.ts's ImageT.gifFrames doc comment). Which
frame is "now" comes from `gifBeatSeconds`, set by SetGifBeatSeconds
(ref.ts's RefExports member of the same name) -- cl_scrn.ts's
SCR_UpdateScreen calls it once per draw-context switch (cl.time-derived
seconds for in-game HUD/2D draws, cls.realtime-derived seconds for menu/
console draws), not once per individual Draw_* call.
*/

import { ERR_FATAL, PRINT_ALL, Com_sprintf } from "../shared/q_shared";
import { gifBeatFrame } from "../qcommon/gif_beat";
import type { ImageT } from "./gl_local";
import { d_8to24table, gl_config, gl_tex_solid_format, glCvars, gltextures, GL_RENDERER_MCD, GL_RENDERER_RENDITION, numgltextures, registration_sequence, ri, vid } from "./gl_local";
import {
  GL_ALPHA_TEST,
  GL_BLEND,
  GL_Bind,
  GL_COLOR_INDEX,
  GL_COLOR_INDEX8_EXT,
  GL_FindImage,
  GL_LINEAR,
  GL_LoadPic,
  GL_NEAREST,
  GL_REPLACE,
  GL_TexEnv,
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

/** GL_MODULATE. gl_image.ts exports GL_REPLACE but not its counterpart;
 *  gl_worldtext.ts declares it locally for the same reason. */
const GL_MODULATE = 0x2100;

export let draw_chars: ImageT | null = null;

export let r_rawpalette: Uint32Array = new Uint32Array(256);
export function SetRawPalette(palette: Uint32Array): void {
  r_rawpalette.set(palette);
}

// Animated-GIF frame selection -- see ref.ts's RefExports.SetGifBeatSeconds
// doc comment for the full design and who calls this (cl_scrn.ts's
// SCR_UpdateScreen, once per draw-context switch, not per draw call).
let gifBeatSeconds = 0;
export function SetGifBeatSeconds(seconds: number): void {
  gifBeatSeconds = seconds;
}

// Every Draw_* pic function below resolves its ImageT through this instead
// of using the looked-up image directly: an animated GIF's `gl.gifFrames`
// (set only for `ImagetypeT.it_pic` loads, see gl_local.ts's ImageT.gifFrames
// doc comment and gl_image.ts's GL_LoadByExt "gif" case) picks which
// composited frame's own texture is bound this draw, at the fixed 10Hz
// TIME-derived cadence qcommon/gif_beat.ts's gifBeatFrame implements. An
// ordinary (non-GIF, or single-frame GIF) image's gifFrames is null, so
// this is a no-op indirection for every non-animated pic.
function pickGifFrame(gl: ImageT): ImageT {
  if (!gl.gifFrames || gl.gifFrames.length < 2) return gl;
  const index = gifBeatFrame(gifBeatSeconds, gl.gifFrames.length);
  return gl.gifFrames[index];
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
  // q2repro's IF_SPECIAL images (refresh/images.c:1913-1917's
  // load_special_image, registered at images.c:2291): a name beginning with
  // "_" is GENERATED by the renderer, not loaded from disk. "_white" is the
  // 1x1 opaque white texel that every SCR_DrawColorPic call tints -- the
  // rerelease cgame HUD's boss health bars, story background and timer
  // background (src/kexgame/cgame/cg_screen.ts) and the classic cgame's own
  // bar draws all go through it. Without this branch each of those hit the
  // "Can't find pic: _white" path below and drew nothing at all.
  if (pic[0] === "_") return Draw_SpecialPic(pic);

  if (pic[0] !== "/" && pic[0] !== "\\") {
    const fullname = Com_sprintf("pics/%s.pcx", pic);
    return GL_FindImage(fullname, ImagetypeT.it_pic);
  }
  return GL_FindImage(pic.slice(1), ImagetypeT.it_pic);
}

/*
=============
Draw_SpecialPic

The renderer-generated images q2repro flags IF_SPECIAL. Only "_white" is
defined upstream, so only "_white" is defined here; anything else with a
leading "_" resolves to null and takes the caller's usual not-found path.

Created on first use rather than in GL_InitImages so it survives
R_FreeUnusedImages the same way any other in-use pic does (it is looked up
again, and re-stamped with the current registration sequence, on every
frame it is drawn). GL_LoadPic is called with bits=32, which keeps it off
the 8-bit scrap-atlas path -- a 1x1 entry in the scrap would bleed its
neighbours' texels through the +/-0.01 texcoord inset that path uses.
=============
*/
function Draw_SpecialPic(name: string): ImageT | null {
  if (name !== "_white") return null;

  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (image.name === name) {
      image.registration_sequence = registration_sequence;
      return image;
    }
  }

  // images.c:1914-1916 -- one texel, 0xFF in every channel.
  const texel = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  return GL_LoadPic(name, texel, 1, 1, ImagetypeT.it_pic, 32);
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
  const frame = pickGifFrame(gl);

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !frame.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(frame.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(frame.sl, frame.tl);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(frame.sh, frame.tl);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f(frame.sh, frame.th);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(frame.sl, frame.th);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}

/*
=============
Draw_ColorPic

Like Draw_StretchPic, but modulated by a color instead of drawn full-white.
No classic-engine precedent (ref_gl/gl_draw.c never had a tinted pic draw);
added for the rerelease cgame API's SCR_DrawColorPic. Mirrors how
Draw_FadeScreen already tints its quad here: qglColor4f() before the quad,
reset to (1,1,1,1) after so every other draw call downstream keeps getting
full-white vertices (matches this file's existing convention -- see
Draw_FadeScreen and Draw_Fill below, both of which reset color the same
way). Blending is enabled only when the tint carries alpha < 255, same
condition Draw_FadeScreen uses to decide whether GL_BLEND needs to be on.
=============
*/
export function Draw_ColorPic(x: number, y: number, w: number, h: number, pic: string, color: { r: number; g: number; b: number; a: number }): void {
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
  const frame = pickGifFrame(gl);

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !frame.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  const translucent = color.a < 255;
  if (translucent) qgl.qglEnable(GL_BLEND);

  // The 2D pass runs with GL_REPLACE (gl_rmisc.ts's GL_SetDefaultState, and
  // every classic Draw_* path leaves it that way), under which the TEXEL
  // replaces the current colour and qglColor4f below is ignored entirely --
  // so a tinted pic drew at full texel colour, i.e. "_white" drew white no
  // matter what tint was asked for. MODULATE for the duration of this quad,
  // back to REPLACE after, so nothing downstream inherits the change. Same
  // pattern and the same reason as gl_worldtext.ts's own GL_TexEnv(
  // GL_MODULATE) around its tinted glyph batch; going through GL_TexEnv
  // rather than qglTexEnvf keeps gl_image.ts's cached mode record honest.
  GL_TexEnv(GL_MODULATE);

  qgl.qglColor4f(color.r / 255, color.g / 255, color.b / 255, color.a / 255);

  GL_Bind(frame.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(frame.sl, frame.tl);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(frame.sh, frame.tl);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f(frame.sh, frame.th);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(frame.sl, frame.th);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  qgl.qglColor4f(1, 1, 1, 1);
  GL_TexEnv(GL_REPLACE);
  if (translucent) qgl.qglDisable(GL_BLEND);

  if (disableAlphaTest) qgl.qglEnable(GL_ALPHA_TEST);
}

/*
=============
Draw_StretchPicRegion

Like Draw_ColorPic, but samples a pixel-space sub-rectangle of the source
image instead of the whole thing. No classic-engine precedent (same as
Draw_ColorPic above) -- added for RefExports.DrawStretchPicRegion (see that
interface member's own doc comment, client/ref.ts). `gl.sl/sh/tl/th` are the
FULL image's texcoord bounds (0..1 for a normal non-scrap-packed image, a
sub-range for one packed into the 8-bit scrap atlas -- see GL_LoadPic's own
scrap-vs-non-scrap branch in gl_image.ts); srcX/srcY/srcW/srcH (source pixel
coordinates) are mapped into that same bounds range here, so this composes
correctly with both cases without needing to know which one applies.
=============
*/
export function Draw_StretchPicRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  pic: string,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  color: { r: number; g: number; b: number; a: number },
): void {
  // C declares these parameters int; truncate at the boundary as the
  // parameter types did (matches ref_soft/r_draw.ts and this file's own
  // Draw_ColorPic above).
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const gl = Draw_FindPic(pic);
  if (!gl) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${pic}\n`);
    return;
  }
  const frame = pickGifFrame(gl);

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !frame.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  const translucent = color.a < 255;
  if (translucent) qgl.qglEnable(GL_BLEND);

  qgl.qglColor4f(color.r / 255, color.g / 255, color.b / 255, color.a / 255);

  const uSpan = frame.sh - frame.sl;
  const vSpan = frame.th - frame.tl;
  const s0 = frame.sl + (srcX / frame.width) * uSpan;
  const s1 = frame.sl + ((srcX + srcW) / frame.width) * uSpan;
  const t0 = frame.tl + (srcY / frame.height) * vSpan;
  const t1 = frame.tl + ((srcY + srcH) / frame.height) * vSpan;

  GL_Bind(frame.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(s0, t0);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(s1, t0);
  qgl.qglVertex2f(x + w, y);
  qgl.qglTexCoord2f(s1, t1);
  qgl.qglVertex2f(x + w, y + h);
  qgl.qglTexCoord2f(s0, t1);
  qgl.qglVertex2f(x, y + h);
  qgl.qglEnd();

  qgl.qglColor4f(1, 1, 1, 1);
  if (translucent) qgl.qglDisable(GL_BLEND);

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
  const frame = pickGifFrame(gl);

  if (scrap_dirty) Scrap_Upload();

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !frame.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(frame.texnum);
  qgl.qglBegin(GL_QUADS);
  qgl.qglTexCoord2f(frame.sl, frame.tl);
  qgl.qglVertex2f(x, y);
  qgl.qglTexCoord2f(frame.sh, frame.tl);
  qgl.qglVertex2f(x + gl.width, y);
  qgl.qglTexCoord2f(frame.sh, frame.th);
  qgl.qglVertex2f(x + gl.width, y + gl.height);
  qgl.qglTexCoord2f(frame.sl, frame.th);
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
  const frame = pickGifFrame(image);

  const disableAlphaTest = mcdOrRenditionAlphaTestQuirk() && !frame.has_alpha;
  if (disableAlphaTest) qgl.qglDisable(GL_ALPHA_TEST);

  GL_Bind(frame.texnum);
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
