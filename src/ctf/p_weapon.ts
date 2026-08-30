// p_weapon.c
//
// g_local.h calls this file "g_pweapon.c" (does not exist) for
// `PlayerNoise`. The other 14 functions here are forward-declared as
// `extern` at the top of g_items.c (its itemlist table references them);
// grepping the C tree confirms all 14 are actually defined in p_weapon.c,
// not g_items.c, so they are attributed here per PORTING.md.
//
// m_player.h frame split: m_player.h is a 200+ constant qdata-generated
import { FRAME_attack1, FRAME_attack8, FRAME_pain301, FRAME_pain304, FRAME_crattak1, FRAME_crattak3, FRAME_crattak9, FRAME_crpain1, FRAME_crpain4, FRAME_wave01, FRAME_wave08 } from "./m_player_frames";

import { AngleVectors, crandom, random, vec3, type Vec3, vec3_origin, VectorAdd, VectorCopy, VectorScale, VectorSet, VectorSubtract } from "../shared/math";
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
  DF_WEAPONS_STAY,
  EF_BLASTER,
  EF_HYPERBLASTER,
  MulticastT,
  MZ_BFG,
  MZ_BLASTER,
  MZ_CHAINGUN1,
  MZ_GRENADE,
  MZ_HYPERBLASTER,
  MZ_MACHINEGUN,
  MZ_RAILGUN,
  MZ_ROCKET,
  MZ_SHOTGUN,
  MZ_SILENCED,
  MZ_SSHOTGUN,
  PITCH,
  PMF_DUCKED,
  PRINT_HIGH,
  Q_stricmp,
  ROLL,
  YAW,
} from "../shared/q_shared";
import {
  ANIM_ATTACK,
  ANIM_PAIN,
  ANIM_REVERSE,
  CENTER_HANDED,
  DAMAGE_TIME,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  type EdictT,
  FL_NOTARGET,
  FL_RESPAWN,
  gameCvars,
  type GClientT,
  gi,
  type GItemT,
  IT_AMMO,
  LEFT_HANDED,
  level,
  MOD_CHAINGUN,
  MOD_MACHINEGUN,
  MOD_SHOTGUN,
  MOD_SSHOTGUN,
  PNOISE_SELF,
  PNOISE_WEAPON,
  svc_muzzleflash,
  WeaponstateT,
} from "./g_local";
import { SVF_NOCLIENT } from "./game";
import { Add_Ammo, Drop_Item, FindItem, ITEM_INDEX, SetRespawn } from "./g_items";
import { G_ProjectSource, G_Spawn } from "./g_utils";
import { fire_bfg, fire_blaster, fire_bullet, fire_grenade, fire_grenade2, fire_rail, fire_rocket, fire_shotgun } from "./g_weapon";
// ZOID: g_ctf.ts imports Weapon_Generic/P_ProjectSource/PlayerNoise from this
// file, so this is a value cycle; both sides are `function` declarations
// (hoisted, live bindings), which ES modules resolve safely across cycles
// as long as they aren't invoked during top-level evaluation -- they are
// only called from inside other functions here, so a static import is safe.
import { CTFApplyHaste, CTFApplyHasteSound, CTFApplyStrengthSound } from "./g_ctf";

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

