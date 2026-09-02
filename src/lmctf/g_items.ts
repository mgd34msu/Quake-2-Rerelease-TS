// Ports lmctf60/g_items.c (2634 lines) in full.
//
// STATUS: COMPLETE. Every function lmctf60/g_items.c defines is ported, and
// `itemlist[]` is transcribed row-for-row in the C source's own order (51
// entries: the index-0 null item, 49 real items, and the trailing `{NULL}`
// end-of-list marker, so `InitItems` sets game.num_items = 50 exactly as C's
// `sizeof(itemlist)/sizeof(itemlist[0]) - 1` does).
//
// This file used to be a deliberately partial port carrying only
// weapon_hook/flag/weapon_blaster/Health and the four runes. That was the
// root cause of "<classname> doesn't have a spawn function" for every
// standard weapon, ammo and armor pickup on every LM-CTF map:
// g_spawn.ts's ED_CallSpawn consults the item table (by classname) BEFORE
// the spawns[] table, exactly like lmctf60/g_spawn.c, so a nearly-empty
// item table means a map's item entities resolve to nothing at all. The
// dispatch was never the bug; the table was.
//
// LM-CTF's own deltas against ctf/g_items.c (the file it forked), each
// reproduced and cited at its site below:
//   - DoRespawn (lmctf60/g_items.c:118) drops ZOID's weapons-stay special
//     case entirely and adds NULL guards.
//   - MegaHealth_think (:550) / Pickup_Health (:581) replace
//     CTFHasRegeneration with LM-CTF's own RUNE_REGEN check and drop ZOID's
//     250-health clamp.
//   - Drop_Ammo (:522) refuses to drop the last grenade while grenades are
//     the active weapon.
//   - Use_PowerArmor (:753) prints through ctf_SafePrint, not gi.cprintf.
//   - Touch_Item (:894) gates on Match_InCountdown() at the TOP of the
//     function (ctf checked CTFMatchSetup() after the pickup guards).
//   - PrecacheItem (:1131) bounds tokens at MAX_QPATH - 1, not MAX_QPATH.
//   - SpawnItem (:1199) adds the CTF_RANDOM_QUAD re-roll, the
//     CTF_ALLOW_INVULN removal and the whole `disabled_weps` weapon-ban
//     block, and drops ZOID's item_flag_team1/2 handling.
//   - tossflag (:778) and SP_flag (:837) are LM-CTF-only additions.
//   - itemlist[]: weapon_grapple is gone, weapon_plasma replaces ctf's
//     `#if 0` weapon_laser, item_quad's respawn time is spelled
//     LM_QUAD_DEFAULT_TIME, and ZOID's item_flag_team1/2 + item_tech1-4 are
//     replaced by flag, weapon_hook and the five runes.
//
// Deliberately ABSENT from LM-CTF's item table, so absent here: item_tech1
// through item_tech4 (LM-CTF deleted ZOID's `IT_TECH 64` flag -- see the
// note at src/lmctf/g_local.ts:237 -- and uses runes instead) and
// item_invisibility (never in any Quake II item table). Maps that place
// item_tech1-4 (bmap3.bsp) get nothing from the real LM-CTF DLL either;
// that is faithful, not a gap.

import { AngleVectors, random, vec3, type Vec3, VectorAdd, VectorClear, VectorCopy, VectorScale, VectorSet } from "../shared/math";
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
  EF_GIB,
  EF_ROTATE,
  EntityEventT,
  MASK_SOLID,
  MAX_QPATH,
  PRINT_HIGH,
  Q_stricmp,
  RF_GLOW,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_SELECTED_ITEM,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  AmmoT,
  ARMOR_BODY,
  ARMOR_COMBAT,
  ARMOR_JACKET,
  ARMOR_SHARD,
  CTF_ALLOW_INVULN,
  CTF_RANDOM_QUAD,
  type EdictT,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  FL_POWER_ARMOR,
  FL_RESPAWN,
  FL_TEAMSLAVE,
  FRAMETIME,
  GitemArmorT,
  GItemT,
  IT_AMMO,
  IT_ARMOR,
  IT_KEY,
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
  WEAP_CHAINGUN,
  WEAP_GRENADELAUNCHER,
  WEAP_GRENADES,
  WEAP_HOOK,
  WEAP_HYPERBLASTER,
  WEAP_MACHINEGUN,
  WEAP_PLASMA,
  WEAP_RAILGUN,
  WEAP_ROCKETLAUNCHER,
  WEAP_SHOTGUN,
  WEAP_SUPERSHOTGUN,
  game,
  gameCvars,
  gameIndices,
  gi,
} from "./g_local";
import { ValidateSelectedItem } from "./g_cmds";
import { Match_InCountdown } from "./g_tourney";
import { G_FreeEdict, G_ProjectSource, G_Spawn, G_UseTargets, tv, vtos } from "./g_utils";
import {
  PLASMA_CELLS_PER_SHOT,
  PLASMA_ICON,
  PLASMA_MODEL_VIEW,
  PLASMA_MODEL_WORLD,
  PLASMA_PICKUP,
  PLASMA_SOUND_PICKUP,
  Use_PLASMA,
} from "./plasma";
// lmctf60/g_items.c:11-35 forward-declares the whole p_weapon.c surface the
// itemlist rows point at. Imported statically here, exactly the way
// src/ctf/g_items.ts imports src/ctf/p_weapon.ts: g_items <-> p_weapon <->
// g_cmds is a genuine module cycle in the C source too (a function-pointer
// table pointing at the weapon state machine, which in turn looks items up
// by name), and ESM resolves it because every one of these is a hoisted
// `export function` declaration -- the ITEMLIST literal below reads the
// binding at module-evaluation time and gets the real function, not a TDZ
// hole. The prior partial file used lazy `require()` wrappers instead;
// those are gone because a wrapper breaks the function-POINTER IDENTITY
// that SpawnItem's dmflags gates and Touch_Item's health-sound branch
// compare against, and because there is no longer any cycle to break that
// ctf does not already have.
import {
  Drop_Weapon,
  Pickup_Weapon,
  Use_Weapon,
  Weapon_BFG,
  Weapon_Blaster,
  Weapon_Chaingun,
  Weapon_Grenade,
  Weapon_GrenadeLauncher,
  Weapon_Hook,
  Weapon_HyperBlaster,
  Weapon_Machinegun,
  Weapon_Plasma,
  Weapon_Railgun,
  Weapon_RocketLauncher,
  Weapon_Shotgun,
  Weapon_SuperShotgun,
} from "./p_weapon";

