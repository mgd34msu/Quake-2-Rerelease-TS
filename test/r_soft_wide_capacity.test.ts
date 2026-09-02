/*
Tests for the software renderer's rerelease-family capacity and sky
registration work:

  - src/ref_soft/r_model.ts's model table. Vanilla ref_soft's
    MAX_MOD_KNOWN was 256 (gl_model.c's 512), sized for the classic wire
    format's MAX_MODELS=256. A widened session (shared/cs_remap.ts,
    protocol 4038) can carry MAX_MODELS_WIDE/2 = 4096 non-inline models,
    and a rerelease map can carry that many *N submodels, so both backing
    arrays now grow on demand up to that ceiling.

  - src/qcommon/tga.ts's decodeTGA and src/ref_soft/r_image.ts's
    LoadTGAQuantized / ".tga" candidate. The rerelease ships env/ skies as
    .tga ONLY, and the software renderer could not load a .tga at all, so
    R_SetSky's six lookups all missed and D_SkySurf silently drew nothing.

  - src/ref_soft/r_rast.ts's R_SetSkyTextureSize. Vanilla hardcoded a
    256-texel sky face; the rerelease also ships 512x512 skies.

Self-sufficient per PORTING.md rule 13: builds every buffer it needs,
fakes the `ri` (RefImports) table, initializes d_8to24table itself, reads
no real game data, and restores the shared model table on the way out.
*/

import { afterAll, describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports, d_8to24table, intsintable, sintable, blanktable, AMP2, SIN_BUFFER_SIZE } from "../src/ref_soft/r_local";
import {
  Mod_ForName,
  Mod_Init,
  Mod_TestFreeAllKnown,
  ModtypeT,
  ImagetypeT,
  mod_known,
  IDALIASHEADER,
  ALIAS_VERSION,
} from "../src/ref_soft/r_model";
import { LoadTGAQuantized, QuantizeRGBAToPalette, R_FindImage } from "../src/ref_soft/r_image";
import { R_SetSkyTextureSize, r_skytexinfo } from "../src/ref_soft/r_rast";
import { decodeTGA } from "../src/qcommon/tga";
import { R_InitTurb } from "../src/ref_soft/r_main";

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

// Same shape as test/ref_model.test.ts's buildTestMd2(0): a structurally
// valid MD2 with zero skins, so Mod_LoadAliasModel never reaches
// R_FindImage and the load needs nothing but this buffer.
function buildTestMd2(): Uint8Array {
  const DMDL_HEADER_SIZE = 68;
  const ofsSt = DMDL_HEADER_SIZE;
  const ofsTris = ofsSt + 4;
  const ofsFrames = ofsTris + 12;
  const frameSize = 40 + 1 * 4;
  const ofsGlcmds = ofsFrames + frameSize;
  const ofsSkins = ofsGlcmds;
  const ofsEnd = ofsSkins;

  const buf = new Uint8Array(ofsEnd);
  const view = new DataView(buf.buffer);

  view.setInt32(0, IDALIASHEADER, true);
  view.setInt32(4, ALIAS_VERSION, true);
  view.setInt32(8, 32, true); // skinwidth
  view.setInt32(12, 32, true); // skinheight
  view.setInt32(16, frameSize, true);
  view.setInt32(20, 0, true); // num_skins
  view.setInt32(24, 1, true); // num_xyz
  view.setInt32(28, 1, true); // num_st
  view.setInt32(32, 1, true); // num_tris
  view.setInt32(36, 0, true); // num_glcmds
  view.setInt32(40, 1, true); // num_frames
  view.setInt32(44, ofsSkins, true);
  view.setInt32(48, ofsSt, true);
  view.setInt32(52, ofsTris, true);
  view.setInt32(56, ofsFrames, true);
  view.setInt32(60, ofsGlcmds, true);
  view.setInt32(64, ofsEnd, true);

  return buf;
}

// ---------------------------------------------------------------------------
// Minimal uncompressed Targa builders (type 2 truecolor / type 3 grayscale)
// and a type 10 RLE builder, matching the header layout decodeTGA reads.
// ---------------------------------------------------------------------------
function tgaHeader(width: number, height: number, imageType: number, pixelSize: number): Uint8Array {
  const h = new Uint8Array(18);
  h[2] = imageType;
  h[12] = width & 0xff;
  h[13] = (width >> 8) & 0xff;
  h[14] = height & 0xff;
  h[15] = (height >> 8) & 0xff;
  h[16] = pixelSize;
  return h;
}

