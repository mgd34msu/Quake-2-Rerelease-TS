// g_newfnc.ts -- mission-pack func_* entities layered onto this module's own
// g_func.ts.
//
// Classnames landed in this file:
//   func_plat2  (placed by the re-release xcompnd2.bsp)
//
// The frozen Xatrix DLL drops it with "func_plat2 doesn't have a spawn
// function": func_plat2 is Ground Zero's (rogue's) plat, and the re-release
// rebuild of xcompnd2 uses it.
//
// SOURCE: src/rogue/g_func.ts's "PLAT 2 -- ROGUE" section (rogue/g_func.c),
// with the same file-level arrangement src/game/g_newfnc.ts uses for its own
// copy. src/game, src/xatrix and src/rogue are HARD FORKS of each other with
// structurally different EdictT types and no cross-module import anywhere in
// the tree, so the implementation is COPIED IN, exactly as commit 288484f
// copied the sibling modules' entities into src/game.
//
// func_plat2 shares plumbing with vanilla func_plat (Move_Calc, the STATE_*
// enumerants, plat_spawn_inside_trigger's shape). Move_Calc is exported by
// this module's g_func.ts and is imported; the STATE_* values and
// plat_spawn_inside_trigger are private to g_func.ts, so this file carries its
// own copies -- the STATE_* values are transcribed to the same numbers, and
// the trigger spawner is the rogue variant that RETURNS the trigger it made
// (vanilla's returns void).
//
// Faithful, line-by-line port; deviations are called out inline.

import {
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorScale,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_STATIC,
  CHAN_NO_PHS_ADD,
  CHAN_VOICE,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
} from "../shared/q_shared";
import { SolidT, SVF_MONSTER } from "./game";
import {
  type EdictT,
  FL_TEAMSLAVE,
  g_edicts,
  gameCvars,
  gi,
  globals,
  level,
  MOD_CRUSH,
  MovetypeT,
  st,
} from "./g_local";
import { BecomeExplosion1 } from "./g_misc";
import { T_Damage } from "./g_combat";
import { Move_Calc } from "./g_func";
import { G_Find, G_FreeEdict, G_Spawn, G_UseTargets } from "./g_utils";
import { registerSaveFunction } from "./g_save";

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// plat states, matching src/xatrix/g_func.ts's own (private) STATE_* values.
const STATE_TOP = 0;
const STATE_BOTTOM = 1;
const STATE_UP = 2;
const STATE_DOWN = 3;

const PLAT_LOW_TRIGGER = 1;

// ROGUE
const PLAT2_TOGGLE = 2;
const PLAT2_TOP = 4;
// PLAT2_TRIGGER_TOP/PLAT2_TRIGGER_BOTTOM are documented on func_plat2's
// QUAKED line but never read anywhere in the shipped rogue g_func.c
// (plat2_hit_top/plat2_hit_bottom always call G_UseTargets unconditionally)
// -- preserved as unused spawnflag bits, matching the C source's own dead
// declarations.
const PLAT2_TRIGGER_TOP = 8;
const PLAT2_TRIGGER_BOTTOM = 16;
void PLAT2_TRIGGER_TOP;
void PLAT2_TRIGGER_BOTTOM;
const PLAT2_BOX_LIFT = 32;

// plat2flags bits (distinct from the spawnflags above).
const PLAT2_CALLED = 1;
const PLAT2_MOVING = 2;
const PLAT2_WAITING = 4;

//==========================================================
// bad_area -- rogue/g_newai.c's SpawnBadArea
//==========================================================

/**
 * rogue/g_newai.c's `badarea_touch` -- the shipped body is a single commented
 * out `drawbbox(ent)` debug call, so the touch handler is deliberately empty
 * in the C source too (src/rogue/g_newai.ts:890 transcribes it the same way).
 */
function badarea_touch(_ent: EdictT, _other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // drawbbox(ent);
}

/**
 * rogue/g_newai.c's `SpawnBadArea` -- ported from src/rogue/g_newai.ts:894.
 *
 * func_plat2 marks the volume under a rising plat as a "bad area" so Ground
 * Zero's monster navigation (CheckForBadArea, called from that pack's
 * M_MoveStep/ai_run) steers monsters out from under it.
 *
 * DEGRADATION, and the reason this is still worth porting: The Reckoning has
 * NO consumer for bad_area -- CheckForBadArea is a Ground Zero addition and
 * this pack's g_ai.ts does not call it -- so the marker is inert here. It is
 * ported anyway because plat2_hit_bottom's `plat2_kill_danger_area` scans for
 * `classname == "bad_area"` owned by the plat and frees them; dropping the
 * spawner while keeping the sweep (or dropping both) would silently diverge
 * from the C's edict bookkeeping. The marker is SOLID_TRIGGER with an empty
 * touch, so it changes nothing a player or monster can observe.
 */
