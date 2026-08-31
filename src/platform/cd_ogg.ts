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
import { FS_Gamedir, FS_NextPath } from "../qcommon/files";
import { S_RawSamples } from "../client/snd_dma";
import { dma, paintedtime, s_rawend } from "../client/snd_loc";
import { cl } from "../client/client";
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
let ogg_remap_tracks: CvarT | null = null;

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
  // the sound engine. This port never adopted that jukebox wholesale, but
  // ogg_remap_tracks IS consumed below (remapTrack, ogg.c:192-205) since
  // CDAudio_Play already has a track number in hand to remap -- see that
  // function's own citation. ogg_enable/ogg_volume/ogg_shuffle/
  // ogg_menu_track remain unconsumed: shuffle needs the full trackmap/
  // playlist machinery (OGG_Play's `ogg_shuffle->integer && trackcount`
  // branch, ogg.c:270-278) this file doesn't have, and ogg_menu_track needs
  // a disconnected-state call site (cl_view.ts/cl_main.ts, out of this
  // unit's territory -- see this file's report) that doesn't exist yet.
  Cvar_Get("ogg_enable", "1", CVAR_ARCHIVE);
  Cvar_Get("ogg_volume", "1", CVAR_ARCHIVE);
  Cvar_Get("ogg_shuffle", "0", CVAR_ARCHIVE);
  Cvar_Get("ogg_menu_track", "77", CVAR_ARCHIVE);
  ogg_remap_tracks = Cvar_Get("ogg_remap_tracks", "1", CVAR_ARCHIVE);
}

// q2repro ogg.c:192-205's remap_track: the xatrix/rogue mission packs'
// original CD soundtracks (tracks 2-11) aren't part of the remaster's
// shared baseq2 music set, so the remaster ships their music as extra
// baseq2 tracks instead -- rogue's CD tracks 2-11 land at baseq2 track12-21
// (a flat +10 shift), xatrix's land at the non-contiguous subset in the
// lookup table below (ogg.c:199, copied verbatim). `cl.gamedir` (set from
// svc_serverdata in CL_ParseServerData, cl_parse.ts:530) mirrors q2repro's
// own `cl.gamedir` comparison exactly. Gated on ogg_remap_tracks (default
// "1", matching ogg.c:817's own default) so `ogg_remap_tracks 0` reproduces
// the un-remapped (wrong-song) behavior for anyone who wants it.
const XATRIX_TRACK_REMAP: readonly number[] = [9, 13, 14, 7, 16, 2, 15, 3, 4, 18];

function remapTrack(track: number): number {
  if (!ogg_remap_tracks || !ogg_remap_tracks.value) return track;
  if (track < 2 || track > 11) return track;

  const gamedir = cl.gamedir.toLowerCase();
  if (gamedir === "rogue") return track + 10;
  if (gamedir === "xatrix") return XATRIX_TRACK_REMAP[track - 2]!;
  return track;
}

// q2repro ogg.c:630-657's OGG_LoadTrackList builds its track map from EVERY
// filesystem search path's music/ dir (FS_NextPath, plus base/home dir),
// not just the active gamedir -- otherwise a mod with no music/ of its own
// (or an xatrix/rogue install whose remapped baseq2 track lives one level
// up) gets silence even though the file exists on disk. FS_NextPath's own
// walk already starts at fs_gamedir and continues through every other
// registered game directory (files.ts's own doc comment on that function),
// so this reproduces the same effective search order without this file
// needing its own copy of the search-path list. Extracted to its own pure
// function (no FFI) so the search-path/remap logic is directly unit
// testable without needing a real Vorbis file on disk -- see
// test/cd_ogg.test.ts.
function buildTrackCandidates(track: number): string[] {
  const remapped = remapTrack(track);
  const pad = remapped < 10 ? `0${remapped}` : `${remapped}`;
  const candidates: string[] = [];
  for (let dir = FS_NextPath(null); dir !== null; dir = FS_NextPath(dir)) {
    candidates.push(`${dir}/music/${pad}.ogg`);
    candidates.push(`${dir}/music/track${pad}.ogg`);
  }
  // FS_Gamedir() fallback kept last in case FS_NextPath ever returns an
  // empty walk (e.g. filesystem not yet initialized) -- matches this
  // function's pre-fix-only lookup, so behavior never regresses to fewer
  // candidates than before.
  candidates.push(`${FS_Gamedir()}/music/${pad}.ogg`, `${FS_Gamedir()}/music/track${pad}.ogg`);
  return candidates;
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

  const candidates = buildTrackCandidates(track);

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

// TEST SEAM (not part of the C engine): `cd_nocd` above is module-private,
// process-wide state used as a "have I already registered cd_nocd/ogg_*"
// latch (registerCdCvars' own `if (cd_nocd) return`) -- correct for a real
// one-boot-per-process engine, but in a multi-boot-per-process test run a
// test whose own cvar-registry snapshot/restore (see test/support/
// cvar_snapshot.ts) deletes cd_nocd/ogg_* from src/qcommon/cvar.ts's
// cvar_vars leaves this module's own cached `cd_nocd` reference pointing
// at an object no longer in the registry -- registerCdCvars' latch still
// reads it as "already done" and skips re-registering ogg_* into the
// now-empty registry. test/cvar_parity.test.ts calls this directly before
// its own CDAudio_Play(0, false) so that call actually re-registers,
// regardless of what any earlier test in the process did.
export function CDAudio_TestResetRegistration(): void {
  cd_nocd = null;
}

// TEST SEAMs (not part of the C engine): expose the pure track-remap and
// candidate-path-building logic directly so test/cd_ogg.test.ts can verify
// the xatrix/rogue remap table and the cross-searchpath music/ lookup
// without needing a real Vorbis file on disk or a loaded libvorbisfile.
export function CDAudio_TestRemapTrack(track: number): number {
  return remapTrack(track);
}
export function CDAudio_TestBuildTrackCandidates(track: number): string[] {
  return buildTrackCandidates(track);
}

export function CDAudio_Shutdown(): void {
  closeTrack();
}
