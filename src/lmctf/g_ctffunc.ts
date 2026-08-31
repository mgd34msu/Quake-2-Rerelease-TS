// Ports lmctf60/g_ctffunc.c -- LM_CTF's team/flag/player-lookup helper
// library (1564 lines total; wholly new, no CTF-mod ancestor -- the
// vanilla `ctf/g_ctf.c` this game family already ported at src/ctf/g_ctf.ts
// has no equivalent module, LM_CTF's team plumbing is a full rewrite).
//
// STATUS: the flag capture/pickup/drop/reset/spawn chain is now fully
// ported (ctf_flagtouch, ctf_playerdropflag, ctf_resetflagandplayer,
// ctf_ResetFlagProps, ctf_spawnflag, ctf_flagsearch, ctf_findflagposition,
// ctf_deletespawnpointsnearflag, ctf_TossEnt, Drop_Flag_Think,
// ctf_getteamflag, ctf_flagathome, ctf_flagatposition, ctf_validateflags),
// alongside the offhand-hook priority feature's earlier pass
// (ctf_findplayer, ctf_validateplayer, ctf_SafePrint's queueing half,
// ctf_hook_abort, ctf_teamstring, ctf_SetEntTeamEx/ctf_SetEntTeam,
// ctf_flagwave, ctf_BSafePrint). ctf_ChangeMap (g_ctffunc.c:1548) is now
// ported too, now that g_tourney.ts's KillMatch/SetMatchState exist (both
// resolved via a lazy require -- see ctf_ChangeMap's own doc comment).
// The replace_* text-macro helpers live in g_replace.c per g_ctffunc.h's
// own comment, not here, and are g_replace.ts's own SCOPE.

import {
  ATTN_NONE,
  ATTN_NORM,
  CHAN_AUTO,
  CONTENTS_SOLID,
  EF_COLOR_SHELL,
  EF_FLAG1,
  EF_FLAG2,
  MASK_SOLID,
  MAX_INFO_STRING,
  MulticastT,
  PRINT_CHAT,
  PRINT_HIGH,
  PRINT_LOW,
  RF_SHELL_BLUE,
  RF_SHELL_RED,
  TempEventT,
} from "../shared/q_shared";
import { AngleVectors, vec3, type Vec3, VectorAdd, VectorClear, VectorCopy, VectorLength, VectorScale, VectorSet, VectorSubtract } from "../shared/math";
import {
  blueflag,
  CHAN_CTF,
  CTF_EXTRAFLAGS_REFEREE,
  CTF_FLAGS_NOFLAGS,
  CTF_SCORE_BALANCE,
  DamageT,
  type EdictT,
  FL_RESPAWN,
  FRAMETIME,
  g_edicts,
  game,
  gameCvars,
  gi,
  type GItemT,
  level,
  MovetypeT,
  redflag,
  SetBlueFlag,
  SetRedFlag,
  svc_temp_entity,
} from "./g_local";
import { SolidT } from "./game";
import { drop_temp_touch, ITEM_INDEX, Touch_Item } from "./g_items";
import { G_FreeEdict, G_Find, G_ProjectSource, G_Spawn, Team_cprint, tv } from "./g_utils";
import { sl_LogScore } from "./stdlog";
import { matchstate, MatchStatesT } from "./g_tourney";

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

// lmctf60/g_ctffunc.h:34-35
export const CTF_CAPTURE_BONUS_CARRIER = 5;
export const CTF_CAPTURE_BONUS_TEAM = 10;

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
ctf_flagatposition (lmctf60/g_ctffunc.c:103) / ctf_flagathome
(lmctf60/g_ctffunc.c:116) -- byte-identical to the C source.
=================
*/
export function ctf_flagatposition(a: Vec3, b: Vec3): boolean {
  const dir = vec3();
  VectorSubtract(a, b, dir);
  return VectorLength(dir) <= 32;
}

export function ctf_flagathome(whichflag: EdictT | null): boolean {
  if (whichflag !== null && whichflag.classname === "flag") {
    return ctf_flagatposition(whichflag.homeposition, whichflag.s.origin);
  }
  return false;
}

