/*
imageHeaderDims (src/qcommon/img_resolve.ts): the header-only size read both
renderers use to recover an image's logical size from the shipped asset a
drop-in replacement stands in for. One hand-built header per format, plus the
truncation and no-SOF cases that must come back null rather than a guess.
*/

import { describe, test, expect } from "bun:test";
import { imageHeaderDims } from "../src/qcommon/img_resolve";

function pcx(w: number, h: number): Uint8Array {
  const b = new Uint8Array(128);
  const v = new DataView(b.buffer);
  b[0] = 0x0a;
  v.setUint16(4, 3, true); // xmin
  v.setUint16(6, 5, true); // ymin
  v.setUint16(8, 3 + w - 1, true);
  v.setUint16(10, 5 + h - 1, true);
  return b;
}

function wal(w: number, h: number): Uint8Array {
  const b = new Uint8Array(100);
  const v = new DataView(b.buffer);
  v.setUint32(32, w, true);
  v.setUint32(36, h, true);
  return b;
}

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w, false);
  v.setUint32(20, h, false);
  return b;
}

function tga(w: number, h: number): Uint8Array {
  const b = new Uint8Array(18);
  const v = new DataView(b.buffer);
  b[2] = 2;
  v.setUint16(12, w, true);
  v.setUint16(14, h, true);
  b[16] = 32;
  return b;
}

function jpg(w: number, h: number, sosFirst = false): Uint8Array {
  // SOI, APP0 (16 bytes payload), then SOF0 -- or SOS in its place.
  const b = new Uint8Array(2 + 18 + 19);
  const v = new DataView(b.buffer);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xe0;
  v.setUint16(4, 16, false);
  b[20] = 0xff;
  b[21] = sosFirst ? 0xda : 0xc0;
  v.setUint16(22, 17, false);
  b[24] = 8; // precision
  v.setUint16(25, h, false);
  v.setUint16(27, w, false);
  return b;
}

function bmp(w: number, h: number): Uint8Array {
  const b = new Uint8Array(54);
  const v = new DataView(b.buffer);
  b[0] = 0x42;
  b[1] = 0x4d;
  v.setInt32(18, w, true);
  v.setInt32(22, -h, true); // top-down rows: negative height
  return b;
}

function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const v = new DataView(b.buffer);
  v.setUint16(6, w, true);
  v.setUint16(8, h, true);
  return b;
}

describe("imageHeaderDims", () => {
  test("reads every supported format's header", () => {
    expect(imageHeaderDims("pcx", pcx(64, 48))).toEqual({ width: 64, height: 48 });
    expect(imageHeaderDims("wal", wal(128, 32))).toEqual({ width: 128, height: 32 });
    expect(imageHeaderDims("png", png(195, 252))).toEqual({ width: 195, height: 252 });
    expect(imageHeaderDims("tga", tga(256, 256))).toEqual({ width: 256, height: 256 });
    expect(imageHeaderDims("jpg", jpg(512, 384))).toEqual({ width: 512, height: 384 });
    expect(imageHeaderDims("jpeg", jpg(512, 384))).toEqual({ width: 512, height: 384 });
    expect(imageHeaderDims("bmp", bmp(24, 24))).toEqual({ width: 24, height: 24 });
    expect(imageHeaderDims("gif", gif(16, 8))).toEqual({ width: 16, height: 8 });
  });

  test("a truncated header, a wrong signature or a JPEG with no frame header yields null", () => {
    expect(imageHeaderDims("png", png(4, 4).subarray(0, 20))).toBeNull();
    expect(imageHeaderDims("png", tga(4, 4))).toBeNull();
    expect(imageHeaderDims("gif", png(4, 4))).toBeNull();
    expect(imageHeaderDims("jpg", jpg(4, 4, true))).toBeNull();
    expect(imageHeaderDims("wal", wal(4, 4).subarray(0, 36))).toBeNull();
    expect(imageHeaderDims("pcx", pcx(0, 0))).toBeNull();
    expect(imageHeaderDims("wal", wal(70000, 4))).toBeNull();
  });
});
