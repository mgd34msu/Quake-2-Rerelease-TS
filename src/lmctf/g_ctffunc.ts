// Ports a SUBSET of lmctf60/g_ctffunc.c -- LM_CTF's team/flag/player-lookup
// helper library (1564 lines total; wholly new, no CTF-mod ancestor -- the
// vanilla `ctf/g_ctf.c` this game family already ported at src/ctf/g_ctf.ts
// has no equivalent module, LM_CTF's team plumbing is a full rewrite).
//
// STATUS: only the functions needed by the offhand-hook priority feature
// are ported here: ctf_findplayer, ctf_validateplayer, ctf_SafePrint's
// queueing half, and ctf_hook_abort. The remaining ~50 functions in
// g_ctffunc.c (flag home/reset/spawn/touch, team-string formatting, spam
// control, ghost-free team assignment, the replace_* text-macro helpers
// that actually live in g_replace.c per g_ctffunc.h's own comment, etc.)
// are NOT ported -- this is a deliberately partial file, reported as a
// follow-up rather than silently completed.

import { ATTN_NONE, MAX_INFO_STRING, PRINT_CHAT, PRINT_HIGH, PRINT_LOW } from "../shared/q_shared";
import { blueflag, CHAN_CTF, type EdictT, FRAMETIME, g_edicts, game, gameCvars, gi, type GItemT, level, redflag } from "./g_local";
import { SolidT } from "./game";
import { G_FreeEdict } from "./g_utils";

// lmctf60/g_ctffunc.h
export const CTF_TEAM_LIMIT = 3;
export const CTF_TEAM_BLUE = 2;
export const CTF_TEAM_RED = 1;
export const CTF_TEAM_UNDEFINED = 0;
export const CTF_TEAM_OBSERVER = -1; // use this for observing both teams
export const CTF_TEAM_OBSERVER_BLUE = -2;
export const CTF_TEAM_OBSERVER_RED = -3;
export const CTF_TEAM_MIN_LIMIT = -4;
export const CTF_TEAM_IGNORETEAM = -4;
export const CTF_TEAM_ANYTEAM = -5;
export const CTF_TEAM_OPPOSING = -6;
export const CTF_TEAM_MATCHING = -7;

/*
=================
ctf_validateplayer (lmctf60/g_ctffunc.c:75)

`ctf_validateplayer` gates every player-lookup helper in this file (and the
hook's own touch handler). A player is valid if the edict is non-null, has
a client, is in use, is connected, and classnames as "player"; in
singleplayer (`!deathmatch->value`) that alone is sufficient (bug-for-bug:
team membership is never consulted outside deathmatch, matching the C
source's early `return true`). In deathmatch, CTF_TEAM_IGNORETEAM always
passes, CTF_TEAM_ANYTEAM requires a defined team
(CTF_TEAM_UNDEFINED < teamnum < CTF_TEAM_LIMIT), and any other
`teamnum_wanted` requires an exact match against ent.client.ctf.teamnum.
=================
*/
export function ctf_validateplayer(ent: EdictT | null, teamnum_wanted: number): boolean {
  if (ent === null) return false;
  if (ent.client === null || !ent.inuse || !ent.client.pers.connected || ent.classname !== "player") {
    return false;
  }
  if (!(gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0)) {
    // surt, trying to catch stuff that breaks in single player
    return true;
  }
  if (teamnum_wanted === CTF_TEAM_IGNORETEAM) {
    return true; // this object was a player, regardless of team
  }
  if (teamnum_wanted === CTF_TEAM_ANYTEAM) {
    return ent.client.ctf.teamnum > CTF_TEAM_UNDEFINED && ent.client.ctf.teamnum < CTF_TEAM_LIMIT;
  }
  return teamnum_wanted === ent.client.ctf.teamnum;
}

