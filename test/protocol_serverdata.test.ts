// Gate for the svc_serverdata READ side added to ProtocolCodec
// (src/qcommon/protocol/codec.ts's ServerDataReadResultT/readServerData) and
// for cl_parse.ts's CL_ParseServerData protocol/codec/csr selection
// (.orch/phase5-design.md phase 5's client-parity follow-up -- see that
// file's task report for the full "1038 client cannot read a kex server"
// investigation this unit fixes).
//
// Three groups of coverage:
//   1. VANILLA_CODEC.readServerData byte-identity against a reference built
//      from `git show HEAD:src/client/cl_parse.ts`'s ORIGINAL
//      CL_ParseServerData body (the six MSG_Read* calls this codec's
//      readServerData extracts verbatim -- see vanilla.ts's doc comment,
//      which cites the exact same source). The reference isn't a second
//      hand-written parser (there is nothing to re-derive: the field
//      list/order/types are copied 1:1) -- instead each test builds a wire
//      buffer with MSG_Write* in that exact pre-existing order and asserts
//      readServerData reproduces every field, proving no field was dropped,
//      reordered, or given the wrong width during the extraction.
//   2. Q2REPRO_CODEC round-trip: writeServerData -> readServerData field
//      equality (there is no prior TypeScript implementation to diff against
//      here either, matching protocol_q2repro.test.ts's own stated
//      round-trip convention for cases q2proto's C source doesn't get a
//      hand-derived byte array).
//   3. cl_parse.ts's exported selectServerCodec: codec + csr selection by
//      protocol number, including the pre-existing "BIG HACK to let demos
//      from release work with the 3.0x patch!!!" bypass this unit had to
//      thread the new 1038 branch around without breaking.

import { describe, test, expect, beforeEach } from "bun:test";
import { SizeBuf, SZ_Init, SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteString, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { Com_SetServerState } from "../src/qcommon/common";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_RERELEASE } from "../src/qcommon/qcommon";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { selectServerCodec } from "../src/client/cl_parse";

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  resetNetMessage();
  Com_SetServerState(0);
});

// =============================================================================
// 1. VANILLA_CODEC.readServerData -- byte-identity vs the git-show-HEAD
//    original CL_ParseServerData body (cl_parse.c's field list, unchanged
//    since this port's first landing of the file: Long servercount, Byte
//    attractloop, String gamedir, Short clientnum, String levelname).
// =============================================================================

describe("VANILLA_CODEC.readServerData -- byte-identity vs pre-extraction CL_ParseServerData", () => {
  test("typical map serverdata: attractloop=0, positive clientnum", () => {
    MSG_WriteLong(net_message, 12345); // servercount
    MSG_WriteByte(net_message, 0); // attractloop
    MSG_WriteString(net_message, "baseq2"); // gamedir
    MSG_WriteShort(net_message, 3); // clientnum
    MSG_WriteString(net_message, "The Base"); // levelname
    MSG_BeginReading(net_message);

    const sd = VANILLA_CODEC.readServerData();
    expect(sd).toEqual({
      servercount: 12345,
      attractloop: false,
      gamedir: "baseq2",
      clientnum: 3,
      levelname: "The Base",
      serverState: 0,
    });
  });

  test("attractloop=1 decodes to true (demo/cinematic serverdata)", () => {
    MSG_WriteLong(net_message, 1);
    MSG_WriteByte(net_message, 1); // attractloop
    MSG_WriteString(net_message, "baseq2");
    MSG_WriteShort(net_message, -1); // cinematic sentinel
    MSG_WriteString(net_message, "intro.cin");
    MSG_BeginReading(net_message);

    const sd = VANILLA_CODEC.readServerData();
    expect(sd.attractloop).toBe(true);
    expect(sd.clientnum).toBe(-1);
    expect(sd.levelname).toBe("intro.cin");
  });

  test("empty gamedir string (baseq2 default) round-trips as empty string", () => {
    MSG_WriteLong(net_message, 0);
    MSG_WriteByte(net_message, 0);
    MSG_WriteString(net_message, ""); // baseq2's own configstring convention: "" means baseq2
    MSG_WriteShort(net_message, 0);
    MSG_WriteString(net_message, "");
    MSG_BeginReading(net_message);

    const sd = VANILLA_CODEC.readServerData();
    expect(sd.gamedir).toBe("");
    expect(sd.levelname).toBe("");
  });

  test("field order is servercount, attractloop, gamedir, clientnum, levelname -- a truncated buffer fails past the point matching this exact order", () => {
    // Only servercount + attractloop + gamedir written; clientnum/levelname
    // missing. If readServerData's internal order didn't match
    // (servercount, attractloop, gamedir, clientnum, levelname), this would
    // either succeed (wrong) or fail at a different field than expected.
    MSG_WriteLong(net_message, 7);
    MSG_WriteByte(net_message, 0);
    MSG_WriteString(net_message, "rogue");
    MSG_BeginReading(net_message);

    // MSG_ReadShort at EOF returns -1 (classic Quake2 net-message EOF
    // sentinel, not a throw -- matches cl_parse.test.ts's own documented
    // truncated-message convention), so this proves gamedir was read in
    // full (not clientnum's bytes misread as part of the string) by getting
    // exactly the EOF sentinel for clientnum, not garbage.
    const sd = VANILLA_CODEC.readServerData();
    expect(sd.servercount).toBe(7);
    expect(sd.gamedir).toBe("rogue");
    expect(sd.clientnum).toBe(-1);
  });
});

// =============================================================================
// 2. Q2REPRO_CODEC -- write -> read round-trip.
// =============================================================================

