// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newfnc.c -- additional func_ entities from the ROGUE mission pack
// (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newfnc.cpp (325
// lines, C++17): `func_door_secret2` (a second, differently-parameterized
// secret-door mover -- moves sideways then forward/back, not vanilla
// `func_door_secret`'s sideways-then-forward-then-back-then-sideways
// four-leg cycle) and `func_force_wall` (a togglable particle-wall trigger
// hazard, telefragging anyone standing in it when it turns solid).
// Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 2 SP_* in the C++ source, 2 exported here
// ============================================================================
// `grep -c '^void SP_' g_rogue_newfnc.cpp` = 2: SP_func_door_secret2,
// SP_func_force_wall.
//
// ============================================================================
// NOT THE SAME AS g_func.ts's `func_door_secret` -- no shared state, no name
// collisions
// ============================================================================
// g_func.ts already ports vanilla `func_door_secret` (`door_secret_use`,
// `door_secret_move1`-`6`, `door_secret_done`, `door_secret_blocked`,
// `door_secret_die`, `SP_func_door_secret`). This file's C++ source
// declares an entirely separate, differently-named set for its OWN
// classname (`fd_secret_use`, `fd_secret_move1`-`6`, `fd_secret_done`,
// `secret_blocked`, `secret_touch`, `fd_secret_killed`,
// `SP_func_door_secret2`) -- no shared save-registry names, ported
// side-by-side with g_func.ts's copy, not merged into it (the two movers
// have genuinely different leg sequencing: vanilla's four legs vs. this
// file's two-leg sideways/forward cycle plus a `secret_touch` message
// print vanilla's version doesn't have).
//
// ============================================================================
// `giLocCenterPrint` -- local copy, not shared
// ============================================================================
// `secret_touch`'s `gi.LocCenter_Print(other, self->message)` (no format
// args) is ported via the same `gi.Loc_Print(e, PrintTypeT.PRINT_CENTER,
// base, args, args.length)` wrapper g_trigger.ts's own local
// `giLocCenterPrint` already uses -- copied here verbatim per this port
// line's "small header-only wrapper: duplicate per file" precedent (see
// g_rogue_newai.ts's/g_func.ts's own `edictFmt`/`cvarOrDefault` copies).
//
// ============================================================================
// `st` (spawn_temp_t) -- not needed
// ============================================================================
// Neither `SP_func_door_secret2` nor `SP_func_force_wall` reads `st` at all
// (verified against the C++ source) -- no `st` import needed in this file.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `fd_secret_use`'s C++ body: `for (ent = self; ent; ent = ent->teamchain)
//   Move_Calc(ent, ent->moveinfo.start_origin, fd_secret_move1);` walks the
//   `self` + team-chain siblings. Ported as an explicit `EdictT | null`
//   loop variable, matching this port line's established teamchain-walk
//   idiom (see g_func.ts's own `Move_Regular`/team-chain call sites).
// - `fd_secret_killed`'s C++ body recurses onto `self->teammaster` when
//   `self` is a `FL_TEAMSLAVE` whose teammaster still has `takedamage`.
//   Ported as a genuinely self-referencing `const` (the registered handler
//   calls itself by name inside its own closure body) -- legal since the
//   recursive call only ever executes after the top-level `const`
//   assignment (and its `RegisterDie` registration) has already completed;
//   see g_rogue_newai.ts's own header for the identical forward-reference
//   reasoning applied to mutually-recursive consts.

import type { Vec3 } from "../../shared/math";
import { vec3 } from "../../shared/math";
import { type KexTraceT, ServerCommandT, KexTempEventT, KexMulticastT, SvflagsT, SolidT, PrintTypeT } from "../../kexapi/game";
import { type EdictT, type ModT, EntFlagsT, ModIdT, DamageflagsT, MovetypeT } from "../g_local";
import { gi, level } from "../g_main_globals";
import { GTIME_ZERO, Gtime_add, Gtime_from_sec, Gtime_from_hz } from "../gtime";
import { type SpawnFlags, SpawnFlags_from, SpawnFlags_has } from "../spawnflags";
import { vec3_origin, vec3_add, vec3_muls, AngleVectors } from "../q_vec3";
import { G_FreeEdict, G_SetMovedir, KillBox } from "../g_utils";
import { T_Damage } from "../g_combat";
import { Move_Calc, G_SetMoveinfoSounds } from "../g_func";
import {
  RegisterThink,
  RegisterTouch,
  RegisterUse,
  RegisterDie,
  RegisterMoveinfoEndfunc,
  RegisterMoveinfoBlocked,
  type ThinkFn,
  type TouchFn,
  type UseFn,
  type DieFn,
  type MoveinfoEndfuncFn,
  type MoveinfoBlockedFn,
} from "../g_save_registry";

