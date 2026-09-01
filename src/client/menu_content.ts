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

`data` is the DATA TREE choice (see this file's DATA TREES section). When
given, a `data_root` command is queued between "killserver" and "map": the
remount has to happen with no server up (so the whole search path, base tier
included, can be torn down and rebuilt) and before the map load resolves its
first file. Omitted -- the pre-data-tree call shape -- nothing is remounted
and the launch runs against whatever is already mounted, exactly as before.
===============
*/
export function PerformLaunch(plan: LaunchPlan, bsp: string, skill: number | null, coop = false, data: DataMountPlan | null = null, seats = 1): void {
  // LOCAL SPLITSCREEN (src/client/cl_seats.ts): every extra seat is a real
  // additional player in the same game, so more than one seat IS a coop
  // session -- the campaign has to run its coop spawn/respawn rules or the
  // extra seats have nowhere to spawn. maxclients must have room for them
  // too, the same widening the coop toggle already does.
  const splitscreen = seats > 1;
  const wantCoop = coop || splitscreen;

  // New Game NEVER starts deathmatch, coop or not. `coop` is the New Game
  // screen's QoL toggle (owner request 2026-08-31); when enabled and
  // maxclients is still the SP default of 1, widen it so the listen
  // server can actually accept a second player -- same guard vanilla's
  // start-server screen applies (m_menu.c StartServerActionFunc: coop
  // with maxclients <= 1 gets 4).
  Cvar_Set("deathmatch", "0");
  Cvar_Set("coop", wantCoop ? "1" : "0");
  if (wantCoop && Cvar_VariableValue("maxclients") <= 1) Cvar_Set("maxclients", "4");
  if (splitscreen && Cvar_VariableValue("maxclients") < seats) Cvar_Set("maxclients", String(seats));
  // Read once per frame by CL_Seats_Reconcile, which does the actual seating
  // after the map has loaded and the primary client is active.
  Cvar_Set("cl_seats", String(Math.max(1, Math.trunc(seats))));
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

  // "classic over rerelease" reads most-significant first, which is the
  // argument order FS_DataRoot_f takes.
  const mount = data ? ` data_root ${data.primary}${data.fallback ? ` ${data.fallback}` : ""}${data.mapsFrom ? ` maps=${data.mapsFrom}` : ""} ; wait ;` : "";
  Cbuf_AddText(`loading ; killserver ; wait ;${mount} map ${bsp}\n`);
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
  // Mirrors files.ts's FS_ListPackFileEntries: every entry name inside the
  // pak at a LITERAL path, without mounting it, or null if it isn't a
  // readable pak. Required by the per-tree availability scan below: both of
  // this machine's data trees keep their campaign bsps inside pak files, so
  // a directory listing alone can never tell whether a tree has a campaign.
  listPakEntries(packfile: string): string[] | null;
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

`allowBspScan` gates tier (c) only -- see StartPointsForSelection's own
comment for why: the alphabetical maps/*.bsp scan is a last resort for
UNKNOWN discovered content (Mike's ruling, quoted there), never for a
CONTENT_LIST famous campaign, whose maps/ dir (when the tree even has a
loose one at all) mixes every dm/ctf/sp bsp together with no campaign
order to recover -- exactly the "multiplayer maps, zero campaign maps"
shape a famous SP campaign must never show. maplist.txt (tier (b)) stays
available to every caller, curated or discovered alike (lmctf's own
LAUNCH_TABLE entry has no mapdb episode at all and relies entirely on its
maplist.txt for a start-point browser -- see menu_content.ts's header).
===============
*/
export function StartPointsForGamedir(seam: GameFsSeam, gamedirPath: string, extraBspPaths: readonly string[] = [], allowBspScan = true): MapdbUnitEntry[] {
  const maplistText = seam.readTextFile(`${gamedirPath}/maplist.txt`);
  if (maplistText !== null) {
    const entries = ParseMaplistTxt(maplistText);
    if (entries.length) return entries;
  }

  if (!allowBspScan) return [];

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

FIX (Mike, live RC report, 2026-08-31): tier (c), the raw maps/*.bsp
alphabetical scan, is passed `allowBspScan = game.kind === "discovered"` --
it is "a last resort for UNKNOWN discovered games only" (Mike's own words
for the ruling this function already claimed to implement); it must never
run for a CONTENT_LIST famous campaign (baseq2/xatrix/rogue/ctf/mg2/n64/
lmctf). Before this fix a classic-only install with no mapdb.json (no
content_root, no rerelease data at all) would have this fall through to
scanning e.g. basedir/baseq2/maps/*.bsp -- a directory classic Quake II
data ships as ONE flat folder holding sp, dm, AND ctf bsps together with
no authored order to recover -- producing exactly the reported "start at"
symptom (dm/ctf-looking names, no recognizable campaign order) for a
screen whose whole point is "famous campaigns list their mapdb units in
campaign order; the bsp scan is a last resort for unknown content only".
A famous campaign with no mapdb data now shows the single static default
(ResolveLaunch's own plan.map, via the caller's "Start" fallback) instead.
Tier (b), maplist.txt, is unaffected -- it stays available to curated
content too (lmctf's own LAUNCH_TABLE entry has no mapdb episode at all
and relies entirely on its maplist.txt for a start-point browser).

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

  const allowBspScan = game.kind === "discovered";
  for (const root of gamedirRoots) {
    const candidate = StartPointsForGamedir(seam, `${root}/${dirname}`, extraBspPaths, allowBspScan);
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

/*
=============================================================================
DATA TREES (Mike's RC ruling, 2026-09-01: "the New Game screen must let the
player choose WHICH DATA TREE runs the content -- original 1997 data vs
re-release data")

This is a THIRD axis, independent of the two above:

  ruleset  = which game MODULE runs (classic 3.21 binding vs the kex one)
  content  = which campaign/mapset
  DATA TREE = which on-disk install the maps, textures, sounds and pics are
              read out of -- the original 1997 data, or the 2023 rerelease's
              re-authored version of the same campaigns

The engine side is qcommon/files.ts's `data_root` command / FS_SetDataRoot;
this section is the model half, same split as the rest of this file.

THE TWO MOUNT RULES (Mike, 2026-09-01, as amended the same morning)
---------------------------------------------------------------------
(a) The KEX ruleset ALWAYS has the rerelease tree mounted, because the kex
    module hard-requires assets that exist nowhere in a 1997 install:
    Q2Game.kpf's kfonts, pics/damage_indicator.png, pics/i_armor_shard.pcx,
    the mission-pack icon set, mapdb.json. Without it the client prints
    hundreds of "Can't find pic" lines and attempts a download per missing
    file (his 2026-09-01 finding 2).

    AMENDED (Mike, 2026-09-01, quoted for the ledger: "if we are playing
    with a specific ruleset, we use the things from that ruleset"): kex +
    original data mounts the RERELEASE tree PRIMARY, with the classic tree
    beneath it, and carves out exactly one exception -- `maps/` lookups
    resolve from the CLASSIC tree first (files.ts's `data_root ...
    maps=<tree>` option, documented at FS_FOpenFile's own site).

    Net effect: kex look-and-feel -- rerelease HUD icons, pics, fonts,
    sounds, remastered textures -- on 1997 map geometry. An earlier revision
    had this backwards (classic primary, rerelease beneath), which kept his
    maps but also served the classic HUD pics under a kex ruleset.

    Either way the rerelease tree is mounted, so rule (a)'s real requirement
    -- the kex module never starves for its own assets -- holds, and finding
    2's spam stays structurally impossible.

(b) The CLASSIC ruleset runs whichever tree the player picked, alone -- a
    classic 3.21 module has no rerelease asset requirements to satisfy, and
    mounting the other tree underneath would only invite silent
    cross-tree resolution the player never asked for.

AVAILABILITY IS SCANNED, NEVER ASSUMED. What each tree actually holds is a
property of THIS MACHINE'S installs, not of the content table above, so
every per-tree question below is answered from ScanDataTree's real reading
of the trees (loose maps/*.bsp plus the contents of every pak, which is
where both trees in fact keep their campaign maps).
=============================================================================
*/

export type DataTreeId = "classic" | "rerelease";

export const DATA_TREES: ReadonlyArray<{ id: DataTreeId; name: string }> = [
  { id: "classic", name: "original" },
  { id: "rerelease", name: "re-release" },
];

export function DataTreeDisplayName(id: DataTreeId): string {
  return DATA_TREES.find((t) => t.id === id)?.name ?? id;
}

// What FS_SetDataRoot must be told for one (ruleset, tree) choice: which
// tree wins name collisions, and which (if any) sits beneath it as the
// asset fallback. See rules (a)/(b) above.
export interface DataMountPlan {
  readonly primary: DataTreeId;
  readonly fallback: DataTreeId | null;
  // The one prefix carve-out: which tree `maps/` comes from, when that is
  // NOT the primary tree. Null means "no carve-out, everything follows the
  // mount order" -- true of every combination except kex + original data.
  readonly mapsFrom: DataTreeId | null;
}

export function DataMountPlanFor(ruleset: RulesetId, tree: DataTreeId): DataMountPlan {
  // (b) classic ruleset: the picked tree, alone, no carve-out.
  if (ruleset !== "rerelease") return { primary: tree, fallback: null, mapsFrom: null };

  // (a) kex ruleset on rerelease data: one tree, nothing to disambiguate.
  if (tree === "rerelease") return { primary: "rerelease", fallback: null, mapsFrom: null };

  // (a) kex ruleset on ORIGINAL data: rerelease assets win everywhere
  // ("we use the things from that ruleset") EXCEPT the map files, which
  // stay the player's 1997 geometry.
  return { primary: "rerelease", fallback: "classic", mapsFrom: "classic" };
}

/*
===============
DataTreeScan

One data tree's real contents: which gamedirs it has, and which map names
are reachable inside each of them. Map names are stored exactly as a
LaunchPlan.map spells them -- "maps/" prefix and ".bsp" suffix stripped,
subdirectories kept ("q64/rtest") -- so availability is a plain set lookup.
===============
*/
export interface DataTreeScan {
  readonly id: DataTreeId;
  readonly root: string;
  // Empty root string, or a root with no baseq2 at all: nothing about this
  // tree is selectable, and the kex ruleset cannot run at all without the
  // rerelease one.
  readonly present: boolean;
  // Gamedir name -> the map names reachable when that gamedir is mounted
  // over baseq2. Always carries a BASEDIRNAME entry when present.
  readonly mapsByGamedir: ReadonlyMap<string, ReadonlySet<string>>;
  // Sibling gamedirs that qualify (GameDirQualifies), excluding baseq2.
  readonly gamedirs: readonly string[];
}

function mapNameFrom(entry: string): string | null {
  const lower = entry.toLowerCase().replace(/\\/g, "/");
  if (!lower.startsWith("maps/") || !lower.endsWith(".bsp")) return null;
  return lower.slice("maps/".length, -".bsp".length);
}

// Every map name reachable in one gamedir directory: the loose maps/ tree
// plus the contents of every pak in it. Both of this machine's trees keep
// their campaign maps in paks, so the pak half is the load-bearing one.
function MapsInGamedir(seam: GameFsSeam, gamedirPath: string): Set<string> {
  const names = new Set<string>();

  for (const loose of seam.listFiles(`${gamedirPath}/maps/*.bsp`) ?? []) {
    const name = mapNameFrom(`maps/${basenameOf(loose)}`);
    if (name !== null) names.add(name);
  }

  for (const pak of seam.listFiles(`${gamedirPath}/*.pak`) ?? []) {
    for (const entry of seam.listPakEntries(pak) ?? []) {
      const name = mapNameFrom(entry);
      if (name !== null) names.add(name);
    }
  }

  return names;
}

/*
===============
ScanDataTree

Read one data root. Cheap enough to run on menu open (it parses pak
DIRECTORIES only, never file bodies), and cached by root path below since a
tree's contents cannot change during a session.
===============
*/
export function ScanDataTree(seam: GameFsSeam, id: DataTreeId, root: string): DataTreeScan {
  const mapsByGamedir = new Map<string, ReadonlySet<string>>();

  if (!root.length) {
    return { id, root, present: false, mapsByGamedir, gamedirs: [] };
  }

  const baseMaps = MapsInGamedir(seam, `${root}/${BASEDIRNAME}`);
  const baseListing = seam.listFiles(`${root}/${BASEDIRNAME}/*`);
  const present = baseListing !== null || baseMaps.size > 0;
  if (!present) {
    return { id, root, present: false, mapsByGamedir, gamedirs: [] };
  }
  mapsByGamedir.set(BASEDIRNAME, baseMaps);

  const gamedirs: string[] = [];
  for (const path of seam.listFiles(`${root}/*`) ?? []) {
    const dirname = basenameOf(path);
    if (dirname === BASEDIRNAME) continue;
    if (!GameDirQualifies(seam, path)) continue;
    gamedirs.push(dirname);
    mapsByGamedir.set(dirname, MapsInGamedir(seam, path));
  }
  gamedirs.sort();

  return { id, root, present: true, mapsByGamedir, gamedirs };
}

// Scans are keyed by root path and reused across menu opens -- a data tree's
// on-disk contents do not change while the client runs, and re-parsing the
// rerelease pak's 14k-entry directory on every open would be pure waste.
const data_tree_scan_cache = new Map<string, DataTreeScan>();

export function CachedScanDataTree(seam: GameFsSeam, id: DataTreeId, root: string): DataTreeScan {
  const key = `${id}\0${root}`;
  const hit = data_tree_scan_cache.get(key);
  if (hit) return hit;
  const scan = ScanDataTree(seam, id, root);
  data_tree_scan_cache.set(key, scan);
  return scan;
}

// Tests that build fixture trees per case must not see an earlier case's
// answer for a reused temp path.
export function ResetDataTreeScanCache(): void {
  data_tree_scan_cache.clear();
}

/*
===============
LaunchPlanRunsInTree

Can this launch plan's map actually be loaded out of this tree? The plan's
gamedir layer is searched first, then baseq2 underneath it -- exactly the
search order FS_SetGamedir lays down, so this answers the real question
("would `map <plan.map>` find a bsp?") rather than a naming convention.

The kex ruleset's plans all name game "kex", whose directory carries no
maps in either tree (all rerelease content lives in the rerelease baseq2
pak); those fall through to the baseq2 lookup, which is correct.
===============
*/
export function LaunchPlanRunsInTree(plan: LaunchPlan, scan: DataTreeScan): boolean {
  if (!scan.present) return false;
  const dir = plan.game.length ? plan.game : BASEDIRNAME;
  if (scan.mapsByGamedir.get(dir)?.has(plan.map)) return true;
  return scan.mapsByGamedir.get(BASEDIRNAME)?.has(plan.map) === true;
}

export type DataTreeScans = Readonly<Record<DataTreeId, DataTreeScan>>;

function scanFor(scans: DataTreeScans, id: DataTreeId): DataTreeScan {
  return scans[id];
}

/*
===============
AvailableDataTreesFor

Which data trees a (game, ruleset) selection can actually run out of, in
DATA_TREES' fixed display order.

Rule (a) is enforced here as a PRECONDITION rather than as a forced choice:
the kex ruleset needs the rerelease tree mounted either way (primary, or
beneath the classic tree as the asset fallback), so if there is no rerelease
tree on this machine at all, the kex ruleset offers no data trees -- and
AvailableRulesetsForGameInTrees below therefore drops the ruleset entirely,
instead of letting the player pick a combination that would reproduce
finding 2's spam.
===============
*/
export function AvailableDataTreesFor(game: SelectableGame, ruleset: RulesetId, scans: DataTreeScans): DataTreeId[] {
  if (ruleset === "rerelease" && !scanFor(scans, "rerelease").present) return [];

  return DATA_TREES.map((t) => t.id).filter((treeId) => {
    const scan = scanFor(scans, treeId);
    if (!scan.present) return false;
    if (game.kind === "discovered") {
      // A discovered mod is only offered for the trees that actually hold
      // its directory -- a mod installed in the classic tree only must not
      // appear as a rerelease-data option.
      return scan.gamedirs.includes(game.dirname);
    }
    const plan = ResolveLaunch(game.content.id, ruleset);
    return plan !== null && LaunchPlanRunsInTree(plan, scan);
  });
}

/*
===============
AvailableRulesetsForGameInTrees

AvailableRulesetsForGame with rule (a)'s ONE precondition applied: the kex
ruleset needs a rerelease tree to exist, because it is mounted either way
(primary, or beneath the classic tree as the asset fallback). On a
classic-only install there is nothing to mount, so the ruleset is not
offered -- which is precisely the combination that produced Mike's finding-2
asset spam.

Deliberately NOT narrowed any further than that. An earlier revision also
dropped any ruleset whose content the scan could not find in either tree;
that made the whole screen depend on the scan being right about every
install layout, and an unconfigured data_root_classic/data_root_rerelease
pair (both scans "not present") left the player with no selectable ruleset
at all and a "begin" that silently did nothing. The scan drives the DATA
row, where being wrong costs a greyed spincontrol; it does not get to veto
the ruleset row, where being wrong costs the ability to start a game.
===============
*/
export function AvailableRulesetsForGameInTrees(game: SelectableGame, scans: DataTreeScans): RulesetId[] {
  return AvailableRulesetsForGame(game).filter((ruleset) => ruleset !== "rerelease" || scanFor(scans, "rerelease").present);
}

/*
===============
EffectiveDataTreeFor

Which tree a launch actually uses, given the scan's answer and the tree the
engine booted against.

The empty-`available` case is the one that matters: it means the scan could
not place this selection in either tree (unconfigured data_root_* cvars, or
an install layout the scan does not recognize). For the CLASSIC ruleset the
answer is null -- no remount is queued and the launch runs against whatever
is already mounted, exactly as it did before this feature existed. For the
KEX ruleset the answer is "rerelease" regardless, because rule (a) is not
negotiable: a kex launch that skipped the remount could end up on a
classic-only mount, which is the spam Mike reported.

`booted` (the tree the engine's own basedir is) wins over list order when it
is available, so a normal launch keeps playing out of the tree it started
from and the data row is a genuine choice rather than a silent switch.
===============
*/
export function EffectiveDataTreeFor(ruleset: RulesetId, available: readonly DataTreeId[], booted: DataTreeId): DataTreeId | null {
  if (!available.length) return ruleset === "rerelease" ? "rerelease" : null;
  if (available.includes(booted)) return booted;
  return available[0] ?? null;
}

/*
===============
DiscoverGameDirsInTrees

The discovered-mod list across BOTH trees, deduped by name and sorted --
the per-tree replacement for DiscoverGameDirs' single root list. A mod that
exists in both trees appears once; AvailableDataTreesFor reports which trees
it can be played from, and GameListDisplayNameInTrees labels the
single-tree case.
===============
*/
export function DiscoverGameDirsInTrees(scans: DataTreeScans): string[] {
  const excluded = CuratedGameDirnames();
  const found: string[] = [];
  for (const { id } of DATA_TREES) {
    for (const dirname of scanFor(scans, id).gamedirs) {
      if (dirname === BASEDIRNAME || excluded.has(dirname) || found.includes(dirname)) continue;
      found.push(dirname);
    }
  }
  return found.sort();
}

/*
===============
GameListDisplayNameInTrees

The menu row's label, with a tree tag when the game exists in only one of
the two trees ("lmctf (original)") so the player can tell at a glance which
data a discovered mod belongs to. Games present in both trees keep their
plain name -- the "maps/data" spincontrol is where that choice is made.
===============
*/
export function GameListDisplayNameInTrees(game: SelectableGame, scans: DataTreeScans): string {
  const name = GameListDisplayName(game);
  const trees = new Set<DataTreeId>();
  for (const ruleset of AvailableRulesetsForGame(game)) {
    for (const treeId of AvailableDataTreesFor(game, ruleset, scans)) trees.add(treeId);
  }
  if (trees.size !== 1) return name;
  const only = [...trees][0];
  if (only === undefined) return name;
  return `${name} (${DataTreeDisplayName(only)})`;
}
