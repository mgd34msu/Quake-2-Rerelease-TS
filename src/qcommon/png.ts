// PNG decoding -- NOT a port of any file in the original id Quake II source
// (vanilla ref_gl/ref_soft only ever load PCX/WAL/TGA; see gl_image.ts's own
// header comment). Added for the kfont FIDELITY RAZOR sweep
// (.orch/preferences.md rule 17): q2repro's own SCR_LoadKFont registers
// "fonts/qconfont.png" (src/refresh/draw.c), a truecolor PNG shipped inside
// the retail rerelease KPF (Q2Game.kpf, mounted via qcommon/zipfile.ts) --
// there is no .tga/.pcx sibling for that exact asset, so matching q2repro's
// observable behavior with that data requires decoding it for real.
//
// Scope is deliberately narrow, matching what the real asset actually is
// (verified against the extracted fonts/qconfont.kfont's texture line and
// the PNG bytes themselves: IHDR reports 195x252, 8-bit depth, colortype 6
// (truecolor+alpha), no interlacing, a single IDAT chunk) rather than a
// general-purpose PNG library:
//   - bit depth 8 only (no 1/2/4/16-bit support)
//   - colortype 0 (grayscale), 2 (RGB), 4 (grayscale+alpha), 6 (RGBA) only
//     -- NOT colortype 3 (palette + PLTE/tRNS), which the shipped asset
//     doesn't use
//   - no interlacing (Adam7) -- the shipped asset has interlace=0
// Anything outside that returns { ok: false }, the same "recognized but not
// handled, degrade gracefully" shape LoadPCX/LoadTGA already use for their
// own out-of-spec inputs (see gl_image.ts's LoadPCX bad-header branch) --
// callers decide whether that's a soft failure (missing-asset fallback) or
// a hard error (Sys_Error), matching each renderer's own existing
// convention for "recognized format, unsupported variant" (LoadTGA's own
// `Only type 2 and 10 targa RGB images supported`).
//
// DEFLATE decompression reuses node:zlib exactly like qcommon/zipfile.ts's
// own DEFLATE (method 8) support -- PNG's IDAT stream is zlib-wrapped
// (RFC 1950: 2-byte header + deflate stream + Adler-32), the plain
// `zlib.inflateSync` counterpart to zipfile.ts's raw-deflate
// `inflateRawSync` (ZIP entries have no zlib wrapper; PNG chunks do).

export interface DecodedPngT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- the same shape/orientation LoadTGA's own `targa_rgba`
  // output uses (see gl_image.ts), so callers can treat both the same way.
  pixels: Uint8Array;
}

export type DecodePngResultT = { ok: true; image: DecodedPngT } | { ok: false; reason: string };

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePNG(buffer: Uint8Array): DecodePngResultT {
  if (buffer.length < 8 + 25) return { ok: false, reason: "file too short" };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: "bad PNG signature" };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawIHDR = false;
  const idatParts: Uint8Array[] = [];
  let idatLength = 0;

  while (pos + 8 <= buffer.length) {
    const chunkLength = view.getUint32(pos, false);
    const chunkType = String.fromCharCode(buffer[pos + 4], buffer[pos + 5], buffer[pos + 6], buffer[pos + 7]);
    const dataStart = pos + 8;
    if (dataStart + chunkLength + 4 > buffer.length) return { ok: false, reason: "truncated chunk" };

    if (chunkType === "IHDR") {
      if (chunkLength !== 13) return { ok: false, reason: "malformed IHDR" };
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filterMethod = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (compression !== 0 || filterMethod !== 0) return { ok: false, reason: "unsupported PNG compression/filter method" };
      if (interlace !== 0) return { ok: false, reason: "interlaced PNG not supported" };
      if (bitDepth !== 8) return { ok: false, reason: `unsupported PNG bit depth ${bitDepth}` };
      if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) {
        return { ok: false, reason: `unsupported PNG color type ${colorType}` };
      }
      sawIHDR = true;
    } else if (chunkType === "IDAT") {
      idatParts.push(buffer.subarray(dataStart, dataStart + chunkLength));
      idatLength += chunkLength;
    } else if (chunkType === "IEND") {
      break;
    }

    pos = dataStart + chunkLength + 4; // skip CRC
  }

  if (!sawIHDR) return { ok: false, reason: "missing IHDR" };
  if (width <= 0 || height <= 0) return { ok: false, reason: "zero-size image" };
  if (idatParts.length === 0) return { ok: false, reason: "missing IDAT" };

  const compressed = new Uint8Array(idatLength);
  {
    let o = 0;
    for (const part of idatParts) {
      compressed.set(part, o);
      o += part.length;
    }
  }

  const zlib = require("node:zlib") as typeof import("node:zlib");
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(zlib.inflateSync(compressed));
  } catch (e) {
    return { ok: false, reason: `zlib inflate failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const bpp = channels; // bitDepth is always 8 here
  const rowBytes = width * bpp;
  const expected = (rowBytes + 1) * height;
  if (raw.length < expected) return { ok: false, reason: "decompressed data too short" };

  const recon = new Uint8Array(rowBytes * height);
  let prevRowOff = -1;
  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[srcOff++];
    const rowOff = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const rawByte = raw[srcOff++];
      const a = x >= bpp ? recon[rowOff + x - bpp] : 0;
      const b = prevRowOff >= 0 ? recon[prevRowOff + x] : 0;
      const c = prevRowOff >= 0 && x >= bpp ? recon[prevRowOff + x - bpp] : 0;
      let value: number;
      switch (filterType) {
        case 0: // None
          value = rawByte;
          break;
        case 1: // Sub
          value = rawByte + a;
          break;
        case 2: // Up
          value = rawByte + b;
          break;
        case 3: // Average
          value = rawByte + Math.floor((a + b) / 2);
          break;
        case 4: // Paeth
          value = rawByte + paethPredictor(a, b, c);
          break;
        default:
          return { ok: false, reason: `unknown scanline filter type ${filterType}` };
      }
      recon[rowOff + x] = value & 255;
    }
    prevRowOff = rowOff;
  }

  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes;
    const outRowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      const srcPix = rowOff + x * channels;
      const outPix = outRowOff + x * 4;
      if (colorType === 0) {
        const g = recon[srcPix];
        pixels[outPix] = g;
        pixels[outPix + 1] = g;
        pixels[outPix + 2] = g;
        pixels[outPix + 3] = 255;
      } else if (colorType === 2) {
        pixels[outPix] = recon[srcPix];
        pixels[outPix + 1] = recon[srcPix + 1];
        pixels[outPix + 2] = recon[srcPix + 2];
        pixels[outPix + 3] = 255;
      } else if (colorType === 4) {
        const g = recon[srcPix];
        pixels[outPix] = g;
        pixels[outPix + 1] = g;
        pixels[outPix + 2] = g;
        pixels[outPix + 3] = recon[srcPix + 1];
      } else {
        // colorType === 6
        pixels[outPix] = recon[srcPix];
        pixels[outPix + 1] = recon[srcPix + 1];
        pixels[outPix + 2] = recon[srcPix + 2];
        pixels[outPix + 3] = recon[srcPix + 3];
      }
    }
  }

  return { ok: true, image: { width, height, pixels } };
}
