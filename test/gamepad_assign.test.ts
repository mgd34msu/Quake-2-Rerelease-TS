/*
CONTROLLER ASSIGNMENT + PER-PLAYER TUNING (v1.2.0).

Covers src/platform/gamepad_assign.ts (the model), the parts of
src/client/cl_seats.ts and src/platform/sdl.ts that consume it, and the
Controllers menu's row text in src/client/menu.ts.

Entirely self-sufficient, with NO controller hardware and no SDL: the
resolver, the tuning lookup and every menu-row helper take plain data as
arguments precisely so this suite can drive them. The one thing that
genuinely cannot be exercised here is SDL handing us a real device -- that
seam (gpReadIdentity/gpOpenDevice in sdl.ts) needs a physical pad and is
called out in this task's report rather than faked into a false green.

Self-sufficient per PORTING.md rule 13: Cbuf_Init/Cmd_Init/Cvar_Init are
idempotent, every test registers what it reads, and afterAll hands every
cvar this file touches back to the default_string it was registered with, so
no other file in the same `bun test` process inherits our values.
*/

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_AUTO,
  DEVICE_KBM,
  DeviceOrdinals,
  FormatDeviceSpec,
  IsAutoSpec,
  IsKbmSpec,
  MAX_LOCAL_PLAYERS,
  ParseDeviceSpec,
  PlayerDeviceCvarName,
  PlayerTuning,
  PlayerTuningCvarNames,
  RegisterPlayerCvars,
  ResolvePadAssignments,
  SeatsDrivable,
  type PadDeviceT,
} from "../src/platform/gamepad_assign";
import { MAX_LOCAL_SEATS } from "../src/server/sv_seats";
import { CL_Seat_BuildCmd, CL_Seat_PlayerCvars, SeatInputStateT, type SeatCmdCvarsT } from "../src/client/cl_seats";
import { ControllerDeadzoneFormatter, ControllerDeviceIndexFor, ControllerDeviceListText, ControllerDeviceOptions, ControllerPlayerHeadingText, ControllerSensitivityFormatter } from "../src/client/menu";
import type { GamepadDeviceInfoT } from "../src/platform/sdl";
import { cvar_vars, Cvar_Init, Cvar_Get, Cvar_Set, Cvar_SetValue, Cvar_ForceSet, Cvar_VariableValue, Cvar_VariableString, Cvar_WriteVariables } from "../src/qcommon/cvar";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_Init } from "../src/qcommon/cmd";
import { PITCH, YAW } from "../src/shared/q_shared";

// Two different controller models, plus a second copy of the first -- the
// duplicate-GUID case the "#n" suffix exists for.
const GUID_A = "030000005e0400008e02000014010000";
const GUID_B = "030000004c050000cc09000011810000";

function dev(instanceId: number, guid: string, name: string): PadDeviceT {
  return { instanceId, guid, name };
}

function bootCvars(): void {
  Cbuf_Init();
  Cmd_Init();
  Cvar_Init();
}

/** Every cvar this file writes, so afterAll can put them all back. */
function allPlayerCvarNames(): string[] {
  const names: string[] = ["joy_deadzone", "joy_yawsensitivity", "joy_pitchsensitivity"];
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    names.push(PlayerDeviceCvarName(p));
    const t = PlayerTuningCvarNames(p);
    names.push(t.yaw, t.pitch, t.invert, t.deadzone);
  }
  return names;
}

/*
Drop the twenty per-player cvars so the NEXT RegisterPlayerCvars genuinely
creates them. A cvar's default_string is fixed at creation and never changes
(Cvar_Get only ORs flags into an existing one), so "the default comes from
the live global" can only be observed on a fresh creation -- and by the time
this file runs in a full-suite `bun test`, some earlier file's client boot
has usually registered them already.

Safe specifically because gamepad_assign.ts caches NO CvarT reference: every
one of its reads goes through Cvar_Get on the spot. That is the hazard
test/support/cvar_snapshot.ts's header documents at length for modules that
DO cache (vid.ts, host.ts), and it is why this helper is confined to this
file's own cvars.
*/
function forgetPlayerCvars(): void {
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
    cvar_vars.delete(PlayerDeviceCvarName(p));
    const t = PlayerTuningCvarNames(p);
    for (const name of [t.yaw, t.pitch, t.invert, t.deadzone]) cvar_vars.delete(name);
  }
}

