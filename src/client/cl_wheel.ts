// wheel.c (2023 Quake II re-release / "KEX" engine client, q2repro's port of
// it -- 623 lines, GPLv2). Ported from
// ~/Projects/qsrc/q2repro/src/client/wheel.c: CL_Carousel_Populate/Open/
// Close/ClearInput/Input/Draw, CL_Wheel_Cycle (+ its two callers
// CL_Wheel_WeapNext/WeapPrev), CL_Wheel_Populate/Open/Close/ClearInput/
// TimeScale/Input/Update/Draw/Precache/Init. See client.h's own
// WheelIconT/WheelWeaponT/WheelAmmoT/WheelPowerupT/WheelDataT/CarouselT/
// WheelT doc comments (src/client/client.ts, just above `class ClStateT`)
// for the plain-data shapes this file operates on.
//
// This file's functions are the CLIENT SIDE of the fix for the reported
// defect: KEX's default binds fire `+wheel`/`-wheel`/`+wheel2`/`-wheel2`/
// `+holster`/`-holster`/`cl_weapnext`/`cl_weapprev`, none of which this
// engine registered before this unit -- every one of them fell through
// Cmd_ForwardToServer (cl_main.ts) as an unrecognized console command,
// landing on the server as a literal `clc_stringcmd` the game module's
// ClientCommand doesn't recognize either, which falls through to chat --
// scrolling the mouse wheel during play chat-spams until flood protection
// locks the player out. Registering the eight commands for real (see
// cl_input.ts's CL_InitInput) is what stops that fallthrough; everything
// else in this file is what makes the resulting behavior the REAL kex
// wheel/carousel, not just a silent no-op.
//
// ---------------------------------------------------------------------------
// ARCHITECTURE DIFFERENCES vs. q2repro's wheel.c (each cited at its own call
// site below too):
// ---------------------------------------------------------------------------
//   - No cl_wheel_icon_t handle cache. RefExports draws every 2D pic BY
//     NAME (ref.ts's DrawPic/DrawStretchPic/DrawColorPic all take a
//     `name: string`, mirroring host.ts's kfont/SCR_DrawBind code -- there
//     is no "resolve a qhandle_t up front" step anywhere else in this port
//     for 2D pics). loadWheelIcon() below is the direct port of
//     CL_LoadWheelIcons, just returning PATHS instead of handles.
//   - No CL_ParseConfigString(-time) hook. cl_parse.ts (this port's
//     CL_ParseConfigString) belongs to a concurrent unit per this task's
//     brief, so there is no per-message dispatch this file can hang a
//     "wheel configstring changed" branch off of the way q2repro's
//     precache.c does. Instead, ensureWheelDataParsed() below re-derives
//     `cl.wheel_data` from `cl.configstrings` every time a populate
//     function runs -- which only happens while the wheel or carousel is
//     actually open (wheel.c's own CL_Wheel_Populate/CL_Carousel_Populate
//     doc comments already say "runs every frame" for exactly that reason,
//     just meaning "every frame it's open" there too). `cl.configstrings[i]`
//     is set unconditionally for every index by cl_parse.ts's
//     CL_ParseConfigString regardless of whether that file recognizes the
//     index (confirmed by reading it) -- so the raw text is always there to
//     re-parse even without a dedicated hook.
//   - No R_SetScale primitive (wheel.c's draw_count() manual integer
//     up-scale trick depends on it) and no hud_scale cvar (host.ts's own
//     kexHudVrect() doc comment already establishes "scale is 1" as this
//     port's precedent). CL_Wheel_Draw/CL_Carousel_Draw below draw ammo/
//     powerup counts via plain 8px DrawChar conchars (drawString() below),
//     the same "conchars-only fallback" this port already uses everywhere
//     else text can't go through a kfont (host.ts's drawConchar).
//
// ---------------------------------------------------------------------------
// BLOCKED ON WIDENING -- reported per this unit's brief, not silently
// worked around:
// ---------------------------------------------------------------------------
// Every per-player wheel readout (which weapons are owned, ammo counts,
// powerup counts, the currently-active wheel weapon) is a KEX-only stat at
// index >= 32 (kexapi/game.ts's PlayerStatT: STAT_WEAPONS_OWNED_1/2 = 32/33,
// STAT_AMMO_INFO_START = 34, STAT_ACTIVE_WHEEL_WEAPON = 47,
// STAT_ACTIVE_WEAPON = 53 -- src/kexgame/p_hud.ts:296-319). Two independent
// gaps compound on the way from the game module to this file, both already
// reported elsewhere and NOT fixed here (out of this unit's file scope):
//   1. src/server/bindings/kex.ts:150's TODO(phase-2b): the wire only
//      carries the classic engine's 32-wide `PlayerStateT.stats`, so every
//      index >= 32 is truncated before it ever reaches the client. This
//      file's own two reads of "wide" stats (activeWeaponItemIndex() below)
//      go through host.ts's kexPlayerStateViewFromClassic(), the same
//      widen-with-zero-fill view CG_DrawHUD's kex path already uses -- so
//      once that TODO lands and the wire actually carries indices 32-63,
//      these reads become correct with NO further changes here.
//   2. src/kexgame/p_hud.ts's G_SetStats (the server-side stat WRITER)
//      unconditionally sets STAT_WEAPONS_OWNED_1/2 to 0 and
//      STAT_ACTIVE_WHEEL_WEAPON/STAT_ACTIVE_WEAPON to -1 on every call
//      (p_hud.ts:549-552) -- its own doc comment cites this as dropped
//      because the real G_SetStats resolves wheel entries through the
//      game's global `itemlist[]` via GetItemByIndex/GetItemByAmmo/
//      GetItemByPowerup, which that unit's author believed unported. (Note
//      for whoever picks this up: src/kexgame/g_items.ts's own SetItemNames
//      -- the CS_WHEEL_WEAPONS/AMMO/POWERUPS configstring writer this file's
//      ensureWheelDataParsed() reads from -- already has a real, populated
//      `itemlist` local array with `weapon_wheel_index`/`ammo_wheel_index`/
//      `powerup_wheel_index` fields on each entry; G_SetStats not using it
//      looks like it may be closeable without an itemlist port at all, but
//      that's src/kexgame/ territory, not this unit's.) Even after gap 1 is
//      fixed, gap 2 means the wheel bitmask/active-weapon reads stay 0/-1
//      until a kexgame-territory unit wires G_SetStats to the real item
//      table.
//
// WHAT WORKS TODAY regardless of both gaps above: command registration
// (no more chat-spam -- priority (a)'s actual bug), the full wheel/carousel
// STATE MACHINE (open/close/cycle/timers/holster), and `cl.wheel_data`
// itself (the per-item icon/ammo-index/sort metadata table) -- that table
// comes from CS_WHEEL_WEAPONS/AMMO/POWERUPS configstrings, which
// g_items.ts's SetItemNames genuinely does populate server-side today, wire
// truncation notwithstanding (those configstrings are plain strings in the
// ordinary CS_GENERAL-following range, not player stats). What does NOT
// work today: which of those weapons the wheel/carousel actually shows as
// "owned" (GetOwnedWeaponWheelWeapons reads the always-0 bitmask), so
// CL_Wheel_Cycle/CL_Carousel_Populate correctly find zero eligible slots and
// gracefully close without ever selecting a weapon or sending
// `use_index_only` -- a real, silent no-op instead of chat-spam, not yet
// the full "cycles your weapons" experience.

