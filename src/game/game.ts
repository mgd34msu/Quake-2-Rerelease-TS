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
