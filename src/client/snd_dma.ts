// snd_dma.c -- main control for any streaming sound output device.
//
// S_SoundInfo_f/S_SpatializeOrigin/S_FreePlaysound/S_ClearBuffer/
// S_AddLoopSounds/GetSoundtime/S_Update_/S_Play/S_SoundList/
// S_RegisterSexedSound/S_AliasName/S_AllocPlaysound are internal to
// snd_dma.c (file-static or forward-declared-only in the C source, never
// in snd_loc.h) and stay unexported here, matching this unit's original
// stub banner. SNDDMA_Init/SNDDMA_GetDMAPos/SNDDMA_Shutdown/
// SNDDMA_BeginPainting/SNDDMA_Submit are platform-owned (src/platform/snd.ts).
//
// snd_dma.c's own file-static globals (s_registration_sequence, known_sfx,
// num_sfx, sound_started, s_playsounds, s_freeplays, s_beginofs,
// s_registering, soundtime) are none of them declared in snd_loc.h, so they
// stay module-private `let`/`const` state here rather than living in
// snd_loc.ts (PORTING.md's header-module convention is for globals shared
// across files, not a file's own statics).

import { Com_DPrintf, Com_Error, Com_Printf } from "../qcommon/common";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cmd_RemoveCommand } from "../qcommon/cmd";
import { Cvar_Get } from "../qcommon/cvar";
import { FS_FCloseFile, FS_FOpenFile } from "../qcommon/files";
import { type Vec3, vec3, DotProduct, VectorCopy, VectorNormalize, VectorSubtract } from "../shared/math";
import { ATTN_STATIC, CVAR_ARCHIVE, CVAR_SOUND, Com_PageInMemory, Com_sprintf, ERR_DROP, ERR_FATAL, RDF_UNDERWATER, type EntityStateT } from "../shared/q_shared";
import { Haptics_TriggerSound } from "../platform/haptics";
import { cl, cl_entities, cl_parse_entities, clCvars, cls, ConnstateT, MAX_PARSE_ENTITIES } from "./client";
import { MAX_SOUNDS_WIDE } from "../shared/cs_remap";
import { CL_GetEntitySoundOrigin } from "./cl_ents";
import {
  ChannelT,
  PlaysoundT,
  SfxT,
  SFX_NAME_MAX_LEN,
  channels,
  dma,
  listener_forward,
  listener_origin,
  listener_right,
  listener_up,
  MAX_CHANNELS,
  MAX_RAW_SAMPLES,
  paintedtime,
  s_pendingplays,
  s_rawend,
  s_rawsamples,
  setPaintedtime,
  setSRawend,
  sndCvars,
} from "./snd_loc";
import { S_LoadSound } from "./snd_mem";
import { S_InitScaletable, S_PaintChannels } from "./snd_mix";
import { SNDDMA_BeginPainting, SNDDMA_GetDMAPos, SNDDMA_Init, SNDDMA_Shutdown, SNDDMA_Submit } from "../platform/snd";
import { S_ReverbInit, S_ReverbEndRegistration, S_ReverbShutdown, S_UpdateReverb } from "./snd_environments";
import { S_ReverbDspReset } from "./snd_reverb_dsp";

// only begin attenuating sound volumes when outside the FULLVOLUME range
const SOUND_FULLVOLUME = 80;
const SOUND_LOOPATTENUATE = 0.003;

let soundStarted = false;

// during registration it is possible to have more sounds than could
// actually be referenced during gameplay, because we don't want to free
// anything until we are sure we won't need it.
// q2repro sound/main.c:50 `#define MAX_SFX (MAX_SOUNDS*2)` -- MAX_SOUNDS there is
// ALWAYS the wide 2048 constant, unconditionally (this internal sfx_t registry
// is not protocol-family aware at all, unlike client.ts's networked
// cl.sound_precache[] array, which IS indexed by the wire sound number and is
// separately sized off MAX_SOUNDS_WIDE there). Previously hardcoded to the
// classic-only 256*2=512; widened here to match, since a kex-family session
// can legitimately register more than 512 total distinct sound assets across
// its lifetime (unlike the network index cap, this is a monotonically
// growing "every sound ever loaded this session" table, gated by
// s_registration_sequence, not per-frame).
const MAX_SFX = MAX_SOUNDS_WIDE * 2;
let known_sfx: SfxT[] = Array.from({ length: MAX_SFX }, () => new SfxT());
let num_sfx = 0;

let s_registration_sequence = 0;
let s_registering = false;

let soundtime = 0; // sample PAIRS

const MAX_PLAYSOUNDS = 128;
let s_playsounds: PlaysoundT[] = Array.from({ length: MAX_PLAYSOUNDS }, () => new PlaysoundT());
const s_freeplays: PlaysoundT = new PlaysoundT();

let s_beginofs = 0;

