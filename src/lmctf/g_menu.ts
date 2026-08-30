// Ports lmctf60/g_menu.c (2139 lines) + g_menu.h -- LM_CTF's in-game popup
// menu system (the `menu`/`chasecam`/`radiomenu` console commands' target,
// and every referee/admin submenu). Replaces ZOID's pmenuhnd_t entirely
// (g_local.ts's MenuItemT/localmenu doc comment already notes this).
//
// STATUS: complete for every LIVE function. Two classes of C source are
// intentionally NOT ported, both per PORTING.md's "#if 0 blocks are
// dropped silently" rule (an always-false `#ifdef` is functionally
// identical to `#if 0`):
//   - The `#ifdef OLDOBSEVERCODE` (sic -- a typo of OLDOBSERVERCODE,
//     defined nowhere either) block wrapping ChaseCam/Obs_CamLock_Exec/
//     Obs_Reverse_Exec and the OLDOBSERVERCODE-only Observe/Observe_Exec/
//     Obs_Main_Menu bodies. The live `#else //bat` bodies (Observe/
//     Observe_Red/Observe_Blue/Observe_Exec/Obs_Main_Menu) are ported.
//   - Three fully-commented-out functions (a stale duplicate Help_Menu,
//     Command_Menu, SetMatchBMap/SetBMap) and the `WEAP_BALANCE_OK`/
//     `NOVOICE_OK` `#ifdef` fragments inside Ref_CTFFlags_Menu (both
//     macros defined nowhere) -- the live Ref_CTFFlags_Menu below reflects
//     exactly which Menu_Set slot each flag line lands on with those
//     fragments removed (notably: "Offhand Hook" ends up in slot 7, not 6,
//     because the NOVOICE_OK block that would have used slot 6 never
//     compiles -- a real, easy-to-miss quirk, preserved exactly).
//
// Cross-dependencies into files this unit does not own (g_cmds.ts/
// p_client.ts/g_ctffunc.ts/g_tourney.ts/g_main.ts/g_utils.ts foundation
// completions owned by unit A) stay local throwing stubs cited at their
// use sites below, per .orch/preferences.md rule 12 -- EXCEPT
// G_CopyString, which (like g_skins.ts's CopyString and g_spawn.c's
// ED_NewString elsewhere in this port) is a pure strdup with exactly one
// possible correct behavior in a language with no manual memory
// management; Menu_Set below reproduces it inline (`text` unchanged)
// instead of stubbing a function whose entire body would be "return the
// input", since a real g_utils.ts G_CopyString could never disagree with
// that.
//
// `helptext`/`maplist`/`maplistindex`/`shortList` are runtime state
// g_save.c populates by parsing config files at startup (not static C
// data -- confirmed by reading g_save.c's assignments into them) --
// neither a function this port can stub nor data this port can inline.
// They stay local, empty-by-default module state here (matching the
// server's real state before any config has ever been read), swappable
// for g_main.ts's real copies once unit A lands them; every function that
// reads them degrades to "no entries" rather than throwing, since an
// empty result is exactly what the real server shows before startup
// config parsing completes.
//
// `refset`/`fastswitch`/`server_file` cvars (registered by g_save.c,
// unit A's pending file) are likewise local stand-ins carrying their C
// defaults ("0", "0", "server.cfg"). SaveServer_Exec's file I/O goes
// through src/qcommon/files.ts's FS_LoadFile/FS_WriteFile (the sanctioned
// FS seam -- same channel g_skins.ts/g_save.ts use), not gi.TagMalloc+fopen.

import { FS_LoadFile, FS_WriteFile } from "../qcommon/files";
import { Com_sprintf, DF_ALLOW_EXIT, DF_FIXED_FOV, DF_FORCE_RESPAWN, DF_INFINITE_AMMO, DF_INSTANT_ITEMS, DF_MODELTEAMS, DF_NO_ARMOR, DF_NO_FALLING, DF_NO_FRIENDLY_FIRE, DF_NO_HEALTH, DF_NO_ITEMS, DF_QUAD_DROP, DF_SAME_LEVEL, DF_SKINTEAMS, DF_SPAWN_FARTHEST, DF_WEAPONS_STAY, PRINT_HIGH, va } from "../shared/q_shared";
import {
  CTF_TEAM_BLUE,
  CTF_TEAM_IGNORETEAM,
  CTF_TEAM_OBSERVER,
  CTF_TEAM_OBSERVER_BLUE,
  CTF_TEAM_OBSERVER_RED,
  CTF_TEAM_RED,
  CTF_TEAM_UNDEFINED,
  ctf_findplayer,
  ctf_SafePrint,
} from "./g_ctffunc";
import {
  CTF_ALLOW_INVULN,
  CTF_EXTRAFLAGS_RCON,
  CTF_EXTRAFLAGS_REFEREE,
  CTF_FLAGS_NOFLAGS,
  CTF_NO_GRAP_DAMAGE,
  CTF_OFFHAND_HOOK,
  CTF_RANDOM_DEATH_MSG,
  CTF_RANDOM_MAPS,
  CTF_RANDOM_QUAD,
  CTF_SCORE_BALANCE,
  CTF_TEAM_ARMOR_PROTECT,
  CTF_TEAM_NOSWITCH,
  CTF_TEAM_NOTEAMS,
  CTF_TEAM_RESET,
  CTF_VOTEMENU_OFF,
  type EdictT,
  blueflag,
  game,
  gameCvars,
  gi,
  level,
  redflag,
  svc_layout,
} from "./g_local";
import { FindItem } from "./g_items";
import { GamePaused, Match_Mode } from "./g_tourney";
import { SkinGetList, SkinListInUse } from "./g_skins";
import { ForceCommand } from "./g_cmds";

// lmctf60/g_menu.h:12-18
export const MENU_LOCAL = 0;
export const MENU_MAIN = 1;
export const MENU_SKIN = 2;
export const MENU_HELP = 3;
export const MENU_HOWTOPLAY = 4;
export const MENU_COMMAND = 5;
export const MENU_RADIO = 6;

// lmctf60/q_shared.h (refset bits) -- not yet exported anywhere in this
// tree (g_local.ts doesn't have them; the ctfflags/DF_* bit sets do exist
// there/in q_shared.ts and are imported for real above).
const CTF_RED_FLAG_FROZEN = 1;
const CTF_BLUE_FLAG_FROZEN = 2;

export interface MenuItem {
  text: string | null;
  func: ((ent: EdictT) => void) | null;
}

export interface MenuData {
  menu: MenuItem[] | null;
  size: number;
}

// ---------------------------------------------------------------------
// Cross-dependencies into files this unit does not own. Unit A owns
// g_cmds.ts (Cmd_Team_f/Team_Change/Cmd_ToggleFastSwitch_f/Drop_All/
// PlayTeamSound/PlayVoiceSound), p_client.ts (not yet created --
// Cmd_Observe_f/TeamJoin/ClientSetSkin), g_ctffunc.ts (ctf_ChangeMap/
// ctf_validateflags), and g_tourney.ts (StartMatch/KillMatch/SetPause --
// only Match_Mode/GamePaused exist there today). Each stub throws if
// actually invoked and cites its C source plus owner.
// ---------------------------------------------------------------------

function Cmd_Team_f(_ent: EdictT): void {
  throw new Error("Cmd_Team_f not yet ported (lmctf60/g_cmds.c; owned by unit A's g_cmds.ts completion)");
}

function Team_Change(_ent: EdictT, _newnum: number): void {
  throw new Error("Team_Change not yet ported (lmctf60/g_cmds.c; owned by unit A's g_cmds.ts completion)");
}

function Cmd_ToggleFastSwitch_f(_ent: EdictT): void {
  throw new Error("Cmd_ToggleFastSwitch_f not yet ported (lmctf60/g_cmds.c; owned by unit A's g_cmds.ts completion)");
}

function Drop_All(_ent: EdictT): void {
  throw new Error("Drop_All not yet ported (lmctf60/g_cmds.c:1065, the live definition; owned by unit A's g_cmds.ts completion)");
}

function PlayTeamSound(_ent: EdictT, _sound: string): void {
  throw new Error("PlayTeamSound not yet ported (lmctf60/g_cmds.c; owned by unit A's g_cmds.ts completion)");
}

