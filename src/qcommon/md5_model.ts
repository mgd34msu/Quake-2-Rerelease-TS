/*
Ported from q2repro (Jonathan "Paril" Barkley et al., GPLv2) checked out at
~/Projects/qsrc/q2repro -- src/refresh/models.c's `#if USE_MD5` block
(MD5_ParseMesh/MD5_ParseAnim/MD5_BuildFrameSkeleton/MD5_ComputeNormals/
MD5_LoadScales/MOD_LoadMD5, lines 767-1447) and src/refresh/mesh.c's
`#if USE_MD5` runtime-skinning block (calc_skel_vert/lerp_alias_skeleton/
draw_alias_skeleton, lines 739-908), plus the MD5-only quaternion helpers in
src/common/math.c (Quat_ComputeW/Quat_Conjugate/Quat_MultiplyQuat/
Quat_MultiplyVector/Quat_RotatePoint/Quat_ToAxis/Quat_SLerp/Quat_Normalize,
lines 529-678) and the VectorRotate(in,axis,out)/LerpVector2 macros
(inc/shared/shared.h:256/286).

Shared by both renderers (wired in from src/ref_gl/gl_model.ts +
src/ref_gl/gl_mesh.ts; src/ref_soft/r_model.ts is documented-only, see that
file's own header comment) because q2repro keeps exactly one MD5
implementation total -- its "refresh" is a single GL-only binary, there is
no separate software renderer the way this port has one. This module is the
closest faithful single home for that one implementation; per-renderer MD2
loading conventions elsewhere in this port (gl_model.ts/r_model.ts each keep
their own private ParsedMd2T) don't apply here since there is nothing
renderer-private to duplicate.

FILE DISCOVERY (q2repro models.c:1415-1445, MOD_LoadMD5) -- corrects an
assumption in this unit's own brief: the files are NOT
"models/<dir>/tris.md5mesh next to tris.md2". COM_SplitPath splits the MD2's
own path into model_name ("tris") and base_path ("models/<dir>/"), then
MOD_LoadMD5 builds base_path + "md5/" + model_name + ".md5mesh"/".md5anim":
the files live in an "md5/" SUBDIRECTORY next to the .md2, e.g.
"models/monsters/soldier/md5/tris.md5mesh". Confirmed against the real
retail data: ~/q2rets/rerelease/baseq2/pak0.pak carries exactly 412 files
(199 .md5mesh + 199 .md5anim + 14 .md5scale), every one at
"models/<dir>/md5/tris.md5*" or "players/<dir>/md5/*.md5*" -- always the
"md5/" subdirectory, never a bare sibling file. (Q2Game.kpf carries none of
this data -- it all lives in pak0.pak.)

MOD_LoadMD5 only fires when BOTH the mesh and the anim exist
(`FS_FileExists(mesh_path) && FS_FileExists(anim_path)`). This port's
RefImports has no FS_FileExists (src/client/ref.ts only exposes
FS_LoadFile), so callers approximate the same gate by attempting
FS_LoadFile on both and bailing if either comes back with no data -- one
extra file read vs the C original's pure existence probe when the mesh
exists but the anim doesn't, but the same observable "silently fall back to
MD2 if either file is missing" outcome.

MD5_LoadScales (models.c:1134-1217) parses a sibling ".md5scale" JSON file
(same base name as the .md5anim) via q2repro's own tiny "jsmn" token parser;
this port uses the platform's real JSON.parse instead (see loadMd5Scales
below) -- same JSON grammar, no jsmn port needed.

GPU-lerp (mesh.c's `gl_static.use_gpu_lerp` branch: MD5_GpuMalloc/
bind_skel_arrays/the SSBO-or-buffer-texture skeleton upload) is NOT ported:
this renderer's alias-model lerping is always CPU-side fixed-function (see
gl_rmain.ts's own `gl_gpulerp` cvar comment, "registered only... no GPU-lerp
path exists"), so only the CPU skinning path (calc_skel_vert/
tess_plain_skel, mesh.c:747-779) has a real consumer here. calcSkelVert
below is that function.
*/

import {
  type Vec3,
  vec3,
  DotProduct,
  VectorAdd,
  VectorSubtract,
  VectorCopy,
  VectorClear,
  VectorScale,
  VectorMA,
  VectorNormalize,
  CrossProduct,
  COM_Parse,
  type ComParseState,
  COM_FilePath,
  COM_FileBase,
  COM_SkipPath,
} from "../shared/math";

//============================================================================
// constants (gl.h:393-397, 962-963)

