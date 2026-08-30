// Protocol codec seam (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md
// step 1). Modeled on q2proto's per-protocol codec struct (q2proto_server.c /
// q2proto_client.c select a `q2proto_svc_func_t`/`q2proto_clc_func_t` table per
// connection; q2proto_proto_vanilla.c is the protocol-34 instance of that
// table). This interface exists to give the ops our engine hardcodes for
// protocol 34 today a named seam, so a future 1038 codec (q2repro's wire
// format) can be swapped in without touching sv_ents.ts/cl_ents.ts callers.
//
// This is step 1 ONLY: the seam plus a `vanilla.ts` implementation that wraps
// the EXISTING protocol-34 functions verbatim. No 1038 codec exists yet, and
// no wire byte this engine emits today changes shape.
//
// ---------------------------------------------------------------------------
// Op inventory vs q2proto_proto_vanilla.c
// ---------------------------------------------------------------------------
//
// q2proto splits its vanilla codec into two kinds of ops:
//   (a) protocol-VARYING ops, implemented as `vanilla_*` functions (entity
//       delta encoding, playerstate delta encoding, frame envelope, move
//       delta, baseline, serverdata's protocol-number literal), and
//   (b) protocol-COMMON ops, implemented once in q2proto_common.c and shared
//       by every protocol (`q2proto_common_server_write_sound/print/
//       stufftext/configstring/temp_entity/muzzleflash/centerprint/download/
//       inventory/layout`, plus nop/disconnect/reconnect).
//
// This codec includes ONLY (a) — the ops that actually differ between
// protocol 34 and protocol 1038 — because (b) is already protocol-agnostic in
// our engine (verified below), so routing it through a codec would add a
// seam with only one implementation ever and no behavioral question to
// answer. `ProtocolCodec` below is the (a) set, restricted further to what
// our engine actually performs today (see "excluded" list).
//
// INCLUDED (this file's ProtocolCodec members, mapped to q2proto's vanilla
// function names):
//   writeDeltaEntity        <- vanilla_server_write_entity_state_delta
//   writeEntityRemove       <- vanilla_server_write_frame_entity_delta (remove branch)
//   writePacketEntitiesEnd  <- vanilla_server_write_frame_entity_delta (newnum==0 "terminator" branch)
//   writeSpawnBaseline      <- vanilla_server_write_spawnbaseline
//   writePlayerStateDelta   <- vanilla_server_write_playerstate (+ vanilla_server_make_player_state_delta, merged: our engine computes and writes the pflags bitmask in one pass)
//   writeDeltaUsercmd       <- vanilla_client_write_move_delta
//   readDeltaUsercmd        <- vanilla_server_read_move_delta
//   readEntityBits          <- vanilla_client_read_entity_delta (bits/number prefix)
//   readDeltaEntity         <- vanilla_client_read_entity_delta (field body)
//   readPlayerStateDelta    <- vanilla_client_read_playerstate
//
// EXCLUDED (present in q2proto_proto_vanilla.c, deliberately left out of this
// seam):
//   - svc_nop/disconnect/reconnect, svc_sound, svc_print, svc_stufftext,
//     svc_configstring, svc_temp_entity, svc_muzzleflash(1/2), svc_centerprint,
//     svc_download, svc_inventory, svc_layout: all q2proto_common_server_write_*
//     in q2proto (identical bytes on every protocol q2proto supports). Grepped
//     our own sv_send.ts equivalents (SV_ClientPrintf, SV_StartSound,
//     SV_Multicast's stufftext path) for protocol branching -- none found.
//     Confirmed non-varying; not part of this seam.
//   - svc_serverdata (vanilla_server_write_serverdata / read_serverdata):
//     q2proto treats this as protocol-varying because it hardcodes the
//     protocol-number literal. Our engine's equivalent (sv_main.ts/sv_user.ts/
//     cl_main.ts/cl_parse.ts writing/checking PROTOCOL_VERSION directly) is a
//     one-time connection-handshake literal, not a repeated per-frame wire
//     encoding, and is out of this step's explicit scope (task item 1 lists
//     delta-entity/delta-usercmd/playerstate-delta/spawn-baseline only).
//     Deferred to whenever the 1038 handshake is implemented.
//   - vanilla_server_write_gamestate / WRITE_GAMESTATE_* (q2proto's demo
//     "gamestate" bulk-baseline dump used by some protocols): our engine has
//     no gamestate concept; SV_Baselines_f sends baselines one at a time on
//     request instead. Not performed today, so not included.
//   - vanilla_pack_solid / vanilla_unpack_solid (bbox-packing for solid
//     encoding used by extended/re-release protocols): protocol 34's U_SOLID
//     is a plain cmodel-index short (MSG_WriteShort(to.solid) /
//     MSG_ReadShort), never a packed bbox. Nothing to seam yet; the 1038
//     codec will need this when it lands.
//   - vanilla_client_read/write (the top-level clc_message_t / svc_message_t
//     dispatch switches): those are engine-level "which message type is
//     this" dispatch (our cl_parse.ts/sv_user.ts switch statements), not a
//     codec-owned encoding decision -- q2proto only special-cases the bodies
//     listed above.
//
// ---------------------------------------------------------------------------
// Signature asymmetry (documented, not "fixed")
// ---------------------------------------------------------------------------
// Every WRITE op below takes an explicit `msg: SizeBuf` destination, matching
// MSG_WriteDeltaEntity/MSG_WriteDeltaUsercmd's existing signatures. The two
// client-side entity READ ops (`readEntityBits`, `readDeltaEntity`) do NOT
// take a buffer: they wrap CL_ParseEntityBits/CL_ParseDelta, which are
// hardcoded today to read from qcommon/net_chan.ts's module-level
// `net_message` singleton (the same way the original C client code reads a
// global `net_message`). Parameterizing them would be a bigger behavioral
// refactor than this seam step calls for ("wrap, move nothing"), so the
// asymmetry is carried through verbatim. `readDeltaUsercmd` (server reading a
// client's move) and `readPlayerStateDelta` (client reading a playerstate)
// DO take an explicit buffer because their wrapped originals
// (MSG_ReadDeltaUsercmd, and the extracted body of CL_ParsePlayerstate) were
// already parameterized that way.