/*
=================
ctf_getteamflag (lmctf60/g_ctffunc.c:125) -- byte-identical to the C
source ("very broken for multiteam", the C source's own comment,
preserved: only CTF_TEAM_RED/CTF_TEAM_BLUE are ever recognized).
=================
*/
export function ctf_getteamflag(teamnum: number, teamnum_option: number): EdictT | null {
  if (teamnum_option === CTF_TEAM_OPPOSING) {
    if (teamnum === CTF_TEAM_RED) return blueflag;
    if (teamnum === CTF_TEAM_BLUE) return redflag;
    return null;
  }
  if (teamnum === CTF_TEAM_RED) return redflag;
  if (teamnum === CTF_TEAM_BLUE) return blueflag;
  return null;
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

// lmctf60/g_ctffunc.h:53-67 -- spam-control tuning constants. CTF_SPAM_BAND_MAX/
// CTF_SPAM_FREQ_MIN are also each client's ClientConnect reset values
// (p_client.ts) -- kept as duplicated literals there (not imported) for the
// same reason RUNE_REGEN is duplicated in g_items.ts (a single
// never-changing #define, size/risk tradeoff documented there).
export const CTF_SPAM_BAND_MAX = 450;
export const CTF_SPAM_BAND_RADIO = 150;
export const CTF_SPAM_BAND_VOICE = 75;
export const CTF_SPAM_BAND_SAY = 60;
const CTF_SPAM_BAND_WARN_LEVEL = 90;
const CTF_SPAM_LOCKOUT_TIME = 5;
const CTF_SPAM_FREQ_MAX_ALLOWED = 50;
const CTF_SPAM_FREQ_EXTRA_PENALTY_TIME = 0.25;
const CTF_SPAM_FREQ_EXTRA_PENALTY = 20;
const CTF_SPAM_FREQ_BAND_EXTRA_PENALTY_LEVEL = 190;
const CTF_SPAM_FREQ_BAND_EXTRA_PENALTY = 5;

/*
=================
ctf_SpamCheck (lmctf60/g_ctffunc.c:1288) -- byte-identical to the C
source. Referees always pass. Otherwise gates on remaining "bandwidth"
(spam_band_count), request frequency (spam_freq_count), and a short
lockout window (spam_lock_time) -- printing a spam-control message and
starting the lockout timer on failure, a bandwidth warning near the
threshold on success. The frequency-penalty accrual at the bottom runs
unconditionally (pass or fail), exactly like the C source.
=================
*/
export function ctf_SpamCheck(ent: EdictT): boolean {
  if (ent.client === null) return false;
  const client = ent.client;
  let result = false;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0) {
    result = true;
  } else if (
    client.spam_band_count <= 0 || // no bandwidth available
    client.spam_freq_count > CTF_SPAM_FREQ_MAX_ALLOWED || // no frequency available
    level.time - client.spam_lock_time < CTF_SPAM_LOCKOUT_TIME // already in penalty box
  ) {
    ctf_SafePrint(ent, PRINT_HIGH, "That action has been blocked by spam control.\n");
    client.spam_lock_time = level.time; // you triggered spam lock
  } else {
    result = true;

    // here we have a player who has done too many long says, or some such
    if (client.spam_band_count < CTF_SPAM_BAND_WARN_LEVEL) {
      ctf_SafePrint(ent, PRINT_HIGH, "Warning: Approaching spam bandwidth limits.\n");
    }
  }

  // here we have a player who has done a few actions in a short time
  if (client.spam_freq_time - level.time < CTF_SPAM_FREQ_EXTRA_PENALTY_TIME) {
    client.spam_freq_count += CTF_SPAM_FREQ_EXTRA_PENALTY;
    if (client.spam_band_count < CTF_SPAM_FREQ_BAND_EXTRA_PENALTY_LEVEL) {
      // compound penalty for bandwidth
      client.spam_freq_count += CTF_SPAM_FREQ_BAND_EXTRA_PENALTY;
    }
  }

  client.spam_freq_time = level.time; // see test of this above

  return result;
}

// ---------------------------------------------------------------------
// Cross-dependencies resolved via lazy require, not a static import, to
// avoid closing a value cycle: p_stats.ts and g_cmds.ts both already
// statically import from this file (ctf_SafePrint/CTF_TEAM_MATCHING/
// CTF_TEAM_UNDEFINED; ctf_SafePrint/ctf_hook_abort), and g_spawn.ts is
// reached indirectly (g_spawn.ts -> p_client.ts -> this file, all static).
// sl_LogScore (stdlog.ts) has no such cycle and is imported for real,
// directly, below.
// ---------------------------------------------------------------------
function statsModule(): typeof import("./p_stats") {
  return require("./p_stats") as typeof import("./p_stats");
}
function cmdsModule(): typeof import("./g_cmds") {
  return require("./g_cmds") as typeof import("./g_cmds");
}
function spawnModule(): typeof import("./g_spawn") {
  return require("./g_spawn") as typeof import("./g_spawn");
}

// lmctf60/q_shared.h -- `refset` cvar bits (not `ctfflags` bits, which
// g_local.ts already exports for real). Not exported anywhere else in
// this tree yet (g_menu.ts's own header carries the same two values as a
// local stand-in for the same reason).
const CTF_RED_FLAG_FROZEN = 1;
const CTF_BLUE_FLAG_FROZEN = 2;

