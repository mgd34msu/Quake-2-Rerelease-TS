// Mission-pack misc_*/info_*/hint_path world entities that don't have a
// more specific owned file in this port effort. Sources, per entity:
//   - misc_nuke_core          <- src/rogue/g_misc.ts
//   - hint_path (SP_hint_path only -- the *AI* helpers stay in g_newai.ts,
//     owned by another unit) <- src/rogue/g_newai.ts
//   - info_player_coop_lava   <- src/rogue/p_client.ts (p_client.ts itself
//     is owned by another unit in this port effort, so the spawn function
//     lives here instead -- see the port report)
//   - misc_amb4, misc_nuke, misc_transport, misc_viper_missile
//                             <- src/xatrix/g_misc.ts
//
// Faithful, line-by-line ports; deviations are called out inline.

import { AngleVectors, vec3, vec3_origin, VectorCopy, VectorNormalize, VectorSet, VectorSubtract } from "../shared/math";
import { ATTN_NONE, CHAN_VOICE, type CvarT, MZ2_CHICK_ROCKET_1 } from "../shared/q_shared";
import { SolidT, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  type EdictT,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  globals,
  level,
  MOD_TRAP,
  MovetypeT,
} from "./g_local";
import { T_Damage } from "./g_combat";
import { func_train_find, train_use } from "./g_func";
import { hint_path_touch } from "./g_newai";
import { monster_fire_rocket } from "./g_monster";
import { G_Find, G_FreeEdict, vtos } from "./g_utils";
import { registerSaveFunction } from "./g_save";

function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

//==========================================================
// misc_nuke_core -- src/rogue/g_misc.ts
//==========================================================

function misc_nuke_core_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  if (self.svflags & SVF_NOCLIENT) self.svflags &= ~SVF_NOCLIENT;
  else self.svflags |= SVF_NOCLIENT;
}

/*QUAKED misc_nuke_core (1 0 0) (-16 -16 -16) (16 16 16)
toggles visible/not visible. starts visible.
*/
export function SP_misc_nuke_core(ent: EdictT): void {
  gi.setmodel(ent, "models/objects/core/tris.md2");
  gi.linkentity(ent);

  ent.use = misc_nuke_core_use;
}

//==========================================================
// hint_path (spawn only) -- src/rogue/g_newai.ts
//
// `hint_path_touch` and the rest of the hint-chain machinery (hint chain
// bookkeeping, InitHintPaths, FindHintPath, etc.) belong to g_newai.ts,
// owned by another unit in this port effort. This spawn function is
// imported there by name; if g_newai.ts is not present yet when this file
// is compiled, that import will not resolve -- expected until that unit
// lands its file (see the port report).
//==========================================================

/*QUAKED hint_path (1 0 1) (-8 -8 -8) (8 8 8) END
Target: next hint path
Target_name: previous hint path
health: 1 way path flag
*/
export function SP_hint_path(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    G_FreeEdict(self);
    return;
  }

  if (!self.targetname && !self.target) {
    gi.dprintf(`unlinked hint_path at ${vtos(self.s.origin)}\n`);
    G_FreeEdict(self);
    return;
  }

  self.solid = SolidT.SOLID_TRIGGER;
  self.touch = hint_path_touch;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);
  self.svflags |= SVF_NOCLIENT;
  gi.linkentity(self);
}

//==========================================================
// info_player_coop_lava (spawn only) -- src/rogue/p_client.ts
//
// The rest of the rmine2 lava-level-check logic that reads this classname
// (a coop respawn-point search in PlayerDeathThink) belongs to
// p_client.ts, owned by another unit -- see the port report.
//==========================================================

/*QUAKED info_player_coop_lava (1 0 1) (-16 -16 -24) (16 16 32)
potential spawning position for coop games on rmine2 where lava level
needs to be checked
*/
export function SP_info_player_coop_lava(self: EdictT): void {
  if (cvarNum(gameCvars.coop) === 0) {
    G_FreeEdict(self);
    return;
  }
}

//==========================================================
// misc_amb4 -- src/xatrix/g_misc.ts
//==========================================================

/*QUAKED misc_amb4 (1 0 0) (-16 -16 -16) (16 16 16)
Mal's amb4 loop entity
*/
// C: `static int amb4sound;` -- file-scope global shared across every
// misc_amb4 instance in the level (re-resolved by each spawn), not a
// per-entity field. Kept as a module-private `let` to match.
let amb4sound = 0;

function amb4_think(ent: EdictT): void {
  ent.nextthink = level.time + 2.7;
  gi.sound(ent, CHAN_VOICE, amb4sound, 1, ATTN_NONE, 0);
}

export function SP_misc_amb4(ent: EdictT): void {
  ent.think = amb4_think;
  ent.nextthink = level.time + 1;
  amb4sound = gi.soundindex("world/amb4.wav");
  gi.linkentity(ent);
}

