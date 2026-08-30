// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_items.c -- the unified item system for the game module (2023 Quake II
// re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/g_items.cpp (4,055 lines,
// C++17): the complete itemlist[] (base + xatrix + rogue + CTF + KEX
// additions, 84 entries incl. index 0 -- matches ItemIdT.IT_TOTAL exactly,
// pinned by the load-time assertion just below the array and by
// test/kexgame_g_items.test.ts), every Pickup_*/Use_*/Drop_* handler family,
// quad/quadfire/invulnerability/invisibility/silencer/breather/envirosuit
// timing, power armor use/toggle/pickup/drop, ammo add/cap machinery, armor
// pickup salvage math, health pickup incl. the mega-health think chain,
// GetItemByIndex/GetItemByAmmo/GetItemByPowerup/FindItem/FindItemByClassname,
// Drop_Item/Drop_General/Touch_Item/droptofloor/PrecacheItem/SpawnItem, and
// InitItems/SetItemNames.
//
// ============================================================================
// STUB SWAP: FindItemByClassname / Drop_Item -- g_monster.ts, g_trigger.ts
// ============================================================================
// g_monster.ts and g_trigger.ts each carried a local throwing stub for
// FindItemByClassname (both) and Drop_Item (g_monster.ts only), cited
// "pending g_items.ts". Both files' stubs are deleted and replaced with real
// imports from this file (see each file's own updated header). No other
// call site changes.
//
// Also swapped: g_trigger.ts's `P_ToggleFlashlight` stub was mis-cited as
// "pending p_hud.ts" -- grepping the real source tree twice confirms
// P_ToggleFlashlight is defined in g_items.cpp:1482 (declared in
// g_local.h:2035), not p_hud.cpp. Ported for real here and re-imported by
// g_trigger.ts with the citation corrected.
//
// ============================================================================
// CROSS-DEPENDENCIES ALREADY LANDED ELSEWHERE -- imported, not duplicated
// ============================================================================
// - ArmorIndex / PowerArmorType (g_items.cpp:726 / 827): g_combat.ts already
//   ported real, exported copies of both (its own header: "a future
//   g_items.ts unit is free to re-export them from there instead once it
//   lands, without any call site here changing"). Imported and re-exported
//   from here per that explicit invitation, instead of a second copy.
// - G_CheckPowerArmor (g_items.cpp:306): g_combat.ts has its own real
//   implementation too, but it is NOT exported (file-local helper for
//   CheckPowerArmor). Since editing g_combat.ts is outside this unit's file
//   scope (g_items.ts + g_monster.ts/g_trigger.ts stub swaps + test file
//   only), this file carries its own small, verified-identical copy instead
//   -- transcribed directly from g_items.cpp:306-337, not from g_combat.ts's
//   copy, so there is no risk of silently drifting from a copy of a copy.
// - G_CheckInfiniteAmmo (p_weapon.cpp:25-31): p_hud.ts already ports this
//   for real and exports it. NOT imported from there: p_hud.ts is under
//   concurrent development in this port line (a sibling unit owns it), and
//   this function is three lines of pure cvar/flag logic -- duplicating it
//   locally removes any build-coupling risk to a file this unit does not
//   control, at negligible DRY cost.
// - player_stat_t indices (STAT_PICKUP_ICON=7/STAT_PICKUP_STRING=8/
//   STAT_SELECTED_ITEM=12/STAT_SELECTED_ITEM_NAME=51): the authoritative
//   enum is p_hud.ts's own `PlayerStatT`, but for the same concurrent-
//   development reason above, the four plain numeric indices Touch_Item/
//   SelectNextItem touch are duplicated here as local constants instead of
//   imported.
//
// ============================================================================
// SMALL CROSS-FILE FUNCTIONS PORTED HERE FOR REAL (not stubbed)
// ============================================================================
// Several functions g_items.cpp calls are declared in OTHER .cpp files (not
// g_items.cpp itself) but are small, self-contained, and either
// unconditionally reachable from a Touch_Item/SpawnItem call every real
// pickup/spawn exercises, or trivially portable with the types already
// available in this port line. Per PORTING.md's precedent (already invoked
// by g_combat.ts for ArmorIndex/PowerArmorType): ported for real, with a
// citation to their true C++ home, rather than left as a throwing stub that
// would break the common case:
//   - ValidateSelectedItem (g_cmds.cpp:90) + SelectNextItem (g_cmds.cpp:6):
//     Touch_Item calls ValidateSelectedItem unconditionally on every
//     pickup. SelectNextItem's `menu`/chase-target branches (PMenu_Next/
//     ChaseNext) are stubbed but PROVABLY unreachable from here:
//     ValidateSelectedItem always calls `SelectNextItem(ent, IF_ANY, false)`
//     with menu=false, and both branches are guarded by `if (menu && ...)`.
//   - CTFHasRegeneration (ctf/g_ctf.cpp:2125): a two-line inventory check,
//     reached by Pickup_Health/MegaHealth_think on every mega-health pickup.
//   - Pickup_Nuke/Use_IR/Use_Double/Pickup_Doppleganger (all
//     rogue/g_rogue_items.cpp): each is pure inventory/cvar/timer logic with
//     no further cross-deps. Only their sibling Use_Nuke/Use_Doppleganger
//     (which call fire_nuke/FindSpawnPoint+CheckGroundSpawnPoint+
//     SpawnGrow_Spawn+fire_doppleganger -- genuinely complex spawning code)
//     stay stubs.
//   - Pickup_Sphere + Use_Defender/Use_Hunter/Use_Vengeance (all
//     rogue/g_rogue_items.cpp): the owned_sphere guard + inventory decrement
//     wrapper logic is ported for real; only the actual
//     Defender_Launch/Hunter_Launch/Vengeance_Launch calls
//     (rogue/g_rogue_sphere.cpp:684/694/704, which spawn a whole new sphere
//     entity) stay stubs.
//   - SetTriggeredSpawn + Item_TriggeredSpawn (both
//     rogue/g_rogue_items.cpp:217/191): SpawnItem calls SetTriggeredSpawn
//     unconditionally for every SPAWNFLAG_ITEM_TRIGGER_SPAWN item, and both
//     functions are small and self-contained (droptofloor, AngleVectors,
//     spawnflags -- everything already available in this file).
//
// ============================================================================
// STUB INVENTORY (throwing, cited to their real C++ home)
// ============================================================================
// Weapon system (p_weapon.cpp / rogue's p_rogue_weapon.cpp / xatrix's
// p_xatrix_weapon.cpp -- none ported anywhere in this port line yet):
// Pickup_Weapon, Use_Weapon, Drop_Weapon, Weapon_Blaster, Weapon_Shotgun,
// Weapon_SuperShotgun, Weapon_Machinegun, Weapon_Chaingun,
// Weapon_HyperBlaster, Weapon_RocketLauncher, Weapon_Grenade,
// Weapon_GrenadeLauncher, Weapon_Railgun, Weapon_BFG, Weapon_ChainFist,
// Weapon_Disintegrator, Weapon_ETF_Rifle, Weapon_Heatbeam, Weapon_Tesla,
// Weapon_ProxLauncher, Weapon_Ionripper, Weapon_Phalanx, Weapon_Trap,
// CTFWeapon_Grapple (ctf/g_ctf.cpp:1453).
// Rogue spawning/effects (genuinely complex, not ported anywhere yet):
// Use_Nuke (needs rogue/g_rogue_newweap.cpp:770 fire_nuke), Use_Doppleganger
// (needs rogue/g_rogue_spawn.cpp FindSpawnPoint/CheckGroundSpawnPoint/
// SpawnGrow_Spawn + rogue/g_rogue_newdm.cpp:242 fire_doppleganger),
// Defender_Launch/Hunter_Launch/Vengeance_Launch (rogue/g_rogue_sphere.cpp).
// CTF (ctf/g_ctf.cpp, not ported anywhere yet): CTFPickup_Flag, CTFDrop_Flag,
// CTFPickup_Tech, CTFDrop_Tech, CTFFlagSetup.
// Rogue misc: Tag_PickupToken (rogue/rogue_dm_tag.cpp:113), DoRandomRespawn
// (rogue/g_rogue_newdm.cpp:126, guarded by g_dm_random_items, default off).
// Established precedent (matches p_hud.ts's/g_target.ts's own copies):
// P_UseCoopInstancedItems (p_client.cpp:90, guarded by coop, default off).
// Menu/chase (guarded unreachable from this file, see above): PMenu_Next,
// ChaseNext.
//
// ============================================================================
// Compass_Update / Use_Compass -- NOT ported (type-shape gap, not a TODO)
// ============================================================================
// g_local_types.ts's LevelLocalsT.poi_points is typed `(Vec3 | null)[]` (one
// point per player slot), but g_items.cpp:1499-1624 needs
// `vec3_t *poi_points[MAX_SPLIT_PLAYERS]` -- a heap-allocated PER-PLAYER
// ARRAY of up to MAX_TEMP_POI_POINTS+1 points, indexed and pointer-
// arithmetic'd throughout Compass_Update and Use_Compass (`points[i]`,
// `points + 1`, `request.pathPoints.array = points + 1`). Reshaping that
// field is outside this unit's file scope (g_items.ts + g_monster.ts/
// g_trigger.ts stub swaps + test file only). p_view.ts's own header already
// anticipated this exact gap for its own (unreachable) Compass_Update call
// site and confirmed level.poi_points is never populated anywhere in this
// port line -- so both functions are unreachable by any real call path
// today either way. Ported as throwing stubs citing this type-shape gap,
// not silently truncated to "one point" (which would silently change
// compass pathing behavior the moment poi_points ever gets populated).
//
// ============================================================================
// QUIRKS (bug-for-bug, not "fixed")
// ============================================================================
// - FindItem's parameter is named `pickup_name` but the C++ body actually
//   matches against each item's `use_name` field (e.g. "Body Armor", never
//   the localized "$item_body_armor" string) -- verified against
//   g_items.cpp:103-118 twice. Preserved exactly, including the misleading
//   parameter name in this port's own doc comment.
// - item_health_large's `pickup_name` and `pickup_name_definite` are BOTH
//   literally "$item_large_medkit" in the C++ source (g_items.cpp:3657-3658)
//   -- not a typo introduced here, the definite-article variant is simply
//   missing its own string upstream. Preserved exactly.
// - Several itemlist entries' inline `/* fieldname */` comments do not match
//   the field they actually initialize (e.g. item_adrenaline's
//   `/* precache */ "items/n_health.wav"` -- singular, missing the plural
//   `precaches` field name). The C++ struct literals are POSITIONAL
//   (aggregate initialization), not C++20 designated initializers, so the
//   compiler never checks the comment text against anything -- only
//   position matters. This port uses named object-literal keys instead
//   (`mkItem({ ..., precaches: "items/n_health.wav" })`), so the comment
//   typo has zero effect here either way; there is no behavioral bug to
//   preserve, just documentation noise in the upstream source.
// - PowerArmorType/ArmorIndex/G_CheckPowerArmor bypass GetItemByIndex
//   entirely for armor_info lookups (see g_combat.ts's own identical note);
//   this file's Pickup_Armor uses the same direct
//   jacketarmor_info/combatarmor_info/bodyarmor_info constants g_combat.ts
//   already established, for the same reason (ArmorIndex can only ever
//   return JACKET/COMBAT/BODY/NULL).
//
// ============================================================================
// SAVE-REGISTERED FUNCTIONS (via g_save_registry.ts)
// ============================================================================
// THINK: DoRespawn, MegaHealth_think, drop_make_touchable, droptofloor.
// TOUCH: Touch_Item, drop_temp_touch.
// USE: Use_Item, Item_TriggeredSpawn.
// Per g_local_types.ts's own note, the GitemT function-pointer fields
// (pickup/use/drop/weaponthink) are NOT part of the save registry -- items
// are re-resolved by id, never serialized as raw function references -- so
// none of Pickup_*/Use_*/Drop_*/Weapon_* is registered.

import { type Vec3, vec3, VectorCopy } from "../shared/math";
import {
  ATTN_NORM,
  ATTN_STATIC,
  ContentsT,
  CvarFlagsT,
  EffectsT,
  KexEntityEventT,
  type KexTraceT,
  MASK_SOLID,
  MAX_QPATH,
  MAX_WHEEL_ITEMS,
  CS_ITEMS,
  CS_WHEEL_AMMO,
  CS_WHEEL_WEAPONS,
  CS_WHEEL_POWERUPS,
  PrintTypeT,
  RenderfxT,
  SoundchanT,
  SolidT,
  SvflagsT,
} from "../kexapi/game";
import {
  type EdictT,
  type GClientT,
  type GitemT,
  type GitemArmorT,
  type GitemPickupFn,
  type GitemUseFn,
  type GitemDropFn,
  type GitemWeaponthinkFn,
  ItemIdT,
  ItemFlagsT,
  AmmoT,
  PowerupT,
  AutoSwitchT,
  HEALTH_IGNORE_MAX,
  HEALTH_TIMED,
  jacketarmor_info,
  combatarmor_info,
  bodyarmor_info,
  AUTO_SHIELD_AUTO,
  AUTO_SHIELD_MANUAL,
  StuckResultT,
  EntFlagsT,
  MovetypeT,
  SELECTED_ITEM_TIME,
  SPAWNFLAG_ITEM_TRIGGER_SPAWN,
  SPAWNFLAG_ITEM_NO_TOUCH,
  SPAWNFLAG_ITEM_TOSS_SPAWN,
  SPAWNFLAG_ITEM_MAX,
  SPAWNFLAG_ITEM_DROPPED,
  SPAWNFLAG_ITEM_DROPPED_PLAYER,
  SPAWNFLAG_ITEM_TARGETS_USED,
  SPAWNFLAG_EDITOR_MASK,
} from "./g_local";
import { gi, g_edicts, level } from "./g_main_globals";
import { type GTime, GTIME_ZERO, Gtime_from_ms, Gtime_from_sec, Gtime_from_hz, Gtime_add, Gtime_subtract, Gtime_nonzero } from "./gtime";
import { type SpawnFlags, SPAWNFLAGS_NONE, SpawnFlags_from, SpawnFlags_has, SpawnFlags_or, SpawnFlags_and, SpawnFlags_value } from "./spawnflags";
import { G_Spawn, G_FreeEdict, G_UseTargets, G_PrintActivationMessage } from "./g_utils";
import { AngleVectors, G_ProjectSource, vec3_add, vec3_muls } from "./q_vec3";
import { RegisterThink, RegisterTouch, RegisterUse, type ThinkFn, type TouchFn, type UseFn } from "./g_save_registry";
import { ArmorIndex, PowerArmorType } from "./g_combat";
import { G_FixStuckObject } from "./g_monster";
import { irandom } from "./q_std";

export { ArmorIndex, PowerArmorType };

// ---------------------------------------------------------------------------
// cvar-read helpers -- same idiom as g_combat.ts's own cvarInt/cvarBool
// ---------------------------------------------------------------------------

function cvarInt(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): number {
  const c = gi.cvar(name, def, flags);
  return c === null ? Math.trunc(Number(def)) : Math.trunc(c.value);
}

function cvarBool(name: string, def: string, flags: CvarFlagsT = CvarFlagsT.CVAR_NOFLAGS): boolean {
  return cvarInt(name, def, flags) !== 0;
}

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/** GTime is a branded number (see gtime.ts); `Math.max` would widen it back
 *  to plain `number`, so a tiny local max avoids that without a cast. */
function GTmax(a: GTime, b: GTime): GTime {
  return a >= b ? a : b;
}

/** g_local.h:3534-3549's `fmt::formatter<edict_t>` local copy -- see
 *  g_misc.ts's own identical `edictFmt` and its header note on why this
 *  isn't shared via a common module. */
function edictFmt(ent: EdictT): string {
  const p = ent.linked ? vec3_muls(vec3_add(ent.absmax, ent.absmin), 0.5) : ent.s.origin;
  return `${ent.classname} @ (${p[0]} ${p[1]} ${p[2]})`;
}