/*
=================
ctf_validateflags (lmctf60/g_ctffunc.c:229) -- byte-identical to the C
source. Repairs/creates redflag/blueflag if either is missing or invalid,
then strips the flag from any invalid holder's inventory.
=================
*/
export function ctf_validateflags(): boolean {
  const deathmatch = gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0;
  const ctfflagsVal = gameCvars.ctfflags === null ? 0 : gameCvars.ctfflags.value;
  if (!deathmatch || (ctfflagsVal & CTF_FLAGS_NOFLAGS) !== 0) return true;

  if (redflag === null || redflag.classname !== "flag" || redflag.item === null || redflag.flagteam !== CTF_TEAM_RED) {
    SetRedFlag(ctf_flagsearch(CTF_TEAM_RED));
    if (redflag === null) ctf_spawnflag(CTF_TEAM_RED);
  }

  if (blueflag === null || blueflag.classname !== "flag" || blueflag.item === null || blueflag.flagteam !== CTF_TEAM_BLUE) {
    SetBlueFlag(ctf_flagsearch(CTF_TEAM_BLUE));
    if (blueflag === null) ctf_spawnflag(CTF_TEAM_BLUE);
  }

  let tmp_player = G_Find(null, "classname", "player");
  while (tmp_player !== null) {
    let teamcount = CTF_TEAM_UNDEFINED + 1;
    while (teamcount < CTF_TEAM_LIMIT) {
      const tmp_flag = ctf_getteamflag(teamcount, CTF_TEAM_MATCHING);
      if (tmp_player.client !== null && tmp_flag !== null && tmp_flag.item !== null && tmp_player.client.pers.inventory[ITEM_INDEX(tmp_flag.item)] !== 0) {
        if (!ctf_validateplayer(tmp_player, CTF_TEAM_ANYTEAM)) {
          ctf_resetflagandplayer(tmp_flag, tmp_player);
        }
      }
      teamcount++;
    }
    tmp_player = G_Find(tmp_player, "classname", "player");
  }

  if (redflag !== null) gi.linkentity(redflag);
  else gi.dprintf("Error, red flag missing, please report this.\n");
  if (blueflag !== null) gi.linkentity(blueflag);
  else gi.dprintf("Error, blue flag missing, please report this.\n");

  return true;
}

/*
=================
ctf_flagsearch (lmctf60/g_ctffunc.c:297) -- byte-identical to the C
source. Scans every "flag" entity for one matching `whichteam`; frees any
flag with no item, an invalid flagteam, or a second flag for a team
already found (keeping the first).
=================
*/
export function ctf_flagsearch(whichteam: number): EdictT | null {
  let valid_flag: EdictT | null = null;
  let current_flag = G_Find(null, "classname", "flag");
  while (current_flag !== null) {
    if (current_flag.item === null) {
      G_FreeEdict(current_flag);
    } else if (current_flag.flagteam >= CTF_TEAM_LIMIT || current_flag.flagteam <= CTF_TEAM_UNDEFINED) {
      G_FreeEdict(current_flag);
    } else if (current_flag.flagteam === whichteam) {
      if (valid_flag !== null) {
        ctf_resetflagandplayer(current_flag, current_flag.owner);
        ctf_resetflagandplayer(valid_flag, valid_flag.owner);
        G_FreeEdict(current_flag);
      } else {
        valid_flag = current_flag;
      }
    }
    current_flag = G_Find(current_flag, "classname", "flag");
  }
  return valid_flag;
}

/*
=================
ctf_resetflagandplayer (lmctf60/g_ctffunc.c:334) -- byte-identical to the
C source.
=================
*/
export function ctf_resetflagandplayer(whichflag: EdictT | null, whichplayer: EdictT | null): boolean {
  if (whichflag !== null) {
    VectorCopy(whichflag.homeposition, whichflag.s.origin);
    VectorCopy(whichflag.homeangles, whichflag.s.angles);
    ctf_ResetFlagProps(whichflag);
  }
  if (whichplayer !== null) {
    whichplayer.s.effects &= ~EF_COLOR_SHELL;
    cmdsModule().ValidateSelectedItem(whichplayer);
    whichplayer.s.modelindex3 = 0;
    if (whichplayer.client !== null) {
      if (redflag !== null && redflag.item !== null) whichplayer.client.pers.inventory[ITEM_INDEX(redflag.item)] = 0;
      if (blueflag !== null && blueflag.item !== null) whichplayer.client.pers.inventory[ITEM_INDEX(blueflag.item)] = 0;
      if (whichflag !== null && whichflag.item !== null) whichplayer.client.pers.inventory[ITEM_INDEX(whichflag.item)] = 0;
      cmdsModule().ValidateSelectedItem(whichplayer);
    }
  }
  return true;
}

