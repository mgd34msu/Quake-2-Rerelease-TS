// sv_ents.c
//
// Encode a client frame onto the network channel; build a client frame
// structure (PVS/PHS visibility culling); record unmerged demo messages.

import { FS_Write } from "../qcommon/files";
import { type Vec3, vec3, VectorSubtract, VectorLength } from "../shared/math";
import { EntityStateT, PlayerStateT, RF_BEAM, RF_CASTSHADOW } from "../shared/q_shared";
import { SizeBuf, SZ_Init, SZ_Write, SZ_Clear, MSG_WriteByte, MSG_WriteLong } from "../qcommon/sizebuf";
import { SvcOpsT, UPDATE_MASK, UPDATE_BACKUP, ERR_FATAL } from "../qcommon/qcommon";
import { MAX_MAP_LEAFS } from "../qcommon/qfiles";
import {
  CM_BoxLeafnums,
  CM_LeafCluster,
  CM_LeafArea,
  CM_NumClusters,
  CM_ClusterPVS,
  CM_ClusterPHS,
  CM_PointLeafnum,
  CM_AreasConnected,
  CM_WriteAreaBits,
  CM_HeadnodeVisible,
} from "../qcommon/cmodel";
import { type ClientT, type ClientFrameT, sv, svs, maxclients } from "./server";
import type { ProtocolCodec } from "../qcommon/protocol/codec";
import { geHolder } from "./sv_game";
import { SVF_NOCLIENT } from "../game/game";
import { Com_DPrintf, Com_Error } from "../qcommon/common";
import { cloneEntityStateInto, clonePlayerState } from "../shared/state_copy";
import { SV_LocalSeatViewOrigins } from "./sv_seats";

function areasConnectedToAny(areas: readonly number[], areanum: number): boolean {
  for (const area of areas) if (CM_AreasConnected(area, areanum)) return true;
  return false;
}

/*
=============================================================================

Encode a client frame onto the network channel

=============================================================================
*/

// game.h's gclient_s server-visible prefix (`{ player_state_t ps; ... }`) is
// not represented in game.ts's `Edict.client: unknown`. Narrowed here with a
// real type guard, matching the `isGClientPublic` precedent in sv_main.ts
// (that one also checks `.ping`; this unit only needs `.ps`).
interface EdictClientPs {
  ps: PlayerStateT;
}

function hasPlayerState(client: unknown): client is EdictClientPs {
  if (typeof client !== "object" || client === null) return false;
  if (!("ps" in client)) return false;
  return client.ps instanceof PlayerStateT;
}

/*
=============
SV_EmitPacketEntities

Writes a delta update of an entity_state_t list to the message. The per-
entity wire encoding (delta bits, remove marker, terminator) is owned by the
`codec` param (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md
step 1; v1.0.0 wire cluster task board #23 made this the caller's
client.codec instead of a fixed svs.codec, since legacy-family connections
now negotiate protocol 34/35/36 per client) so each codec can format these
bytes differently; the diff loop itself (which entities changed) stays here,
matching q2proto's own split (the codec's
vanilla_server_write_frame_entity_delta takes one already-decided entity at
a time; the caller does the old/new list diff).
=============
*/
function SV_EmitPacketEntities(from: ClientFrameT | null, to: ClientFrameT, msg: SizeBuf, codec: ProtocolCodec): void {
  codec.writePacketEntitiesBegin(msg);

  const from_num_entities = from ? from.num_entities : 0;

  let newindex = 0;
  let oldindex = 0;
  while (newindex < to.num_entities || oldindex < from_num_entities) {
    let newent: EntityStateT | null = null;
    let newnum: number;
    if (newindex >= to.num_entities) {
      newnum = 9999;
    } else {
      newent = svs.client_entities[(to.first_entity + newindex) % svs.num_client_entities];
      newnum = newent.number;
    }

    let oldent: EntityStateT | null = null;
    let oldnum: number;
    if (!from || oldindex >= from_num_entities) {
      oldnum = 9999;
    } else {
      oldent = svs.client_entities[(from.first_entity + oldindex) % svs.num_client_entities];
      oldnum = oldent.number;
    }

    if (newnum === oldnum) {
      // delta update from old position
      // because the force parm is false, this will not result
      // in any bytes being emited if the entity has not changed at all
      // note that players are always 'newentities', this updates their oldorigin always
      // and prevents warping
      if (oldent && newent) {
        const mc = maxclients ? maxclients.value : 0;
        codec.writeDeltaEntity(msg, oldent, newent, false, newent.number <= mc);
      }
      oldindex++;
      newindex++;
      continue;
    }

    if (newnum < oldnum) {
      // this is a new entity, send it from the baseline
      if (newent) {
        codec.writeDeltaEntity(msg, sv.baselines[newnum], newent, true, true);
      }
      newindex++;
      continue;
    }

    if (newnum > oldnum) {
      // the old entity isn't present in the new message
      codec.writeEntityRemove(msg, oldnum);
      oldindex++;
      continue;
    }
  }

  codec.writePacketEntitiesEnd(msg); // end of packetentities
}

