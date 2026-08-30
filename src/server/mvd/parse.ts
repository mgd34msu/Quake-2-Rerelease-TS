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
// Handles both the legacy (PROTOCOL_VERSION_MVD_DEFAULT) and kex/rerelease
// (PROTOCOL_VERSION_MVD_RERELEASE) player-state sub-formats -- see
// qcommon/protocol/mvd.ts's header for the field-by-field split and
// readPlayersSection below for the dispatch.

import { SZ_Init, MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadString, MSG_ReadData } from "../../qcommon/sizebuf";
import { net_message } from "../../qcommon/net_chan";
import { U_REMOVE } from "../../qcommon/qcommon";
import { VANILLA_CODEC } from "../../qcommon/protocol/vanilla";
import { EntityStateT, MAX_EDICTS } from "../../shared/q_shared";
import {
  MVD_MAGIC,
  mvd_serverdata,
  mvd_frame,
  mvd_nop,
  mvd_configstring,
  mvd_unicast,
  mvd_unicast_r,
  mvd_multicast_all,
  mvd_multicast_all_r,
  mvd_multicast_pvs_r,
  mvd_sound,
  mvd_print,
  SVCMD_MASK,
  PROTOCOL_VERSION_MVD,
  PROTOCOL_VERSION_MVD_DEFAULT,
  PROTOCOL_VERSION_MVD_RERELEASE,
  CLIENTNUM_NONE,
  MSG_ReadMvdCmd,
  MSG_ReadDeltaMvdPlayerstateBody,
  MSG_ReadDeltaMvdPlayerstateRereleaseBody,
} from "../../qcommon/protocol/mvd";
import { MvdChannelT, MvdChannelStateT, MVD_ClearState } from "./client";

const NULL_ENTITY_STATE = new EntityStateT();

