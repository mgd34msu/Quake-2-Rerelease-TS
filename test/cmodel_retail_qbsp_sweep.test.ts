/*
Retail-gated sweep: every one of the 28 real "Call of the Machine" mgu*.bsp
maps shipped in baseq2/pak0.pak (12 QBSP extended-format, 16 classic IBSP --
verified directly against the retail pak's own header bytes; this port's own
format census, see .orch/followups.md) loaded through the REAL
src/qcommon/cmodel.ts CM_LoadMap, no synthetic fixture. Confirms the QBSP
dual-format collision loader (CMod_LoadSurfaces/.../CMod_LoadMaterials, the
ident dispatch in CM_LoadMap) handles every real retail map, both formats,
without a single load-rejection cap misfiring.

No copyrighted map data is committed anywhere -- pak0.pak is read directly
from the user's local retail install path at test-run time via this port's
own FS_LoadFile (basedir pointed at the retail root), matching every other
retail-gated test in this suite's "skip if the install isn't present"
convention.
*/

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { CM_LoadMap, CM_NumTexinfo, CM_TexinfoMaterial } from "../src/qcommon/cmodel";

const RETAIL_BASEDIR = "/home/buzzkill/q2rets/rerelease";
const PAK_PATH = `${RETAIL_BASEDIR}/baseq2/pak0.pak`;
const havePak = existsSync(PAK_PATH);

/** Minimal classic id PACK format reader -- see test/cl_demo_retail.test.ts's
 *  own identical function for the format/rationale. */
function listMguMaps(pakPath: string): string[] {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return [];
  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;
  const out: string[] = [];
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    if (/^maps\/mgu.*\.bsp$/.test(name)) out.push(name);
  }
  return out.sort();
}

const mguMaps = havePak ? listMguMaps(PAK_PATH) : [];

describe("cmodel.ts -- QBSP dual-format sweep over all 28 real retail mgu*.bsp maps (skipped if the retail install isn't present)", () => {
  beforeAll(() => {
    if (!havePak) return;
    Cvar_ForceSet("basedir", RETAIL_BASEDIR);
    FS_InitFilesystem();
  });

  test.skipIf(!havePak)("this port's own retail-data survey: exactly 28 maps/mgu*.bsp entries in pak0.pak", () => {
    expect(mguMaps.length).toBe(28);
  });

  test.skipIf(!havePak)(
    "all 28 mgu*.bsp maps load through CM_LoadMap with a nonzero checksum and at least one inline model",
    () => {
      const failures: string[] = [];
      for (const name of mguMaps) {
        try {
          const { checksum, model } = CM_LoadMap(name, false);
          if (checksum === 0) failures.push(`${name}: zero checksum`);
          if (!model) failures.push(`${name}: no model returned`);
          // every texinfo's material must be either empty or a valid path
          // string (CMod_LoadMaterials never leaves an invalid one behind)
          const numtex = CM_NumTexinfo();
          for (let i = 0; i < numtex; i++) {
            const m = CM_TexinfoMaterial(i);
            if (m !== "" && !/^[a-zA-Z0-9_-]+$/.test(m)) {
              failures.push(`${name}: texinfo ${i} has an invalid material string "${m}"`);
              break;
            }
          }
        } catch (err) {
          failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (failures.length > 0) {
        console.log("cmodel.ts retail mgu sweep failures:\n" + failures.join("\n"));
      }
      expect(failures).toEqual([]);
      expect(failures.length).toBe(0); // 28/28 through collision, matching the classic-repo reference unit's own measurement
    },
    120000,
  );
});