function setPrefs(prefs: readonly string[]): void {
  RegisterPlayerCvars();
  for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) Cvar_Set(PlayerDeviceCvarName(p), prefs[p] ?? DEVICE_AUTO);
}

const AUTO4 = [DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO];

// ---------------------------------------------------------------------------
// 1. THE MODEL ITSELF
// ---------------------------------------------------------------------------

describe("device specs -- how a controller is named in a cvar", () => {
  test("the first pad of a model is the bare GUID; a duplicate gets a 1-based #n suffix", () => {
    expect(FormatDeviceSpec(GUID_A, 0)).toBe(GUID_A);
    expect(FormatDeviceSpec(GUID_A, 1)).toBe(`${GUID_A}#2`);
    expect(FormatDeviceSpec(GUID_A, 2)).toBe(`${GUID_A}#3`);
  });

  test("parsing round-trips the format, and ordinals are 0-based internally", () => {
    expect(ParseDeviceSpec(GUID_A)).toEqual({ guid: GUID_A, ordinal: 0 });
    expect(ParseDeviceSpec(`${GUID_A}#2`)).toEqual({ guid: GUID_A, ordinal: 1 });
  });

  test("auto/kbm/empty are not device specs", () => {
    expect(ParseDeviceSpec(DEVICE_AUTO)).toBeNull();
    expect(ParseDeviceSpec(DEVICE_KBM)).toBeNull();
    expect(ParseDeviceSpec("  ")).toBeNull();
    expect(IsAutoSpec(DEVICE_AUTO)).toBe(true);
    expect(IsAutoSpec("")).toBe(true); // a mangled config degrades to plug order
    expect(IsKbmSpec(DEVICE_KBM)).toBe(true);
    expect(IsAutoSpec(DEVICE_KBM)).toBe(false);
    expect(IsAutoSpec(GUID_A)).toBe(false);
  });

  test("a malformed '#' suffix is treated as part of the GUID, not as a duplicate index -- a typo must not silently select some other pad", () => {
    expect(ParseDeviceSpec(`${GUID_A}#`)).toEqual({ guid: `${GUID_A}#`, ordinal: 0 });
    expect(ParseDeviceSpec(`${GUID_A}#0`)).toEqual({ guid: `${GUID_A}#0`, ordinal: 0 });
    expect(ParseDeviceSpec(`${GUID_A}#x`)).toEqual({ guid: `${GUID_A}#x`, ordinal: 0 });
  });

  test("ordinals number duplicates in plug order and restart per GUID", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B"), dev(3, GUID_A, "A")];
    expect(DeviceOrdinals(devices)).toEqual([0, 0, 1]);
  });
});

