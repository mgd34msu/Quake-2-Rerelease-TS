// loc.c/loc.h -- localization, ported from the 2023 re-release engine
// (GPLv2, ~/Projects/qsrc/q2repro/src/common/loc.c [409 lines] +
// ~/Projects/qsrc/q2repro/inc/common/loc.h [23 lines]). Vanilla Quake II
// (the engine this repo otherwise ports) has no localization subsystem at
// all -- this is a re-release-only addition being backported ahead of the
// rest of the kex engine layer, per ARCHITECTURE.md phase 7.
//
// Wiring (mirrors q2repro's own call sites, not invented here):
// - `Loc_Init()` is called at the very end of q2repro's `FS_Init()`
//   (files.c:4046, right after the "-----------------------" banner print),
//   NOT from `Qcommon_Init`'s subsystem block -- q2repro's `Qcommon_Init`
//   itself never mentions Loc_Init. This port matches that exact placement:
//   the call is the last statement of `FS_InitFilesystem()`
//   (src/qcommon/files.ts), reached via a lazy `require("./loc")` for the
//   same reason files.ts already lazy-requires cvar.ts/cmd.ts (see that
//   file's `cvarMod`/`cmdMod` comment) -- a static `files.ts -> loc.ts`
//   edge would recreate the exact cycle those lazy requires were added to
//   break, since loc.ts itself statically imports cvar.ts.
// - `gi.Loc_Print` (src/server/bindings/kex.ts) and cgame's `Localize`
//   (src/client/cgame/host.ts) both call `Loc_Localize(base, true, args,
//   num_args, ...)` -- `allow_in_place = true` in both cases, matching
//   q2repro's own `PF_Loc_Print` (server/game.c:808) and `CG_Localize`
//   (client/cgame.c:329).
//
// Deliberate deviations from the C source (documented individually below
// at point of use, summarized here):
// - No hash table: `loc_hash[256]` + `hash_next` chaining collapses to a
//   plain `Map<string, LocString>`, insertion order preserved. Same
//   precedent as cvar.ts's `cvar_vars` Map (see that file's header
//   comment): a duplicate key's *last* insertion wins in both the C hash
//   chain (newest-first, `Loc_Find` returns the first match) and a JS
//   `Map.set` (overwrites), so this is not an observable behavior change.
//   `Com_HashString`/`LOC_HASH_SIZE` are therefore not ported at all.
// - `Com_SetLastError`/`Com_GetLastError` (a global last-error string) do
//   not exist in this codebase. `Loc_Parse` returns a discriminated
//   `{ ok: true; arguments } | { ok: false; error }` instead of a `bool`
//   plus an out-of-band error string -- same information, explicit return
//   value instead of a side channel.
// - `Com_WPrintf` (a warning-colored printf) does not exist in this
//   codebase (grepped: only `Com_Printf`/`Com_DPrintf`/`Com_Error` are
//   exported from qcommon/common.ts). Every `Com_WPrintf` call in the
//   source is ported as `Com_Printf` -- same message text, no color
//   channel to preserve.
// - `Q_strlcpy`/`Q_strnlcpy`/`Q_strlcat`/`Q_strnlcat` (shared/shared.c) are
//   NOT re-exported from q_shared.ts under those names (nothing there
//   ports them yet, and src/kexgame/q_std.ts's own copies are a *different*
//   module's re-implementation with a `{result, srcLength}` return shape
//   for a different call-site style). This file has its own small private
//   equivalents (`strlcpy`/`strnlcpy`/`strlcat`/`strnlcat` below) that
//   return the plain truncated string -- `Loc_Localize`'s C return value
//   (the source's `size_t` truncation-detection length) is never consumed
//   by any real call site in loc.c itself, so nothing is lost by dropping
//   it here too.
// - Fixed C buffers (`char format[MAX_LOC_FORMAT]`, output buffers sized
//   by the caller) become plain JS strings with truncation applied only at
//   the same points the C code explicitly truncates (`Q_strlcpy` calls),
//   via the private helpers above.
// - `Loc_ReloadFile`'s `FS_LoadFile` buffer is decoded as Latin-1 (one byte
//   -> one UTF-16 code unit), not UTF-8: the C parser is a byte-indexed
//   scanner where every parsing decision (`{`, `}`, `"`, `\`, `//`, `/*`,
//   whitespace, digits) lives in the 0-127 ASCII range. Decoding as UTF-8
//   could merge multibyte sequences into single JS characters and shift
//   every subsequent byte offset; Latin-1 preserves an exact 1:1
//   byte<->code-unit mapping (and round-trips losslessly back out).

