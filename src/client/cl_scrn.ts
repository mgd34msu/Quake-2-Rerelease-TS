// cl_scrn.c -- master for refresh, status bar, console, chat, notify, etc.
//
// screen.h declares `void SCR_SizeUp (void);` / `void SCR_SizeDown (void);`
// but cl_scrn.c only defines `SCR_SizeUp_f`/`SCR_SizeDown_f` (confirmed by
// grep) -- the header's names are stale, dropped and reported.
//
// Every re.* drawing call in this file is guarded with `if (!re) return;` (or
// an inline `if (re) ...`) before touching the renderer, matching this
// port's established precedent for its unconstructed renderer (ref_gl/ is
// not ported per PORTING.md; see cl_tent.ts/cl_newfx.ts). Non-drawing state
// (scr_dirty tracking, the debug-graph ring buffer, center-print timing,
// vrect sizing) runs unconditionally.
//
// cl_scrn.c's file-scope statics (scr_initialized, scr_draw_loading,
// scr_dirty/scr_old_dirty, the debug-graph ring buffer, scr_centerstring and
// friends, and every cvar besides scr_viewsize/crosshair -- those two are
// screen.h externs and live in screen.ts) are module-private state here,
// mirroring cl_main.ts's per-file cvar-holder precedent.
//
// crosshair is Cvar_Get'd by cl_view.c's V_Init (confirmed by grep of
// quake-2-c), not by SCR_Init -- screen.ts's own banner comment claiming
// "registered by SCR_Init" is inaccurate (pre-existing, out of this unit's
// SCOPE to fix); SCR_TouchPics null-guards it accordingly since cl_view.ts
// is still a pending stub in this port.
//
// SCR_UpdateScreen's normal 3D-refresh branch calls V_RenderView
// (cl_view.ts) and M_Draw (menu.ts), both still pending stubs that throw --
// faithful to the C call order; callers must expect that throw until those
// units land (same situation cl_main.ts already documents for its own
// SCR_UpdateScreen call sites).

import {
  scr_con_current,
  setScrConCurrent,
  scr_conlines,
  setScrConlines,
  scr_vrect,
  scr_viewsize,
  setScrViewsize,
  crosshair,
  crosshair_pic,
  crosshair_width,
  setCrosshairPic,
  setCrosshairDims,
} from "./screen";
import { cl, cls, re, ConnstateT, KeydestT, clCvars, CMD_BACKUP } from "./client";
import { fixedLength } from "../shared/fixed";
import { viddef } from "./vid";
import { Cvar_Get, Cvar_Set, Cvar_SetValue } from "../qcommon/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { Com_Printf, developer } from "../qcommon/common";
import { Com_sprintf, CVAR_ARCHIVE, type CvarT } from "../shared/q_shared";
import { type Vec3, vec3 } from "../shared/math";
import { Sys_Milliseconds } from "../platform/sys";
import { S_StopAllSounds } from "./snd_dma";
import { Con_CheckResize, Con_DrawConsole as Con_DrawConsoleImpl, Con_DrawNotify, Con_ClearNotify } from "./console_impl";
import { SCR_DrawCinematic } from "./cl_cin";
import { V_RenderView } from "./cl_view";
import { M_Draw } from "./menu";
import type { EntityT } from "./ref";
import { CG_DrawHUD, CG_TouchPics } from "./cgame/host";
import { CL_Carousel_Draw, CL_Wheel_Draw } from "./cl_wheel";

function atof(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}
// atoi (the layout interpreter's token->number helper) moved with
// SCR_ExecuteLayoutString to ./cgame/classic_hud.ts -- it had no other
// caller in this file.

// CDAudio_Stop -- no platform cdaudio module exists yet (cdaudio.ts
// documents the boundary decision but has no exports; see that file). No-op
// stand-in named after its future owner, mirroring cl_main.ts's precedent
// for VID_Init/CDAudio_Init/IN_Init.
function CDAudio_Stop(): void {}

let scr_initialized = false; // ready to draw
let scr_draw_loading = 0;

