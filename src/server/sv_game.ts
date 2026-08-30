// sv_game.c -- interface to the game dll
//
// There is no DLL boundary in this port (no Sys_GetGameAPI/Sys_UnloadGame in
// src/platform/sys.ts -- confirmed absent): SV_InitGameProgs resolves the
// "game" cvar and calls src/server/bindings/legacy.ts's LoadLegacyGame, which
// calls one of the four legacy game trees' GetGameAPI exports directly,
// in-process, instead of loading a shared library and calling through a
// function-pointer struct it returns. That binding module (see its own file
// header, and ARCHITECTURE.md's "Core model") owns the GameImports
// construction and the mission-pack GameExports bridge; this file owns the
// PF_* import callbacks the binding wires up, the apiversion check, and
// `geHolder`.
// `geHolder` is a plain mutable holder (see server.ts's `svClientHolder`/
// `svPlayerHolder` for the same pattern and rationale): tests inject a fake
// `GameExports` directly into `geHolder.ge` without needing SV_InitGameProgs
// to run first.
//
// server.h also forward-declares `void SV_InitEdict (edict_t *e);` under this
// file's section, but no server/*.c file in the v3.19 tree defines or calls
// it -- a dead declaration, dropped here along with it (see report).

import { type Vec3, VectorCopy, vec3_origin } from "../shared/math";
import { MulticastT } from "../shared/q_shared";
import { ERR_DROP, SvcOpsT } from "../qcommon/qcommon";
import { Com_Error, Com_Printf } from "../qcommon/common";
import {
  SZ_Clear,
  MSG_WriteChar,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteFloat,
  MSG_WriteString,
  MSG_WritePos,
  MSG_WriteDir,
  MSG_WriteAngle,
  SZ_Write,
} from "../qcommon/sizebuf";
import { Cvar_VariableString } from "../qcommon/cvar";
import { CM_InlineModel, CM_PointLeafnum, CM_LeafArea, CM_LeafCluster, CM_ClusterPVS, CM_ClusterPHS, CM_AreasConnected } from "../qcommon/cmodel";
import type { GameExports, Edict } from "../game/game";
import { GAME_API_VERSION } from "../game/game";
import { sv, svs, ServerStateT, maxclients } from "./server";
import { SV_Multicast, SV_ClientPrintf, SV_StartSound } from "./sv_send";
import { SV_ModelIndex } from "./sv_init";
import { SV_LinkEdict } from "./sv_world";
import { LoadLegacyGame } from "./bindings/legacy";

export const geHolder: { ge: GameExports | null } = { ge: null };

/*
===============
PF_Unicast

Sends the contents of the mutlicast buffer to a single client
===============
*/
export function PF_Unicast(ent: Edict | null, reliable: boolean): void {
  if (!ent) return;

  const p = ent.s.number; // NUM_FOR_EDICT(ent)
  const maxc = maxclients ? maxclients.value : 0;
  if (p < 1 || p > maxc) return;

  const client = svs.clients[p - 1];

  if (reliable) SZ_Write(client.netchan.message, sv.multicast.data, sv.multicast.cursize);
  else SZ_Write(client.datagram, sv.multicast.data, sv.multicast.cursize);

  SZ_Clear(sv.multicast);
}

/*
===============
PF_dprintf

Debug print to server console

The C original formats via vsprintf into a local buffer; GameImports.dprintf
takes a single already-formatted `fmt` string (the game module formats with
Com_sprintf on its side of the boundary before calling gi.dprintf), so no
varargs plumbing is needed here.
===============
*/
export function PF_dprintf(fmt: string): void {
  Com_Printf("%s", fmt);
}

/*
===============
PF_cprintf

Print to a single client
===============
*/
export function PF_cprintf(ent: Edict | null, level: number, fmt: string): void {
  let n = 0;

  if (ent) {
    n = ent.s.number; // NUM_FOR_EDICT(ent)
    const maxc = maxclients ? maxclients.value : 0;
    if (n < 1 || n > maxc) Com_Error(ERR_DROP, "cprintf to a non-client");
  }

  if (ent) SV_ClientPrintf(svs.clients[n - 1], level, "%s", fmt);
  else Com_Printf("%s", fmt);
}

/*
===============
PF_centerprintf

centerprint to a single client
===============
*/
export function PF_centerprintf(ent: Edict, fmt: string): void {
  const n = ent.s.number; // NUM_FOR_EDICT(ent)
  const maxc = maxclients ? maxclients.value : 0;
  if (n < 1 || n > maxc) return; // Com_Error (ERR_DROP, "centerprintf to a non-client");

  MSG_WriteByte(sv.multicast, SvcOpsT.svc_centerprint);
  MSG_WriteString(sv.multicast, fmt);
  PF_Unicast(ent, true);
}

/*
===============
PF_error

Abort the server with a game error
===============
*/
export function PF_error(fmt: string): never {
  Com_Error(ERR_DROP, "Game Error: %s", fmt);
}

/*
=================
PF_setmodel

Also sets mins and maxs for inline bmodels
=================
*/
export function PF_setmodel(ent: Edict, name: string): void {
  if (!name) Com_Error(ERR_DROP, "PF_setmodel: NULL");

  const i = SV_ModelIndex(name);

  ent.s.modelindex = i;

  // if it is an inline model, get the size information for it
  if (name[0] === "*") {
    const mod = CM_InlineModel(name);
    VectorCopy(mod.mins, ent.mins);
    VectorCopy(mod.maxs, ent.maxs);
    SV_LinkEdict(ent);
  }
}

