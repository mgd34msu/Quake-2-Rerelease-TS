/*
Self-sufficient suite for src/ref_gl/gl_image.ts and gl_draw.ts (rule 13:
every test in this file sets up its own fake RefImports/QGL/gltextures
state in beforeEach; nothing depends on another test file, or another test
in this file, having run first).

The fake RefImports.FS_LoadFile serves synthetic PCX/TGA byte buffers from
an in-memory filename -> Uint8Array map, mirroring test/ref_draw.test.ts's
convention for the software renderer's equivalent suite. QGLRecording (from
qgl.ts) is installed via SetQGL and is this suite's test seam: GL
correctness is asserted as the recorded qgl* call sequence, per this unit's
brief and qgl.ts's own header comment.

Every gltextures[] slot is replaced with a fresh ImageT() and numgltextures
reset to 0 in beforeEach, since gl_local.ts's gltextures/numgltextures are
process-wide singletons this suite mutates. gl_state.currenttextures/
currenttmu are reset the same way for GL_Bind's redundant-bind tracking.
Any it_pic fixture used only to reach a code path (not specifically testing
scrap packing) is built at 128x128 or given an it_wall/it_skin type, so it
never enters GL_LoadPic's scrap-allocation branch (width<64 && height<64 &&
it_pic) and pollute the dedicated Scrap_AllocBlock test's expectations --
scrap_allocated/scrap_texels are module-private in gl_image.ts with no
reset hook, so this suite avoids scrap allocation everywhere except that
one direct-call test.
*/

import { describe, test, expect, beforeEach } from "bun:test";

import { glCvars, SetRefImports, gltextures, ImageT, ImagetypeT, SetNumGltextures, gl_state, d_8to24table } from "../src/ref_gl/gl_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL, GL_Bind, GL_FindImage, GL_Upload8, Scrap_AllocBlock, LoadTGA, LoadPNG, LoadJPG, GL_TEXTURE_2D, GL_QUADS, GL_RGBA, GL_UNSIGNED_BYTE } from "../src/ref_gl/gl_image";
import { Draw_InitLocal, Draw_Char, Draw_FindPic, Draw_StretchPicRegion } from "../src/ref_gl/gl_draw";
import { buildBaselineJpeg } from "./support/jpeg_builder";

let files: Map<string, Uint8Array>;
let qgl: QGLRecording;

function makeFakeRi(): RefImports {
  return {
    Sys_Error(errLevel: number, str: string): never {
      throw new Error(`Sys_Error(${errLevel}): ${str}`);
    },
    Cmd_AddCommand: () => {},
    Cmd_RemoveCommand: () => {},
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => {},
    Con_Printf: () => {},
    FS_LoadFile: (name: string) => {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => {},
    FS_Gamedir: () => "",
    Cvar_Get: () => new CvarT(),
    Cvar_Set: () => new CvarT(),
    Cvar_SetValue: () => {},
    Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// Encodes one PCX scanline (same RLE convention as test/ref_draw.test.ts).
function rleEncodeRow(row: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    const val = row[i];
    let run = 1;
    while (i + run < row.length && row[i + run] === val && run < 63) run++;
    if (run > 1 || (val & 0xc0) === 0xc0) {
      out.push(0xc0 | run, val);
    } else {
      out.push(val);
    }
    i += run;
  }
  return out;
}

function buildPcxBytes(width: number, height: number, pixelFn: (x: number, y: number) => number): Uint8Array {
  const header = new Uint8Array(128);
  header[0] = 0x0a; // manufacturer
  header[1] = 5; // version
  header[2] = 1; // encoding (RLE)
  header[3] = 8; // bits_per_pixel
  const hv = new DataView(header.buffer);
  hv.setUint16(8, width - 1, true); // xmax
  hv.setUint16(10, height - 1, true); // ymax

  const encoded: number[] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(pixelFn(x, y));
    encoded.push(...rleEncodeRow(row));
  }
  const pixelData = new Uint8Array(encoded);

  const palette = new Uint8Array(768);
  for (let i = 0; i < 768; i++) palette[i] = i % 256;

  const bytes = new Uint8Array(header.length + pixelData.length + palette.length);
  bytes.set(header, 0);
  bytes.set(pixelData, header.length);
  bytes.set(palette, header.length + pixelData.length);
  return bytes;
}

// TargaHeader (18 bytes): id_length, colormap_type, image_type (1 byte
// each), colormap_index/length (u16), colormap_size (1 byte), x_origin/
// y_origin/width/height (u16), pixel_size/attributes (1 byte each).
function buildTga24(pixelsBottomToTop: [number, number, number][], width: number, height: number): Uint8Array {
  const header = new Uint8Array(18);
  header[0] = 0; // id_length
  header[1] = 0; // colormap_type
  header[2] = 2; // image_type: uncompressed RGB
  const hv = new DataView(header.buffer);
  hv.setUint16(12, width, true);
  hv.setUint16(14, height, true);
  header[16] = 24; // pixel_size
  header[17] = 0; // attributes

  const body = new Uint8Array(pixelsBottomToTop.length * 3);
  for (let i = 0; i < pixelsBottomToTop.length; i++) {
    const [r, g, b] = pixelsBottomToTop[i];
    body[i * 3 + 0] = b;
    body[i * 3 + 1] = g;
    body[i * 3 + 2] = r;
  }

  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header, 0);
  bytes.set(body, header.length);
  return bytes;
}

