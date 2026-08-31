// GIF (87a/89a) decoding -- NOT a port of any file in the original id
// Quake II source (vanilla ref_gl/ref_soft only ever load PCX/WAL/TGA; see
// gl_image.ts's own header comment). Added per Mike's ruling 2026-08-31
// (.orch/followups.md, "support as many image formats for as many things
// as possible"), same spirit as png.ts/jpg.ts/bmp.ts. That same day's
// follow-up ruling ("image format scope FINAL") shipped this decoder as
// STATIC, FIRST-FRAME-ONLY (landed 9ad6d01) with animation explicitly
// deferred ("static .gif (first frame; animation NOT wired)").
//
// ANIMATION (this revision, Mike's settled design, same 2026-08-31 session,
// superseding the "animation NOT wired" line above): this decoder now
// decodes and composites EVERY frame of an animated GIF, not just the
// first. Frame SELECTION (which composited frame is on screen right now)
// is deliberately NOT this module's job -- see qcommon/gif_beat.ts's
// gifBeatFrame for the fixed-10Hz, TIME-derived cadence that both
// renderers' draw paths use instead of this file's own (ignored) delay/
// loop metadata. Wiring: src/ref_gl/gl_image.ts registers every composited
// frame as its own GL texture (GL_LoadPic per frame under a derived name);
// src/ref_gl/gl_draw.ts's Draw_Pic/Draw_StretchPic/Draw_ColorPic/
// Draw_StretchPicRegion pick the frame to bind at draw time. The software
// renderer (ref_soft/r_image.ts's LoadGIFQuantized) stays first-frame-only
// by deliberate ruling -- see that file's own header note -- as does every
// 3D use of a GIF (wall textures via GL_LoadWal, skins via R_RegisterSkin)
// in the GL renderer: GL_LoadByExt's "gif" case only attaches the
// multi-frame record for `ImagetypeT.it_pic` loads (2D UI pics), so a GIF
// used as a wall texture or skin decodes and uploads its first COMPOSITED
// frame only, exactly like any other still image.
//
// Like BMP, GIF was not found anywhere in the real retail data (own census
// of baseq2/pak0.pak and Q2Game.kpf, both scanned for ".gif": zero hits) --
// forward-looking format support, not filling an observed content gap.
// Test fixtures are synthetic (built with Python's Pillow, documented in
// test/gif.test.ts's own header) rather than retail-gated.
//
// DECODE SHAPE: this decoder reads the Logical Screen Descriptor, the
// (optional) Global Color Table, then walks EVERY block until the Trailer,
// decoding each Image Descriptor's own pixel data (honoring any Graphic
// Control Extension immediately preceding it, for both its transparent-
// color index and its disposal method) and appending it to an internal
// frame list. GIF delay time and the NETSCAPE2.0 loop-count Application
// Extension are read where present (to stay a well-formed parser that
// doesn't choke on them) but their VALUES are deliberately discarded --
// this is Mike's design ruling, not an oversight: every animated GIF used
// by this port loops forever at the fixed cadence gif_beat.ts defines,
// regardless of what the source file's own per-frame delay or loop count
// says. A GIF with only one Image Descriptor keeps the EXACT prior
// behavior byte-for-byte: `frames` is a single entry sized to that image's
// own width/height (NOT composited onto the logical screen, matching the
// pre-animation decoder's own documented behavior above), and `image`
// (kept for the pre-animation call sites: LoadGIF/LoadGIFQuantized, both
// unchanged by this revision) is simply `frames[0]`.
//
// COMPOSITING (2+ Image Descriptors): each output frame is a FULL
// logicalWidth*logicalHeight RGBA canvas, built by drawing every raw frame
// in order onto a persistent canvas (initially fully transparent -- this
// decoder does not track the Logical Screen Descriptor's background-color
// index as an actual paintable color; see the disposal-method-2 note
// below for why that's a deliberate simplification, not a gap) and
// snapshotting the canvas after each frame is drawn. A raw frame's
// transparent-index pixels (alpha 0 in its own decode) leave the canvas
// pixel underneath untouched, exactly like every other GIF decoder's
// partial-rect compositing. Disposal method (Graphic Control Extension
// packed byte bits 2-4) governs what happens to the canvas BETWEEN a
// frame's own draw and the next frame's draw:
//   0 (unspecified) and 1 (do not dispose): grouped together as "keep" --
//     no canvas change; the next frame draws on top of this one's result.
//   2 (restore to background): the just-drawn frame's own rectangle is
//     cleared to fully transparent (alpha 0) before the next frame draws.
//     Deliberate divergence from a byte-literal reading of the spec (which
//     says "background color", not "transparent") -- this decoder has no
//     real background color to restore to (the LSD's background-color
//     INDEX is read but never resolved against a color table anywhere in
//     this file, same as the pre-animation decoder), and transparent is
//     what every major browser engine's GIF decoder actually does for
//     this disposal method in practice (verified against Pillow's own
//     reference decoder while building this file's test fixtures: Pillow
//     fills literal background color instead, which is the source of the
//     one intentional divergence documented in test/gif.test.ts).
//   3 (restore to previous): the canvas is rolled back to exactly what it
//     looked like immediately BEFORE the just-drawn frame was drawn (a
//     snapshot taken right before that frame's own composite step).
//   4-7 (reserved, unspecified by GIF89a): treated the same as 0/1 ("keep")
//     -- there is no defined behavior to fall back to otherwise.
//
// Supported: GIF87a and GIF89a signatures; global and local color tables
// (both up to 256 entries); the LZW variant GIF actually uses (variable
// code width 2..12 bits, clear/end control codes, the classic "code ==
// next available code" KwKwK special case); interlaced images (4-pass
// Adam7-style row order, ITU/GIF89a Appendix E); multi-image composition
// onto the shared logical screen (imageLeft/imageTop position each raw
// frame within the canvas) for files with 2+ Image Descriptors.

