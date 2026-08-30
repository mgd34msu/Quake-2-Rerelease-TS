// Ports lmctf60/g_skins.c + g_skins.h -- LM_CTF's skins.ini team-skin list
// ("CTF CODE -- LM_SURT" per g_local.h's declarations), a config file the
// server loads at startup listing which player model/skin pairs are valid
// for the red and blue teams, used by g_menu.ts's skin-picker menu.
//
// STATUS: complete. All five g_skins.c functions are ported: SkinsReadFile,
// SkinValid, SkinListInUse, SkinRandom, SkinGetList. CopyString (a
// strdup-via-TagMalloc helper) is dropped -- JS strings need no backing
// allocation, so every C call site that did `CopyString(x)` just uses `x`
// directly here, same treatment ED_NewString-adjacent helpers get
// elsewhere in this port.
//
// File I/O goes through src/qcommon/files.ts's FS_ReadRawFile, the same
// sanctioned FS seam src/ctf/g_save.ts and src/game/g_save.ts use for a
// literal, already-fully-qualified on-disk path (checked both before
// writing this file) -- not a raw Node fs call and not gi.TagMalloc+fopen
// the way the C source does it (TagMalloc/TagFree are OMITTED per
// PORTING.md). FS_ReadRawFile is the correct half of the FS seam here
// (not FS_LoadFile, which resolves its argument through the engine's
// virtual quake search path instead): the C source builds its own literal
// path by hand (`gamedir->string + "/" + skin_file->string`) and calls
// `fopen()` directly on it, which is exactly FS_ReadRawFile's documented
// use case ("callers that already hold a fully-qualified filesystem path
// ... rather than a filename to resolve through the virtual quake search
// path"). Reproduced with the same manual concatenation below.
//
// The `gamedir`/`skin_file`/`skin_debug` cvars are registered by
// lmctf60/g_save.c (`gi.cvar("game", "lmctf", CVAR_SERVERINFO)` /
// `gi.cvar("skin_file", "skins.ini", 0)` / `gi.cvar("skin_debug", "0",
// 0)`), which is unit A's not-yet-created g_save.ts -- g_local.ts's
// gameCvars object (also not this unit's file) does not have slots for
// them yet either. Ported as local stand-ins carrying the same C defaults,
// swappable for the real gi.cvar-backed values once g_save.ts lands (see
// "Cross-dependencies" below).

import { FS_ReadRawFile } from "../qcommon/files";
import { CTF_TEAM_RED } from "./g_ctffunc";
import type { EdictT } from "./g_local";
import { gi } from "./g_local";

// g_skins.c:5-13
const SKIN_RED = 0;
const SKIN_BLUE = 1;
// SKIN_MAXCOLOR (2) has no direct use here: it only sized the C source's
// fixed `skinlist[SKIN_MAXCOLOR][...]` array, replaced below by two
// separate arrays.
// SKIN_MODELNAME/SKIN_SKINNAME/SKIN_MAXNAME (the C source's third array
// dimension selecting model-vs-skin within an entry) collapse into the
// SkinEntry tuple below -- see its own doc comment.
// SKIN_MAXSKINS (256, the C source's fixed per-color array capacity) is
// dropped: see SkinEntry's doc comment for why an unbounded TS array is
// the faithful choice here, not a silent capacity change.

// ---------------------------------------------------------------------
// Cross-dependencies / deviations from a literal port:
//
// - `skin_file`/`skin_debug` cvars: not yet registered anywhere in this
//   tree (owned by unit A's pending g_save.ts). Local stand-ins below
//   carry the exact C defaults ("skins.ini", 0) so SkinsReadFile's
//   observable behavior is unchanged; replace with `gameCvars.skin_file`/
//   `gameCvars.skin_debug` once g_save.ts registers them.
// - `char *skinlist[SKIN_MAXCOLOR][SKIN_MAXSKINS][SKIN_MAXNAME]` (a fixed
//   2x256x2 array with a NULL-entry sentinel marking each color list's
//   end) is represented as two plain SkinEntry[] arrays instead. This is
//   an observable-behavior-preserving choice under rule 17 (FIDELITY
//   RAZOR), not a silent simplification: the C array silently overflows
//   (undefined behavior -- out-of-bounds writes into adjacent static
//   storage) past 256 entries in either list, which this port cannot
//   reproduce as anything meaningful in JS; an unbounded array matches
//   every in-range behavior exactly and has no failure mode to diverge on
//   for any config file that actually stays under the 256-entry cap (a
//   realistic skins.ini always does).
// ---------------------------------------------------------------------

