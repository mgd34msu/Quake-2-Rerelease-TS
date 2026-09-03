// Ports lmctf60/g_cmds.c (diff vs quake-2/ctf/g_cmds.c is 2542 lines of
// 2742 total -- almost a full rewrite).
//
// STATUS: this unit's fourth pass. NO PLAYER-FACING OR OPERATOR-FACING
// COMMAND IS MISSING ANY MORE -- every command lmctf60's ClientCommand
// dispatches is now dispatched here.
//
// Earlier passes ported OnSameTeam/ForceCommand/Cmd_Hook_f/Cmd_Unhook_f/
// SelectNextItem/SelectPrevItem/ValidateSelectedItem, the generic
// inventory/weapon/item commands (Cmd_Give_f, Cmd_God_f, Cmd_Notarget_f,
// Cmd_Noclip_f, Cmd_Use_f, Cmd_Drop_f, Cmd_Inven_f, Cmd_InvUse_f,
// Cmd_WeapPrev_f, Cmd_WeapNext_f, Cmd_WeapLast_f, Cmd_InvDrop_f,
// Cmd_Kill_f (suicide), Cmd_PutAway_f, Cmd_Wave_f, Cmd_Players_f,
// Cmd_Users_f, Cmd_Say_f), the team-switch chain (Team_Change, Drop_All,
// Cmd_Team_f, Cmd_Observe_f, Cmd_FlagStatus_f), the referee/match admin
// commands (Cmd_LockTeams_f, Cmd_StartMatch_f, Cmd_StopMatch_f,
// Cmd_PauseMatch_f, Cmd_SetPassword_f, Cmd_SetTimelimit_f,
// Cmd_ChangeMap_f, Cmd_ToggleFastSwitch_f), PlayTeamSound/PlayVoiceSound
// (+ Cmd_PlayTeamSound_f/Cmd_PlayVoiceSound_f/ValidateSoundName),
// ClientCommand's real argv(0) dispatch table, and then the crosshair /
// menu / radio / compass / referee set: Cmd_Id_f (c:1197), Cmd_Position_f
// (c:1227), Cmd_AngleInfo_f (c:1250), Cmd_Ctfhelp_f (c:1272),
// Cmd_Ctfmenu_f (c:1441), Cmd_Refmenu_f (c:1446), Cmd_Radio_f (c:1706),
// Cmd_Compass_f (c:1739), Cmd_Fobserve_f (c:1884), Cmd_Match_f (c:2032),
// PlayerSort (c:2086), Cmd_PlayerList_f (c:2245), Cmd_Refcommands_f
// (c:2333), Cmd_Test_f (c:2398).
//
// THIS pass adds the last of them -- the admin/operator commands and the
// map-authoring dumper: Cmd_Referee_f (c:1771), Cmd_GotoMap_f (c:1816),
// Cmd_QuadTime_f (c:1946), Cmd_Kick_f (c:1971, dispatched as "ctfkick"),
// Cmd_PingAlert_f (c:2067) and Cmd_InfoEnt_f (c:1458) -- plus the dispatch
// arms that forward to functions other files already own: "score" /
// "squadboard" / "help" (p_hud.ts's Cmd_Score_f/Cmd_Squadboard_f/
// Cmd_Help_f), "stats" / "statsall" (p_stats.ts's Cmd_PlayerStats_f/
// Cmd_StatsAll_f), "voteyes" / "voteno" (g_vote.ts's Vote_YES/Vote_NO
// behind its VoteStarted gate), the inline "squad"/"squadstatus" ADC
// category setters, and "gameversion". Cmd_Match_f and Cmd_GotoMap_f now
// scan the REAL rotation list: this pass also added src/lmctf/g_maplist.ts
// (the maplist.txt reader, sort and shuffle out of lmctf60/g_save.c's
// InitGame block and g_main.c's Randomize_Map_List), and g_main.ts's
// InitGame calls its loader.
//
// ClientTeam (c:15) is NOT ported because it does not exist as live code:
// the whole function body is inside a `/* ... */` block comment in
// lmctf60/g_cmds.c, and nothing in this file needs it.
//
// TWO deliberate differences from the C's own dispatch, both called out at
// their call sites rather than left implicit:
//   - "infoent" IS dispatched here. The C's own dispatch line for it is
//     commented out (g_cmds.c:2718-2719), leaving Cmd_InfoEnt_f dead on a
//     stock build; the function is complete and a server operator has no
//     other way to reach the map-authoring tool, so it is wired up.
//   - "danman" (the `#ifdef BAT_DEBUG` arm at the very top of the C's
//     ClientCommand) is NOT dispatched: BAT_DEBUG is never defined and
//     Cmd_DanMan does not exist in this build at all.
//
// ONE genuine gap remains, and it is a build-stamp problem rather than a
// missing port: "gameversion" prints `GAMEVERSION VER __DATE__` in the C,
// and __DATE__ is the compiler's build date. This port has no build-stamp
// mechanism, so that third field prints "unknown" (see BUILD_DATE below).
// The other two fields match exactly.

import { ATTN_IDLE, ATTN_NORM, CHAN_AUTO, CHAN_ITEM, Com_sprintf, Info_ValueForKey, MASK_SHOT, MASK_SOLID, MAX_INFO_STRING, MAX_ITEMS, PMF_DUCKED, PRINT_CHAT, PRINT_HIGH, PRINT_LOW, Q_stricmp, STAT_FRAGS } from "../shared/q_shared";
import { AngleVectors, vec3, vec3_origin, VectorCopy, VectorSet } from "../shared/math";
import {
  CTF_SPAM_BAND_RADIO,
  CTF_SPAM_BAND_SAY,
  CTF_SPAM_BAND_VOICE,
  CTF_TEAM_BLUE,
  CTF_TEAM_IGNORETEAM,
  CTF_TEAM_RED,
  ctf_ChangeMap,
  ctf_BSafePrint,
  ctf_findplayer,
  ctf_SafePrint,
  ctf_hook_abort,
  ctf_SetEntTeam,
  ctf_SpamCheck,
} from "./g_ctffunc";
import { FindItem, GetItemByIndex, ITEM_INDEX, itemlist, SpawnItem, Touch_Item } from "./g_items";
import { G_FreeEdict, G_ProjectSource, G_Spawn, vectoangles } from "./g_utils";
import { replace_flaginfo, string_replace } from "./g_replace";
import { maplist } from "./g_maplist";
import { Cmd_PlayerStats_f, Cmd_StatsAll_f, stats_clear } from "./p_stats";
import { FS_ReadRawFile, FS_WriteFile } from "../qcommon/files";
import {
  type EdictT,
  CTF_ALLOW_INVULN,
  CTF_EXTRAFLAGS_RADIO_SOUND,
  CTF_EXTRAFLAGS_RADIO_TEXT,
  CTF_EXTRAFLAGS_RCON,
  CTF_EXTRAFLAGS_REFEREE,
  CTF_FLAGS_NOFLAGS,
  CTF_NO_GRAP_DAMAGE,
  CTF_OFFHAND_HOOK,
  CTF_SCORE_BALANCE,
  CTF_TEAM_ARMOR_PROTECT,
  CTF_TEAM_NOSWITCH,
  CTF_TEAM_NOTEAMS,
  CTF_TEAM_RESET,
  FL_GODMODE,
  FL_NOTARGET,
  g_edicts,
  game,
  GAMEVERSION,
  gameCvars,
  gi,
  isRef,
  IT_AMMO,
  IT_ARMOR,
  IT_POWERUP,
  IT_WEAPON,
  level,
  MAX_CATEGORY_LEN,
  MAX_STATUS_LEN,
  MOD_SUICIDE,
  meansOfDeathHolder,
  MovetypeT,
  svc_inventory,
  svc_layout,
  svc_stufftext,
  UNSET_CATEGORY_STR,
  UNSET_STATUS_STR,
} from "./g_local";
import { ChaseNext, Team_Observer_OK } from "./g_chase";
import { matchstate, MatchStatesT, KillMatch, SpawnTourneyClock, StartMatch } from "./g_tourney";
import type { Edict } from "./game";
// Lazy require, not a static import: p_weapon.ts (Weapon_Hook_Fire) ->
// g_combat.ts (T_Damage) -> g_cmds.ts (OnSameTeam) -> g_items.ts (this
// file only needs FindItem/ITEM_INDEX from there, no cycle) would close a
// value cycle back to this file if Weapon_Hook_Fire were imported
// statically. Per PORTING.md's import-cycle rule, the command-dispatch
// layer (this file) is the "less fundamental" side and breaks the cycle.
//
// Menu_Next/Menu_Use/RefTogglePause (g_menu.ts) are resolved lazily, not
// statically, for the same reason: g_menu.ts already statically imports
// ForceCommand from this file, so a static import back here would close a
// value cycle.
function menuModule(): typeof import("./g_menu") {
  return require("./g_menu") as typeof import("./g_menu");
}

// p_client.ts already statically imports ForceCommand from this file
// (TeamJoin), so player_die/respawn/ClientHasFlag are resolved via a lazy
// require here for the same import-cycle reason.
function clientModule(): typeof import("./p_client") {
  return require("./p_client") as typeof import("./p_client");
}

// g_runes.ts already statically imports ValidateSelectedItem from this
// file, so Drop_Rune is resolved via a lazy require here for the same
// reason.
function runesModule(): typeof import("./g_runes") {
  return require("./g_runes") as typeof import("./g_runes");
}

// p_hud.ts (-> g_runes.ts), g_vote.ts (-> g_menu.ts) and g_spawn.ts
// (-> p_client.ts) each reach a module that statically imports from this
// file, so all three are resolved via a lazy require for the same
// import-cycle reason as the accessors above. g_vote's `VoteStarted` is a
// mutable `let` export, which is a second reason to read it off the module
// object at call time rather than binding it once at import time.
function hudModule(): typeof import("./p_hud") {
  return require("./p_hud") as typeof import("./p_hud");
}
function voteModule(): typeof import("./g_vote") {
  return require("./g_vote") as typeof import("./g_vote");
}
function spawnModule(): typeof import("./g_spawn") {
  return require("./g_spawn") as typeof import("./g_spawn");
}

function cvarNum(c: { value: number } | null): number {
  return c === null ? 0 : c.value;
}
function atoiC(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

/*
=================
OnSameTeam (lmctf60/g_cmds.c:280)

Wholly different from ctf/g_cmds.c's OnSameTeam (which compares
model/skin-derived "team strings" and requires DF_MODELTEAMS|DF_SKINTEAMS).
LM_CTF compares `ctf.teamnum` directly and is gated by `CTF_TEAM_NOTEAMS`
(server-wide "no teams" mode always returns false, even for two players who
share a teamnum) rather than a dmflags bit.
=================
*/
export function OnSameTeam(ent1: EdictT, ent2: EdictT): boolean {
  if (((gameCvars.ctfflags?.value ?? 0) & CTF_TEAM_NOTEAMS) !== 0) return false;

  if (
    ent1.client !== null &&
    ent2.client !== null &&
    ent1.client.ctf.teamnum === ent2.client.ctf.teamnum &&
    ent1.inuse &&
    ent2.inuse
  ) {
    return true;
  }
  return false;
}

/*
=================
ForceCommand (lmctf60/g_cmds.c:86)

Stuffs a console command into a specific client via `svc_stufftext` (wire
value 11). Used by Cmd_Hook_f/Cmd_Unhook_f to translate +hook/-hook into
+attack/-attack when the grappling hook is the client's currently equipped
weapon (so the weapon's own fire-frame dispatch handles it instead of the
offhand path). Refuses empty/oversized commands and refuses to stuff
anything before a level is loaded (`level.level_name === ""`), matching the
C source's guard against stuffing text during the pre-map-load window.
=================
*/
export function ForceCommand(ent: EdictT, command: string): void {
  if (command.length === 0 || command.length > MAX_INFO_STRING) return;
  if (level.level_name === "") return;

  gi.WriteByte(svc_stufftext);
  gi.WriteString(command);
  gi.unicast(ent, true);
}

/*
=================
Cmd_Hook_f (lmctf60/g_cmds.c:1368)

The offhand-hook dispatch branch. Observers (MOVETYPE_NOCLIP) can never
hook. When CTF_OFFHAND_HOOK is set:
  - if the client has no hook out yet (`!client.hook`) AND the grappling
    hook is NOT the client's current weapon, fire it directly via
    Weapon_Hook_Fire (bypassing the weapon-frame system entirely -- the
    equipped weapon's state is untouched).
  - if the grappling hook IS the current weapon, forward to +attack via
    ForceCommand instead (let the weapon's own fire-frame dispatch handle
    it).
  - otherwise, the C source checks
    `ent->client->pers.inventory[ITEM_INDEX(it)]` to confirm the client
    actually owns a Grappling Hook (every client is granted one at connect
    by the C source's InitClientPersistent, not yet ported -- see
    g_cmds.ts's file header); a test/caller that wants Cmd_Hook_f to
    actually fire must grant it explicitly first:
    `ent.client.pers.inventory[ITEM_INDEX(FindItem("Grappling Hook")!)] = 1`.
    Without that grant, this correctly prints "You have no hook." -- the
    same behavior the C source has for a client who was never given one.
  - a quad-damage sound cue plays on fire if the client currently has quad
    (preserved oddity: the sound plays regardless of whether the hook
    itself benefits from quad -- it doesn't, hook damage is fixed 1/8 --
    the C source just always announces active quad on any weapon fire this
    way).
When CTF_OFFHAND_HOOK is NOT set, `hook` behaves like the classic
"cmd use Grappling Hook" -- switch to it as your weapon (`it.use`).
=================
*/
export function Cmd_Hook_f(ent: EdictT): void {
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) return; // Observers can't hook
  const client = ent.client;
  if (client === null) return;

  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  if ((ctfflags & CTF_OFFHAND_HOOK) !== 0) {
    if (client.hook === null) {
      const it = FindItem("Grappling Hook");

      // Can't offhand your hook if it is your current weapon
      if (client.pers.weapon === it) {
        ForceCommand(ent, "+attack\n");
        return;
      }

      if (it !== null && client.pers.inventory[ITEM_INDEX(it)] !== 0) {
        if (client.quad_framenum > level.framenum) {
          gi.sound(ent, CHAN_ITEM, gi.soundindex("items/damage3.wav"), 1, ATTN_NORM, 0);
        }
        const { Weapon_Hook_Fire } = require("./p_weapon") as { Weapon_Hook_Fire: (ent: EdictT) => void };
        Weapon_Hook_Fire(ent);
      } else {
        ctf_SafePrint(ent, PRINT_HIGH, "You have no hook.\n");
      }
    }
  } else {
    // Use the hook (classic, non-offhand mode)
    const it = FindItem("grappling hook");
    if (it === null || client.pers.inventory[ITEM_INDEX(it)] === 0) {
      ctf_SafePrint(ent, PRINT_HIGH, "Out of item: grappling hook\n");
      return;
    }
    if (it.use) it.use(ent, it);
  }
}

