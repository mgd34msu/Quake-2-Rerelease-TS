// Full port of lmctf60/p_hud.c (1584 lines).
//
// LM_CTF's own scoreboard/HUD system: a two-column red-vs-blue deathmatch
// scoreboard with an MVP/high-score block, an ADC squad board, the help
// computer, and the per-frame status-bar stat writers. Structurally it is a
// near-total rewrite of quake-2/ctf/p_hud.c, so src/ctf/p_hud.ts is used
// only as the house-style reference (cvarNum helper, Int16Array stats,
// layout-string budget, gi.WriteByte/WriteString/unicast), not as a source
// of behavior.
//
// Every function in the C file is ported: MoveClientToIntermission,
// BeginIntermission, Show_String, DeathmatchScoreboardMessage,
// DeathmatchScoreboard, SquadboardMessage, Squadboard,
// CTFSquadboardMessage, Cmd_Score_f, Cmd_Squadboard_f, HelpComputer,
// Cmd_Help_f, G_SetStats, G_CheckChaseStats, G_SetSpectatorStats.
//
// `#ifdef OLDOBSERVERCODE` blocks (the old single-list observer roster in
// DeathmatchScoreboardMessage and the camera_target stat mirror at the top
// of G_SetStats) are never defined by the lmctf60 Makefile and are dropped
// as dead branches, matching the rest of src/lmctf.
//
// DEVIATION -- `redscore`/`bluescore`: G_SetStats reads the two g_local.h
// globals that g_main.c's RunFrame recomputes from scratch every frame
// (g_main.c:774-795). g_main.ts does not maintain them and is outside this
// unit's SCOPE, so G_SetStats recomputes the identical sum inline, in the
// same client loop that already computes Red_Caps/Blue_Caps. The value is
// the same one RunFrame would have just written, except in the GamePaused()
// path where the C reads the previous frame's stale totals.

import { VectorCopy } from "../shared/math";
import {
  ATTN_NORM,
  CHAN_ITEM,
  Com_sprintf,
  CS_PLAYERSKINS,
  Info_ValueForKey,
  MAX_ITEMS,
  PmTypeT,
  Q_stricmp,
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
import { Highscore_Table, MAX_HIGHSCORE_ENTRIES, MvpDisp, SetMvpDisp } from "./bat";
import {
  blueflag,
  CENTER_HANDED,
  type EdictT,
  FL_POWER_ARMOR,
  game,
  gameCvars,
  g_edicts,
  gi,
  GREEN_STATUS_STR,
  IT_KEY,
  level,
  POWER_ARMOR_NONE,
  redflag,
  STAT_BLUE_CAPS,
  STAT_BLUE_FRAGS,
  STAT_BLUE_ICON,
  STAT_MATCH_TIME,
  STAT_RED_CAPS,
  STAT_RED_FRAGS,
  STAT_RED_ICON,
  STAT_RUNE_ICON,
  STAT_TEAM_ICON,
  svc_layout,
} from "./g_local";
import {
  ctf_faceEnemyFlag,
  ctf_faceNorth,
  ctf_facing,
  ctf_flagathome,
  CTF_TEAM_BLUE,
  CTF_TEAM_OBSERVER_BLUE,
  CTF_TEAM_OBSERVER_RED,
  CTF_TEAM_RED,
} from "./g_ctffunc";
import { ArmorIndex, FindItem, GetItemByIndex, ITEM_INDEX, itemlist, PowerArmorType } from "./g_items";
import { RUNE_DAMAGE, RUNE_HASTE, RUNE_REGEN, RUNE_RESIST, RUNE_VAMP } from "./g_runes";
import { Query_DMVP, Query_OMVP, Query_Railgun_Victor, Time_Left, Victory } from "./g_tourney";
import { stats_get, STATS_CAPTURES, STATS_SCORE } from "./p_stats";
import { G_Find } from "./g_utils";

// module-local mirror of every other unit's own cvarNum (see p_weapon.ts).
function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

// Com_sprintf has no `%ld` length modifier and no `%*s` star width, both of
// which p_hud.c uses. These two produce the same padding C's printf does for
// the handful of call sites that need them.
function padNumLeft(n: number, width: number): string {
  return String(Math.trunc(n)).padStart(width, " ");
}
function padStrRight(s: string, width: number): string {
  return s.padEnd(width, " ");
}

/*
=================
MoveClientToIntermission (lmctf60/p_hud.c:22)
=================
*/
export function MoveClientToIntermission(ent: EdictT): void {
  if (ent.client === null) return;
  const client = ent.client;

  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    client.showscores = true;
  }
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
  client.grenade_blew_up = false;
  client.grenade_time = 0;

  ent.viewheight = 0;
  ent.s.modelindex = 0;
  ent.s.modelindex2 = 0;
  ent.s.modelindex3 = 0;
  // C repeats `ent->s.modelindex = 0;` here (p_hud.c:49); a redundant
  // second write, preserved as a comment rather than a duplicated statement.
  ent.s.effects = 0;
  ent.s.sound = 0;
  ent.solid = SolidT.SOLID_NOT;

  // add the layout
  if (cvarNum(gameCvars.deathmatch) !== 0 || cvarNum(gameCvars.coop) !== 0) {
    DeathmatchScoreboardMessage(ent, null);
    gi.unicast(ent, true);
  }
}

