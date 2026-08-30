import { describe, expect, test } from "bun:test";
import { fixedLength } from "../src/shared/fixed";

describe("fixedLength", () => {
  test("returns the value unchanged when the length matches", () => {
    const arr = [1, 2, 3];
    expect(fixedLength("arr", 3, arr)).toBe(arr);
  });

  test("throws with the table name, actual, and expected length on mismatch", () => {
    expect(() => fixedLength("arr", 4, [1, 2, 3])).toThrow("arr: 3 elements, expected 4");
  });

  test("works on typed arrays, not just plain arrays", () => {
    const bytes = new Uint8Array(1024);
    expect(fixedLength("bytes", 1024, bytes)).toBe(bytes);
    expect(() => fixedLength("bytes", 960, bytes)).toThrow("bytes: 1024 elements, expected 960");
  });

  test("zero-length values pass when 0 is expected and throw otherwise", () => {
    expect(fixedLength("empty", 0, [])).toEqual([]);
    expect(() => fixedLength("empty", 1, [])).toThrow("empty: 0 elements, expected 1");
  });
});

// Importing a sample of the modules hardened with fixedLength() must not
// throw: every guarded table in the current codebase is expected to carry
// its correct C-declared row count, so module load should succeed exactly
// as it did before hardening. A regression here means either a genuine table
// length slipped, or a fixedLength() call was given the wrong expected N.
describe("hardened modules import cleanly with current table data", () => {
  test("src/qcommon/anorms.ts (bytedirs, 162 rows)", async () => {
    const mod = await import("../src/qcommon/anorms");
    expect(mod).toBeDefined();
  });

  test("src/qcommon/crc.ts (crctable, 256 rows)", async () => {
    const mod = await import("../src/qcommon/crc");
    expect(mod).toBeDefined();
  });

  test("src/game/g_local.ts (MmoveT frame-count invariant, ~200 monster tables)", async () => {
    const mod = await import("../src/game/g_local");
    expect(mod).toBeDefined();
  });

  test("src/game/m_actor.ts (actor_names, monster frame tables incl. two documented C bugs)", async () => {
    const mod = await import("../src/game/m_actor");
    expect(mod).toBeDefined();
  });

  test("src/ref_gl/gl_mesh.ts (r_avertexnormal_dots, the exact 16x256 table from the motivating crash)", async () => {
    const mod = await import("../src/ref_gl/gl_mesh");
    expect(mod).toBeDefined();
  });
});
