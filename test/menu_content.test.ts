/*
Tests for src/qcommon/mapdb.ts and src/client/menu_content.ts (Mike's
Content & Rules selector, 2026-08-30 task brief) plus the new "content &
rules" wiring into src/client/menu.ts's Game menu.

Self-sufficient per PORTING.md rule 13:
  - mapdb.ts's module-level `mapdb` singleton is reset by every test that
    depends on its state (via MapDB_Init()/MapDB_Shutdown() -- both public
    and idempotent, never assumed to carry state from another file).
  - the fixture written to the temp basedir below is a SYNTHETIC file, but
    every field name/shape in it matches the REAL mapdb.json schema
    extracted from ~/q2rets/rerelease/baseq2/pak0.pak on 2026-08-30 (see
    mapdb.ts's own header for the extraction) -- episodes[]/maps[] with
    the exact real field names (note: "bot", not "bots" -- see mapdb.ts's
    field-name-discrepancy comment), including the "cin+*bsp" composite
    launch-string convention real campaign-start entries use.
  - src/qcommon/cvar.ts's "game" cvar has a latch-on-server-live special
    case (FS_SetGamedir hook); Com_SetServerState(0) is forced in
    beforeEach so PerformLaunch's Cvar_Set("game", ...) always applies
    immediately here, regardless of what any other test file in this
    process left `server_state` at.

Covers (8+ cases, per the task brief):
  1. mapdb parse: valid synthetic fixture -> episodes/maps/defaults.
  2. mapdb parse: missing mapdb.json -> empty db, no throw.
  3. mapdb parse: malformed JSON -> empty db, no throw.
  4. MapDB_ResolveBsp: the "cin+*bsp" / plain / star-only cases.
  5. MapDB_UnitsForEpisode: filters to sp:true + the right episode, in
     file order, with bsp already resolved.
  6. Mapping table: every CONTENT_LIST entry has >=1 available ruleset,
     and every (content, ruleset) pair AvailableRulesetsFor reports
     resolves to a valid, non-empty (game, map) LaunchPlan.
  7. Mapping table: the three "only one ruleset" cases (mg2/n64
     rerelease-only, lmctf classic-only) and the shared four's specific
     (game, map) pairs.
  8. Menu integrity: the Game menu's new "content & rules" entry pushes
     the real Content screen (M_Menu_Content_f) without throwing and
     transitions cls.key_dest to key_menu, same assertion style as
     cl_menu.test.ts's own M_PushMenu coverage.
  9. Menu integrity: BeginContentFunc, run against the screen's default
     widget state (fresh MenulistS curvalue 0 for every spincontrol),
     applies exactly the mapping table's baseq2/classic LaunchPlan
     through the real cvar/Cbuf plumbing.
*/

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { CVAR_LATCH } from "../src/shared/q_shared";
import { Com_SetServerState } from "../src/qcommon/common";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { MapDB_Init, MapDB_Get, MapDB_Shutdown, MapDB_ResolveBsp, MapDB_UnitsForEpisode } from "../src/qcommon/mapdb";
import { CONTENT_LIST, RULESETS, AvailableRulesetsFor, ResolveLaunch, PerformLaunch, ResetDataTreeScanCache, type LaunchPlan } from "../src/client/menu_content";
import { M_Menu_Game_f, M_Menu_Content_f, BeginContentFunc, Content_MenuKey, Content_MenuRowsForTests, Content_LayoutForTests } from "../src/client/menu";
import { viddef } from "../src/client/vid";
import { K_DOWNARROW, K_LEFTARROW, K_RIGHTARROW } from "../src/client/keys";
import { CL_Seats_Available } from "../src/client/cl_seats";
import { cls, KeydestT } from "../src/client/client";

