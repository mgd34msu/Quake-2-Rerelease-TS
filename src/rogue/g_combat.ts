// g_combat.c
//
// rogue/g_combat.c vs baseq2/g_combat.c: banner swap plus rogue's medic/
// sphere/tesla/nuke additions -- a new cleanupHealTarget helper (clears a
// medic's heal-target bookkeeping when the target dies or the medic gives
// up), Killed() gains AI_MEDIC cleanup and AI_SPAWNED_CARRIER/MEDIC_C/WIDOW
// commander-slot bookkeeping plus an AI_DO_NOT_COUNT exemption from the kill
// counter, CheckPowerArmor/CheckArmor gain DAMAGE_NO_POWER_ARMOR/
// DAMAGE_NO_REG_ARMOR handling (the ETF rifle's armor-piercing behaviour),
// M_ReactToDamage gains an `inflictor` parameter for tesla-aggro routing
// (MarkTeslaArea/TargetTesla, implemented in g_newai.c -- RG-systems' SCOPE)
// plus AI_TARGET_ANGER/AI_MEDIC stickiness and an AI_IGNORE_SHOTS carve-out
// that replaces the base game's tank/supertank/makron/jorg classname
// exclusion list, and T_Damage gains: DMGame.ChangeDamage/ChangeKnockback
// hooks (deathmatch-game-rules modifiers, g_newdm.c/dm_tag.c/dm_ball.c --
// RG-systems' SCOPE), defender-sphere half-damage, monster invincibility
// (monsterinfo.invincible_framenum), DAMAGE_DESTROY_ARMOR (damage bypasses
// armor entirely), FL_MECHANICAL/MOD_CHAINFIST blood-effect substitutions,
// and owned_sphere pain notification. T_RadiusNukeDamage/T_RadiusClassDamage
// are new rogue-only radius-damage variants (declared in g_local.h's
// prototypes, implemented here in g_combat.c per the rogue source itself).

import {
  AngleVectors,
  DotProduct,
  type Vec3,
  vec3,
  vec3_origin,
  VectorAdd,
  VectorCopy,
  VectorLength,
  VectorMA,
  VectorNormalize,
  VectorScale,
  VectorSubtract,
} from "../shared/math";
import {
  ATTN_NORM,
  CHAN_ITEM,
  DF_MODELTEAMS,
  DF_NO_FRIENDLY_FIRE,
  DF_SKINTEAMS,
  MASK_SOLID,
  MulticastT,
  TempEventT,
} from "../shared/q_shared";
import { FoundTarget, visible } from "./g_ai";
import { MarkTeslaArea, realrange, TargetTesla } from "./g_newai";
import { OnSameTeam } from "./g_cmds";
import { SVF_DAMAGEABLE, SVF_MONSTER } from "./game";
import { findradius } from "./g_utils";
import {
  AI_DO_NOT_COUNT,
  AI_DUCKED,
  AI_GOOD_GUY,
  AI_IGNORE_SHOTS,
  AI_MEDIC,
  AI_RESURRECTING,
  AI_SOUND_TARGET,
  AI_SPAWNED_CARRIER,
  AI_SPAWNED_MEDIC_C,
  AI_SPAWNED_WIDOW,
  AI_TARGET_ANGER,
  DamageT,
  DAMAGE_BULLET,
  DAMAGE_DESTROY_ARMOR,
  DAMAGE_ENERGY,
  DAMAGE_NO_ARMOR,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_NO_POWER_ARMOR,
  DAMAGE_NO_PROTECTION,
  DAMAGE_NO_REG_ARMOR,
  DAMAGE_RADIUS,
  DEAD_DEAD,
  DMGame,
  type EdictT,
  FL_FLY,
  FL_GODMODE,
  FL_MECHANICAL,
  FL_NOGIB,
  FL_NO_KNOCKBACK,
  FL_SWIM,
  g_edicts,
  gameCvars,
  gi,
  GitemArmorT,
  level,
  meansOfDeathHolder,
  MOD_CHAINFIST,
  MOD_FRIENDLY_FIRE,
  MOD_NUKE,
  MovetypeT,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
  svc_temp_entity,
} from "./g_local";
import { ArmorIndex, FindItem, GetItemByIndex, ITEM_INDEX, PowerArmorType } from "./g_items";
import { M_SetEffects, monster_death_use } from "./g_monster";

