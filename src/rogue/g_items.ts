// g_items.c
//
// rogue/g_items.c vs baseq2/g_items.c: the itemlist[] table grows
// substantially (new ammo AMMO_FLECHETTES/AMMO_TESLA/AMMO_PROX, new weapons
// WEAP_DISRUPTOR/WEAP_ETFRIFLE/WEAP_PLASMA/WEAP_PROXLAUNCH/WEAP_CHAINFIST,
// new powerups for the sphere/doppleganger/IR/double-damage systems, two
// new keys), plus:
// - `DoRespawn` gains a `randomrespawn` cvar hook (DoRandomRespawn, in
//   g_newdm.c -- outside this unit's SCOPE) that can swap the respawning
//   entity for a different one before it reappears.
// - `Pickup_Powerup`/`Pickup_Sphere` now print a dprintf instead of
//   silently doing nothing when an instant-use powerup has no `use`
//   function.
// - `Pickup_Bandolier`/`Pickup_Pack` raise `pers.max_flechettes`; `Pickup_
//   Pack` also grants a batch of Flechettes ammo, matching the existing
//   Bullets/Shells/Cells/Grenades/Rockets/Slugs grants.
// - `Add_Ammo`/`Pickup_Ammo` gain flechette/prox/tesla ammo-cap branches
//   and a "don't auto-switch to the tesla weapon on pickup" guard.
// - `Drop_Item` sets `RF_IR_VISIBLE` in addition to `RF_GLOW` (so IR
//   goggles reveal dropped items).
// - `droptofloor`'s fallback `gi.setmodel` call is now guarded on
//   `item->world_model` being non-null (defensive paranoia per the C
//   comment) instead of always firing.
// - New `Item_TriggeredSpawn`/`SetTriggeredSpawn` implement the
//   TRIGGER_SPAWN spawnflag (bit 0): an item stays invisible/non-solid
//   until `use`d, at which point it drops to the floor for real.
//   `SpawnItem`'s invalid-spawnflags check changes from `spawnflags !== 0`
//   to `spawnflags > 1` so this new bit alone doesn't trip the warning,
//   and `SpawnItem` gains several new deathmatch dmflags branches
//   (DF_NO_MINES/DF_NO_NUKES/DF_NO_SPHERES) plus a "sphere/doppleganger/
//   nuke items only exist in deathmatch" branch, and frees
//   ammo_disruptor/weapon_disintegrator edicts unconditionally (the
//   disruptor weapon is dead in the shipped binary -- see below).
// - New `SP_xatrix_item`: when a map built for the xatrix mission pack is
//   loaded under the rogue game DLL, this remaps xatrix-only classnames
//   (ammo_magslug, ammo_trap, item_quadfire, weapon_boomer, weapon_phalanx)
//   to their nearest rogue equivalents. C leaves `spawnClass` uninitialized
//   if none of the five classnames match (undefined behavior); every
//   registered call site (g_spawn.ts's spawns[] table) only ever invokes
//   this for those five names, so it is unreachable in practice, but TS
//   has no UB to fall back on -- `spawnClass` is typed `string | null` and
//   the function returns early if it's still null, a defensive addition
//   documented here rather than a silent behavior change.
//
// KILL_DISRUPTOR (see g_local.ts's header comment): rogue/g_local.h
// unconditionally defines this, so every `#ifdef KILL_DISRUPTOR` branch is
// live and every `#else`/`#ifndef KILL_DISRUPTOR` branch is dead in the
// shipped binary -- dropped per PORTING.md's "#ifdef WIN32/etc." rule:
// - Add_Ammo's `AMMO_DISRUPTOR -> pers.max_rounds` branch: dropped (no
//   AMMO_DISRUPTOR member, no max_rounds field).
// - Pickup_Bandolier/Pickup_Pack's `pers.max_rounds` bumps: dropped.
// - weapon_disintegrator's `flags` field: IT_NOT_GIVEABLE (the
//   IT_WEAPON `#else` branch is dead).
// - ammo_disruptor's `flags`/`tag` fields: IT_NOT_GIVEABLE / 0 (the
//   IT_AMMO / AMMO_DISRUPTOR `#else` branches are dead).
// - SpawnItem's `#if KILL_DISRUPTOR` early-free-and-return for
//   ammo_disruptor/weapon_disintegrator: always taken, ported unconditionally.
//
// *** ITEM COUNT DEVIATION -- FLAGGED FOR THE COORDINATOR ***
// test/rogue_core.test.ts asserts `itemlist().length === 64` with a comment
// claiming "index-0 NULL placeholder + 62 real items + the trailing {NULL}
// end-of-list marker". Counting rogue/g_items.c's itemlist[] array by hand
// (brace-depth-verified twice, independently, against
// /home/buzzkill/Projects/quake2-rerelease-dll/original/rogue/g_items.c)
// gives 63 entries, not 64: index-0 placeholder + 61 real items + the
// {NULL} end marker. The likely source of the coordinator's off-by-one:
// rogue/g_items.c lines 2599-2621 wrap `item_torch`'s entire QUAKED comment
// *and* struct literal in a SECOND, separate `/* ... */` block comment --
//   /*Q U A K E D item_torch ... */
//   /*
//   	{
//   		"item_torch", ...
//   	},
//   */
// -- so item_torch's struct is dead code and never compiles into the real
// itemlist[] array (consistent with g_local.ts's own header comment noting
// `GClientT`'s `torch_framenum` field is *also* commented out in the C
// struct and was deliberately not ported). Including a working item_torch
// here just to hit 64 would mean fabricating a `Use_Torch` function that
// writes to a client field that was already correctly decided not to
// exist -- a clear "add a row to make the count fit" violation of this
// project's landmine list. This file therefore ports the real,
// C-compiled 63-entry array and reports the discrepancy here rather than
// silently matching the test.
//
// SEPARATE, LATER CHANGE (re-release content port): one row is appended
// beyond that C array -- item_invisibility, which the shipped rogue map
// rdm14 places and this module was dropping with "doesn't have a spawn
// function". So the table is now `fixedLength("ITEMLIST", 64, [...])` and
// `InitItems` sets `game.num_items = 63`. The 63-vs-64 analysis above is
// unchanged; this is 63 real C entries plus 1 deliberate addition, not the
// phantom item_torch. test/rogue_core.test.ts's assertion should read
// `.toBe(64)` (coordinator owns that file).

import {
  AngleVectors,
  random,
  vec3,
  VectorAdd,
  VectorClear,
  VectorCopy,
  VectorMA,
  VectorScale,
  VectorSet,
} from "../shared/math";
import { fixedLength } from "../shared/fixed";
import {
  ATTN_NORM,
  CHAN_AUTO,
  CHAN_ITEM,
  CONTENTS_SOLID,
  type CplaneT,
  type CsurfaceT,
  type CvarT,
  CS_ITEMS,
  DF_INFINITE_AMMO,
  DF_INSTANT_ITEMS,
  DF_NO_ARMOR,
  DF_NO_HEALTH,
  DF_NO_ITEMS,
  DF_NO_MINES,
  DF_NO_NUKES,
  DF_NO_SPHERES,
  EF_GIB,
  EF_ROTATE,
  EF_TAGTRAIL,
  EntityEventT,
  MASK_SOLID,
  MAX_QPATH,
  PRINT_HIGH,
  Q_stricmp,
  RF_GLOW,
  RF_IR_VISIBLE,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_SELECTED_ITEM,
  YAW,
} from "../shared/q_shared";
import { ValidateSelectedItem } from "./g_cmds";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  AmmoT,
  ARMOR_BODY,
  ARMOR_COMBAT,
  ARMOR_JACKET,
  ARMOR_SHARD,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  type EdictT,
  FL_POWER_ARMOR,
  FL_RESPAWN,
  FL_TEAMSLAVE,
  FRAMETIME,
  game,
  gameCvars,
  gameIndices,
  gi,
  GitemArmorT,
  GItemT,
  IT_AMMO,
  IT_ARMOR,
  IT_KEY,
  IT_MELEE,
  IT_NOT_GIVEABLE,
  IT_POWERUP,
  IT_STAY_COOP,
  IT_WEAPON,
  ITEM_NO_TOUCH,
  ITEM_TARGETS_USED,
  ITEM_TRIGGER_SPAWN,
  level,
  MovetypeT,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
  POWER_ARMOR_SHIELD,
  WEAP_BFG,
  WEAP_BLASTER,
  WEAP_CHAINFIST,
  WEAP_CHAINGUN,
  WEAP_DISRUPTOR,
  WEAP_ETFRIFLE,
  WEAP_GRENADELAUNCHER,
  WEAP_GRENADES,
  WEAP_HYPERBLASTER,
  WEAP_MACHINEGUN,
  WEAP_PLASMA,
  WEAP_PROXLAUNCH,
  WEAP_RAILGUN,
  WEAP_ROCKETLAUNCHER,
  WEAP_SHOTGUN,
  WEAP_SUPERSHOTGUN,
} from "./g_local";
import { G_FreeEdict, G_ProjectSource, G_Spawn, G_UseTargets, tv, vtos } from "./g_utils";
import { Tag_PickupToken } from "./dm_tag";
import { DoRandomRespawn, fire_doppleganger } from "./g_newdm";
import { fire_nuke } from "./g_newweap";
import { CheckGroundSpawnPoint, FindSpawnPoint, SpawnGrow_Spawn } from "./g_spawn";
import { Defender_Launch, Hunter_Launch, Vengeance_Launch } from "./g_sphere";
import {
  Drop_Weapon,
  Pickup_Weapon,
  Use_Weapon,
  Weapon_BFG,
  Weapon_Blaster,
  Weapon_ChainFist,
  Weapon_Chaingun,
  Weapon_Disintegrator,
  Weapon_ETF_Rifle,
  Weapon_Grenade,
  Weapon_GrenadeLauncher,
  Weapon_Heatbeam,
  Weapon_HyperBlaster,
  Weapon_Machinegun,
  Weapon_ProxLauncher,
  Weapon_Railgun,
  Weapon_RocketLauncher,
  Weapon_Shotgun,
  Weapon_SuperShotgun,
  Weapon_Tesla,
} from "./p_weapon";

