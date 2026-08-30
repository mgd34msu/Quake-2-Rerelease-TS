/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/q_shared.h and game/q_shared.c (GNU GPL v2 or later).
*/

// MATHLIB — vector/angle/plane helpers and COM_ string helpers from q_shared.h/.c.

import { PITCH, YAW, ROLL, M_PI, type CplaneT } from "./q_shared";

export type Vec3 = Float32Array;
export type Vec5 = Float32Array;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  const v = new Float32Array(3);
  v[0] = x;
  v[1] = y;
  v[2] = z;
  return v;
}

export const vec3_origin: Vec3 = vec3(0, 0, 0);

//============================================================================
// vector macros (DotProduct, VectorSubtract, VectorAdd, VectorCopy, VectorClear,
// VectorNegate, VectorSet) — ported as real functions since TS has no macros.

export function DotProduct(x: Vec3, y: Vec3): number {
  return x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
}

export function VectorSubtract(a: Vec3, b: Vec3, c: Vec3): void {
  c[0] = a[0] - b[0];
  c[1] = a[1] - b[1];
  c[2] = a[2] - b[2];
}

export function VectorAdd(a: Vec3, b: Vec3, c: Vec3): void {
  c[0] = a[0] + b[0];
  c[1] = a[1] + b[1];
  c[2] = a[2] + b[2];
}

export function VectorCopy(a: Vec3, b: Vec3): void {
  b[0] = a[0];
  b[1] = a[1];
  b[2] = a[2];
}

export function VectorClear(a: Vec3): void {
  a[0] = a[1] = a[2] = 0;
}

export function VectorNegate(a: Vec3, b: Vec3): void {
  b[0] = -a[0];
  b[1] = -a[1];
  b[2] = -a[2];
}

export function VectorSet(v: Vec3, x: number, y: number, z: number): void {
  v[0] = x;
  v[1] = y;
  v[2] = z;
}

export function VectorMA(veca: Vec3, scale: number, vecb: Vec3, vecc: Vec3): void {
  vecc[0] = veca[0] + scale * vecb[0];
  vecc[1] = veca[1] + scale * vecb[1];
  vecc[2] = veca[2] + scale * vecb[2];
}