import { MAX_STRING_CHARS, type CvarT } from "../shared/q_shared";
import { Cvar_Get } from "./cvar";
import { FS_LoadFile, FS_FreeFile } from "./files";
import { Com_Printf } from "./common";

// loc.c:27-29
const MAX_LOC_KEY = 64;
const MAX_LOC_FORMAT = 1024;
const MAX_LOC_ARGS = 8;

// loc.c:34-37 (loc_arg_t). `argIndex` is kept in 0-255 (uint8_t in the C
// struct) via `& 0xff` truncation where it's assigned, below.
interface LocArg {
  argIndex: number;
  start: number;
  end: number;
}

// loc.c:39-47 (loc_string_t), minus `key`/`next`/`hash_next` (the Map is
// keyed by `key` directly; there is no linked-list traversal left to do).
interface LocString {
  format: string;
  arguments: LocArg[];
}

// loc.c:49-50 (`loc_head`/`loc_hash`) -- see header comment: a Map replaces
// both the insertion-order list and the hash table.
const locTable = new Map<string, LocString>();

let loc_file: CvarT | null = null;

// ---------------------------------------------------------------------------
// Private BSD-string-style helpers (shared/shared.c:804-867) -- see header
// comment for why these live here instead of being exported from q_shared.ts.
// ---------------------------------------------------------------------------

function strlcpy(src: string, size: number): string {
  if (size <= 0) return "";
  return src.length <= size - 1 ? src : src.slice(0, size - 1);
}

function strnlcpy(src: string, count: number, size: number): string {
  if (size <= 0) return "";
  const ret = Math.min(count, src.length);
  return src.slice(0, Math.min(ret, size - 1));
}

function strlcat(dst: string, src: string, size: number): string {
  return dst + strlcpy(src, size - dst.length);
}

function strnlcat(dst: string, src: string, count: number, size: number): string {
  return dst + strnlcpy(src, count, size - dst.length);
}

// ---------------------------------------------------------------------------
// Loc_Parse -- loc.c:52-161. Transliterated index-by-index (rather than
// re-derived from scratch) because the "{{"/"}}" escape handling has a real
// quirk (documented inline below) that only a literal port reproduces.
// ---------------------------------------------------------------------------

type LocParseResult = { ok: true; arguments: LocArg[] } | { ok: false; error: string };

