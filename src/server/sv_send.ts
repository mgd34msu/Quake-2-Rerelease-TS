// sv_send.c -- server message sending

import { NetsrcT, NetadrtypeT, SysError, SvcOpsT, MAX_MSGLEN } from "../qcommon/qcommon";
import { Netchan_OutOfBandPrint, Netchan_Transmit, Netchan_TransmitNextFragment, net_from, PACKET_HEADER, NETCHAN_NEW, MAX_FRAGMENT_MSGLEN } from "../qcommon/net_chan";
import { SizeBuf, SZ_Init, SZ_Clear, SZ_Write, MSG_WriteByte, MSG_WriteShort, MSG_WriteString, MSG_WritePos } from "../qcommon/sizebuf";
import { Com_Printf, Com_Error, dedicated } from "../qcommon/common";
import { FS_ReadRaw, FS_FCloseFile, FS_Read } from "../qcommon/files";
import { curtime } from "../platform/sys";
import { CM_PointLeafnum, CM_LeafArea, CM_LeafCluster, CM_ClusterPHS, CM_ClusterPVS, CM_AreasConnected } from "../qcommon/cmodel";
import { Com_sprintf, ERR_FATAL, ERR_DROP, PRINT_HIGH, MulticastT, CHAN_RELIABLE, ATTN_NONE } from "../shared/q_shared";
import { type Vec3, vec3, VectorCopy } from "../shared/math";
import { SolidT, SVF_NOCLIENT, type Edict } from "../game/game";
import { sv, svs, ServerStateT, ClientStateT, RedirectT, type ClientT, svClientHolder, RATE_MESSAGES, sv_paused } from "./server";
import { SV_DropClient } from "./sv_main";
import { SV_BuildClientFrame, SV_WriteFrameToClient } from "./sv_ents";
import { SV_Nextserver } from "./sv_user";
import { SV_MvdBroadcastPrint, SV_MvdMulticast, SV_MvdStartSound } from "./sv_mvd";

// qcommon.h's SND_*/DEFAULT_SOUND_PACKET_* constants are not yet ported to
// qcommon.ts (that module's own brief only ports the pieces its landed
// callers needed; sv_send.c is the first consumer of these). qcommon.ts is
// outside this unit's SCOPE, so they are defined locally here instead --
// report for qcommon.ts's owner to relocate.
// Exported: sv_game.ts's PF_LocalSound (game.c's gi.local_sound, the
// [Paril-KEX] per-target sound import) needs the same flag bits and
// defaults to build an equivalent svc_sound payload without going through
// SV_Multicast -- see that function's own header for why it cannot just
// call SV_StartSound.
export const SND_VOLUME = 1 << 0; // a byte
export const SND_ATTENUATION = 1 << 1; // a byte
export const SND_POS = 1 << 2; // three coordinates
export const SND_ENT = 1 << 3; // a short 0-2: channel, 3-12: entity
export const SND_OFFSET = 1 << 4; // a byte, msec offset from frame start
export const DEFAULT_SOUND_PACKET_VOLUME = 1.0;
export const DEFAULT_SOUND_PACKET_ATTENUATION = 1.0;

function requireSvClient(): ClientT {
  const cl = svClientHolder.sv_client;
  if (!cl) throw new SysError("sv_send: sv_client used before being set");
  return cl;
}

/*
=============================================================================

Com_Printf redirection

=============================================================================
*/

export function SV_FlushRedirect(sv_redirected: number, outputbuf: string): void {
  if (sv_redirected === RedirectT.RD_PACKET) {
    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, net_from, "print\n%s", outputbuf);
  } else if (sv_redirected === RedirectT.RD_CLIENT) {
    const cl = requireSvClient();
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_print);
    MSG_WriteByte(cl.netchan.message, PRINT_HIGH);
    MSG_WriteString(cl.netchan.message, outputbuf);
  }
}

/*
=============================================================================

EVENT MESSAGES

=============================================================================
*/

// Sends text across to be displayed if the level passes
export function SV_ClientPrintf(cl: ClientT, level: number, fmt: string, ...args: Array<string | number>): void {
  if (level < cl.messagelevel) return;

  const string = Com_sprintf(fmt, ...args);

  MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_print);
  MSG_WriteByte(cl.netchan.message, level);
  MSG_WriteString(cl.netchan.message, string);
}