function readInt16LE(buf: Uint8Array, byteOffset: number): number {
  const v = buf[byteOffset] | (buf[byteOffset + 1] << 8);
  return (v << 16) >> 16;
}

function toSignedByte(b: number): number {
  return b > 127 ? b - 256 : b;
}

function S_SoundInfo_f(): void {
  if (!soundStarted) {
    Com_Printf("sound system not started\n");
    return;
  }

  Com_Printf("%5d stereo\n", dma.channels - 1);
  Com_Printf("%5d samples\n", dma.samples);
  Com_Printf("%5d samplepos\n", dma.samplepos);
  Com_Printf("%5d samplebits\n", dma.samplebits);
  Com_Printf("%5d submission_chunk\n", dma.submission_chunk);
  Com_Printf("%5d speed\n", dma.speed);
  // C prints the raw dma.buffer pointer ("0x%x dma buffer"); there is no
  // pointer to print here, so the buffer's byte length is printed instead
  // as the closest useful diagnostic. Reported deviation.
  Com_Printf("%i dma buffer bytes\n", dma.buffer.length);
}

/*
================
S_Init
================
*/
export function S_Init(): void {
  Com_Printf("\n------- sound initialization -------\n");

  const cv = Cvar_Get("s_initsound", "1", 0);
  if (!cv || !cv.value) {
    Com_Printf("not initializing.\n");
  } else {
    sndCvars.s_volume = Cvar_Get("s_volume", "0.7", CVAR_ARCHIVE);
    // q2repro src/client/sound/dma.c:560 defaults s_khz to "44", not "11"
    // (cvar-parity fix); src/platform/snd.ts's rate-selection logic already
    // handles 44/22/other correctly.
    sndCvars.s_khz = Cvar_Get("s_khz", "44", CVAR_ARCHIVE | CVAR_SOUND); // dma.c:560 also flags CVAR_SOUND
    // divergence-audit finding #14: q2repro's DMA_UploadSfx (dma.c:54-88)
    // has no s_loadas8bit concept at all -- every sample keeps its native
    // width. This port keeps the cvar (menu.ts's sound-quality option and
    // snd_mem.ts's loader both still read it -- removing it outright is a
    // menu.ts change, out of this unit's territory) but flips its default
    // off so a fresh install matches the rerelease's out-of-the-box
    // fidelity instead of vanilla's forced 8-bit crunch.
    sndCvars.s_loadas8bit = Cvar_Get("s_loadas8bit", "0", CVAR_ARCHIVE);
    // q2repro src/client/sound/dma.c:561 defaults s_mixahead to "0.1", not
    // "0.2" (cvar-parity fix).
    sndCvars.s_mixahead = Cvar_Get("s_mixahead", "0.1", CVAR_ARCHIVE);
    sndCvars.s_show = Cvar_Get("s_show", "0", 0);
    sndCvars.s_testsound = Cvar_Get("s_testsound", "0", 0);
    sndCvars.s_primary = Cvar_Get("s_primary", "0", CVAR_ARCHIVE); // win32 specific
    // q2repro src/client/sound/dma.c:563-564. Registered, consumer
    // unported: this port's mixer has no stereo-channel-swap or named
    // output-driver-selection path.
    Cvar_Get("s_swapstereo", "0", 0);
    Cvar_Get("s_driver", "", CVAR_SOUND);
    // q2repro src/client/sound/main.c:141-157 (S_Init, the OpenAL-preferring
    // frontend that owns s_enable/s_ambient/s_auto_focus/s_underwater*/
    // s_num_channels). This port's S_Init above is q2pro/vanilla's DMA-only
    // model with no OpenAL backend and no per-channel pool sizing knob, so
    // s_enable/s_ambient/s_auto_focus/s_num_channels are registered,
    // consumer unported. s_underwater/s_underwater_gain_hf are the
    // exception: divergence-audit finding #12 -- snd_mix.ts's S_PaintChannels
    // now runs the same OpenAL-Soft high-shelf biquad q2repro's dma.c:278-329
    // applies to the paint buffer whenever S_IsUnderWater() (below) is true.
    Cvar_Get("s_enable", "2", CVAR_SOUND);
    Cvar_Get("s_ambient", "1", 0);
    Cvar_Get("s_auto_focus", "2", 0);
    sndCvars.s_underwater = Cvar_Get("s_underwater", "1", 0);
    sndCvars.s_underwater_gain_hf = Cvar_Get("s_underwater_gain_hf", "0.25", 0);
    Cvar_Get("s_num_channels", "64", CVAR_SOUND);
    // q2repro src/client/sound/qal.c:199-200 and al.c:640-679 -- the OpenAL
    // backend itself (device selection, HRTF, looping-sound merging,
    // playback timescale). This port has no OpenAL backend at all (bun:ffi
    // binds SDL2 audio only, see src/platform/snd.ts) -- four registered,
    // consumer unported. al_reverb/al_reverb_lerp_time are the exception:
    // snd_environments.ts's S_ReverbInit (below) wires them up as real
    // consumers of a from-scratch Freeverb-class DSP (snd_reverb_dsp.ts)
    // driven by the retail sound/default.environments preset data, in place
    // of the OpenAL EAX reverb effect al.c would have fed.
    Cvar_Get("al_device", "", 0);
    Cvar_Get("al_hrtf", "0", 0);
    Cvar_Get("al_merge_looping", "1", 0);
    Cvar_Get("al_timescale", "1", 0);
    S_ReverbInit();

    Cmd_AddCommand("play", S_Play);
    Cmd_AddCommand("stopsound", S_StopAllSounds);
    Cmd_AddCommand("soundlist", S_SoundList);
    Cmd_AddCommand("soundinfo", S_SoundInfo_f);

    if (!SNDDMA_Init()) return;

    S_InitScaletable();

    soundStarted = true;
    num_sfx = 0;

    soundtime = 0;
    setPaintedtime(0);
    // the per-device-session position trackers must rebase with the fresh
    // device (snd_restart), or the first GetSoundtime sees a "wrap" and
    // vaults soundtime a full buffer ahead of a queue that starts empty
    gGetSoundtimeBuffers = 0;
    gGetSoundtimeOldsamplepos = 0;

    Com_Printf("sound sampling rate: %i\n", dma.speed);

    S_StopAllSounds();
  }

  Com_Printf("------------------------------------\n");
}

