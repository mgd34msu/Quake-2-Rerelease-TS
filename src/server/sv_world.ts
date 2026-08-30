// world.c -- world query functions
//
// FIXME: this use of "area" is different from the bsp file use (original
// comment, sv_world.c).

import { type Vec3, vec3, vec3_origin, VectorAdd, VectorSubtract, VectorCopy } from "../shared/math";
import { type Edict, type GTraceT, LinkT, SolidT, SVF_DEADMONSTER, SVF_MONSTER, MAX_ENT_CLUSTERS } from "../game/game";
import { TraceT, MAX_EDICTS, CONTENTS_DEADMONSTER, AREA_SOLID } from "../shared/q_shared";
import {
  CM_BoxLeafnums,
  CM_LeafCluster,
  CM_LeafArea,
  CM_PointContents,
  CM_TransformedPointContents,
  CM_HeadnodeForBox,
  CM_BoxTrace,
  CM_TransformedBoxTrace,
} from "../qcommon/cmodel";
import { sv, ServerStateT, ENT_HISTORY_MASK } from "./server";
import { geHolder } from "./sv_game";
import { Com_DPrintf, Com_Printf, Com_Error } from "../qcommon/common";
import { ERR_FATAL } from "../qcommon/qcommon";

// (type *)STRUCT_FROM_LINK(link_t *link, type, member)
// ent = STRUCT_FROM_LINK(link,entity_t,order)
// FIXME: remove this mess! (original comment)
//
// C recovers the owning edict from an embedded link_t via pointer
// arithmetic (offsetof). TypeScript objects carry no such offset, so this
// port keeps a WeakMap from an edict's `area` link back to the edict --
// populated whenever SV_LinkEdict inserts that edict into an area list --
// as the faithful equivalent of EDICT_FROM_AREA(l). Reported as a deviation.
const areaEdictMap = new WeakMap<LinkT, Edict>();

function EDICT_FROM_AREA(l: LinkT): Edict {
  const e = areaEdictMap.get(l);
  if (!e) {
    throw new Error("SV_AreaEdicts: area link with no owning edict");
  }
  return e;
}

class AreaNodeT {
  axis = -1; // -1 = leaf node
  dist = 0;
  children: (AreaNodeT | null)[] = [null, null];
  trigger_edicts: LinkT = new LinkT();
  solid_edicts: LinkT = new LinkT();
}

const AREA_DEPTH = 4;
const AREA_NODES = 32;

const sv_areanodes: AreaNodeT[] = Array.from({ length: AREA_NODES }, () => new AreaNodeT());
let sv_numareanodes = 0;

let area_mins: Vec3 = vec3();
let area_maxs: Vec3 = vec3();
let area_list: Edict[] = [];
let area_count = 0;
let area_maxcount = 0;
let area_type = 0;

// ClearLink is used for new headnodes
function ClearLink(l: LinkT): void {
  l.prev = l;
  l.next = l;
}

function RemoveLink(l: LinkT): void {
  if (l.next) l.next.prev = l.prev;
  if (l.prev) l.prev.next = l.next;
}

function InsertLinkBefore(l: LinkT, before: LinkT): void {
  l.next = before;
  l.prev = before.prev;
  if (l.prev) l.prev.next = l;
  if (l.next) l.next.prev = l;
}

/*
===============
SV_CreateAreaNode

Builds a uniformly subdivided tree for the given world size
===============
*/
function SV_CreateAreaNode(depth: number, mins: Vec3, maxs: Vec3): AreaNodeT {
  const anode = sv_areanodes[sv_numareanodes];
  sv_numareanodes++;

  ClearLink(anode.trigger_edicts);
  ClearLink(anode.solid_edicts);

  if (depth === AREA_DEPTH) {
    anode.axis = -1;
    anode.children[0] = null;
    anode.children[1] = null;
    return anode;
  }

  const size = vec3();
  VectorSubtract(maxs, mins, size);
  if (size[0] > size[1]) anode.axis = 0;
  else anode.axis = 1;

  anode.dist = 0.5 * (maxs[anode.axis] + mins[anode.axis]);
  const mins1 = vec3(mins[0], mins[1], mins[2]);
  const mins2 = vec3(mins[0], mins[1], mins[2]);
  const maxs1 = vec3(maxs[0], maxs[1], maxs[2]);
  const maxs2 = vec3(maxs[0], maxs[1], maxs[2]);

  maxs1[anode.axis] = anode.dist;
  mins2[anode.axis] = anode.dist;

  anode.children[0] = SV_CreateAreaNode(depth + 1, mins2, maxs2);
  anode.children[1] = SV_CreateAreaNode(depth + 1, mins1, maxs1);

  return anode;
}

