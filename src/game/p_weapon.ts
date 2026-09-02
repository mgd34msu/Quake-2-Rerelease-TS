// p_weapon.c
//
// RERELEASE CONTENT PORT -- the mission-pack player weapons, lifted from
// src/rogue/p_weapon.ts (rogue/p_weapon.c) and src/xatrix/p_weapon.ts
// (xatrix/p_weapon.c):
//   rogue:  P_DamageModifier / damage_multiplier (Quad + Double Damage stack),
//           P_ProjectSource2, Throw_Generic, Weapon_Prox, Weapon_Tesla,
//           Weapon_ProxLauncher, Weapon_ChainFist, Weapon_Disintegrator,
//           Weapon_ETF_Rifle, Weapon_Heatbeam.
//   xatrix: is_quadfire (DualFire Damage double-shot), Use_Weapon2,
//           Weapon_Ionripper, Weapon_Phalanx, Weapon_Trap.
//
// DELIBERATE DEVIATIONS FROM THE SIBLING MODULES (all additive; the goal is
// that no *classic* weapon changes behaviour when none of the new items are
// present -- each is called out again in the port report):
//  1. rogue/p_weapon.c replaces baseq2's hand-rolled `Weapon_Grenade` state
//     machine with `Throw_Generic`, which passes `held=true` on a NORMAL
//     grenade release (a real rogue bug, preserved bug-for-bug in
//     src/rogue/p_weapon.ts) and moves the throw origin from
//     (8,8,viewheight-8)/P_ProjectSource to (2,6,viewheight-14)/
//     P_ProjectSource2. Applying that here would change how the classic
//     hand grenade throws and how its kills are attributed, so
//     `Weapon_Grenade` keeps baseq2's state machine and its held=false
//     release. `Throw_Generic` is still ported, and drives the two NEW
//     throwables (Weapon_Prox / Weapon_Tesla) exactly as rogue does.
//     `weapon_grenade_fire` gains rogue's `pers.weapon.tag` dispatch, with
//     the AMMO_GRENADES arm keeping baseq2's offset/projection.
//  2. rogue/p_weapon.c comments the hyperblaster out of
//     `NoAmmoWeaponChange`'s preference order. It is kept here (a classic
//     player with cells + hyperblaster must still auto-switch to it); the
//     Plasma Beam and ETF Rifle preferences are inserted around it in
//     rogue's order.
//  3. xatrix's ionripper/phalanx/trap fire functions say `damage *= 4` for
//     quad; they use `damage_multiplier` here so rogue's Double Damage
//     stacks with them the way it does with every other weapon in the
//     merged module. xatrix has no Double Damage, so this cannot differ
//     from xatrix's own behaviour on xatrix content.
//
// `G_ProjectSource2` lives in rogue/g_utils.c; src/game/g_utils.ts is not
// this agent's file, so it is mirrored as a module-local here and reported.
//
// g_local.h calls this file "g_pweapon.c" (does not exist) for
// `PlayerNoise`. The other 14 functions here are forward-declared as
// `extern` at the top of g_items.c (its itemlist table references them);
// grepping the C tree confirms all 14 are actually defined in p_weapon.c,
// not g_items.c, so they are attributed here per PORTING.md.
//
// m_player.h frame split: m_player.h is a 200+ constant qdata-generated
import { FRAME_attack1, FRAME_attack8, FRAME_pain301, FRAME_pain304, FRAME_crattak1, FRAME_crattak3, FRAME_crattak9, FRAME_crpain1, FRAME_crpain4, FRAME_wave01, FRAME_wave08 } from "./m_player_frames";

import { AngleVectors, crandom, random, vec3, type Vec3, vec3_origin, VectorAdd, VectorClear, VectorCopy, VectorMA, VectorScale, VectorSet, VectorSubtract } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  BUTTON_ATTACK,
  CHAN_AUTO,
  CHAN_ITEM,
  CHAN_VOICE,
  CHAN_WEAPON,
  type CvarT,
  DF_INFINITE_AMMO,
  DF_NO_STACK_DOUBLE,
  DF_WEAPONS_STAY,
  EF_BLASTER,
  EF_HYPERBLASTER,
  EF_IONRIPPER,
  MASK_SHOT,
  MulticastT,
  MZ_BFG,
  MZ_BLASTER,
  MZ_CHAINGUN1,
  MZ_ETF_RIFLE,
  MZ_GRENADE,
  MZ_HEATBEAM,
  MZ_HYPERBLASTER,
  MZ_IONRIPPER,
  MZ_MACHINEGUN,
  MZ_PHALANX,
  MZ_RAILGUN,
  MZ_ROCKET,
  MZ_SHOTGUN,
  MZ_SILENCED,
  MZ_SSHOTGUN,
  MZ_TRACKER,
  PITCH,
  PMF_DUCKED,
  PRINT_HIGH,
  Q_stricmp,
  ROLL,
  TempEventT,
  YAW,
} from "../shared/q_shared";
import {
  AmmoT,
  ANIM_ATTACK,
  ANIM_PAIN,
  ANIM_REVERSE,
  CENTER_HANDED,
  DAMAGE_TIME,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  type EdictT,
  FL_DISGUISED,
  FL_NOTARGET,
  FL_RESPAWN,
  g_edicts,
  gameCvars,
  type GClientT,
  gi,
  type GItemT,
  IT_AMMO,
  LEFT_HANDED,
  level,
  MOD_CHAINFIST,
  MOD_CHAINGUN,
  MOD_MACHINEGUN,
  MOD_SHOTGUN,
  MOD_SSHOTGUN,
  PNOISE_SELF,
  PNOISE_WEAPON,
  svc_muzzleflash,
  svc_temp_entity,
  WeaponstateT,
  world,
} from "./g_local";
import { type Edict, SVF_DAMAGEABLE, SVF_MONSTER, SVF_NOCLIENT } from "./game";
import { Add_Ammo, Drop_Item, FindItem, ITEM_INDEX, SetRespawn } from "./g_items";
import { G_ProjectSource, G_Spawn } from "./g_utils";
import { fire_bfg, fire_blaster, fire_bullet, fire_grenade, fire_grenade2, fire_rail, fire_rocket, fire_shotgun } from "./g_weapon";
// RERELEASE CONTENT PORT -- the mission-pack projectiles. rogue's live in
// g_newweap.ts (rogue/g_newweap.c); xatrix's fire_ionripper/fire_plasma/
// fire_trap belong to xatrix/g_weapon.c, but src/game/g_weapon.ts is owned
// by another agent, so this module's copies also live in g_newweap.ts --
// flagged to the coordinator as a possible duplicate.
import {
  fire_flechette,
  fire_heat,
  fire_ionripper,
  fire_plasma,
  fire_player_melee,
  fire_prox,
  fire_tesla,
  fire_tracker,
  fire_trap,
} from "./g_newweap";

// g_local.h's DEFAULT_BULLET_HSPREAD/VSPREAD and DEFAULT_*SHOTGUN* family
// live in g_local.h, but this file's SCOPE does not include g_local.ts;
// ported as local consts here (same treatment as the m_player.h frame
// split above) and reported as a follow-up to relocate.
const DEFAULT_BULLET_HSPREAD = 300;
const DEFAULT_BULLET_VSPREAD = 500;
const DEFAULT_SHOTGUN_HSPREAD = 1000;
const DEFAULT_SHOTGUN_VSPREAD = 500;
const DEFAULT_DEATHMATCH_SHOTGUN_COUNT = 12;
const DEFAULT_SHOTGUN_COUNT = 12;
const DEFAULT_SSHOTGUN_COUNT = 20;

// `static qboolean is_quad; static byte is_silenced;` -- file-static
// globals in the C, so plain (unexported) module-locals here.
let is_quad = false;
let is_silenced = 0;

// ROGUE -- `static byte damage_multiplier;`
let damage_multiplier = 1;

// xatrix/p_weapon.c: `// RAFAEL` -- `static qboolean is_quadfire;`
let is_quadfire = false;

// a per-file local mirrors g_items.ts's own cvarNum (module-local there
// too, so not reusable) rather than inventing a shared helper outside
// this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function dmFlags(): number {
  return cvarNum(gameCvars.dmflags) | 0;
}

function requireItem(item: GItemT | null): GItemT {
  if (item !== null) return item;
  gi.error("p_weapon: expected item lookup to succeed");
}

function requireNoise(noise: EdictT | null): EdictT {
  if (noise !== null) return noise;
  gi.error("PlayerNoise: noise entity not initialized");
}

// `tr.ent`'s C default is the world edict for a trace that hit nothing;
// this port's GTraceT.ent is `Edict | null`, so a trace that hit nothing is
// null. Recovers the full EdictT so `hit !== world()` works the way the C's
// `tr.ent != world` does. (Same helper as g_weapon.ts's module-local one.)
function traceEdict(ent: Edict | null): EdictT {
  const e = ent === null ? g_edicts[0] : g_edicts[ent.s.number];
  if (e === undefined) gi.error("p_weapon: trace returned an out-of-range edict");
  return e;
}

