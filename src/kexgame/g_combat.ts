// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_combat.c -- the core damage pipeline for the game module (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_combat.cpp (911 lines, C++17):
// CanDamage, Killed, SpawnDamage, T_Damage (armor/power-armor/resistances),
// T_RadiusDamage, CheckTeamDamage, OnSameTeam, M_ReactToDamage. Checked
// against the legacy vanilla port (src/game/g_combat.ts) for orientation
// only -- every genuine difference below is resolved in the C++'s favor,
// per this unit's brief.
//
// This file also resolves g_utils.ts's own `T_Damage` throwing stub (see
// that file's header): g_utils.ts now imports the real `T_Damage` below.
// KillBox (g_utils.ts) is the only caller; see that file's one-line diff.
//
// ============================================================================
// IMPORT CYCLE: g_utils.ts <-> g_combat.ts
// ============================================================================
// g_utils.ts imports `T_Damage` from here (KillBox's telefrag call);
// this file imports `findradius` from g_utils.ts (T_RadiusDamage's scan).
// Both uses are inside function bodies, never read at module-evaluation
// time, so live ES-module bindings resolve the cycle without a TDZ error --
// no need for the `require()` escape hatch PORTING.md documents for cycles
// that DO break init.
//
// ============================================================================
// EXTERNAL DEPENDENCIES NOT YET PORTED (see g_utils.ts's own section for the
// established idiom this follows: throwing, unexported, cited stubs)
// ============================================================================
// g_combat.cpp calls several functions this port line hasn't ported yet.
// `visible`/`FoundTarget` (g_ai.cpp:392/484) were formerly local throwing
// stubs here -- both are now real imports from src/kexgame/g_ai.ts (that
// unit has landed; see g_ai.ts's own "STUB SWAP" header section). They were
// reached UNCONDITIONALLY on their respective M_ReactToDamage branches
// (`visible`: a monster with a live `.client` enemy reacting to a NEW client
// attacker; `FoundTarget`: whenever M_ReactToDamage acquires/changes a
// monster's enemy and the monster isn't AI_DUCKED -- the COMMON case for "a
// fresh monster takes its first hit from a player"), so this is also where
// the "an unported cross-dep that's actually unconditionally reachable can't
// be a throwing stub without breaking every caller" rule first got written
// down for this file, before g_ai.ts existed to satisfy it for real. The
// rest were reached only on genuinely guarded, narrow paths and were
// throwing stubs until this file's own "STUB SWAP: MarkTeslaArea/TargetTesla"
// note below.
//
// ============================================================================
// STUB SWAP: cleanupHealTarget is now a real import from m_medic.ts
// ============================================================================
// `cleanupHealTarget` (rogue/g_rogue_combat.cpp:13, reached from Killed's
// AI_MEDIC-cleanup branch whenever a monster with a live `.enemy` dies while
// AI_MEDIC is set) was formerly a local throwing stub here -- it is now a
// real import from src/kexgame/m_medic.ts (that unit has landed). This
// creates a real, sanctioned, TWO-WAY import cycle: this file imports
// `cleanupHealTarget` from m_medic.ts, while m_medic.ts imports `T_Damage`
// back from here (abortHeal's gib-damage branch). Both cross-module symbols
// are hoisted `export function` declarations, and both uses are inside
// function bodies (`Killed`/`abortHeal`), never read at module-evaluation
// time -- no TDZ hazard, matching the shape and safety argument of every
// other sanctioned cycle in this port line (g_utils.ts<->g_phys.ts,
// g_utils.ts<->g_combat.ts, g_phys.ts<->g_monster.ts). Verified end-to-end
// by `bunx tsc --noEmit` actually importing both files together.
//
// ============================================================================
// STUB SWAP: MarkTeslaArea / TargetTesla are now real imports from
// rogue/g_rogue_newai.ts
// ============================================================================
// Both (rogue/g_rogue_newai.cpp:1019/1472) were local throwing stubs, reached
// only when `inflictor.classname === "tesla_mine"` in `Killed`'s
// damage-redirect branch. Both are now real imports from
// "./rogue/g_rogue_newai", now landed. This file does not import anything
// g_rogue_newai.ts imports back from it, so this is a plain one-way edge,
// not a cycle.
//
// ============================================================================
// ArmorIndex / PowerArmorType / G_CheckPowerArmor -- ported here, not g_items.ts
// ============================================================================
// All three are declared in g_items.cpp (lines 726, 827, 306 respectively --
// a file that hasn't landed in this port line yet), but CheckArmor/
// CheckPowerArmor call them UNCONDITIONALLY on every T_Damage hit, so they
// can't be throwing stubs either. Read their C bodies closely: none of the
// three actually needs the itemlist/gitem_t machinery g_items.ts would
// provide -- they're pure field reads/writes against `EdictT`/`GClientT`
// fields already fully typed in this port line (inventory counts, monsterinfo
// power-armor fields, the FL_POWER_ARMOR/FL_WANTS_POWER_ARMOR flags). Ported
// verbatim here as small, self-contained functions; a future g_items.ts unit
// is free to re-export them from there instead once it lands, without any
// call site here changing.
//
// ============================================================================
// GetItemByIndex(index)->armor_info -- mapped directly, not resolved via the
// itemlist
// ============================================================================
// `CheckArmor`'s C body resolves `armor_info` via `GetItemByIndex(index)`,
// which needs the full `itemlist[]` (g_items.cpp, not ported). But `index`
// here is always ArmorIndex()'s return value, which -- by ArmorIndex's own
// body, ported above -- can only ever be IT_ARMOR_JACKET/IT_ARMOR_COMBAT/
// IT_ARMOR_BODY/IT_NULL (IT_NULL is filtered by CheckArmor's own `if
// (!index) return 0;` before this lookup runs). g_local_types.ts already
// ports the exact three `gitem_armor_t` constants those three IDs resolve to
// (`jacketarmor_info`/`combatarmor_info`/`bodyarmor_info`) -- `armorInfoFor`
// below maps directly to those instead of resolving through the (absent)
// itemlist, with a defensive throw if that invariant is ever violated.
//
// ============================================================================
// STAT_HIT_MARKER -- restored (2026-08-30 cleanup sweep)
// ============================================================================
// C (g_combat.cpp:717-719):
//   if (targ != attacker && attacker->client && targ->health > 0 &&
//       !((targ->svflags & SVF_DEADMONSTER) || (targ->flags & FL_NO_DAMAGE_EFFECTS)) &&
//       mod.id != MOD_TARGET_LASER)
//     attacker->client->ps.stats[STAT_HIT_MARKER] += take + psave + asave;
// Previously dropped here because `STAT_HIT_MARKER`'s numeric index wasn't
// ported anywhere yet and hand-guessing it risked writing the wrong HUD
// stat slot. p_hud.ts has since landed the real `PlayerStatT` enum
// (`STAT_HIT_MARKER = 50`), so the write is restored using that import
// (real, sanctioned import cycle: p_hud.ts already imports
// `ArmorIndex`/`PowerArmorType` from this file; `PlayerStatT` is only
// referenced inside this function body, never at module-eval time).
//
// ============================================================================
// CTFMatchSetup / DMGame -- concrete faithful values, not stubs (see their
// own comments)
// ============================================================================
// Both are read UNCONDITIONALLY inside T_Damage. `ctfgame` (CTFMatchSetup's
// backing global) and a rogue-ruleset-populated `DMGame` are both out of
// scope; see each's own comment below for why a concrete default is the
// faithful choice rather than a throwing stub.
//
// ============================================================================
// mod_t is a BY-VALUE parameter in C (`mod_t mod`, not `const mod_t&`)
// ============================================================================
// T_Damage's own local `mod` must not alias the caller's `ModT` object (C
// gets an independent copy on the stack); a `{ ...modIn }` clone is taken at
// entry, and every later "store a mod_t into a field" site
// (`targ.lastMOD`/`targ.monsterinfo.damage_mod`) clones AGAIN so those two
// stored copies don't alias each other either -- matching two independent
// struct-copy assignments in C.

