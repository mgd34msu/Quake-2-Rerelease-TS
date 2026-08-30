// bspx.ts -- BSPX extension lump directory (KEX/rerelease + q2repro BSP
// extension format).
//
// Ported from q2repro's src/common/bsp.c:
//   - BSP_ParseExtensionHeader (~line 731) -- the xlump_t directory itself,
//     inc/format/bsp.h:60 (BSPXHEADER magic) and :62-66 (xlump_t struct).
//   - BSP_ParseDecoupledLM (~line 412) -- the DECOUPLED_LM lump (per-face
//     lightmap resolution/orientation decoupled from the face's texture
//     axes, "decoupled lightmaps").
//   - BSP_ParseLightgridHeader_/BSP_ParseLightgrid/BSP_ValidateLightgrid_r
//     (~lines 460-600) -- the LIGHTGRID_OCTREE lump (a sparse octree of
//     ambient-light samples used for dynamic/model lighting).
//
// This module is the PARSE + VALIDATE layer only. It decodes the BSPX
// directory and the two lumps our renderer loaders look for into plain
// data structures and performs the same structural validation the C
// original does (size/bounds/duplicate checks, octree structural
// validation). It does NOT wire decoupled lightmaps or the lightgrid into
// the lightmap-building or lighting-sampling pipeline (GL_BuildPolygonFromSurface
// /R_BuildLightMap/world lighting lookups) -- see gl_model.ts's/r_model.ts's
// Mod_LoadBrushModel for what calls into this module and what still isn't
// wired up.
//
// Com_WPrintf (a q2repro-only warning-level print) has no ported
// equivalent in this tree's common.ts -- warnings below go through
// Com_Printf, same as every other diagnostic in the renderer loaders.

import { Com_Printf } from "./common";

// MakeLittleLong('B','S','P','X'): the on-disk bytes read as a little-endian
// uint32 (matches qfiles.ts's IDBSPHEADER construction for "IBSP").
const BSPXHEADER = ("B".charCodeAt(0) | ("S".charCodeAt(0) << 8) | ("P".charCodeAt(0) << 16) | ("X".charCodeAt(0) << 24)) >>> 0;

const XLUMP_NAME_LEN = 24;
const XLUMP_T_SIZE = XLUMP_NAME_LEN + 4 + 4;

function alignUp4(pos: number): number {
  return (pos + 3) & ~3;
}

export interface BspxLumpT {
  readonly fileofs: number;
  readonly filelen: number;
}

export interface BspxDirectoryT {
  readonly lumps: ReadonlyMap<string, BspxLumpT>;
}

/*
====================
parseBspxDirectory

Locates and decodes the BSPX lump directory appended after a BSP file's
standard lump data. `searchPos` is the byte offset immediately following
the last standard lump's data (the caller aligns nothing -- this function
performs the same 4-byte alignment BSP_ParseExtensionHeader does).

Returns null if no BSPX header is present (this is the common case: most
BSPs have no BSPX extension at all, which is not an error).
====================
*/
export function parseBspxDirectory(buf: Uint8Array, searchPos: number, filelen: number): BspxDirectoryT | null {
  const pos0 = alignUp4(searchPos);
  if (pos0 > filelen - 8) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(pos0, true) !== BSPXHEADER) return null;

  const numlumps = view.getUint32(pos0 + 4, true);
  let pos = pos0 + 8;

  if (numlumps > (filelen - pos) / XLUMP_T_SIZE) {
    Com_Printf("Bad BSPX header\n");
    return null;
  }

  const lumps = new Map<string, BspxLumpT>();
  const decoder = new TextDecoder();

  for (let i = 0; i < numlumps; i++, pos += XLUMP_T_SIZE) {
    const nameBytes = buf.subarray(pos, pos + XLUMP_NAME_LEN);
    let nameEnd = 0;
    while (nameEnd < XLUMP_NAME_LEN && nameBytes[nameEnd] !== 0) nameEnd++;
    const name = decoder.decode(nameBytes.subarray(0, nameEnd));

    const ofs = view.getUint32(pos + XLUMP_NAME_LEN, true);
    const len = view.getUint32(pos + XLUMP_NAME_LEN + 4, true);

    if (len === 0) {
      Com_Printf(`Ignoring empty ${name} lump\n`);
      continue;
    }
    if (ofs + len > filelen) {
      Com_Printf(`Ignoring out of bounds ${name} lump\n`);
      continue;
    }
    if (lumps.has(name)) {
      Com_Printf(`Ignoring duplicate ${name} lump\n`);
      continue;
    }

    lumps.set(name, { fileofs: ofs, filelen: len });
  }

  return { lumps };
}

