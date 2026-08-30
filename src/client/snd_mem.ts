// snd_mem.c: sound caching. ResampleSfx/GetLittleShort/GetLittleLong/
// FindNextChunk/FindChunk are internal to snd_mem.c (file-static in C) and
// are kept as module-private state/functions here, not exported. DumpChunks
// is dead code in the original (declared, never called even with its one
// call site commented out) -- dropped, matching this codebase's precedent
// for stale/unreachable helpers (sound.ts's S_Activate).

import { Com_DPrintf, Com_Printf, Com_Error } from "../qcommon/common";
import { FS_LoadFile, FS_FreeFile } from "../qcommon/files";
import { Com_sprintf, ERR_DROP } from "../shared/q_shared";
import { dma, sndCvars, type SfxT, SfxcacheT, WavinfoT } from "./snd_loc";

// C reads a little-endian 16-bit sample out of a raw byte buffer via a
// `(short *)` cast, which sign-extends on dereference; LittleShort() itself
// is an identity no-op on this always-little-endian host (see q_shared.ts),
// so the sign-extension has to happen explicitly here instead.
function readInt16LE(buf: Uint8Array, byteOffset: number): number {
  const v = buf[byteOffset]! | (buf[byteOffset + 1]! << 8);
  return (v << 16) >> 16;
}

/*
================
ResampleSfx
================
*/
export function ResampleSfx(sfx: SfxT, inrate: number, inwidth: number, data: Uint8Array): void {
  const sc = sfx.cache;
  if (!sc) return;

  const stepscale = inrate / dma.speed; // this is usually 0.5, 1, or 2

  const outcount = Math.trunc(sc.length / stepscale);
  sc.length = outcount;
  if (sc.loopstart !== -1) sc.loopstart = Math.trunc(sc.loopstart / stepscale);

  sc.speed = dma.speed;
  sc.width = sndCvars.s_loadas8bit?.value ? 1 : inwidth;
  sc.stereo = 0;

  // resample / decimate to the current source rate
  if (stepscale === 1 && inwidth === 1 && sc.width === 1) {
    // fast special case
    for (let i = 0; i < outcount; i++) {
      sc.data[i] = (data[i]! - 128) & 0xff;
    }
  } else {
    // general case
    let samplefrac = 0;
    const fracstep = Math.trunc(stepscale * 256);
    for (let i = 0; i < outcount; i++) {
      const srcsample = samplefrac >> 8;
      samplefrac = (samplefrac + fracstep) | 0;
      let sample: number;
      if (inwidth === 2) {
        sample = readInt16LE(data, srcsample * 2);
      } else {
        sample = (data[srcsample]! - 128) << 8;
      }
      if (sc.width === 2) {
        sc.data[i * 2] = sample & 0xff;
        sc.data[i * 2 + 1] = (sample >> 8) & 0xff;
      } else {
        sc.data[i] = (sample >> 8) & 0xff;
      }
    }
  }
}

//=============================================================================

/*
==============
S_LoadSound
==============
*/
export function S_LoadSound(s: SfxT): SfxcacheT | null {
  if (s.name[0] === "*") return null;

  // see if still in memory
  let sc = s.cache;
  if (sc) return sc;

  // load it in
  const name = s.truename ?? s.name;

  const namebuffer = name[0] === "#" ? name.slice(1) : Com_sprintf("sound/%s", name);

  const data = FS_LoadFile(namebuffer);
  if (!data) {
    Com_DPrintf("Couldn't load %s\n", namebuffer);
    return null;
  }

  const info = GetWavinfo(s.name, data, data.length);
  if (info.channels !== 1) {
    Com_Printf("%s is a stereo sample\n", s.name);
    FS_FreeFile(data);
    return null;
  }

  const stepscale = info.rate / dma.speed;
  let len = Math.trunc(info.samples / stepscale);
  len = len * info.width * info.channels;

  sc = new SfxcacheT();
  sc.data = new Uint8Array(len);
  s.cache = sc;

  sc.length = info.samples;
  sc.loopstart = info.loopstart;
  sc.speed = info.rate;
  sc.width = info.width;
  sc.stereo = info.channels;

  ResampleSfx(s, sc.speed, sc.width, data.subarray(info.dataofs));

  FS_FreeFile(data);

  return sc;
}

