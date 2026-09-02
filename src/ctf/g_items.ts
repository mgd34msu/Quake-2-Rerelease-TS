// g_items.c

// g_items.c
//
// RERELEASE CONTENT PORT -- 17 mission-pack itemlist rows and the pickup/use
// code behind them, so this module can play the two re-release CTF maps that
// ship in baseq2/pak0.pak (q2kctf1.bsp, q2kctf2.bsp). Sources, per row group:
//   src/rogue/g_items.ts  -- ammo_flechettes/prox/tesla/nuke/disruptor,
//                            weapon_chainfist/disintegrator/etf_rifle/
//                            plasmabeam/proxlauncher, item_double,
//                            item_doppleganger, item_sphere_hunter
//   src/xatrix/g_items.ts -- ammo_magslug, ammo_trap, weapon_boomer,
//                            weapon_phalanx, SP_item_foodcube
//
// The new rows are APPENDED as one block after item_tech4, just before the
// end-of-list marker: the itemlist is addressed by name (FindItem /
// FindItemByClassname) and by runtime index (ITEM_INDEX / CS_ITEMS
// configstrings / STAT_SELECTED_ITEM), never by a hardcoded constant, so
// appending keeps every existing index stable. Verified by grep: nothing in
// src/ctf/ hardcodes an item index.
//
// SEE ALSO g_local.ts's own re-release block for the AmmoT / IT_MELEE /
// WEAP_* / MOD_* / SPHERE_* declarations these rows need, and the three
// merged-module constant collisions it resolves.

import { AngleVectors, vec3, VectorAdd, VectorClear, VectorCopy, VectorMA, VectorScale, VectorSet } from "../shared/math";
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
  CVAR_SERVERINFO,
  DF_INFINITE_AMMO,
  DF_INSTANT_ITEMS,
  DF_NO_ARMOR,
  DF_NO_HEALTH,
  DF_NO_ITEMS,
  DF_NO_MINES,
  DF_NO_NUKES,
  DF_NO_SPHERES,
  DF_WEAPONS_STAY,
  EF_FLAG1,
  EF_FLAG2,
  EF_GIB,
  EF_ROTATE,
  EntityEventT,
  MASK_SOLID,
  MAX_QPATH,
  PRINT_HIGH,
  Q_stricmp,
  RF_GLOW,
  YAW,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_SELECTED_ITEM,
} from "../shared/q_shared";
import { ValidateSelectedItem } from "./g_cmds";
import { SolidT, SVF_NOCLIENT } from "./game";
import { CTFDrop_Flag, CTFDrop_Tech, CTFFlagSetup, CTFHasRegeneration, CTFMatchSetup, CTFPickup_Flag, CTFPickup_Tech, CTFWeapon_Grapple } from "./g_ctf";
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
  IT_TECH,
  WEAP_BFG,
  WEAP_BLASTER,
  WEAP_BOOMER,
  WEAP_CHAINFIST,
  WEAP_CHAINGUN,
  WEAP_DISRUPTOR,
  WEAP_ETFRIFLE,
  WEAP_GRAPPLE,
  WEAP_GRENADELAUNCHER,
  WEAP_GRENADES,
  WEAP_HYPERBLASTER,
  WEAP_MACHINEGUN,
  WEAP_PHALANX,
  WEAP_PLASMA,
  WEAP_PROXLAUNCH,
  WEAP_RAILGUN,
  WEAP_ROCKETLAUNCHER,
  WEAP_SHOTGUN,
  WEAP_SUPERSHOTGUN,
} from "./g_local";
import { G_FreeEdict, G_ProjectSource, G_Spawn, G_UseTargets, tv, vtos } from "./g_utils";
import {
  Drop_Weapon,
  Pickup_Weapon,
  Use_Weapon,
  Weapon_BFG,
  Weapon_Blaster,
  Weapon_Chaingun,
  Weapon_Grenade,
  Weapon_GrenadeLauncher,
  Weapon_HyperBlaster,
  Weapon_Machinegun,
  Weapon_Railgun,
  Weapon_RocketLauncher,
  Weapon_Shotgun,
  Weapon_SuperShotgun,
  // RERELEASE CONTENT PORT -- the mission-pack weaponthinks.
  Weapon_ChainFist,
  Weapon_Disintegrator,
  Weapon_ETF_Rifle,
  Weapon_Heatbeam,
  Weapon_Ionripper,
  Weapon_Phalanx,
  Weapon_ProxLauncher,
  Weapon_Tesla,
  Weapon_Trap,
} from "./p_weapon";
import { fire_nuke } from "./g_newweap";
import { CheckGroundSpawnPoint, FindSpawnPoint, fire_doppleganger, SpawnGrow_Spawn } from "./g_newdm";
import { Hunter_Launch } from "./g_sphere";

