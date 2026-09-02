// gamepad_assign.ts -- WHICH CONTROLLER DRIVES WHICH LOCAL PLAYER, and each
// player's own stick tuning.
//
// An ORIGINAL module of this port, same status as client/cl_seats.ts and
// client/menu_content.ts: there is nothing to port it from.
//
//   * q2repro has no splitscreen at all, so it never had to name a second
//     pad, let alone let a player pick one.
//   * The 2023 rerelease game DLL (quake2-rerelease-dll) only specifies what
//     the GAME does with a seat index (hud_data[isplit], cg_screen.cpp:107);
//     device binding is entirely engine-side and is not in that source.
//   * KEX's own controller-assignment UI is closed. Nothing about its
//     behavior is observable from anything available here.
//
// So the model below is this port's own design, and the comments say so
// rather than citing a reference that does not exist.
//
// THE MODEL
//
// Four PLAYERS, numbered 1..4 the way the menu shows them. Player 1 is
// client/cl_seats.ts's seat 0 -- the ordinary client, which ALWAYS has the
// keyboard and mouse and may additionally have a pad (that pad is the
// "primary" one, the only pad whose buttons reach the bind system and the
// menu). Players 2..4 are seats 1..3, which are pad-only by construction
// (cl_seats.ts's header explains why: a bind is one global table and two
// seats cannot both own `+attack`).
//
// One CVAR_ARCHIVE cvar per player says what drives it:
//
//   in_player1_device .. in_player4_device
//
//     "auto"          plug/enumeration order, i.e. exactly what this engine
//                     did before this file existed. The default, so a player
//                     who never opens the Controllers screen sees no change
//                     whatsoever.
//     "kbm"           player 1 only: keyboard and mouse, and deliberately NO
//                     pad, even when pads are plugged in. On players 2..4
//                     there is no keyboard to fall back to, so it is treated
//                     as "nothing drives this player" and the menu does not
//                     offer it.
//     "<guid>"        a specific controller, by SDL joystick GUID.
//     "<guid>#n"      the n-th (1-based) controller sharing that GUID, for
//                     the two-identical-pads case where the GUID alone
//                     cannot tell them apart.
//
// WHY GUID AND NOT INSTANCE ID. SDL hands out a fresh instance id every time
// a device is opened, so an instance id does not survive a replug, let alone
// a reboot -- it would make "player 3 uses the red pad" mean "player 3 uses
// whatever got plugged in third this time". The GUID is derived from the
// device's bus/vendor/product/version, so it is the same string across
// replugs and across boots. Its one blind spot is two physically identical
// controllers, which really do share a GUID; that is what the "#n" suffix
// disambiguates, and it necessarily falls back to plug order, because
// nothing else distinguishes them. That limitation is inherent, not a
// shortcut: SDL exposes no per-unit serial for most pads.
//
// RESOLUTION ORDER (ResolvePadAssignments below, and the only place the rule
// lives):
//   1. Explicit assignments are honored first, whatever order the devices
//      were plugged in. A player whose named controller is not currently
//      present simply gets nothing -- it is NOT quietly handed some other
//      pad, because "player 3 uses the red pad" turning into "player 3 uses
//      whichever pad was free" is the exact surprise this screen exists to
//      remove.
//   2. Players left on "auto" then take the still-unclaimed controllers in
//      plug order -- the pre-existing behavior, now operating on whatever
//      the explicit assignments did not spoken for.
//   3. Any controller no player ended up with is idle. That includes a pad
//      assigned to a player who is not seated in this session: it is bound,
//      it is just not driving anything until that player is seated.
//
// PER-PLAYER TUNING. Four more CVAR_ARCHIVE cvars per player:
//
//   in_playerN_yawsensitivity    in_playerN_pitchsensitivity
//   in_playerN_invertpitch       in_playerN_deadzone
//
// registered by RegisterPlayerCvars with the LIVE value of the matching
// global joy_* cvar as their default. That timing is deliberate and is what
// keeps every existing config working untouched: main.ts execs config.cfg
// before CL_Init ever reaches IN_Init, so by the time this runs, a config
// carrying `set joy_yawsensitivity 2` has already put 2 into the global, and
// every player's default becomes 2 as well. Nobody's aim changes because
// this file was added; the per-player cvars only diverge once the player
// actually moves a slider.
//
// The globals are NOT removed and NOT rewritten. joy_forwardsensitivity and
// joy_sidesensitivity stay global for every player (movement speed is not
// the knob anybody tunes per-seat), and the four above simply take over from
// their global counterparts for the axis math in sdl.ts's IN_JoyMove
// (player 1) and cl_seats.ts's CL_Seats_SendCmds (players 2..4).