// Sends text to all active clients
export function SV_BroadcastPrintf(level: number, fmt: string, ...args: Array<string | number>): void {
  const string = Com_sprintf(fmt, ...args);

  // mvd.c's SV_MvdBroadcastPrint hook (see sv_mvd.ts's header for scope)
  SV_MvdBroadcastPrint(level, string);

  // echo to console
  if (dedicated && dedicated.value) {
    // mask off high bits
    let copy = "";
    for (let i = 0; i < 1023 && i < string.length; i++) {
      copy += String.fromCharCode(string.charCodeAt(i) & 127);
    }
    Com_Printf("%s", copy);
  }

  for (const cl of svs.clients) {
    if (level < cl.messagelevel) continue;
    if (cl.state !== ClientStateT.cs_spawned) continue;
    MSG_WriteByte(cl.netchan.message, SvcOpsT.svc_print);
    MSG_WriteByte(cl.netchan.message, level);
    MSG_WriteString(cl.netchan.message, string);
  }
}

// Sends text to all active clients
export function SV_BroadcastCommand(fmt: string, ...args: Array<string | number>): void {
  if (!sv.state) return;
  const string = Com_sprintf(fmt, ...args);

  MSG_WriteByte(sv.multicast, SvcOpsT.svc_stufftext);
  MSG_WriteString(sv.multicast, string);
  SV_Multicast(null, MulticastT.MULTICAST_ALL_R);
}

/*
=================
SV_Multicast

Sends the contents of sv.multicast to a subset of the clients,
then clears sv.multicast.

MULTICAST_ALL	same as broadcast (origin can be NULL)
MULTICAST_PVS	send to clients potentially visible from org
MULTICAST_PHS	send to clients potentially hearable from org
=================
*/
export function SV_Multicast(origin: Vec3 | null, to: MulticastT): void {
  let reliable = false;
  let leafnum = 0;
  let area1 = 0;

  if (to !== MulticastT.MULTICAST_ALL_R && to !== MulticastT.MULTICAST_ALL) {
    if (!origin) throw new SysError("SV_Multicast: null origin for a non-ALL multicast");
    leafnum = CM_PointLeafnum(origin);
    area1 = CM_LeafArea(leafnum);
  }

  // if doing a serverrecord, store everything
  if (svs.demofile !== null) {
    SZ_Write(svs.demo_multicast, sv.multicast.data, sv.multicast.cursize);
  }

  let mask: Uint8Array | null;
  let cluster = 0;

  switch (to) {
    case MulticastT.MULTICAST_ALL_R:
      reliable = true; // intentional fallthrough
    case MulticastT.MULTICAST_ALL:
      leafnum = 0;
      mask = null;
      break;

    case MulticastT.MULTICAST_PHS_R:
      reliable = true; // intentional fallthrough
    case MulticastT.MULTICAST_PHS:
      if (!origin) throw new SysError("SV_Multicast: null origin for MULTICAST_PHS");
      leafnum = CM_PointLeafnum(origin);
      cluster = CM_LeafCluster(leafnum);
      mask = CM_ClusterPHS(cluster);
      break;

    case MulticastT.MULTICAST_PVS_R:
      reliable = true; // intentional fallthrough
    case MulticastT.MULTICAST_PVS:
      if (!origin) throw new SysError("SV_Multicast: null origin for MULTICAST_PVS");
      leafnum = CM_PointLeafnum(origin);
      cluster = CM_LeafCluster(leafnum);
      mask = CM_ClusterPVS(cluster);
      break;

    default:
      mask = null;
      Com_Error(ERR_FATAL, "SV_Multicast: bad to:%i", to);
  }

  // send the data to all relevent clients
  for (const client of svs.clients) {
    if (client.state === ClientStateT.cs_free || client.state === ClientStateT.cs_zombie) continue;
    if (client.state !== ClientStateT.cs_spawned && !reliable) continue;

    if (mask) {
      if (!client.edict) continue;
      leafnum = CM_PointLeafnum(client.edict.s.origin);
      cluster = CM_LeafCluster(leafnum);
      const area2 = CM_LeafArea(leafnum);
      if (!CM_AreasConnected(area1, area2)) continue;
      if (!(mask[cluster >> 3] & (1 << (cluster & 7)))) continue;
    }

    if (reliable) SZ_Write(client.netchan.message, sv.multicast.data, sv.multicast.cursize);
    else SZ_Write(client.datagram, sv.multicast.data, sv.multicast.cursize);
  }

  // mvd.c:311: "add to MVD datagram" -- called with the same payload just
  // fanned out to real clients, before the buffer is cleared below.
  SV_MvdMulticast(leafnum, to, sv.multicast.data.subarray(0, sv.multicast.cursize));

  SZ_Clear(sv.multicast);
}

