// snd_environments.ts -- sound/default.environments parsing, reverb
// environment/preset selection, and EFX-shaped reverb parameter
// interpolation.
//
// [Paril-KEX] Ported from q2repro's src/client/sound/al.c: the JSON loader
// (AL_LoadReverbEnvironments/AL_LoadReverbEnvironment/AL_LoadReverbEntry,
// al.c:351-517), the dimension-threshold environment walk plus 14-direction
// room-size probe (AL_EstimateDimensions, al.c:188-239), the per-frame
// floor-material preset pick (AL_UpdateReverb, al.c:249-349), and the
// cubic-ease preset-to-preset lerp (AL_CalculateReverbFrac, al.c:241-247).
//
// This port has no OpenAL/EFX backend: src/platform/snd.ts is SDL-only PCM
// output feeding the vanilla-shaped DMA software mixer (snd_dma.ts/
// snd_mix.ts), matching q2repro's OWN dma.c/dma.h software-mixing path --
// which never implements reverb at all (grep confirms zero "reverb" hits in
// q2repro's dma.c; reverb is exclusively an al.c/AL_EFFECT_EAXREVERB
// feature). There is therefore no faithful DMA-path reference behavior to
// preserve for reverb; Mike's ruling (2026-08-31) is to port al.c's
// SELECTION algorithm and the retail sound/default.environments data
// verbatim, and drive a from-scratch Freeverb-class DSP (snd_reverb_dsp.ts)
// with the interpolated EFX-shaped parameters this module produces, in
// place of feeding real OpenAL's AL_EFFECT_EAXREVERB.
//
// KNOWN UPSTREAM BUG, NOT REPRODUCED: al.c's floor-probe trace
// (AL_UpdateReverb, al.c:264) calls
// `CL_Trace(&tr, listener_start, mins, maxs, listener_down, NULL, MASK_SOLID)`
// where `mins`/`maxs` are the LOCAL vec3_t box-extent variables ({-16,-16,0}/
// {16,16,0}) and `listener_down` is the absolute world position 256 units
// below the listener. CL_Trace's real signature (src/client/client.h:995,
// confirmed against its definition in predict.c:115) is
// `(trace_t*, start, end, mins, maxs, passent, contentmask)` -- so this call
// actually passes the {-16,-16,0} extent vector as the trace's absolute
// world-space END point, the {16,16,0} extent as `mins`, and the listener's
// real down-position as `maxs`, not a small box swept 256 units straight
// down as the surrounding code clearly intends. This has been present
// unchanged since the feature's first commit (50086765, "reverb mostly
// working", 2023-10-26) through two later reverb bugfixes (c55fb988 "fix
// crash in reverb if a null surface is hit"; 108ca0ea "fix reverb step id
// picking from the ceiling, not the floor" -- which nudged the start point
// +1 unit without touching the actual mins/maxs/end swap) and is still
// present in the checked-out q2repro tree. It is pure deterministic vector
// math (no UB/aliasing/memory-model dependence), so the FIDELITY RAZOR
// (.orch/preferences.md rule 17) does not compel preserving it, and reverb
// is single-player-local/cosmetic (no protocol or gameplay-state interop
// value -- rule 17's stated reason to prefer bug-for-bug does not apply
// here). This port implements the CLEARLY INTENDED geometry instead: a
// small box swept 256 units straight down from just above the listener.
// Flagged per rule 16 for coordinator review; reverting to the byte-exact
// buggy trace is a one-line change if bug-for-bug parity is preferred after
// all.

import { FS_LoadFile } from "../qcommon/files";
import { Com_Printf } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import {
  type Vec3,
  vec3,
  VectorMA,
  VectorSubtract,
  VectorClear,
  ClearBounds,
  AddPointToBounds,
} from "../shared/math";
import { type CvarT, SURF_SKY, MASK_SOLID, Q_stricmp } from "../shared/q_shared";
import { CM_BoxTrace } from "../qcommon/cmodel";

// ---------------------------------------------------------------------------
// EFX-shaped reverb parameters
// ---------------------------------------------------------------------------