// Type 3 (uncompressed, black-and-white/grayscale, 8bpp) -- the format the
// real retail rerelease's sprites/flare_01.tga through flare_04.tga ship
// as (see test/cl_precache_flare_retail.test.ts's own header comment for
// the retail-data survey). One byte per pixel, bottom-to-top row order,
// same convention as buildTga24 above.
function buildTga3Gray(pixelsBottomToTop: number[], width: number, height: number): Uint8Array {
  const header = new Uint8Array(18);
  header[0] = 0; // id_length
  header[1] = 0; // colormap_type
  header[2] = 3; // image_type: uncompressed black-and-white
  const hv = new DataView(header.buffer);
  hv.setUint16(12, width, true);
  hv.setUint16(14, height, true);
  header[16] = 8; // pixel_size
  header[17] = 0; // attributes

  const bytes = new Uint8Array(header.length + pixelsBottomToTop.length);
  bytes.set(header, 0);
  bytes.set(pixelsBottomToTop, header.length);
  return bytes;
}

// Minimal, hand-built, non-copyrighted 8-bit RGBA PNG (colortype 6, no
// interlacing, filter type 0/None on every scanline) -- the exact IHDR
// shape qcommon/png.ts's decodePNG targets (see that module's own header
// comment: verified against the real fonts/qconfont.kfont's texture asset,
// which is 8-bit RGBA non-interlaced too). CRC fields are left zeroed;
// decodePNG does not validate them (see its own header comment).
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
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method: none

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
  files = new Map();
  SetRefImports(makeFakeRi());
  qgl = new QGLRecording();
  SetQGL(qgl);
  for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
  SetNumGltextures(0);
  gl_state.currenttextures[0] = 0;
  gl_state.currenttextures[1] = 0;
  gl_state.currenttmu = 0;
  // rule 13: GL_Upload8's qglTexImage2D-vs-qglColorTableEXT choice reads the
  // shared gl_ext_palettedtexture cvar, which another suite's real R_Init
  // (test/glimp.test.ts) may have left enabled in this process. Pin it off:
  // this suite's assertions are written against the RGBA-expansion path.
  if (glCvars.gl_ext_palettedtexture) glCvars.gl_ext_palettedtexture.value = 0;
});

describe("GL_Bind", () => {
  test("only records qglBindTexture on an actual texture change", () => {
    GL_Bind(5);
    GL_Bind(5); // redundant -- must not record again
    GL_Bind(7);

    const binds = qgl.calls.filter((c) => c.name === "qglBindTexture");
    expect(binds).toHaveLength(2);
    expect(binds[0]?.args).toEqual([GL_TEXTURE_2D, 5]);
    expect(binds[1]?.args).toEqual([GL_TEXTURE_2D, 7]);
  });
});