/*
ROGUE
clean up heal targets for medic
*/
export function cleanupHealTarget(ent: EdictT): void {
  ent.monsterinfo.healer = null;
  ent.takedamage = DamageT.DAMAGE_YES;
  ent.monsterinfo.aiflags &= ~AI_RESURRECTING;
  M_SetEffects(ent);
}

/*
============
CanDamage

Returns true if the inflictor can directly damage the target.  Used for
explosions and melee attacks.
============
*/
export function CanDamage(targ: EdictT, inflictor: EdictT): boolean {
  const dest = vec3();

  // bmodels need special checking because their origin is 0,0,0
  if (targ.movetype === MovetypeT.MOVETYPE_PUSH) {
    VectorAdd(targ.absmin, targ.absmax, dest);
    VectorScale(dest, 0.5, dest);
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
    if (trace.ent === targ) return true;
    return false;
  }

  {
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, targ.s.origin, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  VectorCopy(targ.s.origin, dest);
  dest[0] += 15.0;
  dest[1] += 15.0;
  {
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  VectorCopy(targ.s.origin, dest);
  dest[0] += 15.0;
  dest[1] -= 15.0;
  {
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  VectorCopy(targ.s.origin, dest);
  dest[0] -= 15.0;
  dest[1] += 15.0;
  {
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  VectorCopy(targ.s.origin, dest);
  dest[0] -= 15.0;
  dest[1] -= 15.0;
  {
    const trace = gi.trace(inflictor.s.origin, vec3_origin, vec3_origin, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  return false;
}

/*
============
Killed
============
*/
export function Killed(targ: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3): void {
  if (targ.health < -999) targ.health = -999;

  if (targ.monsterinfo.aiflags & AI_MEDIC) {
    if (targ.enemy !== null) {
      // god, I hope so
      cleanupHealTarget(targ.enemy);
    }

    // clean up self
    targ.monsterinfo.aiflags &= ~AI_MEDIC;
    targ.enemy = attacker;
  } else {
    targ.enemy = attacker;
  }

  if ((targ.svflags & SVF_MONSTER) !== 0 && targ.deadflag !== DEAD_DEAD) {
    //		targ->svflags |= SVF_DEADMONSTER;	// now treat as a different content type
    // ROGUE - free up slot for spawned monster if it's spawned
    if (targ.monsterinfo.aiflags & AI_SPAWNED_CARRIER) {
      const commander = targ.monsterinfo.commander;
      if (commander !== null && commander.inuse && commander.classname === "monster_carrier") {
        commander.monsterinfo.monster_slots++;
      }
    }
    if (targ.monsterinfo.aiflags & AI_SPAWNED_MEDIC_C) {
      const commander = targ.monsterinfo.commander;
      if (commander !== null) {
        if (commander.inuse && commander.classname === "monster_medic_commander") {
          commander.monsterinfo.monster_slots++;
        }
      }
    }
    if (targ.monsterinfo.aiflags & AI_SPAWNED_WIDOW) {
      // need to check this because we can have variable numbers of coop players
      const commander = targ.monsterinfo.commander;
      if (commander !== null && commander.inuse && commander.classname !== null && commander.classname.startsWith("monster_widow")) {
        if (commander.monsterinfo.monster_used > 0) commander.monsterinfo.monster_used--;
      }
    }
    // rogue
    if ((targ.monsterinfo.aiflags & AI_GOOD_GUY) === 0 && (targ.monsterinfo.aiflags & AI_DO_NOT_COUNT) === 0) {
      level.killed_monsters++;
      const coop = gameCvars.coop === null ? 0 : gameCvars.coop.value;
      if (coop && attacker.client !== null) attacker.client.resp.score++;
      // medics won't heal monsters that they kill themselves
      // PMM - now they will
      //if (attacker.classname === "monster_medic") targ.owner = attacker;
    }
  }

  if (
    targ.movetype === MovetypeT.MOVETYPE_PUSH ||
    targ.movetype === MovetypeT.MOVETYPE_STOP ||
    targ.movetype === MovetypeT.MOVETYPE_NONE
  ) {
    // doors, triggers, etc
    if (targ.die) targ.die(targ, inflictor, attacker, damage, point);
    return;
  }

  if ((targ.svflags & SVF_MONSTER) !== 0 && targ.deadflag !== DEAD_DEAD) {
    targ.touch = null;
    monster_death_use(targ);
  }

  if (targ.die) targ.die(targ, inflictor, attacker, damage, point);
}

/*
================
SpawnDamage
================
*/
export function SpawnDamage(type: number, origin: Vec3, normal: Vec3, damage: number): void {
  if (damage > 255) damage = 255;
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(type);
  //	gi.WriteByte (damage);
  gi.WritePosition(origin);
  gi.WriteDir(normal);
  gi.multicast(origin, MulticastT.MULTICAST_PVS);
}

/*
============
T_Damage

targ		entity that is being damaged
inflictor	entity that is causing the damage
attacker	entity that caused the inflictor to damage targ
	example: targ=monster, inflictor=rocket, attacker=player

dir			direction of the attack
point		point at which the damage is being inflicted
normal		normal vector from that point
damage		amount of damage being inflicted
knockback	force to be applied against targ as a result of the damage

dflags		these flags are used to control how T_Damage works
	DAMAGE_RADIUS			damage was indirect (from a nearby explosion)
	DAMAGE_NO_ARMOR			armor does not protect from this damage
	DAMAGE_ENERGY			damage is from an energy based weapon
	DAMAGE_NO_KNOCKBACK		do not affect velocity, just view angles
	DAMAGE_BULLET			damage is from a bullet (used for ricochets)
	DAMAGE_NO_PROTECTION	kills godmode, armor, everything
============
*/
// `static int CheckPowerArmor`/`static int CheckArmor` in C -- exported here
// (not module-private) so the brief's tests can exercise them directly;
// neither crosses the game/engine boundary, so this is harmless.
export function CheckPowerArmor(ent: EdictT, point: Vec3, normal: Vec3, damage: number, dflags: number): number {
  if (!damage) return 0;

  const client = ent.client;

  // PGM -- ROGUE adds DAMAGE_NO_POWER_ARMOR
  if (dflags & (DAMAGE_NO_ARMOR | DAMAGE_NO_POWER_ARMOR)) return 0;

  let power_armor_type: number;
  let power: number;
  let index = 0;

  if (client !== null) {
    power_armor_type = PowerArmorType(ent);
    if (power_armor_type !== POWER_ARMOR_NONE) {
      const cells = FindItem("Cells");
      index = cells === null ? 0 : ITEM_INDEX(cells);
      power = client.pers.inventory[index];
    } else {
      power = 0;
    }
  } else if (ent.svflags & SVF_MONSTER) {
    power_armor_type = ent.monsterinfo.power_armor_type;
    power = ent.monsterinfo.power_armor_power;
  } else {
    return 0;
  }

  if (power_armor_type === POWER_ARMOR_NONE) return 0;
  if (!power) return 0;

  let damagePerCell: number;
  let pa_te_type: number;

  if (power_armor_type === POWER_ARMOR_SCREEN) {
    // only works if damage point is in front
    const forward = vec3();
    AngleVectors(ent.s.angles, forward, null, null);
    const vec = vec3();
    VectorSubtract(point, ent.s.origin, vec);
    VectorNormalize(vec);
    const dot = DotProduct(vec, forward);
    if (dot <= 0.3) return 0;

    damagePerCell = 1;
    pa_te_type = TempEventT.TE_SCREEN_SPARKS;
    damage = (damage / 3) | 0;
  } else {
    damagePerCell = 2;
    pa_te_type = TempEventT.TE_SHIELD_SPARKS;
    damage = ((2 * damage) / 3) | 0;
  }

  // etf rifle
  let save: number;
  if (dflags & DAMAGE_NO_REG_ARMOR) save = ((power * damagePerCell) / 2) | 0;
  else save = power * damagePerCell;

  if (!save) return 0;
  if (save > damage) save = damage;

  SpawnDamage(pa_te_type, point, normal, save);
  ent.powerarmor_time = level.time + 0.2;

  let power_used: number;
  if (dflags & DAMAGE_NO_REG_ARMOR) power_used = ((save / damagePerCell) * 2) | 0;
  else power_used = (save / damagePerCell) | 0;

  if (client !== null) {
    client.pers.inventory[index] -= power_used;
  } else {
    ent.monsterinfo.power_armor_power -= power_used;
  }
  return save;
}

export function CheckArmor(
  ent: EdictT,
  point: Vec3,
  normal: Vec3,
  damage: number,
  te_sparks: number,
  dflags: number,
): number {
  if (!damage) return 0;

  const client = ent.client;

  if (client === null) return 0;

  // ROGUE - added DAMAGE_NO_REG_ARMOR for etf rifle
  if (dflags & (DAMAGE_NO_ARMOR | DAMAGE_NO_REG_ARMOR)) return 0;

  const index = ArmorIndex(ent);
  if (!index) return 0;

  const armor = GetItemByIndex(index);
  // C dereferences `armor` unconditionally here; a live index from
  // ArmorIndex() always resolves through GetItemByIndex() once g_items.c is
  // fully ported. TS cannot express an unchecked deref through a nullable
  // return type, so this null guard is the one input this port handles
  // differently from the original (see the identical precedent in
  // g_utils.ts's G_UseTargets).
  if (armor === null) return 0;

  const info = armor.info;
  if (!(info instanceof GitemArmorT)) {
    // `(gitem_armor_t *)armor->info` in C is an unchecked cast; a real
    // armor item's `info` is always a GitemArmorT once g_items.c sets it up
    // (see g_items.c's InitItems), so this narrows instead of casting per
    // this project's no-`as` rule.
    throw new Error("CheckArmor: armor item has no GitemArmorT info");
  }

  let save: number;
  if (dflags & DAMAGE_ENERGY) {
    save = Math.ceil(info.energy_protection * damage);
  } else {
    save = Math.ceil(info.normal_protection * damage);
  }
  if (save >= client.pers.inventory[index]) save = client.pers.inventory[index];

  if (!save) return 0;

  client.pers.inventory[index] -= save;
  SpawnDamage(te_sparks, point, normal, save);

  return save;
}

export function M_ReactToDamage(targ: EdictT, attacker: EdictT, inflictor: EdictT): void {
  if (attacker.client === null && (attacker.svflags & SVF_MONSTER) === 0) return;

  //=======
  //ROGUE
  // logic for tesla - if you are hit by a tesla, and can't see who you should be mad at (attacker)
  // attack the tesla
  // also, target the tesla if it's a "new" tesla
  if (inflictor.classname === "tesla") {
    const new_tesla = MarkTeslaArea(targ, inflictor);
    if (new_tesla) TargetTesla(targ, inflictor);
    return;
  }
  //ROGUE
  //=======

  if (attacker === targ || attacker === targ.enemy) return;

  // if we are a good guy monster and our attacker is a player
  // or another good guy, do not get mad at them
  if (targ.monsterinfo.aiflags & AI_GOOD_GUY) {
    if (attacker.client !== null || attacker.monsterinfo.aiflags & AI_GOOD_GUY) return;
  }

  //PGM
  // if we're currently mad at something a target_anger made us mad at, ignore
  // damage
  if (targ.enemy !== null && targ.monsterinfo.aiflags & AI_TARGET_ANGER) {
    // make sure whatever we were pissed at is still around.
    if (targ.enemy.inuse) {
      const percentHealth = targ.health / targ.max_health;
      if (targ.enemy.inuse && percentHealth > 0.33) return;
    }

    // remove the target anger flag
    targ.monsterinfo.aiflags &= ~AI_TARGET_ANGER;
  }
  //PGM

  // PMM
  // if we're healing someone, do like above and try to stay with them
  if (targ.enemy !== null && targ.monsterinfo.aiflags & AI_MEDIC) {
    const percentHealth = targ.health / targ.max_health;
    // ignore it some of the time
    if (targ.enemy.inuse && percentHealth > 0.25) return;

    // remove the medic flag
    targ.monsterinfo.aiflags &= ~AI_MEDIC;
    cleanupHealTarget(targ.enemy);
  }
  // PMM

  // we now know that we are not both good guys

  // if attacker is a client, get mad at them because he's good and we're not
  if (attacker.client !== null) {
    targ.monsterinfo.aiflags &= ~AI_SOUND_TARGET;

    // this can only happen in coop (both new and old enemies are clients)
    // only switch if can't see the current enemy
    if (targ.enemy !== null && targ.enemy.client !== null) {
      if (visible(targ, targ.enemy)) {
        targ.oldenemy = attacker;
        return;
      }
      targ.oldenemy = targ.enemy;
    }
    targ.enemy = attacker;
    if (!(targ.monsterinfo.aiflags & AI_DUCKED)) FoundTarget(targ);
    return;
  }

  // it's the same base (walk/swim/fly) type and a different classname and it's not a tank
  // (they spray too much), get mad at them
  // PMM
  // added medics to this
  // FIXME -
  // this really should be turned into an AI flag marking appropriate monsters as "don't shoot me"
  //   this also leads to the problem of tanks and medics being able to, at will, kill monsters with
  //   no chance of retaliation.  My vote is to make those monsters who are designed as "don't shoot me"
  //   such that they also ignore being shot by monsters as well
  if (
    (targ.flags & (FL_FLY | FL_SWIM)) === (attacker.flags & (FL_FLY | FL_SWIM)) &&
    targ.classname !== attacker.classname &&
    !(attacker.monsterinfo.aiflags & AI_IGNORE_SHOTS) &&
    !(targ.monsterinfo.aiflags & AI_IGNORE_SHOTS)
  ) {
    if (targ.enemy !== null && targ.enemy.client !== null) targ.oldenemy = targ.enemy;
    targ.enemy = attacker;
    if (!(targ.monsterinfo.aiflags & AI_DUCKED)) FoundTarget(targ);
  }
  // if they *meant* to shoot us, then shoot back
  else if (attacker.enemy === targ) {
    if (targ.enemy !== null && targ.enemy.client !== null) targ.oldenemy = targ.enemy;
    targ.enemy = attacker;
    if (!(targ.monsterinfo.aiflags & AI_DUCKED)) FoundTarget(targ);
  }
  // otherwise get mad at whoever they are mad at (help our buddy) unless it is us!
  else if (attacker.enemy !== null && attacker.enemy !== targ) {
    if (targ.enemy !== null && targ.enemy.client !== null) targ.oldenemy = targ.enemy;
    targ.enemy = attacker.enemy;
    if (!(targ.monsterinfo.aiflags & AI_DUCKED)) FoundTarget(targ);
  }
}

export function CheckTeamDamage(_targ: EdictT, _attacker: EdictT): boolean {
  //FIXME make the next line real and uncomment this block
  // if ((ability to damage a teammate == OFF) && (targ's team == attacker's team))
  return false;
}

export function T_Damage(
  targ: EdictT,
  inflictor: EdictT,
  attacker: EdictT,
  dir: Vec3,
  point: Vec3,
  normal: Vec3,
  damage: number,
  knockback: number,
  dflags: number,
  mod: number,
): void {
  if (!targ.takedamage) return;

  const deathmatch = gameCvars.deathmatch === null ? 0 : gameCvars.deathmatch.value;
  const dmflags = gameCvars.dmflags === null ? 0 : gameCvars.dmflags.value;
  const coop = gameCvars.coop === null ? 0 : gameCvars.coop.value;
  const skill = gameCvars.skill === null ? 0 : gameCvars.skill.value;

  // PGM
  let sphere_notified = false;

  // friendly fire avoidance
  // if enabled you can't hurt teammates (but you can hurt yourself)
  // knockback still occurs
  if (targ !== attacker && ((deathmatch && (dmflags | 0) & (DF_MODELTEAMS | DF_SKINTEAMS)) || coop)) {
    if (OnSameTeam(targ, attacker)) {
      // PMM - nukes kill everyone
      if ((dmflags | 0) & DF_NO_FRIENDLY_FIRE && mod !== MOD_NUKE) {
        damage = 0;
      } else {
        mod |= MOD_FRIENDLY_FIRE;
      }
    }
  }
  meansOfDeathHolder.meansOfDeath = mod;

  //ROGUE
  // allow the deathmatch game to change values
  const gamerules = gameCvars.gamerules === null ? 0 : gameCvars.gamerules.value;
  if (deathmatch && gamerules) {
    if (DMGame.ChangeDamage) damage = DMGame.ChangeDamage(targ, attacker, damage, mod);
    if (DMGame.ChangeKnockback) knockback = DMGame.ChangeKnockback(targ, attacker, knockback, mod);

    if (!damage) return;
  }
  //ROGUE

  // easy mode takes half damage
  if (skill === 0 && deathmatch === 0 && targ.client !== null) {
    damage = (damage * 0.5) | 0;
    if (!damage) damage = 1;
  }

  const client = targ.client;

  // PMM - defender sphere takes half damage
  if (client !== null && client.owned_sphere !== null && client.owned_sphere.spawnflags === 1) {
    damage *= 0.5;
    if (!damage) damage = 1;
  }

  const te_sparks = dflags & DAMAGE_BULLET ? TempEventT.TE_BULLET_SPARKS : TempEventT.TE_SPARKS;

  VectorNormalize(dir);

  // bonus damage for suprising a monster
  if (
    !(dflags & DAMAGE_RADIUS) &&
    targ.svflags & SVF_MONSTER &&
    attacker.client !== null &&
    targ.enemy === null &&
    targ.health > 0
  ) {
    damage = (damage * 2) | 0;
  }

  if (targ.flags & FL_NO_KNOCKBACK) knockback = 0;

  // figure momentum add
  if (!(dflags & DAMAGE_NO_KNOCKBACK)) {
    if (
      knockback &&
      targ.movetype !== MovetypeT.MOVETYPE_NONE &&
      targ.movetype !== MovetypeT.MOVETYPE_BOUNCE &&
      targ.movetype !== MovetypeT.MOVETYPE_PUSH &&
      targ.movetype !== MovetypeT.MOVETYPE_STOP
    ) {
      const mass = targ.mass < 50 ? 50 : targ.mass;
      const kvel = vec3();

      if (targ.client !== null && attacker === targ) {
        VectorScale(dir, (1600.0 * knockback) / mass, kvel); // the rocket jump hack...
      } else {
        VectorScale(dir, (500.0 * knockback) / mass, kvel);
      }

      VectorAdd(targ.velocity, kvel, targ.velocity);
    }
  }

  let take = damage;
  let save = 0;

  // check for godmode
  if (targ.flags & FL_GODMODE && !(dflags & DAMAGE_NO_PROTECTION)) {
    take = 0;
    save = damage;
    SpawnDamage(te_sparks, point, normal, save);
  }

  // check for invincibility
  if (client !== null && client.invincible_framenum > level.framenum && !(dflags & DAMAGE_NO_PROTECTION)) {
    if (targ.pain_debounce_time < level.time) {
      gi.sound(targ, CHAN_ITEM, gi.soundindex("items/protect4.wav"), 1, ATTN_NORM, 0);
      targ.pain_debounce_time = level.time + 2;
    }
    take = 0;
    save = damage;
  }

  // ROGUE
  // check for monster invincibility
  if (
    targ.svflags & SVF_MONSTER &&
    targ.monsterinfo.invincible_framenum > level.framenum &&
    !(dflags & DAMAGE_NO_PROTECTION)
  ) {
    if (targ.pain_debounce_time < level.time) {
      gi.sound(targ, CHAN_ITEM, gi.soundindex("items/protect4.wav"), 1, ATTN_NORM, 0);
      targ.pain_debounce_time = level.time + 2;
    }
    take = 0;
    save = damage;
  }
  // ROGUE

  const psave = CheckPowerArmor(targ, point, normal, take, dflags);
  take -= psave;

  let asave = CheckArmor(targ, point, normal, take, te_sparks, dflags);
  take -= asave;

  //treat cheat/powerup savings the same as armor
  asave += save;

  // team damage avoidance
  if (!(dflags & DAMAGE_NO_PROTECTION) && CheckTeamDamage(targ, attacker)) return;

  // ROGUE - this option will do damage both to the armor and person. originally for DPU rounds
  if (dflags & DAMAGE_DESTROY_ARMOR) {
    if (
      !(targ.flags & FL_GODMODE) &&
      !(dflags & DAMAGE_NO_PROTECTION) &&
      !(client !== null && client.invincible_framenum > level.framenum)
    ) {
      take = damage;
    }
  }
  // ROGUE

  // do the damage
  if (take) {
    //PGM		need more blood for chainfist.
    if (targ.flags & FL_MECHANICAL) {
      SpawnDamage(TempEventT.TE_ELECTRIC_SPARKS, point, normal, take);
    } else if (targ.svflags & SVF_MONSTER || client !== null) {
      if (mod === MOD_CHAINFIST) SpawnDamage(TempEventT.TE_MOREBLOOD, point, normal, 255);
      else SpawnDamage(TempEventT.TE_BLOOD, point, normal, take);
    } else {
      SpawnDamage(te_sparks, point, normal, take);
    }
    //PGM

    targ.health = targ.health - take;

    //PGM - spheres need to know who to shoot at
    if (client !== null && client.owned_sphere !== null) {
      sphere_notified = true;
      if (client.owned_sphere.pain) client.owned_sphere.pain(client.owned_sphere, attacker, 0, 0);
    }
    //PGM

    if (targ.health <= 0) {
      if (targ.svflags & SVF_MONSTER || client !== null) targ.flags |= FL_NO_KNOCKBACK;
      Killed(targ, inflictor, attacker, take, point);
      return;
    }
  }

  //PGM - spheres need to know who to shoot at
  if (!sphere_notified) {
    if (client !== null && client.owned_sphere !== null) {
      sphere_notified = true;
      if (client.owned_sphere.pain) client.owned_sphere.pain(client.owned_sphere, attacker, 0, 0);
    }
  }
  //PGM

  if (targ.svflags & SVF_MONSTER) {
    M_ReactToDamage(targ, attacker, inflictor);
    // PMM - fixme - if anyone else but the medic ever uses AI_MEDIC, check for it here instead
    // of in the medic's pain function
    if (!(targ.monsterinfo.aiflags & AI_DUCKED) && take) {
      if (targ.pain) targ.pain(targ, attacker, knockback, take);
      // nightmare mode monsters don't go into pain frames often
      if (skill === 3) targ.pain_debounce_time = level.time + 5;
    }
  } else if (client !== null) {
    if (!(targ.flags & FL_GODMODE) && take) {
      if (targ.pain) targ.pain(targ, attacker, knockback, take);
    }
  } else if (take) {
    if (targ.pain) targ.pain(targ, attacker, knockback, take);
  }

  // add to the damage inflicted on a player this frame
  // the total will be turned into screen blends and view angle kicks
  // at the end of the frame
  if (client !== null) {
    client.damage_parmor += psave;
    client.damage_armor += asave;
    client.damage_blood += take;
    client.damage_knockback += knockback;
    VectorCopy(point, client.damage_from);
  }
}

/*
============
T_RadiusDamage
============
*/
export function T_RadiusDamage(
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  ignore: EdictT | null,
  radius: number,
  mod: number,
): void {
  const v = vec3();
  const dir = vec3();

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, inflictor.s.origin, radius);
    if (ent === null) break;
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;

    VectorAdd(ent.mins, ent.maxs, v);
    VectorMA(ent.s.origin, 0.5, v, v);
    VectorSubtract(inflictor.s.origin, v, v);
    let points = damage - 0.5 * VectorLength(v);
    if (ent === attacker) points = points * 0.5;
    if (points > 0) {
      if (CanDamage(ent, inflictor)) {
        VectorSubtract(ent.s.origin, inflictor.s.origin, dir);
        T_Damage(
          ent,
          inflictor,
          attacker,
          dir,
          inflictor.s.origin,
          vec3_origin,
          points | 0,
          points | 0,
          DAMAGE_RADIUS,
          mod,
        );
      }
    }
  }
}

// **********************
// ROGUE

/*
============
T_RadiusNukeDamage

Like T_RadiusDamage, but ignores walls (skips CanDamage check, among others)
// up to KILLZONE radius, do 10,000 points
// after that, do damage linearly out to KILLZONE2 radius
============
*/
export function T_RadiusNukeDamage(
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  ignore: EdictT | null,
  radius: number,
  mod: number,
): void {
  const v = vec3();
  const dir = vec3();

  const killzone = radius;
  const killzone2 = radius * 2.0;

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, inflictor.s.origin, killzone2);
    if (ent === null) break;

    // ignore nobody
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;
    if (!ent.inuse) continue;
    if (!(ent.client !== null || ent.svflags & SVF_MONSTER || ent.svflags & SVF_DAMAGEABLE)) continue;

    VectorAdd(ent.mins, ent.maxs, v);
    VectorMA(ent.s.origin, 0.5, v, v);
    VectorSubtract(inflictor.s.origin, v, v);
    const len = VectorLength(v);
    let points: number;
    if (len <= killzone) {
      if (ent.client !== null) ent.flags |= FL_NOGIB;
      points = 10000;
    } else if (len <= killzone2) {
      points = (damage / killzone) * (killzone2 - len);
    } else {
      points = 0;
    }

    if (points > 0) {
      if (ent.client !== null) ent.client.nuke_framenum = level.framenum + 20;
      VectorSubtract(ent.s.origin, inflictor.s.origin, dir);
      T_Damage(ent, inflictor, attacker, dir, inflictor.s.origin, vec3_origin, points | 0, points | 0, DAMAGE_RADIUS, mod);
    }
  }

  // skip the worldspawn
  // cycle through players
  //
  // C walks this with raw pointer arithmetic (`ent = g_edicts+1; ... ent++;`)
  // and bails the ENTIRE loop the instant an entity fails the `client &&
  // !nuked-this-frame && inuse` test, rather than skipping to the next
  // entity -- preserved bug-for-bug (see PORTING.md's "Faithful port,
  // bug-for-bug"): a non-client or freed edict at index i stops the scan for
  // every player at index > i too.
  for (let i = 1; ; i++) {
    const e: EdictT | undefined = g_edicts[i];
    if (e === undefined) break;
    if (e.client !== null && e.client.nuke_framenum !== level.framenum + 20 && e.inuse) {
      const tr = gi.trace(inflictor.s.origin, null, null, e.s.origin, inflictor, MASK_SOLID);
      if (tr.fraction === 1.0) {
        e.client.nuke_framenum = level.framenum + 20;
      } else {
        const dist = realrange(e, inflictor);
        if (dist < 2048) e.client.nuke_framenum = Math.max(e.client.nuke_framenum, level.framenum + 15);
        else e.client.nuke_framenum = Math.max(e.client.nuke_framenum, level.framenum + 10);
      }
    } else {
      break;
    }
  }
}

/*
============
T_RadiusClassDamage

Like T_RadiusDamage, but ignores anything with classname=ignoreClass
============
*/
export function T_RadiusClassDamage(
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  ignoreClass: string,
  radius: number,
  mod: number,
): void {
  const v = vec3();
  const dir = vec3();

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, inflictor.s.origin, radius);
    if (ent === null) break;

    if (ent.classname !== null && ent.classname === ignoreClass) continue;
    if (!ent.takedamage) continue;

    VectorAdd(ent.mins, ent.maxs, v);
    VectorMA(ent.s.origin, 0.5, v, v);
    VectorSubtract(inflictor.s.origin, v, v);
    let points = damage - 0.5 * VectorLength(v);
    if (ent === attacker) points = points * 0.5;
    if (points > 0) {
      if (CanDamage(ent, inflictor)) {
        VectorSubtract(ent.s.origin, inflictor.s.origin, dir);
        T_Damage(
          ent,
          inflictor,
          attacker,
          dir,
          inflictor.s.origin,
          vec3_origin,
          points | 0,
          points | 0,
          DAMAGE_RADIUS,
          mod,
        );
      }
    }
  }
}

// ROGUE
// ********************
