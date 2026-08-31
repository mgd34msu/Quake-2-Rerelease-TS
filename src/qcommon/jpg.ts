// JPEG (JFIF/baseline sequential DCT) decoding -- NOT a port of any file in
// the original id Quake II source (vanilla ref_gl/ref_soft only ever load
// PCX/WAL/TGA; see gl_image.ts's own header comment). Added so the retail
// re-release's shipped .jpg assets load: baseq2/pak0.pak's images.c texture
// format probe chain is "png jpg tga" (images.c:2258 in the reference
// engine) and the pak ships 198 .jpg files (all under vault/ and
// vault/preview/ -- promotional artwork the in-game "vault" unlockable
// gallery displays), none of which have a .png or .tga sibling.
//
// SURVEY (this unit's own pass over all 198 shipped .jpg files, reading
// every file's SOF marker/precision/component/sampling-factor bytes
// directly out of baseq2/pak0.pak -- see the task report for the full
// listing): every single one is SOF0 (baseline sequential DCT), 8-bit
// precision, 3 components (YCbCr), no arithmetic coding, no restart
// markers (no DRI segment in any of them). Subsampling splits two ways:
// 184 files 4:2:0 (H=2,V=2 on the Y component), 14 files 4:4:4 (H=1,V=1
// on every component, all under vault/preview/ or vault/*.jpg full-size
// concept art) -- no 4:2:2 example exists in the shipped data. Given that,
// a baseline-only decoder is sufficient for 100% of the real retail data;
// progressive/arithmetic-coded/12-bit support was not needed and is
// deliberately out of scope (reported as "unsupported", never misdecoded --
// see below). 4:2:2 and restart-marker support ARE implemented anyway
// (both are simple extensions of the same general subsampling-factor and
// entropy-alignment logic already required for 4:2:0), since a decoder
// that only handles the exact subsampling ratios/absence of restart
// markers seen in one snapshot of one pak is needlessly brittle -- this
// mirrors PORTING.md's "recognized but unsupported variant" contract
// (below) being reserved for genuinely unimplemented compression FAMILIES
// (progressive, arithmetic, 12-bit), not for parameter values this decoder
// already generalizes over.
//
// Scope, matching png.ts's "narrow deliberately" precedent:
//   - SOF0 (baseline sequential DCT) only. SOF1 (extended sequential),
//     SOF2/SOF6 (progressive), SOF3/SOF7 (lossless), SOF9-SOF15
//     (arithmetic-coded variants) are recognized by marker byte and
//     reported as `{ ok: false, reason: "unsupported JPEG variant: ..." }`
//     -- never misdecoded as baseline.
//   - 8-bit sample precision only (SOF0's precision byte); 12-bit is
//     recognized and reported unsupported, matching png.ts's bit-depth
//     check.
//   - 1 (grayscale) or 3 (YCbCr) component scans only; anything else
//     (e.g. 4-component CMYK/YCCK, seen in some Adobe-authored JPEGs but
//     never in the shipped retail data) reports unsupported.
//   - Arbitrary integer H/V sampling factors (1-4) per component -- not
//     hardcoded to 4:2:0/4:2:2/4:4:4 specifically, so any legal baseline
//     subsampling ratio decodes correctly.
//   - A single interleaved scan (one SOS) is supported; a second SOS
//     (non-interleaved multi-scan baseline, legal but vanishingly rare and
//     absent from the retail data) reports unsupported rather than being
//     silently dropped.
//   - Restart markers (DRI/RSTn) are supported: DC predictors reset and
//     the entropy bitstream re-aligns to a byte boundary at each restart,
//     matching the spec (ITU-T T.81 Annex F.2.2.7/B.2.5) exactly, not just
//     "well enough for the current retail data" (which has none).
// Anything outside that returns `{ ok: false }`, the same "recognized but
// not handled, degrade gracefully" shape LoadPCX/LoadTGA/decodePNG already
// use for their own out-of-spec inputs -- callers decide whether that's a
// soft failure (missing-asset fallback) or a hard error (Sys_Error),
// exactly like LoadPNG's existing `reason.startsWith("unsupported")` check
// in gl_image.ts (this decoder's "unsupported" reasons are written to be
// caught by the identical check).
//
// Algorithm notes (all hand-rolled per PORTING.md's "no external
// dependencies" rule -- png.ts's own hand-rolled inflate is the
// precedent; this file has no zlib-equivalent shortcut available since
// node:zlib doesn't do JPEG):
//   - Huffman decode uses the canonical BITS/HUFFVAL table-building
//     procedure from ITU-T T.81 Annex C.2 (generate_size_table /
//     generate_code_table) and the mincode/maxcode/valptr DECODE
//     procedure from Annex F.2.2.3 -- the standard, well-documented
//     approach, not a from-scratch design.
//   - The inverse DCT is the direct separable (row-pass then
//     column-pass) formulation of Annex A's IDCT formula: O(8^3) per
//     block via two 8x8 matrix multiplies against a precomputed cosine
//     basis, rather than a naive O(8^4) double sum. Not a fast
//     (AAN/Loeffler) IDCT -- correctness and readability over raw speed,
//     matching png.ts's own "hand-rolled, not hand-optimized" precedent.
//   - Chroma upsampling is nearest-neighbor (box replication): each
//     subsampled plane sample is read back via
//     `floor(fullResCoord * samplingFactor / maxSamplingFactor)`, the
//     simplest correct baseline reconstruction (real decoders often use
//     smarter interpolation, but nothing in the JPEG spec requires it).
//   - YCbCr->RGB uses the standard ITU-R BT.601 full-range JFIF formula.

