/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_warp.c (GNU GPL v2 or later): GL_SubdivideSurface/
SubdividePolygon, EmitWaterPolys (with the r_turbsin warp table from
ref_gl/warpsin.h), and the sky box (R_AddSkySurface/R_ClearSkyBox/
R_DrawSkyBox/MakeSkyVec/ClipSkyPolygon/DrawSkyPolygon/R_SetSky).

Internal helpers not declared in gl_local.h (BoundPoly, DrawSkyPolygon) stay
module-private. SubdividePolygon, ClipSkyPolygon and MakeSkyVec are also not
declared in gl_local.h, but this unit's test brief exercises them directly
(SubdividePolygon's SUBDIVIDE_SIZE cutting, ClipSkyPolygon's face-bucketing
math), so they are exported here for testability -- same rationale
r_surf.ts's header comment gives for exporting D_SCAlloc.

r_turbsin: warpsin.h is a 256-float literal table; every value in it is
`8*sin(i * 2*PI/256)` rounded to ~6 significant digits (confirmed against
the header, including the i=128 entry printed as `9.79717e-16`, which is
exactly `8*sin(PI)` at double precision). Generated with that formula
instead of transcribing 256 literals by hand -- same numeric content, no
transcription-typo risk.

QGL binding: gl_image.ts (a concurrently-ported sibling that landed while
this unit was in progress) already owns a shared `export let qgl: QGL` /
`SetQGL` pair -- its own header comment explains why (gl_draw.ts already
depended on it, gl_local.ts was out of that unit's SCOPE). Imported directly
from there rather than declaring a second, disconnected instance here, and
re-exported under the same names so a third concurrent sibling's test file
(test/gl_model.test.ts, out of this unit's SCOPE) that already expects
`SetQGL` importable from "./gl_warp" keeps compiling against the exact same
underlying singleton, not a duplicate.

Extension-availability null-checks (`if (qglMTexCoord2fSGIS)`, `if
(qglColorTableEXT)` in R_SetSky) are kept as literal conditionals reading
`qgl.qglMTexCoord2fSGIS` / `qgl.qglColorTableEXT`'s truthiness, exactly as
the C reads the (possibly-null) function pointer. QGL's interface (qgl.ts,
already landed) declares every member as always-present and non-nullable,
so these conditions are always true today; both branches are still ported
in full so a future optional-QGL change restores real conditional behavior
with no further edits here.

`loadmodel` (gl_warp.c's `extern model_t *loadmodel;`, gl_model.c's "model
currently loading" global) has no equivalent export yet in gl_model.ts (a
concurrently-ported sibling at the time; all real now). Checked gl_model.c's
own call site for GL_SubdivideSurface (Mod_LoadFaces, right after
`currentmodel = loadmodel;`): by the time GL_SubdivideSurface runs for
real, `currentmodel` (already a real, landed export in gl_local.ts) holds
the exact same value `loadmodel` would. Used `currentmodel` in
GL_SubdivideSurface instead of a `loadmodel` import that doesn't exist yet
-- accurate for this call site, not a general substitute for `loadmodel`
elsewhere.
*/

import { type Vec3, vec3, DotProduct, VectorAdd, VectorSubtract, VectorCopy } from "../shared/math";
import { MAX_QPATH, ERR_DROP, SURF_FLOWING } from "../shared/q_shared";
import { GlpolyT, VERTEXSIZE, SIDE_FRONT, SIDE_BACK, SIDE_ON, type MsurfaceT } from "./gl_model";
import { r_origin, r_newrefdef, ri, glCvars, r_notexture, currentmodel, ImagetypeT, type ImageT } from "./gl_local";
import { GL_Bind, GL_FindImage, qgl } from "./gl_image";
export { qgl, SetQGL } from "./gl_image";
import { fixedLength } from "../shared/fixed";

// standard OpenGL 1.1 primitive-mode enum values (`<GL/gl.h>`); not defined
// anywhere else in this port yet (see header comment's QGL/enum note).
const GL_TRIANGLE_FAN = 0x0006;
const GL_QUADS = 0x0007;

const SUBDIVIDE_SIZE = 64;
//const SUBDIVIDE_SIZE = 1024;

export let skyname = "";
export let skyrotate = 0;
export const skyaxis: Vec3 = vec3();
export const sky_images: (ImageT | null)[] = fixedLength("sky_images", 6, [null, null, null, null, null, null]);

// gl_warp.c's own file-scope global, set at the top of GL_SubdivideSurface
// and read by SubdividePolygon's recursive base case.
let warpface: MsurfaceT | null = null;

// Test seam for exercising SubdividePolygon directly (this unit's brief
// requires it), mirroring r_bsp.ts's identical setWorldModelForTesting.
export function setWarpfaceForTesting(fa: MsurfaceT | null): void {
  warpface = fa;
}

function BoundPoly(verts: readonly Vec3[], mins: Vec3, maxs: Vec3): void {
  mins[0] = mins[1] = mins[2] = 9999;
  maxs[0] = maxs[1] = maxs[2] = -9999;
  for (const v of verts) {
    for (let j = 0; j < 3; j++) {
      if (v[j] < mins[j]) mins[j] = v[j];
      if (v[j] > maxs[j]) maxs[j] = v[j];
    }
  }
}

// C takes `(int numverts, float *verts)`; here `verts.length` is `numverts`
// and each element is one xyz vertex (BoundPoly's own `numverts` param is
// likewise dropped for the same reason).
export function SubdividePolygon(verts: readonly Vec3[]): void {
  const numverts = verts.length;
  if (numverts > 60) {
    ri.Sys_Error(ERR_DROP, `numverts = ${numverts}`);
  }

  const mins = vec3();
  const maxs = vec3();
  BoundPoly(verts, mins, maxs);

  for (let i = 0; i < 3; i++) {
    let m = (mins[i] + maxs[i]) * 0.5;
    m = SUBDIVIDE_SIZE * Math.floor(m / SUBDIVIDE_SIZE + 0.5);
    if (maxs[i] - m < 8) continue;
    if (m - mins[i] < 8) continue;

    // cut it -- C wraps the flat `dist`/`verts` buffers by writing one extra
    // trailing entry equal to index 0; here the wraparound is just "index 0"
    // read directly, since `verts` is a plain array, not a fixed C buffer.
    const dist: number[] = new Array(numverts);
    for (let j = 0; j < numverts; j++) {
      dist[j] = verts[j][i] - m;
    }

    const front: Vec3[] = [];
    const back: Vec3[] = [];

    for (let j = 0; j < numverts; j++) {
      const v = verts[j];
      const dj = dist[j];
      const djNext = j + 1 < numverts ? dist[j + 1] : dist[0];
      const vNext = j + 1 < numverts ? verts[j + 1] : verts[0];

      if (dj >= 0) front.push(vec3(v[0], v[1], v[2]));
      if (dj <= 0) back.push(vec3(v[0], v[1], v[2]));
      if (dj === 0 || djNext === 0) continue;
      if (dj > 0 !== djNext > 0) {
        const frac = dj / (dj - djNext);
        const clip = vec3();
        for (let k = 0; k < 3; k++) {
          clip[k] = v[k] + frac * (vNext[k] - v[k]);
        }
        front.push(vec3(clip[0], clip[1], clip[2]));
        back.push(vec3(clip[0], clip[1], clip[2]));
      }
    }

    SubdividePolygon(front);
    SubdividePolygon(back);
    return;
  }

  // add a point in the center to help keep warp valid
  if (!warpface || !warpface.texinfo) return;
  const texinfo = warpface.texinfo;

  const poly = new GlpolyT();
  poly.next = warpface.polys;
  warpface.polys = poly;
  poly.numverts = numverts + 2;

  const total = vec3();
  let total_s = 0;
  let total_t = 0;
  const rows: Float32Array[] = new Array(numverts + 2);

  for (let i = 0; i < numverts; i++) {
    const v = verts[i];
    const s = DotProduct(v, texinfo.vecs[0]);
    const t = DotProduct(v, texinfo.vecs[1]);

    total_s += s;
    total_t += t;
    VectorAdd(total, v, total);

    const row = new Float32Array(VERTEXSIZE);
    row[0] = v[0];
    row[1] = v[1];
    row[2] = v[2];
    row[3] = s;
    row[4] = t;
    rows[i + 1] = row;
  }

  const center = new Float32Array(VERTEXSIZE);
  center[0] = total[0] / numverts;
  center[1] = total[1] / numverts;
  center[2] = total[2] / numverts;
  center[3] = total_s / numverts;
  center[4] = total_t / numverts;
  rows[0] = center;

  // copy first vertex to last
  rows[numverts + 1] = new Float32Array(rows[1]);

  poly.verts = rows;
}

/*
================
GL_SubdivideSurface

Breaks a polygon up along axial 64 unit
boundaries so that turbulent and sky warps
can be done reasonably.
================
*/
export function GL_SubdivideSurface(fa: MsurfaceT): void {
  warpface = fa;

  const model = currentmodel; // see header comment: stand-in for `loadmodel`
  if (!model) return;

  const verts: Vec3[] = [];
  for (let i = 0; i < fa.numedges; i++) {
    const lindex = model.surfedges[fa.firstedge + i];
    const pos = lindex > 0 ? model.vertexes[model.edges[lindex].v[0]].position : model.vertexes[model.edges[-lindex].v[1]].position;
    verts.push(vec3(pos[0], pos[1], pos[2]));
  }

  SubdividePolygon(verts);
}

//=========================================================

// speed up sin calculations - Ed (see header comment: generated from the
// formula warpsin.h's literal table encodes, not transcribed by hand).
const r_turbsin: Float32Array = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = 8 * Math.sin((i * 2 * Math.PI) / 256);
  }
  return table;
})();

