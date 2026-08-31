// GIF (87a/89a) decoding -- NOT a port of any file in the original id
// Quake II source (vanilla ref_gl/ref_soft only ever load PCX/WAL/TGA; see
// gl_image.ts's own header comment). Added per Mike's ruling 2026-08-31
// (.orch/followups.md, "support as many image formats for as many things
// as possible"), same spirit as png.ts/jpg.ts/bmp.ts.
//
// Like BMP, GIF was not found anywhere in the real retail data (own census
// of baseq2/pak0.pak and Q2Game.kpf, both scanned for ".gif": zero hits) --
// forward-looking format support, not filling an observed content gap.
// Test fixtures are synthetic (built with Python's Pillow, documented in
// test/gif.test.ts's own header) rather than retail-gated.
//
// STATIC ONLY, FIRST FRAME ONLY: this decoder reads the Logical Screen
// Descriptor, the (optional) Global Color Table, then walks blocks until
// the FIRST Image Descriptor's pixel data is fully decoded, and returns
// that as the whole image. Any Graphic Control Extension immediately
// preceding that first image is honored (for its transparent-color index
// only -- disposal method and frame delay are meaningless for a single
// still image and are not read). Everything after the first image's data
// sub-blocks -- additional Graphic Control Extensions, Image Descriptors,
// Application/Comment/Plain Text extensions, the Trailer -- is never
// parsed. An animated GIF therefore decodes to its first frame exactly as
// if it were a plain still image; this matches how a Quake II texture/pic
// asset would actually be used (one static 2D image), not an animation
// player.
//
// Supported: GIF87a and GIF89a signatures; global and local color tables
// (both up to 256 entries); the LZW variant GIF actually uses (variable
// code width 2..12 bits, clear/end control codes, the classic "code ==
// next available code" KwKwK special case); interlaced images (4-pass
// Adam7-style row order, ITU/GIF89a Appendix E). Not supported: multi-image
// composition onto a shared logical screen (imageLeft/imageTop are read
// but ignored -- the returned image is exactly the first Image
// Descriptor's own width/height, not composited onto the logical screen
// size) and any frame beyond the first.

export interface DecodedGifT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down -- matches
  // png.ts's DecodedPngT/bmp.ts's DecodedBmpT convention.
  pixels: Uint8Array;
}

export type DecodeGifResultT = { ok: true; image: DecodedGifT } | { ok: false; reason: string };

const EXT_INTRODUCER = 0x21;
const GRAPHIC_CONTROL_LABEL = 0xf9;
const IMAGE_DESCRIPTOR = 0x2c;
const TRAILER = 0x3b;

interface Reader {
  buf: Uint8Array;
  pos: number;
}

function readU8(r: Reader): number | undefined {
  if (r.pos >= r.buf.length) return undefined;
  return r.buf[r.pos++];
}

function readU16LE(r: Reader): number | undefined {
  if (r.pos + 2 > r.buf.length) return undefined;
  const lo = r.buf[r.pos];
  const hi = r.buf[r.pos + 1];
  r.pos += 2;
  return lo + hi * 256;
}

// Reads a GIF "data sub-blocks" run: a size byte followed by that many data
// bytes, repeated until a zero-size block terminates the run. Used for both
// the LZW-compressed image data and every extension's payload.
function readSubBlocks(r: Reader): Uint8Array | undefined {
  const chunks: number[] = [];
  for (;;) {
    const size = readU8(r);
    if (size === undefined) return undefined;
    if (size === 0) break;
    if (r.pos + size > r.buf.length) return undefined;
    for (let i = 0; i < size; i++) chunks.push(r.buf[r.pos + i]);
    r.pos += size;
  }
  return new Uint8Array(chunks);
}

