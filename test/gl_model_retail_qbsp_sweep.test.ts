/*
Retail-gated sweep: every one of the 28 real "Call of the Machine" mgu*.bsp
maps shipped in baseq2/pak0.pak (12 QBSP extended-format, 16 classic IBSP)
loaded through the REAL src/ref_gl/gl_model.ts Mod_ForName, no synthetic
fixture. Confirms the QBSP dual-format GL loader (Mod_LoadFacesExt/
Mod_LoadNodesExt/etc., the ident dispatch in Mod_ForName) handles every real
retail map.

Previously reported 15/28: 11 maps (mgu1m1/2m1/2m3/3m1/3m2/3m3/4m1/4m2/4m3/
5m1/5m2) blocked on "LM_UploadBlock() - MAX_LIGHTMAPS exceeded", and 2 more
(mgu6m2/mgu6m3) on "GL_Upload8: too large". Both fixed in gl_rsurf.ts/
gl_image.ts:

- The lightmap blocker: every one of the 11 failing maps carries a BSPX
  DECOUPLED_LM lump (verified against the real pak0.pak directory), which
  packs far more lightmap data per map than the fixed 128x128-texel atlas
  page this port's LM_UploadBlock/LM_AllocBlock (gl_rsurf.ts) hardcoded --
  overflowing the 128-page MAX_LIGHTMAPS budget. q2repro's LM_BeginBuilding
  (src/refresh/surf.c) sizes its atlas page per map instead -- 256x256
  normally, 1024x1024 for a DECOUPLED_LM map -- and gl_rsurf.ts's
  GL_BeginBuildingLightmaps now does the same (see BLOCK_WIDTH/BLOCK_HEIGHT's
  own comment there).
- The GL_Upload8 blocker: vanilla's `s > 512*256` check there guarded a fixed
  C stack buffer (`unsigned trans[512*256]`) this port never had (its `trans`
  is a dynamically-sized `Uint32Array(s)`) -- real Call of the Machine 8-bit
  texture data in mgu6m2.bsp/mgu6m3.bsp legitimately exceeds 512*256 texels
  and tripped this vestigial cap before GL_Upload32's own (already-correct)
  clamp-and-resample-to-256 ever got to run. See GL_Upload8's own comment in
  gl_image.ts for the full citation.

Now 28/28.

No copyrighted map data is committed anywhere -- pak0.pak is read directly
from the user's local retail install via FS_LoadFile served through this
port's own fake RefImports.FS_LoadFile (raw node:fs PACK extraction, no
change to the real engine's search-path state), matching every other
retail-gated test's "skip if the install isn't present" convention.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { RefImports } from "../src/client/ref";
import { SetRefImports, SetNoTexture, ImageT, r_worldmodel } from "../src/ref_gl/gl_local";
import { SetQGL } from "../src/ref_gl/gl_image";
import { QGLRecording } from "../src/ref_gl/qgl";
import { Mod_Init, R_BeginRegistration, R_EndRegistration } from "../src/ref_gl/gl_model";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

interface PakEntry {
  name: string;
  filepos: number;
  filelen: number;
}

function readPakDirectory(pakPath: string): { data: Buffer; entries: PakEntry[] } {
  const data = readFileSync(pakPath);
  const entries: PakEntry[] = [];
  if (data.toString("ascii", 0, 4) === "PACK") {
    const dirofs = data.readInt32LE(4);
    const dirlen = data.readInt32LE(8);
    const numEntries = dirlen / 64;
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = dirofs + i * 64;
      const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
      const name = rawName.replace(/\0.*$/, "");
      const filepos = data.readInt32LE(entryOffset + 56);
      const filelen = data.readInt32LE(entryOffset + 60);
      entries.push({ name, filepos, filelen });
    }
  }
  return { data, entries };
}

const pak = havePak ? readPakDirectory(PAK_PATH) : null;
const mguMaps = pak ? pak.entries.filter((e) => /^maps\/mgu.*\.bsp$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name)) : [];

function makeFakeRi(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand: () => undefined,
    Cmd_RemoveCommand: () => undefined,
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => undefined,
    Con_Printf: () => undefined,
    FS_LoadFile: (name: string) => {
      if (!pak) return { length: -1, data: null };
      const entry = pak.entries.find((e) => e.name === name);
      if (!entry) return { length: -1, data: null };
      const bytes = new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen);
      return { length: bytes.length, data: bytes };
    },
    FS_FreeFile: () => undefined,
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => undefined,
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
  };
}

describe("gl_model.ts -- QBSP dual-format sweep over all 28 real retail mgu*.bsp maps (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)(
    "all 28 mgu*.bsp maps: report pass/fail through Mod_ForName (real retail data, GL loader)",
    () => {
      SetRefImports(makeFakeRi());
      const fakeTex = new ImageT();
      fakeTex.width = 64;
      fakeTex.height = 64;
      SetNoTexture(fakeTex);
      SetQGL(new QGLRecording());

      Mod_Init();

      const results: { name: string; ok: boolean; reason?: string }[] = [];
      for (const entry of mguMaps) {
        // R_BeginRegistration/R_EndRegistration is the REAL production entry
        // point a map change goes through (cl_main.ts's CL_PrepRefresh calls
        // it once per level) -- it increments registration_sequence, frees
        // the previous world model if the name changed, and (via
        // R_EndRegistration -> GL_FreeUnusedImages) frees every texture the
        // new map didn't touch. A bare, repeated Mod_ForName across many
        // maps in one process (this sweep's first draft) never frees
        // textures at all and hits MAX_GLTEXTURES by map ~9 -- an artifact
        // of skipping this real per-map registration cycle, not a defect in
        // the QBSP loader itself.
        const bareName = entry.name.replace(/^maps\//, "").replace(/\.bsp$/, "");
        try {
          R_BeginRegistration(bareName);
          R_EndRegistration();
          results.push({ name: entry.name, ok: r_worldmodel !== null && r_worldmodel.numsurfaces > 0 });
        } catch (err) {
          results.push({ name: entry.name, ok: false, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      const passing = results.filter((r) => r.ok);
      const failing = results.filter((r) => !r.ok);
      console.log(`gl_model.ts retail mgu sweep: ${passing.length}/${results.length} loaded through R_BeginRegistration`);
      if (failing.length > 0) {
        console.log(failing.map((f) => `  ${f.name}: ${f.reason ?? "no surfaces"}`).join("\n"));
      }
      expect(results.length).toBe(28);
      // every failure must be a real, attributable error message, never a
      // silent "returned null with no reason" -- a genuine capacity/format
      // blocker gets ledgered by name below, not swept under a bare boolean.
      for (const f of failing) expect(f.reason).toBeDefined();
      // all 28 real retail mgu*.bsp maps load cleanly (see this file's
      // header comment for the 13 that used to fail and why they're fixed).
      expect(passing.length).toBe(28);
    },
    180000,
  );
});
