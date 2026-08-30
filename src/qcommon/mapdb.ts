// mapdb.c / mapdb.h -- loader for the re-release's mapdb.json episode/level
// catalog. Reference: q2repro (Jonathan "Paril" Barkley, GPLv2) checked out
// at ~/Projects/qsrc/q2repro -- src/common/mapdb.c and inc/common/mapdb.h
// are the C shape this ports; src/client/ui/mapdb.c is the reference for
// how a UI consumes it (see menu_content.ts, which adapts that BEHAVIOR
// into our own qmenu.ts/qmenu_impl.ts widget idiom rather than porting
// q2repro's ui/ framework).
//
// Family-neutral by design: this module only knows how to read the catalog
// id Software/ZeniMax ship inside the re-release baseq2/pak0.pak
// (mapdb.json). It makes no decision about which game family (legacy vs
// kex) plays which entry, or which ruleset a piece of content belongs to
// -- that mapping is src/client/menu_content.ts's job, and lives entirely
// in that file's header/table.
//
// REAL SCHEMA (extracted 2026-08-30 from ~/q2rets/rerelease/baseq2/
// pak0.pak's mapdb.json -- 1700 lines / 40120 bytes / 5 episodes / 232
// maps -- not the q2repro checkout's synthetic example, the actual retail
// file):
//
//   {
//     "episodes": [
//       { "id": "baseq2", "command": "newgame", "name": "Quake II",
//         "activity": "start_quake", "needsSkillSelect": true },
//       ... (mg2 "Call of the Machine", xatrix "The Reckoning",
//            rogue "Ground Zero", n64 "Quake II 64" -- 5 total, all
//            needsSkillSelect: true)
//     ],
//     "maps": [
//       { "bsp": "q2dm1", "title": "The Edge", "episode": "baseq2",
//         "dm": true, "bot": true },
//       { "bsp": "q2ctf1", "title": "McKinley Revival", "episode": "baseq2",
//         "ctf": true, "tdm": false },
//       { "bsp": "*ntro.cin+base1", "title": "Unit 1: Base",
//         "episode": "baseq2", "display_bsp": false, "sp": true,
//         "coop": true },
//       ...
//     ]
//   }
//
// Every map/episode key is optional per-entry. q2repro's C mallocz-zeroes
// the struct before parsing (Z_TagMallocz), so an absent key means "" for
// strings, 0 for numbers, false for booleans -- matched here with the same
// per-field defaults rather than making any of these fields optional in
// the TS type (PORTING.md: "C structs -> class with every field
// initialized", applied to these plain-data interfaces too).
//
// FIELD NAME DISCREPANCY (report only -- it's q2repro's file, not ours,
// and not something this port can or should "fix" upstream): the checked-
// out mapdb.c's map_keys table declares the bot flag as
// `KEY_BOOLEAN(bots)` (JSON key "bots", see mapdb_map_t.bots in
// inc/common/mapdb.h), but every single one of the 232 map entries in the
// real mapdb.json spells the key "bot" (singular). MapDB_ParseKeys's own
// "key not found in table -> Com_DPrintf + skip" branch means a q2repro
// binary built from that exact checkout would silently ignore every "bot"
// flag in its own shipping data file, leaving `bots` false for all 232
// entries. This port reads the REAL field name ("bot") straight off the
// actual data -- the only way the flag could mean anything to any
// consumer -- per FIDELITY RAZOR (.orch/preferences.md rule 17): fidelity
// is measured in observable behavior, and "silently drop the flag because
// of a name typo in one reference checkout" is not behavior worth
// reproducing on purpose.
//
// `activity` (episode) is read and kept even though q2repro's own table
// explicitly skips it (`KEY_SKIP(activity)`, a Discord rich-presence key
// in the real client) -- costs nothing to retain, might be useful later,
// nothing here depends on it.
//
// `command` (episode, e.g. "newgame_xatrix") mirrors q2repro's
// mapdb_episode_t.command faithfully as a schema field, but nothing in
// this engine ever executes it: those commands are closed-source KEX-
// binary-only console commands (cutscene-chained "start a fresh campaign"
// flows) with zero occurrences anywhere in q2repro's own GPL sources or in
// the rerelease-dll GPL sources searched for this port. See
// menu_content.ts's header for how content actually launches here instead
// -- q2repro's OWN mapdb "level" selector mechanism (ui/mapdb.c's
// MapDB_Run_f, `_mapdb_type == "level"` branch: `Cvar_Set("g_start_items",
// ...); map <bsp>`), not the `episode` branch's `Cbuf_AddText(command)`.

import { FS_LoadFile } from "./files";
import { Com_Printf } from "./common";

export interface MapdbEpisode {
  id: string;
  command: string;
  name: string;
  activity: string;
  needsSkillSelect: boolean;
}

export interface MapdbMap {
  bsp: string;
  title: string;
  episode: string;
  short: string;
  unit: number;
  sp: boolean;
  dm: boolean;
  bot: boolean;
  ctf: boolean;
  tdm: boolean;
  coop: boolean;
  display_bsp: boolean;
  start_items: string;
}

export interface MapdbT {
  episodes: MapdbEpisode[];
  maps: MapdbMap[];
}

const EMPTY_MAPDB: MapdbT = { episodes: [], maps: [] };