//==========================================================
// misc_nuke -- src/xatrix/g_misc.ts
//==========================================================

/*QUAKED misc_nuke (1 0 0) (-16 -16 -16) (16 16 16)
*/

function use_nuke(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  for (let i = 0; i < globals.num_edicts; i++) {
    const from = g_edicts[i];
    if (from === undefined || from === self) continue;
    if (from.client !== null) {
      T_Damage(from, self, self, vec3_origin, from.s.origin, vec3_origin, 100000, 1, 0, MOD_TRAP);
    } else if (from.svflags & SVF_MONSTER) {
      G_FreeEdict(from);
    }
  }

  self.use = null;
}

export function SP_misc_nuke(ent: EdictT): void {
  ent.use = use_nuke;
}

//==========================================================
// misc_transport -- src/xatrix/g_misc.ts ("RAFAEL 17-APR-98")
//
// Reuses the same `misc_strogg_ship_use` two-liner misc_strogg_ship spawns
// with in vanilla's own g_misc.ts (owned by another unit, not exported
// there) -- duplicated here rather than imported, matching the C source
// (both misc_strogg_ship and misc_transport's spawn functions assign the
// same file-local `misc_strogg_ship_use` in xatrix/g_misc.c).
//==========================================================

function misc_transport_ship_use(self: EdictT, other: EdictT | null, activator: EdictT | null): void {
  self.svflags &= ~SVF_NOCLIENT;
  self.use = train_use;
  train_use(self, other, activator);
}

/*QUAKED misc_transport (1 0 0) (-8 -8 -8) (8 8 8) TRIGGER_SPAWN
Maxx's transport at end of game
*/
export function SP_misc_transport(ent: EdictT): void {
  if (!ent.target) {
    gi.dprintf(`${ent.classname} without a target at ${vtos(ent.absmin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  if (!ent.speed) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/objects/ship/tris.md2");

  VectorSet(ent.mins, -16, -16, 0);
  VectorSet(ent.maxs, 16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = level.time + FRAMETIME;
  ent.use = misc_transport_ship_use;
  ent.svflags |= SVF_NOCLIENT;
  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = ent.speed;

  if (!(ent.spawnflags & 1)) {
    ent.spawnflags |= 1;
  }

  gi.linkentity(ent);
}
// END 17-APR-98

//==========================================================
// misc_viper_missile -- src/xatrix/g_misc.ts
//==========================================================

// RAFAEL
/*QUAKED misc_viper_missile (1 0 0) (-8 -8 -8) (8 8 8)
"dmg"	how much boom should the bomb make? the default value is 250
*/

function misc_viper_missile_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(self.s.angles, forward, right, up);

  self.enemy = self.target !== null ? G_Find(null, "targetname", self.target) : null;

  // C dereferences self->enemy unconditionally right after G_Find with no
  // NULL check -- a real latent crash in the original if the targeted
  // entity is missing. Deviation: guarded with a dprintf-and-return instead
  // of crashing, matching the missing-destination guards used elsewhere in
  // this port (e.g. g_newtrig.ts's trigger_teleport_touch).
  if (self.enemy === null) {
    gi.dprintf(`misc_viper_missile_use: target "${self.target ?? ""}" not found\n`);
    return;
  }

  const vec = vec3();
  VectorCopy(self.enemy.s.origin, vec);
  // C: `vec[2] + 16;` -- a no-op statement (missing `=`), preserved
  // bug-for-bug: vec is not actually raised.

  const start = vec3();
  VectorCopy(self.s.origin, start);
  const dir = vec3();
  VectorSubtract(vec, start, dir);
  VectorNormalize(dir);

  monster_fire_rocket(self, start, dir, self.dmg, 500, MZ2_CHICK_ROCKET_1);

  self.nextthink = level.time + 0.1;
  self.think = G_FreeEdict;
}

export function SP_misc_viper_missile(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);

  if (!self.dmg) self.dmg = 250;

  self.s.modelindex = gi.modelindex("models/objects/bomb/tris.md2");

  self.use = misc_viper_missile_use;
  self.svflags |= SVF_NOCLIENT;

  gi.linkentity(self);
}

// -------------------------------------------------------------------------
// Savegame function registry -- see g_save.ts's registerSaveFunction.
// -------------------------------------------------------------------------
registerSaveFunction("g_newmisc:misc_nuke_core_use", misc_nuke_core_use);
registerSaveFunction("g_newmisc:amb4_think", amb4_think);
registerSaveFunction("g_newmisc:use_nuke", use_nuke);
registerSaveFunction("g_newmisc:misc_transport_ship_use", misc_transport_ship_use);
registerSaveFunction("g_newmisc:misc_viper_missile_use", misc_viper_missile_use);
