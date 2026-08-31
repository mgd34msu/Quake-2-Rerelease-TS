/*
Test support module, not a port of any .c file.

Builds byte-exact, hand-rolled baseline JPEG (SOI/DQT/DHT/SOF0/SOS/EOI)
buffers for src/qcommon/jpg.ts's decoder tests, the same "construct the
real bytes by hand" precedent test/r_image_png.test.ts's buildPngRgba
follows for PNG (that helper leans on node:zlib.deflateSync since PNG's
compressed payload isn't otherwise hand-writable in a test; JPEG has no
such shortcut available -- there's no reference JPEG encoder anywhere in
this dependency-free tree -- so this file *is* a minimal from-scratch
baseline JPEG encoder).

EXACT ROUND-TRIP TRICK: every 8x8 block this module ever emits is built
from a single constant sample value (the caller supplies one level-shifted
integer per block, not a bitmap to compress). A constant NxN block's
forward DCT is mathematically exact under ITU-T T.81's normalization: for
f(x,y) = c (constant), F(0,0) = 8c and every F(u,v) with u>0 or v>0 is
*exactly* zero (the cosine sum that defines each AC coefficient is an
orthogonality sum that vanishes identically for a constant input -- not
an approximation). Choosing quant table entry Q(0,0) = 8 then makes the
quantized DC code equal to c exactly (F(0,0)/Q(0,0) = 8c/8 = c, no
rounding), and on the decode side dequantizing (c * 8 = 8c) and inverse-
transforming a DC-only block reconstructs exactly c again. That means this
encoder never needs a real forward DCT, float rounding, or lossy
quantization tolerance in the tests that use it -- every decoded sample
this module produces is bit-for-bit predictable from the input, so tests
can assert exact expected pixels instead of "close enough". Every AC
coefficient is therefore always zero, so each block's AC entropy coding is
always a single EOB (RS byte 0x00) symbol.

Huffman tables: this encoder always emits a single shared DC table (id 0)
and single shared AC table (id 0), each a trivial CANONICAL flat 8-bit
code (every symbol gets an 8-bit codeword, values assigned in HUFFVAL
order 0,1,2,...) -- a real DHT segment with a real (if deliberately
non-optimal) canonical Huffman table, decoded by jpg.ts's own general
buildHuffmanTable/huffmanDecode exactly like a real encoder's table would
be, not a decoder-side special case.
*/

export interface JpegComponentSpec {
  h: number;
  v: number;
}

export interface BuildBaselineJpegOptions {
  width: number;
  height: number;
  // One entry per component (length 1 = grayscale, length 3 = YCbCr,
  // component order Y,Cb,Cr for the 3-component case).
  components: JpegComponentSpec[];
  // blocks[mcuIndex][componentIndex][blockIndexWithinComponent] = a single
  // level-shifted (sample - 128) integer in [-128, 127], constant across
  // that whole 8x8 block. mcuIndex is row-major (mcuY * mcusPerLine +
  // mcuX); blockIndexWithinComponent is row-major within the component's
  // h*v sub-block grid (by * h + bx) -- both match jpg.ts's own decode
  // iteration order exactly.
  blocks: number[][][];
  restartInterval?: number; // 0/undefined = no DRI segment, no restarts
}

// Standard JPEG zigzag order (same table as jpg.ts's own ZIGZAG -- kept as
// an independent copy here deliberately: this is a from-scratch encoder,
// not code sharing with the unit under test).
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

class BitWriter {
  bytes: number[] = [];
  private bitBuf = 0;
  private bitCount = 0;