/*
===============
SV_ClearWorld

===============
*/
// called after the world model has been loaded, before linking any entities
export function SV_ClearWorld(): void {
  // memset (sv_areanodes, 0, sizeof(sv_areanodes));
  for (const node of sv_areanodes) {
    node.axis = 0;
    node.dist = 0;
    node.children = [null, null];
    node.trigger_edicts.prev = null;
    node.trigger_edicts.next = null;
    node.solid_edicts.prev = null;
    node.solid_edicts.next = null;
  }
  sv_numareanodes = 0;

  const worldModel = sv.models[1];
  if (!worldModel) {
    Com_Error(ERR_FATAL, "SV_ClearWorld: no world model");
  }
  SV_CreateAreaNode(0, worldModel.mins, worldModel.maxs);
}

/*
===============
SV_UnlinkEdict

===============
*/
// call before removing an entity, and before trying to move one,
// so it doesn't clip against itself
export function SV_UnlinkEdict(ent: Edict): void {
  if (!ent.area.prev) return; // not linked in anywhere
  RemoveLink(ent.area);
  ent.area.prev = null;
  ent.area.next = null;
}

/*
===============
SV_LinkEdict

===============
*/
const MAX_TOTAL_ENT_LEAFS = 128;

// Needs to be called any time an entity changes origin, mins, maxs,
// or solid. Automatically unlinks if needed.
// sets ent.absmin and ent.absmax
// sets ent.clusternums[] for pvs determination even if the entity
// is not solid
export function SV_LinkEdict(ent: Edict): void {
  if (ent.area.prev) SV_UnlinkEdict(ent); // unlink from old position

  const ge = geHolder.ge;
  if (ge && ent === ge.edicts[0]) return; // don't add the world

  if (!ent.inuse) return;

  // set the size
  VectorSubtract(ent.maxs, ent.mins, ent.size);

  // encode the size into the entity_state for client prediction
  if (ent.solid === SolidT.SOLID_BBOX && !(ent.svflags & SVF_DEADMONSTER)) {
    // assume that x/y are equal and symetric
    let i = (ent.maxs[0] / 8) | 0;
    if (i < 1) i = 1;
    if (i > 31) i = 31;

    // z is not symetric
    let j = (-ent.mins[2] / 8) | 0;
    if (j < 1) j = 1;
    if (j > 31) j = 31;

    // and z maxs can be negative...
    let k = ((ent.maxs[2] + 32) / 8) | 0;
    if (k < 1) k = 1;
    if (k > 63) k = 63;

    ent.s.solid = (k << 10) | (j << 5) | i;
  } else if (ent.solid === SolidT.SOLID_BSP) {
    ent.s.solid = 31; // a solid_bbox will never create this value
  } else {
    ent.s.solid = 0;
  }

  // set the abs box
  if (ent.solid === SolidT.SOLID_BSP && (ent.s.angles[0] || ent.s.angles[1] || ent.s.angles[2])) {
    // expand for rotation
    let max = 0;
    for (let i = 0; i < 3; i++) {
      let v = Math.abs(ent.mins[i]);
      if (v > max) max = v;
      v = Math.abs(ent.maxs[i]);
      if (v > max) max = v;
    }
    for (let i = 0; i < 3; i++) {
      ent.absmin[i] = ent.s.origin[i] - max;
      ent.absmax[i] = ent.s.origin[i] + max;
    }
  } else {
    // normal
    VectorAdd(ent.s.origin, ent.mins, ent.absmin);
    VectorAdd(ent.s.origin, ent.maxs, ent.absmax);
  }

  // because movement is clipped an epsilon away from an actual edge,
  // we must fully check even when bounding boxes don't quite touch
  ent.absmin[0] -= 1;
  ent.absmin[1] -= 1;
  ent.absmin[2] -= 1;
  ent.absmax[0] += 1;
  ent.absmax[1] += 1;
  ent.absmax[2] += 1;

  // link to PVS leafs
  ent.num_clusters = 0;
  ent.areanum = 0;
  ent.areanum2 = 0;

  // get all leafs, including solids
  const leafs: number[] = new Array(MAX_TOTAL_ENT_LEAFS).fill(0);
  const { count: num_leafs, topnode } = CM_BoxLeafnums(ent.absmin, ent.absmax, leafs, MAX_TOTAL_ENT_LEAFS);

  // set areas
  const clusters: number[] = new Array(MAX_TOTAL_ENT_LEAFS).fill(0);
  for (let i = 0; i < num_leafs; i++) {
    clusters[i] = CM_LeafCluster(leafs[i]);
    const area = CM_LeafArea(leafs[i]);
    if (area) {
      // doors may legally straggle two areas,
      // but nothing should evern need more than that
      if (ent.areanum && ent.areanum !== area) {
        if (ent.areanum2 && ent.areanum2 !== area && sv.state === ServerStateT.ss_loading) {
          Com_DPrintf("Object touching 3 areas at %f %f %f\n", ent.absmin[0], ent.absmin[1], ent.absmin[2]);
        }
        ent.areanum2 = area;
      } else {
        ent.areanum = area;
      }
    }
  }

  if (num_leafs >= MAX_TOTAL_ENT_LEAFS) {
    // assume we missed some leafs, and mark by headnode
    ent.num_clusters = -1;
    ent.headnode = topnode;
  } else {
    ent.num_clusters = 0;
    for (let i = 0; i < num_leafs; i++) {
      if (clusters[i] === -1) continue; // not a visible leaf

      let j = 0;
      for (j = 0; j < i; j++) {
        if (clusters[j] === clusters[i]) break;
      }
      if (j === i) {
        if (ent.num_clusters === MAX_ENT_CLUSTERS) {
          // assume we missed some leafs, and mark by headnode
          ent.num_clusters = -1;
          ent.headnode = topnode;
          break;
        }
        ent.clusternums[ent.num_clusters++] = clusters[i];
      }
    }
  }

  // if first time, make sure old_origin is valid
  if (!ent.linkcount) {
    VectorCopy(ent.s.origin, ent.s.old_origin);
  }
  ent.linkcount++;

  // record this frame's origin into the framediv interpolation ring
  // (q2repro world.c's PF_LinkEdict, USE_FPS block, ~world.c:330-335).
  // ent.s.number is this port's NUM_FOR_EDICT(ent) substitute (server.ts's
  // EDICT_NUM/NUM_FOR_EDICT comment; same convention as sv_send.ts/
  // sv_game.ts). Always recorded -- cheap, and unconditional in upstream
  // too -- but nothing reads the ring yet; see server.ts's ServerEntityT
  // comment for what's still missing before framediv > 1 can use it.
  const sent = sv.entities[ent.s.number];
  const historySlot = sv.framenum & ENT_HISTORY_MASK;
  VectorCopy(ent.s.origin, sent.history[historySlot].origin);
  sent.history[historySlot].framenum = sv.framenum;

  if (ent.solid === SolidT.SOLID_NOT) return;

  // find the first node that the ent's box crosses
  let node: AreaNodeT = sv_areanodes[0];
  for (;;) {
    if (node.axis === -1) break;

    let nextNode: AreaNodeT | null;
    if (ent.absmin[node.axis] > node.dist) {
      nextNode = node.children[0];
    } else if (ent.absmax[node.axis] < node.dist) {
      nextNode = node.children[1];
    } else {
      break; // crosses the node
    }
    if (!nextNode) {
      throw new Error("SV_LinkEdict: area node tree missing child");
    }
    node = nextNode;
  }

  // link it in
  areaEdictMap.set(ent.area, ent);
  if (ent.solid === SolidT.SOLID_TRIGGER) {
    InsertLinkBefore(ent.area, node.trigger_edicts);
  } else {
    InsertLinkBefore(ent.area, node.solid_edicts);
  }
}

