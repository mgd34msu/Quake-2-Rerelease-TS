/*
Self-sufficient test for the ref_gl scaffold: the QGL recording fake's call
log (the test seam described in this unit's brief), a representative
PendingPort stub throwing with its C function name (PORTING.md's "Pending
stubs" convention, mirrored from test/ref_types.test.ts), and glconfig_t/
glstate_t/image_t faithful defaults from gl_local.ts.
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
    expect(config.allow_cds).toBe(false);

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