/*
=================
ctf_ResetFlagProps (lmctf60/g_ctffunc.c:363) -- byte-identical to the C
source.
=================
*/
export function ctf_ResetFlagProps(whichflag: EdictT): void {
  if (whichflag.owner !== null) {
    whichflag.s.modelindex = whichflag.owner.s.modelindex3;
  }
  if (whichflag.model !== null) {
    gi.setmodel(whichflag, whichflag.model);
  } else if (whichflag.item !== null && whichflag.item.world_model !== null) {
    gi.setmodel(whichflag, whichflag.item.world_model);
  }

  VectorCopy(tv(-15, -15, -15), whichflag.mins);
  VectorCopy(tv(15, 15, 33), whichflag.maxs);

  whichflag.solid = SolidT.SOLID_TRIGGER;
  gi.linkentity(whichflag);

  whichflag.movetype = MovetypeT.MOVETYPE_TOSS;
  whichflag.touch = Touch_Item;
  whichflag.owner = null;
  whichflag.droptime = 0;

  const dest = vec3();
  VectorAdd(whichflag.s.origin, tv(0, 0, -128), dest);

  const tr = gi.trace(whichflag.s.origin, whichflag.mins, whichflag.maxs, dest, whichflag, MASK_SOLID);

  VectorCopy(tr.endpos, whichflag.s.origin);
  VectorClear(whichflag.s.angles);

  // surt, a flag caught moving can land off the pedestal if you don't
  // clear the velocity
  VectorClear(whichflag.velocity);
  whichflag.flags |= FL_RESPAWN;

  whichflag.nextthink = level.time + FRAMETIME;
  whichflag.think = ctf_flagwave;
}

/*
=================
ctf_flagwave (lmctf60/g_ctffunc.c:605) -- flag animation think function.

Cycles the flag's wave-animation frame every FRAMETIME while solid (dropped
flags stop animating once picked back up and made SOLID_NOT by whatever
picks them up), and auto-returns a flag that has sat dropped for 30+
seconds with no valid carrier.
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
ctf_findflagposition (lmctf60/g_ctffunc.c:537) -- byte-identical to the C
source. Picks the info_player_deathmatch/info_flag_red/info_flag_blue spot
farthest from `whichflag`'s current origin; falls back to the first
info_player_deathmatch spot if none of those are farther than 0 units.
=================
*/
export function ctf_findflagposition(whichflag: EdictT): EdictT | null {
  let bestspot: EdictT | null = null;
  let bestdistance = 0;
  const v = vec3();

  let spot = G_Find(null, "classname", "info_player_deathmatch");
  while (spot !== null) {
    VectorSubtract(whichflag.s.origin, spot.s.origin, v);
    const flagdistance = VectorLength(v);
    if (flagdistance > bestdistance) {
      bestspot = spot;
      bestdistance = flagdistance;
    }
    spot = G_Find(spot, "classname", "info_player_deathmatch");
  }

  spot = G_Find(spot, "classname", "info_flag_red");
  if (spot !== null) {
    VectorSubtract(whichflag.s.origin, spot.s.origin, v);
    const flagdistance = VectorLength(v);
    if (flagdistance > bestdistance) {
      bestspot = spot;
      bestdistance = flagdistance;
    }
  }

  spot = G_Find(spot, "classname", "info_flag_blue");
  if (spot !== null) {
    VectorSubtract(whichflag.s.origin, spot.s.origin, v);
    const flagdistance = VectorLength(v);
    if (flagdistance > bestdistance) {
      bestspot = spot;
      bestdistance = flagdistance;
    }
  }

  if (bestspot !== null) return bestspot;

  // if there is a player just spawned on each and every start spot we
  // have no choice to turn one into a telefrag meltdown
  return G_Find(null, "classname", "info_player_deathmatch");
}

/*
=================
ctf_deletespawnpointsnearflag (lmctf60/g_ctffunc.c:1091) -- byte-identical
to the C source.
=================
*/
export function ctf_deletespawnpointsnearflag(flag: EdictT): void {
  if (!(gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0)) return;

  let spot = G_Find(null, "classname", "info_player_deathmatch");
  while (spot !== null) {
    const v = vec3();
    VectorSubtract(spot.s.origin, flag.homeposition, v);
    if (VectorLength(v) <= 256) {
      G_FreeEdict(spot);
    }
    spot = G_Find(spot, "classname", "info_player_deathmatch");
  }
}

