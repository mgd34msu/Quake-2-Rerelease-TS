// sv_game.c -- interface to the game dll
//
// There is no DLL boundary in this port (no Sys_GetGameAPI/Sys_UnloadGame in
// src/platform/sys.ts -- confirmed absent): SV_InitGameProgs calls
// src/game/g_main.ts's GetGameAPI directly, in-process, instead of loading a
// shared library and calling through a function-pointer struct it returns.
// `geHolder` is a plain mutable holder (see server.ts's `svClientHolder`/
// `svPlayerHolder` for the same pattern and rationale): tests inject a fake
// `GameExports` directly into `geHolder.ge` without needing SV_InitGameProgs
// to run first.
//
// server.h also forward-declares `void SV_InitEdict (edict_t *e);` under this
// file's section, but no server/*.c file in the v3.19 tree defines or calls
// it -- a dead declaration, dropped here along with it (see report).

import { type Vec3, VectorCopy, vec3_origin } from "../shared/math";
import { MulticastT, MAX_CONFIGSTRINGS } from "../shared/q_shared";
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
import { Cvar_Get, Cvar_Set, Cvar_ForceSet, Cvar_VariableString } from "../qcommon/cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_Args } from "../qcommon/cmd";
import { Cbuf_AddText } from "../qcommon/cmd";
import { CM_InlineModel, CM_PointLeafnum, CM_LeafArea, CM_LeafCluster, CM_ClusterPVS, CM_ClusterPHS, CM_AreasConnected, CM_SetAreaPortalState } from "../qcommon/cmodel";
import { Pmove } from "../qcommon/pmove";
import type { GameExports, GameImports, Edict } from "../game/game";
import { GAME_API_VERSION } from "../game/game";
import { GetGameAPI } from "../game/g_main";
import type { GameExports as CtfGameExports } from "../ctf/game";
// The C engine picks the game DLL by loading gamex86.dll (or the platform
// equivalent) out of the mod directory named by the "game" cvar (FS_Gamedir()
// / Sys_GetGameAPI(), sv_main.c/sys_*.c) -- there is no DLL boundary in this
// port (see this file's header comment), so both game tracks are statically
// imported here and SV_InitGameProgs picks between their GetGameAPI exports
// by reading the same "game" cvar directly, in-process, instead of loading a
// shared library from a mod directory.
import { GetGameAPI as CTF_GetGameAPI } from "../ctf/g_main";
import { GetGameAPI as XATRIX_GetGameAPI } from "../xatrix/g_main";
import { GetGameAPI as ROGUE_GetGameAPI } from "../rogue/g_main";
import type { GameExports as XatrixGameExports } from "../xatrix/game";
import type { GameExports as RogueGameExports } from "../rogue/game";
import { sv, svs, ServerStateT, maxclients } from "./server";
import { SV_BroadcastPrintf, SV_Multicast, SV_ClientPrintf, SV_StartSound } from "./sv_send";
import { SV_ModelIndex, SV_SoundIndex, SV_ImageIndex } from "./sv_init";
import { SV_LinkEdict, SV_UnlinkEdict, SV_AreaEdicts, SV_Trace, SV_PointContents } from "./sv_world";

export const geHolder: { ge: GameExports | null } = { ge: null };