/*
===============
PF_Configstring

===============
*/
export function PF_Configstring(index: number, val: string): void {
  if (index < 0 || index >= svs.csr.end) Com_Error(ERR_DROP, "configstring: bad index %i\n", index);

  // change the string in sv
  sv.configstrings[index] = val;

  if (sv.state !== ServerStateT.ss_loading) {
    // send the update to everyone
    SZ_Clear(sv.multicast);
    MSG_WriteChar(sv.multicast, SvcOpsT.svc_configstring);
    MSG_WriteShort(sv.multicast, index);
    MSG_WriteString(sv.multicast, val);

    SV_Multicast(vec3_origin, MulticastT.MULTICAST_ALL_R);
  }
}

export function PF_WriteChar(c: number): void {
  MSG_WriteChar(sv.multicast, c);
}
export function PF_WriteByte(c: number): void {
  MSG_WriteByte(sv.multicast, c);
}
export function PF_WriteShort(c: number): void {
  MSG_WriteShort(sv.multicast, c);
}
export function PF_WriteLong(c: number): void {
  MSG_WriteLong(sv.multicast, c);
}
export function PF_WriteFloat(f: number): void {
  MSG_WriteFloat(sv.multicast, f);
}
export function PF_WriteString(s: string): void {
  MSG_WriteString(sv.multicast, s);
}
export function PF_WritePos(pos: Vec3): void {
  MSG_WritePos(sv.multicast, pos);
}
export function PF_WriteDir(dir: Vec3): void {
  MSG_WriteDir(sv.multicast, dir);
}
export function PF_WriteAngle(f: number): void {
  MSG_WriteAngle(sv.multicast, f);
}

/*
=================
PF_inPVS

Also checks portalareas so that doors block sight
=================
*/
export function PF_inPVS(p1: Vec3, p2: Vec3): boolean {
  let leafnum = CM_PointLeafnum(p1);
  const cluster = CM_LeafCluster(leafnum);
  const area1 = CM_LeafArea(leafnum);
  const mask = CM_ClusterPVS(cluster);

  leafnum = CM_PointLeafnum(p2);
  const cluster2 = CM_LeafCluster(leafnum);
  const area2 = CM_LeafArea(leafnum);
  if (mask && !(mask[cluster2 >> 3] & (1 << (cluster2 & 7)))) return false;
  if (!CM_AreasConnected(area1, area2)) return false; // a door blocks sight
  return true;
}

/*
=================
PF_inPHS

Also checks portalareas so that doors block sound
=================
*/
export function PF_inPHS(p1: Vec3, p2: Vec3): boolean {
  let leafnum = CM_PointLeafnum(p1);
  const cluster = CM_LeafCluster(leafnum);
  const area1 = CM_LeafArea(leafnum);
  const mask = CM_ClusterPHS(cluster);

  leafnum = CM_PointLeafnum(p2);
  const cluster2 = CM_LeafCluster(leafnum);
  const area2 = CM_LeafArea(leafnum);
  if (mask && !(mask[cluster2 >> 3] & (1 << (cluster2 & 7)))) return false; // more than one bounce away
  if (!CM_AreasConnected(area1, area2)) return false; // a door blocks hearing

  return true;
}

export function PF_StartSound(entity: Edict | null, channel: number, sound_num: number, volume: number, attenuation: number, timeofs: number): void {
  if (!entity) return;
  SV_StartSound(null, entity, channel, sound_num, volume, attenuation, timeofs);
}

//==============================================

/*
===============
SV_ShutdownGameProgs

Called when either the entire server is being killed, or
it is changing to a different game directory.
===============
*/
export function SV_ShutdownGameProgs(): void {
  if (!geHolder.ge) return;
  geHolder.ge.Shutdown();
  // Sys_UnloadGame() -- omitted: no DLL boundary in this port (see this
  // file's header comment and SV_InitGameProgs below).
  geHolder.ge = null;
}

/*
===============
SV_InitGameProgs

Init the game subsystem for a new map
===============
*/
export function SV_InitGameProgs(): void {
  // unload anything we have now
  if (geHolder.ge) SV_ShutdownGameProgs();

  // load a new game dll -- in this port, "load" means calling one of the
  // legacy binding's GetGameAPI exports directly (see header comment and
  // src/server/bindings/legacy.ts); there is no function-pointer struct
  // returned across a real DLL boundary to null-check afterward, so the C
  // `if (!ge) Com_Error(...)` branch is dead here and dropped (GetGameAPI's
  // return type guarantees a real GameExports).
  //
  // Runtime game-track selection: the C engine loads gamex86.dll (or the
  // platform equivalent) out of the directory named by the "game" cvar
  // (FS_Gamedir()) -- there is no DLL to load in this port, so the "game"
  // cvar instead picks which statically-imported GetGameAPI LoadLegacyGame
  // calls (see that function's comment for the structural-typing details of
  // the mission-pack bridge).
  const gameName = Cvar_VariableString("game");
  const ge = LoadLegacyGame(gameName);

  if (ge.apiversion !== GAME_API_VERSION) {
    Com_Error(ERR_DROP, "game is version %i, not %i", ge.apiversion, GAME_API_VERSION);
  }

  geHolder.ge = ge;

  ge.Init();
}
