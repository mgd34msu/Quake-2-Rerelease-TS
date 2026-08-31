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
// lmctf      | Loki's Minions CTF     | game="lmctf", lmctf09   | -- (classic-only) -- | no
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
// its LoadLegacyGame dispatch: lmctf is LM_CTF (Loki's Minions CTF), a
// classic-era third-party CTF mod with real GPL/authorized-community-port
// source available (~/Projects/qsrc/lmctf60) and a real port at
// src/lmctf/ (flag capture chain, item table, blaster fire, and the
// boot-critical SpawnEntities/RunFrame/ClientConnect/ClientThink path all
// land for real, tested in test/lmctf_core.test.ts and
// test/lmctf_capture.test.ts). Selecting it here now plays those maps
// under src/lmctf's own real LM_CTF rules (legacy.ts's dispatch was
// repointed at LMCTF_GetGameAPI once src/lmctf/ could actually boot a
// level) -- no longer the stock ctf-track fallback this comment used to
// describe.
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

import { Cvar_Set, Cvar_ForceSet, Cvar_VariableValue } from "../qcommon/cvar";
import { Cbuf_AddText } from "../qcommon/cmd";
import { MapDB_UnitsForEpisode, type MapdbUnitEntry } from "../qcommon/mapdb";
import { BASEDIRNAME } from "../qcommon/qcommon";

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
  // True only for CTF content under the kex module: the kexgame's own
  // ZOID init block reads the `ctf` cvar (g_main.ts) to run CTF rules
  // (and forces deathmatch on, which IS correct for CTF). Every other
  // launch must clear it -- a latched ctf=1 left over from an earlier
  // CTF session otherwise makes the kex module print "Forcing
  // deathmatch." and turn a campaign start into DM (Mike's 2026-08-31
  // base1 session: DM inhibited the map's doors/buttons/elevator).
  // The classic "ctf" game module needs no cvar -- it forces its own
  // mode unconditionally (ctf/g_save.ts's own ZOID block).
  ctf?: boolean;
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
    rerelease: { game: "kex", map: "q2ctf1", startItems: "", ctf: true },
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
export function PerformLaunch(plan: LaunchPlan, bsp: string, skill: number | null, coop = false): void {
  // New Game NEVER starts deathmatch, coop or not. `coop` is the New Game
  // screen's QoL toggle (owner request 2026-08-31); when enabled and
  // maxclients is still the SP default of 1, widen it so the listen
  // server can actually accept a second player -- same guard vanilla's
  // start-server screen applies (m_menu.c StartServerActionFunc: coop
  // with maxclients <= 1 gets 4).
  Cvar_Set("deathmatch", "0");
  Cvar_Set("coop", coop ? "1" : "0");
  if (coop && Cvar_VariableValue("maxclients") <= 1) Cvar_Set("maxclients", "4");
  Cvar_Set("gamerules", "0");
  // Clear (or set, for kex CTF) the mode-forcing cvars the game modules'
  // ZOID init blocks read -- see LaunchPlan.ctf's doc comment. Without
  // this, a stale latched ctf/teamplay from an earlier session flips any
  // later New Game start into deathmatch.
  Cvar_Set("ctf", plan.ctf ? "1" : "0");
  Cvar_Set("teamplay", "0");
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

/*
=============================================================================
GAME DISCOVERY (Mike's ruling, 2026-08-31, quoted for the ledger: "we need
to be able to select the game as well, because otherwise how will we know
which maps to use ... the maps should come from whatever is available as a
game") -- the New Game screen's game list is no longer limited to the
curated CONTENT_LIST above: at menu open, menu.ts scans the basedir (and
homedir, when set) for gamedirs sibling to baseq2 the curated table doesn't
already name, and appends them so any installed mod/content shows up.

Addendum (Mike, 2026-08-31): the ordered "start at" list for the famous SP
campaigns now uses mapdb.json's own unit order under EITHER ruleset,
whenever mapdb.json is loadable -- the four id-original tracks' map
sequences are identical in both trees, and mapdb.json is reachable via
content_root regardless of which basedir is active (see files.ts's own
content_root comment) -- lifting the old rerelease-only gate menu.ts's
RebuildStartPoints used to apply.

DEVIATION (documented per .orch/preferences.md rule 3): the design brief's
"ruleset choices = classic only unless the dir is the rerelease's own
baseq2 content" carve-out is not implemented. The only rerelease-content
dirname the engine's binding layer (src/server/bindings/legacy_kex.ts)
actually recognizes is "kex" itself, which is already excluded from
discovery below by CuratedGameDirnames() (it's already a curated table
entry) -- so no directory can ever reach discovery AND legitimately be
rerelease content without bindings-layer changes this task's territory
(menu_content.ts + menu.ts only) doesn't authorize. Every discovered
gamedir here runs the classic legacy binding (game cvar = its directory
name), matching the lmctf launch plan's own shape above.
=============================================================================
*/

// The pure discovery/enumeration functions below take this seam instead of
// importing qcommon/files.ts directly, for two reasons: (1) menu_content.ts
// stays a plain, boot-free model module per its own header (no vid/menu/FS
// runtime needed to test it); (2) files.ts's FS_ListFiles/FS_ReadRawFile
// already operate on LITERAL filesystem paths with no dependency on which
// gamedir happens to be currently mounted (see each of their own header
// comments) -- exactly what's needed here to browse a candidate gamedir
// that isn't the active one, and exactly what lets a test point this at a
// mkdtemp() fixture tree by passing those real functions in unmodified.
export interface GameFsSeam {
  // Mirrors files.ts's FS_ListFiles: glob-matched "dir/name" entries, or
  // null if the directory doesn't exist.
  listFiles(findname: string): string[] | null;
  // Mirrors files.ts's FS_ReadRawFile plus a text decode: whole-file text,
  // or null if the file doesn't exist.
  readTextFile(path: string): string | null;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// Every `game` cvar value the curated table already dispatches on ("" is
// omitted -- it's BASEDIRNAME itself, excluded by name in DiscoverGameDirs
// below, not by this set). A discovered sibling directory with one of
// these names is already represented by a curated CONTENT_LIST row and
// must not be listed twice.
function CuratedGameDirnames(): Set<string> {
  const set = new Set<string>();
  for (const content of CONTENT_LIST) {
    for (const ruleset of RULESETS) {
      const plan = LAUNCH_TABLE[content.id][ruleset.id];
      if (plan && plan.game.length) set.add(plan.game);
    }
  }
  return set;
}

// Bullet 1's qualification rule: at least one .pak, a maps/ subdir
// (existence, not non-emptiness -- listing the PARENT catches an empty
// maps/ dir that globbing straight into it would miss, since FS_ListFiles
// returns null for both "doesn't exist" and "matched nothing"), or a
// maplist.txt.
function GameDirQualifies(seam: GameFsSeam, gamedirPath: string): boolean {
  if ((seam.listFiles(`${gamedirPath}/*.pak`) ?? []).length > 0) return true;
  if ((seam.listFiles(`${gamedirPath}/*`) ?? []).some((p) => basenameOf(p) === "maps")) return true;
  if (seam.readTextFile(`${gamedirPath}/maplist.txt`) !== null) return true;
  return false;
}

/*
===============
DiscoverGameDirs

Scans each root (a basedir or homedir path) for gamedirs sibling to baseq2
that qualify and aren't already named in the curated table, in root order
(so a homedir copy is found the same way a basedir one is), deduped by
name, returned sorted for a stable menu across boots.
===============
*/
export function DiscoverGameDirs(seam: GameFsSeam, roots: readonly string[]): string[] {
  const excluded = CuratedGameDirnames();
  const found: string[] = [];
  for (const root of roots) {
    if (!root.length) continue;
    const entries = seam.listFiles(`${root}/*`) ?? [];
    for (const path of entries) {
      const dirname = basenameOf(path);
      if (dirname === BASEDIRNAME || excluded.has(dirname) || found.includes(dirname)) continue;
      if (GameDirQualifies(seam, path)) found.push(dirname);
    }
  }
  return found.sort();
}

// A game the New Game screen can select: either a curated CONTENT_LIST row
// (full ruleset choice, mapdb wiring, curated display name) or a
// discovered gamedir (classic-only, displayed by directory name -- see
// this section's header DEVIATION note).
export type SelectableGame = { readonly kind: "curated"; readonly content: ContentDef } | { readonly kind: "discovered"; readonly dirname: string };

/*
===============
BuildGameList

Famous CONTENT_LIST entries first (owner design: "the famous CONTENT_LIST
entries stay first"), discovered gamedirs appended after, in
DiscoverGameDirs' order.
===============
*/
export function BuildGameList(discoveredDirnames: readonly string[]): SelectableGame[] {
  const curated = CONTENT_LIST.map((content): SelectableGame => ({ kind: "curated", content }));
  const discovered = discoveredDirnames.map((dirname): SelectableGame => ({ kind: "discovered", dirname }));
  return [...curated, ...discovered];
}

export function GameListDisplayName(game: SelectableGame): string {
  return game.kind === "curated" ? game.content.name : game.dirname;
}

export function AvailableRulesetsForGame(game: SelectableGame): RulesetId[] {
  return game.kind === "curated" ? AvailableRulesetsFor(game.content.id) : ["classic"];
}

export function NeedsSkillSelectForGame(game: SelectableGame): boolean {
  return game.kind === "curated" ? game.content.needsSkillSelect : false;
}

/*
===============
FsFallbackGamedirName

Which on-disk gamedir name backs bullet 2's (b)/(c) maplist.txt/maps/*.bsp
fallback for a (game, ruleset) selection, or null when there is none to
scan. The "kex" ruleset's tree is one monolithic pak shared by every
rerelease content id (base1, xswamp, rmine1, mguhub, q64/rtest, q2ctf1 all
live in the same gamedir) -- scanning it would list every rerelease map
for every content id alike, so it is never used as an FS fallback source;
mapdb (tier (a), applied in menu.ts's RebuildStartPoints before this
function is ever consulted) is the only rerelease-side source, same as the
pre-existing single-default fallback for whichever content mapdb has
nothing for.
===============
*/
export function FsFallbackGamedirName(game: SelectableGame, ruleset: RulesetId): string | null {
  if (game.kind === "discovered") return game.dirname;
  if (ruleset !== "classic") return null;
  const plan = ResolveLaunch(game.content.id, "classic");
  if (!plan) return null;
  return plan.game.length ? plan.game : BASEDIRNAME;
}

/*
===============
ParseMaplistTxt

lmctf precedent (~/q2ts/lmctf/maplist.txt): one bsp basename per line, FILE
order preserved (never sorted) -- the first line is the game's own default
start.
===============
*/
export function ParseMaplistTxt(text: string): MapdbUnitEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((bsp) => ({ title: bsp, bsp }));
}

function bspBasenamesFrom(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const p of paths) {
    const base = basenameOf(p);
    const dot = base.lastIndexOf(".");
    names.add(dot === -1 ? base : base.slice(0, dot));
  }
  return [...names].sort();
}

