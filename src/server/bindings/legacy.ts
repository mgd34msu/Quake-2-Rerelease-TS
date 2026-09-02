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
import { g_edicts as baseGEdicts } from "../../game/g_local";
import type { GameExports as CtfGameExports } from "../../ctf/game";
import { g_edicts as ctfGEdicts } from "../../ctf/g_local";
import { g_edicts as xatrixGEdicts } from "../../xatrix/g_local";
import { g_edicts as rogueGEdicts } from "../../rogue/g_local";
import { g_edicts as lmctfGEdicts } from "../../lmctf/g_local";
import type { Vec3 } from "../../shared/math";
import { CS_REMAP_OLD, remapLegacyConfigstringIndex } from "../../shared/cs_remap";
import { PlayerStateT, STAT_PICKUP_STRING, STAT_CHASE, MAX_ITEMS, MAX_CLIENTS } from "../../shared/q_shared";
import { svs } from "../server";
import { Nav_SetEdictSource, type NavGameEdictView } from "../nav";
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
import { GetGameAPI as LMCTF_GetGameAPI } from "../../lmctf/g_main";
import type { GameExports as XatrixGameExports } from "../../xatrix/game";
import type { GameExports as RogueGameExports } from "../../rogue/game";
import type { GameExports as LmctfGameExports } from "../../lmctf/game";
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
  SV_SetGamePostFrameHook,
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
// Exported (not just used internally by LoadLegacyGame below) so
// src/server/bindings/legacy_kex.ts can reuse the identical Edict-shaped
// GameExports bridge for LMCTF hosted under the kex family's protocol --
// see that file's header. Purely additive: no existing caller's behavior
// changes.
export function adaptPackGameExports(ctfGe: CtfGameExports | XatrixGameExports | RogueGameExports | LmctfGameExports): GameExports {
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
toNavGameEdictView / legacyNavEdicts

nav.ts's Nav_SetupEntities needs "the currently spawned game's edicts" (see
nav.ts's header, "A NEW SEAM NOT IN THE C SOURCE") -- bindings/kex.ts
supplies this for the kex family because KexEdictT already structurally
satisfies NavGameEdictView's `sv.classname`/`sv.ent_flags` shape directly.
The legacy (API v3) `Edict`/EdictT shape has neither: `classname` lives flat
on every legacy tree's own EdictT class (game/ctf/xatrix/rogue/lmctf's
g_local.ts, all five declared `classname: string | null = null;`), not
nested under an `sv` substruct, and there is no `ent_flags` bitfield concept
at all (`SvEntFlagsT`, kexapi/game.ts, is a 2023-kex-only addition).

`LegacyEdictLike` is a local structural type covering exactly what
NavGameEdictView needs; every one of the five legacy trees' concrete EdictT
classes satisfies it without this file importing any of their five distinct
EdictT types by name (the same "structurally typed, not imported" approach
nav.ts's own header describes for KexEdictT vs NavGameEdictView).

`ent_flags: 0n` is not a fudge: the legacy v3 API has no such bitfield, so
"never set" is the only correct, behavior-preserving mapping -- it means
Nav_UpdateConditionalNode's SVFL_TRAP_DANGER/SVFL_IS_LOCKED_DOOR checks
(nav.c:1153,1193) simply never fire for a legacy-family game, exactly
matching what a real legacy edict actually is.

See nav.ts's "A DELIBERATE, DOCUMENTED DEVIATION" header comment (the
`sv_nav_legacy` cvar) for why this provider exists at all -- unlike the real
engine's game3_proxy compat shim (server/game3_proxy/game3_proxy.c), which
never populates `sv.classname` and so ALWAYS fails this exact binding step,
this port has direct access to the legacy game's real edicts and can
actually resolve nav links against them.
===============
*/
interface LegacyEdictLike {
  readonly inuse: boolean;
  readonly svflags: number;
  readonly solid: number;
  readonly absmin: Vec3;
  readonly absmax: Vec3;
  readonly classname: string | null;
  readonly s: {
    readonly modelindex: number;
    readonly renderfx: number;
    readonly origin: Vec3;
    readonly old_origin: Vec3;
  };
}

function toNavGameEdictView(e: LegacyEdictLike): NavGameEdictView {
  return {
    inuse: e.inuse,
    svflags: e.svflags,
    solid: e.solid,
    absmin: e.absmin,
    absmax: e.absmax,
    s: e.s,
    sv: { classname: e.classname, ent_flags: 0n },
  };
}

