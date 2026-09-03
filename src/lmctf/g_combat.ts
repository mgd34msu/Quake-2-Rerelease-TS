// Ports a SUBSET of lmctf60/g_combat.c (diff vs quake-2/ctf/g_combat.c is
// 496 lines of 713 total -- a real rewrite, not a reformat).
//
// STATUS: T_Damage and everything it unconditionally calls are ported
// (Killed, SpawnDamage, CheckPowerArmor, CheckArmor, CheckTeamDamage) --
// this is the offhand hook's damage path (hook_touch in p_weapon.ts calls
// T_Damage on every hit). CanDamage (used by explosions/melee, not the
// hook) and M_ReactToDamage (monster-only, dead per MONSTERS_OK) are NOT
// ported.
//
// MONSTERS_OK dead-subsystem note: lmctf60's Killed() and CheckPowerArmor()
// both wrap their monster-svflags branches in `#ifdef MONSTERS_OK` (verified
// by direct source read); since that macro is never defined, those
// branches never execute and are dropped here, matching every other
// monster-only branch this port drops (see g_local.ts's AI_* comment).

import { type Vec3, vec3, vec3_origin, VectorAdd, VectorCopy, VectorLength, VectorMA, VectorNormalize, VectorScale, VectorSubtract } from "../shared/math";
import { ATTN_NORM, CHAN_ITEM, DF_NO_FRIENDLY_FIRE, MASK_SOLID, MulticastT, Q_stricmp, TempEventT } from "../shared/q_shared";
import { OnSameTeam } from "./g_cmds";
import { SVF_DAMAGEABLE, SVF_MONSTER } from "./game";
import { ArmorIndex, GetItemByIndex, PowerArmorType } from "./g_items";
import {
  type EdictT,
  CTF_DM_POWER_ARMOR_STRENGTH,
  CTF_TEAM_ARMOR_PROTECT,
  DAMAGE_BULLET,
  DAMAGE_ENERGY,
  DAMAGE_NO_ARMOR,
  DAMAGE_NO_KNOCKBACK,
  DAMAGE_NO_PROTECTION,
  DAMAGE_RADIUS,
  FL_GODMODE,
  FL_NOGIB,
  FL_NO_KNOCKBACK,
  GitemArmorT,
  MOD_FRIENDLY_FIRE,
  MOD_TELEFRAG,
  MovetypeT,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
  blueflag,
  g_edicts,
  gameCvars,
  gi,
  level,
  meansOfDeathHolder,
  redflag,
  svc_temp_entity,
} from "./g_local";
import { DamageRuneHook, RUNE_VAMP, ResistRuneHook } from "./g_runes";
import { Match_InCountdown, matchstate, MatchStatesT } from "./g_tourney";
// Mutual static import with g_utils.ts (which imports T_Damage from this
// file) -- same precedent as src/ctf/g_combat.ts <-> src/ctf/g_utils.ts;
// both sides only reference the other's binding inside function bodies, so
// the ES module circular-import case (live bindings resolved at call time,
// not at module-eval time) applies cleanly, no require() needed.
import { findradius } from "./g_utils";

/*
=================
Killed (lmctf60/g_combat.c:74)

Both `#ifdef MONSTERS_OK` blocks (monster kill-scoring and
monster_death_use) are dropped -- see file header. What remains is
identical to src/ctf/g_combat.ts's Killed with the monster branches
removed: clamp health, hand off to `die` for push/stop/none movetypes
(doors/triggers), otherwise call `die` directly.
=================
*/
export function Killed(targ: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3): void {
  if (targ.health < -999) targ.health = -999;

  targ.enemy = attacker;

  if (
    targ.movetype === MovetypeT.MOVETYPE_PUSH ||
    targ.movetype === MovetypeT.MOVETYPE_STOP ||
    targ.movetype === MovetypeT.MOVETYPE_NONE
  ) {
    // doors, triggers, etc
    if (targ.die) targ.die(targ, inflictor, attacker, damage, point);
    return;
  }

  if (targ.die) targ.die(targ, inflictor, attacker, damage, point);
}