export interface DecodedJpgT {
  width: number;
  height: number;
  // Straight (non-premultiplied) RGBA8, row-major, top-down (row 0 is the
  // top scanline) -- alpha is always 255 (JPEG has no alpha channel) --
  // same shape/orientation as png.ts's DecodedPngT.pixels, so callers can
  // treat both the same way.
  pixels: Uint8Array;
}

export type DecodeJpgResultT = { ok: true; image: DecodedJpgT } | { ok: false; reason: string };

// Standard JPEG zigzag scan order: ZIGZAG[i] is the natural (row-major,
// 0..63) coefficient index stored at zigzag position i. (ITU-T T.81
// Figure A.6.)
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

// Precomputed 8-point IDCT cosine basis: COS[x][u] = cos((2x+1) * u * PI / 16).
const IDCT_COS: number[][] = (() => {
  const table: number[][] = [];
  for (let x = 0; x < 8; x++) {
    const row: number[] = [];
    for (let u = 0; u < 8; u++) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / 16));
    }
    table.push(row);
  }
  return table;
})();
const IDCT_C = [1 / Math.SQRT2, 1, 1, 1, 1, 1, 1, 1]; // C(u): 1/sqrt(2) for u=0, else 1

// Separable inverse DCT: block is 64 dequantized coefficients in natural
// (row-major, u + v*8) order; returns 64 spatial-domain samples in the
// range roughly [-128, 127] (still needs the +128 level shift by the
// caller), row-major (x + y*8).
function idct8x8(block: Float64Array): Float64Array {
  const tmp = new Float64Array(64); // after column pass: tmp[u + y*8]
  for (let u = 0; u < 8; u++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += IDCT_C[v] * block[u + v * 8]! * IDCT_COS[y]![v]!;
      }
      tmp[u + y * 8] = sum * 0.5;
    }
  }
  const out = new Float64Array(64); // out[x + y*8]
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) {
        sum += IDCT_C[u] * tmp[u + y * 8]! * IDCT_COS[x]![u]!;
      }
      out[x + y * 8] = sum * 0.5;
    }
  }
  return out;
}

class JpgDecodeError extends Error {}

interface HuffTable {
  mincode: Int32Array;
  maxcode: Int32Array;
  valptr: Int32Array;
  huffval: number[];
}

// ITU-T T.81 Annex C.2: canonical Huffman table construction from the
// BITS (count of codes per length, 1..16) and HUFFVAL (symbols in
// code-length order) arrays straight out of a DHT segment.
function buildHuffmanTable(bits: number[], huffval: number[]): HuffTable {
  const huffsize: number[] = [];
  for (let l = 1; l <= 16; l++) {
    for (let i = 0; i < (bits[l - 1] ?? 0); i++) huffsize.push(l);
  }
  const huffcode: number[] = [];
  let code = 0;
  let si = huffsize.length > 0 ? huffsize[0]! : 0;
  let k = 0;
  while (k < huffsize.length) {
    while (k < huffsize.length && huffsize[k] === si) {
      huffcode.push(code);
      code++;
      k++;
    }
    code <<= 1;
    si++;
  }

  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let p = 0;
  for (let l = 1; l <= 16; l++) {
    const count = bits[l - 1] ?? 0;
    if (count === 0) {
      maxcode[l] = -1;
    } else {
      valptr[l] = p;
      mincode[l] = huffcode[p]!;
      p += count;
      maxcode[l] = huffcode[p - 1]!;
    }
  }
  return { mincode, maxcode, valptr, huffval };
}

