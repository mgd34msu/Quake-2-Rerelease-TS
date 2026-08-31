// LMCTF hosted under the kex family's protocol (1038, CS_REMAP_RERELEASE) --
// the "kex-family LMCTF adaptation" named in .orch/followups.md's task #26
// note. Peer file to bindings/legacy.ts and bindings/kex.ts, not a
// replacement for either: legacy.ts stays untouched (baseq2/ctf/xatrix/
// rogue/plain-"lmctf" keep running exactly as they do today, protocol 34,
// CS_REMAP_OLD); kex.ts stays untouched (still the only binding for the
// real kexgame content module). This file is new.
//
// ============================================================================
// WHICH SIDE OF THE ARCHITECTURE THIS IS -- NOT A REWRITE, NOT KEX.TS'S JOB
// ============================================================================
// ARCHITECTURE.md's "Core model: one engine, five first-class game modules"
// draws exactly two peer bindings: the legacy binding (API v3, frozen
// exhibits, bug-for-bug 3.21) and the kex binding (API 2023, the kexgame
// content-superset module). LMCTF is one of the legacy binding's five game
// trees (src/lmctf/game.ts's own header: "GetGameAPI ... every other family
// in this repo already normalizes to `GetGameAPI`") -- its GameImports/
// GameExports contract is the SAME frozen v3 shape ctf/xatrix/rogue/baseq2
// share (game/game.ts's Edict, no tick_rate/frame_time_s/frame_time_ms
// imports, no WriteGameJson/ReadGameJson/CanSave exports). Hosting it under
// the kex family's WIRE protocol therefore means routing it through
// bindings/legacy.ts's own machinery (BuildLegacyImports, LMCTF_GetGameAPI,
// adaptPackGameExports -- all reused here, none duplicated), NOT rewriting
// it against kexapi/game.ts's KexGameImports/KexGameExports contract the way
// bindings/kex.ts does for the real kexgame module. That would be the
// "not a rewrite of LMCTF game logic" the task brief rules out, and would
// also violate "the game trees themselves do not change" (see legacy.ts's
// own header for the same ruling extended to baseq2/ctf/xatrix/rogue).
//
// ============================================================================
// WHAT "KEX FAMILY" ACTUALLY MEANS HERE -- TWO INDEPENDENT AXES
// ============================================================================
// .orch/phase5-design.md's design rule, carried from ARCHITECTURE.md: "Two
// independent axes: game-API family (vanilla|rerelease) x client protocol
// (34|1038)." sv_game.ts's SV_InitGameProgs currently collapses those two
// axes into one `GameFamily` value ("kex"|"legacy") because, until this
// unit, every game module that ever ran under the wide protocol WAS the
// real kexgame content module -- so `currentGameFamily() === "kex"` also
// correctly meant "the loaded GameExports has the full KexGameExports
// feature surface" everywhere that mattered: sv_ccmds.ts's SSV2/SAV2
// savegame container (WriteGameJson/ReadGameJson/CanSave -- its own header
// comment states this as an invariant: "these functions only run when
// currentGameFamily() === 'kex', and the kex game module unconditionally
// implements WriteGameJson/... -- there is no 'loaded a legacy game under
// the kex family' state this engine can reach"), sv_mvd.ts's rerelease
// player-state MVD codec, and sv_init.ts's SV_ComputeFramerate variable-tick
// dispatch (legacy game logic has no tick_rate import and is hardcoded to
// FRAMETIME=0.1s -- g_local.ts's own constant -- so it cannot safely run at
// anything but 10Hz regardless of wire family).
//
// LMCTF hosted here does NOT become that state: `currentGameFamily()` is
// deliberately left returning "legacy" for it (sv_game.ts's SV_InitGameProgs
// recognizes gameName === "lmctf-kex" as a THIRD, narrower selection --
// content=LMCTF, protocol=kex -- entirely separate from the `family`
// variable that everything else above still keys off). Concretely, when
// "game" = "lmctf-kex":
//   - svs.csr / svs.codec: CS_REMAP_RERELEASE / Q2REPRO_CODEC (protocol
//     1038, wide configstring layout) -- SV_InitGameProgs's own doing.
//   - currentGameFamily(): still "legacy" -- so SV_ComputeFramerate keeps
//     LMCTF pinned at native 10Hz (correct: its game logic has no notion of
//     a faster tick), sv_ccmds.ts's savegame dispatch keeps using LMCTF's
//     own WriteGame/ReadGame/WriteLevel/ReadLevel (the fixed-width legacy
//     container this module already implements via g_save.ts -- there is
//     genuinely no WriteGameJson/ReadGameJson/CanSave to call), and
//     sv_mvd.ts keeps recording the non-rerelease MVD player-state codec.
// This is the one and only place in the engine this task's brief authorizes
// touching sv_game.ts's dispatch: adding a THIRD recognized "game" cvar
// value alongside the existing "kex" (real kexgame content) and every other
// legacy name -- not redefining what `family`/`currentGameFamily()` means
// for anything that already exists.
//
// ============================================================================
// THE ONE REAL GAP: CONFIGSTRING INDEX LAYOUT (the "wide-entity/64-stat
// remaps" the task brief names)
// ============================================================================
// Entity state and player state are ALREADY universally wide regardless of
// family (ARCHITECTURE.md: "Internal state is the wide re-release shape
// regardless of which module runs" -- EntityStateT/PlayerStateT/
// PlayerStateT.stats are the same shape for every binding, confirmed by
// reading shared/q_shared.ts; PlayerStateT.stats is MAX_STATS_STORAGE=64-
// wide already, "wide core" limit lift, landed). Nothing extra is needed
// there: LMCTF's GClientT.ps IS a real PlayerStateT instance
// (src/lmctf/g_local.ts), and BuildLegacyImports/adaptPackGameExports
// (bindings/legacy.ts, reused verbatim below) already route it straight
// through the same engine services bindings/kex.ts uses.
//
// Configstrings are the one place that genuinely differs by more than just
// bounds: CS_REMAP_OLD and CS_REMAP_RERELEASE (shared/cs_remap.ts) put the
// SAME named block (CS_MODELS, CS_SOUNDS, CS_ITEMS, CS_PLAYERSKINS, ...) at
// DIFFERENT starting indices, because each family's MAX_MODELS/MAX_SOUNDS/
// MAX_IMAGES/etc. differ (e.g. CS_ITEMS is 1056 under CS_REMAP_OLD, 11326
// under CS_REMAP_RERELEASE). LMCTF's own game code (a frozen exhibit, see
// above) computes configstring indices against the plain, hardcoded CS_*
// constants from shared/q_shared.ts -- numerically the CS_REMAP_OLD values,
// always, regardless of which family is actually active (game/game.ts's
// GameImports has no CsRemapT-awareness at all; svs.csr is purely an
// engine-side concept). Left unmapped, `gi.configstring(CS_ITEMS + i, ...)`
// under an active CS_REMAP_RERELEASE would silently write LMCTF's item
// pickup message into whatever the WIDE layout considers that raw index to
// mean -- for CS_ITEMS specifically (1056..1311), that lands inside
// CS_REMAP_RERELEASE's SOUNDS block (62..8253), clobbering a sound-name
// precache slot a real 1038 client is relying on. SV_ModelIndex/
// SV_SoundIndex/SV_ImageIndex (sv_init.ts) are already family-aware --
// keyed off `svs.csr.models/sounds/images` internally, not a caller-
// supplied constant -- so `gi.modelindex/soundindex/imageindex` calls need
// no help here; only RAW `gi.configstring(CS_X + n, ...)` calls do.
// `remapLegacyConfigstringIndex` (shared/cs_remap.ts) does that translation
// generically, given both CsRemapT tables; `kexRemappedConfigstring` below
// applies it to every configstring write this binding's GameImports hands
// to LMCTF.
//
// One further, documented exception: src/lmctf/g_items.ts's Pickup_General
// writes `client.ps.stats[STAT_PICKUP_STRING] = CS_ITEMS + ITEM_INDEX(item)`
// directly (stock id Software behavior, shared by every legacy tree, not
// LMCTF-specific) -- a raw configstring index embedded as PLAYER-STATE DATA
// rather than passed through `gi.configstring()`, so there is no import-
// table seam to intercept it at. Grepped exhaustively (`= CS_`, `CS_X +` /
// `+ CS_X` across every src/lmctf/*.ts file) -- this is the ONLY such
// cross-boundary embedding LMCTF's own code contains. `fixupPickupStringStat`
// below is the documented shim the task brief allows for exactly this case:
// a whole-array pass over LMCTF's own (pre-adaptation, still LMCTF-typed)
// edicts after every entry point that can change a client's stats
// (Init/SpawnEntities/RunFrame -- mirrors bindings/kex.ts's own
// `syncAllEdictsFields` post-call cadence for the same reason: pickups
// happen inside RunFrame's entity-think/touch dispatch, not at a call this
// binding otherwise observes), remapping STAT_PICKUP_STRING's value exactly
// like a `gi.configstring()` call would have been remapped. The range check
// (only remap values inside CS_REMAP_OLD's ITEMS block) makes this
// idempotent: once remapped, the value moves into CS_REMAP_RERELEASE's
// ITEMS block, which is far outside CS_REMAP_OLD's range, so a later pass
// leaves it alone instead of re-remapping a already-wide index.

