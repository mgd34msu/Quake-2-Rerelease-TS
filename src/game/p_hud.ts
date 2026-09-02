// p_hud.c
//
// g_local.h attributes `BeginIntermission` to the file it calls
// "g_client.c" (which does not exist); grepping the C tree shows it is
// actually defined in p_hud.c, alongside the rest of this file's exports.
//
// `ValidateSelectedItem` (declared in the same g_local.h prototype block as
// several functions here) is NOT part of this file: grepping the C tree
// shows it is defined in g_cmds.c, and it is already ported (real, not a
// stub) at src/game/g_cmds.ts's `ValidateSelectedItem` export. Nothing here
// needs it.
//
// `Cmd_Score_f`/`Cmd_Help_f` are declared in g_local.h and called from
// g_cmds.c's ClientCommand, but defined here in p_hud.c. g_cmds.ts
// carried local pending stubs of the same two names at the time, with a
// comment flagging this exact follow-up (import from p_hud.ts once it
// lands); g_cmds.ts is outside this unit's SCOPE, so that swap is reported
// as a follow-up rather than made here.

import { VectorCopy } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_ITEM,
  Com_sprintf,
  CS_PLAYERSKINS,
  type CvarT,
  PmTypeT,
  RDF_IRGOGGLES,
  RDF_UNDERWATER,
  STAT_AMMO,
  STAT_AMMO_ICON,
  STAT_ARMOR,
  STAT_ARMOR_ICON,
  STAT_CHASE,
  STAT_FRAGS,
  STAT_HEALTH,
  STAT_HEALTH_ICON,
  STAT_HELPICON,
  STAT_LAYOUTS,
  STAT_PICKUP_ICON,
  STAT_PICKUP_STRING,
  STAT_SELECTED_ICON,
  STAT_SELECTED_ITEM,
  STAT_SPECTATOR,
  STAT_TIMER,
  STAT_TIMER_ICON,
} from "../shared/q_shared";
import { SolidT } from "./game";
import {
  CENTER_HANDED,
  type EdictT,
  FL_POWER_ARMOR,
  gameCvars,
  game,
  g_edicts,
  gi,
  IT_KEY,
  level,
  POWER_ARMOR_NONE,
  svc_layout,
} from "./g_local";
import { ArmorIndex, FindItem, GetItemByIndex, ITEM_INDEX, itemlist, PowerArmorType } from "./g_items";
import { G_Find } from "./g_utils";
import { respawn } from "./p_client";

// a per-file local mirrors other units' own cvarNum (module-local
// everywhere in this codebase, not a shared export) per the established
// house style (see p_weapon.ts).
function cvarNum(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

/*
======================================================================

INTERMISSION

======================================================================
*/

export function MoveClientToIntermission(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) client.showscores = true;
  VectorCopy(level.intermission_origin, ent.s.origin);
  client.ps.pmove.origin[0] = level.intermission_origin[0] * 8;
  client.ps.pmove.origin[1] = level.intermission_origin[1] * 8;
  client.ps.pmove.origin[2] = level.intermission_origin[2] * 8;
  VectorCopy(level.intermission_angle, client.ps.viewangles);
  client.ps.pmove.pm_type = PmTypeT.PM_FREEZE;
  client.ps.gunindex = 0;
  client.ps.blend[3] = 0;
  client.ps.rdflags &= ~RDF_UNDERWATER;

  // clean up powerup info
  client.quad_framenum = 0;
  client.invincible_framenum = 0;
  client.breather_framenum = 0;
  client.enviro_framenum = 0;
  // RERELEASE CONTENT PORT -- ROGUE (rogue/p_hud.c)
  client.ps.rdflags &= ~RDF_IRGOGGLES;
  client.ir_framenum = 0;
  client.nuke_framenum = 0;
  client.double_framenum = 0;
  // RERELEASE CONTENT PORT -- RAFAEL (xatrix/p_hud.c)
  client.quadfire_framenum = 0;
  client.trap_blew_up = false;
  client.trap_time = 0;
  client.grenade_blew_up = false;
  client.grenade_time = 0;

  ent.viewheight = 0;
  ent.s.modelindex = 0;
  ent.s.modelindex2 = 0;
  ent.s.modelindex3 = 0;
  ent.s.modelindex = 0;
  ent.s.effects = 0;
  ent.s.sound = 0;
  ent.solid = SolidT.SOLID_NOT;

  // add the layout
  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    DeathmatchScoreboardMessage(ent, null);
    gi.unicast(ent, true);
  }
}

