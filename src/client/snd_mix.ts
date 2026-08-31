// snd_mix.c -- portable code to mix sounds for snd_dma.c. Only
// S_InitScaletable/S_PaintChannels are exported by the original header
// (snd_loc.h); S_WriteLinearBlastStereo16/S_TransferStereo16/
// S_TransferPaintBuffer/S_PaintChannelFrom8/S_PaintChannelFrom16 are
// file-static in C and stay private here.
//
// The `#if !(defined __linux__ && defined __i386__) / #if !id386` asm
// fallbacks (S_WriteLinearBlastStereo16, S_PaintChannelFrom8) are dropped
// per PORTING.md's ref_soft precedent ("asm files are hand-optimized
// duplicates of the C paths and are not ported"); only the portable C
// branch is ported.
//
// C swings raw pointers (snd_p/snd_out into paintbuffer/dma.buffer,
// file-static globals reused across calls) to bridge into the dropped asm
// routine. There is no pointer arithmetic in TS, so this port passes the
// same information as explicit indices/parameters instead of file-static
// pseudo-pointers -- a data-flow restructuring in the same spirit as
// PORTING.md's sanctioned `goto` control-flow restructuring. The mixing
// order and arithmetic are unchanged.

import {
  dma,
  sndCvars,
  channels,
  paintedtime,
  s_rawend,
  s_rawsamples,
  s_pendingplays,
  setPaintedtime,
  MAX_CHANNELS,
  MAX_RAW_SAMPLES,
  PortableSamplepairT,
  type ChannelT,
  type SfxcacheT,
} from "./snd_loc";
import { S_LoadSound } from "./snd_mem";
import { S_IssuePlaysound, S_IsUnderWater } from "./snd_dma";
import { GetActiveReverbParams } from "./snd_environments";
import { S_ReverbProcessBlock } from "./snd_reverb_dsp";

const PAINTBUFFER_SIZE = 2048;
const paintbuffer: PortableSamplepairT[] = Array.from({ length: PAINTBUFFER_SIZE }, () => new PortableSamplepairT());
// Scratch arrays for S_ReverbProcessBlock (snd_reverb_dsp.ts's DSP loop
// operates on plain typed arrays, not PortableSamplepairT objects, to keep
// that module free of a dependency on the mixer's own paint buffer type).
const reverbScratchL = new Float64Array(PAINTBUFFER_SIZE);
const reverbScratchR = new Float64Array(PAINTBUFFER_SIZE);
const sndScaletable: Int32Array[] = Array.from({ length: 32 }, () => new Int32Array(256));
let sndVol = 0;

/*
===============================================================================

UNDERWATER FILTER

q2repro src/client/sound/dma.c:278-329's OpenAL-Soft high-shelf biquad
(divergence-audit finding #12). This port's paint buffer holds fixed-point
values (left/right accumulated at a <<8 scale -- see sTransferStereo16's
`>> 8` before clamping) rather than dma.c's raw floats, but the filter is
linear, so applying the same coefficients to the fixed-point accumulator
produces the same frequency response, just scaled the same way every other
value in this buffer already is. Coefficients are recomputed lazily (not on
a cvar "changed" callback -- this port's CvarT has none) whenever dma.speed
or s_underwater_gain_hf's value has drifted since the last computation.

===============================================================================
*/

let underwater_b0 = 0;
let underwater_b1 = 0;
let underwater_b2 = 0;
let underwater_a1 = 0;
let underwater_a2 = 0;
let underwater_coeffs_speed = 0;
let underwater_coeffs_gain = -1; // never equals a real gain -- forces first compute
const underwater_hist = [
  { z1: 0, z2: 0 },
  { z1: 0, z2: 0 },
];