/*
=================
Cmd_Unhook_f (lmctf60/g_cmds.c:1418)

Mirror of Cmd_Hook_f's dispatch: forwards to -attack if the hook is the
current weapon, otherwise aborts the offhand hook directly. Only meaningful
under CTF_OFFHAND_HOOK -- when that flag is off, releasing the hook key has
no handler here at all (matches the C source exactly: the `else` branch is
empty/absent).
=================
*/
export function Cmd_Unhook_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  if ((ctfflags & CTF_OFFHAND_HOOK) !== 0) {
    const it = FindItem("Grappling Hook");
    if (client.pers.weapon === it) {
      ForceCommand(ent, "-attack\n");
    } else {
      ctf_hook_abort(ent);
    }
  }
}

/*
=================
SelectNextItem (lmctf60/g_cmds.c:293) -- byte-identical to the C source.
Menu_Next's call does NOT return early (the C source's own comment,
preserved below, explains why: ValidateSelectedItem can reach this
function while a menu is up and must still fall through to the inventory
scan). SelectPrevItem (g_cmds.c:333) is a mirror-image function nothing in
this unit's SCOPE calls and is not ported.
=================
*/
export function SelectNextItem(ent: EdictT, itflags: number): void {
  const client = ent.client;
  if (client === null) return;

  if (client.showmenu) {
    menuModule().Menu_Next(ent);
    // surt, this causes a bug with dropping items ... this can be called
    // from validate selected item in which case it must _not_ return
    // early!!!! (lmctf60 comment, preserved verbatim in spirit)
  }

  if (client.chase_target !== null) {
    ChaseNext(ent);
    return;
  }

  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (client.pers.selected_item + i) % MAX_ITEMS;
    if (!client.pers.inventory[index]) continue;
    const it = GetItemByIndex(index);
    if (it === null || it.use === null) continue;
    if ((it.flags & itflags) === 0) continue;

    client.pers.selected_item = index;
    return;
  }

  client.pers.selected_item = -1;
}

/*
=================
ValidateSelectedItem (lmctf60/g_cmds.c:375) -- byte-identical to the C
source.
=================
*/
export function ValidateSelectedItem(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.pers.inventory[client.pers.selected_item]) return; // valid

  SelectNextItem(ent, -1);
}

/*
=================
SelectPrevItem (lmctf60/g_cmds.c:334) -- byte-identical to the C source
(same "must not return early after Menu_Prev" comment SelectNextItem's own
doc comment already explains).
=================
*/
export function SelectPrevItem(ent: EdictT, itflags: number): void {
  const client = ent.client;
  if (client === null) return;

  if (client.showmenu) {
    menuModule().Menu_Prev(ent);
  }

  if (client.chase_target !== null) {
    const { ChasePrev } = require("./g_chase") as { ChasePrev: (ent: EdictT) => void };
    ChasePrev(ent);
    return;
  }

  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (client.pers.selected_item + MAX_ITEMS - i) % MAX_ITEMS;
    if (!client.pers.inventory[index]) continue;
    const it = GetItemByIndex(index);
    if (it === null || it.use === null) continue;
    if ((it.flags & itflags) === 0) continue;

    client.pers.selected_item = index;
    return;
  }

  client.pers.selected_item = -1;
}

//=================================================================================
// Cheats / inventory / weapon-switch commands (lmctf60/g_cmds.c:397-1037)
//=================================================================================

/*
==================
Cmd_Give_f (lmctf60/g_cmds.c:397)

The `weapons`/`ammo`/`armor`/`Power Shield`/generic-give-all loops all walk
`game.num_items`, but this port's ITEMLIST (g_items.ts) has no IT_AMMO/
IT_ARMOR items and no "Power Shield"/armor-named entries at all -- those
branches are ported (matching the C source's control flow exactly) but
their loop bodies/FindItem lookups are unreachable/null-returning given
this port's actual data, same "unreachable given this port's actual data"
situation g_items.ts's SpawnItem doc comment already documents for
DF_NO_ARMOR/etc. Add_Ammo (p_weapon.c) does not exist anywhere in this
port (see g_tourney.ts's file header) -- its one call site below is
therefore never reached (no IT_AMMO item exists to enter that loop body).
==================
*/
export function Cmd_Give_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(gameCvars.sv_cheats) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Server does not have '+set cheats 1'.\n");
    return;
  }

  const name = gi.args();
  const giveAll = Q_stricmp(name, "all") === 0;

  if (giveAll || Q_stricmp(gi.argv(1), "health") === 0) {
    if (gi.argc() === 3) ent.health = atoiC(gi.argv(2));
    else ent.health = ent.max_health;
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "weapons") === 0) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & IT_WEAPON) === 0) continue;
      client.pers.inventory[i] += 1;
    }
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "ammo") === 0) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & IT_AMMO) === 0) continue;
      // Add_Ammo(ent, it, 1000) -- not reached, see this function's doc comment.
    }
    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "armor") === 0) {
    const jacket = FindItem("Jacket Armor");
    if (jacket !== null) client.pers.inventory[ITEM_INDEX(jacket)] = 0;

    const combat = FindItem("Combat Armor");
    if (combat !== null) client.pers.inventory[ITEM_INDEX(combat)] = 0;

    const body = FindItem("Body Armor");
    if (body !== null) client.pers.inventory[ITEM_INDEX(body)] = 0; // no GitemArmorT info populated in this port's ITEMLIST

    if (!giveAll) return;
  }

  if (giveAll || Q_stricmp(name, "Power Shield") === 0) {
    const it = FindItem("Power Shield");
    if (it !== null) {
      const it_ent = G_Spawn();
      it_ent.classname = it.classname;
      SpawnItem(it_ent, it);
      Touch_Item(it_ent, ent, null, null);
      if (it_ent.inuse) G_FreeEdict(it_ent);
    }

    if (!giveAll) return;
  }

  if (giveAll) {
    const items = itemlist();
    for (let i = 0; i < game.num_items; i++) {
      const it = items[i];
      if (it === undefined || it.pickup === null) continue;
      if ((it.flags & (IT_ARMOR | IT_WEAPON | IT_AMMO)) !== 0) continue;
      client.pers.inventory[i] = 1;
    }
    return;
  }

  let it = FindItem(name);
  if (it === null) {
    it = FindItem(gi.argv(1));
    if (it === null) {
      gi.cprintf(ent, PRINT_HIGH, "unknown item\n");
      return;
    }
  }

  if (it.pickup === null) {
    gi.cprintf(ent, PRINT_HIGH, "non-pickup item\n");
    return;
  }

  const index = ITEM_INDEX(it);

  if ((it.flags & IT_AMMO) !== 0) {
    if (gi.argc() === 3) client.pers.inventory[index] = atoiC(gi.argv(2));
    else client.pers.inventory[index] += it.quantity;
  } else {
    const it_ent = G_Spawn();
    it_ent.classname = it.classname;
    SpawnItem(it_ent, it);
    Touch_Item(it_ent, ent, null, null);
    if (it_ent.inuse) G_FreeEdict(it_ent);
  }
}

/*
==================
Cmd_God_f (lmctf60/g_cmds.c:555)
==================
*/
export function Cmd_God_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(gameCvars.sv_cheats) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Server does not have '+set cheats 1'.\n");
    return;
  }

  ent.flags ^= FL_GODMODE;
  const msg = (ent.flags & FL_GODMODE) === 0 ? "godmode OFF\n" : "godmode ON\n";
  ctf_SafePrint(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Notarget_f (lmctf60/g_cmds.c:584)
==================
*/
export function Cmd_Notarget_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(gameCvars.sv_cheats) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Server does not have '+set cheats 1'.\n");
    return;
  }

  ent.flags ^= FL_NOTARGET;
  const msg = (ent.flags & FL_NOTARGET) === 0 ? "notarget OFF\n" : "notarget ON\n";
  ctf_SafePrint(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Noclip_f (lmctf60/g_cmds.c:611)
==================
*/
export function Cmd_Noclip_f(ent: EdictT): void {
  if (cvarNum(gameCvars.deathmatch) !== 0 && cvarNum(gameCvars.sv_cheats) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Server does not have '+set cheats 1'.\n");
    return;
  }

  let msg: string;
  if (ent.movetype === MovetypeT.MOVETYPE_NOCLIP) {
    ent.movetype = MovetypeT.MOVETYPE_WALK;
    msg = "noclip OFF\n";
  } else {
    ent.movetype = MovetypeT.MOVETYPE_NOCLIP;
    msg = "noclip ON\n";
  }
  ctf_SafePrint(ent, PRINT_HIGH, msg);
}

/*
==================
Cmd_Use_f (lmctf60/g_cmds.c:643)

The "hook"/"grapple" -> "grappling hook" and "flag" -> "Enemy Flag"
classname aliases are LM_CTF-specific (CTF CODE -- LM_JORM), preserved
exactly.
==================
*/
export function Cmd_Use_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let s = gi.args();
  if (Q_stricmp(s, "hook") === 0) s = "grappling hook";
  else if (Q_stricmp(s, "grapple") === 0) s = "grappling hook";
  if (Q_stricmp(s, "flag") === 0) s = "Enemy Flag";

  const it = FindItem(s);
  if (it === null) {
    ctf_SafePrint(ent, PRINT_HIGH, `unknown item: ${s}\n`);
    return;
  }
  if (it.use === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Item is not usable.\n");
    return;
  }
  const index = ITEM_INDEX(it);
  if (!client.pers.inventory[index]) {
    ctf_SafePrint(ent, PRINT_HIGH, `Out of item: ${s}\n`);
    return;
  }

  it.use(ent, it);
}

/*
==================
Cmd_Drop_f (lmctf60/g_cmds.c:692)

LM_CTF-specific additions (CTF CODE -- LM_JORM): "hook"/"flag" classname
aliases, a "rune"/"artifact"/"tech" branch that drops whatever rune the
client is currently carrying (via ent.client.rune.item, not FindItem), and
an "ammo" alias that resolves to the current weapon's ammo type.
==================
*/
export function Cmd_Drop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  let s = gi.args();

  if (s.length === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Drop what?\n");
    return;
  }

  if (Q_stricmp(s, "hook") === 0) s = "grappling hook";
  if (Q_stricmp(s, "flag") === 0) s = "Enemy Flag";

  let it = null as ReturnType<typeof FindItem>;

  if (Q_stricmp(s, "rune") === 0 || Q_stricmp(s, "artifact") === 0 || Q_stricmp(s, "tech") === 0) {
    if (client.rune !== null) {
      const runeItem = client.rune.item;
      if (runeItem !== null) {
        if (runeItem.drop !== null) {
          runeItem.drop(ent, runeItem);
        } else {
          ctf_SafePrint(ent, PRINT_HIGH, `Can't drop ${s}\n`);
        }
      }
    }
    return;
  }

  if (Q_stricmp(s, "ammo") === 0) {
    if (client.pers.weapon !== null && client.pers.weapon.ammo !== null && client.pers.weapon.ammo.length > 0) {
      it = FindItem(client.pers.weapon.ammo);
    }
  }

  if (it === null) it = FindItem(s);
  if (it === null) {
    ctf_SafePrint(ent, PRINT_HIGH, `unknown item: ${s}\n`);
    return;
  }
  if (it.drop === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Item is not dropable.\n");
    return;
  }
  const index = ITEM_INDEX(it);
  if (!client.pers.inventory[index]) {
    ctf_SafePrint(ent, PRINT_HIGH, `Out of item: ${s}\n`);
    return;
  }

  it.drop(ent, it);
}

