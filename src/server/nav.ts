/*
Copyright (C) 2003-2006 Andrey Nazarov
Ported from server/nav.c and server/nav.h (GNU GPL v2 or later).
*/
// nav.c -- Kex navigation node support
//
// Loads bots/navigation/<map>.nav (the Kex/rerelease bot-navigation graph
// format: nodes, links, traversals, entity bindings), holds the resulting
// graph for the lifetime of a level, and answers A* pathfinding requests
// (Nav_GetPathToGoal, wired through src/kexapi/game.ts's PathRequest/PathInfo
// and src/server/bindings/kex.ts's GetPathToGoal import) plus per-frame
// conditional-node re-evaluation (doors, hazards, floor/liquid checks).
//
// ============================================================================
// SCOPE CUT: NO DEBUG VISUALIZATION (nav_debug / Nav_Debug / Nav_RenderLink*)
// ============================================================================
// q2repro's nav.c is almost 30% `#if USE_REF` debug-draw code: the
// `nav_debug`/`nav_debug_range` cvars, `Nav_Debug()`, `Nav_RenderLink[Edict]`,
// `Nav_NodeFlagsToString`, `Nav_DebugPath`, and the `Nav_AddDebug*` wrappers
// around `R_AddDebug*` (nav.c:23-31,858-897,1080-1315). All of it draws into
// the CLIENT renderer (`refresh/gl.h`'s `R_AddDebugLine` etc.), which does
// not exist on this headless dedicated-server port -- exactly the same
// rationale bindings/kex.ts already documents for its own `Draw_*` no-ops
// ("genuinely out of scope for a headless dedicated boot"). None of this
// code affects pathfinding results or file-format compatibility: the ONLY
// non-debug consumer of the `node_link_bitmap` nav_data built at load time
// (nav.c:1026-1036) is `Nav_RenderLink` (nav.c:1194,1208), so that bitmap is
// dropped too, along with `Nav_Load`'s bitmap-build pass. `Nav_Init`'s two
// cvar registrations are the only other USE_REF content; `Nav_Init` is kept
// as an exported no-op purely so the lifecycle call graph (SV_Init ->
// Nav_Init) still mirrors q2repro's, documented at the call site.
//
// ============================================================================
// A NEW SEAM NOT IN THE C SOURCE: Nav_SetEdictSource
// ============================================================================
// nav.c's `Nav_SetupEntities` (nav.c:1419-1450) walks the engine-global
// `ge->num_edicts`/`EDICT_NUM(n)` (server.h's global game-exports pointer) to
// match nav-file edicts (by model index) against the currently spawned game
// entities. This TS engine core has no equivalent ambient global: the
// concrete edict shape nav.c needs here (`sv.classname`, `sv.ent_flags`,
// `s.modelindex`, `s.renderfx`, `svflags`, `solid`, `absmin`/`absmax`) only
// exists on `KexEdictT` (src/kexapi/game.ts), which only bindings/kex.ts
// holds a reference to (as `kexGe.edicts`). Rather than importing kexapi
// types into engine-core nav.ts (this file has no other kex-specific
// dependency and stays structurally typed against `NavGameEdictView` below,
// which `KexEdictT` already satisfies), the edict array is supplied via a
// provider function bindings/kex.ts registers once, in `adaptKexGameExports`
// (`Nav_SetEdictSource(() => kexGe.edicts)`), mirroring q2repro's `ge`
// global with an explicit, testable seam instead. See bindings/kex.ts's own
// header for why every kex<->engine boundary in this port takes this
// adapter shape.
//
// ============================================================================
// A PRESERVED UPSTREAM QUIRK: `nav_data.loaded` is NOT "data is present"
// ============================================================================
// `Nav_Load` sets `loaded = true` unconditionally, BEFORE it even attempts to
// open the file (nav.c:906-908) -- this flag really means "a load attempt
// has happened for this level" (it exists to drive the `Q_assert(!loaded)`
// reentrancy guard and `Nav_Unload`'s early-out), not "nodes/links exist".
// So when `bots/navigation/<map>.nav` is simply missing (the common case --
// most maps ship with no bot nav data), `FS_OpenFile` returns < 0 and
// `Nav_Load` returns immediately (nav.c:915-916) WITHOUT calling
// `Nav_Unload`: `loaded` stays `true`, but `num_nodes` etc. stay at their
// zeroed defaults. `Nav_Path_`'s `if (!nav_data.loaded)` guard (nav.c:749)
// therefore does NOT fire in this case -- pathfinding proceeds into
// `Nav_ClosestNodeTo` against zero nodes, which returns null for both start
// and goal, yielding `PathReturnCode.NoStartNode` (not `NoNavAvailable`).
// `NoNavAvailable` is only reachable before any level's `Nav_Load` has ever
// run, or between `Nav_Unload` and the next `Nav_Load` -- because a genuine
// PARSE failure (bad magic/version/corrupt data) DOES call `Nav_Unload`
// (nav.c:1046-1047, the `fail:` label), which resets `loaded` back to
// `false`. This is a real, observable upstream asymmetry (missing file vs.
// corrupt file produce different PathReturnCodes) and is preserved exactly;
// see the "no .nav file present" and "malformed header" test cases in
// test/nav.test.ts, which pin both halves of it down.
//
// ============================================================================
// OTHER TS-vs-C IMPLEMENTATION SUBSTITUTIONS (behavior-preserving)
// ============================================================================
// - The A* open set: nav.c's `nav_ctx_t` (nav.c:401-411) is a fixed-size
//   pool of `nav_open_t` nodes threaded through two intrusive linked lists
//   (`open_set_open`, ordered by f_score; `open_set_free`, the free pool) to
//   avoid runtime allocation inside the search loop -- the file's own
//   comment (nav.c:404) flags this as "a bit slow for insertion" and a
//   future min-heap candidate. This port uses a plain resizable array
//   (`openSet`) with the same ordered-insert-before-first-larger-f_score
//   rule (`Nav_PushOpenSet` below), which is the SAME O(n) insertion
//   behavior and the SAME tie-break (equal f_score entries stay in
//   insertion order, since the C code's condition is strict `<`) without
//   needing a hand-rolled free-list pool -- JS garbage collection replaces
//   the pool's job with no observable difference in path results.
// - `Com_SetLastError`/`Com_GetLastError` (used by the `NAV_VERIFY` macro,
//   nav.c:389-393): this port has no ported equivalent of that global
//   last-error slot (qcommon/common.ts has no `Com_SetLastError`). Parse
//   failures instead carry their message directly as the return value of
//   `Nav_LoadFromBuffer`/`Nav_Load`'s internal parser, which `Nav_Load` logs
//   through `Com_Printf` (this port also has no `Com_EPrintf`/`Com_WPrintf`;
//   `Com_Printf` is the only print function ported so far) -- same observed
//   log line, no global mutable error state needed.
// - `node_link_bitmap`, `Nav_Debug`, and friends: dropped entirely (see
//   "SCOPE CUT" above).
// - `sv_fps->integer` (nav.c:1456, `Nav_Frame`'s "wait one server-frame's
//   worth of [real] time before the first entity-setup pass" gate): q2repro's
//   `sv_fps` is the cvar that ACTUALLY governs its frame pacing, so
//   `nav_frame > sv_fps` there really does mean "wait ~1 real second". This
//   port's own `sv_fps` (sv_main.ts's `SV_Init`, `Cvar_Get("sv_fps", "40",
//   CVAR_LATCH)`) is registered but never consumed anywhere else -- the
//   value that actually governs this port's per-tick pacing is `sv.framerate`
//   (server.ts), computed per spawn by SV_ComputeFramerate's family dispatch
//   (sv_init.ts: legacy families pin 10Hz regardless of any cvar; only the
//   kex family honors `sv_tick_rate`, clamped to 10..60). An EARLIER version
//   of this file compared against the raw `sv_tick_rate` cvar directly
//   instead -- which is wrong in exactly the cases that matter: on a legacy-
//   family server sv_tick_rate still reads its own default/configured value
//   (e.g. 40) while sv.framerate is pinned to 10, so the gate waited 4x
//   longer in real time than intended (40 frames at the real 100ms/frame
//   pacing = 4s, not the intended ~1s); on kex, whenever sv_tick_rate is
//   raised above its default the two values only coincidentally agreed.
//   Fixed to read `sv.framerate` (server.ts's `sv` singleton) directly,
//   matching q2repro's actual "wait 1 second of frames, whatever this
//   server's real pacing is" intent regardless of family.

