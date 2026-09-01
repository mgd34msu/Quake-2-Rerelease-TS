// sv_seats.ts -- LOCAL SPLITSCREEN SEATS, server side.
//
// This is an ORIGINAL module of this port, not a translation of any id /
// ZeniMax / Paril-KEX source file: there is no C original to cite a basename
// from, the same status src/client/menu_content.ts already carries. The
// reference audit behind that claim (2026-09-01, all three reference trees
// on this machine re-read for it):
//
//   * q2repro implements NO local splitscreen at all. Its own
//     src/client/cgame_classic.c:858 says so -- "Note: isplit is ignored,
//     due to missing split screen support" -- and its one call site,
//     src/client/screen.c:2019, passes literal 0 for both isplit and
//     playernum. There is exactly one refdef_t and one R_RenderFrame call
//     per screen update; no viewport-splitting code exists anywhere.
//   * quake2-rerelease-dll (the 2023 game+cgame source) specifies the
//     GAME-side contract only: hud_data[MAX_SPLIT_PLAYERS] indexed by
//     isplit (cg_screen.cpp:107), `isplit` distinct from `playernum` on
//     DrawHUD (game.h:2270), dupe_key's "prevent sending the message on
//     this frame with the same key to the same player (for splitscreen
//     players)" (game.h:1946-1949), and LAYOUTS_INTERMISSION's "collapse
//     splitscreen into 1 view" (game.h:1589). It computes NO layout: the
//     cgame only ever READS the hud_vrect it is handed.
//   * q2proto carries ONE playerstate per svc_frame
//     (q2proto_struct_svc.h:552) and no per-packet local-player index. The
//     kex protocol's own splitscreen signals are recognized only to be
//     refused: q2proto_proto_kex.c:56-57 rejects a serverdata clientnum of
//     -2 with "FIXME: -2 indicates split screen - don't support this at
//     all", and kex_client_read_splitclient (:798-804) reads the isplit
//     byte purely to keep the stream in sync and `(void)isplit;` throws it
//     away.
//
// WHY SEATS ARE SERVER CLIENTS RATHER THAN EXTRA CONNECTIONS
// ---------------------------------------------------------------------
// Two hard constraints, both established above:
//
//  1. The wire cannot carry a second local player. Every protocol family
//     this port speaks delivers exactly one playerstate per frame and one
//     move stream per connection. Adding a second would be inventing wire
//     format, which this port does not do (rule 20: protocol correctness is
//     verified against reference sources, so we may not author new opcodes).
//  2. The CLIENT is a singleton. `cl`/`cls`/`cl_entities` (client.ts) are
//     module-level state read by ~30k lines; there is no second client
//     instance to give a second seat, and manufacturing one is not a
//     splitscreen change, it is a client rearchitecture.
//
// So the seats past seat 0 are what they physically are on a listen server:
// ordinary additional server clients, sharing the machine and the process
// with the primary one, whose usercmds are handed to the game module
// directly (SV_LocalSeatThink -> ge.ClientThink) instead of arriving over a
// netchan, and whose playerstates are read back out of the game's own
// gclient (SV_LocalSeatPlayerState) instead of being decoded from a frame.
// This is the same slot machinery a coop connection already uses --
// ClientChooseSlot_Any hands out distinct player slots to distinct callers
// (kexgame/p_client.ts) -- with the network step removed because both ends
// are already in this process. test/splitscreen.test.ts's phase-7 scope
// ruling reached the same structural conclusion from the other direction:
// "on a PC engine, what a console calls the second splitscreen player is
// instead an ordinary second network client".
//
// Local seats are therefore LOCAL-GAME ONLY. There is no way to seat a
// second local player on a remote server without the wire support that
// q2proto explicitly refuses to implement, and this module never tries:
// SV_AddLocalSeat requires a running local server.

import { SysError } from "../qcommon/qcommon";
import { Com_DPrintf } from "../qcommon/common";
import { Cmd_TokenizeString } from "../qcommon/cmd";
import { SZ_Init, SZ_Clear } from "../qcommon/sizebuf";
import { UsercmdT, Info_SetValueForKey } from "../shared/q_shared";
import { vec3, type Vec3 } from "../shared/math";
import type { PlayerStateT } from "../shared/q_shared";
import type { GameExports } from "../game/game";
import { sv, svs, ServerStateT, ClientT, ClientStateT, maxclients, svClientHolder, svPlayerHolder } from "./server";
import { geHolder } from "./sv_game";
import { SV_UserinfoChanged } from "./sv_main";

