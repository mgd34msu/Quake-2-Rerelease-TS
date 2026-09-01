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
// SCOPE to fix); SCR_TouchPics null-guards it defensively in case it ever
// runs before V_Init has registered the cvar.
//
// SCR_UpdateScreen's normal 3D-refresh branch calls V_RenderView
// (cl_view.ts) and M_Draw (menu.ts) -- both are real, landed implementations
// (this comment used to describe them as pending stubs that threw; that was
// true only before cl_view.ts/menu.ts landed).

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
  crosshair_height,
  setCrosshairPic,
  setCrosshairDims,
} from "./screen";
import { cl, cls, re, ConnstateT, KeydestT, clCvars, CMD_BACKUP } from "./client";
import { fixedLength } from "../shared/fixed";
import { viddef } from "./vid";
import { Cvar_Get, Cvar_Set, Cvar_SetValue } from "../qcommon/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { Com_Printf, Com_DPrintf, developer } from "../qcommon/common";
import { Com_sprintf, CVAR_ARCHIVE, YAW, type CvarT } from "../shared/q_shared";
import { type Vec3, vec3, DotProduct, VectorAdd, VectorCopy, VectorNormalize, VectorSubtract, AngleVectors } from "../shared/math";
import { Sys_Milliseconds } from "../platform/sys";
import { S_StopAllSounds } from "./snd_dma";
import { Con_CheckResize, Con_DrawConsole as Con_DrawConsoleImpl, Con_DrawNotify, Con_ClearNotify } from "./console_impl";
import { SCR_DrawCinematic } from "./cl_cin";
import { V_RenderView } from "./cl_view";
import { M_Draw } from "./menu";
import type { EntityT, DrawColorT } from "./ref";
import { CG_DrawHUD, CG_DrawHUDForSeat, CG_TouchPics, CG_GetActiveCgame } from "./cgame/host";
import { CL_Seats_Active, CL_Seats_Count, CL_Seats_Viewports, CL_Seats_PlayerState, CL_Seats_Playernum, CL_Seat_ViewHeight } from "./cl_seats";
// Straight from the server-side owner rather than through cl_seats' re-export:
// cl_seats imports THIS file (SCR_CenterPrintSeat), and the per-seat queue
// array below is built while this module is still evaluating, which a
// re-export through the other half of that cycle would not be able to answer.
import { MAX_LOCAL_SEATS } from "../server/sv_seats";
import { CL_SetSeatView } from "./cl_ents";
import { CL_Carousel_Draw, CL_Wheel_Draw } from "./cl_wheel";
import { CDAudio_Play } from "../platform/cd_ogg";
// Palette lookup for svc_poi's `color` field (a classic 8-bit palette
// index, matching q2repro screen.c:1944's own `d_8to24table[poi->color]`).
// q2repro's own screen.c reaches directly into the renderer's global
// palette table for exactly this (`extern uint32_t d_8to24table[256];`,
// screen.c:1851) rather than threading a resolved RGB value through the
// svc_poi wire format -- this is the same "client code reaches one layer
// below the ref.ts RefExports boundary for a renderer primitive ref.ts
// doesn't expose" shape as this file's own kfont/TTF integration (see
// cgame/host.ts's item-5 doc comment for that precedent's full writeup).
// Only the GL renderer's copy is reachable this way -- ref_soft/r_image.ts
// has no exported equivalent -- so a POI's color falls back to (0,0,0,255)
// under the software renderer; reported, not silently wrong (the position/
// image/scale/fade machinery below all still work correctly, only the
// tint is affected).
import { d_8to24table } from "../ref_gl/gl_local";

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
// Damage-indicator / POI cvars (screen.c:69-74) -- registered (bare
// Cvar_Get, values unused) by a prior unit's cvar-parity audit sweep;
// captured here for real now that this section has store+draw consumers.
let scr_damage_indicators: CvarT | null = null;
let scr_damage_indicator_time: CvarT | null = null;
let scr_pois: CvarT | null = null;
let scr_poi_edge_frac: CvarT | null = null;
let scr_poi_max_scale: CvarT | null = null;
// [item 3] menu music -- q2repro's ogg_menu_track (src/client/sound/
// ogg.c:815-816), already registered by platform/cd_ogg.ts's own
// registerCdCvars() but not captured anywhere with a live call site (see
// that file's own header note, and SCR_UpdateScreen's new call below).
// Cvar_Get is idempotent (shared/q_shared.ts convention used throughout
// this codebase -- see this file's own scr_font/scr_alpha precedent just
// below) so registering it a second time here, with the exact same
// name/default/flags cd_ogg.ts uses, just returns cd_ogg.ts's existing
// CvarT instance once that module has run, or creates it fresh if this
// file's SCR_UpdateScreen happens to run first.
let ogg_menu_track: CvarT | null = null;

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

// [Sam-KEX/Paril-KEX] rerelease centerprint model, ported from
// quake2-rerelease-dll/rerelease/cg_screen.cpp's CG_QueueCenterPrint /
// CG_ParseCenterPrint / CG_DrawCenterString / CG_CheckDrawCenterString.
// That algorithm was already ported once, faithfully, at
// src/kexgame/cgame/cg_screen.ts -- but that copy is currently dead code
// (divergence-audit finding #4: src/client/cgame/host.ts never wires the
// kex cgame's own ParseCenterPrint export to the live client path; host.ts
// is out of this unit's territory). What follows is the SAME algorithm
// adapted to this file's own simpler renderer (re.DrawChar directly, no
// kfont/contrast/bind machinery, no splitscreen/hud_vrect) so the one
// client path every centerprint takes today -- cl_parse.ts's
// svc_centerprint and its svc_print PRINT_CENTER/PRINT_TYPEWRITER fallback,
// see that file's own comment at cl_parse.ts:986-1001 -- gets the fixes
// divergence-audit findings #29/#30/#31 describe:
//   - #29: a rotating MAX_CENTER_PRINTS=4 buffer instead of one slot that
//     unconditionally overwrites; a non-instant print queues behind
//     whatever's currently showing instead of clobbering it.
//   - #30: scr_centertime defaults to "5.0" (was vanilla's "2.5") and its
//     clock starts when the print FINISHES displaying (first draw for an
//     instant print, end of type-out for a typewriter print), not at parse
//     time.
//   - #31: non-instant prints type out one codepoint per scr_printspeed
//     SECONDS (default "0.04", was vanilla's "8" characters-per-second,
//     i.e. the opposite unit), drawing only up to the current line, with a
//     blinking cursor char 10+((realtime>>8)&1) at the end of the line
//     being typed.
//
// SCOPE LIMIT: SCR_CenterPrint's only two callers (cl_parse.ts, off-limits
// to this unit) both call it with a single argument, so `instant` always
// defaults to `true` here -- matching legacy svc_centerprint's own
// always-instant vanilla behavior. Wiring cl_parse.ts's svc_print handler
// to pass `instant: printLevel === PRINT_CENTER` (false for
// PRINT_TYPEWRITER, per q2repro's own CL_HandlePrint) so rerelease
// messages actually exercise the typewriter/queue path is a cl_parse.ts
// change, left for whichever unit owns that file next -- the queue/typing/
// timing machinery itself is real and reachable by any future caller
// today, and is exercised directly by test/cl_scrn_centerprint.test.ts.
//
// Centering note: unlike the kex reference's CG_DrawHUDString (which
// centers a fixed 320-unit virtual line and only measures kfont strings),
// each line here is centered in real pixel space from its OWN drawn width
// (buffer.length * 8), matching this port's pre-existing (and untouched)
// instant-print centering convention. For the typewriter path this means
// each partially-revealed line recenters every frame as more of it is
// typed -- a deliberate adaptation, not a byte-identical port of the
// kex layout math.

