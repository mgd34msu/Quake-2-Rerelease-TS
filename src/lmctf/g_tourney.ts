// Ports lmctf60/g_tourney.c -- LM_CTF's match/tournament state machine (483
// lines; wholly new, no CTF-mod ancestor).
//
// STATUS: complete. `matchstate`/the pure query functions (Match_InCountdown/
// Match_InPlay/Match_Mode/Match_CanScore/Match_Over) and GamePaused were
// already ported by an earlier pass. This pass ports everything else:
// SetPause, KillMatch, StartMatch, SpawnTourneyClock, Tourney_Think,
// Match_Start, Victory, Match_End, Reset_MVP/Query_OMVP/Query_DMVP.
//
// Cross-dependency note: g_ctffunc.ts already statically imports
// `matchstate`/`MatchStatesT` from this file, so any import in the other
// direction (this file needing g_ctffunc.ts's ctf_ChangeMap/ctf_BSafePrint/
// ctf_teamstring) would close a value cycle. Per PORTING.md's rule, this
// file (imported first) is not the side that breaks it -- every
// g_ctffunc.ts symbol below is resolved via a lazy require instead of a
// static import.
//
// NOT PORTED, cited at its one call site below: Victory's
// `ctf_SetLogName()` automated log-file-rename call (g_ctffunc.c:1437) --
// gated on a `logrename` cvar g_save.c registers that this port's InitGame
// (g_main.ts) never registers (out of SCOPE, matches every other
// unregistered LM_CTF-only cvar cited there).
//
// p_client.ts and p_stats.ts ALSO already statically import this file
// (matchstate/MatchStatesT for p_client.ts's respawn, Match_CanScore for
// p_stats.ts) -- Match_Start's player_die/stats_clear/stats_get calls
// below are therefore resolved via lazy requires too, same rule.
//
// Match_Start's MATCH_RAILGUN_COUNTDOWN branch (giving every live player a
// railgun + 1000 slugs and switching to it) is NOT ported: it needs
// ChangeWeapon/Add_Ammo (p_weapon.c weapon-switch/ammo-grant plumbing),
// neither of which exists anywhere in this port (p_weapon.ts only has the
// offhand-hook fire chain -- see that file's own header). The health reset
// and matchstate/message transition for that branch ARE ported; only the
// weapon grant is skipped, cited inline below. This branch is unreachable
// through any path this port actually wires (Cmd_Match_f's railgun-mode
// argument parsing is itself not ported, see g_cmds.ts's file header), so
// this is a documented gap in dead code, not a live regression.

import { type EdictT, g_edicts, game, gameCvars, gi, level } from "./g_local";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { type Vec3, vec3_origin } from "../shared/math";

// lmctf60/p_client.c's player_die -- lazy require, see file header (p_client.ts
// already statically imports matchstate/MatchStatesT from this file).
function clientModule(): typeof import("./p_client") {
  return require("./p_client") as typeof import("./p_client");
}
function player_die(self: EdictT, inflictor: EdictT, attacker: EdictT, damage: number, point: Vec3): void {
  clientModule().player_die(self, inflictor, attacker, damage, point);
}

// lmctf60/p_stats.c -- lazy require, see file header (p_stats.ts already
// statically imports Match_CanScore from this file). STATS_* index
// constants are duplicated by value below (byte-identical to p_stats.ts's
// own definitions) rather than routed through the lazy module accessor,
// same size/risk tradeoff g_items.ts's RUNE_REGEN duplication documents.
function statsModule(): typeof import("./p_stats") {
  return require("./p_stats") as typeof import("./p_stats");
}
function stats_clear(ent: EdictT | null): void {
  statsModule().stats_clear(ent);
}
function stats_get(ent: EdictT, stat: number): number {
  return statsModule().stats_get(ent, stat);
}
const STATS_SCORE = 3;
const STATS_DEFENSE_FLAG = 7;
const STATS_DEFENSE_BASE = 8;
const STATS_DEFENSE_CARRIER = 9;
const STATS_ASSISTS = 10;
const STATS_RETURNS = 11;
const STATS_OFFENSE_CARRIER = 13;
const STATS_CAPTURES = 4;

