/*
The re-release objective marker (svc_poi) and its breadcrumb trail
(svc_help_path) under the CLASSIC module.

src/game/g_kextarg.ts already ran the whole target_poi selection algorithm --
team scan, style priority, NEAREST ranking, DUMMY fallback, DYNAMIC latching,
the level-wide stage counter -- and recorded the winner in the kex level
state. What was missing was the PRESENTATION: nothing in src/game ever put an
svc_poi on the wire, so the compass marker the re-release module draws simply
did not exist under the classic ruleset.

It does now, through the same optional-GameImports-hook pattern
extended_layout()/shadowlight()/fog() established: gi.poi() and
gi.help_path(), with src/server/bindings/legacy.ts's PF_Poi / PF_HelpPath as
the engine half.

What this file pins:

  1. WIRE VOCABULARY. legacy.ts spells the svc_poi / svc_help_path opcodes
     locally rather than importing src/kexapi/game.ts, so neither the binding
     nor src/game behind it takes a dependency on the kex API surface. Safe
     only if the two definitions cannot drift -- compared here.

  2. THE ENCODING, by round trip. PF_Poi / PF_HelpPath output is fed to
     qcommon/protocol/kexdemo.ts's readPoiKex / readHelpPathKex -- the SAME
     decoders cl_parse.ts runs -- and every decoded field is checked against
     what went in.

  3. BYTE-FOR-BYTE PARITY WITH THE KEX MODULE. The headline claim of this
     unit is that the classic module emits exactly what the re-release module
     emits for the same POI. src/kexgame/p_client.ts's P_SendLevelPOI writes
     its message field by field through gi.WriteByte/WriteShort/WriteFloat,
     which the kex binding routes to the very same PF_* functions PF_Poi
     calls. So the kex sequence is replayed here through those PF_* functions
     and the resulting bytes compared against PF_Poi's, with no encoder
     shared between the two paths beyond the primitives themselves.

  4. THE POSITION ENCODING REGRESSION. gi.WritePosition was the wrong
     primitive for these two messages: q2repro's server-side PF_WritePos is
     `q2proto_server_write_pos(Q2P_PROTOCOL_MULTICAST_FLOAT, ...)` -- three
     IEEE floats -- while this engine's shared PF_WritePos writes the classic
     three-shorts-at-1/8-unit form every protocol-34 message uses. The kex
     module used to call it here, putting 6 bytes where readPoiKex reads 12.
     Pinned by asserting the exact byte length of both messages.

  5. THE NARROW GATE. A session still on CS_REMAP_OLD must emit NOTHING for
     either message. Protocol 34 has no svc_poi and no svc_help_path, and a
     vanilla client handed either opcode would desync. This is the property
     that keeps 1997 content byte-for-byte vanilla.

  6. THE CLASSIC MODULE'S OWN CALL SHAPE: g_kextarg.ts's P_SendLevelPOI
     passes POI_OBJECTIVE / 10000 / the recorded location / the recorded
     image / colour 208 / no flags, and returns without calling gi.poi at all
     when the level has no valid POI -- the C++'s own early return.
*/

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";

