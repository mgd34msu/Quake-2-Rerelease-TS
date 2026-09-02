/*
Sweeps every MD5 skeletal model shipped in the real retail re-release data
(~/q2rets/rerelease/baseq2/pak0.pak, id PACK format) and checks, per
mesh, straight from src/qcommon/md5_model.ts's own parser
(parseMd5Mesh): tcoords count matches vertex count, every triangle index
is in range for that mesh's vertex count, every tcoord is finite, and
every tcoord lies within the [0,1] range a normalized skin UV should use
(so it maps correctly onto its md5/ skin at whatever resolution that skin
happens to be). Also checks that every md5/ skin name this port would
derive from the sibling tris.md2's own skin list actually exists in the
pak.

Follows md5_model_retail.test.ts's own house conventions: real pak bytes
read with plain node:fs (this port has no shared PAK reader to import,
see that file's own header comment), describe.skipIf(!havePak) so this
skips cleanly -- not fails -- on a machine without the retail install,
and self-sufficient per rule 13 (reads its own retail data, no dependency
on any other test having run first).

Models are enumerated straight from the pak directory by matching any
path ending in "md5/tris.md5mesh" -- not a hardcoded list -- so a new
md5 model dropped into the pak is swept automatically; nothing can slip
past this check by simply not being named. Matching is done without
requiring a "models/" prefix so it also covers the 3 real
"players/<name>/md5/tris.md5mesh" entries (players/cyborg,
players/female, players/male): 138 total in the real pak0.pak, all
under either "models/" or "players/".

IMPORTANT MEASURED FINDING (see the KNOWN_OUT_OF_RANGE_TEXCOORDS table
below): the premise that every MD5 model's tcoords are already
normalized to [0,1] does NOT hold for all 138 real models. Direct
measurement against the real parsed data found 8 real, shipping
.md5mesh files whose "vert" tcoords go outside [0,1] -- 7 view-weapon
models (v_beamer, v_blast, v_chain, v_etf_rifle, v_hyperb, v_shotg) plus
one monster (float) and the default player model (players/male), with s
values as low as -1.06 (v_etf_rifle) and as high as 1.89 (players/male).
These are not a parser bug (index bounds and tcoords-count-matches-verts
both still hold for these meshes, and the values are stable/deterministic
across runs) -- they read as legitimate wrap/atlas-style UVs baked into
those specific models' skins. Rather than silently widening the global
[0,1] tolerance (which would let a genuinely-broken *new* model's tcoords
slip through unnoticed on any other model), this test keeps the tight
[0,1]+EPS check as the default for every model and only relaxes it, per
model, to that model's own measured min/max (widened by a small margin)
for these 8 named exceptions -- a real regression guard on exactly these
known models, not a blanket loosening.
*/

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseMd5Mesh } from "../src/qcommon/md5_model";

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

// Quake PACK directory lookups are case-insensitive on disk (the real
// engine's filesystem layer treats them that way); one real entry in this
// pak is spelled "models/objects/grenade4/tris.MD2" (uppercase extension)
// while its md5mesh sibling and every other tris.md2 in the pak use the
// lowercase spelling, so an exact-case lookup would silently drop that
// model's md2/skin data. Case-insensitive matching is required to see it.
function findEntry(name: string): PakEntry | undefined {
  if (!pak) return undefined;
  const lower = name.toLowerCase();
  return pak.entries.find((e) => e.name.toLowerCase() === lower);
}

function readEntryText(entry: PakEntry): string {
  if (!pak) throw new Error("pak not loaded");
  return new TextDecoder().decode(new Uint8Array(pak.data.buffer, pak.data.byteOffset + entry.filepos, entry.filelen));
}

