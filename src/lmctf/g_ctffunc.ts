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

import { MAX_INFO_STRING, PRINT_CHAT, PRINT_LOW } from "../shared/q_shared";
import { type EdictT, g_edicts, game, gameCvars } from "./g_local";
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
