// menu.c -- the full menu tree (M_Init/M_Menu_Main_f and every submenu,
// M_PushMenu/M_PopMenu stack, M_Draw, M_Keydown). There is no menu.h in the
// v3.19 tree, so this basename is free (no collision with a header module,
// unlike console.c/keys.c/qmenu.c).
//
// Export surface: client.h only declares M_Init/M_Keydown/M_Draw/
// M_Menu_Main_f/M_ForceMenuOff/M_AddToServerList (the original pending-stub
// comment on this file listed exactly those six). This unit additionally
// exports M_PushMenu/M_PopMenu beyond that header surface so the menu stack
// can be driven directly by cl_menu.test.ts with fabricated frameworks, per
// this unit's test brief -- every real C caller of M_PushMenu/M_PopMenu is
// itself inside menu.c, so this only widens the module's export list, it
// does not change behavior.
//
// Deviations from the C, collected here instead of repeated at each site:
//  - `re` is `RefExports | null` (ref_gl/ not ported). Every drawing entry
//    point early-returns on `!re`, matching cl_tent.ts's precedent.
//  - Hand-unrolled runs of near-identical `static menuaction_s s_foo_n;`
//    globals (the 22 key-binding actions, the 8 join-server-list actions,
//    the 15 save/load-game actions) are collapsed into arrays built by a
//    loop with identical resulting per-item state.
//  - Field_Key's clipboard paste (ctrl+V / shift+Insert) is dropped: it
//    needs keys.c's `keydown[256]` and Sys_GetClipboardData(), neither
//    ported yet -- see qmenu_impl.ts.
//  - ConsoleFunc drops the `extern void Key_ClearTyping(void);` call: that
//    function isn't exported by keys_impl.ts yet (not in its declared
//    surface) -- reported omission, not a TODO.
//  - M_Menu_Video_f: vid_menu.c lives per-platform (linux/win32/irix);
//    VID_MenuInit/VID_MenuDraw/VID_MenuKey are ported in
//    src/platform/vid_menu.ts and imported here.
//  - PlayerConfig_ScanDirectories: the C walks Sys_FindFirst/FS_ListFiles
//    with SFF_SUBDIR musthave flags neither of which exist in this port's
//    files.ts (FS_ListFiles here takes no attribute filters, and
//    Sys_FindFirst/Sys_FindClose aren't ported at all). Adapted to list
//    `players/*` and probe each entry for a `tris.md2` file directly via
//    FS_LoadFile; functionally equivalent for the common case but does not
//    reject non-directory entries the way SFF_SUBDIR would. Reported as a
//    higher-risk best-effort port.
//  - Create_Savestrings/StartServer_MenuInit's maps.lst read the raw
//    on-disk path the way the C's `fopen` does; ported via files.ts's
//    FS_ReadRawFile (already the project's idiom for that fopen pattern),
//    falling back to FS_LoadFile like the C's `#else` branch.
//  - `name`/`skin`/`rate`/`hand` are `extern cvar_t *` in the C, resolved to
//    cl_main.c's already-registered globals. cl_main.ts keeps them as
//    unexported module-local `let`s, so this file re-resolves them with the
//    same Cvar_Get(name, default, flags) calls cl_main.ts uses -- Cvar_Get
//    is idempotent by name, so this returns the same CvarT object.
//  - `in_joystick`/`win_noalttab` are likewise resolved locally via
//    Cvar_Get since no sibling module exports them yet.
import { viddef } from "./vid";
import { VID_MenuInit, VID_MenuDraw, VID_MenuKey } from "../platform/vid_menu";
import { re, cl, cls } from "./client";
import { KeydestT } from "./client";
import { Sys_Milliseconds } from "../platform/sys";
import { S_StartLocalSound } from "./snd_dma";
import { SCR_DirtyScreen } from "./cl_scrn";
import { CL_PingServers_f, CL_Quit_f, CL_Snd_Restart_f } from "./cl_main";
import { Con_ClearNotify } from "./console_impl";
import { Key_ClearStates, Key_SetBinding, Key_KeynumToString } from "./keys_impl";
import { keybindings } from "./keys";
import {
  K_TAB,
  K_ENTER,
  K_KP_ENTER,
  K_ESCAPE,
  K_BACKSPACE,
  K_DEL,
  K_KP_DEL,
  K_UPARROW,
  K_KP_UPARROW,
  K_DOWNARROW,
  K_KP_DOWNARROW,
  K_LEFTARROW,
  K_KP_LEFTARROW,
  K_RIGHTARROW,
  K_KP_RIGHTARROW,
  K_MOUSE1,
  K_AUX32,
} from "./keys";
import { Cmd_AddCommand } from "../qcommon/cmd";
import { Cbuf_AddText, Cbuf_InsertText, Cbuf_Execute } from "../qcommon/cmd";
import { Cvar_Get, Cvar_Set, Cvar_SetValue, Cvar_VariableValue, Cvar_VariableString, Cvar_ForceSet } from "../qcommon/cvar";
import { Com_Printf, Com_Error, Com_ServerState } from "../qcommon/common";
import { ERR_DROP } from "../qcommon/qcommon";
import type { NetadrT } from "../qcommon/qcommon";
import { NET_AdrToString } from "../platform/net_udp";
import {
  Com_sprintf,
  Q_stricmp,
  CVAR_ARCHIVE,
  CVAR_USERINFO,
  DF_NO_HEALTH,
  DF_NO_ITEMS,
  DF_WEAPONS_STAY,
  DF_NO_FALLING,
  DF_INSTANT_ITEMS,
  DF_SAME_LEVEL,
  DF_SKINTEAMS,
  DF_MODELTEAMS,
  DF_NO_FRIENDLY_FIRE,
  DF_SPAWN_FARTHEST,
  DF_FORCE_RESPAWN,
  DF_NO_ARMOR,
  DF_ALLOW_EXIT,
  DF_INFINITE_AMMO,
  DF_QUAD_DROP,
  DF_FIXED_FOV,
  DF_NO_MINES,
  DF_NO_NUKES,
  DF_NO_STACK_DOUBLE,
  DF_NO_SPHERES,
} from "../shared/q_shared";
import { COM_Parse, type ComParseState } from "../shared/math";
import { FS_Gamedir, FS_LoadFile, FS_FreeFile, FS_ListFiles, FS_NextPath, FS_ReadRawFile, Developer_searchpath } from "../qcommon/files";
import {
  MenuframeworkS,
  MenuactionS,
  MenuseparatorS,
  MenusliderS,
  MenulistS,
  MenufieldS,
  MTYPE_ACTION,
  MTYPE_SLIDER,
  MTYPE_LIST,
  MTYPE_SPINCONTROL,
  MTYPE_SEPARATOR,
  MTYPE_FIELD,
  QMF_LEFT_JUSTIFY,
  QMF_GRAYED,
  QMF_NUMBERSONLY,
  type MenuItemU,
} from "./qmenu";
import { Field_Key, isField, Menu_AddItem, Menu_AdjustCursor, Menu_Center, Menu_Draw, Menu_ItemAtCursor, Menu_SelectItem, Menu_SetStatusBar, Menu_SlideItem } from "./qmenu_impl";
import { fixedLength } from "../shared/fixed";

// C's per-widget callbacks take `void *self` and cast it back to the
// concrete struct type the call site knows it is (`(menuaction_s *)self`,
// `(menulist_s *)self`). No `as` casts here (PORTING.md/rule 2), so these
// narrow MenuItemU by its `generic.type` tag instead.
function isMenuAction(item: MenuItemU): item is MenuactionS {
  return item.generic.type === MTYPE_ACTION;
}
function isMenuList(item: MenuItemU): item is MenulistS {
  return item.generic.type === MTYPE_LIST || item.generic.type === MTYPE_SPINCONTROL;
}

const NUM_CURSOR_FRAMES = 15;

const menu_in_sound = "misc/menu1.wav";
const menu_move_sound = "misc/menu2.wav";
const menu_out_sound = "misc/menu3.wav";

let m_entersound = false; // play after drawing a frame, so caching won't disrupt the sound

let m_drawfunc: (() => void) | null = null;
let m_keyfunc: ((key: number) => string | null) | null = null;

//=============================================================================
/* Support Routines */

const MAX_MENU_DEPTH = 8;

interface MenulayerT {
  draw: (() => void) | null;
  key: ((key: number) => string | null) | null;
}

const m_layers: MenulayerT[] = Array.from({ length: MAX_MENU_DEPTH }, () => ({ draw: null, key: null }));
let m_menudepth = 0;

function M_Banner(name: string): void {
  if (!re) return;
  const { w } = re.DrawGetPicSize(name);
  re.DrawPic(viddef.width / 2 - w / 2, viddef.height / 2 - 110, name);
}

export function M_PushMenu(draw: () => void, key: (k: number) => string | null): void {
  if (Cvar_VariableValue("maxclients") === 1 && Com_ServerState()) Cvar_Set("paused", "1");

  // if this menu is already present, drop back to that level
  // to avoid stacking menus by hotkeys
  let i = 0;
  for (i = 0; i < m_menudepth; i++) {
    if (m_layers[i].draw === draw && m_layers[i].key === key) {
      m_menudepth = i;
    }
  }

  if (i === m_menudepth) {
    if (m_menudepth >= MAX_MENU_DEPTH) Com_Error(ERR_DROP, "M_PushMenu: MAX_MENU_DEPTH");
    m_layers[m_menudepth].draw = m_drawfunc;
    m_layers[m_menudepth].key = m_keyfunc;
    m_menudepth++;
  }

  m_drawfunc = draw;
  m_keyfunc = key;

  m_entersound = true;

  cls.key_dest = KeydestT.key_menu;
}

export function M_ForceMenuOff(): void {
  m_drawfunc = null;
  m_keyfunc = null;
  cls.key_dest = KeydestT.key_game;
  m_menudepth = 0;
  Key_ClearStates();
  Cvar_Set("paused", "0");
}

export function M_PopMenu(): void {
  S_StartLocalSound(menu_out_sound);
  if (m_menudepth < 1) Com_Error(ERR_DROP, "M_PopMenu: depth < 1");
  m_menudepth--;

  m_drawfunc = m_layers[m_menudepth].draw;
  m_keyfunc = m_layers[m_menudepth].key;

  if (!m_menudepth) M_ForceMenuOff();
}

function Default_MenuKey(m: MenuframeworkS | null, key: number): string | null {
  let sound: string | null = null;

  if (m) {
    const item = Menu_ItemAtCursor(m);
    if (item && isField(item)) {
      if (Field_Key(item, key)) return null;
    }
  }

  switch (key) {
    case K_ESCAPE:
      M_PopMenu();
      return menu_out_sound;

    case K_KP_UPARROW:
    case K_UPARROW:
      if (m) {
        m.cursor--;
        Menu_AdjustCursor(m, -1);
        sound = menu_move_sound;
      }
      break;

    case K_TAB:
    case K_KP_DOWNARROW:
    case K_DOWNARROW:
      if (m) {
        m.cursor++;
        Menu_AdjustCursor(m, 1);
        sound = menu_move_sound;
      }
      break;

    case K_KP_LEFTARROW:
    case K_LEFTARROW:
      if (m) {
        Menu_SlideItem(m, -1);
        sound = menu_move_sound;
      }
      break;

    case K_KP_RIGHTARROW:
    case K_RIGHTARROW:
      if (m) {
        Menu_SlideItem(m, 1);
        sound = menu_move_sound;
      }
      break;

    default:
      // C spells this out as one huge fallthrough case list: K_MOUSE1..3,
      // K_JOY1..4, K_AUX1..32, K_KP_ENTER, K_ENTER. K_MOUSE1..K_AUX32 are
      // contiguous keynums in keys.ts, so this collapses to a range check.
      if ((key >= K_MOUSE1 && key <= K_AUX32) || key === K_KP_ENTER || key === K_ENTER) {
        if (m) Menu_SelectItem(m);
        sound = menu_move_sound;
      }
      break;
  }

  return sound;
}

//=============================================================================

function M_DrawCharacter(cx: number, cy: number, num: number): void {
  if (!re) return;
  re.DrawChar(cx + ((viddef.width - 320) >> 1), cy + ((viddef.height - 240) >> 1), num);
}

function M_Print(cx: number, cy: number, str: string): void {
  let x = cx;
  for (let i = 0; i < str.length; i++) {
    M_DrawCharacter(x, cy, str.charCodeAt(i) + 128);
    x += 8;
  }
}

function M_PrintWhite(cx: number, cy: number, str: string): void {
  let x = cx;
  for (let i = 0; i < str.length; i++) {
    M_DrawCharacter(x, cy, str.charCodeAt(i));
    x += 8;
  }
}

function M_DrawPic(x: number, y: number, pic: string): void {
  if (!re) return;
  re.DrawPic(x + ((viddef.width - 320) >> 1), y + ((viddef.height - 240) >> 1), pic);
}

let m_cursor_cached = false;

function M_DrawCursor(x: number, y: number, f: number): void {
  if (!re) return;
  if (!m_cursor_cached) {
    for (let i = 0; i < NUM_CURSOR_FRAMES; i++) re.RegisterPic(`m_cursor${i}`);
    m_cursor_cached = true;
  }
  re.DrawPic(x, y, `m_cursor${f}`);
}

function M_DrawTextBox(x: number, y: number, width: number, lines: number): void {
  let cx = x;
  let cy = y;
  M_DrawCharacter(cx, cy, 1);
  for (let n = 0; n < lines; n++) {
    cy += 8;
    M_DrawCharacter(cx, cy, 4);
  }
  M_DrawCharacter(cx, cy + 8, 7);

  cx += 8;
  let w = width;
  while (w > 0) {
    cy = y;
    M_DrawCharacter(cx, cy, 2);
    for (let n = 0; n < lines; n++) {
      cy += 8;
      M_DrawCharacter(cx, cy, 5);
    }
    M_DrawCharacter(cx, cy + 8, 8);
    w -= 1;
    cx += 8;
  }

  cy = y;
  M_DrawCharacter(cx, cy, 3);
  for (let n = 0; n < lines; n++) {
    cy += 8;
    M_DrawCharacter(cx, cy, 6);
  }
  M_DrawCharacter(cx, cy + 8, 9);
}

/*
=======================================================================
MAIN MENU
=======================================================================
*/
const MAIN_ITEMS = 5;
let m_main_cursor = 0;