function mod(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** g_local.h's `LocCenter_Print(e, base, ...args)` convenience wrapper --
 *  see file header, copied from g_trigger.ts's identical local helper. */
function giLocCenterPrint(e: EdictT | null, base: string, ...args: (string | number)[]): void {
  gi.Loc_Print(e, PrintTypeT.PRINT_CENTER, base, args.map(String), args.length);
}

// =============================================================================
// SECRET DOORS (func_door_secret2)
// =============================================================================

const SPAWNFLAG_SEC_OPEN_ONCE: SpawnFlags = SpawnFlags_from(1); // stays open
const SPAWNFLAG_SEC_1ST_DOWN: SpawnFlags = SpawnFlags_from(4); // 1st move is down from arrow
const SPAWNFLAG_SEC_YES_SHOOT: SpawnFlags = SpawnFlags_from(16); // shootable even if targeted
const SPAWNFLAG_SEC_MOVE_RIGHT: SpawnFlags = SpawnFlags_from(32);
const SPAWNFLAG_SEC_MOVE_FORWARD: SpawnFlags = SpawnFlags_from(64);

/** rogue/g_rogue_newfnc.cpp:32-42 `USE(fd_secret_use)`. */
const fd_secret_use: UseFn = RegisterUse("fd_secret_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n) return;

  // trigger all paired doors
  let ent: EdictT | null = self;
  while (ent !== null) {
    Move_Calc(ent, ent.moveinfo.start_origin, fd_secret_move1);
    ent = ent.teamchain;
  }
});

/** rogue/g_rogue_newfnc.cpp:44-53 `DIE(fd_secret_killed)`. See file header's
 *  "DEVIATIONS" note on the self-referencing recursion. */
const fd_secret_killed: DieFn = RegisterDie(
  "fd_secret_killed",
  (self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3, dmgMod: ModT): void => {
    self.health = self.max_health;
    self.takedamage = false;

    if ((self.flags & EntFlagsT.FL_TEAMSLAVE) !== 0n && self.teammaster !== null && self.teammaster.takedamage) {
      fd_secret_killed(self.teammaster, inflictor, attacker, damage, point, dmgMod);
    } else {
      fd_secret_use(self, inflictor, attacker);
    }
  },
);

/** rogue/g_rogue_newfnc.cpp:56-60 `MOVEINFO_ENDFUNC(fd_secret_move1)` --
 *  wait after first movement. */
const fd_secret_move1: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("fd_secret_move1", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  self.think = fd_secret_move2;
});

/** rogue/g_rogue_newfnc.cpp:63-66 `THINK(fd_secret_move2)` -- start moving
 *  sideways w/sound. */
const fd_secret_move2: ThinkFn = RegisterThink("fd_secret_move2", (self: EdictT): void => {
  Move_Calc(self, self.moveinfo.end_origin, fd_secret_move3);
});

/** rogue/g_rogue_newfnc.cpp:69-76 `MOVEINFO_ENDFUNC(fd_secret_move3)` --
 *  wait here until time to go back. */
const fd_secret_move3: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("fd_secret_move3", (self: EdictT): void => {
  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_SEC_OPEN_ONCE)) {
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(self.wait));
    self.think = fd_secret_move4;
  }
});

/** rogue/g_rogue_newfnc.cpp:79-82 `THINK(fd_secret_move4)` -- move backward. */
const fd_secret_move4: ThinkFn = RegisterThink("fd_secret_move4", (self: EdictT): void => {
  Move_Calc(self, self.moveinfo.start_origin, fd_secret_move5);
});

/** rogue/g_rogue_newfnc.cpp:85-89 `MOVEINFO_ENDFUNC(fd_secret_move5)` --
 *  wait 1 second. */