export function BeginIntermission(targ: EdictT): void {
  if (level.intermissiontime !== 0) return; // already activated

  game.autosaved = false;

  const maxclients = cvarNum(gameCvars.maxclients);

  // respawn any dead clients
  for (let i = 0; i < maxclients; i++) {
    const client = g_edicts[1 + i];
    if (!client.inuse) continue;
    if (client.health <= 0) respawn(client);
  }

  level.intermissiontime = level.time;
  level.changemap = targ.map;

  if (level.changemap !== null && level.changemap.includes("*")) {
    if (cvarNum(gameCvars.coop) !== 0) {
      for (let i = 0; i < maxclients; i++) {
        const client = g_edicts[1 + i];
        if (!client.inuse) continue;
        // strip players of all keys between units
        const items = itemlist();
        for (let n = 0; n < items.length; n++) {
          if (client.client !== null && (items[n].flags & IT_KEY) !== 0) client.client.pers.inventory[n] = 0;
        }
      }
    }
  } else {
    if (cvarNum(gameCvars.deathmatch) === 0) {
      level.exitintermission = 1; // go immediately to the next level
      return;
    }
  }

  level.exitintermission = 0;

  // find an intermission spot
  let ent = G_Find(null, "classname", "info_player_intermission");
  if (ent === null) {
    // the map creator forgot to put in an intermission point...
    ent = G_Find(null, "classname", "info_player_start");
    if (ent === null) ent = G_Find(null, "classname", "info_player_deathmatch");
  } else {
    // chose one of four spots
    // C: `rand() & 3` -- see g_misc.ts's established house style for raw rand().
    let i = Math.floor(Math.random() * 4) & 3;
    while (i--) {
      ent = G_Find(ent, "classname", "info_player_intermission");
      if (ent === null) ent = G_Find(ent, "classname", "info_player_intermission"); // wrap around the list
    }
  }

  if (ent === null) gi.error("BeginIntermission: no intermission/start/deathmatch spot found");

  VectorCopy(ent.s.origin, level.intermission_origin);
  VectorCopy(ent.s.angles, level.intermission_angle);

  // move all clients to the intermission point
  for (let i = 0; i < maxclients; i++) {
    const client = g_edicts[1 + i];
    if (!client.inuse) continue;
    MoveClientToIntermission(client);
  }
}

/*
==================
DeathmatchScoreboardMessage

==================
*/
export function DeathmatchScoreboardMessage(ent: EdictT, killer: EdictT | null): void {
  // sort the clients by score
  const sorted: number[] = [];
  const sortedscores: number[] = [];

  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (!cl_ent.inuse || game.clients[i].resp.spectator) continue;
    const score = game.clients[i].resp.score;
    let j = sortedscores.findIndex((s) => score > s);
    if (j === -1) j = sortedscores.length;
    sorted.splice(j, 0, i);
    sortedscores.splice(j, 0, score);
  }

  // print level name and exit rules
  let str = "";

  // add the clients in sorted order
  const total = Math.min(sorted.length, 12);

  for (let i = 0; i < total; i++) {
    const cl = game.clients[sorted[i]];
    const cl_ent = g_edicts[1 + sorted[i]];

    gi.imageindex("i_fixme"); // picnum -- computed but unused in the layout string, matching the C source
    const x = i >= 6 ? 160 : 0;
    const y = 32 + 32 * (i % 6);

    // add a dogtag
    let tag: string | null = null;
    if (cl_ent === ent) tag = "tag1";
    else if (cl_ent === killer) tag = "tag2";
    if (tag !== null) {
      const tagEntry = Com_sprintf("xv %i yv %i picn %s ", x + 32, y, tag);
      if (str.length + tagEntry.length > 1024) break;
      str += tagEntry;
    }

    // send the layout
    const entry = Com_sprintf(
      "client %i %i %i %i %i %i ",
      x,
      y,
      sorted[i],
      cl.resp.score,
      cl.ping,
      ((level.framenum - cl.resp.enterframe) / 600) | 0,
    );
    if (str.length + entry.length > 1024) break;
    str += entry;
  }

  gi.WriteByte(svc_layout);
  gi.WriteString(str);
}

/*
==================
DeathmatchScoreboard

Draw instead of help message.
Note that it isn't that hard to overflow the 1400 byte message limit!
==================
*/
export function DeathmatchScoreboard(ent: EdictT): void {
  DeathmatchScoreboardMessage(ent, ent.enemy);
  gi.unicast(ent, true);
}

/*
==================
Cmd_Score_f

Display the scoreboard
==================
*/
export function Cmd_Score_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.showinventory = false;
  client.showhelp = false;

  if (cvarNum(gameCvars.deathmatch) === 0 && cvarNum(gameCvars.coop) === 0) return;

  if (client.showscores) {
    client.showscores = false;
    return;
  }

  client.showscores = true;
  DeathmatchScoreboard(ent);
}

