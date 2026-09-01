// cl_seats.ts -- LOCAL SPLITSCREEN SEATS, client side.
//
// An ORIGINAL module of this port (same status as menu_content.ts): there is
// no C original to cite a basename from, because no reference engine
// available here implements local splitscreen. src/server/sv_seats.ts's
// header carries the full, cited reference audit; the three facts that shape
// this file are:
//
//   * q2repro renders exactly one viewport per screen update and says so
//     ("Note: isplit is ignored, due to missing split screen support",
//     src/client/cgame_classic.c:858). There is no layout math to copy.
//   * The 2023 game/cgame source (quake2-rerelease-dll) specifies only what
//     the GAME side does with a seat: hud_data[isplit] (cg_screen.cpp:107),
//     `isplit` kept DISTINCT from `playernum` on DrawHUD (game.h:2270), and
//     `if (isplit == 0)` gating the chat input line (cg_screen.cpp:202,
//     "only the main player can really chat anyways"). It never computes a
//     rect: the engine hands it a finished hud_vrect.
//   * The wire cannot carry a second local player at all -- q2proto's
//     kex codec rejects a splitscreen serverdata outright
//     (q2proto_proto_kex.c:56-57) and skips svc_splitclient's isplit byte
//     without surfacing it (:798-804).
//
// So: the LAYOUT is invented here (and pinned by tests rather than by a
// citation), the HUD contract is honored as the reference specifies it, and
// the seats are local server clients rather than wire participants.
//
// SEAT 0 IS UNTOUCHED. Seat 0 is the ordinary client: keyboard/mouse, the
// bind system, the menu, the console, cl.viewangles, CL_CreateCmd,
// prediction, the netchan. Nothing in this file runs for it. Seats 1..N-1
// are gamepad-only and bypass the bind system entirely (a bind is global
// state; two seats cannot both own `+attack`), reading a fixed pad->action
// map instead -- which is also what a console engine does, since a console
// seat has no keyboard to rebind with. `seatcmd` (below) is the one console
// affordance they have: a game client command run as a named seat.
//
// A seat also RECEIVES: the server unicasts it centerprints, prints and
// private sounds, which sv_seats.ts captures (nothing transmits them -- a seat
// has no netchan) and CL_Seats_DrainServerMessages decodes into the seat that
// owns them, once per client frame.

import { Cvar_Get, Cvar_Set, Cvar_VariableValue } from "../qcommon/cvar";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { Com_Printf, Com_DPrintf } from "../qcommon/common";
import { UsercmdT, ANGLE2SHORT, SHORT2ANGLE, PITCH, YAW, ROLL, CVAR_ARCHIVE, MAX_ITEMS, type CvarT } from "../shared/q_shared";
import { SvcOpsT } from "../qcommon/qcommon";
import { SizeBuf, SZ_Init, MSG_BeginReading, MSG_ReadByte, MSG_ReadShort, MSG_ReadString } from "../qcommon/sizebuf";
import { ButtonT, PrintTypeT } from "../kexapi/game";
import { GamepadAxisNormalize, SDL_CONTROLLER_BUTTON_A, SDL_CONTROLLER_BUTTON_B, SDL_CONTROLLER_BUTTON_X, SDL_CONTROLLER_BUTTON_Y, SDL_CONTROLLER_BUTTON_LEFTSHOULDER, SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, GAMEPAD_TRIGGER_THRESHOLD } from "../platform/gamepad_map";
import { SDL_GamepadSeatState, SDL_GamepadSeatCount, type GamepadSeatStateT } from "../platform/sdl";
import { viddef } from "./vid";
import { cl, cls, ConnstateT, KeydestT, clCvars } from "./client";
import { SCR_CenterPrintSeat } from "./cl_scrn";
import { CL_ParseStartSoundPacket, SND_VOLUME, SND_ATTENUATION, SND_POS, SND_ENT, SND_OFFSET } from "./cl_parse";
import {
  MAX_LOCAL_SEATS,
  SV_AddLocalSeat,
  SV_RemoveLocalSeats,
  SV_NumLocalSeats,
  SV_QueueLocalSeatCmd,
  SV_LocalSeatPlayerState,
  SV_LocalSeatPlayernum,
  SV_TakeLocalSeatMessages,
  type SeatMessageChunkT,
} from "../server/sv_seats";
import { sv, svs, maxclients, ClientStateT, ServerStateT } from "../server/server";
import type { PlayerStateT } from "../shared/q_shared";

export { MAX_LOCAL_SEATS };

// ---------------------------------------------------------------------------
// VIEWPORT LAYOUT (pure)
// ---------------------------------------------------------------------------

