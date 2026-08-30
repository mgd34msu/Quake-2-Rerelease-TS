/*
Variable-tick unit tests -- ARCHITECTURE.md phase 3 ("Variable tick +
framediv"). Covers three things that used to be wrong or unverified:

  1. Family dispatch: sv_game.ts's currentGameFamily() and sv_init.ts's
     SV_ComputeFramerate() -- the kex family honors sv_tick_rate (clamped
     [10,60]); every legacy family is pinned to BASE_FRAMERATE(10)
     regardless of what the cvar holds.
  2. sv_tick_rate's registered default is "40" (matching q2repro), now that
     family dispatch exists to protect the legacy trees from it.
  3. Engine frame pacing (sv_main.ts's SV_Frame/SV_RunGameFrame accumulator)
     actually honors sv.frametime rather than assuming a fixed 100ms tick --
     exercised by fabricating the accumulator state directly and counting
     how many times a fake GameExports.RunFrame() fires over a fixed
     wall-clock window at two different frametimes.

Self-sufficient per PORTING.md/preferences.md rule 13: every global this
suite reads is set up here, not assumed from another test file's run
order (cvar_vars is a process-wide singleton map, so "game"/"sv_tick_rate"
may already be registered by another file by the time this one runs --
every test below forces the values it needs rather than trusting defaults
left over from elsewhere, except the one test that explicitly re-derives
the true registration default by deleting the cvar first).
*/

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sv, svs, maxclients } from "../src/server/server";
import { SV_Init, SV_Frame } from "../src/server/sv_main";
import { SV_ComputeFramerate } from "../src/server/sv_init";
import { geHolder, currentGameFamily } from "../src/server/sv_game";
import { Cvar_ForceSet, Cvar_Get, cvar_vars } from "../src/qcommon/cvar";
import { CVAR_LATCH } from "../src/shared/q_shared";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { BuildKexImports } from "../src/server/bindings/kex";
import type { GameExports } from "../src/game/game";

