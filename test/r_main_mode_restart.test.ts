/*
Tests for src/ref_soft/r_main.ts's R_BeginFrame mode-restart loop -- the
software-renderer twin of test/gl_rmain.test.ts's
"R_BeginFrame's mode-restart trigger covers vid_scale_fit" describe block.
Same bug, same fix, same reasoning; see that file's comment for the full
story (owner's play-test report: "scale to fullscreen: fit screen ... was
not applied at all" -- vid_scale_fit was missing from this file's own
rCvars entirely, so toggling ONLY "scale to fullscreen" in the video menu
never reached this restart loop at all).

R_BeginFrame's mode-restart loop calls SWimp_SetMode, which -- under this
suite's SDL_VIDEODRIVER=dummy posture -- degrades to the designed headless
fallback rather than exercising the real fullscreen-resize path this bug
lived in (see src/platform/swimp.ts's own header comment), so this reads
source directly for the same reason gl_rmain.test.ts's R_Init test does
rather than trying to observe the loop's real effect on a live SDLVID_Init
call. Self-sufficient per PORTING.md rule 13: reads the file fresh, no
shared state.
*/

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "src", "ref_soft", "r_main.ts"), "utf8");

describe("r_main.ts -- R_BeginFrame's mode-restart loop covers vid_scale_fit", () => {
  test("vid_scale_fit.modified joins sw_mode/vid_fullscreen/vid_scale in the restart while-condition", () => {
    expect(src).toContain(
      "while ((rCvars.sw_mode && rCvars.sw_mode.modified) || (rCvars.vid_fullscreen && rCvars.vid_fullscreen.modified) || (rCvars.vid_scale && rCvars.vid_scale.modified) || (rCvars.vid_scale_fit && rCvars.vid_scale_fit.modified)) {",
    );
  });

  test("the rserr_ok branch clears vid_scale_fit.modified (no re-trigger loop every frame)", () => {
    // both occurrences (rserr_ok success path, rserr_invalid_mode retry
    // path) reset the same four flags -- see r_main.ts's R_BeginFrame.
    const occurrences = src.split("if (rCvars.vid_scale_fit) rCvars.vid_scale_fit.modified = false;").length - 1;
    expect(occurrences).toBe(2);
  });

  test("rCvars registers vid_scale_fit with CVAR_ARCHIVE, matching vid.ts's VID_GetScaleFit default", () => {
    expect(src).toMatch(/rCvars\.vid_scale_fit = ri\.Cvar_Get\("vid_scale_fit", "1", CVAR_ARCHIVE\);/);
  });
});
