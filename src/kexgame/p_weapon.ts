// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// p_weapon.c -- player weapon think/fire dispatch (2023 Quake II re-release
// / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/p_weapon.cpp (1,925 lines,
// C++17): PlayerNoise, P_ProjectSource (+ handedness), the P_CurrentKick*
// family, P_AddWeaponKick, G_RemoveAmmo, Weapon_AnimationTime, Think_Weapon,
// Weapon_RunThink, ChangeWeapon, NoAmmoWeaponChange, Weapon_AttemptSwitch,
// Use_Weapon, Drop_Weapon, Weapon_PowerupSound, the Weapon_Handle*/
// Weapon_Generic/Weapon_Repeating state-machine plumbing, and every
// Blaster/Shotgun/SuperShotgun/Machinegun/Chaingun/HandGrenade/
// GrenadeLauncher/RocketLauncher/HyperBlaster/Railgun/BFG/Beta-Disintegrator
// Weapon_* entry point. Behavioral code, ported bug-for-bug per PORTING.md.
//
// ============================================================================
// GRAPPLE BOUNDARY -- checked, absent from this file
// ============================================================================
// The brief asked to check for a KEX grapple hook in this file. Read the
// entire 1,925-line source top to bottom: there is no grapple fire/think
// function here (no `CTFWeapon_Grapple*`, no `Weapon_Grapple`). The grapple
// hook (`IT_WEAPON_GRAPPLE`'s weaponthink and its fire/pull/hang state
// machine) lives entirely in ctf/g_ctf.cpp, out of this port line's current
// scope -- confirmed absent, not merely unported.
//
// ============================================================================
// PlayerNoise / P_CurrentKickAngles / P_CurrentKickOrigin -- CANONICAL HOME
// MOVED HERE; p_view.ts's copies deleted and replaced with imports
// ============================================================================
// p_view.ts landed first (concurrent porting) and, per its own header,
// carried real local copies of these three functions plus
// P_CurrentKickFactor, citing this file ("p_weapon.cpp") as their true C++
// home and flagging the eventual move. This unit IS that move:
// PlayerNoise/P_CurrentKickAngles/P_CurrentKickOrigin are now exported for
// real from here; p_view.ts's own copies are deleted, replaced with
// `import { PlayerNoise, P_CurrentKickAngles, P_CurrentKickOrigin } from
// "./p_weapon"`. P_CurrentKickFactor itself is NOT declared in g_local.h
// (only Angles/Origin are -- verified) -- it stays a local, unexported
// helper here exactly as it was in p_view.ts, just moved instead of copied.
//
// BUG FIX caught during the move: p_view.ts's PlayerNoise copy omitted
// `noise.svflags = SVF_NOCLIENT;` on both spawned noise entities (p_view.ts
// lines ~319-333, before this move). The real C++ source
// (p_weapon.cpp:190-206) sets `noise->svflags = SVF_NOCLIENT;` on BOTH the
// `mynoise` and `mynoise2` entities right after spawning them -- confirmed
// by re-reading the shipped source character-for-character before writing
// this file. The canonical copy below restores that assignment. Flagged
// prominently in this unit's report; p_view.ts carried the bug for however
// long it was the sole copy, so any test/behavior that depended on the
// (incorrect) client-visible player_noise entity should be re-checked.
//
// G_CheckInfiniteAmmo (p_weapon.cpp:25-31) is declared in g_local.h right
// alongside these three, but p_hud.ts (not p_view.ts) is ALREADY its real,
// correct, exported home -- verified by grepping every kexgame file for
// both "G_CheckInfiniteAmmo" and "P_CurrentKick": p_view.ts never carried a
// copy of it. No reconciliation diff is needed for it; this file simply
// imports the existing p_hud.ts export for G_RemoveAmmo's own use below.
//
// ============================================================================
// SCOPE DECISION -- Pickup_Weapon / G_WeaponShouldStay / G_CheckAutoSwitch
// NOT ported here, despite living in this C++ file
// ============================================================================
// p_weapon.cpp also defines `bool Pickup_Weapon(edict_t*, edict_t*)` and its
// helper `G_WeaponShouldStay()`, and forward-declares (but does not define)
// `G_CheckAutoSwitch`. Not ported in this unit:
//   - They are not in this unit's brief's explicit function list.
//   - `Pickup_Weapon` is exactly the shape of a `gitem_t::pickup` handler --
//     this port line's own commit history assigns "pickup/use/drop
//     handlers" to g_items.ts's scope (its own landing commit says so
//     verbatim), even though this one specific handler is physically
//     defined in p_weapon.cpp in the shipped source. Porting it here risks
//     a duplicate/conflicting export once g_items.ts's own itemlist lands.
//   - `G_CheckAutoSwitch`'s REAL definition is `g_items.cpp:552`, not this
//     file (verified: grepped the whole rerelease/ tree) -- it is a bare
//     forward declaration here, called by `Pickup_Weapon` only. Since
//     `Pickup_Weapon` isn't ported, nothing in this file needs it.
//   - `G_WeaponShouldStay` is used only by `Pickup_Weapon`; same reasoning.
// Nothing exported from this file calls any of the three, so this is a
// clean scope cut, not a hidden gap. Reported as a decision, not a stub.
//
// ============================================================================
// GetItemByIndex / G_ShouldPlayersCollide -- REASSIGNABLE stubs, not plain
// throws (deviation, cited)
// ============================================================================
// Every other cross-dependency this file used to carry as a throwing stub
// (Add_Ammo, SetRespawn, Drop_Item -> g_items.cpp; P_AssignClientSkinnum ->
// p_client.cpp/p_view.ts) has since landed for real and is now a plain
// import, used directly (Add_Ammo/SetRespawn/P_AssignClientSkinnum) or
// through a thin delegating wrapper of the same name (Drop_Item, see its
// own site below) -- this paragraph is otherwise stale as of the
// 2026-08-30 stale-comment sweep; kept for the still-accurate
// GetItemByIndex/G_ShouldPlayersCollide reassignable-stub explanation below.
//
// GetItemByIndex and G_ShouldPlayersCollide are the two exceptions:
//   - NoAmmoWeaponChange's entire observable behavior IS its
//     priority-ordered GetItemByIndex lookup loop (p_weapon.cpp:394-428) --
//     there is no other branch, guard, or early return to test.
//   - P_ProjectSource calls G_ShouldPlayersCollide UNCONDITIONALLY
//     (p_weapon.cpp:109 has no `ent->client` guard -- P_ProjectSource is
//     only ever called with a player, unlike g_weapon.ts's shared
//     monster/player fire_* functions, which DO guard it behind
//     `self->client &&`). A hard throw here would make EVERY call to
//     P_ProjectSource fail immediately, including the brief's own required
//     "P_ProjectSource handedness offsets" test scenario -- there is no
//     guarded branch to route around, unlike every other stub in this
//     file.
// Both are small reassignable module bindings, mirroring the EXACT
// established pattern g_main_globals.ts already uses for the same class of
// problem (a real dependency not yet wired, swapped in via a setter --
// `SetGameImports`/`SetGameExports`/`SetGEdicts`): production code never
// calls either setter, so shipped behavior is unchanged (both still throw
// by default) until a future unit wires the real g_items.ts/p_client.ts
// implementations in here via `SetGetItemByIndex`/`SetGShouldPlayersCollide`.
// Every other call site that reaches either function (Weapon_AttemptSwitch's
// ammo-name print path; every fire_*_fire function's P_ProjectSource call)
// is unaffected -- same default-throwing behavior like every other stub unless
// a test opts in. Note this does NOT touch g_weapon.ts's OWN, separate,
// non-reassignable `G_ShouldPlayersCollide` copy (out of this unit's file
// list) -- fire_bullet/fire_grenade2/fire_rocket/etc. still throw for a
// real player shooter regardless of this file's setter; see this unit's
// own test file header ("KNOWN LIMITATION") and report.
//
// ============================================================================
// QUIRKS PRESERVED BUG-FOR-BUG (read twice against the shipped source, not
// "fixed")
// ============================================================================
// - `Throw_Generic`'s `FRAME_THROW_FIRE` parameter is accepted but NEVER
//   READ anywhere in the function body (verified: grepped the whole
//   function for the identifier a second time before writing this port) --
//   a genuine dead parameter in the shipped source, kept in this port's
//   signature for fidelity even though nothing uses it.
// - `weapon_disint_fire` (Beta Disintegrator) is the only fire function in
//   this file that neither applies `is_quad`/`damage_multiplier` to its
//   damage NOR calls `Weapon_PowerupSound` -- both omissions are exactly as
//   shipped (re-verified against the source a second time): the Beta
//   Disintegrator's 800 damage is quad-immune and silent-on-powerup by
//   design (or by bug -- either way, preserved, not "fixed").
// - `Weapon_Beta_Disintegrator`'s muzzle flash write is
//   `gi.WriteByte(MZ_BLASTER2)` with NO `| is_silenced` OR'd in, unlike
//   every other muzzle flash write in this file -- preserved verbatim.
// - `Weapon_HandleReady`'s pause-frame roll (`if (irandom(16)) return
//   READY_CHANGING;`) skips advancing `gunframe` on a ~15/16 chance when
//   parked on a pause frame -- the random idle "fidget" pause. Ported with
//   the same `irandom(16)` truthiness check (0 is the only falsy roll,
//   1-in-16 odds of falling through to advance).
//
// ============================================================================
// STUB INVENTORY -- HISTORICAL (all of these have since landed for real;
// kept for the reachability citations, updated 2026-08-30 stale-comment
// sweep -- see each real call site for current status)
// ============================================================================
//   - GetItemByIndex (g_items.cpp:52) -- reassignable (see "GetItemByIndex"
//     section above), but now DEFAULTS to the real itemlist lookup
//     (`RealGetItemByIndex`, imported from g_items.ts) instead of a throw;
//     `SetGetItemByIndex` remains as a test seam.
//   - Add_Ammo (g_items.cpp:543) -- only reachable from the NOT-ported
//     Pickup_Weapon; dead code in THIS file (kept only because it's
//     textually declared in g_local.h and nothing here calls it -- actually
//     not referenced at all in this port; omitted entirely, no stub needed).
//   - SetRespawn (g_items.cpp:181) -- same: only reachable from
//     Pickup_Weapon, not ported here; omitted, no stub needed.
//   - Drop_Item (g_items.cpp:1042) -- reached by Drop_Weapon's real
//     "already using it, only copy" guard passing (i.e. dropping actually
//     proceeds). Now a real delegating import from g_items.ts (see its own
//     site below).
//   - G_ShouldPlayersCollide (p_client.cpp:2996) -- reassignable (see this
//     file's own "GetItemByIndex / G_ShouldPlayersCollide" header section
//     above), but now DEFAULTS to the real p_client.ts implementation
//     (`RealG_ShouldPlayersCollide`) instead of a throw; reached
//     unconditionally by every P_ProjectSource call, so this matters for
//     every real weapon fire, not just a test-seam nicety.
//   - P_AssignClientSkinnum (p_client.cpp:1741) -- now a real import from
//     p_view.ts (its genuine C++ home), not a local copy. Reached only by
//     ChangeWeapon's `if (ent.s.modelindex === MODELINDEX_PLAYER)` guard.
//
// ============================================================================
// STUB SWAP (xatrix unit): Throw_Generic / is_quad / damage_multiplier /
// is_silenced / is_quadfire / requirePlayerClient now exported
// ============================================================================
// `Throw_Generic` was real, already-ported, already the shared throwable-
// weapon state machine behind `Weapon_Grenade` -- just not `export`ed, since
// only this file needed it before. p_xatrix_weapon.ts's own `Weapon_Trap`
// (xatrix/p_xatrix_weapon.cpp:160-165) calls it exactly the way
// `Weapon_Grenade` does here (`Throw_Generic(ent, 15, 48, 5,
// "weapons/trapcock.wav", 11, 12, pause_frames, false, "weapons/traploop.wav",
// weapon_trap_fire, false)`), so this unit adds `export` to the one
// declaration -- no behavior change here.
//
// `is_quad`/`damage_multiplier`/`is_silenced` are mutable module-level
// state, refreshed once per weapon-think tick by `Weapon_RunThink`
// (p_weapon.cpp:291-306, this file's sole caller of any `weaponthink`,
// including p_xatrix_weapon.ts's own `Weapon_Ionripper`/`Weapon_Phalanx`/
// `Weapon_Trap`) BEFORE `weapon.weaponthink(ent)` runs -- so p_xatrix_weapon.ts
// reading these via a live ES module import sees the exact same
// already-refreshed values the vanilla weapon-fire functions in THIS file
// read, with no extra plumbing needed on either side. Exported as `export
// let` (not wrapped in a getter) specifically so cross-module reads stay
// live bindings, matching ECMAScript module semantics for mutable exports.
// `requirePlayerClient` is exported unchanged (same "unconditional
// dereference invariant" helper this file already used internally),
// reused by p_xatrix_weapon.ts's own three fire functions instead of being
// duplicated a second time.

