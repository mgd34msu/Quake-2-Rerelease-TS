// Ports lmctf60/bat.c + bat.h.
//
// FINDING (this file's whole reason for existing as a brief line item):
// "bat" is not a weapon, item, or creature. bat.c is a tiny leftover
// debug-utility module -- its only two functions, Cmd_DanMan and
// Debug_Show, are wrapped in `#ifdef BAT_DEBUG`, and bat.h immediately
// `#undef`s BAT_DEBUG one line after defining the (commented-out)
// `//#define BAT_DEBUG`. Neither function compiles in this or any real
// build of lmctf60; per PORTING.md's "#if 0 blocks are dropped silently"
// rule (this is functionally identical: a permanently-false `#ifdef`),
// both are dropped rather than ported.
//
// What bat.h actually contributes are shared globals/constants used by
// OTHER files via `#include "bat.h"` (12 lmctf60 .c files include it, most
// of them just for these declarations):
//   - MALE/FEMALE gender constants -- used by p_client.c (unit A, not yet
//     ported) to pick a random death message list.
//   - HIGHSCORE_STATS_TYPE, MAX_HIGHSCORE_ENTRIES (7), and the
//     Default_Highscore_Table/Highscore_Table arrays -- DEFINED in g_main.c
//     (unit A's g_main.ts, not this file: bat.h only `extern`s them) and
//     read by p_hud.c (unit A, not yet ported) for the MVP scoreboard.
//   - MvpDisp -- DEFINED in p_hud.c (unit A), same story.
//   - DBuffer[512] -- the one symbol bat.c itself DEFINES (`char
//     DBuffer[512];`). It is genuinely live: p_hud.c's ShowInfo (unit A,
//     not yet ported) does `sprintf(DBuffer, ...); strcat(string,
//     DBuffer);` as a scratch string-build buffer. Every other DBuffer use
//     across the tree (p_client.c, p_hud.c) is inside a commented-out
//     `//sprintf(DBuffer, ...); //Debug_Show(DBuffer);` debug-print pair --
//     dead comments, not code, so not reproduced.
//   - Observer_Show_Menu -- `extern`'d here but NEVER DEFINED anywhere in
//     the lmctf60 tree (checked every .c file) and never referenced outside
//     this one `extern` line either. A dangling declaration left over from
//     removed code; the C source would fail to link if anything actually
//     used it. Ported as inert storage defaulting to 0/false, since that
//     is a faithful "this symbol exists but nothing touches it" port.
//   - MENU_TYPES (a one-member enum, `CTF_MENU`) -- declared, never
//     instantiated or referenced anywhere in the tree either. Same
//     treatment: ported as an inert type for header-fidelity, unused.
//   - MAX_RAILTIME (1200) -- declared, never referenced anywhere in the
//     tree. Ported as an inert constant for the same reason.
//
// None of MALE/FEMALE/HIGHSCORE_STATS_TYPE/Highscore_Table/
// Default_Highscore_Table/MvpDisp are used by any file in this unit's
// scope (g_runes.ts, plasma.ts, g_menu.ts, g_skins.ts, g_vote.ts,
// p_observer.ts, p_stats.ts, gslog.ts, stdlog.ts, g_replace.ts) --
// confirmed by grepping every included-by site in lmctf60. They are
// exported here anyway so unit A's g_main.ts/p_hud.ts/p_client.ts have
// this module to import them from, matching bat.h's real role as a
// shared-declarations header.

// bat.h:1-2
export const MALE = 0;
export const FEMALE = 1;

// bat.h:4-7 -- declared, never referenced anywhere in lmctf60.
export enum MenuTypesT {
  CTF_MENU,
}

// bat.h:13
export const MAX_HIGHSCORE_ENTRIES = 7;

// bat.h:17 -- declared, never referenced anywhere in lmctf60.
export const MAX_RAILTIME = 1200;

// bat.h:21-25
export class HighscoreStatsType {
  Player = ""; // C: `char Player[32]`
  Score = 0; // C: `long Score`
}

// bat.c:6: `char DBuffer[512];` -- storage this file actually owns. Callers
// (p_hud.ts, not yet ported) overwrite it wholesale each use (sprintf),
// never append in place, so a plain reassignable string models the C
// buffer's observable behavior exactly; the 512-byte cap is not enforced
// since no caller-visible truncation behavior has been ported yet
// (p_hud.c's own sprintf calls never approach that length).
export let DBuffer = "";

// bat.h:28 -- `extern int Observer_Show_Menu;` with no definition anywhere
// in the lmctf60 tree (see file header finding). Storage placed here since
// this is the only file that declares it.
export let Observer_Show_Menu = 0;
