// g_cmds.c

import { vec3_origin } from "../shared/math";
import {
  Com_sprintf,
  CVAR_SERVERINFO,
  DF_MODELTEAMS,
  DF_SKINTEAMS,
  Info_ValueForKey,
  MAX_ITEMS,
  PMF_DUCKED,
  PRINT_CHAT,
  PRINT_HIGH,
  Q_stricmp,
  STAT_FRAGS,
} from "../shared/q_shared";
import {
  ANIM_WAVE,
  type EdictT,
  FL_GODMODE,
  FL_NOTARGET,
  g_edicts,
  game,
  gameCvars,
  gi,
  GitemArmorT,
  IT_AMMO,
  IT_ARMOR,
  IT_POWERUP,
  IT_WEAPON,
  level,
  MOD_SUICIDE,
  MovetypeT,
  meansOfDeathHolder,
  svc_inventory,
} from "./g_local";
import type { Edict } from "./game";
import { SolidT } from "./game";
import { ChaseNext, ChasePrev } from "./g_chase";
import { Add_Ammo, FindItem, ITEM_INDEX, itemlist, SpawnItem, Touch_Item } from "./g_items";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { player_die } from "./p_client";
import { PMenu_Close, PMenu_Next, PMenu_Prev, PMenu_Select } from "./p_menu";
import {
  CTFAdmin,
  CTFBoot,
  CTFGhost,
  CTFID_f,
  CtfTeamT,
  CTFNotReady,
  CTFObserver,
  CTFOpenJoinMenu,
  CTFPlayerList,
  CTFReady,
  CTFSay_Team,
  CTFStats,
  CTFTeam_f,
  CTFVoteNo,
  CTFVoteYes,
  CTFWarp,
  CTFWhat_Tech,
} from "./g_ctf";

import { FRAME_flip01, FRAME_flip12, FRAME_salute01, FRAME_salute11, FRAME_taunt01, FRAME_taunt17, FRAME_wave01, FRAME_wave11, FRAME_point01, FRAME_point12 } from "./m_player_frames";

// atoi(): C's atoi returns 0 for a string with no valid leading integer.
function atoiC(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function cvarNum(c: { value: number } | null): number {
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

function ClientTeam(ent: EdictT): string {
  if (ent.client === null) return "";

  const value = Info_ValueForKey(ent.client.pers.userinfo, "skin");
  const slash = value.indexOf("/");
  if (slash === -1) return value;

  if (cvarNum(gameCvars.dmflags) & DF_MODELTEAMS) {
    return value.slice(0, slash);
  }

  // if (dmflags & DF_SKINTEAMS)
  return value.slice(slash + 1);
}

export function OnSameTeam(ent1: EdictT, ent2: EdictT): boolean {
  if (!(cvarNum(gameCvars.dmflags) & (DF_MODELTEAMS | DF_SKINTEAMS))) return false;

  return ClientTeam(ent1) === ClientTeam(ent2);
}

export function SelectNextItem(ent: EdictT, itflags: number): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.menu !== null) {
    PMenu_Next(ent);
    return;
  } else if (cl.chase_target !== null) {
    ChaseNext(ent);
    return;
  }

  // scan for the next valid one
  const items = itemlist();
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (cl.pers.selected_item + i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = items[index];
    if (!it.use) continue;
    if (!(it.flags & itflags)) continue;

    cl.pers.selected_item = index;
    return;
  }

  cl.pers.selected_item = -1;
}

export function SelectPrevItem(ent: EdictT, itflags: number): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.menu !== null) {
    PMenu_Prev(ent);
    return;
  } else if (cl.chase_target !== null) {
    ChasePrev(ent);
    return;
  }

  // scan for the next valid one
  const items = itemlist();
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (cl.pers.selected_item + MAX_ITEMS - i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = items[index];
    if (!it.use) continue;
    if (!(it.flags & itflags)) continue;

    cl.pers.selected_item = index;
    return;
  }

  cl.pers.selected_item = -1;
}

export function ValidateSelectedItem(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.pers.inventory[cl.pers.selected_item]) return; // valid

  SelectNextItem(ent, -1);
}

//=================================================================================

