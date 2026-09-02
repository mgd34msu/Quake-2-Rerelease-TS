// cg_screen.cpp (2023 Quake II re-release / "KEX" engine, 1,779 lines).
// Ported from ~/Projects/quake2-rerelease-dll/rerelease/cg_screen.cpp.
//
// This is the whole KEX cgame-side HUD: the layout-string interpreter
// (CG_ExecuteLayoutString -- the status bar / svc_layout / centerprint
// language), stat-driven number/field rendering, the notify/chat line list,
// the typewriter centerprint effect, the inventory grid, and the top-level
// CG_DrawHUD/CG_TouchPics/CG_InitScreen entry points GetCGameAPI (cg_main.ts)
// wires up.
//
// SCOPE FINDING (read against the task brief): the brief describes this file
// as covering "weapon wheel data plumbing, POI/compass drawing, damage
// indicators, hit markers, crosshair names" in addition to the HUD/
// layout/centerprint/notify material. Having read all 1,779 lines end to
// end, NONE of that first group of features exists in this file --
// grepping the full source for "compass", "POI", "crosshair",
// "damage_indicator"/"HitMarker" returns zero matches. The weapon-wheel
// *data* functions (GetActiveWeaponWheelWeapon and friends) are real, but
// they live in cg_main.cpp (ported in ./cg_main.ts), and are pure stat
// reads with no drawing code anywhere in the two files handed to this unit.
// Whatever renders the wheel/compass/hit-marker UI in the real rerelease
// lives in a cg_*.cpp this port was not given (not in the SOURCES list) --
// most likely a separate wheel/compass translation unit. Nothing here was
// skipped; it was never present in the provided sources.
//
// ============================================================================
// HOST PRIMITIVE DEGRADATION (per-call notes; see also host.ts's own
// TODO(phase 7) markers on the underlying stubs)
// ============================================================================
// Every draw call below goes through `CGI()` (the cgame import table --
// see ./cg_local.ts), the SAME table the classic cgame's pass-through
// already uses. Several members are still stubs in
// src/client/cgame/host.ts's buildCgameImports(); this port does not touch
// those stubs (out of scope: "structure and data flow port now, missing
// draw primitives degrade visually not crashingly"). Concretely, with
// today's stubs:
//   - SCR_DrawFontString / SCR_DrawColorPic / SCR_SetAltTypeface: no-ops.
//     Every kfont-drawn HUD string (the scr_usekfont=1 default path),
//     every notify/centerprint accessibility contrast bar, and every
//     health-bar/table background fill silently does not render. The
//     non-kfont fallback path (CG_DrawString / SCR_DrawChar) still draws
//     via the real re.DrawChar, so plain-ASCII HUD text has a working
//     fallback if scr_usekfont is forced to 0.
//   - SCR_MeasureFontString: always returns {x:0,y:0}. Every "center this
//     kfont string" / "right-align this kfont string" / column-width
//     computation in CG_DrawTable degrades to flush-left placement at
//     zero measured width -- visually wrong, not a crash.
//   - SCR_FontLineHeight: always returns 0. font_y_offset (CG_TouchPics)
//     becomes a small negative constant; "health_bars"'s per-bar Y advance
//     via this call collapses to 0 (bars overlap at the same Y instead of
//     stacking) -- degraded layout, not a crash.
//   - Draw_RegisterPic / Draw_GetPicSize: register returns false, size
//     returns {0,0}. Every stat-driven pic/number-field glyph
//     (CG_DrawField's sb_nums, "pic"/"picn"/"client"/"dogtag"/inventory
//     background) draws as a 0x0 SCR_DrawPic -- invisible, not a crash
//     (SCR_DrawPic itself is real and forwards to re.DrawStretchPic, which
//     tolerates a zero-size rect).
//   - CL_GetTextInput: always returns false. The isplit==0 say/say_team
//     input-echo line in CG_DrawNotify never draws; harmless (matches
//     q2repro's own upstream FIXME on this exact import, cited in
//     host.ts).
//   - CL_GetWarnAmmoCount: always returns 0. "anum"'s min_ammo falls back
//     to the same hardcoded 5 threshold q2repro documents as "back
//     compat" -- this one is NOT a degradation, it's the source's own
//     documented fallback path and happens to be exercised unconditionally
//     today.
//   - Localize: returns the base string unlocalized (host.ts's own
//     TODO(phase 7)). Every loc_* token displays its raw key/format
//     string instead of localized text -- readable, not a crash.
//   - SCR_DrawBind: always returns 0. Centerprint keybind prompt lines
//     advance the cursor by 0 instead of a real glyph height; harmless.
//
// ============================================================================
// PROTOCOL-VERSION GUARD (stat_string / loc_stat_* config-string remap)
// ============================================================================
// Five call sites (`stat_string`, `loc_stat_string`, `loc_stat_rstring`,
// `loc_stat_cstring`, `loc_stat_cstring2`) guard a legacy index remap behind
// `cgi.CL_ServerProtocol() <= PROTOCOL_VERSION_3XX`, then call `CS_REMAP()`.
// `CL_ServerProtocol()` is a host.ts stub that unconditionally returns `0`
// (TODO phase 5, protocol layer) -- which WOULD satisfy `0 <= 34` on every
// single call today. `CS_REMAP()` itself is unported BEHAVIOR (not a type;
// kexapi/game.ts's file header explicitly calls out "the two functions are
// not [ported] ... behavior, out of scope for a types-only port"). Rather
// than mis-remapping every stat_string/loc_stat_* index against a
// not-yet-meaningful protocol-version stub, `shouldRemapLegacyConfigstring()`
// below hardcodes this branch to `false` until real protocol negotiation
// (CL_ServerProtocol) and a real CS_REMAP() port both land -- see that
// function's own comment.
//
// ============================================================================
// ENCODING ADAPTATION: FindStartOfUTF8Codepoint / FindEndOfUTF8Codepoint
// ============================================================================
// The C++ originals scan raw UTF-8 BYTES, skipping continuation bytes
// (`(ch & 0xC0) == 0x80`) to avoid splitting a multi-byte glyph mid-typewriter
// -reveal or mid-line-wrap. JS strings are UTF-16 code-unit sequences, not
// UTF-8 byte sequences -- there is no byte-identical port. The adapted
// versions below apply the same *policy* (never stop mid-codepoint) to the
// UTF-16 equivalent hazard: a low surrogate (the second half of an
// astral-plane character's surrogate pair). For the overwhelmingly common
// case of BMP-only text (every stock Quake II HUD/centerprint string), each
// UTF-16 code unit is already one whole codepoint, so this reduces to
// identical behavior; only game text containing astral-plane characters
// (e.g. certain emoji) would observe a difference from true byte-for-byte
// UTF-8 scanning, and no such text exists in the base game.
//
// ============================================================================
// QUIRKS PORTED VERBATIM (deliberately NOT cleaned up -- see citations)
// ============================================================================
// - "lives_num" (cg_screen.cpp:1006-1015): its `if` has no closing
//   `continue;`, so execution falls into the very next `if (!strcmp(token,
//   "hnum"))` check using whatever token "lives_num" last consumed (its stat
//   index argument) -- never actually matches "hnum", so this is an inert
//   wasted comparison, not a functional bug. Ported as literally-adjacent
//   `if` statements (not `else if`) with no `continue` after the "lives_num"
//   block, reproducing the exact fallthrough.
// - "time_limit" (1427-1451), "dogtag" (1454-1467), "start_table"
//   (1469-1496), "table_row" (1498-1531), "draw_table" (1533-1553): none of
//   these five blocks end with `continue;` either, so each one falls through
//   into every following token check for the rest of that loop iteration
//   (again using a stale, non-matching `token` value -- inert). Ported with
//   the same missing `continue`s, in the same order.
// - "loc_string" is checked TWICE: once alone (1334-1361, WITH `continue`),
//   and again later folded into `loc_string2 || loc_rstring2 || loc_string ||
//   loc_rstring` (1387-1424). Because the first check already `continue`s,
//   the second occurrence of "loc_string" in that OR-chain is dead code --
//   a real token can never reach it. Ported as-is (the OR-chain keeps its
//   redundant "loc_string" arm) rather than "fixed", per this port's
//   bug-for-bug mandate.

