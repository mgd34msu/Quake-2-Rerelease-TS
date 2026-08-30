// screen.h -- 2D screen/HUD/cinematic overlay globals. Function prototypes
// declared here (SCR_Init, SCR_UpdateScreen, SCR_CenterPrint, ...) are
// ported as exported functions in cl_scrn.ts's pending stub (cl_scrn.c owns
// them); the scr_cin.c-commented block (SCR_PlayCinematic/SCR_DrawCinematic/
// SCR_RunCinematic/SCR_StopCinematic/SCR_FinishCinematic) is actually
// defined in cl_cin.c in the v3.19 tree (no separate scr_cin.c file exists),
// so those five live in cl_cin.ts's stub instead -- reported deviation from
// the header's own comment.

import { MAX_QPATH, type CvarT } from "../shared/q_shared";

export class VrectT {
  x = 0;
  y = 0;
  width = 0;
  height = 0;
}

export let scr_con_current = 0;
export let scr_conlines = 0; // lines of console to display

export function setScrConCurrent(v: number): void {
  scr_con_current = v;
}
export function setScrConlines(v: number): void {
  scr_conlines = v;
}

export let sb_lines = 0;

export function setSbLines(v: number): void {
  sb_lines = v;
}

// scr_viewsize/crosshair cvars: extern in screen.h, registered by SCR_Init
// (cl_scrn.c); mirrors server.ts's setSvPaused-style setter pattern since
// screen.ts (a header module) cannot itself call Cvar_Get.
export let scr_viewsize: CvarT | null = null;
export let crosshair: CvarT | null = null;

export function setScrViewsize(v: CvarT | null): void {
  scr_viewsize = v;
}
export function setCrosshair(v: CvarT | null): void {
  crosshair = v;
}

export const scr_vrect: VrectT = new VrectT(); // position of render window

export let crosshair_pic = ""; // MAX_QPATH
export let crosshair_width = 0;
export let crosshair_height = 0;

export function setCrosshairPic(v: string): void {
  crosshair_pic = v;
}
export function setCrosshairDims(width: number, height: number): void {
  crosshair_width = width;
  crosshair_height = height;
}

// MAX_QPATH import kept for the crosshair_pic size-limit documentation
// (PORTING.md: char arrays become plain strings, C size noted at the field).
export const CROSSHAIR_PIC_MAX_LEN = MAX_QPATH;