const fd_secret_move5: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("fd_secret_move5", (self: EdictT): void => {
  self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  self.think = fd_secret_move6;
});

/** rogue/g_rogue_newfnc.cpp:91-94 `THINK(fd_secret_move6)`. */
const fd_secret_move6: ThinkFn = RegisterThink("fd_secret_move6", (self: EdictT): void => {
  Move_Calc(self, self.move_origin, fd_secret_done);
});

/** rogue/g_rogue_newfnc.cpp:96-104 `MOVEINFO_ENDFUNC(fd_secret_done)`. */
const fd_secret_done: MoveinfoEndfuncFn = RegisterMoveinfoEndfunc("fd_secret_done", (self: EdictT): void => {
  if (self.targetname === null || SpawnFlags_has(self.spawnflags, SPAWNFLAG_SEC_YES_SHOOT)) {
    self.health = 1;
    self.takedamage = true;
    self.die = fd_secret_killed;
  }
});

/** rogue/g_rogue_newfnc.cpp:106-110 `MOVEINFO_BLOCKED(secret_blocked)`. */
const secret_blocked: MoveinfoBlockedFn = RegisterMoveinfoBlocked("secret_blocked", (self: EdictT, other: EdictT): void => {
  if ((self.flags & EntFlagsT.FL_TEAMSLAVE) === 0n) {
    T_Damage(other, self, self, vec3_origin, other.s.origin, vec3_origin, self.dmg, 0, DamageflagsT.DAMAGE_NONE, mod(ModIdT.MOD_CRUSH));
  }
});

/** rogue/g_rogue_newfnc.cpp:112-134 `TOUCH(secret_touch)` -- prints messages. */
const secret_touch: TouchFn = RegisterTouch("secret_touch", (self: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.health <= 0) return;
  if (other.client === null) return;
  if (self.monsterinfo.attack_finished > level.time) return;

  self.monsterinfo.attack_finished = Gtime_add(level.time, Gtime_from_sec(2));

  if (self.message !== null) giLocCenterPrint(other, self.message);
});

/*QUAKED func_door_secret2 (0 .5 .8) ? open_once 1st_left 1st_down no_shoot always_shoot slide_right slide_forward
Basic secret door. Slides back, then to the left. Angle determines direction.

FLAGS:
open_once = not implemented yet
1st_left = 1st move is left/right of arrow
1st_down = 1st move is forwards/backwards
no_shoot = not implemented yet
always_shoot = even if targeted, keep shootable
reverse_left = the sideways move will be to right of arrow
reverse_back = the to/fro move will be forward

VALUES:
wait = # of seconds before coming back (5 default)
dmg  = damage to inflict when blocked (2 default)
*/
/** rogue/g_rogue_newfnc.cpp:154-229 `void SP_func_door_secret2(edict_t *ent)`. */
export function SP_func_door_secret2(ent: EdictT): void {
  G_SetMoveinfoSounds(ent, "doors/dr1_strt.wav", "doors/dr1_mid.wav", "doors/dr1_end.wav");

  if (!ent.dmg) ent.dmg = 2;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(ent.s.angles, forward, right, up);
  ent.move_origin = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
  ent.move_angles = vec3(ent.s.angles[0], ent.s.angles[1], ent.s.angles[2]);

  G_SetMovedir(ent.s.angles, ent.movedir);
  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_BSP;
  if (ent.model === null) throw new Error("SP_func_door_secret2: ent.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(ent, ent.model);

  let lrSize: number;
  let fbSize: number;

  if (ent.move_angles[1] === 0 || ent.move_angles[1] === 180) {
    lrSize = ent.size[1];
    fbSize = ent.size[0];
  } else if (ent.move_angles[1] === 90 || ent.move_angles[1] === 270) {
    lrSize = ent.size[0];
    fbSize = ent.size[1];
  } else {
    gi.Com_Print("Secret door not at 0,90,180,270!\n");
    G_FreeEdict(ent);
    return;
  }

  const fwd = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SEC_MOVE_FORWARD) ? vec3_muls(forward, fbSize) : vec3_muls(forward, fbSize * -1);
  const rgt = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SEC_MOVE_RIGHT) ? vec3_muls(right, lrSize) : vec3_muls(right, lrSize * -1);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SEC_1ST_DOWN)) {
    ent.moveinfo.start_origin = vec3_add(ent.s.origin, fwd);
    ent.moveinfo.end_origin = vec3_add(ent.moveinfo.start_origin, rgt);
  } else {
    ent.moveinfo.start_origin = vec3_add(ent.s.origin, rgt);
    ent.moveinfo.end_origin = vec3_add(ent.moveinfo.start_origin, fwd);
  }

  ent.touch = secret_touch;
  ent.moveinfo.blocked = secret_blocked;
  ent.use = fd_secret_use;
  ent.moveinfo.speed = 50;
  ent.moveinfo.accel = 50;
  ent.moveinfo.decel = 50;

  if (ent.targetname === null || SpawnFlags_has(ent.spawnflags, SPAWNFLAG_SEC_YES_SHOOT)) {
    ent.health = 1;
    ent.max_health = ent.health;
    ent.takedamage = true;
    ent.die = fd_secret_killed;
  }
  if (!ent.wait) ent.wait = 5; // 5 seconds before closing

  gi.linkentity(ent);
}

