/*
Retail-gated sweep: every one of the 28 real "Call of the Machine" mgu*.bsp
maps shipped in baseq2/pak0.pak (12 QBSP extended-format, 16 classic IBSP)
loaded through the REAL src/ref_soft/r_model.ts R_BeginRegistration (the real
per-map registration entry point -- see test/gl_model_retail_qbsp_sweep.test.ts's
identical rationale for why this, not a bare repeated Mod_ForName). Confirms
the QBSP dual-format software-renderer loader (Mod_LoadFacesExt/
Mod_LoadNodesExt/etc., the ident dispatch, the format-aware
PrescanClassicSurfaceExtents/BSPX numfaces computation) handles every real
retail map.

Previously reported 26/28, with maps/mgu4m2.bsp and maps/mguhub.bsp blocked
on "InitSkyBox: map overflow" -- r_rast.ts's R_InitSkyBox carried a vestigial
whole-map rejection copied verbatim from vanilla's MAX_MAP_FACES/VERTS/EDGES
check (see R_InitSkyBox's own comment for the full citation: that check
guarded a fixed Hunk-allocated buffer in vanilla C that this port's growable
loadmodel.{surfaces,vertexes,edges} arrays never had). Both maps' real lump
counts (mgu4m2.bsp: 78458 verts/72903 faces/152341 edges; mguhub.bsp: 79538/
72159/153281) legitimately exceed the classic 65536/65536/128000 constants --
exactly the QBSP-extended-format headroom qcommon/qfiles.ts's header comment
describes -- and already loaded through every other stage of this same
loader. Fixed by dropping the check (not growing it to a new numeric bound);
now 28/28.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { RefImports } from "../src/client/ref";
import { SetRefImports, r_worldmodel } from "../src/ref_soft/r_local";
import { Mod_Init, R_BeginRegistration, R_EndRegistration } from "../src/ref_soft/r_model";

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

describe("r_model.ts -- QBSP dual-format sweep over all 28 real retail mgu*.bsp maps (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)(
    "all 28 mgu*.bsp maps: report pass/fail through R_BeginRegistration (real retail data, software loader)",
    () => {
      SetRefImports(makeFakeRi());
      Mod_Init();

      const results: { name: string; ok: boolean; reason?: string }[] = [];
      for (const entry of mguMaps) {
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
      console.log(`r_model.ts retail mgu sweep: ${passing.length}/${results.length} loaded through R_BeginRegistration`);
      if (failing.length > 0) {
        console.log(failing.map((f) => `  ${f.name}: ${f.reason ?? "no surfaces"}`).join("\n"));
      }
      expect(results.length).toBe(28);
      // every failure must be a real, attributable error message, never a
      // silent "returned null with no reason" -- checked before the hard
      // 28/28 assertion below so a future regression's failing map(s) are
      // named in the console output even though the pass-count assertion
      // also fails.
      for (const f of failing) expect(f.reason).toBeDefined();
      // all 28 real retail mgu*.bsp maps load cleanly (see this file's
      // header comment for the two that used to fail and why they're fixed).
      expect(passing.length).toBe(28);
    },
    180000,
  );
});
