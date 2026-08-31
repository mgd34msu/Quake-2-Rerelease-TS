// Retail-gated check for src/qcommon/bnvib.ts's .bnvib parser, run against
// all 53 real tactile/*.bnvib files baseq2/pak0.pak actually ships (per the
// task brief's survey: 22 under tactile/weapons/ including
// tactile/weapons/grapple/grfire.bnvib, plus 30 under tactile/players/
// {cyborg,female,male}/ -- 3 models x 10 filenames each). Skips itself if
// the retail install isn't present, same as test/cl_demo_retail.test.ts.
//
// No retail content is read into this repository or committed anywhere:
// the PAK file is read directly from the user's local retail install path
// at test-run time via the same hand-rolled minimal PACK-format directory
// parse test/cl_demo_retail.test.ts uses (raw node:fs, NOT this engine's
// own FS_* module -- see that file's header comment for why), and the
// extracted bytes never touch disk.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseBnvib } from "../src/qcommon/bnvib";

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";

interface PackEntryT {
  name: string;
  filepos: number;
  filelen: number;
}

/** Minimal classic id PACK format reader -- see test/cl_demo_retail.test.ts's
 *  identical function for the full rationale (deliberately not this
 *  engine's own FS_LoadPackFile/FS_AddGameDirectory). */
function readPackDirectory(pakPath: string): { data: Buffer; entries: PackEntryT[] } | null {
  const data = readFileSync(pakPath);
  if (data.toString("ascii", 0, 4) !== "PACK") return null;

  const dirofs = data.readInt32LE(4);
  const dirlen = data.readInt32LE(8);
  const numEntries = dirlen / 64;

  const entries: PackEntryT[] = [];
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = dirofs + i * 64;
    const rawName = data.toString("ascii", entryOffset, entryOffset + 56);
    const name = rawName.replace(/\0.*$/, "");
    const filepos = data.readInt32LE(entryOffset + 56);
    const filelen = data.readInt32LE(entryOffset + 60);
    entries.push({ name, filepos, filelen });
  }
  return { data, entries };
}

const havePak = existsSync(PAK_PATH);

describe("parseBnvib -- all 53 real tactile/*.bnvib files from baseq2/pak0.pak (skipped if the retail install isn't present)", () => {
  test.skipIf(!havePak)("every shipped .bnvib parses, and the retail set matches this unit's own survey exactly", () => {
    const pack = readPackDirectory(PAK_PATH);
    expect(pack).not.toBeNull();
    if (!pack) return;

    const bnvibEntries = pack.entries.filter((e) => e.name.toLowerCase().endsWith(".bnvib"));
    // Exact count from this task's own extraction pass -- if this ever
    // changes, the retail install changed and the survey above needs
    // redoing, not a silent skip.
    expect(bnvibEntries.length).toBe(53);

    let weaponsCount = 0;
    let playersCount = 0;
    const perModelCount: Record<string, number> = { cyborg: 0, female: 0, male: 0 };

    for (const entry of bnvibEntries) {
      const bytes = new Uint8Array(pack.data.subarray(entry.filepos, entry.filepos + entry.filelen));
      const result = parseBnvib(bytes);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      // Every retail file uses the "raw" (metadataSize 0x04) variant --
      // none of the 53 shipped files loop.
      expect(result.pattern.loop).toBeUndefined();
      expect(result.pattern.sampleRateHz).toBe(200);
      expect(result.pattern.samples.length).toBe((entry.filelen - 12) / 4);
      expect(result.pattern.samples.length).toBeGreaterThan(0);

      if (entry.name.startsWith("tactile/weapons/")) weaponsCount++;
      if (entry.name.startsWith("tactile/players/")) {
        playersCount++;
        for (const model of ["cyborg", "female", "male"]) {
          if (entry.name.startsWith(`tactile/players/${model}/`)) perModelCount[model]++;
        }
      }
    }

    expect(weaponsCount).toBe(23); // 22 weapon cues + tactile/weapons/grapple/grfire.bnvib
    expect(playersCount).toBe(30); // 3 player models x 10 pain/fall cues each
    expect(perModelCount.cyborg).toBe(10);
    expect(perModelCount.female).toBe(10);
    expect(perModelCount.male).toBe(10);
  });

  test.skipIf(!havePak)("tactile/weapons/hyprbf1a.bnvib -- shortest weapon cue (20 samples, 100ms @ 200Hz)", () => {
    const pack = readPackDirectory(PAK_PATH);
    if (!pack) return;
    const entry = pack.entries.find((e) => e.name === "tactile/weapons/hyprbf1a.bnvib");
    expect(entry).toBeDefined();
    if (!entry) return;

    const bytes = new Uint8Array(pack.data.subarray(entry.filepos, entry.filepos + entry.filelen));
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pattern.samples.length).toBe(20);
    // first sample, verified by hand against the raw pak bytes
    expect(result.pattern.samples[0]).toEqual({ ampLow: 8, freqLow: 118, ampHigh: 16, freqHigh: 156 });
  });

  test.skipIf(!havePak)("tactile/weapons/bfg__f1y.bnvib -- longest weapon cue (479 samples, ~2.4s @ 200Hz)", () => {
    const pack = readPackDirectory(PAK_PATH);
    if (!pack) return;
    const entry = pack.entries.find((e) => e.name === "tactile/weapons/bfg__f1y.bnvib");
    expect(entry).toBeDefined();
    if (!entry) return;

    const bytes = new Uint8Array(pack.data.subarray(entry.filepos, entry.filepos + entry.filelen));
    const result = parseBnvib(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pattern.samples.length).toBe(479);
  });
});
