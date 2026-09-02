// game.h -- game dll information visible to server
//
// PORTING.md trace_t.ent ruling: `trace_t.ent` is `unknown` in
// src/shared/q_shared.ts (C forward-declares `struct edict_s` there). This
// module ports game.h's shared edict prefix as `interface Edict`; server
// code uses `Edict` throughout and game code recovers its full `EdictT`
// with the C idiom `g_edicts[ent.s.number]` (EDICT_NUM), never a cast.
// Game-facing traces are typed here as `GTraceT`.
//
// `EdictT` (the full game-private struct) lives in g_local.ts, which
// imports `Edict`/`GameImports`/`GTraceT` from this module. This module in
// turn imports `EdictT` (type-only, erased at compile time) from g_local.ts
// for the `GameExports.edicts` field below. That is a type-only cycle, not
// a runtime one: game.ts never imports a *value* from g_local.ts, so the
// runtime module graph stays a single direction (g_local.ts -> game.ts).

import type { Vec3 } from "../shared/math";
import {
  type CvarT,
  type EntityStateT,
  MulticastT,
  type PmoveT,
  type TraceT,
  type UsercmdT,
} from "../shared/q_shared";
import type { EdictT } from "./g_local";

export const GAME_API_VERSION = 3;

// edict->svflags
export const SVF_NOCLIENT = 0x00000001; // don't send entity to clients, even if it has effects
export const SVF_DEADMONSTER = 0x00000002; // treat as CONTENTS_DEADMONSTER for collision
export const SVF_MONSTER = 0x00000004; // treat as CONTENTS_MONSTER for collision
// RERELEASE CONTENT PORT (rogue/game.h: "added for things that are
// damageable but not monsters"): tesla mines, the spheres and the
// doppleganger set this so T_Damage and the monster-targeting code treat
// them as valid targets without making them count as monsters. Vanilla
// entities never set it, so the new bit is inert for classic content.
export const SVF_DAMAGEABLE = 0x00000008;

// edict->solid values
export enum SolidT {
  SOLID_NOT, // no interaction with other objects
  SOLID_TRIGGER, // only touch when inside, after moving
  SOLID_BBOX, // touch on edge
  SOLID_BSP, // bsp clip, touch on edge
}

//===============================================================

// link_t is only used for entity area links now
export class LinkT {
  prev: LinkT | null = null;
  next: LinkT | null = null;
}

export const MAX_ENT_CLUSTERS = 16;

// The server-visible prefix of `struct edict_s` (game.h's short form, used
// when GAME_INCLUDE is not defined). The game module's full struct lives in
// g_local.ts as `EdictT`, which implements this interface. `client` refers
// to `struct gclient_s *`, whose concrete shape (`GClientT`) is private to
// the game module and not visible across this boundary, so it is typed
// `unknown` here -- the same forward-declaration idiom q_shared.ts uses for
// `trace_t.ent`.
export interface Edict {
  s: EntityStateT;
  client: unknown; // struct gclient_s * -- concrete type is g_local.ts's GClientT
  inuse: boolean;
  linkcount: number;

  // FIXME: move these fields to a server private sv_entity_t
  area: LinkT; // linked to a division node or leaf

  num_clusters: number; // if -1, use headnode instead
  clusternums: Int32Array; // length MAX_ENT_CLUSTERS
  headnode: number; // unused if num_clusters != -1
  areanum: number;
  areanum2: number;

  //================================

  svflags: number; // SVF_NOCLIENT, SVF_DEADMONSTER, SVF_MONSTER, etc
  mins: Vec3;
  maxs: Vec3;
  absmin: Vec3;
  absmax: Vec3;
  size: Vec3;
  solid: SolidT;
  clipmask: number;
  owner: Edict | null;
}

// a trace returned to game code: same shape as q_shared.ts's TraceT, but
// with `ent` recovered as the game-visible `Edict` instead of `unknown`.
// plane2/surface2 are optional here (unlike the concrete TraceT class, which
// always initializes them): the many existing hand-built GTraceT trace-stub
// literals across the test suite predate the second-surface fields and have
// no reason to know about them -- real production trace results (sv_world.ts's
// toGTrace, bindings/kex.ts's toKexTrace) always populate both.
export interface GTraceT extends Omit<TraceT, "ent"> {
  ent: Edict | null;
}

//===============================================================

