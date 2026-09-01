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
// Holds either family's state (see the `rerelease` field below) -- legacy
// (PROTOCOL_VERSION_MVD_DEFAULT) and kex/rerelease (PROTOCOL_VERSION_MVD_
// RERELEASE) both parse into the same MvdChannelT shape, since the two
// player-state sub-formats differ only in wire encoding, not in what
// PlayerStateT fields they populate.

import { EntityStateT, PlayerStateT, MAX_CLIENTS } from "../../shared/q_shared";
import { CS_REMAP_OLD, type CsRemapT } from "../../shared/cs_remap";

export enum MvdChannelStateT {
  MVD_DEAD, // no gamestate received yet, unusable for observers
  MVD_READING, // gamestate received, frames may be applied
}

// See MvdChannelT.events below. `base`/`clientNum`/`extrabits` are the raw
// decoded header fields (matching SV_MvdMulticast/SV_MvdUnicast/
// SV_MvdStartSound's own parameters in sv_mvd.ts); `length` is the payload's
// byte length -- this unit does not decode the underlying svc_* payload
// bytes themselves (that IS decoding a live per-client protocol message
// recursively, which is exactly the spectator-networking scope this port's
// MVD channel has never implemented -- see this file's own header).
export type MvdEventT =
  | { kind: "multicast"; base: number; reliable: boolean; leafnum: number; length: number }
  | { kind: "unicast"; reliable: boolean; clientNum: number; length: number }
  | { kind: "sound"; extrabits: number; length: number }
  | { kind: "print"; level: number; text: string }
  | { kind: "configstring"; index: number; value: string };

export class MvdChannelT {
  state: MvdChannelStateT = MvdChannelStateT.MVD_DEAD;

  gamedir = "";
  servercount = 0;
  clientNum = -1;

  // true once a gamestate carrying PROTOCOL_VERSION_MVD_RERELEASE has been
  // parsed (qcommon/protocol/mvd.ts's MSG_WriteDeltaMvdPlayerstateRerelease/
  // MSG_ReadDeltaMvdPlayerstateRerelease branch) -- selects which player-
  // state delta codec every subsequent frame in this channel uses.
  rerelease = false;

  // Out-of-band capture log (item 1's read-side observability): every
  // multicast/unicast/sound/print segment this channel's messages carry,
  // decoded to the extent this unit's scope covers (see parse.ts's header --
  // no PVS-based spectator fan-out, just enough to prove the hooks' bytes
  // actually land in a parsed recording/stream).
  events: MvdEventT[] = [];

  csr: CsRemapT = CS_REMAP_OLD;
  configstrings: string[] = new Array(CS_REMAP_OLD.end).fill("");

  // Indexed directly by client slot number (0..maxclients-1); `null` means
  // that slot is not currently occupied by an active player (matches
  // `!PPS_INUSE(ps)` on the writer side -- see qcommon/protocol/mvd.ts).
  players: Array<PlayerStateT | null> = new Array(MAX_CLIENTS).fill(null);

  // Indexed directly by entity number (1..csr.max_edicts-1); `null` means the
  // entity is not currently active in this channel's view of the world.
  //
  // Sized off `this.csr` (whichever family the channel currently claims to
  // be -- CS_REMAP_OLD until a gamestate says otherwise), NOT a compile-time
  // MAX_EDICTS constant. q2repro's own mvd_t.edicts is a fixed `edict_t
  // edicts[MAX_EDICTS]` array (src/server/mvd/client.h:172), but that's safe
  // there only because q2repro's own MAX_EDICTS is globally the WIDE value
  // (8192 -- shared.h:90; MAX_EDICTS_OLD=1024 is the separate, narrower
  // constant); every bound check in that engine's mvd/client.c and
  // mvd/parse.c (e.g. parse.c:447, 649, 1879, 2430) is against the
  // per-stream `mvd->csr->max_edicts`, not the fixed array size, so a
  // classic-family relay just leaves the top of that array unused. This
  // port's q_shared.ts MAX_EDICTS is the classic-only 1024 (cs_remap.ts's
  // own header explains why the wide value lives only in cs_remap.ts), so
  // mirroring q2repro's storage strategy literally would under-size a
  // rerelease/kex GTV stream's entity numbers (up to 8191). Instead this
  // port dynamically resizes the backing array to the negotiated family's
  // max_edicts -- the same convention sv_mvd.ts's buildGamestate already
  // uses for the RECORDING side's mvd.entities. See parse.ts's
  // parseGamestate, which re-settles `channel.csr` (and re-sizes this array)
  // from the gamestate's protocol-version field, mirroring q2repro's
  // MVD_ParseServerData settling `mvd->csr` from that same field
  // (parse.c:908-921).
  entities: Array<EntityStateT | null> = new Array(this.csr.max_edicts).fill(null);

  portalbits: Uint8Array = new Uint8Array(0);

  framenum = 0;
}

export function MVD_ClearState(channel: MvdChannelT): void {
  channel.state = MvdChannelStateT.MVD_DEAD;
  channel.gamedir = "";
  channel.servercount = 0;
  channel.clientNum = -1;
  channel.rerelease = false;
  channel.configstrings = new Array(channel.csr.end).fill("");
  channel.players = new Array(MAX_CLIENTS).fill(null);
  // Sized off channel.csr, not MAX_EDICTS -- see the field's own doc comment
  // above. Deliberately does NOT reset channel.csr itself: q2repro's own
  // MVD_ClearState (parse.c:790-809) sizes its memset off whatever
  // `mvd->csr` currently holds too, and leaves resettling `mvd->csr` itself
  // to its one caller, MVD_ParseServerData (parse.c:883's `MVD_ClearState
  // (mvd, true);` runs BEFORE that function reads the protocol version and
  // reassigns `mvd->csr`) -- mirrored here by parseGamestate in parse.ts.
  channel.entities = new Array(channel.csr.max_edicts).fill(null);
  channel.portalbits = new Uint8Array(0);
  channel.framenum = 0;
  channel.events = [];
}

export function MVD_NewChannel(): MvdChannelT {
  return new MvdChannelT();
}