// ROGUE
//========
// P_DamageModifier -- stacks Quad Damage and rogue's Double Damage powerup
// into a single multiplier; sets the module-level `is_quad` flag (now
// really "damage is boosted", read by every weapon fire function) and
// returns the multiplier.
//========
// non-static in C (g_newweap.c calls it directly to get fire_nuke's
// damage_modifier) -- exported to match.
export function P_DamageModifier(ent: EdictT): number {
  const client = ent.client;
  if (client === null) return 1; // defensive; C assumes ent->client is set

  is_quad = false;
  damage_multiplier = 1;

  if (client.quad_framenum > level.framenum) {
    damage_multiplier *= 4;
    is_quad = true;

    // if we're quad and DF_NO_STACK_DOUBLE is on, return now.
    if ((dmFlags() & DF_NO_STACK_DOUBLE) !== 0) return damage_multiplier;
  }
  if (client.double_framenum > level.framenum) {
    if (cvarNum(gameCvars.deathmatch) !== 0 || damage_multiplier === 1) {
      damage_multiplier *= 2;
      is_quad = true;
    }
  }

  return damage_multiplier;
}
// ROGUE

// static in C; exported here so it is directly testable (P_ProjectSource's
// handedness math is part of this unit's test brief).
export function P_ProjectSource(client: GClientT, point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  const _distance = vec3();
  VectorCopy(distance, _distance);
  if (client.pers.hand === LEFT_HANDED) _distance[1] *= -1;
  else if (client.pers.hand === CENTER_HANDED) _distance[1] = 0;
  G_ProjectSource(point, _distance, forward, right, result);
}

// ROGUE -- rogue/g_utils.c's G_ProjectSource2 (G_ProjectSource with an
// extra `up` basis vector). Mirrored here because src/game/g_utils.ts is
// owned by another agent; reported to the coordinator.
function G_ProjectSource2(point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, up: Vec3, result: Vec3): void {
  result[0] = point[0] + forward[0] * distance[0] + right[0] * distance[1] + up[0] * distance[2];
  result[1] = point[1] + forward[1] * distance[0] + right[1] * distance[1] + up[1] * distance[2];
  result[2] = point[2] + forward[2] * distance[0] + right[2] * distance[1] + up[2] * distance[2];
}

// ROGUE -- P_ProjectSource with an extra `up` vector, used by the pack's
// grenade-family and ETF rifle fire functions.
function P_ProjectSource2(
  client: GClientT,
  point: Vec3,
  distance: Vec3,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  result: Vec3,
): void {
  const _distance = vec3();
  VectorCopy(distance, _distance);
  if (client.pers.hand === LEFT_HANDED) _distance[1] *= -1;
  else if (client.pers.hand === CENTER_HANDED) _distance[1] = 0;
  G_ProjectSource2(point, _distance, forward, right, up, result);
}

/*
===============
PlayerNoise

Each player can have two noise objects associated with it:
a personal noise (jumping, pain, weapon firing), and a weapon
target noise (bullet wall impacts)

Monsters that don't directly see the player can move
to a noise in hopes of seeing the player from there.
===============
*/
export function PlayerNoise(who: EdictT, where: Vec3, noiseType: number): void {
  if (noiseType === PNOISE_WEAPON) {
    const client = who.client;
    if (client !== null && client.silencer_shots) {
      client.silencer_shots--;
      return;
    }
  }

  if (cvarNum(gameCvars.deathmatch)) return;

  if (who.flags & FL_NOTARGET) return;

  // ROGUE -- a disguised entity firing a weapon marks the disguise as
  // violated instead of making noise; any other noise type is suppressed
  // outright while disguised.
  if ((who.flags & FL_DISGUISED) !== 0) {
    if (noiseType === PNOISE_WEAPON) {
      level.disguise_violator = who;
      level.disguise_violation_framenum = level.framenum + 5;
    } else {
      return;
    }
  }
  // ROGUE

  if (who.mynoise === null) {
    const noise1 = G_Spawn();
    noise1.classname = "player_noise";
    VectorSet(noise1.mins, -8, -8, -8);
    VectorSet(noise1.maxs, 8, 8, 8);
    noise1.owner = who;
    noise1.svflags = SVF_NOCLIENT;
    who.mynoise = noise1;

    const noise2 = G_Spawn();
    noise2.classname = "player_noise";
    VectorSet(noise2.mins, -8, -8, -8);
    VectorSet(noise2.maxs, 8, 8, 8);
    noise2.owner = who;
    noise2.svflags = SVF_NOCLIENT;
    who.mynoise2 = noise2;
  }

  let noise: EdictT;
  if (noiseType === PNOISE_SELF || noiseType === PNOISE_WEAPON) {
    noise = requireNoise(who.mynoise);
    level.sound_entity = noise;
    level.sound_entity_framenum = level.framenum;
  } else {
    // type == PNOISE_IMPACT
    noise = requireNoise(who.mynoise2);
    level.sound2_entity = noise;
    level.sound2_entity_framenum = level.framenum;
  }

  VectorCopy(where, noise.s.origin);
  VectorSubtract(where, noise.maxs, noise.absmin);
  VectorAdd(where, noise.maxs, noise.absmax);
  noise.teleport_time = level.time;
  gi.linkentity(noise);
}

export function Pickup_Weapon(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const index = ITEM_INDEX(item);

  if ((dmFlags() & DF_WEAPONS_STAY || cvarNum(gameCvars.coop)) && client.pers.inventory[index]) {
    if ((ent.spawnflags & (DROPPED_ITEM | DROPPED_PLAYER_ITEM)) === 0) return false; // leave the weapon for others to pickup
  }

  client.pers.inventory[index]++;

  if ((ent.spawnflags & DROPPED_ITEM) === 0) {
    // give them some ammo with it
    // PGM -- IF APPROPRIATE! (the chainfist has no ammo string)
    if (item.ammo !== null && item.ammo.length > 0) {
      const ammo = requireItem(FindItem(item.ammo));
      // xatrix/p_weapon.c: `// Don't get infinite ammo with trap` guards
      // DF_INFINITE_AMMO with `Q_stricmp(ent->item->pickup_name,
      // "ammo_trap")`, but pickup_name is "Trap" (never literally
      // "ammo_trap"), so the added condition is always nonzero -- dead code
      // in xatrix too, preserved as written rather than "fixed".
      if ((dmFlags() & DF_INFINITE_AMMO) !== 0 && Q_stricmp(item.pickup_name ?? "", "ammo_trap") !== 0) {
        Add_Ammo(other, ammo, 1000);
      } else Add_Ammo(other, ammo, ammo.quantity);
    }

    if ((ent.spawnflags & DROPPED_PLAYER_ITEM) === 0) {
      if (cvarNum(gameCvars.deathmatch)) {
        if (dmFlags() & DF_WEAPONS_STAY) ent.flags |= FL_RESPAWN;
        else SetRespawn(ent, 30);
      }
      if (cvarNum(gameCvars.coop)) ent.flags |= FL_RESPAWN;
    }
  }

  if (
    client.pers.weapon !== item &&
    client.pers.inventory[index] === 1 &&
    (!cvarNum(gameCvars.deathmatch) || client.pers.weapon === FindItem("blaster"))
  ) {
    client.newweapon = item;
  }

  return true;
}

/*
===============
ChangeWeapon

The old weapon has been dropped all the way, so make the new one
current
===============
*/
export function ChangeWeapon(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.grenade_time) {
    client.grenade_time = level.time;
    client.weapon_sound = 0;
    weapon_grenade_fire(ent, false);
    client.grenade_time = 0;
  }

  client.pers.lastweapon = client.pers.weapon;
  client.pers.weapon = client.newweapon;
  client.newweapon = null;
  client.machinegun_shots = 0;

  // set visible model
  if (ent.s.modelindex === 255) {
    let i: number;
    if (client.pers.weapon !== null) i = (client.pers.weapon.weapmodel & 0xff) << 8;
    else i = 0;
    ent.s.skinnum = (ent.s.number - 1) | i;
  }

  if (client.pers.weapon !== null && client.pers.weapon.ammo !== null && client.pers.weapon.ammo.length > 0) {
    client.ammo_index = ITEM_INDEX(requireItem(FindItem(client.pers.weapon.ammo)));
  } else {
    client.ammo_index = 0;
  }

  if (client.pers.weapon === null) {
    // dead
    client.ps.gunindex = 0;
    return;
  }

  client.weaponstate = WeaponstateT.WEAPON_ACTIVATING;
  client.ps.gunframe = 0;
  client.ps.gunindex = gi.modelindex(client.pers.weapon.view_model ?? "");

  client.anim_priority = ANIM_PAIN;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crpain1;
    client.anim_end = FRAME_crpain4;
  } else {
    ent.s.frame = FRAME_pain301;
    client.anim_end = FRAME_pain304;
  }
}

