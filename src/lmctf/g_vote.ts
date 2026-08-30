// Ports lmctf60/g_vote.c + g_vote.h -- LM_CTF's mid-game vote system
// ("Vampire -- voting menu", per the file's own end-of-file marker
// comment), letting players call a vote to skip the level, jump to a
// specific map, or referee a player.
//
// STATUS: complete. All six g_vote.c functions are ported: Clear_All_Ballots,
// Vote_Skip_Level, Vote_Jump_Level, Vote_Ref_Player, Check_Vote, Vote_YES,
// Vote_NO, Vote_Menu (that's eight -- Clear_All_Ballots plus the seven
// `void Vote_*`/`Check_Vote` declarations at the top of the C file).
//
// Vote_Jump_Level/Vote_Ref_Player set CTF_VOTETYPE_GOTOMAP/CTF_VOTETYPE_REFPLAYER
// but Check_Vote's own pass/fail branches for those two vote types just
// print "Too bad this feature is not done yet :P" -- preserved verbatim,
// not a gap introduced by this port.
//
// Calls Menu_Free/Menu_Set/Menu_Draw/Main_Menu (g_menu.ts, this unit's own
// file) directly: safe as a plain static import even though g_menu.ts
// separately needs Vote_Menu back (for its "Vote menu" mainmenu[] entry)
// because every use here is inside a function body, never at this file's
// own module-evaluation time. g_menu.ts breaks its half of the cycle with
// a lazy require instead of importing Vote_Menu statically -- see its own
// header comment.
//
// EndDMLevel (lmctf60/g_main.c) is a cross-dependency into a file this
// unit does not own (foundation-partial g_main.ts, unit A's completion);
// stays a local throwing stub cited below, same treatment as g_runes.ts/
// plasma.ts.

import { ATTN_NONE, CHAN_ITEM, PRINT_HIGH } from "../shared/q_shared";
import { CTF_TEAM_IGNORETEAM, ctf_findplayer } from "./g_ctffunc";
import type { EdictT } from "./g_local";
import { gi, level } from "./g_local";
import { Main_Menu, Menu_Draw, Menu_Free, Menu_Set } from "./g_menu";

// g_vote.h:8-19
export const CTF_VOTE_STARTED = 1;
// assorted client flags, in the true meaning -- these shadow (and
// override, per this file being loaded after) q_shared.h's own
// CTF_EXTRAFLAGS_VOTE_YES/CTF_EXTRAFLAGS_VOTE_NO, which are commented out
// there specifically because this "Vampire" addition supersedes them; see
// g_ctffunc.ts and g_local.ts's CTF_EXTRAFLAGS_* for the base set (camera
// lock/referee/rcon/camera reverse/radio text/radio sound) that these two
// extend.
export const CTF_EXTRAFLAGS_VOTE_YES = 64;
export const CTF_EXTRAFLAGS_VOTE_NO = 128;

// votetypes
export const CTF_VOTETYPE_SKIP = 1;
export const CTF_VOTETYPE_GOTOMAP = 2;
export const CTF_VOTETYPE_REFPLAYER = 4;

export const PERCENT_MAJORITY_REQUIRED = 75; // requires a 75% majority for the vote to pass

// g_vote.c:12-14
export let VoteStarted = false;
export let VoteTime = 0.0;
export let VoteType = 0;

// ---------------------------------------------------------------------
// Cross-dependency into a file this unit does not own (lmctf60/g_main.c,
// unit A's foundation-partial completion).
// ---------------------------------------------------------------------
function EndDMLevel(): void {
  throw new Error("EndDMLevel not yet ported (lmctf60/g_main.c; owned by unit A's g_main.ts completion)");
}

// exposed for tests only -- resets this module's vote-session state back to
// "server just booted, no vote ever called" (VoteStarted=false, VoteTime=0,
// VoteType=0). No C equivalent: imported `let` bindings are read-only live
// views from outside this module, so tests need an explicit reset instead
// of assigning VoteStarted/VoteTime/VoteType directly.
export function ResetVoteForTest(): void {
  VoteStarted = false;
  VoteTime = 0;
  VoteType = 0;
}

/*
=================
Clear_All_Ballots (lmctf60/g_vote.c:16)

Resets every connected player's vote (yes/no) flags to "abstain", in
preparation for a new vote. Returns the number of players walked (used by
the three Vote_* initiators below as the "at least 4 players" gate).
=================
*/
export function Clear_All_Ballots(_ent: EdictT): number {
  let num_players = 0;

  let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (player !== null) {
    num_players++;
    if (player.client !== null) {
      player.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_NO;
      player.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_YES;
    }
    player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
  }
  return num_players;
}

