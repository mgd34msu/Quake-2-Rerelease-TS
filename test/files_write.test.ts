import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_WriteFile, FS_RemoveFile, FS_LoadFile, FS_FreeFile } from "../src/qcommon/files";
import type { Edict, GameImports, GTraceT } from "../src/game/game";
import { GetGameAPI } from "../src/game/g_main";
import { ipFilterList } from "../src/game/g_svcmds";
import { SVCmd_WriteIP_f } from "../src/game/g_svcmds";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function textOf(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

describe("files.ts -- FS_WriteFile / FS_RemoveFile", () => {
  let tmpRoot: string;
  let baseq2Dir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2fsw-"));
    baseq2Dir = join(tmpRoot, "baseq2");

    // point fs_basedir at the temp root, bypassing CVAR_NOSET the way an
    // early "+set basedir ..." command would (see files.test.ts's identical
    // setup for why Cvar_ForceSet, not Cvar_Get, is needed here)
    Cvar_ForceSet("basedir", tmpRoot);

    FS_InitFilesystem();
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("FS_WriteFile creates nested directories and round-trips bytes via FS_LoadFile", () => {
    const written = bytesOf("HELLO-NESTED-WRITE");
    FS_WriteFile(`${baseq2Dir}/deep/nested/dir/newfile.txt`, written);

    const readBack = FS_LoadFile("deep/nested/dir/newfile.txt");
    expect(readBack).not.toBeNull();
    expect(textOf(readBack as Uint8Array)).toBe("HELLO-NESTED-WRITE");
    FS_FreeFile(readBack);
  });

  test("FS_WriteFile accepts a plain string and writes its UTF-8 bytes", () => {
    FS_WriteFile(`${baseq2Dir}/stringwrite.txt`, "plain-string-body\n");

    const readBack = FS_LoadFile("stringwrite.txt");
    expect(readBack).not.toBeNull();
    expect(textOf(readBack as Uint8Array)).toBe("plain-string-body\n");
    FS_FreeFile(readBack);
  });

  test("FS_RemoveFile removes a file written by FS_WriteFile", () => {
    const path = `${baseq2Dir}/removeme.txt`;
    FS_WriteFile(path, bytesOf("TEMPORARY"));
    expect(FS_LoadFile("removeme.txt")).not.toBeNull();

    FS_RemoveFile(path);
    expect(FS_LoadFile("removeme.txt")).toBeNull();
  });

  test("FS_RemoveFile on a nonexistent file does not throw", () => {
    expect(() => FS_RemoveFile(`${baseq2Dir}/never-existed.txt`)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SVCmd_WriteIP_f (g_svcmds.ts): a minimal, self-contained GameImports fake --
// only cprintf/cvar are exercised by SVCmd_WriteIP_f itself, but GetGameAPI
// requires the full interface. Modeled after test/g_svcmds.test.ts's
// makeFakeGameImports, duplicated here per the "tests are self-sufficient"
// rule rather than importing from that file.
// ---------------------------------------------------------------------------

function defaultTrace(): GTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1,
    endpos: vec3(),
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
  };
}

describe("g_svcmds.ts -- SVCmd_WriteIP_f", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2listip-"));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    const fakeImports: GameImports = {
      bprintf() {},
      dprintf() {},
      cprintf() {},
      centerprintf() {},
      sound() {},
      positioned_sound() {},
      configstring() {},
      error(fmt): never {
        throw new Error(`gi.error: ${fmt}`);
      },
      modelindex() {
        return 0;
      },
      soundindex() {
        return 0;
      },
      imageindex() {
        return 0;
      },
      setmodel() {},
      trace() {
        return defaultTrace();
      },
      pointcontents() {
        return 0;
      },
      inPVS() {
        return false;
      },
      inPHS() {
        return false;
      },
      SetAreaPortalState() {},
      AreasConnected() {
        return false;
      },
      linkentity() {},
      unlinkentity() {},
      BoxEdicts() {
        return 0;
      },
      Pmove() {},
      multicast() {},
      unicast() {},
      WriteChar() {},
      WriteByte() {},
      WriteShort() {},
      WriteLong() {},
      WriteFloat() {},
      WriteString() {},
      WritePosition() {},
      WriteDir() {},
      WriteAngle() {},
      cvar(name) {
        if (name === "game") {
          const c = new CvarT();
          c.string = tmpRoot; // stands in for the mod dir the file lands under
          return c;
        }
        return null;
      },
      cvar_set() {
        return null;
      },
      cvar_forceset() {
        return null;
      },
      argc() {
        return 0;
      },
      argv() {
        return "";
      },
      args() {
        return "";
      },
      AddCommandString() {},
      DebugGraph() {},
    };

    GetGameAPI(fakeImports);
    ipFilterList.clear();
  });

  test("writes listip.cfg with a 'set filterban' line and one 'sv addip a.b.c.d' line per filter", () => {
    // fabricated filters: 192.246.40.0 and 10.1.2.3, packed the same way
    // StringToFilter/SVCmd_AddIP_f would
    ipFilterList.filters.push({ mask: 0x00ffffff, compare: 192 | (246 << 8) | (40 << 16) });
    ipFilterList.filters.push({ mask: 0xffffffff, compare: (10 | (1 << 8) | (2 << 16) | (3 << 24)) >>> 0 });

    SVCmd_WriteIP_f();

    const contents = readFileSync(join(tmpRoot, "listip.cfg"), "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);

    expect(lines[0]).toMatch(/^set filterban \d+$/);
    expect(lines[1]).toBe("sv addip 192.246.40.0");
    expect(lines[2]).toBe("sv addip 10.1.2.3");
    expect(lines.length).toBe(3);
  });

  test("writes an empty filter list as just the 'set filterban' line", () => {
    SVCmd_WriteIP_f();

    const contents = readFileSync(join(tmpRoot, "listip.cfg"), "utf8");
    expect(contents).toMatch(/^set filterban \d+\n$/);
  });
});
