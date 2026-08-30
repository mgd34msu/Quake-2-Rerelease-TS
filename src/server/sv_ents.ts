// sv_ents.c
//
// Encode a client frame onto the network channel; build a client frame
// structure (PVS/PHS visibility culling); record unmerged demo messages.

import { FS_Write } from "../qcommon/files";
import { type Vec3, vec3, VectorSubtract, VectorLength } from "../shared/math";
import { EntityStateT, PlayerStateT, RF_BEAM } from "../shared/q_shared";
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
import { geHolder } from "./sv_game";
import { SVF_NOCLIENT } from "../game/game";
import { Com_DPrintf, Com_Error } from "../qcommon/common";
import { cloneEntityStateInto, clonePlayerState } from "../shared/state_copy";

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
entity wire encoding (delta bits, remove marker, terminator) is owned by
svs.codec (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md step 1)
so a future 1038 codec can format these bytes differently; the diff loop
itself (which entities changed) stays here, matching q2proto's own split
(the codec's vanilla_server_write_frame_entity_delta takes one already-
decided entity at a time; the caller does the old/new list diff).
=============
*/
function SV_EmitPacketEntities(from: ClientFrameT | null, to: ClientFrameT, msg: SizeBuf): void {
  svs.codec.writePacketEntitiesBegin(msg);

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
        svs.codec.writeDeltaEntity(msg, oldent, newent, false, newent.number <= mc);
      }
      oldindex++;
      newindex++;
      continue;
    }

    if (newnum < oldnum) {
      // this is a new entity, send it from the baseline
      if (newent) {
        svs.codec.writeDeltaEntity(msg, sv.baselines[newnum], newent, true, true);
      }
      newindex++;
      continue;
    }

    if (newnum > oldnum) {
      // the old entity isn't present in the new message
      svs.codec.writeEntityRemove(msg, oldnum);
      oldindex++;
      continue;
    }
  }

  svs.codec.writePacketEntitiesEnd(msg); // end of packetentities
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
  // playerstate delta, packetentities framing) is now owned by svs.codec
  // (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md phase 5 --
  // q2repro.ts's file header "RESOLVED: frame envelope" note). The entity
  // diff loop (SV_EmitPacketEntities) stays here since it needs svs/sv
  // globals this qcommon-layer codec module doesn't import.
  svs.codec.writeFrame(
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
    (m) => SV_EmitPacketEntities(oldframe, frame, m),
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
  for (let j = 0; j < byteLen; j++) fatpvs[j] = firstPvs[j];

  // or in all the other leaf bits
  for (let i = 1; i < count; i++) {
    let j = 0;
    for (j = 0; j < i; j++) if (clusters[i] === clusters[j]) break;
    if (j !== i) continue; // already have the cluster we want

    const src = CM_ClusterPVS(clusters[i]);
    for (j = 0; j < byteLen; j++) fatpvs[j] |= src[j];
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
    clientPs.pmove.origin[2] * 0.125 + clientPs.viewoffset[2],
  );

  const leafnum = CM_PointLeafnum(org);
  const clientarea = CM_LeafArea(leafnum);
  const clientcluster = CM_LeafCluster(leafnum);

  // calculate the visible areas
  frame.areabytes = CM_WriteAreaBits(frame.areabits, clientarea);

  // grab the current player_state_t
  frame.ps = clonePlayerState(clientPs);

  SV_FatPVS(org);
  const clientphs = CM_ClusterPHS(clientcluster);

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
    if (!ent.s.modelindex && !ent.s.effects && !ent.s.sound && !ent.s.event) continue;

    // ignore if not touching a PV leaf
    if (ent !== clent) {
      // check area
      if (!CM_AreasConnected(clientarea, ent.areanum)) {
        // doors can legally straddle two areas, so
        // we may need to check another one
        if (!ent.areanum2 || !CM_AreasConnected(clientarea, ent.areanum2)) continue; // blocked by a door
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
          const delta = vec3();
          VectorSubtract(org, ent.s.origin, delta);
          const len = VectorLength(delta);
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

  // write a frame message that doesn't contain a player_state_t
  MSG_WriteByte(buf, SvcOpsT.svc_frame);
  MSG_WriteLong(buf, sv.framenum);

  MSG_WriteByte(buf, SvcOpsT.svc_packetentities);

  const ge = geHolder.ge;
  if (ge) {
    for (let e = 1; e < ge.num_edicts; e++) {
      const ent = ge.edicts[e];
      // ignore ents without visible models unless they have an effect
      if (ent.inuse && ent.s.number && (ent.s.modelindex || ent.s.effects || ent.s.sound || ent.s.event) && !(ent.svflags & SVF_NOCLIENT)) {
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