/*
==================
HelpComputer

Draw help computer.
==================
*/
export function HelpComputer(ent: EdictT): void {
  const skillValue = cvarNum(gameCvars.skill);
  let sk: string;
  if (skillValue === 0) sk = "easy";
  else if (skillValue === 1) sk = "medium";
  else if (skillValue === 2) sk = "hard";
  else sk = "hard+";

  // send the layout
  const str = Com_sprintf(
    'xv 32 yv 8 picn help ' + // background
      'xv 202 yv 12 string2 "%s" ' + // skill
      'xv 0 yv 24 cstring2 "%s" ' + // level name
      'xv 0 yv 54 cstring2 "%s" ' + // help 1
      'xv 0 yv 110 cstring2 "%s" ' + // help 2
      'xv 50 yv 164 string2 " kills     goals    secrets" ' +
      'xv 50 yv 172 string2 "%3i/%3i     %i/%i       %i/%i" ',
    sk,
    level.level_name,
    game.helpmessage1,
    game.helpmessage2,
    level.killed_monsters,
    level.total_monsters,
    level.found_goals,
    level.total_goals,
    level.found_secrets,
    level.total_secrets,
  );

  gi.WriteByte(svc_layout);
  gi.WriteString(str);
  gi.unicast(ent, true);
}

/*
==================
Cmd_Help_f

Display the current help message
==================
*/
export function Cmd_Help_f(ent: EdictT): void {
  // this is for backwards compatability
  if (cvarNum(gameCvars.deathmatch) !== 0) {
    Cmd_Score_f(ent);
    return;
  }

  const client = ent.client;
  if (client === null) return;

  client.showinventory = false;
  client.showscores = false;

  if (client.showhelp && client.pers.game_helpchanged === game.helpchanged) {
    client.showhelp = false;
    return;
  }

  client.showhelp = true;
  client.pers.helpchanged = 0;
  HelpComputer(ent);
}

//=======================================================================

