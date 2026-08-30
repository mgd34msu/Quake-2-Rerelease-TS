// Ports lmctf60/p_stats.c + p_stats.h -- LM_Hati's persistent player-stats
// subsystem (per-player frag/death/capture/defense/assist counters plus
// ping averaging), backing the squadboard and the `stats`/`statsall`
// console commands.
//
// STATUS: complete. Every function in p_stats.c is ported: stats_log_init,
// stats_log_reset, stats_find_dropped_player, stats_init_player (module-
// private -- not declared in p_stats.h, only used within this file, same
// as the C source), stats_new_player, stats_set_name, stats_cleanup,
// stats_add, stats_set, stats_get, stats_clear, stats_output
// (module-private, same reasoning), Cmd_PlayerStats_f, Cmd_StatsAll_f.
//
// StatsClientT/StatsPlayerT/MAX_PLAYER_STATS already exist in g_local.ts
// (the foundation ported these specifically because GClientT.p_stats_player
// needed the type -- see that file's own doc comment on StatsPlayerT).
// The STATS_* index constants (p_stats.h) are this file's own to define,
// same "headers become type/constant modules" split g_menu.h/g_local.h use
// elsewhere in this port.
//
// gi.TagMalloc/TagFree (memory tags) are OMITTED per PORTING.md; every
// `gi.TagMalloc(sizeof(stats_player_s), TAG_GAME)` becomes a plain `new
// StatsPlayerT()`, and TagFree calls are dropped (GC reclaims unreferenced
// objects).

import { PRINT_HIGH } from "../shared/q_shared";
import { Match_CanScore } from "./g_tourney";
import { LowerCase } from "./g_replace";
import { ctf_SafePrint, CTF_TEAM_MATCHING, CTF_TEAM_UNDEFINED } from "./g_ctffunc";
import { type EdictT, g_edicts, game, gi, StatsPlayerT } from "./g_local";

// p_stats.h:4-22
export const STATS_PLAYER_SAMPLE_RATE = 20; // how many frames between ping samples, 1 frame = 100 ms

export const STATS_PING_TOTAL = 0; // long ping_total; //add to this every time ping is sampled
export const STATS_PING_SAMPLES = 1; // long ping_samples; //# of samples(+1 each time you sample ping)
export const STATS_TIME = 2; // long time; //time on server in seconds? minutes?
export const STATS_SCORE = 3; // int score; //the overall score
export const STATS_CAPTURES = 4; // int captures; //how many direct flag captures
export const STATS_FRAGS = 5; // int frags; //how many direct kills
export const STATS_DEATHS = 6; // int deaths; //again, how many times you died
export const STATS_DEFENSE_FLAG = 7; // int defense_flag; //defended the flag
export const STATS_DEFENSE_BASE = 8; // int defense_base; //defended the base (whether flag present or not)
export const STATS_DEFENSE_CARRIER = 9; // int defense_carrier; //defended flag carrier
export const STATS_ASSISTS = 10; // int assists; //number of assists
export const STATS_RETURNS = 11; // int returns; //returned the flag
export const STATS_OFFENSE_FLAG = 12; // int offense_flag; //took the enemy flag
export const STATS_OFFENSE_CARRIER = 13; // int offense_carrier; //killed enemy flag carrier
export const STATS_OFFENSE_FLAGLOST = 14; // int offense_flaglost; //lost the enemy flag
// MAX_PLAYER_STATS (15) already exported by g_local.ts.

export enum StatsEventT {
  STATS_SUICIDE,
  STATS_FRAG,
  STATS_FC_FRAG,
  STATS_FC_DEFENSE,
  STATS_FLAG_DEFENSE,
  STATS_FLAG_TOUCH,
  STATS_FLAG_RETURN,
  STATS_FLAG_CAPTURE,
  STATS_BASE_DEFENSE,
}

// p_stats.c:6: `stats_player_s *p_start_player = NULL;` -- head of the
// singly linked list of (mostly dropped) players' retained stats.
let p_start_player: StatsPlayerT | null = null;

/*
=================
stats_log_init (lmctf60/p_stats.c:8)
=================
*/
export function stats_log_init(): void {
  p_start_player = null;
}

