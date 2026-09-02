// g_utils.c -- misc utility functions for game module

import {
  AngleVectors,
  type Vec3,
  vec3,
  vec3_origin,
  VectorClear,
  VectorCompare,
  VectorCopy,
  VectorLength,
} from "../shared/math";
import {
  ATTN_NORM,
  AREA_SOLID,
  AREA_TRIGGERS,
  CHAN_AUTO,
  Com_sprintf,
  M_PI,
  MASK_PLAYERSOLID,
  MAX_EDICTS,
  PITCH,
  Q_stricmp,
  ROLL,
  YAW,
} from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import { T_Damage } from "./g_combat";
import { type Edict, type GTraceT, SolidT, SVF_MONSTER } from "./game";
import {
  BODY_QUEUE_SIZE,
  DAMAGE_NO_PROTECTION,
  type EdictT,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  MOD_TELEFRAG,
} from "./g_local";

export function G_ProjectSource(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  result[0] = point[0] + forward[0] * distance[0] + right[0] * distance[1];
  result[1] = point[1] + forward[1] * distance[0] + right[1] * distance[1];
  result[2] = point[2] + forward[2] * distance[0] + right[2] * distance[1] + distance[2];
}

// `field_ofs`/FOFS() is dropped per PORTING.md's Game-track conventions:
// `field` is the literal property name, typed as the string-valued keys of
// EdictT.
export type EdictStringKey = {
  [K in keyof EdictT]: EdictT[K] extends string | null ? K : never;
}[keyof EdictT];

/*
=============
G_Find

Searches all active entities for the next one that holds
the matching string at fieldofs (use the FOFS() macro) in the structure.

Searches beginning at the edict after from, or the beginning if NULL
NULL will be returned if the end of the list is reached.

=============
*/
export function G_Find(from: EdictT | null, field: EdictStringKey, match: string): EdictT | null {
  // C: `if (!from) from = g_edicts; else from++;` -- pointer arithmetic on
  // array position, independent of the edict's own content. `from.s.number`
  // is NOT used here (deliberately): G_FreeEdict's memset-equivalent
  // `clear()` zeroes `s.number` exactly like the C memset does, so an edict
  // passed back into G_Find right after being freed (G_UseTargets's
  // killtarget loop does this) would resume the scan from the wrong spot if
  // keyed off `s.number`. Array-identity lookup mirrors the C pointer's
  // true position regardless of what `clear()` did to the struct's fields.
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
    const s = candidate[field];
    if (s === null) continue;
    if (Q_stricmp(s, match) === 0) return candidate;
  }

  return null;
}

/*
=================
findradius

Returns entities that have origins within a spherical area

findradius (origin, radius)
=================
*/
export function findradius(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
  // see G_Find's comment: array-identity position, not `from.s.number`.
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;
  const eorg = vec3();

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
    if (candidate.solid === SolidT.SOLID_NOT) continue;
    for (let j = 0; j < 3; j++) {
      eorg[j] = org[j] - (candidate.s.origin[j] + (candidate.mins[j] + candidate.maxs[j]) * 0.5);
    }
    if (VectorLength(eorg) > rad) continue;
    return candidate;
  }

  return null;
}

/*
=============
G_PickTarget

Searches all active entities for the next one that holds
the matching string at fieldofs (use the FOFS() macro) in the structure.

Searches beginning at the edict after from, or the beginning if NULL
NULL will be returned if the end of the list is reached.

=============
*/
const MAXCHOICES = 8;

// C declares `char *targetname` with no non-null guarantee -- every call
// site in the original game passes an EdictT.target/.combattarget/.pathtarget
// field, which is `string | null`, and the function's own `if (!targetname)`
// guard proves NULL is an expected input. The stub's `string`-only parameter
// is widened to `string | null` to match; deviation from the pending stub,
// not from the C source.
export function G_PickTarget(targetname: string | null): EdictT | null {
  if (targetname === null) {
    gi.dprintf("G_PickTarget called with NULL targetname\n");
    return null;
  }

  let ent: EdictT | null = null;
  const choice: EdictT[] = [];

  for (;;) {
    ent = G_Find(ent, "targetname", targetname);
    if (ent === null) break;
    choice.push(ent);
    if (choice.length === MAXCHOICES) break;
  }

  if (choice.length === 0) {
    gi.dprintf(`G_PickTarget: target ${targetname} not found\n`);
    return null;
  }

  // C: choice[rand() % num_choices]. rand()/random() map to Math.random()
  // per PORTING.md ("determinism across runs is not a goal"); this is the
  // direct analog of the C modulo pick.
  return choice[Math.floor(Math.random() * choice.length)] ?? null;
}