export const MD5_VERSION = 10;
export const MD5_MAX_JOINTS = 256;
export const MD5_MAX_MESHES = 32;
export const MD5_MAX_WEIGHTS = 8192;
export const MD5_MAX_FRAMES = 1024;
const MD5_NUM_ANIMATED_COMPONENT_BITS = 6; // models.c:1074

// gl.h:962-963 -- q2repro's fixed immediate-mode scratch-buffer caps
// (TESS_MAX_VERTICES/TESS_MAX_INDICES), reused here only as parser sanity
// bounds on numverts/numtris; this port has no equivalent fixed buffer, but
// a .md5mesh this large is corrupt or hostile input either way.
const TESS_MAX_VERTICES = 6144;
const TESS_MAX_INDICES = 3 * TESS_MAX_VERTICES;

//============================================================================
// quaternion math (math.c:529-678) -- first quaternion consumer in this
// port, no prior Quat type/helpers exist anywhere else to reuse.

export type Quat = Float32Array; // (x, y, z, w), matches math.c's `#define X 0 / Y 1 / Z 2 / W 3`

export function quat(x = 0, y = 0, z = 0, w = 0): Quat {
  const q = new Float32Array(4);
  q[0] = x;
  q[1] = y;
  q[2] = z;
  q[3] = w;
  return q;
}

const QX = 0;
const QY = 1;
const QZ = 2;
const QW = 3;

export function Quat_ComputeW(q: Quat): void {
  const t = 1.0 - q[QX] * q[QX] - q[QY] * q[QY] - q[QZ] * q[QZ];
  q[QW] = t < 0.0 ? 0.0 : -Math.sqrt(t); // note the sign: math.c literally negates sqrtf(t), not a typo to "fix"
}