/*
==================
SV_WriteFrameToClient
==================
*/
export function SV_WriteFrameToClient(client: ClientT, msg: SizeBuf): void {
  // this is the frame we are creating
  const frame = client.frames[sv.framenum & UPDATE_MASK];

  let oldframe: ClientFrameT | null;
  let lastframe: number;

  if (client.lastframe <= 0) {
    // client is asking for a retransmit
    oldframe = null;
    lastframe = -1;
  } else if (sv.framenum - client.lastframe >= UPDATE_BACKUP - 3) {
    // client hasn't gotten a good message through in a long time
    oldframe = null;
    lastframe = -1;
  } else {
    // we have a valid message to delta from
    oldframe = client.frames[client.lastframe & UPDATE_MASK];
    lastframe = client.lastframe;
  }

  // Envelope shape (svc_frame opcode, framenum/delta encoding, areabits,
  // playerstate delta, packetentities framing) is owned by the codec
  // (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md phase 5 --
  // q2repro.ts's file header "RESOLVED: frame envelope" note). client.codec,
  // not svs.codec: v1.0.0 wire cluster (task board #23) made codec selection
  // per-client for the legacy family (34/35/36 can now coexist on one
  // server) -- see server.ts's ClientT.codec doc comment. The entity diff
  // loop (SV_EmitPacketEntities) stays here since it needs svs/sv globals
  // this qcommon-layer codec module doesn't import.
  client.codec.writeFrame(
    msg,
    {
      framenum: sv.framenum,
      lastframe,
      surpressCount: client.surpressCount,
      areabits: frame.areabits,
      areabytes: frame.areabytes,
      psFrom: oldframe ? oldframe.ps : null,
      psTo: frame.ps,
    },
    (m) => SV_EmitPacketEntities(oldframe, frame, m, client.codec),
  );
  client.surpressCount = 0;
}

/*
=============================================================================

Build a client frame structure

=============================================================================
*/

const fatpvs = new Uint8Array(MAX_MAP_LEAFS / 8); // 32767 is MAX_MAP_LEAFS

/*
============
SV_FatPVS

The client will interpolate the view position,
so we can't use a single PVS point
===========
*/
function SV_FatPVS(org: Vec3): void {
  SV_FatPVSInto(org, fatpvs, false);
}

/*
The body of SV_FatPVS, with the destination buffer and an OR-in-place flag
lifted out. `accumulate` is what makes local splitscreen work: seats 1..N-1
render out of the PRIMARY connection's single entity list (see
sv_seats.ts's header for why there is only one connection), so that list has
to hold the union of every seat's PVS or a seat looking somewhere the
primary player is not would see holes where entities should be. With one
seat this is called exactly once with accumulate=false and produces the same
bytes the pre-splitscreen SV_FatPVS produced.
*/
function SV_FatPVSInto(org: Vec3, dest: Uint8Array, accumulate: boolean): void {
  const mins = vec3(org[0] - 8, org[1] - 8, org[2] - 8);
  const maxs = vec3(org[0] + 8, org[1] + 8, org[2] + 8);

  const leafs: number[] = new Array(64).fill(0);
  const { count } = CM_BoxLeafnums(mins, maxs, leafs, 64);
  if (count < 1) {
    Com_Error(ERR_FATAL, "SV_FatPVS: count < 1");
  }
  const longs = (CM_NumClusters() + 31) >> 5;
  const byteLen = longs * 4;

  // convert leafs to clusters
  const clusters: number[] = new Array(count);
  for (let i = 0; i < count; i++) clusters[i] = CM_LeafCluster(leafs[i]);

  const firstPvs = CM_ClusterPVS(clusters[0]);
  if (accumulate) {
    for (let j = 0; j < byteLen; j++) dest[j] |= firstPvs[j];
  } else {
    for (let j = 0; j < byteLen; j++) dest[j] = firstPvs[j];
  }

  // or in all the other leaf bits
  for (let i = 1; i < count; i++) {
    let j = 0;
    for (j = 0; j < i; j++) if (clusters[i] === clusters[j]) break;
    if (j !== i) continue; // already have the cluster we want

    const src = CM_ClusterPVS(clusters[i]);
    for (j = 0; j < byteLen; j++) dest[j] |= src[j];
  }
}