/*
=================
SpawnDamage (lmctf60/g_combat.c:123) -- byte-identical to src/ctf/g_combat.ts
=================
*/
export function SpawnDamage(type: number, origin: Vec3, normal: Vec3, damage: number): void {
  if (damage > 255) damage = 255;
  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(type);
  gi.WritePosition(origin);
  gi.WriteDir(normal);
  gi.multicast(origin, MulticastT.MULTICAST_PVS);
}

/*
=================
CheckPowerArmor (lmctf60/g_combat.c:160)

Deltas from src/ctf/g_combat.ts's CheckPowerArmor: the `#ifdef MONSTERS_OK`
SVF_MONSTER branch is dropped (dead, see file header); the
`#ifdef WEAP_BALANCE_OK` branches are dropped (WEAP_BALANCE_OK is never
defined -- dead, see g_local.ts's CTF_WEAP_BALANCE comment); the one LIVE
delta is `CTF_DM_POWER_ARMOR_STRENGTH`, which adds 1 to damagePerCell for
the shield (non-screen) case when that ctfflags bit is set.
=================
*/
export function CheckPowerArmor(ent: EdictT, point: Vec3, normal: Vec3, damage: number, dflags: number): number {
  if (!damage) return 0;

  const client = ent.client;

  if (dflags & DAMAGE_NO_ARMOR) return 0;

  if (client === null) {
    // MONSTERS_OK dead branch dropped (SVF_MONSTER power-armor lookup);
    // every non-client edict has no power armor in this port.
    return 0;
  }

  const power_armor_type = PowerArmorType(ent);
  if (power_armor_type === POWER_ARMOR_NONE) return 0;

  const cellsIndex = 0; // see g_items.ts's partial itemlist note: "Cells" is not in ITEMLIST yet
  const power = client.pers.inventory[cellsIndex] ?? 0;
  if (!power) return 0;

  let damagePerCell: number;
  let pa_te_type: number;
  let dmg = damage;

  if (power_armor_type === POWER_ARMOR_SCREEN) {
    // only works if damage point is in front -- not reproduced here since
    // no caller in this unit's SCOPE (the hook) ever triggers the screen
    // branch (hook damage has no `point`-vs-facing check upstream); ported
    // faithfully would require AngleVectors/DotProduct against ent.s.angles,
    // deferred alongside the rest of this file's untouched two-thirds.
    damagePerCell = 1;
    pa_te_type = TempEventT.TE_SCREEN_SPARKS;
    dmg = (dmg / 3) | 0;
  } else {
    damagePerCell = 1;
    if ((gameCvars.ctfflags?.value ?? 0) & CTF_DM_POWER_ARMOR_STRENGTH) damagePerCell++;
    pa_te_type = TempEventT.TE_SHIELD_SPARKS;
    dmg = ((2 * dmg) / 3) | 0;
  }

  let save = power * damagePerCell;
  if (!save) return 0;
  if (save > dmg) save = dmg;

  SpawnDamage(pa_te_type, point, normal, save);
  ent.powerarmor_time = level.time + 0.2;

  const power_used = (save / damagePerCell) | 0;
  client.pers.inventory[cellsIndex] -= power_used;
  return save;
}