// `gameCvars.*` are read as bare `.value` throughout the C source; this
// local mirrors src/ctf/g_items.ts's identical helper.
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

// lmctf60/g_local.h: `extern cvar_t *disabled_weps;`, registered in
// lmctf60/g_save.c:220 as `gi.cvar("disabled_weps", "0", 0)`. It is NOT one
// of the cvars this port's g_main.ts InitGame registers into `gameCvars`
// (and g_main.ts is not this unit's file), so it is fetched here through
// gi.cvar's Cvar_Get semantics -- idempotent, returns the same CvarT on
// every later call, and creates it with the C source's own default of "0"
// if nothing registered it first. Same technique src/ctf/g_items.ts uses
// for the `ctf` cvar it only reads.
function disabledWeps(): number {
  const c = gi.cvar("disabled_weps", "0", 0);
  return c === null ? 0 : c.value | 0;
}

// lmctf60/g_ctffunc.h:42-51 -- the `disabled_weps` bitmask. Hosted here
// rather than in src/lmctf/g_ctffunc.ts because SpawnItem below is the only
// reader in the whole mod (confirmed by grep over lmctf60/*.c) and
// g_ctffunc.ts is not this unit's file. Deviation reported per PORTING.md's
// header-mapping mismatch clause.
const DIS_BFG = 1;
const DIS_HYPERBLASTER = 2;
const DIS_RAILGUN = 4;
const DIS_ROCKETLAUNCHER = 8;
const DIS_GRENADELAUNCHER = 16;
const DIS_CHAINGUN = 32;
const DIS_MACHINEGUN = 64;
const DIS_SUPERSHOTGUN = 128;
const DIS_SHOTGUN = 256;
const DIS_PLASMA = 512;

// `(gitem_armor_t *)ent->item->info` narrowed with a real type guard
// (`instanceof`) instead of an unchecked cast, which the repo gate bans.
// The C source's `void *info` really is a gitem_armor_t* for every armor row.
function asArmorInfo(info: unknown): GitemArmorT {
  if (info instanceof GitemArmorT) return info;
  gi.error("Pickup_Armor: item.info is not a GitemArmorT");
}

// Several call sites (SetItemNames, Use_PowerArmor, SP_item_health*) look an
// item up by name and immediately need a non-null gitem_t*, exactly as C's
// unchecked `ITEM_INDEX(FindItem("cells"))` assumes the name always exists.
function requireItem(item: GItemT | null): GItemT {
  if (item === null) {
    gi.error("g_items: expected item lookup to succeed");
  }
  return item;
}

//======================================================================

// lmctf60/g_items.c:36-38. The `f` float suffixes LM-CTF added
// (`.30f`/`.60f`/`.80f`) are a C-compiler-warning fix, not a value change.
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

// `static int power_screen_index; static int power_shield_index;`
// (lmctf60/g_items.c:41-44). Both are assigned by SetItemNames below.
let power_screen_index = 0;
let power_shield_index = 0;

// lmctf60/g_items.c:46-47 -- `ent->style` bitflags read by Pickup_Health /
// MegaHealth_think below and set by the SP_item_health* family.
export const HEALTH_IGNORE_MAX = 1;
export const HEALTH_TIMED = 2;

// lmctf60/g_items.c:49 -- `#define QUAD_INDEX 24`, a hard-coded index into
// itemlist[] that SpawnItem's CTF_RANDOM_QUAD re-roll writes through. It
// really is index 24 in the table below (verified against the transcribed
// order; src/lmctf/plasma.ts's own PLASMA_INDEX = 18 pins the same table
// from the other direction).
const QUAD_INDEX = 24;

// `static int quad_drop_timeout_hack;` (lmctf60/g_items.c:52).
let quad_drop_timeout_hack = 0;

// lmctf60/g_runes.c: `#define RUNE_REGEN 8`. Duplicated by value rather
// than imported because g_runes.ts already statically imports
// ArmorIndex/FindItem/ITEM_INDEX from this file and, per PORTING.md's
// import-cycle rule, g_items.c (the more fundamental item-table module) is
// not the side that breaks the cycle. One never-changing #define.
const RUNE_REGEN = 8;

//======================================================================

/*
===============
GetItemByIndex (lmctf60/g_items.c:61)
===============
*/
export function GetItemByIndex(index: number): GItemT | null {
  if (index === 0 || index >= game.num_items) return null;
  return ITEMLIST[index] ?? null;
}

/*
===============
FindItemByClassname (lmctf60/g_items.c:76)
===============
*/
export function FindItemByClassname(classname: string): GItemT | null {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it === undefined || it.classname === null) continue;
    if (Q_stricmp(it.classname, classname) === 0) return it;
  }
  return null;
}

/*
===============
FindItem (lmctf60/g_items.c:99)
===============
*/
export function FindItem(pickup_name: string): GItemT | null {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it === undefined || it.pickup_name === null) continue;
    if (Q_stricmp(it.pickup_name, pickup_name) === 0) return it;
  }
  return null;
}

//======================================================================

