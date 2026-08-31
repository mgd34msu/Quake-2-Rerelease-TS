// Freeverb-class reverb DSP (src/client/snd_reverb_dsp.ts) -- NOT a port of
// any C file (q2repro's own reverb algorithm lives inside OpenAL-Soft, out
// of reach; see that module's own header comment for the full rationale and
// the parameter-coverage table this unit's report cites). These tests check
// DSP-level sanity properties (stability, non-triviality, and the expected
// qualitative relationship between preset parameters and output) rather than
// exact sample values, since there is no reference implementation to check
// exact values against.
//
// Self-sufficient per PORTING.md rule 13: constructs its own EfxReverbParamsT
// fixtures directly (no dependency on snd_environments.ts's parser/selection
// state or any engine boot).

import { describe, test, expect, beforeEach } from "bun:test";
import { S_ReverbProcessBlock, S_ReverbDspReset } from "../src/client/snd_reverb_dsp";
import { REVERB_PRESETS, REVERB_PRESET_NAMES, type EfxReverbParamsT } from "../src/client/snd_environments";

const SAMPLE_RATE = 44100;

function presetByName(name: string): EfxReverbParamsT {
  return REVERB_PRESETS[REVERB_PRESET_NAMES.indexOf(name)];
}

function impulseBlock(count: number): { left: Float64Array; right: Float64Array } {
  const left = new Float64Array(count);
  const right = new Float64Array(count);
  left[0] = 32768 * 256; // full-scale impulse at the paintbuffer's <<8 fixed-point scale
  right[0] = 32768 * 256;
  return { left, right };
}

function energy(a: Float64Array): number {
  let sum = 0;
  for (const v of a) sum += v * v;
  return sum;
}

beforeEach(() => {
  S_ReverbDspReset();
});

describe("S_ReverbProcessBlock", () => {
  test("silence in, silence out (a linear filter network has no output for a zero input)", () => {
    const left = new Float64Array(512);
    const right = new Float64Array(512);
    S_ReverbProcessBlock(presetByName("stone_room"), SAMPLE_RATE, left, right, left.length);
    for (let i = 0; i < left.length; i++) {
      expect(left[i]).toBe(0);
      expect(right[i]).toBe(0);
    }
  });

  test("an impulse produces a nonzero, bounded (non-diverging) tail", () => {
    const { left, right } = impulseBlock(8192);
    S_ReverbProcessBlock(presetByName("stone_room"), SAMPLE_RATE, left, right, left.length);

    // some energy shows up after the initial impulse sample (a real
    // reverberant tail, not just the dry impulse passed through unchanged)
    let tailEnergy = 0;
    for (let i = 1200; i < left.length; i++) tailEnergy += left[i] * left[i];
    expect(tailEnergy).toBeGreaterThan(0);

    // stability: nothing blows up to infinity/NaN over a few thousand samples
    for (let i = 0; i < left.length; i++) {
      expect(Number.isFinite(left[i])).toBe(true);
      expect(Number.isFinite(right[i])).toBe(true);
      expect(Math.abs(left[i])).toBeLessThan(1e12);
      expect(Math.abs(right[i])).toBeLessThan(1e12);
    }
  });

  test("processing across multiple smaller blocks (matching S_PaintChannels' PAINTBUFFER_SIZE-chunked calls) is equivalent to one big block, since the DSP's internal state persists across calls", () => {
    const total = 4096;
    const { left: leftOne, right: rightOne } = impulseBlock(total);
    S_ReverbDspReset();
    S_ReverbProcessBlock(presetByName("hallway"), SAMPLE_RATE, leftOne, rightOne, total);

    S_ReverbDspReset();
    const leftChunked = new Float64Array(total);
    const rightChunked = new Float64Array(total);
    leftChunked[0] = 32768 * 256;
    rightChunked[0] = 32768 * 256;
    const chunkSize = 512;
    for (let offset = 0; offset < total; offset += chunkSize) {
      const n = Math.min(chunkSize, total - offset);
      const l = leftChunked.subarray(offset, offset + n);
      const r = rightChunked.subarray(offset, offset + n);
      S_ReverbProcessBlock(presetByName("hallway"), SAMPLE_RATE, l, r, n);
    }

    for (let i = 0; i < total; i++) {
      expect(leftChunked[i]).toBeCloseTo(leftOne[i], 6);
      expect(rightChunked[i]).toBeCloseTo(rightOne[i], 6);
    }
  });

  test("a longer decayTime preset retains more tail energy than a shorter one, all else similar (decayTime honored per the coverage table)", () => {
    // padded_cell: decayTime 0.17s, lateReverbGain 1.2691.
    // hangar: decayTime 10.05s, lateReverbGain 1.2560 (comparable gain, very
    // different decay time) -- isolates decayTime's effect on tail energy.
    const short = impulseBlock(16384);
    S_ReverbDspReset();
    S_ReverbProcessBlock(presetByName("padded_cell"), SAMPLE_RATE, short.left, short.right, short.left.length);

    S_ReverbDspReset();
    const long = impulseBlock(16384);
    S_ReverbProcessBlock(presetByName("hangar"), SAMPLE_RATE, long.left, long.right, long.left.length);

    // Compare energy in the LATE part of the buffer (well after the initial
    // transient), where a short decay should have died out much more than a
    // long one.
    const lateStart = 8000;
    const shortLateEnergy = energy(short.left.subarray(lateStart));
    const longLateEnergy = energy(long.left.subarray(lateStart));
    expect(longLateEnergy).toBeGreaterThan(shortLateEnergy);
  });

  test("gain scaling: doubling lateReverbGain roughly doubles the wet output amplitude (linear DSP, HONORED per the coverage table)", () => {
    const base = presetByName("room");
    const doubled: EfxReverbParamsT = { ...base, lateReverbGain: base.lateReverbGain * 2 };

    const a = impulseBlock(2048);
    S_ReverbDspReset();
    S_ReverbProcessBlock(base, SAMPLE_RATE, a.left, a.right, a.left.length);
    const energyBase = energy(a.left.subarray(1));

    const b = impulseBlock(2048);
    S_ReverbDspReset();
    S_ReverbProcessBlock(doubled, SAMPLE_RATE, b.left, b.right, b.left.length);
    const energyDoubled = energy(b.left.subarray(1));

    // Energy scales with amplitude^2, so doubling amplitude should roughly
    // quadruple energy; assert it's clearly larger (not asserting an exact
    // ratio, since the wet/dry sum and shelf filter add nonlinearity at the
    // margins) rather than a brittle exact-ratio check.
    expect(energyDoubled).toBeGreaterThan(energyBase * 2);
  });

  test("sample-rate changes are picked up without crashing (s_khz cvar can change the mixer's dma.speed)", () => {
    const a = impulseBlock(2048);
    S_ReverbProcessBlock(presetByName("cave"), 44100, a.left, a.right, a.left.length);

    S_ReverbDspReset();
    const b = impulseBlock(2048);
    expect(() => S_ReverbProcessBlock(presetByName("cave"), 22050, b.left, b.right, b.left.length)).not.toThrow();
    expect(energy(b.left)).toBeGreaterThan(0);
  });
});