//=============================================================================
// DECOUPLED_LM

const DECOUPLED_LM_BYTES = 40;

export interface DecoupledLmFaceT {
  readonly lmWidth: number;
  readonly lmHeight: number;
  // byte offset into the LUMP_LIGHTING data, or null for "no lightmap"
  // (the on-disk sentinel is -1 / 0xffffffff, matching lmap offsets
  // elsewhere in the BSP format).
  readonly lightofs: number | null;
  readonly lmAxis: readonly [readonly [number, number, number], readonly [number, number, number]];
  readonly lmOffset: readonly [number, number];
}

export interface DecoupledLmResultT {
  readonly faces: readonly DecoupledLmFaceT[];
  // BSP_ParseDecoupledLM keeps and warns rather than rejecting the whole
  // lump when an individual face's lightmap offset lands outside
  // numlightmapbytes -- mirrored here as a flag instead of throwing.
  readonly possiblyCorrupted: boolean;
}

/*
====================
parseDecoupledLM

Decodes a DECOUPLED_LM lump: per-face lightmap width/height/byte-offset
plus the two lightmap-space axis vectors and their offsets used to
decouple a face's lightmap resolution/orientation from its texture axes.

Returns null if the lump's size doesn't match `numfaces` (matches
BSP_ParseDecoupledLM's two early-return validation checks).
====================
*/
export function parseDecoupledLM(buf: Uint8Array, fileofs: number, filelen: number, numfaces: number, numlightmapbytes: number): DecoupledLmResultT | null {
  if (filelen % DECOUPLED_LM_BYTES !== 0) {
    Com_Printf("DECOUPLED_LM lump has odd size\n");
    return null;
  }
  if (numfaces > filelen / DECOUPLED_LM_BYTES) {
    Com_Printf("DECOUPLED_LM lump too short\n");
    return null;
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const faces: DecoupledLmFaceT[] = [];
  let possiblyCorrupted = false;

  for (let i = 0; i < numfaces; i++) {
    const base = fileofs + i * DECOUPLED_LM_BYTES;

    const lmWidth = view.getInt16(base, true);
    const lmHeight = view.getInt16(base + 2, true);
    const offset = view.getUint32(base + 4, true);

    let lightofs: number | null;
    if (offset === 0xffffffff) {
      lightofs = null;
    } else if (offset < numlightmapbytes) {
      lightofs = offset;
    } else {
      lightofs = null;
      possiblyCorrupted = true;
    }

    let p = base + 8;
    const axis0: [number, number, number] = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)];
    p += 12;
    const off0 = view.getFloat32(p, true);
    p += 4;
    const axis1: [number, number, number] = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)];
    p += 12;
    const off1 = view.getFloat32(p, true);

    faces.push({ lmWidth, lmHeight, lightofs, lmAxis: [axis0, axis1], lmOffset: [off0, off1] });
  }

  if (possiblyCorrupted) Com_Printf("DECOUPLED_LM lump possibly corrupted\n");

  return { faces, possiblyCorrupted };
}

//=============================================================================
// LIGHTGRID_OCTREE
//
// On-disk layout (BSP_ParseLightgridHeader_/BSP_ParseLightgrid):
//   float scale[3]; float mins[3]; uint32 size[3]; uint8 numstyles;
//   uint32 rootnode; uint32 numnodes; lightgrid_node_t nodes[numnodes];
//   uint32 numleafs; lightgrid_leaf_partial_t leafs[numleafs] (mins[3],
//   size[3], then size[0]*size[1]*size[2] variable-length sample records:
//   uint8 numstyles-at-this-point (255 == "no data"), followed by that many
//   4-byte {style, rgb[3]} samples).