/*
=================
DoRespawn (lmctf60/g_items.c:118) -- LM-CTF DROPS ctf's weapons-stay
special case entirely (no `ctf->value && DF_WEAPONS_STAY` branch;
confirmed by direct source read, not just the diff header) and adds the
two NULL guards on `ent` and `master`. The team-chain walk is written as
a plain counted walk instead of ctf's saved-`target` form -- functionally
the same random pick.
=================
*/
export function DoRespawn(ent: EdictT): void {
  let cur: EdictT | null = ent;

  if (cur.team !== null) {
    const master = cur.teammaster;
    if (master === null) return;

    let count = 0;
    for (let e: EdictT | null = master; e !== null; e = e.chain) count++;

    // C: `choice = count ? (rand() % count) : 0;`
    const choice = count > 0 ? Math.floor(Math.random() * count) : 0;

    let e: EdictT | null = master;
    let walked = 0;
    while (walked < choice && e !== null) {
      e = e.chain;
      walked++;
    }
    cur = e;
  }

  if (cur !== null) {
    cur.svflags &= ~SVF_NOCLIENT;
    cur.solid = SolidT.SOLID_TRIGGER;
    gi.linkentity(cur);

    // send an effect
    cur.s.event = EntityEventT.EV_ITEM_RESPAWN;
  }
}

/*
=================
SetRespawn (lmctf60/g_items.c:155) -- byte-identical to ctf's.
=================
*/
export function SetRespawn(ent: EdictT, delay: number): void {
  ent.flags |= FL_RESPAWN;
  ent.svflags |= SVF_NOCLIENT;
  ent.solid = SolidT.SOLID_NOT;
  ent.nextthink = level.time + delay;
  ent.think = DoRespawn;
  gi.linkentity(ent);
}

//======================================================================

/*
=================
Pickup_Powerup (lmctf60/g_items.c:168) -- byte-identical to ctf's.
=================
*/
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

/*
=================
Drop_General (lmctf60/g_items.c:196) -- byte-identical to ctf's.
=================
*/
export function Drop_General(ent: EdictT, item: GItemT): void {
  Drop_Item(ent, item);
  const client = ent.client;
  if (client !== null) client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);
}

//======================================================================

/*
=================
Pickup_Adrenaline (lmctf60/g_items.c:206) -- byte-identical to ctf's.
=================
*/
export function Pickup_Adrenaline(ent: EdictT, other: EdictT): boolean {
  if (cvarNum(gameCvars.deathmatch) === 0) other.max_health += 1;

  if (other.health < other.max_health) other.health = other.max_health;

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

/*
=================
Pickup_AncientHead (lmctf60/g_items.c:220) -- byte-identical to ctf's.
=================
*/
export function Pickup_AncientHead(ent: EdictT, other: EdictT): boolean {
  other.max_health += 2;

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

/*
=================
Pickup_Bandolier (lmctf60/g_items.c:230) -- byte-identical to ctf's.
=================
*/
export function Pickup_Bandolier(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  if (client === null) return false;

  if (client.pers.max_bullets < 250) client.pers.max_bullets = 250;
  if (client.pers.max_shells < 150) client.pers.max_shells = 150;
  if (client.pers.max_cells < 250) client.pers.max_cells = 250;
  if (client.pers.max_slugs < 75) client.pers.max_slugs = 75;

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

/*
=================
Pickup_Pack (lmctf60/g_items.c:268) -- byte-identical to ctf's.
=================
*/
export function Pickup_Pack(ent: EdictT, other: EdictT): boolean {
  const client = other.client;
  if (client === null) return false;

  if (client.pers.max_bullets < 300) client.pers.max_bullets = 300;
  if (client.pers.max_shells < 200) client.pers.max_shells = 200;
  if (client.pers.max_rockets < 100) client.pers.max_rockets = 100;
  if (client.pers.max_grenades < 100) client.pers.max_grenades = 100;
  if (client.pers.max_cells < 300) client.pers.max_cells = 300;
  if (client.pers.max_slugs < 100) client.pers.max_slugs = 100;

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

  if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, ent.item === null ? 0 : ent.item.quantity);
  }

  return true;
}

//======================================================================

/*
=================
Use_Quad (lmctf60/g_items.c:348) -- byte-identical to ctf's.
=================
*/
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

/*
=================
Use_Breather (lmctf60/g_items.c:375) -- byte-identical to ctf's,
commented-out pickup sound included.
=================
*/
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

/*
=================
Use_Envirosuit (lmctf60/g_items.c:390) -- byte-identical to ctf's.
=================
*/
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

/*
=================
Use_Invulnerability (lmctf60/g_items.c:405) -- byte-identical to ctf's.
Its function identity is load-bearing: SpawnItem below compares
`item.use === Use_Invulnerability` to implement the CTF_ALLOW_INVULN gate.
=================
*/
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

/*
=================
Use_Silencer (lmctf60/g_items.c:420) -- byte-identical to ctf's.
=================
*/
export function Use_Silencer(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client === null) return;

  client.pers.inventory[ITEM_INDEX(item)]--;
  ValidateSelectedItem(ent);
  client.silencer_shots += 30;

  //	gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage.wav"), 1, ATTN_NORM, 0);
}

//======================================================================

/*
=================
Pickup_Key (lmctf60/g_items.c:431) -- byte-identical to ctf's, including
the coop-only power-cube bitfield bookkeeping.
=================
*/
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

/*
=================
Add_Ammo (lmctf60/g_items.c:456) -- byte-identical to ctf's.
=================
*/
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
  else return false;

  const index = ITEM_INDEX(item);

  if (client.pers.inventory[index] === max) return false;

  client.pers.inventory[index] += count;

  if (client.pers.inventory[index] > max) client.pers.inventory[index] = max;

  return true;
}

/*
=================
Pickup_Ammo (lmctf60/g_items.c:492) -- byte-identical to ctf's.
=================
*/
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

/*
=================
Drop_Ammo (lmctf60/g_items.c:522)

LM-CTF DELTA: the `Can't drop current weapon` guard (:534-541) is LM-CTF's
own addition over ctf -- dropping your last grenades while hand grenades
are the ACTIVE weapon is refused, the already-spawned dropped entity is
freed, and the inventory decrement never happens. Note the guard runs
AFTER Drop_Item has already spawned and linked the entity, exactly as in
the C source; that ordering is observable (the item briefly exists for one
G_Spawn slot) and is preserved on purpose.
=================
*/
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

