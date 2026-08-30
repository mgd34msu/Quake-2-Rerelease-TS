// Ports a SUBSET of lmctf60/g_cmds.c (diff vs quake-2/ctf/g_cmds.c is 2542
// lines of 2742 total -- almost a full rewrite; ~30 client commands live
// here that this port does not touch).
//
// STATUS: only OnSameTeam, ForceCommand, Cmd_Hook_f, and Cmd_Unhook_f are
// ported -- the offhand-hook priority feature's command-dispatch layer.
// Every other g_cmds.c command (ctfmenu, play_team, team, flagstatus, id,
// position, radiomenu, radio, ready/notready, the referee/vote/squad
// commands, item/weapon switching, say/say_team, kill, give, god, noclip,
// etc.) is NOT ported. ClientCommand's actual argv(0)-dispatch switch table
// (which would route a client's "+hook"/"-hook"/"hook"/"unhook" console
// input to the functions below) also lives in g_cmds.c and is not ported
// here -- see g_main.ts's InitGame for how this unit wires the two
// commands it does implement without the full dispatch table.

import { ATTN_NORM, CHAN_ITEM, MAX_INFO_STRING, PRINT_HIGH } from "../shared/q_shared";
import { ctf_SafePrint, ctf_hook_abort } from "./g_ctffunc";
import { FindItem, ITEM_INDEX } from "./g_items";
import {
  type EdictT,
  CTF_OFFHAND_HOOK,
  CTF_TEAM_NOTEAMS,
  MovetypeT,
  gameCvars,
  gi,
  level,
  svc_stufftext,
} from "./g_local";
// Lazy require, not a static import: p_weapon.ts (Weapon_Hook_Fire) ->
// g_combat.ts (T_Damage) -> g_cmds.ts (OnSameTeam) -> g_items.ts (this
// file only needs FindItem/ITEM_INDEX from there, no cycle) would close a
// value cycle back to this file if Weapon_Hook_Fire were imported
// statically. Per PORTING.md's import-cycle rule, the command-dispatch
// layer (this file) is the "less fundamental" side and breaks the cycle.

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
