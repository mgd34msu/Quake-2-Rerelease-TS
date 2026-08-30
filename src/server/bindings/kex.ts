// The kex (2023 re-release / API 2023) game binding, per ARCHITECTURE.md's
// "Core model: one engine, five first-class game modules". This is the peer
// binding to bindings/legacy.ts: where legacy.ts adapts engine-core services
// to the frozen v3 GameImports/GameExports contract for baseq2/ctf/xatrix/
// rogue, this module adapts the SAME engine-core services to the 2023
// KexGameImports/KexGameExports contract (src/kexapi/game.ts) for the merged
// kex content module (src/kexgame/), then bridges kex's GameExports shape
// back onto the legacy GameExports interface so the rest of the server
// (sv_game.ts's geHolder, sv_ents.ts, sv_user.ts, sv_ccmds.ts, ...) can keep
// treating "the loaded game" uniformly regardless of which binding produced
// it. legacy.ts stays untouched; this file is new.
//
// bindings/legacy.ts is the naming/structure precedent this file follows:
// BuildKexImports() assembles the import table (mirrors BuildLegacyImports),
// LoadKexGame() resolves the module and returns its GameExports (mirrors
// LoadLegacyGame). Read that file's header first if this one is unclear.
//
// ============================================================================
// WHY AN ADAPTER, NOT A NATIVE KEX PATH -- "TRANSITIONAL BRIDGE"
// ============================================================================
// ARCHITECTURE.md's phase order has the engine core migrating to a native
// kex-shaped internal model over phases 2-5 (wide entity/player state,
// variable tick, protocol layer); this unit lands ahead of that, in phase 6
// ("kex game module port"), purely to make the kex module *bootable* today.
// So every server-side consumer of "the loaded game" (sv_ents.ts, sv_user.ts,
// sv_world.ts, sv_send.ts, sv_ccmds.ts) still expects the OLD shapes:
// `GameExports` (game/game.ts, apiversion 3), `Edict` (its short server-
// visible edict prefix), `EntityStateT`/`PlayerStateT` (shared/q_shared.ts).
// This binding's `LoadKexGame()` therefore returns a `GameExports`-shaped
// object whose `apiversion` field is hardcoded to the LEGACY constant (see
// below) even though the real kex module underneath reports 2023 internally
// (checked once, inside kexgame's own `GetGameAPI`/`GAME_API_VERSION`, never
// exposed past this file) -- a deliberate, documented lie at the adapter
// boundary, matching legacy.ts's own `adaptPackGameExports` precedent of
// bridging one concrete shape onto another the rest of the server expects.
// `ClientChooseSlot`/`CanSave`/`server_flags`/`GetExtension`/`Bot_*`/
// `Entity_IsVisibleToPlayer`/`GetShadowLightData` on the real `KexGameExports`
// have no home on the legacy `GameExports` interface at all and are simply
// not exposed through this adapter -- nothing on the legacy dispatch path
// calls them, so this is a silent-but-harmless capability drop, not a bug.
//
// ============================================================================
// THE EDICT BRIDGE -- one parallel array, kept in sync at two cadences
// ============================================================================
// kexgame's `KexEdictT` (src/kexapi/game.ts) is a DIFFERENT TypeScript shape
// from the engine's `Edict` (game/game.ts) even though both describe "the
// short, server-visible edict prefix": KexEdictT carries `linked: boolean`
// instead of the engine's `area: LinkT`-membership convention, and lacks the
// engine-private `num_clusters`/`clusternums`/`headnode` PVS-assembly fields
// entirely (those live only on the engine side, populated by SV_LinkEdict,
// consumed by sv_ents.ts -- kex game code never reads them). Their entity-
// state types (`KexEntityStateT` vs `EntityStateT`) and player-state types
// (`KexPlayerStateT` vs `PlayerStateT`) also differ in specific, narrow ways
// documented field-by-field below. There is no way to make one JS object
// satisfy both interfaces simultaneously without either violating one side's
// contract or forking every field into a live proxy (rejected as needless
// complexity for a transitional bridge) -- so this binding maintains a
// SEPARATE, parallel array of engine-shaped `Edict` views, index-aligned
// with kexgame's own `g_edicts`/`GameExports.edicts` array (both indexed by
// `s.number`, the same EDICT_NUM convention every port line in this codebase
// already uses).
//
// `engineEdicts: Edict[]` is allocated ONCE per game (re)load, inside this
// binding's `Init()` wrapper, right after `kexGe.Init()` fixes the edict
// array's length (`game.maxentities`, kexgame/g_main.ts's InitGame). It is
// never reallocated afterward for the lifetime of that game instance: doing
// so would orphan every entity currently linked into the engine's area tree
// (sv_world.ts's `SV_LinkEdict` keys a WeakMap from each edict's `area: LinkT`
// object back to the owning `Edict`; replacing that `LinkT` object out from
// under a linked entity would leave the area tree pointing at a stale node
// forever). Per-frame/per-call syncing therefore always writes INTO the
// existing `engineEdicts[i]` objects' fields, never replaces them.
//
// Two sync cadences, both one-directional except where noted:
//
//   1. PER-ENTITY, AT link time (`linkentity`/`unlinkentity`/`setmodel`'s
//      implicit inline-model relink): kex is authoritative for position/
//      bounds/solidity, so `syncEdictKexToEngine` copies kex -> engine
//      BEFORE calling the real `SV_LinkEdict`/`SV_UnlinkEdict`, matching the
//      real engine's contract ("if the size, position, or solidity changes,
//      it must be relinked") -- collision queries (trace/pointcontents/
//      BoxEdicts) that run between linkentity calls always see whatever was
//      last linked, exactly like the real engine/game boundary already
//      works for the legacy binding. `syncLinkResultsToKex` then copies the
//      handful of fields ONLY the engine computes (`absmin`/`absmax`/`size`,
//      the encoded `s.solid` collision-box byte, `s.old_origin`, `linkcount`/
//      `areanum`/`areanum2`, and `linked` derived from `area.prev !== null`)
//      back onto the kex edict, so kex game code reading its own
//      `ent.absmin`/`ent.linked` afterward (real upstream game code does)
//      sees engine-accurate values.
//
//   2. WHOLE-ARRAY, after `Init()`/`SpawnEntities()`/`RunFrame()`: kex game
//      logic can change plenty of state that never needs a relink (frame
//      number, effects, sound, event, a client's player-state fields) but
//      that sv_ents.ts's per-client snapshot builder still needs to see on
//      the engine-view objects it reads from `geHolder.ge.edicts`. This pass
//      (`syncAllEdictsFields`) re-copies every in-array slot's full field
//      set (again kex -> engine only; the two engine-owned sub-fields above
//      are simply re-received as whatever kex is already holding, which by
//      construction is the value this binding itself wrote back at the last
//      link -- idempotent, not a fight over authority).
//
// Field-by-field translations (`syncEntityStateKexToEngine`):
//   - number, origin, angles, modelindex/2/3/4, frame, skinnum, renderfx,
//     sound, event, alpha, scale, instance_bits, loop_volume,
//     loop_attenuation, owner, old_frame: identical shape and meaning on
//     both sides (confirmed against q_shared.ts's EntityStateT, which
//     ARCHITECTURE.md's "wide core" commitment already widened with these
//     exact KEX fields) -- copied directly.
//   - effects (kex: `bigint`, up to bit 37) <-> effects+morefx (engine: two
//     `number` fields, low/high 32 bits): split/joined by `splitEffects`/
//     `joinEffects`, mirroring q_shared.ts's own EntityStateT.morefx design
//     note ("this port splits the value ... Q2PRO's extended protocol uses
//     the same effects/morefx split").
//   - old_origin, solid (the encoded collision-box byte): ENGINE-COMPUTED,
//     not forward-synced -- see cadence 1 above.
//
// `syncPlayerStateKexToEngine` (KexPlayerStateT -> PlayerStateT, only for
// edicts with a client):
//   - viewangles/viewoffset/kick_angles/gunangles/gunoffset, gunindex,
//     gunskin, gunframe, gunrate, fov, rdflags, team_id: identical shape
//     (again already widened by ARCHITECTURE.md's "wide core" commitment) --
//     copied directly. screen_blend (kex) <-> blend (engine, same vec4
//     shape, renamed per q_shared.ts's own documented convention) and
//     damage_blend (both sides, same name) likewise.
//   - pmove: kex's `KexPmoveStateT` uses FLOAT origin/velocity/delta_angles
//     and a wider `KexPmTypeT` (adds PM_GRAPPLE, PM_NOCLIP); the engine's
//     `PmoveStateT` (q_shared.ts) is still the vanilla 12.3-fixed-point
//     int16 shape -- NOT widened by the "wide core" phase (only the top-
//     level entity/player state was). origin/velocity are scaled *8 and
//     rounded/clamped to int16 (the same convention qcommon/pmove.ts's own
//     `pm.s.origin[i] = pml.origin[i] * 8` already uses); delta_angles go
//     through q_shared.ts's existing `ANGLE2SHORT`. `pm_type` is mapped by
//     `toEnginePmType`: PM_GRAPPLE has no legacy equivalent (grappling hook
//     is a [Paril-KEX] addition) and maps to PM_NORMAL; PM_NOCLIP has no
//     legacy pmove-type equivalent either (noclip is movetype-driven in the
//     legacy port) and maps to PM_SPECTATOR, the closest "no world
//     collision" legacy type -- both documented lossy mappings. `viewheight`
//     (kex, int8) has no field on this port's `PmoveStateT` at all and is
//     dropped. pm_flags/pm_time/gravity share the same low-bit encoding on
//     both sides (verified against kexapi/game.ts's `PmflagsT` bit
//     positions) and are copied as raw numbers.
//   - stats: kex widened `MAX_STATS` to 64 (kexapi/game.ts); this port's
//     `PlayerStateT.stats` is still the vanilla `Int16Array(32)`
//     (q_shared.ts's `MAX_STATS`). Only the first 32 slots survive the
//     crossing -- TODO(phase-2b): widen `PlayerStateT.stats` to 64 as part
//     of the ARCHITECTURE.md "wide core" limit lift, at which point this
//     truncation goes away. Reported, not silently accepted, per this
//     unit's brief.
//   - `client.ps` must be a real `new PlayerStateT()` INSTANCE, not merely a
//     structurally-compatible object: sv_ents.ts's/sv_main.ts's/
//     sv_ccmds.ts's own `client.ps instanceof PlayerStateT` type guards
//     require it. `ping` is copied alongside it into the same wrapper
//     object (`EngineClientView`), matching the narrow shape those guards
//     check (`{ ps: PlayerStateT; ping: number }`).
//
// ============================================================================
// A KNOWN, UNFIXED CAPACITY GAP -- reported, not silently absorbed
// ============================================================================
// This binding sets `svs.csr = CS_REMAP_RERELEASE` (done in sv_game.ts's
// dispatch, not here) so the already-family-aware `SV_ModelIndex`/
// `SV_SoundIndex`/`SV_ImageIndex`/`PF_Configstring` bound checks (all keyed
// off `svs.csr.*`, confirmed by reading sv_init.ts/sv_game.ts) accept kex's
// wide CS_* index layout instead of rejecting it against the narrow legacy
// one. `sv.configstrings` is already sized for the wide family regardless of
// which csr is active (server.ts's own comment: "Sized at the widest known
// family's configstring count"). However, `sv.models` (sv_init.ts/server.ts,
// `Array(MAX_MODELS)` = 256 slots) and `sv.entities` (server.ts,
// `Array(MAX_EDICTS)` = 1024 slots, used by SV_LinkEdict's framediv history
// ring) are STILL SIZED TO THE LEGACY, NARROW CONSTANTS -- they have not
// been widened as part of the "wide core" phase 2 commitment. A kex map
// or module that registers more than 256 models, or spawns an edict whose
// `s.number` reaches 1024, will hit `undefined` array reads this binding
// does not guard against (JS arrays don't throw on out-of-declared-length
// access, but `sv.entities[n].history` on an `undefined` slot will). Not
// fixed here: widening those two arrays is a cross-cutting engine-core
// change spanning server.ts/sv_init.ts/sv_world.ts, out of this unit's
// scope (bindings, not engine-core sizing). q2dm1 (the maiden-boot map) has
// well under 256 models and well under 1024 edicts, so this gap does not
// manifest on that map; it will on a busier or officially-wide-content map.
//
// ============================================================================
// OTHER DOCUMENTED, INTENTIONAL GAPS (TODOs cited at their call site too)
// ============================================================================
// - `clip` (single-entity clip, as opposed to a whole-world trace): the
//   engine has no `SV_Clip` equivalent. Documented stub, always reports a
//   clean miss. TODO(phase 7).
// - `trace`'s `plane2`/`surface2` (the second-best surface hit): the
//   engine's CM_BoxTrace/CM_TransformedBoxTrace track only one plane/
//   surface. Null/default. TODO(phase 7).
// - `inPVS`/`inPHS`'s `portals` parameter: ignored: the engine's own
//   PF_inPVS/PF_inPHS (sv_game.ts, reused directly here) never modeled
//   portal-only visibility either, matching q2repro's own PF_inVIS
//   (`portals` there is likewise a newer distinction the legacy PVS/PHS path
//   never had). TODO(phase 7).
// - `local_sound`'s `target`/`dupe_key` (splitscreen per-player delivery and
//   duplicate-send dedup): forwarded to the ordinary broadcast sound path
//   per this unit's brief ("local_sound can forward to sound + TODO
//   dupe_key") -- real per-target unicast needs SV_StartSound split into
//   build/send phases, and MAX_SPLIT_PLAYERS dedup, both ARCHITECTURE.md's
//   "Splitscreen" (phase 7).
// - `unicast`'s `dupe_key`: same splitscreen-dedup gap, ignored.
// - `BoxEdicts`'s filter callback: `SV_AreaEdicts` has no filter concept of
//   its own; applied here in TS after the fact against the engine's own
//   internal buffer ceiling (`shared/q_shared.ts`'s legacy `MAX_EDICTS`,
//   1024 -- the same ceiling SV_AreaEdicts's own `Com_Printf("...MAXCOUNT")`
//   already assumes internally; not re-widened here, same capacity-gap
//   rationale as above).
// - `GetPathToGoal`, `Bot_MoveToPoint`, `Bot_FollowActor`,
//   `Bot_RegisterEdict`/`Bot_UnRegisterEdict`: no-ops / `false` /
//   `GoalReturnCode.Error`. Nav/bots are ARCHITECTURE.md phase 7.
// - `Loc_Print`: real localization ($key resolution, loc_file cvar) is
//   ARCHITECTURE.md phase 7 ("Localization"). This binding does the
//   observable minimum -- substitute `{0}`, `{1}`, ... placeholders in
//   `base` with `args`, then forward to the same print path `Client_Print`
//   uses -- so callers see SOME text rather than a raw template string.
// - The ten `Draw_*` debug-draw primitives, `ReportMatchDetails_Multicast`,
//   `SendToClipBoard`, `GetExtension`: no-ops. ARCHITECTURE.md phase 7 /
//   genuinely out of scope for a headless dedicated boot.
// - `TagMalloc`/`TagFree`/`FreeTags`: no manual tag-allocator on this side
//   of the port (same rationale legacy.ts's own header gives for omitting
//   these three entirely from `GameImports` -- kex's `KexGameImports`
//   keeps them in the interface, so they are implemented here as no-ops/
//   `null` rather than omitted).
// - `tick_rate`/`frame_time_s`/`frame_time_ms`: snapshotted once from
//   `sv.framerate`/`sv.frametime` at `BuildKexImports()` time (matching how
//   the real C engine hands these to the game module once via
//   `game_import_t`, not a live callback). `sv.framerate` stays the
//   engine's global 10 Hz default until ARCHITECTURE.md phase 3 ("Variable
//   tick", `sv_tick_rate` defaulting to 40 for the kex module) lands --
//   kex's own internal step logic (`g_frames_per_frame`, etc.) already
//   tolerates whatever `gi.tick_rate` it's handed, so this is a known,
//   documented deviation from kex's native 40 Hz default, not a bug
//   introduced here.
// - `ClientThink`'s usercmd translation (`toKexUsercmd`): legacy `UsercmdT`
//   has no `server_frame` field (a kex/[Paril-KEX] wire-integrity addition);
//   the current server frame number (`sv.framenum`) is substituted as the
//   closest available signal. `upmove`/`impulse`/`lightlevel` (legacy-only)
//   are dropped; kex's `KexUsercmdT` never had them. angles: converted via
//   `SHORT2ANGLE` (q_shared.ts) into a float `Vec3`, matching kexapi/game.ts's
//   own documented "kex uses a float ... angles ... not fixed-point int16"
//   note. forwardmove/sidemove: both sides already use the same raw-speed
//   convention (not fixed-point) -- copied directly, no scaling.
//
// ============================================================================
// WriteGame/ReadGame/WriteLevel/ReadLevel -- the sanctioned filesystem seam
// ============================================================================
// kex's `WriteGameJson`/`ReadGameJson`/`WriteLevelJson`/`ReadLevelJson`
// (src/kexgame/g_save.ts) already work in JSON-TEXT-STRING space (unlike
// q2repro's C proxy, which base85-encodes through a temp file); this
// binding's job is purely to move that string through the filesystem, using
// the exact same seam the legacy `game/g_save.ts` already uses
// (`FS_WriteFile(filename, jsonString)` / `FS_ReadRawFile(filename)` decoded
// via `TextDecoder` -- verified against `game/g_save.ts`'s own
// `readJSONFile` helper). Legacy `GameExports.WriteLevel(filename)` carries
// no "is this a level-transition save or a full save" flag the way kex's
// `WriteLevelJson(transition, ...)` does; callers on this dispatch path
// (sv_ccmds.ts) never signal which one they mean either, so `transition:
// false` (full save) is the safe, documented default, not a silent guess.
// `CanSave()` has no home on the legacy `GameExports` interface at all (see
// the "TRANSITIONAL BRIDGE" note above) and is simply not exposed.