// Entropy-coded segment bit reader: MSB-first, with JPEG byte-stuffing
// (a literal 0xFF data byte is always followed by a stuffed 0x00, which
// this strips transparently). Hitting `0xFF <anything but 0x00>` mid-block
// means the entropy data ended early (marker or restart boundary reached
// before the decoder expected one) -- that's always a corrupt-stream
// condition from nextBit()'s point of view, since callers only ever pull
// exactly as many bits as a correctly-formed stream provides.
class BitReader {
  private buffer: Uint8Array;
  pos: number;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(buffer: Uint8Array, pos: number) {
    this.buffer = buffer;
    this.pos = pos;
  }

  nextBit(): number {
    if (this.bitCount === 0) {
      if (this.pos >= this.buffer.length) throw new JpgDecodeError("truncated JPEG entropy data");
      let b = this.buffer[this.pos]!;
      if (b === 0xff) {
        const next = this.buffer[this.pos + 1];
        if (next === 0x00) {
          this.pos += 2;
        } else {
          throw new JpgDecodeError("truncated JPEG entropy data (marker encountered before scan finished)");
        }
      } else {
        this.pos += 1;
      }
      this.bitBuf = b;
      this.bitCount = 8;
    }
    this.bitCount--;
    return (this.bitBuf >> this.bitCount) & 1;
  }

  receiveBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.nextBit();
    return v;
  }

  // Discards any partially-consumed byte so the reader sits on a byte
  // boundary, matching the encoder's restart-marker padding convention
  // (Annex F.2.2.7: the last incomplete byte before a restart marker is
  // padded with 1-bits and never re-examined).
  byteAlign(): void {
    this.bitCount = 0;
  }
}

function huffmanDecode(br: BitReader, table: HuffTable): number {
  let code = br.nextBit();
  let l = 1;
  while (l <= 16 && code > table.maxcode[l]!) {
    code = (code << 1) | br.nextBit();
    l++;
  }
  if (l > 16) throw new JpgDecodeError("corrupt Huffman code (no matching entry)");
  const idx = table.valptr[l]! + (code - table.mincode[l]!);
  const sym = table.huffval[idx];
  if (sym === undefined) throw new JpgDecodeError("corrupt Huffman code (symbol index out of range)");
  return sym;
}

// Annex F.2.2.1 EXTEND: sign-extends a `size`-bit unsigned value read from
// the bitstream into JPEG's signed magnitude-category coding.
function extend(v: number, size: number): number {
  if (size === 0) return 0;
  const vt = 1 << (size - 1);
  return v < vt ? v - (1 << size) + 1 : v;
}

interface Component {
  id: number;
  h: number;
  v: number;
  quantTableId: number;
  dcTableId: number;
  acTableId: number;
  planeWidth: number;
  planeHeight: number;
  plane: Uint8Array; // level-shifted back to 0..255 already
  dcPred: number;
}

const SOF_NAMES: Record<number, string> = {
  0xc1: "extended sequential DCT (SOF1)",
  0xc2: "progressive DCT (SOF2)",
  0xc3: "lossless (SOF3)",
  0xc5: "differential sequential DCT (SOF5)",
  0xc6: "differential progressive DCT (SOF6)",
  0xc7: "differential lossless (SOF7)",
  0xc9: "arithmetic-coded extended sequential DCT (SOF9)",
  0xca: "arithmetic-coded progressive DCT (SOF10)",
  0xcb: "arithmetic-coded lossless (SOF11)",
  0xcd: "arithmetic-coded differential sequential DCT (SOF13)",
  0xce: "arithmetic-coded differential progressive DCT (SOF14)",
  0xcf: "arithmetic-coded differential lossless (SOF15)",
};

export function decodeJPG(buffer: Uint8Array): DecodeJpgResultT {
  try {
    return decodeJPGInner(buffer);
  } catch (e) {
    if (e instanceof JpgDecodeError) return { ok: false, reason: e.message };
    throw e;
  }
}

