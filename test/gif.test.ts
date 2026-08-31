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

  test("a single-image file's frames array has exactly one entry, identical to .image", () => {
    // Every fixture above (SIMPLE/TRANSPARENT/INTERLACED/ANIMATED_GIF_FRAME0_ONLY)
    // has exactly one Image Descriptor -- gif.ts's header comment documents
    // this as the exact pre-animation behavior, byte-for-byte.
    for (const gif of [SIMPLE_GIF, TRANSPARENT_GIF, INTERLACED_GIF, ANIMATED_GIF_FRAME0_ONLY]) {
      const result = decodeGIF(gif);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.frames.length).toBe(1);
      expect(result.frames[0]).toBe(result.image);
    }
  });
});

/*
ANIMATED COMPOSITING FIXTURES -- 4x4-canvas, 2-3 frame GIFs exercising each
of the three disposal-method groups (none/keep, restore-to-background,
restore-to-previous) plus transparency inside a partial-rect frame. Built
the same way as the fixtures above (a real Pillow-driven LZW encoder, not a
hand-rolled one) but via Pillow's lower-level GifImagePlugin.getdata(im,
offset) so each frame's rectangle, position, and Graphic Control Extension
(disposal method, transparent index) are exactly controlled rather than
left to Pillow's own frame-diff optimizer. Generated with:

  python3 gen_anim_gif.py > gen_gif_js.txt

using this exact script (kept in scratch, not checked into the repo):

  import struct
  from PIL import Image, GifImagePlugin

  PALETTE = [
      0,0,0,      # 0 black (background index; see gif.ts's header comment
                  # on why disposal-to-background clears to TRANSPARENT
                  # instead, so this color is never actually painted)
      200,0,0,    # 1 red
      0,200,0,    # 2 green
      0,0,200,    # 3 blue
      123,123,123 # 4 transparent placeholder color (never actually shown)
  ] + [0,0,0] * (256-5)

  def mkimg(w, h, pixels):
      im = Image.new("P", (w, h))
      im.putpalette(PALETTE)
      for i, v in enumerate(pixels):
          im.putpixel((i % w, i // w), v)
      return im

  def gce(disposal, transparent_index):
      packed = (disposal << 2) | (1 if transparent_index is not None else 0)
      ti = transparent_index if transparent_index is not None else 0
      return bytes([0x21, 0xF9, 0x04, packed, 0, 0, ti, 0x00])

  def build_gif(logical_w, logical_h, frames):
      # frames: list of (image, (x,y), disposal, transparent_index)
      out = bytearray()
      out += b"GIF89a"
      packed = 0x80 | 0x70 | 0x02  # global color table, 8 entries
      out += struct.pack("<HHB", logical_w, logical_h, packed)
      out += bytes([0, 0])  # bg color index, pixel aspect ratio
      out += bytes(PALETTE[:8*3])
      for im, (x, y), disposal, ti in frames:
          out += gce(disposal, ti)
          for b in GifImagePlugin.getdata(im, offset=(x, y)):
              out += b
      out += bytes([0x3B])
      return bytes(out)

  # DISPOSAL_KEEP_GIF: frame0 = full 4x4 red, disposal=1 (do not dispose);
  # frame1 = 2x2 green at (1,1), disposal=1.
  f0 = mkimg(4, 4, [1]*16)
  f1 = mkimg(2, 2, [2]*4)
  DISPOSAL_KEEP_GIF = build_gif(4, 4, [(f0, (0,0), 1, None), (f1, (1,1), 1, None)])

  # DISPOSAL_BACKGROUND_GIF: frame0 = full 4x4 red, disposal=2 (restore to
  # background); frame1 = 2x2 green at (1,1), disposal=1.
  f0b = mkimg(4, 4, [1]*16)
  f1b = mkimg(2, 2, [2]*4)
  DISPOSAL_BACKGROUND_GIF = build_gif(4, 4, [(f0b, (0,0), 2, None), (f1b, (1,1), 1, None)])

  # DISPOSAL_PREVIOUS_GIF: frame0 = full 4x4 red, disposal=1; frame1 = 2x2
  # green at (1,1), disposal=3 (restore to previous); frame2 = 1x1 blue at
  # (0,0), disposal=1.
  f0c = mkimg(4, 4, [1]*16)
  f1c = mkimg(2, 2, [2]*4)
  f2c = mkimg(1, 1, [3])
  DISPOSAL_PREVIOUS_GIF = build_gif(4, 4, [(f0c, (0,0), 1, None), (f1c, (1,1), 3, None), (f2c, (0,0), 1, None)])

  # DISPOSAL_TRANSPARENT_PARTIAL_GIF: frame0 = full 4x4 red, disposal=1;
  # frame1 = 2x2 at (1,1) with local pixel (0,0) transparent (index 4) and
  # the other three local pixels green, disposal=1.
  f0d = mkimg(4, 4, [1]*16)
  f1d = mkimg(2, 2, [4,2,2,2])
  DISPOSAL_TRANSPARENT_PARTIAL_GIF = build_gif(4, 4, [(f0d, (0,0), 1, None), (f1d, (1,1), 1, 4)])

Every expected pixel grid below was independently cross-checked by opening
each fixture with Pillow's OWN reference GIF reader (Image.open(...).seek(i)
.convert("RGBA")) and printing every frame's pixel grid -- with one
DELIBERATE documented divergence: Pillow's reader paints disposal-to-
background as the literal declared background color (opaque black, from
this fixture's palette index 0), while this decoder treats it as fully
transparent (alpha 0) -- see gif.ts's own header comment for why. Every
other disposal/transparency case (keep, restore-to-previous, transparent
partial-rect) matched Pillow's reference decode exactly.
*/
const RED = [200, 0, 0, 255];
const GREEN = [0, 200, 0, 255];
const BLUE = [0, 0, 200, 255];
const CLEAR = [0, 0, 0, 0];