// cvars -- file-scope statics in the C, held here per-file (scr_viewsize and
// crosshair are the two screen.h externs; they live in screen.ts instead).
let scr_conspeed: CvarT | null = null;
let scr_centertime: CvarT | null = null;
let scr_showturtle: CvarT | null = null;
let scr_showpause: CvarT | null = null;
let scr_printspeed: CvarT | null = null;
let scr_netgraph: CvarT | null = null;
let scr_timegraph: CvarT | null = null;
let scr_debuggraph: CvarT | null = null;
let scr_graphheight: CvarT | null = null;
let scr_graphscale: CvarT | null = null;
let scr_graphshift: CvarT | null = null;
let scr_drawall: CvarT | null = null;

class DirtyT {
  x1 = 0;
  y1 = 0;
  x2 = 0;
  y2 = 0;
}

let scr_dirty = new DirtyT();
const scr_old_dirty: DirtyT[] = fixedLength("scr_old_dirty", 2, [new DirtyT(), new DirtyT()]);

/*
===============================================================================

BAR GRAPHS

===============================================================================
*/

/*
==============
CL_AddNetgraph

A new packet was just parsed
==============
*/
export function CL_AddNetgraph(): void {
  // if using the debuggraph for something else, don't add the net lines
  if ((scr_debuggraph && scr_debuggraph.value) || (scr_timegraph && scr_timegraph.value)) return;

  for (let i = 0; i < cls.netchan.dropped; i++) SCR_DebugGraph(30, 0x40);

  for (let i = 0; i < cl.surpressCount; i++) SCR_DebugGraph(30, 0xdf);

  // see what the latency was on this packet
  const idx = cls.netchan.incoming_acknowledged & (CMD_BACKUP - 1);
  let ping = cls.realtime - cl.cmd_time[idx];
  ping = Math.trunc(ping / 30);
  if (ping > 30) ping = 30;
  SCR_DebugGraph(ping, 0xd0);
}

interface GraphsampT {
  value: number;
  color: number;
}

let graphCurrent = 0;
const graphValues: GraphsampT[] = Array.from({ length: 1024 }, () => ({ value: 0, color: 0 }));

/*
==============
SCR_DebugGraph
==============
*/
export function SCR_DebugGraph(value: number, color: number): void {
  graphValues[graphCurrent & 1023].value = value;
  graphValues[graphCurrent & 1023].color = color;
  graphCurrent++;
}

/*
==============
SCR_DrawDebugGraph
==============
*/
function SCR_DrawDebugGraph(): void {
  if (!re) return;
  if (!scr_graphheight || !scr_graphscale || !scr_graphshift) return;

  const w = scr_vrect.width;

  const x = scr_vrect.x;
  const y = scr_vrect.y + scr_vrect.height;
  re.DrawFill(x, y - scr_graphheight.value, w, scr_graphheight.value, 8);

  for (let a = 0; a < w; a++) {
    const i = (graphCurrent - 1 - a + 1024) & 1023;
    let v = graphValues[i].value;
    const color = graphValues[i].color;
    v = v * scr_graphscale.value + scr_graphshift.value;

    if (v < 0) v += scr_graphheight.value * (1 + Math.trunc(-v / scr_graphheight.value));
    const h = Math.trunc(v) % Math.trunc(scr_graphheight.value);
    re.DrawFill(x + w - 1 - a, y - h, 1, h, color);
  }
}

/*
===============================================================================

CENTER PRINTING

===============================================================================
*/

let scr_centerstring = "";
let scr_centertime_start = 0; // for slow victory printing
let scr_centertime_off = 0;
let scr_center_lines = 0;

/*
==============
SCR_CenterPrint

Called for important messages that should stay in the center of the screen
for a few moments
==============
*/
export function SCR_CenterPrint(str: string): void {
  scr_centerstring = str;
  scr_centertime_off = scr_centertime ? scr_centertime.value : 0;
  scr_centertime_start = cl.time;

  // count the number of lines for centering
  scr_center_lines = 1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\n") scr_center_lines++;
  }

  // echo it to the console
  const banner = "\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f";
  Com_Printf("\n\n%s\n\n", banner);

  let s = str;
  for (;;) {
    // scan the width of the line
    let l = 0;
    while (l < 40 && s[l] !== undefined && s[l] !== "\n") l++;

    let line = "";
    for (let i = 0; i < Math.trunc((40 - l) / 2); i++) line += " ";
    line += s.slice(0, l);
    line += "\n";

    Com_Printf("%s", line);

    let idx = l;
    while (s[idx] !== undefined && s[idx] !== "\n") idx++;

    if (s[idx] === undefined) break;
    s = s.slice(idx + 1); // skip the \n
  }
  Com_Printf("\n\n%s\n\n", banner);
  Con_ClearNotify();
}