// =============================================================================
// func_force_wall
// =============================================================================

const SPAWNFLAG_FORCEWALL_START_ON: SpawnFlags = SpawnFlags_from(1);

/** rogue/g_rogue_newfnc.cpp:235-249 `THINK(force_wall_think)`. */
const force_wall_think: ThinkFn = RegisterThink("force_wall_think", (self: EdictT): void => {
  if (!self.wait) {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_FORCEWALL);
    gi.WritePosition(self.pos1);
    gi.WritePosition(self.pos2);
    gi.WriteByte(self.style);
    gi.multicast(self.offset, KexMulticastT.MULTICAST_PVS, false);
  }

  self.think = force_wall_think;
  self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
});

/** rogue/g_rogue_newfnc.cpp:251-270 `USE(force_wall_use)`. */
const force_wall_use: UseFn = RegisterUse("force_wall_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (!self.wait) {
    self.wait = 1;
    self.think = null;
    self.nextthink = GTIME_ZERO;
    self.solid = SolidT.SOLID_NOT;
    gi.linkentity(self);
  } else {
    self.wait = 0;
    self.think = force_wall_think;
    self.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
    self.solid = SolidT.SOLID_BSP;
    gi.linkentity(self);
    KillBox(self, false); // Is this appropriate?
  }
});

/*QUAKED func_force_wall (1 0 1) ? start_on
A vertical particle force wall. Turns on and solid when triggered.
If someone is in the force wall when it turns on, they're telefragged.

start_on - forcewall begins activated. triggering will turn it off.
style - color of particles to use.
	208: green, 240: red, 241: blue, 224: orange
*/
/** rogue/g_rogue_newfnc.cpp:280-325 `void SP_func_force_wall(edict_t *ent)`. */
export function SP_func_force_wall(ent: EdictT): void {
  if (ent.model === null) throw new Error("SP_func_force_wall: ent.model is null -- the C++ source dereferences it unconditionally here");
  gi.setmodel(ent, ent.model);

  ent.offset[0] = (ent.absmax[0] + ent.absmin[0]) / 2;
  ent.offset[1] = (ent.absmax[1] + ent.absmin[1]) / 2;
  ent.offset[2] = (ent.absmax[2] + ent.absmin[2]) / 2;

  ent.pos1[2] = ent.absmax[2];
  ent.pos2[2] = ent.absmax[2];
  if (ent.size[0] > ent.size[1]) {
    ent.pos1[0] = ent.absmin[0];
    ent.pos2[0] = ent.absmax[0];
    ent.pos1[1] = ent.offset[1];
    ent.pos2[1] = ent.offset[1];
  } else {
    ent.pos1[0] = ent.offset[0];
    ent.pos2[0] = ent.offset[0];
    ent.pos1[1] = ent.absmin[1];
    ent.pos2[1] = ent.absmax[1];
  }

  if (!ent.style) ent.style = 208;

  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.wait = 1;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_FORCEWALL_START_ON)) {
    ent.solid = SolidT.SOLID_BSP;
    ent.think = force_wall_think;
    ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
  } else {
    ent.solid = SolidT.SOLID_NOT;
  }

  ent.use = force_wall_use;

  ent.svflags = SvflagsT.SVF_NOCLIENT;

  gi.linkentity(ent);
}