function PlayVoiceSound(_ent: EdictT, _sound: string): void {
  throw new Error("PlayVoiceSound not yet ported (lmctf60/g_cmds.c; owned by unit A's g_cmds.ts completion)");
}

function Cmd_Observe_f(_ent: EdictT, _observerType: number): void {
  throw new Error("Cmd_Observe_f not yet ported (lmctf60/p_client.c; owned by unit A's pending p_client.ts)");
}

function TeamJoin(_ent: EdictT): void {
  throw new Error("TeamJoin not yet ported (lmctf60/p_client.c; owned by unit A's pending p_client.ts)");
}

function ClientSetSkin(_ent: EdictT, _skin: string): void {
  throw new Error("ClientSetSkin not yet ported (lmctf60/p_client.c; owned by unit A's pending p_client.ts)");
}

function ctf_ChangeMap(_mapname: string | null, _immediate: boolean): void {
  throw new Error("ctf_ChangeMap not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

function ctf_validateflags(): void {
  throw new Error("ctf_validateflags not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

function StartMatch(_mapname: string | null): void {
  throw new Error("StartMatch not yet ported (lmctf60/g_tourney.c; owned by unit A's g_tourney.ts completion)");
}

function KillMatch(): void {
  throw new Error("KillMatch not yet ported (lmctf60/g_tourney.c; owned by unit A's g_tourney.ts completion)");
}

function SetPause(_pause: boolean): void {
  throw new Error("SetPause not yet ported (lmctf60/g_tourney.c; owned by unit A's g_tourney.ts completion)");
}

// ---------------------------------------------------------------------
// Local stand-ins for cvars g_save.c registers (unit A's pending
// g_save.ts) -- carry the exact C defaults so behavior is unchanged once
// real cvars replace them.
// ---------------------------------------------------------------------
let refsetValue = 0; // lmctf60/g_save.c: `gi.cvar("refset", "0", CVAR_SERVERINFO)`
let fastswitchValue = 0; // lmctf60/g_save.c: `gi.cvar("fastswitch", "0", 0)`
let serverFileName = "server.cfg"; // lmctf60/g_save.c: `gi.cvar("server_file", "server.cfg", 0)`

// ---------------------------------------------------------------------
// Local stand-ins for g_save.c-populated runtime state (see file header).
// ---------------------------------------------------------------------
export interface MapInfoT {
  mapname: string | null;
  minplayers: number;
  maxplayers: number;
  next: MapInfoT | null;
}

let helptext: string[] = [];
let maplist: MapInfoT[] = [];
let maplistindex = 0;
let shortList: MapInfoT | null = null;

/*
=================
Menus (lmctf60/g_menu.c:89-244)
=================
*/

const mainmenu: MenuItem[] = [
  { text: "LM CTF Option Menu", func: null },
  { text: "------------------", func: null },
  { text: "", func: null },
  // Vote menu (lmctf60/g_vote.c) closes a cycle with this file (g_vote.ts
  // statically imports Menu_Free/Menu_Set/Menu_Draw/Main_Menu from here,
  // used only inside its own function bodies, never at its own
  // module-evaluation time -- safe). This file's own top-level `mainmenu`
  // array literal DOES need Vote_Menu's value at module-evaluation time,
  // so it is resolved lazily instead of via a static import, same
  // "break the cycle on the side that needs the value eagerly" rule
  // g_items.ts's Weapon_Hook lazy require already established in this
  // codebase.
  { text: "Become Observer", func: Observe },
  { text: "Change Team", func: Cmd_Team_f },
  { text: "Change Skin", func: Skin_Menu },
  {
    text: "Vote menu",
    func: (ent: EdictT): void => {
      (require("./g_vote") as { Vote_Menu: (ent: EdictT) => void }).Vote_Menu(ent);
    },
  }, // Vampire - voting menu
  { text: "", func: null },
  { text: "Help", func: Help_Menu },
];

const skinmenu: MenuItem[] = [
  { text: "Male", func: null },
  { text: "     Skin 1", func: SetOldSkin },
  { text: "     Skin 2", func: SetOldSkin },
  { text: "     Skin 3", func: SetOldSkin },
  { text: "", func: null },
  { text: "Female", func: null },
  { text: "     Skin 1", func: SetOldSkin },
  { text: "     Skin 2", func: SetOldSkin },
];

const helpmenu: MenuItem[] = [
  { text: "LM CTF Help Menu", func: null },
  { text: "------------------", func: null },
  { text: "", func: null },
  { text: "How to Play", func: HowToPlay_Menu },
  { text: "Commands", func: null }, // Command_Menu },
  { text: "Radio Sounds", func: Radio_Menu },
  { text: "", func: null },
  { text: "Main Menu", func: Main_Menu },
];

const howtoplaymenu: MenuItem[] = [
  { text: "How to Play", func: null },
  { text: "------------", func: null },
  { text: "Two teams, red and blue, ", func: null },
  { text: "each attempt to steal the", func: null },
  { text: "opposing team's flag and ", func: null },
  { text: "return it to their own   ", func: null },
  { text: "base, where they must    ", func: null },
  { text: "touch it to their own    ", func: null },
  { text: "flag.  If their own flag ", func: null },
  { text: "is taken, they must kill ", func: null },
  { text: "the enemy flag carrier,  ", func: null },
  { text: "and touch their flag to  ", func: null },
  { text: "return it home.", func: null },
  { text: "", func: null },
  { text: "Help Menu", func: Help_Menu },
];

// f (lmctf60/g_menu.c:329) -- a no-op placeholder function used by
// commandmenu[]'s entries (they're informational text lines only; the C
// source gives them a real, callable no-op instead of NULL so Menu_Draw's
// "skip rows with no func" logic still shows them).
function f(_ent: EdictT): void {}

const commandmenu: MenuItem[] = [
  { text: "LM CTF Command List", func: null },
  { text: "-------------------", func: null },
  { text: "ctfmenu", func: f },
  { text: "play_team <sound>", func: f },
  { text: "radio <off/text/on/both>", func: f },
  { text: "team <red/blue>", func: f },
  { text: "flagstatus", func: f },
  { text: "+hook", func: f },
  { text: "-hook", func: f },
  { text: "observer", func: f },
  { text: "chasecam", func: f },
  { text: "radiomenu", func: f },
  { text: "", func: null },
  { text: "Help Menu", func: Help_Menu },
];

const radiosound = [
  "attack",
  "attack10",
  "capit",
  "clear",
  "defense",
  "escort",
  "incoming",
  "overrun",
  "q60",
  "qattack",
  "quad",
  "qwaiting",
  "ready",
  "recover",
  "regroup",
  "roger",
  "status",
  "work",
];

const radiomenu: MenuItem[] = radiosound.map((sound) => ({ text: sound, func: PickSound }));

const menulist: MenuData[] = [
  { menu: null, size: 0 }, // LOCAL MENU -- Should not be used
  { menu: mainmenu, size: 9 }, // Vampire -- voting menu - increase from 8 to 9 to include the new menuitem
  { menu: skinmenu, size: 8 },
  { menu: helpmenu, size: 8 },
  { menu: howtoplaymenu, size: 15 },
  { menu: commandmenu, size: 14 },
  { menu: radiomenu, size: 18 },
];

const skin = ["", "male/rb-rm1", "male/rb-rm2", "male/rb-rm3", "", "", "female/rb-rf1", "female/rb-rf2"];

/*
=================
Ctf_Menu (lmctf60/g_menu.c:248)
=================
*/
export function Ctf_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ctf_Menu: ent.client is null (lmctf60/g_menu.c:252 dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  cl.showscores = false;
  cl.showhelp = false;
  cl.showinventory = false;
  cl.showmod = false;
  cl.showctfhud = false;
  cl.showsquadboard = false; // ADC

  if (cl.showmenu) {
    cl.showmenu = false;
    Menu_Blank(ent);
    return;
  }

  cl.showmenu = true;
  Main_Menu(ent);
}

/*
=================
Main_Menu (lmctf60/g_menu.c:273)
=================
*/
export function Main_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Main_Menu: ent.client is null (lmctf60/g_menu.c:277 dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  Menu_Free(ent);
  cl.menu = MENU_LOCAL;
  cl.menuselect = 1;

  Menu_Set(ent, 0, "LM CTF Option Menu", Help_Menu);
  Menu_Set(ent, 1, "------------------", null);
  //-bat
  //put back in
  //#ifdef OLDOBSERVERCODE
  if (cl.ctf.teamnum === CTF_TEAM_OBSERVER || cl.ctf.teamnum === CTF_TEAM_OBSERVER_RED || cl.ctf.teamnum === CTF_TEAM_OBSERVER_BLUE) {
    Menu_Set(ent, 3, "Observer Options", Obs_Main_Menu);
  } else {
    Menu_Set(ent, 3, "Become Observer", Observe_Exec);
    Menu_Set(ent, 4, "Change Team", Change_Team_Exec);
  }
  //#else
  //	Menu_Set(ent, 4, "Change Team", Change_Team_Exec);
  //#endif
  Menu_Set(ent, 5, "Change Skin", Skin_Menu);
  Menu_Set(ent, 6, "Radio Sounds", Radio_Menu);
  Menu_Set(ent, 7, "Voice Sounds", Voice_Menu);
  if (((gameCvars.ctfflags?.value ?? 0) & CTF_VOTEMENU_OFF) === 0) {
    Menu_Set(ent, 8, "Voting Menu", (entArg: EdictT): void => {
      (require("./g_vote") as { Vote_Menu: (ent: EdictT) => void }).Vote_Menu(entArg);
    }); //Vampire -- voting menu
  }
  if ((cl.ctf.extra_flags & CTF_EXTRAFLAGS_REFEREE) !== 0) {
    Menu_Set(ent, 9, "Referee Menu", Ref_Main_Menu);
  }
  Menu_Set(ent, 10, "Help", Help_Menu);

  cl.menuselect = 0;

  Menu_Draw(ent);
}

/*
=================
Skin_Old_Menu (lmctf60/g_menu.c:315)
=================
*/
export function Skin_Old_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Skin_Old_Menu: ent.client is null (lmctf60/g_menu.c:319 dereferences ent->client unconditionally)");
  }
  ent.client.menu = MENU_SKIN;
  ent.client.menuselect = 1;

  Menu_Draw(ent);
}

/*
=================
SetOldSkin (lmctf60/g_menu.c:334)
=================
*/
export function SetOldSkin(ent: EdictT): void {
  if (ent.client === null) return;
  const chosen = skin[ent.client.menuselect] ?? "";
  ent.client.pers.userinfo = setInfoValue(ent.client.pers.userinfo, "skin", chosen);
  ClientSetSkin(ent, chosen);
}

// Info_SetValueForKey (q_shared.ts) mutates a copy and returns it; matches
// the C source's in-place `Info_SetValueForKey(ent->client->pers.userinfo,
// "skin", skin[...])` by reassigning the field with the result.
function setInfoValue(userinfo: string, key: string, value: string): string {
  const mod = require("../shared/q_shared") as { Info_SetValueForKey: (s: string, k: string, v: string) => string };
  return mod.Info_SetValueForKey(userinfo, key, value);
}

/*
=================
SetSkin (lmctf60/g_menu.c:341)
=================
*/
export function SetSkin(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("SetSkin: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  const i = ent.client.menuselect - 2 + ent.client.menupage * 15;

  const skinlist = SkinGetList(ent);

  ClientSetSkin(ent, skinlist[i] ?? "");
  ent.client.currmenu = Skin_Menu;
  ent.client.menupage = 0;
  Skin_Menu(ent);
}

/*
=================
Skin_Menu (lmctf60/g_menu.c:356)
=================
*/
export function Skin_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Skin_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }

  if (!SkinListInUse()) {
    Skin_Old_Menu(ent);
    return;
  }

  // Calculate our page
  let start = 15 * ent.client.menupage;

  const skinlist = SkinGetList(ent);

  // Find if last page was the last
  if (start > 14) {
    for (let i = start - 15; i < start; i++) {
      if (skinlist[i] === undefined) {
        // Last entry
        start = 0; // Go to first page
        ent.client.menupage = 0;
      }
    }
  }

  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  if (ent.client.ctf.teamnum === CTF_TEAM_RED) {
    Menu_Set(ent, 0, "LMCTF Red Skins", Main_Menu);
    Menu_Set(ent, 1, "---------------", null);
  } else {
    Menu_Set(ent, 0, "LMCTF Blue Skins", Main_Menu);
    Menu_Set(ent, 1, "----------------", null);
  }

  let j = 2;
  for (let i = start; skinlist[i] !== undefined && j < 17; i++, j++) {
    Menu_Set(ent, j, skinlist[i] ?? "", SetSkin);
  }

  Menu_Set(ent, 17, "<next page>", Skin_Menu);

  Menu_Draw(ent);
}

/*
=================
Observe / Observe_Red / Observe_Blue / Observe_Exec (lmctf60/g_menu.c:486,
the live `#else //bat` branch)
=================
*/
export function Observe(ent: EdictT): void {
  Cmd_Observe_f(ent, CTF_TEAM_OBSERVER);
}

export function Observe_Red(ent: EdictT): void {
  Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_RED);
}

