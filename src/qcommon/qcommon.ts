// qcommon.h -- definitions common between client and server, but not game.dll
//
// Only the pieces that cross module boundaries in this port are ported here:
// PROTOCOL, sizebuf-adjacent constants, svc_/clc_ ops, NET types, MISC error
// codes, and the ComError/SysError exception classes used in place of
// Com_Error()/Sys_Error()'s longjmp/exit control flow.
//
// PRINT_ALL/PRINT_DEVELOPER are already defined (with matching values) in
// src/shared/q_shared.ts, which q_shared.h ports; re-exported here rather than
// redefined, since qcommon.h's copy is a duplicate of the same constants.

export { PRINT_ALL, PRINT_DEVELOPER } from "../shared/q_shared";

export const VERSION = 3.21;
// This port's own release identity, drawn in the console corner where the
// C drew "v%4.2f" VERSION (console.c Con_DrawConsole). VERSION above stays
// 3.21 untouched -- protocol/compat code still keys off it.
export const APP_VERSION_STRING = "Quake 2 Re-release Typescript v1.0.1";
export const BASEDIRNAME = "baseq2";

// #ifdef WIN32/__linux__/... BUILDSTRING/CPUSTRING selection dropped; this
// port only targets one portable build identity (see PORTING.md idiom map).
export const BUILDSTRING = "TypeScript";
export const CPUSTRING = "portable";

//============================================================================
// PROTOCOL

export const PROTOCOL_VERSION = 34;

// PROTOCOL_VERSION_RERELEASE (qsrc/q2repro/inc/common/protocol.h:32) -- the
// 1038 wire format q2proto's q2repro codec implements (see
// src/qcommon/protocol/q2repro.ts). Hosted here alongside PROTOCOL_VERSION
// (rather than staying q2repro.ts's private duplicate) so cl_parse.ts's
// CL_ParseServerData can select a codec/csr off the same literal q2repro.ts
// writes onto the wire.
export const PROTOCOL_VERSION_RERELEASE = 1038;

// PROTOCOL_VERSION_RERELEASE_CLASSIC -- THIS ENGINE'S OWN protocol number, not
// one q2proto/Q2PRO/R1Q2/q2repro ever defines. It is byte-for-byte the SAME
// wire format as 1038 (the exact same q2repro.ts codec writes and reads every
// message; only the protocol long inside svc_serverdata differs), and exists
// for one reason: to tell a connecting client "this server carries wide model/
// sound/image/entity indices, but the game module producing them is the
// CLASSIC one (src/game), not the rerelease module (src/kexgame)".
//
// WHY THAT NEEDS ITS OWN NUMBER. The configstring layout (svs.csr / cls.csr)
// and the game module used to be the same axis in this engine, so the client
// could infer the module from the layout: wide layout => kex module. This
// engine now separates them -- a classic-module session escalates to the wide
// configstring layout whenever the map it is loading needs more than the
// classic family's 256 models/sounds/images (sv_init.ts's
// SV_WidenConfigstringSpace) -- so the inference no longer holds, and two
// client-side decisions that genuinely depend on WHICH GAME MODULE is running
// (cl_fx.ts's monster_flash_offset table, and which cgame/HUD cl_parse.ts
// activates) would silently pick the rerelease answers for a classic session.
// Carrying the fact in the protocol number is the only channel that (a) our
// client sees BEFORE it must make those decisions (it is the first long of
// svc_serverdata) and (b) cannot corrupt any other implementation: a real
// q2repro/Q2PRO/R1Q2/vanilla client that does not know this number rejects
// the connection cleanly with its own version check instead of misparsing a
// stream it was never meant to read.
//
// The value is deliberately far outside every published protocol number
// (34/35/36/37, R1Q2 1903-1905, Q2PRO 1015-1024+, q2repro 1038, KEX demos
// 2022/2023, MVD 2009-2013/3038) so it cannot collide with a future upstream
// bump.
export const PROTOCOL_VERSION_RERELEASE_CLASSIC = 4038;

