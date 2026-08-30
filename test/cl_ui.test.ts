// Exercises the real (non-drawing) state this unit ported: console.c's text
// buffer/line-wrap/notify-timestamp bookkeeping (console_impl.ts), keys.c's
// binding table and Key_Event dispatch (keys_impl.ts/keys.ts), and cl_inv.c's
// CL_ParseInventory wire read (cl_inv.ts). Drawing itself is a no-op under
// this port's unconstructed renderer (`re` stays null -- see cl_scrn.ts's
// file banner), so none of these tests touch it.
//
// Self-sufficient per PORTING.md rule 13: every global these functions read
// (con, cl, cls, keybindings, key_repeats, net_message) is reset in
// beforeEach, and Con_Init/Key_Init are called fresh each test instead of
// relying on another test file's module-load side effects.

import { describe, test, expect, beforeEach } from "bun:test";
import { SZ_Clear, MSG_BeginReading, MSG_WriteShort } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { Cmd_TokenizeString } from "../src/qcommon/cmd";
import { MAX_ITEMS } from "../src/shared/q_shared";
import { cl, cls, KeydestT, setRe } from "../src/client/client";
import { M_ForceMenuOff } from "../src/client/menu";
import { con, NUM_CON_TIMES } from "../src/client/console";
import { Con_Init, Con_Print } from "../src/client/console_impl";
import { keybindings, key_repeats, setAnykeydown } from "../src/client/keys";
import { Key_Init, Key_Event, Key_SetBinding, Key_Bind_f, Key_Unbind_f, Key_StringToKeynum } from "../src/client/keys_impl";
import { CL_ParseInventory } from "../src/client/cl_inv";

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

// TS narrows `cls.key_dest` to the literal just assigned to it and (since it
// can't see inside Key_Event) never widens that narrowing back out across the
// call -- so `cls.key_dest = KeydestT.key_message; Key_Event(...);
// expect(keyDest()).toBe(KeydestT.key_game)` fails to typecheck even
// though it's correct at runtime. Reading through a function with an
// explicit return type forces the widen back to `KeydestT`.
function keyDest(): KeydestT {
  return cls.key_dest;
}

beforeEach(() => {
  cl.clear();
  cls.clear();
  con.clear();
  resetNetMessage();
  setRe(null);
  keybindings.fill(null);
  key_repeats.fill(0);
  setAnykeydown(0);

  // viddef.width stays 0 in this headless port (no platform/vid.ts yet), so
  // Con_CheckResize always takes its "video hasn't been initialized" branch:
  // linewidth pins to 38 deterministically, which every wrap test below
  // relies on.
  Con_Init();
  Key_Init();
});

describe("console_impl.ts -- Con_Print line wrapping and notify timestamps", () => {
  test("con.linewidth is the deterministic headless value Con_Init lands on", () => {
    expect(con.linewidth).toBe(38);
    expect(con.initialized).toBe(true);
  });

  test("a line-width's worth of one word wraps onto a second line via Con_Linefeed", () => {
    const before = con.current;

    // con.linewidth 'B's exactly fill the first line; the space right after
    // starts a new word, so the word-wrap scan (Con_Print's "count word
    // length" loop) cleanly hands off to the next line instead of tripping
    // its near-end-of-string early-wrap quirk (a single word with no spaces
    // at all shortens its own lookahead as it nears the string's end, which
    // triggers Con_Print's `con.x + l > con.linewidth` wrap early -- also
    // faithful to the C, just not what this test is demonstrating).
    Con_Print(`${"B".repeat(con.linewidth)} continued`);

    expect(con.current).toBe(before + 2);

    const firstLineStart = ((before + 1) % con.totallines) * con.linewidth;
    const firstLine = con.text.slice(firstLineStart, firstLineStart + con.linewidth);
    expect(firstLine).toBe("B".repeat(con.linewidth));

    const secondLineStart = ((before + 2) % con.totallines) * con.linewidth;
    const secondLine = con.text.slice(secondLineStart, secondLineStart + " continued".length);
    expect(secondLine).toBe(" continued");
  });

  test("Con_Linefeed advances con.current by one per line and marks the notify timestamp", () => {
    cls.realtime = 54321;
    const before = con.current;

    Con_Print("hi\n");

    expect(con.current).toBe(before + 1);
    expect(con.times[con.current % NUM_CON_TIMES]).toBe(54321);
  });

  test("multiple newlines advance con.current once per line, each stamped with the realtime at print", () => {
    cls.realtime = 1000;
    Con_Print("one\n");
    const afterFirst = con.current;

    cls.realtime = 2000;
    Con_Print("two\n");

    expect(con.current).toBe(afterFirst + 1);
    expect(con.times[afterFirst % NUM_CON_TIMES]).toBe(1000);
    expect(con.times[con.current % NUM_CON_TIMES]).toBe(2000);
  });
});

