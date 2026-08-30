// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_rogue_newtarg.c -- additional target_ entities from the ROGUE mission
// pack (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/g_rogue_newtarg.cpp (324
// lines, C++17): `target_steam` (a particle-steam-jet effect, usually
// poked by a `func_timer`), `target_anger` (makes an entity a "good guy"
// and sics another entity on it), `target_killplayers` (kills every player
// and every visible-to-a-player damageable monster, coop-lives-aware via
// `level.deadly_kill_box`), `target_blacklight`/`target_orb` (two nearly
// identical pulsing decorative light props sharing one THINK function).
// Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// SPAWN-FUNCTION INVENTORY: 5 SP_* in the C++ source, 5 exported here
// ============================================================================
// `grep -c '^void SP_' g_rogue_newtarg.cpp` = 5: SP_target_steam,
// SP_target_anger, SP_target_killplayers, SP_target_blacklight,
// SP_target_orb.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `use_target_steam`'s C++ body keeps a `static int nextid` FUNCTION-LOCAL
//   static, persisting across every call for the lifetime of the process
//   (not per-entity, not reset per level) -- ported as a module-scope `let
//   nextid`, the direct TS equivalent of a C++ function-local `static`.
// - `target_steam_start`'s `self->wait` is read/written in TWO different
//   units across this function and `use_target_steam` (seconds when parsed
//   from the map, milliseconds internally after `target_steam_start`
//   multiplies it by 1000) -- ported exactly as-is, unit conversion bug
//   and all, per PORTING.md's bug-for-bug mandate.
// - `blacklight_think`'s `self->nextthink = level.time + FRAME_TIME_MS;`
//   uses the not-yet-a-real-global `FRAME_TIME_MS` -- worked around with a
//   local `frameTimeAsGtime()` reading `gi.frame_time_ms` per-call, this
//   port line's established substitute (see g_func.ts's/g_monster.ts's own
//   identical local copies, cited in their own headers).
// - `target_killplayers_use`'s C++ body iterates the raw `g_edicts` pointer
//   range (`ent < &g_edicts[globals.num_edicts]`) for the monster-kill pass
//   and a separate `1..game.maxclients` loop for both the per-monster PVS
//   check and the player-kill pass. Ported as plain indexed loops over
//   `g_edicts[0 .. globals.num_edicts)` and `g_edicts[1 .. maxclients]`
//   respectively, matching this port line's established idiom (see
//   g_utils.ts).

import { vec3, type Vec3 } from "../../shared/math";
import type { CvarT } from "../../shared/q_shared";
import { EffectsT, SvflagsT, ServerCommandT, KexTempEventT, KexMulticastT, CvarFlagsT } from "../../kexapi/game";
import { type EdictT, MonsterAiFlagsT, DamageflagsT, ModIdT } from "../g_local";
import { gi, g_edicts, globals, game, level } from "../g_main_globals";
import { Gtime_from_ms, type GTime } from "../gtime";
import { vec3_add, vec3_muls, vec3_sub, vec3_normalized } from "../q_vec3";
import { frandom } from "../q_std";
import { G_FindByString, G_FreeEdict, G_SetMovedir } from "../g_utils";
import { T_Damage } from "../g_combat";
import { FoundTarget } from "../g_ai";
import { RegisterThink, RegisterUse, type ThinkFn, type UseFn } from "../g_save_registry";

function frameTimeAsGtime(): GTime {
  return Gtime_from_ms(gi.frame_time_ms);
}

function deathmatchEnabled(): boolean {
  const c: CvarT | null = gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
  return c !== null && c.value !== 0;
}

// =============================================================================
// target_steam
// =============================================================================

/*QUAKED target_steam (1 0 0) (-8 -8 -8) (8 8 8)
Creates a steam effect (particles w/ velocity in a line).

  speed = velocity of particles (default 50)
  count = number of particles (default 32)
  sounds = color of particles (default 8 for steam)
	 the color range is from this color to this color + 6
  wait = seconds to run before stopping (overrides default
	 value derived from func_timer)

  best way to use this is to tie it to a func_timer that "pokes"
  it every second (or however long you set the wait time, above)

  note that the width of the base is proportional to the speed
  good colors to use:
  6-9 - varying whites (darker to brighter)
  224 - sparks
  176 - blue water
  80  - brown water
  208 - slime
  232 - blood
*/

// C++ function-local `static int nextid;` -- see file header. Module-scope
// per this port line's substitute for a C-style function-local static.
let target_steam_nextid = 0;

