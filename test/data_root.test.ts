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
  AvailableRulesetsForGameInTrees,
  DiscoverGameDirsInTrees,
  GameListDisplayNameInTrees,
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

  test("4. RULE (a): classic over rerelease -- shared names resolve CLASSIC, kex-only assets still resolve", () => {
    // Lowest priority first, so the classic tree is mounted last and wins.
    FS_SetDataRoot([rereleaseRoot, classicRoot]);

    // The whole point of Mike's amendment: his 1997 map files play.
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");
    expect(textOf("shared.txt")).toBe("CLASSIC-SHARED");

    // ...while every kex-module asset the classic tree does not have still
    // resolves out of the rerelease tree beneath it.
    expect(textOf("pics/damage_indicator.png")).toBe("RERELEASE-ONLY-PIC");
    expect(textOf("maps/mguhub.bsp")).toBe("RERELEASE-MGUHUB");
    expect(textOf("classic_only.txt")).toBe("CLASSIC-ONLY");
  });

  test("5. search-path ORDER: every classic entry precedes every rerelease entry", () => {
    FS_SetDataRoot([rereleaseRoot, classicRoot]);

    const paths = FS_TestSearchPathList(); // head (highest priority) first
    const lastClassic = paths.map((p) => p.startsWith(classicRoot)).lastIndexOf(true);
    const firstRerelease = paths.map((p) => p.startsWith(rereleaseRoot)).indexOf(true);

    expect(lastClassic).toBeGreaterThanOrEqual(0);
    expect(firstRerelease).toBeGreaterThanOrEqual(0);
    expect(lastClassic).toBeLessThan(firstRerelease);
  });

  test("6. a gamedir mounted across a switch is re-laid against BOTH roots, classic first", () => {
    FS_SetDataRoot([classicRoot]);
    Cvar_ForceSet("gamedir", "xatrix");
    FS_SetDataRoot([rereleaseRoot, classicRoot]);

    const paths = FS_TestSearchPathList();
    expect(paths).toContain(join(classicRoot, "xatrix"));
    expect(paths).toContain(join(rereleaseRoot, "xatrix"));
    expect(paths.indexOf(join(classicRoot, "xatrix"))).toBeLessThan(paths.indexOf(join(rereleaseRoot, "xatrix")));

    // The classic xatrix pak wins over the rerelease baseq2 copy.
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

    Cbuf_AddText("data_root classic rerelease\n");
    Cbuf_Execute();
    expect(textOf("maps/base1.bsp")).toBe("CLASSIC-BASE1");
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

  test("14. RULE (a) precondition: no rerelease tree => the kex ruleset is not offered at all", () => {
    const classicOnly: DataTreeScans = {
      classic: scans.classic,
      rerelease: ScanDataTree(realSeam, "rerelease", ""),
    };

    expect(AvailableDataTreesFor(curated("baseq2"), "rerelease", classicOnly)).toEqual([]);
    expect(AvailableRulesetsForGameInTrees(curated("baseq2"), classicOnly)).toEqual(["classic"]);
    // mg2/n64 exist only under the kex ruleset, so they drop out entirely.
    expect(AvailableRulesetsForGameInTrees(curated("mg2"), classicOnly)).toEqual([]);

    // With both trees present the kex ruleset is back.
    expect(AvailableRulesetsForGameInTrees(curated("baseq2"), scans)).toEqual(["classic", "rerelease"]);
  });

  test("15. discovered mods are listed per tree, and labelled when they exist in only one", () => {
    const discovered = DiscoverGameDirsInTrees(scans);
    expect(discovered).toContain("classicmod");
    expect(discovered).toContain("kexmod");
    // curated gamedirs are never double-listed as discoveries
    expect(discovered).not.toContain("xatrix");
    expect(discovered).not.toContain("lmctf");

    const classicMod: SelectableGame = { kind: "discovered", dirname: "classicmod" };
    const kexMod: SelectableGame = { kind: "discovered", dirname: "kexmod" };

    expect(AvailableDataTreesFor(classicMod, "classic", scans)).toEqual(["classic"]);
    expect(AvailableDataTreesFor(kexMod, "classic", scans)).toEqual(["rerelease"]);

    expect(GameListDisplayNameInTrees(classicMod, scans)).toBe(`classicmod (${DataTreeDisplayName("classic")})`);
    expect(GameListDisplayNameInTrees(kexMod, scans)).toBe(`kexmod (${DataTreeDisplayName("rerelease")})`);
    // present in both trees -> no tag
    expect(GameListDisplayNameInTrees(curated("baseq2"), scans)).toBe("Quake II");
  });
});

