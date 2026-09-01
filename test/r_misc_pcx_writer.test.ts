// WritePCX header-shape regression test. The regate screenshot oracle
// caught the soft renderer's own screenshots being rejected by standard
// decoders: color_planes was written at offset 64 (pcx_t's `reserved`
// byte) instead of 65, yielding planes=0 headers. Pins the full header
// layout against the PCX spec / vanilla r_misc.c's WritePCXfile struct,
// and round-trips the output through this port's own LoadPCX-compatible
// expectations (offset table, RLE, trailing palette marker).
import { describe, test, expect } from "bun:test";
import { WritePCX } from "../src/ref_soft/r_misc";

describe("WritePCX -- header shape and round-trip", () => {
  const w = 8, h = 4;
  const data = new Uint8Array(w * h).map((_, i) => i % 3 === 0 ? 0xc5 : (i & 0xff));
  const palette = new Uint8Array(768).map((_, i) => i & 0xff);
  const pcx = WritePCX(data, w, h, w, palette);

  test("header fields sit at their spec offsets", () => {
    expect(pcx[0]).toBe(0x0a); // manufacturer
    expect(pcx[1]).toBe(5); // version
    expect(pcx[2]).toBe(1); // RLE
    expect(pcx[3]).toBe(8); // bpp
    expect(pcx[8] | (pcx[9] << 8)).toBe(w - 1); // xmax
    expect(pcx[10] | (pcx[11] << 8)).toBe(h - 1); // ymax
    expect(pcx[64]).toBe(0); // reserved
    expect(pcx[65]).toBe(1); // color_planes -- THE regression
    expect(pcx[66] | (pcx[67] << 8)).toBe(w); // bytes_per_line
    expect(pcx[68]).toBe(2); // palette_type
  });

  test("trailing 768-byte palette with 0x0c marker", () => {
    expect(pcx[pcx.length - 769]).toBe(0x0c);
    expect(pcx.length).toBeGreaterThan(128 + 769);
  });

  test("RLE round-trips to the source pixels", () => {
    let pos = 128;
    const outPix: number[] = [];
    while (outPix.length < w * h) {
      const b = pcx[pos++];
      if ((b & 0xc0) === 0xc0) {
        const run = b & 0x3f;
        const v = pcx[pos++];
        for (let i = 0; i < run; i++) outPix.push(v);
      } else outPix.push(b);
    }
    expect(Uint8Array.from(outPix)).toEqual(data);
  });
});
