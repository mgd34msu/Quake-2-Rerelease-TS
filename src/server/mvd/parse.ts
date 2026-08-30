// server/mvd/parse.c -- MVD_ParseMessage: decode one MVD stream message body
// (either the initial gamestate dump or a subsequent delta frame) into an
// MvdChannelT's state.
//
// Mirrors sv_mvd.ts's emit_gamestate/emit_frame writer exactly (same file,
// see its header for the full field-by-field citation); this is the read
// side of that same wire format. Reads through qcommon/net_chan.ts's shared
// `net_message` singleton buffer via VANILLA_CODEC's entity ops, matching
// how every other reader in this engine (cl_ents.ts, cl_parse.ts) consumes
// codec.ts's read ops -- see codec.ts's "Signature asymmetry" doc comment.
//
// LEGACY FAMILY ONLY -- see qcommon/protocol/mvd.ts's header for the kex gap.

import { SZ_Init, MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadString, MSG_ReadData } from "../../qcommon/sizebuf";
import { net_message } from "../../qcommon/net_chan";
import { U_REMOVE } from "../../qcommon/qcommon";
import { VANILLA_CODEC } from "../../qcommon/protocol/vanilla";
import { EntityStateT, MAX_EDICTS } from "../../shared/q_shared";
import {
  MVD_MAGIC,
  mvd_serverdata,
  mvd_frame,
  SVCMD_MASK,
  PROTOCOL_VERSION_MVD,
  PROTOCOL_VERSION_MVD_DEFAULT,
  CLIENTNUM_NONE,
  MSG_ReadDeltaMvdPlayerstateBody,
} from "../../qcommon/protocol/mvd";
import { MvdChannelT, MvdChannelStateT, MVD_ClearState } from "./client";

const NULL_ENTITY_STATE = new EntityStateT();

function readPlayersSection(channel: MvdChannelT): void {
  for (;;) {
    const number = MSG_ReadByte(net_message);
    if (number === CLIENTNUM_NONE) break;
    if (number < 0 || number >= channel.players.length) {
      throw new Error(`MVD_ParseMessage: bad player number ${number}`);
    }

    const from = channel.players[number];
    const result = MSG_ReadDeltaMvdPlayerstateBody(net_message, from, number);
    channel.players[number] = result.removed ? null : result.ps;
  }
}

function cloneEntityState(from: EntityStateT): EntityStateT {
  const to = new EntityStateT();
  to.number = from.number;
  to.origin.set(from.origin);
  to.angles.set(from.angles);
  to.old_origin.set(from.old_origin);
  to.modelindex = from.modelindex;
  to.modelindex2 = from.modelindex2;
  to.modelindex3 = from.modelindex3;
  to.modelindex4 = from.modelindex4;
  to.frame = from.frame;
  to.skinnum = from.skinnum;
  to.effects = from.effects;
  to.renderfx = from.renderfx;
  to.solid = from.solid;
  to.sound = from.sound;
  to.event = 0; // event is never delta-preserved (matches CL_ParseDelta)
  return to;
}

function readEntitiesSection(channel: MvdChannelT): void {
  for (;;) {
    const { number, bits } = VANILLA_CODEC.readEntityBits();
    if (number === 0) break;
    if (number < 0 || number >= MAX_EDICTS) {
      throw new Error(`MVD_ParseMessage: bad entity number ${number}`);
    }

    if (bits & U_REMOVE) {
      channel.entities[number] = null;
      continue;
    }

    const from = channel.entities[number] ?? NULL_ENTITY_STATE;
    const to = cloneEntityState(from);

    VANILLA_CODEC.readDeltaEntity(from, to, number, bits);
    to.number = number;
    channel.entities[number] = to;
  }
}