function readPlayersSection(channel: MvdChannelT): void {
  const readBody = channel.rerelease ? MSG_ReadDeltaMvdPlayerstateRereleaseBody : MSG_ReadDeltaMvdPlayerstateBody;
  for (;;) {
    const number = MSG_ReadByte(net_message);
    if (number === CLIENTNUM_NONE) break;
    if (number < 0 || number >= channel.players.length) {
      throw new Error(`MVD_ParseMessage: bad player number ${number}`);
    }

    const from = channel.players[number];
    const result = readBody(net_message, from, number);
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
  if (version === PROTOCOL_VERSION_MVD_RERELEASE) {
    channel.rerelease = true;
  } else if (version === PROTOCOL_VERSION_MVD_DEFAULT) {
    channel.rerelease = false;
  } else {
    throw new Error(`MVD_ParseMessage: unsupported MVD sub-version ${version}`);
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

// The mvd_frame op byte itself is already consumed by MVD_ParseMessage's
// dispatch loop below (MSG_ReadMvdCmd) before this is called -- unlike the
// old one-op-per-message design, this is no longer parseFrame's own job.
function parseFrame(channel: MvdChannelT): void {
  const portalbytes = MSG_ReadByte(net_message);
  const portalbits = new Uint8Array(portalbytes);
  MSG_ReadData(net_message, portalbits, portalbytes);
  channel.portalbits = portalbits;

  readPlayersSection(channel);
  readEntitiesSection(channel);

  channel.framenum++;
}

// mvd.c's filter_unicast_data/MVD_ParseMulticast/MVD_ParseUnicast/
// MVD_ParseSound/MVD_ParsePrint/MVD_ParseConfigstring, collapsed to their
// "record what happened" essentials: this channel has no live spectator
// sockets to fan these back out to (see this file's own header and
// client.ts's), so each segment reader's only job is (a) advance
// net_message.readcount past exactly the bytes SV_Mvd{Multicast,Unicast,
// StartSound,BroadcastPrint} wrote, and (b) push an MvdEventT so tests (and
// any future consumer) can observe that the hook's bytes actually arrived.

function readMulticastSegment(channel: MvdChannelT, base: number, reliable: boolean, extrabits: number): void {
  const lengthLow = MSG_ReadByte(net_message);
  const length = ((extrabits & 7) << 8) | lengthLow;
  let leafnum = 0;
  if (base !== 0) leafnum = MSG_ReadShort(net_message);
  MSG_ReadData(net_message, new Uint8Array(length), length);
  channel.events.push({ kind: "multicast", base, reliable, leafnum, length });
}

function readUnicastSegment(channel: MvdChannelT, reliable: boolean, extrabits: number): void {
  const lengthLow = MSG_ReadByte(net_message);
  const length = ((extrabits & 7) << 8) | lengthLow;
  const clientNum = MSG_ReadByte(net_message);
  MSG_ReadData(net_message, new Uint8Array(length), length);
  channel.events.push({ kind: "unicast", reliable, clientNum, length });
}

function readSoundSegment(channel: MvdChannelT, extrabits: number): void {
  // Mirrors SV_MvdStartSound's write exactly (sv_mvd.ts): byte flags, then
  // (per those flags) byte soundindex/volume/attenuation/timeofs, then a
  // short sendchan -- no length prefix, since every field is self-describing
  // via `flags` the same way svc_sound itself is.
  const start = net_message.readcount;
  const flags = MSG_ReadByte(net_message);
  MSG_ReadByte(net_message); // soundindex
  if (flags & 0x01) MSG_ReadByte(net_message); // SND_VOLUME
  if (flags & 0x02) MSG_ReadByte(net_message); // SND_ATTENUATION
  if (flags & 0x10) MSG_ReadByte(net_message); // SND_OFFSET
  MSG_ReadShort(net_message); // sendchan
  channel.events.push({ kind: "sound", extrabits, length: net_message.readcount - start });
}

function readPrintSegment(channel: MvdChannelT): void {
  const level = MSG_ReadByte(net_message);
  const text = MSG_ReadString(net_message);
  channel.events.push({ kind: "print", level, text });
}

function readConfigstringSegment(channel: MvdChannelT): void {
  // Reserved on the write side (SV_MvdConfigstring is not wired -- see
  // sv_mvd.ts's header); kept here so a message carrying one is still
  // parsed correctly rather than tripping the "illegible command" throw.
  const index = MSG_ReadShort(net_message);
  const value = MSG_ReadString(net_message);
  if (index >= 0 && index < channel.configstrings.length) channel.configstrings[index] = value;
  channel.events.push({ kind: "configstring", index, value });
}

/*
==============
MVD_ParseMessage

Parses one complete MVD message body (everything between a stream's length
prefix and the next one). `channel.state === MVD_DEAD` means no gamestate
has been seen yet, so the FIRST message this function is ever given for a
channel is always parsed as a gamestate. Every subsequent message may carry
a mix of out-of-band segments (mvd_print, mvd_configstring, one of the
mvd_multicast_all/phs/pvs ops or their reliable variants, one of
mvd_unicast/mvd_unicast_r, mvd_sound -- each written by one of the SV_Mvd
hook functions in sv_mvd.ts) followed by exactly one mvd_frame segment --
this loop keeps reading ops until the message is exhausted, matching
src/server/mvd/parse.c's MVD_ParseMessage dispatch loop (parse.c:1066-1135)
now that this port's recorder emits that same mixed content (item 1 of the
MVD completion sweep), rather than assuming one bare mvd_frame op per
message the way this port originally did when only gamestate/frame existed.
==============
*/
export function MVD_ParseMessage(channel: MvdChannelT, data: Uint8Array): void {
  SZ_Init(net_message, data, data.length);
  net_message.cursize = data.length;
  MSG_BeginReading(net_message);

  if (channel.state === MvdChannelStateT.MVD_DEAD) {
    parseGamestate(channel);
  }

  while (net_message.readcount < net_message.cursize) {
    const { op, extrabits } = MSG_ReadMvdCmd(net_message);
    switch (op) {
      case mvd_frame:
        parseFrame(channel);
        break;
      case mvd_print:
        readPrintSegment(channel);
        break;
      case mvd_configstring:
        readConfigstringSegment(channel);
        break;
      case mvd_unicast:
        readUnicastSegment(channel, false, extrabits);
        break;
      case mvd_unicast_r:
        readUnicastSegment(channel, true, extrabits);
        break;
      case mvd_sound:
        readSoundSegment(channel, extrabits);
        break;
      case mvd_nop:
        break;
      default:
        if (op >= mvd_multicast_all && op <= mvd_multicast_all + 2) {
          readMulticastSegment(channel, op - mvd_multicast_all, false, extrabits);
        } else if (op >= mvd_multicast_all_r && op <= mvd_multicast_pvs_r) {
          readMulticastSegment(channel, op - mvd_multicast_all_r, true, extrabits);
        } else {
          throw new Error(`MVD_ParseMessage: illegible command ${op}`);
        }
    }
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
