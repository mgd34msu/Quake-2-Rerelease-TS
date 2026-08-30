/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from qcommon/cmodel.c (GNU GPL v2 or later).

cmodel.c -- model loading
*/

import { type Vec3, vec3, DotProduct, VectorSubtract, VectorAdd, VectorCopy, VectorClear, VectorNegate, AngleVectors, BOX_ON_PLANE_SIDE } from "../shared/math";
import { CplaneT, CmodelT, MapsurfaceT, TraceT, CONTENTS_SOLID, CONTENTS_MONSTER, LittleLong, LittleFloat, LittleShort, type CvarT } from "../shared/q_shared";
import { Com_Error, Com_DPrintf } from "./common";
import { ERR_DROP } from "./qcommon";
import { Cvar_Get, Cvar_VariableValue } from "./cvar";
import { FS_LoadFile } from "./files";
import { Com_BlockChecksum } from "./md4";
import {
  type LumpT,
  type DareaportalT,
  MAX_MAP_MODELS,
  MAX_MAP_BRUSHES,
  MAX_MAP_TEXINFO,
  MAX_MAP_AREAS,
  MAX_MAP_AREAPORTALS,
  MAX_MAP_PORTAL_BYTES,
  MAX_MAP_PLANES,
  MAX_MAP_NODES,
  MAX_MAP_BRUSHSIDES,
  MAX_MAP_LEAFS,
  MAX_MAP_LEAFBRUSHES,
  MAX_MAP_ENTSTRING,
  MAX_MAP_VISIBILITY,
  LUMP_ENTITIES,
  LUMP_PLANES,
  LUMP_VISIBILITY,
  LUMP_NODES,
  LUMP_TEXINFO,
  LUMP_LEAFS,
  LUMP_LEAFBRUSHES,
  LUMP_MODELS,
  LUMP_BRUSHES,
  LUMP_BRUSHSIDES,
  LUMP_AREAS,
  LUMP_AREAPORTALS,
  BSPVERSION,
  DVIS_PVS,
  DVIS_PHS,
  DMODEL_T_SIZE,
  DPLANE_T_SIZE,
  DNODE_T_SIZE,
  TEXINFO_T_SIZE,
  DLEAF_T_SIZE,
  DBRUSHSIDE_T_SIZE,
  DBRUSH_T_SIZE,
  DAREA_T_SIZE,
  DAREAPORTAL_T_SIZE,
  readDheader,
  readDmodel,
  readDplane,
  readDnode,
  readTexinfo,
  readDleaf,
  readDbrushside,
  readDbrush,
  readDarea,
  readDareaportal,
  readUint16,
  dvisBitofs,
} from "./qfiles";

// cnode_t
class CnodeT {
  plane: CplaneT = new CplaneT();
  children: [number, number] = [0, 0]; // negative numbers are leafs
}

// cbrushside_t
class CbrushsideT {
  plane: CplaneT = new CplaneT();
  surface: MapsurfaceT = new MapsurfaceT();
}

// cleaf_t
class CleafT {
  contents = 0;
  cluster = 0;
  area = 0;
  firstleafbrush = 0;
  numleafbrushes = 0;
}

// cbrush_t
class CbrushT {
  contents = 0;
  numsides = 0;
  firstbrushside = 0;
  checkcount = 0; // to avoid repeated testings
}

// carea_t
class CareaT {
  numareaportals = 0;
  firstareaportal = 0;
  floodnum = 0; // if two areas have equal floodnums, they are connected
  floodvalid = 0;
}

let checkcount = 0;

let map_name = "";

// Fixed-size C arrays (`cbrushside_t map_brushsides[MAX_MAP_BRUSHSIDES]` etc.)
// become growable JS arrays here rather than preallocated MAX_MAP_*-sized
// object arrays: each CMod_Load* function rebuilds its array from scratch on
// every CM_LoadMap call (matching the *contents* the C static buffer would
// hold after that load), and CM_InitBoxHull appends its extra box-hull
// entries onto the end the same way C writes them into the spare tail
// capacity of the fixed buffer. The MAX_MAP_* bounds checks are preserved
// verbatim as Com_Error guards even though a JS array cannot actually
// overflow, so a map that would have overflowed the original engine still
// reports the same error here.
let numbrushsides = 0;
let map_brushsides: CbrushsideT[] = [];

let numtexinfo = 0;
let map_surfaces: MapsurfaceT[] = [];

let numplanes = 0;
let map_planes: CplaneT[] = [];

let numnodes = 0;
let map_nodes: CnodeT[] = [];

let numleafs = 1; // allow leaf funcs to be called without a map
let map_leafs: CleafT[] = [new CleafT()];
let emptyleaf = 0;
let solidleaf = 0;

let numleafbrushes = 0;
let map_leafbrushes: number[] = [];

let numcmodels = 0;
let map_cmodels: CmodelT[] = [new CmodelT()];

let numbrushes = 0;
let map_brushes: CbrushT[] = [];

let numvisibility = 0;
const map_visibility = new Uint8Array(MAX_MAP_VISIBILITY);
const map_vis_view = new DataView(map_visibility.buffer, map_visibility.byteOffset, map_visibility.byteLength);

let numentitychars = 0;
let map_entitystring = "";

let numareas = 1;
let map_areas: CareaT[] = [new CareaT()];

let numareaportals = 0;
let map_areaportals: DareaportalT[] = [];

let numclusters = 1;

const nullsurface = new MapsurfaceT();

let floodvalid = 0;

const portalopen: boolean[] = new Array(MAX_MAP_AREAPORTALS).fill(false);

let map_noareas: CvarT | null = null;

export let c_pointcontents = 0;
export let c_traces = 0;
export let c_brush_traces = 0;

// common.c's Qcommon_Frame zeroes these three directly through `extern int`
// declarations; `export let` bindings are read-only outside their module, so
// src/main.ts clears them through this setter instead.
export function resetTraceCounters(): void {
  c_pointcontents = 0;
  c_traces = 0;
  c_brush_traces = 0;
}

// atoi()'s lenient parse (leading digits only, 0 if none) -- see cvar.ts's
// `atof` for the same pattern applied to floats.
function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function copyPlane(dst: CplaneT, src: CplaneT): void {
  dst.normal[0] = src.normal[0];
  dst.normal[1] = src.normal[1];
  dst.normal[2] = src.normal[2];
  dst.dist = src.dist;
  dst.type = src.type;
  dst.signbits = src.signbits;
}