//
// functions provided by the main engine
//
/**
 * One player's fog state as p_client.cpp's P_ForceFogTransition carries it.
 * Colour channels and `sky_factor` are 0..1 (the engine scales them to the
 * bytes svc_fog puts on the wire); `hf_start`/`hf_end` are
 * [r, g, b, distance] with the colour 0..1 and the distance in world units.
 */
export interface FogStateT {
  density: number;
  r: number;
  g: number;
  b: number;
  sky_factor: number;
  hf_falloff: number;
  hf_density: number;
  hf_start: readonly [number, number, number, number];
  hf_end: readonly [number, number, number, number];
}

/** RGBA 0..1, the colour argument info_world_text's draw calls take. */
export type FogRgbaT = readonly [number, number, number, number];

/**
 * One nav-mesh path query, the classic module's spelling of the re-release
 * `PathRequest` (src/kexapi/game.ts). Flattened on purpose: the re-release
 * struct nests four sub-structs (debugging / nodeSearch / traversals /
 * pathPoints), and of those the only fields any consumer in this module ever
 * sets are the four node-search knobs and the output buffer -- `debugging`
 * is the USE_REF draw-time this port has no renderer for, and `traversals`
 * is monster-movement policy the compass never uses. The engine half
 * (src/server/bindings/kex.ts's PF_GetPathToGoal for the classic family)
 * fills the untouched sub-structs with the same defaults the C++ struct's
 * own member initializers carry, so a query built here is byte-equivalent to
 * the one src/kexgame builds for the same call site.
 *
 * `points` is the caller's output buffer and `maxPoints` its length; pass
 * `null`/`0` when only `pathDistSqr` is wanted (target_poi's
 * distance_to_poi does exactly that). The engine writes at most `maxPoints`
 * entries IN PLACE into the Vec3 objects already in the array -- it never
 * replaces them -- matching the pointer-into-caller-memory contract the
 * re-release's `PathRequest::PathArray::array` has.
 */
export interface PathQueryT {
  start: Vec3;
  goal: Vec3;
  moveDist: number;
  /** PathFlags bitfield; 0xffffffff is the re-release's `PathFlags::All`. */
  pathFlags: number;
  ignoreNodeFlags: boolean;
  /** 0 = "use the engine default" for each of the three, as in the C++. */
  minHeight: number;
  maxHeight: number;
  radius: number;
  points: Vec3[] | null;
  maxPoints: number;
}

/**
 * The result half of a `get_path_to_goal` query -- the re-release's
 * `PathInfo` (src/kexapi/game.ts) returned by value instead of filled
 * through an out-parameter, since nothing in this module needs to reuse a
 * PathInfo across calls the way m_move.cpp's monster navigation does.
 *
 * `found` is the C++ call's own boolean return (`returnCode <
 * PathReturnCode::StartPathErrors`). `returnCode` is carried through raw
 * because distance_to_poi has to tell "no nav data for this map" (8,
 * `PathReturnCode::NoNavAvailable`) apart from every other failure -- that
 * one case falls back to straight-line distance instead of infinity.
 */
export interface PathResultT {
  found: boolean;
  returnCode: number;
  numPathPoints: number;
  pathDistSqr: number;
  firstMovePoint: Vec3;
  secondMovePoint: Vec3;
}

export interface GameImports {
  // special messages
  bprintf(printlevel: number, fmt: string): void;
  dprintf(fmt: string): void;
  cprintf(ent: Edict | null, printlevel: number, fmt: string): void;
  centerprintf(ent: Edict, fmt: string): void;
  sound(
    ent: Edict,
    channel: number,
    soundindex: number,
    volume: number,
    attenuation: number,
    timeofs: number,
  ): void;
  positioned_sound(
    origin: Vec3,
    ent: Edict,
    channel: number,
    soundindex: number,
    volume: number,
    attenuation: number,
    timeofs: number,
  ): void;

  // config strings hold all the index strings, the lightstyles,
  // and misc data like the sky definition and cdtrack.
  // All of the current configstrings are sent to clients when
  // they connect, and changes are sent to all connected clients.
  configstring(num: number, str: string): void;