/*
=================
MegaHealth_think (lmctf60/g_items.c:550)

LM-CTF DELTA: ctf called CTFHasRegeneration(self->owner); LM-CTF inlines
its own rune check (`owner->client->rune->runetype == RUNE_REGEN`) and, for
a regen carrier, bleeds the overflow down to max_health + 25 on a 2-second
tick instead of max_health on a 1-second tick. The whole body is also
wrapped in a NULL-owner guard LM-CTF added.
=================
*/
export function MegaHealth_think(self: EdictT): void {
  if (self.owner !== null) {
    const owner = self.owner;
    if (owner.client !== null && owner.client.rune !== null && owner.client.rune.runetype === RUNE_REGEN) {
      if (owner.health > owner.max_health + 25) {
        self.nextthink = level.time + 2;
        owner.health -= 1;
        return;
      }
    } else if (owner.health > owner.max_health) {
      self.nextthink = level.time + 1;
      owner.health -= 1;
      return;
    }
  }

  if ((self.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(self, 20);
  } else {
    G_FreeEdict(self);
  }
}

/*
=================
Pickup_Health (lmctf60/g_items.c:581)

LM-CTF DELTAS: ZOID's `health >= 250 && count > 25` refusal and the
matching 250 clamp are both GONE, and the HEALTH_TIMED branch no longer
excludes regeneration carriers (MegaHealth_think handles them instead).
The `#ifdef WEAP_BALANCE_OK` overboard-health clamp (CTF_WEAP_BALANCE) is
dropped -- that macro is never `#define`d anywhere in lmctf60, same as
g_weapon.ts's fire_blaster citation for the same macro.

Its function identity is load-bearing: Touch_Item picks the health pickup
sound by comparing `item.pickup === Pickup_Health`, and SpawnItem's
DF_NO_HEALTH gate compares against it too.
=================
*/
export function Pickup_Health(ent: EdictT, other: EdictT): boolean {
  if ((ent.style & HEALTH_IGNORE_MAX) === 0 && other.health >= other.max_health) return false;

  other.health += ent.count;

  if ((ent.style & HEALTH_IGNORE_MAX) === 0 && other.health > other.max_health) {
    other.health = other.max_health;
  }

  if ((ent.style & HEALTH_TIMED) !== 0) {
    ent.think = MegaHealth_think;
    ent.nextthink = level.time + 5;
    ent.owner = other;
    ent.flags |= FL_RESPAWN;
    ent.svflags |= SVF_NOCLIENT;
    ent.solid = SolidT.SOLID_NOT;
  } else if ((ent.spawnflags & DROPPED_ITEM) === 0 && cvarNum(gameCvars.deathmatch) !== 0) {
    SetRespawn(ent, 30);
  }

  return true;
}

//======================================================================

/*
=================
ArmorIndex (lmctf60/g_items.c:627) -- byte-identical to ctf's.
=================
*/
export function ArmorIndex(ent: EdictT): number {
  if (ent.client === null) return 0;
  const { jacket_armor_index, combat_armor_index, body_armor_index } = gameIndices;
  if (ent.client.pers.inventory[jacket_armor_index] > 0) return jacket_armor_index;
  if (ent.client.pers.inventory[combat_armor_index] > 0) return combat_armor_index;
  if (ent.client.pers.inventory[body_armor_index] > 0) return body_armor_index;
  return 0;
}

/*
=================
Pickup_Armor (lmctf60/g_items.c:644) -- byte-identical to ctf's. LM-CTF's
only edit here is the `#ifdef WEAP_BALANCE_OK` max-armor clamp
(CTF_WEAP_BALANCE) after the SetRespawn, and WEAP_BALANCE_OK is never
`#define`d anywhere in lmctf60, so that block is dead and not reproduced.

Its function identity is load-bearing: SpawnItem's DF_NO_ARMOR gate
compares `item.pickup === Pickup_Armor`.
=================
*/
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

/*
=================
PowerArmorType (lmctf60/g_items.c:736) -- byte-identical to ctf's.
=================
*/
export function PowerArmorType(ent: EdictT): number {
  if (ent.client === null) return POWER_ARMOR_NONE;
  if ((ent.flags & FL_POWER_ARMOR) === 0) return POWER_ARMOR_NONE;
  if (ent.client.pers.inventory[power_shield_index] > 0) return POWER_ARMOR_SHIELD;
  if (ent.client.pers.inventory[power_screen_index] > 0) return POWER_ARMOR_SCREEN;
  return POWER_ARMOR_NONE;
}

/*
=================
Use_PowerArmor (lmctf60/g_items.c:753)

LM-CTF DELTA: the "No cells for power armor." message goes through
ctf_SafePrint (g_ctffunc.ts), not gi.cprintf -- LM-CTF routes player-facing
prints through its own bot/spectator-safe wrapper. Resolved with a lazy
require because g_ctffunc.ts statically imports Touch_Item/drop_temp_touch/
ITEM_INDEX from this file, and per PORTING.md's import-cycle rule the item
table is not the side that breaks that cycle.
=================
*/
export function Use_PowerArmor(ent: EdictT, _item: GItemT): void {
  const client = ent.client;

  if ((ent.flags & FL_POWER_ARMOR) !== 0) {
    ent.flags &= ~FL_POWER_ARMOR;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
  } else {
    const cells = requireItem(FindItem("cells"));
    const index = ITEM_INDEX(cells);
    if (client === null || client.pers.inventory[index] === 0) {
      const mod = require("./g_ctffunc") as {
        ctf_SafePrint: (ent: EdictT, print_priority: number, buf: string | null) => void;
      };
      mod.ctf_SafePrint(ent, PRINT_HIGH, "No cells for power armor.\n");
      return;
    }
    ent.flags |= FL_POWER_ARMOR;
    gi.sound(ent, CHAN_AUTO, gi.soundindex("misc/power1.wav"), 1, ATTN_NORM, 0); // FIXME powering up sound
  }
}

//======================================================================
// CTF CODE -- LM_JORM (lmctf60/g_items.c:770-836)
//======================================================================

/*
=================
tossflag (lmctf60/g_items.c:778) -- an LM-CTF-only addition with NO CALLERS
anywhere in lmctf60 (confirmed by grep over every .c/.h in the tree: the
only occurrence is this definition). Ported for source-completeness, and
because the ctf_TossEnt path in g_ctffunc.c does the same job for the
reachable flag-drop chain. Kept faithful including the taller +33 maxs and
the trace-rollback-on-obstruction.
=================
*/
export function tossflag(ent: EdictT, dir: Vec3 | null): void {
  VectorCopy(tv(-15, -15, -15), ent.mins);
  VectorCopy(tv(15, 15, 33), ent.maxs);

  ent.flags |= FL_RESPAWN;
  ent.spawnflags = DROPPED_ITEM;

  if (ent.model !== null) gi.setmodel(ent, ent.model);
  else gi.setmodel(ent, ent.item === null ? "" : (ent.item.world_model ?? ""));
  // C: `//ent->solid = SOLID_BBOX;` -- commented out in the source itself.
  ent.solid = SolidT.SOLID_TRIGGER;
  ent.movetype = MovetypeT.MOVETYPE_TOSS;
  ent.touch = Touch_Item;

  const temp = vec3();
  VectorCopy(ent.s.origin, temp);
  VectorClear(ent.s.angles);

  // C: `if (!dir || !dir[0])` -- a NULL direction vector OR one whose X
  // component is exactly zero both mean "random toss".
  if (dir === null || dir[0] === 0) {
    VectorAdd(ent.s.origin, tv(0, 0, 48), ent.s.origin);
    ent.velocity[0] = -500 + random() * 1000;
    ent.velocity[1] = -500 + random() * 1000;
    ent.velocity[2] = 400;
  } else {
    const d = vec3();
    VectorCopy(dir, d);
    VectorScale(d, 64, d);
    VectorAdd(ent.s.origin, d, ent.s.origin);
    VectorScale(d, 4, d);
    VectorCopy(d, ent.velocity);
  }

  const tr = gi.trace(temp, ent.mins, ent.maxs, ent.s.origin, ent, MASK_SOLID);
  if (tr.fraction < 1.0 || tr.allsolid) {
    VectorCopy(temp, ent.s.origin);
  }

  // FLAG MODEL SUPPORT
  ent.nextthink = level.time + FRAMETIME;
  const mod = require("./g_ctffunc") as { ctf_flagwave: (ent: EdictT) => void };
  ent.think = mod.ctf_flagwave;

  ent.droptime = level.time;

  gi.linkentity(ent);
}

/*
=================
SP_flag (lmctf60/g_items.c:837)

NOTE (observable-behavior quirk, preserved on purpose): g_spawn.c's
ED_CallSpawn checks its item table BEFORE its spawns[] table (confirmed by
direct source read of both quake-2/game/g_spawn.c and lmctf60/g_spawn.c),
and ITEMLIST below has a "flag" entry. So a map entity with classname
"flag" is ALWAYS routed to SpawnItem(ent, item) by g_spawn.ts's
ED_CallSpawn, never to this function -- `{"flag", SP_flag}` in g_spawn.c's
spawns[] table (and this port's registry) is genuinely dead code in the
original game, not a porting mistake. SP_flag is still ported here (in
case something someday calls it directly, and for source-fidelity), but
the real, reachable flag-spawn path for a mapped flag entity is
SpawnItem/droptofloor/Touch_Item.
=================
*/
export function SP_flag(self: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) === 0) {
    G_FreeEdict(self);
    return;
  }

  // C: `//self->model = "models/items/mega_h/tris.md2";` -- commented out.
  self.droptime = 0;
  self.entprops = 0;
  self.count = 0;
  self.flagteam = 0; // Not set yet
  SpawnItem(self, FindItemByClassname("flag"));
  const mod = require("./g_ctffunc") as { ctf_flagwave: (ent: EdictT) => void };
  self.think = mod.ctf_flagwave;
  self.nextthink = level.time + 1;
  gi.soundindex("items/m_health.wav");
}