/*
=================
ctf_spawnflag (lmctf60/g_ctffunc.c:407) -- byte-identical to the C source.
Creates redflag/blueflag if missing, preferring a map's own
info_flag_red/info_flag_blue marker, then info_player_deathmatch (via
ctf_findflagposition), then info_player_start/target_changelevel as a last
resort; fails (returns false) if none exist.
=================
*/
export function ctf_spawnflag(teamnum: number): boolean {
  if (!(gameCvars.deathmatch !== null && gameCvars.deathmatch.value !== 0)) return false;

  const ctfflagsVal = gameCvars.ctfflags === null ? 0 : gameCvars.ctfflags.value;
  if ((ctfflagsVal & CTF_FLAGS_NOFLAGS) !== 0) return false;

  let ent: EdictT | null = null;

  if (teamnum === CTF_TEAM_RED && redflag === null) {
    let spot = G_Find(null, "classname", "info_flag_red");
    if (spot === null) {
      spot = G_Find(null, "classname", "info_player_deathmatch");
      if (spot !== null) spot = ctf_findflagposition(spot);
      if (spot === null) spot = G_Find(null, "classname", "info_player_start");

      if (spot !== null) {
        spot.classname = "info_flag_red";
        spot.s.effects |= EF_COLOR_SHELL;
        spot.s.renderfx |= RF_SHELL_RED;
      } else {
        return false;
      }
    }

    ent = G_Spawn();
    ent.classname = spawnModule().ED_NewString("flag");
    spawnModule().ED_CallSpawn(ent);

    ent.model = "players/male/flag1.md2";

    VectorCopy(spot.s.origin, ent.s.origin);
    VectorCopy(spot.s.origin, ent.homeposition);
    VectorCopy(spot.s.angles, ent.s.angles);
    VectorCopy(spot.s.angles, ent.homeangles);
    ent.s.effects = EF_FLAG1;
    ent.s.frame = gameCvars.flag_init !== null && gameCvars.flag_init.value !== 0 ? 173 : 0;
    SetRedFlag(ent);
  } else if (teamnum === CTF_TEAM_BLUE && blueflag === null) {
    let spot = G_Find(null, "classname", "info_flag_blue");
    if (spot === null) {
      spot = G_Find(null, "classname", "info_player_deathmatch");
      if (spot !== null) {
        spot = ctf_findflagposition(spot);
        if (spot !== null) spot = ctf_findflagposition(spot);
      }
      if (spot === null) spot = G_Find(null, "classname", "target_changelevel");

      if (spot !== null) {
        spot.classname = "info_flag_blue";
        spot.s.effects |= EF_COLOR_SHELL;
        spot.s.renderfx |= RF_SHELL_BLUE;
      } else {
        return false;
      }
    }

    ent = G_Spawn();
    ent.classname = spawnModule().ED_NewString("flag");
    spawnModule().ED_CallSpawn(ent);

    ent.model = "players/male/flag2.md2";

    VectorCopy(spot.s.origin, ent.s.origin);
    VectorCopy(spot.s.origin, ent.homeposition);
    VectorCopy(spot.s.angles, ent.s.angles);
    VectorCopy(spot.s.angles, ent.homeangles);
    ent.s.effects = EF_FLAG2;
    ent.s.frame = gameCvars.flag_init !== null && gameCvars.flag_init.value !== 0 ? 173 : 0;
    SetBlueFlag(ent);
  }

  if (ent !== null) {
    ent.flagteam = teamnum;
    if (ent.model !== null) gi.setmodel(ent, ent.model);
    ent.takedamage = DamageT.DAMAGE_NO;
    ent.dontfree = 1;
    ctf_resetflagandplayer(ent, null);
    ent.solid = SolidT.SOLID_TRIGGER;
    gi.linkentity(ent);
    ent.movetype = MovetypeT.MOVETYPE_TOSS;
    ctf_ResetFlagProps(ent);
    ctf_deletespawnpointsnearflag(ent);
  }
  return true;
}

/*
=================
ctf_TossEnt (lmctf60/g_ctffunc.c:624) -- byte-identical to the C source.
=================
*/
export function ctf_TossEnt(startent: EdictT, tossent: EdictT): void {
  if (startent.client === null) {
    throw new Error("ctf_TossEnt: startent.client is null (C dereferences it unconditionally here)");
  }
  const forward = vec3();
  const right = vec3();
  const offset = vec3();

  AngleVectors(startent.client.v_angle, forward, right, null);
  VectorSet(offset, 24, 0, -16);
  G_ProjectSource(startent.s.origin, offset, forward, right, tossent.s.origin);
  const tr = gi.trace(startent.s.origin, tossent.mins, tossent.maxs, tossent.s.origin, startent, CONTENTS_SOLID);
  VectorCopy(tr.endpos, tossent.s.origin);

  VectorScale(forward, 200, tossent.velocity);
  tossent.velocity[2] = 300;
}

/*
=================
Drop_Flag_Think (lmctf60/g_ctffunc.c:640) -- byte-identical to the C
source.
=================
*/
export function Drop_Flag_Think(ent: EdictT): void {
  ent.touch = Touch_Item;
  ent.owner = null;
  ent.think = ctf_flagwave;
  ent.nextthink = level.time + FRAMETIME;
}

