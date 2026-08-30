import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEndOfCentralDirectory, parseCentralDirectory, extractEntry, ZipArchive, ZIP_METHOD_STORE, ZIP_METHOD_DEFLATE, type ZipEntryT } from "../src/qcommon/zipfile";
import { parseBspxDirectory, parseDecoupledLM, parseLightgridHeader, parseLightgrid } from "../src/qcommon/bspx";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_LoadFile, FS_FreeFile } from "../src/qcommon/files";

//=============================================================================
// helpers -- fabricate a byte-exact ZIP archive (local file headers +
// central directory + EOCD), the same way test/files.test.ts fabricates a
// byte-exact classic .pak archive for files.ts's PACK reader.

interface ZipEntrySpec {
  name: string;
  data: Uint8Array;
  method: 0 | 8;
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textOf(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

function crc32(data: Uint8Array): number {
  // Not performance sensitive (test-only, small fixtures) -- a plain
  // bitwise table-free implementation of the standard ZIP/PNG CRC-32.
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: ZipEntrySpec[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralRecords: { name: string; method: number; crc: number; compSize: number; uncompSize: number; localOffset: number }[] = [];

  let offset = 0;
  for (const entry of entries) {
    const nameBytes = bytesOf(entry.name);
    const compressed = entry.method === ZIP_METHOD_DEFLATE ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length + compressed.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0, true); // flags
    view.setUint16(8, entry.method, true);
    view.setUint16(10, 0, true); // mod time
    view.setUint16(12, 0, true); // mod date
    view.setUint32(14, crc, true);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(compressed, 30 + nameBytes.length);

    localChunks.push(local);
    centralRecords.push({ name: entry.name, method: entry.method, crc, compSize: compressed.length, uncompSize: entry.data.length, localOffset: offset });
    offset += local.length;
  }

  const centralChunks: Uint8Array[] = [];
  let centralSize = 0;
  for (const rec of centralRecords) {
    const nameBytes = bytesOf(rec.name);
    const central = new Uint8Array(46 + nameBytes.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0, true); // flags
    view.setUint16(10, rec.method, true);
    view.setUint16(12, 0, true); // mod time
    view.setUint16(14, 0, true); // mod date
    view.setUint32(16, rec.crc, true);
    view.setUint32(20, rec.compSize, true);
    view.setUint32(24, rec.uncompSize, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true); // extra length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number
    view.setUint16(36, 0, true); // internal attrs
    view.setUint32(38, 0, true); // external attrs
    view.setUint32(42, rec.localOffset, true);
    central.set(nameBytes, 46);

    centralChunks.push(central);
    centralSize += central.length;
  }

  const centralOffset = offset;
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // disk with central dir
  eocdView.setUint16(8, entries.length, true); // entries on this disk
  eocdView.setUint16(10, entries.length, true); // total entries
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true); // comment length

  return new Uint8Array(Buffer.concat([...localChunks, ...centralChunks, eocd].map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
}

//=============================================================================
// helpers -- fabricate a minimal BSPX directory + lump payloads, mirroring
// inc/format/bsp.h:60-66's on-disk xlump_t layout.

function bspxNameBytes(name: string): Uint8Array {
  const out = new Uint8Array(24);
  out.set(bytesOf(name).subarray(0, 24));
  return out;
}

function buildBspxBlob(searchPos: number, lumps: { name: string; data: Uint8Array }[]): Uint8Array {
  const alignedStart = (searchPos + 3) & ~3;
  const headerSize = 8 + lumps.length * 32;
  let payloadOffset = alignedStart + headerSize;

  const layout = lumps.map((l) => {
    const ofs = payloadOffset;
    payloadOffset += l.data.length;
    return { ...l, ofs };
  });

  const total = payloadOffset;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // BSPXHEADER magic + numlumps
  buf[alignedStart] = "B".charCodeAt(0);
  buf[alignedStart + 1] = "S".charCodeAt(0);
  buf[alignedStart + 2] = "P".charCodeAt(0);
  buf[alignedStart + 3] = "X".charCodeAt(0);
  view.setUint32(alignedStart + 4, lumps.length, true);

  let pos = alignedStart + 8;
  for (const l of layout) {
    buf.set(bspxNameBytes(l.name), pos);
    view.setUint32(pos + 24, l.ofs, true);
    view.setUint32(pos + 28, l.data.length, true);
    pos += 32;
    buf.set(l.data, l.ofs);
  }

  return buf;
}

//=============================================================================

describe("zipfile.ts -- minimal ZIP reader", () => {
  test("findEndOfCentralDirectory locates the EOCD signature", () => {
    const zip = buildZip([{ name: "a.txt", data: bytesOf("hello"), method: ZIP_METHOD_STORE }]);
    const offset = findEndOfCentralDirectory(zip);
    expect(offset).not.toBeNull();
    expect(new DataView(zip.buffer).getUint32(offset as number, true)).toBe(0x06054b50);
  });

  test("findEndOfCentralDirectory returns null for a non-ZIP buffer", () => {
    expect(findEndOfCentralDirectory(bytesOf("not a zip file at all"))).toBeNull();
    expect(findEndOfCentralDirectory(new Uint8Array(4))).toBeNull();
  });

  test("parseCentralDirectory decodes a stored entry's metadata exactly", () => {
    const data = bytesOf("STORED-PAYLOAD");
    const zip = buildZip([{ name: "stored.txt", data, method: ZIP_METHOD_STORE }]);
    const eocd = findEndOfCentralDirectory(zip) as number;
    const entries = parseCentralDirectory(zip, eocd) as ZipEntryT[];

    expect(entries).not.toBeNull();
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("stored.txt");
    expect(entries[0].method).toBe(ZIP_METHOD_STORE);
    expect(entries[0].uncompressedSize).toBe(data.length);
    expect(entries[0].compressedSize).toBe(data.length);
  });

  test("extractEntry round-trips a stored entry byte-for-byte", () => {
    const data = bytesOf("STORED-PAYLOAD-EXACT-BYTES");
    const zip = buildZip([{ name: "stored.txt", data, method: ZIP_METHOD_STORE }]);
    const eocd = findEndOfCentralDirectory(zip) as number;
    const entries = parseCentralDirectory(zip, eocd) as ZipEntryT[];

    const out = extractEntry(zip, entries[0]);
    expect(textOf(out)).toBe("STORED-PAYLOAD-EXACT-BYTES");
  });

  test("extractEntry round-trips a DEFLATEd entry byte-for-byte", () => {
    const data = bytesOf("deflate deflate deflate deflate deflate compress-me compress-me");
    const zip = buildZip([{ name: "deflated.txt", data, method: ZIP_METHOD_DEFLATE }]);
    const eocd = findEndOfCentralDirectory(zip) as number;
    const entries = parseCentralDirectory(zip, eocd) as ZipEntryT[];

    expect(entries[0].method).toBe(ZIP_METHOD_DEFLATE);
    expect(entries[0].compressedSize).toBeLessThan(data.length);

    const out = extractEntry(zip, entries[0]);
    expect(textOf(out)).toBe(textOf(data));
  });

  test("ZipArchive.readFile is case-insensitive and mixes STORE/DEFLATE entries", () => {
    const zip = buildZip([
      { name: "Fonts/Confont.kfont", data: bytesOf("KFONT-BYTES"), method: ZIP_METHOD_STORE },
      { name: "progs/shader.shader", data: bytesOf("shader source shader source shader source"), method: ZIP_METHOD_DEFLATE },
    ]);
    const archive = ZipArchive.open(zip);
    expect(archive).not.toBeNull();
    const a = archive as ZipArchive;

    expect(textOf(a.readFile("fonts/confont.kfont") as Uint8Array)).toBe("KFONT-BYTES");
    expect(textOf(a.readFile("PROGS/SHADER.SHADER") as Uint8Array)).toBe("shader source shader source shader source");
    expect(a.readFile("does/not/exist.txt")).toBeNull();
  });
});

describe("bspx.ts -- BSPX directory parsing", () => {
  test("parseBspxDirectory decodes a single-lump directory's offset/length", () => {
    const payload = bytesOf("DECOUPLED-LM-PAYLOAD-40-BYTES-PADDED!!!"); // 40 bytes
    const searchPos = 1000;
    const blob = buildBspxBlob(searchPos, [{ name: "DECOUPLED_LM", data: payload }]);

    const dir = parseBspxDirectory(blob, searchPos, blob.length);
    expect(dir).not.toBeNull();
    const lump = dir?.lumps.get("DECOUPLED_LM");
    expect(lump).toBeDefined();
    expect(lump?.filelen).toBe(payload.length);
    expect(textOf(blob.subarray(lump!.fileofs, lump!.fileofs + lump!.filelen))).toBe(textOf(payload));
  });

  test("parseBspxDirectory returns null when no BSPX magic is present", () => {
    const blob = new Uint8Array(64); // all zero bytes, no BSPX header anywhere
    expect(parseBspxDirectory(blob, 32, blob.length)).toBeNull();
  });

  test("parseBspxDirectory drops an out-of-bounds lump but keeps a valid one", () => {
    const good = bytesOf("GOOD-LUMP-DATA");
    const searchPos = 200;
    const blob = buildBspxBlob(searchPos, [{ name: "FACENORMALS", data: good }]);

    // corrupt the DECOUPLED_LM-shaped second entry by hand: extend the
    // directory to declare a lump whose fileofs+filelen overruns the buffer.
    const alignedStart = (searchPos + 3) & ~3;
    const extended = new Uint8Array(blob.length + 32);
    extended.set(blob);
    // bump numlumps to 2
    new DataView(extended.buffer).setUint32(alignedStart + 4, 2, true);
    const secondEntryPos = alignedStart + 8 + 32;
    extended.set(bspxNameBytes("LIGHTGRID_OCTREE"), secondEntryPos);
    const dv = new DataView(extended.buffer);
    dv.setUint32(secondEntryPos + 24, blob.length, true); // fileofs
    dv.setUint32(secondEntryPos + 28, 999999, true); // filelen -- runs past EOF

    const dir = parseBspxDirectory(extended, searchPos, extended.length);
    expect(dir).not.toBeNull();
    expect(dir?.lumps.has("FACENORMALS")).toBe(true);
    expect(dir?.lumps.has("LIGHTGRID_OCTREE")).toBe(false);
  });
});

describe("bspx.ts -- DECOUPLED_LM struct decode", () => {
  function buildDecoupledLmBytes(faces: { lmWidth: number; lmHeight: number; offset: number; axis0: [number, number, number]; off0: number; axis1: [number, number, number]; off1: number }[]): Uint8Array {
    const buf = new Uint8Array(faces.length * 40);
    const view = new DataView(buf.buffer);
    let pos = 0;
    for (const f of faces) {
      view.setInt16(pos, f.lmWidth, true);
      view.setInt16(pos + 2, f.lmHeight, true);
      view.setUint32(pos + 4, f.offset, true);
      view.setFloat32(pos + 8, f.axis0[0], true);
      view.setFloat32(pos + 12, f.axis0[1], true);
      view.setFloat32(pos + 16, f.axis0[2], true);
      view.setFloat32(pos + 20, f.off0, true);
      view.setFloat32(pos + 24, f.axis1[0], true);
      view.setFloat32(pos + 28, f.axis1[1], true);
      view.setFloat32(pos + 32, f.axis1[2], true);
      view.setFloat32(pos + 36, f.off1, true);
      pos += 40;
    }
    return buf;
  }

  test("decodes width/height/offset/axis/offset fields exactly", () => {
    const bytes = buildDecoupledLmBytes([{ lmWidth: 17, lmHeight: 9, offset: 128, axis0: [1, 0, 0], off0: 0.5, axis1: [0, 1, 0], off1: -2.25 }]);

    const result = parseDecoupledLM(bytes, 0, bytes.length, 1, 4096);
    expect(result).not.toBeNull();
    expect(result?.possiblyCorrupted).toBe(false);
    const face = result?.faces[0];
    expect(face?.lmWidth).toBe(17);
    expect(face?.lmHeight).toBe(9);
    expect(face?.lightofs).toBe(128);
    expect(face?.lmAxis[0]).toEqual([1, 0, 0]);
    expect(face?.lmAxis[1]).toEqual([0, 1, 0]);
    expect(face?.lmOffset[0]).toBeCloseTo(0.5);
    expect(face?.lmOffset[1]).toBeCloseTo(-2.25);
  });

  test("treats a 0xffffffff offset as 'no lightmap' without flagging corruption", () => {
    const bytes = buildDecoupledLmBytes([{ lmWidth: 4, lmHeight: 4, offset: 0xffffffff, axis0: [0, 0, 1], off0: 0, axis1: [1, 0, 0], off1: 0 }]);
    const result = parseDecoupledLM(bytes, 0, bytes.length, 1, 4096);
    expect(result?.faces[0].lightofs).toBeNull();
    expect(result?.possiblyCorrupted).toBe(false);
  });

  test("flags possiblyCorrupted and nulls lightofs when the offset exceeds numlightmapbytes", () => {
    const bytes = buildDecoupledLmBytes([{ lmWidth: 4, lmHeight: 4, offset: 9000, axis0: [0, 0, 1], off0: 0, axis1: [1, 0, 0], off1: 0 }]);
    const result = parseDecoupledLM(bytes, 0, bytes.length, 1, 4096);
    expect(result?.faces[0].lightofs).toBeNull();
    expect(result?.possiblyCorrupted).toBe(true);
  });

  test("rejects a lump whose size isn't a multiple of 40 bytes", () => {
    const bytes = new Uint8Array(41);
    expect(parseDecoupledLM(bytes, 0, bytes.length, 1, 4096)).toBeNull();
  });

  test("rejects a lump too short for the model's face count", () => {
    const bytes = buildDecoupledLmBytes([{ lmWidth: 1, lmHeight: 1, offset: 0, axis0: [0, 0, 0], off0: 0, axis1: [0, 0, 0], off1: 0 }]);
    // lump has exactly 1 face worth of bytes, but the model claims 2 faces
    expect(parseDecoupledLM(bytes, 0, bytes.length, 2, 4096)).toBeNull();
  });
});

describe("bspx.ts -- LIGHTGRID_OCTREE header parse/validate", () => {
  // Minimal single-leaf, no-node grid: rootnode directly names leaf 0
  // (FLAG_LEAF | 0). One grid point in that leaf with numstyles=255 ("no
  // data" sentinel), so no sample bytes follow.
  function buildLightgridBytes(): Uint8Array {
    const FLAG_LEAF = 0x80000000;
    // 45 (fixed header) + 4 (numleafs) + 12 (leaf mins) + 12 (leaf size) + 1
    // (this leaf's one sample's numstyles byte) = 74.
    const buf = new ArrayBuffer(74);
    const view = new DataView(buf);
    let p = 0;
    view.setFloat32(p, 1, true);
    p += 4; // scale.x (stored as 1/x)
    view.setFloat32(p, 1, true);
    p += 4;
    view.setFloat32(p, 1, true);
    p += 4;
    view.setInt32(p, 4, true);
    p += 4; // size[0]
    view.setInt32(p, 4, true);
    p += 4; // size[1]
    view.setInt32(p, 4, true);
    p += 4; // size[2]
    view.setFloat32(p, 0, true);
    p += 4; // mins.x
    view.setFloat32(p, 0, true);
    p += 4;
    view.setFloat32(p, 0, true);
    p += 4;
    view.setUint8(p, 1);
    p += 1; // numstyles
    view.setUint32(p, (FLAG_LEAF | 0) >>> 0, true);
    p += 4; // rootnode = leaf 0
    view.setUint32(p, 0, true);
    p += 4; // numnodes = 0
    view.setUint32(p, 1, true);
    p += 4; // numleafs = 1
    // leaf 0: mins[3], size[3]=(1,1,1) -> 1 sample
    view.setInt32(p, 0, true);
    p += 4;
    view.setInt32(p, 0, true);
    p += 4;
    view.setInt32(p, 0, true);
    p += 4;
    view.setInt32(p, 1, true);
    p += 4;
    view.setInt32(p, 1, true);
    p += 4;
    view.setInt32(p, 1, true);
    p += 4;
    view.setUint8(p, 255); // this sample's numstyles: 255 == no data
    p += 1;

    return new Uint8Array(buf, 0, p);
  }

  test("parseLightgridHeader validates a minimal single-leaf grid", () => {
    const bytes = buildLightgridBytes();
    // parseLightgridHeader is not exported directly for standalone assertion
    // beyond parseLightgrid's success/failure -- exercise it via the full
    // parse, which calls it internally first.
    const grid = parseLightgrid(bytes, 0, bytes.length, true);
    expect(grid).not.toBeNull();
    expect(grid?.numleafs).toBe(1);
    expect(grid?.numsamples).toBe(1);
    expect(grid?.leafs.length).toBe(1);
    expect(grid?.leafs[0].numsamples).toBe(1);
    // the lone sample was declared "no data" (255) -- stays at the
    // fully-occluded sentinel.
    expect(grid?.samples[0].style).toBe(0xff);
  });

  test("parseLightgrid refuses to run when the map has no lightmap data", () => {
    const bytes = buildLightgridBytes();
    expect(parseLightgrid(bytes, 0, bytes.length, false)).toBeNull();
  });

  test("parseLightgrid rejects a truncated lump", () => {
    const bytes = buildLightgridBytes().subarray(0, 20);
    expect(parseLightgrid(bytes, 0, bytes.length, true)).toBeNull();
  });

  test("parseLightgridHeader rejects numstyles == 0 (JS doesn't wrap like the C uint32_t underflow check)", () => {
    const bytes = buildLightgridBytes();
    // numstyles is the single byte at offset 36 (3 floats + 3 longs + 3 floats)
    bytes[36] = 0;
    expect(parseLightgridHeader(bytes, 0, bytes.length)).toBeNull();
  });
});

describe("files.ts -- Q2Game.kpf search-path integration", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2kpf-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir);

    const kpf = buildZip([
      { name: "localization/loc_english.txt", data: bytesOf("KPF-LOC-DATA"), method: ZIP_METHOD_STORE },
      { name: "fonts/qfont.kfont", data: bytesOf("KPF-FONT-DATA-COMPRESSIBLE-COMPRESSIBLE"), method: ZIP_METHOD_DEFLATE },
      // present in both the kpf and a baseq2 loose file, to prove baseq2 wins
      { name: "shared.txt", data: bytesOf("FROM-KPF"), method: ZIP_METHOD_STORE },
    ]);
    writeFileSync(join(tmpRoot, "Q2Game.kpf"), kpf);
    writeFileSync(join(baseq2Dir, "shared.txt"), bytesOf("FROM-BASEQ2"));

    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a KPF-only entry loads through FS_LoadFile", () => {
    const buf = FS_LoadFile("localization/loc_english.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("KPF-LOC-DATA");
    FS_FreeFile(buf);
  });

  test("a DEFLATEd KPF entry decompresses correctly through FS_LoadFile", () => {
    const buf = FS_LoadFile("fonts/qfont.kfont");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("KPF-FONT-DATA-COMPRESSIBLE-COMPRESSIBLE");
    FS_FreeFile(buf);
  });

  test("baseq2 wins over Q2Game.kpf for a same-named file (KPF is a lower-priority fallback)", () => {
    const buf = FS_LoadFile("shared.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("FROM-BASEQ2");
    FS_FreeFile(buf);
  });
});