function Loc_Parse(format: string): LocParseResult {
  // loc.c:67: "if -1, a positional argument was encountered"
  let argIndexState = 0;
  let argRover = 0;
  const formatLen = format.length;
  const args: LocArg[] = [];

  // format[i] past the end reads as the C null terminator (falsy) --
  // mirrors src/shared/math.ts's COM_Parse `charAt` helper.
  const at = (i: number): string => (i < formatLen ? format[i]! : "");

  while (true) {
    if (argRover >= formatLen || !at(argRover)) {
      break;
    }

    if (at(argRover) === "{") {
      const argStart = argRover;
      argRover++;

      if (at(argRover) && at(argRover) === "{") {
        // loc.c:84-86: escape sequence. NOTE (bug-for-bug, not fixed here):
        // `arg_rover` is left pointing AT the second '{' of the pair, and
        // the outer `while(true)`'s next iteration re-examines that same
        // position as a fresh potential argument start -- so "{{" does not
        // universally suppress argument parsing starting from its second
        // brace (e.g. "a{{0}b" parses an argument spanning the *second*
        // brace through the next "}", not a literal "{{" followed by plain
        // text). This is exactly what the C source does; see loc.c:79-86.
        continue;
      }

      if (args.length === MAX_LOC_ARGS) {
        return { ok: false, error: "too many arguments" };
      }

      const arg: LocArg = { argIndex: 0, start: argStart, end: 0 };
      args.push(arg);

      // strtol(&format[arg_rover], &end_ptr, 10) -- decimal digits only;
      // no sign/leading-whitespace support (loc files never need it; every
      // real `{N}` is a bare unsigned index immediately after '{').
      const rest = format.slice(argRover);
      const digits = /^[0-9]+/.exec(rest);
      const endPtrOffset = digits ? argRover + digits[0].length : argRover;

      if (endPtrOffset === argRover) {
        // loc.c:102-110: no digits consumed -> sequential argument.
        if (argIndexState === -1) {
          return { ok: false, error: "encountered sequential argument, but has positional args" };
        }
        arg.argIndex = argIndexState & 0xff;
        argIndexState++;
      } else {
        // loc.c:111-121: digits consumed -> positional argument.
        if (argIndexState > 0) {
          return { ok: false, error: "encountered positional argument, but has sequential args" };
        }
        arg.argIndex = Number.parseInt(digits![0], 10) & 0xff;
        argIndexState = -1;
      }

      argRover = endPtrOffset - 1;

      while (true) {
        if (argRover >= formatLen || !at(argRover)) {
          return { ok: false, error: "EOF before end of argument found" };
        }

        argRover++;

        if (at(argRover) !== "}") {
          continue;
        }

        const argEnd = argRover;
        argRover++;

        if (at(argRover) && at(argRover) === "}") {
          continue; // loc.c:143-145: "}}" escape, same quirk as "{{" above
        }

        arg.end = argEnd + 1;
        break;
      }
    } else {
      argRover++;
    }
  }

  if (args.length) {
    // loc.c:155-158: qsort by start position.
    args.sort((a, b) => a.start - b.start);
  }

  return { ok: true, arguments: args };
}

// loc.c:163-182
function Loc_HasArguments(base: string): boolean {
  const len = base.length;
  for (let i = 0; i < len; i++) {
    if (base[i] === "{") {
      i++;
      if (i >= len) return false;
      if (base[i] !== "{") return true;
      // else: "{{" -- the enclosing for-loop's own `i++` advances past the
      // second brace too, exactly like the C `for(;*rover;rover++)`.
    }
  }
  return false;
}

// loc.c:184-202 -- see header comment: exact-key Map lookup replaces the
// hash bucket + strcmp chain walk (same result set).
function Loc_Find(base: string): LocString | undefined {
  return locTable.get(base);
}

// ---------------------------------------------------------------------------
// Loc_Localize -- loc.c:204-287
// ---------------------------------------------------------------------------

/**
 * loc.c:204: `size_t Loc_Localize(const char *base, bool allow_in_place,
 * const char **arguments, size_t num_arguments, char *output, size_t
 * output_length)`. `output`/`output_length` collapse to a return value plus
 * an optional truncation-buffer-size parameter (every real call site passes
 * `output_length == MAX_STRING_CHARS`, so it defaults to that).
 */