import { Cvar_Get } from "../qcommon/cvar";
import { CVAR_ARCHIVE, type CvarT } from "../shared/q_shared";

/*
Local players the assignment model covers. Deliberately a plain constant
rather than an import of sv_seats.ts's MAX_LOCAL_SEATS: this is a
src/platform module and must not reach into the server. The two are required
to agree, and test/gamepad_assign.test.ts asserts exactly that rather than
leaving the duplication unguarded.
*/
export const MAX_LOCAL_PLAYERS = 4;

/** "follow plug order", the default -- pre-existing behavior. */
export const DEVICE_AUTO = "auto";
/** Player 1 only: keyboard and mouse, no pad. */
export const DEVICE_KBM = "kbm";

/** One controller SDL currently has open, as the assignment model sees it.
 *  `guid` is SDL's own joystick GUID string; `name` is the human-readable
 *  controller name, used only for display. */
export interface PadDeviceT {
  readonly instanceId: number;
  readonly guid: string;
  readonly name: string;
}

export interface AssignmentT {
  /** Index into the device list for each player (0 = player 1), or -1 when
   *  nothing drives that player. */
  readonly players: number[];
  /** Parallel to the device list: true when no player is using that device. */
  readonly idle: boolean[];
}

/*
Position of each device among the devices sharing its GUID, in list (plug)
order. This is the number the "#n" suffix names, minus one -- so the first
pad with a given GUID is ordinal 0 and is written as the bare GUID, the
second is ordinal 1 and is written "<guid>#2".

Writing the first duplicate as a bare GUID rather than "<guid>#1" is what
makes the common single-pad-per-model case produce a clean, hand-editable
cvar value, and it means a config written when only one such pad was present
keeps working when a second identical pad shows up later.
*/
export function DeviceOrdinals(devices: readonly PadDeviceT[]): number[] {
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (const dev of devices) {
    const n = seen.get(dev.guid) ?? 0;
    out.push(n);
    seen.set(dev.guid, n + 1);
  }
  return out;
}

/** The cvar value naming this device: the bare GUID for the first pad of its
 *  kind, "<guid>#n" (n 1-based) for a later duplicate. */
export function FormatDeviceSpec(guid: string, ordinal: number): string {
  return ordinal <= 0 ? guid : `${guid}#${ordinal + 1}`;
}

/** Split a "<guid>[#n]" cvar value. Returns null for "auto", "kbm", an empty
 *  value, or anything else that does not name a device. */
export function ParseDeviceSpec(spec: string): { guid: string; ordinal: number } | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered === DEVICE_AUTO || lowered === DEVICE_KBM) return null;

  const hash = trimmed.lastIndexOf("#");
  if (hash < 0) return { guid: trimmed, ordinal: 0 };

  const guid = trimmed.slice(0, hash);
  const n = Number(trimmed.slice(hash + 1));
  // A "#" with nothing usable after it is a typo, not a duplicate index --
  // fall back to the whole string as a GUID rather than silently matching
  // some other pad.
  if (!guid || !Number.isFinite(n) || Math.trunc(n) < 1) return { guid: trimmed, ordinal: 0 };
  return { guid, ordinal: Math.trunc(n) - 1 };
}