// =======================================================================
// Shutdown sound engine
// =======================================================================

export function S_Shutdown(): void {
  if (!soundStarted) return;

  SNDDMA_Shutdown();

  S_ReverbShutdown();
  S_ReverbDspReset();

  soundStarted = false;

  Cmd_RemoveCommand("play");
  Cmd_RemoveCommand("stopsound");
  Cmd_RemoveCommand("soundlist");
  Cmd_RemoveCommand("soundinfo");

  // free all sounds
  for (let i = 0; i < num_sfx; i++) {
    if (!known_sfx[i].name[0]) continue;
    known_sfx[i] = new SfxT(); // Z_Free(sfx->cache) has no equivalent -- plain GC'd allocation
  }

  num_sfx = 0;
}

// =======================================================================
// Load a sound
// =======================================================================

/*
==================
S_FindName

==================
*/
export function S_FindName(name: string, create: boolean): SfxT | null {
  if (!name[0]) Com_Error(ERR_FATAL, "S_FindName: empty name\n");
  if (name.length >= SFX_NAME_MAX_LEN) Com_Error(ERR_FATAL, "Sound name too long: %s", name);

  // see if already loaded
  for (let i = 0; i < num_sfx; i++) {
    if (known_sfx[i].name === name) return known_sfx[i];
  }

  if (!create) return null;

  // find a free sfx
  let i = 0;
  for (; i < num_sfx; i++) {
    if (!known_sfx[i].name[0]) break;
  }

  if (i === num_sfx) {
    if (num_sfx === MAX_SFX) Com_Error(ERR_FATAL, "S_FindName: out of sfx_t");
    num_sfx++;
  }

  const sfx = new SfxT();
  known_sfx[i] = sfx;
  sfx.name = name;
  sfx.registration_sequence = s_registration_sequence;

  return sfx;
}

/*
==================
S_AliasName

==================
*/
function S_AliasName(aliasname: string, truename: string): SfxT {
  let i = 0;
  for (; i < num_sfx; i++) {
    if (!known_sfx[i].name[0]) break;
  }

  if (i === num_sfx) {
    if (num_sfx === MAX_SFX) Com_Error(ERR_FATAL, "S_FindName: out of sfx_t");
    num_sfx++;
  }

  const sfx = new SfxT();
  known_sfx[i] = sfx;
  sfx.name = aliasname;
  sfx.registration_sequence = s_registration_sequence;
  sfx.truename = truename; // JS strings are immutable; no need for Z_Malloc+strcpy's defensive copy

  return sfx;
}

/*
=====================
S_BeginRegistration

=====================
*/
export function S_BeginRegistration(): void {
  s_registration_sequence++;
  s_registering = true;
}

/*
==================
S_RegisterSound

==================
*/
export function S_RegisterSound(name: string): SfxT | null {
  if (!soundStarted) return null;

  const sfx = S_FindName(name, true);
  if (!sfx) return null; // S_FindName(_, true) always returns non-null in practice (see its own Com_Error paths)
  sfx.registration_sequence = s_registration_sequence;

  if (!s_registering) S_LoadSound(sfx);

  return sfx;
}