import { type Vec3, vec3, VectorCopy } from "../shared/math";
import {
  ATTN_IDLE,
  ATTN_NORM,
  ButtonT,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  KexMulticastT,
  MASK_PROJECTILE,
  MODELINDEX_PLAYER,
  PlayerMuzzleT,
  PmflagsT,
  PrintTypeT,
  ServerCommandT,
  SoundchanT,
  SvflagsT,
} from "../kexapi/game";
import {
  type EdictT,
  type GClientT,
  type GitemT,
  AnimPriorityT,
  COOP_DAMAGE_FIRING_TIME,
  DAMAGE_TIME,
  DEFAULT_BULLET_HSPREAD,
  DEFAULT_BULLET_VSPREAD,
  DEFAULT_DEATHMATCH_SHOTGUN_COUNT,
  DEFAULT_SHOTGUN_COUNT,
  DEFAULT_SHOTGUN_HSPREAD,
  DEFAULT_SHOTGUN_VSPREAD,
  DEFAULT_SSHOTGUN_COUNT,
  EntFlagsT,
  GRENADE_MAXSPEED,
  GRENADE_MINSPEED,
  GRENADE_TIMER,
  HandednessT,
  INVISIBILITY_TIME,
  ItemFlagsT,
  ItemIdT,
  type ModT,
  ModIdT,
  PlayerNoiseT,
  SPAWNFLAG_ITEM_DROPPED,
  SPAWNFLAG_ITEM_DROPPED_PLAYER,
  WeaponstateT,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { type GTime, GTIME_ZERO, Gtime_add, Gtime_divide, Gtime_from_ms, Gtime_milliseconds, Gtime_nonzero, Gtime_scale, Gtime_seconds, Gtime_subtract, Gtime_from_sec } from "./gtime";
import { AngleVectors, G_ProjectSource2, vec3_add, vec3_muls, vec3_normalized, vec3_origin, vec3_sub } from "./q_vec3";
import { PITCH, ROLL, YAW, crandom, crandom_open, frandom, irandom, Q_PIf } from "./q_std";
import {
  FRAME_attack1,
  FRAME_attack8,
  FRAME_crattak1,
  FRAME_crattak3,
  FRAME_crattak9,
  FRAME_crpain1,
  FRAME_crpain4,
  FRAME_pain301,
  FRAME_pain304,
  FRAME_wave01,
  FRAME_wave08,
} from "./m_player";
import { G_CheckInfiniteAmmo } from "./p_hud";
import { G_LagCompensate, G_UnLagCompensate } from "./p_view";
import { CTFApplyHaste, CTFApplyHasteSound, CTFApplyStrengthSound } from "./ctf/g_ctf";
import { G_Spawn } from "./g_utils";
import { SpawnFlags_or, SpawnFlags_has } from "./spawnflags";
import { fire_bfg, fire_blaster, fire_bullet, fire_disintegrator, fire_grenade, fire_grenade2, fire_rail, fire_rocket, fire_shotgun } from "./g_weapon";
import { G_ShouldPlayersCollide as RealG_ShouldPlayersCollide, P_UseCoopInstancedItems } from "./p_client";
import { GetItemByIndex as RealGetItemByIndex, Add_Ammo, SetRespawn, G_CheckAutoSwitch, Drop_Item as RealDrop_Item } from "./g_items";

// ---------------------------------------------------------------------------
// small per-file helpers (see this port line's established convention for
// tiny header-only wrappers -- duplicated on purpose, see file header)
// ---------------------------------------------------------------------------

function cvarFloat(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Number(def) : c.value;
}

function cvarInt(name: string, def: string): number {
  const c = gi.cvar(name, def, CvarFlagsT.CVAR_NOFLAGS);
  return c ? Math.trunc(c.value) : 0;
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return Math.trunc(cvarFloat(name, def, flags)) !== 0;
}

function giTraceline(start: Vec3, end: Vec3, passent: EdictT | null, mask: ContentsT) {
  return gi.trace(start, null, null, end, passent, mask);
}

/** `mod_t`'s implicit single-argument constructor (g_local.h:1081-1093). */
function modFromId(id: ModIdT): ModT {
  return { id, friendly_fire: false, no_point_loss: false };
}

const MOD_BLASTER = modFromId(ModIdT.MOD_BLASTER);
const MOD_HYPERBLASTER = modFromId(ModIdT.MOD_HYPERBLASTER);
const MOD_MACHINEGUN = modFromId(ModIdT.MOD_MACHINEGUN);
const MOD_CHAINGUN = modFromId(ModIdT.MOD_CHAINGUN);
const MOD_SHOTGUN = modFromId(ModIdT.MOD_SHOTGUN);
const MOD_SSHOTGUN = modFromId(ModIdT.MOD_SSHOTGUN);

// ---------------------------------------------------------------------------
// unconditional-dereference invariants -- see g_weapon.ts's own
// requireEnemy/requireOwner precedent for this exact idiom
// ---------------------------------------------------------------------------

export function requirePlayerClient(ent: EdictT): GClientT {
  if (ent.client === null) throw new Error("p_weapon.ts: ent.client is null -- unconditional C++ dereference (invariant violated)");
  return ent.client;
}

function requireWeapon(client: GClientT): GitemT {
  if (client.pers.weapon === null) throw new Error("p_weapon.ts: client.pers.weapon is null -- unconditional C++ dereference (invariant violated)");
  return client.pers.weapon;
}

// ---------------------------------------------------------------------------
// unported cross-deps (throwing stubs) -- see file header's "STUB INVENTORY"
// ---------------------------------------------------------------------------

// Drop_Item: formerly a local throwing stub here, reached by Drop_Weapon's
// real "already using it, only copy" guard passing (see file header) --
// src/kexgame/g_items.ts has since landed with a real, exported
// `Drop_Item`; swapped for a delegating import (2026-08-30 stale-comment
// sweep). Real import aliased above, alongside this file's other g_items.ts
// imports.
function Drop_Item(ent: EdictT, item: GitemT): EdictT {
  return RealDrop_Item(ent, item);
}

/**
 * Same stub g_utils.ts/g_weapon.ts/p_view.ts already carry under this exact
 * name -- see this file's header. UNLIKE those (and unlike this file's own
 * plain throwing stubs), this copy is reassignable, for the identical
 * reason `GetItemByIndex` above is: P_ProjectSource calls it
 * UNCONDITIONALLY (p_weapon.cpp has no `self->client` guard here --
 * P_ProjectSource is only ever called with a player, unlike g_weapon.ts's
 * shared monster/player fire_* functions), so a hard throw would make the
 * brief's own required "P_ProjectSource handedness offsets" test scenario
 * impossible to exercise at all -- there is no guarded branch to route
 * around. Production code never calls the setter, so shipped behavior is
 * unchanged (still throws) until a future p_client.ts landing wires the
 * real implementation in here.
 */
// p_client.ts landed: the default is now the real implementation. The
// setter remains as the test seam.
let gShouldPlayersCollideImpl: (weaponry: boolean) => boolean = RealG_ShouldPlayersCollide;

/** See the doc comment above for why this one (unlike this file's other
 *  stubs) is reassignable. Pass `null` to restore the default throwing
 *  stub. */
export function SetGShouldPlayersCollide(fn: ((weaponry: boolean) => boolean) | null): void {
  gShouldPlayersCollideImpl = fn ?? RealG_ShouldPlayersCollide;
}

function G_ShouldPlayersCollide(weaponry: boolean): boolean {
  return gShouldPlayersCollideImpl(weaponry);
}

import { P_AssignClientSkinnum } from "./p_view";

/** See file header's "GetItemByIndex" section for why this one is
 *  reassignable instead of a plain throw. */
// g_items.ts landed: the default is now the real itemlist lookup. The
// setter remains as the test seam.
let getItemByIndexImpl: (index: ItemIdT) => GitemT | null = RealGetItemByIndex;

/** Lets a future g_items.ts wiring step (or a test) supply the real
 *  itemlist lookup. Pass `null` to restore the default throwing stub. */
export function SetGetItemByIndex(fn: ((index: ItemIdT) => GitemT | null) | null): void {
  getItemByIndexImpl = fn ?? RealGetItemByIndex;
}

function GetItemByIndex(index: ItemIdT): GitemT | null {
  return getItemByIndexImpl(index);
}

// ---------------------------------------------------------------------------
// module-scope statics (C file-scope globals -- g_local.h declares them
// `extern`, this file is their sole owner; no other kexgame file references
// them, verified by grep before writing this file)
// ---------------------------------------------------------------------------

export let is_quad = false;
// RAFAEL
export let is_quadfire = false;
// RAFAEL
export let is_silenced: PlayerMuzzleT = PlayerMuzzleT.MZ_NONE;

// PGM
export let damage_multiplier = 1;
// PGM

// ---------------------------------------------------------------------------
// G_CheckInfiniteAmmo -- re-exported from its real home (p_hud.ts); see file
// header's "G_CheckInfiniteAmmo" note
// ---------------------------------------------------------------------------

export { G_CheckInfiniteAmmo };

// ---------------------------------------------------------------------------
// P_DamageModifier -- ROGUE
// ---------------------------------------------------------------------------

/** p_weapon.cpp:35-57: `byte P_DamageModifier(edict_t *ent)`. Exported (not
 *  just a local helper for this file's own weapon-fire dispatch) because
 *  rogue/g_rogue_newweap.ts's `fire_nuke` calls it directly, exactly like
 *  the C++ source does (`int damage_modifier = P_DamageModifier(self);`) --
 *  see that file's header for the citation. */
export function P_DamageModifier(ent: EdictT): number {
  const client = requirePlayerClient(ent);
  is_quad = false;
  damage_multiplier = 1;

  if (client.quad_time > level.time) {
    damage_multiplier *= 4;
    is_quad = true;

    // if we're quad and DF_NO_STACK_DOUBLE is on, return now.
    if (cvarBool("g_dm_no_stack_double", "0", CvarFlagsT.CVAR_NOFLAGS)) return damage_multiplier;
  }

  if (client.double_time > level.time) {
    damage_multiplier *= 2;
    is_quad = true;
  }

  return damage_multiplier;
}

// ---------------------------------------------------------------------------
// CTFApplyStrengthSound / CTFApplyHaste / CTFApplyHasteSound -- REAL imports
// from ctf/g_ctf.ts (this file's own former real, local copies moved there
// as part of that unit's consolidation; see ctf/g_ctf.ts's own header).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// G_CheckPowerArmor -- local copy of g_combat.ts's unexported original (see
// that file's identical implementation, g_items.cpp:306); duplicated
// because g_combat.ts does not export it and is not in this unit's file
// list, per this port line's "duplicate the tiny unexported helper"
// convention
// ---------------------------------------------------------------------------

const AUTO_SHIELD_MANUAL = -1;
const AUTO_SHIELD_AUTO = 0;

/** g_items.cpp:306: `void G_CheckPowerArmor(edict_t *ent)`. */
function G_CheckPowerArmor(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let has_enough_cells: boolean;
  if (client.pers.inventory[ItemIdT.IT_AMMO_CELLS] === 0) {
    has_enough_cells = false;
  } else if (client.pers.autoshield >= AUTO_SHIELD_AUTO) {
    has_enough_cells = (ent.flags & EntFlagsT.FL_WANTS_POWER_ARMOR) !== 0n && client.pers.inventory[ItemIdT.IT_AMMO_CELLS] > client.pers.autoshield;
  } else {
    has_enough_cells = true;
  }

  if ((ent.flags & EntFlagsT.FL_POWER_ARMOR) !== 0n) {
    if (!has_enough_cells) {
      ent.flags &= ~EntFlagsT.FL_POWER_ARMOR;
      gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
    }
  } else if (
    client.pers.autoshield !== AUTO_SHIELD_MANUAL &&
    has_enough_cells &&
    (client.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] !== 0 || client.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] !== 0)
  ) {
    ent.flags |= EntFlagsT.FL_POWER_ARMOR;
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
  }
}

