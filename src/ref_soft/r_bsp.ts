/*
Copyright (C) 1997-2001 Id Software, Inc.

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, write to the Free Software
Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.

Ported from ref_soft/r_bsp.c (GNU GPL v2 or later). `R_RecursiveClipBPoly`
is a static internal helper (not declared in r_local.h) and is not exported,
matching the sibling units' convention for internal helpers of this shape.

Cross-module mutable state: `currentmodel`/`currententity`/
`r_pcurrentvertbase`/`r_worldmodel` are r_local.h externs owned by r_local.ts.
R_RenderWorld assigns the first three through its setters (an imported `let`
binding is read-only to the importer) and R_RenderFace/R_RenderBmodelFace
(r_rast.ts) read them back. All four are re-exported from here because
r_light.ts/r_surf.ts/r_main.ts already reach them through this module.
*/

import { type Vec3, vec3, DotProduct, VectorCopy, R_ConcatRotations, type Mat3 } from "../shared/math";
import { CplaneT, CONTENTS_SOLID, M_PI, PRINT_ALL, RDF_NOWORLDMODEL, SURF_TRANS33, SURF_TRANS66 } from "../shared/q_shared";
import { PLANE_X, PLANE_Y, PLANE_Z } from "../qcommon/qfiles";
import {
  BACKFACE_EPSILON,
  BedgeT,
  PITCH,
  YAW,
  ROLL,
  vpn,
  vright,
  vup,
  modelorg,
  r_entorigin,
  r_origin,
  r_worldentity,
  r_newrefdef,
  r_visframecount,
  r_framecount,
  currentmodel,
  currententity,
  r_pcurrentvertbase,
  r_worldmodel,
  SetCurrentModel,
  SetCurrentEntity,
  SetCurrentVertBase,
  SetWorldModel,
  view_clipplanes,
  pfrustum_indexes,
  rCvars,
  ri,
} from "./r_local";
import { type MnodeOrLeaf, type ModelT, type MsurfaceT, MvertexT, isMleaf, SURF_PLANEBACK } from "./r_model";
import { R_TransformFrustum } from "./r_misc";
import { R_RenderFace, R_RenderBmodelFace, rKey } from "./r_rast";

// `currentmodel`/`currententity`/`r_pcurrentvertbase`/`r_worldmodel` are
// r_local.h externs owned by r_local.ts; re-exported here because r_light.ts/
// r_surf.ts/r_main.ts already reach them through this module.
export { currentmodel, currententity, r_pcurrentvertbase, r_worldmodel } from "./r_local";

export function setWorldModelForTesting(m: ModelT | null): void {
  SetWorldModel(m);
}

export let c_drawnode = 0;

//===========================================================================

const MAX_BMODEL_VERTS = 500; // 6K
const MAX_BMODEL_EDGES = 1000; // 12K

let pbverts: MvertexT[] = [];
let pbedges: BedgeT[] = [];
let numbverts = 0;
let numbedges = 0;

// r_bsp.c declares these two as FILE-SCOPE STATICS (line 47: "static
// mvertex_t *pfrontenter, *pfrontexit;"), not locals -- their value
// persists across calls, including across recursive invocations, exactly
// like entity_rotation below. This matters: R_RecursiveClipBPoly's per-edge
// loop clips a bmodel polygon against a chain of BSP planes several levels
// deep, and CotM's higher-precision QBSP-extended bmodel geometry
// occasionally produces a single recursion level where, due to ordinary
// floating-point drift across successive plane clips, the edge loop records
// only one of the two plane-crossings a closed polygon loop should always
// pair up (an entering transition with no matching exit, or vice versa) --
// confirmed live on maps/mguhub.bsp with numbverts/numbedges nowhere near
// MAX_BMODEL_VERTS/MAX_BMODEL_EDGES (13/500, 43/1000), so this is NOT the
// fixed-pool overflow it first looked like. In vanilla, the unset one of the
// pair simply keeps whatever real vertex pointer it held from the last time
// it WAS set (almost always populated by then, since a frame's very first
// bmodel already primes both) and reuses it, producing an ordinary rendering
// artifact (a sliver edge connecting the wrong two points) -- never a crash.
// A local `let`, reset to null every call, throws that stale-but-valid
// safety net away and turns the same geometry into a hard crash. Per the
// FIDELITY RAZOR (memory-model-dependent C behavior gets fixed to match the
// ORIGINAL's observed behavior, not its literal storage class), restoring
// static-equivalent module scope here reproduces vanilla's actual outcome:
// keep rendering, never crash. See the null check below for the residual
// case (no prior value exists yet at all).
let pfrontenter: MvertexT | null = null;
let pfrontexit: MvertexT | null = null;