function SpawnBadArea(minsIn: Vec3, maxsIn: Vec3, lifespan: number, owner: EdictT | null): EdictT {
  const mins = vec3();
  VectorCopy(minsIn, mins);
  const maxs = vec3();
  VectorCopy(maxsIn, maxs);

  const origin = vec3();
  VectorAdd(mins, maxs, origin);
  VectorScale(origin, 0.5, origin);

  VectorSubtract(maxs, origin, maxs);
  VectorSubtract(mins, origin, mins);

  const badarea = G_Spawn();
  VectorCopy(origin, badarea.s.origin);
  VectorCopy(maxs, badarea.maxs);
  VectorCopy(mins, badarea.mins);
  badarea.touch = badarea_touch;
  badarea.movetype = MovetypeT.MOVETYPE_NONE;
  badarea.solid = SolidT.SOLID_TRIGGER;
  badarea.classname = "bad_area";
  gi.linkentity(badarea);

  if (lifespan) {
    badarea.think = G_FreeEdict;
    badarea.nextthink = level.time + lifespan;
  }
  if (owner !== null) {
    badarea.owner = owner;
  }

  return badarea;
}

//==========================================================
// func_plat2 -- src/rogue/g_func.ts
//==========================================================

function Touch_Plat_Center2(ent: EdictT, other: EdictT, _plane: CplaneT | null, _surf: CsurfaceT | null): void {
  // this requires monsters to actively trigger plats, not just step on them.
  if (other.health <= 0) return;

  // PMM - don't let non-monsters activate plat2s
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) return;

  plat2_operate(ent, other);
}

// PGM - plat2's change the trigger field, so this returns the trigger it
// spawned (this module's own plat_spawn_inside_trigger in g_func.ts is
// private and returns void; this is a standalone copy for func_plat2's own
// use, matching src/game/g_newfnc.ts's plat2_spawn_inside_trigger).
function plat2_spawn_inside_trigger(ent: EdictT): EdictT {
  const trigger = G_Spawn();
  trigger.touch = Touch_Plat_Center2;
  trigger.movetype = MovetypeT.MOVETYPE_NONE;
  trigger.solid = SolidT.SOLID_TRIGGER;
  trigger.enemy = ent;

  const tmin = vec3();
  const tmax = vec3();

  tmin[0] = ent.mins[0] + 25;
  tmin[1] = ent.mins[1] + 25;
  tmin[2] = ent.mins[2];

  tmax[0] = ent.maxs[0] - 25;
  tmax[1] = ent.maxs[1] - 25;
  tmax[2] = ent.maxs[2] + 8;

  tmin[2] = tmax[2] - (ent.pos1[2] - ent.pos2[2] + st.lip);

  if ((ent.spawnflags & PLAT_LOW_TRIGGER) !== 0) tmax[2] = tmin[2] + 8;

  if (tmax[0] - tmin[0] <= 0) {
    tmin[0] = (ent.mins[0] + ent.maxs[0]) * 0.5;
    tmax[0] = tmin[0] + 1;
  }
  if (tmax[1] - tmin[1] <= 0) {
    tmin[1] = (ent.mins[1] + ent.maxs[1]) * 0.5;
    tmax[1] = tmin[1] + 1;
  }

  VectorCopy(tmin, trigger.mins);
  VectorCopy(tmax, trigger.maxs);

  gi.linkentity(trigger);

  return trigger;
}

function plat2_spawn_danger_area(ent: EdictT): void {
  const mins = vec3(ent.mins[0], ent.mins[1], ent.mins[2]);
  const maxs = vec3(ent.maxs[0], ent.maxs[1], ent.maxs[2]);
  maxs[2] = ent.mins[2] + 64;

  SpawnBadArea(mins, maxs, 0, ent);
}

function plat2_kill_danger_area(ent: EdictT): void {
  let t: EdictT | null = null;
  while ((t = G_Find(t, "classname", "bad_area")) !== null) {
    if (t.owner === ent) G_FreeEdict(t);
  }
}

function plat2_hit_top(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_TOP;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_down;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) === 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_down;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  G_UseTargets(ent, ent);
}