/** `gi.LocClient_Print` (g_local.h) has no ported counterpart -- this port
 *  line's `gi` only has `Client_Print` (no localization backend anywhere in
 *  this port), and every call site below passes a `$`-prefixed loc key with
 *  no format arguments. Thin pass-through, matching the "no localization
 *  backend, pass the key through as-is" treatment this codebase has not yet
 *  needed to deviate from anywhere else. */
function LocClient_Print(ent: EdictT, printlevel: PrintTypeT, message: string): void {
  gi.Client_Print(ent, printlevel, message);
}

/** Several functions below dereference `ent->item` unconditionally in the
 *  C++ source (only ever called once `ent->item` is known-set, e.g. via
 *  Touch_Item after `ent->item->pickup(...)`). Ported as an explicit
 *  runtime throw on the invariant violation, matching this codebase's
 *  established "throw, don't silently narrow with `!`" precedent (see
 *  g_monster.ts's M_ProcessPain header note for the same pattern). */
function requireItem(ent: EdictT, fnName: string): GitemT {
  if (ent.item === null) {
    throw new Error(`${fnName}: called against an entity with no .item set (${ent.classname ?? "?"}) -- the C++ source dereferences ent->item unconditionally here`);
  }
  return ent.item;
}

/** Same idiom as requireItem, for the equally-unconditional `->client`
 *  dereferences below. */
function requireClient(ent: EdictT, fnName: string): GClientT {
  if (ent.client === null) {
    throw new Error(`${fnName}: called against a non-client entity (${ent.classname ?? "?"}) -- the C++ source dereferences ->client unconditionally here`);
  }
  return ent.client;
}

// player_stat_t indices Touch_Item/SelectNextItem touch -- see file header
// "CROSS-DEPENDENCIES ALREADY LANDED ELSEWHERE" for why these are local
// numeric constants instead of an import of p_hud.ts's own PlayerStatT.
const STAT_PICKUP_ICON = 7;
const STAT_PICKUP_STRING = 8;
const STAT_SELECTED_ITEM = 12;
const STAT_SELECTED_ITEM_NAME = 51;

// ---------------------------------------------------------------------------
// throwing stubs -- weapon system (p_weapon.cpp / rogue / xatrix) -- see
// file header "STUB INVENTORY"
// ---------------------------------------------------------------------------

function Pickup_Weapon(_ent: EdictT, _other: EdictT): boolean {
  throw new Error("Pickup_Weapon: not yet ported (pending p_weapon.ts, see p_weapon.cpp:241)");
}
function Use_Weapon(_ent: EdictT, _item: GitemT): void {
  throw new Error("Use_Weapon: not yet ported (pending p_weapon.ts, see p_weapon.cpp:585)");
}
function Drop_Weapon(_ent: EdictT, _item: GitemT): void {
  throw new Error("Drop_Weapon: not yet ported (pending p_weapon.ts, see p_weapon.cpp:636)");
}
function Weapon_Blaster(_ent: EdictT): void {
  throw new Error("Weapon_Blaster: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1363)");
}
function Weapon_Shotgun(_ent: EdictT): void {
  throw new Error("Weapon_Shotgun: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1719)");
}
function Weapon_SuperShotgun(_ent: EdictT): void {
  throw new Error("Weapon_SuperShotgun: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1767)");
}
function Weapon_Machinegun(_ent: EdictT): void {
  throw new Error("Weapon_Machinegun: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1541)");
}
function Weapon_Chaingun(_ent: EdictT): void {
  throw new Error("Weapon_Chaingun: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1669)");
}
function Weapon_HyperBlaster(_ent: EdictT): void {
  throw new Error("Weapon_HyperBlaster: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1444)");
}
function Weapon_RocketLauncher(_ent: EdictT): void {
  throw new Error("Weapon_RocketLauncher: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1310)");
}
function Weapon_Grenade(_ent: EdictT): void {
  throw new Error("Weapon_Grenade: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1215)");
}
function Weapon_GrenadeLauncher(_ent: EdictT): void {
  throw new Error("Weapon_GrenadeLauncher: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1262)");
}
function Weapon_Railgun(_ent: EdictT): void {
  throw new Error("Weapon_Railgun: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1824)");
}
function Weapon_BFG(_ent: EdictT): void {
  throw new Error("Weapon_BFG: not yet ported (pending p_weapon.ts, see p_weapon.cpp:1889)");
}
function Weapon_ChainFist(_ent: EdictT): void {
  throw new Error("Weapon_ChainFist: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:148)");
}
function Weapon_Disintegrator(_ent: EdictT): void {
  throw new Error("Weapon_Disintegrator: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:250)");
}
function Weapon_ETF_Rifle(_ent: EdictT): void {
  throw new Error("Weapon_ETF_Rifle: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:345)");
}
function Weapon_Heatbeam(_ent: EdictT): void {
  throw new Error("Weapon_Heatbeam: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:441)");
}
function Weapon_Tesla(_ent: EdictT): void {
  throw new Error("Weapon_Tesla: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:53)");
}
function Weapon_ProxLauncher(_ent: EdictT): void {
  throw new Error("Weapon_ProxLauncher: not yet ported (pending p_rogue_weapon.ts, see rogue/p_rogue_weapon.cpp:28)");
}
function Weapon_Ionripper(_ent: EdictT): void {
  throw new Error("Weapon_Ionripper: not yet ported (pending p_xatrix_weapon.ts, see xatrix/p_xatrix_weapon.cpp:45)");
}
function Weapon_Phalanx(_ent: EdictT): void {
  throw new Error("Weapon_Phalanx: not yet ported (pending p_xatrix_weapon.ts, see xatrix/p_xatrix_weapon.cpp:121)");
}
function Weapon_Trap(_ent: EdictT): void {
  throw new Error("Weapon_Trap: not yet ported (pending p_xatrix_weapon.ts, see xatrix/p_xatrix_weapon.cpp:160)");
}
function CTFWeapon_Grapple(_ent: EdictT): void {
  throw new Error("CTFWeapon_Grapple: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1453)");
}

// ---------------------------------------------------------------------------
// throwing stubs -- rogue spawning/effects, CTF, misc -- see file header
// "STUB INVENTORY"
// ---------------------------------------------------------------------------

function Use_Nuke(_ent: EdictT, _item: GitemT): void {
  throw new Error(
    "Use_Nuke: not yet ported (pending g_rogue_newweap.ts, see rogue/g_rogue_newweap.cpp:770's fire_nuke -- rogue/g_rogue_items.cpp:51's own body is otherwise trivial)",
  );
}
function Use_Doppleganger(_ent: EdictT, _item: GitemT): void {
  throw new Error(
    "Use_Doppleganger: not yet ported (pending g_rogue_spawn.ts/g_rogue_newdm.ts -- needs FindSpawnPoint (rogue/g_rogue_spawn.cpp:79), CheckGroundSpawnPoint (rogue/g_rogue_spawn.cpp:139), SpawnGrow_Spawn (rogue/g_rogue_spawn.cpp:200), fire_doppleganger (rogue/g_rogue_newdm.cpp:242))",
  );
}
function Defender_Launch(_self: EdictT): void {
  throw new Error("Defender_Launch: not yet ported (pending g_rogue_sphere.ts, see rogue/g_rogue_sphere.cpp:684)");
}
function Hunter_Launch(_self: EdictT): void {
  throw new Error("Hunter_Launch: not yet ported (pending g_rogue_sphere.ts, see rogue/g_rogue_sphere.cpp:694)");
}
function Vengeance_Launch(_self: EdictT): void {
  throw new Error("Vengeance_Launch: not yet ported (pending g_rogue_sphere.ts, see rogue/g_rogue_sphere.cpp:704)");
}
function Tag_PickupToken(_ent: EdictT, _other: EdictT): boolean {
  throw new Error("Tag_PickupToken: not yet ported (pending g_rogue_dm_tag.ts, see rogue/rogue_dm_tag.cpp:113)");
}
function CTFPickup_Flag(_ent: EdictT, _other: EdictT): boolean {
  throw new Error("CTFPickup_Flag: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:640)");
}
function CTFDrop_Flag(_ent: EdictT, _item: GitemT): void {
  throw new Error("CTFDrop_Flag: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:818)");
}
function CTFPickup_Tech(_ent: EdictT, _other: EdictT): boolean {
  throw new Error("CTFPickup_Tech: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1838)");
}
function CTFDrop_Tech(_ent: EdictT, _item: GitemT): void {
  throw new Error("CTFDrop_Tech: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:1881)");
}
function CTFFlagSetup(self: EdictT): void {
  throw new Error(`CTFFlagSetup: not yet ported (pending g_ctf.ts, see ctf/g_ctf.cpp:833) -- called against ${self.classname ?? "?"}`);
}
function DoRandomRespawn(_ent: EdictT): ItemIdT {
  throw new Error("DoRandomRespawn: not yet ported (pending g_rogue_newdm.ts, see rogue/g_rogue_newdm.cpp:126) -- only reached when g_dm_random_items is set (default off)");
}
function P_UseCoopInstancedItems(): boolean {
  throw new Error("P_UseCoopInstancedItems: not yet ported (pending p_client.ts, see p_client.cpp:90) -- only reached when coop is set (default off)");
}
function PMenu_Next(_ent: EdictT): void {
  throw new Error(
    "PMenu_Next: not yet ported (pending p_ctf_menu.ts, see ctf/p_ctf_menu.cpp) -- only reached when SelectNextItem/SelectPrevItem is called with menu=true and the client has an open menu; ValidateSelectedItem (this file's only caller) always passes menu=false, so this is unreachable from here",
  );
}
function ChaseNext(_ent: EdictT): void {
  throw new Error("ChaseNext: not yet ported (pending p_hud.ts/g_chase.cpp) -- same unreachable-from-here guard as PMenu_Next above");
}

/** ctf/g_ctf.h's `extern ctfgame_t ctfgame;`-backed match-setup gate, read
 *  unconditionally by Touch_Item. Matches g_combat.ts's own identical
 *  `CTFMatchSetup` (same reasoning: a rogue/CTF match-setup controller that
 *  only sets this true during its own pre-round setup; no server this port
 *  line can currently simulate ever reaches that controller, so `false` is
 *  the faithful, always-correct answer). Not a stub -- a concrete, correct
 *  value for every server this port line can run today. */
function CTFMatchSetup(): boolean {
  return false;
}

/** g_items.cpp:1499-1624 -- see file header "Compass_Update / Use_Compass". */
export function Compass_Update(_ent: EdictT, _first: boolean): void {
  throw new Error(
    "Compass_Update: not ported -- g_local_types.ts's LevelLocalsT.poi_points is typed (Vec3 | null)[] (one point per player slot), but g_items.cpp needs vec3_t *poi_points[MAX_SPLIT_PLAYERS] (a heap-allocated per-player ARRAY of up to MAX_TEMP_POI_POINTS+1 points, pointer-arithmetic'd throughout this function and Use_Compass). Reshaping that field is outside this unit's file scope; p_view.ts's own header already confirmed level.poi_points is never populated anywhere in this port line, so this is unreachable today either way.",
  );
}

/** g_items.cpp:1546 (`static`) -- see Compass_Update's own citation above. */
function Use_Compass(_ent: EdictT, _inv: GitemT): void {
  throw new Error("Use_Compass: not ported -- see Compass_Update's own citation just above (same LevelLocalsT.poi_points type-shape gap)");
}

// ---------------------------------------------------------------------------
// small cross-file functions ported for real -- see file header
// "SMALL CROSS-FILE FUNCTIONS PORTED HERE FOR REAL"
// ---------------------------------------------------------------------------

/** g_items.cpp:306: `void G_CheckPowerArmor(edict_t *ent)`. Transcribed
 *  directly from the C++ source (see file header note on why this is not
 *  imported from g_combat.ts's own unexported copy). */
export function G_CheckPowerArmor(ent: EdictT): void {
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
  } else {
    if (
      client.pers.autoshield !== AUTO_SHIELD_MANUAL &&
      has_enough_cells &&
      (client.pers.inventory[ItemIdT.IT_ITEM_POWER_SCREEN] !== 0 || client.pers.inventory[ItemIdT.IT_ITEM_POWER_SHIELD] !== 0)
    ) {
      ent.flags |= EntFlagsT.FL_POWER_ARMOR;
      gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
    }
  }
}

/** p_weapon.cpp:25-31: `[Kex] bool G_CheckInfiniteAmmo(gitem_t *item)`. See
 *  file header for why this is a local copy, not an import from p_hud.ts. */
function G_CheckInfiniteAmmo(item: GitemT): boolean {
  if ((item.flags & ItemFlagsT.IF_NO_INFINITE_AMMO) !== 0) return false;
  return cvarBool("g_infinite_ammo", "0", CvarFlagsT.CVAR_LATCH) || (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_instagib", "0", CvarFlagsT.CVAR_NOFLAGS));
}

/** ctf/g_ctf.cpp:2125: `bool CTFHasRegeneration(edict_t *ent)`. */
export function CTFHasRegeneration(ent: EdictT): boolean {
  return ent.client !== null && ent.client.pers.inventory[ItemIdT.IT_TECH_REGENERATION] !== 0;
}

/** g_cmds.cpp:6: `void SelectNextItem(edict_t *ent, item_flags_t itflags, bool menu = true)`. */
export function SelectNextItem(ent: EdictT, itflags: ItemFlagsT, menu = true): void {
  const client = requireClient(ent, "SelectNextItem");

  if (menu && client.menu !== null) {
    PMenu_Next(ent);
    return;
  } else if (menu && client.chase_target !== null) {
    ChaseNext(ent);
    return;
  }

  for (let i = ItemIdT.IT_NULL + 1; i <= ItemIdT.IT_TOTAL; i++) {
    const index = (client.pers.selected_item + i) % ItemIdT.IT_TOTAL;
    if (client.pers.inventory[index] === 0) continue;
    const it = itemlist[index]!;
    if (it.use === null) continue;
    if ((it.flags & itflags) === 0) continue;

    client.pers.selected_item = index;
    client.pers.selected_item_time = Gtime_add(level.time, SELECTED_ITEM_TIME);
    client.ps.stats[STAT_SELECTED_ITEM_NAME] = CS_ITEMS + index;
    return;
  }

  client.pers.selected_item = ItemIdT.IT_NULL;
}

/** g_cmds.cpp:90: `void ValidateSelectedItem(edict_t *ent)`. */
export function ValidateSelectedItem(ent: EdictT): void {
  const client = requireClient(ent, "ValidateSelectedItem");
  if (client.pers.inventory[client.pers.selected_item] !== 0) return;
  SelectNextItem(ent, ItemFlagsT.IF_ANY, false);
}

/** rogue/g_rogue_items.cpp:8: `bool Pickup_Nuke(edict_t *ent, edict_t *other)`. */
function Pickup_Nuke(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Nuke");
  const client = requireClient(other, "Pickup_Nuke");
  const quantity = client.pers.inventory[item.id];
  if (quantity >= 1) return false;

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && !P_UseCoopInstancedItems() && (item.flags & ItemFlagsT.IF_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[item.id]++;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      SetRespawn(ent, Gtime_from_sec(item.quantity));
    }
  }

  return true;
}

/** rogue/g_rogue_items.cpp:33: `void Use_IR(edict_t *ent, gitem_t *item)`. */
function Use_IR(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_IR");
  client.pers.inventory[item.id]--;
  client.ir_time = Gtime_add(GTmax(level.time, client.ir_time), Gtime_from_sec(60));
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("misc/ir_start.wav"), 1, ATTN_NORM, 0);
}

/** rogue/g_rogue_items.cpp:42: `void Use_Double(edict_t *ent, gitem_t *item)`. */
function Use_Double(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Double");
  client.pers.inventory[item.id]--;
  client.double_time = Gtime_add(GTmax(level.time, client.double_time), Gtime_from_sec(30));
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("misc/ddamage1.wav"), 1, ATTN_NORM, 0);
}

