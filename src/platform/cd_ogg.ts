/*
CD audio backend over Ogg Vorbis track files -- the bun equivalent of
linux/cd_linux.c. The C backend ioctl()s a physical CD drive; no such
device exists here, so the same six-entry cdaudio.h interface plays
`music/NN.ogg` rips instead (the long-standing community convention for
CD-less Quake 2 installs), decoded via the system libvorbisfile through
bun:ffi and streamed into the engine mixer's raw-sample ring -- the same
path cinematic soundtracks take, so music mixes with game audio and obeys
the engine's pacing. cd_nocd (the cvar the options menu's "CD music"
toggle drives) disables it, matching the C.

src/null/cd_null.ts remains the silent backend for builds/hosts without
libvorbisfile: this module degrades to exactly cd_null behaviour when the
library cannot be loaded.
*/

import { dlopen, ptr, read as ffiRead, type Library, type Pointer } from "bun:ffi";
import { Com_DPrintf, Com_Printf } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import { FS_Gamedir } from "../qcommon/files";
import { S_RawSamples } from "../client/snd_dma";
import { dma, paintedtime, s_rawend } from "../client/snd_loc";
import { CVAR_ARCHIVE, type CvarT } from "../shared/q_shared";

const vorbisSymbols = {
  ov_fopen: { args: ["cstring", "ptr"], returns: "i32" },
  ov_read: { args: ["ptr", "ptr", "i32", "i32", "i32", "i32", "ptr"], returns: "i64" },
  ov_info: { args: ["ptr", "i32"], returns: "ptr" },
  ov_clear: { args: ["ptr"], returns: "i32" },
  ov_pcm_seek: { args: ["ptr", "i64"], returns: "i32" },
} as const;

type VorbisLib = Library<typeof vorbisSymbols>;

let vorbis: VorbisLib | null = null;
let vorbisTried = false;

function lib(): VorbisLib | null {
  if (vorbisTried) return vorbis;
  vorbisTried = true;
  const names =
    process.platform === "win32"
      ? ["libvorbisfile-3.dll", "vorbisfile.dll", "libvorbisfile.dll"]
      : process.platform === "darwin"
        ? ["libvorbisfile.3.dylib", "libvorbisfile.dylib"]
        : ["libvorbisfile.so.3", "libvorbisfile.so"];
  for (const name of names) {
    try {
      vorbis = dlopen(name, vorbisSymbols);
      return vorbis;
    } catch {
      // try the next name
    }
  }
  Com_DPrintf("cd_ogg: libvorbisfile not available; CD audio is silent (cd_null behaviour)\n");
  return null;
}

// OggVorbis_File is ~944 bytes on x86-64; over-allocate for safety. The
// struct is opaque to us -- only libvorbisfile reads it.
const OV_FILE_SIZE = 2048;

