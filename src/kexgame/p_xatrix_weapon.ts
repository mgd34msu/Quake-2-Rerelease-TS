// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_xatrix_weapon.cpp -- xatrix (Ground Zero mission pack) player weapon
// think/fire entry points: the Ionripper, the Phalanx, and the Trap. Ported
// from ~/Projects/quake2-rerelease-dll/rerelease/xatrix/p_xatrix_weapon.cpp
// (165 lines, C++17): weapon_ionripper_fire/Weapon_Ionripper,
// weapon_phalanx_fire/Weapon_Phalanx, weapon_trap_fire/Weapon_Trap.
// Behavioral code, ported bug-for-bug per PORTING.md.
//
// Reuses p_weapon.ts's own real, exported `Weapon_Generic`/`Throw_Generic`
// state-machine plumbing, `P_ProjectSource`/`P_AddWeaponKick`/`PlayerNoise`/
// `G_RemoveAmmo` helpers, and `is_quad`/`damage_multiplier`/`is_silenced`
// mutable module state (see p_weapon.ts's own header for the export/live-
// binding rationale) -- exactly mirroring how p_weapon.cpp's OWN
// Blaster/Shotgun/etc. fire functions use them, just from a sibling
// translation unit instead of the same one.
//
// ============================================================================
// STUB SWAP -- g_items.ts's Weapon_Ionripper/Weapon_Phalanx/Weapon_Trap
// ============================================================================
// g_items.ts's itemlist wires `weaponthink: Weapon_Ionripper` /
// `Weapon_Phalanx` / `Weapon_Trap` directly onto the `weapon_boomer`/
// `weapon_phalanx`/`ammo_trap` item entries, but (before this unit) all
// three were local, unexported, cited throwing stubs there. This unit's
// report documents the exact diff swapping those three stubs for imports
// from this file.

import { type Vec3, vec3 } from "../shared/math";
import { PlayerMuzzleT, ServerCommandT, KexMulticastT, CvarFlagsT, EffectsT } from "../kexapi/game";
import { type EdictT, PlayerNoiseT } from "./g_local";
import { Gtime_subtract, Gtime_seconds, Gtime_from_sec, GTIME_ZERO } from "./gtime";
import { irandom, crandom } from "./q_std";
import { PITCH, YAW, ROLL } from "../shared/q_shared";
import { gi, level } from "./g_main_globals";
import {
  is_quad,
  damage_multiplier,
  is_silenced,
  requirePlayerClient,
  P_ProjectSource,
  P_AddWeaponKick,
  PlayerNoise,
  G_RemoveAmmo,
  Weapon_Generic,
  Throw_Generic,
} from "./p_weapon";
import { fire_ionripper, fire_plasma, fire_trap } from "./g_xatrix_weapon";

// ---------------------------------------------------------------------------
// RipperGun (p_xatrix_weapon.cpp:6-51)
// ---------------------------------------------------------------------------

/** `void weapon_ionripper_fire(edict_t *ent)` (p_xatrix_weapon.cpp:10-43). */
function weapon_ionripper_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  let damage = 50;
  // tone down for deathmatch -- see file header note: "deathmatch" is read
  // via the same cvar the rest of this port line already exposes
  if (deathmatchEnabled()) damage = 30;

  if (is_quad) damage *= damage_multiplier;

  const tempang = vec3(client.v_angle[0], client.v_angle[1] + crandom(), client.v_angle[2]);

  const { start, dir } = P_ProjectSource(ent, tempang, vec3(16, 7, -8));

  P_AddWeaponKick(ent, vec3(client.v_forward[0] * -3, client.v_forward[1] * -3, client.v_forward[2] * -3), vec3(-3, 0, 0));

  fire_ionripper(ent, start, dir, damage, 500, EffectsT.EF_IONRIPPER);

  // send muzzle flash
  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_IONRIPPER | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const IONRIPPER_PAUSE_FRAMES: readonly number[] = [36, 0];
const IONRIPPER_FIRE_FRAMES: readonly number[] = [6, 0];

/** `void Weapon_Ionripper(edict_t *ent)` (p_xatrix_weapon.cpp:45-51). */
export function Weapon_Ionripper(ent: EdictT): void {
  Weapon_Generic(ent, 5, 7, 36, 39, IONRIPPER_PAUSE_FRAMES, IONRIPPER_FIRE_FRAMES, weapon_ionripper_fire);
}

// ---------------------------------------------------------------------------
// Phalanx (p_xatrix_weapon.cpp:53-127)
// ---------------------------------------------------------------------------