// ---------------------------------------------------------------------------
// P_CurrentKickFactor / P_CurrentKickAngles / P_CurrentKickOrigin -- moved
// here from p_view.ts (canonical home); see file header
// ---------------------------------------------------------------------------

/** p_weapon.cpp:62-68: `float P_CurrentKickFactor(edict_t *ent)`. Not
 *  declared in g_local.h -- stays a local, unexported helper (matches its
 *  linkage in the C++ source). */
function P_CurrentKickFactor(ent: EdictT): number {
  const client = ent.client;
  if (client === null) return 0;
  if (client.kick.time < level.time) return 0;
  return Gtime_seconds(Gtime_subtract(client.kick.time, level.time)) / Gtime_seconds(client.kick.total);
}

/** p_weapon.cpp:71-74: `vec3_t P_CurrentKickAngles(edict_t *ent)`. */
export function P_CurrentKickAngles(ent: EdictT): Vec3 {
  const client = ent.client;
  if (client === null) return vec3();
  return vec3_muls(client.kick.angles, P_CurrentKickFactor(ent));
}

/** p_weapon.cpp:76-79: `vec3_t P_CurrentKickOrigin(edict_t *ent)`. */
export function P_CurrentKickOrigin(ent: EdictT): Vec3 {
  const client = ent.client;
  if (client === null) return vec3();
  return vec3_muls(client.kick.origin, P_CurrentKickFactor(ent));
}

/** p_weapon.cpp:83-89: `void P_AddWeaponKick(edict_t *ent, const vec3_t
 *  &origin, const vec3_t &angles)`. */
export function P_AddWeaponKick(ent: EdictT, origin: Vec3, angles: Vec3): void {
  const client = requirePlayerClient(ent);
  client.kick.origin = vec3(origin[0], origin[1], origin[2]);
  client.kick.angles = vec3(angles[0], angles[1], angles[2]);
  client.kick.total = Gtime_from_ms(200);
  client.kick.time = Gtime_add(level.time, client.kick.total);
}

// ---------------------------------------------------------------------------
// P_ProjectSource -- moved here from... nowhere; this is its real home
// ---------------------------------------------------------------------------

/**
 * p_weapon.cpp:91-135: `void P_ProjectSource(edict_t *ent, const vec3_t
 * &angles, vec3_t distance, vec3_t &result_start, vec3_t &result_dir)`. The
 * `#if 0` "correction for blocked shots" tail (lines 123-133) is dead code
 * in the shipped source itself and is dropped, per PORTING.md's `#if 0`
 * rule.
 */
export function P_ProjectSource(ent: EdictT, angles: Vec3, distanceIn: Vec3): { start: Vec3; dir: Vec3 } {
  const client = requirePlayerClient(ent);

  // C passes `distance` BY VALUE (mutated locally, caller's copy untouched)
  const distance = vec3(distanceIn[0], distanceIn[1], distanceIn[2]);
  if (client.pers.hand === HandednessT.LEFT_HANDED) distance[1] *= -1;
  else if (client.pers.hand === HandednessT.CENTER_HANDED) distance[1] = 0;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  const eye_position: Vec3 = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2] + ent.viewheight);

  AngleVectors(angles, forward, right, up);

  const result_start = G_ProjectSource2(eye_position, distance, forward, right, up);

  const end = vec3_add(eye_position, vec3_muls(forward, 8192));
  let mask: ContentsT = MASK_PROJECTILE & ~ContentsT.CONTENTS_DEADMONSTER;

  // [Paril-KEX]
  if (!G_ShouldPlayersCollide(true)) mask &= ~ContentsT.CONTENTS_PLAYER;

  const tr = giTraceline(eye_position, end, ent, mask);

  let result_dir: Vec3;
  // if the point was a monster & close to us, use raw forward
  // so railgun pierces properly
  if (tr.startsolid || ((tr.contents & (ContentsT.CONTENTS_MONSTER | ContentsT.CONTENTS_PLAYER)) !== 0 && tr.fraction * 8192 < 128)) {
    result_dir = vec3(forward[0], forward[1], forward[2]);
  } else {
    result_dir = vec3_normalized(vec3_sub(tr.endpos, result_start));
  }

  return { start: result_start, dir: result_dir };
}

// ---------------------------------------------------------------------------
// PlayerNoise -- moved here from p_view.ts (canonical home); see file
// header for the SVF_NOCLIENT bug fix
// ---------------------------------------------------------------------------

/** p_weapon.cpp:149-227: `void PlayerNoise(edict_t *who, const vec3_t
 *  &where, player_noise_t type)`. */
export function PlayerNoise(who: EdictT, where: Vec3, type: PlayerNoiseT): void {
  const client = who.client;
  if (client === null) return;

  if (type === PlayerNoiseT.PNOISE_WEAPON) {
    client.invisibility_fade_time = Gtime_add(level.time, client.silencer_shots ? Gtime_divide(INVISIBILITY_TIME, 5) : INVISIBILITY_TIME);

    if (client.silencer_shots) {
      client.silencer_shots--;
      return;
    }
  }

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) return;

  if ((who.flags & EntFlagsT.FL_NOTARGET) !== 0n) return;

  if (type === PlayerNoiseT.PNOISE_SELF && (client.landmark_free_fall || client.landmark_noise_time >= level.time)) return;

  // ROGUE
  if ((who.flags & EntFlagsT.FL_DISGUISED) !== 0n) {
    if (type === PlayerNoiseT.PNOISE_WEAPON) {
      level.disguise_violator = who;
      level.disguise_violation_time = Gtime_add(level.time, Gtime_from_ms(500));
    } else return;
  }
  // ROGUE

  if (who.mynoise === null) {
    const n1 = G_Spawn();
    n1.classname = "player_noise";
    n1.mins = vec3(-8, -8, -8);
    n1.maxs = vec3(8, 8, 8);
    n1.owner = who;
    n1.svflags |= SvflagsT.SVF_NOCLIENT;
    who.mynoise = n1;

    const n2 = G_Spawn();
    n2.classname = "player_noise";
    n2.mins = vec3(-8, -8, -8);
    n2.maxs = vec3(8, 8, 8);
    n2.owner = who;
    n2.svflags |= SvflagsT.SVF_NOCLIENT;
    who.mynoise2 = n2;
  }

  let noise: EdictT;

  if (type === PlayerNoiseT.PNOISE_SELF || type === PlayerNoiseT.PNOISE_WEAPON) {
    if (who.mynoise === null) throw new Error("PlayerNoise: mynoise unset after initialization -- unreachable");
    noise = who.mynoise;
    client.sound_entity = noise;
    client.sound_entity_time = level.time;
  } else {
    // type === PNOISE_IMPACT
    if (who.mynoise2 === null) throw new Error("PlayerNoise: mynoise2 unset after initialization -- unreachable");
    noise = who.mynoise2;
    client.sound2_entity = noise;
    client.sound2_entity_time = level.time;
  }

  VectorCopy(where, noise.s.origin);
  noise.absmin = vec3_sub(where, noise.maxs);
  noise.absmax = vec3_add(where, noise.maxs);
  noise.teleport_time = level.time;
  gi.linkentity(noise);
}

// ---------------------------------------------------------------------------
// G_WeaponShouldStay / Pickup_Weapon (p_weapon.cpp:229-289) -- restored by the
// phase-6 coverage audit: the original port deferred these to g_items.ts while
// g_items.ts deferred back here (circular deferral; Pickup_Weapon was a LIVE
// throwing stub wired into every weapon itemlist entry).
// ---------------------------------------------------------------------------

export function G_WeaponShouldStay(): boolean {
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) return cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS);
  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) return !P_UseCoopInstancedItems();
  return false;
}

export function Pickup_Weapon(ent: EdictT, other: EdictT): boolean {
  const client = requirePlayerClient(other);
  const item = ent.item;
  if (!item) throw new Error("Pickup_Weapon: ent has no item (C++ would crash)");
  const index = item.id;

  if (G_WeaponShouldStay() && client.pers.inventory[index]) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER))
      return false; // leave the weapon for others to pickup
  }

  const is_new = !client.pers.inventory[index];
  client.pers.inventory[index]++;

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
    // give them some ammo with it -- PGM: IF APPROPRIATE!
    if (item.ammo) {
      const ammo = RealGetItemByIndex(item.ammo);
      if (ammo) {
        // RAFAEL: don't get infinite ammo with trap
        if (G_CheckInfiniteAmmo(ammo)) Add_Ammo(other, ammo, 1000);
        else Add_Ammo(other, ammo, ammo.quantity);
      }
    }

    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER)) {
      if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
        if (cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS)) ent.flags |= EntFlagsT.FL_RESPAWN;
        SetRespawn(ent, Gtime_from_sec(cvarInt("g_weapon_respawn_time", "30")), !cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS));
      }
      if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) ent.flags |= EntFlagsT.FL_RESPAWN;
    }
  }

  G_CheckAutoSwitch(other, item, is_new);
  return true;
}

// ---------------------------------------------------------------------------
// Weapon_RunThink
// ---------------------------------------------------------------------------

/** p_weapon.cpp:291-306: `static void Weapon_RunThink(edict_t *ent)`. */
function Weapon_RunThink(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const weapon = requireWeapon(client);

  // call active weapon think routine
  if (weapon.weaponthink === null) return;

  P_DamageModifier(ent);
  // RAFAEL
  is_quadfire = client.quadfire_time > level.time;
  // RAFAEL
  if (client.silencer_shots) is_silenced = PlayerMuzzleT.MZ_SILENCED;
  else is_silenced = PlayerMuzzleT.MZ_NONE;
  weapon.weaponthink(ent);
}

// ---------------------------------------------------------------------------
// ChangeWeapon
// ---------------------------------------------------------------------------