/*
=================
ctf_playerdropflag (lmctf60/g_ctffunc.c:650) -- byte-identical to the C
source. "this function doesn't use validate player because it should
always succeed even for players that are not inuse" (C source's own
comment, preserved).
=================
*/
export function ctf_playerdropflag(whichplayer: EdictT | null, _item: GItemT): void {
  if (whichplayer === null || whichplayer.client === null) return;

  const whichflag = ctf_getteamflag(whichplayer.client.ctf.teamnum, CTF_TEAM_OPPOSING);
  ctf_resetflagandplayer(whichflag, whichplayer);
  if (whichflag !== null) {
    ctf_ResetFlagProps(whichflag);
    whichflag.owner = whichplayer;
    whichflag.touch = drop_temp_touch;
    whichflag.think = Drop_Flag_Think;
    whichflag.nextthink = level.time + 1;

    ctf_TossEnt(whichplayer, whichflag);

    const flagcolor = ctf_teamstring("", whichplayer.client.ctf.teamnum, CTF_TEAM_OPPOSING).text;
    const message = `${whichplayer.client.pers.netname} lost the ${flagcolor} flag.\n`;

    statsModule().stats_add(whichplayer, statsModule().STATS_OFFENSE_FLAGLOST, 1); // STATS - LM_Hati

    // STDLog Flag Carrier Frag - Surt
    sl_LogScore(whichplayer.client.pers.netname, null, "FC LostFlag", null, 0, level.time);
    ctf_BSafePrint(PRINT_HIGH, message);

    whichflag.droptime = level.time;
    gi.linkentity(whichflag);
  }
}

/*
=================
ctf_flagtouch (lmctf60/g_ctffunc.c:700) -- byte-identical to the C source
(the flag capture/pickup/drop chain: team validation, carrier assignment,
capture scoring with assist bonuses, team-balance capture-score bonus,
HUD/team broadcast).

`last_flagtktime` (C `static float`, function-local persistent state)
becomes module-level state here, same persistence semantics.
=================
*/
let last_flagtktime = 0;