/*
==================
SV_StartSound

Each entity can have eight independant sound sources, like voice,
weapon, feet, etc.

If cahnnel & 8, the sound will be sent to everyone, not just
things in the PHS.

FIXME: if entity isn't in PHS, they must be forced to be sent or
have the origin explicitly sent.

Channel 0 is an auto-allocate channel, the others override anything
already running on that entity/channel pair.

An attenuation of 0 will play full volume everywhere in the level.
Larger attenuations will drop off.  (max 4 attenuation)

Timeofs can range from 0.0 to 0.1 to cause sounds to be started
later in the frame than they normally would.

If origin is NULL, the origin is determined from the entity origin
or the midpoint of the entity box for bmodels.
==================
*/
export function SV_StartSound(origin: Vec3 | null, entity: Edict, channel: number, soundindex: number, volume: number, attenuation: number, timeofs: number): void {
  if (volume < 0 || volume > 1.0) Com_Error(ERR_FATAL, "SV_StartSound: volume = %f", volume);
  if (attenuation < 0 || attenuation > 4) Com_Error(ERR_FATAL, "SV_StartSound: attenuation = %f", attenuation);
  if (timeofs < 0 || timeofs > 0.255) Com_Error(ERR_FATAL, "SV_StartSound: timeofs = %f", timeofs);

  const ent = entity.s.number; // NUM_FOR_EDICT(entity)

  let use_phs: boolean;
  let ch = channel;
  if (ch & 8) {
    // no PHS flag
    use_phs = false;
    ch &= 7;
  } else {
    use_phs = true;
  }

  const sendchan = (ent << 3) | (ch & 7);

  let flags = 0;
  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) flags |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) flags |= SND_ATTENUATION;

  // the client doesn't know that bmodels have weird origins
  // the origin can also be explicitly set
  if (entity.svflags & SVF_NOCLIENT || entity.solid === SolidT.SOLID_BSP || origin) flags |= SND_POS;

  // always send the entity number for channel overrides
  flags |= SND_ENT;

  if (timeofs) flags |= SND_OFFSET;

  // use the entity origin unless it is a bmodel or explicitly specified
  let useOrigin: Vec3;
  if (!origin) {
    useOrigin = vec3();
    if (entity.solid === SolidT.SOLID_BSP) {
      for (let i = 0; i < 3; i++) {
        useOrigin[i] = entity.s.origin[i] + 0.5 * (entity.mins[i] + entity.maxs[i]);
      }
    } else {
      VectorCopy(entity.s.origin, useOrigin);
    }
  } else {
    useOrigin = origin;
  }

  MSG_WriteByte(sv.multicast, SvcOpsT.svc_sound);
  MSG_WriteByte(sv.multicast, flags);
  MSG_WriteByte(sv.multicast, soundindex);

  if (flags & SND_VOLUME) MSG_WriteByte(sv.multicast, (volume * 255) | 0);
  if (flags & SND_ATTENUATION) MSG_WriteByte(sv.multicast, (attenuation * 64) | 0);
  if (flags & SND_OFFSET) MSG_WriteByte(sv.multicast, (timeofs * 1000) | 0);

  if (flags & SND_ENT) MSG_WriteShort(sv.multicast, sendchan);

  if (flags & SND_POS) MSG_WritePos(sv.multicast, useOrigin);

  // if the sound doesn't attenuate, send it to everyone
  // (global radio chatter, voiceovers, etc)
  if (attenuation === ATTN_NONE) use_phs = false;

  if (ch & CHAN_RELIABLE) {
    if (use_phs) SV_Multicast(useOrigin, MulticastT.MULTICAST_PHS_R);
    else SV_Multicast(useOrigin, MulticastT.MULTICAST_ALL_R);
  } else {
    if (use_phs) SV_Multicast(useOrigin, MulticastT.MULTICAST_PHS);
    else SV_Multicast(useOrigin, MulticastT.MULTICAST_ALL);
  }

  // mvd.c:625: SV_MvdStartSound(snd.entity, channel, sound_msg.sound.flags,
  // soundindex, ...) -- called with the SAME already-quantized byte values
  // (flags/volume/attenuation/timeofs) just written into the multicast
  // buffer above, not the original float volume/attenuation/timeofs
  // arguments.
  SV_MvdStartSound(ent, channel, flags, soundindex, (volume * 255) | 0, (attenuation * 64) | 0, (timeofs * 1000) | 0);
}

/*
===============================================================================

FRAME UPDATES

===============================================================================
*/