export function Observe_Blue(ent: EdictT): void {
  Cmd_Observe_f(ent, CTF_TEAM_OBSERVER_BLUE);
}

export function Observe_Exec(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Observe_Exec: ent.client is null (lmctf60/g_menu.c:504 dereferences ent->client unconditionally)");
  }
  if (ent.client.ctf.teamnum <= CTF_TEAM_OBSERVER) {
    TeamJoin(ent);
  } else {
    Observe(ent);
  }

  Ctf_Menu(ent);
}

/*
=================
HowToPlay_Menu (lmctf60/g_menu.c:528)
=================
*/
export function HowToPlay_Menu(ent: EdictT): void {
  if (ent.client === null) return;
  ent.client.menu = MENU_HOWTOPLAY;
  ent.client.menuselect = 1;

  Menu_Draw(ent);
}

/*
=================
Toggle_Radio_Menu (lmctf60/g_menu.c:559)
=================
*/
export function Toggle_Radio_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Toggle_Radio_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  cl.showscores = false;
  cl.showhelp = false;
  cl.showinventory = false;
  cl.showmod = false;
  cl.showctfhud = false;
  cl.showsquadboard = false; // ADC

  if (cl.showmenu) {
    cl.showmenu = false;
    Menu_Blank(ent);
    return;
  }

  cl.showmenu = true;
  Radio_Menu(ent);
}

/*
=================
Radio_Menu (lmctf60/g_menu.c:583)
=================
*/
export function Radio_Menu(ent: EdictT): void {
  if (ent.client === null) return;
  ent.client.menu = MENU_RADIO;
  ent.client.menuselect = 1;

  Menu_Draw(ent);
}

/*
=================
PickSound (lmctf60/g_menu.c:595)
=================
*/
export function PickSound(ent: EdictT): void {
  if (ent.client === null) return;
  const sound = radiosound[ent.client.menuselect];
  if (sound !== undefined) PlayTeamSound(ent, sound);

  ent.client.showmenu = false;
  Menu_Blank(ent);
}

/*
=================
Obs_Main_Menu (lmctf60/g_menu.c:639, the live `#else //bat` branch)
=================
*/
export function Obs_Main_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Obs_Main_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }

  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 1;

  Menu_Set(ent, 1, "LMCTF Observer Menu", null);
  Menu_Set(ent, 2, "-------------------", null);
  Menu_Set(ent, 4, "Play CTF", Observe_Exec);

  Menu_Set(ent, 6, "Observe Red", Observe_Red);
  Menu_Set(ent, 7, "Observe_Blue", Observe_Blue);
  Menu_Set(ent, 8, "Observe_All", Observe);

  Menu_Set(ent, 10, "Help", Help_Menu);

  Menu_Draw(ent);
}

/*
=================
Ref_Main_Load (lmctf60/g_menu.c:667)
=================
*/
export function Ref_Main_Load(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Main_Load: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  cl.showscores = false;
  cl.showhelp = false;
  cl.showinventory = false;
  cl.showmod = false;
  cl.showctfhud = false;
  cl.showsquadboard = false; // ADC

  if (cl.showmenu) {
    cl.showmenu = false;
    Menu_Blank(ent);
    return;
  }

  cl.showmenu = true;

  cl.menu = MENU_LOCAL;
  cl.menuselect = 1;

  Ref_Main_Menu(ent);
}

