/*
Tests for src/qcommon/bmp.ts's decodeBMP. Self-sufficient per rule 13:
pure function in, object out, no filesystem/renderer state to set up.

FIXTURES: hand-built with Python's struct module (no PIL -- exact
byte-level control over BITMAPFILEHEADER/BITMAPINFOHEADER fields, row
padding, and row direction), the same "construct the real bytes by hand"
precedent test/support/jpeg_builder.ts documents for JPEG. Generated with:

  python3 gen_bmp.py > bmp_fixtures.ts

using this exact script (kept in scratch, not checked into the repo):

  https://github.com -- not published; reproduced verbatim below for
  anyone re-deriving these bytes. Every fixture uses the same 2x2 (or 3x2
  for the padding case) source colors: top-left=(10,20,30),
  top-right=(40,50,60), bottom-left=(70,80,90), bottom-right=(100,110,120).

    import struct

    def bmp_header(width, height, bit_count, compression, data_size,
                    palette_size=0, clr_used=0):
        file_header_size = 14
        info_header_size = 40
        off_bits = file_header_size + info_header_size + palette_size
        file_size = off_bits + data_size
        file_header = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, off_bits)
        info_header = struct.pack(
            "<IiiHHIIiiII",
            info_header_size, width, height, 1, bit_count, compression,
            data_size, 0, 0, clr_used, 0,
        )
        return file_header + info_header

    def row_stride(width, bit_count):
        return ((width * bit_count + 31) // 32) * 4

    # 24-bit bottom-up 2x2: file row0 (bottom of image) then file row1 (top)
    def row_bgr(pixels):
        row = bytearray()
        for (r, g, b) in pixels:
            row += bytes([b, g, r])
        row += bytes(row_stride(2, 24) - len(row))
        return bytes(row)
    pixdata = row_bgr([(70,80,90),(100,110,120)]) + row_bgr([(10,20,30),(40,50,60)])
    header = bmp_header(2, 2, 24, 0, len(pixdata))
    # BOTTOM_UP_24BPP_BMP = header + pixdata

    # 24-bit top-down 2x2: negative height, file row0 = top already
    pixdata_td = row_bgr([(10,20,30),(40,50,60)]) + row_bgr([(70,80,90),(100,110,120)])
    header_td = bytearray(bmp_header(2, 2, 24, 0, len(pixdata_td)))
    struct.pack_into("<i", header_td, 14 + 8, -2)  # patch biHeight negative
    # TOP_DOWN_24BPP_BMP = bytes(header_td) + pixdata_td

    # 32-bit bottom-up 2x2, real per-pixel alpha bytes
    def row_bgra(pixels):
        row = bytearray()
        for (r, g, b, a) in pixels:
            row += bytes([b, g, r, a])
        return bytes(row)
    pixdata32 = row_bgra([(70,80,90,255),(100,110,120,128)]) + row_bgra([(10,20,30,64),(40,50,60,0)])
    header32 = bmp_header(2, 2, 32, 0, len(pixdata32))
    # BOTTOM_UP_32BPP_BMP = header32 + pixdata32

    # 8-bit paletted 3x2 (exercises row padding: stride=4, width=3)
    palette = bytes([0,0,0,0, 200,100,50,0, 0,255,0,0, 255,0,0,0])  # BGR0 x4
    def row_idx(indices):
        row = bytearray(indices)
        row += bytes(row_stride(3, 8) - len(row))
        return bytes(row)
    pixdata8 = row_idx([1,2,3]) + row_idx([0,1,2])  # bottom row, then top row
    header8 = bmp_header(3, 2, 8, 0, len(pixdata8), palette_size=len(palette), clr_used=4)
    # PALETTED_8BPP_BMP = header8 + palette + pixdata8

    # unsupported compression (BI_RLE8 = 1) -- decoder must fail cleanly
    # before ever reading pixel data
    header_bad = bmp_header(2, 2, 8, 1, 0, palette_size=4)
    # UNSUPPORTED_COMPRESSION_BMP = header_bad + bytes(4)

    # unsupported bit depth (4bpp) -- decoder must fail cleanly
    header_bad4 = bmp_header(2, 2, 4, 0, 4, palette_size=16)
    # UNSUPPORTED_BITDEPTH_BMP = header_bad4 + bytes(16) + bytes(4)
*/

import { describe, test, expect } from "bun:test";
import { decodeBMP } from "../src/qcommon/bmp";

