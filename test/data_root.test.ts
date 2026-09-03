/*
Tests for the DATA TREE choice (Mike's RC ruling, 2026-09-01: "the New Game
screen must let the player choose WHICH DATA TREE runs the content --
original 1997 data vs re-release data ... implemented behind the scenes as a
data-tree remount at launch").

Two halves, matching the feature's own two halves:

  ENGINE  qcommon/files.ts's FS_SetDataRoot / the `data_root` console
          command -- tear the whole search path down (base tier included,
          which is exactly what FS_SetGamedir refuses to do) and rebuild it
          against one or more named roots, lowest search priority first.

  MODEL   client/menu_content.ts's DATA TREES section -- per-tree
          availability scanned off the real trees, the (ruleset, tree) ->
          mount plan rule, and the launch sequence PerformLaunch queues.

The mount rules under test (Mike, 2026-09-01, as amended the same morning):
  (a) the KEX ruleset always has the rerelease tree mounted -- as the
      primary tree when the player picked rerelease data, or BENEATH the
      classic tree as an asset fallback when he picked original data, so his
      1997 maps play while kex-only assets still resolve;
  (b) the CLASSIC ruleset runs whichever single tree the player picked.

Self-sufficient per .orch/preferences.md rule 13: every describe block
builds and tears down its own mkdtemp fixture trees (including REAL pak
files, since both of this machine's data trees keep their campaign maps in
paks and the availability scan reads pak directories), and every piece of
process-wide state a real FS_InitFilesystem()/FS_SetDataRoot() call touches
-- fs_searchpaths, fs_base_searchpaths, fs_data_roots, and the basedir,
homedir, cddir, content_root, data_root_classic, data_root_rerelease, game
and gamedir cvars -- is snapshotted before and restored after, the same
pattern test/menu_game_discovery.test.ts and test/fs_homedir.test.ts use.

The last describe block is RETAIL-GATED: it only runs when both of this
machine's real installs are present, and is skipped (not failed) otherwise.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_AddCommand, Cmd_RemoveCommand, Cmd_Exists, Cmd_Args } from "../src/qcommon/cmd";
import {
  FS_ListFiles,
  FS_ListPackFileEntries,
  FS_ReadRawFile,
  FS_LoadFile,
  FS_InitFilesystem,
  FS_SetDataRoot,
  FS_RootIsRerelease,
  FS_Gamedir,
  FS_TestSnapshotSearchPaths,
  FS_TestRestoreSearchPaths,
  FS_TestSearchPathList,
  type FsSearchPathSnapshotT,
} from "../src/qcommon/files";
import {
  ScanDataTree,
  ResetDataTreeScanCache,
  LaunchPlanRunsInTree,
  AvailableDataTreesFor,
  DataTreesForGame,
  ResolveLaunchForGame,
  GamesWithData,
  GameListDisplayName,
  BuildGameList,
  DiscoverGameDirsInTrees,
  DataMountPlanFor,
  DataTreeDisplayName,
  PerformLaunch,
  ResolveLaunch,
  CONTENT_LIST,
  type GameFsSeam,
  type DataTreeScans,
  type SelectableGame,
  type ContentId,
} from "../src/client/menu_content";

const CLASSIC_INSTALL = `${process.env.HOME ?? ""}/q2ts`;
const RERELEASE_INSTALL = `${process.env.HOME ?? ""}/q2rets/rerelease`;

// The real, production seam -- files.ts's three literal-path readers, which
// have no dependency on what is currently mounted.
const realSeam: GameFsSeam = {
  listFiles: FS_ListFiles,
  readTextFile: (path) => {
    const raw = FS_ReadRawFile(path);
    return raw ? new TextDecoder().decode(raw) : null;
  },
  listPakEntries: FS_ListPackFileEntries,
};

/*
A real, minimal Quake II pak file. The availability scan reads pak
DIRECTORIES (that is where both real trees keep their campaign maps), so a
fixture that only wrote loose files would not exercise the load-bearing
path at all. Layout is qfiles.h's: "PACK" + dirofs + dirlen, then one
64-byte entry per file (56-byte NUL-padded name, int filepos, int filelen).
*/
function writePak(path: string, entries: ReadonlyArray<{ name: string; body: string }>): void {
  const bodies = entries.map((e) => new TextEncoder().encode(e.body));
  const dirlen = entries.length * 64;
  let dataLen = 0;
  for (const b of bodies) dataLen += b.length;

  const out = new Uint8Array(12 + dataLen + dirlen);
  const view = new DataView(out.buffer);

  out[0] = 0x50; // 'P'
  out[1] = 0x41; // 'A'
  out[2] = 0x43; // 'C'
  out[3] = 0x4b; // 'K'

  let pos = 12;
  const positions: number[] = [];
  for (const b of bodies) {
    positions.push(pos);
    out.set(b, pos);
    pos += b.length;
  }

  const dirofs = pos;
  view.setInt32(4, dirofs, true);
  view.setInt32(8, dirlen, true);

  entries.forEach((entry, i) => {
    const base = dirofs + i * 64;
    const nameBytes = new TextEncoder().encode(entry.name);
    out.set(nameBytes, base);
    view.setInt32(base + 56, positions[i] ?? 0, true);
    view.setInt32(base + 60, bodies[i]?.length ?? 0, true);
  });

  writeFileSync(path, out);
}

