/*
Unit tests for the sound port (snd_dma.ts/snd_mem.ts/snd_mix.ts) and the
headless platform DMA driver (platform/snd.ts). Self-sufficient per
PORTING.md/preferences rule 13: every test sets up the module-level singleton
state it reads (dma, channels, sndCvars, paintedtime/s_rawend, s_pendingplays)
rather than relying on another test having run first.
*/

import { describe, test, expect } from "bun:test";
import { GetWavinfo, ResampleSfx } from "../src/client/snd_mem";
import { S_PaintChannels } from "../src/client/snd_mix";
import { S_Init, S_Shutdown, S_StartSound, S_Update } from "../src/client/snd_dma";
import { SNDDMA_Init } from "../src/platform/snd";
import {
  dma,
  channels,
  sndCvars,
  s_pendingplays,
  setPaintedtime,
  setSRawend,
  ChannelT,
  SfxT,
  SfxcacheT,
  MAX_CHANNELS,
} from "../src/client/snd_loc";
import { cl, cls } from "../src/client/client";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";

function resetSoundState(): void {
  for (let i = 0; i < MAX_CHANNELS; i++) channels[i] = new ChannelT();
  s_pendingplays.next = s_pendingplays;
  s_pendingplays.prev = s_pendingplays;
  setPaintedtime(0);
  setSRawend(0);
}

function buildWav(opts: { channels: number; rate: number; bitsPerSample: number; data: Uint8Array }): Uint8Array {
  const { channels: numChannels, rate, bitsPerSample, data } = opts;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = rate * blockAlign;
  const fmtChunkSize = 16;
  const dataChunkSize = data.length;
  const riffSize = 4 + (8 + fmtChunkSize) + (8 + dataChunkSize);

  const buf = new Uint8Array(8 + riffSize);
  const view = new DataView(buf.buffer);
  let o = 0;

  const writeTag = (tag: string): void => {
    for (let i = 0; i < 4; i++) buf[o + i] = tag.charCodeAt(i);
    o += 4;
  };

  writeTag("RIFF");
  view.setUint32(o, riffSize, true);
  o += 4;
  writeTag("WAVE");

  writeTag("fmt ");
  view.setUint32(o, fmtChunkSize, true);
  o += 4;
  view.setUint16(o, 1, true); // PCM
  o += 2;
  view.setUint16(o, numChannels, true);
  o += 2;
  view.setUint32(o, rate, true);
  o += 4;
  view.setUint32(o, byteRate, true);
  o += 4;
  view.setUint16(o, blockAlign, true);
  o += 2;
  view.setUint16(o, bitsPerSample, true);
  o += 2;

  writeTag("data");
  view.setUint32(o, dataChunkSize, true);
  o += 4;
  buf.set(data, o);
  o += dataChunkSize;

  return buf;
}

describe("snd_mem.ts -- GetWavinfo", () => {
  test("parses a synthetic 8-bit mono 11025Hz RIFF/WAVE (fmt + data chunks)", () => {
    const pcm = new Uint8Array([128, 138, 148, 158, 168]);
    const wav = buildWav({ channels: 1, rate: 11025, bitsPerSample: 8, data: pcm });

    const info = GetWavinfo("test.wav", wav, wav.length);

    expect(info.channels).toBe(1);
    expect(info.rate).toBe(11025);
    expect(info.width).toBe(1);
    expect(info.loopstart).toBe(-1); // no cue chunk present
    expect(info.samples).toBe(pcm.length);
    expect(Array.from(wav.slice(info.dataofs, info.dataofs + pcm.length))).toEqual(Array.from(pcm));
  });
});

describe("snd_mem.ts -- ResampleSfx", () => {
  test("fast path (stepscale=1, 8-bit->8-bit) converts unsigned PCM to the signed-byte bit pattern", () => {
    dma.speed = 11025;
    sndCvars.s_loadas8bit = null;

    const sfx = new SfxT();
    const sc = new SfxcacheT();
    sc.length = 8;
    sc.loopstart = -1;
    sc.data = new Uint8Array(8);
    sfx.cache = sc;

    const input = new Uint8Array([108, 118, 128, 138, 148, 158, 168, 178]);
    ResampleSfx(sfx, 11025, 1, input);

    expect(sc.length).toBe(8);
    expect(sc.width).toBe(1);
    expect(Array.from(sc.data)).toEqual([236, 246, 0, 10, 20, 30, 40, 50]);
  });

  test("downsamples a 16-bit ramp 2:1 (general path)", () => {
    dma.speed = 11025;
    sndCvars.s_loadas8bit = null;

    const sfx = new SfxT();
    const sc = new SfxcacheT();
    sc.length = 8;
    sc.loopstart = 4;
    sc.data = new Uint8Array(8); // outcount(4) * width(2)
    sfx.cache = sc;

    const samples = [100, 200, 300, 400, 500, 600, 700, 800];
    const input = new Uint8Array(16);
    const iv = new DataView(input.buffer);
    samples.forEach((s, i) => iv.setInt16(i * 2, s, true));

    ResampleSfx(sfx, 22050, 2, input); // stepscale = 22050/11025 = 2

    expect(sc.length).toBe(4);
    expect(sc.width).toBe(2);
    expect(sc.loopstart).toBe(2);

    const ov = new DataView(sc.data.buffer);
    const out = [0, 1, 2, 3].map((i) => ov.getInt16(i * 2, true));
    expect(out).toEqual([100, 300, 500, 700]); // decimated every-other-sample
  });

  test("upsamples an 8-bit ramp 1:2 (general path)", () => {
    dma.speed = 22050;
    sndCvars.s_loadas8bit = null;

    const sfx = new SfxT();
    const sc = new SfxcacheT();
    sc.length = 4;
    sc.loopstart = -1;
    sc.data = new Uint8Array(8); // outcount(8) * width(1)
    sfx.cache = sc;

    const input = new Uint8Array([108, 118, 128, 138]);
    ResampleSfx(sfx, 11025, 1, input); // stepscale = 11025/22050 = 0.5

    expect(sc.length).toBe(8);
    expect(sc.width).toBe(1);
    expect(Array.from(sc.data)).toEqual([236, 236, 246, 246, 0, 0, 10, 10]); // each source sample doubled
  });
});