function legacyNavEdicts(edicts: readonly (LegacyEdictLike | undefined)[]): (NavGameEdictView | null)[] {
  return edicts.map((e) => (e ? toNavGameEdictView(e) : null));
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

    configstring: PF_LegacyConfigstring,
    extended_layout: PF_ExtendedLayout,
    shadowlight: PF_ShadowLight,
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
// "lmctf" IS now a real fifth game tree in progress at src/lmctf/ -- ported
// from LM_CTF (Loki's Minions CTF) 5.2/6.0 with QwazyWabbit's C11
// maintenance, GPL source at ~/Projects/qsrc/lmctf60 (61 C files, ~53k
// lines; see src/lmctf's own file headers and PORTING.md for the
// diff-driven-vs-src/ctf method). This corrects an earlier version of this
// comment, which predates that source becoming available and called the
// pack "Lithium CTF" with "no GPL source anywhere in this port's reference
// libraries" -- both no longer accurate.
//
// "lmctf" now routes to LMCTF_GetGameAPI (src/lmctf's own GetGameAPI, real
// LM_CTF rules) instead of CTF_GetGameAPI (stock CTF rules). Flipped once
// the flag capture chain (ctf_flagtouch/ctf_playerdropflag/
// ctf_resetflagandplayer + everything they pull in, g_ctffunc.ts),
// SpawnEntities (g_spawn.ts), ClientConnect/ClientBegin/
// ClientUserinfoChanged/ClientDisconnect/ClientThink (p_client.ts), and
// RunFrame (g_main.ts) were all confirmed real (not throwing) by direct
// invocation and by test/lmctf_capture.test.ts. gameName "lmctf" still
// drives FS_SetGamedir("lmctf") (cvar.ts's "game" latch hook) the same way
// it always did; the only change here is which compiled game module serves
// the resulting traffic.
/*
===============
PF_LegacyConfigstring

Every `gi.configstring(index, str)` call a legacy (API v3) game tree makes
computes its index against that tree's own frozen, hardcoded CS_* constants
(shared/q_shared.ts -- numerically CS_REMAP_OLD's values, always: the frozen
GameImports contract has no CsRemapT awareness, svs.csr is an engine-side
concept). That is exactly right while the session is on the classic layout,
and exactly wrong once it has widened (sv_init.ts's
SV_WidenConfigstringSpace) -- e.g. a raw CS_ITEMS index (1056) lands inside
the wide layout's SOUNDS block (62..8253) and would clobber a precached
sound name.

Translating here, at the engine/module boundary, against the LIVE svs.csr
keeps both cases correct with one code path: when svs.csr is still
CS_REMAP_OLD the translation is the identity (remapLegacyConfigstringIndex
returns its input when the two families are the same table), so an unwidened
classic session writes exactly the bytes it always did.

bindings/legacy_kex.ts does the same translation with both families spelled
out statically, because LMCTF-under-kex is wide from the first frame and can
never be anything else.
===============
*/
function PF_LegacyConfigstring(index: number, str: string): void {
  PF_Configstring(remapLegacyConfigstringIndex(index, CS_REMAP_OLD, svs.csr), str);
}

/*
===============
PF_ExtendedLayout / PF_ShadowLight

The engine half of game.ts's two additions to the frozen v3 import set (see
the block comment there for why they are optional on the interface).

PF_ExtendedLayout is a plain read of the live session layout. A legacy tree
calls it to decide whether presentation it holds on the edict can actually
reach a client this session -- src/game's setup_dynamic_light and the
`_color` spawn-key case are the two consumers today. It answers for the
CURRENT moment, so it must not be cached across a level change; sv_game.ts
resets svs.csr on every game-library load and SV_SpawnServer settles the
session's layout before ge.SpawnEntities runs, which is exactly when the
module asks.

PF_ShadowLight exists because CS_SHADOWLIGHTS has no legacy index to
translate: the classic layout has no such block (cs_remap.ts gives it
shadowlights -1, max_shadowlights 0), so a raw index through
PF_LegacyConfigstring could only land on top of some other block. Taking the
slot number instead and adding the LIVE base here keeps the module free of
any layout arithmetic. On the classic layout there is nowhere to put it, so
the call is a silent no-op rather than an error -- the module is allowed to
call unconditionally, and a caller that cares checks extended_layout() first.
===============
*/
function PF_ExtendedLayout(): boolean {
  return svs.csr.extended;
}

function PF_ShadowLight(slot: number, value: string): void {
  if (svs.csr.shadowlights < 0 || slot < 0 || slot >= svs.csr.max_shadowlights) return;
  PF_Configstring(svs.csr.shadowlights + slot, value);
}

// The live `g_edicts` module singleton of whichever legacy tree `gameName`
// selects -- read directly rather than through `ge.edicts` for the
// live-binding reason this file's Nav_SetEdictSource comment already
// documents (that field is fixed at GetGameAPI-return time and never
// reassigned when InitGame allocates the real array).
function legacyTreeEdicts(gameName: string): { client: unknown }[] {
  if (gameName === "lmctf") return lmctfGEdicts;
  if (gameName === "ctf") return ctfGEdicts;
  if (gameName === "xatrix") return xatrixGEdicts;
  if (gameName === "rogue") return rogueGEdicts;
  return baseGEdicts;
}

function isPlayerStateHolder(client: unknown): client is { ps: PlayerStateT } {
  return typeof client === "object" && client !== null && "ps" in client && (client as { ps: unknown }).ps instanceof PlayerStateT;
}

/*
===============
fixupWidenedSessionPlayerState

Everything a WIDENED classic session has to correct in a legacy tree's player
state before it goes on the wire. Two independent jobs, both no-ops on the
narrow layout (single early-out below), so an unwidened classic session --
the overwhelmingly common case -- is byte-for-byte untouched.

JOB 1: RAW CONFIGSTRING INDICES EMBEDDED AS PLAYER-STATE DATA.

The one class of cross-boundary leak PF_LegacyConfigstring above cannot
catch: a raw configstring index the game tree embeds as PLAYER-STATE DATA
instead of passing to gi.configstring(), so there is no import-table seam to
intercept. Grepped exhaustively across src/game (`= CS_`, `CS_X +`); there
are exactly two, both stock id Software behavior shared by every legacy tree:

  g_items.ts  Pickup_General  stats[STAT_PICKUP_STRING] = CS_ITEMS + ITEM_INDEX(item)
  p_hud.ts    G_SetStats      stats[STAT_CHASE]         = CS_PLAYERSKINS + (number - 1)

(bindings/legacy_kex.ts documents the first for LMCTF; the second is real
here too, because the base tree has a chase camera LMCTF's grep predated.)

Run after every entry point that can change a client's stats -- pickups and
chase-cam updates both happen inside RunFrame's think/touch dispatch, not at
a call this binding otherwise observes. The range checks make it idempotent:
a remapped value lands far outside CS_REMAP_OLD's block, so a later pass
leaves it alone instead of remapping twice.

JOB 2: THE FLOAT PMOVE MIRROR (originF/velocityF).

PmoveStateT carries the pmove origin/velocity twice: `origin`/`velocity` as
the classic 12.3 fixed-point Int16 pair, and `originF`/`velocityF` as plain
world-unit floats. q_shared.ts's own comment on those float fields records
the assumption that held until the configstring space became a session
property: "Always zero for every vanilla-family game (nothing writes them)"
-- true, because only server/bindings/kex.ts filled them, and only the kex
family ever spoke a protocol that read them.

A widened classic session breaks that pairing. It runs a LEGACY game tree
(which writes only the Int16 pair, through qcommon/pmove.ts) over 1038's
codec (protocol/q2repro.ts, which reads pm_origin/pm_velocity from the FLOAT
pair and nothing else -- svc_playerstate carries them as full IEEE-754). The
floats are still zero, so every frame told the client the player was standing
at the world origin with no velocity. Seen directly: rerelease base1 under the
classic ruleset rendered a completely different part of the level from the
same map under either protocol 34 or the kex module, both of which agree with
each other.

Mirroring here rather than in qcommon/pmove.ts is deliberate. pmove.ts's
quantization is bit-exact vanilla behavior on the Int16 domain and is shared
by the client's own prediction; the float pair is purely a WIRE carrier for
the extended protocols, so the place to derive it is the same engine/module
seam that already translates this session's other layout-dependent values.
Dividing the 12.3 fixed-point value by 8 is the exact inverse of
protocol/q2repro.ts's pmFloatToShort (`round(f * 8)`), so the widened classic
session puts the same numbers on the wire that the classic codec always did,
at the classic quantization -- no accuracy is claimed that the legacy tree
did not have.
===============
*/
function fixupWidenedSessionPlayerState(edicts: { client: unknown }[]): void {
  if (svs.csr === CS_REMAP_OLD) return; // classic layout: raw indices are correct and the float pair is never read

  for (const edict of edicts) {
    if (!isPlayerStateHolder(edict.client)) continue;
    const stats = edict.client.ps.stats;

    const pickup = stats[STAT_PICKUP_STRING];
    if (pickup >= CS_REMAP_OLD.items && pickup < CS_REMAP_OLD.items + MAX_ITEMS) {
      stats[STAT_PICKUP_STRING] = remapLegacyConfigstringIndex(pickup, CS_REMAP_OLD, svs.csr);
    }

    const chase = stats[STAT_CHASE];
    if (chase >= CS_REMAP_OLD.playerskins && chase < CS_REMAP_OLD.playerskins + MAX_CLIENTS) {
      stats[STAT_CHASE] = remapLegacyConfigstringIndex(chase, CS_REMAP_OLD, svs.csr);
    }

    // Job 2: derive the float pair the wide codec actually transmits from the
    // fixed-point pair the legacy tree actually wrote. See the header.
    const pm = edict.client.ps.pmove;
    for (let i = 0; i < 3; i++) {
      pm.originF[i] = (pm.origin[i] ?? 0) / 8;
      pm.velocityF[i] = (pm.velocity[i] ?? 0) / 8;
    }
  }
}

export function LoadLegacyGame(gameName: string): GameExports {
  const importsObj = BuildLegacyImports();

  // `importsObj`'s type (src/game/game.ts's GameImports) is structurally
  // identical to src/ctf/game.ts's and src/lmctf/game.ts's GameImports
  // (verified: both only differ from the base by additive constants, no
  // interface-shape change) and all three only take the shared,
  // track-agnostic `Edict` type as parameters, so passing it to
  // CTF_GetGameAPI/LMCTF_GetGameAPI needs no cast. Its GameExports return
  // does NOT assign back structurally (see adaptPackGameExports's comment
  // above) -- bridged through that adapter.
  const ge =
    gameName === "lmctf"
      ? adaptPackGameExports(LMCTF_GetGameAPI(importsObj))
      : gameName === "ctf"
        ? adaptPackGameExports(CTF_GetGameAPI(importsObj))
        : gameName === "xatrix"
          ? adaptPackGameExports(XATRIX_GetGameAPI(importsObj))
          : gameName === "rogue"
            ? adaptPackGameExports(ROGUE_GetGameAPI(importsObj))
            : GetGameAPI(importsObj);

  // nav.ts's edict-source seam, mirroring bindings/kex.ts's identical
  // registration in adaptKexGameExports -- see toNavGameEdictView/
  // legacyNavEdicts above for why this needs an adapter (unlike kex,
  // whose KexEdictT already satisfies NavGameEdictView structurally) and
  // nav.ts's own header for why this provider is only ever consulted when
  // `sv_nav_legacy` is on (sv_init.ts gates the Nav_Load call itself, not
  // this registration -- registering unconditionally here, same as kex,
  // is harmless when nav was never loaded: nav_data.edicts stays empty).
  // Each tree's own `g_edicts` module singleton is read directly here (not
  // `ge.edicts`) for the identical live-binding reason legacy_kex.ts's
  // fixupPickupStringStat already documents for the lmctf-under-kex case.
  Nav_SetEdictSource(() =>
    legacyNavEdicts(
      gameName === "lmctf"
        ? lmctfGEdicts
        : gameName === "ctf"
          ? ctfGEdicts
          : gameName === "xatrix"
            ? xatrixGEdicts
            : gameName === "rogue"
              ? rogueGEdicts
              : baseGEdicts,
    ),
  );

  // Keep the two raw configstring indices a legacy tree embeds in PLAYER
  // STATE (rather than passing to gi.configstring()) in step with the layout
  // the engine is actually using, and the float pmove mirror the wide codec
  // transmits -- see fixupWidenedSessionPlayerState. Registered
  // as an engine-side post-frame hook rather than by wrapping ge.Init/
  // ge.SpawnEntities/ge.RunFrame, because the base track's GameExports is
  // returned unwrapped with its function identities intact (see
  // SV_SetGamePostFrameHook's own doc comment in sv_game.ts). A no-op for
  // every session that never widens, which is every session whose map fits
  // the classic limits.
  // legacyTreeEdicts is re-evaluated INSIDE the closure, not captured once
  // out here: each tree's `g_edicts` is an `export let` that InitGame
  // REASSIGNS when it allocates the real array (g_save.ts's SetGEdicts),
  // and that happens after this function returns. Reading it through the
  // live module binding on every call is the same "read live, don't
  // snapshot" rule the Nav_SetEdictSource registration just below already
  // follows; capturing the array reference here instead pinned the hook to
  // the empty pre-Init array, so it silently iterated nothing.
  SV_SetGamePostFrameHook(() => fixupWidenedSessionPlayerState(legacyTreeEdicts(gameName)));

  return ge;
}