/** p_weapon.cpp:316-376: `void ChangeWeapon(edict_t *ent)`. */
export function ChangeWeapon(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  // [Paril-KEX]
  if (
    ent.health > 0 &&
    !cvarBool("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH) &&
    ((client.latched_buttons | client.buttons) & ButtonT.BUTTON_HOLSTER) !== 0
  ) {
    return;
  }

  if (client.grenade_time) {
    // force a weapon think to drop the held grenade
    client.weapon_sound = 0;
    Weapon_RunThink(ent);
    client.grenade_time = GTIME_ZERO;
  }

  if (client.pers.weapon !== null) {
    client.pers.lastweapon = client.pers.weapon;

    if (client.newweapon !== null && client.newweapon !== client.pers.weapon) {
      gi.sound(ent, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/change.wav"), 1, ATTN_NORM, 0);
    }
  }

  client.pers.weapon = client.newweapon;
  client.newweapon = null;
  client.machinegun_shots = 0;

  // set visible model
  if (ent.s.modelindex === MODELINDEX_PLAYER) P_AssignClientSkinnum(ent);

  if (client.pers.weapon === null) {
    // dead
    client.ps.gunindex = 0;
    client.ps.gunskin = 0;
    return;
  }

  client.weaponstate = WeaponstateT.WEAPON_ACTIVATING;
  client.ps.gunframe = 0;
  if (client.pers.weapon.view_model === null) {
    throw new Error("ChangeWeapon: pers.weapon.view_model is null -- unconditional C++ dereference (invariant violated)");
  }
  client.ps.gunindex = gi.modelindex(client.pers.weapon.view_model);
  client.ps.gunskin = 0;
  client.weapon_sound = 0;

  client.anim_priority = AnimPriorityT.ANIM_PAIN;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crpain1;
    client.anim_end = FRAME_crpain4;
  } else {
    ent.s.frame = FRAME_pain301;
    client.anim_end = FRAME_pain304;
  }
  client.anim_time = GTIME_ZERO;

  // for instantweap, run think immediately
  // to set up correct start frame
  if (cvarBool("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH)) Weapon_RunThink(ent);
}

// ---------------------------------------------------------------------------
// NoAmmoWeaponChange
// ---------------------------------------------------------------------------

const NO_AMMO_ORDER: readonly ItemIdT[] = [
  ItemIdT.IT_WEAPON_DISRUPTOR,
  ItemIdT.IT_WEAPON_RAILGUN,
  ItemIdT.IT_WEAPON_PLASMABEAM,
  ItemIdT.IT_WEAPON_IONRIPPER,
  ItemIdT.IT_WEAPON_HYPERBLASTER,
  ItemIdT.IT_WEAPON_ETF_RIFLE,
  ItemIdT.IT_WEAPON_CHAINGUN,
  ItemIdT.IT_WEAPON_MACHINEGUN,
  ItemIdT.IT_WEAPON_SSHOTGUN,
  ItemIdT.IT_WEAPON_SHOTGUN,
  ItemIdT.IT_WEAPON_PHALANX,
  ItemIdT.IT_WEAPON_RLAUNCHER,
  ItemIdT.IT_WEAPON_GLAUNCHER,
  ItemIdT.IT_WEAPON_PROXLAUNCHER,
  ItemIdT.IT_WEAPON_CHAINFIST,
  ItemIdT.IT_WEAPON_BLASTER,
];

/** p_weapon.cpp:383-429: `void NoAmmoWeaponChange(edict_t *ent, bool
 *  sound)`. */
export function NoAmmoWeaponChange(ent: EdictT, sound: boolean): void {
  const client = requirePlayerClient(ent);

  if (sound) {
    if (level.time >= client.empty_click_sound) {
      gi.sound(ent, SoundchanT.CHAN_WEAPON, gi.soundindex("weapons/noammo.wav"), 1, ATTN_NORM, 0);
      client.empty_click_sound = Gtime_add(level.time, Gtime_from_ms(1000));
    }
  }

  for (const id of NO_AMMO_ORDER) {
    const item = GetItemByIndex(id);
    if (item === null) {
      gi.Com_Error(`Invalid no ammo weapon switch weapon ${id}`);
    }

    if (!client.pers.inventory[item.id]) continue;

    if (item.ammo !== ItemIdT.IT_NULL && client.pers.inventory[item.ammo] < item.quantity) continue;

    client.newweapon = item;
    return;
  }
}

// ---------------------------------------------------------------------------
// G_RemoveAmmo
// ---------------------------------------------------------------------------

/** p_weapon.cpp:431-454: both `G_RemoveAmmo` overloads. `quantity`
 *  defaults to the current weapon's `quantity` field, matching the
 *  zero-arg C++ overload's `G_RemoveAmmo(ent, ent->client->pers.weapon->quantity)`
 *  forwarding call. */
export function G_RemoveAmmo(ent: EdictT, quantity?: number): void {
  const client = requirePlayerClient(ent);
  const weapon = requireWeapon(client);
  const qty = quantity ?? weapon.quantity;

  if (G_CheckInfiniteAmmo(weapon)) return;

  const pre_warning = client.pers.inventory[weapon.ammo] <= weapon.quantity_warn;
  client.pers.inventory[weapon.ammo] -= qty;
  const post_warning = client.pers.inventory[weapon.ammo] <= weapon.quantity_warn;

  if (!pre_warning && post_warning) {
    gi.local_sound(ent, null, ent, SoundchanT.CHAN_AUTO, gi.soundindex("weapons/lowammo.wav"), 1, ATTN_NORM, 0, 0);
  }

  if (weapon.ammo === ItemIdT.IT_AMMO_CELLS) G_CheckPowerArmor(ent);
}

// ---------------------------------------------------------------------------
// Weapon_AnimationTime
// ---------------------------------------------------------------------------

/** p_weapon.cpp:457-481: `inline gtime_t Weapon_AnimationTime(edict_t
 *  *ent)`. */
function Weapon_AnimationTime(ent: EdictT): GTime {
  const client = requirePlayerClient(ent);
  const weapon = requireWeapon(client);

  if (
    cvarBool("g_quick_weapon_switch", "1", CvarFlagsT.CVAR_LATCH) &&
    gi.tick_rate >= 20 &&
    (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING || client.weaponstate === WeaponstateT.WEAPON_DROPPING)
  ) {
    client.ps.gunrate = 20;
  } else {
    client.ps.gunrate = 10;
  }

  if (client.ps.gunframe !== 0 && (!(weapon.flags & ItemFlagsT.IF_NO_HASTE) || client.weaponstate !== WeaponstateT.WEAPON_FIRING)) {
    if (is_quadfire) client.ps.gunrate *= 2;
    if (CTFApplyHaste(ent)) client.ps.gunrate *= 2;
  }

  // network optimization...
  if (client.ps.gunrate === 10) {
    client.ps.gunrate = 0;
    return Gtime_from_ms(100);
  }

  return Gtime_from_ms((1 / client.ps.gunrate) * 1000);
}

// ---------------------------------------------------------------------------
// Think_Weapon
// ---------------------------------------------------------------------------

/** p_weapon.cpp:490-534: `void Think_Weapon(edict_t *ent)`. Called by
 *  ClientBeginServerFrame and ClientThink.
 *
 *  DEVIATION: the C++ source's high-tickrate "catch up on haste remainder"
 *  tail (`if (33_ms < FRAME_TIME_MS) {...}`) compares a compile-time
 *  constant (`33_ms`) against `FRAME_TIME_MS`, a runtime global this port
 *  line has not landed yet (g_local.ts's own header flags this exact gap;
 *  see g_phys.ts's/g_weapon.ts's "FRAME_TIME_S" precedent). Recomputed on
 *  demand from `gi.frame_time_ms` per that precedent -- at the default
 *  10Hz-equivalent 100ms frame time this comparison is always false (33 <
 *  100 is true, so the tail is NOT skipped at 10Hz -- re-read the C++
 *  condition again: `if (33_ms < FRAME_TIME_MS)` runs the catch-up tail
 *  only when the server frame is SLOWER than ~30Hz, i.e. at low tickrates
 *  where haste can outrun a single server frame). Ported as written. */
export function Think_Weapon(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  if (client.resp.spectator) return;

  // if just died, put the weapon away
  if (ent.health < 1) {
    client.newweapon = null;
    ChangeWeapon(ent);
  }

  if (client.pers.weapon === null) {
    if (client.newweapon !== null) ChangeWeapon(ent);
    return;
  }

  // call active weapon think routine
  Weapon_RunThink(ent);

  // check remainder from haste; on 100ms/50ms server frames we may have
  // 'run next frame in' times that we can't possibly catch up to,
  // so we have to run them now.
  const frameTimeMs = Gtime_from_ms(gi.frame_time_ms);
  if (Gtime_from_ms(33) < frameTimeMs) {
    const relative_time = Weapon_AnimationTime(ent);

    if (relative_time < frameTimeMs) {
      // check how many we can't run before the next server tick
      const next_frame = Gtime_add(level.time, frameTimeMs);
      let remaining_ms = Gtime_milliseconds(Gtime_subtract(next_frame, client.weapon_think_time));

      while (remaining_ms > 0) {
        client.weapon_think_time = Gtime_subtract(client.weapon_think_time, relative_time);
        client.weapon_fire_finished = Gtime_subtract(client.weapon_fire_finished, relative_time);
        Weapon_RunThink(ent);
        remaining_ms -= Gtime_milliseconds(relative_time);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Weapon_AttemptSwitch / Use_Weapon
// ---------------------------------------------------------------------------

enum WeapSwitchT {
  WEAP_SWITCH_ALREADY_USING,
  WEAP_SWITCH_NO_WEAPON,
  WEAP_SWITCH_NO_AMMO,
  WEAP_SWITCH_NOT_ENOUGH_AMMO,
  WEAP_SWITCH_VALID,
}

/** p_weapon.cpp:545-571: `weap_switch_t Weapon_AttemptSwitch(edict_t *ent,
 *  gitem_t *item, bool silent)`. */
function Weapon_AttemptSwitch(ent: EdictT, item: GitemT, silent: boolean): WeapSwitchT {
  const client = requirePlayerClient(ent);

  if (client.pers.weapon === item) return WeapSwitchT.WEAP_SWITCH_ALREADY_USING;
  else if (!client.pers.inventory[item.id]) return WeapSwitchT.WEAP_SWITCH_NO_WEAPON;

  if (item.ammo !== ItemIdT.IT_NULL && !cvarBool("g_select_empty", "0", CvarFlagsT.CVAR_ARCHIVE) && (item.flags & ItemFlagsT.IF_AMMO) === 0) {
    const ammo_item = GetItemByIndex(item.ammo);
    if (ammo_item === null) gi.Com_Error(`Invalid ammo item for weapon switch: ${item.ammo}`);

    if (!client.pers.inventory[item.ammo]) {
      if (!silent) gi.Loc_Print(ent, PrintTypeT.PRINT_HIGH, "$g_no_ammo", [ammo_item.pickup_name ?? "", item.pickup_name_definite ?? ""], 2);
      return WeapSwitchT.WEAP_SWITCH_NO_AMMO;
    } else if (client.pers.inventory[item.ammo] < item.quantity) {
      if (!silent) gi.Loc_Print(ent, PrintTypeT.PRINT_HIGH, "$g_not_enough_ammo", [ammo_item.pickup_name ?? "", item.pickup_name_definite ?? ""], 2);
      return WeapSwitchT.WEAP_SWITCH_NOT_ENOUGH_AMMO;
    }
  }

  return WeapSwitchT.WEAP_SWITCH_VALID;
}

/** p_weapon.cpp:573-576: `inline bool Weapon_IsPartOfChain(gitem_t *item,
 *  gitem_t *other)`. */
function Weapon_IsPartOfChain(item: GitemT, other: GitemT | null): boolean {
  return other !== null && other.chain !== ItemIdT.IT_NULL && item.chain !== ItemIdT.IT_NULL && other.chain === item.chain;
}

/** `root->chain_next` unconditional dereference (Use_Weapon,
 *  p_weapon.cpp:595/602) -- weapon chains are built as circular lists in
 *  InitItems (every chained weapon's `chain_next` wraps back around), so a
 *  weapon already proven to be `Weapon_IsPartOfChain` always has a non-null
 *  `chain_next` in practice. Throws instead of silently substituting a
 *  fallback value, per this file's/g_weapon.ts's "unconditional dereference
 *  -> explicit invariant check" idiom. */
function requireChainNext(item: GitemT): GitemT {
  if (item.chain_next === null) throw new Error("Use_Weapon: chain_next is null on a chained weapon -- invariant violated (chains must be circular)");
  return item.chain_next;
}

/** p_weapon.cpp:585-629: `void Use_Weapon(edict_t *ent, gitem_t *item)`.
 *  Makes the weapon ready if there is ammo. */
export function Use_Weapon(ent: EdictT, item: GitemT): void {
  const client = requirePlayerClient(ent);

  let root: GitemT;
  let wanted: GitemT;

  const newweapon = client.newweapon;
  const persWeapon = client.pers.weapon;

  // if we're switching to a weapon in this chain already,
  // start from the weapon after this one in the chain
  if (!client.no_weapon_chains && newweapon !== null && Weapon_IsPartOfChain(item, newweapon)) {
    root = newweapon;
    wanted = requireChainNext(root);
  } else if (!client.no_weapon_chains && persWeapon !== null && Weapon_IsPartOfChain(item, persWeapon)) {
    // if we're already holding a weapon in this chain,
    // start from the weapon after that one
    root = persWeapon;
    wanted = requireChainNext(root);
  } else {
    // start from beginning of chain (if any)
    wanted = root = item;
  }

  let result: WeapSwitchT = WeapSwitchT.WEAP_SWITCH_NO_WEAPON;

  for (;;) {
    // try the weapon currently in the chain
    result = Weapon_AttemptSwitch(ent, wanted, false);
    if (result === WeapSwitchT.WEAP_SWITCH_VALID) break;

    // no chains
    if (wanted.chain_next === null || client.no_weapon_chains) break;

    wanted = wanted.chain_next;

    // we wrapped back to the root item
    if (wanted === root) break;
  }

  if (result === WeapSwitchT.WEAP_SWITCH_VALID) {
    client.newweapon = wanted; // change to this weapon when down
  } else {
    result = Weapon_AttemptSwitch(ent, wanted, true);
    if (result === WeapSwitchT.WEAP_SWITCH_NO_WEAPON && wanted !== client.pers.weapon && wanted !== client.newweapon) {
      gi.Loc_Print(ent, PrintTypeT.PRINT_HIGH, "$g_out_of_item", [wanted.pickup_name ?? ""], 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Drop_Weapon
// ---------------------------------------------------------------------------

/** p_weapon.cpp:636-654: `void Drop_Weapon(edict_t *ent, gitem_t *item)`. */
export function Drop_Weapon(ent: EdictT, item: GitemT): void {
  const client = requirePlayerClient(ent);

  // [Paril-KEX]
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS)) return;

  const index = item.id;
  // see if we're already using it
  if ((item === client.pers.weapon || item === client.newweapon) && client.pers.inventory[index] === 1) {
    gi.Loc_Print(ent, PrintTypeT.PRINT_HIGH, "$g_cant_drop_weapon", [], 0);
    return;
  }

  const drop = Drop_Item(ent, item);
  drop.spawnflags = SpawnFlags_or(drop.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
  drop.svflags &= ~SvflagsT.SVF_INSTANCED;
  client.pers.inventory[index]--;
}

// ---------------------------------------------------------------------------
// Weapon_PowerupSound / Weapon_CanAnimate / Weapon_SetFinished
// ---------------------------------------------------------------------------

/** p_weapon.cpp:656-675: `void Weapon_PowerupSound(edict_t *ent)`. Exported
 *  (not just a local helper for this file's own weapon-fire dispatch)
 *  because rogue/p_rogue_weapon.ts's `weapon_etf_rifle_fire`/
 *  `Heatbeam_Fire` call it directly, exactly the way vanilla
 *  `Weapon_Blaster`/`Weapon_HyperBlaster`/etc. already do in this same
 *  file. */
export function Weapon_PowerupSound(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (!CTFApplyStrengthSound(ent)) {
    if (client.quad_time > level.time && client.double_time > level.time) {
      gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("ctf/tech2x.wav"), 1, ATTN_NORM, 0);
    } else if (client.quad_time > level.time) {
      gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
    } else if (client.double_time > level.time) {
      gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("misc/ddamage3.wav"), 1, ATTN_NORM, 0);
    } else if (client.quadfire_time > level.time && client.ctf_techsndtime < level.time) {
      client.ctf_techsndtime = Gtime_add(level.time, Gtime_from_ms(1000));
      gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("ctf/tech3.wav"), 1, ATTN_NORM, 0);
    }
  }

  CTFApplyHasteSound(ent);
}

/** p_weapon.cpp:677-681: `inline bool Weapon_CanAnimate(edict_t *ent)`. */
function Weapon_CanAnimate(ent: EdictT): boolean {
  // VWep animations screw up corpses
  return !ent.deadflag && ent.s.modelindex === MODELINDEX_PLAYER;
}

/** p_weapon.cpp:685-688: `inline void Weapon_SetFinished(edict_t *ent)`. */
function Weapon_SetFinished(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  client.weapon_fire_finished = Gtime_add(level.time, Weapon_AnimationTime(ent));
}

// ---------------------------------------------------------------------------
// Weapon_HandleDropping / Weapon_HandleActivating / Weapon_HandleNewWeapon /
// Weapon_HandleReady / Weapon_HandleFiring
// ---------------------------------------------------------------------------


function setDeactivatePainAnim(ent: EdictT, client: GClientT): void {
  client.anim_priority = AnimPriorityT.ANIM_ATTACK | AnimPriorityT.ANIM_REVERSED;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crpain4 + 1;
    client.anim_end = FRAME_crpain1;
  } else {
    ent.s.frame = FRAME_pain304 + 1;
    client.anim_end = FRAME_pain301;
  }
  client.anim_time = GTIME_ZERO;
}

/** p_weapon.cpp:690-724: `inline bool Weapon_HandleDropping(edict_t *ent,
 *  int FRAME_DEACTIVATE_LAST)`. */
function Weapon_HandleDropping(ent: EdictT, FRAME_DEACTIVATE_LAST: number): boolean {
  const client = requirePlayerClient(ent);
  if (client.weaponstate !== WeaponstateT.WEAPON_DROPPING) return false;

  if (client.weapon_think_time <= level.time) {
    if (client.ps.gunframe === FRAME_DEACTIVATE_LAST) {
      ChangeWeapon(ent);
      return true;
    } else if (FRAME_DEACTIVATE_LAST - client.ps.gunframe === 4) {
      setDeactivatePainAnim(ent, client);
    }

    client.ps.gunframe++;
    client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
  }
  return true;
}

/** p_weapon.cpp:726-752: `inline bool Weapon_HandleActivating(edict_t *ent,
 *  int FRAME_ACTIVATE_LAST, int FRAME_IDLE_FIRST)`. */
function Weapon_HandleActivating(ent: EdictT, FRAME_ACTIVATE_LAST: number, FRAME_IDLE_FIRST: number): boolean {
  const client = requirePlayerClient(ent);
  if (client.weaponstate !== WeaponstateT.WEAPON_ACTIVATING) return false;

  const instant = cvarBool("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH);
  if (client.weapon_think_time <= level.time || instant) {
    client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));

    if (client.ps.gunframe === FRAME_ACTIVATE_LAST || instant) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = FRAME_IDLE_FIRST;
      client.weapon_fire_buffered = false;
      if (!instant) Weapon_SetFinished(ent);
      else client.weapon_fire_finished = GTIME_ZERO;
      return true;
    }

    client.ps.gunframe++;
    return true;
  }

  return false;
}

/** p_weapon.cpp:754-800: `inline bool Weapon_HandleNewWeapon(edict_t *ent,
 *  int FRAME_DEACTIVATE_FIRST, int FRAME_DEACTIVATE_LAST)`. */
function Weapon_HandleNewWeapon(ent: EdictT, FRAME_DEACTIVATE_FIRST: number, FRAME_DEACTIVATE_LAST: number): boolean {
  const client = requirePlayerClient(ent);

  const instant = cvarBool("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH);
  let is_holstering = false;
  if (!instant) is_holstering = ((client.latched_buttons | client.buttons) & ButtonT.BUTTON_HOLSTER) !== 0;

  if ((client.newweapon !== null || is_holstering) && client.weaponstate !== WeaponstateT.WEAPON_FIRING) {
    if (instant || client.weapon_think_time <= level.time) {
      if (client.newweapon === null) client.newweapon = client.pers.weapon;

      client.weaponstate = WeaponstateT.WEAPON_DROPPING;

      if (instant) {
        ChangeWeapon(ent);
        return true;
      }

      client.ps.gunframe = FRAME_DEACTIVATE_FIRST;

      if (FRAME_DEACTIVATE_LAST - FRAME_DEACTIVATE_FIRST < 4) {
        setDeactivatePainAnim(ent, client);
      }

      client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
    }
    return true;
  }

  return false;
}

enum WeaponReadyStateT {
  READY_NONE,
  READY_CHANGING,
  READY_FIRING,
}

/** p_weapon.cpp:809-855: `inline weapon_ready_state_t Weapon_HandleReady(edict_t
 *  *ent, int FRAME_FIRE_FIRST, int FRAME_IDLE_FIRST, int FRAME_IDLE_LAST,
 *  const int *pause_frames)`. `FRAME_FIRE_FIRST` is accepted but never read
 *  anywhere in the C++ body (re-verified before writing this port) --
 *  dropped entirely from this port's signature rather than kept as an
 *  unused parameter, since this helper is purely internal (never a
 *  gitem_t function-pointer target, unlike Throw_Generic). See file
 *  header's "QUIRKS PRESERVED BUG-FOR-BUG" for the identical situation in
 *  Throw_Generic's `FRAME_THROW_FIRE`, which IS kept (that one's signature
 *  is cited directly against the C++ declaration in this unit's own
 *  report). */
function Weapon_HandleReady(ent: EdictT, FRAME_IDLE_FIRST: number, FRAME_IDLE_LAST: number, pause_frames: readonly number[]): WeaponReadyStateT {
  const client = requirePlayerClient(ent);
  if (client.weaponstate !== WeaponstateT.WEAPON_READY) return WeaponReadyStateT.READY_NONE;

  const request_firing = client.weapon_fire_buffered || ((client.latched_buttons | client.buttons) & ButtonT.BUTTON_ATTACK) !== 0;

  if (request_firing && client.weapon_fire_finished <= level.time) {
    client.latched_buttons &= ~ButtonT.BUTTON_ATTACK;
    client.weapon_think_time = level.time;

    const weapon = requireWeapon(client);
    if (weapon.ammo === ItemIdT.IT_NULL || client.pers.inventory[weapon.ammo] >= weapon.quantity) {
      client.weaponstate = WeaponstateT.WEAPON_FIRING;
      client.last_firing_time = Gtime_add(level.time, COOP_DAMAGE_FIRING_TIME);
      return WeaponReadyStateT.READY_FIRING;
    } else {
      NoAmmoWeaponChange(ent, true);
      return WeaponReadyStateT.READY_CHANGING;
    }
  } else if (client.weapon_think_time <= level.time) {
    client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));

    if (client.ps.gunframe === FRAME_IDLE_LAST) {
      client.ps.gunframe = FRAME_IDLE_FIRST;
      return WeaponReadyStateT.READY_CHANGING;
    }

    for (const frame of pause_frames) {
      if (client.ps.gunframe === frame && irandom(16)) {
        return WeaponReadyStateT.READY_CHANGING;
      }
    }

    client.ps.gunframe++;
    return WeaponReadyStateT.READY_CHANGING;
  }

  return WeaponReadyStateT.READY_NONE;
}

/** p_weapon.cpp:857-876: `inline void Weapon_HandleFiring(edict_t *ent,
 *  int32_t FRAME_IDLE_FIRST, std::function<void()> fire_handler)`. */
function Weapon_HandleFiring(ent: EdictT, FRAME_IDLE_FIRST: number, fire_handler: () => void): void {
  const client = requirePlayerClient(ent);
  Weapon_SetFinished(ent);

  if (client.weapon_fire_buffered) {
    client.buttons |= ButtonT.BUTTON_ATTACK;
    client.weapon_fire_buffered = false;
  }

  fire_handler();

  if (client.ps.gunframe === FRAME_IDLE_FIRST) {
    client.weaponstate = WeaponstateT.WEAPON_READY;
    client.weapon_fire_buffered = false;
  }

  client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
}

function setAttackAnim(ent: EdictT, client: GClientT): void {
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

// ---------------------------------------------------------------------------
// Weapon_Generic / Weapon_Repeating
// ---------------------------------------------------------------------------

/**
 * p_weapon.cpp:878-950: `void Weapon_Generic(edict_t *ent, int
 * FRAME_ACTIVATE_LAST, int FRAME_FIRE_LAST, int FRAME_IDLE_LAST, int
 * FRAME_DEACTIVATE_LAST, const int *pause_frames, const int *fire_frames,
 * void (*fire)(edict_t *ent))`.
 */
export function Weapon_Generic(
  ent: EdictT,
  FRAME_ACTIVATE_LAST: number,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_DEACTIVATE_LAST: number,
  pause_frames: readonly number[],
  fire_frames: readonly number[],
  fire: (ent: EdictT) => void,
): void {
  const client = requirePlayerClient(ent);
  const FRAME_FIRE_FIRST = FRAME_ACTIVATE_LAST + 1;
  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;
  const FRAME_DEACTIVATE_FIRST = FRAME_IDLE_LAST + 1;

  if (!Weapon_CanAnimate(ent)) return;

  if (Weapon_HandleDropping(ent, FRAME_DEACTIVATE_LAST)) return;
  if (Weapon_HandleActivating(ent, FRAME_ACTIVATE_LAST, FRAME_IDLE_FIRST)) return;
  if (Weapon_HandleNewWeapon(ent, FRAME_DEACTIVATE_FIRST, FRAME_DEACTIVATE_LAST)) return;

  const state = Weapon_HandleReady(ent, FRAME_IDLE_FIRST, FRAME_IDLE_LAST, pause_frames);
  if (state !== WeaponReadyStateT.READY_NONE) {
    if (state === WeaponReadyStateT.READY_FIRING) {
      client.ps.gunframe = FRAME_FIRE_FIRST;
      client.weapon_fire_buffered = false;

      if (client.weapon_thunk) client.weapon_think_time = Gtime_add(client.weapon_think_time, Gtime_from_ms(gi.frame_time_ms));

      client.weapon_think_time = Gtime_add(client.weapon_think_time, Weapon_AnimationTime(ent));
      Weapon_SetFinished(ent);

      if (fire_frames.includes(client.ps.gunframe)) {
        Weapon_PowerupSound(ent);
        fire(ent);
      }

      setAttackAnim(ent, client);
    }

    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING && client.weapon_think_time <= level.time) {
    client.last_firing_time = Gtime_add(level.time, COOP_DAMAGE_FIRING_TIME);
    client.ps.gunframe++;
    Weapon_HandleFiring(ent, FRAME_IDLE_FIRST, () => {
      if (fire_frames.includes(client.ps.gunframe)) {
        Weapon_PowerupSound(ent);
        fire(ent);
      }
    });
  }
}

/**
 * p_weapon.cpp:952-978: `void Weapon_Repeating(edict_t *ent, int
 * FRAME_ACTIVATE_LAST, int FRAME_FIRE_LAST, int FRAME_IDLE_LAST, int
 * FRAME_DEACTIVATE_LAST, const int *pause_frames, void (*fire)(edict_t
 * *ent))`.
 */
export function Weapon_Repeating(
  ent: EdictT,
  FRAME_ACTIVATE_LAST: number,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_DEACTIVATE_LAST: number,
  pause_frames: readonly number[],
  fire: (ent: EdictT) => void,
): void {
  const client = requirePlayerClient(ent);
  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;
  const FRAME_DEACTIVATE_FIRST = FRAME_IDLE_LAST + 1;

  if (!Weapon_CanAnimate(ent)) return;

  if (Weapon_HandleDropping(ent, FRAME_DEACTIVATE_LAST)) return;
  if (Weapon_HandleActivating(ent, FRAME_ACTIVATE_LAST, FRAME_IDLE_FIRST)) return;
  if (Weapon_HandleNewWeapon(ent, FRAME_DEACTIVATE_FIRST, FRAME_DEACTIVATE_LAST)) return;
  if (Weapon_HandleReady(ent, FRAME_IDLE_FIRST, FRAME_IDLE_LAST, pause_frames) === WeaponReadyStateT.READY_CHANGING) return;

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING && client.weapon_think_time <= level.time) {
    client.last_firing_time = Gtime_add(level.time, COOP_DAMAGE_FIRING_TIME);
    Weapon_HandleFiring(ent, FRAME_IDLE_FIRST, () => fire(ent));

    if (client.weapon_thunk) client.weapon_think_time = Gtime_add(client.weapon_think_time, Gtime_from_ms(gi.frame_time_ms));
  }
}

// ---------------------------------------------------------------------------
// GRENADE
// ---------------------------------------------------------------------------

/** p_weapon.cpp:988-1011: `void weapon_grenade_fire(edict_t *ent, bool
 *  held)`. */
function weapon_grenade_fire(ent: EdictT, held: boolean): void {
  const client = requirePlayerClient(ent);
  let damage = 125;
  const radius = damage + 40;
  if (is_quad) damage *= damage_multiplier;

  // Paril: kill sideways angle on grenades
  // limit upwards angle so you don't throw behind you
  const { start, dir } = P_ProjectSource(ent, vec3(Math.max(-62.5, client.v_angle[0]), client.v_angle[1], client.v_angle[2]), vec3(2, 0, -14));

  const timer = Gtime_subtract(client.grenade_time, level.time);
  const speed = Math.trunc(
    ent.health <= 0
      ? GRENADE_MINSPEED
      : Math.min(GRENADE_MINSPEED + Gtime_seconds(Gtime_subtract(GRENADE_TIMER, timer)) * ((GRENADE_MAXSPEED - GRENADE_MINSPEED) / Gtime_seconds(GRENADE_TIMER)), GRENADE_MAXSPEED),
  );

  client.grenade_time = GTIME_ZERO;

  fire_grenade2(ent, start, dir, damage, speed, timer, radius, held);

  G_RemoveAmmo(ent, 1);
}

/**
 * p_weapon.cpp:1013-1213: `void Throw_Generic(...)`. `FRAME_THROW_FIRE` is
 * accepted but never read anywhere in the C++ body -- see file header's
 * "QUIRKS PRESERVED BUG-FOR-BUG".
 */
export function Throw_Generic(
  ent: EdictT,
  FRAME_FIRE_LAST: number,
  FRAME_IDLE_LAST: number,
  FRAME_PRIME_SOUND: number,
  prime_sound: string | null,
  FRAME_THROW_HOLD: number,
  _FRAME_THROW_FIRE: number,
  pause_frames: readonly number[],
  EXPLODE: boolean,
  primed_sound: string | null,
  fire: (ent: EdictT, held: boolean) => void,
  extra_idle_frame: boolean,
): void {
  const client = requirePlayerClient(ent);

  // when we die, just toss what we had in our hands.
  if (ent.health <= 0) {
    fire(ent, true);
    return;
  }

  const FRAME_IDLE_FIRST = FRAME_FIRE_LAST + 1;

  if (client.newweapon !== null && client.weaponstate === WeaponstateT.WEAPON_READY) {
    if (client.weapon_think_time <= level.time) {
      ChangeWeapon(ent);
      client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_ACTIVATING) {
    if (client.weapon_think_time <= level.time) {
      client.weaponstate = WeaponstateT.WEAPON_READY;
      client.ps.gunframe = extra_idle_frame ? FRAME_IDLE_LAST + 1 : FRAME_IDLE_FIRST;
      client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
      Weapon_SetFinished(ent);
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_READY) {
    const request_firing = client.weapon_fire_buffered || ((client.latched_buttons | client.buttons) & ButtonT.BUTTON_ATTACK) !== 0;

    if (request_firing && client.weapon_fire_finished <= level.time) {
      client.latched_buttons &= ~ButtonT.BUTTON_ATTACK;

      const weapon = requireWeapon(client);
      if (client.pers.inventory[weapon.ammo]) {
        client.ps.gunframe = 1;
        client.weaponstate = WeaponstateT.WEAPON_FIRING;
        client.grenade_time = GTIME_ZERO;
        client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
      } else {
        NoAmmoWeaponChange(ent, true);
      }
      return;
    } else if (client.weapon_think_time <= level.time) {
      client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));

      if (client.ps.gunframe >= FRAME_IDLE_LAST) {
        client.ps.gunframe = FRAME_IDLE_FIRST;
        return;
      }

      for (const frame of pause_frames) {
        if (client.ps.gunframe === frame && irandom(16)) return;
      }

      client.ps.gunframe++;
    }
    return;
  }

  if (client.weaponstate === WeaponstateT.WEAPON_FIRING) {
    client.last_firing_time = Gtime_add(level.time, COOP_DAMAGE_FIRING_TIME);

    if (client.weapon_think_time <= level.time) {
      if (prime_sound !== null && client.ps.gunframe === FRAME_PRIME_SOUND) {
        gi.sound(ent, SoundchanT.CHAN_WEAPON, gi.soundindex(prime_sound), 1, ATTN_NORM, 0);
      }

      // [Paril-KEX] dualfire/time accel
      let grenade_wait_time = Gtime_from_ms(1000);

      if (CTFApplyHaste(ent)) grenade_wait_time = Gtime_scale(grenade_wait_time, 0.5);
      if (is_quadfire) grenade_wait_time = Gtime_scale(grenade_wait_time, 0.5);

      if (client.ps.gunframe === FRAME_THROW_HOLD) {
        if (!Gtime_nonzero(client.grenade_time) && !Gtime_nonzero(client.grenade_finished_time)) {
          client.grenade_time = Gtime_add(level.time, Gtime_add(GRENADE_TIMER, Gtime_from_ms(200)));
        }

        if (primed_sound !== null && !client.grenade_blew_up) client.weapon_sound = gi.soundindex(primed_sound);

        // they waited too long, detonate it in their hand
        if (EXPLODE && !client.grenade_blew_up && level.time >= client.grenade_time) {
          Weapon_PowerupSound(ent);
          client.weapon_sound = 0;
          fire(ent, true);
          client.grenade_blew_up = true;

          client.grenade_finished_time = Gtime_add(level.time, grenade_wait_time);
        }

        if ((client.buttons & ButtonT.BUTTON_ATTACK) !== 0) {
          client.weapon_think_time = Gtime_add(level.time, Gtime_from_ms(1));
          return;
        }

        if (client.grenade_blew_up) {
          if (level.time >= client.grenade_finished_time) {
            client.ps.gunframe = FRAME_FIRE_LAST;
            client.grenade_blew_up = false;
            client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));
          } else {
            return;
          }
        } else {
          client.ps.gunframe++;

          Weapon_PowerupSound(ent);
          client.weapon_sound = 0;
          fire(ent, false);

          if (!EXPLODE || !client.grenade_blew_up) client.grenade_finished_time = Gtime_add(level.time, grenade_wait_time);

          // VWep animations screw up corpses
          if (!ent.deadflag && ent.s.modelindex === MODELINDEX_PLAYER && ent.health > 0) {
            if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
              client.anim_priority = AnimPriorityT.ANIM_ATTACK;
              ent.s.frame = FRAME_crattak1 - 1;
              client.anim_end = FRAME_crattak3;
            } else {
              client.anim_priority = AnimPriorityT.ANIM_ATTACK | AnimPriorityT.ANIM_REVERSED;
              ent.s.frame = FRAME_wave08;
              client.anim_end = FRAME_wave01;
            }
            client.anim_time = GTIME_ZERO;
          }
        }
      }

      client.weapon_think_time = Gtime_add(level.time, Weapon_AnimationTime(ent));

      if (client.ps.gunframe === FRAME_FIRE_LAST && level.time < client.grenade_finished_time) return;

      client.ps.gunframe++;

      if (client.ps.gunframe === FRAME_IDLE_FIRST) {
        client.grenade_finished_time = GTIME_ZERO;
        client.weaponstate = WeaponstateT.WEAPON_READY;
        client.weapon_fire_buffered = false;
        Weapon_SetFinished(ent);

        if (extra_idle_frame) client.ps.gunframe = FRAME_IDLE_LAST + 1;

        // Paril: if we ran out of the throwable, switch
        // so we don't appear to be holding one that we
        // can't throw
        const weapon = requireWeapon(client);
        if (!client.pers.inventory[weapon.ammo]) {
          NoAmmoWeaponChange(ent, false);
          ChangeWeapon(ent);
        }
      }
    }
  }
}

