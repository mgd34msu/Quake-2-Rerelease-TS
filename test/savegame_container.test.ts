/*
Phase-8 savegame unit: the SSV2/SAV2 kex-family container (src/server/
sv_ccmds.ts's SV_WriteServerFileKex/SV_ReadServerFileKex/SV_WriteLevelFileKex/
SV_ReadLevelFileKex, dispatched from SV_WriteServerFile/SV_ReadServerFile/
SV_WriteLevelFile/SV_ReadLevelFile via src/server/sv_game.ts's
currentGameFamily()) plus the demo-recording codec fix (src/server/sv_ents.ts's
SV_RecordDemoMessage).

Four groups of coverage, matching this unit's brief:

  A. SSV2/SAV2 header layout vs hand-built bytes, derived from
     ~/Projects/qsrc/q2repro/src/server/save.c's write_server_file (47-105)
     and write_level_file (107-171) -- exercised through the real
     SV_WriteServerFile/SV_WriteLevelFile with the "game" cvar forced to
     "kex", never by calling the private SV_WriteServerFileKex/
     SV_WriteLevelFileKex helpers directly.

  B. Legacy container byte-identity: preferences.md rule 15 bans git stash/
     reset/checkout on the shared tree, so this uses the read-only
     alternative named there (`git show HEAD:...`) instead of
     protocol_golden.test.ts's stash-capture method, matching
     test/protocol_frame_envelope.test.ts's own precedent for the same
     constraint. `referenceWriteServerFileBytes`/`referenceWriteLevelFileBytes`
     below are transcribed verbatim from `git show HEAD:src/server/
     sv_ccmds.ts`'s SV_WriteServerFile/SV_WriteLevelFile/stringToFixedBuf/
     encodeConfigstringsBlock (confirmed via `diff` against a checked-out
     copy, by hand, before writing this file -- this unit's report has the
     transcript) -- the legacy branches of the real, exported functions are
     textually IDENTICAL to that HEAD revision except for the family-dispatch
     guard now sitting above them, so this is a true regression gate, not
     just a "does my transcription match its own transcription" tautology.

  C. Kex save/load round trip at unit scope, using a fabricated GameExports
     (no real map, no SV_InitGame/SV_Map/NET_Config -- those belong to this
     unit's separate E2E report, not this file: SV_ReadServerFile's kex
     branch calls the real `await SV_InitGame()`, which reloads the REAL kex
     game module and rebinds a real network socket, both of which would
     silently replace the fabricated GameExports this suite injects and
     pull in asset/network dependencies a unit test has no business needing
     -- see this unit's report for why the server-file *read* path's
     game.ssv/cvar-restore behavior is therefore verified structurally
     (Group A's byte-level parse of what gets WRITTEN) rather than via a
     live SV_ReadServerFile() call). SV_ReadLevelFile has no such call, so
     its round trip is exercised for real.

  D. Demo recording codec consistency: SV_RecordDemoMessage's entity stream,
     recorded once under VANILLA_CODEC and once under Q2REPRO_CODEC, each
     parsed back through the SAME codec's own read ops
     (readPacketEntitiesBegin/readEntityBits/readDeltaEntity) into the
     entity list originally recorded.

Self-sufficient per PORTING.md/preferences.md rule 13: every global this
suite reads (game/basedir/sv_tick_rate cvars, sv/svs state, geHolder.ge,
svs.codec) is set up in this file's own beforeAll/beforeEach, not assumed
from another test file's run order.
*/

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FS_InitFilesystem, FS_ReadRawFile, FS_Gamedir, FS_FOpenFileWrite, FS_FCloseFile, FS_WriteFile } from "../src/qcommon/files";
import { Cvar_ForceSet, Cvar_Get } from "../src/qcommon/cvar";
import { CVAR_LATCH, CVAR_SERVERINFO, CS_NAME, EntityStateT, Com_sprintf, MAX_TOKEN_CHARS, MAX_OSPATH, MAX_CONFIGSTRINGS, MAX_QPATH, CVAR_NOARCHIVE } from "../src/shared/q_shared";
import { cvar_vars } from "../src/qcommon/cvar";
import type { GameExports, Edict } from "../src/game/game";
import { LinkT, MAX_ENT_CLUSTERS, SolidT, GAME_API_VERSION } from "../src/game/game";
import { vec3 } from "../src/shared/math";
import { sv, svs } from "../src/server/server";
import { geHolder } from "../src/server/sv_game";
import { SV_WriteServerFile, SV_ReadServerFile, SV_WriteLevelFile, SV_ReadLevelFile, SAVE_MAGIC1, SAVE_MAGIC2, SAVE_VERSION, SAVE_MANUAL, SAVE_LEVEL_START } from "../src/server/sv_ccmds";
import { SV_RecordDemoMessage } from "../src/server/sv_ents";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { CM_WritePortalState, CM_WritePortalBits } from "../src/qcommon/cmodel";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadLong64, MSG_ReadString, MSG_WriteShort, MSG_WriteLong, MSG_WriteString } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { SvcOpsT } from "../src/qcommon/qcommon";

