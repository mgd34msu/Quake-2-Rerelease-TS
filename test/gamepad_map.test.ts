// Pure-function tests for src/platform/gamepad_map.ts -- no SDL, no real
// controller, no bun:ffi. Every retail default.cfg GAMEPAD button/axis
// mapping (see keys.ts's citation, extracted from
// ~/q2rets/rerelease/baseq2/pak0.pak's default.cfg) plus trigger threshold
// hysteresis in both directions and the stick deadzone curve.

import { describe, test, expect } from "bun:test";
import {
  SDL_GamepadButtonToKeynum,
  SDL_GamepadButtonEventToKey,
  SDL_GamepadTriggerAxisEventToKey,
  GamepadAxisNormalize,
  GAMEPAD_TRIGGER_THRESHOLD,
  SDL_CONTROLLER_BUTTON_A,
  SDL_CONTROLLER_BUTTON_B,
  SDL_CONTROLLER_BUTTON_X,
  SDL_CONTROLLER_BUTTON_Y,
  SDL_CONTROLLER_BUTTON_BACK,
  SDL_CONTROLLER_BUTTON_GUIDE,
  SDL_CONTROLLER_BUTTON_START,
  SDL_CONTROLLER_BUTTON_LEFTSTICK,
  SDL_CONTROLLER_BUTTON_RIGHTSTICK,
  SDL_CONTROLLER_BUTTON_LEFTSHOULDER,
  SDL_CONTROLLER_BUTTON_RIGHTSHOULDER,
  SDL_CONTROLLER_BUTTON_DPAD_UP,
  SDL_CONTROLLER_BUTTON_DPAD_DOWN,
  SDL_CONTROLLER_BUTTON_DPAD_LEFT,
  SDL_CONTROLLER_BUTTON_DPAD_RIGHT,
  SDL_CONTROLLER_AXIS_LEFTX,
  SDL_CONTROLLER_AXIS_LEFTY,
  SDL_CONTROLLER_AXIS_RIGHTX,
  SDL_CONTROLLER_AXIS_RIGHTY,
  SDL_CONTROLLER_AXIS_TRIGGERLEFT,
  SDL_CONTROLLER_AXIS_TRIGGERRIGHT,
} from "../src/platform/gamepad_map";
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
} from "../src/client/keys";

describe("SDL_GamepadButtonToKeynum / SDL_GamepadButtonEventToKey -- every retail default.cfg GAMEPAD button", () => {
  const cases: [number, number, string][] = [
    [SDL_CONTROLLER_BUTTON_A, K_GAMEPAD_A_BUTTON, "a_button"],
    [SDL_CONTROLLER_BUTTON_B, K_GAMEPAD_B_BUTTON, "b_button"],
    [SDL_CONTROLLER_BUTTON_X, K_GAMEPAD_X_BUTTON, "x_button"],
    [SDL_CONTROLLER_BUTTON_LEFTSTICK, K_GAMEPAD_LEFT_STICK, "left_stick (click)"],
    [SDL_CONTROLLER_BUTTON_RIGHTSTICK, K_GAMEPAD_RIGHT_STICK, "right_stick (click)"],
    [SDL_CONTROLLER_BUTTON_LEFTSHOULDER, K_GAMEPAD_LEFT_SHOULDER, "left_shoulder"],
    [SDL_CONTROLLER_BUTTON_RIGHTSHOULDER, K_GAMEPAD_RIGHT_SHOULDER, "right_shoulder"],
    [SDL_CONTROLLER_BUTTON_DPAD_LEFT, K_GAMEPAD_DPAD_LEFT, "DPAD_LEFT"],
    [SDL_CONTROLLER_BUTTON_DPAD_RIGHT, K_GAMEPAD_DPAD_RIGHT, "DPAD_RIGHT"],
    [SDL_CONTROLLER_BUTTON_DPAD_UP, K_GAMEPAD_DPAD_UP, "DPAD_UP"],
  ];

  for (const [sdlButton, keynum, label] of cases) {
    test(`${label}: SDL button ${sdlButton} -> keynum ${keynum}`, () => {
      expect(SDL_GamepadButtonToKeynum(sdlButton)).toBe(keynum);
      expect(SDL_GamepadButtonEventToKey(sdlButton, true)).toEqual({ key: keynum, down: true });
      expect(SDL_GamepadButtonEventToKey(sdlButton, false)).toEqual({ key: keynum, down: false });
    });
  }

  test("every mapped keynum is distinct (no two SDL buttons collide on one keynum)", () => {
    const keynums = cases.map(([, keynum]) => keynum);
    expect(new Set(keynums).size).toBe(cases.length);
  });

  // Buttons the retail default.cfg never binds (no keynum exists for them,
  // see keys_gamepad.test.ts's own "sanity" test for y_button/DPAD_DOWN/
  // start_button) must be dropped, not mis-mapped onto some other keynum.
  const unmapped: [number, string][] = [
    [SDL_CONTROLLER_BUTTON_Y, "Y"],
    [SDL_CONTROLLER_BUTTON_BACK, "BACK"],
    [SDL_CONTROLLER_BUTTON_GUIDE, "GUIDE"],
    [SDL_CONTROLLER_BUTTON_START, "START"],
    [SDL_CONTROLLER_BUTTON_DPAD_DOWN, "DPAD_DOWN"],
    [15, "MISC1"],
    [16, "PADDLE1"],
    [20, "TOUCHPAD"],
  ];
  for (const [sdlButton, label] of unmapped) {
    test(`${label}: SDL button ${sdlButton} has no keynum (dropped, not forwarded)`, () => {
      expect(SDL_GamepadButtonToKeynum(sdlButton)).toBe(0);
      expect(SDL_GamepadButtonEventToKey(sdlButton, true)).toBeNull();
      expect(SDL_GamepadButtonEventToKey(sdlButton, false)).toBeNull();
    });
  }
});