// just in case you don't want to use the macros
export function _DotProduct(v1: Vec3, v2: Vec3): number {
  return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

export function _VectorSubtract(veca: Vec3, vecb: Vec3, out: Vec3): void {
  out[0] = veca[0] - vecb[0];
  out[1] = veca[1] - vecb[1];
  out[2] = veca[2] - vecb[2];
}

export function _VectorAdd(veca: Vec3, vecb: Vec3, out: Vec3): void {
  out[0] = veca[0] + vecb[0];
  out[1] = veca[1] + vecb[1];
  out[2] = veca[2] + vecb[2];
}

export function _VectorCopy(vin: Vec3, out: Vec3): void {
  out[0] = vin[0];
  out[1] = vin[1];
  out[2] = vin[2];
}

export function ClearBounds(mins: Vec3, maxs: Vec3): void {
  mins[0] = mins[1] = mins[2] = 99999;
  maxs[0] = maxs[1] = maxs[2] = -99999;
}

export function AddPointToBounds(v: Vec3, mins: Vec3, maxs: Vec3): void {
  for (let i = 0; i < 3; i++) {
    const val = v[i];
    if (val < mins[i]) mins[i] = val;
    if (val > maxs[i]) maxs[i] = val;
  }
}

// declared `int` in q_shared.h (not qboolean); kept as 0/1 to match the header exactly
export function VectorCompare(v1: Vec3, v2: Vec3): number {
  if (v1[0] !== v2[0] || v1[1] !== v2[1] || v1[2] !== v2[2]) return 0;
  return 1;
}

export function VectorLength(v: Vec3): number {
  let length = 0;
  for (let i = 0; i < 3; i++) length += v[i] * v[i];
  return Math.sqrt(length);
}

export function CrossProduct(v1: Vec3, v2: Vec3, cross: Vec3): void {
  cross[0] = v1[1] * v2[2] - v1[2] * v2[1];
  cross[1] = v1[2] * v2[0] - v1[0] * v2[2];
  cross[2] = v1[0] * v2[1] - v1[1] * v2[0];
}

export function VectorNormalize(v: Vec3): number {
  let length = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  length = Math.sqrt(length);

  if (length) {
    const ilength = 1 / length;
    v[0] *= ilength;
    v[1] *= ilength;
    v[2] *= ilength;
  }

  return length;
}

export function VectorNormalize2(v: Vec3, out: Vec3): number {
  let length = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  length = Math.sqrt(length);

  if (length) {
    const ilength = 1 / length;
    out[0] = v[0] * ilength;
    out[1] = v[1] * ilength;
    out[2] = v[2] * ilength;
  }

  return length;
}

export function VectorInverse(v: Vec3): void {
  v[0] = -v[0];
  v[1] = -v[1];
  v[2] = -v[2];
}

export function VectorScale(vin: Vec3, scale: number, out: Vec3): void {
  out[0] = vin[0] * scale;
  out[1] = vin[1] * scale;
  out[2] = vin[2] * scale;
}

export function Q_log2(val: number): number {
  let v = val;
  let answer = 0;
  while ((v >>= 1)) answer++;
  return answer;
}

//============================================================================
// matrices: float[3][3] and float[3][4] become arrays of rows.

export type Mat3 = [Vec3, Vec3, Vec3];
export type Mat3x4 = [Float32Array, Float32Array, Float32Array];

export function R_ConcatRotations(in1: Mat3, in2: Mat3, out: Mat3): void {
  out[0][0] = in1[0][0] * in2[0][0] + in1[0][1] * in2[1][0] + in1[0][2] * in2[2][0];
  out[0][1] = in1[0][0] * in2[0][1] + in1[0][1] * in2[1][1] + in1[0][2] * in2[2][1];
  out[0][2] = in1[0][0] * in2[0][2] + in1[0][1] * in2[1][2] + in1[0][2] * in2[2][2];
  out[1][0] = in1[1][0] * in2[0][0] + in1[1][1] * in2[1][0] + in1[1][2] * in2[2][0];
  out[1][1] = in1[1][0] * in2[0][1] + in1[1][1] * in2[1][1] + in1[1][2] * in2[2][1];
  out[1][2] = in1[1][0] * in2[0][2] + in1[1][1] * in2[1][2] + in1[1][2] * in2[2][2];
  out[2][0] = in1[2][0] * in2[0][0] + in1[2][1] * in2[1][0] + in1[2][2] * in2[2][0];
  out[2][1] = in1[2][0] * in2[0][1] + in1[2][1] * in2[1][1] + in1[2][2] * in2[2][1];
  out[2][2] = in1[2][0] * in2[0][2] + in1[2][1] * in2[1][2] + in1[2][2] * in2[2][2];
}

export function R_ConcatTransforms(in1: Mat3x4, in2: Mat3x4, out: Mat3x4): void {
  out[0][0] = in1[0][0] * in2[0][0] + in1[0][1] * in2[1][0] + in1[0][2] * in2[2][0];
  out[0][1] = in1[0][0] * in2[0][1] + in1[0][1] * in2[1][1] + in1[0][2] * in2[2][1];
  out[0][2] = in1[0][0] * in2[0][2] + in1[0][1] * in2[1][2] + in1[0][2] * in2[2][2];
  out[0][3] = in1[0][0] * in2[0][3] + in1[0][1] * in2[1][3] + in1[0][2] * in2[2][3] + in1[0][3];
  out[1][0] = in1[1][0] * in2[0][0] + in1[1][1] * in2[1][0] + in1[1][2] * in2[2][0];
  out[1][1] = in1[1][0] * in2[0][1] + in1[1][1] * in2[1][1] + in1[1][2] * in2[2][1];
  out[1][2] = in1[1][0] * in2[0][2] + in1[1][1] * in2[1][2] + in1[1][2] * in2[2][2];
  out[1][3] = in1[1][0] * in2[0][3] + in1[1][1] * in2[1][3] + in1[1][2] * in2[2][3] + in1[1][3];
  out[2][0] = in1[2][0] * in2[0][0] + in1[2][1] * in2[1][0] + in1[2][2] * in2[2][0];
  out[2][1] = in1[2][0] * in2[0][1] + in1[2][1] * in2[1][1] + in1[2][2] * in2[2][1];
  out[2][2] = in1[2][0] * in2[0][2] + in1[2][1] * in2[1][2] + in1[2][2] * in2[2][2];
  out[2][3] = in1[2][0] * in2[0][3] + in1[2][1] * in2[1][3] + in1[2][2] * in2[2][3] + in1[2][3];
}

//============================================================================
// angles

export function AngleVectors(angles: Vec3, forward: Vec3 | null, right: Vec3 | null, up: Vec3 | null): void {
  let angle = angles[YAW] * ((M_PI * 2) / 360);
  const sy = Math.sin(angle);
  const cy = Math.cos(angle);
  angle = angles[PITCH] * ((M_PI * 2) / 360);
  const sp = Math.sin(angle);
  const cp = Math.cos(angle);
  angle = angles[ROLL] * ((M_PI * 2) / 360);
  const sr = Math.sin(angle);
  const cr = Math.cos(angle);

  if (forward) {
    forward[0] = cp * cy;
    forward[1] = cp * sy;
    forward[2] = -sp;
  }
  if (right) {
    right[0] = -1 * sr * sp * cy + -1 * cr * -sy;
    right[1] = -1 * sr * sp * sy + -1 * cr * cy;
    right[2] = -1 * sr * cp;
  }
  if (up) {
    up[0] = cr * sp * cy + -sr * -sy;
    up[1] = cr * sp * sy + -sr * cy;
    up[2] = cr * cp;
  }
}

export function ProjectPointOnPlane(dst: Vec3, p: Vec3, normal: Vec3): void {
  const inv_denom = 1.0 / DotProduct(normal, normal);
  const d = DotProduct(normal, p) * inv_denom;

  const n = vec3(normal[0] * inv_denom, normal[1] * inv_denom, normal[2] * inv_denom);

  dst[0] = p[0] - d * n[0];
  dst[1] = p[1] - d * n[1];
  dst[2] = p[2] - d * n[2];
}

/*
** assumes "src" is normalized
*/
export function PerpendicularVector(dst: Vec3, src: Vec3): void {
  let pos = 0;
  let minelem = 1.0;

  // find the smallest magnitude axially aligned vector
  for (let i = 0; i < 3; i++) {
    if (Math.abs(src[i]) < minelem) {
      pos = i;
      minelem = Math.abs(src[i]);
    }
  }
  const tempvec = vec3(0, 0, 0);
  tempvec[pos] = 1.0;

  // project the point onto the plane defined by src
  ProjectPointOnPlane(dst, tempvec, src);

  // normalize the result
  VectorNormalize(dst);
}

function DEG2RAD(a: number): number {
  return (a * M_PI) / 180.0;
}

export function RotatePointAroundVector(dst: Vec3, dir: Vec3, point: Vec3, degrees: number): void {
  const vf = vec3(dir[0], dir[1], dir[2]);
  const vr = vec3();
  PerpendicularVector(vr, dir);
  const vup = vec3();
  CrossProduct(vr, vf, vup);

  const m: Mat3 = [vec3(vr[0], vup[0], vf[0]), vec3(vr[1], vup[1], vf[1]), vec3(vr[2], vup[2], vf[2])];

  const im: Mat3 = [vec3(m[0][0], m[1][0], m[2][0]), vec3(m[0][1], m[1][1], m[2][1]), vec3(m[0][2], m[1][2], m[2][2])];

  const zrot: Mat3 = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];

  zrot[0][0] = Math.cos(DEG2RAD(degrees));
  zrot[0][1] = Math.sin(DEG2RAD(degrees));
  zrot[1][0] = -Math.sin(DEG2RAD(degrees));
  zrot[1][1] = Math.cos(DEG2RAD(degrees));

  const tmpmat: Mat3 = [vec3(), vec3(), vec3()];
  const rot: Mat3 = [vec3(), vec3(), vec3()];
  R_ConcatRotations(m, zrot, tmpmat);
  R_ConcatRotations(tmpmat, im, rot);

  for (let i = 0; i < 3; i++) {
    dst[i] = rot[i][0] * point[0] + rot[i][1] * point[1] + rot[i][2] * point[2];
  }
}

