// Headless-safe tests for src/platform/haptics.ts.
//
// Three layers, tested independently:
//  1. Pure helpers (normalizeSoundNameToTactilePath, downmixBnvibSample) --
//     no I/O, no engine state.
//  2. BnvibScheduler against FakeRumbleSinkT + synthetic timestamps -- the
//     "scheduler tested against a fake rumble sink" requirement, never
//     touching SDL or real time.
//  3. The public Haptics_TriggerSound/Haptics_Frame surface, with the real
//     SDL-backed sink swapped out via HAPTICS_SetSinkForTests so no test
//     here opens a real controller or the real libSDL2. A synthetic
//     tactile/*.bnvib asset is mounted through this engine's own FS_*
//     module (FS_AddGameDirectory into a throwaway temp dir), exactly like
//     test/kfont.test.ts's own real-asset-loading tests do, with
//     FS_TestSnapshotSearchPaths/FS_TestRestoreSearchPaths isolating the
//     shared fs_searchpaths singleton per PORTING.md rule 13.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeSoundNameToTactilePath,
  downmixBnvibSample,
  BnvibScheduler,
  FakeRumbleSinkT,
  Haptics_Init,
  Haptics_TriggerSound,
  Haptics_Frame,
  HAPTICS_SetBackendEnabled,
  HAPTICS_SetSinkForTests,
  HAPTICS_ResetForTests,
  HAPTICS_IsPlaying,
} from "../src/platform/haptics";
import type { BnvibPatternT } from "../src/qcommon/bnvib";
import { FS_AddGameDirectory, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { cl } from "../src/client/client";
import { Cvar_ForceSet } from "../src/qcommon/cvar";

describe("normalizeSoundNameToTactilePath -- pure, no I/O", () => {
  test("plain weapon sound path", () => {
    expect(normalizeSoundNameToTactilePath("weapons/bfg__f1y.wav")).toBe("tactile/weapons/bfg__f1y.bnvib");
  });

  test("nested grapple path", () => {
    expect(normalizeSoundNameToTactilePath("weapons/grapple/grfire.wav")).toBe("tactile/weapons/grapple/grfire.bnvib");
  });

  test("resolved sexed-sound path (leading '#')", () => {
    expect(normalizeSoundNameToTactilePath("#players/male/pain100_1.wav")).toBe("tactile/players/male/pain100_1.bnvib");
  });

  test("resolved sexed-sound path, female model, fall cue", () => {
    expect(normalizeSoundNameToTactilePath("#players/female/fall2.wav")).toBe("tactile/players/female/fall2.bnvib");
  });

  test("non-.wav names have no tactile counterpart", () => {
    expect(normalizeSoundNameToTactilePath("music/track01.ogg")).toBeNull();
    expect(normalizeSoundNameToTactilePath("")).toBeNull();
  });

  test("bare '.wav' with nothing before it", () => {
    expect(normalizeSoundNameToTactilePath(".wav")).toBeNull();
  });
});

describe("downmixBnvibSample -- pure, no I/O", () => {
  test("amplitude-only downmix (frequency bytes dropped -- see haptics.ts's DOWNMIX section)", () => {
    expect(downmixBnvibSample({ ampLow: 0, freqLow: 200, ampHigh: 255, freqHigh: 0 })).toEqual({ low: 0, high: 1 });
    expect(downmixBnvibSample({ ampLow: 255, freqLow: 0, ampHigh: 0, freqHigh: 200 })).toEqual({ low: 1, high: 0 });
  });
});

function samples(n: number): BnvibPatternT["samples"] {
  return Array.from({ length: n }, (_, i) => ({ ampLow: i, freqLow: 0, ampHigh: 0, freqHigh: 0 }));
}

describe("BnvibScheduler -- fake sink, synthetic timestamps", () => {
  test("applies sample 0 immediately on play()", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    const pattern: BnvibPatternT = { sampleRateHz: 200, samples: samples(4) };

    scheduler.play(pattern, 1000);

    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0].low).toBeCloseTo(0 / 255, 6); // ampLow of sample 0
  });

  test("advances sample index as time passes (5ms period at 200Hz)", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    const pattern: BnvibPatternT = { sampleRateHz: 200, samples: samples(4) };

    scheduler.play(pattern, 1000);
    scheduler.update(1000); // same instant, no new sample
    expect(sink.calls.length).toBe(1);

    scheduler.update(1005); // one sample period later -> index 1
    expect(sink.calls.length).toBe(2);
    expect(sink.calls[1].low).toBeCloseTo(1 / 255, 6);

    scheduler.update(1007); // still index 1, no redundant call
    expect(sink.calls.length).toBe(2);

    scheduler.update(1023); // well past index 3 -> pattern finishes, sink.stop() called
    expect(sink.stopped).toBe(1);
    expect(scheduler.isPlaying()).toBe(false);
  });

  test("stop() zeroes the sink and is idempotent", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.play({ sampleRateHz: 200, samples: samples(2) }, 0);
    scheduler.stop();
    expect(sink.stopped).toBe(1);
    scheduler.stop(); // nothing playing -- must not call sink again
    expect(sink.stopped).toBe(1);
  });

  test("looping pattern wraps to loop.startSample and holds idle during the interval gap", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    // 4 samples, loop [1,3), 2-sample silence gap after the loop
    const pattern: BnvibPatternT = {
      sampleRateHz: 200,
      loop: { startSample: 1, endSample: 3, intervalSamples: 2 },
      samples: samples(4),
    };

    scheduler.play(pattern, 0);
    scheduler.update(20); // index 4 == total -> wraps: posInCycle 0 -> loop.startSample (1)
    const lastCall = sink.calls[sink.calls.length - 1];
    expect(lastCall.low).toBeCloseTo(1 / 255, 6); // sample index 1's ampLow

    scheduler.update(30); // index 6 -> posInCycle 2 -> in the silence gap (loopLen=2)
    const idleCall = sink.calls[sink.calls.length - 1];
    expect(idleCall.low).toBe(0);
    expect(idleCall.high).toBe(0);

    expect(scheduler.isPlaying()).toBe(true); // looping patterns never finish on their own
  });

  test("update() before any play() is a no-op", () => {
    const sink = new FakeRumbleSinkT();
    const scheduler = new BnvibScheduler(sink);
    scheduler.update(500);
    expect(sink.calls.length).toBe(0);
    expect(sink.stopped).toBe(0);
  });
});