// dmdl_t (little-endian int32 fields) -- only the two header fields this
// test needs: num_skins at byte offset 20, ofs_skins at byte offset 44.
// Each skin name is a 64-byte NUL-padded string starting at
// entry.filepos + ofs_skins + i * 64.
function readMd2SkinNames(entry: PakEntry): string[] {
  if (!pak) throw new Error("pak not loaded");
  const numSkins = pak.data.readInt32LE(entry.filepos + 20);
  const ofsSkins = pak.data.readInt32LE(entry.filepos + 44);
  const names: string[] = [];
  for (let i = 0; i < numSkins; i++) {
    const skinOffset = entry.filepos + ofsSkins + i * 64;
    const raw = pak.data.toString("ascii", skinOffset, skinOffset + 64);
    names.push(raw.replace(/\0.*$/, ""));
  }
  return names;
}

const SKIN_EXTENSIONS = ["pcx", "png", "tga", "jpg", "jpeg", "bmp", "gif"];

// Derives every candidate md5/ skin path for one of a tris.md2's own skin
// names: split off the directory and basename, then look for
// "<dir>/md5/<basename-stem>.<ext>" for each of the extensions above (the
// md5 skin's own extension need not match the md2 skin's -- e.g. a ".pcx"
// md2 skin commonly pairs with a ".png" md5 skin in the real data).
function md5SkinCandidates(md2SkinName: string): string[] {
  const slash = md2SkinName.lastIndexOf("/");
  const dir = slash >= 0 ? md2SkinName.slice(0, slash) : "";
  const base = slash >= 0 ? md2SkinName.slice(slash + 1) : md2SkinName;
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return SKIN_EXTENSIONS.map((ext) => `${dir}/md5/${stem}.${ext}`);
}

interface TexcoordBounds {
  minS: number;
  maxS: number;
  minT: number;
  maxT: number;
}

// Measured (not guessed) real min/max s/t per model, widened by a small
// margin -- see the file header comment for why these 8 models are
// exempted from the default [0,1]+EPS check instead of loosening it
// globally.
const KNOWN_OUT_OF_RANGE_TEXCOORDS: ReadonlyMap<string, TexcoordBounds> = new Map([
  ["models/monsters/float/md5/tris.md5mesh", { minS: -0.01, maxS: 1.7, minT: -0.12, maxT: 1.0 }],
  ["models/weapons/v_beamer/md5/tris.md5mesh", { minS: -0.6, maxS: 1.0, minT: -0.01, maxT: 1.0 }],
  ["models/weapons/v_blast/md5/tris.md5mesh", { minS: -0.16, maxS: 1.0, minT: -0.02, maxT: 1.0 }],
  ["models/weapons/v_chain/md5/tris.md5mesh", { minS: -0.05, maxS: 1.0, minT: -0.04, maxT: 1.0 }],
  ["models/weapons/v_etf_rifle/md5/tris.md5mesh", { minS: -1.1, maxS: 1.0, minT: -0.01, maxT: 1.0 }],
  ["models/weapons/v_hyperb/md5/tris.md5mesh", { minS: -0.24, maxS: 1.0, minT: -0.01, maxT: 1.0 }],
  ["models/weapons/v_shotg/md5/tris.md5mesh", { minS: -0.01, maxS: 1.86, minT: -0.01, maxT: 1.0 }],
  ["players/male/md5/tris.md5mesh", { minS: -0.01, maxS: 1.9, minT: -0.01, maxT: 1.0 }],
]);

const EPS = 1e-4;