const HAND_GRENADE_PAUSE_FRAMES: readonly number[] = [29, 34, 39, 48];

/** p_weapon.cpp:1215-1224: `void Weapon_Grenade(edict_t *ent)`. */
export function Weapon_Grenade(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  Throw_Generic(ent, 15, 48, 5, "weapons/hgrena1b.wav", 11, 12, HAND_GRENADE_PAUSE_FRAMES, true, "weapons/hgrenc1b.wav", weapon_grenade_fire, true);

  // [Paril-KEX] skip the duped frame
  if (client.ps.gunframe === 1) client.ps.gunframe = 2;
}

// ---------------------------------------------------------------------------
// GRENADE LAUNCHER
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1234-1260: `void weapon_grenadelauncher_fire(edict_t
 *  *ent)`. */
function weapon_grenadelauncher_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = 120;
  const radius = damage + 40;
  if (is_quad) damage *= damage_multiplier;

  // Paril: kill sideways angle on grenades
  // limit upwards angle so you don't fire it behind you
  const { start, dir } = P_ProjectSource(ent, vec3(Math.max(-62.5, client.v_angle[0]), client.v_angle[1], client.v_angle[2]), vec3(8, 0, -8));

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  fire_grenade(ent, start, dir, damage, 600, Gtime_from_ms(2500), radius, crandom_open() * 10, 200 + crandom_open() * 10, false);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_GRENADE | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const GRENADELAUNCHER_PAUSE_FRAMES: readonly number[] = [34, 51, 59];
const GRENADELAUNCHER_FIRE_FRAMES: readonly number[] = [6];

