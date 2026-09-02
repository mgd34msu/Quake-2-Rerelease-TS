/*
RF_FLARE (misc_flare) end to end: the client half in src/client/cl_ents.ts's
CL_AddPacketEntities (ported from q2repro src/client/entities.c:710-736) and
the renderer half in src/ref_gl/gl_rmain.ts's R_DrawFlare (q2repro
src/refresh/tess.c:366-489, GL_DrawFlares).

kexgame/g_misc.ts's SP_misc_flare is what puts these on the wire: renderfx
RF_FLARE (+ RF_FLARE_LOCK_ANGLE / RF_SHELL_* / RF_CUSTOMSKIN), s.scale from
the `radius` key, s.modelindex2/s.modelindex3 from `fade_start_dist` /
`fade_end_dist` (defaults 96 / 384), and s.skinnum as a packed big-endian
tint. The retail campaign uses them heavily -- maps/mgu2m3.bsp has 53
misc_flare entities, maps/mguhub.bsp 36, maps/q64/core.bsp 32.

Self-sufficient per PORTING.md rule 13: cl.clear()/cls.clear(), the cvar,
the QGL recording and the view axes are all set in beforeEach.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { RF_FLARE, RF_FLARE_LOCK_ANGLE, RF_CUSTOMSKIN, RF_TRANSLUCENT, RF_SHELL_RED, RF_SHELL_BLUE, RF_MINLIGHT } from "../src/shared/q_shared";
import { CS_REMAP_RERELEASE, CS_REMAP_OLD } from "../src/shared/cs_remap";
import { vec3 } from "../src/shared/math";
import { cl, cls, ConnstateT, clCvars, cl_entities, cl_parse_entities, setRe } from "../src/client/client";
import { CL_AddEntities } from "../src/client/cl_ents";
import { EntityT } from "../src/client/ref";
import { V_ClearScene, r_entities, r_numentities } from "../src/client/cl_view";
import { CL_ClearEffects } from "../src/client/cl_fx";
import { CL_ClearTEnts } from "../src/client/cl_tent";
import { Cvar_Get, Cvar_Set } from "../src/qcommon/cvar";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL } from "../src/ref_gl/gl_image";
import { ImageT, vup, vright, r_newrefdef } from "../src/ref_gl/gl_local";
import { R_DrawFlare } from "../src/ref_gl/gl_rmain";

const FLARE_NUMBER = 92;

interface FlareFields {
  renderfx?: number;
  scale?: number;
  skinnum?: number;
  frame?: number;
  fadeStart?: number;
  fadeEnd?: number;
  origin?: [number, number, number];
}

function seatFlare(f: FlareFields = {}): void {
  const s = cl_parse_entities[0];
  s.number = FLARE_NUMBER;
  s.modelindex = 1; // SP_misc_flare's own value: index 1 is the world model
  s.renderfx = f.renderfx ?? RF_FLARE;
  s.skinnum = f.skinnum ?? 0;
  s.frame = f.frame ?? 0;
  s.effects = 0;
  s.scale = f.scale ?? 0;
  s.modelindex2 = f.fadeStart ?? 96; // st.fade_start_dist default
  s.modelindex3 = f.fadeEnd ?? 384; // st.fade_end_dist default
  const org = f.origin ?? [200, 0, 0];
  s.origin[0] = org[0];
  s.origin[1] = org[1];
  s.origin[2] = org[2];

  const cent = cl_entities[FLARE_NUMBER];
  cent.current = s;
  cent.prev = s;
  cent.serverframe = 1;

  cl.frame.valid = true;
  cl.frame.serverframe = 1;
  cl.frame.servertime = 100;
  cl.frame.num_entities = 1;
  cl.frame.parse_entities = 0;
  cl.time = 100;
}

function addedFlare(): EntityT | undefined {
  return r_entities.slice(0, r_numentities).find((e) => e.flags & RF_FLARE);
}

// distance from the view origin CL_CalcViewValues just computed
function viewDistanceTo(e: EntityT): number {
  const dx = cl.refdef.vieworg[0] - e.origin[0];
  const dy = cl.refdef.vieworg[1] - e.origin[1];
  const dz = cl.refdef.vieworg[2] - e.origin[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

beforeEach(() => {
  cl.clear();
  cls.clear();
  setRe(null);
  clCvars.cl_showclamp = null;
  clCvars.cl_timedemo = null;
  clCvars.cl_predict = null;
  clCvars.cl_gun = null;
  clCvars.cl_vwep = null;
  cls.state = ConnstateT.ca_active;
  cls.csr = CS_REMAP_RERELEASE;
  Cvar_Get("cl_flares", "1", 0);
  Cvar_Set("cl_flares", "1");
  // CL_AddEntities also runs CL_AddTEnts/CL_AddDLights, which re-emit any
  // still-live pooled explosion or dlight left behind by an earlier suite;
  // these are the product's own resets for that (rule 13 -- no ordering
  // dependency).
  CL_ClearEffects();
  CL_ClearTEnts();
  V_ClearScene();
});

describe("CL_AddPacketEntities -- RF_FLARE distance fade", () => {
  test("closer than fade_start_dist: the flare is not drawn at all", () => {
    seatFlare({ fadeStart: 96, fadeEnd: 384, origin: [40, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()).toBeUndefined();
  });

  test("between the two distances: alpha ramps linearly from 0 to 1", () => {
    // 240 units out with the retail defaults 96/384 is halfway up the ramp
    seatFlare({ fadeStart: 96, fadeEnd: 384, origin: [240, 0, 0] });

    CL_AddEntities();

    const e = addedFlare();
    expect(e).toBeDefined();
    if (!e) return;
    const d = viewDistanceTo(e);
    expect(d).toBeCloseTo(240, 3); // a cleared client views from the origin
    expect(e.alpha).toBeCloseTo((d - 96) / (384 - 96), 6);
    expect(e.alpha).toBeCloseTo(0.5, 6);
  });

  test("past fade_end_dist: alpha saturates at 1 (flares fade IN with distance)", () => {
    seatFlare({ fadeStart: 96, fadeEnd: 384, origin: [4000, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()?.alpha).toBe(1);
  });

  test("exactly at fade_start_dist the flare appears, with alpha 0", () => {
    seatFlare({ fadeStart: 96, fadeEnd: 384, origin: [96, 0, 0] });

    CL_AddEntities();

    const e = addedFlare();
    expect(e).toBeDefined();
    expect(e?.alpha).toBe(0);
  });

  test("cl_flares 0 consumes the flare without drawing it", () => {
    Cvar_Set("cl_flares", "0");
    seatFlare({ origin: [240, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()).toBeUndefined();
    // and it must never reach the renderer as the world model it claims
    expect(r_numentities).toBe(0);
  });

  test("a legacy (non-extended) protocol family never takes the branch", () => {
    cls.csr = CS_REMAP_OLD;
    const world = { world: true };
    cl.model_draw[1] = world;
    seatFlare({ origin: [240, 0, 0] });

    CL_AddEntities();

    // under a legacy protocol the RF_FLARE bit carries no meaning, so the
    // entity keeps vanilla's plain model lookup: modelindex 1, no flare
    // alpha/scale/tint, no RF_TRANSLUCENT
    const e = r_entities.slice(0, r_numentities).find((x) => x.model === world);
    expect(e).toBeDefined();
    expect((e?.flags ?? 0) & RF_TRANSLUCENT).toBe(0);
    expect(Array.from(e?.scale ?? [])).toEqual([0, 0, 0]);
    expect(e?.alpha).toBe(0);
  });

  test("a WIDENED CLASSIC session takes the flare branch: the gate is the wire's capability, not the game module", () => {
    // A classic-ruleset session on rerelease content that outgrew the classic
    // configstring limits (sv_init.ts's SV_WidenConfigstringSpace) reconnects
    // on PROTOCOL_VERSION_RERELEASE_CLASSIC: the WIDE layout (so
    // cls.csr.extended is true and RF_FLARE means what it says on the wire)
    // with cls.gameFamily still "classic" (so the monster-flash table and the
    // HUD stay classic -- see client.ts's cls.gameFamily doc comment).
    //
    // This branch must follow the layout, not the family. Rerelease flares set
    // s.modelindex = 1; without the flare branch that resolves to the WORLD
    // model and gets handed to the renderer, which is the documented trap this
    // whole code path exists to avoid.
    cls.csr = CS_REMAP_RERELEASE;
    cls.gameFamily = "classic";
    const world = { world: true };
    cl.model_draw[1] = world;
    seatFlare({ origin: [4000, 0, 0] });

    CL_AddEntities();

    // The world model was NOT drawn for this entity...
    expect(r_entities.slice(0, r_numentities).find((x) => x.model === world)).toBeUndefined();
    // ...it took the flare path instead: no model, translucent, alpha set.
    const flare = r_entities.slice(0, r_numentities).find((x) => (x.flags & RF_FLARE) !== 0);
    expect(flare).toBeDefined();
    expect((flare?.flags ?? 0) & RF_TRANSLUCENT).toBe(RF_TRANSLUCENT);
    expect(flare?.alpha).toBe(1);
  });
});

describe("CL_AddPacketEntities -- RF_FLARE field threading onto EntityT", () => {
  test("s.scale 0 means 1, and lands on all three scale axes", () => {
    seatFlare({ scale: 0, origin: [4000, 0, 0] });

    CL_AddEntities();

    const e = addedFlare();
    expect(Array.from(e?.scale ?? [])).toEqual([1, 1, 1]);
  });

  test("a non-zero s.scale is passed through verbatim", () => {
    seatFlare({ scale: 2.5, origin: [4000, 0, 0] });

    CL_AddEntities();

    const e = addedFlare();
    expect(e?.scale[0]).toBeCloseTo(2.5, 6);
    expect(e?.scale[1]).toBeCloseTo(2.5, 6);
    expect(e?.scale[2]).toBeCloseTo(2.5, 6);
  });

  test("skinnum 0 is COLOR_WHITE", () => {
    seatFlare({ skinnum: 0, origin: [4000, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()?.rgba).toEqual({ r: 255, g: 255, b: 255, a: 255 });
  });

  test("a packed skinnum unpacks big-endian into rgba", () => {
    // 0xE0 80 20 FF -> r 224, g 128, b 32, a 255
    seatFlare({ skinnum: 0xe08020ff | 0, origin: [4000, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()?.rgba).toEqual({ r: 0xe0, g: 0x80, b: 0x20, a: 0xff });
  });

  test("flags carry the entity's renderfx plus RF_TRANSLUCENT, and skinnum becomes the entity number", () => {
    seatFlare({ renderfx: RF_FLARE | RF_FLARE_LOCK_ANGLE | RF_SHELL_RED, origin: [4000, 0, 0] });

    CL_AddEntities();

    const e = addedFlare();
    expect(e?.flags).toBe(RF_FLARE | RF_FLARE_LOCK_ANGLE | RF_SHELL_RED | RF_TRANSLUCENT);
    expect(e?.skinnum).toBe(FLARE_NUMBER);
    expect(e?.model).toBeNull(); // never the world model s.modelindex 1 names
  });

  test("RF_CUSTOMSKIN takes the image_precache entry s.frame indexes", () => {
    const custom = { customFlareImage: true };
    cl.image_precache[7] = custom;
    seatFlare({ renderfx: RF_FLARE | RF_CUSTOMSKIN, frame: 7, origin: [4000, 0, 0] });

    CL_AddEntities();

    expect(addedFlare()?.skin).toBe(custom);
  });

  test("an out-of-range RF_CUSTOMSKIN index falls back to the default flare image handle", () => {
    seatFlare({ renderfx: RF_FLARE | RF_CUSTOMSKIN, frame: cls.csr.max_images + 5, origin: [4000, 0, 0] });

    CL_AddEntities();

    // cl_img_flare is null with no renderer registered, which is exactly the
    // "no image" state R_DrawFlare early-outs on
    expect(addedFlare()?.skin).toBeNull();
  });
});

/*
Renderer half. R_DrawFlare is driven through QGLRecording, so these assert
the exact immediate-mode call stream the flare quad emits.
*/
function makeFlareEntity(over: Partial<EntityT> = {}): EntityT {
  const e = new EntityT();
  e.flags = RF_FLARE | RF_TRANSLUCENT;
  e.alpha = 1;
  e.origin = vec3(0, 0, 0);
  e.scale = vec3(1, 1, 1);
  e.rgba = { r: 255, g: 255, b: 255, a: 255 };
  const img = new ImageT();
  img.name = "misc/flare.tga";
  img.texnum = 1234;
  e.skin = img;
  Object.assign(e, over);
  return e;
}