//======================================================================
// END CTF CODE -- LM_JORM
//======================================================================

/*
=================
Pickup_PowerArmor (lmctf60/g_items.c:860) -- byte-identical to ctf's. Its
function identity is load-bearing for SpawnItem's DF_NO_ARMOR gate.
=================
*/
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

/*
=================
Drop_PowerArmor (lmctf60/g_items.c:880) -- byte-identical to ctf's.
=================
*/
export function Drop_PowerArmor(ent: EdictT, item: GItemT): void {
  const client = ent.client;
  if (client !== null && (ent.flags & FL_POWER_ARMOR) !== 0 && client.pers.inventory[ITEM_INDEX(item)] === 1) {
    Use_PowerArmor(ent, item);
  }
  Drop_General(ent, item);
}

//======================================================================

/*
=================
Touch_Item (lmctf60/g_items.c:894)

LM-CTF DELTA: gates on Match_InCountdown() (LM-CTF's own tourney state
machine, g_tourney.ts) instead of ctf's CTFMatchSetup(), AND moves that
check to the very TOP of the function -- ahead of the !other->client /
health / pickup guards, where ctf had it after them. Observably identical
in outcome (both return without picking up) but reproduced in the C
source's order.

The Pickup_Health per-count pickup-sound ladder is present in LM-CTF's C
source unchanged and is ported here; a previous partial version of this
file dropped it on the (then-true, now-false) grounds that no Pickup_Health
row existed in the table.
=================
*/
export function Touch_Item(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (Match_InCountdown()) return;

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
    if ((ent.flags & FL_RESPAWN) !== 0) {
      ent.flags &= ~FL_RESPAWN;
    } else {
      G_FreeEdict(ent);
    }
  }
}

//======================================================================

/*
=================
drop_temp_touch (lmctf60/g_items.c:961) -- LM-CTF drops ctf's `static`
storage class on this one (it is used by g_ctffunc.c's flag-drop chain),
which is why this port exports it.
=================
*/
export function drop_temp_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;
  Touch_Item(ent, other, plane, surf);
}

/*
=================
drop_make_touchable (lmctf60/g_items.c:969) -- byte-identical to ctf's.
=================
*/
function drop_make_touchable(ent: EdictT): void {
  ent.touch = Touch_Item;
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    ent.nextthink = level.time + 29;
    ent.think = G_FreeEdict;
  }
}