// Every process-wide mount/cvar knob these tests move, captured and put back.
interface SavedState {
  readonly paths: FsSearchPathSnapshotT;
  readonly cvars: ReadonlyArray<readonly [string, string]>;
}

const TOUCHED_CVARS = ["basedir", "homedir", "cddir", "content_root", "data_root_classic", "data_root_rerelease", "game", "gamedir"] as const;

function saveState(): SavedState {
  return {
    paths: FS_TestSnapshotSearchPaths(),
    cvars: TOUCHED_CVARS.map((name) => [name, Cvar_VariableString(name)] as const),
  };
}

function restoreState(saved: SavedState): void {
  FS_TestRestoreSearchPaths(saved.paths);
  for (const [name, value] of saved.cvars) Cvar_ForceSet(name, value);
  ResetDataTreeScanCache();
}

// ===========================================================================

describe("files.ts -- FS_SetDataRoot remounts the whole search path", () => {
  let tmp: string;
  let classicRoot: string;
  let rereleaseRoot: string;
  let saved: SavedState;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "q2dataroot-"));
    classicRoot = join(tmp, "classic");
    rereleaseRoot = join(tmp, "rerelease");

    // CLASSIC fixture: a baseq2 with a pak holding base1, plus sibling
    // xatrix and lmctf gamedirs. No Q2Game.kpf -- that is what makes it
    // classic-shaped to FS_RootIsRerelease.
    mkdirSync(join(classicRoot, "baseq2"), { recursive: true });
    writePak(join(classicRoot, "baseq2", "pak0.pak"), [
      { name: "maps/base1.bsp", body: "CLASSIC-BASE1" },
      { name: "shared.txt", body: "CLASSIC-SHARED" },
      { name: "classic_only.txt", body: "CLASSIC-ONLY" },
      // A HUD pic that exists in BOTH trees -- the asset whose winner
      // Mike's "we use the things from that ruleset" ruling decides.
      { name: "pics/i_health.pcx", body: "CLASSIC-HEALTH-PIC" },
    ]);
    mkdirSync(join(classicRoot, "xatrix"), { recursive: true });
    writePak(join(classicRoot, "xatrix", "pak0.pak"), [{ name: "maps/xswamp.bsp", body: "CLASSIC-XSWAMP" }]);
    mkdirSync(join(classicRoot, "lmctf"), { recursive: true });
    writeFileSync(join(classicRoot, "lmctf", "maplist.txt"), "lmctf09\n");
    mkdirSync(join(classicRoot, "lmctf", "maps"), { recursive: true });
    writeFileSync(join(classicRoot, "lmctf", "maps", "lmctf09.bsp"), "");

    // RERELEASE fixture: baseq2/pak0.pak alongside a Q2Game.kpf, which is
    // exactly FS_RootIsRerelease's detection rule. The pak is the content
    // superset (all four id campaigns plus rerelease-only content), and it
    // carries the kex-only asset the classic tree lacks.
    mkdirSync(join(rereleaseRoot, "baseq2"), { recursive: true });
    writeFileSync(join(rereleaseRoot, "Q2Game.kpf"), "not-a-real-zip");
    writePak(join(rereleaseRoot, "baseq2", "pak0.pak"), [
      { name: "maps/base1.bsp", body: "RERELEASE-BASE1" },
      { name: "maps/xswamp.bsp", body: "RERELEASE-XSWAMP" },
      { name: "maps/mguhub.bsp", body: "RERELEASE-MGUHUB" },
      { name: "maps/q64/rtest.bsp", body: "RERELEASE-Q64" },
      { name: "shared.txt", body: "RERELEASE-SHARED" },
      { name: "pics/damage_indicator.png", body: "RERELEASE-ONLY-PIC" },
      { name: "pics/i_health.pcx", body: "RERELEASE-HEALTH-PIC" },
    ]);

    saved = saveState();

    Cvar_ForceSet("basedir", classicRoot);
    Cvar_ForceSet("homedir", "");
    Cvar_ForceSet("cddir", "");
    Cvar_ForceSet("content_root", "");
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("gamedir", "");
    FS_InitFilesystem();
    Cvar_ForceSet("data_root_classic", classicRoot);
    Cvar_ForceSet("data_root_rerelease", rereleaseRoot);
  });

  afterAll(() => {
    restoreState(saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  function textOf(path: string): string | null {
    const raw = FS_LoadFile(path);
    return raw ? new TextDecoder().decode(raw) : null;
  }

  test("1. FS_RootIsRerelease tells the two fixture trees apart", () => {
    expect(FS_RootIsRerelease(rereleaseRoot)).toBe(true);
    expect(FS_RootIsRerelease(classicRoot)).toBe(false);
    expect(FS_RootIsRerelease("")).toBe(false);
    expect(FS_RootIsRerelease(join(tmp, "nope"))).toBe(false);
  });

  test("2. single-root mount: only that tree is reachable, and it is the write root", () => {
    FS_SetDataRoot([rereleaseRoot]);

    expect(textOf("maps/base1.bsp")).toBe("RERELEASE-BASE1");
    expect(textOf("pics/damage_indicator.png")).toBe("RERELEASE-ONLY-PIC");
    // The classic tree is fully unmounted -- a classic-only file is gone.
    expect(textOf("classic_only.txt")).toBeNull();

    expect(FS_Gamedir()).toBe(join(rereleaseRoot, "baseq2"));
    expect(FS_TestSearchPathList().some((p) => p.startsWith(classicRoot))).toBe(false);
  });

  test("3. switching back drops the previous root's mounts entirely", () => {
    FS_SetDataRoot([classicRoot]);

    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");
    expect(textOf("classic_only.txt")).toBe("CLASSIC-ONLY");
    // The rerelease-only asset is unreachable: this is the classic ruleset
    // on original data, mount rule (b).
    expect(textOf("pics/damage_indicator.png")).toBeNull();

    expect(FS_Gamedir()).toBe(join(classicRoot, "baseq2"));
    expect(FS_TestSearchPathList().some((p) => p.startsWith(rereleaseRoot))).toBe(false);
  });

  test("4. RULE (a): rerelease over classic with maps=classic -- kex assets win, 1997 MAPS win", () => {
    // Lowest priority first, so the rerelease tree is mounted last and wins
    // everywhere; the maps/ carve-out then aims map lookups at classic.
    FS_SetDataRoot([classicRoot, rereleaseRoot], classicRoot);

    // Mike's ruling: "if we are playing with a specific ruleset, we use the
    // things from that ruleset" -- every shared asset is the RERELEASE copy.
    expect(textOf("shared.txt")).toBe("RERELEASE-SHARED");
    expect(textOf("pics/i_health.pcx")).toBe("RERELEASE-HEALTH-PIC");
    expect(textOf("pics/damage_indicator.png")).toBe("RERELEASE-ONLY-PIC");

    // ...EXCEPT the map files, which stay his 1997 geometry.
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");

    // A map only the rerelease tree has still resolves: the carve-out only
    // REORDERS the walk, it never makes anything unreachable.
    expect(textOf("maps/mguhub.bsp")).toBe("RERELEASE-MGUHUB");

    // A file only the classic tree has is still reachable underneath.
    expect(textOf("classic_only.txt")).toBe("CLASSIC-ONLY");
  });

  test("5. search-path ORDER: every rerelease entry precedes every classic entry", () => {
    FS_SetDataRoot([classicRoot, rereleaseRoot], classicRoot);

    const paths = FS_TestSearchPathList(); // head (highest priority) first
    const lastRerelease = paths.map((p) => p.startsWith(rereleaseRoot)).lastIndexOf(true);
    const firstClassic = paths.map((p) => p.startsWith(classicRoot)).indexOf(true);

    expect(lastRerelease).toBeGreaterThanOrEqual(0);
    expect(firstClassic).toBeGreaterThanOrEqual(0);
    // The raw mount order really is rerelease-first...
    expect(lastRerelease).toBeLessThan(firstClassic);
    // ...which is exactly why the maps/ result below cannot be an accident
    // of ordering -- it can only come from the carve-out.
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");
  });

  test("5b. without the carve-out the same mount order serves the RERELEASE map", () => {
    // Same two roots, same order, no maps= preference: the control that
    // proves the carve-out is what moves maps/, not the mount order.
    FS_SetDataRoot([classicRoot, rereleaseRoot]);
    expect(textOf("maps/base1.bsp")).toBe("RERELEASE-BASE1");
    expect(textOf("pics/i_health.pcx")).toBe("RERELEASE-HEALTH-PIC");
  });

  test("6. a gamedir mounted across a switch is re-laid against BOTH roots, and maps/ still honors the carve-out", () => {
    FS_SetDataRoot([classicRoot]);
    Cvar_ForceSet("gamedir", "xatrix");
    FS_SetDataRoot([classicRoot, rereleaseRoot], classicRoot);

    const paths = FS_TestSearchPathList();
    expect(paths).toContain(join(classicRoot, "xatrix"));
    expect(paths).toContain(join(rereleaseRoot, "xatrix"));
    // rerelease is primary, so its gamedir layer sits above the classic one
    expect(paths.indexOf(join(rereleaseRoot, "xatrix"))).toBeLessThan(paths.indexOf(join(classicRoot, "xatrix")));

    // The expansion's MAP still comes from the classic tree's own xatrix pak
    // even though the rerelease baseq2 pak (higher priority) also has it.
    expect(textOf("maps/xswamp.bsp")).toBe("CLASSIC-XSWAMP");

    Cvar_ForceSet("gamedir", "");
  });

  test("7. repeated switches do not accumulate stale mounts", () => {
    FS_SetDataRoot([classicRoot]);
    const first = FS_TestSearchPathList().length;
    FS_SetDataRoot([rereleaseRoot]);
    FS_SetDataRoot([classicRoot]);
    expect(FS_TestSearchPathList().length).toBe(first);
  });

  test("8. `data_root` console command drives the same remount, args most-significant first", () => {
    // Without Cbuf_Init the command buffer's maxsize is 0 and every
    // Cbuf_AddText silently overflows -- this suite is self-sufficient
    // (rule 13), so it stands the buffer up itself.
    Cbuf_Init();
    FS_SetDataRoot([rereleaseRoot]);

    Cbuf_AddText("data_root classic\n");
    Cbuf_Execute();
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");

    // The kex-on-original-data form: rerelease primary, classic beneath,
    // maps/ aimed at classic.
    Cbuf_AddText("data_root rerelease classic maps=classic\n");
    Cbuf_Execute();
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");
    expect(textOf("pics/i_health.pcx")).toBe("RERELEASE-HEALTH-PIC");
    expect(textOf("pics/damage_indicator.png")).toBe("RERELEASE-ONLY-PIC");

    Cbuf_AddText("data_root rerelease\n");
    Cbuf_Execute();
    expect(textOf("maps/base1.bsp")).toBe("RERELEASE-BASE1");
  });

  test("9. an unknown tree id or an unconfigured root leaves the mount untouched", () => {
    Cbuf_Init();
    FS_SetDataRoot([classicRoot]);
    const before = FS_TestSearchPathList();

    Cbuf_AddText("data_root nonsense\n");
    Cbuf_Execute();
    expect(FS_TestSearchPathList()).toEqual(before);

    Cbuf_AddText("data_root rerelease maps=nonsense\n");
    Cbuf_Execute();
    expect(FS_TestSearchPathList()).toEqual(before);

    // maps= alone names no tree to mount
    Cbuf_AddText("data_root maps=classic\n");
    Cbuf_Execute();
    expect(FS_TestSearchPathList()).toEqual(before);

    Cvar_ForceSet("data_root_rerelease", "");
    Cbuf_AddText("data_root rerelease\n");
    Cbuf_Execute();
    expect(FS_TestSearchPathList()).toEqual(before);
    Cvar_ForceSet("data_root_rerelease", rereleaseRoot);

    FS_SetDataRoot([]);
    expect(FS_TestSearchPathList()).toEqual(before);
  });
});

// ===========================================================================

describe("menu_content.ts -- per-tree availability is scanned, not assumed", () => {
  let tmp: string;
  let classicRoot: string;
  let rereleaseRoot: string;
  let scans: DataTreeScans;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "q2treescan-"));
    classicRoot = join(tmp, "classic");
    rereleaseRoot = join(tmp, "rerelease");

    // Classic tree: the four id campaigns in their own gamedirs, plus a
    // classic-only mod, plus a discovered mod. No mguhub, no q64.
    mkdirSync(join(classicRoot, "baseq2"), { recursive: true });
    writePak(join(classicRoot, "baseq2", "pak0.pak"), [{ name: "maps/base1.bsp", body: "x" }]);
    mkdirSync(join(classicRoot, "xatrix"), { recursive: true });
    writePak(join(classicRoot, "xatrix", "pak0.pak"), [{ name: "maps/xswamp.bsp", body: "x" }]);
    mkdirSync(join(classicRoot, "rogue"), { recursive: true });
    writePak(join(classicRoot, "rogue", "pak0.pak"), [{ name: "maps/rmine1.bsp", body: "x" }]);
    mkdirSync(join(classicRoot, "ctf"), { recursive: true });
    writePak(join(classicRoot, "ctf", "pak0.pak"), [{ name: "maps/q2ctf1.bsp", body: "x" }]);
    mkdirSync(join(classicRoot, "lmctf", "maps"), { recursive: true });
    writeFileSync(join(classicRoot, "lmctf", "maplist.txt"), "lmctf09\n");
    writeFileSync(join(classicRoot, "lmctf", "maps", "lmctf09.bsp"), "");
    mkdirSync(join(classicRoot, "classicmod", "maps"), { recursive: true });
    writeFileSync(join(classicRoot, "classicmod", "maps", "cm1.bsp"), "");

    // Rerelease tree: one monolithic baseq2 pak holding every campaign
    // (this is the real shape -- the rerelease has no xatrix/rogue/ctf
    // gamedirs on disk at all), plus its own discovered mod.
    mkdirSync(join(rereleaseRoot, "baseq2"), { recursive: true });
    writeFileSync(join(rereleaseRoot, "Q2Game.kpf"), "not-a-real-zip");
    writePak(join(rereleaseRoot, "baseq2", "pak0.pak"), [
      { name: "maps/base1.bsp", body: "x" },
      { name: "maps/xswamp.bsp", body: "x" },
      { name: "maps/rmine1.bsp", body: "x" },
      { name: "maps/q2ctf1.bsp", body: "x" },
      { name: "maps/mguhub.bsp", body: "x" },
      { name: "maps/q64/rtest.bsp", body: "x" },
    ]);
    mkdirSync(join(rereleaseRoot, "kexmod", "maps"), { recursive: true });
    writeFileSync(join(rereleaseRoot, "kexmod", "maps", "km1.bsp"), "");

    scans = {
      classic: ScanDataTree(realSeam, "classic", classicRoot),
      rerelease: ScanDataTree(realSeam, "rerelease", rereleaseRoot),
    };
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    ResetDataTreeScanCache();
  });

  function curated(id: ContentId): SelectableGame {
    const content = CONTENT_LIST.find((c) => c.id === id);
    if (!content) throw new Error(`no content ${id}`);
    return { kind: "curated", content };
  }

  test("10. the scan reads maps out of PAK DIRECTORIES, not just loose files", () => {
    expect(scans.classic.mapsByGamedir.get("baseq2")?.has("base1")).toBe(true);
    expect(scans.classic.mapsByGamedir.get("xatrix")?.has("xswamp")).toBe(true);
    // subdirectory names survive, exactly as a LaunchPlan.map spells them
    expect(scans.rerelease.mapsByGamedir.get("baseq2")?.has("q64/rtest")).toBe(true);
    // loose maps/ still counted
    expect(scans.classic.mapsByGamedir.get("lmctf")?.has("lmctf09")).toBe(true);
  });

  test("11. an absent / unconfigured root scans as not present", () => {
    expect(ScanDataTree(realSeam, "rerelease", "").present).toBe(false);
    expect(ScanDataTree(realSeam, "rerelease", join(tmp, "nothing-here")).present).toBe(false);
  });

  test("12. availability matrix matches what each fixture tree actually holds", () => {
    const inTree = (id: ContentId, ruleset: "classic" | "rerelease", tree: "classic" | "rerelease"): boolean => {
      const plan = ResolveLaunch(id, ruleset);
      return plan !== null && LaunchPlanRunsInTree(plan, scans[tree]);
    };

    // The four id campaigns exist under the classic ruleset in BOTH trees.
    for (const id of ["baseq2", "xatrix", "rogue", "ctf"] as const) {
      expect(inTree(id, "classic", "classic")).toBe(true);
      expect(inTree(id, "classic", "rerelease")).toBe(true);
    }
    // ...and under the kex ruleset in both, since kex plays off baseq2.
    expect(inTree("baseq2", "rerelease", "classic")).toBe(true);
    expect(inTree("baseq2", "rerelease", "rerelease")).toBe(true);

    // Rerelease-only content is absent from the classic tree.
    expect(inTree("mg2", "rerelease", "classic")).toBe(false);
    expect(inTree("mg2", "rerelease", "rerelease")).toBe(true);
    expect(inTree("n64", "rerelease", "classic")).toBe(false);
    expect(inTree("n64", "rerelease", "rerelease")).toBe(true);

    // Classic-only content is absent from the rerelease tree.
    expect(inTree("lmctf", "classic", "classic")).toBe(true);
    expect(inTree("lmctf", "classic", "rerelease")).toBe(false);
  });

  test("13. AvailableDataTreesFor: both trees for shared content, one for exclusive content", () => {
    expect(AvailableDataTreesFor(curated("baseq2"), "classic", scans)).toEqual(["classic", "rerelease"]);
    expect(AvailableDataTreesFor(curated("baseq2"), "rerelease", scans)).toEqual(["classic", "rerelease"]);
    expect(AvailableDataTreesFor(curated("lmctf"), "classic", scans)).toEqual(["classic"]);
    expect(AvailableDataTreesFor(curated("mg2"), "rerelease", scans)).toEqual(["rerelease"]);
  });

  test("14. the ruleset row is NOT data-filtered: content with no tree still resolves both rulesets", () => {
    // Mike's 2026-09-01 ruling. A ruleset is a built-in engine module, so no
    // reading of the installed data may remove one -- this used to be
    // AvailableRulesetsForGameInTrees, which emptied the ruleset row for mg2
    // on a machine with no rerelease tree (the row then drew NO value at all).
    const classicOnly: DataTreeScans = {
      classic: scans.classic,
      rerelease: ScanDataTree(realSeam, "rerelease", ""),
    };

    // The mount-planning question still answers honestly...
    expect(AvailableDataTreesFor(curated("baseq2"), "rerelease", classicOnly)).toEqual([]);
    // ...but every content still has a launch plan under BOTH rulesets, which
    // is what lets the menu row cycle them unconditionally.
    for (const id of ["baseq2", "xatrix", "rogue", "ctf", "mg2", "n64", "lmctf"] as const) {
      for (const ruleset of ["classic", "rerelease"] as const) {
        const plan = ResolveLaunchForGame(curated(id), ruleset, "");
        expect(plan).not.toBeNull();
        expect(plan?.map.length).toBeGreaterThan(0);
        // the ruleset picks the game MODULE
        expect(plan?.game).toBe(ruleset === "rerelease" ? "kex" : (ResolveLaunch(id, "classic")?.game ?? ""));
      }
    }
  });

  test("15. DataTreesForGame: which trees hold a content's maps, ruleset-independent", () => {
    // shared campaigns live in both fixture trees
    expect(DataTreesForGame(curated("baseq2"), scans)).toEqual(["classic", "rerelease"]);
    expect(DataTreesForGame(curated("xatrix"), scans)).toEqual(["classic", "rerelease"]);
    // rerelease-only and classic-only content each name their one tree
    expect(DataTreesForGame(curated("mg2"), scans)).toEqual(["rerelease"]);
    expect(DataTreesForGame(curated("n64"), scans)).toEqual(["rerelease"]);
    expect(DataTreesForGame(curated("lmctf"), scans)).toEqual(["classic"]);
    // discovered mods are placed by the tree that actually has the directory
    expect(DataTreesForGame({ kind: "discovered", dirname: "classicmod" }, scans)).toEqual(["classic"]);
    expect(DataTreesForGame({ kind: "discovered", dirname: "kexmod" }, scans)).toEqual(["rerelease"]);
  });

  test("16. discovered mods are listed across both trees, with PLAIN names (no tree suffix)", () => {
    const discovered = DiscoverGameDirsInTrees(scans);
    expect(discovered).toContain("classicmod");
    expect(discovered).toContain("kexmod");
    // curated gamedirs are never double-listed as discoveries
    expect(discovered).not.toContain("xatrix");
    expect(discovered).not.toContain("lmctf");

    // Mike's 2026-09-01 finding 2: the content row names the GAME and nothing
    // else. "Quake II (original)" / "classicmod (original)" are gone -- the
    // maps/data row is where the tree is chosen.
    expect(GameListDisplayName({ kind: "discovered", dirname: "classicmod" })).toBe("classicmod");
    expect(GameListDisplayName(curated("baseq2"))).toBe("Quake II");
    expect(GameListDisplayName(curated("mg2"))).toBe("Call of the Machine");
    for (const content of CONTENT_LIST) {
      expect(content.name).not.toMatch(/\((original|re-release|map pack)\)/);
    }
  });

  test("17. GamesWithData drops content no tree holds, and never empties the row", () => {
    const all = BuildGameList(DiscoverGameDirsInTrees(scans));
    const listed = GamesWithData(all, scans).map((g) => GameListDisplayName(g));
    // every fixture campaign is installed somewhere, so all survive
    expect(listed).toContain("Quake II");
    expect(listed).toContain("Call of the Machine");
    expect(listed).toContain("Lithium CTF");
    expect(listed).toContain("classicmod");

    // A tree pair the scan can read nothing out of must not empty the row --
    // an optimistic list beats a blank screen.
    const blind: DataTreeScans = {
      classic: ScanDataTree(realSeam, "classic", ""),
      rerelease: ScanDataTree(realSeam, "rerelease", ""),
    };
    expect(GamesWithData(all, blind).length).toBe(all.length);

    // Curated content no tree holds IS dropped...
    const classicOnly: DataTreeScans = { classic: scans.classic, rerelease: ScanDataTree(realSeam, "rerelease", "") };
    const classicOnlyNames = GamesWithData(all, classicOnly).map((g) => GameListDisplayName(g));
    expect(classicOnlyNames).toContain("Quake II");
    expect(classicOnlyNames).not.toContain("Call of the Machine");

    // ...but a DISCOVERED gamedir never is. It was found by a directory scan
    // of basedir/homedir, which are not the data trees, so a tree that has
    // never heard of it is not evidence that it is missing.
    const mod: SelectableGame = { kind: "discovered", dirname: "somemod-not-in-any-tree" };
    expect(GamesWithData([...all, mod], scans)).toContain(mod);
    expect(GamesWithData([...all, mod], classicOnly)).toContain(mod);
  });
});

