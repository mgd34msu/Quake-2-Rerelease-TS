// Ports lmctf60/game.h -- game dll information visible to server.
//
// Diff-derived from src/ctf/game.ts (lmctf60/game.h vs quake-2/ctf/game.h):
// the only substantive difference is that ZOID's `SVF_PROJECTILE` (network
// optimization for the hyperblaster's projectile encoding) is REMOVED in
// lmctf60 (diff confirmed: the whole `//ZOID ... //ZOID` block is deleted).
// Everything else in the diff is copyright-header removal, a typo fix
// ("Persistant" -> "Persistent"), a comment, and the DLL entry point's
// capitalization (`GetGameApi` -> `GetGameAPI`, which every other family in
// this repo already normalizes to `GetGameAPI` regardless of the C source's
// capitalization).
//
// PORTING.md trace_t.ent ruling applies identically to this file as it does
// to src/ctf/game.ts/src/game/game.ts; see those files' header comments.

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
// NOTE: ctf/game.h's `SVF_PROJECTILE 0x00000008` is REMOVED in lmctf60
// (diff confirmed). Not carried over.

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

export interface GTraceT extends Omit<TraceT, "ent"> {
  ent: Edict | null;
}

//===============================================================

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

  // Never returns (see PORTING.md idiom map: ComError is thrown and caught
  // in Qcommon_Frame).
  error(fmt: string): never;

  modelindex(name: string): number;
  soundindex(name: string): number;
  imageindex(name: string): number;

  setmodel(ent: Edict, name: string): void;

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

  linkentity(ent: Edict): void;
  unlinkentity(ent: Edict): void; // call before removing an interactive edict
  BoxEdicts(mins: Vec3, maxs: Vec3, list: Edict[], maxcount: number, areatype: number): number;
  Pmove(pmove: PmoveT): void; // player movement code common with client prediction

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

  // TagMalloc/TagFree/FreeTags OMITTED per PORTING.md.

  cvar(var_name: string, value: string | null, flags: number): CvarT | null;
  cvar_set(var_name: string, value: string): CvarT | null;
  cvar_forceset(var_name: string, value: string): CvarT | null;

  argc(): number;
  argv(n: number): string;
  args(): string; // concatenation of all argv >= 1

  AddCommandString(text: string): void;

  DebugGraph(value: number, color: number): void;
}

export interface GameExports {
  apiversion: number;

  Init(): void;
  Shutdown(): void;

  SpawnEntities(mapname: string, entstring: string, spawnpoint: string): void;

  WriteGame(filename: string, autosave: boolean): void;
  ReadGame(filename: string): void;

  WriteLevel(filename: string): void;
  ReadLevel(filename: string): void;

  ClientConnect(ent: Edict, userinfo: string): { allowed: boolean; userinfo: string };
  ClientBegin(ent: Edict): void;
  ClientUserinfoChanged(ent: Edict, userinfo: string): void;
  ClientDisconnect(ent: Edict): void;
  ClientCommand(ent: Edict): void;
  ClientThink(ent: Edict, cmd: UsercmdT): void;

  RunFrame(): void;

  ServerCommand(): void;

  edicts: Edict[];
  num_edicts: number; // current number, <= max_edicts
  max_edicts: number;
}