/*
=================
BeginIntermission (lmctf60/p_hud.c:64)
=================
*/
export function BeginIntermission(targ: EdictT): void {
  if (level.intermissiontime !== 0) return; // already activated

  SetMvpDisp(1);

  // LM_JORM -- Proclaim a victory!
  Victory();
  // END LM_JORM

  game.autosaved = false;

  // The vanilla "respawn any dead clients" loop is commented out in
  // lmctf60/p_hud.c:81-90 ("bat / Too Many overflows!!!!!"), so it is not
  // ported either.

  level.intermissiontime = level.time;
  level.changemap = targ.map;

  if (level.changemap !== null && level.changemap.includes("*")) {
    if (cvarNum(gameCvars.coop) !== 0) {
      const maxclients = Math.floor(cvarNum(gameCvars.maxclients));
      for (let i = 0; i < maxclients; i++) {
        const client = g_edicts[1 + i];
        if (client === undefined || !client.inuse) continue;
        if (client.client === null) continue;
        // strip players of all keys between units
        const items = itemlist();
        for (let n = 0; n < MAX_ITEMS; n++) {
          const it = items[n];
          if (it !== undefined && (it.flags & IT_KEY) !== 0) {
            client.client.pers.inventory[n] = 0;
          }
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
    // choose one of four spots
    let i = Math.floor(Math.random() * 4) & 3;
    while (i-- > 0) {
      const next = G_Find(ent, "classname", "info_player_intermission");
      ent = next ?? G_Find(ent, "classname", "info_player_intermission");
    }
  }

  if (ent === null) {
    gi.dprintf("BeginIntermission: no intermission/start/deathmatch spot found\n");
    return;
  }

  VectorCopy(ent.s.origin, level.intermission_origin);
  VectorCopy(ent.s.angles, level.intermission_angle);

  // move all clients to the intermission point
  const maxclients = Math.floor(cvarNum(gameCvars.maxclients));
  for (let i = 0; i < maxclients; i++) {
    const client = g_edicts[1 + i];
    if (client === undefined || !client.inuse) continue;
    MoveClientToIntermission(client);
  }
}

/*
=================
Show_String (lmctf60/p_hud.c:160)

C signature is `Show_String(int x, int y, char *string, char *Text)`: it
formats into the file-global scratch buffer `DBuffer` (bat.c) and then
strcat()s that onto `string`, i.e. it APPENDS to the caller's buffer, it
does not replace it. Modelled here as "return the caller's buffer with the
new fragment appended", which callers assign back.

The trip through the shared `DBuffer` is not observable -- nothing else
reads DBuffer between the sprintf and the strcat -- so bat.ts's DBuffer is
left alone rather than written and immediately re-read.
=================
*/
export function Show_String(x: number, y: number, str: string, Text: string): string {
  return str + Com_sprintf('xv %i yv %i string2 "%s" ', x, y, Text);
}

/*
==================
DeathmatchScoreboardMessage (lmctf60/p_hud.c:176)

==================
*/
export function DeathmatchScoreboardMessage(ent: EdictT, killer: EdictT | null): void {
  let showsmall = false;

  let bluescore = 0;
  let bluecaps = 0;
  let blue = 0;
  let redscore = 0;
  let redcaps = 0;
  let red = 0;

  let redpings = 0;
  let bluepings = 0;

  const redsorted: number[] = [];
  const redsortedscores: number[] = [];
  const bluesorted: number[] = [];
  const bluesortedscores: number[] = [];

  const sorted_reg_observers: number[] = [];
  const sorted_red_observers: number[] = [];
  const sorted_blue_observers: number[] = [];

  //
  // This function really should be rewritten, but I probably
  // won't get around to it.
  // -bat
  //

  // sort the clients by score
  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    const cl = game.clients[i];

    // bat allow spectators to be on teams -- the vanilla
    // `|| game.clients[i].resp.spectator` half of this test is commented
    // out in the C.
    if (cl_ent === undefined || !cl_ent.inuse) continue;
    if (cl_ent.client === null || cl === undefined) continue;

    const score = stats_get(cl_ent, STATS_SCORE);

    if (cl_ent.client.ctf.teamnum === CTF_TEAM_RED) {
      // RED TEAM
      redscore += score;
      redcaps += stats_get(cl_ent, STATS_CAPTURES);
      redpings += cl.ping;

      let j = 0;
      for (; j < red; j++) {
        if (score > redsortedscores[j]) break;
      }
      redsorted.splice(j, 0, i);
      redsortedscores.splice(j, 0, score);
      red++;
    } else if (cl_ent.client.ctf.teamnum === CTF_TEAM_BLUE) {
      // BLUE TEAM
      bluescore += score;
      bluecaps += stats_get(cl_ent, STATS_CAPTURES);
      bluepings += cl.ping;

      let j = 0;
      for (; j < blue; j++) {
        if (score > bluesortedscores[j]) break;
      }
      bluesorted.splice(j, 0, i);
      bluesortedscores.splice(j, 0, score);
      blue++;
    } else if (cl_ent.client.ctf.teamnum === CTF_TEAM_OBSERVER_BLUE) {
      sorted_blue_observers.push(i);
    } else if (cl_ent.client.ctf.teamnum === CTF_TEAM_OBSERVER_RED) {
      sorted_red_observers.push(i);
    } else {
      sorted_reg_observers.push(i);
    }
  }

  const reg_observers = sorted_reg_observers.length;
  const red_observers = sorted_red_observers.length;
  const blue_observers = sorted_blue_observers.length;

  // print level name and exit rules
  let str = "";
  let stringlength = 0;

  // `string2` in the C is one scratch buffer reused by every branch below.
  // Some branches sprintf() into it (clobbering it) and others reach it via
  // Show_String (which strcat()s onto whatever is already there). That
  // difference is player-visible -- see the notes at the individual call
  // sites -- so the accumulate/clobber distinction is preserved exactly.
  let string2 = "";
  let mvpstring = "";
  let entry = "";
  let j = 0;
  let x = 0;
  let y = 0;

  // add the clients in sorted order
  if (red > 6) {
    showsmall = true;
    if (red > 21) red = 21;
  }

  if (blue > 6) {
    showsmall = true;
    if (blue > 21) blue = 21;
  }

  // NOTE: the averages divide by the CLAMPED team size (21), not the real
  // one, so on a 22+ player team the average ping reads high. Quirk of the
  // C, preserved.
  let Avg_Redpings: number;
  let Avg_Bluepings: number;
  if (red === 0) Avg_Redpings = 0;
  else Avg_Redpings = Math.trunc(redpings / red);

  if (blue === 0) Avg_Bluepings = 0;
  else Avg_Bluepings = Math.trunc(bluepings / blue);

  if (showsmall) {
    x = 0;
    y = 32;
    string2 =
      'xv 0 yv 32 string2 "Scr Png Name        " ' +
      'xv 0 yv 40 string2 "------------------- " ' +
      'xv 160 yv 32 string2 "Scr Png Name        " ' +
      'xv 160 yv 40 string2 "------------------- " ';

    j = string2.length;
    if (stringlength + j <= 1024) {
      str += string2;
      stringlength += j;
    }
  }

  for (let i = 0; i < red; i++) {
    const cl = game.clients[redsorted[i]];
    const cl_ent = g_edicts[1 + redsorted[i]];
    if (cl === undefined || cl_ent === undefined) continue;

    if (showsmall) {
      x = 0;
      y = 48 + 8 * i;

      // NOTE: the two MVP branches go through Show_String, which APPENDS to
      // `string2` -- and `string2` still holds the four-line column header
      // written just above (plus every earlier MVP row). So an MVP row
      // re-emits the whole accumulated buffer into the layout. That is what
      // the C does; not "fixed" here.
      if (cl_ent === Query_DMVP()) {
        mvpstring = `D${padNumLeft(cl.resp.score, 3)} ${padNumLeft(cl.ping, 3)} ${cl.pers.netname}`;
        mvpstring = mvpstring.slice(0, 19); // C: mvpstring[19] = 0
        string2 = Show_String(x, y, string2, mvpstring);
      } else if (cl_ent === Query_OMVP()) {
        mvpstring = `O${padNumLeft(cl.resp.score, 3)} ${padNumLeft(cl.ping, 3)} ${cl.pers.netname}`;
        mvpstring = mvpstring.slice(0, 19); // C: mvpstring[19] = 0
        string2 = Show_String(x, y, string2, mvpstring);
      } else {
        string2 = `ctf ${x} ${y} ${redsorted[i]} ${stats_get(cl_ent, STATS_SCORE)} ${cl.ping > 999 ? 999 : cl.ping} `;
      }

      j = string2.length;
      if (stringlength + j > 1024) break;
      str += string2;
      stringlength += j;
    } else {
      x = 0;
      y = 32 + 32 * (i % 6);

      // add a dogtag
      let tag: string | null = null;
      if (cl_ent === ent) tag = "tag1";
      else if (cl_ent === killer) tag = "tag2";
      if (tag !== null) {
        entry = Com_sprintf("xv %i yv %i picn %s ", x + 32, y, tag);
        j = entry.length;
        if (stringlength + j > 1024) break;
        str += entry;
        stringlength += j;
      }

      // send the layout
      entry = Com_sprintf(
        "client %i %i %i %i %i %i ",
        x,
        y,
        redsorted[i],
        stats_get(cl_ent, STATS_SCORE),
        cl.ping,
        Math.trunc((level.framenum - cl.resp.enterframe) / 600),
      );

      j = entry.length;
      if (stringlength + j > 1024) break;
      str += entry;
      stringlength += j;

      if (stats_get(cl_ent, STATS_CAPTURES) !== 0) {
        string2 = Com_sprintf(
          'xv %i yv %i string2 "C:%i" ', // teamname
          x + 32 + 80,
          y + 24,
          stats_get(cl_ent, STATS_CAPTURES),
        );

        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      }

      if (cl_ent === Query_DMVP()) {
        string2 = Com_sprintf("xv %d yv %d picn dmvpicon ", x, y);
        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      } else if (cl_ent === Query_OMVP()) {
        string2 = Com_sprintf("xv %d yv %d picn omvpicon ", x, y);
        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      }
    }
    // END PLAY -- LM JORM
  }

  for (let i = 0; i < blue; i++) {
    const cl = game.clients[bluesorted[i]];
    const cl_ent = g_edicts[1 + bluesorted[i]];
    if (cl === undefined || cl_ent === undefined) continue;

    if (showsmall) {
      x = 160;
      y = 48 + 8 * i;

      // Same accumulate-not-clobber quirk as the red column above.
      if (cl_ent === Query_DMVP()) {
        mvpstring = `D${padNumLeft(cl.resp.score, 3)} ${padNumLeft(cl.ping, 3)} ${cl.pers.netname}`;
        mvpstring = mvpstring.slice(0, 19); // C: mvpstring[19] = 0
        string2 = Show_String(x, y, string2, mvpstring);
      } else if (cl_ent === Query_OMVP()) {
        mvpstring = `O${padNumLeft(cl.resp.score, 3)} ${padNumLeft(cl.ping, 3)} ${cl.pers.netname}`;
        mvpstring = mvpstring.slice(0, 19); // C: mvpstring[19] = 0
        string2 = Show_String(x, y, string2, mvpstring);
      } else {
        string2 = `ctf ${x} ${y} ${bluesorted[i]} ${stats_get(cl_ent, STATS_SCORE)} ${cl.ping > 999 ? 999 : cl.ping} `;
      }

      j = string2.length;
      if (stringlength + j > 1024) break;
      str += string2;
      stringlength += j;
    } else {
      x = 160;
      y = 32 + 32 * (i % 6);

      // add a dogtag
      let tag: string | null = null;
      if (cl_ent === ent) tag = "tag1";
      else if (cl_ent === killer) tag = "tag2";
      if (tag !== null) {
        entry = Com_sprintf("xv %i yv %i picn %s ", x + 32, y, tag);
        j = entry.length;
        if (stringlength + j > 1024) break;
        str += entry;
        stringlength += j;
      }

      // send the layout
      entry = Com_sprintf(
        "client %i %i %i %i %i %i ",
        x,
        y,
        bluesorted[i],
        stats_get(cl_ent, STATS_SCORE),
        cl.ping,
        Math.trunc((level.framenum - cl.resp.enterframe) / 600),
      );

      j = entry.length;
      if (stringlength + j > 1024) break;
      str += entry;
      stringlength += j;

      if (stats_get(cl_ent, STATS_CAPTURES) !== 0) {
        string2 = Com_sprintf(
          'xv %i yv %i string2 "C:%i" ', // teamname
          x + 32 + 80,
          y + 24,
          stats_get(cl_ent, STATS_CAPTURES),
        );

        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      }
      if (cl_ent === Query_DMVP()) {
        string2 = Com_sprintf("xv %d yv %d picn dmvpicon ", x, y);
        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      } else if (cl_ent === Query_OMVP()) {
        string2 = Com_sprintf("xv %d yv %d picn omvpicon ", x, y);
        j = string2.length;
        if (stringlength + j > 1024) break;
        str += string2;
        stringlength += j;
      }
    }
    // END PLAY -- LM JORM
  }

  y = 32 * 8;
  string2 = "";

  if (MvpDisp !== 0) {
    mvpstring = `*** ${level.mapname} MVPs ***`;
    string2 = Show_String(80, y, string2, mvpstring);
    y += 8;

    const Railgun_Victor = Query_Railgun_Victor();
    if (Railgun_Victor !== null) {
      mvpstring = `Railgod -> ${Railgun_Victor.client === null ? "" : Railgun_Victor.client.pers.netname}`;
      string2 = Show_String(100, y, string2, mvpstring);
      y += 8;
    }

    mvpstring = `1) ${Highscore_Table[0].Player} ${padNumLeft(Highscore_Table[0].Score, 4)}`;
    string2 = Show_String(130, y, string2, mvpstring);
    y += 8;

    x = 0;

    for (let i = 1; i < MAX_HIGHSCORE_ENTRIES; i++) {
      if (i === 4) {
        x = 220;
        y = 272;
        if (Railgun_Victor !== null) y += 8;
      }

      // C: "%d) %15s %4ld" -- %15s is right-justified.
      mvpstring = `${i + 1}) ${Highscore_Table[i].Player.padStart(15, " ")} ${padNumLeft(Highscore_Table[i].Score, 4)}`;

      string2 = Show_String(x, y, string2, mvpstring);
      y += 8;
    }

    j = string2.length;
    if (stringlength + j <= 1024) {
      str += string2;
      stringlength += j;
    }
  } else {
    // NOTE: `string2` is reset to "" only once, above. Each of the three
    // observer blocks below appends to it and then copies the WHOLE buffer
    // into the layout, so a red-observer roster is re-emitted again by the
    // blue block, and both again by the regular-observer block. Quirk of
    // the C, preserved.
    if (red_observers !== 0) {
      x = 0;
      string2 = Show_String(x, y, string2, "Red Observers:");
      y += 8;

      for (let i = 0; i < red_observers; i++) {
        const cl = game.clients[sorted_red_observers[i]];
        // C also recomputes an unused `cl_ent` here; dead, omitted.
        if (cl === undefined) continue;
        string2 = Show_String(x, y, string2, cl.pers.netname);
        y += 8;
      }

      j = string2.length;
      if (stringlength + j <= 1024) {
        str += string2;
        stringlength += j;
      }
    }

    if (blue_observers !== 0) {
      x = 160;
      string2 = Show_String(x, y, string2, "Blue Observers:");
      y += 8;

      for (let i = 0; i < blue_observers; i++) {
        const cl = game.clients[sorted_blue_observers[i]];
        if (cl === undefined) continue;
        string2 = Show_String(x, y, string2, cl.pers.netname);
        y += 8;
      }

      j = string2.length;
      if (stringlength + j <= 1024) {
        str += string2;
        stringlength += j;
      }
    }

    if (reg_observers !== 0) {
      // give more space for the reg observers
      if (red_observers === 0 && blue_observers === 0) {
        x = 80;
        string2 = Show_String(x, y, string2, "Observers:");
        y += 8;

        // Do 2 obs per line (comment is the C's; the code below actually
        // lays out 3 per line).
        for (let i = 0; i < reg_observers; i++) {
          x = (i % 3) * 130;

          const cl = game.clients[sorted_reg_observers[i]];
          if (cl === undefined) continue;
          string2 = Show_String(x, y, string2, cl.pers.netname);

          if (i % 3 === 2) y += 8;
        }

        j = string2.length;
        if (stringlength + j <= 1024) {
          str += string2;
          stringlength += j;
        }
      } else {
        x = 80;
        string2 = Show_String(x, y, string2, "Observers:");
        y += 8;

        for (let i = 0; i < reg_observers; i++) {
          const cl = game.clients[sorted_reg_observers[i]];
          if (cl === undefined) continue;
          string2 = Show_String(x, y, string2, cl.pers.netname);
          y += 8;
        }

        j = string2.length;
        if (stringlength + j <= 1024) {
          str += string2;
          stringlength += j;
        }
      }
    }
  }

  // The `#ifdef OLDOBSERVERCODE` single-list observer roster that used to
  // live here is a dead branch (never defined by the Makefile); dropped.

  // END PLAY -- LM JORM

  // Don't show captures graphic if TEAMS and FLAGS turned off (DM MODE)
  // Show them - bat  (the ctfflags test is commented out in the C)
  {
    string2 = Com_sprintf(
      "xv %i yv %i picn %s " +
        "xv %i yv %i picn %s " +
        "xv %i yv %i picn %s " +
        "xv %i yv %i picn %s " +
        // Just caps - bat (the "P:%3i" player-count lines are commented out)
        'xv %i yv %i string2 "C:%3i" ' + // captures
        'xv %i yv %i string2 "AP:%3i" ' + // bat AVG PING
        'xv %i yv %i string2 "C:%3i" ' +
        'xv %i yv %i string2 "AP:%3i" ' +
        "xv %i yv %i num 4 19 " +
        "xv %i yv %i num 4 20 ",
      0,
      0,
      "redlion_i",
      160,
      0,
      "bluewolf_i",
      32,
      0,
      "redtag",
      192,
      0,
      "bluetag",
      36,
      4,
      redcaps,
      36,
      20,
      Avg_Redpings,
      196,
      4,
      bluecaps,
      196,
      20,
      Avg_Bluepings,
      90,
      4,
      250,
      4,
    );

    j = string2.length;
    // NOTE: this last budget test is `< 1024`, not the `<= 1024` used by
    // every other append above. Quirk of the C, preserved.
    if (stringlength + j < 1024) {
      str += string2;
      stringlength += j;
    }
  }

  // END PLAY -- LM JORM

  // NOTE: `redscore`/`bluescore` are accumulated by the sort loop above but
  // never rendered -- the C's layout shows captures and average pings only
  // (the "P:%3i" player-count lines are commented out). Dead in the C too;
  // the sums are kept so the loop matches line for line.
  void redscore;
  void bluescore;

  gi.WriteByte(svc_layout);
  gi.WriteString(str);
}

/*
==================
DeathmatchScoreboard (lmctf60/p_hud.c:880)

Draw instead of help message.
Note that it isn't that hard to overflow the 1400 byte message limit!
==================
*/
export function DeathmatchScoreboard(ent: EdictT): void {
  DeathmatchScoreboardMessage(ent, ent.enemy);
  gi.unicast(ent, true);
}

// ADC
/*
==================
SquadboardMessage (lmctf60/p_hud.c:893)

==================
*/
export function SquadboardMessage(ent: EdictT, killer: EdictT | null): void {
  CTFSquadboardMessage(ent, killer);
}
// ADC

// ADC
/*
==================
Squadboard (lmctf60/p_hud.c:908)

Draw instead of help message.
Note that it isn't that hard to overflow the 1400 byte message limit!
==================
*/
export function Squadboard(ent: EdictT): void {
  SquadboardMessage(ent, ent.enemy);
  gi.unicast(ent, true);
}
// ADC

/*
==================
CTFSquadboardMessage (lmctf60/p_hud.c:920)
==================
*/
export function CTFSquadboardMessage(ent: EdictT, killer: EdictT | null): void {
  // `killer` is a parameter of the C function too, and the C never reads it.
  void killer;

  if (ent.client === null) return;

  const maxsize = 1000;

  // The C's `gclient_t *clients[MAX_CLIENTS]` is a sparse array: entries are
  // NULLed out as they are consumed by the squad loop below, so a plain
  // (GClientT | null)[] models it exactly.
  const clients: Array<{ pers: { netname: string; squad: string; squadStatus: string } } | null> = [];
  let clientCount = 0;
  const sortedClients: Array<{ pers: { netname: string; squad: string; squadStatus: string } }> = [];

  let squad: string | null = null;
  let numCategoryLines = 0;

  const readyString = "string2"; // green string
  const notReadyString = "string"; // white string

  const greenStatusLen = GREEN_STATUS_STR.length;

  let widestName = 0; // in chars

  const teamOfInterest = ent.client.ctf.teamnum === CTF_TEAM_RED ? 0 : 1;

  for (let i = 0; i < game.maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || !cl_ent.inuse) continue;
    const gcl = game.clients[i];
    if (gcl === undefined) continue;

    let team: number;
    if (gcl.ctf.teamnum === CTF_TEAM_RED) team = 0;
    else if (gcl.ctf.teamnum === CTF_TEAM_BLUE) team = 1;
    else continue; // unknown team?

    if (team === teamOfInterest) {
      const len = gcl.pers.netname.length;
      clients[clientCount++] = gcl;

      if (len > widestName) widestName = len;
    }
  }

  // We want to put the predefined categories first
  // in the list, then any remaining ones.

  for (let i = 0, ready = 1; ready; i++) {
    // squad loop
    ready = 0;

    switch (i) {
      case 0:
        squad = "Offense";
        break;
      case 1:
        squad = "Middle";
        break;
      case 2:
        squad = "Defense";
        break;
      default:
        squad = null;
        break;
    }

    for (let jj = 0; jj < game.maxclients; jj++) {
      // client loop
      const c = clients[jj];
      if (c !== null && c !== undefined) {
        ready = 1;

        if (squad === null) squad = c.pers.squad;

        if (Q_stricmp(c.pers.squad, squad) === 0) {
          sortedClients.push(c);
          clients[jj] = null;
        }
      }
    }
  }

  const sortedCount = sortedClients.length;

  // print level name and exit rules
  // add the clients in sorted order
  let str = "";
  // NOTE: `len` starts at 0 even though `string` already holds the two
  // header fragments below, and is only refreshed after a successful
  // append -- so the first entry gets the full 1000-char budget. Quirk of
  // the C, preserved.
  let len = 0;

  if (teamOfInterest === 0) {
    // red
    str = "xv 0 yv 0 picn redlion_i xv 32 yv 0 picn redtag ";
  } else {
    // blue
    str = "xv 0 yv 0 picn bluewolf_i xv 32 yv 0 picn bluetag ";
  }

  str += 'xv 48 yv 10 string "Squad Board" ';

  squad = null;

  for (let i = 0; i < 16; i++) {
    if (i >= sortedCount) break; // we're done

    let entry = "";
    const sc = sortedClients[i];

    if (squad === null || Q_stricmp(squad, sc.pers.squad) !== 0) {
      squad = sc.pers.squad;

      entry += Com_sprintf('xv 0 yv %d string "%s" ', 42 + i * 8 + numCategoryLines * 8, sc.pers.squad);

      numCategoryLines++;
    }

    // If the status starts with "Ready", then it should be shown
    // in green.
    const statusStart = sc.pers.squadStatus.slice(0, greenStatusLen);

    const ready = Q_stricmp(statusStart, GREEN_STATUS_STR) === 0;

    // Note that the width %*s below is the widest chars
    // for a netname. We want the names padded with spaces
    // to make the status line up.
    entry += `xv 0 yv ${42 + i * 8 + numCategoryLines * 8} ${ready ? readyString : notReadyString} "   ${padStrRight(
      sc.pers.netname,
      widestName,
    )} ${sc.pers.squadStatus}" `;

    if (maxsize - len > entry.length) {
      str += entry;
      len = str.length;
    }
  }

  gi.WriteByte(svc_layout);
  gi.WriteString(str);
}

/*
==================
Cmd_Score_f (lmctf60/p_hud.c:1076)

Display the scoreboard
==================
*/
export function Cmd_Score_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.showinventory = false;
  client.showhelp = false;
  client.showctfhud = false;
  client.showmod = false;
  client.showmenu = false;
  client.showsquadboard = false; // ADC

  if (cvarNum(gameCvars.deathmatch) === 0 && cvarNum(gameCvars.coop) === 0) return;

  if (client.showscores) {
    client.showscores = false;
    return;
  }

  client.showscores = true;
  DeathmatchScoreboard(ent);
}