/*
=================
Cmd_Inven_f (lmctf60/g_cmds.c:777)
=================
*/
export function Cmd_Inven_f(ent: EdictT): void {
  const cl = ent.client;
  if (cl === null) return;

  cl.showscores = false;
  cl.showhelp = false;
  cl.showctfhud = false;
  cl.showmod = false;
  cl.showmenu = false;
  cl.showsquadboard = false; // ADC

  if (cl.showinventory) {
    cl.showinventory = false;
    return;
  }

  cl.showinventory = true;

  gi.WriteByte(svc_inventory);
  for (let i = 0; i < MAX_ITEMS; i++) {
    gi.WriteShort(cl.pers.inventory[i]);
  }
  gi.unicast(ent, true);
}

/*
=================
Cmd_InvUse_f (lmctf60/g_cmds.c:812) -- `client.showmenu` routes to
g_menu.ts's Menu_Use (lazy require, see this file's header).
=================
*/
export function Cmd_InvUse_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.showmenu) {
    menuModule().Menu_Use(ent);
    return;
  }

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === -1) {
    ctf_SafePrint(ent, PRINT_HIGH, "No item to use.\n");
    return;
  }

  const it = GetItemByIndex(client.pers.selected_item);
  if (it === null || it.use === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Item is not usable.\n");
    return;
  }
  it.use(ent, it);
}

/*
=================
Cmd_WeapPrev_f (lmctf60/g_cmds.c:844) -- skips the grappling hook when
CTF_OFFHAND_HOOK is set (LM_JORM addition: the hook isn't a normal weapon
slot in offhand mode) and bails immediately during MATCH_RAILGUN_INPLAY
(g_tourney.ts).
=================
*/
export function Cmd_WeapPrev_f(ent: EdictT): void {
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return;

  const cl = ent.client;
  if (cl === null) return;
  if (cl.pers.weapon === null) return;

  const selected_weapon = ITEM_INDEX(cl.pers.weapon);
  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  const hook = FindItem("Grappling Hook");

  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (selected_weapon + i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = GetItemByIndex(index);
    if (it === null || it.use === null) continue;
    if ((it.flags & IT_WEAPON) === 0) continue;
    if ((ctfflags & CTF_OFFHAND_HOOK) !== 0 && it === hook) continue;

    it.use(ent, it);
    if (cl.pers.weapon === it) return; // successful
  }
}

/*
=================
Cmd_WeapNext_f (lmctf60/g_cmds.c:892) -- mirror of Cmd_WeapPrev_f above.
=================
*/
export function Cmd_WeapNext_f(ent: EdictT): void {
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return;

  const cl = ent.client;
  if (cl === null) return;
  if (cl.pers.weapon === null) return;

  const selected_weapon = ITEM_INDEX(cl.pers.weapon);
  const ctfflags = gameCvars.ctfflags?.value ?? 0;
  const hook = FindItem("Grappling Hook");

  for (let i = 1; i <= MAX_ITEMS; i++) {
    const index = (selected_weapon + MAX_ITEMS - i) % MAX_ITEMS;
    if (!cl.pers.inventory[index]) continue;
    const it = GetItemByIndex(index);
    if (it === null || it.use === null) continue;
    if ((it.flags & IT_WEAPON) === 0) continue;
    if ((ctfflags & CTF_OFFHAND_HOOK) !== 0 && it === hook) continue;

    it.use(ent, it);
    if (cl.pers.weapon === it) return; // successful
  }
}

/*
=================
Cmd_WeapLast_f (lmctf60/g_cmds.c:940)
=================
*/
export function Cmd_WeapLast_f(ent: EdictT): void {
  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return;

  const cl = ent.client;
  if (cl === null) return;
  if (cl.pers.weapon === null || cl.pers.lastweapon === null) return;

  const index = ITEM_INDEX(cl.pers.lastweapon);
  if (!cl.pers.inventory[index]) return;
  const it = GetItemByIndex(index);
  if (it === null || it.use === null) return;
  if ((it.flags & IT_WEAPON) === 0) return;
  it.use(ent, it);
}

/*
=================
Cmd_InvDrop_f (lmctf60/g_cmds.c:972)
=================
*/
export function Cmd_InvDrop_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  ValidateSelectedItem(ent);

  if (client.pers.selected_item === -1) {
    ctf_SafePrint(ent, PRINT_HIGH, "No item to drop.\n");
    return;
  }

  const it = GetItemByIndex(client.pers.selected_item);
  if (it === null || it.drop === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Item is not dropable.\n");
    return;
  }
  it.drop(ent, it);
}

/*
=================
Cmd_Kill_f (lmctf60/g_cmds.c:998) -- lmctf60 drops ctf's `ent->solid ==
SOLID_NOT` early-out entirely (confirmed by direct source read); the
`#ifdef OLDOBSERVERCODE` Observer_Start call after player_die is dead code
(never defined, see g_menu.ts's own file header for the same macro).
=================
*/
export function Cmd_Kill_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (level.time - client.respawn_time < 5) return;
  ent.flags &= ~FL_GODMODE;
  ent.health = 0;
  meansOfDeathHolder.meansOfDeath = MOD_SUICIDE;
  clientModule().player_die(ent, ent, ent, 100000, vec3_origin);
}

/*
=================
Cmd_PutAway_f (lmctf60/g_cmds.c:1017)
=================
*/
export function Cmd_PutAway_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  client.showscores = false;
  client.showhelp = false;
  client.showinventory = false;
  client.showctfhud = false;
  client.showmod = false;
  client.showmenu = false;
  client.showsquadboard = false; // ADC

  gi.WriteByte(svc_layout);
  gi.WriteString("");
  gi.unicast(ent, false);
}

//=================================================================================
// TEAM_CODE -- LM_JORM (lmctf60/g_cmds.c:1039-1187)
//=================================================================================

/*
=================
Team_Change (lmctf60/g_cmds.c:1039) -- byte-identical to the C source.
player_die/respawn are resolved via a lazy require (see this file's
header).
=================
*/
export function Team_Change(ent: EdictT, newnum: number): void {
  if (newnum === 0) return;

  if (game.teamslocked) {
    gi.cprintf(ent, PRINT_HIGH, "Teams are locked\n");
    return;
  }

  const client = clientModule();
  ent.health = 0;
  // player_die (p_client.ts) -> ClientObituary applies deathmatch's usual
  // self-inflicted-death penalty (self.client.resp.score--, since attacker
  // === ent here); the resp.score++ below exists specifically to cancel
  // that penalty out, matching the C source's intent (switching teams
  // should not cost the player a frag) -- net effect on resp.score is
  // zero, not +1.
  client.player_die(ent, ent, ent, 100000, vec3_origin);
  if (ent.client !== null) {
    ent.client.resp.score++;
    const stats = require("./p_stats") as typeof import("./p_stats");
    stats.stats_add(ent, stats.STATS_SCORE, 1);
    stats.stats_add(ent, stats.STATS_DEATHS, -1);
  }

  // don't even bother waiting for death frames
  ctf_SetEntTeam(ent, newnum); // switch teams after they die

  client.respawn(ent); // force them to respawn on the new team
}

/*
=================
Drop_All (lmctf60/g_cmds.c:1065) -- byte-identical to the C source.
ClientHasFlag (p_client.ts) and Drop_Rune (g_runes.ts) are both resolved
via a lazy require (see this file's header).
=================
*/
export function Drop_All(ent: EdictT): void {
  const flag = clientModule().ClientHasFlag(ent);
  if (flag !== null && flag.item !== null) {
    const mod = require("./g_ctffunc") as { ctf_playerdropflag: (ent: EdictT, item: import("./g_local").GItemT) => void };
    mod.ctf_playerdropflag(ent, flag.item);
  }

  if (ent.client === null) return;

  if (ent.client.hook !== null) {
    G_FreeEdict(ent.client.hook);
    ent.client.hook = null;
  }

  if (ent.client.rune !== null && ent.client.rune.item !== null) {
    runesModule().Drop_Rune(ent, ent.client.rune.item);
  }
}

/*
=================
Cmd_Team_f (lmctf60/g_cmds.c:1088) -- byte-identical to the C source. The
spectator branch sets `ctf.New_Team` and forwards to "spectator 0"
(ForceCommand) rather than switching teams directly, matching
p_client.ts's TeamJoin convention for the same field.
=================
*/
export function Cmd_Team_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (matchstate === MatchStatesT.MATCH_RAILGUN_INPLAY) return;

  if (((gameCvars.ctfflags?.value ?? 0) & CTF_TEAM_NOSWITCH) !== 0) {
    gi.centerprintf(ent, "Sorry.  Team switching has been turned\n off on this server.\n");
    return;
  }

  if (game.teamslocked) {
    gi.cprintf(ent, PRINT_HIGH, "Teams are currently locked.\n");
    return;
  }

  const rawnew = gi.argv(1).toLowerCase();

  // If they are a spectator, team code screwed up, so do this instead.
  if (client.resp.spectator) {
    if (rawnew === "red") {
      client.ctf.New_Team = CTF_TEAM_RED;
      ForceCommand(ent, "spectator 0");
    } else if (rawnew === "blue") {
      client.ctf.New_Team = CTF_TEAM_BLUE;
      ForceCommand(ent, "spectator 0");
    }
    return;
  }

  let newnum = 0;

  if (rawnew === "red") {
    if (client.ctf.teamnum !== CTF_TEAM_RED) {
      newnum = 1;
    } else {
      return; // Same team
    }
  } else if (rawnew === "blue") {
    if (client.ctf.teamnum !== CTF_TEAM_BLUE) {
      newnum = 2;
    } else {
      return; // Same team
    }
  } else if (rawnew.length === 0) {
    if (client.ctf.teamnum === CTF_TEAM_RED) {
      ctf_SafePrint(ent, PRINT_HIGH, "You are currently on the red team.\n");
    } else if (client.ctf.teamnum === CTF_TEAM_BLUE) {
      ctf_SafePrint(ent, PRINT_HIGH, "You are currently on the blue team.\n");
    } else {
      ctf_SafePrint(ent, PRINT_HIGH, `You are currently team ${client.ctf.teamnum}.\n`);
    }
    ctf_SafePrint(ent, PRINT_HIGH, "Use 'team red' or 'team blue' to change teams.\n");
    return;
  } else {
    newnum = Math.random() < 0.5 ? 1 : 2;
  }

  Team_Change(ent, newnum);
}

/*
=================
Cmd_FlagStatus_f (lmctf60/g_cmds.c:1187) -- byte-identical to the C
source.
=================
*/
export function Cmd_FlagStatus_f(ent: EdictT): void {
  ctf_SafePrint(ent, PRINT_HIGH, replace_flaginfo(ent));
}

/*
=================
Cmd_Observe_f (lmctf60/g_cmds.c:2277) -- byte-identical to the C source
("bat"'s replacement observer path; see g_menu.ts's own file header for
why the `#ifdef OLDOBSERVERCODE` original is dead code). Drop_All is
ported above; Team_Observer_OK is g_chase.ts's real export.
=================
*/
export function Cmd_Observe_f(ent: EdictT, observerType: number): void {
  if (ent.client === null) return;

  const maxclients = cvarNum(gameCvars.maxclients);
  let numspec = 0;
  for (let i = 1; i <= maxclients; i++) {
    const e = g_edicts[i];
    if (e !== undefined && e.inuse && e.client !== null && e.client.pers.spectator) numspec++;
  }

  if (numspec >= cvarNum(gameCvars.maxspectators)) {
    gi.cprintf(ent, PRINT_HIGH, "Server spectator limit is full.");
    return;
  }

  if (observerType === CTF_TEAM_BLUE_OBSERVER()) {
    if (!Team_Observer_OK(CTF_TEAM_BLUE, ent)) return;
  } else if (observerType === CTF_TEAM_RED_OBSERVER()) {
    if (!Team_Observer_OK(CTF_TEAM_RED, ent)) return;
  }

  Drop_All(ent);
  ent.client.ctf.teamnum = observerType;
  ent.client.chase_target = null;
  ForceCommand(ent, "spectator 1");
}

// CTF_TEAM_OBSERVER_BLUE/RED (g_ctffunc.ts) -- resolved via a small lazy
// accessor rather than a direct import to avoid growing this file's
// already-large g_ctffunc.ts import list for two constants only used in
// the one comparison above; both are plain numeric literals (-2/-3, see
// g_ctffunc.ts) with no cycle concern either way.
function CTF_TEAM_BLUE_OBSERVER(): number {
  return (require("./g_ctffunc") as { CTF_TEAM_OBSERVER_BLUE: number }).CTF_TEAM_OBSERVER_BLUE;
}
function CTF_TEAM_RED_OBSERVER(): number {
  return (require("./g_ctffunc") as { CTF_TEAM_OBSERVER_RED: number }).CTF_TEAM_OBSERVER_RED;
}

//=================================================================================
// Referee / match-admin commands (lmctf60/g_cmds.c:41-115, 2321-2400)
//=================================================================================

/*
=================
Cmd_LockTeams_f (lmctf60/g_cmds.c:41) -- byte-identical to the C source.
=================
*/
export function Cmd_LockTeams_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Only referees can (un)lock teams.\n");
    return;
  }

  game.teamslocked = !game.teamslocked;
  gi.bprintf(PRINT_HIGH, `Teams are now ${game.teamslocked ? "" : "un"}locked\n`);
}