import type { SizeBuf } from "../sizebuf";
import type { EntityStateT, PlayerStateT, UsercmdT } from "../../shared/q_shared";

// Added for the 1038 (q2repro) codec (.orch/phase5-design.md phase 5 unit).
// q2proto's vanilla_server_write_serverdata/q2repro_server_write_serverdata
// both take a `q2proto_svc_serverdata_t` value struct; this is the subset of
// that struct our engine actually has data for at the SV_New_f call site,
// plus (for 1038 only) the extra q2pro/q2repro handshake fields the vanilla
// codec's implementation ignores. Kept as one shared param type (rather than
// a vanilla-only and a q2repro-only variant) so SV_New_f can build a single
// literal regardless of which codec is active -- q2repro-specific fields are
// simply unread by VANILLA_CODEC's implementation.
export interface ServerDataParamsT {
  servercount: number;
  attractloop: boolean;
  gamedir: string;
  clientnum: number; // playernum; -1 for cinematic/pic servers
  levelname: string;
  // q2repro (1038) only -- see q2repro.ts's writeServerData for the exact
  // wire shape and citations. Ignored by VANILLA_CODEC.
  serverState: number; // ServerStateT numeric value (sv.state)
}

export interface ProtocolCodec {
  // Identifies the codec for logging/diagnostics; not itself part of the
  // wire format. "vanilla" for protocol 34 (this step); "q2repro"/1038 is
  // future work (.orch/phase5-design.md).
  readonly name: string;

  // ---- server -> client writes -------------------------------------------

  // Writes the svc_serverdata handshake message (protocol-number literal +
  // servercount/attractloop/gamedir/clientnum/levelname, plus whatever extra
  // fields the concrete protocol's handshake carries). Added alongside the
  // 1038 codec (.orch/phase5-design.md phase 5): codec.ts's original header
  // comment excluded svc_serverdata from step 1's seam as "a one-time
  // connection-handshake literal, not a repeated per-frame wire encoding,
  // ... deferred to whenever the 1038 handshake is implemented" -- that's
  // now. VANILLA_CODEC's implementation is byte-identical to the inline
  // write it replaces in sv_user.ts's SV_New_f (see vanilla.ts).
  writeServerData(msg: SizeBuf, params: ServerDataParamsT): void;

  // Writes one entity_state_t delta (or a forced full state) as used by
  // both packetentities updates and spawn-baseline/demo dumps.
  writeDeltaEntity(msg: SizeBuf, from: EntityStateT, to: EntityStateT, force: boolean, newentity: boolean): void;

  // Writes the "entity present in the old frame, absent from the new one"
  // removal marker inside a packetentities stream.
  writeEntityRemove(msg: SizeBuf, oldnum: number): void;

  // Writes the packetentities stream terminator (bits=0, number=0).
  writePacketEntitiesEnd(msg: SizeBuf): void;

  // Writes one svc_spawnbaseline message body (tag byte + forced full delta
  // from a null entity_state_t).
  writeSpawnBaseline(msg: SizeBuf, base: EntityStateT): void;

  // Writes an svc_playerinfo player_state_t delta (pflags bitmask + changed
  // fields + stat bits).
  writePlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void;

  // ---- client -> server writes / server-side reads -----------------------

  // Writes one clc_move usercmd_t delta (bits byte + changed fields + msec +
  // lightlevel).
  writeDeltaUsercmd(msg: SizeBuf, from: UsercmdT, cmd: UsercmdT): void;

  // Reads one clc_move usercmd_t delta from a server-held buffer (the
  // client's outgoing move, as the server parses it).
  readDeltaUsercmd(msg: SizeBuf, from: UsercmdT, move: UsercmdT): void;

  // ---- client-side reads (net_message singleton; see asymmetry note) ----

  // Reads the leading bits/number prefix of an entity delta (MOREBITS chain
  // + 8/16-bit entity number).
  readEntityBits(): { number: number; bits: number };

  // Reads the field body of an entity delta into `to`, given the bits word
  // from readEntityBits() and the baseline/previous state to delta from.
  readDeltaEntity(from: EntityStateT, to: EntityStateT, number: number, bits: number): void;

  // Reads an svc_playerinfo player_state_t delta's wire fields into `to`.
  // Caller is responsible for seeding `to` from `from` first (matching
  // CL_ParsePlayerstate's copy-then-overwrite delta model) and for any
  // non-wire post-processing (e.g. CL_ParsePlayerstate's cl.attractloop ->
  // PM_FREEZE override, applied by the caller after this returns -- see
  // vanilla.ts's readPlayerStateDelta doc comment).
  readPlayerStateDelta(msg: SizeBuf, from: PlayerStateT, to: PlayerStateT): void;
}
