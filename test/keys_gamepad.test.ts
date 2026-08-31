// Regression test for the retail rerelease default.cfg's "GAMEPAD" section
// spamming `"<name>" isn't a valid key` on every boot (.orch/followups.md
// finding 12). The exact bind lines, extracted from
// ~/q2rets/rerelease/baseq2/pak0.pak's default.cfg (classic PACK format,
// verified with a hand-rolled reader against that file's own PACK
// directory -- not the legacy baseq2/pak0.pak's default.cfg, which has no
// GAMEPAD section at all):
//
//   bind left_trigger "+moveup"        bind right_shoulder "+wheel"
//   bind right_trigger "+attack"       bind left_shoulder "+wheel2"
//   bind x_button "cmd help"           bind DPAD_LEFT "cl_weapprev"
//   bind a_button "+moveup"            bind DPAD_RIGHT "cl_weapnext"
//   bind b_button "+movedown"          bind DPAD_UP "wave 4"
//   bind left_stick "+movedown"
//   bind right_stick "centerview"
//
// Neither q2repro checkout (~/Projects/q2repro, ~/Projects/qsrc/q2repro)
// has gamepad/SDL_GameController support at all (grepped both trees'
// client/keys.c, keys.h, input.c, and unix/video/sdl.c for
// SDL_CONTROLLER/GameController/left_trigger/DPAD_ and every one came back
// empty) -- the real name<->keynum table lives only in the closed-source
// KEX engine (quake2ex_steam.exe). keys.ts's new K_GAMEPAD_* constants are
// therefore new keynums (241-252, the first free block above
// K_MWHEELUP=240 and below K_PAUSE=255), not a rename of the existing
// generic K_JOY1-4/K_AUX1-32 joystick abstraction: reusing those would make
// Key_KeynumToString's first-match-wins linear scan answer "JOY1" etc.
// instead of these names for the reverse lookup, breaking the round-trip
// this suite checks for below. Self-sufficient per PORTING.md rule 13: only
// Key_Init() (registers the "bind" console command) and keybindings/
// key_repeats resets are required -- no console/menu/cl state needed.

import { describe, test, expect, beforeEach } from "bun:test";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { keybindings, key_repeats } from "../src/client/keys";
import { Key_Init, Key_Bind_f, Key_StringToKeynum, Key_KeynumToString } from "../src/client/keys_impl";

beforeEach(() => {
  keybindings.fill(null);
  key_repeats.fill(0);
  Key_Init();
});

// Exact case as default.cfg spells each one.
const RETAIL_GAMEPAD_NAMES = [
  "left_trigger",
  "right_trigger",
  "x_button",
  "a_button",
  "b_button",
  "left_stick",
  "right_stick",
  "right_shoulder",
  "left_shoulder",
  "DPAD_LEFT",
  "DPAD_RIGHT",
  "DPAD_UP",
] as const;