/*
=============
SV_BuildClientFrame

Decides which entities are going to be visible to the client, and
copies off the playerstat and areabits.
=============
*/
export function SV_BuildClientFrame(client: ClientT): void {
  const clent = client.edict;
  if (!clent) return; // not in game yet
  if (!hasPlayerState(clent.client)) return; // not in game yet

  const clientPs = clent.client.ps;

  // this is the frame we are creating
  const frame = client.frames[sv.framenum & UPDATE_MASK];

  frame.senttime = svs.realtime; // save it for ping calc later

  // find the client's PVS
  const org = vec3(
    clientPs.pmove.origin[0] * 0.125 + clientPs.viewoffset[0],
    clientPs.pmove.origin[1] * 0.125 + clientPs.viewoffset[1],
    // q2repro server/entities.c:610-612: "Rerelease game doesn't include
    // viewheight in viewoffset, vanilla does" -- so the re-release family
    // has to add ps.pmove.viewheight here or the PVS is computed from the
    // player's feet instead of the eyes (visibly wrong through low doorways
    // and over railings). Vanilla-family games leave the field at 0, so
    // this term is a no-op for them and no classic behavior changes.
    clientPs.pmove.origin[2] * 0.125 + clientPs.viewoffset[2] + clientPs.pmove.viewheight,
  );

  const leafnum = CM_PointLeafnum(org);
  const clientarea = CM_LeafArea(leafnum);
  const clientcluster = CM_LeafCluster(leafnum);

  // LOCAL SPLITSCREEN (sv_seats.ts): the extra local seats ride this one
  // connection's entity list, so everything visibility-related below widens
  // to the UNION over the primary client plus every seated seat. Seats only
  // ever exist on a local server and only for the client that owns them, so
  // this list is empty -- and every union below collapses to exactly the
  // pre-splitscreen single-origin computation -- for a normal connection.
  const seatOrigins = client.isLocalSeat ? [] : SV_LocalSeatViewOrigins();
  const viewAreas: number[] = [clientarea];

  // calculate the visible areas
  frame.areabytes = CM_WriteAreaBits(frame.areabits, clientarea);

  // grab the current player_state_t
  frame.ps = clonePlayerState(clientPs);

  SV_FatPVS(org);
  let clientphs = CM_ClusterPHS(clientcluster);

  if (seatOrigins.length) {
    const seatAreaBits = new Uint8Array(frame.areabits.length);
    // CM_ClusterPHS hands back a buffer the collision model owns and reuses;
    // OR-ing seats into it would corrupt it for every later reader, so the
    // union is accumulated into a copy.
    const phsUnion = new Uint8Array(clientphs);
    for (const seatOrg of seatOrigins) {
      SV_FatPVSInto(seatOrg, fatpvs, true);

      const seatLeaf = CM_PointLeafnum(seatOrg);
      const seatArea = CM_LeafArea(seatLeaf);
      if (!viewAreas.includes(seatArea)) viewAreas.push(seatArea);
      const seatBytes = CM_WriteAreaBits(seatAreaBits, seatArea);
      if (seatBytes > frame.areabytes) frame.areabytes = seatBytes;
      for (let i = 0; i < seatBytes; i++) frame.areabits[i] |= seatAreaBits[i];

      const seatPhs = CM_ClusterPHS(CM_LeafCluster(seatLeaf));
      for (let i = 0; i < phsUnion.length && i < seatPhs.length; i++) phsUnion[i] |= seatPhs[i];
    }
    clientphs = phsUnion;
  }

  // build up the list of visible entities
  frame.num_entities = 0;
  frame.first_entity = svs.next_client_entities;

  const ge = geHolder.ge;
  if (!ge) return; // game not loaded; nothing to enumerate

  for (let e = 1; e < ge.num_edicts; e++) {
    const ent = ge.edicts[e];

    // ignore ents without visible models
    if (ent.svflags & SVF_NOCLIENT) continue;

    // ignore ents without visible models unless they have an effect
    if (!ent.s.modelindex && !ent.s.effects && !ent.s.sound && !ent.s.event && !(ent.s.renderfx & RF_CASTSHADOW)) continue;

    // ignore if not touching a PV leaf
    if (ent !== clent) {
      // check area
      // `viewAreas` is [clientarea] for every ordinary connection, so this
      // is the original two-line check with one iteration; a splitscreen
      // primary carries one entry per seat (see the union block above).
      if (!areasConnectedToAny(viewAreas, ent.areanum)) {
        // doors can legally straddle two areas, so
        // we may need to check another one
        if (!ent.areanum2 || !areasConnectedToAny(viewAreas, ent.areanum2)) continue; // blocked by a door
      }

      // beams just check one point for PHS
      if (ent.s.renderfx & RF_BEAM) {
        const l = ent.clusternums[0];
        if (!(clientphs[l >> 3] & (1 << (l & 7)))) continue;
      } else {
        // FIXME: if an ent has a model and a sound, but isn't
        // in the PVS, only the PHS, clear the model
        const bitvector = fatpvs; // clientphs;

        if (ent.num_clusters === -1) {
          // too many leafs for individual check, go by headnode
          if (!CM_HeadnodeVisible(ent.headnode, bitvector)) continue;
        } else {
          // check individual leafs
          let i = 0;
          for (i = 0; i < ent.num_clusters; i++) {
            const l = ent.clusternums[i];
            if (bitvector[l >> 3] & (1 << (l & 7))) break;
          }
          if (i === ent.num_clusters) continue; // not visible
        }

        if (!ent.s.modelindex) {
          // don't send sounds if they will be attenuated away
          //
          // Measured from the NEAREST view origin: a sound that is audible
          // to seat 1 has to survive this cull even when the primary player
          // is out of range, or that seat goes silent. With no seats this
          // is the original single `org` distance test.
          const delta = vec3();
          VectorSubtract(org, ent.s.origin, delta);
          let len = VectorLength(delta);
          for (const seatOrg of seatOrigins) {
            VectorSubtract(seatOrg, ent.s.origin, delta);
            const seatLen = VectorLength(delta);
            if (seatLen < len) len = seatLen;
          }
          if (len > 400) continue;
        }
      }
    }

    // add it to the circular client_entities array
    const state = svs.client_entities[svs.next_client_entities % svs.num_client_entities];
    if (ent.s.number !== e) {
      Com_DPrintf("FIXING ENT->S.NUMBER!!!\n");
      ent.s.number = e;
    }
    cloneEntityStateInto(ent.s, state);

    // don't mark players missiles as solid
    if (ent.owner === client.edict) state.solid = 0;

    svs.next_client_entities++;
    frame.num_entities++;
  }
}