// `gameCvars.*` are read as bare `.value` throughout; a per-file local
// mirrors g_main.ts's own `cvarNum` (module-local there too, so not
// reusable) rather than inventing a shared helper outside this file's SCOPE.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// ctf/g_ctf.h: `extern cvar_t *ctf;` -- g_ctf.ts registers this cvar in
// CTFInit() but keeps the resulting CvarT reference module-local (per
// .orch/decisions.tsv's g_ctf.ts cvar-ownership note, same pattern as
// g_main.ts's ctfCvar()), so this file -- which only reads it -- re-fetches
// the same cvar object via gi.cvar() at each read site. gi.cvar() is
// idempotent (Cvar_Get semantics): once CTFInit() has registered "ctf",
// every later gi.cvar("ctf", ...) call returns that same CvarT.
function ctfCvar(): number {
  const c = gi.cvar("ctf", "1", CVAR_SERVERINFO);
  return c === null ? 0 : c.value;
}

// `(gitem_armor_t *)ent->item->info` is narrowed from `unknown` with a real
// type guard (`instanceof`) instead of an `as` cast. Note: g_local.ts's
// comment on GItemT.info claims "`void *info` is never used by baseq2"; that
// is not accurate -- Pickup_Armor below reads it as a gitem_armor_t* for
// every armor pickup. Correcting that comment is out of this file's SCOPE.
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

// `static int power_screen_index; static int power_shield_index;` -- unlike
// jacket/combat/body armor index (which g_local.ts's gameIndices holder
// already declares, presumably for a later cross-module reader), these two
// are read only inside this file in the C source, so they stay module-local.
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

    // in ctf, when we are weapons stay, only the master of a team of
    // weapons is spawned
    if (
      master !== null &&
      ctfCvar() &&
      (cvarNum(gameCvars.dmflags) & DF_WEAPONS_STAY) !== 0 &&
      master.item !== null &&
      (master.item.flags & IT_WEAPON) !== 0
    ) {
      target = master;
    } else {
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
  }

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
      if (item.use !== null) item.use(other, item);
    }
  }

  return true;
}

// =========================================================================
// RERELEASE CONTENT PORT -- rogue/g_items.c's new pickup/use functions
// (`// PMM` / `// PGM` blocks), ported from src/rogue/g_items.ts. Only the
// ones the two re-release CTF maps actually need are here: the A-M Bomb
// (ammo_nuke), Double Damage (item_double), the doppelganger
// (item_doppleganger) and the hunter sphere (item_sphere_hunter).
//
// NOT ported: Use_IR / Use_Compass / Use_Defender / Use_Vengeance /
// Use_QuadFire. No map in this module's game dir places item_ir_goggles,
// item_compass, item_sphere_defender, item_sphere_vengeance or
// item_quadfire, so their use functions would have no row to hang off.
// (The defender and vengeance spheres themselves ARE reachable -- the
// doppelganger spawns one directly through g_sphere.ts's Sphere_Spawn when
// it dies -- they just have no pickup of their own here.)
// =========================================================================

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