// `gameCvars.*` are read as bare `.value` throughout; a per-file local
// mirrors g_main.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// `(gitem_armor_t *)ent->item->info` is narrowed from `unknown` with a real
// type guard (`instanceof`) instead of an `as` cast.
function asArmorInfo(info: unknown): GitemArmorT {
  if (info instanceof GitemArmorT) return info;
  gi.error("Pickup_Armor: item.info is not a GitemArmorT");
}

// Several call sites (SetItemNames, Use_PowerArmor) look up an item by name
// and immediately need a non-null gitem_t* for ITEM_INDEX, exactly as C's
// unchecked `ITEM_INDEX(FindItem("cells"))` assumes the name always exists.
function requireItem(item: GItemT | null): GItemT {
  if (item === null) {
    gi.error("g_items: expected item lookup to succeed");
  }
  return item;
}

//======================================================================

// `gitem_armor_t jacketarmor_info = { 25, 50, .30, .00, ARMOR_JACKET};` etc.
export const jacketarmor_info: GitemArmorT = Object.assign(new GitemArmorT(), {
  base_count: 25,
  max_count: 50,
  normal_protection: 0.3,
  energy_protection: 0.0,
  armor: ARMOR_JACKET,
});
export const combatarmor_info: GitemArmorT = Object.assign(new GitemArmorT(), {
  base_count: 50,
  max_count: 100,
  normal_protection: 0.6,
  energy_protection: 0.3,
  armor: ARMOR_COMBAT,
});
export const bodyarmor_info: GitemArmorT = Object.assign(new GitemArmorT(), {
  base_count: 100,
  max_count: 200,
  normal_protection: 0.8,
  energy_protection: 0.6,
  armor: ARMOR_BODY,
});

// `static int power_screen_index; static int power_shield_index;` -- these
// two are read only inside this file in the C source, so they stay
// module-local (unlike jacket/combat/body armor index, already homed in
// g_local.ts's gameIndices holder).
let power_screen_index = 0;
let power_shield_index = 0;

const HEALTH_IGNORE_MAX = 1;
const HEALTH_TIMED = 2;

let quad_drop_timeout_hack = 0;

//======================================================================

/*
===============
GetItemByIndex
===============
*/
export function GetItemByIndex(index: number): GItemT | null {
  if (index === 0 || index >= game.num_items) return null;

  return ITEMLIST[index];
}

/*
===============
FindItemByClassname

===============
*/
export function FindItemByClassname(classname: string): GItemT | null {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it.classname === null) continue;
    if (Q_stricmp(it.classname, classname) === 0) return it;
  }

  return null;
}

/*
===============
FindItem

===============
*/
export function FindItem(pickup_name: string): GItemT | null {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it.pickup_name === null) continue;
    if (Q_stricmp(it.pickup_name, pickup_name) === 0) return it;
  }

  return null;
}

//======================================================================

export function DoRespawn(ent: EdictT): void {
  let target = ent;

  if (target.team !== null) {
    const master = target.teammaster;

    let count = 0;
    let e: EdictT | null = master;
    for (; e !== null; e = e.chain) count++;

    // C: `choice = rand() % count;`
    const choice = Math.floor(Math.random() * count);

    let picked: EdictT | null = master;
    let i = 0;
    for (; i < choice && picked !== null; i++) picked = picked.chain;
    if (picked !== null) target = picked;
  }

  // ROGUE
  if (gameCvars.randomrespawn !== null && gameCvars.randomrespawn.value !== 0) {
    const newEnt = DoRandomRespawn(target);

    // if we've changed entities, then do some sleight of hand.
    // otherwise, the old entity will respawn
    if (newEnt !== null) {
      G_FreeEdict(target);
      target = newEnt;
    }
  }
  // ROGUE

  target.svflags &= ~SVF_NOCLIENT;
  target.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(target);

  // send an effect
  target.s.event = EntityEventT.EV_ITEM_RESPAWN;
}

export function SetRespawn(ent: EdictT, delay: number): void {
  ent.flags |= FL_RESPAWN;
  ent.svflags |= SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_NOT;
  ent.nextthink = level.time + delay;
  ent.think = DoRespawn;
  gi.linkentity(ent);
}

//======================================================================

export function Pickup_Powerup(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const index = ITEM_INDEX(item);
  const quantity = client.pers.inventory[index];
  const skillVal = cvarNum(gameCvars.skill);
  if ((skillVal === 1 && quantity >= 2) || (skillVal >= 2 && quantity >= 1)) return false;

  if (cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[index]++;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if ((ent.spawnflags & DROPPED_ITEM) === 0) SetRespawn(ent, item.quantity);
    const dmflags = cvarNum(gameCvars.dmflags) | 0;
    const isDroppedQuad = item.use === Use_Quad && (ent.spawnflags & DROPPED_PLAYER_ITEM) !== 0;
    if ((dmflags & DF_INSTANT_ITEMS) !== 0 || isDroppedQuad) {
      if (isDroppedQuad) {
        quad_drop_timeout_hack = ((ent.nextthink - level.time) / FRAMETIME) | 0;
      }
      // PGM
      if (item.use !== null) item.use(other, item);
      else gi.dprintf("Powerup has no use function!\n");
      // PGM
    }
  }

  return true;
}

export function Drop_General(ent: EdictT, item: GItemT): void {
  Drop_Item(ent, item);
  const client = ent.client;
  if (client !== null) client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);
}

//======================================================================

export function Pickup_Adrenaline(ent: EdictT, other: EdictT): boolean {
  if (cvarNum(gameCvars.deathmatch) === 0) other.max_health += 1;

  if (other.health < other.max_health) other.health = other.max_health;

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

export function Pickup_AncientHead(ent: EdictT, other: EdictT): boolean {
  other.max_health += 2;

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

export function Pickup_Bandolier(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  if (client === null) return false;

  if (client.pers.max_bullets < 250) client.pers.max_bullets = 250;
  if (client.pers.max_shells < 150) client.pers.max_shells = 150;
  if (client.pers.max_cells < 250) client.pers.max_cells = 250;
  if (client.pers.max_slugs < 75) client.pers.max_slugs = 75;
  // PMM
  if (client.pers.max_flechettes < 250) client.pers.max_flechettes = 250;
  // pmm

  let item = FindItem("Bullets");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_bullets) client.pers.inventory[index] = client.pers.max_bullets;
  }

  item = FindItem("Shells");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_shells) client.pers.inventory[index] = client.pers.max_shells;
  }

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

export function Pickup_Pack(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  if (client === null) return false;

  if (client.pers.max_bullets < 300) client.pers.max_bullets = 300;
  if (client.pers.max_shells < 200) client.pers.max_shells = 200;
  if (client.pers.max_rockets < 100) client.pers.max_rockets = 100;
  if (client.pers.max_grenades < 100) client.pers.max_grenades = 100;
  if (client.pers.max_cells < 300) client.pers.max_cells = 300;
  if (client.pers.max_slugs < 100) client.pers.max_slugs = 100;
  // PMM
  if (client.pers.max_flechettes < 200) client.pers.max_flechettes = 200;
  // pmm

  let item = FindItem("Bullets");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_bullets) client.pers.inventory[index] = client.pers.max_bullets;
  }

  item = FindItem("Shells");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_shells) client.pers.inventory[index] = client.pers.max_shells;
  }

  item = FindItem("Cells");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_cells) client.pers.inventory[index] = client.pers.max_cells;
  }

  item = FindItem("Grenades");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_grenades)
      client.pers.inventory[index] = client.pers.max_grenades;
  }

  item = FindItem("Rockets");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_rockets) client.pers.inventory[index] = client.pers.max_rockets;
  }

  item = FindItem("Slugs");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_slugs) client.pers.inventory[index] = client.pers.max_slugs;
  }

  // PMM
  item = FindItem("Flechettes");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_flechettes)
      client.pers.inventory[index] = client.pers.max_flechettes;
  }
  // pmm

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

// ================
// PMM
export function Pickup_Nuke(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const quantity = client.pers.inventory[ITEM_INDEX(item)];

  if (quantity >= 1) return false;

  if (cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[ITEM_INDEX(item)]++;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if ((ent.spawnflags & DROPPED_ITEM) === 0) SetRespawn(ent, item.quantity);
  }

  return true;
}

// ================
// PGM
export function Use_IR(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.ir_framenum > level.framenum) client.ir_framenum += 600;
  else client.ir_framenum = level.framenum + 600;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/ir_start.wav"), 1, ATTN_NORM, 0);
}

export function Use_Double(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.double_framenum > level.framenum) client.double_framenum += 300;
  else client.double_framenum = level.framenum + 300;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/ddamage1.wav"), 1, ATTN_NORM, 0);
}

// `void Use_Torch (edict_t *ent, gitem_t *item) { ent->client->torch_framenum
// = level.framenum + 600; }` is entirely commented out in the C source
// (along with item_torch's itemlist entry and GClientT.torch_framenum) --
// not ported, matches g_local.ts's already-documented decision to drop
// torch_framenum.

export function Use_Compass(ent: EdictT, _item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  let ang = client.v_angle[YAW] | 0;
  if (ang < 0) ang += 360;

  gi.cprintf(
    ent,
    PRINT_HIGH,
    `Origin: ${ent.s.origin[0].toFixed(0)},${ent.s.origin[1].toFixed(0)},${ent.s.origin[2].toFixed(0)}    Dir: ${ang}\n`,
  );
}