export interface DecodedGifT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down -- matches
  // png.ts's DecodedPngT/bmp.ts's DecodedBmpT convention.
  pixels: Uint8Array;
}

// `frames`: every decoded frame. Length 1 for a single-image file (that
// entry is sized to the image's own width/height, matching this decoder's
// pre-animation behavior exactly); length 2+ for an animated file (every
// entry then shares the SAME width/height -- the logical screen size --
// since each is a fully composited canvas snapshot, not a raw per-frame
// rect). `image` is always `frames[0]`, kept so the pre-animation call
// sites (LoadGIF/LoadGIFQuantized) don't need to change.
export type DecodeGifResultT = { ok: true; image: DecodedGifT; frames: readonly DecodedGifT[] } | { ok: false; reason: string };

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

// One Image Descriptor's own decode, positioned within the logical screen
// but NOT yet composited onto anything -- `pixels` is exactly
// imageWidth*imageHeight*4 bytes, top-down within its own rect.
// `disposalMethod` is whatever the immediately preceding Graphic Control
// Extension said (0 when there was none), 0-7 (see this file's header
// comment for how 4-7 are treated).
interface RawFrameT {
  imageLeft: number;
  imageTop: number;
  imageWidth: number;
  imageHeight: number;
  pixels: Uint8Array;
  disposalMethod: number;
}

// Composites a sequence of raw (positioned, un-composited) frames onto a
// shared logicalWidth*logicalHeight canvas, honoring each frame's own
// disposal method for what happens to the canvas before the NEXT frame
// draws. Returns one full-canvas RGBA snapshot per input frame, in order.
// See this file's header comment for the disposal-method semantics.
function composeAnimatedFrames(logicalWidth: number, logicalHeight: number, rawFrames: readonly RawFrameT[]): DecodedGifT[] {
  const canvas = new Uint8Array(logicalWidth * logicalHeight * 4); // starts fully transparent
  const composed: DecodedGifT[] = [];

  let previousFrame: RawFrameT | null = null;
  let previousSnapshot: Uint8Array | null = null; // canvas state right before previousFrame was drawn, only kept when previousFrame's own disposal is 3

  for (const frame of rawFrames) {
    // Apply the PREVIOUS frame's disposal before this frame draws.
    if (previousFrame) {
      if (previousFrame.disposalMethod === 2) {
        // restore to background -- see header comment for why this clears
        // to transparent rather than a literal background color.
        for (let y = 0; y < previousFrame.imageHeight; y++) {
          const rowOfs = ((previousFrame.imageTop + y) * logicalWidth + previousFrame.imageLeft) * 4;
          canvas.fill(0, rowOfs, rowOfs + previousFrame.imageWidth * 4);
        }
      } else if (previousFrame.disposalMethod === 3 && previousSnapshot) {
        canvas.set(previousSnapshot);
      }
      // 0/1 (and any reserved 4-7 value): no-op, canvas keeps this frame's result.
    }

    // If THIS frame will need "restore to previous" once it's superseded,
    // snapshot the canvas now, before drawing it.
    previousSnapshot = frame.disposalMethod === 3 ? canvas.slice() : null;

    // Composite this frame's own pixels onto the canvas at its rect,
    // skipping transparent (alpha 0) source pixels so whatever was already
    // on the canvas shows through them.
    for (let y = 0; y < frame.imageHeight; y++) {
      for (let x = 0; x < frame.imageWidth; x++) {
        const srcOfs = (y * frame.imageWidth + x) * 4;
        if (frame.pixels[srcOfs + 3] === 0) continue;
        const dstOfs = ((frame.imageTop + y) * logicalWidth + (frame.imageLeft + x)) * 4;
        canvas[dstOfs + 0] = frame.pixels[srcOfs + 0];
        canvas[dstOfs + 1] = frame.pixels[srcOfs + 1];
        canvas[dstOfs + 2] = frame.pixels[srcOfs + 2];
        canvas[dstOfs + 3] = frame.pixels[srcOfs + 3];
      }
    }

    composed.push({ width: logicalWidth, height: logicalHeight, pixels: canvas.slice() });
    previousFrame = frame;
  }

  return composed;
}