describe("keys_impl.ts -- binding round-trip", () => {
  test("Key_SetBinding/keybindings round-trip a direct call", () => {
    const keynum = Key_StringToKeynum("q");
    expect(keynum).toBe("q".charCodeAt(0));

    Key_SetBinding(keynum, "+moveup");
    expect(keybindings[keynum]).toBe("+moveup");

    Key_SetBinding(keynum, "");
    expect(keybindings[keynum]).toBe("");
  });

  test("Key_Bind_f reads its key/command through Cmd_TokenizeString, same as the console would", () => {
    Cmd_TokenizeString("bind a jump", true);
    Key_Bind_f();

    const keynum = Key_StringToKeynum("a");
    expect(keybindings[keynum]).toBe("jump");
  });

  test("Key_Unbind_f clears a binding set through Key_Bind_f", () => {
    Cmd_TokenizeString("bind b +attack", true);
    Key_Bind_f();
    expect(keybindings[Key_StringToKeynum("b")]).toBe("+attack");

    Cmd_TokenizeString("unbind b", true);
    Key_Unbind_f();
    expect(keybindings[Key_StringToKeynum("b")]).toBe("");
  });

  test("Key_Bind_f with a multi-word command joins the remaining args with spaces", () => {
    Cmd_TokenizeString('bind c "say hello there"', true);
    Key_Bind_f();
    expect(keybindings[Key_StringToKeynum("c")]).toBe("say hello there");
  });
});

// menu.c/qmenu.c (menu.ts/qmenu_impl.ts) landed as real implementations
// partway through this unit's work (they were still PendingPort throw stubs
// when this brief was written, per its "M_Menu stub throw handled" note) --
// these tests were written against the pending-stub world and are adjusted
// here to the real M_Menu_Main_f/M_Keydown/M_PushMenu/M_ForceMenuOff now
// in-tree, asserting the one thing keys_impl.ts itself owns: which handler
// cls.key_dest routes ESC to.
describe("keys_impl.ts -- Key_Event ESC dispatch by cls.key_dest", () => {
  test("key_dest=key_message: ESC is handled locally (Key_Message), never reaches the menu", () => {
    cls.key_dest = KeydestT.key_message;

    Key_Event(27 /* K_ESCAPE */, true, 0);
    expect(keyDest()).toBe(KeydestT.key_game);
  });

  test("key_dest=key_game: ESC dispatches to M_Menu_Main_f, which pushes the menu", () => {
    cls.key_dest = KeydestT.key_game;

    Key_Event(27, true, 0);
    expect(keyDest()).toBe(KeydestT.key_menu);
  });

  test("key_dest=key_console: ESC also dispatches to M_Menu_Main_f", () => {
    cls.key_dest = KeydestT.key_console;

    Key_Event(27, true, 0);
    expect(keyDest()).toBe(KeydestT.key_menu);
  });

  test("key_dest=key_menu: ESC dispatches to M_Keydown, which never itself changes key_dest", () => {
    M_ForceMenuOff(); // known-null menu.ts module state (m_keyfunc/m_drawfunc), independent of other tests in this file
    cls.key_dest = KeydestT.key_menu; // re-simulate already being in the menu after that reset

    expect(() => Key_Event(27, true, 0)).not.toThrow();
    expect(keyDest()).toBe(KeydestT.key_menu);
  });

  test("key up (down=false) is a no-op return for ESC, regardless of key_dest", () => {
    cls.key_dest = KeydestT.key_game;
    expect(() => Key_Event(27, false, 0)).not.toThrow();
    expect(keyDest()).toBe(KeydestT.key_game);
  });
});

describe("cl_inv.ts -- CL_ParseInventory", () => {
  test("reads MAX_ITEMS shorts off net_message into cl.inventory, in order", () => {
    for (let i = 0; i < MAX_ITEMS; i++) {
      MSG_WriteShort(net_message, i * 3 - 100);
    }
    MSG_BeginReading(net_message);

    CL_ParseInventory();

    expect(cl.inventory.length).toBe(MAX_ITEMS);
    for (let i = 0; i < MAX_ITEMS; i++) {
      expect(cl.inventory[i]).toBe(i * 3 - 100);
    }
  });
});