/** rogue/g_rogue_newtarg.cpp:31-85 `USE(use_target_steam)`. */
const use_target_steam: UseFn = RegisterUse("use_target_steam", (self: EdictT, other: EdictT | null, _activator: EdictT | null): void => {
  if (target_steam_nextid > 20000) target_steam_nextid = target_steam_nextid % 20000;

  target_steam_nextid++;

  // automagically set wait from func_timer unless they set it already, or
  // default to 1000 if not called by a func_timer (eek!)
  if (!self.wait) {
    self.wait = other !== null ? other.wait * 1000 : 1000;
  }

  let point: Vec3;

  if (self.enemy !== null) {
    point = vec3_muls(vec3_add(self.enemy.absmin, self.enemy.absmax), 0.5);
    self.movedir = vec3_normalized(vec3_sub(point, self.s.origin));
  }

  point = vec3_add(self.s.origin, vec3_muls(self.movedir, self.style * 0.5));

  if (self.wait > 100) {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_STEAM);
    gi.WriteShort(target_steam_nextid);
    gi.WriteByte(self.count);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(self.movedir);
    gi.WriteByte(self.sounds & 0xff);
    gi.WriteShort(self.style);
    gi.WriteLong(self.wait);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
  } else {
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_STEAM);
    gi.WriteShort(-1);
    gi.WriteByte(self.count);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(self.movedir);
    gi.WriteByte(self.sounds & 0xff);
    gi.WriteShort(self.style);
    gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);
  }
});

/** rogue/g_rogue_newtarg.cpp:87-121 `THINK(target_steam_start)`. */
const target_steam_start: ThinkFn = RegisterThink("target_steam_start", (self: EdictT): void => {
  self.use = use_target_steam;

  if (self.target !== null) {
    const ent = G_FindByString(null, "targetname", self.target);
    if (ent === null) gi.Com_Print(`${self.classname ?? "?"}: target ${self.target} not found\n`);
    self.enemy = ent;
  } else {
    G_SetMovedir(self.s.angles, self.movedir);
  }

  if (!self.count) self.count = 32;
  if (!self.style) self.style = 75;
  if (!self.sounds) self.sounds = 8;
  if (self.wait) self.wait *= 1000; // we want it in milliseconds, not seconds

  // paranoia is good
  self.sounds &= 0xff;
  self.count &= 0xff;

  self.svflags = SvflagsT.SVF_NOCLIENT;

  gi.linkentity(self);
});

/** rogue/g_rogue_newtarg.cpp:123-134 `void SP_target_steam(edict_t *self)`. */
export function SP_target_steam(self: EdictT): void {
  self.style = Math.trunc(self.speed);

  if (self.target !== null) {
    self.think = target_steam_start;
    self.nextthink = frameTimeAsGtime();
  } else {
    target_steam_start(self);
  }
}

// =============================================================================
// target_anger
// =============================================================================

/** rogue/g_rogue_newtarg.cpp:140-184 `USE(target_anger_use)`. */
const target_anger_use: UseFn = RegisterUse("target_anger_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  if (self.killtarget === null) {
    throw new Error("target_anger_use: self.killtarget is null (invariant violated -- SP_target_anger always sets this before wiring target_anger_use)");
  }
  const target = G_FindByString(null, "targetname", self.killtarget);

  if (target !== null && self.target !== null) {
    // Make whatever a "good guy" so the monster will try to kill it!
    if ((target.svflags & SvflagsT.SVF_MONSTER) === 0) {
      target.monsterinfo.aiflags |= MonsterAiFlagsT.AI_GOOD_GUY | MonsterAiFlagsT.AI_DO_NOT_COUNT;
      target.svflags |= SvflagsT.SVF_MONSTER;
      target.health = 300;
    }

    let t = G_FindByString(null, "targetname", self.target);
    while (t !== null) {
      if (t === self) {
        gi.Com_Print("WARNING: entity used itself.\n");
      } else if (t.use !== null) {
        if (t.health <= 0) return;

        t.enemy = target;
        t.monsterinfo.aiflags |= MonsterAiFlagsT.AI_TARGET_ANGER;
        FoundTarget(t);
      }

      if (!self.inuse) {
        gi.Com_Print("entity was removed while using targets\n");
        return;
      }

      t = G_FindByString(t, "targetname", self.target);
    }
  }
});