/** rogue/g_rogue_items.cpp:90: `bool Pickup_Doppleganger(edict_t *ent, edict_t *other)`. */
function Pickup_Doppleganger(ent: EdictT, other: EdictT): boolean {
  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) return false;

  const item = requireItem(ent, "Pickup_Doppleganger");
  const client = requireClient(other, "Pickup_Doppleganger");
  const quantity = client.pers.inventory[item.id];
  if (quantity >= 1) return false;

  client.pers.inventory[item.id]++;

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
    SetRespawn(ent, Gtime_from_sec(item.quantity));
  }

  return true;
}

/** rogue/g_rogue_items.cpp:109: `bool Pickup_Sphere(edict_t *ent, edict_t *other)`. */
function Pickup_Sphere(ent: EdictT, other: EdictT): boolean {
  if (other.client !== null && other.client.owned_sphere !== null) return false;

  const item = requireItem(ent, "Pickup_Sphere");
  const client = requireClient(other, "Pickup_Sphere");
  const quantity = client.pers.inventory[item.id];
  const skillInt = cvarInt("skill", "1", CvarFlagsT.CVAR_LATCH);
  if ((skillInt === 1 && quantity >= 2) || (skillInt >= 2 && quantity >= 1)) return false;

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && !P_UseCoopInstancedItems() && (item.flags & ItemFlagsT.IF_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[item.id]++;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      SetRespawn(ent, Gtime_from_sec(item.quantity));
    }
    if (cvarBool("g_dm_instant_items", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.use !== null) item.use(other, item);
      else gi.Com_Print("Powerup has no use function!\n");
    }
  }

  return true;
}

/** rogue/g_rogue_items.cpp:146: `void Use_Defender(edict_t *ent, gitem_t *item)`. */
function Use_Defender(ent: EdictT, item: GitemT): void {
  if (ent.client !== null && ent.client.owned_sphere !== null) {
    LocClient_Print(ent, PrintTypeT.PRINT_HIGH, "$g_only_one_sphere_time");
    return;
  }
  const client = requireClient(ent, "Use_Defender");
  client.pers.inventory[item.id]--;
  Defender_Launch(ent);
}

/** rogue/g_rogue_items.cpp:159: `void Use_Hunter(edict_t *ent, gitem_t *item)`. */
function Use_Hunter(ent: EdictT, item: GitemT): void {
  if (ent.client !== null && ent.client.owned_sphere !== null) {
    LocClient_Print(ent, PrintTypeT.PRINT_HIGH, "$g_only_one_sphere_time");
    return;
  }
  const client = requireClient(ent, "Use_Hunter");
  client.pers.inventory[item.id]--;
  Hunter_Launch(ent);
}

/** rogue/g_rogue_items.cpp:172: `void Use_Vengeance(edict_t *ent, gitem_t *item)`. */
function Use_Vengeance(ent: EdictT, item: GitemT): void {
  if (ent.client !== null && ent.client.owned_sphere !== null) {
    LocClient_Print(ent, PrintTypeT.PRINT_HIGH, "$g_only_one_sphere_time");
    return;
  }
  const client = requireClient(ent, "Use_Vengeance");
  client.pers.inventory[item.id]--;
  Vengeance_Launch(ent);
}

// ---------------------------------------------------------------------------
// GetItemByIndex / GetItemByAmmo / GetItemByPowerup / FindItemByClassname /
// FindItem (g_items.cpp:52-118)
// ---------------------------------------------------------------------------

/** g_items.cpp:52: `gitem_t *GetItemByIndex(item_id_t index)`. */
export function GetItemByIndex(index: ItemIdT): GitemT | null {
  if (index <= ItemIdT.IT_NULL || index >= ItemIdT.IT_TOTAL) return null;
  return itemlist[index] ?? null;
}

const ammolist: (GitemT | null)[] = new Array(AmmoT.AMMO_MAX).fill(null);
const poweruplist: (GitemT | null)[] = new Array(PowerupT.POWERUP_MAX).fill(null);

/** g_items.cpp:62: `gitem_t *GetItemByAmmo(ammo_t ammo)`. Only populated
 *  once InitItems() has run (matching the C++ source's own
 *  init-before-use requirement -- itemlist/ammolist/poweruplist are game
 *  bootstrap state, not something this module auto-initializes on import). */
export function GetItemByAmmo(ammo: AmmoT): GitemT | null {
  return ammolist[ammo] ?? null;
}

/** g_items.cpp:69: `gitem_t *GetItemByPowerup(powerup_t powerup)`. See
 *  GetItemByAmmo's own note on InitItems() being required first. */
export function GetItemByPowerup(powerup: PowerupT): GitemT | null {
  return poweruplist[powerup] ?? null;
}

/** g_items.cpp:80: `gitem_t *FindItemByClassname(const char *classname)`. */
export function FindItemByClassname(classname: string): GitemT | null {
  const needle = classname.toLowerCase();
  for (const it of itemlist) {
    if (it.classname === null) continue;
    if (it.classname.toLowerCase() === needle) return it;
  }
  return null;
}

/** g_items.cpp:103: `gitem_t *FindItem(const char *pickup_name)`. NOTE: the
 *  C++ parameter is named `pickup_name` but the body actually matches
 *  against each item's `use_name` field -- see file header "QUIRKS".
 *  Preserved exactly, including the misleading parameter name. */
export function FindItem(pickup_name: string): GitemT | null {
  const needle = pickup_name.toLowerCase();
  for (const it of itemlist) {
    if (it.use_name === null) continue;
    if (it.use_name.toLowerCase() === needle) return it;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DoRespawn / SetRespawn (g_items.cpp:122-198)
// ---------------------------------------------------------------------------

export const DoRespawn: ThinkFn = RegisterThink("DoRespawn", (entIn: EdictT): void => {
  let ent = entIn;

  if (ent.team !== null) {
    const master = ent.teammaster;
    if (master === null) throw new Error("DoRespawn: ent.team is set but ent.teammaster is null");

    if (
      cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH) &&
      cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS) &&
      master.item !== null &&
      (master.item.flags & ItemFlagsT.IF_WEAPON) !== 0
    ) {
      ent = master;
    } else {
      ent.svflags |= SvflagsT.SVF_NOCLIENT;
      ent.solid = SolidT.SOLID_NOT;
      gi.linkentity(ent);

      let count = 0;
      let e: EdictT | null = master;
      while (e !== null) {
        count++;
        e = e.chain;
      }

      const choice = irandom(count);

      count = 0;
      e = master;
      while (count < choice) {
        if (e === null) throw new Error("DoRespawn: chain walked past its own length");
        e = e.chain;
        count++;
      }
      ent = e ?? master;
    }
  }

  ent.svflags &= ~SvflagsT.SVF_NOCLIENT;
  ent.svflags &= ~SvflagsT.SVF_RESPAWNING;
  ent.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(ent);

  ent.s.event = KexEntityEventT.EV_ITEM_RESPAWN;

  if (cvarBool("g_dm_random_items", "0", CvarFlagsT.CVAR_NOFLAGS)) {
    const new_item = DoRandomRespawn(ent);

    if (new_item !== ItemIdT.IT_NULL) {
      const item = GetItemByIndex(new_item);
      if (item === null) throw new Error("DoRespawn: DoRandomRespawn returned an out-of-range item id");

      ent.item = item;
      ent.classname = item.classname;
      ent.s.effects = item.world_model_flags;
      gi.setmodel(ent, item.world_model ?? "");
    }
  }
});

/** g_items.cpp:181: `void SetRespawn(edict_t *ent, gtime_t delay, bool
 *  hide_self = true)`. */
export function SetRespawn(ent: EdictT, delay: GTime, hide_self = true): void {
  if (ent.think === DoRespawn && ent.nextthink >= level.time) return;

  ent.flags |= EntFlagsT.FL_RESPAWN;

  if (hide_self) {
    ent.svflags |= SvflagsT.SVF_NOCLIENT | SvflagsT.SVF_RESPAWNING;
    ent.solid = SolidT.SOLID_NOT;
    gi.linkentity(ent);
  }

  ent.nextthink = Gtime_add(level.time, delay);
  ent.think = DoRespawn;
}

// ---------------------------------------------------------------------------
// IsInstantItemsEnabled / Pickup_Powerup / Pickup_General / Drop_General
// (g_items.cpp:202-278)
// ---------------------------------------------------------------------------

function IsInstantItemsEnabled(): boolean {
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_dm_instant_items", "0", CvarFlagsT.CVAR_NOFLAGS)) return true;
  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && level.instantitems) return true;
  return false;
}

export function Pickup_Powerup(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Powerup");
  const client = requireClient(other, "Pickup_Powerup");

  const quantity = client.pers.inventory[item.id];
  const skillInt = cvarInt("skill", "1", CvarFlagsT.CVAR_LATCH);
  if ((skillInt === 0 && quantity >= 3) || (skillInt === 1 && quantity >= 2) || (skillInt >= 2 && quantity >= 1)) return false;

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && !P_UseCoopInstancedItems() && (item.flags & ItemFlagsT.IF_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[item.id]++;

  const is_dropped_from_death = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER) && !SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED);

  if (IsInstantItemsEnabled() || (item.use === Use_Quad && is_dropped_from_death) || (item.use === Use_QuadFire && is_dropped_from_death)) {
    if (item.use === Use_Quad && is_dropped_from_death) {
      quad_drop_timeout_hack = Gtime_subtract(ent.nextthink, level.time);
    } else if (item.use === Use_QuadFire && is_dropped_from_death) {
      quad_fire_drop_timeout_hack = Gtime_subtract(ent.nextthink, level.time);
    }

    if (item.use !== null) item.use(other, item);
  }

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && !is_dropped_from_death) {
      SetRespawn(ent, Gtime_from_sec(item.quantity));
    }
  }

  return true;
}

export function Pickup_General(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_General");
  const client = requireClient(other, "Pickup_General");

  if (client.pers.inventory[item.id] !== 0) return false;

  client.pers.inventory[item.id]++;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      SetRespawn(ent, Gtime_from_sec(item.quantity));
    }
  }

  return true;
}

export function Drop_General(ent: EdictT, item: GitemT): void {
  const dropped = Drop_Item(ent, item);
  dropped.spawnflags = SpawnFlags_or(dropped.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
  dropped.svflags &= ~SvflagsT.SVF_INSTANCED;
  const client = requireClient(ent, "Drop_General");
  client.pers.inventory[item.id]--;
}

// ---------------------------------------------------------------------------
// Use_Adrenaline / Pickup_LegacyHead (g_items.cpp:282-304)
// ---------------------------------------------------------------------------

export function Use_Adrenaline(ent: EdictT, item: GitemT): void {
  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) ent.max_health += 1;

  if (ent.health < ent.max_health) ent.health = ent.max_health;

  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/n_health.wav"), 1, ATTN_NORM, 0);

  const client = requireClient(ent, "Use_Adrenaline");
  client.pers.inventory[item.id]--;
}

export function Pickup_LegacyHead(ent: EdictT, other: EdictT): boolean {
  other.max_health += 5;
  other.health += 5;

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    const item = requireItem(ent, "Pickup_LegacyHead");
    SetRespawn(ent, Gtime_from_sec(item.quantity));
  }

  return true;
}

// ---------------------------------------------------------------------------
// G_AddAmmoAndCap / G_AddAmmoAndCapQuantity / G_AdjustAmmoCap
// (g_items.cpp:339-362) -- `inline`, file-local in the C++ source too
// ---------------------------------------------------------------------------

function G_AddAmmoAndCap(other: EdictT, item: ItemIdT, max: number, quantity: number): boolean {
  const client = requireClient(other, "G_AddAmmoAndCap");
  if (client.pers.inventory[item] >= max) return false;

  client.pers.inventory[item] += quantity;
  if (client.pers.inventory[item] > max) client.pers.inventory[item] = max;

  G_CheckPowerArmor(other);

  return true;
}

function G_AddAmmoAndCapQuantity(other: EdictT, ammo: AmmoT): boolean {
  const item = GetItemByAmmo(ammo);
  if (item === null) throw new Error(`G_AddAmmoAndCapQuantity: no item registered for ammo ${ammo} (InitItems() not called yet?)`);
  const client = requireClient(other, "G_AddAmmoAndCapQuantity");
  return G_AddAmmoAndCap(other, item.id, client.pers.max_ammo[ammo]!, item.quantity);
}

function G_AdjustAmmoCap(other: EdictT, ammo: AmmoT, new_max: number): void {
  const client = requireClient(other, "G_AdjustAmmoCap");
  client.pers.max_ammo[ammo] = Math.max(client.pers.max_ammo[ammo]!, new_max);
}

// ---------------------------------------------------------------------------
// Pickup_Bandolier / Pickup_Pack (g_items.cpp:364-415)
// ---------------------------------------------------------------------------

export function Pickup_Bandolier(ent: EdictT, other: EdictT): boolean {
  G_AdjustAmmoCap(other, AmmoT.AMMO_BULLETS, 250);
  G_AdjustAmmoCap(other, AmmoT.AMMO_SHELLS, 150);
  G_AdjustAmmoCap(other, AmmoT.AMMO_CELLS, 250);
  G_AdjustAmmoCap(other, AmmoT.AMMO_SLUGS, 75);
  G_AdjustAmmoCap(other, AmmoT.AMMO_MAGSLUG, 75);
  G_AdjustAmmoCap(other, AmmoT.AMMO_FLECHETTES, 250);
  G_AdjustAmmoCap(other, AmmoT.AMMO_DISRUPTOR, 21);

  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_BULLETS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_SHELLS);

  const item = requireItem(ent, "Pickup_Bandolier");
  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    SetRespawn(ent, Gtime_from_sec(item.quantity));
  }

  return true;
}

export function Pickup_Pack(ent: EdictT, other: EdictT): boolean {
  G_AdjustAmmoCap(other, AmmoT.AMMO_BULLETS, 300);
  G_AdjustAmmoCap(other, AmmoT.AMMO_SHELLS, 200);
  G_AdjustAmmoCap(other, AmmoT.AMMO_ROCKETS, 100);
  G_AdjustAmmoCap(other, AmmoT.AMMO_GRENADES, 100);
  G_AdjustAmmoCap(other, AmmoT.AMMO_CELLS, 300);
  G_AdjustAmmoCap(other, AmmoT.AMMO_SLUGS, 100);
  G_AdjustAmmoCap(other, AmmoT.AMMO_MAGSLUG, 100);
  G_AdjustAmmoCap(other, AmmoT.AMMO_FLECHETTES, 300);
  G_AdjustAmmoCap(other, AmmoT.AMMO_DISRUPTOR, 30);

  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_BULLETS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_SHELLS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_CELLS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_GRENADES);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_ROCKETS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_SLUGS);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_MAGSLUG);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_FLECHETTES);
  G_AddAmmoAndCapQuantity(other, AmmoT.AMMO_DISRUPTOR);

  const item = requireItem(ent, "Pickup_Pack");
  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    SetRespawn(ent, Gtime_from_sec(item.quantity));
  }

  return true;
}

// ---------------------------------------------------------------------------
// Use_Quad / Use_QuadFire (g_items.cpp:419-462)
// ---------------------------------------------------------------------------

let quad_drop_timeout_hack: GTime = GTIME_ZERO;
let quad_fire_drop_timeout_hack: GTime = GTIME_ZERO;