//============================================================================

export function Q_fabs(f: number): number {
  fabsFloat[0] = f;
  fabsInt[0] = fabsInt[0] & 0x7fffffff;
  return fabsFloat[0];
}
const fabsBuf = new ArrayBuffer(4);
const fabsInt = new Int32Array(fabsBuf);
const fabsFloat = new Float32Array(fabsBuf);

/*
NOTE: q_shared.h declares `LerpAngle(float a1, float a2, float frac)` but the
definition in q_shared.c names the same two positional parameters `a2, a1` —
purely a naming inconsistency in the original source. The parameter names below
match the .c definition verbatim; calling convention (first angle, second angle,
frac) is unaffected.
*/
export function LerpAngle(a2: number, a1: number, frac: number): number {
  let end = a1;
  if (end - a2 > 180) end -= 360;
  if (end - a2 < -180) end += 360;
  return a2 + frac * (end - a2);
}

export function anglemod(a: number): number {
  return (360.0 / 65536) * (Math.trunc(a * (65536 / 360.0)) & 65535);
}

// this is the slow, general version
export function BoxOnPlaneSide2(emins: Vec3, emaxs: Vec3, p: CplaneT): number {
  const corners: [Vec3, Vec3] = [vec3(), vec3()];

  for (let i = 0; i < 3; i++) {
    if (p.normal[i] < 0) {
      corners[0][i] = emins[i];
      corners[1][i] = emaxs[i];
    } else {
      corners[1][i] = emins[i];
      corners[0][i] = emaxs[i];
    }
  }
  const dist1 = DotProduct(p.normal, corners[0]) - p.dist;
  const dist2 = DotProduct(p.normal, corners[1]) - p.dist;
  let sides = 0;
  if (dist1 >= 0) sides = 1;
  if (dist2 < 0) sides |= 2;

  return sides;
}

