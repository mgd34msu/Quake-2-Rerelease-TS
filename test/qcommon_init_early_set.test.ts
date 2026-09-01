/*
Parity regression test (Mike's task, 2026-08-31): vanilla 3.21's Qcommon_Init
(qcommon/common.c) exists specifically so a command-line "+set X Y" survives
a config file that also sets X. It does this with a two-pass shape:

    Cbuf_AddEarlyCommands(false);   // pass 1: "+set" args -> "set X Y", argv NOT cleared
    Cbuf_Execute();

    FS_InitFilesystem();

    Cbuf_AddText("exec default.cfg\n");
    Cbuf_AddText("exec config.cfg\n");

    Cbuf_AddEarlyCommands(true);    // pass 2: re-adds the SAME "set X Y" lines, THEN clears argv
    Cbuf_Execute();

Pass 1 exists only so early parms like basedir/cddir are live before configs
exec. Pass 2's re-added "set X Y" lines land in the command buffer AFTER
"exec config.cfg", and Cbuf_Execute's single pass then runs: default.cfg's
commands, then config.cfg's commands (via Cmd_Exec_f's Cbuf_InsertText,
which splices the file's text ahead of whatever is still queued behind it,
here "set X Y\n"), then finally the re-applied "set X Y" line -- so the
command line always has the last word. src/main.ts's Qcommon_Init (around
its own Cbuf_AddEarlyCommands(false)/Cbuf_AddEarlyCommands(true) pair)
mirrors this exactly.

Two describe blocks exercise this from two altitudes:

  - the top one drives the REAL Qcommon_Init over a synthetic (no retail
    data) basedir whose config.cfg sets vid_ref to "soft", passing
    "+set vid_ref gl" on the command line -- the literal repro from the bug
    report. dedicated=1 keeps this out of CL_Init's VID_Init/ref_soft/SDL
    path entirely (cl_main.ts's CL_Init returns immediately when
    dedicated.value is set, before ever reaching VID_Init), so this only
    exercises qcommon/cmd/cvar/files -- the areas this task is scoped to.

  - the bottom one drives Cbuf_AddEarlyCommands/Cbuf_Execute directly with no
    filesystem involved at all, as a pure-mechanism unit test, and includes a
    negative control (only ONE early-commands pass before the config-style
    "set" line) that ends with the config value winning -- proving this
    harness can actually tell the two shapes apart, not just trivially pass.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { COM_InitArgv } from "../src/qcommon/common";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_Init, Cbuf_AddEarlyCommands } from "../src/qcommon/cmd";
import { Cvar_Init } from "../src/qcommon/cvar";
import { NET_Shutdown } from "../src/platform/net_udp";
import { Qcommon_Init } from "../src/main";
import { SV_Shutdown } from "../src/server/sv_main";

describe("src/main.ts -- Qcommon_Init: command-line +set survives config.cfg (vanilla common.c parity)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2earlyset-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir, { recursive: true });
    writeFileSync(join(baseq2Dir, "default.cfg"), "");
    writeFileSync(join(baseq2Dir, "config.cfg"), "set vid_ref soft\n");

    // Preempt CVAR_NOSET/CVAR_LATCH flags an earlier test file's own boot in
    // this same bun process may already have stamped onto these names
    // (test/boot.test.ts's own comment explains why this is needed): the
    // equivalent "+set ..." argv below still runs for real through
    // Qcommon_Init's own Cbuf_AddEarlyCommands, this just unblocks it.
    Cvar_ForceSet("basedir", tmpRoot);
    Cvar_ForceSet("game", "");
    Cvar_ForceSet("port", "0");
    Cvar_ForceSet("dedicated", "1");
    Cvar_ForceSet("coop", "1");
    Cvar_ForceSet("deathmatch", "0");

    Qcommon_Init(["quake2", "+set", "basedir", tmpRoot, "+set", "dedicated", "1", "+set", "port", "0", "+set", "vid_ref", "gl"]);
  });

  afterAll(async () => {
    SV_Shutdown("qcommon_init_early_set test finished\n", false);
    await NET_Shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('vid_ref ends up "gl" even though config.cfg sets it to "soft"', () => {
    expect(Cvar_VariableString("vid_ref")).toBe("gl");
  });
});

describe("src/qcommon/cmd.ts -- Cbuf_AddEarlyCommands: two-pass re-application (no filesystem involved)", () => {
  beforeAll(() => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
  });

  test("a +set argument re-applied after a config-style \"set\" line wins (the real two-pass shape)", () => {
    COM_InitArgv(["quake2", "+set", "parity_early_cvar", "gl"]);

    // pass 1 (clear=false): live before "config" execs, argv survives
    Cbuf_AddEarlyCommands(false);
    Cbuf_Execute();
    expect(Cvar_VariableString("parity_early_cvar")).toBe("gl");

    // stand-in for "exec config.cfg" setting the same cvar to something else
    Cbuf_AddText("set parity_early_cvar soft\n");

    // pass 2 (clear=true): re-adds "set parity_early_cvar gl" AFTER the
    // config-style line above, then clears argv so late commands can't see
    // it a third time -- mirrors src/main.ts's own
    // Cbuf_AddEarlyCommands(true) call, queued after "exec config.cfg" the
    // same way.
    Cbuf_AddEarlyCommands(true);
    Cbuf_Execute();

    expect(Cvar_VariableString("parity_early_cvar")).toBe("gl");
  });

  test("negative control: with only a single early-commands pass, the config-style line wins instead", () => {
    COM_InitArgv(["quake2", "+set", "parity_early_cvar_control", "gl"]);

    Cbuf_AddEarlyCommands(false);
    Cbuf_Execute();
    expect(Cvar_VariableString("parity_early_cvar_control")).toBe("gl");

    // same config-style override, but this time nothing re-applies the
    // command-line value afterward
    Cbuf_AddText("set parity_early_cvar_control soft\n");
    Cbuf_Execute();

    expect(Cvar_VariableString("parity_early_cvar_control")).toBe("soft");
  });
});
