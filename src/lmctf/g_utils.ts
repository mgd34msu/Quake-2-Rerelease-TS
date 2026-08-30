// Ports lmctf60/g_utils.c -- diff-derived from src/ctf/g_utils.ts
// (lmctf60/g_utils.c vs quake-2/ctf/g_utils.c: 237-line diff of 635 total).
//
// The diff is cosmetic (license header dropped, `0.5` -> `0.5f` float-literal
// suffixes, a dead LM_JORM debug-assert block left commented out in the C
// source -- not reproduced, same as every other dead comment block per
// PORTING.md) plus three real additions: `findallradius` (an LM_CTF-only
// variant of findradius that does not skip SOLID_NOT entities, marked
// "LM_JORM" in the source) and `Team_centerprint`/`Team_cprint` (CTF-team
// broadcast helpers appended at the end of the file, marked "CTF CODE --
// LM_JORM", using g_ctffunc.ts's ctf_validateplayer/ctf_SafePrint).
//
// G_FreeEdict/G_Spawn/G_InitEdict were already ported by the foundation unit
// (byte-identical to src/ctf/g_utils.ts); everything else below completes
// this file.

import type { Vec3 } from "../shared/math";
import { AngleVectors, vec3, vec3_origin, VectorClear, VectorCompare, VectorCopy, VectorLength } from "../shared/math";
import { fixedLength } from "../shared/fixed";
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
  PRINT_HIGH,
  Q_stricmp,
  ROLL,
  YAW,
} from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { type Edict, SolidT, SVF_MONSTER } from "./game";
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

// `field_ofs`/FOFS() is dropped per PORTING.md's Game-track conventions:
// `field` is the literal property name, typed as the string-valued keys of
// EdictT.
export type EdictStringKey = {
  [K in keyof EdictT]: EdictT[K] extends string | null ? K : never;
}[keyof EdictT];