describe("md5 texcoords/indices/skin-resolution sweep across every shipping MD5 skeletal model (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)(
    "every md5mesh in the pak: tcoords count matches vertex count, every triangle index is in range, every tcoord is finite and normalized (per-model bounds for the 8 known real exceptions -- see file header)",
    () => {
      if (!pak) throw new Error("pak not loaded");

      // enumerated straight from the pak directory, not a hardcoded list.
      const md5meshEntries = pak.entries.filter((e) => /\/md5\/tris\.md5mesh$/.test(e.name));
      expect(md5meshEntries.length).toBeGreaterThan(100);

      let totalMeshesChecked = 0;
      let totalTcoordsChecked = 0;
      let globalMinS = Infinity;
      let globalMaxS = -Infinity;
      let globalMinT = Infinity;
      let globalMaxT = -Infinity;

      for (const entry of md5meshEntries) {
        const model = parseMd5Mesh(readEntryText(entry), entry.name);
        const bounds = KNOWN_OUT_OF_RANGE_TEXCOORDS.get(entry.name);

        for (const mesh of model.meshes) {
          totalMeshesChecked++;

          expect(mesh.tcoords.length).toBe(mesh.numVerts);

          for (const idx of mesh.indices) {
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(mesh.numVerts);
          }

          for (const tc of mesh.tcoords) {
            totalTcoordsChecked++;
            expect(Number.isFinite(tc.s)).toBe(true);
            expect(Number.isFinite(tc.t)).toBe(true);

            if (tc.s < globalMinS) globalMinS = tc.s;
            if (tc.s > globalMaxS) globalMaxS = tc.s;
            if (tc.t < globalMinT) globalMinT = tc.t;
            if (tc.t > globalMaxT) globalMaxT = tc.t;

            if (bounds) {
              expect(tc.s).toBeGreaterThanOrEqual(bounds.minS);
              expect(tc.s).toBeLessThanOrEqual(bounds.maxS);
              expect(tc.t).toBeGreaterThanOrEqual(bounds.minT);
              expect(tc.t).toBeLessThanOrEqual(bounds.maxT);
            } else {
              expect(tc.s).toBeGreaterThanOrEqual(-EPS);
              expect(tc.s).toBeLessThanOrEqual(1 + EPS);
              expect(tc.t).toBeGreaterThanOrEqual(-EPS);
              expect(tc.t).toBeLessThanOrEqual(1 + EPS);
            }
          }
        }
      }

      // aggregate guard: an enumeration bug that finds zero models cannot
      // make this test pass vacuously.
      expect(totalMeshesChecked).toBeGreaterThan(100);

      console.log(
        `md5 texcoord sweep: ${totalMeshesChecked} meshes checked, ${totalTcoordsChecked} tcoords checked, ` +
          `global s=[${globalMinS}, ${globalMaxS}], global t=[${globalMinT}, ${globalMaxT}]`,
      );
    },
  );

  test.skipIf(!havePak)("every md5 skin name derived from the sibling tris.md2's skin list resolves to a real file in the pak", () => {
    if (!pak) throw new Error("pak not loaded");

    const md5meshEntries = pak.entries.filter((e) => /\/md5\/tris\.md5mesh$/.test(e.name));
    expect(md5meshEntries.length).toBeGreaterThan(100);

    let totalSkinNames = 0;
    let resolvedSkinNames = 0;
    const missing: string[] = [];

    for (const entry of md5meshEntries) {
      const dir = entry.name.replace(/\/md5\/tris\.md5mesh$/, "");
      const md2Name = `${dir}/tris.md2`;
      const md2Entry = findEntry(md2Name);
      if (!md2Entry) continue; // no sibling md2 for this md5mesh -- nothing to resolve

      for (const skinName of readMd2SkinNames(md2Entry)) {
        totalSkinNames++;
        const found = md5SkinCandidates(skinName).some((cand) => findEntry(cand) !== undefined);
        if (found) resolvedSkinNames++;
        else missing.push(`${skinName} (from ${md2Name})`);
      }
    }

    console.log(`md5 skin resolution: ${resolvedSkinNames}/${totalSkinNames} resolved, ${missing.length} missing`);
    if (missing.length > 0) console.log("missing md5 skins:", missing);

    expect(totalSkinNames).toBeGreaterThan(0);
    expect(missing.length).toBe(0);
  });

  test.skipIf(havePak)("SKIPPED: retail data not found -- set up ~/q2rets/rerelease/baseq2/pak0.pak to run this sweep", () => {
    expect(havePak).toBe(false);
  });
});
