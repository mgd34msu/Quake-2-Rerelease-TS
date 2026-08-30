// menu_content.ts -- THE CONTENT & RULES SELECTOR (Mike's design, 2026-08-30
// task brief; this is an original piece of this port, not a translation of
// any id/ZeniMax/Paril-KEX source file -- there is no C original to cite a
// basename from).
//
// v1.0.0 REQUIREMENT THIS SERVES: "the menu is the content selector -- one
// client plays everything, so campaign/ruleset choice lives in our UI."
// This module is the MODEL half of that feature (the mapping table +
// pure resolution logic, importable and testable with no client/vid/menu
// boot required); src/client/menu.ts's new "Content & Rules" screen
// (Content_MenuInit/Draw/Key, M_Menu_Content_f, wired into the existing
// Game menu) is the VIEW half, built with menu.ts's own qmenu.ts widget
// toolkit -- see menu.ts's own header for why this is a two-file split
// (import-cycle avoidance: menu.ts imports this file's pure exports;
// this file never imports menu.ts, so there is no cycle to break).
//
// WHAT "CONTENT" AND "RULESET" MEAN HERE
// ---------------------------------------------------------------------
// "Ruleset" is which of the two peer game-API families runs the content
// (ARCHITECTURE.md's "Core model: one engine, five first-class game
// modules"): CLASSIC = the frozen bug-for-bug 3.21 legacy binding (game
// cvar "", "xatrix", "rogue", "ctf", or a custom legacy gamedir);
// RERELEASE = the 2023 kex binding (game cvar "kex" -- ARCHITECTURE.md:
// "the kex module is the content superset ... 'play baseq2 under
// re-release rules' is simply running the kex module").
//
// "Content" is WHICH campaign/mapset to play, independent of ruleset:
// Quake II (base), The Reckoning (xatrix), Ground Zero (rogue), Capture
// the Flag, plus re-release-only additions from mapdb.json (Call of the
// Machine / mg2, Quake II 64 / n64), plus Mike's own classic-only CTF map
// pack (lmctf). Most content is playable under EITHER ruleset (same bsp
// files exist in both trees for the four id-original tracks); content
// that only exists on one side appears only under that ruleset's list --
// see the table below.
//
// THE MAPPING TABLE
// ---------------------------------------------------------------------
// Content id | Display name          | Classic 3.21          | Re-release 2023      | Skill?
// -----------|------------------------|------------------------|----------------------|-------
// baseq2     | Quake II               | game="",     base1     | game="kex", base1    | yes
// xatrix     | The Reckoning          | game="xatrix", xswamp   | game="kex", xswamp   | yes
// rogue      | Ground Zero            | game="rogue", rmine1    | game="kex", rmine1   | yes
// ctf        | Capture the Flag       | game="ctf",  q2ctf1     | game="kex", q2ctf1   | no
// mg2        | Call of the Machine    | -- (kex-only content) --| game="kex", mguhub   | yes
// n64        | Quake II 64            | -- (kex-only content) --| game="kex", q64/rtest| yes
// lmctf      | Lithium CTF (map pack) | game="lmctf", lmctf09   | -- (classic-only) -- | no
//
// Every (game, map) pair above was cross-checked against the real
// mapdb.json (~/q2rets/rerelease/baseq2/pak0.pak, extracted 2026-08-30):
// each classic/rerelease-shared content id's map comes from that content's
// first sp:true campaign-start entry, run through mapdb.ts's
// MapDB_ResolveBsp (e.g. "*ntro.cin+base1" -> "base1", "eou1_.cin+*bunk1"
// -> "bunk1"; only the FIRST unit's bsp is needed for the default launch
// pair -- see MapDB_UnitsForEpisode for browsing the rest). CTF's map
// comes from mapdb's own baseq2-episode ctf:true entries (q2ctf1 is the
// first). mg2/n64 are real mapdb episodes that exist ONLY inside the
// rerelease pak (no classic-tree equivalent bsp/game exists to fall back
// to). lmctf has no mapdb entry at all -- it is not id/ZeniMax content --
// its startmap (lmctf09) is the first line of its own maplist.txt
// (~/q2ts/lmctf/maplist.txt).
//
// "lmctf" GAME TRACK -- see src/server/bindings/legacy.ts's own comment at
// its LoadLegacyGame dispatch: lmctf is Mike's classic-era third-party CTF
// map pack, shipped with its own closed-source game DLLs we have no source
// to port. Selecting it here plays those maps under OUR compiled ctf
// track (stock CTF rules), not a port of whatever the original lmctf DLL
// did -- an explicit, documented scope boundary, not a fidelity claim.
//
// WHY A STATIC TABLE (not fully mapdb-driven)
// ---------------------------------------------------------------------
// mapdb.json only exists in the re-release tree (see files.ts's
// content_root cvar for how it becomes reachable regardless of basedir).
// A classic-only basedir with no content_root configured has NO mapdb.json
// at all, and this selector must still work in that configuration (it's
// the ONLY way to start The Reckoning/Ground Zero/CTF content from the
// menu at all -- there is no other campaign picker). So the launch table
// is a static, hand-verified fallback; MapDB_UnitsForEpisode (mapdb.ts) is
// used ADDITIONALLY, when mapdb.json IS loaded, to populate a real "start
// point" browser (this satisfies the "episode/campaign browser" half of
// the brief) letting the player pick any unit within a re-release-side
// episode instead of always starting at unit 1 -- but the guaranteed
// default (this table) never depends on that data being present.