/*
=====================
S_EndRegistration

=====================
*/
export function S_EndRegistration(): void {
  // [Paril-KEX] al.c:1311-1336's AL_EndRegistration reloads
  // sound/default.environments and resets reverb selection state at exactly
  // this point in the registration lifecycle (once per map, after the world
  // model and all sounds are (re)loaded but before gameplay resumes). This
  // port has one S_EndRegistration regardless of backend, so the reload runs
  // here unconditionally rather than behind an OpenAL-only sndapi dispatch.
  S_ReverbEndRegistration();

  // free any sounds not from this registration sequence
  for (let i = 0; i < num_sfx; i++) {
    const sfx = known_sfx[i];
    if (!sfx.name[0]) continue;
    if (sfx.registration_sequence !== s_registration_sequence) {
      // don't need this sound
      known_sfx[i] = new SfxT();
    } else if (sfx.cache) {
      // make sure it is paged in
      const size = sfx.cache.length * sfx.cache.width;
      Com_PageInMemory(sfx.cache.data, size);
    }
  }

  // load everything in
  for (let i = 0; i < num_sfx; i++) {
    const sfx = known_sfx[i];
    if (!sfx.name[0]) continue;
    S_LoadSound(sfx);
  }

  s_registering = false;
}

//=============================================================================

/*
=================
S_PickChannel
=================
*/
export function S_PickChannel(entnum: number, entchannel: number): ChannelT | null {
  if (entchannel < 0) Com_Error(ERR_DROP, "S_PickChannel: entchannel<0");

  // Check for replacement sound, or find the best one to replace
  let first_to_die = -1;
  let life_left = 0x7fffffff;
  for (let ch_idx = 0; ch_idx < MAX_CHANNELS; ch_idx++) {
    const c = channels[ch_idx];

    if (entchannel !== 0 && c.entnum === entnum && c.entchannel === entchannel) {
      // always override sound from same entity
      first_to_die = ch_idx;
      break;
    }

    // don't let monster sounds override player sounds
    if (c.entnum === cl.playernum + 1 && entnum !== cl.playernum + 1 && c.sfx) continue;

    if (c.end - paintedtime < life_left) {
      life_left = c.end - paintedtime;
      first_to_die = ch_idx;
    }
  }

  if (first_to_die === -1) return null;

  const ch = new ChannelT();
  channels[first_to_die] = ch;

  return ch;
}

/*
=================
S_SpatializeOrigin

Used for spatializing channels and autosounds
=================
*/
function S_SpatializeOrigin(origin: Vec3, master_vol: number, dist_mult: number): [number, number] {
  if (cls.state !== ConnstateT.ca_active) return [255, 255];

  // calculate stereo seperation and distance attenuation
  const source_vec = vec3();
  VectorSubtract(origin, listener_origin, source_vec);

  let dist = VectorNormalize(source_vec);
  dist -= SOUND_FULLVOLUME;
  if (dist < 0) dist = 0; // close enough to be at full volume
  dist *= dist_mult; // different attenuation levels

  const dot = DotProduct(listener_right, source_vec);

  let rscale: number;
  let lscale: number;
  if (dma.channels === 1 || !dist_mult) {
    // no attenuation = no spatialization
    rscale = 1.0;
    lscale = 1.0;
  } else {
    rscale = 0.5 * (1.0 + dot);
    lscale = 0.5 * (1.0 - dot);
  }

  // add in distance effect
  let scale = (1.0 - dist) * rscale;
  let right_vol = Math.trunc(master_vol * scale);
  if (right_vol < 0) right_vol = 0;

  scale = (1.0 - dist) * lscale;
  let left_vol = Math.trunc(master_vol * scale);
  if (left_vol < 0) left_vol = 0;

  return [left_vol, right_vol];
}

/*
=================
S_IsUnderWater

q2repro src/client/sound/sound.h:178-179's S_IsUnderWater() macro:
`cls.state == ca_active && (cl.frame.ps.rdflags | cl.predicted_rdflags) &
RDF_UNDERWATER && s_underwater->integer`. This port's client has no
predicted_rdflags field (a q2repro prediction-timing refinement with no
equivalent state anywhere in cl_pred.ts/cl_view.ts today; adding one is out
of this unit's territory), so this reads the confirmed frame's rdflags only
(cl.frame.playerstate.rdflags, matching cl_view.ts:579's own read of the
same field) -- the underwater filter engages one frame later than upstream
in the worst case, not never.
=================
*/
export function S_IsUnderWater(): boolean {
  if (cls.state !== ConnstateT.ca_active) return false;
  if ((cl.frame.playerstate.rdflags & RDF_UNDERWATER) === 0) return false;
  return (sndCvars.s_underwater ? sndCvars.s_underwater.value : 0) !== 0;
}

