// q2repro homedir support (src/common/files.c's setup_base_paths/
// setup_game_paths/open_file_write, src/unix/system.c:195-211,
// src/windows/system.c:955) -- see files.ts's FS_InitFilesystem/
// FS_SetGamedir header comments for the exact citations this test exercises.
//
// Three behaviors under test:
// 1. an EMPTY "homedir" cvar (this port's Sys_GetDefaultHomedir() default,
//    platform/sys.ts) is a complete no-op: search paths and the write root
//    (FS_Gamedir()) are exactly what they were before homedir support
//    existed.
// 2. a NON-EMPTY "homedir" makes it the write root (FS_Gamedir()) instead
//    of basedir, both for the plain baseq2 case and for an FS_SetGamedir
//    mod directory.
// 3. a NON-EMPTY "homedir" shadows basedir on read: a file present under
//    both roots resolves to the homedir copy; a file present under only one
//    root still resolves through the other (shadowing isn't exclusion).
//
// Each describe block mounts its own basedir/homedir temp roots via
// Cvar_ForceSet + FS_InitFilesystem and wraps them in
// FS_TestSnapshotSearchPaths/FS_TestRestoreSearchPaths (see files.ts's own
// "TEST SEAM" comment on fs_searchpaths/fs_base_searchpaths -- these are
// process-wide singletons that outlive a single describe block, so an
// unrestored mount from an earlier block in THIS file would otherwise leak
// into later blocks' FS_LoadFile lookups).

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import {
  FS_InitFilesystem,
  FS_LoadFile,
  FS_FreeFile,
  FS_Gamedir,
  FS_SetGamedir,
  FS_WriteFile,
  FS_TestSnapshotSearchPaths,
  FS_TestRestoreSearchPaths,
  type FsSearchPathSnapshotT,
} from "../src/qcommon/files";
import { Sys_GetDefaultHomedir } from "../src/platform/sys";

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textOf(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

// "homedir", "basedir", "game" and "gamedir" are all process-global cvars:
// every describe below force-sets the first two, and the last describe's
// FS_SetGamedir("xatrix") writes the fourth. The per-block afterAll
// teardowns restore fs_searchpaths, but a cvar has no unmount. Without this
// file-level reset the LAST block's temp roots (rmSync'd, dead paths) would
// leak into every later suite in the same bun process and silently redirect
// their FS_SetGamedir write roots (rule 13: this file cleans up everything
// it set).
//
// "game" is force-set to "" on the way IN, not restored on the way out: it
// is a precondition of every FS_Gamedir() assertion below, because
// FS_InitFilesystem re-reads "game" as its last step and calls
// FS_SetGamedir on any non-empty value -- which moves the write root off
// baseq2 onto that mod directory. Any suite that leaves "game" set is
// itself out of rule-13 compliance and is fixed at its own end; this makes
// the precondition explicit rather than assumed.
let preTestHomedir = "";
let preTestBasedir = "";
let preTestGame = "";
let preTestGamedir = "";

beforeAll(() => {
  preTestHomedir = Cvar_VariableString("homedir");
  preTestBasedir = Cvar_VariableString("basedir");
  preTestGame = Cvar_VariableString("game");
  preTestGamedir = Cvar_VariableString("gamedir");
  Cvar_ForceSet("game", "");
});

afterAll(() => {
  Cvar_ForceSet("homedir", preTestHomedir);
  Cvar_ForceSet("basedir", preTestBasedir);
  Cvar_ForceSet("game", preTestGame);
  Cvar_ForceSet("gamedir", preTestGamedir);
});

describe("platform/sys.ts -- Sys_GetDefaultHomedir", () => {
  test("resolves to the empty string (this port's deployment shape has no system-wide/rerelease-auto-detect build variant)", () => {
    // see Sys_GetDefaultHomedir's own header comment for the q2repro
    // meson.build/system.c citations behind this -- an empty default means
    // FS_InitFilesystem's homedir mount is a no-op until something
    // explicitly Cvar_ForceSets "homedir", preserving every existing test's
    // (and today's real boot's) basedir-only behavior exactly.
    expect(Sys_GetDefaultHomedir()).toBe("");
  });
});

describe("files.ts -- homedir unset (empty cvar) is a no-op", () => {
  let tmpRoot: string;
  let baseq2Dir: string;
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fshome-unset-"));
    baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir);
    writeFileSync(join(baseq2Dir, "onlybase.txt"), bytesOf("BASE-ONLY"));

    fsSnapshot = FS_TestSnapshotSearchPaths();

    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("homedir", "");

    FS_InitFilesystem();
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(fsSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("FS_Gamedir() is exactly basedir/baseq2, not any homedir path", () => {
    expect(FS_Gamedir()).toBe(`${tmpRoot}/baseq2`);
  });

  test("reads resolve normally through basedir", () => {
    const buf = FS_LoadFile("onlybase.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("BASE-ONLY");
    FS_FreeFile(buf);
  });

  test("writes through FS_Gamedir() land physically under basedir/baseq2", () => {
    FS_WriteFile(`${FS_Gamedir()}/written.txt`, "WROTE-TO-BASE");
    expect(readFileSync(join(baseq2Dir, "written.txt"), "utf8")).toBe("WROTE-TO-BASE");
  });
});

describe("files.ts -- homedir set: write-path selection (base game, no mod)", () => {
  let tmpRoot: string;
  let baseDir: string;
  let homeDir: string;
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fshome-write-"));
    baseDir = join(tmpRoot, "base");
    homeDir = join(tmpRoot, "home");
    mkdirSync(join(baseDir, "baseq2"), { recursive: true });
    // homeDir itself is deliberately NOT pre-created -- q2repro's
    // setup_base_paths mounts the home path unconditionally (files.c:3709-
    // 3710, skip_if_not_exist=false for the home case), relying on
    // FS_CreatePath to create it lazily on first write. This asserts this
    // port's FS_AddGameDirectory/FS_WriteFile do the same.

    fsSnapshot = FS_TestSnapshotSearchPaths();

    Cvar_ForceSet("basedir", baseDir);
    Cvar_ForceSet("homedir", homeDir);

    FS_InitFilesystem();
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(fsSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("FS_Gamedir() resolves to homedir/baseq2, not basedir/baseq2", () => {
    expect(FS_Gamedir()).toBe(`${homeDir}/baseq2`);
  });

  test("a write through FS_Gamedir() lands under homedir/baseq2, never basedir/baseq2", () => {
    FS_WriteFile(`${FS_Gamedir()}/save.txt`, "SAVED-TO-HOME");

    expect(readFileSync(join(homeDir, "baseq2", "save.txt"), "utf8")).toBe("SAVED-TO-HOME");
    expect(existsSync(join(baseDir, "baseq2", "save.txt"))).toBe(false);
  });
});

describe("files.ts -- homedir set: read shadowing order (homedir wins, non-overlapping files still fall through)", () => {
  let tmpRoot: string;
  let baseDir: string;
  let homeDir: string;
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fshome-read-"));
    baseDir = join(tmpRoot, "base");
    homeDir = join(tmpRoot, "home");
    mkdirSync(join(baseDir, "baseq2"), { recursive: true });
    mkdirSync(join(homeDir, "baseq2"), { recursive: true });

    // present under BOTH roots, different contents -- tests shadowing
    writeFileSync(join(baseDir, "baseq2", "shared.txt"), bytesOf("FROM-BASE"));
    writeFileSync(join(homeDir, "baseq2", "shared.txt"), bytesOf("FROM-HOME"));

    // present under basedir only -- shadowing must not hide this
    writeFileSync(join(baseDir, "baseq2", "baseonly.txt"), bytesOf("BASE-ONLY-FILE"));

    // present under homedir only
    writeFileSync(join(homeDir, "baseq2", "homeonly.txt"), bytesOf("HOME-ONLY-FILE"));

    fsSnapshot = FS_TestSnapshotSearchPaths();

    Cvar_ForceSet("basedir", baseDir);
    Cvar_ForceSet("homedir", homeDir);

    FS_InitFilesystem();
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(fsSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("a name present under both roots resolves to the homedir copy", () => {
    const buf = FS_LoadFile("shared.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("FROM-HOME");
    FS_FreeFile(buf);
  });

  test("a name present only under basedir still resolves (shadowing is priority, not exclusion)", () => {
    const buf = FS_LoadFile("baseonly.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("BASE-ONLY-FILE");
    FS_FreeFile(buf);
  });

  test("a name present only under homedir resolves too", () => {
    const buf = FS_LoadFile("homeonly.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("HOME-ONLY-FILE");
    FS_FreeFile(buf);
  });
});

describe("files.ts -- homedir set: interaction with the \"game\" cvar (FS_SetGamedir mod directories)", () => {
  let tmpRoot: string;
  let baseDir: string;
  let homeDir: string;
  let fsSnapshot: FsSearchPathSnapshotT;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fshome-mod-"));
    baseDir = join(tmpRoot, "base");
    homeDir = join(tmpRoot, "home");
    mkdirSync(join(baseDir, "baseq2"), { recursive: true });
    mkdirSync(join(baseDir, "xatrix"), { recursive: true });
    mkdirSync(join(homeDir, "xatrix"), { recursive: true });

    writeFileSync(join(baseDir, "xatrix", "modfile.txt"), bytesOf("MOD-FROM-BASE"));
    writeFileSync(join(homeDir, "xatrix", "modfile.txt"), bytesOf("MOD-FROM-HOME"));

    fsSnapshot = FS_TestSnapshotSearchPaths();

    Cvar_ForceSet("basedir", baseDir);
    Cvar_ForceSet("homedir", homeDir);

    FS_InitFilesystem();
    FS_SetGamedir("xatrix");
  });

  afterAll(() => {
    // q2repro's own "game"/gamedir cvars aren't reset here -- FS_SetGamedir
    // itself only ever prepends search-path entries (freed back to
    // fs_base_searchpaths by the NEXT FS_SetGamedir call, same as the real
    // engine), so restoring the snapshot below is what actually unmounts
    // xatrix for later test files in the same process.
    FS_TestRestoreSearchPaths(fsSnapshot);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("FS_Gamedir() resolves to homedir/xatrix after FS_SetGamedir, not basedir/xatrix", () => {
    expect(FS_Gamedir()).toBe(`${homeDir}/xatrix`);
  });

  test("a write through FS_Gamedir() lands under homedir/xatrix", () => {
    FS_WriteFile(`${FS_Gamedir()}/modsave.txt`, "MOD-SAVED-TO-HOME");

    expect(readFileSync(join(homeDir, "xatrix", "modsave.txt"), "utf8")).toBe("MOD-SAVED-TO-HOME");
    expect(existsSync(join(baseDir, "xatrix", "modsave.txt"))).toBe(false);
  });

  test("reads for the mod directory shadow homedir over basedir too", () => {
    const buf = FS_LoadFile("modfile.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("MOD-FROM-HOME");
    FS_FreeFile(buf);
  });
});
