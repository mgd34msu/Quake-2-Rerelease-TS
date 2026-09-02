/*
Self-sufficient suite for the emissive glow-map path (rule 13: this file sets
up its own fake RefImports/QGL/gltextures state in beforeEach and depends on
nothing another file has run).

Covers the three pieces the feature is made of:
  - gl_image.ts's GL_CheckForGlowMap: finding "<name>_glow.<ext>" next to a
    skin or wall texture, the r_glowmaps gate, the it_skin premultiply and
    the it_wall diffuse*alpha bake, and the MD5 case (a skin already resolved
    under an "md5/" subdirectory finds its sibling glow there).
  - gl_rsurf.ts's R_DrawGlowmaps: the additive pass's GL state, the
    gl_glowmap_intensity value reaching the constant colour, and the
    suppression/drain rules.
  - gl_model.ts's split MD5 skin array: R_RegisterModel re-resolves the MD2
    skin names on every registration, and must no longer clobber the MD5
    skins that Mod_LoadMD5 resolved (the defect that made MD5 meshes draw
    their md5/ texture coordinates against the MD2's differently-laid-out,
    lower-resolution skin).

GL_InitImages is called in beforeEach with intensity and vid_gamma pinned to
1 so intensitytable/gammatable are both identity. Those two LUTs are
module-private in gl_image.ts and are applied to every 32-bit upload by
GL_LightScaleTexture; without pinning them the uploaded bytes asserted below
would depend on whatever another suite left in the shared cvar state, and an
un-initialised (all-zero) table would make every assertion pass vacuously.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { deflateSync } from "node:zlib";

import { glCvars, SetRefImports, gltextures, ImageT, ImagetypeT, SetNumGltextures, gl_state } from "../src/ref_gl/gl_local";
import type { RefImports } from "../src/client/ref";
import { CvarT } from "../src/shared/q_shared";
import { QGLRecording } from "../src/ref_gl/qgl";
import { SetQGL, GL_FindImage, GL_InitImages, GL_CheckForGlowMap, ResetScrapState, GL_TEXTURE_2D } from "../src/ref_gl/gl_image";
import { R_DrawGlowmaps } from "../src/ref_gl/gl_rsurf";
import { MsurfaceT, GlpolyT, MtexinfoT, R_RegisterModel, IDALIASHEADER, ALIAS_VERSION } from "../src/ref_gl/gl_model";
import { Md5ModelT } from "../src/qcommon/md5_model";

let files: Map<string, Uint8Array>;
let cvars: Map<string, CvarT>;
let qgl: QGLRecording;

function fakeCvarGet(name: string, value: string): CvarT {
  const existing = cvars.get(name);
  if (existing) return existing;
  const c = new CvarT();
  c.name = name;
  c.string = value;
  c.value = parseFloat(value) || 0;
  cvars.set(name, c);
  return c;
}

function makeFakeRi(): RefImports {
  return {
    Sys_Error(errLevel: number, str: string): never {
      throw new Error(`Sys_Error(${errLevel}): ${str}`);
    },
    Cmd_AddCommand: () => {},
    Cmd_RemoveCommand: () => {},
    Cmd_Argc: () => 0,
    Cmd_Argv: () => "",
    Cmd_ExecuteText: () => {},
    Con_Printf: () => {},
    FS_LoadFile: (name: string) => {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile: () => {},
    FS_Gamedir: () => "",
    Cvar_Get: (name: string, value: string) => fakeCvarGet(name, value),
    Cvar_Set: (name: string, value: string) => {
      const c = fakeCvarGet(name, value);
      c.string = value;
      c.value = parseFloat(value) || 0;
      return c;
    },
    Cvar_SetValue: (name: string, value: number) => {
      const c = fakeCvarGet(name, String(value));
      c.string = String(value);
      c.value = value;
    },
    Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
    Vid_MenuInit: () => {},
    Vid_NewWindow: () => {},
  };
}

// --- minimal fixture builders (this suite decodes nothing it did not write) --

function crc32(buf: Uint8Array): number {
  let table: number[] | null = null;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of buf) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// 8-bit RGBA PNG, row 0 = top scanline.
function buildPngRgba(width: number, height: number, pixelFn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[row + 1 + x * 4 + 0] = r;
      raw[row + 1 + x * 4 + 1] = g;
      raw[row + 1 + x * 4 + 2] = b;
      raw[row + 1 + x * 4 + 3] = a;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", new Uint8Array(deflateSync(raw))), pngChunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function rleEncodeRow(row: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    const val = row[i];
    let run = 1;
    while (i + run < row.length && row[i + run] === val && run < 63) run++;
    if (run > 1 || (val & 0xc0) === 0xc0) out.push(0xc0 | run, val);
    else out.push(val);
    i += run;
  }
  return out;
}

function buildPcxBytes(width: number, height: number, pixelFn: (x: number, y: number) => number): Uint8Array {
  const header = new Uint8Array(128);
  header[0] = 0x0a;
  header[1] = 5;
  header[2] = 1;
  header[3] = 8;
  const hv = new DataView(header.buffer);
  hv.setUint16(8, width - 1, true);
  hv.setUint16(10, height - 1, true);
  const encoded: number[] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) row.push(pixelFn(x, y));
    encoded.push(...rleEncodeRow(row));
  }
  const pixelData = new Uint8Array(encoded);
  const palette = new Uint8Array(768);
  for (let i = 0; i < 768; i++) palette[i] = i % 256;
  const bytes = new Uint8Array(header.length + pixelData.length + palette.length);
  bytes.set(header, 0);
  bytes.set(pixelData, header.length);
  bytes.set(palette, header.length + pixelData.length);
  return bytes;
}

// The RGBA bytes of the Nth qglTexImage2D recorded, as [r,g,b,a] per texel.
//
// Every fixture the post-processing tests below upload is 1x1 ON PURPOSE.
// GL_Upload32's mip loop calls GL_MipMap, which halves the level IN PLACE in
// the very buffer it already handed to qglTexImage2D for level 0 -- and
// QGLRecording stores the argument by reference, not by copy. So for any
// image bigger than 1x1 the recorded "level 0" payload has already been
// overwritten by the time a test reads it (a 2x2 fixture reads back as its
// own 1x1 mip average). At 1x1 the `while (sw > 1 || sh > 1)` loop never
// runs, nothing is overwritten, and the recorded bytes are exactly what was
// uploaded.
function uploadTexels(index: number): number[][] {
  const uploads = qgl.calls.filter((c) => c.name === "qglTexImage2D");
  const args = uploads[index]?.args;
  const data = args?.[8];
  if (!(data instanceof Uint8Array) && !(data instanceof Uint32Array)) throw new Error("upload payload is not a typed array");
  const bytes = data instanceof Uint32Array ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data;
  const out: number[][] = [];
  for (let i = 0; i < bytes.length; i += 4) out.push([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
  return out;
}

// Loads a 1x1 diffuse + 1x1 glow pair and returns the glow's uploaded RGB.
function glowRgbFor(dir: string, type: ImagetypeT, diffuse: [number, number, number, number], glow: [number, number, number, number]): number[] {
  files.set(`${dir}/t.png`, buildPngRgba(1, 1, () => diffuse));
  files.set(`${dir}/t_glow.png`, buildPngRgba(1, 1, () => glow));
  qgl.clear();
  const image = GL_FindImage(`${dir}/t.png`, type);
  expect(image?.glow).not.toBeNull();
  // upload 0 is the diffuse, upload 1 is the glow (neither has a mip chain)
  return uploadTexels(1)[0].slice(0, 3);
}

beforeEach(() => {
  files = new Map();
  cvars = new Map();
  SetRefImports(makeFakeRi());
  qgl = new QGLRecording();
  SetQGL(qgl);
  for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
  SetNumGltextures(0);
  gl_state.currenttextures[0] = 0;
  gl_state.currenttextures[1] = 0;
  gl_state.currenttmu = 0;
  ResetScrapState();
  gl_state.d_16to8table = null;

  // Identity intensity/gamma LUTs -- see this file's header comment.
  fakeCvarGet("intensity", "1");
  fakeCvarGet("vid_gamma", "1");
  fakeCvarGet("gl_picmip", "0");
  fakeCvarGet("gl_round_down", "0");
  files.set("pics/colormap.pcx", buildPcxBytes(2, 2, () => 1));
  GL_InitImages();
  if (glCvars.gl_ext_palettedtexture) glCvars.gl_ext_palettedtexture.value = 0;

  glCvars.r_glowmaps = fakeCvarGet("r_glowmaps", "1");
  glCvars.gl_glowmap_intensity = fakeCvarGet("gl_glowmap_intensity", "1");
});

describe("GL_CheckForGlowMap -- finding the glow sibling", () => {
  test("a skin loaded as .pcx picks up its _glow.png sibling", () => {
    files.set("models/items/healing/medium/skin.pcx", buildPcxBytes(2, 2, () => 1));
    files.set("models/items/healing/medium/skin_glow.png", buildPngRgba(2, 2, () => [10, 20, 30, 255]));

    const image = GL_FindImage("models/items/healing/medium/skin.pcx", ImagetypeT.it_skin);

    expect(image).not.toBeNull();
    expect(image?.glow).not.toBeNull();
    expect(image?.glow?.name).toBe("models/items/healing/medium/skin_glow.png");
  });

  test("MD5 path: a skin already resolved under md5/ finds md5/skin_glow.png, not the MD2-level one", () => {
    // Both exist on disk, exactly as they do in the rerelease pak. The one
    // next to the resolved skin is the one that must win.
    files.set("models/monsters/soldier/skin_glow.png", buildPngRgba(2, 2, () => [1, 1, 1, 255]));
    files.set("models/monsters/soldier/md5/skin.png", buildPngRgba(2, 2, () => [40, 50, 60, 255]));
    files.set("models/monsters/soldier/md5/skin_glow.png", buildPngRgba(2, 2, () => [70, 80, 90, 255]));

    const image = GL_FindImage("models/monsters/soldier/md5/skin.pcx", ImagetypeT.it_skin);

    expect(image?.name).toBe("models/monsters/soldier/md5/skin.png");
    expect(image?.glow?.name).toBe("models/monsters/soldier/md5/skin_glow.png");
  });

  test("no glow sibling on disk leaves image.glow null", () => {
    files.set("models/items/quaddama/skin.pcx", buildPcxBytes(2, 2, () => 1));

    const image = GL_FindImage("models/items/quaddama/skin.pcx", ImagetypeT.it_skin);

    expect(image).not.toBeNull();
    expect(image?.glow).toBeNull();
  });

  test("r_glowmaps 0 skips the glow entirely even though the file is there", () => {
    if (glCvars.r_glowmaps) glCvars.r_glowmaps.value = 0;
    files.set("models/items/healing/medium/skin.pcx", buildPcxBytes(2, 2, () => 1));
    files.set("models/items/healing/medium/skin_glow.png", buildPngRgba(2, 2, () => [10, 20, 30, 255]));

    const image = GL_FindImage("models/items/healing/medium/skin.pcx", ImagetypeT.it_skin);

    expect(image?.glow).toBeNull();
  });

  test("a pic is never given a glow map (only skins and walls are)", () => {
    files.set("pics/thing.png", buildPngRgba(128, 128, () => [10, 20, 30, 255]));
    files.set("pics/thing_glow.png", buildPngRgba(128, 128, () => [40, 50, 60, 255]));

    const image = GL_FindImage("pics/thing.png", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.glow).toBeNull();
  });

  test("two textures sharing one glow file reuse the same glow image rather than uploading it twice", () => {
    files.set("textures/e1u1/a.png", buildPngRgba(2, 2, () => [10, 10, 10, 255]));
    files.set("textures/e1u1/a_glow.png", buildPngRgba(2, 2, () => [90, 90, 90, 255]));

    const first = GL_FindImage("textures/e1u1/a.png", ImagetypeT.it_wall);
    // A second lookup of the same name is a cache hit; the glow must ride along.
    const second = GL_FindImage("textures/e1u1/a.png", ImagetypeT.it_wall);

    expect(second).toBe(first);
    expect(second?.glow).toBe(first?.glow);
    const baseUploads = qgl.calls.filter((c) => c.name === "qglTexImage2D" && c.args[1] === 0).length;
    // one diffuse + one glow, not one diffuse + two glows
    expect(baseUploads).toBe(2);
  });
});

describe("GL_CheckForGlowMap -- post-processing", () => {
  test("it_skin premultiplies RGB by alpha, so masked-out RGB uploads as zero", () => {
    // Real rerelease model glow maps carry non-zero RGB where alpha is 0
    // (models/monsters/soldier/md5/skin_glow.png has 57706 such texels).
    // Unpremultiplied, that RGB would be added over the whole model as a
    // wash of light; premultiplying is what confines the glow to the mask.
    const emissive = glowRgbFor("models/a", ImagetypeT.it_skin, [9, 9, 9, 255], [200, 100, 50, 255]);
    const masked = glowRgbFor("models/b", ImagetypeT.it_skin, [9, 9, 9, 255], [200, 100, 50, 0]);
    const half = glowRgbFor("models/c", ImagetypeT.it_skin, [9, 9, 9, 255], [200, 100, 50, 128]);

    expect(emissive).toEqual([200, 100, 50]);
    expect(masked).toEqual([0, 0, 0]);
    expect(half).toEqual([100, 50, 25]);
  });

  test("it_wall bakes diffuse.rgb * glow.a, so the emissive colour is the wall's own colour", () => {
    // Wall glow maps are pure white wherever alpha matters (checked across
    // textures/e1u1/*_glow.png), so the colour has to come from the diffuse
    // -- using the glow's own RGB would wash every emissive wall to white.
    const emissive = glowRgbFor("textures/w1", ImagetypeT.it_wall, [80, 160, 240, 255], [255, 255, 255, 255]);
    const masked = glowRgbFor("textures/w2", ImagetypeT.it_wall, [80, 160, 240, 255], [255, 255, 255, 0]);
    const half = glowRgbFor("textures/w3", ImagetypeT.it_wall, [80, 160, 240, 255], [255, 255, 255, 128]);

    expect(emissive).toEqual([80, 160, 240]); // the wall's colour, not white
    expect(masked).toEqual([0, 0, 0]);
    expect(half).toEqual([40, 80, 120]);
  });

  test("calling GL_CheckForGlowMap twice does not re-upload or relink", () => {
    files.set("models/y/skin.png", buildPngRgba(2, 2, () => [10, 10, 10, 255]));
    files.set("models/y/skin_glow.png", buildPngRgba(2, 2, () => [20, 20, 20, 255]));

    const image = GL_FindImage("models/y/skin.png", ImagetypeT.it_skin);
    expect(image).not.toBeNull();
    const firstGlow = image?.glow;
    const uploadsBefore = qgl.calls.filter((c) => c.name === "qglTexImage2D").length;

    if (image) GL_CheckForGlowMap(image);

    expect(image?.glow).toBe(firstGlow);
    expect(qgl.calls.filter((c) => c.name === "qglTexImage2D").length).toBe(uploadsBefore);
  });
});

// --- the additive world pass -------------------------------------------------

function makeGlowSurface(image: ImageT): MsurfaceT {
  const surf = new MsurfaceT();
  const poly = new GlpolyT();
  poly.numverts = 3;
  // GlpolyT.verts is one Float32Array per vertex: x,y,z,s,t,lightmap s,t
  poly.verts = [
    new Float32Array([0, 0, 0, 0, 0, 0, 0]),
    new Float32Array([1, 0, 0, 1, 0, 0, 0]),
    new Float32Array([1, 1, 0, 1, 1, 0, 0]),
  ];
  surf.polys = poly;
  surf.texinfo = new MtexinfoT();
  surf.glowchain = null;
  image.glowchain = surf;
  return surf;
}

function makeGlowPair(): ImageT {
  const image = gltextures[0];
  image.name = "textures/e1u1/lamp.png";
  image.type = ImagetypeT.it_wall;
  image.texnum = 500;
  image.registration_sequence = 1;
  const glow = gltextures[1];
  glow.name = "textures/e1u1/lamp_glow.png";
  glow.type = ImagetypeT.it_wall;
  glow.texnum = 501;
  glow.registration_sequence = 1;
  image.glow = glow;
  SetNumGltextures(2);
  makeGlowSurface(image);
  return image;
}

describe("R_DrawGlowmaps -- the additive pass", () => {
  const GL_ONE = 1;
  const GL_ONE_MINUS_DST_COLOR = 0x0307;
  const GL_BLEND = 0x0be2;

  test("draws the glow texture additively, unlit, with depth writes off", () => {
    const image = makeGlowPair();
    qgl.clear();

    R_DrawGlowmaps();

    const blendFuncs = qgl.calls.filter((c) => c.name === "qglBlendFunc");
    expect(blendFuncs[0]?.args).toEqual([GL_ONE_MINUS_DST_COLOR, GL_ONE]);
    expect(qgl.calls.some((c) => c.name === "qglEnable" && c.args[0] === GL_BLEND)).toBe(true);
    expect(qgl.calls.some((c) => c.name === "qglDepthMask" && c.args[0] === false)).toBe(true);
    // the GLOW texture is what gets bound, not the diffuse
    expect(qgl.calls.some((c) => c.name === "qglBindTexture" && c.args[0] === GL_TEXTURE_2D && c.args[1] === 501)).toBe(true);
    // and the surface actually got drawn
    expect(qgl.calls.some((c) => c.name === "qglVertex3fv")).toBe(true);
    // state restored
    expect(qgl.calls.some((c) => c.name === "qglDepthMask" && c.args[0] === true)).toBe(true);
    expect(qgl.calls.some((c) => c.name === "qglDisable" && c.args[0] === GL_BLEND)).toBe(true);
    // the chain is drained so the next frame starts clean
    expect(image.glowchain).toBeNull();
  });

  test("gl_glowmap_intensity scales the constant colour the pass draws with", () => {
    makeGlowPair();
    if (glCvars.gl_glowmap_intensity) glCvars.gl_glowmap_intensity.value = 0.5;
    qgl.clear();

    R_DrawGlowmaps();

    const colours = qgl.calls.filter((c) => c.name === "qglColor4f");
    expect(colours[0]?.args).toEqual([0.5, 0.5, 0.5, 1]);
  });

  test("gl_glowmap_intensity 0 draws nothing but still drains the chain", () => {
    const image = makeGlowPair();
    if (glCvars.gl_glowmap_intensity) glCvars.gl_glowmap_intensity.value = 0;
    qgl.clear();

    R_DrawGlowmaps();

    expect(qgl.calls.some((c) => c.name === "qglVertex3fv")).toBe(false);
    // Draining matters even when suppressed: a surface left linked would be
    // drawn under the next drain's modelview matrix (an inline brush model's).
    expect(image.glowchain).toBeNull();
  });

  test("gl_lightmap mode suppresses the glow (tess.c:759-760) but still drains", () => {
    const image = makeGlowPair();
    glCvars.gl_lightmap = fakeCvarGet("gl_lightmap", "1");
    qgl.clear();

    R_DrawGlowmaps();

    expect(qgl.calls.some((c) => c.name === "qglVertex3fv")).toBe(false);
    expect(image.glowchain).toBeNull();
    glCvars.gl_lightmap = null;
  });

  test("no linked surfaces means no GL state is touched at all", () => {
    qgl.clear();

    R_DrawGlowmaps();

    expect(qgl.calls).toHaveLength(0);
  });
});

// --- the MD5 skin array ------------------------------------------------------

// Smallest .md2 gl_model.ts's Mod_LoadAliasModel will accept, carrying one
// skin name. Adapted from test/gl_model.test.ts's own fixture.
function buildMd2(skinName: string): Uint8Array {
  const HEADER = 68;
  const ofsSt = HEADER;
  const ofsTris = ofsSt + 4;
  const ofsFrames = ofsTris + 12;
  const frameSize = 40 + 4;
  const ofsGlcmds = ofsFrames + frameSize;
  const glcmds = [3, 111, 211, 0, 112, 212, 0, 113, 213, 0, 0];
  const ofsSkins = ofsGlcmds + glcmds.length * 4;
  const ofsEnd = ofsSkins + 64;

  const buf = new Uint8Array(ofsEnd);
  const view = new DataView(buf.buffer);
  view.setInt32(0, IDALIASHEADER, true);
  view.setInt32(4, ALIAS_VERSION, true);
  view.setInt32(8, 32, true); // skinwidth
  view.setInt32(12, 32, true); // skinheight
  view.setInt32(16, frameSize, true);
  view.setInt32(20, 1, true); // num_skins
  view.setInt32(24, 1, true); // num_xyz
  view.setInt32(28, 1, true); // num_st
  view.setInt32(32, 1, true); // num_tris
  view.setInt32(36, glcmds.length, true);
  view.setInt32(40, 1, true); // num_frames
  view.setInt32(44, ofsSkins, true);
  view.setInt32(48, ofsSt, true);
  view.setInt32(52, ofsTris, true);
  view.setInt32(56, ofsFrames, true);
  view.setInt32(60, ofsGlcmds, true);
  view.setInt32(64, ofsEnd, true);
  view.setFloat32(ofsFrames, 1, true);
  view.setFloat32(ofsFrames + 4, 1, true);
  view.setFloat32(ofsFrames + 8, 1, true);
  const fname = "frame1";
  for (let i = 0; i < fname.length; i++) view.setUint8(ofsFrames + 24 + i, fname.charCodeAt(i));
  for (let i = 0; i < glcmds.length; i++) view.setInt32(ofsGlcmds + i * 4, glcmds[i], true);
  for (let i = 0; i < skinName.length; i++) view.setUint8(ofsSkins + i, skinName.charCodeAt(i));
  return buf;
}

describe("R_RegisterModel -- MD5 skins are not clobbered by the MD2 skin names", () => {
  test("a skeletal model keeps its md5/ skin while skins[] still holds the MD2 skin", () => {
    // The defect this guards: Mod_LoadMD5 resolved the md5/ skins straight
    // into mod.skins, and R_RegisterModel -- which re-resolves the MD2 skin
    // names from the header on EVERY registration, as vanilla gl_model.c
    // does -- overwrote them again on the next call, every time. MD5 meshes
    // then drew their own md5/ texture coordinates against the MD2's
    // differently-laid-out, lower-resolution skin.
    files.set("models/test/tris.md2", buildMd2("models/test/skin.pcx"));
    files.set("models/test/skin.pcx", buildPcxBytes(2, 2, () => 1));
    files.set("models/test/md5/skin.png", buildPngRgba(2, 2, () => [40, 50, 60, 255]));

    const first = R_RegisterModel("models/test/tris.md2");
    expect(first).not.toBeNull();
    if (!first) return;

    // Stand in for a real .md5mesh/.md5anim pair: this test is about which
    // array R_RegisterModel writes, not about MD5 parsing (covered by
    // test/md5_model_retail.test.ts).
    first.skeleton = new Md5ModelT();

    const second = R_RegisterModel("models/test/tris.md2");

    expect(second).toBe(first);
    expect(second?.skins[0]?.name).toBe("models/test/skin.pcx");
    expect(second?.md5skins[0]?.name).toBe("models/test/md5/skin.png");
  });

  test("a model with no skeleton resolves no md5/ SKIN (the md5mesh probe itself is expected)", () => {
    const asked: string[] = [];
    SetRefImports({
      ...makeFakeRi(),
      FS_LoadFile: (name: string) => {
        asked.push(name);
        const data = files.get(name);
        if (!data) return { length: -1, data: null };
        return { length: data.length, data };
      },
    });
    files.set("models/plain/tris.md2", buildMd2("models/plain/skin.pcx"));
    files.set("models/plain/skin.pcx", buildPcxBytes(2, 2, () => 1));

    const mod = R_RegisterModel("models/plain/tris.md2");

    expect(mod).not.toBeNull();
    expect(mod?.skeleton).toBeNull();
    expect(mod?.md5skins[0] ?? null).toBeNull();
    // Mod_LoadMD5 probes "<dir>/md5/tris.md5mesh" for every alias model --
    // that IS its file-existence check, and it is expected here. What must
    // not happen is a SKIN lookup under md5/, which is the work
    // R_RegisterModel skips for a model that has no skeleton.
    const skinProbes = asked.filter((n) => n.includes("/md5/") && !n.includes(".md5mesh") && !n.includes(".md5anim") && !n.includes(".md5scale"));
    expect(skinProbes).toEqual([]);
  });
});