/*
=================
S_Spatialize
=================
*/
export function S_Spatialize(ch: ChannelT): void {
  // anything coming from the view entity will always be full volume
  if (ch.entnum === cl.playernum + 1) {
    ch.leftvol = ch.master_vol;
    ch.rightvol = ch.master_vol;
    return;
  }

  const origin = vec3();
  if (ch.fixed_origin) {
    VectorCopy(ch.origin, origin);
  } else {
    CL_GetEntitySoundOrigin(ch.entnum, origin);
  }

  const [left_vol, right_vol] = S_SpatializeOrigin(origin, ch.master_vol, ch.dist_mult);
  ch.leftvol = left_vol;
  ch.rightvol = right_vol;
}

/*
=================
S_AllocPlaysound
=================
*/
function S_AllocPlaysound(): PlaysoundT | null {
  const ps = s_freeplays.next;
  if (!ps || ps === s_freeplays) return null; // no free playsounds

  // unlink from freelist
  if (ps.prev) ps.prev.next = ps.next;
  if (ps.next) ps.next.prev = ps.prev;

  return ps;
}

/*
=================
S_FreePlaysound
=================
*/
function S_FreePlaysound(ps: PlaysoundT): void {
  // unlink from channel
  if (ps.prev) ps.prev.next = ps.next;
  if (ps.next) ps.next.prev = ps.prev;

  // add to free list
  ps.next = s_freeplays.next;
  if (s_freeplays.next) s_freeplays.next.prev = ps;
  ps.prev = s_freeplays;
  s_freeplays.next = ps;
}

/*
===============
S_IssuePlaysound

Take the next playsound and begin it on the channel
This is never called directly by S_Play*, but only
by the update loop.
===============
*/
export function S_IssuePlaysound(ps: PlaysoundT): void {
  if (sndCvars.s_show?.value) Com_Printf("Issue %i\n", ps.begin);

  // pick a channel to play on
  const ch = S_PickChannel(ps.entnum, ps.entchannel);
  if (!ch) {
    S_FreePlaysound(ps);
    return;
  }

  // spatialize
  if (ps.attenuation === ATTN_STATIC) ch.dist_mult = ps.attenuation * 0.001;
  else ch.dist_mult = ps.attenuation * 0.0005;
  ch.master_vol = ps.volume;
  ch.entnum = ps.entnum;
  ch.entchannel = ps.entchannel;
  ch.sfx = ps.sfx;
  VectorCopy(ps.origin, ch.origin);
  ch.fixed_origin = ps.fixed_origin;

  S_Spatialize(ch);

  ch.pos = 0;
  if (ch.sfx) {
    const sc = S_LoadSound(ch.sfx);
    if (sc) ch.end = paintedtime + sc.length;
  }

  // free the playsound
  S_FreePlaysound(ps);
}

function S_RegisterSexedSound(ent: EntityStateT, base: string): SfxT | null {
  // determine what model the client is using
  let model = "";
  const n = cls.csr.playerskins + ent.number - 1;
  const cs = cl.configstrings[n];
  if (cs) {
    const backslash = cs.indexOf("\\");
    if (backslash !== -1) {
      let m = cs.slice(backslash + 1);
      const slash = m.indexOf("/");
      if (slash !== -1) m = m.slice(0, slash);
      model = m;
    }
  }
  // if we can't figure it out, they're male
  if (!model) model = "male";

  // see if we already know of the model specific sound
  const sexedFilename = Com_sprintf("#players/%s/%s", model, base.slice(1));
  let sfx = S_FindName(sexedFilename, false);

  if (!sfx) {
    // no, so see if it exists
    const open = FS_FOpenFile(sexedFilename.slice(1));
    if (open) {
      // yes, close the file and register it
      FS_FCloseFile(open.handle);
      sfx = S_RegisterSound(sexedFilename);
    } else {
      // no, revert to the male sound in the pak0.pak
      const maleFilename = Com_sprintf("player/%s/%s", "male", base.slice(1));
      sfx = S_AliasName(sexedFilename, maleFilename);
    }
  }

  return sfx;
}

// =======================================================================
// Start a sound effect
// =======================================================================

