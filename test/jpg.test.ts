/*
Tests for src/qcommon/jpg.ts's baseline JPEG decoder (decodeJPG) -- see
that file's own header comment for the full scope rationale (retail
baseq2/pak0.pak ships 198 .jpg files, all SOF0 baseline, all 8-bit, all
either 4:2:0 or 4:4:4 subsampled per this unit's own survey; 4:2:2 and
restart-marker support are implemented anyway as straightforward
generalizations of the same logic).

Every hand-built vector here is constructed byte-for-byte via
test/support/jpeg_builder.ts's from-scratch encoder -- see that file's own
header comment for why every test image is built from constant-valued 8x8
blocks (an "exact round-trip" trick that lets these tests assert precise
expected pixels instead of a lossy tolerance).
*/

import { describe, test, expect } from "bun:test";
import { decodeJPG } from "../src/qcommon/jpg";
import { buildBaselineJpeg, buildMinimalSof, ycbcrToRgb } from "./support/jpeg_builder";

describe("decodeJPG -- subsampling modes", () => {
  test("4:4:4 (no subsampling): two MCUs, each block a distinct constant YCbCr color, exact pixel match", () => {
    // 16x8 image, MCU = 8x8 (H=V=1 for every component), so 2 MCUs side by
    // side, one 8x8 Y/Cb/Cr block per component per MCU.
    const mcu0 = { y: 200, cb: 90, cr: 170 };
    const mcu1 = { y: 50, cb: 200, cr: 60 };
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [[mcu0.y - 128], [mcu0.cb - 128], [mcu0.cr - 128]],
        [[mcu1.y - 128], [mcu1.cb - 128], [mcu1.cr - 128]],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(8);

    const expected0 = ycbcrToRgb(mcu0.y, mcu0.cb, mcu0.cr);
    const expected1 = ycbcrToRgb(mcu1.y, mcu1.cb, mcu1.cr);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? expected0 : expected1;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2], result.image.pixels[o + 3]]).toEqual([
          expected[0],
          expected[1],
          expected[2],
          255,
        ]);
      }
    }
  });

  test("4:2:0 (H=2,V=2 luma): one MCU, four distinct Y quadrants sharing one Cb/Cr pair, exact pixel match", () => {
    // 16x16 image = exactly one MCU: 4 Y blocks (top-left, top-right,
    // bottom-left, bottom-right, in the by*h+bx order jpg.ts decodes), 1
    // Cb block, 1 Cr block covering the whole MCU.
    const yTL = 220,
      yTR = 180,
      yBL = 90,
      yBR = 40;
    const cb = 140,
      cr = 110;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 16,
      components: [
        { h: 2, v: 2 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [
          [yTL - 128, yTR - 128, yBL - 128, yBR - 128],
          [cb - 128],
          [cr - 128],
        ],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(16);

    const expTL = ycbcrToRgb(yTL, cb, cr);
    const expTR = ycbcrToRgb(yTR, cb, cr);
    const expBL = ycbcrToRgb(yBL, cb, cr);
    const expBR = ycbcrToRgb(yBR, cb, cr);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = y < 8 ? (x < 8 ? expTL : expTR) : x < 8 ? expBL : expBR;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(expected);
        expect(result.image.pixels[o + 3]).toBe(255);
      }
    }
  });

  test("4:2:2 (H=2,V=1 luma): one MCU, two distinct Y halves sharing one Cb/Cr pair, exact pixel match", () => {
    // 16x8 image = one MCU: 2 Y blocks (left, right), 1 Cb, 1 Cr covering
    // the whole 16x8 MCU (chroma subsampled horizontally only).
    const yL = 210,
      yR = 30;
    const cb = 160,
      cr = 100;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [
        { h: 2, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: [
        [
          [yL - 128, yR - 128],
          [cb - 128],
          [cr - 128],
        ],
      ],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(8);

    const expL = ycbcrToRgb(yL, cb, cr);
    const expR = ycbcrToRgb(yR, cb, cr);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? expL : expR;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(expected);
      }
    }
  });

  test("grayscale (1 component): R=G=B=Y, alpha 255", () => {
    const y0 = 33,
      y1 = 222;
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 8,
      components: [{ h: 1, v: 1 }],
      blocks: [[[y0 - 128]], [[y1 - 128]]],
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const expected = x < 8 ? y0 : y1;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2], result.image.pixels[o + 3]]).toEqual([
          expected,
          expected,
          expected,
          255,
        ]);
      }
    }
  });
});