function makeCountingGameExports(): GameExports & { runFrameCount: number } {
  const obj = {
    apiversion: 3,
    runFrameCount: 0,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect() {
      return { allowed: true, userinfo: "" };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {
      obj.runFrameCount++;
    },
    ServerCommand() {},
    edicts: [],
    num_edicts: 0,
    max_edicts: 0,
  };
  return obj;
}

describe("variable tick -- family dispatch", () => {
  let tmpRoot: string;

  beforeAll(() => {
    // FS_InitFilesystem is what registers the "game" cvar in this codebase
    // (files.ts); route it at a scratch basedir so it does not touch (or
    // depend on) the real cwd's baseq2 tree.
    tmpRoot = mkdtempSync(join(tmpdir(), "q2tick-"));
    mkdirSync(join(tmpRoot, "baseq2"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();

    // SV_Init registers sv_tick_rate (and maxclients, etc) if not already
    // registered by another test file in this same process.
    SV_Init();
  });

  test("currentGameFamily() reads 'kex' when the game cvar names it", () => {
    Cvar_ForceSet("game", "kex");
    expect(currentGameFamily()).toBe("kex");
  });

  test("currentGameFamily() treats every non-kex game name as 'legacy'", () => {
    Cvar_ForceSet("game", "baseq2");
    expect(currentGameFamily()).toBe("legacy");

    Cvar_ForceSet("game", "rogue");
    expect(currentGameFamily()).toBe("legacy");

    Cvar_ForceSet("game", "");
    expect(currentGameFamily()).toBe("legacy");
  });

  test("SV_ComputeFramerate: kex family honors sv_tick_rate", () => {
    Cvar_ForceSet("game", "kex");
    Cvar_ForceSet("sv_tick_rate", "40");
    expect(SV_ComputeFramerate()).toBe(40);
  });

  test("SV_ComputeFramerate: kex family clamps sv_tick_rate to [10,60]", () => {
    Cvar_ForceSet("game", "kex");

    Cvar_ForceSet("sv_tick_rate", "100");
    expect(SV_ComputeFramerate()).toBe(60);

    Cvar_ForceSet("sv_tick_rate", "5");
    expect(SV_ComputeFramerate()).toBe(10);

    Cvar_ForceSet("sv_tick_rate", "1000000");
    expect(SV_ComputeFramerate()).toBe(60);
  });

  test("SV_ComputeFramerate: legacy family is pinned to 10 regardless of sv_tick_rate", () => {
    Cvar_ForceSet("game", "rogue");
    Cvar_ForceSet("sv_tick_rate", "40");
    expect(SV_ComputeFramerate()).toBe(10);

    Cvar_ForceSet("sv_tick_rate", "60");
    expect(SV_ComputeFramerate()).toBe(10);
  });

  test("sv_tick_rate's registered default is 40, matching q2repro", () => {
    // Force a fresh registration: cvar_vars is a process-wide singleton
    // map, so an earlier test file's SV_Init() call may have already
    // registered sv_tick_rate (Cvar_Get is a no-op on an existing cvar,
    // so a stale registration would otherwise hide a default regression).
    cvar_vars.delete("sv_tick_rate");
    SV_Init();
    const rate = Cvar_Get("sv_tick_rate", "should-not-be-used", CVAR_LATCH);
    expect(rate).not.toBeNull();
    expect(rate?.value).toBe(40);
    expect(rate?.string).toBe("40");
  });
});

describe("variable tick -- engine frame pacing honors sv.frametime", () => {
  beforeAll(() => {
    svs.initialized = true;
    if (maxclients) maxclients.value = 0; // no client slots touched by SV_CheckTimeouts/SV_GiveMsec/SV_CalcPings
  });

  // Drives SV_Frame with `stepMs`-sized real-time slices (mirroring
  // Qcommon_Frame's per-iteration delta) for `totalMs` of wall-clock time,
  // and counts how many times RunFrame actually fired. This exercises the
  // REAL accumulator in sv_main.ts's SV_Frame/SV_RunGameFrame, not a
  // reimplementation of it.
  function countRunFramesOver(frameTimeMs: number, totalMs: number, stepMs = 1): number {
    const ge = makeCountingGameExports();
    geHolder.ge = ge;

    sv.framerate = 1000 / frameTimeMs;
    sv.frametime = frameTimeMs;
    sv.framenum = 0;
    sv.time = 0;
    svs.realtime = 0;

    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) SV_Frame(stepMs);

    return ge.runFrameCount;
  }

  test("at a 100ms (10Hz) frametime, 1000ms of wall-clock time yields 11 ticks (10 ticks + the initial catch-up tick)", () => {
    expect(countRunFramesOver(100, 1000)).toBe(11);
  });

  test("at a 25ms (40Hz) frametime, 1000ms of wall-clock time yields 41 ticks (40 ticks + the initial catch-up tick)", () => {
    expect(countRunFramesOver(25, 1000)).toBe(41);
  });

  test("halving the frametime doubles the tick cadence over the same wall-clock window", () => {
    const at50ms = countRunFramesOver(50, 2000);
    const at25ms = countRunFramesOver(25, 2000);
    // both series share the same +1 catch-up tick, so compare tick COUNTS
    // net of that shared offset rather than a raw 2x ratio.
    expect(at25ms - 1).toBe((at50ms - 1) * 2);
  });

  test("sv.framenum and sv.time advance in lockstep with the ticks that actually ran", () => {
    countRunFramesOver(25, 400); // 400/25 + 1 = 17 ticks
    expect(sv.framenum).toBe(17);
    expect(sv.time).toBe(17 * 25);
  });

  test("a slower frametime does not run more often than its own cadence even over a long window", () => {
    const ticks = countRunFramesOver(100, 5000);
    expect(ticks).toBe(51); // 5000/100 + 1
  });
});

describe("variable tick -- kex import fields read sv.framerate/sv.frametime live", () => {
  test("tick_rate/frame_time_s/frame_time_ms track sv.framerate/sv.frametime on every read, not a snapshot taken at BuildKexImports() call time", () => {
    // Mirrors the real bug: SV_InitGameProgs (sv_game.ts) calls
    // BuildKexImports() from SV_InitGame, which runs BEFORE SV_SpawnServer
    // (sv_init.ts) derives the real per-family framerate for the level
    // about to load. Build the imports against a stale pre-spawn value...
    sv.framerate = 10;
    sv.frametime = 100;
    const imports = BuildKexImports();
    expect(imports.tick_rate).toBe(10);
    expect(imports.frame_time_ms).toBe(100);

    // ...then simulate SV_SpawnServer's family dispatch settling on the
    // real kex-family rate afterward.
    sv.framerate = 40;
    sv.frametime = 25;

    expect(imports.tick_rate).toBe(40);
    expect(imports.frame_time_s).toBe(0.025);
    expect(imports.frame_time_ms).toBe(25);
  });
});