/*
=================
Vote_Skip_Level (lmctf60/g_vote.c:36)
=================
*/
export function Vote_Skip_Level(ent: EdictT): void {
  const num_players = Clear_All_Ballots(ent);
  if (num_players < 4) {
    gi.cprintf(ent, PRINT_HIGH, "You need at least four players on the server to initiate a vote\n");
  } else if (VoteStarted) {
    gi.cprintf(ent, PRINT_HIGH, "Vote has already been started\n");
  } else {
    VoteStarted = true;
    VoteTime = level.time; // start the 30 second timer
    VoteType |= CTF_VOTETYPE_SKIP;

    if (ent.client === null) {
      throw new Error("Vote_Skip_Level: ent.client is null (lmctf60/g_vote.c:51 dereferences ent->client unconditionally)");
    }
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} started vote to skip level.\n`);
    gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/secret.wav"), 1, ATTN_NONE, 0);
    ent.client.ctf.extra_flags |= CTF_EXTRAFLAGS_VOTE_YES; // client who initiates vote must vote yes by default
    ent.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_NO;
  }
  Vote_Menu(ent);
}

/*
=================
Vote_Jump_Level (lmctf60/g_vote.c:59)
=================
*/
export function Vote_Jump_Level(ent: EdictT): void {
  const num_players = Clear_All_Ballots(ent);
  if (num_players < 4) {
    gi.cprintf(ent, PRINT_HIGH, "You need at least four players on the server to initiate a vote\n");
  } else if (VoteStarted) {
    gi.cprintf(ent, PRINT_HIGH, "Vote has already been started\n");
  } else {
    VoteStarted = true;
    VoteTime = level.time; // start the 30 second timer
    VoteType |= CTF_VOTETYPE_GOTOMAP;

    if (ent.client === null) {
      throw new Error("Vote_Jump_Level: ent.client is null (lmctf60/g_vote.c:74 dereferences ent->client unconditionally)");
    }
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} started vote to jump to specific level.\n`);
    gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/secret.wav"), 1, ATTN_NONE, 0);
    ent.client.ctf.extra_flags |= CTF_EXTRAFLAGS_VOTE_YES;
    ent.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_NO;
  }
  Vote_Menu(ent);
}

/*
=================
Vote_Ref_Player (lmctf60/g_vote.c:82)
=================
*/
export function Vote_Ref_Player(ent: EdictT): void {
  const num_players = Clear_All_Ballots(ent);
  if (num_players < 4) {
    gi.cprintf(ent, PRINT_HIGH, "You need at least four players on the server to initiate a vote\n");
  } else if (VoteStarted) {
    gi.cprintf(ent, PRINT_HIGH, "Vote has already been started\n");
  } else {
    VoteStarted = true;
    VoteTime = level.time; // start the 30 second timer
    VoteType |= CTF_VOTETYPE_REFPLAYER;

    if (ent.client === null) {
      throw new Error("Vote_Ref_Player: ent.client is null (lmctf60/g_vote.c:97 dereferences ent->client unconditionally)");
    }
    gi.bprintf(PRINT_HIGH, `${ent.client.pers.netname} started vote to referee a player.\n`);
    gi.sound(ent, CHAN_ITEM, gi.soundindex("misc/secret.wav"), 1, ATTN_NONE, 0);
    ent.client.ctf.extra_flags |= CTF_EXTRAFLAGS_VOTE_YES;
    ent.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_NO;
  }
  Vote_Menu(ent);
}