/*
=================
ctf_findplayer (lmctf60/g_ctffunc.c:9)

Walks g_edicts[1 .. game.maxclients] (the fixed client slot range), not a
G_Find/classname search -- the C source's commented-out G_Find version is
preserved as dead code in the original and is not reproduced here (a
comment, not a branch, so nothing is "dropped" per PORTING.md's #ifdef
convention; it never compiled either way). `ent_after` resumes the search
one slot past the given entity; `ignore` skips one specific candidate.
=================
*/
export function ctf_findplayer(
  ent_after: EdictT | null,
  ignore: EdictT | null,
  teamnum_wanted: number,
): EdictT | null {
  let index = ent_after === null ? 1 : g_edicts.indexOf(ent_after) + 1;
  if (ent_after !== null && index === 0) {
    // ent_after wasn't found in g_edicts at all -- mirrors the C pointer
    // arithmetic's undefined behavior only in the sense that there is no
    // sane resumption point; throwing here is strictly more informative
    // than silently scanning from a garbage offset.
    throw new Error("ctf_findplayer: ent_after is not a live g_edicts entry");
  }
  while (index < 1 + game.maxclients) {
    const temp = g_edicts[index];
    if (temp !== undefined && ctf_validateplayer(temp, CTF_TEAM_IGNORETEAM)) {
      if (temp !== ignore) {
        if (teamnum_wanted === CTF_TEAM_IGNORETEAM) {
          return temp;
        } else if (teamnum_wanted === CTF_TEAM_ANYTEAM) {
          if (temp.client !== null && temp.client.ctf.teamnum > CTF_TEAM_UNDEFINED) return temp;
        } else if (temp.client !== null && temp.client.ctf.teamnum === teamnum_wanted) {
          return temp;
        }
      }
    }
    index++;
  }
  return null; // didn't find anything to return before here.
}

/*
=================
ctf_SafePrint (lmctf60/g_ctffunc.c:1479) -- QUEUEING HALF ONLY

Only the `buf !== null` branch (queue a message onto
ent.client.ctf.printdata[print_priority]) is ported. The `buf === null`
flush branch (dequeue up to the next newline and gi.cprintf it, called once
per server frame from code outside this unit's SCOPE) is NOT ported --
`ctf.printready` is still set so a future p_view.ts port has a correct
starting flag, but nothing currently drains the queue. Every call site this
unit's SCOPE actually needs (Cmd_Hook_f's "You have no hook.") always
passes a real buf, so this is sufficient for the hook feature.
=================
*/
export function ctf_SafePrint(ent: EdictT, print_priority: number, buf: string | null): void {
  if (!ctf_validateplayer(ent, CTF_TEAM_IGNORETEAM)) return;
  if (ent.client === null) return;
  if (print_priority < PRINT_LOW || print_priority > PRINT_CHAT) return;

  if (buf !== null) {
    ent.client.ctf.printready = true;
    const existing = ent.client.ctf.printdata[print_priority] ?? "";
    if (existing.length < MAX_INFO_STRING * 16 - 2048) {
      ent.client.ctf.printdata[print_priority] = (existing + buf).slice(0, existing.length + 2000);
    }
  }
  // flush branch intentionally not ported -- see doc comment above.
}

/*
=================
ctf_hook_abort (lmctf60/g_ctffunc.c:1117)

Cancels the grapple hook: zeroes fall-preventing velocity if grounded,
forces the weapon back to WEAPON_READY if the grapple happens to be the
current weapon and mid-fire, resets hookstate/hooklength to 0, and frees
the live hook bolt entity (unhooking its think/nextthink first so a
still-in-flight bolt does not fire one more think after being freed).

Bug-for-bug note (lmctf60 source comment, preserved): the C source has its
own comment flagging that `hookstate = 0` used to be written with `==`
(a no-op comparison instead of an assignment) -- already fixed upstream in
this source snapshot, so there is nothing to preserve here, just citing
the comment since it explains why this line looks unremarkable.
=================
*/
/*
=================
ctf_BSafePrint (lmctf60/g_ctffunc.c:1526)

Broadcasts `buf` to every valid player via ctf_SafePrint (queueing half
only, see that function's own doc comment) plus an unconditional
gi.dprintf(buf) to the server console -- the C source's own commented-out
`ctf_SafePrint(ent, ...)` loop-by-index (lines above the real
ctf_findplayer loop below) is dead code, not reproduced, same rationale as
ctf_findplayer's own dead G_Find comment.
=================
*/
export function ctf_BSafePrint(print_priority: number, buf: string): void {
  gi.dprintf(buf);

  let ent = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (ent !== null) {
    ctf_SafePrint(ent, print_priority, buf);
    ent = ctf_findplayer(ent, null, CTF_TEAM_IGNORETEAM);
  }
}

