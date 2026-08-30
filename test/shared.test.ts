import { describe, expect, test } from "bun:test";
import {
  vec3,
  VectorAdd,
  VectorSubtract,
  VectorScale,
  DotProduct,
  CrossProduct,
  VectorNormalize,
  AngleVectors,
  COM_Parse,
  type ComParseState,
  BoxOnPlaneSide,
} from "../src/shared/math";
import { Com_sprintf, Info_SetValueForKey, Info_ValueForKey, CplaneT } from "../src/shared/q_shared";

describe("vector ops", () => {
  test("VectorAdd", () => {
    const out = vec3();
    VectorAdd(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([5, 7, 9]);
  });

  test("VectorSubtract", () => {
    const out = vec3();
    VectorSubtract(vec3(1, 2, 3), vec3(4, 5, 6), out);
    expect(Array.from(out)).toEqual([-3, -3, -3]);
  });

  test("VectorScale", () => {
    const out = vec3();
    VectorScale(vec3(1, 2, 3), 2, out);
    expect(Array.from(out)).toEqual([2, 4, 6]);
  });

  test("DotProduct", () => {
    expect(DotProduct(vec3(1, 2, 3), vec3(4, 5, 6))).toBe(32);
  });

  test("CrossProduct", () => {
    const out = vec3();
    CrossProduct(vec3(1, 0, 0), vec3(0, 1, 0), out);
    expect(Array.from(out)).toEqual([0, 0, 1]);
  });

  test("VectorNormalize", () => {
    const v = vec3(3, 4, 0);
    const length = VectorNormalize(v);
    expect(length).toBeCloseTo(5, 5);
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
    expect(v[2]).toBeCloseTo(0, 5);
  });
});

describe("AngleVectors", () => {
  test("zero angles: forward=+X, right=-Y, up=+Z", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    AngleVectors(vec3(0, 0, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(1, 5);
    expect(forward[1]).toBeCloseTo(0, 5);
    expect(forward[2]).toBeCloseTo(0, 5);
    expect(right[0]).toBeCloseTo(0, 5);
    expect(right[1]).toBeCloseTo(-1, 5);
    expect(right[2]).toBeCloseTo(0, 5);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[1]).toBeCloseTo(0, 5);
    expect(up[2]).toBeCloseTo(1, 5);
  });

  test("yaw=90: forward=+Y, right=+X, up=+Z", () => {
    const forward = vec3();
    const right = vec3();
    const up = vec3();
    // vec3(pitch, yaw, roll)
    AngleVectors(vec3(0, 90, 0), forward, right, up);
    expect(forward[0]).toBeCloseTo(0, 5);
    expect(forward[1]).toBeCloseTo(1, 5);
    expect(forward[2]).toBeCloseTo(0, 5);
    expect(right[0]).toBeCloseTo(1, 5);
    expect(right[1]).toBeCloseTo(0, 5);
    expect(up[2]).toBeCloseTo(1, 5);
  });
});

describe("COM_Parse", () => {
  test("tokenizes words, quoted strings, and skips // comments", () => {
    const state: ComParseState = { data: 'foo "bar baz" // a comment\nqux', index: 0 };
    expect(COM_Parse(state)).toBe("foo");
    expect(COM_Parse(state)).toBe("bar baz");
    expect(COM_Parse(state)).toBe("qux");
    expect(COM_Parse(state)).toBe("");
  });

  test("returns empty string once the data is exhausted", () => {
    const state: ComParseState = { data: "  ", index: 0 };
    expect(COM_Parse(state)).toBe("");
    expect(COM_Parse(state)).toBe("");
  });
});

describe("Com_sprintf", () => {
  test("supports %s %d %5.2f %c %%", () => {
    const result = Com_sprintf("%s-%d-%5.2f-%c-%%", "hi", 42, 3.14159, 65);
    expect(result).toBe("hi-42- 3.14-A-%");
  });
});

describe("Info_SetValueForKey / Info_ValueForKey", () => {
  test("round-trips a key/value pair", () => {
    let info = "";
    info = Info_SetValueForKey(info, "name", "quake");
    info = Info_SetValueForKey(info, "map", "base1");

    expect(Info_ValueForKey(info, "name")).toBe("quake");
    expect(Info_ValueForKey(info, "map")).toBe("base1");
    expect(Info_ValueForKey(info, "nonexistent")).toBe("");
  });
});

describe("BoxOnPlaneSide", () => {
  test("axial plane: box entirely in front, entirely behind, and straddling", () => {
    const plane = new CplaneT();
    plane.normal[0] = 1;
    plane.normal[1] = 0;
    plane.normal[2] = 0;
    plane.dist = 5;
    plane.type = 0; // axial on X

    // entirely behind the plane (dist >= emaxs[X]) -> side 2
    expect(BoxOnPlaneSide(vec3(-10, -10, -10), vec3(0, 0, 0), plane)).toBe(2);

    // entirely in front of the plane (dist <= emins[X]) -> side 1
    expect(BoxOnPlaneSide(vec3(10, -10, -10), vec3(20, 10, 10), plane)).toBe(1);

    // straddles the plane
    expect(BoxOnPlaneSide(vec3(0, -10, -10), vec3(10, 10, 10), plane)).toBe(3);
  });
});
