// keys.c -- key event dispatch, bindings, and line editing. Named
// keys_impl.ts, not keys.ts, because keys.h's constant/global surface
// already owns that basename (K_*/keybindings/etc. in keys.ts) -- a
// deliberate exception to PORTING.md's "same basename" rule, reported per
// this unit's brief.
//
// key_lines/edit_line/key_linepos are `extern`'d into console.c (it edits
// the current input line for Con_DrawInput and Key_ClearTyping) even though
// they're defined here -- exported for console_impl.ts's use, matching the
// C extern declaration there. This closes a two-way module cycle with
// console_impl.ts (Con_ToggleConsole_f is called from here); both sides only
// touch each other's exports from inside function bodies, never at module
// top level, so the live-binding cycle initializes safely without needing
// the lazy-require workaround in PORTING.md's import-cycle rule.
//
// Key_KeynumToString is declared in client.h under its "cl_input" section,
// but is actually defined in keys.c (confirmed by grep) -- ported here
// instead of in cl_input.ts.
//
// CompleteCommand/Key_Console/Key_Message are internal to keys.c (no
// external caller in the ported tree) and stay module-private. Key_Bind_f/
// Key_Unbind_f/Key_Unbindall_f/Key_Bindlist_f/Key_StringToKeynum are not
// `static` in the C and are exported here (deviation from the earlier
// pending-stub's "internal, not stubbed" note, which only scoped the throw
// stubs) so this unit's test brief can round-trip `bind` through
// Cmd_TokenizeString + Key_Bind_f the same way the real console does.
//
// Sys_GetClipboardData lives in platform/sys.ts (linux semantics: returns
// null); Key_Console's ctrl-V/shift-insert paste branch is ported in full.

import { Sys_GetClipboardData } from "../platform/sys";
import {
  K_TAB,
  K_ENTER,
  K_ESCAPE,
  K_BACKSPACE,
  K_UPARROW,
  K_DOWNARROW,
  K_LEFTARROW,
  K_RIGHTARROW,
  K_CTRL,
  K_SHIFT,
  K_F1,
  K_F12,
  K_INS,
  K_DEL,
  K_PGDN,
  K_PGUP,
  K_HOME,
  K_END,
  K_KP_HOME,
  K_KP_UPARROW,
  K_KP_PGUP,
  K_KP_LEFTARROW,
  K_KP_5,
  K_KP_RIGHTARROW,
  K_KP_END,
  K_KP_DOWNARROW,
  K_KP_PGDN,
  K_KP_ENTER,
  K_KP_INS,
  K_KP_DEL,
  K_KP_SLASH,
  K_KP_MINUS,
  K_KP_PLUS,
  K_PAUSE,
  K_GAMEPAD_LEFT_TRIGGER,
  K_GAMEPAD_RIGHT_TRIGGER,
  K_GAMEPAD_X_BUTTON,
  K_GAMEPAD_A_BUTTON,
  K_GAMEPAD_B_BUTTON,
  K_GAMEPAD_LEFT_STICK,
  K_GAMEPAD_RIGHT_STICK,
  K_GAMEPAD_LEFT_SHOULDER,
  K_GAMEPAD_RIGHT_SHOULDER,
  K_GAMEPAD_DPAD_LEFT,
  K_GAMEPAD_DPAD_RIGHT,
  K_GAMEPAD_DPAD_UP,
  keybindings,
  key_repeats,
  anykeydown,
  setAnykeydown,
  chat_buffer,
  chat_bufferlen,
  chat_team,
  setChatBuffer,
} from "./keys";
import { cl, cls, ConnstateT, KeydestT } from "./client";
import { con } from "./console";
import { Cbuf_AddText, Cmd_Argc, Cmd_Argv, Cmd_AddCommand, Cmd_CompleteCommand } from "../qcommon/cmd";
import { Cvar_CompleteVariable, Cvar_Get } from "../qcommon/cvar";
import { Com_Printf, Com_Error } from "../qcommon/common";
import { Com_sprintf, Q_stricmp, STAT_LAYOUTS } from "../shared/q_shared";
import { ERR_FATAL } from "../qcommon/qcommon";
import { FS_Write } from "../qcommon/files";
import { M_Keydown, M_Menu_Main_f } from "./menu";
import { SCR_UpdateScreen } from "./cl_scrn";
import { Con_ToggleConsole_f } from "./console_impl";
import { Sys_SendKeyEvents } from "./cl_input";

