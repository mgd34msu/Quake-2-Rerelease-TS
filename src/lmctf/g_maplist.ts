// Ports LM_CTF's maplist.txt map rotation list: the `MapInfo maplist[300]`
// / `maplistindex` globals declared in lmctf60/g_local.h:619-632 and
// lmctf60/g_main.c:99-100, the reader that fills them (the `// CTF CODE --
// LM_JORM` block inside lmctf60/g_save.c's InitGame, g_save.c:266-328),
// the quicksort that orders them (SortMaplist/MapDivide/flip,
// g_save.c:385-412), and the rotation shuffle Randomize_Map_List
// (g_main.c:265-288) with its Maps_Picked table (g_main.c:261).
//
// Split into its own file rather than added to g_main.ts because the two
// halves live in two different C files (g_save.c reads the file,
// g_main.c shuffles and walks the result) and because g_cmds.ts's
// Cmd_Match_f and Cmd_GotoMap_f are the only consumers so far -- a
// map-rotation module with one loader entry point is a cleaner seam than
// growing either of those files with the other's half.
//
// STATUS: the list, the loader, the sort and the shuffle are ported.
// getRandomMapByPlayerCount (g_main.c:290) and the maplistindex rotation
// walk inside EndDMLevel (g_main.c:540-570, and the `maplistindex == -1`
// startup block at g_main.c:648-665) are NOT ported -- they belong to
// g_main.ts's own SCOPE, and g_main.ts's file header already documents
// them as unported. This module exposes everything they need
// (maplist/maplistindex/Maps_Picked/Randomize_Map_List) so that pass is a
// pure addition there.
//
// File I/O goes through src/qcommon/files.ts's FS_ReadRawFile, the same
// sanctioned FS seam g_skins.ts's SkinsReadFile uses and for the same
// reason: the C source builds a literal on-disk path by hand
// (`gamedir->string + "/" + maplist_file->string`) and fopen()s it
// directly, which is FS_ReadRawFile's documented use case, rather than
// resolving a name through the engine's virtual quake search path
// (FS_LoadFile). The C's `fopen(fname)` -> `fopen("maplist.txt")` fallback
// is reproduced as a second FS_ReadRawFile call.

import { CVAR_SERVERINFO } from "../shared/q_shared";
import { gi } from "./g_local";
import { FS_ReadRawFile } from "../qcommon/files";

// g_main.c:259
export const MAX_MAPS = 300;

/*
=================
MapInfoT (lmctf60/g_local.h:619)

`next` is part of the C struct and is left here for struct fidelity, but
nothing in this port writes it: its only C consumer is
getRandomMapByPlayerCount (g_main.c:290), which builds a temporary linked
list through these entries and is not ported (see this file's header).
=================
*/
export interface MapInfoT {
  mapname: string;
  minplayers: number;
  maxplayers: number;
  next: MapInfoT | null;
}

/*
=================
maplist / maplistindex (lmctf60/g_main.c:99-100)

The C declares `MapInfo maplist[300]` with a NULL-`mapname` sentinel
marking the end, so every C consumer walks it as
`for (i = 0; maplist[i].mapname; i++)`. Here the array's own length is the
terminator and consumers use a plain `for..of`.

The fixed 300-entry capacity is deliberately NOT reproduced as a hard cap.
The C's reader writes `maplist[maplistindex]` with no bound check at all,
so a maplist.txt with more than 300 lines is an out-of-bounds write into
adjacent static storage -- undefined behavior this port cannot reproduce
as anything meaningful. An unbounded array matches every in-range
behavior exactly and has no failure mode to diverge on for any real
maplist.txt, the same reasoning (and the same rule 17 FIDELITY RAZOR
call) g_skins.ts's SkinEntry doc comment already makes for skinlist's
256-entry array. MAX_MAPS is still exported and is still honored where the
C actually tests it -- Randomize_Map_List's own clamp below.

`maplistindex` is a rotation cursor with two sentinel values the C relies
on: -1 means "list loaded, first time through", -2 means "no list, use the
standard maps". 0 means "never read the file yet", which is what gates the
loader.
=================
*/
export const maplist: MapInfoT[] = [];

export let maplistindex = 0;

export function SetMaplistIndex(v: number): void {
  maplistindex = v;
}

// g_main.c:261 -- `short Maps_Picked[MAX_MAPS]`.
export const Maps_Picked = new Int16Array(MAX_MAPS);