export function Think_Delay(ent: EdictT): void {
  G_UseTargets(ent, ent.activator);
  G_FreeEdict(ent);
}

/*
==============================
G_UseTargets

the global "activator" should be set to the entity that initiated the firing.

If self.delay is set, a DelayedUse entity will be created that will actually
do the SUB_UseTargets after that many seconds have passed.

Centerprints any self.message to the activator.

Search for (string)targetname in all entities that
match (string)self.target and call their .use function

==============================
*/
export function G_UseTargets(ent: EdictT, activator: EdictT | null): void {

  //
  // check for a delay
  //
  if (ent.delay) {
    // create a temp object to fire at a later time
    const t = G_Spawn();
    t.classname = "DelayedUse";
    t.nextthink = level.time + ent.delay;
    t.think = Think_Delay;
    t.activator = activator;
    if (activator === null) {
      gi.dprintf("Think_Delay with no activator\n");
    }
    t.message = ent.message;
    t.target = ent.target;
    t.killtarget = ent.killtarget;
    return;
  }

  //
  // print the message
  //
  // C dereferences `activator->svflags` unconditionally here; every real
  // call site that sets ent.message also supplies a live activator (the
  // comment above documents that contract), so a NULL activator hitting
  // this branch is unreached in practice. TS cannot express an unchecked
  // deref through a nullable type, so an explicit `activator !== null`
  // guard replaces the C crash-on-null with a silent skip -- the one
  // pathological input this port treats differently from the original.
  if (ent.message !== null && activator !== null && (activator.svflags & SVF_MONSTER) === 0) {
    gi.centerprintf(activator, ent.message);
    if (ent.noise_index) {
      gi.sound(activator, CHAN_AUTO, ent.noise_index, 1, ATTN_NORM, 0);
    } else {
      gi.sound(activator, CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
    }
  }

  //
  // kill killtargets
  //
  if (ent.killtarget !== null) {
    const killtarget = ent.killtarget;
    let t: EdictT | null = null;
    while ((t = G_Find(t, "targetname", killtarget)) !== null) {
      G_FreeEdict(t);
      if (!ent.inuse) {
        gi.dprintf("entity was removed while using killtargets\n");
        return;
      }
    }
  }

  //
  // fire targets
  //
  if (ent.target !== null) {
    const target = ent.target;
    let t: EdictT | null = null;
    while ((t = G_Find(t, "targetname", target)) !== null) {
      // doors fire area portals in a specific way
      if (
        t.classname !== null &&
        ent.classname !== null &&
        Q_stricmp(t.classname, "func_areaportal") === 0 &&
        (Q_stricmp(ent.classname, "func_door") === 0 || Q_stricmp(ent.classname, "func_door_rotating") === 0)
      ) {
        continue;
      }

      if (t === ent) {
        gi.dprintf("WARNING: Entity used itself.\n");
      } else {
        if (t.use) t.use(t, ent, activator);
      }
      if (!ent.inuse) {
        gi.dprintf("entity was removed while using targets\n");
        return;
      }
    }
  }
}

/*
=============
TempVector

This is just a convenience function
for making temporary vectors for function calls
=============
*/
// static locals become module-scope state -- see PORTING.md ("Never return
// fresh arrays on hot paths"); this mirrors the C rotating buffer exactly.
const tvVecs: Vec3[] = fixedLength("tv vecs", 8, [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()]);
let tvIndex = 0;

export function tv(x: number, y: number, z: number): Vec3 {
  // use an array so that multiple tempvectors won't collide
  // for a while
  const v = tvVecs[tvIndex];
  tvIndex = (tvIndex + 1) & 7;

  v[0] = x;
  v[1] = y;
  v[2] = z;

  return v;
}

/*
=============
VectorToString

This is just a convenience function
for printing vectors
=============
*/
// C rotates through 8 static char buffers so overlapping vtos() calls in one
// printf don't alias; JS strings are immutable values with no buffer to
// alias, so the rotation has nothing left to protect against and is dropped.
export function vtos(v: Vec3): string {
  return Com_sprintf("(%i %i %i)", v[0], v[1], v[2]);
}

const VEC_UP: Vec3 = vec3(0, -1, 0);
const MOVEDIR_UP: Vec3 = vec3(0, 0, 1);
const VEC_DOWN: Vec3 = vec3(0, -2, 0);
const MOVEDIR_DOWN: Vec3 = vec3(0, 0, -1);

export function G_SetMovedir(angles: Vec3, movedir: Vec3): void {
  if (VectorCompare(angles, VEC_UP) !== 0) {
    VectorCopy(MOVEDIR_UP, movedir);
  } else if (VectorCompare(angles, VEC_DOWN) !== 0) {
    VectorCopy(MOVEDIR_DOWN, movedir);
  } else {
    AngleVectors(angles, movedir, null, null);
  }

  VectorClear(angles);
}

export function vectoyaw(vec: Vec3): number {
  let yaw: number;

  if (/*vec[YAW] == 0 &&*/ vec[PITCH] === 0) {
    yaw = 0;
    if (vec[YAW] > 0) yaw = 90;
    else if (vec[YAW] < 0) yaw = -90;
  } else {
    yaw = Math.trunc((Math.atan2(vec[YAW], vec[PITCH]) * 180) / M_PI);
    if (yaw < 0) yaw += 360;
  }

  return yaw;
}

export function vectoangles(vec: Vec3, angles: Vec3): void {
  let yaw: number;
  let pitch: number;

  if (vec[1] === 0 && vec[0] === 0) {
    yaw = 0;
    pitch = vec[2] > 0 ? 90 : 270;
  } else {
    if (vec[0]) {
      yaw = Math.trunc((Math.atan2(vec[1], vec[0]) * 180) / M_PI);
    } else if (vec[1] > 0) {
      yaw = 90;
    } else {
      yaw = -90;
    }
    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
    pitch = Math.trunc((Math.atan2(vec[2], forward) * 180) / M_PI);
    if (pitch < 0) pitch += 360;
  }

  angles[PITCH] = -pitch;
  angles[YAW] = yaw;
  angles[ROLL] = 0;
}

// gi.TagMalloc(strlen(in)+1, TAG_LEVEL) + strcpy is the allocate-and-copy
// idiom for C's owned char*; per PORTING.md ("Z_Malloc/... -> plain
// allocation") and the TagMalloc-family drop, this collapses to a plain
// string assignment since JS strings are immutable values, not buffers that
// need an independent copy.
export function G_CopyString(inStr: string): string {
  return inStr;
}

export function G_InitEdict(e: EdictT): void {
  e.inuse = true;
  e.classname = "noclass";
  e.gravity = 1.0;
  // `e - g_edicts` (pointer offset) has no direct TS equivalent; g_edicts is
  // a plain array (see game.ts's GameExports.edicts comment), so the offset
  // is recovered by identity lookup instead of address arithmetic.
  e.s.number = g_edicts.indexOf(e);

  // RERELEASE CONTENT PORT (rogue/g_utils.c's ROGUE_GRAVITY block, which
  // is unconditionally compiled in the shipped binary): set the gravity
  // direction BEFORE the spawn function runs, so a spawn function can
  // override it. The ported rerelease content that flips gravity
  // (target_gravity, the reverse-gravity areas the rerelease campaigns
  // use) depends on every edict starting with a real downward vector
  // rather than the all-zero one the field declaration leaves.
  e.gravityVector[0] = 0.0;
  e.gravityVector[1] = 0.0;
  e.gravityVector[2] = -1.0;
}

/*
=================
G_Spawn

Either finds a free edict, or allocates a new one.
Try to avoid reusing an entity that was recently freed, because it
can cause the client to think the entity morphed into something else
instead of being removed and recreated, which can cause interpolated
angles and bad trails.
=================
*/
export function G_Spawn(): EdictT {
  const maxclients = gameCvars.maxclients === null ? 0 : gameCvars.maxclients.value;

  let i = maxclients + 1;
  for (; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
    // the first couple seconds of server time can involve a lot of
    // freeing and allocating, so relax the replacement policy
    if (e !== undefined && !e.inuse && (e.freetime < 2 || level.time - e.freetime > 0.5)) {
      G_InitEdict(e);
      return e;
    }
  }

  if (i === game.maxentities) {
    gi.error("ED_Alloc: no free edicts");
  }

  globals.num_edicts++;
  const e = g_edicts[i];
  if (e === undefined) {
    // g_edicts is preallocated to game.maxentities entries by the (not yet
    // ported) InitGame path; a missing slot here means that precondition
    // was not met, which the original C can't fail in this way (the array
    // is a raw memory block sized up front).
    throw new Error(`G_Spawn: g_edicts has no preallocated slot at index ${i}`);
  }
  G_InitEdict(e);
  return e;
}

/*
=================
G_FreeEdict

Marks the edict as free
=================
*/
export function G_FreeEdict(ed: EdictT): void {
  gi.unlinkentity(ed); // unlink from world

  const maxclients = gameCvars.maxclients === null ? 0 : gameCvars.maxclients.value;
  const index = g_edicts.indexOf(ed);
  if (index <= maxclients + BODY_QUEUE_SIZE) {
    //		gi.dprintf("tried to free special edict\n");
    return;
  }

  ed.clear(); // memset (ed, 0, sizeof(*ed))
  ed.classname = "freed";
  ed.freetime = level.time;
  ed.inuse = false;
}

/*
============
G_TouchTriggers

============
*/
export function G_TouchTriggers(ent: EdictT): void {
  // dead things don't activate triggers!
  if ((ent.client !== null || (ent.svflags & SVF_MONSTER) !== 0) && ent.health <= 0) return;

  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(ent.absmin, ent.absmax, touch, MAX_EDICTS, AREA_TRIGGERS);

  // be careful, it is possible to have an entity in this
  // list removed before we get to it (killtriggered)
  for (let i = 0; i < num; i++) {
    // recover the full EdictT the same way trace_t.ent is recovered
    // elsewhere: g_edicts[number], never a cast (see PORTING.md).
    const hit = g_edicts[touch[i].s.number];
    if (hit === undefined || !hit.inuse) continue;
    if (!hit.touch) continue;
    hit.touch(hit, ent, null, null);
  }
}

/*
============
G_TouchSolids

Call after linking a new trigger in during gameplay
to force all entities it covers to immediately touch it
============
*/
export function G_TouchSolids(ent: EdictT): void {
  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(ent.absmin, ent.absmax, touch, MAX_EDICTS, AREA_SOLID);

  // be careful, it is possible to have an entity in this
  // list removed before we get to it (killtriggered)
  for (let i = 0; i < num; i++) {
    const hit = g_edicts[touch[i].s.number];
    if (hit === undefined || !hit.inuse) continue;
    // NOTE: the original calls ent->touch (not hit->touch) here -- preserved
    // bug-for-bug per PORTING.md ("Faithful port, bug-for-bug").
    if (ent.touch) ent.touch(hit, ent, null, null);
    if (!ent.inuse) break;
  }
}

/*
==============================================================================

RERELEASE CONTENT PORT -- G_FixStuckObject_Generic

p_move.cpp:9-154, transcribed from this port's own rerelease copy in
src/kexgame/p_move.ts (which carries the full C citation and the
preserved-quirk notes). Vanilla 3.21 has no equivalent: pmove never needed
one, because vanilla never places anything at an arbitrary computed point.
The landmark transition does exactly that -- p_client.ts's TryLandmarkSpawn
computes an origin from the destination landmark and the stored relative
offset, and the two maps' geometry does not have to agree to the unit -- so
the rerelease runs this to nudge the bbox out of whatever it clipped into,
and gives up on the landmark entirely when it cannot.

Nothing on a 1997 map reaches this function: TryLandmarkSpawn is its only
caller and it returns before this on a null landmark_name.

PRESERVED QUIRK, carried over from src/kexgame/p_move.ts's own note (1):
the C sorts `good_positions` over the range [begin, end - 1), so the LAST
candidate found never takes part in the sort and index 0 can therefore be a
non-minimal distance. Reproduced exactly rather than "fixed".

==============================================================================
*/

export enum StuckResultT {
  GOOD_POSITION = 0,
  FIXED = 1,
  NO_GOOD_POSITION = 2,
}

/** The trace shape G_FixStuckObject_Generic probes with. */
export type StuckObjectTraceFn = (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => GTraceT;

interface SideCheck {
  readonly normal: readonly [number, number, number];
  readonly mins: readonly [number, number, number];
  readonly maxs: readonly [number, number, number];
}

/** p_move.cpp:21-31 `side_checks[]`. */
const SIDE_CHECKS: readonly SideCheck[] = [
  { normal: [0, 0, 1], mins: [-1, -1, 0], maxs: [1, 1, 0] },
  { normal: [0, 0, -1], mins: [-1, -1, 0], maxs: [1, 1, 0] },
  { normal: [1, 0, 0], mins: [0, -1, -1], maxs: [0, 1, 1] },
  { normal: [-1, 0, 0], mins: [0, -1, -1], maxs: [0, 1, 1] },
  { normal: [0, 1, 0], mins: [-1, 0, -1], maxs: [1, 0, 1] },
  { normal: [0, -1, 0], mins: [-1, 0, -1], maxs: [1, 0, 1] },
];

/**
 * p_move.cpp:9-154. `origin` is mutated in place, matching the C++
 * `vec3_t &origin` reference parameter.
 */
export function G_FixStuckObject_Generic(origin: Vec3, own_mins: Vec3, own_maxs: Vec3, trace: StuckObjectTraceFn): StuckResultT {
  if (!trace(origin, own_mins, own_maxs, origin).startsolid) return StuckResultT.GOOD_POSITION;

  const good_positions: { distance: number; origin: Vec3 }[] = [];

  for (let sn = 0; sn < SIDE_CHECKS.length; sn++) {
    const side = SIDE_CHECKS[sn]!;
    let start = vec3(origin[0], origin[1], origin[2]);
    const mins = vec3();
    const maxs = vec3();

    for (let n = 0; n < 3; n++) {
      if (side.normal[n]! < 0) start[n] += own_mins[n]!;
      else if (side.normal[n]! > 0) start[n] += own_maxs[n]!;

      if (side.mins[n] === -1) mins[n] = own_mins[n]!;
      else if (side.mins[n] === 1) mins[n] = own_maxs[n]!;

      if (side.maxs[n] === -1) maxs[n] = own_mins[n]!;
      else if (side.maxs[n] === 1) maxs[n] = own_maxs[n]!;
    }

    let tr = trace(start, mins, maxs, start);

    let needed_epsilon_fix = -1;
    let needed_epsilon_dir = 0;

    if (tr.startsolid) {
      for (let e = 0; e < 3; e++) {
        if (side.normal[e] !== 0) continue;

        const ep_start = vec3(start[0], start[1], start[2]);
        ep_start[e] += 1;

        tr = trace(ep_start, mins, maxs, ep_start);

        if (!tr.startsolid) {
          start = ep_start;
          needed_epsilon_fix = e;
          needed_epsilon_dir = 1;
          break;
        }

        ep_start[e] -= 2;
        tr = trace(ep_start, mins, maxs, ep_start);

        if (!tr.startsolid) {
          start = ep_start;
          needed_epsilon_fix = e;
          needed_epsilon_dir = -1;
          break;
        }
      }
    }

    // no good
    if (tr.startsolid) continue;

    const opposite_start = vec3(origin[0], origin[1], origin[2]);
    const other_side = SIDE_CHECKS[sn ^ 1]!;

    for (let n = 0; n < 3; n++) {
      if (other_side.normal[n]! < 0) opposite_start[n] += own_mins[n]!;
      else if (other_side.normal[n]! > 0) opposite_start[n] += own_maxs[n]!;
    }

    if (needed_epsilon_fix >= 0) opposite_start[needed_epsilon_fix] += needed_epsilon_dir;

    // potentially a good side; start from our center, push back to the
    // opposite side to find how much clearance we have
    tr = trace(start, mins, maxs, opposite_start);

    // ???
    if (tr.startsolid) continue;

    // check the delta
    const end = vec3(tr.endpos[0], tr.endpos[1], tr.endpos[2]);
    // push us very slightly away from the wall
    end[0] += side.normal[0] * 0.125;
    end[1] += side.normal[1] * 0.125;
    end[2] += side.normal[2] * 0.125;

    // calculate delta
    const delta = vec3(end[0] - opposite_start[0], end[1] - opposite_start[1], end[2] - opposite_start[2]);
    const new_origin = vec3(origin[0] + delta[0], origin[1] + delta[1], origin[2] + delta[2]);

    if (needed_epsilon_fix >= 0) new_origin[needed_epsilon_fix] += needed_epsilon_dir;

    tr = trace(new_origin, own_mins, own_maxs, new_origin);

    // bad
    if (tr.startsolid) continue;

    good_positions.push({ origin: new_origin, distance: delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2] });
  }

  if (good_positions.length > 0) {
    // PRESERVED QUIRK (see this section's header): only indices
    // [0, n-2] take part in the sort; index n-1 stays where it was pushed.
    const n = good_positions.length;
    if (n > 1) {
      const sortable = good_positions.slice(0, n - 1);
      sortable.sort((a, b) => a.distance - b.distance);
      for (let i = 0; i < sortable.length; i++) good_positions[i] = sortable[i]!;
    }

    VectorCopy(good_positions[0]!.origin, origin);
    return StuckResultT.FIXED;
  }

  return StuckResultT.NO_GOOD_POSITION;
}

/*
==============================================================================

Kill box

==============================================================================
*/

/*
=================
KillBox

Kills all entities that would touch the proposed new positioning
of ent.  Ent should be unlinked before calling this!
=================
*/
export function KillBox(ent: EdictT): boolean {
  for (;;) {
    const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, null, MASK_PLAYERSOLID);
    if (tr.ent === null) break;

    const target = g_edicts[tr.ent.s.number];

    // nail it
    T_Damage(target, ent, ent, vec3_origin, ent.s.origin, vec3_origin, 100000, 0, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);

    // if we didn't kill it, fail
    if (target.solid !== SolidT.SOLID_NOT) return false;
  }

  return true; // all clear
}

