/*
FS_LoadShippedFile (src/qcommon/files.ts): the shipped copy of a file is the
first search-path hit with the homedir's loose directories skipped. A pak
entry and a basedir loose file are shipped; a homedir loose file is a drop-in
and never counts, even when it is the only copy.

Own temp basedir + homedir, snapshot/restore of the process-wide search path
per files.test.ts's rule-13 setup.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_Get, Cvar_VariableString } from "../src/qcommon/cvar";
import { CVAR_NOSET } from "../src/shared/q_shared";
import { FS_InitFilesystem, FS_LoadFile, FS_LoadShippedFile, FS_TestSnapshotSearchPaths, FS_TestRestoreSearchPaths, type FsSearchPathSnapshotT } from "../src/qcommon/files";

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textOf(buf: Uint8Array | null): string {
  return buf ? new TextDecoder().decode(buf) : "<null>";
}

// PACK header (id, dirofs, dirlen), file data, then 64-byte directory entries.
function buildPak(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  let dataLen = 0;
  for (const e of entries) dataLen += e.data.length;
  const buf = new Uint8Array(12 + dataLen + entries.length * 64);
  const v = new DataView(buf.buffer);
  buf.set([0x50, 0x41, 0x43, 0x4b]);
  let pos = 12;
  const positions: number[] = [];
  for (const e of entries) {
    positions.push(pos);
    buf.set(e.data, pos);
    pos += e.data.length;
  }
  v.setInt32(4, pos, true);
  v.setInt32(8, entries.length * 64, true);
  entries.forEach((e, i) => {
    const at = pos + i * 64;
    buf.set(bytesOf(e.name), at);
    v.setInt32(at + 56, positions[i], true);
    v.setInt32(at + 60, e.data.length, true);
  });
  return buf;
}

describe("FS_LoadShippedFile", () => {
  let tmpRoot: string;
  let tmpHome: string;
  let snapshot: FsSearchPathSnapshotT;
  let preBasedir = "";
  let preHomedir = "";
  let preGamedir = "";

  beforeAll(() => {
    snapshot = FS_TestSnapshotSearchPaths();
    preBasedir = Cvar_VariableString("basedir");
    preHomedir = Cvar_VariableString("homedir");
    preGamedir = Cvar_VariableString("gamedir");

    tmpRoot = mkdtempSync(join(tmpdir(), "q2ship-"));
    tmpHome = mkdtempSync(join(tmpdir(), "q2shiphome-"));
    mkdirSync(join(tmpRoot, "baseq2", "pics"), { recursive: true });
    mkdirSync(join(tmpHome, "baseq2", "pics"), { recursive: true });

    writeFileSync(join(tmpRoot, "baseq2", "pak0.pak"), buildPak([{ name: "pics/x.png", data: bytesOf("PAK-X-DATA") }]));
    writeFileSync(join(tmpRoot, "baseq2", "pics", "y.png"), bytesOf("BASE-LOOSE-Y"));
    writeFileSync(join(tmpHome, "baseq2", "pics", "x.png"), bytesOf("HOME-X"));
    writeFileSync(join(tmpHome, "baseq2", "pics", "z.png"), bytesOf("HOME-ONLY-Z"));

    Cvar_ForceSet("basedir", tmpRoot);
    // Register "homedir" with its real default ("" on this platform, per
    // Sys_GetDefaultHomedir) BEFORE forcing the temp value, so the cvar's
    // default_string does not leak this suite's temp path into the cvar
    // parity audit that boots the whole engine later in the same process.
    Cvar_Get("homedir", "", CVAR_NOSET);
    Cvar_ForceSet("homedir", tmpHome);
    FS_InitFilesystem();
  });

  afterAll(() => {
    FS_TestRestoreSearchPaths(snapshot);
    Cvar_ForceSet("basedir", preBasedir);
    Cvar_ForceSet("homedir", preHomedir);
    Cvar_ForceSet("gamedir", preGamedir);
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("the homedir drop-in wins the normal walk, the pak copy is the shipped one", () => {
    expect(textOf(FS_LoadFile("pics/x.png"))).toBe("HOME-X");
    expect(textOf(FS_LoadShippedFile("pics/x.png", 3))).toBe("PAK"); // only maxBytes of the head
    expect(textOf(FS_LoadShippedFile("pics/x.png", 1000))).toBe("PAK-X-DATA");
  });

  test("a basedir loose file is shipped content", () => {
    expect(textOf(FS_LoadShippedFile("pics/y.png", 1000))).toBe("BASE-LOOSE-Y");
  });

  test("a homedir-only file has no shipped copy; a missing file has none either", () => {
    expect(textOf(FS_LoadFile("pics/z.png"))).toBe("HOME-ONLY-Z");
    expect(FS_LoadShippedFile("pics/z.png", 1000)).toBeNull();
    expect(FS_LoadShippedFile("pics/nope.png", 1000)).toBeNull();
  });
});