/*
=================
Ref_Main_Menu (lmctf60/g_menu.c:695)
=================
*/
export function Ref_Main_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Main_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  const cl = ent.client;

  Menu_Free(ent);
  cl.menu = MENU_LOCAL;
  cl.menuselect = 1;

  Menu_Set(ent, 1, "LMCTF Referee Menu", Main_Menu);
  Menu_Set(ent, 2, "------------------", null);
  Menu_Set(ent, 3, "Change Map", Ref_Map_Menu);
  Menu_Set(ent, 4, "Server Settings", Ref_Settings_Menu);
  Menu_Set(ent, 5, va("Ping Floor:          %3d", cl.ctf.pingalertfloor), Ref_PingFloor_Menu);
  Menu_Set(ent, 6, va("Ping Ceiling:        %3d", cl.ctf.pingalertceiling), Ref_PingCeiling_Menu);
  if (Match_Mode()) {
    Menu_Set(ent, 7, "Stop Match", Ref_End_Match);
  } else {
    Menu_Set(ent, 7, "Start Match", Ref_Match_Menu);
  }
  Menu_Set(ent, 8, "Kick Player", Ref_Kick_Menu);

  if (GamePaused()) {
    Menu_Set(ent, 9, "Continue Match", RefTogglePause);
  } else {
    Menu_Set(ent, 9, "Pause Match", RefTogglePause);
  }
  Menu_Set(ent, 10, "Practice Settings", Ref_Practice_Menu);
  Menu_Set(ent, 11, "Toggle Fast Switch", Cmd_ToggleFastSwitch_f);
  Menu_Set(ent, 12, "Referee Help", Ref_Help_Menu);

  if ((cl.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) !== 0) {
    Menu_Set(ent, 13, "Save Config (RCON)", SaveServer_Exec);
  }

  Menu_Draw(ent);
}

/*
=================
RefTogglePause (lmctf60/g_menu.c:732)
=================
*/
export function RefTogglePause(ent: EdictT): void {
  if (GamePaused()) {
    SetPause(false);
  } else {
    SetPause(true);
  }

  Ref_Main_Menu(ent);
}

/*
=================
SaveServer_Exec (lmctf60/g_menu.c:742)

Reads server.cfg, strips out any existing dmflags/ctfflags/timelimit/
fraglimit lines (matching by either the bare name or the "set <name>"
form), then rewrites it with fresh `set <name> <value>` lines for those
four followed by everything else unchanged. File I/O goes through the
sanctioned FS seam (FS_LoadFile/FS_WriteFile), not gi.TagMalloc+fopen; the
40000-byte read cap the C source enforced (`gi.TagMalloc(40000,
TAG_GAME)`) has no equivalent here since FS_LoadFile reads the whole file
regardless of size.
=================
*/
export function SaveServer_Exec(ent: EdictT): void {
  const buf = FS_LoadFile(serverFileName);
  if (buf === null) return;

  const text = new TextDecoder().decode(buf);
  ctf_SafePrint(ent, PRINT_HIGH, "Read server.cfg successfully");

  const skipPrefixes = ["set dmflags", "dmflags", "set ctfflags", "ctfflags", "set timelimit", "timelimit", "set fraglimit", "fraglimit"];

  let out = "";
  out += `set dmflags ${gameCvars.dmflags?.value ?? 0}\n`;
  out += `set ctfflags ${gameCvars.ctfflags?.value ?? 0}\n`;
  out += `set timelimit ${gameCvars.timelimit?.value ?? 0}\n`;
  out += `set fraglimit ${gameCvars.fraglimit?.value ?? 0}\n`;

  // now dump out remainder of file, ignoring the things we dumped out above
  const lines = text.split("\n");
  for (const line of lines) {
    if (skipPrefixes.some((prefix) => line.startsWith(prefix))) continue;
    out += `${line}\n`;
  }

  FS_WriteFile(serverFileName, out);
  ctf_SafePrint(ent, PRINT_HIGH, "Success: Current server values saved to server.cfg.\n");
}

// refhelptext[] (lmctf60/g_menu.c:828) -- three pages of 15 lines each,
// 0-terminated (the C source's final `0` sentinel becomes "end of array"
// here; every `refhelptext[j]` truthiness check below is `j <
// refhelptext.length`).
const refhelptext: string[] = [
  "",
  "gotomap",
  "",
  "- Allows a referee to",
  "change the current map.",
  "",
  "",
  "users",
  "",
  "- Lists the player",
  "numbers for all active",
  "users.",
  "",
  "",
  "",
  // Page 2
  "",
  "kick",
  "",
  "- Allows a referee to",
  "disconnect a player.",
  "Requires a player",
  "number.",
  "",
  "",
  "match",
  "",
  "- Starts a match with",
  "given map name. Map",
  "must be in maplist.",
  "",
  // Page 3
  "",
  "pingalert",
  "",
  "- Warns a referee if any",
  "players' ping is above a",
  "max or below a min.",
  "",
  "",
  "refmenu",
  "",
  "- Opens the referee",
  "menu.",
  "",
  "",
];

/*
=================
Ref_Help_Menu (lmctf60/g_menu.c:887)
=================
*/
export function Ref_Help_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Help_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }

  // Calculate our page
  let start = 15 * ent.client.menupage;

  // Find if last page was the last
  if (start > 14) {
    for (let i = start - 15; i < start; i++) {
      if (refhelptext[i] === undefined) {
        // Last entry
        start = 0; // Go to first page
        ent.client.menupage = 0;
      }
    }
  }

  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "LMCTF Ref Commands", Ref_Main_Menu);
  Menu_Set(ent, 1, "------------------", null);
  let j = start;
  for (let i = 2; i < 17 && refhelptext[j] !== undefined; i++, j++) {
    Menu_Set(ent, i, (refhelptext[j] ?? "").slice(0, 24), null);
  }
  Menu_Set(ent, 17, "<next page>", Ref_Help_Menu);

  Menu_Draw(ent);
}

/*
=================
Ref_Practice_Menu (lmctf60/g_menu.c:925)
=================
*/
export function Ref_Practice_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Practice_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 1;
  ctf_validateflags();
  Menu_Set(ent, 1, "LMCTF Practice Menu", Ref_Main_Menu);
  Menu_Set(ent, 2, "-------------------", null);
  Menu_Set(ent, 3, `Red Flag:     ${redflag !== null && (refsetValue & CTF_RED_FLAG_FROZEN) !== 0 ? "FROZEN" : "NORMAL"}`, Ref_PracticeFlagRed_Exec);
  Menu_Set(ent, 4, `Blue Flag:    ${blueflag !== null && (refsetValue & CTF_BLUE_FLAG_FROZEN) !== 0 ? "FROZEN" : "NORMAL"}`, Ref_PracticeFlagBlue_Exec);
  Menu_Draw(ent);
}

/*
=================
Ref_PracticeFlagRed_Exec / Ref_PracticeFlagBlue_Exec (lmctf60/g_menu.c:947,
956)
=================
*/
export function Ref_PracticeFlagRed_Exec(ent: EdictT): void {
  if (redflag !== null && (refsetValue & CTF_RED_FLAG_FROZEN) !== 0) {
    refsetValue &= ~CTF_RED_FLAG_FROZEN;
  } else {
    refsetValue |= CTF_RED_FLAG_FROZEN;
  }
  gi.cvar_set("refset", `${refsetValue}`);
  Ref_Practice_Menu(ent);
}

export function Ref_PracticeFlagBlue_Exec(ent: EdictT): void {
  if (blueflag !== null && (refsetValue & CTF_BLUE_FLAG_FROZEN) !== 0) {
    refsetValue &= ~CTF_BLUE_FLAG_FROZEN;
  } else {
    refsetValue |= CTF_BLUE_FLAG_FROZEN;
  }
  gi.cvar_set("refset", `${refsetValue}`);
  Ref_Practice_Menu(ent);
}

// pingfloor[] (lmctf60/g_menu.c:965) -- also used, unchanged, by
// Ref_PingCeiling_Menu/PingCeiling_Exec below; the C source has no
// separate "pingceiling" table, a real quirk preserved exactly.
const pingfloor = [0, 0, 0, 50, 100, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 350, 500];

