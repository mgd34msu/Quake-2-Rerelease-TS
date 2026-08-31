// Divergence-audit wave-B visible-wrong fix: src/client/cl_parse.ts's
// svc_locprint dispatch used to call readLocprintKex() purely to stay
// byte-aligned and discard the decoded { flags, base, args }, so every
// Loc_Print-driven message from a real external q2repro/rerelease server
// (or KEX demo playback) silently vanished -- neither the console nor a
// centerprint banner ever showed it, even though the bytes were decoded
// correctly.
//
// Reference: q2repro src/client/parse.c:1226-1248 CL_ParseLocPrint --
// localize base+args via Loc_Localize, then route the result through the
// same level dispatch as svc_print's CL_HandlePrint (PRINT_CHAT plays a
// sound; PRINT_CENTER/PRINT_TYPEWRITER become a centerprint banner;
// everything else is a plain console line).
//
// Follows test/loc_print_key_expansion.test.ts's own precedent: capture
// console output via Com_BeginRedirect/Com_EndRedirect (SCR_CenterPrint's
// banner separator proves the centerprint path was taken, not a bare
// console echo) rather than reaching into cl_scrn.ts's module-private
// queue state.

import { describe, test, expect, beforeEach } from "bun:test";
import { SvcOpsT } from "../src/qcommon/qcommon";
import { SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteString } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { cl, cls, clCvars, setRe } from "../src/client/client";
import { CL_ParseServerMessage } from "../src/client/cl_parse";
import { PrintTypeT } from "../src/kexapi/game";
import { Com_BeginRedirect, Com_EndRedirect } from "../src/qcommon/common";

// ServerCommandT.svc_locprint's numeric value (kexapi/game.ts) -- shares
// SvcOpsT's own numbering space (verified by test/cl_demo.test.ts's own
// header comment), written directly since importing ServerCommandT just
// for this one constant would pull in the whole kex opcode enum.
const SVC_LOCPRINT = 26;

beforeEach(() => {
  cl.clear();
  cls.clear();
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
  clCvars.cl_shownet = null;
  setRe(null);
});

function sendLocprint(flags: number, base: string, args: string[]): string {
  SZ_Clear(net_message);
  MSG_WriteByte(net_message, SVC_LOCPRINT);
  MSG_WriteByte(net_message, flags);
  MSG_WriteString(net_message, base);
  MSG_WriteByte(net_message, args.length);
  for (const a of args) MSG_WriteString(net_message, a);
  MSG_BeginReading(net_message);

  let captured = "";
  Com_BeginRedirect(1, 1 << 16, (_target, buffer) => {
    captured += buffer;
  });
  try {
    CL_ParseServerMessage();
  } finally {
    Com_EndRedirect();
  }
  return captured;
}

describe("cl_parse.ts svc_locprint -- localizes and displays instead of discarding", () => {
  test("a plain (non-$, no-argument) base string reaches the console verbatim, localized", () => {
    const out = sendLocprint(PrintTypeT.PRINT_HIGH, "plain string, no placeholders", []);
    expect(out).toBe("plain string, no placeholders");
  });

  test("an in-place {0} format string is substituted from args, with no loc-file registration needed", () => {
    const out = sendLocprint(PrintTypeT.PRINT_LOW, "Picked up {0}", ["Body Armor"]);
    expect(out).toBe("Picked up Body Armor");
  });

  test("an unregistered $key falls back to the key text minus its leading '$' (Loc_Localize's own documented miss behavior)", () => {
    const out = sendLocprint(PrintTypeT.PRINT_HIGH, "$totally_unregistered_key", []);
    expect(out).toBe("totally_unregistered_key");
  });

  test("PRINT_CENTER routes through SCR_CenterPrint's banner instead of a bare console line", () => {
    const out = sendLocprint(PrintTypeT.PRINT_CENTER, "Objective: {0}", ["Find the exit"]);
    expect(out).toContain("\x1d\x1e"); // SCR_CenterPrint's banner separator
    expect(out).toContain("Objective: Find the exit");
    expect(out).not.toBe("Objective: Find the exit"); // not a bare unpadded echo
  });

  test("PRINT_TYPEWRITER also routes through SCR_CenterPrint's banner", () => {
    const out = sendLocprint(PrintTypeT.PRINT_TYPEWRITER, "typed out message", []);
    expect(out).toContain("\x1d\x1e");
    expect(out).toContain("typed out message");
  });

  test("PRINT_CHAT does not throw (sound + notify ormask side effects, no renderer/sound backend needed)", () => {
    expect(() => sendLocprint(PrintTypeT.PRINT_CHAT, "chat message", [])).not.toThrow();
  });
});