// lmctf60/g_local.h CTF team constants this file needs (CTF_TEAM_RED/BLUE);
// duplicated by value rather than imported from g_ctffunc.ts for the same
// import-cycle reason documented above (g_ctffunc.ts already imports this
// file statically). Values must match g_ctffunc.ts's real CTF_TEAM_RED=1/
// CTF_TEAM_BLUE=2 exactly (confirmed against that file).
const CTF_TEAM_RED = 1;
const CTF_TEAM_BLUE = 2;

// CHAN_CTF (g_local.ts) -- safe to import statically: g_local.ts is
// beneath both this file and g_ctffunc.ts in the dependency order, no cycle.
import { CHAN_CTF } from "./g_local";
import { ATTN_NONE, PRINT_HIGH } from "../shared/q_shared";

// ---------------------------------------------------------------------
// Lazy g_ctffunc.ts cross-dependencies (see file header for why).
// ---------------------------------------------------------------------
function ctffuncModule(): typeof import("./g_ctffunc") {
  return require("./g_ctffunc") as typeof import("./g_ctffunc");
}
function ctf_ChangeMap(mapname: string | null, startmatch: boolean): void {
  ctffuncModule().ctf_ChangeMap(mapname, startmatch);
}
function ctf_BSafePrint(printPriority: number, buf: string): void {
  ctffuncModule().ctf_BSafePrint(printPriority, buf);
}
function ctf_teamstring(buf: string, teamnum: number, teamnumOption: number): string {
  return ctffuncModule().ctf_teamstring(buf, teamnum, teamnumOption).text;
}

// lmctf60/g_cmds.c's ForceCommand -- used by Tourney_Think's railgun-mode
// "say I am %p" announcement. Lazy require: g_cmds.ts does not import this
// file today, but Cmd_StartMatch_f/Cmd_StopMatch_f/Cmd_Team_f etc (this
// same unit's g_cmds.ts completion) DO import StartMatch/KillMatch/
// SetPause from here, so a static import back would close a cycle.
function cmdsModule(): typeof import("./g_cmds") {
  return require("./g_cmds") as typeof import("./g_cmds");
}

// lmctf60/g_local.h (refset bits) -- not needed here; skip.

// lmctf60/g_menu.h
export enum MatchStatesT {
  MATCH_NONE,
  MATCH_ENDLEVEL, // Match_Mode false before here
  MATCH_COUNTDOWN,
  MATCH_INPLAY,
  MATCH_OVER,
  MATCH_RAILGUN_COUNTDOWN,
  MATCH_RAILGUN_INPLAY,
  MATCH_RAILGUN_OVER,
}

// `extern int matchstate;` -- lmctf60/g_tourney.c's file-local `static int
// matchstate = MATCH_NONE;` promoted to a module export the same way every
// other cross-file C global in this port is (g_local.ts's `game`/`level`
// pattern).
export let matchstate: MatchStatesT = MatchStatesT.MATCH_NONE;
export function SetMatchState(v: MatchStatesT): void {
  matchstate = v;
}

// lmctf60/g_tourney.c: `static qboolean match_pause = false;`
let match_pause = false;

// lmctf60/g_tourney.c: `edict_t *tourneyclock = NULL;`
let tourneyclock: EdictT | null = null;
export function GetTourneyClock(): EdictT | null {
  return tourneyclock;
}

// lmctf60/g_main.c: `edict_t *omvp = NULL, *dmvp = NULL;` -- these are
// g_tourney.c's own module-static Reset_MVP/Query_OMVP/Query_DMVP targets
// (g_main.c declares its OWN unrelated Railgun_Victor global; not the same
// variable). Kept module-local here, matching the C source's file-static
// storage.
let omvp: EdictT | null = null;
let dmvp: EdictT | null = null;

export function Reset_MVP(): void {
  omvp = null;
  dmvp = null;
}

export function Query_OMVP(): EdictT | null {
  return omvp;
}

export function Query_DMVP(): EdictT | null {
  return dmvp;
}

export function Match_InCountdown(): boolean {
  return matchstate === MatchStatesT.MATCH_COUNTDOWN;
}

export function Match_InPlay(): boolean {
  return matchstate === MatchStatesT.MATCH_INPLAY;
}

export function Match_Mode(): boolean {
  return matchstate > MatchStatesT.MATCH_ENDLEVEL;
}

