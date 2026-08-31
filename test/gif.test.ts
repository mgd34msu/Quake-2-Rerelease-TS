/*
Tests for src/qcommon/gif.ts's decodeGIF. Self-sufficient per rule 13:
pure function in, object out, no filesystem/renderer state to set up.

FIXTURES: generated with Python's Pillow (a real GIF encoder -- gives an
authoritative LZW bitstream, avoiding "this test only exercises my own
encoder's assumptions" the way a hand-rolled LZW builder would). Generated
with:

  python3 gen_gif.py > gif_fixtures.ts

using this exact script (kept in scratch, not checked into the repo):

  from PIL import Image

  palette = [0,0,0, 10,20,30, 40,50,60, 70,80,90] + [0,0,0] * 252

  # SIMPLE_GIF -- 2x2, no transparency
  img = Image.new("P", (2, 2))
  img.putpalette(palette)
  img.putpixel((0, 0), 1)  # -> (10,20,30)
  img.putpixel((1, 0), 2)  # -> (40,50,60)
  img.putpixel((0, 1), 3)  # -> (70,80,90)
  img.putpixel((1, 1), 1)  # -> (10,20,30)
  img.save("simple.gif")

  # TRANSPARENT_GIF -- same layout, index 3 marked transparent
  img2 = Image.new("P", (2, 2))
  img2.putpalette(palette)
  img2.putpixel((0, 0), 1)
  img2.putpixel((1, 0), 2)
  img2.putpixel((0, 1), 3)  # transparent
  img2.putpixel((1, 1), 2)
  img2.save("trans.gif", transparency=3)

  # INTERLACED_GIF -- build a 4x4 image whose rows are pre-shuffled into
  # Adam7-for-GIF pass order [0,2,1,3] (GIF89a Appendix E, height 4: pass1
  # row0, pass2 none, pass3 row2, pass4 rows1+3), let Pillow LZW-encode
  # that reordered pixel stream as an ordinary top-to-bottom image, then
  # flip bit6 of the Image Descriptor's packed byte (byte offset
  # index_of(0x2C) + 9) to mark it interlaced. Real REAL_ROWS content:
  #   [[1,1,1,1],[2,2,2,2],[3,3,3,3],[1,2,3,1]]
  # A correct de-interlacer decodes this exactly back to REAL_ROWS.
  def interlaced_row_order(height):
      rows = []
      for start, step in [(0, 8), (4, 8), (2, 4), (1, 2)]:
          rows.extend(range(start, height, step))
      return rows
  real_rows = [[1,1,1,1],[2,2,2,2],[3,3,3,3],[1,2,3,1]]
  order = interlaced_row_order(4)  # [0, 2, 1, 3]
  reordered = [v for r in order for v in real_rows[r]]
  img3 = Image.new("P", (4, 4))
  img3.putpalette(palette)
  for i, v in enumerate(reordered):
      img3.putpixel((i % 4, i // 4), v)
  img3.save("interlace_src.gif")
  data = bytearray(open("interlace_src.gif", "rb").read())
  idx = data.index(0x2C)
  data[idx + 9] |= 0x40  # left,top,w,h (4x u16) then packed byte
  # INTERLACED_GIF = bytes(data)

  # ANIMATED_GIF -- 3 frames, solid colors 1/2/3; decoder must stop at
  # frame 1 and produce the SAME result as a lone single-frame save of
  # frame 0 (ANIMATED_GIF_FRAME0_ONLY).
  frames = []
  for val in (1, 2, 3):
      f = Image.new("P", (2, 2))
      f.putpalette(palette)
      for p in range(4):
          f.putpixel((p % 2, p // 2), val)
      frames.append(f)
  frames[0].save("anim.gif", save_all=True, append_images=frames[1:], loop=0, duration=100)
  frames[0].save("anim_frame0.gif")

  # TRUNCATED_GIF / BAD_SIGNATURE_GIF -- hand-built corrupt inputs.

Pillow's own GIF encoder re-indexes/compacts the palette to only the
colors actually used by each source image (verified by inspecting the
emitted bytes) -- the exact index values below are Pillow's, not the
values passed to putpixel above; what's invariant (and what these tests
assert) is the DECODED COLOR at each position, cross-checked once by hand
against the raw bytes before being hardcoded here.
*/

import { describe, test, expect } from "bun:test";
import { decodeGIF } from "../src/qcommon/gif";