/*
===============
StartPointsForGamedir

Bullet 2's (b)/(c) tiers for one on-disk gamedir: maplist.txt in file order
when present and non-empty, else every maps/*.bsp basename (alphabetical --
explicitly the last resort, per Mike's addendum) across the loose maps/
dir and, when the caller already has them (its gamedir is the one
currently mounted -- see menu.ts's FS_ListPakFiles call site), any
pak-internal maps/*.bsp entries passed in `extraBspPaths`. Empty when
neither source has anything; the caller (menu.ts's RebuildStartPoints)
falls back to the single default "Start" entry in that case, same as
before this task.
===============
*/
export function StartPointsForGamedir(seam: GameFsSeam, gamedirPath: string, extraBspPaths: readonly string[] = []): MapdbUnitEntry[] {
  const maplistText = seam.readTextFile(`${gamedirPath}/maplist.txt`);
  if (maplistText !== null) {
    const entries = ParseMaplistTxt(maplistText);
    if (entries.length) return entries;
  }

  const loose = seam.listFiles(`${gamedirPath}/maps/*.bsp`) ?? [];
  const names = bspBasenamesFrom([...loose, ...extraBspPaths]);
  return names.map((bsp) => ({ title: bsp, bsp }));
}

/*
===============
StartPointsForSelection

The full "start at" priority chain for one (game, ruleset) selection --
menu.ts's RebuildStartPoints is a thin wrapper around this. Mike's
addendum (2026-08-31, "at least have them selectable in that order"):
(a) mapdb episode unit order wins under EITHER ruleset whenever the
selected content has a mapdb episode AND `mapdbUnitsForContent` returns
something for it -- no ruleset gate anymore (the four id-original
campaigns' map sequences are identical in both trees, and mapdb.json is
reachable via content_root regardless of basedir); (b)/(c) FsFallbackGamedirName
+ StartPointsForGamedir's own maplist.txt/maps/*.bsp tiers, tried against
each root in order (so a homedir copy of a gamedir is found the same way a
basedir one is); empty when nothing anywhere has a map, in which case the
caller falls back to the single default "Start" entry, same as before this
task.

`mapdbUnitsForContent` is injected (rather than this function importing
qcommon/mapdb.ts's UnitsForContent itself) purely so tests can supply a
synthetic mapdb answer without standing up FS_InitFilesystem/mapdb.json at
all -- production always passes the real UnitsForContent.
===============
*/
export function StartPointsForSelection(
  game: SelectableGame,
  ruleset: RulesetId,
  mapdbUnitsForContent: (content: ContentId) => MapdbUnitEntry[],
  seam: GameFsSeam,
  gamedirRoots: readonly string[],
  extraBspPaths: readonly string[] = [],
): MapdbUnitEntry[] {
  const mapdbUnits = game.kind === "curated" && game.content.mapdbEpisodeId ? mapdbUnitsForContent(game.content.id) : [];
  if (mapdbUnits.length) return mapdbUnits;

  const dirname = FsFallbackGamedirName(game, ruleset);
  if (!dirname) return [];

  for (const root of gamedirRoots) {
    const candidate = StartPointsForGamedir(seam, `${root}/${dirname}`, extraBspPaths);
    if (candidate.length) return candidate;
  }
  return [];
}

/*
===============
LaunchPlanForDiscovered

Bullet 3's shape for a discovered gamedir: classic legacy binding (game
cvar = the directory name), no g_start_items override, ctf left undefined
(the kex module's ZOID cvar block that field exists for -- see LaunchPlan's
own doc comment -- has no equivalent in a discovered classic gamedir).
===============
*/
export function LaunchPlanForDiscovered(dirname: string, firstMap: string): LaunchPlan {
  return { game: dirname, map: firstMap, startItems: "" };
}

// One-call launch-plan resolution for either branch of a SelectableGame --
// menu.ts's BeginContentFunc no longer needs its own kind-branch.
export function ResolveLaunchForGame(game: SelectableGame, ruleset: RulesetId, firstMap: string): LaunchPlan | null {
  return game.kind === "curated" ? ResolveLaunch(game.content.id, ruleset) : LaunchPlanForDiscovered(game.dirname, firstMap);
}
