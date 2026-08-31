// Hand-built byte-vector tests for src/qcommon/bnvib.ts's .bnvib parser.
// See test/bnvib_retail.test.ts for the real-asset-gated counterpart that
// runs the same parser over all 53 shipped tactile/*.bnvib files.

import { describe, test, expect } from "bun:test";
import { bnvibAmplitude, bnvibFrequencyHz, parseBnvib, BNVIB_METADATA_RAW, BNVIB_METADATA_LOOP, BNVIB_METADATA_LOOP_INTERVAL } from "../src/qcommon/bnvib";

// Builds a well-formed .bnvib byte buffer from parts, mirroring the format
// this module's own header comment documents.
function buildBnvib(opts: {
  metadataSize: number;
  formatId?: number;
  sampleRateHz: number;
  loopStart?: number;
  loopEnd?: number;
  loopInterval?: number;
  samples: Array<[number, number, number, number]>;
}): Uint8Array {
  const { metadataSize, formatId = 3, sampleRateHz, loopStart = 0, loopEnd = 0, loopInterval = 0, samples } = opts;
  const dataSize = samples.length * 4;
  const total = 4 + metadataSize + 4 + dataSize;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  dv.setUint32(0, metadataSize, true);
  dv.setUint16(4, formatId, true);
  dv.setUint16(6, sampleRateHz, true);
  if (metadataSize >= BNVIB_METADATA_LOOP) {
    dv.setUint32(8, loopStart, true);
    dv.setUint32(12, loopEnd, true);
  }
  if (metadataSize >= BNVIB_METADATA_LOOP_INTERVAL) {
    dv.setUint32(16, loopInterval, true);
  }

  const metadataEnd = 4 + metadataSize;
  dv.setUint32(metadataEnd, dataSize, true);

  let off = metadataEnd + 4;
  for (const [a, b, c, d] of samples) {
    buf[off++] = a;
    buf[off++] = b;
    buf[off++] = c;
    buf[off++] = d;
  }

  return buf;
}

describe("parseBnvib -- raw (metadataSize 0x04, no loop)", () => {
  test("parses a two-sample raw pattern", () => {
    const bytes = buildBnvib({
      metadataSize: BNVIB_METADATA_RAW,
      sampleRateHz: 200,
      samples: [
        [8, 118, 16, 156],
        [63, 118, 56, 166],
      ],
    });

    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pattern.sampleRateHz).toBe(200);
    expect(result.pattern.loop).toBeUndefined();
    expect(result.pattern.samples).toEqual([
      { ampLow: 8, freqLow: 118, ampHigh: 16, freqHigh: 156 },
      { ampLow: 63, freqLow: 118, ampHigh: 56, freqHigh: 166 },
    ]);
  });

  test("parses a zero-sample raw pattern (empty body is legal)", () => {
    const bytes = buildBnvib({ metadataSize: BNVIB_METADATA_RAW, sampleRateHz: 200, samples: [] });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pattern.samples).toEqual([]);
  });
});

describe("parseBnvib -- loop (metadataSize 0x0c)", () => {
  test("parses loopStart/loopEnd, no intervalSamples", () => {
    const bytes = buildBnvib({
      metadataSize: BNVIB_METADATA_LOOP,
      sampleRateHz: 200,
      loopStart: 4,
      loopEnd: 12,
      samples: Array.from({ length: 16 }, (_, i) => [i, i, i, i] as [number, number, number, number]),
    });

    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pattern.loop).toEqual({ startSample: 4, endSample: 12 });
    expect(result.pattern.samples.length).toBe(16);
  });
});

describe("parseBnvib -- loop+interval (metadataSize 0x10)", () => {
  test("parses loopStart/loopEnd/intervalSamples", () => {
    const bytes = buildBnvib({
      metadataSize: BNVIB_METADATA_LOOP_INTERVAL,
      sampleRateHz: 200,
      loopStart: 2,
      loopEnd: 6,
      loopInterval: 40,
      samples: Array.from({ length: 8 }, (_, i) => [i, 0, 0, i] as [number, number, number, number]),
    });

    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pattern.loop).toEqual({ startSample: 2, endSample: 6, intervalSamples: 40 });
  });
});

describe("parseBnvib -- malformed input degrades to { ok: false }, never throws", () => {
  test("empty buffer", () => {
    const result = parseBnvib(new Uint8Array(0));
    expect(result.ok).toBe(false);
  });

  test("too short for the metadata size field", () => {
    const result = parseBnvib(new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(false);
  });

  test("unrecognized metadata size (not 0x04/0x0c/0x10)", () => {
    const bytes = buildBnvib({ metadataSize: BNVIB_METADATA_RAW, sampleRateHz: 200, samples: [] });
    new DataView(bytes.buffer).setUint32(0, 7, true); // corrupt the field
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported metadata size/);
  });

  test("truncated before the metadata section ends", () => {
    const full = buildBnvib({ metadataSize: BNVIB_METADATA_LOOP, sampleRateHz: 200, loopStart: 1, loopEnd: 2, samples: [[1, 2, 3, 4]] });
    const truncated = full.subarray(0, 10); // metadataSize says 0x0c (needs 16 bytes before dataSize) but only 10 given
    const result = parseBnvib(truncated);
    expect(result.ok).toBe(false);
  });

  test("unsupported formatId", () => {
    const bytes = buildBnvib({ metadataSize: BNVIB_METADATA_RAW, formatId: 99, sampleRateHz: 200, samples: [] });
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unsupported formatId/);
  });

  test("data size not a multiple of 4", () => {
    const bytes = buildBnvib({ metadataSize: BNVIB_METADATA_RAW, sampleRateHz: 200, samples: [[1, 2, 3, 4]] });
    const metadataEnd = 4 + BNVIB_METADATA_RAW;
    new DataView(bytes.buffer).setUint32(metadataEnd, 5, true); // claim 5 bytes of sample data
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not a multiple of 4/);
  });

  test("truncated sample data (dataSize claims more than is present)", () => {
    const bytes = buildBnvib({ metadataSize: BNVIB_METADATA_RAW, sampleRateHz: 200, samples: [[1, 2, 3, 4]] });
    const metadataEnd = 4 + BNVIB_METADATA_RAW;
    new DataView(bytes.buffer).setUint32(metadataEnd, 8, true); // claim 2 samples' worth, only 1 present
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/truncated sample data/);
  });
});

describe("bnvibAmplitude / bnvibFrequencyHz -- documented physical-unit conversions", () => {
  test("amplitude is byte/255", () => {
    expect(bnvibAmplitude(0)).toBe(0);
    expect(bnvibAmplitude(255)).toBe(1);
    expect(bnvibAmplitude(128)).toBeCloseTo(128 / 255, 10);
  });

  test("frequency is 10 * 2^(byte/32)", () => {
    expect(bnvibFrequencyHz(0)).toBeCloseTo(10, 10);
    expect(bnvibFrequencyHz(32)).toBeCloseTo(20, 10); // one full octave up
    expect(bnvibFrequencyHz(64)).toBeCloseTo(40, 10); // two octaves up
    expect(bnvibFrequencyHz(255)).toBeCloseTo(10 * Math.pow(2, 255 / 32), 6);
  });
});