/*
=================
Ref_PingFloor_Menu / PingFloor_Exec (lmctf60/g_menu.c:987, 1008)
=================
*/
export function Ref_PingFloor_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_PingFloor_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, va("Current Ping Floor:  %3d", ent.client.ctf.pingalertfloor), Ref_Main_Menu);
  Menu_Set(ent, 1, "------------------", null);
  for (let i = 2; i < 18; i++) {
    Menu_Set(ent, i, `${pingfloor[i] ?? 0}`, PingFloor_Exec);
  }

  Menu_Draw(ent);
}

export function PingFloor_Exec(ent: EdictT): void {
  if (ent.client === null) return;
  ent.client.ctf.pingalertfloor = pingfloor[ent.client.menuselect] ?? 0;
  Ref_Main_Menu(ent);
}

/*
=================
Ref_PingCeiling_Menu / PingCeiling_Exec (lmctf60/g_menu.c:1014, 1035)
=================
*/
export function Ref_PingCeiling_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_PingCeiling_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, va("Current Ping Ceiling: %3d", ent.client.ctf.pingalertceiling), Ref_Main_Menu);
  Menu_Set(ent, 1, "------------------", null);
  for (let i = 2; i < 18; i++) {
    Menu_Set(ent, i, `${pingfloor[i] ?? 0}`, PingCeiling_Exec);
  }

  Menu_Draw(ent);
}

export function PingCeiling_Exec(ent: EdictT): void {
  if (ent.client === null) return;
  ent.client.ctf.pingalertceiling = pingfloor[ent.client.menuselect] ?? 0;
  Ref_Main_Menu(ent);
}

/*
=================
Ref_Settings_Menu (lmctf60/g_menu.c:1041)
=================
*/
export function Ref_Settings_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Settings_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 1;

  const quad = FindItem("Quad Damage");
  Menu_Set(ent, 1, "Server Settings", Ref_Main_Menu);
  Menu_Set(ent, 2, "---------------", null);
  Menu_Set(ent, 3, va("Timelimit:           %3d", gameCvars.timelimit?.value ?? 0), Ref_Timelimit_Menu);
  Menu_Set(ent, 4, va("Fraglimit:           %3d", gameCvars.fraglimit?.value ?? 0), Ref_Fraglimit_Menu);
  Menu_Set(ent, 5, va("DMFlags:           %5d", (gameCvars.dmflags?.value ?? 0) & 0xffff), Ref_DMFlags_Menu);
  Menu_Set(ent, 6, va("CTFFlags:          %5d", (gameCvars.ctfflags?.value ?? 0) & 0xffff), Ref_CTFFlags_Menu);
  Menu_Set(ent, 7, va("Fast Weap Switch:  %5d", fastswitchValue & 0xffff), null);
  Menu_Set(ent, 8, va("Teams Locked:      %5d", game.teamslocked ? 1 : 0), null);
  const svp = gi.cvar("sv_password", "", 0);
  if (svp !== null && svp.string.length > 0) {
    Menu_Set(ent, 9, `sv_password: ${svp.string}`, null);
  } else {
    Menu_Set(ent, 9, `password: ${gameCvars.password?.string ?? ""}`, null);
  }
  if ((ent.client.ctf.extra_flags & CTF_EXTRAFLAGS_RCON) !== 0) {
    Menu_Set(ent, 10, "Clear password (RCON)", ClearPassword_Exec);
  }
  if (quad !== null) {
    Menu_Set(ent, 11, `Quad Time: ${quad.quantity}`, null);
  }

  Menu_Draw(ent);
}

/*
=================
ClearPassword_Exec (lmctf60/g_menu.c:1083)
=================
*/
export function ClearPassword_Exec(ent: EdictT): void {
  gi.cvar_set("password", "");
  Ref_Settings_Menu(ent);
}

/*
=================
DMFlags_Exec / Ref_DMFlags_Menu (lmctf60/g_menu.c:1089, 1103)
=================
*/
export function DMFlags_Exec(ent: EdictT): void {
  if (ent.client === null) return;
  const i = ent.client.menuselect - 2;
  const cur = gameCvars.dmflags?.value ?? 0;
  if ((cur & (1 << i)) !== 0) {
    gi.cvar_set("dmflags", va("%d", cur & ~(1 << i)));
  } else {
    gi.cvar_set("dmflags", va("%d", cur | (1 << i)));
  }
  Ref_DMFlags_Menu(ent);
}

function dmflag(bit: number): string {
  return ((gameCvars.dmflags?.value ?? 0) & bit) !== 0 ? "ON" : "OFF";
}

export function Ref_DMFlags_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_DMFlags_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 1;

  Menu_Set(ent, 0, va("DMFlags:             %d", (gameCvars.dmflags?.value ?? 0) & 0xffff), Ref_Settings_Menu);
  Menu_Set(ent, 1, "----------------", null);
  Menu_Set(ent, 2, `No Health            ${dmflag(DF_NO_HEALTH)}`, DMFlags_Exec);
  Menu_Set(ent, 3, `No Items             ${dmflag(DF_NO_ITEMS)}`, DMFlags_Exec);
  Menu_Set(ent, 4, `Weapons Stay         ${dmflag(DF_WEAPONS_STAY)}`, DMFlags_Exec);
  Menu_Set(ent, 5, `No Falling           ${dmflag(DF_NO_FALLING)}`, DMFlags_Exec);
  Menu_Set(ent, 6, `Instant Items        ${dmflag(DF_INSTANT_ITEMS)}`, DMFlags_Exec);
  Menu_Set(ent, 7, `Same Level           ${dmflag(DF_SAME_LEVEL)}`, DMFlags_Exec);
  Menu_Set(ent, 8, `Skin Teams           ${dmflag(DF_SKINTEAMS)}`, DMFlags_Exec);
  Menu_Set(ent, 9, `Model Teams          ${dmflag(DF_MODELTEAMS)}`, DMFlags_Exec);
  Menu_Set(ent, 10, `Friendly Fire        ${dmflag(DF_NO_FRIENDLY_FIRE)}`, DMFlags_Exec);
  Menu_Set(ent, 11, `Spawn Farthest       ${dmflag(DF_SPAWN_FARTHEST)}`, DMFlags_Exec);
  Menu_Set(ent, 12, `Force Respawn        ${dmflag(DF_FORCE_RESPAWN)}`, DMFlags_Exec);
  Menu_Set(ent, 13, `No Armor             ${dmflag(DF_NO_ARMOR)}`, DMFlags_Exec);
  Menu_Set(ent, 14, `Allow Exit           ${dmflag(DF_ALLOW_EXIT)}`, DMFlags_Exec);
  Menu_Set(ent, 15, `Infinite Ammo        ${dmflag(DF_INFINITE_AMMO)}`, DMFlags_Exec);
  Menu_Set(ent, 16, `Quad Drop            ${dmflag(DF_QUAD_DROP)}`, DMFlags_Exec);
  Menu_Set(ent, 17, `Fixed FOV            ${dmflag(DF_FIXED_FOV)}`, DMFlags_Exec);

  Menu_Draw(ent);
}

/*
=================
CTFFlags_Exec / Ref_CTFFlags_Menu (lmctf60/g_menu.c:1150, 1164)

`WEAP_BALANCE_OK`/`NOVOICE_OK` are never defined -- see file header. The
NOVOICE_OK block would have put "Offhand Hook" in slot 6 and "No Voice" in
slot 7; with it dropped, "Offhand Hook" lands in slot 7 directly and "No
Voice" is never shown at all. Preserved exactly as the live build behaves.
=================
*/
export function CTFFlags_Exec(ent: EdictT): void {
  if (ent.client === null) return;
  const i = ent.client.menuselect - 2;
  const cur = gameCvars.ctfflags?.value ?? 0;
  if ((cur & (1 << i)) !== 0) {
    gi.cvar_set("ctfflags", va("%d", cur & ~(1 << i)));
  } else {
    gi.cvar_set("ctfflags", va("%d", cur | (1 << i)));
  }
  Ref_CTFFlags_Menu(ent);
}

function ctfflag(bit: number): string {
  return ((gameCvars.ctfflags?.value ?? 0) & bit) !== 0 ? "ON" : "OFF";
}

