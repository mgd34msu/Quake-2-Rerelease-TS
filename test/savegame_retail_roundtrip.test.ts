/*
Savegame cross-load verification unit (.orch/followups.md's phase-8 q2repro
interop matrix, cell (e)) -- skipIf-gated e2e that round-trips a REAL
savegame (real retail "base1" map, not a synthetic BSP) through this
engine's OWN kex-family writer and reader (src/server/sv_ccmds.ts's
SV_WriteServerFileKex/SV_ReadServerFileKex/SV_WriteLevelFileKex/
SV_ReadLevelFileKex).

This complements two pre-existing suites rather than duplicating them:
  - test/savegame_kex_e2e.test.ts already does a same-engine save/load
    round trip, but against a synthetic box-room BSP (no retail data
    needed) -- this file swaps in the real retail "base1" campaign map via
    the `content_root` mechanism (src/qcommon/files.ts's FS_InitFilesystem,
    see that file's own "BASEDIR REALITY" comment) so real entity/BSP
    content (lights with packed-color skinnum fields, real navigation
    files, real configstring counts) exercises the writer/reader instead
    of a two-entity fabricated room.
  - test/savegame_container.test.ts's Group A/B are self-sufficient golden-
    byte-layout tests (no retail data, no real map) -- this file is
    deliberately NOT self-sufficient; it is the real-data e2e companion the
    task brief calls for, gated with `test.skipIf` on the same retail-path
    convention test/cl_demo_retail.test.ts already established (only skips
    itself if the retail install isn't present -- CI or a machine without
    it -- never silently no-ops elsewhere).

CROSS-ENGINE FINDING this same investigation surfaced (see task report for
the full writeup, not re-verified by this file since it needs a real
q2repro binary this suite cannot depend on): a save produced by this
engine against real base1 data fails to load in the real q2repro binary
with "entities[240].s.skinnum: expected integer" -- a `classname: "light"`
entity's packed RGBA color (src/kexgame/g_spawn.ts's ED_LoadColor, via
`(... ) >>> 0`, an unsigned 32-bit value like 0xFF00FFFF = 4278849791)
written to JSON as-is, versus q2repro's own JSON reader which requires the
value fit a signed int32. That bug lives in src/kexgame/ (owned by a
different unit per this task's territory split), not in the container
code this file exercises, so it is NOT re-asserted here -- this file only
confirms this engine's OWN writer/reader round-trip stays self-consistent
against real map data, independent of that separate cross-engine gap.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { cls, ConnstateT } from "../src/client/client";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { Cbuf_AddText } from "../src/qcommon/cmd";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init, runFrames } from "../src/main";
import { sv, ServerStateT } from "../src/server/server";
import { SV_Shutdown } from "../src/server/sv_main";
import { FS_Gamedir, FS_ReadRawFile, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";
import { g_edicts, level } from "../src/kexgame/g_main_globals";
import { Gtime_milliseconds, Gtime_from_sec } from "../src/kexgame/gtime";
import { snapshotCvars, restoreCvars, type CvarSnapshotT } from "./support/cvar_snapshot";

// rule 13 (process-wide singleton leaks, closed at the source):
//
// (1) fs_searchpaths / content_root -- this is the only test in the suite
// that mounts the real retail install via content_root (src/qcommon/
// files.ts's FS_InitFilesystem, see its own "BASEDIR REALITY" comment),
// and neither half of that mount is undone on its own: fs_searchpaths/
// fs_base_searchpaths are process-wide linked lists that persist for the
// whole `bun test` run (later test files' exact-name FS_LoadFile/
// FS_FOpenFile lookups can resolve through to genuine retail assets that
// were never supposed to be reachable there -- FS_TestSnapshotSearchPaths/
// FS_TestRestoreSearchPaths in src/qcommon/files.ts is the test seam this
// half needed), AND the "content_root" cvar itself stays set to
// RETAIL_ROOT forever, which is worse than it sounds: FS_InitFilesystem
// re-mounts content_root's baseq2/Q2Game.kpf on EVERY call that sees it
// non-empty, so any later test that calls FS_InitFilesystem again for its
// own reasons (e.g. test/menu_content.test.ts's beforeEach, mounting its
// own synthetic basedir) unknowingly re-mounts the real retail data right
// back on top, undoing the fs_searchpaths restore.
//
// (2) cvar_vars -- Qcommon_Init unconditionally execs "default.cfg" and
// "config.cfg" (src/main.ts, matching q2repro exactly: a dedicated server
// reads these too, for archived server cvars) -- and because content_root
// points this boot at a REAL retail install, those are a REAL, machine-
// specific user's actual saved files, not synthetic fixtures. Any cvar
// name in there that no code on this test's own (dedicated) boot path
// ever Cvar_Get's -- every client-only preference: "name", "fov",
// "sensitivity", "hand", "rate", "crosshair", "cl_run", "freelook",
// "allow_download_players", ... -- gets created fresh by Cvar_Set2's
// create-on-demand path (src/qcommon/cvar.ts) with that real user's saved
// VALUE baked in as its permanent default_string. Cvar_Get's "first
// registration wins the default" contract means no later, correct
// Cvar_Get call (e.g. test/cvar_parity.test.ts's own real client boot)
// can ever fix it -- observed breaking that suite's whole manifest audit
// with a real user's fov/sensitivity/name/etc. standing in for q2repro's
// documented defaults. Unlike (1), this isn't fixable by naming the one
// or two known-bad cvars (a real user's config.cfg can contain anything);
// snapshot/restore the whole registry instead. This is safe specifically
// because this file is the ONLY consumer of real, machine-specific
// config content in the whole suite -- nothing else should ever want a
// leftover from it to persist, unlike test/cvar_parity.test.ts's own
// boot (a legitimate first mover many other files' ambient cvar state
// depends on) or any test using synthetic-only fixtures. See
// test/support/cvar_snapshot.ts (shared with test/sdl_platform.test.ts's
// own throwaway "+set allow_download 0"/"+set s_initsound 0" boot, the
// identical leak shape) for the snapshot/restore recipe and its exact
// scope/safety rationale.

// Same retail-install convention as test/cl_demo_retail.test.ts: skip
// (never fail) when this machine has no retail rerelease install.
const RETAIL_ROOT = "/home/buzzkill/q2rets/rerelease";
const haveRetail = existsSync(join(RETAIL_ROOT, "Q2Game.kpf")) && existsSync(join(RETAIL_ROOT, "baseq2", "pak0.pak"));

async function pollUntil(predicate: () => boolean, limit = 800): Promise<boolean> {
  // do-while, not while: always drains Cbuf_Execute at least once before the
  // first check -- see this repo's report for why a while-first loop can
  // exit before ever running a just-queued command when the predicate (e.g.
  // sv.state === ss_game) is already true from an EARLIER command.
  for (let i = 0; i < limit; i++) {
    runFrames(1, 100);
    await Bun.sleep(1);
    if (predicate()) return true;
  }
  return predicate();
}

function inuseEntityCount(): number {
  return g_edicts.filter((e) => e.inuse).length;
}

describe.skipIf(!haveRetail)("kex family save/load -- real retail base1 e2e (own writer, own reader)", () => {
  let tmpRoot: string;
  let fsSnapshot: FsSearchPathSnapshotT;
  let cvarSnapshot: CvarSnapshotT;

  beforeAll(async () => {
    // Captured before ANY mutation below (including the Cvar_ForceSet calls
    // right after) -- a snapshot taken even one mutation too late bakes
    // that mutation in as the "restored" state.
    fsSnapshot = FS_TestSnapshotSearchPaths();
    cvarSnapshot = snapshotCvars();

    tmpRoot = mkdtempSync(join(tmpdir(), "q2save-retail-e2e-"));

    // Belt-and-suspenders pre-registration (see this unit's report: a live
    // concurrent-edit race was observed, once, resolving basedir to "."
    // despite a correct `+set basedir` argv -- Cvar_ForceSet before
    // Qcommon_Init, matching test/savegame_kex_e2e.test.ts's own existing
    // pattern, is the establish belt-and-suspenders fix).
    //
    // "dedicated" gets the identical treatment for the identical reason:
    // it is CVAR_NOSET (src/main.ts's Qcommon_Init), and an earlier test
    // file's own client boot (dedicated 0, common in this suite) can leave
    // it registered and write-protected at 0, in which case this file's
    // own "+set dedicated 1" argv below -- a plain, non-forced Cvar_Set2,
    // see src/qcommon/cmd.ts's Cbuf_AddEarlyCommands -- would silently
    // no-op and this describe block would run a full client boot (CL_Init/
    // VID_Init/S_Init) against the real retail content_root mount instead
    // of the dedicated boot its own header comment assumes.
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("content_root", RETAIL_ROOT);
    Cvar_ForceSet("dedicated", "1");

    // In-process boot: a real process starts with cls.state fresh, and CL_Init
    // returns before touching it under dedicated=1, so reset what an earlier
    // suite in this process may have left connected (otherwise init's default
    // startup command forwards to a netchan that was never set up).
    cls.state = ConnstateT.ca_disconnected;
    Qcommon_Init([
      "quake2",
      "+set",
      "basedir",
      tmpRoot,
      "+set",
      "content_root",
      RETAIL_ROOT,
      "+set",
      "game",
      "kex",
      "+set",
      "dedicated",
      "1",
      "+set",
      "s_initsound",
      "0",
      "+set",
      "coop",
      "1",
      "+set",
      "deathmatch",
      "0",
      "+set",
      "port",
      "0",
    ]);

    Cbuf_AddText("map base1\n");
    const booted = await pollUntil(() => sv.state === ServerStateT.ss_game);
    expect(booted).toBe(true);
    expect(sv.name).toBe("base1");
  });

  afterAll(async () => {
    SV_Shutdown("retail savegame E2E test finished\n", false);
    await NET_Shutdown();
    // Unmount the real retail search paths this boot added (leak (1)
    // above) -- this alone isn't enough on its own: restoreCvars below
    // also has to put "content_root" itself back, or the very next test
    // that calls FS_InitFilesystem for its own reasons re-mounts the real
    // retail install right back on top (see leak (1)'s comment).
    FS_TestRestoreSearchPaths(fsSnapshot);
    // Undo every cvar this boot's real config.cfg/default.cfg exec
    // registered or changed (leak (2) above).
    restoreCvars(cvarSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("save/load round trip against real base1 data: level.time and entity count restore, all four container files exist", async () => {
    const entityCountBefore = inuseEntityCount();
    expect(entityCountBefore).toBeGreaterThan(0);

    level.time = Gtime_from_sec(4242);
    const timeBefore = Gtime_milliseconds(level.time);

    Cbuf_AddText("save retailtest\n");
    const saved = await pollUntil(() => {
      const gamedir = FS_Gamedir();
      return FS_ReadRawFile(`${gamedir}/save/retailtest/server.ssv`) !== null;
    });
    expect(saved).toBe(true);

    const gamedir = FS_Gamedir();
    // the four files SV_WriteServerFileKex/SV_WriteLevelFileKex (sv_ccmds.ts)
    // write, matching save.c's write_server_file/write_level_file split.
    expect(FS_ReadRawFile(`${gamedir}/save/retailtest/server.ssv`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/retailtest/game.ssv`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/retailtest/base1.sv2`)).not.toBeNull();
    expect(FS_ReadRawFile(`${gamedir}/save/retailtest/base1.sav`)).not.toBeNull();

    // mutate well past the saved snapshot so a later match proves the
    // restored value came from the save file, not untouched live state
    level.time = Gtime_from_sec(999999);
    expect(Gtime_milliseconds(level.time)).toBeGreaterThan(timeBefore);

    Cbuf_AddText("load retailtest\n");
    // The LOAD_NORMAL catch-up frames advance level.time by exactly two
    // game frames past the saved value (f5b976f: mainLoop=false really
    // runs them, per q2repro save.c:626-654) -- poll for the restored-and-
    // advanced value, then pin it exactly.
    const catchUpMs = 2 * sv.frametime; // the game's live per-frame ms (gi.frame_time_ms mirrors sv.frametime)
    const reloaded = await pollUntil(() => sv.state === ServerStateT.ss_game && Gtime_milliseconds(level.time) === timeBefore + catchUpMs);
    expect(reloaded).toBe(true);

    expect(sv.name).toBe("base1");
    // The two LOAD_NORMAL catch-up frames are REAL game frames now
    // (f5b976f) and legitimately spawn a handful of entities on base1
    // (timed thinks); the restore itself is exact -- assert restored-plus-
    // bounded-evolution rather than frozen equality.
    expect(inuseEntityCount()).toBeGreaterThanOrEqual(entityCountBefore);
    expect(inuseEntityCount()).toBeLessThanOrEqual(entityCountBefore + 16);
  });
});