/*
===============
G_SetStats
===============
*/
export function G_SetStats(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  //
  // health
  //
  client.ps.stats[STAT_HEALTH_ICON] = level.pic_health;
  client.ps.stats[STAT_HEALTH] = ent.health;

  //
  // ammo
  //
  if (client.ammo_index === 0 /* || !ent->client->pers.inventory[ent->client->ammo_index] */) {
    client.ps.stats[STAT_AMMO_ICON] = 0;
    client.ps.stats[STAT_AMMO] = 0;
  } else {
    const item = GetItemByIndex(client.ammo_index);
    client.ps.stats[STAT_AMMO_ICON] = item !== null ? gi.imageindex(item.icon ?? "") : 0;
    client.ps.stats[STAT_AMMO] = client.pers.inventory[client.ammo_index];
  }

  //
  // armor
  //
  let power_armor_type = PowerArmorType(ent);
  let cells = 0;
  if (power_armor_type !== POWER_ARMOR_NONE) {
    const cellsItem = FindItem("cells");
    cells = cellsItem !== null ? client.pers.inventory[ITEM_INDEX(cellsItem)] : 0;
    if (cells === 0) {
      // ran out of cells for power armor
      ent.flags &= ~FL_POWER_ARMOR;
      gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/power2.wav"), 1, ATTN_NORM, 0);
      power_armor_type = POWER_ARMOR_NONE;
    }
  }

  const index = ArmorIndex(ent);
  if (power_armor_type !== POWER_ARMOR_NONE && (index === 0 || (level.framenum & 8) !== 0)) {
    // flash between power armor and other armor icon
    client.ps.stats[STAT_ARMOR_ICON] = gi.imageindex("i_powershield");
    client.ps.stats[STAT_ARMOR] = cells;
  } else if (index !== 0) {
    const item = GetItemByIndex(index);
    client.ps.stats[STAT_ARMOR_ICON] = item !== null ? gi.imageindex(item.icon ?? "") : 0;
    client.ps.stats[STAT_ARMOR] = client.pers.inventory[index];
  } else {
    client.ps.stats[STAT_ARMOR_ICON] = 0;
    client.ps.stats[STAT_ARMOR] = 0;
  }

  //
  // pickup message
  //
  if (level.time > client.pickup_msg_time) {
    client.ps.stats[STAT_PICKUP_ICON] = 0;
    client.ps.stats[STAT_PICKUP_STRING] = 0;
  }

  //
  // timers
  //
  // RERELEASE CONTENT PORT -- the mission-pack powerup timers slot into this
  // chain in each pack's own position: rogue puts Double Damage right after
  // quad and the sphere/IR pair right after breather (rogue/p_hud.c), xatrix
  // puts DualFire right after quad (xatrix/p_hud.c). The chain is
  // `else if`, so only ONE icon is ever shown -- with several powerups
  // running at once the later tiers are invisible. That is exactly how each
  // pack behaves on its own; it is not a merge artefact.
  if (client.quad_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_quad");
    client.ps.stats[STAT_TIMER] = ((client.quad_framenum - level.framenum) / 10) | 0;
    // ROGUE
  } else if (client.double_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_double");
    client.ps.stats[STAT_TIMER] = ((client.double_framenum - level.framenum) / 10) | 0;
    // ROGUE
    // RAFAEL
  } else if (client.quadfire_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_quadfire");
    client.ps.stats[STAT_TIMER] = ((client.quadfire_framenum - level.framenum) / 10) | 0;
    // RAFAEL
  } else if (client.invincible_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_invulnerability");
    client.ps.stats[STAT_TIMER] = ((client.invincible_framenum - level.framenum) / 10) | 0;
  } else if (client.enviro_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_envirosuit");
    client.ps.stats[STAT_TIMER] = ((client.enviro_framenum - level.framenum) / 10) | 0;
  } else if (client.breather_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_rebreather");
    client.ps.stats[STAT_TIMER] = ((client.breather_framenum - level.framenum) / 10) | 0;
    // ROGUE
  } else if (client.owned_sphere !== null) {
    if (client.owned_sphere.spawnflags === 1) client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_defender");
    else if (client.owned_sphere.spawnflags === 2) client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_hunter");
    else if (client.owned_sphere.spawnflags === 4) client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_vengeance");
    else client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("i_fixme"); // error case

    client.ps.stats[STAT_TIMER] = (client.owned_sphere.wait - level.time) | 0;
  } else if (client.ir_framenum > level.framenum) {
    client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_ir");
    client.ps.stats[STAT_TIMER] = ((client.ir_framenum - level.framenum) / 10) | 0;
    // ROGUE
  } else {
    client.ps.stats[STAT_TIMER_ICON] = 0;
    client.ps.stats[STAT_TIMER] = 0;
  }

  //
  // selected item
  //
  if (client.pers.selected_item === -1) {
    client.ps.stats[STAT_SELECTED_ICON] = 0;
  } else {
    const items = itemlist();
    client.ps.stats[STAT_SELECTED_ICON] = gi.imageindex(items[client.pers.selected_item].icon ?? "");
  }

  client.ps.stats[STAT_SELECTED_ITEM] = client.pers.selected_item;

  //
  // layouts
  //
  client.ps.stats[STAT_LAYOUTS] = 0;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if (client.pers.health <= 0 || level.intermissiontime !== 0 || client.showscores) client.ps.stats[STAT_LAYOUTS] |= 1;
    if (client.showinventory && client.pers.health > 0) client.ps.stats[STAT_LAYOUTS] |= 2;
  } else {
    if (client.showscores || client.showhelp) client.ps.stats[STAT_LAYOUTS] |= 1;
    if (client.showinventory && client.pers.health > 0) client.ps.stats[STAT_LAYOUTS] |= 2;
  }

  //
  // frags
  //
  client.ps.stats[STAT_FRAGS] = client.resp.score;

  //
  // help icon / current weapon if not shown
  //
  if (client.pers.helpchanged !== 0 && (level.framenum & 8) !== 0) {
    client.ps.stats[STAT_HELPICON] = gi.imageindex("i_help");
  } else if ((client.pers.hand === CENTER_HANDED || client.ps.fov > 91) && client.pers.weapon !== null) {
    client.ps.stats[STAT_HELPICON] = gi.imageindex(client.pers.weapon.icon ?? "");
  } else {
    client.ps.stats[STAT_HELPICON] = 0;
  }

  client.ps.stats[STAT_SPECTATOR] = 0;
}

/*
===============
G_CheckChaseStats
===============
*/
export function G_CheckChaseStats(ent: EdictT): void {
  const entClient = ent.client;
  if (entClient === null) return;

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    const cl = e.client;
    if (!e.inuse || cl === null || cl.chase_target !== ent) continue;
    cl.ps.stats.set(entClient.ps.stats);
    G_SetSpectatorStats(e);
  }
}

/*
===============
G_SetSpectatorStats
===============
*/
export function G_SetSpectatorStats(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.chase_target === null) G_SetStats(ent);

  cl.ps.stats[STAT_SPECTATOR] = 1;

  // layouts are independant in spectator
  cl.ps.stats[STAT_LAYOUTS] = 0;
  if (cl.pers.health <= 0 || level.intermissiontime !== 0 || cl.showscores) cl.ps.stats[STAT_LAYOUTS] |= 1;
  if (cl.showinventory && cl.pers.health > 0) cl.ps.stats[STAT_LAYOUTS] |= 2;

  if (cl.chase_target !== null && cl.chase_target.inuse) cl.ps.stats[STAT_CHASE] = CS_PLAYERSKINS + (cl.chase_target.s.number - 1);
  else cl.ps.stats[STAT_CHASE] = 0;
}
