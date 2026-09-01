/*
Part G audit (Mike, 2026-09-01): the owner suspects fullscreen (and friends)
don't survive a restart. This exercises the whole video-cvar archive-to-disk
round trip for the seven cvars audited in this task's report: vid_fullscreen,
gl_mode, sw_mode, r_customwidth, r_customheight, vid_scale, vid_scale_fit.

Real registration functions are used where practical (VID_GetModeInfo(-1)/
VID_GetScale/VID_GetScaleFit from src/platform/vid.ts register
r_customwidth/r_customheight/vid_scale/vid_scale_fit with CVAR_ARCHIVE;
VID_MenuInit from src/platform/vid_menu.ts registers vid_fullscreen/gl_mode/
sw_mode the same way -- see that file's own Part-G bug-fix comment on
gl_mode/sw_mode, previously registered there with flags=0). Cvar_WriteVariables
writes to a fresh temp file under os.tmpdir() (never inside the repo, per
this task's brief); Cbuf_AddText+Cbuf_Execute (the real "set" command path,
Cvar_Init's own registration) re-execs that file's content to simulate a
fresh boot's config.cfg exec, proving the round trip actually restores state
rather than the assertion being trivially true because nothing touched the
cvars in between.

Self-sufficient per PORTING.md rule 13: Cbuf_Init/Cmd_Init/Cvar_Init are all
idempotent (Cmd_AddCommand no-ops on an already-registered name, Cbuf_Init
just resets the shared command-text buffer), so calling them here is safe
regardless of what other test files in the same process already did.
*/

import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_Init, Cvar_SetValue, Cvar_VariableValue, Cvar_WriteVariables } from "../src/qcommon/cvar";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_Init } from "../src/qcommon/cmd";
import { VID_GetModeInfo, VID_GetScale, VID_GetScaleFit } from "../src/platform/vid";
import { VID_MenuInit, s_shadows_box, s_shadow_quality_slider } from "../src/platform/vid_menu";

const CVAR_NAMES = ["vid_fullscreen", "gl_mode", "sw_mode", "r_customwidth", "r_customheight", "vid_scale", "vid_scale_fit"] as const;

// Non-default values, one per cvar, chosen to differ from every default
// registered anywhere in this codebase (vid_fullscreen "0", gl_mode "3",
// sw_mode "0", r_customwidth 1920, r_customheight 1080, vid_scale 1,
// vid_scale_fit "1").
const MODIFIED: Record<(typeof CVAR_NAMES)[number], number> = {
  vid_fullscreen: 1,
  gl_mode: 6,
  sw_mode: 4,
  r_customwidth: 2560,
  r_customheight: 1440,
  vid_scale: 0.5,
  vid_scale_fit: 0,
};

// A third set of values, distinct from both the defaults and MODIFIED --
// written between the archive write and the re-exec step below to prove the
// re-exec genuinely restores MODIFIED's values rather than the assertion
// being trivially true because nothing ever changed them.
const CLOBBERED: Record<(typeof CVAR_NAMES)[number], number> = {
  vid_fullscreen: 0,
  gl_mode: 5,
  sw_mode: 2,
  r_customwidth: 800,
  r_customheight: 600,
  vid_scale: 0.25,
  vid_scale_fit: 1,
};

// Mirrors Cvar_SetValue's own %i/%f formatting (src/qcommon/cvar.ts) so the
// expected `set <name> "<value>"` lines match Cvar_WriteVariables' output
// byte-for-byte.
function formatCvarValue(value: number): string {
  return value === Math.trunc(value) ? String(Math.trunc(value)) : value.toFixed(6);
}

function registerAllSeven(): void {
  // r_customwidth/r_customheight: VID_GetModeInfo(-1) is vid.ts's own
  // custom-mode lookup, which lazily registers both with CVAR_ARCHIVE (see
  // vid.ts's customModeInfo).
  VID_GetModeInfo(-1);
  // vid_scale / vid_scale_fit: vid.ts's own lazy-registration getters.
  VID_GetScale();
  VID_GetScaleFit();
  // vid_fullscreen / gl_mode / sw_mode: vid_menu.ts's VID_MenuInit lazily
  // registers all three (gl_mode/sw_mode now with CVAR_ARCHIVE -- see this
  // task's Part-G bug fix in that file).
  VID_MenuInit();
}

function setAll(values: Record<(typeof CVAR_NAMES)[number], number>): void {
  for (const name of CVAR_NAMES) Cvar_SetValue(name, values[name]);
}

function assertValues(values: Record<(typeof CVAR_NAMES)[number], number>): void {
  for (const name of CVAR_NAMES) {
    expect(Cvar_VariableValue(name)).toBeCloseTo(values[name], 6);
  }
}

let tmpPath: string | null = null;

afterEach(() => {
  if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath);
  tmpPath = null;
});