const MAX_CENTER_PRINTS = 4;

class CenterPrintSlot {
  lines: string[] = []; // empty === free slot
  instant = true;
  currentLine = 0; // line index currently typing out
  lineCount = 0; // codepoints revealed on currentLine
  finished = true; // done typing (or already drawn once, for instant)
  timeTick = 0; // cls.realtime-scale: next reveal timestamp
  timeOff = 0; // cls.realtime-scale: expiry timestamp, valid once finished
}

// ONE QUEUE PER SEAT (src/client/cl_seats.ts). The reference keeps exactly
// this shape on the cgame side -- `std::array<hud_data_t, MAX_SPLIT_PLAYERS>
// hud_data;` (cg_screen.cpp:107), each element carrying its own centers[] and
// center_index, indexed by isplit. This is the engine-side centerprint the
// CLASSIC ruleset draws (the kex cgame has its own copy of the machinery and
// SCR_CenterPrintSeat hands it the seat index instead), and it needs the same
// per-seat split for the same reason: seat 1's "you need the blue key" must
// not overwrite, or be overwritten by, seat 0's.
let scr_centers: CenterPrintSlot[][] = Array.from({ length: MAX_LOCAL_SEATS }, () => Array.from({ length: MAX_CENTER_PRINTS }, () => new CenterPrintSlot()));
let scr_center_index: (number | null)[] = Array.from({ length: MAX_LOCAL_SEATS }, () => null);

/** cg_screen.cpp:109-111's CG_ClearCenterprint. Empties the whole rotating
 *  buffer outright, for every seat. Exported for test/cl_scrn_centerprint
 *  .test.ts to reset this module's private queue state cleanly between
 *  cases; no production call site needs it yet within this unit's scope. */
export function SCR_ClearCenterPrint(): void {
  for (let seat = 0; seat < MAX_LOCAL_SEATS; seat++) {
    scr_center_index[seat] = null;
    for (const slot of scr_centers[seat]) slot.lines = [];
  }
}

// cg_screen.cpp's FindEndOfUTF8Codepoint, adapted to JS's UTF-16 strings:
// never stops on a low surrogate (the second half of an astral-plane
// character's surrogate pair) -- see src/kexgame/cgame/cg_screen.ts's file
// header "ENCODING ADAPTATION" note for the full rationale (same policy,
// same caveat: only non-BMP text, absent from the base game, would differ
// from true byte-for-byte UTF-8 scanning).
function isLowSurrogate(cu: number): boolean {
  return cu >= 0xdc00 && cu <= 0xdfff;
}
function findEndOfCodepoint(str: string, pos: number): number {
  if (pos >= str.length) return -1;
  for (let i = pos; i < str.length; i++) {
    if (!isLowSurrogate(str.charCodeAt(i))) return i;
  }
  return -1;
}

function SCR_QueueCenterPrint(seat: number, instant: boolean): CenterPrintSlot {
  const slots = scr_centers[seat]!;
  const index = scr_center_index[seat];

  if (index === null || instant) {
    scr_center_index[seat] = 0;
    for (let i = 1; i < MAX_CENTER_PRINTS; i++) slots[i].lines = [];
    return slots[0]!;
  }

  // pick the next free index if we can find one
  for (let i = 1; i < MAX_CENTER_PRINTS; i++) {
    const slot = slots[(index + i) % MAX_CENTER_PRINTS]!;
    if (slot.lines.length === 0) return slot;
  }

  // none free: overwrite the currently-displaying slot and skip ahead
  // (cg_screen.cpp:368-372, ported verbatim including this corner case)
  const slot = slots[index]!;
  scr_center_index[seat] = (index + 1) % MAX_CENTER_PRINTS;
  return slot;
}

/*
==============
SCR_CenterPrint

Called for important messages that should stay in the center of the screen
for a few moments. `instant` (default true; see SCOPE LIMIT above) mirrors
cg_screen.cpp's CG_ParseCenterPrint(str, isplit, instant): true draws the
whole message immediately (and flushes the queue back to slot 0); false
queues it behind whatever's displaying and types it out one codepoint at a
time.

[item 6, %bind hint lines] This file's own header comment already flagged
the reason a from-scratch adaptation of cg_screen.cpp's algorithm lives
here at all: "src/client/cgame/host.ts never wires the kex cgame's own
ParseCenterPrint export to the live client path; host.ts is out of this
unit's territory". host.ts now has that wiring (CgameExports.ParseCenterPrint
-- see that file's own doc comment for the full writeup), so the fix is a
delegation check here rather than reimplementing %bind:...% expansion a
second time: when the ACTIVE cgame exposes a real ParseCenterPrint (the kex
cgame, once CG_SetActiveCgameKind("kex") has run -- cl_parse.ts's
CL_ParseServerData does this for real on a rerelease/1038 connection), hand
the raw string straight to it. The kex cgame's own CG_ParseCenterPrint
(src/kexgame/cgame/cg_screen.ts:548-630) strips leading "%bind:cmd:purpose%"
tokens into `center.binds` and its own CG_DrawCenterString draws each one
through cgi.SCR_DrawBind -- already wired for real in host.ts's
buildCgameImports() ("[key] purpose" via Key_GetBinding + Loc_Localize,
e.g. "CTRL Crouch here" for the loc test suite's real
"%bind:+movedown:$m_crouch%Crouch here." example) -- so this single
delegation line is sufficient; no bind-expansion logic needs to be
duplicated in THIS file. The classic cgame has no ParseCenterPrint member
(CgameExports.ParseCenterPrint is optional -- see host.ts's own doc comment
on why), so classic sessions fall through unchanged to this file's own
queue/typewriter implementation below, exactly as before.
==============
*/
export function SCR_CenterPrint(str: string, instant = true): void {
  SCR_CenterPrintSeat(0, str, instant);
}