// GIF's LZW variant: codes are packed LSB-first, bit-packed across byte
// boundaries (unlike TIFF/PDF's MSB-first LZW). Decodes to a flat array of
// color-table indices, stopping once `wantPixels` indices have been
// produced (real encoders emit an end code right after the last pixel, but
// a robust decoder doesn't need to wait for it once it has enough data).
function lzwDecode(data: Uint8Array, minCodeSize: number, wantPixels: number): number[] | null {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let dict: number[][] = [];
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;

  function resetDict(): void {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([]); // clearCode slot, unused as an actual entry
    dict.push([]); // endCode slot, unused as an actual entry
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  }
  resetDict();

  const out: number[] = [];
  let prevCode: number | null = null;

  let bitPos = 0;
  const totalBits = data.length * 8;

  function nextCodeValue(): number | null {
    if (bitPos + codeSize > totalBits) return null;
    let value = 0;
    for (let i = 0; i < codeSize; i++) {
      const bytePos = (bitPos + i) >> 3;
      const bitOfs = (bitPos + i) & 7;
      const bit = (data[bytePos] >> bitOfs) & 1;
      value |= bit << i;
    }
    bitPos += codeSize;
    return value;
  }

  for (;;) {
    if (out.length >= wantPixels) break;
    const code = nextCodeValue();
    if (code === null) break;

    if (code === clearCode) {
      resetDict();
      prevCode = null;
      continue;
    }
    if (code === endCode) break;

    // code is guaranteed not to be clearCode/endCode here (both handled
    // above), so any code already present in the dictionary (dict has no
    // holes -- it grows by exactly one entry per new code, matching
    // nextCode) is a valid literal lookup.
    let entry: number[];
    if (code < dict.length) {
      entry = dict[code];
    } else if (code === nextCode && prevCode !== null) {
      const prevEntry = dict[prevCode];
      entry = [...prevEntry, prevEntry[0]];
    } else {
      return null; // malformed code stream
    }

    for (const b of entry) out.push(b);

    if (prevCode !== null) {
      const prevEntry = dict[prevCode];
      dict[nextCode] = [...prevEntry, entry[0]];
      nextCode++;
      if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prevCode = code;
  }

  return out;
}

// Adam7-for-GIF row interlacing order (GIF89a Appendix E): four passes,
// each visiting every 8th/8th/4th/2nd row starting at a different offset.
// Returns, for pass index p (0..3), the sequence of destination row
// numbers that pass fills, in the order the decoded pixel stream supplies
// them.
function interlacedRowOrder(height: number): number[] {
  const rows: number[] = [];
  const passes: [number, number][] = [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ];
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

export function decodeGIF(buffer: Uint8Array): DecodeGifResultT {
  if (buffer.length < 13) return { ok: false, reason: "file too short" };
  const sig = String.fromCharCode(...buffer.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") return { ok: false, reason: "bad GIF signature" };

  const r: Reader = { buf: buffer, pos: 6 };

  const logicalWidth = readU16LE(r);
  const logicalHeight = readU16LE(r);
  const packed = readU8(r);
  readU8(r); // background color index -- unused (no canvas compositing)
  readU8(r); // pixel aspect ratio -- unused
  if (logicalWidth === undefined || logicalHeight === undefined || packed === undefined) {
    return { ok: false, reason: "truncated logical screen descriptor" };
  }

  const globalColorTableFlag = (packed & 0x80) !== 0;
  const globalColorTableSize = globalColorTableFlag ? 2 << (packed & 0x07) : 0;

  let globalColorTable: Uint8Array | null = null;
  if (globalColorTableFlag) {
    if (r.pos + globalColorTableSize * 3 > buffer.length) return { ok: false, reason: "truncated global color table" };
    globalColorTable = buffer.subarray(r.pos, r.pos + globalColorTableSize * 3);
    r.pos += globalColorTableSize * 3;
  }

  let transparentColorFlag = false;
  let transparentColorIndex = -1;

  for (;;) {
    const introducer = readU8(r);
    if (introducer === undefined) return { ok: false, reason: "truncated block stream" };

    if (introducer === TRAILER) return { ok: false, reason: "no image data found before trailer" };

    if (introducer === EXT_INTRODUCER) {
      const label = readU8(r);
      if (label === undefined) return { ok: false, reason: "truncated extension" };

      if (label === GRAPHIC_CONTROL_LABEL) {
        // Fixed 4-byte block size per spec (packed byte, u16 delay, index
        // byte), always followed by exactly one 0x00 terminator byte. A
        // size other than 4 would signal a future GIF extension revision
        // this decoder doesn't know about; bail out rather than guess.
        const size = readU8(r);
        if (size === undefined || size !== 4) return { ok: false, reason: "malformed graphic control extension" };
        const gcePacked = readU8(r);
        readU16LE(r); // delay time -- unused (single-frame decode)
        const tIndex = readU8(r);
        const terminator = readU8(r);
        if (gcePacked === undefined || tIndex === undefined || terminator === undefined) {
          return { ok: false, reason: "truncated graphic control extension" };
        }
        if (terminator !== 0) return { ok: false, reason: "malformed graphic control extension terminator" };
        transparentColorFlag = (gcePacked & 0x01) !== 0;
        transparentColorIndex = tIndex;
      } else {
        const payload = readSubBlocks(r);
        if (payload === undefined) return { ok: false, reason: "truncated extension payload" };
      }
      continue;
    }

    if (introducer === IMAGE_DESCRIPTOR) {
      const imageLeft = readU16LE(r);
      const imageTop = readU16LE(r);
      const imageWidth = readU16LE(r);
      const imageHeight = readU16LE(r);
      const imgPacked = readU8(r);
      void imageLeft;
      void imageTop;
      if (imageWidth === undefined || imageHeight === undefined || imgPacked === undefined) {
        return { ok: false, reason: "truncated image descriptor" };
      }
      if (imageWidth === 0 || imageHeight === 0) return { ok: false, reason: "zero-sized image" };

      const localColorTableFlag = (imgPacked & 0x80) !== 0;
      const interlaceFlag = (imgPacked & 0x40) !== 0;
      const localColorTableSize = localColorTableFlag ? 2 << (imgPacked & 0x07) : 0;

      let colorTable = globalColorTable;
      if (localColorTableFlag) {
        if (r.pos + localColorTableSize * 3 > buffer.length) return { ok: false, reason: "truncated local color table" };
        colorTable = buffer.subarray(r.pos, r.pos + localColorTableSize * 3);
        r.pos += localColorTableSize * 3;
      }
      if (!colorTable) return { ok: false, reason: "no color table (neither global nor local)" };

      const minCodeSize = readU8(r);
      if (minCodeSize === undefined || minCodeSize < 2 || minCodeSize > 8) {
        return { ok: false, reason: `bad LZW minimum code size: ${minCodeSize}` };
      }

      const compressed = readSubBlocks(r);
      if (compressed === undefined) return { ok: false, reason: "truncated image data" };

      const wantPixels = imageWidth * imageHeight;
      const indices = lzwDecode(compressed, minCodeSize, wantPixels);
      if (indices === null || indices.length < wantPixels) return { ok: false, reason: "LZW decode failed or produced too few pixels" };

      const pixels = new Uint8Array(imageWidth * imageHeight * 4);
      const rowOrder = interlaceFlag ? interlacedRowOrder(imageHeight) : null;

      for (let i = 0; i < wantPixels; i++) {
        const index = indices[i];
        const srcRow = interlaceFlag ? Math.floor(i / imageWidth) : -1;
        const destRow = interlaceFlag && rowOrder ? rowOrder[srcRow] : Math.floor(i / imageWidth);
        const col = i % imageWidth;
        const dstOfs = (destRow * imageWidth + col) * 4;

        const paletteOfs = index * 3;
        const r8 = colorTable[paletteOfs] ?? 0;
        const g8 = colorTable[paletteOfs + 1] ?? 0;
        const b8 = colorTable[paletteOfs + 2] ?? 0;
        const isTransparent = transparentColorFlag && index === transparentColorIndex;

        pixels[dstOfs + 0] = r8;
        pixels[dstOfs + 1] = g8;
        pixels[dstOfs + 2] = b8;
        pixels[dstOfs + 3] = isTransparent ? 0 : 255;
      }

      return { ok: true, image: { width: imageWidth, height: imageHeight, pixels } };
    }

    return { ok: false, reason: `unrecognized block introducer: 0x${introducer.toString(16)}` };
  }
}