/** p_weapon.cpp:1262-1268: `void Weapon_GrenadeLauncher(edict_t *ent)`. */
export function Weapon_GrenadeLauncher(ent: EdictT): void {
  Weapon_Generic(ent, 5, 16, 59, 64, GRENADELAUNCHER_PAUSE_FRAMES, GRENADELAUNCHER_FIRE_FRAMES, weapon_grenadelauncher_fire);
}

// ---------------------------------------------------------------------------
// ROCKET
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1278-1308: `void Weapon_RocketLauncher_Fire(edict_t
 *  *ent)`. */
function Weapon_RocketLauncher_Fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = irandom(100, 120);
  let radius_damage = 120;
  const damage_radius = 120;
  if (is_quad) {
    damage *= damage_multiplier;
    radius_damage *= damage_multiplier;
  }

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(8, 8, -8));
  fire_rocket(ent, start, dir, damage, 650, damage_radius, radius_damage);

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_ROCKET | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const ROCKETLAUNCHER_PAUSE_FRAMES: readonly number[] = [25, 33, 42, 50];
const ROCKETLAUNCHER_FIRE_FRAMES: readonly number[] = [5];

/** p_weapon.cpp:1310-1316: `void Weapon_RocketLauncher(edict_t *ent)`. */
export function Weapon_RocketLauncher(ent: EdictT): void {
  Weapon_Generic(ent, 4, 12, 50, 54, ROCKETLAUNCHER_PAUSE_FRAMES, ROCKETLAUNCHER_FIRE_FRAMES, Weapon_RocketLauncher_Fire);
}