describe("keys_impl.ts -- KEX rerelease gamepad button names", () => {
  test("every retail default.cfg GAMEPAD name parses to a valid keynum", () => {
    for (const name of RETAIL_GAMEPAD_NAMES) {
      const keynum = Key_StringToKeynum(name);
      expect(keynum).not.toBe(-1);
      expect(keynum).toBeGreaterThanOrEqual(0);
      expect(keynum).toBeLessThan(256);
    }
  });

  test("every retail default.cfg GAMEPAD name parses to a DISTINCT keynum", () => {
    const keynums = RETAIL_GAMEPAD_NAMES.map((name) => Key_StringToKeynum(name));
    expect(new Set(keynums).size).toBe(RETAIL_GAMEPAD_NAMES.length);
  });

  test("the 12 gamepad keynums don't collide with any pre-existing keyname's keynum", () => {
    // Every other name this table already carries (arrows, function keys,
    // keypad, mouse, the classic generic joystick K_JOY1-4/K_AUX1-32, mouse
    // wheel, PAUSE, SEMICOLON) plus the printable-ASCII single-char range
    // Key_StringToKeynum handles before ever consulting the table.
    const preExisting = [
      "TAB",
      "ENTER",
      "ESCAPE",
      "SPACE",
      "BACKSPACE",
      "UPARROW",
      "DOWNARROW",
      "LEFTARROW",
      "RIGHTARROW",
      "ALT",
      "CTRL",
      "SHIFT",
      "F1",
      "F12",
      "INS",
      "DEL",
      "PGDN",
      "PGUP",
      "HOME",
      "END",
      "MOUSE1",
      "MOUSE2",
      "MOUSE3",
      "JOY1",
      "JOY2",
      "JOY3",
      "JOY4",
      "AUX1",
      "AUX32",
      "KP_HOME",
      "KP_PLUS",
      "MWHEELUP",
      "MWHEELDOWN",
      "PAUSE",
      "SEMICOLON",
    ];
    const preExistingKeynums = new Set(preExisting.map((name) => Key_StringToKeynum(name)));
    for (const name of RETAIL_GAMEPAD_NAMES) {
      expect(preExistingKeynums.has(Key_StringToKeynum(name))).toBe(false);
    }
    // And ASCII printable single chars (32-126) never collide either, since
    // Key_StringToKeynum's single-char shortcut only fires for
    // str.length === 1 -- every gamepad name here is multi-character.
    for (const name of RETAIL_GAMEPAD_NAMES) {
      const keynum = Key_StringToKeynum(name);
      expect(keynum > 32 && keynum < 127).toBe(false);
    }
  });

  test("every retail default.cfg GAMEPAD name round-trips through Key_KeynumToString", () => {
    for (const name of RETAIL_GAMEPAD_NAMES) {
      const keynum = Key_StringToKeynum(name);
      expect(Key_KeynumToString(keynum)).toBe(name);
      // and back again, transitively stable
      expect(Key_StringToKeynum(Key_KeynumToString(keynum))).toBe(keynum);
    }
  });

  test("case-insensitive parse matches the C's Key_StringToKeynum (Q_stricmp)", () => {
    const cases: [string, string][] = [
      ["left_trigger", "LEFT_TRIGGER"],
      ["right_trigger", "Right_Trigger"],
      ["x_button", "X_BUTTON"],
      ["a_button", "A_Button"],
      ["b_button", "B_BUTTON"],
      ["left_stick", "LEFT_STICK"],
      ["right_stick", "Right_Stick"],
      ["right_shoulder", "RIGHT_SHOULDER"],
      ["left_shoulder", "Left_Shoulder"],
      ["DPAD_LEFT", "dpad_left"],
      ["DPAD_RIGHT", "Dpad_Right"],
      ["DPAD_UP", "dpad_up"],
    ];
    for (const [canonical, variant] of cases) {
      expect(Key_StringToKeynum(variant)).toBe(Key_StringToKeynum(canonical));
      expect(Key_StringToKeynum(variant)).not.toBe(-1);
    }
  });

  test("the exact retail default.cfg GAMEPAD bind lines execute through Key_Bind_f with no rejects", () => {
    // Mirrors test/cl_ui.test.ts's Cmd_TokenizeString + Key_Bind_f pattern
    // (the same path console.c's Cbuf_Execute drives "bind ..." lines
    // through on real config exec) -- this is the exact regression
    // finding 12 describes: default.cfg exec spamming "isn't a valid key"
    // on every boot.
    const bindLines: [string, string][] = [
      ["left_trigger", "+moveup"],
      ["right_trigger", "+attack"],
      ["x_button", "cmd help"],
      ["a_button", "+moveup"],
      ["b_button", "+movedown"],
      ["left_stick", "+movedown"],
      ["right_stick", "centerview"],
      ["right_shoulder", "+wheel"],
      ["left_shoulder", "+wheel2"],
      ["DPAD_LEFT", "cl_weapprev"],
      ["DPAD_RIGHT", "cl_weapnext"],
      ["DPAD_UP", "wave 4"],
    ];

    for (const [name, command] of bindLines) {
      Cmd_TokenizeString(`bind ${name} "${command}"`, true);
      Key_Bind_f();

      const keynum = Key_StringToKeynum(name);
      expect(keynum).not.toBe(-1);
      expect(keybindings[keynum]).toBe(command);
    }
  });

  test("sanity: a name genuinely absent from the table still reports invalid (proves the harness isn't vacuous)", () => {
    expect(Key_StringToKeynum("y_button")).toBe(-1);
    expect(Key_StringToKeynum("DPAD_DOWN")).toBe(-1);
    expect(Key_StringToKeynum("start_button")).toBe(-1);
  });
});
