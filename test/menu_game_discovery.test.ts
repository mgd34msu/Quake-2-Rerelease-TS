/*
Tests for the New Game screen's game-list DISCOVERY and per-game start-
point enumeration (Mike's ruling, 2026-08-31, quoted for the ledger: "we
need to be able to select the game as well, because otherwise how will we
know which maps to use ... the maps should come from whatever is available
as a game") plus the same day's addendum ("in the case of the single
player campaigns where map order is known, at least have them selectable
in that order").

Covers, per the task brief:
  1. DiscoverGameDirs: a mkdtemp fixture basedir with four candidate
     gamedirs -- one with a .pak only, one with a maps/ subdir only, one
     with a maplist.txt only, one with none of the three ("empty-invalid")
     -- asserts the first three qualify and the fourth doesn't, and that a
     curated-table dirname ("xatrix") is excluded from discovery even
     though it qualifies on disk.
  2. BuildGameList ordering: the famous CONTENT_LIST entries come first,
     discovered gamedirs appended after.
  3. StartPointsForGamedir / ParseMaplistTxt: the (b) maplist.txt > (c)
     maps/*.bsp priority, file order preserved for (b), alphabetical for
     (c), and the "neither present" empty case.
  4. StartPointsForSelection: the addendum's full priority chain --
     mapdb wins under a ruleset that used to be excluded from it
     ("classic"), and the static single-default ([]) fallback when mapdb
     has nothing and no on-disk source has anything either.
  5. LaunchPlanForDiscovered / ResolveLaunchForGame: the exact LaunchPlan
     shape bullet 3 specifies, and that it drives the real game cvar
     through PerformLaunch.
  6. menu.ts wiring: M_Menu_Content_f (reload-on-open) actually discovers
     a real mkdtemp gamedir and BeginContentFunc launches it with the
     right game cvar, reached by simulating the same K_RIGHTARROW keypress
     Default_MenuKey's real key handling uses to advance the "content"
     spincontrol (Content_MenuKey is exported as a test seam for exactly
     this, same pattern as this file's existing FS_Test* seams).

Self-sufficient per PORTING.md rule 13: every describe block mounts and
tears down its own mkdtemp fixture; the fs_searchpaths/fs_basedir/fs_homedir/
"game" cvar state a real FS_InitFilesystem() call touches is snapshotted
and restored exactly like test/fs_homedir.test.ts's own pattern, and the
one test that moves a shared MenulistS's curvalue away from 0 restores it
before returning so it never leaks into another test in this file or a
later full-suite run.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { Com_SetServerState } from "../src/qcommon/common";
import {
  FS_ListFiles,
  FS_ListPackFileEntries,
  FS_ReadRawFile,
  FS_InitFilesystem,
  FS_TestSnapshotSearchPaths,
  FS_TestRestoreSearchPaths,
  type FsSearchPathSnapshotT,
} from "../src/qcommon/files";
import { MapDB_Init, MapDB_Shutdown } from "../src/qcommon/mapdb";
import {
  CONTENT_LIST,
  DiscoverGameDirs,
  BuildGameList,
  GameListDisplayName,
  StartPointsForGamedir,
  StartPointsForSelection,
  UnitsForContent,
  ParseMaplistTxt,
  LaunchPlanForDiscovered,
  ResolveLaunchForGame,
  PerformLaunch,
  type GameFsSeam,
  type SelectableGame,
  type ContentId,
} from "../src/client/menu_content";
import { M_Menu_Content_f, BeginContentFunc, Content_MenuKey } from "../src/client/menu";
import { K_RIGHTARROW, K_LEFTARROW } from "../src/client/keys";

// The real, production seam: files.ts's FS_ListFiles/FS_ReadRawFile
// already operate on literal filesystem paths with no dependency on which
// gamedir is mounted (see each function's own header comment) -- exactly
// what lets a test point this straight at a mkdtemp() fixture tree with no
// FS_InitFilesystem/cvar setup at all.
const realSeam: GameFsSeam = {
  listFiles: FS_ListFiles,
  readTextFile: (path) => {
    const raw = FS_ReadRawFile(path);
    return raw ? new TextDecoder().decode(raw) : null;
  },
  listPakEntries: FS_ListPackFileEntries,
};

describe("menu_content.ts -- DiscoverGameDirs over a mkdtemp fixture basedir", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2discover-"));

    // baseq2 itself -- must never be discovered, regardless of contents.
    mkdirSync(join(tmpRoot, "baseq2"), { recursive: true });

    // qualifies via "at least one .pak"
    mkdirSync(join(tmpRoot, "pakonly"), { recursive: true });
    writeFileSync(join(tmpRoot, "pakonly", "data.pak"), "fake pak bytes");

    // qualifies via "a maps/ subdir" (existence, not non-emptiness)
    mkdirSync(join(tmpRoot, "mapsonly", "maps"), { recursive: true });

    // qualifies via "a maplist.txt"
    mkdirSync(join(tmpRoot, "maplistonly"), { recursive: true });
    writeFileSync(join(tmpRoot, "maplistonly", "maplist.txt"), "somemap\n");

    // none of the three -- must NOT be discovered
    mkdirSync(join(tmpRoot, "emptyinvalid"), { recursive: true });

    // a curated-table dirname that WOULD qualify on disk -- must still be
    // excluded, proving the curated-table exclusion beats on-disk qualification.
    mkdirSync(join(tmpRoot, "xatrix"), { recursive: true });
    writeFileSync(join(tmpRoot, "xatrix", "data.pak"), "fake pak bytes");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("1. discovers pakonly/mapsonly/maplistonly, sorted; skips baseq2, emptyinvalid, and the curated xatrix", () => {
    const discovered = DiscoverGameDirs(realSeam, [tmpRoot]);
    expect(discovered).toEqual(["maplistonly", "mapsonly", "pakonly"]);
  });

  test("2. an empty root list produces no discoveries (no throw)", () => {
    expect(DiscoverGameDirs(realSeam, [])).toEqual([]);
    expect(DiscoverGameDirs(realSeam, [""])).toEqual([]);
  });

  test("3. BuildGameList: famous CONTENT_LIST entries first, discovered gamedirs appended after", () => {
    const discovered = DiscoverGameDirs(realSeam, [tmpRoot]);
    const gameList = BuildGameList(discovered);

    expect(gameList.length).toBe(CONTENT_LIST.length + discovered.length);

    for (let i = 0; i < CONTENT_LIST.length; i++) {
      const entry = gameList[i];
      expect(entry?.kind).toBe("curated");
      if (entry?.kind === "curated") expect(entry.content.id).toBe(CONTENT_LIST[i]?.id);
    }

    for (let i = 0; i < discovered.length; i++) {
      const entry = gameList[CONTENT_LIST.length + i];
      expect(entry?.kind).toBe("discovered");
      if (entry?.kind === "discovered") expect(entry.dirname).toBe(discovered[i]);
    }

    expect(gameList.map(GameListDisplayName)).toEqual([...CONTENT_LIST.map((c) => c.name), ...discovered]);
  });
});

describe("menu_content.ts -- StartPointsForGamedir / ParseMaplistTxt priority", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2startpoints-"));

    // (b) wins over (c) even when both are present -- maplist.txt's own
    // entries never get pulled from the maps/ dir's (different) contents.
    mkdirSync(join(tmpRoot, "withMaplist", "maps"), { recursive: true });
    writeFileSync(join(tmpRoot, "withMaplist", "maplist.txt"), "foo\r\nbar\nbaz\n");
    writeFileSync(join(tmpRoot, "withMaplist", "maps", "zzz.bsp"), "");
    writeFileSync(join(tmpRoot, "withMaplist", "maps", "aaa.bsp"), "");

    // no maplist.txt -- (c) bsp scan, alphabetical
    mkdirSync(join(tmpRoot, "bspOnly", "maps"), { recursive: true });
    writeFileSync(join(tmpRoot, "bspOnly", "maps", "zzz.bsp"), "");
    writeFileSync(join(tmpRoot, "bspOnly", "maps", "mmm.bsp"), "");
    writeFileSync(join(tmpRoot, "bspOnly", "maps", "aaa.bsp"), "");

    // an EMPTY maplist.txt (present, but no usable lines) falls through to
    // the bsp scan rather than returning zero entries outright.
    mkdirSync(join(tmpRoot, "emptyMaplist", "maps"), { recursive: true });
    writeFileSync(join(tmpRoot, "emptyMaplist", "maplist.txt"), "\n\n");
    writeFileSync(join(tmpRoot, "emptyMaplist", "maps", "one.bsp"), "");

    // neither source -- empty result
    mkdirSync(join(tmpRoot, "nothing"), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("4. ParseMaplistTxt: file order preserved, blank lines and CRLF dropped", () => {
    expect(ParseMaplistTxt("foo\r\nbar\nbaz\n")).toEqual([
      { title: "foo", bsp: "foo" },
      { title: "bar", bsp: "bar" },
      { title: "baz", bsp: "baz" },
    ]);
    expect(ParseMaplistTxt("\n\n")).toEqual([]);
  });

  test("5. maplist.txt present and non-empty wins over a maps/ dir with different contents, in file order", () => {
    expect(StartPointsForGamedir(realSeam, join(tmpRoot, "withMaplist"))).toEqual([
      { title: "foo", bsp: "foo" },
      { title: "bar", bsp: "bar" },
      { title: "baz", bsp: "baz" },
    ]);
  });

  test("6. no maplist.txt: maps/*.bsp scan, alphabetical (explicitly the last resort)", () => {
    expect(StartPointsForGamedir(realSeam, join(tmpRoot, "bspOnly"))).toEqual([
      { title: "aaa", bsp: "aaa" },
      { title: "mmm", bsp: "mmm" },
      { title: "zzz", bsp: "zzz" },
    ]);
  });

  test("7. an empty maplist.txt falls through to the bsp scan", () => {
    expect(StartPointsForGamedir(realSeam, join(tmpRoot, "emptyMaplist"))).toEqual([{ title: "one", bsp: "one" }]);
  });

  test("8. neither maplist.txt nor maps/*.bsp: empty result", () => {
    expect(StartPointsForGamedir(realSeam, join(tmpRoot, "nothing"))).toEqual([]);
  });

  test("9. extraBspPaths (the active-gamedir FS_ListPakFiles merge) contributes pak-internal names too", () => {
    expect(StartPointsForGamedir(realSeam, join(tmpRoot, "nothing"), ["maps/packed.bsp"])).toEqual([{ title: "packed", bsp: "packed" }]);
  });
});

describe("menu_content.ts -- StartPointsForSelection (Mike's 2026-08-31 addendum priority chain)", () => {
  const baseq2Game: SelectableGame = { kind: "curated", content: CONTENT_LIST[0] as (typeof CONTENT_LIST)[number] };
  const fakeMapdbUnits = [
    { title: "Unit 1: Base", bsp: "base1" },
    { title: "Unit 2: Warehouse", bsp: "bunk1" },
  ];

  test("10. mapdb order wins under the CLASSIC ruleset too -- the old rerelease-only gate is lifted", () => {
    const mapdbUnitsForContent = (_content: ContentId) => fakeMapdbUnits;
    const result = StartPointsForSelection(baseq2Game, "classic", mapdbUnitsForContent, realSeam, ["/does/not/exist"]);
    expect(result).toEqual(fakeMapdbUnits);
  });

  test("11. mapdb order also wins under the RERELEASE ruleset (unchanged pre-existing behavior)", () => {
    const mapdbUnitsForContent = (_content: ContentId) => fakeMapdbUnits;
    const result = StartPointsForSelection(baseq2Game, "rerelease", mapdbUnitsForContent, realSeam, ["/does/not/exist"]);
    expect(result).toEqual(fakeMapdbUnits);
  });

  test("12. falls back to the static single default (empty result) when mapdb has nothing and no on-disk source has anything either", () => {
    const noMapdb = (_content: ContentId) => [];
    const result = StartPointsForSelection(baseq2Game, "classic", noMapdb, realSeam, ["/does/not/exist"]);
    expect(result).toEqual([]);
  });

  test("13. the rerelease ruleset never falls through to an FS scan (the 'kex' gamedir is shared across every rerelease content id)", () => {
    // real disk fixture where a "kex" dir DOES have maps, to prove the
    // rerelease branch still returns [] rather than scanning it.
    const tmpRoot = mkdtempSync(join(tmpdir(), "q2startpoints-kex-"));
    try {
      mkdirSync(join(tmpRoot, "kex", "maps"), { recursive: true });
      writeFileSync(join(tmpRoot, "kex", "maps", "base1.bsp"), "");

      const noMapdb = (_content: ContentId) => [];
      const result = StartPointsForSelection(baseq2Game, "rerelease", noMapdb, realSeam, [tmpRoot]);
      expect(result).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("14. a discovered gamedir (classic-only) uses its own maplist.txt/bsp scan, never mapdb", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "q2startpoints-disc-"));
    try {
      mkdirSync(join(tmpRoot, "buzzmod"), { recursive: true });
      writeFileSync(join(tmpRoot, "buzzmod", "maplist.txt"), "lmctf09\nlmctf10\n");

      const discoveredGame: SelectableGame = { kind: "discovered", dirname: "buzzmod" };
      const shouldNeverBeCalled = (_content: ContentId) => fakeMapdbUnits;
      const result = StartPointsForSelection(discoveredGame, "classic", shouldNeverBeCalled, realSeam, [tmpRoot]);
      expect(result).toEqual([
        { title: "lmctf09", bsp: "lmctf09" },
        { title: "lmctf10", bsp: "lmctf10" },
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("14b. RC FIX (Mike, live report 2026-08-31): a FAMOUS campaign with mapdb absent shows the static default, NEVER the maps/*.bsp scan -- the exact bug shape (dm/ctf names, no campaign order) a bsp scan of a classic gamedir's one flat maps/ folder would otherwise produce", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "q2startpoints-famous-noscan-"));
    try {
      // A classic-style baseq2 tree: sp campaign AND dm/ctf maps all mixed in
      // one flat maps/ dir, no maplist.txt -- exactly the real shape a
      // classic Quake II install ships. Before the fix, StartPointsForSelection
      // would alphabetize this whole mixed bag for a FAMOUS campaign pick.
      mkdirSync(join(tmpRoot, "baseq2", "maps"), { recursive: true });
      writeFileSync(join(tmpRoot, "baseq2", "maps", "base1.bsp"), "");
      writeFileSync(join(tmpRoot, "baseq2", "maps", "q2dm1.bsp"), "");
      writeFileSync(join(tmpRoot, "baseq2", "maps", "q2ctf1.bsp"), "");

      const noMapdb = (_content: ContentId) => [];
      const result = StartPointsForSelection(baseq2Game, "classic", noMapdb, realSeam, [tmpRoot]);
      expect(result).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("14c. the SAME on-disk mixed maps/ dir DOES drive a discovered (unknown) game's browser -- proves 14b's gate is per-game-kind, not a global scan removal", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "q2startpoints-disc-scan-"));
    try {
      mkdirSync(join(tmpRoot, "buzzmod", "maps"), { recursive: true });
      writeFileSync(join(tmpRoot, "buzzmod", "maps", "base1.bsp"), "");
      writeFileSync(join(tmpRoot, "buzzmod", "maps", "q2dm1.bsp"), "");
      writeFileSync(join(tmpRoot, "buzzmod", "maps", "q2ctf1.bsp"), "");

      const discoveredGame: SelectableGame = { kind: "discovered", dirname: "buzzmod" };
      const shouldNeverBeCalled = (_content: ContentId) => fakeMapdbUnits;
      const result = StartPointsForSelection(discoveredGame, "classic", shouldNeverBeCalled, realSeam, [tmpRoot]);
      expect(result).toEqual([
        { title: "base1", bsp: "base1" },
        { title: "q2ctf1", bsp: "q2ctf1" },
        { title: "q2dm1", bsp: "q2dm1" },
      ]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("menu_content.ts -- LaunchPlanForDiscovered / ResolveLaunchForGame", () => {
  beforeAll(() => {
    // Neutralize cvar.ts's "game" cvar CVAR_LATCH-on-server-live special
    // case (see menu_content.test.ts's own header) so PerformLaunch's
    // Cvar_Set("game", ...) always applies immediately here.
    Com_SetServerState(0);
  });

  test("15. LaunchPlanForDiscovered: bullet 3's exact shape -- game=dirname, map=firstMap, startItems empty, ctf undefined", () => {
    const plan = LaunchPlanForDiscovered("buzzmod", "lmctf09");
    expect(plan).toEqual({ game: "buzzmod", map: "lmctf09", startItems: "" });
    expect(plan.ctf).toBeUndefined();
  });

  test("16. ResolveLaunchForGame dispatches to LaunchPlanForDiscovered for a discovered game", () => {
    const discoveredGame: SelectableGame = { kind: "discovered", dirname: "buzzmod" };
    const plan = ResolveLaunchForGame(discoveredGame, "classic", "lmctf09");
    expect(plan).toEqual({ game: "buzzmod", map: "lmctf09", startItems: "" });
  });

  test("17. ResolveLaunchForGame dispatches to the curated table for a curated game (baseq2/classic)", () => {
    const baseq2Game: SelectableGame = { kind: "curated", content: CONTENT_LIST[0] as (typeof CONTENT_LIST)[number] };
    const plan = ResolveLaunchForGame(baseq2Game, "classic", "ignored-for-curated");
    expect(plan).toEqual({ game: "", map: "base1", startItems: "" });
  });

  test("18. a discovered game's LaunchPlan sets the right game cvar value via the real PerformLaunch plumbing", () => {
    const plan = LaunchPlanForDiscovered("buzzmod", "lmctf09");
    PerformLaunch(plan, "lmctf09", null, false);

    expect(Cvar_VariableString("game")).toBe("buzzmod");
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("0");
    expect(Cvar_VariableString("g_start_items")).toBe("");
  });
});

describe("menu.ts wiring -- Content_MenuInit discovers a real mkdtemp gamedir end to end", () => {
  let tmpRoot: string;
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2discover-wiring-"));
    mkdirSync(join(tmpRoot, "baseq2"), { recursive: true });
    mkdirSync(join(tmpRoot, "buzzmod"), { recursive: true });
    writeFileSync(join(tmpRoot, "buzzmod", "maplist.txt"), "arena\n");

    fsSnapshot = FS_TestSnapshotSearchPaths();
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("homedir", "");
    FS_InitFilesystem();
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(fsSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
    MapDB_Shutdown();
  });

  test("19. the discovered 'buzzmod' gamedir is selectable after the curated list and launches with game=\"buzzmod\"", () => {
    Com_SetServerState(0);
    M_Menu_Content_f(); // reload-on-open: DiscoverGameDirs re-scans tmpRoot fresh every call

    // cursor defaults to 0 == the "content" spincontrol (first Menu_AddItem
    // in Content_MenuInit) -- CONTENT_LIST.length real K_RIGHTARROW presses
    // land exactly on the one discovered gamedir appended right after it.
    for (let i = 0; i < CONTENT_LIST.length; i++) Content_MenuKey(K_RIGHTARROW);

    try {
      BeginContentFunc();

      expect(Cvar_VariableString("game")).toBe("buzzmod");
      expect(Cvar_VariableString("deathmatch")).toBe("0");
      expect(Cvar_VariableString("coop")).toBe("0");
    } finally {
      // Restore the shared s_content_list widget's curvalue to 0 so this
      // test never leaks selection state into another test in this
      // process (rule 13/21: self-sufficient, and no landmines for a
      // later full-suite regate).
      for (let i = 0; i < CONTENT_LIST.length; i++) Content_MenuKey(K_LEFTARROW);
    }
  });
});

// RC repro (Mike, live, 2026-08-31): "the New Game screen's 'start at' list
// shows MULTIPLAYER maps (dm/ctf-looking names) and ZERO campaign maps when
// starting a campaign", against the REAL retail rerelease install at the
// exact basedir his launch command uses (no content_root). Same
// retail-install convention as test/cl_demo_retail.test.ts: skip (never
// fail) when this machine has no retail rerelease install.
//
// This investigation's finding (see task report): MapDB_Init() already
// finds mapdb.json fine off a plain `basedir` mount with no content_root at
// all -- FS_LoadFile("mapdb.json") walks the WHOLE fs_searchpaths list
// (files.ts's FS_FOpenFile), and FS_InitFilesystem always mounts
// `${basedir}/baseq2` (files.ts:1226) regardless of content_root, so a
// basedir that IS the rerelease tree already has baseq2/pak0.pak's
// mapdb.json on the search path. The two tests below prove that positively
// (both rulesets); the real bug this RC report was hitting was
// StartPointsForSelection's missing curated-vs-discovered gate on the
// maps/*.bsp scan tier, fixed above (test 14b) and in
// src/client/menu_content.ts's StartPointsForGamedir/StartPointsForSelection.
const RETAIL_ROOT = "/home/buzzkill/q2rets/rerelease";
const haveRetail = existsSync(join(RETAIL_ROOT, "baseq2", "pak0.pak"));

describe.skipIf(!haveRetail)("menu_content.ts -- StartPointsForSelection against REAL retail rerelease data (RC report repro, skipped if the retail install isn't present)", () => {
  const baseq2Game: SelectableGame = { kind: "curated", content: CONTENT_LIST[0] as (typeof CONTENT_LIST)[number] };

  let fsSnapshot: FsSearchPathSnapshotT;
  let prevBasedir: string;
  let prevHomedir: string;

  beforeAll(() => {
    prevBasedir = Cvar_VariableString("basedir");
    prevHomedir = Cvar_VariableString("homedir");
    fsSnapshot = FS_TestSnapshotSearchPaths();

    Cvar_ForceSet("basedir", RETAIL_ROOT);
    Cvar_ForceSet("homedir", "");
    FS_InitFilesystem();
    MapDB_Init();
  });

  afterAll(() => {
    MapDB_Shutdown();
    FS_TestRestoreSearchPaths(fsSnapshot);
    Cvar_ForceSet("basedir", prevBasedir);
    Cvar_ForceSet("homedir", prevHomedir);
  });

  function assertRealCampaignOrder(ruleset: "classic" | "rerelease"): void {
    const units = StartPointsForSelection(baseq2Game, ruleset, UnitsForContent, realSeam, [RETAIL_ROOT]);

    expect(units.length).toBeGreaterThan(0);
    expect(units[0]).toEqual({ title: "Unit 1: Base", bsp: "base1" });

    for (const u of units) {
      expect(u.bsp).not.toMatch(/^q2dm/i);
      expect(u.bsp).not.toMatch(/^q2ctf/i);
      expect(u.bsp).not.toMatch(/^dm\d/i);
    }
  }

  test("mapdb episode order under the CLASSIC ruleset: real campaign units, start unit is base1, no dm/ctf names", () => {
    assertRealCampaignOrder("classic");
  });

  test("mapdb episode order under the RERELEASE ruleset: same real campaign units, no dm/ctf names", () => {
    assertRealCampaignOrder("rerelease");
  });
});