export function SV_SendClientDatagram(client: ClientT): boolean {
  // The per-frame write budget, which is NOT the same number as the
  // per-datagram budget on a fragmenting channel. q2pro/q2repro's
  // src/server/send.c has one frame writer per netchan type and they use two
  // different limits for exactly this reason:
  //
  //   - write_datagram_old (NETCHAN_OLD): the accumulated unreliable payload
  //     is dumped when `msg_write.cursize + client->msg_unreliable_bytes >
  //     client->netchan.maxpacketlen`, because NetchanOld_Transmit has no way
  //     to split a write and would only print "dumped unreliable" and lose
  //     it. So the whole frame has to fit one datagram.
  //   - write_datagram_new (NETCHAN_NEW): the same check is against
  //     `msg_write.maxsize` instead -- msg_write is SZ_Init'd over
  //     `msg_write_buffer[MAX_MSGLEN]` with the C's MAX_MSGLEN of 0x8000
  //     (inc/common/protocol.h:25, src/common/msg.c), NOT maxpacketlen --
  //     because NetchanNew_Transmit splits anything larger than maxpacketlen
  //     into fragments (chan.c:475-487) and the receiver reassembles it.
  //
  // This port had only the OLD limit, applied to both types: the buffer was
  // `max(MAX_MSGLEN, maxpacketlen + PACKET_HEADER)`, i.e. 4096 for a loopback
  // kex/1038 channel. Call of the Machine's mgu5m2 builds per-frame datagrams
  // larger than that under BOTH game modules (measured: 668 overflowing frames
  // in one 4-minute kex run, 167 under the widened classic session), so this
  // SizeBuf overflowed ("WARNING: msg overflowed for %s" plus SZ_GetSpace's
  // own print), the SZ_Clear below threw the whole frame away, and the client
  // never received a complete frame at all -- a black screen for the entire
  // run. The fragmentation path in net_chan.ts already existed but could never
  // be reached, because the frame was destroyed one layer above it.
  //
  // NETCHAN_OLD keeps its previous sizing verbatim (vanilla/34 and R1Q2/35
  // are unchanged, including their overflow-and-drop behavior, which is the
  // reference's behavior for a non-fragmenting channel).
  const msg_buf = new Uint8Array(
    client.netchan.type === NETCHAN_NEW ? MAX_FRAGMENT_MSGLEN : Math.max(MAX_MSGLEN, client.netchan.maxpacketlen + PACKET_HEADER),
  );
  const msg = new SizeBuf();

  SV_BuildClientFrame(client);

  SZ_Init(msg, msg_buf, msg_buf.length);
  msg.allowoverflow = true;

  // send over all the relevant entity_state_t and the player_state_t
  SV_WriteFrameToClient(client, msg);

  // copy the accumulated multicast datagram for this client out to the
  // message; it is necessary for this to be after the WriteEntities so that
  // entity references will be current
  if (client.datagram.overflowed) {
    Com_Printf("WARNING: datagram overflowed for %s\n", client.name);
  } else {
    SZ_Write(msg, client.datagram.data, client.datagram.cursize);
  }
  SZ_Clear(client.datagram);

  if (msg.overflowed) {
    // must have room left for the packet header
    Com_Printf("WARNING: msg overflowed for %s\n", client.name);
    SZ_Clear(msg);
  }

  // send the datagram
  Netchan_Transmit(client.netchan, msg.cursize, msg.data);

  // record the size for rate estimation
  client.message_size[sv.framenum % RATE_MESSAGES] = msg.cursize;

  return true;
}

export function SV_DemoCompleted(): void {
  if (sv.demofile !== null) {
    FS_FCloseFile(sv.demofile);
    sv.demofile = null;
  }
  SV_Nextserver();
}

/*
=======================
SV_RateDrop

Returns true if the client is over its current
bandwidth estimation and should not be sent another packet
=======================
*/
export function SV_RateDrop(c: ClientT): boolean {
  // never drop over the loopback
  if (c.netchan.remote_address.type === NetadrtypeT.NA_LOOPBACK) return false;

  let total = 0;
  for (let i = 0; i < RATE_MESSAGES; i++) {
    total += c.message_size[i];
  }

  if (total > c.rate) {
    c.surpressCount++;
    c.message_size[sv.framenum % RATE_MESSAGES] = 0;
    return true;
  }

  return false;
}