/*
=================
NoAmmoWeaponChange
=================
*/
export function NoAmmoWeaponChange(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const slugs = requireItem(FindItem("slugs"));
  const railgun = requireItem(FindItem("railgun"));
  if (client.pers.inventory[ITEM_INDEX(slugs)] && client.pers.inventory[ITEM_INDEX(railgun)]) {
    client.newweapon = railgun;
    return;
  }
  const cells = requireItem(FindItem("cells"));

  // ROGUE -- Plasma Beam sits ahead of the hyperblaster in rogue's
  // preference order (which also drops the hyperblaster entirely; see this
  // file's header note -- kept here so classic play is unchanged).
  const plasmaBeam = requireItem(FindItem("Plasma Beam"));
  if (client.pers.inventory[ITEM_INDEX(cells)] >= 2 && client.pers.inventory[ITEM_INDEX(plasmaBeam)]) {
    client.newweapon = plasmaBeam;
    return;
  }
  // -ROGUE

  const hyperblaster = requireItem(FindItem("hyperblaster"));
  if (client.pers.inventory[ITEM_INDEX(cells)] && client.pers.inventory[ITEM_INDEX(hyperblaster)]) {
    client.newweapon = hyperblaster;
    return;
  }

  // ROGUE
  const flechettes = requireItem(FindItem("flechettes"));
  const etfRifle = requireItem(FindItem("etf rifle"));
  if (client.pers.inventory[ITEM_INDEX(flechettes)] && client.pers.inventory[ITEM_INDEX(etfRifle)]) {
    client.newweapon = etfRifle;
    return;
  }
  // -ROGUE

  const bullets = requireItem(FindItem("bullets"));
  const chaingun = requireItem(FindItem("chaingun"));
  if (client.pers.inventory[ITEM_INDEX(bullets)] && client.pers.inventory[ITEM_INDEX(chaingun)]) {
    client.newweapon = chaingun;
    return;
  }
  const machinegun = requireItem(FindItem("machinegun"));
  if (client.pers.inventory[ITEM_INDEX(bullets)] && client.pers.inventory[ITEM_INDEX(machinegun)]) {
    client.newweapon = machinegun;
    return;
  }
  const shells = requireItem(FindItem("shells"));
  const supershotgun = requireItem(FindItem("super shotgun"));
  if (client.pers.inventory[ITEM_INDEX(shells)] > 1 && client.pers.inventory[ITEM_INDEX(supershotgun)]) {
    client.newweapon = supershotgun;
    return;
  }
  const shotgun = requireItem(FindItem("shotgun"));
  if (client.pers.inventory[ITEM_INDEX(shells)] && client.pers.inventory[ITEM_INDEX(shotgun)]) {
    client.newweapon = shotgun;
    return;
  }
  client.newweapon = requireItem(FindItem("blaster"));
}

/*
=================
Think_Weapon

Called by ClientBeginServerFrame and ClientThink
=================
*/
export function Think_Weapon(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // if just died, put the weapon away
  if (ent.health < 1) {
    client.newweapon = null;
    ChangeWeapon(ent);
  }

  // call active weapon think routine
  if (client.pers.weapon !== null && client.pers.weapon.weaponthink !== null) {
    // PGM -- rogue replaces baseq2's inline `is_quad` with the stacking
    // Quad + Double Damage multiplier.
    P_DamageModifier(ent);
    // PGM
    // xatrix/p_weapon.c: `// RAFAEL`
    is_quadfire = client.quadfire_framenum > level.framenum;
    is_silenced = client.silencer_shots ? MZ_SILENCED : 0;
    client.pers.weapon.weaponthink(ent);
  }
}

/*
================
Use_Weapon

Make the weapon ready if there is ammo
================
*/
export function Use_Weapon(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  // see if we're already using it
  if (item === client.pers.weapon) return;

  if (item.ammo !== null && item.ammo.length > 0 && !cvarNum(gameCvars.g_select_empty) && (item.flags & IT_AMMO) === 0) {
    const ammo_item = requireItem(FindItem(item.ammo));
    const ammo_index = ITEM_INDEX(ammo_item);

    if (!client.pers.inventory[ammo_index]) {
      gi.cprintf(ent, PRINT_HIGH, `No ${ammo_item.pickup_name} for ${item.pickup_name}.\n`);
      return;
    }

    if (client.pers.inventory[ammo_index] < item.quantity) {
      gi.cprintf(ent, PRINT_HIGH, `Not enough ${ammo_item.pickup_name} for ${item.pickup_name}.\n`);
      return;
    }
  }

  // change to this weapon when down
  client.newweapon = item;
}

/*
================
Drop_Weapon
================
*/
export function Drop_Weapon(ent: EdictT, item: GItemT): void {
  if (dmFlags() & DF_WEAPONS_STAY) return;

  const client = ent.client;
  if (client === null) return;

  const index = ITEM_INDEX(item);
  // see if we're already using it
  if ((item === client.pers.weapon || item === client.newweapon) && client.pers.inventory[index] === 1) {
    gi.cprintf(ent, PRINT_HIGH, "Can't drop current weapon\n");
    return;
  }

  Drop_Item(ent, item);
  client.pers.inventory[index]--;
}

/*
================
Weapon_Generic

A generic function to handle the basics of weapon thinking
================
*/
export function Weapon_Generic(
  ent: EdictT,
  FRAME_ACTIVATE_LAST: number,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_DEACTIVATE_LAST: number,
  pause_frames: number[],
  fire_frames: number[],
  fire: (ent: EdictT) => void,
): void {
  const client = ent.client;
  if (client === null) return;

  const FRAME_FIRE_FIRST = FRAME_ACTIVATE_LAST + 1;
  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;
  const FRAME_DEACTIVATE_FIRST = FRAME_IDLE_LAST + 1;

  if (ent.deadflag || ent.s.modelindex !== 255) {
    // VWep animations screw up corpses
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_DROPPING) {
    if (client.ps.gunframe === FRAME_DEACTIVATE_LAST) {
      ChangeWeapon(ent);
      return;
    } else if (FRAME_DEACTIVATE_LAST - client.ps.gunframe === 4) {
      client.anim_priority = ANIM_REVERSE;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }

    client.ps.gunframe++;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    if (client.ps.gunframe === FRAME_ACTIVATE_LAST) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = FRAME_IDLE_FIRST;
      return;
    }

    client.ps.gunframe++;
    return;
  }

  if (client.newweapon !== null && client.weaponstate !== WeaponstateT.WEAPON_FIRING) {
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    client.ps.gunframe = FRAME_DEACTIVATE_FIRST;

    if (FRAME_DEACTIVATE_LAST - FRAME_DEACTIVATE_FIRST < 4) {
      client.anim_priority = ANIM_REVERSE;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crpain4 + 1;
        client.anim_end = FRAME_crpain1;
      } else {
        ent.s.frame = FRAME_pain304 + 1;
        client.anim_end = FRAME_pain301;
      }
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if ((client.latched_buttons | client.buttons) & BUTTON_ATTACK) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      const weaponQuantity = client.pers.weapon === null ? 0 : client.pers.weapon.quantity;
      if (!client.ammo_index || client.pers.inventory[client.ammo_index] >= weaponQuantity) {
        client.ps.gunframe = FRAME_FIRE_FIRST;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;

        // start the animation
        client.anim_priority = ANIM_ATTACK;
        if (client.ps.pmove.pm_flags & PMF_DUCKED) {
          ent.s.frame = FRAME_crattak1 - 1;
          client.anim_end = FRAME_crattak9;
        } else {
          ent.s.frame = FRAME_attack1 - 1;
          client.anim_end = FRAME_attack8;
        }
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
    } else {
      if (client.ps.gunframe === FRAME_IDLE_LAST) {
        client.ps.gunframe = FRAME_IDLE_FIRST;
        return;
      }

      for (const pf of pause_frames) {
        if (client.ps.gunframe === pf) {
          // `rand()&15` -- no integer rand() helper exists in math.ts (only
          // random()/crandom()); approximated with an equivalent uniform
          // pick: ~15/16 chance to pause, ~1/16 chance to fall through.
          if (Math.floor(Math.random() * 16) !== 0) return;
        }
      }

      client.ps.gunframe++;
      return;
    }
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    let matched = false;
    for (const ff of fire_frames) {
      if (client.ps.gunframe === ff) {
        // ROGUE -- FIXME - double should use different sound
        if (client.quad_framenum > level.framenum) {
          gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
        } else if (client.double_framenum > level.framenum) {
          gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/ddamage3.wav"), 1, ATTN_NORM, 0);
        }
        // ROGUE

        fire(ent);
        matched = true;
        break;
      }
    }

    if (!matched) client.ps.gunframe++;

    if (client.ps.gunframe === FRAME_IDLE_FIRST + 1) client.weaponstate = WeaponstateT.WEAPON_READY;
  }
}

/*
======================================================================

GRENADE

======================================================================
*/

const GRENADE_TIMER = 3.0;
const GRENADE_MINSPEED = 400;
const GRENADE_MAXSPEED = 800;