describe("ResolvePadAssignments -- who drives whom", () => {
  test("all auto reproduces the pre-existing plug-order behavior exactly", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B")];
    const r = ResolvePadAssignments(devices, AUTO4);
    expect(r.players).toEqual([0, 1, -1, -1]);
    expect(r.idle).toEqual([false, false]);
  });

  test("an explicit assignment beats plug order -- the named pad reaches its player no matter which order it arrived in", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B")];
    // Player 2 (index 1) claims the SECOND-plugged pad; player 1 is auto and
    // must therefore take the one left over, not the first one.
    const r = ResolvePadAssignments(devices, [DEVICE_AUTO, GUID_B, DEVICE_AUTO, DEVICE_AUTO]);
    expect(r.players[1]).toBe(1);
    expect(r.players[0]).toBe(0);

    // And with the claim on the FIRST pad, the auto player is pushed to the
    // second -- which is the case plug order alone would have got wrong.
    const r2 = ResolvePadAssignments(devices, [DEVICE_AUTO, GUID_A, DEVICE_AUTO, DEVICE_AUTO]);
    expect(r2.players[1]).toBe(0);
    expect(r2.players[0]).toBe(1);
  });

  test("two identical controllers are told apart by the #n suffix, and swapping the two assignments swaps the pads", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_A, "A")];
    const straight = ResolvePadAssignments(devices, [GUID_A, `${GUID_A}#2`, DEVICE_AUTO, DEVICE_AUTO]);
    expect(straight.players[0]).toBe(0);
    expect(straight.players[1]).toBe(1);

    const swapped = ResolvePadAssignments(devices, [`${GUID_A}#2`, GUID_A, DEVICE_AUTO, DEVICE_AUTO]);
    expect(swapped.players[0]).toBe(1);
    expect(swapped.players[1]).toBe(0);
  });

  test("an assignment survives unplug/replug: the instance id changes, the GUID does not", () => {
    const before = ResolvePadAssignments([dev(7, GUID_A, "A"), dev(8, GUID_B, "B")], [DEVICE_AUTO, GUID_B, DEVICE_AUTO, DEVICE_AUTO]);
    expect(before.players[1]).toBe(1);

    // Same two physical pads after a replug: SDL hands out fresh instance
    // ids, and B now happens to enumerate first.
    const after = ResolvePadAssignments([dev(42, GUID_B, "B"), dev(43, GUID_A, "A")], [DEVICE_AUTO, GUID_B, DEVICE_AUTO, DEVICE_AUTO]);
    // Player 2 still has controller B (now at list index 0), not "whatever
    // was plugged in second this time".
    expect(after.players[1]).toBe(0);
    expect(after.players[0]).toBe(1);
  });

  test("a player whose named controller is absent gets NOTHING -- it is never quietly handed a different pad", () => {
    const devices = [dev(1, GUID_A, "A")];
    const r = ResolvePadAssignments(devices, [DEVICE_AUTO, GUID_B, DEVICE_AUTO, DEVICE_AUTO]);
    expect(r.players[1]).toBe(-1);
    // ...and the pad that IS present still goes to the auto player.
    expect(r.players[0]).toBe(0);
  });

  test("a controller assigned to a player who is not seated is idle, not reassigned", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B")];
    // Player 4 claims B. Only two seats will ever run, so B drives nothing.
    const r = ResolvePadAssignments(devices, [DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO, GUID_B]);
    expect(r.players[3]).toBe(1);
    expect(r.players[1]).toBe(-1); // player 2 did NOT get to steal it
    expect(SeatsDrivable(r)).toBe(1); // so only seat 0 can run
    expect(r.idle).toEqual([false, false]); // both are claimed, just not usefully
  });

  test("player 1 on 'kbm' keeps no pad, and does not block the pads from reaching players 2 and 3", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B")];
    const r = ResolvePadAssignments(devices, [DEVICE_KBM, DEVICE_AUTO, DEVICE_AUTO, DEVICE_AUTO]);
    expect(r.players[0]).toBe(-1);
    expect(r.players[1]).toBe(0);
    expect(r.players[2]).toBe(1);
    expect(SeatsDrivable(r)).toBe(3);
  });

  test("a controller no player ended up with is reported idle", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B")];
    const r = ResolvePadAssignments(devices, [DEVICE_KBM, DEVICE_KBM, DEVICE_KBM, DEVICE_KBM]);
    expect(r.players).toEqual([-1, -1, -1, -1]);
    expect(r.idle).toEqual([true, true]);
  });

  test("more controllers than players is not an error -- the extras are simply idle", () => {
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_B, "B"), dev(3, GUID_A, "A"), dev(4, GUID_B, "B")];
    const r = ResolvePadAssignments(devices, AUTO4);
    expect(r.players).toEqual([0, 1, 2, 3]);
    expect(r.idle).toEqual([false, false, false, false]);
  });
});

describe("SeatsDrivable -- the cap the New Game seat row uses", () => {
  test("seat 0 always counts, because it has the keyboard and mouse", () => {
    expect(SeatsDrivable(ResolvePadAssignments([], AUTO4))).toBe(1);
  });

  test("with everything on auto it is exactly the old '1 + number of extra pads'", () => {
    for (let n = 0; n <= MAX_LOCAL_PLAYERS; n++) {
      const devices = Array.from({ length: n }, (_, i) => dev(i + 1, `guid${i}`, `pad${i}`));
      const expected = Math.min(1 + Math.max(0, n - 1), MAX_LOCAL_PLAYERS);
      expect(SeatsDrivable(ResolvePadAssignments(devices, AUTO4))).toBe(expected);
    }
  });

  test("seats are counted consecutively -- a pad on player 4 with player 2 empty buys no seat", () => {
    const devices = [dev(1, GUID_A, "A")];
    const r = ResolvePadAssignments(devices, [DEVICE_KBM, DEVICE_AUTO, DEVICE_AUTO, GUID_A]);
    expect(r.players[3]).toBe(0);
    expect(SeatsDrivable(r)).toBe(1);
  });

  test("the model's player count matches the server's seat count -- the two constants must never drift", () => {
    expect(MAX_LOCAL_PLAYERS).toBe(MAX_LOCAL_SEATS);
  });
});

