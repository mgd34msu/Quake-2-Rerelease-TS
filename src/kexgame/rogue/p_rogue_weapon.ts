// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_rogue_weapon.c -- the ROGUE mission pack's player-facing weapon_*
// wrappers (2023 Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/rogue/p_rogue_weapon.cpp
// (445 lines, C++17) in full: `Weapon_ProxLauncher`/`Weapon_Tesla`/
// `Weapon_ChainFist`/`Weapon_Disintegrator`/`Weapon_ETF_Rifle`/
// `Weapon_Heatbeam` -- each a `Weapon_Generic`/`Weapon_Repeating`/
// `Throw_Generic`-style state machine (see g_weapon.ts's vanilla
// Weapon_Blaster/Weapon_Grenade for the same idiom) that calls into
// g_rogue_newweap.ts's primitives (`fire_prox`/`fire_tesla`/
// `fire_player_melee`/`fire_tracker`/`fire_flechette`/`fire_heatbeam`).
//
// ============================================================================
// STUB SWAPS depended on (not edited by this unit -- landed on p_weapon.ts
// directly, see that file's own header for the citation)
// ============================================================================
// `P_DamageModifier` and `Weapon_PowerupSound` (p_weapon.cpp:35-57,
// 656-675) were both real in p_weapon.ts already, but only as local,
// unexported helpers for that file's own weapon-fire dispatch. Both are now
// `export`ed (one-line change each, no behavior change) -- `fire_nuke`
// (g_rogue_newweap.ts) calls `P_DamageModifier` directly, and this file's
// own `weapon_etf_rifle_fire`/`Heatbeam_Fire` call `Weapon_PowerupSound`
// directly, exactly the way vanilla `Weapon_Blaster`/`Weapon_HyperBlaster`
// already do in p_weapon.ts itself.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG
// ============================================================================
// - `weapon_tesla_fire(ent, held)` (p_rogue_weapon.cpp:36-51) accepts a
//   `held: boolean` parameter that is never read in the body -- ported as
//   `_held`, kept in the signature (`Throw_Generic`'s `fire` callback type
//   is `(ent, held) => void`, so the parameter can't simply be dropped).
// - Every C-array `pause_frames`/`fire_frames` in the C++ source ends with a
//   `0` sentinel (C-style null-terminated array convention) -- dropped when
//   porting to a plain `readonly number[]` literal, matching this port
//   line's own p_weapon.ts precedent (`HAND_GRENADE_PAUSE_FRAMES = [29, 34,
//   39, 48]`, no trailing `0`) since `Weapon_Generic`/`Weapon_Repeating`/
//   `Throw_Generic` check membership with `.includes()`, which needs no
//   sentinel and would otherwise wrongly treat frame `0` as a pause frame.
//   `Weapon_ChainFist`'s C++ `pause_frames[] = { 0 }` is JUST the
//   terminator -- ported as an empty array, `[]`.
// - `weapon_chainfist_fire`'s `if (... irandom(8)) chainfist_smoke(ent);`
//   (Weapon_ChainFist's smoke-on-idle check, actually) uses `irandom(8)`
//   directly as a boolean condition (C++ implicit int-to-bool: true unless
//   the roll is exactly 0, a 7/8 chance) -- ported as `irandom(8) !== 0`.
//
// ============================================================================
// g_spawn.ts ENTRIES (coordinator's responsibility -- not edited here)
// ============================================================================
// None -- this file only exports `Weapon_*(ent: EdictT): void` dispatch
// functions, which are wired up as `weaponthink`/`use` callbacks on each
// weapon's `gitem_t` entry in g_items.ts's itemlist (already landed,
// per this port line's own commit history), not through g_spawn.ts's
// spawn-function registry.