const SIMPLE_GIF = new Uint8Array([71, 73, 70, 56, 55, 97, 2, 0, 2, 0, 129, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 0, 0, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 0, 8, 7, 0, 1, 4, 16, 0, 32, 32, 0, 59]);
const TRANSPARENT_GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 2, 0, 2, 0, 129, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 0, 0, 0, 33, 249, 4, 1, 0, 0, 2, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 0, 8, 7, 0, 1, 4, 16, 16, 32, 32, 0, 59]);
const INTERLACED_GIF = new Uint8Array([71, 73, 70, 56, 55, 97, 4, 0, 4, 0, 129, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 4, 0, 64, 8, 17, 0, 1, 8, 4, 32, 160, 160, 128, 0, 8, 3, 0, 8, 32, 0, 64, 64, 0, 59]);
const ANIMATED_GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 2, 0, 2, 0, 129, 0, 0, 10, 20, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 255, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, 0, 0, 0, 33, 249, 4, 0, 10, 0, 0, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 0, 8, 6, 0, 1, 8, 4, 16, 16, 0, 33, 249, 4, 1, 10, 0, 1, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 129, 40, 50, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 1, 8, 4, 16, 16, 0, 33, 249, 4, 1, 10, 0, 1, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 129, 70, 80, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 1, 8, 4, 16, 16, 0, 59]);
const ANIMATED_GIF_FRAME0_ONLY = new Uint8Array([71, 73, 70, 56, 55, 97, 2, 0, 2, 0, 129, 0, 0, 10, 20, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0, 0, 8, 6, 0, 1, 8, 4, 16, 16, 0, 59]);
const TRUNCATED_GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 0, 0, 0]);
const BAD_SIGNATURE_GIF = new Uint8Array([78, 79, 84, 65, 71, 73, 70, 0, 0, 0, 0, 0, 0]);

describe("decodeGIF", () => {
  test("decodes a simple 4-color static GIF", () => {
    const result = decodeGIF(SIMPLE_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(2);
    expect(result.image.height).toBe(2);
    expect(Array.from(result.image.pixels)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, // row 0
      70, 80, 90, 255, 10, 20, 30, 255, // row 1
    ]);
  });

  test("applies the Graphic Control Extension's transparent color index (alpha 0)", () => {
    const result = decodeGIF(TRANSPARENT_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.image.pixels)).toEqual([
      10, 20, 30, 255, 40, 50, 60, 255, // row 0, both opaque
      70, 80, 90, 0, 40, 50, 60, 255, // row 1: bottom-left is the transparent index -- alpha 0
    ]);
  });

  test("de-interlaces a 4-pass Adam7-for-GIF image back to the correct row order", () => {
    // Source pixel stream was pre-shuffled into pass order [0,2,1,3] for a
    // real REAL_ROWS = [[1,1,1,1],[2,2,2,2],[3,3,3,3],[1,2,3,1]] (values
    // 1/2/3 -> colors (10,20,30)/(40,50,60)/(70,80,90)) -- see this file's
    // header comment for the exact generation steps. A correct decoder
    // reconstructs REAL_ROWS exactly; a decoder that ignored the interlace
    // flag would instead produce the pass-order-shuffled rows.
    const result = decodeGIF(INTERLACED_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(4);
    expect(result.image.height).toBe(4);
    const c1 = [10, 20, 30, 255];
    const c2 = [40, 50, 60, 255];
    const c3 = [70, 80, 90, 255];
    expect(Array.from(result.image.pixels)).toEqual([
      ...c1, ...c1, ...c1, ...c1, // row 0: [1,1,1,1]
      ...c2, ...c2, ...c2, ...c2, // row 1: [2,2,2,2]
      ...c3, ...c3, ...c3, ...c3, // row 2: [3,3,3,3]
      ...c1, ...c2, ...c3, ...c1, // row 3: [1,2,3,1]
    ]);
  });

  test("decodes only the first frame of an animated GIF, matching a lone single-frame save of that same frame", () => {
    const animated = decodeGIF(ANIMATED_GIF);
    const frame0Only = decodeGIF(ANIMATED_GIF_FRAME0_ONLY);
    expect(animated.ok && frame0Only.ok).toBe(true);
    if (!animated.ok || !frame0Only.ok) return;
    expect(animated.image.width).toBe(frame0Only.image.width);
    expect(animated.image.height).toBe(frame0Only.image.height);
    expect(Array.from(animated.image.pixels)).toEqual(Array.from(frame0Only.image.pixels));
    // sanity: frame 0 is solid color index 1 -> (10,20,30) everywhere,
    // definitely not frame 2's (40,50,60) or frame 3's (70,80,90).
    expect(Array.from(animated.image.pixels)).toEqual([10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]);
  });

  test("rejects a truncated file", () => {
    const result = decodeGIF(TRUNCATED_GIF);
    expect(result.ok).toBe(false);
  });

  test("rejects a bad signature (not GIF87a/GIF89a)", () => {
    const result = decodeGIF(BAD_SIGNATURE_GIF);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("signature");
  });

  test("rejects a file with no image data before the trailer", () => {
    // Logical screen descriptor + global color table (4 entries) +
    // trailer, no Image Descriptor at all.
    const bytes = new Uint8Array([...SIMPLE_GIF.slice(0, 25), 0x3b]);
    const result = decodeGIF(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no image data");
  });
});