function M_Main_Draw(): void {
  if (!re) return;

  const names = fixedLength("M_Main_Draw names", MAIN_ITEMS, [
    "m_main_game",
    "m_main_multiplayer",
    "m_main_options",
    "m_main_video",
    "m_main_quit",
  ]);
  let widest = -1;
  for (const n of names) {
    const { w } = re.DrawGetPicSize(n);
    if (w > widest) widest = w;
  }

  const ystart = viddef.height / 2 - 110;
  const xoffset = (viddef.width - widest + 70) / 2;

  for (let i = 0; i < names.length; i++) {
    if (i !== m_main_cursor) re.DrawPic(xoffset, ystart + i * 40 + 13, names[i] ?? "");
  }
  re.DrawPic(xoffset, ystart + m_main_cursor * 40 + 13, `${names[m_main_cursor]}_sel`);

  M_DrawCursor(xoffset - 25, ystart + m_main_cursor * 40 + 11, Math.floor(cls.realtime / 100) % NUM_CURSOR_FRAMES);

  const plaque = re.DrawGetPicSize("m_main_plaque");
  re.DrawPic(xoffset - 30 - plaque.w, ystart, "m_main_plaque");
  re.DrawPic(xoffset - 30 - plaque.w, ystart + plaque.h + 5, "m_main_logo");
}

function M_Main_Key(key: number): string | null {
  const sound = menu_move_sound;

  switch (key) {
    case K_ESCAPE:
      M_PopMenu();
      break;

    case K_KP_DOWNARROW:
    case K_DOWNARROW:
      m_main_cursor = (m_main_cursor + 1) % MAIN_ITEMS;
      return sound;

    case K_KP_UPARROW:
    case K_UPARROW:
      m_main_cursor = (m_main_cursor - 1 + MAIN_ITEMS) % MAIN_ITEMS;
      return sound;

    case K_KP_ENTER:
    case K_ENTER:
      m_entersound = true;

      switch (m_main_cursor) {
        case 0:
          M_Menu_Game_f();
          break;
        case 1:
          M_Menu_Multiplayer_f();
          break;
        case 2:
          M_Menu_Options_f();
          break;
        case 3:
          M_Menu_Video_f();
          break;
        case 4:
          M_Menu_Quit_f();
          break;
      }
      break;
  }

  return null;
}

export function M_Menu_Main_f(): void {
  M_PushMenu(M_Main_Draw, M_Main_Key);
}

/*
=======================================================================
MULTIPLAYER MENU
=======================================================================
*/
const s_multiplayer_menu = new MenuframeworkS();
const s_join_network_server_action = new MenuactionS();
const s_start_network_server_action = new MenuactionS();
const s_player_setup_action = new MenuactionS();

function Multiplayer_MenuDraw(): void {
  M_Banner("m_banner_multiplayer");
  Menu_AdjustCursor(s_multiplayer_menu, 1);
  Menu_Draw(s_multiplayer_menu);
}

function PlayerSetupFunc(): void {
  M_Menu_PlayerConfig_f();
}

function JoinNetworkServerFunc(): void {
  M_Menu_JoinServer_f();
}

function StartNetworkServerFunc(): void {
  M_Menu_StartServer_f();
}

function Multiplayer_MenuInit(): void {
  s_multiplayer_menu.x = viddef.width * 0.5 - 64;
  s_multiplayer_menu.nitems = 0;

  s_join_network_server_action.generic.type = MTYPE_ACTION;
  s_join_network_server_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_join_network_server_action.generic.x = 0;
  s_join_network_server_action.generic.y = 0;
  s_join_network_server_action.generic.name = " join network server";
  s_join_network_server_action.generic.callback = JoinNetworkServerFunc;

  s_start_network_server_action.generic.type = MTYPE_ACTION;
  s_start_network_server_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_start_network_server_action.generic.x = 0;
  s_start_network_server_action.generic.y = 10;
  s_start_network_server_action.generic.name = " start network server";
  s_start_network_server_action.generic.callback = StartNetworkServerFunc;

  s_player_setup_action.generic.type = MTYPE_ACTION;
  s_player_setup_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_player_setup_action.generic.x = 0;
  s_player_setup_action.generic.y = 20;
  s_player_setup_action.generic.name = " player setup";
  s_player_setup_action.generic.callback = PlayerSetupFunc;

  Menu_AddItem(s_multiplayer_menu, s_join_network_server_action);
  Menu_AddItem(s_multiplayer_menu, s_start_network_server_action);
  Menu_AddItem(s_multiplayer_menu, s_player_setup_action);

  Menu_SetStatusBar(s_multiplayer_menu, null);

  Menu_Center(s_multiplayer_menu);
}

function Multiplayer_MenuKey(key: number): string | null {
  return Default_MenuKey(s_multiplayer_menu, key);
}

function M_Menu_Multiplayer_f(): void {
  Multiplayer_MenuInit();
  M_PushMenu(Multiplayer_MenuDraw, Multiplayer_MenuKey);
}

/*
=======================================================================
KEYS MENU
=======================================================================
*/
const bindnames: [string, string][] = [
  ["+attack", "attack"],
  ["weapnext", "next weapon"],
  ["+forward", "walk forward"],
  ["+back", "backpedal"],
  ["+left", "turn left"],
  ["+right", "turn right"],
  ["+speed", "run"],
  ["+moveleft", "step left"],
  ["+moveright", "step right"],
  ["+strafe", "sidestep"],
  ["+lookup", "look up"],
  ["+lookdown", "look down"],
  ["centerview", "center view"],
  ["+mlook", "mouse look"],
  ["+klook", "keyboard look"],
  ["+moveup", "up / jump"],
  ["+movedown", "down / crouch"],
  ["inven", "inventory"],
  ["invuse", "use item"],
  ["invdrop", "drop item"],
  ["invprev", "prev item"],
  ["invnext", "next item"],
  ["cmd help", "help computer"],
];

let bind_grab = false;

const s_keys_menu = new MenuframeworkS();
// hand-unrolled `static menuaction_s s_keys_xxx_action;` per bindnames[]
// entry in the C, collapsed into one array built by a loop (see file header).
const s_keys_actions: MenuactionS[] = bindnames.map(() => new MenuactionS());

function M_UnbindCommand(command: string): void {
  const l = command.length;
  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (!b) continue;
    if (b.slice(0, l) === command) Key_SetBinding(j, "");
  }
}

function M_FindKeysForCommand(command: string, twokeys: [number, number]): void {
  twokeys[0] = -1;
  twokeys[1] = -1;
  const l = command.length;
  let count = 0;

  for (let j = 0; j < 256; j++) {
    const b = keybindings[j];
    if (!b) continue;
    if (b.slice(0, l) === command) {
      twokeys[count] = j;
      count++;
      if (count === 2) break;
    }
  }
}

function KeyCursorDrawFunc(menu: MenuframeworkS): void {
  if (!re) return;
  if (bind_grab) re.DrawChar(menu.x, menu.y + menu.cursor * 9, "=".charCodeAt(0));
  else re.DrawChar(menu.x, menu.y + menu.cursor * 9, 12 + ((Sys_Milliseconds() / 250) & 1));
}

function DrawKeyBindingFunc(self: MenuItemU): void {
  if (!re) return;
  if (!isMenuAction(self)) return;
  const a = self;
  const parent = a.generic.parent;
  if (!parent) return;

  const keys: [number, number] = [-1, -1];
  M_FindKeysForCommand(bindnames[a.generic.localdata[0] ?? 0]?.[0] ?? "", keys);

  if (keys[0] === -1) {
    M_DrawStringLocal(a.generic.x + parent.x + 16, a.generic.y + parent.y, "???");
  } else {
    const name = Key_KeynumToString(keys[0]);
    M_DrawStringLocal(a.generic.x + parent.x + 16, a.generic.y + parent.y, name);

    const x = name.length * 8;

    if (keys[1] !== -1) {
      M_DrawStringLocal(a.generic.x + parent.x + 24 + x, a.generic.y + parent.y, "or");
      M_DrawStringLocal(a.generic.x + parent.x + 48 + x, a.generic.y + parent.y, Key_KeynumToString(keys[1]));
    }
  }
}

// qmenu.c's Menu_DrawString isn't imported into menu.c (it uses the same
// left-to-right glyph loop directly); mirrored locally instead of importing
// qmenu_impl.ts's copy, to match the C translation unit boundary.
function M_DrawStringLocal(x: number, y: number, string: string): void {
  if (!re) return;
  for (let i = 0; i < string.length; i++) re.DrawChar(x + i * 8, y, string.charCodeAt(i));
}

function KeyBindingFunc(self: MenuItemU): void {
  if (!isMenuAction(self)) return;
  const a = self;
  const keys: [number, number] = [-1, -1];
  const command = bindnames[a.generic.localdata[0] ?? 0]?.[0] ?? "";

  M_FindKeysForCommand(command, keys);

  if (keys[1] !== -1) M_UnbindCommand(command);

  bind_grab = true;

  Menu_SetStatusBar(s_keys_menu, "press a key or button for this action");
}

function Keys_MenuInit(): void {
  s_keys_menu.x = viddef.width * 0.5;
  s_keys_menu.nitems = 0;
  s_keys_menu.cursordraw = KeyCursorDrawFunc;

  let y = 0;
  for (let i = 0; i < s_keys_actions.length; i++) {
    const action = s_keys_actions[i];
    if (!action) continue;
    action.generic.type = MTYPE_ACTION;
    action.generic.flags = QMF_GRAYED;
    action.generic.x = 0;
    action.generic.y = y;
    action.generic.ownerdraw = DrawKeyBindingFunc;
    action.generic.localdata[0] = i;
    action.generic.name = bindnames[i]?.[1] ?? null;
    y += 9;
  }

  for (const action of s_keys_actions) Menu_AddItem(s_keys_menu, action);

  Menu_SetStatusBar(s_keys_menu, "enter to change, backspace to clear");
  Menu_Center(s_keys_menu);
}

function Keys_MenuDraw(): void {
  Menu_AdjustCursor(s_keys_menu, 1);
  Menu_Draw(s_keys_menu);
}

function Keys_MenuKey(key: number): string | null {
  const rawItem = Menu_ItemAtCursor(s_keys_menu);
  const item = rawItem && isMenuAction(rawItem) ? rawItem : null;

  if (bind_grab) {
    if (key !== K_ESCAPE && key !== "`".charCodeAt(0) && item) {
      const cmd = Com_sprintf('bind "%s" "%s"\n', Key_KeynumToString(key), bindnames[item.generic.localdata[0] ?? 0]?.[0] ?? "");
      Cbuf_InsertText(cmd);
    }

    Menu_SetStatusBar(s_keys_menu, "enter to change, backspace to clear");
    bind_grab = false;
    return menu_out_sound;
  }

  switch (key) {
    case K_KP_ENTER:
    case K_ENTER:
      if (item) KeyBindingFunc(item);
      return menu_in_sound;
    case K_BACKSPACE:
    case K_DEL:
    case K_KP_DEL:
      if (item) M_UnbindCommand(bindnames[item.generic.localdata[0] ?? 0]?.[0] ?? "");
      return menu_out_sound;
    default:
      return Default_MenuKey(s_keys_menu, key);
  }
}

// unreferenced in the C tree too (the only cursordraw assignment uses
// KeyCursorDrawFunc); ported for completeness.
function NullCursorDraw(_self: unknown): void {}
void NullCursorDraw; // referenced so tsc's unused check stays quiet, like the C linker kept the symbol

function M_Menu_Keys_f(): void {
  Keys_MenuInit();
  M_PushMenu(Keys_MenuDraw, Keys_MenuKey);
}

/*
=======================================================================
CONTROLS MENU
=======================================================================
*/
let win_noalttab = Cvar_Get("win_noalttab", "0", CVAR_ARCHIVE);

const s_options_menu = new MenuframeworkS();
const s_options_defaults_action = new MenuactionS();
const s_options_customize_options_action = new MenuactionS();
const s_options_sensitivity_slider = new MenusliderS();
const s_options_freelook_box = new MenulistS();
const s_options_alwaysrun_box = new MenulistS();
const s_options_invertmouse_box = new MenulistS();
const s_options_lookspring_box = new MenulistS();
const s_options_lookstrafe_box = new MenulistS();
const s_options_crosshair_box = new MenulistS();
const s_options_sfxvolume_slider = new MenusliderS();
const s_options_joystick_box = new MenulistS();
const s_options_cdvolume_box = new MenulistS();
const s_options_quality_list = new MenulistS();
const s_options_compatibility_list = new MenulistS();
const s_options_console_action = new MenuactionS();

function CrosshairFunc(): void {
  Cvar_SetValue("crosshair", s_options_crosshair_box.curvalue);
}

function JoystickFunc(): void {
  Cvar_SetValue("in_joystick", s_options_joystick_box.curvalue);
}

function CustomizeControlsFunc(): void {
  M_Menu_Keys_f();
}

function AlwaysRunFunc(): void {
  Cvar_SetValue("cl_run", s_options_alwaysrun_box.curvalue);
}

function FreeLookFunc(): void {
  Cvar_SetValue("freelook", s_options_freelook_box.curvalue);
}

function MouseSpeedFunc(): void {
  Cvar_SetValue("sensitivity", s_options_sensitivity_slider.curvalue / 2.0);
}