function verticesOf(rec: QGLRecording): number[][] {
  return rec.calls.filter((c) => c.name === "qglVertex3fv" || c.name === "qglVertex3f").map((c) => (c.name === "qglVertex3f" ? (c.args as number[]) : Array.from(c.args[0] as Float32Array)));
}

function colorsOf(rec: QGLRecording): number[][] {
  return rec.calls.filter((c) => c.name === "qglColor4f").map((c) => c.args as number[]);
}

describe("ref_gl R_DrawFlare", () => {
  beforeEach(() => {
    SetQGL(new QGLRecording());
    vup.set([0, 0, 1]);
    vright.set([0, 1, 0]);
    r_newrefdef.vieworg.set([0, -100, 0]);
  });

  test("no image handle draws nothing", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity({ skin: null });

    R_DrawFlare(e);

    expect(rec.calls.length).toBe(0);
  });

  test("LOCK_ANGLE builds the quad from the view axes, sized (25 << default_flare) * scale", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    // misc/flare.tga is q2repro's IF_DEFAULT_FLARE image, so 25 << 1 == 50
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE });

    R_DrawFlare(e);

    const verts = verticesOf(rec);
    // fan: center, then up+left, up+right, down+right, down+left, up+left
    expect(verts.length).toBe(6);
    expect(verts[0]).toEqual([0, 0, 0]);
    // left is -vright (q2repro's viewaxis[1]); up is +vup
    expect(verts[1]).toEqual([0, -50, 50]);
    expect(verts[2]).toEqual([0, 50, 50]);
    expect(verts[3]).toEqual([0, 50, -50]);
    expect(verts[4]).toEqual([0, -50, -50]);
    expect(verts[5]).toEqual([0, -50, 50]); // fan closes back on its first rim vertex
  });

  test("entity scale multiplies the quad size", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE, scale: vec3(3, 3, 3) });

    R_DrawFlare(e);

    const verts = verticesOf(rec);
    expect(verts[1]).toEqual([0, -150, 150]); // 50 * 3
  });

  test("a non-default flare image halves the size (25 << 0)", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const img = new ImageT();
    img.name = "sprites/flare_01.tga"; // a misc_flare `image` key, not the built-in
    img.texnum = 9;
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE, skin: img });

    R_DrawFlare(e);

    expect(verticesOf(rec)[1]).toEqual([0, -25, 25]);
  });

  test("without LOCK_ANGLE the quad is built around the direction to the viewer, still facing it", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity(); // no RF_FLARE_LOCK_ANGLE
    // view is at (0,-100,0), flare at the origin: dir is +y
    R_DrawFlare(e);

    const verts = verticesOf(rec);
    expect(verts.length).toBe(6);
    for (const v of verts.slice(1)) {
      // every rim vertex sits in the plane perpendicular to the view
      // direction (y = 0) at the quad's half-diagonal from the center
      expect(v[1]).toBeCloseTo(0, 5);
      expect(Math.hypot(v[0], v[2])).toBeCloseTo(Math.hypot(50, 50), 4);
    }
  });

  test("alpha follows (128 + 32 * default_flare) * ent.alpha, folded into rgb and alpha both", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE, alpha: 0.5 });

    R_DrawFlare(e);

    const a = ((128 + 32) * 0.5) / 255;
    for (const c of colorsOf(rec).slice(0, 6)) {
      expect(c[3]).toBeCloseTo(a, 6);
      expect(c[0]).toBeCloseTo(a, 6); // white tint premultiplied
    }
  });

  test("the entity tint modulates the inner vertex color", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE, rgba: { r: 255, g: 0, b: 0, a: 255 } });

    R_DrawFlare(e);

    const a = 160 / 255;
    const inner = colorsOf(rec)[0];
    expect(inner[0]).toBeCloseTo(a, 6);
    expect(inner[1]).toBeCloseTo(0, 6);
    expect(inner[2]).toBeCloseTo(0, 6);
  });

  test("a shell color drives the rim vertices to the pure shell channel", () => {
    const rec = new QGLRecording();
    SetQGL(rec);
    const e = makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE | RF_SHELL_BLUE });

    R_DrawFlare(e);

    const a = 160 / 255;
    const cols = colorsOf(rec);
    expect(cols[0][0]).toBeCloseTo(a, 6); // inner stays the entity tint (white)
    expect(cols[1]).toEqual([0, 0, a, a]); // rim is pure blue
  });

  test("draws additively, with the alpha test off and the previous blend/tex state restored", () => {
    const rec = new QGLRecording();
    SetQGL(rec);

    R_DrawFlare(makeFlareEntity({ flags: RF_FLARE | RF_TRANSLUCENT | RF_FLARE_LOCK_ANGLE }));

    const names = rec.calls.map((c) => c.name);
    const blends = rec.calls.filter((c) => c.name === "qglBlendFunc").map((c) => c.args as number[]);
    expect(blends[0]).toEqual([0x0302, 1]); // GL_SRC_ALPHA, GL_ONE
    expect(blends[1]).toEqual([0x0302, 0x0303]); // restored to GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA
    expect(names).toContain("qglBegin");
    expect(names).toContain("qglEnd");
    // never touches the depth mask: the translucent entity pass owns it
    expect(names).not.toContain("qglDepthMask");
    // the alpha test is turned off and LEFT off (GL_GREATER 0.666 would
    // otherwise discard R_DrawAlphaSurfaces' 0.33/0.66 world surfaces later
    // in the frame) -- same as R_DrawSpriteModel
    const alphaTest = rec.calls.filter((c) => c.name === "qglDisable" || c.name === "qglEnable").filter((c) => (c.args as number[])[0] === 0x0bc0);
    expect(alphaTest.map((c) => c.name)).toEqual(["qglDisable", "qglDisable"]);
  });

  test("RF_FLARE_LOCK_ANGLE is RF_MINLIGHT, the bit SPAWNFLAG_FLARE_LOCK_ANGLE sets", () => {
    expect(RF_FLARE_LOCK_ANGLE).toBe(RF_MINLIGHT);
  });
});
