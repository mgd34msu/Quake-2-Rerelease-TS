/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_draw.c (GNU GPL v2 or later). `Draw_StretchPicImplementation`
is a static internal helper (not declared in r_local.h) and is module-private,
not exported, per this unit's brief.

`vid.buffer`/`vid.rowbytes`/`vid.width`/`vid.height` (r_local.ts's ViddefT)
are the framebuffer this whole module writes 8-bit palette-index pixels
into; every `dest`/`source` byte pointer in the C is a `Uint8Array` index
here.
*/

import { ERR_FATAL, PRINT_ALL } from "../shared/q_shared";
import { ri, vid, TRANSPARENT_COLOR, d_8to24table } from "./r_local";
import { R_FindImage } from "./r_image";
import { ImageT, ImagetypeT } from "./r_model";

let draw_chars: ImageT | null = null; // 8*8 graphic characters

//=============================================================================

/*
================
Draw_FindPic
================
*/
export function Draw_FindPic(name: string): ImageT | null {
  if (name[0] !== "/" && name[0] !== "\\") {
    const fullname = `pics/${name}.pcx`;
    return R_FindImage(fullname, ImagetypeT.it_pic);
  }
  return R_FindImage(name.slice(1), ImagetypeT.it_pic);
}

/*
===============
Draw_InitLocal
===============
*/
export function Draw_InitLocal(): void {
  draw_chars = Draw_FindPic("conchars");
}

/*
================
Draw_Char

Draws one 8*8 graphics character
It can be clipped to the top of the screen to allow the console to be
smoothly scrolled off.
================
*/
export function Draw_Char(x: number, y: number, num: number): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  num = num | 0;
  num &= 255;

  if (num === 32 || num === 32 + 128) return;

  if (y <= -8) return; // totally off screen

  //	if ( ( y + 8 ) >= vid.height )
  if (y + 8 > vid.height)
    // PGM - status text was missing in sw...
    return;

  const row = num >> 4;
  const col = num & 15;
  if (!draw_chars) return;
  const sourceBuf = draw_chars.pixels[0];
  if (!sourceBuf) return;
  let sourceOfs = (row << 10) + (col << 3);

  let drawline: number;
  if (y < 0) {
    // clipped
    drawline = 8 + y;
    sourceOfs -= 128 * y;
    y = 0;
  } else {
    drawline = 8;
  }

  let destOfs = y * vid.rowbytes + x;

  while (drawline--) {
    if (sourceBuf[sourceOfs + 0] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 0] = sourceBuf[sourceOfs + 0];
    if (sourceBuf[sourceOfs + 1] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 1] = sourceBuf[sourceOfs + 1];
    if (sourceBuf[sourceOfs + 2] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 2] = sourceBuf[sourceOfs + 2];
    if (sourceBuf[sourceOfs + 3] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 3] = sourceBuf[sourceOfs + 3];
    if (sourceBuf[sourceOfs + 4] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 4] = sourceBuf[sourceOfs + 4];
    if (sourceBuf[sourceOfs + 5] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 5] = sourceBuf[sourceOfs + 5];
    if (sourceBuf[sourceOfs + 6] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 6] = sourceBuf[sourceOfs + 6];
    if (sourceBuf[sourceOfs + 7] !== TRANSPARENT_COLOR) vid.buffer[destOfs + 7] = sourceBuf[sourceOfs + 7];
    sourceOfs += 128;
    destOfs += vid.rowbytes;
  }
}

/*
=============
Draw_GetPicSize
=============
*/
export function Draw_GetPicSize(name: string): { w: number; h: number } {
  const gl = Draw_FindPic(name);
  if (!gl) {
    return { w: -1, h: -1 };
  }
  return { w: gl.width, h: gl.height };
}

/*
=============
Draw_StretchPicImplementation
=============
*/
function Draw_StretchPicImplementation(x: number, y: number, w: number, h: number, pic: ImageT): void {
  if (x < 0 || x + w > vid.width || y + h > vid.height) {
    ri.Sys_Error(ERR_FATAL, "Draw_Pic: bad coordinates");
  }

  const picPixels = pic.pixels[0];
  if (!picPixels) return;

  let height = h;
  let skip: number;
  if (y < 0) {
    skip = -y;
    height += y;
    y = 0;
  } else {
    skip = 0;
  }

  let destOfs = y * vid.rowbytes + x;

  for (let v = 0; v < height; v++, destOfs += vid.rowbytes) {
    const sv = (((skip + v) * pic.height) / h) | 0;
    const sourceOfs = sv * pic.width;
    if (w === pic.width) {
      vid.buffer.set(picPixels.subarray(sourceOfs, sourceOfs + w), destOfs);
    } else {
      let f = 0;
      const fstep = ((pic.width * 0x10000) / w) | 0;
      for (let u = 0; u < w; u += 4) {
        vid.buffer[destOfs + u] = picPixels[sourceOfs + (f >> 16)];
        f += fstep;
        vid.buffer[destOfs + u + 1] = picPixels[sourceOfs + (f >> 16)];
        f += fstep;
        vid.buffer[destOfs + u + 2] = picPixels[sourceOfs + (f >> 16)];
        f += fstep;
        vid.buffer[destOfs + u + 3] = picPixels[sourceOfs + (f >> 16)];
        f += fstep;
      }
    }
  }
}