export function Ref_CTFFlags_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_CTFFlags_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 1;

  Menu_Set(ent, 0, va("CTFFlags:            %d", (gameCvars.ctfflags?.value ?? 0) & 0xffff), Ref_Settings_Menu);
  Menu_Set(ent, 1, "----------------", null);
  // #ifdef WEAP_BALANCE_OK -- never defined, dropped:
  // Menu_Set(ent, 2, `Weapon Balance       ${ctfflag(CTF_WEAP_BALANCE)}`, CTFFlags_Exec);
  Menu_Set(ent, 3, `Allow Invuln         ${ctfflag(CTF_ALLOW_INVULN)}`, CTFFlags_Exec);
  Menu_Set(ent, 4, `Team Reset           ${ctfflag(CTF_TEAM_RESET)}`, CTFFlags_Exec);
  Menu_Set(ent, 5, `Team No Switch       ${ctfflag(CTF_TEAM_NOSWITCH)}`, CTFFlags_Exec);
  // #ifdef NOVOICE_OK -- never defined; slot 6 ("Offhand Hook") and the
  // "No Voice" line it would have introduced never happen. "Offhand Hook"
  // lands in slot 7 instead, below.
  Menu_Set(ent, 7, `Offhand Hook         ${ctfflag(CTF_OFFHAND_HOOK)}`, CTFFlags_Exec);
  Menu_Set(ent, 8, `No Grapple Damage    ${ctfflag(CTF_NO_GRAP_DAMAGE)}`, CTFFlags_Exec);
  Menu_Set(ent, 9, `No Teams             ${ctfflag(CTF_TEAM_NOTEAMS)}`, CTFFlags_Exec);
  Menu_Set(ent, 10, `No Flags             ${ctfflag(CTF_FLAGS_NOFLAGS)}`, CTFFlags_Exec);
  Menu_Set(ent, 11, `Score Balance        ${ctfflag(CTF_SCORE_BALANCE)}`, CTFFlags_Exec);
  Menu_Set(ent, 12, `Team Armor Protect   ${ctfflag(CTF_TEAM_ARMOR_PROTECT)}`, CTFFlags_Exec);

  //-bat
  Menu_Set(ent, 14, `Random Map List      ${ctfflag(CTF_RANDOM_MAPS)}`, CTFFlags_Exec);
  Menu_Set(ent, 15, `Random Quad Respawn  ${ctfflag(CTF_RANDOM_QUAD)}`, CTFFlags_Exec);
  Menu_Set(ent, 16, `Random Death Msgs    ${ctfflag(CTF_RANDOM_DEATH_MSG)}`, CTFFlags_Exec);

  Menu_Draw(ent);
}

// timeslist[] (lmctf60/g_menu.c:1214)
const timeslist = [0, 0, 0, 1, 5, 10, 12, 15, 20, 25, 30, 35, 40, 45, 60, 60, 90, 120];

export function SetTimelimit(ent: EdictT): void {
  if (ent.client === null) return;
  gi.cvar_set("timelimit", va("%f", timeslist[ent.client.menuselect] ?? 0));
  Ref_Settings_Menu(ent);
}

export function Ref_Timelimit_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Timelimit_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, va("Current Timelimit:  %3d", gameCvars.timelimit?.value ?? 0), Ref_Settings_Menu);
  Menu_Set(ent, 1, "------------------", null);
  for (let i = 2; i < 18; i++) {
    Menu_Set(ent, i, `${timeslist[i] ?? 0}`, SetTimelimit);
  }

  Menu_Draw(ent);
}

// fragslist[] (lmctf60/g_menu.c:1263)
const fragslist = [0, 0, 0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 200, 300, 500];

export function SetFraglimit(ent: EdictT): void {
  if (ent.client === null) return;
  gi.cvar_set("fraglimit", va("%f", fragslist[ent.client.menuselect] ?? 0));
  Ref_Settings_Menu(ent);
}

export function Ref_Fraglimit_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Fraglimit_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, va("Current Fraglimit:  %3d", gameCvars.fraglimit?.value ?? 0), Ref_Settings_Menu);
  Menu_Set(ent, 1, "------------------", null);
  for (let i = 2; i < 18; i++) {
    Menu_Set(ent, i, `${fragslist[i] ?? 0}`, SetFraglimit);
  }

  Menu_Draw(ent);
}

// Maps (lmctf60/g_menu.c:1315-1477)
const mapalist: (string | null)[] = [null, null, "lmctf01", "lmctf02c", "lmctf03", "lmctf04", "lmctf05c", "lmctf06", "lmctf07", "lmctf08", "lmctf09", "lmctf10", null, null, null, null, null, null];
const mapblist: (string | null)[] = [null, null, "lmctf11", "lmctf12", "lmctf13", "lmctf14", "lmctf15", "lmctf16", "lmctf17", "lmctf18", "lmctf19", "lmctf20", null, null, null, null, null, null];
const mapclist: (string | null)[] = [null, null, "lmctf21", "lmctf22", "lmctf23", "lmctf24", "lmctf25", "lmctf26", "lmctf27", "lmctf28", "lmctf29", "lmctf30", null, null, null, null, null, null];
const mapdlist: (string | null)[] = [null, null, "lmctf31", "lmctf32", "lmctf33", "lmctf34", "lmctf35", "lmctf36", "lmctf37", "lmctf38", "lmctf39", "lmctf40", null, null, null, null, null, null];
const mapelist: (string | null)[] = [null, null, "lmctf41", "lmctf42", "lmctf43", "lmctf44", "lmctf45", "lmctf46", "lmctf47", "lmctf48", "lmctf49", null, null, null, null, null, null, null];

/*
=================
SetMap (lmctf60/g_menu.c:1499)

Dispatches by identity-comparing `ent->client->prevmenu` against each of
the ten Ref_Match_x / Ref_Map_x menu functions (a poor-man's enum switch
on function pointers, preserved exactly -- TS function declarations are
stable references, so `===` comparison here matches the C source's
pointer comparison).
=================
*/
export function SetMap(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("SetMap: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  SetupShortList();
  let slPtr = shortList;

  const prev = ent.client.prevmenu;
  const sel = ent.client.menuselect;

  if (prev === Ref_Match_A_Menu) {
    Ctf_Menu(ent); // turn off menu
    StartMatch(mapalist[sel] ?? null);
  } else if (prev === Ref_Match_B_Menu) {
    Ctf_Menu(ent);
    StartMatch(mapblist[sel] ?? null);
  } else if (prev === Ref_Match_C_Menu) {
    Ctf_Menu(ent);
    StartMatch(mapclist[sel] ?? null);
  } else if (prev === Ref_Match_D_Menu) {
    Ctf_Menu(ent);
    StartMatch(mapdlist[sel] ?? null);
  } else if (prev === Ref_Match_E_Menu) {
    Ctf_Menu(ent);
    StartMatch(mapelist[sel] ?? null);
  } else if (prev === Ref_Match_Maplist_Menu) {
    Ctf_Menu(ent);
    const i = sel - 2 + ent.client.menulastpage * 15;
    for (let ctr = 0; ctr < i && slPtr !== null; ctr++) slPtr = slPtr.next;
    if (slPtr !== null) StartMatch(slPtr.mapname);
  } else if (prev === Ref_Map_A_Menu) {
    Ctf_Menu(ent);
    ctf_ChangeMap(mapalist[sel] ?? null, false);
  } else if (prev === Ref_Map_B_Menu) {
    Ctf_Menu(ent);
    ctf_ChangeMap(mapblist[sel] ?? null, false);
  } else if (prev === Ref_Map_C_Menu) {
    Ctf_Menu(ent);
    ctf_ChangeMap(mapclist[sel] ?? null, false);
  } else if (prev === Ref_Map_D_Menu) {
    Ctf_Menu(ent);
    ctf_ChangeMap(mapdlist[sel] ?? null, false);
  } else if (prev === Ref_Map_E_Menu) {
    Ctf_Menu(ent);
    ctf_ChangeMap(mapelist[sel] ?? null, false);
  } else if (prev === Ref_Map_Maplist_Menu) {
    Ctf_Menu(ent);
    const i = sel - 2 + ent.client.menulastpage * 15;
    for (let ctr = 0; ctr < i && slPtr !== null; ctr++) slPtr = slPtr.next;
    if (slPtr !== null) ctf_ChangeMap(slPtr.mapname, false);
  }
}

/*
=================
Ref_Match_Maplist_Menu / Ref_Map_Maplist_Menu (lmctf60/g_menu.c:1575, 1589)
=================
*/
export function Ref_Match_Maplist_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Match_Maplist_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "Match Maplist <min> <max>", Ref_Main_Menu);
  Menu_Set(ent, 1, "-------------", null);
  SetMapsForMenu(ent);
  Menu_Set(ent, 17, "<next page>", Ref_Match_Maplist_Menu);

  Menu_Draw(ent);
}

