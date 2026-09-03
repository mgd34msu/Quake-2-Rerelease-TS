// g_newtarg.c
//
// Pack-only targets: target_steam (particle steam jets, usually poked by a
// func_timer), target_anger (makes one monster hostile to another),
// target_killplayers, and the decorative target_blacklight / target_orb.

import { vec3, vec3_origin, VectorClear, VectorMA, VectorNormalize, VectorSet, VectorSubtract } from "../shared/math";
import {
  EF_SPHERETRANS,
  EF_TRACKER,
  EF_TRACKERTRAIL,
  MulticastT,
  RF_BEAM,
  RF_TRANSLUCENT,
  TempEventT,
} from "../shared/q_shared";
import { SolidT, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import {
  AI_GOOD_GUY,
  AI_TARGET_ANGER,
  type EdictT,
  DAMAGE_NO_PROTECTION,
  g_edicts,
  game,
  gameCvars,
  gi,
  globals,
  level,
  MOD_TELEFRAG,
  MovetypeT,
  svc_temp_entity,
} from "./g_local";
import { FoundTarget, visible } from "./g_ai";
import { T_Damage } from "./g_combat";
import { G_Find, G_FreeEdict, G_SetMovedir, vtos } from "./g_utils";
import { target_laser_think } from "./g_target";
import { registerSaveFunction } from "./g_save";

//==========================================================

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

// FIXME - this needs to be a global
let target_steam_nextid = 0;

export function use_target_steam(self: EdictT, other: EdictT | null, _activator: EdictT | null): void {
  const point = vec3();

  if (target_steam_nextid > 20000) target_steam_nextid = target_steam_nextid % 20000;

  target_steam_nextid++;

  // automagically set wait from func_timer unless they set it already, or
  // default to 1000 if not called by a func_timer (eek!)
  if (!self.wait) {
    if (other !== null) self.wait = other.wait * 1000;
    else self.wait = 1000;
  }

  if (self.enemy !== null) {
    VectorMA(self.enemy.absmin, 0.5, self.enemy.size, point);
    VectorSubtract(point, self.s.origin, self.movedir);
    VectorNormalize(self.movedir);
  }

  VectorMA(self.s.origin, self.plat2flags * 0.5, self.movedir, point);
  if (self.wait > 100) {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_STEAM);
    gi.WriteShort(target_steam_nextid);
    gi.WriteByte(self.count);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(self.movedir);
    gi.WriteByte(self.sounds & 0xff);
    gi.WriteShort(self.plat2flags);
    gi.WriteLong(self.wait);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  } else {
    gi.WriteByte(svc_temp_entity);
    gi.WriteByte(TempEventT.TE_STEAM);
    gi.WriteShort(-1);
    gi.WriteByte(self.count);
    gi.WritePosition(self.s.origin);
    gi.WriteDir(self.movedir);
    gi.WriteByte(self.sounds & 0xff);
    gi.WriteShort(self.plat2flags);
    gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);
  }
}

export function target_steam_start(self: EdictT): void {
  self.use = use_target_steam;

  if (self.target) {
    const ent = G_Find(null, "targetname", self.target);
    if (ent === null) {
      gi.dprintf(`${self.classname ?? ""} at ${vtos(self.s.origin)}: ${self.target} is a bad target\n`);
    }
    self.enemy = ent;
  } else {
    G_SetMovedir(self.s.angles, self.movedir);
  }

  if (!self.count) self.count = 32;
  if (!self.plat2flags) self.plat2flags = 75;
  if (!self.sounds) self.sounds = 8;
  if (self.wait) self.wait *= 1000; // we want it in milliseconds, not seconds

  // paranoia is good
  self.sounds &= 0xff;
  self.count &= 0xff;

  self.svflags = SVF_NOCLIENT;

  gi.linkentity(self);
}

export function SP_target_steam(self: EdictT): void {
  self.plat2flags = self.speed;

  if (self.target) {
    self.think = target_steam_start;
    self.nextthink = level.time + 1;
  } else {
    target_steam_start(self);
  }
}

//==========================================================
// target_anger
//==========================================================