export function Quat_Conjugate(inQ: Quat, out: Quat): void {
  const w = inQ[QW];
  const x = -inQ[QX];
  const y = -inQ[QY];
  const z = -inQ[QZ];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

export function Quat_MultiplyQuat(qa: Quat, qb: Quat, out: Quat): void {
  const w = qa[QW] * qb[QW] - qa[QX] * qb[QX] - qa[QY] * qb[QY] - qa[QZ] * qb[QZ];
  const x = qa[QX] * qb[QW] + qa[QW] * qb[QX] + qa[QY] * qb[QZ] - qa[QZ] * qb[QY];
  const y = qa[QY] * qb[QW] + qa[QW] * qb[QY] + qa[QZ] * qb[QX] - qa[QX] * qb[QZ];
  const z = qa[QZ] * qb[QW] + qa[QW] * qb[QZ] + qa[QX] * qb[QY] - qa[QY] * qb[QX];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

function Quat_MultiplyVector(q: Quat, v: Vec3, out: Quat): void {
  const w = -(q[QX] * v[0]) - q[QY] * v[1] - q[QZ] * v[2];
  const x = q[QW] * v[0] + q[QY] * v[2] - q[QZ] * v[1];
  const y = q[QW] * v[1] + q[QZ] * v[0] - q[QX] * v[2];
  const z = q[QW] * v[2] + q[QX] * v[1] - q[QY] * v[0];
  out[QW] = w;
  out[QX] = x;
  out[QY] = y;
  out[QZ] = z;
}

export function Quat_RotatePoint(q: Quat, inV: Vec3, out: Vec3): void {
  // Assume q is a unit quaternion (math.c's own assumption, unchecked there too)
  const inv = quat();
  Quat_Conjugate(q, inv);
  const tmp = quat();
  Quat_MultiplyVector(q, inV, tmp);
  const output = quat();
  Quat_MultiplyQuat(tmp, inv, output);
  out[0] = output[QX];
  out[1] = output[QY];
  out[2] = output[QZ];
}

export function Quat_ToAxis(q: Quat, axis: readonly [Vec3, Vec3, Vec3]): void {
  const q0 = q[QW];
  const q1 = q[QX];
  const q2 = q[QY];
  const q3 = q[QZ];

  axis[0][0] = 2 * (q0 * q0 + q1 * q1) - 1;
  axis[0][1] = 2 * (q1 * q2 - q0 * q3);
  axis[0][2] = 2 * (q1 * q3 + q0 * q2);

  axis[1][0] = 2 * (q1 * q2 + q0 * q3);
  axis[1][1] = 2 * (q0 * q0 + q2 * q2) - 1;
  axis[1][2] = 2 * (q2 * q3 - q0 * q1);

  axis[2][0] = 2 * (q1 * q3 - q0 * q2);
  axis[2][1] = 2 * (q2 * q3 + q0 * q1);
  axis[2][2] = 2 * (q0 * q0 + q3 * q3) - 1;
}

export function Quat_Normalize(q: Quat): number {
  const length = Math.sqrt(q[QX] * q[QX] + q[QY] * q[QY] + q[QZ] * q[QZ] + q[QW] * q[QW]);
  if (length) {
    const ilength = 1 / length;
    q[QX] *= ilength;
    q[QY] *= ilength;
    q[QZ] *= ilength;
    q[QW] *= ilength;
  }
  return length;
}

const DOT_THRESHOLD = 0.9995;

export function Quat_SLerp(qa: Quat, qb: Quat, backlerp: number, frontlerp: number, out: Quat): void {
  if (backlerp <= 0.0) {
    out[0] = qb[0];
    out[1] = qb[1];
    out[2] = qb[2];
    out[3] = qb[3];
    return;
  } else if (backlerp >= 1.0) {
    out[0] = qa[0];
    out[1] = qa[1];
    out[2] = qa[2];
    out[3] = qa[3];
    return;
  }

  let cosOmega = qa[QX] * qb[QX] + qa[QY] * qb[QY] + qa[QZ] * qb[QZ] + qa[QW] * qb[QW];

  let q1w = qb[QW];
  let q1x = qb[QX];
  let q1y = qb[QY];
  let q1z = qb[QZ];

  if (cosOmega < 0.0) {
    q1w = -q1w;
    q1x = -q1x;
    q1y = -q1y;
    q1z = -q1z;
    cosOmega = -cosOmega;
  }

  let k0: number;
  let k1: number;

  if (cosOmega > DOT_THRESHOLD) {
    k0 = backlerp;
    k1 = frontlerp;
  } else {
    const sinOmega = Math.sqrt(1.0 - cosOmega * cosOmega);
    const omega = Math.atan2(sinOmega, cosOmega);
    const oneOverSinOmega = 1.0 / sinOmega;

    k0 = Math.sin(backlerp * omega) * oneOverSinOmega;
    k1 = Math.sin(frontlerp * omega) * oneOverSinOmega;
  }

  out[QW] = k0 * qa[QW] + k1 * q1w;
  out[QX] = k0 * qa[QX] + k1 * q1x;
  out[QY] = k0 * qa[QY] + k1 * q1y;
  out[QZ] = k0 * qa[QZ] + k1 * q1z;
}

// VectorRotate(in,axis,out) (shared.h:256) -- NOT Quat_RotatePoint. Dots
// `in` against each of axis's three ROWS: out[i] = DotProduct(in, axis[i]).
function VectorRotateByAxis(inV: Vec3, axis: readonly [Vec3, Vec3, Vec3], out: Vec3): void {
  out[0] = DotProduct(inV, axis[0]);
  out[1] = DotProduct(inV, axis[1]);
  out[2] = DotProduct(inV, axis[2]);
}

//============================================================================
// types (gl.h:404-449)

// baseframe_joint_t (models.c:858-861) -- bind-pose joint from either
// .md5mesh's "joints" block or .md5anim's "baseframe" block.
export class Md5BaseJointT {
  pos: Vec3 = vec3();
  orient: Quat = quat();
}

// joint_info_t (models.c:1068-1072) -- one .md5anim "hierarchy" entry.
export class Md5JointInfoT {
  name = "";
  parent = -1;
  flags = 0;
  startIndex = 0;
  scalePos = false;
}

// md5_joint_t (gl.h:405-410) -- one joint of one built (per-frame) skeleton.
export class Md5SkeletonJointT {
  pos: Vec3 = vec3();
  scale = 1.0; // models.c:1322-1323's `mdl->skeleton_frames[i].scale = 1.0f` default
  orient: Quat = quat();
  axis: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];
}

// md5_vertex_t (gl.h:412-418)
export class Md5VertexT {
  normal: Vec3 = vec3(); // joint-local-blended bind-pose normal, see computeNormals
  start = 0; // first weight index
  count = 0; // weight count
}

// md5_weight_t (gl.h:420-424)
export class Md5WeightT {
  pos: Vec3 = vec3();
  bias = 0;
}

// maliastc_t as used by md5_mesh_t.tcoords (gl.h:432)
export class Md5TCoordT {
  s = 0;
  t = 0;
}

// md5_mesh_t (gl.h:427-437)
export class Md5MeshT {
  shader = ""; // the .md5mesh "shader" string, kept for diagnostics/tests only -- q2repro re-derives real skins from the MD2's own skin list instead, see md5SkinPathFor
  numVerts = 0;
  numIndices = 0; // 3 * numTris
  numWeights = 0;
  vertices: Md5VertexT[] = [];
  tcoords: Md5TCoordT[] = [];
  indices: number[] = []; // flat triangle list, 3 per tri (uint16_t on disk)
  weights: Md5WeightT[] = [];
  jointnums: number[] = []; // per-weight joint index (uint8_t on disk)
}

// md5_model_t (gl.h:439-449)
export class Md5ModelT {
  numMeshes = 0;
  numJoints = 0;
  numFrames = 0; // may not equal the MD2's own numframes -- see MOD_LoadMD5's own warning, ported in parseMd5Anim below
  meshes: Md5MeshT[] = [];
  skeletonFrames: Md5SkeletonJointT[] = []; // flat [frame * numJoints + joint]
}

export class Md5ParseError extends Error {}

//============================================================================
// tiny COM_Parse-based tokenizer wrappers (MD5_ParseExpect/ParseFloat/
// ParseUint/ParseInt/ParseVector, models.c:801-856) -- reuse this port's
// real vanilla tokenizer (shared/math.ts's COM_Parse) rather than
// reinventing one, per this codebase's existing convention (menu.ts,
// kfont.ts, cmd.ts, every g_spawn.ts already do the same).

function expectToken(state: ComParseState, expect: string, path: string): void {
  const token = COM_Parse(state);
  if (token !== expect) throw new Md5ParseError(`${path}: line ${lineOf(state)}: expected "${expect}", got "${token}"`);
}

function skipToken(state: ComParseState): void {
  COM_Parse(state);
}

// COM_Parse has no line tracking (unlike q2repro's com_linenum); approximate
// for diagnostics only by counting newlines consumed so far.
function lineOf(state: ComParseState): number {
  let line = 1;
  for (let i = 0; i < state.index && i < state.data.length; i++) if (state.data[i] === "\n") line++;
  return line;
}

function parseFloatTok(state: ComParseState, path: string): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || Number.isNaN(v)) throw new Md5ParseError(`${path}: line ${lineOf(state)}: expected float, got "${token}"`);
  return v;
}