function decodeJPGInner(buffer: Uint8Array): DecodeJpgResultT {
  if (buffer.length < 4) return { ok: false, reason: "file too short" };
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return { ok: false, reason: "bad JPEG signature" };

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const quantTables = new Map<number, Int32Array>(); // 64 entries each, zigzag order
  const dcTables = new Map<number, HuffTable>();
  const acTables = new Map<number, HuffTable>();

  let precision = 0;
  let width = 0;
  let height = 0;
  let components: Component[] = [];
  let restartInterval = 0;
  let sawSOF = false;
  let sawSOS = false;

  let pos = 2;
  while (pos < buffer.length) {
    if (buffer[pos] !== 0xff) return { ok: false, reason: "malformed marker segment" };
    let mpos = pos + 1;
    while (buffer[mpos] === 0xff) mpos++; // fill bytes
    const marker = buffer[mpos];
    pos = mpos + 1;
    if (marker === undefined) return { ok: false, reason: "truncated marker segment" };

    if (marker === 0xd9) break; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / stray RST: no length, no payload

    if (pos + 2 > buffer.length) return { ok: false, reason: "truncated marker segment" };
    const length = view.getUint16(pos, false);
    if (length < 2 || pos + length > buffer.length) return { ok: false, reason: "truncated marker segment" };
    const segStart = pos + 2;
    const segEnd = pos + length;

    if (marker === 0xc0) {
      // SOF0 -- baseline sequential DCT
      if (segEnd - segStart < 6) return { ok: false, reason: "malformed SOF0 segment" };
      precision = buffer[segStart]!;
      if (precision !== 8) return { ok: false, reason: `unsupported JPEG bit depth ${precision}` };
      height = view.getUint16(segStart + 1, false);
      width = view.getUint16(segStart + 3, false);
      const numComponents = buffer[segStart + 5]!;
      if (numComponents !== 1 && numComponents !== 3) {
        return { ok: false, reason: `unsupported JPEG component count ${numComponents}` };
      }
      if (segEnd - segStart < 6 + numComponents * 3) return { ok: false, reason: "malformed SOF0 segment" };
      components = [];
      for (let c = 0; c < numComponents; c++) {
        const off = segStart + 6 + c * 3;
        const id = buffer[off]!;
        const hv = buffer[off + 1]!;
        const h = hv >> 4;
        const v = hv & 0xf;
        if (h < 1 || h > 4 || v < 1 || v > 4) return { ok: false, reason: "unsupported JPEG sampling factor" };
        const quantTableId = buffer[off + 2]!;
        components.push({
          id,
          h,
          v,
          quantTableId,
          dcTableId: 0,
          acTableId: 0,
          planeWidth: 0,
          planeHeight: 0,
          plane: new Uint8Array(0),
          dcPred: 0,
        });
      }
      sawSOF = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const name = SOF_NAMES[marker] ?? `SOF marker 0x${marker.toString(16)}`;
      return { ok: false, reason: `unsupported JPEG variant: ${name}` };
    } else if (marker === 0xdb) {
      // DQT
      let p = segStart;
      while (p < segEnd) {
        const pq = buffer[p]! >> 4;
        const tq = buffer[p]! & 0xf;
        p++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          if (pq === 0) {
            table[i] = buffer[p]!;
            p++;
          } else {
            table[i] = view.getUint16(p, false);
            p += 2;
          }
        }
        quantTables.set(tq, table);
      }
    } else if (marker === 0xc4) {
      // DHT
      let p = segStart;
      while (p < segEnd) {
        const classId = buffer[p]! >> 4;
        const tableId = buffer[p]! & 0xf;
        p++;
        const bits: number[] = [];
        for (let i = 0; i < 16; i++) bits.push(buffer[p + i]!);
        p += 16;
        const total = bits.reduce((a, b) => a + b, 0);
        const huffval: number[] = [];
        for (let i = 0; i < total; i++) huffval.push(buffer[p + i]!);
        p += total;
        const table = buildHuffmanTable(bits, huffval);
        if (classId === 0) dcTables.set(tableId, table);
        else acTables.set(tableId, table);
      }
    } else if (marker === 0xdd) {
      // DRI
      if (segEnd - segStart < 2) return { ok: false, reason: "malformed DRI segment" };
      restartInterval = view.getUint16(segStart, false);
    } else if (marker === 0xda) {
      // SOS
      if (sawSOS) return { ok: false, reason: "unsupported JPEG variant: multiple scans" };
      if (!sawSOF) return { ok: false, reason: "missing SOF marker" };
      const numScanComponents = buffer[segStart]!;
      if (segEnd - segStart < 1 + numScanComponents * 2 + 3) return { ok: false, reason: "malformed SOS segment" };
      for (let c = 0; c < numScanComponents; c++) {
        const off = segStart + 1 + c * 2;
        const selector = buffer[off]!;
        const tables = buffer[off + 1]!;
        const comp = components.find((cc) => cc.id === selector);
        if (!comp) return { ok: false, reason: "malformed SOS segment (unknown component selector)" };
        comp.dcTableId = tables >> 4;
        comp.acTableId = tables & 0xf;
      }
      // Entropy-coded data isn't length-prefixed (`length` above only
      // covers the scan header): decodeScan's own bit reader consumes
      // exactly the entropy-coded bytes (including any embedded restart
      // markers, which it handles itself) and its final position lands
      // right after the last consumed byte -- which, since baseline
      // encoders always pad the last partial byte to a boundary, is
      // exactly the next real marker (EOI for a single-scan image).
      // Deliberately NOT a byte-level re-scan for the next `0xFF <marker>`
      // pair from segEnd: restart markers are genuine unstuffed `0xFF Dx`
      // bytes embedded inside the entropy-coded data, so a naive re-scan
      // would latch onto the first one instead of the real trailing
      // marker.
      pos = decodeScan(buffer, segEnd, components, quantTables, dcTables, acTables, restartInterval, width, height);
      sawSOS = true;
      continue;
    } else {
      // APPn / COM / DNL / DHP / EXP / reserved JPGn / anything else with
      // a standard length-prefixed payload: not needed for baseline
      // decode, skip.
    }

    pos = segEnd;
  }

  if (!sawSOF) return { ok: false, reason: "missing SOF marker" };
  if (!sawSOS) return { ok: false, reason: "missing SOS marker" };
  if (width <= 0 || height <= 0) return { ok: false, reason: "zero-size image" };

  const pixels = renderOutput(components, width, height);
  return { ok: true, image: { width, height, pixels } };
}