/** Hard cap on local seats. Deliberately NOT MAX_SPLIT_PLAYERS (8): the
 *  reference constant is overloaded -- quake2-rerelease-dll uses it as the
 *  default value of `maxclients` (g_main.cpp:171) and as a "no more than 8
 *  players in coop" scratch-array bound (m_rogue_carrier.cpp:78-79) as much
 *  as it uses it for hud_data's per-split slots, so 8 is evidence for "8
 *  total players", not for "8-way local split". Four is what the 2023
 *  re-release actually offers on a console and what this port's viewport
 *  layouts cover. */
export const MAX_LOCAL_SEATS = 4;

class LocalSeatT {
  /** Index into svs.clients, i.e. the seat's player slot. -1 when unseated. */
  clientIndex = -1;
  client: ClientT | null = null;
  /* The seat's move for the next server frame, and any game command it
     queued, both parked here by the CLIENT (cl_seats.ts) and consumed by
     SV_RunLocalSeatThinks inside SV_Frame.

     WHY THE QUEUE EXISTS (found by the live 2-seat gate, not reasoned
     about): calling ge.ClientThink straight from the client's own frame ran
     the game's player think OUTSIDE SV_Frame. Anything the game wrote to
     `gi.multicast` during it -- a weapon effect, a spawn effect -- was
     stranded until the next server frame, whose SV_RunGameFrame tail then
     reported "Game left N bytes in multicast buffer, cleared" once per
     frame and threw the bytes away. Real clients never hit this because
     their moves are executed from SV_ReadPackets, INSIDE the frame that
     then flushes what the game wrote. Seats now land at exactly that same
     point. */
  pendingCmd: UsercmdT | null = null;
  pendingCommandText: string | null = null;
}

const local_seats: LocalSeatT[] = Array.from({ length: MAX_LOCAL_SEATS }, () => new LocalSeatT());
let num_local_seats = 0;

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_seats: ge used before SV_InitGameProgs");
  return ge;
}

/** How many EXTRA local seats are currently seated (seat 0 is the ordinary
 *  primary connection and is never owned by this module). */
export function SV_NumLocalSeats(): number {
  return num_local_seats;
}

export function SV_LocalSeatClient(seat: number): ClientT | null {
  const s = local_seats[seat];
  return s ? s.client : null;
}

/** The seat's player slot -- what the cgame's DrawHUD calls `playernum` and
 *  what an entity number is `playernum + 1` of. -1 when unseated. */
export function SV_LocalSeatPlayernum(seat: number): number {
  const s = local_seats[seat];
  return s ? s.clientIndex : -1;
}

function hasPlayerState(client: unknown): client is { ps: PlayerStateT } {
  return typeof client === "object" && client !== null && "ps" in client;
}

/** The seat's live playerstate, read straight out of the game module's own
 *  gclient. This is the local-server stand-in for "the playerstate the
 *  server would have written into this seat's frame" -- identical data, one
 *  delta-encode/decode round trip skipped because both ends are in this
 *  process. */
export function SV_LocalSeatPlayerState(seat: number): PlayerStateT | null {
  const client = SV_LocalSeatClient(seat);
  if (!client || !client.edict) return null;
  if (!hasPlayerState(client.edict.client)) return null;
  return client.edict.client.ps;
}

/** Eye origins of every seated local seat, in the same units SV_FatPVS
 *  wants. Used by SV_BuildClientFrame to widen the PRIMARY client's PVS to
 *  the union over all seats: all seats render out of the one entity list
 *  that connection carries, so an entity visible to seat 1 but not seat 0
 *  has to be in that list or seat 1's viewport would show holes. This is
 *  the same thing a real one-connection splitscreen engine must do, and it
 *  is the only server-side behavior change local seats cause. */
export function SV_LocalSeatViewOrigins(): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < MAX_LOCAL_SEATS; i++) {
    const ps = SV_LocalSeatPlayerState(i);
    if (!ps) continue;
    out.push(
      vec3(
        ps.pmove.origin[0] * 0.125 + ps.viewoffset[0],
        ps.pmove.origin[1] * 0.125 + ps.viewoffset[1],
        // Same re-release viewheight term SV_BuildClientFrame's own primary
        // origin carries (see that function for the q2repro citation).
        ps.pmove.origin[2] * 0.125 + ps.viewoffset[2] + ps.pmove.viewheight,
      ),
    );
  }
  return out;
}