function parseUintTok(state: ComParseState, path: string, minV: number, maxV: number): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || !Number.isInteger(v) || v < 0) throw new Md5ParseError(`${path}: line ${lineOf(state)}: expected uint, got "${token}"`);
  if (v < minV || v > maxV) throw new Md5ParseError(`${path}: line ${lineOf(state)}: value out of range: ${v}`);
  return v;
}

function parseIntTok(state: ComParseState, path: string, minV: number, maxV: number): number {
  const token = COM_Parse(state);
  const v = Number(token);
  if (token === "" || !Number.isInteger(v)) throw new Md5ParseError(`${path}: line ${lineOf(state)}: expected int, got "${token}"`);
  if (v < minV || v > maxV) throw new Md5ParseError(`${path}: line ${lineOf(state)}: value out of range: ${v}`);
  return v;
}

function parseVectorTok(state: ComParseState, path: string, out: Vec3): void {
  expectToken(state, "(", path);
  out[0] = parseFloatTok(state, path);
  out[1] = parseFloatTok(state, path);
  out[2] = parseFloatTok(state, path);
  expectToken(state, ")", path);
}

//============================================================================
// MD5_ComputeNormals (models.c:863-945) -- angle-weighted bind-pose vertex
// normals, blended into joint-local space per weight so calcSkelVert can
// re-project them cheaply at animation time.

function vec3Key(v: Vec3): string {
  // exact-value dedup key, mirroring q2repro's HashMap_Create(vec3_t, vec3_t,
  // &HashVec3, NULL) exact-match grouping of finalVerts by float value.
  return `${v[0]}|${v[1]}|${v[2]}`;
}