// ---------------------------------------------------------------------------
// BLASTER / HYPERBLASTER
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1326-1354: `void Blaster_Fire(edict_t *ent, const vec3_t
 *  &g_offset, int damage, bool hyper, effects_t effect)`. */
function Blaster_Fire(ent: EdictT, g_offset: Vec3, damageIn: number, hyper: boolean, effect: EffectsT): void {
  const client = requirePlayerClient(ent);
  let damage = damageIn;
  if (is_quad) damage *= damage_multiplier;

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3_add(vec3(24, 8, -8), g_offset));

  if (hyper) P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(crandom() * 0.7, crandom() * 0.7, crandom() * 0.7));
  else P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  // let the regular blaster projectiles travel a bit faster because it is a
  // completely useless gun
  const speed = hyper ? 1000 : 1500;

  fire_blaster(ent, start, dir, damage, speed, effect, hyper ? MOD_HYPERBLASTER : MOD_BLASTER);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte((hyper ? PlayerMuzzleT.MZ_HYPERBLASTER : PlayerMuzzleT.MZ_BLASTER) | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);
}

/** p_weapon.cpp:1356-1361: `void Weapon_Blaster_Fire(edict_t *ent)`. */
function Weapon_Blaster_Fire(ent: EdictT): void {
  // give the blaster 15 across the board instead of just in dm
  Blaster_Fire(ent, vec3_origin, 15, false, EffectsT.EF_BLASTER);
}

const BLASTER_PAUSE_FRAMES: readonly number[] = [19, 32];
const BLASTER_FIRE_FRAMES: readonly number[] = [5];

/** p_weapon.cpp:1363-1369: `void Weapon_Blaster(edict_t *ent)`. */
export function Weapon_Blaster(ent: EdictT): void {
  Weapon_Generic(ent, 4, 8, 52, 55, BLASTER_PAUSE_FRAMES, BLASTER_FIRE_FRAMES, Weapon_Blaster_Fire);
}

/** p_weapon.cpp:1371-1442: `void Weapon_HyperBlaster_Fire(edict_t *ent)`. */
function Weapon_HyperBlaster_Fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);

  // start on frame 6
  if (client.ps.gunframe > 20) client.ps.gunframe = 6;
  else client.ps.gunframe++;

  // if we reached end of loop, have ammo & holding attack, reset loop
  // otherwise play wind down
  if (client.ps.gunframe === 12) {
    const weapon = requireWeapon(client);
    if (client.pers.inventory[weapon.ammo] && (client.buttons & ButtonT.BUTTON_ATTACK) !== 0) {
      client.ps.gunframe = 6;
    } else {
      gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("weapons/hyprbd1a.wav"), 1, ATTN_NORM, 0);
    }
  }

  // play weapon sound for firing loop
  if (client.ps.gunframe >= 6 && client.ps.gunframe <= 11) client.weapon_sound = gi.soundindex("weapons/hyprbl1a.wav");
  else client.weapon_sound = 0;

  // fire frames
  const request_firing = client.weapon_fire_buffered || (client.buttons & ButtonT.BUTTON_ATTACK) !== 0;

  if (request_firing && client.ps.gunframe >= 6 && client.ps.gunframe <= 11) {
    client.weapon_fire_buffered = false;

    const weapon = requireWeapon(client);
    if (!client.pers.inventory[weapon.ammo]) {
      NoAmmoWeaponChange(ent, true);
      return;
    }

    const rotation = ((client.ps.gunframe - 5) * 2 * Q_PIf) / 6;
    const offset = vec3();
    offset[0] = -4 * Math.sin(rotation);
    offset[2] = 0;
    offset[1] = 4 * Math.cos(rotation);

    const damage = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) ? 15 : 20;
    Blaster_Fire(ent, offset, damage, true, client.ps.gunframe % 4 ? EffectsT.EF_NONE : EffectsT.EF_HYPERBLASTER);
    Weapon_PowerupSound(ent);

    G_RemoveAmmo(ent);

    setAttackAnimJittered(ent, client);
  }
}

/** Matches C's `FRAME_crattak1 - (int)(frandom() + 0.25f)`/`FRAME_attack1 -
 *  (int)(frandom() + 0.25f)` jitter (used by HyperBlaster and Machinegun
 *  fire, not the shared `setAttackAnim` used by the deterministic
 *  Weapon_Generic path). */
function setAttackAnimJittered(ent: EdictT, client: GClientT): void {
  client.anim_priority = AnimPriorityT.ANIM_ATTACK;
  const jitter = Math.trunc(frandom() + 0.25);
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - jitter;
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - jitter;
    client.anim_end = FRAME_attack8;
  }
  client.anim_time = GTIME_ZERO;
}

const HYPERBLASTER_PAUSE_FRAMES: readonly number[] = [];

/** p_weapon.cpp:1444-1449: `void Weapon_HyperBlaster(edict_t *ent)`. */
export function Weapon_HyperBlaster(ent: EdictT): void {
  Weapon_Repeating(ent, 5, 20, 49, 53, HYPERBLASTER_PAUSE_FRAMES, Weapon_HyperBlaster_Fire);
}

// ---------------------------------------------------------------------------
// MACHINEGUN / CHAINGUN
// ---------------------------------------------------------------------------
// Machinegun_Fire/Chaingun_Fire are `static` fire-callback bodies in the C++
// source (only ever referenced by name within this same file, passed as a
// function pointer to Weapon_Repeating) -- exported here anyway so this
// unit's own test suite can exercise their frame/kick/ammo logic directly
// instead of only indirectly through the full Weapon_Repeating state
// machine (which would require satisfying WEAPON_FIRING preconditions
// unrelated to what each test actually verifies). No other kexgame file
// imports either name.

/** p_weapon.cpp:1459-1539: `void Machinegun_Fire(edict_t *ent)`. */
export function Machinegun_Fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = 8;
  let kick = 2;

  if ((client.buttons & ButtonT.BUTTON_ATTACK) === 0) {
    client.machinegun_shots = 0;
    client.ps.gunframe = 6;
    return;
  }

  client.ps.gunframe = client.ps.gunframe === 4 ? 5 : 4;

  const weapon = requireWeapon(client);
  if (client.pers.inventory[weapon.ammo] < 1) {
    client.ps.gunframe = 6;
    NoAmmoWeaponChange(ent, true);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  const kick_origin = vec3(crandom() * 0.35, crandom() * 0.35, crandom() * 0.35);
  const kick_angles = vec3(crandom() * 0.7, crandom() * 0.7, crandom() * 0.7);
  P_AddWeaponKick(ent, kick_origin, kick_angles);

  // Paril: kill sideways angle on hitscan
  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 0, -8));
  G_LagCompensate(ent, start, dir);
  fire_bullet(ent, start, dir, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_MACHINEGUN);
  G_UnLagCompensate();
  Weapon_PowerupSound(ent);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_MACHINEGUN | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);

  setAttackAnimJittered(ent, client);
}

const MACHINEGUN_PAUSE_FRAMES: readonly number[] = [23, 45];

/** p_weapon.cpp:1541-1546: `void Weapon_Machinegun(edict_t *ent)`. */
export function Weapon_Machinegun(ent: EdictT): void {
  Weapon_Repeating(ent, 3, 5, 45, 49, MACHINEGUN_PAUSE_FRAMES, Machinegun_Fire);
}