export function Use_Quad(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Quad");
  client.pers.inventory[item.id]--;

  let timeout: GTime;
  if (Gtime_nonzero(quad_drop_timeout_hack)) {
    timeout = quad_drop_timeout_hack;
    quad_drop_timeout_hack = GTIME_ZERO;
  } else {
    timeout = Gtime_from_sec(30);
  }

  client.quad_time = Gtime_add(GTmax(level.time, client.quad_time), timeout);
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

export function Use_QuadFire(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_QuadFire");
  client.pers.inventory[item.id]--;

  let timeout: GTime;
  if (Gtime_nonzero(quad_fire_drop_timeout_hack)) {
    timeout = quad_fire_drop_timeout_hack;
    quad_fire_drop_timeout_hack = GTIME_ZERO;
  } else {
    timeout = Gtime_from_sec(30);
  }

  client.quadfire_time = Gtime_add(GTmax(level.time, client.quadfire_time), timeout);
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/quadfire1.wav"), 1, ATTN_NORM, 0);
}

// ---------------------------------------------------------------------------
// Use_Breather / Use_Envirosuit / Use_Invulnerability / Use_Invisibility /
// Use_Silencer (g_items.cpp:466-514)
// ---------------------------------------------------------------------------

export function Use_Breather(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Breather");
  client.pers.inventory[item.id]--;
  client.breather_time = Gtime_add(GTmax(level.time, client.breather_time), Gtime_from_sec(30));
}

export function Use_Envirosuit(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Envirosuit");
  client.pers.inventory[item.id]--;
  client.enviro_time = Gtime_add(GTmax(level.time, client.enviro_time), Gtime_from_sec(30));
}

export function Use_Invulnerability(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Invulnerability");
  client.pers.inventory[item.id]--;
  client.invincible_time = Gtime_add(GTmax(level.time, client.invincible_time), Gtime_from_sec(30));
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/protect.wav"), 1, ATTN_NORM, 0);
}

export function Use_Invisibility(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Invisibility");
  client.pers.inventory[item.id]--;
  client.invisible_time = Gtime_add(GTmax(level.time, client.invisible_time), Gtime_from_sec(30));
  gi.sound(ent, SoundchanT.CHAN_ITEM, gi.soundindex("items/protect.wav"), 1, ATTN_NORM, 0);
}

export function Use_Silencer(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Use_Silencer");
  client.pers.inventory[item.id]--;
  client.silencer_shots += 30;
}

// ---------------------------------------------------------------------------
// Pickup_Key (g_items.cpp:518-539)
// ---------------------------------------------------------------------------

export function Pickup_Key(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Key");
  const client = requireClient(other, "Pickup_Key");

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) {
    if (item.id === ItemIdT.IT_KEY_POWER_CUBE || item.id === ItemIdT.IT_KEY_EXPLOSIVE_CHARGES) {
      const editorBits = SpawnFlags_value(SpawnFlags_and(ent.spawnflags, SPAWNFLAG_EDITOR_MASK)) >> 8;
      if ((client.pers.power_cubes & editorBits) !== 0) return false;
      client.pers.inventory[item.id]++;
      client.pers.power_cubes |= editorBits;
    } else {
      if (client.pers.inventory[item.id] !== 0) return false;
      client.pers.inventory[item.id] = 1;
    }
    return true;
  }

  client.pers.inventory[item.id]++;
  return true;
}

// ---------------------------------------------------------------------------
// Add_Ammo / G_CheckAutoSwitch / Pickup_Ammo / Drop_Ammo (g_items.cpp:543-642)
// ---------------------------------------------------------------------------

export function Add_Ammo(ent: EdictT, item: GitemT, count: number): boolean {
  if (ent.client === null || item.tag < AmmoT.AMMO_BULLETS || item.tag >= AmmoT.AMMO_MAX) return false;
  return G_AddAmmoAndCap(ent, item.id, ent.client.pers.max_ammo[item.tag]!, count);
}

function G_CheckAutoSwitch(ent: EdictT, item: GitemT, is_new: boolean): void {
  const client = requireClient(ent, "G_CheckAutoSwitch");

  if (client.pers.weapon === item || client.newweapon === item) return;
  else if (item.ammo !== ItemIdT.IT_NULL) {
    const required_ammo = (item.flags & ItemFlagsT.IF_AMMO) !== 0 ? 1 : item.quantity;
    if (client.pers.inventory[item.ammo] < required_ammo) return;
  }

  if (client.pers.autoswitch === AutoSwitchT.NEVER) return;
  else if ((item.flags & ItemFlagsT.IF_AMMO) !== 0 && client.pers.autoswitch === AutoSwitchT.ALWAYS_NO_AMMO) return;
  else if (client.pers.autoswitch === AutoSwitchT.SMART) {
    const using_blaster = client.pers.weapon !== null && client.pers.weapon.id === ItemIdT.IT_WEAPON_BLASTER;

    if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && !using_blaster) return;
    else if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && !using_blaster && !is_new) return;
  }

  client.newweapon = item;
}

export function Pickup_Ammo(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Ammo");
  const weapon = (item.flags & ItemFlagsT.IF_WEAPON) !== 0;

  let count: number;
  if (weapon && G_CheckInfiniteAmmo(item)) count = 1000;
  else if (ent.count !== 0) count = ent.count;
  else count = item.quantity;

  const client = requireClient(other, "Pickup_Ammo");
  const oldcount = client.pers.inventory[item.id];

  if (!Add_Ammo(other, item, count)) return false;

  if (weapon) G_CheckAutoSwitch(other, item, oldcount === 0);

  if (!SpawnFlags_has(ent.spawnflags, SpawnFlags_or(SPAWNFLAG_ITEM_DROPPED, SPAWNFLAG_ITEM_DROPPED_PLAYER)) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    SetRespawn(ent, Gtime_from_sec(30));
  }

  return true;
}

export function Drop_Ammo(ent: EdictT, item: GitemT): void {
  if (G_CheckInfiniteAmmo(item)) return;

  const index = item.id;
  const dropped = Drop_Item(ent, item);
  dropped.spawnflags = SpawnFlags_or(dropped.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
  dropped.svflags &= ~SvflagsT.SVF_INSTANCED;

  const client = requireClient(ent, "Drop_Ammo");

  if (client.pers.inventory[index] >= item.quantity) dropped.count = item.quantity;
  else dropped.count = client.pers.inventory[index];

  if (client.pers.weapon !== null && client.pers.weapon === item && (item.flags & ItemFlagsT.IF_AMMO) !== 0 && client.pers.inventory[index] - dropped.count <= 0) {
    LocClient_Print(ent, PrintTypeT.PRINT_HIGH, "$g_cant_drop_weapon");
    G_FreeEdict(dropped);
    return;
  }

  client.pers.inventory[index] -= dropped.count;
  G_CheckPowerArmor(ent);
}

// ---------------------------------------------------------------------------
// MegaHealth_think / Pickup_Health (g_items.cpp:646-722)
// ---------------------------------------------------------------------------

export const MegaHealth_think: ThinkFn = RegisterThink("MegaHealth_think", (self: EdictT): void => {
  const owner = self.owner;
  if (owner === null) throw new Error("MegaHealth_think: self.owner is null -- Pickup_Health always sets it before assigning this think");

  if (owner.health > owner.max_health && !CTFHasRegeneration(owner)) {
    self.nextthink = Gtime_add(level.time, Gtime_from_sec(1));
    owner.health -= 1;
    return;
  }

  if (!SpawnFlags_has(self.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    SetRespawn(self, Gtime_from_sec(20));
  } else {
    G_FreeEdict(self);
  }
});

export function Pickup_Health(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Health");
  const health_flags = ent.style !== 0 ? ent.style : item.tag;

  if ((health_flags & HEALTH_IGNORE_MAX) === 0) {
    if (other.health >= other.max_health) return false;
  }

  const count = ent.count !== 0 ? ent.count : item.quantity;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && other.health >= 250 && count > 25) return false;

  other.health += count;

  if (cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH) && other.health > 250 && count > 25) other.health = 250;

  if ((health_flags & HEALTH_IGNORE_MAX) === 0) {
    if (other.health > other.max_health) other.health = other.max_health;
  }

  if ((item.tag & HEALTH_TIMED) !== 0 && !CTFHasRegeneration(other)) {
    if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
      const client = requireClient(other, "Pickup_Health");
      client.pers.megahealth_time = Gtime_from_sec(5);
    } else {
      ent.think = MegaHealth_think;
      ent.nextthink = Gtime_add(level.time, Gtime_from_sec(5));
      ent.owner = other;
      ent.flags |= EntFlagsT.FL_RESPAWN;
      ent.svflags |= SvflagsT.SVF_NOCLIENT;
      ent.solid = SolidT.SOLID_NOT;
    }
  } else {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
      SetRespawn(ent, Gtime_from_sec(30));
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Pickup_Armor (g_items.cpp:744-823) -- ArmorIndex/PowerArmorType imported
// from g_combat.ts, see file header
// ---------------------------------------------------------------------------

export function Pickup_Armor(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_Armor");
  const newinfo = item.armor_info;
  const old_armor_index = ArmorIndex(other);
  const client = requireClient(other, "Pickup_Armor");

  const base_count = ent.count !== 0 ? ent.count : newinfo !== null ? newinfo.base_count : 0;

  if (item.id === ItemIdT.IT_ARMOR_SHARD) {
    if (old_armor_index === ItemIdT.IT_NULL) {
      client.pers.inventory[ItemIdT.IT_ARMOR_JACKET] = 2;
    } else {
      client.pers.inventory[old_armor_index] += 2;
    }
  } else if (old_armor_index === ItemIdT.IT_NULL) {
    client.pers.inventory[item.id] = base_count;
  } else {
    let oldinfo: GitemArmorT;
    if (old_armor_index === ItemIdT.IT_ARMOR_JACKET) oldinfo = jacketarmor_info;
    else if (old_armor_index === ItemIdT.IT_ARMOR_COMBAT) oldinfo = combatarmor_info;
    else oldinfo = bodyarmor_info;

    if (newinfo === null) throw new Error("Pickup_Armor: item has no armor_info but old_armor_index is set -- only armor items reach this branch");

    if (newinfo.normal_protection > oldinfo.normal_protection) {
      const salvage = oldinfo.normal_protection / newinfo.normal_protection;
      const salvagecount = Math.trunc(salvage * client.pers.inventory[old_armor_index]);
      let newcount = base_count + salvagecount;
      if (newcount > newinfo.max_count) newcount = newinfo.max_count;

      client.pers.inventory[old_armor_index] = 0;
      client.pers.inventory[item.id] = newcount;
    } else {
      const salvage = newinfo.normal_protection / oldinfo.normal_protection;
      const salvagecount = Math.trunc(salvage * base_count);
      let newcount = client.pers.inventory[old_armor_index] + salvagecount;
      if (newcount > oldinfo.max_count) newcount = oldinfo.max_count;

      if (client.pers.inventory[old_armor_index] >= newcount) return false;

      client.pers.inventory[old_armor_index] = newcount;
    }
  }

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED) && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    SetRespawn(ent, Gtime_from_sec(20));
  }

  return true;
}

// ---------------------------------------------------------------------------
// Use_PowerArmor / Pickup_PowerArmor / Drop_PowerArmor (g_items.cpp:844-896)
// ---------------------------------------------------------------------------

export function Use_PowerArmor(ent: EdictT, _item: GitemT): void {
  if ((ent.flags & EntFlagsT.FL_POWER_ARMOR) !== 0n) {
    ent.flags &= ~(EntFlagsT.FL_POWER_ARMOR | EntFlagsT.FL_WANTS_POWER_ARMOR);
    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
  } else {
    const client = requireClient(ent, "Use_PowerArmor");
    if (client.pers.inventory[ItemIdT.IT_AMMO_CELLS] === 0) {
      LocClient_Print(ent, PrintTypeT.PRINT_HIGH, "$g_no_cells_power_armor");
      return;
    }

    ent.flags |= EntFlagsT.FL_POWER_ARMOR;

    if (client.pers.autoshield !== AUTO_SHIELD_MANUAL && client.pers.inventory[ItemIdT.IT_AMMO_CELLS] > client.pers.autoshield) {
      ent.flags |= EntFlagsT.FL_WANTS_POWER_ARMOR;
    }

    gi.sound(ent, SoundchanT.CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
  }
}

export function Pickup_PowerArmor(ent: EdictT, other: EdictT): boolean {
  const item = requireItem(ent, "Pickup_PowerArmor");
  const client = requireClient(other, "Pickup_PowerArmor");
  const quantity = client.pers.inventory[item.id];

  client.pers.inventory[item.id]++;

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED)) {
      SetRespawn(ent, Gtime_from_sec(item.quantity));
    }
    if (quantity === 0) G_CheckPowerArmor(other);
  } else {
    G_CheckPowerArmor(other);
  }

  return true;
}

export function Drop_PowerArmor(ent: EdictT, item: GitemT): void {
  const client = requireClient(ent, "Drop_PowerArmor");
  if ((ent.flags & EntFlagsT.FL_POWER_ARMOR) !== 0n && client.pers.inventory[item.id] === 1) {
    Use_PowerArmor(ent, item);
  }
  Drop_General(ent, item);
}

// ---------------------------------------------------------------------------
// Entity_IsVisibleToPlayer (g_items.cpp:900-903)
// ---------------------------------------------------------------------------
// This is a `KexGameExports` member (see the `Entity_IsVisibleToPlayer`
// field in kexapi/game.ts's own interface and its stand-in in every test
// fixture's `makeFakeGameExports`) -- the engine calls it directly through
// the export table. No GetGameAPI/InitGame assembly unit exists yet in this
// port line to WIRE this function into `globals.Entity_IsVisibleToPlayer`
// (see g_main_globals.ts's own "a future InitGame/GetGameAPI unit
// eventually" note); that wiring is out of this unit's scope. Ported here
// as the real, callable, exported function -- a future GetGameAPI unit can
// adapt its `KexEdictT | null` export-table signature to this one.

export function Entity_IsVisibleToPlayer(ent: EdictT, player: EdictT): boolean {
  return !ent.item_picked_up_by[player.s.number - 1];
}

// ---------------------------------------------------------------------------
// Touch_Item (g_items.cpp:910-1020)
// ---------------------------------------------------------------------------