/*
=============
Draw_StretchPic
=============
*/
export function Draw_StretchPic(x: number, y: number, w: number, h: number, name: string): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const pic = Draw_FindPic(name);
  if (!pic) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${name}\n`);
    return;
  }
  Draw_StretchPicImplementation(x, y, w, h, pic);
}

/*
=============
Draw_ColorPic

No classic-engine precedent: ref_soft/r_draw.c never had a tinted pic draw
(SCR_DrawColorPic is a rerelease-only cgame API import). The framebuffer
here holds 8-bit palette indices, not RGB, so exact color modulation is
impossible -- there is no legacy fallback to match either, since vanilla
Q2's software renderer's only "blend" precedent is Draw_FadeScreen's fixed
ordered-dither checkerboard (writes index 0 to 3-of-every-4 pixels rather
than true alpha blending).

Approach taken here, staying in that same spirit:
  1. Nearest-palette-color remap: for the given tint, build (and cache,
     keyed by r,g,b) a 256-entry table mapping each source palette index i
     to the index of the closest palette entry to (paletteRGB[i] * tint /
     255) by squared RGB distance. This approximates "multiply the pic's
     colors by the tint" as well as an 8-bit indexed palette can.
  2. Alpha is not part of the remap (there is no "half tinted" palette
     entry to remap to) -- instead it is applied as coverage via a 4x4
     ordered (Bayer) dither, a direct generalization of Draw_FadeScreen's
     own fixed checkerboard: alpha=255 always draws the remapped pixel,
     alpha=0 never does, and values between dither between the remapped
     pixel and whatever was already in the framebuffer.
=============
*/
const colorRemapCache = new Map<number, Uint8Array>();

function buildColorRemap(r: number, g: number, b: number): Uint8Array {
  const key = (r << 16) | (g << 8) | b;
  const cached = colorRemapCache.get(key);
  if (cached) return cached;

  const palette = new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const tr = (palette[i * 4 + 0] * r) / 255;
    const tg = (palette[i * 4 + 1] * g) / 255;
    const tb = (palette[i * 4 + 2] * b) / 255;

    let best = 0;
    let bestDist = Infinity;
    for (let j = 0; j < 256; j++) {
      const dr = palette[j * 4 + 0] - tr;
      const dg = palette[j * 4 + 1] - tg;
      const db = palette[j * 4 + 2] - tb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    table[i] = best;
  }
  colorRemapCache.set(key, table);
  return table;
}

// 4x4 Bayer ordered-dither matrix, values 0-15. See Draw_ColorPic's doc
// comment above -- this generalizes Draw_FadeScreen's fixed 2-level
// checkerboard into a coverage fraction usable for arbitrary alpha.
const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

export function Draw_ColorPic(x: number, y: number, w: number, h: number, name: string, color: { r: number; g: number; b: number; a: number }): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const pic = Draw_FindPic(name);
  if (!pic) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${name}\n`);
    return;
  }
  const picPixels = pic.pixels[0];
  if (!picPixels) return;

  if (x < 0 || x + w > vid.width || y + h > vid.height) {
    ri.Sys_Error(ERR_FATAL, "Draw_ColorPic: bad coordinates");
  }

  const remap = buildColorRemap(color.r & 255, color.g & 255, color.b & 255);
  const alphaThreshold = (color.a & 255) >> 4; // 0-15, matches BAYER_4X4's range

  let height = h;
  let skip = 0;
  if (y < 0) {
    skip = -y;
    height += y;
    y = 0;
  }

  let destOfs = y * vid.rowbytes + x;
  const fstep = ((pic.width * 0x10000) / w) | 0;

  for (let v = 0; v < height; v++, destOfs += vid.rowbytes) {
    const sv = (((skip + v) * pic.height) / h) | 0;
    const sourceOfs = sv * pic.width;
    const rowDither = (y + v) & 3;
    let f = 0;
    for (let u = 0; u < w; u++) {
      const tinted = remap[picPixels[sourceOfs + (f >> 16)]];
      f += fstep;
      if (alphaThreshold >= 15 || BAYER_4X4[rowDither * 4 + (u & 3)] < alphaThreshold) {
        vid.buffer[destOfs + u] = tinted;
      }
    }
  }
}