// v1.1.0 shadow mapping: the two video-menu rows (vid_menu.ts's
// s_shadows_box / s_shadow_quality_slider) must survive a restart the same
// way the seven above do. Registered with CVAR_ARCHIVE by ref_gl's
// R_Register and, for a session where the GL renderer never started, lazily
// by VID_MenuInit -- which is what this suite exercises, since it never
// boots a renderer.
const SHADOW_CVAR_NAMES = ["gl_shadowmaps", "gl_shadowmap_res"] as const;

describe("shadow-mapping video cvars survive a restart (v1.1.0)", () => {
  test("both are registered with CVAR_ARCHIVE, so Cvar_WriteVariables emits a set line for each", () => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
    VID_MenuInit();

    // non-defaults (defaults are "1" and "512")
    Cvar_SetValue("gl_shadowmaps", 0);
    Cvar_SetValue("gl_shadowmap_res", 1024);

    tmpPath = join(tmpdir(), `q2rets-shadow-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    Cvar_WriteVariables(tmpPath);

    const written = readFileSync(tmpPath, "utf8");
    expect(written).toContain('set gl_shadowmaps "0"');
    expect(written).toContain('set gl_shadowmap_res "1024"');
  });

  test("re-execing the archived file restores both values after they are clobbered", () => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
    VID_MenuInit();

    Cvar_SetValue("gl_shadowmaps", 0);
    Cvar_SetValue("gl_shadowmap_res", 256);

    tmpPath = join(tmpdir(), `q2rets-shadow-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    Cvar_WriteVariables(tmpPath);
    const written = readFileSync(tmpPath, "utf8");

    // third, distinct values -- proves the restore is real
    Cvar_SetValue("gl_shadowmaps", 1);
    Cvar_SetValue("gl_shadowmap_res", 1024);
    expect(Cvar_VariableValue("gl_shadowmaps")).toBe(1);
    expect(Cvar_VariableValue("gl_shadowmap_res")).toBe(1024);

    Cbuf_AddText(written);
    Cbuf_Execute();

    expect(Cvar_VariableValue("gl_shadowmaps")).toBe(0);
    expect(Cvar_VariableValue("gl_shadowmap_res")).toBe(256);
  });

  test("the menu rows pick the restored values back up on the next VID_MenuInit", () => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
    VID_MenuInit();

    Cvar_SetValue("gl_shaders", 1);
    Cvar_SetValue("gl_shadowmaps", 0);
    Cvar_SetValue("gl_shadowmap_res", 1024);

    tmpPath = join(tmpdir(), `q2rets-shadow-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    Cvar_WriteVariables(tmpPath);
    const written = readFileSync(tmpPath, "utf8");

    Cvar_SetValue("gl_shadowmaps", 1);
    Cvar_SetValue("gl_shadowmap_res", 256);

    Cbuf_AddText(written);
    Cbuf_Execute();
    VID_MenuInit();

    expect(s_shadows_box.curvalue).toBe(0);
    expect(s_shadow_quality_slider.curvalue).toBe(2); // 1024 -> "high"
  });

  for (const name of SHADOW_CVAR_NAMES) {
    test(`${name} is not silently dropped from the archive when left at its default`, () => {
      Cbuf_Init();
      Cmd_Init();
      Cvar_Init();
      VID_MenuInit();

      tmpPath = join(tmpdir(), `q2rets-shadow-default-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
      Cvar_WriteVariables(tmpPath);
      expect(readFileSync(tmpPath, "utf8")).toContain(`set ${name} "`);
    });
  }
});

describe("video cvar archive round trip (Part G: does fullscreen/scale survive a restart)", () => {
  test("all seven cvars are registered with CVAR_ARCHIVE (Cvar_WriteVariables emits a set line for each)", () => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
    registerAllSeven();
    setAll(MODIFIED);

    tmpPath = join(tmpdir(), `q2rets-vid-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    Cvar_WriteVariables(tmpPath);

    const written = readFileSync(tmpPath, "utf8");
    for (const name of CVAR_NAMES) {
      const expectedLine = `set ${name} "${formatCvarValue(MODIFIED[name])}"`;
      expect(written).toContain(expectedLine);
    }
  });

  test("re-execing the written file's content (simulating a fresh boot's config.cfg exec) restores every value -- nothing resets them afterward", () => {
    Cbuf_Init();
    Cmd_Init();
    Cvar_Init();
    registerAllSeven();
    setAll(MODIFIED);

    tmpPath = join(tmpdir(), `q2rets-vid-persistence-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.cfg`);
    Cvar_WriteVariables(tmpPath);
    const written = readFileSync(tmpPath, "utf8");

    // Prove the round trip is real: clobber every one of the seven cvars to
    // a third, distinct value before re-execing.
    setAll(CLOBBERED);
    assertValues(CLOBBERED);

    // Simulate a fresh-boot config.cfg exec: feed the archived file's own
    // `set <name> "<value>"` lines through the real command path (the same
    // "set" command Cvar_Init registers, the same Cbuf_AddText/Cbuf_Execute
    // pump main.ts's own Qcommon_Init uses for "exec config.cfg").
    Cbuf_AddText(written);
    Cbuf_Execute();

    assertValues(MODIFIED);
  });
});