function weapon_grenade_fire(ent: EdictT, held: boolean): void {
  const client = ent.client;
  if (client === null) return;

  // ROGUE -- one fire function now serves all three throwables; which one
  // is thrown comes from `pers.weapon.tag` (AMMO_GRENADES / AMMO_TESLA /
  // anything else = prox).
  const weapon = client.pers.weapon;
  if (weapon === null) return; // defensive; Think_Weapon only calls weaponthink when pers.weapon is set

  let damage = 125;
  const radius = damage + 40;
  if (is_quad) damage *= damage_multiplier; // PGM

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(client.v_angle, forward, right, up);

  const start = vec3();
  if (weapon.tag === AmmoT.AMMO_GRENADES) {
    // DELIBERATE DEVIATION (see this file's header note 1): rogue moves the
    // hand grenade's throw origin to (2,6,viewheight-14)/P_ProjectSource2.
    // baseq2's origin is kept so classic play is byte-identical.
    const offset = vec3(8, 8, ent.viewheight - 8);
    P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  } else {
    const offset = vec3();
    if (weapon.tag === AmmoT.AMMO_TESLA) VectorSet(offset, 0, -4, ent.viewheight - 22);
    else VectorSet(offset, 2, 6, ent.viewheight - 14);
    P_ProjectSource2(client, ent.s.origin, offset, forward, right, up, start);
  }

  const timer = client.grenade_time - level.time;
  let speed = (GRENADE_MINSPEED + (GRENADE_TIMER - timer) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / GRENADE_TIMER)) | 0;
  if (speed > GRENADE_MAXSPEED) speed = GRENADE_MAXSPEED;

  // PGM
  switch (weapon.tag) {
    case AmmoT.AMMO_GRENADES:
      fire_grenade2(ent, start, forward, damage, speed, timer, radius, held);
      break;
    case AmmoT.AMMO_TESLA:
      fire_tesla(ent, start, forward, damage_multiplier, speed);
      break;
    default:
      fire_prox(ent, start, forward, damage_multiplier, speed);
      break;
  }
  // PGM

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

  client.grenade_time = level.time + 1.0;

  if (ent.deadflag || ent.s.modelindex !== 255) {
    // VWep animations screw up corpses
    return;
  }

  if (ent.health <= 0) return;

  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    client.anim_priority = ANIM_ATTACK;
    ent.s.frame = FRAME_crattak1 - 1;
    client.anim_end = FRAME_crattak3;
  } else {
    client.anim_priority = ANIM_REVERSE;
    ent.s.frame = FRAME_wave08;
    client.anim_end = FRAME_wave01;
  }
}

export function Weapon_Grenade(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.newweapon !== null && client.weaponstate === WeaponstateT.WEAPON_READY) {
    ChangeWeapon(ent);
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    client.weaponstate = WeaponstateT.WEAPON_READY;
    client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if ((client.latched_buttons | client.buttons) & BUTTON_ATTACK) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      if (client.pers.inventory[client.ammo_index]) {
        client.ps.gunframe = 1;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;
        client.grenade_time = 0;
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
      return;
    }

    if (client.ps.gunframe === 29 || client.ps.gunframe === 34 || client.ps.gunframe === 39 || client.ps.gunframe === 48) {
      // rand()&15, see the comment in Weapon_Generic
      if (Math.floor(Math.random() * 16) !== 0) return;
    }

    if (++client.ps.gunframe > 48) client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    if (client.ps.gunframe === 5) gi.sound(ent, CHAN_WEAPON, gi.soundindex("weapons/hgrena1b.wav"), 1, ATTN_NORM, 0);

    if (client.ps.gunframe === 11) {
      if (!client.grenade_time) {
        client.grenade_time = level.time + GRENADE_TIMER + 0.2;
        client.weapon_sound = gi.soundindex("weapons/hgrenc1b.wav");
      }

      // they waited too long, detonate it in their hand
      if (!client.grenade_blew_up && level.time >= client.grenade_time) {
        client.weapon_sound = 0;
        weapon_grenade_fire(ent, true);
        client.grenade_blew_up = true;
      }

      if (client.buttons & BUTTON_ATTACK) return;

      if (client.grenade_blew_up) {
        if (level.time >= client.grenade_time) {
          client.ps.gunframe = 15;
          client.grenade_blew_up = false;
        } else {
          return;
        }
      }
    }

    if (client.ps.gunframe === 12) {
      client.weapon_sound = 0;
      weapon_grenade_fire(ent, false);
    }

    if (client.ps.gunframe === 15 && level.time < client.grenade_time) return;

    client.ps.gunframe++;

    if (client.ps.gunframe === 16) {
      client.grenade_time = 0;
      client.weaponstate = WeaponstateT.WEAPON_READY;
    }
  }
}

// ROGUE
//========
// Throw_Generic -- Weapon_Generic's counterpart for hold-to-cook throwables.
// baseq2's Weapon_Grenade above is left on its own hand-rolled state machine
// (see this file's header note 1); this drives the two NEW throwables,
// Weapon_Prox and Weapon_Tesla, exactly as rogue/p_weapon.c does.
//
// Bug-for-bug from rogue/p_weapon.c: `fire(ent, true)` is called with
// held=true at BOTH the "detonate in hand" branch AND the normal release
// (FRAME_THROW_FIRE) branch. Neither prox nor tesla reads `held`, so this
// has no observable effect here -- preserved so the code matches the C.
//========
function Throw_Generic(
  ent: EdictT,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_THROW_SOUND: number,
  FRAME_THROW_HOLD: number,
  FRAME_THROW_FIRE: number,
  pause_frames: number[],
  EXPLODE: number,
  fire: (ent: EdictT, held: boolean) => void,
): void {
  const client = ent.client;
  if (client === null) return;

  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;

  if (client.newweapon !== null && client.weaponstate === WeaponstateT.WEAPON_READY) {
    ChangeWeapon(ent);
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    client.weaponstate = WeaponstateT.WEAPON_READY;
    client.ps.gunframe = FRAME_IDLE_FIRST;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if (((client.latched_buttons | client.buttons) & BUTTON_ATTACK) !== 0) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      if (client.pers.inventory[client.ammo_index] !== 0) {
        client.ps.gunframe = 1;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;
        client.grenade_time = 0;
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
      return;
    }

    if (client.ps.gunframe === FRAME_IDLE_LAST) {
      client.ps.gunframe = FRAME_IDLE_FIRST;
      return;
    }

    for (const pf of pause_frames) {
      if (client.ps.gunframe === pf) {
        // rand()&15, see Weapon_Generic's identical comment
        if (Math.floor(Math.random() * 16) !== 0) return;
      }
    }

    client.ps.gunframe++;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    if (client.ps.gunframe === FRAME_THROW_SOUND) {
      gi.sound(ent, CHAN_WEAPON, gi.soundindex("weapons/hgrena1b.wav"), 1, ATTN_NORM, 0);
    }

    if (client.ps.gunframe === FRAME_THROW_HOLD) {
      if (client.grenade_time === 0) {
        client.grenade_time = level.time + GRENADE_TIMER + 0.2;
        const weapon = client.pers.weapon;
        if (weapon !== null && weapon.tag === AmmoT.AMMO_GRENADES) {
          client.weapon_sound = gi.soundindex("weapons/hgrenc1b.wav");
        }
      }

      // they waited too long, detonate it in their hand
      if (EXPLODE !== 0 && !client.grenade_blew_up && level.time >= client.grenade_time) {
        client.weapon_sound = 0;
        fire(ent, true);
        client.grenade_blew_up = true;
      }

      if ((client.buttons & BUTTON_ATTACK) !== 0) return;

      if (client.grenade_blew_up) {
        if (level.time >= client.grenade_time) {
          client.ps.gunframe = FRAME_FIRE_LAST;
          client.grenade_blew_up = false;
        } else {
          return;
        }
      }
    }

    if (client.ps.gunframe === FRAME_THROW_FIRE) {
      client.weapon_sound = 0;
      fire(ent, true);
    }

    if (client.ps.gunframe === FRAME_FIRE_LAST && level.time < client.grenade_time) return;

    client.ps.gunframe++;

    if (client.ps.gunframe === FRAME_IDLE_FIRST) {
      client.grenade_time = 0;
      client.weaponstate = WeaponstateT.WEAPON_READY;
    }
  }
}

export function Weapon_Prox(ent: EdictT): void {
  const pause_frames = [22, 29];

  Throw_Generic(ent, 7, 27, 99, 2, 4, pause_frames, 0, weapon_grenade_fire);
}

export function Weapon_Tesla(ent: EdictT): void {
  const client = ent.client;
  const pause_frames = [21];

  if (client !== null) {
    if (client.ps.gunframe > 1 && client.ps.gunframe < 9) {
      client.ps.gunindex = gi.modelindex("models/weapons/v_tesla2/tris.md2");
    } else {
      client.ps.gunindex = gi.modelindex("models/weapons/v_tesla/tris.md2");
    }
  }

  Throw_Generic(ent, 8, 32, 99, 1, 2, pause_frames, 0, weapon_grenade_fire);
}
// ROGUE

/*
======================================================================

GRENADE LAUNCHER / PROX LAUNCHER

======================================================================
*/