export function Match_CanScore(): boolean {
  if (
    matchstate === MatchStatesT.MATCH_OVER ||
    matchstate === MatchStatesT.MATCH_COUNTDOWN ||
    matchstate === MatchStatesT.MATCH_RAILGUN_COUNTDOWN
  ) {
    return false;
  }
  return true;
}

/*
=================
Match_Over (lmctf60/g_tourney.c:235) -- byte-identical to the C source.
=================
*/
export function Match_Over(): boolean {
  return matchstate === MatchStatesT.MATCH_OVER;
}

/*
=================
GamePaused (lmctf60/g_tourney.c:240)
=================
*/
export function GamePaused(): boolean {
  return match_pause;
}

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}

/*
=================
SetPause (lmctf60/g_tourney.c:245) -- byte-identical to the C source.
autolock's `game.teamslocked` side effect is preserved exactly (pausing
UNLOCKS teams, unpausing RE-LOCKS them, both gated on the same autolock
cvar StartMatch/KillMatch/SpawnTourneyClock gate their own team-lock
writes on).
=================
*/
export function SetPause(state: boolean): void {
  match_pause = state;

  let message: string;
  if (state) {
    if (cvarNum(gameCvars.autolock) !== 0) {
      game.teamslocked = false;
    }
    message = "Game Paused\n";
  } else {
    if (cvarNum(gameCvars.autolock) !== 0) {
      game.teamslocked = true;
    }
    message = "Game Unpaused\n";
  }

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse) continue;
    gi.centerprintf(ent, message);
  }
  gi.dprintf(message);
}

/*
=================
KillMatch (lmctf60/g_tourney.c:434) -- byte-identical to the C source.
=================
*/
export function KillMatch(): void {
  matchstate = MatchStatesT.MATCH_NONE;

  if (tourneyclock !== null) {
    tourneyclock.think = G_FreeEdict;
    tourneyclock.nextthink = level.time + 1;
    tourneyclock = null;
  }

  if (cvarNum(gameCvars.autolock) !== 0) {
    game.teamslocked = false;
  }
}

/*
=================
StartMatch (lmctf60/g_tourney.c:449) -- byte-identical to the C source.
=================
*/
export function StartMatch(levelname: string | null): void {
  if (cvarNum(gameCvars.autolock) !== 0) {
    game.teamslocked = true;
  }

  ctf_ChangeMap(levelname, true);
}

// CTF_Countdown_Table (lmctf60/g_tourney.c:276) -- index 0 is the "go" cue,
// indices 1-10 the "N seconds" voice-count sounds; `ent->count` (0-10)
// indexes this table directly in Tourney_Think below.
const CTF_Countdown_Table: string[] = [
  "ctf/go.wav",
  "ctf/1.wav",
  "ctf/2.wav",
  "ctf/3.wav",
  "ctf/4.wav",
  "ctf/5.wav",
  "ctf/6.wav",
  "ctf/7.wav",
  "ctf/8.wav",
  "ctf/9.wav",
  "ctf/10.wav",
];

// lmctf60/g_tourney.c:290-292 -- module-static counters Tourney_Think's
// MATCH_RAILGUN_INPLAY branch uses across calls.
let Last_Guy = 0;
let Position_Count = 0;