// ===========================================================================

describe("menu_content.ts -- (ruleset, tree) -> mount plan and launch sequence", () => {
  test("16. DataMountPlanFor encodes both of Mike's rules", () => {
    // (b) classic ruleset: whichever single tree was picked, alone, and no
    // carve-out -- classic + original data is classic EVERYTHING.
    expect(DataMountPlanFor("classic", "classic")).toEqual({ primary: "classic", fallback: null, mapsFrom: null });
    expect(DataMountPlanFor("classic", "rerelease")).toEqual({ primary: "rerelease", fallback: null, mapsFrom: null });

    // (a) kex ruleset on ORIGINAL data (Mike, 2026-09-01: "if we are playing
    // with a specific ruleset, we use the things from that ruleset"):
    // rerelease assets win everywhere, classic supplies maps/ only.
    expect(DataMountPlanFor("rerelease", "classic")).toEqual({ primary: "rerelease", fallback: "classic", mapsFrom: "classic" });

    // (a) kex ruleset on rerelease data: rerelease alone, nothing to
    // disambiguate.
    expect(DataMountPlanFor("rerelease", "rerelease")).toEqual({ primary: "rerelease", fallback: null, mapsFrom: null });
  });

  // The launch sequence is captured by standing in for the four commands
  // PerformLaunch queues, then draining the real Cbuf -- so what is asserted
  // is the ORDER the engine would actually execute them in, not a string.
  function captureLaunch(run: () => void): string[] {
    // Fresh buffer per capture: stands the Cbuf up (its maxsize is 0 until
    // Cbuf_Init runs) and drops anything a previous capture left queued.
    Cbuf_Init();
    const seen: string[] = [];
    const names = ["loading", "killserver", "data_root", "map"] as const;
    const restore: string[] = [];

    for (const name of names) {
      if (Cmd_Exists(name)) Cmd_RemoveCommand(name);
      restore.push(name);
      Cmd_AddCommand(name, () => {
        const args = Cmd_Args();
        seen.push(args.length ? `${name} ${args}` : name);
      });
    }

    try {
      run();
      // "wait" ends a Cbuf_Execute pass; the sequence spans several passes.
      for (let i = 0; i < 16; i++) Cbuf_Execute();
    } finally {
      for (const name of restore) Cmd_RemoveCommand(name);
    }
    return seen;
  }

  test("17. PerformLaunch queues data_root between killserver and map", () => {
    const paths = FS_TestSnapshotSearchPaths();
    const savedGame = Cvar_VariableString("game");
    try {
      const plan = ResolveLaunch("baseq2", "rerelease");
      expect(plan).not.toBeNull();
      if (!plan) return;

      // kex ruleset + ORIGINAL data -> rerelease primary, classic beneath,
      // maps/ from classic
      const kexOnClassic = captureLaunch(() => {
        PerformLaunch(plan, "base1", 1, false, DataMountPlanFor("rerelease", "classic"));
      });
      expect(kexOnClassic).toEqual(["loading", "killserver", "data_root rerelease classic maps=classic", "map base1"]);

      // kex ruleset + rerelease data -> a single root
      const kexOnRerelease = captureLaunch(() => {
        PerformLaunch(plan, "base1", 1, false, DataMountPlanFor("rerelease", "rerelease"));
      });
      expect(kexOnRerelease).toEqual(["loading", "killserver", "data_root rerelease", "map base1"]);

      // classic ruleset + original data -> a single root
      const classicPlan = ResolveLaunch("baseq2", "classic");
      expect(classicPlan).not.toBeNull();
      if (!classicPlan) return;
      const classicOnClassic = captureLaunch(() => {
        PerformLaunch(classicPlan, "base1", 1, false, DataMountPlanFor("classic", "classic"));
      });
      expect(classicOnClassic).toEqual(["loading", "killserver", "data_root classic", "map base1"]);

      // No data plan at all -> the pre-feature sequence, unchanged.
      const noMount = captureLaunch(() => {
        PerformLaunch(classicPlan, "base1", 1, false);
      });
      expect(noMount).toEqual(["loading", "killserver", "map base1"]);
    } finally {
      Cvar_ForceSet("game", savedGame);
      FS_TestRestoreSearchPaths(paths);
    }
  });
});