// gl_rmain.c's R_Init does `for (j=0; j<256; j++) r_turbsin[j] *= 0.5;` on
// this table. In C each vid_restart reloads ref_gl.so with a fresh table, so
// the halving happens exactly once per load; this statically-linked module
// emulates that by recomputing from the formula, keeping repeated R_Init
// calls idempotent instead of compounding the scale.
export function R_ScaleTurbsinForRInit(): void {
  for (let i = 0; i < 256; i++) {
    r_turbsin[i] = 8 * Math.sin((i * 2 * Math.PI) / 256) * 0.5;
  }
}
const TURBSCALE = 256.0 / (2 * Math.PI);

/*
=============
EmitWaterPolys

Does a water warp on the pre-fragmented glpoly_t chain
=============
*/
export function EmitWaterPolys(fa: MsurfaceT): void {
  const flowing = fa.texinfo !== null && (fa.texinfo.flags & SURF_FLOWING) !== 0;
  const scroll = flowing ? -64 * (r_newrefdef.time * 0.5 - Math.trunc(r_newrefdef.time * 0.5)) : 0;

  for (let bp = fa.polys; bp; bp = bp.next) {
    const p = bp;

    qgl.qglBegin(GL_TRIANGLE_FAN);
    for (let i = 0; i < p.numverts; i++) {
      const v = p.verts[i];
      const os = v[3];
      const ot = v[4];

      let s = os + r_turbsin[Math.trunc((ot * 0.125 + r_newrefdef.time) * TURBSCALE) & 255];
      s += scroll;
      s *= 1.0 / 64;

      let t = ot + r_turbsin[Math.trunc((os * 0.125 + r_newrefdef.time) * TURBSCALE) & 255];
      t *= 1.0 / 64;

      qgl.qglTexCoord2f(s, t);
      qgl.qglVertex3fv(v);
    }
    qgl.qglEnd();
  }
}