/*
=================
Randomize_Map_List (lmctf60/g_main.c:265) -- byte-identical to the C
source, preserved quirks and all:
  - the shuffle loop starts at i=1, never i=0, so map slot 0 of the picked
    order is only ever filled by the linear-probe fallback below -- entry
    0 of the shuffled order is effectively always whatever the probe lands
    on rather than a randomly chosen map;
  - `rand() % (Num_Of_Maps - 2)` never generates the last two indices
    directly (and divides by zero -- undefined behavior in C -- for a
    two-entry maplist), so those slots are also reachable only through the
    probe;
  - the probe walks forward and wraps at Num_Of_Maps, not at MAX_MAPS.
None of that is "fixed" here; the shuffle is meant to match the C's actual
rotation order, oddities included.
=================
*/
export function Randomize_Map_List(Num_Of_Maps: number): void {
  let numMaps = Num_Of_Maps;
  if (numMaps > MAX_MAPS) numMaps = MAX_MAPS;

  for (let i = 0; i < MAX_MAPS; i++) Maps_Picked[i] = 0;

  for (let i = 1; i < numMaps; i++) {
    // C: `rand() % (Num_Of_Maps - 2)`. For numMaps < 3 the C divides by
    // zero or a negative; Math.trunc of a non-finite/negative modulus is
    // guarded to 0 here so this port cannot produce a NaN index where the
    // C produces a garbage-but-in-range one.
    const span = numMaps - 2;
    let Rand_Num = span > 0 ? Math.floor(Math.random() * span) : 0;
    while (Maps_Picked[Rand_Num]) {
      Rand_Num++;
      if (Rand_Num === numMaps) Rand_Num = 0;
    }
    Maps_Picked[Rand_Num] = i;
  }
}

/*
=================
flip / MapDivide / SortMaplist (lmctf60/g_save.c:408 / :394 / :385)

A literal port of the C's own Lomuto-partition quicksort over mapname,
NOT a call to Array.prototype.sort: the two orderings differ for equal or
near-equal keys (a maplist.txt is allowed to list the same map twice), and
the rotation order that comes out of this is player-visible.
=================
*/
function flip(arr: MapInfoT[], x: number, y: number): void {
  const tmp = arr[x];
  arr[x] = arr[y];
  arr[y] = tmp;
}

function MapDivide(arr: MapInfoT[], min: number, max: number): number {
  // C: `MapInfo tmp = arr[max];` -- a struct COPY of the pivot. arr[max]
  // is not touched until the final flip below, so capturing just the
  // pivot's name here is equivalent and unambiguous.
  const pivotName = arr[max].mapname;
  let nndx = min - 1;

  for (let x = min; x <= max - 1; x++) {
    // C: `strcmp(arr[x].mapname, tmp.mapname) < 0` -- byte-order compare,
    // which is what JS's `<` on strings does for the ASCII map names a
    // maplist.txt holds (the reader has already lowercased them).
    if (arr[x].mapname < pivotName) {
      nndx++;
      flip(arr, nndx, x);
    }
  }
  flip(arr, nndx + 1, max);
  return nndx + 1;
}

export function SortMaplist(arr: MapInfoT[], min: number, max: number): void {
  if (min < max) {
    const ndx = MapDivide(arr, min, max);
    SortMaplist(arr, min, ndx - 1);
    SortMaplist(arr, ndx + 1, max);
  }
}

/*
=================
parseMaplistLine (replaces g_save.c:284-300's cascade of
`sscanf(line, "%s %d %d")` -> `sscanf(line, "%s %d")` -> `sscanf(line,
"%s")`)

The C tries the three-field form first, falls back to two fields, then to
one, and only reports "Bad entry in maplist" when even a bare map name
fails to scan. `tempmin`/`tempmax` are initialized to 0/99 before the
scans, so a one-field line keeps 0/99 and a two-field line keeps 99 as its
maximum. The name is lowercased in place afterward "for subsequent
comparisons" (the C's own comment), which is why Cmd_GotoMap_f lowercases
its argument before matching.

One scan cascade with an optional-number tail reproduces all three
outcomes exactly, including the C's behavior on a trailing non-numeric
token ("q2dm1 abc" scans one field, not two, and keeps the defaults).
=================
*/
function parseMaplistLine(line: string): MapInfoT | null {
  const nameMatch = /^\s*(\S+)/.exec(line);
  if (nameMatch === null) return null; // even "%s" found nothing

  let rest = line.slice(nameMatch[0].length);
  let minplayers = 0;
  let maxplayers = 99;

  const minMatch = /^\s*([+-]?\d+)/.exec(rest);
  if (minMatch !== null) {
    minplayers = Number.parseInt(minMatch[1], 10);
    rest = rest.slice(minMatch[0].length);
    const maxMatch = /^\s*([+-]?\d+)/.exec(rest);
    if (maxMatch !== null) maxplayers = Number.parseInt(maxMatch[1], 10);
  }

  return {
    // C: `for (i = 0; i < strlen(tempname); i++) tempname[i] =
    // tolower(tempname[i]);`
    mapname: nameMatch[1].toLowerCase(),
    minplayers,
    maxplayers,
    next: null,
  };
}

