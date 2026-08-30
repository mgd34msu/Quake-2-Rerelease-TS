// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// bot_exports.cpp (187 lines, 2023 Quake II re-release / "KEX" engine),
// ported from ~/Projects/quake2-rerelease-dll/rerelease/bots/bot_exports.cpp:
// the six behavioral functions g_main.ts's own header cited as "throwing
// stubs (bots/ subsystem)" -- Bot_SetWeapon/Bot_TriggerEdict/Bot_UseItem/
// Bot_GetItemID/Edict_ForceLookAtPoint/Bot_PickedUpItem. Each is a
// KexGameExports slot; g_main.ts's GetGameAPI wires its six stub bodies to
// these real exports (see that file's own updated header for the exact
// diff).
//
// ============================================================================
// null_trace -- local copy, not shared (Bot_TriggerEdict's `trace_t unUsed;`)
// ============================================================================
// g_utils.ts's own `null_trace` (g_local.h:627: `constexpr trace_t
// null_trace {};`) is module-local there, so this file keeps its own copy,
// matching every other file in this port line that needs a
// default-constructed `trace_t` (see that file's header for the field-by-
// field justification).
//
// ============================================================================
// g_instant_weapon_switch -- direct `.value` poke, not gi.cvar_set
// ============================================================================
// The real C++ (`Bot_SetWeapon`'s own "FIXME: ugly, maybe store in client
// later" comment) temporarily writes `g_instant_weapon_switch->integer`
// directly, calls `ChangeWeapon`, then restores the old value -- bypassing
// `Cvar_Set`'s normal latch/side-effect path entirely, on purpose, so the
// override is invisible to everything except the one `ChangeWeapon` call in
// between. This port's `CvarT` (q_shared.ts) has no `.integer` field (see
// g_main.ts's own "Cvar_WasModified" header note for that documented gap),
// only `.value` -- `gi.cvar(name, def, flags)` returns the SAME registered
// `CvarT` object on every call (real cvar semantics: first call registers,
// every later call with the same name returns the existing pointer), so
// writing `.value` directly on that returned object, calling `ChangeWeapon`
// (which reads the cvar back via its own `cvarBool` helper, p_weapon.ts),
// then restoring `.value` reproduces the exact same observable hack with
// the field this port's `CvarT` actually has.
//
// ============================================================================
// anglemod -- kex's OWN fmod-based version, local copy (not shared/math.ts's)
// ============================================================================
// g_misc.ts's own header already documents this exact fork: shared/math.ts's
// `anglemod` is the LEGACY 16-bit-quantized version (`(360/65536) *
// (trunc(a*65536/360) & 65535)`), but kex's own q_std.h:185 `anglemod` is a
// plain `fmod(a, 360)` with a below-zero correction -- a different function
// with the same name. `Edict_ForceLookAtPoint` is kex-era code
// (bots/bot_exports.cpp includes g_local.h, which pulls in q_std.h), so it
// gets q_std.h's version, ported locally exactly like g_misc.ts/m_move.ts/
// g_ai.ts/g_func.ts/m_medic.ts/m_rogue_turret.ts/m_rogue_carrier.ts each
// already carry their own copy for the identical reason.

import { type Vec3, vec3 } from "../../shared/math";
import { CplaneT } from "../../shared/q_shared";
import { type KexTraceT, ContentsT, CvarFlagsT, SvflagsT } from "../../kexapi/game";
import { type EdictT, type GitemT, ItemFlagsT, ItemIdT } from "../g_local";
import { gi } from "../g_main_globals";
import { itemlist, ValidateSelectedItem } from "../g_items";
import { ChangeWeapon } from "../p_weapon";
import { Q_strcasecmp } from "../q_std";
import { vec3_add, vec3_sub, vec3_normalized, vectoangles } from "../q_vec3";

/** g_local.h:627: `constexpr trace_t null_trace {};` -- see file header. */
const null_trace: KexTraceT = {
  allsolid: false,
  startsolid: false,
  fraction: 0,
  endpos: vec3(),
  plane: new CplaneT(),
  surface: null,
  contents: ContentsT.CONTENTS_NONE,
  ent: null,
  plane2: new CplaneT(),
  surface2: null,
};

/** q_std.h:185's kex-era `anglemod` -- see file header. */
function anglemod(a: number): number {
  const v = a % 360;
  return v < 0 ? 360 + v : v;
}

