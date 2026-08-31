// Ports lmctf60/g_cmds.c (diff vs quake-2/ctf/g_cmds.c is 2542 lines of
// 2742 total -- almost a full rewrite).
//
// STATUS: this unit's second pass. In addition to the first pass's
// OnSameTeam/ForceCommand/Cmd_Hook_f/Cmd_Unhook_f/SelectNextItem/
// ValidateSelectedItem, this pass ports: SelectPrevItem, the generic
// inventory/weapon/item commands (Cmd_Give_f, Cmd_God_f, Cmd_Notarget_f,
// Cmd_Noclip_f, Cmd_Use_f, Cmd_Drop_f, Cmd_Inven_f, Cmd_InvUse_f,
// Cmd_WeapPrev_f, Cmd_WeapNext_f, Cmd_WeapLast_f, Cmd_InvDrop_f,
// Cmd_Kill_f, Cmd_PutAway_f, Cmd_Wave_f, Cmd_Players_f, Cmd_Users_f,
// Cmd_Say_f), the team-switch chain (Team_Change, Drop_All, Cmd_Team_f,
// Cmd_Observe_f, Cmd_FlagStatus_f), the referee/match admin commands
// (Cmd_LockTeams_f, Cmd_StartMatch_f, Cmd_StopMatch_f, Cmd_PauseMatch_f,
// Cmd_SetPassword_f, Cmd_SetTimelimit_f, Cmd_ChangeMap_f,
// Cmd_ToggleFastSwitch_f), PlayTeamSound/PlayVoiceSound (+
// Cmd_PlayTeamSound_f/Cmd_PlayVoiceSound_f/ValidateSoundName), and
// ClientCommand's real argv(0) dispatch table (moved here from
// g_main.ts's placeholder, matching src/ctf/g_cmds.ts's own
// ClientCommand-lives-here convention).
//
// STILL NOT PORTED, reported explicitly (out of this pass's SCOPE, cited
// individually so a future pass has exact pointers): Cmd_Referee_f/
// Cmd_Kick_f/Cmd_Users_f's ctfkick companion/Cmd_GotoMap_f/Cmd_Match_f/
// Cmd_PingAlert_f/Cmd_Fobserve_f/Cmd_QuadTime_f/Cmd_Refcommands_f
// (referee/admin commands needing either password-prompt state machines or
// the maplist.txt parser g_main.ts's own header already documents as
// unported); Cmd_InfoEnt_f (a ~250-line debug entity dumper); Cmd_Id_f/
// Cmd_Position_f/Cmd_AngleInfo_f (crosshair debug readouts); Cmd_Ctfhelp_f/
// Cmd_Ctfmenu_f/Cmd_Refmenu_f (thin wrappers this file could add trivially,
// but their targets -- Ctf_Menu/Ref_Main_Load, g_menu.ts -- are unit B's
// own menu-system SCOPE, not re-derived here to avoid duplicating that
// unit's dispatch); Cmd_Radio_f/Cmd_Compass_f (text-command variants of the
// already-ported PlayTeamSound path); Cmd_PlayerList_f/voteyes/voteno
// (g_vote.ts's own SCOPE). Every one of these still falls through
// ClientCommand's final `else Cmd_Say_f(ent, false, true)` chat catch-all,
// exactly matching a real server's behavior for an unrecognized command
// (not a crash, just "said" as chat text) -- so no unhandled command can
// ever throw from this dispatcher.