/*
=================
stats_log_reset (lmctf60/p_stats.c:13)
=================
*/
export function stats_log_reset(): void {
  let p_current_player = p_start_player;
  while (p_current_player !== null) {
    p_start_player = p_current_player.next;
    p_current_player = p_start_player;
  }

  stats_log_init();
}

/*
=================
stats_find_dropped_player (lmctf60/p_stats.c:28)
=================
*/
export function stats_find_dropped_player(name: string): StatsPlayerT | null {
  let p_current_player = p_start_player;

  while (p_current_player !== null) {
    if (p_current_player.info.name === name && p_current_player.dropped) {
      break;
    }
    p_current_player = p_current_player.next;
  }

  return p_current_player;
}

/*
=================
stats_init_player (lmctf60/p_stats.c:44, not declared in p_stats.h --
module-private here too)
=================
*/
function stats_init_player(p_player: StatsPlayerT): void {
  // set up initial stats for player
  for (let i = 0; i < p_player.stats.length; i++) {
    p_player.stats[i] = 0;
  }
  // p_player->dropped = false; -- commented out in the C source itself, not reproduced.
}

/*
=================
stats_new_player (lmctf60/p_stats.c:53)
=================
*/
export function stats_new_player(name: string): StatsPlayerT {
  const p_player = new StatsPlayerT();

  stats_init_player(p_player);
  p_player.dropped = false;
  p_player.info.teamnum = CTF_TEAM_UNDEFINED;
  p_player.info.name = name;

  // attach the player to the front of the list
  p_player.next = p_start_player;
  p_start_player = p_player;

  return p_player;
}

/*
=================
stats_set_name (lmctf60/p_stats.c:75)
=================
*/
export function stats_set_name(ent: EdictT, name: string): void {
  if (ent.client !== null && ent.client.p_stats_player !== null) {
    /* here should check for duplicate name
       if duplicate name is found, disallow change,
       and force back to original name  */
    ent.client.p_stats_player.info.name = name;
  }
}

/*
=================
stats_cleanup (lmctf60/p_stats.c:88)

Drops every player marked `dropped` from the linked list (freeing their
retained stats for good) and reinitializes the stats of everyone who
remains, ready for the next level.
=================
*/
export function stats_cleanup(): void {
  // clear out dropped players from start and adjust start if needed
  let p_current_player = p_start_player;
  while (p_current_player !== null && p_current_player.dropped) {
    p_start_player = p_current_player.next;
    p_current_player = p_start_player;
  }

  // case when everyone is gone
  if (p_start_player === null) {
    return;
  }

  stats_init_player(p_start_player);

  // clear out dropped players and reinitialize stats
  p_current_player = p_start_player.next; // When the start is valid
  let p_prev_player = p_start_player;

  while (p_current_player !== null) {
    if (p_current_player.dropped) {
      p_prev_player.next = p_current_player.next;
    } else {
      stats_init_player(p_current_player);
      p_prev_player = p_current_player;
    }
    p_current_player = p_prev_player.next;
  }
}

/*
=================
stats_add (lmctf60/p_stats.c:135)
=================
*/
export function stats_add(ent: EdictT, stat: number, amount: number): void {
  if (Match_CanScore() && ent.client !== null && ent.client.p_stats_player !== null) {
    ent.client.p_stats_player.stats[stat] += amount;
  }
}

/*
=================
stats_set (lmctf60/p_stats.c:141)
=================
*/
export function stats_set(ent: EdictT, stat: number, amount: number): void {
  if (Match_CanScore() && ent.client !== null && ent.client.p_stats_player !== null) {
    ent.client.p_stats_player.stats[stat] = amount;
  }
}

/*
=================
stats_get (lmctf60/p_stats.c:147)
=================
*/
export function stats_get(ent: EdictT, stat: number): number {
  if (ent.client !== null && ent.client.p_stats_player !== null) {
    return ent.client.p_stats_player.stats[stat] ?? 0;
  }
  return 0;
}