// Targa scanlines are stored bottom-up, so row 0 of `rows` is the BOTTOM
// row of the resulting top-down image -- callers below account for that.
function buildTga24(width: number, height: number, rgbAt: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(18 + width * height * 3);
  out.set(tgaHeader(width, height, 2, 24), 0);
  let p = 18;
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, row);
      out[p++] = b;
      out[p++] = g;
      out[p++] = r;
    }
  }
  return out;
}

function buildTga32(width: number, height: number, rgbaAt: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(18 + width * height * 4);
  out.set(tgaHeader(width, height, 2, 32), 0);
  let p = 18;
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgbaAt(x, row);
      out[p++] = b;
      out[p++] = g;
      out[p++] = r;
      out[p++] = a;
    }
  }
  return out;
}

function buildTga8Gray(width: number, height: number, grayAt: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(18 + width * height);
  out.set(tgaHeader(width, height, 3, 8), 0);
  let p = 18;
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) out[p++] = grayAt(x, row);
  }
  return out;
}

// One run-length packet per scanline, all pixels the same colour.
function buildTga24RleSolidRows(width: number, height: number, rgbForRow: (row: number) => [number, number, number]): Uint8Array {
  const body: number[] = [];
  for (let row = 0; row < height; row++) {
    let remaining = width;
    const [r, g, b] = rgbForRow(row);
    while (remaining > 0) {
      const run = Math.min(remaining, 128);
      body.push(0x80 | (run - 1), b, g, r);
      remaining -= run;
    }
  }
  const out = new Uint8Array(18 + body.length);
  out.set(tgaHeader(width, height, 10, 24), 0);
  out.set(Uint8Array.from(body), 18);
  return out;
}

function setPaletteEntry(index: number, r: number, g: number, b: number): void {
  d_8to24table[index] = ((b << 16) | (g << 8) | r) >>> 0;
}

// Pixel (x,y) of a top-down RGBA8 decode result.
function texel(image: { width: number; pixels: Uint8Array }, x: number, y: number): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.pixels[o], image.pixels[o + 1], image.pixels[o + 2], image.pixels[o + 3]];
}

afterAll(() => {
  Mod_TestFreeAllKnown();
});

beforeEach(() => {
  files.clear();
  SetRefImports(makeFakeRi());
  Mod_Init();
  Mod_TestFreeAllKnown();
  d_8to24table.fill(0);
});

// ---------------------------------------------------------------------------

describe("ref_soft model table under a widened session", () => {
  test("registers 730 distinct models with no loss", () => {
    // 730 is well past vanilla ref_soft's MAX_MOD_KNOWN of 256 (and past
    // gl_model.c's 512): before the table grew, model 257 hard-errored
    // with "mod_numknown == MAX_MOD_KNOWN".
    const COUNT = 730;
    const md2 = buildTestMd2();
    const names: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const name = `models/synthetic/m${i}/tris.md2`;
      names.push(name);
      files.set(name, md2);
    }

    const loaded = names.map((n) => Mod_ForName(n, false));

    // every one of them loaded, and as an alias model
    for (let i = 0; i < COUNT; i++) {
      expect(loaded[i]).not.toBeNull();
      expect(loaded[i]?.name).toBe(names[i]);
      expect(loaded[i]?.type).toBe(ModtypeT.mod_alias);
    }

    // each one got its OWN slot -- no silent reuse/overwrite
    const distinct = new Set(loaded);
    expect(distinct.size).toBe(COUNT);

    // and the table really did grow past the vanilla ceiling
    expect(mod_known.length).toBeGreaterThanOrEqual(COUNT);
    for (let i = 0; i < COUNT; i++) {
      expect(mod_known[i].name).toBe(names[i]);
    }
  });

  test("re-requesting an already loaded model returns the same slot", () => {
    const md2 = buildTestMd2();
    files.set("models/a/tris.md2", md2);
    files.set("models/b/tris.md2", md2);

    const a1 = Mod_ForName("models/a/tris.md2", false);
    const b1 = Mod_ForName("models/b/tris.md2", false);
    const a2 = Mod_ForName("models/a/tris.md2", false);

    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    expect(a2).toBe(a1);
    expect(a1).not.toBe(b1);
  });
});

// ---------------------------------------------------------------------------

