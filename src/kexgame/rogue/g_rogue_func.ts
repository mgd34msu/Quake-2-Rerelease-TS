// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_func.c -- the ROGUE mission pack's `func_plat2` extensions (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_func.cpp (430
// lines, C++17): `func_plat2` itself -- a plat with THREE resting states
// (top, bottom, and a trigger-called "middle" state reached only via
// `plat2_operate`'s PLAT2_CALLED bookkeeping, not a literal third stop
// position; the plat still only ever *rests* at pos1/pos2, but a
// mid-cycle "someone called it while it was already headed somewhere
// else" call re-targets the SAME move rather than queuing a second one) --
// plus `plat2_spawn_danger_area`/`plat2_kill_danger_area`, the "bad area"
// monster-AI-avoidance integration every func_plat (not just plat2) reaches
// through g_func.ts's `plat_go_up`/`plat_hit_bottom`. Behavioral code,
// ported bug-for-bug per PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 1 SP_* in the C++ source, 1 exported here
// ============================================================================
// `grep -c '^void SP_' g_rogue_func.cpp` = 1: SP_func_plat2.
//
// ============================================================================
// STUB SWAP THIS UNIT OWNS: g_func.ts's `plat2_spawn_danger_area` NO-OP
// ============================================================================
// g_func.ts's own header ("THE plat2 BOUNDARY") documents a permanent
// no-op placeholder for `plat2_spawn_danger_area` (called unconditionally
// from `plat_go_up`, reached by EVERY func_plat, not just plat2 entities)
// because `SpawnBadArea` -- the one thing the real body calls -- lived in a
// third, unported translation unit (rogue/g_rogue_newai.cpp) at the time
// g_func.ts landed. `SpawnBadArea` is now real, exported from
// rogue/g_rogue_newai.ts. This file exports a REAL `plat2_spawn_danger_area`
// (line 18 below, g_rogue_func.cpp:18-26) that calls it; g_func.ts's
// placeholder function and its explanatory comment are deleted and replaced
// with `import { plat2_spawn_danger_area } from "./rogue/g_rogue_func"` --
// see that file's own updated header for the after-state. `plat2_kill_danger_area`
// (g_func.ts already ports this one for real, per its own header's
// "RULING" paragraph) is duplicated here too, verbatim, since ROGUE's own
// `func_plat2` state machine (`plat2_hit_bottom`) needs its own call site to
// the same cleanup walk and g_func.ts's copy is unexported (matching this
// port line's "small, single-purpose helper: copy, don't cross-import"
// precedent for `edictFmt`/`cvarOrDefault`/`mod` etc., since re-exporting a
// one-line loop across the module boundary would cost more than it saves).
//
// ============================================================================
// `plat_spawn_inside_trigger` -- EXPORTED from g_func.ts as part of this unit
// ============================================================================
// `plat2_activate`/`SP_func_plat2` both call `plat_spawn_inside_trigger`
// (g_func.cpp's own helper, PGM-authored specifically so plat2 could
// override the resulting trigger's `touch` -- see that function's own "PGM -
// plat2's change the trigger field" comment, still present verbatim in
// g_func.ts). It was `function`-scoped (unexported) in g_func.ts because
// nothing outside that file needed it before this unit. Added `export` to
// its declaration in g_func.ts -- a one-word, behavior-neutral visibility
// change (no logic touched) -- so this file can call the real shared
// implementation instead of a second local copy of a function whose whole
// point (per its own PGM comment) is to be reused by plat2.
//
// ============================================================================
// `st` (spawn_temp_t) -- imports the REAL shared global from g_spawn.ts,
// not g_func.ts's own stale local placeholder
// ============================================================================
// g_func.ts's own header documents its `st` as "a real-shaped, permanently-
// default placeholder" (no src/kexgame/g_spawn.ts existed when it was
// written) and explicitly says "a future unit should delete this placeholder
// and import the real one." g_spawn.ts has since landed with a real,
// mutated-during-parsing `export const st: SpawnTempT` (already the import
// source g_target.ts/g_trigger.ts use, per their own headers). Since this is
// a NEW file, not an edit to g_func.ts's existing (still-placeholder) `st`,
// it imports the real one directly from "../g_spawn" rather than
// perpetuating the stale copy -- `st.height`/`st.lip` read here reflect
// whatever the entity actually being parsed set, exactly like the C++
// source's real global `st`.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `Use_Plat2`'s C++ body walks a raw pointer range (`g_edicts + 1` .. `&
//   g_edicts[globals.num_edicts]`) looking for the one `trigger_teleport`-
//   shaped entity whose `touch == Touch_Plat_Center2` and `enemy == ent`.
//   Ported as a plain indexed loop over `g_edicts[1 .. globals.num_edicts)`,
//   matching this port line's established `for (let i = 1; i <
//   globals.num_edicts; i++)` idiom (see g_utils.ts).
// - `plat2_operate`'s `other` parameter and `Use_Plat2`'s `activator`
//   argument are dereferenced unconditionally in the C++ source (no null
//   check anywhere in the call chain) -- ported with a `must()` guard that
//   throws with a descriptive message instead of segfaulting, matching this
//   port line's "throw instead of dereference null" convention for C++
//   call sites with no null check of their own (see g_turret.ts's
//   `SP_turret_breach` precedent for the identical pattern on `self.model`).
// - `SP_func_plat2`'s `gi.setmodel(ent, ent->model)` call has no null guard
//   in the C++ source (unlike vanilla `SP_func_plat`'s `if (ent->model)
//   gi.setmodel(...)`) -- ported the same way, via a `must()`-style throw
//   rather than a silent skip, again matching `SP_turret_breach`'s
//   precedent.