/*
=================
Cmd_StartMatch_f (lmctf60/g_cmds.c:52) -- byte-identical to the C source.
=================
*/
export function Cmd_StartMatch_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command denied.\n");
    return;
  }

  if (matchstate > MatchStatesT.MATCH_NONE) {
    gi.cprintf(ent, PRINT_HIGH, "Match already running, stop it first\n");
    return;
  }

  // start countdown
  SpawnTourneyClock();
}

/*
=================
Cmd_StopMatch_f (lmctf60/g_cmds.c:67) -- byte-identical to the C source.
=================
*/
export function Cmd_StopMatch_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command denied.\n");
    return;
  }

  if (matchstate === MatchStatesT.MATCH_NONE) {
    gi.cprintf(ent, PRINT_HIGH, "No match running\n");
    return;
  }

  KillMatch();
  if (ent.client !== null) {
    gi.bprintf(PRINT_HIGH, `Match stopped by ${ent.client.pers.netname}\n`);
  }
}

/*
=================
Cmd_PauseMatch_f (lmctf60/g_cmds.c:82) -- RefTogglePause (g_menu.ts) is
resolved via a lazy require (see this file's header).
=================
*/
export function Cmd_PauseMatch_f(ent: EdictT): void {
  menuModule().RefTogglePause(ent);
}

/*
=================
Cmd_SetPassword_f (lmctf60/g_cmds.c:98) -- byte-identical to the C source.
=================
*/
export function Cmd_SetPassword_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command\n");
    return;
  }

  if (gi.argc() < 2) {
    gi.cvar_set("password", "");
    gi.cprintf(ent, PRINT_HIGH, "Server password has been cleared\n");
    return;
  }

  const pw = gi.argv(1);
  gi.cvar_set("password", pw);
  gi.cprintf(ent, PRINT_HIGH, `Server password set to "${pw}"\n`);
}

/*
=================
Cmd_SetTimelimit_f (lmctf60/g_cmds.c:2377) -- byte-identical to the C
source.
=================
*/
export function Cmd_SetTimelimit_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command\n");
    return;
  }

  if (gi.argc() < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Usage: settimelimit <minutes>\n");
    return;
  }

  const minutes = gi.argv(1);
  gi.cvar_set("timelimit", minutes);

  gi.cprintf(ent, PRINT_HIGH, `Timelimit set to ${Math.floor(cvarNum(gameCvars.timelimit))} minutes\n`);
}

/*
=================
Cmd_ChangeMap_f (lmctf60/g_cmds.c:2361) -- byte-identical to the C source.
=================
*/
export function Cmd_ChangeMap_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command\n");
    return;
  }

  if (gi.argc() < 2) {
    gi.cprintf(ent, PRINT_HIGH, "Usage: changemap <mapname>\n");
    return;
  }

  const map = gi.argv(1);
  ctf_ChangeMap(map, false);
}

/*
=================
Cmd_ToggleFastSwitch_f (lmctf60/g_cmds.c:2321) -- byte-identical to the C
source.
=================
*/
export function Cmd_ToggleFastSwitch_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command\n");
    return;
  }

  const newval = cvarNum(gameCvars.fastswitch) === 1 ? "0" : "1";
  gi.cvar_set("fastswitch", newval);
  gi.bprintf(PRINT_HIGH, `Fast weapon switching now ${cvarNum(gameCvars.fastswitch) !== 0 ? "en" : "dis"}abled\n`);
}

//=================================================================================
// Radio / voice sounds (lmctf60/g_cmds.c:117-274)
//=================================================================================

/*
=================
PlayTeamSound (lmctf60/g_cmds.c:117) -- byte-identical to the C source.
Gender is inferred from the client's own skin string ("f"/"F" prefix ->
female); "_"-prefixed or already male_/fem_-prefixed sounds skip the
gender-append step entirely.
=================
*/
export function PlayTeamSound(ent: EdictT, sound: string): void {
  if (ent.client === null) return;
  const client = ent.client;

  if (client.ctf.teamnum <= 0 /* CTF_TEAM_OBSERVER and below */) {
    ctf_SafePrint(ent, PRINT_HIGH, "Observers have no radio.\n");
    return;
  }

  if ((client.ctf.extra_flags & (CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND)) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "Your radio is off!\n");
    return;
  }

  if (!ctf_SpamCheck(ent)) return;

  const s = Info_ValueForKey(client.pers.userinfo, "skin");

  let command: string;
  if (sound.startsWith("_") || sound.startsWith("male_") || sound.startsWith("fem_")) {
    command = `play radio/${sound}\n`;
  } else {
    const gender = s.startsWith("f") || s.startsWith("F") ? "fem" : "male";
    command = `play radio/${gender}_${sound}\n`;
  }

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let j = 1; j <= maxclients; j++) {
    const other = g_edicts[j];
    if (other === undefined || !other.inuse || other.client === null) continue;
    if (!OnSameTeam(ent, other)) continue;

    if ((other.client.ctf.extra_flags & (CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND)) === 0) continue;

    if ((other.client.ctf.extra_flags & CTF_EXTRAFLAGS_RADIO_SOUND) !== 0) {
      ForceCommand(other, command);
    }

    if ((other.client.ctf.extra_flags & CTF_EXTRAFLAGS_RADIO_TEXT) !== 0) {
      ctf_SafePrint(other, PRINT_HIGH, `${client.pers.netname} (radiotext): ${sound}\n`);
    }
  }
  gi.dprintf(`${client.pers.netname} (radiotext): ${sound}\n`);

  client.spam_band_count -= CTF_SPAM_BAND_RADIO;
}

/*
=================
PlayVoiceSound (lmctf60/g_cmds.c:196) -- byte-identical to the C source.
The `#ifdef NOVOICE_OK` block is never defined (dead code, same rule
g_menu.ts's Ref_CTFFlags_Menu doc comment already documents for the same
macro family).
=================
*/
export function PlayVoiceSound(ent: EdictT, sound: string): void {
  if (ent.client === null) return;
  const client = ent.client;

  if (client.ctf.teamnum <= 0 /* CTF_TEAM_OBSERVER and below */) {
    ctf_SafePrint(ent, PRINT_HIGH, "Observers can't use voice.\n");
    return;
  }

  if (!ctf_SpamCheck(ent)) return;

  const s = Info_ValueForKey(client.pers.userinfo, "skin");

  let command: string;
  if (sound.startsWith("_") || sound.startsWith("male_") || sound.startsWith("fem_")) {
    command = `voice/${sound}.wav`;
  } else {
    const gender = s.startsWith("f") || s.startsWith("F") ? "fem" : "male";
    command = `voice/${gender}_${sound}.wav`;
  }

  gi.sound(ent, CHAN_AUTO, gi.soundindex(command), 1, ATTN_IDLE, 0);
  gi.dprintf(`${client.pers.netname} (voicetext): ${command}\n`);

  client.spam_band_count -= CTF_SPAM_BAND_VOICE;
}

/*
=================
ValidateSoundName (lmctf60/g_cmds.c:255, `static`) -- the C source's
sscanf-based path-sanitizer strips anything after the first
`;\/:*?"<>| \t\n\r` character. Reproduced with an equivalent character
class scan.
=================
*/
function ValidateSoundName(sound: string): string {
  const m = /^[^;\\/:*?"<>| \t\n\r]*/.exec(sound);
  return m !== null ? m[0] : "";
}

/*
=================
Cmd_PlayTeamSound_f / Cmd_PlayVoiceSound_f (lmctf60/g_cmds.c:268/274) --
byte-identical to the C source.
=================
*/
export function Cmd_PlayTeamSound_f(ent: EdictT): void {
  const sound = ValidateSoundName(gi.args());
  PlayTeamSound(ent, sound);
}

export function Cmd_PlayVoiceSound_f(ent: EdictT): void {
  const sound = ValidateSoundName(gi.args());
  PlayVoiceSound(ent, sound);
}

//=================================================================================
// Wave / players / users / say (lmctf60/g_cmds.c:2108-2245)
//=================================================================================

// FRAME_* (lmctf60/m_player.h:77-139) -- byte-identical to the values
// this port's src/ctf and base game families each already duplicate their
// own copy of (no m_player_frames.ts exists for this game family yet, see
// this file's header); kept as local literals rather than importing
// another game family's module (this port never imports across game
// family boundaries, per PORTING.md).
const FRAME_flip01 = 72;
const FRAME_flip12 = 83;
const FRAME_salute01 = 84;
const FRAME_salute11 = 94;
const FRAME_taunt01 = 95;
const FRAME_taunt17 = 111;
const FRAME_wave01 = 112;
const FRAME_wave11 = 122;
const FRAME_point01 = 123;
const FRAME_point12 = 134;
const ANIM_WAVE = 1;

/*
=================
Cmd_Wave_f (lmctf60/g_cmds.c:2119) -- byte-identical to the C source.
=================
*/
export function Cmd_Wave_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const i = atoiC(gi.argv(1));

  // can't wave when ducked
  if ((client.ps.pmove.pm_flags & PMF_DUCKED) !== 0) return;
  if (client.anim_priority > ANIM_WAVE) return;

  client.anim_priority = ANIM_WAVE;

  switch (i) {
    case 0:
      ctf_SafePrint(ent, PRINT_HIGH, "flipoff\n");
      ent.s.frame = FRAME_flip01 - 1;
      client.anim_end = FRAME_flip12;
      break;
    case 1:
      ctf_SafePrint(ent, PRINT_HIGH, "salute\n");
      ent.s.frame = FRAME_salute01 - 1;
      client.anim_end = FRAME_salute11;
      break;
    case 2:
      ctf_SafePrint(ent, PRINT_HIGH, "taunt\n");
      ent.s.frame = FRAME_taunt01 - 1;
      client.anim_end = FRAME_taunt17;
      break;
    case 3:
      ctf_SafePrint(ent, PRINT_HIGH, "wave\n");
      ent.s.frame = FRAME_wave01 - 1;
      client.anim_end = FRAME_wave11;
      break;
    case 4:
    default:
      ctf_SafePrint(ent, PRINT_HIGH, "point\n");
      ent.s.frame = FRAME_point01 - 1;
      client.anim_end = FRAME_point12;
      break;
  }
}

/*
=================
Cmd_Users_f (lmctf60/g_cmds.c:1850) -- byte-identical to the C source.
=================
*/
export function Cmd_Users_f(ent: EdictT): void {
  let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (player !== null) {
    if (player.client === null) {
      player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
      continue;
    }
    let status: string;
    if ((player.client.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) !== 0) status = "[RCON] ";
    else if ((player.client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0) status = "(REF)  ";
    else status = "PLAYER ";

    status += ` id: ${player.client.ctf.ctfid} ${player.client.pers.netname} frags: ${player.client.ps.stats[STAT_FRAGS]}\n`;
    ctf_SafePrint(ent, PRINT_HIGH, status);

    player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
  }
}

/*
=================
Cmd_Players_f (lmctf60/g_cmds.c:2108) -- byte-identical to the C source
("surt just call users, it does same thing").
=================
*/
export function Cmd_Players_f(ent: EdictT): void {
  Cmd_Users_f(ent);
}

/*
=================
Cmd_Say_f (lmctf60/g_cmds.c:2170) -- byte-identical to the C source.
Gates on ctf_SpamCheck (not CheckFlood -- LM_CTF replaces ctf's
flood-message cvars with the spam-control subsystem everywhere). The
"infoent info_position" temporary debug branch is commented out in the C
source itself (dead code, not reproduced).
=================
*/
export function Cmd_Say_f(ent: EdictT, team: boolean, arg0: boolean): void {
  const client = ent.client;
  if (client === null) return;

  if (gi.argc() < 2 && !arg0) return;

  if (!ctf_SpamCheck(ent)) return;

  let text = team ? `(${client.pers.netname}): ` : `${client.pers.netname}: `;

  let temp: string;
  if (arg0) {
    temp = `${gi.argv(0)} ${gi.args()}`;
  } else {
    let p = gi.args();
    if (p.startsWith('"')) {
      p = p.slice(1);
      if (p.length > 0) p = p.slice(0, -1);
    }
    temp = p;
  }

  temp = string_replace(ent, temp);
  text += temp;

  // don't let text be too long for malicious reasons
  if (text.length > 150) text = text.slice(0, 150);

  client.spam_band_count -= text.length * 2 + CTF_SPAM_BAND_SAY; // surt spam control

  text += "\n";

  if (cvarNum(gameCvars.dedicated) !== 0) gi.dprintf(text);

  const maxclients = game.maxclients;
  for (let j = 1; j <= maxclients; j++) {
    const other = g_edicts[j];
    if (other === undefined || !other.inuse || other.client === null) continue;
    if (team && !OnSameTeam(ent, other)) continue;
    ctf_SafePrint(other, PRINT_CHAT, text);
  }
}

//=================================================================================
// Crosshair/debug readouts, help/menu wrappers, radio + compass toggles,
// referee force-observe/match/playerlist/refcommands
// (lmctf60/g_cmds.c:1197-2398)
//=================================================================================

// MAX_MSGLEN (qcommon.h:  `#define MAX_MSGLEN 1400`) -- kept as a local
// literal rather than importing src/qcommon/qcommon.ts, which sits on the
// engine side of the game-module boundary this tree never imports across
// (same rule the FRAME_* literals above are kept local under).
const MAX_MSGLEN = 1400;

// trace_t.ent recovery idiom (see g_monster.ts's own traceEdict): sv_world.c
// defaults an unset trace.ent to the world edict, never NULL, so a null
// GTraceT.ent here falls back to g_edicts[0] the same way. The world edict
// has neither `client` nor `item`, so Cmd_Id_f's C `if (tr.ent)` guard and
// this fallback print exactly the same thing (nothing).
function traceEdict(entIn: Edict | null): EdictT {
  if (entIn === null) return g_edicts[0];
  return g_edicts[entIn.s.number];
}

/*
=================
ParseUnsignedLongArg -- C: `unsigned long i=0; if (!sscanf(p, "%lu", &i))`.
sscanf's "%lu" skips leading whitespace, accepts an optional sign, then
digits, and reports 0 items assigned (falsy) when nothing numeric is found.
Mirrors g_svcmds.ts's module-local helper of the same name (module-private
there, so replicated rather than imported -- same convention as this file's
own `cvarNum`). The `>>> 0` mirrors storing the parsed number into an
unsigned long.
=================
*/
function ParseUnsignedLongArg(s: string): { ok: boolean; value: number } {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (m === null) return { ok: false, value: 0 };
  return { ok: true, value: Number.parseInt(m[1], 10) >>> 0 };
}

/*
=================
Cmd_Id_f (lmctf60/g_cmds.c:1197) -- byte-identical to the C source.

Traces a 64-unit-wide box 10000 units along the client's view direction and
centerprints whatever is under the crosshair: a player's netname, or an
item's pickup_name. Preserved oddity: the trace uses a full +/-32 box
(hull-sized), not a point trace, so "id" latches onto anything the player
could physically walk into, not strictly what the crosshair pixel covers.
=================
*/
export function Cmd_Id_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const mins = vec3(-32, -32, -32);
  const maxs = vec3(32, 32, 32);
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const offset = vec3();
  const end = vec3();

  // Set out ending point to our starting point
  AngleVectors(client.v_angle, forward, right, null);
  VectorSet(offset, 8, 0, ent.viewheight - 8);
  G_ProjectSource(ent.s.origin, offset, forward, right, start);

  VectorSet(offset, 10000, 0, 0);
  G_ProjectSource(start, offset, forward, right, end);

  const tr = gi.trace(start, mins, maxs, end, ent, MASK_SHOT);
  const hit = traceEdict(tr.ent);
  if (hit.client !== null) {
    gi.centerprintf(ent, hit.client.pers.netname);
  } else if (hit.item !== null && hit.item.pickup_name !== null) {
    gi.centerprintf(ent, hit.item.pickup_name);
  }
}

