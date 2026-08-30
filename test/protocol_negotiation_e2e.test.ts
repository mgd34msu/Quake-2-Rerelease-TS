// v1.0.0 wire cluster (task board #23) E2E gate: a real connectionless-packet
// loopback client-server pair (server_core.test.ts's SVC_GetChallenge
// precedent -- real NET_SendPacket/NET_GetPacket over the NA_LOOPBACK
// address, not a hand-fabricated buffer) drives sv_main.ts's SVC_DirectConnect
// through a genuine "connect 35 ..." / "connect 36 ..." handshake, then
// asserts the negotiated per-client codec (server.ts's ClientT.codec) and
// svc_zpacket eligibility (qcommon/net_chan.ts's NetchanT.compress) land
// correctly -- and finally proves that exact negotiated codec instance
// round-trips a real SV_WriteFrameToClient frame (protocol_frame_envelope.
// test.ts's fabricated-client harness precedent), closing the loop from
// "client sent a connect string" all the way to "codec produces correct
// wire bytes for THIS connection".

import { describe, test, expect } from "bun:test";
import { sv, svs, ServerStateT, ClientStateT, ClientT, maxclients } from "../src/server/server";
import { SV_Init, SV_ConnectionlessPacket } from "../src/server/sv_main";
import { SV_WriteFrameToClient } from "../src/server/sv_ents";
import { geHolder } from "../src/server/sv_game";
import { NetadrT, NetadrtypeT, NetsrcT, UPDATE_MASK, PROTOCOL_VERSION_R1Q2_CURRENT, PROTOCOL_VERSION_Q2PRO_SERVER_STATE } from "../src/qcommon/qcommon";
import { net_from, net_message } from "../src/qcommon/net_chan";
import { NET_ClearLoopback, NET_SendPacket, NET_GetPacket } from "../src/platform/net_udp";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_BeginReading, MSG_ReadLong, MSG_ReadByte } from "../src/qcommon/sizebuf";
import { Cvar_FullSet } from "../src/qcommon/cvar";
import { CVAR_LATCH, CVAR_SERVERINFO, EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import { LinkT, SolidT, MAX_ENT_CLUSTERS, type Edict, type GameExports } from "../src/game/game";
import { CS_REMAP_OLD } from "../src/shared/cs_remap";
import { setR1Q2FrameExtrabits } from "../src/qcommon/protocol/r1q2";
import { noteQ2ProFrameOpcodeExtrabits } from "../src/qcommon/protocol/q2pro";

// ---- fixtures (self-sufficient per .orch/preferences.md rule 13 -- copies
// of server_core.test.ts's own private fixtures, not imports, since that
// file exports none of them) --------------------------------------------

function loopbackAdr(): NetadrT {
  const a = new NetadrT();
  a.type = NetadrtypeT.NA_LOOPBACK;
  return a;
}

function makeEdict(client: unknown = null): Edict {
  return {
    s: new EntityStateT(),
    client,
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

function makeFakeGameExports(): GameExports {
  return {
    apiversion: 3,
    Init() {},
    Shutdown() {},
    SpawnEntities() {},
    WriteGame() {},
    ReadGame() {},
    WriteLevel() {},
    ReadLevel() {},
    ClientConnect(_ent: Edict, userinfo: string) {
      return { allowed: true, userinfo };
    },
    ClientBegin() {},
    ClientUserinfoChanged() {},
    ClientDisconnect() {},
    ClientCommand() {},
    ClientThink() {},
    RunFrame() {},
    ServerCommand() {},
    edicts: [makeEdict(), makeEdict()],
    num_edicts: 2,
    max_edicts: 2,
  };
}

// Drives one full connect handshake over the real loopback path and returns
// the resulting ClientT. `tail` is the protocol-specific trailing tokens
// cl_main.ts's CL_SendConnectPacket appends after the four standard connect
// fields (empty for plain protocol 34, present for R1Q2/Q2PRO -- see that
// file's own comment for the exact token grammar this mirrors).
function driveConnect(protocol: number, tail: string): ClientT {
  NET_ClearLoopback();
  const adr = loopbackAdr();

  // ---- getchallenge ------------------------------------------------------
  const challengeText = "getchallenge";
  const challengeBytes = new Uint8Array(4 + challengeText.length);
  challengeBytes.set([0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < challengeText.length; i++) challengeBytes[4 + i] = challengeText.charCodeAt(i);
  NET_SendPacket(NetsrcT.NS_CLIENT, challengeBytes.length, challengeBytes, adr);
  expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
  SV_ConnectionlessPacket();

  const replyFrom = new NetadrT();
  expect(NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message)).toBe(true);
  MSG_BeginReading(net_message);
  MSG_ReadLong(net_message);
  const challengeReply = new TextDecoder().decode(net_message.data.slice(net_message.readcount, net_message.cursize));
  const challenge = Number.parseInt(challengeReply.slice("challenge ".length), 10);
  expect(Number.isNaN(challenge)).toBe(false);

  // ---- connect -------------------------------------------------------------
  const connectText = `connect ${protocol} 3000 ${challenge} "\\name\\Tester"${tail}`;
  const connectBytes = new Uint8Array(4 + connectText.length);
  connectBytes.set([0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < connectText.length; i++) connectBytes[4 + i] = connectText.charCodeAt(i);
  NET_SendPacket(NetsrcT.NS_CLIENT, connectBytes.length, connectBytes, adr);
  expect(NET_GetPacket(NetsrcT.NS_SERVER, net_from, net_message)).toBe(true);
  SV_ConnectionlessPacket();

  // drain the "client_connect" reply so it doesn't leak into the next
  // iteration's loopback ring
  const drained = NET_GetPacket(NetsrcT.NS_CLIENT, replyFrom, net_message);
  expect(drained).toBe(true);

  const connected = svs.clients.find((c) => c.state === ClientStateT.cs_connected);
  if (!connected) throw new Error("SVC_DirectConnect did not produce a connected client");
  return connected;
}

function setupServer(): void {
  Cvar_FullSet("maxclients", "1", CVAR_SERVERINFO | CVAR_LATCH);
  sv.state = ServerStateT.ss_dead;
  svs.initialized = false;
  SV_Init();
  if (!maxclients) throw new Error("maxclients not initialized");
  maxclients.value = 1;
  svs.csr = CS_REMAP_OLD; // legacy family -- accepts 34/35/36 (kex family only ever accepts 1038)
  svs.clients = [new ClientT()];
  geHolder.ge = makeFakeGameExports();
}

describe("v1.0.0 wire cluster E2E: connect negotiation -> per-client codec -> frame round-trip", () => {
  test("protocol 35 (R1Q2): negotiates R1Q2_CODEC at the requested minor version, unconditional zpacket eligibility", () => {
    setupServer();
    const client = driveConnect(35, ` 1400 ${PROTOCOL_VERSION_R1Q2_CURRENT}`);

    expect(client.codec.name).toBe("r1q2");
    expect(client.protocolMinorVersion).toBe(PROTOCOL_VERSION_R1Q2_CURRENT);
    // R1Q2 supports svc_r1q2_zpacket unconditionally (q2proto_proto_r1q2.c:39)
    expect(client.netchan.compress).toBe(true);

    // ---- frame round-trip through the negotiated codec instance ----------
    svs.num_client_entities = 4;
    svs.client_entities = Array.from({ length: 4 }, () => new EntityStateT());
    sv.framenum = 1;
    const frame = client.frames[sv.framenum & UPDATE_MASK];
    frame.ps = new PlayerStateT();
    frame.ps.pmove.origin.set([64, 0, 0]);
    frame.areabytes = 0;
    frame.num_entities = 1;
    frame.first_entity = 0;
    const ent = new EntityStateT();
    ent.number = 5;
    ent.origin.set([32, 0, 0]);
    svs.client_entities[0] = ent;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(4096), 4096);
    SV_WriteFrameToClient(client, msg);

    // Load the written frame into the net_message singleton the way a real
    // received packet would (protocol_frame_envelope.test.ts's
    // loadIntoNetMessage precedent): every client-side codec read op in this
    // seam reads from net_message, not an explicit buffer.
    SZ_Clear(net_message);
    SZ_Write(net_message, msg.data, msg.cursize);
    MSG_BeginReading(net_message);

    const opcode = MSG_ReadByte(net_message);
    setR1Q2FrameExtrabits(opcode & 0xe0);
    const header = client.codec.readFrameHeader(new Uint8Array(32), true);
    expect(header.serverframe).toBe(1);
    expect(header.deltaframe).toBe(-1); // fresh client, no delta source -> nodelta

    const psOut = new PlayerStateT();
    client.codec.readFramePlayerstate(new PlayerStateT(), psOut);
    expect(Array.from(psOut.pmove.origin)).toEqual([64, 0, 0]);

    client.codec.readPacketEntitiesBegin();
    const e = client.codec.readEntityBits();
    expect(e.number).toBe(5);
    const entOut = new EntityStateT();
    client.codec.readDeltaEntity(new EntityStateT(), entOut, e.number, e.bits);
    expect(Array.from(entOut.origin)).toEqual([32, 0, 0]);
    expect(client.codec.readEntityBits().number).toBe(0); // terminator
  });

  test("protocol 36 (Q2PRO): negotiates Q2PRO_CODEC, zpacket eligibility follows the connect string's has_zlib token", () => {
    setupServer();
    const client = driveConnect(36, ` 1400 0 1 ${PROTOCOL_VERSION_Q2PRO_SERVER_STATE}`);

    expect(client.codec.name).toBe("q2pro");
    expect(client.protocolMinorVersion).toBe(PROTOCOL_VERSION_Q2PRO_SERVER_STATE);
    expect(client.netchan.compress).toBe(true); // has_zlib=1 in the connect tail above

    // ---- frame round-trip through the negotiated codec instance ----------
    svs.num_client_entities = 4;
    svs.client_entities = Array.from({ length: 4 }, () => new EntityStateT());
    sv.framenum = 1;
    const frame = client.frames[sv.framenum & UPDATE_MASK];
    frame.ps = new PlayerStateT();
    frame.ps.pmove.origin.set([96, 0, 0]);
    frame.areabytes = 0;
    frame.num_entities = 1;
    frame.first_entity = 0;
    const ent = new EntityStateT();
    ent.number = 6;
    ent.origin.set([48, 0, 0]);
    ent.solid = 1234; // Q2PRO always writes a u32-packed solid, unconditionally
    svs.client_entities[0] = ent;

    const msg = new SizeBuf();
    SZ_Init(msg, new Uint8Array(4096), 4096);
    SV_WriteFrameToClient(client, msg);

    // Load the written frame into the net_message singleton the way a real
    // received packet would (protocol_frame_envelope.test.ts's
    // loadIntoNetMessage precedent): every client-side codec read op in this
    // seam reads from net_message, not an explicit buffer.
    SZ_Clear(net_message);
    SZ_Write(net_message, msg.data, msg.cursize);
    MSG_BeginReading(net_message);

    const opcode = MSG_ReadByte(net_message);
    noteQ2ProFrameOpcodeExtrabits(opcode & 0xe0);
    const header = client.codec.readFrameHeader(new Uint8Array(32), true);
    expect(header.serverframe).toBe(1);
    expect(header.deltaframe).toBe(-1);

    const psOut = new PlayerStateT();
    client.codec.readFramePlayerstate(new PlayerStateT(), psOut);
    expect(Array.from(psOut.pmove.origin)).toEqual([96, 0, 0]);

    client.codec.readPacketEntitiesBegin();
    const e = client.codec.readEntityBits();
    expect(e.number).toBe(6);
    const entOut = new EntityStateT();
    client.codec.readDeltaEntity(new EntityStateT(), entOut, e.number, e.bits);
    expect(Array.from(entOut.origin)).toEqual([48, 0, 0]);
    expect(entOut.solid).toBe(1234);
    expect(client.codec.readEntityBits().number).toBe(0); // terminator
  });

  test("protocol 34 (vanilla): unaffected by the R1Q2/Q2PRO negotiation -- still connects with VANILLA_CODEC", () => {
    setupServer();
    const client = driveConnect(34, "");
    expect(client.codec.name).toBe("vanilla");
    expect(client.protocolMinorVersion).toBe(0);
    expect(client.netchan.compress).toBe(false);
  });
});