export function SV_SendClientMessages(): void {
  let msglen = 0;
  const msgbuf = new Uint8Array(MAX_MSGLEN);

  // read the next demo message if needed
  if (sv.state === ServerStateT.ss_demo && sv.demofile !== null) {
    if (sv_paused && sv_paused.value) {
      msglen = 0;
    } else {
      const demofile = sv.demofile;
      // FS_Read throws on any short read (including a clean EOF), unlike
      // C's fread which just returns fewer items; this port has no way to
      // tell "ran out of demo file" from "real I/O error" through the
      // sanctioned FS boundary (files.ts), so any thrown error here is
      // treated the same way the original treats a short/failed fread: the
      // demo is done. See report.
      // C: `r = fread (&msglen, 4, 1, sv.demofile); if (r != 1) { done }`
      const lenBuf = new Uint8Array(4);
      if (FS_ReadRaw(lenBuf, 4, demofile) !== 4) {
        SV_DemoCompleted();
        return;
      }
      msglen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getInt32(0, true);
      if (msglen === -1) {
        SV_DemoCompleted();
        return;
      }
      if (msglen > MAX_MSGLEN) Com_Error(ERR_DROP, "SV_SendClientMessages: msglen > MAX_MSGLEN");
      if (FS_ReadRaw(msgbuf, msglen, demofile) !== msglen) {
        SV_DemoCompleted();
        return;
      }
    }
  }

  // send a message to each connected client
  for (const c of svs.clients) {
    if (!c.state) continue;

    // Local splitscreen seats (sv_seats.ts) have no netchan and no remote
    // address: their playerstate is read back in-process by the client that
    // draws their viewport, so there is no message to build and nothing to
    // transmit to. Skipped before any buffer/overflow handling below, all of
    // which would be operating on a NetchanT that was never Netchan_Setup'd.
    if (c.isLocalSeat) continue;

    // if the reliable message overflowed, drop the client
    if (c.netchan.message.overflowed) {
      SZ_Clear(c.netchan.message);
      SZ_Clear(c.datagram);
      SV_BroadcastPrintf(PRINT_HIGH, "%s overflowed\n", c.name);
      SV_DropClient(c);
    }

    if (sv.state === ServerStateT.ss_cinematic || sv.state === ServerStateT.ss_demo || sv.state === ServerStateT.ss_pic) {
      Netchan_Transmit(c.netchan, msglen, msgbuf);
    } else if (c.state === ClientStateT.cs_spawned) {
      // don't overrun bandwidth
      if (SV_RateDrop(c)) continue;

      // "don't write any frame data until all fragments are sent"
      // (q2pro/q2repro src/server/send.c, SV_SendClientMessages -- the check
      // sits between SV_RateDrop and SV_BuildClientFrame and does
      // `client->frameflags |= FF_SUPPRESSED; cursize =
      // client->netchan.TransmitNextFragment(&client->netchan); goto
      // advance;`). Placing it HERE rather than relying on
      // Netchan_Transmit's own fragment_pending short-circuit is the
      // load-bearing part: SV_SendClientDatagram would otherwise run
      // SV_BuildClientFrame (advancing the delta-compression frame ring for a
      // frame that is never going to be transmitted) and then
      // unconditionally SZ_Clear(client.datagram), silently discarding every
      // temp entity, sound and print accumulated while the previous message
      // was still draining. Skipping the whole frame instead keeps that
      // payload queued for the next non-suppressed frame, exactly as the
      // reference does. frameflags/FF_SUPPRESSED itself is q2pro's own
      // client-visible frame-flag bookkeeping and has no counterpart in this
      // port's vanilla-shaped frame writer, so there is nothing to set.
      // (The `type === NETCHAN_NEW` half of this condition is belt-and-braces
      // and cannot change behavior: fragment_pending is only ever set by the
      // NETCHAN_NEW send path. The reference tests fragment_pending alone,
      // because there TransmitNextFragment is a per-type function pointer
      // that a NETCHAN_OLD channel simply does not carry; this port's is a
      // plain function, so the type is checked explicitly instead.)
      if (c.netchan.type === NETCHAN_NEW && c.netchan.fragment_pending) {
        const cursize = Netchan_TransmitNextFragment(c.netchan);
        // src/server/send.c:883's SV_CalcSendTime(client, cursize) -- a
        // suppressed frame still consumed bandwidth, so it has to land in the
        // rate-estimation window SV_RateDrop reads. Leaving the slot holding
        // the PREVIOUS frame's size would let a fragmenting client
        // systematically under-report what it is actually sending.
        c.message_size[sv.framenum % RATE_MESSAGES] = cursize;
        continue;
      }

      SV_SendClientDatagram(c);
    } else {
      // just update reliable if needed
      if (c.netchan.message.cursize || curtime.value - c.netchan.last_sent > 1000) {
        Netchan_Transmit(c.netchan, 0, new Uint8Array(0));
      }
    }
  }
}