const MAXCMDLINE = 256;

export const key_lines: string[] = new Array(32).fill("]");
export let key_linepos = 1;
export function setKeyLinepos(v: number): void {
  key_linepos = v;
}
export let edit_line = 0;
export function setEditLine(v: number): void {
  edit_line = v;
}
let history_line = 0;

let key_waiting = 0;
let shift_down = false;

const keydown: boolean[] = new Array(256).fill(false);
const consolekeys: boolean[] = new Array(256).fill(false); // if true, can't be rebound while in console
const menubound: boolean[] = new Array(256).fill(false); // if true, can't be rebound while in menu
const keyshift: number[] = new Array(256).fill(0); // key to map to if shift held down in console

interface KeynameT {
  name: string;
  keynum: number;
}

const keynames: KeynameT[] = [
  { name: "TAB", keynum: K_TAB },
  { name: "ENTER", keynum: K_ENTER },
  { name: "ESCAPE", keynum: K_ESCAPE },
  { name: "SPACE", keynum: 32 },
  { name: "BACKSPACE", keynum: K_BACKSPACE },
  { name: "UPARROW", keynum: K_UPARROW },
  { name: "DOWNARROW", keynum: K_DOWNARROW },
  { name: "LEFTARROW", keynum: K_LEFTARROW },
  { name: "RIGHTARROW", keynum: K_RIGHTARROW },

  { name: "ALT", keynum: 132 },
  { name: "CTRL", keynum: K_CTRL },
  { name: "SHIFT", keynum: K_SHIFT },

  { name: "F1", keynum: K_F1 },
  { name: "F2", keynum: K_F1 + 1 },
  { name: "F3", keynum: K_F1 + 2 },
  { name: "F4", keynum: K_F1 + 3 },
  { name: "F5", keynum: K_F1 + 4 },
  { name: "F6", keynum: K_F1 + 5 },
  { name: "F7", keynum: K_F1 + 6 },
  { name: "F8", keynum: K_F1 + 7 },
  { name: "F9", keynum: K_F1 + 8 },
  { name: "F10", keynum: K_F1 + 9 },
  { name: "F11", keynum: K_F1 + 10 },
  { name: "F12", keynum: K_F1 + 11 },

  { name: "INS", keynum: K_INS },
  { name: "DEL", keynum: K_DEL },
  { name: "PGDN", keynum: K_PGDN },
  { name: "PGUP", keynum: K_PGUP },
  { name: "HOME", keynum: K_HOME },
  { name: "END", keynum: K_END },

  { name: "MOUSE1", keynum: 200 },
  { name: "MOUSE2", keynum: 201 },
  { name: "MOUSE3", keynum: 202 },

  { name: "JOY1", keynum: 203 },
  { name: "JOY2", keynum: 204 },
  { name: "JOY3", keynum: 205 },
  { name: "JOY4", keynum: 206 },

  { name: "AUX1", keynum: 207 },
  { name: "AUX2", keynum: 208 },
  { name: "AUX3", keynum: 209 },
  { name: "AUX4", keynum: 210 },
  { name: "AUX5", keynum: 211 },
  { name: "AUX6", keynum: 212 },
  { name: "AUX7", keynum: 213 },
  { name: "AUX8", keynum: 214 },
  { name: "AUX9", keynum: 215 },
  { name: "AUX10", keynum: 216 },
  { name: "AUX11", keynum: 217 },
  { name: "AUX12", keynum: 218 },
  { name: "AUX13", keynum: 219 },
  { name: "AUX14", keynum: 220 },
  { name: "AUX15", keynum: 221 },
  { name: "AUX16", keynum: 222 },
  { name: "AUX17", keynum: 223 },
  { name: "AUX18", keynum: 224 },
  { name: "AUX19", keynum: 225 },
  { name: "AUX20", keynum: 226 },
  { name: "AUX21", keynum: 227 },
  { name: "AUX22", keynum: 228 },
  { name: "AUX23", keynum: 229 },
  { name: "AUX24", keynum: 230 },
  { name: "AUX25", keynum: 231 },
  { name: "AUX26", keynum: 232 },
  { name: "AUX27", keynum: 233 },
  { name: "AUX28", keynum: 234 },
  { name: "AUX29", keynum: 235 },
  { name: "AUX30", keynum: 236 },
  { name: "AUX31", keynum: 237 },
  { name: "AUX32", keynum: 238 },

  { name: "KP_HOME", keynum: K_KP_HOME },
  { name: "KP_UPARROW", keynum: K_KP_UPARROW },
  { name: "KP_PGUP", keynum: K_KP_PGUP },
  { name: "KP_LEFTARROW", keynum: K_KP_LEFTARROW },
  { name: "KP_5", keynum: K_KP_5 },
  { name: "KP_RIGHTARROW", keynum: K_KP_RIGHTARROW },
  { name: "KP_END", keynum: K_KP_END },
  { name: "KP_DOWNARROW", keynum: K_KP_DOWNARROW },
  { name: "KP_PGDN", keynum: K_KP_PGDN },
  { name: "KP_ENTER", keynum: K_KP_ENTER },
  { name: "KP_INS", keynum: K_KP_INS },
  { name: "KP_DEL", keynum: K_KP_DEL },
  { name: "KP_SLASH", keynum: K_KP_SLASH },
  { name: "KP_MINUS", keynum: K_KP_MINUS },
  { name: "KP_PLUS", keynum: K_KP_PLUS },

  { name: "MWHEELUP", keynum: 240 },
  { name: "MWHEELDOWN", keynum: 239 },

  { name: "PAUSE", keynum: K_PAUSE },

  { name: "SEMICOLON", keynum: 59 }, // because a raw semicolon seperates commands

  // KEX rerelease gamepad button names -- retail default.cfg's "GAMEPAD"
  // section binds these by name (see keys.ts's K_GAMEPAD_* citation for the
  // exact bind lines and source pak). Case kept exactly as default.cfg
  // spells each one (lowercase snake_case for the buttons/sticks/shoulders,
  // upper snake_case for the DPAD_* names) since that's the string the real
  // KEX engine would echo back through its own bindlist/config write --
  // Key_StringToKeynum's Q_stricmp lookup is already case-insensitive on
  // parse either way (matches the vanilla C's Key_StringToKeynum).
  { name: "left_trigger", keynum: K_GAMEPAD_LEFT_TRIGGER },
  { name: "right_trigger", keynum: K_GAMEPAD_RIGHT_TRIGGER },
  { name: "x_button", keynum: K_GAMEPAD_X_BUTTON },
  { name: "a_button", keynum: K_GAMEPAD_A_BUTTON },
  { name: "b_button", keynum: K_GAMEPAD_B_BUTTON },
  { name: "left_stick", keynum: K_GAMEPAD_LEFT_STICK },
  { name: "right_stick", keynum: K_GAMEPAD_RIGHT_STICK },
  { name: "left_shoulder", keynum: K_GAMEPAD_LEFT_SHOULDER },
  { name: "right_shoulder", keynum: K_GAMEPAD_RIGHT_SHOULDER },
  { name: "DPAD_LEFT", keynum: K_GAMEPAD_DPAD_LEFT },
  { name: "DPAD_RIGHT", keynum: K_GAMEPAD_DPAD_RIGHT },
  { name: "DPAD_UP", keynum: K_GAMEPAD_DPAD_UP },
];