export const Touch_Item: TouchFn = RegisterTouch("Touch_Item", (ent: EdictT, other: EdictT, _tr: KexTraceT, _otherTouchingSelf: boolean): void => {
  if (other.client === null) return;
  if (other.health < 1) return;

  const item = ent.item;
  if (item === null || item.pickup === null) return;

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && P_UseCoopInstancedItems()) {
    if (ent.item_picked_up_by[other.s.number - 1]) return;
  }

  if (CTFMatchSetup()) return;

  const taken = item.pickup(ent, other);

  ValidateSelectedItem(other);

  const client = requireClient(other, "Touch_Item");

  if (taken) {
    client.bonus_alpha = 0.25;

    client.ps.stats[STAT_PICKUP_ICON] = item.icon !== null ? gi.imageindex(item.icon) : 0;
    client.ps.stats[STAT_PICKUP_STRING] = CS_ITEMS + item.id;
    client.pickup_msg_time = Gtime_add(level.time, Gtime_from_sec(3));

    if (item.use !== null && client.pers.inventory[item.id] !== 0) {
      client.ps.stats[STAT_SELECTED_ITEM] = item.id;
      client.pers.selected_item = item.id;
      client.ps.stats[STAT_SELECTED_ITEM_NAME] = 0;
    }

    if (ent.noise_index !== 0) {
      gi.sound(other, SoundchanT.CHAN_ITEM, ent.noise_index, 1, ATTN_NORM, 0);
    } else if (item.pickup_sound !== null) {
      gi.sound(other, SoundchanT.CHAN_ITEM, gi.soundindex(item.pickup_sound), 1, ATTN_NORM, 0);
    }

    const player_number = other.s.number - 1;

    if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && P_UseCoopInstancedItems() && !ent.item_picked_up_by[player_number]) {
      ent.item_picked_up_by[player_number] = true;

      if (ent.message !== null) G_PrintActivationMessage(ent, other, false);
    }
  }

  if (!SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_TARGETS_USED)) {
    const shouldSwap = cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) || (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && P_UseCoopInstancedItems());
    let message_backup: string | null = null;

    if (shouldSwap) {
      message_backup = ent.message;
      ent.message = null;
    }

    G_UseTargets(ent, other);

    if (shouldSwap) {
      ent.message = message_backup;
    }

    ent.spawnflags = SpawnFlags_or(ent.spawnflags, SPAWNFLAG_ITEM_TARGETS_USED);
  }

  if (taken) {
    let should_remove: boolean;

    if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) {
      if (P_UseCoopInstancedItems()) {
        should_remove = SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_DROPPED_PLAYER);
      } else {
        should_remove = SpawnFlags_has(ent.spawnflags, SpawnFlags_or(SPAWNFLAG_ITEM_DROPPED, SPAWNFLAG_ITEM_DROPPED_PLAYER)) || (item.flags & ItemFlagsT.IF_STAY_COOP) === 0;
      }
    } else {
      should_remove = !cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) || SpawnFlags_has(ent.spawnflags, SpawnFlags_or(SPAWNFLAG_ITEM_DROPPED, SPAWNFLAG_ITEM_DROPPED_PLAYER));
    }

    if (should_remove) {
      if ((ent.flags & EntFlagsT.FL_RESPAWN) !== 0n) {
        ent.flags &= ~EntFlagsT.FL_RESPAWN;
      } else {
        G_FreeEdict(ent);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// drop_temp_touch / drop_make_touchable / Drop_Item / Use_Item
// (g_items.cpp:1024-1111)
// ---------------------------------------------------------------------------

export const drop_temp_touch: TouchFn = RegisterTouch("drop_temp_touch", (ent: EdictT, other: EdictT, tr: KexTraceT, otherTouchingSelf: boolean): void => {
  if (other === ent.owner) return;
  Touch_Item(ent, other, tr, otherTouchingSelf);
});

export const drop_make_touchable: ThinkFn = RegisterThink("drop_make_touchable", (ent: EdictT): void => {
  ent.touch = Touch_Item;
  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    ent.nextthink = Gtime_add(level.time, Gtime_from_sec(29));
    ent.think = G_FreeEdict;
  }
});

export function Drop_Item(ent: EdictT, item: GitemT): EdictT {
  const dropped = G_Spawn();

  dropped.item = item;
  dropped.spawnflags = SPAWNFLAG_ITEM_DROPPED;
  dropped.classname = item.classname;
  dropped.s.effects = item.world_model_flags;
  gi.setmodel(dropped, item.world_model ?? "");
  dropped.s.renderfx = RenderfxT.RF_GLOW | RenderfxT.RF_NO_LOD | RenderfxT.RF_IR_VISIBLE;
  dropped.mins = vec3(-15, -15, -15);
  dropped.maxs = vec3(15, 15, 15);
  dropped.solid = SolidT.SOLID_TRIGGER;
  dropped.movetype = MovetypeT.MOVETYPE_TOSS;
  dropped.touch = drop_temp_touch;
  dropped.owner = ent;

  const forward = vec3();
  const right = vec3();

  if (ent.client !== null) {
    AngleVectors(ent.client.v_angle, forward, right, null);
    const offset = vec3(24, 0, -16);
    const projected = G_ProjectSource(ent.s.origin, offset, forward, right);
    const trace = gi.trace(ent.s.origin, dropped.mins, dropped.maxs, projected, ent, ContentsT.CONTENTS_SOLID);
    VectorCopy(trace.endpos, dropped.s.origin);
  } else {
    AngleVectors(ent.s.angles, forward, right, null);
    VectorCopy(vec3_muls(vec3_add(ent.absmin, ent.absmax), 0.5), dropped.s.origin);
  }

  const check = vec3(dropped.s.origin[0], dropped.s.origin[1], dropped.s.origin[2]);
  G_FixStuckObject(dropped, check);

  dropped.velocity = vec3_muls(forward, 100);
  dropped.velocity[2] = 300;

  dropped.think = drop_make_touchable;
  dropped.nextthink = Gtime_add(level.time, Gtime_from_sec(1));

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && P_UseCoopInstancedItems()) {
    dropped.svflags |= SvflagsT.SVF_INSTANCED;
  }

  gi.linkentity(dropped);
  return dropped;
}

export const Use_Item: UseFn = RegisterUse("Use_Item", (ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  ent.svflags &= ~SvflagsT.SVF_NOCLIENT;
  ent.use = null;

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_NO_TOUCH)) {
    ent.solid = SolidT.SOLID_BBOX;
    ent.touch = null;
  } else {
    ent.solid = SolidT.SOLID_TRIGGER;
    ent.touch = Touch_Item;
  }

  gi.linkentity(ent);
});

// ---------------------------------------------------------------------------
// droptofloor (g_items.cpp:1120-1202)
// ---------------------------------------------------------------------------

export const droptofloor: ThinkFn = RegisterThink("droptofloor", (ent: EdictT): void => {
  const item = requireItem(ent, "droptofloor");

  if (ent.classname === "item_foodcube") {
    const scale = ent.s.scale;
    ent.mins = vec3_muls(vec3(-8, -8, -8), scale);
    ent.maxs = vec3_muls(vec3(8, 8, 8), scale);
  } else {
    ent.mins = vec3(-15, -15, -15);
    ent.maxs = vec3(15, 15, 15);
  }

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  else gi.setmodel(ent, item.world_model ?? "");
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;

  const dest = vec3_add(ent.s.origin, vec3(0, 0, -128));

  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, dest, ent, MASK_SOLID);
  if (tr.startsolid) {
    const check = vec3(ent.s.origin[0], ent.s.origin[1], ent.s.origin[2]);
    if (G_FixStuckObject(ent, check) === StuckResultT.NO_GOOD_POSITION) {
      if (ent.classname === "item_foodcube") {
        ent.velocity[2] = 0;
      } else {
        gi.Com_Print(`${edictFmt(ent)}: droptofloor: startsolid\n`);
        G_FreeEdict(ent);
        return;
      }
    }
  } else {
    VectorCopy(tr.endpos, ent.s.origin);
  }

  if (ent.team !== null) {
    ent.flags &= ~EntFlagsT.FL_TEAMSLAVE;
    ent.chain = ent.teamchain;
    ent.teamchain = null;

    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;

    if (ent === ent.teammaster) {
      ent.nextthink = Gtime_add(level.time, Gtime_from_hz(10));
      ent.think = DoRespawn;
    }
  }

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_NO_TOUCH)) {
    ent.solid = SolidT.SOLID_BBOX;
    ent.touch = null;
    ent.s.effects &= ~(EffectsT.EF_ROTATE | EffectsT.EF_BOB);
    ent.s.renderfx &= ~RenderfxT.RF_GLOW;
  }

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_TRIGGER_SPAWN)) {
    ent.svflags |= SvflagsT.SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
    ent.use = Use_Item;
  }

  ent.watertype = gi.pointcontents(ent.s.origin);
  gi.linkentity(ent);
});

// ---------------------------------------------------------------------------
// Item_TriggeredSpawn / SetTriggeredSpawn (rogue/g_rogue_items.cpp:191-227)
// -- see file header "SMALL CROSS-FILE FUNCTIONS PORTED HERE FOR REAL"
// ---------------------------------------------------------------------------

export const Item_TriggeredSpawn: UseFn = RegisterUse("Item_TriggeredSpawn", (self: EdictT, _other: EdictT | null, _activator: EdictT | null): void => {
  self.svflags &= ~SvflagsT.SVF_NOCLIENT;
  self.use = null;

  if (SpawnFlags_has(self.spawnflags, SPAWNFLAG_ITEM_TOSS_SPAWN)) {
    self.movetype = MovetypeT.MOVETYPE_TOSS;
    const forward = vec3();
    const right = vec3();
    AngleVectors(self.s.angles, forward, right, null);
    self.s.origin[2] += 16;
    self.velocity = vec3_muls(forward, 100);
    self.velocity[2] = 300;
  }

  const item = requireItem(self, "Item_TriggeredSpawn");
  if (item.id !== ItemIdT.IT_KEY_POWER_CUBE && item.id !== ItemIdT.IT_KEY_EXPLOSIVE_CHARGES) {
    self.spawnflags = SpawnFlags_and(self.spawnflags, SPAWNFLAG_ITEM_NO_TOUCH);
  }

  droptofloor(self);
});

export function SetTriggeredSpawn(ent: EdictT): void {
  const item = requireItem(ent, "SetTriggeredSpawn");
  if (item.id === ItemIdT.IT_KEY_POWER_CUBE || item.id === ItemIdT.IT_KEY_EXPLOSIVE_CHARGES) return;

  ent.think = null;
  ent.nextthink = GTIME_ZERO;
  ent.use = Item_TriggeredSpawn;
  ent.svflags |= SvflagsT.SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_NOT;
}

// ---------------------------------------------------------------------------
// PrecacheItem (g_items.cpp:1213-1269)
// ---------------------------------------------------------------------------

export function PrecacheItem(it: GitemT | null): void {
  if (it === null) return;

  if (it.pickup_sound !== null) gi.soundindex(it.pickup_sound);
  if (it.world_model !== null) gi.modelindex(it.world_model);
  if (it.view_model !== null) gi.modelindex(it.view_model);
  if (it.icon !== null) gi.imageindex(it.icon);

  if (it.ammo !== ItemIdT.IT_NULL) {
    const ammo = GetItemByIndex(it.ammo);
    if (ammo !== it) PrecacheItem(ammo);
  }

  const s = it.precaches;
  if (s === null || s.length === 0) return;

  for (const token of s.split(" ")) {
    if (token.length === 0) continue;
    if (token.length >= MAX_QPATH || token.length < 5) {
      gi.Com_Error(`PrecacheItem: ${it.classname ?? "?"} has bad precache string`);
    }
    const ext = token.slice(-3);
    if (ext === "md2" || ext === "sp2") gi.modelindex(token);
    else if (ext === "wav") gi.soundindex(token);
    if (ext === "pcx") gi.imageindex(token);
  }
}

// ---------------------------------------------------------------------------
// SpawnItem (g_items.cpp:1281-1480)
// ---------------------------------------------------------------------------

export function SpawnItem(ent: EdictT, itemIn: GitemT): void {
  let item = itemIn;

  if ((item.flags & ItemFlagsT.IF_KEY) !== 0) {
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_TRIGGER_SPAWN)) {
      ent.svflags |= SvflagsT.SVF_NOCLIENT;
      ent.solid = SolidT.SOLID_NOT;
      ent.use = Use_Item;
    }
    if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_NO_TOUCH)) {
      ent.solid = SolidT.SOLID_BBOX;
      ent.touch = null;
      ent.s.effects &= ~(EffectsT.EF_ROTATE | EffectsT.EF_BOB);
      ent.s.renderfx &= ~RenderfxT.RF_GLOW;
    }
  } else if (SpawnFlags_value(ent.spawnflags) >= SpawnFlags_value(SPAWNFLAG_ITEM_MAX)) {
    ent.spawnflags = SPAWNFLAGS_NONE;
    gi.Com_Print(`${edictFmt(ent)} has invalid spawnflags set\n`);
  }

  if (cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (cvarBool("g_instagib", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (
        item.pickup === Pickup_Armor ||
        item.pickup === Pickup_PowerArmor ||
        item.pickup === Pickup_Powerup ||
        item.pickup === Pickup_Sphere ||
        item.pickup === Pickup_Doppleganger ||
        (item.flags & ItemFlagsT.IF_HEALTH) !== 0 ||
        (item.flags & ItemFlagsT.IF_AMMO) !== 0 ||
        item.pickup === Pickup_Weapon ||
        item.pickup === Pickup_Pack ||
        item.id === ItemIdT.IT_ITEM_BANDOLIER ||
        item.id === ItemIdT.IT_ITEM_PACK ||
        item.id === ItemIdT.IT_AMMO_NUKE
      ) {
        G_FreeEdict(ent);
        return;
      }
    }

    if (cvarBool("g_no_armor", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.pickup === Pickup_Armor || item.pickup === Pickup_PowerArmor) {
        G_FreeEdict(ent);
        return;
      }
    }
    if (cvarBool("g_no_items", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.pickup === Pickup_Powerup) {
        G_FreeEdict(ent);
        return;
      }
      if (item.pickup === Pickup_Sphere) {
        G_FreeEdict(ent);
        return;
      }
      if (item.pickup === Pickup_Doppleganger) {
        G_FreeEdict(ent);
        return;
      }
    }
    if (cvarBool("g_no_health", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if ((item.flags & ItemFlagsT.IF_HEALTH) !== 0) {
        G_FreeEdict(ent);
        return;
      }
    }
    if (G_CheckInfiniteAmmo(item)) {
      if (item.flags === ItemFlagsT.IF_AMMO) {
        G_FreeEdict(ent);
        return;
      }

      if (item.id === ItemIdT.IT_WEAPON_BFG) {
        const replacement = GetItemByIndex(ItemIdT.IT_WEAPON_DISRUPTOR);
        if (replacement === null) throw new Error("SpawnItem: IT_WEAPON_DISRUPTOR missing from itemlist");
        item = replacement;
      }
    }

    if (cvarBool("g_no_mines", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.id === ItemIdT.IT_WEAPON_PROXLAUNCHER || item.id === ItemIdT.IT_AMMO_PROX || item.id === ItemIdT.IT_AMMO_TESLA || item.id === ItemIdT.IT_AMMO_TRAP) {
        G_FreeEdict(ent);
        return;
      }
    }
    if (cvarBool("g_no_nukes", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.id === ItemIdT.IT_AMMO_NUKE) {
        G_FreeEdict(ent);
        return;
      }
    }
    if (cvarBool("g_no_spheres", "0", CvarFlagsT.CVAR_NOFLAGS)) {
      if (item.pickup === Pickup_Sphere) {
        G_FreeEdict(ent);
        return;
      }
    }
  }

  if (!cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH)) {
    if (item.pickup === Pickup_Doppleganger || item.pickup === Pickup_Nuke) {
      gi.Com_Print(`${edictFmt(ent)} spawned in non-DM; freeing...\n`);
      G_FreeEdict(ent);
      return;
    }
    if (item.use === Use_Vengeance || item.use === Use_Hunter) {
      gi.Com_Print(`${edictFmt(ent)} spawned in non-DM; freeing...\n`);
      G_FreeEdict(ent);
      return;
    }
  }

  if (G_CheckInfiniteAmmo(item)) {
    if (item.id === ItemIdT.IT_ITEM_POWER_SHIELD || item.id === ItemIdT.IT_ITEM_POWER_SCREEN) {
      const replacement = GetItemByIndex(ItemIdT.IT_ARMOR_BODY);
      if (replacement === null) throw new Error("SpawnItem: IT_ARMOR_BODY missing from itemlist");
      item = replacement;
    }
  }

  if (!cvarBool("ctf", "0", CvarFlagsT.CVAR_LATCH) && (item.id === ItemIdT.IT_FLAG1 || item.id === ItemIdT.IT_FLAG2)) {
    G_FreeEdict(ent);
    return;
  }

  ent.classname = item.classname;

  PrecacheItem(item);

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH) && (item.id === ItemIdT.IT_KEY_POWER_CUBE || item.id === ItemIdT.IT_KEY_EXPLOSIVE_CHARGES)) {
    ent.spawnflags = SpawnFlags_or(ent.spawnflags, SpawnFlags_from(1 << (8 + level.power_cubes)));
    level.power_cubes++;
  }

  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) {
    if (P_UseCoopInstancedItems()) ent.svflags |= SvflagsT.SVF_INSTANCED;
  }

  ent.item = item;
  ent.nextthink = Gtime_add(level.time, Gtime_from_hz(20));
  ent.think = droptofloor;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RenderfxT.RF_GLOW | RenderfxT.RF_NO_LOD;
  if (ent.model !== null) gi.modelindex(ent.model);

  if (SpawnFlags_has(ent.spawnflags, SPAWNFLAG_ITEM_TRIGGER_SPAWN)) SetTriggeredSpawn(ent);

  if (item.id === ItemIdT.IT_FLAG1 || item.id === ItemIdT.IT_FLAG2) {
    ent.think = CTFFlagSetup;
  }
}

// ---------------------------------------------------------------------------
// P_ToggleFlashlight / Use_Flashlight (g_items.cpp:1482-1495)
// ---------------------------------------------------------------------------

export function P_ToggleFlashlight(ent: EdictT, state: boolean): void {
  if (((ent.flags & EntFlagsT.FL_FLASHLIGHT) !== 0n) === state) return;

  ent.flags ^= EntFlagsT.FL_FLASHLIGHT;

  gi.sound(
    ent,
    SoundchanT.CHAN_AUTO,
    gi.soundindex((ent.flags & EntFlagsT.FL_FLASHLIGHT) !== 0n ? "items/flashlight_on.wav" : "items/flashlight_off.wav"),
    1,
    ATTN_STATIC,
    0,
  );
}

