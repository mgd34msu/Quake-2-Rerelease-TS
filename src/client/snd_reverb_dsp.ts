// snd_reverb_dsp.ts -- from-scratch Freeverb-class stereo reverb, driven by
// the EFX-shaped parameters snd_environments.ts's S_UpdateReverb selects and
// interpolates.
//
// NOT a port of any q2repro/rerelease file. q2repro's own reverb DSP is
// entirely inside OpenAL/OpenAL-Soft's AL_EFFECT_EAXREVERB implementation --
// al.c (src/client/sound/al.c) only SELECTS which EFXEAXREVERBPROPERTIES
// preset applies and uploads the 22 scalar fields via qalEffectf/qalEffectfv
// (al.c:136-163's AL_LoadEffect); the actual reverberation algorithm lives in
// closed/vendor OpenAL-Soft C++ (not in q2repro's own source tree, and out of
// this port's reach regardless -- see this project's no-license-laundering
// rule). This port's audio backend (src/platform/snd.ts) is SDL PCM output
// feeding a from-scratch DMA-style software mixer with no OpenAL/EFX
// dependency at all, matching q2repro's OWN dma.c path, which never
// implements reverb (see snd_environments.ts's header comment). Mike's
// ruling (2026-08-31): since there's real retail preset DATA to honor but no
// portable reference ALGORITHM to port, drive an off-the-shelf DSP topology
// with that data instead.
//
// Topology: the classic "Freeverb" 8-comb/4-allpass-per-channel network
// (Jezar at Dreampoint, public domain -- "This code is public domain. ... You
// may use, modify, distribute this code however you want."; the specific
// delay-line tuning lengths below (combTuning/allpassTuning/STEREO_SPREAD)
// are that same long-public, widely-republished parameter set, not copied
// from any GPL/LGPL Freeverb wrapper implementation -- this file's actual
// code is written from scratch against that public-domain recipe, in this
// project's own conventions (fixed-point-scaled numbers matching the mixer's
// paintbuffer, no `any`, no `as`). Operates directly on snd_mix.ts's
// paintbuffer samples at their native <<8 fixed-point scale (same scale
// convention snd_mix.ts's underwater biquad filter already uses) -- a linear
// filter network produces the same relative output regardless of the input's
// fixed scale factor, so no rescaling is needed.
//
// PARAMETER COVERAGE (see this file's mapping functions below for the exact
// formulas; summarized here for the unit's report):
//
// HONORED (shapes the DSP output):
//   density, diffusion   -> allpass feedback coefficient (density blended in
//                           as a secondary weight; Freeverb's fixed 8-comb
//                           topology can't vary true echo DENSITY per se, so
//                           this is a coarse stand-in).
//   decayTime            -> per-comb feedback via the standard -60dB RT60
//                           formula (feedback = 10^(-3*delaySamples/(decayTime*rate))).
//   decayHFRatio         -> per-comb high-frequency damping coefficient
//                           (ratio<1 => faster HF decay => more damping;
//                           ratio>=1 clamps to "no extra damping" -- this
//                           simple one-pole damping network cannot BRIGHTEN
//                           the tail beyond the comb's own broadband decay,
//                           so presets with decayHFRatio>1, e.g. cave=1.3,
//                           parking_lot=1.5, lose their brightening).
//   gain, lateReverbGain,
//   reflectionsGain       -> combined into one wet output scalar (gain is
//                           CONSTANT at 0.3162 across all 26 real presets --
//                           verified against efx-presets.h -- so in practice
//                           only lateReverbGain/reflectionsGain differentiate
//                           presets here; reflectionsGain is folded in at a
//                           small weight since Freeverb has no discrete
//                           early-reflection tap to give it its own voice).
//   gainHF, hfReference    -> one-pole high-shelf on the WET signal only,
//                           corner frequency = hfReference (constant 5000Hz
//                           across all presets, same corner-frequency
//                           convention snd_mix.ts's underwater filter already
//                           uses).
//   lateReverbDelay        -> pre-delay (silence gap before the wet tail
//                           starts), a short circular buffer ahead of the
//                           comb network.
//   decayHFLimit           -> approximate: slightly raises the damping floor
//                           when true, matching EFX's internal
//                           decay-time/GainHF consistency clamp in spirit,
//                           not formula.
//
// DROPPED (either architecturally impossible in a comb/allpass network
// without a much larger DSP, or VERIFIED CONSTANT across all 26 real presets
// in efx-presets.h and therefore inert regardless of implementation effort):
//   gainLF, airAbsorptionGainHF, roomRolloffFactor, lfReference -- constant
//     (1.0 / 0.9943 / 0.0 / 250.0 Hz) in every one of the 26 presets.
//   reflectionsPan / lateReverbPan -- not carried into EfxReverbParamsT at
//     all (see snd_environments.ts's header comment); always {0,0,0} in
//     every preset, and meaningless for a 2-channel bus without full 3D
//     reverb panning.
//   echoTime / echoDepth -- discrete flutter-echo tap. No comb/allpass
//     topology has one. Most audible loss: ALLEY/FOREST/MOUNTAINS/QUARRY/
//     PLAIN/DIZZY (echoDepth 0.7-1.0 there; 0 or negligible everywhere else).
//   modulationTime / modulationDepth -- chorus-style pitch modulation of the
//     late tail. Not implemented. Most audible loss: DRUGGED/DIZZY/PSYCHOTIC
//     (modulationDepth 0.31-1.0 there; 0 everywhere else).
//   decayLFRatio -- constant 1.0 in every preset (no low-frequency-specific
//     decay shaping is ever actually requested by the retail data).