export function Ref_Map_Maplist_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Map_Maplist_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "Maplist <min> <max>", Ref_Main_Menu);
  Menu_Set(ent, 1, "-------------", null);
  SetMapsForMenu(ent);
  Menu_Set(ent, 17, "<next page>", Ref_Map_Maplist_Menu);

  Menu_Draw(ent);
}

/*
=================
SetMapsForMenu (lmctf60/g_menu.c:1603)
=================
*/
export function SetMapsForMenu(ent: EdictT): void {
  if (ent.client === null) return;
  SetupShortList();

  const start = 15 * ent.client.menupage;

  let slPtr: MapInfoT | null = shortList;
  let ct = 0;
  while (ct < start && slPtr !== null) {
    slPtr = slPtr.next;
    ct++;
  }

  for (let endCtr = 2; endCtr < 18 && slPtr !== null; endCtr++) {
    Menu_Set(ent, endCtr, `${slPtr.mapname ?? ""} ${slPtr.minplayers} ${slPtr.maxplayers}`, SetMap);
    slPtr = slPtr.next;
  }
}

/*
=================
SetupShortList (lmctf60/g_menu.c:1644)

Builds `shortList` (every g_save.c-parsed maplist entry NOT already one of
the fixed lmctf01-49 match maps) once and caches it; a no-op on every call
after the first. `maplist` is always empty in this port today (see file
header), so `shortList` stays null until unit A's g_save.ts lands the real
maplist parser -- the loop below is still exactly what the C source does.
=================
*/
export function SetupShortList(): void {
  if (shortList !== null) {
    return;
  }

  let slPtr: MapInfoT | null = null;
  for (const entry of maplist) {
    const thisMap = entry.mapname;
    if (thisMap !== null && maplmlist.includes(thisMap)) continue;

    if (slPtr === null) {
      entry.next = null;
      shortList = slPtr = entry;
    } else {
      entry.next = null;
      slPtr.next = entry;
      slPtr = entry;
    }
  }
}

// maplmlist[] (lmctf60/g_menu.c:1425) -- the fixed lmctf01-49 map set
// SetupShortList excludes from the "extra" maplist.
const maplmlist = Array.from({ length: 49 }, (_, i) => {
  const n = i + 1;
  if (n === 2) return "lmctf02c";
  if (n === 5) return "lmctf05c";
  return `lmctf${n < 10 ? `0${n}` : n}`;
});

/*
=================
MapMenu (lmctf60/g_menu.c:1672)
=================
*/
export function MapMenu(ent: EdictT, list: (string | null)[], msg: string): void {
  if (ent.client === null) {
    throw new Error("MapMenu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, msg, ent.client.prevmenu);
  Menu_Set(ent, 1, "-----------", null);
  for (let i = 2; i < 18; i++) {
    const name = list[i];
    if (name !== undefined && name !== null) {
      Menu_Set(ent, i, name, SetMap);
    }
  }

  Menu_Draw(ent);
}

export function Ref_Match_A_Menu(ent: EdictT): void {
  MapMenu(ent, mapalist, "Set 1 maps");
}
export function Ref_Map_A_Menu(ent: EdictT): void {
  MapMenu(ent, mapalist, "Set 1 Maps");
}
export function Ref_Match_B_Menu(ent: EdictT): void {
  MapMenu(ent, mapblist, "Set 2 Maps");
}
export function Ref_Map_B_Menu(ent: EdictT): void {
  MapMenu(ent, mapblist, "Set 2 Maps");
}
export function Ref_Match_C_Menu(ent: EdictT): void {
  MapMenu(ent, mapclist, "Set 3 Maps");
}
export function Ref_Map_C_Menu(ent: EdictT): void {
  MapMenu(ent, mapclist, "Set 3 Maps");
}
export function Ref_Match_D_Menu(ent: EdictT): void {
  MapMenu(ent, mapdlist, "Set 4 Maps");
}
export function Ref_Map_D_Menu(ent: EdictT): void {
  MapMenu(ent, mapdlist, "Set 4 Maps");
}
export function Ref_Match_E_Menu(ent: EdictT): void {
  MapMenu(ent, mapelist, "Set 5 Maps");
}
export function Ref_Map_E_Menu(ent: EdictT): void {
  MapMenu(ent, mapelist, "Set 5 Maps");
}

/*
=================
Ref_End_Match (lmctf60/g_menu.c:1748)
=================
*/
export function Ref_End_Match(ent: EdictT): void {
  KillMatch();
  Ref_Main_Menu(ent);
}

/*
=================
Ref_Match_Menu / Ref_Map_Menu (lmctf60/g_menu.c:1754, 1773)
=================
*/
export function Ref_Match_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Match_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "Match Menu", Ref_Main_Menu);
  Menu_Set(ent, 1, "----------", null);
  Menu_Set(ent, 2, "LMCTF Set 1", Ref_Match_A_Menu);
  Menu_Set(ent, 3, "LMCTF Set 2", Ref_Match_B_Menu);
  Menu_Set(ent, 4, "LMCTF Set 3", Ref_Match_C_Menu);
  Menu_Set(ent, 5, "LMCTF Set 4", Ref_Match_D_Menu);
  Menu_Set(ent, 6, "LMCTF Set 5", Ref_Match_E_Menu);
  if (maplistindex !== -2) {
    // No list
    Menu_Set(ent, 7, "Maplist", Ref_Match_Maplist_Menu);
  }
  Menu_Draw(ent);
}

export function Ref_Map_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Map_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "Map Menu", Ref_Main_Menu);
  Menu_Set(ent, 1, "--------", null);
  Menu_Set(ent, 2, "LMCTF Set 1", Ref_Map_A_Menu);
  Menu_Set(ent, 3, "LMCTF Set 2", Ref_Map_B_Menu);
  Menu_Set(ent, 4, "LMCTF Set 3", Ref_Map_C_Menu);
  Menu_Set(ent, 5, "LMCTF Set 4", Ref_Map_D_Menu);
  Menu_Set(ent, 6, "LMCTF Set 5", Ref_Map_E_Menu);
  if (maplistindex !== -2) {
    // No list
    Menu_Set(ent, 7, "Maplist", Ref_Map_Maplist_Menu);
  }

  Menu_Draw(ent);
}

/*
=================
SelectKick / Ref_Kick_Menu (lmctf60/g_menu.c:1794, 1808)
=================
*/
export function SelectKick(ent: EdictT): void {
  if (ent.client === null) return;
  const i = ent.client.menuselect;
  const text = ent.client.localmenu[i]?.text ?? "";
  const id = Number.parseInt(text, 10);
  if (!Number.isNaN(id)) {
    ForceCommand(ent, `\nctfkick ${id}\n`);
  }
}

export function Ref_Kick_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Ref_Kick_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "LMCTF Kick Menu", Ref_Main_Menu);
  Menu_Set(ent, 1, "---------------", null);

  let i = 2;
  let player = ctf_findplayer(null, null, CTF_TEAM_IGNORETEAM);
  while (player !== null && i < 17) {
    if (player.client !== null) {
      Menu_Set(ent, i, `${player.client.ctf.ctfid} ${player.client.pers.netname}`, SelectKick);
    }
    player = ctf_findplayer(player, null, CTF_TEAM_IGNORETEAM);
    i++;
  }

  Menu_Draw(ent);
}

// voicelist[] (lmctf60/g_menu.c:1835)
const voicelist: (string | null)[] = [null, null, "damn", "escort", "followme", "getflag", "goodshot", "gotcha", "laugh", "move", "silly", "stopshoot", null, null, null, null, null, null];

/*
=================
Voice_Menu / Voice_Exec (lmctf60/g_menu.c:1857, 1876)
=================
*/
export function Voice_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Voice_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }
  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "Play_Voice Menu", Main_Menu);
  Menu_Set(ent, 1, "---------------", null);
  for (let i = 2; i < 18; i++) {
    const v = voicelist[i];
    if (v !== undefined && v !== null) {
      Menu_Set(ent, i, v, Voice_Exec);
    }
  }

  Menu_Draw(ent);
}

