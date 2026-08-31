/*
Tests for src/ref_soft/r_image.ts's rerelease-pak PNG-to-palette
quantization (NearestPaletteIndex/QuantizeRGBAToPalette/LoadPNGQuantized)
and R_FindImage's ".pcx"-miss -> ".png" fallback -- see r_image.ts's own
file header comment for the full rationale (rerelease pak0.pak ships
pics/conchars.png and all pics/m_cursor*.png with no .pcx sibling at all,
so this renderer's console text/menu cursor would otherwise stay
permanently missing on rerelease data).

Self-sufficient per PORTING.md rule 13: initializes SetRefImports and
d_8to24table itself; does not depend on another test file having run
first, and does not read any real game data files.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports, d_8to24table } from "../src/ref_soft/r_local";
import { ImagetypeT } from "../src/ref_soft/r_model";
import { NearestPaletteIndex, QuantizeRGBAToPalette, LoadPNGQuantized } from "../src/ref_soft/r_image";

const files = new Map<string, Uint8Array>();

function makeFakeRi(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand: () => undefined,
    Cmd_RemoveCommand: () => undefined,
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => undefined,
    Con_Printf: () => undefined,
    FS_LoadFile: (name: string) => {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => undefined,
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => undefined,
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
  };
}

// Packs r/g/b into d_8to24table's byte layout (byte0=r, byte1=g, byte2=b,
// byte3 unused) -- matches Draw_GetPalette's own construction in r_main.ts.
function setPaletteEntry(index: number, r: number, g: number, b: number): void {
  d_8to24table[index] = ((b << 16) | (g << 8) | r) >>> 0;
}

function clearPalette(): void {
  d_8to24table.fill(0);
}

// ---------------------------------------------------------------------------
// hand-built 8-bit RGBA PNG encoder, identical shape to test/gl_image.test.ts's
// buildPngRgba (colortype 6, filter type 0/None, no interlacing) -- see that
// file's header comment for why this exact IHDR shape matches decodePNG.
// ---------------------------------------------------------------------------
function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}

function buildPngRgba(width: number, height: number, pixelFn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const rowBytes = width * 4;
  const raw = new Uint8Array((rowBytes + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const compressed = new Uint8Array(zlib.deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = buildPngChunk("IHDR", ihdr);
  const idatChunk = buildPngChunk("IDAT", compressed);
  const iendChunk = buildPngChunk("IEND", new Uint8Array(0));

  const out = new Uint8Array(sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let pos = 0;
  out.set(sig, pos);
  pos += sig.length;
  out.set(ihdrChunk, pos);
  pos += ihdrChunk.length;
  out.set(idatChunk, pos);
  pos += idatChunk.length;
  out.set(iendChunk, pos);
  return out;
}

beforeEach(() => {
  files.clear();
  SetRefImports(makeFakeRi());
  clearPalette();
});

describe("NearestPaletteIndex", () => {
  test("picks the exact match when one exists", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(1, 255, 0, 0);
    setPaletteEntry(2, 0, 255, 0);
    setPaletteEntry(3, 0, 0, 255);

    expect(NearestPaletteIndex(0, 255, 0)).toBe(2);
  });

  test("picks the closest color by squared Euclidean distance when there is no exact match", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(1, 100, 100, 100);
    setPaletteEntry(2, 200, 200, 200);

    expect(NearestPaletteIndex(90, 90, 90)).toBe(1);
    expect(NearestPaletteIndex(180, 180, 180)).toBe(2);
  });

  test("never returns index 255 (reserved for transparency) even if it is the closest RGB match", () => {
    for (let i = 0; i < 255; i++) setPaletteEntry(i, 200, 200, 200); // far from black
    setPaletteEntry(254, 0, 0, 0); // the only close, searchable entry
    setPaletteEntry(255, 1, 1, 1); // closer still to (0,0,0), but reserved

    expect(NearestPaletteIndex(0, 0, 0)).toBe(254);
  });
});

describe("QuantizeRGBAToPalette", () => {
  test("maps known opaque RGBA texels to their expected nearest palette index", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(5, 255, 0, 0);
    setPaletteEntry(9, 0, 0, 255);

    const rgba = new Uint8Array([
      0, 0, 0, 255, // -> 0
      255, 0, 0, 255, // -> 5
      0, 0, 255, 255, // -> 9
      1, 1, 1, 255, // -> nearest to (0,0,0) among what's populated -> 0
    ]);

    expect(Array.from(QuantizeRGBAToPalette(rgba, 4, 1))).toEqual([0, 5, 9, 0]);
  });

  test("maps texels below the alpha threshold to index 255 (transparent) regardless of color", () => {
    setPaletteEntry(5, 255, 0, 0);

    const rgba = new Uint8Array([
      255, 0, 0, 0, // alpha 0 -> transparent despite an exact color match
      255, 0, 0, 127, // alpha 127 (below the 128 threshold) -> transparent
      255, 0, 0, 128, // alpha 128 (at the threshold) -> opaque, quantized
    ]);

    expect(Array.from(QuantizeRGBAToPalette(rgba, 3, 1))).toEqual([255, 255, 5]);
  });
});

describe("LoadPNGQuantized", () => {
  test("decodes a hand-built PNG and quantizes it against the current palette", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(1, 255, 255, 255);

    files.set(
      "pics/test.png",
      buildPngRgba(2, 1, (x) => (x === 0 ? [10, 10, 10, 255] : [240, 240, 240, 255])),
    );

    const result = LoadPNGQuantized("pics/test.png");

    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(Array.from(result.pic ?? [])).toEqual([0, 1]);
  });

  test("returns a null pic for a missing file", () => {
    const result = LoadPNGQuantized("pics/missing.png");
    expect(result.pic).toBeNull();
  });
});

// r_image.ts's `r_images`/`numr_images` are module-level cache state with
// no reset between tests (R_FindImage's own first move is a linear scan
// for an already-cached entry by exact name) -- a real classic install's
// actual pics/conchars.pcx, loaded by some other, unrelated test running
// earlier in the same `bun test` process, would otherwise satisfy this
// describe block's own R_FindImage("pics/conchars.pcx", ...) call straight
// out of that shared cache before it ever reaches this file's fake
// FS_LoadFile, defeating the whole point of the test. Importing r_image.ts
// through a private, file-scoped query string (same technique
// test/bspx_renderer.test.ts and test/lightgrid_q64.test.ts already use
// for r_model.ts's mod_known singleton) gives this describe block its own
// independent r_images/numr_images instance instead.
describe("R_FindImage -- rerelease-pak PNG fallback on a PCX miss", () => {
  let rImage: typeof import("../src/ref_soft/r_image");
  let isolationCounter = 0;

  beforeEach(async () => {
    isolationCounter++;
    rImage = await import("../src/ref_soft/r_image" + "?r_image_png_test_isolation_" + isolationCounter);
  });

  test("pics/conchars.pcx not found (rerelease data) falls back to pics/conchars.png, quantized", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(7, 128, 64, 32);

    files.set(
      "pics/conchars.png",
      buildPngRgba(1, 1, () => [128, 64, 32, 255]),
    );

    const image = rImage.R_FindImage("pics/conchars.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/conchars.png");
    expect(image?.width).toBe(1);
    expect(image?.height).toBe(1);
    expect(Array.from(image?.pixels[0] ?? [])).toEqual([7]);
  });

  test("returns null when neither the .pcx nor a .png fallback exists", () => {
    const image = rImage.R_FindImage("pics/nonexistent.pcx", ImagetypeT.it_pic);
    expect(image).toBeNull();
  });
});

describe("r_main.ts R_Init ordering -- palette before quantize", () => {
  test("Draw_GetPalette precedes Draw_InitLocal in R_Init (quantized conchars nearest-match against d_8to24table; an empty table maps every glyph to black -- found live)", async () => {
    const src = await Bun.file(new URL("../src/ref_soft/r_main.ts", import.meta.url)).text();
    const body = src.slice(src.indexOf("export function R_Init"));
    const palette = body.indexOf("Draw_GetPalette()");
    const initLocal = body.indexOf("Draw_InitLocal()");
    expect(palette).toBeGreaterThan(-1);
    expect(initLocal).toBeGreaterThan(-1);
    expect(palette).toBeLessThan(initLocal);
  });
});