const SYNTHETIC_MAPDB = {
  episodes: [
    { id: "baseq2", command: "newgame", name: "Quake II", activity: "start_quake", needsSkillSelect: true },
    { id: "xatrix", command: "newgame_xatrix", name: "The Reckoning", activity: "start_xatrix", needsSkillSelect: true },
  ],
  maps: [
    // plain deathmatch entry, "bot" (real field name) true
    { bsp: "q2dm1", title: "The Edge", episode: "baseq2", dm: true, bot: true },
    // ctf entry (episode "baseq2", not a separate episode -- matches real data)
    { bsp: "q2ctf1", title: "McKinley Revival", episode: "baseq2", ctf: true, tdm: false },
    // campaign-start entries, in authored (unit-ascending) order, exercising
    // every MapDB_ResolveBsp case seen in the real file:
    { bsp: "*ntro.cin+base1", title: "Unit 1: Base", episode: "baseq2", display_bsp: false, sp: true, coop: true },
    { bsp: "eou1_.cin+*bunk1", title: "Unit 2: Warehouse", episode: "baseq2", display_bsp: false, sp: true, coop: true },
    { bsp: "*boss1", title: "Unit 10: Boss", episode: "baseq2", display_bsp: false, sp: true, coop: true },
    // a non-sp, per-level entry under the same episode -- must NOT show up
    // in MapDB_UnitsForEpisode("baseq2")
    { bsp: "base2", title: "Outer Base", episode: "baseq2", unit: 1 },
    // xatrix's own sp entry, to prove episode filtering
    { bsp: "*xin.cin+xswamp", title: "Unit 1: Swamps", episode: "xatrix", display_bsp: false, sp: true, coop: true },
    // an entry with an unrecognized extra key, exercising forward-compat
    // (extra keys are simply ignored, matching q2repro's own tolerant
    // "unknown key -> skip" MapDB_ParseKeys behavior)
    { bsp: "q2dm2", title: "Tokay's Towers", episode: "baseq2", dm: true, someFutureField: "ignored" },
  ],
};

