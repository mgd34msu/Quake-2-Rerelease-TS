// Ports a SUBSET of lmctf60/p_hud.c (41023 bytes total; diff vs
// quake-2/ctf/p_hud.c is 1668 lines of 1584 -- almost a full rewrite, LM_CTF's
// own scoreboard/HUD system).
//
// STATUS: only MoveClientToIntermission and BeginIntermission are ported --
// the two functions g_target.ts's use_target_changelevel and p_client.ts's
// ClientBegin/ClientBeginDeathmatch need to reach the intermission state
// this unit's SCOPE requires reaching. Every other p_hud.c function
// (DeathmatchScoreboardMessage and its ~30 helper layout functions,
// Cmd_Help_f, the CTF-specific HUD stat-string builders, G_SetStats,
// P_DamageFeedback/SV_CalcBlend/etc) is NOT ported -- this is a
// deliberately partial file.
//
// NOT PORTED at MoveClientToIntermission's call site: DeathmatchScoreboardMessage
// (the ~30-function scoreboard layout builder) -- skipped with a citation,
// the state transition (origin/pmove/viewangles reset, powerup clear) is
// otherwise complete.
//
// NOT PORTED at BeginIntermission's call site: Victory() (g_tourney.c's
// match-end announcement -- g_tourney.ts's own file header already
// documents Match_End/Victory as NOT ported by this unit) -- skipped with
// a citation; the actual intermission state transition (finding an
// info_player_intermission spot, moving every client there) is otherwise
// complete.

import { vec3, VectorCopy } from "../shared/math";
import { MAX_ITEMS, PmTypeT, RDF_UNDERWATER } from "../shared/q_shared";
import { type EdictT, g_edicts, game, gameCvars, gi, IT_KEY, level } from "./g_local";
import { G_Find } from "./g_utils";
import { itemlist } from "./g_items";

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
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
  ent.s.effects = 0;
  ent.s.sound = 0;
  ent.solid = 0; // SolidT.SOLID_NOT

  // DeathmatchScoreboardMessage(ent, null) + gi.unicast(ent, true) -- not
  // ported, see file header. The layout stat_string this would populate
  // simply stays whatever it last was; no crash, just a stale scoreboard.
}

/*
=================
BeginIntermission (lmctf60/p_hud.c:64)
=================
*/
export function BeginIntermission(targ: EdictT): void {
  if (level.intermissiontime !== 0) return; // already activated

  // Victory() -- g_tourney.c's match-end announcement, not ported (see
  // g_tourney.ts's own file header). Skipped with citation.

  game.autosaved = false;

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
