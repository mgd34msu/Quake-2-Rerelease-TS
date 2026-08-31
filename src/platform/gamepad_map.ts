/*
Pure, testable mapping from SDL_GameController events to this port's own
K_GAMEPAD_* keynums (src/client/keys.ts) and to normalized stick-axis values.
Split out of src/platform/sdl.ts the same way that file already splits pure
geometry into vid_scale.ts (see sdl.ts's own SDLVID_Present, the only caller
of VID_CalcScaledRect) -- sdl.ts's own INPUT section imports this file and is
the only place that touches real SDL calls; everything here is `SDL event
struct in, {key, down} out` (or a plain number in/out for the stick axes),
with zero bun:ffi/dlopen surface, so it is unit-testable without a real
controller or even the real libSDL2.

.orch/followups.md finding 12's closure note: keys.ts's K_GAMEPAD_LEFT_TRIGGER
.. K_GAMEPAD_DPAD_UP (241-252, commit 5d28433) parse and bind, but nothing
fed them -- "no SDL_GameController input layer exists at all". This file plus
sdl.ts's INPUT section is that layer's event-mapping half.
*/

import {
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
} from "../client/keys";

//=============================================================================
// SDL_GameControllerButton / SDL_GameControllerAxis (SDL_gamecontroller.h) --
// verified against /usr/include/SDL2/SDL_gamecontroller.h on this host.
// Frozen SDL2 ABI, same guarantee sdl.ts's own header comment already
// documents for the struct offsets below: SDL2 only ever APPENDS new members
// after SDL_CONTROLLER_BUTTON_TOUCHPAD / SDL_CONTROLLER_AXIS_MAX, never
// renumbers a shipped one.

export const SDL_CONTROLLER_BUTTON_A = 0;
export const SDL_CONTROLLER_BUTTON_B = 1;
export const SDL_CONTROLLER_BUTTON_X = 2;
export const SDL_CONTROLLER_BUTTON_Y = 3;
export const SDL_CONTROLLER_BUTTON_BACK = 4;
export const SDL_CONTROLLER_BUTTON_GUIDE = 5;
export const SDL_CONTROLLER_BUTTON_START = 6;
export const SDL_CONTROLLER_BUTTON_LEFTSTICK = 7;
export const SDL_CONTROLLER_BUTTON_RIGHTSTICK = 8;
export const SDL_CONTROLLER_BUTTON_LEFTSHOULDER = 9;
export const SDL_CONTROLLER_BUTTON_RIGHTSHOULDER = 10;
export const SDL_CONTROLLER_BUTTON_DPAD_UP = 11;
export const SDL_CONTROLLER_BUTTON_DPAD_DOWN = 12;
export const SDL_CONTROLLER_BUTTON_DPAD_LEFT = 13;
export const SDL_CONTROLLER_BUTTON_DPAD_RIGHT = 14;

export const SDL_CONTROLLER_AXIS_LEFTX = 0;
export const SDL_CONTROLLER_AXIS_LEFTY = 1;
export const SDL_CONTROLLER_AXIS_RIGHTX = 2;
export const SDL_CONTROLLER_AXIS_RIGHTY = 3;
export const SDL_CONTROLLER_AXIS_TRIGGERLEFT = 4;
export const SDL_CONTROLLER_AXIS_TRIGGERRIGHT = 5;

//=============================================================================
// buttons -- SDL_CONTROLLERBUTTONDOWN/UP -> Key_Event

/*
Retail default.cfg's GAMEPAD section (see keys.ts's own citation comment,
extracted from ~/q2rets/rerelease/baseq2/pak0.pak) binds exactly 12 button
names, and K_GAMEPAD_LEFT_TRIGGER..K_GAMEPAD_DPAD_UP (241-252) is exactly
those 12 keynums -- no Y button, no DPAD_DOWN, and no back/start/guide
keynum exists anywhere in this port, because default.cfg never binds one.
This map is therefore intentionally NOT a full SDL_GameControllerButton ->
keynum table: a button with no keynum (Y, DPAD_DOWN, BACK, GUIDE, START,
MISC1, the four Xbox Elite paddles, the PS4/5 touchpad click) maps to 0
(SDL_KeyToQuake's own "no mapping, drop it" convention, sdl.ts) and the event
pump silently ignores it, exactly like an unmapped SDLK_* keycode already is.
*/
const buttonKeynum = new Map<number, number>([
  [SDL_CONTROLLER_BUTTON_A, K_GAMEPAD_A_BUTTON],
  [SDL_CONTROLLER_BUTTON_B, K_GAMEPAD_B_BUTTON],
  [SDL_CONTROLLER_BUTTON_X, K_GAMEPAD_X_BUTTON],
  [SDL_CONTROLLER_BUTTON_LEFTSTICK, K_GAMEPAD_LEFT_STICK],
  [SDL_CONTROLLER_BUTTON_RIGHTSTICK, K_GAMEPAD_RIGHT_STICK],
  [SDL_CONTROLLER_BUTTON_LEFTSHOULDER, K_GAMEPAD_LEFT_SHOULDER],
  [SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, K_GAMEPAD_RIGHT_SHOULDER],
  [SDL_CONTROLLER_BUTTON_DPAD_LEFT, K_GAMEPAD_DPAD_LEFT],
  [SDL_CONTROLLER_BUTTON_DPAD_RIGHT, K_GAMEPAD_DPAD_RIGHT],
  [SDL_CONTROLLER_BUTTON_DPAD_UP, K_GAMEPAD_DPAD_UP],
]);

