/*
cl_fog.ts -- client-side fog state for the re-release's svc_fog message.

No .c analog in the 1997 id Software client (vanilla Quake 2 has no fog at
all). This is q2repro's split across two files, gathered into one module:

  * src/client/view.c:482-528  V_FogParamsChanged() -- folds one decoded
    svc_fog into the persistent TARGET params, field by field, honouring
    the message's per-field presence bits, and arms the transition timer.
  * src/client/view.c:616-651  the block inside V_RenderView() that writes
    cl.refdef.fog / cl.refdef.heightfog, either straight from the target
    (no transition running) or LERP2'd between start and target.
  * src/client/client.h:400    `cl_fog_params_t start, end;` plus
    lerp_time / lerp_time_start, held in the `cl` struct.

Kept as its own module with module-private state rather than widening
client.ts's `cl`: the reset hook (CL_ClearFog, called from cl_parse.ts's
svc_serverdata handling) is the only thing memset-of-`cl` bought q2repro,
and an explicit call is clearer than an implicit struct-wide clear.

Every value here is in the RENDERER's units, i.e. already converted out of
the wire encoding by CL_FogParamsChanged below -- colors and sky factor as
0..1 fractions, densities/falloff as raw floats, heights as world Z. That
conversion is q2proto's (q2proto_coords.c:552/607: a color component and a
byte fraction are both `b / 255`, a float fraction and an unscaled i32
coord are passed through), applied at the point cl_parse.ts hands the
decoded message over.

THE TRANSITION IS THE CLIENT'S JOB. The server sends one svc_fog carrying
a duration in milliseconds (SvcFogDataBitsT.BIT_TIME); nothing further
arrives while the fade runs. q2repro's view.c does the interpolation
locally against cl.time, and so does this.
*/

import { SvcFogDataBitsT, type SvcFogDataT } from "../kexapi/game";
import { FogGlobalT, FogHeightT } from "./ref";

// q2repro client.h:208-212's `cl_fog_params_t` -- the two refdef structs
// paired, because the transition interpolates them together.
export interface FogParamsT {
  linear: FogGlobalT;
  height: FogHeightT;
}

export function makeFogParams(): FogParamsT {
  return { linear: new FogGlobalT(), height: new FogHeightT() };
}

export function copyFogParams(src: FogParamsT, dst: FogParamsT): void {
  dst.linear.color[0] = src.linear.color[0];
  dst.linear.color[1] = src.linear.color[1];
  dst.linear.color[2] = src.linear.color[2];
  dst.linear.density = src.linear.density;
  dst.linear.skyFactor = src.linear.skyFactor;

  for (let i = 0; i < 3; i++) {
    dst.height.start.color[i] = src.height.start.color[i];
    dst.height.end.color[i] = src.height.end.color[i];
  }
  dst.height.start.dist = src.height.start.dist;
  dst.height.end.dist = src.height.end.dist;
  dst.height.density = src.height.density;
  dst.height.falloff = src.height.falloff;
}

// shared.h:218 -- `#define LERP2(a, b, c, d) ((a)*(c)+(b)*(d))`, used by
// view.c's Q_FP/Q_HFP macros with (backlerp, frontlerp).
function lerp2(a: number, b: number, backlerp: number, frontlerp: number): number {
  return a * backlerp + b * frontlerp;
}

/*
====================
lerpFogParams

view.c:620-648's Q_FP/Q_HFP expansion, as a pure function so the mapping
is unit-testable without a client. EVERY field is interpolated, including
the two height-fog distances and the falloff -- q2repro interpolates them
too, which is why a transition that moves the band also slides it rather
than snapping.
====================
*/
export function lerpFogParams(start: FogParamsT, end: FogParamsT, frontlerp: number, out: FogParamsT): void {
  const backlerp = 1 - frontlerp;

  for (let i = 0; i < 3; i++) {
    out.linear.color[i] = lerp2(start.linear.color[i], end.linear.color[i], backlerp, frontlerp);
    out.height.start.color[i] = lerp2(start.height.start.color[i], end.height.start.color[i], backlerp, frontlerp);
    out.height.end.color[i] = lerp2(start.height.end.color[i], end.height.end.color[i], backlerp, frontlerp);
  }
  out.linear.density = lerp2(start.linear.density, end.linear.density, backlerp, frontlerp);
  out.linear.skyFactor = lerp2(start.linear.skyFactor, end.linear.skyFactor, backlerp, frontlerp);

  out.height.start.dist = lerp2(start.height.start.dist, end.height.start.dist, backlerp, frontlerp);
  out.height.end.dist = lerp2(start.height.end.dist, end.height.end.dist, backlerp, frontlerp);
  out.height.density = lerp2(start.height.density, end.height.density, backlerp, frontlerp);
  out.height.falloff = lerp2(start.height.falloff, end.height.falloff, backlerp, frontlerp);
}

// --- module state (q2repro's cl.fog: client.h:398-402) -------------------

