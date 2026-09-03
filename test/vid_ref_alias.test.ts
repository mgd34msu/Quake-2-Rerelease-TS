/*
VID_CanonicalRefName (src/platform/vid.ts): this port has "gl" and "soft";
any other vid_ref value means gl. Mike's lmctf tree carried an R1Q2-era
autoexec.cfg with `set vid_ref "r1gl"`, which used to fail the load and drop
the session to software on every switch into the mod (play-test 2026-09-02).
*/

import { describe, test, expect } from "bun:test";
import { VID_CanonicalRefName } from "../src/platform/vid";

describe("VID_CanonicalRefName", () => {
  test("gl stays gl; soft and vanilla's softx stay soft", () => {
    expect(VID_CanonicalRefName("gl")).toBe("gl");
    expect(VID_CanonicalRefName("soft")).toBe("soft");
    expect(VID_CanonicalRefName("softx")).toBe("soft");
  });

  test("any other name means gl, never a failed load", () => {
    for (const n of ["r1gl", "R1GL", "glx", "kmgl", "gl1", "vulkan"]) expect(VID_CanonicalRefName(n)).toBe("gl");
  });
});
