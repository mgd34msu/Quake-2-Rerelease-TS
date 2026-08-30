// Ports a SUBSET of lmctf60/g_tourney.c -- LM_CTF's match/tournament state
// machine (483 lines; wholly new, no CTF-mod ancestor).
//
// STATUS: only `matchstate` and the pure query functions that read it
// (Match_InCountdown/Match_InPlay/Match_Mode/Match_CanScore) plus the
// pause flag and GamePaused() are ported -- these are the only pieces
// g_combat.ts's T_Damage and p_view.ts's ClientEndServerFrame (both in the
// offhand-hook priority feature's dependency chain) actually read.
// SpawnTourneyClock, StartMatch, KillMatch, SetPause (the only function
// that ever WRITES match_pause or advances matchstate), Victory,
// Match_Over, Query_OMVP/Query_DMVP/Reset_MVP, and Match_End are NOT
// ported. Because nothing yet calls SetPause or advances matchstate, this
// slice is internally consistent: the server boots with matchstate ==
// MATCH_NONE and match_pause == false, exactly the C source's static
// initializers, and stays there until the rest of g_tourney.c is ported.

// lmctf60/g_tourney.h
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
GamePaused (lmctf60/g_tourney.c:240)
=================
*/
export function GamePaused(): boolean {
  return match_pause;
}
