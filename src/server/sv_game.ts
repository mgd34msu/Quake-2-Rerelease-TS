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
import { MulticastT, CHAN_RELIABLE } from "../shared/q_shared";
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
import {
  SV_Multicast,
  SV_ClientPrintf,
  SV_StartSound,
  SND_VOLUME,
  SND_ATTENUATION,
  SND_ENT,
  SND_OFFSET,
  DEFAULT_SOUND_PACKET_VOLUME,
  DEFAULT_SOUND_PACKET_ATTENUATION,
} from "./sv_send";
import { SV_ModelIndex } from "./sv_init";
import { SV_LinkEdict } from "./sv_world";
import { SV_MvdUnicast } from "./sv_mvd";
import { LoadLegacyGame } from "./bindings/legacy";
import { LoadKexGame } from "./bindings/kex";
import { LoadLmctfKexGame } from "./bindings/legacy_kex";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../shared/cs_remap";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../qcommon/protocol/q2repro";

export const geHolder: { ge: GameExports | null } = { ge: null };

/** The two peer game-API families this engine dispatches on -- see
 * ARCHITECTURE.md's "Core model: one engine, five first-class game modules".
 */
export type GameFamily = "kex" | "legacy";

/*
===============
currentGameFamily

Single source of truth for "which game family is the 'game' cvar naming
right now" -- SV_InitGameProgs below (module load + configstring remap
selection) and sv_init.ts's SV_SpawnServer (tick-rate dispatch) both need
this same answer and previously each re-read the "game" cvar and
re-derived it independently. Centralized here instead of re-reading the
cvar at each call site.
===============
*/
export function currentGameFamily(): GameFamily {
  return Cvar_VariableString("game") === "kex" ? "kex" : "legacy";
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

  // mvd.c:148 (game.c's own PF_Unicast): `SV_MvdUnicast(ent, clientNum,
  // reliable);` -- read BEFORE the buffer is cleared below, matching the
  // reference's ordering exactly (this port has no `msg_write.overflowed`/
  // svc_disconnect drop-hack branches to also mirror -- see sv_mvd.ts's
  // SV_MvdUnicast for the filtering it does apply).
  //
  // FILE SCOPE NOTE: the task brief for this hook restricted edits to
  // "sv_send.ts hook block" (multicast/startsound both live there), but
  // PF_Unicast -- the actual call site for SV_MvdUnicast, matching game.c's
  // own PF_Unicast exactly -- lives in this file instead (this port's
  // sv_send.ts only has the plain SV_Multicast/SV_StartSound send-buffer
  // primitives; the per-client wrapper is a sv_game.ts PF_* import). Wiring
  // the hook anywhere else would not fire it at all, so this file gained one
  // narrow, single-line addition beyond the stated scope -- flagged here and
  // in the task report rather than silently expanding scope.
  SV_MvdUnicast(ent, p - 1, reliable, sv.multicast.data.subarray(0, sv.multicast.cursize));

  SZ_Clear(sv.multicast);
}