/*
==================
BoxOnPlaneSide

Returns 1, 2, or 1 + 2
==================
*/
// portable path only; the `#else` branch (x86 __declspec(naked) asm) is dropped —
// see PORTING.md idiom map ("#ifdef id386 ... take the portable little-endian C path").
export function BoxOnPlaneSide(emins: Vec3, emaxs: Vec3, p: CplaneT): number {
  // fast axial cases
  if (p.type < 3) {
    if (p.dist <= emins[p.type]) return 1;
    if (p.dist >= emaxs[p.type]) return 2;
    return 3;
  }

  // general case
  let dist1: number;
  let dist2: number;
  switch (p.signbits) {
    case 0:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      break;
    case 1:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      break;
    case 2:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      break;
    case 3:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      break;
    case 4:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      break;
    case 5:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emaxs[2];
      break;
    case 6:
      dist1 = p.normal[0] * emaxs[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emins[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      break;
    case 7:
      dist1 = p.normal[0] * emins[0] + p.normal[1] * emins[1] + p.normal[2] * emins[2];
      dist2 = p.normal[0] * emaxs[0] + p.normal[1] * emaxs[1] + p.normal[2] * emaxs[2];
      break;
    default:
      // shut up compiler
      dist1 = dist2 = 0;
      break;
  }

  let sides = 0;
  if (dist1 >= p.dist) sides = 1;
  if (dist2 < p.dist) sides |= 2;

  return sides;
}

// BOX_ON_PLANE_SIDE macro: fast axial check inline, falls back to BoxOnPlaneSide.
export function BOX_ON_PLANE_SIDE(emins: Vec3, emaxs: Vec3, p: CplaneT): number {
  if (p.type < 3) {
    if (p.dist <= emins[p.type]) return 1;
    if (p.dist >= emaxs[p.type]) return 2;
    return 3;
  }
  return BoxOnPlaneSide(emins, emaxs, p);
}

//====================================================================================
// COM_ file-name helpers. C mutates buffers via out-parameters; these return the
// derived string instead since JS strings are immutable.

export function COM_SkipPath(pathname: string): string {
  const idx = pathname.lastIndexOf("/");
  return idx === -1 ? pathname : pathname.slice(idx + 1);
}

export function COM_StripExtension(inStr: string): string {
  const idx = inStr.indexOf(".");
  return idx === -1 ? inStr : inStr.slice(0, idx);
}

export function COM_FileExtension(inStr: string): string {
  const idx = inStr.indexOf(".");
  if (idx === -1) return "";
  // original exten[8] buffer holds at most 7 chars + terminator
  return inStr.slice(idx + 1, idx + 1 + 7);
}

export function COM_FileBase(inStr: string): string {
  const n = inStr.length;
  let s = n - 1;
  while (s > 0 && inStr[s] !== ".") s--;
  let s2 = s;
  while (s2 > 0 && inStr[s2] !== "/") s2--;
  if (s - s2 < 2) return "";
  return inStr.slice(s2 + 1, s);
}

export function COM_FilePath(inStr: string): string {
  const n = inStr.length;
  let s = n - 1;
  while (s > 0 && inStr[s] !== "/") s--;
  return inStr.slice(0, s);
}

export function COM_DefaultExtension(path: string, extension: string): string {
  let src = path.length - 1;
  // guarded with `src > 0` (not just `src !== 0`) to avoid running past the start
  // of an empty string, which the original pointer arithmetic does not protect against
  while (src > 0 && path[src] !== "/") {
    if (path[src] === ".") return path; // it has an extension
    src--;
  }
  return path + extension;
}

//==============================================
// COM_Parse

function charAt(s: string, idx: number): number {
  // mirrors reading a C null-terminated string: past the end reads as 0
  return idx < s.length ? s.charCodeAt(idx) : 0;
}

const MAX_TOKEN_CHARS = 128;

export interface ComParseState {
  data: string;
  index: number;
}

/*
==============
COM_Parse

Parse a token out of a string
==============
*/
export function COM_Parse(state: ComParseState): string {
  const s = state.data;
  let idx = state.index;
  let len = 0;
  let token = "";

  for (;;) {
    // skip whitespace
    let c = charAt(s, idx);
    while (c <= 32) {
      if (c === 0) {
        state.index = idx;
        return "";
      }
      idx++;
      c = charAt(s, idx);
    }

    // skip // comments
    if (c === 47 /* '/' */ && charAt(s, idx + 1) === 47) {
      while (charAt(s, idx) !== 0 && charAt(s, idx) !== 10 /* '\n' */) idx++;
      continue; // goto skipwhite
    }
    break;
  }

  let c = charAt(s, idx);

  // handle quoted strings specially
  if (c === 34 /* '"' */) {
    idx++;
    for (;;) {
      c = charAt(s, idx);
      idx++;
      if (c === 34 || c === 0) {
        state.index = idx;
        return token;
      }
      if (len < MAX_TOKEN_CHARS) {
        token += String.fromCharCode(c);
        len++;
      }
    }
  }

  // parse a regular word
  do {
    if (len < MAX_TOKEN_CHARS) {
      token += String.fromCharCode(c);
      len++;
    }
    idx++;
    c = charAt(s, idx);
  } while (c > 32);

  if (len === MAX_TOKEN_CHARS) {
    token = "";
  }

  state.index = idx;
  return token;
}

//============================================================================
// random()/crandom() — defined in game/g_local.h (not q_shared.h), placed here
// per PORTING.md's split ("random()/crandom() live in src/shared/math.ts").
// Determinism is not a goal (see PORTING.md idiom map); backed by Math.random().

export function random(): number {
  return (Math.floor(Math.random() * 0x8000) & 0x7fff) / 0x7fff;
}

export function crandom(): number {
  return 2.0 * (random() - 0.5);
}