// Parses the initial gamestate message (mvd_serverdata + configstrings +
// baseline frame). Throws on malformed/unsupported input rather than
// dropping silently -- this is a from-scratch parser with no legacy
// "tolerate garbage demos" requirement.
function parseGamestate(channel: MvdChannelT): void {
  const cmd = MSG_ReadByte(net_message);
  if ((cmd & SVCMD_MASK) !== mvd_serverdata) {
    throw new Error(`MVD_ParseMessage: expected mvd_serverdata, got ${cmd}`);
  }

  const protocol = MSG_ReadLong(net_message);
  if (protocol !== PROTOCOL_VERSION_MVD) {
    throw new Error(`MVD_ParseMessage: bad MVD protocol ${protocol}`);
  }

  const version = MSG_ReadShort(net_message);
  if (version !== PROTOCOL_VERSION_MVD_DEFAULT) {
    throw new Error(`MVD_ParseMessage: unsupported MVD sub-version ${version} (kex/rerelease MVD is not ported -- see qcommon/protocol/mvd.ts)`);
  }

  channel.servercount = MSG_ReadLong(net_message);
  channel.gamedir = MSG_ReadString(net_message);
  channel.clientNum = MSG_ReadShort(net_message);

  for (;;) {
    const idx = MSG_ReadShort(net_message);
    if (idx >= channel.csr.end) break;
    channel.configstrings[idx] = MSG_ReadString(net_message);
  }

  const portalbytes = MSG_ReadByte(net_message);
  const portalbits = new Uint8Array(portalbytes);
  MSG_ReadData(net_message, portalbits, portalbytes);
  channel.portalbits = portalbits;

  readPlayersSection(channel);
  readEntitiesSection(channel);

  channel.state = MvdChannelStateT.MVD_READING;
}

function parseFrame(channel: MvdChannelT): void {
  const cmd = MSG_ReadByte(net_message);
  if (cmd !== mvd_frame) {
    throw new Error(`MVD_ParseMessage: expected mvd_frame, got ${cmd}`);
  }

  const portalbytes = MSG_ReadByte(net_message);
  const portalbits = new Uint8Array(portalbytes);
  MSG_ReadData(net_message, portalbits, portalbytes);
  channel.portalbits = portalbits;

  readPlayersSection(channel);
  readEntitiesSection(channel);

  channel.framenum++;
}

/*
==============
MVD_ParseMessage

Parses one complete MVD message body (everything between a stream's length
prefix and the next one). `channel.state === MVD_DEAD` means no gamestate
has been seen yet, so the FIRST message this function is ever given for a
channel is always parsed as a gamestate; every subsequent call parses a
delta frame. Matches src/server/mvd/parse.c's MVD_ParseMessage dispatch
(real source keys off the leading opcode byte the same way; this port keys
off channel.state instead since the only two message shapes it ever
produces -- emit_gamestate's mvd_serverdata and emit_frame's mvd_frame --
are exactly the ones the real opcode byte already distinguishes, and our
scoped recorder never emits anything else, e.g. no periodic re-gamestate).
==============
*/
export function MVD_ParseMessage(channel: MvdChannelT, data: Uint8Array): void {
  SZ_Init(net_message, data, data.length);
  net_message.cursize = data.length;
  MSG_BeginReading(net_message);

  if (channel.state === MvdChannelStateT.MVD_DEAD) {
    parseGamestate(channel);
  } else {
    parseFrame(channel);
  }
}

/*
==============
MVD_LoadFile

Reads a whole .mvd2 buffer (magic + framed messages + zero-length EOF
marker) into a fresh channel. Mirrors sv_mvd.ts's rec_start/rec_frame/
rec_stop framing on the read side: 4-byte magic, then repeated
[u16 LE length][length bytes] records, terminated by a length-0 record.
==============
*/
export function MVD_LoadFile(bytes: Uint8Array): MvdChannelT {
  const channel = new MvdChannelT();
  MVD_ClearState(channel);

  if (bytes.length < 4) {
    throw new Error("MVD_LoadFile: file too short for magic");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== MVD_MAGIC) {
    throw new Error("MVD_LoadFile: not a MVD2 file");
  }

  let offset = 4;
  for (;;) {
    if (offset + 2 > bytes.length) {
      throw new Error("MVD_LoadFile: truncated length prefix");
    }
    const msglen = view.getUint16(offset, true);
    offset += 2;
    if (msglen === 0) break; // EOF marker
    if (offset + msglen > bytes.length) {
      throw new Error("MVD_LoadFile: truncated message body");
    }
    const body = bytes.subarray(offset, offset + msglen);
    offset += msglen;
    MVD_ParseMessage(channel, body);
  }

  return channel;
}