function sUnderwaterRecomputeIfNeeded(): void {
  const gainRaw = sndCvars.s_underwater_gain_hf?.value ?? 0.25;
  // dma.c:286's Cvar_ClampValue(self, 0.001f, 1)
  const gain = Math.min(1, Math.max(0.001, gainRaw));

  if (dma.speed === underwater_coeffs_speed && gain === underwater_coeffs_gain) return;
  underwater_coeffs_speed = dma.speed;
  underwater_coeffs_gain = gain;

  const f0norm = 5000.0 / dma.speed;
  const w0 = Math.PI * 2.0 * f0norm;
  const sinW0 = Math.sin(w0);
  const cosW0 = Math.cos(w0);
  const alpha = (sinW0 / 2.0) * Math.SQRT2;
  const sqrtGainAlpha2 = 2.0 * Math.sqrt(gain) * alpha;

  let b0 = gain * (gain + 1.0 + (gain - 1.0) * cosW0 + sqrtGainAlpha2);
  let b1 = gain * (gain - 1.0 + (gain + 1.0) * cosW0) * -2.0;
  let b2 = gain * (gain + 1.0 + (gain - 1.0) * cosW0 - sqrtGainAlpha2);

  const a0 = gain + 1.0 - (gain - 1.0) * cosW0 + sqrtGainAlpha2;
  let a1 = (gain - 1.0 - (gain + 1.0) * cosW0) * 2.0;
  let a2 = gain + 1.0 - (gain - 1.0) * cosW0 - sqrtGainAlpha2;

  a1 /= a0;
  a2 /= a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;

  underwater_b0 = b0;
  underwater_b1 = b1;
  underwater_b2 = b2;
  underwater_a1 = a1;
  underwater_a2 = a2;
}

function sUnderwaterFilterChannel(hist: { z1: number; z2: number }, count: number, isLeft: boolean): void {
  let z1 = hist.z1;
  let z2 = hist.z2;

  for (let i = 0; i < count; i++) {
    const samp = paintbuffer[i]!;
    const input = isLeft ? samp.left : samp.right;
    const output = input * underwater_b0 + z1;
    z1 = input * underwater_b1 - output * underwater_a1 + z2;
    z2 = input * underwater_b2 - output * underwater_a2;
    if (isLeft) samp.left = output;
    else samp.right = output;
  }

  hist.z1 = z1;
  hist.z2 = z2;
}

function sUnderwaterFilter(count: number): void {
  sUnderwaterRecomputeIfNeeded();
  sUnderwaterFilterChannel(underwater_hist[0]!, count, true);
  sUnderwaterFilterChannel(underwater_hist[1]!, count, false);
}

function clampShort(val: number): number {
  if (val > 0x7fff) return 0x7fff;
  if (val < -0x8000) return -0x8000;
  return val;
}

function getDmaView(): DataView {
  return new DataView(dma.buffer.buffer, dma.buffer.byteOffset, dma.buffer.byteLength);
}

function sTransferStereo16(endtime: number): void {
  const view = getDmaView();
  let lpaintedtime = paintedtime;
  let pbIndex = 0;

  while (lpaintedtime < endtime) {
    // handle recirculating buffer issues
    const framesInBuffer = dma.samples >> 1;
    const lpos = lpaintedtime & (framesInBuffer - 1);

    let framesRemaining = framesInBuffer - lpos;
    if (lpaintedtime + framesRemaining > endtime) framesRemaining = endtime - lpaintedtime;

    for (let f = 0; f < framesRemaining; f++) {
      const samp = paintbuffer[pbIndex + f];
      const left = clampShort(samp.left >> 8);
      const right = clampShort(samp.right >> 8);
      const byteOffset = (lpos + f) * 4;
      view.setInt16(byteOffset, left, true);
      view.setInt16(byteOffset + 2, right, true);
    }

    pbIndex += framesRemaining;
    lpaintedtime += framesRemaining;
  }
}

