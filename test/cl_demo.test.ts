// Loader-level tests for KEX demo playback (src/client/cl_demo.ts +
// src/client/cl_parse.ts's KEX-opcode dispatch extension), KEX demo
// playback unit (.orch/RESUME.md).
//
// Acceptance bar per the task brief: "loader-level: parse all messages
// without error." This suite synthesizes small, self-contained demo byte
// buffers (the `.dm2` length-prefixed container format -- see cl_demo.ts's
// own file header) covering the KEX-only opcode set added to
// CL_ParseServerMessage's dispatch, and asserts the whole buffer parses
// end to end with no thrown error, correct protocol/codec detection, and
// (where cheap to check) correct field extraction.
//
// No copyrighted retail content is used or committed here -- every byte is
// hand-constructed from the wire-format derivation in kexdemo.ts's own
// header (itself derived from reading q2proto's GPLv2 C source, not from
// any retail asset). See test/cl_demo_retail.test.ts for the SEPARATE,
// skip-if-absent check against the real vanilla-protocol attract-loop
// demos bundled in the retail baseq2/pak0.pak (never committed, read
// directly from the user's local retail install).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteFloat, MSG_WriteString, MSG_WriteDir, SizeBuf, SZ_Init } from "../src/qcommon/sizebuf";
import { vec3 } from "../src/shared/math";
import { cl, cls, clCvars, setRe } from "../src/client/client";
import { KEX_DEMO_CODEC, PROTOCOL_KEX_DEMOS } from "../src/qcommon/protocol/kexdemo";
import { CL_PlayDemoFromBuffer, CL_OpenDemoBuffer, CL_ReadDemoMessage } from "../src/client/cl_demo";
import { net_message, net_message_buffer } from "../src/qcommon/net_chan";

beforeEach(() => {
  cl.clear();
  cls.clear();
  clCvars.cl_shownet = null;
  clCvars.cl_predict = null;
  clCvars.cl_noskins = null;
  clCvars.cl_vwep = null;
  clCvars.cl_gun = null;
  clCvars.cl_timedemo = null;
  clCvars.cl_showclamp = null;
  setRe(null);
});

afterEach(() => {
  // rule 13: net_message (src/qcommon/net_chan.ts) is a process-wide
  // SizeBuf singleton -- CL_ReadDemoMessage (src/client/cl_demo.ts) calls
  // SZ_Init(net_message, block, block.length) on every demo message this
  // suite reads, repointing net_message's `.data`/`.maxsize` at a tiny
  // demo-block-sized buffer and never restoring the real, full-size
  // net_message_buffer afterward. Left alone, any later test file that
  // expects net_message to hold MAX_MSGLEN bytes (e.g.
  // test/net_chan_fragment.test.ts's NET_GetPacket calls) overflows
  // instead. Restore it here so this suite leaves no trace.
  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
});

/** Builds one `.dm2`-framed block (u32 LE length + raw bytes) from a
 *  callback that writes into a scratch SizeBuf, matching CL_WriteDemoMessage's
 *  own write-side framing (cl_main.ts) exactly. */
function block(fn: (msg: SizeBuf) => void): Uint8Array {
  const msg = new SizeBuf();
  SZ_Init(msg, new Uint8Array(4096), 4096);
  fn(msg);
  const body = msg.data.subarray(0, msg.cursize);
  const framed = new Uint8Array(4 + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, true);
  framed.set(body, 4);
  return framed;
}

const EOF_SENTINEL = new Uint8Array(4);
new DataView(EOF_SENTINEL.buffer).setUint32(0, 0xffffffff, true);

