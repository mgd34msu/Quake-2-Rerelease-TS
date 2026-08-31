// Ports a SUBSET of lmctf60/g_items.c (2634 lines total; diff vs
// quake-2/ctf/g_items.c is 893 lines of 2446 -- real deltas beyond
// formatting, not yet fully reviewed).
//
// STATUS: the item-table plumbing and armor-lookup helpers the offhand-hook
// priority feature's dependency chain needs are ported: FindItem/
// FindItemByClassname/GetItemByIndex/ITEM_INDEX (generic lookup) and
// ArmorIndex/PowerArmorType (both of which -- see the doc comments below --
// only need `ent.flags`/`ent.client.pers.inventory` to be zeroed, which is
// EdictT/ClientPersistentT's default state, not a populated item table).
// The itemlist contains "weapon_hook" (the one item Cmd_Hook_f (g_cmds.ts)
// and Weapon_Hook (p_weapon.ts) look up by name), "flag" (SP_flag below,
// needed by g_spawn.ts's registry for the flag entity spawn chain), and all
// four runes -- damage_rune/resist_rune/haste_rune/regen_rune (see
// makeDamageRuneItem/makeResistRuneItem/makeHasteRuneItem/makeRegenRuneItem
// below; g_runes.ts's effect logic was already ported, this file's ITEMLIST
// entries are what let a map (or g_runes.ts's own SpawnRune) actually
// instantiate one instead of hitting ED_CallSpawn's "doesn't have a spawn
// function" fallback in g_spawn.ts). The other ~35 item entries (weapons,
// ammo, armor, most powerups) are NOT ported -- FindItem/GetItemByIndex will
// not find them. This is a deliberately partial file, not a finished one.

import { vec3, VectorAdd, VectorCopy } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_ITEM,
  type CplaneT,
  type CsurfaceT,
  CS_ITEMS,
  DF_NO_HEALTH,
  EF_ROTATE,
  EntityEventT,
  MASK_SOLID,
  Q_stricmp,
  RF_GLOW,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_SELECTED_ITEM,
} from "../shared/q_shared";
import { SolidT, SVF_NOCLIENT } from "./game";
import {
  type EdictT,
  DROPPED_ITEM,
  DROPPED_PLAYER_ITEM,
  FL_POWER_ARMOR,
  FL_RESPAWN,
  FL_TEAMSLAVE,
  GItemT,
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
  WEAP_BLASTER,
  WEAP_HOOK,
  game,
  gameCvars,
  gameIndices,
  gi,
} from "./g_local";
import { Match_InCountdown } from "./g_tourney";
import { G_FreeEdict, G_UseTargets, tv, vtos } from "./g_utils";
// Lazy require, not a static import: g_items.ts (item table) <-
// p_weapon.ts (Weapon_Hook) <- g_combat.ts (T_Damage) <- g_cmds.ts
// (OnSameTeam) <- g_items.ts (FindItem) closes a value cycle. Per
// PORTING.md's import-cycle rule, the "less fundamental" side breaks it --
// an item table entry pointing at its weaponthink function is a data
// relationship in the C source (a function-pointer table entry, not a
// module dependency), so this is the natural place to resolve lazily.

// `static int power_screen_index; static int power_shield_index;` --
// neither is ever assigned in this partial port (that happens in
// InitItems's precache pass over the full itemlist, not ported here), so
// they stay at their C static-storage default of 0, matching
// PowerArmorType's behavior when power armor was never precached.
let power_screen_index = 0;
let power_shield_index = 0;

// lmctf60/g_items.c ~2384: `/* weapon_hook (.3 .3 1) (-16 -16 -16) (16 16
// 16) always owned, never in the world */`
function makeHookItem(): GItemT {
  const item = new GItemT();
  item.classname = "weapon_hook";
  item.use = null; // C: Use_Weapon -- not ported in this partial file (g_items.ts's generic weapon-use path)
  item.weaponthink = (ent: EdictT): void => {
    const mod = require("./p_weapon") as { Weapon_Hook: (ent: EdictT) => void };
    mod.Weapon_Hook(ent);
  };
  item.pickup_sound = "misc/w_pkup.wav";
  item.world_model = "models/objects/debris2/tris.md2";
  item.view_model = "models/weapons/v_hook/tris.md2";
  item.icon = "w_blaster";
  item.pickup_name = "Grappling Hook";
  item.flags = IT_WEAPON;
  item.weapmodel = WEAP_HOOK;
  item.precaches = "weapons/grapple/grfire.wav misc/lasfly.wav models/items/debris2/tris.md2";
  return item;
}