// entity_rotation is r_bsp.c's own file-scope static, used only within this
// file (r_local.h declares it extern, but grep of the whole C tree shows no
// other .c file ever reads it).
let entity_rotation: Mat3 = [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)];

/*
================
R_EntityRotate
================
*/
function R_EntityRotate(vecInOut: Vec3): void {
  const tvec = vec3(vecInOut[0], vecInOut[1], vecInOut[2]);
  vecInOut[0] = DotProduct(entity_rotation[0], tvec);
  vecInOut[1] = DotProduct(entity_rotation[1], tvec);
  vecInOut[2] = DotProduct(entity_rotation[2], tvec);
}

/*
================
R_RotateBmodel
================
*/
export function R_RotateBmodel(): void {
  if (!currententity) throw new Error("R_RotateBmodel: currententity not set");

  // yaw
  let angle = (currententity.angles[YAW] * (M_PI * 2)) / 360;
  let s = Math.sin(angle);
  let c = Math.cos(angle);

  const temp1: Mat3 = [vec3(c, s, 0), vec3(-s, c, 0), vec3(0, 0, 1)];

  // pitch
  angle = (currententity.angles[PITCH] * (M_PI * 2)) / 360;
  s = Math.sin(angle);
  c = Math.cos(angle);

  const temp2: Mat3 = [vec3(c, 0, -s), vec3(0, 1, 0), vec3(s, 0, c)];

  const temp3: Mat3 = [vec3(), vec3(), vec3()];
  R_ConcatRotations(temp2, temp1, temp3);

  // roll
  angle = (currententity.angles[ROLL] * (M_PI * 2)) / 360;
  s = Math.sin(angle);
  c = Math.cos(angle);

  const rollMat: Mat3 = [vec3(1, 0, 0), vec3(0, c, s), vec3(0, -s, c)];

  R_ConcatRotations(rollMat, temp3, entity_rotation);

  // rotate modelorg and the transformation matrix
  R_EntityRotate(modelorg);
  R_EntityRotate(vpn);
  R_EntityRotate(vright);
  R_EntityRotate(vup);

  R_TransformFrustum();
}