// R1Q2 protocol family (protocol 35) and Q2PRO protocol family (protocol 36)
// -- v1.0.0 wire cluster (task board #23), Mike's ruling: our server accepts
// classic community clients and our client joins classic community servers.
// Minor-version ladders per q2proto_internal_protocol.h (q2proto, the
// reference library these two codecs -- src/qcommon/protocol/r1q2.ts and
// q2pro.ts -- are ported from).
export const PROTOCOL_VERSION_R1Q2 = 35;
export const PROTOCOL_VERSION_R1Q2_MINIMUM = 1903;
// clc_move gains optional 1-byte forward/angle1 fields (BUTTON_UCMD_DBLFORWARD
// / BUTTON_UCMD_DBL_ANGLE1) at this minor version and above.
export const PROTOCOL_VERSION_R1Q2_UCMD = 1904;
// U_SOLID widens from a u16 cmodel-index short to a u32 packed bbox at this
// minor version and above (q2proto_proto_r1q2.c's `has_solid32` feature).
export const PROTOCOL_VERSION_R1Q2_LONG_SOLID = 1905;
export const PROTOCOL_VERSION_R1Q2_CURRENT = 1905;

export const PROTOCOL_VERSION_Q2PRO = 36;
export const PROTOCOL_VERSION_Q2PRO_MINIMUM = 1015;
// This port implements Q2PRO's "plain" (non-extended, game_api == VANILLA)
// wire tier only -- see q2pro.ts's file header for the documented scope cut
// (no U_ANGLE16/U_MODEL16/U_MOREFX/U_ALPHA/U_SCALE entity-delta extensions,
// no EPS_CLIENTNUM/PS_MOREBITS/PLAYERFOG playerstate extensions, no
// svc_q2pro_gamestate/configstringstream/baselinestream bulk-transfer
// opcodes, no PROTOCOL_VERSION_Q2PRO_EXTENDED_LIMITS-and-up q2pro_flags word).
// Negotiated client versions are clamped to this ceiling; the server always
// advertises game_api == VANILLA in serverdata, which is how a real Q2PRO
// client is told to fall back to the plain wire format regardless of its own
// maximum supported version.
export const PROTOCOL_VERSION_Q2PRO_SERVER_STATE = 1019;
export const PROTOCOL_VERSION_Q2PRO_CURRENT = PROTOCOL_VERSION_Q2PRO_SERVER_STATE;

// Shared player_state_t "extraflags" byte (EPS_*) introduced by R1Q2 and
// inherited unchanged by Q2PRO (q2proto_internal_protocol.h) -- travels
// through the frame envelope's opcode high bits + suppress_count's high
// nibble, NOT as its own MSG_WriteByte call (see r1q2.ts/q2pro.ts writeFrame
// for the exact packing/unpacking).
export const EPS_GUNOFFSET = 1 << 0;
export const EPS_GUNANGLES = 1 << 1;
export const EPS_M_VELOCITY2 = 1 << 2;
export const EPS_M_ORIGIN2 = 1 << 3;
export const EPS_VIEWANGLE2 = 1 << 4;
export const EPS_STATS = 1 << 5;

// svc_r1q2_zpacket -- shared opcode value used identically by both R1Q2 and
// Q2PRO (q2proto_internal_maybe_zpacket.c); numerically the same slot KEX
// uses for its own unrelated svc_splitclient opcode (both families start
// their private opcode range at svc_frame+1 == 21; only one family's codec is
// ever active per connection, so the numeric overlap is safe -- same pattern
// already established for svc_sound/svc_temp_entity's cls.codec branches in
// cl_parse.ts).
export const SVC_ZPACKET = 21;

export const PORT_MASTER = 27900;
export const PORT_CLIENT = 27901;
export const PORT_SERVER = 27910;

export const UPDATE_BACKUP = 16; // copies of entity_state_t to keep buffered, must be power of two
export const UPDATE_MASK = UPDATE_BACKUP - 1;