function Use_Flashlight(ent: EdictT, _inv: GitemT): void {
  P_ToggleFlashlight(ent, (ent.flags & EntFlagsT.FL_FLASHLIGHT) === 0n);
}

// ---------------------------------------------------------------------------
// itemlist (g_items.cpp:1629-3901) -- see file header for the load-time
// assertion this array is validated against just below
// ---------------------------------------------------------------------------
// C++ initializes each `gitem_t` via POSITIONAL aggregate initialization
// (the `/* fieldname */ value,` comments are documentation only, not C++20
// designated initializers -- see file header "QUIRKS" on why a couple of
// those comments don't match the field they actually fill). This port uses
// a named-field factory instead, which sidesteps that ambiguity entirely:
// every value below is assigned to the field it is actually stored in,
// regardless of what the original comment said.

interface ItemSpec {
  id: ItemIdT;
  classname: string | null;
  pickup?: GitemPickupFn | null;
  use?: GitemUseFn | null;
  drop?: GitemDropFn | null;
  weaponthink?: GitemWeaponthinkFn | null;
  pickup_sound?: string | null;
  world_model?: string | null;
  world_model_flags?: EffectsT;
  view_model?: string | null;
  icon?: string | null;
  use_name?: string | null;
  pickup_name?: string | null;
  pickup_name_definite?: string | null;
  quantity?: number;
  ammo?: ItemIdT;
  chain?: ItemIdT;
  flags?: ItemFlagsT;
  vwep_model?: string | null;
  armor_info?: GitemArmorT | null;
  tag?: number;
  precaches?: string | null;
  sort_id?: number;
  quantity_warn?: number;
}

/** Fills every field GitemT declares, using this port's documented C++
 *  default-member-initializer values (see g_local_types.ts's GitemT own
 *  "default X" comments) for anything an itemlist entry below omits. */
function mkItem(spec: ItemSpec): GitemT {
  return {
    id: spec.id,
    classname: spec.classname,
    pickup: spec.pickup ?? null,
    use: spec.use ?? null,
    drop: spec.drop ?? null,
    weaponthink: spec.weaponthink ?? null,
    pickup_sound: spec.pickup_sound ?? null,
    world_model: spec.world_model ?? null,
    world_model_flags: spec.world_model_flags ?? EffectsT.EF_NONE,
    view_model: spec.view_model ?? null,
    icon: spec.icon ?? null,
    use_name: spec.use_name ?? null,
    pickup_name: spec.pickup_name ?? null,
    pickup_name_definite: spec.pickup_name_definite ?? null,
    quantity: spec.quantity ?? 0,
    ammo: spec.ammo ?? ItemIdT.IT_NULL,
    chain: spec.chain ?? ItemIdT.IT_NULL,
    flags: spec.flags ?? ItemFlagsT.IF_NONE,
    vwep_model: spec.vwep_model ?? null,
    armor_info: spec.armor_info ?? null,
    tag: spec.tag ?? 0,
    precaches: spec.precaches ?? null,
    sort_id: spec.sort_id ?? 0,
    quantity_warn: spec.quantity_warn ?? 5,
    // set in InitItems/SetItemNames, don't set by hand -- see GitemT's own comments
    chain_next: null,
    vwep_index: 0,
    ammo_wheel_index: -1,
    weapon_wheel_index: -1,
    powerup_wheel_index: -1,
  };
}

const IF = ItemFlagsT;
const EF = EffectsT;