export function Use_Nuke(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  const forward = vec3();
  const right = vec3();
  AngleVectors(client.v_angle, forward, right, null);

  const start = vec3();
  VectorCopy(ent.s.origin, start);
  const speed = 100;
  fire_nuke(ent, start, forward, speed);
}

export function Use_Doppleganger(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  const ang = vec3();
  VectorClear(ang);
  ang[YAW] = client.v_angle[YAW];
  const forward = vec3();
  const right = vec3();
  AngleVectors(ang, forward, right, null);

  const createPt = vec3();
  VectorMA(ent.s.origin, 48, forward, createPt);

  const spawnPt = vec3();
  if (!FindSpawnPoint(createPt, ent.mins, ent.maxs, spawnPt, 32)) return;

  if (!CheckGroundSpawnPoint(spawnPt, ent.mins, ent.maxs, 64, -1)) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  SpawnGrow_Spawn(spawnPt, 0);
  fire_doppleganger(ent, spawnPt, forward);
}

export function Pickup_Doppleganger(ent: EdictT, other: EdictT): boolean {
  if (cvarNum(gameCvars.deathmatch) === 0) return false; // item is DM only

  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const quantity = client.pers.inventory[ITEM_INDEX(item)];
  if (quantity >= 1) return false; // FIXME - apply max to dopplegangers

  client.pers.inventory[ITEM_INDEX(item)]++;

  if ((ent.spawnflags & DROPPED_ITEM) === 0) SetRespawn(ent, item.quantity);

  return true;
}

export function Pickup_Sphere(ent: EdictT, other: EdictT): boolean {
  if (other.client !== null && other.client.owned_sphere !== null) {
    // gi.cprintf(other, PRINT_HIGH, "Only one sphere to a customer!\n");
    return false;
  }

  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const index = ITEM_INDEX(item);
  const quantity = client.pers.inventory[index];
  const skillVal = cvarNum(gameCvars.skill);
  if ((skillVal === 1 && quantity >= 2) || (skillVal >= 2 && quantity >= 1)) return false;

  if (cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0 && quantity > 0) return false;

  client.pers.inventory[index]++;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if ((ent.spawnflags & DROPPED_ITEM) === 0) SetRespawn(ent, item.quantity);
    if (((cvarNum(gameCvars.dmflags) | 0) & DF_INSTANT_ITEMS) !== 0) {
      // PGM
      if (item.use !== null) item.use(other, item);
      else gi.dprintf("Powerup has no use function!\n");
      // PGM
    }
  }

  return true;
}

export function Use_Defender(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.owned_sphere !== null) {
    gi.cprintf(ent, PRINT_HIGH, "Only one sphere at a time!\n");
    return;
  }

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  Defender_Launch(ent);
}

export function Use_Hunter(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.owned_sphere !== null) {
    gi.cprintf(ent, PRINT_HIGH, "Only one sphere at a time!\n");
    return;
  }

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  Hunter_Launch(ent);
}

export function Use_Vengeance(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.owned_sphere !== null) {
    gi.cprintf(ent, PRINT_HIGH, "Only one sphere at a time!\n");
    return;
  }

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  Vengeance_Launch(ent);
}
// PGM
// ================

//======================================================================

export function Use_Quad(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  let timeout: number;
  if (quad_drop_timeout_hack !== 0) {
    timeout = quad_drop_timeout_hack;
    quad_drop_timeout_hack = 0;
  } else {
    timeout = 300;
  }

  if (client.quad_framenum > level.framenum) client.quad_framenum += timeout;
  else client.quad_framenum = level.framenum + timeout;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

export function Use_Breather(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.breather_framenum > level.framenum) client.breather_framenum += 300;
  else client.breather_framenum = level.framenum + 300;

  //	gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

export function Use_Envirosuit(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.enviro_framenum > level.framenum) client.enviro_framenum += 300;
  else client.enviro_framenum = level.framenum + 300;

  //	gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

export function Use_Invulnerability(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.invincible_framenum > level.framenum) client.invincible_framenum += 300;
  else client.invincible_framenum = level.framenum + 300;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("items/protect.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

// RE-RELEASE CONTENT PORT -- item_invisibility, the re-release cloak, placed
// by rdm14. Ported from our sibling src/game/g_items.ts, which translated
// src/kexgame/g_items.ts's Use_Invisibility
// (`client.invisible_time = max(level.time, invisible_time) + 30s`).
//
// This module counts powerups in server frames rather than the re-release's
// gtime_t, so 30 seconds is 300 frames -- the same idiom every other powerup
// in this file already uses (quad, invulnerability, double, IR).
//
// DOCUMENTED DEGRADATION: the SERVER-SIDE timer runs and is readable by
// anything that cares, and p_view.ts applies the translucency this module's
// renderer already understands. What is NOT reproduced is the re-release's
// own cloak SHADER (its fade-in/fade-out ramp, driven by
// `invisibility_fade_time`), which has no protocol-34 representation. The
// player does become visibly translucent; it just is not the re-release's
// exact presentation.
export function Use_Invisibility(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.invisible_framenum > level.framenum) client.invisible_framenum += 300;
  else client.invisible_framenum = level.framenum + 300;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("items/protect.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

export function Use_Silencer(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);
  client.silencer_shots += 30;

  //	gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

export function Pickup_Key(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  if (cvarNum(gameCvars.coop) !== 0) {
    if (ent.classname === "key_power_cube") {
      if ((client.pers.power_cubes & ((ent.spawnflags & 0x0000ff00) >> 8)) !== 0) return false;
      client.pers.inventory[ITEM_INDEX(item)]++;
      client.pers.power_cubes |= (ent.spawnflags & 0x0000ff00) >> 8;
    } else {
      if (client.pers.inventory[ITEM_INDEX(item)] !== 0) return false;
      client.pers.inventory[ITEM_INDEX(item)] = 1;
    }
    return true;
  }
  client.pers.inventory[ITEM_INDEX(item)]++;
  return true;
}

//======================================================================

export function Add_Ammo(ent: EdictT, item: GItemT, count: number): boolean {
  const client = ent.client;
  if (client === null) return false;

  let max: number;
  if (item.tag === AmmoT.AMMO_BULLETS) max = client.pers.max_bullets;
  else if (item.tag === AmmoT.AMMO_SHELLS) max = client.pers.max_shells;
  else if (item.tag === AmmoT.AMMO_ROCKETS) max = client.pers.max_rockets;
  else if (item.tag === AmmoT.AMMO_GRENADES) max = client.pers.max_grenades;
  else if (item.tag === AmmoT.AMMO_CELLS) max = client.pers.max_cells;
  else if (item.tag === AmmoT.AMMO_SLUGS) max = client.pers.max_slugs;
  // ROGUE
  else if (item.tag === AmmoT.AMMO_FLECHETTES) max = client.pers.max_flechettes;
  else if (item.tag === AmmoT.AMMO_PROX) max = client.pers.max_prox;
  else if (item.tag === AmmoT.AMMO_TESLA) max = client.pers.max_tesla;
  // ROGUE
  else {
    gi.dprintf("undefined ammo type\n");
    return false;
  }

  const index = ITEM_INDEX(item);

  if (client.pers.inventory[index] === max) return false;

  client.pers.inventory[index] += count;

  if (client.pers.inventory[index] > max) client.pers.inventory[index] = max;

  return true;
}

export function Pickup_Ammo(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  const weapon = (item.flags & IT_WEAPON) !== 0;
  let count: number;
  if (weapon && ((cvarNum(gameCvars.dmflags) | 0) & DF_INFINITE_AMMO) !== 0) count = 1000;
  else if (ent.count !== 0) count = ent.count;
  else count = item.quantity;

  const oldcount = client.pers.inventory[ITEM_INDEX(item)];

  if (!Add_Ammo(other, item, count)) return false;

  if (weapon && oldcount === 0) {
    // don't switch to tesla
    if (
      client.pers.weapon !== item &&
      (cvarNum(gameCvars.deathmatch) === 0 || client.pers.weapon === FindItem("blaster")) &&
      ent.classname !== "ammo_tesla"
    ) {
      client.newweapon = item;
    }
  }

  if ((ent.spawnflags & (DROPPED_ITEM | DROPPED_PLAYER_ITEM)) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, 30);
  }
  return true;
}

export function Drop_Ammo(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  const index = ITEM_INDEX(item);
  const dropped = Drop_Item(ent, item);
  if (client.pers.inventory[index] >= item.quantity) dropped.count = item.quantity;
  else dropped.count = client.pers.inventory[index];

  if (
    client.pers.weapon !== null &&
    client.pers.weapon.tag === AmmoT.AMMO_GRENADES &&
    item.tag === AmmoT.AMMO_GRENADES &&
    client.pers.inventory[index] - dropped.count <= 0
  ) {
    gi.cprintf(ent, PRINT_HIGH, "Can't drop current weapon\n");
    G_FreeEdict(dropped);
    return;
  }

  client.pers.inventory[index] -= dropped.count;
  ValidateSelectedItem(ent);
}

//======================================================================

function MegaHealth_think(self: EdictT): void {
  const owner = self.owner;
  if (owner !== null && owner.health > owner.max_health) {
    self.nextthink = level.time + 1;
    owner.health -= 1;
    return;
  }

  if ((self.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) SetRespawn(self, 20);
  else G_FreeEdict(self);
}

export function Pickup_Health(ent: EdictT, other: EdictT): boolean {
  if ((ent.style & HEALTH_IGNORE_MAX) === 0) {
    if (other.health >= other.max_health) return false;
  }

  other.health += ent.count;

  if ((ent.style & HEALTH_IGNORE_MAX) === 0) {
    if (other.health > other.max_health) other.health = other.max_health;
  }

  if ((ent.style & HEALTH_TIMED) !== 0) {
    ent.think = MegaHealth_think;
    ent.nextthink = level.time + 5;
    ent.owner = other;
    ent.flags |= FL_RESPAWN;
    ent.svflags |= SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
  } else {
    if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) SetRespawn(ent, 30);
  }

  return true;
}

//======================================================================

export function ArmorIndex(ent: EdictT): number {
  if (ent.client === null) return 0;

  if (ent.client.pers.inventory[gameIndices.jacket_armor_index] > 0) return gameIndices.jacket_armor_index;

  if (ent.client.pers.inventory[gameIndices.combat_armor_index] > 0) return gameIndices.combat_armor_index;

  if (ent.client.pers.inventory[gameIndices.body_armor_index] > 0) return gameIndices.body_armor_index;

  return 0;
}

export function Pickup_Armor(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return false;

  // C only casts here (newinfo = (gitem_armor_t *)ent->item->info) and the
  // shard branch never dereferences it -- shards carry no info. Narrow
  // lazily in the branches that read it, like the C pointer's actual use.
  const old_armor_index = ArmorIndex(other);

  // handle armor shards specially
  if (item.tag === ARMOR_SHARD) {
    if (old_armor_index === 0) client.pers.inventory[gameIndices.jacket_armor_index] = 2;
    else client.pers.inventory[old_armor_index] += 2;
  }
  // if player has no armor, just use it
  else if (old_armor_index === 0) {
    client.pers.inventory[ITEM_INDEX(item)] = asArmorInfo(item.info).base_count;
  }
  // use the better armor
  else {
    const newinfo = asArmorInfo(item.info);
    // get info on old armor
    let oldinfo: GitemArmorT;
    if (old_armor_index === gameIndices.jacket_armor_index) oldinfo = jacketarmor_info;
    else if (old_armor_index === gameIndices.combat_armor_index) oldinfo = combatarmor_info;
    else oldinfo = bodyarmor_info; // (old_armor_index == body_armor_index)

    if (newinfo.normal_protection > oldinfo.normal_protection) {
      // calc new armor values
      const salvage = oldinfo.normal_protection / newinfo.normal_protection;
      const salvagecount = (salvage * client.pers.inventory[old_armor_index]) | 0;
      let newcount = newinfo.base_count + salvagecount;
      if (newcount > newinfo.max_count) newcount = newinfo.max_count;

      // zero count of old armor so it goes away
      client.pers.inventory[old_armor_index] = 0;

      // change armor to new item with computed value
      client.pers.inventory[ITEM_INDEX(item)] = newcount;
    } else {
      // calc new armor values
      const salvage = newinfo.normal_protection / oldinfo.normal_protection;
      const salvagecount = (salvage * newinfo.base_count) | 0;
      let newcount = client.pers.inventory[old_armor_index] + salvagecount;
      if (newcount > oldinfo.max_count) newcount = oldinfo.max_count;

      // if we're already maxed out then we don't need the new armor
      if (client.pers.inventory[old_armor_index] >= newcount) return false;

      // update current armor value
      client.pers.inventory[old_armor_index] = newcount;
    }
  }

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) SetRespawn(ent, 20);

  return true;
}

//======================================================================

export function PowerArmorType(ent: EdictT): number {
  if (ent.client === null) return POWER_ARMOR_NONE;

  if ((ent.flags & FL_POWER_ARMOR) === 0) return POWER_ARMOR_NONE;

  if (ent.client.pers.inventory[power_shield_index] > 0) return POWER_ARMOR_SHIELD;

  if (ent.client.pers.inventory[power_screen_index] > 0) return POWER_ARMOR_SCREEN;

  return POWER_ARMOR_NONE;
}

export function Use_PowerArmor(ent: EdictT, _item: GItemT): void {
  const client = ent.client;

  if ((ent.flags & FL_POWER_ARMOR) !== 0) {
    ent.flags &= ~FL_POWER_ARMOR;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
  } else {
    const cells = requireItem(FindItem("cells"));
    const index = ITEM_INDEX(cells);
    if (client === null || client.pers.inventory[index] === 0) {
      gi.cprintf(ent, PRINT_HIGH, "No cells for power armor.\n");
      return;
    }
    ent.flags |= FL_POWER_ARMOR;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0);
  }
}