function SCR_DrawCenterString(): void {
  if (!re) return;

  let remaining = 9999;

  let start = scr_centerstring;

  let y: number;
  if (scr_center_lines <= 4) y = Math.trunc(viddef.height * 0.35);
  else y = 48;

  for (;;) {
    let l = 0;
    while (l < 40 && start[l] !== undefined && start[l] !== "\n") l++;

    let x = Math.trunc((viddef.width - l * 8) / 2);
    SCR_AddDirtyPoint(x, y);
    for (let j = 0; j < l; j++, x += 8) {
      re.DrawChar(x, y, start.charCodeAt(j));
      remaining--;
      if (remaining < 0) return;
    }
    SCR_AddDirtyPoint(x, y + 8);

    y += 8;

    let idx = l;
    while (start[idx] !== undefined && start[idx] !== "\n") idx++;

    if (start[idx] === undefined) break;
    start = start.slice(idx + 1); // skip the \n
  }
}

function SCR_CheckDrawCenterString(): void {
  scr_centertime_off -= cls.frametime;

  if (scr_centertime_off <= 0) return;

  SCR_DrawCenterString();
}

//=============================================================================

/*
=================
SCR_CalcVrect

Sets scr_vrect, the coordinates of the rendered window
=================
*/
function SCR_CalcVrect(): void {
  if (!scr_viewsize) return;

  // bound viewsize
  if (scr_viewsize.value < 40) Cvar_Set("viewsize", "40");
  if (scr_viewsize.value > 100) Cvar_Set("viewsize", "100");

  const size = scr_viewsize.value;

  scr_vrect.width = Math.trunc((viddef.width * size) / 100) & ~7;
  scr_vrect.height = Math.trunc((viddef.height * size) / 100) & ~1;

  scr_vrect.x = Math.trunc((viddef.width - scr_vrect.width) / 2);
  scr_vrect.y = Math.trunc((viddef.height - scr_vrect.height) / 2);
}

/*
=================
SCR_SizeUp_f

Keybinding command
=================
*/
function SCR_SizeUp_f(): void {
  if (scr_viewsize) Cvar_SetValue("viewsize", scr_viewsize.value + 10);
}

/*
=================
SCR_SizeDown_f

Keybinding command
=================
*/
function SCR_SizeDown_f(): void {
  if (scr_viewsize) Cvar_SetValue("viewsize", scr_viewsize.value - 10);
}

/*
=================
SCR_Sky_f

Set a specific sky and rotation speed
=================
*/
function SCR_Sky_f(): void {
  if (!re) return;

  if (Cmd_Argc() < 2) {
    Com_Printf("Usage: sky <basename> <rotate> <axis x y z>\n");
    return;
  }
  const rotate = Cmd_Argc() > 2 ? atof(Cmd_Argv(2)) : 0;
  const axis: Vec3 = vec3();
  if (Cmd_Argc() === 6) {
    axis[0] = atof(Cmd_Argv(3));
    axis[1] = atof(Cmd_Argv(4));
    axis[2] = atof(Cmd_Argv(5));
  } else {
    axis[0] = 0;
    axis[1] = 0;
    axis[2] = 1;
  }

  re.SetSky(Cmd_Argv(1), rotate, axis);
}

//============================================================================