import { type Vec3, vec3 } from "../shared/math";
import {
  ATTN_NORM,
  ContentsT,
  CvarFlagsT,
  KexMulticastT,
  KexTempEventT,
  MASK_SOLID,
  ServerCommandT,
  SoundchanT,
  SolidT,
  SvflagsT,
} from "../kexapi/game";
import {
  AUTO_SHIELD_AUTO,
  AUTO_SHIELD_MANUAL,
  COOP_DAMAGE_RESPAWN_TIME,
  type DamageIndicatorT,
  DamageflagsT,
  type DmGameRt,
  type EdictT,
  EntFlagsT,
  type GitemArmorT,
  ItemIdT,
  jacketarmor_info,
  combatarmor_info,
  bodyarmor_info,
  MAX_DAMAGE_INDICATORS,
  ModIdT,
  type ModT,
  MonsterAiFlagsT,
  MovetypeT,
  random_time,
  SPHERE_DEFENDER,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { Gtime_add, Gtime_from_ms, Gtime_from_sec } from "./gtime";
import { findradius } from "./g_utils";
import { AngleVectors, closest_point_to_box, vec3_add, vec3_addEq, vec3_dot, vec3_length, vec3_muls, vec3_normalized, vec3_sub } from "./q_vec3";
import { brandom } from "./q_std";
import { visible, FoundTarget } from "./g_ai";
import { cleanupHealTarget } from "./m_medic";
import { MarkTeslaArea, TargetTesla } from "./rogue/g_rogue_newai";
import { CTFApplyResistance, CTFApplyStrength, CTFCheckHurtCarrier, CTFMatchSetup } from "./ctf/g_ctf";
import { PlayerStatT } from "./p_hud";

// ---------------------------------------------------------------------------
// cvar-read helpers (see g_utils.ts's own `coopEnabled()` precedent for the
// same CvarT.value-not-.integer workaround this file's header doesn't need
// to repeat)
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

// MarkTeslaArea / TargetTesla are now real imports from
// "./rogue/g_rogue_newai" -- see that file's header for the swap note.

// ---------------------------------------------------------------------------
// CanDamage
// ---------------------------------------------------------------------------

/**
 * g_combat.cpp:15-77: `bool CanDamage(edict_t *targ, edict_t *inflictor)`.
 * Returns true if the inflictor can directly damage the target (used for
 * explosions and melee attacks). NOTE: this is genuinely different from the
 * legacy/vanilla port's `CanDamage` (src/game/g_combat.ts) -- that version
 * branches on `targ.movetype === MOVETYPE_PUSH`; this KEX source branches on
 * `targ->solid == SOLID_BSP` instead, and always additionally checks the
 * five rays against `targ_center` regardless of solidity (the legacy port
 * returns early after just the bmodel check). Ported from the C++ body, not
 * the legacy TS.
 */
export function CanDamage(targ: EdictT, inflictor: EdictT): boolean {
  const inflictor_center: Vec3 = inflictor.linked ? vec3_muls(vec3_add(inflictor.absmin, inflictor.absmax), 0.5) : inflictor.s.origin;

  if (targ.solid === SolidT.SOLID_BSP) {
    const dest = closest_point_to_box(inflictor_center, targ.absmin, targ.absmax);
    const trace = gi.trace(inflictor_center, null, null, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  const targ_center: Vec3 = targ.linked ? vec3_muls(vec3_add(targ.absmin, targ.absmax), 0.5) : targ.s.origin;

  {
    const trace = gi.trace(inflictor_center, null, null, targ_center, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  // the four corner offsets, in the C source's own order
  const offsets: [number, number][] = [
    [15.0, 15.0],
    [15.0, -15.0],
    [-15.0, 15.0],
    [-15.0, -15.0],
  ];
  for (const [dx, dy] of offsets) {
    const dest = vec3(targ_center[0] + dx, targ_center[1] + dy, targ_center[2]);
    const trace = gi.trace(inflictor_center, null, null, dest, inflictor, MASK_SOLID);
    if (trace.fraction === 1.0) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Killed
// ---------------------------------------------------------------------------

/**
 * g_combat.cpp:84-112: `void Killed(...)`. Genuinely different from the
 * legacy/vanilla port's `Killed`: this KEX version does NOT touch
 * `deadflag`, does NOT gib, and for SVF_MONSTER targets does nothing but
 * record `enemy`/`lastMOD` and RETURN -- the comment is explicit: "[Paril-KEX]
 * monsters call die in their damage handler", i.e. a monster's own die()
 * dispatch happens elsewhere (m_move.ts/the monster's own pain handler, not
 * here). `targ.die(...)` and `targ.monsterinfo.setskin(...)` below therefore
 * only ever run for NON-monster targets (players, breakables, doors, ...).
 */
export function Killed(targ: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3, mod: ModT): void {
  if (targ.health < -999) targ.health = -999;

  // [Paril-KEX]
  if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    if (targ.enemy !== null && targ.enemy.inuse && (targ.enemy.svflags & SvflagsT.SVF_MONSTER) !== 0) {
      cleanupHealTarget(targ.enemy);
    }
    // clean up self
    targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
  }

  targ.enemy = attacker;
  targ.lastMOD = { ...mod }; // by-value store -- see file header

  // [Paril-KEX] monsters call die in their damage handler
  if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0) return;

  // C dereferences targ->die unconditionally; see g_utils.ts's identical
  // "TS cannot express an unchecked deref through a nullable field" note
  // (its own G_UseTargets/CheckArmor precedent) for why this guards instead.
  if (targ.die !== null) {
    targ.die(targ, inflictor, attacker, damage, point, mod);
  }

  if (targ.monsterinfo.setskin !== null) targ.monsterinfo.setskin(targ);
}

// ---------------------------------------------------------------------------
// SpawnDamage
// ---------------------------------------------------------------------------

/** g_combat.cpp:119-129: `void SpawnDamage(...)`. */
export function SpawnDamage(type: number, origin: Vec3, normal: Vec3, damage: number): void {
  if (damage > 255) damage = 255;
  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(type);
  gi.WritePosition(origin);
  gi.WriteDir(normal);
  gi.multicast(origin, KexMulticastT.MULTICAST_PVS, false);
}

// ---------------------------------------------------------------------------
// ArmorIndex / PowerArmorType / G_CheckPowerArmor -- see file header
// ---------------------------------------------------------------------------

/** g_items.cpp:726: `item_id_t ArmorIndex(edict_t *ent)`. */
export function ArmorIndex(ent: EdictT): ItemIdT {
  if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) return ent.monsterinfo.armor_type;

  if (ent.client !== null) {
    if (ent.client.pers.inventory[ItemIdT.IT_ARMOR_JACKET] > 0) return ItemIdT.IT_ARMOR_JACKET;
    if (ent.client.pers.inventory[ItemIdT.IT_ARMOR_COMBAT] > 0) return ItemIdT.IT_ARMOR_COMBAT;
    if (ent.client.pers.inventory[ItemIdT.IT_ARMOR_BODY] > 0) return ItemIdT.IT_ARMOR_BODY;
  }

  return ItemIdT.IT_NULL;
}

/** g_items.cpp:827: `item_id_t PowerArmorType(edict_t *ent)`. */
export function PowerArmorType(ent: EdictT): ItemIdT {
  if (ent.client === null) return ItemIdT.IT_NULL;
  if ((ent.flags & EntFlagsT.FL_POWER_ARMOR) === 0n) return ItemIdT.IT_NULL;
  if (ent.client.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] > 0) return ItemIdT.IT_ITEM_POWER_SHIELD;
  if (ent.client.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] > 0) return ItemIdT.IT_ITEM_POWER_SCREEN;
  return ItemIdT.IT_NULL;
}

/** g_items.cpp:306: `void G_CheckPowerArmor(edict_t *ent)`. C dereferences
 *  `ent->client` unconditionally (only ever called with one, per
 *  CheckPowerArmor's own `if (ent->client)` guard below). */
function G_CheckPowerArmor(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let has_enough_cells: boolean;
  if (client.pers.inventory[ItemIdT.IT_AMMO_CELLS] === 0) {
    has_enough_cells = false;
  } else if (client.pers.autoshield >= AUTO_SHIELD_AUTO) {
    has_enough_cells =
      (ent.flags & EntFlagsT.FL_WANTS_POWER_ARMOR) !== 0n && client.pers.inventory[ItemIdT.IT_AMMO_CELLS] > client.pers.autoshield;
  } else {
    has_enough_cells = true;
  }

  if ((ent.flags & EntFlagsT.FL_POWER_ARMOR) !== 0n) {
    if (!has_enough_cells) {
      // ran out of cells for power armor
      ent.flags &= ~EntFlagsT.FL_POWER_ARMOR;
      gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
    }
  } else if (
    client.pers.autoshield !== AUTO_SHIELD_MANUAL &&
    has_enough_cells &&
    (client.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] !== 0 || client.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] !== 0)
  ) {
    // special case for power armor, for auto-shields
    ent.flags |= EntFlagsT.FL_POWER_ARMOR;
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
  }
}