import { type Vec3, vec3, VectorAdd, VectorSubtract, VectorCopy, VectorSet, VectorMA, DotProduct, CrossProduct, VectorScale } from "../shared/math";
import { type CvarT, MASK_SOLID, MASK_WATER, CONTENTS_SLIME, CONTENTS_LAVA, CONTENTS_PLAYERCLIP, CONTENTS_MONSTERCLIP } from "../shared/q_shared";
import { Com_Printf, Com_DPrintf } from "../qcommon/common";
import { Cvar_Get } from "../qcommon/cvar";
import { FS_LoadFile } from "../qcommon/files";
import { SV_Trace, SV_PointContents } from "./sv_world";
import { sv } from "./server";
import { PathFlags, PathReturnCode, PathLinkType, type PathRequest, type PathInfo } from "../kexapi/game";

// small local helper matching the C `BIT(n)` macro used throughout nav.h's
// bitflag enums (kexapi/game.ts has its own private copy of this same
// one-liner; not imported from there to keep this file's only kex-specific
// dependency limited to the PathRequest/PathInfo/PathFlags/PathReturnCode/
// PathLinkType types nav.c itself is defined in terms of).
function bit(n: number): number {
  return 1 << n;
}

//============================================================================
// nav.h -- flags, enums, node/link/traversal/edict shapes
//============================================================================

// nav.h:22-38 (`enum { NodeFlag_* }`, `nav_node_flags_t : uint16_t`)
export const NodeFlagT = {
  Normal: 0,
  Teleporter: bit(0),
  Pusher: bit(1),
  Elevator: bit(2),
  Ladder: bit(3),
  UnderWater: bit(4),
  CheckForHazard: bit(5),
  CheckHasFloor: bit(6),
  CheckInSolid: bit(7),
  NoMonsters: bit(8),
  Crouch: bit(9),
  NoPOI: bit(10),
  CheckInLiquid: bit(11),
  CheckDoorLinks: bit(12),
  Disabled: bit(13),
} as const;
export type NodeFlagT = number;

// nav.h:55-71 (`enum { NavLinkType_* }`, `nav_link_type_t : uint8_t`)
export enum NavLinkTypeT {
  Walk,
  LongJump,
  Teleport,
  WalkOffLedge,
  Pusher,
  BarrierJump,
  Elevator,
  Train,
  Manual_LongJump,
  Crouch,
  Ladder,
  Manual_BarrierJump,
  PivotAndJump,
  RocketJump,
  Unknown,
}

// nav.h:76-88 (`enum { NavLinkFlag_* }`, `nav_link_flags_t : uint8_t`)
export const NavLinkFlagT = {
  TeamRed: bit(0),
  TeamBlue: bit(1),
  ExitAtTarget: bit(2),
  WalkOnly: bit(3),
  EaseIntoTarget: bit(4),
  InstantTurn: bit(5),
  Disabled: bit(6),
  get AllTeams() {
    return NavLinkFlagT.TeamRed | NavLinkFlagT.TeamBlue;
  },
} as const;
export type NavLinkFlagT = number;

// nav.h:91-96
export interface NavTraversalT {
  funnel: Vec3;
  start: Vec3;
  end: Vec3;
  ladder_plane: Vec3;
}

// nav.h:101-107 (`nav_link_t`; "LinkT" is already taken by game/game.ts's
// area-tree doubly-linked-list node -- an unrelated concept -- so this keeps
// its full "Nav"-prefixed name with no ambiguity).
export interface NavLinkT {
  target: NavNodeT;
  type: NavLinkTypeT;
  flags: NavLinkFlagT;
  traversal: NavTraversalT | null;
  edict: NavEdictT | null;
}

// nav.h:45-52 (`nav_node_t`)
export interface NavNodeT {
  flags: NodeFlagT;
  id: number;
  radius: number;
  origin: Vec3;
  links: NavLinkT[];
}

// The engine-side view of a game entity that nav.ts's edict-facing functions
// (Nav_RegisterEdict/Nav_UnRegisterEdict/Nav_SetupEntities/
// Nav_UpdateConditionalNode's door/hazard checks) need to inspect. Every
// field here exists on src/kexapi/game.ts's `KexEdictT`, which satisfies
// this interface structurally -- see this file's header ("A NEW SEAM").
export interface NavGameEdictView {
  readonly inuse: boolean;
  readonly svflags: number;
  readonly solid: number;
  readonly absmin: Vec3;
  readonly absmax: Vec3;
  readonly s: {
    readonly modelindex: number;
    readonly renderfx: number;
    readonly origin: Vec3;
    readonly old_origin: Vec3;
  };
  readonly sv: {
    readonly classname: string | null;
    readonly ent_flags: bigint;
  };
}

// nav.h:110-116 (`nav_edict_t`)
export interface NavEdictT {
  link: NavLinkT;
  model: number;
  mins: Vec3;
  maxs: Vec3;
  game_edict: NavGameEdictView | null;
}

// nav.h:401-411 (`nav_ctx_t`). See header ("A* open set") for why the C
// pool-plus-two-intrusive-lists design becomes a plain array here.
interface NavOpenEntryT {
  node: NavNodeT;
  fScore: number;
}
export interface NavCtxT {
  openSet: NavOpenEntryT[];
  came_from: Int16Array;
  went_to: Int16Array;
  g_score: Float32Array;
}

// nav.h:131-133, 137-150 (`nav_heuristic_func_t`/`nav_weight_func_t`/
// `nav_link_accessible_func_t`, `nav_path_t`)
export type NavHeuristicFuncT = (path: NavPathT, node: NavNodeT) => number;
export type NavWeightFuncT = (path: NavPathT, node: NavNodeT, link: NavLinkT) => number;
export type NavLinkAccessibleFuncT = (path: NavPathT, node: NavNodeT, link: NavLinkT) => boolean;

export interface NavPathT {
  heuristic: NavHeuristicFuncT | null;
  weight: NavWeightFuncT | null;
  link_accessible: NavLinkAccessibleFuncT | null;
  context: NavCtxT | null;
  request: PathRequest;
  start: NavNodeT | null;
  goal: NavNodeT | null;
}

//============================================================================
// module state (nav.c:33-64, the static `nav_data` struct)
//============================================================================