export function ctf_flagtouch(ent: EdictT, other: EdictT): boolean {
  ctf_validateflags(); // make sure nothing is weird

  // Make sure it will respawn
  ent.flags |= FL_RESPAWN;

  if (matchstate >= MatchStatesT.MATCH_RAILGUN_COUNTDOWN) return false;

  if (!ctf_validateplayer(other, CTF_TEAM_ANYTEAM)) return false; // only active players may touch flag
  if (other.client === null) return false;

  const flagcolorMatching = ctf_teamstring("", ent.flagteam, CTF_TEAM_MATCHING).text;

  // If it is your flag...
  if (other.client.ctf.teamnum === ent.flagteam) {
    if (ctf_flagathome(ent)) {
      // Do we have the enemy flag?
      if (ent.item !== null && other.client.pers.inventory[ITEM_INDEX(ent.item)] !== 0) {
        const otherflag = ctf_getteamflag(other.client.ctf.teamnum, CTF_TEAM_OPPOSING);

        const flagcolorOpposing = ctf_teamstring("", ent.flagteam, CTF_TEAM_OPPOSING).text;

        const message = `${other.client.pers.netname} captured your flag!\n`;
        const elsemessage = `${other.client.pers.netname} captured the ${flagcolorOpposing} flag.\n`;

        if (otherflag !== null) Team_cprint(otherflag.flagteam, message, elsemessage);

        // Award Assists for captures
        let assister = ctf_findplayer(null, null, other.client.ctf.teamnum); // LM_Hati NULL second argument allows assisting yourself
        while (assister !== null) {
          if (assister.client === null) {
            assister = ctf_findplayer(assister, null, other.client.ctf.teamnum);
            continue;
          }
          const ac = assister.client;
          if (level.time < ac.kill_carrier_time + 6) {
            // surt was 60 ... (this is seconds, not tenths)
            ctf_BSafePrint(PRINT_HIGH, `${ac.pers.netname} assisted the capture by killing the flag carrier.\n`);
            statsModule().stats_add(assister, statsModule().STATS_SCORE, 1);
            ac.resp.score += 1;
            ac.kill_carrier_time = 0;
            statsModule().stats_add(assister, statsModule().STATS_ASSISTS, 1); // STATS - LM_Hati
            sl_LogScore(ac.pers.netname, null, "FC Frag Assist", null, 1, level.time);
          }
          if (level.time < ac.return_flag_time + 3) {
            ctf_BSafePrint(PRINT_HIGH, `${ac.pers.netname} assisted the capture by returning the flag.\n`);
            statsModule().stats_add(assister, statsModule().STATS_SCORE, 1);
            ac.resp.score += 1;
            ac.return_flag_time = 0;
            statsModule().stats_add(assister, statsModule().STATS_ASSISTS, 1); // STATS - LM_Hati
            sl_LogScore(ac.pers.netname, null, "F Return Assist", null, 1, level.time);
          }
          if (level.time < ac.defend_flag_time + 2) {
            ctf_BSafePrint(PRINT_HIGH, `${ac.pers.netname} assisted the capture by defending the flag.\n`);
            statsModule().stats_add(assister, statsModule().STATS_SCORE, 1);
            ac.resp.score += 1;
            ac.defend_flag_time = 0;
            statsModule().stats_add(assister, statsModule().STATS_ASSISTS, 1); // STATS - LM_Hati
            sl_LogScore(ac.pers.netname, null, "F Defend Assist", null, 1, level.time);
          }

          assister = ctf_findplayer(assister, null, other.client.ctf.teamnum);
        }

        const skinsetVal = gameCvars.skinset === null ? 0 : Math.trunc(gameCvars.skinset.value);
        let sound: string;
        if (other.client.ctf.teamnum === CTF_TEAM_RED) sound = `ctf/redscore${skinsetVal + 1}.wav`;
        else if (other.client.ctf.teamnum === CTF_TEAM_BLUE) sound = `ctf/bluescore${skinsetVal + 1}.wav`;
        else sound = "misc/tele_up";

        gi.sound(ent, CHAN_CTF, gi.soundindex(sound), 1, ATTN_NONE, 0);

        gi.WriteByte(svc_temp_entity);
        gi.WriteByte(TempEventT.TE_BFG_EXPLOSION);
        gi.WritePosition(ent.s.origin);
        gi.multicast(ent.s.origin, MulticastT.MULTICAST_PVS);

        // Add score to team
        statsModule().stats_add(other, statsModule().STATS_SCORE, CTF_CAPTURE_BONUS_CARRIER);
        other.client.resp.score += CTF_CAPTURE_BONUS_CARRIER; // 5 for being the actual capturer
        statsModule().stats_add(other, statsModule().STATS_CAPTURES, 1);
        sl_LogScore(other.client.pers.netname, null, "F Capture", null, CTF_CAPTURE_BONUS_CARRIER, level.time);

        let scorebonus = CTF_CAPTURE_BONUS_TEAM;
        // surt code to give a scoring bonus for a small team capturing vs a large team
        const ctfflagsVal = gameCvars.ctfflags === null ? 0 : gameCvars.ctfflags.value;
        if ((ctfflagsVal & CTF_SCORE_BALANCE) !== 0) {
          let teammate = ctf_findplayer(null, null, CTF_TEAM_ANYTEAM);
          let redcount = 1;
          let bluecount = 1;
          while (teammate !== null) {
            if (teammate.client !== null) {
              if (teammate.client.ctf.teamnum === CTF_TEAM_RED) redcount++;
              else if (teammate.client.ctf.teamnum === CTF_TEAM_BLUE) bluecount++;
            }
            teammate = ctf_findplayer(teammate, null, CTF_TEAM_ANYTEAM);
          }
          if (other.client.ctf.teamnum === CTF_TEAM_RED) {
            scorebonus = Math.trunc((scorebonus * bluecount) / redcount);
          } else if (other.client.ctf.teamnum === CTF_TEAM_BLUE) {
            scorebonus = Math.trunc((scorebonus * redcount) / bluecount);
          }
        }

        let teammate = ctf_findplayer(null, null, other.client.ctf.teamnum);
        while (teammate !== null) {
          if (teammate.client !== null) {
            statsModule().stats_add(teammate, statsModule().STATS_SCORE, scorebonus);
            teammate.client.resp.score += scorebonus;
            sl_LogScore(teammate.client.pers.netname, null, "Team Score", null, scorebonus, level.time);
          }
          teammate = ctf_findplayer(teammate, null, other.client.ctf.teamnum);
        }

        if (otherflag === null) {
          ctf_validateflags();
        } else {
          ctf_resetflagandplayer(otherflag, otherflag.owner);
        }
      }
      return false; // Can't pick up your own flag
    }

    // Return flag to origin
    if (ent.flagteam === CTF_TEAM_RED) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/r_returned.wav"), 0.8, ATTN_NONE, 0);
    } else if (ent.flagteam === CTF_TEAM_BLUE) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/b_returned.wav"), 0.8, ATTN_NONE, 0);
    }

    const message = `${other.client.pers.netname} returned your flag!\n`;
    const elsemessage = `${other.client.pers.netname} returned the ${flagcolorMatching} flag.\n`;

    statsModule().stats_add(other, statsModule().STATS_RETURNS, 1); // STATS - LM_Hati
    statsModule().stats_add(other, statsModule().STATS_SCORE, 1);
    sl_LogScore(other.client.pers.netname, null, "F Return", null, 1, level.time);

    other.client.resp.score += 1;
    other.client.return_flag_time = level.time;

    Team_cprint(other.client.ctf.teamnum, message, elsemessage);

    // Award Assists for returns
    let assister = ctf_findplayer(null, other, other.client.ctf.teamnum);
    while (assister !== null) {
      if (assister.client !== null && level.time < assister.client.kill_carrier_time + 6) {
        // surt was 60 ... (this is seconds, not tenths)
        ctf_BSafePrint(
          PRINT_HIGH,
          `${assister.client.pers.netname} helped ${other.client.pers.netname} return the ${flagcolorMatching} flag.\n`,
        );
        statsModule().stats_add(assister, statsModule().STATS_SCORE, 1);
        sl_LogScore(assister.client.pers.netname, null, "F Return Assist", null, 1, level.time);
        assister.client.resp.score += 1;
        assister.client.kill_carrier_time = 0;
        statsModule().stats_add(assister, statsModule().STATS_ASSISTS, 1); // STATS - LM_Hati
      }
      assister = ctf_findplayer(assister, other, other.client.ctf.teamnum);
    }

    ctf_resetflagandplayer(ent, null);
    return false;
  }

  // Enemy flag
  if (ent.flagteam === CTF_TEAM_RED && ((gameCvars.refset === null ? 0 : gameCvars.refset.value) & CTF_RED_FLAG_FROZEN) !== 0) {
    return false;
  }
  if (ent.flagteam === CTF_TEAM_BLUE && ((gameCvars.refset === null ? 0 : gameCvars.refset.value) & CTF_BLUE_FLAG_FROZEN) !== 0) {
    return false;
  }

  // Give us a glowing shell
  other.s.effects |= EF_COLOR_SHELL;
  if (ent.flagteam === CTF_TEAM_BLUE) other.s.renderfx |= RF_SHELL_RED;
  else if (ent.flagteam === CTF_TEAM_RED) other.s.renderfx |= RF_SHELL_BLUE;

  const message = `${other.client.pers.netname} stole your flag!\n`;
  const elsemessage = `${other.client.pers.netname} stole the ${flagcolorMatching} flag.\n`;

  statsModule().stats_add(other, statsModule().STATS_OFFENSE_FLAG, 1); // STATS - LM_Hati
  sl_LogScore(other.client.pers.netname, null, "F Pickup", null, 0, level.time);

  Team_cprint(ent.flagteam, message, elsemessage);

  if (ctf_flagathome(ent)) {
    gi.sound(ent, CHAN_AUTO, gi.soundindex("ctf/flagtk.wav"), 0.7, ATTN_NORM, 0);
    if (ent.flagteam === CTF_TEAM_RED) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/r_stolen.wav"), 0.8, ATTN_NONE, 0);
    } else if (ent.flagteam === CTF_TEAM_BLUE) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/b_stolen.wav"), 0.8, ATTN_NONE, 0);
    }
  } else if (level.time > last_flagtktime + 8) {
    // surt volume was slightly too loud at 1.0, so always plays when
    // stolen from home base; surt also irritating if dropped/stolen
    // repeatedly -- only plays every 5 seconds (sic, comment says 5, the
    // guard is 8) if not at home base
    last_flagtktime = level.time;
    if (ent.flagteam === CTF_TEAM_RED) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/r_stolen.wav"), 0.8, ATTN_NORM, 0);
    } else if (ent.flagteam === CTF_TEAM_BLUE) {
      gi.sound(ent, CHAN_CTF, gi.soundindex("ctf/b_stolen.wav"), 0.8, ATTN_NORM, 0);
    }
  }

  ent.owner = other;
  ent.flags |= FL_RESPAWN;
  ent.solid = SolidT.SOLID_NOT;
  gi.linkentity(ent);

  ent.nextthink = level.time + FRAMETIME;
  ent.think = ctf_flagwave;

  ent.owner.s.modelindex3 = ent.s.modelindex;
  ent.s.modelindex = 0;

  if (ent.item !== null) other.client.pers.inventory[ITEM_INDEX(ent.item)]++;

  return true;
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