// Decodes the entropy-coded scan data starting at `scanDataStart` and
// returns the buffer position immediately after the last byte it
// consumed -- see the SOS handler's call site for why that position (not
// a byte-level re-scan) is what the outer marker loop resumes from.
function decodeScan(
  buffer: Uint8Array,
  scanDataStart: number,
  components: Component[],
  quantTables: Map<number, Int32Array>,
  dcTables: Map<number, HuffTable>,
  acTables: Map<number, HuffTable>,
  restartInterval: number,
  width: number,
  height: number,
): number {
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcuWidthPx = maxH * 8;
  const mcuHeightPx = maxV * 8;
  const mcusPerLine = Math.ceil(width / mcuWidthPx);
  const mcusPerColumn = Math.ceil(height / mcuHeightPx);

  for (const comp of components) {
    comp.planeWidth = mcusPerLine * comp.h * 8;
    comp.planeHeight = mcusPerColumn * comp.v * 8;
    comp.plane = new Uint8Array(comp.planeWidth * comp.planeHeight);
    comp.dcPred = 0;
  }

  const br = new BitReader(buffer, scanDataStart);
  let mcusUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
  const totalMcus = mcusPerLine * mcusPerColumn;
  let mcusDone = 0;

  for (let mcuY = 0; mcuY < mcusPerColumn; mcuY++) {
    for (let mcuX = 0; mcuX < mcusPerLine; mcuX++) {
      for (const comp of components) {
        const quant = quantTables.get(comp.quantTableId);
        const dcTable = dcTables.get(comp.dcTableId);
        const acTable = acTables.get(comp.acTableId);
        if (!quant) throw new JpgDecodeError("missing DQT table referenced by SOF");
        if (!dcTable || !acTable) throw new JpgDecodeError("missing DHT table referenced by SOS");

        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            decodeBlockInto(br, comp, quant, dcTable, acTable, mcuX, mcuY, bx, by);
          }
        }
      }

      mcusDone++;
      mcusUntilRestart--;
      if (mcusUntilRestart === 0 && mcusDone < totalMcus) {
        br.byteAlign();
        if (buffer[br.pos] !== 0xff || buffer[br.pos + 1] === undefined || !(buffer[br.pos + 1]! >= 0xd0 && buffer[br.pos + 1]! <= 0xd7)) {
          throw new JpgDecodeError("expected restart marker");
        }
        br.pos += 2;
        for (const comp of components) comp.dcPred = 0;
        mcusUntilRestart = restartInterval;
      }
    }
  }

  return br.pos;
}