/*
==================
SCR_Init
==================
*/
export function SCR_Init(): void {
  setScrViewsize(Cvar_Get("viewsize", "100", CVAR_ARCHIVE));
  scr_conspeed = Cvar_Get("scr_conspeed", "3", 0);
  // q2repro src/client/screen.c:1487 defaults scr_showturtle to "1"
  // (cvar-parity fix).
  scr_showturtle = Cvar_Get("scr_showturtle", "1", 0);
  scr_showpause = Cvar_Get("scr_showpause", "1", 0);
  scr_centertime = Cvar_Get("scr_centertime", "2.5", 0);
  scr_printspeed = Cvar_Get("scr_printspeed", "8", 0);
  scr_netgraph = Cvar_Get("netgraph", "0", 0);
  scr_timegraph = Cvar_Get("timegraph", "0", 0);
  scr_debuggraph = Cvar_Get("debuggraph", "0", 0);
  scr_graphheight = Cvar_Get("graphheight", "32", 0);
  scr_graphscale = Cvar_Get("graphscale", "1", 0);
  scr_graphshift = Cvar_Get("graphshift", "0", 0);
  scr_drawall = Cvar_Get("scr_drawall", "0", 0);

  // --- cvar-parity audit: remaining src/client/screen.c cvars ---
  // None of the HUD features these gate (chat-message overlay, per-channel
  // colored/scalable crosshair, always-on-screen network-lag meter, hit
  // markers, damage-direction indicators, point-of-interest markers,
  // stats/pmove debug overlays) exist anywhere in this port's client --
  // confirmed by grepping src/client/*.ts for their behavior, not just
  // their cvar names. All registered, consumer unported.
  Cvar_Get("scr_demobar", "1", 0); // screen.c:1447
  // scr_font/scr_alpha are also registered in q2repro's src/client/cgame.c
  // (:69-70, same defaults) for the cgame API's own HUD drawing; this port
  // registers them once here.
  Cvar_Get("scr_font", "conchars", 0); // screen.c:1448, cgame.c:70
  Cvar_Get("scr_scale", "0", CVAR_ARCHIVE); // screen.c:1450
  Cvar_Get("scr_chathud", "0", CVAR_ARCHIVE); // screen.c:1462
  Cvar_Get("scr_chathud_lines", "4", CVAR_ARCHIVE); // screen.c:1463
  Cvar_Get("scr_chathud_time", "0", CVAR_ARCHIVE); // screen.c:1464
  Cvar_Get("scr_chathud_x", "8", CVAR_ARCHIVE); // screen.c:1467
  Cvar_Get("scr_chathud_y", "-64", CVAR_ARCHIVE); // screen.c:1468
  Cvar_Get("ch_health", "0", 0); // screen.c:1470
  Cvar_Get("ch_red", "1", 0); // screen.c:1472
  Cvar_Get("ch_green", "1", 0); // screen.c:1474
  Cvar_Get("ch_blue", "1", 0); // screen.c:1476
  Cvar_Get("ch_alpha", "1", 0); // screen.c:1478
  Cvar_Get("ch_scale", "1", 0); // screen.c:1481
  Cvar_Get("ch_x", "0", 0); // screen.c:1483
  Cvar_Get("ch_y", "0", 0); // screen.c:1484
  Cvar_Get("scr_draw2d", "2", 0); // screen.c:1486
  Cvar_Get("scr_lag_x", "-1", 0); // screen.c:1488
  Cvar_Get("scr_lag_y", "-1", 0); // screen.c:1489
  Cvar_Get("scr_lag_draw", "0", 0); // screen.c:1490
  Cvar_Get("scr_lag_min", "0", 0); // screen.c:1491
  Cvar_Get("scr_lag_max", "200", 0); // screen.c:1492
  Cvar_Get("scr_alpha", "1", 0); // screen.c:1493, cgame.c:69
  Cvar_Get("scr_showstats", "0", 0); // screen.c:1495
  Cvar_Get("scr_showpmove", "0", 0); // screen.c:1496
  Cvar_Get("scr_hit_marker_time", "500", 0); // screen.c:1499
  Cvar_Get("scr_damage_indicators", "1", 0); // screen.c:1501
  Cvar_Get("scr_damage_indicator_time", "1000", 0); // screen.c:1502
  Cvar_Get("scr_pois", "1", 0); // screen.c:1504
  Cvar_Get("scr_poi_edge_frac", "0.15", 0); // screen.c:1505
  Cvar_Get("scr_poi_max_scale", "1.0", 0); // screen.c:1506
  Cvar_Get("scr_safe_zone", "0.02", 0); // screen.c:1507

  //
  // register our commands
  //
  Cmd_AddCommand("timerefresh", SCR_TimeRefresh_f);
  Cmd_AddCommand("loading", SCR_Loading_f);
  Cmd_AddCommand("sizeup", SCR_SizeUp_f);
  Cmd_AddCommand("sizedown", SCR_SizeDown_f);
  Cmd_AddCommand("sky", SCR_Sky_f);

  scr_initialized = true;
}

