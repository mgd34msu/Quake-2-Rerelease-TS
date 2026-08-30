import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_LoadFile, FS_FreeFile, FS_ListFiles, FS_Gamedir, FS_SetGamedir } from "../src/qcommon/files";

const HEADER_SIZE = 12;
const ENTRY_SIZE = 64; // 56-char name + filepos (int32) + filelen (int32)

// Builds a byte-exact IDPAK ('PACK') archive: header (ident/dirofs/dirlen),
// then each file's raw bytes back-to-back, then the directory table at
// dirofs -- matching qfiles.h's dpackheader_t/dpackfile_t layout that
// files.ts's FS_LoadPackFile parses.
function buildPak(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  let dataLen = 0;
  for (const e of entries) dataLen += e.data.length;

  const dirofs = HEADER_SIZE + dataLen;
  const dirlen = entries.length * ENTRY_SIZE;
  const buf = new Uint8Array(dirofs + dirlen);
  const view = new DataView(buf.buffer);

  // ident: on-disk bytes 'P','A','C','K' read back as a little-endian int32
  buf[0] = 0x50;
  buf[1] = 0x41;
  buf[2] = 0x43;
  buf[3] = 0x4b;
  view.setInt32(4, dirofs, true);
  view.setInt32(8, dirlen, true);

  let dataOffset = HEADER_SIZE;
  let dirEntryOffset = dirofs;
  for (const e of entries) {
    buf.set(e.data, dataOffset);

    for (let i = 0; i < e.name.length && i < 56; i++) {
      buf[dirEntryOffset + i] = e.name.charCodeAt(i);
    }
    // remaining name bytes are left 0 (null-padded), matching strcpy into a
    // zeroed dpackfile_t.name buffer
    view.setInt32(dirEntryOffset + 56, dataOffset, true);
    view.setInt32(dirEntryOffset + 60, e.data.length, true);

    dataOffset += e.data.length;
    dirEntryOffset += ENTRY_SIZE;
  }

  return buf;
}

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textOf(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

describe("files.ts -- FS_* virtual filesystem", () => {
  let tmpRoot: string;
  let baseq2Dir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fs-"));
    baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir);

    // two pak entries: "onlypak.txt" has no loose counterpart, "shadow.txt"
    // is also written as a loose file below with *different* content, to
    // test search-path precedence between the two sources.
    const pak = buildPak([
      { name: "onlypak.txt", data: bytesOf("PAK-ONLY-DATA") },
      { name: "shadow.txt", data: bytesOf("PAK-SHADOW-DATA") },
    ]);
    writeFileSync(join(baseq2Dir, "pak0.pak"), pak);

    // loose file shadowing a pak entry of the same name
    writeFileSync(join(baseq2Dir, "shadow.txt"), bytesOf("LOOSE-SHADOW-DATA"));

    // point fs_basedir at the temp root, bypassing CVAR_NOSET the way an
    // early "+set basedir ..." command would (see files.ts's FS_InitFilesystem:
    // Cvar_Get("basedir", ".", CVAR_NOSET) only ORs the NOSET flag into an
    // already-existing cvar, it never overwrites an existing value)
    Cvar_ForceSet("basedir", tmpRoot);

    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("FS_LoadFile returns exact bytes for a pak-only entry", () => {
    const buf = FS_LoadFile("onlypak.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("PAK-ONLY-DATA");
    FS_FreeFile(buf);
  });

  // Search-path ordering, per files.c's FS_AddGameDirectory: within a single
  // FS_AddGameDirectory call, the loose directory entry is pushed onto
  // fs_searchpaths *before* the loop that pushes pak0..pak9 on top of it, so
  // paks end up searched *ahead of* the loose directory tree in the same
  // gamedir. A loose file therefore does NOT shadow a same-named pak entry
  // from the same game directory -- the pak wins. (A loose file only wins if
  // it lives in a *later*-added game directory, e.g. a mod dir added after
  // baseq2.)
  test("a same-directory pak entry wins over a same-named loose file", () => {
    const buf = FS_LoadFile("shadow.txt");
    expect(buf).not.toBeNull();
    expect(textOf(buf as Uint8Array)).toBe("PAK-SHADOW-DATA");
    FS_FreeFile(buf);
  });

  test("FS_LoadFile returns null for a file that exists nowhere on the search path", () => {
    expect(FS_LoadFile("does-not-exist.txt")).toBeNull();
  });

  test("FS_ListFiles matches a glob pattern against real directory entries", () => {
    const paks = FS_ListFiles(`${baseq2Dir}/*.pak`);
    expect(paks).not.toBeNull();
    expect(paks).toEqual([`${baseq2Dir}/pak0.pak`]);

    // FS_ListFiles is a plain directory listing (Sys_FindFirst/Next in the
    // original), not pak-aware -- only the loose shadow.txt is a real
    // directory entry, "onlypak.txt" only exists inside the pak and will not
    // be found this way.
    const txts = FS_ListFiles(`${baseq2Dir}/*.txt`);
    expect(txts).not.toBeNull();
    expect(txts).toEqual([`${baseq2Dir}/shadow.txt`]);
  });

  test("FS_ListFiles returns null when nothing matches", () => {
    expect(FS_ListFiles(`${baseq2Dir}/*.nomatch`)).toBeNull();
  });

  test("FS_Gamedir reflects FS_SetGamedir", () => {
    FS_SetGamedir("mymod");
    expect(FS_Gamedir()).toBe(`${tmpRoot}/mymod`);
  });
});