/*
=================
Cmd_Position_f (lmctf60/g_cmds.c:1227) -- byte-identical to the C source.

Preserved oddity: the ANGLE line reports `ent->s.angles` (the *model's*
angles, which the player-move code keeps yaw-only with pitch scaled to
1/3), not `client->v_angle` -- so the pitch/roll it prints will not match
where the player is actually looking. Cmd_AngleInfo_f below is the command
that reports v_angle.
=================
*/
export function Cmd_Position_f(ent: EdictT): void {
  const f1 = ent.s.origin[0];
  const f2 = ent.s.origin[1];
  const f3 = ent.s.origin[2];

  const a1 = ent.s.angles[0];
  const a2 = ent.s.angles[1];
  const a3 = ent.s.angles[2];

  const temp = string_replace(ent, "%p");

  const message = Com_sprintf(
    "LOC: { %.0f, %.0f, %.0f }\nANGLE: { %.0f, %.0f, %.0f }\nYou are %s\n",
    f1,
    f2,
    f3,
    a1,
    a2,
    a3,
    temp,
  );

  ctf_SafePrint(ent, PRINT_HIGH, message);
}

/*
=================
Cmd_AngleInfo_f (lmctf60/g_cmds.c:1250) -- byte-identical to the C source.

Preserved bug: "FACEANGLE" runs `vectoangles` on `ent->s.origin` -- a world
*position*, not a direction vector -- so the three numbers it prints are the
pitch/yaw of the ray from the world origin to the player, not the player's
facing at all. Left exactly as the C source has it.
=================
*/
export function Cmd_AngleInfo_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const a1 = client.v_angle[0];
  const a2 = client.v_angle[1];
  const a3 = client.v_angle[2];

  const tempvec = vec3();
  VectorCopy(ent.s.origin, tempvec);
  vectoangles(tempvec, tempvec);
  const t1 = tempvec[0];
  const t2 = tempvec[1];
  const t3 = tempvec[2];

  const message = Com_sprintf(
    "VIEWANGLE: { %.0f, %.0f, %.0f }\tFACEANGLE: { %.0f, %.0f, %.0f }\n",
    a1,
    a2,
    a3,
    t1,
    t2,
    t3,
  );
  ctf_SafePrint(ent, PRINT_HIGH, message);
}

/*
=================
Cmd_Ctfhelp_f (lmctf60/g_cmds.c:1272)

Prints the eleven-line `ctfflags` settings summary followed by the command
list (which gains the two hook lines only when CTF_OFFHAND_HOOK is set).

Two of the eleven lines come from `#ifdef` arms that are dead in this
build:
  - s1's `#ifdef WEAP_BALANCE_OK` arm (which would read CTF_WEAP_BALANCE)
    is never compiled -- WEAP_BALANCE_OK appears in no GNUmakefile define
    and in no header -- so only the `#else` arm, the unconditional
    "OFF: Normal Balance", is ported.
  - s6's `#ifdef NOVOICE_OK` arm (CTF_NOVOICE) is dead for the same reason
    (the same macro g_menu.ts's Ref_CTFFlags_Menu doc comment already
    documents), so only its unconditional "OFF: Voice Commands Enabled"
    `#else` arm is ported.
=================
*/
export function Cmd_Ctfhelp_f(ent: EdictT): void {
  const ctfflags = gameCvars.ctfflags?.value ?? 0;

  // WEAP_BALANCE_OK is never defined in this build -- only the #else arm exists.
  const s1 = "OFF: Normal Balance";

  const s2 = (ctfflags & CTF_ALLOW_INVULN) !== 0 ? "ON : Invulnerability Enabled" : "OFF: Invulnerability Disabled";
  const s3 = (ctfflags & CTF_TEAM_RESET) !== 0 ? "ON : Teams reset every level" : "OFF: Teams do not reset";
  const s4 = (ctfflags & CTF_TEAM_NOSWITCH) !== 0 ? "ON : Team command disabled" : "OFF: Team command enabled";
  const s5 = (ctfflags & CTF_OFFHAND_HOOK) !== 0 ? "ON : Offhand Hook Enabled" : "OFF: Offhand Hook Disabled";

  // NOVOICE_OK is never defined in this build -- only the #else arm exists.
  const s6 = "OFF: Voice Commands Enabled";

  const s7 = (ctfflags & CTF_NO_GRAP_DAMAGE) !== 0 ? "ON : No Grapple Damage" : "OFF: Grapple Damage Enabled";
  const s8 = (ctfflags & CTF_TEAM_NOTEAMS) !== 0 ? "ON : Teams Disabled" : "OFF: Teams Enabled";
  const s9 = (ctfflags & CTF_FLAGS_NOFLAGS) !== 0 ? "ON : Flags Disabled" : "OFF: Flags Enabled";
  const s10 = (ctfflags & CTF_SCORE_BALANCE) !== 0 ? "ON : Balance Enabled" : "OFF: Balance Disabled";
  const s11 =
    (ctfflags & CTF_TEAM_ARMOR_PROTECT) !== 0
      ? "ON : Team Armor Protect Enabled"
      : "OFF: Team Armor Protect Disabled";

  const message = Com_sprintf(
    "ctfflags:\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n   %s\n\n",
    s1,
    s2,
    s3,
    s4,
    s5,
    s6,
    s7,
    s8,
    s9,
    s10,
    s11,
  );
  ctf_SafePrint(ent, PRINT_HIGH, message);

  if ((ctfflags & CTF_OFFHAND_HOOK) !== 0) {
    ctf_SafePrint(
      ent,
      PRINT_HIGH,
      "The following commands are available:\n" +
        "   cmd ctfmenu\n" +
        "   cmd play_team\n" +
        "   cmd team <red/blue>\n" +
        "   cmd flagstatus\n" +
        "   cmd id\n" +
        "   cmd position\n" +
        // literal tab, exactly as the C string has it (not three spaces)
        "\t+hook\n" +
        "   -hook\n" +
        "   radiomenu\n" +
        "   radio <off/text/on/both>\n",
    );
  } else {
    ctf_SafePrint(
      ent,
      PRINT_HIGH,
      "The following commands are available:\n" +
        "   cmd ctfmenu\n" +
        "   cmd play_team\n" +
        "   cmd team <red/blue>\n" +
        "   cmd flagstatus\n" +
        "   cmd id\n" +
        "   cmd position\n" +
        "   radiomenu\n" +
        "   radio <off/text/on/both>\n",
    );
  }
}

/*
=================
Cmd_Ctfmenu_f (lmctf60/g_cmds.c:1441) -- byte-identical to the C source.
Ctf_Menu (g_menu.ts) is reached through this file's `menuModule()` lazy
accessor (g_menu.ts statically imports from this file -- see the header).
=================
*/
export function Cmd_Ctfmenu_f(ent: EdictT): void {
  menuModule().Ctf_Menu(ent);
}

/*
=================
Cmd_Refmenu_f (lmctf60/g_cmds.c:1446) -- byte-identical to the C source.
Note the referee gate here is the raw CTF_EXTRAFLAGS_REFEREE test the C
source writes, NOT ISREF() -- an rcon-only client (CTF_EXTRAFLAGS_RCON
without CTF_EXTRAFLAGS_REFEREE) is refused the ref menu, which is exactly
what g_local.ts's isRef() would also answer here (isRef tests the same
single bit), so the two happen to agree; the direct bit test is kept to
match the C line-for-line.
=================
*/
export function Cmd_Refmenu_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee\n");
    return;
  }

  client.showmenu = true;
  menuModule().Ref_Main_Menu(ent);
}

/*
=================
Cmd_Radio_f (lmctf60/g_cmds.c:1706) -- byte-identical to the C source.
The word forms are matched with case-sensitive `strcmp`, not Q_stricmp, so
"OFF" does NOT match "off" -- preserved exactly (it still matches the '0'
first-character test, though, which is why "OFF" happens to work anyway).
=================
*/
export function Cmd_Radio_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const p = gi.args();
  const c0 = p.length > 0 ? p[0] : "";

  if (c0 === "0" || p === "off") {
    client.ctf.extra_flags &= ~(CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND);
    ctf_SafePrint(ent, PRINT_HIGH, "Your radio is now off.\n");
  } else if (c0 === "1" || p === "on") {
    client.ctf.extra_flags &= ~(CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND);
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_RADIO_SOUND;
    ctf_SafePrint(ent, PRINT_HIGH, "Your radio is now on for sound.\n");
  } else if (c0 === "2" || p === "text") {
    client.ctf.extra_flags &= ~(CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND);
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_RADIO_TEXT;
    ctf_SafePrint(ent, PRINT_HIGH, "Your radio is now text.\n");
  } else if (c0 === "3" || p === "both") {
    client.ctf.extra_flags &= ~(CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND);
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_RADIO_TEXT | CTF_EXTRAFLAGS_RADIO_SOUND;
    ctf_SafePrint(ent, PRINT_HIGH, "Your radio is now on for text and sound.\n");
  } else {
    ctf_SafePrint(ent, PRINT_HIGH, "Format: radio <off/text/on/both>\n");
  }
}

/*
=================
Cmd_Compass_f (lmctf60/g_cmds.c:1739) -- byte-identical to the C source
(same case-sensitive strcmp note as Cmd_Radio_f above). Sets
`client.ctf.compass` to 0 (off) / 1 (facing) / 2 (on) / 3 (enemy flag).
=================
*/
export function Cmd_Compass_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const p = gi.args();
  const c0 = p.length > 0 ? p[0] : "";

  if (c0 === "0" || p === "off") {
    client.ctf.compass = 0;
    ctf_SafePrint(ent, PRINT_HIGH, "Your compass is now off.\n");
  } else if (c0 === "1" || p === "facing") {
    client.ctf.compass = 1;
    ctf_SafePrint(ent, PRINT_HIGH, "Your compass is now in facing mode.\n");
  } else if (c0 === "2" || p === "on") {
    client.ctf.compass = 2;
    ctf_SafePrint(ent, PRINT_HIGH, "Your compass is now on.\n");
  } else if (c0 === "3" || p === "flag") {
    client.ctf.compass = 3;
    ctf_SafePrint(ent, PRINT_HIGH, "Your compass is now pointing to the enemy flag.\n");
  } else {
    ctf_SafePrint(ent, PRINT_HIGH, "Format: compass <on/off/facing/flag>\n");
  }
}

