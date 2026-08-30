// cl_inv.c -- client inventory screen. CL_ParseInventory reads MAX_ITEMS
// shorts off the wire into cl.inventory.
//
// CL_DrawInventory (the scrolling inventory overlay drawn from the
// help-computer key), Inv_DrawString, and SetStringHighBit moved to
// ./cgame/classic_hud.ts as part of ARCHITECTURE.md phase 4's classic-cgame
// extraction -- q2repro's own cg_screen.cpp draws the inventory grid from
// inside the cgame too, and this port mirrors that split (see
// classic_hud.ts's own top-of-file comment for the host-import-surface
// boundary that move drew). CL_ParseInventory stays here: it is client
// network-parsing code (reading the wire into cl.inventory), not HUD
// drawing, and has no cgame-side reason to move.
//
// client.h also declares `void CL_KeyInventory (int key);` under this
// file's section, but no client/*.c file in the v3.19 tree defines it
// (confirmed by grep) -- a dead declaration, dropped and reported.

import { cl } from "./client";
import { MSG_ReadShort } from "../qcommon/sizebuf";
import { net_message } from "../qcommon/net_chan";
import { MAX_ITEMS } from "../shared/q_shared";

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