import { type EfxReverbParamsT } from "./snd_environments";

// Classic Freeverb tuning, in samples @44100Hz (Jezar at Dreampoint, public
// domain). Scaled by the mixer's actual sample rate at (re)initialization.
const COMB_TUNING_L = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING_L = [556, 441, 341, 225];
const STEREO_SPREAD = 23;
const REFERENCE_RATE = 44100;
const MAX_PREDELAY_SECONDS = 0.3;

class CombFilter {
  buffer: Float64Array;
  index = 0;
  filterStore = 0;
  feedback = 0;
  damp1 = 0;
  damp2 = 1;

  constructor(length: number) {
    this.buffer = new Float64Array(Math.max(1, length));
  }

  process(input: number): number {
    const output = this.buffer[this.index];
    this.filterStore = output * this.damp2 + this.filterStore * this.damp1;
    this.buffer[this.index] = input + this.filterStore * this.feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }

  clear(): void {
    this.buffer.fill(0);
    this.filterStore = 0;
  }
}

class AllpassFilter {
  buffer: Float64Array;
  index = 0;
  feedback = 0.5;

  constructor(length: number) {
    this.buffer = new Float64Array(Math.max(1, length));
  }

  process(input: number): number {
    const bufout = this.buffer[this.index];
    const output = -input + bufout;
    this.buffer[this.index] = input + bufout * this.feedback;
    this.index = (this.index + 1) % this.buffer.length;
    return output;
  }

  clear(): void {
    this.buffer.fill(0);
  }
}

class ChannelNetwork {
  combs: CombFilter[];
  allpasses: AllpassFilter[];

  constructor(sampleRate: number, spread: number) {
    const scale = sampleRate / REFERENCE_RATE;
    this.combs = COMB_TUNING_L.map((n) => new CombFilter(Math.round((n + spread) * scale)));
    this.allpasses = ALLPASS_TUNING_L.map((n) => new AllpassFilter(Math.round((n + spread) * scale)));
  }

  process(input: number): number {
    let out = 0;
    for (const c of this.combs) out += c.process(input);
    for (const a of this.allpasses) out = a.process(out);
    return out;
  }

  clear(): void {
    for (const c of this.combs) c.clear();
    for (const a of this.allpasses) a.clear();
  }
}

let leftNet: ChannelNetwork | null = null;
let rightNet: ChannelNetwork | null = null;
let netSampleRate = 0;

let preDelayL: Float64Array = new Float64Array(1);
let preDelayR: Float64Array = new Float64Array(1);
let preDelayIndex = 0;
let preDelaySampleRate = 0;

// one-pole high-shelf state for the wet-only HF gain (gainHF/hfReference).
let shelfStateL = 0;
let shelfStateR = 0;
let shelfCoeffA = 0;
let shelfCoeffFreq = -1;
let shelfCoeffRate = 0;

function ensureNetworks(sampleRate: number): void {
  if (netSampleRate === sampleRate && leftNet && rightNet) return;
  netSampleRate = sampleRate;
  leftNet = new ChannelNetwork(sampleRate, 0);
  rightNet = new ChannelNetwork(sampleRate, STEREO_SPREAD);
  const predelayLen = Math.max(1, Math.round(MAX_PREDELAY_SECONDS * sampleRate));
  preDelayL = new Float64Array(predelayLen);
  preDelayR = new Float64Array(predelayLen);
  preDelaySampleRate = sampleRate;
  preDelayIndex = 0;
  shelfStateL = 0;
  shelfStateR = 0;
  shelfCoeffFreq = -1;
}

function combFeedbackForDecay(decayTime: number, delaySamples: number, sampleRate: number): number {
  const dt = Math.max(0.001, decayTime);
  const g = Math.pow(10, (-3 * delaySamples) / (dt * sampleRate));
  return Math.min(0.98, Math.max(0, g));
}

function dampingForHFRatio(decayHFRatio: number, decayHFLimit: boolean): number {
  // decayHFRatio < 1 => HF decays faster than the broadband decay => more
  // damping; >= 1 (this simple damping stage can't brighten beyond the
  // comb's own broadband decay) => no extra damping applied.
  let damping = Math.min(1, Math.max(0, 1 - decayHFRatio));
  if (decayHFLimit) damping = Math.min(1, damping + 0.05);
  return damping;
}