function concat(blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

function writeServerdataBlock(msg: SizeBuf, protocol: number): void {
  MSG_WriteByte(msg, 12); // svc_serverdata opcode (SvcOpsT.svc_serverdata === ServerCommandT.svc_serverdata === 12)
  MSG_WriteLong(msg, protocol);
  MSG_WriteLong(msg, 1); // servercount
  MSG_WriteByte(msg, 0); // attractloop
  MSG_WriteByte(msg, 10); // server_fps (discarded)
  MSG_WriteString(msg, "baseq2"); // gamedir
  MSG_WriteShort(msg, 0); // clientnum
  MSG_WriteString(msg, "q2dm1"); // levelname
}

describe("CL_PlayDemoFromBuffer -- KEX demo container + protocol detection", () => {
  test("detects protocol 2022 (PROTOCOL_KEX_DEMOS) from the first svc_serverdata and selects KEX_DEMO_CODEC", () => {
    const handshake = block((msg) => writeServerdataBlock(msg, PROTOCOL_KEX_DEMOS));
    const data = concat([handshake, EOF_SENTINEL]);

    expect(() => CL_PlayDemoFromBuffer(data)).not.toThrow();

    expect(cls.serverProtocol).toBe(PROTOCOL_KEX_DEMOS);
    expect(cls.codec).toBe(KEX_DEMO_CODEC);
    expect(cl.servercount).toBe(1);
    expect(cl.gamedir).toBe("baseq2");
    expect(cls.demoplayback).toBe(false); // restored after the pump finishes
  });

  test("parses every KEX-only auxiliary opcode added to CL_ParseServerMessage's dispatch without error", () => {
    const handshake = block((msg) => writeServerdataBlock(msg, PROTOCOL_KEX_DEMOS));

    const aux = block((msg) => {
      // svc_splitclient (21)
      MSG_WriteByte(msg, 21);
      MSG_WriteByte(msg, 0); // isplit

      // svc_damage (25)
      MSG_WriteByte(msg, 25);
      MSG_WriteByte(msg, 1); // count
      MSG_WriteByte(msg, 5); // encoded
      MSG_WriteDir(msg, vec3(1, 0, 0));

      // svc_locprint (26)
      MSG_WriteByte(msg, 26);
      MSG_WriteByte(msg, 0); // flags
      MSG_WriteString(msg, "$g_test");
      MSG_WriteByte(msg, 0); // num_args

      // svc_fog (27)
      MSG_WriteByte(msg, 27);
      MSG_WriteByte(msg, 0); // bits=0 -> no further fields

      // svc_poi (30)
      MSG_WriteByte(msg, 30);
      MSG_WriteShort(msg, 1); // key
      MSG_WriteShort(msg, 2); // time
      MSG_WriteFloat(msg, 0);
      MSG_WriteFloat(msg, 0);
      MSG_WriteFloat(msg, 0);
      MSG_WriteShort(msg, 3); // image
      MSG_WriteByte(msg, 4); // color
      MSG_WriteByte(msg, 0); // flags

      // svc_help_path (31)
      MSG_WriteByte(msg, 31);
      MSG_WriteByte(msg, 1); // start
      MSG_WriteFloat(msg, 0);
      MSG_WriteFloat(msg, 0);
      MSG_WriteFloat(msg, 0);
      MSG_WriteDir(msg, vec3(0, 0, 1));

      // svc_muzzleflash3 (32)
      MSG_WriteByte(msg, 32);
      MSG_WriteShort(msg, 7); // entity
      MSG_WriteShort(msg, 3); // weapon

      // svc_achievement (33)
      MSG_WriteByte(msg, 33);
      MSG_WriteString(msg, "ACH_TEST");

      // svc_print (10) -- a "common" opcode already shared with vanilla,
      // included to prove the pre-existing dispatch keeps working alongside
      // the new KEX cases.
      MSG_WriteByte(msg, 10);
      MSG_WriteByte(msg, 0); // print level
      MSG_WriteString(msg, "hello from a KEX demo\n");

      // svc_nop (6)
      MSG_WriteByte(msg, 6);
    });

    const data = concat([handshake, aux, EOF_SENTINEL]);

    expect(() => CL_PlayDemoFromBuffer(data)).not.toThrow();
    expect(cls.demoplayback).toBe(false);
  });

  test("truncated demo (length prefix promises more bytes than exist) throws rather than silently misreading", () => {
    const bogus = new Uint8Array(4);
    new DataView(bogus.buffer).setUint32(0, 1000, true); // claims 1000 bytes, buffer has none
    const reader = CL_OpenDemoBuffer(bogus);
    expect(() => CL_ReadDemoMessage(reader)).toThrow();
  });

  test("CL_ReadDemoMessage returns false at a clean EOF sentinel", () => {
    const reader = CL_OpenDemoBuffer(EOF_SENTINEL);
    expect(CL_ReadDemoMessage(reader)).toBe(false);
  });
});