import { cl, cls, re, ConnstateT, WheelStateT, type WheelIconT, type WheelWeaponT, type WheelAmmoT, type WheelPowerupT, type WheelSlotT, type CarouselSlotT } from "./client";
import { viddef } from "./vid";
import type { UsercmdT, CvarT } from "../shared/q_shared";
import { Cvar_Get } from "../qcommon/cvar";
import { MSG_WriteByte, SZ_Print } from "../qcommon/sizebuf";
import { ClcOpsT } from "../qcommon/qcommon";
import { Sys_Milliseconds } from "../platform/sys";
import { ButtonT } from "../kexapi/game";
import { Loc_Localize } from "../qcommon/loc";
import { CG_GetActiveCgame, kexPlayerStateViewFromClassic } from "./cgame/host";
import type { DrawColorT } from "./ref";

// STAT_ACTIVE_WEAPON (kex-only, index 53) -- src/kexgame/p_hud.ts:319,
// q2repro's inc/shared/shared.h:1503 (`STAT_ACTIVE_WEAPON` follows
// STAT_HEALTH_BARS=52 in the KEX-only tail). Hardcoded (not imported from
// src/kexgame/p_hud.ts's own `PlayerStatT`) deliberately: p_hud.ts is a
// game-module file (src/kexgame/), a layer this client-side file has no
// other dependency on, and pulling in that module's whole graph for one
// numeric constant would be a bigger, riskier change than citing the number
// -- see the "BLOCKED ON WIDENING" section above for why this index reads
// as 0 today regardless.
const STAT_ACTIVE_WEAPON = 53;

// ---------------------------------------------------------------------------
// cvars -- wheel.c's CL_Wheel_Init (wc_screen_frac_y/wc_timeout/wc_lock_time/
// wc_ammo_scale/ww_timer_speed/ww_ammo_scale). Registered from
// cl_input.ts's CL_InitInput rather than a q2repro-style dedicated
// CL_Wheel_Init call site in cl_main.ts's CL_InitLocal: cl_main.ts is under
// heavy concurrent edit by another unit per this task's brief, and cvar
// registration order relative to other subsystems' has no behavioral
// dependency here (Cvar_Get just needs to run once before first use).
// Reported deviation, not a silent relocation.
// ---------------------------------------------------------------------------
let wc_screen_frac_y: CvarT | null = null;
let wc_timeout: CvarT | null = null;
let wc_lock_time: CvarT | null = null;
let wc_ammo_scale: CvarT | null = null;
let ww_timer_speed: CvarT | null = null;
let ww_ammo_scale: CvarT | null = null;

export function CL_Wheel_Init(): void {
  wc_screen_frac_y = Cvar_Get("wc_screen_frac_y", "0.72", 0);
  wc_timeout = Cvar_Get("wc_timeout", "400", 0);
  wc_lock_time = Cvar_Get("wc_lock_time", "300", 0);
  wc_ammo_scale = Cvar_Get("wc_ammo_scale", "0.66", 0);
  ww_timer_speed = Cvar_Get("ww_timer_speed", "3", 0);
  ww_ammo_scale = Cvar_Get("ww_ammo_scale", "0.66", 0);
  cl.wheel.timescale = 1.0;
}

