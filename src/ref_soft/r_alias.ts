/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_alias.c (GNU GPL v2 or later): routines for setting
up to draw alias (MD2) models. `R_AliasCheckFrameBBox`/`R_AliasCheckBBox`/
`R_AliasTransformVector`/`R_AliasPreparePoints`/`R_AliasSetUpTransform`/
`R_AliasTransformFinalVerts`/`R_AliasSetupSkin`/`R_AliasSetupLighting`/
`R_AliasSetupFrames`/`R_AliasSetUpLerpData` are internal to the model-drawing
pipeline (not declared in r_local.h) and stay module-private, per the
pending stub's note. `R_AliasProjectAndClipTestFinalVert` is exported
because r_aclip.ts's R_Alias_clip_z calls it (see that file's header
comment on the resulting circular value import -- safe because both sides
only touch the other's export from inside function bodies, never at
module-init time).

Dropped per PORTING.md's id386/asm rule: the entire `#if id386 &&
!defined __linux__` inline-asm body of R_AliasTransformFinalVerts; its
`#else` C fallback (lines 750-805 of the .c file) is the only version
ported. `r_lerped[1024]` and the `aedge_t aedges[12]` table are declared in
the C file but never read anywhere in it (dead globals, presumably left
over from an abandoned bbox-edge-clipping path) and are not ported.

ParsedMd2T reshaping: the C code walks `dmdl_t`/`daliasframe_t`/
`dtrivertx_t`/`dstvert_t`/`dtriangle_t` as raw offsets into one Hunk-allocated
byte blob (`s_pmdl`, `r_thisframe`, `r_lastframe`, `pstverts`, `ptri`).
r_model.ts's Mod_LoadAliasModel already parses the whole MD2 into a
`ParsedMd2T` object graph (`ModelT.extradata`, narrowed here with
`instanceof ParsedMd2T` since `extradata` is typed `unknown`) with real
arrays (`hdr.frames[i].verts[j]`, `hdr.stverts[i]`, `hdr.triangles[i]`)
instead of pointer arithmetic, so every `(byte*)pmdl + ofs_x + i*stride`
walk below becomes a plain array index. `DaliasframeT`/`DtrivertxT` are not
exported by r_model.ts (out of this unit's SCOPE to change), so this file
names them via the indexed-access types `DaliasframeLike`/`DtrivertxLike`
below instead of importing the class names directly.

Cross-module mutable state (imported `let` bindings are read-only outside
their declaring module, so every r_local.h extern written from here goes
through a setter): `r_amodels_drawn` through r_local.ts's `SetAmodelsDrawn`,
`r_aliasblendcolor` through r_polyse.ts's `R_SetAliasBlendColor` (r_polyse.c
is the C reader, in the ConstantX_33/66 span drawers).
`aliasxscale`/`aliasyscale`/`aliasxcenter`/`aliasycenter` are read from
r_local.ts, where R_ViewChanged (r_misc.ts) refreshes them every frame;
R_AliasDrawModel snapshots them into `l_alias*` locals and performs the
RF_WEAPONMODEL left-hand x-flip on the snapshot. The C original flips the
global itself and never restores it, so a weapon model there leaves the flip
in place for the rest of the frame -- reported deviation, the snapshot is
confined to one model.
*/