import { type Vec3, vec3, VectorCopy } from "../../shared/math";
import {
  EntityStateT,
  PlayerStateT,
  type UsercmdT,
  MulticastT,
  PmTypeT,
  CplaneT,
  Info_ValueForKey,
  Info_RemoveKey,
  Info_SetValueForKey,
  SHORT2ANGLE,
  ANGLE2SHORT,
  MAX_EDICTS,
} from "../../shared/q_shared";
import { Com_Printf } from "../../qcommon/common";
import { Cvar_Get, Cvar_Set, Cvar_ForceSet } from "../../qcommon/cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cbuf_AddText } from "../../qcommon/cmd";
import { CM_SetAreaPortalState, CM_AreasConnected } from "../../qcommon/cmodel";
import { FS_WriteFile, FS_ReadRawFile } from "../../qcommon/files";
import { sv } from "../server";
import { SV_Multicast, SV_StartSound, SV_BroadcastPrintf } from "../sv_send";
import { SV_ModelIndex, SV_SoundIndex, SV_ImageIndex } from "../sv_init";
import { SV_LinkEdict, SV_UnlinkEdict, SV_AreaEdicts, SV_Trace, SV_PointContents } from "../sv_world";
import {
  PF_Configstring,
  PF_Unicast,
  PF_cprintf,
  PF_centerprintf,
  PF_error,
  PF_setmodel,
  PF_inPVS,
  PF_inPHS,
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
import { type Edict, LinkT, SolidT as EngineSolidT, MAX_ENT_CLUSTERS, type GameExports, GAME_API_VERSION, type GTraceT } from "../../game/game";
import { GetGameAPI } from "../../kexgame/g_main";
import {
  type KexGameImports,
  type KexGameExports,
  type KexEdictT,
  type KexPlayerStateT,
  type KexGclientT,
  type KexTraceT,
  type KexUsercmdT,
  KexPmTypeT,
  SolidT as KexSolidT,
  KexMulticastT,
  type PrintTypeT,
  BoxEdictsResultT,
  type BoxEdictsFilterT,
  GoalReturnCode,
  type SolidityAreaT,
} from "../../kexapi/game";

//===============================================================
// effects_t (bigint) <-> effects/morefx (number/number) split
//===============================================================

export function splitEffects(e: bigint): { effects: number; morefx: number } {
  return { effects: Number(BigInt.asUintN(32, e)), morefx: Number(e >> 32n) };
}

export function joinEffects(effects: number, morefx: number): bigint {
  return (BigInt(morefx) << 32n) | BigInt(effects >>> 0);
}

//===============================================================
// cross-enum mappings (no casts: explicit, exhaustive switches)
//===============================================================

function toEngineSolid(s: KexSolidT): EngineSolidT {
  switch (s) {
    case KexSolidT.SOLID_NOT:
      return EngineSolidT.SOLID_NOT;
    case KexSolidT.SOLID_TRIGGER:
      return EngineSolidT.SOLID_TRIGGER;
    case KexSolidT.SOLID_BBOX:
      return EngineSolidT.SOLID_BBOX;
    case KexSolidT.SOLID_BSP:
      return EngineSolidT.SOLID_BSP;
  }
}

function toEnginePmType(t: KexPmTypeT): PmTypeT {
  switch (t) {
    case KexPmTypeT.PM_NORMAL:
      return PmTypeT.PM_NORMAL;
    // PM_GRAPPLE is a [Paril-KEX] addition with no legacy pmove-type
    // equivalent -- mapped to the closest "still simulated normally" type.
    case KexPmTypeT.PM_GRAPPLE:
      return PmTypeT.PM_NORMAL;
    // PM_NOCLIP has no legacy pmove-type equivalent either (noclip is
    // movetype-driven in the legacy port) -- mapped to the closest
    // "no world collision" legacy type.
    case KexPmTypeT.PM_NOCLIP:
      return PmTypeT.PM_SPECTATOR;
    case KexPmTypeT.PM_SPECTATOR:
      return PmTypeT.PM_SPECTATOR;
    case KexPmTypeT.PM_DEAD:
      return PmTypeT.PM_DEAD;
    case KexPmTypeT.PM_GIB:
      return PmTypeT.PM_GIB;
    case KexPmTypeT.PM_FREEZE:
      return PmTypeT.PM_FREEZE;
  }
}

function kexMulticastDest(to: KexMulticastT, reliable: boolean): MulticastT {
  switch (to) {
    case KexMulticastT.MULTICAST_ALL:
      return reliable ? MulticastT.MULTICAST_ALL_R : MulticastT.MULTICAST_ALL;
    case KexMulticastT.MULTICAST_PHS:
      return reliable ? MulticastT.MULTICAST_PHS_R : MulticastT.MULTICAST_PHS;
    case KexMulticastT.MULTICAST_PVS:
      return reliable ? MulticastT.MULTICAST_PVS_R : MulticastT.MULTICAST_PVS;
  }
}

function clampInt16(v: number): number {
  if (v > 32767) return 32767;
  if (v < -32768) return -32768;
  return v;
}

//===============================================================
// The edict bridge: parallel engine-shaped views, index-aligned with
// kexgame's own edicts array (see file header for the full design).
//===============================================================

let engineEdicts: Edict[] = [];
let kexEdictsRef: KexEdictT[] = [];

function createEngineEdict(): Edict {
  return {
    s: new EntityStateT(),
    client: null,
    inuse: false,
    linkcount: 0,
    area: new LinkT(),
    num_clusters: 0,
    clusternums: new Int32Array(MAX_ENT_CLUSTERS),
    headnode: 0,
    areanum: 0,
    areanum2: 0,
    svflags: 0,
    mins: vec3(),
    maxs: vec3(),
    absmin: vec3(),
    absmax: vec3(),
    size: vec3(),
    solid: EngineSolidT.SOLID_NOT,
    clipmask: 0,
    owner: null,
  };
}

// Allocates the parallel array ONCE per game (re)load -- see file header
// for why this must never be reallocated mid-game.
function allocateEngineViews(kexGe: KexGameExports): void {
  kexEdictsRef = kexGe.edicts;
  engineEdicts = Array.from({ length: kexGe.edicts.length }, () => createEngineEdict());
}

function engineViewForIndex(n: number): Edict {
  const e = engineEdicts[n];
  if (!e) {
    throw new Error(`kex binding: engine view for edict ${n} requested before Init() built the parallel array`);
  }
  return e;
}

function resolveEngineView(ent: KexEdictT | null): Edict | null {
  return ent ? engineViewForIndex(ent.s.number) : null;
}

function mustResolveEngineView(ent: KexEdictT | null, ctx: string): Edict {
  if (!ent) {
    throw new Error(`${ctx}: called with a null edict -- the C++ source dereferences it unconditionally here`);
  }
  return engineViewForIndex(ent.s.number);
}

function resolveKexFromEngine(eng: Edict | null): KexEdictT | null {
  if (!eng) return null;
  return kexEdictsRef[eng.s.number] ?? null;
}

function kexEdictForEngine(eng: Edict, ctx: string): KexEdictT {
  const kexEnt = kexEdictsRef[eng.s.number];
  if (!kexEnt) throw new Error(`${ctx}: no kex edict backing engine edict ${eng.s.number}`);
  return kexEnt;
}

//---------------------------------------------------------------
// entity_state_t sync (kex -> engine, one direction except the two
// engine-computed sub-fields called out below)
//---------------------------------------------------------------

function syncEntityStateKexToEngine(src: KexEdictT["s"], dst: EntityStateT): void {
  dst.number = src.number;
  VectorCopy(src.origin, dst.origin);
  VectorCopy(src.angles, dst.angles);
  // old_origin is engine-computed by SV_LinkEdict on first link -- NOT
  // forward-synced; see syncLinkResultsToKex.
  dst.modelindex = src.modelindex;
  dst.modelindex2 = src.modelindex2;
  dst.modelindex3 = src.modelindex3;
  dst.modelindex4 = src.modelindex4;
  dst.frame = src.frame;
  dst.skinnum = src.skinnum;
  const { effects, morefx } = splitEffects(src.effects);
  dst.effects = effects;
  dst.morefx = morefx;
  dst.renderfx = src.renderfx;
  // solid (the encoded collision-box byte) is engine-computed by
  // SV_LinkEdict -- NOT forward-synced; see syncLinkResultsToKex.
  dst.sound = src.sound;
  dst.event = src.event;
  dst.alpha = src.alpha;
  dst.scale = src.scale;
  dst.instance_bits = src.instance_bits;
  dst.loop_volume = src.loop_volume;
  dst.loop_attenuation = src.loop_attenuation;
  dst.owner = src.owner;
  dst.old_frame = src.old_frame;
}

interface EngineClientView {
  ps: PlayerStateT;
  ping: number;
}

function isEngineClientView(v: unknown): v is EngineClientView {
  return typeof v === "object" && v !== null && "ps" in v && (v as { ps: unknown }).ps instanceof PlayerStateT;
}

function syncPlayerStateKexToEngine(src: KexPlayerStateT, dst: PlayerStateT): void {
  dst.pmove.pm_type = toEnginePmType(src.pmove.pm_type);
  for (let i = 0; i < 3; i++) {
    dst.pmove.origin[i] = clampInt16(Math.round(src.pmove.origin[i] * 8));
    dst.pmove.velocity[i] = clampInt16(Math.round(src.pmove.velocity[i] * 8));
    dst.pmove.delta_angles[i] = ANGLE2SHORT(src.pmove.delta_angles[i]);
  }
  dst.pmove.pm_flags = src.pmove.pm_flags;
  dst.pmove.pm_time = src.pmove.pm_time;
  dst.pmove.gravity = src.pmove.gravity;
  // src.pmove.viewheight (int8) has no field on this port's PmoveStateT --
  // dropped, documented in the file header.

  VectorCopy(src.viewangles, dst.viewangles);
  VectorCopy(src.viewoffset, dst.viewoffset);
  VectorCopy(src.kick_angles, dst.kick_angles);
  VectorCopy(src.gunangles, dst.gunangles);
  VectorCopy(src.gunoffset, dst.gunoffset);
  dst.gunindex = src.gunindex;
  dst.gunskin = src.gunskin;
  dst.gunframe = src.gunframe;
  dst.gunrate = src.gunrate;
  dst.blend.set(src.screen_blend);
  dst.damage_blend.set(src.damage_blend);
  dst.fov = src.fov;
  dst.rdflags = src.rdflags;
  // MAX_STATS truncation (64 -> 32) -- see file header.
  dst.stats.set(src.stats.subarray(0, dst.stats.length));
  dst.team_id = src.team_id;
}

function syncClientKexToEngine(kexClient: KexGclientT | null, eng: Edict): void {
  if (!kexClient) {
    eng.client = null;
    return;
  }
  const view: EngineClientView = isEngineClientView(eng.client) ? eng.client : { ps: new PlayerStateT(), ping: 0 };
  view.ping = kexClient.ping;
  syncPlayerStateKexToEngine(kexClient.ps, view.ps);
  eng.client = view;
}

function syncEdictKexToEngine(kexEnt: KexEdictT, eng: Edict): void {
  eng.inuse = kexEnt.inuse;
  eng.svflags = kexEnt.svflags;
  VectorCopy(kexEnt.mins, eng.mins);
  VectorCopy(kexEnt.maxs, eng.maxs);
  eng.solid = toEngineSolid(kexEnt.solid);
  eng.clipmask = kexEnt.clipmask;
  eng.owner = resolveEngineView(kexEnt.owner);
  syncEntityStateKexToEngine(kexEnt.s, eng.s);
  syncClientKexToEngine(kexEnt.client, eng);
}

// The handful of fields ONLY the engine computes (SV_LinkEdict / the
// implicit relink inside PF_setmodel) -- copied back so kex game code
// reading its own edict afterward sees engine-accurate values.
function syncLinkResultsToKex(eng: Edict, kexEnt: KexEdictT): void {
  VectorCopy(eng.absmin, kexEnt.absmin);
  VectorCopy(eng.absmax, kexEnt.absmax);
  VectorCopy(eng.size, kexEnt.size);
  kexEnt.s.solid = eng.s.solid;
  VectorCopy(eng.s.old_origin, kexEnt.s.old_origin);
  kexEnt.linkcount = eng.linkcount;
  kexEnt.areanum = eng.areanum;
  kexEnt.areanum2 = eng.areanum2;
  kexEnt.linked = eng.area.prev !== null;
}

// Whole-array pass -- see file header cadence (2).
function syncAllEdictsFields(kexGe: KexGameExports): void {
  for (let i = 0; i < kexGe.edicts.length; i++) {
    syncEdictKexToEngine(kexGe.edicts[i], engineEdicts[i]);
  }
}

//---------------------------------------------------------------
// trace / usercmd conversions
//---------------------------------------------------------------

function toKexTrace(gt: GTraceT): KexTraceT {
  return {
    allsolid: gt.allsolid,
    startsolid: gt.startsolid,
    fraction: gt.fraction,
    endpos: gt.endpos,
    plane: gt.plane,
    surface: gt.surface ? { name: gt.surface.name, flags: gt.surface.flags, value: gt.surface.value, id: 0, material: "" } : null,
    contents: gt.contents,
    ent: resolveKexFromEngine(gt.ent),
    // [Paril-KEX] second-best surface hit -- the engine's CM_BoxTrace/
    // CM_TransformedBoxTrace track only a single plane/surface. TODO(phase 7).
    plane2: new CplaneT(),
    surface2: null,
  };
}

function noHitKexTrace(end: Vec3): KexTraceT {
  return {
    allsolid: false,
    startsolid: false,
    fraction: 1.0,
    endpos: end,
    plane: new CplaneT(),
    surface: null,
    contents: 0,
    ent: null,
    plane2: new CplaneT(),
    surface2: null,
  };
}

function toKexUsercmd(cmd: UsercmdT): KexUsercmdT {
  return {
    msec: cmd.msec,
    buttons: cmd.buttons,
    angles: vec3(SHORT2ANGLE(cmd.angles[0]), SHORT2ANGLE(cmd.angles[1]), SHORT2ANGLE(cmd.angles[2])),
    forwardmove: cmd.forwardmove,
    sidemove: cmd.sidemove,
    // No real client-reported frame counter exists on this port's UsercmdT
    // (a kex/[Paril-KEX] wire-integrity addition) -- see file header.
    server_frame: sv.framenum,
  };
}

//---------------------------------------------------------------
// print helpers shared by Client_Print / Loc_Print / Center_Print
//---------------------------------------------------------------

function kexClientPrint(ent: KexEdictT | null, level: PrintTypeT, message: string): void {
  if (!ent) {
    Com_Printf("%s", message);
    return;
  }
  PF_cprintf(resolveEngineView(ent), level, message);
}

function kexCenterPrint(ent: KexEdictT | null, message: string): void {
  if (!ent) return; // the console has no "center of screen"
  PF_centerprintf(mustResolveEngineView(ent, "Center_Print"), message);
}

function substituteLocArgs(base: string, args: string[], num_args: number): string {
  let out = base;
  for (let i = 0; i < num_args; i++) {
    out = out.split(`{${i}}`).join(args[i] ?? "");
  }
  return out;
}

//---------------------------------------------------------------
// BoxEdicts -- see file header for the filter/maxcount semantics
//---------------------------------------------------------------

function kexBoxEdicts(
  mins: Vec3,
  maxs: Vec3,
  list: (KexEdictT | null)[],
  maxcount: number,
  areatype: SolidityAreaT,
  filter: BoxEdictsFilterT | null,
  filter_data: unknown,
): number {
  const engineList: Edict[] = new Array(MAX_EDICTS);
  const rawCount = SV_AreaEdicts(mins, maxs, engineList, MAX_EDICTS, areatype);
  let kept = 0;
  for (let i = 0; i < rawCount; i++) {
    const kexEnt = resolveKexFromEngine(engineList[i]);
    if (filter) {
      const verdict = filter(kexEnt, filter_data);
      if (verdict === BoxEdictsResultT.Skip) continue;
      if (verdict === BoxEdictsResultT.End) break;
    }
    if (maxcount > 0 && kept < maxcount) list[kept] = kexEnt;
    kept++;
  }
  return maxcount > 0 ? Math.min(kept, maxcount) : kept;
}

/*
===============
BuildKexImports

Assembles the KexGameImports object handed to the kex game module. Mirrors
bindings/legacy.ts's BuildLegacyImports -- see this file's header for every
translation performed below.
===============
*/
export function BuildKexImports(): KexGameImports {
  return {
    tick_rate: sv.framerate,
    frame_time_s: sv.frametime / 1000,
    frame_time_ms: sv.frametime,

    Broadcast_Print: (printlevel, message) => SV_BroadcastPrintf(printlevel, "%s", message),
    Com_Print: (msg) => Com_Printf("%s", msg),
    Client_Print: (ent, printlevel, message) => kexClientPrint(ent, printlevel, message),
    Center_Print: (ent, message) => kexCenterPrint(ent, message),

    sound: (ent, channel, soundindex, volume, attenuation, timeofs) => {
      const target = ent ? mustResolveEngineView(ent, "sound") : engineViewForIndex(0);
      SV_StartSound(null, target, channel, soundindex, volume, attenuation, timeofs);
    },
    positioned_sound: (origin, ent, channel, soundindex, volume, attenuation, timeofs) => {
      const target = ent ? mustResolveEngineView(ent, "positioned_sound") : engineViewForIndex(0);
      SV_StartSound(origin, target, channel, soundindex, volume, attenuation, timeofs);
    },
    // [Paril-KEX] splitscreen per-target sound -- forwarded to the ordinary
    // broadcast sound path; `dupe_key` ignored. See file header.
    local_sound: (_target, origin, ent, channel, soundindex, volume, attenuation, timeofs, _dupe_key) => {
      const target = ent ? mustResolveEngineView(ent, "local_sound") : engineViewForIndex(0);
      SV_StartSound(origin, target, channel, soundindex, volume, attenuation, timeofs);
    },

    configstring: (num, str) => PF_Configstring(num, str),
    get_configstring: (num) => sv.configstrings[num] ?? "",

    Com_Error: (message) => PF_error(message),

    modelindex: (name) => SV_ModelIndex(name),
    soundindex: (name) => SV_SoundIndex(name),
    imageindex: (name) => SV_ImageIndex(name),

    setmodel: (ent, name) => {
      if (!ent) {
        throw new Error("setmodel: called with a null edict -- the C++ source dereferences it unconditionally here");
      }
      const eng = engineViewForIndex(ent.s.number);
      syncEdictKexToEngine(ent, eng);
      PF_setmodel(eng, name);
      syncLinkResultsToKex(eng, ent);
    },

    trace: (start, mins, maxs, end, passent, contentmask) => toKexTrace(SV_Trace(start, mins, maxs, end, resolveEngineView(passent), contentmask)),
    // [Paril-KEX] single-entity clip -- the engine has no SV_Clip. Documented
    // stub, always a clean miss. TODO(phase 7): CM_TransformedBoxTrace
    // against just `entity`'s headnode (mirrors sv_world.ts's
    // SV_ClipMoveToEntities per-entity branch).
    clip: (_entity, _start, _mins, _maxs, end, _contentmask) => noHitKexTrace(end),
    pointcontents: (point) => SV_PointContents(point),
    // `portals` ignored -- see file header (matches q2repro's own PF_inVIS).
    inPVS: (p1, p2, _portals) => PF_inPVS(p1, p2),
    inPHS: (p1, p2, _portals) => PF_inPHS(p1, p2),
    SetAreaPortalState: (portalnum, open) => CM_SetAreaPortalState(portalnum, open),
    AreasConnected: (area1, area2) => CM_AreasConnected(area1, area2),

    linkentity: (ent) => {
      if (!ent) return;
      const eng = engineViewForIndex(ent.s.number);
      syncEdictKexToEngine(ent, eng);
      SV_LinkEdict(eng);
      syncLinkResultsToKex(eng, ent);
    },
    unlinkentity: (ent) => {
      if (!ent) return;
      const eng = engineViewForIndex(ent.s.number);
      SV_UnlinkEdict(eng);
      ent.linked = eng.area.prev !== null;
    },
    BoxEdicts: (mins, maxs, list, maxcount, areatype, filter, filter_data) => kexBoxEdicts(mins, maxs, list, maxcount, areatype, filter, filter_data),

    multicast: (origin, to, reliable) => SV_Multicast(origin, kexMulticastDest(to, reliable)),
    unicast: (ent, reliable, _dupe_key) => PF_Unicast(resolveEngineView(ent), reliable),

    WriteChar: PF_WriteChar,
    WriteByte: PF_WriteByte,
    WriteShort: PF_WriteShort,
    WriteLong: PF_WriteLong,
    WriteFloat: PF_WriteFloat,
    WriteString: PF_WriteString,
    WritePosition: PF_WritePos,
    WriteDir: PF_WriteDir,
    WriteAngle: PF_WriteAngle,
    WriteEntity: (e) => PF_WriteShort(e ? e.s.number : 0),

    TagMalloc: () => null,
    TagFree: () => {},
    FreeTags: () => {},

    cvar: (var_name, value, flags) => Cvar_Get(var_name, value, flags),
    cvar_set: (var_name, value) => Cvar_Set(var_name, value),
    cvar_forceset: (var_name, value) => Cvar_ForceSet(var_name, value),

    argc: () => Cmd_Argc(),
    argv: (n) => Cmd_Argv(n),
    args: () => Cmd_Args(),

    AddCommandString: (text) => Cbuf_AddText(text),

    // SCR_DebugGraph is client render/debug-overlay code, not applicable to
    // a headless/dedicated engine -- no-op, matching legacy.ts's identical
    // DebugGraphNoop precedent.
    DebugGraph: () => {},

    GetExtension: () => null,

    // Bots: ARCHITECTURE.md phase 7. No-ops / GoalReturnCode.Error.
    Bot_RegisterEdict: () => {},
    Bot_UnRegisterEdict: () => {},
    Bot_MoveToPoint: () => GoalReturnCode.Error,
    Bot_FollowActor: () => GoalReturnCode.Error,

    // Nav: ARCHITECTURE.md phase 7.
    GetPathToGoal: () => false,

    // Localization: ARCHITECTURE.md phase 7 ("loc.c equivalent"). Minimum
    // observable behavior: substitute {0}/{1}/... placeholders, forward to
    // the same print path Client_Print uses.
    Loc_Print: (ent, level, base, args, num_args) => kexClientPrint(ent, level, substituteLocArgs(base, args, num_args)),

    // Debug draw: ARCHITECTURE.md phase 7 (versioned extension). No-ops.
    Draw_Line: () => {},
    Draw_Point: () => {},
    Draw_Circle: () => {},
    Draw_Bounds: () => {},
    Draw_Sphere: () => {},
    Draw_OrientedWorldText: () => {},
    Draw_StaticWorldText: () => {},
    Draw_Cylinder: () => {},
    Draw_Ray: () => {},
    Draw_Arrow: () => {},

    ReportMatchDetails_Multicast: () => {},

    ServerFrame: () => sv.framenum,

    SendToClipBoard: () => {},

    Info_ValueForKey: (s, key, buffer, buffer_len) => {
      const value = Info_ValueForKey(s, key);
      const truncated = value.length > buffer_len ? value.slice(0, buffer_len) : value;
      buffer[0] = truncated;
      return truncated.length;
    },
    Info_RemoveKey: (s, key) => {
      const result = Info_RemoveKey(s[0], key);
      const changed = result !== s[0];
      s[0] = result;
      return changed;
    },
    Info_SetValueForKey: (s, key, value) => {
      const result = Info_SetValueForKey(s[0], key, value);
      const applied = Info_ValueForKey(result, key) === value;
      s[0] = result;
      return applied;
    },
  };
}

/*
===============
adaptKexGameExports

Adapts an already-constructed KexGameExports (real or, in tests, a fake) onto
the legacy GameExports shape geHolder expects. Split out from LoadKexGame so
tests can exercise the adapter's own logic (apiversion mapping, PreInit/Init
ordering, RunFrame->RunFrame(true)+PrepFrame() ordering, ClientConnect's
{allowed,userinfo} translation, the edict bridge) against a small, fully-
controllable fake KexGameExports, without needing the real kexgame module's
InitGame (extensive real cvar registration, real g_spawn/g_save behavior) to
run. See this file's header ("TRANSITIONAL BRIDGE") for the full design.
===============
*/
export function adaptKexGameExports(kexGe: KexGameExports): GameExports {
  return {
    // A deliberate, documented lie: the real kex module reports 2023
    // internally (checked once inside kexgame's own GetGameAPI, never
    // exposed past this file); this adapter reports the legacy constant so
    // sv_game.ts's SV_InitGameProgs apiversion check keeps working
    // uniformly across both bindings. See file header.
    apiversion: GAME_API_VERSION,

    Init: () => {
      // q2repro game.c:1142 order: PreInit before Init.
      kexGe.PreInit();
      kexGe.Init();
      allocateEngineViews(kexGe);
      syncAllEdictsFields(kexGe);
    },
    Shutdown: () => kexGe.Shutdown(),
    SpawnEntities: (mapname, entstring, spawnpoint) => {
      kexGe.SpawnEntities(mapname, entstring, spawnpoint);
      syncAllEdictsFields(kexGe);
    },

    WriteGame: (filename, autosave) => {
      const outSize: [number] = [0];
      const json = kexGe.WriteGameJson(autosave, outSize);
      FS_WriteFile(filename, json ?? "");
    },
    ReadGame: (filename) => {
      const buf = FS_ReadRawFile(filename);
      if (buf === null) throw new Error(`LoadKexGame.ReadGame: couldn't open ${filename}`);
      kexGe.ReadGameJson(new TextDecoder().decode(buf));
      syncAllEdictsFields(kexGe);
    },
    WriteLevel: (filename) => {
      const outSize: [number] = [0];
      // No "transition" signal available at this call site -- full save is
      // the safe default. See file header.
      const json = kexGe.WriteLevelJson(false, outSize);
      FS_WriteFile(filename, json ?? "");
    },
    ReadLevel: (filename) => {
      const buf = FS_ReadRawFile(filename);
      if (buf === null) throw new Error(`LoadKexGame.ReadLevel: couldn't open ${filename}`);
      kexGe.ReadLevelJson(new TextDecoder().decode(buf));
      syncAllEdictsFields(kexGe);
    },

    ClientConnect: (ent, userinfo) => {
      const kexEnt = kexEdictForEngine(ent, "ClientConnect");
      const box: [string] = [userinfo];
      const allowed = kexGe.ClientConnect(kexEnt, box, "", false);
      return { allowed, userinfo: box[0] };
    },
    ClientBegin: (ent) => kexGe.ClientBegin(kexEdictForEngine(ent, "ClientBegin")),
    ClientUserinfoChanged: (ent, userinfo) => kexGe.ClientUserinfoChanged(kexEdictForEngine(ent, "ClientUserinfoChanged"), userinfo),
    ClientDisconnect: (ent) => kexGe.ClientDisconnect(kexEdictForEngine(ent, "ClientDisconnect")),
    ClientCommand: (ent) => kexGe.ClientCommand(kexEdictForEngine(ent, "ClientCommand")),
    ClientThink: (ent, cmd) => kexGe.ClientThink(kexEdictForEngine(ent, "ClientThink"), toKexUsercmd(cmd)),

    RunFrame: () => {
      kexGe.RunFrame(true);
      kexGe.PrepFrame();
      syncAllEdictsFields(kexGe);
    },
    ServerCommand: () => kexGe.ServerCommand(),

    get edicts() {
      return engineEdicts;
    },
    get num_edicts() {
      return kexGe.num_edicts;
    },
    set num_edicts(v: number) {
      kexGe.num_edicts = v;
    },
    get max_edicts() {
      return kexGe.max_edicts;
    },
    set max_edicts(v: number) {
      kexGe.max_edicts = v;
    },
  };
}

/*
===============
LoadKexGame

Calls kexgame's GetGameAPI(imports) directly (there is no DLL boundary in
this port -- see bindings/legacy.ts's identical note), then adapts the
returned KexGameExports via adaptKexGameExports. This is the function
sv_game.ts's SV_InitGameProgs actually calls; adaptKexGameExports itself is
exported separately purely for testability (see its own header comment).
===============
*/
export function LoadKexGame(): GameExports {
  return adaptKexGameExports(GetGameAPI(BuildKexImports()));
}