function ClampCvar(min: number, max: number, value: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function ControlsSetMenuItemValues(): void {
  s_options_sfxvolume_slider.curvalue = Cvar_VariableValue("s_volume") * 10;
  s_options_cdvolume_box.curvalue = Cvar_VariableValue("cd_nocd") === 0 ? 1 : 0;
  s_options_quality_list.curvalue = Cvar_VariableValue("s_loadas8bit") === 0 ? 1 : 0;
  s_options_sensitivity_slider.curvalue = Cvar_VariableValue("sensitivity") * 2;

  Cvar_SetValue("cl_run", ClampCvar(0, 1, Cvar_VariableValue("cl_run")));
  s_options_alwaysrun_box.curvalue = Cvar_VariableValue("cl_run");

  s_options_invertmouse_box.curvalue = Cvar_VariableValue("m_pitch") < 0 ? 1 : 0;

  Cvar_SetValue("lookspring", ClampCvar(0, 1, Cvar_VariableValue("lookspring")));
  s_options_lookspring_box.curvalue = Cvar_VariableValue("lookspring");

  Cvar_SetValue("lookstrafe", ClampCvar(0, 1, Cvar_VariableValue("lookstrafe")));
  s_options_lookstrafe_box.curvalue = Cvar_VariableValue("lookstrafe");

  Cvar_SetValue("freelook", ClampCvar(0, 1, Cvar_VariableValue("freelook")));
  s_options_freelook_box.curvalue = Cvar_VariableValue("freelook");

  Cvar_SetValue("crosshair", ClampCvar(0, 3, Cvar_VariableValue("crosshair")));
  s_options_crosshair_box.curvalue = Cvar_VariableValue("crosshair");

  Cvar_SetValue("in_joystick", ClampCvar(0, 1, Cvar_VariableValue("in_joystick")));
  s_options_joystick_box.curvalue = Cvar_VariableValue("in_joystick");

  s_options_noalttab_curvalue_sync();
}

function s_options_noalttab_curvalue_sync(): void {
  if (win_noalttab) win_noalttab.value = win_noalttab.value; // no-op: item not added to the menu (see below)
}

function ControlsResetDefaultsFunc(): void {
  Cbuf_AddText("exec default.cfg\n");
  Cbuf_Execute();

  ControlsSetMenuItemValues();
}

function InvertMouseFunc(): void {
  Cvar_SetValue("m_pitch", -Cvar_VariableValue("m_pitch"));
}

function LookspringFunc(): void {
  Cvar_SetValue("lookspring", Cvar_VariableValue("lookspring") === 0 ? 1 : 0);
}

function LookstrafeFunc(): void {
  Cvar_SetValue("lookstrafe", Cvar_VariableValue("lookstrafe") === 0 ? 1 : 0);
}

function UpdateVolumeFunc(): void {
  Cvar_SetValue("s_volume", s_options_sfxvolume_slider.curvalue / 10);
}

function UpdateCDVolumeFunc(): void {
  Cvar_SetValue("cd_nocd", s_options_cdvolume_box.curvalue ? 0 : 1);
}

function ConsoleFunc(): void {
  // extern void Key_ClearTyping(void); -- dropped: not exported by
  // keys_impl.ts yet (see file header deviation note).
  if (cl.attractloop) {
    Cbuf_AddText("killserver\n");
    return;
  }

  Con_ClearNotify();

  M_ForceMenuOff();
  cls.key_dest = KeydestT.key_console;
}

function UpdateSoundQualityFunc(): void {
  if (s_options_quality_list.curvalue) {
    Cvar_SetValue("s_khz", 22);
    Cvar_SetValue("s_loadas8bit", 0);
  } else {
    Cvar_SetValue("s_khz", 11);
    Cvar_SetValue("s_loadas8bit", 1);
  }

  Cvar_SetValue("s_primary", s_options_compatibility_list.curvalue);

  M_DrawTextBox(8, 120 - 48, 36, 3);
  M_Print(16 + 16, 120 - 48 + 8, "Restarting the sound system. This");
  M_Print(16 + 16, 120 - 48 + 16, "could take up to a minute, so");
  M_Print(16 + 16, 120 - 48 + 24, "please be patient.");

  // the text box won't show up unless we do a buffer swap
  if (re) re.EndFrame();

  CL_Snd_Restart_f();
}

function Options_MenuInit(): void {
  const cd_music_items = ["disabled", "enabled"];
  const quality_items = ["low", "high"];
  const compatibility_items = ["max compatibility", "max performance"];
  const yesno_names = ["no", "yes"];
  const crosshair_names = ["none", "cross", "dot", "angle"];

  win_noalttab = Cvar_Get("win_noalttab", "0", CVAR_ARCHIVE);

  s_options_menu.x = viddef.width / 2;
  s_options_menu.y = viddef.height / 2 - 58;
  s_options_menu.nitems = 0;

  s_options_sfxvolume_slider.generic.type = MTYPE_SLIDER;
  s_options_sfxvolume_slider.generic.x = 0;
  s_options_sfxvolume_slider.generic.y = 0;
  s_options_sfxvolume_slider.generic.name = "effects volume";
  s_options_sfxvolume_slider.generic.callback = UpdateVolumeFunc;
  s_options_sfxvolume_slider.minvalue = 0;
  s_options_sfxvolume_slider.maxvalue = 10;
  s_options_sfxvolume_slider.curvalue = Cvar_VariableValue("s_volume") * 10;

  s_options_cdvolume_box.generic.type = MTYPE_SPINCONTROL;
  s_options_cdvolume_box.generic.x = 0;
  s_options_cdvolume_box.generic.y = 10;
  s_options_cdvolume_box.generic.name = "CD music";
  s_options_cdvolume_box.generic.callback = UpdateCDVolumeFunc;
  s_options_cdvolume_box.itemnames = cd_music_items;
  s_options_cdvolume_box.curvalue = Cvar_VariableValue("cd_nocd") === 0 ? 1 : 0;

  s_options_quality_list.generic.type = MTYPE_SPINCONTROL;
  s_options_quality_list.generic.x = 0;
  s_options_quality_list.generic.y = 20;
  s_options_quality_list.generic.name = "sound quality";
  s_options_quality_list.generic.callback = UpdateSoundQualityFunc;
  s_options_quality_list.itemnames = quality_items;
  s_options_quality_list.curvalue = Cvar_VariableValue("s_loadas8bit") === 0 ? 1 : 0;

  s_options_compatibility_list.generic.type = MTYPE_SPINCONTROL;
  s_options_compatibility_list.generic.x = 0;
  s_options_compatibility_list.generic.y = 30;
  s_options_compatibility_list.generic.name = "sound compatibility";
  s_options_compatibility_list.generic.callback = UpdateSoundQualityFunc;
  s_options_compatibility_list.itemnames = compatibility_items;
  s_options_compatibility_list.curvalue = Cvar_VariableValue("s_primary");

  s_options_sensitivity_slider.generic.type = MTYPE_SLIDER;
  s_options_sensitivity_slider.generic.x = 0;
  s_options_sensitivity_slider.generic.y = 50;
  s_options_sensitivity_slider.generic.name = "mouse speed";
  s_options_sensitivity_slider.generic.callback = MouseSpeedFunc;
  s_options_sensitivity_slider.minvalue = 2;
  s_options_sensitivity_slider.maxvalue = 22;

  s_options_alwaysrun_box.generic.type = MTYPE_SPINCONTROL;
  s_options_alwaysrun_box.generic.x = 0;
  s_options_alwaysrun_box.generic.y = 60;
  s_options_alwaysrun_box.generic.name = "always run";
  s_options_alwaysrun_box.generic.callback = AlwaysRunFunc;
  s_options_alwaysrun_box.itemnames = yesno_names;

  s_options_invertmouse_box.generic.type = MTYPE_SPINCONTROL;
  s_options_invertmouse_box.generic.x = 0;
  s_options_invertmouse_box.generic.y = 70;
  s_options_invertmouse_box.generic.name = "invert mouse";
  s_options_invertmouse_box.generic.callback = InvertMouseFunc;
  s_options_invertmouse_box.itemnames = yesno_names;

  s_options_lookspring_box.generic.type = MTYPE_SPINCONTROL;
  s_options_lookspring_box.generic.x = 0;
  s_options_lookspring_box.generic.y = 80;
  s_options_lookspring_box.generic.name = "lookspring";
  s_options_lookspring_box.generic.callback = LookspringFunc;
  s_options_lookspring_box.itemnames = yesno_names;

  s_options_lookstrafe_box.generic.type = MTYPE_SPINCONTROL;
  s_options_lookstrafe_box.generic.x = 0;
  s_options_lookstrafe_box.generic.y = 90;
  s_options_lookstrafe_box.generic.name = "lookstrafe";
  s_options_lookstrafe_box.generic.callback = LookstrafeFunc;
  s_options_lookstrafe_box.itemnames = yesno_names;

  s_options_freelook_box.generic.type = MTYPE_SPINCONTROL;
  s_options_freelook_box.generic.x = 0;
  s_options_freelook_box.generic.y = 100;
  s_options_freelook_box.generic.name = "free look";
  s_options_freelook_box.generic.callback = FreeLookFunc;
  s_options_freelook_box.itemnames = yesno_names;

  s_options_crosshair_box.generic.type = MTYPE_SPINCONTROL;
  s_options_crosshair_box.generic.x = 0;
  s_options_crosshair_box.generic.y = 110;
  s_options_crosshair_box.generic.name = "crosshair";
  s_options_crosshair_box.generic.callback = CrosshairFunc;
  s_options_crosshair_box.itemnames = crosshair_names;

  // s_options_noalttab_box is `/* ... */`-commented out in the C original
  // (the whole block, dead per PORTING.md's #if 0 rule) -- not wired here.

  s_options_joystick_box.generic.type = MTYPE_SPINCONTROL;
  s_options_joystick_box.generic.x = 0;
  s_options_joystick_box.generic.y = 120;
  s_options_joystick_box.generic.name = "use joystick";
  s_options_joystick_box.generic.callback = JoystickFunc;
  s_options_joystick_box.itemnames = yesno_names;

  s_options_customize_options_action.generic.type = MTYPE_ACTION;
  s_options_customize_options_action.generic.x = 0;
  s_options_customize_options_action.generic.y = 140;
  s_options_customize_options_action.generic.name = "customize controls";
  s_options_customize_options_action.generic.callback = CustomizeControlsFunc;

  s_options_defaults_action.generic.type = MTYPE_ACTION;
  s_options_defaults_action.generic.x = 0;
  s_options_defaults_action.generic.y = 150;
  s_options_defaults_action.generic.name = "reset defaults";
  s_options_defaults_action.generic.callback = ControlsResetDefaultsFunc;

  s_options_console_action.generic.type = MTYPE_ACTION;
  s_options_console_action.generic.x = 0;
  s_options_console_action.generic.y = 160;
  s_options_console_action.generic.name = "go to console";
  s_options_console_action.generic.callback = ConsoleFunc;

  ControlsSetMenuItemValues();

  Menu_AddItem(s_options_menu, s_options_sfxvolume_slider);
  Menu_AddItem(s_options_menu, s_options_cdvolume_box);
  Menu_AddItem(s_options_menu, s_options_quality_list);
  Menu_AddItem(s_options_menu, s_options_compatibility_list);
  Menu_AddItem(s_options_menu, s_options_sensitivity_slider);
  Menu_AddItem(s_options_menu, s_options_alwaysrun_box);
  Menu_AddItem(s_options_menu, s_options_invertmouse_box);
  Menu_AddItem(s_options_menu, s_options_lookspring_box);
  Menu_AddItem(s_options_menu, s_options_lookstrafe_box);
  Menu_AddItem(s_options_menu, s_options_freelook_box);
  Menu_AddItem(s_options_menu, s_options_crosshair_box);
  Menu_AddItem(s_options_menu, s_options_joystick_box);
  Menu_AddItem(s_options_menu, s_options_customize_options_action);
  Menu_AddItem(s_options_menu, s_options_defaults_action);
  Menu_AddItem(s_options_menu, s_options_console_action);
}

function Options_MenuDraw(): void {
  M_Banner("m_banner_options");
  Menu_AdjustCursor(s_options_menu, 1);
  Menu_Draw(s_options_menu);
}

function Options_MenuKey(key: number): string | null {
  return Default_MenuKey(s_options_menu, key);
}

function M_Menu_Options_f(): void {
  Options_MenuInit();
  M_PushMenu(Options_MenuDraw, Options_MenuKey);
}

/*
=======================================================================
VIDEO MENU
=======================================================================
*/
function M_Menu_Video_f(): void {
  VID_MenuInit();
  M_PushMenu(VID_MenuDraw, VID_MenuKey);
}

/*
=============================================================================
END GAME MENU (CREDITS)
=============================================================================
*/
let credits_start_time = 0;
let credits: readonly string[] = [];
let creditsBuffer: Uint8Array | null = null;

const idcredits: readonly string[] = [
  "+QUAKE II BY ID SOFTWARE",
  "",
  "+PROGRAMMING",
  "John Carmack",
  "John Cash",
  "Brian Hook",
  "",
  "+ART",
  "Adrian Carmack",
  "Kevin Cloud",
  "Paul Steed",
  "",
  "+LEVEL DESIGN",
  "Tim Willits",
  "American McGee",
  "Christian Antkow",
  "Paul Jaquays",
  "Brandon James",
  "",
  "+BIZ",
  "Todd Hollenshead",
  "Barrett (Bear) Alexander",
  "Donna Jackson",
  "",
  "",
  "+SPECIAL THANKS",
  "Ben Donges for beta testing",
  "",
  "",
  "",
  "",
  "",
  "",
  "+ADDITIONAL SUPPORT",
  "",
  "+LINUX PORT AND CTF",
  'Dave "Zoid" Kirsch',
  "",
  "+CINEMATIC SEQUENCES",
  "Ending Cinematic by Blur Studio - ",
  "Venice, CA",
  "",
  "Environment models for Introduction",
  "Cinematic by Karl Dolgener",
  "",
  "Assistance with environment design",
  "by Cliff Iwai",
  "",
  "+SOUND EFFECTS AND MUSIC",
  "Sound Design by Soundelux Media Labs.",
  "Music Composed and Produced by",
  "Soundelux Media Labs.  Special thanks",
  "to Bill Brown, Tom Ozanich, Brian",
  "Celano, Jeff Eisner, and The Soundelux",
  "Players.",
  "",
  '"Level Music" by Sonic Mayhem',
  "www.sonicmayhem.com",
  "",
  '"Quake II Theme Song"',
  "(C) 1997 Rob Zombie. All Rights",
  "Reserved.",
  "",
  'Track 10 ("Climb") by Jer Sypult',
  "",
  "Voice of computers by",
  "Carly Staehlin-Taylor",
  "",
  "+THANKS TO ACTIVISION",
  "+IN PARTICULAR:",
  "",
  "John Tam",
  "Steve Rosenthal",
  "Marty Stratton",
  "Henk Hartong",
  "",
  "Quake II(tm) (C)1997 Id Software, Inc.",
  "All Rights Reserved.  Distributed by",
  "Activision, Inc. under license.",
  "Quake II(tm), the Id Software name,",
  'the "Q II"(tm) logo and id(tm)',
  "logo are trademarks of Id Software,",
  "Inc. Activision(R) is a registered",
  "trademark of Activision, Inc. All",
  "other trademarks and trade names are",
  "properties of their respective owners.",
];

const xatcredits: readonly string[] = [
  "+QUAKE II MISSION PACK: THE RECKONING",
  "+BY",
  "+XATRIX ENTERTAINMENT, INC.",
  "",
  "+DESIGN AND DIRECTION",
  "Drew Markham",
  "",
  "+PRODUCED BY",
  "Greg Goodrich",
  "",
  "+PROGRAMMING",
  "Rafael Paiz",
  "",
  "+LEVEL DESIGN / ADDITIONAL GAME DESIGN",
  "Alex Mayberry",
  "",
  "+LEVEL DESIGN",
  "Mal Blackwell",
  "Dan Koppel",
  "",
  "+ART DIRECTION",
  'Michael "Maxx" Kaufman',
  "",
  "+COMPUTER GRAPHICS SUPERVISOR AND",
  "+CHARACTER ANIMATION DIRECTION",
  "Barry Dempsey",
  "",
  "+SENIOR ANIMATOR AND MODELER",
  "Jason Hoover",
  "",
  "+CHARACTER ANIMATION AND",
  "+MOTION CAPTURE SPECIALIST",
  "Amit Doron",
  "",
  "+ART",
  "Claire Praderie-Markham",
  "Viktor Antonov",
  "Corky Lehmkuhl",
  "",
  "+INTRODUCTION ANIMATION",
  "Dominique Drozdz",
  "",
  "+ADDITIONAL LEVEL DESIGN",
  "Aaron Barber",
  "Rhett Baldwin",
  "",
  "+3D CHARACTER ANIMATION TOOLS",
  "Gerry Tyra, SA Technology",
  "",
  "+ADDITIONAL EDITOR TOOL PROGRAMMING",
  "Robert Duffy",
  "",
  "+ADDITIONAL PROGRAMMING",
  "Ryan Feltrin",
  "",
  "+PRODUCTION COORDINATOR",
  "Victoria Sylvester",
  "",
  "+SOUND DESIGN",
  "Gary Bradfield",
  "",
  "+MUSIC BY",
  "Sonic Mayhem",
  "",
  "",
  "",
  "+SPECIAL THANKS",
  "+TO",
  "+OUR FRIENDS AT ID SOFTWARE",
  "",
  "John Carmack",
  "John Cash",
  "Brian Hook",
  "Adrian Carmack",
  "Kevin Cloud",
  "Paul Steed",
  "Tim Willits",
  "Christian Antkow",
  "Paul Jaquays",
  "Brandon James",
  "Todd Hollenshead",
  "Barrett (Bear) Alexander",
  'Dave "Zoid" Kirsch',
  "Donna Jackson",
  "",
  "",
  "",
  "+THANKS TO ACTIVISION",
  "+IN PARTICULAR:",
  "",
  "Marty Stratton",
  'Henk "The Original Ripper" Hartong',
  "Kevin Kraff",
  "Jamey Gottlieb",
  "Chris Hepburn",
  "",
  "+AND THE GAME TESTERS",
  "",
  "Tim Vanlaw",
  "Doug Jacobs",
  "Steven Rosenthal",
  "David Baker",
  "Chris Campbell",
  "Aaron Casillas",
  "Steve Elwell",
  "Derek Johnstone",
  "Igor Krinitskiy",
  "Samantha Lee",
  "Michael Spann",
  "Chris Toft",
  "Juan Valdes",
  "",
  "+THANKS TO INTERGRAPH COMPUTER SYTEMS",
  "+IN PARTICULAR:",
  "",
  "Michael T. Nicolaou",
  "",
  "",
  "Quake II Mission Pack: The Reckoning",
  "(tm) (C)1998 Id Software, Inc. All",
  "Rights Reserved. Developed by Xatrix",
  "Entertainment, Inc. for Id Software,",
  "Inc. Distributed by Activision Inc.",
  "under license. Quake(R) is a",
  "registered trademark of Id Software,",
  "Inc. Quake II Mission Pack: The",
  "Reckoning(tm), Quake II(tm), the Id",
  'Software name, the "Q II"(tm) logo',
  "and id(tm) logo are trademarks of Id",
  "Software, Inc. Activision(R) is a",
  "registered trademark of Activision,",
  "Inc. Xatrix(R) is a registered",
  "trademark of Xatrix Entertainment,",
  "Inc. All other trademarks and trade",
  "names are properties of their",
  "respective owners.",
];

const roguecredits: readonly string[] = [
  "+QUAKE II MISSION PACK 2: GROUND ZERO",
  "+BY",
  "+ROGUE ENTERTAINMENT, INC.",
  "",
  "+PRODUCED BY",
  "Jim Molinets",
  "",
  "+PROGRAMMING",
  "Peter Mack",
  "Patrick Magruder",
  "",
  "+LEVEL DESIGN",
  "Jim Molinets",
  "Cameron Lamprecht",
  "Berenger Fish",
  "Robert Selitto",
  "Steve Tietze",
  "Steve Thoms",
  "",
  "+ART DIRECTION",
  "Rich Fleider",
  "",
  "+ART",
  "Rich Fleider",
  "Steve Maines",
  "Won Choi",
  "",
  "+ANIMATION SEQUENCES",
  "Creat Studios",
  "Steve Maines",
  "",
  "+ADDITIONAL LEVEL DESIGN",
  "Rich Fleider",
  "Steve Maines",
  "Peter Mack",
  "",
  "+SOUND",
  "James Grunke",
  "",
  "+GROUND ZERO THEME",
  "+AND",
  "+MUSIC BY",
  "Sonic Mayhem",
  "",
  "+VWEP MODELS",
  'Brent "Hentai" Dill',
  "",
  "",
  "",
  "+SPECIAL THANKS",
  "+TO",
  "+OUR FRIENDS AT ID SOFTWARE",
  "",
  "John Carmack",
  "John Cash",
  "Brian Hook",
  "Adrian Carmack",
  "Kevin Cloud",
  "Paul Steed",
  "Tim Willits",
  "Christian Antkow",
  "Paul Jaquays",
  "Brandon James",
  "Todd Hollenshead",
  "Barrett (Bear) Alexander",
  "Katherine Anna Kang",
  "Donna Jackson",
  'Dave "Zoid" Kirsch',
  "",
  "",
  "",
  "+THANKS TO ACTIVISION",
  "+IN PARTICULAR:",
  "",
  "Marty Stratton",
  "Henk Hartong",
  "Mitch Lasky",
  "Steve Rosenthal",
  "Steve Elwell",
  "",
  "+AND THE GAME TESTERS",
  "",
  "The Ranger Clan",
  'Dave "Zoid" Kirsch',
  "Nihilistic Software",
  "Robert Duffy",
  "",
  "And Countless Others",
  "",
  "",
  "",
  "Quake II Mission Pack 2: Ground Zero",
  "(tm) (C)1998 Id Software, Inc. All",
  "Rights Reserved. Developed by Rogue",
  "Entertainment, Inc. for Id Software,",
  "Inc. Distributed by Activision Inc.",
  "under license. Quake(R) is a",
  "registered trademark of Id Software,",
  "Inc. Quake II Mission Pack 2: Ground",
  'Zero(tm), Quake II(tm), the Id',
  'Software name, the "Q II"(tm) logo',
  "and id(tm) logo are trademarks of Id",
  "Software, Inc. Activision(R) is a",
  "registered trademark of Activision,",
  "Inc. Rogue(R) is a registered",
  "trademark of Rogue Entertainment,",
  "Inc. All other trademarks and trade",
  "names are properties of their",
  "respective owners.",
];

function M_Credits_MenuDraw(): void {
  if (!re) return;

  let i = 0;
  let y = viddef.height - (cls.realtime - credits_start_time) / 40.0;
  for (; i < credits.length && y < viddef.height; y += 10, i++) {
    const line = credits[i] ?? "";
    if (y <= -8) continue;

    const bold = line[0] === "+";
    const stringoffset = bold ? 1 : 0;

    for (let j = 0; j + stringoffset < line.length; j++) {
      const x = (viddef.width - line.length * 8 - stringoffset * 8) / 2 + (j + stringoffset) * 8;
      const ch = line.charCodeAt(j + stringoffset);
      re.DrawChar(x, y, bold ? ch + 128 : ch);
    }
  }

  if (y < 0) credits_start_time = cls.realtime;
}

function M_Credits_Key(key: number): string | null {
  switch (key) {
    case K_ESCAPE:
      if (creditsBuffer) FS_FreeFile(creditsBuffer);
      M_PopMenu();
      break;
  }

  return menu_out_sound;
}

function M_Menu_Credits_f(): void {
  creditsBuffer = FS_LoadFile("credits");
  if (creditsBuffer) {
    const text = new TextDecoder().decode(creditsBuffer);
    credits = text.split(/\r\n|\r|\n/).slice(0, 255);
  } else {
    const isdeveloper = Developer_searchpath(1);

    if (isdeveloper === 1) credits = xatcredits;
    else if (isdeveloper === 2) credits = roguecredits;
    else credits = idcredits;
  }

  credits_start_time = cls.realtime;
  M_PushMenu(M_Credits_MenuDraw, M_Credits_Key);
}

/*
=============================================================================
GAME MENU
=============================================================================
*/
const s_game_menu = new MenuframeworkS();
const s_easy_game_action = new MenuactionS();
const s_medium_game_action = new MenuactionS();
const s_hard_game_action = new MenuactionS();
const s_load_game_action = new MenuactionS();
const s_save_game_action = new MenuactionS();
const s_credits_action = new MenuactionS();
const s_blankline = new MenuseparatorS();

function StartGame(): void {
  // disable updates and start the cinematic going
  cl.servercount = -1;
  M_ForceMenuOff();
  Cvar_SetValue("deathmatch", 0);
  Cvar_SetValue("coop", 0);

  Cvar_SetValue("gamerules", 0);

  Cbuf_AddText("loading ; killserver ; wait ; newgame\n");
  cls.key_dest = KeydestT.key_game;
}

function EasyGameFunc(): void {
  Cvar_ForceSet("skill", "0");
  StartGame();
}

function MediumGameFunc(): void {
  Cvar_ForceSet("skill", "1");
  StartGame();
}

function HardGameFunc(): void {
  Cvar_ForceSet("skill", "2");
  StartGame();
}

function LoadGameFunc(): void {
  M_Menu_LoadGame_f();
}

function SaveGameFunc(): void {
  M_Menu_SaveGame_f();
}

function CreditsFunc(): void {
  M_Menu_Credits_f();
}

function Game_MenuInit(): void {
  s_game_menu.x = viddef.width * 0.5;
  s_game_menu.nitems = 0;

  s_easy_game_action.generic.type = MTYPE_ACTION;
  s_easy_game_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_easy_game_action.generic.x = 0;
  s_easy_game_action.generic.y = 0;
  s_easy_game_action.generic.name = "easy";
  s_easy_game_action.generic.callback = EasyGameFunc;

  s_medium_game_action.generic.type = MTYPE_ACTION;
  s_medium_game_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_medium_game_action.generic.x = 0;
  s_medium_game_action.generic.y = 10;
  s_medium_game_action.generic.name = "medium";
  s_medium_game_action.generic.callback = MediumGameFunc;

  s_hard_game_action.generic.type = MTYPE_ACTION;
  s_hard_game_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_hard_game_action.generic.x = 0;
  s_hard_game_action.generic.y = 20;
  s_hard_game_action.generic.name = "hard";
  s_hard_game_action.generic.callback = HardGameFunc;

  s_blankline.generic.type = MTYPE_SEPARATOR;

  s_load_game_action.generic.type = MTYPE_ACTION;
  s_load_game_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_load_game_action.generic.x = 0;
  s_load_game_action.generic.y = 40;
  s_load_game_action.generic.name = "load game";
  s_load_game_action.generic.callback = LoadGameFunc;

  s_save_game_action.generic.type = MTYPE_ACTION;
  s_save_game_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_save_game_action.generic.x = 0;
  s_save_game_action.generic.y = 50;
  s_save_game_action.generic.name = "save game";
  s_save_game_action.generic.callback = SaveGameFunc;

  s_credits_action.generic.type = MTYPE_ACTION;
  s_credits_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_credits_action.generic.x = 0;
  s_credits_action.generic.y = 60;
  s_credits_action.generic.name = "credits";
  s_credits_action.generic.callback = CreditsFunc;

  Menu_AddItem(s_game_menu, s_easy_game_action);
  Menu_AddItem(s_game_menu, s_medium_game_action);
  Menu_AddItem(s_game_menu, s_hard_game_action);
  Menu_AddItem(s_game_menu, s_blankline);
  Menu_AddItem(s_game_menu, s_load_game_action);
  Menu_AddItem(s_game_menu, s_save_game_action);
  Menu_AddItem(s_game_menu, s_blankline);
  Menu_AddItem(s_game_menu, s_credits_action);

  Menu_Center(s_game_menu);
}

function Game_MenuDraw(): void {
  M_Banner("m_banner_game");
  Menu_AdjustCursor(s_game_menu, 1);
  Menu_Draw(s_game_menu);
}

function Game_MenuKey(key: number): string | null {
  return Default_MenuKey(s_game_menu, key);
}

function M_Menu_Game_f(): void {
  Game_MenuInit();
  M_PushMenu(Game_MenuDraw, Game_MenuKey);
}

/*
=============================================================================
LOADGAME / SAVEGAME MENUS
=============================================================================
*/
const MAX_SAVEGAMES = 15;

const s_loadgame_menu = new MenuframeworkS();
const s_loadgame_actions: MenuactionS[] = Array.from({ length: MAX_SAVEGAMES }, () => new MenuactionS());

const s_savegame_menu = new MenuframeworkS();
const s_savegame_actions: MenuactionS[] = Array.from({ length: MAX_SAVEGAMES - 1 }, () => new MenuactionS());

const m_savestrings: string[] = new Array(MAX_SAVEGAMES).fill("");
const m_savevalid: boolean[] = new Array(MAX_SAVEGAMES).fill(false);

function decodeFixedString(buf: Uint8Array, len: number): string {
  const slice = buf.slice(0, Math.min(len, buf.length));
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? slice : slice.slice(0, nul));
}