import type { GameExports, GameImports } from "../../game/game";
import { GetGameAPI as LMCTF_GetGameAPI } from "../../lmctf/g_main";
import { g_edicts as lmctfEdicts } from "../../lmctf/g_local";
import { BuildLegacyImports, adaptPackGameExports } from "./legacy";
import { PF_Configstring } from "../sv_game";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, remapLegacyConfigstringIndex } from "../../shared/cs_remap";
import { PlayerStateT, STAT_PICKUP_STRING, MAX_ITEMS } from "../../shared/q_shared";

/*
===============
kexRemappedConfigstring

Every `gi.configstring(index, str)` call LMCTF's game code makes uses a raw
index computed against CS_REMAP_OLD's layout (see file header) -- translate
it to the currently-active engine layout (CS_REMAP_RERELEASE, the only
reason this binding exists) before handing it to the real PF_Configstring.
===============
*/
function kexRemappedConfigstring(index: number, str: string): void {
  PF_Configstring(remapLegacyConfigstringIndex(index, CS_REMAP_OLD, CS_REMAP_RERELEASE), str);
}

/*
===============
BuildLmctfKexImports

Mirrors bindings/legacy.ts's BuildLegacyImports (reused verbatim for every
field except `configstring`) -- see that function's own header.
===============
*/
export function BuildLmctfKexImports(): GameImports {
  return {
    ...BuildLegacyImports(),
    configstring: kexRemappedConfigstring,
  };
}