/*
====================
SV_AreaEdicts_r

====================
*/
function SV_AreaEdicts_r(node: AreaNodeT): void {
  // touch linked edicts
  const start = area_type === AREA_SOLID ? node.solid_edicts : node.trigger_edicts;

  for (let l = start.next; l !== null && l !== start; ) {
    const next: LinkT | null = l.next;
    const check = EDICT_FROM_AREA(l);

    if (check.solid === SolidT.SOLID_NOT) {
      l = next;
      continue; // deactivated
    }
    if (
      check.absmin[0] > area_maxs[0] ||
      check.absmin[1] > area_maxs[1] ||
      check.absmin[2] > area_maxs[2] ||
      check.absmax[0] < area_mins[0] ||
      check.absmax[1] < area_mins[1] ||
      check.absmax[2] < area_mins[2]
    ) {
      l = next;
      continue; // not touching
    }

    if (area_count === area_maxcount) {
      Com_Printf("SV_AreaEdicts: MAXCOUNT\n");
      return;
    }

    area_list[area_count] = check;
    area_count++;
    l = next;
  }

  if (node.axis === -1) return; // terminal node

  // recurse down both sides
  if (area_maxs[node.axis] > node.dist) {
    const c0 = node.children[0];
    if (c0) SV_AreaEdicts_r(c0);
  }
  if (area_mins[node.axis] < node.dist) {
    const c1 = node.children[1];
    if (c1) SV_AreaEdicts_r(c1);
  }
}