export const MAX_LIGHTMAPS = 4;
const FLAG_OCCLUDED = 0x40000000; // BIT(30)
const FLAG_LEAF = 0x80000000 >>> 0; // BIT(31)

class OverrunError extends Error {}

class ReadCursor {
  pos: number;
  constructor(
    private readonly view: DataView,
    private readonly base: number,
    private readonly limit: number,
  ) {
    this.pos = 0;
  }
  remaining(): number {
    return this.limit - this.pos;
  }
  private need(n: number): void {
    if (n > this.remaining()) throw new OverrunError("lightgrid: read past end of lump");
  }
  readByte(): number {
    this.need(1);
    const v = this.view.getUint8(this.base + this.pos);
    this.pos += 1;
    return v;
  }
  readLong(): number {
    this.need(4);
    const v = this.view.getUint32(this.base + this.pos, true);
    this.pos += 4;
    return v;
  }
  readFloat(): number {
    this.need(4);
    const v = this.view.getFloat32(this.base + this.pos, true);
    this.pos += 4;
    return v;
  }
  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

export interface LightgridNodeT {
  point: readonly [number, number, number];
  readonly children: readonly [number, number, number, number, number, number, number, number];
}

export interface LightgridSampleT {
  readonly style: number;
  readonly rgb: readonly [number, number, number];
}

export interface LightgridLeafT {
  readonly mins: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly numsamples: number;
  readonly firstsample: number;
}

export interface LightgridT {
  readonly scale: readonly [number, number, number];
  readonly mins: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly numstyles: number;
  readonly rootnode: number;
  readonly numnodes: number;
  readonly numleafs: number;
  readonly numsamples: number;
  readonly nodes: readonly LightgridNodeT[];
  readonly leafs: readonly LightgridLeafT[];
  // stride between consecutive grid points is always `numstyles` samples
  // (short entries are left at the fully-occluded sentinel below), exactly
  // matching BSP_LookupLightgrid's `samples[firstsample + index*numstyles]`.
  readonly samples: readonly LightgridSampleT[];
}

interface LightgridHeaderT {
  readonly scale: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly mins: readonly [number, number, number];
  readonly numstyles: number;
  readonly rootnode: number;
  readonly numnodes: number;
  readonly numleafs: number;
  readonly numsamples: number;
}

const FULLY_OCCLUDED_SAMPLE: LightgridSampleT = { style: 0xff, rgb: [0xff, 0xff, 0xff] };

/*
====================
parseLightgridHeader

Reads and structurally validates the LIGHTGRID_OCTREE header, including the
per-leaf sample-count walk BSP_ParseLightgridHeader_ does purely to compute
the total sample count (there is no shortcut -- every leaf's variable-length
sample block has to be walked to know where the next leaf starts).

Returns null on any structural violation (bad numstyles, node/leaf counts
that don't fit the remaining lump data, a leaf's declared sample count that
exceeds the running total, or a truncated read).
====================
*/
export function parseLightgridHeader(buf: Uint8Array, fileofs: number, filelen: number): LightgridHeaderT | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const s = new ReadCursor(view, fileofs, filelen);