describe("snd_mix.ts -- S_PaintChannels", () => {
  test("sums two channels into the paint buffer and clamps on positive overflow", () => {
    resetSoundState();
    dma.channels = 2;
    dma.samplebits = 16;
    dma.samples = 256;
    dma.buffer = new Uint8Array(512);

    const vol = new CvarT();
    vol.value = 1.0; // sndVol = 256 exactly, so channel contribution = sample*leftvol exactly
    sndCvars.s_volume = vol;

    const sfx = new SfxT();
    const sc = new SfxcacheT();
    sc.width = 2;
    sc.length = 1;
    sc.loopstart = -1;
    sc.data = new Uint8Array(2);
    new DataView(sc.data.buffer).setInt16(0, 32767, true);
    sfx.cache = sc;

    for (const idx of [0, 1]) {
      const ch = new ChannelT();
      ch.sfx = sfx;
      ch.leftvol = 255;
      ch.rightvol = 0;
      ch.pos = 0;
      ch.end = 1000;
      channels[idx] = ch;
    }

    // one channel alone would be 32767*255 = 8,355,585 -> >>8 = 32,639 (no clamp);
    // both channels summed = 16,711,170 -> >>8 = 65,278, which does need clamping.
    S_PaintChannels(1);

    const view = new DataView(dma.buffer.buffer);
    expect(view.getInt16(0, true)).toBe(32767); // clamped
    expect(view.getInt16(2, true)).toBe(0); // rightvol=0 on both channels -> untouched
  });

  test("sums two channels into the paint buffer and clamps on negative overflow", () => {
    resetSoundState();
    dma.channels = 2;
    dma.samplebits = 16;
    dma.samples = 256;
    dma.buffer = new Uint8Array(512);

    const vol = new CvarT();
    vol.value = 1.0;
    sndCvars.s_volume = vol;

    const sfx = new SfxT();
    const sc = new SfxcacheT();
    sc.width = 2;
    sc.length = 1;
    sc.loopstart = -1;
    sc.data = new Uint8Array(2);
    new DataView(sc.data.buffer).setInt16(0, -32768, true);
    sfx.cache = sc;

    for (const idx of [0, 1]) {
      const ch = new ChannelT();
      ch.sfx = sfx;
      ch.leftvol = 255;
      ch.rightvol = 0;
      ch.pos = 0;
      ch.end = 1000;
      channels[idx] = ch;
    }

    S_PaintChannels(1);

    const view = new DataView(dma.buffer.buffer);
    expect(view.getInt16(0, true)).toBe(-32768); // clamped
  });
});

describe("platform/snd.ts -- SNDDMA_Init (null driver)", () => {
  test("configures a fixed-size, power-of-two ring buffer and reports success", () => {
    const ok = SNDDMA_Init();

    expect(ok).toBe(true);
    expect(dma.channels).toBe(2);
    expect(dma.samplebits).toBe(16);
    expect(dma.speed).toBe(11025); // s_khz not registered in this test -> default rate
    expect(dma.samples).toBe(0x10000 / 2);
    expect(dma.buffer.length).toBe(0x10000);
    expect(dma.submission_chunk).toBe(1);
    expect(dma.samples & (dma.samples - 1)).toBe(0); // power of two, required by the mixer's ring masks
  });
});

describe("snd_dma.ts -- S_StartSound / S_Update", () => {
  test("S_StartSound queues a playsound that S_Update consumes into a channel", () => {
    // rule 13: the SDL platform suite may have run a full client boot with
    // its own audio accounting in this process; tear that down first so
    // this suite's S_Init starts from a fresh driver/timeline.
    S_Shutdown();
    Cvar_ForceSet("s_initsound", "1"); // the SDL boot suite disables audio init
    S_Init(); // registers cvars, calls SNDDMA_Init, and resets channels/playsounds via S_StopAllSounds
    // ...and clear the loading plaque the SDL boot suite may have left up:
    // S_Update faithfully early-returns while cls.disable_screen is set.
    cls.disable_screen = 0;

    const fakeSfx = new SfxT();
    fakeSfx.name = "test/fake.wav";
    const cache = new SfxcacheT();
    cache.length = 10;
    cache.width = 2;
    cache.loopstart = -1;
    cache.data = new Uint8Array(20); // silence; only queue/consume behavior is under test
    fakeSfx.cache = cache;

    expect(s_pendingplays.next).toBe(s_pendingplays); // nothing queued yet

    S_StartSound(null, cl.playernum + 1, 0, fakeSfx, 1.0, 1.0, 0);

    expect(s_pendingplays.next).not.toBe(s_pendingplays); // now queued

    S_Update(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1));

    expect(s_pendingplays.next).toBe(s_pendingplays); // consumed back to empty by the mixer
  });
});