// static in C; exported here so it is directly testable (P_ProjectSource's
// handedness math is part of this unit's test brief).
export function P_ProjectSource(client: GClientT, point: Vec3, distance: Vec3, forward: Vec3, right: Vec3, result: Vec3): void {
  const _distance = vec3();
  VectorCopy(distance, _distance);
  if (client.pers.hand === LEFT_HANDED) _distance[1] *= -1;
  else if (client.pers.hand === CENTER_HANDED) _distance[1] = 0;
  G_ProjectSource(point, _distance, forward, right, result);
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
    if (item.ammo !== null && item.ammo.length > 0) {
      const ammo = requireItem(FindItem(item.ammo));
      if (dmFlags() & DF_INFINITE_AMMO) Add_Ammo(other, ammo, 1000);
      else Add_Ammo(other, ammo, ammo.quantity);
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
  const hyperblaster = requireItem(FindItem("hyperblaster"));
  if (client.pers.inventory[ITEM_INDEX(cells)] && client.pers.inventory[ITEM_INDEX(hyperblaster)]) {
    client.newweapon = hyperblaster;
    return;
  }
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
    is_quad = client.quad_framenum > level.framenum;
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
function Weapon_Generic2(
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
    if (client.ps.gunframe === FRAME_ACTIVATE_LAST || cvarNum(gameCvars.instantweap) !== 0) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = FRAME_IDLE_FIRST;
      return;
    }

    client.ps.gunframe++;
    return;
  }

  if (client.newweapon !== null && client.weaponstate !== WeaponstateT.WEAPON_FIRING) {
    client.weaponstate = WeaponstateT.WEAPON_DROPPING;
    if (cvarNum(gameCvars.instantweap) !== 0) {
      ChangeWeapon(ent);
      return;
    } else {
      client.ps.gunframe = FRAME_DEACTIVATE_FIRST;
    }

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
        if (!CTFApplyStrengthSound(ent)) {
          if (client.quad_framenum > level.framenum) {
            gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
          }
        }
        CTFApplyHasteSound(ent);

        fire(ent);
        matched = true;
        break;
      }
    }

    if (!matched) client.ps.gunframe++;

    if (client.ps.gunframe === FRAME_IDLE_FIRST + 1) client.weaponstate = WeaponstateT.WEAPON_READY;
  }
}

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

  const oldstate = client.weaponstate;

  Weapon_Generic2(ent, FRAME_ACTIVATE_LAST, FRAME_FIRE_LAST, FRAME_IDLE_LAST, FRAME_DEACTIVATE_LAST, pause_frames, fire_frames, fire);

  const isGrapple = client.pers.weapon !== null && client.pers.weapon.pickup_name !== null && Q_stricmp(client.pers.weapon.pickup_name, "Grapple") === 0;

  // run the weapon frame again if hasted
  if (isGrapple && client.weaponstate === WeaponstateT.WEAPON_FIRING) return;

  if ((CTFApplyHaste(ent) || (isGrapple && client.weaponstate !== WeaponstateT.WEAPON_FIRING)) && oldstate === client.weaponstate) {
    Weapon_Generic2(ent, FRAME_ACTIVATE_LAST, FRAME_FIRE_LAST, FRAME_IDLE_LAST, FRAME_DEACTIVATE_LAST, pause_frames, fire_frames, fire);
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

  let damage = 125;
  const radius = damage + 40;
  if (is_quad) damage *= 4;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  const timer = client.grenade_time - level.time;
  const speed = (GRENADE_MINSPEED + (GRENADE_TIMER - timer) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / GRENADE_TIMER)) | 0;
  fire_grenade2(ent, start, forward, damage, speed, timer, radius, held);

  if (!(dmFlags() & DF_INFINITE_AMMO)) client.pers.inventory[client.ammo_index]--;

  client.grenade_time = level.time + 1.0;

  if (ent.deadflag || ent.s.modelindex !== 255) {
    // VWep animations screw up corpses
    return;
  }

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

/*
======================================================================

GRENADE LAUNCHER

======================================================================
*/

function weapon_grenadelauncher_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let damage = 120;
  const radius = damage + 40;
  if (is_quad) damage *= 4;

  const offset = vec3(8, 8, ent.viewheight - 8);
  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);
  const start = vec3();
  P_ProjectSource(client, ent.s.origin, offset, forward, right, start);

  VectorScale(forward, -2, client.kick_origin);
  client.kick_angles[0] = -1;

  fire_grenade(ent, start, forward, damage, 600, 2.5, radius);

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
}

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
    damage *= 4;
    radius_damage *= 4;
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
}

/*
======================================================================

BLASTER / HYPERBLASTER

======================================================================
*/

function Blaster_Fire(ent: EdictT, g_offset: Vec3, damage: number, hyper: boolean, effect: number): void {
  const client = ent.client;
  if (client === null) return;

  if (is_quad) damage *= 4;
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
    damage *= 4;
    kick *= 4;
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
    damage *= 4;
    kick *= 4;
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
    damage *= 4;
    kick *= 4;
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
    damage *= 4;
    kick *= 4;
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
    damage *= 4;
    kick *= 4;
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
}

/*
======================================================================

BFG10K

======================================================================
*/

function weapon_bfg_fire(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // C: `vec3_t offset, start;` declared at the top of the function; the
  // gunframe===9 branch below reads `start` before it is ever assigned by
  // P_ProjectSource further down (a genuine upstream 3.21 bug -- it reads
  // whatever the C stack happened to hold). A zero vector is the closest
  // deterministic TS stand-in for that uninitialized read; see this unit's
  // report.
  const start = vec3();

  const damage_radius = 1000;
  let damage = cvarNum(gameCvars.deathmatch) ? 200 : 500;

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

  if (is_quad) damage *= 4;

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
}
