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
export const BASEDIRNAME = "baseq2";

// #ifdef WIN32/__linux__/... BUILDSTRING/CPUSTRING selection dropped; this
// port only targets one portable build identity (see PORTING.md idiom map).
export const BUILDSTRING = "TypeScript";
export const CPUSTRING = "portable";

//============================================================================
// PROTOCOL

export const PROTOCOL_VERSION = 34;

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

// client to server
export enum ClcOpsT {
  clc_bad,
  clc_nop,
  clc_move, // [[usercmd_t]
  clc_userinfo, // [[userinfo string]
  clc_stringcmd, // [string] message
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