/*
================
R_RecursiveClipBPoly

Clip a bmodel poly down the world bsp tree
================
*/
function R_RecursiveClipBPoly(pedgesIn: BedgeT | null, pnode: MnodeOrLeaf, psurf: MsurfaceT): void {
  const psideedges: [BedgeT | null, BedgeT | null] = [null, null];
  let makeclippededge = false;

  if (isMleaf(pnode)) throw new Error("R_RecursiveClipBPoly: expected a decision node");

  // transform the BSP plane into model space
  const splitplane = pnode.plane;
  if (!splitplane) throw new Error("R_RecursiveClipBPoly: node has no plane");

  const tplane = new CplaneT();
  tplane.dist = splitplane.dist - DotProduct(r_entorigin, splitplane.normal);
  tplane.normal[0] = DotProduct(entity_rotation[0], splitplane.normal);
  tplane.normal[1] = DotProduct(entity_rotation[1], splitplane.normal);
  tplane.normal[2] = DotProduct(entity_rotation[2], splitplane.normal);

  // clip edges to BSP plane
  let pedges = pedgesIn;
  while (pedges) {
    const pnextedge = pedges.pnext;

    const plastvert = pedges.v[0];
    const pvert = pedges.v[1];
    if (!plastvert || !pvert) throw new Error("R_RecursiveClipBPoly: bedge missing vertex");

    const lastdist = DotProduct(plastvert.position, tplane.normal) - tplane.dist;
    const lastside = lastdist > 0 ? 0 : 1;

    const dist = DotProduct(pvert.position, tplane.normal) - tplane.dist;
    const side = dist > 0 ? 0 : 1;

    if (side !== lastside) {
      // clipped
      if (numbverts >= MAX_BMODEL_VERTS) return;

      // generate the clipped vertex
      const frac = lastdist / (lastdist - dist);
      const ptvert = pbverts[numbverts++];
      ptvert.position[0] = plastvert.position[0] + frac * (pvert.position[0] - plastvert.position[0]);
      ptvert.position[1] = plastvert.position[1] + frac * (pvert.position[1] - plastvert.position[1]);
      ptvert.position[2] = plastvert.position[2] + frac * (pvert.position[2] - plastvert.position[2]);

      // split into two edges, one on each side, and remember entering
      // and exiting points
      if (numbedges >= MAX_BMODEL_EDGES - 1) {
        ri.Con_Printf(PRINT_ALL, "Out of edges for bmodel\n");
        return;
      }

      let ptedge = pbedges[numbedges];
      ptedge.pnext = psideedges[lastside];
      psideedges[lastside] = ptedge;
      ptedge.v[0] = plastvert;
      ptedge.v[1] = ptvert;

      ptedge = pbedges[numbedges + 1];
      ptedge.pnext = psideedges[side];
      psideedges[side] = ptedge;
      ptedge.v[0] = ptvert;
      ptedge.v[1] = pvert;

      numbedges += 2;

      if (side === 0) {
        // entering for front, exiting for back
        pfrontenter = ptvert;
        makeclippededge = true;
      } else {
        pfrontexit = ptvert;
        makeclippededge = true;
      }
    } else {
      // add the edge to the appropriate side
      pedges.pnext = psideedges[side];
      psideedges[side] = pedges;
    }

    pedges = pnextedge;
  }

  // if anything was clipped, reconstitute and add the edges along the clip
  // plane to both sides (but in opposite directions)
  if (makeclippededge) {
    if (numbedges >= MAX_BMODEL_EDGES - 2) {
      ri.Con_Printf(PRINT_ALL, "Out of edges for bmodel\n");
      return;
    }
    if (!pfrontexit || !pfrontenter) {
      // Only reachable before ANY bmodel poly has ever been clipped this
      // process (see pfrontenter/pfrontexit's own module-scope comment
      // above) -- vanilla's raw pointer reuse has no equivalent failure mode
      // worth reproducing here, so degrade like the capacity checks above
      // instead of dereferencing a still-unset vertex.
      ri.Con_Printf(PRINT_ALL, "R_RecursiveClipBPoly: no prior clip vertex available, dropping poly\n");
      return;
    }

    let ptedge = pbedges[numbedges];
    ptedge.pnext = psideedges[0];
    psideedges[0] = ptedge;
    ptedge.v[0] = pfrontexit;
    ptedge.v[1] = pfrontenter;

    ptedge = pbedges[numbedges + 1];
    ptedge.pnext = psideedges[1];
    psideedges[1] = ptedge;
    ptedge.v[0] = pfrontenter;
    ptedge.v[1] = pfrontexit;

    numbedges += 2;
  }

  // draw or recurse further
  for (let i = 0; i < 2; i++) {
    if (!psideedges[i]) continue;

    // draw if we've reached a non-solid leaf, done if all that's left is a
    // solid leaf, and continue down the tree if it's not a leaf
    const pn = pnode.children[i];
    if (!pn) continue;

    // we're done with this branch if the node or leaf isn't in the PVS
    if (pn.visframe !== r_visframecount) continue;

    if (isMleaf(pn)) {
      if (pn.contents !== CONTENTS_SOLID) {
        if (r_newrefdef.areabits) {
          const area = pn.area;
          if (!(r_newrefdef.areabits[area >> 3] & (1 << (area & 7)))) continue; // not visible
        }

        rKey.currentB = pn.key;
        R_RenderBmodelFace(psideedges[i], psurf);
      }
    } else {
      R_RecursiveClipBPoly(psideedges[i], pn, psurf);
    }
  }
}