function updateShelfCoeff(freqHz: number, sampleRate: number): void {
  if (shelfCoeffFreq === freqHz && shelfCoeffRate === sampleRate) return;
  shelfCoeffFreq = freqHz;
  shelfCoeffRate = sampleRate;
  // one-pole low-pass corner coefficient; used as the "low band" half of the
  // shelf blend in reverbProcessSample below.
  const clampedFreq = Math.min(sampleRate * 0.45, Math.max(20, freqHz));
  shelfCoeffA = 1 - Math.exp((-2 * Math.PI * clampedFreq) / sampleRate);
}

/*
=================
S_ReverbProcessBlock

Applies the reverb DSP to `count` paintbuffer samples starting at `offset`,
ADDING the wet signal onto the existing (dry) samples in place. `left`/
`right` are parallel arrays the caller (snd_mix.ts) indexes the same way it
already indexes its paintbuffer (kept as plain number arrays here rather than
importing PortableSamplepairT, to avoid a dependency from this pure-DSP
module back onto the mixer's own paint buffer type).
=================
*/
export function S_ReverbProcessBlock(
  params: EfxReverbParamsT,
  sampleRate: number,
  left: Float64Array,
  right: Float64Array,
  count: number,
): void {
  ensureNetworks(sampleRate);
  if (!leftNet || !rightNet) return;

  // Per-block coefficient refresh (cheap relative to the per-sample comb
  // work below; parameters only change once per lerp step in practice).
  const combGains: number[] = [];
  for (const c of leftNet.combs) combGains.push(combFeedbackForDecay(params.decayTime, c.buffer.length, sampleRate));
  const damping = dampingForHFRatio(params.decayHFRatio, params.decayHFLimit);
  const damp2 = damping;
  const damp1 = 1 - damping;

  for (let i = 0; i < leftNet.combs.length; i++) {
    const fb = combGains[i];
    leftNet.combs[i].feedback = fb;
    leftNet.combs[i].damp1 = damp1;
    leftNet.combs[i].damp2 = damp2;
    rightNet.combs[i].feedback = fb;
    rightNet.combs[i].damp1 = damp1;
    rightNet.combs[i].damp2 = damp2;
  }

  const diffusionBlend = Math.min(1, Math.max(0, params.diffusion * 0.7 + params.density * 0.3));
  const allpassFeedback = 0.6 * diffusionBlend;
  for (const a of leftNet.allpasses) a.feedback = allpassFeedback;
  for (const a of rightNet.allpasses) a.feedback = allpassFeedback;

  updateShelfCoeff(params.hfReference, sampleRate);

  // gain is a fixed 0.3162 constant across every real preset (see this
  // file's header comment); still applied for completeness/correctness if a
  // future .environments file ever varies it.
  const wetLevel = params.gain * (params.lateReverbGain + 0.25 * params.reflectionsGain);
  const WET_CALIBRATION = 0.12; // empirical mix-level constant, not derived from EFX (see header comment)
  const wetGain = Math.min(4, Math.max(0, wetLevel)) * WET_CALIBRATION;

  const preDelaySamples = Math.min(
    preDelayL.length - 1,
    Math.max(0, Math.round(params.lateReverbDelay * sampleRate)),
  );

  for (let i = 0; i < count; i++) {
    const dryL = left[i];
    const dryR = right[i];

    // pre-delay write/read (circular buffer)
    const readIndex = (preDelayIndex - preDelaySamples + preDelayL.length) % preDelayL.length;
    const delayedL = preDelayL[readIndex];
    const delayedR = preDelayR[readIndex];
    preDelayL[preDelayIndex] = dryL;
    preDelayR[preDelayIndex] = dryR;
    preDelayIndex = (preDelayIndex + 1) % preDelayL.length;

    let wetL = leftNet.process(delayedL * 0.015);
    let wetR = rightNet.process(delayedR * 0.015);

    // one-pole high-shelf: low band passes flat, high band attenuated to
    // gainHF (see header comment -- HONORED gainHF/hfReference entry).
    shelfStateL += shelfCoeffA * (wetL - shelfStateL);
    shelfStateR += shelfCoeffA * (wetR - shelfStateR);
    wetL = shelfStateL + params.gainHF * (wetL - shelfStateL);
    wetR = shelfStateR + params.gainHF * (wetR - shelfStateR);

    left[i] = dryL + wetL * wetGain;
    right[i] = dryR + wetR * wetGain;
  }
}

export function S_ReverbDspReset(): void {
  leftNet?.clear();
  rightNet?.clear();
  preDelayL.fill(0);
  preDelayR.fill(0);
  preDelayIndex = 0;
  shelfStateL = 0;
  shelfStateR = 0;
}