export interface SeatViewportT {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 0 = auto (by aspect), 1 = side-by-side (a VERTICAL divider), 2 = stacked
 *  (a HORIZONTAL divider). Only meaningful for two seats: three and four
 *  seats are always quadrants, which is the only layout that tiles. */
export const SPLIT_LAYOUT_AUTO = 0;
export const SPLIT_LAYOUT_SIDE_BY_SIDE = 1;
export const SPLIT_LAYOUT_STACKED = 2;

/*
Two-seat auto rule: side-by-side once the display is wider than 3:2, stacked
otherwise. Rationale, stated plainly because there is no reference to cite:
splitting along the LONG axis is what keeps each pane's aspect closest to the
full screen's, so a 16:9 display halved side-by-side gives two 8:9 panes
(worse) versus two 16:4.5 panes stacked (also worse) -- the tie is broken
toward side-by-side on wide displays because horizontal field of view is what
players aim with, and CalcFov (cl_view.ts) derives fov_y from fov_x and the
pane's own aspect, so a full-width stacked pane keeps the full horizontal fov
while a half-width pane halves it. 3:2 is the threshold at which a stacked
pane's height stops being usable for the HUD.
*/
const SIDE_BY_SIDE_ASPECT = 1.5;

// Same alignment SCR_CalcVrect (cl_scrn.ts) applies to the single-viewport
// rect: width to a multiple of 8, height to a multiple of 2. ref_soft's span
// rasterizer wants the byte-aligned width; keeping the rule identical means a
// one-seat session and seat 0 of a split session are rounded the same way.
// The few pixels each pane gives up become the gutter between panes, which is
// exactly the divider a split screen wants.
function alignRect(x: number, y: number, width: number, height: number): SeatViewportT {
  return { x, y, width: Math.max(8, width & ~7), height: Math.max(2, height & ~1) };
}

export function SplitscreenLayout(count: number, width: number, height: number, mode: number): SeatViewportT[] {
  const n = Math.min(Math.max(Math.trunc(count), 1), MAX_LOCAL_SEATS);
  if (n <= 1) return [alignRect(0, 0, width, height)];

  const halfW = Math.trunc(width / 2);
  const halfH = Math.trunc(height / 2);

  if (n === 2) {
    const sideBySide = mode === SPLIT_LAYOUT_SIDE_BY_SIDE || (mode !== SPLIT_LAYOUT_STACKED && width / height >= SIDE_BY_SIDE_ASPECT);
    if (sideBySide) {
      return [alignRect(0, 0, halfW, height), alignRect(halfW, 0, width - halfW, height)];
    }
    return [alignRect(0, 0, width, halfH), alignRect(0, halfH, width, height - halfH)];
  }

  // Three and four seats are quadrants; with three, the bottom-right cell is
  // left empty rather than stretching one pane, so every pane keeps the same
  // aspect and the same HUD scale.
  const quads = [alignRect(0, 0, halfW, halfH), alignRect(halfW, 0, width - halfW, halfH), alignRect(0, halfH, halfW, height - halfH), alignRect(halfW, halfH, width - halfW, height - halfH)];
  return quads.slice(0, n);
}

// ---------------------------------------------------------------------------
// SEAT INPUT (pure, given a pad snapshot)
// ---------------------------------------------------------------------------

/*
Fixed pad -> action map for seats 1..N-1. Deliberately NOT routed through
keys.ts binds: a bind is one global table, so two seats pressing the same
physical button would both resolve to the same `+attack` kbutton and fight
over its state. A console seat has no keyboard to rebind with either, so a
fixed map is also the shape the feature actually has.

Chosen to match the layout the retail default.cfg gamepad binds already
establish for seat 0 (this port's own src/platform/gamepad_map.ts):
right trigger fires, A jumps, B crouches, X uses, shoulders cycle weapons.
*/
export const SEAT_PAD_BUTTON_JUMP = SDL_CONTROLLER_BUTTON_A;
export const SEAT_PAD_BUTTON_CROUCH = SDL_CONTROLLER_BUTTON_B;
export const SEAT_PAD_BUTTON_USE = SDL_CONTROLLER_BUTTON_X;
export const SEAT_PAD_BUTTON_HOLSTER = SDL_CONTROLLER_BUTTON_Y;
export const SEAT_PAD_BUTTON_WEAPPREV = SDL_CONTROLLER_BUTTON_LEFTSHOULDER;
export const SEAT_PAD_BUTTON_WEAPNEXT = SDL_CONTROLLER_BUTTON_RIGHTSHOULDER;

// SDL reports triggers over the full signed range with 0 at rest; the same
// fraction-of-full-scale threshold gamepad_map.ts uses for seat 0's trigger
// -> Key_Event conversion decides "pressed" here.
const TRIGGER_ON = GAMEPAD_TRIGGER_THRESHOLD * 32767;

function held(buttons: number, bit: number): boolean {
  return (buttons & (1 << bit)) !== 0;
}

/** Per-seat mutable input and view state. viewangles is the seat's own camera;
 *  `cl` only ever holds seat 0's, and the same is true of the crouch-transition
 *  eye-height lerp below. */
export class SeatInputStateT {
  viewangles: Float32Array = new Float32Array(3);
  /** Pad button bitmask as of the previous frame -- edge detection for the
   *  weapon-cycle shoulders, which must fire once per press and not once per
   *  frame the button is held. */
  prevButtons = 0;
  /** Set when this seat's pad asked for a weapon change this frame; drained
   *  by CL_Seats_SendCmds, which is the only place allowed to run a server
   *  command on the seat's behalf. */
  pendingCommand: string | null = null;