describe("mapdb.ts -- mapdb.json loader", () => {
  // files.ts's FS_InitFilesystem only ever ADDS search roots (fs_searchpaths
  // is a module-level singleton that accumulates for the lifetime of the
  // process -- see files.test.ts's own single beforeAll for the same
  // reason); calling it again per-test would just stack a new, higher-
  // priority baseq2 dir on top of the previous one without ever removing
  // it, so a "missing file" test run after a "valid fixture" test would
  // still resolve mapdb.json from the earlier root. Mount ONE temp basedir
  // once, and mutate/delete the loose mapdb.json file it points at before
  // each test that needs different content -- FS_LoadFile re-reads the
  // loose file from disk on every call (see files.ts's loose/pack
  // precedence comments), so this reflects immediately.
  let tmpRoot: string;
  let mapdbPath: string;

  function setMapdb(contents: string | null): void {
    if (contents === null) rmSync(mapdbPath, { force: true });
    else writeFileSync(mapdbPath, contents);
  }

  beforeEach(() => {
    if (tmpRoot) return;
    tmpRoot = mkdtempSync(join(tmpdir(), "q2mapdb-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir);
    mapdbPath = join(baseq2Dir, "mapdb.json");
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    MapDB_Shutdown();
  });

  test("1. parses a real-schema fixture: episodes, maps, and per-field defaults for absent keys", () => {
    setMapdb(JSON.stringify(SYNTHETIC_MAPDB));
    MapDB_Init();

    const db = MapDB_Get();
    expect(db.episodes.length).toBe(2);
    expect(db.maps.length).toBe(8);

    const baseq2Episode = db.episodes.find((e) => e.id === "baseq2");
    expect(baseq2Episode).toBeDefined();
    expect(baseq2Episode?.command).toBe("newgame");
    expect(baseq2Episode?.name).toBe("Quake II");
    expect(baseq2Episode?.needsSkillSelect).toBe(true);

    const dm1 = db.maps.find((m) => m.bsp === "q2dm1");
    expect(dm1).toBeDefined();
    // real field name "bot" (see header/mapdb.ts discrepancy note), not "bots"
    expect(dm1?.bot).toBe(true);
    expect(dm1?.dm).toBe(true);
    // absent keys default like a C mallocz zero-init: "" / 0 / false
    expect(dm1?.short).toBe("");
    expect(dm1?.unit).toBe(0);
    expect(dm1?.sp).toBe(false);
    expect(dm1?.start_items).toBe("");

    const ctf1 = db.maps.find((m) => m.bsp === "q2ctf1");
    expect(ctf1?.ctf).toBe(true);
    expect(ctf1?.tdm).toBe(false);

    // the unrecognized "someFutureField" key must not break parsing
    const dm2 = db.maps.find((m) => m.bsp === "q2dm2");
    expect(dm2).toBeDefined();
    expect(dm2?.dm).toBe(true);
  });

  test("2. missing mapdb.json: MapDB_Get returns an empty db, does not throw", () => {
    setMapdb(null);

    expect(() => MapDB_Init()).not.toThrow();
    const db = MapDB_Get();
    expect(db.episodes).toEqual([]);
    expect(db.maps).toEqual([]);
  });

  test("3. malformed JSON: MapDB_Get returns an empty db, does not throw", () => {
    setMapdb("{ this is not valid JSON");

    expect(() => MapDB_Init()).not.toThrow();
    const db = MapDB_Get();
    expect(db.episodes).toEqual([]);
    expect(db.maps).toEqual([]);
  });

  test("4. MapDB_ResolveBsp: composite cutscene-chain, plain, and star-only bsp fields", () => {
    // real examples from mapdb.json, 2026-08-30 extraction (see mapdb.ts header)
    expect(MapDB_ResolveBsp("*ntro.cin+base1")).toBe("base1");
    expect(MapDB_ResolveBsp("eou1_.cin+*bunk1")).toBe("bunk1");
    expect(MapDB_ResolveBsp("*boss1")).toBe("boss1");
    expect(MapDB_ResolveBsp("q2dm1")).toBe("q2dm1");
    expect(MapDB_ResolveBsp("q64/rtest")).toBe("q64/rtest");
    expect(MapDB_ResolveBsp("n64/n64l4t.cin+*q64/orbit")).toBe("q64/orbit");
  });

  test("5. MapDB_UnitsForEpisode: sp:true entries only, right episode, file order, bsp resolved", () => {
    setMapdb(JSON.stringify(SYNTHETIC_MAPDB));
    MapDB_Init();

    const baseq2Units = MapDB_UnitsForEpisode("baseq2");
    expect(baseq2Units).toEqual([
      { title: "Unit 1: Base", bsp: "base1" },
      { title: "Unit 2: Warehouse", bsp: "bunk1" },
      { title: "Unit 10: Boss", bsp: "boss1" },
    ]);

    const xatrixUnits = MapDB_UnitsForEpisode("xatrix");
    expect(xatrixUnits).toEqual([{ title: "Unit 1: Swamps", bsp: "xswamp" }]);

    expect(MapDB_UnitsForEpisode("rogue")).toEqual([]);
  });
});

describe("menu_content.ts -- the Content & Rules mapping table", () => {
  test("6. every content entry has at least one available ruleset, and every (content, ruleset) pair resolves", () => {
    expect(CONTENT_LIST.length).toBeGreaterThanOrEqual(7);

    for (const content of CONTENT_LIST) {
      const rulesets = AvailableRulesetsFor(content.id);
      expect(rulesets.length).toBeGreaterThan(0);

      for (const ruleset of rulesets) {
        const plan = ResolveLaunch(content.id, ruleset);
        expect(plan).not.toBeNull();
        expect(typeof plan?.game).toBe("string");
        expect(plan?.map.length).toBeGreaterThan(0);
      }
    }
  });

  test("7. content that exists one way only appears under exactly its own ruleset; shared content resolves the documented (game, map) pairs", () => {
    expect(AvailableRulesetsFor("mg2")).toEqual(["rerelease"]);
    expect(AvailableRulesetsFor("n64")).toEqual(["rerelease"]);
    expect(AvailableRulesetsFor("lmctf")).toEqual(["classic"]);

    expect(AvailableRulesetsFor("baseq2")).toEqual(["classic", "rerelease"]);
    expect(AvailableRulesetsFor("xatrix")).toEqual(["classic", "rerelease"]);
    expect(AvailableRulesetsFor("rogue")).toEqual(["classic", "rerelease"]);
    expect(AvailableRulesetsFor("ctf")).toEqual(["classic", "rerelease"]);

    expect(ResolveLaunch("baseq2", "classic")).toEqual({ game: "", map: "base1", startItems: "" });
    expect(ResolveLaunch("baseq2", "rerelease")).toEqual({ game: "kex", map: "base1", startItems: "" });
    expect(ResolveLaunch("xatrix", "classic")).toEqual({ game: "xatrix", map: "xswamp", startItems: "" });
    expect(ResolveLaunch("rogue", "classic")).toEqual({ game: "rogue", map: "rmine1", startItems: "" });
    expect(ResolveLaunch("ctf", "classic")).toEqual({ game: "ctf", map: "q2ctf1", startItems: "" });
    expect(ResolveLaunch("mg2", "rerelease")).toEqual({ game: "kex", map: "mguhub", startItems: "" });
    expect(ResolveLaunch("n64", "rerelease")).toEqual({ game: "kex", map: "q64/rtest", startItems: "" });
    expect(ResolveLaunch("lmctf", "classic")).toEqual({ game: "lmctf", map: "lmctf09", startItems: "" });

    // ctf is multiplayer-only content: no skill select
    expect(CONTENT_LIST.find((c) => c.id === "ctf")?.needsSkillSelect).toBe(false);
    expect(CONTENT_LIST.find((c) => c.id === "lmctf")?.needsSkillSelect).toBe(false);
    expect(CONTENT_LIST.find((c) => c.id === "baseq2")?.needsSkillSelect).toBe(true);

    // RULESETS' own display list matches the two ids the table dispatches on
    expect(RULESETS.map((r) => r.id)).toEqual(["classic", "rerelease"]);
  });
});

describe("menu.ts -- Content & Rules screen wired into the Game menu", () => {
  beforeEach(() => {
    // Neutralize cvar.ts's "game" cvar CVAR_LATCH-on-server-live special
    // case (see this file's header) so PerformLaunch's Cvar_Set("game", ...)
    // always applies synchronously here, independent of any other test
    // file's leftover server state in this process.
    Com_SetServerState(0);
  });

  test("8. the Game menu still opens (not regressed), and the new Content & Rules screen pushes cleanly", () => {
    expect(() => M_Menu_Game_f()).not.toThrow();
    expect(cls.key_dest).toBe(KeydestT.key_menu);

    expect(() => M_Menu_Content_f()).not.toThrow();
    expect(cls.key_dest).toBe(KeydestT.key_menu);
  });

  test("9. BeginContentFunc, at the screen's default widget state, applies the baseq2/classic LaunchPlan through the real cvar plumbing", () => {
    M_Menu_Content_f(); // fresh open: every MenulistS.curvalue is 0 -> content[0] (baseq2), ruleset[0] (classic)

    BeginContentFunc();

    expect(Cvar_VariableString("game")).toBe("");
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("0");
    expect(Cvar_VariableString("gamerules")).toBe("0");
    // baseq2 needsSkillSelect: true, skill spincontrol curvalue 0 -> "easy"
    expect(Cvar_VariableString("skill")).toBe("0");
    expect(Cvar_VariableString("g_start_items")).toBe("");
  });
});

describe("PerformLaunch -- game-mode cvars (New Game never starts deathmatch)", () => {
  // Regression for Mike's 2026-08-31 report: a New Game menu start must
  // force deathmatch off no matter what a previous session left behind,
  // and the coop QoL toggle must start coop (widening maxclients from the
  // SP default of 1, vanilla m_menu.c StartServerActionFunc precedent)
  // without ever enabling deathmatch.
  const plan: LaunchPlan = { game: "", map: "base1", startItems: "" };

  beforeEach(() => {
    // Register through the product's OWN default before anything forces a
    // value: PerformLaunch (src/client/menu_content.ts) does
    // Cvar_ForceSet("skill", ...), and Cvar_ForceSet on a name nothing has
    // registered yet CREATES the cvar with the forced value as its
    // default_string. In a real session src/server/sv_main.ts's SV_Init has
    // always run Cvar_Get("skill", "1", CVAR_LATCH) long before any menu
    // exists, so the ForceSet only ever assigns a value. Under `bun test`
    // the cvar table is one process-global and SV_Init may not have run
    // yet, so this suite could stamp a default_string of "0" and make
    // test/cvar_parity.test.ts's "skill: default 1" row fail whenever this
    // file happened to run first (PORTING.md rule 13: a suite initializes
    // what it touches and does not depend on -- or impose -- an ordering).
    // Same idiom as test/cl_scrn_bind_hint.test.ts and
    // test/cgame_host_hud_scale.test.ts use for cl_kfont_source.
    Cvar_Get("skill", "1", CVAR_LATCH);
  });

  test("coop=false forces deathmatch 0 and coop 0 over stale values", () => {
    Cvar_ForceSet("deathmatch", "1");
    Cvar_ForceSet("coop", "1");
    PerformLaunch(plan, "base1", 1, false);
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("0");
  });

  test("stale ctf/teamplay from an earlier CTF session are cleared (the 'Forcing deathmatch.' chain)", () => {
    Cvar_ForceSet("ctf", "1");
    Cvar_ForceSet("teamplay", "1");
    PerformLaunch(plan, "base1", 1, false);
    expect(Cvar_VariableString("ctf")).toBe("0");
    expect(Cvar_VariableString("teamplay")).toBe("0");
  });

  test("kex CTF plan sets ctf 1 explicitly", () => {
    Cvar_ForceSet("ctf", "0");
    const ctfPlan: LaunchPlan = { game: "kex", map: "q2ctf1", startItems: "", ctf: true };
    PerformLaunch(ctfPlan, "q2ctf1", null, false);
    expect(Cvar_VariableString("ctf")).toBe("1");
  });

  test("coop=true starts coop, not deathmatch, and widens maxclients from 1", () => {
    Cvar_ForceSet("deathmatch", "1");
    Cvar_ForceSet("coop", "0");
    Cvar_ForceSet("maxclients", "1");
    PerformLaunch(plan, "base1", 1, true);
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("1");
    expect(Cvar_VariableString("maxclients")).toBe("4");
  });

  test("coop=true respects an already-widened maxclients", () => {
    Cvar_ForceSet("maxclients", "8");
    PerformLaunch(plan, "base1", null, true);
    expect(Cvar_VariableString("maxclients")).toBe("8");
  });
});

/*
=============================================================================
NEW GAME SCREEN ROWS (Mike's 2026-09-01 play test)

Every one of these is a regression for something he hit with a controller in
his hands, on a machine whose rerelease tree the data scan could not see:

  finding 2  the content row read "Quake II (original)"
  finding 3  switching content to "Call of the Machine" blanked the ruleset
             row's VALUE -- the row drew a label and nothing else
  finding 4  neither the ruleset nor the maps/data row would move under
             left/right; both had been filtered down to a single entry
  finding 5  "local players" was pinned to "1 (no split)" by the attached
             gamepad count, so splitscreen could not be selected at all

The scenario is reproduced the harsh way: data_root_classic and
data_root_rerelease forced EMPTY, so the availability scan knows nothing about
anything. That is the exact state his session was in, and it is now required
to change nothing about which options the screen offers.
=============================================================================
*/
describe("New Game screen -- every row shows a value and every row cycles", () => {
  type RowT = { name: string; value: string; values: string[]; focused: boolean };
  const rowsByName = (): Map<string, RowT> => {
    const map = new Map<string, RowT>();
    for (const row of Content_MenuRowsForTests()) map.set(row.name, row);
    return map;
  };

  // Put the menu cursor on a named row with real K_DOWNARROW presses (the
  // screen's widget state and cursor persist between opens, exactly as they do
  // for a player reopening the menu, so nothing here may assume a position).
  const focus = (name: string): void => {
    for (let i = 0; i <= Content_MenuRowsForTests().length; i++) {
      if (rowsByName().get(name)?.focused) return;
      Content_MenuKey(K_DOWNARROW);
    }
    throw new Error(`could not focus row "${name}"`);
  };

  // Wind the focused spincontrol back to its first value with K_LEFTARROW,
  // which clamps at index 0 (SpinControl_DoSlide).
  const rewind = (name: string): void => {
    focus(name);
    for (let i = 0; i <= (rowsByName().get(name)?.values.length ?? 0); i++) Content_MenuKey(K_LEFTARROW);
  };

  beforeEach(() => {
    Com_SetServerState(0);
    // The blind-scan scenario: no data tree is configured at all.
    Cvar_ForceSet("data_root_classic", "");
    Cvar_ForceSet("data_root_rerelease", "");
    ResetDataTreeScanCache();
    M_Menu_Content_f();
  });

  test("no row is ever blank, on a machine the scan knows nothing about", () => {
    for (const row of Content_MenuRowsForTests()) {
      expect(row.value.length).toBeGreaterThan(0);
    }
  });

  test("finding 3: the ruleset row keeps a value on Call of the Machine", () => {
    // walk the content row to Call of the Machine
    rewind("content");
    const target = rowsByName().get("content")?.values.indexOf("Call of the Machine") ?? -1;
    expect(target).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < target; i++) Content_MenuKey(K_RIGHTARROW);

    const after = rowsByName();
    expect(after.get("content")?.value).toBe("Call of the Machine");
    // the row that used to go blank
    expect(after.get("ruleset")?.value.length).toBeGreaterThan(0);
    expect(after.get("ruleset")?.values.length).toBe(RULESETS.length);
    // ...and the maps/data row still names a tree
    expect(after.get("maps/data")?.value.length).toBeGreaterThan(0);
  });

  test("finding 4: the ruleset row cycles both engine modules, for every content", () => {
    const content = rowsByName().get("content");
    const contentCount = content?.values.length ?? 0;
    expect(contentCount).toBeGreaterThan(0);

    for (let c = 0; c < contentCount; c++) {
      rewind("content");
      for (let i = 0; i < c; i++) Content_MenuKey(K_RIGHTARROW);

      expect(rowsByName().get("ruleset")?.values).toEqual(RULESETS.map((r) => r.name));

      // and it really moves, both ways
      rewind("ruleset");
      expect(rowsByName().get("ruleset")?.value).toBe(RULESETS[0]?.name);
      Content_MenuKey(K_RIGHTARROW);
      expect(rowsByName().get("ruleset")?.value).toBe(RULESETS[1]?.name);
      Content_MenuKey(K_LEFTARROW);
      expect(rowsByName().get("ruleset")?.value).toBe(RULESETS[0]?.name);
    }
  });

  test("finding 2: content names carry no data-tree suffix", () => {
    for (const name of rowsByName().get("content")?.values ?? []) {
      expect(name).not.toMatch(/\((original|re-release)\)/);
    }
  });

  test("finding 5: local players offers 1-4 with no gamepads attached", () => {
    expect(rowsByName().get("local players")?.values).toEqual(["1 (no split)", "2", "3", "4"]);

    rewind("local players");
    expect(rowsByName().get("local players")?.value).toBe("1 (no split)");
    Content_MenuKey(K_RIGHTARROW);
    expect(rowsByName().get("local players")?.value).toBe("2");
    Content_MenuKey(K_RIGHTARROW);
    expect(rowsByName().get("local players")?.value).toBe("3");
    Content_MenuKey(K_RIGHTARROW);
    expect(rowsByName().get("local players")?.value).toBe("4");
    // no pads are attached under `bun test`; the count is a hint, not a cap
    expect(CL_Seats_Available()).toBe(1);
  });
});

/*
LAYOUT (Mike's 2026-09-01 finding 1: "the New Game title is drawn overlapping
the first row"). The title used to be pinned to viddef.height / 2 - 60 while
Menu_Center put the first row at viddef.height / 2 - 55 -- both measured from
the same midpoint, so an 8-pixel-tall title always landed 5 pixels above an
8-pixel-tall row, at EVERY resolution. The title is now placed relative to the
menu body, so this checks the whole ladder at once: banner, title, first row,
last row, statusbar, at every mode in the table plus the sizes the
vid_scale/vid_scale_fit path produces (which only ever changes viddef).
*/
describe("New Game screen -- layout never overlaps, at any resolution", () => {
  const SIZES: [number, number][] = [
    [320, 240], // vanilla low mode, and what vid_scale 0.5 of 640x480 renders
    [400, 300],
    [512, 384],
    [640, 480],
    [800, 600],
    [1024, 768],
    [1280, 960],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ];

  test("the title clears the first row, and the last row clears the statusbar", () => {
    const restore = { width: viddef.width, height: viddef.height };
    try {
      for (const [width, height] of SIZES) {
        viddef.width = width;
        viddef.height = height;
        M_Menu_Content_f();

        const layout = Content_LayoutForTests();
        const first = layout.rows[0];
        const last = layout.rows[layout.rows.length - 1];
        expect(first).toBeDefined();
        expect(last).toBeDefined();

        // the actual defect: title glyphs must end before the first row starts
        expect(layout.titleY + layout.titleHeight).toBeLessThanOrEqual(first?.y ?? 0);
        // ...and the title must not run off the top of the screen either
        expect(layout.titleY).toBeGreaterThanOrEqual(0);
        // the body must fit above the statusbar strip
        expect((last?.y ?? 0) + 8).toBeLessThanOrEqual(layout.statusbarY);
        // rows keep their authored 20-unit rhythm, in order
        for (let i = 1; i < layout.rows.length; i++) {
          expect(layout.rows[i]?.y ?? 0).toBeGreaterThan(layout.rows[i - 1]?.y ?? 0);
        }
      }
    } finally {
      viddef.width = restore.width;
      viddef.height = restore.height;
    }
  });
});