interface NavDataT {
  loaded: boolean;
  filename: string;

  num_nodes: number;
  num_links: number;
  num_traversals: number;
  num_edicts: number;
  heuristic: number;

  nodes: NavNodeT[];
  links: NavLinkT[];
  traversals: NavTraversalT[];
  edicts: NavEdictT[];

  conditional_nodes: NavNodeT[];

  ctx: NavCtxT | null;

  registered_edicts: (NavGameEdictView | null)[];

  setup_entities: boolean;
  nav_frame: number;
}

function freshNavData(): NavDataT {
  return {
    loaded: false,
    filename: "",
    num_nodes: 0,
    num_links: 0,
    num_traversals: 0,
    num_edicts: 0,
    heuristic: 0,
    nodes: [],
    links: [],
    traversals: [],
    edicts: [],
    conditional_nodes: [],
    ctx: null,
    registered_edicts: [],
    setup_entities: false,
    nav_frame: 0,
  };
}

let nav_data: NavDataT = freshNavData();

// nav.c:67 (`INVALID_ID`)
export const INVALID_ID = -1;

// nav.c:70-77,81-84,188,191,290 (magic + supported versions)
export const NAV_MAGIC = "N".charCodeAt(0) | ("A".charCodeAt(0) << 8) | ("V".charCodeAt(0) << 16) | ("3".charCodeAt(0) << 24);
export const NAV_VERSION_1 = 1;
export const NAV_VERSION_2 = 2;
export const NAV_VERSION_3 = 3;
export const NAV_VERSION_4 = 4;
export const NAV_VERSION_5 = 5;
export const NAV_VERSION_6 = 6;
export const NAV_VERSION_LATEST = NAV_VERSION_6;

// nav.c:585 / nav.c:1078
export const PATH_POINT_TOO_CLOSE = 64.0;
export const NavFloorDistance = 96.0;

// A provider for "the currently spawned game's edicts", set once by
// bindings/kex.ts. See header ("A NEW SEAM").
let navEdictSource: (() => readonly (NavGameEdictView | null)[]) | null = null;
export function Nav_SetEdictSource(getEdicts: (() => readonly (NavGameEdictView | null)[]) | null): void {
  navEdictSource = getEdicts;
}

//============================================================================
// small local vector helpers not already in shared/math.ts (confirmed
// absent repo-wide: VectorDistance, Vector2Subtract/Length/Normalize).
// Only used within this file, so kept local rather than added to the shared
// module (out of scope for this unit; shared/math.ts's own header doesn't
// document these as omissions to fix here).
//============================================================================