/*
==============================================================================

			LINE TYPING INTO THE CONSOLE

==============================================================================
*/

function CompleteCommand(): void {
  let s = key_lines[edit_line].slice(1);
  if (s[0] === "\\" || s[0] === "/") s = s.slice(1);

  let cmd = Cmd_CompleteCommand(s);
  if (!cmd) cmd = Cvar_CompleteVariable(s);
  if (cmd) {
    const line = key_lines[edit_line].slice(0, 1) + "/" + cmd + " ";
    key_linepos = line.length;
    key_lines[edit_line] = line;
  }
}

/*
====================
Key_Console

Interactive line editing and console scrollback
====================
*/
function Key_Console(keyIn: number): void {
  let key = keyIn;

  switch (key) {
    case K_KP_SLASH:
      key = "/".charCodeAt(0);
      break;
    case K_KP_MINUS:
      key = "-".charCodeAt(0);
      break;
    case K_KP_PLUS:
      key = "+".charCodeAt(0);
      break;
    case K_KP_HOME:
      key = "7".charCodeAt(0);
      break;
    case K_KP_UPARROW:
      key = "8".charCodeAt(0);
      break;
    case K_KP_PGUP:
      key = "9".charCodeAt(0);
      break;
    case K_KP_LEFTARROW:
      key = "4".charCodeAt(0);
      break;
    case K_KP_5:
      key = "5".charCodeAt(0);
      break;
    case K_KP_RIGHTARROW:
      key = "6".charCodeAt(0);
      break;
    case K_KP_END:
      key = "1".charCodeAt(0);
      break;
    case K_KP_DOWNARROW:
      key = "2".charCodeAt(0);
      break;
    case K_KP_PGDN:
      key = "3".charCodeAt(0);
      break;
    case K_KP_INS:
      key = "0".charCodeAt(0);
      break;
    case K_KP_DEL:
      key = ".".charCodeAt(0);
      break;
    default:
      break;
  }

  if ((String.fromCharCode(key).toUpperCase() === "V" && keydown[K_CTRL]) || ((key === K_INS || key === K_KP_INS) && keydown[K_SHIFT]) ) {
    const cbd = Sys_GetClipboardData();
    if (cbd !== null) {
      // strtok(cbd, "\n\r\b") -- keep only the first line
      let text = cbd.split(/[\n\r\b]/)[0] ?? "";
      let i = text.length;
      if (i + key_linepos >= MAXCMDLINE) i = MAXCMDLINE - key_linepos;
      if (i > 0) {
        text = text.slice(0, i);
        key_lines[edit_line] += text;
        key_linepos += i;
      }
    }
    return;
  }

  if (key === "l".charCodeAt(0) && keydown[K_CTRL]) {
    Cbuf_AddText("clear\n");
    return;
  }

  if (key === K_ENTER || key === K_KP_ENTER) {
    // backslash text are commands, else chat
    const line = key_lines[edit_line];
    if (line[1] === "\\" || line[1] === "/") Cbuf_AddText(line.slice(2));
    else Cbuf_AddText(line.slice(1));

    Cbuf_AddText("\n");
    Com_Printf("%s\n", line);
    edit_line = (edit_line + 1) & 31;
    history_line = edit_line;
    key_lines[edit_line] = "]";
    key_linepos = 1;
    if (cls.state === ConnstateT.ca_disconnected)
      SCR_UpdateScreen(); // force an update, because the command may take some time
    return;
  }

  if (key === K_TAB) {
    CompleteCommand();
    return;
  }

  if (key === K_BACKSPACE || key === K_LEFTARROW || key === K_KP_LEFTARROW || (key === "h".charCodeAt(0) && keydown[K_CTRL])) {
    if (key_linepos > 1) key_linepos--;
    return;
  }

  if (key === K_UPARROW || key === K_KP_UPARROW || (key === "p".charCodeAt(0) && keydown[K_CTRL])) {
    do {
      history_line = (history_line - 1) & 31;
    } while (history_line !== edit_line && key_lines[history_line].length <= 1);
    if (history_line === edit_line) history_line = (edit_line + 1) & 31;
    key_lines[edit_line] = key_lines[history_line];
    key_linepos = key_lines[edit_line].length;
    return;
  }

  if (key === K_DOWNARROW || key === K_KP_DOWNARROW || (key === "n".charCodeAt(0) && keydown[K_CTRL])) {
    if (history_line === edit_line) return;
    do {
      history_line = (history_line + 1) & 31;
    } while (history_line !== edit_line && key_lines[history_line].length <= 1);
    if (history_line === edit_line) {
      key_lines[edit_line] = "]";
      key_linepos = 1;
    } else {
      key_lines[edit_line] = key_lines[history_line];
      key_linepos = key_lines[edit_line].length;
    }
    return;
  }

  if (key === K_PGUP || key === K_KP_PGUP) {
    con.display -= 2;
    return;
  }

  if (key === K_PGDN || key === K_KP_PGDN) {
    con.display += 2;
    if (con.display > con.current) con.display = con.current;
    return;
  }

  if (key === K_HOME || key === K_KP_HOME) {
    con.display = con.current - con.totallines + 10;
    return;
  }

  if (key === K_END || key === K_KP_END) {
    con.display = con.current;
    return;
  }

  if (key < 32 || key > 127) return; // non printable

  if (key_linepos < MAXCMDLINE - 1) {
    key_lines[edit_line] = key_lines[edit_line].slice(0, key_linepos) + String.fromCharCode(key);
    key_linepos++;
  }
}

