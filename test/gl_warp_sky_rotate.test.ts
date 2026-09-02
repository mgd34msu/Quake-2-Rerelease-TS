/*
Tests for src/ref_gl/gl_warp.ts -- pins R_DrawSkyBox's rotation math at the
seam identified in followups.md finding 9 (skybox rotating extremely fast,
reported in the classic port, audited here too). q2repro's src/refresh/
sky.c:253/364 scales sky rotation by refdef time in SECONDS:
`SetupRotationMatrix(skymatrix, skyaxis, glr.fd.time * skyrotate)`, and
src/client/view.c:584 builds that refdef time as `cl.refdef.time = cl.time *
0.001f` (cl.time is milliseconds). This test asserts the actual qglRotatef
call this module emits for a known skyrotate/refdef.time pair, with no GL
context needed (QGLRecording captures the call instead of touching real GL).

Self-sufficient per preferences.md rule 13: resets everything it reads (QGL
recording, ref imports, r_newrefdef.time, skyaxis/skyrotate via R_SetSky,
skymins/skymaxs via R_ClearSkyBox) so it never depends on another test
file's state.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import type { RefImports } from "../src/client/ref";
import { vec3 } from "../src/shared/math";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { SetRefImports, r_newrefdef } from "../src/ref_gl/gl_local";
import { R_SetSky, R_DrawSkyBox, R_ClearSkyBox, skymins, skymaxs, skyrotate, skyaxis } from "../src/ref_gl/gl_warp";

function makeFakeRi(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand: () => undefined,
    Cmd_RemoveCommand: () => undefined,
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => undefined,
    Con_Printf: () => undefined,
    FS_LoadFile: () => ({ length: -1, data: null }), // no real sky images on disk; R_SetSky falls back to r_notexture per face
    FS_FreeFile: () => undefined,
    FS_Gamedir: () => "",
    Cvar_Get: () => null,
    Cvar_Set: () => null,
    Cvar_SetValue: () => undefined,
    Vid_GetModeInfo: () => null,
    Vid_MenuInit: () => undefined,
    Vid_NewWindow: () => undefined,
  };
}

beforeEach(() => {
  SetQGL(new QGLRecording());
  SetRefImports(makeFakeRi());
  R_ClearSkyBox();
});

describe("gl_warp.ts -- R_DrawSkyBox rotation", () => {
  test("rotatedegrees = skyrotate * refdef.time (seconds): 8 deg/s * 2.0s = 16 degrees", () => {
    R_SetSky("unit", 8, true, vec3(0, 0, 1));
    r_newrefdef.time = 2.0;

    // mark face 0 visible so R_DrawSkyBox's "nothing visible" early-out
    // doesn't skip the rotate call (mirrors what R_AddSkySurface/ClipSkyPolygon
    // would have done during world traversal).
    skymins[0][0] = -0.5;
    skymins[1][0] = -0.5;
    skymaxs[0][0] = 0.5;
    skymaxs[1][0] = 0.5;

    const qgl = new QGLRecording();
    SetQGL(qgl);

    R_DrawSkyBox();

    const rotateCall = qgl.calls.find((c) => c.name === "qglRotatef");
    expect(rotateCall).toBeDefined();
    expect(rotateCall?.args[0]).toBeCloseTo(16, 10);
    expect(rotateCall?.args[1]).toBe(skyaxis[0]);
    expect(rotateCall?.args[2]).toBe(skyaxis[1]);
    expect(rotateCall?.args[3]).toBe(skyaxis[2]);
    expect(skyrotate).toBe(8);
  });

  test("regression guard: refdef.time in milliseconds (the 1000x-fast bug shape) would NOT be pinned here", () => {
    // documents the bug shape this test suite guards against: if refdef.time
    // were still in milliseconds (cl.time un-scaled), 8 deg/s * 2000ms =
    // 16000 degrees for the same 2-second mark -- 1000x the correct angle.
    R_SetSky("unit", 8, true, vec3(0, 0, 1));
    r_newrefdef.time = 2000; // the bug shape: milliseconds instead of seconds

    skymins[0][0] = -0.5;
    skymins[1][0] = -0.5;
    skymaxs[0][0] = 0.5;
    skymaxs[1][0] = 0.5;

    const qgl = new QGLRecording();
    SetQGL(qgl);

    R_DrawSkyBox();

    const rotateCall = qgl.calls.find((c) => c.name === "qglRotatef");
    expect(rotateCall?.args[0]).toBe(16000);
    expect(rotateCall?.args[0]).not.toBeCloseTo(16, 10);
  });
});
