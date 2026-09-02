/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from game/g_monster.c (GNU GPL v2 or later).
*/
// g_monster.c
//
// rogue/g_monster.c vs baseq2/g_monster.c: three new monster-weapon muzzle
// wrappers (monster_fire_blaster2/monster_fire_tracker/monster_fire_heat,
// calling fire_blaster2/fire_tracker/fire_heat from g_newweap.c), a "don't
// fire into a solid wall" guard on monster_fire_railgun, M_FliesOff/M_FliesOn
// and M_WorldEffects become exported (no longer file-private -- the pack's
// medic-commander code and rogue/g_misc.c call them directly), M_CheckGround/
// M_droptofloor gain ROGUE_GRAVITY branches that project along
// `ent.gravityVector` instead of assuming down-is-Z (ROGUE_GRAVITY is
// unconditionally on in the shipped rogue binary, per g_local.ts's
// ROGUE_GRAVITY export -- and since every edict's gravityVector defaults to
// (0,0,-1), these branches are byte-identical to the base game for every
// entity that never customizes it), M_SetEffects gains EF_QUAD/EF_DOUBLE/
// EF_PENT powerup-shell tracking (monsterinfo.quad_framenum/double_framenum/
// invincible_framenum, all zero-initialized so this is a no-op for monsters
// that never set them), monster_use/monster_triggered_spawn gain an
// FL_DISGUISED guard (disguised players/monsters don't trip FoundTarget --
// the flag is never set on a classic entity), monster_start exempts
// AI_DO_NOT_COUNT monsters from the total_monsters counter (used by the
// pack's runtime-spawned helper monsters, see CreateMonster below) and
// additionally resets monsterinfo.base_height/quad_framenum/double_framenum/
// invincible_framenum, walkmonster_start_go special-cases monster_stalker's
// shorter viewheight, and the file gains a stationarymonster_* family
// (turret-only spawn path, mirroring monster_triggered_spawn/_start but
// without the walk-move-in-solid check turrets don't need) plus
// monster_done_dodge (clears AI_DODGING once a dodge move completes).
//
// Also carries CreateMonster/CreateFlyMonster/CreateGroundMonster/
// FindSpawnPoint/CheckSpawnPoint/CheckGroundSpawnPoint/DetermineBBox/
// SpawnGrow_Spawn and cleanupHealTarget. In rogue these live in g_spawn.c and
// g_combat.c respectively, but src/game/g_spawn.ts and src/game/g_combat.ts
// are outside this round's edit ownership (the coordinator wires the spawn
// table in g_spawn.ts in one pass at the end, and g_combat.ts belongs to
// another round); they're hosted here instead since g_monster.ts already
// owns this file's cross-monster "spawn a monster, walk/fly it into place"
// utility role. See this file's final port report for the two g_combat.c
// (Killed()) call sites that still need cleanupHealTarget wired in by
// whoever owns g_combat.ts.