/*
==============
SCR_DrawNet
==============
*/
function SCR_DrawNet(): void {
  if (!re) return;
  if (cls.netchan.outgoing_sequence - cls.netchan.incoming_acknowledged < CMD_BACKUP - 1) return;

  re.DrawPic(scr_vrect.x + 64, scr_vrect.y, "net");
}

/*
==============
SCR_DrawPause
==============
*/
function SCR_DrawPause(): void {
  if (!re) return;
  if (!scr_showpause || !scr_showpause.value) return; // turn off for screenshots

  if (!clCvars.cl_paused || !clCvars.cl_paused.value) return;

  const { w, h } = re.DrawGetPicSize("pause");
  re.DrawPic(Math.trunc((viddef.width - w) / 2), Math.trunc(viddef.height / 2) + 8, "pause");
}

/*
==============
SCR_DrawLoading
==============
*/
function SCR_DrawLoading(): void {
  if (!scr_draw_loading) return;

  scr_draw_loading = 0;
  if (!re) return;
  const { w, h } = re.DrawGetPicSize("loading");
  re.DrawPic(Math.trunc((viddef.width - w) / 2), Math.trunc((viddef.height - h) / 2), "loading");
}

//=============================================================================

/*
==================
SCR_RunConsole

Scroll it up or down
==================
*/
export function SCR_RunConsole(): void {
  // decide on the height of the console
  if (cls.key_dest === KeydestT.key_console) setScrConlines(0.5);
  // half screen
  else setScrConlines(0); // none visible

  if (scr_conlines < scr_con_current) {
    let next = scr_con_current - (scr_conspeed ? scr_conspeed.value : 0) * cls.frametime;
    if (scr_conlines > next) next = scr_conlines;
    setScrConCurrent(next);
  } else if (scr_conlines > scr_con_current) {
    let next = scr_con_current + (scr_conspeed ? scr_conspeed.value : 0) * cls.frametime;
    if (scr_conlines < next) next = scr_conlines;
    setScrConCurrent(next);
  }
}

/*
==================
SCR_DrawConsole
==================
*/
function SCR_DrawConsole(): void {
  Con_CheckResize();

  if (cls.state === ConnstateT.ca_disconnected || cls.state === ConnstateT.ca_connecting) {
    // forced full screen console
    Con_DrawConsoleImpl(1.0);
    return;
  }

  if (cls.state !== ConnstateT.ca_active || !cl.refresh_prepped) {
    // connected, but can't render
    Con_DrawConsoleImpl(0.5);
    if (re) re.DrawFill(0, Math.trunc(viddef.height / 2), viddef.width, Math.trunc(viddef.height / 2), 0);
    return;
  }

  if (scr_con_current) {
    Con_DrawConsoleImpl(scr_con_current);
  } else {
    if (cls.key_dest === KeydestT.key_game || cls.key_dest === KeydestT.key_message) Con_DrawNotify(); // only draw notify in game
  }
}

//=============================================================================

/*
================
SCR_BeginLoadingPlaque
================
*/
export function SCR_BeginLoadingPlaque(): void {
  S_StopAllSounds();
  cl.sound_prepped = false; // don't play ambients
  CDAudio_Stop();
  if (cls.disable_screen) return;
  if (developer && developer.value) return;
  if (cls.state === ConnstateT.ca_disconnected) return; // if at console, don't bring up the plaque
  if (cls.key_dest === KeydestT.key_console) return;
  if (cl.cinematictime > 0) scr_draw_loading = 2; // clear to balack first
  else scr_draw_loading = 1;
  SCR_UpdateScreen();
  cls.disable_screen = Sys_Milliseconds();
  cls.disable_servercount = cl.servercount;
}