function weapon_grenadelauncher_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const weapon = client.pers.weapon;
  if (weapon === null) return; // defensive; Think_Weapon only calls weaponthink when pers.weapon is set

  // PGM
  let damage: number;
  switch (weapon.tag) {
    case AmmoT.AMMO_PROX:
      damage = 90;
      break;
    default:
      damage = 120;
      break;
  }
  // PGM

  const radius = damage + 40;
  if (is_quad) damage *= damage_multiplier; // PGM

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  // PGM
  switch (weapon.tag) {
    case AmmoT.AMMO_PROX:
      fire_prox(ent, start, forward, damage_multiplier, 600);
      break;
    default:
      fire_grenade(ent, start, forward, damage, 600, 2.5, radius);
      break;
  }
  // PGM

  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_GRENADE | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_GrenadeLauncher(ent: EdictT): void {
  const pause_frames = [34, 51, 59];
  const fire_frames = [6];

  Weapon_Generic(ent, 5, 16, 59, 64, pause_frames, fire_frames, weapon_grenadelauncher_fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 5, 16, 59, 64, pause_frames, fire_frames, weapon_grenadelauncher_fire);
}

// ROGUE -- same frame numbers and fire function as the grenade launcher;
// the prox launcher differs only in the item's `tag`, which the fire
// function dispatches on.
export function Weapon_ProxLauncher(ent: EdictT): void {
  const pause_frames = [34, 51, 59];
  const fire_frames = [6];

  Weapon_Generic(ent, 5, 16, 59, 64, pause_frames, fire_frames, weapon_grenadelauncher_fire);
}
// ROGUE

/*
======================================================================

ROCKET

======================================================================
*/

function Weapon_RocketLauncher_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 100 + ((random() * 20.0) | 0);
  let radius_damage = 120;
  const damage_radius = 120;
  if (is_quad) {
    damage *= damage_multiplier; // PGM
    radius_damage *= damage_multiplier;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_rocket(ent, start, forward, damage, 650, damage_radius, radius_damage);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_ROCKET | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_RocketLauncher(ent: EdictT): void {
  const pause_frames = [25, 33, 42, 50];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 12, 50, 54, pause_frames, fire_frames, Weapon_RocketLauncher_Fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 4, 12, 50, 54, pause_frames, fire_frames, Weapon_RocketLauncher_Fire);
}

/*
======================================================================

BLASTER / HYPERBLASTER

======================================================================
*/

function Blaster_Fire(ent: EdictT, g_offset: Vec3, damage: number, hyper: boolean, effect: number): void {
  const client = ent.client;
  if (client === null) return;

  if (is_quad) damage *= damage_multiplier; // PGM
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const offset = vec3(24, 8, ent.viewheight - 8);
  VectorAdd(offset, g_offset, offset);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  fire_blaster(ent, start, forward, damage, 1000, effect, hyper);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  if (hyper) gi.WriteByte(MZ_HYPERBLASTER | is_silenced);
  else gi.WriteByte(MZ_BLASTER | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);
}

function Weapon_Blaster_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const damage = cvarNum(gameCvars.deathmatch) ? 15 : 10;
  Blaster_Fire(ent, vec3_origin, damage, false, EF_BLASTER);
  client.ps.gunframe++;
}

export function Weapon_Blaster(ent: EdictT): void {
  const pause_frames = [19, 32];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 8, 52, 55, pause_frames, fire_frames, Weapon_Blaster_Fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 4, 8, 52, 55, pause_frames, fire_frames, Weapon_Blaster_Fire);
}

function Weapon_HyperBlaster_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.weapon_sound = gi.soundindex("weapons/hyprbl1a.wav");

  if (!(client.buttons & BUTTON_ATTACK)) {
    client.ps.gunframe++;
  } else {
    if (!client.pers.inventory[client.ammo_index]) {
      if (level.time >= ent.pain_debounce_time) {
        gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
        ent.pain_debounce_time = level.time + 1;
      }
      NoAmmoWeaponChange(ent);
    } else {
      const rotation = ((client.ps.gunframe - 5) * 2 * Math.PI) / 6;
      const offset = vec3(-4 * Math.sin(rotation), 0, 4 * Math.cos(rotation));

      const effect = client.ps.gunframe === 6 || client.ps.gunframe === 9 ? EF_HYPERBLASTER : 0;
      const damage = cvarNum(gameCvars.deathmatch) ? 15 : 20;
      Blaster_Fire(ent, offset, damage, true, effect);
      if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

      client.anim_priority = ANIM_ATTACK;
      if (client.ps.pmove.pm_flags & PMF_DUCKED) {
        ent.s.frame = FRAME_crattak1 - 1;
        client.anim_end = FRAME_crattak9;
      } else {
        ent.s.frame = FRAME_attack1 - 1;
        client.anim_end = FRAME_attack8;
      }
    }

    client.ps.gunframe++;
    if (client.ps.gunframe === 12 && client.pers.inventory[client.ammo_index]) client.ps.gunframe = 6;
  }

  if (client.ps.gunframe === 12) {
    gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
    client.weapon_sound = 0;
  }
}

export function Weapon_HyperBlaster(ent: EdictT): void {
  const pause_frames: number[] = [];
  const fire_frames = [6, 7, 8, 9, 10, 11];

  Weapon_Generic(ent, 5, 20, 49, 53, pause_frames, fire_frames, Weapon_HyperBlaster_Fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 5, 20, 49, 53, pause_frames, fire_frames, Weapon_HyperBlaster_Fire);
}

/*
======================================================================

MACHINEGUN / CHAINGUN

======================================================================
*/

// non-static in C but only called within this file; exported anyway for
// direct testability (this unit's test brief covers Machinegun_Fire
// specifically).
export function Machinegun_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 8;
  let kick = 2;

  if (!(client.buttons & BUTTON_ATTACK)) {
    client.machinegun_shots = 0;
    client.ps.gunframe++;
    return;
  }

  if (client.ps.gunframe === 5) client.ps.gunframe = 4;
  else client.ps.gunframe = 5;

  if (client.pers.inventory[client.ammo_index] < 1) {
    client.ps.gunframe = 6;
    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }
    NoAmmoWeaponChange(ent);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier; // PGM
    kick *= damage_multiplier;
  }

  for (let i = 1; i < 3; i++) {
    client.kick_origin[i] = crandom() * 0.35;
    client.kick_angles[i] = crandom() * 0.7;
  }
  client.kick_origin[0] = crandom() * 0.35;
  client.kick_angles[0] = client.machinegun_shots * -1.5;

  // raise the gun as it is firing
  if (!cvarNum(gameCvars.deathmatch)) {
    client.machinegun_shots++;
    if (client.machinegun_shots > 9) client.machinegun_shots = 9;
  }

  // get start / end positions
  const angles = vec3();
  VectorAdd(client.v_angle, client.kick_angles, angles);
  const forward = vec3();
  const right = vec3();
  AngleVectors(angles, forward, right, null);
  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_bullet(ent, start, forward, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_MACHINEGUN);

  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_MACHINEGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

  client.anim_priority = ANIM_ATTACK;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crattak1 - ((random() + 0.25) | 0);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - ((random() + 0.25) | 0);
    client.anim_end = FRAME_attack8;
  }
}

export function Weapon_Machinegun(ent: EdictT): void {
  const pause_frames = [23, 45];
  const fire_frames = [4, 5];

  Weapon_Generic(ent, 3, 5, 45, 49, pause_frames, fire_frames, Machinegun_Fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 3, 5, 45, 49, pause_frames, fire_frames, Machinegun_Fire);
}

function Chaingun_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let kick = 2;
  let damage = cvarNum(gameCvars.deathmatch) ? 6 : 8;

  if (client.ps.gunframe === 5) gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/chngnu1a.wav"), 1, ATTN_IDLE, 0);

  if (client.ps.gunframe === 14 && !(client.buttons & BUTTON_ATTACK)) {
    client.ps.gunframe = 32;
    client.weapon_sound = 0;
    return;
  } else if (client.ps.gunframe === 21 && client.buttons & BUTTON_ATTACK && client.pers.inventory[client.ammo_index]) {
    client.ps.gunframe = 15;
  } else {
    client.ps.gunframe++;
  }

  if (client.ps.gunframe === 22) {
    client.weapon_sound = 0;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("weapons/chngnd1a.wav"), 1, ATTN_IDLE, 0);
  } else {
    client.weapon_sound = gi.soundindex("weapons/chngnl1a.wav");
  }

  client.anim_priority = ANIM_ATTACK;
  if (client.ps.pmove.pm_flags & PMF_DUCKED) {
    ent.s.frame = FRAME_crattak1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_attack8;
  }

  let shots: number;
  if (client.ps.gunframe <= 9) shots = 1;
  else if (client.ps.gunframe <= 14) shots = client.buttons & BUTTON_ATTACK ? 2 : 1;
  else shots = 3;

  if (client.pers.inventory[client.ammo_index] < shots) shots = client.pers.inventory[client.ammo_index];

  if (!shots) {
    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }
    NoAmmoWeaponChange(ent);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier; // PGM
    kick *= damage_multiplier;
  }

  for (let i = 0; i < 3; i++) {
    client.kick_origin[i] = crandom() * 0.35;
    client.kick_angles[i] = crandom() * 0.7;
  }

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  let start = vec3();
  for (let i = 0; i < shots; i++) {
    // get start / end positions
    AngleVectors(client.v_angle, forward, right, up);
    const r = 7 + crandom() * 4;
    const u = crandom() * 4;
    const offset = vec3(0, r, u + ent.viewheight - 8);
    start = vec3();
    P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

    fire_bullet(ent, start, forward, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_CHAINGUN);
  }

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte((MZ_CHAINGUN1 + shots - 1) | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= shots;
}