// ADC
/*
==================
Cmd_Squadboard_f (lmctf60/p_hud.c:1106)

Display the squadboard
==================
*/
export function Cmd_Squadboard_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.showhelp = false;
  client.showinventory = false;
  client.showctfhud = false;
  client.showmod = false;
  client.showmenu = false;
  client.showscores = false;

  if (cvarNum(gameCvars.deathmatch) === 0 && cvarNum(gameCvars.coop) === 0) return;

  if (client.showsquadboard) {
    client.showsquadboard = false;
    return;
  }

  client.showsquadboard = true;
  Squadboard(ent);
}
// ADC

/*
==================
HelpComputer (lmctf60/p_hud.c:1136)

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
    "xv 32 yv 8 picn help " + // background
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
Cmd_Help_f (lmctf60/p_hud.c:1180)

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
  client.showctfhud = false;
  client.showmod = false;
  client.showmenu = false;
  client.showsquadboard = false; // ADC

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
G_SetStats (lmctf60/p_hud.c:1215)
===============
*/
export function G_SetStats(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  // The `#ifdef OLDOBSERVERCODE` camera_target stat mirror that guarded the
  // whole body below is a dead branch (never defined by the Makefile);
  // dropped, so the body always runs.
  {
    // NOTE: Red_Caps/Blue_Caps are plain (non-static) C function locals
    // initialized in their declaration, so they really do restart at 0 on
    // every call -- the totals below are a fresh per-call sum, not an
    // accumulation.
    let Red_Caps = 0;
    let Blue_Caps = 0;

    // See the file header's redscore/bluescore deviation note: these are
    // g_local.h globals in the C, recomputed by g_main.c's RunFrame with
    // exactly this loop. Summed here instead.
    let redscore = 0;
    let bluescore = 0;

    // bat - This should be global. :/
    for (let i = 0; i < game.maxclients; i++) {
      const cl_ent = g_edicts[1 + i];
      if (cl_ent === undefined || !cl_ent.inuse) continue;
      if (cl_ent.client === null) continue;

      const score = stats_get(cl_ent, STATS_SCORE);

      if (cl_ent.client.ctf.teamnum === CTF_TEAM_RED) {
        Red_Caps += stats_get(cl_ent, STATS_CAPTURES);
        redscore += score;
      } else if (cl_ent.client.ctf.teamnum === CTF_TEAM_BLUE) {
        Blue_Caps += stats_get(cl_ent, STATS_CAPTURES);
        bluescore += score;
      }
    }

    client.ps.stats[STAT_RED_FRAGS] = redscore;
    client.ps.stats[STAT_BLUE_FRAGS] = bluescore;

    client.ps.stats[STAT_RED_CAPS] = Red_Caps;
    client.ps.stats[STAT_BLUE_CAPS] = Blue_Caps;
    client.ps.stats[STAT_MATCH_TIME] = Time_Left;

    // decide gender -- the C's female/male portrait switch is commented out
    // and replaced by the skin-path parse below.
    let s = Info_ValueForKey(client.pers.userinfo, "skin");
    let portrait: string;
    const slash = s.indexOf("/"); // C: strchr(s, '/')
    if (slash !== -1) {
      s = s.slice(slash + 1); // C: s++ past the '/'
      portrait = `${s}_i`;
    } else {
      portrait = "redlion_i";
    }

    switch (client.ctf.compass) {
      case 1:
        client.ps.stats[STAT_TEAM_ICON] = gi.imageindex(ctf_facing(ent));
        break;
      case 2:
        client.ps.stats[STAT_TEAM_ICON] = gi.imageindex(ctf_faceNorth(ent));
        break;
      case 3:
        client.ps.stats[STAT_TEAM_ICON] = gi.imageindex(ctf_faceEnemyFlag(ent));
        break;
      default:
        // C: `default:` falls straight through into `case 0:`
        if (redflag !== null && redflag.owner === ent) {
          client.ps.stats[STAT_TEAM_ICON] = gi.imageindex("redflaggone");
        } else if (blueflag !== null && blueflag.owner === ent) {
          client.ps.stats[STAT_TEAM_ICON] = gi.imageindex("blueflaggone");
        } else {
          client.ps.stats[STAT_TEAM_ICON] = gi.imageindex(portrait);
        }
        break;
    }

    // Show status of the red flag
    if (redflag !== null) {
      if (redflag.owner !== null) client.ps.stats[STAT_RED_ICON] = gi.imageindex("redflaggone");
      else if (!ctf_flagathome(redflag)) client.ps.stats[STAT_RED_ICON] = gi.imageindex("redflagdown");
      else client.ps.stats[STAT_RED_ICON] = gi.imageindex("redlion_i");
    }

    if (blueflag !== null) {
      if (blueflag.owner !== null) client.ps.stats[STAT_BLUE_ICON] = gi.imageindex("blueflaggone");
      else if (!ctf_flagathome(blueflag)) client.ps.stats[STAT_BLUE_ICON] = gi.imageindex("blueflagdown");
      else client.ps.stats[STAT_BLUE_ICON] = gi.imageindex("bluewolf_i");
    }

    if (client.rune !== null) {
      // C uses four independent `if`s, not else-if; preserved.
      if (client.rune.runetype === RUNE_DAMAGE) client.ps.stats[STAT_RUNE_ICON] = gi.imageindex("strength");
      if (client.rune.runetype === RUNE_RESIST) client.ps.stats[STAT_RUNE_ICON] = gi.imageindex("resist");
      if (client.rune.runetype === RUNE_HASTE) client.ps.stats[STAT_RUNE_ICON] = gi.imageindex("haste");
      if (client.rune.runetype === RUNE_REGEN) client.ps.stats[STAT_RUNE_ICON] = gi.imageindex("regen");
      if (client.rune.runetype === RUNE_VAMP) client.ps.stats[STAT_RUNE_ICON] = gi.imageindex("k_redkey"); // added by Vampire
    } else {
      client.ps.stats[STAT_RUNE_ICON] = 0;
    }

    // END CTF CODE -- LM_JORM

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
      const item = itemlist()[client.ammo_index];
      client.ps.stats[STAT_AMMO_ICON] = item === undefined ? 0 : gi.imageindex(item.icon ?? "");
      client.ps.stats[STAT_AMMO] = client.pers.inventory[client.ammo_index];
    }

    //
    // armor
    //
    let power_armor_type = PowerArmorType(ent);
    let cells = 0;
    if (power_armor_type !== POWER_ARMOR_NONE) {
      const cellsItem = FindItem("cells");
      cells = cellsItem === null ? 0 : client.pers.inventory[ITEM_INDEX(cellsItem)];
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
      client.ps.stats[STAT_ARMOR_ICON] = item === null ? 0 : gi.imageindex(item.icon ?? "");
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
    if (client.quad_framenum > level.framenum) {
      client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_quad");
      client.ps.stats[STAT_TIMER] = Math.trunc((client.quad_framenum - level.framenum) / 10);
    } else if (client.invincible_framenum > level.framenum) {
      client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_invulnerability");
      client.ps.stats[STAT_TIMER] = Math.trunc((client.invincible_framenum - level.framenum) / 10);
    } else if (client.enviro_framenum > level.framenum) {
      client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_envirosuit");
      client.ps.stats[STAT_TIMER] = Math.trunc((client.enviro_framenum - level.framenum) / 10);
    } else if (client.breather_framenum > level.framenum) {
      client.ps.stats[STAT_TIMER_ICON] = gi.imageindex("p_rebreather");
      client.ps.stats[STAT_TIMER] = Math.trunc((client.breather_framenum - level.framenum) / 10);
    } else {
      client.ps.stats[STAT_TIMER_ICON] = 0;
      client.ps.stats[STAT_TIMER] = 0;
    }

    //
    // selected item
    //

    // Show proper flag item
    if (client.pers.selected_item === -1) {
      client.ps.stats[STAT_SELECTED_ICON] = 0;
    } else {
      const items = itemlist();
      const sel = items[client.pers.selected_item];
      if (blueflag !== null && sel !== undefined && blueflag.item === sel) {
        client.ps.stats[STAT_SELECTED_ICON] = gi.imageindex("a_blueflag");
      } else if (redflag !== null && sel !== undefined && redflag.item === sel) {
        client.ps.stats[STAT_SELECTED_ICON] = gi.imageindex("a_redflag");
      } else {
        client.ps.stats[STAT_SELECTED_ICON] = sel === undefined ? 0 : gi.imageindex(sel.icon ?? "");
      }
    }

    client.ps.stats[STAT_SELECTED_ITEM] = client.pers.selected_item;

    //
    // frags
    //
    client.ps.stats[STAT_FRAGS] = stats_get(ent, STATS_SCORE);

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
  }

  //
  // layouts
  //
  client.ps.stats[STAT_LAYOUTS] = 0;

  if (cvarNum(gameCvars.deathmatch) !== 0) {
    if (
      client.pers.health <= 0 ||
      level.intermissiontime !== 0 ||
      client.showscores ||
      client.showctfhud ||
      client.showmod ||
      client.showmenu ||
      client.showsquadboard // ADC
    ) {
      client.ps.stats[STAT_LAYOUTS] |= 1;
    }
    if (client.showinventory && client.pers.health > 0) client.ps.stats[STAT_LAYOUTS] |= 2;
  } else {
    if (
      client.showscores ||
      client.showhelp ||
      client.showctfhud ||
      client.showmod ||
      client.showsquadboard // ADC
    ) {
      client.ps.stats[STAT_LAYOUTS] |= 1;
    }
    if (client.showinventory && client.pers.health > 0) client.ps.stats[STAT_LAYOUTS] |= 2;
  }

  // LM_JORM -- the "turn CTF HUD back on automatically" block is commented
  // out in the C; not ported.

  client.ps.stats[STAT_SPECTATOR] = 0;
}