export function SDL_GamepadButtonToKeynum(button: number): number {
  return buttonKeynum.get(button) ?? 0;
}

// SDL_CONTROLLERBUTTONDOWN/UP -> {key, down}, or null for a button this port
// has no keynum for. Mirrors sdl.ts's own SDL_KeyToQuake seam: pure, no SDL
// calls, fully unit-testable.
export function SDL_GamepadButtonEventToKey(button: number, down: boolean): { key: number; down: boolean } | null {
  const key = SDL_GamepadButtonToKeynum(button);
  if (key === 0) return null;
  return { key, down };
}

//=============================================================================
// trigger axes-as-buttons -- SDL_CONTROLLERAXISMOTION -> Key_Event

/*
Trigger-as-button threshold. There is no single canonical SDL_GameController
constant for "how far pulled counts as a press" -- SDL's own API has no
trigger-click emulation feature at all, and XInput's own
XINPUT_GAMEPAD_TRIGGER_THRESHOLD (30 of 255, ~11.8%) is a Microsoft-specific
constant this port has no dependency on and the KEX default.cfg gives no
threshold data to derive one from either (its GAMEPAD section only lists
bind NAMES, see keys.ts's citation -- no analog curve). Per this task's own
brief ("SDL's standard ~30%"), 0.3 of full pull is this file's threshold.

Single cut, not a dual-band Schmitt trigger: the SAME 0.3 line is tested on
both the press and the release side; the caller's own previously-latched
down/up state (passed in explicitly below) is what turns that single line
into edge-triggered "hysteresis" -- press and release are each their own
one-way crossing, and a value that doesn't cross the line produces no event
at all (see SDL_GamepadTriggerAxisEventToKey's null return).
*/
export const GAMEPAD_TRIGGER_THRESHOLD = 0.3;

const triggerAxisKeynum = new Map<number, number>([
  [SDL_CONTROLLER_AXIS_TRIGGERLEFT, K_GAMEPAD_LEFT_TRIGGER],
  [SDL_CONTROLLER_AXIS_TRIGGERRIGHT, K_GAMEPAD_RIGHT_TRIGGER],
]);

// SDL_ControllerAxisEvent.value ranges -32768..32767 for every axis
// (SDL_gamecontroller.h); dividing by 32767 (not 32768) matches SDL's own
// documented convention that -32768 is reachable but the nominal unit range
// is symmetric around a 32767-scaled +1.0.
function normalizedAxis(value: number): number {
  return value / 32767;
}

/*
SDL_CONTROLLERAXISMOTION -> {key, down} | null, for the two trigger axes
only. `wasDown` is the caller's own previously-latched press state for that
trigger. Returns null both when the axis isn't a trigger (LEFTX/LEFTY/
RIGHTX/RIGHTY feed stick movement instead, see GamepadAxisNormalize below,
not a key press) and when the new threshold-crossing state matches
`wasDown` (no edge, nothing to send) -- this null-on-no-change branch is the
"hysteresis both directions" seam the unit tests exercise directly, in both
the press (false->true) and release (true->false) direction.
*/
export function SDL_GamepadTriggerAxisEventToKey(axis: number, value: number, wasDown: boolean): { key: number; down: boolean } | null {
  const key = triggerAxisKeynum.get(axis);
  if (key === undefined) return null;
  const down = normalizedAxis(value) >= GAMEPAD_TRIGGER_THRESHOLD;
  if (down === wasDown) return null;
  return { key, down };
}

//=============================================================================
// movement-stick axes -- SDL_CONTROLLERAXISMOTION -> usercmd/viewangles,
// NOT Key_Event

/*
LEFTX/LEFTY/RIGHTX/RIGHTY never produce a Key_Event: default.cfg's GAMEPAD
section only binds the STICK CLICKS (left_stick/right_stick ->
SDL_CONTROLLER_BUTTON_LEFTSTICK/RIGHTSTICK above), not the analog tilt.
Analog tilt instead feeds the usercmd movement/look path the way vanilla
in_win.c's IN_JoyMove fed a physical PC joystick's axes into the same
cmd->forwardmove/sidemove/viewangles fields IN_MouseMove already writes for
the mouse (win32/in_win.c) -- this port's own mouse handling is
src/platform/sdl.ts's IN_Move, which is where the values this function
computes actually get applied (see that function's own doc comment for the
exact sign/axis wiring and the cited deviation from in_win.c's
DirectInput-specific polarity).

Per-axis deadzone, not a circular/radial one: in_win.c's own
joy_forwardthreshold/joy_sidethreshold/joy_pitchthreshold/joy_yawthreshold
cvars (vanilla default "0.15" each) are independently applied per axis, not
as a combined stick-magnitude radius; this port's single joy_deadzone cvar
(sdl.ts's IN_Init) follows that same per-axis shape, collapsed to one knob
since SDL_GameController's fixed 2-stick/4-axis layout has no per-user axis
reassignment to configure the way in_win.c's joy_advaxis* system did for
arbitrary PC joystick hardware -- documented simplification, not a dropped
feature (nothing in this port ever had the general axis-remap UI to lose).
*/
export function GamepadAxisNormalize(rawValue: number, deadzone: number): number {
  const v = normalizedAxis(rawValue);
  if (deadzone >= 1) return 0;
  const mag = Math.abs(v);
  if (mag < deadzone) return 0;
  const sign = v < 0 ? -1 : 1;
  const scaled = (mag - deadzone) / (1 - deadzone);
  return sign * Math.min(1, scaled);
}