describe("Haptics_TriggerSound / Haptics_Frame -- headless-safe, no controller required", () => {
  let snapshot: FsSearchPathSnapshotT;
  let tmpRoot: string;
  const sink = new FakeRumbleSinkT();

  beforeEach(() => {
    snapshot = FS_TestSnapshotSearchPaths();
    tmpRoot = mkdtempSync(join(tmpdir(), "q2-haptics-test-"));
    mkdirSync(join(tmpRoot, "tactile", "weapons"), { recursive: true });

    // A hand-built, minimal valid "raw" .bnvib (metadataSize=4, formatId=3,
    // rate=200, one sample) -- format bytes match src/qcommon/bnvib.ts's
    // own documented layout, not real retail bytes.
    const bytes = Buffer.from([
      0x04, 0x00, 0x00, 0x00, // metadataSize = 4
      0x03, 0x00, // formatId = 3
      0xc8, 0x00, // sampleRateHz = 200
      0x04, 0x00, 0x00, 0x00, // dataSize = 4 (one sample)
      0xff, 0x00, 0x00, 0x00, // ampLow=255, freqLow=0, ampHigh=0, freqHigh=0
    ]);
    writeFileSync(join(tmpRoot, "tactile", "weapons", "testcue.bnvib"), bytes);
    FS_AddGameDirectory(tmpRoot);

    Haptics_Init();
    HAPTICS_SetBackendEnabled(true);
    sink.calls = [];
    sink.stopped = 0;
    HAPTICS_SetSinkForTests(sink);
    cl.playernum = 0; // local player entity number is playernum+1 = 1
  });

  afterEach(() => {
    HAPTICS_ResetForTests();
    Cvar_ForceSet("in_haptics", "1");
    FS_TestRestoreSearchPaths(snapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a local-player sound with a matching tactile asset triggers playback", () => {
    Haptics_TriggerSound("weapons/testcue.wav", 1); // entnum 1 === cl.playernum(0)+1

    expect(sink.calls.length).toBe(1);
    expect(sink.calls[0].low).toBeCloseTo(255 / 255, 6);
    expect(HAPTICS_IsPlaying()).toBe(true);
  });

  test("the same sound for a DIFFERENT player's entity does not trigger", () => {
    Haptics_TriggerSound("weapons/testcue.wav", 7); // some other player's entity
    expect(sink.calls.length).toBe(0);
  });

  test("a sound with no matching tactile asset does not trigger", () => {
    Haptics_TriggerSound("weapons/nonexistent.wav", 1);
    expect(sink.calls.length).toBe(0);
  });

  test("in_haptics 0 disables triggering entirely", () => {
    Cvar_ForceSet("in_haptics", "0");
    Haptics_TriggerSound("weapons/testcue.wav", 1);
    expect(sink.calls.length).toBe(0);
  });

  test("backend disabled (client not armed) -- everything no-ops", () => {
    HAPTICS_SetBackendEnabled(false);
    Haptics_TriggerSound("weapons/testcue.wav", 1);
    Haptics_Frame(1000);
    expect(sink.calls.length).toBe(0);
    expect(sink.stopped).toBe(0);
  });

  test("Haptics_Frame drives the scheduler forward for an already-playing pattern", () => {
    Haptics_TriggerSound("weapons/testcue.wav", 1);
    expect(sink.calls.length).toBe(1);

    // single-sample pattern: the very next Frame call past its 5ms period
    // finishes it (stop() called), matching BnvibScheduler's own behavior.
    Haptics_Frame(50);
    expect(sink.stopped).toBe(1);
    expect(HAPTICS_IsPlaying()).toBe(false);
  });
});