import { type Vec3, vec3, vec3_origin, VectorAdd, VectorCompare, VectorCopy, VectorSet, VectorSubtract } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_BODY,
  CONTENTS_LAVA,
  CONTENTS_PLAYERCLIP,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  EF_COLOR_SHELL,
  EF_DOUBLE,
  EF_FLIES,
  EF_PENT,
  EF_POWERSCREEN,
  EF_QUAD,
  EF_SPHERETRANS,
  MASK_MONSTERSOLID,
  MASK_SOLID,
  MASK_WATER,
  MulticastT,
  RF_FRAMELERP,
  RF_IR_VISIBLE,
  RF_SHELL_BLUE,
  RF_SHELL_DOUBLE,
  RF_SHELL_GREEN,
  RF_SHELL_RED,
  YAW,
} from "../shared/q_shared";
import { T_Damage } from "./g_combat";
import { FoundTarget, M_CheckAttack } from "./g_ai";
import {
  AI_DODGING,
  AI_DO_NOT_COUNT,
  AI_GOOD_GUY,
  AI_HOLD_FRAME,
  AI_RESURRECTING,
  DamageT,
  DAMAGE_NO_ARMOR,
  DEAD_NO,
  type EdictT,
  FL_DISGUISED,
  FL_FLY,
  FL_IMMUNE_LAVA,
  FL_IMMUNE_SLIME,
  FL_INWATER,
  FL_NOTARGET,
  FL_SWIM,
  FRAMETIME,
  g_edicts,
  gameCvars,
  gi,
  level,
  MOD_LAVA,
  MOD_SLIME,
  MOD_UNKNOWN,
  MOD_WATER,
  MovetypeT,
  POWER_ARMOR_SCREEN,
  POWER_ARMOR_SHIELD,
  st,
  svc_muzzleflash2,
  world,
} from "./g_local";
import { type Edict, SolidT, SVF_DEADMONSTER, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import { fire_bfg, fire_blaster, fire_bullet, fire_grenade, fire_rail, fire_rocket, fire_shotgun } from "./g_weapon";
import { fire_blaster2, fire_heat, fire_tracker } from "./g_newweap";
import { FindItemByClassname } from "./g_items";
import { Drop_Item } from "./g_items";
import { G_Find, G_FreeEdict, G_PickTarget, G_Spawn, G_UseTargets, KillBox, vectoyaw, vtos, type EdictStringKey } from "./g_utils";
import { ED_CallSpawn, ED_NewString } from "./g_spawn";
import { M_walkmove } from "./m_move";

// trace_t.ent recovery idiom (see g_phys.ts's traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way.
function traceEdict(ent: Edict | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// `gameCvars.*` are read as bare `.value` throughout; a per-file local
// mirrors g_items.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

//
// monster weapons
//

// FIXME mosnters should call these with a totally accurate direction
// and we can mess it up based on skill.  Spread should be for normal
// and we can tighten or loosen based on skill.  We could muck with
// the damages too, but I'm not sure that's such a good idea.
export function monster_fire_bullet(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  flashtype: number,
): void {
  fire_bullet(self, start, dir, damage, kick, hspread, vspread, MOD_UNKNOWN);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_shotgun(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  hspread: number,
  vspread: number,
  count: number,
  flashtype: number,
): void {
  fire_shotgun(self, start, aimdir, damage, kick, hspread, vspread, count, MOD_UNKNOWN);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_blaster(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
  effect: number,
): void {
  fire_blaster(self, start, dir, damage, speed, effect, false);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

// ROGUE
export function monster_fire_blaster2(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
  effect: number,
): void {
  fire_blaster2(self, start, dir, damage, speed, effect, false);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

// FIXME -- add muzzle flash
export function monster_fire_tracker(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  // rogue/m_widow2.c passes NULL here for its long-range disruptor shot
  // (m_widow2.c's WidowDisruptorTrack else-branch), so this stays nullable
  // to match fire_tracker's (g_newweap.c) own `edict_t *enemy` parameter.
  enemy: EdictT | null,
  flashtype: number,
): void {
  fire_tracker(self, start, dir, damage, speed, enemy);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_heat(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  offset: Vec3,
  damage: number,
  kick: number,
  flashtype: number,
): void {
  fire_heat(self, start, dir, offset, damage, kick, true);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}
// ROGUE

export function monster_fire_grenade(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
): void {
  fire_grenade(self, start, aimdir, damage, speed, 2.5, damage + 40);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_rocket(
  self: EdictT,
  start: Vec3,
  dir: Vec3,
  damage: number,
  speed: number,
  flashtype: number,
): void {
  fire_rocket(self, start, dir, damage, speed, damage + 20, damage);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_railgun(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  kick: number,
  flashtype: number,
): void {
  // PMM -- don't fire into a solid wall
  if (!(gi.pointcontents(start) & MASK_SOLID)) fire_rail(self, start, aimdir, damage, kick);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

export function monster_fire_bfg(
  self: EdictT,
  start: Vec3,
  aimdir: Vec3,
  damage: number,
  speed: number,
  kick: number,
  damage_radius: number,
  flashtype: number,
): void {
  fire_bfg(self, start, aimdir, damage, speed, damage_radius);

  gi.WriteByte(svc_muzzleflash2);
  gi.WriteShort(g_edicts.indexOf(self));
  gi.WriteByte(flashtype);
  gi.multicast(start, MulticastT.MULTICAST_PVS);
}

//
// Monster utility functions
//

// rogue/g_monster.c drops `static` here -- the medic-commander code (which
// this round also ports) calls these directly.
export function M_FliesOff(self: EdictT): void {
  self.s.effects &= ~EF_FLIES;
  self.s.sound = 0;
}

export function M_FliesOn(self: EdictT): void {
  if (self.waterlevel) return;
  self.s.effects |= EF_FLIES;
  self.s.sound = gi.soundindex("infantry/inflies1.wav");
  self.think = M_FliesOff;
  self.nextthink = level.time + 60;
}

export function M_FlyCheck(self: EdictT): void {
  if (self.waterlevel) return;

  if (Math.random() > 0.5) return;

  self.think = M_FliesOn;
  self.nextthink = level.time + 5 + 10 * Math.random();
}

export function AttackFinished(self: EdictT, time: number): void {
  self.monsterinfo.attack_finished = level.time + time;
}

export function M_CheckGround(ent: EdictT): void {
  if (ent.flags & (FL_SWIM | FL_FLY)) return;

  // ROGUE_GRAVITY is unconditionally defined in the shipped rogue binary
  // (see g_local.ts's ROGUE_GRAVITY export), so these branches always take
  // the gravityVector-relative path instead of the base game's Z-only check.
  // Every edict's gravityVector defaults to (0,0,-1) (G_InitEdict/ED_CallSpawn
  // reset it there), so this is byte-identical to the base game unless
  // something customizes gravityVector.
  if (ent.velocity[2] * ent.gravityVector[2] < -100) {
    // PGM
    ent.groundentity = null;
    return;
  }

  // if the hull point one-quarter unit down is solid the entity is on ground
  const point = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + 0.25 * ent.gravityVector[2]); // PGM

  const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, point, ent, MASK_MONSTERSOLID);

  // check steepness
  // PGM
  if (ent.gravityVector[2] < 0) {
    // normal gravity
    if (trace.plane.normal[2] < 0.7 && !trace.startsolid) {
      ent.groundentity = null;
      return;
    }
  } else {
    // inverted gravity
    if (trace.plane.normal[2] > -0.7 && !trace.startsolid) {
      ent.groundentity = null;
      return;
    }
  }
  // PGM

  // 	ent->groundentity = trace.ent;
  // 	ent->groundentity_linkcount = trace.ent->linkcount;
  // 	if (!trace.startsolid && !trace.allsolid)
  // 		VectorCopy (trace.endpos, ent->s.origin);
  if (!trace.startsolid && !trace.allsolid) {
    VectorCopy(trace.endpos, ent.s.origin);
    const groundEnt = traceEdict(trace.ent);
    ent.groundentity = groundEnt;
    ent.groundentity_linkcount = groundEnt.linkcount;
    ent.velocity[2] = 0;
  }
}

export function M_CatagorizePosition(ent: EdictT): void {
  //
  // get waterlevel
  //
  const point = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.mins[2] + 1);
  let cont = gi.pointcontents(point);

  if (!(cont & MASK_WATER)) {
    ent.waterlevel = 0;
    ent.watertype = 0;
    return;
  }

  ent.watertype = cont;
  ent.waterlevel = 1;
  point[2] += 26;
  cont = gi.pointcontents(point);
  if (!(cont & MASK_WATER)) return;

  ent.waterlevel = 2;
  point[2] += 22;
  cont = gi.pointcontents(point);
  if (cont & MASK_WATER) ent.waterlevel = 3;
}

// rogue's g_misc.c calls this directly (`extern void M_WorldEffects`);
// exported (no longer file-private) so it stays callable from outside this
// file, matching rogue/g_monster.c's linkage.
export function M_WorldEffects(ent: EdictT): void {
  if (ent.health > 0) {
    if (!(ent.flags & FL_SWIM)) {
      if (ent.waterlevel < 3) {
        ent.air_finished = level.time + 12;
      } else if (ent.air_finished < level.time) {
        // drown!
        if (ent.pain_debounce_time < level.time) {
          let dmg = 2 + 2 * Math.floor(level.time - ent.air_finished);
          if (dmg > 15) dmg = 15;
          T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, dmg, 0, DAMAGE_NO_ARMOR, MOD_WATER);
          ent.pain_debounce_time = level.time + 1;
        }
      }
    } else {
      if (ent.waterlevel > 0) {
        ent.air_finished = level.time + 9;
      } else if (ent.air_finished < level.time) {
        // suffocate!
        if (ent.pain_debounce_time < level.time) {
          let dmg = 2 + 2 * Math.floor(level.time - ent.air_finished);
          if (dmg > 15) dmg = 15;
          T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, dmg, 0, DAMAGE_NO_ARMOR, MOD_WATER);
          ent.pain_debounce_time = level.time + 1;
        }
      }
    }
  }

  if (ent.waterlevel === 0) {
    if (ent.flags & FL_INWATER) {
      gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_out.wav"), 1, ATTN_NORM, 0);
      ent.flags &= ~FL_INWATER;
    }
    return;
  }

  if (ent.watertype & CONTENTS_LAVA && !(ent.flags & FL_IMMUNE_LAVA)) {
    if (ent.damage_debounce_time < level.time) {
      ent.damage_debounce_time = level.time + 0.2;
      T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, 10 * ent.waterlevel, 0, 0, MOD_LAVA);
    }
  }
  if (ent.watertype & CONTENTS_SLIME && !(ent.flags & FL_IMMUNE_SLIME)) {
    if (ent.damage_debounce_time < level.time) {
      ent.damage_debounce_time = level.time + 1;
      T_Damage(ent, world(), world(), vec3_origin, ent.s.origin, vec3_origin, 4 * ent.waterlevel, 0, 0, MOD_SLIME);
    }
  }

  if (!(ent.flags & FL_INWATER)) {
    if (!(ent.svflags & SVF_DEADMONSTER)) {
      if (ent.watertype & CONTENTS_LAVA) {
        if (Math.random() <= 0.5) gi.sound(ent, CHAN_BODY, gi.soundindex("player/lava1.wav"), 1, ATTN_NORM, 0);
        else gi.sound(ent, CHAN_BODY, gi.soundindex("player/lava2.wav"), 1, ATTN_NORM, 0);
      } else if (ent.watertype & CONTENTS_SLIME) {
        gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
      } else if (ent.watertype & CONTENTS_WATER) {
        gi.sound(ent, CHAN_BODY, gi.soundindex("player/watr_in.wav"), 1, ATTN_NORM, 0);
      }
    }

    ent.flags |= FL_INWATER;
    ent.damage_debounce_time = 0;
  }
}

export function M_droptofloor(ent: EdictT): void {
  const end = vec3();

  // PGM -- ROGUE_GRAVITY (unconditionally on): drop along gravityVector's
  // direction instead of assuming down-is-Z. Byte-identical to the base
  // game for the default (0,0,-1) gravityVector.
  if (ent.gravityVector[2] < 0) {
    ent.s.origin[2] += 1;
    VectorCopy(ent.s.origin, end);
    end[2] -= 256;
  } else {
    ent.s.origin[2] -= 1;
    VectorCopy(ent.s.origin, end);
    end[2] += 256;
  }
  // PGM

  const trace = gi.trace(ent.s.origin, ent.mins, ent.maxs, end, ent, MASK_MONSTERSOLID);

  if (trace.fraction === 1 || trace.allsolid) return;

  VectorCopy(trace.endpos, ent.s.origin);

  gi.linkentity(ent);
  M_CheckGround(ent);
  M_CatagorizePosition(ent);
}

export function M_SetEffects(ent: EdictT): void {
  ent.s.effects &= ~(EF_COLOR_SHELL | EF_POWERSCREEN | EF_DOUBLE | EF_QUAD | EF_PENT);
  ent.s.renderfx &= ~(RF_SHELL_RED | RF_SHELL_GREEN | RF_SHELL_BLUE | RF_SHELL_DOUBLE);

  if (ent.monsterinfo.aiflags & AI_RESURRECTING) {
    ent.s.effects |= EF_COLOR_SHELL;
    ent.s.renderfx |= RF_SHELL_RED;
  }

  if (ent.health <= 0) return;

  if (ent.powerarmor_time > level.time) {
    if (ent.monsterinfo.power_armor_type === POWER_ARMOR_SCREEN) {
      ent.s.effects |= EF_POWERSCREEN;
    } else if (ent.monsterinfo.power_armor_type === POWER_ARMOR_SHIELD) {
      ent.s.effects |= EF_COLOR_SHELL;
      ent.s.renderfx |= RF_SHELL_GREEN;
    }
  }

  // PMM - new monster powerups (rogue quad/double/invincible spheres); a
  // no-op for any monster that never sets these framenum fields (they
  // default to 0, and level.framenum only ever increases).
  if (ent.monsterinfo.quad_framenum > level.framenum) {
    const remaining = ent.monsterinfo.quad_framenum - level.framenum;
    if (remaining > 30 || remaining & 4) ent.s.effects |= EF_QUAD;
  } else {
    ent.s.effects &= ~EF_QUAD;
  }

  if (ent.monsterinfo.double_framenum > level.framenum) {
    const remaining = ent.monsterinfo.double_framenum - level.framenum;
    if (remaining > 30 || remaining & 4) ent.s.effects |= EF_DOUBLE;
  } else {
    ent.s.effects &= ~EF_DOUBLE;
  }

  if (ent.monsterinfo.invincible_framenum > level.framenum) {
    const remaining = ent.monsterinfo.invincible_framenum - level.framenum;
    if (remaining > 30 || remaining & 4) ent.s.effects |= EF_PENT;
  } else {
    ent.s.effects &= ~EF_PENT;
  }
  // PMM
}

function M_MoveFrame(self: EdictT): void {
  let move = self.monsterinfo.currentmove;
  self.nextthink = level.time + FRAMETIME;

  if (move === null) {
    // C dereferences `move->firstframe` unconditionally: `currentmove` is
    // always set before a real monster reaches monster_think. There is no
    // faithful behavior to give a null pointer deref, so this guards instead
    // of throwing -- see the m_move currentmove-pointer field note in
    // g_local.ts.
    return;
  }

  if (
    self.monsterinfo.nextframe &&
    self.monsterinfo.nextframe >= move.firstframe &&
    self.monsterinfo.nextframe <= move.lastframe
  ) {
    self.s.frame = self.monsterinfo.nextframe;
    self.monsterinfo.nextframe = 0;
  } else {
    if (self.s.frame === move.lastframe) {
      if (move.endfunc) {
        move.endfunc(self);

        // regrab move, endfunc is very likely to change it
        move = self.monsterinfo.currentmove;

        // check for death
        if (self.svflags & SVF_DEADMONSTER) return;
      }
    }

    if (move === null) return;

    if (self.s.frame < move.firstframe || self.s.frame > move.lastframe) {
      self.monsterinfo.aiflags &= ~AI_HOLD_FRAME;
      self.s.frame = move.firstframe;
    } else {
      if (!(self.monsterinfo.aiflags & AI_HOLD_FRAME)) {
        self.s.frame++;
        if (self.s.frame > move.lastframe) self.s.frame = move.firstframe;
      }
    }
  }

  const index = self.s.frame - move.firstframe;
  const frame = move.frame[index];
  if (frame === undefined) return;
  if (frame.aifunc) {
    if (!(self.monsterinfo.aiflags & AI_HOLD_FRAME)) frame.aifunc(self, frame.dist * self.monsterinfo.scale);
    else frame.aifunc(self, 0);
  }

  if (frame.thinkfunc) frame.thinkfunc(self);
}

export function monster_think(self: EdictT): void {
  M_MoveFrame(self);
  if (self.linkcount !== self.monsterinfo.linkcount) {
    self.monsterinfo.linkcount = self.linkcount;
    M_CheckGround(self);
  }
  M_CatagorizePosition(self);
  M_WorldEffects(self);
  M_SetEffects(self);
}

/*
================
monster_use

Using a monster makes it angry at the current activator
================
*/
export function monster_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  if (self.enemy) return;
  if (self.health <= 0) return;
  if (activator === null) return;
  if (activator.flags & FL_NOTARGET) return;
  if (!activator.client && !(activator.monsterinfo.aiflags & AI_GOOD_GUY)) return;
  if (activator.flags & FL_DISGUISED) return; // PGM

  // delay reaction so if the monster is teleported, its sound is still heard
  self.enemy = activator;
  FoundTarget(self);
}

export function monster_triggered_spawn(self: EdictT): void {
  self.s.origin[2] += 1;
  KillBox(self);

  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_STEP;
  self.svflags &= ~SVF_NOCLIENT;
  self.air_finished = level.time + 12;
  gi.linkentity(self);

  monster_start_go(self);

  if (self.enemy && !(self.spawnflags & 1) && !(self.enemy.flags & FL_NOTARGET)) {
    if (!(self.enemy.flags & FL_DISGUISED)) {
      // PGM
      FoundTarget(self);
    } else {
      // PMM - just in case, make sure to clear the enemy so FindTarget doesn't get confused
      self.enemy = null;
    }
  } else {
    self.enemy = null;
  }
}

export function monster_triggered_spawn_use(self: EdictT, _other: EdictT | null, activator: EdictT | null): void {
  // we have a one frame delay here so we don't telefrag the guy who activated us
  self.think = monster_triggered_spawn;
  self.nextthink = level.time + FRAMETIME;
  if (activator !== null && activator.client) self.enemy = activator;
  self.use = monster_use;
}

export function monster_triggered_start(self: EdictT): void {
  self.solid = SolidT.SOLID_NOT;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SVF_NOCLIENT;
  self.nextthink = 0;
  self.use = monster_triggered_spawn_use;
}

/*
================
monster_death_use

When a monster dies, it fires all of its targets with the current
enemy as activator.
================
*/
export function monster_death_use(self: EdictT): void {
  self.flags &= ~(FL_FLY | FL_SWIM);
  self.monsterinfo.aiflags &= AI_GOOD_GUY;

  if (self.item) {
    Drop_Item(self, self.item);
    self.item = null;
  }

  if (self.deathtarget) self.target = self.deathtarget;

  if (!self.target) return;

  G_UseTargets(self, self.enemy);
}

//============================================================================

export function monster_start(self: EdictT): boolean {
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    G_FreeEdict(self);
    return false;
  }

  if (self.spawnflags & 4 && !(self.monsterinfo.aiflags & AI_GOOD_GUY)) {
    self.spawnflags &= ~4;
    self.spawnflags |= 1;
    //		gi.dprintf("fixed spawnflags on %s at %s\n", self->classname, vtos(self->s.origin));
  }

  if (!(self.monsterinfo.aiflags & AI_GOOD_GUY) && !(self.monsterinfo.aiflags & AI_DO_NOT_COUNT)) {
    level.total_monsters++;
  }

  self.nextthink = level.time + FRAMETIME;
  self.svflags |= SVF_MONSTER;
  self.s.renderfx |= RF_FRAMELERP;
  self.takedamage = DamageT.DAMAGE_AIM;
  self.air_finished = level.time + 12;
  self.use = monster_use;
  self.max_health = self.health;
  self.clipmask = MASK_MONSTERSOLID;

  self.s.skinnum = 0;
  self.deadflag = DEAD_NO;
  self.svflags &= ~SVF_DEADMONSTER;

  if (!self.monsterinfo.checkattack) self.monsterinfo.checkattack = M_CheckAttack;
  VectorCopy(self.s.origin, self.s.old_origin);

  if (st.item) {
    self.item = FindItemByClassname(st.item);
    if (!self.item) gi.dprintf(`${self.classname} at ${vtos(self.s.origin)} has bad item: ${st.item}\n`);
  }

  // randomize what frame they start on
  if (self.monsterinfo.currentmove) {
    const move = self.monsterinfo.currentmove;
    self.s.frame = move.firstframe + Math.floor(Math.random() * (move.lastframe - move.firstframe + 1));
  }

  // PMM - get this so I don't have to do it in all of the monsters
  self.monsterinfo.base_height = self.maxs[2];

  // PMM - clear these
  self.monsterinfo.quad_framenum = 0;
  self.monsterinfo.double_framenum = 0;
  self.monsterinfo.invincible_framenum = 0;

  return true;
}

export function monster_start_go(self: EdictT): void {
  if (self.health <= 0) return;

  // check for target to combat_point and change to combattarget
  if (self.target) {
    let notcombat = false;
    let fixup = false;
    let target: EdictT | null = null;
    while ((target = G_Find(target, "targetname" as EdictStringKey, self.target)) !== null) {
      if (target.classname === "point_combat") {
        self.combattarget = self.target;
        fixup = true;
      } else {
        notcombat = true;
      }
    }
    if (notcombat && self.combattarget) {
      gi.dprintf(`${self.classname} at ${vtos(self.s.origin)} has target with mixed types\n`);
    }
    if (fixup) self.target = null;
  }

  // validate combattarget
  if (self.combattarget) {
    let target: EdictT | null = null;
    while ((target = G_Find(target, "targetname" as EdictStringKey, self.combattarget)) !== null) {
      if (target.classname !== "point_combat") {
        gi.dprintf(
          `${self.classname} at (${Math.trunc(self.s.origin[0])} ${Math.trunc(self.s.origin[1])} ${Math.trunc(self.s.origin[2])}) has a bad combattarget ${self.combattarget} : ${target.classname} at (${Math.trunc(target.s.origin[0])} ${Math.trunc(target.s.origin[1])} ${Math.trunc(target.s.origin[2])})\n`,
        );
      }
    }
  }

  if (self.target) {
    const picked = G_PickTarget(self.target);
    self.goalentity = picked;
    self.movetarget = picked;
    if (!self.movetarget) {
      gi.dprintf(`${self.classname} can't find target ${self.target} at ${vtos(self.s.origin)}\n`);
      self.target = null;
      self.monsterinfo.pausetime = 100000000;
      if (self.monsterinfo.stand) self.monsterinfo.stand(self);
    } else if (self.movetarget.classname === "path_corner") {
      const v = vec3();
      VectorSubtract(self.goalentity ? self.goalentity.s.origin : vec3_origin, self.s.origin, v);
      self.ideal_yaw = vectoyaw(v);
      self.s.angles[YAW] = self.ideal_yaw;
      if (self.monsterinfo.walk) self.monsterinfo.walk(self);
      self.target = null;
    } else {
      self.goalentity = null;
      self.movetarget = null;
      self.monsterinfo.pausetime = 100000000;
      if (self.monsterinfo.stand) self.monsterinfo.stand(self);
    }
  } else {
    self.monsterinfo.pausetime = 100000000;
    if (self.monsterinfo.stand) self.monsterinfo.stand(self);
  }

  self.think = monster_think;
  self.nextthink = level.time + FRAMETIME;
}

export function walkmonster_start_go(self: EdictT): void {
  if (!(self.spawnflags & 2) && level.time < 1) {
    M_droptofloor(self);

    if (self.groundentity) {
      if (!M_walkmove(self, 0, 0)) gi.dprintf(`${self.classname} in solid at ${vtos(self.s.origin)}\n`);
    }
  }

  if (!self.yaw_speed) self.yaw_speed = 20;
  // PMM - stalkers are too short for this
  if (self.classname === "monster_stalker") self.viewheight = 15;
  else self.viewheight = 25;

  monster_start_go(self);

  if (self.spawnflags & 2) monster_triggered_start(self);
}

export function walkmonster_start(self: EdictT): void {
  self.think = walkmonster_start_go;
  monster_start(self);
}

export function flymonster_start_go(self: EdictT): void {
  if (!M_walkmove(self, 0, 0)) gi.dprintf(`${self.classname} in solid at ${vtos(self.s.origin)}\n`);

  if (!self.yaw_speed) self.yaw_speed = 10;
  self.viewheight = 25;

  monster_start_go(self);

  if (self.spawnflags & 2) monster_triggered_start(self);
}

export function flymonster_start(self: EdictT): void {
  self.flags |= FL_FLY;
  self.think = flymonster_start_go;
  monster_start(self);
}

export function swimmonster_start_go(self: EdictT): void {
  if (!self.yaw_speed) self.yaw_speed = 10;
  self.viewheight = 10;

  monster_start_go(self);

  if (self.spawnflags & 2) monster_triggered_start(self);
}

export function swimmonster_start(self: EdictT): void {
  self.flags |= FL_SWIM;
  self.think = swimmonster_start_go;
  monster_start(self);
}

// ROGUE
//
// stationarymonster_* mirrors monster_triggered_spawn/_start/_use above, but
// for the turret family: turrets are deliberately spawned already embedded
// in solid geometry, so unlike monster_triggered_spawn this path never
// M_walkmove()s (and never warns about being "in solid").

export function stationarymonster_start_go(self: EdictT): void {
  // PGM - only turrets use this, so remove the error message. They're supposed to be in solid.

  //	if (!M_walkmove (self, 0, 0))
  //		gi.dprintf ("%s in solid at %s\n", self->classname, vtos(self->s.origin));

  if (!self.yaw_speed) self.yaw_speed = 20;
  //	self.viewheight = 25;

  monster_start_go(self);

  if (self.spawnflags & 2) stationarymonster_triggered_start(self);
}

export function stationarymonster_triggered_spawn(self: EdictT): void {
  KillBox(self);

  self.solid = SolidT.SOLID_BBOX;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags &= ~SVF_NOCLIENT;
  self.air_finished = level.time + 12;
  gi.linkentity(self);

  // FIXME - why doesn't this happen with real monsters?
  self.spawnflags &= ~2;

  stationarymonster_start_go(self);

  if (self.enemy && !(self.spawnflags & 1) && !(self.enemy.flags & FL_NOTARGET)) {
    if (!(self.enemy.flags & FL_DISGUISED)) {
      // PGM
      FoundTarget(self);
    } else {
      // PMM - just in case, make sure to clear the enemy so FindTarget doesn't get confused
      self.enemy = null;
    }
  } else {
    self.enemy = null;
  }
}

export function stationarymonster_triggered_spawn_use(
  self: EdictT,
  _other: EdictT | null,
  activator: EdictT | null,
): void {
  // we have a one frame delay here so we don't telefrag the guy who activated us
  self.think = stationarymonster_triggered_spawn;
  self.nextthink = level.time + FRAMETIME;
  if (activator !== null && activator.client) self.enemy = activator;
  self.use = monster_use;
}

export function stationarymonster_triggered_start(self: EdictT): void {
  self.solid = SolidT.SOLID_NOT;
  self.movetype = MovetypeT.MOVETYPE_NONE;
  self.svflags |= SVF_NOCLIENT;
  self.nextthink = 0;
  self.use = stationarymonster_triggered_spawn_use;
}

export function stationarymonster_start(self: EdictT): void {
  self.think = stationarymonster_start_go;
  monster_start(self);
}

export function monster_done_dodge(self: EdictT): void {
  self.monsterinfo.aiflags &= ~AI_DODGING;
}
// ROGUE

// ROGUE
// cleanupHealTarget -- clean up heal targets for the medic/medic commander.
// Ported from rogue/g_combat.c (outside this round's edit ownership -- see
// the file-top note). Not yet wired into g_combat.ts's Killed(); see this
// file's final port report.
export function cleanupHealTarget(ent: EdictT): void {
  // This function's contract is "ent is no longer anyone's heal target",
  // and all three call sites pass a medic's current patient. Vanilla 3.21
  // claims a patient with `patient.owner = medic` and rogue's medic
  // overhaul claims it with `monsterinfo.healer`; this module hosts
  // monsters that use each, so releasing the patient has to clear both.
  // Clearing owner is not just bookkeeping -- traces skip an entity's
  // owner, so a corpse left owned by a dead medic keeps colliding wrong
  // and no other medic can claim it.
  ent.owner = null;
  ent.monsterinfo.healer = null;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.monsterinfo.aiflags &= ~AI_RESURRECTING;
  M_SetEffects(ent);
}
// ROGUE

//===================================================================
// ROGUE -- monster-spawning helpers, used by the carrier/medic_commander/
// black widow (this round's monster SCOPE). Ported from rogue/g_spawn.c
// (outside this round's edit ownership -- see the file-top note). See the
// C's own block comment: the sequence to create a flying monster is
// FindSpawnPoint then CreateFlyMonster; for a ground monster, FindSpawnPoint
// then CreateGroundMonster.
//===================================================================

/*
CreateMonster
*/
export function CreateMonster(origin: Vec3, angles: Vec3, classname: string): EdictT {
  const newEnt = G_Spawn();

  VectorCopy(origin, newEnt.s.origin);
  VectorCopy(angles, newEnt.s.angles);
  newEnt.classname = ED_NewString(classname);
  newEnt.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

  VectorSet(newEnt.gravityVector, 0, 0, -1);
  ED_CallSpawn(newEnt);
  newEnt.s.renderfx |= RF_IR_VISIBLE;

  return newEnt;
}

export function CreateFlyMonster(origin: Vec3, angles: Vec3, mins: Vec3, maxs: Vec3, classname: string): EdictT | null {
  if (VectorCompare(mins, vec3_origin) !== 0 || VectorCompare(maxs, vec3_origin) !== 0) {
    DetermineBBox(classname, mins, maxs);
  }

  if (!CheckSpawnPoint(origin, mins, maxs)) return null;

  return CreateMonster(origin, angles, classname);
}

// This is just a wrapper for CreateMonster that looks down height # of CMUs
// and sees if there are bad things down there or not
//
// this is from m_move.c
const STEPSIZE_SPAWN = 18;

export function CreateGroundMonster(
  origin: Vec3,
  angles: Vec3,
  entMins: Vec3,
  entMaxs: Vec3,
  classname: string,
  height: number,
): EdictT | null {
  let mins = entMins;
  let maxs = entMaxs;

  // if they don't provide us a bounding box, figure it out
  if (VectorCompare(entMins, vec3_origin) !== 0 || VectorCompare(entMaxs, vec3_origin) !== 0) {
    mins = vec3();
    maxs = vec3();
    DetermineBBox(classname, mins, maxs);
  }

  // check the ground to make sure it's there, it's relatively flat, and it's not toxic
  if (!CheckGroundSpawnPoint(origin, mins, maxs, height, -1)) return null;

  return CreateMonster(origin, angles, classname);
}

// FindSpawnPoint
// PMM - this is used by the medic commander (possibly by the carrier) to
// find a good spawn point if the startpoint is bad, try above the
// startpoint for a bit
export function FindSpawnPoint(startpoint: Vec3, mins: Vec3, maxs: Vec3, spawnpoint: Vec3, maxMoveUp: number): boolean {
  const tr = gi.trace(startpoint, mins, maxs, startpoint, null, MASK_MONSTERSOLID | CONTENTS_PLAYERCLIP);
  if (tr.startsolid || tr.allsolid || traceEdict(tr.ent) !== world()) {
    const top = vec3();
    VectorCopy(startpoint, top);
    top[2] += maxMoveUp;

    const tr2 = gi.trace(top, mins, maxs, startpoint, null, MASK_MONSTERSOLID);
    if (tr2.startsolid || tr2.allsolid) {
      return false;
    }
    VectorCopy(tr2.endpos, spawnpoint);
    return true;
  }
  VectorCopy(startpoint, spawnpoint);
  return true;
}

// FIXME - all of this needs to be tweaked to handle the new gravity rules
// if we ever want to spawn stuff on the roof

// CheckSpawnPoint
// PMM - checks volume to make sure we can spawn a monster there (is it
// solid?) This is all fliers should need
export function CheckSpawnPoint(origin: Vec3, mins: Vec3, maxs: Vec3): boolean {
  if (VectorCompare(mins, vec3_origin) !== 0 || VectorCompare(maxs, vec3_origin) !== 0) {
    return false;
  }

  const tr = gi.trace(origin, mins, maxs, origin, null, MASK_MONSTERSOLID);
  if (tr.startsolid || tr.allsolid) {
    return false;
  }
  if (traceEdict(tr.ent) !== world()) {
    return false;
  }
  return true;
}

// CheckGroundSpawnPoint
// PMM - used for walking monsters: is there a ground within the specified
// height of the origin, is the ground non-water, and is the ground flat
// enough to walk on?
export function CheckGroundSpawnPoint(origin: Vec3, entMins: Vec3, entMaxs: Vec3, height: number, gravity: number): boolean {
  if (!CheckSpawnPoint(origin, entMins, entMaxs)) return false;

  // FIXME - this is too conservative about angled surfaces
  const stop = vec3();
  VectorCopy(origin, stop);
  // FIXME - gravity vector
  stop[2] = origin[2] + entMins[2] - height;

  let tr = gi.trace(origin, entMins, entMaxs, stop, null, MASK_MONSTERSOLID | MASK_WATER);
  // it's not going to be all solid or start solid, since that's checked above

  if (tr.fraction < 1 && (tr.contents & MASK_MONSTERSOLID) !== 0) {
    // we found a non-water surface down there somewhere. now we need to
    // check to make sure it's not too sloped -- algorithm straight out of
    // m_move.c:M_CheckBottom()

    // first, do the midpoint trace
    const mins = vec3();
    const maxs = vec3();
    VectorAdd(tr.endpos, entMins, mins);
    VectorAdd(tr.endpos, entMaxs, maxs);

    // first, do the easy flat check
    const start = vec3();
    // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
    if (gravity > 0) {
      start[2] = maxs[2] + 1;
    } else {
      start[2] = mins[2] - 1;
    }

    let allSolid = true;
    for (let x = 0; x <= 1 && allSolid; x++) {
      for (let y = 0; y <= 1 && allSolid; y++) {
        start[0] = x !== 0 ? maxs[0] : mins[0];
        start[1] = y !== 0 ? maxs[1] : mins[1];
        if (gi.pointcontents(start) !== CONTENTS_SOLID) allSolid = false;
      }
    }
    if (allSolid) {
      // if it passed all four above checks, we're done
      return true;
    }

    // check it for real
    const start2 = vec3();
    const stop2 = vec3();
    start2[0] = stop2[0] = (mins[0] + maxs[0]) * 0.5;
    start2[1] = stop2[1] = (mins[1] + maxs[1]) * 0.5;
    start2[2] = mins[2];

    tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

    if (tr.fraction === 1) return false;
    let mid: number;
    let bottom: number;

    if (gravity < 0) {
      start2[2] = mins[2];
      stop2[2] = start2[2] - STEPSIZE_SPAWN - STEPSIZE_SPAWN;
      mid = bottom = tr.endpos[2] + entMins[2];
    } else {
      start2[2] = maxs[2];
      stop2[2] = start2[2] + STEPSIZE_SPAWN + STEPSIZE_SPAWN;
      mid = bottom = tr.endpos[2] - entMaxs[2];
    }

    for (let x = 0; x <= 1; x++) {
      for (let y = 0; y <= 1; y++) {
        start2[0] = stop2[0] = x !== 0 ? maxs[0] : mins[0];
        start2[1] = stop2[1] = y !== 0 ? maxs[1] : mins[1];

        tr = gi.trace(start2, vec3_origin, vec3_origin, stop2, null, MASK_MONSTERSOLID);

        // PGM
        // FIXME - this will only handle 0,0,1 and 0,0,-1 gravity vectors
        if (gravity > 0) {
          if (tr.fraction !== 1 && tr.endpos[2] < bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || tr.endpos[2] - mid > STEPSIZE_SPAWN) {
            return false;
          }
        } else {
          if (tr.fraction !== 1 && tr.endpos[2] > bottom) bottom = tr.endpos[2];
          if (tr.fraction === 1 || mid - tr.endpos[2] > STEPSIZE_SPAWN) {
            return false;
          }
        }
      }
    }

    return true; // we can land on it, it's ok
  }

  // otherwise, it's either water (bad) or not there (too far)
  return false;
}

export function DetermineBBox(classname: string, mins: Vec3, maxs: Vec3): void {
  // FIXME - cache this stuff
  const newEnt = G_Spawn();

  VectorCopy(vec3_origin, newEnt.s.origin);
  VectorCopy(vec3_origin, newEnt.s.angles);
  newEnt.classname = ED_NewString(classname);
  newEnt.monsterinfo.aiflags |= AI_DO_NOT_COUNT;

  ED_CallSpawn(newEnt);

  VectorCopy(newEnt.mins, mins);
  VectorCopy(newEnt.maxs, maxs);

  G_FreeEdict(newEnt);
}

// ****************************
// SPAWNGROW stuff
// ****************************

const SPAWNGROW_LIFESPAN = 0.3;

function spawngrow_think(self: EdictT): void {
  for (let i = 0; i < 2; i++) {
    self.s.angles[0] = Math.floor(Math.random() * 360);
    self.s.angles[1] = Math.floor(Math.random() * 360);
    self.s.angles[2] = Math.floor(Math.random() * 360);
  }
  if (level.time < self.wait && self.s.frame < 2) self.s.frame++;
  if (level.time >= self.wait) {
    if (self.s.effects & EF_SPHERETRANS) {
      G_FreeEdict(self);
      return;
    } else if (self.s.frame > 0) {
      self.s.frame--;
    } else {
      G_FreeEdict(self);
      return;
    }
  }
  self.nextthink += FRAMETIME;
}

export function SpawnGrow_Spawn(startpos: Vec3, size: number): void {
  const ent = G_Spawn();
  VectorCopy(startpos, ent.s.origin);
  for (let i = 0; i < 2; i++) {
    ent.s.angles[0] = Math.floor(Math.random() * 360);
    ent.s.angles[1] = Math.floor(Math.random() * 360);
    ent.s.angles[2] = Math.floor(Math.random() * 360);
  }
  ent.solid = SolidT.SOLID_NOT;
  ent.s.renderfx = RF_IR_VISIBLE;
  ent.movetype = MovetypeT.MOVETYPE_NONE;
  ent.classname = "spawngro";

  let lifespan: number;
  if (size <= 1) {
    lifespan = SPAWNGROW_LIFESPAN;
    ent.s.modelindex = gi.modelindex("models/items/spawngro2/tris.md2");
  } else if (size === 2) {
    ent.s.modelindex = gi.modelindex("models/items/spawngro3/tris.md2");
    lifespan = 2;
  } else {
    ent.s.modelindex = gi.modelindex("models/items/spawngro/tris.md2");
    lifespan = SPAWNGROW_LIFESPAN;
  }

  ent.think = spawngrow_think;

  ent.wait = level.time + lifespan;
  ent.nextthink = level.time + FRAMETIME;
  if (size !== 2) ent.s.effects |= EF_SPHERETRANS;
  gi.linkentity(ent);
}

// -------------------------------------------------------------------------
// Savegame function/mmove registry -- so a save containing an entity that
// references one of these callbacks or move tables restores a real
// think/touch/use/pain/die/blocked function or monsterinfo.currentmove
// object instead of null (see g_save.ts's registerSaveFunction/
// registerSaveMmove name registry).
// -------------------------------------------------------------------------

import { registerSaveFunction, registerSaveMmove } from "./g_save";

registerSaveFunction("g_monster:M_FliesOff", M_FliesOff);
registerSaveFunction("g_monster:M_FliesOn", M_FliesOn);
registerSaveFunction("g_monster:M_CheckAttack", M_CheckAttack);
registerSaveFunction("g_monster:stationarymonster_start_go", stationarymonster_start_go);
registerSaveFunction("g_monster:stationarymonster_triggered_spawn", stationarymonster_triggered_spawn);
registerSaveFunction("g_monster:stationarymonster_triggered_spawn_use", stationarymonster_triggered_spawn_use);
registerSaveFunction("g_monster:spawngrow_think", spawngrow_think);