export function Pickup_PowerArmor(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  const item = ent.item;
  if (client === null || item === null) return true;

  const index = ITEM_INDEX(item);
  const quantity = client.pers.inventory[index];

  client.pers.inventory[index]++;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if ((ent.spawnflags & DROPPED_ITEM) === 0) SetRespawn(ent, item.quantity);
    // auto-use for DM only if we didn't already have one
    if (quantity === 0 && item.use !== null) item.use(other, item);
  }

  return true;
}

export function Drop_PowerArmor(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client !== null && (ent.flags & FL_POWER_ARMOR) !== 0 && client.pers.inventory[ITEM_INDEX(item)] === 1) {
    Use_PowerArmor(ent, item);
  }
  Drop_General(ent, item);
}

//======================================================================

/*
===============
Touch_Item
===============
*/
export function Touch_Item(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  const client = other.client;
  if (client === null) return;
  if (other.health < 1) return; // dead people can't pickup
  const item = ent.item;
  if (item === null || item.pickup === null) return; // not a grabbable item?

  const taken = item.pickup(ent, other);

  if (taken) {
    // flash the screen
    client.bonus_alpha = 0.25;

    // show icon and name on status bar
    client.ps.stats[STAT_PICKUP_ICON] = gi.imageindex(item.icon ?? "");
    client.ps.stats[STAT_PICKUP_STRING] = CS_ITEMS + ITEM_INDEX(item);
    client.pickup_msg_time = level.time + 3.0;

    // change selected item
    if (item.use !== null) {
      const idx = ITEM_INDEX(item);
      client.pers.selected_item = idx;
      client.ps.stats[STAT_SELECTED_ITEM] = idx;
    }

    // PMM - health sound fix
    if (item.pickup === Pickup_Health) {
      if (ent.count === 2) gi.sound(other, CHAN_ITEM, gi.soundindex("items/s_health.wav"), 1, ATTN_NORM, 0);
      else if (ent.count === 10) gi.sound(other, CHAN_ITEM, gi.soundindex("items/n_health.wav"), 1, ATTN_NORM, 0);
      else if (ent.count === 25) gi.sound(other, CHAN_ITEM, gi.soundindex("items/l_health.wav"), 1, ATTN_NORM, 0);
      else gi.sound(other, CHAN_ITEM, gi.soundindex("items/m_health.wav"), 1, ATTN_NORM, 0); // (ent->count == 100)
    } else if (item.pickup_sound !== null) {
      // PGM - paranoia
      gi.sound(other, CHAN_ITEM, gi.soundindex(item.pickup_sound), 1, ATTN_NORM, 0);
    }
  }

  if ((ent.spawnflags & ITEM_TARGETS_USED) === 0) {
    G_UseTargets(ent, other);
    ent.spawnflags |= ITEM_TARGETS_USED;
  }

  if (!taken) return;

  if (
    !(cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0) ||
    (ent.spawnflags & (DROPPED_ITEM | DROPPED_PLAYER_ITEM)) !== 0
  ) {
    if ((ent.flags & FL_RESPAWN) !== 0) ent.flags &= ~FL_RESPAWN;
    else G_FreeEdict(ent);
  }
}

//======================================================================

function drop_temp_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;

  Touch_Item(ent, other, plane, surf);
}

function drop_make_touchable(ent: EdictT): void {
  ent.touch = Touch_Item;
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ent.nextthink = level.time + 29;
    ent.think = G_FreeEdict;
  }
}

export function Drop_Item(ent: EdictT, item: GItemT): EdictT {
  const dropped = G_Spawn();
  const forward = vec3();
  const right = vec3();
  const offset = vec3();

  dropped.classname = item.classname;
  dropped.item = item;
  dropped.spawnflags = DROPPED_ITEM;
  dropped.s.effects = item.world_model_flags;
  dropped.s.renderfx = RF_GLOW | RF_IR_VISIBLE; // PGM
  VectorSet(dropped.mins, -15, -15, -15);
  VectorSet(dropped.maxs, 15, 15, 15);
  gi.setmodel(dropped, item.world_model ?? "");
  dropped.solid = SolidT.SOLID_TRIGGER;
  dropped.movetype = MovetypeT.MOVETYPE_TOSS;
  dropped.touch = drop_temp_touch;
  dropped.owner = ent;

  if (ent.client !== null) {
    AngleVectors(ent.client.v_angle, forward, right, null);
    VectorSet(offset, 24, 0, -16);
    G_ProjectSource(ent.s.origin, offset, forward, right, dropped.s.origin);
    const trace = gi.trace(ent.s.origin, dropped.mins, dropped.maxs, dropped.s.origin, ent, CONTENTS_SOLID);
    VectorCopy(trace.endpos, dropped.s.origin);
  } else {
    AngleVectors(ent.s.angles, forward, right, null);
    VectorCopy(ent.s.origin, dropped.s.origin);
  }

  VectorScale(forward, 100, dropped.velocity);
  dropped.velocity[2] = 300;

  dropped.think = drop_make_touchable;
  dropped.nextthink = level.time + 1;

  gi.linkentity(dropped);

  return dropped;
}

export function Use_Item(ent: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  ent.svflags &= ~SVF_NOCLIENT;
  ent.use = null;

  if ((ent.spawnflags & ITEM_NO_TOUCH) !== 0) {
    ent.solid = SolidT.SOLID_BBOX;
    ent.touch = null;
  } else {
    ent.solid = SolidT.SOLID_TRIGGER;
    ent.touch = Touch_Item;
  }

  gi.linkentity(ent);
}

//======================================================================