  // [Paril-KEX] re-release eye height, this seat's copy of client.ts's
  // cl.current_viewheight/prev_viewheight/viewheight_change_time (which are
  // the primary client's and cannot carry a second player). Same int8_t
  // values, same cl.time-scale change stamp -- see CL_Seat_ViewHeight.
  current_viewheight = 0;
  prev_viewheight = 0;
  viewheight_change_time = 0;
}

/*
==================
CL_Seat_ViewHeight

The seat's eye height for this frame, eased exactly the way the primary
client's is (q2repro client/entities.c:1528-1536 records the change,
:1605-1609 eases it: `viewheight_lerp = 100 - min(cl.time - change_time,
100); viewheight = current + (prev - current) * viewheight_lerp * 0.01;`),
against this seat's own lerp state instead of cl's.

Idempotent within a frame: re-reading the same viewheight at the same time
records no new change, so a second call in the same frame (a stereo pass, a
test driving the same values twice) returns the same number.
==================
*/
export function CL_Seat_ViewHeight(seat: number, viewheight: number, time: number): number {
  const state = seat_input[seat];
  if (!state) return viewheight;

  if (state.current_viewheight !== viewheight) {
    state.prev_viewheight = state.current_viewheight;
    state.current_viewheight = viewheight;
    state.viewheight_change_time = time;
  }

  let viewheight_lerp = time - state.viewheight_change_time;
  viewheight_lerp = 100 - Math.min(viewheight_lerp, 100);
  return state.current_viewheight + (state.prev_viewheight - state.current_viewheight) * viewheight_lerp * 0.01;
}

/** Start a seat at a known eye height with no transition in flight -- what
 *  cl_ents.ts does for seat 0 when a fresh frame arrives (current and prev
 *  both the current value, no change stamp), so a just-seated player does not
 *  ease in from the floor. */
export function CL_Seat_ResetViewHeight(seat: number, viewheight: number): void {
  const state = seat_input[seat];
  if (!state) return;
  state.current_viewheight = viewheight;
  state.prev_viewheight = viewheight;
  state.viewheight_change_time = 0;
}

export interface SeatCmdCvarsT {
  forwardspeed: number;
  sidespeed: number;
  upspeed: number;
  yawspeed: number;
  pitchspeed: number;
  deadzone: number;
  forwardsensitivity: number;
  sidesensitivity: number;
  yawsensitivity: number;
  pitchsensitivity: number;
}

/*
Builds one seat's usercmd from a pad snapshot. Pure: every input is an
argument and the only mutation is on the caller-owned SeatInputStateT, so the
whole of seat input is testable without SDL, a window, or a server.

Stick handling mirrors IN_JoyMove (platform/sdl.ts) exactly -- same
GamepadAxisNormalize deadzone, same "SDL's Y axis is positive down so
negative Y is forward" convention, same cvar set and the same
frametime-scaled look integration -- so seat 1 and seat 0 feel identical on
identical hardware.
*/
export function CL_Seat_BuildCmd(state: SeatInputStateT, pad: GamepadSeatStateT, frametime: number, msec: number, cvars: SeatCmdCvarsT, deltaAnglePitch: number): UsercmdT {
  const cmd = new UsercmdT();
  cmd.msec = msec > 250 ? 100 : msec; // "time was unreasonable", CL_FinishMove

  const dz = cvars.deadzone;
  const lx = GamepadAxisNormalize(pad.leftX, dz);
  const ly = GamepadAxisNormalize(pad.leftY, dz);
  const rx = GamepadAxisNormalize(pad.rightX, dz);
  const ry = GamepadAxisNormalize(pad.rightY, dz);

  cmd.forwardmove = cvars.forwardspeed * cvars.forwardsensitivity * -ly;
  cmd.sidemove = cvars.sidespeed * cvars.sidesensitivity * lx;

  state.viewangles[YAW] -= frametime * cvars.yawspeed * cvars.yawsensitivity * rx;
  state.viewangles[PITCH] += frametime * cvars.pitchspeed * cvars.pitchsensitivity * ry;
  state.viewangles[ROLL] = 0;

  CL_Seat_ClampPitch(state, deltaAnglePitch);

  // CL_ClampSpeed's own 400 unit ceiling (cl_input.ts), applied for the same
  // reason: the server clamps to it anyway and an unclamped value just wastes
  // wire/precision.
  if (cmd.forwardmove > 400) cmd.forwardmove = 400;
  else if (cmd.forwardmove < -400) cmd.forwardmove = -400;
  if (cmd.sidemove > 400) cmd.sidemove = 400;
  else if (cmd.sidemove < -400) cmd.sidemove = -400;

  const buttons = pad.buttons;

  if (pad.triggerR >= TRIGGER_ON) cmd.buttons |= ButtonT.BUTTON_ATTACK;
  if (held(buttons, SEAT_PAD_BUTTON_USE)) cmd.buttons |= ButtonT.BUTTON_USE;
  if (held(buttons, SEAT_PAD_BUTTON_HOLSTER)) cmd.buttons |= ButtonT.BUTTON_HOLSTER;

  if (held(buttons, SEAT_PAD_BUTTON_JUMP)) {
    cmd.buttons |= ButtonT.BUTTON_JUMP;
    cmd.upmove = cvars.upspeed;
  }
  if (held(buttons, SEAT_PAD_BUTTON_CROUCH)) {
    cmd.buttons |= ButtonT.BUTTON_CROUCH;
    cmd.upmove = -cvars.upspeed;
  }

  if (cmd.buttons) cmd.buttons |= ButtonT.BUTTON_ANY;

  // Weapon cycling is a server COMMAND ("weapnext"/"weapprev"), not a button
  // bit and not an impulse: the kex game module has no ucmd.impulse handling
  // at all (grepped p_client/p_weapon/g_cmds -- zero matches), so the only
  // faithful route is the same ClientCommand path a keyboard bind takes.
  // Edge-triggered so holding the shoulder does not cycle every frame.
  const pressed = buttons & ~state.prevButtons;
  if (pressed & (1 << SEAT_PAD_BUTTON_WEAPNEXT)) state.pendingCommand = "weapnext";
  else if (pressed & (1 << SEAT_PAD_BUTTON_WEAPPREV)) state.pendingCommand = "weapprev";
  state.prevButtons = buttons;

  for (let i = 0; i < 3; i++) cmd.angles[i] = ANGLE2SHORT(state.viewangles[i]);

  return cmd;
}

/** CL_ClampPitch (cl_input.ts) against a seat's own viewangles and its own
 *  server playerstate's delta_angles, instead of cl.viewangles and
 *  cl.frame's. Same arithmetic, different storage. */
export function CL_Seat_ClampPitch(state: SeatInputStateT, deltaAnglePitchShort: number): void {
  let pitch = SHORT2ANGLE(deltaAnglePitchShort);
  if (pitch > 180) pitch -= 360;

  if (state.viewangles[PITCH] + pitch < -360) state.viewangles[PITCH] += 360; // wrapped
  if (state.viewangles[PITCH] + pitch > 360) state.viewangles[PITCH] -= 360; // wrapped

  if (state.viewangles[PITCH] + pitch > 89) state.viewangles[PITCH] = 89 - pitch;
  if (state.viewangles[PITCH] + pitch < -89) state.viewangles[PITCH] = -89 - pitch;
}

// ---------------------------------------------------------------------------
// RUNTIME
// ---------------------------------------------------------------------------

let cl_seats: CvarT | null = null;
let cl_splitscreen_layout: CvarT | null = null;

const seat_input: SeatInputStateT[] = Array.from({ length: MAX_LOCAL_SEATS }, () => new SeatInputStateT());

// Seat count the session was STARTED with. The cvar can be changed at any
// time from the console; a change only takes effect on the next
// CL_Seats_Reconcile, which is also where the seats are (re-)created after a
// level change, so the two never disagree mid-frame.
let active_seats = 1;

/** Pad snapshot source. Swappable so seat input is testable with no SDL
 *  library present -- the same seam shape platform/sdl.ts's own
 *  SDL_ResetBackendForTests establishes for the rest of the backend. */
export interface SeatPadSourceT {
  count(): number;
  state(slot: number): GamepadSeatStateT | null;
}

let pad_source: SeatPadSourceT = {
  count: SDL_GamepadSeatCount,
  state: SDL_GamepadSeatState,
};

export function CL_Seats_SetPadSource(src: SeatPadSourceT | null): void {
  pad_source = src ?? { count: SDL_GamepadSeatCount, state: SDL_GamepadSeatState };
}

/*
==================
CL_SeatCmd_f

`seatcmd <seat> <command...>` -- run a GAME client command as one of the local
seats, the way typing it at the console runs it as the primary player. Seats
1..N-1 are pad-only (see this file's header: a bind is one global table, so
they cannot own `+attack` or a keyboard command of their own), which leaves
the fixed pad map as their entire command vocabulary; this is the console-side
counterpart, and it goes through exactly the same queue the pad's
weapnext/weapprev already uses -- parked here, executed inside SV_Frame by
SV_RunLocalSeatThinks (see sv_seats.ts's LocalSeatT.pendingCmd for why a seat
command may not run outside the server frame).

Seat 0 is refused: it is the ordinary client, and its game commands are what
the console already sends.
==================
*/
function CL_SeatCmd_f(): void {
  if (Cmd_Argc() < 3) {
    Com_Printf("usage: seatcmd <seat 1-%i> <command ...>\n", MAX_LOCAL_SEATS - 1);
    return;
  }

  const seat = Math.trunc(Number(Cmd_Argv(1)));
  if (!Number.isFinite(seat) || seat < 1 || seat >= MAX_LOCAL_SEATS) {
    Com_Printf("seatcmd: seat must be 1..%i (seat 0 is the console's own player)\n", MAX_LOCAL_SEATS - 1);
    return;
  }
  if (seat >= active_seats) {
    Com_Printf("seatcmd: seat %i is not seated (cl_seats is %i)\n", seat, active_seats);
    return;
  }

  const parts: string[] = [];
  for (let i = 2; i < Cmd_Argc(); i++) parts.push(Cmd_Argv(i));
  const command = parts.join(" ");
  if (!command) return;

  seat_input[seat].pendingCommand = command;
}

export function CL_Seats_Init(): void {
  // Not CVAR_ARCHIVE: a seat count is a property of the session you launched,
  // not a preference to restore into a single-player game on next boot.
  cl_seats = Cvar_Get("cl_seats", "1", 0);
  cl_splitscreen_layout = Cvar_Get("cl_splitscreen_layout", "0", CVAR_ARCHIVE);
  Cmd_AddCommand("seatcmd", CL_SeatCmd_f);

  // A `+set cl_seats N` on the command line has already been applied to the
  // cvar by now, and the command line's own `+map`/`+load` has NOT run yet, so
  // this is the point at which widening the latched server cvars still reaches
  // the first server this session starts.
  CL_Seats_WidenServerCvars(CL_Seats_Requested());
}

/** Requested seat count, clamped. Reads the cvar so a console `cl_seats 2`
 *  works exactly like the menu selector. */
export function CL_Seats_Requested(): number {
  const v = cl_seats ? Math.trunc(cl_seats.value) : 1;
  return Math.min(Math.max(v, 1), MAX_LOCAL_SEATS);
}

/** Seats actually running right now: 1 (no split) up to MAX_LOCAL_SEATS. */
export function CL_Seats_Count(): number {
  return active_seats;
}

export function CL_Seats_Active(): boolean {
  return active_seats > 1;
}

export function CL_Seats_Viewports(): SeatViewportT[] {
  return SplitscreenLayout(active_seats, viddef.width, viddef.height, cl_splitscreen_layout ? Math.trunc(cl_splitscreen_layout.value) : SPLIT_LAYOUT_AUTO);
}

/** The playerstate driving seat `i`'s viewport. Seat 0 is the ordinary
 *  client's own frame; seats past it are read live out of the local server. */
export function CL_Seats_PlayerState(seat: number): PlayerStateT | null {
  if (seat === 0) return cl.frame.playerstate;
  return SV_LocalSeatPlayerState(seat - 1);
}

export function CL_Seats_Playernum(seat: number): number {
  if (seat === 0) return cl.playernum;
  return SV_LocalSeatPlayernum(seat - 1);
}

// ---------------------------------------------------------------------------
// SERVER-TO-SEAT MESSAGES
// ---------------------------------------------------------------------------

/*
The game unicasts a seat its own centerprints, prints and private sounds
exactly as it does for a real connection; sv_seats.ts captures those writes
per seat (SEAT MESSAGE CAPTURE there) instead of transmitting them, because a
seat has no netchan. This is the other end: the same svc_* opcodes the primary
client's CL_ParseServerMessage reads, decoded out of that capture and applied
to the SEAT that owns them.

WHAT IS ACTED ON
  svc_centerprint          -> that seat's pane (SCR_CenterPrintSeat)
  svc_print PRINT_CENTER /
            PRINT_TYPEWRITER -> the same, matching cl_parse.ts's own
                              svc_print branch (q2repro parse.c:970-1001)
  svc_print, other levels  -> the shared console, tagged with the seat, and
                              only when the payload was not also sent to the
                              primary connection (a broadcast print is one
                              message, not one per local player)
  svc_sound                -> S_StartSound through cl_parse.ts's own
                              CL_ParseStartSoundPacket, again only when the
                              payload was seat-directed rather than a
                              multicast the primary connection already played

WHAT IS DECODED AND DROPPED, AND WHY
  svc_stufftext     the console/cbuf is one shared thing. A seat's stuffed
                    text is connection handshake ("precache", "cmd ...") for
                    a connection it does not have, and running it would
                    execute it as the PRIMARY player. Reported at developer
                    level rather than executed.
  svc_layout        the pane HUD draws from the seat's playerstate plus the
                    connection's layout string (cl.layout); a per-seat layout
                    would need its own storage on both sides of the cgame
                    DrawHUD boundary, which is a bigger change than this one.
  svc_inventory     same shape: cl.inventory is the primary's, and the
                    inventory/carousel screens are seat-0 chrome
                    (SCR_DrawSeatViews' own note).
  svc_configstring, svc_temp_entity, svc_muzzleflash(2), everything else:
                    shared world state. Every seat's copy is a duplicate of
                    what the primary connection already applied -- acting on
                    it a second time would double the effect, not add one.

Anything whose length this decoder does not know (svc_temp_entity above all,
whose payload is a per-type table) costs its own WRITE and no more: the
capture records where each write began, so the decoder resyncs at the next
boundary instead of losing the rest of the frame.
*/

/** Byte length of a vanilla svc_sound payload (sv_send.ts's SV_StartSound /
 *  sv_game.ts's PF_LocalSound write exactly these fields, and cl_parse.ts's
 *  CL_ParseStartSoundPacket reads them back), given its flags byte. Used to
 *  step over a sound this seat should not play a second time. */
function seatSoundPayloadLength(flags: number): number {
  let len = 2; // flags, soundindex
  if (flags & SND_VOLUME) len += 1;
  if (flags & SND_ATTENUATION) len += 1;
  if (flags & SND_OFFSET) len += 1;
  if (flags & SND_ENT) len += 2;
  if (flags & SND_POS) len += 6;
  return len;
}

class SeatMessageStreamT {
  readonly msg = new SizeBuf();
  /** 1 per byte: this byte belongs to a payload the primary connection got too. */
  readonly shared: Uint8Array;
  /** Offset of each captured write, ascending -- the decoder's resync points. */
  readonly starts: number[] = [];

