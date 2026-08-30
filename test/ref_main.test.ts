/*
Self-sufficient suite for src/ref_soft/r_main.ts and r_misc.ts. Every test
sets up its own fake RefImports (SetRefImports) and its own vid.buffer
(SWimp_SetMode) in beforeEach -- nothing here depends on another test file
having run first, per .orch/preferences.md rule 13.

PCX bytes are hand-built the same way test/ref_draw.test.ts does (128-byte
header + RLE-encoded pixel data + 768-byte trailing palette); Draw_GetPalette
and the WritePCX round-trip both reuse that pattern via buildPcxBytes.
*/

import { describe, test, expect, beforeEach } from "bun:test";

import { SetRefImports, d_8to24table, r_refdef, sw_state, vid, view_clipplanes, screenedge, modelorg, vpn, vright, vup } from "../src/ref_soft/r_local";
import type { RefImports } from "../src/client/ref";
import { RefdefT } from "../src/client/ref";
import { CvarT, RDF_NOWORLDMODEL } from "../src/shared/q_shared";
import { SWimp_SetMode } from "../src/platform/swimp";
import { LoadPCX } from "../src/ref_soft/r_image";
import { DotProduct, VectorCopy, type Vec3, vec3 } from "../src/shared/math";
import { Draw_GetPalette, R_GammaCorrectAndSetPalette, R_RenderFrame, R_SetSky, skyaxis, skyname, skyrotate } from "../src/ref_soft/r_main";
import { R_TransformFrustum, TransformVector, WritePCX } from "../src/ref_soft/r_misc";

const VID_WIDTH = 64;
const VID_HEIGHT = 48;

let files: Map<string, Uint8Array>;