/*
=================
Match_Start (lmctf60/g_tourney.c:38) -- see file header for the ONE
documented gap (MATCH_RAILGUN_COUNTDOWN's weapon/ammo grant, ChangeWeapon/
Add_Ammo not ported anywhere in this port). Everything else -- the
per-player death-and-stats-clear reset, the message + matchstate
transition -- is byte-identical to the C source.
=================
*/
export function Match_Start(ent: EdictT): void {
  const maxclients = cvarNum(gameCvars.maxclients);
  let player_count = 0;

  for (let i = 0; i < maxclients; i++) {
    const player = g_edicts[1 + i];
    if (player === undefined) continue;

    // Don't bother killing them if they are an observer
    if (player.inuse && player.client !== null && !player.client.resp.spectator) {
      player_count++;

      if (matchstate !== MatchStatesT.MATCH_RAILGUN_COUNTDOWN) {
        player.health = 0;
        player_die(player, player, player, 100000, vec3_origin);
        // don't even bother waiting for death frames

        // Start our time over so we respawn on team spawn point
        player.client.resp.enterframe = level.framenum;

        stats_clear(player); // Blank all our stats, whether we are here or not
      } else {
        // MATCH_RAILGUN_COUNTDOWN: the C source also does
        // `player->client->pers.weapon = FindItem("railgun"); ...
        // Add_Ammo(player, FindItem("slugs"), 1000); ChangeWeapon(player);`
        // here -- NOT reproduced, see this file's header (ChangeWeapon/
        // Add_Ammo not ported anywhere in this port).
        player.health = 100;
      }
    }
  }

  if (matchstate === MatchStatesT.MATCH_RAILGUN_COUNTDOWN) {
    matchstate = MatchStatesT.MATCH_RAILGUN_INPLAY;
    ent.count = cvarNum(gameCvars.railtime);
    ctf_BSafePrint(PRINT_HIGH, `${ent.count} seconds. ${player_count} men enter 1 man leaves \n`);
  } else {
    matchstate = MatchStatesT.MATCH_INPLAY;
    ent.count = (cvarNum(gameCvars.timelimit) & 0xffff) * 60;
    ctf_BSafePrint(PRINT_HIGH, `${Math.floor(ent.count / 60)} minutes until match ends.\n`);
  }
}

/*
=================
Victory (lmctf60/g_tourney.c:97) -- see file header for the one dropped
call (ctf_SetLogName, gated on an unregistered cvar). Everything else is
byte-identical to the C source, including the DMVP/OMVP scoring formulas.
=================
*/
export function Victory(): void {
  const maxclients = cvarNum(gameCvars.maxclients);
  let redscore = 0;
  let bluescore = 0;
  let oscore = 0;
  let dscore = 0;
  omvp = null;
  dmvp = null;
  let lastEnt: EdictT | null = null;

  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined || !ent.inuse || ent.client === null) continue;
    lastEnt = ent;

    if (ent.client.ctf.teamnum === CTF_TEAM_RED) {
      redscore += stats_get(ent, STATS_SCORE);
    } else if (ent.client.ctf.teamnum === CTF_TEAM_BLUE) {
      bluescore += stats_get(ent, STATS_SCORE);
    }
  }

  // Find the dmvp
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined) continue;

    const temp =
      4 * stats_get(ent, STATS_OFFENSE_CARRIER) +
      3 * stats_get(ent, STATS_DEFENSE_FLAG) +
      2 * stats_get(ent, STATS_RETURNS) +
      stats_get(ent, STATS_DEFENSE_CARRIER) +
      stats_get(ent, STATS_DEFENSE_BASE);

    if (temp > dscore) {
      dscore = temp;
      dmvp = ent;
    }
  }

  // Find the omvp
  for (let i = 0; i < maxclients; i++) {
    const ent = g_edicts[1 + i];
    if (ent === undefined) continue;

    // Exclude dmvp
    if (ent === dmvp) continue;

    const temp = 8 * stats_get(ent, STATS_CAPTURES) + 4 * stats_get(ent, STATS_DEFENSE_CARRIER) + stats_get(ent, STATS_ASSISTS);

    if (temp > oscore) {
      oscore = temp;
      omvp = ent;
    }
  }

  let victoryBuf = "";

  if (dmvp !== null && dmvp.client !== null) {
    const teambuf = ctf_teamstring("", dmvp.client.ctf.teamnum, -7 /* CTF_TEAM_MATCHING */);
    victoryBuf += `Defense MVP: ${dmvp.client.pers.netname} (${teambuf})!\n`;
  }

  if (omvp !== null && omvp.client !== null) {
    const teambuf = ctf_teamstring("", omvp.client.ctf.teamnum, -7 /* CTF_TEAM_MATCHING */);
    victoryBuf += `Offense MVP: ${omvp.client.pers.netname} (${teambuf})!\n`;
  }

  const soundEnt = lastEnt ?? g_edicts[1];
  if (bluescore > redscore) {
    if (soundEnt !== undefined) gi.sound(soundEnt, CHAN_CTF, gi.soundindex("ctf/end_blue.wav"), 1, ATTN_NONE, 0);
    victoryBuf += `Blue: ${bluescore} beats red: ${redscore}!\n`;
  } else if (redscore > bluescore) {
    if (soundEnt !== undefined) gi.sound(soundEnt, CHAN_CTF, gi.soundindex("ctf/end_red.wav"), 1, ATTN_NONE, 0);
    victoryBuf += `Red: ${redscore} beats blue: ${bluescore}!\n`;
  } else {
    if (soundEnt !== undefined) gi.sound(soundEnt, CHAN_CTF, gi.soundindex("ctf/end_tie.wav"), 1, ATTN_NONE, 0);
    victoryBuf += `Tie game at ${redscore}!\n`;
  }

  ctf_BSafePrint(PRINT_HIGH, victoryBuf);
  // ctf_SetLogName() -- NOT ported, see file header.
}