/*
==============
SCR_CenterPrintSeat

The same message, addressed to one LOCAL SPLITSCREEN seat (cl_seats.ts).
`seat` is the reference's `isplit`: the cgame's CG_ParseCenterPrint already
takes it (cg_screen.cpp's `CG_ParseCenterPrint(str, isplit, instant)` ->
hud_data[isplit]) and its CG_DrawHUD draws hud_data[isplit] into that seat's
own hud_vrect, so under the kex ruleset passing the seat through is the whole
fix. Under the classic ruleset the message lands in this file's own per-seat
queue and SCR_CheckDrawCenterStringSeat draws it into the seat's pane.

Seats past 0 do NOT echo to the console: the console and its notify lines
belong to the primary player (the reference gates its own chat line the same
way -- `if (isplit == 0)`, cg_screen.cpp:202), and Con_ClearNotify below would
have seat 1's message wiping seat 0's notify text off the screen.
==============
*/
export function SCR_CenterPrintSeat(seat: number, str: string, instant = true): void {
  const activeParseCenterPrint = CG_GetActiveCgame().ParseCenterPrint;
  if (activeParseCenterPrint) {
    activeParseCenterPrint(str, seat, instant);
    return;
  }

  const center = SCR_QueueCenterPrint(seat, instant);
  center.lines = [];

  if (seat === 0) {
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

  // split into lines (cg_screen.cpp:454-484 / cg_screen.ts:597-618)
  let lineStart = 0;
  for (let lineEnd = 0; ; ) {
    lineEnd = findEndOfCodepoint(str, lineEnd);

    if (lineEnd === -1) {
      if (lineStart < str.length) center.lines.push(str.slice(lineStart));
      break;
    }

    if (str[lineEnd] === "\n") {
      center.lines.push(lineEnd > lineStart ? str.slice(lineStart, lineEnd) : "");
      lineStart = lineEnd + 1;
      lineEnd++;
      continue;
    }

    lineEnd++;
  }

  if (center.lines.length === 0) {
    center.finished = true;
    return;
  }

  center.timeTick = cls.realtime + (scr_printspeed ? scr_printspeed.value : 0) * 1000;
  center.instant = instant;
  center.finished = false;
  center.currentLine = 0;
  center.lineCount = 0;
}

/** The rectangle a seat's engine centerprint centers itself in.
 *
 *  Ordinarily the whole display, which is what every coordinate here was
 *  implicitly relative to. Under LOCAL SPLITSCREEN it is that seat's own pane,
 *  the same rect its 3D view and its HUD are drawn into (cl_seats.ts's
 *  SplitscreenLayout), which is where the kex path already puts a seat's
 *  centerprint (its cgame draws them from hud_data[isplit] against that seat's
 *  hud_vrect). */
function centerPrintPane(seat: number): { x: number; y: number; width: number; height: number } {
  if (!CL_Seats_Active()) return { x: 0, y: 0, width: viddef.width, height: viddef.height };
  const rect = CL_Seats_Viewports()[seat];
  return rect ? rect : { x: 0, y: 0, width: viddef.width, height: viddef.height };
}

function SCR_DrawCenterStringSlot(center: CenterPrintSlot, seat: number): void {
  if (!re) return;

  const pane = centerPrintPane(seat);

  let y: number;
  if (center.lines.length <= 4) y = pane.y + Math.trunc(pane.height * 0.35);
  else y = pane.y + 48;

  if (center.instant) {
    for (const line of center.lines) {
      const l = Math.min(line.length, 40);
      let x = pane.x + Math.trunc((pane.width - l * 8) / 2);
      SCR_AddDirtyPoint(x, y);
      for (let j = 0; j < l; j++, x += 8) re.DrawChar(x, y, line.charCodeAt(j));
      SCR_AddDirtyPoint(x, y + 8);
      y += 8;
    }

    if (!center.finished) {
      center.finished = true;
      center.timeOff = cls.realtime + (scr_centertime ? scr_centertime.value : 0) * 1000;
    }
    return;
  }

  // typewriter: advance the reveal timer, then draw only up to and
  // including the current line (cg_screen.cpp:548-621 / cg_screen.ts:675-726)
  const t = cls.realtime;

  if (!center.finished && center.timeTick < t) {
    center.timeTick = t + (scr_printspeed ? scr_printspeed.value : 0) * 1000;
    center.lineCount = findEndOfCodepoint(center.lines[center.currentLine] ?? "", center.lineCount + 1);

    if (center.lineCount === -1) {
      center.currentLine++;
      center.lineCount = 0;

      if (center.currentLine === center.lines.length) {
        center.currentLine--;
        center.finished = true;
        center.timeOff = t + (scr_centertime ? scr_centertime.value : 0) * 1000;
      }
    }
  }

  for (let i = 0; i < center.lines.length; i++) {
    const line = center.lines[i]!;
    const buffer = center.finished || i !== center.currentLine ? line : line.slice(0, center.lineCount);

    const l = Math.min(buffer.length, 40);
    let x = pane.x + Math.trunc((pane.width - l * 8) / 2);
    SCR_AddDirtyPoint(x, y);
    for (let j = 0; j < l; j++, x += 8) re.DrawChar(x, y, buffer.charCodeAt(j));

    if (i === center.currentLine) {
      // blinking cursor at the end of the line being typed (or, once
      // finished, at the end of the last line -- it keeps blinking until
      // this slot's display time runs out, matching the reference)
      re.DrawChar(x, y, 10 + ((t >> 8) & 1));
      x += 8;
    }
    SCR_AddDirtyPoint(x, y + 8);

    y += 8;

    if (i === center.currentLine) break;
  }
}

// Exported for test/cl_scrn_centerprint.test.ts: this is the same per-frame
// entry point SCR_UpdateScreen's 3D-refresh branch already calls (below),
// so driving it directly from a test exercises the exact production
// rotate/reveal/expire path.
export function SCR_CheckDrawCenterString(): void {
  SCR_CheckDrawCenterStringSeat(0);
}

/** The same per-frame rotate/reveal/expire pass for one seat's queue, drawn
 *  into that seat's pane. Seat 0 is the ordinary call above; seats 1..N-1 are
 *  driven from SCR_DrawSeatViews, once their pane has been rendered. */
export function SCR_CheckDrawCenterStringSeat(seat: number): void {
  const index = scr_center_index[seat];
  if (index === null || index === undefined) return;

  const slots = scr_centers[seat]!;
  const center = slots[index]!;

  // ran out of center time -- rotate to the next queued slot, if any
  // (cg_screen.cpp:619-653 / cg_screen.ts:729-757)
  if (center.finished && center.timeOff < cls.realtime) {
    center.lines = [];

    const nextIndex = (index + 1) % MAX_CENTER_PRINTS;
    const nextCenter = slots[nextIndex]!;

    if (nextCenter.lines.length === 0) {
      scr_center_index[seat] = null;
      return;
    }

    scr_center_index[seat] = nextIndex;
    nextCenter.currentLine = 0;
    nextCenter.lineCount = 0;
  }

  const drawIndex = scr_center_index[seat];
  if (drawIndex === null) return;

  SCR_DrawCenterStringSlot(slots[drawIndex]!, seat);
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
  // [Sam-KEX] scr_centertime was "2.5", changed to "5.0" (cg_screen.cpp:1772
  // comment); scr_printspeed was "8" characters-per-second, changed to
  // "0.04" SECONDS-per-character (cg_screen.cpp:1773 comment) -- divergence
  // -audit findings #30/#31, see the CENTER PRINTING section below.
  scr_centertime = Cvar_Get("scr_centertime", "5.0", 0);
  scr_printspeed = Cvar_Get("scr_printspeed", "0.04", 0);
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
  // Captured (not bare Cvar_Get calls) now that SCR_AddToDamageDisplay/
  // SCR_DrawDamageDisplays and SCR_AddPOI/SCR_RemovePOI/SCR_DrawPOIs below
  // are real consumers.
  scr_damage_indicators = Cvar_Get("scr_damage_indicators", "1", 0); // screen.c:1501
  scr_damage_indicator_time = Cvar_Get("scr_damage_indicator_time", "1000", 0); // screen.c:1502
  scr_pois = Cvar_Get("scr_pois", "1", 0); // screen.c:1504
  scr_poi_edge_frac = Cvar_Get("scr_poi_edge_frac", "0.15", 0); // screen.c:1505
  scr_poi_max_scale = Cvar_Get("scr_poi_max_scale", "1.0", 0); // screen.c:1506
  Cvar_Get("scr_safe_zone", "0.02", 0); // screen.c:1507 -- still unconsumed: no splitscreen/overscan-safe-zone rect concept exists in this port's cgame->DrawHUD call (see cgame/host.ts's kexHudVrect doc comment), same gap as this file's own pre-existing note on the classic HUD path.

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

  // [item 1] damage indicator pic (screen.c:1262-1263's own
  // `scr.damage_display_pic = R_RegisterPic("damage_indicator");
  // R_GetPicSize(&scr.damage_display_width, &scr.damage_display_height,
  // scr.damage_display_pic);`). No "pics/" prefix -- matches R_RegisterPic's
  // own bare name, letting Draw_FindPic's existing search-order/format-
  // fallback chain (pics/damage_indicator.pcx, then .png/.tga, etc.) resolve
  // it; the rerelease pak only ships a .png/.tga for this asset (see this
  // file's own report), which that fallback chain already handles -- no
  // special-casing needed here.
  re.RegisterPic(DAMAGE_DISPLAY_PIC);
  const damageSize = re.DrawGetPicSize(DAMAGE_DISPLAY_PIC);
  damage_display_width = damageSize.w;
  damage_display_height = damageSize.h;

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

/*
===============================================================================

DAMAGE INDICATORS / POINTS OF INTEREST / HELP PATH -- the kex on-screen
indicator systems. q2repro src/client/screen.c's SCR_AddToDamageDisplay/
SCR_DrawDamageDisplays (damage-direction wedges fading around the
crosshair) and SCR_AddPOI/SCR_RemovePOI/SCR_DrawPOIs (world-projected
compass markers), plus a documented adaptation of tent.c's CL_AddHelpPath
(the compass "help path" breadcrumb trail). Decode-side already existed
(qcommon/protocol/kexdemo.ts's readDamageKex/readPoiKex/readHelpPathKex,
routed here from cl_parse.ts's svc_damage/svc_poi/svc_help_path cases) --
this section is the store+draw consumer that was missing.

Drawn from cl_view.ts's SCR_DrawCrosshair (that file's own home for the
crosshair pic itself, cl_view.c in the original) rather than from this
file's own SCR_UpdateScreen, matching q2repro's own call order exactly:
screen.c:1969 calls SCR_DrawPOIs() BEFORE drawing the crosshair pic itself,
then screen.c:1986 calls SCR_DrawDamageDisplays() AFTER it -- see
SCR_DrawPOIs/SCR_DrawDamageDisplays' own export comments below and
cl_view.ts's SCR_DrawCrosshair for the two call sites.

===============================================================================
*/

// -----------------------------------------------------------------------
// Damage indicators (screen.c:1675-1745)
// -----------------------------------------------------------------------

interface ScrDamageEntryT {
  damage: number;
  color: Vec3;
  dir: Vec3;
  time: number; // cls.realtime-scale expiry; <= cls.realtime means "free slot"
}

const MAX_DAMAGE_ENTRIES = 32; // client.h:1172
const DAMAGE_ENTRY_BASE_SIZE = 3; // client.h:1173
const DAMAGE_DISPLAY_PIC = "damage_indicator"; // screen.c:1262
let damage_display_width = 0;
let damage_display_height = 0;

const scr_damage_entries: ScrDamageEntryT[] = Array.from({ length: MAX_DAMAGE_ENTRIES }, () => ({ damage: 0, color: vec3(), dir: vec3(), time: 0 }));

// vectoangles2's YAW-only half (cl_newfx.ts's own vectoangles2, "this is
// duplicated in the game DLL, but I need it here" -- same duplication
// idiom, one more file needing it): SCR_DrawDamageDisplays only ever reads
// angles[YAW] off the result (screen.c:1726-1727), so this only computes
// that component.
function vectoyaw(dir: Vec3): number {
  if (dir[1] === 0 && dir[0] === 0) return 0;
  let yaw: number;
  if (dir[0]) yaw = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
  else if (dir[1] > 0) yaw = 90;
  else yaw = 270;
  if (yaw < 0) yaw += 360;
  return yaw;
}

// SCR_AllocDamageDisplay (screen.c:1675-1697): reuse a slot already tracking
// a near-identical direction (dot >= 0.95) so repeated hits from roughly the
// same angle accumulate into one wedge instead of spawning a new one each
// time; otherwise take the first free (expired) slot, falling back to
// slot 0 if every slot is still active (matches the C's own `entry =
// scr.damage_entries;` unconditional fallback after the loop).
function SCR_AllocDamageDisplay(dir: Vec3): ScrDamageEntryT {
  for (const entry of scr_damage_entries) {
    if (entry.time <= cls.realtime) {
      entry.damage = 0;
      entry.color = vec3();
      return entry;
    }
    if (DotProduct(entry.dir, dir) >= 0.95) return entry;
  }
  const entry = scr_damage_entries[0]!;
  entry.damage = 0;
  entry.color = vec3();
  return entry;
}

/** q2repro screen.c:1699-1712's SCR_AddToDamageDisplay -- store half. Called
 *  from cl_parse.ts's svc_damage case (parse.c:1135-1156's CL_ParseDamage,
 *  which builds `color` from the health/shield/armor bits before calling
 *  this, normalized the same way). */
export function SCR_AddToDamageDisplay(damage: number, color: Vec3, dir: Vec3): void {
  if (!scr_damage_indicators || !scr_damage_indicators.value) return;

  const entry = SCR_AllocDamageDisplay(dir);
  entry.damage += damage;
  VectorAdd(entry.color, color, entry.color);
  VectorNormalize(entry.color);
  VectorCopy(dir, entry.dir);
  entry.time = cls.realtime + (scr_damage_indicator_time ? scr_damage_indicator_time.value : 1000);
}

/** q2repro screen.c:1714-1745's SCR_DrawDamageDisplays -- draw half. Called
 *  from cl_view.ts's SCR_DrawCrosshair, AFTER the crosshair pic itself
 *  (screen.c:1986's own call order).
 *
 *  DEVIATION (renderer primitive gap, not silently dropped): the C rotates
 *  the whole pic around the crosshair via R_DrawStretchRotatePic(x, y, w, h,
 *  color, yaw_diff, pivot_x, pivot_y, pic) -- this port's RefExports (ref.ts)
 *  has no rotated-stretch-pic primitive (DrawPic/DrawStretchPic/
 *  DrawColorPic/DrawStretchPicRegion are all axis-aligned), and adding one
 *  would mean extending ref.ts/gl_draw.ts/r_draw.ts, outside this unit's
 *  territory (cl_scrn.ts/cl_view.ts/console_impl.ts/cl_parse.ts routing/
 *  host.ts items 5-6/keys_impl.ts/test -- see this file's own task report).
 *  Adapted instead: the pivot offset (0, -(crosshair_height + h/2)) that the
 *  C rotates the PIC around is rotated here as a plain 2D point around the
 *  crosshair center by the same yaw_diff, and the (unrotated) pic is drawn
 *  centered on that rotated point via DrawColorPic. This preserves the
 *  signal that actually matters (a wedge appears at the correct clock
 *  position around the crosshair for the hit direction, fading over
 *  scr_damage_indicator_time) without rotating the wedge graphic itself to
 *  visually point that way. */
export function SCR_DrawDamageDisplays(): void {
  if (!re) return;
  if (!scr_damage_indicators || !scr_damage_indicators.value) return;
  if (!damage_display_width || !damage_display_height) return; // SCR_TouchPics never ran (no renderer, or pic missing)

  const durationMs = scr_damage_indicator_time ? scr_damage_indicator_time.value : 1000;
  const centerX = viddef.width / 2;
  const centerY = viddef.height / 2;
  const myYaw = cl.predicted_angles[YAW];

  for (const entry of scr_damage_entries) {
    if (entry.time <= cls.realtime) continue;

    const frac = (entry.time - cls.realtime) / durationMs;
    const damageYaw = vectoyaw(entry.dir);
    const yawDiffRad = ((myYaw - damageYaw - 180) * Math.PI) / 180;

    const size = Math.min(damage_display_width, DAMAGE_ENTRY_BASE_SIZE * entry.damage);
    const w = size;
    const h = damage_display_height;

    const ox = 0;
    const oy = -(crosshair_height + h / 2);
    const cosA = Math.cos(yawDiffRad);
    const sinA = Math.sin(yawDiffRad);
    const rx = ox * cosA - oy * sinA;
    const ry = ox * sinA + oy * cosA;

    const color: DrawColorT = {
      r: Math.round(Math.max(0, Math.min(1, entry.color[0])) * 255),
      g: Math.round(Math.max(0, Math.min(1, entry.color[1])) * 255),
      b: Math.round(Math.max(0, Math.min(1, entry.color[2])) * 255),
      a: Math.round(Math.max(0, Math.min(1, frac)) * 255),
    };

    re.DrawColorPic(Math.trunc(centerX + rx - w / 2), Math.trunc(centerY + ry - h / 2), Math.trunc(w), Math.trunc(h), DAMAGE_DISPLAY_PIC, color);
  }
}

// -----------------------------------------------------------------------
// Points of interest (screen.c:1747-1958)
// -----------------------------------------------------------------------

const POI_FLAG_HIDE_ON_AIM = 1; // screen.c:1856

interface ScrPoiT {
  id: number;
  time: number; // cl.time-scale expiry (NOT cls.realtime -- matches screen.c's own `poi->time = cl.time + time`)
  position: Vec3;
  imageName: string; // resolved pic name -- this port's DrawColorPic takes names, not qhandle_t, so the name is resolved and stored once here instead of a qhandle_t (screen.c's own `poi->image = cl.image_precache[image]`)
  width: number;
  height: number;
  color: number; // classic 8-bit palette index (d_8to24table), NOT a resolved RGB -- resolved at draw time
  flags: number;
}

const MAX_TRACKED_POIS = 32; // client.h:1185
const scr_pois_store: ScrPoiT[] = Array.from({ length: MAX_TRACKED_POIS }, () => ({ id: 0, time: 0, position: vec3(), imageName: "", width: 0, height: 0, color: 0, flags: 0 }));

/** q2repro screen.c:1747-1767's SCR_RemovePOI. Routed from cl_parse.ts's
 *  svc_poi case when the wire's `time` field is the USHRT_MAX sentinel
 *  (q2proto_q2repro_client_read_poi's own convention, kexdemo.ts's
 *  readPoiKex -- see parse.c:1213-1223's CL_ParsePOI, which this mirrors). */
export function SCR_RemovePOI(id: number): void {
  if (!scr_pois || !scr_pois.value) return;
  if (id === 0) {
    Com_Printf("tried to remove unkeyed POI\n");
    return;
  }
  for (const poi of scr_pois_store) {
    if (poi.id === id) {
      poi.id = 0;
      poi.time = 0;
      break;
    }
  }
}

/** q2repro screen.c:1769-1849's SCR_AddPOI, ported allocation-strategy
 *  faithfully (id===0 "unkeyed, prefer the oldest still-live unkeyed slot"
 *  vs. id!==0 "replace a matching id, else a free slot, else the oldest
 *  unkeyed slot" -- see the C's own extensive comments, reproduced above
 *  each branch here too). `image` is a CS_IMAGES-relative index (same
 *  convention cl_wheel.ts's CL_LoadWheelIcons already uses for its own icon
 *  indices: `cl.configstrings[cls.csr.images + iconIndex]`) -- resolved to
 *  a pic NAME here (not a qhandle_t/ImageS, since this port's DrawColorPic
 *  draws by name) and registered via re.RegisterPic + re.DrawGetPicSize,
 *  mirroring the C's own `poi->image = cl.image_precache[image];
 *  R_GetPicSize(&poi->width, &poi->height, poi->image);` pair. */
export function SCR_AddPOI(id: number, time: number, p: Vec3, image: number, color: number, flags: number): void {
  if (!scr_pois || !scr_pois.value) return;

  let poi: ScrPoiT | null = null;

  if (id === 0) {
    // find any free non-key'd POI. we'll find
    // the oldest POI as a fallback to replace.
    let oldest: ScrPoiT | null = null;
    for (const rover of scr_pois_store) {
      if (rover.time > cl.time) {
        if (rover.id) continue; // keyed
        if (!oldest || rover.time < oldest.time) oldest = rover;
      } else {
        poi = rover; // expired
        break;
      }
    }
    if (!poi) poi = oldest;
  } else {
    // we must replace a matching POI with the ID
    // if one exists, otherwise we pick a free POI,
    // and finally we pick the oldest non-key'd POI.
    let oldest: ScrPoiT | null = null;
    let free: ScrPoiT | null = null;
    for (const rover of scr_pois_store) {
      if (rover.id === id) {
        poi = rover; // found matching ID, just re-use that one
        break;
      }
      if (rover.time <= cl.time) {
        if (!free) free = rover; // expired
      } else if (!rover.id) {
        // not expired; we should only ever replace non-key'd POIs
        if (!oldest || rover.time < oldest.time) oldest = rover;
      }
    }
    if (!poi) poi = free ?? oldest;
  }

  if (!poi) {
    Com_Printf("couldn't add a POI\n");
    return;
  }

  poi.id = id;
  poi.time = cl.time + time;
  VectorCopy(p, poi.position);
  poi.imageName = cl.configstrings[cls.csr.images + image] ?? "";
  if (re && poi.imageName) {
    re.RegisterPic(poi.imageName);
    const size = re.DrawGetPicSize(poi.imageName);
    poi.width = size.w;
    poi.height = size.h;
  } else {
    poi.width = 0;
    poi.height = 0;
  }
  poi.color = color;
  poi.flags = flags;
}

function clipf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** q2repro screen.c:1859-1958's SCR_DrawPOIs. Called from cl_view.ts's
 *  SCR_DrawCrosshair, BEFORE the crosshair pic itself (screen.c:1969's own
 *  call order).
 *
 *  Projection is re-derived analytically (view-space dot products against
 *  AngleVectors(cl.predicted_angles, ...) + a symmetric perspective divide
 *  by tan(fov/2)) rather than building the C's own 4x4 frustum/view/
 *  multiply/TransformVec4 matrix stack (Matrix_Frustum/Matrix_FromOriginAxis/
 *  Matrix_Multiply/Matrix_TransformVec4 have no port in this codebase, and
 *  this is the only call site that would ever need them) -- mathematically
 *  equivalent for a symmetric frustum (this engine never uses an off-center
 *  one), verified against the C's own gluProject-style formula it cites.
 *  `w` (the C's `sp[3]`, pre-divide) is exactly the view-space forward
 *  distance under this formulation, so `behind = w < 0` still means "camera
 *  is looking away from this point", matching the C's `sp[3] < 0.f` check.
 *
 *  DEVIATION (preserved q2repro quirk, FIDELITY RAZOR rule 17 -- NOT fixed
 *  here): screen.c:1935-1956 draws the stretch pic at `hw`/`hh` -- HALF of
 *  `poi->width * scale` / `poi->height * scale` -- even though the centering
 *  math (`sp[0] -= hw`) and the position clamp bound
 *  (`scr.hud_width - hw`) both read as if a FULL-size draw of `hw*2`/`hh*2`
 *  was intended. This looks like a real upstream half-size rendering quirk,
 *  not a deliberate "draw at half scale" design; reproduced byte-for-byte
 *  here rather than silently "corrected" to a full-size draw, per this
 *  codebase's own established preserve-real-quirks policy (see e.g.
 *  cgame/host.ts's kfont line-height doc comment for the same policy
 *  applied elsewhere). hud_width/hud_height are `viddef.width`/
 *  `viddef.height` directly -- this port's SCR_UpdateScreen never applies
 *  q2repro's own scr.hud_scale/R_SetScale wrapping (no SCR_Draw2D
 *  equivalent exists here), so there is no separate scaled "hud" surface to
 *  distinguish from the real one. */
export function SCR_DrawPOIs(): void {
  if (!re) return;
  if (!scr_pois || !scr_pois.value) return;

  const hudWidth = viddef.width;
  const hudHeight = viddef.height;
  const maxHeight = hudHeight * 0.75;
  const maxScale = scr_poi_max_scale ? scr_poi_max_scale.value : 1.0;
  const edgeFrac = scr_poi_edge_frac ? scr_poi_edge_frac.value : 0.15;

  const forward = vec3();
  const right = vec3();
  const up = vec3();
  AngleVectors(cl.predicted_angles, forward, right, up);

  const tanX = Math.tan((cl.refdef.fov_x * Math.PI) / 360);
  const tanY = Math.tan((cl.refdef.fov_y * Math.PI) / 360);

  for (const poi of scr_pois_store) {
    if (poi.time <= cl.time) continue;
    if (!poi.imageName || (!poi.width && !poi.height)) continue;

    const rel = vec3();
    VectorSubtract(poi.position, cl.refdef.vieworg, rel);
    const xView = DotProduct(rel, right);
    const yView = DotProduct(rel, up);
    const zView = DotProduct(rel, forward); // the C's `sp[3]` pre-divide

    const behind = zView < 0;

    let spX: number;
    let spY: number;
    if (zView !== 0 && tanX !== 0 && tanY !== 0) {
      const invW = 1 / zView;
      const ndcX = (xView * invW) / tanX;
      const ndcY = (yView * invW) / tanY;
      spX = (ndcX * 0.5 + 0.5) * hudWidth;
      spY = (-ndcY * 0.5 + 0.5) * hudHeight;
    } else {
      spX = hudWidth / 2;
      spY = hudHeight / 2;
    }

    if (behind) {
      spX = hudWidth - spX;
      spY = hudHeight - spY;
      if (spY > 0) {
        spX = spX < hudWidth / 2 ? 0 : hudWidth - 1;
        spY = Math.min(spY, maxHeight);
      }
    }

    // scale the icon if they are closer to the edges of the screen
    let scale = 1.0;
    if (maxScale !== 1.0) {
      const edgeDist = Math.min(hudWidth, hudHeight) * edgeFrac;
      for (let axis = 0; axis < 2; axis++) {
        const extent = axis === 0 ? hudWidth : hudHeight;
        const coord = axis === 0 ? spX : spY;
        let frac: number | null = null;
        if (coord < edgeDist) frac = coord / edgeDist;
        else if (coord > extent - edgeDist) frac = (extent - coord) / edgeDist;
        if (frac === null) continue;
        scale = clipf(1.0 + (1.0 - frac) * (maxScale - 1.0), scale, maxScale);
      }
    }

    // center & clamp -- see this function's own doc comment: hw/hh are
    // HALF the scaled size, and both the centering and the clamp bound
    // deliberately reuse that half value (preserved q2repro quirk).
    const hw = Math.trunc((poi.width * scale) / 2);
    const hh = Math.trunc((poi.height * scale) / 2);

    let drawX = spX - hw;
    let drawY = spY - hh;
    drawX = clipf(drawX, 0, hudWidth - hw);
    drawY = clipf(drawY, 0, hudHeight - hh);

    const packed = d_8to24table[poi.color & 0xff] ?? 0;
    let alpha = 255;
    if (poi.flags & POI_FLAG_HIDE_ON_AIM) {
      const cx = hudWidth / 2 - drawX;
      const cy = hudHeight / 2 - drawY;
      const len = Math.sqrt(cx * cx + cy * cy);
      alpha = Math.round(255 * clipf(len / (hw * 6 || 1), 0.25, 1.0));
    }

    const color: DrawColorT = {
      r: packed & 0xff,
      g: (packed >>> 8) & 0xff,
      b: (packed >>> 16) & 0xff,
      a: alpha,
    };

    re.DrawColorPic(Math.trunc(drawX), Math.trunc(drawY), hw, hh, poi.imageName, color);
  }
}

/** Test-only reset -- mirrors SCR_ClearCenterPrint's own precedent just
 *  above (module-private queue/store state a test file needs to zero
 *  between cases without reaching into this file's internals directly). */
export function SCR_ClearDamageAndPOIs(): void {
  for (const entry of scr_damage_entries) {
    entry.damage = 0;
    entry.time = 0;
    entry.color = vec3();
    entry.dir = vec3();
  }
  for (const poi of scr_pois_store) {
    poi.id = 0;
    poi.time = 0;
    poi.imageName = "";
  }
  scr_help_path_markers = [];
}

// -----------------------------------------------------------------------
// Help path (tent.c:477-502's CL_AddHelpPath) -- ADAPTED, not a byte-for-
// byte port. The real function spawns a chain of `ex_marker`-typed
// explosion_t entries (cl_tent.c's own explosion pool: CL_AllocExplosion,
// a `models/.../marker` md2 model at scale 2.5, RF_MINLIGHT|RF_TRANSLUCENT)
// that ride the normal 3D entity refresh. Neither the explosion pool nor
// an `ex_marker` ExptypeT variant exist in this port's cl_tent.ts (checked:
// its own ExptypeT enum has ex_free/explosion/misc/flash/mflash/poly/poly2
// only) -- and cl_tent.ts is explicitly out of this unit's territory
// (queued unit; see this file's own task report). Reproducing the C exactly
// would mean adding a new explosion type AND its CL_AddTEnts render-loop
// case there, which this unit may not touch.
//
// Adapted instead: the same waypoint stream (position + direction + "first
// of a new path" reset flag) is stored here, then submitted into the 3D
// scene as plain particles via cl_view.ts's already-public V_AddParticle
// (that file's own existing scene-building primitive, called once per
// frame from V_RenderView right after CL_AddEntities -- see cl_view.ts's
// SCR_AddHelpPathMarkers call site) instead of a textured/lit marker model.
// This keeps the waypoint trail's actual signal (a visible breadcrumb path
// through the world leading toward the compass objective) without touching
// cl_tent.ts's explosion pool or ExptypeT enum. Reported deviation, not a
// silent one.
// -----------------------------------------------------------------------

export interface ScrHelpPathMarkerT {
  position: Vec3;
  dir: Vec3;
}

const MAX_HELP_PATH_MARKERS = 64;
let scr_help_path_markers: ScrHelpPathMarkerT[] = [];

/** Routed from cl_parse.ts's svc_help_path case (readHelpPathKex). `first`
 *  clears any previous path before adding this waypoint, matching
 *  tent.c:479-489's own "if (first) free every ex_marker" reset. The
 *  origin's `+16` Z offset matches tent.c:493's own `ex->ent.origin[2] +=
 *  16.0f;` (lifts the marker up off the floor). */
export function SCR_AddHelpPath(origin: Vec3, dir: Vec3, first: boolean): void {
  if (first) scr_help_path_markers = [];
  if (scr_help_path_markers.length >= MAX_HELP_PATH_MARKERS) scr_help_path_markers.shift();
  scr_help_path_markers.push({ position: vec3(origin[0], origin[1], origin[2] + 16.0), dir: vec3(dir[0], dir[1], dir[2]) });
}

/** Read-only accessor for cl_view.ts's per-frame V_AddParticle submission
 *  loop (SCR_AddHelpPathMarkers there) -- kept here since the STORE lives
 *  in this file (this unit's own territory split: cl_scrn.ts owns state,
 *  cl_ents-adjacent code it also owns -- cl_view.ts -- owns the per-frame
 *  scene submission, since that is where V_AddParticle already lives). */
export function SCR_GetHelpPathMarkers(): readonly ScrHelpPathMarkerT[] {
  return scr_help_path_markers;
}

/*
=================
SCR_DrawSeatViews

The local-splitscreen replacement for the single
SCR_CalcVrect/SCR_TileClear/V_RenderView/CG_DrawHUD sequence: one 3D pass and
one HUD pass per seat, each into its own sub-rect of the frame.

`cl.refdef.x/y/width/height` is already a sub-rect descriptor -- it is how
`viewsize` below 100 has always worked, and both renderers honor it
(ref_gl's R_SetupGL issues the matching glViewport/glScissor, gl_rmain.ts:
685-693; ref_soft derives its span rasterizer's vrect from the same fields).
Splitting the screen therefore needs no renderer change at all: it needs the
right rect per pass, the right playerstate per pass, and the background
cleared once so the gutters between panes do not hold last frame's pixels.

WHAT IS PER-SEAT AND WHAT IS NOT
  per-seat: the 3D view (rect, origin, angles, fov, blend, view weapon,
    which body is hidden), the cgame HUD (its own hud_vrect, its own
    isplit HUD-state slot, its own playernum's stats) and the engine
    centerprint queue (its own isplit slot, drawn in its own pane -- see
    SCR_CenterPrintSeat).
  once per frame, seat 0's: the carousel/weapon wheel, the net icon, the
    debug graphs and the pause pic. These are connection-level or
    input-level chrome, and the reference API agrees about the direction --
    the 2023 cgame gates its own chat input line on `if (isplit == 0)`
    ("only the main player can really chat anyways", cg_screen.cpp:202).
=================
*/
function SCR_DrawSeatViews(separation: number): void {
  if (!re) return;

  const seats = CL_Seats_Viewports();

  // The panes tile the display except for the few pixels each one gives up
  // to SCR_CalcVrect's own width/height alignment (see cl_seats.ts's
  // alignRect). Those gutters are never drawn into by any pass, so without
  // this they would hold whatever was in the framebuffer last frame. Filling
  // once, before any pane renders, also gives the split a visible divider.
  re.DrawFill(0, 0, viddef.width, viddef.height, 0);

  let drawn = 0;
  for (let seat = 0; seat < seats.length && seat < CL_Seats_Count(); seat++) {
    const rect = seats[seat];
    const ps = CL_Seats_PlayerState(seat);
    if (!ps) continue;
    drawn++;

    scr_vrect.x = rect.x;
    scr_vrect.y = rect.y;
    scr_vrect.width = rect.width;
    scr_vrect.height = rect.height;

    // Seat 0 renders through the ordinary predicted/interpolated path (a
    // null override); every other seat renders from its live server
    // playerstate -- see cl_ents.ts's CL_SetSeatView. `viewheight` is that
    // seat's own crouch-transition ease, kept in cl_seats.ts because
    // cl.current_viewheight/cl.viewheight_change_time are seat 0's.
    CL_SetSeatView(seat === 0 ? null : { ps, playernum: CL_Seats_Playernum(seat), viewheight: CL_Seat_ViewHeight(seat, ps.pmove.viewheight, cl.time) });
    V_RenderView(separation);

    re.SetGifBeatSeconds(cl.time / 1000);
    CG_DrawHUDForSeat(CL_Seats_Playernum(seat), ps, { isplit: seat, x: rect.x, y: rect.y, width: rect.width, height: rect.height });

    // The seat's own engine centerprint queue (classic ruleset; under kex the
    // cgame drew hud_data[isplit]'s inside CG_DrawHUDForSeat just above).
    // Seat 0's is drawn with the rest of the connection-level chrome in
    // SCR_UpdateScreen, after every pane has rendered.
    if (seat !== 0) SCR_CheckDrawCenterStringSeat(seat);
  }

  // Never leave the override installed: every other consumer of
  // CL_CalcViewValues/CL_AddPacketEntities in this process (sound
  // spatialization, the next frame's seat 0 pass) must see the ordinary
  // client again.
  CL_SetSeatView(null);

  // A pane that never drew is a seat whose playerstate the server is not
  // providing -- worth a one-shot report rather than a silently black
  // quarter of the screen.
  if (drawn !== reported_drawn_seats) {
    reported_drawn_seats = drawn;
    Com_DPrintf("splitscreen: %i of %i viewports drawn (state %i, prepped %i)\n", drawn, CL_Seats_Count(), cls.state, cl.refresh_prepped ? 1 : 0);
  }
}

let reported_drawn_seats = -1;

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

  // [item 3] menu music -- q2repro's OGG_Play() (src/client/sound/ogg.c:
  // 238-289) is called from many sites (CL_Disconnect, boot, refresh
  // restart, etc., see this file's own task report for the full list) and
  // picks ogg_menu_track vs. the server's CS_CDTRACK based on
  // `cls.state < ca_connected`; it is itself idempotent (`if
  // (!Q_stricmp(ogg.autotrack, s)) return;` -- ogg.c:257-258) so calling it
  // from many places is cheap. This port's CS_CDTRACK-driven half already
  // has its own call site (cl_view.ts's CL_PrepRefresh: `CDAudio_Play(
  // parseInt(cl.configstrings[CS_CDTRACK]...` -- reached once actually
  // connected/precached), but the disconnected/menu half never had one
  // (platform/cd_ogg.ts's own registerCdCvars() doc comment flagged this
  // exact gap: "ogg_menu_track needs a disconnected-state call site
  // (cl_view.ts/cl_main.ts, out of this unit's territory)"). Reproduced
  // here as a per-frame check instead of a one-shot state-transition hook
  // in cl_main.ts's CL_Disconnect (which this unit may not touch): this
  // function already runs every frame regardless of cls.state, and
  // CDAudio_Play's own `if (currentTrack === track && vf) { ...; return;
  // }` early-return (cd_ogg.ts:183-186) makes a per-frame call exactly as
  // cheap as OGG_Play's own many-call-site pattern -- it only actually
  // re-opens a file when the track genuinely changes (e.g. on the real
  // disconnect transition, or connecting when this branch stops running).
  // Deliberately narrow: this ONLY covers the ogg_menu_track branch --
  // the CS_CDTRACK branch stays exactly where it already was, so the two
  // never race over which track should be playing.
  if (cls.state < ConnstateT.ca_connected) {
    if (!ogg_menu_track) ogg_menu_track = Cvar_Get("ogg_menu_track", "77", CVAR_ARCHIVE);
    if (ogg_menu_track) CDAudio_Play(ogg_menu_track.value, true);
  }

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
    // Animated-GIF frame selection default: menu/console context
    // (cls.realtime-derived seconds). The in-game 3D-refresh branch below
    // switches this to cl.time-derived seconds right before its own HUD/2D
    // draws, then switches back before SCR_DrawConsole/M_Draw -- see
    // ref.ts's RefExports.SetGifBeatSeconds doc comment for the full
    // design (Mike's ruling, qcommon/gif_beat.ts).
    re.SetGifBeatSeconds(cls.realtime / 1000);

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

      if (CL_Seats_Active()) {
        // LOCAL SPLITSCREEN (src/client/cl_seats.ts): one refdef pass and one
        // HUD pass per seat, inside the SAME BeginFrame/EndFrame pair the
        // single-viewport path already uses -- the identical shape the
        // stereo branch above this loop uses for its two passes, which is
        // the only precedent this engine has for more than one RenderFrame
        // per screen update (no reference engine renders a split at all;
        // see cl_seats.ts's header).
        SCR_DrawSeatViews(separation[i]);
      } else {
        // do 3D refresh drawing, and then update the screen
        SCR_CalcVrect();

        // clear any dirty part of the background
        SCR_TileClear();

        V_RenderView(separation[i]);

        // In-game 2D draws (HUD/carousel/wheel/net/center-string/pause) use
        // cl.time-derived seconds -- see this function's own BeginFrame-side
        // comment above.
        re.SetGifBeatSeconds(cl.time / 1000);

        // Routed through the cgame host (src/client/cgame/host.ts) rather
        // than calling SCR_DrawStats/SCR_DrawLayout/CL_DrawInventory directly
        // -- the active cgame's DrawHUD (classic.ts + classic_hud.ts, today)
        // makes those same three calls under the same conditions; see those
        // files for the (now real, no longer pass-through) implementation.
        // ARCHITECTURE.md phase 4 ("cgame host, two built-in cgames").
        CG_DrawHUD();
      }

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

      // Back to menu/console context (cls.realtime-derived seconds) for
      // the console/menu draws below -- same rationale as the BeginFrame-
      // side comment above.
      re.SetGifBeatSeconds(cls.realtime / 1000);

      SCR_DrawConsole();

      M_Draw();

      SCR_DrawLoading();
    }
  }
  if (re) re.EndFrame();
}