/*
=================
ctf_resetflagandplayer (lmctf60/g_ctffunc.c:334)

NOT PORTED: resets a flag to its home position and (optionally) strips the
flag from whichplayer's inventory/HUD state -- a substantial function
(carrier bookkeeping, HUD updates, team broadcast) genuinely out of this
unit's SCOPE (g_ctffunc.ts's own file header already documents "flag
home/reset/spawn/touch" as NOT ported). Thrown with citation so
ctf_flagwave's auto-return branch below fails loudly instead of silently
no-opping when it's actually reached.
=================
*/
function ctf_resetflagandplayer(whichflag: EdictT, whichplayer: EdictT | null): boolean {
  throw new Error(
    "ctf_resetflagandplayer (lmctf60/g_ctffunc.c:334) is not ported -- flag home/reset is out of this unit's SCOPE, see this file's header",
  );
}

/*
=================
ctf_flagwave (lmctf60/g_ctffunc.c:605) -- flag animation think function.

Cycles the flag's wave-animation frame every FRAMETIME while solid (dropped
flags stop animating once picked back up and made SOLID_NOT by whatever
picks them up), and auto-returns a flag that has sat dropped for 30+
seconds with no valid carrier. The auto-return branch's actual reset
(ctf_resetflagandplayer) is not ported -- see that function's own doc
comment; ctf_flagwave still faithfully evaluates the guard condition and
plays the correct team's return sound before hitting that throw, so a test
asserting "an old dropped flag with no carrier tries to auto-return"
observes the exact right behavior up to the documented gap.
=================
*/
export function ctf_flagwave(ent: EdictT): void {
  if (ent.solid !== SolidT.SOLID_NOT) {
    ent.s.frame = 173 + (((ent.s.frame - 173) + 1) % 16);
  }
  ent.nextthink = level.time + FRAMETIME;

  if (ent.droptime && level.time > ent.droptime + 30) {
    if (!ctf_validateplayer(ent.owner, CTF_TEAM_ANYTEAM)) {
      if (ent === redflag) {
        gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/r_returned.wav"), 0.8, ATTN_NONE, 0);
      } else if (ent === blueflag) {
        gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/b_returned.wav"), 0.8, ATTN_NONE, 0);
      }
      ctf_resetflagandplayer(ent, null);
    }
  }
}

/*
=================
ctf_flagtouch (lmctf60/g_ctffunc.c:700) / ctf_playerdropflag
(lmctf60/g_ctffunc.c:650)

NOT PORTED: the flag capture/pickup/drop chain (team validation, carrier
assignment, capture scoring, HUD/team broadcast). Both are substantial
functions squarely in the "flag home/reset/spawn/touch" territory this
file's header already documents as out of SCOPE. Thrown with citation --
wired as the "flag" GItemT's pickup/use/drop callbacks in g_items.ts, so a
flag entity spawns and animates correctly (via ctf_flagwave above) and only
throws when something actually touches/uses/drops it, matching this unit's
established "spawn succeeds, only the unreached behavior throws" pattern
(see g_target.ts's use_target_blaster).
=================
*/
export function ctf_flagtouch(ent: EdictT, other: EdictT): boolean {
  throw new Error("ctf_flagtouch (lmctf60/g_ctffunc.c:700) is not ported -- flag capture chain is out of this unit's SCOPE");
}

export function ctf_playerdropflag(whichplayer: EdictT, item: GItemT): void {
  throw new Error(
    "ctf_playerdropflag (lmctf60/g_ctffunc.c:650) is not ported -- flag capture chain is out of this unit's SCOPE",
  );
}