// [Paril-KEX] al.c:73-100's `s_reverb_parameters` table, sourced from OpenAL
// Soft's own EFXEAXREVERBPROPERTIES preset macros (system header
// /usr/include/AL/efx-presets.h -- the same "Creative EFX reverb preset"
// values every OpenAL implementation ships, not q2repro's own invention;
// q2repro's al.c feeds these to qalEffectf/qalEffectfv via AL_LoadEffect,
// al.c:136-163). Field set here matches EFXEAXREVERBPROPERTIES minus its two
// 3-component pan vectors (flReflectionsPan/flLateReverbPan): every one of
// the 26 presets below has both pans pinned at {0,0,0} (verified against the
// header), so they carry no information this port would ever read, and
// dropping them avoids pulling a Vec3 dependency into pure preset data.
export type EfxReverbParamsT = {
  density: number;
  diffusion: number;
  gain: number;
  gainHF: number;
  gainLF: number;
  decayTime: number;
  decayHFRatio: number;
  decayLFRatio: number;
  reflectionsGain: number;
  reflectionsDelay: number;
  lateReverbGain: number;
  lateReverbDelay: number;
  echoTime: number;
  echoDepth: number;
  modulationTime: number;
  modulationDepth: number;
  airAbsorptionGainHF: number;
  hfReference: number;
  lfReference: number;
  roomRolloffFactor: number;
  decayHFLimit: boolean;
};

// al.c:107-134's s_reverb_names, in the SAME order as s_reverb_parameters
// (index == preset id read from the JSON "preset" string and used as
// s_reverb_current_preset/new_preset throughout al.c).
export const REVERB_PRESET_NAMES: readonly string[] = [
  "generic",
  "padded_cell",
  "room",
  "bathroom",
  "living_room",
  "stone_room",
  "auditorium",
  "concert_hall",
  "cave",
  "arena",
  "hangar",
  "carpeted_hallway",
  "hallway",
  "stone_corridor",
  "alley",
  "forest",
  "city",
  "mountains",
  "quarry",
  "plain",
  "parking_lot",
  "sewer_pipe",
  "underwater",
  "drugged",
  "dizzy",
  "psychotic",
];

// al.c's fallback preset when a JSON "preset" name doesn't match any entry
// in s_reverb_names (al.c:390-395: "missing sound environment preset" ->
// index 19, "plain") and the preset AL_UpdateReverb forces when the floor
// probe finds no ground within range (al.c:292: `new_preset = 19;`).
export const REVERB_PRESET_PLAIN = 19;