function cstr(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

let cd_nocd: CvarT | null = null;

let vf: Uint8Array | null = null; // live OggVorbis_File storage
let trackRate = 0;
let trackChannels = 0;
let looping = false;
let currentTrack = 0;

const bitstream = new Int32Array(1);
const decodeBuf = new Uint8Array(8192);

// feed until this much audio (in output sample frames) is buffered ahead of
// the mixer -- a quarter second, comfortably past s_mixahead
function feedTarget(): number {
  return (dma.speed / 4) | 0;
}

function closeTrack(): void {
  const l = lib();
  if (l && vf) l.symbols.ov_clear(ptr(vf));
  vf = null;
  currentTrack = 0;
}

// cvar-parity audit fix: previously inlined into CDAudio_Play only, after
// its `if (!l) return` library-availability check -- so on a host without
// libvorbisfile even "cd_nocd" itself would report "unknown command"
// instead of just being inert, and CDAudio_Init (below) sets cd_nocd
// directly, which meant CDAudio_Play's own `if (!cd_nocd)` guard never even
// ran when Init had already been called (the normal boot order). Pulled out
// into its own function, called from both entry points, unconditional.
function registerCdCvars(): void {
  if (cd_nocd) return;
  cd_nocd = Cvar_Get("cd_nocd", "0", 0);
  // q2repro src/client/sound/ogg.c:810-817 replaced this CD-audio-over-OGG
  // model (cd_nocd, this file's own header comment) with a dedicated music
  // jukebox (ogg_enable/ogg_volume/ogg_shuffle/ogg_menu_track/
  // ogg_remap_tracks) with its own playlist/shuffle/remap logic layered on
  // the sound engine. This port never adopted that jukebox -- registered
  // here, consumer unported, so setting them no longer reports "unknown
  // command" but they don't affect this file's simpler CD-audio replacement
  // (which cd_nocd alone still gates, unchanged).
  Cvar_Get("ogg_enable", "1", CVAR_ARCHIVE);
  Cvar_Get("ogg_volume", "1", CVAR_ARCHIVE);
  Cvar_Get("ogg_shuffle", "0", CVAR_ARCHIVE);
  Cvar_Get("ogg_menu_track", "77", CVAR_ARCHIVE);
  Cvar_Get("ogg_remap_tracks", "1", CVAR_ARCHIVE);
}

export function CDAudio_Play(track: number, loop: boolean): void {
  registerCdCvars();
  if (cd_nocd && cd_nocd.value) return;

  const l = lib();
  if (!l) return;

  if (currentTrack === track && vf) {
    looping = loop;
    return;
  }
  closeTrack();

  if (track <= 0) return; // track 0/1 = data track / silence, like the CD

  const pad = track < 10 ? `0${track}` : `${track}`;
  const candidates = [`${FS_Gamedir()}/music/${pad}.ogg`, `${FS_Gamedir()}/music/track${pad}.ogg`];

  const storage = new Uint8Array(OV_FILE_SIZE);
  let opened = false;
  for (const path of candidates) {
    if (l.symbols.ov_fopen(cstr(path), ptr(storage)) === 0) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    Com_DPrintf(`cd_ogg: no music file for track ${track}\n`);
    return;
  }

  const info = l.symbols.ov_info(ptr(storage), -1);
  // bun:ffi ptr returns can be bigint for high addresses; vorbis_info lives
  // in normal heap on every platform bun targets, narrowed like qglGetString
  if (info === null || typeof info === "bigint") {
    l.symbols.ov_clear(ptr(storage));
    return;
  }
  // vorbis_info: int version; int channels; long rate; (LP64: rate at +8)
  trackChannels = readI32(info, 4);
  trackRate = Number(readI64(info, 8));
  if (trackChannels < 1 || trackChannels > 2 || trackRate <= 0) {
    l.symbols.ov_clear(ptr(storage));
    Com_Printf(`cd_ogg: unsupported format for track ${track} (${trackChannels}ch @ ${trackRate})\n`);
    return;
  }

  vf = storage;
  looping = loop;
  currentTrack = track;
}

function readI32(p: Pointer, off: number): number {
  return ffiRead.i32(p, off);
}
function readI64(p: Pointer, off: number): bigint {
  return ffiRead.i64(p, off);
}

export function CDAudio_Stop(): void {
  closeTrack();
}

export function CDAudio_Resume(): void {
  // the CD backend resumes the paused drive; the stream just keeps feeding
}

export function CDAudio_Update(): void {
  const l = lib();
  if (!l || !vf) return;
  if (cd_nocd && cd_nocd.value) {
    closeTrack();
    return;
  }
  if (!dma.speed) return;

  // keep the raw ring feedTarget() output frames ahead of the mixer
  while (s_rawend - paintedtime < feedTarget()) {
    const n = Number(l.symbols.ov_read(ptr(vf), ptr(decodeBuf), decodeBuf.length, 0, 2, 1, ptr(bitstream)));
    if (n > 0) {
      const frames = (n / (2 * trackChannels)) | 0;
      S_RawSamples(frames, trackRate, 2, trackChannels, decodeBuf.subarray(0, n));
      continue;
    }
    if (n === 0) {
      // end of track
      if (looping && l.symbols.ov_pcm_seek(ptr(vf), 0n) === 0) continue;
      closeTrack();
      return;
    }
    // decode error (OV_HOLE etc): skip and keep going, like every player does
    if (n === -3) continue; // OV_HOLE
    Com_DPrintf(`cd_ogg: decode error ${n} on track ${currentTrack}\n`);
    closeTrack();
    return;
  }
}

export function CDAudio_Init(): number {
  registerCdCvars();
  return lib() ? 0 : -1; // C: 0 = ok; init failure leaves the null behaviour
}

export function CDAudio_Shutdown(): void {
  closeTrack();
}