// server to client
export enum SvcOpsT {
  svc_bad,

  // these ops are known to the game dll
  svc_muzzleflash,
  svc_muzzleflash2,
  svc_temp_entity,
  svc_layout,
  svc_inventory,

  // the rest are private to the client and server
  svc_nop,
  svc_disconnect,
  svc_reconnect,
  svc_sound, // <see code>
  svc_print, // [byte] id [string] null terminated string
  svc_stufftext, // [string] stuffed into client's console buffer, should be \n terminated
  svc_serverdata, // [long] protocol ...
  svc_configstring, // [short] [string]
  svc_spawnbaseline,
  svc_centerprint, // [string] to put in center of the screen
  svc_download, // [short] size [size bytes]
  svc_playerinfo, // variable
  svc_packetentities, // [...]
  svc_deltapacketentities, // [...]
  svc_frame,
}

// client to server. Numeric values match q2proto_internal_protocol.h's
// `enum common_clc_cmds` exactly (the gap at 6-9 is skipped -- not
// implemented by this port; the numbering gap is deliberate, not a mistake,
// so the three Q2PRO/q2repro batched-move opcodes below keep q2proto's real
// wire values).
export enum ClcOpsT {
  clc_bad,
  clc_nop,
  clc_move, // [[usercmd_t]
  clc_userinfo, // [[userinfo string]
  clc_stringcmd, // [string] message
  // R1Q2/Q2PRO/q2repro client setting push (index/value pair, e.g.
  // CLS_NOGUN/CLS_NOPREDICT/CLS_FPS -- qsrc/q2repro/inc/common/protocol.h's
  // clientSetting_t). Phase-8 interop finding (NOT predicted by static
  // analysis -- caught by a live capture's raw opcode byte): a real q2repro
  // client sends this immediately after entering the game, BEFORE any
  // movement packet, so it blocked cell (a)/(c) exactly like the batched-
  // move opcodes below did. See qcommon/protocol/codec.ts's
  // readClientSetting doc comment.
  clc_r1q2_setting = 5,
  // Q2PRO (protocol 36) and q2repro (protocol 1038) client commands --
  // src/qcommon/protocol/clc_batch_move.ts decodes the wire body;
  // src/server/sv_user.ts's SV_ExecuteClientMessage dispatches them.
  clc_q2pro_move_nodelta = 10,
  clc_q2pro_move_batched,
  clc_q2pro_userinfo_delta,
}

// user_cmd_t communication -- ms and light always sent, the others are optional
export const CM_ANGLE1 = 1 << 0;
export const CM_ANGLE2 = 1 << 1;
export const CM_ANGLE3 = 1 << 2;
export const CM_FORWARD = 1 << 3;
export const CM_SIDE = 1 << 4;
export const CM_UP = 1 << 5;
export const CM_BUTTONS = 1 << 6;
export const CM_IMPULSE = 1 << 7;

// entity_state_t communication -- try to pack the common update flags into the first byte
export const U_ORIGIN1 = 1 << 0;
export const U_ORIGIN2 = 1 << 1;
export const U_ANGLE2 = 1 << 2;
export const U_ANGLE3 = 1 << 3;
export const U_FRAME8 = 1 << 4; // frame is a byte
export const U_EVENT = 1 << 5;
export const U_REMOVE = 1 << 6; // REMOVE this entity, don't add it
export const U_MOREBITS1 = 1 << 7; // read one additional byte

// second byte
export const U_NUMBER16 = 1 << 8; // NUMBER8 is implicit if not set
export const U_ORIGIN3 = 1 << 9;
export const U_ANGLE1 = 1 << 10;
export const U_MODEL = 1 << 11;
export const U_RENDERFX8 = 1 << 12; // fullbright, etc
export const U_EFFECTS8 = 1 << 14; // autorotate, trails, etc
export const U_MOREBITS2 = 1 << 15; // read one additional byte