/*
==================
Cmd_Give_f

Give items to a client
==================
*/
export function Cmd_Give_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (cvarNum(gameCvars.deathmatch) && !cvarNum(gameCvars.sv_cheats)) {
    gi.cprintf(ent, PRINT_HIGH, "You must run the server with '+set cheats 1' to enable this command.\n");
    return;
  }

  const name = gi.args();
  const giveAll = Q_stricmp(name, "all") === 0;

  if (giveAll || Q_stricmp(gi.argv(1), "health") === 0) {
    if (gi.argc() === 3) ent.health = atoiC(gi.argv(2));
    else ent.health = ent.max_health;
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "weapons") === 0) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (!it.pickup) continue;
      if (!(it.flags & IT_WEAPON)) continue;
      client.pers.inventory[i] += 1;
    }
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "ammo") === 0) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (!it.pickup) continue;
      if (!(it.flags & IT_AMMO)) continue;
      Add_Ammo(ent, it, 1000);
    }
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "armor") === 0) {
    const jacket = FindItem("Jacket Armor");
    if (jacket !== null) client.pers.inventory[ITEM_INDEX(jacket)] = 0;

    const combat = FindItem("Combat Armor");
    if (combat !== null) client.pers.inventory[ITEM_INDEX(combat)] = 0;

    const body = FindItem("Body Armor");
    if (body !== null && body.info instanceof GitemArmorT) {
      client.pers.inventory[ITEM_INDEX(body)] = body.info.max_count;
    }

    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "Power Shield") === 0) {
    const it = FindItem("Power Shield");
    if (it !== null) {
      const it_ent = G_Spawn();
      it_ent.classname = it.classname;
      SpawnItem(it_ent, it);
      Touch_Item(it_ent, ent, null, null);
      if (it_ent.inuse) G_FreeEdict(it_ent);
    }

    if (!giveAll) return;
  }

  if (giveAll) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (!it.pickup) continue;
      if (it.flags & (IT_ARMOR | IT_WEAPON | IT_AMMO)) continue;
      client.pers.inventory[i] = 1;
    }
    return;
  }

  let it = FindItem(name);
  if (it === null) {
    it = FindItem(gi.argv(1));
    if (it === null) {
      gi.cprintf(ent, PRINT_HIGH, "unknown item\n");
      return;
    }
  }

  if (!it.pickup) {
    gi.cprintf(ent, PRINT_HIGH, "non-pickup item\n");
    return;
  }

  const index = ITEM_INDEX(it);

  if (it.flags & IT_AMMO) {
    if (gi.argc() === 3) client.pers.inventory[index] = atoiC(gi.argv(2));
    else client.pers.inventory[index] += it.quantity;
  } else {
    const it_ent = G_Spawn();
    it_ent.classname = it.classname;
    SpawnItem(it_ent, it);
    Touch_Item(it_ent, ent, null, null);
    if (it_ent.inuse) G_FreeEdict(it_ent);
  }
}

/*
==================
Cmd_God_f

Sets client to godmode

argv(0) god
==================
*/
export function Cmd_God_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) && !cvarNum(gameCvars.sv_cheats)) {
    gi.cprintf(ent, PRINT_HIGH, "You must run the server with '+set cheats 1' to enable this command.\n");
    return;
  }

  ent.flags ^= FL_GODMODE;
  const msg = !(ent.flags & FL_GODMODE) ? "godmode OFF\n" : "godmode ON\n";

  gi.cprintf(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Notarget_f

Sets client to notarget

argv(0) notarget
==================
*/
export function Cmd_Notarget_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) && !cvarNum(gameCvars.sv_cheats)) {
    gi.cprintf(ent, PRINT_HIGH, "You must run the server with '+set cheats 1' to enable this command.\n");
    return;
  }

  ent.flags ^= FL_NOTARGET;
  const msg = !(ent.flags & FL_NOTARGET) ? "notarget OFF\n" : "notarget ON\n";

  gi.cprintf(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Noclip_f

argv(0) noclip
==================
*/
export function Cmd_Noclip_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) && !cvarNum(gameCvars.sv_cheats)) {
    gi.cprintf(ent, PRINT_HIGH, "You must run the server with '+set cheats 1' to enable this command.\n");
    return;
  }

  let msg: string;
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) {
    ent.movetype = MovetypeT.MOVETYPE_WALK;
    msg = "noclip OFF\n";
  } else {
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    msg = "noclip ON\n";
  }

  gi.cprintf(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Use_f

Use an inventory item
==================
*/
export function Cmd_Use_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const s = gi.args();
  const it = FindItem(s);
  if (it === null) {
    gi.cprintf(ent, PRINT_HIGH, `unknown item: ${s}\n`);
    return;
  }
  if (!it.use) {
    gi.cprintf(ent, PRINT_HIGH, "Item is not usable.\n");
    return;
  }
  const index = ITEM_INDEX(it);
  if (!client.pers.inventory[index]) {
    gi.cprintf(ent, PRINT_HIGH, `Out of item: ${s}\n`);
    return;
  }

  it.use(ent, it);
}