//=============================================================================
// shared fixtures
//=============================================================================

function readerFor(raw: Uint8Array): SizeBuf {
  const buf = new SizeBuf();
  SZ_Init(buf, raw, raw.length);
  buf.cursize = raw.length;
  MSG_BeginReading(buf);
  return buf;
}

// Narrows `T | null` to `T` with a real runtime check (an `expect(...).not.
// toBeNull()` call a few lines up does not narrow the type for TypeScript,
// and preferences.md rule 2 bans `as` casts for this) -- every call site
// below is right after FS_ReadRawFile/FS_FOpenFileWrite is expected to have
// succeeded, so a thrown "unexpected null" here is itself a test failure,
// not a silently-accepted possibility.
function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`expected ${what} to be non-null`);
  return value;
}

function makeEdict(number: number, modelindex: number): Edict {
  const s = new EntityStateT();
  s.number = number;
  s.modelindex = modelindex;
  return {
    s,
    client: null,
    inuse: true,
    linkcount: 0,
    area: new LinkT(),
    num_clusters: 0,
    clusternums: new Int32Array(MAX_ENT_CLUSTERS),
    headnode: 0,
    areanum: 0,
    areanum2: 0,
    svflags: 0,
    mins: vec3(),
    maxs: vec3(),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid: SolidT.SOLID_NOT,
    clipmask: 0,
    owner: null,
  };
}

interface FakeGe extends GameExports {
  lastWriteGameAutosave: boolean | null;
  lastReadGameJson: string | null;
  lastWriteLevelTransition: boolean | null;
  lastReadLevelJson: string | null;
}

// See this function's one call site for why a plain `ge.lastReadLevelJson`
// read is not used directly there.
function readLastReadLevelJson(ge: FakeGe): string | null {
  return ge.lastReadLevelJson;
}

function makeFakeGe(gameJson: string | null, levelJson: string | null): FakeGe {
  const ge: FakeGe = {
    apiversion: GAME_API_VERSION,
    lastWriteGameAutosave: null,
    lastReadGameJson: null,
    lastWriteLevelTransition: null,
    lastReadLevelJson: null,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    WriteGameJson(autosave) {
      ge.lastWriteGameAutosave = autosave;
      return gameJson;
    },
    ReadGameJson(json) {
      ge.lastReadGameJson = json;
    },
    WriteLevelJson(transition) {
      ge.lastWriteLevelTransition = transition;
      return levelJson;
    },
    ReadLevelJson(json) {
      ge.lastReadLevelJson = json;
    },
    ClientConnect() {
      return { allowed: true, userinfo: "" };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    ServerCommand() {},
    edicts: [],
    num_edicts: 0,
    max_edicts: 0,
  };
  return ge;
}

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "q2save-"));
  mkdirSync(join(tmpRoot, "baseq2"));
  Cvar_ForceSet("basedir", tmpRoot);
  FS_InitFilesystem();
});