import { AngleVectors, DotProduct, R_ConcatTransforms, VectorCopy, VectorInverse, VectorSubtract, type Mat3x4, type Vec3, vec3 } from "../shared/math";
import { PRINT_ALL, RF_DEPTHHACK, RF_FULLBRIGHT, RF_GLOW, RF_IR_VISIBLE, RF_MINLIGHT, RF_SHELL_BLUE, RF_SHELL_DOUBLE, RF_SHELL_GREEN, RF_SHELL_HALF_DAM, RF_SHELL_RED, RF_TRANSLUCENT, RF_WEAPONMODEL, RDF_IRGOGGLES } from "../shared/q_shared";
import { POWERSUIT_SCALE, SHELL_BG_COLOR, SHELL_BLUE_COLOR, SHELL_DOUBLE_COLOR, SHELL_GREEN_COLOR, SHELL_HALF_DAM_COLOR, SHELL_RB_COLOR, SHELL_RED_COLOR, SHELL_RG_COLOR, SHELL_WHITE_COLOR, type EntityT } from "../client/ref";
import { bytedirs } from "../qcommon/anorms";
import { R_LightPoint } from "./r_light";
import { R_AliasClipTriangle } from "./r_aclip";
import {
  R_PolysetDrawSpans8_33,
  R_PolysetDrawSpans8_66,
  R_PolysetDrawSpans8_Opaque,
  R_PolysetDrawSpansConstant8_33,
  R_PolysetDrawSpansConstant8_66,
  R_PolysetUpdateTables,
  R_SetAliasBlendColor,
  R_SetDrawSpansFn,
  R_SetIractive,
  R_DrawTriangle,
} from "./r_polyse";
import {
  ALIAS_LEFT_CLIP,
  ALIAS_TOP_CLIP,
  ALIAS_RIGHT_CLIP,
  ALIAS_BOTTOM_CLIP,
  ALIAS_Z_CLIP,
  ALIAS_Z_CLIP_PLANE,
  CACHE_SIZE,
  MAXALIASVERTS,
  PITCH,
  ROLL,
  VID_CBITS,
  VID_GRADES,
  YAW,
  aliasxcenter,
  aliasxscale,
  aliasycenter,
  aliasyscale,
  aliastriangleparms,
  currententity,
  currentmodel,
  r_affinetridesc,
  r_newrefdef,
  r_origin,
  r_refdef,
  rCvars,
  ri,
  view_clipplanes,
  vpn,
  vright,
  vup,
  FinalvertT,
  r_amodels_drawn,
  SetAmodelsDrawn,
} from "./r_local";
import { ImageT, ModelT, ParsedMd2T } from "./r_model";

const LIGHT_MIN = 5; // lowest light value we'll allow, to avoid the need for inner-loop light clamping

type DaliasframeLike = ParsedMd2T["frames"][number];
type DtrivertxLike = DaliasframeLike["verts"][number];

let l_aliasxscale = 0;
let l_aliasyscale = 0;
let l_aliasxcenter = 0;
let l_aliasycenter = 0;

const r_plightvec: Vec3 = vec3();

let r_ambientlight = 0;
let r_shadelight = 0;

let r_thisframe: DaliasframeLike | null = null;
let r_lastframe: DaliasframeLike | null = null;
let s_pmdl: ParsedMd2T | null = null;