import { vec3, type Vec3 } from "../../shared/math";
import { vec3_add, vec3_muls } from "../q_vec3";
import {
  type EdictT,
  type ModT,
  AnimPriorityT,
  EntFlagsT,
  GRENADE_MAXSPEED,
  GRENADE_MINSPEED,
  GRENADE_TIMER,
  HandednessT,
  ItemIdT,
  ModIdT,
  PlayerNoiseT,
  WeaponstateT,
} from "../g_local";
import { type KexEdictT, ATTN_NORM, ButtonT, ContentsT, KexMulticastT, MASK_PROJECTILE, PlayerMuzzleT, PmflagsT, ServerCommandT, SoundchanT, SvflagsT, KexTempEventT } from "../../kexapi/game";
import { gi, g_edicts, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_ms, Gtime_seconds, Gtime_subtract, GTIME_ZERO } from "../gtime";
import { frandom, crandom, irandom } from "../q_std";
import { FRAME_attack1, FRAME_attack8, FRAME_crattak1, FRAME_crattak9 } from "../m_player";
import { G_LagCompensate, G_UnLagCompensate } from "../p_view";
import { G_ShouldPlayersCollide } from "../p_client";
import {
  requirePlayerClient,
  P_ProjectSource,
  P_AddWeaponKick,
  PlayerNoise,
  G_RemoveAmmo,
  NoAmmoWeaponChange,
  Weapon_PowerupSound,
  Weapon_Generic,
  Weapon_Repeating,
  Throw_Generic,
  is_quad,
  is_silenced,
  damage_multiplier,
} from "../p_weapon";
import { fire_prox, fire_tesla, fire_player_melee, fire_tracker, fire_flechette, fire_heatbeam } from "./g_rogue_newweap";

function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

/** `trace_t::ent` (`KexEdictT | null`) -> the game-side `EdictT`, falling
 *  back to the world edict for a null trace target -- local duplicate
 *  matching g_weapon.ts's/g_rogue_newweap.ts's own identical helper. */
function traceEdict(ent: KexEdictT | null): EdictT {
  if (ent === null) return g_edicts[0];
  return g_edicts[ent.s.number];
}

// ============================================================================
// PROX LAUNCHER (p_rogue_weapon.cpp:7-34)
// ============================================================================

/** p_rogue_weapon.cpp:7-26 `void weapon_prox_fire(edict_t *ent)`. */
function weapon_prox_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  // Paril: kill sideways angle on grenades
  // limit upwards angle so you don't fire behind you
  const { start, dir } = P_ProjectSource(ent, vec3(Math.max(-62.5, client.v_angle[0]), client.v_angle[1], client.v_angle[2]), vec3(8, 0, -8));

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  fire_prox(ent, start, dir, damage_multiplier, 600);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_PROX | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const PROX_PAUSE_FRAMES: readonly number[] = [34, 51, 59];
const PROX_FIRE_FRAMES: readonly number[] = [6];

/** p_rogue_weapon.cpp:28-34 `void Weapon_ProxLauncher(edict_t *ent)`. */
export function Weapon_ProxLauncher(ent: EdictT): void {
  Weapon_Generic(ent, 5, 16, 59, 64, PROX_PAUSE_FRAMES, PROX_FIRE_FRAMES, weapon_prox_fire);
}

// ============================================================================
// TESLA (p_rogue_weapon.cpp:36-58)
// ============================================================================

/** p_rogue_weapon.cpp:36-51 `void weapon_tesla_fire(edict_t *ent, bool
 *  held)`. See file header's "QUIRKS PRESERVED BUG-FOR-BUG" note on the
 *  unused `held` parameter. */
function weapon_tesla_fire(ent: EdictT, _held: boolean): void {
  const client = requirePlayerClient(ent);

  // Paril: kill sideways angle on grenades
  // limit upwards angle so you don't throw behind you
  const { start, dir } = P_ProjectSource(ent, vec3(Math.max(-62.5, client.v_angle[0]), client.v_angle[1], client.v_angle[2]), vec3(0, 0, -22));

  const timer = Gtime_subtract(client.grenade_time, level.time);
  const speed = Math.trunc(
    ent.health <= 0
      ? GRENADE_MINSPEED
      : Math.min(GRENADE_MINSPEED + Gtime_seconds(Gtime_subtract(GRENADE_TIMER, timer)) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / Gtime_seconds(GRENADE_TIMER)), GRENADE_MAXSPEED),
  );

  client.grenade_time = GTIME_ZERO;

  fire_tesla(ent, start, dir, damage_multiplier, speed);

  G_RemoveAmmo(ent, 1);
}