export const itemlist: GitemT[] = [
  mkItem({ id: ItemIdT.IT_NULL, classname: null }), // leave index 0 alone

  //
  // ARMOR
  //
  mkItem({
    id: ItemIdT.IT_ARMOR_BODY,
    classname: "item_armor_body",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar3_pkup.wav",
    world_model: "models/items/armor/body/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_bodyarmor",
    use_name: "Body Armor",
    pickup_name: "$item_body_armor",
    pickup_name_definite: "$item_body_armor_def",
    flags: IF.IF_ARMOR,
    armor_info: bodyarmor_info,
  }),
  mkItem({
    id: ItemIdT.IT_ARMOR_COMBAT,
    classname: "item_armor_combat",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar1_pkup.wav",
    world_model: "models/items/armor/combat/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_combatarmor",
    use_name: "Combat Armor",
    pickup_name: "$item_combat_armor",
    pickup_name_definite: "$item_combat_armor_def",
    flags: IF.IF_ARMOR,
    armor_info: combatarmor_info,
  }),
  mkItem({
    id: ItemIdT.IT_ARMOR_JACKET,
    classname: "item_armor_jacket",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar1_pkup.wav",
    world_model: "models/items/armor/jacket/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_jacketarmor",
    use_name: "Jacket Armor",
    pickup_name: "$item_jacket_armor",
    pickup_name_definite: "$item_jacket_armor_def",
    flags: IF.IF_ARMOR,
    armor_info: jacketarmor_info,
  }),
  mkItem({
    id: ItemIdT.IT_ARMOR_SHARD,
    classname: "item_armor_shard",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar2_pkup.wav",
    world_model: "models/items/armor/shard/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_armor_shard",
    use_name: "Armor Shard",
    pickup_name: "$item_armor_shard",
    pickup_name_definite: "$item_armor_shard_def",
    flags: IF.IF_ARMOR,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_POWER_SCREEN,
    classname: "item_power_screen",
    pickup: Pickup_PowerArmor,
    use: Use_PowerArmor,
    drop: Drop_PowerArmor,
    pickup_sound: "misc/ar3_pkup.wav",
    world_model: "models/items/armor/screen/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_powerscreen",
    use_name: "Power Screen",
    pickup_name: "$item_power_screen",
    pickup_name_definite: "$item_power_screen_def",
    quantity: 60,
    ammo: ItemIdT.IT_AMMO_CELLS,
    flags: IF.IF_ARMOR | IF.IF_POWERUP_WHEEL | IF.IF_POWERUP_ONOFF,
    tag: PowerupT.POWERUP_SCREEN,
    precaches: "misc/power2.wav misc/power1.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_POWER_SHIELD,
    classname: "item_power_shield",
    pickup: Pickup_PowerArmor,
    use: Use_PowerArmor,
    drop: Drop_PowerArmor,
    pickup_sound: "misc/ar3_pkup.wav",
    world_model: "models/items/armor/shield/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_powershield",
    use_name: "Power Shield",
    pickup_name: "$item_power_shield",
    pickup_name_definite: "$item_power_shield_def",
    quantity: 60,
    ammo: ItemIdT.IT_AMMO_CELLS,
    flags: IF.IF_ARMOR | IF.IF_POWERUP_WHEEL | IF.IF_POWERUP_ONOFF,
    tag: PowerupT.POWERUP_SHIELD,
    precaches: "misc/power2.wav misc/power1.wav",
  }),

  //
  // WEAPONS
  //
  mkItem({
    id: ItemIdT.IT_WEAPON_GRAPPLE,
    classname: "weapon_grapple",
    use: Use_Weapon,
    weaponthink: CTFWeapon_Grapple,
    world_model_flags: EF.EF_NONE,
    view_model: "models/weapons/grapple/tris.md2",
    icon: "w_grapple",
    use_name: "Grapple",
    pickup_name: "$item_grapple",
    pickup_name_definite: "$item_grapple_def",
    chain: ItemIdT.IT_WEAPON_BLASTER,
    flags: IF.IF_WEAPON | IF.IF_NO_HASTE | IF.IF_POWERUP_WHEEL | IF.IF_NOT_RANDOM,
    vwep_model: "#w_grapple.md2",
    precaches: "weapons/grapple/grfire.wav weapons/grapple/grpull.wav weapons/grapple/grhang.wav weapons/grapple/grreset.wav weapons/grapple/grhit.wav weapons/grapple/grfly.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_BLASTER,
    classname: "weapon_blaster",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    weaponthink: Weapon_Blaster,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_blast/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_blast/tris.md2",
    icon: "w_blaster",
    use_name: "Blaster",
    pickup_name: "$item_blaster",
    pickup_name_definite: "$item_blaster_def",
    chain: ItemIdT.IT_WEAPON_BLASTER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP | IF.IF_NOT_RANDOM,
    vwep_model: "#w_blaster.md2",
    precaches: "weapons/blastf1a.wav misc/lasfly.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_CHAINFIST,
    classname: "weapon_chainfist",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ChainFist,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_chainf/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_chainf/tris.md2",
    icon: "w_chainfist",
    use_name: "Chainfist",
    pickup_name: "$item_chainfist",
    pickup_name_definite: "$item_chainfist_def",
    chain: ItemIdT.IT_WEAPON_BLASTER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP | IF.IF_NO_HASTE,
    vwep_model: "#w_chainfist.md2",
    precaches: "weapons/sawidle.wav weapons/sawhit.wav weapons/sawslice.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_SHOTGUN,
    classname: "weapon_shotgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Shotgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotg/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_shotg/tris.md2",
    icon: "w_shotgun",
    use_name: "Shotgun",
    pickup_name: "$item_shotgun",
    pickup_name_definite: "$item_shotgun_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_SHELLS,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_shotgun.md2",
    precaches: "weapons/shotgf1b.wav weapons/shotgr1b.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_SSHOTGUN,
    classname: "weapon_supershotgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_SuperShotgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotg2/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_shotg2/tris.md2",
    icon: "w_sshotgun",
    use_name: "Super Shotgun",
    pickup_name: "$item_super_shotgun",
    pickup_name_definite: "$item_super_shotgun_def",
    quantity: 2,
    ammo: ItemIdT.IT_AMMO_SHELLS,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_sshotgun.md2",
    precaches: "weapons/sshotf1b.wav",
    quantity_warn: 10,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_MACHINEGUN,
    classname: "weapon_machinegun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Machinegun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_machn/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_machn/tris.md2",
    icon: "w_machinegun",
    use_name: "Machinegun",
    pickup_name: "$item_machinegun",
    pickup_name_definite: "$item_machinegun_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_BULLETS,
    chain: ItemIdT.IT_WEAPON_MACHINEGUN,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_machinegun.md2",
    precaches: "weapons/machgf1b.wav weapons/machgf2b.wav weapons/machgf3b.wav weapons/machgf4b.wav weapons/machgf5b.wav",
    quantity_warn: 30,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_ETF_RIFLE,
    classname: "weapon_etf_rifle",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ETF_Rifle,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_etf_rifle/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_etf_rifle/tris.md2",
    icon: "w_etf_rifle",
    use_name: "ETF Rifle",
    pickup_name: "$item_etf_rifle",
    pickup_name_definite: "$item_etf_rifle_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_FLECHETTES,
    chain: ItemIdT.IT_WEAPON_MACHINEGUN,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_etfrifle.md2",
    precaches: "weapons/nail1.wav models/proj/flechette/tris.md2",
    quantity_warn: 30,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_CHAINGUN,
    classname: "weapon_chaingun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Chaingun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_chain/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_chain/tris.md2",
    icon: "w_chaingun",
    use_name: "Chaingun",
    pickup_name: "$item_chaingun",
    pickup_name_definite: "$item_chaingun_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_BULLETS,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_chaingun.md2",
    precaches: "weapons/chngnu1a.wav weapons/chngnl1a.wav weapons/machgf3b.wav weapons/chngnd1a.wav",
    quantity_warn: 60,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_GRENADES,
    classname: "ammo_grenades",
    pickup: Pickup_Ammo,
    use: Use_Weapon,
    drop: Drop_Ammo,
    weaponthink: Weapon_Grenade,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/grenades/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    view_model: "models/weapons/v_handgr/tris.md2",
    icon: "a_grenades",
    use_name: "Grenades",
    pickup_name: "$item_grenades",
    pickup_name_definite: "$item_grenades_def",
    quantity: 5,
    ammo: ItemIdT.IT_AMMO_GRENADES,
    chain: ItemIdT.IT_AMMO_GRENADES,
    flags: IF.IF_AMMO | IF.IF_WEAPON,
    vwep_model: "#a_grenades.md2",
    tag: AmmoT.AMMO_GRENADES,
    precaches: "weapons/hgrent1a.wav weapons/hgrena1b.wav weapons/hgrenc1b.wav weapons/hgrenb1a.wav weapons/hgrenb2a.wav models/objects/grenade3/tris.md2",
    quantity_warn: 2,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_TRAP,
    classname: "ammo_trap",
    pickup: Pickup_Ammo,
    use: Use_Weapon,
    drop: Drop_Ammo,
    weaponthink: Weapon_Trap,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/weapons/g_trap/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_trap/tris.md2",
    icon: "a_trap",
    use_name: "Trap",
    pickup_name: "$item_trap",
    pickup_name_definite: "$item_trap_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_TRAP,
    chain: ItemIdT.IT_AMMO_GRENADES,
    flags: IF.IF_AMMO | IF.IF_WEAPON | IF.IF_NO_INFINITE_AMMO,
    vwep_model: "#a_trap.md2",
    tag: AmmoT.AMMO_TRAP,
    precaches:
      "misc/fhit3.wav weapons/trapcock.wav weapons/traploop.wav weapons/trapsuck.wav weapons/trapdown.wav items/s_health.wav items/n_health.wav items/l_health.wav items/m_health.wav models/weapons/z_trap/tris.md2",
    quantity_warn: 1,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_TESLA,
    classname: "ammo_tesla",
    pickup: Pickup_Ammo,
    use: Use_Weapon,
    drop: Drop_Ammo,
    weaponthink: Weapon_Tesla,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_tesl/tris.md2",
    world_model_flags: EF.EF_NONE,
    view_model: "models/weapons/v_tesla/tris.md2",
    icon: "a_tesla",
    use_name: "Tesla",
    pickup_name: "$item_tesla",
    pickup_name_definite: "$item_tesla_def",
    quantity: 3,
    ammo: ItemIdT.IT_AMMO_TESLA,
    chain: ItemIdT.IT_AMMO_GRENADES,
    flags: IF.IF_AMMO | IF.IF_WEAPON | IF.IF_NO_INFINITE_AMMO,
    vwep_model: "#a_tesla.md2",
    tag: AmmoT.AMMO_TESLA,
    precaches: "weapons/teslaopen.wav weapons/hgrenb1a.wav weapons/hgrenb2a.wav models/weapons/g_tesla/tris.md2",
    quantity_warn: 1,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_GLAUNCHER,
    classname: "weapon_grenadelauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_GrenadeLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_launch/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_launch/tris.md2",
    icon: "w_glauncher",
    use_name: "Grenade Launcher",
    pickup_name: "$item_grenade_launcher",
    pickup_name_definite: "$item_grenade_launcher_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_GRENADES,
    chain: ItemIdT.IT_WEAPON_GLAUNCHER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_glauncher.md2",
    precaches: "models/objects/grenade4/tris.md2 weapons/grenlf1a.wav weapons/grenlr1b.wav weapons/grenlb1b.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_PROXLAUNCHER,
    classname: "weapon_proxlauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ProxLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_plaunch/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_plaunch/tris.md2",
    icon: "w_proxlaunch",
    use_name: "Prox Launcher",
    pickup_name: "$item_prox_launcher",
    pickup_name_definite: "$item_prox_launcher_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_PROX,
    chain: ItemIdT.IT_WEAPON_GLAUNCHER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_plauncher.md2",
    tag: AmmoT.AMMO_PROX,
    precaches: "weapons/grenlf1a.wav weapons/grenlr1b.wav weapons/grenlb1b.wav weapons/proxwarn.wav weapons/proxopen.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_RLAUNCHER,
    classname: "weapon_rocketlauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_RocketLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_rocket/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_rocket/tris.md2",
    icon: "w_rlauncher",
    use_name: "Rocket Launcher",
    pickup_name: "$item_rocket_launcher",
    pickup_name_definite: "$item_rocket_launcher_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_ROCKETS,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_rlauncher.md2",
    precaches: "models/objects/rocket/tris.md2 weapons/rockfly.wav weapons/rocklf1a.wav weapons/rocklr1b.wav models/objects/debris2/tris.md2",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_HYPERBLASTER,
    classname: "weapon_hyperblaster",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_HyperBlaster,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_hyperb/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_hyperb/tris.md2",
    icon: "w_hyperblaster",
    use_name: "HyperBlaster",
    pickup_name: "$item_hyperblaster",
    pickup_name_definite: "$item_hyperblaster_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_CELLS,
    chain: ItemIdT.IT_WEAPON_HYPERBLASTER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_hyperblaster.md2",
    precaches: "weapons/hyprbu1a.wav weapons/hyprbl1a.wav weapons/hyprbf1a.wav weapons/hyprbd1a.wav misc/lasfly.wav",
    quantity_warn: 30,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_IONRIPPER,
    classname: "weapon_boomer",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Ionripper,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_boom/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_boomer/tris.md2",
    icon: "w_ripper",
    use_name: "Ionripper",
    pickup_name: "$item_ionripper",
    pickup_name_definite: "$item_ionripper_def",
    quantity: 2,
    ammo: ItemIdT.IT_AMMO_CELLS,
    chain: ItemIdT.IT_WEAPON_HYPERBLASTER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_ripper.md2",
    precaches: "weapons/rippfire.wav models/objects/boomrang/tris.md2 misc/lasfly.wav",
    quantity_warn: 30,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_PLASMABEAM,
    classname: "weapon_plasmabeam",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Heatbeam,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_beamer/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_beamer/tris.md2",
    icon: "w_heatbeam",
    use_name: "Plasma Beam",
    pickup_name: "$item_plasma_beam",
    pickup_name_definite: "$item_plasma_beam_def",
    quantity: 2,
    ammo: ItemIdT.IT_AMMO_CELLS,
    chain: ItemIdT.IT_WEAPON_HYPERBLASTER,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_plasma.md2",
    precaches: "weapons/bfg__l1a.wav",
    quantity_warn: 50,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_RAILGUN,
    classname: "weapon_railgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Railgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_rail/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_rail/tris.md2",
    icon: "w_railgun",
    use_name: "Railgun",
    pickup_name: "$item_railgun",
    pickup_name_definite: "$item_railgun_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_SLUGS,
    chain: ItemIdT.IT_WEAPON_RAILGUN,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_railgun.md2",
    precaches: "weapons/rg_hum.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_PHALANX,
    classname: "weapon_phalanx",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Phalanx,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotx/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_shotx/tris.md2",
    icon: "w_phallanx",
    use_name: "Phalanx",
    pickup_name: "$item_phalanx",
    pickup_name_definite: "$item_phalanx_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_MAGSLUG,
    chain: ItemIdT.IT_WEAPON_RAILGUN,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_phalanx.md2",
    precaches: "weapons/plasshot.wav sprites/s_photon.sp2 weapons/rockfly.wav",
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_BFG,
    classname: "weapon_bfg",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_BFG,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_bfg/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_bfg/tris.md2",
    icon: "w_bfg",
    use_name: "BFG10K",
    pickup_name: "$item_bfg10k",
    pickup_name_definite: "$item_bfg10k_def",
    quantity: 50,
    ammo: ItemIdT.IT_AMMO_CELLS,
    chain: ItemIdT.IT_WEAPON_BFG,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_bfg.md2",
    precaches: "sprites/s_bfg1.sp2 sprites/s_bfg2.sp2 sprites/s_bfg3.sp2 weapons/bfg__f1y.wav weapons/bfg__l1a.wav weapons/bfg__x1b.wav weapons/bfg_hum.wav",
    quantity_warn: 50,
  }),
  mkItem({
    id: ItemIdT.IT_WEAPON_DISRUPTOR,
    classname: "weapon_disintegrator",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Disintegrator,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_dist/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    view_model: "models/weapons/v_dist/tris.md2",
    icon: "w_disintegrator",
    use_name: "Disruptor",
    pickup_name: "$item_disruptor",
    pickup_name_definite: "$item_disruptor_def",
    quantity: 1,
    ammo: ItemIdT.IT_AMMO_ROUNDS,
    chain: ItemIdT.IT_WEAPON_BFG,
    flags: IF.IF_WEAPON | IF.IF_STAY_COOP,
    vwep_model: "#w_disrupt.md2",
    precaches: "models/proj/disintegrator/tris.md2 weapons/disrupt.wav weapons/disint2.wav weapons/disrupthit.wav",
  }),

  // `#if 0 IT_WEAPON_DISINTEGRATOR #endif` (g_items.cpp:2408-2433) is dead
  // code in the C source itself (compiled out) and is correctly omitted
  // here too, matching g_local.ts's own identical note on the enumerator.

  //
  // AMMO ITEMS
  //
  mkItem({
    id: ItemIdT.IT_AMMO_SHELLS,
    classname: "ammo_shells",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/shells/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_shells",
    use_name: "Shells",
    pickup_name: "$item_shells",
    pickup_name_definite: "$item_shells_def",
    quantity: 10,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_SHELLS,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_BULLETS,
    classname: "ammo_bullets",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/bullets/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_bullets",
    use_name: "Bullets",
    pickup_name: "$item_bullets",
    pickup_name_definite: "$item_bullets_def",
    quantity: 50,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_BULLETS,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_CELLS,
    classname: "ammo_cells",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/cells/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_cells",
    use_name: "Cells",
    pickup_name: "$item_cells",
    pickup_name_definite: "$item_cells_def",
    quantity: 50,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_CELLS,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_ROCKETS,
    classname: "ammo_rockets",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/rockets/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_rockets",
    use_name: "Rockets",
    pickup_name: "$item_rockets",
    pickup_name_definite: "$item_rockets_def",
    quantity: 5,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_ROCKETS,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_SLUGS,
    classname: "ammo_slugs",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/slugs/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_slugs",
    use_name: "Slugs",
    pickup_name: "$item_slugs",
    pickup_name_definite: "$item_slugs_def",
    quantity: 10,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_SLUGS,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_MAGSLUG,
    classname: "ammo_magslug",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/objects/ammo/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_mslugs",
    use_name: "Mag Slug",
    pickup_name: "$item_mag_slug",
    pickup_name_definite: "$item_mag_slug_def",
    quantity: 10,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_MAGSLUG,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_FLECHETTES,
    classname: "ammo_flechettes",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_flechette/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_flechettes",
    use_name: "Flechettes",
    pickup_name: "$item_flechettes",
    pickup_name_definite: "$item_flechettes_def",
    quantity: 50,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_FLECHETTES,
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_PROX,
    classname: "ammo_prox",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_prox/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_prox",
    use_name: "Prox",
    pickup_name: "$item_prox",
    pickup_name_definite: "$item_prox_def",
    quantity: 5,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_PROX,
    precaches: "models/weapons/g_prox/tris.md2 weapons/proxwarn.wav",
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_NUKE,
    classname: "ammo_nuke",
    pickup: Pickup_Nuke,
    use: Use_Nuke,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_nuke",
    use_name: "A-M Bomb",
    pickup_name: "$item_am_bomb",
    pickup_name_definite: "$item_am_bomb_def",
    quantity: 300,
    ammo: ItemIdT.IT_AMMO_NUKE,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_AM_BOMB,
    precaches: "weapons/nukewarn2.wav world/rumble.wav",
  }),
  mkItem({
    id: ItemIdT.IT_AMMO_ROUNDS,
    classname: "ammo_disruptor",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_disr/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "a_disruptor",
    use_name: "Rounds",
    pickup_name: "$item_rounds",
    pickup_name_definite: "$item_rounds_def",
    quantity: 3,
    flags: IF.IF_AMMO,
    tag: AmmoT.AMMO_DISRUPTOR,
  }),

  //
  // POWERUP ITEMS
  //
  mkItem({
    id: ItemIdT.IT_ITEM_QUAD,
    classname: "item_quad",
    pickup: Pickup_Powerup,
    use: Use_Quad,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/quaddama/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_quad",
    use_name: "Quad Damage",
    pickup_name: "$item_quad_damage",
    pickup_name_definite: "$item_quad_damage_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_QUAD,
    precaches: "items/damage.wav items/damage2.wav items/damage3.wav ctf/tech2x.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_QUADFIRE,
    classname: "item_quadfire",
    pickup: Pickup_Powerup,
    use: Use_QuadFire,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/quadfire/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_quadfire",
    use_name: "DualFire Damage",
    pickup_name: "$item_dualfire_damage",
    pickup_name_definite: "$item_dualfire_damage_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_QUADFIRE,
    precaches: "items/quadfire1.wav items/quadfire2.wav items/quadfire3.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_INVULNERABILITY,
    classname: "item_invulnerability",
    pickup: Pickup_Powerup,
    use: Use_Invulnerability,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/invulner/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_invulnerability",
    use_name: "Invulnerability",
    pickup_name: "$item_invulnerability",
    pickup_name_definite: "$item_invulnerability_def",
    quantity: 300,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_INVULNERABILITY,
    precaches: "items/protect.wav items/protect2.wav items/protect4.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_INVISIBILITY,
    classname: "item_invisibility",
    pickup: Pickup_Powerup,
    use: Use_Invisibility,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/cloaker/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_cloaker",
    use_name: "Invisibility",
    pickup_name: "$item_invisibility",
    pickup_name_definite: "$item_invisibility_def",
    quantity: 300,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_INVISIBILITY,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_SILENCER,
    classname: "item_silencer",
    pickup: Pickup_Powerup,
    use: Use_Silencer,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/silencer/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_silencer",
    use_name: "Silencer",
    pickup_name: "$item_silencer",
    pickup_name_definite: "$item_silencer_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_SILENCER,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_REBREATHER,
    classname: "item_breather",
    pickup: Pickup_Powerup,
    use: Use_Breather,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/breather/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_rebreather",
    use_name: "Rebreather",
    pickup_name: "$item_rebreather",
    pickup_name_definite: "$item_rebreather_def",
    quantity: 60,
    flags: IF.IF_STAY_COOP | IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_REBREATHER,
    precaches: "items/airout.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_ENVIROSUIT,
    classname: "item_enviro",
    pickup: Pickup_Powerup,
    use: Use_Envirosuit,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/enviro/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_envirosuit",
    use_name: "Environment Suit",
    pickup_name: "$item_environment_suit",
    pickup_name_definite: "$item_environment_suit_def",
    quantity: 60,
    flags: IF.IF_STAY_COOP | IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_ENVIROSUIT,
    precaches: "items/airout.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_ANCIENT_HEAD,
    classname: "item_ancient_head",
    pickup: Pickup_LegacyHead,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/c_head/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_fixme",
    use_name: "Ancient Head",
    pickup_name: "$item_ancient_head",
    pickup_name_definite: "$item_ancient_head_def",
    quantity: 60,
    flags: IF.IF_HEALTH | IF.IF_NOT_RANDOM,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_LEGACY_HEAD,
    classname: "item_legacy_head",
    pickup: Pickup_LegacyHead,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/legacyhead/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_fixme",
    use_name: "Legacy Head",
    pickup_name: "$item_legacy_head",
    pickup_name_definite: "$item_legacy_head_def",
    quantity: 60,
    flags: IF.IF_HEALTH | IF.IF_NOT_RANDOM,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_ADRENALINE,
    classname: "item_adrenaline",
    pickup: Pickup_Powerup,
    use: Use_Adrenaline,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/adrenal/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_adrenaline",
    use_name: "Adrenaline",
    pickup_name: "$item_adrenaline",
    pickup_name_definite: "$item_adrenaline_def",
    quantity: 60,
    flags: IF.IF_HEALTH | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_ADRENALINE,
    precaches: "items/n_health.wav", // C++ comment says `/* precache */` (singular) -- positional init, see file header "QUIRKS"
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_BANDOLIER,
    classname: "item_bandolier",
    pickup: Pickup_Bandolier,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/band/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_bandolier",
    use_name: "Bandolier",
    pickup_name: "$item_bandolier",
    pickup_name_definite: "$item_bandolier_def",
    quantity: 60,
    flags: IF.IF_POWERUP,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_PACK,
    classname: "item_pack",
    pickup: Pickup_Pack,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/pack/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_pack",
    use_name: "Ammo Pack",
    pickup_name: "$item_ammo_pack",
    pickup_name_definite: "$item_ammo_pack_def",
    quantity: 180,
    flags: IF.IF_POWERUP,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_IR_GOGGLES,
    classname: "item_ir_goggles",
    pickup: Pickup_Powerup,
    use: Use_IR,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/goggles/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_ir",
    use_name: "IR Goggles",
    pickup_name: "$item_ir_goggles",
    pickup_name_definite: "$item_ir_goggles_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_IR_GOGGLES,
    precaches: "misc/ir_start.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_DOUBLE,
    classname: "item_double",
    pickup: Pickup_Powerup,
    use: Use_Double,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/ddamage/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_double",
    use_name: "Double Damage",
    pickup_name: "$item_double_damage",
    pickup_name_definite: "$item_double_damage_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_DOUBLE,
    precaches: "misc/ddamage1.wav misc/ddamage2.wav misc/ddamage3.wav ctf/tech2x.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_SPHERE_VENGEANCE,
    classname: "item_sphere_vengeance",
    pickup: Pickup_Sphere,
    use: Use_Vengeance,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/vengnce/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_vengeance",
    use_name: "vengeance sphere",
    pickup_name: "$item_vengeance_sphere",
    pickup_name_definite: "$item_vengeance_sphere_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_SPHERE_VENGEANCE,
    precaches: "spheres/v_idle.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_SPHERE_HUNTER,
    classname: "item_sphere_hunter",
    pickup: Pickup_Sphere,
    use: Use_Hunter,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/hunter/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_hunter",
    use_name: "hunter sphere",
    pickup_name: "$item_hunter_sphere",
    pickup_name_definite: "$item_hunter_sphere_def",
    quantity: 120,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_SPHERE_HUNTER,
    precaches: "spheres/h_idle.wav spheres/h_active.wav spheres/h_lurk.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_SPHERE_DEFENDER,
    classname: "item_sphere_defender",
    pickup: Pickup_Sphere,
    use: Use_Defender,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/defender/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_defender",
    use_name: "defender sphere",
    pickup_name: "$item_defender_sphere",
    pickup_name_definite: "$item_defender_sphere_def",
    quantity: 60,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_SPHERE_DEFENDER,
    precaches: "models/objects/laser/tris.md2 models/items/shell/tris.md2 spheres/d_idle.wav",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_DOPPELGANGER,
    classname: "item_doppleganger",
    pickup: Pickup_Doppleganger,
    use: Use_Doppleganger,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/dopple/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_doppleganger",
    use_name: "Doppelganger",
    pickup_name: "$item_doppleganger",
    pickup_name_definite: "$item_doppleganger_def",
    quantity: 90,
    flags: IF.IF_POWERUP | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_DOPPELGANGER,
    precaches: "models/objects/dopplebase/tris.md2 models/items/spawngro3/tris.md2 medic_commander/monsterspawn1.wav models/items/hunter/tris.md2 models/items/vengnce/tris.md2",
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_TAG_TOKEN,
    classname: null,
    pickup: Tag_PickupToken,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/tagtoken/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB | EF.EF_TAGTRAIL,
    icon: "i_tagtoken",
    use_name: "Tag Token",
    pickup_name: "$item_tag_token",
    pickup_name_definite: "$item_tag_token_def",
    flags: IF.IF_POWERUP | IF.IF_NOT_GIVEABLE,
  }),

  //
  // KEYS
  //
  mkItem({
    id: ItemIdT.IT_KEY_DATA_CD,
    classname: "key_data_cd",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/data_cd/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_datacd",
    use_name: "Data CD",
    pickup_name: "$item_data_cd",
    pickup_name_definite: "$item_data_cd_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_POWER_CUBE,
    classname: "key_power_cube",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/power/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_powercube",
    use_name: "Power Cube",
    pickup_name: "$item_power_cube",
    pickup_name_definite: "$item_power_cube_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_EXPLOSIVE_CHARGES,
    classname: "key_explosive_charges",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/n64/charge/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "n64/i_charges",
    use_name: "Explosive Charges",
    pickup_name: "$item_explosive_charges",
    pickup_name_definite: "$item_explosive_charges_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_YELLOW,
    classname: "key_yellow_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/n64/yellow_key/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "n64/i_yellow_key",
    use_name: "Yellow Key",
    pickup_name: "$item_yellow_key",
    pickup_name_definite: "$item_yellow_key_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_POWER_CORE,
    classname: "key_power_core",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/n64/power_core/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_pyramid",
    use_name: "Power Core",
    pickup_name: "$item_power_core",
    pickup_name_definite: "$item_power_core_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_PYRAMID,
    classname: "key_pyramid",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/pyramid/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_pyramid",
    use_name: "Pyramid Key",
    pickup_name: "$item_pyramid_key",
    pickup_name_definite: "$item_pyramid_key_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_DATA_SPINNER,
    classname: "key_data_spinner",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/spinner/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_dataspin",
    use_name: "Data Spinner",
    pickup_name: "$item_data_spinner",
    pickup_name_definite: "$item_data_spinner_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_PASS,
    classname: "key_pass",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/pass/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_security",
    use_name: "Security Pass",
    pickup_name: "$item_security_pass",
    pickup_name_definite: "$item_security_pass_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_BLUE_KEY,
    classname: "key_blue_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/key/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_bluekey",
    use_name: "Blue Key",
    pickup_name: "$item_blue_key",
    pickup_name_definite: "$item_blue_key_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_RED_KEY,
    classname: "key_red_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/red_key/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_redkey",
    use_name: "Red Key",
    pickup_name: "$item_red_key",
    pickup_name_definite: "$item_red_key_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_GREEN_KEY,
    classname: "key_green_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/green_key/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "k_green",
    use_name: "Green Key",
    pickup_name: "$item_green_key",
    pickup_name_definite: "$item_green_key_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_COMMANDER_HEAD,
    classname: "key_commander_head",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/monsters/commandr/head/tris.md2",
    world_model_flags: EF.EF_GIB,
    icon: "k_comhead",
    use_name: "Commander's Head",
    pickup_name: "$item_commanders_head",
    pickup_name_definite: "$item_commanders_head_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_AIRSTRIKE,
    classname: "key_airstrike_target",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/target/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_airstrike",
    use_name: "Airstrike Marker",
    pickup_name: "$item_airstrike_marker",
    pickup_name_definite: "$item_airstrike_marker_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_NUKE_CONTAINER,
    classname: "key_nuke_container",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_contain",
    use_name: "Antimatter Pod",
    pickup_name: "$item_antimatter_pod",
    pickup_name_definite: "$item_antimatter_pod_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),
  mkItem({
    id: ItemIdT.IT_KEY_NUKE,
    classname: "key_nuke",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "i_nuke",
    use_name: "Antimatter Bomb",
    pickup_name: "$item_antimatter_bomb",
    pickup_name_definite: "$item_antimatter_bomb_def",
    flags: IF.IF_STAY_COOP | IF.IF_KEY,
  }),

  //
  // HEALTH
  //
  mkItem({
    id: ItemIdT.IT_HEALTH_SMALL,
    classname: "item_health_small",
    pickup: Pickup_Health,
    pickup_sound: "items/s_health.wav",
    world_model: "models/items/healing/stimpack/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "i_health",
    use_name: "Health",
    pickup_name: "$item_stimpack",
    pickup_name_definite: "$item_stimpack_def",
    quantity: 2,
    flags: IF.IF_HEALTH,
    tag: HEALTH_IGNORE_MAX,
  }),
  mkItem({
    id: ItemIdT.IT_HEALTH_MEDIUM,
    classname: "item_health",
    pickup: Pickup_Health,
    pickup_sound: "items/n_health.wav",
    world_model: "models/items/healing/medium/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "i_health",
    use_name: "Health",
    pickup_name: "$item_small_medkit",
    pickup_name_definite: "$item_small_medkit_def",
    quantity: 10,
    flags: IF.IF_HEALTH,
  }),
  mkItem({
    id: ItemIdT.IT_HEALTH_LARGE,
    classname: "item_health_large",
    pickup: Pickup_Health,
    pickup_sound: "items/l_health.wav",
    world_model: "models/items/healing/large/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "i_health",
    use_name: "Health",
    pickup_name: "$item_large_medkit",
    pickup_name_definite: "$item_large_medkit", // NOT "..._def" -- see file header "QUIRKS"
    quantity: 25,
    flags: IF.IF_HEALTH,
  }),
  mkItem({
    id: ItemIdT.IT_HEALTH_MEGA,
    classname: "item_health_mega",
    pickup: Pickup_Health,
    pickup_sound: "items/m_health.wav",
    world_model: "models/items/mega_h/tris.md2",
    world_model_flags: EF.EF_NONE,
    icon: "p_megahealth",
    use_name: "Health",
    pickup_name: "$item_mega_health",
    pickup_name_definite: "$item_mega_health_def",
    quantity: 100,
    flags: IF.IF_HEALTH,
    tag: HEALTH_IGNORE_MAX | HEALTH_TIMED,
  }),

  //
  // CTF FLAGS
  //
  mkItem({
    id: ItemIdT.IT_FLAG1,
    classname: "item_flag_team1",
    pickup: CTFPickup_Flag,
    drop: CTFDrop_Flag,
    pickup_sound: "ctf/flagtk.wav",
    world_model: "players/male/flag1.md2",
    world_model_flags: EF.EF_FLAG1,
    icon: "i_ctf1",
    use_name: "Red Flag",
    pickup_name: "$item_red_flag",
    pickup_name_definite: "$item_red_flag_def",
    flags: IF.IF_NONE,
    precaches: "ctf/flagcap.wav",
  }),
  mkItem({
    id: ItemIdT.IT_FLAG2,
    classname: "item_flag_team2",
    pickup: CTFPickup_Flag,
    drop: CTFDrop_Flag,
    pickup_sound: "ctf/flagtk.wav",
    world_model: "players/male/flag2.md2",
    world_model_flags: EF.EF_FLAG2,
    icon: "i_ctf2",
    use_name: "Blue Flag",
    pickup_name: "$item_blue_flag",
    pickup_name_definite: "$item_blue_flag_def",
    flags: IF.IF_NONE,
    precaches: "ctf/flagcap.wav",
  }),

  //
  // TECHS
  //
  mkItem({
    id: ItemIdT.IT_TECH_RESISTANCE,
    classname: "item_tech1",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech,
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/resistance/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "tech1",
    use_name: "Disruptor Shield",
    pickup_name: "$item_disruptor_shield",
    pickup_name_definite: "$item_disruptor_shield_def",
    flags: IF.IF_TECH | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_TECH1,
    precaches: "ctf/tech1.wav",
  }),
  mkItem({
    id: ItemIdT.IT_TECH_STRENGTH,
    classname: "item_tech2",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech,
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/strength/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "tech2",
    use_name: "Power Amplifier",
    pickup_name: "$item_power_amplifier",
    pickup_name_definite: "$item_power_amplifier_def",
    flags: IF.IF_TECH | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_TECH2,
    precaches: "ctf/tech2.wav ctf/tech2x.wav",
  }),
  mkItem({
    id: ItemIdT.IT_TECH_HASTE,
    classname: "item_tech3",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech,
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/haste/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "tech3",
    use_name: "Time Accel",
    pickup_name: "$item_time_accel",
    pickup_name_definite: "$item_time_accel_def",
    flags: IF.IF_TECH | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_TECH3,
    precaches: "ctf/tech3.wav",
  }),
  mkItem({
    id: ItemIdT.IT_TECH_REGENERATION,
    classname: "item_tech4",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech,
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/regeneration/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "tech4",
    use_name: "AutoDoc",
    pickup_name: "$item_autodoc",
    pickup_name_definite: "$item_autodoc_def",
    flags: IF.IF_TECH | IF.IF_POWERUP_WHEEL,
    tag: PowerupT.POWERUP_TECH4,
    precaches: "ctf/tech4.wav",
  }),

  //
  // KEX ADDITIONS
  //
  mkItem({
    id: ItemIdT.IT_ITEM_FLASHLIGHT,
    classname: "item_flashlight",
    pickup: Pickup_General,
    use: Use_Flashlight,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/flashlight/tris.md2",
    world_model_flags: EF.EF_ROTATE | EF.EF_BOB,
    icon: "p_torch",
    use_name: "Flashlight",
    pickup_name: "$item_flashlight",
    pickup_name_definite: "$item_flashlight_def",
    flags: IF.IF_STAY_COOP | IF.IF_POWERUP_WHEEL | IF.IF_POWERUP_ONOFF | IF.IF_NOT_RANDOM,
    tag: PowerupT.POWERUP_FLASHLIGHT,
    precaches: "items/flashlight_on.wav items/flashlight_off.wav",
    sort_id: -1,
  }),
  mkItem({
    id: ItemIdT.IT_ITEM_COMPASS,
    classname: "item_compass",
    use: Use_Compass,
    world_model_flags: EF.EF_NONE,
    icon: "p_compass",
    use_name: "Compass",
    pickup_name: "$item_compass",
    pickup_name_definite: "$item_compass_def",
    flags: IF.IF_STAY_COOP | IF.IF_POWERUP_WHEEL | IF.IF_POWERUP_ONOFF,
    tag: PowerupT.POWERUP_COMPASS,
    precaches: "misc/help_marker.wav",
    sort_id: -2,
  }),
];

// ---------------------------------------------------------------------------
// load-time assertion -- itemlist.length === IT_TOTAL, id === index
// ---------------------------------------------------------------------------
// Runs at module import time (no `gi` dependency, so it works before any
// test/game bootstrap sets one up), mirroring the C++ source's own
// InitItems() integrity check (g_items.cpp:3904-3909) but earlier and
// unconditional -- see g_local_types.ts's own ItemIdT.IT_TOTAL comment
// ("must match itemlist order EXACTLY"), which this array is the direct
// enforcement of.

(function validateItemlist(): void {
  if (itemlist.length !== ItemIdT.IT_TOTAL) {
    throw new Error(`g_items: itemlist.length (${itemlist.length}) !== ItemIdT.IT_TOTAL (${ItemIdT.IT_TOTAL})`);
  }
  for (let i = 0; i < itemlist.length; i++) {
    const it = itemlist[i]!;
    if (it.id !== i) {
      throw new Error(`g_items: itemlist[${i}] has id ${it.id} (classname=${it.classname ?? "null"}); expected id === index`);
    }
  }
})();

// ---------------------------------------------------------------------------
// InitItems / G_CanDropItem / SetItemNames (g_items.cpp:3904-4055)
// ---------------------------------------------------------------------------

export function InitItems(): void {
  // validate item integrity -- see the load-time assertion above; this loop
  // can never actually fire its error branch as a result, but is kept for
  // structural fidelity with the C++ source.
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    const it: GitemT = itemlist[i]!;
    if (it.id !== i) {
      gi.Com_Error(`Item ${it.pickup_name ?? "?"} has wrong enum ID ${it.id} (should be ${i})`);
    }
  }

  // set up weapon chains
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    const item = itemlist[i]!;
    if (item.chain === ItemIdT.IT_NULL) continue;
    if (item.chain_next !== null) continue;

    const chain_item = itemlist[item.chain]!;

    if (chain_item.chain_next === null) chain_item.chain_next = chain_item;

    if (chain_item !== item) {
      let c = chain_item;
      while (c.chain_next !== chain_item) {
        if (c.chain_next === null) throw new Error(`InitItems: broken chain starting at ${chain_item.classname ?? "?"}`);
        c = c.chain_next;
      }
      item.chain_next = chain_item;
      c.chain_next = item;
    }
  }

  // set up ammo/powerup lookups
  for (const it of itemlist) {
    if ((it.flags & ItemFlagsT.IF_AMMO) !== 0 && it.tag >= AmmoT.AMMO_BULLETS && it.tag < AmmoT.AMMO_MAX) {
      ammolist[it.tag] = it;
    } else if ((it.flags & ItemFlagsT.IF_POWERUP_WHEEL) !== 0 && (it.flags & ItemFlagsT.IF_WEAPON) === 0 && it.tag >= PowerupT.POWERUP_SCREEN && it.tag < PowerupT.POWERUP_MAX) {
      poweruplist[it.tag] = it;
    }
  }

  // in coop without instanced items, remove IF_STAY_COOP items' drop ptr
  if (cvarBool("coop", "0", CvarFlagsT.CVAR_LATCH)) {
    for (const it of itemlist) {
      if (!P_UseCoopInstancedItems() && (it.flags & ItemFlagsT.IF_STAY_COOP) !== 0) {
        it.drop = null;
      }
    }
  }
}