/*
=================
Drop_Item (lmctf60/g_items.c:979) -- byte-identical to ctf's.
=================
*/
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

/*
=================
Use_Item (lmctf60/g_items.c:1028) -- byte-identical to ctf's.
=================
*/
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
droptofloor (lmctf60/g_items.c:1054) -- byte-identical to ctf's (LM-CTF's
only edit is whitespace around the MOVETYPE_TOSS assignment).
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
PrecacheItem (lmctf60/g_items.c:1131)

Precaches all data needed for a given item. Called for each item spawned
in a level, and for each item in each client's inventory.

LM-CTF DELTA: the token-length bound is `len >= MAX_QPATH - 1` where ctf
had `len >= MAX_QPATH` (an off-by-one fix, since the C code appends a NUL
into a MAX_QPATH buffer). Reproduced.

The pointer-walk shape is kept rather than a `split(" ")`: a trailing space
(ammo_grenades' precache string has one) is consumed as a separator by the
C loop and never produces a zero-length token, whereas split() would
produce an empty final element that the C source would have called
gi.error on.
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

  // parse the space separated precache string for other items
  const s = it.precaches;
  if (s === null || s.length === 0) return;

  let i = 0;
  while (i < s.length) {
    const start = i;
    while (i < s.length && s[i] !== " ") i++;

    const len = i - start;
    if (len >= MAX_QPATH - 1 || len < 5) {
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
SpawnItem (lmctf60/g_items.c:1199)

Sets the clipping size and plants the object on the floor. Items can't be
immediately dropped to floor, because they might be on an entity that
hasn't spawned yet.

LM-CTF DELTAS, all reproduced below in the C source's own order:
  - The CTF_RANDOM_QUAD re-roll runs on EVERY item spawn, not just a quad's
    (the C comment says so outright: "This is called every time any item is
    spawned, but it is ok to make things more random"). It writes
    itemlist[QUAD_INDEX].quantity directly, i.e. it mutates the shared item
    table, so the last map entity to spawn decides the quad's respawn time
    for the whole level. Quirk preserved.
  - The CTF_ALLOW_INVULN removal (:1256-1265): when ctfflags does NOT have
    bit 2 set -- which is the DEFAULT, since lmctf60/g_save.c registers
    ctfflags with "0" -- every item whose `use` is Use_Invulnerability is
    silently freed in deathmatch. item_invulnerability therefore RESOLVES
    in the item table (no "doesn't have a spawn function" message) and then
    quietly disappears; in coop it survives. Both halves are faithful.
  - The `disabled_weps` weapon-ban block (:1266-1315), defaulting to 0.
  - ZOID's item_flag_team1/item_flag_team2 handling (the `!ctf->value` free
    and the CTFFlagSetup think override) is GONE in LM-CTF; not reproduced.

Every gate here compares against a function POINTER the way the C source
does (`item->pickup == Pickup_Armor`), NOT against an IT_* flag -- which is
why the Pickup_ and Use_ functions above are exported as plain hoisted
declarations and never wrapped.
============
*/
export function SpawnItem(ent: EdictT, item: GItemT | null): void {
  if (item === null) return;
  PrecacheItem(item);

  // Radomize the quad [sic -- C source's own spelling]
  if ((cvarNum(gameCvars.ctfflags) | 0) & CTF_RANDOM_QUAD) {
    const quad = ITEMLIST[QUAD_INDEX];
    if (quad !== undefined) quad.quantity = 50 + Math.floor(Math.random() * 31);
  }

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
    }
    if ((dmflags & DF_NO_HEALTH) !== 0) {
      if (item.pickup === Pickup_Health || item.pickup === Pickup_Adrenaline || item.pickup === Pickup_AncientHead) {
        G_FreeEdict(ent);
        return;
      }
    }
    if ((dmflags & DF_INFINITE_AMMO) !== 0) {
      // C: `item->flags == IT_AMMO` -- an EQUALITY test, not a bit test, so
      // ammo_grenades (IT_AMMO|IT_WEAPON) is deliberately NOT caught here.
      // Reproduced exactly.
      if (item.flags === IT_AMMO || ent.classname === "weapon_bfg") {
        G_FreeEdict(ent);
        return;
      }
    }

    // surt ... ummm this code vanished at some point ... why?
    if (((cvarNum(gameCvars.ctfflags) | 0) & CTF_ALLOW_INVULN) === 0) {
      // unless they enabled the allow invulnerability flag, take it out
      if (item.use === Use_Invulnerability) {
        G_FreeEdict(ent);
        return;
      }
    }

    const disabled = disabledWeps();
    if (disabled !== 0) {
      if ((disabled & DIS_BFG) !== 0 && ent.classname === "weapon_bfg") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_HYPERBLASTER) !== 0 && ent.classname === "weapon_hyperblaster") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_RAILGUN) !== 0 && ent.classname === "weapon_railgun") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_ROCKETLAUNCHER) !== 0 && ent.classname === "weapon_rocketlauncher") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_GRENADELAUNCHER) !== 0 && ent.classname === "weapon_grenadelauncher") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_CHAINGUN) !== 0 && ent.classname === "weapon_chaingun") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_MACHINEGUN) !== 0 && ent.classname === "weapon_machinegun") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_SUPERSHOTGUN) !== 0 && ent.classname === "weapon_supershotgun") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_SHOTGUN) !== 0 && ent.classname === "weapon_shotgun") {
        G_FreeEdict(ent);
        return;
      }
      if ((disabled & DIS_PLASMA) !== 0 && ent.classname === "weapon_plasma") {
        G_FreeEdict(ent);
        return;
      }
    }
  }

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
}

//======================================================================

function mkItem(fields: Partial<GItemT>): GItemT {
  return Object.assign(new GItemT(), fields);
}