// ---------------------------------------------------------------------------
// 2. CVARS
// ---------------------------------------------------------------------------

describe("per-player cvar defaults come from the live global joy_* values", () => {
  test("every player's tuning default equals the matching global, so an existing config's feel is preserved", () => {
    bootCvars();
    // A config that had already set the globals to non-stock values, exactly
    // as main.ts's config.cfg exec would have done before IN_Init runs.
    Cvar_Get("joy_deadzone", "0.15", 0);
    Cvar_Get("joy_yawsensitivity", "1", 0);
    Cvar_Get("joy_pitchsensitivity", "1", 0);
    Cvar_Set("joy_deadzone", "0.22");
    Cvar_Set("joy_yawsensitivity", "1.75");
    Cvar_Set("joy_pitchsensitivity", "0.6");

    // Registration is what reads the globals, so it has to happen after the
    // globals are set -- see forgetPlayerCvars above for why this is needed
    // even though IN_Init already registered them earlier in the process.
    forgetPlayerCvars();
    RegisterPlayerCvars();

    for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
      const names = PlayerTuningCvarNames(p);
      // default_string is the contract: this is what the cvar falls back to
      // and what a fresh install starts from.
      expect(Cvar_Get(names.deadzone, null, 0)?.default_string).toBe("0.22");
      expect(Cvar_Get(names.yaw, null, 0)?.default_string).toBe("1.75");
      expect(Cvar_Get(names.pitch, null, 0)?.default_string).toBe("0.6");
      // ...and the live value starts there too.
      const tuning = PlayerTuning(p);
      expect(tuning.deadzone).toBeCloseTo(0.22, 6);
      expect(tuning.yawsensitivity).toBeCloseTo(1.75, 6);
      expect(tuning.pitchsensitivity).toBeCloseTo(0.6, 6);
      expect(tuning.pitchsign).toBe(1); // invert off by default
    }
  });

  test("every player's device preference defaults to 'auto', so nothing changes for anyone who never opens the screen", () => {
    bootCvars();
    forgetPlayerCvars();
    RegisterPlayerCvars();
    for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
      expect(Cvar_Get(PlayerDeviceCvarName(p), null, 0)?.default_string).toBe(DEVICE_AUTO);
    }
  });

  test("invert-pitch becomes a -1 multiplier and nothing else", () => {
    bootCvars();
    RegisterPlayerCvars();
    Cvar_SetValue(PlayerTuningCvarNames(1).invert, 1);
    expect(PlayerTuning(1).pitchsign).toBe(-1);
    expect(PlayerTuning(0).pitchsign).toBe(1); // strictly per player
    Cvar_SetValue(PlayerTuningCvarNames(1).invert, 0);
    expect(PlayerTuning(1).pitchsign).toBe(1);
  });
});