/*
================
SCR_EndLoadingPlaque
================
*/
export function SCR_EndLoadingPlaque(): void {
  cls.disable_screen = 0;
  Con_ClearNotify();
}

/*
================
SCR_Loading_f
================
*/
function SCR_Loading_f(): void {
  SCR_BeginLoadingPlaque();
}

/*
================
SCR_TimeRefresh_f
================
*/
// entitycmpfnc's model/skin pointer-difference compare is unportable as
// written: ModelS/ImageS are opaque renderer handles (`unknown` per ref.ts,
// same precedent as cl_ents.ts's RF_USE_DISGUISE note) with no ordering
// available in this port. Returns a stable 0 (equal) until a real renderer
// exists; reported deviation. Exported for cl_view.c's future qsort call
// (cl_view.ts is still a pending stub, out of this unit's SCOPE).
export function entitycmpfnc(_a: EntityT, _b: EntityT): number {
  return 0;
}

function SCR_TimeRefresh_f(): void {
  if (cls.state !== ConnstateT.ca_active) return;
  if (!re) return;

  const start = Sys_Milliseconds();

  if (Cmd_Argc() === 2) {
    // run without page flipping
    re.BeginFrame(0);
    for (let i = 0; i < 128; i++) {
      cl.refdef.viewangles[1] = (i / 128.0) * 360.0;
      re.RenderFrame(cl.refdef);
    }
    re.EndFrame();
  } else {
    for (let i = 0; i < 128; i++) {
      cl.refdef.viewangles[1] = (i / 128.0) * 360.0;

      re.BeginFrame(0);
      re.RenderFrame(cl.refdef);
      re.EndFrame();
    }
  }

  const stop = Sys_Milliseconds();
  const time = (stop - start) / 1000.0;
  Com_Printf("%f seconds (%f fps)\n", time, 128 / time);
}

/*
=================
SCR_AddDirtyPoint
=================
*/
export function SCR_AddDirtyPoint(x: number, y: number): void {
  if (x < scr_dirty.x1) scr_dirty.x1 = x;
  if (x > scr_dirty.x2) scr_dirty.x2 = x;
  if (y < scr_dirty.y1) scr_dirty.y1 = y;
  if (y > scr_dirty.y2) scr_dirty.y2 = y;
}

export function SCR_DirtyScreen(): void {
  SCR_AddDirtyPoint(0, 0);
  SCR_AddDirtyPoint(viddef.width - 1, viddef.height - 1);
}