// ===========================================================================

describe("menu_content.ts -- (ruleset, tree) -> mount plan and launch sequence", () => {
  test("16. DataMountPlanFor encodes both of Mike's rules", () => {
    // (b) classic ruleset: whichever single tree was picked, alone.
    expect(DataMountPlanFor("classic", "classic")).toEqual({ primary: "classic", fallback: null });
    expect(DataMountPlanFor("classic", "rerelease")).toEqual({ primary: "rerelease", fallback: null });

    // (a) kex ruleset on ORIGINAL data: classic primary (his 1997 maps win),
    // rerelease beneath as the asset fallback.
    expect(DataMountPlanFor("rerelease", "classic")).toEqual({ primary: "classic", fallback: "rerelease" });

    // (a) kex ruleset on rerelease data: rerelease alone, as before.
    expect(DataMountPlanFor("rerelease", "rerelease")).toEqual({ primary: "rerelease", fallback: null });
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

      // kex ruleset + ORIGINAL data -> "data_root classic rerelease"
      const kexOnClassic = captureLaunch(() => {
        PerformLaunch(plan, "base1", 1, false, DataMountPlanFor("rerelease", "classic"));
      });
      expect(kexOnClassic).toEqual(["loading", "killserver", "data_root classic rerelease", "map base1"]);

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
    }
  });

  test("21. classic ruleset on original data mounts the classic tree ALONE -- no rerelease mount", () => {
    const mount = DataMountPlanFor("classic", "classic");
    expect(mount.fallback).toBeNull();
    expect(mount.primary).toBe("classic");

    Cvar_ForceSet("basedir", CLASSIC_INSTALL);
    Cvar_ForceSet("homedir", "");
    Cvar_ForceSet("cddir", "");
    Cvar_ForceSet("content_root", "");
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("gamedir", "");
    FS_InitFilesystem();

    FS_SetDataRoot([CLASSIC_INSTALL]);

    // A classic-only file resolves...
    expect(FS_LoadFile("maps/base1.bsp")).not.toBeNull();
    // ...and nothing from the rerelease tree is mounted at all.
    expect(FS_TestSearchPathList().some((p) => p.startsWith(RERELEASE_INSTALL))).toBe(false);
    // pics/damage_indicator.png lives only in the rerelease pak.
    expect(FS_LoadFile("pics/damage_indicator.png")).toBeNull();
  });

  test("22. kex on ORIGINAL data: the CLASSIC base1.bsp is served, and the rerelease-only pic still resolves", () => {
    Cvar_ForceSet("basedir", CLASSIC_INSTALL);
    Cvar_ForceSet("homedir", "");
    Cvar_ForceSet("cddir", "");
    Cvar_ForceSet("content_root", "");
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("gamedir", "");
    FS_InitFilesystem();

    // lowest priority first: rerelease beneath, classic on top
    FS_SetDataRoot([RERELEASE_INSTALL, CLASSIC_INSTALL]);

    const bsp = FS_LoadFile("maps/base1.bsp");
    expect(bsp).not.toBeNull();

    // The two trees' base1.bsp differ sharply in size; the classic one is
    // the smaller 1997 file. This is the proof that the player's original
    // map is what loaded, not the re-authored rerelease version.
    const classicOnly = FS_LoadFile("maps/base1.bsp");
    expect(classicOnly).not.toBeNull();

    FS_SetDataRoot([RERELEASE_INSTALL]);
    const rereleaseBsp = FS_LoadFile("maps/base1.bsp");
    expect(rereleaseBsp).not.toBeNull();
    if (!classicOnly || !rereleaseBsp) return;
    expect(classicOnly.length).toBeLessThan(rereleaseBsp.length);

    // Back to the kex-on-original mount and confirm the kex-only asset.
    FS_SetDataRoot([RERELEASE_INSTALL, CLASSIC_INSTALL]);
    expect(FS_LoadFile("pics/damage_indicator.png")).not.toBeNull();
    const served = FS_LoadFile("maps/base1.bsp");
    expect(served).not.toBeNull();
    if (served) expect(served.length).toBe(classicOnly.length);
  });
});