function Create_Savestrings(): void {
  for (let i = 0; i < MAX_SAVEGAMES; i++) {
    const name = `${FS_Gamedir()}/save/save${i}/server.ssv`;
    const buf = FS_ReadRawFile(name);
    if (!buf) {
      m_savestrings[i] = "<EMPTY>";
      m_savevalid[i] = false;
    } else {
      m_savestrings[i] = decodeFixedString(buf, 32);
      m_savevalid[i] = true;
    }
  }
}

function LoadGameCallback(self: MenuItemU): void {
  if (!isMenuAction(self)) return;
  const index = self.generic.localdata[0] ?? 0;

  if (m_savevalid[index]) Cbuf_AddText(`load save${index}\n`);
  M_ForceMenuOff();
}

function LoadGame_MenuInit(): void {
  s_loadgame_menu.x = viddef.width / 2 - 120;
  s_loadgame_menu.y = viddef.height / 2 - 58;
  s_loadgame_menu.nitems = 0;

  Create_Savestrings();

  for (let i = 0; i < MAX_SAVEGAMES; i++) {
    const action = s_loadgame_actions[i];
    if (!action) continue;

    action.generic.name = m_savestrings[i] ?? "";
    action.generic.flags = QMF_LEFT_JUSTIFY;
    action.generic.localdata[0] = i;
    action.generic.callback = LoadGameCallback;

    action.generic.x = 0;
    action.generic.y = i * 10;
    if (i > 0) action.generic.y += 10; // separate from autosave

    action.generic.type = MTYPE_ACTION;

    Menu_AddItem(s_loadgame_menu, action);
  }
}

