// console.c -- the scrollback console: printing, line wrapping, drawing,
// and the toggle/message-mode commands. Named console_impl.ts, not
// console.ts, because console.h's type/global surface already owns that
// basename (ConsoleT/con in console.ts) -- a deliberate exception to
// PORTING.md's "same basename" rule, reported per this unit's brief.
//
// console.ts's `con.text` field is a plain string (CON_TEXTSIZE chars) per
// that module's own "PORTING.md: char arrays become plain strings" note.
// Since JS strings are immutable, every C `con.text[i] = c` write here goes
// through the conSetChar/conFillRange helpers below (slice-and-splice
// instead of an in-place byte write) -- reported deviation, purely
// mechanical, same observable behavior.
//
// Key_ClearTyping/Con_Linefeed/Con_DrawInput are `static`-equivalent (no
// external caller in the ported tree) and stay module-private, matching the
// original pending-stub's scoping note. Con_Dump_f/Con_MessageMode_f/
// Con_MessageMode2_f/Con_ToggleChat_f are exported (registered as commands
// by Con_Init, same as Con_Clear_f) even though the pending-stub's banner
// called them "internal" -- that banner scoped the throw-stub subset, not
// this unit's full-port surface.
//
// console.h also declares `void Con_DrawCharacter (int cx, int line, int
// num);`, but it is never defined anywhere in the v3.19 client tree
// (confirmed by grep) -- a dead declaration, dropped and reported.
//
// Drawing entry points (Con_DrawConsole/Con_DrawNotify/Con_DrawInput/
// DrawString/DrawAltString) early-return `if (!re) return;` before touching
// any re.* call, matching cl_tent.ts/cl_newfx.ts's established precedent for
// this port's unconstructed renderer (ref_gl/ is not ported per
// PORTING.md). Con_CheckResize/Con_Print/Con_Linefeed/state bookkeeping run
// unconditionally, since none of it depends on a renderer existing.

import { con, NUM_CON_TIMES, CON_TEXTSIZE } from "./console";
import { viddef } from "./vid";
import { cl, cls, re, ConnstateT, KeydestT } from "./client";
import { key_lines, edit_line, key_linepos, setKeyLinepos } from "./keys_impl";
import { chat_team, chat_buffer, chat_bufferlen, setChatTeam } from "./keys";
import { Cvar_Get, Cvar_Set, Cvar_VariableValue } from "../qcommon/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv, Cbuf_AddText } from "../qcommon/cmd";
import { SetConPrintHandler, Com_Printf, Com_ServerState } from "../qcommon/common";
import { Com_sprintf, type CvarT } from "../shared/q_shared";
import { VERSION } from "../qcommon/qcommon";
import { FS_Gamedir, FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile } from "../qcommon/files";
import { SCR_EndLoadingPlaque, SCR_AddDirtyPoint } from "./cl_scrn";
import { M_ForceMenuOff } from "./menu";

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

function conCharCodeAt(index: number): number {
  return index >= 0 && index < con.text.length ? con.text.charCodeAt(index) : 32;
}

function conSetChar(index: number, code: number): void {
  con.text = con.text.slice(0, index) + String.fromCharCode(code & 0xff) + con.text.slice(index + 1);
}

function conFillRange(start: number, count: number, code: number): void {
  con.text = con.text.slice(0, start) + String.fromCharCode(code & 0xff).repeat(count) + con.text.slice(start + count);
}

let con_notifytime: CvarT | null = null;

export function DrawString(x: number, y: number, s: string): void {
  if (!re) return;
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    re.DrawChar(cx, y, s.charCodeAt(i));
    cx += 8;
  }
}

export function DrawAltString(x: number, y: number, s: string): void {
  if (!re) return;
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    re.DrawChar(cx, y, s.charCodeAt(i) ^ 0x80);
    cx += 8;
  }
}

function Key_ClearTyping(): void {
  key_lines[edit_line] = "]"; // clear any typing
  setKeyLinepos(1);
}

/*
================
Con_ToggleConsole_f
================
*/
export function Con_ToggleConsole_f(): void {
  SCR_EndLoadingPlaque(); // get rid of loading plaque

  if (cl.attractloop) {
    Cbuf_AddText("killserver\n");
    return;
  }

  if (cls.state === ConnstateT.ca_disconnected) {
    // start the demo loop again
    Cbuf_AddText("d1\n");
    return;
  }

  Key_ClearTyping();
  Con_ClearNotify();

  if (cls.key_dest === KeydestT.key_console) {
    M_ForceMenuOff();
    Cvar_Set("paused", "0");
  } else {
    M_ForceMenuOff();
    cls.key_dest = KeydestT.key_console;

    if (Cvar_VariableValue("maxclients") === 1 && Com_ServerState()) Cvar_Set("paused", "1");
  }
}