import { Cvar_Set, Cvar_ForceSet } from "../qcommon/cvar";
import { Cbuf_AddText } from "../qcommon/cmd";
import { MapDB_UnitsForEpisode, type MapdbUnitEntry } from "../qcommon/mapdb";

export type RulesetId = "classic" | "rerelease";

export const RULESETS: ReadonlyArray<{ id: RulesetId; name: string }> = [
  { id: "classic", name: "Classic 3.21" },
  { id: "rerelease", name: "Re-release 2023" },
];

export type ContentId = "baseq2" | "xatrix" | "rogue" | "ctf" | "mg2" | "n64" | "lmctf";

export interface ContentDef {
  id: ContentId;
  name: string;
  needsSkillSelect: boolean;
  // Which mapdb.json episode id (mapdb.ts's MapdbEpisode.id) this content
  // corresponds to, for the unit browser -- null when there is no mapdb
  // entry for this content at all (ctf's own episode id in mapdb.json is
  // "baseq2" itself -- ctf maps are baseq2-episode entries with ctf:true,
  // not a separate episode -- so ctf's browser is intentionally null here
  // rather than pulling in every baseq2 SP campaign map; lmctf has no
  // mapdb entry, period).
  mapdbEpisodeId: string | null;
}

export const CONTENT_LIST: ReadonlyArray<ContentDef> = [
  { id: "baseq2", name: "Quake II", needsSkillSelect: true, mapdbEpisodeId: "baseq2" },
  { id: "xatrix", name: "The Reckoning", needsSkillSelect: true, mapdbEpisodeId: "xatrix" },
  { id: "rogue", name: "Ground Zero", needsSkillSelect: true, mapdbEpisodeId: "rogue" },
  { id: "ctf", name: "Capture the Flag", needsSkillSelect: false, mapdbEpisodeId: null },
  { id: "mg2", name: "Call of the Machine", needsSkillSelect: true, mapdbEpisodeId: "mg2" },
  { id: "n64", name: "Quake II 64", needsSkillSelect: true, mapdbEpisodeId: "n64" },
  { id: "lmctf", name: "Lithium CTF (map pack)", needsSkillSelect: false, mapdbEpisodeId: null },
];

export interface LaunchPlan {
  // Value to Cvar_Set("game", ...); "" selects the default baseq2 legacy
  // module (FS_SetGamedir's own "" / BASEDIRNAME special case).
  game: string;
  // Literal bsp name for the `map` command (already run through
  // mapdb.ts's MapDB_ResolveBsp where the source was a mapdb entry).
  map: string;
  // g_start_items override; "" means none (the kex game's default
  // loadout). Only ever meaningful under the "rerelease" ruleset -- the
  // legacy trees have no such cvar/import.
  startItems: string;
}