// Runtime game-track selection (see SV_InitGameProgs below): src/ctf/game.ts's
// GameExports is NOT structurally assignable to src/game/game.ts's GameExports
// wholesale -- ctf/g_local.ts's GClientT/EdictT classes add ctf-only fields
// (ctf_team, ctf_grapple, menu, ...), and GameExports.edicts: EdictT[] plus
// item-callback fields (gitem_t.pickup(ent: EdictT, ...)) embed that
// track-specific EdictT/GClientT type, so the two GameExports shapes fail
// structural assignment in both directions once TS walks into those nested
// callback parameter types (contravariance) -- confirmed by trying a plain
// union type for `geHolder.ge`, which surfaced the exact mismatch and, worse,
// broke sv_ccmds.ts/sv_init.ts/sv_main.ts/sv_user.ts's own `const ge:
// GameExports = geHolder.ge` annotations (files outside this unit's SCOPE).
// adaptCtfGameExports bridges the gap for every member that only crosses the
// track boundary through the shared, track-agnostic `Edict` interface (which
// -- unlike EdictT/GClientT -- is identical between src/game/game.ts and
// src/ctf/game.ts: same fields, `client: unknown`, no self-referential
// EdictT/GClientT typed members), which covers every GameExports member
// except edicts/num_edicts/max_edicts.
//
// Known limitation (reported, not silently patched): edicts/num_edicts/
// max_edicts stay at GetGameAPI's own zero-initialized defaults ([]/0/0) on
// the ctf branch, same as the base track's GetGameAPI starts them (see
// g_main.ts's own GameExports comment) -- but the base track's InitGame
// mutates them live afterward via the `globals`/`exportsObj` object-identity
// trick (g_local.ts's SetGameExports keeps `globals` and the returned
// GameExports the same object), and ctf's InitGame does the identical thing
// to *its own* ctf-typed GameExports object, which this adapter cannot
// re-expose as base-typed EdictT[] without either an `as` cast (forbidded by
// this port's rule 2) or editing src/game/game.ts's/src/ctf/game.ts's
// `edicts: EdictT[]` field to the shared `Edict[]` type (out of this unit's
// SCOPE, which covers sv_game.ts's selection only). Net effect: ctf's Init/
// Shutdown/SpawnEntities/ClientConnect/ClientBegin/ClientUserinfoChanged/
// ClientDisconnect/ClientCommand/ClientThink/RunFrame/ServerCommand/WriteGame/
// ReadGame/WriteLevel/ReadLevel all genuinely run ctf's implementations; the
// world-entity list exposed through `geHolder.ge.edicts` for server-side
// netcode (sv_ents.ts et al.) does not yet reflect ctf's live entities.
// Follow-up: change `edicts: EdictT[]` to `edicts: Edict[]` in both
// src/game/game.ts and src/ctf/game.ts (Edict is already what every
// consumer's actual field access needs) to close this gap.
// the mission packs share ctf's adapter shape: their GameImports are
// structurally identical to the base game's, their GameExports objects are
// mutated in place by their own InitGame, and the live getters below keep
// the bridge current. One adapter serves all three pack tracks; the union
// parameter works because the three interfaces are structurally identical
// in every member the adapter touches.
function adaptPackGameExports(ctfGe: CtfGameExports | XatrixGameExports | RogueGameExports): GameExports {
  return {
    apiversion: ctfGe.apiversion,
    Init: () => ctfGe.Init(),
    Shutdown: () => ctfGe.Shutdown(),
    SpawnEntities: (mapname, entstring, spawnpoint) => ctfGe.SpawnEntities(mapname, entstring, spawnpoint),
    WriteGame: (filename, autosave) => ctfGe.WriteGame(filename, autosave),
    ReadGame: (filename) => ctfGe.ReadGame(filename),
    WriteLevel: (filename) => ctfGe.WriteLevel(filename),
    ReadLevel: (filename) => ctfGe.ReadLevel(filename),
    ClientConnect: (ent, userinfo) => ctfGe.ClientConnect(ent, userinfo),
    ClientBegin: (ent) => ctfGe.ClientBegin(ent),
    ClientUserinfoChanged: (ent, userinfo) => ctfGe.ClientUserinfoChanged(ent, userinfo),
    ClientDisconnect: (ent) => ctfGe.ClientDisconnect(ent),
    ClientCommand: (ent) => ctfGe.ClientCommand(ent),
    ClientThink: (ent, cmd) => ctfGe.ClientThink(ent, cmd),
    RunFrame: () => ctfGe.RunFrame(),
    ServerCommand: () => ctfGe.ServerCommand(),
    // live delegation: ctf's InitGame mutates its own GameExports object
    // in place (globals identity trick); getters keep this adapter current.
    get edicts() {
      return ctfGe.edicts;
    },
    get num_edicts() {
      return ctfGe.num_edicts;
    },
    set num_edicts(v: number) {
      ctfGe.num_edicts = v;
    },
    get max_edicts() {
      return ctfGe.max_edicts;
    },
    set max_edicts(v: number) {
      ctfGe.max_edicts = v;
    },
  };
}

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
  if (index < 0 || index >= MAX_CONFIGSTRINGS) Com_Error(ERR_DROP, "configstring: bad index %i\n", index);

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
function DebugGraphNoop(_value: number, _color: number): void {
  // SCR_DebugGraph is only forward-declared in sv_game.c (`void
  // SCR_DebugGraph (float value, int color);`) and never defined by any
  // server/*.c file in this tree -- it is client render/debug-overlay code
  // (src/client/scr_main.ts territory, not yet ported, and arguably not
  // applicable to a headless/dedicated engine at all). No-op per brief.
}