/*
================
Con_ToggleChat_f
================
*/
export function Con_ToggleChat_f(): void {
  Key_ClearTyping();

  if (cls.key_dest === KeydestT.key_console) {
    if (cls.state === ConnstateT.ca_active) {
      M_ForceMenuOff();
      cls.key_dest = KeydestT.key_game;
    }
  } else {
    cls.key_dest = KeydestT.key_console;
  }

  Con_ClearNotify();
}

/*
================
Con_Clear_f
================
*/
export function Con_Clear_f(): void {
  con.text = " ".repeat(CON_TEXTSIZE);
}

/*
================
Con_Dump_f

Save the console contents out to a file
================
*/
export function Con_Dump_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("usage: condump <filename>\n");
    return;
  }

  const name = Com_sprintf("%s/%s.txt", FS_Gamedir(), Cmd_Argv(1));

  Com_Printf("Dumped console text to %s.\n", name);
  FS_CreatePath(name);
  const f = FS_FOpenFileWrite(name);
  if (f === null) {
    Com_Printf("ERROR: couldn't open.\n");
    return;
  }

  // skip empty lines
  let l = con.current - con.totallines + 1;
  for (; l <= con.current; l++) {
    const lineStart = mod(l, con.totallines) * con.linewidth;
    let x = 0;
    for (; x < con.linewidth; x++) {
      if (conCharCodeAt(lineStart + x) !== 32) break;
    }
    if (x !== con.linewidth) break;
  }

  // write the remaining lines
  let out = "";
  for (; l <= con.current; l++) {
    const lineStart = mod(l, con.totallines) * con.linewidth;
    let line = "";
    for (let x = 0; x < con.linewidth; x++) line += String.fromCharCode(conCharCodeAt(lineStart + x));

    let end = con.linewidth;
    while (end > 0 && line.charCodeAt(end - 1) === 32) end--;
    line = line.slice(0, end);

    let stripped = "";
    for (let x = 0; x < line.length; x++) stripped += String.fromCharCode(line.charCodeAt(x) & 0x7f);

    out += stripped + "\n";
  }

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  FS_Write(bytes, bytes.length, f);

  FS_FCloseFile(f);
}

/*
================
Con_ClearNotify
================
*/
export function Con_ClearNotify(): void {
  for (let i = 0; i < NUM_CON_TIMES; i++) con.times[i] = 0;
}

/*
================
Con_MessageMode_f
================
*/
export function Con_MessageMode_f(): void {
  setChatTeam(false);
  cls.key_dest = KeydestT.key_message;
}

/*
================
Con_MessageMode2_f
================
*/
export function Con_MessageMode2_f(): void {
  setChatTeam(true);
  cls.key_dest = KeydestT.key_message;
}

/*
================
Con_CheckResize

If the line width has changed, reformat the buffer.
================
*/
export function Con_CheckResize(): void {
  const width = (viddef.width >> 3) - 2;

  if (width === con.linewidth) return;

  if (width < 1) {
    // video hasn't been initialized yet
    con.linewidth = 38;
    con.totallines = Math.floor(CON_TEXTSIZE / con.linewidth);
    con.text = " ".repeat(CON_TEXTSIZE);
  } else {
    const oldwidth = con.linewidth;
    con.linewidth = width;
    const oldtotallines = con.totallines;
    con.totallines = Math.floor(CON_TEXTSIZE / con.linewidth);
    let numlines = oldtotallines;

    if (con.totallines < numlines) numlines = con.totallines;

    let numchars = oldwidth;

    if (con.linewidth < numchars) numchars = con.linewidth;

    const tbuf = con.text;
    const newText: string[] = new Array(CON_TEXTSIZE).fill(" ");

    for (let i = 0; i < numlines; i++) {
      for (let j = 0; j < numchars; j++) {
        const dst = (con.totallines - 1 - i) * con.linewidth + j;
        const src = mod(con.current - i + oldtotallines, oldtotallines) * oldwidth + j;
        newText[dst] = src < tbuf.length ? tbuf[src] : " ";
      }
    }
    con.text = newText.join("");

    Con_ClearNotify();
  }

  con.current = con.totallines - 1;
  con.display = con.current;
}