function makeFakeRi(): RefImports {
  return {
    Sys_Error(errLevel: number, str: string): never {
      throw new Error(`Sys_Error(${errLevel}): ${str}`);
    },
    Cmd_AddCommand: () => {},
    Cmd_RemoveCommand: () => {},
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => {},
    Con_Printf: () => {},
    FS_LoadFile: (name: string) => {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => {},
    FS_Gamedir: () => "base",
    Cvar_Get: () => new CvarT(),
    Cvar_Set: () => new CvarT(),
    Cvar_SetValue: () => {},
    Vid_GetModeInfo: () => ({ width: VID_WIDTH, height: VID_HEIGHT }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// same RLE scheme as test/ref_draw.test.ts's rleEncodeRow/buildPcxBytes:
// runs of identical bytes use the 0xC0|count marker, and any byte with its
// top two bits already set must always use the marker (even for a run of
// one) since a raw literal in that range would be misread as one on decode.
function rleEncodeRow(row: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    const val = row[i];
    let run = 1;
    while (i + run < row.length && row[i + run] === val && run < 63) run++;
    if (run > 1 || (val & 0xc0) === 0xc0) {
      out.push(0xc0 | run, val);
    } else {
      out.push(val);
    }
    i += run;
  }
  return out;
}

function buildPcxBytes(width: number, height: number, pixelFn: (x: number, y: number) => number, palette: Uint8Array): Uint8Array {
  const header = new Uint8Array(128);
  header[0] = 0x0a;
  header[1] = 5;
  header[2] = 1;
  header[3] = 8;
  const hv = new DataView(header.buffer);
  hv.setUint16(8, width - 1, true);
  hv.setUint16(10, height - 1, true);

  const encoded: number[] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(pixelFn(x, y));
    encoded.push(...rleEncodeRow(row));
  }
  const pixelData = new Uint8Array(encoded);

  const bytes = new Uint8Array(header.length + pixelData.length + palette.length);
  bytes.set(header, 0);
  bytes.set(pixelData, header.length);
  bytes.set(palette, header.length + pixelData.length);
  return bytes;
}

function d8to24Bytes(): Uint8Array {
  return new Uint8Array(d_8to24table.buffer, d_8to24table.byteOffset, d_8to24table.byteLength);
}

beforeEach(() => {
  files = new Map();
  SetRefImports(makeFakeRi());
  SWimp_SetMode(0, 0, 0, false);
  d_8to24table.fill(0);
  sw_state.currentpalette.fill(0);
  sw_state.gammatable.fill(0);
});

describe("Draw_GetPalette", () => {
  test("extracts the 256*3 palette from pics/colormap.pcx into d_8to24table and vid.colormap", () => {
    const palette = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      palette[i * 3 + 0] = i;
      palette[i * 3 + 1] = (i * 2) & 0xff;
      palette[i * 3 + 2] = (i * 3) & 0xff;
    }
    const bytes = buildPcxBytes(4, 4, (x, y) => (y * 4 + x) & 0xff, palette);
    files.set("pics/colormap.pcx", bytes);

    Draw_GetPalette();

    expect(vid.colormap).not.toBeNull();
    expect(Array.from(vid.colormap ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    const out = d8to24Bytes();
    for (let i = 0; i < 256; i++) {
      expect(out[i * 4 + 0]).toBe(palette[i * 3 + 0]);
      expect(out[i * 4 + 1]).toBe(palette[i * 3 + 1]);
      expect(out[i * 4 + 2]).toBe(palette[i * 3 + 2]);
    }
  });

  test("Sys_Errors when pics/colormap.pcx is missing", () => {
    expect(() => Draw_GetPalette()).toThrow();
  });
});

describe("R_GammaCorrectAndSetPalette", () => {
  test("applies the gamma table's byte-for-byte mapping to each RGB channel, per-entry", () => {
    // hand-computed gamma curve: gammatable[v] = 255 - v (an easy-to-verify
    // stand-in for Draw_BuildGammaTable's pow() curve -- this function only
    // ever indexes the table, it doesn't compute it).
    for (let i = 0; i < 256; i++) sw_state.gammatable[i] = 255 - i;

    const inputPalette = new Uint8Array(1024);
    // a handful of known entries, spread across the table
    const samples: Array<[number, number, number, number]> = [
      [0, 10, 20, 30],
      [1, 200, 210, 220],
      [128, 5, 250, 100],
      [255, 0, 255, 128],
    ];
    for (const [i, r, g, b] of samples) {
      inputPalette[i * 4 + 0] = r;
      inputPalette[i * 4 + 1] = g;
      inputPalette[i * 4 + 2] = b;
      inputPalette[i * 4 + 3] = 0xff;
    }

    R_GammaCorrectAndSetPalette(inputPalette);

    for (const [i, r, g, b] of samples) {
      expect(sw_state.currentpalette[i * 4 + 0]).toBe(255 - r);
      expect(sw_state.currentpalette[i * 4 + 1]).toBe(255 - g);
      expect(sw_state.currentpalette[i * 4 + 2]).toBe(255 - b);
    }
  });

  test("identity gamma table is a pass-through", () => {
    for (let i = 0; i < 256; i++) sw_state.gammatable[i] = i;

    const inputPalette = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) inputPalette[i] = (i * 7) & 0xff;

    R_GammaCorrectAndSetPalette(inputPalette);

    for (let i = 0; i < 256; i++) {
      expect(sw_state.currentpalette[i * 4 + 0]).toBe(inputPalette[i * 4 + 0]);
      expect(sw_state.currentpalette[i * 4 + 1]).toBe(inputPalette[i * 4 + 1]);
      expect(sw_state.currentpalette[i * 4 + 2]).toBe(inputPalette[i * 4 + 2]);
    }
  });
});

describe("TransformVector / R_TransformFrustum", () => {
  beforeEach(() => {
    // an orthonormal (but non-identity) basis so the dot-product math is
    // actually exercised on all three axes, not just picking off components.
    VectorCopy(vec3(0, 1, 0), vright);
    VectorCopy(vec3(0, 0, 1), vup);
    VectorCopy(vec3(1, 0, 0), vpn);
    VectorCopy(vec3(5, -3, 2), modelorg);
  });

  test("TransformVector projects onto vright/vup/vpn via dot products", () => {
    const inV: Vec3 = vec3(2, 4, 6);
    const out: Vec3 = vec3();
    TransformVector(inV, out);

    expect(out[0]).toBeCloseTo(DotProduct(inV, vright), 5);
    expect(out[1]).toBeCloseTo(DotProduct(inV, vup), 5);
    expect(out[2]).toBeCloseTo(DotProduct(inV, vpn), 5);
    // with this particular basis, TransformVector is just an axis permutation
    expect(out[0]).toBeCloseTo(4, 5);
    expect(out[1]).toBeCloseTo(6, 5);
    expect(out[2]).toBeCloseTo(2, 5);
  });

  test("R_TransformFrustum rebuilds view_clipplanes from screenedge and the current basis", () => {
    // give each screenedge plane a known (pre-normalization-independent)
    // normal so the expected transform is easy to hand-compute.
    screenedge[0].normal[0] = 1;
    screenedge[0].normal[1] = 0;
    screenedge[0].normal[2] = 0;
    screenedge[1].normal[0] = 0;
    screenedge[1].normal[1] = 1;
    screenedge[1].normal[2] = 0;
    screenedge[2].normal[0] = 0;
    screenedge[2].normal[1] = 0;
    screenedge[2].normal[2] = 1;
    screenedge[3].normal[0] = 1;
    screenedge[3].normal[1] = 1;
    screenedge[3].normal[2] = 1;

    R_TransformFrustum();

    for (let i = 0; i < 4; i++) {
      // reproduce the C formula independently (not by calling the function
      // under test) as the expected value:
      //   v = (se.normal[2], -se.normal[0], se.normal[1])
      //   v2 = v[1]*vright + v[2]*vup + v[0]*vpn   (component-wise)
      const se = screenedge[i];
      const v: Vec3 = vec3(se.normal[2], -se.normal[0], se.normal[1]);
      const expected: Vec3 = vec3();
      for (let c = 0; c < 3; c++) {
        expected[c] = v[1] * vright[c] + v[2] * vup[c] + v[0] * vpn[c];
      }

      expect(view_clipplanes[i].normal[0]).toBeCloseTo(expected[0], 5);
      expect(view_clipplanes[i].normal[1]).toBeCloseTo(expected[1], 5);
      expect(view_clipplanes[i].normal[2]).toBeCloseTo(expected[2], 5);
      expect(view_clipplanes[i].dist).toBeCloseTo(DotProduct(modelorg, expected), 5);
    }
  });
});

describe("WritePCX / LoadPCX round trip", () => {
  test("encodes vid.buffer and decodes back to the same pixels and palette", () => {
    const width = 6;
    const height = 4;
    const rowbytes = width; // no padding, keeps the round trip byte-exact
    const data = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 3) & 0xff;

    const palette = new Uint8Array(768);
    for (let i = 0; i < 768; i++) palette[i] = (i * 5) & 0xff;

    const pcxBytes = WritePCX(data, width, height, rowbytes, palette);

    files.set("pics/roundtrip.pcx", pcxBytes);
    const decoded = LoadPCX("pics/roundtrip.pcx");

    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Array.from(decoded.pic ?? [])).toEqual(Array.from(data));
    expect(Array.from(decoded.palette ?? [])).toEqual(Array.from(palette));
  });

  test("round-trips a run that exercises the 0xC1-escape path (byte with top two bits set)", () => {
    const width = 3;
    const height = 1;
    // 0xC1 has its top two bits set, so WritePCX must escape it even
    // though it's a run of one.
    const data = new Uint8Array([0xc1, 0x05, 0xff]);
    const palette = new Uint8Array(768);

    const pcxBytes = WritePCX(data, width, height, width, palette);
    files.set("pics/escaped.pcx", pcxBytes);
    const decoded = LoadPCX("pics/escaped.pcx");

    expect(Array.from(decoded.pic ?? [])).toEqual([0xc1, 0x05, 0xff]);
  });
});

