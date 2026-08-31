/*
Pure table tests for src/qcommon/img_resolve.ts's imageExtCandidates against
q2repro's own algorithm (src/refresh/images.c: load_image_data 1819-1855,
try_other_formats 1669-1691, default r_texture_formats "png jpg tga" order,
images.c:2258) plus this port's own three added formats (jpeg/bmp/gif, no
q2repro precedent -- see img_resolve.ts's own header comment) -- see that
module's own header comment for the full derivation. No filesystem, no
renderer state: this is a self-contained function-in/list-out check,
matching rule 13's self-sufficiency requirement trivially (there is no
global state to set up).

Table entries below were hand-derived by walking img_resolve.ts's algorithm
for each (requestedExt, isWall) combination (mirrors q2repro's own
load_image_data/try_other_formats shape, extended with jpeg/bmp/gif always
slotted after tga per SEARCH_ORDER):
  - non-wall, native pcx already tried: the search loop runs every other
    entry (none equal pcx), then the native fallback slot (pcx, since
    type != wall) equals the already-tried extension -- skipped.
    -> pcx, png, jpg, tga, jpeg, bmp, gif
  - non-wall, requested one of the six search-order extensions: the loop
    skips only the one requested; the pcx fallback (never equal to any of
    the six) always runs last.
  - wall, native wal already tried: the loop runs every search-order entry
    (never equal wal); the fallback slot is wal (type == wall), equal to
    the already-tried extension -- skipped. -> wal, png, jpg, tga, jpeg,
    bmp, gif (never pcx -- walls were never a PCX format).
  - wall, requested one of the six search-order extensions: loop skips the
    one requested; the wal fallback (never equal to any of the six) always
    runs last.
  - unrecognized/unsupported extension (null, or a supported-set literal
    that isn't actually in the supplied `supported` set): skips the leading
    try-as-is and runs the full search plus native fallback.
*/

import { describe, test, expect } from "bun:test";
import { imageExtCandidates, type ImgExtT } from "../src/qcommon/img_resolve";

const GL_EXTS: readonly ImgExtT[] = ["pcx", "wal", "tga", "png", "jpg", "jpeg", "bmp", "gif"];
const SOFT_EXTS: readonly ImgExtT[] = ["pcx", "wal", "png", "jpg", "jpeg", "bmp", "gif"];

describe("imageExtCandidates -- GL renderer (all eight formats decodable)", () => {
  test.each([
    ["pcx", false, ["pcx", "png", "jpg", "tga", "jpeg", "bmp", "gif"]],
    ["png", false, ["png", "jpg", "tga", "jpeg", "bmp", "gif", "pcx"]],
    ["jpg", false, ["jpg", "png", "tga", "jpeg", "bmp", "gif", "pcx"]],
    ["tga", false, ["tga", "png", "jpg", "jpeg", "bmp", "gif", "pcx"]],
    ["jpeg", false, ["jpeg", "png", "jpg", "tga", "bmp", "gif", "pcx"]],
    ["bmp", false, ["bmp", "png", "jpg", "tga", "jpeg", "gif", "pcx"]],
    ["gif", false, ["gif", "png", "jpg", "tga", "jpeg", "bmp", "pcx"]],
    ["wal", true, ["wal", "png", "jpg", "tga", "jpeg", "bmp", "gif"]],
    ["png", true, ["png", "jpg", "tga", "jpeg", "bmp", "gif", "wal"]],
    ["jpg", true, ["jpg", "png", "tga", "jpeg", "bmp", "gif", "wal"]],
    ["tga", true, ["tga", "png", "jpg", "jpeg", "bmp", "gif", "wal"]],
    ["jpeg", true, ["jpeg", "png", "jpg", "tga", "bmp", "gif", "wal"]],
    ["bmp", true, ["bmp", "png", "jpg", "tga", "jpeg", "gif", "wal"]],
    ["gif", true, ["gif", "png", "jpg", "tga", "jpeg", "bmp", "wal"]],
  ] satisfies [ImgExtT, boolean, ImgExtT[]][])("requested=%s isWall=%s -> %j", (requested, isWall, expected) => {
    expect(imageExtCandidates(requested, isWall, GL_EXTS)).toEqual(expected);
  });

  test("a wall requested as .pcx still falls back to .wal (fallback rung differs from the requested extension)", () => {
    // orig=pcx, isWall=true: the search loop tries every other entry (none
    // equal pcx), then the native fallback slot is wal (isWall==true),
    // which does NOT equal orig (pcx) here -- so wal gets a real extra
    // try, unlike the "wal requested, isWall" case where the fallback slot
    // collides with orig and is skipped.
    expect(imageExtCandidates("pcx", true, GL_EXTS)).toEqual(["pcx", "png", "jpg", "tga", "jpeg", "bmp", "gif", "wal"]);
  });

  test("unrecognized extension (null) runs the full search with no leading as-is try", () => {
    expect(imageExtCandidates(null, false, GL_EXTS)).toEqual(["png", "jpg", "tga", "jpeg", "bmp", "gif", "pcx"]);
    expect(imageExtCandidates(null, true, GL_EXTS)).toEqual(["png", "jpg", "tga", "jpeg", "bmp", "gif", "wal"]);
  });
});