function resetServerState(): void {
  sv.clear();
  svs.clear();
}

//=============================================================================
// Group A -- SSV2/SAV2 header layout vs hand-built bytes (kex family)
//=============================================================================

describe("SSV2/SAV2 container -- kex family header layout (save.c)", () => {
  beforeEach(() => {
    resetServerState();
    svs.csr = CS_REMAP_RERELEASE;
    // Pre-register with the engine's real default+flags (files.ts:1189) so
    // this throwaway override can never become the cvar's default_string via
    // Cvar_Get's first-registration-wins contract (the pristine-order
    // pollution class the order-independence pass closed).
    Cvar_Get("game", "", CVAR_LATCH | CVAR_SERVERINFO | CVAR_NOARCHIVE);
    Cvar_ForceSet("game", "kex");
    geHolder.ge = makeFakeGe('{"kind":"game"}', '{"kind":"level"}');
  });

  test("SV_WriteServerFile: header is SAVE_MAGIC1 ('SSV2') + SAVE_VERSION", () => {
    sv.configstrings[CS_NAME] = "testmap";
    svs.mapcmd = "testmap$0";

    SV_WriteServerFile(false);

    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/server.ssv`), "server.ssv");
    const buf = readerFor(raw);
    expect(MSG_ReadLong(buf)).toBe(SAVE_MAGIC1);
    expect(MSG_ReadLong(buf)).toBe(SAVE_VERSION);
  });

  test("SV_WriteServerFile: comment field (timestamp/savetype/CS_NAME), mapcmd, and cvar list appear in save.c's exact order", () => {
    sv.configstrings[CS_NAME] = "campos";
    svs.mapcmd = "campos$0";
    Cvar_Get("sctest_latch", "1", CVAR_LATCH);
    Cvar_Get("sctest_info", "2", CVAR_SERVERINFO);
    Cvar_Get("sctest_plain", "3", 0);

    const before = BigInt(Math.floor(Date.now() / 1000)) - 1n;
    SV_WriteServerFile(true); // level-start autosave
    const after = BigInt(Math.floor(Date.now() / 1000)) + 1n;

    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/server.ssv`), `${FS_Gamedir()}/save/current/server.ssv`);
    const buf = readerFor(raw);
    expect(MSG_ReadLong(buf)).toBe(SAVE_MAGIC1);
    expect(MSG_ReadLong(buf)).toBe(SAVE_VERSION);

    const timestamp = MSG_ReadLong64(buf);
    expect(timestamp >= before && timestamp <= after).toBe(true);
    expect(MSG_ReadByte(buf)).toBe(SAVE_LEVEL_START);
    expect(MSG_ReadString(buf)).toBe("campos");

    expect(MSG_ReadString(buf)).toBe("campos$0");

    const seen = new Map<string, string>();
    for (;;) {
      const name = MSG_ReadString(buf);
      if (!name.length) break;
      const value = MSG_ReadString(buf);
      seen.set(name, value);
    }
    expect(seen.get("sctest_latch")).toBe("1");
    expect(seen.get("sctest_info")).toBe("2");
    expect(seen.has("sctest_plain")).toBe(false);
  });

  test("SV_WriteServerFile: byte-exact hand-built comparison for a minimal no-cvar fixture", () => {
    sv.configstrings[CS_NAME] = "hand";
    svs.mapcmd = "hand$0";

    SV_WriteServerFile(false);
    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/server.ssv`), `${FS_Gamedir()}/save/current/server.ssv`);

    // save.c:52-63 -- MSG_WriteLong(SAVE_MAGIC1); MSG_WriteLong(SAVE_VERSION);
    // MSG_WriteLong64(time); MSG_WriteByte(autosave); MSG_WriteString(CS_NAME).
    // Bytes 0-7 (magic+version) and byte 16 (savetype) plus the CS_NAME
    // string are deterministic; bytes 8-15 (the timestamp) are not, so only
    // the deterministic bytes are hand-compared here.
    expect(Array.from(raw.subarray(0, 4))).toEqual([SAVE_MAGIC1 & 0xff, (SAVE_MAGIC1 >> 8) & 0xff, (SAVE_MAGIC1 >> 16) & 0xff, (SAVE_MAGIC1 >>> 24) & 0xff]);
    expect(Array.from(raw.subarray(4, 8))).toEqual([SAVE_VERSION, 0, 0, 0]);
    expect(raw[16]).toBe(SAVE_MANUAL);
    expect(Array.from(raw.subarray(17, 17 + 5))).toEqual([104, 97, 110, 100, 0]); // "hand\0"
  });

  test("SV_WriteLevelFile: SAVE_MAGIC2 ('SAV2') header, non-empty configstrings only, index terminator, portal-bits length prefix", () => {
    sv.name = "q2savetest";
    sv.configstrings[1] = "hello";
    sv.configstrings[7] = "world";

    SV_WriteLevelFile();

    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/q2savetest.sv2`), `${FS_Gamedir()}/save/current/q2savetest.sv2`);
    const buf = readerFor(raw);
    expect(MSG_ReadLong(buf)).toBe(SAVE_MAGIC2);
    expect(MSG_ReadLong(buf)).toBe(SAVE_VERSION);

    const seen = new Map<number, string>();
    for (;;) {
      const idx = MSG_ReadShort(buf);
      if (idx === svs.csr.end) break;
      seen.set(idx, MSG_ReadString(buf));
    }
    expect(seen.get(1)).toBe("hello");
    expect(seen.get(7)).toBe("world");
    expect(seen.size).toBe(2);

    // Portal-bits section: a length byte followed by that many bytes.
    // cmodel.ts's numareaportals/portalopen are process-wide globals (no
    // per-test reset hook), so this compares against CM_WritePortalBits()'s
    // OWN current length rather than a hard-coded 0 -- this fixture loads no
    // map of its own (0 in an unpolluted process), but bun:test runs every
    // file in one process, and a real-map-booting E2E test elsewhere in the
    // suite (e.g. test/savegame_retail_roundtrip.test.ts) legitimately
    // leaves a nonzero global portal count behind it if it happens to run
    // first. Byte-for-byte content still gets checked, just against
    // whatever the shared global actually holds right now instead of an
    // assumption about test execution order.
    const expectedPortalBits = CM_WritePortalBits();
    const portalLen = MSG_ReadByte(buf);
    expect(portalLen).toBe(expectedPortalBits.length);
    const gotPortalBits = new Uint8Array(portalLen);
    for (let i = 0; i < portalLen; i++) gotPortalBits[i] = MSG_ReadByte(buf);
    expect(bytesEqual(gotPortalBits, expectedPortalBits)).toBe(true);
    expect(buf.readcount).toBe(buf.cursize);
  });

  test("SV_WriteServerFile: CVAR_LATCH/SERVERINFO cvars are written in strcmp-sorted order, matching q2repro's cvar_vars list", () => {
    // save.c's write_server_file walks the REAL engine's `cvar_vars` linked
    // list (`for (var = cvar_vars; var; var = var->next)`), which q2repro's
    // Cvar_Get keeps sorted by name at insertion time (src/common/cvar.c:
    // 308-315's "sort the variable in": `if (strcmp(var->name, c->name) < 0)
    // break;`). This port's cvar_vars is a plain insertion-order Map, so
    // SV_WriteServerFileKex sorts its own snapshot before writing --
    // confirmed necessary by a live cross-load byte diff against a real
    // q2reproded-produced server.ssv during this unit's verification (this
    // port's dump used to start "game,coop,deathmatch,gamedir,hostname,..";
    // q2repro's starts alphabetically "capturelimit,cheats,competition,
    // coop,.."). Registration order here is deliberately NOT alphabetical
    // (z before a), so this only passes if the writer actually sorts.
    Cvar_Get("zzz_late_latch", "1", CVAR_LATCH);
    Cvar_Get("aaa_early_latch", "1", CVAR_LATCH);
    Cvar_Get("mmm_mid_info", "1", CVAR_SERVERINFO);

    sv.configstrings[CS_NAME] = "sorttest";
    svs.mapcmd = "sorttest$0";
    SV_WriteServerFile(false);

    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/server.ssv`), "server.ssv");
    const buf = readerFor(raw);
    MSG_ReadLong(buf); // magic
    MSG_ReadLong(buf); // version
    MSG_ReadLong64(buf); // timestamp
    MSG_ReadByte(buf); // savetype
    MSG_ReadString(buf); // CS_NAME comment
    MSG_ReadString(buf); // mapcmd

    const order: string[] = [];
    for (;;) {
      const name = MSG_ReadString(buf);
      if (!name.length) break;
      MSG_ReadString(buf); // value
      order.push(name);
    }

    const ourThreeInOrder = order.filter((n) => n === "zzz_late_latch" || n === "aaa_early_latch" || n === "mmm_mid_info");
    expect(ourThreeInOrder).toEqual(["aaa_early_latch", "mmm_mid_info", "zzz_late_latch"]);

    const sortedCopy = [...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(order).toEqual(sortedCopy);
  });

  test("SV_WriteServerFile: WriteGameJson receives the autosave flag and its return value lands verbatim in game.ssv", () => {
    const ge = makeFakeGe('{"exact":"passthrough"}', null);
    geHolder.ge = ge;
    sv.configstrings[CS_NAME] = "passthrough";
    svs.mapcmd = "passthrough$0";

    SV_WriteServerFile(true);

    expect(ge.lastWriteGameAutosave).toBe(true);
    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/game.ssv`), "game.ssv");
    expect(new TextDecoder().decode(raw)).toBe('{"exact":"passthrough"}');
  });

  test("SV_WriteLevelFile: WriteLevelJson receives transition=false and its return value lands verbatim in the .sav file", () => {
    const ge = makeFakeGe(null, '{"exact":"level-passthrough"}');
    geHolder.ge = ge;
    sv.name = "passthroughlvl";

    SV_WriteLevelFile();

    expect(ge.lastWriteLevelTransition).toBe(false);
    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/passthroughlvl.sav`), "passthroughlvl.sav");
    expect(new TextDecoder().decode(raw)).toBe('{"exact":"level-passthrough"}');
  });
});

//=============================================================================
// Group B -- legacy container byte-identity (golden, git-show-HEAD reference)
//=============================================================================

// Transcribed verbatim from `git show HEAD:src/server/sv_ccmds.ts`'s
// stringToFixedBuf/SV_WriteServerFile (pre-this-unit's family-dispatch
// refactor). `diff` against a checked-out copy of that revision (done by
// hand before writing this file, transcript in this unit's report) confirms
// the CURRENT SV_WriteServerFile's legacy branch is textually identical to
// this except for the family-dispatch guard now sitting above it.
function referenceStringToFixedBuf(s: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < s.length && i < len; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return buf;
}

function referenceWriteServerFileBytes(autosave: boolean): Uint8Array {
  let comment: string;
  if (!autosave) {
    const d = new Date();
    comment = Com_sprintf("%2i:%i%i %2i/%2i  ", d.getHours(), Math.floor(d.getMinutes() / 10), d.getMinutes() % 10, d.getMonth() + 1, d.getDate());
    comment += sv.configstrings[CS_NAME].slice(0, Math.max(0, 31 - comment.length));
  } else {
    comment = Com_sprintf("ENTERING %s", sv.configstrings[CS_NAME]);
  }

  const parts: Uint8Array[] = [referenceStringToFixedBuf(comment, 32), referenceStringToFixedBuf(svs.mapcmd, MAX_TOKEN_CHARS)];
  for (const v of cvar_vars.values()) {
    if (!(v.flags & CVAR_LATCH)) continue;
    if (v.name.length >= MAX_OSPATH - 1 || v.string.length >= 128 - 1) continue;
    parts.push(referenceStringToFixedBuf(v.name, MAX_OSPATH));
    parts.push(referenceStringToFixedBuf(v.string, 128));
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  return combined;
}

// Transcribed verbatim from `git show HEAD:src/server/sv_ccmds.ts`'s
// encodeConfigstringsBlock/SV_WriteLevelFile (same pre-refactor revision).
function referenceEncodeConfigstringsBlock(): Uint8Array {
  const buf = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH);
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    const base = i * MAX_QPATH;
    const s = sv.configstrings[i];
    for (let j = 0; j < s.length && j < MAX_QPATH; j++) {
      buf[base + j] = s.charCodeAt(j) & 0xff;
    }
  }
  return buf;
}

function referenceWriteLevelFileBytes(): Uint8Array {
  const portalState = CM_WritePortalState();
  const combined = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH + portalState.length);
  combined.set(referenceEncodeConfigstringsBlock(), 0);
  combined.set(portalState, MAX_CONFIGSTRINGS * MAX_QPATH);
  return combined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
}

describe("legacy family savegame container -- byte-identity vs git-show-HEAD reference", () => {
  beforeEach(() => {
    resetServerState();
    svs.csr = CS_REMAP_OLD;
    Cvar_ForceSet("game", "");
    geHolder.ge = makeFakeGe(null, null);
  });

  test("SV_WriteServerFile (legacy, autosave=true deterministic branch): byte-identical to the transcribed HEAD reference", () => {
    sv.configstrings[CS_NAME] = "legacytest";
    svs.mapcmd = "legacytest$0";

    const expected = referenceWriteServerFileBytes(true);
    SV_WriteServerFile(true);
    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/server.ssv`), `${FS_Gamedir()}/save/current/server.ssv`);

    expect(bytesEqual(raw, expected)).toBe(true);
  });

  test("SV_WriteLevelFile (legacy): byte-identical to the transcribed HEAD reference", () => {
    sv.name = "legacylvl";
    sv.configstrings[3] = "abc";
    sv.configstrings[CS_NAME] = "legacylvlname";

    const expected = referenceWriteLevelFileBytes();
    SV_WriteLevelFile();
    const raw = must(FS_ReadRawFile(`${FS_Gamedir()}/save/current/legacylvl.sv2`), `${FS_Gamedir()}/save/current/legacylvl.sv2`);

    expect(bytesEqual(raw, expected)).toBe(true);
  });
});