/*QUAKED target_anger (1 0 0) (-8 -8 -8) (8 8 8)
This trigger will cause an entity to be angry at another entity when a player touches it. Target the
entity you want to anger, and killtarget the entity you want it to be angry at.

target - entity to piss off
killtarget - entity to be pissed off at
*/
/** rogue/g_rogue_newtarg.cpp:193-210 `void SP_target_anger(edict_t *self)`. */
export function SP_target_anger(self: EdictT): void {
  if (self.target === null) {
    gi.Com_Print("target_anger without target!\n");
    G_FreeEdict(self);
    return;
  }
  if (self.killtarget === null) {
    gi.Com_Print("target_anger without killtarget!\n");
    G_FreeEdict(self);
    return;
  }

  self.use = target_anger_use;
  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// ***********************************
// target_killplayers
// ***********************************

/** rogue/g_rogue_newtarg.cpp:216-259 `USE(target_killplayers_use)`. Exported
 *  (2026-08-30 stale-comment sweep): g_xatrix_misc.ts's `misc_nuke` entity
 *  (`ent->use = target_killplayers_use;` in the real C++) used to carry a
 *  local throwing stub citing this exact function, unable to import it
 *  while it was unexported. */
export const target_killplayers_use: UseFn = RegisterUse("target_killplayers_use", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  level.deadly_kill_box = true;

  // kill any visible monsters
  for (let i = 0; i < globals.num_edicts; i++) {
    const ent = g_edicts[i];
    if (ent === undefined || !ent.inuse) continue;
    if (ent.health < 1) continue;
    if (!ent.takedamage) continue;

    for (let p = 1; p <= game.maxclients; p++) {
      const player = g_edicts[p];
      if (player === undefined || !player.inuse) continue;

      if (gi.inPVS(player.s.origin, ent.s.origin, false)) {
        T_Damage(ent, self, self, vec3(0, 0, 0), ent.s.origin, vec3(0, 0, 0), ent.health, 0, DamageflagsT.DAMAGE_NO_PROTECTION, { id: ModIdT.MOD_TELEFRAG, friendly_fire: false, no_point_loss: false });
        break;
      }
    }
  }

  // kill the players
  for (let p = 1; p <= game.maxclients; p++) {
    const player = g_edicts[p];
    if (player === undefined || !player.inuse) continue;

    // nail it
    T_Damage(player, self, self, vec3(0, 0, 0), self.s.origin, vec3(0, 0, 0), 100000, 0, DamageflagsT.DAMAGE_NO_PROTECTION, { id: ModIdT.MOD_TELEFRAG, friendly_fire: false, no_point_loss: false });
  }

  level.deadly_kill_box = false;
});

/*QUAKED target_killplayers (1 0 0) (-8 -8 -8) (8 8 8)
When triggered, this will kill all the players on the map.
*/
/** rogue/g_rogue_newtarg.cpp:264-268 `void SP_target_killplayers(edict_t *self)`. */
export function SP_target_killplayers(self: EdictT): void {
  self.use = target_killplayers_use;
  self.svflags = SvflagsT.SVF_NOCLIENT;
}

// =============================================================================
// target_blacklight / target_orb
// =============================================================================

/*QUAKED target_blacklight (1 0 1) (-16 -16 -24) (16 16 24)
Pulsing black light with sphere in the center
*/
/** rogue/g_rogue_newtarg.cpp:273-279 `THINK(blacklight_think)`. Shared,
 *  unmodified, by both `target_blacklight` and `target_orb`, matching the
 *  C++ source's own reuse. */
const blacklight_think: ThinkFn = RegisterThink("blacklight_think", (self: EdictT): void => {
  self.s.angles = vec3(self.s.angles[0] + frandom(10), self.s.angles[1] + frandom(10), self.s.angles[2] + frandom(10));
  self.nextthink = frameTimeAsGtime();
});

/** rogue/g_rogue_newtarg.cpp:281-299 `void SP_target_blacklight(edict_t *ent)`. */
export function SP_target_blacklight(ent: EdictT): void {
  if (deathmatchEnabled()) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.mins = vec3(0, 0, 0);
  ent.maxs = vec3(0, 0, 0);

  ent.s.effects |= EffectsT.EF_TRACKERTRAIL | EffectsT.EF_TRACKER;
  ent.think = blacklight_think;
  ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
  ent.s.scale = 6.0;
  ent.s.skinnum = 0;
  ent.nextthink = frameTimeAsGtime();
  gi.linkentity(ent);
}

/*QUAKED target_orb (1 0 1) (-16 -16 -24) (16 16 24)
Translucent pulsing orb with speckles
*/
/** rogue/g_rogue_newtarg.cpp:304-324 `void SP_target_orb(edict_t *ent)`. */
export function SP_target_orb(ent: EdictT): void {
  if (deathmatchEnabled()) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  ent.mins = vec3(0, 0, 0);
  ent.maxs = vec3(0, 0, 0);

  ent.think = blacklight_think;
  ent.nextthink = Gtime_from_ms(100);
  ent.s.skinnum = 1;
  ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
  ent.s.frame = 2;
  ent.s.scale = 8.0;
  ent.s.effects |= EffectsT.EF_SPHERETRANS;
  gi.linkentity(ent);
}