// lmctf60/g_tourney.c's KillMatch -- lazy require, not a static import:
// this file already statically imports matchstate/MatchStatesT from
// g_tourney.ts, so a static import back here would close a value cycle.
// Per PORTING.md's rule, g_tourney.ts (imported first) is not the side
// that breaks it.
function tourneyModule(): typeof import("./g_tourney") {
  return require("./g_tourney") as typeof import("./g_tourney");
}

/*
=================
ctf_ChangeMap (lmctf60/g_ctffunc.c:1548) -- byte-identical to the C
source, now that g_tourney.ts's KillMatch has landed. `matchstate` is
this file's own already-imported live binding (module-level `let` export
from g_tourney.ts); C's `extern int matchstate;` local redeclaration
inside the function is a no-op once real modules replace `extern`.
=================
*/
export function ctf_ChangeMap(mapname: string | null, startmatch: boolean): void {
  const command = `gamemap "${mapname ?? ""}"\n`;
  gi.AddCommandString(command);
  level.changemap = null;
  level.exitintermission = 0;
  level.intermissiontime = 0;
  (require("./p_stats") as typeof import("./p_stats")).stats_cleanup(); // STATS - LM_Hati
  tourneyModule().KillMatch();
  if (startmatch) {
    tourneyModule().SetMatchState(MatchStatesT.MATCH_COUNTDOWN);
  } else {
    tourneyModule().SetMatchState(MatchStatesT.MATCH_NONE);
  }
}