/*
===============================================================================

WAV loading

===============================================================================
*/

// file-private "pointer" state, mirroring snd_mem.c's own file-static
// globals (data_p/iff_end/last_chunk/iff_data/iff_chunk_len). All offsets
// are indices into `wavBuf`, standing in for C's raw byte pointers.
let wavBuf: Uint8Array = new Uint8Array(0);
let iffEnd = 0;
let iffDataOfs = 0;
let lastChunk = 0;
let dataP = -1; // -1 == NULL
let iffChunkLen = 0;

function matchTag(offset: number, tag: string): boolean {
  if (offset < 0) return false;
  for (let i = 0; i < 4; i++) {
    if (wavBuf[offset + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

function getLittleShort(): number {
  const val = readInt16LE(wavBuf, dataP);
  dataP += 2;
  return val;
}

function getLittleLong(): number {
  const b0 = wavBuf[dataP]!;
  const b1 = wavBuf[dataP + 1]!;
  const b2 = wavBuf[dataP + 2]!;
  const b3 = wavBuf[dataP + 3]!;
  const val = (b0 + (b1 << 8) + (b2 << 16) + (b3 << 24)) | 0;
  dataP += 4;
  return val;
}

function findNextChunk(name: string): void {
  for (;;) {
    dataP = lastChunk;

    if (dataP >= iffEnd) {
      // didn't find the chunk
      dataP = -1;
      return;
    }

    dataP += 4;
    iffChunkLen = getLittleLong();
    if (iffChunkLen < 0) {
      dataP = -1;
      return;
    }
    dataP -= 8;
    lastChunk = dataP + 8 + ((iffChunkLen + 1) & ~1);
    if (matchTag(dataP, name)) return;
  }
}

function findChunk(name: string): void {
  lastChunk = iffDataOfs;
  findNextChunk(name);
}

/*
============
GetWavinfo
============
*/
export function GetWavinfo(name: string, wav: Uint8Array, wavlength: number): WavinfoT {
  const info = new WavinfoT();

  wavBuf = wav;
  iffEnd = wavlength;
  iffDataOfs = 0;
  lastChunk = 0;
  dataP = -1;

  // find "RIFF" chunk
  findChunk("RIFF");
  if (!(dataP >= 0 && matchTag(dataP + 8, "WAVE"))) {
    Com_Printf("Missing RIFF/WAVE chunks\n");
    return info;
  }

  // get "fmt " chunk
  iffDataOfs = dataP + 12;

  findChunk("fmt ");
  if (dataP < 0) {
    Com_Printf("Missing fmt chunk\n");
    return info;
  }
  dataP += 8;
  const format = getLittleShort();
  if (format !== 1) {
    Com_Printf("Microsoft PCM format only\n");
    return info;
  }

  info.channels = getLittleShort();
  info.rate = getLittleLong();
  dataP += 4 + 2;
  info.width = Math.trunc(getLittleShort() / 8);

  // get cue chunk
  findChunk("cue ");
  if (dataP >= 0) {
    dataP += 32;
    info.loopstart = getLittleLong();

    // if the next chunk is a LIST chunk, look for a cue length marker
    findNextChunk("LIST");
    if (dataP >= 0) {
      if (matchTag(dataP + 28, "mark")) {
        // this is not a proper parse, but it works with cooledit...
        dataP += 24;
        const i = getLittleLong(); // samples in loop
        info.samples = info.loopstart + i;
      }
    }
  } else {
    info.loopstart = -1;
  }

  // find data chunk
  findChunk("data");
  if (dataP < 0) {
    Com_Printf("Missing data chunk\n");
    return info;
  }

  dataP += 4;
  const samples = Math.trunc(getLittleLong() / info.width);

  if (info.samples) {
    if (samples < info.samples) Com_Error(ERR_DROP, "Sound %s has a bad loop length", name);
  } else {
    info.samples = samples;
  }

  info.dataofs = dataP;

  return info;
}