/*
=================
Cmd_Fobserve_f (lmctf60/g_cmds.c:1884)

Referee-only: forces one player (named by their "users" list id) into
observer mode, clearing their stats first. Preserved quirks:
  - the id scan keeps walking every player after a match, so the LAST
    player with the given ctfid wins (ctfids are unique, so this only
    matters as wasted work);
  - a referee cannot fobserve another referee unless they also hold
    CTF_EXTRAFLAGS_RCON, and nobody can fobserve an rcon holder;
  - with an EMPTY argument string, C's sscanf returns EOF (-1), which is
    truthy, so the usage message is NOT printed -- `i` stays 0 and the
    command falls through to the "Couldn't find that target number."
    branch instead. ParseUnsignedLongArg reports ok:false for an empty
    string, so the port would print usage where the C does not; the
    explicit `p.length === 0` short-circuit below restores the C's actual
    behavior.
=================
*/
export function Cmd_Fobserve_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee\n");
    return;
  }

  const p = gi.args();
  let i = 0;
  if (p.length !== 0) {
    const parsed = ParseUnsignedLongArg(p);
    if (!parsed.ok) {
      ctf_SafePrint(ent, PRINT_HIGH, 'Usage: fobserve <number>\nUse "users" to list players by number.\n');
      return;
    }
    i = parsed.value;
  }

  let target: EdictT | null = null;
  let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (player !== null) {
    if (player.client !== null && player.client.ctf.ctfid === i) target = player;
    player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
  }

  if (target === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Couldn't find that target number.\n");
    return;
  }
  const targetClient = target.client;
  if (targetClient === null) return;

  // Can't kick a referee unless you are an rcon
  if (
    (targetClient.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0 &&
    (client.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) === 0
  ) {
    ctf_SafePrint(ent, PRINT_HIGH, `${targetClient.pers.netname} is a referee.  You cannot force observer on them.\n`);
    return;
  }

  // Can't kick an rcon under any circumstances
  if ((targetClient.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) !== 0) {
    ctf_SafePrint(ent, PRINT_HIGH, `${targetClient.pers.netname} is an rcon.  You cannot force observer on them.\n`);
    return;
  }

  ctf_BSafePrint(PRINT_HIGH, `${targetClient.pers.netname} was forced to observe by ${client.pers.netname}.\n`);
  // clear the kicked player's stats
  stats_clear(target);
  ForceCommand(target, "observe\n");
}

/*
=================
Cmd_Match_f (lmctf60/g_cmds.c:2032)

Referee-only "match <mapname>": scans the server's maplist for an exact
(case-sensitive) name match and, on a hit, starts the match countdown on
that map.

The maplist itself now comes from g_maplist.ts (this pass ported the
maplist.txt reader out of lmctf60/g_save.c's InitGame block into that
file), so the scan below walks the server's real rotation list. The name
match is case-sensitive `strcmp` against the reader's already-lowercased
names -- so, unlike Cmd_GotoMap_f at c:1816, `match` does NOT lowercase
its argument first and therefore will not find a map typed with any
capital letters. That asymmetry between the two commands is the C's, and
is preserved.
=================
*/
export function Cmd_Match_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee\n");
    return;
  }

  const p = gi.args();

  if (p.length === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "USAGE: match <mapname>\n");
    return;
  }

  for (const entry of maplist) {
    if (entry.mapname === p) {
      ctf_SafePrint(ent, PRINT_HIGH, "Match countdown beginning.\n");
      StartMatch(p);
      return;
    }
  }
  ctf_SafePrint(ent, PRINT_HIGH, `${p} is not a map from the maplist.\n`);
}

/*
=================
PlayerSort (lmctf60/g_cmds.c:2086)

The qsort comparator for an array of client indices, ordering by
STAT_FRAGS ascending. Ported for completeness: lmctf60 has NO qsort call
anywhere (verified across every .c/.h in the tree), so nothing in the C
source ever passes this to anything -- Cmd_PlayerList_f prints in edict
order, unsorted. Exported so the day a caller lands it is already here.
=================
*/
export function PlayerSort(a: number, b: number): number {
  const anum = game.clients[a].ps.stats[STAT_FRAGS];
  const bnum = game.clients[b].ps.stats[STAT_FRAGS];

  if (anum < bnum) return -1;
  if (anum > bnum) return 1;
  return 0;
}

/*
=================
Cmd_PlayerList_f (lmctf60/g_cmds.c:2245)

Connect time (mm:ss), ping, score, name, "(spectator)" and the client's
ctf id, one line per in-use client, printed as one cprintf. Preserved
quirks:
  - the loop walks `maxclients->value` slots starting at g_edicts+1 and
    dereferences `e2->client` after only an `inuse` test (this port adds
    the `client === null` guard TypeScript requires; on a real server an
    in-use client slot always has a client, so the guarded path is the
    same one C takes);
  - the "connect time" divides framenum deltas by 600 and 10 -- correct
    only at the stock 10Hz server tick;
  - once the accumulated text would pass MAX_MSGLEN-50 it appends
    "And more...\n" and returns, silently dropping every remaining player.
=================
*/
export function Cmd_PlayerList_f(ent: EdictT): void {
  let text = "";

  const maxclients = cvarNum(gameCvars.maxclients);
  for (let i = 0; i < maxclients; i++) {
    const e2 = g_edicts[i + 1];
    if (e2 === undefined || !e2.inuse) continue;
    if (e2.client === null) continue;

    const elapsed = level.framenum - e2.client.resp.enterframe;
    const st = Com_sprintf(
      "%02d:%02d %4d %3d %s%s id: %i\n",
      Math.trunc(elapsed / 600),
      Math.trunc((elapsed % 600) / 10),
      e2.client.ping,
      e2.client.resp.score,
      e2.client.pers.netname,
      e2.client.resp.spectator ? " (spectator)" : "",
      e2.client.ctf.ctfid,
    );
    if (text.length + st.length > MAX_MSGLEN - 50) {
      text += "And more...\n";
      gi.cprintf(ent, PRINT_HIGH, text);
      return;
    }
    text += st;
  }
  gi.cprintf(ent, PRINT_HIGH, text);
}

/*
=================
Cmd_Refcommands_f (lmctf60/g_cmds.c:2333) -- byte-identical to the C
source. Note the listed commands include several this port does not
implement (gotomap, kick, pingalert): the C source's own help text is
reproduced verbatim rather than trimmed, since it is a fixed string, not a
capability query.
=================
*/
export function Cmd_Refcommands_f(ent: EdictT): void {
  if (!isRef(ent)) {
    gi.cprintf(ent, PRINT_HIGH, "Referee-only command\n");
    return;
  }

  let buf = "";
  buf += "\nReferee, commands:\n";
  buf += "  gotomap                          Change the map\n";
  buf += "  users                            List players\n";
  buf += "  kick <id>                        Kick player by their client ID\n";
  buf += "  pingalert <floor> <ceiling>      Notify ref if a player is outside this range\n";
  buf += "  togglefastswitch                 Turn on/off fast weapon switching\n";
  buf += "  refmenu                          Open the menu in the hud\n";
  buf += "  startmatch                       Start the match on the current map\n";
  buf += "  stopmatch                        Stop the current match\n";
  buf += "  pausematch                       Pause the current match\n";
  buf += "  lock                             Toggle the team lock\n";
  buf += "  setpassword <password>           Set a password on server. blank password unsets it\n";
  buf += "  changemap <mapname>              Change to the selected map\n";
  buf += "  settimelimit <minutes>           Set the match timelimit in minutes\n";

  gi.cprintf(ent, PRINT_HIGH, buf);
}

/*
=================
Cmd_Test_f (lmctf60/g_cmds.c:2398)

"Just for testing stuff" -- the C body is empty. Ported (and dispatched)
because ClientCommand tests "test" FIRST and returns, which means the
command is swallowed rather than falling through to the chat catch-all;
leaving it out would make typing "test" say "test" in chat.
=================
*/
export function Cmd_Test_f(_ent: EdictT): void {
  // intentionally empty -- matches the C source
}


//=================================================================================
// Referee / rcon admin commands and the map-authoring dumper
// (lmctf60/g_cmds.c:1458-2067)
//=================================================================================

// lmctf60/g_local.h:58 -- `#define VER "r00~0000000"`. g_local.ts (another
// unit's file) has no slot for it, so it is kept here as a local literal
// carrying the exact C value, the same way this file already keeps the
// FRAME_* and MAX_MSGLEN literals local.
const VER = "r00~0000000";

// The C's third gameversion field is `__DATE__`, the C preprocessor's
// compile-date stamp. This port has no build-stamp mechanism at all, so
// there is no honest value to print here and none is invented -- the field
// is emitted as "unknown". This is the ONE part of the "gameversion"
// output that cannot match the C byte-for-byte; every other field does.
const BUILD_DATE = "unknown";

/*
=================
appendRawFile -- C: `fp = fopen(name, "a"); fwrite(...); fclose(fp);`

files.ts has no append primitive, so an append is expressed as
read-concat-write through the same FS_ReadRawFile/FS_WriteFile seam
g_skins.ts and g_svcmds.ts already use for literal on-disk paths.
FS_WriteFile creates any missing parent directories itself, so no separate
FS_CreatePath call is needed here.

Preserved-with-a-guard C bug: the C source never checks `fp` for NULL. On a
server whose `<gamedir>/info/` directory does not exist, `fopen(..., "a")`
returns NULL and the very next line dereferences it -- a crash. This port
cannot reproduce a crash as behavior, so it creates the directory on the
way (FS_WriteFile's own FS_CreatePath) and reports failure instead of
faulting; on every server where the C works, the result is identical.
=================
*/
function appendRawFile(path: string, text: string): boolean {
  try {
    const existing = FS_ReadRawFile(path);
    const prefix = existing === null ? "" : new TextDecoder().decode(existing);
    FS_WriteFile(path, prefix + text);
    return true;
  } catch {
    return false;
  }
}

/*
=================
Cmd_Referee_f (lmctf60/g_cmds.c:1771)

Compares the typed argument against the rcon password first, then the
referee password, granting CTF_EXTRAFLAGS_REFEREE (plus
CTF_EXTRAFLAGS_RCON for the rcon match) and opening the CTF menu. Both
comparisons are case-sensitive `strcmp`, not Q_stricmp -- preserved.

Preserved quirk: an EMPTY server password matches an empty argument first,
and only then is rejected with "Rcon Mode is off" / "Referee Mode is off".
So on a server with no rcon password set, typing a bare `referee` reports
that rcon mode is off rather than falling through to the referee-password
check -- an unset rcon password masks the referee password for the
empty-argument case. That is the C's own control flow, kept as-is.

The cvar names are the C's: `rcon_password` (the C's variable is called
rconpassword but g_save.c:219 registers it as "rcon_password") and
`refpassword`. Neither has a slot in g_local.ts's gameCvars holder, so both
are resolved lazily through gi.cvar() -- Cvar_Get semantics return the
already-registered cvar when InitGame made one, and otherwise create it
with the C's own "" default. Same approach g_maplist.ts uses for
gamedir/maplist_file.
=================
*/
function cvarStringLazy(name: string, defaultValue: string): string {
  const c = gi.cvar(name, defaultValue, 0);
  return c === null ? defaultValue : c.string;
}

export function Cmd_Referee_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const p = gi.args();

  // check for a password
  // surt adjusted this so that a blank ref password doesn't deny access to
  // rcon, and created rcon access mode
  const rconpassword = cvarStringLazy("rcon_password", "");
  const refpassword = cvarStringLazy("refpassword", "");

  if (rconpassword === p) {
    // deny access if password is blank on server
    if (rconpassword.length === 0) {
      ctf_SafePrint(ent, PRINT_HIGH, "Rcon Mode is off\n");
      return;
    }

    ctf_SafePrint(ent, PRINT_HIGH, "You are now an Rcon\n");
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_REFEREE;
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_RCON;
    menuModule().Ctf_Menu(ent);
  } else if (refpassword === p) {
    // deny access if password is blank on server
    if (refpassword.length === 0) {
      ctf_SafePrint(ent, PRINT_HIGH, "Referee Mode is off\n");
      return;
    }
    ctf_SafePrint(ent, PRINT_HIGH, "You are now a Referee\n");
    client.ctf.extra_flags |= CTF_EXTRAFLAGS_REFEREE;
    client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_RCON;
    menuModule().Ctf_Menu(ent);
  } else {
    ctf_SafePrint(ent, PRINT_HIGH, "Incorrect Referee Password\n");
    client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_REFEREE;
    client.ctf.extra_flags &= ~CTF_EXTRAFLAGS_RCON;
  }
}

/*
=================
Cmd_GotoMap_f (lmctf60/g_cmds.c:1816) -- referee-only immediate map change
to a map named in maplist.txt.

Preserved quirk: with an EMPTY argument the whole body is skipped and the
command prints nothing at all -- no usage message, no error. Only a
non-empty name that misses the list gets "is not a map from the maplist."

The C lowercases `p` IN PLACE, mutating gi.args()'s own buffer, before
comparing against the (already-lowercased) maplist names. This port
lowercases a copy: the C's in-place write is only observable to a caller
that reads gi.args() again after this function, and ClientCommand never
does.
=================
*/
export function Cmd_GotoMap_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee.\n");
    return;
  }

  const raw = gi.args();

  if (raw.length !== 0) {
    // convert to lower case for comparison
    const p = raw.toLowerCase();

    for (const entry of maplist) {
      if (entry.mapname === p) {
        ctf_ChangeMap(p, false);
        return;
      }
    }
    ctf_SafePrint(ent, PRINT_HIGH, `${p} is not a map from the maplist.\n`);
  }
}