/*
=============
Draw_StretchRaw
=============
*/
export function Draw_StretchRaw(x: number, y: number, w: number, h: number, cols: number, rows: number, data: Uint8Array): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  const pic = new ImageT();
  pic.pixels[0] = data;
  pic.width = cols;
  pic.height = rows;
  Draw_StretchPicImplementation(x, y, w, h, pic);
}

/*
=============
Draw_Pic
=============
*/
export function Draw_Pic(x: number, y: number, name: string): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  const pic = Draw_FindPic(name);
  if (!pic) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${name}\n`);
    return;
  }

  if (x < 0 || x + pic.width > vid.width || y + pic.height > vid.height) return; //	ri.Sys_Error (ERR_FATAL,"Draw_Pic: bad coordinates");

  const picPixels = pic.pixels[0];
  if (!picPixels) return;

  let height = pic.height;
  let sourceOfs = 0;
  if (y < 0) {
    height += y;
    sourceOfs += pic.width * -y;
    y = 0;
  }

  let destOfs = y * vid.rowbytes + x;

  if (!pic.transparent) {
    for (let v = 0; v < height; v++) {
      vid.buffer.set(picPixels.subarray(sourceOfs, sourceOfs + pic.width), destOfs);
      destOfs += vid.rowbytes;
      sourceOfs += pic.width;
    }
  } else {
    if (pic.width & 7) {
      // general
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < pic.width; u++) {
          const tbyte = picPixels[sourceOfs + u];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u] = tbyte;
        }
        destOfs += vid.rowbytes;
        sourceOfs += pic.width;
      }
    } else {
      // unwound
      for (let v = 0; v < height; v++) {
        for (let u = 0; u < pic.width; u += 8) {
          let tbyte = picPixels[sourceOfs + u];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u] = tbyte;
          tbyte = picPixels[sourceOfs + u + 1];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 1] = tbyte;
          tbyte = picPixels[sourceOfs + u + 2];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 2] = tbyte;
          tbyte = picPixels[sourceOfs + u + 3];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 3] = tbyte;
          tbyte = picPixels[sourceOfs + u + 4];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 4] = tbyte;
          tbyte = picPixels[sourceOfs + u + 5];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 5] = tbyte;
          tbyte = picPixels[sourceOfs + u + 6];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 6] = tbyte;
          tbyte = picPixels[sourceOfs + u + 7];
          if (tbyte !== TRANSPARENT_COLOR) vid.buffer[destOfs + u + 7] = tbyte;
        }
        destOfs += vid.rowbytes;
        sourceOfs += pic.width;
      }
    }
  }
}

/*
=============
Draw_TileClear

This repeats a 64*64 tile graphic to fill the screen around a sized down
refresh window.
=============
*/
export function Draw_TileClear(x: number, y: number, w: number, h: number, name: string): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > vid.width) w = vid.width - x;
  if (y + h > vid.height) h = vid.height - y;
  if (w <= 0 || h <= 0) return;

  const pic = Draw_FindPic(name);
  if (!pic) {
    ri.Con_Printf(PRINT_ALL, `Can't find pic: ${name}\n`);
    return;
  }
  const picPixels = pic.pixels[0];
  if (!picPixels) return;

  const x2 = x + w;
  let pdestOfs = y * vid.rowbytes;
  for (let i = 0; i < h; i++, pdestOfs += vid.rowbytes) {
    const psrcOfs = pic.width * ((i + y) & 63);
    for (let j = x; j < x2; j++) vid.buffer[pdestOfs + j] = picPixels[psrcOfs + (j & 63)];
  }
}

/*
=============
Draw_Fill

Fills a box of pixels with a single color
=============
*/
export function Draw_Fill(x: number, y: number, w: number, h: number, c: number): void {
  // C declares these parameters int; JS callers can pass fractional
  // values (typed-array writes at fractional indices are silently dropped),
  // so truncate at the boundary exactly as the C parameter types did.
  x = x | 0;
  y = y | 0;
  w = w | 0;
  h = h | 0;
  if (x + w > vid.width) w = vid.width - x;
  if (y + h > vid.height) h = vid.height - y;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (w < 0 || h < 0) return;
  let destOfs = y * vid.rowbytes + x;
  for (let v = 0; v < h; v++, destOfs += vid.rowbytes) for (let u = 0; u < w; u++) vid.buffer[destOfs + u] = c;
}
//=============================================================================

/*
================
Draw_FadeScreen

================
*/
export function Draw_FadeScreen(): void {
  for (let y = 0; y < vid.height; y++) {
    const pbufOfs = vid.rowbytes * y;
    const t = (y & 1) << 1;

    for (let x = 0; x < vid.width; x++) {
      if ((x & 3) !== t) vid.buffer[pbufOfs + x] = 0;
    }
  }
}