/*
=================
ctf_teamstring (lmctf60/g_ctffunc.c:144) -- byte-identical branching to the
C source. C mutates `buf` in place via strcat; this port appends to and
returns a new string instead (JS strings are immutable), matching
PORTING.md's "mutate a char* in place -> return the new string" idiom.
=================
*/
export function ctf_teamstring(buf: string, teamnum: number, teamnum_option: number): { text: string; ok: boolean } {
  if (teamnum_option === CTF_TEAM_OPPOSING) {
    if (teamnum === CTF_TEAM_RED) return { text: buf + "blue", ok: true };
    if (teamnum === CTF_TEAM_BLUE) return { text: buf + "red", ok: true };
    if (teamnum === CTF_TEAM_OBSERVER_RED) return { text: buf + "observer blue", ok: true };
    if (teamnum === CTF_TEAM_OBSERVER_BLUE) return { text: buf + "observer red", ok: true };
    if (teamnum === CTF_TEAM_OBSERVER) return { text: buf + "observer", ok: true };
    return { text: buf + "unknown", ok: false };
  }

  if (teamnum === CTF_TEAM_RED) return { text: buf + "red", ok: true };
  if (teamnum === CTF_TEAM_BLUE) return { text: buf + "blue", ok: true };
  if (teamnum === CTF_TEAM_OBSERVER) return { text: buf + "observer", ok: true };
  if (teamnum === CTF_TEAM_OBSERVER_RED) return { text: buf + "observer red", ok: true };
  if (teamnum === CTF_TEAM_OBSERVER_BLUE) return { text: buf + "observer blue", ok: true };
  if (teamnum === CTF_TEAM_UNDEFINED) return { text: buf + "undefined", ok: false };
  return { text: buf + "unknown", ok: false };
}

/*
=================
ctf_SetEntTeamEx / ctf_SetEntTeam (lmctf60/g_ctffunc.c:1354/1362)

Assigns ent.client.ctf.teamnum, clamping out-of-range values to
CTF_TEAM_UNDEFINED exactly like the C source's bounds check
(`whatteam >= CTF_TEAM_LIMIT || whatteam <= CTF_TEAM_MIN_LIMIT`), mirrors
the team assignment into p_stats_player.info.teamnum if a stats record is
attached, and broadcasts "X is now on the Y team." via ctf_BSafePrint.

NOT reproduced: sl_LogPlayerTeamChange (StdLog -- unit B's
gslog.ts/stdlog.ts, not this unit's SCOPE) and the commented-out
score-penalty block (the C source itself has this entire branch commented
out -- "Let them keep their score all the time" -- so nothing is dropped
here that the original still runs).
=================
*/
export function ctf_SetEntTeamEx(ent: EdictT, whatteam: number, nopenalty: number): void {
  let team = whatteam;
  if (team >= CTF_TEAM_LIMIT || team <= CTF_TEAM_MIN_LIMIT) team = CTF_TEAM_UNDEFINED;

  if (ent.client === null) return;
  ent.client.ctf.teamnum = team;

  if (ent.client.p_stats_player !== null) {
    ent.client.p_stats_player.info.teamnum = team;
  }

  if (!ent.inuse) return; // can't use ctf_validateplayer -- classname isn't "player" yet at this call site

  const { text } = ctf_teamstring("", ent.client.ctf.teamnum, CTF_TEAM_MATCHING);
  ctf_BSafePrint(PRINT_HIGH, `${ent.client.pers.netname} is now on the ${text} team.\n`);
}

export function ctf_SetEntTeam(ent: EdictT, whatteam: number): void {
  ctf_SetEntTeamEx(ent, whatteam, 0);
}

export function ctf_hook_abort(ent: EdictT | null): void {
  if (ent === null || ent.client === null) return;
  const client = ent.client;

  // If we are on the ground, don't take falling damage
  if (ent.groundentity !== null) {
    client.oldvelocity[2] = 0;
    ent.velocity[2] = 0;
  }

  if (
    client.pers.weapon !== null &&
    client.pers.weapon.pickup_name === "Grappling Hook" &&
    client.weaponstate === 3 // WeaponstateT.WEAPON_FIRING
  ) {
    // Only stop firing grapple
    client.weaponstate = 0; // WeaponstateT.WEAPON_READY
  }
  client.hookstate = 0; // Surt: this used to be ==, obviously broken
  client.hooklength = 0;
  if (client.hook !== null) {
    client.hook.think = null;
    client.hook.nextthink = 0;
    client.hook.hook_target = null;
    G_FreeEdict(client.hook);
    client.hook = null;
  }
}