// ---------------------------------------------------------------------------
// CheckPowerArmor / CheckArmor
// ---------------------------------------------------------------------------

/** g_combat.cpp:155-269: `static int CheckPowerArmor(...)`. Exported (not
 *  module-private) so this unit's own tests can exercise it directly --
 *  same rationale the legacy port's own `CheckPowerArmor` documents. */
export function CheckPowerArmor(ent: EdictT, point: Vec3, normal: Vec3, damageIn: number, dflags: DamageflagsT): number {
  let damage = damageIn;

  if (ent.health <= 0) return 0;
  if (!damage) return 0;

  const client = ent.client;

  if ((dflags & (DamageflagsT.DAMAGE_NO_ARMOR | DamageflagsT.DAMAGE_NO_POWER_ARMOR)) !== 0) return 0;

  let power_armor_type: ItemIdT;
  let power: number;
  let writePower: (v: number) => void;

  if (client !== null) {
    power_armor_type = PowerArmorType(ent);
    power = client.pers.inventory[ItemIdT.IT_AMMO_CELLS];
    writePower = (v) => {
      client.pers.inventory[ItemIdT.IT_AMMO_CELLS] = v;
    };
  } else if ((ent.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    power_armor_type = ent.monsterinfo.power_armor_type;
    power = ent.monsterinfo.power_armor_power;
    writePower = (v) => {
      ent.monsterinfo.power_armor_power = v;
    };
  } else {
    return 0;
  }

  if (power_armor_type === ItemIdT.IT_NULL) return 0;
  if (!power) return 0;

  let damagePerCell: number;
  let pa_te_type: number;

  if (power_armor_type === ItemIdT.IT_ITEM_POWER_SCREEN) {
    // only works if damage point is in front
    const forward = vec3();
    AngleVectors(ent.s.angles, forward, null, null);
    const vec = vec3_normalized(vec3_sub(point, ent.s.origin));
    const dot = vec3_dot(vec, forward);
    if (dot <= 0.3) return 0;

    damagePerCell = 1;
    pa_te_type = KexTempEventT.TE_SCREEN_SPARKS;
    damage = Math.trunc(damage / 3);
  } else {
    damagePerCell = cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) ? 1 : 2; // power armor is weaker in CTF
    pa_te_type = KexTempEventT.TE_SCREEN_SPARKS;
    damage = Math.trunc((2 * damage) / 3);
  }

  // Paril: fix small amounts of damage not being absorbed
  damage = Math.max(1, damage);

  let save = power * damagePerCell;
  if (!save) return 0;

  // [Paril-KEX] energy damage should do more to power armor
  if ((dflags & DamageflagsT.DAMAGE_ENERGY) !== 0) save = Math.max(1, Math.trunc(save / 2));

  if (save > damage) save = damage;

  let power_used: number;
  if ((dflags & DamageflagsT.DAMAGE_ENERGY) !== 0) power_used = Math.trunc(save / damagePerCell) * 2;
  else power_used = Math.trunc(save / damagePerCell);
  power_used = Math.max(1, power_used);

  SpawnDamage(pa_te_type, point, normal, save);
  ent.powerarmor_time = Gtime_add(level.time, Gtime_from_ms(200));

  // Paril: adjustment so that power armor always uses damagePerCell even if
  // it does only a single point of damage
  const newPower = Math.max(0, power - Math.max(damagePerCell, power_used));
  writePower(newPower);

  // check power armor turn-off states
  if (ent.client !== null) {
    G_CheckPowerArmor(ent);
  } else if (newPower === 0) {
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/mon_power2.wav"), 1, ATTN_NORM, 0);
    gi.WriteByte(ServerCommandT.svc_temp_entity);
    gi.WriteByte(KexTempEventT.TE_POWER_SPLASH);
    gi.WriteEntity(ent);
    gi.WriteByte(power_armor_type === ItemIdT.IT_ITEM_POWER_SCREEN ? 1 : 0);
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PHS, false);
  }

  return save;
}