describe("imageExtCandidates -- software renderer (no TGA decoder)", () => {
  test.each([
    ["pcx", false, ["pcx", "png", "jpg", "jpeg", "bmp", "gif"]],
    ["png", false, ["png", "jpg", "jpeg", "bmp", "gif", "pcx"]],
    ["jpg", false, ["jpg", "png", "jpeg", "bmp", "gif", "pcx"]],
    ["jpeg", false, ["jpeg", "png", "jpg", "bmp", "gif", "pcx"]],
    ["bmp", false, ["bmp", "png", "jpg", "jpeg", "gif", "pcx"]],
    ["gif", false, ["gif", "png", "jpg", "jpeg", "bmp", "pcx"]],
    ["wal", true, ["wal", "png", "jpg", "jpeg", "bmp", "gif"]],
    ["png", true, ["png", "jpg", "jpeg", "bmp", "gif", "wal"]],
    ["jpg", true, ["jpg", "png", "jpeg", "bmp", "gif", "wal"]],
    ["jpeg", true, ["jpeg", "png", "jpg", "bmp", "gif", "wal"]],
    ["bmp", true, ["bmp", "png", "jpg", "jpeg", "gif", "wal"]],
    ["gif", true, ["gif", "png", "jpg", "jpeg", "bmp", "wal"]],
  ] satisfies [ImgExtT, boolean, ImgExtT[]][])("requested=%s isWall=%s -> %j", (requested, isWall, expected) => {
    expect(imageExtCandidates(requested, isWall, SOFT_EXTS)).toEqual(expected);
  });

  test("a requested .tga (unsupported by this renderer) still searches every other format and the native fallback", () => {
    // "tga" is absent from SOFT_EXTS, so has(requestedExt) is false: the
    // leading as-is try is skipped (same shape as the unrecognized-
    // extension case), but the search loop and native fallback still run.
    expect(imageExtCandidates("tga", false, SOFT_EXTS)).toEqual(["png", "jpg", "jpeg", "bmp", "gif", "pcx"]);
    expect(imageExtCandidates("tga", true, SOFT_EXTS)).toEqual(["png", "jpg", "jpeg", "bmp", "gif", "wal"]);
  });

  test("unrecognized extension (null) runs the full search with no leading as-is try", () => {
    expect(imageExtCandidates(null, false, SOFT_EXTS)).toEqual(["png", "jpg", "jpeg", "bmp", "gif", "pcx"]);
  });
});

describe("imageExtCandidates -- exact-name-first invariant", () => {
  test("the requested extension, when supported, is always candidate 0", () => {
    for (const ext of GL_EXTS) {
      for (const isWall of [false, true]) {
        expect(imageExtCandidates(ext, isWall, GL_EXTS)[0]).toBe(ext);
      }
    }
  });

  test("never produces a candidate outside the supplied supported set", () => {
    for (const ext of GL_EXTS) {
      for (const isWall of [false, true]) {
        for (const candidate of imageExtCandidates(ext, isWall, SOFT_EXTS)) {
          expect(SOFT_EXTS).toContain(candidate);
        }
      }
    }
  });

  test("never produces a duplicate extension", () => {
    for (const ext of [...GL_EXTS, null]) {
      for (const isWall of [false, true]) {
        const candidates = imageExtCandidates(ext, isWall, GL_EXTS);
        expect(new Set(candidates).size).toBe(candidates.length);
      }
    }
  });
});