describe("Scrap_AllocBlock", () => {
  test("packs two small blocks side by side in the same scrap texture", () => {
    const first = Scrap_AllocBlock(8, 8);
    const second = Scrap_AllocBlock(8, 8);

    expect(first).toEqual({ texnum: 0, x: 0, y: 0 });
    expect(second).toEqual({ texnum: 0, x: 8, y: 0 });
  });
});

describe("GL_Upload8", () => {
  test("records a palette-expanded RGBA upload for a power-of-two image", () => {
    // palette index 5 -> r=10 g=20 b=30 a=255 (byte layout matches
    // Draw_GetPalette's construction: byte0=r, byte1=g, byte2=b, byte3=a).
    d_8to24table[5] = ((255 << 24) | (30 << 16) | (20 << 8) | 10) >>> 0;
    const data = new Uint8Array(4).fill(5); // 2x2, already power-of-two

    GL_Upload8(data, 2, 2, false, false);

    const uploads = qgl.calls.filter((c) => c.name === "qglTexImage2D");
    expect(uploads).toHaveLength(1);
    const args = uploads[0]?.args;
    expect(args?.[0]).toBe(GL_TEXTURE_2D);
    expect(args?.[3]).toBe(2); // width
    expect(args?.[4]).toBe(2); // height
    expect(args?.[6]).toBe(GL_RGBA);
    expect(args?.[7]).toBe(GL_UNSIGNED_BYTE);

    const pixels = args?.[8];
    expect(pixels).toBeInstanceOf(Uint32Array);
    const bytes = new Uint8Array((pixels as Uint32Array).buffer);
    for (let i = 0; i < 4; i++) {
      expect(bytes[i * 4 + 0]).toBe(10);
      expect(bytes[i * 4 + 1]).toBe(20);
      expect(bytes[i * 4 + 2]).toBe(30);
      expect(bytes[i * 4 + 3]).toBe(255);
    }
  });

  test("rounds a non-power-of-two width up before uploading", () => {
    const data = new Uint8Array(3 * 2).fill(0);

    GL_Upload8(data, 3, 2, false, false);

    const uploads = qgl.calls.filter((c) => c.name === "qglTexImage2D");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args[3]).toBe(4); // 3 rounds up to 4
    expect(uploads[0]?.args[4]).toBe(2); // 2 is already power-of-two
  });
});

describe("LoadTGA", () => {
  test("decodes a hand-built 24-bit uncompressed TGA exactly", () => {
    // File order is bottom-to-top per the TGA format; LoadTGA writes the
    // first group of pixels read into the LAST output row.
    const bottomRow: [number, number, number][] = [
      [7, 8, 9],
      [10, 11, 12],
    ];
    const topRow: [number, number, number][] = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    files.set("pics/test.tga", buildTga24([...bottomRow, ...topRow], 2, 2));

    const result = LoadTGA("pics/test.tga");

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(Array.from(result.pic ?? [])).toEqual([
      1, 2, 3, 255, 4, 5, 6, 255, // output row 0 (top)
      7, 8, 9, 255, 10, 11, 12, 255, // output row 1 (bottom)
    ]);
  });

  test("returns a null pic for a missing file", () => {
    const result = LoadTGA("pics/missing.tga");
    expect(result.pic).toBeNull();
  });

  // Live bug fix (task report): the real retail sprites/flare_01.tga (a
  // misc_flare glow texture) is a type 3 grayscale TGA. Before this, type 3
  // hit the "Only type 2 and 10" Sys_Error and dropped the client entirely
  // the moment cl_parse.ts's CL_RegisterImage correctly resolved the name
  // instead of mangling it -- see this file's sibling
  // test/cl_precache_flare_retail.test.ts for the real-bytes round trip.
  test("decodes a hand-built 8-bit grayscale (type 3) TGA, expanding each byte to R=G=B, A=255", () => {
    const bottomRow = [10, 200];
    const topRow = [0, 255];
    files.set("sprites/test_gray.tga", buildTga3Gray([...bottomRow, ...topRow], 2, 2));

    const result = LoadTGA("sprites/test_gray.tga");

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(Array.from(result.pic ?? [])).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255, // output row 0 (top)
      10, 10, 10, 255, 200, 200, 200, 255, // output row 1 (bottom)
    ]);
  });

  test("still rejects an unsupported targa type (e.g. type 1, colormapped) instead of silently misdecoding", () => {
    const bytes = buildTga3Gray([0], 1, 1);
    bytes[2] = 1; // image_type: colormapped -- not type 2/3/10
    files.set("sprites/bad_type.tga", bytes);
    expect(() => LoadTGA("sprites/bad_type.tga")).toThrow(/Only type 2, 3 and 10/);
  });
});