/*
=================
vectoangles2

RERELEASE CONTENT PORT (rogue/g_utils.c). A second vector-to-angles
conversion the ported rerelease content uses. It differs from vanilla's
vectoangles above in the degenerate straight-up/straight-down case and in
negating pitch at the end, which is what the spheres, the tracker and
g_newdm's spawn-point logic expect. Kept as a separate function rather than
folded into vectoangles, exactly as the C has it -- vanilla callers must
keep vanilla behavior.
=================
*/
export function vectoangles2(vec: Vec3, angles: Vec3): void {
  let yaw: number;
  let pitch: number;

  if (vec[1] === 0 && vec[0] === 0) {
    yaw = 0;
    pitch = vec[2] > 0 ? 90 : 270;
  } else {
    if (vec[0]) {
      yaw = (Math.atan2(vec[1], vec[0]) * 180) / M_PI;
    } else if (vec[1] > 0) {
      yaw = 90;
    } else {
      yaw = 270;
    }
    if (yaw < 0) yaw += 360;

    const forward = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1]);
    pitch = (Math.atan2(vec[2], forward) * 180) / M_PI;
    if (pitch < 0) pitch += 360;
  }

  angles[PITCH] = -pitch;
  angles[YAW] = yaw;
  angles[ROLL] = 0;
}