function LoadGame_MenuDraw(): void {
  M_Banner("m_banner_load_game");
  Menu_Draw(s_loadgame_menu);
}

function LoadGame_MenuKey(key: number): string | null {
  if (key === K_ESCAPE || key === K_ENTER) {
    s_savegame_menu.cursor = s_loadgame_menu.cursor - 1;
    if (s_savegame_menu.cursor < 0) s_savegame_menu.cursor = 0;
  }
  return Default_MenuKey(s_loadgame_menu, key);
}

function M_Menu_LoadGame_f(): void {
  LoadGame_MenuInit();
  M_PushMenu(LoadGame_MenuDraw, LoadGame_MenuKey);
}

function SaveGameCallback(self: MenuItemU): void {
  if (!isMenuAction(self)) return;
  Cbuf_AddText(`save save${self.generic.localdata[0] ?? 0}\n`);
  M_ForceMenuOff();
}

function SaveGame_MenuDraw(): void {
  M_Banner("m_banner_save_game");
  Menu_AdjustCursor(s_savegame_menu, 1);
  Menu_Draw(s_savegame_menu);
}

function SaveGame_MenuInit(): void {
  s_savegame_menu.x = viddef.width / 2 - 120;
  s_savegame_menu.y = viddef.height / 2 - 58;
  s_savegame_menu.nitems = 0;

  Create_Savestrings();

  // don't include the autosave slot
  for (let i = 0; i < MAX_SAVEGAMES - 1; i++) {
    const action = s_savegame_actions[i];
    if (!action) continue;

    action.generic.name = m_savestrings[i + 1] ?? "";
    action.generic.localdata[0] = i + 1;
    action.generic.flags = QMF_LEFT_JUSTIFY;
    action.generic.callback = SaveGameCallback;

    action.generic.x = 0;
    action.generic.y = i * 10;

    action.generic.type = MTYPE_ACTION;

    Menu_AddItem(s_savegame_menu, action);
  }
}

function SaveGame_MenuKey(key: number): string | null {
  if (key === K_ENTER || key === K_ESCAPE) {
    s_loadgame_menu.cursor = s_savegame_menu.cursor - 1;
    if (s_loadgame_menu.cursor < 0) s_loadgame_menu.cursor = 0;
  }
  return Default_MenuKey(s_savegame_menu, key);
}

function M_Menu_SaveGame_f(): void {
  if (!Com_ServerState()) return; // not playing a game

  SaveGame_MenuInit();
  M_PushMenu(SaveGame_MenuDraw, SaveGame_MenuKey);
  Create_Savestrings();
}

/*
=============================================================================
JOIN SERVER MENU
=============================================================================
*/
const MAX_LOCAL_SERVERS = 8;
const NO_SERVER_STRING = "<no server>";

const s_joinserver_menu = new MenuframeworkS();
const s_joinserver_server_title = new MenuseparatorS();
const s_joinserver_search_action = new MenuactionS();
const s_joinserver_address_book_action = new MenuactionS();
const s_joinserver_server_actions: MenuactionS[] = Array.from({ length: MAX_LOCAL_SERVERS }, () => new MenuactionS());

let m_num_servers = 0;
const local_server_names: string[] = new Array(MAX_LOCAL_SERVERS).fill(NO_SERVER_STRING);
const local_server_netadr: NetadrT[] = [];

export function M_AddToServerList(adr: NetadrT, info: string): void {
  if (m_num_servers === MAX_LOCAL_SERVERS) return;

  let trimmed = info;
  while (trimmed.startsWith(" ")) trimmed = trimmed.slice(1);

  // ignore if duplicated
  for (let i = 0; i < m_num_servers; i++) {
    if (trimmed === local_server_names[i]) return;
  }

  local_server_netadr[m_num_servers] = adr;
  local_server_names[m_num_servers] = trimmed.slice(0, 79);
  m_num_servers++;
}

function JoinServerFunc(self: MenuItemU): void {
  if (!isMenuAction(self)) return;
  const index = s_joinserver_server_actions.indexOf(self);
  if (index === -1) return;

  if (Q_stricmp(local_server_names[index] ?? "", NO_SERVER_STRING) === 0) return;
  if (index >= m_num_servers) return;

  const adr = local_server_netadr[index];
  if (!adr) return;
  Cbuf_AddText(`connect ${NET_AdrToString(adr)}\n`);
  M_ForceMenuOff();
}

function AddressBookFunc(): void {
  M_Menu_AddressBook_f();
}

function SearchLocalGames(): void {
  m_num_servers = 0;
  for (let i = 0; i < MAX_LOCAL_SERVERS; i++) local_server_names[i] = NO_SERVER_STRING;

  M_DrawTextBox(8, 120 - 48, 36, 3);
  M_Print(16 + 16, 120 - 48 + 8, "Searching for local servers, this");
  M_Print(16 + 16, 120 - 48 + 16, "could take up to a minute, so");
  M_Print(16 + 16, 120 - 48 + 24, "please be patient.");

  // the text box won't show up unless we do a buffer swap
  if (re) re.EndFrame();

  // send out info packets (async in this port: NET_Config awaits the bind;
  // fire-and-forget matches the C's synchronous console-command dispatch)
  void CL_PingServers_f();
}

function SearchLocalGamesFunc(): void {
  SearchLocalGames();
}

function JoinServer_MenuInit(): void {
  s_joinserver_menu.x = viddef.width * 0.5 - 120;
  s_joinserver_menu.nitems = 0;

  s_joinserver_address_book_action.generic.type = MTYPE_ACTION;
  s_joinserver_address_book_action.generic.name = "address book";
  s_joinserver_address_book_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_joinserver_address_book_action.generic.x = 0;
  s_joinserver_address_book_action.generic.y = 0;
  s_joinserver_address_book_action.generic.callback = AddressBookFunc;

  s_joinserver_search_action.generic.type = MTYPE_ACTION;
  s_joinserver_search_action.generic.name = "refresh server list";
  s_joinserver_search_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_joinserver_search_action.generic.x = 0;
  s_joinserver_search_action.generic.y = 10;
  s_joinserver_search_action.generic.callback = SearchLocalGamesFunc;
  s_joinserver_search_action.generic.statusbar = "search for servers";

  s_joinserver_server_title.generic.type = MTYPE_SEPARATOR;
  s_joinserver_server_title.generic.name = "connect to...";
  s_joinserver_server_title.generic.x = 80;
  s_joinserver_server_title.generic.y = 30;

  for (let i = 0; i < MAX_LOCAL_SERVERS; i++) {
    const action = s_joinserver_server_actions[i];
    if (!action) continue;

    action.generic.type = MTYPE_ACTION;
    local_server_names[i] = NO_SERVER_STRING;
    action.generic.name = local_server_names[i] ?? null;
    action.generic.flags = QMF_LEFT_JUSTIFY;
    action.generic.x = 0;
    action.generic.y = 40 + i * 10;
    action.generic.callback = JoinServerFunc;
    action.generic.statusbar = "press ENTER to connect";
  }

  Menu_AddItem(s_joinserver_menu, s_joinserver_address_book_action);
  Menu_AddItem(s_joinserver_menu, s_joinserver_server_title);
  Menu_AddItem(s_joinserver_menu, s_joinserver_search_action);

  for (const action of s_joinserver_server_actions) Menu_AddItem(s_joinserver_menu, action);

  Menu_Center(s_joinserver_menu);

  SearchLocalGames();
}

function JoinServer_MenuDraw(): void {
  M_Banner("m_banner_join_server");
  Menu_Draw(s_joinserver_menu);
}

function JoinServer_MenuKey(key: number): string | null {
  return Default_MenuKey(s_joinserver_menu, key);
}

function M_Menu_JoinServer_f(): void {
  JoinServer_MenuInit();
  M_PushMenu(JoinServer_MenuDraw, JoinServer_MenuKey);
}

/*
=============================================================================
START SERVER MENU
=============================================================================
*/
const s_startserver_menu = new MenuframeworkS();
let mapnames: string[] = [];

const s_startserver_start_action = new MenuactionS();
const s_startserver_dmoptions_action = new MenuactionS();
const s_timelimit_field = new MenufieldS();
const s_fraglimit_field = new MenufieldS();
const s_maxclients_field = new MenufieldS();
const s_hostname_field = new MenufieldS();
const s_startmap_list = new MenulistS();
const s_rules_box = new MenulistS();

function DMOptionsFunc(): void {
  if (s_rules_box.curvalue === 1) return;
  M_Menu_DMOptions_f();
}

function RulesChangeFunc(): void {
  // DM
  if (s_rules_box.curvalue === 0) {
    s_maxclients_field.generic.statusbar = null;
    s_startserver_dmoptions_action.generic.statusbar = null;
  } else if (s_rules_box.curvalue === 1) {
    // coop
    s_maxclients_field.generic.statusbar = "4 maximum for cooperative";
    if (parseInt(s_maxclients_field.buffer, 10) > 4) s_maxclients_field.buffer = "4";
    s_startserver_dmoptions_action.generic.statusbar = "N/A for cooperative";
  } else if (Developer_searchpath(2) === 2) {
    // ROGUE GAMES
    if (s_rules_box.curvalue === 2) {
      // tag
      s_maxclients_field.generic.statusbar = null;
      s_startserver_dmoptions_action.generic.statusbar = null;
    }
  }
}

function StartServerActionFunc(): void {
  const chosen = mapnames[s_startmap_list.curvalue] ?? "";
  const nl = chosen.indexOf("\n");
  const startmap = nl === -1 ? chosen : chosen.slice(nl + 1);

  const maxclients = parseInt(s_maxclients_field.buffer, 10) || 0;
  const timelimit = parseInt(s_timelimit_field.buffer, 10) || 0;
  const fraglimit = parseInt(s_fraglimit_field.buffer, 10) || 0;

  Cvar_SetValue("maxclients", ClampCvar(0, maxclients, maxclients));
  Cvar_SetValue("timelimit", ClampCvar(0, timelimit, timelimit));
  Cvar_SetValue("fraglimit", ClampCvar(0, fraglimit, fraglimit));
  Cvar_Set("hostname", s_hostname_field.buffer);

  if (s_rules_box.curvalue < 2 || Developer_searchpath(2) !== 2) {
    Cvar_SetValue("deathmatch", s_rules_box.curvalue ? 0 : 1);
    Cvar_SetValue("coop", s_rules_box.curvalue);
    Cvar_SetValue("gamerules", 0);
  } else {
    Cvar_SetValue("deathmatch", 1); // deathmatch is always true for rogue games, right?
    Cvar_SetValue("coop", 0);
    Cvar_SetValue("gamerules", s_rules_box.curvalue);
  }

  let spot: string | null = null;
  if (s_rules_box.curvalue === 1) {
    if (Q_stricmp(startmap, "bunk1") === 0) spot = "start";
    else if (Q_stricmp(startmap, "mintro") === 0) spot = "start";
    else if (Q_stricmp(startmap, "fact1") === 0) spot = "start";
    else if (Q_stricmp(startmap, "power1") === 0) spot = "pstart";
    else if (Q_stricmp(startmap, "biggun") === 0) spot = "bstart";
    else if (Q_stricmp(startmap, "hangar1") === 0) spot = "unitstart";
    else if (Q_stricmp(startmap, "city1") === 0) spot = "unitstart";
    else if (Q_stricmp(startmap, "boss1") === 0) spot = "bosstart";
  }

  if (spot) {
    if (Com_ServerState()) Cbuf_AddText("disconnect\n");
    Cbuf_AddText(`gamemap "*${startmap}$${spot}"\n`);
  } else {
    Cbuf_AddText(`map ${startmap}\n`);
  }

  M_ForceMenuOff();
}

// Parses maps.lst's "shortname longname" token pairs into "LONGNAME\nSHORTNAME"
// entries for the spincontrol -- the C pre-scans for '\r' to size a malloc,
// which has no JS equivalent; this just parses tokens until COM_Parse hits EOF.
function ParseMapsList(text: string): string[] {
  const state: ComParseState = { data: text, index: 0 };
  const result: string[] = [];

  for (;;) {
    const shortname = COM_Parse(state);
    if (!shortname) break;
    const longname = COM_Parse(state);
    if (!longname) break;
    result.push(`${longname}\n${shortname.toUpperCase()}`);
  }

  return result;
}