describe("decodeJPG -- restart markers", () => {
  test("DRI=1 (restart after every MCU): four distinct MCUs decode correctly, proving DC predictors reset at each restart", () => {
    // If DC-predictor reset across a restart marker were broken, every MCU
    // after the first would accumulate the wrong absolute DC value (since
    // each MCU's block only encodes a DIFF from the previous predictor) --
    // this would show up as wrong colors on every MCU past the first.
    const colors = [
      { y: 240, cb: 128, cr: 128 },
      { y: 16, cb: 200, cr: 60 },
      { y: 128, cb: 60, cr: 200 },
      { y: 80, cb: 90, cr: 170 },
    ];
    const bytes = buildBaselineJpeg({
      width: 16,
      height: 16, // 2x2 grid of 8x8 MCUs (4:4:4)
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: colors.map((c) => [[c.y - 128], [c.cb - 128], [c.cr - 128]]),
      restartInterval: 1,
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.width).toBe(16);
    expect(result.image.height).toBe(16);

    const expected = colors.map((c) => ycbcrToRgb(c.y, c.cb, c.cr));
    const mcuAt = (x: number, y: number): number => (y < 8 ? 0 : 2) + (x < 8 ? 0 : 1);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const o = (y * 16 + x) * 4;
        const exp = expected[mcuAt(x, y)]!;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(exp);
      }
    }
  });

  test("DRI=2 (restart every other MCU): four MCUs still decode correctly", () => {
    const colors = [
      { y: 10, cb: 128, cr: 128 },
      { y: 250, cb: 128, cr: 128 },
      { y: 100, cb: 40, cr: 210 },
      { y: 190, cb: 210, cr: 40 },
    ];
    const bytes = buildBaselineJpeg({
      width: 32,
      height: 8, // 4 MCUs in a row (4:4:4)
      components: [
        { h: 1, v: 1 },
        { h: 1, v: 1 },
        { h: 1, v: 1 },
      ],
      blocks: colors.map((c) => [[c.y - 128], [c.cb - 128], [c.cr - 128]]),
      restartInterval: 2,
    });

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expected = colors.map((c) => ycbcrToRgb(c.y, c.cb, c.cr));
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 32; x++) {
        const mcuIndex = Math.floor(x / 8);
        const o = (y * 32 + x) * 4;
        const exp = expected[mcuIndex]!;
        expect([result.image.pixels[o], result.image.pixels[o + 1], result.image.pixels[o + 2]]).toEqual(exp);
      }
    }
  });
});

describe("decodeJPG -- progressive DCT (SOF2) is now a supported variant, not a bare marker probe", () => {
  // Progressive (SOF2) decoding was added (see jpg.ts's own header comment
  // and test/jpg_progressive.test.ts for the real per-scan coverage) --
  // SOF2 is no longer in the "recognized but not decoded" bucket below, so
  // a bare SOF2-then-EOI probe (no SOS at all) now fails the same way a
  // bare SOF0-then-EOI probe already does ("missing SOS marker" -- see the
  // "missing SOS marker" test further down), not "unsupported".
  test("SOF2 with no SOS reports missing SOS marker, not unsupported", () => {
    const bytes = buildMinimalSof(0xc2, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOS marker");
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });
});

describe("decodeJPG -- unsupported variants (recognized but not decoded, never misdecoded)", () => {
  test("extended sequential DCT (SOF1) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc1, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("arithmetic-coded extended sequential DCT (SOF9) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc9, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("arithmetic");
  });

  test("arithmetic-coded progressive DCT (SOF10) reports unsupported", () => {
    const bytes = buildMinimalSof(0xca, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("lossless (SOF3) reports unsupported", () => {
    const bytes = buildMinimalSof(0xc3, 8, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("12-bit precision (SOF0) reports unsupported bit depth, never misdecoded as 8-bit", () => {
    const bytes = buildMinimalSof(0xc0, 12, 8, 8, 3);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("12");
  });

  test("2-component SOF0 reports unsupported component count", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 2);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("4-component SOF0 (e.g. CMYK) reports unsupported component count", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 4);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
  });

  test("a second SOS (non-interleaved multi-scan) reports unsupported, not silently dropped", () => {
    const valid = buildBaselineJpeg({
      width: 8,
      height: 8,
      components: [{ h: 1, v: 1 }],
      blocks: [[[0]]],
    });
    // Drop the trailing EOI (last 2 bytes) and splice in a second, minimal
    // SOS header before re-appending EOI.
    const withoutEoi = valid.slice(0, valid.length - 2);
    const secondSos = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    const bytes = new Uint8Array(withoutEoi.length + secondSos.length + 2);
    bytes.set(withoutEoi, 0);
    bytes.set(secondSos, withoutEoi.length);
    bytes.set([0xff, 0xd9], withoutEoi.length + secondSos.length);

    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(true);
    expect(result.reason).toContain("multiple scans");
  });
});

describe("decodeJPG -- corrupt/malformed data (soft failure, matching LoadPCX/LoadTGA/decodePNG's Con_Printf+null convention)", () => {
  test("file too short", () => {
    const result = decodeJPG(new Uint8Array([0xff, 0xd8]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });

  test("bad JPEG signature (not FFD8)", () => {
    const result = decodeJPG(new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad JPEG signature");
  });

  test("missing SOF marker (SOI then straight to EOI)", () => {
    const result = decodeJPG(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOF marker");
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });

  test("missing SOS marker (SOF0 present, no SOS)", () => {
    const bytes = buildMinimalSof(0xc0, 8, 8, 8, 1);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing SOS marker");
  });

  test("SOS referencing a Huffman table that was never defined via DHT", () => {
    // SOI + DQT(id0) + SOF0(1 component, quant id0) + SOS(component1,
    // dc/ac table id0) with NO DHT segment anywhere -- the decoder must
    // fail once it tries to actually decode entropy data, not silently
    // produce garbage.
    const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(8)];
    const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00];
    const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
    const bytes = new Uint8Array([0xff, 0xd8, ...dqt, ...sof, ...sos, 0xff, 0xd9]);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
    expect(result.reason).toContain("DHT");
  });

  test("truncated marker segment (length field claims more bytes than exist)", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x50, 0x00, 0x08, 0x08]);
    const result = decodeJPG(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith("unsupported")).toBe(false);
  });
});