/*
====================
S_StartSound

Validates the parms and ques the sound up
if pos is NULL, the sound will be dynamically sourced from the entity
Entchannel 0 will never override a playing sound
====================
*/
export function S_StartSound(
  origin: Vec3 | null,
  entnum: number,
  entchannel: number,
  sfxIn: SfxT | null,
  fvol: number,
  attenuation: number,
  timeofs: number,
): void {
  if (!soundStarted) return;
  if (!sfxIn) return;

  let sfx: SfxT | null = sfxIn;
  if (sfx.name[0] === "*") {
    sfx = S_RegisterSexedSound(cl_entities[entnum].current, sfx.name);
  }
  if (!sfx) return;

  // Retail tactile/ haptic cues mirror sound/ paths 1:1 (all 53 .bnvib
  // names verified) -- the trigger IS the sound start, gated to the local
  // player inside Haptics_TriggerSound. See platform/haptics.ts's header
  // for the evidence and downmix design.
  Haptics_TriggerSound(sfx.name, entnum);

  // make sure the sound is loaded
  const sc = S_LoadSound(sfx);
  if (!sc) return; // couldn't load the sound's data

  const vol = Math.trunc(fvol * 255);

  // make the playsound_t
  const ps = S_AllocPlaysound();
  if (!ps) return;

  if (origin) {
    VectorCopy(origin, ps.origin);
    ps.fixed_origin = true;
  } else {
    ps.fixed_origin = false;
  }

  ps.entnum = entnum;
  ps.entchannel = entchannel;
  ps.attenuation = attenuation;
  ps.volume = vol;
  ps.sfx = sfx;

  // drift s_beginofs
  let start = Math.trunc(cl.frame.servertime * 0.001 * dma.speed + s_beginofs);
  if (start < paintedtime) {
    start = paintedtime;
    s_beginofs = Math.trunc(start - cl.frame.servertime * 0.001 * dma.speed);
  } else if (start > paintedtime + 0.3 * dma.speed) {
    start = Math.trunc(paintedtime + 0.1 * dma.speed);
    s_beginofs = Math.trunc(start - cl.frame.servertime * 0.001 * dma.speed);
  } else {
    s_beginofs -= 10;
  }

  if (!timeofs) ps.begin = paintedtime;
  else ps.begin = Math.trunc(start + timeofs * dma.speed);

  // sort into the pending sound list
  let sort = s_pendingplays.next;
  while (sort && sort !== s_pendingplays && sort.begin < ps.begin) sort = sort.next;
  if (!sort) return; // sentinel invariant guarantees non-null; defensive only

  ps.next = sort;
  ps.prev = sort.prev;

  if (ps.next) ps.next.prev = ps;
  if (ps.prev) ps.prev.next = ps;
}

/*
==================
S_StartLocalSound
==================
*/
export function S_StartLocalSound(sound: string): void {
  if (!soundStarted) return;

  const sfx = S_RegisterSound(sound);
  if (!sfx) {
    Com_Printf("S_StartLocalSound: can't cache %s\n", sound);
    return;
  }
  S_StartSound(null, cl.playernum + 1, 0, sfx, 1, 1, 0);
}

/*
==================
S_ClearBuffer
==================
*/
function S_ClearBuffer(): void {
  if (!soundStarted) return;

  setSRawend(0);

  const clear = dma.samplebits === 8 ? 0x80 : 0;

  SNDDMA_BeginPainting();
  if (dma.buffer.length) dma.buffer.fill(clear);
  SNDDMA_Submit();
}

/*
==================
S_StopAllSounds
==================
*/
export function S_StopAllSounds(): void {
  if (!soundStarted) return;

  // clear all the playsounds
  s_playsounds = Array.from({ length: MAX_PLAYSOUNDS }, () => new PlaysoundT());
  s_freeplays.next = s_freeplays;
  s_freeplays.prev = s_freeplays;
  s_pendingplays.next = s_pendingplays;
  s_pendingplays.prev = s_pendingplays;

  for (let i = 0; i < MAX_PLAYSOUNDS; i++) {
    const p = s_playsounds[i];
    p.prev = s_freeplays;
    p.next = s_freeplays.next;
    if (p.prev) p.prev.next = p;
    if (p.next) p.next.prev = p;
  }

  // clear all the channels
  for (let i = 0; i < MAX_CHANNELS; i++) channels[i] = new ChannelT();

  S_ClearBuffer();
}