function StartServer_MenuInit(): void {
  const dm_coop_names = ["deathmatch", "cooperative"];
  const dm_coop_names_rogue = ["deathmatch", "cooperative", "tag"];

  const raw = FS_ReadRawFile(`${FS_Gamedir()}/maps.lst`) ?? FS_LoadFile("maps.lst");
  if (!raw) Com_Error(ERR_DROP, "couldn't find maps.lst\n");

  mapnames = ParseMapsList(new TextDecoder().decode(raw));
  if (mapnames.length === 0) Com_Error(ERR_DROP, "no maps in maps.lst\n");

  s_startserver_menu.x = viddef.width * 0.5;
  s_startserver_menu.nitems = 0;

  s_startmap_list.generic.type = MTYPE_SPINCONTROL;
  s_startmap_list.generic.x = 0;
  s_startmap_list.generic.y = 0;
  s_startmap_list.generic.name = "initial map";
  s_startmap_list.itemnames = mapnames;

  s_rules_box.generic.type = MTYPE_SPINCONTROL;
  s_rules_box.generic.x = 0;
  s_rules_box.generic.y = 20;
  s_rules_box.generic.name = "rules";

  s_rules_box.itemnames = Developer_searchpath(2) === 2 ? dm_coop_names_rogue : dm_coop_names;

  s_rules_box.curvalue = Cvar_VariableValue("coop") ? 1 : 0;
  s_rules_box.generic.callback = RulesChangeFunc;

  s_timelimit_field.generic.type = MTYPE_FIELD;
  s_timelimit_field.generic.name = "time limit";
  s_timelimit_field.generic.flags = QMF_NUMBERSONLY;
  s_timelimit_field.generic.x = 0;
  s_timelimit_field.generic.y = 36;
  s_timelimit_field.generic.statusbar = "0 = no limit";
  s_timelimit_field.length = 3;
  s_timelimit_field.visible_length = 3;
  s_timelimit_field.buffer = Cvar_VariableString("timelimit");

  s_fraglimit_field.generic.type = MTYPE_FIELD;
  s_fraglimit_field.generic.name = "frag limit";
  s_fraglimit_field.generic.flags = QMF_NUMBERSONLY;
  s_fraglimit_field.generic.x = 0;
  s_fraglimit_field.generic.y = 54;
  s_fraglimit_field.generic.statusbar = "0 = no limit";
  s_fraglimit_field.length = 3;
  s_fraglimit_field.visible_length = 3;
  s_fraglimit_field.buffer = Cvar_VariableString("fraglimit");

  s_maxclients_field.generic.type = MTYPE_FIELD;
  s_maxclients_field.generic.name = "max players";
  s_maxclients_field.generic.flags = QMF_NUMBERSONLY;
  s_maxclients_field.generic.x = 0;
  s_maxclients_field.generic.y = 72;
  s_maxclients_field.generic.statusbar = null;
  s_maxclients_field.length = 3;
  s_maxclients_field.visible_length = 3;
  s_maxclients_field.buffer = Cvar_VariableValue("maxclients") === 1 ? "8" : Cvar_VariableString("maxclients");

  s_hostname_field.generic.type = MTYPE_FIELD;
  s_hostname_field.generic.name = "hostname";
  s_hostname_field.generic.flags = 0;
  s_hostname_field.generic.x = 0;
  s_hostname_field.generic.y = 90;
  s_hostname_field.generic.statusbar = null;
  s_hostname_field.length = 12;
  s_hostname_field.visible_length = 12;
  s_hostname_field.buffer = Cvar_VariableString("hostname");

  s_startserver_dmoptions_action.generic.type = MTYPE_ACTION;
  s_startserver_dmoptions_action.generic.name = " deathmatch flags";
  s_startserver_dmoptions_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_startserver_dmoptions_action.generic.x = 24;
  s_startserver_dmoptions_action.generic.y = 108;
  s_startserver_dmoptions_action.generic.statusbar = null;
  s_startserver_dmoptions_action.generic.callback = DMOptionsFunc;

  s_startserver_start_action.generic.type = MTYPE_ACTION;
  s_startserver_start_action.generic.name = " begin";
  s_startserver_start_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_startserver_start_action.generic.x = 24;
  s_startserver_start_action.generic.y = 128;
  s_startserver_start_action.generic.callback = StartServerActionFunc;

  Menu_AddItem(s_startserver_menu, s_startmap_list);
  Menu_AddItem(s_startserver_menu, s_rules_box);
  Menu_AddItem(s_startserver_menu, s_timelimit_field);
  Menu_AddItem(s_startserver_menu, s_fraglimit_field);
  Menu_AddItem(s_startserver_menu, s_maxclients_field);
  Menu_AddItem(s_startserver_menu, s_hostname_field);
  Menu_AddItem(s_startserver_menu, s_startserver_dmoptions_action);
  Menu_AddItem(s_startserver_menu, s_startserver_start_action);

  Menu_Center(s_startserver_menu);

  // call this now to set proper inital state
  RulesChangeFunc();
}

function StartServer_MenuDraw(): void {
  Menu_Draw(s_startserver_menu);
}

function StartServer_MenuKey(key: number): string | null {
  if (key === K_ESCAPE) {
    mapnames = [];
  }
  return Default_MenuKey(s_startserver_menu, key);
}

function M_Menu_StartServer_f(): void {
  StartServer_MenuInit();
  M_PushMenu(StartServer_MenuDraw, StartServer_MenuKey);
}

/*
=============================================================================
DMOPTIONS MENU
=============================================================================
*/
let dmoptions_statusbar = "";

const s_dmoptions_menu = new MenuframeworkS();

const s_friendlyfire_box = new MenulistS();
const s_falls_box = new MenulistS();
const s_weapons_stay_box = new MenulistS();
const s_instant_powerups_box = new MenulistS();
const s_powerups_box = new MenulistS();
const s_health_box = new MenulistS();
const s_spawn_farthest_box = new MenulistS();
const s_teamplay_box = new MenulistS();
const s_samelevel_box = new MenulistS();
const s_force_respawn_box = new MenulistS();
const s_armor_box = new MenulistS();
const s_allow_exit_box = new MenulistS();
const s_infinite_ammo_box = new MenulistS();
const s_fixed_fov_box = new MenulistS();
const s_quad_drop_box = new MenulistS();

const s_no_mines_box = new MenulistS();
const s_no_nukes_box = new MenulistS();
const s_stack_double_box = new MenulistS();
const s_no_spheres_box = new MenulistS();

function DMFlagCallback(self: MenuItemU): void {
  if (!isMenuList(self)) return;
  const f = self;
  let flags = Cvar_VariableValue("dmflags");
  let bit = 0;
  let useSetValue = false;

  if (f === s_friendlyfire_box) {
    flags = f.curvalue ? flags & ~DF_NO_FRIENDLY_FIRE : flags | DF_NO_FRIENDLY_FIRE;
    useSetValue = true;
  } else if (f === s_falls_box) {
    flags = f.curvalue ? flags & ~DF_NO_FALLING : flags | DF_NO_FALLING;
    useSetValue = true;
  } else if (f === s_weapons_stay_box) {
    bit = DF_WEAPONS_STAY;
  } else if (f === s_instant_powerups_box) {
    bit = DF_INSTANT_ITEMS;
  } else if (f === s_allow_exit_box) {
    bit = DF_ALLOW_EXIT;
  } else if (f === s_powerups_box) {
    flags = f.curvalue ? flags & ~DF_NO_ITEMS : flags | DF_NO_ITEMS;
    useSetValue = true;
  } else if (f === s_health_box) {
    flags = f.curvalue ? flags & ~DF_NO_HEALTH : flags | DF_NO_HEALTH;
    useSetValue = true;
  } else if (f === s_spawn_farthest_box) {
    bit = DF_SPAWN_FARTHEST;
  } else if (f === s_teamplay_box) {
    if (f.curvalue === 1) flags = (flags | DF_SKINTEAMS) & ~DF_MODELTEAMS;
    else if (f.curvalue === 2) flags = (flags | DF_MODELTEAMS) & ~DF_SKINTEAMS;
    else flags = flags & ~(DF_MODELTEAMS | DF_SKINTEAMS);
    useSetValue = true;
  } else if (f === s_samelevel_box) {
    bit = DF_SAME_LEVEL;
  } else if (f === s_force_respawn_box) {
    bit = DF_FORCE_RESPAWN;
  } else if (f === s_armor_box) {
    flags = f.curvalue ? flags & ~DF_NO_ARMOR : flags | DF_NO_ARMOR;
    useSetValue = true;
  } else if (f === s_infinite_ammo_box) {
    bit = DF_INFINITE_AMMO;
  } else if (f === s_fixed_fov_box) {
    bit = DF_FIXED_FOV;
  } else if (f === s_quad_drop_box) {
    bit = DF_QUAD_DROP;
  } else if (Developer_searchpath(2) === 2) {
    if (f === s_no_mines_box) bit = DF_NO_MINES;
    else if (f === s_no_nukes_box) bit = DF_NO_NUKES;
    else if (f === s_stack_double_box) bit = DF_NO_STACK_DOUBLE;
    else if (f === s_no_spheres_box) bit = DF_NO_SPHERES;
  }

  if (!useSetValue) {
    flags = f.curvalue === 0 ? flags & ~bit : flags | bit;
  }

  Cvar_SetValue("dmflags", flags);
  dmoptions_statusbar = `dmflags = ${flags}`;
}

