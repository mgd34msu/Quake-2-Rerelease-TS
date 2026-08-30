// cl_inv.c -- client inventory screen. CL_ParseInventory reads MAX_ITEMS
// shorts off the wire into cl.inventory; CL_DrawInventory draws the
// scrolling inventory overlay used by the help-computer key. Inv_DrawString/
// SetStringHighBit are internal to cl_inv.c (no external caller in the
// ported tree) and stay module-private.
//
// client.h also declares `void CL_KeyInventory (int key);` under this
// file's section, but no client/*.c file in the v3.19 tree defines it
// (confirmed by grep) -- a dead declaration, dropped and reported.
//
// Inv_DrawString/CL_DrawInventory's re.DrawPic/re.DrawChar calls are guarded
// with `if (!re) return;` / `if (re) ...`, matching cl_tent.ts/cl_newfx.ts's
// established precedent for this port's unconstructed renderer (ref_gl/ is
// not ported per PORTING.md); the inventory-list bookkeeping (index/top/
// binding lookup) still runs so callers can rely on it under test.

import { cl, cls, re } from "./client";
import { MSG_ReadShort } from "../qcommon/sizebuf";
import { net_message } from "../qcommon/net_chan";
import { MAX_ITEMS, STAT_SELECTED_ITEM, CS_ITEMS, Com_sprintf, Q_stricmp } from "../shared/q_shared";
import { keybindings } from "./keys";
import { Key_KeynumToString } from "./keys_impl";
import { viddef } from "./vid";
import { SCR_DirtyScreen } from "./cl_scrn";

/*
================
CL_ParseInventory
================
*/
export function CL_ParseInventory(): void {
  for (let i = 0; i < MAX_ITEMS; i++) {
    cl.inventory[i] = MSG_ReadShort(net_message);
  }
}

/*
================
Inv_DrawString
================
*/
function Inv_DrawString(x: number, y: number, s: string): void {
  if (!re) return;
  let cx = x;
  for (let i = 0; i < s.length; i++) {
    re.DrawChar(cx, y, s.charCodeAt(i));
    cx += 8;
  }
}

function SetStringHighBit(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) | 128);
  return out;
}

/*
================
CL_DrawInventory
================
*/
const DISPLAY_ITEMS = 17;

export function CL_DrawInventory(): void {
  const selected = cl.frame.playerstate.stats[STAT_SELECTED_ITEM];

  let num = 0;
  let selected_num = 0;
  const index: number[] = new Array(MAX_ITEMS).fill(0);
  for (let i = 0; i < MAX_ITEMS; i++) {
    if (i === selected) selected_num = num;
    if (cl.inventory[i]) {
      index[num] = i;
      num++;
    }
  }

  // determine scroll point
  let top = selected_num - Math.floor(DISPLAY_ITEMS / 2);
  if (num - top < DISPLAY_ITEMS) top = num - DISPLAY_ITEMS;
  if (top < 0) top = 0;

  let x = Math.floor((viddef.width - 256) / 2);
  let y = Math.floor((viddef.height - 240) / 2);

  // repaint everything next frame
  SCR_DirtyScreen();

  if (re) re.DrawPic(x, y + 8, "inventory");

  y += 24;
  x += 24;
  Inv_DrawString(x, y, "hotkey ### item");
  Inv_DrawString(x, y + 8, "------ --- ----");
  y += 16;
  for (let i = top; i < num && i < top + DISPLAY_ITEMS; i++) {
    const item = index[i];
    // search for a binding
    const binding = Com_sprintf("use %s", cl.configstrings[CS_ITEMS + item]);
    let bind = "";
    for (let j = 0; j < 256; j++) {
      const kb = keybindings[j];
      if (kb && Q_stricmp(kb, binding) === 0) {
        bind = Key_KeynumToString(j);
        break;
      }
    }

    let str = Com_sprintf("%6s %3i %s", bind, cl.inventory[item], cl.configstrings[CS_ITEMS + item]);
    if (item !== selected) {
      str = SetStringHighBit(str);
    } else if (re && (Math.trunc(cls.realtime * 10) & 1) === 1) {
      // draw a blinky cursor by the selected item
      re.DrawChar(x - 8, y, 15);
    }
    Inv_DrawString(x, y, str);
    y += 8;
  }
}
