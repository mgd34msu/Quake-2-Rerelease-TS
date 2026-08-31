/*
End-to-end proof of the universal image-format resolution (both renderers,
src/qcommon/img_resolve.ts + gl_image.ts's GL_FindImage + r_image.ts's
R_FindImage) against REAL retail bytes, per Mike's ruling 2026-08-31
(.orch/followups.md:365-367, "support as many image formats for as many
things as possible").

Own pak scan (raw node:fs PACK reader, same minimal format/convention as
test/cl_precache_flare_retail.test.ts's own function -- never the engine's
FS_* module, so no shared search-path state is mutated for other test
files sharing this process) against RETAIL_BASEDIR/baseq2/pak0.pak found:

  - pics/conchars: ONLY a .png entry (6462 bytes), no .pcx sibling at all.
    Requesting "pics/conchars.pcx" (the classic, hardcoded-everywhere name
    -- see gl_draw.ts's Draw_InitLocal) must fall back to the .png.
  - sprites/s_bfg1_0: BOTH a .pcx (2815 bytes) and a .tga (11924 bytes)
    sibling -- a real dual-format sprite frame. Requesting the .pcx name
    with both present in the fake filesystem proves the exact match wins
    without scanning the alternates.
  - models/items/legacyhead/skin: BOTH a .pcx (20126 bytes) and a .png
    (14793 bytes) sibling -- a real dual-format skin (the "skins" image
    class named in this task's brief). Same exact-match proof, it_skin.

Skips loudly (never fails) if the retail install isn't present on this
machine, matching every other retail-gated test in this suite.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SetRefImports as GLSetRefImports, gltextures, ImageT as GLImageT, SetNumGltextures, gl_state, ImagetypeT as GLImagetypeT } from "../src/ref_gl/gl_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { SetQGL, GL_FindImage } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetRefImports as SoftSetRefImports, d_8to24table } from "../src/ref_soft/r_local";
import { ImagetypeT as SoftImagetypeT } from "../src/ref_soft/r_model";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

// pak0.pak is ~1.7GB -- readFileSync-ing it fresh per extraction (the
// pattern test/cl_precache_flare_retail.test.ts's own extractFromPak uses,
// fine there since it only extracts a handful of small entries once) is
// what pushed this file over bun:test's default 5000ms per-test timeout
// when a single test needs several entries. Read the whole buffer exactly
// once (module scope, only when the retail install is actually present)
// and slice every entry out of that same buffer instead.
const pakBuffer: Buffer | null = havePak ? readFileSync(PAK_PATH) : null;

interface PakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPakDirectory(data: Buffer): PakEntry[] {
  if (data.toString("ascii", 0, 4) !== "PACK") return [];
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;
  const entries: PakEntry[] = [];
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    entries.push({ name, filepos, filelen });
  }
  return entries;
}

// Directory parsed once and reused by every test below (still a single
// linear scan of the small 64-byte-per-entry directory, cheap either way).
const pakEntries: PakEntry[] = pakBuffer ? readPakDirectory(pakBuffer) : [];

function extractFromPak(entryName: string): Uint8Array | null {
  if (!pakBuffer) return null;
  const entry = pakEntries.find((e) => e.name === entryName);
  if (!entry) return null;
  return new Uint8Array(pakBuffer.subarray(entry.filepos, entry.filepos + entry.filelen));
}

describe("retail-data survey -- pics/conchars is PNG-only, sprites/s_bfg1_0 and legacyhead/skin are real dual-format assets (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("own pak scan confirms all three survey facts against the real pak0.pak", () => {
    const names = new Set(pakEntries.map((e) => e.name));

    expect(names.has("pics/conchars.png")).toBe(true);
    expect(names.has("pics/conchars.pcx")).toBe(false);
    expect(names.has("pics/conchars.tga")).toBe(false);
    expect(names.has("pics/conchars.jpg")).toBe(false);

    expect(names.has("sprites/s_bfg1_0.pcx")).toBe(true);
    expect(names.has("sprites/s_bfg1_0.tga")).toBe(true);

    expect(names.has("models/items/legacyhead/skin.pcx")).toBe(true);
    expect(names.has("models/items/legacyhead/skin.png")).toBe(true);
  });
});

function makeGLRi(files: Map<string, Uint8Array>, loadCalls: string[]): RefImports {
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
      loadCalls.push(name);
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => {},
    FS_Gamedir: () => "",
    Cvar_Get: () => new CvarT(),
    Cvar_Set: () => new CvarT(),
    Cvar_SetValue: () => {},
    Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

describe("gl_image.ts GL_FindImage -- real retail bytes (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("pics/conchars.pcx (no .pcx in the real pak) resolves via the .png fallback", () => {
    const pngBytes = extractFromPak("pics/conchars.png");
    expect(pngBytes).not.toBeNull();

    const files = new Map<string, Uint8Array>([["pics/conchars.png", pngBytes!]]);
    const loadCalls: string[] = [];
    GLSetRefImports(makeGLRi(files, loadCalls));
    SetQGL(new QGLRecording());
    for (let i = 0; i < gltextures.length; i++) gltextures[i] = new GLImageT();
    SetNumGltextures(0);
    gl_state.currenttextures[0] = 0;
    gl_state.currenttextures[1] = 0;
    gl_state.currenttmu = 0;

    const image = GL_FindImage("pics/conchars.pcx", GLImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/conchars.png");
    expect(image?.width).toBeGreaterThan(0);
    expect(image?.height).toBeGreaterThan(0);
    // resolution order (default r_texture_formats "png jpg tga",
    // images.c:2258): pcx (miss) -> png (hit). jpg/tga are never probed
    // once png succeeds.
    expect(loadCalls).toEqual(["pics/conchars.pcx", "pics/conchars.png"]);
  });

  test.skipIf(!havePak)("sprites/s_bfg1_0.pcx (real dual-format pcx+tga sprite frame) resolves the exact name, never scanning the .tga sibling", () => {
    const pcxBytes = extractFromPak("sprites/s_bfg1_0.pcx");
    const tgaBytes = extractFromPak("sprites/s_bfg1_0.tga");
    expect(pcxBytes).not.toBeNull();
    expect(tgaBytes).not.toBeNull();

    const files = new Map<string, Uint8Array>([
      ["sprites/s_bfg1_0.pcx", pcxBytes!],
      ["sprites/s_bfg1_0.tga", tgaBytes!],
    ]);
    const loadCalls: string[] = [];
    GLSetRefImports(makeGLRi(files, loadCalls));
    SetQGL(new QGLRecording());
    for (let i = 0; i < gltextures.length; i++) gltextures[i] = new GLImageT();
    SetNumGltextures(0);
    gl_state.currenttextures[0] = 0;
    gl_state.currenttextures[1] = 0;
    gl_state.currenttmu = 0;

    const image = GL_FindImage("sprites/s_bfg1_0.pcx", GLImagetypeT.it_sprite);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("sprites/s_bfg1_0.pcx");
    // exact-name hit: exactly one FS_LoadFile call, for the requested name
    // itself -- no alternate extension was ever probed.
    expect(loadCalls).toEqual(["sprites/s_bfg1_0.pcx"]);
  });
});

function makeSoftRi(files: Map<string, Uint8Array>, loadCalls: string[]): RefImports {
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
      loadCalls.push(name);
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => {},
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => {},
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// r_image.ts's r_images/numr_images module cache has no reset hook between
// tests (same rationale as test/r_image_png.test.ts's own R_FindImage
// describe block) -- each test below imports r_image.ts through its own
// private query-string instance to avoid cross-test cache pollution.
describe("r_image.ts R_FindImage -- real retail bytes, quantized to the 8-bit palette (skipped if the retail install isn't present)", () => {
  let isolationCounter = 0;

  test.skipIf(!havePak)("pics/conchars.pcx (no .pcx in the real pak) resolves via the .png fallback, quantized", async () => {
    isolationCounter++;
    const rImage: typeof import("../src/ref_soft/r_image") = await import("../src/ref_soft/r_image" + "?img_resolve_retail_isolation_" + isolationCounter);

    const pngBytes = extractFromPak("pics/conchars.png");
    expect(pngBytes).not.toBeNull();

    const files = new Map<string, Uint8Array>([["pics/conchars.png", pngBytes!]]);
    const loadCalls: string[] = [];
    SoftSetRefImports(makeSoftRi(files, loadCalls));
    d_8to24table.fill(0);

    const image = rImage.R_FindImage("pics/conchars.pcx", SoftImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/conchars.png");
    expect(image?.width).toBeGreaterThan(0);
    expect(image?.height).toBeGreaterThan(0);
    // every quantized texel is a valid palette index (0-255, always -- this
    // just proves the pipeline ran, not any specific color mapping).
    const px = image?.pixels[0];
    expect(px).toBeDefined();
    expect(px!.length).toBe((image?.width ?? 0) * (image?.height ?? 0));

    expect(loadCalls).toEqual(["pics/conchars.pcx", "pics/conchars.png"]);
  });

  test.skipIf(!havePak)("models/items/legacyhead/skin.pcx (real dual-format pcx+png skin) resolves the exact name, never scanning the .png sibling", async () => {
    isolationCounter++;
    const rImage: typeof import("../src/ref_soft/r_image") = await import("../src/ref_soft/r_image" + "?img_resolve_retail_isolation_" + isolationCounter);

    const pcxBytes = extractFromPak("models/items/legacyhead/skin.pcx");
    const pngBytes = extractFromPak("models/items/legacyhead/skin.png");
    expect(pcxBytes).not.toBeNull();
    expect(pngBytes).not.toBeNull();

    const files = new Map<string, Uint8Array>([
      ["models/items/legacyhead/skin.pcx", pcxBytes!],
      ["models/items/legacyhead/skin.png", pngBytes!],
    ]);
    const loadCalls: string[] = [];
    SoftSetRefImports(makeSoftRi(files, loadCalls));
    d_8to24table.fill(0);

    const image = rImage.R_FindImage("models/items/legacyhead/skin.pcx", SoftImagetypeT.it_skin);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("models/items/legacyhead/skin.pcx");
    // exact-name hit: exactly one FS_LoadFile call, for the requested name
    // itself -- no alternate extension was ever probed.
    expect(loadCalls).toEqual(["models/items/legacyhead/skin.pcx"]);
  });
});