/** True when this player's preference is "keyboard and mouse, no pad". Only
 *  meaningful for player 1 (index 0); see this file's header. */
export function IsKbmSpec(spec: string): boolean {
  return spec.trim().toLowerCase() === DEVICE_KBM;
}

/** True when this player is on the default plug-order behavior. An
 *  unrecognized or empty value is treated as "auto", so a hand-mangled
 *  config degrades to the pre-existing behavior instead of leaving a player
 *  with no input at all. */
export function IsAutoSpec(spec: string): boolean {
  const lowered = spec.trim().toLowerCase();
  if (!lowered) return true;
  if (lowered === DEVICE_AUTO) return true;
  if (lowered === DEVICE_KBM) return false;
  return false;
}

/*
==================
ResolvePadAssignments

The whole routing rule, as a pure function of "what is plugged in" and "what
the four cvars say". sdl.ts calls it on every hotplug event and whenever the
Controllers screen changes a preference; the tests call it directly, which is
the reason it takes plain data instead of reading the cvars itself.

`prefs[i]` is player i+1's in_playerN_device value. Devices are in plug
order, which is the order SDL handed them to us.
==================
*/
export function ResolvePadAssignments(devices: readonly PadDeviceT[], prefs: readonly string[]): AssignmentT {
  const ordinals = DeviceOrdinals(devices);
  const players: number[] = new Array(MAX_LOCAL_PLAYERS).fill(-1);
  const claimed: boolean[] = new Array(devices.length).fill(false);

  // Pass 1 -- explicit assignments, which beat plug order by construction.
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const spec = prefs[p] ?? DEVICE_AUTO;
    const parsed = ParseDeviceSpec(spec);
    if (!parsed) continue; // auto or kbm; handled below / not a pad at all

    let found = -1;
    for (let d = 0; d < devices.length; d++) {
      const dev = devices[d];
      if (!dev || claimed[d]) continue;
      if (dev.guid !== parsed.guid) continue;
      if (ordinals[d] !== parsed.ordinal) continue;
      found = d;
      break;
    }
    // Not present: this player gets nothing this session (see header rule 1).
    if (found < 0) continue;
    players[p] = found;
    claimed[found] = true;
  }

  // Pass 2 -- "auto" players take what is left, in plug order. "kbm" is
  // skipped here: it is an explicit refusal of a pad, not a fall-through.
  let next = 0;
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const spec = prefs[p] ?? DEVICE_AUTO;
    if (players[p] >= 0) continue;
    if (IsKbmSpec(spec)) continue;
    if (!IsAutoSpec(spec)) continue; // named a device that is not plugged in
    while (next < devices.length && claimed[next]) next++;
    if (next >= devices.length) break;
    players[p] = next;
    claimed[next] = true;
  }

  return { players, idle: claimed.map((c) => !c) };
}