/*
================
SV_AreaEdicts
================
*/
// fills in a table of edict pointers with edicts that have bounding boxes
// that intersect the given area. It is possible for a non-axial bmodel
// to be returned that doesn't actually intersect the area on an exact test.
// returns the number of pointers filled in
export function SV_AreaEdicts(mins: Vec3, maxs: Vec3, list: Edict[], maxcount: number, areatype: number): number {
  area_mins = mins;
  area_maxs = maxs;
  area_list = list;
  area_count = 0;
  area_maxcount = maxcount;
  area_type = areatype;

  SV_AreaEdicts_r(sv_areanodes[0]);

  return area_count;
}

//===========================================================================

/*
=============
SV_PointContents
=============
*/
// returns the CONTENTS_* value from the world at the given point.
// Quake 2 extends this to also check entities, to allow moving liquids
export function SV_PointContents(p: Vec3): number {
  const worldModel = sv.models[1];
  if (!worldModel) {
    Com_Error(ERR_FATAL, "SV_PointContents: no world model");
  }

  // get base contents from world
  let contents = CM_PointContents(p, worldModel.headnode);

  // or in contents from all the other entities
  const touch: Edict[] = new Array(MAX_EDICTS);
  const num = SV_AreaEdicts(p, p, touch, MAX_EDICTS, AREA_SOLID);

  for (let i = 0; i < num; i++) {
    const hit = touch[i];

    // might intersect, so do an exact clip
    const headnode = SV_HullForEntity(hit);
    // NOTE: the original C computes `angles` (zeroed for non-SOLID_BSP
    // entities, "boxes don't rotate") but then passes `hit->s.angles`
    // unconditionally to CM_TransformedPointContents -- a latent bug in
    // sv_world.c preserved here bug-for-bug per the porting brief.
    const c2 = CM_TransformedPointContents(p, headnode, hit.s.origin, hit.s.angles);

    contents |= c2;
  }

  return contents;
}

interface MoveClipT {
  boxmins: Vec3;
  boxmaxs: Vec3; // enclose the test object along entire move
  mins: Vec3;
  maxs: Vec3; // size of the moving object
  mins2: Vec3;
  maxs2: Vec3; // size when clipping against mosnters
  start: Vec3;
  end: Vec3;
  trace: TraceT;
  traceEnt: Edict | null; // C stores this as trace.ent; kept alongside TraceT
  // here since TraceT.ent is `unknown` (see PORTING.md's trace_t.ent ruling)
  passedict: Edict | null;
  contentmask: number;
}