/*
==================
Cmd_Drop_f

Drop an inventory item
==================
*/
export function Cmd_Drop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  //special case for tech powerups
  if (Q_stricmp(gi.args(), "tech") === 0) {
    const tech = CTFWhat_Tech(ent);
    if (tech !== null && tech.drop !== null) {
      tech.drop(ent, tech);
      return;
    }
  }

  const s = gi.args();
  const it = FindItem(s);
  if (it === null) {
    gi.cprintf(ent, PRINT_HIGH, `unknown item: ${s}\n`);
    return;
  }
  if (!it.drop) {
    gi.cprintf(ent, PRINT_HIGH, "Item is not dropable.\n");
    return;
  }
  const index = ITEM_INDEX(it);
  if (!client.pers.inventory[index]) {
    gi.cprintf(ent, PRINT_HIGH, `Out of item: ${s}\n`);
    return;
  }

  it.drop(ent, it);
}

/*
=================
Cmd_Inven_f
=================
*/
export function Cmd_Inven_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  cl.showscores = false;
  cl.showhelp = false;

  if (cl.menu !== null) {
    PMenu_Close(ent);
    cl.update_chase = true;
    return;
  }

  if (cl.showinventory) {
    cl.showinventory = false;
    return;
  }

  if (ctfCvar() !== 0 && cl.resp.ctf_team === CtfTeamT.CTF_NOTEAM) {
    CTFOpenJoinMenu(ent);
    return;
  }

  cl.showinventory = true;

  gi.WriteByte(svc_inventory);
  for (let i = 0; i < MAX_ITEMS; i++) {
    gi.WriteShort(cl.pers.inventory[i]);
  }
  gi.unicast(ent, true);
}

/*
=================
Cmd_InvUse_f
=================
*/
export function Cmd_InvUse_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu !== null) {
    PMenu_Select(ent);
    return;
  }

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === -1) {
    gi.cprintf(ent, PRINT_HIGH, "No item to use.\n");
    return;
  }

  const it = itemlist()[client.pers.selected_item];
  if (!it.use) {
    gi.cprintf(ent, PRINT_HIGH, "Item is not usable.\n");
    return;
  }
  it.use(ent, it);
}

/*
=================
Cmd_LastWeap_f
=================
*/
export function Cmd_LastWeap_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.pers.weapon === null || cl.pers.lastweapon === null) return;

  if (cl.pers.lastweapon.use) cl.pers.lastweapon.use(ent, cl.pers.lastweapon);
}

/*
=================
Cmd_WeapPrev_f
=================
*/
export function Cmd_WeapPrev_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.pers.weapon === null) return;

  const selected_weapon = ITEM_INDEX(cl.pers.weapon);
  const items = itemlist();

  // scan for the next valid one
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (selected_weapon + i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = items[index];
    if (!it.use) continue;
    if (!(it.flags & IT_WEAPON)) continue;
    it.use(ent, it);
    if (cl.pers.weapon === it) return; // successful
  }
}

/*
=================
Cmd_WeapNext_f
=================
*/
export function Cmd_WeapNext_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.pers.weapon === null) return;

  const selected_weapon = ITEM_INDEX(cl.pers.weapon);
  const items = itemlist();

  // scan for the next valid one
  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (selected_weapon + MAX_ITEMS - i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = items[index];
    if (!it.use) continue;
    if (!(it.flags & IT_WEAPON)) continue;
    it.use(ent, it);
    if (cl.pers.weapon === it) return; // successful
  }
}

/*
=================
Cmd_WeapLast_f
=================
*/
export function Cmd_WeapLast_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.pers.weapon === null || cl.pers.lastweapon === null) return;

  const index = ITEM_INDEX(cl.pers.lastweapon);
  if (!cl.pers.inventory[index]) return;
  const it = itemlist()[index];
  if (!it.use) return;
  if (!(it.flags & IT_WEAPON)) return;
  it.use(ent, it);
}