function computeNormals(mesh: Md5MeshT, baseSkeleton: readonly Md5BaseJointT[]): void {
  const finalVerts: Vec3[] = mesh.vertices.map(() => vec3());

  for (let i = 0; i < mesh.numVerts; i++) {
    const vert = mesh.vertices[i];
    const out = finalVerts[i];
    VectorClear(out);

    for (let j = 0; j < vert.count; j++) {
      const weight = mesh.weights[vert.start + j];
      const joint = baseSkeleton[mesh.jointnums[vert.start + j]];

      const wv = vec3();
      Quat_RotatePoint(joint.orient, weight.pos, wv);
      VectorAdd(joint.pos, wv, wv);
      VectorMA(out, weight.bias, wv, out);
    }
  }

  const posToNormal = new Map<string, Vec3>();

  for (let i = 0; i < mesh.numIndices; i += 3) {
    const xyz: Vec3[] = [finalVerts[mesh.indices[i]], finalVerts[mesh.indices[i + 1]], finalVerts[mesh.indices[i + 2]]];

    const d1 = vec3();
    VectorSubtract(xyz[2], xyz[0], d1);
    const d2 = vec3();
    VectorSubtract(xyz[1], xyz[0], d2);
    VectorNormalize(d1);
    VectorNormalize(d2);

    const norm = vec3();
    CrossProduct(d1, d2, norm);
    VectorNormalize(norm);

    const angle = Math.acos(DotProduct(d1, d2)); // no clamping in the C original either -- NaN on degenerate triangles is the original's own behavior
    VectorScale(norm, angle, norm);

    for (let j = 0; j < 3; j++) {
      const key = vec3Key(xyz[j]);
      const found = posToNormal.get(key);
      if (found) VectorAdd(found, norm, found);
      else posToNormal.set(key, vec3(norm[0], norm[1], norm[2]));
    }
  }

  for (const norm of posToNormal.values()) VectorNormalize(norm);

  for (let i = 0; i < mesh.numVerts; i++) {
    const vert = mesh.vertices[i];
    VectorClear(vert.normal);
    const norm = posToNormal.get(vec3Key(finalVerts[i]));
    if (!norm) continue;

    for (let j = 0; j < vert.count; j++) {
      const weight = mesh.weights[vert.start + j];
      const joint = baseSkeleton[mesh.jointnums[vert.start + j]];

      const orientInv = quat();
      Quat_Conjugate(joint.orient, orientInv);
      const wv = vec3();
      Quat_RotatePoint(orientInv, norm, wv);
      VectorMA(vert.normal, weight.bias, wv, vert.normal);
    }
  }
}

//============================================================================
// MD5_ParseMesh (models.c:947-1066)

export function parseMd5Mesh(text: string, path: string): Md5ModelT {
  const state: ComParseState = { data: text, index: 0 };

  expectToken(state, "MD5Version", path);
  expectToken(state, String(MD5_VERSION), path);

  const model = new Md5ModelT();

  expectToken(state, "commandline", path);
  skipToken(state);

  expectToken(state, "numJoints", path);
  model.numJoints = parseUintTok(state, path, 1, MD5_MAX_JOINTS);

  expectToken(state, "numMeshes", path);
  model.numMeshes = parseUintTok(state, path, 1, MD5_MAX_MESHES);

  expectToken(state, "joints", path);
  expectToken(state, "{", path);

  const baseSkeleton: Md5BaseJointT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const joint = new Md5BaseJointT();
    skipToken(state); // name -- unused by MD5_ParseMesh; real joint names come from the .md5anim hierarchy instead
    skipToken(state); // parent -- likewise unused here
    parseVectorTok(state, path, joint.pos);
    parseVectorTok(state, path, joint.orient); // (x y z) triple on disk; w recomputed next
    Quat_ComputeW(joint.orient);
    baseSkeleton.push(joint);
  }
  expectToken(state, "}", path);

  for (let m = 0; m < model.numMeshes; m++) {
    const mesh = new Md5MeshT();

    expectToken(state, "mesh", path);
    expectToken(state, "{", path);

    expectToken(state, "shader", path);
    mesh.shader = COM_Parse(state);

    expectToken(state, "numverts", path);
    mesh.numVerts = parseUintTok(state, path, 0, TESS_MAX_VERTICES);
    mesh.vertices = Array.from({ length: mesh.numVerts }, () => new Md5VertexT());
    mesh.tcoords = Array.from({ length: mesh.numVerts }, () => new Md5TCoordT());

    for (let j = 0; j < mesh.numVerts; j++) {
      expectToken(state, "vert", path);
      const vertIndex = parseUintTok(state, path, 0, mesh.numVerts - 1);

      const tc = mesh.tcoords[vertIndex];
      expectToken(state, "(", path);
      tc.s = parseFloatTok(state, path);
      tc.t = parseFloatTok(state, path);
      expectToken(state, ")", path);

      const vert = mesh.vertices[vertIndex];
      vert.start = parseUintTok(state, path, 0, 0xffff);
      vert.count = parseUintTok(state, path, 0, 0xffff);
    }

    expectToken(state, "numtris", path);
    const numTris = parseUintTok(state, path, 0, Math.trunc(TESS_MAX_INDICES / 3));
    mesh.numIndices = numTris * 3;
    mesh.indices = new Array<number>(mesh.numIndices).fill(0);

    for (let j = 0; j < numTris; j++) {
      expectToken(state, "tri", path);
      const triIndex = parseUintTok(state, path, 0, numTris - 1);
      for (let k = 0; k < 3; k++) mesh.indices[triIndex * 3 + k] = parseUintTok(state, path, 0, mesh.numVerts - 1);
    }

    expectToken(state, "numweights", path);
    mesh.numWeights = parseUintTok(state, path, 0, MD5_MAX_WEIGHTS);
    mesh.weights = Array.from({ length: mesh.numWeights }, () => new Md5WeightT());
    mesh.jointnums = new Array<number>(mesh.numWeights).fill(0);

    for (let j = 0; j < mesh.numWeights; j++) {
      expectToken(state, "weight", path);
      const weightIndex = parseUintTok(state, path, 0, mesh.numWeights - 1);
      mesh.jointnums[weightIndex] = parseUintTok(state, path, 0, model.numJoints - 1);

      const weight = mesh.weights[weightIndex];
      weight.bias = parseFloatTok(state, path);
      parseVectorTok(state, path, weight.pos);
    }

    expectToken(state, "}", path);

    // integrity check done last, mirroring models.c:1054-1060's own comment
    // ("has to be done last because of circular data dependencies")
    for (let j = 0; j < mesh.numVerts; j++) {
      const vert = mesh.vertices[j];
      if (vert.start + vert.count > mesh.numWeights) throw new Md5ParseError(`${path}: bad vert start/count`);
    }

    computeNormals(mesh, baseSkeleton);
    model.meshes.push(mesh);
  }

  return model;
}