/*
============================================================================
*/

function Key_Message(key: number): void {
  if (key === K_ENTER || key === K_KP_ENTER) {
    if (chat_team) Cbuf_AddText('say_team "');
    else Cbuf_AddText('say "');
    Cbuf_AddText(chat_buffer);
    Cbuf_AddText('"\n');

    cls.key_dest = KeydestT.key_game;
    setChatBuffer("");
    return;
  }

  if (key === K_ESCAPE) {
    cls.key_dest = KeydestT.key_game;
    setChatBuffer("");
    return;
  }

  if (key < 32 || key > 127) return; // non printable

  if (key === K_BACKSPACE) {
    if (chat_bufferlen) setChatBuffer(chat_buffer.slice(0, -1));
    return;
  }

  if (chat_bufferlen === MAXCMDLINE - 1) return; // all full

  setChatBuffer(chat_buffer + String.fromCharCode(key));
}

/*
============================================================================
*/

/*
===================
Key_StringToKeynum

Returns a key number to be used to index keybindings[] by looking at
the given string.  Single ascii characters return themselves, while
the K_* names are matched up.
===================
*/
export function Key_StringToKeynum(str: string): number {
  if (!str || str.length === 0) return -1;
  if (str.length === 1) return str.charCodeAt(0);

  for (const kn of keynames) {
    if (Q_stricmp(str, kn.name) === 0) return kn.keynum;
  }
  return -1;
}