/*
==============
SCR_TileClear

Clear any parts of the tiled background that were drawn on last frame
==============
*/
function SCR_TileClear(): void {
  if (scr_drawall && scr_drawall.value) SCR_DirtyScreen(); // for power vr or broken page flippers...

  if (scr_con_current === 1.0) return; // full screen console
  if (scr_viewsize && scr_viewsize.value === 100) return; // full screen rendering
  if (cl.cinematictime > 0) return; // full screen cinematic

  // erase rect will be the union of the past three frames
  // so tripple buffering works properly
  const clear = new DirtyT();
  clear.x1 = scr_dirty.x1;
  clear.x2 = scr_dirty.x2;
  clear.y1 = scr_dirty.y1;
  clear.y2 = scr_dirty.y2;
  for (let i = 0; i < 2; i++) {
    if (scr_old_dirty[i].x1 < clear.x1) clear.x1 = scr_old_dirty[i].x1;
    if (scr_old_dirty[i].x2 > clear.x2) clear.x2 = scr_old_dirty[i].x2;
    if (scr_old_dirty[i].y1 < clear.y1) clear.y1 = scr_old_dirty[i].y1;
    if (scr_old_dirty[i].y2 > clear.y2) clear.y2 = scr_old_dirty[i].y2;
  }

  scr_old_dirty[1] = scr_old_dirty[0];
  scr_old_dirty[0] = scr_dirty;

  scr_dirty = new DirtyT();
  scr_dirty.x1 = 9999;
  scr_dirty.x2 = -9999;
  scr_dirty.y1 = 9999;
  scr_dirty.y2 = -9999;

  // don't bother with anything convered by the console)
  const top0 = scr_con_current * viddef.height;
  if (top0 >= clear.y1) clear.y1 = top0;

  if (clear.y2 <= clear.y1) return; // nothing disturbed

  if (!re) return;

  const top = scr_vrect.y;
  const bottom = top + scr_vrect.height - 1;
  const left = scr_vrect.x;
  const right = left + scr_vrect.width - 1;

  if (clear.y1 < top) {
    // clear above view screen
    const i = clear.y2 < top - 1 ? clear.y2 : top - 1;
    re.DrawTileClear(clear.x1, clear.y1, clear.x2 - clear.x1 + 1, i - clear.y1 + 1, "backtile");
    clear.y1 = top;
  }
  if (clear.y2 > bottom) {
    // clear below view screen
    const i = clear.y1 > bottom + 1 ? clear.y1 : bottom + 1;
    re.DrawTileClear(clear.x1, i, clear.x2 - clear.x1 + 1, clear.y2 - i + 1, "backtile");
    clear.y2 = bottom;
  }
  if (clear.x1 < left) {
    // clear left of view screen
    const i = clear.x2 < left - 1 ? clear.x2 : left - 1;
    re.DrawTileClear(clear.x1, clear.y1, i - clear.x1 + 1, clear.y2 - clear.y1 + 1, "backtile");
    clear.x1 = left;
  }
  if (clear.x2 > right) {
    // clear left of view screen
    const i = clear.x1 > right + 1 ? clear.x1 : right + 1;
    re.DrawTileClear(i, clear.y1, clear.x2 - i + 1, clear.y2 - clear.y1 + 1, "backtile");
    clear.x2 = right;
  }
}

//===============================================================

// sb_nums (the digit-icon status bar numbers), SizeHUDString, DrawHUDString,
// and SCR_DrawField moved to ./cgame/classic_hud.ts along with
// SCR_ExecuteLayoutString/SCR_DrawStats/SCR_DrawLayout (ARCHITECTURE.md
// phase 4 classic-cgame extraction). SCR_TouchPics' own sb_nums precache
// loop has now moved again, behind CgameExports.TouchPics() (host.ts) --
// each registered cgame precaches its own status-bar/HUD pics (classic.ts's
// TouchPics for the sb_nums digits, the kex cgame's own CG_TouchPics for its
// sb_nums + "inventory" pic), dispatched through CG_TouchPics() (host.ts)
// below. SCR_TouchPics itself stays here rather than moving entirely: it
// also owns crosshair pic setup (crosshair_pic/crosshair_width via
// screen.ts), a cl_view.c concern with no relation to either cgame's own
// HUD/layout data -- see this file's prior note on why splitting that half
// out under the crosshair-only SCOPE would have no behavioral benefit.

/*
===============
SCR_TouchPics

Allows rendering code to cache all needed sbar graphics
===============
*/
export function SCR_TouchPics(): void {
  if (!re) return;

  CG_TouchPics();

  if (crosshair && crosshair.value) {
    let cv = crosshair.value;
    if (cv > 3 || cv < 0) {
      cv = 3;
      Cvar_SetValue("crosshair", 3);
    }

    setCrosshairPic(Com_sprintf("ch%i", Math.trunc(cv)));
    const { w, h } = re.DrawGetPicSize(crosshair_pic);
    setCrosshairDims(w, h);
    if (!crosshair_width) setCrosshairPic("");
  }
}

// SCR_ExecuteLayoutString/SCR_DrawStats/SCR_DrawLayout moved to
// ./cgame/classic_hud.ts (see this file's earlier note on the classic-cgame
// extraction, above SCR_TouchPics) -- they now run behind the cgame host
// interface (CG_DrawHUD, ./cgame/host.ts), called from SCR_UpdateScreen
// below in the exact same place/order/conditions this file used to call
// them directly.

//=======================================================