export function Loc_Localize(
  base: string,
  allow_in_place: boolean,
  args: readonly string[] | null,
  num_args: number,
  output_length: number = MAX_STRING_CHARS,
): string {
  let workingBase = base;
  let str: LocString | undefined;

  // loc.c:211-213: re-release supports two types of localizations -- ones
  // in the loc file (prefixed with $) and in-place localizations that are
  // formatted at runtime.
  if (!allow_in_place) {
    if (workingBase.charAt(0) !== "$") {
      return strlcpy(workingBase, output_length);
    }

    // loc.c:219: `base++` -- NOTE this is the string used by every fallback
    // below, i.e. a lookup MISS returns the key WITHOUT its leading '$'.
    workingBase = workingBase.slice(1);
    str = Loc_Find(workingBase);
  } else {
    if (workingBase.charAt(0) === "$") {
      workingBase = workingBase.slice(1); // loc.c:223, same note as above
      str = Loc_Find(workingBase);
    } else if (Loc_HasArguments(workingBase)) {
      const inPlaceFormat = strlcpy(workingBase, MAX_LOC_FORMAT);
      const parsed = Loc_Parse(inPlaceFormat);

      if (!parsed.ok) {
        Com_Printf(`in-place localization of "%s" failed: %s\n`, workingBase, parsed.error);
        return strlcpy(workingBase, output_length);
      }

      str = { format: inPlaceFormat, arguments: parsed.arguments };
    } else {
      return strlcpy(workingBase, output_length);
    }
  }

  if (!str) {
    return strlcpy(workingBase, output_length);
  }

  // loc.c:244-247: easy case, no arguments to substitute.
  if (str.arguments.length === 0) {
    return strlcpy(str.format, output_length);
  }

  // loc.c:249-262: validate before touching output.
  for (const arg of str.arguments) {
    if (arg.argIndex >= num_args) {
      Com_Printf(`Loc_Localize: base "%s" localized with too few arguments\n`, workingBase);
      return strlcpy(workingBase, output_length);
    }
  }

  // loc.c:257-262: `!arguments[i]` in C means a NULL pointer, not an empty
  // string -- `""` is a perfectly valid argument. Checked against
  // null/undefined here rather than JS truthiness for that reason.
  for (let i = 0; i < num_args; i++) {
    if (!args || args[i] == null) {
      Com_Printf(`Loc_Localize: invalid argument at position %d\n`, i);
      return strlcpy(workingBase, output_length);
    }
  }

  const argList: readonly string[] = args ?? [];

  // loc.c:264-286: fill prefix, then interleave each localized argument
  // with the literal text that follows it up to the next argument.
  let arg = str.arguments[0]!;
  let output = strnlcpy(str.format, arg.start, output_length);

  for (let i = 0; i < str.arguments.length - 1; i++) {
    const localizedArg = Loc_Localize(argList[arg.argIndex]!, false, null, 0, MAX_STRING_CHARS);
    output = strlcat(output, localizedArg, output_length);

    const nextArg = str.arguments[i + 1]!;
    output = strnlcat(output, str.format.slice(arg.end), nextArg.start - arg.end, output_length);

    arg = nextArg;
  }

  const lastLocalizedArg = Loc_Localize(argList[arg.argIndex]!, false, null, 0, MAX_STRING_CHARS);
  output = strlcat(output, lastLocalizedArg, output_length);

  return strlcat(output, str.format.slice(arg.end), output_length);
}

// ---------------------------------------------------------------------------
// File-format tokenizer -- shared/shared.c:510-609 (`COM_ParseToken`), the
// re-release's version with a `flags` parameter (`PARSE_FLAG_ESCAPE`) that
// this codebase's own src/shared/math.ts `COM_Parse` does not have (it's a
// port of the *original* engine's simpler tokenizer, predating the
// re-release). loc.c is the only current caller of this richer form, so it
// lives here privately rather than being grafted onto math.ts's copy.
// ---------------------------------------------------------------------------

const PARSE_FLAG_NONE = 0;
const PARSE_FLAG_ESCAPE = 1; // BIT(0)

interface TokenState {
  data: string;
  index: number;
}

function cc(s: string, i: number): number {
  return i < s.length ? s.charCodeAt(i) : 0;
}

// shared/shared.c:485-500
function parseEscapeSequence(state: TokenState): number | null {
  const code = cc(state.data, state.index);
  state.index++;
  if (code === 0) return null;
  if (code === 0x6e) return 0x0a; // 'n' -> \n
  if (code === 0x74) return 0x09; // 't' -> \t
  if (code === 0x72) return 0x0d; // 'r' -> \r
  return code;
}