export function Voice_Exec(ent: EdictT): void {
  if (ent.client === null) return;
  const v = voicelist[ent.client.menuselect];
  if (v !== undefined && v !== null) PlayVoiceSound(ent, v);
  ent.client.showmenu = false;
  Menu_Blank(ent);
}

/*
=================
Change_Team_Exec (lmctf60/g_menu.c:1883)
=================
*/
export function Change_Team_Exec(ent: EdictT): void {
  if (ent.client !== null) {
    if (ent.client.ctf.teamnum === CTF_TEAM_BLUE) {
      Team_Change(ent, CTF_TEAM_RED);
    } else {
      Team_Change(ent, CTF_TEAM_BLUE);
    }
  }

  Ctf_Menu(ent);
}

/*
=================
Help_Menu (lmctf60/g_menu.c:1898, the real one -- a stale, fully
commented-out duplicate at line 514 is not reproduced, per PORTING.md's
dead-comment rule)
=================
*/
export function Help_Menu(ent: EdictT): void {
  if (ent.client === null) {
    throw new Error("Help_Menu: ent.client is null (lmctf60/g_menu.c dereferences ent->client unconditionally)");
  }

  // Calculate our page
  let start = 15 * ent.client.menupage;

  // Find if last page was the last
  if (start > 14) {
    for (let i = start - 15; i < start; i++) {
      if ((helptext[i] ?? "").length === 0) {
        // Last entry
        start = 0; // Go to first page
        ent.client.menupage = 0;
      }
    }
  }

  Menu_Free(ent);
  ent.client.menu = MENU_LOCAL;
  ent.client.menuselect = 0;

  Menu_Set(ent, 0, "LMCTF Commands", Main_Menu);
  Menu_Set(ent, 1, "--------------", null);
  let j = start;
  for (let i = 2; i < 17 && (helptext[j] ?? "").length > 0; i++, j++) {
    Menu_Set(ent, i, (helptext[j] ?? "").slice(0, 24), null);
  }
  Menu_Set(ent, 17, "<next page>", Help_Menu);

  Menu_Draw(ent);
}

/*
=================
Menu Functions (lmctf60/g_menu.c:1936)
=================
*/

/*
=================
Menu_Free (lmctf60/g_menu.c:1943)
=================
*/
export function Menu_Free(ent: EdictT): void {
  if (ent.client === null) return;
  for (let i = 0; i < 18; i++) {
    const item = ent.client.localmenu[i];
    if (item !== undefined && item.text !== null) {
      item.text = null;
      item.func = null;
    }
  }
}

/*
=================
Menu_Set (lmctf60/g_menu.c:1957)

`text` is assigned directly rather than via a ported G_CopyString -- see
file header's "Cross-dependencies" note: a strdup has one possible correct
behavior in a GC'd language, so there is nothing for a real g_utils.ts
G_CopyString to do differently.
=================
*/
export function Menu_Set(ent: EdictT, item: number, text: string | null, func: ((ent: EdictT) => void) | null): void {
  if (ent.client === null) return;
  const slot = ent.client.localmenu[item];
  if (slot === undefined) return;

  slot.text = text;
  slot.func = func;
}

/*
=================
Menu_Draw (lmctf60/g_menu.c:1967)

Renders either the per-client `localmenu` (MENU_LOCAL) or one of the
static `menulist[]` screens as a `svc_layout` string, highlighting the
current selection. Rate-limited to once per server frame
(`menumovetime`), EXCEPT while the game is paused (Paril's addition, per
its own comment) -- this lets a paused referee's screen still redraw every
call, matching the C source exactly.
=================
*/
export function Menu_Draw(ent: EdictT): void {
  if (ent.client === null) return;
  const cl = ent.client;

  // Keep from updating the menu more than once per frame
  // Paril: unless we're paused, in which case...
  if (cl.menumovetime === level.framenum && !GamePaused()) return;

  cl.menumovetime = level.framenum;

  gi.WriteByte(svc_layout);
  let str = "xv 32 yv 8 picn inventory ";

  let menu: MenuItem[];
  let size: number;
  let ystart: number;

  if (cl.menu === MENU_LOCAL) {
    // Special case
    menu = cl.localmenu;
    size = 18;
    ystart = 32; // Start one line up from static menu
  } else {
    // Static menu
    const data = menulist[cl.menu];
    if (data === undefined || data.menu === null) return;
    menu = data.menu;
    size = data.size;
    ystart = size < 18 ? 40 : 32; // Start one line down from local menu
  }

  // Validate our highlighed selection
  let guard = 0;
  while (menu[cl.menuselect]?.func == null) {
    cl.menuselect = (cl.menuselect + 1) % size;
    guard++;
    if (guard > size) {
      // C has no equivalent guard (an all-NULL-func menu spins forever);
      // this stays a documented, behavior-preserving safety valve rather
      // than reproducing a real infinite loop.
      return;
    }
  }
  const selected = cl.menuselect;

  for (let i = 0; i < size; i++) {
    const it = menu[i];
    if (it === undefined || it.text === null) continue;
    if (i === selected) {
      str += Com_sprintf("xv %i yv %i string \"\x0d%s\" ", 55, ystart + i * 8, it.text);
    } else {
      str += Com_sprintf("xv %i yv %i string2 \" %s\" ", 55, ystart + i * 8, it.text);
    }
  }

  gi.WriteString(str);
  // Paril
  gi.unicast(ent, true);
  // Paril
}

/*
=================
Menu_Blank (lmctf60/g_menu.c:2032)
=================
*/
export function Menu_Blank(ent: EdictT): void {
  gi.WriteByte(svc_layout);
  gi.WriteString("");
  // Paril
  gi.unicast(ent, true);
  // Paril
}

/*
=================
Menu_Next (lmctf60/g_menu.c:2042)
=================
*/
export function Menu_Next(ent: EdictT): void {
  if (ent.client === null) return;
  const cl = ent.client;

  let menu: MenuItem[];
  let size: number;

  if (cl.menu === MENU_LOCAL) {
    menu = cl.localmenu;
    size = 18;
  } else {
    const data = menulist[cl.menu];
    if (data === undefined || data.menu === null) return;
    menu = data.menu;
    size = data.size;
  }

  cl.menuselect = (cl.menuselect + 1) % size;
  let guard = 0;
  while (menu[cl.menuselect]?.func == null) {
    cl.menuselect = (cl.menuselect + 1) % size;
    guard++;
    if (guard > size) return;
  }

  Menu_Draw(ent);
}

/*
=================
Menu_Prev (lmctf60/g_menu.c:2068)
=================
*/
export function Menu_Prev(ent: EdictT): void {
  if (ent.client === null) return;
  const cl = ent.client;

  let menu: MenuItem[];
  let size: number;

  if (cl.menu === MENU_LOCAL) {
    menu = cl.localmenu;
    size = 18;
  } else {
    const data = menulist[cl.menu];
    if (data === undefined || data.menu === null) return;
    menu = data.menu;
    size = data.size;
  }

  if (!cl.menuselect) {
    cl.menuselect = size - 1;
  } else {
    cl.menuselect--;
  }

  let guard = 0;
  while (menu[cl.menuselect]?.func == null) {
    if (!cl.menuselect) {
      cl.menuselect = size - 1;
    } else {
      cl.menuselect--;
    }
    guard++;
    if (guard > size) return;
  }

  Menu_Draw(ent);
}

/*
=================
Menu_Use (lmctf60/g_menu.c:2103)
=================
*/
export function Menu_Use(ent: EdictT): void {
  if (ent.client === null) return;
  const cl = ent.client;

  let menu: MenuItem[];
  let size: number;

  if (cl.menu === MENU_LOCAL) {
    menu = cl.localmenu;
    size = 18;
  } else {
    const data = menulist[cl.menu];
    menu = data?.menu ?? [];
    size = data?.size ?? 0;
  }

  if (menu.length > 0 && size) {
    const item = menu[cl.menuselect];
    if (item !== undefined && item.func !== null) {
      cl.prevmenu = cl.currmenu;
      cl.currmenu = item.func;

      cl.menulastpage = cl.menupage;
      if (cl.currmenu === cl.prevmenu) {
        cl.menupage++;
      } else {
        cl.menupage = 0;
      }

      item.func(ent);
    }
  }
  //Menu_Draw (ent);
}