function mat3x4(): Mat3x4 {
  return [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
}

const aliastransform: Mat3x4 = mat3x4();
const aliasworldtransform: Mat3x4 = mat3x4();
const aliasoldworldtransform: Mat3x4 = mat3x4();

let s_ziscale = 0;
const s_alias_forward: Vec3 = vec3();
const s_alias_right: Vec3 = vec3();
const s_alias_up: Vec3 = vec3();

// exported (const object bindings' elements are freely mutable/readable
// from outside without hitting the imported-`let` wall -- see this file's
// header comment) so test/ref_alias.test.ts can verify
// R_AliasSetUpLerpData's output directly.
export const r_lerp_frontv: Vec3 = vec3();
export const r_lerp_backv: Vec3 = vec3();
export const r_lerp_move: Vec3 = vec3();

const BBOX_TRIVIAL_ACCEPT = 0;
const BBOX_MUST_CLIP_XY = 1;
const BBOX_MUST_CLIP_Z = 2;
const BBOX_TRIVIAL_REJECT = 8;

// preallocated pool for R_AliasPreparePoints's stack-local `finalverts` --
// the C cache-alignment pointer trick around it is a pure memory-layout
// micro-optimization dropped for the same reason CplaneT drops pad bytes.
const finalvertsPool: FinalvertT[] = Array.from({ length: MAXALIASVERTS }, () => new FinalvertT());
void CACHE_SIZE; // referenced only by the dropped C cache-alignment trick

/*
================
R_AliasCheckFrameBBox

Returns a bitmask of BBOX_TRIVIAL_ACCEPT/BBOX_MUST_CLIP_XY/
BBOX_MUST_CLIP_Z/BBOX_TRIVIAL_REJECT -- the C original types this
`unsigned long` (not `qboolean`, despite R_AliasCheckBBox's C return type),
so this stays `number`.
================
*/
function R_AliasCheckFrameBBox(frame: DaliasframeLike, worldxf: Mat3x4): number {
  let aggregate_and_clipcode = ~0 >>> 0;
  let aggregate_or_clipcode = 0;

  const mins: Vec3 = vec3();
  const maxs: Vec3 = vec3();
  const transformed_min: Vec3 = vec3();
  const transformed_max: Vec3 = vec3();
  const zclipped = false;
  let zfullyclipped = true;

  // get the exact frame bounding box
  for (let i = 0; i < 3; i++) {
    mins[i] = frame.translate[i];
    maxs[i] = mins[i] + frame.scale[i] * 255;
  }

  // transform the min and max values into view space
  R_AliasTransformVector(mins, transformed_min, aliastransform);
  R_AliasTransformVector(maxs, transformed_max, aliastransform);

  if (transformed_min[2] >= ALIAS_Z_CLIP_PLANE) zfullyclipped = false;
  if (transformed_max[2] >= ALIAS_Z_CLIP_PLANE) zfullyclipped = false;

  if (zfullyclipped) return BBOX_TRIVIAL_REJECT;
  if (zclipped) return BBOX_MUST_CLIP_XY | BBOX_MUST_CLIP_Z;

  // build a transformed bounding box from the given min and max
  for (let i = 0; i < 8; i++) {
    const tmp: Vec3 = vec3();
    const transformed: Vec3 = vec3();
    let clipcode = 0;

    tmp[0] = i & 1 ? mins[0] : maxs[0];
    tmp[1] = i & 2 ? mins[1] : maxs[1];
    tmp[2] = i & 4 ? mins[2] : maxs[2];

    R_AliasTransformVector(tmp, transformed, worldxf);

    for (let j = 0; j < 4; j++) {
      const dp = DotProduct(transformed, view_clipplanes[j].normal);
      if (dp - view_clipplanes[j].dist < 0.0) clipcode |= 1 << j;
    }

    aggregate_and_clipcode &= clipcode;
    aggregate_or_clipcode |= clipcode;
  }

  if (aggregate_and_clipcode) return BBOX_TRIVIAL_REJECT;
  if (!aggregate_or_clipcode) return BBOX_TRIVIAL_ACCEPT;

  return BBOX_MUST_CLIP_XY;
}

/*
================
R_AliasCheckBBox
================
*/
function R_AliasCheckBBox(): number {
  if (currententity === null || r_thisframe === null) throw new Error("R_AliasCheckBBox: no current entity/frame");

  const ccode0 = R_AliasCheckFrameBBox(r_thisframe, aliasworldtransform);

  // non-lerping model
  if (currententity.backlerp === 0) {
    if (ccode0 === BBOX_TRIVIAL_ACCEPT) return BBOX_TRIVIAL_ACCEPT;
    else if (ccode0 & BBOX_TRIVIAL_REJECT) return BBOX_TRIVIAL_REJECT;
    else return ccode0 & ~BBOX_TRIVIAL_REJECT;
  }

  if (r_lastframe === null) throw new Error("R_AliasCheckBBox: no last frame");
  const ccode1 = R_AliasCheckFrameBBox(r_lastframe, aliasoldworldtransform);

  if ((ccode0 | ccode1) === BBOX_TRIVIAL_ACCEPT) return BBOX_TRIVIAL_ACCEPT;
  else if ((ccode0 & ccode1) & BBOX_TRIVIAL_REJECT) return BBOX_TRIVIAL_REJECT;
  else return (ccode0 | ccode1) & ~BBOX_TRIVIAL_REJECT;
}

/*
================
R_AliasTransformVector
================
*/
function R_AliasTransformVector(inV: Vec3, out: Vec3, xf: Mat3x4): void {
  out[0] = DotProduct(inV, xf[0]) + xf[0][3];
  out[1] = DotProduct(inV, xf[1]) + xf[1][3];
  out[2] = DotProduct(inV, xf[2]) + xf[2][3];
}

/*
================
R_AliasPreparePoints

General clipped case
================
*/
function R_AliasPreparePoints(): void {
  if (s_pmdl === null || r_lastframe === null || r_thisframe === null || currententity === null) {
    throw new Error("R_AliasPreparePoints: model/frame/entity not set up");
  }
  const pmdl = s_pmdl;

  // PGM
  R_SetIractive(r_newrefdef.rdflags & RDF_IRGOGGLES && currententity.flags & RF_IR_VISIBLE ? 1 : 0);

  const numPoints = pmdl.num_xyz;
  const pfinalverts = finalvertsPool;

  R_AliasTransformFinalVerts(numPoints, pfinalverts, r_lastframe.verts, r_thisframe.verts);

  // clip and draw all triangles
  const pstverts = pmdl.stverts;
  const triangles = pmdl.triangles;

  if (currententity.flags & RF_WEAPONMODEL && rCvars.r_lefthand !== null && rCvars.r_lefthand.value === 1.0) {
    for (let i = 0; i < pmdl.num_tris; i++) {
      const ptri = triangles[i];
      const pfv0 = pfinalverts[ptri.index_xyz[0]];
      const pfv1 = pfinalverts[ptri.index_xyz[1]];
      const pfv2 = pfinalverts[ptri.index_xyz[2]];

      if (pfv0.flags & pfv1.flags & pfv2.flags) continue; // completely clipped

      pfv0.s = pstverts[ptri.index_st[0]].s << 16;
      pfv0.t = pstverts[ptri.index_st[0]].t << 16;
      pfv1.s = pstverts[ptri.index_st[1]].s << 16;
      pfv1.t = pstverts[ptri.index_st[1]].t << 16;
      pfv2.s = pstverts[ptri.index_st[2]].s << 16;
      pfv2.t = pstverts[ptri.index_st[2]].t << 16;

      if (!(pfv0.flags | pfv1.flags | pfv2.flags)) {
        // totally unclipped
        aliastriangleparms.a = pfv2;
        aliastriangleparms.b = pfv1;
        aliastriangleparms.c = pfv0;
        R_DrawTriangle();
      } else {
        R_AliasClipTriangle(pfv2, pfv1, pfv0);
      }
    }
  } else {
    for (let i = 0; i < pmdl.num_tris; i++) {
      const ptri = triangles[i];
      const pfv0 = pfinalverts[ptri.index_xyz[0]];
      const pfv1 = pfinalverts[ptri.index_xyz[1]];
      const pfv2 = pfinalverts[ptri.index_xyz[2]];

      if (pfv0.flags & pfv1.flags & pfv2.flags) continue; // completely clipped

      pfv0.s = pstverts[ptri.index_st[0]].s << 16;
      pfv0.t = pstverts[ptri.index_st[0]].t << 16;
      pfv1.s = pstverts[ptri.index_st[1]].s << 16;
      pfv1.t = pstverts[ptri.index_st[1]].t << 16;
      pfv2.s = pstverts[ptri.index_st[2]].s << 16;
      pfv2.t = pstverts[ptri.index_st[2]].t << 16;

      if (!(pfv0.flags | pfv1.flags | pfv2.flags)) {
        // totally unclipped
        aliastriangleparms.a = pfv0;
        aliastriangleparms.b = pfv1;
        aliastriangleparms.c = pfv2;
        R_DrawTriangle();
      } else {
        // partially clipped
        R_AliasClipTriangle(pfv0, pfv1, pfv2);
      }
    }
  }
}

/*
================
R_AliasSetUpTransform
================
*/
function R_AliasSetUpTransform(): void {
  if (currententity === null) throw new Error("R_AliasSetUpTransform: no current entity");

  const viewmatrix: Mat3x4 = mat3x4();
  const angles: Vec3 = vec3();

  angles[ROLL] = currententity.angles[ROLL];
  angles[PITCH] = currententity.angles[PITCH];
  angles[YAW] = currententity.angles[YAW];
  AngleVectors(angles, s_alias_forward, s_alias_right, s_alias_up);

  for (const row of aliasworldtransform) row.fill(0);
  for (const row of aliasoldworldtransform) row.fill(0);

  for (let i = 0; i < 3; i++) {
    // faithful port of the C original's bug: aliasworldtransform correctly
    // fills columns 0/1/2, but every aliasoldworldtransform assignment
    // targets column 0 (a copy-paste typo in the C source that was never
    // fixed), so aliasoldworldtransform's columns 1/2 stay zero.
    aliasoldworldtransform[i][0] = aliasworldtransform[i][0] = s_alias_forward[i];
    aliasoldworldtransform[i][0] = aliasworldtransform[i][1] = -s_alias_right[i];
    aliasoldworldtransform[i][0] = aliasworldtransform[i][2] = s_alias_up[i];
  }

  aliasworldtransform[0][3] = currententity.origin[0] - r_origin[0];
  aliasworldtransform[1][3] = currententity.origin[1] - r_origin[1];
  aliasworldtransform[2][3] = currententity.origin[2] - r_origin[2];

  aliasoldworldtransform[0][3] = currententity.oldorigin[0] - r_origin[0];
  aliasoldworldtransform[1][3] = currententity.oldorigin[1] - r_origin[1];
  aliasoldworldtransform[2][3] = currententity.oldorigin[2] - r_origin[2];

  VectorCopy(vright, viewmatrix[0]);
  VectorCopy(vup, viewmatrix[1]);
  VectorInverse(viewmatrix[1]);
  VectorCopy(vpn, viewmatrix[2]);

  viewmatrix[0][3] = 0;
  viewmatrix[1][3] = 0;
  viewmatrix[2][3] = 0;

  R_ConcatTransforms(viewmatrix, aliasworldtransform, aliastransform);

  aliasworldtransform[0][3] = currententity.origin[0];
  aliasworldtransform[1][3] = currententity.origin[1];
  aliasworldtransform[2][3] = currententity.origin[2];

  aliasoldworldtransform[0][3] = currententity.oldorigin[0];
  aliasoldworldtransform[1][3] = currententity.oldorigin[1];
  aliasoldworldtransform[2][3] = currententity.oldorigin[2];
}

/*
================
R_AliasTransformFinalVerts

Portable (non-id386-asm) C fallback only -- see file header comment.
================
*/
function R_AliasTransformFinalVerts(numpoints: number, fv: FinalvertT[], oldv: DtrivertxLike[], newv: DtrivertxLike[]): void {
  if (currententity === null) throw new Error("R_AliasTransformFinalVerts: no current entity");
  const shellFlags = RF_SHELL_RED | RF_SHELL_GREEN | RF_SHELL_BLUE | RF_SHELL_DOUBLE | RF_SHELL_HALF_DAM;
  const lerped_vert: Vec3 = vec3();

  for (let i = 0; i < numpoints; i++) {
    const o = oldv[i];
    const n = newv[i];
    const dest = fv[i];

    lerped_vert[0] = r_lerp_move[0] + o.v[0] * r_lerp_backv[0] + n.v[0] * r_lerp_frontv[0];
    lerped_vert[1] = r_lerp_move[1] + o.v[1] * r_lerp_backv[1] + n.v[1] * r_lerp_frontv[1];
    lerped_vert[2] = r_lerp_move[2] + o.v[2] * r_lerp_backv[2] + n.v[2] * r_lerp_frontv[2];

    // bytedirs is guarded by fixedLength("bytedirs", NUMVERTEXNORMALS, ...) at
    // its declaration (src/qcommon/anorms.ts), so this index is safe as long
    // as model data never produces a lightnormalindex >= NUMVERTEXNORMALS.
    const plightnormal = bytedirs[n.lightnormalindex];

    // PMM - added double damage shell
    if (currententity.flags & shellFlags) {
      lerped_vert[0] += plightnormal[0] * POWERSUIT_SCALE;
      lerped_vert[1] += plightnormal[1] * POWERSUIT_SCALE;
      lerped_vert[2] += plightnormal[2] * POWERSUIT_SCALE;
    }

    dest.xyz[0] = DotProduct(lerped_vert, aliastransform[0]) + aliastransform[0][3];
    dest.xyz[1] = DotProduct(lerped_vert, aliastransform[1]) + aliastransform[1][3];
    dest.xyz[2] = DotProduct(lerped_vert, aliastransform[2]) + aliastransform[2][3];

    dest.flags = 0;

    // lighting
    const lightcos = DotProduct(plightnormal, r_plightvec);
    let temp = r_ambientlight;

    if (lightcos < 0) {
      temp += (r_shadelight * lightcos) | 0;
      if (temp < 0) temp = 0;
    }

    dest.l = temp;

    if (dest.xyz[2] < ALIAS_Z_CLIP_PLANE) {
      dest.flags |= ALIAS_Z_CLIP;
    } else {
      R_AliasProjectAndClipTestFinalVert(dest);
    }
  }
}

/*
================
R_AliasProjectAndClipTestFinalVert
================
*/
export function R_AliasProjectAndClipTestFinalVert(fv: FinalvertT): void {
  const x = fv.xyz[0];
  const y = fv.xyz[1];
  const z = fv.xyz[2];
  const zi = 1.0 / z;

  fv.zi = (zi * s_ziscale) | 0;

  fv.u = (x * l_aliasxscale * zi + l_aliasxcenter) | 0;
  fv.v = (y * l_aliasyscale * zi + l_aliasycenter) | 0;

  if (fv.u < r_refdef.aliasvrect.x) fv.flags |= ALIAS_LEFT_CLIP;
  if (fv.v < r_refdef.aliasvrect.y) fv.flags |= ALIAS_TOP_CLIP;
  if (fv.u > r_refdef.aliasvrectright) fv.flags |= ALIAS_RIGHT_CLIP;
  if (fv.v > r_refdef.aliasvrectbottom) fv.flags |= ALIAS_BOTTOM_CLIP;
}

/*
===============
R_AliasSetupSkin
===============
*/
function R_AliasSetupSkin(): boolean {
  if (currententity === null || currentmodel === null || s_pmdl === null) throw new Error("R_AliasSetupSkin: no current entity/model");

  let pskindesc: ImageT | null = currententity.skin instanceof ImageT ? currententity.skin : null;

  if (pskindesc === null) {
    let skinnum = currententity.skinnum;
    if (skinnum >= s_pmdl.num_skins || skinnum < 0) {
      ri.Con_Printf(PRINT_ALL, `R_AliasSetupSkin ${currentmodel.name}: no such skin # ${skinnum}\n`);
      skinnum = 0;
    }
    pskindesc = currentmodel.skins[skinnum] ?? null;
  }

  if (pskindesc === null) return false;

  r_affinetridesc.pskin = pskindesc.pixels[0];
  r_affinetridesc.skinwidth = pskindesc.width;
  r_affinetridesc.skinheight = pskindesc.height;

  R_PolysetUpdateTables(); // FIXME: precalc edge lookups

  return true;
}

/*
================
R_AliasSetupLighting

  FIXME: put lighting into tables
================
*/
function R_AliasSetupLighting(): void {
  if (currententity === null) throw new Error("R_AliasSetupLighting: no current entity");

  const lightvec: Vec3 = vec3(-1, 0, 0);
  const light: Vec3 = vec3();

  // all components of light should be identical in software
  if (currententity.flags & RF_FULLBRIGHT) {
    light[0] = light[1] = light[2] = 1.0;
  } else {
    R_LightPoint(currententity.origin, light);
  }

  // save off light value for server to look at (BIG HACK!)
  if (currententity.flags & RF_WEAPONMODEL && rCvars.r_lightlevel !== null) {
    rCvars.r_lightlevel.value = 150.0 * light[0];
  }

  if (currententity.flags & RF_MINLIGHT) {
    for (let i = 0; i < 3; i++) if (light[i] < 0.1) light[i] = 0.1;
  }

  if (currententity.flags & RF_GLOW) {
    // bonus items will pulse with time
    const scale = 0.1 * Math.sin(r_newrefdef.time * 7);
    for (let i = 0; i < 3; i++) {
      const min = light[i] * 0.8;
      light[i] += scale;
      if (light[i] < min) light[i] = min;
    }
  }

  const j = ((light[0] + light[1] + light[2]) * 0.3333 * 255) | 0;

  let ambientlight = j;
  let shadelight = j;

  // clamp lighting so it doesn't overbright as much
  if (ambientlight > 128) ambientlight = 128;
  if (ambientlight + shadelight > 192) shadelight = 192 - ambientlight;

  // guarantee that no vertex will ever be lit below LIGHT_MIN, so we don't
  // have to clamp off the bottom
  r_ambientlight = ambientlight;

  if (r_ambientlight < LIGHT_MIN) r_ambientlight = LIGHT_MIN;

  r_ambientlight = (255 - r_ambientlight) << VID_CBITS;

  if (r_ambientlight < LIGHT_MIN) r_ambientlight = LIGHT_MIN;

  r_shadelight = shadelight;

  if (r_shadelight < 0) r_shadelight = 0;

  r_shadelight *= VID_GRADES;

  // rotate the lighting vector into the model's frame of reference
  r_plightvec[0] = DotProduct(lightvec, s_alias_forward);
  r_plightvec[1] = -DotProduct(lightvec, s_alias_right);
  r_plightvec[2] = DotProduct(lightvec, s_alias_up);
}

/*
=================
R_AliasSetupFrames
=================
*/
function R_AliasSetupFrames(pmdl: ParsedMd2T): void {
  if (currententity === null || currentmodel === null) throw new Error("R_AliasSetupFrames: no current entity/model");

  let thisframe = currententity.frame;
  let lastframe = currententity.oldframe;

  if (thisframe >= pmdl.num_frames || thisframe < 0) {
    ri.Con_Printf(PRINT_ALL, `R_AliasSetupFrames ${currentmodel.name}: no such thisframe ${thisframe}\n`);
    thisframe = 0;
  }
  if (lastframe >= pmdl.num_frames || lastframe < 0) {
    ri.Con_Printf(PRINT_ALL, `R_AliasSetupFrames ${currentmodel.name}: no such lastframe ${lastframe}\n`);
    lastframe = 0;
  }

  r_thisframe = pmdl.frames[thisframe];
  r_lastframe = pmdl.frames[lastframe];
}

/*
** R_AliasSetUpLerpData
**
** Precomputes lerp coefficients used for the whole frame. Exported, and
** takes `entity`/`thisframe`/`lastframe` as explicit parameters rather than
** reading the module-global `currententity`/`r_thisframe`/`r_lastframe`
** the C original reads (all three still globals in C too -- this isn't a
** C signature it has to match, since it's not declared in r_local.h) --
** this is the only way to unit-test the interpolation math in isolation:
** `currententity` is an imported `let` from r_local.ts, and per this
** file's header comment (and every sibling unit's identical wall) nothing
** outside r_local.ts can assign to it, so a test cannot inject an entity
** any other way. R_AliasDrawModel below still sources all three values
** from the same module globals it always did; only this function's own
** parameter-passing changed.
*/
export function R_AliasSetUpLerpData(entity: EntityT, thisframe: DaliasframeLike, lastframe: DaliasframeLike, backlerp: number): void {
  const frontlerp = 1.0 - backlerp;
  const translation: Vec3 = vec3();
  const vectors: [Vec3, Vec3, Vec3] = [vec3(), vec3(), vec3()];

  // convert entity's angles into discrete vectors for R, U, and F
  AngleVectors(entity.angles, vectors[0], vectors[1], vectors[2]);

  // translation is the vector from last position to this position
  VectorSubtract(entity.oldorigin, entity.origin, translation);

  // move should be the delta back to the previous frame * backlerp
  r_lerp_move[0] = DotProduct(translation, vectors[0]); // forward
  r_lerp_move[1] = -DotProduct(translation, vectors[1]); // left
  r_lerp_move[2] = DotProduct(translation, vectors[2]); // up

  r_lerp_move[0] += lastframe.translate[0];
  r_lerp_move[1] += lastframe.translate[1];
  r_lerp_move[2] += lastframe.translate[2];

  for (let i = 0; i < 3; i++) {
    r_lerp_move[i] = backlerp * r_lerp_move[i] + frontlerp * thisframe.translate[i];
  }

  for (let i = 0; i < 3; i++) {
    r_lerp_frontv[i] = frontlerp * thisframe.scale[i];
    r_lerp_backv[i] = backlerp * lastframe.scale[i];
  }
}

/*
================
R_AliasDrawModel
================
*/
export function R_AliasDrawModel(): void {
  if (currententity === null || currentmodel === null) throw new Error("R_AliasDrawModel: no current entity/model");
  if (!(currentmodel.extradata instanceof ParsedMd2T)) throw new Error("R_AliasDrawModel: model has no parsed MD2 data");

  s_pmdl = currentmodel.extradata;

  if (rCvars.r_lerpmodels !== null && rCvars.r_lerpmodels.value === 0) currententity.backlerp = 0;

  // snapshot r_local.ts's (inert) scale/center exports -- see file header comment.
  l_aliasxscale = aliasxscale;
  l_aliasyscale = aliasyscale;
  l_aliasxcenter = aliasxcenter;
  l_aliasycenter = aliasycenter;

  const lefthandValue = rCvars.r_lefthand !== null ? rCvars.r_lefthand.value : 0;

  if (currententity.flags & RF_WEAPONMODEL) {
    if (lefthandValue === 1.0) {
      l_aliasxscale = -l_aliasxscale;
    } else if (lefthandValue === 2.0) {
      return;
    }
  }

  // we have to set our frame pointers and transformations before doing any real work
  R_AliasSetupFrames(s_pmdl);
  R_AliasSetUpTransform();

  // see if the bounding box lets us trivially reject, also sets trivial accept status
  if (R_AliasCheckBBox() === BBOX_TRIVIAL_REJECT) {
    return;
  }

  // set up the skin and verify it exists
  if (!R_AliasSetupSkin()) {
    ri.Con_Printf(PRINT_ALL, `R_AliasDrawModel ${currentmodel.name}: NULL skin found\n`);
    return;
  }

  SetAmodelsDrawn(r_amodels_drawn + 1);
  R_AliasSetupLighting();

  // select the proper span routine based on translucency
  // PMM - added double damage shell
  // PMM - reordered to handle blending
  const shellFlags = RF_SHELL_RED | RF_SHELL_GREEN | RF_SHELL_BLUE | RF_SHELL_DOUBLE | RF_SHELL_HALF_DAM;
  if (currententity.flags & shellFlags) {
    const color = currententity.flags & shellFlags;

    // PMM - reordered, new shells after old shells (so they get overriden)
    if (color === RF_SHELL_RED) R_SetAliasBlendColor(SHELL_RED_COLOR);
    else if (color === RF_SHELL_GREEN) R_SetAliasBlendColor(SHELL_GREEN_COLOR);
    else if (color === RF_SHELL_BLUE) R_SetAliasBlendColor(SHELL_BLUE_COLOR);
    else if (color === (RF_SHELL_RED | RF_SHELL_GREEN)) R_SetAliasBlendColor(SHELL_RG_COLOR);
    else if (color === (RF_SHELL_RED | RF_SHELL_BLUE)) R_SetAliasBlendColor(SHELL_RB_COLOR);
    else if (color === (RF_SHELL_BLUE | RF_SHELL_GREEN)) R_SetAliasBlendColor(SHELL_BG_COLOR);
    // PMM - added this .. it's yellowish
    else if (color === RF_SHELL_DOUBLE) R_SetAliasBlendColor(SHELL_DOUBLE_COLOR);
    else if (color === RF_SHELL_HALF_DAM) R_SetAliasBlendColor(SHELL_HALF_DAM_COLOR);
    // pmm
    else R_SetAliasBlendColor(SHELL_WHITE_COLOR);

    if (currententity.alpha > 0.33) R_SetDrawSpansFn(R_PolysetDrawSpansConstant8_66);
    else R_SetDrawSpansFn(R_PolysetDrawSpansConstant8_33);
  } else if (currententity.flags & RF_TRANSLUCENT) {
    if (currententity.alpha > 0.66) R_SetDrawSpansFn(R_PolysetDrawSpans8_Opaque);
    else if (currententity.alpha > 0.33) R_SetDrawSpansFn(R_PolysetDrawSpans8_66);
    else R_SetDrawSpansFn(R_PolysetDrawSpans8_33);
  } else {
    R_SetDrawSpansFn(R_PolysetDrawSpans8_Opaque);
  }

  // compute this_frame and old_frame addresses
  if (r_thisframe === null || r_lastframe === null) throw new Error("R_AliasDrawModel: frames not set up");
  R_AliasSetUpLerpData(currententity, r_thisframe, r_lastframe, currententity.backlerp);

  if (currententity.flags & RF_DEPTHHACK) s_ziscale = 0x8000 * 0x10000 * 3.0;
  else s_ziscale = 0x8000 * 0x10000;

  R_AliasPreparePoints();
}