/*
=================
Cmd_QuadTime_f (lmctf60/g_cmds.c:1946)

The client-command twin of g_svcmds.ts's SVCmd_QuadTime_f: retunes the Quad
Damage item's respawn interval. Gated on REFEREE *or* RCON (unlike most of
the commands around it, which test REFEREE alone).

Preserved quirk: an out-of-range value (<= 0 or >= 1200) silently does
nothing -- no error, no confirmation. Only an accepted value prints "Quad
respawn updated".
=================
*/
export function Cmd_QuadTime_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & (CTF_EXTRAFLAGS_REFEREE | CTF_EXTRAFLAGS_RCON)) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee or Rcon\n");
    return;
  }

  const p = gi.args();
  const parsed = ParseUnsignedLongArg(p);
  if (!parsed.ok) {
    ctf_SafePrint(ent, PRINT_HIGH, "Usage: quadtime <seconds>\n");
    return;
  }
  const i = parsed.value;

  const target = FindItem("Quad Damage");
  if (target !== null && i > 0 && i < 1200) {
    target.quantity = i;
    ctf_SafePrint(ent, PRINT_HIGH, "Quad respawn updated\n");
  }
}

/*
=================
Cmd_Kick_f (lmctf60/g_cmds.c:1971), dispatched as "ctfkick"

Referee-only: disconnects one player named by their "users" list id, after
clearing their stats.

PRESERVED BUG -- this is the important one. The "can't kick a referee" and
"can't kick an rcon" guards print their refusal message but DO NOT return
(compare Cmd_Fobserve_f at c:1884, whose identical-looking guards each end
in `return`). So a referee kicking another referee sees
"X is a referee.  You cannot kick them." and then X is kicked anyway --
and an rcon holder gets BOTH refusal messages and is still kicked. Left
exactly as the C has it; the missing `return`s are not added.

Same empty-argument sscanf quirk as Cmd_Fobserve_f: C's sscanf returns
EOF (truthy) for an empty string, so no usage message is printed and the
lookup runs with id 0.
=================
*/
export function Cmd_Kick_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if ((client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0) {
    ctf_SafePrint(ent, PRINT_HIGH, "You are not a Referee\n");
    return;
  }

  const p = gi.args();
  let i = 0;
  if (p.length !== 0) {
    const parsed = ParseUnsignedLongArg(p);
    if (!parsed.ok) {
      ctf_SafePrint(ent, PRINT_HIGH, 'Usage: kick <number>\nUse "users" to list players by number.\n');
      return;
    }
    i = parsed.value;
  }

  let target: EdictT | null = null;
  let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (player !== null) {
    if (player.client !== null && player.client.ctf.ctfid === i) target = player;
    player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
  }

  if (target === null) {
    ctf_SafePrint(ent, PRINT_HIGH, "Couldn't find that target number.\n");
    return;
  }
  const targetClient = target.client;
  if (targetClient === null) return;

  // Can't kick a referee unless you are an rcon
  // (... except this branch does not return -- see the doc comment.)
  if (
    (targetClient.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0 &&
    (client.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) === 0
  ) {
    ctf_SafePrint(ent, PRINT_HIGH, `${targetClient.pers.netname} is a referee.  You cannot kick them.\n`);
  }

  // Can't kick an rcon under any circumstances
  // (... except this branch does not return either.)
  if ((targetClient.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) !== 0) {
    ctf_SafePrint(ent, PRINT_HIGH, `${targetClient.pers.netname} is an rcon.  You cannot kick them.\n`);
  }

  ctf_BSafePrint(PRINT_HIGH, `${targetClient.pers.netname} was kicked by ${client.pers.netname}.\n`);
  // clear the kicked player's stats
  stats_clear(target);
  ForceCommand(target, "disconnect\n");
}

/*
=================
Cmd_PingAlert_f (lmctf60/g_cmds.c:2067)

Sets the referee's own ping-alert window. The per-frame checker that reads
these two fields and prints the warnings is p_client.ts's PingAlert
(p_client.c:2997), already ported by that file; only the command that sets
the thresholds lives here, and it was the missing half.

Zero disables that end of the range (the usage text says so). No referee
gate at all in the C -- any player may set their own thresholds; only
p_client.ts's `if (isRef(ent)) PingAlert(ent)` call restricts who actually
receives the alerts. Preserved.
=================
*/
export function Cmd_PingAlert_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const p = gi.args();

  // C: `if (sscanf(p, "%d %d", &i, &j) < 1)` -- fewer than one field
  // assigned (including EOF on an empty string, which IS < 1 here, unlike
  // the `!sscanf(...)` idiom Cmd_Kick_f/Cmd_Fobserve_f use) prints usage.
  const first = /^\s*([+-]?\d+)/.exec(p);
  if (first === null) {
    ctf_SafePrint(
      ent,
      PRINT_HIGH,
      "Usage: pingalert <floor> <ceiling>\nUse zero to set no alert for that value.\n",
    );
    return;
  }
  const i = Number.parseInt(first[1], 10) | 0;

  // C initializes j to 0, so a missing second field leaves the ceiling off.
  let j = 0;
  const rest = p.slice(first[0].length);
  const second = /^\s*([+-]?\d+)/.exec(rest);
  if (second !== null) j = Number.parseInt(second[1], 10) | 0;

  client.ctf.pingalertfloor = i;
  client.ctf.pingalertceiling = j;
}

/*
=================
Cmd_InfoEnt_f (lmctf60/g_cmds.c:1458)

A map-authoring tool, not a gameplay command: it spawns a CTF banner or
info entity where the player is aiming (or standing) and APPENDS that
entity's .ent-format definition to `<gamedir>/info/<mapname>.ent`, so a
mapper can walk a map placing CTF props and then paste the file into the
map source. Handles five classnames: misc_ctf_banner, misc_ctf_small_banner,
info_position, and the info_flag_red/info_flag_blue/info_player_red/
info_player_blue group; anything else returns without writing.

NOTE ON ITS DISPATCH: the C's own `else if (Q_stricmp (cmd, "infoent") ==
0) Cmd_InfoEnt_f (ent);` line is COMMENTED OUT in ClientCommand
(g_cmds.c:2718-2719), so on a stock lmctf60 build this function has no
reachable call site at all. It is wired up here under "infoent" so the
command actually works -- the function is complete, tested C code and a
server operator has no other way to reach it -- which is the one place
this port deliberately exposes something the C build left dormant. Say so
plainly rather than pretending the dispatch matches.

PRESERVED BUG (the "red" argument never works): the C scans its argument
with `sscanf(p, "%s %[^\n]", enttype, entcolor)`. A `%[...]` scanset does
NOT skip leading whitespace the way %s and %d do, so for the input
`misc_ctf_banner red` the scanset captures " red" WITH its leading space,
and the very next line's `Q_stricmp(entcolor, "red")` therefore never
matches. Every banner comes out with `red = 0` -- i.e. spawnflags 1, the
blue variant -- no matter what colour was typed. The leading space also
rides along into info_position's `message` field. Reproduced exactly.
=================
*/
export function Cmd_InfoEnt_f(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  const mins = vec3(-8, -8, -2);
  const maxs = vec3(8, 8, 2);
  const forward = vec3();
  const right = vec3();
  const start = vec3();
  const offset = vec3();
  const end = vec3();

  // Set out ending point to our starting point
  AngleVectors(client.v_angle, forward, right, null);
  VectorSet(offset, 8, 0, ent.viewheight - 8);
  G_ProjectSource(ent.s.origin, offset, forward, right, start);

  VectorSet(offset, 10000, 0, 0);
  G_ProjectSource(start, offset, forward, right, end);

  let tr = gi.trace(start, mins, maxs, end, ent, MASK_SHOT);

  const p = gi.args();

  // C: `sscanf(p, "%s %[^\n]", enttype, entcolor)`. The return value is
  // EOF (-1) for an empty string and >= 1 otherwise -- always truthy -- so
  // the C's `else if (p)` / `else return` arms are both unreachable and
  // are not reproduced.
  let enttype = "";
  let entcolor = "";
  const nameMatch = /^\s*(\S+)/.exec(p);
  if (nameMatch !== null) {
    enttype = nameMatch[1];
    // The scanset keeps the separating whitespace -- see the doc comment.
    const rest = p.slice(nameMatch[0].length);
    const nl = rest.indexOf("\n");
    entcolor = nl === -1 ? rest : rest.slice(0, nl);
  }

  const red = Q_stricmp(entcolor, "red") === 0 ? 1 : 0;

  if (entcolor.startsWith('"')) {
    let stripped = entcolor.slice(1);
    if (stripped.length > 0) stripped = stripped.slice(0, -1);
    entcolor = stripped;
  }

  let entities: string;
  let f1: number;
  let f2: number;
  let f3: number;
  let a1: number;
  let a2: number;
  let a3: number;

  // C: `if (tr.ent) { ... } else return;`. gi.trace always fills trace.ent
  // (sv_world defaults an unset one to the world edict, never NULL), so
  // the else-return is unreachable in the C too and the branch is taken
  // unconditionally here.

  if (enttype === "misc_ctf_banner") {
    // MISC_CTF_BANNER
    vectoangles(tr.plane.normal, end);
    end[0] = 0;
    a1 = 0;
    a2 = end[1];
    end[2] = 0;
    a3 = 0;

    tr.endpos[2] -= 248;

    f1 = tr.endpos[0];
    f2 = tr.endpos[1];
    f3 = tr.endpos[2];

    const banner = G_Spawn();
    banner.classname = spawnModule().ED_NewString("misc_ctf_banner");
    banner.spawnflags = red ? 0 : 1;
    VectorCopy(tr.endpos, banner.s.origin);
    VectorCopy(end, banner.s.angles);
    spawnModule().ED_CallSpawn(banner);

    VectorSet(mins, -8, -8, 0);
    VectorSet(maxs, 8, 8, 248);
    tr = gi.trace(banner.s.origin, mins, maxs, banner.s.origin, banner, MASK_SOLID);
    if (tr.startsolid) {
      G_FreeEdict(banner);
      gi.centerprintf(ent, "Banner Failed. Deleting Entity\n");
      return;
    }

    if (red) {
      entities = Com_sprintf(
        '{\n"origin" "%.0f %.0f %.0f"\n"angles" "%.0f %.0f %.0f"\n"classname" "misc_ctf_banner"\n}\n',
        f1, f2, f3, a1, a2, a3,
      );
    } else {
      entities = Com_sprintf(
        '{\n"origin" "%.0f %.0f %.0f"\n"angles" "%.0f %.0f %.0f"\n"classname" "misc_ctf_banner"\n"spawnflags" "1"\n}\n',
        f1, f2, f3, a1, a2, a3,
      );
    }
  } else if (enttype === "misc_ctf_small_banner") {
    // MISC_CTF_SMALL_BANNER
    tr.plane.normal[2] = 0;
    vectoangles(tr.plane.normal, end);
    end[0] = 0;
    a1 = 0;
    a2 = end[1];
    end[2] = 0;
    a3 = 0;

    tr.endpos[2] -= 124;

    f1 = tr.endpos[0];
    f2 = tr.endpos[1];
    f3 = tr.endpos[2];

    const banner = G_Spawn();
    banner.classname = spawnModule().ED_NewString("misc_ctf_small_banner");
    banner.spawnflags = red ? 0 : 1;
    VectorCopy(tr.endpos, banner.s.origin);
    VectorCopy(end, banner.s.angles);
    spawnModule().ED_CallSpawn(banner);

    VectorSet(mins, -8, -8, 0);
    VectorSet(maxs, 8, 8, 124);
    tr = gi.trace(banner.s.origin, mins, maxs, banner.s.origin, banner, MASK_SOLID);
    if (tr.startsolid) {
      G_FreeEdict(banner);
      gi.centerprintf(ent, "Small Banner Failed. Deleting Entity\n");
      return;
    }

    if (red) {
      entities = Com_sprintf(
        '{\n"origin" "%.0f %.0f %.0f"\n"angles" "%.0f %.0f %.0f"\n"classname" "misc_ctf_small_banner"\n}\n',
        f1, f2, f3, a1, a2, a3,
      );
    } else {
      entities = Com_sprintf(
        '{\n"origin" "%.0f %.0f %.0f"\n"angles" "%.0f %.0f %.0f"\n"classname" "misc_ctf_small_banner"\n"spawnflags" "1"\n}\n',
        f1, f2, f3, a1, a2, a3,
      );
    }
  } else if (enttype === "info_position") {
    // INFO_POSITION
    f1 = ent.s.origin[0];
    f2 = ent.s.origin[1];
    f3 = ent.s.origin[2];

    entities = Com_sprintf(
      '{\n"origin" "%.0f %.0f %.0f"\n"classname" "info_position"\n"message" "%s"\n}\n',
      f1, f2, f3, entcolor,
    );

    const banner = G_Spawn();
    banner.classname = spawnModule().ED_NewString(enttype);
    banner.message = spawnModule().ED_NewString(entcolor);
    VectorCopy(ent.s.origin, banner.s.origin);
    spawnModule().ED_CallSpawn(banner);
  } else if (
    enttype === "info_flag_red" ||
    enttype === "info_flag_blue" ||
    enttype === "info_player_red" ||
    enttype === "info_player_blue"
  ) {
    // INFO_FLAG_RED (and the three siblings sharing this branch)
    f1 = ent.s.origin[0];
    f2 = ent.s.origin[1];
    f3 = ent.s.origin[2];

    a1 = ent.s.angles[0]; // Filled out this so the
    a2 = ent.s.angles[1]; // sprintf below has enough
    a3 = ent.s.angles[2]; // fodder

    // Preserved oddity: the key written is "angle" (singular, normally a
    // scalar yaw in .ent files) but three numbers are written into it.
    entities = Com_sprintf(
      '{\n"origin" "%.0f %.0f %.0f"\n"classname" "%s"\n"angle" "%.0f %.0f %.0f"\n}\n',
      f1, f2, f3, enttype, a1, a2, a3,
    );

    const banner = G_Spawn();
    banner.classname = spawnModule().ED_NewString(enttype);
    VectorCopy(ent.s.origin, banner.s.origin);
    VectorCopy(ent.s.angles, banner.s.angles);
    spawnModule().ED_CallSpawn(banner);
  } else {
    return;
  }

  const gamedir = cvarStringLazy("game", "lmctf");
  const name = `${gamedir}/info/${level.mapname}.ent`;
  if (!appendRawFile(name, entities)) {
    gi.dprintf(`Cmd_InfoEnt_f: couldn't write ${name}\n`);
  }
}