// third byte
export const U_SKIN8 = 1 << 16;
export const U_FRAME16 = 1 << 17; // frame is a short
export const U_RENDERFX16 = 1 << 18; // 8 + 16 = 32
export const U_EFFECTS16 = 1 << 19; // 8 + 16 = 32
export const U_MODEL2 = 1 << 20; // weapons, flags, etc
export const U_MODEL3 = 1 << 21;
export const U_MODEL4 = 1 << 22;
export const U_MOREBITS3 = 1 << 23; // read one additional byte

// fourth byte
export const U_OLDORIGIN = 1 << 24; // FIXME: get rid of this
export const U_SKIN16 = 1 << 25;
export const U_SOUND = 1 << 26;
export const U_SOLID = 1 << 27;

// player_state_t communication -- delta flags for the playerstate portion of
// svc_playerinfo. Was hand-duplicated as file-local consts in
// src/server/sv_ents.ts and src/client/cl_ents.ts; consolidated here per
// Phase-2 sequencing item 4.
export const PS_M_TYPE = 1 << 0;
export const PS_M_ORIGIN = 1 << 1;
export const PS_M_VELOCITY = 1 << 2;
export const PS_M_TIME = 1 << 3;
export const PS_M_FLAGS = 1 << 4;
export const PS_M_GRAVITY = 1 << 5;
export const PS_M_DELTA_ANGLES = 1 << 6;
export const PS_VIEWOFFSET = 1 << 7;
export const PS_VIEWANGLES = 1 << 8;
export const PS_KICKANGLES = 1 << 9;
export const PS_BLEND = 1 << 10;
export const PS_FOV = 1 << 11;
export const PS_WEAPONINDEX = 1 << 12;
export const PS_WEAPONFRAME = 1 << 13;
export const PS_RDFLAGS = 1 << 14;
// Q2rePRO (protocol 1038) only: re-release eye height, an i8 written after
// gunrate. q2proto_internal_protocol.h:263 (`#define PS_RR_VIEWHEIGHT
// BIT(15) // Q2rePRO`); Q2PRO's extended protocols spend the SAME bit on
// PS_MOREBITS instead (:264), so only protocol/q2repro.ts may use this name.
export const PS_RR_VIEWHEIGHT = 1 << 15;

//==============================================================
// CMD

export const EXEC_NOW = 0; // don't return until completed
export const EXEC_INSERT = 1; // insert at current position, but don't run yet
export const EXEC_APPEND = 2; // add to end of the command buffer

//==============================================================
// NET

export const PORT_ANY = -1;

export const MAX_MSGLEN = 1400; // max length of a message
export const PACKET_HEADER = 10; // two ints and a short

export enum NetadrtypeT {
  NA_LOOPBACK,
  NA_BROADCAST,
  NA_IP,
  NA_IPX,
  NA_BROADCAST_IPX,
}

export enum NetsrcT {
  NS_CLIENT,
  NS_SERVER,
}

export class NetadrT {
  type: NetadrtypeT = NetadrtypeT.NA_LOOPBACK;
  ip: Uint8Array = new Uint8Array(4);
  ipx: Uint8Array = new Uint8Array(10);
  port = 0;
}

//==============================================================
// MISC

export const ERR_FATAL = 0; // exit the entire game with a popup window
export const ERR_DROP = 1; // print to console and disconnect from game
export const ERR_QUIT = 2; // not an error, just a normal exit

// ComError -- Com_Error(ERR_DROP | ERR_DISCONNECT, ...) / longjmp(abortframe)
// recovery, per PORTING.md's idiom map. Thrown by common.ts, meant to be
// caught by the future Qcommon_Frame in src/main.ts.
export class ComError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = "ComError";
  }
}

// SysError -- Sys_Error(...) calls (both direct and Com_Error's ERR_FATAL/
// default fallthrough, which itself ends in Sys_Error("%s", msg)).
export class SysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SysError";
  }
}