/** p_weapon.cpp:1548-1667: `void Chaingun_Fire(edict_t *ent)`. */
export function Chaingun_Fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const weapon = requireWeapon(client);
  let damage = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) ? 6 : 8;
  let kick = 2;

  if (client.ps.gunframe > 31) {
    client.ps.gunframe = 5;
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("weapons/chngnu1a.wav"), 1, ATTN_IDLE, 0);
  } else if (client.ps.gunframe === 14 && (client.buttons & ButtonT.BUTTON_ATTACK) === 0) {
    client.ps.gunframe = 32;
    client.weapon_sound = 0;
    return;
  } else if (client.ps.gunframe === 21 && (client.buttons & ButtonT.BUTTON_ATTACK) !== 0 && client.pers.inventory[weapon.ammo] !== 0) {
    client.ps.gunframe = 15;
  } else {
    client.ps.gunframe++;
  }

  if (client.ps.gunframe === 22) {
    client.weapon_sound = 0;
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("weapons/chngnd1a.wav"), 1, ATTN_IDLE, 0);
  }

  if (client.ps.gunframe < 5 || client.ps.gunframe > 21) return;

  client.weapon_sound = gi.soundindex("weapons/chngnl1a.wav");

  client.anim_priority = AnimPriorityT.ANIM_ATTACK;
  if ((client.ps.pmove.pm_flags & PmflagsT.PMF_DUCKED) !== 0) {
    ent.s.frame = FRAME_crattak1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_crattak9;
  } else {
    ent.s.frame = FRAME_attack1 - (client.ps.gunframe & 1);
    client.anim_end = FRAME_attack8;
  }
  client.anim_time = GTIME_ZERO;

  let shots: number;
  if (client.ps.gunframe <= 9) shots = 1;
  else if (client.ps.gunframe <= 14) shots = (client.buttons & ButtonT.BUTTON_ATTACK) !== 0 ? 2 : 1;
  else shots = 3;

  if (client.pers.inventory[weapon.ammo] < shots) shots = client.pers.inventory[weapon.ammo];

  if (!shots) {
    NoAmmoWeaponChange(ent, true);
    return;
  }

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  const kick_origin = vec3(crandom() * 0.35, crandom() * 0.35, crandom() * 0.35);
  const kick_angles = vec3(crandom() * (0.5 + shots * 0.15), crandom() * (0.5 + shots * 0.15), crandom() * (0.5 + shots * 0.15));
  P_AddWeaponKick(ent, kick_origin, kick_angles);

  let start = vec3();
  let dir = vec3();
  {
    const proj = P_ProjectSource(ent, client.v_angle, vec3(0, 0, -8));
    start = proj.start;
    dir = proj.dir;
  }

  G_LagCompensate(ent, start, dir);
  for (let i = 0; i < shots; i++) {
    // Paril: kill sideways angle on hitscan
    const r = crandom() * 4;
    const u = crandom() * 4;
    const proj = P_ProjectSource(ent, client.v_angle, vec3(0, r, u - 8));
    start = proj.start;
    dir = proj.dir;

    fire_bullet(ent, start, dir, damage, kick, DEFAULT_BULLET_HSPREAD, DEFAULT_BULLET_VSPREAD, MOD_CHAINGUN);
  }
  G_UnLagCompensate();

  Weapon_PowerupSound(ent);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte((PlayerMuzzleT.MZ_CHAINGUN1 + shots - 1) | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent, shots);
}

const CHAINGUN_PAUSE_FRAMES: readonly number[] = [38, 43, 51, 61];

/** p_weapon.cpp:1669-1674: `void Weapon_Chaingun(edict_t *ent)`. */
export function Weapon_Chaingun(ent: EdictT): void {
  Weapon_Repeating(ent, 4, 31, 61, 64, CHAINGUN_PAUSE_FRAMES, Chaingun_Fire);
}

// ---------------------------------------------------------------------------
// SHOTGUN / SUPERSHOTGUN
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1684-1717: `void weapon_shotgun_fire(edict_t *ent)`. */
function weapon_shotgun_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = 4;
  let kick = 8;

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 0, -8));

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-2, 0, 0));

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  G_LagCompensate(ent, start, dir);
  const count = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) ? DEFAULT_DEATHMATCH_SHOTGUN_COUNT : DEFAULT_SHOTGUN_COUNT;
  fire_shotgun(ent, start, dir, damage, kick, 500, 500, count, MOD_SHOTGUN);
  G_UnLagCompensate();

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_SHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const SHOTGUN_PAUSE_FRAMES: readonly number[] = [22, 28, 34];
const SHOTGUN_FIRE_FRAMES: readonly number[] = [8];

/** p_weapon.cpp:1719-1725: `void Weapon_Shotgun(edict_t *ent)`. */
export function Weapon_Shotgun(ent: EdictT): void {
  Weapon_Generic(ent, 7, 18, 36, 39, SHOTGUN_PAUSE_FRAMES, SHOTGUN_FIRE_FRAMES, weapon_shotgun_fire);
}

/** p_weapon.cpp:1727-1765: `void weapon_supershotgun_fire(edict_t *ent)`. */
function weapon_supershotgun_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  let damage = 6;
  let kick = 12;

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  let { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 0, -8));
  G_LagCompensate(ent, start, dir);

  const vLeft = vec3(client.v_angle[PITCH], client.v_angle[YAW] - 5, client.v_angle[ROLL]);
  ({ start, dir } = P_ProjectSource(ent, vLeft, vec3(0, 0, -8)));
  fire_shotgun(ent, start, dir, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);

  const vRight = vec3(client.v_angle[PITCH], client.v_angle[YAW] + 5, client.v_angle[ROLL]);
  ({ start, dir } = P_ProjectSource(ent, vRight, vec3(0, 0, -8)));
  fire_shotgun(ent, start, dir, damage, kick, DEFAULT_SHOTGUN_HSPREAD, DEFAULT_SHOTGUN_VSPREAD, DEFAULT_SSHOTGUN_COUNT / 2, MOD_SSHOTGUN);
  G_UnLagCompensate();

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-2, 0, 0));

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_SSHOTGUN | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const SUPERSHOTGUN_PAUSE_FRAMES: readonly number[] = [29, 42, 57];
const SUPERSHOTGUN_FIRE_FRAMES: readonly number[] = [7];

/** p_weapon.cpp:1767-1773: `void Weapon_SuperShotgun(edict_t *ent)`. */
export function Weapon_SuperShotgun(ent: EdictT): void {
  Weapon_Generic(ent, 6, 17, 57, 61, SUPERSHOTGUN_PAUSE_FRAMES, SUPERSHOTGUN_FIRE_FRAMES, weapon_supershotgun_fire);
}

// ---------------------------------------------------------------------------
// RAILGUN
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1783-1822: `void weapon_railgun_fire(edict_t *ent)`. */
function weapon_railgun_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const dm = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH);
  let damage = dm ? 100 : 125;
  let kick = dm ? 200 : 225;

  if (is_quad) {
    damage *= damage_multiplier;
    kick *= damage_multiplier;
  }

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(0, 7, -8));
  G_LagCompensate(ent, start, dir);
  fire_rail(ent, start, dir, damage, kick);
  G_UnLagCompensate();

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -3), vec3(-3, 0, 0));

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_RAILGUN | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

const RAILGUN_PAUSE_FRAMES: readonly number[] = [56];
const RAILGUN_FIRE_FRAMES: readonly number[] = [4];

/** p_weapon.cpp:1824-1830: `void Weapon_Railgun(edict_t *ent)`. */
export function Weapon_Railgun(ent: EdictT): void {
  Weapon_Generic(ent, 3, 18, 56, 61, RAILGUN_PAUSE_FRAMES, RAILGUN_FIRE_FRAMES, weapon_railgun_fire);
}

// ---------------------------------------------------------------------------
// BFG10K
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1840-1887: `void weapon_bfg_fire(edict_t *ent)`. */
function weapon_bfg_fire(ent: EdictT): void {
  const client = requirePlayerClient(ent);
  const damage_radius = 1000;
  let damage = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) ? 200 : 500;

  if (client.ps.gunframe === 9) {
    gi.WriteByte(ServerCommandT.svc_muzzleflash);
    gi.WriteEntity(ent);
    gi.WriteByte(PlayerMuzzleT.MZ_BFG | is_silenced);
    gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

    PlayerNoise(ent, ent.s.origin, PlayerNoiseT.PNOISE_WEAPON);
    return;
  }

  // cells can go down during windup (from power armor hits), so
  // check again and abort firing if we don't have enough now
  const weapon = requireWeapon(client);
  if (client.pers.inventory[weapon.ammo] < 50) return;

  if (is_quad) damage *= damage_multiplier;

  const { start, dir } = P_ProjectSource(ent, client.v_angle, vec3(8, 8, -8));
  fire_bfg(ent, start, dir, damage, 400, damage_radius);

  P_AddWeaponKick(ent, vec3_muls(client.v_forward, -2), vec3(-20, 0, crandom() * 8));
  client.kick.total = DAMAGE_TIME_LOCAL();
  client.kick.time = Gtime_add(level.time, client.kick.total);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(ent);
  gi.WriteByte(PlayerMuzzleT.MZ_BFG2 | is_silenced);
  gi.multicast(ent.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(ent, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(ent);
}

/** g_local.h: `DAMAGE_TIME() { return 500_ms + DAMAGE_TIME_SLACK(); }` --
 *  already ported for real in g_local.ts as `DAMAGE_TIME(frameTimeMs)`;
 *  called here with the current frame time exactly like p_view.ts's own
 *  call sites do. */
function DAMAGE_TIME_LOCAL(): GTime {
  return DAMAGE_TIME(Gtime_from_ms(gi.frame_time_ms));
}

const BFG_PAUSE_FRAMES: readonly number[] = [39, 45, 50, 55];
const BFG_FIRE_FRAMES: readonly number[] = [9, 17];

/** p_weapon.cpp:1889-1895: `void Weapon_BFG(edict_t *ent)`. */
export function Weapon_BFG(ent: EdictT): void {
  Weapon_Generic(ent, 8, 32, 54, 58, BFG_PAUSE_FRAMES, BFG_FIRE_FRAMES, weapon_bfg_fire);
}

// ---------------------------------------------------------------------------
// BETA DISINTEGRATOR -- see file header's "QUIRKS PRESERVED BUG-FOR-BUG"
// (no is_quad, no Weapon_PowerupSound, no | is_silenced on the flash)
// ---------------------------------------------------------------------------

/** p_weapon.cpp:1899-1917: `void weapon_disint_fire(edict_t *self)`. */
function weapon_disint_fire(self: EdictT): void {
  const client = requirePlayerClient(self);
  const { start, dir } = P_ProjectSource(self, client.v_angle, vec3(24, 8, -8));

  P_AddWeaponKick(self, vec3_muls(client.v_forward, -2), vec3(-1, 0, 0));

  fire_disintegrator(self, start, dir, 800);

  gi.WriteByte(ServerCommandT.svc_muzzleflash);
  gi.WriteEntity(self);
  gi.WriteByte(PlayerMuzzleT.MZ_BLASTER2);
  gi.multicast(self.s.origin, KexMulticastT.MULTICAST_PVS, false);

  PlayerNoise(self, start, PlayerNoiseT.PNOISE_WEAPON);

  G_RemoveAmmo(self);
}

const DISINTEGRATOR_PAUSE_FRAMES: readonly number[] = [30, 37, 45];
const DISINTEGRATOR_FIRE_FRAMES: readonly number[] = [17];

/** p_weapon.cpp:1919-1925: `void Weapon_Beta_Disintegrator(edict_t *ent)`. */
export function Weapon_Beta_Disintegrator(ent: EdictT): void {
  Weapon_Generic(ent, 16, 23, 46, 50, DISINTEGRATOR_PAUSE_FRAMES, DISINTEGRATOR_FIRE_FRAMES, weapon_disint_fire);
}