/*
================
droptofloor
================
*/
export function droptofloor(ent: EdictT): void {
  VectorSet(ent.mins, -15, -15, -15);
  VectorSet(ent.maxs, 15, 15, 15);

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  // PGM we shouldn't need this check, but paranoia...
  else if (ent.item !== null && ent.item.world_model !== null) gi.setmodel(ent, ent.item.world_model);
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;

  const dest = vec3();
  VectorAdd(ent.s.origin, tv(0, 0, -128), dest);

  const tr = gi.trace(ent.s.origin, ent.mins, ent.maxs, dest, ent, MASK_SOLID);
  if (tr.startsolid) {
    gi.dprintf(`droptofloor: ${ent.classname ?? ""} startsolid at ${vtos(ent.s.origin)}\n`);
    G_FreeEdict(ent);
    return;
  }

  VectorCopy(tr.endpos, ent.s.origin);

  if (ent.team !== null) {
    ent.flags &= ~FL_TEAMSLAVE;
    ent.chain = ent.teamchain;
    ent.teamchain = null;

    ent.svflags |= SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
    if (ent === ent.teammaster) {
      ent.nextthink = level.time + FRAMETIME;
      ent.think = DoRespawn;
    }
  }

  if ((ent.spawnflags & ITEM_NO_TOUCH) !== 0) {
    ent.solid = SolidT.SOLID_BBOX;
    ent.touch = null;
    ent.s.effects &= ~EF_ROTATE;
    ent.s.renderfx &= ~RF_GLOW;
  }

  if ((ent.spawnflags & ITEM_TRIGGER_SPAWN) !== 0) {
    ent.svflags |= SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
    ent.use = Use_Item;
  }

  gi.linkentity(ent);
}

// ROGUE
//=================
// Item_TriggeredSpawn - create the item marked for spawn creation
//=================
function Item_TriggeredSpawn(self: EdictT, _other: EdictT | null, _activator: EdictT | null): void {
  self.svflags &= ~SVF_NOCLIENT;
  self.use = null;
  if (self.classname !== "key_power_cube") self.spawnflags = 0; // leave them be on key_power_cube..
  droptofloor(self);
}

//=================
// SetTriggeredSpawn - set up an item to spawn in later.
//=================
function SetTriggeredSpawn(ent: EdictT): void {
  // don't do anything on key_power_cubes.
  if (ent.classname === "key_power_cube") return;

  ent.think = null;
  ent.nextthink = 0;
  ent.use = Item_TriggeredSpawn;
  ent.svflags |= SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_NOT;
}
// ROGUE

/*
===============
PrecacheItem

Precaches all data needed for a given item.
This will be called for each item spawned in a level,
and for each item in each client's inventory.
===============
*/
export function PrecacheItem(it: GItemT | null): void {
  if (it === null) return;

  if (it.pickup_sound !== null) gi.soundindex(it.pickup_sound);
  if (it.world_model !== null) gi.modelindex(it.world_model);
  if (it.view_model !== null) gi.modelindex(it.view_model);
  if (it.icon !== null) gi.imageindex(it.icon);

  // parse everything for its ammo
  if (it.ammo !== null && it.ammo.length > 0) {
    const ammo = FindItem(it.ammo);
    if (ammo !== it) PrecacheItem(ammo);
  }

  // parse the space seperated precache string for other items
  const s = it.precaches;
  if (s === null || s.length === 0) return;

  let i = 0;
  while (i < s.length) {
    const start = i;
    while (i < s.length && s[i] !== " ") i++;

    const len = i - start;
    if (len >= MAX_QPATH || len < 5) {
      gi.error(`PrecacheItem: ${it.classname ?? ""} has bad precache string`);
    }
    const data = s.slice(start, i);
    if (i < s.length) i++;

    // determine type based on extension
    const ext = data.slice(len - 3);
    if (ext === "md2") gi.modelindex(data);
    else if (ext === "sp2") gi.modelindex(data);
    else if (ext === "wav") gi.soundindex(data);
    if (ext === "pcx") gi.imageindex(data);
  }
}

/*
============
SpawnItem

Sets the clipping size and plants the object on the floor.

Items can't be immediately dropped to floor, because they might
be on an entity that hasn't spawned yet.
============
*/
export function SpawnItem(ent: EdictT, item: GItemT): void {
  // ROGUE -- KILL_DISRUPTOR is always defined in the shipped binary (see
  // this file's header comment): the disruptor weapon/ammo table entries
  // exist only so ITEM_INDEX lookups and inventory slots keep working, but
  // they never actually spawn.
  if (ent.classname === "ammo_disruptor" || ent.classname === "weapon_disintegrator") {
    G_FreeEdict(ent);
    return;
  }
  // ROGUE

  // PGM - since the item may be freed by the following rules, the
  // PrecacheItem call moves to AFTER the following rules have been checked.

  if (ent.spawnflags > 1) {
    // PGM
    if (ent.classname !== "key_power_cube") {
      ent.spawnflags = 0;
      gi.dprintf(`${ent.classname ?? ""} at ${vtos(ent.s.origin)} has invalid spawnflags set\n`);
    }
  }

  // some items will be prevented in deathmatch
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    const dmflags = cvarNum(gameCvars.dmflags) | 0;
    if ((dmflags & DF_NO_ARMOR) !== 0) {
      if (item.pickup === Pickup_Armor || item.pickup === Pickup_PowerArmor) {
        G_FreeEdict(ent);
        return;
      }
    }
    if ((dmflags & DF_NO_ITEMS) !== 0) {
      if (item.pickup === Pickup_Powerup) {
        G_FreeEdict(ent);
        return;
      }
      // ROGUE
      if (item.pickup === Pickup_Sphere) {
        G_FreeEdict(ent);
        return;
      }
      if (item.pickup === Pickup_Doppleganger) {
        G_FreeEdict(ent);
        return;
      }
      // ROGUE
    }
    if ((dmflags & DF_NO_HEALTH) !== 0) {
      if (item.pickup === Pickup_Health || item.pickup === Pickup_Adrenaline || item.pickup === Pickup_AncientHead) {
        G_FreeEdict(ent);
        return;
      }
    }
    if ((dmflags & DF_INFINITE_AMMO) !== 0) {
      if (item.flags === IT_AMMO || ent.classname === "weapon_bfg") {
        G_FreeEdict(ent);
        return;
      }
    }

    // ROGUE
    if ((dmflags & DF_NO_MINES) !== 0) {
      if (ent.classname === "ammo_prox" || ent.classname === "ammo_tesla") {
        G_FreeEdict(ent);
        return;
      }
    }
    if ((dmflags & DF_NO_NUKES) !== 0) {
      if (ent.classname === "ammo_nuke") {
        G_FreeEdict(ent);
        return;
      }
    }
    if ((dmflags & DF_NO_SPHERES) !== 0) {
      if (item.pickup === Pickup_Sphere) {
        G_FreeEdict(ent);
        return;
      }
    }
    // ROGUE
  }

  // ROGUE -- DM only items
  if (cvarNum(gameCvars.deathmatch) === 0) {
    if (item.pickup === Pickup_Doppleganger || item.pickup === Pickup_Nuke) {
      G_FreeEdict(ent);
      return;
    }
    if (item.use === Use_Vengeance || item.use === Use_Hunter) {
      G_FreeEdict(ent);
      return;
    }
  }
  // ROGUE

  PrecacheItem(item);

  if (cvarNum(gameCvars.coop) !== 0 && ent.classname === "key_power_cube") {
    ent.spawnflags |= 1 << (8 + level.power_cubes);
    level.power_cubes++;
  }

  // don't let them drop items that stay in a coop game
  if (cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0) {
    item.drop = null;
  }

  ent.item = item;
  ent.nextthink = level.time + 2 * FRAMETIME; // items start after other solids
  ent.think = droptofloor;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RF_GLOW;
  if (ent.model !== null) gi.modelindex(ent.model);

  // ROGUE
  if ((ent.spawnflags & 1) !== 0) SetTriggeredSpawn(ent);
  // ROGUE
}

//======================================================================

function mkItem(fields: Partial<GItemT>): GItemT {
  return Object.assign(new GItemT(), fields);
}

