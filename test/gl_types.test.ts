/*
Self-sufficient test for the ref_gl scaffold: the QGL recording fake's call
log (the test seam described in this unit's brief), a representative
bodyless-C-declaration guard throwing with its C function name (Mod_ClearAll
-- PORTING.md's convention for a declared-but-never-defined C function,
mirrored from test/ref_types.test.ts; this is a different, permanent stub
class from the historical "PendingPort" placeholder PORTING.md also
documents, which had zero references left once its close phase ran), and
glconfig_t/glstate_t/image_t faithful defaults from gl_local.ts.
*/

import { describe, test, expect } from "bun:test";
import {
  GlconfigT,
  GlstateT,
  ImageT,
  ImagetypeT,
  RserrT,
  gl_config,
  gl_state,
  vid,
  ViddefT,
} from "../src/ref_gl/gl_local";
import { MvertexT, MedgeT, MtexinfoT, MsurfaceT, MnodeT, MleafT, ModelT, ModtypeT, GlpolyT, CONTENTS_NODE, isMleaf, Mod_ClearAll } from "../src/ref_gl/gl_model";
import { QGLRecording } from "../src/ref_gl/qgl";

describe("ref_gl/qgl.ts: QGLRecording", () => {
  test("captures an ordered call log", () => {
    const qgl = new QGLRecording();

    qgl.qglClearColor(0, 0, 0, 1);
    qgl.qglClear(0x4000);
    qgl.qglMatrixMode(0x1701);
    qgl.qglLoadIdentity();
    qgl.qglBegin(0x0004);
    qgl.qglVertex3f(1, 2, 3);
    qgl.qglEnd();

    expect(qgl.calls).toHaveLength(7);
    expect(qgl.calls.map((c) => c.name)).toEqual(["qglClearColor", "qglClear", "qglMatrixMode", "qglLoadIdentity", "qglBegin", "qglVertex3f", "qglEnd"]);
    expect(qgl.calls[0]?.args).toEqual([0, 0, 0, 1]);
    expect(qgl.calls[5]?.args).toEqual([1, 2, 3]);
  });

  test("benign return values for query functions, and clear() resets the log", () => {
    const qgl = new QGLRecording();

    expect(qgl.qglGetError()).toBe(0);
    expect(qgl.qglGetString(0x1f00)).toBeNull();
    expect(qgl.calls).toHaveLength(2);

    qgl.clear();
    expect(qgl.calls).toHaveLength(0);
  });
});

describe("ref_gl/gl_local.ts and gl_model.ts type core", () => {
  test("image_t (GL flavor) constructs with faithful defaults", () => {
    const img = new ImageT();
    expect(img.type).toBe(ImagetypeT.it_skin);
    expect(img.texnum).toBe(0);
    expect(img.scrap).toBe(false);
    expect(img.has_alpha).toBe(false);
    expect(img.paletted).toBe(false);
    expect(img.texturechain).toBeNull();
  });

  test("glconfig_t / glstate_t construct with faithful defaults", () => {
    const config = new GlconfigT();
    expect(config.renderer).toBe(0);
    expect(config.renderer_string).toBe("");
    // Bug fix (Mike, 2026-09-02, owner's play-test report: fullscreen never
    // actually engaged on a fresh boot -- "fit screen ... was not applied
    // at all"). allow_cds used to zero-init false (faithful to the C
    // original's static bool), but R_SetMode (gl_rmain.ts) reads this
    // BEFORE R_Init can ever determine the real value (needs a live GL
    // context's vendor string, which R_SetMode itself is what creates) --
    // so a false default unconditionally disabled vid_fullscreen on every
    // process's first-ever mode set, regardless of what was actually
    // requested. See gl_local.ts's GlconfigT.allow_cds doc comment for the
    // full story; this is a deliberate deviation from the faithful
    // zero-init default, not an oversight.
    expect(config.allow_cds).toBe(true);

    const state = new GlstateT();
    expect(state.inverse_intensity).toBe(0);
    expect(state.fullscreen).toBe(false);
    expect(state.currenttextures).toEqual([0, 0]);
    expect(state.originalRedGammaTable).toBeInstanceOf(Uint8Array);
    expect(state.originalRedGammaTable.length).toBe(256);

    // singletons
    expect(gl_config).toBeInstanceOf(GlconfigT);
    expect(gl_state).toBeInstanceOf(GlstateT);
    expect(vid).toBeInstanceOf(ViddefT);
    expect(RserrT.rserr_ok).toBe(0);
  });

  test("gl_model.ts structs construct with faithful defaults", () => {
    const mv = new MvertexT();
    expect(mv.position).toEqual(new Float32Array(3));

    const medge = new MedgeT();
    expect(medge.v).toEqual([0, 0]);

    const texinfo = new MtexinfoT();
    expect(texinfo.vecs).toHaveLength(2);
    expect(texinfo.vecs[0].length).toBe(4);

    const poly = new GlpolyT();
    expect(poly.numverts).toBe(0);
    expect(poly.verts).toEqual([]);

    const surf = new MsurfaceT();
    expect(surf.styles).toHaveLength(4); // MAXLIGHTMAPS
    expect(surf.light_s).toBe(0);
    expect(surf.lightmapchain).toBeNull();

    const node = new MnodeT();
    expect(node.contents).toBe(CONTENTS_NODE);
    expect(node.children).toEqual([null, null]);

    const leaf = new MleafT();
    expect(leaf.contents).toBe(0);
    expect(isMleaf(node)).toBe(false);
    expect(isMleaf(leaf)).toBe(true);

    const model = new ModelT();
    expect(model.type).toBe(ModtypeT.mod_bad);
    expect(model.skins).toHaveLength(32); // MAX_MD2SKINS
    expect(model.vis).toBeNull();
  });
});

describe("bodyless C declarations", () => {
  test("Mod_ClearAll (bodyless in the C source) fails hard with its name", () => {
    expect(() => Mod_ClearAll()).toThrow(/Mod_ClearAll/);
  });
});