// ---------------------------------------------------------------------------
// CL_ClientCommand -- q2repro's cl_main.c helper of the same name: writes an
// immediate clc_stringcmd straight into the outgoing netchan message
// (flushed by the next CL_SendCmd), the same idiom cl_main.ts's own
// Cmd_ForwardToServer already uses for the exact "unrecognized command"
// fallback this whole unit exists to stop the wheel commands from hitting.
// ---------------------------------------------------------------------------
function CL_ClientCommand(cmd: string): void {
  if (cls.state < ConnstateT.ca_connected) return;
  MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
  SZ_Print(cls.netchan.message, cmd);
}

// ---------------------------------------------------------------------------
// Wheel data parsing -- CL_LoadWheelIcons/CL_LoadWheelEntry (precache.c),
// adapted to this port's lazy re-parse-on-populate model (see file header).
// ---------------------------------------------------------------------------

// CL_LoadWheelIcons (precache.c:426-448). `iconIndex` is a CS_IMAGES index
// (the second pipe-field of every CS_WHEEL_* configstring entry --
// g_items.ts's SetItemNames writes `gi.imageindex(it.icon)` there).
function loadWheelIcon(iconIndex: number): WheelIconT {
  const main = cl.configstrings[cls.csr.images + iconIndex] ?? "";
  let wheel = `wheel/${main}`;
  let selected = `${wheel}_selected`;
  if (re) {
    if (re.DrawGetPicSize(wheel).w <= 0) {
      // no per-wheel icon at all -- fall back to the plain (non-wheel) icon
      // for both, matching CL_LoadWheelIcons' `icons.wheel = icons.selected
      // = icons.main;` branch exactly.
      wheel = main;
      selected = main;
    } else if (re.DrawGetPicSize(selected).w <= 0) {
      // wheel icon exists but no dedicated "_selected" variant -- reuse the
      // plain wheel icon, matching CL_LoadWheelIcons' `icons.selected =
      // icons.wheel;` branch.
      selected = wheel;
    }
  }
  return { main, wheel, selected };
}

function parseWheelWeaponEntry(index: number, raw: string): void {
  const values = raw.split("|").map((v) => Number.parseInt(v, 10));
  if (values.length !== 8 || values.some((v) => Number.isNaN(v))) return;
  const [item_index, iconIndex, ammo_index, min_ammo, is_powerup, sort_id, quantity_warn, can_drop] = values as [number, number, number, number, number, number, number, number];
  const entry: WheelWeaponT = {
    item_index,
    icons: loadWheelIcon(iconIndex),
    ammo_index,
    min_ammo,
    sort_id,
    quantity_warn,
    is_powerup: is_powerup !== 0,
    can_drop: can_drop !== 0,
  };
  cl.wheel_data.weapons[index] = entry;
}

function parseWheelAmmoEntry(index: number, raw: string): void {
  const values = raw.split("|").map((v) => Number.parseInt(v, 10));
  if (values.length !== 2 || values.some((v) => Number.isNaN(v))) return;
  const [item_index, iconIndex] = values as [number, number];
  const entry: WheelAmmoT = { item_index, icons: loadWheelIcon(iconIndex) };
  cl.wheel_data.ammo[index] = entry;
}

function parseWheelPowerupEntry(index: number, raw: string): void {
  const values = raw.split("|").map((v) => Number.parseInt(v, 10));
  if (values.length !== 6 || values.some((v) => Number.isNaN(v))) return;
  const [item_index, iconIndex, is_toggle, sort_id, can_drop, ammo_index] = values as [number, number, number, number, number, number];
  const entry: WheelPowerupT = {
    item_index,
    icons: loadWheelIcon(iconIndex),
    sort_id,
    ammo_index,
    is_toggle: is_toggle !== 0,
    can_drop: can_drop !== 0,
  };
  cl.wheel_data.powerups[index] = entry;
}

// Re-derives cl.wheel_data from cl.configstrings -- see file header for why
// this replaces a CL_ParseConfigString-time hook. Guarded on the connected
// family actually having a wheel configstring block at all (cs_remap.ts's
// CS_REMAP_OLD sets wheelweapons/wheelammo/wheelpowerups to -1 and
// max_wheelitems to 0 for the classic family, matching q2repro's own -1
// sentinel convention).
function ensureWheelDataParsed(): void {
  const csr = cls.csr;
  if (csr.wheelweapons === -1 || csr.max_wheelitems <= 0) {
    cl.wheel_data.num_weapons = 0;
    cl.wheel_data.num_ammo = 0;
    cl.wheel_data.num_powerups = 0;
    return;
  }

  let numWeapons = 0;
  for (let i = 0; i < csr.max_wheelitems; i++) {
    const raw = cl.configstrings[csr.wheelweapons + i];
    if (raw) {
      parseWheelWeaponEntry(i, raw);
      numWeapons = i + 1;
    }
  }
  cl.wheel_data.num_weapons = numWeapons;

  let numAmmo = 0;
  for (let i = 0; i < csr.max_wheelitems; i++) {
    const raw = cl.configstrings[csr.wheelammo + i];
    if (raw) {
      parseWheelAmmoEntry(i, raw);
      numAmmo = i + 1;
    }
  }
  cl.wheel_data.num_ammo = numAmmo;

  let numPowerups = 0;
  for (let i = 0; i < csr.max_wheelitems; i++) {
    const raw = cl.configstrings[csr.wheelpowerups + i];
    if (raw) {
      parseWheelPowerupEntry(i, raw);
      numPowerups = i + 1;
    }
  }
  cl.wheel_data.num_powerups = numPowerups;
}

