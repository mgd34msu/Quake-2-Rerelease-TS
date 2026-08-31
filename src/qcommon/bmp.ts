// Windows BMP decoding -- NOT a port of any file in the original id Quake II
// source (vanilla ref_gl/ref_soft only ever load PCX/WAL/TGA; see
// gl_image.ts's own header comment). Added per Mike's ruling 2026-08-31
// (.orch/followups.md, "support as many image formats for as many things
// as possible"), same spirit as png.ts/jpg.ts.
//
// Unlike PNG/JPG, BMP was not found anywhere in the real retail data (own
// census of baseq2/pak0.pak and Q2Game.kpf, both scanned for ".bmp": zero
// hits) -- this is forward-looking format support, not filling an observed
// content gap. Test fixtures are therefore entirely synthetic (Python
// `struct`-built, documented in test/bmp.test.ts's own header) rather than
// retail-gated.
//
// Scope, matching png.ts's "narrow deliberately" precedent:
//   - BITMAPFILEHEADER (14 bytes) + BITMAPINFOHEADER (40 bytes) only. The
//     older 12-byte OS/2 BITMAPCOREHEADER and the newer 108/124-byte V4/V5
//     headers (gamma/colorspace/ICC profile fields) are recognized by their
//     biSize field and reported `{ ok: false, reason: "unsupported BMP
//     header size: ..." }` -- never misdecoded as BITMAPINFOHEADER.
//   - biCompression == BI_RGB (0) only. RLE4/RLE8/BITFIELDS/JPEG/PNG
//     (compression codes 1-5) are recognized and reported unsupported.
//   - biBitCount 8 (paletted), 24 (BGR), and 32 (BGRA) only. 1/4/16-bit are
//     recognized and reported unsupported.
//   - Both row directions: biHeight > 0 (bottom-up, the overwhelmingly
//     common case) and biHeight < 0 (top-down, valid since BITMAPINFOHEADER
//     and used by some screen-capture tools) both convert to this module's
//     top-down output convention.
//   - 32bpp BI_RGB has no universally-agreed alpha convention (some writers
//     leave the 4th byte 0 meaning "no alpha data present", others use it
//     as real alpha) -- this decoder takes the RFC-free pragmatic choice of
//     reading it literally as alpha, same as every other byte in this
//     format: no guessing heuristic, no second pass over the pixels.

export interface DecodedBmpT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- matches png.ts's DecodedPngT/gif.ts's DecodedGifT
  // convention, so callers can treat every truecolor decoder the same way.
  pixels: Uint8Array;
}

export type DecodeBmpResultT = { ok: true; image: DecodedBmpT } | { ok: false; reason: string };

const BI_RGB = 0;

const BMP_COMPRESSION_NAMES: Readonly<Record<number, string>> = {
  1: "BI_RLE8",
  2: "BI_RLE4",
  3: "BI_BITFIELDS",
  4: "BI_JPEG",
  5: "BI_PNG",
};

export function decodeBMP(buffer: Uint8Array): DecodeBmpResultT {
  if (buffer.length < 14 + 40) return { ok: false, reason: "file too short" };
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) return { ok: false, reason: "bad BMP signature" }; // "BM"

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const bfOffBits = view.getUint32(10, true);

  const biSize = view.getUint32(14, true);
  if (biSize !== 40) return { ok: false, reason: `unsupported BMP header size: ${biSize}` };

  const biWidthRaw = view.getInt32(18, true);
  const biHeightRaw = view.getInt32(22, true);
  const biPlanes = view.getUint16(26, true);
  const biBitCount = view.getUint16(28, true);
  const biCompression = view.getUint32(30, true);
  let biClrUsed = view.getUint32(46, true);

  if (biPlanes !== 1) return { ok: false, reason: `unsupported BMP planes: ${biPlanes}` };
  if (biCompression !== BI_RGB) {
    const name = BMP_COMPRESSION_NAMES[biCompression] ?? `code ${biCompression}`;
    return { ok: false, reason: `unsupported BMP compression: ${name}` };
  }
  if (biBitCount !== 8 && biBitCount !== 24 && biBitCount !== 32) {
    return { ok: false, reason: `unsupported BMP bit depth: ${biBitCount}` };
  }
  if (biWidthRaw <= 0) return { ok: false, reason: `bad BMP width: ${biWidthRaw}` };
  if (biHeightRaw === 0) return { ok: false, reason: "bad BMP height: 0" };

  const width = biWidthRaw;
  const topDown = biHeightRaw < 0;
  const height = topDown ? -biHeightRaw : biHeightRaw;

  // Color table (BITMAPINFOHEADER: 4 bytes per entry, B/G/R/reserved),
  // immediately following the 40-byte info header, only present for
  // paletted (<=8bpp) images.
  let palette: Uint8Array | null = null;
  if (biBitCount === 8) {
    if (biClrUsed === 0) biClrUsed = 256;
    const paletteOffset = 14 + biSize;
    const paletteBytes = biClrUsed * 4;
    if (buffer.length < paletteOffset + paletteBytes) return { ok: false, reason: "truncated BMP color table" };
    palette = buffer.subarray(paletteOffset, paletteOffset + paletteBytes);
  }

  const bytesPerPixel = biBitCount / 8;
  const rowStride = Math.floor((width * biBitCount + 31) / 32) * 4;
  const pixelDataSize = rowStride * height;
  if (buffer.length < bfOffBits + pixelDataSize) return { ok: false, reason: "truncated BMP pixel data" };

  const pixels = new Uint8Array(width * height * 4);

  for (let fileRow = 0; fileRow < height; fileRow++) {
    // biHeight > 0: row 0 in the file is the BOTTOM of the image (bottom-up
    // storage) -- this decoder's output convention is top-down, so file row
    // 0 lands at output row (height-1). biHeight < 0: file row 0 is already
    // the top (top-down storage), no flip.
    const outRow = topDown ? fileRow : height - 1 - fileRow;
    const rowStart = bfOffBits + fileRow * rowStride;
    let srcOfs = rowStart;
    let dstOfs = outRow * width * 4;

    for (let x = 0; x < width; x++) {
      if (biBitCount === 8) {
        const index = buffer[srcOfs];
        // palette entries are B,G,R,reserved (4 bytes each)
        const p = (palette as Uint8Array).subarray(index * 4, index * 4 + 4);
        pixels[dstOfs + 0] = p[2] ?? 0; // R
        pixels[dstOfs + 1] = p[1] ?? 0; // G
        pixels[dstOfs + 2] = p[0] ?? 0; // B
        pixels[dstOfs + 3] = 255;
      } else if (biBitCount === 24) {
        pixels[dstOfs + 0] = buffer[srcOfs + 2]; // R
        pixels[dstOfs + 1] = buffer[srcOfs + 1]; // G
        pixels[dstOfs + 2] = buffer[srcOfs + 0]; // B
        pixels[dstOfs + 3] = 255;
      } else {
        // 32bpp: B,G,R,A in file order -- see header comment on the alpha
        // convention this decoder takes.
        pixels[dstOfs + 0] = buffer[srcOfs + 2]; // R
        pixels[dstOfs + 1] = buffer[srcOfs + 1]; // G
        pixels[dstOfs + 2] = buffer[srcOfs + 0]; // B
        pixels[dstOfs + 3] = buffer[srcOfs + 3]; // A
      }
      srcOfs += bytesPerPixel;
      dstOfs += 4;
    }
  }

  return { ok: true, image: { width, height, pixels } };
}