export function decodeGIF(buffer: Uint8Array): DecodeGifResultT {
  if (buffer.length < 13) return { ok: false, reason: "file too short" };
  const sig = String.fromCharCode(...buffer.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") return { ok: false, reason: "bad GIF signature" };

  const r: Reader = { buf: buffer, pos: 6 };

  const logicalWidth = readU16LE(r);
  const logicalHeight = readU16LE(r);
  const packed = readU8(r);
  readU8(r); // background color index -- unused (see header comment: disposal-to-background clears to transparent, not a resolved color)
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

  // Pending Graphic Control Extension fields, consumed by (and reset after)
  // the next Image Descriptor -- a GCE applies only to the one image that
  // immediately follows it (GIF89a Appendix A).
  let transparentColorFlag = false;
  let transparentColorIndex = -1;
  let disposalMethod = 0;

  const rawFrames: RawFrameT[] = [];

  for (;;) {
    const introducer = readU8(r);
    if (introducer === undefined) return { ok: false, reason: "truncated block stream" };

    if (introducer === TRAILER) break;

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
        readU16LE(r); // delay time -- read past, value discarded (see header comment: fixed 10Hz cadence overrides it)
        const tIndex = readU8(r);
        const terminator = readU8(r);
        if (gcePacked === undefined || tIndex === undefined || terminator === undefined) {
          return { ok: false, reason: "truncated graphic control extension" };
        }
        if (terminator !== 0) return { ok: false, reason: "malformed graphic control extension terminator" };
        transparentColorFlag = (gcePacked & 0x01) !== 0;
        transparentColorIndex = tIndex;
        disposalMethod = (gcePacked >> 2) & 0x07;
      } else {
        // Application Extension (e.g. NETSCAPE2.0's loop count) / Comment /
        // Plain Text -- read past and discarded. See header comment: loop
        // count is deliberately ignored, every animated GIF loops forever
        // at the fixed cadence instead.
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
      if (imageLeft === undefined || imageTop === undefined || imageWidth === undefined || imageHeight === undefined || imgPacked === undefined) {
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

      rawFrames.push({ imageLeft, imageTop, imageWidth, imageHeight, pixels, disposalMethod });

      // A GCE applies to exactly one image; reset for whatever (if
      // anything) precedes the next one.
      transparentColorFlag = false;
      transparentColorIndex = -1;
      disposalMethod = 0;
      continue;
    }

    return { ok: false, reason: `unrecognized block introducer: 0x${introducer.toString(16)}` };
  }

  if (rawFrames.length === 0) return { ok: false, reason: "no image data found before trailer" };

  if (rawFrames.length === 1) {
    // Exact pre-animation behavior: the single image's own width/height,
    // not composited onto the logical screen.
    const only = rawFrames[0];
    const image: DecodedGifT = { width: only.imageWidth, height: only.imageHeight, pixels: only.pixels };
    return { ok: true, image, frames: [image] };
  }

  const frames = composeAnimatedFrames(logicalWidth, logicalHeight, rawFrames);
  return { ok: true, image: frames[0], frames };
}