/** g_local.h's `jacketarmor_info`/`combatarmor_info`/`bodyarmor_info` --
 *  see file header's "GetItemByIndex(index)->armor_info" note. */
function armorInfoFor(index: ItemIdT): GitemArmorT {
  switch (index) {
    case ItemIdT.IT_ARMOR_JACKET:
      return jacketarmor_info;
    case ItemIdT.IT_ARMOR_COMBAT:
      return combatarmor_info;
    case ItemIdT.IT_ARMOR_BODY:
      return bodyarmor_info;
    default:
      throw new Error(`CheckArmor: unexpected armor index ${index} (ArmorIndex should only ever return JACKET/COMBAT/BODY/NULL)`);
  }
}

/** g_combat.cpp:271-320: `static int CheckArmor(...)`. Exported for the same
 *  reason `CheckPowerArmor` is. */
export function CheckArmor(ent: EdictT, point: Vec3, normal: Vec3, damage: number, te_sparks: number, dflags: DamageflagsT): number {
  if (!damage) return 0;

  // ROGUE
  if ((dflags & (DamageflagsT.DAMAGE_NO_ARMOR | DamageflagsT.DAMAGE_NO_REG_ARMOR)) !== 0) return 0;
  // ROGUE

  const client = ent.client;
  const index = ArmorIndex(ent);
  if (index === ItemIdT.IT_NULL) return 0;

  const armorInfo = armorInfoFor(index);

  let save: number;
  if ((dflags & DamageflagsT.DAMAGE_ENERGY) !== 0) {
    save = Math.ceil(armorInfo.energy_protection * damage);
  } else {
    save = Math.ceil(armorInfo.normal_protection * damage);
  }

  const power = client !== null ? client.pers.inventory[index] : ent.monsterinfo.armor_power;

  if (save >= power) save = power;
  if (!save) return 0;

  const newPower = power - save;
  if (client !== null) {
    client.pers.inventory[index] = newPower;
  } else {
    ent.monsterinfo.armor_power = newPower;
    if (newPower === 0) ent.monsterinfo.armor_type = ItemIdT.IT_NULL;
  }

  SpawnDamage(te_sparks, point, normal, save);

  return save;
}

// ---------------------------------------------------------------------------
// M_ReactToDamage
// ---------------------------------------------------------------------------

/**
 * g_combat.cpp:322-490: `void M_ReactToDamage(...)`. `inflictor` is typed
 * non-null `EdictT` throughout this port line (matching T_Damage's own
 * signature and g_utils.ts's pre-existing T_Damage stub) -- C's `if
 * (inflictor)` guard around the tesla check is therefore always true here
 * and is omitted as dead code under this port's typing, per that same
 * established non-nullable-EdictT-parameter convention.
 */