import { vec3, VectorCopy } from "../../shared/math";
import type { CvarT } from "../../shared/q_shared";
import { type KexTraceT, SolidT, SvflagsT, SoundchanT, CvarFlagsT, ATTN_STATIC } from "../../kexapi/game";
import { type EdictT, type ModT, MovetypeT, EntFlagsT, MoveStateT, ModIdT, DamageflagsT, Plat2flagsT } from "../g_local";
import { gi, g_edicts, globals, level } from "../g_main_globals";
import { type GTime, Gtime_add, Gtime_subtract, Gtime_from_sec, Gtime_from_ms } from "../gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "../spawnflags";
import { vec3_origin } from "../q_vec3";
import { G_FindByString, G_FreeEdict, G_UseTargets } from "../g_utils";
import { T_Damage } from "../g_combat";
import { BecomeExplosion1 } from "../g_misc";
import { st } from "../g_spawn";
import { Move_Calc, G_SetMoveinfoSounds, plat_spawn_inside_trigger } from "../g_func";
import { SpawnBadArea } from "./g_rogue_newai";
import {
  RegisterThink,
  RegisterTouch,
  RegisterUse,
  RegisterMoveinfoEndfunc,
  RegisterMoveinfoBlocked,
  type ThinkFn,
  type TouchFn,
  type UseFn,
  type MoveinfoEndfuncFn,
  type MoveinfoBlockedFn,
} from "../g_save_registry";

// ---------------------------------------------------------------------------
// small local helpers -- see g_rogue_newai.ts's identical copies; each
// rogue/*.ts file keeps its own per this port line's established precedent.
// ---------------------------------------------------------------------------