/** g_items.cpp:3968: `inline bool G_CanDropItem(const gitem_t &item)`. */
function G_CanDropItem(item: GitemT): boolean {
  if (item.drop === null) return false;
  if ((item.flags & ItemFlagsT.IF_WEAPON) !== 0 && (item.flags & ItemFlagsT.IF_AMMO) === 0 && cvarBool("deathmatch", "0", CvarFlagsT.CVAR_LATCH) && cvarBool("g_dm_weapons_stay", "0", CvarFlagsT.CVAR_NOFLAGS)) {
    return false;
  }
  return true;
}

export function SetItemNames(): void {
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    gi.configstring(CS_ITEMS + i, itemlist[i]!.pickup_name ?? "");
  }

  let cs_index = 0;
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    const it = itemlist[i]!;
    if ((it.flags & ItemFlagsT.IF_AMMO) === 0) continue;
    if (cs_index >= MAX_WHEEL_ITEMS) gi.Com_Error("out of wheel indices");

    gi.configstring(CS_WHEEL_AMMO + cs_index, `${i}|${gi.imageindex(it.icon ?? "")}`);
    it.ammo_wheel_index = cs_index;
    cs_index++;
  }

  cs_index = 0;
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    const it = itemlist[i]!;
    if ((it.flags & ItemFlagsT.IF_WEAPON) === 0) continue;
    if (cs_index >= MAX_WHEEL_ITEMS) gi.Com_Error("out of wheel indices");

    const min_ammo = (it.flags & ItemFlagsT.IF_AMMO) !== 0 ? 1 : it.quantity;
    const ammoItem = it.ammo !== ItemIdT.IT_NULL ? GetItemByIndex(it.ammo) : null;
    const ammo_wheel_index = ammoItem !== null ? ammoItem.ammo_wheel_index : -1;

    gi.configstring(
      CS_WHEEL_WEAPONS + cs_index,
      `${i}|${gi.imageindex(it.icon ?? "")}|${ammo_wheel_index}|${min_ammo}|${(it.flags & ItemFlagsT.IF_POWERUP_WHEEL) !== 0 ? 1 : 0}|${it.sort_id}|${it.quantity_warn}|${G_CanDropItem(it) ? 1 : 0}`,
    );
    it.weapon_wheel_index = cs_index;
    cs_index++;
  }

  cs_index = 0;
  for (let i = ItemIdT.IT_NULL; i < ItemIdT.IT_TOTAL; i++) {
    const it = itemlist[i]!;
    if ((it.flags & ItemFlagsT.IF_POWERUP_WHEEL) === 0 || (it.flags & ItemFlagsT.IF_WEAPON) !== 0) continue;
    if (cs_index >= MAX_WHEEL_ITEMS) gi.Com_Error("out of wheel indices");

    const ammoItem = it.ammo !== ItemIdT.IT_NULL ? GetItemByIndex(it.ammo) : null;
    const ammo_wheel_index = ammoItem !== null ? ammoItem.ammo_wheel_index : -1;

    gi.configstring(
      CS_WHEEL_POWERUPS + cs_index,
      `${i}|${gi.imageindex(it.icon ?? "")}|${(it.flags & ItemFlagsT.IF_POWERUP_ONOFF) !== 0 ? 1 : 0}|${it.sort_id}|${G_CanDropItem(it) ? 1 : 0}|${ammo_wheel_index}`,
    );
    it.powerup_wheel_index = cs_index;
    cs_index++;
  }
}