  // ---------------------------------------------------------------------
  // ADDITIONS TO THE FROZEN v3 IMPORT SET (not in the 1997 game.h).
  //
  // The configstring space is a property of the SESSION, not of the game
  // module (src/server/sv_init.ts's SV_WidenConfigstringSpace). A classic
  // module hosted on the WIDE layout can deliver presentation the classic
  // layout has no room for, and these two are how it asks and how it
  // publishes.
  //
  // Both are OPTIONAL (`?`) on purpose: the engine always supplies them
  // (src/server/bindings/legacy.ts), but declaring them optional means the
  // other frozen legacy trees -- src/ctf, src/rogue, src/xatrix, src/lmctf,
  // each with its own copy of this interface -- need no edit at all to keep
  // compiling and keep behaving identically. Call sites use `?.()` and treat
  // "absent" as "classic layout", which is the correct answer for any engine
  // that does not provide them.
  // ---------------------------------------------------------------------

  // True when this session runs on the wide (re-release) configstring
  // layout, i.e. when the client will have cls.csr.extended set and the
  // delta can carry s.alpha / s.scale and the extended renderfx bits.
  extended_layout?(): boolean;

  // Publish one CS_SHADOWLIGHTS slot. The block exists only in the wide
  // layout (cs_remap.ts gives CS_REMAP_OLD shadowlights -1 /
  // max_shadowlights 0), and its index cannot be spelled in the frozen v3
  // CS_* constants at all, so it cannot go through configstring() and its
  // legacy-index translation. `slot` is 0-based within the block; the engine
  // adds the live layout's base and bounds-checks.
  shadowlight?(slot: number, value: string): void;

  // One player's fog state, exactly the set p_client.cpp's
  // P_ForceFogTransition carries: global fog (density; r/g/b and sky factor
  // all 0..1) plus the height-fog gradient (falloff, density, and a
  // start/end pair whose first three slots are colour 0..1 and whose fourth
  // is a world-unit distance).
  //
  // Publish one player's fog transition. The engine writes the re-release
  // svc_fog message -- a bitmask packet carrying only the fields that differ
  // between `current` and `wanted` -- and unicasts it reliably to `ent`.
  // `transitionMs` is the lerp duration the client should take to get there,
  // or null for "no BIT_TIME field" (an instant change, or a trigger_fog
  // with no delay).
  //
  // Silently does nothing on a narrow session: protocol 34 has no svc_fog
  // and a vanilla client would desync on the unknown opcode. Callers may
  // therefore call unconditionally, exactly as with shadowlight() above.
  fog?(ent: Edict, current: FogStateT, wanted: FogStateT, transitionMs: number | null): void;

  // The re-release compass/objective marker (svc_poi) and its breadcrumb
  // trail (svc_help_path), unicast to one player. Same reason PF_Fog exists:
  // both opcodes and their field layouts are re-release wire vocabulary that
  // the frozen v3 GameImports cannot name, and neither exists in protocol 34.
  //
  // `key` is the POI slot the client keys the marker on (the re-release
  // reserves MAX_EDICTS for the level objective and MAX_EDICTS+3+n for player
  // pings); `timeMs` is how long the client keeps it (0xffff means "delete the
  // POI with this key"); `image` is a CS_IMAGES index; `color` is a palette
  // index; `flags` is the svc_poi flag byte (1 = hide when aimed at).
  //
  // Silently does nothing on a narrow session, exactly like fog() and
  // shadowlight(), so callers may call unconditionally.
  poi?(ent: Edict, key: number, timeMs: number, pos: Vec3, image: number, color: number, flags: number): void;

  // One breadcrumb marker of the compass path. `first` marks the start of a
  // fresh trail (the client clears the old one); `pos` is the marker's world
  // position and `dir` the direction to the following marker. Unreliable,
  // matching the re-release's own `gi.unicast(ent, false, 0)`.
  help_path?(ent: Edict, first: boolean, pos: Vec3, dir: Vec3): void;

  // The nav-mesh path query behind the compass trail: the classic module's
  // spelling of the re-release's `gi.GetPathToGoal`
  // (src/kexapi/game.ts's GameImports). Optional for exactly the reason
  // poi()/help_path()/fog() are: it is re-release engine vocabulary the
  // frozen v3 GameImports cannot name, so the module calls it with `?.()`
  // and copes with `undefined`.
  //
  // ABSENT IS NOT THE SAME AS "NO PATH". A missing hook is what the
  // re-release calls `PathReturnCode::NoNavAvailable` -- distance_to_poi's
  // documented straight-line fallback -- while a present hook returning
  // `found: false` means the engine looked and found no walkable route.
  // g_kextarg.ts's two call sites distinguish the two.
  //
  // Unlike poi()/help_path(), this one does NOT depend on the session having
  // widened onto the re-release configstring layout: it puts nothing on the
  // wire. It depends only on the server having nav data loaded for this map,
  // which for the legacy family is the opt-in `sv_nav_legacy` cvar
  // (src/server/nav.ts's header records the ruling and the default).
  get_path_to_goal?(query: PathQueryT): PathResultT;