/*
=================
Cmd_InvDrop_f
=================
*/
export function Cmd_InvDrop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === -1) {
    gi.cprintf(ent, PRINT_HIGH, "No item to drop.\n");
    return;
  }

  const it = itemlist()[client.pers.selected_item];
  if (!it.drop) {
    gi.cprintf(ent, PRINT_HIGH, "Item is not dropable.\n");
    return;
  }
  it.drop(ent, it);
}

/*
=================
Cmd_Kill_f
=================
*/
export function Cmd_Kill_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (ent.solid === SolidT.SOLID_NOT) return;

  if (level.time - client.respawn_time < 5) return;
  ent.flags &= ~FL_GODMODE;
  ent.health = 0;
  meansOfDeathHolder.meansOfDeath = MOD_SUICIDE;
  player_die(ent, ent, ent, 100000, vec3_origin);
}

/*
=================
Cmd_PutAway_f
=================
*/
export function Cmd_PutAway_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.showscores = false;
  client.showhelp = false;
  client.showinventory = false;
  if (client.menu !== null) PMenu_Close(ent);
  client.update_chase = true;
}

function PlayerSort(a: number, b: number): number {
  const anum = game.clients[a].ps.stats[STAT_FRAGS];
  const bnum = game.clients[b].ps.stats[STAT_FRAGS];

  if (anum < bnum) return -1;
  if (anum > bnum) return 1;
  return 0;
}

/*
=================
Cmd_Players_f
=================
*/
export function Cmd_Players_f(ent: EdictT): void {
  const maxclients = cvarNum(gameCvars.maxclients);

  const index: number[] = [];
  for (let i = 0; i < maxclients; i++) {
    if (game.clients[i].pers.connected) index.push(i);
  }

  // sort by frags
  index.sort(PlayerSort);

  // print information
  let large = "";

  for (let i = 0; i < index.length; i++) {
    const small = Com_sprintf("%3i %s\n", game.clients[index[i]].ps.stats[STAT_FRAGS], game.clients[index[i]].pers.netname);
    if (small.length + large.length > 1280 - 100) {
      // can't print all of them in one packet
      large += "...\n";
      break;
    }
    large += small;
  }

  gi.cprintf(ent, PRINT_HIGH, `${large}\n${index.length} players\n`);
}

/*
=================
Cmd_Wave_f
=================
*/
export function Cmd_Wave_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const i = atoiC(gi.argv(1));

  // can't wave when ducked
  if (client.ps.pmove.pm_flags & PMF_DUCKED) return;

  if (client.anim_priority > ANIM_WAVE) return;

  client.anim_priority = ANIM_WAVE;

  switch (i) {
    case 0:
      gi.cprintf(ent, PRINT_HIGH, "flipoff\n");
      ent.s.frame = FRAME_flip01 - 1;
      client.anim_end = FRAME_flip12;
      break;
    case 1:
      gi.cprintf(ent, PRINT_HIGH, "salute\n");
      ent.s.frame = FRAME_salute01 - 1;
      client.anim_end = FRAME_salute11;
      break;
    case 2:
      gi.cprintf(ent, PRINT_HIGH, "taunt\n");
      ent.s.frame = FRAME_taunt01 - 1;
      client.anim_end = FRAME_taunt17;
      break;
    case 3:
      gi.cprintf(ent, PRINT_HIGH, "wave\n");
      ent.s.frame = FRAME_wave01 - 1;
      client.anim_end = FRAME_wave11;
      break;
    case 4:
    default:
      gi.cprintf(ent, PRINT_HIGH, "point\n");
      ent.s.frame = FRAME_point01 - 1;
      client.anim_end = FRAME_point12;
      break;
  }
}

