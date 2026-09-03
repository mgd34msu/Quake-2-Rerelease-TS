/*
Self-sufficient suite for the logical-vs-upload dimension split in
src/ref_gl/gl_image.ts (rule 13: own fake RefImports/QGL/gltextures state in
beforeEach, no dependence on another file having run).

ImageT.width/height are the LOGICAL size the rest of the renderer reasons in;
upload_width/upload_height are what actually reached the driver after
power-of-two rounding and picmip. The distinction only bites in one place --
gl_rsurf.ts's GL_BuildPolygonFromSurface divides the BSP texinfo projection by
image.width/height, because a BSP's texinfo vectors are in the ORIGINAL
texture's texel units -- so a wall whose .wal request was satisfied by a
larger 32-bit file must keep the .wal's size as its logical size or the whole
surface remaps. GL_RecoverLogicalDimensions does that, mirroring q2repro's
get_image_dimensions (src/refresh/images.c:1693-1727).

Every OTHER image class is resolution-independent by construction, and the
tests at the bottom pin that down so a future change cannot quietly introduce
a dependence on the loaded file's size.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { deflateSync } from "node:zlib";

import { glCvars, SetRefImports, gltextures, ImageT, ImagetypeT, SetNumGltextures, gl_state } from "../src/ref_gl/gl_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL, GL_FindImage, GL_InitImages, ResetScrapState } from "../src/ref_gl/gl_image";

let files: Map<string, Uint8Array>;
let shipped: Map<string, Uint8Array>; // what FS_LoadShippedFile sees: the non-homedir copies only
let cvars: Map<string, CvarT>;
let qgl: QGLRecording;

function fakeCvarGet(name: string, value: string): CvarT {
  const existing = cvars.get(name);
  if (existing) return existing;
  const c = new CvarT();
  c.name = name;
  c.string = value;
  c.value = parseFloat(value) || 0;
  cvars.set(name, c);
  return c;
}

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
    FS_LoadShippedFile: (name: string, maxBytes: number) => {
      const data = shipped.get(name);
      return data ? data.subarray(0, maxBytes) : null;
    },
    FS_Gamedir: () => "",
    Cvar_Get: (name: string, value: string) => fakeCvarGet(name, value),
    Cvar_Set: (name: string, value: string) => {
      const c = fakeCvarGet(name, value);
      c.string = value;
      c.value = parseFloat(value) || 0;
      return c;
    },
    Cvar_SetValue: (name: string, value: number) => {
      const c = fakeCvarGet(name, String(value));
      c.string = String(value);
      c.value = value;
    },
    Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

function crc32(buf: Uint8Array): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function buildPngRgba(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 4 + 0] = 200;
      raw[row + 1 + x * 4 + 1] = 100;
      raw[row + 1 + x * 4 + 2] = 50;
      raw[row + 1 + x * 4 + 3] = 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", new Uint8Array(deflateSync(raw))), pngChunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// A .pcx whose HEADER is well-formed and readable (so the logical size can be
// recovered from it) but whose `manufacturer` byte is wrong, so LoadPCX
// rejects it and GL_FindImage falls through to the next extension. This is
// the reachable shape of "the 8-bit original is on disk but the 32-bit file
// is what actually got uploaded".
function buildUnloadablePcxWithGoodHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(128 + 768);
  const hv = new DataView(bytes.buffer);
  bytes[0] = 0x00; // manufacturer: deliberately NOT 0x0a -> LoadPCX bails
  bytes[1] = 5;
  bytes[2] = 1;
  bytes[3] = 8;
  hv.setUint16(4, 0, true); // xmin
  hv.setUint16(6, 0, true); // ymin
  hv.setUint16(8, width - 1, true); // xmax
  hv.setUint16(10, height - 1, true); // ymax
  return bytes;
}

beforeEach(() => {
  files = new Map();
  shipped = new Map();
  cvars = new Map();
  SetRefImports(makeFakeRi());
  qgl = new QGLRecording();
  SetQGL(qgl);
  for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
  SetNumGltextures(0);
  gl_state.currenttextures[0] = 0;
  gl_state.currenttextures[1] = 0;
  gl_state.currenttmu = 0;
  ResetScrapState();
  gl_state.d_16to8table = null;

  fakeCvarGet("intensity", "1");
  fakeCvarGet("vid_gamma", "1");
  fakeCvarGet("gl_picmip", "0");
  fakeCvarGet("gl_round_down", "0");
  // A minimal colormap so GL_InitImages' Draw_GetPalette does not Sys_Error.
  const cm = new Uint8Array(128 + 4 + 768);
  cm[0] = 0x0a;
  cm[1] = 5;
  cm[2] = 1;
  cm[3] = 8;
  const cv = new DataView(cm.buffer);
  cv.setUint16(8, 1, true);
  cv.setUint16(10, 1, true);
  files.set("pics/colormap.pcx", cm);
  GL_InitImages();
  if (glCvars.gl_ext_palettedtexture) glCvars.gl_ext_palettedtexture.value = 0;
  // Glow lookups are irrelevant here and would only add probe noise.
  glCvars.r_glowmaps = fakeCvarGet("r_glowmaps", "0");
});

describe("GL_RecoverLogicalDimensions", () => {
  test("a wall satisfied by a larger 32-bit file keeps the 8-bit original's logical size", () => {
    // The BSP's texinfo vectors are in the original texture's texel units, so
    // gl_rsurf.ts's `s /= image.width` must divide by 64, not 128, or every
    // surface using this texture remaps to a quarter of the geometry.
    files.set("textures/e1u1/wall.pcx", buildUnloadablePcxWithGoodHeader(64, 64));
    files.set("textures/e1u1/wall.png", buildPngRgba(128, 128));

    const image = GL_FindImage("textures/e1u1/wall.pcx", ImagetypeT.it_wall);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("textures/e1u1/wall.png"); // the 32-bit file is what got uploaded
    expect(image?.width).toBe(64); // ...but the LOGICAL size is the original's
    expect(image?.height).toBe(64);
    expect(image?.upload_width).toBe(128); // the extra resolution is still used
    expect(image?.upload_height).toBe(128);
  });

  test("with no 8-bit original on disk there is nothing to recover, so the loaded size stands", () => {
    // This is the ordinary rerelease case: models/.../md5/skin.pcx is asked
    // for, only md5/skin.png exists. Nothing to recover from, and nothing
    // needs recovering -- MD5 texture coordinates are already normalized.
    files.set("models/m/md5/skin.png", buildPngRgba(128, 64));

    const image = GL_FindImage("models/m/md5/skin.pcx", ImagetypeT.it_skin);

    expect(image?.name).toBe("models/m/md5/skin.png");
    expect(image?.width).toBe(128);
    expect(image?.height).toBe(64);
  });

  test("an image loaded under the extension it was asked for is never touched", () => {
    files.set("textures/e1u1/plain.png", buildPngRgba(64, 32));

    const image = GL_FindImage("textures/e1u1/plain.png", ImagetypeT.it_wall);

    expect(image?.width).toBe(64);
    expect(image?.height).toBe(32);
  });

  test("a nonsense original header is ignored rather than poisoning the logical size", () => {
    // xmax/ymax of 0 would make width/height 1x1 here, which is technically
    // in range; use a truncated file instead, which cannot be read at all.
    files.set("textures/e1u1/trunc.pcx", new Uint8Array(4));
    files.set("textures/e1u1/trunc.png", buildPngRgba(64, 64));

    const image = GL_FindImage("textures/e1u1/trunc.pcx", ImagetypeT.it_wall);

    expect(image).not.toBeNull();
    expect(image?.width).toBe(64); // the loaded file's own size, not 0
    expect(image?.height).toBe(64);
  });
});

// A 2x2 truecolor TGA header (18 bytes) -- only the header is ever read.
function tgaHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(18);
  const v = new DataView(b.buffer);
  b[2] = 2;
  v.setUint16(12, width, true);
  v.setUint16(14, height, true);
  b[16] = 32;
  return b;
}

describe("GL_RecoverLogicalDimensions -- drop-ins over truecolor originals (rule 25)", () => {
  test("a same-format .png drop-in keeps the shipped .png's logical size", () => {
    // fonts/qconfont.png at 4x: every kfont atlas cell is addressed in the
    // shipped atlas's pixels, so the logical size must be the pak's.
    files.set("fonts/qconfont.png", buildPngRgba(8, 8)); // the homedir drop-in the walk resolves
    shipped.set("fonts/qconfont.png", buildPngRgba(2, 2)); // the pak's copy

    const image = GL_FindImage("fonts/qconfont.png", ImagetypeT.it_pic);

    expect(image?.name).toBe("fonts/qconfont.png");
    expect(image?.width).toBe(2);
    expect(image?.height).toBe(2);
    expect(image?.upload_width).toBe(8);
    expect(image?.upload_height).toBe(8);
  });

  test("a homedir-only .png over a shipped .tga takes the .tga's size, not its own", () => {
    // env/unit1_bk.png dropped in beside a pak that ships only the .tga: the
    // shipped-copy probe must pass over the .png (no shipped copy) and land
    // on the .tga.
    files.set("pics/sky.png", buildPngRgba(8, 8));
    shipped.set("pics/sky.tga", tgaHeader(2, 2));

    const image = GL_FindImage("pics/sky.pcx", ImagetypeT.it_pic);

    expect(image?.name).toBe("pics/sky.png");
    expect(image?.width).toBe(2);
    expect(image?.height).toBe(2);
    expect(image?.upload_width).toBe(8);
  });

  test("a file with no shipped copy anywhere keeps its own size", () => {
    files.set("pics/mine.png", buildPngRgba(8, 8));

    const image = GL_FindImage("pics/mine.png", ImagetypeT.it_pic);

    expect(image?.width).toBe(8);
    expect(image?.height).toBe(8);
  });
});