export function M_ReactToDamage(targ: EdictT, attacker: EdictT, inflictor: EdictT): void {
  if (attacker.client === null && (attacker.svflags & SvflagsT.SVF_MONSTER) === 0) return;

  //=======
  // ROGUE
  // logic for tesla - if you are hit by a tesla, and can't see who you
  // should be mad at (attacker), attack the tesla; also target the tesla if
  // it's a "new" tesla
  if (inflictor.classname === "tesla_mine") {
    const new_tesla = MarkTeslaArea(targ, inflictor);
    if ((new_tesla || brandom()) && (targ.enemy === null || targ.enemy.classname === null || targ.enemy.classname !== "tesla_mine")) {
      TargetTesla(targ, inflictor);
    }
    return;
  }
  // ROGUE
  //=======

  if (attacker === targ || attacker === targ.enemy) return;

  // if we are a good guy monster and our attacker is a player or another
  // good guy, do not get mad at them
  if ((targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) {
    if (attacker.client !== null || (attacker.monsterinfo.aiflags & MonsterAiFlagsT.AI_GOOD_GUY) !== 0n) return;
  }

  // PGM
  // if we're currently mad at something a target_anger made us mad at,
  // ignore damage
  if (targ.enemy !== null && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_TARGET_ANGER) !== 0n) {
    // make sure whatever we were pissed at is still around.
    if (targ.enemy.inuse) {
      const percentHealth = targ.health / targ.max_health;
      if (targ.enemy.inuse && percentHealth > 0.33) return;
    }
    targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_TARGET_ANGER;
  }
  // PGM

  // we recently switched from reacting to damage, don't do it
  if (targ.monsterinfo.react_to_damage_time > level.time) return;

  // PMM
  // if we're healing someone, do like above and try to stay with them
  if (targ.enemy !== null && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
    const percentHealth = targ.health / targ.max_health;
    // ignore it some of the time
    if (targ.enemy.inuse && percentHealth > 0.25) return;

    cleanupHealTarget(targ.enemy);
    targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
  }
  // PMM

  // we now know that we are not both good guys
  targ.monsterinfo.react_to_damage_time = Gtime_add(level.time, random_time(Gtime_from_sec(3), Gtime_from_sec(5)));

  // if attacker is a client, get mad at them because he's good and we're not
  if (attacker.client !== null) {
    targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_SOUND_TARGET;

    // this can only happen in coop (both new and old enemies are clients)
    // only switch if can't see the current enemy
    if (targ.enemy !== attacker) {
      if (targ.enemy !== null && targ.enemy.client !== null) {
        if (visible(targ, targ.enemy)) {
          targ.oldenemy = attacker;
          return;
        }
        targ.oldenemy = targ.enemy;
      }

      // [Paril-KEX]
      if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
        if (targ.enemy !== null && targ.enemy.inuse && (targ.enemy.svflags & SvflagsT.SVF_MONSTER) !== 0) {
          cleanupHealTarget(targ.enemy);
        }
        targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
      }

      targ.enemy = attacker;
      if ((targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) === 0n) FoundTarget(targ);
    }
    return;
  }

  if (
    attacker.enemy === targ || // if they *meant* to shoot us, then shoot back
    // it's the same base (walk/swim/fly) type and both don't ignore shots, get mad at them
    ((targ.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) === (attacker.flags & (EntFlagsT.FL_FLY | EntFlagsT.FL_SWIM)) &&
      targ.classname !== attacker.classname &&
      (attacker.monsterinfo.aiflags & MonsterAiFlagsT.AI_IGNORE_SHOTS) === 0n &&
      (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_IGNORE_SHOTS) === 0n)
  ) {
    if (targ.enemy !== attacker) {
      // [Paril-KEX]
      if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
        if (targ.enemy !== null && targ.enemy.inuse && (targ.enemy.svflags & SvflagsT.SVF_MONSTER) !== 0) {
          cleanupHealTarget(targ.enemy);
        }
        targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
      }

      if (targ.enemy !== null && targ.enemy.client !== null) targ.oldenemy = targ.enemy;
      targ.enemy = attacker;
      if ((targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) === 0n) FoundTarget(targ);
    }
  }
  // otherwise get mad at whoever they are mad at (help our buddy) unless it is us!
  else if (attacker.enemy !== null && attacker.enemy !== targ && targ.enemy !== attacker.enemy) {
    if (targ.enemy !== attacker.enemy) {
      // [Paril-KEX]
      if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 && (targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_MEDIC) !== 0n) {
        if (targ.enemy !== null && targ.enemy.inuse && (targ.enemy.svflags & SvflagsT.SVF_MONSTER) !== 0) {
          cleanupHealTarget(targ.enemy);
        }
        targ.monsterinfo.aiflags &= ~MonsterAiFlagsT.AI_MEDIC;
      }

      if (targ.enemy !== null && targ.enemy.client !== null) targ.oldenemy = targ.enemy;
      targ.enemy = attacker.enemy;
      if ((targ.monsterinfo.aiflags & MonsterAiFlagsT.AI_DUCKED) === 0n) FoundTarget(targ);
    }
  }
}

// ---------------------------------------------------------------------------
// OnSameTeam / CheckTeamDamage
// ---------------------------------------------------------------------------

/** g_combat.cpp:506-514 (ctf/g_ctf.cpp:56): `bool G_TeamplayEnabled()`. */
function G_TeamplayEnabled(): boolean {
  return (
    cvarBool("ctf", "0", CvarFlagsT.CVAR_SERVERINFO | CvarFlagsT.CVAR_LATCH) || cvarBool("teamplay", "0", CvarFlagsT.CVAR_LATCH)
  );
}

/** g_combat.cpp:493-514: `bool OnSameTeam(edict_t *ent1, edict_t *ent2)`. */
export function OnSameTeam(ent1: EdictT, ent2: EdictT): boolean {
  // monsters are never on our team atm
  if (ent1.client === null || ent2.client === null) return false;
  // we're never on our own team
  if (ent1 === ent2) return false;

  // [Paril-KEX] coop 'team' support -- every client is on the same team in
  // coop, unconditionally (ent1.client/ent2.client are both already known
  // non-null above).
  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) return true;

  // ZOID
  if (G_TeamplayEnabled()) {
    if (ent1.client.resp.ctf_team === ent2.client.resp.ctf_team) return true;
  }
  // ZOID

  return false;
}