const TESLA_PAUSE_FRAMES: readonly number[] = [21];

/** p_rogue_weapon.cpp:53-58 `void Weapon_Tesla(edict_t *ent)`. */
export function Weapon_Tesla(ent: EdictT): void {
  Throw_Generic(ent, 8, 32, -1, null, 1, 2, TESLA_PAUSE_FRAMES, false, null, weapon_tesla_fire, false);
}

// ============================================================================
// CHAINFIST (p_rogue_weapon.cpp:64-173)
// ============================================================================

const CHAINFIST_REACH = 24;

/** p_rogue_weapon.cpp:69-134 `void weapon_chainfist_fire(edict_t *ent)`. */
function weapon_chainfist_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  if ((client.buttons & ButtonT.BUTTON_ATTACK) === 0) {
    if (client.ps.gunframe === 13 || client.ps.gunframe === 23 || client.ps.gunframe >= 32) {
      client.ps.gunframe = 33;
      return;
    }
  }

  let damage = 7;

  if (deathmatchEnabled()) damage = 15;

  if (is_quad) damage *= damage_multiplier;

  // set start point
  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 0, -4));

  if (fire_player_melee(ent, start, dir, CHAINFIST_REACH, damage, 100, modFromId(ModIdT.MOD_CHAINFIST))) {
    if (client.empty_click_sound < level.time) {
      client.empty_click_sound = Gtime_add(level.time, Gtime_from_ms(500));
      gi.sound(ent, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/sawslice.wav"), 1, ATTN_NORM, 0);
    }
  }

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  client.ps.gunframe++;

  if ((client.buttons & ButtonT.BUTTON_ATTACK) !== 0) {
    if (client.ps.gunframe === 12) client.ps.gunframe = 14;
    else if (client.ps.gunframe === 22) client.ps.gunframe = 24;
    else if (client.ps.gunframe >= 32) client.ps.gunframe = 7;
  }

  // start the animation
  if (client.anim_priority !== AnimPriorityT.ANIM_ATTACK || frandom() < 0.25) {
    client.anim_priority = AnimPriorityT.ANIM_ATTACK;
    if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
      ent.s.frame = FRAME_crattak1 - 1;
      client.anim_end = FRAME_crattak9;
    } else {
      ent.s.frame = FRAME_attack1 - 1;
      client.anim_end = FRAME_attack8;
    }
    client.anim_time = GTIME_ZERO;
  }
}

/** Local `deathmatch->integer` read -- matches this port line's per-file
 *  `cvarBool`/`deathmatchEnabled` duplication convention (see
 *  g_rogue_newweap.ts's own identical helper). */
function deathmatchEnabled(): boolean {
  const c = gi.cvar("deathmatch", "0", 0);
  return c !== null && c.value !== 0;
}

/** p_rogue_weapon.cpp:137-146 `void chainfist_smoke(edict_t *ent)` -- this
 *  spits out some smoke from the motor. it's a two-stroke, you know. */
function chainfist_smoke(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const { start: tempVec } = P_ProjectSource(ent, client.v_angle, vec3(8, 8, -4));

  gi.WriteByte(ServerCommandT.svc_temp_entity);
  gi.WriteByte(KexTempEventT.TE_CHAINFIST_SMOKE);
  gi.WritePosition(tempVec);
  gi.unicast(ent, false, 0);
}

const CHAINFIST_PAUSE_FRAMES: readonly number[] = [];

/** p_rogue_weapon.cpp:148-173 `void Weapon_ChainFist(edict_t *ent)`. */
export function Weapon_ChainFist(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  Weapon_Repeating(ent, 4, 32, 57, 60, CHAINFIST_PAUSE_FRAMES, weapon_chainfist_fire);

  // smoke on idle sequence
  if (client.ps.gunframe === 42 && irandom(8) !== 0) {
    if (client.pers.hand !== HandednessT.CENTER_HANDED && frandom() < 0.4) chainfist_smoke(ent);
  } else if (client.ps.gunframe === 51 && irandom(8) !== 0) {
    if (client.pers.hand !== HandednessT.CENTER_HANDED && frandom() < 0.4) chainfist_smoke(ent);
  }

  // set the appropriate weapon sound.
  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    client.weapon_sound = gi.soundindex("weapons/sawhit.wav");
  } else if (client.weaponstate === WeaponstateT.WEAPON_DROPPING) {
    client.weapon_sound = 0;
  } else if (client.pers.weapon !== null && client.pers.weapon.id === ItemIdT.IT_WEAPON_CHAINFIST) {
    client.weapon_sound = gi.soundindex("weapons/sawidle.wav");
  }
}