/*
===============
PF_LocalSound

[Paril-KEX] gi.local_sound (game.h:1897's `local_sound` import) -- like
`sound`, but ONLY the `target` client ever receives it, matching q2repro's
own PF_LocalSound (server/game.c:638-673). q2repro's implementation:

  - never touches `origin` (the parameter is declared but never read in the
    reference body) -- a local_sound is a purely channel-based cue (pickup
    jingles, low-ammo warnings, help markers), never a positioned/PVS-culled
    one, so no SND_POS is ever written here either.
  - never touches `entity` for the message's own entity/channel-override
    number: `entnum = NUM_FOR_EDICT(target)`, i.e. the encoded channel slot
    is always the RECEIVING client's own player entity, regardless of which
    logical "source" entity (frequently `world`) was passed as `entity`.
    Real callers do pass a distinct target/entity pair (rerelease's
    g_items.cpp:1533: `gi.local_sound(ent, points[...], world, ...)`).
  - unicasts the built message to `target` alone via PF_Unicast (reliable
    iff `channel & CHAN_RELIABLE`), never through SV_Multicast/PVS.

This is NOT the same code path as SV_StartSound (broadcast/PHS multicast):
before this function existed, the kex binding forwarded local_sound straight
into SV_StartSound, which sent the "private" cue to every client in the
source entity's PVS -- see src/server/bindings/kex.ts's OTHER DOCUMENTED GAPS
header, "local_sound's target/dupe_key", now fixed by wiring to this
function instead. `dupe_key` (splitscreen duplicate-send dedup) is still
accepted by the binding and dropped here, matching q2repro's own PF_Unicast
(server/game.c:100), which accepts a `dupe_key` parameter it never reads
either -- q2repro is a PC engine with no local splitscreen to dedupe for,
same as this port (see .orch/ splitscreen scope ruling).
===============
*/
export function PF_LocalSound(target: Edict, entity: Edict, channel: number, soundindex: number, volume: number, attenuation: number, timeofs: number): void {
  const p = target.s.number; // NUM_FOR_EDICT(target)
  const maxc = maxclients ? maxclients.value : 0;
  if (p < 1 || p > maxc) return;

  // `entity` carries no message content of its own here -- see header. The
  // parameter still exists so this signature stays index-aligned with
  // KexGameImports.local_sound's (target, origin, entity, ...) shape.
  void entity;

  let flags = 0;
  if (volume !== DEFAULT_SOUND_PACKET_VOLUME) flags |= SND_VOLUME;
  if (attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION) flags |= SND_ATTENUATION;
  // always send the entity number for channel overrides
  flags |= SND_ENT;
  if (timeofs) flags |= SND_OFFSET;

  const sendchan = (p << 3) | (channel & 7);

  MSG_WriteByte(sv.multicast, SvcOpsT.svc_sound);
  MSG_WriteByte(sv.multicast, flags);
  MSG_WriteByte(sv.multicast, soundindex);

  if (flags & SND_VOLUME) MSG_WriteByte(sv.multicast, (volume * 255) | 0);
  if (flags & SND_ATTENUATION) MSG_WriteByte(sv.multicast, (attenuation * 64) | 0);
  if (flags & SND_OFFSET) MSG_WriteByte(sv.multicast, (timeofs * 1000) | 0);

  MSG_WriteShort(sv.multicast, sendchan);

  PF_Unicast(target, !!(channel & CHAN_RELIABLE));
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
  // the mission-pack bridge). "kex" (the re-release module, bindings/kex.ts)
  // is a second peer track alongside the four legacy ones, per
  // ARCHITECTURE.md's "Core model: one engine, five first-class game
  // modules".
  //
  // FS_Gamedir: "game" doubles as qcommon/files.ts's gamedir cvar (its own
  // CVAR_LATCH hook calls FS_SetGamedir(existing.string) whenever "game"
  // changes -- see cvar.ts's Cvar_Set2/Cvar_GetLatchedVars). Setting "game"
  // to "kex" therefore pushes an (empty, since no baseq2-tree "kex/"
  // directory exists) search-path layer ahead of the base searchpaths via
  // FS_AddGameDirectory -- but FS_SetGamedir never tears down
  // fs_base_searchpaths, so asset reads (maps/models/sounds) fall through to
  // baseq2 correctly regardless; kex plays on baseq2's assets, matching
  // ARCHITECTURE.md's "content superset" framing. The only observable side
  // effect is that FS_Gamedir() (savegame/demo writes) targets
  // <basedir>/kex/... instead of baseq2/... until an explicit gamedir
  // override is set -- an accepted, documented transitional gap, not a boot
  // blocker (FS_CreatePath creates the directory tree on demand). Not
  // special-cased here: doing so would mean fighting the generic "game"
  // cvar hook (qcommon/cvar.ts/qcommon/files.ts, shared infra every cvar
  // relies on) for a cosmetic save-path difference, out of this unit's
  // scope.
  //
  // svs.csr (server.ts's own header comment names this binding as its
  // intended owner): selects which configstring-index layout ("game
  // family") is active. SV_ModelIndex/SV_SoundIndex/SV_ImageIndex/
  // PF_Configstring are already family-aware (keyed off svs.csr.*, not a
  // hardcoded constant) -- the only missing piece was actually choosing
  // cs_remap_rerelease for the kex module, done here.
  const gameName = Cvar_VariableString("game");
  const family = currentGameFamily();
  // "lmctf-kex" (bindings/legacy_kex.ts, .orch/followups.md's "kex-family
  // LMCTF adaptation" task #26) is a THIRD, narrower selection: LMCTF's own
  // frozen legacy-API v3 content, hosted under the kex family's wire
  // protocol/configstring layout. It is deliberately NOT folded into
  // `family`/`currentGameFamily()` -- see legacy_kex.ts's own header ("two
  // independent axes") for why: `family` still governs tick rate (LMCTF has
  // no tick_rate import and is hardcoded to 10Hz), savegame container choice
  // (LMCTF has no WriteGameJson/ReadGameJson/CanSave), and MVD codec choice,
  // all of which must stay on LMCTF's native legacy behavior regardless of
  // which wire protocol is active. Only svs.csr/svs.codec (below) and which
  // GetGameAPI gets called (further below) key off this narrower check.
  const lmctfKex = gameName === "lmctf-kex";
  svs.csr = family === "kex" || lmctfKex ? CS_REMAP_RERELEASE : CS_REMAP_OLD;
  // ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md phase 5: mirror
  // q2repro's own server, which ONLY accepts the rerelease protocol (1038) --
  // offer Q2REPRO_CODEC for kex games, keep legacy games on VANILLA_CODEC
  // (protocol 34). This is server-wide (not per-client) selection, same
  // simplification server.ts's `codec` field doc comment already calls out;
  // full multi-protocol negotiation (a legacy-34 client and a kex-1038
  // client connected to the same server simultaneously) is future work.
  svs.codec = family === "kex" || lmctfKex ? Q2REPRO_CODEC : VANILLA_CODEC;
  const ge = lmctfKex ? LoadLmctfKexGame() : family === "kex" ? LoadKexGame() : LoadLegacyGame(gameName);

  if (ge.apiversion !== GAME_API_VERSION) {
    Com_Error(ERR_DROP, "game is version %i, not %i", ge.apiversion, GAME_API_VERSION);
  }

  geHolder.ge = ge;

  ge.Init();
}
