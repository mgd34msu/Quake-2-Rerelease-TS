// The legacy (API v3) game binding, per ARCHITECTURE.md's "Core model: one
// engine, five first-class game modules". This module is the peer binding
// that adapts engine-core services to the frozen baseq2/ctf/xatrix/rogue
// GameImports/GameExports contract; it is the counterpart to the (not yet
// built) kex binding for the 2023 API. The four game trees it wraps are
// frozen exhibits -- bug-for-bug 3.21 behavior -- and do not change here or
// anywhere else as part of this transformation.
//
// There is no DLL boundary in this port (see sv_game.ts's header comment):
// "loading" a game module means calling one of the four statically-imported
// GetGameAPI functions directly, in-process, picked by reading the "game"
// cvar, instead of loading a shared library out of a mod directory
// (FS_Gamedir() / Sys_GetGameAPI() in the C engine).
//
// BuildLegacyImports assembles the GameImports object all four trees share;
// LoadLegacyGame resolves "game" to one of them and returns its GameExports,
// bridging the three mission-pack tracks through adaptPackGameExports. Both
// were moved here from sv_game.ts's SV_InitGameProgs as a behavior-neutral
// refactor -- see that file for the apiversion check and geHolder storage
// that remain on the caller's side of this boundary.

import type { GameExports, GameImports } from "../../game/game";
import { GetGameAPI } from "../../game/g_main";
import type { GameExports as CtfGameExports } from "../../ctf/game";
// The C engine picks the game DLL by loading gamex86.dll (or the platform
// equivalent) out of the mod directory named by the "game" cvar (FS_Gamedir()
// / Sys_GetGameAPI(), sv_main.c/sys_*.c) -- there is no DLL boundary in this
// port (see sv_game.ts's header comment), so all four game tracks are
// statically imported here and LoadLegacyGame picks between their GetGameAPI
// exports by reading the "game" cvar value passed in by the caller, instead
// of loading a shared library from a mod directory.
import { GetGameAPI as CTF_GetGameAPI } from "../../ctf/g_main";
import { GetGameAPI as XATRIX_GetGameAPI } from "../../xatrix/g_main";
import { GetGameAPI as ROGUE_GetGameAPI } from "../../rogue/g_main";
import type { GameExports as XatrixGameExports } from "../../xatrix/game";
import type { GameExports as RogueGameExports } from "../../rogue/game";
import { Cvar_Get, Cvar_Set, Cvar_ForceSet } from "../../qcommon/cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cbuf_AddText } from "../../qcommon/cmd";
import { CM_SetAreaPortalState, CM_AreasConnected } from "../../qcommon/cmodel";
import { Pmove } from "../../qcommon/pmove";
import { SV_BroadcastPrintf, SV_Multicast, SV_StartSound } from "../sv_send";
import { SV_ModelIndex, SV_SoundIndex, SV_ImageIndex } from "../sv_init";
import { SV_LinkEdict, SV_UnlinkEdict, SV_AreaEdicts, SV_Trace, SV_PointContents } from "../sv_world";
import {
  PF_Unicast,
  PF_dprintf,
  PF_cprintf,
  PF_centerprintf,
  PF_error,
  PF_setmodel,
  PF_inPVS,
  PF_inPHS,
  PF_Configstring,
  PF_StartSound,
  PF_WriteChar,
  PF_WriteByte,
  PF_WriteShort,
  PF_WriteLong,
  PF_WriteFloat,
  PF_WriteString,
  PF_WritePos,
  PF_WriteDir,
  PF_WriteAngle,
} from "../sv_game";

// Runtime game-track selection (see LoadLegacyGame below): src/ctf/game.ts's
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
// adaptPackGameExports bridges the gap for every member that only crosses the
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
// SCOPE, which covers game-track selection only). Net effect: ctf's Init/
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

function DebugGraphNoop(_value: number, _color: number): void {
  // SCR_DebugGraph is only forward-declared in sv_game.c (`void
  // SCR_DebugGraph (float value, int color);`) and never defined by any
  // server/*.c file in this tree -- it is client render/debug-overlay code
  // (src/client/scr_main.ts territory, not yet ported, and arguably not
  // applicable to a headless/dedicated engine at all). No-op per brief.
}

/*
===============
BuildLegacyImports

Assembles the GameImports object handed to all four legacy game trees
(baseq2, ctf, xatrix, rogue). Moved verbatim out of sv_game.ts's
SV_InitGameProgs.
===============
*/
export function BuildLegacyImports(): GameImports {
  return {
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
}

/*
===============
LoadLegacyGame

Resolves the "game" cvar value to one of the four statically-imported
GetGameAPI exports and returns its GameExports, bridging the three
mission-pack tracks through adaptPackGameExports. Moved verbatim out of
sv_game.ts's SV_InitGameProgs; the caller retains the apiversion check and
geHolder assignment.
===============
*/
// "lmctf" is NOT a fifth game tree and has no GPL source anywhere in this
// port's reference libraries -- it's Mike's own classic-era CTF map pack
// (~/q2ts/lmctf), which ships its own closed-source game DLLs (gamex86.dll
// et al.) for a third-party CTF variant we have no source to port. Per
// src/client/menu_content.ts's Content & Rules selector (its file header
// has the full mapping table), "lmctf" content plays under OUR compiled
// ctf track -- Mike's map pack running with stock CTF rules, not a port of
// whatever the original lmctf DLL actually did differently. This is a
// content-to-track alias only: gameName "lmctf" still drives
// FS_SetGamedir("lmctf") (cvar.ts's "game" latch hook), which mounts
// lmctf's own pak/map data as the active search root; only the compiled
// game logic served here is redirected to CTF_GetGameAPI.
export function LoadLegacyGame(gameName: string): GameExports {
  const importsObj = BuildLegacyImports();

  // `importsObj`'s type (src/game/game.ts's GameImports) is structurally
  // identical to src/ctf/game.ts's GameImports (verified: `diff
  // src/game/game.ts src/ctf/game.ts` adds only the SVF_PROJECTILE constant,
  // no interface-shape change) and both only take the shared, track-agnostic
  // `Edict` type as parameters, so passing it to CTF_GetGameAPI needs no
  // cast. Its GameExports return does NOT assign back structurally (see
  // adaptPackGameExports's comment above) -- bridged through that adapter.
  return gameName === "ctf" || gameName === "lmctf"
    ? adaptPackGameExports(CTF_GetGameAPI(importsObj))
    : gameName === "xatrix"
      ? adaptPackGameExports(XATRIX_GetGameAPI(importsObj))
      : gameName === "rogue"
        ? adaptPackGameExports(ROGUE_GetGameAPI(importsObj))
        : GetGameAPI(importsObj);
}