// One entry per (content, ruleset) pair that actually exists. Absence of a
// ruleset key means that content doesn't exist under that ruleset (the
// "appears under its only ruleset" cases: mg2/n64 have no "classic" key,
// lmctf has no "rerelease" key).
const LAUNCH_TABLE: Readonly<Record<ContentId, Partial<Record<RulesetId, LaunchPlan>>>> = {
  baseq2: {
    classic: { game: "", map: "base1", startItems: "" },
    rerelease: { game: "kex", map: "base1", startItems: "" },
  },
  xatrix: {
    classic: { game: "xatrix", map: "xswamp", startItems: "" },
    rerelease: { game: "kex", map: "xswamp", startItems: "" },
  },
  rogue: {
    classic: { game: "rogue", map: "rmine1", startItems: "" },
    rerelease: { game: "kex", map: "rmine1", startItems: "" },
  },
  ctf: {
    classic: { game: "ctf", map: "q2ctf1", startItems: "" },
    rerelease: { game: "kex", map: "q2ctf1", startItems: "" },
  },
  mg2: {
    rerelease: { game: "kex", map: "mguhub", startItems: "" },
  },
  n64: {
    rerelease: { game: "kex", map: "q64/rtest", startItems: "" },
  },
  lmctf: {
    classic: { game: "lmctf", map: "lmctf09", startItems: "" },
  },
};

/*
===============
ContentById
===============
*/
export function ContentById(id: ContentId): ContentDef {
  const found = CONTENT_LIST.find((c) => c.id === id);
  if (!found) throw new Error(`menu_content: unknown content id "${id}"`);
  return found;
}

/*
===============
AvailableRulesetsFor

Which rulesets a piece of content can be played under, in RULESETS' fixed
display order.
===============
*/
export function AvailableRulesetsFor(content: ContentId): RulesetId[] {
  const entry = LAUNCH_TABLE[content];
  return RULESETS.map((r) => r.id).filter((id) => entry[id] !== undefined);
}

/*
===============
ResolveLaunch

The mapping table lookup. Returns null only for a (content, ruleset) pair
that doesn't exist (call AvailableRulesetsFor first, as the menu screen
does, to avoid ever hitting that case from the UI).
===============
*/
export function ResolveLaunch(content: ContentId, ruleset: RulesetId): LaunchPlan | null {
  return LAUNCH_TABLE[content][ruleset] ?? null;
}

/*
===============
UnitsForContent

mapdb-driven "start point" browser data for a content id (empty array when
the content has no mapdb episode, or mapdb.json hasn't been loaded --
either way the menu screen falls back to the single default LaunchPlan
from ResolveLaunch). This is the "episode/campaign browser" piece of the
brief: MapDB_UnitsForEpisode already returns entries in authored (unit-
ascending) order with bsp fields resolved to literal, loadable names.
===============
*/
export function UnitsForContent(content: ContentId): MapdbUnitEntry[] {
  const def = ContentById(content);
  if (!def.mapdbEpisodeId) return [];
  return MapDB_UnitsForEpisode(def.mapdbEpisodeId);
}

/*
===============
PerformLaunch

The actual engine side effect: mirrors menu.ts's own StartGame() idiom
("loading ; killserver ; wait ; <command>") and StartServerActionFunc's
cvar-then-Cbuf sequencing exactly -- set every cvar the game needs FIRST,
then queue the map change through Cbuf_AddText so it runs in the correct
order across frames (see .orch task brief's note that direct synchronous
Cvar_Set("game", ...) while a server is currently up would just latch
instead of applying -- routing through Cbuf after "killserver ; wait"
avoids that, same as every other menu screen that starts a game).

`bsp` overrides the LaunchPlan's default map (the unit browser's chosen
start point, when the caller offers one); pass plan.map to start at the
default first unit.
===============
*/
export function PerformLaunch(plan: LaunchPlan, bsp: string, skill: number | null): void {
  Cvar_Set("deathmatch", "0");
  Cvar_Set("coop", "0");
  Cvar_Set("gamerules", "0");
  Cvar_Set("game", plan.game);

  if (skill !== null) Cvar_ForceSet("skill", String(skill));

  if (plan.startItems.length) Cvar_Set("g_start_items", plan.startItems);
  else Cvar_Set("g_start_items", "");

  Cbuf_AddText(`loading ; killserver ; wait ; map ${bsp}\n`);
}

// Re-exported purely so menu.ts's Content screen (and this file's own
// tests) don't need a second import line into qcommon/mapdb.ts just for
// the browser entry shape.
export type { MapdbUnitEntry };