/*
===================
Key_KeynumToString

Returns a string (either a single ascii char, or a K_* name) for the
given keynum.
FIXME: handle quote special (general escape sequence?)
===================
*/
export function Key_KeynumToString(keynum: number): string {
  if (keynum === -1) return "<KEY NOT FOUND>";
  if (keynum > 32 && keynum < 127) {
    // printable ascii
    return String.fromCharCode(keynum);
  }

  for (const kn of keynames) {
    if (keynum === kn.keynum) return kn.name;
  }

  return "<UNKNOWN KEYNUM>";
}

/*
===================
Key_GetBinding

Reverse lookup: given a bound command string (eg "+moveup"), returns the
display name (Key_KeynumToString) of the first key bound to it, or "" if
no key is bound to that command. Mirrors q2repro's client/keys.c
Key_GetBinding (added for the rerelease cgame API's CL_GetKeyBinding
import; classic Q2 keys.c never had this function). Linear scan over all
256 keynums, case-insensitive compare, first match wins -- identical to
upstream.
===================
*/
export function Key_GetBinding(binding: string): string {
  for (let key = 0; key < 256; key++) {
    const bound = keybindings[key];
    if (bound && Q_stricmp(bound, binding) === 0) {
      return Key_KeynumToString(key);
    }
  }
  return "";
}

/*
===================
Key_SetBinding
===================
*/
export function Key_SetBinding(keynum: number, binding: string | null): void {
  if (keynum === -1) return;

  keybindings[keynum] = binding;
}

/*
===================
Key_Unbind_f
===================
*/
export function Key_Unbind_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("unbind <key> : remove commands from a key\n");
    return;
  }

  const b = Key_StringToKeynum(Cmd_Argv(1));
  if (b === -1) {
    Com_Printf('"%s" isn\'t a valid key\n', Cmd_Argv(1));
    return;
  }

  Key_SetBinding(b, "");
}