/*
================
Con_Init
================
*/
export function Con_Init(): void {
  SetConPrintHandler(Con_Print);
  con.linewidth = -1;

  Con_CheckResize();

  Com_Printf("Console initialized.\n");

  //
  // register our commands
  //
  con_notifytime = Cvar_Get("con_notifytime", "3", 0);

  Cmd_AddCommand("toggleconsole", Con_ToggleConsole_f);
  Cmd_AddCommand("togglechat", Con_ToggleChat_f);
  Cmd_AddCommand("messagemode", Con_MessageMode_f);
  Cmd_AddCommand("messagemode2", Con_MessageMode2_f);
  Cmd_AddCommand("clear", Con_Clear_f);
  Cmd_AddCommand("condump", Con_Dump_f);
  con.initialized = true;
}

/*
===============
Con_Linefeed
===============
*/
function Con_Linefeed(): void {
  con.x = 0;
  if (con.display === con.current) con.display++;
  con.current++;
  conFillRange(mod(con.current, con.totallines) * con.linewidth, con.linewidth, 32);
}

// static local in the C original (persists across Con_Print calls)
let printCr = false;

/*
================
Con_Print

Handles cursor positioning, line wrapping, etc
All console printing must go through this in order to be logged to disk
If no console is visible, the text will appear at the top of the game window
================
*/
export function Con_Print(txt: string): void {
  if (!con.initialized) return;

  let mask = 0;
  let p = 0;
  if (txt.length > 0 && (txt.charCodeAt(0) === 1 || txt.charCodeAt(0) === 2)) {
    mask = 128; // go to colored text
    p = 1;
  }

  const charAt = (idx: number): number => (idx < txt.length ? txt.charCodeAt(idx) : 0);

  let c: number;
  while ((c = charAt(p)) !== 0) {
    // count word length
    let l = 0;
    for (; l < con.linewidth; l++) {
      if (charAt(p + l) <= 32) break;
    }

    // word wrap
    if (l !== con.linewidth && con.x + l > con.linewidth) con.x = 0;

    p++;

    if (printCr) {
      con.current--;
      printCr = false;
    }

    if (con.x === 0) {
      Con_Linefeed();
      // mark time for transparent overlay
      if (con.current >= 0) con.times[mod(con.current, NUM_CON_TIMES)] = cls.realtime;
    }

    switch (c) {
      case 10: // '\n'
        con.x = 0;
        break;

      case 13: // '\r'
        con.x = 0;
        printCr = true;
        break;

      default: {
        // display character and advance
        const y = mod(con.current, con.totallines);
        conSetChar(y * con.linewidth + con.x, c | mask | con.ormask);
        con.x++;
        if (con.x >= con.linewidth) con.x = 0;
        break;
      }
    }
  }
}

/*
==============
Con_CenteredPrint
==============
*/
export function Con_CenteredPrint(text: string): void {
  let l = Math.floor((con.linewidth - text.length) / 2);
  if (l < 0) l = 0;
  Con_Print(" ".repeat(l) + text + "\n");
}

/*
==============================================================================

DRAWING

==============================================================================
*/

/*
================
Con_DrawInput

The input line scrolls horizontally if typing goes beyond the right edge
================
*/
function Con_DrawInput(): void {
  if (!re) return;

  if (cls.key_dest === KeydestT.key_menu) return;
  if (cls.key_dest !== KeydestT.key_console && cls.state === ConnstateT.ca_active) return; // don't draw anything (always draw if not active)

  const text = key_lines[edit_line];

  // add the cursor frame, fill out remainder with spaces
  let display = text.slice(0, key_linepos) + String.fromCharCode(10 + ((cls.realtime >> 8) & 1));
  while (display.length < con.linewidth) display += " ";

  // prestep if horizontally scrolling
  const start = key_linepos >= con.linewidth ? 1 + key_linepos - con.linewidth : 0;

  // draw it
  for (let i = 0; i < con.linewidth; i++) {
    const idx = start + i;
    const ch = idx < display.length ? display.charCodeAt(idx) : 32;
    re.DrawChar((i + 1) << 3, con.vislines - 22, ch);
  }
}

