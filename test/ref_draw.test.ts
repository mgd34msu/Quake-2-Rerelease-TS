/*
Self-sufficient suite for src/ref_soft/r_image.ts and r_draw.ts. Every test
sets up its own fake RefImports (SetRefImports) and its own vid.buffer
(SWimp_SetMode) in beforeEach -- nothing here depends on another test file
having run first, per .orch/preferences.md rule 13.

The fake RefImports.FS_LoadFile serves synthetic PCX/WAL byte buffers from
an in-memory filename -> Uint8Array map instead of touching the real
filesystem (r_image.ts's LoadPCX/R_LoadWal only ever call ri.FS_LoadFile,
never node:fs directly). SWimp_SetMode (src/platform/swimp.ts) is used
as-is to allocate vid.buffer/vid.rowbytes/vid.width/vid.height the way the
real engine does, via the same fake ri's Vid_GetModeInfo.

PCX bytes are built by hand the way test/cl_view.test.ts's SCR_LoadPCX
suite does (128-byte header + RLE-encoded pixel data + 768-byte trailing
palette): the LoadPCX suite below hand-builds a tiny 2x2 PCX exactly like
that one. The larger 128x128 conchars sheet and small Draw_Pic fixtures use
a generic per-row RLE encoder (rleEncodeRow) instead of literal bytes --
still the same PCX RLE format, just generated instead of transcribed byte
by byte, since a 128x128 image would be unreadable as a hand-typed byte
array.
*/

import { describe, test, expect, beforeEach } from "bun:test";

import { SetRefImports, r_notexture_mip, vid } from "../src/ref_soft/r_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { SWimp_SetMode } from "../src/platform/swimp";
import { LoadPCX, R_FindImage, R_InitImages } from "../src/ref_soft/r_image";
import { ImagetypeT } from "../src/ref_soft/r_model";
import { Draw_Char, Draw_Fill, Draw_InitLocal, Draw_Pic } from "../src/ref_soft/r_draw";

const VID_WIDTH = 64;
const VID_HEIGHT = 48;

