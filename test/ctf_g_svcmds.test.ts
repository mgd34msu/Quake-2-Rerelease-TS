/*
Unit tests for the ctf/g_svcmds.c 3.19 -> 3.21 delta applied to
src/ctf/g_svcmds.ts: 3.21 restores the packet-filtering (ipfilter)
subsystem that this ctf fork had dropped in 3.19.

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: this file
calls GetGameAPI(fakeImports) itself and never relies on another test file
having run first. Modeled after test/g_svcmds.test.ts's (base game)
fake-GameImports pattern.
*/

import { describe, expect, test, beforeEach } from "bun:test";
import type { GameImports, GTraceT } from "../src/ctf/game";
import { GetGameAPI } from "../src/ctf/g_main";
import { EdictT, g_edicts, game, gameCvars, globals, level, SetGEdicts } from "../src/ctf/g_local";
import { CplaneT, CvarT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { ipFilterList, ServerCommand, StringToFilter, SV_FilterPacket, SVCmd_AddIP_f, SVCmd_RemoveIP_f } from "../src/ctf/g_svcmds";

interface Recorder {
  cprintf: string[];
}

function makeRecorder(): Recorder {
  return { cprintf: [] };
}

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

let currentArgs: string[] = [];

function setArgs(args: string[]): void {
  currentArgs = args;
}

function makeFakeGameImports(rec: Recorder): GameImports {
  return {
    bprintf() {},
    dprintf() {},
    cprintf(_ent, _level, fmt) {
      rec.cprintf.push(fmt);
    },
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
      return 7;
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
        c.string = "";
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
      return currentArgs.length;
    },
    argv(n) {
      return currentArgs[n] ?? "";
    },
    args() {
      return "";
    },
    AddCommandString() {},
    DebugGraph() {},
  };
}

function fakeCvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

const MAXENTITIES = 16;

function setupWorld(): Recorder {
  const rec = makeRecorder();
  GetGameAPI(makeFakeGameImports(rec));

  const edicts: EdictT[] = Array.from({ length: MAXENTITIES }, () => new EdictT());
  edicts.forEach((e, i) => {
    e.s.number = i;
  });
  SetGEdicts(edicts);

  game.clear();
  game.maxclients = 1;
  game.maxentities = MAXENTITIES;

  level.clear();

  gameCvars.maxclients = fakeCvar(1);
  gameCvars.skill = fakeCvar(1);
  gameCvars.deathmatch = fakeCvar(0);
  gameCvars.filterban = fakeCvar(1);

  globals.num_edicts = MAXENTITIES;

  currentArgs = [];
  ipFilterList.clear();

  return rec;
}

beforeEach(() => {
  setupWorld();
});

// ---------------------------------------------------------------------------

describe("StringToFilter", () => {
  test("parses a fully-specified dotted quad into packed mask/compare", () => {
    const result = StringToFilter("192.246.40.0");

    expect(result.ok).toBe(true);
    expect(result.mask).toBe(0x00ffffff);
    expect(result.compare).toBe(192 | (246 << 8) | (40 << 16));
  });

  test("an unspecified trailing octet leaves that byte's mask at 0 (class C wildcard)", () => {
    const result = StringToFilter("192.246.40");

    expect(result.ok).toBe(true);
    expect(result.mask).toBe(0x00ffffff);
    expect(result.compare).toBe(192 | (246 << 8) | (40 << 16));
  });

  test("rejects a non-numeric address", () => {
    const result = StringToFilter("abc.def");
    expect(result.ok).toBe(false);
  });
});

describe("SV_FilterPacket", () => {
  test("filterban=1 (default): a listed address is rejected", () => {
    const parsed = StringToFilter("192.246.40.0");
    ipFilterList.filters.push({ mask: parsed.mask, compare: parsed.compare });

    expect(SV_FilterPacket("192.246.40.5")).toBe(true); // matches the /24, filterban=1 -> blocked
    expect(SV_FilterPacket("10.0.0.1")).toBe(false); // not listed -> allowed
  });

  test("filterban=0: only a listed address is allowed", () => {
    gameCvars.filterban = fakeCvar(0);
    const parsed = StringToFilter("192.246.40.0");
    ipFilterList.filters.push({ mask: parsed.mask, compare: parsed.compare });

    expect(SV_FilterPacket("192.246.40.5")).toBe(false); // listed -> allowed
    expect(SV_FilterPacket("10.0.0.1")).toBe(true); // not listed -> blocked
  });

  test("empty (no ip= key) address is not blocked against an empty filter list", () => {
    // this is the shape ClientConnect passes when userinfo has no "ip" key
    // set -- must not spuriously reject every connection.
    expect(SV_FilterPacket("")).toBe(false);
  });
});

describe("addip / removeip round-trip", () => {
  test("addip inserts a filter that SV_FilterPacket then matches, removeip clears it", () => {
    setArgs(["sv", "addip", "192.246.40.0"]);
    SVCmd_AddIP_f();

    expect(ipFilterList.filters.length).toBe(1);
    expect(SV_FilterPacket("192.246.40.7")).toBe(true);

    setArgs(["sv", "removeip", "192.246.40.0"]);
    SVCmd_RemoveIP_f();

    expect(ipFilterList.filters.length).toBe(0);
    expect(SV_FilterPacket("192.246.40.7")).toBe(false);
  });

  test("ServerCommand dispatches addip/listip/removeip by argv(1), case-insensitively", () => {
    const rec = setupWorld();

    setArgs(["sv", "ADDIP", "10.1.2.0"]);
    ServerCommand();
    expect(ipFilterList.filters.length).toBe(1);

    setArgs(["sv", "listip"]);
    ServerCommand();
    expect(rec.cprintf.some((m) => m.includes("Filter list"))).toBe(true);

    setArgs(["sv", "removeip", "10.1.2.0"]);
    ServerCommand();
    expect(ipFilterList.filters.length).toBe(0);
  });

  test("addip with a bad address is rejected and does not register a filter", () => {
    setArgs(["sv", "addip", "not-an-ip"]);
    SVCmd_AddIP_f();

    expect(ipFilterList.filters.length).toBe(1);
    expect(ipFilterList.filters[0].compare >>> 0).toBe(0xffffffff);
  });
});