/*
=================
Check_Vote (lmctf60/g_vote.c:105) -- called from p_client.c (unit A, not
this file)

30 seconds after a vote starts, tallies every connected player's
yes/no/abstain flag. Only yes+no ballots count toward the total; a vote
needs at least 2 cast ballots and a >=75% yes share (rounded per
`remainder > midpoint` -- integer-percent rounding, not exact fractional
rounding) to pass.
=================
*/
export function Check_Vote(): void {
  if (level.time > VoteTime + 30) {
    // if the 30 seconds are up then process the votes.
    gi.bprintf(PRINT_HIGH, "Vote session has ended\n");
    VoteStarted = false;

    // go in and check the ent->client->ctf.extra_flags of each player and tabulate the votes
    let num_yes = 0;
    let num_no = 0;
    let num_abstained = 0;

    let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
    while (player !== null) {
      if (player.client !== null && (player.client.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_YES) !== 0) {
        num_yes++;
      } else if (player.client !== null && (player.client.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_NO) !== 0) {
        num_no++;
      } else {
        num_abstained++;
      }
      player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
    }

    gi.bprintf(PRINT_HIGH, `VOTE RESULT: YES:${num_yes}  NO:${num_no}  Abstained:${num_abstained}\n`);
    const total_votes = num_yes + num_no; // only those who voted will be counted
    if (total_votes < 2) {
      gi.bprintf(PRINT_HIGH, "Vote Fails: you need at least 2 ballots cast!\n");
    } else {
      let vote_result = ((num_yes * 100) / total_votes) | 0;
      const remainder = (num_yes * 100) % total_votes; // find the remainder of the integer division if there is one.
      const midpoint = total_votes >> 1;
      if (remainder > midpoint) vote_result++; // if the remainder is greater than 50% then round up by one.
      if (vote_result >= PERCENT_MAJORITY_REQUIRED) {
        if ((VoteType & CTF_VOTETYPE_SKIP) !== 0) {
          gi.bprintf(PRINT_HIGH, `Vote to skip level Passes with ${vote_result} percent majority\n`);
          EndDMLevel();
        } else if ((VoteType & CTF_VOTETYPE_GOTOMAP) !== 0) {
          gi.bprintf(PRINT_HIGH, `Vote to goto level Passes with ${vote_result} percent majority\n`);
          gi.bprintf(PRINT_HIGH, "Too bad this feature is not done yet :P\n");
        } else if ((VoteType & CTF_VOTETYPE_REFPLAYER) !== 0) {
          gi.bprintf(PRINT_HIGH, `Vote to ref player Passes with ${vote_result} percent majority\n`);
          gi.bprintf(PRINT_HIGH, "Too bad this feature is not done yet :P\n");
        }
      } else {
        gi.bprintf(PRINT_HIGH, `Vote Fails with ${100 - vote_result} percent majority\n`);
      }
    }
    VoteType &= ~CTF_VOTETYPE_SKIP; // clear the vote modes
    VoteType &= ~CTF_VOTETYPE_GOTOMAP;
    VoteType &= ~CTF_VOTETYPE_REFPLAYER;
  }
}

/*
=================
Vote_YES (lmctf60/g_vote.c:185)
=================
*/
export function Vote_YES(ent: EdictT): void {
  gi.cprintf(ent, PRINT_HIGH, "You have voted YES\n");
  if (ent.client === null) {
    throw new Error("Vote_YES: ent.client is null (lmctf60/g_vote.c:188 dereferences ent->client unconditionally)");
  }
  ent.client.ctf.extra_flags |= CTF_EXTRAFLAGS_VOTE_YES;
  ent.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_NO;
  Vote_Menu(ent);
}

/*
=================
Vote_NO (lmctf60/g_vote.c:193)
=================
*/
export function Vote_NO(ent: EdictT): void {
  gi.cprintf(ent, PRINT_HIGH, "You have voted NO\n");
  if (ent.client === null) {
    throw new Error("Vote_NO: ent.client is null (lmctf60/g_vote.c:196 dereferences ent->client unconditionally)");
  }
  ent.client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_VOTE_YES;
  ent.client.ctf.extra_flags |= CTF_EXTRAFLAGS_VOTE_NO;
  Vote_Menu(ent);
}

/*
=================
Vote_Menu (lmctf60/g_vote.c:201) -- Vampire -- voting menu
=================
*/
export function Vote_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Vote_Menu: ent.client is null (lmctf60/g_vote.c:206 dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  Menu_Free(ent);
  ent.client.menu = 0; // MENU_LOCAL
  ent.client.menuselect = 1;

  Menu_Set(ent, 0, "LMCTF Vote Menu", Main_Menu);
  Menu_Set(ent, 1, "------------------", null);
  if (!VoteStarted) {
    Menu_Set(ent, 2, "Skip to next map", Vote_Skip_Level);
    Menu_Set(ent, 3, "Jump to specific map", Vote_Jump_Level);
    Menu_Set(ent, 4, "Referee a player", Vote_Ref_Player);
  } else {
    Menu_Set(ent, 3, "Vote YES", Vote_YES);
    Menu_Set(ent, 4, "Vote NO", Vote_NO);
  }
  Menu_Set(ent, 6, VoteStarted ? "Vote:     Started" : "Vote:     Idle", null);
  if (VoteStarted) {
    let text: string;
    if ((cl.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_YES) !== 0) {
      text = "You have voted YES";
    } else if ((cl.ctf.extra_flags & CTF_EXTRAFLAGS_VOTE_NO) !== 0) {
      text = "You have voted NO";
    } else {
      text = "You have not voted";
    }
    Menu_Set(ent, 8, text, null);
  }

  cl.menuselect = 0;

  Menu_Draw(ent);
}
/* END -- Vampire */