/*
==================
SV_InitLocalSeatBuffers

A seat still RECEIVES server-to-client messages: ClientBegin alone sends the
seat its stufftexts and layout, and every frame after that the game unicasts
it prints, sounds and centerprints. Those writes go to the client's reliable
(netchan.message) and datagram buffers exactly as they would for a real
connection -- and both are unusable on a fresh ClientT, because SZ_Init is
only ever called on them by Netchan_Setup, which a seat never goes through.

FOUND LIVE, not reasoned about: without this the very first ge.ClientBegin
threw "SZ_GetSpace: overflow without allowoverflow set" the instant the game
tried to write to the seat, on a zero-capacity SizeBuf.

The buffers are real (so writes land somewhere valid), marked allowoverflow
(so a big spike is dropped instead of taking the server down -- a seat has no
connection to drop for a reliable overflow the way SV_SendClientMessages
would), and drained every frame by SV_RunLocalSeatThinks: nothing ever
transmits them, so without the drain they would fill up and stay full.

WHAT IS DISCARDED, STATED PLAINLY: server-to-seat messages are written and
thrown away. A seat's own centerprints, private sounds and layout updates do
not reach the screen in this deliverable -- the HUD each pane draws comes
from the seat's PLAYERSTATE (stats, which is where health/ammo/armor live)
plus the connection's shared layout, which is why a seat's HUD is correct
while its centerprints are not. Consuming this buffer per-seat is the
remaining work for full parity.
==================
*/
function SV_InitLocalSeatBuffers(client: ClientT): void {
  SZ_Init(client.netchan.message, client.netchan.message_buf, client.netchan.message_buf.length);
  client.netchan.message.allowoverflow = true;
  SZ_Init(client.datagram, client.datagram_buf, client.datagram_buf.length);
  client.datagram.allowoverflow = true;
}

/*
==================
SV_AddLocalSeat

Seats one additional local player. Mirrors the tail of SVC_DirectConnect
(sv_main.ts) -- free-slot search, clear(), edict binding, ge.ClientConnect,
SV_UserinfoChanged, ge.ClientBegin -- with the three network steps removed:
no challenge check, no Netchan_Setup, no client_connect out-of-band reply.
There is no address to challenge and no channel to set up; `isLocalSeat`
marks the client so the send loop never tries to transmit down the netchan
this client deliberately does not have.

Returns the seat index, or null when the seat could not be created (no local
server, seat table full, no free player slot, or the game module rejected
the connection).
==================
*/
export function SV_AddLocalSeat(userinfo: string): number | null {
  if (sv.state !== ServerStateT.ss_game) return null;

  const seat = local_seats.findIndex((s) => s.client === null);
  if (seat < 0) return null;

  // `maxclients` is CVAR_LATCH: a change made after SV_InitGame allocated
  // svs.clients is visible on the cvar but not yet in the array, so the
  // search bound is whichever is smaller. SVC_DirectConnect's own loop
  // trusts the cvar alone and would index past the end here.
  const maxc = Math.min(maxclients ? maxclients.value : 0, svs.clients.length);
  let newcl: ClientT | null = null;
  let newclIndex = -1;
  for (let i = 0; i < maxc; i++) {
    if (svs.clients[i].state === ClientStateT.cs_free) {
      newcl = svs.clients[i];
      newclIndex = i;
      break;
    }
  }
  if (!newcl) {
    Com_DPrintf("SV_AddLocalSeat: no free player slot\n");
    return null;
  }

  newcl.clear();
  newcl.isLocalSeat = true;
  // The connection-scoped codec is meaningless for a seat that never writes
  // a byte to a netchan, but it is read unconditionally by anything that
  // walks svs.clients, so it keeps the server's family default rather than
  // being left at whatever clear() produced.
  newcl.codec = svs.codec;
  svClientHolder.sv_client = newcl;

  const ge = requireGe();
  const ent = ge.edicts[newclIndex + 1];
  newcl.edict = ent;
  svPlayerHolder.sv_player = ent;

  // Force the same ip key SVC_DirectConnect forces, so a game module that
  // filters on it sees a well-formed value rather than an absent one.
  const connect = ge.ClientConnect(ent, Info_SetValueForKey(userinfo, "ip", "loopback"));
  if (!connect.allowed) {
    newcl.clear();
    Com_DPrintf("SV_AddLocalSeat: game rejected the seat\n");
    return null;
  }

  newcl.userinfo = connect.userinfo;
  SV_UserinfoChanged(newcl);

  newcl.state = ClientStateT.cs_spawned;
  newcl.lastmessage = svs.realtime;
  newcl.lastconnect = svs.realtime;

  SV_InitLocalSeatBuffers(newcl);

  ge.ClientBegin(ent);

  local_seats[seat].client = newcl;
  local_seats[seat].clientIndex = newclIndex;
  num_local_seats++;
  return seat;
}

/*
==================
SV_RemoveLocalSeats

Disconnects every extra local seat. Called when splitscreen stops, when the
primary client disconnects, and before a level change (the seats are re-added
against the NEW level's edicts once the primary is active again -- seat state
does not survive a map change any more than a real connection's edict does).
==================
*/
export function SV_RemoveLocalSeats(): void {
  const ge = geHolder.ge;
  for (const s of local_seats) {
    const client = s.client;
    s.client = null;
    s.clientIndex = -1;
    if (!client) continue;
    if (ge && client.edict && client.state === ClientStateT.cs_spawned) ge.ClientDisconnect(client.edict);
    client.clear();
    client.state = ClientStateT.cs_free;
  }
  num_local_seats = 0;
}