/*
===================
S_TransferPaintBuffer

===================
*/
function sTransferPaintBuffer(endtime: number): void {
  if (sndCvars.s_testsound?.value) {
    // write a fixed sine wave
    const count = endtime - paintedtime;
    for (let i = 0; i < count; i++) {
      const v = Math.sin((paintedtime + i) * 0.1) * 20000 * 256;
      paintbuffer[i].left = v;
      paintbuffer[i].right = v;
    }
  }

  if (dma.samplebits === 16 && dma.channels === 2) {
    // optimized case
    sTransferStereo16(endtime);
  } else {
    // general case
    const view = getDmaView();
    let count = (endtime - paintedtime) * dma.channels;
    const outMask = dma.samples - 1;
    let outIdx = (paintedtime * dma.channels) & outMask;
    const step = 3 - dma.channels;
    let p = 0; // flat int index into paintbuffer: even = left, odd = right

    if (dma.samplebits === 16) {
      while (count-- > 0) {
        const entry = paintbuffer[p >> 1];
        const raw = (p & 1) === 0 ? entry.left : entry.right;
        p += step;
        const val = clampShort(raw >> 8);
        view.setInt16(outIdx * 2, val, true);
        outIdx = (outIdx + 1) & outMask;
      }
    } else if (dma.samplebits === 8) {
      while (count-- > 0) {
        const entry = paintbuffer[p >> 1];
        const raw = (p & 1) === 0 ? entry.left : entry.right;
        p += step;
        const val = clampShort(raw >> 8);
        view.setUint8(outIdx, ((val >> 8) + 128) & 0xff);
        outIdx = (outIdx + 1) & outMask;
      }
    }
  }
}

/*
===============================================================================

CHANNEL MIXING

===============================================================================
*/

// C declares `unsigned char *sfx` but assigns it `(signed char *)sc->data +
// ch->pos` and reads through the declared (unsigned char) type, so `data`
// ends up a plain 0-255 byte used directly as the scale-table index -- the
// signed cast has no effect. Ported as a direct byte read.
function sPaintChannelFrom8(ch: ChannelT, sc: SfxcacheT, count: number, offset: number): void {
  if (ch.leftvol > 255) ch.leftvol = 255;
  if (ch.rightvol > 255) ch.rightvol = 255;

  //ZOID-- >>11 has been changed to >>3, >>11 didn't make much sense
  //as it would always be zero.
  const lscale = sndScaletable[ch.leftvol >> 3];
  const rscale = sndScaletable[ch.rightvol >> 3];

  for (let i = 0; i < count; i++) {
    const data = sc.data[ch.pos + i];
    const samp = paintbuffer[offset + i];
    samp.left += lscale[data];
    samp.right += rscale[data];
  }

  ch.pos += count;
}

function readSfxInt16LE(buf: Uint8Array, sampleIndex: number): number {
  const byteOffset = sampleIndex * 2;
  const v = buf[byteOffset] | (buf[byteOffset + 1] << 8);
  return (v << 16) >> 16;
}

function sPaintChannelFrom16(ch: ChannelT, sc: SfxcacheT, count: number, offset: number): void {
  const leftvol = ch.leftvol * sndVol;
  const rightvol = ch.rightvol * sndVol;

  for (let i = 0; i < count; i++) {
    const data = readSfxInt16LE(sc.data, ch.pos + i);
    const left = (data * leftvol) >> 8;
    const right = (data * rightvol) >> 8;
    const samp = paintbuffer[offset + i];
    samp.left += left;
    samp.right += right;
  }

  ch.pos += count;
}