describe("Q2REPRO_CODEC.writeServerData -> readServerData round-trip", () => {
  function roundTrip(params: {
    servercount: number;
    attractloop: boolean;
    gamedir: string;
    clientnum: number;
    levelname: string;
    serverState: number;
  }) {
    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(4096), 4096);
    Q2REPRO_CODEC.writeServerData(msg, params);

    // writeServerData emits the leading svc_serverdata opcode + the
    // protocol-number long (both consumed by the CALLER in real traffic --
    // see codec.ts's ServerDataReadResultT doc comment); skip both before
    // feeding the rest to readServerData, matching cl_parse.ts's own
    // CL_ParseServerData call sequence (opcode consumed by
    // CL_ParseServerMessage's switch, protocol number consumed by
    // CL_ParseServerData itself before calling codec.readServerData()).
    resetNetMessage();
    net_message.data.set(msg.data.subarray(0, msg.cursize));
    net_message.cursize = msg.cursize;
    MSG_BeginReading(net_message);
    net_message.readcount = 5; // 1 opcode byte + 4-byte protocol long

    return Q2REPRO_CODEC.readServerData();
  }

  test("typical kex map serverdata", () => {
    const sd = roundTrip({
      servercount: 42,
      attractloop: false,
      gamedir: "kex",
      clientnum: 0,
      levelname: "base1",
      serverState: 0, // ss_game
    });
    expect(sd).toEqual({
      servercount: 42,
      attractloop: false,
      gamedir: "kex",
      clientnum: 0,
      levelname: "base1",
      serverState: 0,
    });
  });

  test("attractloop=true + non-zero server_state (ss_cinematic) round-trips both", () => {
    const sd = roundTrip({
      servercount: 999,
      attractloop: true,
      gamedir: "kex",
      clientnum: -1,
      levelname: "intro.cin",
      serverState: 2, // ss_cinematic
    });
    expect(sd.attractloop).toBe(true);
    expect(sd.clientnum).toBe(-1);
    expect(sd.serverState).toBe(2);
    expect(sd.levelname).toBe("intro.cin");
  });

  test("large servercount (beyond 16 bits, exercises the full i32 write/read) round-trips exactly", () => {
    const sd = roundTrip({
      servercount: 0x12345678,
      attractloop: false,
      gamedir: "kex",
      clientnum: 5,
      levelname: "q64/comm1",
      serverState: 0,
    });
    expect(sd.servercount).toBe(0x12345678);
    expect(sd.gamedir).toBe("kex");
    expect(sd.clientnum).toBe(5);
  });

  test("reads exactly the bytes writeServerData emits -- no leftover/missing bytes (byte-alignment gate for the q2pro extension-field tail)", () => {
    // Regression gate for the protocol_version/q2repro_flags/server_fps tail
    // this codec's readServerData must consume-and-discard in the right
    // widths (short, short, byte) to stay aligned: append a second faux
        // message (a single sentinel byte) right after the serverdata body and
    // confirm readServerData leaves the read cursor exactly at that byte,
    // proving it consumed neither more nor fewer bytes than writeServerData
    // produced.
    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(4096), 4096);
    Q2REPRO_CODEC.writeServerData(msg, {
      servercount: 1,
      attractloop: false,
      gamedir: "kex",
      clientnum: 0,
      levelname: "base1",
      serverState: 0,
    });
    const sentinel = 0xaa;
    MSG_WriteByte(msg, sentinel);

    resetNetMessage();
    net_message.data.set(msg.data.subarray(0, msg.cursize));
    net_message.cursize = msg.cursize;
    MSG_BeginReading(net_message);
    net_message.readcount = 5; // skip opcode + protocol long

    Q2REPRO_CODEC.readServerData();
    expect(MSG_ReadByte(net_message)).toBe(sentinel);
  });
});

// =============================================================================
// 3. cl_parse.ts's selectServerCodec -- codec + csr selection by protocol
//    number, including the pre-existing "BIG HACK" bypass.
// =============================================================================

describe("selectServerCodec -- codec/csr selection by protocol number", () => {
  test("protocol 34 (classic) selects VANILLA_CODEC + CS_REMAP_OLD", () => {
    const { codec, csr } = selectServerCodec(PROTOCOL_VERSION);
    expect(codec).toBe(VANILLA_CODEC);
    expect(csr).toBe(CS_REMAP_OLD);
  });

  test("protocol 1038 (kex/rerelease) selects Q2REPRO_CODEC + CS_REMAP_RERELEASE", () => {
    const { codec, csr } = selectServerCodec(PROTOCOL_VERSION_RERELEASE);
    expect(codec).toBe(Q2REPRO_CODEC);
    expect(csr).toBe(CS_REMAP_RERELEASE);
  });

  test("an unrecognized protocol number throws ERR_DROP (\"Server returned version\") when not running a listen server", () => {
    expect(() => selectServerCodec(26)).toThrow(/version/);
  });

  test("BIG HACK preserved: an unrecognized protocol number while Com_ServerState() is truthy falls back to VANILLA_CODEC instead of throwing", () => {
    Com_SetServerState(1); // ss_game -- listen server active
    const { codec, csr } = selectServerCodec(26);
    expect(codec).toBe(VANILLA_CODEC);
    expect(csr).toBe(CS_REMAP_OLD);
  });

  test("1038 wins over the BIG HACK bypass even when Com_ServerState() is truthy -- a kex listen server must not fall through to vanilla", () => {
    Com_SetServerState(1);
    const { codec, csr } = selectServerCodec(PROTOCOL_VERSION_RERELEASE);
    expect(codec).toBe(Q2REPRO_CODEC);
    expect(csr).toBe(CS_REMAP_RERELEASE);
  });
});