function newMoveClip(): MoveClipT {
  return {
    boxmins: vec3(),
    boxmaxs: vec3(),
    mins: vec3_origin,
    maxs: vec3_origin,
    mins2: vec3(),
    maxs2: vec3(),
    start: vec3_origin,
    end: vec3_origin,
    trace: new TraceT(),
    traceEnt: null,
    passedict: null,
    contentmask: 0,
  };
}

/*
================
SV_HullForEntity

Returns a headnode that can be used for testing or clipping an
object of mins/maxs size.
Offset is filled in to contain the adjustment that must be added to the
testing object's origin to get a point to use with the returned hull.

`triggers`: when true, a SOLID_TRIGGER entity's own BSP model (not just its
mins/maxs bbox) is used, matching q2repro's SV_HullForEntity(ent, triggers)
-- q2repro's own comment: SV_Clip "can be used to clip to SOLID_TRIGGER by
its BSP tree". SV_Trace/SV_ClipMoveToEntities's sweep against the whole
entity list always passes false here (a trigger volume is treated as its
axial bbox during a multi-entity sweep, same as this port's pre-existing
behavior); SV_Clip's single-entity clip passes true, since gi.clip is used
throughout g_trigger.ts/g_utils.ts specifically to test whether another
entity's box is inside a (possibly non-axial) trigger brush.
================
*/
function SV_HullForEntity(ent: Edict, triggers = false): number {
  // decide which clipping hull to use, based on the size
  if (ent.solid === SolidT.SOLID_BSP || (triggers && ent.solid === SolidT.SOLID_TRIGGER)) {
    // explicit hulls in the BSP model
    const model = sv.models[ent.s.modelindex];
    if (!model) {
      Com_Error(ERR_FATAL, "MOVETYPE_PUSH with a non bsp model");
    }
    return model.headnode;
  }

  // create a temp hull from bounding box sizes
  return CM_HeadnodeForBox(ent.mins, ent.maxs);
}

/*
====================
SV_ClipToEntity

Exact clip of a single mins/maxs box move against one entity's hull.
Factored out of SV_ClipMoveToEntities's per-entity loop body so SV_Clip
(below) can reuse the exact same headnode-lookup + angle-zeroing +
CM_TransformedBoxTrace call, instead of duplicating it -- SV_Clip and
SV_ClipMoveToEntities's inner loop were two copies of this same four-line
sequence before this refactor (flagged per this unit's brief).
====================
*/
function SV_ClipToEntity(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, touch: Edict, contentmask: number, triggers: boolean): TraceT {
  const headnode = SV_HullForEntity(touch, triggers);
  const angles = touch.solid !== SolidT.SOLID_BSP ? vec3_origin : touch.s.angles; // boxes don't rotate
  return CM_TransformedBoxTrace(start, end, mins, maxs, headnode, contentmask, touch.s.origin, angles);
}

//===========================================================================

/*
====================
SV_ClipMoveToEntities

====================
*/
function SV_ClipMoveToEntities(clip: MoveClipT): void {
  const touchlist: Edict[] = new Array(MAX_EDICTS);
  const num = SV_AreaEdicts(clip.boxmins, clip.boxmaxs, touchlist, MAX_EDICTS, AREA_SOLID);

  // be careful, it is possible to have an entity in this
  // list removed before we get to it (killtriggered)
  for (let i = 0; i < num; i++) {
    const touch = touchlist[i];
    if (touch.solid === SolidT.SOLID_NOT) continue;
    if (touch === clip.passedict) continue;
    if (clip.trace.allsolid) return;
    if (clip.passedict) {
      if (touch.owner === clip.passedict) continue; // don't clip against own missiles
      if (clip.passedict.owner === touch) continue; // don't clip against owner
    }

    if (!(clip.contentmask & CONTENTS_DEADMONSTER) && touch.svflags & SVF_DEADMONSTER) continue;

    // might intersect, so do an exact clip. `triggers=false`: a multi-entity
    // sweep treats a SOLID_TRIGGER entity as its axial bbox, not its BSP
    // model -- see SV_HullForEntity's header comment.
    const trace =
      touch.svflags & SVF_MONSTER
        ? SV_ClipToEntity(clip.start, clip.mins2, clip.maxs2, clip.end, touch, clip.contentmask, false)
        : SV_ClipToEntity(clip.start, clip.mins, clip.maxs, clip.end, touch, clip.contentmask, false);

    if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
      if (clip.trace.startsolid) {
        clip.trace = trace;
        clip.trace.startsolid = true;
      } else {
        clip.trace = trace;
      }
      clip.traceEnt = touch;
    } else if (trace.startsolid) {
      clip.trace.startsolid = true;
    }
  }
}