export function SV_InitGameProgs(): void {
  // unload anything we have now
  if (geHolder.ge) SV_ShutdownGameProgs();

  // load a new game dll -- in this port, "load" means calling GetGameAPI
  // directly (see header comment); there is no function-pointer struct
  // returned across a real DLL boundary to null-check afterward, so the C
  // `if (!ge) Com_Error(...)` branch is dead here and dropped (GetGameAPI's
  // return type guarantees a real GameExports).
  const importsObj: GameImports = {
    multicast: SV_Multicast,
    unicast: PF_Unicast,
    bprintf: SV_BroadcastPrintf,
    dprintf: PF_dprintf,
    cprintf: PF_cprintf,
    centerprintf: PF_centerprintf,
    error: PF_error,

    linkentity: SV_LinkEdict,
    unlinkentity: SV_UnlinkEdict,
    BoxEdicts: SV_AreaEdicts,
    trace: SV_Trace,
    pointcontents: SV_PointContents,
    setmodel: PF_setmodel,
    inPVS: PF_inPVS,
    inPHS: PF_inPHS,
    Pmove,

    modelindex: SV_ModelIndex,
    soundindex: SV_SoundIndex,
    imageindex: SV_ImageIndex,

    configstring: PF_Configstring,
    sound: PF_StartSound,
    positioned_sound: SV_StartSound,

    WriteChar: PF_WriteChar,
    WriteByte: PF_WriteByte,
    WriteShort: PF_WriteShort,
    WriteLong: PF_WriteLong,
    WriteFloat: PF_WriteFloat,
    WriteString: PF_WriteString,
    WritePosition: PF_WritePos,
    WriteDir: PF_WriteDir,
    WriteAngle: PF_WriteAngle,

    // TagMalloc/TagFree/FreeTags are OMITTED per game.ts's own GameImports
    // comment (no tag-based allocator on this side of the port).

    cvar: Cvar_Get,
    cvar_set: Cvar_Set,
    cvar_forceset: Cvar_ForceSet,

    argc: Cmd_Argc,
    argv: Cmd_Argv,
    args: Cmd_Args,
    AddCommandString: Cbuf_AddText,

    DebugGraph: DebugGraphNoop,
    SetAreaPortalState: CM_SetAreaPortalState,
    AreasConnected: CM_AreasConnected,
  };

  // Runtime game-track selection: the C engine loads gamex86.dll (or the
  // platform equivalent) out of the directory named by the "game" cvar
  // (FS_Gamedir()) -- there is no DLL to load in this port, so the "game"
  // cvar instead picks which statically-imported GetGameAPI to call.
  // `importsObj`'s type (src/game/game.ts's GameImports) is structurally
  // identical to src/ctf/game.ts's GameImports (verified: `diff
  // src/game/game.ts src/ctf/game.ts` adds only the SVF_PROJECTILE constant,
  // no interface-shape change) and both only take the shared, track-agnostic
  // `Edict` type as parameters, so passing it to CTF_GetGameAPI needs no
  // cast. Its GameExports return does NOT assign back structurally (see
  // adaptCtfGameExports's comment above) -- bridged through that adapter.
  const gameName = Cvar_VariableString("game");
  const ge =
    gameName === "ctf"
      ? adaptPackGameExports(CTF_GetGameAPI(importsObj))
      : gameName === "xatrix"
        ? adaptPackGameExports(XATRIX_GetGameAPI(importsObj))
        : gameName === "rogue"
          ? adaptPackGameExports(ROGUE_GetGameAPI(importsObj))
          : GetGameAPI(importsObj);

  if (ge.apiversion !== GAME_API_VERSION) {
    Com_Error(ERR_DROP, "game is version %i, not %i", ge.apiversion, GAME_API_VERSION);
  }

  geHolder.ge = ge;

  ge.Init();
}