/*
================
Con_DrawNotify

Draws the last few lines of output transparently over the game top
================
*/
export function Con_DrawNotify(): void {
  if (!re) return;

  let v = 0;
  for (let i = con.current - NUM_CON_TIMES + 1; i <= con.current; i++) {
    if (i < 0) continue;
    const time = con.times[mod(i, NUM_CON_TIMES)];
    if (time === 0) continue;
    const elapsed = cls.realtime - time;
    if (con_notifytime && elapsed > con_notifytime.value * 1000) continue;

    const lineStart = mod(i, con.totallines) * con.linewidth;
    for (let x = 0; x < con.linewidth; x++) re.DrawChar((x + 1) << 3, v, conCharCodeAt(lineStart + x));

    v += 8;
  }

  if (cls.key_dest === KeydestT.key_message) {
    let skip: number;
    if (chat_team) {
      DrawString(8, v, "say_team:");
      skip = 11;
    } else {
      DrawString(8, v, "say:");
      skip = 5;
    }

    let s = chat_buffer;
    if (chat_bufferlen > (viddef.width >> 3) - (skip + 1)) {
      s = s.slice(chat_bufferlen - ((viddef.width >> 3) - (skip + 1)));
    }
    let x = 0;
    while (x < s.length) {
      re.DrawChar((x + skip) << 3, v, s.charCodeAt(x));
      x++;
    }
    re.DrawChar((x + skip) << 3, v, 10 + ((cls.realtime >> 8) & 1));
    v += 8;
  }

  if (v) {
    SCR_AddDirtyPoint(0, 0);
    SCR_AddDirtyPoint(viddef.width - 1, v);
  }
}

/*
================
Con_DrawConsole

Draws the console with the solid background
================
*/
export function Con_DrawConsole(frac: number): void {
  if (!re) return;

  let lines = Math.floor(viddef.height * frac);
  if (lines <= 0) return;

  if (lines > viddef.height) lines = viddef.height;

  // draw the background
  re.DrawStretchPic(0, -viddef.height + lines, viddef.width, viddef.height, "conback");
  SCR_AddDirtyPoint(0, 0);
  SCR_AddDirtyPoint(viddef.width - 1, lines - 1);

  const version = Com_sprintf("v%4.2f", VERSION);
  for (let x = 0; x < 5; x++) re.DrawChar(viddef.width - 44 + x * 8, lines - 12, 128 + version.charCodeAt(x));

  // draw the text
  con.vislines = lines;

  let rows = (lines - 22) >> 3; // rows of text to draw
  let y = lines - 30;

  // draw from the bottom up
  if (con.display !== con.current) {
    // draw arrows to show the buffer is backscrolled
    for (let x = 0; x < con.linewidth; x += 4) re.DrawChar((x + 1) << 3, y, "^".charCodeAt(0));

    y -= 8;
    rows--;
  }

  let row = con.display;
  for (let i = 0; i < rows; i++, y -= 8, row--) {
    if (row < 0) break;
    if (con.current - row >= con.totallines) break; // past scrollback wrap point

    const lineStart = mod(row, con.totallines) * con.linewidth;
    for (let x = 0; x < con.linewidth; x++) re.DrawChar((x + 1) << 3, y, conCharCodeAt(lineStart + x));
  }

  //ZOID
  // draw the download bar
  if (cls.download !== null) {
    const slashIdx = cls.downloadname.lastIndexOf("/");
    let text = slashIdx >= 0 ? cls.downloadname.slice(slashIdx + 1) : cls.downloadname;

    const barX = con.linewidth - Math.floor((con.linewidth * 7) / 40);
    let barcells = barX - text.length - 8;
    const third = Math.floor(con.linewidth / 3);
    let dlbar: string;
    if (text.length > third) {
      barcells = barX - third - 11;
      text = text.slice(0, third);
      dlbar = text + "...";
    } else {
      dlbar = text;
    }
    dlbar += ": ";
    dlbar += "\x80";

    const n = cls.downloadpercent === 0 ? 0 : Math.floor((barcells * cls.downloadpercent) / 100);
    for (let j = 0; j < barcells; j++) dlbar += j === n ? "\x83" : "\x81";
    dlbar += "\x82";
    dlbar += ` ${String(cls.downloadpercent).padStart(2, "0")}%`;

    const barY = con.vislines - 12;
    for (let i = 0; i < dlbar.length; i++) re.DrawChar((i + 1) << 3, barY, dlbar.charCodeAt(i));
  }
  //ZOID

  // draw the input prompt, user text, and cursor if desired
  Con_DrawInput();
}