/*
==================
SeatsDrivable

How many seats the hardware and the assignments can actually fill right now,
given a resolved assignment: player 1 always counts (it has the keyboard and
mouse whatever else is true), and each player after it counts only while
every player before it is also driveable, because seats are filled in order
and there is no such thing as seat 2 without seat 1.

This is what caps client/menu.ts's "local players" row. With every player on
"auto" it reduces to exactly the old `1 + number of extra pads`, so the row
behaves as it always has until somebody assigns something.
==================
*/
export function SeatsDrivable(assignment: AssignmentT): number {
  let n = 1;
  for (let p = 1; p < MAX_LOCAL_PLAYERS; p++) {
    if (assignment.players[p] === undefined || (assignment.players[p] ?? -1) < 0) break;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// CVARS
// ---------------------------------------------------------------------------

/** in_player1_device .. in_player4_device, by 0-based player index. */
export function PlayerDeviceCvarName(player: number): string {
  return `in_player${player + 1}_device`;
}

export interface PlayerTuningCvarNamesT {
  readonly yaw: string;
  readonly pitch: string;
  readonly invert: string;
  readonly deadzone: string;
}

export function PlayerTuningCvarNames(player: number): PlayerTuningCvarNamesT {
  const n = player + 1;
  return {
    yaw: `in_player${n}_yawsensitivity`,
    pitch: `in_player${n}_pitchsensitivity`,
    invert: `in_player${n}_invertpitch`,
    deadzone: `in_player${n}_deadzone`,
  };
}

/** The global joy_* cvars the per-player set defaults from, registered with
 *  the same defaults sdl.ts's IN_Init uses (this function may run first, and
 *  Cvar_Get's flag OR-merge means whichever call lands first wins the
 *  default without either losing its flags). */
function globalJoyCvars(): { deadzone: CvarT | null; yaw: CvarT | null; pitch: CvarT | null } {
  return {
    deadzone: Cvar_Get("joy_deadzone", "0.15", 0),
    yaw: Cvar_Get("joy_yawsensitivity", "1", 0),
    pitch: Cvar_Get("joy_pitchsensitivity", "1", 0),
  };
}

/*
==================
RegisterPlayerCvars

Registers all twenty cvars (four players x device + four tuning knobs).
Idempotent: Cvar_Get on an existing cvar only ORs the flags in and returns
it, so calling this from IN_Init and again from the menu costs nothing and
never rewrites a value.

The tuning defaults come from the LIVE global joy_* values rather than from
hardcoded literals -- see this file's header for why that is what preserves
an existing config's feel exactly.
==================
*/
export function RegisterPlayerCvars(): void {
  const g = globalJoyCvars();
  const deadzone = g.deadzone ? g.deadzone.string : "0.15";
  const yaw = g.yaw ? g.yaw.string : "1";
  const pitch = g.pitch ? g.pitch.string : "1";

  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    Cvar_Get(PlayerDeviceCvarName(p), DEVICE_AUTO, CVAR_ARCHIVE);
    const names = PlayerTuningCvarNames(p);
    Cvar_Get(names.yaw, yaw, CVAR_ARCHIVE);
    Cvar_Get(names.pitch, pitch, CVAR_ARCHIVE);
    Cvar_Get(names.invert, "0", CVAR_ARCHIVE);
    Cvar_Get(names.deadzone, deadzone, CVAR_ARCHIVE);
  }
}

/** Every player's device preference, in player order -- the array
 *  ResolvePadAssignments wants. */
export function PlayerDevicePrefs(): string[] {
  RegisterPlayerCvars();
  const out: string[] = [];
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    const cv = Cvar_Get(PlayerDeviceCvarName(p), DEVICE_AUTO, CVAR_ARCHIVE);
    out.push(cv ? cv.string : DEVICE_AUTO);
  }
  return out;
}

export interface PlayerTuningT {
  yawsensitivity: number;
  pitchsensitivity: number;
  /** +1 normally, -1 when the player has invert-pitch on. Pre-multiplied so
   *  the axis math in sdl.ts/cl_seats.ts stays a single multiply. */
  pitchsign: number;
  deadzone: number;
}

/** This player's live stick tuning. Reads the cvars every call, the same way
 *  IN_JoyMove has always read joy_* every frame -- a console `in_player2_deadzone
 *  0.3` takes effect on the next frame, with no menu round trip. */
export function PlayerTuning(player: number): PlayerTuningT {
  RegisterPlayerCvars();
  const names = PlayerTuningCvarNames(player);
  const yaw = Cvar_Get(names.yaw, "1", CVAR_ARCHIVE);
  const pitch = Cvar_Get(names.pitch, "1", CVAR_ARCHIVE);
  const invert = Cvar_Get(names.invert, "0", CVAR_ARCHIVE);
  const deadzone = Cvar_Get(names.deadzone, "0.15", CVAR_ARCHIVE);
  return {
    yawsensitivity: yaw ? yaw.value : 1,
    pitchsensitivity: pitch ? pitch.value : 1,
    pitchsign: invert && invert.value !== 0 ? -1 : 1,
    deadzone: deadzone ? deadzone.value : 0.15,
  };
}