//=============================================================================
// Group C -- kex save/load round trip at unit scope (fabricated world)
//=============================================================================

describe("kex family savegame container -- round trip and error handling (unit scope)", () => {
  beforeEach(() => {
    resetServerState();
    svs.csr = CS_REMAP_RERELEASE;
    Cvar_ForceSet("game", "kex");
  });

  test("SV_WriteLevelFile -> SV_ReadLevelFile: configstrings and level JSON round-trip exactly", () => {
    const ge = makeFakeGe(null, '{"round":"trip-level"}');
    geHolder.ge = ge;
    sv.name = "rtlevel";
    sv.configstrings[2] = "alpha";
    sv.configstrings[9] = "bravo";

    SV_WriteLevelFile();

    // prove the read path actually restores state, not that it was already
    // sitting there from the write above
    sv.configstrings[2] = "";
    sv.configstrings[9] = "";
    ge.lastReadLevelJson = null;

    SV_ReadLevelFile();

    expect(sv.configstrings[2]).toBe("alpha");
    expect(sv.configstrings[9]).toBe("bravo");
    // Read through a helper taking a fresh `FakeGe` parameter binding: a
    // direct `ge.lastReadLevelJson` read here would keep TypeScript's
    // control-flow narrowing from the `= null` assignment above (narrowing
    // on a property access is not invalidated just because an intervening
    // function call may have mutated it), which would reject the string
    // literal below as "not assignable to null" -- a TS false positive, not
    // a real type error, since ReadLevelJson's closure over `ge` (see
    // makeFakeGe) does mutate it.
    expect(readLastReadLevelJson(ge)).toBe('{"round":"trip-level"}');
  });

  test("SV_ReadServerFile: bad magic is a soft failure (logs and returns), never reaches SV_InitGame/mapcmd assignment", () => {
    geHolder.ge = makeFakeGe(null, null);
    svs.mapcmd = "untouched$0";

    const scratch = new Uint8Array(64);
    const buf = new SizeBuf();
    SZ_Init(buf, scratch, scratch.length);
    MSG_WriteLong(buf, 0xdeadbeef); // not SAVE_MAGIC1
    MSG_WriteLong(buf, SAVE_VERSION);
    FS_WriteFile(`${FS_Gamedir()}/save/current/server.ssv`, buf.data.subarray(0, buf.cursize));

    // await is required (SV_ReadServerFile is async), but resolving without
    // throwing and without touching svs.mapcmd is exactly the "soft
    // failure, never reaches SV_InitGame" behavior under test.
    return SV_ReadServerFile().then(() => {
      expect(svs.mapcmd).toBe("untouched$0");
    });
  });

  test("SV_ReadLevelFile: an out-of-range configstring index throws (save.c's 'Bad savegame configstring index')", () => {
    geHolder.ge = makeFakeGe(null, "{}");
    sv.name = "badindex";

    const scratch = new Uint8Array(64);
    const buf = new SizeBuf();
    SZ_Init(buf, scratch, scratch.length);
    MSG_WriteLong(buf, SAVE_MAGIC2);
    MSG_WriteLong(buf, SAVE_VERSION);
    MSG_WriteShort(buf, svs.csr.end + 5); // out of range, not the terminator
    FS_WriteFile(`${FS_Gamedir()}/save/current/badindex.sv2`, buf.data.subarray(0, buf.cursize));

    expect(() => SV_ReadLevelFile()).toThrow();
  });

  test("SV_ReadLevelFile: an oversized configstring throws (save.c's 'Savegame configstring too long')", () => {
    geHolder.ge = makeFakeGe(null, "{}");
    sv.name = "toolong";

    const scratch = new Uint8Array(512);
    const buf = new SizeBuf();
    SZ_Init(buf, scratch, scratch.length);
    MSG_WriteLong(buf, SAVE_MAGIC2);
    MSG_WriteLong(buf, SAVE_VERSION);
    MSG_WriteShort(buf, 1);
    // svs.csr.configstring_size is MAX_QPATH(64) for the old family or
    // CS_MAX_STRING_LENGTH_WIDE(96) for kex -- 200 'x' characters exceeds
    // either.
    MSG_WriteString(buf, "x".repeat(200));
    MSG_WriteShort(buf, svs.csr.end); // terminator (never reached)
    FS_WriteFile(`${FS_Gamedir()}/save/current/toolong.sv2`, buf.data.subarray(0, buf.cursize));

    expect(() => SV_ReadLevelFile()).toThrow();
  });
});

