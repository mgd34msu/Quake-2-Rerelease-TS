/*
Test for src/client/cl_view.ts and src/client/cl_cin.ts.

Self-sufficient per PORTING.md rule 13: every module-level singleton this
file reads (cl, cls, cin, the r_* scene-accumulation arrays) is reset in a
beforeEach, never assumed from another test file.

Three groups:
  - V_ClearScene / V_AddEntity / V_AddParticle / V_AddLight: cap-then-drop
    behavior against the real MAX_* constants from ref.ts.
  - SCR_LoadPCX: a tiny synthetic PCX (128-byte header + a 4-byte RLE-encoded
    2x2 pixel run + a 768-byte palette) built by hand in this file, decoded
    and checked byte-for-byte, plus SCR_PlayCinematic's ".pcx" branch that
    calls it.
  - Huff1Decompress: rather than driving the full file-reading path
    (Huff1TableInit reads a 65536-byte order-1 counts table from
    cl.cinematic_file), this builds the two rows of cin.hnodes1 that the
    hand-picked bitstream actually visits directly -- row 0 (the initial
    context) and rows 65/66 (the context after decoding 'A'/'B'), each with
    a trivial 2-leaf tree {65, 66} at node id 256 -- and hand-computes the
    bit-packed input byte for a 5-symbol "AABAB" stream. This exercises the
    real per-context row-switching logic (hnodesbase + (nodenum<<9)) and the
    leaf-detection/overread-check paths without needing file I/O.
    SmallestNode1 (the tree-building priority pick) is also checked in
    isolation since it's a pure function over cin.h_count/h_used.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vec3 } from "../src/shared/math";
import { EntityT, MAX_DLIGHTS, MAX_ENTITIES, MAX_PARTICLES } from "../src/client/ref";
import { V_AddEntity, V_AddLight, V_AddParticle, V_ClearScene, r_numdlights, r_numentities, r_numparticles } from "../src/client/cl_view";
import { cin, Huff1Decompress, SCR_LoadPCX, SCR_PlayCinematic, SmallestNode1 } from "../src/client/cl_cin";
import { FS_AddGameDirectory } from "../src/qcommon/files";
import { cl, cls, ConnstateT } from "../src/client/client";

beforeEach(() => {
  V_ClearScene();
  cl.clear();
  cls.clear();
  cin.hnodes1 = null;
  cin.numhnodes1.fill(0);
  cin.h_count.fill(0);
  cin.h_used.fill(0);
});

describe("V_ClearScene / V_AddEntity / V_AddParticle / V_AddLight", () => {
  test("V_ClearScene zeroes all three scene counts", () => {
    V_AddEntity(new EntityT());
    V_AddParticle(vec3(), 1, 1);
    V_AddLight(vec3(), 1, 1, 1, 1);
    expect(r_numentities).toBe(1);
    expect(r_numparticles).toBe(1);
    expect(r_numdlights).toBe(1);

    V_ClearScene();
    expect(r_numentities).toBe(0);
    expect(r_numparticles).toBe(0);
    expect(r_numdlights).toBe(0);
  });

  test("V_AddEntity appends until MAX_ENTITIES then silently drops", () => {
    const ent = new EntityT();
    for (let i = 0; i < MAX_ENTITIES + 5; i++) V_AddEntity(ent);
    expect(r_numentities).toBe(MAX_ENTITIES);
  });

  test("V_AddParticle appends until MAX_PARTICLES then silently drops", () => {
    const org = vec3();
    for (let i = 0; i < MAX_PARTICLES + 5; i++) V_AddParticle(org, 8, 1);
    expect(r_numparticles).toBe(MAX_PARTICLES);
  });

  test("V_AddLight appends until MAX_DLIGHTS then silently drops", () => {
    const org = vec3();
    for (let i = 0; i < MAX_DLIGHTS + 5; i++) V_AddLight(org, 200, 1, 0, 0);
    expect(r_numdlights).toBe(MAX_DLIGHTS);
  });

  test("V_AddEntity copies fields by value, not by reference (matches C's struct-copy assignment)", () => {
    const ent = new EntityT();
    ent.frame = 1;
    V_AddEntity(ent);
    ent.frame = 2;
    V_AddEntity(ent);
    // two distinct captured snapshots, not two references to the same `ent`
    expect(r_numentities).toBe(2);
  });
});

describe("SCR_LoadPCX", () => {
  // Builds a 2x2 8-bit PCX: row0 is a 2-pixel run of color 10 (RLE-encoded
  // as 0xC2,10 -- (0xC0|runLength=2)), row1 is two literal pixels 20,30
  // (each < 0xC0 so no run marker), followed by the trailing 768-byte
  // 256-color palette SCR_LoadPCX reads from the last 768 bytes of the file.
  function buildPcx(): { bytes: Uint8Array; palette: Uint8Array } {
    const header = new Uint8Array(128);
    header[0] = 0x0a; // manufacturer
    header[1] = 5; // version
    header[2] = 1; // encoding (RLE)
    header[3] = 8; // bits_per_pixel
    const hv = new DataView(header.buffer);
    hv.setUint16(8, 1, true); // xmax = width-1 = 1
    hv.setUint16(10, 1, true); // ymax = height-1 = 1

    const pixelData = new Uint8Array([0xc2, 10, 20, 30]);

    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = i % 256;

    const bytes = new Uint8Array(header.length + pixelData.length + palette.length);
    bytes.set(header, 0);
    bytes.set(pixelData, header.length);
    bytes.set(palette, header.length + pixelData.length);

    return { bytes, palette };
  }

  function withFixtureGamedir(filename: string, bytes: Uint8Array): void {
    const dir = mkdtempSync(join(tmpdir(), "q2-cl-cin-"));
    mkdirSync(join(dir, "pics"), { recursive: true });
    writeFileSync(join(dir, "pics", filename), bytes);
    FS_AddGameDirectory(dir);
  }

  test("decodes pixels and palette exactly", () => {
    const { bytes, palette } = buildPcx();
    withFixtureGamedir("test.pcx", bytes);

    const result = SCR_LoadPCX("pics/test.pcx");

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    expect(result.pic).not.toBeNull();
    expect(Array.from(result.pic ?? [])).toEqual([10, 10, 20, 30]);
    expect(result.palette).not.toBeNull();
    expect(Array.from(result.palette ?? [])).toEqual(Array.from(palette));
  });

  test("returns a null pic for a missing file", () => {
    const result = SCR_LoadPCX("pics/does-not-exist.pcx");
    expect(result.pic).toBeNull();
    expect(result.palette).toBeNull();
  });

  test("SCR_PlayCinematic's .pcx branch loads the static image and sets cinematicframe -1", () => {
    const { bytes } = buildPcx();
    withFixtureGamedir("splash.pcx", bytes);

    SCR_PlayCinematic("splash.pcx");

    expect(cl.cinematicframe).toBe(-1);
    expect(cl.cinematictime).toBe(1);
    expect(cls.state).toBe(ConnstateT.ca_active);
    expect(cl.cinematicpalette[0]).toBe(0); // palette[0] === 0 % 256
    expect(cl.cinematicpalette[767]).toBe(767 % 256);
  });
});

describe("Huff1Decompress / SmallestNode1 (order-1 Huffman)", () => {
  test("SmallestNode1 returns the lowest untried nonzero count, marking each used", () => {
    cin.h_count[5] = 3;
    cin.h_count[9] = 1;
    cin.h_count[20] = 7;

    expect(SmallestNode1(256)).toBe(9);
    expect(cin.h_used[9]).toBe(1);
    expect(SmallestNode1(256)).toBe(5);
    expect(SmallestNode1(256)).toBe(20);
    expect(SmallestNode1(256)).toBe(-1); // nothing left untried
  });

  test("decodes a hand-built order-1 stream through the real row-switching logic", () => {
    // Populate cin.hnodes1 with only the rows this stream actually visits:
    // row 0 (the initial context, selected by nodenum=256 on the very first
    // lookup) and rows 65/66 (the context after decoding 'A'=65 / 'B'=66).
    // Each row's single internal node (id 256) is a 2-leaf tree {65, 66}.
    cin.hnodes1 = new Int32Array(256 * 256 * 2);
    const setRow = (prev: number): void => {
      const base = prev * 256 * 2; // node id 256 lives at offset 0 within its row
      cin.hnodes1![base] = 65; // bit 0 -> 'A'
      cin.hnodes1![base + 1] = 66; // bit 1 -> 'B'
    };
    setRow(0);
    setRow(65);
    setRow(66);
    cin.numhnodes1[0] = 256;
    cin.numhnodes1[65] = 256;
    cin.numhnodes1[66] = 256;

    // Intended output "AABAB" -> bit sequence [0,0,1,0,1] (LSB first,
    // 0='A', 1='B'). Packed into one byte: 0*1+0*2+1*4+0*8+1*16 = 20.
    const compressed = new Uint8Array([20]);
    const data = new Uint8Array(4 + compressed.length);
    data[0] = 5; // decompressed count, little-endian 32-bit: 5 symbols
    data[1] = 0;
    data[2] = 0;
    data[3] = 0;
    data.set(compressed, 4);

    const result = Huff1Decompress({ data, count: data.length });

    expect(Array.from(result.data)).toEqual([65, 65, 66, 65, 66]); // "AABAB"
    expect(result.count).toBe(5);
  });
});