/*
==================
SV_LocalSeatThink

The seat's usercmd, handed to the game module. This is SV_ClientThink
(sv_user.ts) minus the commandMsec/sv_enforcetime time-cheat accounting: that
budget exists to catch a REMOTE client sending more command milliseconds than
wall-clock time allows, and a seat's commands are generated by this same
process on this same frame clock, so there is nothing to police and no
netchan whose arrival rate could be gamed.

`lastmessage` is refreshed here so SV_CheckTimeouts (sv_main.ts) never sees a
seat as a stalled connection -- a seat has no packets to time out on.
==================
*/
export function SV_LocalSeatThink(seat: number, cmd: UsercmdT): void {
  const client = SV_LocalSeatClient(seat);
  if (!client || !client.edict) return;
  if (client.state !== ClientStateT.cs_spawned) return;

  client.lastmessage = svs.realtime;
  client.lastcmd = cmd;

  svClientHolder.sv_client = client;
  svPlayerHolder.sv_player = client.edict;
  requireGe().ClientThink(client.edict, cmd);
}

/*
==================
SV_LocalSeatCommand

Runs a game-module client command ("weapnext", "weapprev", "inven", ...) as
the seat. This is the tail of SV_ExecuteUserCommand (sv_user.ts): tokenize,
point sv_client/sv_player at the issuing client, hand it to
ge.ClientCommand. The engine-side command table is deliberately NOT
consulted -- every command in it ("new", "configstrings", "begin",
"download", "disconnect", ...) is part of the connection handshake a seat
does not have, and a seat has no business driving one.
==================
*/
export function SV_LocalSeatCommand(seat: number, text: string): void {
  const client = SV_LocalSeatClient(seat);
  if (!client || !client.edict) return;
  if (client.state !== ClientStateT.cs_spawned) return;

  svClientHolder.sv_client = client;
  svPlayerHolder.sv_player = client.edict;
  Cmd_TokenizeString(text, true);
  requireGe().ClientCommand(client.edict);
}

/** Park a seat's move for the next server frame. Called from the client's
 *  own frame (cl_seats.ts), where the pad is read; consumed inside SV_Frame
 *  by SV_RunLocalSeatThinks. See LocalSeatT.pendingCmd for why the move is
 *  queued rather than executed on the spot. */
export function SV_QueueLocalSeatCmd(seat: number, cmd: UsercmdT, command: string | null = null): void {
  const s = local_seats[seat];
  if (!s || !s.client) return;
  s.pendingCmd = cmd;
  if (command) s.pendingCommandText = command;
}

/*
==================
SV_RunLocalSeatThinks

Every seated seat's queued move, executed at the same point in SV_Frame that
a real client's move is executed from (SV_ReadPackets -> SV_ExecuteClientMessage
-> SV_ClientThink), so the game's per-think writes are flushed by the same
frame that produced them.

sv_client/sv_player are restored afterwards: SV_ReadPackets leaves them
pointing at whichever client sent the last packet, and everything downstream
in this frame (SV_RunGameFrame and the game commands it may run) must not
suddenly find a seat there instead.
==================
*/
export function SV_RunLocalSeatThinks(): void {
  if (num_local_seats === 0) return;

  const savedClient = svClientHolder.sv_client;
  const savedPlayer = svPlayerHolder.sv_player;

  for (let i = 0; i < MAX_LOCAL_SEATS; i++) {
    const s = local_seats[i];
    if (!s.client) continue;

    // Drain last frame's server-to-seat writes; nothing transmits them.
    // See SV_InitLocalSeatBuffers for what this discards and why.
    SZ_Clear(s.client.netchan.message);
    s.client.netchan.message.overflowed = false;
    SZ_Clear(s.client.datagram);
    s.client.datagram.overflowed = false;

    const cmd = s.pendingCmd;
    s.pendingCmd = null;
    if (cmd) SV_LocalSeatThink(i, cmd);

    const text = s.pendingCommandText;
    s.pendingCommandText = null;
    if (text) SV_LocalSeatCommand(i, text);
  }

  svClientHolder.sv_client = savedClient;
  svPlayerHolder.sv_player = savedPlayer;
}

/** Test seam: drop the seat table without touching the game module (used by
 *  suites that fabricate clients directly and never ran ClientConnect). */
export function SV_ClearLocalSeatsForTests(): void {
  for (const s of local_seats) {
    s.client = null;
    s.clientIndex = -1;
  }
  num_local_seats = 0;
}
