// End-to-end check against REAL retail .jpg data, per the JPEG decoder
// unit's own brief ("survey the actual retail jpgs first ... if real jpg
// files exist, an e2e decode test against several of them"). This unit's
// own survey (see src/qcommon/jpg.ts's header comment and the task
// report) read every SOF marker byte out of all 198 .jpg files shipped in
// baseq2/pak0.pak directly: 100% are SOF0 baseline, 8-bit, 3-component,
// 184 of them 4:2:0 and 14 of them 4:4:4 (no 4:2:2 example exists in the
// shipped data, and none carry a DRI/restart-interval segment) -- this
// test decodes a representative sample of each subsampling group and
// checks the actual decoded pixels are plausible (non-zero variance, i.e.
// not a flat/garbage output), not just that decodeJPG returns `ok: true`.
//
// No retail content is read into this repository or committed anywhere:
// the PAK file is read directly from the user's local retail install path
// at test-run time (raw node:fs, the same hand-rolled minimal PACK-format
// directory parse test/cl_demo_retail.test.ts's own header comment
// documents -- NOT the engine's own FS_* module, to avoid mutating that
// shared singleton's search-path state for other test files sharing this
// process) and the extracted image bytes never touch disk. If the retail
// path isn't present (e.g. CI, or a machine without the retail install),
// every test in this file skips itself rather than failing.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { decodeJPG } from "../src/qcommon/jpg";

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";

/** Minimal classic id PACK format reader -- see
 *  test/cl_demo_retail.test.ts's own header/function comment for the full
 *  format description and why this deliberately isn't FS_LoadPackFile. */
function extractFromPak(pakPath: string, entryName: string): Uint8Array | null {
  const data = readFileSync(pakPath);
  const magic = data.toString("ascii", 0, 4);
  if (magic !== "PACK") return null;

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

function varianceOfRedChannel(pixels: Uint8Array, width: number, height: number): number {
  const n = width * height;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4]!;
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

const havePak = existsSync(PAK_PATH);

describe("decodeJPG -- real retail .jpg data (baseq2/pak0.pak's vault/ artwork, skipped if the retail install isn't present)", () => {
  // Exact dimensions/subsampling per this unit's own survey (see
  // src/qcommon/jpg.ts's header comment) -- asserted here too so a future
  // retail data change (or a survey mistake) fails loudly instead of this
  // test silently checking the wrong thing.
  const cases: { name: string; width: number; height: number }[] = [
    { name: "vault/preview/logo.jpg", width: 389, height: 512 }, // 4:2:0
    { name: "vault/preview/vault_makron.jpg", width: 910, height: 512 }, // 4:2:0
    { name: "vault/preview/item_railgun.jpg", width: 910, height: 512 }, // 4:2:0
    { name: "vault/preview/doc1.jpg", width: 408, height: 512 }, // 4:4:4
    { name: "vault/preview/texpaint.jpg", width: 671, height: 512 }, // 4:4:4
  ];

  for (const c of cases) {
    test.skipIf(!havePak)(
      `${c.name} decodes to ${c.width}x${c.height} with plausible (non-zero variance) pixel data`,
      () => {
        const bytes = extractFromPak(PAK_PATH, c.name);
        expect(bytes).not.toBeNull();

        const result = decodeJPG(bytes!);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.image.width).toBe(c.width);
        expect(result.image.height).toBe(c.height);
        expect(result.image.pixels.length).toBe(c.width * c.height * 4);

        // Every alpha byte is opaque (JPEG has no alpha channel).
        let allOpaque = true;
        for (let i = 3; i < result.image.pixels.length; i += 4) {
          if (result.image.pixels[i] !== 255) {
            allOpaque = false;
            break;
          }
        }
        expect(allOpaque).toBe(true);

        const variance = varianceOfRedChannel(result.image.pixels, result.image.width, result.image.height);
        expect(variance).toBeGreaterThan(0);
      },
      // bun:test's default 5000ms per-test timeout is tight for a real JPEG
      // decode (pak0.pak extraction + full baseline decode) once this runs
      // deep inside the full ~2800-test suite rather than standalone --
      // measured passing in ~2s standalone but timing out at 5000ms under
      // full-suite CPU contention (host scheduling/GC pressure from ~195
      // other test files, not from any shared-state leak: this file passes
      // cleanly in isolation every time). Generous fixed budget instead of
      // chasing a moving contention target.
      15000,
    );
  }

  test.skipIf(!havePak)(
    "all 198 shipped .jpg files decode successfully with non-zero pixel variance (full-set survey re-check)",
    () => {
      const data = readFileSync(PAK_PATH);
      const dirofs = data.readInt32LE(4);
      const dirlen = data.readInt32LE(8);
      const numEntries = dirlen / 64;
      const jpgEntries: { name: string; filepos: number; filelen: number }[] = [];
      for (let i = 0; i < numEntries; i++) {
        const entryOffset = dirofs + i * 64;
        const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
        const name = rawName.replace(/\0.*$/, "");
        if (!name.toLowerCase().endsWith(".jpg")) continue;
        jpgEntries.push({
          name,
          filepos: data.readInt32LE(entryOffset + 56),
          filelen: data.readInt32LE(entryOffset + 60),
        });
      }
      expect(jpgEntries.length).toBe(198); // matches this unit's own survey exactly

      let failed = 0;
      let zeroVariance = 0;
      for (const e of jpgEntries) {
        const bytes = new Uint8Array(data.subarray(e.filepos, e.filepos + e.filelen));
        const result = decodeJPG(bytes);
        if (!result.ok) {
          failed++;
          continue;
        }
        const variance = varianceOfRedChannel(result.image.pixels, result.image.width, result.image.height);
        if (variance === 0) zeroVariance++;
      }
      expect(failed).toBe(0);
      expect(zeroVariance).toBe(0);
    },
    // Decoding all 198 files (including several ~2000x2000 concept-art
    // originals) takes several seconds -- past bun:test's default 5000ms
    // per-test timeout.
    30000,
  );
});