  try {
    const scale: [number, number, number] = [1 / s.readFloat(), 1 / s.readFloat(), 1 / s.readFloat()];
    const size: [number, number, number] = [s.readLong(), s.readLong(), s.readLong()];
    const mins: [number, number, number] = [s.readFloat(), s.readFloat(), s.readFloat()];

    const numstyles = s.readByte();
    // C: `grid->numstyles - 1 >= MAX_LIGHTMAPS` on a uint32_t -- numstyles==0
    // underflows to UINT32_MAX there, which is >= MAX_LIGHTMAPS and gets
    // rejected. JS's `numstyles - 1` doesn't wrap (stays -1, a signed
    // comparison that would let 0 through) -- the explicit `=== 0` check
    // below restores the same observable outcome (FIDELITY RAZOR, rule 17).
    if (numstyles - 1 >= MAX_LIGHTMAPS || numstyles === 0) {
      Com_Printf("Bad LIGHTGRID_OCTREE header\n");
      return null;
    }

    const rootnode = s.readLong();
    const numnodes = s.readLong();
    if (numnodes > s.remaining() / 44) {
      Com_Printf("Bad LIGHTGRID_OCTREE header\n");
      return null;
    }
    s.skip(numnodes * 44);

    const numleafs = s.readLong();
    if (numleafs - 1 >= s.remaining() / 24) {
      Com_Printf("Bad LIGHTGRID_OCTREE header\n");
      return null;
    }

    let numsamples = 0;
    for (let i = 0; i < numleafs; i++) {
      s.skip(12); // leaf mins[3]
      const x = s.readLong();
      const y = s.readLong();
      const z = s.readLong();

      let leafSamples = x * y * z;
      numsamples += leafSamples;

      while (leafSamples--) {
        const styleCount = s.readByte();
        if (styleCount === 255) continue;
        if (styleCount > numstyles) {
          Com_Printf("Bad LIGHTGRID_OCTREE header\n");
          return null;
        }
        s.skip(4 * styleCount);
      }
    }

    return { scale, size, mins, numstyles, rootnode, numnodes, numleafs, numsamples };
  } catch (err) {
    if (err instanceof OverrunError) {
      Com_Printf("Bad LIGHTGRID_OCTREE header\n");
      return null;
    }
    throw err;
  }
}

function validateLightgridTree(nodes: readonly LightgridNodeT[], numleafs: number, nodenum: number, visited: Uint8Array): boolean {
  if (nodenum & FLAG_OCCLUDED) return true;

  if (nodenum & FLAG_LEAF) {
    return (nodenum & ~FLAG_LEAF) >>> 0 < numleafs;
  }

  if (nodenum >= nodes.length) return false;
  if (visited[nodenum]) return false;
  visited[nodenum] = 1;

  const node = nodes[nodenum];
  for (const child of node.children) {
    if (!validateLightgridTree(nodes, numleafs, child, visited)) return false;
  }
  return true;
}

