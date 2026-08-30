// Ports a SUBSET of lmctf60/g_items.c (2634 lines total; diff vs
// quake-2/ctf/g_items.c is 893 lines of 2446 -- real deltas beyond
// formatting, not yet fully reviewed).
//
// STATUS: only the item-table plumbing and armor-lookup helpers the
// offhand-hook priority feature's dependency chain needs are ported:
// FindItem/GetItemByIndex/ITEM_INDEX (generic lookup) and
// ArmorIndex/PowerArmorType (both of which -- see the doc comments below --
// only need `ent.flags`/`ent.client.pers.inventory` to be zeroed, which is
// EdictT/ClientPersistentT's default state, not a populated item table).
// The itemlist itself contains ONLY the "weapon_hook" entry
// (lmctf60/g_items.c's `/* weapon_hook */` block, ~line 2384) since that is
// the one item Cmd_Hook_f (g_cmds.ts) and Weapon_Hook (p_weapon.ts) look up
// by name. The other ~40 item entries (weapons, ammo, armor, powerups,
// runes, the two flags) are NOT ported -- FindItem/GetItemByIndex will not
// find them. This is a deliberately partial file, not a finished one.

import { Q_stricmp } from "../shared/q_shared";
import {
  type EdictT,
  FL_POWER_ARMOR,
  GItemT,
  IT_WEAPON,
  POWER_ARMOR_NONE,
  POWER_ARMOR_SCREEN,
  POWER_ARMOR_SHIELD,
  WEAP_HOOK,
  game,
  gameIndices,
} from "./g_local";
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

// `gitem_t itemlist[]` -- partial (see file header). Index 0 is always the
// null item in the C source (`{}` first entry so index 0 means "no item");
// preserved here for the same ITEM_INDEX-is-1-based convention src/ctf/g_items.ts
// uses.
const ITEMLIST: GItemT[] = [new GItemT(), makeHookItem()];
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