// activeWeaponItemIndex -- the STAT_ACTIVE_WEAPON read shared by
// CL_Carousel_Open (wheel.c:98) and CL_Carousel_Input (wheel.c:193). Reads
// through host.ts's kexPlayerStateViewFromClassic() (the same 32->64 widen
// CG_DrawHUD's kex path uses) rather than `cl.frame.playerstate.stats`
// directly -- that classic array is only 32 wide, and index 53 would be
// `undefined` off the end of it. See "BLOCKED ON WIDENING" above: today the
// widened view zero-fills index 53, so this returns wheel_data.weapons[0]'s
// item_index (if any) rather than -1 -- a faithful reflection of the
// upstream gap, not a guess, and self-corrects once G_SetStats's -1 default
// (src/kexgame/p_hud.ts:552) actually survives the trip to the client.
function activeWeaponItemIndex(): number {
  const kexPs = kexPlayerStateViewFromClassic(cl.frame.playerstate);
  const wheelIndex = kexPs.stats[STAT_ACTIVE_WEAPON];
  if (wheelIndex === -1) return -1;
  const weapon = cl.wheel_data.weapons[wheelIndex];
  return weapon ? weapon.item_index : -1;
}

// ---------------------------------------------------------------------------
// Carousel (wheel.c:46-236 -- the shared "populate/open/close/cycle" half
// used by both the classic mouse-wheel carousel HUD strip and
// cl_weapnext/cl_weapprev's weapon cycling).
// ---------------------------------------------------------------------------

export function CL_Carousel_Close(): void {
  cl.carousel.state = WheelStateT.WHEEL_CLOSED;
}

// CL_Carousel_Populate (wheel.c:53-93).
function CL_Carousel_Populate(): boolean {
  ensureWheelDataParsed();
  const cgame = CG_GetActiveCgame();
  const ps = cl.frame.playerstate;
  const owned = cgame.GetOwnedWeaponWheelWeapons(ps);

  const slots: CarouselSlotT[] = [];
  for (let i = 0; i < cl.wheel_data.num_weapons; i++) {
    if ((owned & (1 << i)) === 0) continue;
    const w = cl.wheel_data.weapons[i]!;
    slots.push({
      data_id: i,
      has_ammo: w.ammo_index === -1 || cgame.GetWeaponWheelAmmoCount(ps, w.ammo_index) !== 0,
      item_index: w.item_index,
    });
  }
  // wheel.c:71's own TODO ("sort by sort_id") is unimplemented upstream
  // too -- left in insertion (weapon-table) order here for the same reason.
  // wheel.c:73's "TODO: cl.wheel.powerups" (a powerup row on the carousel
  // HUD strip) is also unimplemented upstream -- not added here either.
  cl.carousel.slots = slots;
  cl.carousel.num_slots = slots.length;

  if (!slots.length) return false;

  if (cl.carousel.selected === -1) {
    cl.carousel.selected = slots[0]!.item_index;
  } else if (!slots.some((s) => s.item_index === cl.carousel.selected)) {
    // wheel.c:87-90's own "TODO: maybe something smarter?" -- matches
    // upstream's bail-out exactly.
    return false;
  }

  return true;
}

// CL_Carousel_Open (wheel.c:95-106).
function CL_Carousel_Open(): void {
  if (cl.carousel.state === WheelStateT.WHEEL_CLOSED) {
    cl.carousel.selected = activeWeaponItemIndex();
  }
  cl.carousel.state = WheelStateT.WHEEL_OPEN;
  if (!CL_Carousel_Populate()) CL_Carousel_Close();
}

// CL_Carousel_ClearInput (wheel.c:165-171). q2repro's own close_time bump
// uses `cl.frametime.time` (an integer-millisecond fixed-tick value this
// port has no counterpart for -- see cl_input.ts's own frame_msec, the
// closest analogue, which is per-input-frame rather than per-server-tick);
// approximated here as `cls.frametime` (this port's float seconds-per-frame)
// converted to milliseconds. Only affects how many extra milliseconds the
// carousel HUD strip lingers after closing -- a cosmetic timing value, not
// a correctness-affecting one.
export function CL_Carousel_ClearInput(): void {
  if (cl.carousel.state === WheelStateT.WHEEL_CLOSING) {
    cl.carousel.state = WheelStateT.WHEEL_CLOSED;
    cl.carousel.close_time = cls.realtime + Math.round(cls.frametime * 1000) * 2;
  }
}

// CL_Carousel_Input (wheel.c:173-204) -- runs every built usercmd (see
// cl_input.ts's CL_SendCmd call site) and mutates it directly: BUTTON_HOLSTER
// while the carousel is open, and the eventual `use_index_only` dispatch on
// attack-press or timeout.
export function CL_Carousel_Input(cmd: UsercmdT): void {
  if (cl.carousel.state !== WheelStateT.WHEEL_OPEN) {
    if (cl.carousel.state === WheelStateT.WHEEL_CLOSING && cls.realtime >= cl.carousel.close_time) {
      cl.carousel.state = WheelStateT.WHEEL_CLOSED;
    }
    return;
  }

  if (!CL_Carousel_Populate()) {
    CL_Carousel_Close();
    return;
  }

  // always holster while open
  cmd.buttons |= ButtonT.BUTTON_HOLSTER;

  if (cls.realtime >= cl.carousel.close_time || (cmd.buttons & ButtonT.BUTTON_ATTACK) !== 0) {
    const activeItem = activeWeaponItemIndex();

    if (cl.carousel.selected === activeItem) {
      // already using this weapon
      CL_Carousel_Close();
      return;
    }

    CL_ClientCommand(`use_index_only ${cl.carousel.selected}\n`);
    cl.carousel.state = WheelStateT.WHEEL_CLOSING;

    cl.weapon_lock_time = cl.time + (wc_lock_time?.value ?? 300);
  }
}