describe("config write/exec round trip for every new archived cvar", () => {
  const ARCHIVED = (): string[] => {
    const names: string[] = [];
    for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
      names.push(PlayerDeviceCvarName(p));
      const t = PlayerTuningCvarNames(p);
      names.push(t.yaw, t.pitch, t.invert, t.deadzone);
    }
    return names;
  };

  let tmpPath: string | null = null;
  const freshPath = (): string => {
    tmpPath = join(tmpdir(), `q2rets-gamepad-assign-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    return tmpPath;
  };
  const cleanup = (): void => {
    if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath);
    tmpPath = null;
  };

  test("all twenty are CVAR_ARCHIVE -- Cvar_WriteVariables emits a set line for each, even at their defaults", () => {
    bootCvars();
    RegisterPlayerCvars();
    const path = freshPath();
    Cvar_WriteVariables(path);
    const written = readFileSync(path, "utf8");
    for (const name of ARCHIVED()) expect(written).toContain(`set ${name} "`);
    cleanup();
  });

  test("re-execing the written file restores every value after it is clobbered -- the same path a fresh boot's config.cfg exec takes", () => {
    bootCvars();
    RegisterPlayerCvars();

    // Distinct, non-default values for all twenty.
    const chosen: Record<string, string> = {};
    for (let p = 0; p < MAX_LOCAL_PLAYERS; p++) {
      const t = PlayerTuningCvarNames(p);
      chosen[PlayerDeviceCvarName(p)] = p === 0 ? DEVICE_KBM : FormatDeviceSpec(GUID_A, p - 1);
      chosen[t.yaw] = String(1.1 + p * 0.1);
      chosen[t.pitch] = String(0.5 + p * 0.1);
      chosen[t.invert] = p % 2 === 0 ? "1" : "0";
      chosen[t.deadzone] = String(0.05 + p * 0.05);
    }
    for (const [name, value] of Object.entries(chosen)) Cvar_Set(name, value);

    const path = freshPath();
    Cvar_WriteVariables(path);
    const written = readFileSync(path, "utf8");

    // Third, distinct values -- proves the restore below is real and not
    // trivially true because nothing ever changed.
    for (const name of ARCHIVED()) Cvar_Set(name, "9");
    for (const name of ARCHIVED()) expect(Cvar_VariableString(name)).toBe("9");

    Cbuf_AddText(written);
    Cbuf_Execute();

    for (const [name, value] of Object.entries(chosen)) expect(Cvar_VariableString(name)).toBe(value);
    cleanup();
  });

  test("a GUID survives the quoted config round trip intact, suffix and all", () => {
    bootCvars();
    RegisterPlayerCvars();
    const spec = `${GUID_A}#2`;
    Cvar_Set(PlayerDeviceCvarName(2), spec);

    const path = freshPath();
    Cvar_WriteVariables(path);
    const written = readFileSync(path, "utf8");
    expect(written).toContain(`set ${PlayerDeviceCvarName(2)} "${spec}"`);

    Cvar_Set(PlayerDeviceCvarName(2), DEVICE_AUTO);
    Cbuf_AddText(written);
    Cbuf_Execute();
    expect(Cvar_VariableString(PlayerDeviceCvarName(2))).toBe(spec);

    // ...and it still resolves to the right physical pad after the restore.
    const devices = [dev(1, GUID_A, "A"), dev(2, GUID_A, "A")];
    setPrefs([DEVICE_AUTO, DEVICE_AUTO, spec, DEVICE_AUTO]);
    expect(ResolvePadAssignments(devices, [DEVICE_AUTO, DEVICE_AUTO, spec, DEVICE_AUTO]).players[2]).toBe(1);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 3. THE TUNING ACTUALLY REACHING THE AXIS MATH
// ---------------------------------------------------------------------------

function padSnapshot(over: Partial<{ leftX: number; leftY: number; rightX: number; rightY: number; triggerL: number; triggerR: number; buttons: number }> = {}) {
  return { leftX: 0, leftY: 0, rightX: 0, rightY: 0, triggerL: 0, triggerR: 0, buttons: 0, ...over };
}

/*
The movement half is a fixed literal rather than CL_Seat_SharedCvars(): those
values come from client.ts's clCvars, which are null until CL_Init runs, and
this suite deliberately never boots a client (test/splitscreen_seats.test.ts
does the same for the same reason). The PER-PLAYER half below is the real
thing, read from the real cvars -- that is what these cases are about.
*/
function cvarsFor(seat: number): SeatCmdCvarsT {
  return {
    forwardspeed: 200,
    sidespeed: 200,
    upspeed: 200,
    yawspeed: 140,
    pitchspeed: 150,
    forwardsensitivity: 1,
    sidesensitivity: 1,
    ...CL_Seat_PlayerCvars(seat),
  };
}

describe("per-player tuning reaches CL_Seat_BuildCmd's axis math", () => {
  test("a seat's yaw sensitivity scales only that seat's turn rate", () => {
    bootCvars();
    RegisterPlayerCvars();
    Cvar_SetValue(PlayerTuningCvarNames(1).yaw, 1);
    Cvar_SetValue(PlayerTuningCvarNames(2).yaw, 2);

    const stick = padSnapshot({ rightX: 32767 });

    const s1 = new SeatInputStateT();
    CL_Seat_BuildCmd(s1, stick, 0.1, 100, cvarsFor(1), 0);
    const s2 = new SeatInputStateT();
    CL_Seat_BuildCmd(s2, stick, 0.1, 100, cvarsFor(2), 0);

    // Both turned the same direction; seat 2 turned twice as far.
    expect(s1.viewangles[YAW]).toBeLessThan(0);
    expect(s2.viewangles[YAW]).toBeCloseTo(s1.viewangles[YAW] * 2, 4);
  });

  test("invert pitch flips only the pitch axis, and only for the seat that set it", () => {
    bootCvars();
    RegisterPlayerCvars();
    Cvar_SetValue(PlayerTuningCvarNames(1).pitch, 1);
    Cvar_SetValue(PlayerTuningCvarNames(2).pitch, 1);
    Cvar_SetValue(PlayerTuningCvarNames(1).invert, 0);
    Cvar_SetValue(PlayerTuningCvarNames(2).invert, 1);

    const stick = padSnapshot({ rightY: 32767 });

    const s1 = new SeatInputStateT();
    CL_Seat_BuildCmd(s1, stick, 0.1, 100, cvarsFor(1), 0);
    const s2 = new SeatInputStateT();
    CL_Seat_BuildCmd(s2, stick, 0.1, 100, cvarsFor(2), 0);

    expect(s1.viewangles[PITCH]).toBeGreaterThan(0);
    expect(s2.viewangles[PITCH]).toBeCloseTo(-s1.viewangles[PITCH], 4);

    Cvar_SetValue(PlayerTuningCvarNames(2).invert, 0);
  });

  test("a seat's dead zone gates only that seat -- a stick inside one seat's dead zone and outside another's moves exactly one of them", () => {
    bootCvars();
    RegisterPlayerCvars();
    Cvar_SetValue(PlayerTuningCvarNames(1).deadzone, 0.5);
    Cvar_SetValue(PlayerTuningCvarNames(2).deadzone, 0.05);

    // ~30% deflection: inside seat 1's 0.5 dead zone, outside seat 2's 0.05.
    const stick = padSnapshot({ leftY: -Math.round(32767 * 0.3) });

    const s1 = new SeatInputStateT();
    const c1 = CL_Seat_BuildCmd(s1, stick, 0.1, 100, cvarsFor(1), 0);
    const s2 = new SeatInputStateT();
    const c2 = CL_Seat_BuildCmd(s2, stick, 0.1, 100, cvarsFor(2), 0);

    expect(Math.abs(c1.forwardmove)).toBe(0);
    expect(c2.forwardmove).toBeGreaterThan(0);
  });

  test("CL_Seat_PlayerCvars reads the seat's OWN cvar set, not player 1's", () => {
    bootCvars();
    RegisterPlayerCvars();
    Cvar_SetValue(PlayerTuningCvarNames(0).deadzone, 0.1);
    Cvar_SetValue(PlayerTuningCvarNames(3).deadzone, 0.4);
    expect(CL_Seat_PlayerCvars(0).deadzone).toBeCloseTo(0.1, 6);
    expect(CL_Seat_PlayerCvars(3).deadzone).toBeCloseTo(0.4, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. THE MENU'S ROWS
// ---------------------------------------------------------------------------

function info(guid: string, spec: string, name: string, player: number, instanceId = 1): GamepadDeviceInfoT {
  return { guid, spec, name, player, instanceId };
}

describe("Controllers menu row text", () => {
  test("with nothing plugged in the list says so in words, rather than showing an unexplained blank", () => {
    expect(ControllerDeviceListText([])).toEqual(["(none detected)"]);
  });

  test("each detected controller is listed with the player it drives, or 'idle'", () => {
    const rows = ControllerDeviceListText([info(GUID_A, GUID_A, "Xbox Pad", 1), info(GUID_B, GUID_B, "DS4", -1, 2)]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Xbox Pad");
    expect(rows[0]).toContain("player 2"); // 0-based player 1 shows as "player 2"
    expect(rows[1]).toContain("idle");
  });

  test("two identical controllers are distinguishable in the list -- the duplicate marker is kept in the label", () => {
    const rows = ControllerDeviceListText([info(GUID_A, GUID_A, "Xbox Pad", 0), info(GUID_A, `${GUID_A}#2`, "Xbox Pad", 1, 2)]);
    expect(rows[0]).not.toBe(rows[1]);
    expect(rows[1]).toContain("#2");
  });

  test("a player heading says which controller reached that player -- QMF_GRAYED cannot draw that state, so the text must", () => {
    const devices = [info(GUID_A, GUID_A, "Xbox Pad", 0)];
    expect(ControllerPlayerHeadingText(0, devices)).toContain("Xbox Pad");
    expect(ControllerPlayerHeadingText(1, devices)).toContain("[no controller]");
  });

  test("the device row offers auto, keyboard/mouse for player 1 only, and every detected pad", () => {
    const devices = [info(GUID_A, GUID_A, "Xbox Pad", 0), info(GUID_B, GUID_B, "DS4", -1, 2)];

    const p1 = ControllerDeviceOptions(0, devices, DEVICE_AUTO);
    expect(p1.map((o) => o.value)).toEqual([DEVICE_AUTO, DEVICE_KBM, GUID_A, GUID_B]);

    const p2 = ControllerDeviceOptions(1, devices, DEVICE_AUTO);
    // No keyboard/mouse entry: seats past 0 have no keyboard to fall back on.
    expect(p2.map((o) => o.value)).toEqual([DEVICE_AUTO, GUID_A, GUID_B]);
  });

  test("a saved assignment for a pad that is not plugged in is still shown, marked, and selected -- so opening the screen cannot silently erase it", () => {
    const devices = [info(GUID_A, GUID_A, "Xbox Pad", 0)];
    const options = ControllerDeviceOptions(1, devices, GUID_B);
    const last = options[options.length - 1];
    expect(last?.value).toBe(GUID_B);
    expect(last?.label).toBe("[not connected]");
    // ...and the row lands on it rather than falling back to index 0 (which
    // is what would overwrite the choice on the next keypress).
    expect(ControllerDeviceIndexFor(options, GUID_B)).toBe(options.length - 1);
  });

  test("a device row selects the saved value, and falls back to auto only for a value it cannot offer", () => {
    const devices = [info(GUID_A, GUID_A, "Xbox Pad", 0)];
    const options = ControllerDeviceOptions(0, devices, DEVICE_AUTO);
    expect(ControllerDeviceIndexFor(options, DEVICE_AUTO)).toBe(0);
    expect(ControllerDeviceIndexFor(options, DEVICE_KBM)).toBe(1);
    expect(ControllerDeviceIndexFor(options, GUID_A)).toBe(2);
    expect(ControllerDeviceIndexFor(options, "")).toBe(0);
  });

  test("slider readouts show the value that actually reaches the cvar", () => {
    // Sensitivity: curvalue x 0.1, one decimal, with the 'x' the player reads
    // as a multiplier.
    expect(ControllerSensitivityFormatter(10)).toBe("1.0x");
    expect(ControllerSensitivityFormatter(25)).toBe("2.5x");
    expect(ControllerSensitivityFormatter(1)).toBe("0.1x");
    // Dead zone: curvalue x 0.05, two decimals. 3 is the joy_deadzone default.
    expect(ControllerDeadzoneFormatter(3)).toBe("0.15");
    expect(ControllerDeadzoneFormatter(0)).toBe("0.00");
    expect(ControllerDeadzoneFormatter(10)).toBe("0.50");
  });
});

// Rule 13's second half: leave no value behind for another file to inherit.
afterAll(() => {
  // Globals first: the per-player defaults are derived from them, so they
  // have to be back at stock before the re-registration below.
  for (const name of ["joy_deadzone", "joy_yawsensitivity", "joy_pitchsensitivity"]) {
    const cv = Cvar_Get(name, null, 0);
    if (cv) Cvar_ForceSet(name, cv.default_string);
  }
  // This file deliberately re-created the per-player cvars against modified
  // globals, which permanently fixed their default_string at those values.
  // Drop and re-create them once more, now against the restored globals, so
  // a later file in the same process sees stock defaults.
  forgetPlayerCvars();
  RegisterPlayerCvars();
  for (const name of allPlayerCvarNames()) {
    const cv = Cvar_Get(name, null, 0);
    if (cv) Cvar_ForceSet(name, cv.default_string);
  }
  for (const name of ["cl_yawspeed", "cl_pitchspeed", "cl_forwardspeed"]) {
    const cv = Cvar_Get(name, null, 0);
    if (cv) Cvar_ForceSet(name, cv.default_string);
  }
  expect(Cvar_VariableValue("joy_deadzone")).toBeGreaterThanOrEqual(0);
});