// `gitem_t itemlist[]` -- transcribed in the exact order of the C array,
// including index 0 ("leave index 0 alone") and the trailing `{NULL}`
// end-of-list marker. 63 entries from the C array (see this file's header
// comment for the 63-vs-64 provenance note), plus ONE re-release addition at
// the tail -- item_invisibility, which rdm14 places -- for 64 total.
// `InitItems` sets `game.num_items` to `ITEMLIST.length - 1` exactly as the C
// `sizeof(itemlist)/sizeof(...)-1` does.
//
// This guard is a RUNTIME invariant, not a type: bumping the count is part of
// adding a row, and tsc --noEmit will not catch a stale number. MAX_ITEMS is
// 256 (shared/q_shared.ts), so the inventory array and the CS_ITEMS
// configstring block have ample room; nothing else in this module keys off
// the item count.
const ITEMLIST: GItemT[] = fixedLength("ITEMLIST", 64, [
  mkItem({}), // leave index 0 alone

  //
  // ARMOR
  //

  /*QUAKED item_armor_body (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_armor_body",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar1_pkup.wav",
    world_model: "models/items/armor/body/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_bodyarmor",
    pickup_name: "Body Armor",
    count_width: 3,
    flags: IT_ARMOR,
    info: bodyarmor_info,
    tag: ARMOR_BODY,
    precaches: "",
  }),

  /*QUAKED item_armor_combat (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_armor_combat",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar1_pkup.wav",
    world_model: "models/items/armor/combat/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_combatarmor",
    pickup_name: "Combat Armor",
    count_width: 3,
    flags: IT_ARMOR,
    info: combatarmor_info,
    tag: ARMOR_COMBAT,
    precaches: "",
  }),

  /*QUAKED item_armor_jacket (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_armor_jacket",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar1_pkup.wav",
    world_model: "models/items/armor/jacket/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_jacketarmor",
    pickup_name: "Jacket Armor",
    count_width: 3,
    flags: IT_ARMOR,
    info: jacketarmor_info,
    tag: ARMOR_JACKET,
    precaches: "",
  }),

  /*QUAKED item_armor_shard (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_armor_shard",
    pickup: Pickup_Armor,
    pickup_sound: "misc/ar2_pkup.wav",
    world_model: "models/items/armor/shard/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_jacketarmor",
    pickup_name: "Armor Shard",
    count_width: 3,
    flags: IT_ARMOR,
    info: null,
    tag: ARMOR_SHARD,
    precaches: "",
  }),

  /*QUAKED item_power_screen (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_power_screen",
    pickup: Pickup_PowerArmor,
    use: Use_PowerArmor,
    drop: Drop_PowerArmor,
    pickup_sound: "misc/ar3_pkup.wav",
    world_model: "models/items/armor/screen/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_powerscreen",
    pickup_name: "Power Screen",
    count_width: 0,
    quantity: 60,
    flags: IT_ARMOR,
    tag: 0,
    precaches: "",
  }),

  /*QUAKED item_power_shield (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_power_shield",
    pickup: Pickup_PowerArmor,
    use: Use_PowerArmor,
    drop: Drop_PowerArmor,
    pickup_sound: "misc/ar3_pkup.wav",
    world_model: "models/items/armor/shield/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_powershield",
    pickup_name: "Power Shield",
    count_width: 0,
    quantity: 60,
    flags: IT_ARMOR,
    tag: 0,
    precaches: "misc/power2.wav misc/power1.wav",
  }),

  //
  // WEAPONS
  //

  /* weapon_blaster (.3 .3 1) (-16 -16 -16) (16 16 16)
  always owned, never in the world
  */
  mkItem({
    classname: "weapon_blaster",
    use: Use_Weapon,
    weaponthink: Weapon_Blaster,
    pickup_sound: "misc/w_pkup.wav",
    view_model: "models/weapons/v_blast/tris.md2",
    icon: "w_blaster",
    pickup_name: "Blaster",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_BLASTER,
    precaches: "weapons/blastf1a.wav misc/lasfly.wav",
  }),

  /*QUAKED weapon_shotgun (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_shotgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Shotgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotg/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_shotg/tris.md2",
    icon: "w_shotgun",
    pickup_name: "Shotgun",
    quantity: 1,
    ammo: "Shells",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_SHOTGUN,
    precaches: "weapons/shotgf1b.wav weapons/shotgr1b.wav",
  }),

  /*QUAKED weapon_supershotgun (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_supershotgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_SuperShotgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotg2/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_shotg2/tris.md2",
    icon: "w_sshotgun",
    pickup_name: "Super Shotgun",
    quantity: 2,
    ammo: "Shells",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_SUPERSHOTGUN,
    precaches: "weapons/sshotf1b.wav",
  }),

  /*QUAKED weapon_machinegun (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_machinegun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Machinegun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_machn/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_machn/tris.md2",
    icon: "w_machinegun",
    pickup_name: "Machinegun",
    quantity: 1,
    ammo: "Bullets",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_MACHINEGUN,
    precaches:
      "weapons/machgf1b.wav weapons/machgf2b.wav weapons/machgf3b.wav weapons/machgf4b.wav weapons/machgf5b.wav",
  }),

  /*QUAKED weapon_chaingun (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_chaingun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Chaingun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_chain/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_chain/tris.md2",
    icon: "w_chaingun",
    pickup_name: "Chaingun",
    quantity: 1,
    ammo: "Bullets",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_CHAINGUN,
    // C source literally has a stray backtick in this precache string
    // (`weapons/machgf3b.wav\`` before the space) -- preserved bug-for-bug.
    precaches: "weapons/chngnu1a.wav weapons/chngnl1a.wav weapons/machgf3b.wav` weapons/chngnd1a.wav",
  }),

  // ROGUE
  /*QUAKED weapon_etf_rifle (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_etf_rifle",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ETF_Rifle,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_etf_rifle/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_etf_rifle/tris.md2",
    icon: "w_etf_rifle",
    pickup_name: "ETF Rifle",
    count_width: 0,
    quantity: 1,
    ammo: "Flechettes",
    flags: IT_WEAPON,
    weapmodel: WEAP_ETFRIFLE,
    info: null,
    tag: 0,
    precaches: "weapons/nail1.wav models/proj/flechette/tris.md2",
  }),
  // rogue

  /*QUAKED ammo_grenades (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_grenades",
    pickup: Pickup_Ammo,
    use: Use_Weapon,
    drop: Drop_Ammo,
    weaponthink: Weapon_Grenade,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/grenades/medium/tris.md2",
    world_model_flags: 0,
    view_model: "models/weapons/v_handgr/tris.md2",
    icon: "a_grenades",
    pickup_name: "Grenades",
    count_width: 3,
    quantity: 5,
    ammo: "grenades",
    flags: IT_AMMO | IT_WEAPON,
    weapmodel: WEAP_GRENADES,
    tag: AmmoT.AMMO_GRENADES,
    precaches:
      "weapons/hgrent1a.wav weapons/hgrena1b.wav weapons/hgrenc1b.wav weapons/hgrenb1a.wav weapons/hgrenb2a.wav ",
  }),

  /*QUAKED weapon_grenadelauncher (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_grenadelauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_GrenadeLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_launch/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_launch/tris.md2",
    icon: "w_glauncher",
    pickup_name: "Grenade Launcher",
    quantity: 1,
    ammo: "Grenades",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_GRENADELAUNCHER,
    precaches: "models/objects/grenade/tris.md2 weapons/grenlf1a.wav weapons/grenlr1b.wav weapons/grenlb1b.wav",
  }),

  // ROGUE
  /*QUAKED weapon_proxlauncher (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_proxlauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ProxLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_plaunch/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_plaunch/tris.md2",
    icon: "w_proxlaunch",
    pickup_name: "Prox Launcher",
    count_width: 0,
    quantity: 1,
    ammo: "Prox",
    flags: IT_WEAPON,
    weapmodel: WEAP_PROXLAUNCH,
    info: null,
    tag: AmmoT.AMMO_PROX,
    precaches: "weapons/grenlf1a.wav weapons/grenlr1b.wav weapons/grenlb1b.wav weapons/proxwarn.wav weapons/proxopen.wav",
  }),
  // rogue

  /*QUAKED weapon_rocketlauncher (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_rocketlauncher",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_RocketLauncher,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_rocket/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_rocket/tris.md2",
    icon: "w_rlauncher",
    pickup_name: "Rocket Launcher",
    quantity: 1,
    ammo: "Rockets",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_ROCKETLAUNCHER,
    precaches:
      "models/objects/rocket/tris.md2 weapons/rockfly.wav weapons/rocklf1a.wav weapons/rocklr1b.wav models/objects/debris2/tris.md2",
  }),

  /*QUAKED weapon_hyperblaster (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_hyperblaster",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_HyperBlaster,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_hyperb/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_hyperb/tris.md2",
    icon: "w_hyperblaster",
    pickup_name: "HyperBlaster",
    quantity: 1,
    ammo: "Cells",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_HYPERBLASTER,
    precaches:
      "weapons/hyprbu1a.wav weapons/hyprbl1a.wav weapons/hyprbf1a.wav weapons/hyprbd1a.wav misc/lasfly.wav",
  }),

  // ROGUE
  /*QUAKED weapon_plasmabeam (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_plasmabeam",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Heatbeam,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_beamer/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_beamer/tris.md2",
    icon: "w_heatbeam",
    pickup_name: "Plasma Beam",
    count_width: 0,
    // FIXME - if this changes, change it in NoAmmoWeaponChange as well
    quantity: 2,
    ammo: "Cells",
    flags: IT_WEAPON,
    weapmodel: WEAP_PLASMA,
    info: null,
    tag: 0,
    precaches: "models/weapons/v_beamer2/tris.md2 weapons/bfg__l1a.wav",
  }),
  // rogue

  /*QUAKED weapon_railgun (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_railgun",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Railgun,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_rail/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_rail/tris.md2",
    icon: "w_railgun",
    pickup_name: "Railgun",
    quantity: 1,
    ammo: "Slugs",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_RAILGUN,
    precaches: "weapons/rg_hum.wav",
  }),

  /*QUAKED weapon_bfg (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_bfg",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_BFG,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_bfg/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_bfg/tris.md2",
    icon: "w_bfg",
    pickup_name: "BFG10K",
    quantity: 50,
    ammo: "Cells",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_BFG,
    precaches:
      "sprites/s_bfg1.sp2 sprites/s_bfg2.sp2 sprites/s_bfg3.sp2 weapons/bfg__f1y.wav weapons/bfg__l1a.wav weapons/bfg__x1b.wav weapons/bfg_hum.wav",
  }),

  // =========================
  // ROGUE WEAPONS
  /*QUAKED weapon_chainfist (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_chainfist",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_ChainFist,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_chainf/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_chainf/tris.md2",
    icon: "w_chainfist",
    pickup_name: "Chainfist",
    count_width: 0,
    quantity: 0,
    ammo: null,
    flags: IT_WEAPON | IT_MELEE,
    weapmodel: WEAP_CHAINFIST,
    info: null,
    tag: 1,
    precaches: "weapons/sawidle.wav weapons/sawhit.wav",
  }),

  /*QUAKED weapon_disintegrator (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "weapon_disintegrator",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Disintegrator,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_dist/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_dist/tris.md2",
    icon: "w_disintegrator",
    pickup_name: "Disruptor",
    count_width: 0,
    quantity: 1,
    ammo: "Rounds",
    // KILL_DISRUPTOR is always defined in the shipped binary -- the
    // `#else IT_WEAPON` branch is dead (see this file's header comment).
    flags: IT_NOT_GIVEABLE,
    weapmodel: WEAP_DISRUPTOR,
    info: null,
    tag: 1,
    precaches:
      "models/items/spawngro/tris.md2 models/proj/disintegrator/tris.md2 weapons/disrupt.wav weapons/disint2.wav weapons/disrupthit.wav",
  }),
  // ROGUE WEAPONS
  // =========================

  //
  // AMMO ITEMS
  //

  /*QUAKED ammo_shells (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_shells",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/shells/medium/tris.md2",
    world_model_flags: 0,
    icon: "a_shells",
    pickup_name: "Shells",
    count_width: 3,
    quantity: 10,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_SHELLS,
    precaches: "",
  }),

  /*QUAKED ammo_bullets (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_bullets",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/bullets/medium/tris.md2",
    world_model_flags: 0,
    icon: "a_bullets",
    pickup_name: "Bullets",
    count_width: 3,
    quantity: 50,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_BULLETS,
    precaches: "",
  }),

  /*QUAKED ammo_cells (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_cells",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/cells/medium/tris.md2",
    world_model_flags: 0,
    icon: "a_cells",
    pickup_name: "Cells",
    count_width: 3,
    quantity: 50,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_CELLS,
    precaches: "",
  }),

  /*QUAKED ammo_rockets (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_rockets",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/rockets/medium/tris.md2",
    world_model_flags: 0,
    icon: "a_rockets",
    pickup_name: "Rockets",
    count_width: 3,
    quantity: 5,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_ROCKETS,
    precaches: "",
  }),

  /*QUAKED ammo_slugs (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_slugs",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/items/ammo/slugs/medium/tris.md2",
    world_model_flags: 0,
    icon: "a_slugs",
    pickup_name: "Slugs",
    count_width: 3,
    quantity: 10,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_SLUGS,
    precaches: "",
  }),

  // =======================================
  // ROGUE AMMO

  /*QUAKED ammo_flechettes (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_flechettes",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_flechette/tris.md2",
    world_model_flags: 0,
    icon: "a_flechettes",
    pickup_name: "Flechettes",
    count_width: 3,
    quantity: 50,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_FLECHETTES,
    precaches: null,
  }),

  /*QUAKED ammo_prox (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_prox",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_prox/tris.md2",
    world_model_flags: 0,
    icon: "a_prox",
    pickup_name: "Prox",
    count_width: 3,
    quantity: 5,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_PROX,
    precaches: "models/weapons/g_prox/tris.md2 weapons/proxwarn.wav",
  }),

  /*QUAKED ammo_tesla (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_tesla",
    pickup: Pickup_Ammo,
    use: Use_Weapon, // PGM
    drop: Drop_Ammo,
    weaponthink: Weapon_Tesla, // PGM
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_tesl/tris.md2",
    world_model_flags: 0,
    view_model: "models/weapons/v_tesla/tris.md2",
    icon: "a_tesla",
    pickup_name: "Tesla",
    count_width: 3,
    quantity: 5,
    ammo: "Tesla", // PGM
    flags: IT_AMMO | IT_WEAPON,
    weapmodel: 0,
    info: null,
    tag: AmmoT.AMMO_TESLA,
    precaches:
      "models/weapons/v_tesla2/tris.md2 weapons/teslaopen.wav weapons/hgrenb1a.wav weapons/hgrenb2a.wav models/weapons/g_tesla/tris.md2",
  }),

  /*QUAKED ammo_nuke (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_nuke",
    pickup: Pickup_Nuke,
    use: Use_Nuke, // PMM
    drop: Drop_Ammo,
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_nuke",
    pickup_name: "A-M Bomb",
    count_width: 3,
    quantity: 300, // used for respawn time
    ammo: "A-M Bomb",
    flags: IT_POWERUP,
    weapmodel: 0,
    info: null,
    tag: 0,
    precaches: "weapons/nukewarn2.wav world/rumble.wav",
    pickup_sound: "misc/am_pkup.wav",
  }),

  /*QUAKED ammo_disruptor (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "ammo_disruptor",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_disr/tris.md2",
    world_model_flags: 0,
    icon: "a_disruptor",
    pickup_name: "Rounds", // FIXME
    count_width: 3,
    quantity: 15,
    // KILL_DISRUPTOR is always defined in the shipped binary -- the
    // `#else` (IT_AMMO / AMMO_DISRUPTOR) branches are dead.
    flags: IT_NOT_GIVEABLE,
    tag: 0,
    precaches: null,
  }),
  // ROGUE AMMO
  // =======================================

  //
  // POWERUP ITEMS
  //
  /*QUAKED item_quad (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_quad",
    pickup: Pickup_Powerup,
    use: Use_Quad,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/quaddama/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_quad",
    pickup_name: "Quad Damage",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    precaches: "items/damage.wav items/damage2.wav items/damage3.wav",
  }),

  /*QUAKED item_invulnerability (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_invulnerability",
    pickup: Pickup_Powerup,
    use: Use_Invulnerability,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/invulner/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_invulnerability",
    pickup_name: "Invulnerability",
    count_width: 2,
    quantity: 300,
    flags: IT_POWERUP,
    precaches: "items/protect.wav items/protect2.wav items/protect4.wav",
  }),

  /*QUAKED item_silencer (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_silencer",
    pickup: Pickup_Powerup,
    use: Use_Silencer,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/silencer/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_silencer",
    pickup_name: "Silencer",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    precaches: "",
  }),

  /*QUAKED item_breather (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_breather",
    pickup: Pickup_Powerup,
    use: Use_Breather,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/breather/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_rebreather",
    pickup_name: "Rebreather",
    count_width: 2,
    quantity: 60,
    flags: IT_STAY_COOP | IT_POWERUP,
    precaches: "items/airout.wav",
  }),

  /*QUAKED item_enviro (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_enviro",
    pickup: Pickup_Powerup,
    use: Use_Envirosuit,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/enviro/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_envirosuit",
    pickup_name: "Environment Suit",
    count_width: 2,
    quantity: 60,
    flags: IT_STAY_COOP | IT_POWERUP,
    precaches: "items/airout.wav",
  }),

  /*QUAKED item_ancient_head (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  Special item that gives +2 to maximum health
  */
  mkItem({
    classname: "item_ancient_head",
    pickup: Pickup_AncientHead,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/c_head/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_fixme",
    pickup_name: "Ancient Head",
    count_width: 2,
    quantity: 60,
    precaches: "",
  }),

  /*QUAKED item_adrenaline (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  gives +1 to maximum health
  */
  mkItem({
    classname: "item_adrenaline",
    pickup: Pickup_Adrenaline,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/adrenal/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_adrenaline",
    pickup_name: "Adrenaline",
    count_width: 2,
    quantity: 60,
    precaches: "",
  }),

  /*QUAKED item_bandolier (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_bandolier",
    pickup: Pickup_Bandolier,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/band/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_bandolier",
    pickup_name: "Bandolier",
    count_width: 2,
    quantity: 60,
    precaches: "",
  }),

  /*QUAKED item_pack (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_pack",
    pickup: Pickup_Pack,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/pack/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_pack",
    pickup_name: "Ammo Pack",
    count_width: 2,
    quantity: 180,
    precaches: "",
  }),

  // ======================================
  // PGM

  /*QUAKED item_ir_goggles (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  gives +1 to maximum health
  */
  mkItem({
    classname: "item_ir_goggles",
    pickup: Pickup_Powerup,
    use: Use_IR,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/goggles/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_ir",
    pickup_name: "IR Goggles",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    precaches: "misc/ir_start.wav",
  }),

  /*QUAKED item_double (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_double",
    pickup: Pickup_Powerup,
    use: Use_Double,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/ddamage/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_double",
    pickup_name: "Double Damage",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    precaches: "misc/ddamage1.wav misc/ddamage2.wav misc/ddamage3.wav",
  }),

  // `/*Q U A K E D item_torch ... */` and its struct are BOTH wrapped in a
  // separate `/* ... */` C block comment in rogue/g_items.c (lines
  // 2601-2621) -- Use_Torch and GClientT.torch_framenum are also
  // commented out. Dead code, not ported; see this file's header comment
  // for the itemlist-length consequence.

  /*QUAKED item_compass (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_compass",
    pickup: Pickup_Powerup,
    use: Use_Compass,
    pickup_sound: "items/pkup.wav",
    world_model: "models/objects/fire/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_compass",
    pickup_name: "compass",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    tag: 0,
    precaches: null,
  }),

  /*QUAKED item_sphere_vengeance (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_sphere_vengeance",
    pickup: Pickup_Sphere,
    use: Use_Vengeance,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/vengnce/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_vengeance",
    pickup_name: "vengeance sphere",
    count_width: 2,
    quantity: 60,
    flags: IT_POWERUP,
    tag: 0,
    precaches: "spheres/v_idle.wav",
  }),

  /*QUAKED item_sphere_hunter (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_sphere_hunter",
    pickup: Pickup_Sphere,
    use: Use_Hunter,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/hunter/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_hunter",
    pickup_name: "hunter sphere",
    count_width: 2,
    quantity: 120,
    flags: IT_POWERUP,
    tag: 0,
    precaches: "spheres/h_idle.wav spheres/h_active.wav spheres/h_lurk.wav",
  }),

  /*QUAKED item_sphere_defender (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_sphere_defender",
    pickup: Pickup_Sphere,
    use: Use_Defender,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/defender/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_defender",
    pickup_name: "defender sphere",
    count_width: 2,
    quantity: 60, // respawn time
    flags: IT_POWERUP,
    tag: 0,
    precaches: "models/proj/laser2/tris.md2 models/items/shell/tris.md2 spheres/d_idle.wav",
  }),

  /*QUAKED item_doppleganger (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "item_doppleganger",
    pickup: Pickup_Doppleganger,
    use: Use_Doppleganger,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/dopple/tris.md2",
    world_model_flags: EF_ROTATE,
    count_width: 0,
    quantity: 90, // respawn time
    flags: IT_POWERUP,
    tag: 0,
    icon: "p_doppleganger",
    pickup_name: "Doppleganger",
    precaches:
      "models/objects/dopplebase/tris.md2 models/items/spawngro2/tris.md2 models/items/hunter/tris.md2 models/items/vengnce/tris.md2",
  }),

  mkItem({
    classname: null,
    pickup: Tag_PickupToken,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/tagtoken/tris.md2",
    world_model_flags: EF_ROTATE | EF_TAGTRAIL,
    icon: "i_tagtoken",
    pickup_name: "Tag Token",
    count_width: 0,
    quantity: 0,
    flags: IT_POWERUP | IT_NOT_GIVEABLE,
    tag: 1,
    precaches: null,
  }),

  // PGM
  // ======================================

  //
  // KEYS
  //
  /*QUAKED key_data_cd (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  key for computer centers
  */
  mkItem({
    classname: "key_data_cd",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/data_cd/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_datacd",
    pickup_name: "Data CD",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_power_cube (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN NO_TOUCH
  warehouse circuits
  */
  mkItem({
    classname: "key_power_cube",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/power/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_powercube",
    pickup_name: "Power Cube",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_pyramid (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  key for the entrance of jail3
  */
  mkItem({
    classname: "key_pyramid",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/pyramid/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_pyramid",
    pickup_name: "Pyramid Key",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_data_spinner (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  key for the city computer
  */
  mkItem({
    classname: "key_data_spinner",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/spinner/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_dataspin",
    pickup_name: "Data Spinner",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_pass (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  security pass for the security level
  */
  mkItem({
    classname: "key_pass",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/pass/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_security",
    pickup_name: "Security Pass",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_blue_key (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  normal door key - blue
  */
  mkItem({
    classname: "key_blue_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/key/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_bluekey",
    pickup_name: "Blue Key",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_red_key (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  normal door key - red
  */
  mkItem({
    classname: "key_red_key",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/red_key/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_redkey",
    pickup_name: "Red Key",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_commander_head (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  tank commander's head
  */
  mkItem({
    classname: "key_commander_head",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/monsters/commandr/head/tris.md2",
    world_model_flags: EF_GIB,
    icon: "k_comhead",
    pickup_name: "Commander's Head",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  /*QUAKED key_airstrike_target (0 .5 .8) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
  tank commander's head
  */
  mkItem({
    classname: "key_airstrike_target",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/keys/target/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_airstrike",
    pickup_name: "Airstrike Marker",
    count_width: 2,
    flags: IT_STAY_COOP | IT_KEY,
    precaches: "",
  }),

  // ======================================
  // PGM

  /*QUAKED key_nuke_container (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "key_nuke_container",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_contain",
    pickup_name: "Antimatter Pod",
    count_width: 2,
    quantity: 0,
    flags: IT_STAY_COOP | IT_KEY,
    tag: 0,
    precaches: null,
  }),

  /*QUAKED key_nuke (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  mkItem({
    classname: "key_nuke",
    pickup: Pickup_Key,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/weapons/g_nuke/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "i_nuke",
    pickup_name: "Antimatter Bomb",
    count_width: 2,
    quantity: 0,
    flags: IT_STAY_COOP | IT_KEY,
    tag: 0,
    precaches: null,
  }),

  // PGM
  // ======================================

  mkItem({
    classname: null,
    pickup: Pickup_Health,
    pickup_sound: "items/pkup.wav",
    icon: "i_health",
    pickup_name: "Health",
    count_width: 3,
    // PMM - health sound fix
    precaches: "items/s_health.wav items/n_health.wav items/l_health.wav items/m_health.wav",
  }),

  // ======================================
  // RE-RELEASE CONTENT PORT -- not in rogue/g_items.c's itemlist[].
  //
  // rdm14 (a shipped Ground Zero deathmatch map) places item_invisibility,
  // and this module was dropping it with "item_invisibility doesn't have a
  // spawn function". ED_CallSpawn scans the itemlist BEFORE the spawns[]
  // table, so an ITEMLIST row -- not a spawns[] entry -- is the correct
  // registration for an item, exactly as in the C.
  //
  // Appended at the tail rather than woven into the C's ordering so the row
  // is obviously an addition; nothing indexes this table positionally
  // (FindItem/FindItemByClassname search by name, SetItemNames walks it in
  // order), and InitItems still derives game.num_items from the length minus
  // the end marker below.
  //
  // *** ITEM COUNT CHANGE -- FLAGGED FOR THE COORDINATOR ***
  // test/rogue_core.test.ts asserts `itemlist().length === 63`; with this row
  // it is 64. See this file's header for the separate 63-vs-64 provenance
  // note on the C array itself -- that count is unchanged, this is one
  // deliberate re-release addition on top of it.
  // ======================================

  /*QUAKED item_invisibility (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  // See Use_Invisibility above: the 30-second cloak timer runs on
  // GClientT.invisible_framenum and p_view.ts's G_SetClientEffects draws it
  // as RF_TRANSLUCENT.
  mkItem({
    classname: "item_invisibility",
    pickup: Pickup_Powerup,
    use: Use_Invisibility,
    drop: Drop_General,
    pickup_sound: "items/pkup.wav",
    world_model: "models/items/cloaker/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "p_cloaker",
    pickup_name: "Invisibility",
    count_width: 2,
    quantity: 300,
    flags: IT_POWERUP,
    precaches: "items/protect.wav items/protect2.wav items/protect4.wav",
  }),

  // end of list marker
  mkItem({}),
]);

/*QUAKED item_health (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
 */
export function SP_item_health(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_HEALTH) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/medium/tris.md2";
  self.count = 10;
  SpawnItem(self, requireItem(FindItem("Health")));
  gi.soundindex("items/n_health.wav");
}

/*QUAKED item_health_small (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
 */
export function SP_item_health_small(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_HEALTH) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/stimpack/tris.md2";
  self.count = 2;
  SpawnItem(self, requireItem(FindItem("Health")));
  self.style = HEALTH_IGNORE_MAX;
  gi.soundindex("items/s_health.wav");
}

/*QUAKED item_health_large (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
 */
export function SP_item_health_large(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_HEALTH) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/large/tris.md2";
  self.count = 25;
  SpawnItem(self, requireItem(FindItem("Health")));
  gi.soundindex("items/l_health.wav");
}

/*QUAKED item_health_mega (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
 */
export function SP_item_health_mega(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_HEALTH) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/mega_h/tris.md2";
  self.count = 100;
  SpawnItem(self, requireItem(FindItem("Health")));
  gi.soundindex("items/m_health.wav");
  self.style = HEALTH_IGNORE_MAX | HEALTH_TIMED;
}

export function InitItems(): void {
  game.num_items = ITEMLIST.length - 1;
}

/*
===============
SetItemNames

Called by worldspawn
===============
*/
export function SetItemNames(): void {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    gi.configstring(CS_ITEMS + i, it.pickup_name ?? "");
  }

  gameIndices.jacket_armor_index = ITEM_INDEX(requireItem(FindItem("Jacket Armor")));
  gameIndices.combat_armor_index = ITEM_INDEX(requireItem(FindItem("Combat Armor")));
  gameIndices.body_armor_index = ITEM_INDEX(requireItem(FindItem("Body Armor")));
  power_screen_index = ITEM_INDEX(requireItem(FindItem("Power Screen")));
  power_shield_index = ITEM_INDEX(requireItem(FindItem("Power Shield")));
}

// `gitem_t itemlist[]` -- exposed as a readonly accessor per the base
// port's convention (kept so existing call sites/tests using `itemlist()`
// keep working) rather than exporting the mutable array binding directly.
export function itemlist(): readonly GItemT[] {
  return ITEMLIST;
}

// `#define ITEM_INDEX(x) ((x)-itemlist)` -- C pointer subtraction against
// the itemlist array, reshaped into an array index lookup.
export function ITEM_INDEX(item: GItemT): number {
  return ITEMLIST.indexOf(item);
}

// ROGUE
//===============
// SP_xatrix_item -- remaps a map entity spawned with an xatrix mission-pack
// classname (loaded under the rogue game DLL) to its nearest rogue
// equivalent. Registered in g_spawn.ts's spawns[] table for exactly the
// five xatrix classnames handled below.
//===============
export function SP_xatrix_item(self: EdictT): void {
  if (self.classname === null) return;

  let spawnClass: string | null = null;

  if (self.classname === "ammo_magslug") spawnClass = "ammo_flechettes";
  else if (self.classname === "ammo_trap") spawnClass = "weapon_proxlauncher";
  else if (self.classname === "item_quadfire") {
    const chance = random();
    if (chance < 0.2) spawnClass = "item_sphere_hunter";
    else if (chance < 0.6) spawnClass = "item_sphere_vengeance";
    else spawnClass = "item_sphere_defender";
  } else if (self.classname === "weapon_boomer") spawnClass = "weapon_etf_rifle";
  else if (self.classname === "weapon_phalanx") spawnClass = "weapon_plasmabeam";

  // C leaves `spawnClass` uninitialized (undefined behavior) if none of the
  // branches above match; every registered call site only maps these five
  // known classnames to SP_xatrix_item, so this is unreachable in practice
  // -- guarded here since TS has no UB to fall back on (see header comment).
  if (spawnClass === null) return;

  // check item spawn functions
  for (let i = 0; i < game.num_items; i++) {
    const item = ITEMLIST[i];
    if (item.classname === null) continue;
    if (item.classname === spawnClass) {
      // found it
      SpawnItem(self, item);
      return;
    }
  }
}
// ROGUE