function plat2_hit_bottom(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_end) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = 0;
  }
  ent.moveinfo.state = STATE_BOTTOM;

  if ((ent.plat2flags & PLAT2_CALLED) !== 0) {
    ent.plat2flags = PLAT2_WAITING;
    if ((ent.spawnflags & PLAT2_TOGGLE) === 0) {
      ent.think = plat2_go_up;
      ent.nextthink = level.time + 5.0;
    }
    if (cvarNum(gameCvars.deathmatch) !== 0) ent.last_move_time = level.time - 1.0;
    else ent.last_move_time = level.time - 2.0;
  } else if ((ent.spawnflags & PLAT2_TOP) !== 0 && (ent.spawnflags & PLAT2_TOGGLE) === 0) {
    ent.plat2flags = 0;
    ent.think = plat2_go_up;
    ent.nextthink = level.time + 2.0;
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = 0;
    ent.last_move_time = level.time;
  }

  plat2_kill_danger_area(ent);
  G_UseTargets(ent, ent);
}

function plat2_go_down(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_DOWN;
  ent.plat2flags |= PLAT2_MOVING;

  Move_Calc(ent, ent.moveinfo.end_origin, plat2_hit_bottom);
}

function plat2_go_up(ent: EdictT): void {
  if ((ent.flags & FL_TEAMSLAVE) === 0) {
    if (ent.moveinfo.sound_start) {
      gi.sound(ent, CHAN_NO_PHS_ADD + CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
    }
    ent.s.sound = ent.moveinfo.sound_middle;
  }
  ent.moveinfo.state = STATE_UP;
  ent.plat2flags |= PLAT2_MOVING;

  plat2_spawn_danger_area(ent);

  Move_Calc(ent, ent.moveinfo.start_origin, plat2_hit_top);
}

function plat2_operate(triggerEnt: EdictT, other: EdictT): void {
  const trigger = triggerEnt;
  const plat = triggerEnt.enemy; // now point at the plat, not the trigger
  // guards TS null-safety; always set when trigger.touch === Touch_Plat_Center2
  if (plat === null) return;

  if ((plat.plat2flags & PLAT2_MOVING) !== 0) return;

  if (plat.last_move_time + 2 > level.time) return;

  const platCenter = (trigger.absmin[2] + trigger.absmax[2]) / 2;

  let otherState: number;
  if (plat.moveinfo.state === STATE_TOP) {
    otherState = STATE_TOP;
    if ((plat.spawnflags & PLAT2_BOX_LIFT) !== 0) {
      if (platCenter > other.s.origin[2]) otherState = STATE_BOTTOM;
    } else {
      if (trigger.absmax[2] > other.s.origin[2]) otherState = STATE_BOTTOM;
    }
  } else {
    otherState = STATE_BOTTOM;
    if (other.s.origin[2] > platCenter) otherState = STATE_TOP;
  }

  plat.plat2flags = PLAT2_MOVING;

  let pauseTime: number;
  if (cvarNum(gameCvars.deathmatch) !== 0) pauseTime = 0.3;
  else pauseTime = 0.5;

  if (plat.moveinfo.state !== otherState) {
    plat.plat2flags |= PLAT2_CALLED;
    pauseTime = 0.1;
  }

  plat.last_move_time = level.time;

  if (plat.moveinfo.state === STATE_BOTTOM) {
    plat.think = plat2_go_up;
    plat.nextthink = level.time + pauseTime;
  } else {
    plat.think = plat2_go_down;
    plat.nextthink = level.time + pauseTime;
  }
}

function plat2_blocked(self: EdictT, other: EdictT): void {
  if ((other.svflags & SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, 0, MOD_CRUSH);
    // if it's still there, nuke it
    if (other.inuse) BecomeExplosion1(other);
    return;
  }

  // gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, 0, MOD_CRUSH);
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, 0, MOD_CRUSH);

  if (self.moveinfo.state === STATE_UP) plat2_go_down(self);
  else if (self.moveinfo.state === STATE_DOWN) plat2_go_up(self);
}

function Use_Plat2(ent: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (ent.moveinfo.state > STATE_BOTTOM) return;
  if (ent.last_move_time + 2 > level.time) return;
  // plat2_operate unconditionally dereferences its `other` param (C would
  // crash on a NULL activator here too); guarded for TS's nullable `use`
  // signature rather than left as an unchecked dereference.
  if (activator === null) return;

  for (let i = 1; i < globals.num_edicts; i++) {
    const trigger = g_edicts[i];
    if (!trigger.inuse) continue;
    if (trigger.touch === Touch_Plat_Center2 && trigger.enemy === ent) {
      plat2_operate(trigger, activator);
      return;
    }
  }
}