/*
=================
MaplistReadFile (lmctf60/g_save.c:266-328, the `// CTF CODE -- LM_JORM`
maplist block inside InitGame)

Reads `<gamedir>/<maplist_file>` (falling back to a bare "maplist.txt" in
the working directory exactly as the C's second fopen does), fills
`maplist`, sorts it, shuffles the rotation order and leaves `maplistindex`
at -1 (list loaded) or -2 (no list / empty list).

`if (!maplistindex)` guards the whole block in the C -- InitGame can run
more than once per process and the list is only read the first time --
so the same `maplistindex !== 0` early-out is kept here.

The `gamedir` and `maplist_file` cvars (registered by lmctf60/g_save.c:213
and :234) have no slot in g_local.ts's gameCvars holder yet. They are
resolved lazily through `gi.cvar()` at call time instead of being cached:
gi.cvar is Cvar_Get, which returns the ALREADY-REGISTERED cvar when one
exists and only creates it (with the C's own default) otherwise, so this
reads exactly the value InitGame's own registration produces without
needing an edit to g_local.ts or a stand-in constant.
=================
*/
function cvarString(name: string, defaultValue: string, flags: number): string {
  const c = gi.cvar(name, defaultValue, flags);
  return c === null ? defaultValue : c.string;
}

export function MaplistReadFile(): void {
  if (maplistindex !== 0) return; // Have we done this before?

  // g_save.c:213 `gamedir = gi.cvar("game", "lmctf", CVAR_SERVERINFO)`
  const gamedir = cvarString("game", "lmctf", CVAR_SERVERINFO);
  // g_save.c:234 `maplist_file = gi.cvar("maplist_file", "maplist.txt", 0)`
  const maplistFile = cvarString("maplist_file", "maplist.txt", 0);

  const fname = `${gamedir}/${maplistFile}`;
  let buf = FS_ReadRawFile(fname);
  if (buf === null) buf = FS_ReadRawFile("maplist.txt");

  if (buf === null) {
    gi.dprintf(`Can't find ${fname}.  Reverting to standard maps.\n`);
    maplistindex = -2; // Not going to use it
    return;
  }

  // If there is a maplist file, read it
  //   And use it for our list of maps.
  maplist.length = 0;
  maplistindex = 0;

  const text = new TextDecoder().decode(buf);
  // C: `while (fgets(line, 255, file))` -- one record per '\n'. A trailing
  // '\r' on a CRLF file stays part of the line, exactly as fgets leaves
  // it; it never reaches a field because "%s" and "%d" both stop at
  // whitespace. A final chunk with no newline is still a record (fgets
  // returns it), but a trailing empty string after the last '\n' is not.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    const parsed = parseMaplistLine(line);
    if (parsed === null) {
      // C: `sprintf(line, "Bad entry in maplist"); gi.dprintf(line);` --
      // no trailing newline, preserved.
      gi.dprintf("Bad entry in maplist");
      continue;
    }
    maplist.push(parsed);
    maplistindex++;
  }

  SortMaplist(maplist, 0, maplistindex - 1);
  gi.dprintf(`${maplistindex} entries in maplist.\n`);

  if (maplistindex) {
    // Did we read anything?
    Randomize_Map_List(maplistindex);
    maplistindex = -1; // This means first time through the list
  } else {
    maplistindex = -2; // Not going to use it
  }
}

/*
=================
ResetMaplistForTest -- no C equivalent (the real process reads the file
once per server lifetime and never unwinds it). Restores this module to
"server just booted, maplist.txt never read", mirroring g_skins.ts's own
ResetSkinsForTest.
=================
*/
export function ResetMaplistForTest(): void {
  maplist.length = 0;
  maplistindex = 0;
  Maps_Picked.fill(0);
}