export function Weapon_Chaingun(ent: EdictT): void {
  const pause_frames = [38, 43, 51, 61];
  const fire_frames = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];

  Weapon_Generic(ent, 4, 31, 61, 64, pause_frames, fire_frames, Chaingun_Fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 4, 31, 61, 64, pause_frames, fire_frames, Chaingun_Fire);
}

/*
======================================================================

SHOTGUN / SUPERSHOTGUN

======================================================================
*/

function weapon_shotgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 4;
  let kick = 8;

  if (client.ps.gunframe === 9) {
    client.ps.gunframe++;
    return;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -2;

  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  if (is_quad) {
    damage *= damage_multiplier; // PGM
    kick *= damage_multiplier;
  }

  if (cvarNum(gameCvars.deathmatch)) {
    fire_shotgun(ent, start, forward, damage, kick, 500, 500, DEFAULT_DEATHMATCH_SHOTGUN_COUNT, MOD_SHOTGUN);
  } else {
    fire_shotgun(ent, start, forward, damage, kick, 500, 500, DEFAULT_SHOTGUN_COUNT, MOD_SHOTGUN);
  }

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_SHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_Shotgun(ent: EdictT): void {
  const pause_frames = [22, 28, 34];
  const fire_frames = [8, 9];

  Weapon_Generic(ent, 7, 18, 36, 39, pause_frames, fire_frames, weapon_shotgun_fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 7, 18, 36, 39, pause_frames, fire_frames, weapon_shotgun_fire);
}

function weapon_supershotgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 6;
  let kick = 12;

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -2;

  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  if (is_quad) {
    damage *= damage_multiplier; // PGM
    kick *= damage_multiplier;
  }

  const v = vec3();
  v[PITCH] = client.v_angle[PITCH];
  v[YAW] = client.v_angle[YAW] - 5;
  v[ROLL] = client.v_angle[ROLL];
  AngleVectors(v, forward, null, null);
  fire_shotgun(ent, start, forward, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);
  v[YAW] = client.v_angle[YAW] + 5;
  AngleVectors(v, forward, null, null);
  fire_shotgun(ent, start, forward, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_SSHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= 2;
}

export function Weapon_SuperShotgun(ent: EdictT): void {
  const pause_frames = [29, 42, 57];
  const fire_frames = [7];

  Weapon_Generic(ent, 6, 17, 57, 61, pause_frames, fire_frames, weapon_supershotgun_fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 6, 17, 57, 61, pause_frames, fire_frames, weapon_supershotgun_fire);
}

/*
======================================================================

RAILGUN

======================================================================
*/

function weapon_railgun_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage: number;
  let kick: number;
  if (cvarNum(gameCvars.deathmatch)) {
    // normal damage is too extreme in dm
    damage = 100;
    kick = 200;
  } else {
    damage = 150;
    kick = 250;
  }

  if (is_quad) {
    damage *= damage_multiplier; // PGM
    kick *= damage_multiplier;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -3, client.kick_origin);
  client.kick_angles[0] = -3;

  const offset = vec3(0, 7, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_rail(ent, start, forward, damage, kick);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_RAILGUN | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
}

export function Weapon_Railgun(ent: EdictT): void {
  const pause_frames = [56];
  const fire_frames = [4];

  Weapon_Generic(ent, 3, 18, 56, 61, pause_frames, fire_frames, weapon_railgun_fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 3, 18, 56, 61, pause_frames, fire_frames, weapon_railgun_fire);
}

/*
======================================================================

BFG10K

======================================================================
*/

function weapon_bfg_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const damage_radius = 1000;
  let damage = cvarNum(gameCvars.deathmatch) ? 200 : 500;
  // C declares `start` at the top of the function and reads it uninitialized
  // on the early-return branch below (a real bug carried through 3.20/3.21);
  // zero-initialized here since there is no uninitialized stack memory to read.
  const start = vec3();

  if (client.ps.gunframe === 9) {
    // send muzzle flash
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(ent.s.number);
    gi.WriteByte(MZ_BFG | is_silenced);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

    client.ps.gunframe++;

    PlayerNoise(ent, start, PNOISE_WEAPON);
    return;
  }

  // cells can go down during windup (from power armor hits), so
  // check again and abort firing if we don't have enough now
  if (client.pers.inventory[client.ammo_index] < 50) {
    client.ps.gunframe++;
    return;
  }

  if (is_quad) damage *= damage_multiplier; // PGM

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);

  // make a big pitch kick with an inverse fall
  client.v_dmg_pitch = -40;
  client.v_dmg_roll = crandom() * 8;
  client.v_dmg_time = level.time + DAMAGE_TIME;

  const offset = vec3(8, 8, ent.viewheight - 8);
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);
  fire_bfg(ent, start, forward, damage, 400, damage_radius);

  client.ps.gunframe++;

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index] -= 50;
}

export function Weapon_BFG(ent: EdictT): void {
  const pause_frames = [39, 45, 50, 55];
  const fire_frames = [9, 17];

  Weapon_Generic(ent, 8, 32, 55, 58, pause_frames, fire_frames, weapon_bfg_fire);

  // xatrix/p_weapon.c: `// RAFAEL` -- quadfire doubles the shot by
  // re-running the same generic weapon think when active.
  if (is_quadfire) Weapon_Generic(ent, 8, 32, 55, 58, pause_frames, fire_frames, weapon_bfg_fire);
}

//======================================================================
// RERELEASE CONTENT PORT -- ROGUE MODS BELOW (rogue/p_weapon.c)
//======================================================================

//
// CHAINFIST
//
const CHAINFIST_REACH = 64;

function weapon_chainfist_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  const weapon = client.pers.weapon;

  let damage = 15;
  if (cvarNum(gameCvars.deathmatch)) damage = 30;

  if (is_quad) damage *= damage_multiplier;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(client.v_angle, forward, right, up);

  // kick back
  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  // set start point
  const offset = vec3(0, 8, ent.viewheight - 4);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  fire_player_melee(ent, start, forward, CHAINFIST_REACH, damage, 100, 1, MOD_CHAINFIST);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  client.ps.gunframe++;
  if (weapon !== null) client.pers.inventory[client.ammo_index] -= weapon.quantity;
}

// this spits out some smoke from the motor. it's a two-stroke, you know.
function chainfist_smoke(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(client.v_angle, forward, right, up);
  const offset = vec3(8, 8, ent.viewheight - 4);
  const tempVec = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, tempVec);

  gi.WriteByte(svc_temp_entity);
  gi.WriteByte(TempEventT.TE_CHAINFIST_SMOKE);
  gi.WritePosition(tempVec);
  gi.unicast(ent, false);
}

export function Weapon_ChainFist(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const pause_frames = [0];
  const fire_frames = [8, 9, 16, 17, 18, 30, 31];

  let last_sequence = 0;

  // `#define HOLD_FRAMES 0` -- the two `#if HOLD_FRAMES` branches that sit
  // between the "go idle" and "idle smoke" branches below never compile in
  // the shipped binary; dropped per PORTING.md's "#if 0 blocks".
  if (client.ps.gunframe === 13 || client.ps.gunframe === 23) {
    // end of attack, go idle
    client.ps.gunframe = 32;
  } else if (client.ps.gunframe === 42 && Math.floor(Math.random() * 8) !== 0) {
    // holds for idle sequence
    if (client.pers.hand !== CENTER_HANDED && random() < 0.4) chainfist_smoke(ent);
  } else if (client.ps.gunframe === 51 && Math.floor(Math.random() * 8) !== 0) {
    if (client.pers.hand !== CENTER_HANDED && random() < 0.4) chainfist_smoke(ent);
  }

  // set the appropriate weapon sound.
  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    client.weapon_sound = gi.soundindex("weapons/sawhit.wav");
  } else if (client.weaponstate === WeaponstateT.WEAPON_DROPPING) {
    client.weapon_sound = 0;
  } else {
    client.weapon_sound = gi.soundindex("weapons/sawidle.wav");
  }

  Weapon_Generic(ent, 4, 32, 57, 60, pause_frames, fire_frames, weapon_chainfist_fire);

  if ((client.buttons & BUTTON_ATTACK) !== 0) {
    if (client.ps.gunframe === 13 || client.ps.gunframe === 23 || client.ps.gunframe === 32) {
      last_sequence = client.ps.gunframe;
      client.ps.gunframe = 6;
    }
  }

  if (client.ps.gunframe === 6) {
    let chance = random();
    if (last_sequence === 13) {
      // if we just did sequence 1, do 2 or 3.
      chance -= 0.34;
    } else if (last_sequence === 23) {
      // if we just did sequence 2, do 1 or 3
      chance += 0.33;
    } else if (last_sequence === 32) {
      // if we just did sequence 3, do 1 or 2
      if (chance >= 0.33) chance += 0.34;
    }

    if (chance < 0.33) client.ps.gunframe = 14;
    else if (chance < 0.66) client.ps.gunframe = 24;
  }
}

//
// Disintegrator
//