/*
===============================================================================

					MAP LOADING

===============================================================================
*/

// byte *cmod_base -- the raw loaded file, as a DataView for struct reads.
// Initialized to an empty view so CMod_Load* never need a null check (the C
// global is an uninitialized-but-always-set-before-use pointer).
let cmod_view: DataView = new DataView(new ArrayBuffer(0));

/*
=================
CMod_LoadSubmodels
=================
*/
function CMod_LoadSubmodels(l: LumpT): void {
  if (l.filelen % DMODEL_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DMODEL_T_SIZE;

  if (count < 1) Com_Error(ERR_DROP, "Map with no models");
  if (count > MAX_MAP_MODELS) Com_Error(ERR_DROP, "Map has too many models");

  numcmodels = count;
  map_cmodels = [];

  for (let i = 0; i < count; i++) {
    const din = readDmodel(cmod_view, l.fileofs + i * DMODEL_T_SIZE);
    const out = new CmodelT();

    for (let j = 0; j < 3; j++) {
      // spread the mins / maxs by a pixel
      out.mins[j] = LittleFloat(din.mins[j]) - 1;
      out.maxs[j] = LittleFloat(din.maxs[j]) + 1;
      out.origin[j] = LittleFloat(din.origin[j]);
    }
    out.headnode = LittleLong(din.headnode);
    map_cmodels.push(out);
  }
}

/*
=================
CMod_LoadSurfaces
=================
*/
function CMod_LoadSurfaces(l: LumpT): void {
  if (l.filelen % TEXINFO_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / TEXINFO_T_SIZE;
  if (count < 1) Com_Error(ERR_DROP, "Map with no surfaces");
  if (count > MAX_MAP_TEXINFO) Com_Error(ERR_DROP, "Map has too many surfaces");

  numtexinfo = count;
  map_surfaces = [];

  for (let i = 0; i < count; i++) {
    const din = readTexinfo(cmod_view, l.fileofs + i * TEXINFO_T_SIZE);
    const out = new MapsurfaceT();
    out.c.name = din.texture.slice(0, 15);
    out.rname = din.texture.slice(0, 31);
    out.c.flags = LittleLong(din.flags);
    out.c.value = LittleLong(din.value);
    map_surfaces.push(out);
  }
}

/*
=================
CMod_LoadNodes

=================
*/
function CMod_LoadNodes(l: LumpT): void {
  if (l.filelen % DNODE_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DNODE_T_SIZE;

  if (count < 1) Com_Error(ERR_DROP, "Map has no nodes");
  if (count > MAX_MAP_NODES) Com_Error(ERR_DROP, "Map has too many nodes");

  numnodes = count;
  map_nodes = [];

  for (let i = 0; i < count; i++) {
    const din = readDnode(cmod_view, l.fileofs + i * DNODE_T_SIZE);
    const out = new CnodeT();
    out.plane = map_planes[LittleLong(din.planenum)];
    for (let j = 0; j < 2; j++) {
      out.children[j] = LittleLong(din.children[j]);
    }
    map_nodes.push(out);
  }
}

/*
=================
CMod_LoadBrushes

=================
*/
function CMod_LoadBrushes(l: LumpT): void {
  if (l.filelen % DBRUSH_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DBRUSH_T_SIZE;

  if (count > MAX_MAP_BRUSHES) Com_Error(ERR_DROP, "Map has too many brushes");

  numbrushes = count;
  map_brushes = [];

  for (let i = 0; i < count; i++) {
    const din = readDbrush(cmod_view, l.fileofs + i * DBRUSH_T_SIZE);
    const out = new CbrushT();
    out.firstbrushside = LittleLong(din.firstside);
    out.numsides = LittleLong(din.numsides);
    out.contents = LittleLong(din.contents);
    map_brushes.push(out);
  }
}

/*
=================
CMod_LoadLeafs
=================
*/
function CMod_LoadLeafs(l: LumpT): void {
  if (l.filelen % DLEAF_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DLEAF_T_SIZE;

  if (count < 1) Com_Error(ERR_DROP, "Map with no leafs");
  // need to save space for box planes
  if (count > MAX_MAP_PLANES) Com_Error(ERR_DROP, "Map has too many planes");

  numleafs = count;
  numclusters = 0;
  map_leafs = [];

  for (let i = 0; i < count; i++) {
    const din = readDleaf(cmod_view, l.fileofs + i * DLEAF_T_SIZE);
    const out = new CleafT();
    out.contents = LittleLong(din.contents);
    out.cluster = LittleShort(din.cluster);
    out.area = LittleShort(din.area);
    out.firstleafbrush = LittleShort(din.firstleafbrush);
    out.numleafbrushes = LittleShort(din.numleafbrushes);

    if (out.cluster >= numclusters) numclusters = out.cluster + 1;
    map_leafs.push(out);
  }

  if (map_leafs[0].contents !== CONTENTS_SOLID) Com_Error(ERR_DROP, "Map leaf 0 is not CONTENTS_SOLID");
  solidleaf = 0;
  emptyleaf = -1;
  for (let i = 1; i < numleafs; i++) {
    if (!map_leafs[i].contents) {
      emptyleaf = i;
      break;
    }
  }
  if (emptyleaf === -1) Com_Error(ERR_DROP, "Map does not have an empty leaf");
}

/*
=================
CMod_LoadPlanes
=================
*/
function CMod_LoadPlanes(l: LumpT): void {
  if (l.filelen % DPLANE_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DPLANE_T_SIZE;

  if (count < 1) Com_Error(ERR_DROP, "Map with no planes");
  // need to save space for box planes
  if (count > MAX_MAP_PLANES) Com_Error(ERR_DROP, "Map has too many planes");

  numplanes = count;
  map_planes = [];

  for (let i = 0; i < count; i++) {
    const din = readDplane(cmod_view, l.fileofs + i * DPLANE_T_SIZE);
    const out = new CplaneT();
    let bits = 0;
    for (let j = 0; j < 3; j++) {
      out.normal[j] = LittleFloat(din.normal[j]);
      if (out.normal[j] < 0) bits |= 1 << j;
    }
    out.dist = LittleFloat(din.dist);
    out.type = LittleLong(din.type);
    out.signbits = bits;
    map_planes.push(out);
  }
}

/*
=================
CMod_LoadLeafBrushes
=================
*/
function CMod_LoadLeafBrushes(l: LumpT): void {
  if (l.filelen % 2) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / 2;

  if (count < 1) Com_Error(ERR_DROP, "Map with no planes");
  // need to save space for box planes
  if (count > MAX_MAP_LEAFBRUSHES) Com_Error(ERR_DROP, "Map has too many leafbrushes");

  numleafbrushes = count;
  map_leafbrushes = [];

  for (let i = 0; i < count; i++) {
    map_leafbrushes.push(LittleShort(readUint16(cmod_view, l.fileofs + i * 2)));
  }
}

/*
=================
CMod_LoadBrushSides
=================
*/
function CMod_LoadBrushSides(l: LumpT): void {
  if (l.filelen % DBRUSHSIDE_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DBRUSHSIDE_T_SIZE;

  // need to save space for box planes
  if (count > MAX_MAP_BRUSHSIDES) Com_Error(ERR_DROP, "Map has too many planes");

  numbrushsides = count;
  map_brushsides = [];

  for (let i = 0; i < count; i++) {
    const din = readDbrushside(cmod_view, l.fileofs + i * DBRUSHSIDE_T_SIZE);
    const out = new CbrushsideT();
    const num = LittleShort(din.planenum);
    out.plane = map_planes[num];
    const j = LittleShort(din.texinfo);
    if (j >= numtexinfo) Com_Error(ERR_DROP, "Bad brushside texinfo");
    // C stores &map_surfaces[j] even when j is -1 (bevel sides carry no
    // texinfo) -- an out-of-bounds pointer whose garbage csurface is later
    // read at trace time without crashing. The defined equivalent is the
    // zeroed nullsurface the C file already uses for missing texinfo.
    out.surface = j >= 0 ? map_surfaces[j] : nullsurface;
    map_brushsides.push(out);
  }
}

/*
=================
CMod_LoadAreas
=================
*/
function CMod_LoadAreas(l: LumpT): void {
  if (l.filelen % DAREA_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DAREA_T_SIZE;

  if (count > MAX_MAP_AREAS) Com_Error(ERR_DROP, "Map has too many areas");

  numareas = count;
  map_areas = [];

  for (let i = 0; i < count; i++) {
    const din = readDarea(cmod_view, l.fileofs + i * DAREA_T_SIZE);
    const out = new CareaT();
    out.numareaportals = LittleLong(din.numareaportals);
    out.firstareaportal = LittleLong(din.firstareaportal);
    out.floodvalid = 0;
    out.floodnum = 0;
    map_areas.push(out);
  }
}

/*
=================
CMod_LoadAreaPortals
=================
*/
function CMod_LoadAreaPortals(l: LumpT): void {
  if (l.filelen % DAREAPORTAL_T_SIZE) Com_Error(ERR_DROP, "MOD_LoadBmodel: funny lump size");
  const count = l.filelen / DAREAPORTAL_T_SIZE;

  // bug-for-bug with the original: bounded against MAX_MAP_AREAS, not
  // MAX_MAP_AREAPORTALS
  if (count > MAX_MAP_AREAS) Com_Error(ERR_DROP, "Map has too many areas");

  numareaportals = count;
  map_areaportals = [];

  for (let i = 0; i < count; i++) {
    const din = readDareaportal(cmod_view, l.fileofs + i * DAREAPORTAL_T_SIZE);
    map_areaportals.push({
      portalnum: LittleLong(din.portalnum),
      otherarea: LittleLong(din.otherarea),
    });
  }
}

/*
=================
CMod_LoadVisibility
=================
*/
function CMod_LoadVisibility(l: LumpT): void {
  numvisibility = l.filelen;
  if (l.filelen > MAX_MAP_VISIBILITY) Com_Error(ERR_DROP, "Map has too large visibility lump");

  const src = new Uint8Array(cmod_view.buffer, cmod_view.byteOffset + l.fileofs, l.filelen);
  map_visibility.set(src, 0);

  // map_vis->numclusters = LittleLong(map_vis->numclusters), and the
  // following bitofs byteswap loop, are no-ops on this little-endian-only
  // port (see PORTING.md idiom map: "take the portable little-endian C
  // path") -- the bytes are already in the right order after the copy above.
}

/*
=================
CMod_LoadEntityString
=================
*/
function CMod_LoadEntityString(l: LumpT): void {
  numentitychars = l.filelen;
  if (l.filelen > MAX_MAP_ENTSTRING) Com_Error(ERR_DROP, "Map has too large entity lump");

  let s = "";
  for (let i = 0; i < l.filelen; i++) {
    s += String.fromCharCode(cmod_view.getUint8(l.fileofs + i));
  }
  const nul = s.indexOf("\0");
  map_entitystring = nul === -1 ? s : s.slice(0, nul);
}

/*
==================
CM_LoadMap

Loads in the map and all submodels

Adaptation: C returns the cmodel_t* and writes the checksum through an
`unsigned *checksum` out-parameter. JS has no primitive out-parameters, so
this returns `{ model, checksum }` instead.
==================
*/
let last_checksum = 0;

export function CM_LoadMap(name: string, clientload: boolean): { model: CmodelT; checksum: number } {
  map_noareas = Cvar_Get("map_noareas", "0", 0);

  if (map_name === name && (clientload || !Cvar_VariableValue("flushmap"))) {
    const checksum = last_checksum;
    if (!clientload) {
      portalopen.fill(false);
      FloodAreaConnections();
    }
    return { model: map_cmodels[0], checksum }; // still have the right version
  }

  // free old stuff
  numplanes = 0;
  numnodes = 0;
  numleafs = 0;
  numcmodels = 0;
  numvisibility = 0;
  numentitychars = 0;
  map_entitystring = "";
  map_name = "";

  if (!name || name.length === 0) {
    numleafs = 1;
    numclusters = 1;
    numareas = 1;
    return { model: map_cmodels[0], checksum: 0 }; // cinematic servers won't have anything at all
  }

  //
  // load the file
  //
  const buf = FS_LoadFile(name);
  if (!buf) {
    Com_Error(ERR_DROP, "Couldn't load %s", name);
  }
  const length = buf.length;

  last_checksum = LittleLong(Com_BlockChecksum(buf, length));
  const checksum = last_checksum;

  cmod_view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const header = readDheader(cmod_view, 0);
  // the C original byteswaps every int of the header in place here; a no-op
  // on this little-endian-only port (same rationale as CMod_LoadVisibility).

  if (header.version !== BSPVERSION) {
    Com_Error(ERR_DROP, "CMod_LoadBrushModel: %s has wrong version number (%i should be %i)", name, header.version, BSPVERSION);
  }

  // load into heap
  CMod_LoadSurfaces(header.lumps[LUMP_TEXINFO]);
  CMod_LoadLeafs(header.lumps[LUMP_LEAFS]);
  CMod_LoadLeafBrushes(header.lumps[LUMP_LEAFBRUSHES]);
  CMod_LoadPlanes(header.lumps[LUMP_PLANES]);
  CMod_LoadBrushes(header.lumps[LUMP_BRUSHES]);
  CMod_LoadBrushSides(header.lumps[LUMP_BRUSHSIDES]);
  CMod_LoadSubmodels(header.lumps[LUMP_MODELS]);
  CMod_LoadNodes(header.lumps[LUMP_NODES]);
  CMod_LoadAreas(header.lumps[LUMP_AREAS]);
  CMod_LoadAreaPortals(header.lumps[LUMP_AREAPORTALS]);
  CMod_LoadVisibility(header.lumps[LUMP_VISIBILITY]);
  CMod_LoadEntityString(header.lumps[LUMP_ENTITIES]);

  // FS_FreeFile(buf) -- no-op in this port; Uint8Array buffers are garbage
  // collected, not hand-freed (see files.ts).

  CM_InitBoxHull();

  portalopen.fill(false);
  FloodAreaConnections();

  map_name = name;

  return { model: map_cmodels[0], checksum };
}

/*
==================
CM_InlineModel
==================
*/
export function CM_InlineModel(name: string): CmodelT {
  if (!name || name[0] !== "*") Com_Error(ERR_DROP, "CM_InlineModel: bad name");
  const num = atoi(name.slice(1));
  if (num < 1 || num >= numcmodels) Com_Error(ERR_DROP, "CM_InlineModel: bad number");

  return map_cmodels[num];
}

export function CM_NumClusters(): number {
  return numclusters;
}

export function CM_NumInlineModels(): number {
  return numcmodels;
}

export function CM_EntityString(): string {
  return map_entitystring;
}

export function CM_LeafContents(leafnum: number): number {
  if (leafnum < 0 || leafnum >= numleafs) Com_Error(ERR_DROP, "CM_LeafContents: bad number");
  return map_leafs[leafnum].contents;
}

export function CM_LeafCluster(leafnum: number): number {
  if (leafnum < 0 || leafnum >= numleafs) Com_Error(ERR_DROP, "CM_LeafCluster: bad number");
  return map_leafs[leafnum].cluster;
}

export function CM_LeafArea(leafnum: number): number {
  if (leafnum < 0 || leafnum >= numleafs) Com_Error(ERR_DROP, "CM_LeafArea: bad number");
  return map_leafs[leafnum].area;
}

//=======================================================================

let box_planes: CplaneT[] = [];
let box_headnode = 0;
let box_brush: CbrushT = new CbrushT();
let box_leaf: CleafT = new CleafT();

/*
===================
CM_InitBoxHull

Set up the planes and nodes so that the six floats of a bounding box
can just be stored out and get a proper clipping hull structure.
===================
*/
export function CM_InitBoxHull(): void {
  box_headnode = numnodes;
  const planesStart = numplanes;

  if (numnodes + 6 > MAX_MAP_NODES || numbrushes + 1 > MAX_MAP_BRUSHES || numleafbrushes + 1 > MAX_MAP_LEAFBRUSHES || numbrushsides + 6 > MAX_MAP_BRUSHSIDES || numplanes + 12 > MAX_MAP_PLANES) {
    Com_Error(ERR_DROP, "Not enough room for box tree");
  }

  box_brush = new CbrushT();
  box_brush.numsides = 6;
  box_brush.firstbrushside = numbrushsides;
  box_brush.contents = CONTENTS_MONSTER;
  map_brushes[numbrushes] = box_brush;

  box_leaf = new CleafT();
  box_leaf.contents = CONTENTS_MONSTER;
  box_leaf.firstleafbrush = numleafbrushes;
  box_leaf.numleafbrushes = 1;
  map_leafs[numleafs] = box_leaf;

  map_leafbrushes[numleafbrushes] = numbrushes;

  const planes: CplaneT[] = [];
  for (let k = 0; k < 12; k++) planes.push(new CplaneT());
  for (let k = 0; k < 12; k++) map_planes[planesStart + k] = planes[k];
  box_planes = planes;

  for (let i = 0; i < 6; i++) {
    const side = i & 1;

    // brush sides
    const s = new CbrushsideT();
    s.plane = planes[i * 2 + side];
    s.surface = nullsurface;
    map_brushsides[numbrushsides + i] = s;

    // nodes
    const c = new CnodeT();
    c.plane = planes[i * 2];
    c.children[side] = -1 - emptyleaf;
    if (i !== 5) c.children[side ^ 1] = box_headnode + i + 1;
    else c.children[side ^ 1] = -1 - numleafs;
    map_nodes[box_headnode + i] = c;

    // planes
    const p = planes[i * 2];
    p.type = i >> 1;
    p.signbits = 0;
    VectorClear(p.normal);
    p.normal[i >> 1] = 1;

    const p2 = planes[i * 2 + 1];
    p2.type = 3 + (i >> 1);
    p2.signbits = 0;
    VectorClear(p2.normal);
    p2.normal[i >> 1] = -1;
  }
}

/*
Test-support seam, not part of cmodel.c's API surface.

CM_PointContents and CM_BoxTrace both guard on `if (!numnodes) return ...`
("map not loaded"). CM_InitBoxHull sets `box_headnode = numnodes` but never
increments `numnodes` itself -- in the real engine, the box hull is always
layered on top of an already-loaded real map (CMod_LoadNodes has already set
numnodes to the map's real node count by the time CM_InitBoxHull runs from
inside CM_LoadMap), so that guard is always already open by the time any code
uses a box-hull headnode. There is no BSP-free way in the original C to open
that guard, since CM_LoadMap's own map-free path (`!name`) returns before
ever calling CM_InitBoxHull. This export exists solely so this unit's tests
(which must run without a BSP file per brief) can simulate "a trivial map is
already loaded" -- it does not change CM_PointContents/CM_BoxTrace/
CM_InitBoxHull's logic in any way, it just sets the same module state a real
CMod_LoadNodes call would have set before CM_InitBoxHull runs.
*/
export function CM_MarkMapLoadedForTesting(): void {
  if (numnodes === 0) numnodes = 1;
}

/*
===================
CM_HeadnodeForBox

To keep everything totally uniform, bounding boxes are turned into small
BSP trees instead of being compared directly.
===================
*/
export function CM_HeadnodeForBox(mins: Vec3, maxs: Vec3): number {
  box_planes[0].dist = maxs[0];
  box_planes[1].dist = -maxs[0];
  box_planes[2].dist = mins[0];
  box_planes[3].dist = -mins[0];
  box_planes[4].dist = maxs[1];
  box_planes[5].dist = -maxs[1];
  box_planes[6].dist = mins[1];
  box_planes[7].dist = -mins[1];
  box_planes[8].dist = maxs[2];
  box_planes[9].dist = -maxs[2];
  box_planes[10].dist = mins[2];
  box_planes[11].dist = -mins[2];

  return box_headnode;
}

/*
==================
CM_PointLeafnum_r

==================
*/
export function CM_PointLeafnum_r(p: Vec3, num: number): number {
  let n = num;
  while (n >= 0) {
    const node = map_nodes[n];
    const plane = node.plane;

    let d: number;
    if (plane.type < 3) d = p[plane.type] - plane.dist;
    else d = DotProduct(plane.normal, p) - plane.dist;

    if (d < 0) n = node.children[1];
    else n = node.children[0];
  }

  c_pointcontents++; // optimize counter

  return -1 - n;
}

export function CM_PointLeafnum(p: Vec3): number {
  if (!numplanes) return 0; // sound may call this without map loaded
  return CM_PointLeafnum_r(p, 0);
}

/*
=============
CM_BoxLeafnums

Fills in a list of all the leafs touched
=============
*/
let leaf_count = 0;
let leaf_maxcount = 0;
let leaf_list: number[] = [];
let leaf_mins: Vec3 = vec3();
let leaf_maxs: Vec3 = vec3();
let leaf_topnode = -1;

function CM_BoxLeafnums_r(nodenum: number): void {
  let n = nodenum;
  for (;;) {
    if (n < 0) {
      if (leaf_count >= leaf_maxcount) {
        // Com_Printf ("CM_BoxLeafnums_r: overflow\n") -- dropped, commented
        // out in the original too
        return;
      }
      leaf_list[leaf_count++] = -1 - n;
      return;
    }

    const node = map_nodes[n];
    const plane = node.plane;
    const s = BOX_ON_PLANE_SIDE(leaf_mins, leaf_maxs, plane);
    if (s === 1) {
      n = node.children[0];
    } else if (s === 2) {
      n = node.children[1];
    } else {
      // go down both
      if (leaf_topnode === -1) leaf_topnode = n;
      CM_BoxLeafnums_r(node.children[0]);
      n = node.children[1];
    }
  }
}

// Adaptation: C's `int *topnode` is an optional out-parameter (nullable
// pointer, only written if non-NULL). Returned as part of the result object
// instead; callers that don't need it just ignore the field.
export function CM_BoxLeafnums_headnode(mins: Vec3, maxs: Vec3, list: number[], listsize: number, headnode: number): { count: number; topnode: number } {
  leaf_list = list;
  leaf_count = 0;
  leaf_maxcount = listsize;
  leaf_mins = mins;
  leaf_maxs = maxs;

  leaf_topnode = -1;

  CM_BoxLeafnums_r(headnode);

  return { count: leaf_count, topnode: leaf_topnode };
}

export function CM_BoxLeafnums(mins: Vec3, maxs: Vec3, list: number[], listsize: number): { count: number; topnode: number } {
  return CM_BoxLeafnums_headnode(mins, maxs, list, listsize, map_cmodels[0].headnode);
}

/*
==================
CM_PointContents

==================
*/
export function CM_PointContents(p: Vec3, headnode: number): number {
  if (!numnodes) return 0; // map not loaded

  const l = CM_PointLeafnum_r(p, headnode);

  return map_leafs[l].contents;
}

/*
==================
CM_TransformedPointContents

Handles offseting and rotation of the end points for moving and
rotating entities
==================
*/
export function CM_TransformedPointContents(p: Vec3, headnode: number, origin: Vec3, angles: Vec3): number {
  const p_l = vec3();

  // subtract origin offset
  VectorSubtract(p, origin, p_l);

  // rotate start and end into the models frame of reference
  if (headnode !== box_headnode && (angles[0] || angles[1] || angles[2])) {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(angles, forward, right, up);

    const temp = vec3();
    VectorCopy(p_l, temp);
    p_l[0] = DotProduct(temp, forward);
    p_l[1] = -DotProduct(temp, right);
    p_l[2] = DotProduct(temp, up);
  }

  const l = CM_PointLeafnum_r(p_l, headnode);

  return map_leafs[l].contents;
}

/*
===============================================================================

BOX TRACING

===============================================================================
*/

// 1/32 epsilon to keep floating point happy
const DIST_EPSILON = 0.03125;

const trace_start: Vec3 = vec3();
const trace_end: Vec3 = vec3();
const trace_mins: Vec3 = vec3();
const trace_maxs: Vec3 = vec3();
const trace_extents: Vec3 = vec3();

let trace_trace = new TraceT();
let trace_contents = 0;
let trace_ispoint = false; // optimized case

/*
================
CM_ClipBoxToBrush
================
*/
function CM_ClipBoxToBrush(mins: Vec3, maxs: Vec3, p1: Vec3, p2: Vec3, trace: TraceT, brush: CbrushT): void {
  let enterfrac = -1;
  let leavefrac = 1;
  let clipplane: CplaneT | null = null;

  if (!brush.numsides) return;

  c_brush_traces++;

  let getout = false;
  let startout = false;
  let leadside: CbrushsideT | null = null;

  const ofs = vec3();

  for (let i = 0; i < brush.numsides; i++) {
    const side = map_brushsides[brush.firstbrushside + i];
    const plane = side.plane;

    let dist: number;
    if (!trace_ispoint) {
      // general box case
      // push the plane out apropriately for mins/maxs
      for (let j = 0; j < 3; j++) {
        ofs[j] = plane.normal[j] < 0 ? maxs[j] : mins[j];
      }
      dist = DotProduct(ofs, plane.normal);
      dist = plane.dist - dist;
    } else {
      // special point case
      dist = plane.dist;
    }

    const d1 = DotProduct(p1, plane.normal) - dist;
    const d2 = DotProduct(p2, plane.normal) - dist;

    if (d2 > 0) getout = true; // endpoint is not in solid
    if (d1 > 0) startout = true;

    // if completely in front of face, no intersection
    if (d1 > 0 && d2 >= d1) return;

    if (d1 <= 0 && d2 <= 0) continue;

    // crosses face
    if (d1 > d2) {
      // enter
      const f = (d1 - DIST_EPSILON) / (d1 - d2);
      if (f > enterfrac) {
        enterfrac = f;
        clipplane = plane;
        leadside = side;
      }
    } else {
      // leave
      const f = (d1 + DIST_EPSILON) / (d1 - d2);
      if (f < leavefrac) leavefrac = f;
    }
  }

  if (!startout) {
    // original point was inside brush
    trace.startsolid = true;
    if (!getout) trace.allsolid = true;
    return;
  }
  if (enterfrac < leavefrac) {
    if (enterfrac > -1 && enterfrac < trace.fraction) {
      if (enterfrac < 0) enterfrac = 0;
      trace.fraction = enterfrac;
      if (clipplane) copyPlane(trace.plane, clipplane);
      if (leadside) trace.surface = leadside.surface.c;
      trace.contents = brush.contents;
    }
  }
}

/*
================
CM_TestBoxInBrush
================
*/
function CM_TestBoxInBrush(mins: Vec3, maxs: Vec3, p1: Vec3, trace: TraceT, brush: CbrushT): void {
  if (!brush.numsides) return;

  const ofs = vec3();

  for (let i = 0; i < brush.numsides; i++) {
    const side = map_brushsides[brush.firstbrushside + i];
    const plane = side.plane;

    // general box case
    // push the plane out apropriately for mins/maxs
    for (let j = 0; j < 3; j++) {
      ofs[j] = plane.normal[j] < 0 ? maxs[j] : mins[j];
    }
    let dist = DotProduct(ofs, plane.normal);
    dist = plane.dist - dist;

    const d1 = DotProduct(p1, plane.normal) - dist;

    // if completely in front of face, no intersection
    if (d1 > 0) return;
  }

  // inside this brush
  trace.startsolid = true;
  trace.allsolid = true;
  trace.fraction = 0;
  trace.contents = brush.contents;
}

/*
================
CM_TraceToLeaf
================
*/
function CM_TraceToLeaf(leafnum: number): void {
  const leaf = map_leafs[leafnum];
  if (!(leaf.contents & trace_contents)) return;
  // trace line against all brushes in the leaf
  for (let k = 0; k < leaf.numleafbrushes; k++) {
    const brushnum = map_leafbrushes[leaf.firstleafbrush + k];
    const b = map_brushes[brushnum];
    if (b.checkcount === checkcount) continue; // already checked this brush in another leaf
    b.checkcount = checkcount;

    if (!(b.contents & trace_contents)) continue;
    CM_ClipBoxToBrush(trace_mins, trace_maxs, trace_start, trace_end, trace_trace, b);
    if (!trace_trace.fraction) return;
  }
}

/*
================
CM_TestInLeaf
================
*/
function CM_TestInLeaf(leafnum: number): void {
  const leaf = map_leafs[leafnum];
  if (!(leaf.contents & trace_contents)) return;
  // trace line against all brushes in the leaf
  for (let k = 0; k < leaf.numleafbrushes; k++) {
    const brushnum = map_leafbrushes[leaf.firstleafbrush + k];
    const b = map_brushes[brushnum];
    if (b.checkcount === checkcount) continue; // already checked this brush in another leaf
    b.checkcount = checkcount;

    if (!(b.contents & trace_contents)) continue;
    CM_TestBoxInBrush(trace_mins, trace_maxs, trace_start, trace_trace, b);
    if (!trace_trace.fraction) return;
  }
}

/*
==================
CM_RecursiveHullCheck

==================
*/
function CM_RecursiveHullCheck(num: number, p1f: number, p2f: number, p1: Vec3, p2: Vec3): void {
  if (trace_trace.fraction <= p1f) return; // already hit something nearer

  // if < 0, we are in a leaf node
  if (num < 0) {
    CM_TraceToLeaf(-1 - num);
    return;
  }

  //
  // find the point distances to the seperating plane
  // and the offset for the size of the box
  //
  const node = map_nodes[num];
  const plane = node.plane;

  let t1: number;
  let t2: number;
  let offset: number;
  if (plane.type < 3) {
    t1 = p1[plane.type] - plane.dist;
    t2 = p2[plane.type] - plane.dist;
    offset = trace_extents[plane.type];
  } else {
    t1 = DotProduct(plane.normal, p1) - plane.dist;
    t2 = DotProduct(plane.normal, p2) - plane.dist;
    if (trace_ispoint) offset = 0;
    else offset = Math.abs(trace_extents[0] * plane.normal[0]) + Math.abs(trace_extents[1] * plane.normal[1]) + Math.abs(trace_extents[2] * plane.normal[2]);
  }

  // see which sides we need to consider
  if (t1 >= offset && t2 >= offset) {
    CM_RecursiveHullCheck(node.children[0], p1f, p2f, p1, p2);
    return;
  }
  if (t1 < -offset && t2 < -offset) {
    CM_RecursiveHullCheck(node.children[1], p1f, p2f, p1, p2);
    return;
  }

  // put the crosspoint DIST_EPSILON pixels on the near side
  let side: number;
  let frac: number;
  let frac2: number;
  if (t1 < t2) {
    const idist = 1.0 / (t1 - t2);
    side = 1;
    frac2 = (t1 + offset + DIST_EPSILON) * idist;
    frac = (t1 - offset + DIST_EPSILON) * idist;
  } else if (t1 > t2) {
    const idist = 1.0 / (t1 - t2);
    side = 0;
    frac2 = (t1 - offset - DIST_EPSILON) * idist;
    frac = (t1 + offset + DIST_EPSILON) * idist;
  } else {
    side = 0;
    frac = 1;
    frac2 = 0;
  }

  // move up to the node
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  let midf = p1f + (p2f - p1f) * frac;
  const mid = vec3();
  for (let i = 0; i < 3; i++) mid[i] = p1[i] + frac * (p2[i] - p1[i]);

  CM_RecursiveHullCheck(node.children[side], p1f, midf, p1, mid);

  // go past the node
  if (frac2 < 0) frac2 = 0;
  if (frac2 > 1) frac2 = 1;

  midf = p1f + (p2f - p1f) * frac2;
  const mid2 = vec3();
  for (let i = 0; i < 3; i++) mid2[i] = p1[i] + frac2 * (p2[i] - p1[i]);

  CM_RecursiveHullCheck(node.children[side ^ 1], midf, p2f, mid2, p2);
}

//======================================================================

/*
==================
CM_BoxTrace
==================
*/
export function CM_BoxTrace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, headnode: number, brushmask: number): TraceT {
  checkcount++; // for multi-check avoidance

  c_traces++; // for statistics, may be zeroed

  // fill in a default trace
  trace_trace = new TraceT();
  trace_trace.fraction = 1;
  trace_trace.surface = nullsurface.c;

  if (!numnodes) return trace_trace; // map not loaded

  trace_contents = brushmask;
  VectorCopy(start, trace_start);
  VectorCopy(end, trace_end);
  VectorCopy(mins, trace_mins);
  VectorCopy(maxs, trace_maxs);

  //
  // check for position test special case
  //
  if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) {
    const leafs: number[] = new Array(1024).fill(0);
    const c1 = vec3();
    const c2 = vec3();

    VectorAdd(start, mins, c1);
    VectorAdd(start, maxs, c2);
    for (let i = 0; i < 3; i++) {
      c1[i] -= 1;
      c2[i] += 1;
    }

    const { count } = CM_BoxLeafnums_headnode(c1, c2, leafs, 1024, headnode);
    for (let i = 0; i < count; i++) {
      CM_TestInLeaf(leafs[i]);
      if (trace_trace.allsolid) break;
    }
    VectorCopy(start, trace_trace.endpos);
    return trace_trace;
  }

  //
  // check for point special case
  //
  if (mins[0] === 0 && mins[1] === 0 && mins[2] === 0 && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0) {
    trace_ispoint = true;
    VectorClear(trace_extents);
  } else {
    trace_ispoint = false;
    trace_extents[0] = -mins[0] > maxs[0] ? -mins[0] : maxs[0];
    trace_extents[1] = -mins[1] > maxs[1] ? -mins[1] : maxs[1];
    trace_extents[2] = -mins[2] > maxs[2] ? -mins[2] : maxs[2];
  }

  //
  // general sweeping through world
  //
  CM_RecursiveHullCheck(headnode, 0, 1, start, end);

  if (trace_trace.fraction === 1) {
    VectorCopy(end, trace_trace.endpos);
  } else {
    for (let i = 0; i < 3; i++) trace_trace.endpos[i] = start[i] + trace_trace.fraction * (end[i] - start[i]);
  }
  return trace_trace;
}

/*
==================
CM_TransformedBoxTrace

Handles offseting and rotation of the end points for moving and
rotating entities

(the `#pragma optimize("", off)` bracketing this in the original MSVC build
is a compiler workaround with no portable equivalent -- dropped per
PORTING.md's `#ifdef _WIN32` rule.)
==================
*/
export function CM_TransformedBoxTrace(start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, headnode: number, brushmask: number, origin: Vec3, angles: Vec3): TraceT {
  const start_l = vec3();
  const end_l = vec3();

  // subtract origin offset
  VectorSubtract(start, origin, start_l);
  VectorSubtract(end, origin, end_l);

  // rotate start and end into the models frame of reference
  const rotated = headnode !== box_headnode && (angles[0] !== 0 || angles[1] !== 0 || angles[2] !== 0);

  if (rotated) {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(angles, forward, right, up);

    const temp = vec3();
    VectorCopy(start_l, temp);
    start_l[0] = DotProduct(temp, forward);
    start_l[1] = -DotProduct(temp, right);
    start_l[2] = DotProduct(temp, up);

    VectorCopy(end_l, temp);
    end_l[0] = DotProduct(temp, forward);
    end_l[1] = -DotProduct(temp, right);
    end_l[2] = DotProduct(temp, up);
  }

  // sweep the box through the model
  const trace = CM_BoxTrace(start_l, end_l, mins, maxs, headnode, brushmask);

  if (rotated && trace.fraction !== 1.0) {
    // FIXME: figure out how to do this with existing angles
    const a = vec3();
    VectorNegate(angles, a);
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(a, forward, right, up);

    const temp = vec3();
    VectorCopy(trace.plane.normal, temp);
    trace.plane.normal[0] = DotProduct(temp, forward);
    trace.plane.normal[1] = -DotProduct(temp, right);
    trace.plane.normal[2] = DotProduct(temp, up);
  }

  trace.endpos[0] = start[0] + trace.fraction * (end[0] - start[0]);
  trace.endpos[1] = start[1] + trace.fraction * (end[1] - start[1]);
  trace.endpos[2] = start[2] + trace.fraction * (end[2] - start[2]);

  return trace;
}

/*
===============================================================================

PVS / PHS

===============================================================================
*/

/*
===================
CM_DecompressVis
===================
*/
function CM_DecompressVis(inBuf: Uint8Array | null, inOffset: number, out: Uint8Array): void {
  const row = (numclusters + 7) >> 3;
  let outIdx = 0;

  if (!inBuf || !numvisibility) {
    // no vis info, so make all visible
    for (let i = 0; i < row; i++) out[outIdx++] = 0xff;
    return;
  }

  let inIdx = inOffset;
  do {
    if (inBuf[inIdx]) {
      out[outIdx++] = inBuf[inIdx++];
      continue;
    }

    let c = inBuf[inIdx + 1];
    inIdx += 2;
    if (outIdx + c > row) {
      c = row - outIdx;
      Com_DPrintf("warning: Vis decompression overrun\n");
    }
    while (c) {
      out[outIdx++] = 0;
      c--;
    }
  } while (outIdx < row);
}

const pvsrow = new Uint8Array(MAX_MAP_LEAFS / 8);
const phsrow = new Uint8Array(MAX_MAP_LEAFS / 8);

export function CM_ClusterPVS(cluster: number): Uint8Array {
  if (cluster === -1) {
    pvsrow.fill(0, 0, (numclusters + 7) >> 3);
  } else {
    CM_DecompressVis(map_visibility, dvisBitofs(map_vis_view, cluster, DVIS_PVS), pvsrow);
  }
  return pvsrow;
}

export function CM_ClusterPHS(cluster: number): Uint8Array {
  if (cluster === -1) {
    phsrow.fill(0, 0, (numclusters + 7) >> 3);
  } else {
    CM_DecompressVis(map_visibility, dvisBitofs(map_vis_view, cluster, DVIS_PHS), phsrow);
  }
  return phsrow;
}

/*
===============================================================================

AREAPORTALS

===============================================================================
*/

function FloodArea_r(area: CareaT, floodnum: number): void {
  if (area.floodvalid === floodvalid) {
    if (area.floodnum === floodnum) return;
    Com_Error(ERR_DROP, "FloodArea_r: reflooded");
  }

  area.floodnum = floodnum;
  area.floodvalid = floodvalid;
  for (let i = 0; i < area.numareaportals; i++) {
    const p = map_areaportals[area.firstareaportal + i];
    if (portalopen[p.portalnum]) FloodArea_r(map_areas[p.otherarea], floodnum);
  }
}

/*
====================
FloodAreaConnections


====================
*/
export function FloodAreaConnections(): void {
  // all current floods are now invalid
  floodvalid++;
  let floodnum = 0;

  // area 0 is not used
  for (let i = 1; i < numareas; i++) {
    const area = map_areas[i];
    if (area.floodvalid === floodvalid) continue; // already flooded into
    floodnum++;
    FloodArea_r(area, floodnum);
  }
}

export function CM_SetAreaPortalState(portalnum: number, open: boolean): void {
  if (portalnum > numareaportals) Com_Error(ERR_DROP, "areaportal > numareaportals");

  portalopen[portalnum] = open;
  FloodAreaConnections();
}

export function CM_AreasConnected(area1: number, area2: number): boolean {
  if (map_noareas && map_noareas.value) return true;

  if (area1 > numareas || area2 > numareas) Com_Error(ERR_DROP, "area > numareas");

  if (map_areas[area1].floodnum === map_areas[area2].floodnum) return true;
  return false;
}

/*
=================
CM_WriteAreaBits

Writes a length byte followed by a bit vector of all the areas
that area in the same flood as the area parameter

This is used by the client refreshes to cull visibility
=================
*/
export function CM_WriteAreaBits(buffer: Uint8Array, area: number): number {
  const bytes = (numareas + 7) >> 3;

  if (map_noareas && map_noareas.value) {
    // for debugging, send everything
    buffer.fill(255, 0, bytes);
  } else {
    buffer.fill(0, 0, bytes);

    const floodnum = map_areas[area].floodnum;
    for (let i = 0; i < numareas; i++) {
      if (map_areas[i].floodnum === floodnum || !area) {
        buffer[i >> 3] |= 1 << (i & 7);
      }
    }
  }

  return bytes;
}

/*
===================
CM_WritePortalState

Writes the portal state to a savegame file

Adaptation: the C signature takes a `FILE *f` and fwrite()s
`portalopen` (a `qboolean[]`, i.e. an array of C ints) directly. This port
has no file handle type; it returns a fresh Uint8Array (one byte per
portal, 0/1) for the caller (the future save-game module) to write out
itself. The on-disk byte layout therefore differs from the original engine's
raw struct dump -- reported per brief.
===================
*/
export function CM_WritePortalState(): Uint8Array {
  const out = new Uint8Array(MAX_MAP_AREAPORTALS);
  for (let i = 0; i < MAX_MAP_AREAPORTALS; i++) out[i] = portalopen[i] ? 1 : 0;
  return out;
}

/*
===================
CM_ReadPortalState

Reads the portal state from a savegame file
and recalculates the area connections

Adaptation: accepts the already-read Uint8Array instead of a `FILE *f` (see
CM_WritePortalState).
===================
*/
export function CM_ReadPortalState(data: Uint8Array): void {
  for (let i = 0; i < MAX_MAP_AREAPORTALS; i++) {
    portalopen[i] = i < data.length && data[i] !== 0;
  }
  FloodAreaConnections();
}

/*
===================
CM_WritePortalBits

q2repro's SSV2/SAV2 savegame container's portal encoding (common/cmodel.c
CM_WritePortalBits): one bit per portal (not one byte, like the legacy
CM_WritePortalState/CM_ReadPortalState pair above -- both encodings coexist
here because the legacy fixed-width .sv2 container and the kex SAV2
container use different on-disk layouts, matching q2repro's own file since
it kept the old byte-per-portal CM_WritePortalState alongside the new
bit-packed CM_WritePortalBits rather than replacing it). `numareaportals`
mirrors q2repro's `cm->cache->numportals` ("largest portal number used plus
one" -- bsp.h:285); both are bounded by cm->cache->numportals in the exact
same CM_SetAreaPortalState bounds check above.

Adaptation: the C signature takes `(const cm_t *cm, byte *buffer)` and
returns the byte count written into a caller-owned buffer; this port has no
separate cm_t handle for the currently-loaded map (portalopen/numareaportals
are this module's own globals, like CM_WritePortalState above), so it
returns a freshly-sized Uint8Array instead.
===================
*/
export function CM_WritePortalBits(): Uint8Array {
  const numportals = Math.min(numareaportals, MAX_MAP_PORTAL_BYTES << 3);
  const bytes = (numportals + 7) >> 3;
  const out = new Uint8Array(bytes);
  for (let i = 0; i < numportals; i++) {
    if (portalopen[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

/*
===================
CM_SetPortalStates

Reads CM_WritePortalBits' bit-packed encoding back and recalculates area
connections (common/cmodel.c CM_SetPortalStates). Portals beyond the
buffer's bit count default to OPEN (`true`), matching the C loop's second
`for (; i < cm->cache->numportals; i++) cm->portalopen[i] = true;` tail.
===================
*/
export function CM_SetPortalStates(data: Uint8Array): void {
  const numportals = Math.min(numareaportals, data.length << 3);
  let i = 0;
  for (; i < numportals; i++) {
    portalopen[i] = !!(data[i >> 3] & (1 << (i & 7)));
  }
  for (; i < numareaportals; i++) {
    portalopen[i] = true;
  }
  FloodAreaConnections();
}

/*
=============
CM_HeadnodeVisible

Returns true if any leaf under headnode has a cluster that
is potentially visible
=============
*/
export function CM_HeadnodeVisible(nodenum: number, visbits: Uint8Array): boolean {
  if (nodenum < 0) {
    const leafnum = -1 - nodenum;
    const cluster = map_leafs[leafnum].cluster;
    if (cluster === -1) return false;
    if (visbits[cluster >> 3] & (1 << (cluster & 7))) return true;
    return false;
  }

  const node = map_nodes[nodenum];
  if (CM_HeadnodeVisible(node.children[0], visbits)) return true;
  return CM_HeadnodeVisible(node.children[1], visbits);
}
