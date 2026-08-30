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
import { ri, vid, TRANSPARENT_COLOR } from "./r_local";
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