//============================================================================
// MD5_LoadScales (models.c:1131-1217) -- ".md5scale" JSON sidecar, real
// JSON.parse instead of q2repro's own jsmn tokenizer (same grammar).

export interface Md5ScaleSourceT {
  text: string;
  path: string;
}

function loadMd5Scales(model: Md5ModelT, jointInfos: readonly Md5JointInfoT[], jsonText: string, path: string, warn: (msg: string) => void): void {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    warn(`Couldn't load ${path}: Invalid JSON data`);
    return;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    warn(`Couldn't load ${path}: Invalid JSON data`);
    return;
  }

  for (const [jointName, rawEntry] of Object.entries(data as Record<string, unknown>)) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      warn(`Couldn't load ${path}: Invalid JSON data`);
      return;
    }

    const jointId = jointInfos.findIndex((info) => info.name === jointName);
    if (jointId === -1) warn(`No such joint "${jointName}" in ${path}`);

    for (const [key, val] of Object.entries(rawEntry as Record<string, unknown>)) {
      if (jointId === -1) continue;

      if (key === "scale_positions") {
        jointInfos[jointId].scalePos = val === true;
      } else {
        const frameId = Number(key);
        if (Number.isInteger(frameId) && frameId >= 0 && frameId < model.numFrames && typeof val === "number") {
          model.skeletonFrames[frameId * model.numJoints + jointId].scale = val;
        } else {
          warn(`No such frame ${key} in ${path}`);
        }
      }
    }
  }
}

//============================================================================
// MD5_BuildFrameSkeleton (models.c:1076-1129)

function buildFrameSkeleton(
  jointInfos: readonly Md5JointInfoT[],
  baseFrame: readonly Md5BaseJointT[],
  animFrameData: Float32Array,
  skeletonFrames: Md5SkeletonJointT[],
  frameBase: number,
  numJoints: number,
): void {
  for (let i = 0; i < numJoints; i++) {
    const baseJoint = baseFrame[i];
    const info = jointInfos[i];

    // components[0..2] = position, components[3..5] = quat x/y/z (w recomputed below)
    const components = [baseJoint.pos[0], baseJoint.pos[1], baseJoint.pos[2], baseJoint.orient[0], baseJoint.orient[1], baseJoint.orient[2]];

    let j = 0;
    for (let c = 0; c < MD5_NUM_ANIMATED_COMPONENT_BITS; c++) {
      if (info.flags & (1 << c)) components[c] = animFrameData[info.startIndex + j++];
    }

    const animatedPosition = vec3(components[0], components[1], components[2]);
    const animatedQuat = quat(components[3], components[4], components[5], 0);
    Quat_ComputeW(animatedQuat);

    const thisJoint = skeletonFrames[frameBase + i];

    if (info.scalePos) VectorScale(animatedPosition, thisJoint.scale, animatedPosition);

    if (info.parent < 0) {
      VectorCopy(animatedPosition, thisJoint.pos);
      thisJoint.orient[0] = animatedQuat[0];
      thisJoint.orient[1] = animatedQuat[1];
      thisJoint.orient[2] = animatedQuat[2];
      thisJoint.orient[3] = animatedQuat[3];
      Quat_ToAxis(thisJoint.orient, thisJoint.axis);
      continue;
    }

    // parent is guaranteed already built: parseMd5Anim's hierarchy parse
    // already rejected `parent >= i` (models.c's Q_assert(parent < i))
    const parentJoint = skeletonFrames[frameBase + info.parent];

    const rotatedPos = vec3();
    Quat_RotatePoint(parentJoint.orient, animatedPosition, rotatedPos);
    VectorAdd(rotatedPos, parentJoint.pos, thisJoint.pos);

    Quat_MultiplyQuat(parentJoint.orient, animatedQuat, thisJoint.orient);
    Quat_Normalize(thisJoint.orient);

    Quat_ToAxis(thisJoint.orient, thisJoint.axis);
  }
}