export function target_anger_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  const target = G_Find(null, "targetname", self.killtarget ?? "");

  if (target !== null && self.target) {
    // Make whatever a "good guy" so the monster will try to kill it!
    target.monsterinfo.aiflags |= AI_GOOD_GUY;
    target.svflags |= SVF_MONSTER;
    target.health = 300;

    let t: EdictT | null = null;
    while ((t = G_Find(t, "targetname", self.target)) !== null) {
      if (t === self) {
        gi.dprintf("WARNING: entity used itself.\n");
      } else if (t.use) {
        if (t.health < 0) {
          // if ((g_showlogic) && (g_showlogic->value))
          //   gi.dprintf("target_anger with dead monster!\n");
          return;
        }
        t.enemy = target;
        t.monsterinfo.aiflags |= AI_TARGET_ANGER;
        FoundTarget(t);
      }
      if (!self.inuse) {
        gi.dprintf("entity was removed while using targets\n");
        return;
      }
    }
  }
}

/*QUAKED target_anger (1 0 0) (-8 -8 -8) (8 8 8)
This trigger will cause an entity to be angry at another entity when a player touches it. Target the
entity you want to anger, and killtarget the entity you want it to be angry at.

target - entity to piss off
killtarget - entity to be pissed off at
*/
export function SP_target_anger(self: EdictT): void {
  if (!self.target) {
    gi.dprintf("target_anger without target!\n");
    G_FreeEdict(self);
    return;
  }
  if (!self.killtarget) {
    gi.dprintf("target_anger without killtarget!\n");
    G_FreeEdict(self);
    return;
  }

  self.use = target_anger_use;
  self.svflags = SVF_NOCLIENT;
}

// ================
// target_spawn -- dead code in the C (wrapped in a block comment, never
// compiled: CreateMonster wasn't wired to a spawn function here). Not
// ported; see report.
// ================

// ***********************************
// target_killplayers
// ***********************************

export function target_killplayers_use(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  // kill the players
  for (let i = 0; i < game.maxclients; i++) {
    const player = g_edicts[1 + i];
    if (player === undefined || !player.inuse) continue;

    // nail it
    T_Damage(player, self, self, vec3_origin, self.s.origin, vec3_origin, 100000, 0, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);
  }

  // kill any visible monsters
  for (let idx = 0; idx < globals.num_edicts; idx++) {
    const ent = g_edicts[idx];
    if (ent === undefined) continue;
    if (!ent.inuse) continue;
    if (ent.health < 1) continue;
    if (!ent.takedamage) continue;

    for (let i = 0; i < game.maxclients; i++) {
      const player = g_edicts[1 + i];
      if (player === undefined || !player.inuse) continue;

      if (visible(player, ent)) {
        T_Damage(ent, self, self, vec3_origin, ent.s.origin, vec3_origin, ent.health, 0, DAMAGE_NO_PROTECTION, MOD_TELEFRAG);
        break;
      }
    }
  }
}

/*QUAKED target_killplayers (1 0 0) (-8 -8 -8) (8 8 8)
When triggered, this will kill all the players on the map.
*/
export function SP_target_killplayers(self: EdictT): void {
  self.use = target_killplayers_use;
  self.svflags = SVF_NOCLIENT;
}

/*QUAKED target_blacklight (1 0 1) (-16 -16 -24) (16 16 24)
Pulsing black light with sphere in the center
*/
export function blacklight_think(self: EdictT): void {
  self.s.angles[0] = Math.floor(Math.random() * 360);
  self.s.angles[1] = Math.floor(Math.random() * 360);
  self.s.angles[2] = Math.floor(Math.random() * 360);
  self.nextthink = level.time + 0.1;
}

export function SP_target_blacklight(ent: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  VectorClear(ent.mins);
  VectorClear(ent.maxs);

  ent.s.effects |= EF_TRACKERTRAIL | EF_TRACKER;
  ent.think = blacklight_think;
  ent.s.modelindex = gi.modelindex("models/items/spawngro2/tris.md2");
  ent.s.frame = 1;
  ent.nextthink = level.time + 0.1;
  gi.linkentity(ent);
}

/*QUAKED target_orb (1 0 1) (-16 -16 -24) (16 16 24)
Translucent pulsing orb with speckles
*/
export function orb_think(self: EdictT): void {
  self.s.angles[0] = Math.floor(Math.random() * 360);
  self.s.angles[1] = Math.floor(Math.random() * 360);
  self.s.angles[2] = Math.floor(Math.random() * 360);
  // self.s.effects |= (EF_TRACKERTRAIL|EF_DOUBLE);
  self.nextthink = level.time + 0.1;
}