function DMOptions_MenuInit(): void {
  const yes_no_names = ["no", "yes"];
  const teamplay_names = ["disabled", "by skin", "by model"];
  const dmflags = Cvar_VariableValue("dmflags");
  let y = 0;

  s_dmoptions_menu.x = viddef.width * 0.5;
  s_dmoptions_menu.nitems = 0;

  s_falls_box.generic.type = MTYPE_SPINCONTROL;
  s_falls_box.generic.x = 0;
  s_falls_box.generic.y = y;
  s_falls_box.generic.name = "falling damage";
  s_falls_box.generic.callback = DMFlagCallback;
  s_falls_box.itemnames = yes_no_names;
  s_falls_box.curvalue = (dmflags & DF_NO_FALLING) === 0 ? 1 : 0;

  s_weapons_stay_box.generic.type = MTYPE_SPINCONTROL;
  s_weapons_stay_box.generic.x = 0;
  s_weapons_stay_box.generic.y = (y += 10);
  s_weapons_stay_box.generic.name = "weapons stay";
  s_weapons_stay_box.generic.callback = DMFlagCallback;
  s_weapons_stay_box.itemnames = yes_no_names;
  s_weapons_stay_box.curvalue = (dmflags & DF_WEAPONS_STAY) !== 0 ? 1 : 0;

  s_instant_powerups_box.generic.type = MTYPE_SPINCONTROL;
  s_instant_powerups_box.generic.x = 0;
  s_instant_powerups_box.generic.y = (y += 10);
  s_instant_powerups_box.generic.name = "instant powerups";
  s_instant_powerups_box.generic.callback = DMFlagCallback;
  s_instant_powerups_box.itemnames = yes_no_names;
  s_instant_powerups_box.curvalue = (dmflags & DF_INSTANT_ITEMS) !== 0 ? 1 : 0;

  s_powerups_box.generic.type = MTYPE_SPINCONTROL;
  s_powerups_box.generic.x = 0;
  s_powerups_box.generic.y = (y += 10);
  s_powerups_box.generic.name = "allow powerups";
  s_powerups_box.generic.callback = DMFlagCallback;
  s_powerups_box.itemnames = yes_no_names;
  s_powerups_box.curvalue = (dmflags & DF_NO_ITEMS) === 0 ? 1 : 0;

  s_health_box.generic.type = MTYPE_SPINCONTROL;
  s_health_box.generic.x = 0;
  s_health_box.generic.y = (y += 10);
  s_health_box.generic.callback = DMFlagCallback;
  s_health_box.generic.name = "allow health";
  s_health_box.itemnames = yes_no_names;
  s_health_box.curvalue = (dmflags & DF_NO_HEALTH) === 0 ? 1 : 0;

  s_armor_box.generic.type = MTYPE_SPINCONTROL;
  s_armor_box.generic.x = 0;
  s_armor_box.generic.y = (y += 10);
  s_armor_box.generic.name = "allow armor";
  s_armor_box.generic.callback = DMFlagCallback;
  s_armor_box.itemnames = yes_no_names;
  s_armor_box.curvalue = (dmflags & DF_NO_ARMOR) === 0 ? 1 : 0;

  s_spawn_farthest_box.generic.type = MTYPE_SPINCONTROL;
  s_spawn_farthest_box.generic.x = 0;
  s_spawn_farthest_box.generic.y = (y += 10);
  s_spawn_farthest_box.generic.name = "spawn farthest";
  s_spawn_farthest_box.generic.callback = DMFlagCallback;
  s_spawn_farthest_box.itemnames = yes_no_names;
  s_spawn_farthest_box.curvalue = (dmflags & DF_SPAWN_FARTHEST) !== 0 ? 1 : 0;

  s_samelevel_box.generic.type = MTYPE_SPINCONTROL;
  s_samelevel_box.generic.x = 0;
  s_samelevel_box.generic.y = (y += 10);
  s_samelevel_box.generic.name = "same map";
  s_samelevel_box.generic.callback = DMFlagCallback;
  s_samelevel_box.itemnames = yes_no_names;
  s_samelevel_box.curvalue = (dmflags & DF_SAME_LEVEL) !== 0 ? 1 : 0;

  s_force_respawn_box.generic.type = MTYPE_SPINCONTROL;
  s_force_respawn_box.generic.x = 0;
  s_force_respawn_box.generic.y = (y += 10);
  s_force_respawn_box.generic.name = "force respawn";
  s_force_respawn_box.generic.callback = DMFlagCallback;
  s_force_respawn_box.itemnames = yes_no_names;
  s_force_respawn_box.curvalue = (dmflags & DF_FORCE_RESPAWN) !== 0 ? 1 : 0;

  s_teamplay_box.generic.type = MTYPE_SPINCONTROL;
  s_teamplay_box.generic.x = 0;
  s_teamplay_box.generic.y = (y += 10);
  s_teamplay_box.generic.name = "teamplay";
  s_teamplay_box.generic.callback = DMFlagCallback;
  s_teamplay_box.itemnames = teamplay_names;

  s_allow_exit_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_exit_box.generic.x = 0;
  s_allow_exit_box.generic.y = (y += 10);
  s_allow_exit_box.generic.name = "allow exit";
  s_allow_exit_box.generic.callback = DMFlagCallback;
  s_allow_exit_box.itemnames = yes_no_names;
  s_allow_exit_box.curvalue = (dmflags & DF_ALLOW_EXIT) !== 0 ? 1 : 0;

  s_infinite_ammo_box.generic.type = MTYPE_SPINCONTROL;
  s_infinite_ammo_box.generic.x = 0;
  s_infinite_ammo_box.generic.y = (y += 10);
  s_infinite_ammo_box.generic.name = "infinite ammo";
  s_infinite_ammo_box.generic.callback = DMFlagCallback;
  s_infinite_ammo_box.itemnames = yes_no_names;
  s_infinite_ammo_box.curvalue = (dmflags & DF_INFINITE_AMMO) !== 0 ? 1 : 0;

  s_fixed_fov_box.generic.type = MTYPE_SPINCONTROL;
  s_fixed_fov_box.generic.x = 0;
  s_fixed_fov_box.generic.y = (y += 10);
  s_fixed_fov_box.generic.name = "fixed FOV";
  s_fixed_fov_box.generic.callback = DMFlagCallback;
  s_fixed_fov_box.itemnames = yes_no_names;
  s_fixed_fov_box.curvalue = (dmflags & DF_FIXED_FOV) !== 0 ? 1 : 0;

  s_quad_drop_box.generic.type = MTYPE_SPINCONTROL;
  s_quad_drop_box.generic.x = 0;
  s_quad_drop_box.generic.y = (y += 10);
  s_quad_drop_box.generic.name = "quad drop";
  s_quad_drop_box.generic.callback = DMFlagCallback;
  s_quad_drop_box.itemnames = yes_no_names;
  s_quad_drop_box.curvalue = (dmflags & DF_QUAD_DROP) !== 0 ? 1 : 0;

  s_friendlyfire_box.generic.type = MTYPE_SPINCONTROL;
  s_friendlyfire_box.generic.x = 0;
  s_friendlyfire_box.generic.y = (y += 10);
  s_friendlyfire_box.generic.name = "friendly fire";
  s_friendlyfire_box.generic.callback = DMFlagCallback;
  s_friendlyfire_box.itemnames = yes_no_names;
  s_friendlyfire_box.curvalue = (dmflags & DF_NO_FRIENDLY_FIRE) === 0 ? 1 : 0;

  const rogue = Developer_searchpath(2) === 2;
  if (rogue) {
    s_no_mines_box.generic.type = MTYPE_SPINCONTROL;
    s_no_mines_box.generic.x = 0;
    s_no_mines_box.generic.y = (y += 10);
    s_no_mines_box.generic.name = "remove mines";
    s_no_mines_box.generic.callback = DMFlagCallback;
    s_no_mines_box.itemnames = yes_no_names;
    s_no_mines_box.curvalue = (dmflags & DF_NO_MINES) !== 0 ? 1 : 0;

    s_no_nukes_box.generic.type = MTYPE_SPINCONTROL;
    s_no_nukes_box.generic.x = 0;
    s_no_nukes_box.generic.y = (y += 10);
    s_no_nukes_box.generic.name = "remove nukes";
    s_no_nukes_box.generic.callback = DMFlagCallback;
    s_no_nukes_box.itemnames = yes_no_names;
    s_no_nukes_box.curvalue = (dmflags & DF_NO_NUKES) !== 0 ? 1 : 0;

    s_stack_double_box.generic.type = MTYPE_SPINCONTROL;
    s_stack_double_box.generic.x = 0;
    s_stack_double_box.generic.y = (y += 10);
    s_stack_double_box.generic.name = "2x/4x stacking off";
    s_stack_double_box.generic.callback = DMFlagCallback;
    s_stack_double_box.itemnames = yes_no_names;
    s_stack_double_box.curvalue = (dmflags & DF_NO_STACK_DOUBLE) !== 0 ? 1 : 0;

    s_no_spheres_box.generic.type = MTYPE_SPINCONTROL;
    s_no_spheres_box.generic.x = 0;
    s_no_spheres_box.generic.y = (y += 10);
    s_no_spheres_box.generic.name = "remove spheres";
    s_no_spheres_box.generic.callback = DMFlagCallback;
    s_no_spheres_box.itemnames = yes_no_names;
    s_no_spheres_box.curvalue = (dmflags & DF_NO_SPHERES) !== 0 ? 1 : 0;
  }

  Menu_AddItem(s_dmoptions_menu, s_falls_box);
  Menu_AddItem(s_dmoptions_menu, s_weapons_stay_box);
  Menu_AddItem(s_dmoptions_menu, s_instant_powerups_box);
  Menu_AddItem(s_dmoptions_menu, s_powerups_box);
  Menu_AddItem(s_dmoptions_menu, s_health_box);
  Menu_AddItem(s_dmoptions_menu, s_armor_box);
  Menu_AddItem(s_dmoptions_menu, s_spawn_farthest_box);
  Menu_AddItem(s_dmoptions_menu, s_samelevel_box);
  Menu_AddItem(s_dmoptions_menu, s_force_respawn_box);
  Menu_AddItem(s_dmoptions_menu, s_teamplay_box);
  Menu_AddItem(s_dmoptions_menu, s_allow_exit_box);
  Menu_AddItem(s_dmoptions_menu, s_infinite_ammo_box);
  Menu_AddItem(s_dmoptions_menu, s_fixed_fov_box);
  Menu_AddItem(s_dmoptions_menu, s_quad_drop_box);
  Menu_AddItem(s_dmoptions_menu, s_friendlyfire_box);

  if (rogue) {
    Menu_AddItem(s_dmoptions_menu, s_no_mines_box);
    Menu_AddItem(s_dmoptions_menu, s_no_nukes_box);
    Menu_AddItem(s_dmoptions_menu, s_stack_double_box);
    Menu_AddItem(s_dmoptions_menu, s_no_spheres_box);
  }

  Menu_Center(s_dmoptions_menu);

  // set the original dmflags statusbar
  DMFlagCallback(s_falls_box);
  dmoptions_statusbar = `dmflags = ${dmflags}`;
  Menu_SetStatusBar(s_dmoptions_menu, dmoptions_statusbar);
}

function DMOptions_MenuDraw(): void {
  Menu_Draw(s_dmoptions_menu);
}

function DMOptions_MenuKey(key: number): string | null {
  return Default_MenuKey(s_dmoptions_menu, key);
}

function M_Menu_DMOptions_f(): void {
  DMOptions_MenuInit();
  M_PushMenu(DMOptions_MenuDraw, DMOptions_MenuKey);
}

/*
=============================================================================
DOWNLOADOPTIONS MENU
=============================================================================
*/
const s_downloadoptions_menu = new MenuframeworkS();
const s_download_title = new MenuseparatorS();
const s_allow_download_box = new MenulistS();
const s_allow_download_maps_box = new MenulistS();
const s_allow_download_models_box = new MenulistS();
const s_allow_download_players_box = new MenulistS();
const s_allow_download_sounds_box = new MenulistS();

function DownloadCallback(self: MenuItemU): void {
  if (!isMenuList(self)) return;
  const f = self;

  if (f === s_allow_download_box) Cvar_SetValue("allow_download", f.curvalue);
  else if (f === s_allow_download_maps_box) Cvar_SetValue("allow_download_maps", f.curvalue);
  else if (f === s_allow_download_models_box) Cvar_SetValue("allow_download_models", f.curvalue);
  else if (f === s_allow_download_players_box) Cvar_SetValue("allow_download_players", f.curvalue);
  else if (f === s_allow_download_sounds_box) Cvar_SetValue("allow_download_sounds", f.curvalue);
}

function DownloadOptions_MenuInit(): void {
  const yes_no_names = ["no", "yes"];
  let y = 0;

  s_downloadoptions_menu.x = viddef.width * 0.5;
  s_downloadoptions_menu.nitems = 0;

  s_download_title.generic.type = MTYPE_SEPARATOR;
  s_download_title.generic.name = "Download Options";
  s_download_title.generic.x = 48;
  s_download_title.generic.y = y;

  s_allow_download_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_download_box.generic.x = 0;
  s_allow_download_box.generic.y = (y += 20);
  s_allow_download_box.generic.name = "allow downloading";
  s_allow_download_box.generic.callback = DownloadCallback;
  s_allow_download_box.itemnames = yes_no_names;
  s_allow_download_box.curvalue = Cvar_VariableValue("allow_download") !== 0 ? 1 : 0;

  s_allow_download_maps_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_download_maps_box.generic.x = 0;
  s_allow_download_maps_box.generic.y = (y += 20);
  s_allow_download_maps_box.generic.name = "maps";
  s_allow_download_maps_box.generic.callback = DownloadCallback;
  s_allow_download_maps_box.itemnames = yes_no_names;
  s_allow_download_maps_box.curvalue = Cvar_VariableValue("allow_download_maps") !== 0 ? 1 : 0;

  s_allow_download_players_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_download_players_box.generic.x = 0;
  s_allow_download_players_box.generic.y = (y += 10);
  s_allow_download_players_box.generic.name = "player models/skins";
  s_allow_download_players_box.generic.callback = DownloadCallback;
  s_allow_download_players_box.itemnames = yes_no_names;
  s_allow_download_players_box.curvalue = Cvar_VariableValue("allow_download_players") !== 0 ? 1 : 0;

  s_allow_download_models_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_download_models_box.generic.x = 0;
  s_allow_download_models_box.generic.y = (y += 10);
  s_allow_download_models_box.generic.name = "models";
  s_allow_download_models_box.generic.callback = DownloadCallback;
  s_allow_download_models_box.itemnames = yes_no_names;
  s_allow_download_models_box.curvalue = Cvar_VariableValue("allow_download_models") !== 0 ? 1 : 0;

  s_allow_download_sounds_box.generic.type = MTYPE_SPINCONTROL;
  s_allow_download_sounds_box.generic.x = 0;
  s_allow_download_sounds_box.generic.y = (y += 10);
  s_allow_download_sounds_box.generic.name = "sounds";
  s_allow_download_sounds_box.generic.callback = DownloadCallback;
  s_allow_download_sounds_box.itemnames = yes_no_names;
  s_allow_download_sounds_box.curvalue = Cvar_VariableValue("allow_download_sounds") !== 0 ? 1 : 0;

  Menu_AddItem(s_downloadoptions_menu, s_download_title);
  Menu_AddItem(s_downloadoptions_menu, s_allow_download_box);
  Menu_AddItem(s_downloadoptions_menu, s_allow_download_maps_box);
  Menu_AddItem(s_downloadoptions_menu, s_allow_download_players_box);
  Menu_AddItem(s_downloadoptions_menu, s_allow_download_models_box);
  Menu_AddItem(s_downloadoptions_menu, s_allow_download_sounds_box);

  Menu_Center(s_downloadoptions_menu);

  // skip over title
  if (s_downloadoptions_menu.cursor === 0) s_downloadoptions_menu.cursor = 1;
}

function DownloadOptions_MenuDraw(): void {
  Menu_Draw(s_downloadoptions_menu);
}

function DownloadOptions_MenuKey(key: number): string | null {
  return Default_MenuKey(s_downloadoptions_menu, key);
}

function M_Menu_DownloadOptions_f(): void {
  DownloadOptions_MenuInit();
  M_PushMenu(DownloadOptions_MenuDraw, DownloadOptions_MenuKey);
}

/*
=============================================================================
ADDRESS BOOK MENU
=============================================================================
*/
const NUM_ADDRESSBOOK_ENTRIES = 9;

const s_addressbook_menu = new MenuframeworkS();
const s_addressbook_fields: MenufieldS[] = Array.from({ length: NUM_ADDRESSBOOK_ENTRIES }, () => new MenufieldS());

function AddressBook_MenuInit(): void {
  s_addressbook_menu.x = viddef.width / 2 - 142;
  s_addressbook_menu.y = viddef.height / 2 - 58;
  s_addressbook_menu.nitems = 0;

  for (let i = 0; i < NUM_ADDRESSBOOK_ENTRIES; i++) {
    const field = s_addressbook_fields[i];
    if (!field) continue;

    const adr = Cvar_Get(`adr${i}`, "", CVAR_ARCHIVE);

    field.generic.type = MTYPE_FIELD;
    field.generic.name = null;
    field.generic.callback = null;
    field.generic.x = 0;
    field.generic.y = i * 18;
    field.generic.localdata[0] = i;
    field.cursor = 0;
    field.length = 60;
    field.visible_length = 30;

    field.buffer = adr ? adr.string : "";

    Menu_AddItem(s_addressbook_menu, field);
  }
}

function AddressBook_MenuKey(key: number): string | null {
  if (key === K_ESCAPE) {
    for (let index = 0; index < NUM_ADDRESSBOOK_ENTRIES; index++) {
      Cvar_Set(`adr${index}`, s_addressbook_fields[index]?.buffer ?? "");
    }
  }
  return Default_MenuKey(s_addressbook_menu, key);
}

function AddressBook_MenuDraw(): void {
  M_Banner("m_banner_addressbook");
  Menu_Draw(s_addressbook_menu);
}

function M_Menu_AddressBook_f(): void {
  AddressBook_MenuInit();
  M_PushMenu(AddressBook_MenuDraw, AddressBook_MenuKey);
}

/*
=============================================================================
PLAYER CONFIG MENU
=============================================================================
*/
const s_player_config_menu = new MenuframeworkS();
const s_player_name_field = new MenufieldS();
const s_player_model_box = new MenulistS();
const s_player_skin_box = new MenulistS();
const s_player_handedness_box = new MenulistS();
const s_player_rate_box = new MenulistS();
const s_player_skin_title = new MenuseparatorS();
const s_player_model_title = new MenuseparatorS();
const s_player_hand_title = new MenuseparatorS();
const s_player_rate_title = new MenuseparatorS();
const s_player_download_action = new MenuactionS();

const MAX_DISPLAYNAME = 16;

interface PlayermodelinfoS {
  nskins: number;
  skindisplaynames: string[];
  displayname: string;
  directory: string;
}

let s_pmi: PlayermodelinfoS[] = [];
let s_numplayermodels = 0;

const rate_tbl = fixedLength("rate_tbl", 5, [2500, 3200, 5000, 10000, 25000]);
const rate_names = fixedLength("rate_names", 6, [
  "28.8 Modem",
  "33.6 Modem",
  "Single ISDN",
  "Dual ISDN/Cable",
  "T1/LAN",
  "User defined",
]);

function DownloadOptionsFunc(): void {
  M_Menu_DownloadOptions_f();
}