function deathmatchEnabled(): boolean {
  const c: CvarT | null = gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

/** g_local.h:1085's `mod_t(mod_id_t)` implicit conversion -- see g_func.ts's
 *  identical local copy's header note. */
function mod(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

function must<T>(value: T | null, name: string, self: EdictT): T {
  if (value === null) throw new Error(`g_rogue_func: ${name} is null for ${self.classname ?? "?"} (unchecked in g_rogue_func.cpp)`);
  return value;
}

//====
// PGM
const SPAWNFLAGS_PLAT2_TOGGLE: SpawnFlags = SpawnFlags_from(2);
const SPAWNFLAGS_PLAT2_TOP: SpawnFlags = SpawnFlags_from(4);
const SPAWNFLAGS_PLAT2_START_ACTIVE: SpawnFlags = SpawnFlags_from(8);
const SPAWNFLAGS_PLAT2_BOX_LIFT: SpawnFlags = SpawnFlags_from(32);
// PGM
//====

/**
 * rogue/g_rogue_func.cpp:18-26 `void plat2_spawn_danger_area(edict_t *ent)`.
 * Spawns a `bad_area` marker covering the plat's own footprint up to 64
 * units above its `mins[2]` -- a monster-AI pathing hint, zero mechanical
 * effect on the plat itself. See file header's "STUB SWAP THIS UNIT OWNS".
 */
export function plat2_spawn_danger_area(ent: EdictT): void {
  const mins = vec3(ent.mins[0], ent.mins[1], ent.mins[2]);
  const maxs = vec3(ent.maxs[0], ent.maxs[1], ent.mins[2] + 64);

  SpawnBadArea(mins, maxs, 0 as GTime, ent);
}

/**
 * rogue/g_rogue_func.cpp:29-39 `void plat2_kill_danger_area(edict_t *ent)`.
 * See file header's "`plat_spawn_inside_trigger`" section on why this is a
 * second copy of g_func.ts's own (unexported) identical helper.
 */
function plat2_kill_danger_area(ent: EdictT): void {
  let t: EdictT | null = null;
  for (;;) {
    t = G_FindByString(t, "classname", "bad_area");
    if (t === null) break;
    if (t.owner === ent) G_FreeEdict(t);
  }
}

const plat2_go_down: ThinkFn = RegisterThink("plat2_go_down", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_start) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }

  ent.s.sound = ent.moveinfo.sound_middle;

  ent.moveinfo.state = MoveStateT.STATE_DOWN;
  ent.plat2flags |= Plat2flagsT.PLAT2_MOVING;

  Move_Calc(ent, ent.moveinfo.end_origin, plat2_hit_bottom);
});

const plat2_go_up: ThinkFn = RegisterThink("plat2_go_up", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_start) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_start, 1, ATTN_STATIC, 0);
  }

  ent.s.sound = ent.moveinfo.sound_middle;

  ent.moveinfo.state = MoveStateT.STATE_UP;
  ent.plat2flags |= Plat2flagsT.PLAT2_MOVING;

  plat2_spawn_danger_area(ent);

  Move_Calc(ent, ent.moveinfo.start_origin, plat2_hit_top);
});

/** rogue/g_rogue_func.cpp:41-78 `MOVEINFO_ENDFUNC(plat2_hit_top)`. */
const plat2_hit_top: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("plat2_hit_top", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_end) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
  }
  ent.s.sound = 0;
  ent.moveinfo.state = MoveStateT.STATE_TOP;

  if ((ent.plat2flags & Plat2flagsT.PLAT2_CALLED) !== 0) {
    ent.plat2flags = Plat2flagsT.PLAT2_WAITING;
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOGGLE)) {
      ent.think = plat2_go_down;
      ent.nextthink = Gtime_add(level.time, Gtime_from_sec(5));
    }
    ent.last_move_time = deathmatchEnabled() ? Gtime_subtract(level.time, Gtime_from_sec(1)) : Gtime_subtract(level.time, Gtime_from_sec(2));
  } else if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOP) && !SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOGGLE)) {
    ent.plat2flags = Plat2flagsT.PLAT2_NONE;
    ent.think = plat2_go_down;
    ent.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = Plat2flagsT.PLAT2_NONE;
    ent.last_move_time = level.time;
  }

  G_UseTargets(ent, ent);
});

/** rogue/g_rogue_func.cpp:80-118 `MOVEINFO_ENDFUNC(plat2_hit_bottom)`. */
const plat2_hit_bottom: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("plat2_hit_bottom", (ent: EdictT): void => {
  if ((ent.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    if (ent.moveinfo.sound_end) gi.sound(ent, SoundchanT.CHAN_NO_PHS_ADD | SoundchanT.CHAN_VOICE, ent.moveinfo.sound_end, 1, ATTN_STATIC, 0);
  }
  ent.s.sound = 0;
  ent.moveinfo.state = MoveStateT.STATE_BOTTOM;

  if ((ent.plat2flags & Plat2flagsT.PLAT2_CALLED) !== 0) {
    ent.plat2flags = Plat2flagsT.PLAT2_WAITING;
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOGGLE)) {
      ent.think = plat2_go_up;
      ent.nextthink = Gtime_add(level.time, Gtime_from_sec(5));
    }
    ent.last_move_time = deathmatchEnabled() ? Gtime_subtract(level.time, Gtime_from_sec(1)) : Gtime_subtract(level.time, Gtime_from_sec(2));
  } else if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOP) && !SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOGGLE)) {
    ent.plat2flags = Plat2flagsT.PLAT2_NONE;
    ent.think = plat2_go_up;
    ent.nextthink = Gtime_add(level.time, Gtime_from_sec(2));
    ent.last_move_time = level.time;
  } else {
    ent.plat2flags = Plat2flagsT.PLAT2_NONE;
    ent.last_move_time = level.time;
  }

  plat2_kill_danger_area(ent);
  G_UseTargets(ent, ent);
});