/*
================
R_DrawSolidClippedSubmodelPolygons

Bmodel crosses multiple leafs
================
*/
export function R_DrawSolidClippedSubmodelPolygons(pmodel: ModelT, topnode: MnodeOrLeaf): void {
  const numsurfaces = pmodel.nummodelsurfaces;
  const pedgesArr = pmodel.edges;

  if (!r_pcurrentvertbase) throw new Error("R_DrawSolidClippedSubmodelPolygons: r_pcurrentvertbase not set");

  for (let i = 0; i < numsurfaces; i++) {
    const psurf = pmodel.surfaces[pmodel.firstmodelsurface + i];

    // find which side of the node we are on
    const pplane = psurf.plane;
    if (!pplane) throw new Error("R_DrawSolidClippedSubmodelPolygons: surface has no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if ((!(psurf.flags & SURF_PLANEBACK) && dot < -BACKFACE_EPSILON) || ((psurf.flags & SURF_PLANEBACK) !== 0 && dot > BACKFACE_EPSILON)) continue;

    // copy the edges to bedges, flipping if necessary so always
    // clockwise winding
    pbverts = Array.from({ length: MAX_BMODEL_VERTS }, () => new MvertexT());
    pbedges = Array.from({ length: MAX_BMODEL_EDGES }, () => new BedgeT());
    numbverts = 0;
    numbedges = psurf.numedges;

    for (let j = 0; j < psurf.numedges; j++) {
      let lindex = pmodel.surfedges[psurf.firstedge + j];

      if (lindex > 0) {
        const pedge = pedgesArr[lindex];
        pbedges[j].v[0] = r_pcurrentvertbase[pedge.v[0]];
        pbedges[j].v[1] = r_pcurrentvertbase[pedge.v[1]];
      } else {
        lindex = -lindex;
        const pedge = pedgesArr[lindex];
        pbedges[j].v[0] = r_pcurrentvertbase[pedge.v[1]];
        pbedges[j].v[1] = r_pcurrentvertbase[pedge.v[0]];
      }

      pbedges[j].pnext = pbedges[j + 1];
    }

    pbedges[psurf.numedges - 1].pnext = null; // mark end of edges

    if (!psurf.texinfo) throw new Error("R_DrawSolidClippedSubmodelPolygons: surface has no texinfo");

    if (!(psurf.texinfo.flags & (SURF_TRANS66 | SURF_TRANS33))) {
      R_RecursiveClipBPoly(pbedges[0], topnode, psurf);
    } else {
      R_RenderBmodelFace(pbedges[0], psurf);
    }
  }
}

/*
================
R_DrawSubmodelPolygons

All in one leaf
================
*/
export function R_DrawSubmodelPolygons(pmodel: ModelT, clipflags: number, topnode: MnodeOrLeaf): void {
  if (!isMleaf(topnode)) throw new Error("R_DrawSubmodelPolygons: topnode must be a leaf");

  const numsurfaces = pmodel.nummodelsurfaces;

  for (let i = 0; i < numsurfaces; i++) {
    const psurf = pmodel.surfaces[pmodel.firstmodelsurface + i];

    // find which side of the node we are on
    const pplane = psurf.plane;
    if (!pplane) throw new Error("R_DrawSubmodelPolygons: surface has no plane");

    const dot = DotProduct(modelorg, pplane.normal) - pplane.dist;

    // draw the polygon
    if ((psurf.flags & SURF_PLANEBACK && dot < -BACKFACE_EPSILON) || (!(psurf.flags & SURF_PLANEBACK) && dot > BACKFACE_EPSILON)) {
      rKey.current = topnode.key;
      R_RenderFace(psurf, clipflags);
    }
  }
}

/*
================
R_RecursiveWorldNode
================
*/
export function R_RecursiveWorldNode(node: MnodeOrLeaf, clipflagsIn: number): void {
  if (node.contents === CONTENTS_SOLID) return; // solid

  if (node.visframe !== r_visframecount) return;

  // cull the clipping planes if not trivial accept
  let clipflags = clipflagsIn;
  if (clipflags) {
    for (let i = 0; i < 4; i++) {
      if (!(clipflags & (1 << i))) continue; // don't need to clip against it

      // generate accept and reject points
      const pindex = pfrustum_indexes[i];

      const rejectpt = vec3(node.minmaxs[pindex[0]], node.minmaxs[pindex[1]], node.minmaxs[pindex[2]]);

      let d = DotProduct(rejectpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;
      if (d <= 0) return;

      const acceptpt = vec3(node.minmaxs[pindex[3]], node.minmaxs[pindex[4]], node.minmaxs[pindex[5]]);

      d = DotProduct(acceptpt, view_clipplanes[i].normal);
      d -= view_clipplanes[i].dist;

      if (d >= 0) clipflags &= ~(1 << i); // node is entirely on screen
    }
  }

  c_drawnode++;

  // if a leaf node, draw stuff
  if (isMleaf(node)) {
    // check for door connected areas
    if (r_newrefdef.areabits) {
      if (!(r_newrefdef.areabits[node.area >> 3] & (1 << (node.area & 7)))) return; // not visible
    }

    const mark = node.firstmarksurface;
    const c = node.nummarksurfaces;

    for (let i = 0; i < c; i++) {
      mark[i].visframe = r_framecount;
    }

    node.key = rKey.current;
    rKey.current++; // all bmodels in a leaf share the same key
  } else {
    // node is just a decision point, so go down the apropriate sides

    // find which side of the node we are on
    const plane = node.plane;
    if (!plane) throw new Error("R_RecursiveWorldNode: node has no plane");

    let dot: number;
    switch (plane.type) {
      case PLANE_X:
        dot = modelorg[0] - plane.dist;
        break;
      case PLANE_Y:
        dot = modelorg[1] - plane.dist;
        break;
      case PLANE_Z:
        dot = modelorg[2] - plane.dist;
        break;
      default:
        dot = DotProduct(modelorg, plane.normal) - plane.dist;
        break;
    }

    const side = dot >= 0 ? 0 : 1;

    // recurse down the children, front side first
    const nearChild = node.children[side];
    if (nearChild) R_RecursiveWorldNode(nearChild, clipflags);

    // draw stuff
    let c = node.numsurfaces;

    if (c) {
      if (!r_worldmodel) throw new Error("R_RecursiveWorldNode: r_worldmodel not set");

      let idx = node.firstsurface;

      if (dot < -BACKFACE_EPSILON) {
        for (; c > 0; c--, idx++) {
          const surf = r_worldmodel.surfaces[idx];
          if (surf.flags & SURF_PLANEBACK && surf.visframe === r_framecount) {
            R_RenderFace(surf, clipflags);
          }
        }
      } else if (dot > BACKFACE_EPSILON) {
        for (; c > 0; c--, idx++) {
          const surf = r_worldmodel.surfaces[idx];
          if (!(surf.flags & SURF_PLANEBACK) && surf.visframe === r_framecount) {
            R_RenderFace(surf, clipflags);
          }
        }
      }

      // all surfaces on the same node share the same sequence number
      rKey.current++;
    }

    // recurse down the back side
    const farChild = node.children[side === 0 ? 1 : 0];
    if (farChild) R_RecursiveWorldNode(farChild, clipflags);
  }
}

/*
================
R_RenderWorld
================
*/
export function R_RenderWorld(): void {
  if (!rCvars.r_drawworld || !rCvars.r_drawworld.value) return;
  if (r_newrefdef.rdflags & RDF_NOWORLDMODEL) return;

  c_drawnode = 0;

  // auto cycle the world frame for texture animation
  r_worldentity.frame = Math.trunc(r_newrefdef.time * 2);
  SetCurrentEntity(r_worldentity);

  VectorCopy(r_origin, modelorg);
  if (!r_worldmodel) throw new Error("R_RenderWorld: r_worldmodel not set");
  SetCurrentModel(r_worldmodel);
  SetCurrentVertBase(r_worldmodel.vertexes);

  R_RecursiveWorldNode(r_worldmodel.nodes[0], 15);
}