/** `void weapon_phalanx_fire(edict_t *ent)` (p_xatrix_weapon.cpp:57-119). */
function weapon_phalanx_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  let damage = irandom(70, 80);
  let radius_damage = 120;
  let damage_radius = 120;

  if (is_quad) {
    damage *= damage_multiplier;
    radius_damage *= damage_multiplier;
  }

  if (client.ps.gunframe === 8) {
    const v = vec3(client.v_angle[PITCH], client.v_angle[YAW] - 1.5, client.v_angle[ROLL]);

    const { start, dir } = P_ProjectSource(ent, v, vec3(0, 8, -8));

    radius_damage = 30;
    damage_radius = 120;

    fire_plasma(ent, start, dir, damage, 725, damage_radius, radius_damage);

    // send muzzle flash
    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(PlayerMuzzleT.MZ_PHALANX2 | is_silenced);
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

    G_RemoveAmmo(ent);
  } else {
    const v = vec3(client.v_angle[PITCH], client.v_angle[YAW] + 1.5, client.v_angle[ROLL]);

    const { start, dir } = P_ProjectSource(ent, v, vec3(0, 8, -8));

    fire_plasma(ent, start, dir, damage, 725, damage_radius, radius_damage);

    // send muzzle flash
    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(PlayerMuzzleT.MZ_PHALANX | is_silenced);
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

    PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);
  }

  P_AddWeaponKick(ent, vec3(client.v_forward[0] * -2, client.v_forward[1] * -2, client.v_forward[2] * -2), vec3(-2, 0, 0));
}

const PHALANX_PAUSE_FRAMES: readonly number[] = [29, 42, 55, 0];
const PHALANX_FIRE_FRAMES: readonly number[] = [7, 8, 0];

/** `void Weapon_Phalanx(edict_t *ent)` (p_xatrix_weapon.cpp:121-127). */
export function Weapon_Phalanx(ent: EdictT): void {
  Weapon_Generic(ent, 5, 20, 58, 63, PHALANX_PAUSE_FRAMES, PHALANX_FIRE_FRAMES, weapon_phalanx_fire);
}

// ---------------------------------------------------------------------------
// TRAP (p_xatrix_weapon.cpp:129-165)
// ---------------------------------------------------------------------------

const TRAP_TIMER = Gtime_from_sec(5);
const TRAP_MINSPEED = 300.0;
const TRAP_MAXSPEED = 700.0;

/** `void weapon_trap_fire(edict_t *ent, bool held)` (p_xatrix_weapon.cpp:
 *  141-158). */
function weapon_trap_fire(ent: EdictT, _held: boolean): void {
  const client = requirePlayerClient(ent);

  // Paril: kill sideways angle on grenades
  // limit upwards angle so you don't throw behind you
  const { start, dir } = P_ProjectSource(ent, vec3(Math.max(-62.5, client.v_angle[0]), client.v_angle[1], client.v_angle[2]), vec3(8, 0, -8));

  const timer = Gtime_subtract(client.grenade_time, level.time);

  const speed = Math.trunc(
    ent.health <= 0
      ? TRAP_MINSPEED
      : Math.min(TRAP_MINSPEED + Gtime_seconds(Gtime_subtract(TRAP_TIMER, timer)) * ((TRAP_MAXSPEED - TRAP_MINSPEED) / Gtime_seconds(TRAP_TIMER)), TRAP_MAXSPEED),
  );

  client.grenade_time = GTIME_ZERO;

  fire_trap(ent, start, dir, speed);

  G_RemoveAmmo(ent, 1);
}

const TRAP_PAUSE_FRAMES: readonly number[] = [29, 34, 39, 48, 0];

/** `void Weapon_Trap(edict_t *ent)` (p_xatrix_weapon.cpp:160-165). */
export function Weapon_Trap(ent: EdictT): void {
  Throw_Generic(ent, 15, 48, 5, "weapons/trapcock.wav", 11, 12, TRAP_PAUSE_FRAMES, false, "weapons/traploop.wav", weapon_trap_fire, false);
}

// ---------------------------------------------------------------------------
// small per-file helpers (duplicated on purpose, per this port line's
// established convention for tiny header-only wrappers)
// ---------------------------------------------------------------------------

function deathmatchEnabled(): boolean {
  const c = gi.cvar("deathmatch", "0", CvarFlagsT.CVAR_NOFLAGS);
  return c !== null && c.value !== 0;
}