/**
 * rogue/g_rogue_func.cpp:154-218 `void plat2_operate(edict_t *ent, edict_t
 * *other)`. `ent` here is actually the TRIGGER (renamed `trigger` inside,
 * matching the C++ source's own local reassignment: `trigger = ent; ent =
 * ent->enemy;`) -- kept as two distinctly-named parameters instead, since TS
 * has no in-place pointer-reassignment idiom that reads as cleanly.
 */
function plat2_operate(trigger: EdictT, other: EdictT): void {
  const ent = must(trigger.enemy, "enemy", trigger); // now point at the plat, not the trigger

  if ((ent.plat2flags & Plat2flagsT.PLAT2_MOVING) !== 0) return;

  if (Gtime_add(ent.last_move_time, Gtime_from_sec(2)) > level.time) return;

  const platCenter = (trigger.absmin[2] + trigger.absmax[2]) / 2;

  let otherState: MoveStateT;

  if (ent.moveinfo.state === MoveStateT.STATE_TOP) {
    otherState = MoveStateT.STATE_TOP;
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_BOX_LIFT)) {
      if (platCenter > other.s.origin[2]) otherState = MoveStateT.STATE_BOTTOM;
    } else {
      if (trigger.absmax[2] > other.s.origin[2]) otherState = MoveStateT.STATE_BOTTOM;
    }
  } else {
    otherState = MoveStateT.STATE_BOTTOM;
    if (other.s.origin[2] > platCenter) otherState = MoveStateT.STATE_TOP;
  }

  ent.plat2flags = Plat2flagsT.PLAT2_MOVING;

  let pauseTime: GTime = deathmatchEnabled() ? Gtime_from_ms(300) : Gtime_from_ms(500);

  if (ent.moveinfo.state !== otherState) {
    ent.plat2flags |= Plat2flagsT.PLAT2_CALLED;
    pauseTime = Gtime_from_ms(100);
  }

  ent.last_move_time = level.time;

  if (ent.moveinfo.state === MoveStateT.STATE_BOTTOM) {
    ent.think = plat2_go_up;
    ent.nextthink = Gtime_add(level.time, pauseTime);
  } else {
    ent.think = plat2_go_down;
    ent.nextthink = Gtime_add(level.time, pauseTime);
  }
}

/** rogue/g_rogue_func.cpp:220-236 `TOUCH(Touch_Plat_Center2)`. Requires
 *  monsters/players to actively trigger plat2s, not just step on them --
 *  the "FIXME - commented out for E3" client-only check is dead in the
 *  C++ source too (left commented out), not ported. */
const Touch_Plat_Center2: TouchFn = RegisterTouch("Touch_Plat_Center2", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.health <= 0) return;

  // PMM - don't let non-monsters activate plat2s
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) return;

  plat2_operate(self, other);
});

/** rogue/g_rogue_func.cpp:238-266 `MOVEINFO_BLOCKED(plat2_blocked)`. */
const plat2_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("plat2_blocked", (self: EdictT, other: EdictT): void => {
  if ((other.svflags & SvflagsT.SVF_MONSTER) === 0 && other.client === null) {
    // give it a chance to go away on it's own terms (like gibs)
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100000, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
    // if it's still there, nuke it
    if (other.inuse && other.solid !== SolidT.SOLID_NOT) BecomeExplosion1(other);
    return;
  }

  // gib dead things
  if (other.health < 1) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, 100, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
  }

  T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 1, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));

  // [Paril-KEX] killed, so don't change direction
  if (!other.inuse || other.solid === SolidT.SOLID_NOT) return;

  if (self.moveinfo.state === MoveStateT.STATE_UP) plat2_go_down(self);
  else if (self.moveinfo.state === MoveStateT.STATE_DOWN) plat2_go_up(self);
});