  writeBits(value: number, size: number): void {
    for (let i = size - 1; i >= 0; i--) {
      const bit = (value >> i) & 1;
      this.bitBuf = (this.bitBuf << 1) | bit;
      this.bitCount++;
      if (this.bitCount === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    const b = this.bitBuf & 0xff;
    this.bytes.push(b);
    if (b === 0xff) this.bytes.push(0x00); // byte-stuffing
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  // Pads the final partial byte with 1-bits (ITU-T T.81 Annex F.2.2.7),
  // used before EOI and before every restart marker.
  padToByteBoundary(): void {
    if (this.bitCount > 0) {
      const pad = 8 - this.bitCount;
      this.bitBuf = (this.bitBuf << pad) | ((1 << pad) - 1);
      this.bitCount = 8;
      this.flushByte();
    }
  }
}

// JPEG DC/AC magnitude category + value encoding (the encode-side inverse
// of jpg.ts's EXTEND procedure): smallest category S with
// 2^(S-1) <= |d| <= 2^S - 1, and the S-bit code that EXTEND(code, S) maps
// back to d.
function categoryAndBits(d: number): { size: number; bits: number } {
  if (d === 0) return { size: 0, bits: 0 };
  const mag = Math.abs(d);
  let size = 0;
  while (1 << size <= mag) size++;
  const bits = d >= 0 ? d : d + (1 << size) - 1;
  return { size, bits };
}

function marker(type: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, type, (length >> 8) & 0xff, length & 0xff, ...payload];
}

// Flat canonical Huffman table: every symbol in `symbols` gets an 8-bit
// codeword, value = its index in `symbols` (see file header). Returns the
// DHT payload (class/id byte + BITS[16] + HUFFVAL) and a symbol->code
// lookup for the entropy encoder.
function flatHuffmanTable(classAndId: number, symbols: number[]): { dhtPayload: number[]; codeOf: Map<number, number> } {
  const bits = new Array(16).fill(0);
  bits[7] = symbols.length; // all codes at length 8
  const dhtPayload = [classAndId, ...bits, ...symbols];
  const codeOf = new Map<number, number>();
  symbols.forEach((sym, i) => codeOf.set(sym, i));
  return { dhtPayload, codeOf };
}

export function buildBaselineJpeg(opts: BuildBaselineJpegOptions): Uint8Array {
  const { width, height, components, blocks, restartInterval = 0 } = opts;
  const numComponents = components.length;
  if (numComponents !== 1 && numComponents !== 3) throw new Error("test helper only supports 1 or 3 components");

  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (maxH * 8));
  const mcusPerColumn = Math.ceil(height / (maxV * 8));
  const totalMcus = mcusPerLine * mcusPerColumn;

  // DC categories 0..11 cover every possible diff between two level-shifted
  // samples in [-128, 127] (max |diff| = 255, category 9). AC only ever
  // needs EOB (0x00) since every block here is DC-only -- see file header.
  const dcSymbols = Array.from({ length: 12 }, (_, i) => i);
  const acSymbols = [0x00];
  const { dhtPayload: dcPayload, codeOf: dcCodeOf } = flatHuffmanTable(0x00, dcSymbols); // class 0 (DC), id 0
  const { dhtPayload: acPayload, codeOf: acCodeOf } = flatHuffmanTable(0x10, acSymbols); // class 1 (AC), id 0

  const componentIds = numComponents === 1 ? [1] : [1, 2, 3];

  const bytes: number[] = [0xff, 0xd8]; // SOI

  // DQT: one shared table (id 0), DC position = 8 (see file header trick),
  // every other position also 8 (irrelevant -- AC coefficients are always
  // exactly zero regardless of the quant value they'd be divided/
  // multiplied by).
  const dqtPayload = [0x00, ...new Array(64).fill(8)];
  bytes.push(...marker(0xdb, dqtPayload));

  bytes.push(...marker(0xc4, dcPayload));
  bytes.push(...marker(0xc4, acPayload));

  if (restartInterval > 0) {
    bytes.push(...marker(0xdd, [(restartInterval >> 8) & 0xff, restartInterval & 0xff]));
  }

  // SOF0
  const sofPayload = [
    8, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    numComponents,
  ];
  for (let i = 0; i < numComponents; i++) {
    const c = components[i]!;
    sofPayload.push(componentIds[i]!, (c.h << 4) | c.v, 0x00); // quant table id 0
  }
  bytes.push(...marker(0xc0, sofPayload));

  // SOS header
  const sosPayload = [numComponents];
  for (let i = 0; i < numComponents; i++) {
    sosPayload.push(componentIds[i]!, 0x00); // DC table id 0 (high nibble), AC table id 0 (low nibble)
  }
  sosPayload.push(0x00, 0x3f, 0x00); // Ss=0, Se=63, Ah/Al=0
  bytes.push(...marker(0xda, sosPayload));

  // Entropy-coded data
  const bw = new BitWriter();
  const dcPred = new Array(numComponents).fill(0);
  let mcusUntilRestart = restartInterval > 0 ? restartInterval : Infinity;
  let restartCounter = 0;
  let mcusDone = 0;

  for (let mcuIndex = 0; mcuIndex < totalMcus; mcuIndex++) {
    for (let ci = 0; ci < numComponents; ci++) {
      const comp = components[ci]!;
      const compBlocks = blocks[mcuIndex]?.[ci];
      if (!compBlocks || compBlocks.length !== comp.h * comp.v) {
        throw new Error(`buildBaselineJpeg: missing/mis-sized block data for mcu ${mcuIndex} component ${ci}`);
      }
      for (const c of compBlocks) {
        const diff = c - dcPred[ci];
        dcPred[ci] = c;
        const { size, bits } = categoryAndBits(diff);
        const dcCode = dcCodeOf.get(size);
        if (dcCode === undefined) throw new Error(`buildBaselineJpeg: DC category ${size} out of range`);
        bw.writeBits(dcCode, 8);
        if (size > 0) bw.writeBits(bits, size);
        // AC: always immediately EOB (every AC coefficient is exactly zero).
        const acCode = acCodeOf.get(0x00)!;
        bw.writeBits(acCode, 8);
      }
    }

    mcusDone++;
    mcusUntilRestart--;
    if (mcusUntilRestart === 0 && mcusDone < totalMcus) {
      bw.padToByteBoundary();
      bytes.push(...bw.bytes);
      bw.bytes.length = 0;
      bytes.push(0xff, 0xd0 + (restartCounter % 8));
      restartCounter++;
      for (let ci = 0; ci < numComponents; ci++) dcPred[ci] = 0;
      mcusUntilRestart = restartInterval;
    }
  }

  bw.padToByteBoundary();
  bytes.push(...bw.bytes);

  bytes.push(0xff, 0xd9); // EOI

  return new Uint8Array(bytes);
}

// Minimal SOI + SOF<marker> + EOI buffer for "unsupported variant"
// tests -- the decoder must reject these at header-parse time, before
// ever reaching DQT/DHT/SOS, so no entropy-coded payload is needed.
export function buildMinimalSof(sofMarker: number, precision: number, width: number, height: number, numComponents: number): Uint8Array {
  const payload = [precision, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, numComponents];
  for (let i = 0; i < numComponents; i++) {
    payload.push(i + 1, 0x11, 0x00); // 1x1 sampling, quant table id 0
  }
  return new Uint8Array([0xff, 0xd8, ...marker(sofMarker, payload), 0xff, 0xd9]);
}

// Straight YCbCr->RGB conversion mirroring jpg.ts's renderOutput formula
// exactly, so tests can compute expected pixels for a given (Y, Cb, Cr)
// triple without importing the unit under test.
export function ycbcrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const Cb = cb - 128;
  const Cr = cr - 128;
  const r = y + 1.402 * Cr;
  const g = y - 0.344136 * Cb - 0.714136 * Cr;
  const b = y + 1.772 * Cb;
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [clamp(r), clamp(g), clamp(b)];
}