  constructor(chunks: readonly SeatMessageChunkT[]) {
    let total = 0;
    for (const chunk of chunks) total += chunk.bytes.length;

    const data = new Uint8Array(total);
    this.shared = new Uint8Array(total);

    let offset = 0;
    for (const chunk of chunks) {
      this.starts.push(offset);
      data.set(chunk.bytes, offset);
      if (chunk.shared) this.shared.fill(1, offset, offset + chunk.bytes.length);
      offset += chunk.bytes.length;
    }

    SZ_Init(this.msg, data, total);
    this.msg.cursize = total;
    MSG_BeginReading(this.msg);
  }

  /** True when every byte of [start, end) came from a payload the primary
   *  connection was sent as well. */
  isShared(start: number, end: number): boolean {
    if (end <= start) return false;
    for (let i = start; i < end; i++) if (!this.shared[i]) return false;
    return true;
  }

  /** Give up on the message that started at `start` and continue at the next
   *  captured write. Returns false when there is nothing left. */
  resync(start: number): boolean {
    for (const offset of this.starts) {
      if (offset > start) {
        this.msg.readcount = offset;
        return true;
      }
    }
    this.msg.readcount = this.msg.cursize;
    return false;
  }
}

/** What the last decode did, per kind. Production reads none of this; it is
 *  how a suite (and `developer 1`, below) sees which branch a captured
 *  message took without a screen or a sound device. */
export interface SeatMessageStatsT {
  centerprints: number;
  prints: number;
  /** Prints dropped because the primary connection got the same payload. */
  printsShared: number;
  sounds: number;
  /** Sounds dropped for the same reason. */
  soundsShared: number;
  /** Writes stepped over because this decoder does not know their length. */
  skipped: number;
}

const seat_message_stats: SeatMessageStatsT = { centerprints: 0, prints: 0, printsShared: 0, sounds: 0, soundsShared: 0, skipped: 0 };

function CL_Seat_DispatchServerMessages(seat: number, chunks: readonly SeatMessageChunkT[]): void {
  const stream = new SeatMessageStreamT(chunks);
  const msg = stream.msg;

  while (msg.readcount < msg.cursize) {
    const start = msg.readcount;
    const cmd = MSG_ReadByte(msg);
    if (cmd === -1) break;

    switch (cmd) {
      case SvcOpsT.svc_nop:
      case SvcOpsT.svc_disconnect:
      case SvcOpsT.svc_reconnect:
        // Connection-level, and a seat has no connection to end or remake.
        break;

      case SvcOpsT.svc_centerprint: {
        const text = MSG_ReadString(msg);
        seat_message_stats.centerprints++;
        Com_DPrintf("cl_seats: seat %i centerprint: %s\n", seat + 1, text);
        SCR_CenterPrintSeat(seat, text);
        break;
      }

      case SvcOpsT.svc_print: {
        const level = MSG_ReadByte(msg);
        const text = MSG_ReadString(msg);
        if (level === PrintTypeT.PRINT_CENTER || level === PrintTypeT.PRINT_TYPEWRITER) {
          // instant for PRINT_CENTER, typed out for PRINT_TYPEWRITER -- the
          // same split cl_parse.ts's svc_print branch makes for seat 0.
          seat_message_stats.centerprints++;
          Com_DPrintf("cl_seats: seat %i centerprint (print level %i): %s\n", seat + 1, level, text);
          SCR_CenterPrintSeat(seat, text, level !== PrintTypeT.PRINT_TYPEWRITER);
        } else if (stream.isShared(start, msg.readcount)) {
          seat_message_stats.printsShared++;
        } else {
          seat_message_stats.prints++;
          Com_Printf("[P%i] %s", seat + 1, text);
        }
        break;
      }

      case SvcOpsT.svc_sound: {
        const flags = msg.data[msg.readcount] ?? 0;
        const end = msg.readcount + seatSoundPayloadLength(flags);
        if (stream.isShared(start, end)) {
          seat_message_stats.soundsShared++;
          msg.readcount = end;
        } else {
          seat_message_stats.sounds++;
          CL_ParseStartSoundPacket(msg);
        }
        break;
      }

      case SvcOpsT.svc_stufftext: {
        const text = MSG_ReadString(msg);
        Com_DPrintf("cl_seats: seat %i stufftext dropped: %s\n", seat + 1, text);
        break;
      }

      case SvcOpsT.svc_layout:
        MSG_ReadString(msg);
        break;

      case SvcOpsT.svc_configstring:
        MSG_ReadShort(msg);
        MSG_ReadString(msg);
        break;

      case SvcOpsT.svc_inventory:
        // MAX_ITEMS shorts, cl_inv.ts's CL_ParseInventory.
        msg.readcount += MAX_ITEMS * 2;
        break;

      case SvcOpsT.svc_muzzleflash:
      case SvcOpsT.svc_muzzleflash2:
        msg.readcount += 3; // entity short + the flash byte
        break;

      default:
        // Not a length this decoder knows (svc_temp_entity and friends).
        seat_message_stats.skipped++;
        if (!stream.resync(start)) return;
        break;
    }
  }
}

/*
==================
CL_Seats_DrainServerMessages

Once per client frame, before the panes are drawn: whatever the server wrote
to each seat since the last frame, decoded and applied to that seat.
==================
*/
export function CL_Seats_DrainServerMessages(): void {
  if (active_seats <= 1) return;

  for (let seat = 1; seat < active_seats; seat++) {
    const chunks = SV_TakeLocalSeatMessages(seat - 1);
    if (chunks.length === 0) continue;
    CL_Seat_DispatchServerMessages(seat, chunks);
  }
}

/** Test seam: what the decoder did with everything it has been handed. */
export function CL_Seats_MessageStatsForTests(): SeatMessageStatsT {
  return { ...seat_message_stats };
}

/** Test seam: zero the decode counters. */
export function CL_Seats_ResetMessageStatsForTests(): void {
  seat_message_stats.centerprints = 0;
  seat_message_stats.prints = 0;
  seat_message_stats.printsShared = 0;
  seat_message_stats.sounds = 0;
  seat_message_stats.soundsShared = 0;
  seat_message_stats.skipped = 0;
}

/*
==================
CL_Seats_Reconcile

Brings the seat table in line with cl_seats and the current connection state,
once per frame. This is also what re-seats everyone after a level change: the
seats' edicts do not survive SV_SpawnServer any more than a real connection's
do, so they are torn down whenever the primary client leaves ca_active and
rebuilt when it comes back.
==================
*/
export function CL_Seats_Reconcile(): void {
  const want = CL_Seats_Requested();

  // Splitscreen needs a local server: a seat is a server client created
  // in-process (sv_seats.ts), and there is no wire representation for one.
  const canSeat = cls.state === ConnstateT.ca_active && Com_LocalServerRunning();

  if (want <= 1 || !canSeat) {
    if (active_seats > 1 || SV_NumLocalSeats() > 0) {
      SV_RemoveLocalSeats();
      active_seats = 1;
    }
    // Leaving the game (or asking for one seat) clears the "already tried and
    // reported" latch, so the next server gets a fresh attempt.
    seating_blocked_for = 0;
    return;
  }

  const seated = SV_NumLocalSeats();
  if (seated === want - 1) {
    active_seats = want;
    return;
  }

  // This exact seat count was already attempted against this server and did
  // not fit. Retrying every frame would re-seat, re-fail and re-print forever;
  // the latch is dropped by the branch above the moment the session changes.
  if (seating_blocked_for === want) return;

  // Any mismatch (count changed, or a level change wiped the seats) is
  // resolved by tearing down and re-seating, rather than by patching the
  // difference: seating order determines player slot order, and a partial
  // rebuild would silently renumber the seats.
  SV_RemoveLocalSeats();
  active_seats = 1;

  for (let i = 1; i < want; i++) {
    let seat: number | null = null;
    try {
      seat = SV_AddLocalSeat(`\\name\\Player ${i + 1}\\skin\\male/grunt\\hand\\0\\fov\\90\\msg\\1\\rate\\25000`);
    } catch (err) {
      // A game module that refuses a seat by throwing (rather than by
      // returning allowed:false from ClientConnect) must not take the whole
      // client down with it: the session is still perfectly playable with
      // fewer seats. Reported, not swallowed silently.
      Com_Printf("cl_seats: seating local player %i failed: %s\n", i + 1, err instanceof Error ? err.message : String(err));
      break;
    }
    if (seat === null) {
      Com_Printf("cl_seats: could not seat local player %i; continuing with %i\n", i + 1, i);
      break;
    }
    // A fresh seat starts looking wherever the game spawned it, and at the eye
    // height the game spawned it at (cl_ents.ts does the same for seat 0 on a
    // fresh frame: current and prev both the current value, no change stamp,
    // so the first frame does not ease in from zero).
    const ps = SV_LocalSeatPlayerState(seat);
    if (ps) for (let a = 0; a < 3; a++) seat_input[i].viewangles[a] = ps.viewangles[a];
    seat_input[i].prevButtons = 0;
    seat_input[i].pendingCommand = null;
    CL_Seat_ResetViewHeight(i, ps ? ps.pmove.viewheight : 0);
    active_seats = i + 1;
  }

  if (active_seats < want) {
    // Fewer seats than asked for: the server has no room. Widen the cvars a
    // wider server needs (they are CVAR_LATCH, so this takes effect at the
    // next SV_InitGame, not now) and say so once, with the command that
    // applies it -- the alternative is the silent one-seat session this used
    // to be.
    CL_Seats_WidenServerCvars(want);
    seating_blocked_for = want;
    Com_Printf("cl_seats %i: this server seats %i local player%s (maxclients %i, %i free slot%s).\n", want, active_seats, active_seats === 1 ? "" : "s", seatCapacity(), freePlayerSlots(), freePlayerSlots() === 1 ? "" : "s");
    Com_Printf("cl_seats: coop/maxclients widened for the next server start -- run `map %s` to seat %i.\n", sv.name ? sv.name : "<map>", want);
  }

  if (active_seats !== reported_seats) {
    reported_seats = active_seats;
    Com_Printf("cl_seats: %i local player%s\n", active_seats, active_seats === 1 ? "" : "s");
  }
}

// Only printed on a transition -- CL_Seats_Reconcile runs every client frame.
let reported_seats = 1;
// Seat count already attempted against the running server and reported as not
// fitting; 0 when nothing is latched off.
let seating_blocked_for = 0;

/** Player slots this server actually has. `maxclients` is CVAR_LATCH, so a
 *  change made after SV_InitGame allocated svs.clients is visible on the cvar
 *  but not in the array -- the smaller of the two is what can be seated, the
 *  same bound SV_AddLocalSeat's own free-slot search uses. */
function seatCapacity(): number {
  return Math.min(maxclients ? maxclients.value : 0, svs.clients.length);
}

function freePlayerSlots(): number {
  let free = 0;
  const capacity = seatCapacity();
  for (let i = 0; i < capacity; i++) if (svs.clients[i].state === ClientStateT.cs_free) free++;
  return free;
}

/*
==================
CL_Seats_WidenServerCvars

The rule PerformLaunch applies when the menu starts a split session
(menu_content.ts:269-281), applied to a seat count that arrived any other way
-- `+set cl_seats 2` on the command line, or `cl_seats 2` typed at the
console. Without it, a default single-player launch forces `maxclients 1`
(sv_init.ts's SV_InitGame: not deathmatch, not coop -> one slot) and there is
physically no slot for a second local player, whatever cl_seats says.

More than one seat IS a coop session -- the extra players need coop spawn and
respawn rules, and a campaign started any other way has nowhere to put them.
A deathmatch server is left alone: it already seats eight, and forcing coop
onto it would change the game being played.

Both cvars are CVAR_LATCH: this makes the NEXT server start able to seat
them. Called before any server exists (CL_Seats_Init, i.e. before the command
line's own `+map` runs) and again when a running server turns out to be too
small, where CL_Seats_Reconcile prints the command that applies it.
==================
*/
export function CL_Seats_WidenServerCvars(want: number): void {
  if (want <= 1) return;

  if (Cvar_VariableValue("deathmatch") <= 0 && Cvar_VariableValue("coop") < 1) Cvar_Set("coop", "1");
  if (Cvar_VariableValue("maxclients") <= 1) Cvar_Set("maxclients", "4");
  if (Cvar_VariableValue("maxclients") < want) Cvar_Set("maxclients", String(want));
}

/*
==================
CL_Seats_SendCmds

Seat 0's move is built and transmitted by CL_SendCmd (cl_input.ts) and is not
touched here. Seats 1..N-1 have no netchan to transmit down, so their move
goes where a transmitted one would have ended up anyway: straight into the
game module via SV_LocalSeatThink.
==================
*/
export function CL_Seats_SendCmds(): void {
  if (active_seats <= 1) return;
  // A seat should not be able to move while the local player has the menu or
  // console up, for the same reason IN_JoyMove is gated on key_game: the
  // session is paused/attention is elsewhere.
  if (cls.key_dest !== KeydestT.key_game) return;

  const cvars: SeatCmdCvarsT = {
    forwardspeed: clCvars.cl_forwardspeed ? clCvars.cl_forwardspeed.value : 0,
    sidespeed: clCvars.cl_sidespeed ? clCvars.cl_sidespeed.value : 0,
    upspeed: clCvars.cl_upspeed ? clCvars.cl_upspeed.value : 0,
    yawspeed: clCvars.cl_yawspeed ? clCvars.cl_yawspeed.value : 0,
    pitchspeed: clCvars.cl_pitchspeed ? clCvars.cl_pitchspeed.value : 0,
    deadzone: Cvar_Get("joy_deadzone", "0.15", 0)?.value ?? 0.15,
    forwardsensitivity: Cvar_Get("joy_forwardsensitivity", "1", 0)?.value ?? 1,
    sidesensitivity: Cvar_Get("joy_sidesensitivity", "1", 0)?.value ?? 1,
    yawsensitivity: Cvar_Get("joy_yawsensitivity", "1", 0)?.value ?? 1,
    pitchsensitivity: Cvar_Get("joy_pitchsensitivity", "1", 0)?.value ?? 1,
  };

  const msec = Math.trunc(cls.frametime * 1000);

  for (let i = 1; i < active_seats; i++) {
    const state = seat_input[i];
    // Pad slot i-1 is the first EXTRA pad: seat 0 owns the primary
    // controller (and the keyboard/mouse), seat 1 the next one, and so on.
    const pad = pad_source.state(i - 1);
    const ps = SV_LocalSeatPlayerState(i - 1);
    if (!pad || !ps) {
      // No pad for this seat yet (not plugged in, or unplugged mid-game):
      // the seat still needs a command every frame or the game module sees
      // it as frozen mid-move, so it gets an empty one holding its angles.
      const idle = new UsercmdT();
      idle.msec = msec > 250 ? 100 : msec;
      for (let a = 0; a < 3; a++) idle.angles[a] = ANGLE2SHORT(state.viewangles[a]);
      // A queued game command still goes with it: `seatcmd` does not need a
      // controller, and a seat whose pad was unplugged must still be able to
      // act on one.
      SV_QueueLocalSeatCmd(i - 1, idle, state.pendingCommand);
      state.pendingCommand = null;
      continue;
    }

    const cmd = CL_Seat_BuildCmd(state, pad, cls.frametime, msec, cvars, ps.pmove.delta_angles[PITCH]);
    // Queued, not executed here: a seat's think has to happen inside
    // SV_Frame or the game's per-think multicast writes are stranded until
    // the next one (found live -- see LocalSeatT.pendingCmd in sv_seats.ts).
    SV_QueueLocalSeatCmd(i - 1, cmd, state.pendingCommand);
    state.pendingCommand = null;
  }
}

export function CL_Seats_Shutdown(): void {
  SV_RemoveLocalSeats();
  active_seats = 1;
  // The session is over: a seat count that did not fit THAT server gets a
  // fresh attempt against the next one.
  seating_blocked_for = 0;
  for (const s of seat_input) {
    s.viewangles.fill(0);
    s.prevButtons = 0;
    s.pendingCommand = null;
    s.current_viewheight = 0;
    s.prev_viewheight = 0;
    s.viewheight_change_time = 0;
  }
}

/** How many seats the hardware can actually drive right now: seat 0 plus one
 *  per extra pad. The menu uses this to tell the player why picking four
 *  seats with one pad plugged in will not give them four. */
export function CL_Seats_Available(): number {
  return Math.min(1 + pad_source.count(), MAX_LOCAL_SEATS);
}

// Tested against ss_game specifically rather than qcommon/common's
// Com_ServerState (any nonzero state): a seat needs a running GAME, not a
// server that is mid-load or replaying a demo.
function Com_LocalServerRunning(): boolean {
  return sv.state === ServerStateT.ss_game;
}

/** Test seam: seat input state, so a suite can assert on viewangles without
 *  driving a whole frame. */
export function CL_Seats_InputStateForTests(seat: number): SeatInputStateT {
  return seat_input[seat];
}

/** Test seam: force the active seat count without a server (viewport/HUD
 *  math has no server dependency and should be testable on its own). */
export function CL_Seats_SetActiveForTests(n: number): void {
  active_seats = Math.min(Math.max(Math.trunc(n), 1), MAX_LOCAL_SEATS);
}