// ---------------------------------------------------------------------------
// CL_Wheel_Cycle (wheel.c:206-239) -- cl_weapnext/cl_weapprev's real logic.
// This is priority (a): the exact function the task brief asks be
// gap/wraparound tested. Faithful line-for-line port of the C loop,
// including its "TODO this is ugly :(" own comment.
// ---------------------------------------------------------------------------
function CL_Wheel_Cycle(offset: number): void {
  if (cl.carousel.state !== WheelStateT.WHEEL_OPEN) {
    CL_Carousel_Open();
  } else if (!CL_Carousel_Populate()) {
    CL_Carousel_Close();
    return;
  }

  // TODO this is ugly :(
  for (let i = 0; i < cl.carousel.num_slots; i++) {
    if (cl.carousel.slots[i]!.item_index === cl.carousel.selected) {
      for (let n = 0, o = i + offset; n < cl.carousel.num_slots - 1; n++, o += offset) {
        if (o < 0) o = cl.carousel.num_slots - 1;
        else if (o >= cl.carousel.num_slots) o = 0;

        if (!cl.carousel.slots[o]!.has_ammo) continue;

        cl.carousel.selected = cl.carousel.slots[o]!.item_index;
        break;
      }
      break;
    }
  }

  cl.carousel.close_time = cls.realtime + (wc_timeout?.value ?? 400);
}

export function CL_Wheel_WeapNext(): void {
  CL_Wheel_Cycle(1);
}
export function CL_Wheel_WeapPrev(): void {
  CL_Wheel_Cycle(-1);
}

// ---------------------------------------------------------------------------
// Wheel (wheel.c:257-448 -- the pie-menu weapon/powerup wheel opened by
// +wheel/+wheel2).
// ---------------------------------------------------------------------------

function wheelSlotSortCompare(a: WheelSlotT, b: WheelSlotT): number {
  return a.sort_id === b.sort_id ? a.item_index - b.item_index : a.sort_id - b.sort_id;
}

// CL_Wheel_Populate (wheel.c:257-298).
function CL_Wheel_Populate(): boolean {
  ensureWheelDataParsed();
  const cgame = CG_GetActiveCgame();
  const ps = cl.frame.playerstate;
  const owned = cgame.GetOwnedWeaponWheelWeapons(ps);

  const slots: WheelSlotT[] = [];

  if (cl.wheel.is_powerup_wheel) {
    for (let i = 0; i < cl.wheel_data.num_powerups; i++) {
      const p = cl.wheel_data.powerups[i]!;
      slots.push({
        data_id: i,
        is_powerup: true,
        has_ammo: p.ammo_index === -1 || cgame.GetWeaponWheelAmmoCount(ps, p.ammo_index) !== 0,
        item_index: p.item_index,
        has_item: cgame.GetPowerupWheelCount(ps, i) !== 0,
        sort_id: p.sort_id,
        icons: p.icons,
        angle: 0,
        dir: [0, 0],
        dot: 0,
      });
    }
  } else {
    for (let i = 0; i < cl.wheel_data.num_weapons; i++) {
      const w = cl.wheel_data.weapons[i]!;
      slots.push({
        data_id: i,
        has_ammo: w.ammo_index === -1 || cgame.GetWeaponWheelAmmoCount(ps, w.ammo_index) !== 0,
        item_index: w.item_index,
        has_item: (owned & (1 << i)) !== 0,
        is_powerup: false,
        sort_id: w.sort_id,
        icons: w.icons,
        angle: 0,
        dir: [0, 0],
        dot: 0,
      });
    }
  }

  slots.sort(wheelSlotSortCompare);

  cl.wheel.slots = slots;
  cl.wheel.num_slots = slots.length;
  cl.wheel.slice_deg = slots.length ? (Math.PI * 2) / slots.length : 0;
  cl.wheel.slice_sin = Math.cos(cl.wheel.slice_deg / 2);

  return slots.length > 0;
}

// CL_Wheel_Open (wheel.c:300-311).
export function CL_Wheel_Open(powerup: boolean): void {
  cl.wheel.is_powerup_wheel = powerup;
  cl.wheel.selected = -1;

  if (!CL_Wheel_Populate()) return;

  cl.wheel.state = WheelStateT.WHEEL_OPEN;
  cl.wheel.deselect_time = 0;
  cl.wheel.position = [0, 0];
}

// CL_Wheel_TimeScale (wheel.c:313-316).
export function CL_Wheel_TimeScale(): number {
  return cl.wheel.timescale;
}

// CL_Wheel_ClearInput (wheel.c:318-322).
export function CL_Wheel_ClearInput(): void {
  if (cl.wheel.state === WheelStateT.WHEEL_CLOSING) cl.wheel.state = WheelStateT.WHEEL_CLOSED;
}