/** bot_exports.cpp:12-61: `void Bot_SetWeapon(edict_t*, const int, const bool)`. */
export function Bot_SetWeapon(bot: EdictT, weaponIndex: number, instantSwitch: boolean): void {
  if (weaponIndex <= ItemIdT.IT_NULL || weaponIndex > ItemIdT.IT_TOTAL) return;
  if ((bot.svflags & SvflagsT.SVF_BOT) === 0) return;

  const client = bot.client;
  if (client === null || client.pers.inventory[weaponIndex] === 0) return;

  const weaponItemID = weaponIndex;

  const currentGun = client.pers.weapon;
  if (currentGun !== null) {
    if (currentGun.id === weaponItemID) return; // already have the gun in hand.
  }

  const pendingGun = client.newweapon;
  if (pendingGun !== null) {
    if (pendingGun.id === weaponItemID) return; // already in the process of switching to that gun, just be patient!
  }

  const item: GitemT = itemlist[weaponIndex];
  if ((item.flags & ItemFlagsT.IF_WEAPON) === 0) return;
  if (item.use === null) return;

  client.no_weapon_chains = true;
  item.use(bot, item);

  if (instantSwitch) {
    // FIXME: ugly, maybe store in client later -- see file header
    const cvar = gi.cvar("g_instant_weapon_switch", "0", CvarFlagsT.CVAR_LATCH);
    if (cvar !== null) {
      const temp_instant_weapon = cvar.value;
      cvar.value = 1;
      ChangeWeapon(bot);
      cvar.value = temp_instant_weapon;
    } else {
      ChangeWeapon(bot);
    }
  }
}

/** bot_exports.cpp:68-85: `void Bot_TriggerEdict(edict_t*, edict_t*)`. */
export function Bot_TriggerEdict(bot: EdictT, edict: EdictT): void {
  if (!bot.inuse || !edict.inuse) return;
  if ((bot.svflags & SvflagsT.SVF_BOT) === 0) return;

  if (edict.use !== null) edict.use(edict, bot, bot);

  if (edict.touch !== null) edict.touch(edict, bot, null_trace, true);
}

/** bot_exports.cpp:92-123: `void Bot_UseItem(edict_t*, const int32_t)`. */
export function Bot_UseItem(bot: EdictT, itemID: number): void {
  if (!bot.inuse) return;
  if ((bot.svflags & SvflagsT.SVF_BOT) === 0) return;
  if (bot.client === null) throw new Error("Bot_UseItem: bot.client is null (invariant violated)");

  const desiredItemID: ItemIdT = itemID;
  bot.client.pers.selected_item = desiredItemID;

  ValidateSelectedItem(bot);

  if (bot.client.pers.selected_item === ItemIdT.IT_NULL) return;
  if (bot.client.pers.selected_item !== desiredItemID) return; // the itemID changed on us -- don't use it!

  const item: GitemT = itemlist[bot.client.pers.selected_item];
  bot.client.pers.selected_item = ItemIdT.IT_NULL;

  if (item.use === null) return;

  bot.client.no_weapon_chains = true;
  item.use(bot, item);
}

/** bot_exports.cpp:130-151: `int32_t Bot_GetItemID(const char*)`. */
export function Bot_GetItemID(classname: string): number {
  const Item_Invalid = -1;
  const Item_Null = 0;

  if (classname.length === 0) return Item_Invalid;
  if (Q_strcasecmp(classname, "none") === 0) return Item_Null;

  for (let i = 0; i < ItemIdT.IT_TOTAL; ++i) {
    const item = itemlist[i];
    if (item.classname === null || item.classname.length === 0) continue;
    if (Q_strcasecmp(item.classname, classname) === 0) return item.id;
  }

  return Item_Invalid;
}

/** bot_exports.cpp:158-177: `void Edict_ForceLookAtPoint(edict_t*, gvec3_cref_t)`. */
export function Edict_ForceLookAtPoint(edict: EdictT, point: Vec3): void {
  let viewOrigin = edict.s.origin;
  if (edict.client !== null) viewOrigin = vec3_add(viewOrigin, edict.client.ps.viewoffset);

  const ideal = vec3_normalized(vec3_sub(point, viewOrigin));

  const viewAngles = vectoangles(ideal);
  if (viewAngles[0] < -180.0) viewAngles[0] = anglemod(viewAngles[0] + 360.0);

  if (edict.client !== null) {
    edict.client.ps.pmove.delta_angles = vec3_sub(viewAngles, edict.client.resp.cmd_angles);
    edict.client.ps.viewangles = vec3(0, 0, 0);
    edict.client.v_angle = vec3(0, 0, 0);
    edict.s.angles = vec3(0, 0, 0);
  }
}

/**
 * bot_exports.cpp:186-188: `bool Bot_PickedUpItem(edict_t*, edict_t*)`. Check
 * if the given bot has picked up the given item or not.
 */
export function Bot_PickedUpItem(bot: EdictT, item: EdictT): boolean {
  return item.item_picked_up_by[bot.s.number - 1];
}