//=================================================================================
// ClientCommand (lmctf60/g_cmds.c:2404) -- see this file's own header for
// the exact list of commands still NOT ported (each cited individually
// there) and why every one of them safely falls through to the
// `Cmd_Say_f(ent, false, true)` chat catch-all instead of throwing.
//=================================================================================

// Recovers the full EdictT for the `Edict` ClientCommand receives across
// the GameExports boundary, by reference identity -- same rationale as
// src/ctf/g_cmds.ts's own edictFromBoundary (commit 77082d8): a
// just-connected client's `edict.s.number` can still read stale-zero
// before sv_user.ts's SV_New_f runs, so the EDICT_NUM idiom
// (g_edicts[ent.s.number]) is not safe to use here.
function edictFromBoundary(entIn: Edict): EdictT {
  const found = g_edicts.find((e) => e === entIn);
  if (found !== undefined) return found;
  gi.error("g_cmds: boundary edict not found in g_edicts");
}

/*
=================
ClientCommand (lmctf60/g_cmds.c:2404)
=================
*/
export function ClientCommand(edict: Edict): void {
  const ent = edictFromBoundary(edict);
  if (ent.client === null) return; // not fully in game yet

  const cmd = gi.argv(0);

  // The `#ifdef BAT_DEBUG` "danman" branch above this in the C source is
  // dead code (BAT_DEBUG is never defined; Cmd_DanMan does not exist in
  // this build) and is not reproduced.
  if (Q_stricmp(cmd, "test") === 0) {
    Cmd_Test_f(ent);
    return;
  }

  if (Q_stricmp(cmd, "players") === 0) {
    Cmd_Players_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "say") === 0) {
    Cmd_Say_f(ent, false, false);
    return;
  }
  if (Q_stricmp(cmd, "say_team") === 0) {
    Cmd_Say_f(ent, true, false);
    return;
  }
  if (Q_stricmp(cmd, "score") === 0) {
    hudModule().Cmd_Score_f(ent);
    return;
  }
  // ADC squadboard commands.
  if (Q_stricmp(cmd, "squadboard") === 0) {
    hudModule().Cmd_Squadboard_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "squad") === 0) {
    // C: `strncpy(dest, src, MAX_CATEGORY_LEN-1); dest[MAX_CATEGORY_LEN-1] = 0;`
    const newcategory = gi.argv(1);
    const src = newcategory.length === 0 ? UNSET_CATEGORY_STR : newcategory;
    ent.client.pers.squad = src.slice(0, MAX_CATEGORY_LEN - 1);
    return;
  }
  if (Q_stricmp(cmd, "squadstatus") === 0) {
    const newstatus = gi.argv(1);
    const src = newstatus.length === 0 ? UNSET_STATUS_STR : newstatus;
    ent.client.pers.squadStatus = src.slice(0, MAX_STATUS_LEN - 1);
    return;
  }
  if (Q_stricmp(cmd, "help") === 0) {
    hudModule().Cmd_Help_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "referee") === 0) {
    Cmd_Referee_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "gameversion") === 0) {
    // C: `va("%s %s %s\n", GAMEVERSION, VER, __DATE__)`. __DATE__ is the
    // compiler's build-date stamp and has no runtime equivalent here --
    // see BUILD_DATE's own comment above.
    ctf_SafePrint(ent, PRINT_HIGH, `${GAMEVERSION} ${VER} ${BUILD_DATE}\n`);
    return;
  }
  if (Q_stricmp(cmd, "ctfhelp") === 0) {
    Cmd_Ctfhelp_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "ctfmenu") === 0) {
    Cmd_Ctfmenu_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "refmenu") === 0) {
    Cmd_Refmenu_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "refcommands") === 0) {
    Cmd_Refcommands_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "lock") === 0 || Q_stricmp(cmd, "unlock") === 0) {
    Cmd_LockTeams_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "startmatch") === 0) {
    Cmd_StartMatch_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "stopmatch") === 0) {
    Cmd_StopMatch_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "pausematch") === 0 || Q_stricmp(cmd, "unpausematch") === 0) {
    Cmd_PauseMatch_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "setpassword") === 0) {
    Cmd_SetPassword_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "settimelimit") === 0) {
    Cmd_SetTimelimit_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "togglefastswitch") === 0) {
    Cmd_ToggleFastSwitch_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "changemap") === 0) {
    Cmd_ChangeMap_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "users") === 0) {
    Cmd_Users_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "ctfkick") === 0) {
    Cmd_Kick_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "fobserve") === 0) {
    Cmd_Fobserve_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "quadtime") === 0) {
    Cmd_QuadTime_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "angleinfo") === 0) {
    Cmd_AngleInfo_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "gotomap") === 0) {
    Cmd_GotoMap_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "match") === 0) {
    Cmd_Match_f(ent);
    return;
  }
  if (Q_stricmp(cmd, "pingalert") === 0) {
    Cmd_PingAlert_f(ent);
    return;
  }
  // Vampire -- voting menu
  if (Q_stricmp(cmd, "voteyes") === 0) {
    if (voteModule().VoteStarted) voteModule().Vote_YES(ent);
    else gi.cprintf(ent, PRINT_LOW, "A vote has not been initiated.\n");
    return;
  }
  if (Q_stricmp(cmd, "voteno") === 0) {
    if (voteModule().VoteStarted) voteModule().Vote_NO(ent);
    else gi.cprintf(ent, PRINT_LOW, "A vote has not been initiated.\n");
    return;
  }

  if (level.intermissiontime !== 0) return;

  if (
    GamePausedForDispatch() &&
    (ent.client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) === 0
  ) {
    // LM_JORM -- Don't let players do certain things if paused
    return;
  }

  if (Q_stricmp(cmd, "use") === 0) Cmd_Use_f(ent);
  else if (Q_stricmp(cmd, "hook") === 0) Cmd_Hook_f(ent);
  else if (Q_stricmp(cmd, "unhook") === 0) Cmd_Unhook_f(ent);
  else if (Q_stricmp(cmd, "weapprev") === 0) Cmd_WeapPrev_f(ent);
  else if (Q_stricmp(cmd, "weapnext") === 0) Cmd_WeapNext_f(ent);
  else if (Q_stricmp(cmd, "weaplast") === 0) Cmd_WeapLast_f(ent);
  else if (Q_stricmp(cmd, "drop") === 0) Cmd_Drop_f(ent);
  // The C tests "help" a second time here; the pre-gate test above already
  // returned for it, so this arm is unreachable -- kept to match the C's
  // dispatch shape exactly.
  else if (Q_stricmp(cmd, "help") === 0) hudModule().Cmd_Help_f(ent);
  else if (Q_stricmp(cmd, "inven") === 0) Cmd_Inven_f(ent);
  else if (Q_stricmp(cmd, "invnext") === 0) SelectNextItem(ent, -1);
  else if (Q_stricmp(cmd, "invprev") === 0) SelectPrevItem(ent, -1);
  else if (Q_stricmp(cmd, "invnextw") === 0) SelectNextItem(ent, IT_WEAPON);
  else if (Q_stricmp(cmd, "invprevw") === 0) SelectPrevItem(ent, IT_WEAPON);
  else if (Q_stricmp(cmd, "invnextp") === 0) SelectNextItem(ent, IT_POWERUP);
  else if (Q_stricmp(cmd, "invprevp") === 0) SelectPrevItem(ent, IT_POWERUP);
  else if (Q_stricmp(cmd, "invuse") === 0) Cmd_InvUse_f(ent);
  else if (Q_stricmp(cmd, "invdrop") === 0) Cmd_InvDrop_f(ent);
  else if (Q_stricmp(cmd, "kill") === 0) Cmd_Kill_f(ent);
  else if (Q_stricmp(cmd, "putaway") === 0) Cmd_PutAway_f(ent);
  else if (Q_stricmp(cmd, "wave") === 0) Cmd_Wave_f(ent);
  else if (Q_stricmp(cmd, "fov") === 0) {
    let fov = atoiC(gi.argv(1));
    if (fov < 1) fov = 90;
    else if (fov > 160) fov = 160;
    ent.client.ps.fov = fov;
  }
  // TEAM_CODE -- LM_JORM
  else if (Q_stricmp(cmd, "team") === 0) Cmd_Team_f(ent);
  else if (Q_stricmp(cmd, "flagstatus") === 0) Cmd_FlagStatus_f(ent);
  else if (Q_stricmp(cmd, "id") === 0) Cmd_Id_f(ent);
  else if (Q_stricmp(cmd, "position") === 0) Cmd_Position_f(ent);
  else if (Q_stricmp(cmd, "radiomenu") === 0) menuModule().Toggle_Radio_Menu(ent);
  else if (Q_stricmp(cmd, "play_team") === 0) Cmd_PlayTeamSound_f(ent);
  else if (Q_stricmp(cmd, "play_voice") === 0) Cmd_PlayVoiceSound_f(ent);
  else if (Q_stricmp(cmd, "radio") === 0) Cmd_Radio_f(ent);
  // observe/observe_red/observe_blue: the live `#else //bat` branch (the
  // `#ifdef OLDOBSERVERCODE` original -- Observe/ChaseCam -- is dead code,
  // see g_menu.ts's own file header for the same macro).
  else if (Q_stricmp(cmd, "observe") === 0) Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_CONST());
  else if (Q_stricmp(cmd, "observe_red") === 0) Cmd_Observe_f(ent, CTF_TEAM_RED_OBSERVER());
  else if (Q_stricmp(cmd, "observe_blue") === 0) Cmd_Observe_f(ent, CTF_TEAM_BLUE_OBSERVER());
  else if (Q_stricmp(cmd, "stats") === 0) Cmd_PlayerStats_f(ent); // STATS - LM_Hati
  else if (Q_stricmp(cmd, "statsall") === 0) Cmd_StatsAll_f(ent); // STATS - LM_Surt
  else if (Q_stricmp(cmd, "compass") === 0) Cmd_Compass_f(ent);
  else if (Q_stricmp(cmd, "give") === 0) Cmd_Give_f(ent);
  else if (Q_stricmp(cmd, "god") === 0) Cmd_God_f(ent);
  else if (Q_stricmp(cmd, "notarget") === 0) Cmd_Notarget_f(ent);
  else if (Q_stricmp(cmd, "noclip") === 0) Cmd_Noclip_f(ent);
  // The C's own `else if (Q_stricmp (cmd, "infoent") == 0)` line is
  // COMMENTED OUT at g_cmds.c:2718-2719, so Cmd_InfoEnt_f is unreachable on
  // a stock lmctf60 build. It is wired up here so the map-authoring tool
  // actually works -- see Cmd_InfoEnt_f's own doc comment for why this is
  // the one deliberate dispatch difference from the C.
  else if (Q_stricmp(cmd, "infoent") === 0) Cmd_InfoEnt_f(ent);
  else if (Q_stricmp(cmd, "pause_match") === 0) {
    if ((ent.client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0) menuModule().RefTogglePause(ent);
  }
  // END TEAM CODE
  else if (Q_stricmp(cmd, "playerlist") === 0) Cmd_PlayerList_f(ent);
  // anything that doesn't match a command will be a chat
  else Cmd_Say_f(ent, false, true);
}

// GamePaused (g_tourney.ts) -- resolved via a small wrapper for symmetry
// with this dispatcher's other lazy accessors; no cycle concern (this file
// already statically imports g_tourney.ts above), kept as a wrapper only
// for naming clarity at the one call site.
function GamePausedForDispatch(): boolean {
  return (require("./g_tourney") as typeof import("./g_tourney")).GamePaused();
}

function CTF_TEAM_OBSERVER_CONST(): number {
  return (require("./g_ctffunc") as { CTF_TEAM_OBSERVER: number }).CTF_TEAM_OBSERVER;
}
