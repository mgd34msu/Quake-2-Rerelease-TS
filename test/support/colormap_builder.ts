/*
Test support module, not a port of any .c file.

Builds the one piece of game data the software renderer refuses to start
without: `pics/colormap.pcx`. Draw_GetPalette (r_main.ts) loads it, hands the
pixels to `vid.colormap`, takes `vid.alphamap` from the tail at offset
64*256, and copies the PCX's 256-entry palette into `d_8to24table`.

Shape (matching the real file, see r_local.h's VID_GRADES and Draw_GetPalette):
256 wide by 320 tall, 8bpp.
  - rows 0..63    the shading table, indexed `colormap[(light & 0xff00) + pix]`
                  by r_surf.ts's block drawers -- 64 light levels of 256 entries.
  - rows 64..319  the 256x256 translucency table `vid.alphamap`, indexed
                  `alphamap[a + b*256]` / `alphamap[a*256 + b]` by r_part.ts's
                  particle blends.

The shading table here is the identity at every light level (`colormap[l*256 +
i] === i`), not the real game's darkening ramp: it keeps rendered output equal
to the source texture index, which is what makes a rendered frame assertable
without shipping id's data. The translucency table is the same identity in its
first operand (`alphamap[a + b*256] === a`). Documented deviation from the
real file, deliberate, and only the ordering/geometry of the table matters to
the code paths under test -- none of them assume a particular ramp.

The palette is a 256-step greyscale (`i -> (i, i, i)`) so a written screenshot
round-trips to an obviously-checkable RGB.
*/

import { WritePCX } from "../../src/ref_soft/r_misc";

export const COLORMAP_WIDTH = 256;
export const COLORMAP_ROWS = 64; // VID_GRADES
export const ALPHAMAP_ROWS = 256;
export const COLORMAP_HEIGHT = COLORMAP_ROWS + ALPHAMAP_ROWS;

export function buildColormapPalette(): Uint8Array {
  const palette = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    palette[i * 3 + 0] = i;
    palette[i * 3 + 1] = i;
    palette[i * 3 + 2] = i;
  }
  return palette;
}

export function buildColormapPixels(): Uint8Array {
  const pixels = new Uint8Array(COLORMAP_WIDTH * COLORMAP_HEIGHT);

  // shading table: identity at every light level
  for (let level = 0; level < COLORMAP_ROWS; level++) {
    for (let i = 0; i < 256; i++) pixels[level * 256 + i] = i;
  }

  // translucency table: alphamap[a + b*256] === a
  const alphaBase = COLORMAP_ROWS * 256;
  for (let b = 0; b < 256; b++) {
    for (let a = 0; a < 256; a++) pixels[alphaBase + b * 256 + a] = a;
  }

  return pixels;
}

export function buildColormapPcx(): Uint8Array {
  return WritePCX(buildColormapPixels(), COLORMAP_WIDTH, COLORMAP_HEIGHT, COLORMAP_WIDTH, buildColormapPalette());
}