describe("R_SetSky", () => {
  test("stores name/rotate/axis", () => {
    const axis: Vec3 = vec3(0, 0, 1);
    R_SetSky("unit", 90, axis);

    expect(skyname).toBe("unit");
    expect(skyrotate).toBe(90);
    expect(Array.from(skyaxis)).toEqual([0, 0, 1]);
  });

  test("looks up all 6 side images by the env/<name><suffix>.pcx naming convention", () => {
    const requested: string[] = [];
    SetRefImports({
      ...makeFakeRi(),
      FS_LoadFile: (name: string) => {
        requested.push(name);
        return { length: -1, data: null };
      },
    });

    R_SetSky("unit", 0, vec3(0, 0, 1));

    for (const suf of ["rt", "bk", "lf", "ft", "up", "dn"]) {
      expect(requested).toContain(`env/unit${suf}.pcx`);
    }
  });
});

describe("R_RenderFrame orchestration", () => {
  test("RDF_NOWORLDMODEL frame completes without a world model", () => {
    const palette = new Uint8Array(768);
    files.set("pics/colormap.pcx", buildPcxBytes(2, 2, () => 1, palette));
    Draw_GetPalette();

    const fd = new RefdefT();
    fd.x = 0;
    fd.y = 0;
    fd.width = VID_WIDTH;
    fd.height = VID_HEIGHT;
    fd.fov_x = 90;
    fd.fov_y = 90;
    fd.rdflags = RDF_NOWORLDMODEL;

    expect(() => R_RenderFrame(fd)).not.toThrow();
    expect(r_refdef.vieworg[0]).toBe(fd.vieworg[0]);
  });
});