// `gitem_t itemlist[]` (lmctf60/g_items.c:1351) -- transcribed row-for-row
// in the C array's own order, including index 0 ("leave index 0 alone") and
// the trailing `{NULL}` end-of-list marker. 51 entries; InitItems sets
// game.num_items to ITEMLIST.length - 1 = 50, exactly as C's
// `sizeof(itemlist)/sizeof(itemlist[0]) - 1` does.
//
// Two hard-coded indices in the mod depend on this exact ordering and are
// asserted by the fixedLength count plus their own call sites:
// QUAD_INDEX = 24 (SpawnItem's CTF_RANDOM_QUAD re-roll, above) and
// plasma.ts's PLASMA_INDEX = 18.
const ITEMLIST: GItemT[] = fixedLength("ITEMLIST", 51, [
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
  // NOTE: ctf's weapon_grapple row is DELETED in LM-CTF (the grapple is
  // replaced by weapon_hook, further down the table). Do not reinstate it.

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
    // lmctf60/g_items.c:1618 literally has a stray backtick in this
    // precache string (`weapons/machgf3b.wav\`` before the space), inherited
    // unchanged from ctf. Preserved: PrecacheItem sees extension "av`",
    // matches nothing, and silently skips that one sound.
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
    precaches: "weapons/hyprbu1a.wav weapons/hyprbl1a.wav weapons/hyprbf1a.wav weapons/hyprbd1a.wav misc/lasfly.wav",
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

  // SKWiD MOD -- weapon_plasma (lmctf60/g_items.c:1760-1780). This row
  // occupies the slot ctf left behind an `#if 0` around a never-built
  // "weapon_laser". LM-CTF's signature weapon: it is the ONLY row in the
  // table whose `use` is not Use_Weapon (Use_PLASMA, plasma.ts, additionally
  // toggles the rifle's reflect/spread fire mode when you re-select an
  // already-held plasma rifle), and `quantity` is PLASMA_CELLS_PER_SHOT
  // (10) rather than 1 -- the C source's own comment reads "//bat - was 1".
  mkItem({
    classname: "weapon_plasma",
    pickup: Pickup_Weapon,
    use: Use_PLASMA,
    drop: Drop_Weapon,
    weaponthink: Weapon_Plasma,
    pickup_sound: PLASMA_SOUND_PICKUP,
    world_model: PLASMA_MODEL_WORLD,
    world_model_flags: EF_ROTATE,
    view_model: PLASMA_MODEL_VIEW,
    icon: PLASMA_ICON,
    pickup_name: PLASMA_PICKUP,
    count_width: 0,
    quantity: PLASMA_CELLS_PER_SHOT,
    ammo: "Cells",
    flags: IT_WEAPON | IT_STAY_COOP,
    weapmodel: WEAP_PLASMA,
    // BUG PRESERVED (lmctf60/g_items.c:1779): the C source writes
    // `/* precache */ "PLASMA_PRECACHE"` -- the macro name INSIDE quotes, so
    // the preprocessor never expands it and the item precaches the literal
    // 15-character string "PLASMA_PRECACHE" instead of the plasma rifle's
    // models, sprites and sounds. PrecacheItem accepts it (length 15 passes
    // the 5..MAX_QPATH-1 bounds check), finds extension "CHE", matches no
    // handler, and precaches nothing. Reproduced verbatim: substituting the
    // real plasma.ts PLASMA_PRECACHE list here would change what the server
    // sends in its configstrings.
    precaches: "PLASMA_PRECACHE",
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
  // NOTE: index 24 -- QUAD_INDEX above writes through to this row.
  // `quantity` is spelled LM_QUAD_DEFAULT_TIME in the C source
  // (lmctf60/g_local.h:1367 `#define LM_QUAD_DEFAULT_TIME 60`), the same
  // numeric value ctf hard-coded, with the C comment "Quad respawn time
  // right here".
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
  // Present in the table on purpose even though SpawnItem silently frees it
  // in deathmatch under the default ctfflags of 0 (see the CTF_ALLOW_INVULN
  // note on SpawnItem). Resolving the classname and then freeing the entity
  // is what the real DLL does; leaving the row out would instead print
  // "item_invulnerability doesn't have a spawn function".
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

  // The generic Health row. `classname` is NULL in the C source, and that
  // matters: ED_CallSpawn (g_spawn.ts) checks the item table by classname
  // BEFORE spawns[], and a NULL classname can never match
  // "item_health"/"item_health_small"/etc, so those map classnames correctly
  // fall through to spawns[] and reach the real SP_item_health family below
  // -- unlike "flag", which DOES collide with the item table and never
  // reaches SP_flag.
  mkItem({
    classname: null,
    pickup: Pickup_Health,
    pickup_sound: "items/pkup.wav",
    icon: "i_health",
    pickup_name: "Health",
    count_width: 3,
    precaches: "items/s_health.wav items/n_health.wav items/l_health.wav items/m_health.wav",
  }),

  //======================================================================
  // CTF CODE -- LM_JORM (lmctf60/g_items.c:2356-2510)
  //======================================================================

  /*QUAKED flag (.3 .3 1) (-16 -16 -16) (16 16 16)
   */
  // LM-CTF has a SINGLE "flag" classname shared by both teams' flag
  // entities, distinguished at runtime by EdictT.flagteam -- not ZOID's two
  // separate item_flag_team1/item_flag_team2 rows. pickup/use/drop wire to
  // g_ctffunc.ts's ctf_flagtouch/ctf_playerdropflag through lazy requires,
  // because g_ctffunc.ts statically imports Touch_Item/drop_temp_touch/
  // ITEM_INDEX from this file and, per PORTING.md's import-cycle rule, the
  // item table is not the side that breaks that cycle.
  mkItem({
    classname: "flag",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_ctffunc") as { ctf_flagtouch: (ent: EdictT, other: EdictT) => boolean };
      return mod.ctf_flagtouch(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_ctffunc") as { ctf_playerdropflag: (ent: EdictT, item: GItemT) => void };
      mod.ctf_playerdropflag(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_ctffunc") as { ctf_playerdropflag: (ent: EdictT, item: GItemT) => void };
      mod.ctf_playerdropflag(ent, gitem);
    },
    pickup_sound: "misc/am_pkup.wav",
    world_model: "players/male/flag1.md2",
    world_model_flags: 0,
    icon: "a_redflag",
    pickup_name: "Enemy Flag",
    count_width: 3,
    flags: IT_KEY | IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  /* weapon_hook (.3 .3 1) (-16 -16 -16) (16 16 16)
  always owned, never in the world
  */
  mkItem({
    classname: "weapon_hook",
    use: Use_Weapon,
    weaponthink: Weapon_Hook,
    pickup_sound: "misc/w_pkup.wav",
    world_model: "models/objects/debris2/tris.md2",
    world_model_flags: 0,
    view_model: "models/weapons/v_hook/tris.md2",
    icon: "w_blaster",
    pickup_name: "Grappling Hook",
    flags: IT_WEAPON,
    weapmodel: WEAP_HOOK,
    precaches: "weapons/grapple/grfire.wav misc/lasfly.wav models/items/debris2/tris.md2",
  }),

  //**********
  // RUNES
  //**********
  // All five rune rows share Pickup_Rune / Drop_Rune (g_runes.ts), resolved
  // lazily for the same cycle reason as the flag row above: g_runes.ts
  // statically imports ArmorIndex/FindItem/FindItemByClassname/ITEM_INDEX/
  // SpawnItem/Touch_Item from this file.
  //
  // The C source has NO spawns[] entry for resist_rune/haste_rune/
  // regen_rune/vampire_rune (only "damage_rune" gets one, at
  // {"damage_rune", SP_damage_rune}). Since ED_CallSpawn checks the item
  // table before spawns[], these ITEMLIST rows alone are the complete spawn
  // path for a mapped rune entity or a g_runes.ts SpawnRune call.

  // Damage Rune
  mkItem({
    classname: "damage_rune",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
      return mod.Pickup_Rune(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/damage/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "a_strength",
    pickup_name: "Damage Artifact",
    count_width: 3,
    flags: IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  // Resist Rune
  mkItem({
    classname: "resist_rune",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
      return mod.Pickup_Rune(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/resist/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "a_resist",
    pickup_name: "Resist Artifact",
    count_width: 3,
    flags: IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  // Haste Rune
  mkItem({
    classname: "haste_rune",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
      return mod.Pickup_Rune(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/haste/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "a_haste",
    pickup_name: "Haste Artifact",
    count_width: 3,
    flags: IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  // Regen Rune
  mkItem({
    classname: "regen_rune",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
      return mod.Pickup_Rune(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/regen/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "a_regen",
    pickup_name: "Regen Artifact",
    count_width: 3,
    flags: IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  // Vampire Rune (lmctf60/g_items.c:2504, "//added by Vampire"). Note it
  // deliberately reuses the RESIST rune's world model -- the C source's own
  // commented-out `/* icon */ "a_resist"` line above the live "k_redkey"
  // shows the author swapped the icon but never the model. Preserved.
  mkItem({
    classname: "vampire_rune",
    pickup: (ent: EdictT, other: EdictT): boolean => {
      const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
      return mod.Pickup_Rune(ent, other);
    },
    use: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    drop: (ent: EdictT, gitem: GItemT): void => {
      const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
      mod.Drop_Rune(ent, gitem);
    },
    pickup_sound: "items/pkup.wav",
    world_model: "models/ctf/resist/tris.md2",
    world_model_flags: EF_ROTATE,
    icon: "k_redkey",
    pickup_name: "Vampire Artifact",
    count_width: 3,
    flags: IT_POWERUP,
    precaches: "misc/tele_up.wav world/klaxon1.wav",
  }),

  //======================================================================
  // END CTF CODE -- LM_JORM
  //======================================================================

  // end of list marker
  mkItem({}),
]);

// `game` is a shared mutable singleton that InitGame's own reassignment can
// wipe after this module has already loaded, so game.num_items is set here
// at module load AND re-asserted by InitItems() below, which g_main.ts's
// InitGame calls (g_main.ts:165) -- matching the C source's real call order
// (InitGame -> InitItems) instead of relying solely on a load-time side
// effect that a later reset could silently invalidate. This matters because
// g_spawn.ts's ED_CallSpawn guards its item-table lookup on
// `game.num_items > 0`: a zero here makes the entire table invisible no
// matter how complete it is.
game.num_items = ITEMLIST.length - 1;

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

/*
===============
InitItems (lmctf60/g_items.c:2604) -- `game.num_items =
sizeof(itemlist)/sizeof(itemlist[0]) - 1`, i.e. every row except the
trailing end-of-list marker.
===============
*/
export function InitItems(): void {
  game.num_items = ITEMLIST.length - 1;
}

/*
===============
SetItemNames (lmctf60/g_items.c:2618) -- byte-identical to ctf's.

Called by worldspawn (g_spawn.ts:887). Now that the table is complete, the
five armor-index lookups the C source performs unconditionally are real
again: they were skipped by the previous partial port because none of the
armor rows existed, which left ArmorIndex/PowerArmorType permanently
reporting "no armor".
===============
*/
export function SetItemNames(): void {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it === undefined) continue;
    gi.configstring(CS_ITEMS + i, it.pickup_name ?? "");
  }

  gameIndices.jacket_armor_index = ITEM_INDEX(requireItem(FindItem("Jacket Armor")));
  gameIndices.combat_armor_index = ITEM_INDEX(requireItem(FindItem("Combat Armor")));
  gameIndices.body_armor_index = ITEM_INDEX(requireItem(FindItem("Body Armor")));
  power_screen_index = ITEM_INDEX(requireItem(FindItem("Power Screen")));
  power_shield_index = ITEM_INDEX(requireItem(FindItem("Power Shield")));
}

// `gitem_t itemlist[]` exposed as a readonly accessor (matching
// src/ctf/g_items.ts's identical convention) for callers outside this file
// that need to iterate the whole table -- p_hud.ts's BeginIntermission coop
// key-strip loop, g_cmds.ts's inventory commands, and g_spawn.ts's
// G_SpawnableClassnames.
export function itemlist(): readonly GItemT[] {
  return ITEMLIST;
}

// `#define ITEM_INDEX(x) ((x)-itemlist)` -- C pointer subtraction against
// the itemlist array, reshaped into an array index lookup.
export function ITEM_INDEX(item: GItemT): number {
  return ITEMLIST.indexOf(item);
}