describe("LoadPNG", () => {
  test("decodes a hand-built 8-bit RGBA PNG exactly (filter type None, no interlacing)", () => {
    files.set(
      "fonts/test.png",
      buildPngRgba(2, 2, (x, y) => {
        const table: [number, number, number, number][] = [
          [1, 2, 3, 255],
          [4, 5, 6, 128],
          [7, 8, 9, 0],
          [10, 11, 12, 64],
        ];
        return table[y * 2 + x];
      }),
    );

    const result = LoadPNG("fonts/test.png");

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(Array.from(result.pic ?? [])).toEqual([1, 2, 3, 255, 4, 5, 6, 128, 7, 8, 9, 0, 10, 11, 12, 64]);
  });

  test("returns a null pic for a missing file", () => {
    const result = LoadPNG("fonts/missing.png");
    expect(result.pic).toBeNull();
  });
});

describe("LoadJPG", () => {
  test("decodes a hand-built baseline JPEG exactly (4:4:4, single 8x8 constant-color block)", () => {
    // See test/support/jpeg_builder.ts's header comment for why a
    // constant-valued block round-trips through DCT/quant/IDCT exactly,
    // letting this test assert precise expected bytes instead of a
    // tolerance.
    const y = 180,
      cb = 90,
      cr = 200;
    files.set(
      "vault/preview/test.jpg",
      buildBaselineJpeg({
        width: 8,
        height: 8,
        components: [
          { h: 1, v: 1 },
          { h: 1, v: 1 },
          { h: 1, v: 1 },
        ],
        blocks: [[[y - 128], [cb - 128], [cr - 128]]],
      }),
    );

    const result = LoadJPG("vault/preview/test.jpg");

    expect(result.width).toBe(8);
    expect(result.height).toBe(8);
    expect(result.pic).not.toBeNull();
    // Same YCbCr->RGB formula (and 0..255 clamp) jpg.ts's renderOutput uses;
    // pixel (0,0):
    const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    const r = clamp(y + 1.402 * (cr - 128));
    const g = clamp(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
    const b = clamp(y + 1.772 * (cb - 128));
    expect(Array.from(result.pic!.slice(0, 4))).toEqual([r, g, b, 255]);
  });

  test("returns a null pic for a missing file", () => {
    const result = LoadJPG("vault/missing.jpg");
    expect(result.pic).toBeNull();
  });
});

describe("GL_FindImage", () => {
  test("dispatches .png through LoadPNG (truecolor atlas assets, e.g. kfont textures) with a full-image 0..1 texcoord range", () => {
    files.set("fonts/atlas.png", buildPngRgba(2, 2, () => [10, 20, 30, 255]));

    const image = GL_FindImage("fonts/atlas.png", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.width).toBe(2);
    expect(image?.height).toBe(2);
    // bits=32 (truecolor) images never enter GL_LoadPic's 8-bit scrap-atlas
    // branch (see gl_image.ts's GL_LoadPic: `bits === 8` is part of that
    // branch's own condition) -- sl/sh/tl/th stay the full 0..1 range this
    // suite's own header comment already relies on for LoadTGA-loaded images.
    expect(image?.sl).toBe(0);
    expect(image?.sh).toBe(1);
    expect(image?.tl).toBe(0);
    expect(image?.th).toBe(1);
  });

  test("caches by name: a second call for the same name returns the same object", () => {
    files.set("textures/cached.pcx", buildPcxBytes(2, 2, () => 3));

    const first = GL_FindImage("textures/cached.pcx", ImagetypeT.it_wall);
    const second = GL_FindImage("textures/cached.pcx", ImagetypeT.it_wall);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("returns null for a name shorter than 5 characters", () => {
    expect(GL_FindImage("abcd", ImagetypeT.it_pic)).toBeNull();
  });

  test("returns null when the file can't be loaded", () => {
    expect(GL_FindImage("pics/does-not-exist.pcx", ImagetypeT.it_pic)).toBeNull();
  });

  // The rerelease pak ships classic 2D pics ONLY as PNG (pics/conchars.png,
  // pics/m_cursor*.png -- no .pcx at all), so a hard .pcx miss left
  // draw_chars null and DrawChar bound texture 0: solid white glyph quads
  // on a real GL context (found live during Mike's RC pass, 2026-08-30).
  // See GL_FindImage's own comment for the q2repro IMG_Find precedent and
  // the documented requested-format-first order deviation.
  test("a missing .pcx falls back to a .png sibling (rerelease-pak pics)", () => {
    files.set("pics/m_cursor2.png", buildPngRgba(2, 2, () => [10, 20, 30, 255]));

    const image = GL_FindImage("pics/m_cursor2.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/m_cursor2.png");
    expect(image?.width).toBe(2);
  });

  test("a missing .pcx with no .png sibling falls back to a .tga sibling", () => {
    files.set("pics/only.tga", buildTga24([[1, 2, 3]], 1, 1));

    const image = GL_FindImage("pics/only.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/only.tga");
  });

  // The retail vault/ artwork (198 promotional .jpg assets, see
  // qcommon/jpg.ts's own header comment) has no .pcx/.png/.tga sibling
  // either -- this is the last rung of the fallback chain, matching
  // q2repro's own "png jpg tga" texture format probe order.
  test("a missing .pcx with no .png/.tga sibling falls back to a .jpg sibling", () => {
    files.set(
      "vault/only.jpg",
      buildBaselineJpeg({
        width: 8,
        height: 8,
        components: [
          { h: 1, v: 1 },
          { h: 1, v: 1 },
          { h: 1, v: 1 },
        ],
        blocks: [[[10], [20], [30]]],
      }),
    );

    const image = GL_FindImage("vault/only.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("vault/only.jpg");
  });

  test("dispatches .jpg through LoadJPG directly", () => {
    files.set(
      "vault/direct.jpg",
      buildBaselineJpeg({
        width: 8,
        height: 8,
        components: [
          { h: 1, v: 1 },
          { h: 1, v: 1 },
          { h: 1, v: 1 },
        ],
        blocks: [[[10], [20], [30]]],
      }),
    );

    const image = GL_FindImage("vault/direct.jpg", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.width).toBe(8);
    expect(image?.height).toBe(8);
  });

  test("an existing .pcx wins over a .png sibling (classic-data path unchanged)", () => {
    files.set("pics/both.pcx", buildPcxBytes(2, 2, () => 3));
    files.set("pics/both.png", buildPngRgba(2, 2, () => [10, 20, 30, 255]));

    const image = GL_FindImage("pics/both.pcx", ImagetypeT.it_wall);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/both.pcx");
  });
});

describe("Draw_Char", () => {
  test("records a quad with the glyph cell's texcoords", () => {
    // 128x128 conchars sheet -- large enough to skip GL_LoadPic's scrap
    // path regardless of content (only it_pic images under 64x64 scrap).
    files.set("pics/conchars.pcx", buildPcxBytes(128, 128, () => 1));
    Draw_InitLocal();
    qgl.clear();

    const num = 1; // row = num>>4 = 0, col = num&15 = 1
    Draw_Char(20, 6, num);

    const frow = 0 * 0.0625;
    const fcol = 1 * 0.0625;
    const size = 0.0625;

    const names = qgl.calls.map((c) => c.name);
    expect(names).toEqual(["qglBegin", "qglTexCoord2f", "qglVertex2f", "qglTexCoord2f", "qglVertex2f", "qglTexCoord2f", "qglVertex2f", "qglTexCoord2f", "qglVertex2f", "qglEnd"]);
    expect(qgl.calls[0]?.args).toEqual([GL_QUADS]);
    expect(qgl.calls[1]?.args).toEqual([fcol, frow]);
    expect(qgl.calls[2]?.args).toEqual([20, 6]);
    expect(qgl.calls[3]?.args).toEqual([fcol + size, frow]);
    expect(qgl.calls[4]?.args).toEqual([28, 6]);
    expect(qgl.calls[5]?.args).toEqual([fcol + size, frow + size]);
    expect(qgl.calls[6]?.args).toEqual([28, 14]);
    expect(qgl.calls[7]?.args).toEqual([fcol, frow + size]);
    expect(qgl.calls[8]?.args).toEqual([20, 14]);
  });

  test("does nothing for a space character", () => {
    files.set("pics/conchars.pcx", buildPcxBytes(128, 128, () => 1));
    Draw_InitLocal();
    qgl.clear();

    Draw_Char(0, 0, 32);

    expect(qgl.calls).toHaveLength(0);
  });
});

describe("Draw_StretchPicRegion", () => {
  test("maps a pixel-space source sub-rect into the image's 0..1 texcoord range and applies the tint", () => {
    // "/fonts/atlas.png" (leading slash) is the exact-path convention
    // Draw_FindPic gives non-"pics/*.pcx" assets -- see kfont.ts's own
    // header comment ("/" + textureToken) for why the real kfont loader
    // uses this same shape for its atlas texture name.
    files.set("fonts/atlas.png", buildPngRgba(100, 50, () => [1, 2, 3, 255]));
    Draw_FindPic("/fonts/atlas.png"); // registers + binds once, so GL_Bind below is a redundant no-op (see Draw_Char's own precedent above)
    qgl.clear();

    Draw_StretchPicRegion(10, 20, 16, 28, "/fonts/atlas.png", 25, 10, 8, 14, { r: 200, g: 100, b: 50, a: 255 });

    const s0 = 25 / 100;
    const s1 = (25 + 8) / 100;
    const t0 = 10 / 50;
    const t1 = (10 + 14) / 50;

    const colorCalls = qgl.calls.filter((c) => c.name === "qglColor4f");
    expect(colorCalls[0]?.args).toEqual([200 / 255, 100 / 255, 50 / 255, 1]); // a=255 -> opaque, no GL_BLEND toggle
    expect(colorCalls[1]?.args).toEqual([1, 1, 1, 1]); // reset after the quad, matching Draw_ColorPic's own convention

    const texCoords = qgl.calls.filter((c) => c.name === "qglTexCoord2f").map((c) => c.args);
    expect(texCoords).toEqual([
      [s0, t0],
      [s1, t0],
      [s1, t1],
      [s0, t1],
    ]);

    const vertices = qgl.calls.filter((c) => c.name === "qglVertex2f").map((c) => c.args);
    expect(vertices).toEqual([
      [10, 20],
      [10 + 16, 20],
      [10 + 16, 20 + 28],
      [10, 20 + 28],
    ]);

    // GL_Bind was already current from GL_FindImage's own load-time bind
    // (2x2 truecolor image, no scrap) -- a redundant re-bind of the same
    // texnum records nothing, matching GL_Bind's own "only on change" test
    // above.
    expect(qgl.calls.filter((c) => c.name === "qglBindTexture")).toHaveLength(0);
  });

  test("returns without drawing when the named pic can't be found", () => {
    Draw_StretchPicRegion(0, 0, 1, 1, "fonts/does-not-exist.png", 0, 0, 1, 1, { r: 255, g: 255, b: 255, a: 255 });
    expect(qgl.calls).toHaveLength(0);
  });
});