export function Key_Unbindall_f(): void {
  for (let i = 0; i < 256; i++) {
    if (keybindings[i]) Key_SetBinding(i, "");
  }
}

/*
===================
Key_Bind_f
===================
*/
export function Key_Bind_f(): void {
  const c = Cmd_Argc();

  if (c < 2) {
    Com_Printf("bind <key> [command] : attach a command to a key\n");
    return;
  }
  const b = Key_StringToKeynum(Cmd_Argv(1));
  if (b === -1) {
    Com_Printf('"%s" isn\'t a valid key\n', Cmd_Argv(1));
    return;
  }

  if (c === 2) {
    if (keybindings[b]) Com_Printf('"%s" = "%s"\n', Cmd_Argv(1), keybindings[b] ?? "");
    else Com_Printf('"%s" is not bound\n', Cmd_Argv(1));
    return;
  }

  // copy the rest of the command line
  let cmd = "";
  for (let i = 2; i < c; i++) {
    cmd += Cmd_Argv(i);
    if (i !== c - 1) cmd += " ";
  }

  Key_SetBinding(b, cmd);
}

/*
============
Key_WriteBindings

Writes lines containing "bind key value"
============
*/
export function Key_WriteBindings(f: number): void {
  let out = "";
  for (let i = 0; i < 256; i++) {
    if (keybindings[i] && keybindings[i] !== "") {
      out += Com_sprintf('bind %s "%s"\n', Key_KeynumToString(i), keybindings[i] ?? "");
    }
  }
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  FS_Write(bytes, bytes.length, f);
}

/*
============
Key_Bindlist_f

============
*/
export function Key_Bindlist_f(): void {
  for (let i = 0; i < 256; i++) {
    if (keybindings[i] && keybindings[i] !== "") {
      Com_Printf('%s "%s"\n', Key_KeynumToString(i), keybindings[i] ?? "");
    }
  }
}