function decodeBlockInto(
  br: BitReader,
  comp: Component,
  quant: Int32Array,
  dcTable: HuffTable,
  acTable: HuffTable,
  mcuX: number,
  mcuY: number,
  bx: number,
  by: number,
): void {
  const coeffs = new Float64Array(64); // natural order

  // DC
  const dcSize = huffmanDecode(br, dcTable);
  const dcDiffBits = dcSize > 0 ? br.receiveBits(dcSize) : 0;
  const dcDiff = extend(dcDiffBits, dcSize);
  comp.dcPred += dcDiff;
  coeffs[0] = comp.dcPred * quant[0]!;

  // AC
  let k = 1;
  while (k < 64) {
    const rs = huffmanDecode(br, acTable);
    const run = rs >> 4;
    const size = rs & 0xf;
    if (size === 0) {
      if (run === 15) {
        k += 16; // ZRL: 16 zero coefficients
        continue;
      }
      break; // EOB
    }
    k += run;
    if (k >= 64) throw new JpgDecodeError("corrupt AC coefficient run (out of block bounds)");
    const bits = br.receiveBits(size);
    const value = extend(bits, size);
    const zigzagIndex = k;
    const naturalIndex = ZIGZAG[zigzagIndex]!;
    coeffs[naturalIndex] = value * quant[zigzagIndex]!;
    k++;
  }

  const spatial = idct8x8(coeffs);

  const blockOriginX = (mcuX * comp.h + bx) * 8;
  const blockOriginY = (mcuY * comp.v + by) * 8;
  for (let y = 0; y < 8; y++) {
    const rowOff = (blockOriginY + y) * comp.planeWidth + blockOriginX;
    for (let x = 0; x < 8; x++) {
      const s = spatial[x + y * 8]! + 128;
      comp.plane[rowOff + x] = s < 0 ? 0 : s > 255 ? 255 : Math.round(s);
    }
  }
}

function renderOutput(components: Component[], width: number, height: number): Uint8Array {
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const pixels = new Uint8Array(width * height * 4);

  if (components.length === 1) {
    const y = components[0]!;
    for (let py = 0; py < height; py++) {
      const sy = Math.floor((py * y.v) / maxV);
      for (let px = 0; px < width; px++) {
        const sx = Math.floor((px * y.h) / maxH);
        const val = y.plane[sy * y.planeWidth + sx]!;
        const o = (py * width + px) * 4;
        pixels[o] = val;
        pixels[o + 1] = val;
        pixels[o + 2] = val;
        pixels[o + 3] = 255;
      }
    }
    return pixels;
  }

  const yComp = components[0]!;
  const cbComp = components[1]!;
  const crComp = components[2]!;
  for (let py = 0; py < height; py++) {
    const ySy = Math.floor((py * yComp.v) / maxV);
    const cbSy = Math.floor((py * cbComp.v) / maxV);
    const crSy = Math.floor((py * crComp.v) / maxV);
    for (let px = 0; px < width; px++) {
      const ySx = Math.floor((px * yComp.h) / maxH);
      const cbSx = Math.floor((px * cbComp.h) / maxH);
      const crSx = Math.floor((px * crComp.h) / maxH);
      const Y = yComp.plane[ySy * yComp.planeWidth + ySx]!;
      const Cb = cbComp.plane[cbSy * cbComp.planeWidth + cbSx]! - 128;
      const Cr = crComp.plane[crSy * crComp.planeWidth + crSx]! - 128;

      const r = Y + 1.402 * Cr;
      const g = Y - 0.344136 * Cb - 0.714136 * Cr;
      const b = Y + 1.772 * Cb;

      const o = (py * width + px) * 4;
      pixels[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      pixels[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      pixels[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      pixels[o + 3] = 255;
    }
  }
  return pixels;
}