/*
===============
G_CheckChaseStats (lmctf60/p_hud.c:1538)
===============
*/
export function G_CheckChaseStats(ent: EdictT): void {
  const entClient = ent.client;
  if (entClient === null) return;

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    if (e === undefined) continue;
    const cl = e.client;
    if (!e.inuse || cl === null || cl.chase_target !== ent) continue;
    cl.ps.stats.set(entClient.ps.stats);
    G_SetSpectatorStats(e);
  }
}

/*
===============
G_SetSpectatorStats (lmctf60/p_hud.c:1557)
===============
*/
export function G_SetSpectatorStats(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  if (cl.chase_target === null) G_SetStats(ent);

  cl.ps.stats[STAT_SPECTATOR] = 1;

  // layouts are independant in spectator
  cl.ps.stats[STAT_LAYOUTS] = 0;

  // bat - I think that cl->pers.health is only supposed to be checked in
  // deathmatch, so the vanilla `cl->pers.health <= 0 ||` term is dropped
  // from this test in lmctf60.
  if (level.intermissiontime !== 0 || cl.showscores || cl.showmenu) cl.ps.stats[STAT_LAYOUTS] |= 1;
  if (cl.showinventory && cl.pers.health > 0) cl.ps.stats[STAT_LAYOUTS] |= 2;

  if (cl.chase_target !== null && cl.chase_target.inuse) {
    // C: `CS_PLAYERSKINS + (cl->chase_target - g_edicts) - 1` -- pointer
    // arithmetic for the target's edict index. s.number IS that index (it is
    // assigned from it at edict-array setup), so it is used directly rather
    // than an O(n) identity scan of g_edicts.
    cl.ps.stats[STAT_CHASE] = CS_PLAYERSKINS + cl.chase_target.s.number - 1;
  } else {
    cl.ps.stats[STAT_CHASE] = 0;
  }
}
