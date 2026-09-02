// game.h -- game dll information visible to server
//
// rogue/game.h vs baseq2/game.h: banner swap plus one addition --
// `#define SVF_DAMAGEABLE 0x00000008` ("added for things that are
// damageable, but not monsters -- right now, only the tesla has this").
// Everything else in this module is copied byte-for-byte from
// src/game/game.ts; see that file's header comment for the porting notes
// this module inherits (Edict/GTraceT boundary shapes, the game.ts <->
// g_local.ts type-only import cycle, etc).

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
// ROGUE -- added for things that are damageable, but not monsters
// right now, only the tesla has this
export const SVF_DAMAGEABLE = 0x00000008;
// ROGUE end

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

  svflags: number; // SVF_NOCLIENT, SVF_DEADMONSTER, SVF_MONSTER, SVF_DAMAGEABLE, etc
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
export interface GTraceT extends Omit<TraceT, "ent"> {
  ent: Edict | null;
}

//===============================================================

//
// functions provided by the main engine
//
/**
 * One nav-mesh path query, this module's spelling of the re-release
 * `PathRequest`. IDENTICAL to src/game/game.ts's PathQueryT and copied in for
 * the same reason every other shared shape in this file is: this tree is a
 * HARD FORK of src/game with its own Edict and its own GameImports, and there
 * is no cross-module import anywhere in the tree.
 *
 * Flattened on purpose: the re-release struct nests four sub-structs
 * (debugging / nodeSearch / traversals / pathPoints), and the only fields any
 * consumer here ever sets are the four node-search knobs and the output
 * buffer. The engine half (src/server/bindings/legacy.ts's PF_GetPathToGoal)
 * fills the untouched sub-structs with the C++ struct's own member-initializer
 * defaults.
 *
 * `points` is the caller's output buffer and `maxPoints` its length; pass
 * `null`/`0` when only `pathDistSqr` is wanted, which is exactly what
 * g_kextarg.ts's distance_to_poi does -- the only caller in this module.
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
 * `PathInfo`, returned by value instead of filled through an out-parameter.
 * Same copy-in rationale as PathQueryT above.
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

  // The nav-mesh path query behind the re-release's compass and its
  // NEAREST-flag target_poi ranking: this module's spelling of
  // `gi.GetPathToGoal`. Optional because it is re-release engine vocabulary
  // the frozen v3 GameImports cannot name, so the module calls it through a
  // local `undefined` check.
  //
  // ABSENT IS NOT THE SAME AS "NO PATH". A missing hook is what the
  // re-release calls `PathReturnCode::NoNavAvailable` -- distance_to_poi's
  // documented straight-line fallback -- while a present hook returning
  // `found: false` means the engine looked and found no walkable route.
  // g_kextarg.ts's distance_to_poi distinguishes the two.
  //
  // Already supplied at RUNTIME to this tree: src/server/bindings/legacy.ts's
  // BuildLegacyImports assembles ONE import object for all four legacy trees
  // and has carried `get_path_to_goal: PF_GetPathToGoal` since the classic
  // module gained the hook. Naming it here is what lets this tree's code
  // actually call it. It puts nothing on the wire, so unlike a POI/help_path
  // import it does not depend on the session having widened onto the
  // re-release configstring layout -- only on the server having nav data
  // loaded for this map (src/server/nav.ts's `sv_nav_legacy`).
  get_path_to_goal?(query: PathQueryT): PathResultT;

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

  RunFrame(): void;

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
