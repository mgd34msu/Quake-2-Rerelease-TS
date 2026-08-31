/*
End-to-end check against REAL retail data for Mike's console report:
"Downloading pics/sprites/flare_01.tga.pcx / Server does not have this
file" during a barrel explosion (.orch/followups.md finding 3(a)/8).

ROOT CAUSE (see cl_main.ts's CL_RequestNextDownload CS_IMAGES phase and
cl_parse.ts's CL_RegisterImage, both fixed by this same task): a
misc_flare entity's `image` spawn key (kexgame/g_misc.ts's SP_misc_flare)
is written straight through to gi.imageindex(), landing a full path WITH
its own extension -- "sprites/flare_01.tga" -- in a CS_IMAGES configstring.
Both the download-precache walk and the render-side image registration
treated every CS_IMAGES entry as a bare name needing "pics/<name>.pcx"
appended, unconditionally -- producing "pics/sprites/flare_01.tga.pcx" on
both sides. That name can never resolve (locally or over the wire), so the
walk queued a doomed UDP download every time it ran.

RETAIL-DATA CORRECTION (an earlier pass of this same investigation checked
the WRONG pak0.pak -- .orch's baseq2/pak0.pak, a small ~103MB mod-merged
directory, not the real rerelease install -- and concluded these sprite
frames don't exist anywhere in Mike's data. That conclusion was wrong,
caught only by checking the actual retail path this repo's OTHER
retail-gated tests already use (test/jpg_retail.test.ts,
test/cmodel_retail_qbsp_sweep.test.ts): RETAIL_BASEDIR/baseq2/pak0.pak,
1.7GB, the real Steam rerelease install. sprites/flare_01.tga through
flare_04.tga are real, present, non-trivial-sized (16428/16428/16428/65580
bytes) TGA files in that pak -- confirmed with a standalone hand-rolled
PACK reader below, the same convention test/cl_demo_retail.test.ts and
test/jpg_retail.test.ts already use (raw node:fs, never the engine's own
FS_* module, so no shared search-path state is mutated for other test
files sharing this process). There is no sprites/flare*.sp2 container --
these are meant to be loaded directly as standalone images, matching
q2repro's CL_RegisterImage dispatch (src/client/precache.c:401-417):
"sprites/psx_flare*" and other "sprites/*" names go straight to an image
loader, never through an .sp2 model parse.

This file proves two things against the real bytes:
  1. the four flare frames genuinely exist in the retail data (documents
     the survey; skips loudly if the retail install isn't present on this
     machine, matching every other retail-gated test in this suite);
  2. this port's own LoadTGA (src/ref_gl/gl_image.ts) decodes the REAL
     sprites/flare_01.tga bytes without error, into plausible non-flat
     RGBA pixel data -- proving the render-side half of the fix
     (cl_parse.ts's CL_RegisterImage routing this name to RegisterSkin's
     GL_FindImage(name, it_skin), no "pics/" prefix, no forced ".pcx") can
     actually load this real asset once resolved by name correctly.

The download-side fix's exact name-building/skip decisions are pinned
separately (and cheaply, no retail data needed) by test/cl_precache.test.ts's
own "rerelease/extended family" describe block.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { SetRefImports, gltextures, ImageT, SetNumGltextures, gl_state } from "../src/ref_gl/gl_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { SetQGL, LoadTGA } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

/** Minimal classic id PACK format reader -- see test/cl_demo_retail.test.ts's
 *  own identical function for the format/rationale. */
function extractFromPak(pakPath: string, entryName: string): Uint8Array | null {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return null;

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;

  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    if (name !== entryName) continue;

    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    return new Uint8Array(data.subarray(filepos, filepos + filelen));
  }
  return null;
}

const FLARE_FRAMES = [
  { name: "sprites/flare_01.tga", expectedLen: 16428 },
  { name: "sprites/flare_02.tga", expectedLen: 16428 },
  { name: "sprites/flare_03.tga", expectedLen: 16428 },
  { name: "sprites/flare_04.tga", expectedLen: 65580 },
];

describe("retail-data survey -- sprites/flare_NN.tga in the real rerelease pak0.pak (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("all four flare frame files exist with their surveyed sizes, no *.sp2 container", () => {
    for (const { name, expectedLen } of FLARE_FRAMES) {
      const bytes = extractFromPak(PAK_PATH, name);
      expect(bytes).not.toBeNull();
      expect(bytes!.length).toBe(expectedLen);
    }
    // confirms misc_flare's image name refers to a raw texture file, not a
    // sprite-model container -- q2repro's own CL_RegisterImage dispatches
    // "sprites/*" straight to an image loader for exactly this reason.
    expect(extractFromPak(PAK_PATH, "sprites/flare.sp2")).toBeNull();
    expect(extractFromPak(PAK_PATH, "sprites/flare_01.sp2")).toBeNull();
  });
});

describe("gl_image.ts LoadTGA -- decodes the REAL retail sprites/flare_01.tga bytes (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("decodes without error into plausible (non-flat, correctly sized) RGBA pixels", () => {
    const realBytes = extractFromPak(PAK_PATH, "sprites/flare_01.tga");
    expect(realBytes).not.toBeNull();

    const files = new Map<string, Uint8Array>([["sprites/flare_01.tga", realBytes!]]);
    const ri: RefImports = {
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
      FS_Gamedir: () => "",
      Cvar_Get: () => new CvarT(),
      Cvar_Set: () => new CvarT(),
      Cvar_SetValue: () => {},
      Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
      Vid_MenuInit: () => {},
      Vid_NewWindow: () => {},
    };
    SetRefImports(ri);
    SetQGL(new QGLRecording());
    for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
    SetNumGltextures(0);
    gl_state.currenttextures[0] = 0;
    gl_state.currenttextures[1] = 0;
    gl_state.currenttmu = 0;

    const { pic, width, height } = LoadTGA("sprites/flare_01.tga");

    expect(pic).not.toBeNull();
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(pic!.length).toBe(width * height * 4);

    // not a flat/garbage decode -- a real flare glow texture has visible
    // brightness variance across its pixels (this is the exact same
    // "plausible, not just non-null" bar test/jpg_retail.test.ts's own
    // varianceOfRedChannel helper applies to its retail samples).
    let sum = 0;
    let sumSq = 0;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const r = pic![i * 4]!;
      sum += r;
      sumSq += r * r;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(variance).toBeGreaterThan(0);
  });
});