let gamedirValue = "lmctf"; // lmctf60/g_save.c: `gi.cvar("game", "lmctf", CVAR_SERVERINFO)`
let skinFileName = "skins.ini"; // lmctf60/g_save.c:235: `gi.cvar("skin_file", "skins.ini", 0)`

// exposed for tests only (mirrors real gi.cvar mutation, not part of
// g_skins.c's public API -- there is no equivalent C entry point since the
// C source reads the cvar pointers directly at call time).
export function SetSkinsConfigForTest(gamedir: string, skinFile: string): void {
  gamedirValue = gamedir;
  skinFileName = skinFile;
}
let skinDebug = false; // lmctf60/g_save.c:236: `gi.cvar("skin_debug", "0", 0)`

// exposed for tests only -- resets this module's state back to "server just
// booted, skins.ini never read" (skinlistinuse=false, both lists empty).
// No C equivalent: the real process only ever runs SkinsReadFile once per
// server lifetime, so nothing in g_skins.c itself needs to undo it.
export function ResetSkinsForTest(): void {
  skinlistinuse = false;
  skinlistRed.length = 0;
  skinlistBlue.length = 0;
}

/*
=================
SkinEntry (replaces the C source's `char *skinlist[color][i][SKIN_MODELNAME
|SKIN_SKINNAME]` third dimension)
=================
*/
interface SkinEntry {
  model: string;
  skin: string;
}

// g_skins.c:15-16
let skinlistinuse = false;
const skinlistRed: SkinEntry[] = [];
const skinlistBlue: SkinEntry[] = [];

function skinListForColor(colorindex: number): SkinEntry[] {
  return colorindex === SKIN_RED ? skinlistRed : skinlistBlue;
}

/*
=================
parseSkinLine (replaces `sscanf(line, "%[^/]/%s", model, skin) == 2`)

`%[^/]` greedily consumes everything up to (not including) the first '/';
`%s` then skips leading whitespace and reads one whitespace-delimited
token. Returns null when there is no '/' in the line (sscanf would fail to
match the literal '/' and return less than 2) or when there is no
non-whitespace token after it (same reason).
=================
*/
function parseSkinLine(line: string): { model: string; skin: string } | null {
  const slashIndex = line.indexOf("/");
  if (slashIndex === -1) return null;

  const model = line.slice(0, slashIndex);
  const rest = line.slice(slashIndex + 1);
  const match = /\S+/.exec(rest);
  if (match === null) return null;

  return { model, skin: match[0] };
}

/*
=================
SkinsReadFile (lmctf60/g_skins.c:27)

Loads skins.ini (or whatever `skin_file` names) and populates the red/blue
skin lists from its `[red]`/`[blue]` sections. Lines starting with '#',
'/', or ';' are comments; a bare "[red]"/"[blue]" line switches which list
subsequent "model/skin" lines are added to (starting in the red section,
matching the C source's `colorindex = SKIN_RED` initial value).
=================
*/
export function SkinsReadFile(): void {
  const buf = FS_ReadRawFile(`${gamedirValue}/${skinFileName}`);
  if (buf === null) return;

  const text = new TextDecoder().decode(buf);
  // C: `sscanf(tempbuf,"%[^\n]", line)` then `while (*tempbuf == '\n')
  // tempbuf++;` -- splits on '\n' only (a trailing '\r' on a CRLF file
  // stays part of `line`, exactly like the C source; not trimmed here
  // either).
  const lines = text.split("\n");

  skinlistRed.length = 0;
  skinlistBlue.length = 0;

  if (text.length === 0) {
    if (skinDebug) {
      gi.dprintf("Error: skins file empty.\n");
    }
    return;
  }

  skinlistinuse = true;
  let colorindex = SKIN_RED;

  for (const line of lines) {
    // Ignore lines with # or / or ;
    if (line[0] === "#" || line[0] === "/" || line[0] === ";") continue;

    // Determine which skinset we are dealing with
    if (line === "[red]") colorindex = SKIN_RED;
    if (line === "[blue]") colorindex = SKIN_BLUE;

    // If it is a skin, add it to the list
    if (line.length > 0) {
      const parsed = parseSkinLine(line);
      if (parsed !== null) {
        skinListForColor(colorindex).push(parsed);
      }
    }
  }

  if (skinDebug) {
    gi.dprintf("[red]\n");
    for (const entry of skinlistRed) {
      gi.dprintf(`MODEL: [${entry.model}]  SKIN: [${entry.skin}]\n`);
    }
    gi.dprintf("\n[blue]\n");
    for (const entry of skinlistBlue) {
      gi.dprintf(`MODEL: [${entry.model}]  SKIN: [${entry.skin}]\n`);
    }
  }
}