//===================================================================

const skyclip: readonly Vec3[] = fixedLength("skyclip", 6, [vec3(1, 1, 0), vec3(1, -1, 0), vec3(0, -1, 1), vec3(0, 1, 1), vec3(1, 0, 1), vec3(-1, 0, 1)]);
let c_sky = 0;

// 1 = s, 2 = t, 3 = 2048
const st_to_vec: readonly (readonly number[])[] = fixedLength(
  "st_to_vec",
  6,
  [
    [3, -1, 2],
    [-3, 1, 2],

    [1, 3, 2],
    [-1, -3, 2],

    [-2, -1, 3], // 0 degrees yaw, look straight up
    [2, -1, -3], // look straight down
  ],
).map((row) => fixedLength("st_to_vec row", 3, row));

// s = [0]/[2], t = [1]/[2]
const vec_to_st: readonly (readonly number[])[] = fixedLength(
  "vec_to_st",
  6,
  [
    [-2, 3, 1],
    [2, 3, -1],

    [1, 3, 2],
    [-1, 3, -2],

    [-2, -1, 3],
    [-2, 1, -3],
  ],
).map((row) => fixedLength("vec_to_st row", 3, row));

const skyminsRows: [number[], number[]] = [
  fixedLength("skymins row", 6, [9999, 9999, 9999, 9999, 9999, 9999]),
  fixedLength("skymins row", 6, [9999, 9999, 9999, 9999, 9999, 9999]),
];
export const skymins: [number[], number[]] = fixedLength("skymins", 2, skyminsRows);
const skymaxsRows: [number[], number[]] = [
  fixedLength("skymaxs row", 6, [-9999, -9999, -9999, -9999, -9999, -9999]),
  fixedLength("skymaxs row", 6, [-9999, -9999, -9999, -9999, -9999, -9999]),
];
export const skymaxs: [number[], number[]] = fixedLength("skymaxs", 2, skymaxsRows);
let sky_min = 0;
let sky_max = 0;