/*
==================
SV_TraceBounds
==================
*/
function SV_TraceBounds(start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3, boxmins: Vec3, boxmaxs: Vec3): void {
  for (let i = 0; i < 3; i++) {
    if (end[i] > start[i]) {
      boxmins[i] = start[i] + mins[i] - 1;
      boxmaxs[i] = end[i] + maxs[i] + 1;
    } else {
      boxmins[i] = end[i] + mins[i] - 1;
      boxmaxs[i] = start[i] + maxs[i] + 1;
    }
  }
}

// trace results whose ent ends up null (untouched, or ge not yet loaded)
// default to the world edict via ge.edicts[0], per the U020 convention.
function worldEdict(): Edict | null {
  const ge = geHolder.ge;
  return ge ? ge.edicts[0] : null;
}

function toGTrace(t: TraceT, ent: Edict | null): GTraceT {
  return {
    allsolid: t.allsolid,
    startsolid: t.startsolid,
    fraction: t.fraction,
    endpos: t.endpos,
    plane: t.plane,
    surface: t.surface,
    contents: t.contents,
    ent,
  };
}

/*
==================
SV_Trace

Moves the given mins/maxs volume through the world from start to end.

Passedict and edicts owned by passedict are explicitly not checked.

==================
*/
// mins and maxs are relative. passedict is explicitly excluded from
// clipping checks (normally null)
export function SV_Trace(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, passedict: Edict | null, contentmask: number): GTraceT {
  const realMins = mins ?? vec3_origin;
  const realMaxs = maxs ?? vec3_origin;

  const clip = newMoveClip();

  // clip to world
  clip.trace = CM_BoxTrace(start, end, realMins, realMaxs, 0, contentmask);
  clip.traceEnt = worldEdict();
  if (clip.trace.fraction === 0) {
    return toGTrace(clip.trace, clip.traceEnt); // blocked by the world
  }

  clip.contentmask = contentmask;
  clip.start = start;
  clip.end = end;
  clip.mins = realMins;
  clip.maxs = realMaxs;
  clip.passedict = passedict;

  VectorCopy(realMins, clip.mins2);
  VectorCopy(realMaxs, clip.maxs2);

  // create the bounding box of the entire move
  SV_TraceBounds(start, clip.mins2, clip.maxs2, end, clip.boxmins, clip.boxmaxs);

  // clip to other solid entities
  SV_ClipMoveToEntities(clip);

  return toGTrace(clip.trace, clip.traceEnt);
}

/*
==================
SV_Clip

Like SV_Trace(), but clip to ONE specified entity only -- no world sweep,
no other entities considered. Can be used to clip to SOLID_TRIGGER by its
BSP tree (q2repro's world.c:622-648 SV_Clip docstring, reproduced above;
this is the kex/[Paril-KEX] `gi.clip` entry point -- the legacy game import
table has no equivalent, see kex.ts's binding header).

`clipEntity === ` the world edict is special-cased to a straight world BSP
trace, matching q2repro's `if (clip == ge->edicts) CM_BoxTrace(...)`.
==================
*/
export function SV_Clip(start: Vec3, mins: Vec3 | null, maxs: Vec3 | null, end: Vec3, clipEntity: Edict, contentmask: number): GTraceT {
  const realMins = mins ?? vec3_origin;
  const realMaxs = maxs ?? vec3_origin;

  const worldEnt = worldEdict();
  const trace =
    worldEnt && clipEntity === worldEnt
      ? CM_BoxTrace(start, end, realMins, realMaxs, 0, contentmask)
      : SV_ClipToEntity(start, realMins, realMaxs, end, clipEntity, contentmask, true);

  return toGTrace(trace, clipEntity);
}
