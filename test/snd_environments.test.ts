// sound/default.environments parsing + reverb environment/preset selection
// (src/client/snd_environments.ts). Ported from q2repro's src/client/
// sound/al.c -- see that file's own header comment for the full C
// citation list and the one deliberate deviation (the floor-probe trace's
// mins/maxs/end argument-order bug, NOT reproduced).
//
// Self-sufficient per PORTING.md rule 13: the pure-parser and pure-
// selection tests below need no engine state at all (ParseEnvironmentsFile/
// SelectEnvironmentIndex/SelectPresetForMaterial take plain data in, return
// plain data out). The retail-data section follows test/cl_demo_retail.
// test.ts's established convention: it reads baseq2/pak0.pak directly from
// the user's local retail install path with its own from-scratch PACK
// reader (not this port's own file-reading code) and skips itself (never
// fails) if that install isn't present.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  ParseEnvironmentsFile,
  SelectEnvironmentIndex,
  SelectPresetForMaterial,
  REVERB_PRESET_NAMES,
  REVERB_PRESETS,
  REVERB_PRESET_PLAIN,
  type ReverbEnvironmentT,
} from "../src/client/snd_environments";

// ---------------------------------------------------------------------------
// Preset table integrity
// ---------------------------------------------------------------------------

describe("REVERB_PRESETS / REVERB_PRESET_NAMES", () => {
  test("26 presets, names and values both sourced from efx-presets.h in the same order al.c:73-100/107-134 lists them", () => {
    expect(REVERB_PRESET_NAMES.length).toBe(26);
    expect(REVERB_PRESETS.length).toBe(26);
  });

  test("REVERB_PRESET_PLAIN indexes the 'plain' preset", () => {
    expect(REVERB_PRESET_NAMES[REVERB_PRESET_PLAIN]).toBe("plain");
  });

  test("spot-check against /usr/include/AL/efx-presets.h's EFX_REVERB_PRESET_GENERIC (index 0) and EFX_REVERB_PRESET_UNDERWATER (index 22)", () => {
    const generic = REVERB_PRESETS[0];
    expect(generic.density).toBeCloseTo(1.0, 6);
    expect(generic.gain).toBeCloseTo(0.3162, 6);
    expect(generic.decayTime).toBeCloseTo(1.49, 6);
    expect(generic.lateReverbGain).toBeCloseTo(1.2589, 6);
    expect(generic.decayHFLimit).toBe(true);

    const underwater = REVERB_PRESETS[REVERB_PRESET_NAMES.indexOf("underwater")];
    expect(underwater.decayTime).toBeCloseTo(1.49, 6);
    expect(underwater.lateReverbGain).toBeCloseTo(7.0795, 6);
    expect(underwater.modulationTime).toBeCloseTo(1.18, 6);
    expect(underwater.modulationDepth).toBeCloseTo(0.348, 6);
  });

  test("gain/gainLF/airAbsorptionGainHF/hfReference/lfReference/roomRolloffFactor are constant across all 26 real presets (the DSP coverage table's 'dropped as inert' justification)", () => {
    for (const p of REVERB_PRESETS) {
      expect(p.gain).toBeCloseTo(0.3162, 6);
      expect(p.gainLF).toBeCloseTo(1.0, 6);
      expect(p.airAbsorptionGainHF).toBeCloseTo(0.9943, 6);
      expect(p.hfReference).toBeCloseTo(5000.0, 6);
      expect(p.lfReference).toBeCloseTo(250.0, 6);
      expect(p.roomRolloffFactor).toBeCloseTo(0.0, 6);
      expect(p.decayLFRatio).toBeCloseTo(1.0, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// ParseEnvironmentsFile -- pure parser
// ---------------------------------------------------------------------------

describe("ParseEnvironmentsFile", () => {
  test("parses a well-formed file with wildcard and explicit-material reverb entries", () => {
    const text = JSON.stringify({
      environments: [
        { dimension: 200, reverbs: [{ materials: "*", preset: "sewer_pipe" }] },
        {
          dimension: 500,
          reverbs: [
            { materials: ["boot", "mech", "clank"], preset: "stone_room" },
            { materials: ["grass", "flesh"], preset: "room" },
            { materials: "*", preset: "living_room" },
          ],
        },
      ],
    });

    const envs = ParseEnvironmentsFile(text);
    expect(envs).not.toBeNull();
    const parsed = envs!;
    expect(parsed.length).toBe(2);
    expect(parsed[0].dimension).toBe(200);
    expect(parsed[0].reverbs[0].materials).toBeNull();
    expect(parsed[0].reverbs[0].presetIndex).toBe(REVERB_PRESET_NAMES.indexOf("sewer_pipe"));
    expect(parsed[1].reverbs[0].materials).toEqual(["boot", "mech", "clank"]);
    expect(parsed[1].reverbs[2].materials).toBeNull();
  });

  test("an empty environments array is valid (al.c:500-505: 'no reverb' file)", () => {
    expect(ParseEnvironmentsFile(JSON.stringify({ environments: [] }))).toEqual([]);
  });

  test("missing 'environments' key returns null (al.c:494-495's Json_Error)", () => {
    expect(ParseEnvironmentsFile(JSON.stringify({ foo: [] }))).toBeNull();
  });

  test("malformed JSON returns null rather than throwing", () => {
    expect(ParseEnvironmentsFile("{ not json")).toBeNull();
  });

  test("unrecognized preset name falls back to PLAIN with a warning, matching al.c:390-395 -- does NOT abort the whole file", () => {
    const text = JSON.stringify({
      environments: [{ dimension: 100, reverbs: [{ materials: "*", preset: "not_a_real_preset" }] }],
    });
    const envs = ParseEnvironmentsFile(text);
    expect(envs).not.toBeNull();
    expect(envs![0].reverbs[0].presetIndex).toBe(REVERB_PRESET_PLAIN);
  });

  test("a materials string not starting with '*' is a structural violation and aborts the whole file (al.c:360-364's Json_Error)", () => {
    const text = JSON.stringify({
      environments: [{ dimension: 100, reverbs: [{ materials: "not-a-wildcard", preset: "plain" }] }],
    });
    expect(ParseEnvironmentsFile(text)).toBeNull();
  });

  test("a materials array containing a non-string entry aborts the whole file", () => {
    const text = JSON.stringify({
      environments: [{ dimension: 100, reverbs: [{ materials: ["ok", 5], preset: "plain" }] }],
    });
    expect(ParseEnvironmentsFile(text)).toBeNull();
  });

  test("a non-array 'environments' value aborts", () => {
    expect(ParseEnvironmentsFile(JSON.stringify({ environments: "nope" }))).toBeNull();
  });

  test("a non-object environment entry aborts", () => {
    expect(ParseEnvironmentsFile(JSON.stringify({ environments: [42] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SelectEnvironmentIndex -- pure dimension-threshold walk
// ---------------------------------------------------------------------------

function envAt(dimension: number): ReverbEnvironmentT {
  return { dimension, reverbs: [] };
}

describe("SelectEnvironmentIndex (al.c:222-236's threshold walk)", () => {
  const envs = [envAt(200), envAt(500), envAt(800), envAt(900), envAt(1200), envAt(1600), envAt(2000), envAt(2001)];

  test("grows the index while the probe average exceeds the current entry's dimension", () => {
    expect(SelectEnvironmentIndex(envs, 0, 250)).toBe(1); // > 200, <= 500
    expect(SelectEnvironmentIndex(envs, 0, 850)).toBe(3); // walks past 200/500/800 to land on the 900 entry (index 3)
  });

  test("never grows past the last entry even for a huge probe average", () => {
    expect(SelectEnvironmentIndex(envs, 0, 999999)).toBe(envs.length - 1);
  });

  test("shrinks the index only when growth found nothing to do, comparing against the PREVIOUS entry's dimension", () => {
    expect(SelectEnvironmentIndex(envs, 5, 1000)).toBe(4); // 1000 < envs[4]=1200 -> shrink to 4
    expect(SelectEnvironmentIndex(envs, 5, 1300)).toBe(5); // 1300 is not > envs[5]=1600 and not < envs[4]=1200 -> stays
  });

  test("never shrinks past index 0", () => {
    expect(SelectEnvironmentIndex(envs, 0, 0)).toBe(0);
  });

  test("stays put when the probe average is within the current entry's own band (below its own dimension, above the previous entry's)", () => {
    // currentIndex=3 -> envs[3].dimension=900; envs[2].dimension=800.
    // 850 is not > 900 (no growth) and not < 800 (no shrink) -> unchanged.
    expect(SelectEnvironmentIndex(envs, 3, 850)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SelectPresetForMaterial -- pure floor-material preset pick
// ---------------------------------------------------------------------------

describe("SelectPresetForMaterial (al.c:266-293's floor-material pick)", () => {
  const env: ReverbEnvironmentT = {
    dimension: 500,
    reverbs: [
      { materials: ["boot", "mech", "clank"], presetIndex: REVERB_PRESET_NAMES.indexOf("stone_room") },
      { materials: ["grass", "flesh", "water", "snow"], presetIndex: REVERB_PRESET_NAMES.indexOf("room") },
      { materials: null, presetIndex: REVERB_PRESET_NAMES.indexOf("living_room") },
    ],
  };

  test("no floor hit (hitMaterial null) forces PLAIN, matching al.c:291-293's else branch", () => {
    expect(SelectPresetForMaterial(env, null, 5)).toBe(REVERB_PRESET_PLAIN);
  });

  test("matches an explicit material in the ordered list", () => {
    expect(SelectPresetForMaterial(env, "mech", 5)).toBe(REVERB_PRESET_NAMES.indexOf("stone_room"));
    expect(SelectPresetForMaterial(env, "water", 5)).toBe(REVERB_PRESET_NAMES.indexOf("room"));
  });

  test("material matching is case-insensitive (Q_stricmp convention)", () => {
    expect(SelectPresetForMaterial(env, "MECH", 5)).toBe(REVERB_PRESET_NAMES.indexOf("stone_room"));
  });

  test("falls through to the wildcard entry when no explicit material matches", () => {
    expect(SelectPresetForMaterial(env, "concrete", 5)).toBe(REVERB_PRESET_NAMES.indexOf("living_room"));
  });

  test("keeps the current preset when nothing in the list matches at all (no wildcard entry present)", () => {
    const noWildcard: ReverbEnvironmentT = {
      dimension: 500,
      reverbs: [{ materials: ["boot"], presetIndex: REVERB_PRESET_NAMES.indexOf("stone_room") }],
    };
    expect(SelectPresetForMaterial(noWildcard, "concrete", 7)).toBe(7);
  });

  test("first match wins, even if a later entry would also match", () => {
    const twoWildcards: ReverbEnvironmentT = {
      dimension: 500,
      reverbs: [
        { materials: null, presetIndex: REVERB_PRESET_NAMES.indexOf("cave") },
        { materials: null, presetIndex: REVERB_PRESET_NAMES.indexOf("hangar") },
      ],
    };
    expect(SelectPresetForMaterial(twoWildcards, "anything", 0)).toBe(REVERB_PRESET_NAMES.indexOf("cave"));
  });
});

// ---------------------------------------------------------------------------
// Real retail data: sound/default.environments (baseq2/pak0.pak)
// ---------------------------------------------------------------------------

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const ENTRY_NAME = "sound/default.environments";

/** Minimal classic id PACK format reader -- see test/cl_demo_retail.test.ts's
 *  own identical function; duplicated here per that file's established
 *  "self-sufficient, no relying on another test file" idiom. */
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

const havePak = existsSync(PAK_PATH);
const realBytes = havePak ? extractFromPak(PAK_PATH, ENTRY_NAME) : null;
const realText = realBytes !== null ? Buffer.from(realBytes).toString("utf8") : null;

describe("sound/default.environments -- real retail file (skipIf retail install absent)", () => {
  test.skipIf(!havePak || realText === null)("parses without error and matches the file's own known shape", () => {
    const envs = ParseEnvironmentsFile(realText!);
    expect(envs).not.toBeNull();
    const parsed = envs!;

    // Verified by hand against the real extracted file (see this unit's
    // task report for the full transcription): 8 environments, strictly
    // ascending dimension 200/500/800/900/1200/1600/2000/2001, ending on a
    // "*" -> plain wildcard.
    expect(parsed.length).toBe(8);
    const dims = parsed.map((e) => e.dimension);
    expect(dims).toEqual([200, 500, 800, 900, 1200, 1600, 2000, 2001]);
    for (let i = 1; i < dims.length; i++) expect(dims[i]).toBeGreaterThan(dims[i - 1]);

    const last = parsed[parsed.length - 1];
    expect(last.reverbs.length).toBe(1);
    expect(last.reverbs[0].materials).toBeNull();
    expect(last.reverbs[0].presetIndex).toBe(REVERB_PRESET_PLAIN);

    // The 500-dimension environment's material-keyed rules (boot/mech/clank
    // -> stone_room, grass/flesh/water/snow -> room, "*" -> living_room).
    const env500 = parsed[1];
    expect(env500.reverbs[0].materials).toEqual(["boot", "mech", "clank"]);
    expect(env500.reverbs[0].presetIndex).toBe(REVERB_PRESET_NAMES.indexOf("stone_room"));
    expect(env500.reverbs[1].materials).toEqual(["grass", "flesh", "water", "snow"]);
    expect(env500.reverbs[1].presetIndex).toBe(REVERB_PRESET_NAMES.indexOf("room"));
    expect(env500.reverbs[2].materials).toBeNull();
    expect(env500.reverbs[2].presetIndex).toBe(REVERB_PRESET_NAMES.indexOf("living_room"));
  });

  test.skipIf(!havePak || realText === null)("SelectEnvironmentIndex walks the real dimension thresholds correctly end to end", () => {
    const envs = ParseEnvironmentsFile(realText!)!;
    // A tiny closet-sized estimate should settle on the smallest (200) band.
    expect(SelectEnvironmentIndex(envs, 4, 50)).toBe(0);
    // A vast open-sky estimate should settle on the largest (2001, "plain") band.
    expect(SelectEnvironmentIndex(envs, 0, 100000)).toBe(envs.length - 1);
    // A mid-sized room (~850 units) should land on the 900 band (index 3).
    expect(SelectEnvironmentIndex(envs, 0, 850)).toBe(3);
  });
});