//============================================================================
// MD5_ParseAnim (models.c:1219-1349)

export function parseMd5Anim(text: string, path: string, model: Md5ModelT, scale: Md5ScaleSourceT | null, warn: (msg: string) => void): void {
  const state: ComParseState = { data: text, index: 0 };

  expectToken(state, "MD5Version", path);
  expectToken(state, String(MD5_VERSION), path);

  expectToken(state, "commandline", path);
  skipToken(state);

  expectToken(state, "numFrames", path);
  model.numFrames = parseUintTok(state, path, 1, MD5_MAX_FRAMES);

  // warn on mismatched frame counts (not fatal) -- models.c:1249-1251. This
  // module has no access to the MD2's own numframes (renderer-private),
  // so callers that want this warning compare it themselves after
  // loadMd5Model returns; nothing to do here.

  expectToken(state, "numJoints", path);
  const numJoints = parseUintTok(state, path, 1, MD5_MAX_JOINTS);
  if (numJoints !== model.numJoints) throw new Md5ParseError(`${path}: bad numJoints`);

  expectToken(state, "frameRate", path);
  skipToken(state);

  expectToken(state, "numAnimatedComponents", path);
  const numAnimatedComponents = parseUintTok(state, path, 0, MD5_MAX_JOINTS * MD5_NUM_ANIMATED_COMPONENT_BITS);

  expectToken(state, "hierarchy", path);
  expectToken(state, "{", path);

  const jointInfos: Md5JointInfoT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const info = new Md5JointInfoT();
    info.name = COM_Parse(state);
    info.parent = parseIntTok(state, path, -1, model.numJoints - 1);
    info.flags = parseUintTok(state, path, 0, 0xffffffff);
    info.startIndex = parseUintTok(state, path, 0, numAnimatedComponents);

    let numComponents = 0;
    for (let j = 0; j < MD5_NUM_ANIMATED_COMPONENT_BITS; j++) if (info.flags & (1 << j)) numComponents++;
    if (info.startIndex + numComponents > numAnimatedComponents) throw new Md5ParseError(`${path}: bad joint info`);
    if (info.parent >= i) throw new Md5ParseError(`${path}: bad parent joint`);

    jointInfos.push(info);
  }
  expectToken(state, "}", path);

  // bounds are ignored -- q2repro's own comment (models.c:1294-1296): "apparently
  // usually wrong anyways so we'll just rely on [the MD2's bounds] instead."
  expectToken(state, "bounds", path);
  expectToken(state, "{", path);
  for (let i = 0; i < model.numFrames * 2 * 5; i++) skipToken(state); // 2 vectors * 5 tokens ('(' x y z ')') per frame
  expectToken(state, "}", path);

  expectToken(state, "baseframe", path);
  expectToken(state, "{", path);
  const baseFrame: Md5BaseJointT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const joint = new Md5BaseJointT();
    parseVectorTok(state, path, joint.pos);
    parseVectorTok(state, path, joint.orient);
    Quat_ComputeW(joint.orient);
    baseFrame.push(joint);
  }
  expectToken(state, "}", path);

  // allocate + default every joint/frame scale to 1.0 (models.c:1319-1323) --
  // Md5SkeletonJointT's own field initializer already does this.
  model.skeletonFrames = Array.from({ length: model.numFrames * model.numJoints }, () => new Md5SkeletonJointT());

  if (scale) loadMd5Scales(model, jointInfos, scale.text, scale.path, warn);

  const animFrameData = new Float32Array(numAnimatedComponents);
  for (let f = 0; f < model.numFrames; f++) {
    expectToken(state, "frame", path);
    const frameIndex = parseUintTok(state, path, 0, model.numFrames - 1);

    expectToken(state, "{", path);
    for (let j = 0; j < numAnimatedComponents; j++) animFrameData[j] = parseFloatTok(state, path);
    expectToken(state, "}", path);

    buildFrameSkeleton(jointInfos, baseFrame, animFrameData, model.skeletonFrames, frameIndex * model.numJoints, model.numJoints);
  }
}

//============================================================================
// runtime skinning (mesh.c:747-773, 810-824) -- CPU path only, see file
// header comment for why the GPU-lerp SSBO path is not ported.