/*
=================
SkinValid (lmctf60/g_skins.c:168)
=================
*/
export function SkinValid(ent: EdictT, input: string | null): boolean {
  if (ent.client === null) return false;
  if (input === null) return false;

  // Parse our input skin and model
  const parsed = parseSkinLine(input);
  if (parsed === null) return false; // Doesn't contain skin and model

  // C: `if (teamnum == CTF_TEAM_RED) teamnum = SKIN_RED; else teamnum =
  // SKIN_BLUE;` -- every non-red team (blue, both observer variants, or
  // any other value) falls into the BLUE list check; preserved exactly.
  const teamnum = ent.client.ctf.teamnum === CTF_TEAM_RED ? SKIN_RED : SKIN_BLUE;

  const list = skinListForColor(teamnum);
  return list.some((entry) => entry.skin === parsed.skin && entry.model === parsed.model);
}

/*
=================
SkinListInUse (lmctf60/g_skins.c:205)
=================
*/
export function SkinListInUse(): boolean {
  return skinlistinuse;
}

/*
=================
SkinRandom (lmctf60/g_skins.c:210)

`rand() % i` -- see file header's FIDELITY RAZOR note; `i` is always the
team's skin count. `i == 0` (an empty list) is division-by-zero UB in the
C source (typically SIGFPE on real hardware); JS has no equivalent crash
for `x % 0`, so this throws instead of silently returning `"undefined/
undefined"`, matching "the original observably dies here" more closely
than any non-crashing return value would.
=================
*/
export function SkinRandom(ent: EdictT): string {
  if (ent.client === null) {
    throw new Error("SkinRandom: ent.client is null (lmctf60/g_skins.c:215 dereferences ent->client unconditionally)");
  }
  const teamnum = ent.client.ctf.teamnum === CTF_TEAM_RED ? SKIN_RED : SKIN_BLUE;
  const list = skinListForColor(teamnum);

  if (list.length === 0) {
    throw new Error("SkinRandom: skin list is empty (lmctf60/g_skins.c:226 `rand() % i` with i==0 is a divide-by-zero crash in the original)");
  }

  const i = Math.floor(Math.random() * list.length);
  const entry = list[i];
  if (entry === undefined) {
    throw new Error("SkinRandom: index out of range (unreachable given the length check above)");
  }
  return `${entry.model}/${entry.skin}`;
}

/*
=================
SkinGetList (lmctf60/g_skins.c:234)

Returns the team's "model/skin" strings as a plain array. The C source's
NULL terminator (`skins[i] = NULL;`) has no explicit equivalent here --
JS array indexing past the end already yields `undefined`, and every call
site in g_menu.ts checks `!skinlist[i]`/`!list[i]`, which `undefined` and
`NULL` both satisfy identically.
=================
*/
export function SkinGetList(ent: EdictT): string[] {
  if (ent.client === null) {
    throw new Error("SkinGetList: ent.client is null (lmctf60/g_skins.c:240 dereferences ent->client unconditionally)");
  }
  const teamnum = ent.client.ctf.teamnum === CTF_TEAM_RED ? SKIN_RED : SKIN_BLUE;
  const list = skinListForColor(teamnum);

  return list.map((entry) => `${entry.model}/${entry.skin}`);
}