/*
===================
Key_Init
===================
*/
export function Key_Init(): void {
  // q2repro src/common/prompt.c:588-589 (Prompt_Init): com_completion_mode
  // selects between q2repro's exact/fuzzy/substring Prompt completion
  // modes, com_completion_treshold tunes the fuzzy-match score cutoff.
  // Registered, consumer unported: CompleteCommand() below is this port's
  // simple exact-prefix Cmd_CompleteCommand/Cvar_CompleteVariable lookup,
  // not q2repro's Prompt_AddMatch fuzzy-scoring engine.
  Cvar_Get("com_completion_mode", "1", 0);
  Cvar_Get("com_completion_treshold", "50", 0);

  for (let i = 0; i < 32; i++) {
    key_lines[i] = "]";
  }
  key_linepos = 1;

  //
  // init ascii characters in console mode
  //
  for (let i = 32; i < 128; i++) consolekeys[i] = true;
  consolekeys[K_ENTER] = true;
  consolekeys[K_KP_ENTER] = true;
  consolekeys[K_TAB] = true;
  consolekeys[K_LEFTARROW] = true;
  consolekeys[K_KP_LEFTARROW] = true;
  consolekeys[K_RIGHTARROW] = true;
  consolekeys[K_KP_RIGHTARROW] = true;
  consolekeys[K_UPARROW] = true;
  consolekeys[K_KP_UPARROW] = true;
  consolekeys[K_DOWNARROW] = true;
  consolekeys[K_KP_DOWNARROW] = true;
  consolekeys[K_BACKSPACE] = true;
  consolekeys[K_HOME] = true;
  consolekeys[K_KP_HOME] = true;
  consolekeys[K_END] = true;
  consolekeys[K_KP_END] = true;
  consolekeys[K_PGUP] = true;
  consolekeys[K_KP_PGUP] = true;
  consolekeys[K_PGDN] = true;
  consolekeys[K_KP_PGDN] = true;
  consolekeys[K_SHIFT] = true;
  consolekeys[K_INS] = true;
  consolekeys[K_KP_INS] = true;
  consolekeys[K_KP_DEL] = true;
  consolekeys[K_KP_SLASH] = true;
  consolekeys[K_KP_PLUS] = true;
  consolekeys[K_KP_MINUS] = true;
  consolekeys[K_KP_5] = true;

  consolekeys["`".charCodeAt(0)] = false;
  consolekeys["~".charCodeAt(0)] = false;

  for (let i = 0; i < 256; i++) keyshift[i] = i;
  for (let i = "a".charCodeAt(0); i <= "z".charCodeAt(0); i++) keyshift[i] = i - "a".charCodeAt(0) + "A".charCodeAt(0);
  keyshift["1".charCodeAt(0)] = "!".charCodeAt(0);
  keyshift["2".charCodeAt(0)] = "@".charCodeAt(0);
  keyshift["3".charCodeAt(0)] = "#".charCodeAt(0);
  keyshift["4".charCodeAt(0)] = "$".charCodeAt(0);
  keyshift["5".charCodeAt(0)] = "%".charCodeAt(0);
  keyshift["6".charCodeAt(0)] = "^".charCodeAt(0);
  keyshift["7".charCodeAt(0)] = "&".charCodeAt(0);
  keyshift["8".charCodeAt(0)] = "*".charCodeAt(0);
  keyshift["9".charCodeAt(0)] = "(".charCodeAt(0);
  keyshift["0".charCodeAt(0)] = ")".charCodeAt(0);
  keyshift["-".charCodeAt(0)] = "_".charCodeAt(0);
  keyshift["=".charCodeAt(0)] = "+".charCodeAt(0);
  keyshift[",".charCodeAt(0)] = "<".charCodeAt(0);
  keyshift[".".charCodeAt(0)] = ">".charCodeAt(0);
  keyshift["/".charCodeAt(0)] = "?".charCodeAt(0);
  keyshift[";".charCodeAt(0)] = ":".charCodeAt(0);
  keyshift["'".charCodeAt(0)] = '"'.charCodeAt(0);
  keyshift["[".charCodeAt(0)] = "{".charCodeAt(0);
  keyshift["]".charCodeAt(0)] = "}".charCodeAt(0);
  keyshift["`".charCodeAt(0)] = "~".charCodeAt(0);
  keyshift["\\".charCodeAt(0)] = "|".charCodeAt(0);

  menubound[K_ESCAPE] = true;
  for (let i = 0; i < 12; i++) menubound[K_F1 + i] = true;

  //
  // register our functions
  //
  Cmd_AddCommand("bind", Key_Bind_f);
  Cmd_AddCommand("unbind", Key_Unbind_f);
  Cmd_AddCommand("unbindall", Key_Unbindall_f);
  Cmd_AddCommand("bindlist", Key_Bindlist_f);
}