// CL_Wheel_Close (wheel.c:324-333).
export function CL_Wheel_Close(released: boolean): void {
  if (cl.wheel.state !== WheelStateT.WHEEL_OPEN) return;

  cl.wheel.state = WheelStateT.WHEEL_CLOSING;

  if (released && cl.wheel.selected !== -1) {
    const slot = cl.wheel.slots[cl.wheel.selected];
    if (slot) CL_ClientCommand(`use_index_only ${slot.item_index}\n`);
  }
}

// One module-scope cache of the weaponwheel.png pic's registered size,
// filled by CL_Wheel_Precache -- q2repro's own scr.wheel_size (client.h)
// counterpart. Draw-by-name (see file header) means there is no handle to
// cache alongside it, just the size.
let wheelPicSize = 0;

// get_wheel_draw_size (wheel.c:335-352). q2repro divides by scr.hud_scale
// throughout; this port has no hud_scale cvar (host.ts's kexHudVrect's own
// "scale is 1" precedent), so those divisions collapse to identity.
function getWheelDrawSize(): number {
  const wheelPadding = 74;
  const wheelContentSize = wheelPicSize - wheelPadding;
  const realHudHeight = viddef.height;

  if (wheelContentSize <= 0 || realHudHeight <= 0) return wheelPicSize;

  if (wheelContentSize >= realHudHeight) {
    const wheelSizeDiv = Math.trunc((2 * wheelContentSize - 1) / realHudHeight);
    return wheelSizeDiv > 0 ? Math.trunc(wheelPicSize / wheelSizeDiv) : wheelPicSize;
  }

  const wheelSizeMul = Math.trunc(realHudHeight / wheelContentSize);
  return wheelPicSize * wheelSizeMul;
}

// CL_Wheel_Input (wheel.c:354-389). Called from platform/sdl.ts's IN_Move --
// see that file's own citation for why the raw relative-mouse-motion feed
// lives there (the only place in this port's input backend that still has
// undivided access to the frame's dx/dy before it's folded into
// viewangles/movement).
export function CL_Wheel_Input(cmd: UsercmdT, x: number, y: number): void {
  if (cl.wheel.state === WheelStateT.WHEEL_CLOSED) return;

  // always holster while open (or closing)
  if (!cl.wheel.is_powerup_wheel) cmd.buttons |= ButtonT.BUTTON_HOLSTER;

  if (cl.wheel.state !== WheelStateT.WHEEL_OPEN) return;

  if (!CL_Wheel_Populate()) {
    CL_Wheel_Close(false);
    return;
  }

  cl.wheel.position[0] += x;
  cl.wheel.position[1] += y;

  cl.wheel.distance = Math.hypot(cl.wheel.position[0], cl.wheel.position[1]);
  const innerSize = getWheelDrawSize() * 0.64;

  cl.wheel.dir = [0, 0];

  if (cl.wheel.distance) {
    const invDistance = 1 / cl.wheel.distance;
    cl.wheel.dir = [cl.wheel.position[0] * invDistance, cl.wheel.position[1] * invDistance];

    if (cl.wheel.distance > innerSize / 2) {
      cl.wheel.distance = innerSize / 2;
      cl.wheel.position = [cl.wheel.dir[0] * (innerSize / 2), cl.wheel.dir[1] * (innerSize / 2)];
    }
  }
}

let lastWheelTime = 0;

// CL_Wheel_Update (wheel.c:391-447) -- per-slot dot-product selection math +
// the open/close timer that drives CL_Wheel_TimeScale's zoom tween.
export function CL_Wheel_Update(): void {
  const t = Sys_Milliseconds();
  const frac = (t - lastWheelTime) * 0.001;
  lastWheelTime = t;

  const timerSpeed = ww_timer_speed?.value ?? 3;

  if (cl.wheel.state !== WheelStateT.WHEEL_OPEN) {
    if (cl.wheel.timer > 0) cl.wheel.timer = Math.max(0, cl.wheel.timer - frac * timerSpeed);
    cl.wheel.timescale = Math.max(0.1, 1 - cl.wheel.timer);
    return;
  }

  if (cl.wheel.timer < 1) cl.wheel.timer = Math.min(1, cl.wheel.timer + frac * timerSpeed);
  cl.wheel.timescale = Math.max(0.1, 1 - cl.wheel.timer);

  for (let i = 0; i < cl.wheel.num_slots; i++) {
    const slot = cl.wheel.slots[i]!;
    if (!slot.has_item) continue;

    slot.angle = cl.wheel.slice_deg * i;
    slot.dir = [Math.sin(slot.angle), -Math.cos(slot.angle)];
    slot.dot = cl.wheel.dir[0] * slot.dir[0] + cl.wheel.dir[1] * slot.dir[1];
  }

  const canSelect = cl.wheel.distance > 140;

  if (canSelect) {
    for (let i = 0; i < cl.wheel.num_slots; i++) {
      const slot = cl.wheel.slots[i]!;
      if (!slot.has_item) continue;

      if (slot.dot > cl.wheel.slice_sin) {
        cl.wheel.selected = i;
        cl.wheel.deselect_time = 0;
      }
    }
  } else if (cl.wheel.selected) {
    if (!cl.wheel.deselect_time) cl.wheel.deselect_time = cls.realtime + 200;
  }

  if (cl.wheel.deselect_time && cl.wheel.deselect_time < cls.realtime) {
    cl.wheel.selected = -1;
    cl.wheel.deselect_time = 0;
  }
}