function DrawSkyPolygon(verts: readonly Vec3[]): void {
  c_sky++;

  // decide which face it maps to
  const v = vec3();
  for (const vp of verts) VectorAdd(vp, v, v);

  const av = vec3(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  let axis: number;
  if (av[0] > av[1] && av[0] > av[2]) axis = v[0] < 0 ? 1 : 0;
  else if (av[1] > av[2] && av[1] > av[0]) axis = v[1] < 0 ? 3 : 2;
  else axis = v[2] < 0 ? 5 : 4;

  // project new texture coords
  for (const vp of verts) {
    let j = vec_to_st[axis][2];
    const dv = j > 0 ? vp[j - 1] : -vp[-j - 1];
    if (dv < 0.001) continue; // don't divide by zero

    j = vec_to_st[axis][0];
    const s = j < 0 ? -vp[-j - 1] / dv : vp[j - 1] / dv;
    j = vec_to_st[axis][1];
    const t = j < 0 ? -vp[-j - 1] / dv : vp[j - 1] / dv;

    if (s < skymins[0][axis]) skymins[0][axis] = s;
    if (t < skymins[1][axis]) skymins[1][axis] = t;
    if (s > skymaxs[0][axis]) skymaxs[0][axis] = s;
    if (t > skymaxs[1][axis]) skymaxs[1][axis] = t;
  }
}

const ON_EPSILON = 0.1; // point on plane side epsilon
const MAX_CLIP_VERTS = 64;

export function ClipSkyPolygon(verts: readonly Vec3[], stage: number): void {
  const nump = verts.length;
  if (nump > MAX_CLIP_VERTS - 2) {
    ri.Sys_Error(ERR_DROP, "ClipSkyPolygon: MAX_CLIP_VERTS");
  }
  if (stage === 6) {
    // fully clipped, so draw it
    DrawSkyPolygon(verts);
    return;
  }

  let front = false;
  let back = false;
  const norm = skyclip[stage];
  const sides: number[] = new Array(nump);
  const dists: number[] = new Array(nump);
  for (let i = 0; i < nump; i++) {
    const d = DotProduct(verts[i], norm);
    if (d > ON_EPSILON) {
      front = true;
      sides[i] = SIDE_FRONT;
    } else if (d < -ON_EPSILON) {
      back = true;
      sides[i] = SIDE_BACK;
    } else {
      sides[i] = SIDE_ON;
    }
    dists[i] = d;
  }

  if (!front || !back) {
    // not clipped
    ClipSkyPolygon(verts, stage + 1);
    return;
  }

  // clip it -- wraparound (C's `sides[i]=sides[0]; dists[i]=dists[0];
  // VectorCopy(vecs, vecs+i*3)`) is read directly from index 0 below rather
  // than physically appended, per SubdividePolygon's identical note.
  const newv: [Vec3[], Vec3[]] = [[], []];

  for (let i = 0; i < nump; i++) {
    const v = verts[i];
    const side = sides[i];
    const nextSide = i + 1 < nump ? sides[i + 1] : sides[0];
    const dist = dists[i];
    const nextDist = i + 1 < nump ? dists[i + 1] : dists[0];
    const vNext = i + 1 < nump ? verts[i + 1] : verts[0];

    switch (side) {
      case SIDE_FRONT:
        newv[0].push(vec3(v[0], v[1], v[2]));
        break;
      case SIDE_BACK:
        newv[1].push(vec3(v[0], v[1], v[2]));
        break;
      case SIDE_ON:
        newv[0].push(vec3(v[0], v[1], v[2]));
        newv[1].push(vec3(v[0], v[1], v[2]));
        break;
      default:
        break;
    }

    if (side === SIDE_ON || nextSide === SIDE_ON || nextSide === side) continue;

    const d = dist / (dist - nextDist);
    const clip = vec3();
    for (let j = 0; j < 3; j++) {
      clip[j] = v[j] + d * (vNext[j] - v[j]);
    }
    newv[0].push(vec3(clip[0], clip[1], clip[2]));
    newv[1].push(vec3(clip[0], clip[1], clip[2]));
  }

  // continue
  ClipSkyPolygon(newv[0], stage + 1);
  ClipSkyPolygon(newv[1], stage + 1);
}

/*
=================
R_AddSkySurface
=================
*/
export function R_AddSkySurface(fa: MsurfaceT): void {
  for (let p = fa.polys; p; p = p.next) {
    const verts: Vec3[] = [];
    for (let i = 0; i < p.numverts; i++) {
      const row = p.verts[i];
      const vv = vec3();
      VectorSubtract(row.subarray(0, 3), r_origin, vv);
      verts.push(vv);
    }
    ClipSkyPolygon(verts, 0);
  }
}

/*
==============
R_ClearSkyBox
==============
*/
export function R_ClearSkyBox(): void {
  for (let i = 0; i < 6; i++) {
    skymins[0][i] = skymins[1][i] = 9999;
    skymaxs[0][i] = skymaxs[1][i] = -9999;
  }
}

export function MakeSkyVec(s: number, t: number, axis: number): void {
  const b = vec3(s * 2300, t * 2300, 2300);
  const v = vec3();

  for (let j = 0; j < 3; j++) {
    const k = st_to_vec[axis][j];
    v[j] = k < 0 ? -b[-k - 1] : b[k - 1];
  }

  // avoid bilerp seam
  let ss = (s + 1) * 0.5;
  let tt = (t + 1) * 0.5;

  if (ss < sky_min) ss = sky_min;
  else if (ss > sky_max) ss = sky_max;
  if (tt < sky_min) tt = sky_min;
  else if (tt > sky_max) tt = sky_max;

  tt = 1.0 - tt;
  qgl.qglTexCoord2f(ss, tt);
  qgl.qglVertex3fv(v);
}

/*
==============
R_DrawSkyBox
==============
*/
const skytexorder: readonly number[] = fixedLength("skytexorder", 6, [0, 2, 1, 3, 4, 5]);

export function R_DrawSkyBox(): void {
  if (skyrotate) {
    // check for no sky at all
    let i = 0;
    for (; i < 6; i++) {
      if (skymins[0][i] < skymaxs[0][i] && skymins[1][i] < skymaxs[1][i]) break;
    }
    if (i === 6) return; // nothing visible
  }

  qgl.qglPushMatrix();
  qgl.qglTranslatef(r_origin[0], r_origin[1], r_origin[2]);
  qgl.qglRotatef(r_newrefdef.time * skyrotate, skyaxis[0], skyaxis[1], skyaxis[2]);

  for (let i = 0; i < 6; i++) {
    if (skyrotate) {
      // hack, forces full sky to draw when rotating
      skymins[0][i] = -1;
      skymins[1][i] = -1;
      skymaxs[0][i] = 1;
      skymaxs[1][i] = 1;
    }

    if (skymins[0][i] >= skymaxs[0][i] || skymins[1][i] >= skymaxs[1][i]) continue;

    // C dereferences sky_images[skytexorder[i]]->texnum unconditionally,
    // relying on R_SetSky always having populated every slot (falling back
    // to r_notexture on a missing file); guarded here since TS tracks null.
    const image = sky_images[skytexorder[i]];
    if (!image) continue;
    GL_Bind(image.texnum);

    qgl.qglBegin(GL_QUADS);
    MakeSkyVec(skymins[0][i], skymins[1][i], i);
    MakeSkyVec(skymins[0][i], skymaxs[1][i], i);
    MakeSkyVec(skymaxs[0][i], skymaxs[1][i], i);
    MakeSkyVec(skymaxs[0][i], skymins[1][i], i);
    qgl.qglEnd();
  }
  qgl.qglPopMatrix();
}

/*
============
R_SetSky
============
*/
// 3dstudio environment map names
const suf: readonly string[] = fixedLength("suf", 6, ["rt", "bk", "lf", "ft", "up", "dn"]);

export function R_SetSky(name: string, rotate: number, axis: Vec3): void {
  skyname = name.slice(0, MAX_QPATH - 1);
  skyrotate = rotate;
  VectorCopy(axis, skyaxis);

  for (let i = 0; i < 6; i++) {
    // chop down rotating skies for less memory
    const skymip = glCvars.gl_skymip !== null && glCvars.gl_skymip.value !== 0;
    if (skymip || skyrotate) {
      if (glCvars.gl_picmip) glCvars.gl_picmip.value++;
    }

    const usePaletted = Boolean(qgl.qglColorTableEXT) && glCvars.gl_ext_palettedtexture !== null && glCvars.gl_ext_palettedtexture.value !== 0;
    const ext = usePaletted ? ".pcx" : ".tga";
    const pathname = `env/${skyname}${suf[i]}${ext}`;

    let image = GL_FindImage(pathname, ImagetypeT.it_sky);
    if (!image) image = r_notexture;
    sky_images[i] = image;

    if (skymip || skyrotate) {
      // take less memory
      if (glCvars.gl_picmip) glCvars.gl_picmip.value--;
      sky_min = 1.0 / 256;
      sky_max = 255.0 / 256;
    } else {
      sky_min = 1.0 / 512;
      sky_max = 511.0 / 512;
    }
  }
}