function weapon_tracker_fire(self: EdictT): void {
  const client = self.client;
  if (client === null) return;
  const weapon = client.pers.weapon;

  // PMM - felt a little high at 25
  const damage = cvarNum(gameCvars.deathmatch) ? 30 : 45;
  const dmg = is_quad ? damage * damage_multiplier : damage; // pgm

  const mins = vec3(-16, -16, -16);
  const maxs = vec3(16, 16, 16);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const offset = vec3(24, 8, self.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, self.s.origin, offset, forward, right, start);

  // FIXME - can we shorten this? do we need to?
  const end = vec3();
  VectorMA(start, 8192, forward, end);
  let enemy: EdictT | null = null;
  // PMM - doing two traces .. one point and one box.
  let tr = gi.trace(start, vec3_origin, vec3_origin, end, self, MASK_SHOT);
  let hit = traceEdict(tr.ent);
  if (hit !== world()) {
    if (
      ((hit.svflags & SVF_MONSTER) !== 0 || hit.client !== null || (hit.svflags & SVF_DAMAGEABLE) !== 0) &&
      hit.health > 0
    ) {
      enemy = hit;
    }
  } else {
    tr = gi.trace(start, mins, maxs, end, self, MASK_SHOT);
    hit = traceEdict(tr.ent);
    if (hit !== world()) {
      if (
        ((hit.svflags & SVF_MONSTER) !== 0 || hit.client !== null || (hit.svflags & SVF_DAMAGEABLE) !== 0) &&
        hit.health > 0
      ) {
        enemy = hit;
      }
    }
  }

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  fire_tracker(self, start, forward, dmg, 1000, enemy);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(self.s.number);
  gi.WriteByte(MZ_TRACKER);
  gi.multicast(self.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(self, start, PNOISE_WEAPON);

  client.ps.gunframe++;
  if (weapon !== null) client.pers.inventory[client.ammo_index] -= weapon.quantity;
}

export function Weapon_Disintegrator(ent: EdictT): void {
  const pause_frames = [14, 19, 23];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 9, 29, 34, pause_frames, fire_frames, weapon_tracker_fire);
}

/*
======================================================================

ETF RIFLE

======================================================================
*/

function weapon_etf_rifle_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  const weapon = client.pers.weapon;
  if (weapon === null) return; // defensive; Think_Weapon only calls weaponthink when pers.weapon is set

  let damage: number;
  if (cvarNum(gameCvars.deathmatch)) damage = 10;
  else damage = 10;
  let kick = 3;

  // PGM - adjusted to use the quantity entry in the weapon structure.
  if (client.pers.inventory[client.ammo_index] < weapon.quantity) {
    VectorClear(client.kick_origin);
    VectorClear(client.kick_angles);
    client.ps.gunframe = 8;

    if (level.time >= ent.pain_debounce_time) {
      gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      ent.pain_debounce_time = level.time + 1;
    }
    NoAmmoWeaponChange(ent);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  for (let i = 0; i < 3; i++) {
    client.kick_origin[i] = crandom() * 0.85;
    client.kick_angles[i] = crandom() * 0.85;
  }

  // get start / end positions
  // C computes `angles` here (v_angle + kick_angles) but never actually
  // uses it -- AngleVectors is called with client.v_angle directly two
  // lines later. Preserved as dead computation, exactly as written.
  const angles = vec3();
  VectorAdd(client.v_angle, client.kick_angles, angles);
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(client.v_angle, forward, right, up);

  // FIXME - set correct frames for different offsets.
  const offset = vec3();
  if (client.ps.gunframe === 6) {
    // right barrel
    VectorSet(offset, 15, 8, -8);
  } else {
    // left barrel
    VectorSet(offset, 15, 6, -8);
  }

  const tempPt = vec3();
  VectorCopy(ent.s.origin, tempPt);
  tempPt[2] += ent.viewheight;
  const start = vec3();
  P_ProjectSource2(client, tempPt, offset, forward, right, up, start);
  fire_flechette(ent, start, forward, damage, 750, kick);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_ETF_RIFLE);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  client.ps.gunframe++;
  client.pers.inventory[client.ammo_index] -= weapon.quantity;

  client.anim_priority = ANIM_ATTACK;
  if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - 1;
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - 1;
    client.anim_end = FRAME_attack8;
  }
}

export function Weapon_ETF_Rifle(ent: EdictT): void {
  const client = ent.client;
  const pause_frames = [18, 28];
  const fire_frames = [6, 7];

  // note - if you change the fire frame number, fix the offset in weapon_etf_rifle_fire.
  if (client !== null && client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    if (client.pers.inventory[client.ammo_index] <= 0) client.ps.gunframe = 8;
  }

  Weapon_Generic(ent, 4, 7, 37, 41, pause_frames, fire_frames, weapon_etf_rifle_fire);

  if (client !== null && client.ps.gunframe === 8 && (client.buttons & BUTTON_ATTACK) !== 0) {
    client.ps.gunframe = 6;
  }
}

// pgm - this now uses ent->client->pers.weapon->quantity like all the other weapons
const HEATBEAM_DM_DMG = 15;
const HEATBEAM_SP_DMG = 15;

function Heatbeam_Fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // for comparison, the hyperblaster is 15/20
  // jim requested more damage, so try 15/15 --- PGM 07/23/98
  let damage = cvarNum(gameCvars.deathmatch) ? HEATBEAM_DM_DMG : HEATBEAM_SP_DMG;
  let kick = cvarNum(gameCvars.deathmatch) ? 75 : 30; // really knock 'em around in deathmatch

  client.ps.gunframe++;
  client.ps.gunindex = gi.modelindex("models/weapons/v_beamer2/tris.md2");

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  VectorClear(client.kick_origin);
  VectorClear(client.kick_angles);

  // get start / end positions
  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(client.v_angle, forward, right, up);

  // This offset is the "view" offset for the beam start (used by trace)
  const startOffset = vec3(7, 2, ent.viewheight - 3);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, startOffset, forward, right, start);

  // This offset is the entity offset
  const entOffset = vec3(2, 7, -3);

  fire_heat(ent, start, forward, entOffset, damage, kick, false);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_HEATBEAM | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) {
    const weapon = client.pers.weapon;
    if (weapon !== null) client.pers.inventory[client.ammo_index] -= weapon.quantity;
  }

  client.anim_priority = ANIM_ATTACK;
  if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - 1;
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - 1;
    client.anim_end = FRAME_attack8;
  }
}

export function Weapon_Heatbeam(ent: EdictT): void {
  const client = ent.client;
  const pause_frames = [35];
  const fire_frames = [9, 10, 11, 12];

  if (client !== null) {
    if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
      client.weapon_sound = gi.soundindex("weapons/bfg__l1a.wav");
      if (client.pers.inventory[client.ammo_index] >= 2 && (client.buttons & BUTTON_ATTACK) !== 0) {
        if (client.ps.gunframe >= 13) {
          client.ps.gunframe = 9;
          client.ps.gunindex = gi.modelindex("models/weapons/v_beamer2/tris.md2");
        } else {
          client.ps.gunindex = gi.modelindex("models/weapons/v_beamer2/tris.md2");
        }
      } else {
        client.ps.gunframe = 13;
        client.ps.gunindex = gi.modelindex("models/weapons/v_beamer/tris.md2");
      }
    } else {
      client.ps.gunindex = gi.modelindex("models/weapons/v_beamer/tris.md2");
      client.weapon_sound = 0;
    }
  }

  Weapon_Generic(ent, 8, 12, 39, 44, pause_frames, fire_frames, Heatbeam_Fire);
}

//======================================================================
// RERELEASE CONTENT PORT -- XATRIX MODS BELOW (xatrix/p_weapon.c)
//======================================================================

// xatrix/p_weapon.c: `// RAFAEL 14-APR-98` -- HyperBlaster/Railgun's `use`
// function is swapped for Use_Weapon2, which redirects to the matching
// xatrix upgrade weapon (Ionripper/Phalanx) when the player already has it
// and its ammo, exactly like base Quake 2's own weapon-swap items.
export function Use_Weapon2(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  if (item.pickup_name === "HyperBlaster") {
    if (item === client.pers.weapon) {
      let candidate = requireItem(FindItem("Ionripper"));
      const index = ITEM_INDEX(candidate);
      if (!client.pers.inventory[index]) candidate = requireItem(FindItem("HyperBlaster"));
      item = candidate;
    }
  } else if (item.pickup_name === "Railgun") {
    // C dereferences item->ammo/nextitem->ammo unconditionally here; every
    // real caller passes the Railgun or Phalanx item, both of which always
    // have a non-null ammo string in the item table.
    let ammo_item = requireItem(FindItem(item.ammo ?? ""));
    let ammo_index = ITEM_INDEX(ammo_item);
    if (!client.pers.inventory[ammo_index]) {
      const nextitem = requireItem(FindItem("Phalanx"));
      ammo_item = requireItem(FindItem(nextitem.ammo ?? ""));
      ammo_index = ITEM_INDEX(ammo_item);
      if (client.pers.inventory[ammo_index]) {
        let candidate = requireItem(FindItem("Phalanx"));
        const index = ITEM_INDEX(candidate);
        if (!client.pers.inventory[index]) candidate = requireItem(FindItem("Railgun"));
        item = candidate;
      }
    } else if (item === client.pers.weapon) {
      let candidate = requireItem(FindItem("Phalanx"));
      const index = ITEM_INDEX(candidate);
      if (!client.pers.inventory[index]) candidate = requireItem(FindItem("Railgun"));
      item = candidate;
    }
  }

  // see if we're already using it
  if (item === client.pers.weapon) return;

  if (item.ammo !== null && item.ammo.length > 0) {
    const ammo_item = requireItem(FindItem(item.ammo));
    const ammo_index = ITEM_INDEX(ammo_item);
    if (!client.pers.inventory[ammo_index] && !cvarNum(gameCvars.g_select_empty)) {
      gi.cprintf(ent, PRINT_HIGH, `No ${ammo_item.pickup_name} for ${item.pickup_name}.\n`);
      return;
    }
  }

  // change to this weapon when down
  client.newweapon = item;
}