/*
==================
SV_RecordDemoMessage

Save everything in the world out without deltas.
Used for recording footage for merged or assembled demos
==================
*/
export function SV_RecordDemoMessage(): void {
  if (svs.demofile === null) return;

  const nostate = new EntityStateT();
  const buf = new SizeBuf();
  const buf_data = new Uint8Array(32768);
  SZ_Init(buf, buf_data, buf_data.length);

  // write a frame message that doesn't contain a player_state_t. The leading
  // svc_frame opcode + bare framenum long is this merge-format's OWN framing
  // (matching vanilla's sv_ents.c byte-for-byte -- this was never a live
  // per-client svc_frame envelope in the first place: it carries no
  // lastframe/surpressCount/areabits/playerstate, none of which
  // svs.codec.writeFrame's 1038 envelope can omit, so it stays a literal
  // MSG_WriteByte/MSG_WriteLong pair here rather than routing through
  // writeFrame), unlike the packetentities opening bracket right after it,
  // which genuinely does vary per protocol (vanilla's leading
  // svc_packetentities opcode byte vs 1038's no-opcode "entities follow
  // directly" shape -- codec.ts's writePacketEntitiesBegin doc comment) and
  // was hardcoded to the vanilla byte here even under the kex family/1038
  // codec, unlike the writeDeltaEntity/writePacketEntitiesEnd calls below,
  // which already went through svs.codec correctly.
  MSG_WriteByte(buf, SvcOpsT.svc_frame);
  MSG_WriteLong(buf, sv.framenum);

  svs.codec.writePacketEntitiesBegin(buf);

  const ge = geHolder.ge;
  if (ge) {
    for (let e = 1; e < ge.num_edicts; e++) {
      const ent = ge.edicts[e];
      // ignore ents without visible models unless they have an effect
      if (ent.inuse && ent.s.number && (ent.s.modelindex || ent.s.effects || ent.s.sound || ent.s.event || ent.s.renderfx & RF_CASTSHADOW) && !(ent.svflags & SVF_NOCLIENT)) {
        svs.codec.writeDeltaEntity(buf, nostate, ent.s, false, true);
      }
    }
  }

  svs.codec.writePacketEntitiesEnd(buf); // end of packetentities

  // now add the accumulated multicast information
  SZ_Write(buf, svs.demo_multicast.data, svs.demo_multicast.cursize);
  SZ_Clear(svs.demo_multicast);

  // now write the entire message to the file, prefixed by the length
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setInt32(0, buf.cursize, true);
  FS_Write(lenBuf, 4, svs.demofile);
  FS_Write(buf.data.subarray(0, buf.cursize), buf.cursize, svs.demofile);
}