// CheckFlood is g_ctf.ts's CTFSay_Team delta on top of the base Cmd_Say_f's
// inline flood-protection block: pulled out into its own function so both
// call sites share the same rate limiting.
export function CheckFlood(ent: EdictT): boolean {
  const client = ent.client;
  if (client === null) return false;

  const floodMsgs = cvarNum(gameCvars.flood_msgs);
  if (floodMsgs) {
    if (level.time < client.flood_locktill) {
      gi.cprintf(ent, PRINT_HIGH, `You can't talk for ${Math.trunc(client.flood_locktill - level.time)} more seconds\n`);
      return true;
    }
    let i = client.flood_whenhead - floodMsgs + 1;
    if (i < 0) i = client.flood_when.length + i;
    const floodPersecond = cvarNum(gameCvars.flood_persecond);
    if (client.flood_when[i] && level.time - client.flood_when[i] < floodPersecond) {
      const floodWaitdelay = cvarNum(gameCvars.flood_waitdelay);
      client.flood_locktill = level.time + floodWaitdelay;
      gi.cprintf(ent, PRINT_CHAT, `Flood protection:  You can't talk for ${Math.trunc(floodWaitdelay)} seconds.\n`);
      return true;
    }
    client.flood_whenhead = (client.flood_whenhead + 1) % client.flood_when.length;
    client.flood_when[client.flood_whenhead] = level.time;
  }
  return false;
}

/*
==================
Cmd_Say_f
==================
*/
export function Cmd_Say_f(ent: EdictT, teamIn: boolean, arg0: boolean): void {
  const client = ent.client;
  if (client === null) return;

  if (gi.argc() < 2 && !arg0) return;

  let team = teamIn;
  if (!(cvarNum(gameCvars.dmflags) & (DF_MODELTEAMS | DF_SKINTEAMS))) team = false;

  let text: string;
  if (team) text = `(${client.pers.netname}): `;
  else text = `${client.pers.netname}: `;

  if (arg0) {
    text += `${gi.argv(0)} ${gi.args()}`;
  } else {
    let p = gi.args();

    if (p.startsWith('"')) {
      p = p.slice(1);
      if (p.length > 0) p = p.slice(0, -1);
    }
    text += p;
  }

  // don't let text be too long for malicious reasons
  if (text.length > 150) text = text.slice(0, 150);

  text += "\n";

  if (CheckFlood(ent)) return;

  if (cvarNum(gameCvars.dedicated)) gi.cprintf(null, PRINT_CHAT, text);

  const maxclients = game.maxclients;
  for (let j = 1; j <= maxclients; j++) {
    const other = g_edicts[j];
    if (!other.inuse) continue;
    if (other.client === null) continue;
    if (team) {
      if (!OnSameTeam(ent, other)) continue;
    }
    gi.cprintf(other, PRINT_CHAT, text);
  }
}

// Cmd_PlayerList_f is dropped: ctf/g_cmds.c removes this function entirely
// and rewires the "playerlist" command to g_ctf.c's CTFPlayerList instead
// (see ClientCommand below).

import { Cmd_Help_f, Cmd_Score_f } from "./p_hud";
import { Cmd_Compass_f } from "./g_kextarg";

// Recovers the full EdictT for the `Edict` ClientCommand receives across the
// GameExports boundary, by reference identity rather than the EDICT_NUM
// idiom (g_edicts[ent.s.number]). p_client.ts's edictFromBoundary comment
// (commit 77082d8) explains why the numeric lookup is unsound here: on a
// fresh boot, g_spawn.ts's SpawnEntities `.clear()`s every edict including
// reserved player slots, and a player slot's `s.number` is not restored
// until sv_user.ts's SV_New_f runs. sv_ccmds.ts and sv_user.ts can both
// dispatch client stringcmds (this function) before that point, so a
// just-connected, not-yet-`new`'d client's `edict.s.number` can still read
// stale-zero, and the numeric lookup would silently resolve to the world
// edict instead of the real client. Recovering by reference identity
// sidesteps that staleness window entirely and needs no cast (EdictT
// structurally satisfies Edict, so `===` narrows cleanly).
function edictFromBoundary(entIn: Edict): EdictT {
  const found = g_edicts.find((e) => e === entIn);
  if (found !== undefined) return found;
  gi.error("g_cmds: boundary edict not found in g_edicts");
}