describe("decodeTGA", () => {
  test("decodes an uncompressed 24-bit truecolor targa top-down", () => {
    // bottom-up storage: source row 0 is the image's BOTTOM row, so a
    // correct decode puts it at y = height-1.
    const tga = buildTga24(2, 2, (x, row) => (row === 0 ? [255, 0, 0] : [0, 0, 255]));
    const res = decodeTGA(tga);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.image.width).toBe(2);
    expect(res.image.height).toBe(2);
    expect(texel(res.image, 0, 0)).toEqual([0, 0, 255, 255]); // top row
    expect(texel(res.image, 1, 1)).toEqual([255, 0, 0, 255]); // bottom row
  });

  test("keeps the alpha byte of a 32-bit targa", () => {
    const tga = buildTga32(1, 1, () => [10, 20, 30, 40]);
    const res = decodeTGA(tga);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(texel(res.image, 0, 0)).toEqual([10, 20, 30, 40]);
  });

  test("decodes a type 3 grayscale targa as opaque gray", () => {
    const tga = buildTga8Gray(2, 1, (x) => (x === 0 ? 0 : 200));
    const res = decodeTGA(tga);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(texel(res.image, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(texel(res.image, 1, 0)).toEqual([200, 200, 200, 255]);
  });

  test("decodes a run-length encoded (type 10) targa", () => {
    const tga = buildTga24RleSolidRows(300, 2, (row) => (row === 0 ? [1, 2, 3] : [4, 5, 6]));
    const res = decodeTGA(tga);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.image.width).toBe(300);
    // runs wider than one 128-pixel packet still fill the whole scanline
    expect(texel(res.image, 0, 1)).toEqual([1, 2, 3, 255]);
    expect(texel(res.image, 299, 1)).toEqual([1, 2, 3, 255]);
    expect(texel(res.image, 150, 0)).toEqual([4, 5, 6, 255]);
  });

  test("rejects unsupported variants and truncated data instead of throwing", () => {
    expect(decodeTGA(new Uint8Array(4))).toMatchObject({ ok: false });

    const colormapped = buildTga24(1, 1, () => [0, 0, 0]);
    colormapped[1] = 1; // colormap_type
    expect(decodeTGA(colormapped)).toMatchObject({ ok: false });

    const badType = buildTga24(1, 1, () => [0, 0, 0]);
    badType[2] = 11; // an image_type this decoder does not handle
    expect(decodeTGA(badType)).toMatchObject({ ok: false });

    const truncated = buildTga24(8, 8, () => [1, 2, 3]).subarray(0, 30);
    expect(decodeTGA(truncated)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------

describe("ref_soft .tga loading", () => {
  test("LoadTGAQuantized maps texels onto the 8-bit palette", () => {
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(7, 255, 0, 0);
    setPaletteEntry(9, 0, 0, 255);

    files.set("env/test_ft.tga", buildTga24(2, 1, (x) => (x === 0 ? [250, 4, 4] : [4, 4, 250])));

    const { pic, width, height } = LoadTGAQuantized("env/test_ft.tga");
    expect(pic).not.toBeNull();
    expect(width).toBe(2);
    expect(height).toBe(1);
    expect(pic?.[0]).toBe(7);
    expect(pic?.[1]).toBe(9);
    // same pipeline the other truecolor loaders use
    expect(Array.from(QuantizeRGBAToPalette(Uint8Array.from([250, 4, 4, 255]), 1, 1))).toEqual([7]);
  });

  test("R_FindImage resolves a .pcx sky request to the .tga that actually ships", () => {
    // Exactly the rerelease sky case: R_SetSky asks for "env/<name><suf>.pcx"
    // (as vanilla always did) and only a .tga exists in the pak.
    setPaletteEntry(0, 0, 0, 0);
    setPaletteEntry(5, 12, 200, 12);
    files.set("env/strogg_moon_ft.tga", buildTga24(4, 4, () => [12, 200, 12]));

    const image = R_FindImage("env/strogg_moon_ft.pcx", ImagetypeT.it_sky);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("env/strogg_moon_ft.tga");
    expect(image?.width).toBe(4);
    expect(image?.height).toBe(4);
    expect(image?.pixels[0]?.[0]).toBe(5);
  });

  test("a sky side with no file at all still resolves to null, not a throw", () => {
    expect(R_FindImage("env/absent_ft.pcx", ImagetypeT.it_sky)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("R_SetSkyTextureSize", () => {
  test("a 256x256 sky keeps vanilla's exact texture axes", () => {
    R_SetSkyTextureSize(0, 256, 256);
    // box_vecs[0] is [(0,-1,0), (-1,0,0)]; at 256 the scale is 1, so the
    // axes stay the unit vectors vanilla's R_InitSkyBox copied verbatim.
    expect(r_skytexinfo[0].vecs[0][0]).toBe(0);
    expect(r_skytexinfo[0].vecs[0][1]).toBe(-1);
    expect(r_skytexinfo[0].vecs[0][2]).toBe(0);
    expect(r_skytexinfo[0].vecs[1][0]).toBe(-1);
  });

  test("a 512x512 sky scales the texture axes so one image spans the face", () => {
    R_SetSkyTextureSize(0, 512, 512);
    expect(r_skytexinfo[0].vecs[0][1]).toBe(-2);
    expect(r_skytexinfo[0].vecs[1][0]).toBe(-2);

    // and back down again -- the scaling is always derived from box_vecs,
    // never applied cumulatively on top of the previous size
    R_SetSkyTextureSize(0, 256, 256);
    expect(r_skytexinfo[0].vecs[0][1]).toBe(-1);
    expect(r_skytexinfo[0].vecs[1][0]).toBe(-1);
  });

  test("non-square sky sides scale each axis independently", () => {
    R_SetSkyTextureSize(3, 512, 256);
    // box_vecs[3] is [(1,0,0), (0,0,-1)]
    expect(r_skytexinfo[3].vecs[0][0]).toBe(2);
    expect(r_skytexinfo[3].vecs[1][2]).toBe(-1);
    R_SetSkyTextureSize(3, 256, 256);
  });
});

// ---------------------------------------------------------------------------

describe("R_InitTurb integer tables", () => {
  test("intsintable holds whole numbers usable as array subscripts", () => {
    R_InitTurb();

    // r_local.h declares `int intsintable[]`; D_WarpScreen (r_scan.ts) uses
    // these values directly as array subscripts (rowptr[v + turb(u)] and
    // column[turb(v) + u]). A fractional value there is not a rounding
    // nit -- it is an absent JS property, so the row+column sum goes NaN,
    // r_warpbuffer[NaN] is undefined, and storing undefined into the
    // Uint8Array framebuffer writes 0. That blanked the ENTIRE underwater
    // view to palette index 0 (maps/mgu5m2.bsp).
    for (let i = 0; i < SIN_BUFFER_SIZE; i++) {
      expect(Number.isInteger(intsintable[i])).toBe(true);
      // AMP2 + sin(..)*AMP2 stays inside [0, 2*AMP2] once truncated
      expect(intsintable[i]).toBeGreaterThanOrEqual(0);
      expect(intsintable[i]).toBeLessThanOrEqual(2 * AMP2);
    }
  });

  test("a warp-style lookup through intsintable never lands off the end", () => {
    R_InitTurb();

    // Mirrors D_WarpScreen's own indexing at 800x600 into a 320x240 warp
    // buffer: rowptr[] is built for h + AMP2*2 entries and column[] for
    // w + AMP2*2, so v + turb(u) and turb(v) + u must both stay inside.
    const w = 800;
    const h = 600;
    const WARP_W = 320;
    const WARP_H = 240;
    const rowptr: number[] = [];
    for (let v = 0; v < h + AMP2 * 2; v++) rowptr.push(WARP_W * Math.trunc((v / (h + AMP2 * 2)) * WARP_H));
    const column: number[] = [];
    for (let u = 0; u < w + AMP2 * 2; u++) column.push(Math.trunc((u / (w + AMP2 * 2)) * WARP_W));

    for (let turbOffset = 0; turbOffset < 128; turbOffset += 37) {
      for (let v = 0; v < h; v += 97) {
        const colBase = intsintable[turbOffset + v];
        for (let u = 0; u < w; u += 89) {
          const idx = rowptr[v + intsintable[turbOffset + u]] + column[colBase + u];
          expect(Number.isInteger(idx)).toBe(true);
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(WARP_W * WARP_H);
        }
      }
    }
  });

  test("sintable is integral too and blanktable stays zeroed", () => {
    R_InitTurb();
    for (let i = 0; i < SIN_BUFFER_SIZE; i += 13) {
      expect(Number.isInteger(sintable[i])).toBe(true);
      expect(blanktable[i]).toBe(0);
    }
  });
});