// ===========================================================================

const RETAIL_PRESENT = existsSync(join(CLASSIC_INSTALL, "baseq2", "pak0.pak")) && existsSync(join(RERELEASE_INSTALL, "baseq2", "pak0.pak"));

describe.if(RETAIL_PRESENT)("RETAIL-GATED -- the two real installs on this machine", () => {
  let saved: SavedState;
  let scans: DataTreeScans;

  beforeAll(() => {
    saved = saveState();
    ResetDataTreeScanCache();
    scans = {
      classic: ScanDataTree(realSeam, "classic", CLASSIC_INSTALL),
      rerelease: ScanDataTree(realSeam, "rerelease", RERELEASE_INSTALL),
    };
  });

  afterAll(() => {
    restoreState(saved);
  });

  test("18. auto-detection classifies the two real trees correctly", () => {
    expect(FS_RootIsRerelease(RERELEASE_INSTALL)).toBe(true);
    expect(FS_RootIsRerelease(CLASSIC_INSTALL)).toBe(false);
  });

  test("19. the real availability matrix", () => {
    const has = (tree: "classic" | "rerelease", dir: string, map: string): boolean => scans[tree].mapsByGamedir.get(dir)?.has(map) === true;

    // Both trees carry all four id campaigns -- the classic one in per-
    // expansion gamedirs, the rerelease one in its single baseq2 pak.
    expect(has("classic", "baseq2", "base1")).toBe(true);
    expect(has("classic", "xatrix", "xswamp")).toBe(true);
    expect(has("classic", "rogue", "rmine1")).toBe(true);
    expect(has("classic", "ctf", "q2ctf1")).toBe(true);

    expect(has("rerelease", "baseq2", "base1")).toBe(true);
    expect(has("rerelease", "baseq2", "xswamp")).toBe(true);
    expect(has("rerelease", "baseq2", "rmine1")).toBe(true);
    expect(has("rerelease", "baseq2", "q2ctf1")).toBe(true);

    // Rerelease-only content really is rerelease-only.
    expect(has("rerelease", "baseq2", "mguhub")).toBe(true);
    expect(has("rerelease", "baseq2", "q64/rtest")).toBe(true);
    expect(has("classic", "baseq2", "mguhub")).toBe(false);
    expect(has("classic", "baseq2", "q64/rtest")).toBe(false);

    // lmctf really is classic-only.
    expect(has("classic", "lmctf", "lmctf09")).toBe(true);
    expect(scans.rerelease.mapsByGamedir.has("lmctf")).toBe(false);
  });

  test("20. kex ruleset ALWAYS ends up with the rerelease tree mounted, whichever data the player picked", () => {
    for (const tree of ["classic", "rerelease"] as const) {
      const mount = DataMountPlanFor("rerelease", tree);
      const mounted = [mount.primary, ...(mount.fallback ? [mount.fallback] : [])];
      expect(mounted).toContain("rerelease");
      // and the rerelease tree is the PRIMARY one either way, per Mike's
      // "we use the things from that ruleset" ruling.
      expect(mount.primary).toBe("rerelease");
    }
  });

  function bootClassicBasedir(): void {
    Cvar_ForceSet("basedir", CLASSIC_INSTALL);
    Cvar_ForceSet("homedir", "");
    Cvar_ForceSet("cddir", "");
    Cvar_ForceSet("content_root", "");
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("gamedir", "");
    FS_InitFilesystem();
  }

  function sizeOf(path: string): number {
    const raw = FS_LoadFile(path);
    return raw ? raw.length : -1;
  }

  test("21. classic ruleset on original data mounts the classic tree ALONE -- no rerelease mount, no carve-out", () => {
    const mount = DataMountPlanFor("classic", "classic");
    expect(mount.fallback).toBeNull();
    expect(mount.mapsFrom).toBeNull();
    expect(mount.primary).toBe("classic");

    bootClassicBasedir();
    FS_SetDataRoot([CLASSIC_INSTALL]);

    // Classic everything: the 1997 map AND a classic-tree HUD pic. The pic's
    // exact bytes depend on which of the tree's paks wins: every .pak in
    // baseq2 mounts now (this install's buzzpak.pak carries its own
    // pics/i_health.pcx above pak6's 1353-byte and pak0's 1477-byte ones),
    // so the assertion is "present" rather than a single pak's size.
    expect(sizeOf("maps/base1.bsp")).toBe(1991536);
    expect(sizeOf("pics/i_health.pcx")).toBeGreaterThan(0);

    // Nothing from the rerelease tree is mounted at all.
    expect(FS_TestSearchPathList().some((p) => p.startsWith(RERELEASE_INSTALL))).toBe(false);
    expect(sizeOf("pics/damage_indicator.png")).toBe(-1);
    expect(sizeOf("pics/i_armor_shard.pcx")).toBe(-1);
  });

  test("22. kex on ORIGINAL data: RERELEASE pics/fonts win, CLASSIC map geometry wins", () => {
    bootClassicBasedir();

    // Baseline: what each tree alone reports, so the combined mount's
    // numbers below are attributable to a specific tree rather than asserted
    // against hardcoded constants alone.
    FS_SetDataRoot([CLASSIC_INSTALL]);
    const classicBsp = sizeOf("maps/base1.bsp");
    const classicHealth = sizeOf("pics/i_health.pcx");
    const classicInventory = sizeOf("pics/inventory.pcx");

    FS_SetDataRoot([RERELEASE_INSTALL]);
    const rereleaseBsp = sizeOf("maps/base1.bsp");
    const rereleaseHealth = sizeOf("pics/i_health.pcx");
    const rereleaseInventory = sizeOf("pics/inventory.pcx");

    // The two trees really do differ on all three, or the test proves nothing.
    expect(classicBsp).not.toBe(rereleaseBsp);
    expect(classicHealth).not.toBe(rereleaseHealth);
    expect(classicInventory).not.toBe(rereleaseInventory);

    // The real kex-on-original-data mount, exactly as DataMountPlanFor
    // describes it: rerelease primary, classic beneath, maps/ from classic.
    const mount = DataMountPlanFor("rerelease", "classic");
    expect(mount).toEqual({ primary: "rerelease", fallback: "classic", mapsFrom: "classic" });
    FS_SetDataRoot([CLASSIC_INSTALL, RERELEASE_INSTALL], CLASSIC_INSTALL);

    // MAPS: the player's 1997 geometry.
    expect(sizeOf("maps/base1.bsp")).toBe(classicBsp);
    expect(sizeOf("maps/base1.bsp")).toBe(1991536);

    // EVERYTHING ELSE: the kex ruleset's own assets.
    expect(sizeOf("pics/i_health.pcx")).toBe(rereleaseHealth);
    expect(sizeOf("pics/inventory.pcx")).toBe(rereleaseInventory);
    expect(sizeOf("pics/i_armor_shard.pcx")).toBe(1503);
    expect(sizeOf("pics/damage_indicator.png")).toBe(2149);
    expect(sizeOf("fonts/qconfont.kfont")).toBe(5202);
    expect(sizeOf("mapdb.json")).toBe(40120);

    // A rerelease-only map is still reachable -- the carve-out reorders, it
    // does not restrict.
    expect(sizeOf("maps/mguhub.bsp")).toBeGreaterThan(0);
  });

  test("23. the expansions' maps also come from the classic tree under kex + original data", () => {
    bootClassicBasedir();

    FS_SetDataRoot([CLASSIC_INSTALL]);
    Cvar_ForceSet("gamedir", "xatrix");
    FS_SetDataRoot([CLASSIC_INSTALL], "");
    const classicXswamp = sizeOf("maps/xswamp.bsp");

    FS_SetDataRoot([RERELEASE_INSTALL]);
    const rereleaseXswamp = sizeOf("maps/xswamp.bsp");
    expect(classicXswamp).not.toBe(rereleaseXswamp);

    FS_SetDataRoot([CLASSIC_INSTALL, RERELEASE_INSTALL], CLASSIC_INSTALL);
    expect(sizeOf("maps/xswamp.bsp")).toBe(classicXswamp);

    Cvar_ForceSet("gamedir", "");
  });
});