/*
=================
ClientCommand
=================
*/
// ClientCommand is a GameExports boundary member (crosses from server code,
// which only sees `Edict`); recover the full game-private `EdictT` via
// edictFromBoundary rather than the EDICT_NUM idiom (g_edicts[ent.s.number])
// or a cast -- see edictFromBoundary's comment above.
export function ClientCommand(edict: Edict): void {
  const ent = edictFromBoundary(edict);
  if (ent.client === null) return; // not fully in game yet

  const cmd = gi.argv(0);

  if (Q_stricmp(cmd, "players") === 0) {
    Cmd_Players_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "say") === 0) {
    Cmd_Say_f(ent, false, false);
    return;
  }
  if (Q_stricmp(cmd, "say_team") === 0 || Q_stricmp(cmd, "steam") === 0) {
    CTFSay_Team(ent, gi.args());
    return;
  }
  if (Q_stricmp(cmd, "score") === 0) {
    Cmd_Score_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "help") === 0) {
    Cmd_Help_f(ent);
    return;
  }

  if (level.intermissiontime) return;

  if (Q_stricmp(cmd, "use") === 0) Cmd_Use_f(ent);
  else if (Q_stricmp(cmd, "drop") === 0) Cmd_Drop_f(ent);
  else if (Q_stricmp(cmd, "give") === 0) Cmd_Give_f(ent);
  else if (Q_stricmp(cmd, "god") === 0) Cmd_God_f(ent);
  else if (Q_stricmp(cmd, "notarget") === 0) Cmd_Notarget_f(ent);
  else if (Q_stricmp(cmd, "noclip") === 0) Cmd_Noclip_f(ent);
  else if (Q_stricmp(cmd, "inven") === 0) Cmd_Inven_f(ent);
  else if (Q_stricmp(cmd, "invnext") === 0) SelectNextItem(ent, -1);
  else if (Q_stricmp(cmd, "invprev") === 0) SelectPrevItem(ent, -1);
  else if (Q_stricmp(cmd, "invnextw") === 0) SelectNextItem(ent, IT_WEAPON);
  else if (Q_stricmp(cmd, "invprevw") === 0) SelectPrevItem(ent, IT_WEAPON);
  else if (Q_stricmp(cmd, "invnextp") === 0) SelectNextItem(ent, IT_POWERUP);
  else if (Q_stricmp(cmd, "invprevp") === 0) SelectPrevItem(ent, IT_POWERUP);
  else if (Q_stricmp(cmd, "invuse") === 0) Cmd_InvUse_f(ent);
  else if (Q_stricmp(cmd, "invdrop") === 0) Cmd_InvDrop_f(ent);
  else if (Q_stricmp(cmd, "weapprev") === 0) Cmd_WeapPrev_f(ent);
  else if (Q_stricmp(cmd, "weapnext") === 0) Cmd_WeapNext_f(ent);
  else if (Q_stricmp(cmd, "weaplast") === 0) Cmd_WeapLast_f(ent);
  else if (Q_stricmp(cmd, "kill") === 0) Cmd_Kill_f(ent);
  else if (Q_stricmp(cmd, "putaway") === 0) Cmd_PutAway_f(ent);
  else if (Q_stricmp(cmd, "wave") === 0) Cmd_Wave_f(ent);
  else if (Q_stricmp(cmd, "team") === 0) CTFTeam_f(ent);
  else if (Q_stricmp(cmd, "id") === 0) CTFID_f(ent);
  else if (Q_stricmp(cmd, "yes") === 0) CTFVoteYes(ent);
  else if (Q_stricmp(cmd, "no") === 0) CTFVoteNo(ent);
  else if (Q_stricmp(cmd, "ready") === 0) CTFReady(ent);
  else if (Q_stricmp(cmd, "notready") === 0) CTFNotReady(ent);
  else if (Q_stricmp(cmd, "ghost") === 0) CTFGhost(ent);
  else if (Q_stricmp(cmd, "admin") === 0) CTFAdmin(ent);
  else if (Q_stricmp(cmd, "stats") === 0) CTFStats(ent);
  else if (Q_stricmp(cmd, "warp") === 0) CTFWarp(ent);
  else if (Q_stricmp(cmd, "boot") === 0) CTFBoot(ent);
  else if (Q_stricmp(cmd, "playerlist") === 0) CTFPlayerList(ent);
  else if (Q_stricmp(cmd, "observer") === 0) CTFObserver(ent);
  // RERELEASE CONTENT: the compass/objective marker. The rerelease reaches
  // Use_Compass through the IT_COMPASS inventory item; the classic itemlist
  // is a frozen, index-stable table the save format depends on, so it is
  // reached through this command instead (see g_kextarg.ts's Cmd_Compass_f,
  // which is deliberately NOT called Use_Compass -- g_items.ts already has
  // one of those, the rogue compass ITEM).
  // Emits nothing on a narrow session -- gi.poi() is a no-op there.
  else if (Q_stricmp(cmd, "compass") === 0) Cmd_Compass_f(ent);
  else Cmd_Say_f(ent, false, true); // anything that doesn't match a command will be a chat
}
