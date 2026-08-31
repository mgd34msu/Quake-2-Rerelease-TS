/*
Tests for src/ref_gl/gl_rmain.ts, per this unit's brief (rule 13):
self-sufficient, no reliance on any other test file having run first. Each
test resets exactly the shared module state it reads (frustum planes,
r_nocull cvar, QGL recording).
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vec3 } from "../src/shared/math";
import { CvarT } from "../src/shared/q_shared";
import { PLANE_X } from "../src/qcommon/qfiles";
import { EntityT } from "../src/client/ref";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { frustum, glCvars } from "../src/ref_gl/gl_local";
import { R_CullBox, R_RotateForEntity } from "../src/ref_gl/gl_rmain";

function resetFrustumToNeutral(): void {
  // neutral axial planes at the origin: BOX_ON_PLANE_SIDE's fast path
  // (`p.type < 3`) returns 3 ("straddles") for any box containing the
  // origin on both sides, which R_CullBox treats as "not culled" -- tests
  // that need an actual cull overwrite the plane(s) they need.
  for (const p of frustum) {
    p.normal = vec3(1, 0, 0);
    p.dist = 0;
    p.type = PLANE_X;
    p.signbits = 0;
  }
}

beforeEach(() => {
  SetQGL(new QGLRecording());
  glCvars.r_nocull = null;
  resetFrustumToNeutral();
});

describe("gl_rmain.ts -- R_CullBox", () => {
  test("box entirely behind a frustum plane is culled", () => {
    // plane x=0 (normal (1,0,0), dist 0); box spans x in [-20,-10], fully on
    // the negative side -- BOX_ON_PLANE_SIDE's axial fast path returns 2
    // (`dist >= emaxs[type]` since 0 >= -10), which R_CullBox treats as cull.
    frustum[0].normal = vec3(1, 0, 0);
    frustum[0].dist = 0;
    frustum[0].type = PLANE_X;

    const mins = vec3(-20, -5, -5);
    const maxs = vec3(-10, 5, 5);

    expect(R_CullBox(mins, maxs)).toBe(true);
  });

  test("box straddling every frustum plane is not culled", () => {
    for (const p of frustum) {
      p.normal = vec3(1, 0, 0);
      p.dist = 0;
      p.type = PLANE_X;
    }
    const mins = vec3(-10, -10, -10);
    const maxs = vec3(10, 10, 10);

    expect(R_CullBox(mins, maxs)).toBe(false);
  });

  test("box behind only one of the four planes is still culled (any plane at side 2 culls)", () => {
    // planes 0-2 straddle; plane 3 fully rejects the box.
    frustum[3].normal = vec3(1, 0, 0);
    frustum[3].dist = 100;
    frustum[3].type = PLANE_X;

    const mins = vec3(-10, -10, -10);
    const maxs = vec3(10, 10, 10);

    expect(R_CullBox(mins, maxs)).toBe(true);
  });

  test("r_nocull cvar forces false regardless of frustum", () => {
    frustum[0].normal = vec3(1, 0, 0);
    frustum[0].dist = 0;
    frustum[0].type = PLANE_X;

    const mins = vec3(-20, -5, -5);
    const maxs = vec3(-10, 5, 5);

    const nocull = new CvarT();
    nocull.value = 1;
    glCvars.r_nocull = nocull;

    expect(R_CullBox(mins, maxs)).toBe(false);
  });
});

describe("gl_rmain.ts -- R_RotateForEntity", () => {
  test("emits qglTranslatef then yaw/pitch/roll qglRotatef calls in the C source's exact order", () => {
    const rec = new QGLRecording();
    SetQGL(rec);

    const e = new EntityT();
    e.origin = vec3(1, 2, 3);
    e.angles = vec3(10, 20, 30); // [PITCH, YAW, ROLL]

    R_RotateForEntity(e);

    expect(rec.calls.map((c) => c.name)).toEqual(["qglTranslatef", "qglRotatef", "qglRotatef", "qglRotatef"]);
    expect(rec.calls[0]?.args).toEqual([1, 2, 3]);
    expect(rec.calls[1]?.args).toEqual([20, 0, 0, 1]); // qglRotatef(angles[YAW], 0,0,1)
    expect(rec.calls[2]?.args).toEqual([-10, 0, 1, 0]); // qglRotatef(-angles[PITCH], 0,1,0)
    expect(rec.calls[3]?.args).toEqual([-30, 1, 0, 0]); // qglRotatef(-angles[ROLL], 1,0,0)
  });
});

describe("gl_rmain.ts -- R_Init's GL string dump matches q2repro's verbosity", () => {
  // R_Init's GL-string block can't be driven end to end headlessly: it sits
  // behind glimp.Init/QGL_Init/R_SetMode, none of which have a real OpenGL
  // context to bind to in this test environment (see ref_frame.test.ts's
  // header note that the software renderer's R_Init is the only one that
  // runs headless -- ref_gl's needs a real GL context). This reads the
  // source directly instead, pinning the print-level regression: q2repro
  // (src/refresh/qgl.c QGL_Init, ~lines 492-500 and 585) prints
  // GL_VENDOR/GL_RENDERER/GL_VERSION via Com_DPrintf (developer-only) and
  // never prints the raw GL_EXTENSIONS string at normal verbosity at all
  // (that's gated behind the "strings" console command, src/refresh/main.c's
  // GL_Strings_f, and even there only with an explicit argument). This
  // port's R_Init keeps vendor/renderer/version at normal (PRINT_ALL, unlike
  // q2repro's Com_DPrintf) since those are short, single-line, and useful
  // without -developer, but the multi-hundred-token GL_EXTENSIONS dump must
  // not flood the console at normal verbosity -- PRINT_DEVELOPER matches
  // q2repro's "never at normal verbosity" behavior for that one line.
  const src = readFileSync(join(import.meta.dir, "..", "src", "ref_gl", "gl_rmain.ts"), "utf8");

  test("GL_VENDOR/GL_RENDERER/GL_VERSION stay at PRINT_ALL", () => {
    expect(src).toMatch(/ri\.Con_Printf\(PRINT_ALL, `GL_VENDOR: \$\{gl_config\.vendor_string\}\\n`\);/);
    expect(src).toMatch(/ri\.Con_Printf\(PRINT_ALL, `GL_RENDERER: \$\{gl_config\.renderer_string\}\\n`\);/);
    expect(src).toMatch(/ri\.Con_Printf\(PRINT_ALL, `GL_VERSION: \$\{gl_config\.version_string\}\\n`\);/);
  });

  test("GL_EXTENSIONS is printed at PRINT_DEVELOPER, not PRINT_ALL", () => {
    expect(src).toMatch(/ri\.Con_Printf\(PRINT_DEVELOPER, `GL_EXTENSIONS: \$\{gl_config\.extensions_string\}\\n`\);/);
    expect(src).not.toMatch(/ri\.Con_Printf\(PRINT_ALL, `GL_EXTENSIONS:/);
  });
});