export function Use_Double(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);

  if (client.double_framenum > level.framenum) client.double_framenum += 300;
  else client.double_framenum = level.framenum + 300;

  gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/ddamage1.wav"), 1, ATTN_NORM, 0);
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
  // RERELEASE CONTENT PORT -- the mission-pack caps the Bandolier raises.
  // PMM (rogue)
  if (client.pers.max_flechettes < 250) client.pers.max_flechettes = 250;
  // RAFAEL (xatrix)
  if (client.pers.max_magslug < 75) client.pers.max_magslug = 75;

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
  // RERELEASE CONTENT PORT -- the mission-pack caps the Ammo Pack raises.
  // PMM (rogue)
  if (client.pers.max_flechettes < 200) client.pers.max_flechettes = 200;
  // RAFAEL (xatrix)
  if (client.pers.max_magslug < 100) client.pers.max_magslug = 100;

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

  // RERELEASE CONTENT PORT -- the Ammo Pack also hands out the two
  // mission-pack ammo types with a cap of their own.
  // PMM (rogue)
  item = FindItem("Flechettes");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_flechettes)
      client.pers.inventory[index] = client.pers.max_flechettes;
  }

  // RAFAEL (xatrix)
  item = FindItem("Mag Slug");
  if (item !== null) {
    const index = ITEM_INDEX(item);
    client.pers.inventory[index] += item.quantity;
    if (client.pers.inventory[index] > client.pers.max_magslug) client.pers.inventory[index] = client.pers.max_magslug;
  }

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

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
  // RERELEASE CONTENT PORT -- the mission-pack ammo caps.
  // ROGUE
  else if (item.tag === AmmoT.AMMO_FLECHETTES) max = client.pers.max_flechettes;
  else if (item.tag === AmmoT.AMMO_PROX) max = client.pers.max_prox;
  else if (item.tag === AmmoT.AMMO_TESLA) max = client.pers.max_tesla;
  else if (item.tag === AmmoT.AMMO_DISRUPTOR) max = client.pers.max_rounds;
  // ROGUE
  // RAFAEL (xatrix)
  else if (item.tag === AmmoT.AMMO_MAGSLUG) max = client.pers.max_magslug;
  else if (item.tag === AmmoT.AMMO_TRAP) max = client.pers.max_trap;
  // RAFAEL
  else return false;

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
    if (
      client.pers.weapon !== item &&
      (cvarNum(gameCvars.deathmatch) === 0 || client.pers.weapon === FindItem("blaster"))
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

  client.pers.inventory[index] -= dropped.count;
  ValidateSelectedItem(ent);
}

//======================================================================