/*
======================================================================

RIPPERGUN (Ionripper)

======================================================================
*/

function weapon_ionripper_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage: number;
  let kick: number;
  if (cvarNum(gameCvars.deathmatch)) {
    // tone down for deathmatch
    damage = 30;
    kick = 40;
  } else {
    damage = 50;
    kick = 60;
  }

  // MERGE NOTE: xatrix says `*= 4` here; `damage_multiplier` is used so
  // rogue's Double Damage stacks the same way it does on every other
  // weapon in the merged module (see this file's header note 3).
  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  const tempang = vec3();
  VectorCopy(client.v_angle, tempang);
  tempang[YAW] += crandom();

  const forward = vec3();
  const right = vec3();
  AngleVectors(tempang, forward, right, null);

  VectorScale(forward, -3, client.kick_origin);
  client.kick_angles[0] = -3;

  const offset = vec3(16, 7, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  fire_ionripper(ent, start, forward, damage, 500, EF_IONRIPPER);

  // send muzzle flash
  gi.WriteByte(svc_muzzleflash);
  gi.WriteShort(ent.s.number);
  gi.WriteByte(MZ_IONRIPPER | is_silenced);
  gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

  client.ps.gunframe++;
  PlayerNoise(ent, start, PNOISE_WEAPON);

  if (!(dmFlags() & DF_INFINITE_AMMO)) {
    const weaponQuantity = client.pers.weapon === null ? 0 : client.pers.weapon.quantity;
    client.pers.inventory[client.ammo_index] -= weaponQuantity;
  }

  if (client.pers.inventory[client.ammo_index] < 0) client.pers.inventory[client.ammo_index] = 0;
}

export function Weapon_Ionripper(ent: EdictT): void {
  const pause_frames = [36];
  const fire_frames = [5];

  Weapon_Generic(ent, 4, 6, 36, 39, pause_frames, fire_frames, weapon_ionripper_fire);

  if (is_quadfire) Weapon_Generic(ent, 4, 6, 36, 39, pause_frames, fire_frames, weapon_ionripper_fire);
}

/*
======================================================================

PHALANX

======================================================================
*/

function weapon_phalanx_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = (70 + random() * 10.0) | 0;
  let radius_damage = 120;
  const damage_radius = 120;

  // MERGE NOTE: see weapon_ionripper_fire above.
  if (is_quad) {
    damage *= damage_multiplier;
    radius_damage *= damage_multiplier;
  }

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -2;

  const offset = vec3(0, 8, ent.viewheight - 8);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  if (client.ps.gunframe === 8) {
    const v = vec3();
    v[PITCH] = client.v_angle[PITCH];
    v[YAW] = client.v_angle[YAW] - 1.5;
    v[ROLL] = client.v_angle[ROLL];
    const up = vec3();
    AngleVectors(v, forward, right, up);

    fire_plasma(ent, start, forward, damage, 725, damage_radius, 30);

    if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;
  } else {
    const v = vec3();
    v[PITCH] = client.v_angle[PITCH];
    v[YAW] = client.v_angle[YAW] + 1.5;
    v[ROLL] = client.v_angle[ROLL];
    const up = vec3();
    AngleVectors(v, forward, right, up);
    fire_plasma(ent, start, forward, damage, 725, damage_radius, radius_damage);

    // send muzzle flash
    gi.WriteByte(svc_muzzleflash);
    gi.WriteShort(ent.s.number);
    gi.WriteByte(MZ_PHALANX | is_silenced);
    gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

    PlayerNoise(ent, start, PNOISE_WEAPON);
  }

  client.ps.gunframe++;
}

export function Weapon_Phalanx(ent: EdictT): void {
  const pause_frames = [29, 42, 55];
  const fire_frames = [7, 8];

  Weapon_Generic(ent, 5, 20, 58, 63, pause_frames, fire_frames, weapon_phalanx_fire);

  if (is_quadfire) Weapon_Generic(ent, 5, 20, 58, 63, pause_frames, fire_frames, weapon_phalanx_fire);
}

/*
======================================================================

TRAP

======================================================================
*/

// xatrix/p_weapon.c defines `TRAP_TIMER 5.0` / `TRAP_MINSPEED 300` /
// `TRAP_MAXSPEED 700` alongside weapon_trap_fire, but every actual use in
// both weapon_trap_fire (the speed calc) and Weapon_Trap (the gunframe-11
// re-arm timer) references the pre-existing GRENADE_TIMER/GRENADE_MINSPEED/
// GRENADE_MAXSPEED constants instead -- the TRAP_* trio is dead code.
// Preserved as a documented no-op rather than defined-and-unused consts.

function weapon_trap_fire(ent: EdictT, held: boolean): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 125;
  const radius = damage + 40;
  // MERGE NOTE: see weapon_ionripper_fire above.
  if (is_quad) damage *= damage_multiplier;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  const timer = client.grenade_time - level.time;
  const speed =
    (GRENADE_MINSPEED + (GRENADE_TIMER - timer) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / GRENADE_TIMER)) | 0;
  fire_trap(ent, start, forward, damage, speed, timer, radius, held);

  // xatrix/p_weapon.c: "you don't get infinite traps! ZOID" -- the
  // DF_INFINITE_AMMO guard other grenade-style weapons use is commented out
  // in the C for this one; every fire always consumes a trap.
  client.pers.inventory[client.ammo_index]--;

  client.grenade_time = level.time + 1.0;
}

export function Weapon_Trap(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.newweapon !== null && client.weaponstate === WeaponstateT.WEAPON_READY) {
    ChangeWeapon(ent);
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    client.weaponstate = WeaponstateT.WEAPON_READY;
    client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    if ((client.latched_buttons | client.buttons) & BUTTON_ATTACK) {
      client.latched_buttons &= ~BUTTON_ATTACK;
      if (client.pers.inventory[client.ammo_index]) {
        client.ps.gunframe = 1;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;
        client.grenade_time = 0;
      } else {
        if (level.time >= ent.pain_debounce_time) {
          gi.sound(ent, CHAN_VOICE, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
          ent.pain_debounce_time = level.time + 1;
        }
        NoAmmoWeaponChange(ent);
      }
      return;
    }

    if (
      client.ps.gunframe === 29 ||
      client.ps.gunframe === 34 ||
      client.ps.gunframe === 39 ||
      client.ps.gunframe === 48
    ) {
      // rand()&15, see the comment in Weapon_Generic
      if (Math.floor(Math.random() * 16) !== 0) return;
    }

    if (++client.ps.gunframe > 48) client.ps.gunframe = 16;
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    if (client.ps.gunframe === 5) {
      // xatrix/p_weapon.c: `// RAFAEL 16-APR-98` swaps the borrowed grenade
      // cock sound for the trap's own.
      gi.sound(ent, CHAN_WEAPON, gi.soundindex("weapons/trapcock.wav"), 1, ATTN_NORM, 0);
    }

    if (client.ps.gunframe === 11) {
      if (!client.grenade_time) {
        // xatrix/p_weapon.c: reuses GRENADE_TIMER here, not the dead
        // TRAP_TIMER constant (see the comment above weapon_trap_fire).
        client.grenade_time = level.time + GRENADE_TIMER + 0.2;
        // xatrix/p_weapon.c: `// RAFAEL 16-APR-98`
        client.weapon_sound = gi.soundindex("weapons/traploop.wav");
      }

      // they waited too long, detonate it in their hand
      if (!client.grenade_blew_up && level.time >= client.grenade_time) {
        client.weapon_sound = 0;
        weapon_trap_fire(ent, true);
        client.grenade_blew_up = true;
      }

      if (client.buttons & BUTTON_ATTACK) return;

      if (client.grenade_blew_up) {
        if (level.time >= client.grenade_time) {
          client.ps.gunframe = 15;
          client.grenade_blew_up = false;
        } else {
          return;
        }
      }
    }

    if (client.ps.gunframe === 12) {
      client.weapon_sound = 0;
      weapon_trap_fire(ent, false);
      if (client.pers.inventory[client.ammo_index] === 0) NoAmmoWeaponChange(ent);
    }

    if (client.ps.gunframe === 15 && level.time < client.grenade_time) return;

    client.ps.gunframe++;

    if (client.ps.gunframe === 16) {
      client.grenade_time = 0;
      client.weaponstate = WeaponstateT.WEAPON_READY;
    }
  }
}