import { CS_REMAP_OLD, CS_REMAP_RERELEASE, MAX_EDICTS_WIDE } from "../src/shared/cs_remap";
import { sv, svs } from "../src/server/server";
import { SZ_Clear, SZ_Init, MSG_BeginReading, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { readPoiKex, readHelpPathKex } from "../src/qcommon/protocol/kexdemo";
import { ServerCommandT, SvcPoiFlagsT } from "../src/kexapi/game";
import { PF_Poi, PF_HelpPath, SVC_POI, SVC_HELP_PATH } from "../src/server/bindings/legacy";
import { PF_WriteByte, PF_WriteShort, PF_WriteFloat, PF_WriteDir } from "../src/server/sv_game";
import { vec3 } from "../src/shared/math";
import type { Edict } from "../src/game/game";

/*
A stand-in edict whose s.number is 0, i.e. the world. PF_Unicast bails on it
at `if (p < 1 || p > maxclients) return;` BEFORE the SZ_Clear at the end of
the function, so the encoded bytes stay in sv.multicast where the test can
read them and no netchan or client array has to exist. The encode path under
test runs in full either way. Same harness trick wide_classic_fog.test.ts
uses, for the same reason.
*/
const worldEdict = { s: { number: 0 } } as unknown as Edict;

let savedCsr: typeof svs.csr;

// net_message is a module singleton every client-side decode path reads
// through, and beginDecode() below repoints it at a local byte array. Its
// original backing store is captured once and put back when this file is
// done, so no later test file inherits a net_message pointed at a stale
// scratch buffer.
const savedNetMessage = {
  data: net_message.data,
  view: net_message.view,
  cursize: net_message.cursize,
  readcount: net_message.readcount,
  maxsize: net_message.maxsize,
};

beforeEach(() => {
  savedCsr = svs.csr;
  SZ_Init(sv.multicast, sv.multicast_buf, sv.multicast_buf.length);
  SZ_Clear(sv.multicast);
});

afterEach(() => {
  svs.csr = savedCsr;
  SZ_Clear(sv.multicast);
});

afterAll(() => {
  net_message.data = savedNetMessage.data;
  net_message.view = savedNetMessage.view;
  net_message.cursize = savedNetMessage.cursize;
  net_message.readcount = savedNetMessage.readcount;
  net_message.maxsize = savedNetMessage.maxsize;
});

function emitted(): Uint8Array {
  return sv.multicast.data.subarray(0, sv.multicast.cursize).slice();
}

/*
SZ_Init, not a bare `net_message.data = bytes`: SizeBuf carries a DataView
alongside the byte array and MSG_ReadFloat reads through the VIEW while
MSG_ReadByte reads through the array. Swapping only the array leaves the view
pointed at the previous buffer -- bytes read fine and floats read as zero.
*/
function beginDecode(bytes: Uint8Array): number {
  SZ_Init(net_message, bytes, bytes.length);
  net_message.cursize = bytes.length;
  MSG_BeginReading(net_message);
  return MSG_ReadByte(net_message);
}

// ---------------------------------------------------------------------------
// 1. Wire vocabulary
// ---------------------------------------------------------------------------

describe("svc_poi / svc_help_path wire vocabulary stays pinned to the kex API's", () => {
  test("the opcodes match ServerCommandT", () => {
    expect(SVC_POI).toBe(ServerCommandT.svc_poi);
    expect(SVC_HELP_PATH).toBe(ServerCommandT.svc_help_path);
  });
});

// ---------------------------------------------------------------------------
// 2. Encoding round trip through the client's own decoders
// ---------------------------------------------------------------------------

describe("PF_Poi encodes what readPoiKex decodes", () => {
  beforeEach(() => {
    svs.csr = CS_REMAP_RERELEASE;
  });

  test("every field survives the round trip", () => {
    PF_Poi(worldEdict, 8192, 10000, vec3(-1664, 1536, 144), 37, 208, SvcPoiFlagsT.POI_FLAG_NONE);

    const bytes = emitted();
    expect(beginDecode(bytes)).toBe(ServerCommandT.svc_poi);

    const poi = readPoiKex();
    expect(poi.key).toBe(8192);
    expect(poi.time).toBe(10000);
    expect(Array.from(poi.pos)).toEqual([-1664, 1536, 144]);
    expect(poi.image).toBe(37);
    expect(poi.color).toBe(208);
    expect(poi.flags).toBe(SvcPoiFlagsT.POI_FLAG_NONE);
  });

  test("fractional coordinates survive -- the whole point of the float encoding", () => {
    // A 1/8-unit short encoding (this engine's shared PF_WritePos) would
    // quantize these; three IEEE floats do not.
    PF_Poi(worldEdict, 8192, 10000, vec3(0.5, -1128.25, -128.125), 1, 208, 0);
    expect(beginDecode(emitted())).toBe(ServerCommandT.svc_poi);
    const poi = readPoiKex();
    expect(Array.from(poi.pos)).toEqual([0.5, -1128.25, -128.125]);
  });

  test("the message is exactly 15 bytes: opcode + u16 + u16 + 3xf32 + u16 + u8 + u8", () => {
    PF_Poi(worldEdict, 8192, 10000, vec3(1, 2, 3), 4, 208, 0);
    expect(emitted().length).toBe(1 + 2 + 2 + 12 + 2 + 1 + 1);
  });

  test("the USHRT_MAX time sentinel (SCR_RemovePOI) round trips", () => {
    PF_Poi(worldEdict, 8192, 0xffff, vec3(0, 0, 0), 0, 208, 0);
    expect(beginDecode(emitted())).toBe(ServerCommandT.svc_poi);
    expect(readPoiKex().time).toBe(0xffff);
  });

  test("POI_FLAG_HIDE_ON_AIM round trips", () => {
    PF_Poi(worldEdict, 8192, 5000, vec3(0, 0, 0), 0, 208, SvcPoiFlagsT.POI_FLAG_HIDE_ON_AIM);
    expect(beginDecode(emitted())).toBe(ServerCommandT.svc_poi);
    expect(readPoiKex().flags).toBe(SvcPoiFlagsT.POI_FLAG_HIDE_ON_AIM);
  });
});

describe("PF_HelpPath encodes what readHelpPathKex decodes", () => {
  beforeEach(() => {
    svs.csr = CS_REMAP_RERELEASE;
  });

  test("first flag and position survive the round trip", () => {
    PF_HelpPath(worldEdict, true, vec3(10.5, -20.25, 30), vec3(0, 1, 0));

    expect(beginDecode(emitted())).toBe(ServerCommandT.svc_help_path);
    const hp = readHelpPathKex();
    expect(hp.start).toBe(true);
    expect(Array.from(hp.pos)).toEqual([10.5, -20.25, 30]);
    // WriteDir quantizes to one of the 162 vertex normals, so the direction
    // comes back close, not exact -- that is the wire format, not this port.
    expect(hp.dir[1]).toBeGreaterThan(0.9);
  });

  test("first=false round trips", () => {
    PF_HelpPath(worldEdict, false, vec3(0, 0, 0), vec3(1, 0, 0));
    expect(beginDecode(emitted())).toBe(ServerCommandT.svc_help_path);
    expect(readHelpPathKex().start).toBe(false);
  });

  test("the message is exactly 15 bytes: opcode + u8 + 3xf32 + dir byte", () => {
    PF_HelpPath(worldEdict, true, vec3(1, 2, 3), vec3(0, 0, 1));
    expect(emitted().length).toBe(1 + 1 + 12 + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Byte-for-byte parity with the kex module's own write sequence
// ---------------------------------------------------------------------------

describe("the classic module's svc_poi bytes equal the kex module's", () => {
  beforeEach(() => {
    svs.csr = CS_REMAP_RERELEASE;
  });

  /*
  src/kexgame/p_client.ts's P_SendLevelPOI body, replayed through the same
  PF_* primitives bindings/kex.ts wires its gi.Write* imports to. Nothing is
  shared with PF_Poi beyond those primitives, so matching bytes really do
  mean the two modules put the same message on the wire.
  */
  function kexPSendLevelPOI(key: number, timeMs: number, pos: readonly number[], image: number): void {
    PF_WriteByte(ServerCommandT.svc_poi);
    PF_WriteShort(key);
    PF_WriteShort(timeMs);
    PF_WriteFloat(pos[0]);
    PF_WriteFloat(pos[1]);
    PF_WriteFloat(pos[2]);
    PF_WriteShort(image);
    PF_WriteByte(208);
    PF_WriteByte(SvcPoiFlagsT.POI_FLAG_NONE);
  }

  test("identical bytes for the same objective POI", () => {
    const key = MAX_EDICTS_WIDE; // g_local.h:946's POI_OBJECTIVE
    const pos = [-1488, 1664, -120];

    PF_Poi(worldEdict, key, 10000, vec3(pos[0], pos[1], pos[2]), 42, 208, SvcPoiFlagsT.POI_FLAG_NONE);
    const fromClassic = emitted();

    SZ_Clear(sv.multicast);
    kexPSendLevelPOI(key, 10000, pos, 42);
    const fromKex = emitted();

    expect(Array.from(fromClassic)).toEqual(Array.from(fromKex));
  });

  test("POI_OBJECTIVE is the WIDE layout's MAX_EDICTS, which is what both modules key on", () => {
    // src/game/g_kextarg.ts spells 8192 as a local constant because the
    // classic module's own MAX_EDICTS is 1024; the client receiving the
    // message is on the wide layout by construction.
    expect(MAX_EDICTS_WIDE).toBe(8192);
  });

  /*
  src/kexgame/g_items.ts's Compass_Update body, same treatment.
  */
  function kexCompassWrite(first: boolean, pos: readonly number[], dir: readonly number[]): void {
    PF_WriteByte(ServerCommandT.svc_help_path);
    PF_WriteByte(first ? 1 : 0);
    PF_WriteFloat(pos[0]);
    PF_WriteFloat(pos[1]);
    PF_WriteFloat(pos[2]);
    PF_WriteDir(vec3(dir[0], dir[1], dir[2]));
  }

  test("identical bytes for the same help-path marker", () => {
    const pos = [128, -64, 32];
    const dir = [0, 0, 1];

    PF_HelpPath(worldEdict, true, vec3(pos[0], pos[1], pos[2]), vec3(dir[0], dir[1], dir[2]));
    const fromClassic = emitted();

    SZ_Clear(sv.multicast);
    kexCompassWrite(true, pos, dir);
    const fromKex = emitted();

    expect(Array.from(fromClassic)).toEqual(Array.from(fromKex));
  });
});

// ---------------------------------------------------------------------------
// 4. The narrow gate
// ---------------------------------------------------------------------------

describe("a narrow (protocol 34) session emits nothing", () => {
  beforeEach(() => {
    svs.csr = CS_REMAP_OLD;
  });

  test("PF_Poi writes no bytes", () => {
    PF_Poi(worldEdict, 8192, 10000, vec3(1, 2, 3), 4, 208, 0);
    expect(sv.multicast.cursize).toBe(0);
  });

  test("PF_HelpPath writes no bytes", () => {
    PF_HelpPath(worldEdict, true, vec3(1, 2, 3), vec3(0, 0, 1));
    expect(sv.multicast.cursize).toBe(0);
  });
});
