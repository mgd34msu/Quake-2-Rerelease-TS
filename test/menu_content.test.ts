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
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { Com_SetServerState } from "../src/qcommon/common";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { MapDB_Init, MapDB_Get, MapDB_Shutdown, MapDB_ResolveBsp, MapDB_UnitsForEpisode } from "../src/qcommon/mapdb";
import { CONTENT_LIST, RULESETS, AvailableRulesetsFor, ResolveLaunch, PerformLaunch, type LaunchPlan } from "../src/client/menu_content";
import { M_Menu_Game_f, M_Menu_Content_f, BeginContentFunc } from "../src/client/menu";
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

  test("coop=false forces deathmatch 0 and coop 0 over stale values", () => {
    Cvar_ForceSet("deathmatch", "1");
    Cvar_ForceSet("coop", "1");
    PerformLaunch(plan, "base1", 1, false);
    expect(Cvar_VariableString("deathmatch")).toBe("0");
    expect(Cvar_VariableString("coop")).toBe("0");
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