// lmctf60/g_items.c: `/* weapon_blaster (.3 .3 1) (-16 -16 -16) (16 16 16)
// always owned, never in the world */`. Required for InitClientPersistent
// (p_client.ts) -- every player's starting weapon is `FindItem("Blaster")`,
// treated as always-succeeding in the C source (a real game's itemlist
// always has this entry); without it, PutClientInServer cannot spawn any
// player at all, so this entry (unlike most of the still-unported ~40
// item table) is load-bearing for this unit's SCOPE, not optional.
// `use`/`weaponthink` are left null (Use_Weapon/Weapon_Blaster are not
// ported -- no weapon-fire dispatch beyond the hook chain exists in this
// family, see p_client.ts's file header) since nothing in this unit's
// SCOPE calls a weapon's `use`/`weaponthink` for the Blaster specifically.
function makeBlasterItem(): GItemT {
  const item = new GItemT();
  item.classname = "weapon_blaster";
  item.use = null;
  item.weaponthink = null;
  item.pickup_sound = "misc/w_pkup.wav";
  item.view_model = "models/weapons/v_blast/tris.md2";
  item.icon = "w_blaster";
  item.pickup_name = "Blaster";
  item.flags = IT_WEAPON | IT_STAY_COOP;
  item.weapmodel = WEAP_BLASTER;
  return item;
}

// lmctf60/g_items.c ~2358: `/*QUAKED flag (.3 .3 1) (-16 -16 -16) (16 16
// 16)*/` -- the one flag item entry (LM_CTF has a single "flag" classname
// shared by both teams' flag entities, distinguished at runtime by
// EdictT.flagteam, not by two separate item entries the way CTF_TEAM_RED
// vs CTF_TEAM_BLUE weapon-model slots might suggest -- confirmed against
// the C source's itemlist, which has exactly one `{"flag", ...}` block).
// pickup/use/drop wire to g_ctffunc.ts's ctf_flagtouch/ctf_playerdropflag,
// both documented throwing stubs there (flag capture chain out of this
// unit's SCOPE) -- see this file's SP_flag for the part that IS ported
// (spawning and animating the flag entity).
function makeFlagItem(): GItemT {
  const item = new GItemT();
  item.classname = "flag";
  item.pickup = (ent: EdictT, other: EdictT): boolean => {
    const mod = require("./g_ctffunc") as { ctf_flagtouch: (ent: EdictT, other: EdictT) => boolean };
    return mod.ctf_flagtouch(ent, other);
  };
  item.use = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_ctffunc") as { ctf_playerdropflag: (ent: EdictT, item: GItemT) => void };
    mod.ctf_playerdropflag(ent, gitem);
  };
  item.drop = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_ctffunc") as { ctf_playerdropflag: (ent: EdictT, item: GItemT) => void };
    mod.ctf_playerdropflag(ent, gitem);
  };
  item.pickup_sound = "misc/am_pkup.wav";
  item.world_model = "players/male/flag1.md2";
  item.icon = "a_redflag";
  item.pickup_name = "Enemy Flag";
  item.count_width = 3;
  item.flags = IT_KEY | IT_POWERUP;
  item.precaches = "misc/tele_up.wav world/klaxon1.wav";
  return item;
}