export interface FogStateT {
  start: FogParamsT;
  end: FogParamsT;
  lerpTime: number; // ms; 0 == no transition running
  lerpTimeStart: number; // cl.time the transition was armed at
}

function makeFogState(): FogStateT {
  return { start: makeFogParams(), end: makeFogParams(), lerpTime: 0, lerpTimeStart: 0 };
}

let fogState: FogStateT = makeFogState();

export function CL_FogState(): FogStateT {
  return fogState;
}

/*
====================
CL_ClearFog

No q2repro analog by name: there, `cl` is memset by CL_ClearState (client
side of svc_serverdata / a new map), which zeroes cl.fog along with
everything else. Called from cl_parse.ts's svc_serverdata handling so a
map with no worldspawn fog keys starts unfogged instead of inheriting the
previous map's values.
====================
*/
export function CL_ClearFog(): void {
  fogState = makeFogState();
}

/*
====================
CL_FogParamsChanged

q2repro view.c:482-528, with its four separate bit arguments (message
flags, and one per-component delta mask for each of the three colors)
collapsed back into the single wire `bits` word this port's decoder
already carries -- q2proto splits that word into flags + delta_bits inside
its reader (q2proto_proto_q2repro.c's delta_bits_check /
fog_color_bits_check) purely because its public struct predates the
re-release layout; every branch below tests exactly the wire bit that
q2proto's split was derived from.

`timeMs` semantics, verbatim from view.c:484-492: a NON-ZERO transition
time snapshots the current TARGET into `start` and arms the timer against
`clTime`; zero disarms any running transition and lets the new values take
effect immediately. Note that the snapshot takes the target, not the
currently displayed interpolation -- a second message arriving mid-fade
therefore restarts from where the first fade was heading, not from what is
on screen. That is q2repro's behavior and the re-release's; preserved on
purpose.
====================
*/
export function CL_FogParamsChanged(fog: SvcFogDataT, clTime: number): void {
  const bits = fog.bits;

  if (fog.bits & SvcFogDataBitsT.BIT_TIME && fog.time !== 0) {
    copyFogParams(fogState.end, fogState.start);
    fogState.lerpTime = fog.time;
    fogState.lerpTimeStart = clTime;
  } else {
    fogState.lerpTime = 0;
  }

  const cur = fogState.end;

  // parse.c:1163-1167 -- one bit covers density AND sky factor; the sky
  // factor is a BYTE fraction on the wire (q2proto_var_fraction_set_byte),
  // the density a raw float.
  if (bits & SvcFogDataBitsT.BIT_DENSITY) {
    cur.linear.density = fog.density;
    cur.linear.skyFactor = fog.skyfactor / 255;
  }
  if (bits & SvcFogDataBitsT.BIT_R) cur.linear.color[0] = fog.red / 255;
  if (bits & SvcFogDataBitsT.BIT_G) cur.linear.color[1] = fog.green / 255;
  if (bits & SvcFogDataBitsT.BIT_B) cur.linear.color[2] = fog.blue / 255;

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_FALLOFF) cur.height.falloff = fog.hf_falloff;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_DENSITY) cur.height.density = fog.hf_density;

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_R) cur.height.start.color[0] = fog.hf_start_r / 255;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_G) cur.height.start.color[1] = fog.hf_start_g / 255;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_B) cur.height.start.color[2] = fog.hf_start_b / 255;
  // An unscaled i32 world Z (q2proto_var_coord_set_int_unscaled), NOT a
  // 1/8-unit coord: mgu6m1's worldspawn ships -328 / -349 and those are
  // literal world heights.
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_START_DIST) cur.height.start.dist = fog.hf_start_dist;

  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_R) cur.height.end.color[0] = fog.hf_end_r / 255;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_G) cur.height.end.color[1] = fog.hf_end_g / 255;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_B) cur.height.end.color[2] = fog.hf_end_b / 255;
  if (bits & SvcFogDataBitsT.BIT_HEIGHTFOG_END_DIST) cur.height.end.dist = fog.hf_end_dist;
}

/*
====================
CL_CurrentFog

view.c:616-650: the per-frame read the renderer sees. Writes into `out`
(the refdef's own fog structs) rather than allocating, exactly as
q2repro assigns into cl.refdef.fog / cl.refdef.heightfog.
====================
*/
const currentScratch = makeFogParams();

export function CL_CurrentFog(clTime: number, outLinear: FogGlobalT, outHeight: FogHeightT): void {
  const state = fogState;
  if (state.lerpTime === 0 || clTime > state.lerpTimeStart + state.lerpTime) {
    copyFogParams(state.end, currentScratch);
  } else {
    const frontlerp = (clTime - state.lerpTimeStart) / state.lerpTime;
    lerpFogParams(state.start, state.end, frontlerp, currentScratch);
  }
  copyFogParams(currentScratch, { linear: outLinear, height: outHeight });
}