function plat2_activate(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.use = Use_Plat2;

  const trigger = plat2_spawn_inside_trigger(ent); // the "start moving" trigger

  trigger.maxs[0] += 10;
  trigger.maxs[1] += 10;
  trigger.mins[0] -= 10;
  trigger.mins[1] -= 10;

  gi.linkentity(trigger);

  trigger.touch = Touch_Plat_Center2; // Override trigger touch function

  plat2_go_down(ent);
}

/*QUAKED func_plat2 (0 .5 .8) ? PLAT_LOW_TRIGGER PLAT2_TOGGLE PLAT2_TOP PLAT2_TRIGGER_TOP PLAT2_TRIGGER_BOTTOM BOX_LIFT
speed	default 150

PLAT_LOW_TRIGGER - creates a short trigger field at the bottom
PLAT2_TOGGLE - plat will not return to default position.
PLAT2_TOP - plat's default position will the the top.
PLAT2_TRIGGER_TOP - plat will trigger it's targets each time it hits top
PLAT2_TRIGGER_BOTTOM - plat will trigger it's targets each time it hits bottom
BOX_LIFT - this indicates that the lift is a box, rather than just a platform

Plats are always drawn in the extended position, so they will light correctly.

If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.

"speed"	overrides default 200.
"accel" overrides default 500
"lip"	no default

If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determoveinfoned by the model's height.
*/
export function SP_func_plat2(ent: EdictT): void {
  VectorClear(ent.s.angles);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  gi.setmodel(ent, ent.model ?? "");

  ent.blocked = plat2_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ent.speed *= 2;
    ent.accel *= 2;
    ent.decel *= 2;
  }

  // PMM Added to kill things it's being blocked by
  if (!ent.dmg) ent.dmg = 2;

  // pos1 is the top position, pos2 is the bottom
  VectorCopy(ent.s.origin, ent.pos1);
  VectorCopy(ent.s.origin, ent.pos2);

  if (st.height) ent.pos2[2] -= st.height - st.lip;
  else ent.pos2[2] -= ent.maxs[2] - ent.mins[2] - st.lip;

  ent.moveinfo.state = STATE_TOP;

  if (ent.targetname !== null) {
    ent.use = plat2_activate;
  } else {
    ent.use = Use_Plat2;

    const trigger = plat2_spawn_inside_trigger(ent); // the "start moving" trigger

    // PGM - debugging??
    trigger.maxs[0] += 10;
    trigger.maxs[1] += 10;
    trigger.mins[0] -= 10;
    trigger.mins[1] -= 10;

    gi.linkentity(trigger);

    trigger.touch = Touch_Plat_Center2; // Override trigger touch function

    if ((ent.spawnflags & PLAT2_TOP) === 0) {
      VectorCopy(ent.pos2, ent.s.origin);
      ent.moveinfo.state = STATE_BOTTOM;
    }
  }

  gi.linkentity(ent);

  ent.moveinfo.speed = ent.speed;
  ent.moveinfo.accel = ent.accel;
  ent.moveinfo.decel = ent.decel;
  ent.moveinfo.wait = ent.wait;
  VectorCopy(ent.pos1, ent.moveinfo.start_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.start_angles);
  VectorCopy(ent.pos2, ent.moveinfo.end_origin);
  VectorCopy(ent.s.angles, ent.moveinfo.end_angles);

  ent.moveinfo.sound_start = gi.soundindex("plats/pt1_strt.wav");
  ent.moveinfo.sound_middle = gi.soundindex("plats/pt1_mid.wav");
  ent.moveinfo.sound_end = gi.soundindex("plats/pt1_end.wav");
}

// ---------------------------------------------------------------------------
// Savegame function registry -- see g_save.ts's registerSaveFunction.
// ---------------------------------------------------------------------------

registerSaveFunction("g_newfnc:badarea_touch", badarea_touch);
registerSaveFunction("g_newfnc:plat2_hit_top", plat2_hit_top);
registerSaveFunction("g_newfnc:plat2_hit_bottom", plat2_hit_bottom);
registerSaveFunction("g_newfnc:plat2_go_down", plat2_go_down);
registerSaveFunction("g_newfnc:plat2_go_up", plat2_go_up);
registerSaveFunction("g_newfnc:plat2_blocked", plat2_blocked);
registerSaveFunction("g_newfnc:Use_Plat2", Use_Plat2);
registerSaveFunction("g_newfnc:plat2_activate", plat2_activate);
registerSaveFunction("g_newfnc:Touch_Plat_Center2", Touch_Plat_Center2);
