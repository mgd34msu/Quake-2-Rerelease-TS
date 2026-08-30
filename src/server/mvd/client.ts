// server/mvd/client.c -- the "MVD channel": receiving-side state for an MVD
// stream (whether it comes from a locally recorded .mvd2 file, a live
// in-process feed, or a GTV connection). Named mvd_t in the C source
// (src/server/mvd/client.h:130-185); this port calls the type MvdChannelT to
// avoid colliding with server.ts's ClientT.
//
// SCOPE: this port implements the state container and the top-level
// gamestate/frame message dispatch (MVD_ParseMessage lives in ./parse.ts and
// calls back into this module's mutator functions). NOT ported: mvd_t's
// demo-seeking (`demoseeking`/`snapshots`), the GTV downstream-forwarding
// fields (`gtv`/`read_frame`/`forward_cmd`), and the delay/jitter buffer
// (`delay`/`num_packets`/`min_packets`) -- all real q2pro/q2repro features
// for smoothing a live relay's playback rate, out of scope for a unit whose
// job is proving the wire format round-trips (record -> parse -> state
// matches). See sv_mvd.ts's header for the matching "no MVD dummy client"
// scope note on the RECORDING side.
//
// LEGACY FAMILY ONLY -- see qcommon/protocol/mvd.ts's header for the kex/
// rerelease gap.

import { EntityStateT, PlayerStateT, MAX_EDICTS, MAX_CLIENTS } from "../../shared/q_shared";
import { CS_REMAP_OLD, type CsRemapT } from "../../shared/cs_remap";

export enum MvdChannelStateT {
  MVD_DEAD, // no gamestate received yet, unusable for observers
  MVD_READING, // gamestate received, frames may be applied
}

export class MvdChannelT {
  state: MvdChannelStateT = MvdChannelStateT.MVD_DEAD;

  gamedir = "";
  servercount = 0;
  clientNum = -1;

  csr: CsRemapT = CS_REMAP_OLD;
  configstrings: string[] = new Array(CS_REMAP_OLD.end).fill("");

  // Indexed directly by client slot number (0..maxclients-1); `null` means
  // that slot is not currently occupied by an active player (matches
  // `!PPS_INUSE(ps)` on the writer side -- see qcommon/protocol/mvd.ts).
  players: Array<PlayerStateT | null> = new Array(MAX_CLIENTS).fill(null);

  // Indexed directly by entity number (1..MAX_EDICTS-1); `null` means the
  // entity is not currently active in this channel's view of the world.
  entities: Array<EntityStateT | null> = new Array(MAX_EDICTS).fill(null);

  portalbits: Uint8Array = new Uint8Array(0);

  framenum = 0;
}

export function MVD_ClearState(channel: MvdChannelT): void {
  channel.state = MvdChannelStateT.MVD_DEAD;
  channel.gamedir = "";
  channel.servercount = 0;
  channel.clientNum = -1;
  channel.configstrings = new Array(channel.csr.end).fill("");
  channel.players = new Array(MAX_CLIENTS).fill(null);
  channel.entities = new Array(MAX_EDICTS).fill(null);
  channel.portalbits = new Uint8Array(0);
  channel.framenum = 0;
}

export function MVD_NewChannel(): MvdChannelT {
  return new MvdChannelT();
}
