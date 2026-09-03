/*
R_ApplyLogicalSize (src/ref_soft/r_image.ts): the software renderer's half of
rule 25. A replacement that loaded at another size than the shipped asset is
point-resampled to the shipped size, and a wall with only mip 0 gets its
chain built, so Draw_Pic, the kfont region draw and r_surf.ts never see a
size the original did not have.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { SetRefImports } from "../src/ref_soft/r_local";
import { ImageT, ImagetypeT } from "../src/ref_soft/r_model";
import { R_ApplyLogicalSize } from "../src/ref_soft/r_image";
import { CvarT } from "../src/shared/q_shared";

let shipped: Map<string, Uint8Array>;

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width, false);
  v.setUint32(20, height, false);
  return b;
}

function makeFakeRi(): RefImports {
  const cvar = (name: string, value: string): CvarT => {
    const c = new CvarT();
    c.name = name;
    c.string = value;
    c.value = parseFloat(value) || 0;
    return c;
  };
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
    FS_LoadFile: () => ({ length: -1, data: null }),
    FS_FreeFile: () => {},
    FS_LoadShippedFile: (name: string, maxBytes: number) => {
      const data = shipped.get(name);
      return data ? data.subarray(0, maxBytes) : null;
    },
    FS_Gamedir: () => "",
    Cvar_Get: cvar,
    Cvar_Set: cvar,
    Cvar_SetValue: () => {},
    Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// 8x8 of 4x4 blocks: block (bx,by) holds index 10*by + bx.
function blocks8(): Uint8Array {
  const px = new Uint8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[y * 8 + x] = 10 * (y >> 2) + (x >> 2);
  return px;
}

const CANDIDATES = ["png", "jpg", "tga", "jpeg", "bmp", "gif", "pcx"] as const; // a pic request's chain
const WALL_CANDIDATES = ["wal", "png", "jpg", "tga", "jpeg", "bmp", "gif"] as const; // a wall request's chain

beforeEach(() => {
  shipped = new Map();
  SetRefImports(makeFakeRi());
});

describe("R_ApplyLogicalSize", () => {
  test("a 4x drop-in pic is resampled back to the shipped size", () => {
    shipped.set("pics/ch1.png", pngHeader(2, 2));
    const image = new ImageT();
    image.type = ImagetypeT.it_pic;
    image.width = 8;
    image.height = 8;
    image.pixels[0] = blocks8();

    R_ApplyLogicalSize(image, "pics/ch1.png", "png", "png", CANDIDATES);

    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(Array.from(image.pixels[0]!)).toEqual([0, 1, 10, 11]);
  });

  test("a wall that arrived with one mip gets its chain built at the shipped size", () => {
    shipped.set("textures/e1u1/floor.wal", (() => {
      const b = new Uint8Array(100);
      const v = new DataView(b.buffer);
      v.setUint32(32, 4, true);
      v.setUint32(36, 4, true);
      return b;
    })());
    const image = new ImageT();
    image.type = ImagetypeT.it_wall;
    image.width = 8;
    image.height = 8;
    image.pixels[0] = blocks8();

    R_ApplyLogicalSize(image, "textures/e1u1/floor.wal", "wal", "png", WALL_CANDIDATES);

    expect(image.width).toBe(4);
    expect(image.pixels[0]!.length).toBe(16);
    expect(image.pixels[1]!.length).toBe(4);
    expect(image.pixels[2]!.length).toBe(1);
    expect(image.pixels[3]!.length).toBe(1);
  });

  test("with no shipped copy the loaded size stands", () => {
    const image = new ImageT();
    image.type = ImagetypeT.it_pic;
    image.width = 8;
    image.height = 8;
    image.pixels[0] = blocks8();

    R_ApplyLogicalSize(image, "pics/mine.png", "png", "png", CANDIDATES);

    expect(image.width).toBe(8);
    expect(image.pixels[0]!.length).toBe(64);
  });
});