/*
==================
SCR_UpdateScreen

This is called every frame, and can also be called explicitly to flush
text to the screen.
==================
*/
export function SCR_UpdateScreen(): void {
  // if the screen is disabled (loading plaque is up, or vid mode changing)
  // do nothing at all
  if (cls.disable_screen) {
    if (Sys_Milliseconds() - cls.disable_screen > 120000) {
      cls.disable_screen = 0;
      Com_Printf("Loading plaque timed out.\n");
    }
    return;
  }

  if (!scr_initialized) return; // not initialized yet -- console.initialized folded
  // in below since Con_CheckResize/Con_Init live in console_impl.ts and
  // con.initialized is checked there already for every drawing entry point.

  // range check cl_camera_separation so we don't inadvertently fry someone's brain
  if (clCvars.cl_stereo_separation && clCvars.cl_stereo_separation.value > 1.0) Cvar_SetValue("cl_stereo_separation", 1.0);
  else if (clCvars.cl_stereo_separation && clCvars.cl_stereo_separation.value < 0) Cvar_SetValue("cl_stereo_separation", 0.0);

  let numframes: number;
  const separation = [0, 0];
  if (clCvars.cl_stereo && clCvars.cl_stereo.value) {
    numframes = 2;
    separation[0] = clCvars.cl_stereo_separation ? -clCvars.cl_stereo_separation.value / 2 : 0;
    separation[1] = clCvars.cl_stereo_separation ? clCvars.cl_stereo_separation.value / 2 : 0;
  } else {
    separation[0] = 0;
    separation[1] = 0;
    numframes = 1;
  }

  for (let i = 0; i < numframes; i++) {
    if (!re) continue;

    re.BeginFrame(separation[i]);

    if (scr_draw_loading === 2) {
      // loading plaque over black screen
      re.CinematicSetPalette(null);
      scr_draw_loading = 0;
      const { w, h } = re.DrawGetPicSize("loading");
      re.DrawPic(Math.trunc((viddef.width - w) / 2), Math.trunc((viddef.height - h) / 2), "loading");
    } else if (cl.cinematictime > 0) {
      // if a cinematic is supposed to be running, handle menus and console specially
      if (cls.key_dest === KeydestT.key_menu) {
        if (cl.cinematicpalette_active) {
          re.CinematicSetPalette(null);
          cl.cinematicpalette_active = false;
        }
        M_Draw();
      } else if (cls.key_dest === KeydestT.key_console) {
        if (cl.cinematicpalette_active) {
          re.CinematicSetPalette(null);
          cl.cinematicpalette_active = false;
        }
        SCR_DrawConsole();
      } else {
        SCR_DrawCinematic();
      }
    } else {
      // make sure the game palette is active
      if (cl.cinematicpalette_active) {
        re.CinematicSetPalette(null);
        cl.cinematicpalette_active = false;
      }

      // do 3D refresh drawing, and then update the screen
      SCR_CalcVrect();

      // clear any dirty part of the background
      SCR_TileClear();

      V_RenderView(separation[i]);

      // Routed through the cgame host (src/client/cgame/host.ts) rather
      // than calling SCR_DrawStats/SCR_DrawLayout/CL_DrawInventory directly
      // -- the active cgame's DrawHUD (classic.ts + classic_hud.ts, today)
      // makes those same three calls under the same conditions; see those
      // files for the (now real, no longer pass-through) implementation.
      // ARCHITECTURE.md phase 4 ("cgame host, two built-in cgames").
      CG_DrawHUD();

      // q2repro's screen.c:2019-2023 draws the carousel/wheel right after
      // cgame->DrawHUD, before SCR_DrawNet -- same placement here (see
      // cl_wheel.ts for the port itself; this is its "cl_scrn draw
      // hookup").
      CL_Carousel_Draw();
      CL_Wheel_Draw();

      SCR_DrawNet();
      SCR_CheckDrawCenterString();

      if (scr_timegraph && scr_timegraph.value) SCR_DebugGraph(cls.frametime * 300, 0);

      if ((scr_debuggraph && scr_debuggraph.value) || (scr_timegraph && scr_timegraph.value) || (scr_netgraph && scr_netgraph.value))
        SCR_DrawDebugGraph();

      SCR_DrawPause();

      SCR_DrawConsole();

      M_Draw();

      SCR_DrawLoading();
    }
  }
  if (re) re.EndFrame();
}