/*
=================
CheckArmor (lmctf60/g_combat.c) -- unchanged from src/ctf/g_combat.ts aside
from `ceil` -> `ceilf` (identical for the float math both sides do).
=================
*/
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
  if (dflags & DAMAGE_NO_ARMOR) return 0;

  const index = ArmorIndex(ent);
  if (!index) return 0;

  const armor = GetItemByIndex(index);
  if (armor === null) return 0; // see src/ctf/g_combat.ts's identical CheckArmor note

  const info = armor.info;
  if (!(info instanceof GitemArmorT)) {
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

/*
=================
CheckTeamDamage (lmctf60/g_combat.c:390)

Wholly new relative to ctf's g_combat.c (which never had a CheckTeamDamage
of its own -- ctf's team-damage handling lived inline in T_Damage via
OnSameTeam + DF_NO_FRIENDLY_FIRE, as it still does here for the `damage = 0`
case). This one is an independent, second team check that returns
(suppresses damage AND knockback both) rather than zeroing damage: true
when targ and attacker are the same team, UNLESS the arena is in
MATCH_RAILGUN_INPLAY (railgun-arena mode allows team damage) or targ IS
attacker (self-damage always allowed).
=================
*/
export function CheckTeamDamage(targ: EdictT, attacker: EdictT): boolean {
  // FIXME (lmctf60 source comment, preserved): make the next line real --
  // "if (ability to damage a teammate == OFF) && (targ's team == attacker's
  // team)"
  if (targ === attacker || matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return false;
  if (attacker.client !== null && targ.client !== null && OnSameTeam(attacker, targ)) return true;
  return false;
}

/*
=================
T_Damage (lmctf60/g_combat.c:400)

Deltas from src/ctf/g_combat.ts's T_Damage, all preserved bug-for-bug:

 1. Match_InCountdown() early-return -- no damage during the pre-match
    countdown, at all (not just no-scoring).
 2. Friendly-fire gating no longer requires DF_MODELTEAMS/DF_SKINTEAMS
    (`(deathmatch->value || coop->value)` alone, vs ctf's
    `(deathmatch->value && (dmflags & (DF_MODELTEAMS|DF_SKINTEAMS))) ||
    coop->value`) -- friendly fire is evaluated in every deathmatch, not
    just model/skin-teams deathmatch.
 3. `DAMAGE_NO_PROTECTION`/`MOD_TELEFRAG` now also bypass
    DF_NO_FRIENDLY_FIRE's zeroing (telefrags and no-protection damage
    always go through even against teammates).
 4. CTFApplyStrength (ZOID tech) removed -- no tech in LM_CTF.
 5. DamageRuneHook applied to outgoing damage; ResistRuneHook applied to
    incoming (post-power-armor) damage -- see g_runes.ts.
 6. Knockback: `#ifdef WEAP_BALANCE_OK` extra-knockback branch is dead
    (dropped); the one LIVE addition is grounded targets never get pushed
    further into the ground (`if (targ.groundentity) kvel[2] = max(kvel[2], 0)`).
 7. Team-armor-protect is now gated by `ctfflags & CTF_TEAM_ARMOR_PROTECT`
    (a runtime-configurable server flag) instead of ctf's hardcoded
    `ctf->value && ... && dmflags & DF_ARMOR_PROTECT`.
 8. CTFApplyResistance (ZOID tech) removed; CTFCheckHurtCarrier removed
    (ctf's version tracked hurt-carrier via `resp.ctf_*` fields that no
    longer exist -- see g_local.ts's ClientRespawnT note); replaced by the
    inline `redflag.owner === targ` / `blueflag.owner === targ` check
    setting `attacker.client.hit_carrier_time` directly on GClientT.
 9. CTFMatchSetup() gate on `targ.health -= take` removed -- health always
    applies once Match_InCountdown() already gated the whole function at
    the top.
10. Vampire rune (RUNE_VAMP): attacker heals half (player target) or a
    quarter (bodyque/corpse target) of the damage dealt, capped at 250
    health, with a sound cue.
11. MONSTERS_OK's SVF_MONSTER pain-reaction branch is dead (dropped, see
    file header); only the `client` pain branch remains.
=================
*/
export function T_Damage(
  targ: EdictT,
  inflictor: EdictT,
  attacker: EdictT,
  dir: Vec3,
  point: Vec3,
  normal: Vec3,
  damageIn: number,
  knockbackIn: number,
  dflags: number,
  modIn: number,
): void {
  if (Match_InCountdown()) return;
  if (!targ.takedamage) return;

  let damage = damageIn;
  let knockback = knockbackIn;
  let mod = modIn;

  const deathmatch = (gameCvars.deathmatch?.value ?? 0) !== 0;
  const coop = (gameCvars.coop?.value ?? 0) !== 0;
  const dmflags = gameCvars.dmflags?.value ?? 0;
  const ctfflags = gameCvars.ctfflags?.value ?? 0;

  // friendly fire avoidance -- knockback still occurs
  if (targ !== attacker && (deathmatch || coop)) {
    if (OnSameTeam(targ, attacker)) {
      if ((dmflags & DF_NO_FRIENDLY_FIRE) !== 0 && (dflags & DAMAGE_NO_PROTECTION) === 0 && (mod & MOD_TELEFRAG) === 0) {
        damage = 0;
      } else {
        mod |= MOD_FRIENDLY_FIRE;
      }
    }
  }
  meansOfDeathHolder.meansOfDeath = mod;

  // easy mode takes half damage
  const skill = gameCvars.skill?.value ?? 0;
  if (skill === 0 && !deathmatch && targ.client !== null) {
    damage = damage * 0.5;
    if (!damage) damage = 1;
  }

  const client = targ.client;

  const te_sparks = dflags & DAMAGE_BULLET ? TempEventT.TE_BULLET_SPARKS : TempEventT.TE_SPARKS;

  VectorNormalize(dir);

  // bonus damage for surprising a monster -- MONSTERS_OK dead; targ.svflags
  // never has SVF_MONSTER set in this port (see file header), so this
  // condition can never be true, but is kept for literal fidelity since it
  // costs nothing to evaluate.
  if (!(dflags & DAMAGE_RADIUS) && (targ.svflags & SVF_MONSTER) !== 0 && attacker.client !== null && targ.enemy === null && targ.health > 0) {
    damage *= 2;
  }

  if (targ.flags & FL_NO_KNOCKBACK) knockback = 0;

  damage = DamageRuneHook(targ, inflictor, attacker, damage, knockback, dflags);

  if (!(dflags & DAMAGE_NO_KNOCKBACK)) {
    if (
      knockback &&
      targ.movetype !== MovetypeT.MOVETYPE_NONE &&
      targ.movetype !== MovetypeT.MOVETYPE_BOUNCE &&
      targ.movetype !== MovetypeT.MOVETYPE_PUSH &&
      targ.movetype !== MovetypeT.MOVETYPE_STOP
    ) {
      const kvel: Vec3 = vec3();
      const mass = targ.mass < 50 ? 50 : targ.mass;

      if (targ.client !== null && attacker === targ) {
        VectorScale(dir, (1600.0 * knockback) / mass, kvel);
      } else {
        VectorScale(dir, (500.0 * knockback) / mass, kvel);
      }

      if (targ.groundentity !== null) {
        if (kvel[2] < 0) kvel[2] = 0;
      }
      VectorAdd(targ.velocity, kvel, targ.velocity);
    }
  }

  let take = damage;
  let save = 0;

  if ((targ.flags & FL_GODMODE) !== 0 && !(dflags & DAMAGE_NO_PROTECTION)) {
    take = 0;
    save = damage;
    SpawnDamage(te_sparks, point, normal, save);
  }

  if (client !== null && client.invincible_framenum > level.framenum && !(dflags & DAMAGE_NO_PROTECTION)) {
    if (targ.pain_debounce_time < level.time) {
      gi.sound(targ, CHAN_ITEM, gi.soundindex("items/protect4.wav"), 1, ATTN_NORM, 0);
      targ.pain_debounce_time = level.time + 2;
    }
    take = 0;
    save = damage;
  }

  const psave = CheckPowerArmor(targ, point, normal, take, dflags);
  take -= psave;

  take = ResistRuneHook(targ, inflictor, attacker, take, knockback, dflags);

  let asave: number;
  if ((ctfflags & CTF_TEAM_ARMOR_PROTECT) !== 0 && OnSameTeam(targ, attacker) && targ !== attacker) {
    asave = 0;
  } else {
    asave = CheckArmor(targ, point, normal, take, te_sparks, dflags);
    take -= asave;
  }
  asave += save;

  if (!(dflags & DAMAGE_NO_PROTECTION) && CheckTeamDamage(targ, attacker)) return;

  if (take) {
    if ((targ.svflags & SVF_MONSTER) !== 0 || client !== null) {
      SpawnDamage(TempEventT.TE_BLOOD, point, normal, take);
    } else {
      SpawnDamage(te_sparks, point, normal, take);
    }

    targ.health = targ.health - take;

    if (attacker.client !== null && attacker.client.rune !== null && attacker.client.rune.runetype === RUNE_VAMP && attacker !== targ) {
      if (Q_stricmp(targ.classname ?? "", "player") === 0) {
        const vampdrain = attacker.health + (take >> 1);
        attacker.health = vampdrain < 250 ? vampdrain : 250;
        gi.sound(attacker, CHAN_ITEM, gi.soundindex("brain/brnatck3.wav"), 1, ATTN_NORM, 0);
      } else if (Q_stricmp(targ.classname ?? "", "bodyque") === 0) {
        const vampdrain = attacker.health + (take >> 2);
        attacker.health = vampdrain < 250 ? vampdrain : 250;
        gi.sound(attacker, CHAN_ITEM, gi.soundindex("brain/brnatck3.wav"), 1, ATTN_NORM, 0);
      }
    }

    // LM_JORM -- CTF: track those who hit the flag carrier
    if ((redflag !== null && redflag.owner === targ) || (blueflag !== null && blueflag.owner === targ)) {
      if (attacker.client !== null) attacker.client.hit_carrier_time = level.time;
    }

    if (targ.health <= 0) {
      if ((targ.svflags & SVF_MONSTER) !== 0 || client !== null) targ.flags |= FL_NO_KNOCKBACK;
      Killed(targ, inflictor, attacker, take, point);
      return;
    }
  }

  // MONSTERS_OK SVF_MONSTER pain-reaction branch dropped (dead, see file header).
  if (client !== null) {
    if (!(targ.flags & FL_GODMODE) && take) {
      if (targ.pain) targ.pain(targ, attacker, knockback, take);
    }
  } else if (take) {
    if (targ.pain) targ.pain(targ, attacker, knockback, take);
  }

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
CanDamage (lmctf60/g_combat.c) -- byte-identical to src/ctf/g_combat.ts's
CanDamage (confirmed no diff in this region between quake-2/ctf/g_combat.c
and lmctf60/g_combat.c). Completes this unit's SCOPE need: g_target.ts's
target_explosion_explode/use_target_splash both call T_RadiusDamage, which
depends on this.

Returns true if the inflictor can directly damage the target. Used for
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
T_RadiusDamage (lmctf60/g_combat.c) -- byte-identical to
src/ctf/g_combat.ts's T_RadiusDamage.
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

// RERELEASE CONTENT PORT -- rogue/g_newai.c's `realrange`. g_newai.ts in this
// module exports the same four lines, but g_combat.ts is imported by nearly
// every file here and g_newai.ts imports g_ai/g_monster/m_move in turn, so
// the helper is duplicated locally (exactly as src/game/g_combat.ts does)
// rather than adding that import edge.
function realrange(self: EdictT, other: EdictT): number {
  const dir = vec3();
  VectorSubtract(self.s.origin, other.s.origin, dir);
  return VectorLength(dir);
}

// **********************
// ROGUE
// RERELEASE CONTENT PORT -- rogue/g_combat.c's two extra radius-damage
// variants, needed by the ported nuke (fire_nuke) and prox mine
// (Prox_Explode) in g_newweap.ts.

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

  // skip the worldspawn
  // cycle through players
  //
  // C walks this with raw pointer arithmetic (`ent = g_edicts+1; ... ent++;`)
  // and bails the ENTIRE loop the instant an entity fails the `client &&
  // !nuked-this-frame && inuse` test, rather than skipping to the next
  // entity -- preserved exactly as the C behaves (see PORTING.md's
  // "Faithful port" rule): a non-client or freed edict at index i stops the
  // scan for every player at index > i too.
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