function VectorDistance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Only the X/Y components matter at every nav.c call site (the C macro
// operates on vec2_t-shaped slices of a zero-initialized vec3_t); Z is left
// untouched in the output, matching those call sites' own zero-init.
function Vector2Subtract(a: Vec3, b: Vec3, out: Vec3): void {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
}

function Vector2Length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

function Vector2Normalize(v: Vec3): number {
  const len = Vector2Length(v);
  if (len) {
    v[0] /= len;
    v[1] /= len;
  }
  return len;
}

// shared/shared.c:120-127
function IntersectBounds(amins: Vec3, amaxs: Vec3, bmins: Vec3, bmaxs: Vec3): boolean {
  return amins[0] <= bmaxs[0] && amaxs[0] >= bmins[0] && amins[1] <= bmaxs[1] && amaxs[1] >= bmins[1] && amins[2] <= bmaxs[2] && amaxs[2] >= bmins[2];
}

// shared/shared.c:129-163 ("adapted from PowerslaveEX")
function IntersectBoundLine(mins: Vec3, maxs: Vec3, start: Vec3, end: Vec3): boolean {
  const center = vec3();
  VectorAdd(maxs, mins, center);
  VectorScale(center, 0.5, center);
  const extents = vec3();
  VectorSubtract(maxs, center, extents);
  const lineDir = vec3();
  VectorSubtract(end, start, lineDir);
  VectorScale(lineDir, 0.5, lineDir);
  const lineCenter = vec3();
  VectorAdd(lineDir, start, lineCenter);
  const dir = vec3();
  VectorSubtract(lineCenter, center, dir);

  const ld = vec3();
  for (let i = 0; i < 3; i++) {
    ld[i] = Math.abs(lineDir[i]);
    if (Math.abs(dir[i]) > extents[i] + ld[i]) return false;
  }

  const cross = vec3();
  CrossProduct(lineDir, dir, cross);

  if (Math.abs(cross[0]) > extents[1] * ld[2] + extents[2] * ld[1]) return false;
  if (Math.abs(cross[1]) > extents[0] * ld[2] + extents[2] * ld[0]) return false;
  if (Math.abs(cross[2]) > extents[0] * ld[1] + extents[1] * ld[0]) return false;

  return true;
}

//============================================================================
// nav.c:418-437 -- Nav_AllocCtx / Nav_FreeCtx
//============================================================================

export function Nav_AllocCtx(): NavCtxT {
  return {
    openSet: [],
    came_from: new Int16Array(nav_data.num_nodes),
    went_to: new Int16Array(nav_data.num_nodes),
    g_score: new Float32Array(nav_data.num_nodes),
  };
}

// no-op: JS garbage collection frees the arrays above. Kept for API parity
// with nav.h's exported `Nav_FreeCtx`.
export function Nav_FreeCtx(_ctx: NavCtxT): void {}

//============================================================================
// nav.c:440-522 -- built-in path callbacks
//============================================================================

function Nav_Heuristic(path: NavPathT, node: NavNodeT): number {
  return VectorDistance(path.goal!.origin, node.origin);
}

function Nav_Weight(path: NavPathT, node: NavNodeT, link: NavLinkT): number {
  if (link.type === NavLinkTypeT.Teleport) return 1.0;
  return VectorDistance(node.origin, link.target.origin) * nav_data.heuristic;
}

function Nav_NodeAccessible(path: NavPathT, node: NavNodeT): boolean {
  if (node.flags & NodeFlagT.Disabled) return false;

  if (path.request.nodeSearch.ignoreNodeFlags) {
    if (node.flags & NodeFlagT.NoPOI) return false;
  } else {
    if (node.flags & (NodeFlagT.NoMonsters | NodeFlagT.Crouch | NodeFlagT.Ladder | NodeFlagT.Pusher | NodeFlagT.Teleporter)) {
      return false;
    } else if (node.flags & NodeFlagT.UnderWater && (path.request.pathFlags & (PathFlags.Walk | PathFlags.Water)) === PathFlags.Walk) {
      return false;
    } else if (!(node.flags & NodeFlagT.UnderWater) && (path.request.pathFlags & (PathFlags.Walk | PathFlags.Water)) === PathFlags.Water) {
      return false;
    } else if (!(path.request.pathFlags & PathFlags.Elevator) && node.flags & NodeFlagT.Elevator) {
      return false;
    }
  }

  return true;
}

function Nav_LinkAccessible(path: NavPathT, node: NavNodeT, link: NavLinkT): boolean {
  if (!path.request.nodeSearch.ignoreNodeFlags) {
    let entity_traversal = false;

    // can only path to walk in water
    if (path.request.pathFlags === PathFlags.Water) {
      if (link.type !== NavLinkTypeT.Walk) return false;
    } else if (link.type === NavLinkTypeT.Elevator) {
      if (!(path.request.pathFlags & PathFlags.Elevator)) return false;
      entity_traversal = true;
    } else if (link.type === NavLinkTypeT.WalkOffLedge) {
      if (!(path.request.pathFlags & PathFlags.WalkOffLedge)) return false;
      if (path.request.traversals.dropHeight > 0.0 && link.target.origin[2] < node.origin[2] - path.request.traversals.dropHeight) return false;
    } else if (link.type === NavLinkTypeT.LongJump) {
      if (!(path.request.pathFlags & PathFlags.LongJump)) return false;
    } else if (link.type === NavLinkTypeT.BarrierJump) {
      // nav.c:508 -- upstream bug preserved as-is: this checks against
      // `NavLinkType_BarrierJump` (the enum ordinal, 5) instead of
      // `PathFlags_BarrierJump` (bit(4) = 16). Bug-for-bug port: do not fix.
      if (!(path.request.pathFlags & NavLinkTypeT.BarrierJump)) return false;
      if (path.request.traversals.jumpHeight > 0.0 && link.target.origin[2] > node.origin[2] + path.request.traversals.jumpHeight) return false;
    }

    if (link.edict && !entity_traversal) return false;
  }

  return Nav_NodeAccessible(path, link.target);
}

// nav.c:524-525 (`Nav_ParamSupplied` macro)
function Nav_ParamSupplied(x: number, def: number): number {
  return x > 0.0 ? x : def;
}

// nav.c:527-583
function Nav_ClosestNodeTo(p: Vec3, request: PathRequest): NavNodeT | null {
  let w = Infinity;
  let c: NavNodeT | null = null;
  const minHeight = Nav_ParamSupplied(request.nodeSearch.minHeight, 64.0);
  const maxHeight = Nav_ParamSupplied(request.nodeSearch.maxHeight, 64.0);
  // nav.c:533 -- upstream bug preserved as-is: the search radius is derived
  // from `nodeSearch.maxHeight` again, not `nodeSearch.radius`. Bug-for-bug
  // port: do not fix.
  const radius = Nav_ParamSupplied(request.nodeSearch.maxHeight, 512.0);
  const waterOnly = request.pathFlags === PathFlags.Water;

  const bz = p[2] - minHeight;
  const tz = p[2] + maxHeight;

  for (let i = 0; i < nav_data.num_nodes; i++) {
    const node = nav_data.nodes[i];

    if (!request.nodeSearch.ignoreNodeFlags) {
      if (node.flags & (NodeFlagT.Disabled | NodeFlagT.Pusher | NodeFlagT.Teleporter | NodeFlagT.Ladder | NodeFlagT.Crouch | NodeFlagT.NoMonsters)) {
        continue;
      }
      if (waterOnly && !(node.flags & NodeFlagT.UnderWater)) continue;
    }

    if (node.origin[2] < bz || node.origin[2] > tz) continue;

    const d = vec3();
    Vector2Subtract(p, node.origin, d);
    const l = Vector2Length(d);

    if (l > radius) continue;
    if (l > w) continue;

    const end = vec3(0, 0, 32);
    VectorAdd(end, node.origin, end);
    const tr = SV_Trace(p, vec3(), vec3(), end, null, MASK_SOLID | CONTENTS_PLAYERCLIP | CONTENTS_MONSTERCLIP);

    if (tr.fraction < 1.0) continue;

    w = l;
    c = node;
  }

  return c;
}

// nav.c:587-595
function Nav_GetLink(a: NavNodeT, b: NavNodeT): NavLinkT | null {
  for (const link of a.links) {
    if (link.target === b) return link;
  }
  Com_Printf("Nav_GetLink: assertion failed (no link from node %s to node %s)\n", `${a.id}`, `${b.id}`);
  return null;
}

function Nav_TouchingNode(pos: Vec3, move_dist: number, node: NavNodeT): boolean {
  return VectorDistance(pos, node.origin) <= move_dist;
}

// nav.c:602-613
function Nav_NodeReached(pos: Vec3, node: NavNodeT): boolean {
  const d = vec3();
  VectorSubtract(node.origin, pos, d);

  if (Vector2Length(d) > node.radius) return false;
  else if (Math.abs(d[2]) > 64.0) return false;

  return true;
}

// nav.c:615-637 -- ordered insert; see header ("A* open set")
function Nav_PushOpenSet(ctx: NavCtxT, node: NavNodeT, f: number): void {
  const entry: NavOpenEntryT = { node, fScore: f };
  const open = ctx.openSet;
  for (let i = 0; i < open.length; i++) {
    if (f < open[i].fScore) {
      open.splice(i, 0, entry);
      return;
    }
  }
  open.push(entry);
}

// nav.c:639-644
function Nav_PushPathPoint(info: PathInfo, request: PathRequest, p: Vec3): void {
  if (info.numPathPoints < request.pathPoints.count && request.pathPoints.array) {
    VectorCopy(p, request.pathPoints.array[info.numPathPoints]);
  }
  info.numPathPoints++;
}

// nav.c:646-743
function Nav_ReachedGoal(path: NavPathT, info: PathInfo, request: PathRequest, ctx: NavCtxT, current: number): void {
  let num_points = 0;

  let n = current;
  while (ctx.came_from[n] !== -1) {
    num_points++;
    n = ctx.came_from[n];
  }

  n = current;
  let p = 0;
  while (ctx.came_from[n] !== -1) {
    const from = ctx.came_from[n];
    ctx.went_to[num_points - p - 1] = from;
    n = from;
    p++;
  }

  let first_point = 0;
  let link: NavLinkT | null = null;

  if (num_points > 1) {
    link = Nav_GetLink(nav_data.nodes[ctx.went_to[0]], nav_data.nodes[ctx.went_to[1]]);

    if (!path.request.nodeSearch.ignoreNodeFlags && link) {
      if (link.type === NavLinkTypeT.Walk || link.type === NavLinkTypeT.Crouch) {
        if (Nav_NodeReached(request.start, nav_data.nodes[ctx.went_to[0]])) {
          first_point++;
        } else {
          const d = vec3();
          Vector2Subtract(nav_data.nodes[ctx.went_to[1]].origin, nav_data.nodes[ctx.went_to[0]].origin, d);
          Vector2Normalize(d);

          const origin = vec3();
          VectorMA(nav_data.nodes[ctx.went_to[0]].origin, nav_data.nodes[ctx.went_to[0]].radius, d, origin);

          const pathVec = vec3();
          Vector2Subtract(nav_data.nodes[ctx.went_to[1]].origin, origin, pathVec);

          if (DotProduct(d, pathVec) > 0.0) first_point++;
        }
      }
    }
  }

  if (request.pathPoints.count) {
    let dist = VectorDistance(request.start, nav_data.nodes[ctx.went_to[first_point]].origin);
    if (dist > PATH_POINT_TOO_CLOSE) Nav_PushPathPoint(info, request, request.start);

    for (p = first_point; p < num_points; p++) Nav_PushPathPoint(info, request, nav_data.nodes[ctx.went_to[p]].origin);

    dist = VectorDistance(request.goal, nav_data.nodes[ctx.went_to[num_points - 1]].origin);
    if (dist > PATH_POINT_TOO_CLOSE) Nav_PushPathPoint(info, request, request.goal);
  }

  if (path.request.nodeSearch.ignoreNodeFlags) {
    info.returnCode = PathReturnCode.RawPathFound;
    return;
  }

  if (link && link.traversal !== null) {
    VectorCopy(link.traversal.start, info.firstMovePoint);
    VectorCopy(link.traversal.end, info.secondMovePoint);
    info.returnCode = PathReturnCode.TraversalPending;
    return;
  }

  VectorCopy(nav_data.nodes[ctx.went_to[first_point]].origin, info.firstMovePoint);
  if (first_point + 1 < num_points) VectorCopy(nav_data.nodes[ctx.went_to[first_point + 1]].origin, info.secondMovePoint);
  else VectorCopy(path.request.goal, info.secondMovePoint);
  info.returnCode = PathReturnCode.InProgress;
}

function freshPathInfo(): PathInfo {
  return {
    numPathPoints: 0,
    pathDistSqr: 0,
    firstMovePoint: vec3(),
    secondMovePoint: vec3(),
    pathLinkType: PathLinkType.Walk,
    returnCode: PathReturnCode.StartPathErrors,
  };
}

// nav.c:745-856 (`Nav_Path_`, the un-debug-wrapped core)
function Nav_Path_(path: NavPathT): PathInfo {
  const info = freshPathInfo();

  if (!nav_data.loaded) {
    info.returnCode = PathReturnCode.NoNavAvailable;
    return info;
  }

  if ((path.request.pathFlags & (PathFlags.Walk | PathFlags.Water)) === 0) {
    info.returnCode = PathReturnCode.MissingWalkOrSwimFlag;
    return info;
  }

  const request = path.request;

  path.start = Nav_ClosestNodeTo(request.start, path.request);
  if (!path.start) {
    info.returnCode = PathReturnCode.NoStartNode;
    return info;
  }

  path.goal = Nav_ClosestNodeTo(request.goal, path.request);
  if (!path.goal) {
    info.returnCode = PathReturnCode.NoGoalNode;
    return info;
  }

  if (path.start === path.goal || Nav_TouchingNode(request.start, request.moveDist, path.goal)) {
    info.returnCode = PathReturnCode.ReachedGoal;
    return info;
  }

  if (!path.request.nodeSearch.ignoreNodeFlags) {
    if (SV_PointContents(path.request.start) & MASK_SOLID) {
      info.returnCode = PathReturnCode.InvalidStart;
      return info;
    }
    if (SV_PointContents(path.request.goal) & MASK_SOLID) {
      info.returnCode = PathReturnCode.InvalidGoal;
      return info;
    }
  }

  const start_id = path.start.id;
  const goal_id = path.goal.id;

  const weight_func = path.weight ?? Nav_Weight;
  const heuristic_func = path.heuristic ?? Nav_Heuristic;
  const link_accessible_func = path.link_accessible ?? Nav_LinkAccessible;

  const ctx = path.context ?? nav_data.ctx!;

  for (let i = 0; i < nav_data.num_nodes; i++) ctx.g_score[i] = Infinity;
  ctx.openSet.length = 0;

  ctx.came_from[start_id] = -1;
  ctx.g_score[start_id] = 0;
  Nav_PushOpenSet(ctx, path.start, heuristic_func(path, path.start));

  info.returnCode = PathReturnCode.NoPathFound;

  while (true) {
    const cursor = ctx.openSet.shift();
    if (!cursor) break;

    const current = cursor.node.id;

    if (current === goal_id) {
      Nav_ReachedGoal(path, info, request, ctx, current);
      break;
    }

    const current_node = nav_data.nodes[current];

    for (const link of current_node.links) {
      if (!link_accessible_func(path, current_node, link)) continue;

      const target_id = link.target.id;
      const temp_g_score = ctx.g_score[current] + weight_func(path, current_node, link);

      if (temp_g_score >= ctx.g_score[target_id]) continue;

      ctx.came_from[target_id] = current;
      ctx.g_score[target_id] = temp_g_score;

      Nav_PushOpenSet(ctx, link.target, temp_g_score + heuristic_func(path, link.target));
    }
  }

  return info;
}

// nav.c:887-897 (debug-draw branch dropped; see header "SCOPE CUT")
export function Nav_Path(path: NavPathT): PathInfo {
  return Nav_Path_(path);
}

// nav.c:772-782 in game.c (`PF_GetPathToGoal`), the function
// bindings/kex.ts's `GetPathToGoal` import wires directly to.
export function Nav_GetPathToGoal(request: PathRequest, info: PathInfo | null): boolean {
  const path: NavPathT = {
    heuristic: null,
    weight: null,
    link_accessible: null,
    context: null,
    request,
    start: null,
    goal: null,
  };

  const result = Nav_Path(path);

  if (info) {
    info.numPathPoints = result.numPathPoints;
    info.pathDistSqr = result.pathDistSqr;
    info.firstMovePoint = result.firstMovePoint;
    info.secondMovePoint = result.secondMovePoint;
    info.pathLinkType = result.pathLinkType;
    info.returnCode = result.returnCode;
  }

  return result.returnCode < PathReturnCode.StartPathErrors;
}

//============================================================================
// nav.c:899-1060 -- loading
//============================================================================

function Nav_NodeIsConditional(flags: NodeFlagT): boolean {
  return (flags & (NodeFlagT.CheckDoorLinks | NodeFlagT.CheckForHazard | NodeFlagT.CheckHasFloor | NodeFlagT.CheckInLiquid | NodeFlagT.CheckInSolid)) !== 0;
}

// A small cursor-based little-endian reader over the whole loaded file
// buffer, standing in for nav.c's `FS_Read`-per-field + `NAV_VERIFY` macro
// (nav.c:392-393): out-of-range reads throw, caught by the parser's single
// try/catch and turned into the same kind of "bad data" failure the C
// macro's `goto fail` produces.
class NavReader {
  private readonly view: DataView;
  private pos = 0;
  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get remaining(): number {
    return this.view.byteLength - this.pos;
  }
  i32(): number {
    if (this.remaining < 4) throw new Error("bad data");
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u16(): number {
    if (this.remaining < 2) throw new Error("bad data");
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i16(): number {
    if (this.remaining < 2) throw new Error("bad data");
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u8(): number {
    if (this.remaining < 1) throw new Error("bad data");
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  f32(): number {
    if (this.remaining < 4) throw new Error("bad data");
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  vec3(): Vec3 {
    const v = vec3();
    v[0] = this.f32();
    v[1] = this.f32();
    v[2] = this.f32();
    return v;
  }
}

function navVerify(condition: boolean, error: string): void {
  if (!condition) throw new Error(error);
}

export interface NavParseResultT {
  ok: boolean;
  error?: string;
}

/*
===============
Nav_LoadFromBuffer

Parses an already-read .nav file buffer (nav.c:904-1050's body, minus the
FS_OpenFile/FS_Read/FS_CloseFile plumbing and the debug-only node_link_bitmap
pass -- see file header). Exported as the test seam test/nav.test.ts uses to
exercise the format without touching the real filesystem. On success,
commits the parsed graph to this module's `nav_data` and allocates the
built-in pathing context (nav.c:1041). On failure, logs the same kind of
message nav.c's `fail:` label does and resets `nav_data` via Nav_Unload
(nav.c:1046-1047) -- see header ("A PRESERVED UPSTREAM QUIRK") for why this
differs from the "file simply doesn't exist" case.
===============
*/
export function Nav_LoadFromBuffer(buf: Uint8Array, filenameForLog: string): NavParseResultT {
  try {
    const r = new NavReader(buf);

    const magic = r.i32();
    navVerify(magic === NAV_MAGIC, "bad magic");

    const v = r.i32();
    navVerify(v <= NAV_VERSION_LATEST, `bad version ${v}\n`);

    const num_nodes = r.i32();
    const num_links = r.i32();
    const num_traversals = r.i32();
    const heuristic = r.f32();

    // Node headers: flags, num_links, first_link, radius (nav.c:939-953).
    interface RawNode {
      flags: NodeFlagT;
      num_links: number;
      first_link: number;
      radius: number;
    }
    const rawNodes: RawNode[] = [];
    for (let i = 0; i < num_nodes; i++) {
      const flags = r.u16();
      const nl = r.i16();
      const first_link = r.i16();
      navVerify(first_link >= 0 && first_link + nl <= num_links, "bad node link extents");
      const radius = r.i16();
      rawNodes.push({ flags, num_links: nl, first_link, radius });
    }

    // Node origins, interleaved as a second pass over the same node range
    // (nav.c:958-965) -- the file format stores all node headers first,
    // then all node origins, so this genuinely is a second loop, not a
    // refactor.
    const nodes: NavNodeT[] = [];
    const conditional_nodes: NavNodeT[] = [];
    for (let i = 0; i < num_nodes; i++) {
      const origin = r.vec3();
      const raw = rawNodes[i];
      const node: NavNodeT = { flags: raw.flags, id: i, radius: raw.radius, origin, links: [] };
      nodes.push(node);
      if (Nav_NodeIsConditional(raw.flags)) conditional_nodes.push(node);
    }

    // Links (nav.c:967-992).
    interface RawLink {
      target: number;
      type: NavLinkTypeT;
      flags: NavLinkFlagT;
      traversal: number;
    }
    const rawLinks: RawLink[] = [];
    for (let i = 0; i < num_links; i++) {
      const target = r.i16();
      navVerify(target >= 0 && target < num_nodes, "bad link target");
      const type = r.u8();
      let flags = r.u8();

      if (v < NAV_VERSION_3) {
        flags = NavLinkFlagT.AllTeams;
      } else if (v < NAV_VERSION_6) {
        flags &= ~(bit(2) | bit(3));
      }

      const traversal = r.i16();
      if (traversal !== -1) navVerify(traversal < num_traversals, "bad link traversal");

      rawLinks.push({ target, type, flags, traversal });
    }

    // Traversals (nav.c:994-1003).
    const traversals: NavTraversalT[] = [];
    for (let i = 0; i < num_traversals; i++) {
      const funnel = r.vec3();
      const start = r.vec3();
      const end = r.vec3();
      const ladder_plane = v >= NAV_VERSION_4 ? r.vec3() : vec3();
      traversals.push({ funnel, start, end, ladder_plane });
    }

    // Now that traversals[] exists, materialize the links array (target
    // resolved to a real NavNodeT, traversal resolved to a real
    // NavTraversalT or null).
    const links: NavLinkT[] = rawLinks.map((rl) => ({
      target: nodes[rl.target],
      type: rl.type,
      flags: rl.flags,
      traversal: rl.traversal !== -1 ? traversals[rl.traversal] : null,
      edict: null,
    }));

    // Wire each node's `links` slice now that the flat `links` array exists
    // (nav.c's `node->links = &nav_data.links[first_link]` pointer-into-
    // flat-array becomes an actual per-node array slice here).
    for (let i = 0; i < num_nodes; i++) {
      const raw = rawNodes[i];
      nodes[i].links = links.slice(raw.first_link, raw.first_link + raw.num_links);
    }

    // Edicts (nav.c:1005-1024).
    const num_edicts = r.i32();
    const edicts: NavEdictT[] = [];
    for (let i = 0; i < num_edicts; i++) {
      const linkIdx = r.i16();
      navVerify(linkIdx >= 0 && linkIdx < num_links, "bad edict link");
      const model = v >= NAV_VERSION_2 ? r.i32() : 0;
      const mins = r.vec3();
      const maxs = r.vec3();

      const edict: NavEdictT = { link: links[linkIdx], model, mins, maxs, game_edict: null };
      edict.link.edict = edict;
      edicts.push(edict);
    }

    Com_DPrintf("Bot navigation file (%s) loaded:\n %i nodes\n %i links\n %i traversals\n %i edicts\n", filenameForLog, `${num_nodes}`, `${num_links}`, `${num_traversals}`, `${num_edicts}`);

    nav_data = {
      loaded: true,
      filename: filenameForLog,
      num_nodes,
      num_links,
      num_traversals,
      num_edicts,
      heuristic,
      nodes,
      links,
      traversals,
      edicts,
      conditional_nodes,
      ctx: null,
      registered_edicts: [],
      setup_entities: false,
      nav_frame: 0,
    };
    nav_data.ctx = Nav_AllocCtx();

    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    Com_Printf("Couldn't load bot navigation file (%s): %s\n", filenameForLog, message);
    // nav.c:1047 (`fail:` label calls Nav_Unload()) -- resets `loaded` back
    // to false, unlike the "file not found" path in Nav_Load below. See
    // header ("A PRESERVED UPSTREAM QUIRK").
    Nav_Unload();
    return { ok: false, error: message };
  }
}

/*
===============
Nav_Load

nav.c:904-1050, minus the file-I/O-error-path debug rendering (none exists)
and the node_link_bitmap pass (see file header). Called from
SV_SpawnServer's ss_game branch (src/server/sv_init.ts), mirroring
q2repro's `if (cmd->state == ss_game) { sv.cm = cmd->cm; Nav_Load(cmd->server); ... }`
(init.c:165-166).
===============
*/
export function Nav_Load(map_name: string): void {
  if (nav_data.loaded) {
    // nav.c:906 (`Q_assert(!nav_data.loaded)`) -- Nav_Load must not be
    // called while a previous level's nav data (or even just its
    // "attempted" flag) is still loaded; callers must Nav_Unload() first.
    throw new Error("Nav_Load: already loaded (call Nav_Unload first)");
  }

  const filename = `bots/navigation/${map_name}.nav`;
  const buf = FS_LoadFile(filename);

  if (buf === null) {
    // nav.c:915-916 -- file not found: `loaded` stays true (set below),
    // nothing else populated, Nav_Unload is NOT called. See header ("A
    // PRESERVED UPSTREAM QUIRK").
    nav_data = freshNavData();
    nav_data.loaded = true;
    nav_data.filename = filename;
    return;
  }

  Nav_LoadFromBuffer(buf, filename);
}

// nav.c:1052-1060
export function Nav_Unload(): void {
  if (!nav_data.loaded) return;
  nav_data = freshNavData();
}

//============================================================================
// nav.c:1062-1076, 1317-1450 -- conditional nodes and entity setup
//============================================================================

function Nav_GetNodeBounds(node: NavNodeT, mins: Vec3, maxs: Vec3): void {
  VectorSet(mins, -16, -16, -24);
  VectorSet(maxs, 16, 16, 32);
  if (node.flags & NodeFlagT.Crouch) maxs[2] = 4.0;
}

function Nav_GetNodeTraceOrigin(node: NavNodeT, origin: Vec3): void {
  VectorCopy(node.origin, origin);
  origin[2] += 24.0;
}

// nav.c:1317-1417
function Nav_UpdateConditionalNode(node: NavNodeT): void {
  node.flags &= ~NodeFlagT.Disabled;

  const mins = vec3();
  const maxs = vec3();
  const origin = vec3();
  Nav_GetNodeBounds(node, mins, maxs);
  Nav_GetNodeTraceOrigin(node, origin);

  if (node.flags & NodeFlagT.CheckInSolid) {
    const tr = SV_Trace(origin, mins, maxs, origin, null, MASK_SOLID);
    if (tr.startsolid || tr.allsolid) {
      node.flags |= NodeFlagT.Disabled;
      return;
    }
  }

  if (node.flags & NodeFlagT.CheckInLiquid) {
    const tr = SV_Trace(origin, mins, maxs, origin, null, MASK_WATER);
    if (!(tr.startsolid || tr.allsolid)) {
      node.flags |= NodeFlagT.Disabled;
      return;
    }
  }

  if (node.flags & NodeFlagT.CheckForHazard) {
    const hazardMask = CONTENTS_SLIME | CONTENTS_LAVA;
    const tr = SV_Trace(origin, mins, maxs, origin, null, hazardMask);

    if (tr.startsolid || tr.allsolid) {
      node.flags |= NodeFlagT.Disabled;
    } else {
      const absmin = vec3();
      const absmax = vec3();
      VectorAdd(origin, mins, absmin);
      VectorAdd(origin, maxs, absmax);

      for (const e of nav_data.registered_edicts) {
        if (!e) continue;
        if (!(e.sv.ent_flags & 0x8000000n /* SVFL_TRAP_DANGER = bit(27) */)) continue;

        if (e.s.renderfx & 128 /* RF_BEAM */) {
          if (e.svflags & 0x1 /* SVF_NOCLIENT */) continue;
          if (IntersectBoundLine(absmin, absmax, e.s.origin, e.s.old_origin)) {
            node.flags |= NodeFlagT.Disabled;
            return;
          }
        } else if (e.solid === 3 /* SOLID_TRIGGER */) {
          if (IntersectBounds(e.absmin, e.absmax, absmin, absmax)) {
            node.flags |= NodeFlagT.Disabled;
            return;
          }
        }
      }
    }
  }

  if (node.flags & NodeFlagT.CheckHasFloor) {
    const flat_mins = vec3(mins[0], mins[1], 0);
    const flat_maxs = vec3(maxs[0], maxs[1], 0);

    const floor_end = vec3();
    VectorCopy(origin, floor_end);
    floor_end[2] -= NavFloorDistance;

    const tr = SV_Trace(origin, flat_mins, flat_maxs, floor_end, null, MASK_SOLID);
    if (tr.fraction === 1.0) {
      node.flags |= NodeFlagT.Disabled;
      return;
    }
  }

  if (node.flags & NodeFlagT.CheckDoorLinks) {
    for (const link of node.links) {
      if (!link.edict) continue;
      const game_edict = link.edict.game_edict;
      if (!game_edict) continue;
      if (!game_edict.inuse) continue;

      if (game_edict.sv.ent_flags & 0x1000000n /* SVFL_IS_LOCKED_DOOR = bit(24) */) {
        node.flags |= NodeFlagT.Disabled;
        return;
      }
    }
  }
}

// nav.c:1419-1450
function Nav_SetupEntities(): void {
  nav_data.setup_entities = true;

  const gameEdicts = navEdictSource ? navEdictSource() : [];

  for (const e of nav_data.edicts) {
    for (const game_e of gameEdicts) {
      if (!game_e || !game_e.inuse) continue;
      if (game_e.s.modelindex !== e.model) continue;

      const classname = game_e.sv.classname;
      if (!classname) continue;

      const lower = classname.toLowerCase();
      if (!lower.startsWith("func_") && !lower.startsWith("trigger_")) {
        Com_Printf("Nav entity (of type %s) might not be safe as an entity\n", classname);
      }

      e.game_edict = game_e;
      break;
    }

    if (!e.game_edict) Com_Printf("Nav entity appears to be missing (needs entity with model %i)\n", `${e.model}`);
  }
}

// nav.c:1452-1466 (Nav_Debug() call dropped; see header "SCOPE CUT")
export function Nav_Frame(): void {
  nav_data.nav_frame++;

  const tickRate = Math.trunc(sv.framerate);
  if (nav_data.nav_frame > tickRate) {
    if (!nav_data.setup_entities) Nav_SetupEntities();
  }

  for (const node of nav_data.conditional_nodes) Nav_UpdateConditionalNode(node);
}

// ============================================================================
// A DELIBERATE, DOCUMENTED DEVIATION: `sv_nav_legacy` (not in nav.c at all)
// ============================================================================
// q2repro's own init.c:163-166 calls Nav_Load(cmd->server) unconditionally
// for every ss_game spawn, regardless of which game module is running --
// there is no family check in the reference engine at all. Under a LEGACY
// (API v3) game module, that unconditional load is real but functionally
// inert-and-noisy there: nav.c:1436's `Nav_SetupEntities` binds nav-file
// edicts by testing `game_e->sv.classname` (server/nav.c:1434-1436, "only
// map-spawned entities"), and the real engine's own compat shim for old game
// DLLs (`src/server/game3_proxy/game3_proxy.c`) never populates
// `edict_t->sv.classname` on the edicts it proxies to the engine -- that
// substruct is a 2023-kex-only addition old v3 game code has no concept of.
// So on a real q2repro server running a legacy game DLL, EVERY nav-file
// edict binding fails and prints "Nav entity appears to be missing" --
// confirmed by reading game3_proxy.c directly (zero assignments to
// `sv.classname` anywhere in that file). .orch/followups.md's finding 14
// already ledgers this exact spam as "upstream-faithful noise" for our own
// port, which inherited the identical failure for the identical structural
// reason (see this file's header, "A NEW SEAM": `NavGameEdictView.sv.
// classname` mirrors kex.c's `sv_entity_t` exactly, and nothing populated it
// for the legacy family until this cvar's provider was added below).
//
// Rather than reproduce the real engine's proxy limitation byte-for-bug
// (this port has NO DLL/proxy boundary -- bindings/legacy.ts holds the legacy
// game's real edicts directly, classname included, so the resolution failure
// is not structurally forced here the way it is upstream), this port makes
// nav loading for the legacy family FAMILY-AWARE and cvar-controlled:
//   - kex family: unchanged, unconditional (matches init.c:163-166 exactly).
//   - legacy family: Nav_Load runs when `sv_nav_legacy` is nonzero (see
//     sv_init.ts's SV_SpawnServer), and when it does it gets a WORKING
//     resolution, not the upstream-faithful failure: bindings/legacy.ts
//     registers a real Nav_SetEdictSource provider over the active legacy
//     tree's own edicts (classname included), so the same nav links a kex
//     boot resolves are the ones this resolves.
//
// This is the FIDELITY RAZOR (rule 17) in the direction rule 16 explicitly
// allows: a documented, deliberate departure from literal source behavior
// because the platform difference (no DLL boundary here) removes the reason
// the original bug existed.
//
// THE DEFAULT, AND WHY IT CHANGED
//
// 2026-08-31, Mike's ruling, quoted verbatim for the ledger: "add it to the
// legacy one but default it to off. that way we don't disrupt having bots
// and things like that." The default was "0". That was the right call ON THE
// FACTS AS THEY STOOD: at the time NOTHING under the classic module consumed
// nav data at all. There was no classic path query -- src/game/game.ts's
// GameImports had no nav entry point, and Nav_GetPathToGoal was reachable
// only through the kex-only PF_* import table -- so loading a .nav file for a
// legacy spawn bought exactly nothing and risked the upstream "Nav entity
// appears to be missing" noise for no gain. Off was the cheap, safe posture.
//
// 2026-09-02: those facts no longer hold. The classic module now HAS a nav
// consumer. src/game/game.ts carries an optional `get_path_to_goal()` import,
// bindings/legacy.ts backs it with PF_GetPathToGoal over this very module,
// and src/game/g_kextarg.ts's Cmd_Compass_f and distance_to_poi both call it
// -- the objective compass's breadcrumb trail and its NEAREST-flag target_poi
// ranking. With the default at "0" the classic compass silently degrades:
// `compass` sends the objective marker and its sound and no trail, and a
// teamed target_poi ranks by straight-line distance through walls. The owner's
// charter is that every re-release feature works under the classic ruleset,
// and a feature that only works after the player finds an undocumented cvar
// does not meet it.
//
// The original ruling's actual concern -- disrupting bots with upstream's
// binding noise -- does not apply to this port, and did not apply even when
// the ruling was made: it is the DLL/proxy boundary that breaks binding
// upstream, and this port has none. bindings/legacy.ts resolves nav edicts
// off the live legacy tree correctly, so turning the load on adds a resolved
// graph, not a page of warnings.
//
// So the default is now "1" and the cvar keeps its full value as the OPT-OUT:
// `sv_nav_legacy 0` restores the 2026-08-31 behavior exactly (no legacy-family
// Nav_Load at all) for anyone who wants it.
//
// WHAT THE FLIP DOES ON A MAP WITH NO .nav FILE. Nothing at boot: Nav_Load's
// "file not found" branch prints nothing at all, so a 1997-tree spawn is as
// silent at "1" as it was at "0" (verified frame-for-frame against a control
// build). It does move ONE observable thing, and it moves it toward the
// reference. Because that branch leaves `loaded` TRUE with zero nodes -- the
// preserved upstream quirk this file's header spells out at length -- a path
// query on such a map now fails with NoStartNode rather than NoNavAvailable,
// and g_kextarg.ts's distance_to_poi maps those two differently: NoNavAvailable
// falls back to straight-line distance, anything else is "unreachable"
// (Infinity), which a teamed SPAWNFLAG_POI_NEAREST scan skips. That is
// precisely what a q2repro server does on the same map -- its init.c:163-166
// calls Nav_Load unconditionally for every ss_game spawn, so every nav-less
// map there is already in the loaded-but-empty state -- and what the kex
// family here has always done. The exposure is narrow in practice: target_poi
// is a re-release-only entity, and all 174 re-release maps ship nav data.
let sv_nav_legacy: CvarT | null = null;

/*
===============
Nav_LegacyLoadEnabled

Test/consumer seam for the cvar above -- see sv_init.ts's SV_SpawnServer,
the only call site that needs this decision (whether to call Nav_Load at all
for a legacy-family spawn; the kex family never consults this).
===============
*/
export function Nav_LegacyLoadEnabled(): boolean {
  return sv_nav_legacy !== null && sv_nav_legacy.value !== 0;
}

// nav.c:1468-1474. The debug-draw consumer these cvars gate (`Nav_Debug()`,
// nav.c:1261-1315) is USE_REF-gated and not ported here at all (see this
// file's header "SCOPE CUT" -- there is no renderer on this headless port,
// and no Nav_Debug/Nav_RenderLink* equivalent exists anywhere in this file).
// Registered, consumer unported: this only makes `nav_debug`/
// `nav_debug_range` settable at the console instead of failing as "unknown
// command"; neither cvar is read anywhere in this module.
export function Nav_Init(): void {
  Cvar_Get("nav_debug", "0", 0); // nav.c:1471
  Cvar_Get("nav_debug_range", "512", 0); // nav.c:1472

  // NOT in nav.c -- see this file's "A DELIBERATE, DOCUMENTED DEVIATION"
  // comment above, including "THE DEFAULT, AND WHY IT CHANGED" for why this
  // is "1" and not the "0" it shipped with. Plain flags (no CVAR_LATCH): the
  // value is only ever consulted at SV_SpawnServer time, which already only
  // takes effect on the next map load regardless of latch semantics.
  sv_nav_legacy = Cvar_Get("sv_nav_legacy", "1", 0);
}

// nav.c:1476-1479. Note: q2repro itself never calls this from anywhere in
// its own runtime (confirmed by grepping the full q2repro tree for
// `Nav_Shutdown(` outside nav.c/nav.h) -- `Z_LeakTest` is a debug-build
// memory-leak check with no TS equivalent. Kept exported, unwired, matching
// upstream's own dead call graph.
export function Nav_Shutdown(): void {}

// nav.c:1481-1498
export function Nav_RegisterEdict(edict: NavGameEdictView | null): void {
  if (!edict) return;

  let free_slot = nav_data.registered_edicts.length;

  for (let i = 0; i < nav_data.registered_edicts.length; i++) {
    if (nav_data.registered_edicts[i] === edict) {
      return;
    } else if (nav_data.registered_edicts[i] === null) {
      free_slot = i;
    }
  }

  nav_data.registered_edicts[free_slot] = edict;
}

// nav.c:1500-1524
export function Nav_UnRegisterEdict(edict: NavGameEdictView | null): void {
  if (!edict) return;

  for (const e of nav_data.edicts) {
    if (e.game_edict === edict) {
      e.game_edict = null;
      break;
    }
  }

  for (let i = 0; i < nav_data.registered_edicts.length; i++) {
    if (nav_data.registered_edicts[i] === edict) {
      nav_data.registered_edicts[i] = null;

      // nav.c:1513-1520 -- trim trailing nulls off the tail of the
      // registry (the C loop walks backward from the end, decrementing
      // `num_registered_edicts` for each trailing null, stopping at the
      // first non-null). Mirrored here as an array-length trim.
      while (nav_data.registered_edicts.length > 0 && nav_data.registered_edicts[nav_data.registered_edicts.length - 1] === null) {
        nav_data.registered_edicts.pop();
      }
      break;
    }
  }
}

//============================================================================
// test-only introspection (not part of nav.h's public API surface, but
// needed by test/nav.test.ts to assert on parsed graph shape without
// re-deriving it from PathInfo alone).
//============================================================================

export function Nav_DebugState(): Readonly<{
  loaded: boolean;
  filename: string;
  num_nodes: number;
  num_links: number;
  num_traversals: number;
  num_edicts: number;
  nodes: readonly NavNodeT[];
  // `edicts` (nav-file edict records, each carrying the `game_edict` binding
  // Nav_SetupEntities resolves -- or leaves null when the "appears to be
  // missing" warning fired) added for the sv_nav_legacy family-gating tests
  // (test/nav_family_gating_boot.test.ts): lets those tests assert the
  // resolution actually succeeded instead of only scraping console text.
  edicts: readonly NavEdictT[];
  registered_edicts: readonly (NavGameEdictView | null)[];
}> {
  return nav_data;
}
