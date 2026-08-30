// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_xatrix_misc.cpp -- xatrix (Ground Zero mission pack) misc_* entities:
// `misc_crashviper` (a large scripted viper on a path), `misc_viper_missile`
// (a scripted bombing-run projectile), `misc_transport` (Maxx's end-of-game
// transport ship), `misc_amb4` (a looping ambient-sound entity), and
// `misc_nuke` (a thin `use` alias onto the ROGUE mission pack's
// `target_killplayers_use`). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/xatrix/g_xatrix_misc.cpp (143
// lines, C++17). Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// STUB SWAP -- misc_viper_use / misc_strogg_ship_use / func_train_find now
// imported for real
// ============================================================================
// `misc_crashviper`/`misc_transport` reuse g_misc.ts's own already-real
// `misc_viper_use`/`misc_strogg_ship_use` USE handlers and g_func.ts's own
// already-real `func_train_find` THINK handler verbatim -- the C++ source
// itself does exactly this (`ent->use = misc_viper_use;` /
// `ent->use = misc_strogg_ship_use;`, both re-using the vanilla scripted-path
// train infrastructure). `misc_viper_use`/`misc_strogg_ship_use` were
// previously real but unexported in g_misc.ts; this unit adds `export` to
// both declarations (no behavior change -- see g_misc.ts's own header for
// the one-line diff) so they can be imported here.
//
// ============================================================================
// target_killplayers_use -- NOT ported (ROGUE mission-pack content, out of
// scope)
// ============================================================================
// `misc_nuke`'s entire body is `ent->use = target_killplayers_use;`, but
// `target_killplayers_use`'s only body anywhere in the source tree is
// rogue/g_rogue_newtarg.cpp:216 -- ROGUE (Ground Zero's sibling ADD-ON, not
// xatrix), genuinely out of THIS unit's scope, matching the exact same
// "declared/forward-referenced here, defined in a different mission pack's
// translation unit" shape as `blocked_checkjump`/`fire_flechette` elsewhere
// in this port line. Kept as a local, unexported, cited throwing stub;
// `SP_misc_nuke` itself is otherwise real (a one-line `use` assignment).

import { vec3 } from "../shared/math";
import { ATTN_NONE, SoundchanT, SolidT, SvflagsT, MonsterMuzzleflashIdT } from "../kexapi/game";
import { type EdictT, type ThinkFn, type UseFn, MovetypeT, SPAWNFLAG_TRAIN_START_ON } from "./g_local";
import { gi, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_sec } from "./gtime";
import { G_FreeEdict, G_FindByString } from "./g_utils";
import { vec3_sub, vec3_normalized } from "./q_vec3";
import { monster_fire_rocket } from "./g_monster";
import { func_train_find } from "./g_func";
import { misc_viper_use, misc_strogg_ship_use } from "./g_misc";
import { SpawnFlags_has, SpawnFlags_or } from "./spawnflags";
import { RegisterThink, RegisterUse } from "./g_save_registry";

function edictFmt(ent: EdictT): string {
  return `${ent.classname} @ (${ent.s.origin[0]} ${ent.s.origin[1]} ${ent.s.origin[2]})`;
}

// ---------------------------------------------------------------------------
// misc_crashviper (g_xatrix_misc.cpp:6-34)
// ---------------------------------------------------------------------------

/**
 * QUAKED misc_crashviper (1 .5 0) (-176 -120 -24) (176 120 72)
 * `void SP_misc_crashviper(edict_t *ent)` (g_xatrix_misc.cpp:9-34).
 */
export function SP_misc_crashviper(ent: EdictT): void {
  if (ent.target === null) {
    gi.Com_Print(`${edictFmt(ent)}: no target\n`);
    G_FreeEdict(ent);
    return;
  }

  if (!ent.speed) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/ships/bigviper/tris.md2");
  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
  ent.use = misc_viper_use;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = ent.speed;

  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// misc_viper_missile (g_xatrix_misc.cpp:36-79)
// ---------------------------------------------------------------------------

/** `USE(misc_viper_missile_use)` (g_xatrix_misc.cpp:41-61). */
const misc_viper_missile_use: UseFn = RegisterUse("misc_viper_missile_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.enemy = G_FindByString(null, "targetname", self.target ?? "");
  if (self.enemy === null) throw new Error(`misc_viper_missile_use: target "${self.target ?? "?"}" not found (invariant violated)`);

  const start = vec3(self.s.origin[0], self.s.origin[1], self.s.origin[2]);
  const dir = vec3_normalized(vec3_sub(self.enemy.s.origin, start));

  monster_fire_rocket(self, start, dir, self.dmg, 500, MonsterMuzzleflashIdT.MZ2_CHICK_ROCKET_1);

  self.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
  self.think = G_FreeEdict;
});