/** rogue/g_rogue_func.cpp:268-293 `USE(Use_Plat2)`. See file header's
 *  "DEVIATIONS" note on the raw-pointer-range loop. */
const Use_Plat2: UseFn = RegisterUse("Use_Plat2", (ent: EdictT, _other: EdictT | null, activator: EdictT | null): void => {
  if (ent.moveinfo.state > MoveStateT.STATE_BOTTOM) return;
  // [Paril-KEX] disabled this; causes confusing situations
  // if ((ent.last_move_time + 2_sec) > level.time) return;

  const usedBy = must(activator, "activator", ent);

  for (let i = 1; i < globals.num_edicts; i++) {
    const trigger = g_edicts[i];
    if (trigger === undefined || !trigger.inuse) continue;
    if (trigger.touch === Touch_Plat_Center2 && trigger.enemy === ent) {
      plat2_operate(trigger, usedBy);
      return;
    }
  }
});

/** rogue/g_rogue_func.cpp:295-316 `USE(plat2_activate)`. */
const plat2_activate: UseFn = RegisterUse("plat2_activate", (ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  ent.use = Use_Plat2;

  const trigger = plat_spawn_inside_trigger(ent); // the "start moving" trigger

  trigger.maxs[0] += 10;
  trigger.maxs[1] += 10;
  trigger.mins[0] -= 10;
  trigger.mins[1] -= 10;

  gi.linkentity(trigger);

  trigger.touch = Touch_Plat_Center2; // Override trigger touch function

  plat2_go_down(ent);
});

/*QUAKED func_plat2 (0 .5 .8) ? PLAT_LOW_TRIGGER PLAT2_TOGGLE PLAT2_TOP PLAT2_START_ACTIVE UNUSED BOX_LIFT
speed	default 150

PLAT_LOW_TRIGGER - creates a short trigger field at the bottom
PLAT2_TOGGLE - plat will not return to default position.
PLAT2_TOP - plat's default position will the the top.
PLAT2_START_ACTIVE - plat will trigger it's targets each time it hits top
UNUSED
BOX_LIFT - this indicates that the lift is a box, rather than just a platform

Plats are always drawn in the extended position, so they will light correctly.

If the plat is the target of another trigger or button, it will start out disabled in the extended position until it is trigger, when it will lower and become a normal plat.

"speed"	overrides default 200.
"accel" overrides default 500
"lip"	no default

If the "height" key is set, that will determine the amount the plat moves, instead of being implicitly determoveinfoned by the model's height.
*/
/** rogue/g_rogue_func.cpp:339-430 `void SP_func_plat2(edict_t *ent)`. */
export function SP_func_plat2(ent: EdictT): void {
  ent.s.angles = vec3(0, 0, 0);
  ent.solid = SolidT.SOLID_BSP;
  ent.movetype = MovetypeT.MOVETYPE_PUSH;

  if (ent.model === null) throw new Error("SP_func_plat2: ent.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(ent, ent.model);

  ent.moveinfo.blocked = plat2_blocked;

  if (!ent.speed) ent.speed = 20;
  else ent.speed *= 0.1;

  if (!ent.accel) ent.accel = 5;
  else ent.accel *= 0.1;

  if (!ent.decel) ent.decel = 5;
  else ent.decel *= 0.1;

  if (deathmatchEnabled()) {
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

  ent.moveinfo.state = MoveStateT.STATE_TOP;

  if (ent.targetname !== null && !SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_START_ACTIVE)) {
    ent.use = plat2_activate;
  } else {
    ent.use = Use_Plat2;

    const trigger = plat_spawn_inside_trigger(ent); // the "start moving" trigger

    // PGM - debugging??
    trigger.maxs[0] += 10;
    trigger.maxs[1] += 10;
    trigger.mins[0] -= 10;
    trigger.mins[1] -= 10;

    gi.linkentity(trigger);

    trigger.touch = Touch_Plat_Center2; // Override trigger touch function

    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAGS_PLAT2_TOP)) {
      VectorCopy(ent.pos2, ent.s.origin);
      ent.moveinfo.state = MoveStateT.STATE_BOTTOM;
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

  G_SetMoveinfoSounds(ent, "plats/pt1_strt.wav", "plats/pt1_mid.wav", "plats/pt1_end.wav");
}