/*
=================
stats_clear (lmctf60/p_stats.c:156)
=================
*/
export function stats_clear(ent: EdictT | null): void {
  if (ent === null || ent.client === null || ent.client.p_stats_player === null) return;

  stats_init_player(ent.client.p_stats_player);
  ent.client.resp.score = 0;
}

/*
=================
stats_output (lmctf60/p_stats.c:166, not declared in p_stats.h --
module-private here too)
=================
*/
function stats_output(ent: EdictT, p_player: StatsPlayerT): void {
  const conbuf = p_player.dropped ? "quit" : "active";
  const total_encounters = p_player.stats[STATS_FRAGS] + p_player.stats[STATS_DEATHS];

  // ctf_teamstring (lmctf60/g_ctffunc.c) is not yet ported (owned by unit
  // A's g_ctffunc.ts completion) -- this cross-dependency stays a local
  // throwing stub, same treatment as g_replace.ts's.
  const teambuf = ctf_teamstring(p_player.info.teamnum, CTF_TEAM_MATCHING);

  let outbuf = `\n(${teambuf}) [${conbuf}] ${p_player.info.name}\n`;

  const eff = total_encounters === 0 ? 0 : (100 * p_player.stats[STATS_FRAGS]) / total_encounters;
  outbuf += `Score=${p_player.stats[STATS_SCORE]} Frags=${p_player.stats[STATS_FRAGS]} Deaths=${p_player.stats[STATS_DEATHS]} Eff=${Math.trunc(eff)}%\n`;

  outbuf +=
    `Def Base=${p_player.stats[STATS_DEFENSE_BASE]} Def Flag=${p_player.stats[STATS_DEFENSE_FLAG]} Def Carrier=${p_player.stats[STATS_DEFENSE_CARRIER]}\n` +
    `Got Flag=${p_player.stats[STATS_OFFENSE_FLAG]} Lost Flag=${p_player.stats[STATS_OFFENSE_FLAGLOST]} Captures=${p_player.stats[STATS_CAPTURES]}\n`;

  const pingSamples = p_player.stats[STATS_PING_SAMPLES];
  const avgPing = Math.trunc(p_player.stats[STATS_PING_TOTAL] / (pingSamples > 0 ? pingSamples : 1));
  outbuf += `Kill Carrier=${p_player.stats[STATS_OFFENSE_CARRIER]} Flag Returns=${p_player.stats[STATS_RETURNS]} Assists=${p_player.stats[STATS_ASSISTS]}\nAverage Ping=${avgPing} Samples=${pingSamples}\n`;

  ctf_SafePrint(ent, PRINT_HIGH, outbuf);
}

// ---------------------------------------------------------------------
// Cross-dependency into lmctf60/g_ctffunc.c, not yet ported (owned by
// unit A's g_ctffunc.ts completion).
// ---------------------------------------------------------------------
function ctf_teamstring(_teamnum: number, _teamCompare: number): string {
  throw new Error("ctf_teamstring not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

/*
=================
Cmd_PlayerStats_f (lmctf60/p_stats.c:221)

With no argument, shows the caller's own stats. With an argument, does a
case-insensitive substring search of every connected client's netname and
shows the first match.
=================
*/
export function Cmd_PlayerStats_f(ent: EdictT): void {
  const p = gi.args();
  let target: EdictT | null = null;

  if (p.length > 0) {
    const needle = LowerCase(p);
    for (let i = 0; i < game.maxclients; i++) {
      const temp = g_edicts[1 + i];
      if (temp === undefined || temp.client === null) continue;
      const haystack = LowerCase(temp.client.pers.netname);
      if (haystack.includes(needle)) {
        target = temp;
        break;
      }
    }
  } else {
    target = ent;
  }

  if (target === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Cannot find a matching player.\n");
    return;
  }

  if (target.client === null || target.client.p_stats_player === null) return;
  stats_output(ent, target.client.p_stats_player);
}

/*
=================
Cmd_StatsAll_f (lmctf60/p_stats.c:261)
=================
*/
export function Cmd_StatsAll_f(ent: EdictT): void {
  let p_player = p_start_player;
  while (p_player !== null) {
    stats_output(ent, p_player);
    p_player = p_player.next;
  }
}