/**
 * QUAKED misc_viper_missile (1 0 0) (-8 -8 -8) (8 8 8)
 * `void SP_misc_viper_missile(edict_t *self)` (g_xatrix_misc.cpp:63-79).
 */
export function SP_misc_viper_missile(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.mins = vec3(-8, -8, -8);
  self.maxs = vec3(8, 8, 8);

  if (!self.dmg) self.dmg = 250;

  self.s.modelindex = gi.modelindex("models/objects/bomb/tris.md2");

  self.use = misc_viper_missile_use;
  self.svflags |= SvflagsT.SVF_NOCLIENT;

  gi.linkentity(self);
}

// ---------------------------------------------------------------------------
// misc_transport (g_xatrix_misc.cpp:81-116) -- "RAFAEL 17-APR-98"
// ---------------------------------------------------------------------------

/**
 * QUAKED misc_transport (1 0 0) (-8 -8 -8) (8 8 8)
 * `void SP_misc_transport(edict_t *ent)` (g_xatrix_misc.cpp:85-114).
 */
export function SP_misc_transport(ent: EdictT): void {
  if (ent.target === null) {
    gi.Com_Print(`${edictFmt(ent)}: no target\n`);
    G_FreeEdict(ent);
    return;
  }

  if (!ent.speed) ent.speed = 300;

  ent.movetype = MovetypeT.MOVETYPE_PUSH;
  ent.solid = SolidT.SOLID_NOT;
  ent.s.modelindex = gi.modelindex("models/objects/ship/tris.md2");

  ent.mins = vec3(-16, -16, 0);
  ent.maxs = vec3(16, 16, 32);

  ent.think = func_train_find;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(0.1));
  ent.use = misc_strogg_ship_use;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.moveinfo.accel = ent.moveinfo.decel = ent.moveinfo.speed = ent.speed;

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_TRAIN_START_ON)) {
    ent.spawnflags = SpawnFlags_or(ent.spawnflags, SPAWNFLAG_TRAIN_START_ON);
  }

  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// misc_amb4 (g_xatrix_misc.cpp:117-134) -- Mal's amb4 loop entity
// ---------------------------------------------------------------------------

/** `static cached_soundindex amb4sound;` -- module-level, matching
 *  g_trigger.ts's own `windsound` precedent for `cached_soundindex`. */
let amb4sound = 0;

/** `THINK(amb4_think)` (g_xatrix_misc.cpp:122-126). */
const amb4_think: ThinkFn = RegisterThink("amb4_think", (ent: EdictT): void => {
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(2.7));
  gi.sound(ent, SoundchanT.CHAN_VOICE, amb4sound, 1, ATTN_NONE, 0);
});

/**
 * QUAKED misc_amb4 (1 0 0) (-16 -16 -16) (16 16 16)
 * `void SP_misc_amb4(edict_t *ent)` (g_xatrix_misc.cpp:128-134).
 */
export function SP_misc_amb4(ent: EdictT): void {
  ent.think = amb4_think;
  ent.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
  amb4sound = gi.soundindex("world/amb4.wav");
  gi.linkentity(ent);
}

// ---------------------------------------------------------------------------
// misc_nuke (g_xatrix_misc.cpp:136-143) -- see file header
// ---------------------------------------------------------------------------

function target_killplayers_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  throw new Error(`target_killplayers_use: not yet ported (rogue mission pack, see rogue/g_rogue_newtarg.cpp:216) -- called against ${self.classname ?? "?"}`);
}

/**
 * QUAKED misc_nuke (1 0 0) (-16 -16 -16) (16 16 16)
 * `void SP_misc_nuke(edict_t *ent)` (g_xatrix_misc.cpp:140-143).
 */
export function SP_misc_nuke(ent: EdictT): void {
  ent.use = target_killplayers_use;
}