/*
=============
G_Find (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's G_Find.
=============
*/
export function G_Find(from: EdictT | null, field: EdictStringKey, match: string): EdictT | null {
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
findradius (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
findradius aside from the dead `0.5` -> `0.5f` literal-suffix change.
=================
*/
export function findradius(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
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
=================
findallradius (lmctf60/g_utils.c, marked "LM_JORM" -- LM_CTF addition, no
ctf/baseq2 ancestor)

Returns ALL entities (even non-solid) that have origins within a spherical
area -- identical to findradius except it does NOT skip SOLID_NOT entities.
=================
*/
export function findallradius(from: EdictT | null, org: Vec3, rad: number): EdictT | null {
  const start = from === null ? 0 : g_edicts.indexOf(from) + 1;
  const eorg = vec3();

  for (let i = start; i < globals.num_edicts; i++) {
    const candidate = g_edicts[i];
    if (candidate === undefined || !candidate.inuse) continue;
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
G_PickTarget (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
G_PickTarget.
=============
*/
const MAXCHOICES = 8;

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

  return choice[Math.floor(Math.random() * choice.length)] ?? null;
}

export function Think_Delay(ent: EdictT): void {
  G_UseTargets(ent, ent.activator);
  G_FreeEdict(ent);
}

/*
==============================
G_UseTargets (lmctf60/g_utils.c) -- byte-identical logic to
src/ctf/g_utils.ts's G_UseTargets (the only source diff is a dropped
commented-out dprintf and `!= NULL` made explicit on two while-conditions,
no behavior change).

the global "activator" should be set to the entity that initiated the firing.

If self.delay is set, a DelayedUse entity will be created that will actually
do the SUB_UseTargets after that many seconds have passed.

Centerprints any self.message to the activator.

Search for (string)targetname in all entities that
match (string)self.target and call their .use function
==============================
*/
export function G_UseTargets(ent: EdictT, activator: EdictT | null): void {
  if (ent.delay) {
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

  // C dereferences `activator->svflags` unconditionally here; every real
  // call site that sets ent.message also supplies a live activator, so a
  // NULL activator hitting this branch is unreached in practice. TS cannot
  // express an unchecked deref through a nullable type, so an explicit
  // `activator !== null` guard replaces the C crash-on-null with a silent
  // skip, matching src/ctf/g_utils.ts's G_UseTargets.
  if (ent.message !== null && activator !== null && (activator.svflags & SVF_MONSTER) === 0) {
    gi.centerprintf(activator, ent.message);
    if (ent.noise_index) {
      gi.sound(activator, CHAN_AUTO, ent.noise_index, 1, ATTN_NORM, 0);
    } else {
      gi.sound(activator, CHAN_AUTO, gi.soundindex("misc/talk1.wav"), 1, ATTN_NORM, 0);
    }
  }

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

  if (ent.target !== null) {
    const target = ent.target;
    let t: EdictT | null = null;
    while ((t = G_Find(t, "targetname", target)) !== null) {
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
TempVector (lmctf60/g_utils.c) -- byte-identical rotating-buffer scheme to
src/ctf/g_utils.ts's tv, aside from the dead `static int index;` ->
`static int index = 1;` initializer change (both start the C static at 0
after zero-init; lmctf60 spells the same value explicitly -- no behavior
change since JS module state has no equivalent "static without initializer"
distinction).
=============
*/
const tvVecs: Vec3[] = fixedLength("tvVecs", 8, [vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3(), vec3()]);
let tvIndex = 0;

export function tv(x: number, y: number, z: number): Vec3 {
  const v = tvVecs[tvIndex];
  tvIndex = (tvIndex + 1) & 7;

  v[0] = x;
  v[1] = y;
  v[2] = z;

  return v;
}

/*
=============
VectorToString (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
vtos (the 8-buffer rotation the C source uses to avoid aliasing has no JS
equivalent need, same rationale as the ctf port).
=============
*/
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

  if (vec[PITCH] === 0) {
    yaw = 0;
    if (vec[YAW] > 0) yaw = 90;
    else if (vec[YAW] < 0) yaw = -90;
  } else {
    yaw = Math.trunc((Math.atan2(vec[YAW], vec[PITCH]) * 180) / M_PI);
    if (yaw < 0) yaw += 360;
  }

  return yaw;
}

/*
=================
vectoangles (lmctf60/g_utils.c) -- byte-identical baseq2 math to
src/ctf/g_utils.ts's vectoangles. Needed by p_weapon.ts's fire_hook to
orient the hook bolt's model along its firing direction.
=================
*/
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

/*
=================
G_ProjectSource (lmctf60/g_utils.c) -- byte-identical baseq2 math to
src/ctf/g_utils.ts's G_ProjectSource. Needed by p_weapon.ts's
P_ProjectSource (used by Weapon_Hook_Fire to compute the hook's muzzle
point).
=================
*/
export function G_ProjectSource(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  result[0] = point[0] + forward[0] * distance[0] + right[0] * distance[1];
  result[1] = point[1] + forward[1] * distance[0] + right[1] * distance[1];
  result[2] = point[2] + forward[2] * distance[0] + right[2] * distance[1] + distance[2];
}

// gi.TagMalloc(strlen(in)+1, TAG_LEVEL) + strcpy is the allocate-and-copy
// idiom for C's owned char*; per PORTING.md this collapses to a plain
// string assignment since JS strings are immutable values, not buffers
// that need an independent copy -- byte-identical to src/ctf/g_utils.ts's
// G_CopyString.
export function G_CopyString(inStr: string): string {
  return inStr;
}

/*
=================
G_InitEdict (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts
=================
*/
export function G_InitEdict(e: EdictT): void {
  e.inuse = true;
  e.classname = "noclass";
  e.gravity = 1.0;
  // `e - g_edicts` (pointer offset) recovered by identity lookup instead of
  // address arithmetic, same as src/ctf/g_utils.ts's G_InitEdict.
  e.s.number = g_edicts.indexOf(e);
}

/*
=================
G_Spawn (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts aside
from the dead `0.5` -> `0.5f` literal-suffix change noted above.
=================
*/
export function G_Spawn(): EdictT {
  const maxclients = gameCvars.maxclients === null ? 0 : gameCvars.maxclients.value;

  let i = maxclients + 1;
  for (; i < globals.num_edicts; i++) {
    const e = g_edicts[i];
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
    throw new Error(`G_Spawn: g_edicts has no preallocated slot at index ${i}`);
  }
  G_InitEdict(e);
  return e;
}

/*
=================
G_FreeEdict (lmctf60/g_utils.c:467)

Identical to src/ctf/g_utils.ts's G_FreeEdict -- lmctf60's only change from
the ctf ancestor is a commented-out (never compiled) LM_JORM debug assert
block that is not reproduced here since it is dead code even in the C
source (a comment, not an #ifdef branch).

Marks the edict as free. Refuses to free the world/client/body-queue
range of the g_edicts array (indices 0..maxclients+BODY_QUEUE_SIZE),
matching the C pointer-arithmetic bound `(ed - g_edicts) <=
(maxclients->value + BODY_QUEUE_SIZE)` exactly via `g_edicts.indexOf(ed)`.
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
G_TouchTriggers (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
G_TouchTriggers.
============
*/
export function G_TouchTriggers(ent: EdictT): void {
  if ((ent.client !== null || (ent.svflags & SVF_MONSTER) !== 0) && ent.health <= 0) return;

  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(ent.absmin, ent.absmax, touch, MAX_EDICTS, AREA_TRIGGERS);

  for (let i = 0; i < num; i++) {
    const hit = g_edicts[touch[i].s.number];
    if (hit === undefined || !hit.inuse) continue;
    if (!hit.touch) continue;
    hit.touch(hit, ent, null, null);
  }
}

/*
============
G_TouchSolids (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
G_TouchSolids, including the preserved bug where the original calls
ent->touch (not hit->touch).

Call after linking a new trigger in during gameplay to force all entities
it covers to immediately touch it.
============
*/
export function G_TouchSolids(ent: EdictT): void {
  const touch: Edict[] = new Array<Edict>(MAX_EDICTS);
  const num = gi.BoxEdicts(ent.absmin, ent.absmax, touch, MAX_EDICTS, AREA_SOLID);

  for (let i = 0; i < num; i++) {
    const hit = g_edicts[touch[i].s.number];
    if (hit === undefined || !hit.inuse) continue;
    // NOTE: the original calls ent->touch (not hit->touch) here -- preserved
    // bug-for-bug per PORTING.md.
    if (ent.touch) ent.touch(hit, ent, null, null);
    if (!ent.inuse) break;
  }
}

/*
=================
KillBox (lmctf60/g_utils.c) -- byte-identical to src/ctf/g_utils.ts's
KillBox.

Kills all entities that would touch the proposed new positioning of ent.
Ent should be unlinked before calling this!
=================
*/
export function KillBox(ent: EdictT): boolean {
  for (;;) {
    const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, ent.s.origin, null, MASK_PLAYERSOLID);
    if (tr.ent === null) break;

    const target = g_edicts[tr.ent.s.number];

    T_Damage(target, ent, ent, vec3_origin, ent.s.origin, vec3_origin, 100000, 0, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);

    if (target.solid !== SolidT.SOLID_NOT) return false;
  }

  return true; // all clear
}

/*
=================
Team_centerprint (lmctf60/g_utils.c, marked "CTF CODE -- LM_JORM" -- LM_CTF
addition appended at the end of the file, no ctf/baseq2 ancestor)

Centerprints `message` to every client on team `color`; if `elsemessage` is
non-null, every other in-game client gets that instead. Bug-for-bug: the
C source's trailing `gi.dprintf(elsemessage)` call is unconditional and
dereferences a possibly-NULL `elsemessage` -- gi.dprintf's signature here
takes a `string`, so a NULL elsemessage is passed through as the literal
string "null" would be in C's printf("%s", NULL) UB path; per the fidelity
razor (PORTING.md/preferences rule 17) this is preserved observably as "no
message" (skip the call) rather than reproducing a platform-dependent
crash, since the original's actual behavior on every real libc target
(glibc/Windows CRT) either prints "(null)" or crashes -- neither of which
is a behavior this port can or should reproduce identically. Every call
site in this file passes a non-null elsemessage, so this guard is inert in
practice.
=================
*/
export function Team_centerprint(color: number, message: string, elsemessage: string | null): void {
  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || !cl_ent.inuse) continue;
    if (cl_ent.client === null) continue;
    if (cl_ent.client.ctf.teamnum === color) {
      gi.centerprintf(cl_ent, message);
    } else if (elsemessage !== null) {
      gi.centerprintf(cl_ent, elsemessage);
    }
  }
  if (elsemessage !== null) gi.dprintf(elsemessage);
}

/*
=================
Team_cprint (lmctf60/g_utils.c, marked "CTF CODE -- LM_JORM") -- same shape
as Team_centerprint but gates on ctf_validateplayer and prints through
ctf_SafePrint at PRINT_HIGH instead of gi.centerprintf. See
Team_centerprint's doc comment for the elsemessage-null handling rationale.
=================
*/
// Lazy require, not a static import: g_ctffunc.ts (ctf_hook_abort) ->
// g_utils.ts (G_FreeEdict) is an established static import in the other
// direction; a static import of g_ctffunc.ts here would close a value
// cycle. Per PORTING.md's import-cycle rule, g_utils.c is the more
// fundamental utility module, so this file (the "less fundamental" side
// for this particular pair of functions) resolves g_ctffunc.ts lazily.
function ctffunc(): typeof import("./g_ctffunc") {
  return require("./g_ctffunc") as typeof import("./g_ctffunc");
}

export function Team_cprint(color: number, message: string, elsemessage: string | null): void {
  const { ctf_validateplayer, ctf_SafePrint, CTF_TEAM_IGNORETEAM } = ctffunc();
  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || !ctf_validateplayer(cl_ent, CTF_TEAM_IGNORETEAM)) continue;
    if (cl_ent.client === null) continue;
    if (cl_ent.client.ctf.teamnum === color) {
      ctf_SafePrint(cl_ent, PRINT_HIGH, message);
    } else if (elsemessage !== null) {
      ctf_SafePrint(cl_ent, PRINT_HIGH, elsemessage);
    }
  }
  if (elsemessage !== null) gi.dprintf(elsemessage);
}