let files: Map<string, Uint8Array>;

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
    Vid_GetModeInfo: () => ({ width: VID_WIDTH, height: VID_HEIGHT }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// Encodes one PCX scanline: runs of identical bytes use the 0xC0|count
// marker (max count 63, per the format's 6-bit run field); any byte whose
// top two bits are already set (0xC0-0xFF, which includes TRANSPARENT_COLOR
// 0xFF) must always use the marker, even for a run of one, since a raw
// literal byte in that range would be misread as a run marker on decode.
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

// miptex_t (qcommon/qfiles.h): name[32], width/height (u32 @32/@36),
// offsets[4] (u32 @40..@55), animname[32], flags/contents/value (i32).
// Only offsets[0] and width/height are read by R_LoadWal.
function buildWalBytes(width: number, height: number): Uint8Array {
  const mip0 = width * height;
  const mip1 = (mip0 / 4) | 0;
  const mip2 = (mip0 / 16) | 0;
  const mip3 = (mip0 / 64) | 0;
  const size = mip0 + mip1 + mip2 + mip3;
  const headerSize = 100;

  const buf = new Uint8Array(headerSize + size);
  const view = new DataView(buf.buffer);
  view.setUint32(32, width, true);
  view.setUint32(36, height, true);
  view.setUint32(40, headerSize, true); // offsets[0]
  for (let i = 0; i < size; i++) buf[headerSize + i] = i % 256;
  return buf;
}

beforeEach(() => {
  files = new Map();
  SetRefImports(makeFakeRi());
  R_InitImages();
  SWimp_SetMode(0, 0, 0, false);
});

describe("LoadPCX", () => {
  test("decodes a hand-built RLE PCX exactly", () => {
    const header = new Uint8Array(128);
    header[0] = 0x0a;
    header[1] = 5;
    header[2] = 1;
    header[3] = 8;
    const hv = new DataView(header.buffer);
    hv.setUint16(8, 1, true); // xmax = width-1 = 1
    hv.setUint16(10, 1, true); // ymax = height-1 = 1

    // row0: run of two pixels of color 10 (0xC2 = 0xC0 | runLength 2, then
    // the byte 10); row1: two literal pixels 20, 30 (neither has the top
    // two bits set, so no run marker is needed).
    const pixelData = new Uint8Array([0xc2, 10, 20, 30]);

    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = i % 256;

    const bytes = new Uint8Array(header.length + pixelData.length + palette.length);
    bytes.set(header, 0);
    bytes.set(pixelData, header.length);
    bytes.set(palette, header.length + pixelData.length);

    files.set("pics/test.pcx", bytes);

    const result = LoadPCX("pics/test.pcx");

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(Array.from(result.pic ?? [])).toEqual([10, 10, 20, 30]);
    expect(Array.from(result.palette ?? [])).toEqual(Array.from(palette));
  });

  test("returns a null pic for a missing file", () => {
    const result = LoadPCX("pics/does-not-exist.pcx");
    expect(result.pic).toBeNull();
    expect(result.palette).toBeNull();
  });
});

describe("R_FindImage", () => {
  test("caches by name: a second call for the same name returns the same object", () => {
    files.set("pics/cached.pcx", buildPcxBytes(2, 2, () => 5));

    const first = R_FindImage("pics/cached.pcx", ImagetypeT.it_pic);
    const second = R_FindImage("pics/cached.pcx", ImagetypeT.it_pic);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  test("a .pcx load gets the requested type; a .wal load always gets it_wall", () => {
    files.set("pics/apic.pcx", buildPcxBytes(2, 2, () => 7));
    const pic = R_FindImage("pics/apic.pcx", ImagetypeT.it_pic);
    expect(pic).not.toBeNull();
    expect(pic?.type).toBe(ImagetypeT.it_pic);

    files.set("textures/awall.wal", buildWalBytes(16, 16));
    // R_LoadWal hardcodes it_wall regardless of the requested type -- the
    // C function doesn't even take a type argument.
    const wall = R_FindImage("textures/awall.wal", ImagetypeT.it_skin);
    expect(wall).not.toBeNull();
    expect(wall?.type).toBe(ImagetypeT.it_wall);
    expect(wall?.width).toBe(16);
    expect(wall?.height).toBe(16);
  });

  test("R_LoadWal slices the combined mip buffer at the right offsets", () => {
    files.set("textures/mips.wal", buildWalBytes(16, 16));
    const image = R_FindImage("textures/mips.wal", ImagetypeT.it_wall);
    expect(image).not.toBeNull();

    const mip0 = image?.pixels[0];
    const mip1 = image?.pixels[1];
    const mip2 = image?.pixels[2];
    const mip3 = image?.pixels[3];
    expect(mip0?.length).toBe(256);
    expect(mip1?.length).toBe(64);
    expect(mip2?.length).toBe(16);
    expect(mip3?.length).toBe(4);
    expect(Array.from(mip0?.subarray(0, 4) ?? [])).toEqual([0, 1, 2, 3]);
    expect(Array.from(mip1?.subarray(0, 4) ?? [])).toEqual([0, 1, 2, 3].map((v) => (256 + v) % 256));
  });

  test("returns r_notexture_mip when a .wal file can't be loaded", () => {
    expect(R_FindImage("textures/missing.wal", ImagetypeT.it_wall)).toBe(r_notexture_mip);
  });

  test("returns null for a name shorter than 5 characters", () => {
    expect(R_FindImage("abcd", ImagetypeT.it_pic)).toBeNull();
  });

  // The software renderer's framebuffer is 8-bit palette indices -- it has
  // no truecolor decode path at all, matching r_image.c's own real
  // ".tga" branch (`return NULL; // "can't load %s in software renderer"`,
  // this file's own header comment on LoadTGA being "ref_soft's dead-code
  // path"). ".png" (added for the kfont FIDELITY RAZOR sweep,
  // .orch/preferences.md rule 17 -- q2repro's real fonts/qconfont.png
  // atlas texture) falls into that exact same "recognized-looking but
  // unsupported extension" bucket here, via R_FindImage's own generic
  // `else return null` branch -- no PNG decoder was added to this file,
  // deliberately: q2repro itself has no software renderer to match
  // against (see .orch/followups.md's own note on this), so there is no
  // real behavior to port for this case, only the original engine's own
  // "software renderer can't do truecolor" precedent to stay consistent
  // with. This is why host.ts's kfont path gracefully falls back to the
  // conchars-only draw under ref_soft even with the real rerelease KPF
  // mounted.
  test("returns null for a .png file (no truecolor decode path exists in the software renderer, matching the real .tga dead-code branch)", () => {
    expect(R_FindImage("fonts/qconfont.png", ImagetypeT.it_pic)).toBeNull();
  });
});

describe("Draw_Fill", () => {
  test("writes the color index into exactly the requested rect and leaves outside pixels untouched", () => {
    Draw_Fill(10, 5, 4, 3, 0x2a);

    for (let y = 5; y < 8; y++) {
      for (let x = 10; x < 14; x++) {
        expect(vid.buffer[y * vid.rowbytes + x]).toBe(0x2a);
      }
    }

    // just outside each edge of the rect
    expect(vid.buffer[5 * vid.rowbytes + 9]).toBe(0);
    expect(vid.buffer[5 * vid.rowbytes + 14]).toBe(0);
    expect(vid.buffer[4 * vid.rowbytes + 10]).toBe(0);
    expect(vid.buffer[8 * vid.rowbytes + 10]).toBe(0);
  });
});

describe("Draw_Char", () => {
  test("blits a synthetic conchars glyph cell to the right offset, skipping transparent pixels", () => {
    const num = 1; // row = num>>4 = 0, col = num&15 = 1
    const row = num >> 4;
    const col = num & 15;
    // 8 bytes for the glyph's first source scanline; indices 2 and 6 are
    // TRANSPARENT_COLOR (255) and must be skipped by the blit.
    const glyph = [10, 11, 255, 13, 14, 15, 255, 17];

    const bytes = buildPcxBytes(128, 128, (x, y) => {
      const gx = x - (col << 3);
      const gy = y - (row << 3);
      if (gy === 0 && gx >= 0 && gx < 8) return glyph[gx];
      return 255; // transparent filler everywhere else in the sheet
    });
    files.set("pics/conchars.pcx", bytes);

    Draw_InitLocal();
    Draw_Char(20, 6, num);

    for (let k = 0; k < 8; k++) {
      const destVal = vid.buffer[6 * vid.rowbytes + 20 + k];
      if (glyph[k] === 255) {
        expect(destVal).toBe(0); // untouched -- buffer starts zeroed
      } else {
        expect(destVal).toBe(glyph[k]);
      }
    }
  });
});

describe("Draw_Pic", () => {
  test("draws pixels at the given offset when fully on-screen", () => {
    files.set("pics/box.pcx", buildPcxBytes(4, 4, (x, y) => y * 4 + x + 1));

    Draw_Pic(2, 3, "box");

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(vid.buffer[(3 + y) * vid.rowbytes + (2 + x)]).toBe(y * 4 + x + 1);
      }
    }
  });

  test("truncates fractional coordinates like the C int parameters did", () => {
    // C declares Draw_Pic(int x, int y, ...): callers doing integer division
    // (e.g. M_Main_Draw's xoffset = (viddef.width - widest + 70) / 2) got
    // truncation from the parameter type. In JS a fractional x reaches the
    // typed-array blit and every write at a fractional index is silently
    // dropped, which made the whole main menu invisible. The boundary must
    // truncate.
    files.set("pics/frac.pcx", buildPcxBytes(4, 4, (x, y) => y * 4 + x + 1));

    Draw_Pic(2.5, 3.5, "frac");

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(vid.buffer[(3 + y) * vid.rowbytes + (2 + x)]).toBe(y * 4 + x + 1);
      }
    }
  });

  test("clips at the screen edge without writing out of bounds", () => {
    files.set("pics/edge.pcx", buildPcxBytes(8, 8, () => 77));

    // vid is 64x48 (rowbytes 64): x=60 + width=8 = 68 > 64, so the C
    // bounds check ("bad coordinates") aborts the whole draw rather than
    // partially clipping horizontally.
    const before = vid.buffer.slice();
    Draw_Pic(60, 0, "edge");

    expect(vid.buffer).toEqual(before);
    expect(vid.buffer.length).toBe(VID_WIDTH * VID_HEIGHT); // canary: never reallocated/overrun
  });
});