/**
 * g_combat.cpp:518-525: `bool CheckTeamDamage(edict_t *targ, edict_t
 * *attacker)`. NOTE: unlike the legacy/vanilla port, T_Damage in THIS
 * source does NOT call this function -- it inlines the equivalent
 * OnSameTeam check directly in its own "friendly fire avoidance" block
 * below (also gated on `g_friendly_fire`, not `dmflags`/DF_NO_FRIENDLY_FIRE
 * like the legacy port). `CheckTeamDamage` is ported here anyway since it's
 * a real exported function in this file; it simply isn't on T_Damage's own
 * call path in this KEX source.
 */
export function CheckTeamDamage(targ: EdictT, attacker: EdictT): boolean {
  // always damage teammates if friendly fire is enabled
  if (cvarBool("g_friendly_fire", "0", CvarFlagsT.CVAR_NOFLAGS)) return false;

  return OnSameTeam(targ, attacker);
}

// ---------------------------------------------------------------------------
// CTF helpers T_Damage calls unconditionally -- REAL imports from
// ctf/g_ctf.ts (this unit's own module). CTFApplyStrength/CTFApplyResistance/
// CTFCheckHurtCarrier used to be real, local copies here; CTFMatchSetup used
// to be pinned `return false` (a full CTF match-flow port was out of scope
// for whichever unit landed them first). ctf/g_ctf.ts now owns the real
// `ctfgame` match-state global and every one of these for real; this file
// imports them instead of carrying its own copies. See ctf/g_ctf.ts's own
// header for the full consolidation inventory and the sanctioned import
// cycle this creates (g_combat.ts <-> p_client.ts <-> ctf/g_ctf.ts, etc.).
// ---------------------------------------------------------------------------


/**
 * g_local.h:3275 `extern dm_game_rt DMGame;` -- real assignment lives in
 * rogue/g_rogue_newdm.cpp:322-359's `InitGameRules()`. Modeled as a local,
 * all-null default: T_Damage's own `if (deathmatch->integer &&
 * gamerules->integer)` guard keeps every DMGame.* read unreachable as long
 * as `gamerules` sits at its registered default of 0 (g_main.cpp:282) --
 * exactly a stock (non-rogue-ruleset) server's real behavior.
 *
 * NOT "out of scope" anymore (2026-08-30 stale-comment sweep):
 * rogue/g_rogue_newdm.ts has since landed a real, exported `InitGameRules`
 * that populates ITS OWN local `DMGame` object -- a SEPARATE binding from
 * this one. g_main.ts's own `InitGameRules` call site still uses a local
 * throwing stub rather than that real function specifically BECAUSE wiring
 * it in would populate a `DMGame` object this file never reads, silently
 * no-op'ing every ChangeDamage/ChangeKnockback hook even with `gamerules`
 * set -- see g_main.ts's own `InitGameRules` doc comment for the full
 * finding. Unifying the two bindings (an exported setter here, matching
 * p_view.ts's `SetXyspeed` precedent) is real, focused follow-up work,
 * flagged in .orch/followups.md.
 */
const DMGame: DmGameRt = {
  GameInit: null,
  PostInitSetup: null,
  ClientBegin: null,
  SelectSpawnPoint: null,
  PlayerDeath: null,
  Score: null,
  PlayerEffects: null,
  DogTag: null,
  PlayerDisconnect: null,
  ChangeDamage: null,
  ChangeKnockback: null,
  CheckDMRules: null,
};

// ---------------------------------------------------------------------------
// T_Damage
// ---------------------------------------------------------------------------

/**
 * g_combat.cpp:527-860: `void T_Damage(...)`. The core damage pipeline --
 * see the file header for the by-value `mod` clone, the STAT_HIT_MARKER
 * write, and the CTFMatchSetup/DMGame notes.
 */