import { ATTN_IDLE, ATTN_NORM, CHAN_AUTO, CHAN_ITEM, Com_sprintf, Info_ValueForKey, MAX_INFO_STRING, MAX_ITEMS, PMF_DUCKED, PRINT_CHAT, PRINT_HIGH, Q_stricmp, STAT_FRAGS } from "../shared/q_shared";
import { vec3_origin } from "../shared/math";
import {
  CTF_SPAM_BAND_RADIO,
  CTF_SPAM_BAND_SAY,
  CTF_SPAM_BAND_VOICE,
  CTF_TEAM_BLUE,
  CTF_TEAM_IGNORETEAM,
  CTF_TEAM_RED,
  ctf_ChangeMap,
  ctf_findplayer,
  ctf_SafePrint,
  ctf_hook_abort,
  ctf_SetEntTeam,
  ctf_SpamCheck,
} from "./g_ctffunc";
import { FindItem, GetItemByIndex, ITEM_INDEX, itemlist, SpawnItem, Touch_Item } from "./g_items";
import { G_FreeEdict, G_Spawn } from "./g_utils";
import { replace_flaginfo, string_replace } from "./g_replace";
import {
  type EdictT,
  CTF_EXTRAFLAGS_RADIO_SOUND,
  CTF_EXTRAFLAGS_RADIO_TEXT,
  CTF_EXTRAFLAGS_RCON,
  CTF_EXTRAFLAGS_REFEREE,
  CTF_OFFHAND_HOOK,
  CTF_TEAM_NOSWITCH,
  CTF_TEAM_NOTEAMS,
  FL_GODMODE,
  FL_NOTARGET,
  g_edicts,
  game,
  gameCvars,
  gi,
  isRef,
  IT_AMMO,
  IT_ARMOR,
  IT_POWERUP,
  IT_WEAPON,
  level,
  MOD_SUICIDE,
  meansOfDeathHolder,
  MovetypeT,
  svc_inventory,
  svc_layout,
  svc_stufftext,
} from "./g_local";
import { ChaseNext, Team_Observer_OK } from "./g_chase";
import { matchstate, MatchStatesT, KillMatch, SpawnTourneyClock } from "./g_tourney";
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
  // score/squadboard/squad/squadstatus: Cmd_Score_f (p_hud.c)/ADC
  // squadboard fields -- not ported anywhere in this port (p_hud.ts's own
  // SCOPE, see that file's header; squad/squadStatus fields don't exist on
  // ClientPersistentT either), falls through to the chat catch-all below.
  // referee/ctfhelp/ctfmenu/refmenu/refcommands/gotomap/match/pingalert/
  // fobserve/quadtime/angleinfo/id/position/compass/playerlist/voteyes/
  // voteno: all NOT ported (see this file's header for the exact reason
  // per command) -- deliberately left OUT of this dispatch table so each
  // falls through to the `Cmd_Say_f(ent, false, true)` catch-all at the
  // bottom, exactly matching a real server's behavior for an unrecognized
  // command (never a throw).
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
  else if (Q_stricmp(cmd, "radiomenu") === 0) menuModule().Toggle_Radio_Menu(ent);
  else if (Q_stricmp(cmd, "play_team") === 0) Cmd_PlayTeamSound_f(ent);
  else if (Q_stricmp(cmd, "play_voice") === 0) Cmd_PlayVoiceSound_f(ent);
  // observe/observe_red/observe_blue: the live `#else //bat` branch (the
  // `#ifdef OLDOBSERVERCODE` original -- Observe/ChaseCam -- is dead code,
  // see g_menu.ts's own file header for the same macro).
  else if (Q_stricmp(cmd, "observe") === 0) Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_CONST());
  else if (Q_stricmp(cmd, "observe_red") === 0) Cmd_Observe_f(ent, CTF_TEAM_RED_OBSERVER());
  else if (Q_stricmp(cmd, "observe_blue") === 0) Cmd_Observe_f(ent, CTF_TEAM_BLUE_OBSERVER());
  else if (Q_stricmp(cmd, "give") === 0) Cmd_Give_f(ent);
  else if (Q_stricmp(cmd, "god") === 0) Cmd_God_f(ent);
  else if (Q_stricmp(cmd, "notarget") === 0) Cmd_Notarget_f(ent);
  else if (Q_stricmp(cmd, "noclip") === 0) Cmd_Noclip_f(ent);
  else if (Q_stricmp(cmd, "pause_match") === 0) {
    if ((ent.client.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0) menuModule().RefTogglePause(ent);
  }
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