// calc_skel_vert (mesh.c:747-773)
export function calcSkelVert(vert: Md5VertexT, mesh: Md5MeshT, skeleton: readonly Md5SkeletonJointT[], outPosition: Vec3, outNormal: Vec3 | null): void {
  VectorClear(outPosition);
  if (outNormal) VectorClear(outNormal);

  for (let i = 0; i < vert.count; i++) {
    const weight = mesh.weights[vert.start + i];
    const joint = skeleton[mesh.jointnums[vert.start + i]];

    const wv = vec3();
    VectorRotateByAxis(weight.pos, joint.axis, wv);
    VectorMA(joint.pos, joint.scale, wv, wv);
    VectorMA(outPosition, weight.bias, wv, outPosition);

    if (outNormal) {
      const nv = vec3();
      VectorRotateByAxis(vert.normal, joint.axis, nv);
      VectorMA(outNormal, weight.bias, nv, outNormal);
    }
  }
}

// draw_alias_skeleton's frame selection (mesh.c:876-883): use the stored
// frame directly when old==new, otherwise lerp_alias_skeleton (mesh.c:810-824).
export function getSkeletonFrame(model: Md5ModelT, oldFrame: number, newFrame: number, backlerp: number, frontlerp: number): readonly Md5SkeletonJointT[] {
  const frameA = oldFrame % model.numFrames;
  const frameB = newFrame % model.numFrames;

  if (frameA === frameB) return model.skeletonFrames.slice(frameB * model.numJoints, (frameB + 1) * model.numJoints);

  const out: Md5SkeletonJointT[] = [];
  for (let i = 0; i < model.numJoints; i++) {
    const a = model.skeletonFrames[frameA * model.numJoints + i];
    const b = model.skeletonFrames[frameB * model.numJoints + i];
    const j = new Md5SkeletonJointT();
    j.scale = b.scale;
    // LerpVector2(a,b,backlerp,frontlerp,out) (shared.h:286): out = a*backlerp + b*frontlerp
    j.pos[0] = a.pos[0] * backlerp + b.pos[0] * frontlerp;
    j.pos[1] = a.pos[1] * backlerp + b.pos[1] * frontlerp;
    j.pos[2] = a.pos[2] * backlerp + b.pos[2] * frontlerp;
    Quat_SLerp(a.orient, b.orient, backlerp, frontlerp, j.orient);
    Quat_ToAxis(j.orient, j.axis);
    out.push(j);
  }
  return out;
}

//============================================================================
// file discovery + top-level load (MOD_LoadMD5, models.c:1415-1445) -- see
// file header comment for the "md5/" subdirectory correction.

export interface Md5FilePathsT {
  meshPath: string;
  animPath: string;
  scalePath: string;
}

export function md5PathsFor(modelPath: string): Md5FilePathsT {
  const dir = COM_FilePath(modelPath); // e.g. "models/monsters/soldier" (no trailing slash)
  const base = COM_FileBase(modelPath); // e.g. "tris" (no extension)
  return {
    meshPath: `${dir}/md5/${base}.md5mesh`,
    animPath: `${dir}/md5/${base}.md5anim`,
    scalePath: `${dir}/md5/${base}.md5scale`,
  };
}

// MD5_LoadSkins (models.c:1370-1403): re-derive each of the MD2's own
// already-registered skin names under this model's "md5/" subdirectory --
// confirmed against retail data (e.g. the MD2 skin
// "models/monsters/bitch/bi_sk3.pcx" pairs with the MD5 skin
// "models/monsters/bitch/md5/bi_sk3.png", a DIFFERENT texture asset, not a
// reused one). Extension is kept as-is (COM_SplitPath's `false` "don't
// strip extension" parameter, models.c:1390); this port's own image finder
// already handles trying alternate extensions for MD2 skins the same way.
export function md5SkinPathFor(md2SkinName: string): string {
  const dir = COM_FilePath(md2SkinName);
  const base = COM_SkipPath(md2SkinName);
  return `${dir}/md5/${base}`;
}

// MOD_LoadMD5's orchestration (models.c:1415-1445), minus the hunk
// watermark/free-on-fail bookkeeping (this port has no hunk allocator --
// see PORTING.md's "Z_Malloc/Hunk_* -> plain allocation" idiom already
// applied throughout gl_model.ts/r_model.ts). Throws Md5ParseError on any
// parse failure; callers should catch it and fall back to MD2 rendering,
// matching MOD_LoadMD5's own `fail:` label (free + model->skeleton = NULL,
// no propagated error).
export function loadMd5Model(meshText: string, meshPath: string, animText: string, animPath: string, scale: Md5ScaleSourceT | null, warn: (msg: string) => void): Md5ModelT {
  const model = parseMd5Mesh(meshText, meshPath);
  parseMd5Anim(animText, animPath, model, scale, warn);
  return model;
}