// ============================================================================
// DISINTEGRATOR (p_rogue_weapon.cpp:175-256)
// ============================================================================

/** p_rogue_weapon.cpp:179-248 `void weapon_tracker_fire(edict_t *self)`. */
function weapon_tracker_fire(self: EdictT): void {
  const client = requirePlayerClient(self);

  // PMM - felt a little high at 25
  let damage = deathmatchEnabled() ? 45 : 135;

  if (is_quad) damage *= damage_multiplier; // pgm

  const mins = vec3(-16, -16, -16);
  const maxs = vec3(16, 16, 16);

  const { start, dir } = P_ProjectSource(self, client.v_angle, vec3(24, 8, -8));

  const end = vec3_add(start, vec3_muls(dir, 8192));
  let enemy: EdictT | null = null;
  // PMM - doing two traces .. one point and one box.
  let mask: ContentsT = MASK_PROJECTILE;

  // [Paril-KEX]
  if (!G_ShouldPlayersCollide(true)) mask &= ~ContentsT.CONTENTS_PLAYER;

  G_LagCompensate(self, start, dir);
  let tr = gi.trace(start, null, null, end, self, mask);
  G_UnLagCompensate();

  let hit = traceEdict(tr.ent);
  if (hit !== g_edicts[0]) {
    if ((hit.svflags & SvflagsT.SVF_MONSTER) !== 0 || hit.client !== null || (hit.flags & EntFlagsT.FL_DAMAGEABLE) !== 0n) {
      if (hit.health > 0) enemy = hit;
    }
  } else {
    tr = gi.trace(start, mins, maxs, end, self, mask);
    hit = traceEdict(tr.ent);
    if (hit !== g_edicts[0]) {
      if ((hit.svflags & SvflagsT.SVF_MONSTER) !== 0 || hit.client !== null || (hit.flags & EntFlagsT.FL_DAMAGEABLE) !== 0n) {
        if (hit.health > 0) enemy = hit;
      }
    }
  }

  P_AddWeaponKick(self, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  fire_tracker(self, start, dir, damage, 1000, enemy);

  // send muzzle flash
  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(self);
  gi.WriteByte(PlayerMuzzleT.MZ_TRACKER | is_silenced);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(self, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(self);
}

const DISINTEGRATOR_PAUSE_FRAMES: readonly number[] = [14, 19, 23];
const DISINTEGRATOR_FIRE_FRAMES: readonly number[] = [5];

/** p_rogue_weapon.cpp:250-256 `void Weapon_Disintegrator(edict_t *ent)`. */
export function Weapon_Disintegrator(ent: EdictT): void {
  Weapon_Generic(ent, 4, 9, 29, 34, DISINTEGRATOR_PAUSE_FRAMES, DISINTEGRATOR_FIRE_FRAMES, weapon_tracker_fire);
}

// ============================================================================
// ETF RIFLE (p_rogue_weapon.cpp:258-350)
// ============================================================================

/** p_rogue_weapon.cpp:265-343 `void weapon_etf_rifle_fire(edict_t *ent)`. */
function weapon_etf_rifle_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = 10;
  let kick = 3;

  if ((client.buttons & ButtonT.BUTTON_ATTACK) === 0) {
    client.ps.gunframe = 8;
    return;
  }

  if (client.ps.gunframe === 6) client.ps.gunframe = 7;
  else client.ps.gunframe = 6;

  // PGM - adjusted to use the quantity entry in the weapon structure.
  const weapon = client.pers.weapon;
  if (weapon === null || client.pers.inventory[weapon.ammo] < weapon.quantity) {
    client.ps.gunframe = 8;
    NoAmmoWeaponChange(ent, true);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  const kick_origin = vec3();
  const kick_angles = vec3();
  for (let i = 0; i < 3; i++) {
    kick_origin[i] = crandom() * 0.85;
    kick_angles[i] = crandom() * 0.85;
  }
  P_AddWeaponKick(ent, kick_origin, kick_angles);

  // get start / end positions
  const offset = client.ps.gunframe === 6 ? vec3(15, 8, -8) : vec3(15, 6, -8);

  const { start, dir } = P_ProjectSource(ent, vec3_add(client.v_angle, kick_angles), offset);
  fire_flechette(ent, start, dir, damage, 1150, kick);
  Weapon_PowerupSound(ent);

  // send muzzle flash
  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte((client.ps.gunframe === 6 ? PlayerMuzzleT.MZ_ETF_RIFLE : PlayerMuzzleT.MZ_ETF_RIFLE_2) | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);

  client.anim_priority = AnimPriorityT.ANIM_ATTACK;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - Math.trunc(frandom() + 0.25);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - Math.trunc(frandom() + 0.25);
    client.anim_end = FRAME_attack8;
  }
  client.anim_time = GTIME_ZERO;
}

const ETF_RIFLE_PAUSE_FRAMES: readonly number[] = [18, 28];

/** p_rogue_weapon.cpp:345-350 `void Weapon_ETF_Rifle(edict_t *ent)`. */
export function Weapon_ETF_Rifle(ent: EdictT): void {
  Weapon_Repeating(ent, 4, 7, 37, 41, ETF_RIFLE_PAUSE_FRAMES, weapon_etf_rifle_fire);
}

// ============================================================================
// HEATBEAM (p_rogue_weapon.cpp:352-446)
// ============================================================================

const HEATBEAM_DM_DMG = 15;
const HEATBEAM_SP_DMG = 15;

/** p_rogue_weapon.cpp:355-439 `void Heatbeam_Fire(edict_t *ent)`. */
function Heatbeam_Fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const firing = (client.buttons & ButtonT.BUTTON_ATTACK) !== 0;
  const weapon = client.pers.weapon;
  const has_ammo = weapon !== null && client.pers.inventory[weapon.ammo] >= weapon.quantity;

  if (!firing || !has_ammo) {
    client.ps.gunframe = 13;
    client.weapon_sound = 0;
    client.ps.gunskin = 0;

    if (firing && !has_ammo) NoAmmoWeaponChange(ent, true);
    return;
  }

  // start on frame 8
  if (client.ps.gunframe > 12) client.ps.gunframe = 8;
  else client.ps.gunframe++;

  if (client.ps.gunframe === 12) client.ps.gunframe = 8;

  // play weapon sound for firing
  client.weapon_sound = gi.soundindex("weapons/bfg__l1a.wav");
  client.ps.gunskin = 1;

  // for comparison, the hyperblaster is 15/20
  // jim requested more damage, so try 15/15 --- PGM 07/23/98
  let damage = deathmatchEnabled() ? HEATBEAM_DM_DMG : HEATBEAM_SP_DMG;

  // really knock 'em around in deathmatch
  let kick = deathmatchEnabled() ? 75 : 30;

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  client.kick.time = GTIME_ZERO;

  // This offset is the "view" offset for the beam start (used by trace)
  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(7, 2, -3));

  // This offset is the entity offset
  G_LagCompensate(ent, start, dir);
  fire_heatbeam(ent, start, dir, vec3(2, 7, -3), damage, kick, false);
  G_UnLagCompensate();
  Weapon_PowerupSound(ent);

  // send muzzle flash
  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_HEATBEAM | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);

  client.anim_priority = AnimPriorityT.ANIM_ATTACK;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - Math.trunc(frandom() + 0.25);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - Math.trunc(frandom() + 0.25);
    client.anim_end = FRAME_attack8;
  }
  client.anim_time = GTIME_ZERO;
}

const HEATBEAM_PAUSE_FRAMES: readonly number[] = [35];

/** p_rogue_weapon.cpp:441-446 `void Weapon_Heatbeam(edict_t *ent)`. */
export function Weapon_Heatbeam(ent: EdictT): void {
  Weapon_Repeating(ent, 8, 12, 42, 47, HEATBEAM_PAUSE_FRAMES, Heatbeam_Fire);
}