/*
=================
Match_End (lmctf60/g_tourney.c:202) -- byte-identical to the C source.
=================
*/
export function Match_End(ent: EdictT): void {
  Victory();

  matchstate = MatchStatesT.MATCH_OVER;
  ent.count = 300; // five minutes
  game.teamslocked = false;
}

/*
=================
One_Man_Left / Declare_Railgun_Victor (lmctf60/g_main.c:456/478) -- these
two live in g_main.c, not g_tourney.c, but Tourney_Think's
MATCH_RAILGUN_INPLAY branch below needs them and nothing else in this port
does; ported here (module-private) rather than promoted to a full
g_main.ts export, matching this file's existing `Last_Guy`/`Position_Count`
module-static convention for the same railgun-mode feature.
=================
*/
function One_Man_Left(): boolean {
  const maxclients = cvarNum(gameCvars.maxclients);
  let livingPeople = 0;
  for (let i = 0; i < maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined) continue;
    if (cl_ent.health > 0) livingPeople++;
    if (livingPeople > 1) return false;
  }
  return true;
}

function Declare_Railgun_Victor(): EdictT | null {
  let highscore = -9999;
  const maxclients = cvarNum(gameCvars.maxclients);
  let winner: EdictT | null = g_edicts[1] ?? null;

  for (let i = 0; i < maxclients; i++) {
    const cl_ent = g_edicts[1 + i];
    if (cl_ent === undefined || cl_ent.health <= 0) continue;

    const score = stats_get(cl_ent, STATS_SCORE);
    if (score > highscore) {
      winner = cl_ent;
      highscore = score;
    }
  }

  return winner;
}

// `edict_t *Railgun_Victor;` (g_main.c) -- module-local here for the same
// reason One_Man_Left/Declare_Railgun_Victor are (nothing outside the
// railgun-mode Tourney_Think branch reads it in this port; p_hud.c's own
// Railgun_Victor read is part of the HUD MVP display, not ported -- see
// p_hud.ts's own SCOPE).
let Railgun_Victor: EdictT | null = null;