export function S_PaintChannels(endtime: number): void {
  sndVol = Math.trunc((sndCvars.s_volume?.value ?? 0) * 256);

  while (paintedtime < endtime) {
    // if paintbuffer is smaller than DMA buffer
    let end = endtime;
    if (endtime - paintedtime > PAINTBUFFER_SIZE) end = paintedtime + PAINTBUFFER_SIZE;

    // start any playsounds
    for (;;) {
      const ps = s_pendingplays.next;
      if (!ps || ps === s_pendingplays) break; // no more pending sounds
      if (ps.begin <= paintedtime) {
        S_IssuePlaysound(ps);
        continue;
      }

      if (ps.begin < end) end = ps.begin; // stop here
      break;
    }

    // clear the paint buffer
    if (s_rawend < paintedtime) {
      for (let i = 0; i < end - paintedtime; i++) {
        paintbuffer[i].left = 0;
        paintbuffer[i].right = 0;
      }
    } else {
      // copy from the streaming sound source
      const stop = end < s_rawend ? end : s_rawend;

      let i = paintedtime;
      for (; i < stop; i++) {
        const s = i & (MAX_RAW_SAMPLES - 1);
        const raw = s_rawsamples[s];
        const samp = paintbuffer[i - paintedtime];
        samp.left = raw.left;
        samp.right = raw.right;
      }
      for (; i < end; i++) {
        paintbuffer[i - paintedtime].left = 0;
        paintbuffer[i - paintedtime].right = 0;
      }
    }

    // paint in the channels.
    for (let ci = 0; ci < MAX_CHANNELS; ci++) {
      const ch = channels[ci];
      let ltime = paintedtime;

      while (ltime < end) {
        if (!ch.sfx || (!ch.leftvol && !ch.rightvol)) break;

        // max painting is to the end of the buffer
        let count = end - ltime;

        // might be stopped by running out of data
        if (ch.end - ltime < count) count = ch.end - ltime;

        const sc = S_LoadSound(ch.sfx);
        if (!sc) break;

        if (count > 0 && ch.sfx) {
          if (sc.width === 1) sPaintChannelFrom8(ch, sc, count, ltime - paintedtime);
          else sPaintChannelFrom16(ch, sc, count, ltime - paintedtime);

          ltime += count;
        }

        // if at end of loop, restart
        if (ltime >= ch.end) {
          if (ch.autosound) {
            // autolooping sounds always go back to start
            ch.pos = 0;
            ch.end = ltime + sc.length;
          } else if (sc.loopstart >= 0) {
            ch.pos = sc.loopstart;
            ch.end = ltime + sc.length - ch.pos;
          } else {
            // channel just stopped
            ch.sfx = null;
          }
        }
      }
    }

    // Environmental reverb (see snd_environments.ts/snd_reverb_dsp.ts):
    // applied before the underwater filter below, over the same buffer span,
    // so a submerged listener's reverb tail is muffled by the underwater
    // filter exactly like everything else already painted into the buffer
    // -- there is no q2repro reference ordering to match here (al.c's OpenAL
    // reverb and dma.c's underwater biquad are two different backends that
    // never coexist upstream; see snd_reverb_dsp.ts's header comment), so
    // this ordering is this port's own choice, not a divergence from a real
    // original.
    const reverbParams = GetActiveReverbParams();
    if (reverbParams) {
      const count = end - paintedtime;
      for (let i = 0; i < count; i++) {
        reverbScratchL[i] = paintbuffer[i].left;
        reverbScratchR[i] = paintbuffer[i].right;
      }
      S_ReverbProcessBlock(reverbParams, dma.speed, reverbScratchL, reverbScratchR, count);
      for (let i = 0; i < count; i++) {
        paintbuffer[i].left = reverbScratchL[i];
        paintbuffer[i].right = reverbScratchR[i];
      }
    }

    // q2repro dma.c:430,491-492: the underwater filter runs after channels
    // are painted but BEFORE raw/streaming samples (cinematics, voice-over-
    // network) are mixed in, so upstream never filters that source. This
    // port's S_PaintChannels copies raw samples into the paint buffer
    // FIRST (top of this loop, before the channel-painting loop above) and
    // channels are added on top of the same buffer, so by this point the
    // two sources already share the same indices with no clean way to
    // filter one but not the other -- a pre-existing structural difference
    // in mixing order, not something introduced by this fix. Filtering the
    // whole buffer here (divergence-audit finding #12) is the faithful-in-
    // spirit adaptation: it engages the same OpenAL-Soft biquad on the same
    // condition (S_IsUnderWater), just over a couple more sample sources
    // than upstream's own raw/channel split would.
    if (S_IsUnderWater()) sUnderwaterFilter(end - paintedtime);

    // transfer out according to DMA format
    sTransferPaintBuffer(end);
    setPaintedtime(end);
  }
}

export function S_InitScaletable(): void {
  if (sndCvars.s_volume) sndCvars.s_volume.modified = false;

  const volume = sndCvars.s_volume?.value ?? 0;
  for (let i = 0; i < 32; i++) {
    const scale = Math.trunc(i * 8 * 256 * volume);
    const row = sndScaletable[i];
    for (let j = 0; j < 256; j++) {
      const sj = j > 127 ? j - 256 : j;
      row[j] = (sj * scale) | 0;
    }
  }
}
