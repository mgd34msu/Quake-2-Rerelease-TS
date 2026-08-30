/*
Unit + integration tests for src/qcommon/loc.ts, ported from q2repro's
src/common/loc.c (GPLv2). Two groups:

1. Tests that need no filesystem at all -- Loc_Localize's "in-place"
   localization type ($-less strings formatted at call time), argument
   substitution/reordering, and the various documented fallback paths.
   These exercise loc.c:204-287 directly.

2. One integration test that writes a fabricated loc-format file into a
   temp baseq2/ tree, points the "basedir" cvar at it, and calls
   FS_InitFilesystem() -- exercising the real wiring (files.ts's
   FS_InitFilesystem -> loc.ts's Loc_Init -> Loc_ReloadFile -> Loc_Parse)
   the same way test/files.test.ts already exercises FS_InitFilesystem
   itself. The loc-file syntax quoted below (`key = "format"`, optional
   `key <platform> = "format"`) is loc.c:329-393 (`Loc_ReloadFile`'s
   COM_ParseToken loop).
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem } from "../src/qcommon/files";
import { Loc_Localize } from "../src/qcommon/loc";

describe("loc.ts -- in-place localization (no file needed)", () => {
  // loc.c:225-234: `Loc_HasArguments(base)` true, base doesn't start with
  // '$' -> parsed and formatted at call time.
  test("in-place localization type: {0} substitution on a raw string", () => {
    expect(Loc_Localize("Score: {0}", true, ["100"], 1)).toBe("Score: 100");
  });

  // loc.c:214-217: allow_in_place=false and base doesn't start with '$' ->
  // returned completely unmodified, no {N} substitution attempted at all.
  test("allow_in_place=false skips in-place substitution entirely", () => {
    expect(Loc_Localize("Score: {0}", false, ["100"], 1)).toBe("Score: {0}");
  });

  // loc.c:235-237: allow_in_place=true, no '$' prefix, and
  // Loc_HasArguments() is false (no bare '{' at all) -> returned unchanged.
  test("allow_in_place=true with no arguments and no $ prefix returns base unchanged", () => {
    expect(Loc_Localize("Just plain text", true, [], 0)).toBe("Just plain text");
  });

  // loc.c:257-262: `!arguments[i]` in the C source tests for a NULL
  // pointer, not an empty string -- `""` is a valid argument and must not
  // trigger the "invalid argument" fallback.
  test("an empty-string argument is valid, not treated as a missing/invalid argument", () => {
    expect(Loc_Localize("Value: [{0}]", true, [""], 1)).toBe("Value: []");
  });

  // loc.c:264-286: prefix, then interleaved substitution/literal-text,
  // driven by loc_arg_t.arg_index -- NOT by the argument's position in the
  // string. "{1}" appears before "{0}" in the format, so this also proves
  // positional reordering (the value used at "{1}" is args[1], even though
  // it renders first).
  test("positional argument reordering: {1} appears before {0} in the format", () => {
    expect(Loc_Localize("{1} then {0}", true, ["first", "second"], 2)).toBe("second then first");
  });

  // loc.c:102-110: no digits after '{' -> sequential allocation
  // (arg_index++ each time), the {} / {} shorthand.
  test("sequential ({} {}) arguments assign 0, 1, 2, ... in encounter order", () => {
    expect(Loc_Localize("A is {} and B is {}", true, ["X", "Y"], 2)).toBe("A is X and B is Y");
  });

  // loc.c:104-107: a sequential "{}" after a positional "{0}" is a parse
  // error ("encountered sequential argument, but has positional args").
  // loc.c:229-232: Loc_Parse failure on an in-place string prints a
  // warning and falls back to returning the original, unsubstituted base.
  test("mixing positional and sequential args is a parse error; falls back to the raw base string", () => {
    expect(Loc_Localize("{0} and {}", true, ["a", "b"], 2)).toBe("{0} and {}");
  });

  // loc.c:249-255: every arg_index must be < num_arguments, checked BEFORE
  // any substitution happens -- one out-of-range reference fails the whole
  // call, not just that one placeholder.
  test("too few arguments supplied falls back to the base string", () => {
    expect(Loc_Localize("{0} and {1}", true, ["only-one"], 1)).toBe("{0} and {1}");
  });

  // loc.c:271-286: each substituted argument is itself run back through
  // Loc_Localize(..., allow_in_place=false, ...) -- so an argument that
  // starts with '$' is itself a table lookup, not inserted literally. Since
  // there is no loc table loaded in this describe block, "$missing" misses
  // and falls back to itself minus the '$' (loc.c:219: `base++` before the
  // NULL-check fallback -- see the dedicated test below for that fallback).
  test("a substituted argument is itself recursively localized (allow_in_place=false)", () => {
    expect(Loc_Localize("Hi, {0}!", true, ["$missing"], 1)).toBe("Hi, missing!");
  });

  // shared/shared.c:804-815 (Q_strlcpy): output_length truncates to
  // output_length - 1 characters.
  test("output_length truncates the result (Q_strlcpy semantics)", () => {
    expect(Loc_Localize("Hello, World!", false, null, 0, 6)).toBe("Hello");
  });
});

describe("loc.ts -- table lookup (no file needed: empty table)", () => {
  // loc.c:214-219 (allow_in_place=false) and loc.c:222-223
  // (allow_in_place=true): both strip the leading '$' into `base` BEFORE
  // calling Loc_Find, and loc.c:240-241 returns that ALREADY-STRIPPED
  // `base` on a miss -- so a miss on "$foo" returns "foo", not "$foo".
  test("a table lookup miss returns the key WITHOUT its leading '$' (allow_in_place=false)", () => {
    expect(Loc_Localize("$nonexistent_key", false, [], 0)).toBe("nonexistent_key");
  });

  test("a table lookup miss returns the key WITHOUT its leading '$' (allow_in_place=true)", () => {
    expect(Loc_Localize("$nonexistent_key", true, [], 0)).toBe("nonexistent_key");
  });
});

describe("loc.ts -- Loc_ReloadFile via FS_InitFilesystem (real wiring)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2loc-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    const locDir = join(baseq2Dir, "localization");
    mkdirSync(locDir, { recursive: true });

    // Format quoted from loc.c:329-393 (Loc_ReloadFile's parse loop):
    // `key = "format"`, optionally `key <platform> = "format"` (parsed to
    // keep the tokenizer's position correct, then discarded -- loc.c:362-364).
    const locFile = [
      `g_greeting = "Hello, {0}!"`,
      `g_two_args = "{1} met {0}"`,
      `g_name = "Bob"`,
      `g_hello = "Hi, {0}!"`,
      `g_bad_mixed = "{0} and {}"`,
      `g_ps_test <ps5> = "should be skipped entirely"`,
      `g_after_ps = "still parses after a platform-spec line"`,
      ``,
    ].join("\n");
    writeFileSync(join(locDir, "loc_english.txt"), locFile);

    // Same fixture idiom as test/files.test.ts: force basedir past
    // CVAR_NOSET, then run the real init path (which now ends in
    // Loc_Init() -> Loc_ReloadFile(), per files.ts's FS_InitFilesystem).
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a $-prefixed lookup hit substitutes the loaded format's argument", () => {
    expect(Loc_Localize("$g_greeting", true, ["World"], 1)).toBe("Hello, World!");
  });

  test("a $-prefixed lookup hit reorders positional arguments ({1} before {0})", () => {
    expect(Loc_Localize("$g_two_args", true, ["World", "Hello"], 2)).toBe("Hello met World");
  });

  test("a $-prefixed lookup miss still falls back to the stripped key", () => {
    expect(Loc_Localize("$totally_unknown_key", true, [], 0)).toBe("totally_unknown_key");
  });

  test("a malformed entry in the file is skipped (not inserted), not fatal to the rest of the file", () => {
    // g_bad_mixed failed Loc_Parse during Loc_ReloadFile (mixed positional/
    // sequential, loc.c:104-107) and was never inserted into the table, so
    // this is an ordinary miss, not a crash.
    expect(Loc_Localize("$g_bad_mixed", true, [], 0)).toBe("g_bad_mixed");
  });

  test("a platform-spec entry (<ps5>) is parsed and discarded, never queryable", () => {
    expect(Loc_Localize("$g_ps_test", true, [], 0)).toBe("g_ps_test");
  });

  test("parsing continues correctly after a skipped platform-spec entry", () => {
    expect(Loc_Localize("$g_after_ps", true, [], 0)).toBe("still parses after a platform-spec line");
  });

  test("a recursively-localized argument resolves through the loaded table", () => {
    // loc.c:271-286: the substituted argument "$g_name" is itself passed
    // back through Loc_Localize(..., allow_in_place=false, ...), which
    // looks it up in the same table.
    expect(Loc_Localize("$g_hello", true, ["$g_name"], 1)).toBe("Hi, Bob!");
  });
});

describe("loc.ts -- graceful degradation with no loc data present", () => {
  // Mirrors this codebase's actual baseq2 data (3.21-era, pre-dates the
  // re-release, ships no localization/ directory at all): Loc_ReloadFile's
  // FS_LoadFile call returns null, loc.c:318-320 returns immediately with
  // no print and an empty table -- every Loc_Localize call still works,
  // every $-lookup just misses and falls back to the base string.
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2loc-empty-"));
    mkdirSync(join(tmpRoot, "baseq2"), { recursive: true });
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("boot with no loc file present does not throw, and lookups degrade to the base string", () => {
    expect(Loc_Localize("$anything", true, [], 0)).toBe("anything");
    expect(Loc_Localize("plain text", true, [], 0)).toBe("plain text");
  });
});
