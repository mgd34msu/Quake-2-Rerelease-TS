/*
Tests for world-space text (info_world_text) end to end within this
process: sv_debugdraw.ts's buffer -> sv_main.ts's per-frame drain ->
cl_worldtext.ts's client snapshot -> the refdef -> gl_worldtext.ts's
world-space basis math.

There is deliberately no wire message to round-trip here. q2repro's
PF_Draw_*WorldText call the client's R_AddDebugText directly under
`#if USE_REF` (src/server/game.c:834-889); protocol.h's svc_ops_t and
q2proto's Q2P_SVC_* both have no debug/text member, so the re-release
transmits none of this over the network. The "round trip" that exists to
test is therefore the in-process one, and that is what this covers --
see cl_worldtext.ts's header for the full finding.

Self-sufficient per rule 13: every test clears the buffer and the client
snapshot it touches.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, VectorCopy, AngleVectors, DotProduct } from "../src/shared/math";
import {
  SV_DebugDraw_OrientedWorldText,
  SV_DebugDraw_StaticWorldText,
  SV_DebugDraw_Line,
  SV_DebugDraw_Drain,
  SV_DebugDraw_Tick,
  SV_DebugDraw_Clear,
} from "../src/server/sv_debugdraw";
import { CL_ClearWorldText, CL_SetWorldText, CL_WorldTexts, makeWorldText, MAX_WORLD_TEXTS } from "../src/client/cl_worldtext";
import { WorldTextT } from "../src/client/ref";
import { worldTextBasis, worldTextCulled, worldTextLineStart } from "../src/ref_gl/gl_worldtext";

const WHITE = { r: 255, g: 255, b: 255, a: 255 };

// The glue in sv_main.ts's SV_DeliverWorldText, reproduced here so the
// mapping is exercised without pulling the whole server frame in.
function deliver(): void {
  const texts: WorldTextT[] = [];
  for (const entry of SV_DebugDraw_Drain()) {
    const shape = entry.shape;
    const color = new Uint8Array([entry.color.r, entry.color.g, entry.color.b, entry.color.a]);
    if (shape.kind === "orientedWorldText") texts.push(makeWorldText(shape.origin, null, shape.text, shape.size, color, entry.depthTest));
    else if (shape.kind === "staticWorldText") texts.push(makeWorldText(shape.origin, shape.angles, shape.text, shape.size, color, entry.depthTest));
  }
  CL_SetWorldText(texts);
}

describe("world text -- server buffer to client snapshot", () => {
  beforeEach(() => {
    SV_DebugDraw_Clear();
    CL_ClearWorldText();
  });

  test("an oriented (angle-less) draw becomes a billboarded entry", () => {
    // sv_debugdraw.ts's "orientedWorldText" is the shape with NO angles --
    // it mirrors PF_Draw_OrientedWorldText passing NULL to R_AddDebugText
    // (q2repro game.c:857-860), which is what makes it face the viewer.
    SV_DebugDraw_OrientedWorldText(vec3(10, 20, 30), "hello", { r: 116, g: 61, b: 50, a: 255 }, 0.2, 0.1, true);
    deliver();

    const texts = CL_WorldTexts();
    expect(texts.length).toBe(1);
    const t = texts[0];
    expect(t.oriented).toBe(false); // false == billboard toward the view
    expect(t.text).toBe("hello");
    expect(Array.from(t.origin)).toEqual([10, 20, 30]);
    // debug.c:376's `t->size = size * 8.0f`. info_world_text's default
    // radius of 0.2 therefore means a 1.6-unit character cell.
    expect(t.size).toBeCloseTo(1.6, 6);
    expect(Array.from(t.color)).toEqual([116, 61, 50, 255]);
    expect(t.depthTest).toBe(true);
  });

  test("a static (angled) draw carries its angles through", () => {
    SV_DebugDraw_StaticWorldText(vec3(1, 2, 3), vec3(0, 270, 0), "wall", WHITE, 0.5, 0.1, false);
    deliver();

    const t = CL_WorldTexts()[0];
    expect(t.oriented).toBe(true);
    expect(Array.from(t.angles)).toEqual([0, 270, 0]);
    expect(t.size).toBeCloseTo(4, 6);
    expect(t.depthTest).toBe(false);
  });

  test("non-text debug shapes are ignored and stay buffered", () => {
    SV_DebugDraw_Line(vec3(0, 0, 0), vec3(1, 1, 1), WHITE, 5, true);
    SV_DebugDraw_OrientedWorldText(vec3(), "only me", WHITE, 1, 5, true);
    deliver();

    expect(CL_WorldTexts().length).toBe(1);
    expect(CL_WorldTexts()[0].text).toBe("only me");
    // The line is still in the buffer -- nothing draws it yet, and
    // discarding it here would lose it silently.
    const remaining = SV_DebugDraw_Drain();
    expect(remaining.some((e) => e.shape.kind === "line")).toBe(true);
  });

  test("the snapshot is replaced wholesale, so a text that stops being emitted disappears", () => {
    // info_world_text re-emits every server frame with a one-frame-ish
    // lifetime, so "stopped emitting" has to mean "gone next frame".
    SV_DebugDraw_OrientedWorldText(vec3(), "frame one", WHITE, 1, 0, true);
    deliver();
    expect(CL_WorldTexts().length).toBe(1);

    // Next server frame: nothing emitted. The one-shot was already removed
    // by the previous drain.
    deliver();
    expect(CL_WorldTexts().length).toBe(0);
  });

  test("a timed entry survives until SV_DebugDraw_Tick expires it", () => {
    SV_DebugDraw_OrientedWorldText(vec3(), "sticky", WHITE, 1, 0.3, true);
    deliver();
    expect(CL_WorldTexts().length).toBe(1);

    SV_DebugDraw_Tick(100);
    deliver();
    expect(CL_WorldTexts().length).toBe(1);

    SV_DebugDraw_Tick(250); // past the 300ms lifetime
    deliver();
    expect(CL_WorldTexts().length).toBe(0);
  });

  test("CL_ClearWorldText drops the snapshot for a new map", () => {
    SV_DebugDraw_OrientedWorldText(vec3(), "stale", WHITE, 1, 5, true);
    deliver();
    CL_ClearWorldText();
    expect(CL_WorldTexts().length).toBe(0);
  });

  test("text is truncated to the C struct's 127 usable characters", () => {
    const long = "x".repeat(400);
    const t = makeWorldText(vec3(), null, long, 1, new Uint8Array([1, 2, 3, 4]), true);
    expect(t.text.length).toBe(127);
  });

  test("the snapshot is capped at MAX_WORLD_TEXTS", () => {
    const many: WorldTextT[] = [];
    for (let i = 0; i < MAX_WORLD_TEXTS + 25; i++) many.push(makeWorldText(vec3(), null, `t${i}`, 1, new Uint8Array(4), true));
    CL_SetWorldText(many);
    expect(CL_WorldTexts().length).toBe(MAX_WORLD_TEXTS);
  });

  test("the snapshot is copied, not aliased to the caller's objects", () => {
    const src = makeWorldText(vec3(1, 2, 3), null, "copy me", 1, new Uint8Array([9, 9, 9, 9]), true);
    CL_SetWorldText([src]);
    src.origin[0] = 999;
    src.text = "mutated";
    expect(CL_WorldTexts()[0].origin[0]).toBe(1);
    expect(CL_WorldTexts()[0].text).toBe("copy me");
  });
});

describe("gl_worldtext.ts -- world-space basis (q2repro debug.c:585-621)", () => {
  test("a billboard steps along the view right and down the view up", () => {
    const viewRight = vec3(0, 1, 0);
    const viewUp = vec3(0, 0, 1);
    const { right, down } = worldTextBasis({ oriented: false, angles: vec3(), size: 4 }, viewRight, viewUp);
    expect(Array.from(right)).toEqual([0, 4, 0]);
    // "down" is the NEGATED up vector -- glyph rows advance downward.
    expect(Array.from(down)).toEqual([-0, -0, -4]);
  });

  test("an angled text uses AngleVectors' own right, and up negated", () => {
    const angles = vec3(0, 90, 0);
    const { right, down } = worldTextBasis({ oriented: true, angles, size: 2 }, vec3(1, 0, 0), vec3(0, 0, 1));

    const f = vec3();
    const r = vec3();
    const u = vec3();
    AngleVectors(angles, f, r, u);
    for (let i = 0; i < 3; i++) {
      expect(right[i]).toBeCloseTo(r[i] * 2, 5);
      expect(down[i]).toBeCloseTo(-u[i] * 2, 5);
    }
    // The basis ignores the view entirely for this case -- that is what
    // makes an angled text stay put as the player walks around it.
    const other = worldTextBasis({ oriented: true, angles, size: 2 }, vec3(0, -1, 0), vec3(0, 0, -1));
    expect(Array.from(other.right)).toEqual(Array.from(right));
  });

  test("the distance cull is debug.c:610's size-vs-axial-distance test", () => {
    const vieworg = vec3(0, 0, 0);
    const forward = vec3(1, 0, 0);
    const distfrac = 0.004;

    // A 1.6-unit cell survives out to 1.6/0.004 = 400 units along the view.
    expect(worldTextCulled(vec3(399, 0, 0), 1.6, vieworg, forward, distfrac)).toBe(false);
    expect(worldTextCulled(vec3(401, 0, 0), 1.6, vieworg, forward, distfrac)).toBe(true);
    // Bigger text survives proportionally further.
    expect(worldTextCulled(vec3(401, 0, 0), 8, vieworg, forward, distfrac)).toBe(false);
    // Behind the eye the axial distance is negative, so this test never
    // culls it (q2repro leaves that to the frustum check).
    expect(worldTextCulled(vec3(-5000, 0, 0), 1.6, vieworg, forward, distfrac)).toBe(false);
    // Only the component ALONG the view axis counts.
    const sideways = vec3(0, 5000, 0);
    expect(worldTextCulled(sideways, 1.6, vieworg, forward, distfrac)).toBe(false);
    expect(DotProduct(sideways, forward)).toBe(0);
  });

  test("a line is centred on the origin, not started at it (debug.c:592)", () => {
    const origin = vec3(100, 0, 0);
    const right = vec3(0, 2, 0); // 2 units per character
    const out = vec3();
    worldTextLineStart(origin, right, 5, out);
    // 5 characters * 2 units = 10 wide, so it starts 5 units left of centre.
    expect(Array.from(out)).toEqual([100, -5, 0]);

    // A single character starts half a cell before the origin.
    worldTextLineStart(origin, right, 1, out);
    expect(Array.from(out)).toEqual([100, -1, 0]);
  });

  test("the basis and the line start compose into the expected quad corners", () => {
    // One character, cell size 2, billboarded with right=+Y and down=-Z:
    // the glyph's top-left corner sits half a cell left of the origin and
    // its bottom-right one half a cell right and one cell down.
    const { right, down } = worldTextBasis({ oriented: false, angles: vec3(), size: 2 }, vec3(0, 1, 0), vec3(0, 0, 1));
    const start = vec3();
    worldTextLineStart(vec3(0, 0, 0), right, 1, start);
    const bottomRight = vec3();
    VectorCopy(start, bottomRight);
    for (let i = 0; i < 3; i++) bottomRight[i] += right[i] + down[i];
    expect(Array.from(start)).toEqual([0, -1, 0]);
    expect(Array.from(bottomRight)).toEqual([0, 1, -2]);
  });
});