/*
==================
S_AddLoopSounds

Entities with a ->sound field will generated looped sounds
that are automatically started, stopped, and merged together
as the entities are sent to the client
==================
*/
function S_AddLoopSounds(): void {
  if (clCvars.cl_paused?.value) return;

  if (cls.state !== ConnstateT.ca_active) return;

  if (!cl.sound_prepped) return;

  const sounds: number[] = new Array(cl.frame.num_entities).fill(0);

  for (let i = 0; i < cl.frame.num_entities; i++) {
    const num = (cl.frame.parse_entities + i) & (MAX_PARSE_ENTITIES - 1);
    sounds[i] = cl_parse_entities[num].sound;
  }

  for (let i = 0; i < cl.frame.num_entities; i++) {
    if (!sounds[i]) continue;

    const sfx = cl.sound_precache[sounds[i]];
    if (!sfx) continue; // bad sound effect
    const sc = sfx.cache;
    if (!sc) continue;

    let num = (cl.frame.parse_entities + i) & (MAX_PARSE_ENTITIES - 1);
    let ent = cl_parse_entities[num];

    // q2repro src/client/sound/dma.c:726 routes every autosound origin
    // through CL_GetEntitySoundOrigin, same as S_Spatialize above (line
    // ~433) already does for one-shot channel sounds -- divergence-audit
    // finding #11 found this loop still reading ent.origin directly,
    // bypassing that shared function entirely. CL_GetEntitySoundOrigin
    // itself (src/client/cl_ents.ts) is still the vanilla stub with its own
    // "// FIXME: bmodel issues" comment -- porting the rerelease's
    // nearest-point-on-bmodel clamp (entities.c:1644-1679) into that
    // function is out of this unit's territory (cl_ents.ts is off-limits
    // here). Routing through it now means loop sounds automatically pick
    // up that clamp once it lands there, instead of permanently bypassing
    // it even after cl_ents.ts is fixed.
    const loopOrigin = vec3();
    CL_GetEntitySoundOrigin(ent.number, loopOrigin);
    // find the total contribution of all sounds of this type
    let [left_total, right_total] = S_SpatializeOrigin(loopOrigin, 255.0, SOUND_LOOPATTENUATE);
    for (let j = i + 1; j < cl.frame.num_entities; j++) {
      if (sounds[j] !== sounds[i]) continue;
      sounds[j] = 0; // don't check this again later

      num = (cl.frame.parse_entities + j) & (MAX_PARSE_ENTITIES - 1);
      ent = cl_parse_entities[num];

      CL_GetEntitySoundOrigin(ent.number, loopOrigin);
      const [left, right] = S_SpatializeOrigin(loopOrigin, 255.0, SOUND_LOOPATTENUATE);
      left_total += left;
      right_total += right;
    }

    if (left_total === 0 && right_total === 0) continue; // not audible

    // allocate a channel
    const ch = S_PickChannel(0, 0);
    if (!ch) return;

    if (left_total > 255) left_total = 255;
    if (right_total > 255) right_total = 255;
    ch.leftvol = left_total;
    ch.rightvol = right_total;
    ch.autosound = true; // remove next frame
    ch.sfx = sfx;
    ch.pos = paintedtime % sc.length;
    ch.end = paintedtime + sc.length - ch.pos;
  }
}

//=============================================================================

/*
============
S_RawSamples

Cinematic streaming and voice over network
============
*/
export function S_RawSamples(samples: number, rate: number, width: number, numChannels: number, data: Uint8Array): void {
  if (!soundStarted) return;

  if (s_rawend < paintedtime) setSRawend(paintedtime);
  const scale = rate / dma.speed;

  if (numChannels === 2 && width === 2) {
    if (scale === 1.0) {
      // optimized case
      for (let i = 0; i < samples; i++) {
        const dst = s_rawend & (MAX_RAW_SAMPLES - 1);
        setSRawend(s_rawend + 1);
        s_rawsamples[dst].left = readInt16LE(data, i * 4) << 8;
        s_rawsamples[dst].right = readInt16LE(data, i * 4 + 2) << 8;
      }
    } else {
      for (let i = 0; ; i++) {
        const src = Math.trunc(i * scale);
        if (src >= samples) break;
        const dst = s_rawend & (MAX_RAW_SAMPLES - 1);
        setSRawend(s_rawend + 1);
        s_rawsamples[dst].left = readInt16LE(data, src * 4) << 8;
        s_rawsamples[dst].right = readInt16LE(data, src * 4 + 2) << 8;
      }
    }
  } else if (numChannels === 1 && width === 2) {
    for (let i = 0; ; i++) {
      const src = Math.trunc(i * scale);
      if (src >= samples) break;
      const dst = s_rawend & (MAX_RAW_SAMPLES - 1);
      setSRawend(s_rawend + 1);
      const v = readInt16LE(data, src * 2) << 8;
      s_rawsamples[dst].left = v;
      s_rawsamples[dst].right = v;
    }
  } else if (numChannels === 2 && width === 1) {
    for (let i = 0; ; i++) {
      const src = Math.trunc(i * scale);
      if (src >= samples) break;
      const dst = s_rawend & (MAX_RAW_SAMPLES - 1);
      setSRawend(s_rawend + 1);
      // C reads these as `(char *)data` (signed), unlike the mono 8-bit
      // branch below which reads `(byte *)data` (unsigned) -- an
      // inconsistency in the original, preserved as-is.
      s_rawsamples[dst].left = toSignedByte(data[src * 2]) << 16;
      s_rawsamples[dst].right = toSignedByte(data[src * 2 + 1]) << 16;
    }
  } else if (numChannels === 1 && width === 1) {
    for (let i = 0; ; i++) {
      const src = Math.trunc(i * scale);
      if (src >= samples) break;
      const dst = s_rawend & (MAX_RAW_SAMPLES - 1);
      setSRawend(s_rawend + 1);
      const v = (data[src] - 128) << 16;
      s_rawsamples[dst].left = v;
      s_rawsamples[dst].right = v;
    }
  }
}

//=============================================================================