import {
  type KexPlayerStateT,
  type CgServerDataT,
  type VrectT,
  type RgbaT,
  TextAlignT,
  LayoutFlagsT,
  type LayoutFlagsT as LayoutFlagsNumber,
  rgba_white,
  rgba_black,
  rgba_red,
  rgba_green,
  MAX_CLIENTS,
  MAX_IMAGES,
  MAX_ITEMS,
  MAX_CONFIGSTRINGS,
  MAX_LOCALIZATION_ARGS,
  MAX_SPLIT_PLAYERS,
  CS_IMAGES,
  CS_ITEMS,
  CS_STATUSBAR,
  CS_GENERAL,
  CvarFlagsT,
  MAX_STATS,
} from "../../kexapi/game";
import { PlayerStatT } from "../p_hud";
import type { CvarT } from "../../shared/q_shared";
// COM_Parse comes from ../q_std, which caps tokens at the re-release's 512
// (game.h:122) rather than vanilla's 128 -- see that file's own note.
import { type ComParseState, COM_Parse } from "../q_std";
import { fixedLength } from "../../shared/fixed";
import { CGI, cgame_init_time } from "./cg_local";

// ---------------------------------------------------------------------------
// small per-file helpers (duplicated tiny wrappers -- established idiom;
// see cl_scrn.ts's own atoi/atof and g_target.ts's own cvarInt/cvarFloat)
// ---------------------------------------------------------------------------

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** `cvar_t::integer` -- this port's CvarT has no cached `.integer` field
 *  (kexapi/game.ts's file header); truncate `.value` at every read site,
 *  matching this codebase's established convention (m_medic.ts's
 *  skillValue(), g_target.ts's cvarInt(), etc). */
function CVI(c: CvarT | null): number {
  return c === null ? 0 : Math.trunc(c.value);
}
function CVF(c: CvarT | null): number {
  return c === null ? 0 : c.value;
}

function requirePs(ps: KexPlayerStateT | null, fn: string): KexPlayerStateT {
  if (ps === null) throw new Error(`${fn}: called with a null player_state_t -- the C++ source dereferences it unconditionally here`);
  return ps;
}
function requireData(data: CgServerDataT | null, fn: string): CgServerDataT {
  if (data === null) throw new Error(`${fn}: called with a null cg_server_data_t -- the C++ source dereferences it unconditionally here`);
  return data;
}

// ---------------------------------------------------------------------------
// bg_local.h's reserved general-CS-range offset chain -- recomputed locally.
// Not exported from any shared module today (no bg_local.ts port of that
// anonymous enum exists); g_target.ts and g_spawn.ts both already recompute
// CONFIG_N64_PHYSICS this same way for this same reason (see g_target.ts's
// own "CONFIG_HEALTH_BAR_NAME / CONFIG_STORY -- computed locally, not
// guessed" file-header note for the full derivation citation). Only the two
// entries this file actually reads (HEALTH_BAR_NAME, STORY) are named here.
// ---------------------------------------------------------------------------
const CONFIG_CTF_PLAYER_NAME_END = CS_GENERAL + 2 + MAX_CLIENTS;
const COOP_RESPAWN_TOTAL = 6;
const CONFIG_COOP_RESPAWN_STRING_END = CONFIG_CTF_PLAYER_NAME_END + 1 + (COOP_RESPAWN_TOTAL - 1);
const CONFIG_N64_PHYSICS_INDEX = CONFIG_COOP_RESPAWN_STRING_END + 1;
const CONFIG_HEALTH_BAR_NAME = CONFIG_N64_PHYSICS_INDEX + 1;
const CONFIG_STORY = CONFIG_HEALTH_BAR_NAME + 1;

// ---------------------------------------------------------------------------
// protocol-version guard -- see file header "PROTOCOL-VERSION GUARD"
// ---------------------------------------------------------------------------
function shouldRemapLegacyConfigstring(): boolean {
  return false;
}

// ---------------------------------------------------------------------------
// constants (cg_screen.cpp:5-49)
// ---------------------------------------------------------------------------

const STAT_MINUS = 10; // num frame for '-' stats digit
const sb_nums: string[][] = fixedLength("sb_nums", 2, [
  fixedLength("sb_nums row", 11, ["num_0", "num_1", "num_2", "num_3", "num_4", "num_5", "num_6", "num_7", "num_8", "num_9", "num_minus"]),
  fixedLength("sb_nums row", 11, ["anum_0", "anum_1", "anum_2", "anum_3", "anum_4", "anum_5", "anum_6", "anum_7", "anum_8", "anum_9", "anum_minus"]),
]);

const CHAR_WIDTH = 16;
const CONCHAR_WIDTH = 8;

let font_y_offset = 0;

const alt_color: RgbaT = { r: 112, g: 255, b: 52, a: 255 };

let scr_usekfont: CvarT | null = null;
let scr_centertime: CvarT | null = null;
let scr_printspeed: CvarT | null = null;
let cl_notifytime: CvarT | null = null;
let scr_maxlines: CvarT | null = null;
let ui_acc_contrast: CvarT | null = null;
let ui_acc_alttypeface: CvarT | null = null;
let cl_skipHud: CvarT | null = null;
let cl_paused: CvarT | null = null;

// hud_temp -- static temp data used for hud (cg_screen.cpp:32-44)
const HUD_TEMP_ROWS = 11; // just enough to store 8 levels + header + total (+ one slack)
const HUD_TEMP_COLS = 6;
interface HudTempT {
  table_rows: { table_cells: { text: string }[] }[];
  column_widths: number[];
  num_rows: number;
  num_columns: number;
}
const hud_temp: HudTempT = {
  table_rows: Array.from({ length: HUD_TEMP_ROWS }, () => ({ table_cells: Array.from({ length: HUD_TEMP_COLS }, () => ({ text: "" })) })),
  column_widths: new Array(HUD_TEMP_COLS).fill(0) as number[],
  num_rows: 0,
  num_columns: 0,
};

// ---------------------------------------------------------------------------
// centerprint / notify state (cg_screen.cpp:46-107)
// ---------------------------------------------------------------------------

const MAX_CENTER_PRINTS = 4;
const MAX_NOTIFY = 8;

interface CenterPrintBindT {
  bind: string;
  purpose: string;
}

interface CenterPrintT {
  binds: CenterPrintBindT[];
  lines: string[];
  instant: boolean; // don't type out
  current_line: number; // current line we're typing out
  line_count: number; // codepoint count to draw on current line
  finished: boolean; // done typing it out
  time_tick: number; // time to reveal next char at
  time_off: number; // time to remove at
}

interface NotifyEntryT {
  message: string; // utf8 message
  is_active: boolean; // filled or not
  is_chat: boolean; // green or not
  time: number; // rotate out when < CL_ClientTime()
}

interface HudDataT {
  centers: CenterPrintT[]; // length MAX_CENTER_PRINTS
  center_index: number | null; // current index we're drawing, or null if none left
  notify: NotifyEntryT[]; // length MAX_NOTIFY
}

function makeCenterPrint(): CenterPrintT {
  return { binds: [], lines: [], instant: false, current_line: 0, line_count: 0, finished: true, time_tick: 0, time_off: 0 };
}
function makeNotifyEntry(): NotifyEntryT {
  return { message: "", is_active: false, is_chat: false, time: 0 };
}
function makeHudData(): HudDataT {
  return {
    centers: Array.from({ length: MAX_CENTER_PRINTS }, makeCenterPrint),
    center_index: null,
    notify: Array.from({ length: MAX_NOTIFY }, makeNotifyEntry),
  };
}

// per-splitscreen client hud storage (cg_screen.cpp:107: `static
// std::array<hud_data_t, MAX_SPLIT_PLAYERS> hud_data;`)
let hud_data: HudDataT[] = Array.from({ length: MAX_SPLIT_PLAYERS }, makeHudData);

// ---------------------------------------------------------------------------
// layout-flag helpers (cg_screen.cpp:68-86)
// ---------------------------------------------------------------------------

function CG_ViewingLayout(ps: KexPlayerStateT): boolean {
  return (ps.stats[PlayerStatT.STAT_LAYOUTS] & (LayoutFlagsT.LAYOUTS_LAYOUT | LayoutFlagsT.LAYOUTS_INVENTORY)) !== 0;
}

function CG_InIntermission(ps: KexPlayerStateT): boolean {
  return (ps.stats[PlayerStatT.STAT_LAYOUTS] & LayoutFlagsT.LAYOUTS_INTERMISSION) !== 0;
}

/** cg_screen.cpp:78-81. Not called anywhere else in this file (parity with
 *  the C source, which also never calls it from cg_screen.cpp itself). */
function CG_HudHidden(ps: KexPlayerStateT): boolean {
  return (ps.stats[PlayerStatT.STAT_LAYOUTS] & LayoutFlagsT.LAYOUTS_HIDE_HUD) !== 0;
}

/** cg_screen.cpp:83-86. Exported: this is `cglobals.LayoutFlags`. */
export function CG_LayoutFlags(psIn: KexPlayerStateT | null): LayoutFlagsNumber {
  const ps = requirePs(psIn, "CG_LayoutFlags");
  return ps.stats[PlayerStatT.STAT_LAYOUTS];
}

// ---------------------------------------------------------------------------
// centerprint / notify clearing (cg_screen.cpp:109-118)
// ---------------------------------------------------------------------------

/** Exported: `cglobals.ClearCenterprint`. */
export function CG_ClearCenterprint(isplit: number): void {
  hud_data[isplit].center_index = null;
}

/** Exported: `cglobals.ClearNotify`. */
export function CG_ClearNotify(isplit: number): void {
  for (const msg of hud_data[isplit].notify) msg.is_active = false;
}

// ---------------------------------------------------------------------------
// notify list (cg_screen.cpp:120-210)
// ---------------------------------------------------------------------------

function CG_Notify_CheckExpire(data: HudDataT): void {
  const cgi = CGI();
  while (data.notify[0].is_active && data.notify[0].time < cgi.CL_ClientTime()) {
    data.notify[0].is_active = false;
    for (let i = 1; i < MAX_NOTIFY; i++) {
      if (data.notify[i].is_active) {
        const tmp = data.notify[i];
        data.notify[i] = data.notify[i - 1];
        data.notify[i - 1] = tmp;
      }
    }
  }
}

function CG_AddNotify(data: HudDataT, msg: string, is_chat: boolean): void {
  const maxLines = CVI(scr_maxlines);
  if (maxLines <= 0) return;

  const max = Math.min(MAX_NOTIFY, maxLines);
  let i = 0;
  for (; i < max; i++) if (!data.notify[i].is_active) break;

  if (i === max) {
    data.notify[0].time = 0;
    CG_Notify_CheckExpire(data);
    i = max - 1;
  }

  data.notify[i].message = msg;
  data.notify[i].is_active = true;
  data.notify[i].is_chat = is_chat;
  data.notify[i].time = CGI().CL_ClientTime() + CVF(cl_notifytime) * 1000;
}

/** Exported: `cglobals.NotifyMessage`. */
export function CG_NotifyMessage(isplit: number, msg: string, is_chat: boolean): void {
  CG_AddNotify(hud_data[isplit], msg, is_chat);
}

function CG_DrawNotify(isplit: number, hud_vrect: VrectT, hud_safe: VrectT, scale: number): void {
  const cgi = CGI();
  const data = hud_data[isplit];

  CG_Notify_CheckExpire(data);

  let y = hud_vrect.y * scale + hud_safe.y;

  cgi.SCR_SetAltTypeface(CVI(ui_acc_alttypeface) !== 0);

  if (CVI(ui_acc_contrast) !== 0) {
    for (const msg of data.notify) {
      if (!msg.is_active || msg.message.length === 0) break;
      const sz = cgi.SCR_MeasureFontString(msg.message, scale);
      const w = sz.x + 10; // extra padding for black bars
      cgi.SCR_DrawColorPic(hud_vrect.x * scale + hud_safe.x - 5, y, w, 15 * scale, "_white", rgba_black);
      y += 10 * scale;
    }
  }

  y = hud_vrect.y * scale + hud_safe.y;
  for (const msg of data.notify) {
    if (!msg.is_active) break;
    cgi.SCR_DrawFontString(msg.message, hud_vrect.x * scale + hud_safe.x, y, scale, msg.is_chat ? alt_color : rgba_white, true, TextAlignT.LEFT);
    y += 10 * scale;
  }

  cgi.SCR_SetAltTypeface(false);

  // draw text input (only the main player can really chat anyways...)
  if (isplit === 0) {
    const inputMsg: [string] = [""];
    const inputTeam: [boolean] = [false];
    if (cgi.CL_GetTextInput(inputMsg, inputTeam)) {
      cgi.SCR_DrawFontString(`${inputTeam[0] ? "say_team" : "say"}: ${inputMsg[0]}`, hud_vrect.x * scale + hud_safe.x, y, scale, rgba_white, true, TextAlignT.LEFT);
    }
  }
}

// ---------------------------------------------------------------------------
// CG_DrawHUDString (cg_screen.cpp:212-276)
// ---------------------------------------------------------------------------

function CG_DrawHUDString(str: string, x0: number, y0: number, centerwidth: number, xorVal: number, scale: number, shadow = true): number {
  const cgi = CGI();
  const useKfont = CVI(scr_usekfont) !== 0;
  const margin = x0;
  let x = x0;
  let y = y0;
  let i = 0;

  while (i < str.length) {
    // scan out one line of text from the string
    let line = "";
    let width = 0;
    while (i < str.length && str[i] !== "\n") {
      line += str[i];
      i++;
      width++;
    }

    let size = { x: 0, y: 0 };
    if (useKfont) size = cgi.SCR_MeasureFontString(line, scale);

    if (centerwidth) {
      x = useKfont ? margin + Math.trunc((centerwidth - size.x) / 2) : margin + Math.trunc((centerwidth - width * CONCHAR_WIDTH * scale) / 2);
    } else {
      x = margin;
    }

    if (!useKfont) {
      for (let j = 0; j < width; j++) {
        cgi.SCR_DrawChar(x, y, scale, line.charCodeAt(j) ^ xorVal, shadow);
        x += CONCHAR_WIDTH * scale;
      }
    } else {
      cgi.SCR_DrawFontString(line, x, y - font_y_offset * scale, scale, xorVal ? alt_color : rgba_white, true, TextAlignT.LEFT);
      x += size.x;
    }

    if (i < str.length) {
      i++; // skip the \n
      x = margin;
      y += useKfont ? 10 * scale : CONCHAR_WIDTH * scale;
    }
  }

  return x;
}

// ---------------------------------------------------------------------------
// UTF-8/UTF-16 codepoint-boundary scan -- see file header "ENCODING
// ADAPTATION" (cg_screen.cpp:279-339)
// ---------------------------------------------------------------------------

const NPOS = -1;

function isLowSurrogate(cu: number): boolean {
  return cu >= 0xdc00 && cu <= 0xdfff;
}

/** Not called anywhere else in this file (parity with the C source, which
 *  also defines but never calls it from cg_screen.cpp itself). */
function FindStartOfUTF8Codepoint(str: string, pos: number): number {
  if (pos >= str.length) return NPOS;
  for (let i = pos; i >= 0; i--) {
    if (!isLowSurrogate(str.charCodeAt(i))) return i;
  }
  return NPOS;
}

function FindEndOfUTF8Codepoint(str: string, pos: number): number {
  if (pos >= str.length) return NPOS;
  for (let i = pos; i < str.length; i++) {
    if (!isLowSurrogate(str.charCodeAt(i))) return i;
  }
  return NPOS;
}

// ---------------------------------------------------------------------------
// centerprint (cg_screen.cpp:341-653)
// ---------------------------------------------------------------------------

/** Exported: `cglobals.NotifyMessage` calls this indirectly via
 *  CG_AddNotify; `CG_NotifyMessage` itself is the export -- see above. This
 *  wrapper (cg_screen.cpp:341-344) is kept for 1:1 structural parity even
 *  though it is a trivial pass-through identical to CG_NotifyMessage. */

function CG_QueueCenterPrint(isplit: number, instant: boolean): CenterPrintT {
  const icl = hud_data[isplit];

  // just use first index
  if (icl.center_index === null || instant) {
    icl.center_index = 0;
    for (let i = 1; i < MAX_CENTER_PRINTS; i++) icl.centers[i].lines = [];
    return icl.centers[0];
  }

  // pick the next free index if we can find one
  for (let i = 1; i < MAX_CENTER_PRINTS; i++) {
    const center = icl.centers[(icl.center_index + i) % MAX_CENTER_PRINTS];
    if (center.lines.length === 0) return center;
  }

  // none, so update the current one (the new end of buffer) and skip ahead
  const center = icl.centers[icl.center_index];
  icl.center_index = (icl.center_index + 1) % MAX_CENTER_PRINTS;
  return center;
}

/** cg_screen.cpp:422-423/452: the decorative console banner surrounding a
 *  centerprint echo -- \x1D, thirty-five \x1E, \x1F (verified against the
 *  source's literal escape count). */
const CENTERPRINT_BANNER = `\n\n\x1d${"\x1e".repeat(35)}\x1f\n\n`;

/** Exported: `cglobals.ParseCenterPrint`. */
export function CG_ParseCenterPrint(str: string, isplit: number, instant: boolean): void {
  const cgi = CGI();

  // handle center queueing
  const center = CG_QueueCenterPrint(isplit, instant);
  center.lines = [];

  // split the string into lines
  center.binds = [];

  // [Paril-KEX] pull out bindings. they'll always be at the start
  let text = str;
  while (text.slice(0, 6) === "%bind:") {
    const endOfBind = text.indexOf("%", 1);
    if (endOfBind === -1) break;

    const bind = text.slice(6, endOfBind);
    const purposeIndex = bind.indexOf(":");
    if (purposeIndex !== -1) {
      center.binds.push({ bind: bind.slice(0, purposeIndex), purpose: bind.slice(purposeIndex + 1) });
    } else {
      center.binds.push({ bind, purpose: "" });
    }

    text = text.slice(endOfBind + 1);
  }

  // echo it to the console
  cgi.Com_Print(CENTERPRINT_BANNER);

  {
    // scan the width of the line (max 40 cols), center-pad, print
    let sIdx = 0;
    for (;;) {
      let l = 0;
      while (l < 40 && sIdx + l < text.length && text[sIdx + l] !== "\n") l++;

      const pad = " ".repeat(Math.trunc((40 - l) / 2));
      cgi.Com_Print(`${pad}${text.slice(sIdx, sIdx + l)}\n`);

      let scan = sIdx;
      while (scan < text.length && text[scan] !== "\n") scan++;
      if (scan >= text.length) break;
      sIdx = scan + 1; // skip the \n
    }
  }
  cgi.Com_Print(CENTERPRINT_BANNER);
  CG_ClearNotify(isplit);

  let lineStart = 0;
  for (let lineEnd = 0; ; ) {
    lineEnd = FindEndOfUTF8Codepoint(text, lineEnd);

    if (lineEnd === NPOS) {
      // final line
      if (lineStart < text.length) center.lines.push(text.slice(lineStart));
      break;
    }

    const ch = text[lineEnd];

    if (ch === "\n") {
      if (lineEnd > lineStart) center.lines.push(text.slice(lineStart, lineEnd));
      else center.lines.push("");
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

  center.time_tick = cgi.CL_ClientRealTime() + CVF(scr_printspeed) * 1000;
  center.instant = instant;
  center.finished = false;
  center.current_line = 0;
  center.line_count = 0;
}

function CG_DrawCenterString(ps: KexPlayerStateT, hud_vrect: VrectT, hud_safe: VrectT, isplit: number, scale: number, center: CenterPrintT): void {
  const cgi = CGI();

  let y = hud_vrect.y * scale;

  if (CG_ViewingLayout(ps)) y += hud_safe.y;
  else if (center.lines.length <= 4) y += hud_vrect.height * 0.2 * scale;
  else y += 48 * scale;

  let lineHeight = (CVI(scr_usekfont) !== 0 ? 10 : 8) * scale;
  if (CVI(ui_acc_alttypeface) !== 0) lineHeight *= 1.5;

  // easy!
  if (center.instant) {
    for (const line of center.lines) {
      cgi.SCR_SetAltTypeface(CVI(ui_acc_alttypeface) !== 0);

      if (CVI(ui_acc_contrast) !== 0 && line.length > 0) {
        const sz = cgi.SCR_MeasureFontString(line, scale);
        const w = sz.x + 10;
        const barY = CVI(ui_acc_alttypeface) !== 0 ? y - 8 : y;
        cgi.SCR_DrawColorPic((hud_vrect.x + hud_vrect.width / 2) * scale - w / 2, barY, w, lineHeight, "_white", rgba_black);
      }
      CG_DrawHUDString(line, (hud_vrect.x + hud_vrect.width / 2 - 160) * scale, y, (320 / 2) * 2 * scale, 0, scale);

      cgi.SCR_SetAltTypeface(false);

      y += lineHeight;
    }

    for (const bind of center.binds) {
      y += lineHeight * 2;
      cgi.SCR_DrawBind(isplit, bind.bind, bind.purpose, (hud_vrect.x + hud_vrect.width / 2) * scale, y, scale);
    }

    if (!center.finished) {
      center.finished = true;
      center.time_off = cgi.CL_ClientRealTime() + CVF(scr_centertime) * 1000;
    }

    return;
  }

  // hard and annoying!
  const t = cgi.CL_ClientRealTime();

  if (!center.finished) {
    if (center.time_tick < t) {
      center.time_tick = t + CVF(scr_printspeed) * 1000;
      center.line_count = FindEndOfUTF8Codepoint(center.lines[center.current_line], center.line_count + 1);

      if (center.line_count === NPOS) {
        center.current_line++;
        center.line_count = 0;

        if (center.current_line === center.lines.length) {
          center.current_line--;
          center.finished = true;
          center.time_off = t + CVF(scr_centertime) * 1000;
        }
      }
    }
  }

  for (let i = 0; i < center.lines.length; i++) {
    cgi.SCR_SetAltTypeface(CVI(ui_acc_alttypeface) !== 0);

    const line = center.lines[i];
    const buffer = center.finished || i !== center.current_line ? line : line.slice(0, center.line_count);

    let blinkyX: number;

    if (CVI(ui_acc_contrast) !== 0 && line.length > 0) {
      const sz = cgi.SCR_MeasureFontString(line, scale);
      const w = sz.x + 10;
      const barY = CVI(ui_acc_alttypeface) !== 0 ? y - 8 : y;
      cgi.SCR_DrawColorPic((hud_vrect.x + hud_vrect.width / 2) * scale - w / 2, barY, w, lineHeight, "_white", rgba_black);
    }

    if (buffer.length > 0) {
      blinkyX = CG_DrawHUDString(buffer, (hud_vrect.x + hud_vrect.width / 2 - 160) * scale, y, (320 / 2) * 2 * scale, 0, scale);
    } else {
      blinkyX = (hud_vrect.width / 2) * scale;
    }

    cgi.SCR_SetAltTypeface(false);

    if (i === center.current_line && CVI(ui_acc_alttypeface) === 0) {
      cgi.SCR_DrawChar(blinkyX, y, scale, 10 + ((Math.floor(cgi.CL_ClientRealTime() / 256) & 1) as 0 | 1), true);
    }

    y += lineHeight;

    if (i === center.current_line) break;
  }
}

function CG_CheckDrawCenterString(ps: KexPlayerStateT, hud_vrect: VrectT, hud_safe: VrectT, isplit: number, scale: number): void {
  if (CG_InIntermission(ps)) return;
  const data = hud_data[isplit];
  if (data.center_index === null) return;

  // ran out of center time
  const center = data.centers[data.center_index];
  if (center.finished && center.time_off < CGI().CL_ClientRealTime()) {
    center.lines = [];

    const nextIndex = (data.center_index + 1) % MAX_CENTER_PRINTS;
    const nextCenter = data.centers[nextIndex];

    // no more
    if (nextCenter.lines.length === 0) {
      data.center_index = null;
      return;
    }

    // buffer rotated; start timer now
    data.center_index = nextIndex;
    nextCenter.current_line = 0;
    nextCenter.line_count = 0;
  }

  if (data.center_index === null) return;

  CG_DrawCenterString(ps, hud_vrect, hud_safe, isplit, scale, data.centers[data.center_index]);
}

// ---------------------------------------------------------------------------
// CG_DrawString / CG_DrawField / CG_DrawTable (cg_screen.cpp:655-773)
// ---------------------------------------------------------------------------

function CG_DrawString(x0: number, y: number, scale: number, s: string, alt = false, shadow = true): void {
  const cgi = CGI();
  let x = x0;
  for (let i = 0; i < s.length; i++) {
    cgi.SCR_DrawChar(x, y, scale, s.charCodeAt(i) ^ (alt ? 0x80 : 0), shadow);
    x += 8 * scale; // cg_screen.cpp:665: `x+=8*scale`
  }
}

function CG_DrawField(x0: number, y: number, color: number, widthIn: number, value: number, scale: number): void {
  if (widthIn < 1) return;
  const width = widthIn > 5 ? 5 : widthIn;

  const numStr = String(value);
  let l = numStr.length;
  if (l > width) l = width;

  let x = x0 + (2 + CHAR_WIDTH * (width - l)) * scale;

  const cgi = CGI();
  let ptr = 0;
  while (ptr < numStr.length && l > 0) {
    const ch = numStr[ptr];
    const frame = ch === "-" ? STAT_MINUS : ch.charCodeAt(0) - "0".charCodeAt(0);
    const w: [number] = [0];
    const h: [number] = [0];
    cgi.Draw_GetPicSize(w, h, sb_nums[color][frame]);
    cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, sb_nums[color][frame]);
    x += CHAR_WIDTH * scale;
    ptr++;
    l--;
  }
}

function CG_DrawTable(x0: number, y0: number, width: number, height: number, scale: number): void {
  const cgi = CGI();

  // half left
  let x = x0 - width / 2;
  let y = y0 + CONCHAR_WIDTH * scale;

  // draw border
  cgi.SCR_DrawChar(x - CONCHAR_WIDTH * scale, y - CONCHAR_WIDTH * scale, scale, 18, false);
  cgi.SCR_DrawChar(x + width, y - CONCHAR_WIDTH * scale, scale, 20, false);
  cgi.SCR_DrawChar(x - CONCHAR_WIDTH * scale, y + height, scale, 24, false);
  cgi.SCR_DrawChar(x + width, y + height, scale, 26, false);

  for (let cx = x; cx < x + width; cx += CONCHAR_WIDTH * scale) {
    cgi.SCR_DrawChar(cx, y - CONCHAR_WIDTH * scale, scale, 19, false);
    cgi.SCR_DrawChar(cx, y + height, scale, 25, false);
  }
  for (let cy = y; cy < y + height; cy += CONCHAR_WIDTH * scale) {
    cgi.SCR_DrawChar(x - CONCHAR_WIDTH * scale, cy, scale, 21, false);
    cgi.SCR_DrawChar(x + width, cy, scale, 23, false);
  }

  cgi.SCR_DrawColorPic(x, y, width, height, "_white", { r: 0, g: 0, b: 0, a: 255 });

  // draw in columns
  for (let i = 0; i < hud_temp.num_columns; i++) {
    let ry = y;
    for (let r = 0; r < hud_temp.num_rows; r++, ry += (CONCHAR_WIDTH + font_y_offset) * scale) {
      let xOffset = 0;
      const text = hud_temp.table_rows[r].table_cells[i].text;

      if (r === 0) {
        // center
        xOffset = hud_temp.column_widths[i] / 2 - cgi.SCR_MeasureFontString(text, scale).x / 2;
      } else if (i !== 0) {
        // right align
        xOffset = hud_temp.column_widths[i] - cgi.SCR_MeasureFontString(text, scale).x;
      }

      cgi.SCR_DrawFontString(text, x + xOffset, ry - font_y_offset * scale, scale, r === 0 ? alt_color : rgba_white, true, TextAlignT.LEFT);
    }

    x += hud_temp.column_widths[i] + cgi.SCR_MeasureFontString(" ", 1).x;
  }
}

// ---------------------------------------------------------------------------
// layout-string tokenizer helper -- duplicated from cl_scrn.ts's own
// nextLayoutToken (same COM_Parse-end-of-string convention: an
// empty-and-not-a-closed-empty-quote token means the C++ `while (s)` loop
// would have exited because COM_Parse set `s` to null).
// ---------------------------------------------------------------------------

function nextLayoutToken(state: ComParseState): { token: string; done: boolean } {
  const startIndex = state.index;
  const token = COM_Parse(state);
  const closedEmptyQuote = state.index > startIndex && state.data.charAt(state.index - 1) === '"';
  const done = token === "" && !closedEmptyQuote;
  return { token, done };
}

// ---------------------------------------------------------------------------
// CG_ExecuteLayoutString (cg_screen.cpp:775-1628)
// ---------------------------------------------------------------------------

function CG_ExecuteLayoutString(s: string, hud_vrect: VrectT, hud_safe: VrectT, scale: number, playernum: number, ps: KexPlayerStateT): void {
  if (!s || s.length === 0) return;

  const cgi = CGI();

  let x = hud_vrect.x;
  let y = hud_vrect.y;
  let width = 3;

  const hx = 320 / 2;
  const hy = 240 / 2;

  const flash_frame = cgi.CL_ClientTime() % 1000 < 500 ? 1 : 0;

  // if non-zero, parse but don't affect state
  let if_depth = 0; // current if statement depth
  let endif_depth = 0; // at this depth, toggle skip_depth
  let skip_depth = false; // whether we're in a dead stmt or not

  const state: ComParseState = { data: s, index: 0 };

  for (;;) {
    const next = nextLayoutToken(state);
    if (next.done) break;
    const token = next.token;

    if (token === "xl") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) x = (hud_vrect.x + atoi(t)) * scale + hud_safe.x;
      continue;
    }
    if (token === "xr") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) x = (hud_vrect.x + hud_vrect.width + atoi(t)) * scale - hud_safe.x;
      continue;
    }
    if (token === "xv") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) x = (hud_vrect.x + hud_vrect.width / 2 + (atoi(t) - hx)) * scale;
      continue;
    }

    if (token === "yt") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) y = (hud_vrect.y + atoi(t)) * scale + hud_safe.y;
      continue;
    }
    if (token === "yb") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) y = (hud_vrect.y + hud_vrect.height + atoi(t)) * scale - hud_safe.y;
      continue;
    }
    if (token === "yv") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) y = (hud_vrect.y + hud_vrect.height / 2 + (atoi(t) - hy)) * scale;
      continue;
    }

    if (token === "pic") {
      // draw a pic from a stat number
      const t = nextLayoutToken(state).token;
      if (!skip_depth) {
        const value = ps.stats[atoi(t)];
        if (value >= MAX_IMAGES) cgi.Com_Error("Pic >= MAX_IMAGES");

        const pic = cgi.get_configstring(CS_IMAGES + value);
        if (pic && pic.length > 0) {
          const w: [number] = [0];
          const h: [number] = [0];
          cgi.Draw_GetPicSize(w, h, pic);
          cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, pic);
        }
      }
      continue;
    }

    if (token === "client") {
      // draw a deathmatch client block
      const tx = nextLayoutToken(state).token;
      if (!skip_depth) {
        x = (hud_vrect.x + hud_vrect.width / 2 + (atoi(tx) - hx)) * scale;
        x += 8 * scale;
      }
      const ty = nextLayoutToken(state).token;
      if (!skip_depth) {
        y = (hud_vrect.y + hud_vrect.height / 2 + (atoi(ty) - hy)) * scale;
        y += 7 * scale;
      }

      const tv = nextLayoutToken(state).token;
      let value = 0;
      if (!skip_depth) {
        value = atoi(tv);
        if (value >= MAX_CLIENTS || value < 0) cgi.Com_Error("client >= MAX_CLIENTS");
      }

      const tscore = nextLayoutToken(state).token;
      let score = 0;
      if (!skip_depth) score = atoi(tscore);

      const tping = nextLayoutToken(state).token;
      if (!skip_depth) {
        const ping = atoi(tping);

        if (CVI(scr_usekfont) === 0) CG_DrawString(x + 32 * scale, y, scale, cgi.CL_GetClientName(value));
        else cgi.SCR_DrawFontString(cgi.CL_GetClientName(value), x + 32 * scale, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);

        if (CVI(scr_usekfont) === 0) CG_DrawString(x + 32 * scale, y + 10 * scale, scale, `${score}`, true);
        else cgi.SCR_DrawFontString(`${score}`, x + 32 * scale, y + (10 - font_y_offset) * scale, scale, rgba_white, true, TextAlignT.LEFT);

        cgi.SCR_DrawPic(x + 96 * scale, y + 10 * scale, 9 * scale, 9 * scale, "ping");

        if (CVI(scr_usekfont) === 0) CG_DrawString(x + 73 * scale + 32 * scale, y + 10 * scale, scale, `${ping}`);
        else cgi.SCR_DrawFontString(`${ping}`, x + 107 * scale, y + (10 - font_y_offset) * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "ctf") {
      // draw a ctf client block
      const tx = nextLayoutToken(state).token;
      if (!skip_depth) x = (hud_vrect.x + hud_vrect.width / 2 - hx + atoi(tx)) * scale;
      const ty = nextLayoutToken(state).token;
      if (!skip_depth) y = (hud_vrect.y + hud_vrect.height / 2 - hy + atoi(ty)) * scale;

      const tv = nextLayoutToken(state).token;
      let value = 0;
      if (!skip_depth) {
        value = atoi(tv);
        if (value >= MAX_CLIENTS || value < 0) cgi.Com_Error("client >= MAX_CLIENTS");
      }

      const tscore = nextLayoutToken(state).token;
      let score = 0;
      if (!skip_depth) score = atoi(tscore);

      const tping = nextLayoutToken(state).token;
      let ping = 0;
      if (!skip_depth) {
        ping = atoi(tping);
        if (ping > 999) ping = 999;
      }

      const iconToken = nextLayoutToken(state).token;

      if (!skip_depth) {
        const color = value === playernum ? alt_color : rgba_white;
        cgi.SCR_DrawFontString(`${score}`, x, y - font_y_offset * scale, scale, color, true, TextAlignT.LEFT);
        x += 3 * 9 * scale;
        cgi.SCR_DrawFontString(`${ping}`, x, y - font_y_offset * scale, scale, color, true, TextAlignT.LEFT);
        x += 3 * 9 * scale;
        cgi.SCR_DrawFontString(cgi.CL_GetClientName(value), x, y - font_y_offset * scale, scale, color, true, TextAlignT.LEFT);

        if (iconToken.length > 0) {
          const w: [number] = [0];
          const h: [number] = [0];
          cgi.Draw_GetPicSize(w, h, iconToken);
          cgi.SCR_DrawPic(x - (w[0] + 2) * scale, y, w[0] * scale, h[0] * scale, iconToken);
        }
      }
      continue;
    }

    if (token === "picn") {
      // draw a pic from a name
      const name = nextLayoutToken(state).token;
      if (!skip_depth) {
        const w: [number] = [0];
        const h: [number] = [0];
        cgi.Draw_GetPicSize(w, h, name);
        cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, name);
      }
      continue;
    }

    if (token === "num") {
      // draw a number
      const tw = nextLayoutToken(state).token;
      if (!skip_depth) width = atoi(tw);
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        const value = ps.stats[atoi(ti)];
        CG_DrawField(x, y, 0, width, value, scale);
      }
      continue;
    }
    // [Paril-KEX] special handling for the lives number -- NOTE: this
    // branch intentionally has no `continue` (see file header "QUIRKS
    // PORTED VERBATIM"); execution falls into the "hnum" check below with
    // the leftover token from this block.
    if (token === "lives_num") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        const value = ps.stats[atoi(ti)];
        CG_DrawField(x, y, value <= 2 ? flash_frame : 0, 1, Math.max(0, value - 2), scale);
      }
    }

    if (token === "hnum") {
      // health number
      if (!skip_depth) {
        width = 3;
        const value = ps.stats[PlayerStatT.STAT_HEALTH];
        let color: number;
        if (value > 25) color = 0; // green
        else if (value > 0) color = flash_frame; // flash
        else color = 1;

        if (ps.stats[PlayerStatT.STAT_FLASHES] & 1) {
          const w: [number] = [0];
          const h: [number] = [0];
          cgi.Draw_GetPicSize(w, h, "field_3");
          cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, "field_3");
        }

        CG_DrawField(x, y, color, width, value, scale);
      }
      continue;
    }

    if (token === "anum") {
      // ammo number
      if (!skip_depth) {
        width = 3;
        const value = ps.stats[PlayerStatT.STAT_AMMO];

        let minAmmo = cgi.CL_GetWarnAmmoCount(ps.stats[PlayerStatT.STAT_ACTIVE_WEAPON]);
        if (!minAmmo) minAmmo = 5; // back compat

        let color: number;
        if (value > minAmmo) color = 0; // green
        else if (value >= 0) color = flash_frame; // flash
        else continue; // negative number = don't show

        if (ps.stats[PlayerStatT.STAT_FLASHES] & 4) {
          const w: [number] = [0];
          const h: [number] = [0];
          cgi.Draw_GetPicSize(w, h, "field_3");
          cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, "field_3");
        }

        CG_DrawField(x, y, color, width, value, scale);
      }
      continue;
    }

    if (token === "rnum") {
      // armor number
      if (!skip_depth) {
        width = 3;
        const value = ps.stats[PlayerStatT.STAT_ARMOR];
        if (value < 0) continue;

        const color = 0; // green

        if (ps.stats[PlayerStatT.STAT_FLASHES] & 2) {
          const w: [number] = [0];
          const h: [number] = [0];
          cgi.Draw_GetPicSize(w, h, "field_3");
          cgi.SCR_DrawPic(x, y, w[0] * scale, h[0] * scale, "field_3");
        }

        CG_DrawField(x, y, color, width, value, scale);
      }
      continue;
    }

    if (token === "stat_string") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        let index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        index = ps.stats[index];

        if (shouldRemapLegacyConfigstring()) {
          // TODO(phase 5, protocol layer / CS_REMAP port): see file header.
        }

        if (index < 0 || index >= MAX_CONFIGSTRINGS) cgi.Com_Error("Bad stat_string index");
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, cgi.get_configstring(index));
        else cgi.SCR_DrawFontString(cgi.get_configstring(index), x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "cstring") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) CG_DrawHUDString(t, x, y, hx * 2 * scale, 0, scale);
      continue;
    }

    if (token === "string") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) {
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, t);
        else cgi.SCR_DrawFontString(t, x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "cstring2") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) CG_DrawHUDString(t, x, y, hx * 2 * scale, 0x80, scale);
      continue;
    }

    if (token === "string2") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) {
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, t, true);
        else cgi.SCR_DrawFontString(t, x, y - font_y_offset * scale, scale, alt_color, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "if") {
      const t = nextLayoutToken(state).token;
      if_depth++;
      if (!skip_depth && !ps.stats[atoi(t)]) {
        skip_depth = true;
        endif_depth = if_depth;
      }
      continue;
    }

    if (token === "ifgef") {
      const t = nextLayoutToken(state).token;
      if_depth++;
      if (!skip_depth && cgi.CL_ServerFrame() < atoi(t)) {
        skip_depth = true;
        endif_depth = if_depth;
      }
      continue;
    }

    if (token === "endif") {
      if (skip_depth && if_depth === endif_depth) skip_depth = false;
      if_depth--;
      if (if_depth < 0) cgi.Com_Error("endif without matching if");
      continue;
    }

    // localization stuff
    if (token === "loc_stat_string") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        let index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        index = ps.stats[index];
        if (index < 0 || index >= MAX_CONFIGSTRINGS) cgi.Com_Error("Bad stat_string index");
        const localized = cgi.Localize(cgi.get_configstring(index), [], 0);
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, localized);
        else cgi.SCR_DrawFontString(localized, x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "loc_stat_rstring") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        let index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        index = ps.stats[index];
        if (index < 0 || index >= MAX_CONFIGSTRINGS) cgi.Com_Error("Bad stat_string index");
        const localized = cgi.Localize(cgi.get_configstring(index), [], 0);
        if (CVI(scr_usekfont) === 0) CG_DrawString(x - localized.length * CONCHAR_WIDTH * scale, y, scale, localized);
        else {
          const size = cgi.SCR_MeasureFontString(localized, scale);
          cgi.SCR_DrawFontString(localized, x - size.x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
        }
      }
      continue;
    }

    if (token === "loc_stat_cstring") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        let index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        index = ps.stats[index];
        if (index < 0 || index >= MAX_CONFIGSTRINGS) cgi.Com_Error("Bad stat_string index");
        CG_DrawHUDString(cgi.Localize(cgi.get_configstring(index), [], 0), x, y, hx * 2 * scale, 0, scale);
      }
      continue;
    }

    if (token === "loc_stat_cstring2") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        let index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        index = ps.stats[index];
        if (index < 0 || index >= MAX_CONFIGSTRINGS) cgi.Com_Error("Bad stat_string index");
        CG_DrawHUDString(cgi.Localize(cgi.get_configstring(index), [], 0), x, y, hx * 2 * scale, 0x80, scale);
      }
      continue;
    }

    if (token === "loc_cstring") {
      const numArgs = atoi(nextLayoutToken(state).token);
      if (numArgs < 0 || numArgs >= MAX_LOCALIZATION_ARGS) cgi.Com_Error("Bad loc string");

      const base = nextLayoutToken(state).token;
      const args: string[] = [];
      for (let i = 0; i < numArgs; i++) args.push(nextLayoutToken(state).token);

      if (!skip_depth) CG_DrawHUDString(cgi.Localize(base, args, numArgs), x, y, hx * 2 * scale, 0, scale);
      continue;
    }

    if (token === "loc_string") {
      const numArgs = atoi(nextLayoutToken(state).token);
      if (numArgs < 0 || numArgs >= MAX_LOCALIZATION_ARGS) cgi.Com_Error("Bad loc string");

      const base = nextLayoutToken(state).token;
      const args: string[] = [];
      for (let i = 0; i < numArgs; i++) args.push(nextLayoutToken(state).token);

      if (!skip_depth) {
        const localized = cgi.Localize(base, args, numArgs);
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, localized);
        else cgi.SCR_DrawFontString(localized, x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "loc_cstring2") {
      const numArgs = atoi(nextLayoutToken(state).token);
      if (numArgs < 0 || numArgs >= MAX_LOCALIZATION_ARGS) cgi.Com_Error("Bad loc string");

      const base = nextLayoutToken(state).token;
      const args: string[] = [];
      for (let i = 0; i < numArgs; i++) args.push(nextLayoutToken(state).token);

      if (!skip_depth) CG_DrawHUDString(cgi.Localize(base, args, numArgs), x, y, hx * 2 * scale, 0x80, scale);
      continue;
    }

    // See file header "QUIRKS PORTED VERBATIM": "loc_string" here is dead
    // code (the check above always intercepts it first with its own
    // `continue`), kept for parity with the C source's redundant OR-chain.
    if (token === "loc_string2" || token === "loc_rstring2" || token === "loc_string" || token === "loc_rstring") {
      const green = token.endsWith("2");
      const rightAlign = token.startsWith("loc_rstring");
      const numArgs = atoi(nextLayoutToken(state).token);
      if (numArgs < 0 || numArgs >= MAX_LOCALIZATION_ARGS) cgi.Com_Error("Bad loc string");

      const base = nextLayoutToken(state).token;
      const args: string[] = [];
      for (let i = 0; i < numArgs; i++) args.push(nextLayoutToken(state).token);

      if (!skip_depth) {
        const locStr = cgi.Localize(base, args, numArgs);
        let xOffs = 0;
        if (rightAlign) {
          xOffs = CVI(scr_usekfont) !== 0 ? cgi.SCR_MeasureFontString(locStr, scale).x : locStr.length * CONCHAR_WIDTH * scale;
        }

        if (CVI(scr_usekfont) === 0) CG_DrawString(x - xOffs, y, scale, locStr, green);
        else cgi.SCR_DrawFontString(locStr, x - xOffs, y - font_y_offset * scale, scale, green ? alt_color : rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    // draw time remaining -- NOTE: no `continue` (see file header "QUIRKS
    // PORTED VERBATIM").
    if (token === "time_limit") {
      const endFrameTok = nextLayoutToken(state).token;
      if (!skip_depth) {
        const endFrame = atoi(endFrameTok);
        if (endFrame >= cgi.CL_ServerFrame()) {
          const remainingMs = (endFrame - cgi.CL_ServerFrame()) * cgi.frame_time_ms;
          const green = true;
          const mins = String(Math.trunc(remainingMs / 1000 / 60)).padStart(2, "0");
          const secs = String(Math.trunc((remainingMs / 1000) % 60)).padStart(2, "0");
          const locStr = cgi.Localize("$g_score_time", [`${mins}:${secs}`], 1);
          const xOffs = CVI(scr_usekfont) !== 0 ? cgi.SCR_MeasureFontString(locStr, scale).x : locStr.length * CONCHAR_WIDTH * scale;
          if (CVI(scr_usekfont) === 0) CG_DrawString(x - xOffs, y, scale, locStr, green);
          else cgi.SCR_DrawFontString(locStr, x - xOffs, y - font_y_offset * scale, scale, green ? alt_color : rgba_white, true, TextAlignT.LEFT);
        }
      }
    }

    // draw client dogtag -- NOTE: no `continue`.
    if (token === "dogtag") {
      const t = nextLayoutToken(state).token;
      if (!skip_depth) {
        const value = atoi(t);
        if (value >= MAX_CLIENTS || value < 0) cgi.Com_Error("client >= MAX_CLIENTS");
        cgi.SCR_DrawPic(x, y, 198 * scale, 32 * scale, `/tags/${cgi.CL_GetClientDogtag(value)}`);
      }
    }

    // NOTE: no `continue` on any of start_table/table_row/draw_table.
    if (token === "start_table") {
      const t = nextLayoutToken(state).token;
      const value = atoi(t);

      if (!skip_depth) {
        if (value >= hud_temp.table_rows[0].table_cells.length) cgi.Com_Error("table too big");
        hud_temp.num_columns = value;
        hud_temp.num_rows = 1;
        for (let i = 0; i < value; i++) hud_temp.column_widths[i] = 0;
      }

      for (let i = 0; i < value; i++) {
        const cellTok = nextLayoutToken(state).token;
        if (!skip_depth) {
          const localized = cgi.Localize(cellTok, [], 0);
          hud_temp.table_rows[0].table_cells[i].text = localized;
          hud_temp.column_widths[i] = Math.max(hud_temp.column_widths[i], cgi.SCR_MeasureFontString(localized, scale).x);
        }
      }
    }

    if (token === "table_row") {
      const t = nextLayoutToken(state).token;
      const value = atoi(t);

      if (!skip_depth && hud_temp.num_rows >= hud_temp.table_rows.length) {
        cgi.Com_Error("table too big");
      }

      const row = hud_temp.table_rows[hud_temp.num_rows];

      for (let i = 0; i < value; i++) {
        const cellTok = nextLayoutToken(state).token;
        if (!skip_depth) {
          row.table_cells[i].text = cellTok;
          hud_temp.column_widths[i] = Math.max(hud_temp.column_widths[i], cgi.SCR_MeasureFontString(cellTok, scale).x);
        }
      }

      if (!skip_depth) {
        for (let i = value; i < hud_temp.num_columns; i++) row.table_cells[i].text = "";
        hud_temp.num_rows++;
      }
    }

    if (token === "draw_table") {
      if (!skip_depth) {
        let totalInnerTableWidth = 0;
        for (let i = 0; i < hud_temp.num_columns; i++) {
          if (i !== 0) totalInnerTableWidth += cgi.SCR_MeasureFontString(" ", scale).x;
          totalInnerTableWidth += hud_temp.column_widths[i];
        }

        const totalTableHeight = hud_temp.num_rows * (CONCHAR_WIDTH + font_y_offset) * scale;

        CG_DrawTable(x, y, totalInnerTableWidth, totalTableHeight, scale);
      }
    }

    if (token === "stat_pname") {
      const ti = nextLayoutToken(state).token;
      if (!skip_depth) {
        const index = atoi(ti);
        if (index < 0 || index >= MAX_STATS) cgi.Com_Error("Bad stat_string index");
        const clientIndex = ps.stats[index] - 1;
        if (CVI(scr_usekfont) === 0) CG_DrawString(x, y, scale, cgi.CL_GetClientName(clientIndex));
        else cgi.SCR_DrawFontString(cgi.CL_GetClientName(clientIndex), x, y - font_y_offset * scale, scale, rgba_white, true, TextAlignT.LEFT);
      }
      continue;
    }

    if (token === "health_bars") {
      if (skip_depth) continue;

      // reinterpret_cast<const byte *>(&ps->stats[STAT_HEALTH_BARS]) -- two
      // health-bar bytes packed little-endian into one int16 stat.
      const raw = ps.stats[PlayerStatT.STAT_HEALTH_BARS];
      const bytes = [raw & 0xff, (raw >> 8) & 0xff];

      const name = cgi.Localize(cgi.get_configstring(CONFIG_HEALTH_BAR_NAME), [], 0);
      CG_DrawHUDString(name, (hud_vrect.x + hud_vrect.width / 2 - 160) * scale, y, (320 / 2) * 2 * scale, 0, scale);

      const barWidth = (hud_vrect.width * scale - hud_safe.x * 2) * 0.5;
      const barHeight = 4 * scale;

      // NOTE: this shadows `x` with a new local (matching the C source's
      // `float x = ...` inside this block, which shadows the outer int
      // `x`) but mutates the outer `y` directly -- so `y` stays advanced
      // for whatever token comes after "health_bars", while `x` reverts to
      // its pre-block value. See file header for why this matters.
      y += cgi.SCR_FontLineHeight(scale);
      let barX = (hud_vrect.x + hud_vrect.width * 0.5) * scale - barWidth * 0.5;
      let barY = y;

      // 2 health bars, hardcoded
      for (let i = 0; i < 2; i++) {
        const stat = bytes[i];
        if ((stat & 0b10000000) === 0) continue;

        const percent = (stat & 0b01111111) / 127;

        cgi.SCR_DrawColorPic(barX, barY, barWidth + scale, barHeight + scale, "_white", rgba_black);
        if (percent > 0) cgi.SCR_DrawColorPic(barX, barY, barWidth * percent, barHeight, "_white", rgba_red);
        if (percent < 1) cgi.SCR_DrawColorPic(barX + barWidth * percent, barY, barWidth * (1 - percent), barHeight, "_white", { r: 80, g: 80, b: 80, a: 255 });

        barY += barHeight * 3;
        y = barY;
      }

      // keep barX referenced (parity note above); no further use.
      void barX;
    }

    if (token === "story") {
      const storyStr = cgi.get_configstring(CONFIG_STORY);
      if (!storyStr || storyStr.length === 0) continue;

      const localized = cgi.Localize(storyStr, [], 0);
      const size = cgi.SCR_MeasureFontString(localized, scale);
      const centerx = (hud_vrect.x + hud_vrect.width * 0.5) * scale;
      const centery = (hud_vrect.y + hud_vrect.height * 0.5) * scale - size.y * 0.5;

      cgi.SCR_DrawFontString(localized, centerx, centery, scale, rgba_white, true, TextAlignT.CENTER);
    }
  }

  if (skip_depth) cgi.Com_Error("if with no matching endif");
}

// ---------------------------------------------------------------------------
// CG_DrawInventory (cg_screen.cpp:1630-1713)
// ---------------------------------------------------------------------------

const DISPLAY_ITEMS = 19;

function CG_DrawInventory(ps: KexPlayerStateT, inventory: Int16Array, hud_vrect: VrectT, scale: number): void {
  const cgi = CGI();

  const selected = ps.stats[PlayerStatT.STAT_SELECTED_ITEM];

  let num = 0;
  let selectedNum = 0;
  const index: number[] = [];
  for (let i = 0; i < MAX_ITEMS; i++) {
    if (i === selected) selectedNum = num;
    if (inventory[i]) {
      index[num] = i;
      num++;
    }
  }

  // determine scroll point
  let top = selectedNum - Math.trunc(DISPLAY_ITEMS / 2);
  if (num - top < DISPLAY_ITEMS) top = num - DISPLAY_ITEMS;
  if (top < 0) top = 0;

  let x = hud_vrect.x * scale;
  let y = hud_vrect.y * scale;
  const width = hud_vrect.width;
  const height = hud_vrect.height;

  x += ((width / 2 - 256 / 2) | 0) * scale;
  y += ((height / 2 - 216 / 2) | 0) * scale;

  const picw: [number] = [0];
  const pich: [number] = [0];
  cgi.Draw_GetPicSize(picw, pich, "inventory");
  cgi.SCR_DrawPic(x, y + 8 * scale, picw[0] * scale, pich[0] * scale, "inventory");

  y += 27 * scale;
  x += 22 * scale;

  for (let i = top; i < num && i < top + DISPLAY_ITEMS; i++) {
    const item = index[i];
    if (item === selected) {
      // draw a blinky cursor by the selected item
      if ((Math.floor(cgi.CL_ClientRealTime() * 10) & 1) !== 0) cgi.SCR_DrawChar(x - 8, y, scale, 15, false);
    }

    if (CVI(scr_usekfont) === 0) {
      const label = cgi.Localize(cgi.get_configstring(CS_ITEMS + item), [], 0);
      CG_DrawString(x, y, scale, `${String(inventory[item]).padStart(3)} ${label}`, item === selected, false);
    } else {
      const countStr = `${inventory[item]}`;
      cgi.SCR_DrawFontString(countStr, x + 216 * scale - 16 * scale, y - font_y_offset * scale, scale, item === selected ? alt_color : rgba_white, true, TextAlignT.RIGHT);

      const label = cgi.Localize(cgi.get_configstring(CS_ITEMS + item), [], 0);
      cgi.SCR_DrawFontString(label, x + 16 * scale, y - font_y_offset * scale, scale, item === selected ? alt_color : rgba_white, true, TextAlignT.LEFT);
    }

    y += 8 * scale;
  }
}

// ---------------------------------------------------------------------------
// CG_DrawHUD / CG_TouchPics / CG_InitScreen (cg_screen.cpp:1715-1779)
// ---------------------------------------------------------------------------

/** Exported: `cglobals.DrawHUD`. */
export function CG_DrawHUD(
  isplit: number,
  data: CgServerDataT | null,
  hud_vrect: VrectT,
  hud_safe: VrectT,
  scale: number,
  playernum: number,
  psIn: KexPlayerStateT | null,
): void {
  const cgi = CGI();
  const ps = requirePs(psIn, "CG_DrawHUD");

  if (cgi.CL_InAutoDemoLoop()) {
    if (CVI(cl_paused) !== 0) return; // demo is paused, menu is open

    const time = cgi.CL_ClientRealTime() - cgame_init_time;
    if (time < 20000 && time % 4000 < 2000) {
      cgi.SCR_DrawFontString(
        cgi.Localize("$m_eou_press_button", [], 0),
        hud_vrect.width * 0.5 * scale,
        (hud_vrect.height - 64) * scale,
        scale,
        rgba_green,
        true,
        TextAlignT.CENTER,
      );
    }
    return;
  }

  // draw HUD
  if (CVI(cl_skipHud) === 0 && (ps.stats[PlayerStatT.STAT_LAYOUTS] & LayoutFlagsT.LAYOUTS_HIDE_HUD) === 0) {
    CG_ExecuteLayoutString(cgi.get_configstring(CS_STATUSBAR), hud_vrect, hud_safe, scale, playernum, ps);
  }

  // draw centerprint string
  CG_CheckDrawCenterString(ps, hud_vrect, hud_safe, isplit, scale);

  // draw notify
  CG_DrawNotify(isplit, hud_vrect, hud_safe, scale);

  // svc_layout still drawn with hud off
  if (ps.stats[PlayerStatT.STAT_LAYOUTS] & LayoutFlagsT.LAYOUTS_LAYOUT) {
    const d = requireData(data, "CG_DrawHUD (LAYOUTS_LAYOUT)");
    CG_ExecuteLayoutString(d.layout, hud_vrect, hud_safe, scale, playernum, ps);
  }

  // inventory too
  if (ps.stats[PlayerStatT.STAT_LAYOUTS] & LayoutFlagsT.LAYOUTS_INVENTORY) {
    const d = requireData(data, "CG_DrawHUD (LAYOUTS_INVENTORY)");
    CG_DrawInventory(ps, d.inventory, hud_vrect, scale);
  }
}

/** Exported: `cglobals.TouchPics`. */
export function CG_TouchPics(): void {
  const cgi = CGI();
  for (const row of sb_nums) for (const name of row) cgi.Draw_RegisterPic(name);

  cgi.Draw_RegisterPic("inventory");

  font_y_offset = Math.trunc((cgi.SCR_FontLineHeight(1) - CONCHAR_WIDTH) / 2);
}

/** Called by cg_main.ts's InitCGame (cg_main.cpp:19-21). */
export function CG_InitScreen(): void {
  const cgi = CGI();

  cl_paused = cgi.cvar("paused", "0", CvarFlagsT.CVAR_NOFLAGS);
  cl_skipHud = cgi.cvar("cl_skipHud", "0", CvarFlagsT.CVAR_ARCHIVE);
  scr_usekfont = cgi.cvar("scr_usekfont", "1", CvarFlagsT.CVAR_NOFLAGS);

  scr_centertime = cgi.cvar("scr_centertime", "5.0", CvarFlagsT.CVAR_ARCHIVE); // [Sam-KEX] Changed from 2.5
  scr_printspeed = cgi.cvar("scr_printspeed", "0.04", CvarFlagsT.CVAR_NOFLAGS); // [Sam-KEX] Changed from 8
  cl_notifytime = cgi.cvar("cl_notifytime", "5.0", CvarFlagsT.CVAR_ARCHIVE);
  scr_maxlines = cgi.cvar("scr_maxlines", "4", CvarFlagsT.CVAR_ARCHIVE);
  ui_acc_contrast = cgi.cvar("ui_acc_contrast", "0", CvarFlagsT.CVAR_NOFLAGS);
  ui_acc_alttypeface = cgi.cvar("ui_acc_alttypeface", "0", CvarFlagsT.CVAR_NOFLAGS);

  hud_data = Array.from({ length: MAX_SPLIT_PLAYERS }, makeHudData);
}