// ---------------------------------------------------------------------------
// Drawing (wheel.c:22-163, 449-600) -- priority (c) per this unit's brief.
// No real renderer is constructed anywhere in this port yet (ref.ts's own
// file header: "no module ever constructs a real RefExports today"), so
// none of this runs against real pixels in practice; ported for fidelity
// and exercised by tests against a fake `re` (this port's established
// cgame_draw.test.ts precedent).
// ---------------------------------------------------------------------------

const COLOR_WHITE: DrawColorT = { r: 255, g: 255, b: 255, a: 255 };
const COLOR_BLACK: DrawColorT = { r: 0, g: 0, b: 0, a: 255 };

// wheel.c's slot_count_color()/draw_count() tint ammo-count text red when
// low and yellow when the slot is selected -- CUT here: ref.ts's DrawChar
// (this port's only conchar primitive, see drawCount() below) takes no
// color parameter at all, unlike q2repro's SCR_DrawString(..., color, ...).
// Every ammo/powerup count below draws in the console's default color
// instead of wheel.c's per-state tint; `warnLow`/`selected` are still
// computed at each call site so a future kfont-colored text primitive can
// wire the tint back in without re-deriving them.

function withAlpha(c: DrawColorT, alphaFrac: number): DrawColorT {
  return { r: c.r, g: c.g, b: c.b, a: Math.round(c.a * alphaFrac) };
}

// draw_count (wheel.c:25-39), simplified: no R_SetScale in this port (see
// file header) -- draws plain 8px conchars via re.DrawChar instead of the
// sub-pixel integer up-scale trick. Center-aligned on `x`.
function drawCount(x: number, y: number, value: number): void {
  if (!re) return;
  const str = String(value);
  const startX = x - (str.length * 8) / 2;
  for (let i = 0; i < str.length; i++) re.DrawChar(Math.round(startX + i * 8), y, str.charCodeAt(i));
}

// R_DrawStretchPicShadowAlpha (wheel.c:111-115).
function drawStretchPicShadowAlpha(x: number, y: number, w: number, h: number, name: string, shadowOffset: number, color: DrawColorT, alpha: number): void {
  if (!re || !name) return;
  re.DrawColorPic(x + shadowOffset, y + shadowOffset, w, h, name, withAlpha(COLOR_BLACK, alpha));
  re.DrawColorPic(x, y, w, h, name, withAlpha(color, alpha));
}

function localizedItemName(itemIndex: number): string {
  const base = cl.configstrings[cls.csr.items + itemIndex] ?? "";
  return Loc_Localize(base, true, [], 0);
}

// CL_Carousel_Draw (wheel.c:123-163).
export function CL_Carousel_Draw(): void {
  if (cl.carousel.state !== WheelStateT.WHEEL_OPEN || !re) return;

  const iconSize = 24 + 2;
  const pad = 2;
  const carouselW = cl.carousel.num_slots * (iconSize + pad);
  const centerX = viddef.width / 2;
  let carouselX = centerX - carouselW / 2;
  const carouselY = viddef.height * (wc_screen_frac_y?.value ?? 0.72);

  for (let i = 0; i < cl.carousel.num_slots; i++, carouselX += iconSize + pad) {
    const carSlot = cl.carousel.slots[i]!;
    const selected = cl.carousel.selected === carSlot.item_index;
    const weap = cl.wheel_data.weapons[carSlot.data_id];
    if (!weap) continue;
    const icons = weap.icons;

    drawStretchPicShadowAlpha(carouselX, carouselY, iconSize, iconSize, selected ? icons.selected : icons.wheel, 2, COLOR_WHITE, 1);

    if (selected) {
      const localized = localizedItemName(carSlot.item_index);
      for (let c = 0; c < localized.length; c++) re.DrawChar(Math.round(centerX - (localized.length * 8) / 2 + c * 8), carouselY - 16, localized.charCodeAt(c));
    }

    if (weap.ammo_index >= 0) {
      const cgame = CG_GetActiveCgame();
      const count = cgame.GetWeaponWheelAmmoCount(cl.frame.playerstate, weap.ammo_index);
      drawCount(carouselX + iconSize / 2, carouselY + iconSize + 2, count);
    }
  }
}