/*
=================
Tourney_Think (lmctf60/g_tourney.c:298) -- byte-identical to the C source,
including the railgun-mode branches (Match_Start's one documented gap
aside, see file header).
=================
*/
export function Tourney_Think(ent: EdictT): void {
  ent.nextthink = level.time + 1;

  // If game paused, don't keep counting down
  if (GamePaused()) return;

  const minutes = Math.floor(ent.count / 60);

  if (matchstate === MatchStatesT.MATCH_COUNTDOWN || matchstate === MatchStatesT.MATCH_RAILGUN_COUNTDOWN) {
    if (ent.count <= 10) {
      const snd = CTF_Countdown_Table[ent.count];
      if (snd !== undefined) gi.sound(ent, CHAN_CTF, gi.soundindex(snd), 1, ATTN_NONE, 0);
    }

    switch (ent.count) {
      case 60:
        ctf_BSafePrint(PRINT_HIGH, "60 seconds until match begins.\n");
        break;
      case 30:
        ctf_BSafePrint(PRINT_HIGH, "30 seconds until match begins.\n");
        break;
      case 15:
        if (matchstate === MatchStatesT.MATCH_RAILGUN_COUNTDOWN) {
          ctf_BSafePrint(PRINT_HIGH, "Prepare to annihilate your enemy...\n");
          gi.sound(ent, CHAN_CTF, gi.soundindex("weapons/bfg__l1a.wav"), 1, ATTN_NONE, 0);
        } else {
          ctf_BSafePrint(PRINT_HIGH, "15 seconds until match begins.\n");
        }
        break;
      case 10:
        ctf_BSafePrint(PRINT_HIGH, "10 seconds until match begins.\n");
        break;
      case 0:
        Last_Guy = 0;
        Position_Count = 0;
        Match_Start(ent);
        break;
      default:
        break;
    }
  } else if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) {
    const maxclients = cvarNum(gameCvars.maxclients);
    Position_Count++;
    if (Position_Count === 6) {
      let cl_ent = g_edicts[1 + Last_Guy];

      while (cl_ent !== undefined && cl_ent.health <= 0) {
        Last_Guy++;
        if (Last_Guy === maxclients) {
          Last_Guy = 0;
          break;
        }
        cl_ent = g_edicts[1 + Last_Guy];
      }

      cl_ent = g_edicts[1 + Last_Guy];
      if (cl_ent !== undefined && cl_ent.health > 0) {
        cmdsModule().ForceCommand(cl_ent, "say I am %p");
      }

      Last_Guy++;
      Position_Count = 0;
    }

    if (ent.count === 0 || One_Man_Left()) {
      Railgun_Victor = Declare_Railgun_Victor();
      matchstate = MatchStatesT.MATCH_RAILGUN_OVER;
    } else if (ent.count <= 15) {
      ctf_BSafePrint(PRINT_HIGH, `${ent.count}\n`);
      if (ent.count <= 10) {
        const snd = CTF_Countdown_Table[ent.count];
        if (snd !== undefined) gi.sound(ent, CHAN_CTF, gi.soundindex(snd), 1, ATTN_NONE, 0);
      }
    }
  } else if (matchstate === MatchStatesT.MATCH_INPLAY) {
    // Start the countdown if we hit the fraglimit
    if (ent.count > 10) {
      const maxclients = cvarNum(gameCvars.maxclients);
      for (let i = 0; i < maxclients; i++) {
        const player = g_edicts[1 + i];
        if (player === undefined || !player.inuse) continue;

        const fraglimit = cvarNum(gameCvars.fraglimit);
        if (fraglimit !== 0 && stats_get(player, STATS_SCORE) >= fraglimit) {
          // Fraglimit was hit
          ent.count = 10;
        }
      }
    }

    if (ent.count <= 0) {
      // End match
      Match_End(ent);
      return;
    } else if (ent.count % 60 === 0) {
      if (minutes > 1) {
        ctf_BSafePrint(PRINT_HIGH, `${minutes} minutes until match ends.\n`);
      } else if (minutes === 1) {
        ctf_BSafePrint(PRINT_HIGH, `${minutes} minute until match ends.\n`);
      } else {
        ctf_BSafePrint(PRINT_HIGH, `${Math.floor(cvarNum(gameCvars.fraglimit))} frags until match ends.\n`);
      }
    } else if (ent.count <= 10) {
      const snd = CTF_Countdown_Table[ent.count];
      if (snd !== undefined) gi.sound(ent, CHAN_CTF, gi.soundindex(snd), 1, ATTN_NONE, 0);
    }
  } else if (matchstate === MatchStatesT.MATCH_OVER) {
    if (ent.count <= 0) {
      matchstate = MatchStatesT.MATCH_NONE;
      ent.think = G_FreeEdict;
      tourneyclock = null;
    }
  }

  ent.count--;
}

/*
=================
SpawnTourneyClock (lmctf60/g_tourney.c:458) -- byte-identical to the C
source.
=================
*/
export function SpawnTourneyClock(): void {
  let ent: EdictT;

  if (tourneyclock === null) {
    ent = G_Spawn();
    tourneyclock = ent;
  } else {
    ent = tourneyclock;
  }

  if (matchstate === MatchStatesT.MATCH_RAILGUN_COUNTDOWN) {
    ent.count = 16;
  } else {
    ent.count = Math.floor(cvarNum(gameCvars.countdown_time));
    matchstate = MatchStatesT.MATCH_COUNTDOWN;
  }

  // game is about to start, lock teams if necessary
  if (cvarNum(gameCvars.autolock) !== 0) {
    game.teamslocked = true;
  }

  ent.think = Tourney_Think;
  ent.nextthink = level.time + 1;
}