  // info_world_text's two draw calls (g_misc.cpp:2276-2325). The re-release
  // routes these straight into the client renderer's debug-primitive list;
  // this engine's server-side equivalent is src/server/sv_debugdraw.ts, the
  // same buffer bindings/kex.ts hands the kex module. `size` is the text
  // height, `lifeTime` is in seconds.
  draw_oriented_world_text?(origin: Vec3, text: string, color: FogRgbaT, size: number, lifeTime: number, depthTest: boolean): void;
  draw_static_world_text?(origin: Vec3, angles: Vec3, text: string, color: FogRgbaT, size: number, lifeTime: number, depthTest: boolean): void;

  // Com_Error(ERR_DROP, ...) never returns to the caller (see PORTING.md
  // idiom map: ComError is thrown and caught in Qcommon_Frame).
  error(fmt: string): never;

  // the *index functions create configstrings and some internal server state
  modelindex(name: string): number;
  soundindex(name: string): number;
  imageindex(name: string): number;

  setmodel(ent: Edict, name: string): void;

  // collision detection
  trace(
    start: Vec3,
    mins: Vec3 | null,
    maxs: Vec3 | null,
    end: Vec3,
    passent: Edict | null,
    contentmask: number,
  ): GTraceT;
  pointcontents(point: Vec3): number;
  inPVS(p1: Vec3, p2: Vec3): boolean;
  inPHS(p1: Vec3, p2: Vec3): boolean;
  SetAreaPortalState(portalnum: number, open: boolean): void;
  AreasConnected(area1: number, area2: number): boolean;

  // an entity will never be sent to a client or used for collision
  // if it is not passed to linkentity.  If the size, position, or
  // solidity changes, it must be relinked.
  linkentity(ent: Edict): void;
  unlinkentity(ent: Edict): void; // call before removing an interactive edict
  BoxEdicts(mins: Vec3, maxs: Vec3, list: Edict[], maxcount: number, areatype: number): number;
  Pmove(pmove: PmoveT): void; // player movement code common with client prediction

  // network messaging
  multicast(origin: Vec3, to: MulticastT): void;
  unicast(ent: Edict, reliable: boolean): void;
  WriteChar(c: number): void;
  WriteByte(c: number): void;
  WriteShort(c: number): void;
  WriteLong(c: number): void;
  WriteFloat(f: number): void;
  WriteString(s: string): void;
  WritePosition(pos: Vec3): void; // some fractional bits
  WriteDir(pos: Vec3): void; // single byte encoded, very coarse
  WriteAngle(f: number): void;

  // managed memory allocation: `TagMalloc`/`TagFree`/`FreeTags` are OMITTED
  // per PORTING.md ("Z_Malloc/Z_Free/Hunk_*/Z_TagMalloc -> plain
  // allocation") -- there is no manual tag-based allocator on this side of
  // the boundary, so these three fields are dropped from the interface.

  // console variable interaction
  cvar(var_name: string, value: string | null, flags: number): CvarT | null;
  cvar_set(var_name: string, value: string): CvarT | null;
  cvar_forceset(var_name: string, value: string): CvarT | null;

  // ClientCommand and ServerCommand parameter access
  argc(): number;
  argv(n: number): string;
  args(): string; // concatenation of all argv >= 1

  // add commands to the server console as if they were typed in
  // for map changing, etc
  AddCommandString(text: string): void;

  DebugGraph(value: number, color: number): void;
}

//
// functions exported by the game subsystem
//
export interface GameExports {
  apiversion: number;

  // the init function will only be called when a game starts,
  // not each time a level is loaded.  Persistant data for clients
  // and the server can be allocated in init
  Init(): void;
  Shutdown(): void;

  // each new level entered will cause a call to SpawnEntities
  SpawnEntities(mapname: string, entstring: string, spawnpoint: string): void;