// CL_Wheel_Draw's per-slot body (wheel.c:460-525).
function drawWheelSlot(slotIdx: number, centerX: number, centerY: number, wheelDrawSize: number, wheelAlpha: number): void {
  if (!re) return;
  const slot = cl.wheel.slots[slotIdx];
  if (!slot || !slot.has_item || !slot.icons) return;

  const selected = cl.wheel.selected === slotIdx;
  const scale = selected ? 2 : 1;
  const size = 12 * scale;
  const px = slot.dir[0] * ((wheelDrawSize / 2) * 0.525);
  const py = slot.dir[1] * ((wheelDrawSize / 2) * 0.525);

  let active = selected;
  let alpha = 1.0;

  if (slot.is_powerup) {
    const powerup = cl.wheel_data.powerups[slot.data_id];
    if (powerup?.is_toggle) {
      const cgame = CG_GetActiveCgame();
      if (cgame.GetPowerupWheelCount(cl.frame.playerstate, slot.data_id) === 2) active = true;
      if (powerup.ammo_index !== -1 && !slot.has_ammo) alpha = 0.5;
    }
  }

  alpha *= wheelAlpha;

  drawStretchPicShadowAlpha(centerX + px - size, centerY + py - size, size * 2, size * 2, active ? slot.icons.selected : slot.icons.wheel, 4, COLOR_WHITE, alpha);

  const cgame = CG_GetActiveCgame();
  let count = -1;

  if (slot.is_powerup) {
    const powerup = cl.wheel_data.powerups[slot.data_id];
    if (powerup && !powerup.is_toggle) count = cgame.GetPowerupWheelCount(cl.frame.playerstate, slot.data_id);
    else if (powerup && powerup.ammo_index !== -1) count = cgame.GetWeaponWheelAmmoCount(cl.frame.playerstate, powerup.ammo_index);
  } else {
    const weapon = cl.wheel_data.weapons[slot.data_id];
    if (weapon && weapon.ammo_index !== -1) count = cgame.GetWeaponWheelAmmoCount(cl.frame.playerstate, weapon.ammo_index);
    // wheel.c also computes `warn_low = count <= weapon.quantity_warn` here,
    // feeding slot_count_color()'s red tint -- dropped along with the rest
    // of the color-tint path (see this file's COLOR_WHITE/COLOR_BLACK
    // comment above: DrawChar has no color parameter to tint with).
  }

  const minCount = slot.is_powerup ? 2 : 0;
  if (count !== -1 && count >= minCount) {
    drawCount(centerX + px + size, centerY + py + size, count);
  }
}

// CL_Wheel_Draw (wheel.c:527-600).
export function CL_Wheel_Draw(): void {
  if ((cl.wheel.state !== WheelStateT.WHEEL_OPEN && cl.wheel.timer === 0) || !re) return;

  let centerX = viddef.width / 2;
  centerX += cl.wheel.is_powerup_wheel ? -(viddef.width / 4) : viddef.width / 4;
  const centerY = viddef.height / 2;

  const t = 1 - cl.wheel.timer;
  const tween = 0.5 - Math.cos(t * t * Math.PI) * 0.5;
  const wheelAlpha = 1 - tween;
  const wheelDrawSize = getWheelDrawSize();

  re.DrawColorPic(centerX - wheelDrawSize / 2, centerY - wheelDrawSize / 2, wheelDrawSize, wheelDrawSize, "/gfx/weaponwheel.png", withAlpha(COLOR_WHITE, wheelAlpha));

  for (let i = 0; i < cl.wheel.num_slots; i++) {
    if (i === cl.wheel.selected) continue;
    drawWheelSlot(i, centerX, centerY, wheelDrawSize, wheelAlpha);
  }

  if (cl.wheel.selected >= 0 && cl.wheel.selected < cl.wheel.num_slots) {
    drawWheelSlot(cl.wheel.selected, centerX, centerY, wheelDrawSize, wheelAlpha);

    const slot = cl.wheel.slots[cl.wheel.selected]!;
    const localized = localizedItemName(slot.item_index);
    const labelY = centerY - wheelDrawSize / 8;
    for (let c = 0; c < localized.length; c++) re.DrawChar(Math.round(centerX - (localized.length * 8) / 2 + c * 8), labelY, localized.charCodeAt(c));

    const cgame = CG_GetActiveCgame();
    let ammoIndex: number;
    if (slot.is_powerup) {
      const powerup = cl.wheel_data.powerups[slot.data_id];
      ammoIndex = powerup ? powerup.ammo_index : -1;
      if (powerup && !powerup.is_toggle) {
        const count = String(cgame.GetPowerupWheelCount(cl.frame.playerstate, slot.data_id));
        for (let c = 0; c < count.length; c++) re.DrawChar(Math.round(centerX - (count.length * 8) / 2 + c * 8), centerY, count.charCodeAt(c));
      }
    } else {
      const weapon = cl.wheel_data.weapons[slot.data_id];
      ammoIndex = weapon ? weapon.ammo_index : -1;
    }

    if (ammoIndex !== -1) {
      const ammo = cl.wheel_data.ammo[ammoIndex];
      if (ammo) {
        drawStretchPicShadowAlpha(centerX - (24 * 3) / 2, centerY - (24 * 3) / 2, 24 * 3, 24 * 3, ammo.icons.wheel, 2, COLOR_WHITE, wheelAlpha);
      }
    }
  }

  const wheelButtonDrawSize = wheelPicSize > 0 ? Math.round(wheelPicSize * 0.15) : 32;
  re.DrawColorPic(
    Math.round(centerX + cl.wheel.position[0] - wheelButtonDrawSize / 2),
    Math.round(centerY + cl.wheel.position[1] - wheelButtonDrawSize / 2),
    wheelButtonDrawSize,
    wheelButtonDrawSize,
    "/gfx/wheelbutton.png",
    withAlpha(COLOR_WHITE, wheelAlpha * 0.5),
  );
}

// CL_Wheel_Precache (wheel.c:602-611). Draw-by-name means there's no handle
// to keep -- just cache the base wheel-circle pic's size for
// getWheelDrawSize() above, matching R_GetPicSize's one real caller.
export function CL_Wheel_Precache(): void {
  if (re) {
    const size = re.DrawGetPicSize("/gfx/weaponwheel.png");
    wheelPicSize = size.w > 0 ? size.w : 0;
  }
  cl.wheel.timescale = 1.0;
}