export function SP_target_orb(ent: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value) {
    // auto-remove for deathmatch
    G_FreeEdict(ent);
    return;
  }

  VectorClear(ent.mins);
  VectorClear(ent.maxs);

  // ent.s.effects |= EF_TRACKERTRAIL;
  ent.think = orb_think;
  ent.nextthink = level.time + 0.1;
  ent.s.modelindex = gi.modelindex("models/items/spawngro2/tris.md2");
  ent.s.frame = 2;
  ent.s.effects |= EF_SPHERETRANS;
  gi.linkentity(ent);
}


// =====================================================================
// RE-RELEASE CONTENT PORT -- xatrix's target_mal_laser, copied verbatim
// (comments included) from our sibling src/game/g_newtarg.ts. Placed by
// xship, one of the maps this module now hosts; no 1998-era Ground Zero map
// names the classname, so it is inert for existing content.
// =====================================================================

//==========================================================
// target_mal_laser -- src/xatrix/g_target.ts's "RAFAEL 15-APR-98" delta.
// Reuses vanilla's own target_laser_think (src/game/g_target.ts) instead
// of duplicating it -- the xatrix source does the same (mal_laser_think
// calls the file-local target_laser_think directly).
//==========================================================

/*QUAKED target_mal_laser (1 0 0) (-4 -4 -4) (4 4 4) START_ON RED GREEN BLUE YELLOW ORANGE FAT
Mal's laser
*/
export function target_mal_laser_on(self: EdictT): void {
  if (self.activator === null) self.activator = self;
  self.spawnflags |= 0x80000001;
  self.svflags &= ~SVF_NOCLIENT;
  // target_laser_think (self);
  self.nextthink = level.time + self.wait + self.delay;
}

export function target_mal_laser_off(self: EdictT): void {
  self.spawnflags &= ~1;
  self.svflags |= SVF_NOCLIENT;
  self.nextthink = 0;
}

export function target_mal_laser_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  self.activator = activator;
  if (self.spawnflags & 1) target_mal_laser_off(self);
  else target_mal_laser_on(self);
}

export function mal_laser_think(self: EdictT): void {
  target_laser_think(self);
  self.nextthink = level.time + self.wait + 0.1;
  self.spawnflags |= 0x80000000;
}

export function SP_target_mal_laser(self: EdictT): void {
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.solid = SolidT.SOLID_NOT;
  self.s.renderfx |= RF_BEAM | RF_TRANSLUCENT;
  self.s.modelindex = 1; // must be non-zero

  // set the beam diameter
  if (self.spawnflags & 64) self.s.frame = 16;
  else self.s.frame = 4;

  // set the color
  if (self.spawnflags & 2) self.s.skinnum = 0xf2f2f0f0;
  else if (self.spawnflags & 4) self.s.skinnum = 0xd0d1d2d3;
  else if (self.spawnflags & 8) self.s.skinnum = 0xf3f3f1f1;
  else if (self.spawnflags & 16) self.s.skinnum = 0xdcdddedf;
  else if (self.spawnflags & 32) self.s.skinnum = 0xe0e1e2e3;

  G_SetMovedir(self.s.angles, self.movedir);

  if (!self.delay) self.delay = 0.1;

  if (!self.wait) self.wait = 0.1;

  if (!self.dmg) self.dmg = 5;

  VectorSet(self.mins, -8, -8, -8);
  VectorSet(self.maxs, 8, 8, 8);

  self.nextthink = level.time + self.delay;
  self.think = mal_laser_think;

  self.use = target_mal_laser_use;

  gi.linkentity(self);

  if (self.spawnflags & 1) target_mal_laser_on(self);
  else target_mal_laser_off(self);
}


// -------------------------------------------------------------------------
// Savegame function registry -- see g_save.ts's registerSaveFunction.
// -------------------------------------------------------------------------
registerSaveFunction("g_newtarg:target_mal_laser_on", target_mal_laser_on);
registerSaveFunction("g_newtarg:target_mal_laser_off", target_mal_laser_off);
registerSaveFunction("g_newtarg:target_mal_laser_use", target_mal_laser_use);
registerSaveFunction("g_newtarg:mal_laser_think", mal_laser_think);