const BOTTOM_UP_24BPP_BMP = new Uint8Array([66, 77, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90, 80, 70, 120, 110, 100, 0, 0, 30, 20, 10, 60, 50, 40, 0, 0]);
const TOP_DOWN_24BPP_BMP = new Uint8Array([66, 77, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 254, 255, 255, 255, 1, 0, 24, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 30, 20, 10, 60, 50, 40, 0, 0, 90, 80, 70, 120, 110, 100, 0, 0]);
const BOTTOM_UP_32BPP_BMP = new Uint8Array([66, 77, 70, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90, 80, 70, 255, 120, 110, 100, 128, 30, 20, 10, 64, 60, 50, 40, 0]);
const PALETTED_8BPP_BMP = new Uint8Array([66, 77, 78, 0, 0, 0, 0, 0, 0, 0, 70, 0, 0, 0, 40, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 200, 100, 50, 0, 0, 255, 0, 0, 255, 0, 0, 0, 1, 2, 3, 0, 0, 1, 2, 0]);
const UNSUPPORTED_COMPRESSION_BMP = new Uint8Array([66, 77, 58, 0, 0, 0, 0, 0, 0, 0, 58, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 8, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const UNSUPPORTED_BITDEPTH_BMP = new Uint8Array([66, 77, 74, 0, 0, 0, 0, 0, 0, 0, 70, 0, 0, 0, 40, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1, 0, 4, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("decodeBMP", () => {
  test("decodes a bottom-up 24bpp BMP, flipping rows to this decoder's top-down output convention", () => {
    const result = decodeBMP(BOTTOM_UP_24BPP_BMP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(2);
    expect(result.image.height).toBe(2);
    expect(Array.from(result.image.pixels)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, // output row 0 (top)
      70, 80, 90, 255, 100, 110, 120, 255, // output row 1 (bottom)
    ]);
  });

  test("decodes a top-down 24bpp BMP (negative biHeight) without flipping rows", () => {
    const result = decodeBMP(TOP_DOWN_24BPP_BMP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(2);
    expect(result.image.height).toBe(2);
    expect(Array.from(result.image.pixels)).toEqual([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
  });

  test("bottom-up and top-down fixtures of the same logical image decode identically", () => {
    const bottomUp = decodeBMP(BOTTOM_UP_24BPP_BMP);
    const topDown = decodeBMP(TOP_DOWN_24BPP_BMP);
    expect(bottomUp.ok && topDown.ok).toBe(true);
    if (!bottomUp.ok || !topDown.ok) return;
    expect(Array.from(bottomUp.image.pixels)).toEqual(Array.from(topDown.image.pixels));
  });

  test("decodes a 32bpp BMP, reading the 4th byte literally as alpha", () => {
    const result = decodeBMP(BOTTOM_UP_32BPP_BMP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([
      10, 20, 30, 64, 40, 50, 60, 0, // output row 0 (top)
      70, 80, 90, 255, 100, 110, 120, 128, // output row 1 (bottom)
    ]);
  });

  test("decodes an 8bpp paletted BMP, mapping indices through the BGR0 color table and handling row padding", () => {
    const result = decodeBMP(PALETTED_8BPP_BMP);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(3);
    expect(result.image.height).toBe(2);
    // palette: 0=(0,0,0) 1=(50,100,200) 2=(0,255,0) 3=(0,0,255) (BGR0 in file -> RGB out)
    // top row (file row1, indices [0,1,2]), bottom row (file row0, indices [1,2,3])
    expect(Array.from(result.image.pixels)).toEqual([
      0, 0, 0, 255, 50, 100, 200, 255, 0, 255, 0, 255, // row 0 (top): indices 0,1,2
      50, 100, 200, 255, 0, 255, 0, 255, 0, 0, 255, 255, // row 1 (bottom): indices 1,2,3
    ]);
  });

  test("cleanly reports an unsupported compression (BI_RLE8) instead of misdecoding", () => {
    const result = decodeBMP(UNSUPPORTED_COMPRESSION_BMP);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported BMP compression");
  });

  test("cleanly reports an unsupported bit depth (4bpp) instead of misdecoding", () => {
    const result = decodeBMP(UNSUPPORTED_BITDEPTH_BMP);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported BMP bit depth");
  });

  test("rejects a file that's too short to hold the headers", () => {
    const result = decodeBMP(new Uint8Array(10));
    expect(result.ok).toBe(false);
  });

  test("rejects a bad signature (not 'BM')", () => {
    const bad = new Uint8Array(BOTTOM_UP_24BPP_BMP);
    bad[0] = 0x00;
    const result = decodeBMP(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("signature");
  });

  test("rejects an unsupported header size (e.g. a BITMAPV4HEADER-style 108-byte header)", () => {
    const bad = new Uint8Array(BOTTOM_UP_24BPP_BMP);
    const view = new DataView(bad.buffer);
    view.setUint32(14, 108, true);
    const result = decodeBMP(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("unsupported BMP header size");
  });
});
