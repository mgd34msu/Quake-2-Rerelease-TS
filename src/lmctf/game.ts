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