// lmctf60/g_items.c ~2413: the "damage_rune" itemlist entry -- byte-
// identical field values to the C source. The other three rune entries
// (resist_rune/haste_rune/regen_rune, ~2437-2503) are now ported too --
// see makeResistRuneItem/makeHasteRuneItem/makeRegenRuneItem below.
//
// Pickup_Rune/Drop_Rune (g_runes.ts) are resolved via a lazy require, not
// a static import, same reasoning as makeFlagItem's ctf_flagtouch/
// ctf_playerdropflag above: g_runes.ts already statically imports
// SpawnItem/FindItemByClassname/etc from this file, so a static import
// back would close a value cycle.
function makeDamageRuneItem(): GItemT {
  const item = new GItemT();
  item.classname = "damage_rune";
  item.pickup = (ent: EdictT, other: EdictT): boolean => {
    const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
    return mod.Pickup_Rune(ent, other);
  };
  item.use = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.drop = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.pickup_sound = "items/pkup.wav";
  item.world_model = "models/ctf/damage/tris.md2";
  item.world_model_flags = EF_ROTATE;
  item.icon = "a_strength";
  item.pickup_name = "Damage Artifact";
  item.count_width = 3;
  item.flags = IT_POWERUP;
  item.precaches = "misc/tele_up.wav world/klaxon1.wav";
  return item;
}

// lmctf60/g_items.c ~2437: the "resist_rune" itemlist entry -- byte-
// identical field values to the C source, same pickup/use/drop wiring as
// makeDamageRuneItem above (Pickup_Rune/Drop_Rune, g_runes.ts, resolved
// lazily for the same import-cycle reason). The C source has NO spawns[]
// entry for "resist_rune" (confirmed by direct read of g_spawn.c's spawns[]
// table -- only "damage_rune" gets one, at {"damage_rune", SP_damage_rune}):
// ED_CallSpawn (g_spawn.ts) checks the item table before spawns[], so this
// ITEMLIST entry alone is the complete spawn path for a "resist_rune" map
// entity or a g_runes.ts SpawnRune(RUNE_RESIST) call -- no g_spawn.ts
// registry entry is needed or present in the C source to mirror.
function makeResistRuneItem(): GItemT {
  const item = new GItemT();
  item.classname = "resist_rune";
  item.pickup = (ent: EdictT, other: EdictT): boolean => {
    const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
    return mod.Pickup_Rune(ent, other);
  };
  item.use = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.drop = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.pickup_sound = "items/pkup.wav";
  item.world_model = "models/ctf/resist/tris.md2";
  item.world_model_flags = EF_ROTATE;
  item.icon = "a_resist";
  item.pickup_name = "Resist Artifact";
  item.count_width = 3;
  item.flags = IT_POWERUP;
  item.precaches = "misc/tele_up.wav world/klaxon1.wav";
  return item;
}

// lmctf60/g_items.c ~2459: the "haste_rune" itemlist entry -- byte-
// identical field values to the C source; same "no spawns[] entry in the
// C source" note as makeResistRuneItem above applies here too.
function makeHasteRuneItem(): GItemT {
  const item = new GItemT();
  item.classname = "haste_rune";
  item.pickup = (ent: EdictT, other: EdictT): boolean => {
    const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
    return mod.Pickup_Rune(ent, other);
  };
  item.use = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.drop = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.pickup_sound = "items/pkup.wav";
  item.world_model = "models/ctf/haste/tris.md2";
  item.world_model_flags = EF_ROTATE;
  item.icon = "a_haste";
  item.pickup_name = "Haste Artifact";
  item.count_width = 3;
  item.flags = IT_POWERUP;
  item.precaches = "misc/tele_up.wav world/klaxon1.wav";
  return item;
}

// lmctf60/g_items.c ~2481: the "regen_rune" itemlist entry -- byte-
// identical field values to the C source; same "no spawns[] entry in the
// C source" note as makeResistRuneItem above applies here too.
function makeRegenRuneItem(): GItemT {
  const item = new GItemT();
  item.classname = "regen_rune";
  item.pickup = (ent: EdictT, other: EdictT): boolean => {
    const mod = require("./g_runes") as { Pickup_Rune: (ent: EdictT, other: EdictT) => boolean };
    return mod.Pickup_Rune(ent, other);
  };
  item.use = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.drop = (ent: EdictT, gitem: GItemT): void => {
    const mod = require("./g_runes") as { Drop_Rune: (ent: EdictT, item: GItemT | null) => void };
    mod.Drop_Rune(ent, gitem);
  };
  item.pickup_sound = "items/pkup.wav";
  item.world_model = "models/ctf/regen/tris.md2";
  item.world_model_flags = EF_ROTATE;
  item.icon = "a_regen";
  item.pickup_name = "Regen Artifact";
  item.count_width = 3;
  item.flags = IT_POWERUP;
  item.precaches = "misc/tele_up.wav world/klaxon1.wav";
  return item;
}