let mapdb: MapdbT = EMPTY_MAPDB;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : "";
}

function bool(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key];
  return typeof v === "boolean" ? v : false;
}

function num(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function parseEpisode(v: unknown): MapdbEpisode | null {
  if (!isRecord(v)) return null;
  return {
    id: str(v, "id"),
    command: str(v, "command"),
    name: str(v, "name"),
    activity: str(v, "activity"),
    needsSkillSelect: bool(v, "needsSkillSelect"),
  };
}

function parseMap(v: unknown): MapdbMap | null {
  if (!isRecord(v)) return null;
  return {
    bsp: str(v, "bsp"),
    title: str(v, "title"),
    episode: str(v, "episode"),
    short: str(v, "short"),
    unit: num(v, "unit"),
    sp: bool(v, "sp"),
    dm: bool(v, "dm"),
    bot: bool(v, "bot"),
    ctf: bool(v, "ctf"),
    tdm: bool(v, "tdm"),
    coop: bool(v, "coop"),
    display_bsp: bool(v, "display_bsp"),
    start_items: str(v, "start_items"),
  };
}

/*
===============
MapDB_Init

Loads and parses mapdb.json off the active search path. Present only in
the re-release baseq2/pak0.pak (directly, or via files.ts's content_root
mount) -- classic-only basedirs have no such file, which is not an error,
matching q2repro's own graceful "WPrintf + shutdown" behavior on a missing
or malformed file (MapDB_Init in the reference: Json_ErrorHandler catches
the failure, warns, calls MapDB_Shutdown, returns -- never a hard error).

Safe to call repeatedly: menu_content.ts's Content & Rules screen calls
this every time it opens, the same idiom menu.ts's StartServer_MenuInit
uses re-reading maps.lst on every open.
===============
*/
export function MapDB_Init(): void {
  const raw = FS_LoadFile("mapdb.json");
  if (!raw) {
    MapDB_Shutdown();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    Com_Printf("Failed to load/parse mapdb.json: %s\n", e instanceof Error ? e.message : String(e));
    MapDB_Shutdown();
    return;
  }

  if (!isRecord(parsed)) {
    Com_Printf("Failed to load/parse mapdb.json: not an object\n");
    MapDB_Shutdown();
    return;
  }

  const episodesRaw = parsed["episodes"];
  const mapsRaw = parsed["maps"];

  const episodes: MapdbEpisode[] = Array.isArray(episodesRaw)
    ? episodesRaw.map(parseEpisode).filter((e): e is MapdbEpisode => e !== null)
    : [];
  const maps: MapdbMap[] = Array.isArray(mapsRaw) ? mapsRaw.map(parseMap).filter((m): m is MapdbMap => m !== null) : [];

  mapdb = { episodes, maps };
}

/*
===============
MapDB_Get
===============
*/
export function MapDB_Get(): MapdbT {
  return mapdb;
}

/*
===============
MapDB_Shutdown
===============
*/
export function MapDB_Shutdown(): void {
  mapdb = EMPTY_MAPDB;
}

/*
===============
MapDB_ResolveBsp

Not a q2repro function. q2repro's own mapdb "level" selector (ui/mapdb.c's
MapDB_Run_f) passes maps[level].bsp to `map ` VERBATIM, because the real
KEX client's `map` command itself understands the "cutscene.cin+*realbsp"
chaining syntax every multi-unit campaign-start entry uses (e.g.
"eou1_.cin+*bunk1": play the cutscene, then load bunk1). Our `map` command
doesn't parse that syntax -- cinematic-chained campaign starts are out of
scope for this engine -- so menu_content.ts needs the literal, loadable
bsp name instead. Rule, verified against all 33 sp:true entries in the
real mapdb.json (2026-08-30 extraction, see menu_content.test.ts): split
on "+", take the last segment, strip one leading "*". Degrades correctly
for the many entries that were never composite to begin with (plain
"q2dm1", or single-segment-with-star entries like "*mguhub", "*xship").
===============
*/
export function MapDB_ResolveBsp(bspField: string): string {
  const segments = bspField.split("+");
  const last = segments[segments.length - 1] ?? bspField;
  return last.startsWith("*") ? last.slice(1) : last;
}

/*
===============
MapDB_UnitsForEpisode

Not a q2repro function (adapts ui/mapdb.c's UI_MapDB_FetchUnits behavior,
which builds one flat cross-episode list, into a per-episode query that
menu_content.ts's Content & Rules screen uses to populate its "start
point" spin control once a content/episode is chosen). Returns every
sp:true entry for the given episode id, in file order (array order is the
authored unit sequence -- q2repro's own map_keys `unit` field is absent on
all but one entry in the real data and can't be relied on for ordering;
see this file's header discrepancy note for the same kind of real-data-
vs-reference-checkout mismatch).
===============
*/
export interface MapdbUnitEntry {
  title: string;
  bsp: string;
}

export function MapDB_UnitsForEpisode(episodeId: string): MapdbUnitEntry[] {
  const result: MapdbUnitEntry[] = [];
  for (const m of mapdb.maps) {
    if (!m.sp || m.episode !== episodeId) continue;
    result.push({ title: m.title, bsp: MapDB_ResolveBsp(m.bsp) });
  }
  return result;
}