export function T_Damage(
  targ: EdictT,
  inflictor: EdictT,
  attacker: EdictT,
  dirIn: Vec3,
  point: Vec3,
  normal: Vec3,
  damageIn: number,
  knockbackIn: number,
  dflags: DamageflagsT,
  modIn: ModT,
): void {
  if (!targ.takedamage) return;

  let damage = damageIn;
  let knockback = knockbackIn;
  const mod: ModT = { ...modIn }; // by-value parameter -- see file header

  if (cvarBool("g_instagib", "0", CvarFlagsT.CVAR_NOFLAGS) && attacker.client !== null && targ.client !== null) {
    // [Kex] always kill no matter what on instagib
    damage = 9999;
  }

  let sphere_notified = false; // PGM

  // friendly fire avoidance
  // if enabled you can't hurt teammates (but you can hurt yourself)
  // knockback still occurs
  if (targ !== attacker && (dflags & DamageflagsT.DAMAGE_NO_PROTECTION) === 0) {
    // mark as friendly fire
    if (OnSameTeam(targ, attacker)) {
      mod.friendly_fire = true;

      // if we're not a nuke & friendly fire is disabled, just kill the damage
      if (!cvarBool("g_friendly_fire", "0", CvarFlagsT.CVAR_NOFLAGS) && mod.id !== ModIdT.MOD_NUKE) {
        damage = 0;
      }
    }
  }

  // ROGUE
  // allow the deathmatch game to change values
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("gamerules", "0", CvarFlagsT.CVAR_LATCH)) {
    if (DMGame.ChangeDamage !== null) damage = DMGame.ChangeDamage(targ, attacker, damage, mod);
    if (DMGame.ChangeKnockback !== null) knockback = DMGame.ChangeKnockback(targ, attacker, knockback, mod);

    if (!damage) return;
  }
  // ROGUE

  // easy mode takes half damage
  if (cvarInt("skill", "1", CvarFlagsT.CVAR_LATCH) === 0 && !cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && targ.client !== null && damage) {
    damage = Math.trunc(damage / 2);
    if (!damage) damage = 1;
  }

  if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    damage = damage * cvarInt("ai_damage_scale", "1", CvarFlagsT.CVAR_NOFLAGS);
  } else {
    damage = damage * cvarInt("g_damage_scale", "1", CvarFlagsT.CVAR_NOFLAGS);
  } // mal: just for debugging...

  const client = targ.client;

  // PMM - defender sphere takes half damage
  if (damage && client !== null && client.owned_sphere !== null && client.owned_sphere.spawnflags === SPHERE_DEFENDER) {
    damage = Math.trunc(damage / 2);
    if (!damage) damage = 1;
  }

  const te_sparks = (dflags & DamageflagsT.DAMAGE_BULLET) !== 0 ? KexTempEventT.TE_BULLET_SPARKS : KexTempEventT.TE_SPARKS;

  // bonus damage for surprising a monster
  if (
    (dflags & DamageflagsT.DAMAGE_RADIUS) === 0 &&
    (targ.svflags & SvflagsT.SVF_MONSTER) !== 0 &&
    attacker.client !== null &&
    (targ.enemy === null || targ.monsterinfo.surprise_time === level.time) &&
    targ.health > 0
  ) {
    damage = damage * 2;
    targ.monsterinfo.surprise_time = level.time;
  }

  // ZOID
  // strength tech
  damage = CTFApplyStrength(attacker, damage);
  // ZOID

  if (
    (targ.flags & EntFlagsT.FL_NO_KNOCKBACK) !== 0n ||
    ((targ.flags & EntFlagsT.FL_ALIVE_KNOCKBACK_ONLY) !== 0n && (!targ.deadflag || targ.dead_time !== level.time))
  ) {
    knockback = 0;
  }

  // figure momentum add
  if ((dflags & DamageflagsT.DAMAGE_NO_KNOCKBACK) === 0) {
    if (
      knockback !== 0 &&
      targ.movetype !== MovetypeT.MOVETYPE_NONE &&
      targ.movetype !== MovetypeT.MOVETYPE_BOUNCE &&
      targ.movetype !== MovetypeT.MOVETYPE_PUSH &&
      targ.movetype !== MovetypeT.MOVETYPE_STOP
    ) {
      const normalized = vec3_normalized(dirIn); // fresh copy -- does NOT mutate the caller's `dirIn`, unlike the legacy port's in-place VectorNormalize(dir)
      const mass = targ.mass < 50 ? 50 : targ.mass;
      const kvel =
        targ.client !== null && attacker === targ
          ? vec3_muls(normalized, (1600.0 * knockback) / mass) // the rocket jump hack...
          : vec3_muls(normalized, (500.0 * knockback) / mass);

      vec3_addEq(targ.velocity, kvel);
    }
  }

  let take = damage;
  let save = 0;

  // check for godmode
  if ((targ.flags & EntFlagsT.FL_GODMODE) !== 0n && (dflags & DamageflagsT.DAMAGE_NO_PROTECTION) === 0) {
    take = 0;
    save = damage;
    SpawnDamage(te_sparks, point, normal, save);
  }

  // check for invincibility
  // ROGUE
  if (
    (dflags & DamageflagsT.DAMAGE_NO_PROTECTION) === 0 &&
    ((client !== null && client.invincible_time > level.time) || ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 && targ.monsterinfo.invincible_time > level.time))
  )
    // ROGUE
  {
    if (targ.pain_debounce_time < level.time) {
      gi.sound(targ, SoundchanT.CHAN_ITEM, gi.soundindex("items/protect4.wav"), 1, ATTN_NORM, 0);
      targ.pain_debounce_time = Gtime_add(level.time, Gtime_from_sec(2));
    }
    take = 0;
    save = damage;
  }

  // ZOID
  // team armor protect
  let psave: number;
  let asave: number;
  if (
    G_TeamplayEnabled() &&
    targ.client !== null &&
    attacker.client !== null &&
    targ.client.resp.ctf_team === attacker.client.resp.ctf_team &&
    targ !== attacker &&
    cvarBool("g_teamplay_armor_protect", "0", CvarFlagsT.CVAR_NOFLAGS)
  ) {
    psave = 0;
    asave = 0;
  } else {
    // ZOID
    psave = CheckPowerArmor(targ, point, normal, take, dflags);
    take -= psave;

    asave = CheckArmor(targ, point, normal, take, te_sparks, dflags);
    take -= asave;
  }

  // treat cheat/powerup savings the same as armor
  asave += save;

  // ZOID
  // resistance tech
  take = CTFApplyResistance(targ, take);
  // ZOID

  // ZOID
  CTFCheckHurtCarrier(targ, attacker);
  // ZOID

  // ROGUE - this option will do damage both to the armor and person.
  // originally for DPU rounds
  if ((dflags & DamageflagsT.DAMAGE_DESTROY_ARMOR) !== 0) {
    if (
      (targ.flags & EntFlagsT.FL_GODMODE) === 0n &&
      (dflags & DamageflagsT.DAMAGE_NO_PROTECTION) === 0 &&
      !(client !== null && client.invincible_time > level.time)
    ) {
      take = damage;
    }
  }
  // ROGUE

  // [Paril-KEX] player hit markers (g_combat.cpp:717-719)
  if (
    targ !== attacker &&
    attacker.client !== null &&
    targ.health > 0 &&
    (targ.svflags & SvflagsT.SVF_DEADMONSTER) === 0 &&
    (targ.flags & EntFlagsT.FL_NO_DAMAGE_EFFECTS) === 0n &&
    mod.id !== ModIdT.MOD_TARGET_LASER
  ) {
    attacker.client.ps.stats[PlayerStatT.STAT_HIT_MARKER] += take + psave + asave;
  }

  // do the damage
  if (take) {
    if ((targ.flags & EntFlagsT.FL_NO_DAMAGE_EFFECTS) === 0n) {
      // ROGUE
      if ((targ.flags & EntFlagsT.FL_MECHANICAL) !== 0n) {
        SpawnDamage(KexTempEventT.TE_ELECTRIC_SPARKS, point, normal, take);
        // ROGUE
      } else if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 || client !== null) {
        // XATRIX
        if (targ.classname === "monster_gekk") {
          SpawnDamage(KexTempEventT.TE_GREENBLOOD, point, normal, take);
          // XATRIX
          // ROGUE
        } else if (mod.id === ModIdT.MOD_CHAINFIST) {
          SpawnDamage(KexTempEventT.TE_MOREBLOOD, point, normal, 255);
          // ROGUE
        } else {
          SpawnDamage(KexTempEventT.TE_BLOOD, point, normal, take);
        }
      } else {
        SpawnDamage(te_sparks, point, normal, take);
      }
    }

    if (!CTFMatchSetup()) {
      targ.health = targ.health - take;
    }

    if ((targ.flags & EntFlagsT.FL_IMMORTAL) !== 0n && targ.health <= 0) {
      targ.health = 1;
    }

    // PGM - spheres need to know who to shoot at
    if (client !== null && client.owned_sphere !== null) {
      sphere_notified = true;
      if (client.owned_sphere.pain !== null) {
        client.owned_sphere.pain(client.owned_sphere, attacker, 0, 0, mod);
      }
    }
    // PGM

    if (targ.health <= 0) {
      if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0 || client !== null) {
        targ.flags |= EntFlagsT.FL_ALIVE_KNOCKBACK_ONLY;
        targ.dead_time = level.time;
      }
      targ.monsterinfo.damage_blood += take;
      targ.monsterinfo.damage_attacker = attacker;
      targ.monsterinfo.damage_inflictor = inflictor;
      targ.monsterinfo.damage_from = point;
      targ.monsterinfo.damage_mod = { ...mod }; // by-value store -- see file header
      targ.monsterinfo.damage_knockback += knockback;
      Killed(targ, inflictor, attacker, take, point, mod);
      return;
    }
  }

  // PGM - spheres need to know who to shoot at
  if (!sphere_notified) {
    if (client !== null && client.owned_sphere !== null) {
      sphere_notified = true;
      if (client.owned_sphere.pain !== null) {
        client.owned_sphere.pain(client.owned_sphere, attacker, 0, 0, mod);
      }
    }
  }
  // PGM
  void sphere_notified; // write-only past this point, matching the C source's own scaffolding

  if (targ.client !== null) {
    targ.client.last_attacker_time = level.time;
  }

  if ((targ.svflags & SvflagsT.SVF_MONSTER) !== 0) {
    if (damage > 0) {
      M_ReactToDamage(targ, attacker, inflictor);

      targ.monsterinfo.damage_attacker = attacker;
      targ.monsterinfo.damage_inflictor = inflictor;
      targ.monsterinfo.damage_blood += take;
      targ.monsterinfo.damage_from = point;
      targ.monsterinfo.damage_mod = { ...mod }; // by-value store -- see file header
      targ.monsterinfo.damage_knockback += knockback;
    }

    if (targ.monsterinfo.setskin !== null) targ.monsterinfo.setskin(targ);
  } else if (take && targ.pain !== null) {
    targ.pain(targ, attacker, knockback, take, mod);
  }

  // add to the damage inflicted on a player this frame
  // the total will be turned into screen blends and view angle kicks at the
  // end of the frame
  if (client !== null) {
    client.damage_parmor += psave;
    client.damage_armor += asave;
    client.damage_blood += take;
    client.damage_knockback += knockback;
    client.damage_from = point;
    client.last_damage_time = Gtime_add(level.time, COOP_DAMAGE_RESPAWN_TIME);

    const world = g_edicts[0];
    if ((dflags & DamageflagsT.DAMAGE_NO_INDICATOR) === 0 && inflictor !== world && attacker !== world && (take || psave || asave)) {
      let indicator: DamageIndicatorT | null = null;
      let i = 0;

      for (; i < client.num_damage_indicators; i++) {
        const candidate = client.damage_indicators[i];
        if (candidate !== undefined && vec3_length(vec3_sub(point, candidate.from)) < 32) {
          indicator = candidate;
          break;
        }
      }

      if (indicator === null && i !== MAX_DAMAGE_INDICATORS) {
        const fresh: DamageIndicatorT = {
          // for projectile direct hits, use the attacker; otherwise use the
          // inflictor (rocket splash should point to the rocket)
          from: (dflags & DamageflagsT.DAMAGE_RADIUS) !== 0 ? inflictor.s.origin : attacker.s.origin,
          health: 0,
          armor: 0,
          power: 0,
        };
        client.damage_indicators[i] = fresh;
        indicator = fresh;
        client.num_damage_indicators++;
      }

      if (indicator !== null) {
        indicator.health += take;
        indicator.power += psave;
        indicator.armor += asave;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// T_RadiusDamage
// ---------------------------------------------------------------------------

/** g_combat.cpp:867-911: `void T_RadiusDamage(...)`. */
export function T_RadiusDamage(
  inflictor: EdictT,
  attacker: EdictT,
  damage: number,
  ignore: EdictT | null,
  radius: number,
  dflags: DamageflagsT,
  mod: ModT,
): void {
  const inflictor_center: Vec3 = inflictor.linked ? vec3_muls(vec3_add(inflictor.absmax, inflictor.absmin), 0.5) : inflictor.s.origin;

  let ent: EdictT | null = null;
  for (;;) {
    ent = findradius(ent, inflictor_center, radius);
    if (ent === null) break;
    if (ent === ignore) continue;
    if (!ent.takedamage) continue;

    let v: Vec3;
    if (ent.solid === SolidT.SOLID_BSP && ent.linked) {
      v = closest_point_to_box(inflictor_center, ent.absmin, ent.absmax);
    } else {
      v = vec3_add(ent.s.origin, vec3_muls(vec3_add(ent.mins, ent.maxs), 0.5));
    }
    v = vec3_sub(inflictor_center, v);

    let points = damage - 0.5 * vec3_length(v);
    if (ent === attacker) points = points * 0.5;

    if (points > 0) {
      if (CanDamage(ent, inflictor)) {
        const dir = vec3_normalized(vec3_sub(ent.s.origin, inflictor_center));
        // [Paril-KEX] use closest point on bbox to explosion position to
        // spawn the damage effect
        T_Damage(
          ent,
          inflictor,
          attacker,
          dir,
          closest_point_to_box(inflictor_center, ent.absmin, ent.absmax),
          dir,
          Math.trunc(points),
          Math.trunc(points),
          dflags | DamageflagsT.DAMAGE_RADIUS,
          mod,
        );
      }
    }
  }
}