// lmctf60/g_items.c:46-47 -- `ent->style` bitflags read by Pickup_Health/
// MegaHealth_think below.
export const HEALTH_IGNORE_MAX = 1;
export const HEALTH_TIMED = 2;

// lmctf60/g_runes.c: `#define RUNE_REGEN 8`, also exported for real from
// g_runes.ts -- kept as a local copy here (not imported) because g_runes.ts
// already statically imports ArmorIndex/FindItem/ITEM_INDEX from this
// file; a static import back would close a value cycle. Per PORTING.md's
// import-cycle rule this file (g_items.c, the more fundamental item-table
// module) is not the side that breaks it, so this one bitflag constant is
// duplicated by value instead of lazily required, matching the size/risk
// tradeoff PORTING.md accepts for a single never-changing #define.
const RUNE_REGEN = 8;

/*
=================
MegaHealth_think (lmctf60/g_items.c:550) -- byte-identical to the C
source. Only reached for a picked-up HEALTH_TIMED item (item_health_mega),
whose Pickup_Health branch below re-purposes the entity as a ticking
"give back the overflow health" timer on its owner instead of freeing or
respawning it.
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

  if ((self.spawnflags & DROPPED_ITEM) === 0 && gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0) {
    SetRespawn(self, 20);
  } else {
    G_FreeEdict(self);
  }
}

/*
=================
Pickup_Health (lmctf60/g_items.c:581) -- byte-identical to the C source.
The `#ifdef WEAP_BALANCE_OK` overboard-health clamp (CTF_WEAP_BALANCE) is
dropped -- that macro is never `#define`d anywhere in lmctf60, same as
g_weapon.ts's fire_blaster citation for the same macro.
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
  } else if ((ent.spawnflags & DROPPED_ITEM) === 0 && gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0) {
    SetRespawn(ent, 30);
  }

  return true;
}

// lmctf60/g_items.c ~2334: `/* pickup */ "Health"` itemlist entry --
// `classname` is NULL in the C source (confirmed by direct read), which
// matters: g_spawn.ts's ED_CallSpawn checks the item table by classname
// BEFORE spawns[] (the same "item table wins" quirk SP_flag's own doc
// comment documents), and a NULL classname here can never match
// "item_health"/"item_health_small"/etc, so those map classnames correctly
// fall through to g_spawn.ts's spawns[] table and reach the real
// SP_item_health family below -- unlike "flag", which DOES collide with
// the item table and never reaches SP_flag.
function makeHealthItem(): GItemT {
  const item = new GItemT();
  item.pickup = Pickup_Health;
  item.pickup_sound = "items/pkup.wav";
  item.icon = "i_health";
  item.pickup_name = "Health";
  item.count_width = 3;
  item.flags = 0;
  return item;
}

// `gitem_t itemlist[]` -- partial (see file header). Index 0 is always the
// null item in the C source (`{}` first entry so index 0 means "no item");
// preserved here for the same ITEM_INDEX-is-1-based convention src/ctf/g_items.ts
// uses.
const ITEMLIST: GItemT[] = [
  new GItemT(),
  makeHookItem(),
  makeFlagItem(),
  makeBlasterItem(),
  makeHealthItem(),
  makeDamageRuneItem(),
  makeResistRuneItem(),
  makeHasteRuneItem(),
  makeRegenRuneItem(),
];
// lmctf60/g_items.c's real InitItems() sets `game.num_items` (among other
// precache work this partial port does not do); `game` is a shared mutable
// singleton that InitGame's own `game.clear()`/reassignment can wipe after
// this module has already loaded, so `game.num_items` is set here at
// module load AND re-asserted by InitItems() below, which g_main.ts's
// InitGame calls -- matching the C source's real call order
// (InitGame -> InitItems) instead of relying solely on a load-time side
// effect that a later `game.clear()` could silently invalidate.
game.num_items = ITEMLIST.length;

export function InitItems(): void {
  game.num_items = ITEMLIST.length;
}

/*
===============
FindItemByClassname (lmctf60/g_items.c) -- byte-identical to
src/ctf/g_items.ts's FindItemByClassname. Needed by g_trigger.ts's
SP_trigger_key. Subject to the same partial-ITEMLIST caveat as FindItem
above: only "weapon_hook" (and the always-present index-0 null item) can
be found until g_items.c gets its own full diff-driven pass.
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

export function FindItem(pickup_name: string): GItemT | null {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it === undefined || it.pickup_name === null) continue;
    if (Q_stricmp(it.pickup_name, pickup_name) === 0) return it;
  }
  return null;
}

export function GetItemByIndex(index: number): GItemT | null {
  if (index === 0 || index >= game.num_items) return null;
  return ITEMLIST[index] ?? null;
}

export function ITEM_INDEX(item: GItemT): number {
  return ITEMLIST.indexOf(item);
}

// `gitem_t itemlist[]` exposed as a readonly accessor (matching
// src/ctf/g_items.ts's identical convention) for callers outside this file
// that need to iterate the whole table (e.g. p_hud.ts's BeginIntermission
// coop key-strip loop).
export function itemlist(): readonly GItemT[] {
  return ITEMLIST;
}

/*
=================
SetItemNames (lmctf60/g_items.c) -- PARTIAL, scoped to this port's
two-entry ITEMLIST.

The C source also resolves jacket_armor_index/combat_armor_index/
body_armor_index/power_screen_index/power_shield_index here from
FindItem("Jacket Armor") etc; none of those items exist in this port's
ITEMLIST (weapon_hook, flag), so that lookup-and-crash-on-not-found
sequence is not reproduced -- gameIndices' armor fields simply stay at
their module-load default of 0, which is exactly what ArmorIndex/
PowerArmorType above already document as correct behavior for a table with
no armor entries.
=================
*/
export function SetItemNames(): void {
  for (let i = 0; i < game.num_items; i++) {
    const it = ITEMLIST[i];
    if (it === undefined) continue;
    gi.configstring(CS_ITEMS + i, it.pickup_name ?? "");
  }
}

/*
=================
ArmorIndex (unchanged from src/ctf/g_items.ts -- lmctf60/g_items.c's
ArmorIndex is byte-identical to ctf's aside from formatting)

Returns 0 (no armor) whenever none of the three armor items have a
positive inventory count, which is EdictT's default state
(`inventory: Int32Array` zero-fills), so this is correct without a
populated armor entry in ITEMLIST above.
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
PowerArmorType (unchanged from src/ctf/g_items.ts)

Returns POWER_ARMOR_NONE whenever FL_POWER_ARMOR is not set on ent.flags,
which is EdictT's default state, so this is correct without a populated
power-armor/cells entry in ITEMLIST above.
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
===============
PrecacheItem (lmctf60/g_items.c:1131) -- byte-identical to the C source's
extension-sniffing precache loop. Needed so a flag/hook spawn actually
registers its models/sounds with the engine the way a real map load would.
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

  for (const data of s.split(" ")) {
    if (data.length === 0) continue;
    if (data.length < 5) {
      gi.error(`PrecacheItem: ${it.classname ?? ""} has bad precache string`);
    }
    const ext = data.slice(-3);
    if (ext === "md2" || ext === "sp2") gi.modelindex(data);
    else if (ext === "wav") gi.soundindex(data);
    if (ext === "pcx") gi.imageindex(data);
  }
}

/*
===============
SpawnItem (lmctf60/g_items.c:1199) -- PARTIAL, scoped to what this port's
two-entry ITEMLIST ("weapon_hook", "flag") can actually reach.

The C source's full SpawnItem also gates on DF_NO_ARMOR/DF_NO_ITEMS/
DF_NO_HEALTH/DF_INFINITE_AMMO by comparing `item->pickup` against
Pickup_Armor/Pickup_PowerArmor/Pickup_Powerup/Pickup_Health/
Pickup_Adrenaline/Pickup_AncientHead, and against `disabled_weps` by
classname -- none of those Pickup_* functions exist in this port (no armor/
powerup/health items are in ITEMLIST) and `disabled_weps` is not one of the
cvars g_main.ts's InitGame registers (documented skip, see that file's
header), so every one of those branches is unreachable given this port's
actual data and is not reproduced here (there is nothing for them to
compare against). The coop key_power_cube spawnflag bump and the
IT_STAY_COOP drop-nulling ARE reachable in principle and are ported.
===============
*/
export function SpawnItem(ent: EdictT, item: GItemT | null): void {
  if (item === null) return;
  PrecacheItem(item);

  if (ent.spawnflags !== 0) {
    if (ent.classname !== "key_power_cube") {
      ent.spawnflags = 0;
      gi.dprintf(`${ent.classname ?? ""} at ${vtos(ent.s.origin)} has invalid spawnflags set\n`);
    }
  }

  const coop = gameCvars.coop !== null && gameCvars.coop.value !== 0;
  if (coop && ent.classname === "key_power_cube") {
    ent.spawnflags |= 1 << (8 + level.power_cubes);
    level.power_cubes++;
  }

  // don't let them drop items that stay in a coop game
  if (coop && (item.flags & IT_STAY_COOP) !== 0) {
    item.drop = null;
  }

  ent.item = item;
  ent.nextthink = level.time + 2 * 0.1; // FRAMETIME -- items start after other solids
  ent.think = droptofloor;
  ent.s.effects = item.world_model_flags;
  ent.s.renderfx = RF_GLOW;
  if (ent.model !== null) gi.modelindex(ent.model);
}

/*
=================
droptofloor (lmctf60/g_items.c:1054) -- byte-identical to
src/ctf/g_items.ts's droptofloor.
=================
*/
export function droptofloor(ent: EdictT): void {
  const mins = tv(-15, -15, -15);
  VectorCopy(mins, ent.mins);
  const maxs = tv(15, 15, 15);
  VectorCopy(maxs, ent.maxs);

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
      ent.nextthink = level.time + 0.1; // FRAMETIME
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
=================
DoRespawn (lmctf60/g_items.c:118) -- lmctf60 DROPS ctf's weapons-stay
special case entirely (no ctfCvar()/DF_WEAPONS_STAY check -- confirmed by
direct source read, not just the diff header) and simplifies the "picked"
team-chain walk to not bother saving the chosen entity to a `target`
temporary the way ctf/g_utils.ts's ancestor does -- functionally identical
random-pick-from-team-chain, just written as a simple counted walk.
=================
*/
export function DoRespawn(ent: EdictT): void {
  let cur: EdictT | null = ent;

  if (cur.team !== null) {
    const master = cur.teammaster;
    if (master === null) return;

    let count = 0;
    for (let e: EdictT | null = master; e !== null; e = e.chain) count++;

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
SetRespawn (lmctf60/g_items.c) -- byte-identical to src/ctf/g_items.ts's
SetRespawn.
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

/*
=================
Use_Item (lmctf60/g_items.c) -- byte-identical to src/ctf/g_items.ts's
Use_Item.
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
}

/*
=================
Touch_Item (lmctf60/g_items.c:894) -- gates on Match_InCountdown() instead
of ctf's CTFMatchSetup() (LM_CTF's own tourney state machine replaces
ZOID's match system, see g_tourney.ts). The Pickup_Health-specific pickup
sound special-case is dropped: no Pickup_Health function exists anywhere
in this port's ITEMLIST (weapon_hook, flag), so `item.pickup ===
Pickup_Health` can never be true given this port's actual data -- the
general `item.pickup_sound` branch below covers both of this port's real
items correctly (both have a pickup_sound set).
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

    if (item.pickup_sound !== null) {
      gi.sound(other, CHAN_ITEM, gi.soundindex(item.pickup_sound), 1, ATTN_NORM, 0);
    }
  }

  if ((ent.spawnflags & ITEM_TARGETS_USED) === 0) {
    G_UseTargets(ent, other);
    ent.spawnflags |= ITEM_TARGETS_USED;
  }

  if (!taken) return;

  const coop = gameCvars.coop !== null && gameCvars.coop.value !== 0;
  if (!(coop && (item.flags & IT_STAY_COOP) !== 0) || (ent.spawnflags & (DROPPED_ITEM | DROPPED_PLAYER_ITEM)) !== 0) {
    if ((ent.flags & FL_RESPAWN) !== 0) {
      ent.flags &= ~FL_RESPAWN;
    } else {
      G_FreeEdict(ent);
    }
  }
}

/*
=================
drop_temp_touch (lmctf60/g_items.c:961) -- byte-identical to the C source:
a dropped item can't be immediately re-picked-up by the player who dropped
it (skips straight past Touch_Item for that one entity), everyone else
touches it normally.
=================
*/
export function drop_temp_touch(ent: EdictT, other: EdictT, plane: CplaneT | null, surf: CsurfaceT | null): void {
  if (other === ent.owner) return;
  Touch_Item(ent, other, plane, surf);
}

/*
=================
SP_flag (lmctf60/g_items.c:837)

NOTE (observable-behavior quirk, preserved bug-for-bug): g_spawn.c's
ED_CallSpawn checks its item table BEFORE its spawns[] table (confirmed by
direct source read of both quake-2/game/g_spawn.c and lmctf60/g_spawn.c),
and ITEMLIST above has a "flag" entry. This means a map entity with
classname "flag" is ALWAYS routed to SpawnItem(ent, item) by g_spawn.ts's
ED_CallSpawn, never to this function -- `{"flag", SP_flag}` in g_spawn.c's
spawns[] table (and this port's registry) is genuinely dead code in the
original game, not a porting mistake. SP_flag is still ported here (in
case something someday calls it directly, and for source-fidelity), but
the real, reachable flag-spawn path for a mapped flag entity is
SpawnItem/droptofloor/Touch_Item above.
=================
*/
export function SP_flag(self: EdictT): void {
  const deathmatch = gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0;
  if (!deathmatch) {
    G_FreeEdict(self);
    return;
  }

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

/*
=================
SP_item_health / SP_item_health_small / SP_item_health_large /
SP_item_health_mega (lmctf60/g_items.c:2539-2603) -- byte-identical to the
C source. All four route through FindItem("Health") (makeHealthItem's
ITEMLIST entry above) with SpawnItem, matching Pickup_Health's exact
count/style per size. Reached via g_spawn.ts's spawns[] table (see
makeHealthItem's own doc comment for why ED_CallSpawn's item-table-wins
check doesn't intercept these classnames first).
=================
*/
export function SP_item_health(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0 && (gameCvars.dmflags !== null && (gameCvars.dmflags.value & DF_NO_HEALTH) !== 0)) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/medium/tris.md2";
  self.count = 10;
  SpawnItem(self, FindItem("Health"));
  gi.soundindex("items/n_health.wav");
}

export function SP_item_health_small(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0 && (gameCvars.dmflags !== null && (gameCvars.dmflags.value & DF_NO_HEALTH) !== 0)) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/stimpack/tris.md2";
  self.count = 2;
  SpawnItem(self, FindItem("Health"));
  self.style = HEALTH_IGNORE_MAX;
  gi.soundindex("items/s_health.wav");
}

export function SP_item_health_large(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0 && (gameCvars.dmflags !== null && (gameCvars.dmflags.value & DF_NO_HEALTH) !== 0)) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/healing/large/tris.md2";
  self.count = 25;
  SpawnItem(self, FindItem("Health"));
  gi.soundindex("items/l_health.wav");
}

export function SP_item_health_mega(self: EdictT): void {
  if (gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0 && (gameCvars.dmflags !== null && (gameCvars.dmflags.value & DF_NO_HEALTH) !== 0)) {
    G_FreeEdict(self);
    return;
  }

  self.model = "models/items/mega_h/tris.md2";
  self.count = 100;
  SpawnItem(self, FindItem("Health"));
  gi.soundindex("items/m_health.wav");
  self.style = HEALTH_IGNORE_MAX | HEALTH_TIMED;
}