// shared/shared.c:510-609
function comParseToken(state: TokenState, size: number, flags: number): string {
  let result = "";
  let len = 0;

  for (;;) {
    let c = cc(state.data, state.index);
    while (c <= 32) {
      if (c === 0) return "";
      state.index++;
      c = cc(state.data, state.index);
    }

    if (c === 0x2f && cc(state.data, state.index + 1) === 0x2f) {
      // "//" line comment
      state.index += 2;
      while (cc(state.data, state.index) !== 0 && cc(state.data, state.index) !== 0x0a) state.index++;
      continue;
    }

    if (c === 0x2f && cc(state.data, state.index + 1) === 0x2a) {
      // "/* */" block comment
      state.index += 2;
      while (cc(state.data, state.index) !== 0) {
        if (cc(state.data, state.index) === 0x2a && cc(state.data, state.index + 1) === 0x2f) {
          state.index += 2;
          break;
        }
        state.index++;
      }
      continue;
    }

    break;
  }

  let c = cc(state.data, state.index);

  if (c === 0x22 /* '"' */) {
    state.index++;
    for (;;) {
      c = cc(state.data, state.index);
      state.index++;
      if (c === 0x22 || c === 0) {
        return result;
      }
      if (c === 0x5c /* '\' */ && (flags & PARSE_FLAG_ESCAPE) !== 0) {
        const esc = parseEscapeSequence(state);
        if (esc === null) return result;
        c = esc;
      }
      if (len + 1 < size) {
        result += String.fromCharCode(c);
      }
      len++;
    }
  }

  do {
    if (c === 0x5c && (flags & PARSE_FLAG_ESCAPE) !== 0) {
      const esc = parseEscapeSequence(state);
      if (esc === null) break;
      c = esc;
    }
    if (len + 1 < size) {
      result += String.fromCharCode(c);
    }
    len++;
    state.index++;
    c = cc(state.data, state.index);
  } while (c > 32);

  return result;
}

// ---------------------------------------------------------------------------
// Loc_ReloadFile / Loc_Init -- loc.c:289-409
// ---------------------------------------------------------------------------

function Loc_Unload(): void {
  locTable.clear();
}

/*
================
Loc_ReloadFile
================
*/
export function Loc_ReloadFile(): void {
  Loc_Unload();

  const path = loc_file ? loc_file.string : "localization/loc_english.txt";
  const buffer = FS_LoadFile(path);

  if (!buffer) {
    // loc.c:318-320: no print here -- matches the re-release engine
    // degrading silently to "no localization data" when the loc file is
    // absent (true for this codebase's 3.21-era baseq2, which predates the
    // re-release and ships no localization/ directory at all -- see the
    // engineering report for what was actually found on disk). Every
    // Loc_Localize call still works: table lookups just always miss and
    // fall back to the base string.
    return;
  }

  const text = Buffer.from(buffer).toString("latin1");
  const state: TokenState = { data: text, index: 0 };
  let numLocs = 0;

  while (true) {
    const key = comParseToken(state, MAX_LOC_KEY, PARSE_FLAG_NONE);
    if (!key) break;

    // COM_Parse(p) == COM_ParseEx(p, PARSE_FLAG_NONE), buffer size
    // MAX_TOKEN_CHARS == MAX_STRING_CHARS (1024) in q2repro.
    let equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
    let hasPlatformSpec = false;

    if (!equals) {
      break;
    } else if (equals.charAt(0) === "<") {
      hasPlatformSpec = true;

      // loc.c:346-349: skip tokens until one ends with '>'.
      while (equals && equals.charAt(equals.length - 1) !== ">") {
        equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
      }

      equals = comParseToken(state, MAX_STRING_CHARS, PARSE_FLAG_NONE);
    }

    // loc.c:355-357: syntax error stops the whole file, not just this line.
    if (equals !== "=") break;

    const format = comParseToken(state, MAX_LOC_FORMAT, PARSE_FLAG_ESCAPE);

    // loc.c:362-364: platform-specific overrides (`key <ps5> = "..."`) are
    // parsed (to keep the tokenizer's position correct) and then discarded.
    if (hasPlatformSpec) continue;

    const parsed = Loc_Parse(format);
    if (!parsed.ok) {
      Com_Printf(`%s (%s): %s\n`, path, key, parsed.error);
      continue;
    }

    locTable.set(key, { format, arguments: parsed.arguments });
    numLocs++;
  }

  FS_FreeFile(buffer);

  Com_Printf(`Loaded %d localization strings\n`, numLocs);
}

/*
================
Loc_Init
================
*/
export function Loc_Init(): void {
  loc_file = Cvar_Get("loc_file", "localization/loc_english.txt", 0);
  Loc_ReloadFile();
}