interface PlayerStateHolder {
  ps: PlayerStateT;
}

function isPlayerStateHolder(client: unknown): client is PlayerStateHolder {
  return typeof client === "object" && client !== null && "ps" in client && (client as { ps: unknown }).ps instanceof PlayerStateT;
}

/*
===============
fixupPickupStringStat

See file header ("One further, documented exception"). Walks LMCTF's own
LIVE `g_edicts` module singleton (src/lmctf/g_local.ts) directly -- NOT
`lmctfGe.edicts` (the field on the object LMCTF's own GetGameAPI returns):
that field is a plain `[]` literal fixed at GetGameAPI-return time
(src/lmctf/g_main.ts's own GetGameAPI body), never reassigned once InitGame
later calls SetGEdicts to allocate the real, game.maxentities-sized array --
the exact same staleness bindings/legacy.ts's own header documents for the
ctf track ("the world-entity list exposed through `geHolder.ge.edicts` ...
does not yet reflect ctf's live entities"). Importing `g_edicts` directly
sidesteps that gap entirely, the same way src/lmctf/p_client.ts's own
`edictFromBoundary` does (`g_edicts.find(...)`, never `lmctfGe.edicts`).
`.client` narrows through the local type guard since `EdictT.client` is
typed `GClientT | null`, not the opaque `unknown` the engine-facing `Edict`
interface uses.
===============
*/
function fixupPickupStringStat(): void {
  for (const edict of lmctfEdicts) {
    if (!isPlayerStateHolder(edict.client)) continue;
    const stats = edict.client.ps.stats;
    const raw = stats[STAT_PICKUP_STRING];
    if (raw >= CS_REMAP_OLD.items && raw < CS_REMAP_OLD.items + MAX_ITEMS) {
      stats[STAT_PICKUP_STRING] = remapLegacyConfigstringIndex(raw, CS_REMAP_OLD, CS_REMAP_RERELEASE);
    }
  }
}

/*
===============
LoadLmctfKexGame

Calls LMCTF's own GetGameAPI(imports) directly (there is no DLL boundary in
this port -- see bindings/legacy.ts's identical note), through the
remapping GameImports above, adapts the result onto the engine's Edict-
shaped GameExports via bindings/legacy.ts's adaptPackGameExports (same
bridge plain "lmctf" already uses), then wraps Init/SpawnEntities/RunFrame
to run the STAT_PICKUP_STRING fixup pass afterward. This is the function
sv_game.ts's SV_InitGameProgs calls when "game" = "lmctf-kex" -- see file
header for why plain "lmctf" is untouched and keeps using
bindings/legacy.ts's LoadLegacyGame instead.
===============
*/
export function LoadLmctfKexGame(): GameExports {
  const importsObj = BuildLmctfKexImports();
  const ge = adaptPackGameExports(LMCTF_GetGameAPI(importsObj));

  const baseInit = ge.Init;
  const baseSpawnEntities = ge.SpawnEntities;
  const baseRunFrame = ge.RunFrame;

  ge.Init = () => {
    baseInit();
    fixupPickupStringStat();
  };
  ge.SpawnEntities = (mapname, entstring, spawnpoint) => {
    baseSpawnEntities(mapname, entstring, spawnpoint);
    fixupPickupStringStat();
  };
  ge.RunFrame = () => {
    baseRunFrame();
    fixupPickupStringStat();
  };

  return ge;
}
