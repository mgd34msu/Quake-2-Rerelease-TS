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
import { SetQGL, GL_Bind, GL_FindImage, GL_Upload8, Scrap_AllocBlock, LoadTGA, GL_TEXTURE_2D, GL_QUADS, GL_RGBA, GL_UNSIGNED_BYTE } from "../src/ref_gl/gl_image";
import { Draw_InitLocal, Draw_Char } from "../src/ref_gl/gl_draw";

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
});

describe("GL_FindImage", () => {
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
