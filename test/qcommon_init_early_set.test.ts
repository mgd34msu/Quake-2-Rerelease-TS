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
    It runs in a SPAWNED bun subprocess, not this test process: a full
    engine init is a one-per-process affair (src/main.ts's own catch turns
    any ComError during init into Sys_Error, i.e. process exit), and an
    earlier suite in the same process -- test/boot.test.ts under some file
    orderings -- has already spent this process's init. A subprocess makes
    the test immune to suite file ordering AND makes an init failure a
    plain test failure instead of aborting the whole bun test run (which
    is exactly what happened at the first clean-worktree landing gate that
    ran this file after boot.test.ts).

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
import { Cvar_VariableString } from "../src/qcommon/cvar";
import { COM_InitArgv } from "../src/qcommon/common";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_Init, Cbuf_AddEarlyCommands } from "../src/qcommon/cmd";
import { Cvar_Init } from "../src/qcommon/cvar";

describe("src/main.ts -- Qcommon_Init: command-line +set survives config.cfg (vanilla common.c parity)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2earlyset-"));
    const baseq2Dir = join(tmpRoot, "baseq2");
    mkdirSync(baseq2Dir, { recursive: true });
    writeFileSync(join(baseq2Dir, "default.cfg"), "");
    writeFileSync(join(baseq2Dir, "config.cfg"), "set vid_ref soft\n");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('vid_ref ends up "gl" even though config.cfg sets it to "soft"', async () => {
    // The driver boots the real engine (dedicated, port 0, synthetic
    // basedir) and prints the post-init vid_ref value on a marker line.
    // import.meta.dir is this test file's directory, so the src/ path
    // works from any cwd.
    const driver = join(tmpRoot, "earlyset_driver.ts");
    writeFileSync(
      driver,
      `import { Qcommon_Init } from ${JSON.stringify(join(import.meta.dir, "../src/main.ts"))};
import { Cvar_VariableString } from ${JSON.stringify(join(import.meta.dir, "../src/qcommon/cvar.ts"))};
Qcommon_Init(["quake2", "+set", "basedir", ${JSON.stringify(tmpRoot)}, "+set", "dedicated", "1", "+set", "port", "0", "+set", "vid_ref", "gl"]);
console.log("EARLYSET_RESULT vid_ref=" + Cvar_VariableString("vid_ref"));
process.exit(0);
`,
    );
    const proc = Bun.spawn(["bun", "run", driver], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const marker = out.split("\n").find((l) => l.startsWith("EARLYSET_RESULT "));
    expect(`exit=${code} ${marker ?? `NO_MARKER stderr=${err.slice(0, 400)}`}`).toBe("exit=0 EARLYSET_RESULT vid_ref=gl");
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