function HandednessCallback(): void {
  Cvar_SetValue("hand", s_player_handedness_box.curvalue);
}

function RateCallback(): void {
  if (s_player_rate_box.curvalue !== rate_tbl.length) {
    Cvar_SetValue("rate", rate_tbl[s_player_rate_box.curvalue] ?? 0);
  }
}

function ModelCallback(): void {
  s_player_skin_box.itemnames = s_pmi[s_player_model_box.curvalue]?.skindisplaynames ?? [];
  s_player_skin_box.curvalue = 0;
}

// PlayerConfig_ScanDirectories: see file header for the deviation this
// takes from Sys_FindFirst/SFF_SUBDIR-filtered FS_ListFiles, neither of
// which this port's files.ts exposes.
function PlayerConfig_ScanDirectories(): boolean {
  s_pmi = [];

  let dirnames: string[] | null = null;
  let path: string | null = null;
  do {
    path = FS_NextPath(path);
    dirnames = FS_ListFiles(`${path}/players/*`);
  } while (!dirnames && path);

  if (!dirnames) return false;

  for (const dirpath of dirnames) {
    if (!FS_LoadFile(`${dirpath}/tris.md2`)) continue;

    const pcxnames = FS_ListFiles(`${dirpath}/*.pcx`);
    if (!pcxnames) continue;

    const skinnames: string[] = [];
    for (const pcx of pcxnames) {
      if (pcx.endsWith("_i.pcx")) continue;

      const dot = pcx.lastIndexOf(".");
      const iconPath = (dot === -1 ? pcx : pcx.slice(0, dot)) + "_i.pcx";
      if (!pcxnames.includes(iconPath)) continue;

      const slash = pcx.lastIndexOf("/");
      const base = slash === -1 ? pcx : pcx.slice(slash + 1);
      const baseDot = base.lastIndexOf(".");
      skinnames.push(baseDot === -1 ? base : base.slice(0, baseDot));
    }

    if (skinnames.length === 0) continue;

    const slash = dirpath.lastIndexOf("/");
    const dirBase = slash === -1 ? dirpath : dirpath.slice(slash + 1);

    s_pmi.push({
      nskins: skinnames.length,
      skindisplaynames: skinnames,
      displayname: dirBase.slice(0, MAX_DISPLAYNAME - 1),
      directory: dirBase,
    });
  }

  s_numplayermodels = s_pmi.length;
  return s_numplayermodels > 0;
}

function pmiCompare(a: PlayermodelinfoS, b: PlayermodelinfoS): number {
  // sort by male, female, then alphabetical
  if (a.directory === "male") return -1;
  if (b.directory === "male") return 1;
  if (a.directory === "female") return -1;
  if (b.directory === "female") return 1;
  return a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0;
}

function PlayerConfig_MenuInit(): boolean {
  const handedness = ["right", "left", "center"];

  const hand = Cvar_Get("hand", "0", CVAR_USERINFO | CVAR_ARCHIVE);
  const nameCvar = Cvar_Get("name", "unnamed", CVAR_USERINFO | CVAR_ARCHIVE);
  const skinCvar = Cvar_Get("skin", "male/grunt", CVAR_USERINFO | CVAR_ARCHIVE);

  if (!PlayerConfig_ScanDirectories()) return false;
  if (s_numplayermodels === 0) return false;

  if (hand && (hand.value < 0 || hand.value > 2)) Cvar_SetValue("hand", 0);

  let currentdirectory = "male";
  let currentskin = "grunt";
  const skinStr = skinCvar ? skinCvar.string : "";
  const slashFwd = skinStr.indexOf("/");
  const slashBack = skinStr.indexOf("\\");
  const slash = slashFwd !== -1 ? slashFwd : slashBack;
  if (slash !== -1) {
    currentdirectory = skinStr.slice(0, slash);
    currentskin = skinStr.slice(slash + 1);
  }

  s_pmi.sort(pmiCompare);

  let currentdirectoryindex = 0;
  let currentskinindex = 0;
  const s_pmnames: string[] = [];

  for (let i = 0; i < s_numplayermodels; i++) {
    const pmi = s_pmi[i];
    if (!pmi) continue;
    s_pmnames.push(pmi.displayname);

    if (Q_stricmp(pmi.directory, currentdirectory) === 0) {
      currentdirectoryindex = i;

      for (let j = 0; j < pmi.nskins; j++) {
        if (Q_stricmp(pmi.skindisplaynames[j] ?? "", currentskin) === 0) {
          currentskinindex = j;
          break;
        }
      }
    }
  }

  s_player_config_menu.x = viddef.width / 2 - 95;
  s_player_config_menu.y = viddef.height / 2 - 97;
  s_player_config_menu.nitems = 0;

  s_player_name_field.generic.type = MTYPE_FIELD;
  s_player_name_field.generic.name = "name";
  s_player_name_field.generic.callback = null;
  s_player_name_field.generic.x = 0;
  s_player_name_field.generic.y = 0;
  s_player_name_field.length = 20;
  s_player_name_field.visible_length = 20;
  s_player_name_field.buffer = nameCvar ? nameCvar.string : "";
  s_player_name_field.cursor = s_player_name_field.buffer.length;

  s_player_model_title.generic.type = MTYPE_SEPARATOR;
  s_player_model_title.generic.name = "model";
  s_player_model_title.generic.x = -8;
  s_player_model_title.generic.y = 60;

  s_player_model_box.generic.type = MTYPE_SPINCONTROL;
  s_player_model_box.generic.x = -56;
  s_player_model_box.generic.y = 70;
  s_player_model_box.generic.callback = ModelCallback;
  s_player_model_box.generic.cursor_offset = -48;
  s_player_model_box.curvalue = currentdirectoryindex;
  s_player_model_box.itemnames = s_pmnames;

  s_player_skin_title.generic.type = MTYPE_SEPARATOR;
  s_player_skin_title.generic.name = "skin";
  s_player_skin_title.generic.x = -16;
  s_player_skin_title.generic.y = 84;

  s_player_skin_box.generic.type = MTYPE_SPINCONTROL;
  s_player_skin_box.generic.x = -56;
  s_player_skin_box.generic.y = 94;
  s_player_skin_box.generic.name = null;
  s_player_skin_box.generic.callback = null;
  s_player_skin_box.generic.cursor_offset = -48;
  s_player_skin_box.curvalue = currentskinindex;
  s_player_skin_box.itemnames = s_pmi[currentdirectoryindex]?.skindisplaynames ?? [];

  s_player_hand_title.generic.type = MTYPE_SEPARATOR;
  s_player_hand_title.generic.name = "handedness";
  s_player_hand_title.generic.x = 32;
  s_player_hand_title.generic.y = 108;

  s_player_handedness_box.generic.type = MTYPE_SPINCONTROL;
  s_player_handedness_box.generic.x = -56;
  s_player_handedness_box.generic.y = 118;
  s_player_handedness_box.generic.name = null;
  s_player_handedness_box.generic.cursor_offset = -48;
  s_player_handedness_box.generic.callback = HandednessCallback;
  s_player_handedness_box.curvalue = Cvar_VariableValue("hand");
  s_player_handedness_box.itemnames = handedness;

  let rateIndex = rate_tbl.length;
  for (let i = 0; i < rate_tbl.length; i++) {
    if (Cvar_VariableValue("rate") === rate_tbl[i]) {
      rateIndex = i;
      break;
    }
  }

  s_player_rate_title.generic.type = MTYPE_SEPARATOR;
  s_player_rate_title.generic.name = "connect speed";
  s_player_rate_title.generic.x = 56;
  s_player_rate_title.generic.y = 156;

  s_player_rate_box.generic.type = MTYPE_SPINCONTROL;
  s_player_rate_box.generic.x = -56;
  s_player_rate_box.generic.y = 166;
  s_player_rate_box.generic.name = null;
  s_player_rate_box.generic.cursor_offset = -48;
  s_player_rate_box.generic.callback = RateCallback;
  s_player_rate_box.curvalue = rateIndex;
  s_player_rate_box.itemnames = rate_names;

  s_player_download_action.generic.type = MTYPE_ACTION;
  s_player_download_action.generic.name = "download options";
  s_player_download_action.generic.flags = QMF_LEFT_JUSTIFY;
  s_player_download_action.generic.x = -24;
  s_player_download_action.generic.y = 186;
  s_player_download_action.generic.statusbar = null;
  s_player_download_action.generic.callback = DownloadOptionsFunc;

  Menu_AddItem(s_player_config_menu, s_player_name_field);
  Menu_AddItem(s_player_config_menu, s_player_model_title);
  Menu_AddItem(s_player_config_menu, s_player_model_box);
  if (s_player_skin_box.itemnames.length > 0) {
    Menu_AddItem(s_player_config_menu, s_player_skin_title);
    Menu_AddItem(s_player_config_menu, s_player_skin_box);
  }
  Menu_AddItem(s_player_config_menu, s_player_hand_title);
  Menu_AddItem(s_player_config_menu, s_player_handedness_box);
  Menu_AddItem(s_player_config_menu, s_player_rate_title);
  Menu_AddItem(s_player_config_menu, s_player_rate_box);
  Menu_AddItem(s_player_config_menu, s_player_download_action);

  return true;
}

function PlayerConfig_MenuDraw(): void {
  // The 3D player preview (CalcFov/re.RegisterModel/re.RenderFrame) is
  // entirely behind the re-null guard, like every other drawing entry point
  // here -- so cl_view.ts's not-yet-ported CalcFov is never actually needed
  // headless.
  if (!re) return;

  const pmi = s_pmi[s_player_model_box.curvalue];
  if (!pmi || pmi.skindisplaynames.length === 0) {
    Menu_Draw(s_player_config_menu);
    return;
  }

  const skin = pmi.skindisplaynames[s_player_skin_box.curvalue] ?? "";
  re.RegisterModel(`players/${pmi.directory}/tris.md2`);
  re.RegisterSkin(`players/${pmi.directory}/${skin}.pcx`);

  Menu_Draw(s_player_config_menu);

  const width = 144;
  const height = 168;
  M_DrawTextBox((viddef.width / 2) * (320.0 / viddef.width) - 8, (viddef.height / 2) * (240.0 / viddef.height) - 77, width / 8, height / 8);

  re.DrawPic(s_player_config_menu.x - 40, viddef.height / 2 - 72, `/players/${pmi.directory}/${skin}_i.pcx`);
}

function PlayerConfig_MenuKey(key: number): string | null {
  if (key === K_ESCAPE) {
    Cvar_Set("name", s_player_name_field.buffer);

    const pmi = s_pmi[s_player_model_box.curvalue];
    if (pmi) {
      const skin = pmi.skindisplaynames[s_player_skin_box.curvalue] ?? "";
      Cvar_Set("skin", `${pmi.directory}/${skin}`);
    }

    for (const m of s_pmi) m.skindisplaynames = [];
  }
  return Default_MenuKey(s_player_config_menu, key);
}

function M_Menu_PlayerConfig_f(): void {
  if (!PlayerConfig_MenuInit()) {
    Menu_SetStatusBar(s_multiplayer_menu, "No valid player models found");
    return;
  }
  Menu_SetStatusBar(s_multiplayer_menu, null);
  M_PushMenu(PlayerConfig_MenuDraw, PlayerConfig_MenuKey);
}

// #if 0'd out in the C original (M_Menu_Gallery_f) -- dropped silently per
// PORTING.md's dead-code rule.

/*
=======================================================================
QUIT MENU
=======================================================================
*/
function M_Quit_Key(key: number): string | null {
  switch (key) {
    case K_ESCAPE:
    case "n".charCodeAt(0):
    case "N".charCodeAt(0):
      M_PopMenu();
      break;

    case "Y".charCodeAt(0):
    case "y".charCodeAt(0):
      cls.key_dest = KeydestT.key_console;
      CL_Quit_f();
      break;
  }

  return null;
}

function M_Quit_Draw(): void {
  if (!re) return;
  const { w, h } = re.DrawGetPicSize("quit");
  re.DrawPic((viddef.width - w) / 2, (viddef.height - h) / 2, "quit");
}

function M_Menu_Quit_f(): void {
  M_PushMenu(M_Quit_Draw, M_Quit_Key);
}

//=============================================================================
/* Menu Subsystem */

export function M_Init(): void {
  Cmd_AddCommand("menu_main", M_Menu_Main_f);
  Cmd_AddCommand("menu_game", M_Menu_Game_f);
  Cmd_AddCommand("menu_loadgame", M_Menu_LoadGame_f);
  Cmd_AddCommand("menu_savegame", M_Menu_SaveGame_f);
  Cmd_AddCommand("menu_joinserver", M_Menu_JoinServer_f);
  Cmd_AddCommand("menu_addressbook", M_Menu_AddressBook_f);
  Cmd_AddCommand("menu_startserver", M_Menu_StartServer_f);
  Cmd_AddCommand("menu_dmoptions", M_Menu_DMOptions_f);
  Cmd_AddCommand("menu_playerconfig", M_Menu_PlayerConfig_f);
  Cmd_AddCommand("menu_downloadoptions", M_Menu_DownloadOptions_f);
  Cmd_AddCommand("menu_credits", M_Menu_Credits_f);
  Cmd_AddCommand("menu_multiplayer", M_Menu_Multiplayer_f);
  Cmd_AddCommand("menu_video", M_Menu_Video_f);
  Cmd_AddCommand("menu_options", M_Menu_Options_f);
  Cmd_AddCommand("menu_keys", M_Menu_Keys_f);
  Cmd_AddCommand("menu_quit", M_Menu_Quit_f);
}

export function M_Draw(): void {
  if (cls.key_dest !== KeydestT.key_menu) return;

  // repaint everything next frame
  SCR_DirtyScreen();

  // dim everything behind it down
  if (re) {
    if (cl.cinematictime > 0) re.DrawFill(0, 0, viddef.width, viddef.height, 0);
    else re.DrawFadeScreen();
  }

  if (m_drawfunc) m_drawfunc();

  // delay playing the enter sound until after the menu has been drawn, to
  // avoid delay while caching images
  if (m_entersound) {
    S_StartLocalSound(menu_in_sound);
    m_entersound = false;
  }
}

export function M_Keydown(key: number): void {
  if (m_keyfunc) {
    const s = m_keyfunc(key);
    if (s !== null) S_StartLocalSound(s);
  }
}