/*
====================
parseLightgrid

Full LIGHTGRID_OCTREE decode: header (see parseLightgridHeader), octree
node/children, structural tree validation (BSP_ValidateLightgrid_r -- every
child reachable from rootnode must be either FLAG_OCCLUDED, a valid leaf
index, or a not-yet-visited node index; cycles and out-of-range indices are
rejected), node bounding points, and per-leaf variable-length sample data.

`hasLightmap` mirrors BSP_ParseLightgrid's "ignore if map isn't lit" guard
-- callers pass whether LUMP_LIGHTING produced any data for this BSP.

Returns null if the header is invalid, the map isn't lit, or tree
validation fails. Returns a LightgridT with numleafs === 0 (no node/leaf/
sample arrays populated) when the header parses but declares zero leafs,
matching BSP_ParseLightgrid's early-return-without-error in that case.
====================
*/
export function parseLightgrid(buf: Uint8Array, fileofs: number, filelen: number, hasLightmap: boolean): LightgridT | null {
  const header = parseLightgridHeader(buf, fileofs, filelen);
  if (!header) return null;

  if (header.numleafs === 0) {
    return { ...header, nodes: [], leafs: [], samples: [] };
  }

  if (!hasLightmap) {
    Com_Printf("Ignoring LIGHTGRID_OCTREE, map isn't lit\n");
    return null;
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const s = new ReadCursor(view, fileofs, filelen);

  try {
    // fixed header is 45 bytes: 3 floats (scale) + 3 longs (size) + 3 floats
    // (mins) + 1 byte (numstyles) + 4 (rootnode) + 4 (numnodes) = 45.
    s.pos = 45;

    const nodes: LightgridNodeT[] = [];
    for (let i = 0; i < header.numnodes; i++) {
      s.skip(12); // point[3], read in the second pass below
      const children: number[] = [];
      for (let j = 0; j < 8; j++) children.push(s.readLong());
      nodes.push({ point: [0, 0, 0], children: children as unknown as LightgridNodeT["children"] });
    }

    const visited = new Uint8Array(header.numnodes);
    if (!validateLightgridTree(nodes, header.numleafs, header.rootnode, visited)) {
      Com_Printf("Bad LIGHTGRID_OCTREE structure\n");
      return null;
    }

    // second pass: read each node's bounding point now that the tree is
    // known to be well-formed.
    s.pos = 45;
    for (let i = 0; i < header.numnodes; i++) {
      const point: [number, number, number] = [s.readLong(), s.readLong(), s.readLong()];
      nodes[i].point = point;
      s.skip(32); // children[8], already read above
    }

    s.skip(4); // numleafs (already known from the header)

    const leafs: LightgridLeafT[] = [];
    const samples: LightgridSampleT[] = new Array(header.numsamples * header.numstyles).fill(FULLY_OCCLUDED_SAMPLE);

    let sampleCursor = 0;
    let remaining = header.numsamples;
    for (let i = 0; i < header.numleafs; i++) {
      const mins: [number, number, number] = [s.readLong(), s.readLong(), s.readLong()];
      const size: [number, number, number] = [s.readLong(), s.readLong(), s.readLong()];

      const numsamples = size[0] * size[1] * size[2];
      const firstsample = sampleCursor;

      if (numsamples > remaining) {
        Com_Printf("Bad LIGHTGRID_OCTREE structure\n");
        return null;
      }
      remaining -= numsamples;

      for (let j = 0; j < numsamples; j++, sampleCursor += header.numstyles) {
        const styleCount = s.readByte();
        if (styleCount === 255) continue;
        if (styleCount > header.numstyles) {
          Com_Printf("Bad LIGHTGRID_OCTREE structure\n");
          return null;
        }
        for (let k = 0; k < styleCount; k++) {
          const style = s.readByte();
          const rgb: [number, number, number] = [s.readByte(), s.readByte(), s.readByte()];
          samples[sampleCursor + k] = { style, rgb };
        }
      }

      leafs.push({ mins, size, numsamples, firstsample });
    }

    return { ...header, nodes, leafs, samples };
  } catch (err) {
    if (err instanceof OverrunError) {
      Com_Printf("Bad LIGHTGRID_OCTREE structure\n");
      return null;
    }
    throw err;
  }
}

/*
====================
lookupLightgrid

BSP_LookupLightgrid's octree walk: descends from rootnode, picking the
child octant containing `point` at each internal node, until it reaches a
leaf (returns that leaf's samples, offset by `point`'s position inside the
leaf's bounding box) or an occluded/invalid path (returns null).
====================
*/
export function lookupLightgrid(grid: LightgridT, point: readonly [number, number, number]): readonly LightgridSampleT[] | null {
  let nodenum = grid.rootnode;

  for (;;) {
    if (nodenum & FLAG_OCCLUDED) return null;

    if (nodenum & FLAG_LEAF) {
      const leaf = grid.leafs[(nodenum & ~FLAG_LEAF) >>> 0];
      if (!leaf) return null;

      const px = point[0] - leaf.mins[0];
      const py = point[1] - leaf.mins[1];
      const pz = point[2] - leaf.mins[2];

      const w = leaf.size[0];
      const h = leaf.size[1];
      const index = w * (h * pz + py) + px;
      if (index < 0 || index >= leaf.numsamples) return null;

      const start = leaf.firstsample + index * grid.numstyles;
      return grid.samples.slice(start, start + grid.numstyles);
    }

    const node = grid.nodes[nodenum];
    if (!node) return null;

    const childIndex = (point[0] >= node.point[0] ? 4 : 0) | (point[1] >= node.point[1] ? 2 : 0) | (point[2] >= node.point[2] ? 1 : 0);
    nodenum = node.children[childIndex];
  }
}