  // Read/Write Game is for storing persistant cross level information
  // about the world state and the clients.
  // WriteGame is called every time a level is exited.
  // ReadGame is called on a loadgame.
  WriteGame(filename: string, autosave: boolean): void;
  ReadGame(filename: string): void;

  // ReadLevel is called after the default map information has been
  // loaded with SpawnEntities
  WriteLevel(filename: string): void;
  ReadLevel(filename: string): void;

  // Optional kex-family-only string seam, alongside the filename-taking
  // WriteGame/ReadGame/WriteLevel/ReadLevel above: q2repro's save.c actually
  // owns the on-disk savegame CONTAINER itself (SSV2/SAV2 -- magic, version,
  // engine metadata) and only ever hands the game module a JSON string to
  // produce or consume (`ge->WriteGameJson(...)`/`ge->ReadGameJson(buf)`,
  // save.c:94/473), unlike the filename-based WriteGame/ReadGame/WriteLevel/
  // ReadLevel contract above, which assumes the game module owns its own
  // file I/O end-to-end (true for the legacy v3 game modules, never true
  // for kex). The kex binding (bindings/kex.ts) is the only implementer;
  // legacy game modules leave these undefined, since legacy.ts's
  // adaptPackGameExports has no JSON-string save format to expose. The
  // engine's SSV2/SAV2 container writer/reader (sv_ccmds.ts's
  // SV_WriteServerFileKex/SV_ReadServerFileKex/SV_WriteLevelFileKex/
  // SV_ReadLevelFileKex) calls these directly and does its own
  // FS_WriteFile/FS_LoadFile, matching save.c's actual "engine owns files"
  // split -- see bindings/kex.ts's file header for how WriteGame/ReadGame/
  // WriteLevel/ReadLevel above are now built on top of these instead of
  // duplicating the kexGe call.
  WriteGameJson?(autosave: boolean): string | null;
  ReadGameJson?(json: string): void;
  WriteLevelJson?(transition: boolean): string | null;
  ReadLevelJson?(json: string): void;

  // [Paril-KEX] q2repro save.c's `if (!ge->CanSave()) return;` gate in
  // SV_Savegame_f (src/kexapi/game.ts's `KexGameExports.CanSave()`, always
  // present there). Same "kex-family-only, legacy leaves it undefined"
  // shape as the four JSON members above -- sv_ccmds.ts's SV_Savegame_f
  // checks `currentGameFamily() === "kex"` before calling it.
  CanSave?(): boolean;

  // C mutates `userinfo` in place (the game DLL can inject a "rejmsg" key on
  // rejection) and returns qboolean; JS strings are immutable, so the
  // mutated userinfo and the accept/reject flag are both returned instead.
  // Settled interface ruling (U021b/followups.md): { allowed, userinfo }.
  ClientConnect(ent: Edict, userinfo: string): { allowed: boolean; userinfo: string };
  ClientBegin(ent: Edict): void;
  ClientUserinfoChanged(ent: Edict, userinfo: string): void;
  ClientDisconnect(ent: Edict): void;
  ClientCommand(ent: Edict): void;
  ClientThink(ent: Edict, cmd: UsercmdT): void;

  // mainLoop mirrors the kex API's RunFrame(bool main_loop): q2repro's
  // engine passes FALSE for SV_SpawnServer's two post-spawn settle frames
  // and SV_CheckForSavegame's catch-up frames (init.c ge->RunFrame(false)),
  // which bypasses G_RunFrame's no-player-spawned early-out. Optional and
  // defaulted true so every legacy game implementation (which has no such
  // concept and ignores the parameter) is untouched.
  RunFrame(mainLoop?: boolean): void;

  // ServerCommand will be called when an "sv <command>" command is issued on the
  // server console.
  // The game can issue gi.argc() / gi.argv() commands to get the rest
  // of the parameters
  ServerCommand(): void;

  //
  // global variables shared between game and server
  //

  // The C struct holds `edict_s *edicts` (a pointer to a block sized by
  // `edict_size` since the game DLL's edict_t is larger than the server's)
  // plus `edict_size` for pointer arithmetic when walking the array.
  // TypeScript arrays need no element stride, so this reshapes the
  // pointer+size pair into a plain array of full edicts; `edict_size` is
  // dropped entirely (reported per PORTING.md).
  edicts: Edict[];
  num_edicts: number; // current number, <= max_edicts
  max_edicts: number;
}