describe("SDL_GamepadTriggerAxisEventToKey -- trigger-as-button threshold hysteresis", () => {
  const BELOW = Math.round((GAMEPAD_TRIGGER_THRESHOLD - 0.05) * 32767); // ~25%
  const ABOVE = Math.round((GAMEPAD_TRIGGER_THRESHOLD + 0.05) * 32767); // ~35%

  test("left trigger: crossing UP through the threshold fires a press", () => {
    const ev = SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERLEFT, ABOVE, false);
    expect(ev).toEqual({ key: K_GAMEPAD_LEFT_TRIGGER, down: true });
  });

  test("left trigger: crossing DOWN through the threshold fires a release", () => {
    const ev = SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERLEFT, BELOW, true);
    expect(ev).toEqual({ key: K_GAMEPAD_LEFT_TRIGGER, down: false });
  });

  test("right trigger: crossing UP through the threshold fires a press", () => {
    const ev = SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERRIGHT, ABOVE, false);
    expect(ev).toEqual({ key: K_GAMEPAD_RIGHT_TRIGGER, down: true });
  });

  test("right trigger: crossing DOWN through the threshold fires a release", () => {
    const ev = SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERRIGHT, BELOW, true);
    expect(ev).toEqual({ key: K_GAMEPAD_RIGHT_TRIGGER, down: false });
  });

  test("no edge: still above threshold while already down produces no event", () => {
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERLEFT, ABOVE, true)).toBeNull();
  });

  test("no edge: still below threshold while already up produces no event", () => {
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERLEFT, BELOW, false)).toBeNull();
  });

  test("exactly at the threshold counts as pressed (>=, not >)", () => {
    // ceil, not round: normalizedAxis divides by 32767, so the smallest raw
    // value whose quotient is >= GAMEPAD_TRIGGER_THRESHOLD is the ceiling,
    // not the nearest integer (round(0.3*32767) rounds DOWN to a quotient
    // just under 0.3 here, which would test the wrong side of the line).
    const atThreshold = Math.ceil(GAMEPAD_TRIGGER_THRESHOLD * 32767);
    expect(atThreshold / 32767).toBeGreaterThanOrEqual(GAMEPAD_TRIGGER_THRESHOLD);
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERLEFT, atThreshold, false)).toEqual({ key: K_GAMEPAD_LEFT_TRIGGER, down: true });
  });

  test("fully released (0) while already down releases", () => {
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERRIGHT, 0, true)).toEqual({ key: K_GAMEPAD_RIGHT_TRIGGER, down: false });
  });

  test("fully pulled (32767) while already up presses", () => {
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_TRIGGERRIGHT, 32767, false)).toEqual({ key: K_GAMEPAD_RIGHT_TRIGGER, down: true });
  });

  test("non-trigger axes (movement sticks) never produce a trigger key event", () => {
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_LEFTX, 32767, false)).toBeNull();
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_LEFTY, 32767, false)).toBeNull();
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_RIGHTX, 32767, false)).toBeNull();
    expect(SDL_GamepadTriggerAxisEventToKey(SDL_CONTROLLER_AXIS_RIGHTY, 32767, false)).toBeNull();
  });
});

describe("GamepadAxisNormalize -- movement-stick deadzone curve", () => {
  const DZ = 0.15;

  test("centered stick (0) is exactly zero", () => {
    expect(GamepadAxisNormalize(0, DZ)).toBe(0);
  });

  test("inside the deadzone (either direction) clamps to zero", () => {
    const inside = Math.round(DZ * 0.5 * 32767);
    expect(GamepadAxisNormalize(inside, DZ)).toBe(0);
    expect(GamepadAxisNormalize(-inside, DZ)).toBe(0);
  });

  test("exactly at the deadzone edge is zero (< deadzone is the cut, not <=, but a stick sitting AT the edge still reads ~0 pre-scale)", () => {
    const atEdge = Math.round(DZ * 32767);
    // mag === deadzone is NOT < deadzone, so this rescales to (approximately) 0
    expect(GamepadAxisNormalize(atEdge, DZ)).toBeCloseTo(0, 3);
  });

  test("full deflection rescales to +-1 regardless of deadzone", () => {
    expect(GamepadAxisNormalize(32767, DZ)).toBeCloseTo(1, 3);
    expect(GamepadAxisNormalize(-32768, DZ)).toBeCloseTo(-1, 2);
  });

  test("halfway past the deadzone is NOT simply 0.5 -- it is rescaled against the remaining (1-deadzone) span", () => {
    const half = Math.round((DZ + (1 - DZ) / 2) * 32767);
    expect(GamepadAxisNormalize(half, DZ)).toBeCloseTo(0.5, 2);
  });

  test("sign is preserved through the deadzone rescale", () => {
    const v = Math.round(0.6 * 32767);
    expect(GamepadAxisNormalize(v, DZ)).toBeGreaterThan(0);
    expect(GamepadAxisNormalize(-v, DZ)).toBeLessThan(0);
    expect(GamepadAxisNormalize(v, DZ)).toBeCloseTo(-GamepadAxisNormalize(-v, DZ), 6);
  });

  test("a deadzone of 1 or more never produces movement", () => {
    expect(GamepadAxisNormalize(32767, 1)).toBe(0);
    expect(GamepadAxisNormalize(32767, 1.5)).toBe(0);
  });

  test("a deadzone of 0 passes the raw normalized value straight through", () => {
    expect(GamepadAxisNormalize(16384, 0)).toBeCloseTo(16384 / 32767, 6);
  });
});