/*
============
S_Update

Called once each time through the main loop
============
*/
export function S_Update(origin: Vec3, forward: Vec3, right: Vec3, up: Vec3): void {
  if (!soundStarted) return;

  // if the loading plaque is up, clear everything
  // out to make sure we aren't looping a dirty
  // dma buffer while loading
  if (cls.disable_screen) {
    S_ClearBuffer();
    return;
  }

  // rebuild scale tables if volume is modified
  if (sndCvars.s_volume?.modified) S_InitScaletable();

  VectorCopy(origin, listener_origin);
  VectorCopy(forward, listener_forward);
  VectorCopy(right, listener_right);
  VectorCopy(up, listener_up);

  // [Paril-KEX] al.c:1260-1264's AL_Update calls AL_UpdateReverb() right
  // after the listener position/orientation are set and before per-channel
  // respatialization -- matched here (see snd_environments.ts's own header
  // comment for what this port does differently from al.c's floor-probe
  // trace call).
  S_UpdateReverb(listener_origin, cl.time);

  // update spatialization for dynamic sounds
  for (let i = 0; i < MAX_CHANNELS; i++) {
    const ch = channels[i];
    if (!ch.sfx) continue;
    if (ch.autosound) {
      // autosounds are regenerated fresh each frame
      channels[i] = new ChannelT();
      continue;
    }
    S_Spatialize(ch); // respatialize channel
    if (!ch.leftvol && !ch.rightvol) {
      channels[i] = new ChannelT();
      continue;
    }
  }

  // add loopsounds
  S_AddLoopSounds();

  //
  // debugging output
  //
  if (sndCvars.s_show?.value) {
    let total = 0;
    for (let i = 0; i < MAX_CHANNELS; i++) {
      const ch = channels[i];
      if (ch.sfx && (ch.leftvol || ch.rightvol)) {
        Com_Printf("%3i %3i %s\n", ch.leftvol, ch.rightvol, ch.sfx.name);
        total++;
      }
    }

    Com_Printf("----(%i)---- painted: %i\n", total, paintedtime);
  }

  // mix some sound
  S_Update_();
}

let gGetSoundtimeBuffers = 0;
let gGetSoundtimeOldsamplepos = 0;

function GetSoundtime(): void {
  const fullsamples = Math.trunc(dma.samples / dma.channels);

  // it is possible to miscount buffers if it has wrapped twice between
  // calls to S_Update.  Oh well.
  const samplepos = SNDDMA_GetDMAPos();

  if (samplepos < gGetSoundtimeOldsamplepos) {
    gGetSoundtimeBuffers++; // buffer wrapped

    if (paintedtime > 0x40000000) {
      // time to chop things off to avoid 32 bit limits
      gGetSoundtimeBuffers = 0;
      setPaintedtime(fullsamples);
      S_StopAllSounds();
    }
  }
  gGetSoundtimeOldsamplepos = samplepos;

  soundtime = gGetSoundtimeBuffers * fullsamples + Math.trunc(samplepos / dma.channels);
}

function S_Update_(): void {
  if (!soundStarted) return;

  SNDDMA_BeginPainting();

  if (!dma.buffer.length) return;

  // Updates DMA time
  GetSoundtime();

  // check to make sure that we haven't overshot
  if (paintedtime < soundtime) {
    Com_DPrintf("S_Update_ : overflow\n");
    setPaintedtime(soundtime);
  }

  // mix ahead of current position
  let endtime = Math.trunc(soundtime + (sndCvars.s_mixahead?.value ?? 0) * dma.speed);

  // mix to an even submission block size
  endtime = (endtime + dma.submission_chunk - 1) & ~(dma.submission_chunk - 1);
  const samps = dma.samples >> (dma.channels - 1);
  if (endtime - soundtime > samps) endtime = soundtime + samps;

  S_PaintChannels(endtime);

  SNDDMA_Submit();
}

/*
===============================================================================

console functions

===============================================================================
*/

function S_Play(): void {
  let i = 1;
  while (i < Cmd_Argc()) {
    let name = Cmd_Argv(i);
    if (!name.includes(".")) name = `${name}.wav`;
    const sfx = S_RegisterSound(name);
    S_StartSound(null, cl.playernum + 1, 0, sfx, 1.0, 1.0, 0);
    i++;
  }
}

function S_SoundList(): void {
  let total = 0;
  for (let i = 0; i < num_sfx; i++) {
    const sfx = known_sfx[i];
    if (!sfx.registration_sequence) continue;
    const sc = sfx.cache;
    if (sc) {
      const size = sc.length * sc.width * (sc.stereo + 1);
      total += size;
      Com_Printf(sc.loopstart >= 0 ? "L" : " ");
      Com_Printf("(%2db) %6i : %s\n", sc.width * 8, size, sfx.name);
    } else {
      if (sfx.name[0] === "*") Com_Printf("  placeholder : %s\n", sfx.name);
      else Com_Printf("  not loaded  : %s\n", sfx.name);
    }
  }
  Com_Printf("Total resident: %i\n", total);
}