const DISPOSAL_KEEP_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 4, 0, 4, 0, 242, 0, 0, 0, 0, 0, 200, 0, 0, 0, 200, 0, 0, 0, 200, 123, 123, 123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 4, 0, 0, 8, 9, 0, 3,
  8, 28, 72, 176, 96, 128, 128, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 1, 0, 1, 0, 2, 0, 2, 0, 0, 8, 6, 0, 5, 8, 20, 16, 16, 0, 59,
]);
const DISPOSAL_BACKGROUND_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 4, 0, 4, 0, 242, 0, 0, 0, 0, 0, 200, 0, 0, 0, 200, 0, 0, 0, 200, 123, 123, 123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4, 8, 0, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 4, 0, 0, 8, 9, 0, 3,
  8, 28, 72, 176, 96, 128, 128, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 1, 0, 1, 0, 2, 0, 2, 0, 0, 8, 6, 0, 5, 8, 20, 16, 16, 0, 59,
]);
const DISPOSAL_PREVIOUS_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 4, 0, 4, 0, 242, 0, 0, 0, 0, 0, 200, 0, 0, 0, 200, 0, 0, 0, 200, 123, 123, 123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 4, 0, 0, 8, 9, 0, 3,
  8, 28, 72, 176, 96, 128, 128, 0, 33, 249, 4, 12, 0, 0, 0, 0, 44, 1, 0, 1, 0, 2, 0, 2, 0, 0, 8, 6, 0, 5, 8, 20, 16, 16, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 8, 4, 0, 7, 4, 4, 0,
  59,
]);
const DISPOSAL_TRANSPARENT_PARTIAL_GIF = new Uint8Array([
  71, 73, 70, 56, 57, 97, 4, 0, 4, 0, 242, 0, 0, 0, 0, 0, 200, 0, 0, 0, 200, 0, 0, 0, 200, 123, 123, 123, 0, 0, 0, 0, 0, 0, 0, 0, 0, 33, 249, 4, 4, 0, 0, 0, 0, 44, 0, 0, 0, 0, 4, 0, 4, 0, 0, 8, 9, 0, 3,
  8, 28, 72, 176, 96, 128, 128, 0, 33, 249, 4, 5, 0, 0, 4, 0, 44, 1, 0, 1, 0, 2, 0, 2, 0, 0, 8, 6, 0, 9, 8, 24, 24, 16, 0, 59,
]);

describe("decodeGIF -- animated frame compositing", () => {
  test("multi-frame files produce one composited frame per Image Descriptor, sized to the logical screen", () => {
    const result = decodeGIF(DISPOSAL_KEEP_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames.length).toBe(2);
    for (const f of result.frames) {
      expect(f.width).toBe(4);
      expect(f.height).toBe(4);
    }
    expect(result.image).toBe(result.frames[0]);
  });

  test("disposal 'none/keep' (0/1): a later partial-rect frame draws over the previous frame's result, which persists everywhere else", () => {
    const result = decodeGIF(DISPOSAL_KEEP_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.frames[0].pixels)).toEqual([...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED]);
    // frame1: red border, green 2x2 center at (1,1)-(2,2).
    expect(Array.from(result.frames[1].pixels)).toEqual([
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...GREEN,
      ...GREEN,
      ...RED,
      ...RED,
      ...GREEN,
      ...GREEN,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
    ]);
  });

  test("disposal 'restore to background' (2): the disposed frame's own rectangle clears to transparent before the next frame draws", () => {
    const result = decodeGIF(DISPOSAL_BACKGROUND_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.frames[0].pixels)).toEqual([...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED]);
    // frame0's disposal (2) fires before frame1 draws: the whole canvas
    // (frame0 covered all of it) clears to transparent, THEN frame1's 2x2
    // green draws on top of that blank canvas -- everywhere outside its
    // rect stays transparent, not frame0's red.
    expect(Array.from(result.frames[1].pixels)).toEqual([
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
      ...GREEN,
      ...GREEN,
      ...CLEAR,
      ...CLEAR,
      ...GREEN,
      ...GREEN,
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
      ...CLEAR,
    ]);
  });

  test("disposal 'restore to previous' (3): the canvas rolls back to its pre-frame state once that frame is superseded", () => {
    const result = decodeGIF(DISPOSAL_PREVIOUS_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.frames.length).toBe(3);
    // frame0: solid red.
    expect(Array.from(result.frames[0].pixels)).toEqual(new Array(16).fill(RED).flat());
    // frame1: red border, green 2x2 center (same shape as the keep case).
    expect(Array.from(result.frames[1].pixels)).toEqual([
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...GREEN,
      ...GREEN,
      ...RED,
      ...RED,
      ...GREEN,
      ...GREEN,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
    ]);
    // frame2: frame1's disposal (3) restores the canvas to frame0's own
    // pre-frame1 state (solid red) before frame2's 1x1 blue draws at (0,0)
    // -- the green square from frame1 must NOT still be visible here.
    expect(Array.from(result.frames[2].pixels)).toEqual([...BLUE, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED, ...RED]);
  });

  test("a transparent pixel inside a partial-rect frame reveals the canvas content beneath it instead of overwriting it", () => {
    const result = decodeGIF(DISPOSAL_TRANSPARENT_PARTIAL_GIF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // frame1's local (0,0) (canvas (1,1)) is the transparent index -- red
    // shows through from frame0; the other three local pixels are opaque
    // green.
    expect(Array.from(result.frames[1].pixels)).toEqual([
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...GREEN,
      ...RED,
      ...RED,
      ...GREEN,
      ...GREEN,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
      ...RED,
    ]);
  });
});