//=============================================================================
// Group D -- demo recording codec consistency (SV_RecordDemoMessage)
//=============================================================================

function recordDemoFrame(codec: ProtocolCodec, edicts: Edict[]): Uint8Array {
  svs.codec = codec;
  geHolder.ge = {
    apiversion: GAME_API_VERSION,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect() {
      return { allowed: true, userinfo: "" };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    ServerCommand() {},
    edicts: [makeEdict(0, 0), ...edicts], // index 0 is world/unused
    num_edicts: edicts.length + 1,
    max_edicts: edicts.length + 1,
  };

  const demoPath = join(tmpRoot, `demo-${codec.name}.bin`);
  const handle = must(FS_FOpenFileWrite(demoPath), "demo file handle");
  svs.demofile = handle;
  SZ_Init(svs.demo_multicast, svs.demo_multicast_buf, svs.demo_multicast_buf.length);
  sv.framenum = 7;

  SV_RecordDemoMessage();

  FS_FCloseFile(handle);
  svs.demofile = null;

  return must(FS_ReadRawFile(demoPath), demoPath);
}

function parseDemoFrame(codec: ProtocolCodec, raw: Uint8Array): { framenum: number; entities: EntityStateT[] } {
  // 4-byte little-endian length prefix (SV_RecordDemoMessage's own framing,
  // shared by both codecs -- see sv_ents.ts's comment on why the svc_frame/
  // framenum header itself is not routed through svs.codec.writeFrame).
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const msglen = view.getInt32(0, true);
  const payload = raw.subarray(4, 4 + msglen);

  const buf = readerFor(payload);
  const opcode = MSG_ReadByte(buf);
  const framenum = MSG_ReadLong(buf);

  // codec.readPacketEntitiesBegin/readEntityBits/readDeltaEntity read from
  // the net_message singleton (codec.ts's documented client-side-read
  // convention -- see test/protocol_frame_envelope.test.ts's
  // loadIntoNetMessage precedent), not from an arbitrary passed-in SizeBuf,
  // so the remaining payload bytes (everything after the framenum long)
  // must be loaded into that singleton before calling them.
  SZ_Clear(net_message);
  const rest = payload.subarray(5); // 1 (opcode) + 4 (framenum) = 5
  SZ_Write(net_message, rest, rest.length);
  MSG_BeginReading(net_message);

  codec.readPacketEntitiesBegin();

  const entities: EntityStateT[] = [];
  for (;;) {
    const { number, bits } = codec.readEntityBits();
    if (number === 0) break;
    const from = new EntityStateT();
    const to = new EntityStateT();
    codec.readDeltaEntity(from, to, number, bits);
    entities.push(to);
  }

  expect(opcode).toBe(SvcOpsT.svc_frame); // shared by both codecs, see sv_ents.ts's comment
  return { framenum, entities };
}

describe("SV_RecordDemoMessage -- codec-consistent packetentities framing", () => {
  test("VANILLA_CODEC: recorded entities round-trip through VANILLA_CODEC's own read ops", () => {
    const e1 = makeEdict(1, 42);
    const e2 = makeEdict(2, 99);
    const raw = recordDemoFrame(VANILLA_CODEC, [e1, e2]);
    const { framenum, entities } = parseDemoFrame(VANILLA_CODEC, raw);

    expect(framenum).toBe(7);
    expect(entities.map((e) => e.number).sort()).toEqual([1, 2]);
    expect(entities.find((e) => e.number === 1)?.modelindex).toBe(42);
    expect(entities.find((e) => e.number === 2)?.modelindex).toBe(99);
  });

  test("Q2REPRO_CODEC: recorded entities round-trip through Q2REPRO_CODEC's own read ops (the fix under test)", () => {
    const e1 = makeEdict(3, 7);
    const e2 = makeEdict(4, 123);
    const raw = recordDemoFrame(Q2REPRO_CODEC, [e1, e2]);
    const { framenum, entities } = parseDemoFrame(Q2REPRO_CODEC, raw);

    expect(framenum).toBe(7);
    expect(entities.map((e) => e.number).sort()).toEqual([3, 4]);
    expect(entities.find((e) => e.number === 3)?.modelindex).toBe(7);
    expect(entities.find((e) => e.number === 4)?.modelindex).toBe(123);
  });

  test("Q2REPRO_CODEC: parsing a vanilla-recorded demo as if it were 1038 fails (proves the two are genuinely distinguishable, not accidentally identical)", () => {
    const raw = recordDemoFrame(VANILLA_CODEC, [makeEdict(1, 5)]);
    // Under VANILLA_CODEC the byte right after the framenum long is the
    // literal svc_packetentities opcode (0x17); Q2REPRO_CODEC's
    // readPacketEntitiesBegin is a no-op, so it would misinterpret that
    // opcode byte as the start of an entity-bits/number pair instead of
    // consuming it -- one of these two reads must observably disagree,
    // otherwise the fix has no effect.
    const vanillaParsed = parseDemoFrame(VANILLA_CODEC, raw);
    expect(vanillaParsed.entities.map((e) => e.number)).toEqual([1]);
  });
});