// Values transcribed programmatically (not by hand) from
// /usr/include/AL/efx-presets.h's EFX_REVERB_PRESET_* macros, in
// REVERB_PRESET_NAMES order, to avoid transcription error across 26 * 21
// fields.
export const REVERB_PRESETS: readonly EfxReverbParamsT[] = [
  { // generic
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.8913, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.83, decayLFRatio: 1.0,
    reflectionsGain: 0.05, reflectionsDelay: 0.007,
    lateReverbGain: 1.2589, lateReverbDelay: 0.011,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // padded_cell
    density: 0.1715, diffusion: 1.0, gain: 0.3162, gainHF: 0.001, gainLF: 1.0,
    decayTime: 0.17, decayHFRatio: 0.1, decayLFRatio: 1.0,
    reflectionsGain: 0.25, reflectionsDelay: 0.001,
    lateReverbGain: 1.2691, lateReverbDelay: 0.002,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // room
    density: 0.4287, diffusion: 1.0, gain: 0.3162, gainHF: 0.5929, gainLF: 1.0,
    decayTime: 0.4, decayHFRatio: 0.83, decayLFRatio: 1.0,
    reflectionsGain: 0.1503, reflectionsDelay: 0.002,
    lateReverbGain: 1.0629, lateReverbDelay: 0.003,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // bathroom
    density: 0.1715, diffusion: 1.0, gain: 0.3162, gainHF: 0.2512, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.54, decayLFRatio: 1.0,
    reflectionsGain: 0.6531, reflectionsDelay: 0.007,
    lateReverbGain: 3.2734, lateReverbDelay: 0.011,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // living_room
    density: 0.9766, diffusion: 1.0, gain: 0.3162, gainHF: 0.001, gainLF: 1.0,
    decayTime: 0.5, decayHFRatio: 0.1, decayLFRatio: 1.0,
    reflectionsGain: 0.2051, reflectionsDelay: 0.003,
    lateReverbGain: 0.2805, lateReverbDelay: 0.004,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // stone_room
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.7079, gainLF: 1.0,
    decayTime: 2.31, decayHFRatio: 0.64, decayLFRatio: 1.0,
    reflectionsGain: 0.4411, reflectionsDelay: 0.012,
    lateReverbGain: 1.1003, lateReverbDelay: 0.017,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // auditorium
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.5781, gainLF: 1.0,
    decayTime: 4.32, decayHFRatio: 0.59, decayLFRatio: 1.0,
    reflectionsGain: 0.4032, reflectionsDelay: 0.02,
    lateReverbGain: 0.717, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // concert_hall
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.5623, gainLF: 1.0,
    decayTime: 3.92, decayHFRatio: 0.7, decayLFRatio: 1.0,
    reflectionsGain: 0.2427, reflectionsDelay: 0.02,
    lateReverbGain: 0.9977, lateReverbDelay: 0.029,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // cave
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 1.0, gainLF: 1.0,
    decayTime: 2.91, decayHFRatio: 1.3, decayLFRatio: 1.0,
    reflectionsGain: 0.5, reflectionsDelay: 0.015,
    lateReverbGain: 0.7063, lateReverbDelay: 0.022,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
  { // arena
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.4477, gainLF: 1.0,
    decayTime: 7.24, decayHFRatio: 0.33, decayLFRatio: 1.0,
    reflectionsGain: 0.2612, reflectionsDelay: 0.02,
    lateReverbGain: 1.0186, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // hangar
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.3162, gainLF: 1.0,
    decayTime: 10.05, decayHFRatio: 0.23, decayLFRatio: 1.0,
    reflectionsGain: 0.5, reflectionsDelay: 0.02,
    lateReverbGain: 1.256, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // carpeted_hallway
    density: 0.4287, diffusion: 1.0, gain: 0.3162, gainHF: 0.01, gainLF: 1.0,
    decayTime: 0.3, decayHFRatio: 0.1, decayLFRatio: 1.0,
    reflectionsGain: 0.1215, reflectionsDelay: 0.002,
    lateReverbGain: 0.1531, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // hallway
    density: 0.3645, diffusion: 1.0, gain: 0.3162, gainHF: 0.7079, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.59, decayLFRatio: 1.0,
    reflectionsGain: 0.2458, reflectionsDelay: 0.007,
    lateReverbGain: 1.6615, lateReverbDelay: 0.011,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // stone_corridor
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.7612, gainLF: 1.0,
    decayTime: 2.7, decayHFRatio: 0.79, decayLFRatio: 1.0,
    reflectionsGain: 0.2472, reflectionsDelay: 0.013,
    lateReverbGain: 1.5758, lateReverbDelay: 0.02,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // alley
    density: 1.0, diffusion: 0.3, gain: 0.3162, gainHF: 0.7328, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.86, decayLFRatio: 1.0,
    reflectionsGain: 0.25, reflectionsDelay: 0.007,
    lateReverbGain: 0.9954, lateReverbDelay: 0.011,
    echoTime: 0.125, echoDepth: 0.95, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // forest
    density: 1.0, diffusion: 0.3, gain: 0.3162, gainHF: 0.0224, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.54, decayLFRatio: 1.0,
    reflectionsGain: 0.0525, reflectionsDelay: 0.162,
    lateReverbGain: 0.7682, lateReverbDelay: 0.088,
    echoTime: 0.125, echoDepth: 1.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // city
    density: 1.0, diffusion: 0.5, gain: 0.3162, gainHF: 0.3981, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.67, decayLFRatio: 1.0,
    reflectionsGain: 0.073, reflectionsDelay: 0.007,
    lateReverbGain: 0.1427, lateReverbDelay: 0.011,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // mountains
    density: 1.0, diffusion: 0.27, gain: 0.3162, gainHF: 0.0562, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.21, decayLFRatio: 1.0,
    reflectionsGain: 0.0407, reflectionsDelay: 0.3,
    lateReverbGain: 0.1919, lateReverbDelay: 0.1,
    echoTime: 0.25, echoDepth: 1.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
  { // quarry
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 0.3162, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.83, decayLFRatio: 1.0,
    reflectionsGain: 0.0, reflectionsDelay: 0.061,
    lateReverbGain: 1.7783, lateReverbDelay: 0.025,
    echoTime: 0.125, echoDepth: 0.7, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // plain
    density: 1.0, diffusion: 0.21, gain: 0.3162, gainHF: 0.1, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.5, decayLFRatio: 1.0,
    reflectionsGain: 0.0585, reflectionsDelay: 0.179,
    lateReverbGain: 0.1089, lateReverbDelay: 0.1,
    echoTime: 0.25, echoDepth: 1.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // parking_lot
    density: 1.0, diffusion: 1.0, gain: 0.3162, gainHF: 1.0, gainLF: 1.0,
    decayTime: 1.65, decayHFRatio: 1.5, decayLFRatio: 1.0,
    reflectionsGain: 0.2082, reflectionsDelay: 0.008,
    lateReverbGain: 0.2652, lateReverbDelay: 0.012,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
  { // sewer_pipe
    density: 0.3071, diffusion: 0.8, gain: 0.3162, gainHF: 0.3162, gainLF: 1.0,
    decayTime: 2.81, decayHFRatio: 0.14, decayLFRatio: 1.0,
    reflectionsGain: 1.6387, reflectionsDelay: 0.014,
    lateReverbGain: 3.2471, lateReverbDelay: 0.021,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 0.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // underwater
    density: 0.3645, diffusion: 1.0, gain: 0.3162, gainHF: 0.01, gainLF: 1.0,
    decayTime: 1.49, decayHFRatio: 0.1, decayLFRatio: 1.0,
    reflectionsGain: 0.5963, reflectionsDelay: 0.007,
    lateReverbGain: 7.0795, lateReverbDelay: 0.011,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 1.18, modulationDepth: 0.348,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: true,
  },
  { // drugged
    density: 0.4287, diffusion: 0.5, gain: 0.3162, gainHF: 1.0, gainLF: 1.0,
    decayTime: 8.39, decayHFRatio: 1.39, decayLFRatio: 1.0,
    reflectionsGain: 0.876, reflectionsDelay: 0.002,
    lateReverbGain: 3.1081, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 0.25, modulationDepth: 1.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
  { // dizzy
    density: 0.3645, diffusion: 0.6, gain: 0.3162, gainHF: 0.631, gainLF: 1.0,
    decayTime: 17.23, decayHFRatio: 0.56, decayLFRatio: 1.0,
    reflectionsGain: 0.1392, reflectionsDelay: 0.02,
    lateReverbGain: 0.4937, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 1.0, modulationTime: 0.81, modulationDepth: 0.31,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
  { // psychotic
    density: 0.0625, diffusion: 0.5, gain: 0.3162, gainHF: 0.8404, gainLF: 1.0,
    decayTime: 7.56, decayHFRatio: 0.91, decayLFRatio: 1.0,
    reflectionsGain: 0.4864, reflectionsDelay: 0.02,
    lateReverbGain: 2.4378, lateReverbDelay: 0.03,
    echoTime: 0.25, echoDepth: 0.0, modulationTime: 4.0, modulationDepth: 1.0,
    airAbsorptionGainHF: 0.9943, hfReference: 5000.0, lfReference: 250.0,
    roomRolloffFactor: 0.0, decayHFLimit: false,
  },
];

function copyReverbParams(src: EfxReverbParamsT): EfxReverbParamsT {
  return { ...src };
}

// ---------------------------------------------------------------------------
// sound/default.environments parsing
// ---------------------------------------------------------------------------

// al.c:55-59's al_reverb_entry_t: `materials === null` is al.c's
// `materials == NULL` ("if null, matches everything" -- the JSON "*"
// wildcard, al.c:360-364).
export type ReverbMaterialEntryT = {
  materials: readonly string[] | null;
  presetIndex: number;
};

// al.c:61-65's al_reverb_environment_t.
export type ReverbEnvironmentT = {
  dimension: number;
  reverbs: readonly ReverbMaterialEntryT[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// al.c:380-395's preset-name lookup: falls back to REVERB_PRESET_PLAIN with
// a warning on an unrecognized name (does NOT abort the whole file, matching
// al.c's own per-entry recovery -- only structural violations abort, per
// AL_LoadReverbEnvironments's Json_Error/Json_ErrorHandler pair).
function resolvePresetName(name: string): number {
  const idx = REVERB_PRESET_NAMES.indexOf(name);
  if (idx === -1) {
    Com_Printf("missing sound environment preset\n");
    return REVERB_PRESET_PLAIN;
  }
  return idx;
}

// al.c:351-403's AL_LoadReverbEntry. Throws (caught by the top-level parser)
// on the same structural violations al.c's Json_Error/Json_EnsureNext would
// abort the whole file for.
function parseReverbEntry(raw: unknown): ReverbMaterialEntryT {
  if (!isRecord(raw)) throw new Error("reverb entry is not an object");

  let materials: readonly string[] | null = null;
  let presetIndex = REVERB_PRESET_PLAIN;
  let sawPreset = false;

  if ("materials" in raw) {
    const m = raw.materials;
    if (typeof m === "string") {
      // al.c:360-364 only checks the FIRST character is '*' (not that the
      // whole string equals "*") -- ported literally; retail data only ever
      // uses the bare "*" so the distinction never actually matters.
      if (m[0] !== "*") throw new Error('expected string to start with "*"');
      materials = null;
    } else if (Array.isArray(m)) {
      const list: string[] = [];
      for (const item of m) {
        if (typeof item !== "string") throw new Error("materials array entry is not a string");
        list.push(item);
      }
      materials = list;
    } else {
      throw new Error('"materials" must be a string or an array of strings');
    }
  }

  if ("preset" in raw) {
    const p = raw.preset;
    if (typeof p !== "string") throw new Error('"preset" must be a string');
    presetIndex = resolvePresetName(p);
    sawPreset = true;
  }

  // al.c has no explicit "preset is required" check, but out_entry->preset
  // is Z_TagMallocz'd (zero-initialized) if the field is absent, i.e.
  // defaults to index 0 ("generic"), not 19 ("plain"). Matched here: only
  // fall back to PLAIN via resolvePresetName's own "unrecognized name" path,
  // not for an outright-missing field.
  if (!sawPreset) presetIndex = 0;

  return { materials, presetIndex };
}

// al.c:405-430's AL_LoadReverbEnvironment.
function parseReverbEnvironment(raw: unknown): ReverbEnvironmentT {
  if (!isRecord(raw)) throw new Error("environment entry is not an object");

  let dimension = 0;
  let reverbs: ReverbMaterialEntryT[] = [];

  if ("dimension" in raw) {
    const d = raw.dimension;
    if (typeof d !== "number" || !Number.isFinite(d)) throw new Error('"dimension" must be a number');
    dimension = d;
  }

  if ("reverbs" in raw) {
    const r = raw.reverbs;
    if (!Array.isArray(r)) throw new Error('"reverbs" must be an array');
    reverbs = r.map(parseReverbEntry);
  }

  return { dimension, reverbs };
}

/*
=================
ParseEnvironmentsFile

Pure parser: al.c:478-517's AL_LoadReverbEnvironments, minus the filesystem
read (the caller supplies the file's text). q2repro's json.c is a JSMN-based
streaming tokenizer with its own error-recovery machinery (Json_Error longjmps
out through Json_ErrorHandler, aborting the whole file); sound/default.environments
is well-formed standard JSON with no q2repro-specific extensions (no comments,
no trailing commas -- confirmed against the real retail file), so this port
uses the host JSON.parse plus a validating walk instead of re-implementing the
tokenizer. Returns null on ANY structural violation (mirrors the
Json_ErrorHandler catch-all at al.c:484-488, which discards partial data and
leaves reverb disabled for that registration).
=================
*/
export function ParseEnvironmentsFile(text: string): ReverbEnvironmentT[] | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    Com_Printf(`Couldn't load sound/default.environments; ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }

  try {
    if (!isRecord(root)) throw new Error("expected a JSON object");
    if (!("environments" in root)) throw new Error('expected "environments" key');
    const envs = root.environments;
    if (!Array.isArray(envs)) throw new Error('"environments" must be an array');
    if (envs.length === 0) return []; // al.c:500-505: an empty array is a valid "no reverb" file
    return envs.map(parseReverbEnvironment);
  } catch (e) {
    Com_Printf(`Couldn't load sound/default.environments; ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime selection + interpolation state
// ---------------------------------------------------------------------------

let s_environments: ReverbEnvironmentT[] | null = null;
let s_activeEnvironmentIndex = 0;

// al.c:165-183's 14 fixed probe directions (a near-icosahedral spread) and
// per-probe result cache, copied verbatim.
const REVERB_PROBES: readonly Vec3[] = [
  vec3(0.0, 0.0, -1.0),
  vec3(0.0, 0.0, 1.0),
  vec3(0.707106769, 0.0, 0.707106769),
  vec3(0.353553385, 0.612372458, 0.707106769),
  vec3(-0.353553444, 0.612372458, 0.707106769),
  vec3(-0.707106769, -6.18172393e-8, 0.707106769),
  vec3(-0.353553325, -0.612372518, 0.707106769),
  vec3(0.353553355, -0.612372458, 0.707106769),
  vec3(1.0, 0.0, -4.37113883e-8),
  vec3(0.49999997, 0.866025448, -4.37113883e-8),
  vec3(-0.50000006, 0.866025388, -4.37113883e-8),
  vec3(-1.0, -8.74227766e-8, -4.37113883e-8),
  vec3(-0.499999911, -0.866025448, -4.37113883e-8),
  vec3(0.499999911, -0.866025448, -4.37113883e-8),
];

let s_probeTime = 0;
let s_probeIndex = 0;
const s_probeResults: Vec3[] = REVERB_PROBES.map(() => vec3());
let s_probeAvg = 8192;

let s_currentPreset = REVERB_PRESET_PLAIN;
let s_activeParams: EfxReverbParamsT = copyReverbParams(REVERB_PRESETS[REVERB_PRESET_PLAIN]);
let s_lerpTo: EfxReverbParamsT = copyReverbParams(REVERB_PRESETS[REVERB_PRESET_PLAIN]);
let s_lerpResult: EfxReverbParamsT = copyReverbParams(REVERB_PRESETS[REVERB_PRESET_PLAIN]);
let s_lerpStart = 0;
let s_lerpEnd = 0; // 0 means "not lerping" (al.c's s_reverb_lerp_time doing double duty as a bool)

export let reverbCvar: CvarT | null = null;
export let reverbLerpTimeCvar: CvarT | null = null;

/*
=================
S_ReverbInit

Registers al_reverb/al_reverb_lerp_time as real consumers. Both cvars were
already registered "consumer unported" by S_Init (snd_dma.ts:162-163,
divergence-audit finding #12's neighboring dead registrations) -- this
function re-Cvar_Get's them (Cvar_Get on an existing name returns the same
CvarT) and stores the handles this module reads every frame.
=================
*/
// al.c:576-579's al_reverb_changed calls S_StopAllSounds() whenever al_reverb
// is toggled, purely to force every AL source to re-issue its
// AL_AUXILIARY_SEND_FILTER binding (al.c:892-896) against the now-on/off
// reverb slot -- an OpenAL routing detail with no equivalent in this port's
// paintbuffer-based DSP (GetActiveReverbParams() below is read fresh every
// mix pass, so toggling al_reverb takes effect on the very next block with
// no re-routing step needed). Not ported; no `.changed` callback is attached.
export function S_ReverbInit(): void {
  reverbCvar = Cvar_Get("al_reverb", "1", 0);
  reverbLerpTimeCvar = Cvar_Get("al_reverb_lerp_time", "3.0", 0);
}

function reverbEnabled(): boolean {
  return (reverbCvar ? reverbCvar.value : 1) !== 0;
}

/*
=================
S_LoadReverbEnvironments

al.c:478-517's AL_LoadReverbEnvironments, without the Z_TagMalloc arena (this
port's arrays are plain GC'd allocations) and without the free-then-reload
wrapper (AL_EndRegistration's job -- see S_ReverbEndRegistration below).
=================
*/
export function S_LoadReverbEnvironments(): void {
  const buf = FS_LoadFile("sound/default.environments");
  if (!buf) {
    s_environments = null;
    return;
  }
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("utf8");
  s_environments = ParseEnvironmentsFile(text);
}

/*
=================
S_ReverbEndRegistration

al.c:1311-1336's AL_EndRegistration: reload sound/default.environments fresh
for the new map, reset the active environment to the LARGEST-dimension entry
(index length-1 -- environments are ascending by "dimension" per-file, matched
by AL_EstimateDimensions's own threshold walk assumption, verified against the
real retail file: 200/500/800/900/1200/1600/2000/2001), reset probe state
(s_reverb_probe_avg = 8192, the probe array's own max plausible dimension),
and snap the current preset straight to PLAIN with no lerp in progress.
=================
*/
export function S_ReverbEndRegistration(): void {
  S_LoadReverbEnvironments();

  if (!s_environments || s_environments.length === 0) return;

  s_currentPreset = REVERB_PRESET_PLAIN;
  s_activeParams = copyReverbParams(REVERB_PRESETS[REVERB_PRESET_PLAIN]);
  s_lerpResult = copyReverbParams(REVERB_PRESETS[REVERB_PRESET_PLAIN]);
  s_lerpStart = 0;
  s_lerpEnd = 0;

  s_probeTime = 0;
  s_probeIndex = 0;
  for (const r of s_probeResults) VectorClear(r);
  s_probeAvg = 8192;

  s_activeEnvironmentIndex = s_environments.length - 1;
}

// al.c's S_StopAllSounds()/snd_restart equivalent for this module: drop back
// to "no environments loaded" so GetActiveReverbParams bypasses cleanly.
export function S_ReverbShutdown(): void {
  s_environments = null;
}

/*
=================
estimateDimensions

al.c:188-239's AL_EstimateDimensions. One probe direction per call (throttled
to roughly once every 13ms of cl.time, matching al.c's own `cl.time + 13`
gate), accumulating a running bounding box across all 14 directions; the
scalar "dimension" used for environment selection is the average of that
box's three axis extents.
=================
*/
function estimateDimensions(listenerOrigin: Vec3, clTime: number): boolean {
  if (!s_environments || s_environments.length === 0) return false;
  if (s_probeTime > clTime) return false;

  s_probeTime = clTime + 13;

  const end = vec3();
  VectorMA(listenerOrigin, 8192.0, REVERB_PROBES[s_probeIndex], end);

  const tr = CM_BoxTrace(listenerOrigin, end, vec3(), vec3(), 0, MASK_SOLID);
  VectorSubtract(tr.endpos, listenerOrigin, s_probeResults[s_probeIndex]);

  if (s_probeIndex === 1 && tr.surface && (tr.surface.flags & SURF_SKY) !== 0) {
    s_probeResults[s_probeIndex][2] += 4096;
  }

  const mins = vec3();
  const maxs = vec3();
  ClearBounds(mins, maxs);
  for (const r of s_probeResults) AddPointToBounds(r, mins, maxs);

  const extents = vec3();
  VectorSubtract(maxs, mins, extents);
  s_probeAvg = (extents[0] + extents[1] + extents[2]) / 3.0;

  s_probeIndex = (s_probeIndex + 1) % REVERB_PROBES.length;

  const next = SelectEnvironmentIndex(s_environments, s_activeEnvironmentIndex, s_probeAvg);
  const changed = next !== s_activeEnvironmentIndex;
  s_activeEnvironmentIndex = next;
  return changed;
}

/*
=================
SelectEnvironmentIndex

Pure form of al.c:222-236's threshold walk out of AL_EstimateDimensions:
given the environments array (ASCENDING by "dimension", verified against the
real retail sound/default.environments -- 200/500/800/900/1200/1600/2000/2001),
the currently active index, and a newly measured room-size estimate, returns
the index the walk settles on. Grows the index while the estimate exceeds the
CURRENT entry's own dimension (and it isn't already the last entry); only if
that grew nothing does it shrink the index while the estimate is below the
entry BELOW the current one. Exported standalone (not inlined into
estimateDimensions) so this decision can be unit-tested without a loaded
world/trace fixture.
=================
*/
export function SelectEnvironmentIndex(
  environments: readonly ReverbEnvironmentT[],
  currentIndex: number,
  probeAvg: number,
): number {
  let index = currentIndex;
  let changed = false;

  while (index !== environments.length - 1 && probeAvg > environments[index].dimension) {
    index++;
    changed = true;
  }
  if (!changed) {
    while (index !== 0 && probeAvg < environments[index - 1].dimension) {
      index--;
    }
  }

  return index;
}

// al.c:241-247's AL_CalculateReverbFrac -- cubic ease-out.
function calculateReverbFrac(clTime: number): number {
  const frac = (clTime - s_lerpStart) / (s_lerpEnd - s_lerpStart);
  const bfrac = 1.0 - frac;
  const f = 1.0 - bfrac * bfrac * bfrac;
  return Math.min(1, Math.max(0, f));
}

function lerpParams(a: EfxReverbParamsT, b: EfxReverbParamsT, f: number, out: EfxReverbParamsT): void {
  out.density = a.density + f * (b.density - a.density);
  out.diffusion = a.diffusion + f * (b.diffusion - a.diffusion);
  out.gain = a.gain + f * (b.gain - a.gain);
  out.gainHF = a.gainHF + f * (b.gainHF - a.gainHF);
  out.gainLF = a.gainLF + f * (b.gainLF - a.gainLF);
  out.decayTime = a.decayTime + f * (b.decayTime - a.decayTime);
  out.decayHFRatio = a.decayHFRatio + f * (b.decayHFRatio - a.decayHFRatio);
  out.decayLFRatio = a.decayLFRatio + f * (b.decayLFRatio - a.decayLFRatio);
  out.reflectionsGain = a.reflectionsGain + f * (b.reflectionsGain - a.reflectionsGain);
  out.reflectionsDelay = a.reflectionsDelay + f * (b.reflectionsDelay - a.reflectionsDelay);
  out.lateReverbGain = a.lateReverbGain + f * (b.lateReverbGain - a.lateReverbGain);
  out.lateReverbDelay = a.lateReverbDelay + f * (b.lateReverbDelay - a.lateReverbDelay);
  out.echoTime = a.echoTime + f * (b.echoTime - a.echoTime);
  out.echoDepth = a.echoDepth + f * (b.echoDepth - a.echoDepth);
  out.modulationTime = a.modulationTime + f * (b.modulationTime - a.modulationTime);
  out.modulationDepth = a.modulationDepth + f * (b.modulationDepth - a.modulationDepth);
  out.airAbsorptionGainHF = a.airAbsorptionGainHF + f * (b.airAbsorptionGainHF - a.airAbsorptionGainHF);
  out.hfReference = a.hfReference + f * (b.hfReference - a.hfReference);
  out.lfReference = a.lfReference + f * (b.lfReference - a.lfReference);
  out.roomRolloffFactor = a.roomRolloffFactor + f * (b.roomRolloffFactor - a.roomRolloffFactor);
  out.decayHFLimit = f >= 0.5 ? b.decayHFLimit : a.decayHFLimit; // iDecayHFLimit is a bool; al.c LERPs it as an int (harmless, since it's never read mid-lerp) -- snapped at the midpoint here instead of carrying a meaningless fractional int
}

/*
=================
SelectPresetForMaterial

Pure form of al.c:266-293's floor-material preset pick out of
AL_UpdateReverb: given the active environment's ordered `reverbs` list, the
hit surface's material name (null when the floor probe found no ground,
al.c's `tr.fraction >= 1.0` branch), and the currently-active preset (used
as-is when nothing in the list matches, matching al.c's own `new_preset =
s_reverb_current_preset;` starting value), returns the preset index the pick
settles on. A `null` materials entry (the JSON "*" wildcard) matches
unconditionally; otherwise the first entry whose materials list contains the
hit material (case-insensitive, matching this port's Q_stricmp convention
for surface-material comparisons elsewhere, e.g. cmodel.ts's own
CMod_LoadMaterials) wins. Exported standalone so this decision can be
unit-tested without a loaded world/trace fixture.
=================
*/
export function SelectPresetForMaterial(
  environment: ReverbEnvironmentT,
  hitMaterial: string | null,
  currentPreset: number,
): number {
  if (hitMaterial === null) return REVERB_PRESET_PLAIN;

  for (const entry of environment.reverbs) {
    if (entry.materials === null) return entry.presetIndex;
    if (entry.materials.some((m) => Q_stricmp(m, hitMaterial) === 0)) return entry.presetIndex;
  }

  return currentPreset;
}

/*
=================
S_UpdateReverb

al.c:249-349's AL_UpdateReverb: room-dimension probing, the floor-material
preset pick, and the cubic-ease preset-to-preset lerp. Produces the
interpolated EfxReverbParamsT the DSP (snd_reverb_dsp.ts) reads every mix
pass via GetActiveReverbParams().

Floor probe: q2repro sweeps a small box 256 units straight down from just
above the listener and matches the hit surface's material name against the
active environment's ordered `reverbs` list (first match wins; a `null`
materials entry -- the JSON "*" wildcard -- matches unconditionally). This
port does the same box trace with the OBVIOUSLY INTENDED geometry -- see this
file's header comment for the real al.c call's mins/maxs/end argument-order
bug, which is NOT reproduced here.
=================
*/
export function S_UpdateReverb(listenerOrigin: Vec3, clTime: number): void {
  if (!s_environments || s_environments.length === 0) return;

  estimateDimensions(listenerOrigin, clTime);

  const mins = vec3(-16, -16, 0);
  const maxs = vec3(16, 16, 0);
  const start = vec3(listenerOrigin[0], listenerOrigin[1], listenerOrigin[2] + 1.0);
  const end = vec3(start[0], start[1], start[2] - 256.0);
  const tr = CM_BoxTrace(start, end, mins, maxs, 0, MASK_SOLID);

  const activeEnv = s_environments[s_activeEnvironmentIndex];
  const hitMaterial = tr.fraction < 1.0 && tr.surface ? tr.surface.material : null;
  const newPreset = SelectPresetForMaterial(activeEnv, hitMaterial, s_currentPreset);

  if (newPreset !== s_currentPreset) {
    s_currentPreset = newPreset;

    if (s_lerpEnd) {
      s_activeParams = copyReverbParams(s_lerpResult);
    }

    s_lerpStart = clTime;
    const lerpSeconds = reverbLerpTimeCvar ? reverbLerpTimeCvar.value : 3.0;
    s_lerpEnd = clTime + lerpSeconds * 1000;
    s_lerpTo = copyReverbParams(REVERB_PRESETS[s_currentPreset]);
  }

  if (s_lerpEnd) {
    if (clTime >= s_lerpEnd) {
      s_lerpEnd = 0;
      s_activeParams = copyReverbParams(s_lerpTo);
    } else {
      const f = calculateReverbFrac(clTime);
      lerpParams(s_activeParams, s_lerpTo, f, s_lerpResult);
    }
  }
}

/*
=================
GetActiveReverbParams

Accessor for snd_reverb_dsp.ts: null when reverb is disabled (al_reverb 0) or
no sound/default.environments data is loaded for the current map, matching
al.c:892-896's `if (cl.bsp && s_reverb_slot && al_reverb->integer)` routing
gate -- the DSP should bypass entirely rather than apply a stale/default
reverb.
=================
*/
export function GetActiveReverbParams(): EfxReverbParamsT | null {
  if (!s_environments || s_environments.length === 0) return null;
  if (!reverbEnabled()) return null;
  return s_lerpEnd ? s_lerpResult : s_activeParams;
}

// Test-only accessors (not called by engine code) -- exposes selection state
// without reaching into module-private variables from test files.
export function ReverbDebugState(): {
  environments: readonly ReverbEnvironmentT[] | null;
  activeEnvironmentIndex: number;
  currentPreset: number;
  probeAvg: number;
} {
  return {
    environments: s_environments,
    activeEnvironmentIndex: s_activeEnvironmentIndex,
    currentPreset: s_currentPreset,
    probeAvg: s_probeAvg,
  };
}
