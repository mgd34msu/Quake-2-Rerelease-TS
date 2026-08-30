// One portable implementation of snd_loc.h's "SYSTEM SPECIFIC FUNCTIONS"
// (SNDDMA_Init/SNDDMA_GetDMAPos/SNDDMA_Shutdown/SNDDMA_BeginPainting/
// SNDDMA_Submit), matching PORTING.md's platform mapping: the linux/win32/
// irix per-OS backends are alternative implementations of this same
// interface and are not transliterated file-by-file.
//
// Two drivers live behind that interface here:
//
// - SDL (sdl.ts), when the client path armed the backend and the system
//   library opened. `dma.buffer` stays the ring buffer snd_mix.ts's
//   S_PaintChannels/S_TransferPaintBuffer write PCM into, exactly as
//   DirectSound's secondary buffer is in win32/snd_win.c; SNDDMA_Submit
//   pushes the newly painted span into SDL's audio queue, and
//   SNDDMA_GetDMAPos reports how much of everything ever pushed the device
//   has actually consumed, which is what DirectSound's play cursor
//   (IDirectSoundBuffer_GetCurrentPosition in SNDDMA_GetDMAPos) reports
//   there. No SDL audio callback is installed, so nothing in the mixer runs
//   off the main thread.
//
// - A NULL driver, when there is no SDL device (dedicated server, missing
//   library, no audio device). Nothing is audible; SNDDMA_GetDMAPos reports
//   a simulated "playback" position that advances with wall-clock time (as
//   if a device were draining the ring at `dma.speed` samples/sec) so the
//   mixer's mix-ahead pacing (S_Update_'s GetSoundtime/endtime math in
//   snd_dma.ts) behaves the same as it would against real hardware.
//
// Field values are modeled on win32/snd_win.c's SNDDMA_InitWav (the most
// fully-specified backend, and the one that reads the `s_khz` cvar
// directly) rather than any single literal port: dma.channels=2,
// dma.samplebits=16, and dma.speed selected from `s_khz` (44/22/other ->
// 44100/22050/11025). Unlike win32's SNDDMA_InitWav (which has a real bug:
// its second `if (s_khz->value == 22)` is followed by an unconditional
// `else dma.speed = 11025`, so s_khz==44 is silently overridden back to
// 11025), this implementation picks the rate correctly -- this file has no
// single C original to be bug-for-bug faithful to (PORTING.md: the per-OS
// dirs are "not transliterated"), so the bug is not reproduced.

import { Cvar_VariableValue } from "../qcommon/cvar";
import { dma, paintedtime } from "../client/snd_loc";
import { SDLSND_Active, SDLSND_Close, SDLSND_ConsumedBytes, SDLSND_Open, SDLSND_Queue } from "./sdl";

// 0x10000 bytes, the same fixed ring size DirectSound's secondary buffer
// used in win32/snd_win.c (SECONDARY_BUFFER_SIZE). At samplebits=16 that's
// 32768 interleaved samples -- a power of two, required by snd_mix.ts's
// `dma.samples - 1` / `(dma.samples>>1) - 1` ring masks.
const RING_BUFFER_BYTES = 0x10000;

let initialized = false;
let startTimeMs = 0;
let usingSdl = false;
// paintedtime (in sample frames) of everything already handed to the device
let submitted = 0;

function pickSpeed(): number {
  const khz = Cvar_VariableValue("s_khz");
  if (khz === 44) return 44100;
  if (khz === 22) return 22050;
  return 11025;
}

export function SNDDMA_Init(): boolean {
  submitted = 0; // fresh device, fresh queue: nothing has been handed over yet
  dma.channels = 2;
  dma.samplebits = 16;
  dma.speed = pickSpeed();

  const obtained = SDLSND_Open(dma.speed, dma.channels, dma.samplebits);
  usingSdl = obtained !== null;
  if (obtained) {
    dma.speed = obtained.freq;
    dma.channels = obtained.channels;
  }

  dma.samples = RING_BUFFER_BYTES / (dma.samplebits / 8);
  dma.submission_chunk = 1;
  dma.buffer = new Uint8Array(RING_BUFFER_BYTES);
  dma.samplepos = 0;

  submitted = 0;
  startTimeMs = performance.now();
  initialized = true;

  return true;
}

function bytesPerFrame(): number {
  return dma.channels * (dma.samplebits / 8);
}

export function SNDDMA_GetDMAPos(): number {
  if (!initialized) return 0;

  if (usingSdl && SDLSND_Active()) {
    const framesPlayed = Math.floor(SDLSND_ConsumedBytes() / bytesPerFrame());
    dma.samplepos = (framesPlayed * dma.channels) % dma.samples;
    return dma.samplepos;
  }

  const elapsedSec = (performance.now() - startTimeMs) / 1000;
  const framesPlayed = Math.floor(elapsedSec * dma.speed);
  const totalSamplesPlayed = framesPlayed * dma.channels;

  dma.samplepos = totalSamplesPlayed % dma.samples;
  return dma.samplepos;
}

export function SNDDMA_Shutdown(): void {
  initialized = false;
  usingSdl = false;
  submitted = 0;
  SDLSND_Close();
  dma.buffer = new Uint8Array(0);
}

export function SNDDMA_BeginPainting(): void {
  // no locking needed: dma.buffer is a plain in-memory array, not a
  // hardware-shared buffer that has to be locked before writes (the
  // IDirectSoundBuffer_Lock in win32/snd_win.c).
}

/*
Hand the span the mixer just painted (`submitted` .. paintedtime, in sample
frames) to the device. win32/snd_win.c's SNDDMA_Submit only has to unlock
the DirectSound buffer because the hardware reads the same memory; a queue
device has to be given the bytes, so the ring is read back out here.
*/
export function SNDDMA_Submit(): void {
  if (!initialized || !usingSdl || !SDLSND_Active()) return;

  const frameBytes = bytesPerFrame();
  const totalFrames = dma.samples / dma.channels;

  // paintedtime went backwards (S_Init/S_StopAllSounds reset it), or the
  // gap exceeds one ring (snd_restart resynced paintedtime to a device
  // position the old cursor never saw): resync and send NOTHING stale. A
  // queue device cannot "catch up" -- ring content older than the current
  // paint pass is garbage, and pushing it pinned a permanent ring's worth
  // (~1.5s) of latency onto every subsequent sound.
  if (paintedtime < submitted) submitted = paintedtime;
  if (paintedtime - submitted > totalFrames) submitted = paintedtime;

  let frames = paintedtime - submitted;
  if (frames <= 0) return;

  let offset = ((submitted * dma.channels) & (dma.samples - 1)) * (dma.samplebits / 8);
  while (frames > 0) {
    const framesToEnd = Math.min(frames, (RING_BUFFER_BYTES - offset) / frameBytes);
    const length = framesToEnd * frameBytes;
    SDLSND_Queue(dma.buffer.subarray(offset, offset + length));
    frames -= framesToEnd;
    offset = 0;
  }

  submitted = paintedtime;
}