/*
===================
Key_Event

Called by the system between frames for both key up and key down events
Should NOT be called during an interrupt!
===================
*/
export function Key_Event(key: number, down: boolean, time: number): void {
  // hack for modal presses
  if (key_waiting === -1) {
    if (down) key_waiting = key;
    return;
  }

  // update auto-repeat status
  if (down) {
    key_repeats[key]++;
    if (
      key !== K_BACKSPACE &&
      key !== K_PAUSE &&
      key !== K_PGUP &&
      key !== K_KP_PGUP &&
      key !== K_PGDN &&
      key !== K_KP_PGDN &&
      key_repeats[key] > 1
    )
      return; // ignore most autorepeats

    if (key >= 200 && !keybindings[key]) Com_Printf("%s is unbound, hit F4 to set.\n", Key_KeynumToString(key));
  } else {
    key_repeats[key] = 0;
  }

  if (key === K_SHIFT) shift_down = down;

  // console key is hardcoded, so the user can never unbind it
  if (key === "`".charCodeAt(0) || key === "~".charCodeAt(0)) {
    if (!down) return;
    Con_ToggleConsole_f();
    return;
  }

  // any key during the attract mode will bring up the menu
  let effectiveKey = key;
  if (cl.attractloop && cls.key_dest !== KeydestT.key_menu && !(key >= K_F1 && key <= K_F12)) effectiveKey = K_ESCAPE;

  // menu key is hardcoded, so the user can never unbind it
  if (effectiveKey === K_ESCAPE) {
    if (!down) return;

    if (cl.frame.playerstate.stats[STAT_LAYOUTS] && cls.key_dest === KeydestT.key_game) {
      // put away help computer / inventory
      Cbuf_AddText("cmd putaway\n");
      return;
    }
    switch (cls.key_dest) {
      case KeydestT.key_message:
        Key_Message(effectiveKey);
        break;
      case KeydestT.key_menu:
        M_Keydown(effectiveKey);
        break;
      case KeydestT.key_game:
      case KeydestT.key_console:
        M_Menu_Main_f();
        break;
      default:
        Com_Error(ERR_FATAL, "Bad cls.key_dest");
    }
    return;
  }

  // track if any key is down for BUTTON_ANY
  keydown[key] = down;
  if (down) {
    if (key_repeats[key] === 1) setAnykeydown(anykeydown + 1);
  } else {
    setAnykeydown(anykeydown - 1);
    if (anykeydown < 0) setAnykeydown(0);
  }

  //
  // key up events only generate commands if the game key binding is
  // a button command (leading + sign).  These will occur even in console mode,
  // to keep the character from continuing an action started before a console
  // switch.  Button commands include the kenum as a parameter, so multiple
  // downs can be matched with ups
  //
  if (!down) {
    let kb = keybindings[key];
    if (kb && kb[0] === "+") {
      Cbuf_AddText(Com_sprintf("-%s %i %i\n", kb.slice(1), key, time));
    }
    if (keyshift[key] !== key) {
      kb = keybindings[keyshift[key]];
      if (kb && kb[0] === "+") {
        Cbuf_AddText(Com_sprintf("-%s %i %i\n", kb.slice(1), key, time));
      }
    }
    return;
  }

  //
  // if not a consolekey, send to the interpreter no matter what mode is
  //
  if (
    (cls.key_dest === KeydestT.key_menu && menubound[key]) ||
    (cls.key_dest === KeydestT.key_console && !consolekeys[key]) ||
    (cls.key_dest === KeydestT.key_game && (cls.state === ConnstateT.ca_active || !consolekeys[key]))
  ) {
    const kb = keybindings[key];
    if (kb) {
      if (kb[0] === "+") {
        // button commands add keynum and time as a parm
        Cbuf_AddText(Com_sprintf("%s %i %i\n", kb, key, time));
      } else {
        Cbuf_AddText(kb);
        Cbuf_AddText("\n");
      }
    }
    return;
  }

  if (!down) return; // other systems only care about key down events

  let finalKey = key;
  if (shift_down) finalKey = keyshift[key];

  switch (cls.key_dest) {
    case KeydestT.key_message:
      Key_Message(finalKey);
      break;
    case KeydestT.key_menu:
      M_Keydown(finalKey);
      break;

    case KeydestT.key_game:
    case KeydestT.key_console:
      Key_Console(finalKey);
      break;
    default:
      Com_Error(ERR_FATAL, "Bad cls.key_dest");
  }
}

/*
===================
Key_ClearStates
===================
*/
export function Key_ClearStates(): void {
  setAnykeydown(0);

  for (let i = 0; i < 256; i++) {
    if (keydown[i] || key_repeats[i]) Key_Event(i, false, 0);
    keydown[i] = false;
    key_repeats[i] = 0;
  }
}

/*
===================
Key_GetKey
===================
*/
export function Key_GetKey(): number {
  key_waiting = -1;

  // Sys_SendKeyEvents (cl_input.ts) never actually pumps an OS event queue
  // in this port yet (no platform input loop -- see cl_input.ts's own file
  // banner), so nothing sets key_waiting away from -1 here; this call would
  // spin forever in practice. Faithful to the C control flow regardless
  // (the C original relies on Key_Event being invoked from the platform
  // layer during this spin, which this port doesn't wire up) -- reported
  // deviation, not fixed here (out of this unit's SCOPE).
  while (key_waiting === -1) Sys_SendKeyEvents();

  return key_waiting;
}