function MegaHealth_think(self: EdictT): void {
  const owner = self.owner;
  if (owner !== null && owner.health > owner.max_health && !CTFHasRegeneration(owner)) {
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

  if (other.health >= 250 && ent.count > 25) return false;

  other.health += ent.count;

  if (other.health > 250 && ent.count > 25) other.health = 250;

  if ((ent.style & HEALTH_IGNORE_MAX) === 0) {
    if (other.health > other.max_health) other.health = other.max_health;
  }

  if ((ent.style & HEALTH_TIMED) !== 0 && !CTFHasRegeneration(other)) {
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

  // get info on new armor
  const newinfo = asArmorInfo(item.info);

  const old_armor_index = ArmorIndex(other);

  // handle armor shards specially
  if (item.tag === ARMOR_SHARD) {
    if (old_armor_index === 0) client.pers.inventory[gameIndices.jacket_armor_index] = 2;
    else client.pers.inventory[old_armor_index] += 2;
  }
  // if player has no armor, just use it
  else if (old_armor_index === 0) {
    client.pers.inventory[ITEM_INDEX(item)] = newinfo.base_count;
  }
  // use the better armor
  else {
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

  if (CTFMatchSetup()) return; // can't pick stuff up right now

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

    if (item.pickup === Pickup_Health) {
      if (ent.count === 2) gi.sound(other, CHAN_ITEM, gi.soundindex("items/s_health.wav"), 1, ATTN_NORM, 0);
      else if (ent.count === 10) gi.sound(other, CHAN_ITEM, gi.soundindex("items/n_health.wav"), 1, ATTN_NORM, 0);
      else if (ent.count === 25) gi.sound(other, CHAN_ITEM, gi.soundindex("items/l_health.wav"), 1, ATTN_NORM, 0);
      else gi.sound(other, CHAN_ITEM, gi.soundindex("items/m_health.wav"), 1, ATTN_NORM, 0); // (ent->count == 100)
    } else if (item.pickup_sound !== null) {
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
  dropped.s.renderfx = RF_GLOW;
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
  else gi.setmodel(ent, ent.item === null ? "" : (ent.item.world_model ?? ""));
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
  PrecacheItem(item);

  if (ent.spawnflags !== 0) {
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
      // RERELEASE CONTENT PORT -- ROGUE. The sphere and doppelganger rows
      // have their own pickup functions, so DF_NO_ITEMS has to name them
      // explicitly the way rogue's SpawnItem does.
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

    // RERELEASE CONTENT PORT -- ROGUE's three extra dmflags, which gate the
    // mission-pack pickups this module now spawns.
    //
    // NOTE this module keeps ctf/g_items.c's PrecacheItem-first ordering
    // (rogue moved the PrecacheItem call BELOW these checks so a freed item
    // does not burn configstrings). Left as CTF has it so no existing item's
    // precache behaviour changes; the cost is a handful of unused model
    // configstrings on a server that sets these flags.
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

  if (cvarNum(gameCvars.coop) !== 0 && ent.classname === "key_power_cube") {
    ent.spawnflags |= 1 << (8 + level.power_cubes);
    level.power_cubes++;
  }

  // don't let them drop items that stay in a coop game
  if (cvarNum(gameCvars.coop) !== 0 && (item.flags & IT_STAY_COOP) !== 0) {
    item.drop = null;
  }

  // don't spawn the flags unless enabled
  if (!ctfCvar() && (ent.classname === "item_flag_team1" || ent.classname === "item_flag_team2")) {
    G_FreeEdict(ent);
    return;
  }

  ent.item = item;
  ent.nextthink = level.time + 2 * FRAMETIME; // items start after other solids
  ent.think = droptofloor;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RF_GLOW;
  if (ent.model !== null) gi.modelindex(ent.model);

  // flags are server animated and have special handling
  if (ent.classname === "item_flag_team1" || ent.classname === "item_flag_team2") {
    ent.think = CTFFlagSetup;
  }
}

//======================================================================

function mkItem(fields: Partial<GItemT>): GItemT {
  return Object.assign(new GItemT(), fields);
}

// `gitem_t itemlist[]` -- transcribed in the exact order of the C array,
// including index 0 ("leave index 0 alone") and the trailing `{NULL}`
// end-of-list marker. 42 base entries (game.num_items before this unit's
// delta) plus this unit's ctf/g_items.c delta (weapon_grapple,
// item_flag_team1/2, item_tech1-4 = 7 entries) = 50 entries, plus the
// re-release content port's 17 appended rows (see this file's header) = 67
// entries total; `InitItems` sets `game.num_items` to `ITEMLIST.length - 1`
// exactly as the C `sizeof(itemlist)/sizeof(...)-1` does.
const ITEMLIST: GItemT[] = fixedLength("ITEMLIST", 67, [
  mkItem({}), // leave index 0 alone

  //
  // ARMOR
  //

  /*QUAKED item_armor_body (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_armor_combat (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_armor_jacket (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_armor_shard (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_power_screen (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_power_shield (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /* weapon_grapple (.3 .3 1) (-16 -16 -16) (16 16 16)
  always owned, never in the world
  */
  mkItem({
    classname: "weapon_grapple",
    use: Use_Weapon,
    weaponthink: CTFWeapon_Grapple,
    pickup_sound: "misc/w_pkup.wav",
    view_model: "models/weapons/grapple/tris.md2",
    icon: "w_grapple",
    pickup_name: "Grapple",
    flags: IT_WEAPON,
    weapmodel: WEAP_GRAPPLE,
    precaches:
      "weapons/grapple/grfire.wav weapons/grapple/grpull.wav weapons/grapple/grhang.wav weapons/grapple/grreset.wav weapons/grapple/grhit.wav",
  }),

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

  /*QUAKED weapon_shotgun (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_supershotgun (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_machinegun (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_chaingun (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED ammo_grenades (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_grenadelauncher (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_rocketlauncher (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_hyperblaster (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_railgun (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED weapon_bfg (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  //
  // AMMO ITEMS
  //

  /*QUAKED ammo_shells (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED ammo_bullets (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED ammo_cells (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED ammo_rockets (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED ammo_slugs (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  //
  // POWERUP ITEMS
  //
  /*QUAKED item_quad (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_invulnerability (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_silencer (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_breather (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_enviro (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_ancient_head (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_adrenaline (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_bandolier (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  /*QUAKED item_pack (.3 .3 1) (-16 -16 -16) (16 16 16)
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

  //
  // KEYS
  //
  /*QUAKED key_data_cd (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_pyramid (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_data_spinner (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_pass (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_blue_key (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_red_key (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_commander_head (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  /*QUAKED key_airstrike_target (0 .5 .8) (-16 -16 -16) (16 16 16)
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

  mkItem({
    classname: null,
    pickup: Pickup_Health,
    pickup_sound: "items/pkup.wav",
    icon: "i_health",
    pickup_name: "Health",
    count_width: 3,
    precaches: "items/s_health.wav items/n_health.wav items/l_health.wav items/m_health.wav",
  }),

  /*QUAKED item_flag_team1 (1 0.2 0) (-16 -16 -24) (16 16 32)
   */
  mkItem({
    classname: "item_flag_team1",
    pickup: CTFPickup_Flag,
    drop: CTFDrop_Flag, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "ctf/flagtk.wav",
    world_model: "players/male/flag1.md2",
    world_model_flags: EF_FLAG1,
    icon: "i_ctf1",
    pickup_name: "Red Flag",
    count_width: 2,
    precaches: "ctf/flagcap.wav",
  }),

  /*QUAKED item_flag_team2 (1 0.2 0) (-16 -16 -24) (16 16 32)
   */
  mkItem({
    classname: "item_flag_team2",
    pickup: CTFPickup_Flag,
    drop: CTFDrop_Flag, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "ctf/flagtk.wav",
    world_model: "players/male/flag2.md2",
    world_model_flags: EF_FLAG2,
    icon: "i_ctf2",
    pickup_name: "Blue Flag",
    count_width: 2,
    precaches: "ctf/flagcap.wav",
  }),

  /* Resistance Tech */
  mkItem({
    classname: "item_tech1",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/resistance/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "tech1",
    pickup_name: "Disruptor Shield",
    count_width: 2,
    flags: IT_TECH,
    precaches: "ctf/tech1.wav",
  }),

  /* Strength Tech */
  mkItem({
    classname: "item_tech2",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/strength/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "tech2",
    pickup_name: "Power Amplifier",
    count_width: 2,
    flags: IT_TECH,
    precaches: "ctf/tech2.wav ctf/tech2x.wav",
  }),

  /* Haste Tech */
  mkItem({
    classname: "item_tech3",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/haste/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "tech3",
    pickup_name: "Time Accel",
    count_width: 2,
    flags: IT_TECH,
    precaches: "ctf/tech3.wav",
  }),

  /* Regeneration Tech */
  mkItem({
    classname: "item_tech4",
    pickup: CTFPickup_Tech,
    drop: CTFDrop_Tech, //Should this be null if we don't want players to drop it manually?
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/regeneration/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "tech4",
    pickup_name: "AutoDoc",
    count_width: 2,
    flags: IT_TECH,
    precaches: "ctf/tech4.wav",
  }),


  // =====================================================================
  // RERELEASE CONTENT PORT -- 17 appended rows, one per classname the two
  // re-release CTF maps place that this module could not spawn. Each
  // carries the sibling module it was lifted from. Field-for-field
  // transcriptions unless a comment says otherwise.
  //
  // Every weapon row here ships with a working weaponthink AND its fire_*
  // implementation (p_weapon.ts / g_newweap.ts): a row whose weaponthink
  // were null would make Think_Weapon skip the state machine entirely, so
  // the player would hold a weapon that never fires and can never be
  // switched away from -- worse than the entity not spawning at all.
  // =====================================================================

  //
  // ROGUE WEAPONS (src/rogue/g_items.ts)
  //

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
  // DELIBERATE DEVIATION FROM src/rogue/g_items.ts, same call src/game's
  // merged module made: rogue/g_local.h defines KILL_DISRUPTOR, so in the
  // shipped rogue binary this row is IT_NOT_GIVEABLE and SpawnItem frees any
  // weapon_disintegrator edict outright -- the weapon is dead content there.
  // q2kctf2.bsp places weapon_disintegrator and ammo_disruptor as *working*
  // pickups, so the KILL_DISRUPTOR branch is NOT ported: the row is a live
  // IT_WEAPON and SpawnItem has no free-and-return for it.
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
    flags: IT_WEAPON,
    weapmodel: WEAP_DISRUPTOR,
    info: null,
    tag: 1,
    precaches:
      "models/items/spawngro/tris.md2 models/proj/disintegrator/tris.md2 weapons/disrupt.wav weapons/disint2.wav weapons/disrupthit.wav",
  }),

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
    // weapon_grenadelauncher_fire dispatches on this tag to pick fire_prox
    // over fire_grenade.
    tag: AmmoT.AMMO_PROX,
    precaches:
      "weapons/grenlf1a.wav weapons/grenlr1b.wav weapons/grenlb1b.wav weapons/proxwarn.wav weapons/proxopen.wav",
  }),

  //
  // XATRIX WEAPONS (src/xatrix/g_items.ts)
  //

  /*QUAKED weapon_boomer (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  mkItem({
    classname: "weapon_boomer",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Ionripper,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_boom/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_boomer/tris.md2",
    icon: "w_ripper",
    pickup_name: "Ionripper",
    quantity: 2,
    ammo: "Cells",
    flags: IT_WEAPON,
    weapmodel: WEAP_BOOMER,
    precaches: "weapons/rg_hum.wav weapons/rippfire.wav",
  }),

  /*QUAKED weapon_phalanx (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  mkItem({
    classname: "weapon_phalanx",
    pickup: Pickup_Weapon,
    use: Use_Weapon,
    drop: Drop_Weapon,
    weaponthink: Weapon_Phalanx,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/weapons/g_shotx/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_shotx/tris.md2",
    icon: "w_phallanx",
    pickup_name: "Phalanx",
    quantity: 1,
    ammo: "Mag Slug",
    flags: IT_WEAPON,
    weapmodel: WEAP_PHALANX,
    precaches: "weapons/plasshot.wav",
  }),

  //
  // ROGUE AMMO (src/rogue/g_items.ts)
  //

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
  // IT_AMMO|IT_WEAPON: the tesla mine is ammo you can also SELECT and throw,
  // so unlike the other ammo rows it carries a weaponthink -- Weapon_Tesla,
  // which drives rogue's Throw_Generic state machine in p_weapon.ts and
  // fires through g_newweap.ts's fire_tesla.
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
  // The A-M Bomb. IT_POWERUP with a `use`, not a weaponthink: it is thrown
  // straight from the inventory by Use_Nuke, so there is no weapon state
  // machine to miss.
  mkItem({
    classname: "ammo_nuke",
    pickup: Pickup_Nuke,
    use: Use_Nuke, // PMM
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
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
  }),

  /*QUAKED ammo_disruptor (.3 .3 1) (-16 -16 -16) (16 16 16) TRIGGER_SPAWN
   */
  // Live IT_AMMO, not rogue's KILL_DISRUPTOR IT_NOT_GIVEABLE stub -- see the
  // note on weapon_disintegrator above.
  mkItem({
    classname: "ammo_disruptor",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/ammo/am_disr/tris.md2",
    world_model_flags: 0,
    icon: "a_disruptor",
    pickup_name: "Rounds", // FIXME (verbatim C comment)
    count_width: 3,
    quantity: 15,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_DISRUPTOR,
    precaches: null,
  }),

  //
  // XATRIX AMMO (src/xatrix/g_items.ts)
  //

  /*QUAKED ammo_magslug (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  mkItem({
    classname: "ammo_magslug",
    pickup: Pickup_Ammo,
    drop: Drop_Ammo,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/objects/ammo/tris.md2",
    world_model_flags: 0,
    icon: "a_mslugs",
    pickup_name: "Mag Slug",
    count_width: 3,
    quantity: 10,
    flags: IT_AMMO,
    tag: AmmoT.AMMO_MAGSLUG,
    precaches: "",
  }),

  /*QUAKED ammo_trap (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  // Same shape as ammo_tesla: ammo you can select and throw, so it carries
  // xatrix's own Weapon_Trap state machine (p_weapon.ts) and fires through
  // g_newweap.ts's fire_trap.
  mkItem({
    classname: "ammo_trap",
    pickup: Pickup_Ammo,
    use: Use_Weapon,
    drop: Drop_Ammo,
    weaponthink: Weapon_Trap,
    pickup_sound: "misc/am_pkup.wav",
    world_model: "models/weapons/g_trap/tris.md2",
    world_model_flags: EF_ROTATE,
    view_model: "models/weapons/v_trap/tris.md2",
    icon: "a_trap",
    pickup_name: "Trap",
    count_width: 3,
    quantity: 1,
    ammo: "trap",
    flags: IT_AMMO | IT_WEAPON,
    weapmodel: 0,
    tag: AmmoT.AMMO_TRAP,
    precaches: "weapons/trapcock.wav weapons/traploop.wav weapons/trapsuck.wav weapons/trapdown.wav",
  }),

  //
  // ROGUE POWERUPS (src/rogue/g_items.ts)
  //

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

  // end of list marker
  mkItem({}),
]);

/*QUAKED item_health (.3 .3 1) (-16 -16 -16) (16 16 16)
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

/*QUAKED item_health_small (.3 .3 1) (-16 -16 -16) (16 16 16)
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

/*QUAKED item_health_large (.3 .3 1) (-16 -16 -16) (16 16 16)
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

/*QUAKED item_health_mega (.3 .3 1) (-16 -16 -16) (16 16 16)
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

// RERELEASE CONTENT PORT -- xatrix/g_items.c's `// RAFAEL` SP_item_foodcube.
// Spawned directly by g_newweap.ts's Trap_Think (a G_Spawn() +
// SP_item_foodcube() call, not through the spawns[] registry) when the trap
// weapon -- ammo_trap, which q2kctf1.bsp places -- finishes digesting a
// kill. It has no classname of its own in the itemlist and is therefore not
// map-placeable; it reuses the existing "Health" row.
export function SP_item_foodcube(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && ((cvarNum(gameCvars.dmflags) | 0) & DF_NO_HEALTH) !== 0) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/objects/trapfx/tris.md2";
  SpawnItem(self, requireItem(FindItem("Health")));
  self.spawnflags |= DROPPED_ITEM;
  self.style = HEALTH_IGNORE_MAX;
  gi.soundindex("items/s_health.wav");
  self.classname = "foodcube";
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

// `gitem_t itemlist[]` -- exposed as a readonly accessor per the prior
// stub's convention (kept so existing call sites/tests using `itemlist()`
// keep working) rather than exporting the mutable array binding directly.
export function itemlist(): readonly GItemT[] {
  return ITEMLIST;
}

// `#define ITEM_INDEX(x) ((x)-itemlist)` -- C pointer subtraction against
// the itemlist array, reshaped into an array index lookup.
export function ITEM_INDEX(item: GItemT): number {
  return ITEMLIST.indexOf(item);
}
