/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_rmisc.c (GNU GPL v2 or later): R_InitParticleTexture,
GL_ScreenShot_f, GL_SetDefaultState, GL_UpdateSwapInterval. `GL_Strings_f`
(a Cmd_AddCommand-registered console command, forward-declared in
gl_rmain.c and registered by that file's R_Register, but *defined* here in
gl_rmisc.c) is ported here too, per PORTING.md's "one .ts module per .c
file" rule -- both this file and gl_rmain.ts are owned by this same unit, so
there is no cross-unit placement mismatch to report.

GL_ScreenShot_f: the original creates the screenshot directory (Sys_Mkdir),
finds the next unused "quakeNN.tga" name by fopen()-probing for existence,
then fopen/fwrite's the TGA buffer to disk. `RefImports` (client/ref.ts)
exposes only read-only *virtual-filesystem* access (FS_LoadFile/FS_FreeFile/
FS_Gamedir) -- no directory-creation, file-write, or raw-OS-path probe
import exists to call. This port builds the identical TGA header and
BGR-swapped pixel buffer via qglReadPixels, and reaches disk through two
platform-injected hooks (SetScreenshotWriter/SetScreenshotExists, installed
by src/platform/vid.ts's VID_Init, the same seam ref_soft's R_ScreenShot_f
uses): the writer stands in for Sys_Mkdir+fwrite, the exists-probe for
fopen(checkname, "rb"). Both take the absolute OS path the C original uses.

`#ifdef _WIN32` in GL_UpdateSwapInterval (the wglSwapIntervalEXT call) is
dropped per PORTING.md's portable-path rule; the modified-flag reset that
guards it is kept.
*/

import { PRINT_ALL, Com_sprintf } from "../shared/q_shared";
import { fixedLength } from "../shared/fixed";
import { ri, glCvars, vid, gl_config, gl_filter_min, gl_filter_max, d_8to24table, ImagetypeT, SetParticleTexture, SetNoTexture } from "./gl_local";
import {
  qgl,
  GL_TEXTURE_2D,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_MAG_FILTER,
  GL_REPLACE,
  GL_ALPHA_TEST,
  GL_BLEND,
  GL_SHARED_TEXTURE_PALETTE_EXT,
  GL_RGB,
  GL_UNSIGNED_BYTE,
  GL_TextureMode,
  GL_TextureAlphaMode,
  GL_TextureSolidMode,
  GL_TexEnv,
  GL_SetTexturePalette,
  GL_LoadPic,
} from "./gl_image";

// standard OpenGL 1.1 enum values (`<GL/gl.h>`) plus the SGIS point-parameter
// extension's (qgl.h) -- no shared GL-enum module exists yet across
// gl_*.ts, see gl_light.ts/gl_rsurf.ts's identical note.
const GL_FRONT = 0x0404;
const GL_FRONT_AND_BACK = 0x0408;
const GL_FILL = 0x1b02;
const GL_FLAT = 0x1d00;
const GL_GREATER = 0x0204;
const GL_DEPTH_TEST = 0x0b71;
const GL_CULL_FACE = 0x0b44;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_REPEAT = 0x2901;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_POINT_SMOOTH = 0x0b10;
const GL_POINT_SIZE_MIN_EXT = 0x8126;
const GL_POINT_SIZE_MAX_EXT = 0x8127;
const GL_DISTANCE_ATTENUATION_EXT = 0x8129;

/*
==================
R_InitParticleTexture
==================
*/
const dottexture: readonly (readonly number[])[] = fixedLength(
  "dottexture",
  8,
  [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [0, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
).map((row) => fixedLength("dottexture row", 8, row));

export function R_InitParticleTexture(): void {
  //
  // particle texture
  //
  const data = new Uint8Array(8 * 8 * 4);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      const o = (y * 8 + x) * 4;
      data[o + 0] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = dottexture[x][y] * 255;
    }
  }
  SetParticleTexture(GL_LoadPic("***particle***", data, 8, 8, ImagetypeT.it_sprite, 32));

  //
  // also use this for bad textures, but without alpha
  //
  const notextureData = new Uint8Array(8 * 8 * 4);
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      const o = (y * 8 + x) * 4;
      notextureData[o + 0] = dottexture[x & 3][y & 3] * 255;
      notextureData[o + 1] = 0; // dottexture[x&3][y&3]*255;
      notextureData[o + 2] = 0; // dottexture[x&3][y&3]*255;
      notextureData[o + 3] = 255;
    }
  }
  SetNoTexture(GL_LoadPic("***r_notexture***", notextureData, 8, 8, ImagetypeT.it_wall, 32));
}

/*
==================
GL_ScreenShot_f
==================
*/
export function GL_ScreenShot_f(): void {
  // create the scrnshot directory / write the file: refimport_t has no
  // Sys_Mkdir/fwrite equivalent, so the platform injects a writer, the
  // same seam ref_soft's R_ScreenShot_f uses (see r_misc.ts).
  if (!screenshotWriter) {
    ri.Con_Printf(PRINT_ALL, "GL_ScreenShot_f: no screenshot writer registered\n");
    return;
  }

  // find a file name to save it to
  const gamedir = ri.FS_Gamedir();
  let picname = "";
  let checkname = "";
  let slot = 0;
  for (; slot <= 99; slot++) {
    picname = `quake${(slot / 10) | 0}${slot % 10}.tga`;
    checkname = `${gamedir}/scrnshot/${picname}`;
    if (!screenshotExists || !screenshotExists(checkname)) break;
  }
  if (slot === 100) {
    ri.Con_Printf(PRINT_ALL, "SCR_ScreenShot_f: Couldn't create a file\n");
    return;
  }

  const buffer = new Uint8Array(vid.width * vid.height * 3 + 18);
  buffer[2] = 2; // uncompressed type
  buffer[12] = vid.width & 255;
  buffer[13] = (vid.width >> 8) & 255;
  buffer[14] = vid.height & 255;
  buffer[15] = (vid.height >> 8) & 255;
  buffer[16] = 24; // pixel size

  qgl.qglReadPixels(0, 0, vid.width, vid.height, GL_RGB, GL_UNSIGNED_BYTE, buffer.subarray(18));

  // swap rgb to bgr
  const c = 18 + vid.width * vid.height * 3;
  for (let i = 18; i < c; i += 3) {
    const temp = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = temp;
  }

  screenshotWriter(checkname, buffer);
  ri.Con_Printf(PRINT_ALL, Com_sprintf("Wrote %s\n", picname));
}

export type ScreenshotWriterT = (path: string, data: Uint8Array) => void;
let screenshotWriter: ScreenshotWriterT | null = null;
export function SetScreenshotWriter(fn: ScreenshotWriterT | null): void {
  screenshotWriter = fn;
}

// The free-filename probe needs the same seam. `checkname` is an absolute OS
// path built from FS_Gamedir(), which ri.FS_LoadFile -- a virtual-filesystem
// lookup relative to the search paths -- can never resolve, so it answered
// "does not exist" for every slot and every screenshot overwrote quake00.
// The C original probes the OS path directly with fopen(checkname, "rb").
export type ScreenshotExistsT = (path: string) => boolean;
let screenshotExists: ScreenshotExistsT | null = null;
export function SetScreenshotExists(fn: ScreenshotExistsT | null): void {
  screenshotExists = fn;
}

/*
** GL_Strings_f
*/
export function GL_Strings_f(): void {
  ri.Con_Printf(PRINT_ALL, Com_sprintf("GL_VENDOR: %s\n", gl_config.vendor_string));
  ri.Con_Printf(PRINT_ALL, Com_sprintf("GL_RENDERER: %s\n", gl_config.renderer_string));
  ri.Con_Printf(PRINT_ALL, Com_sprintf("GL_VERSION: %s\n", gl_config.version_string));
  ri.Con_Printf(PRINT_ALL, Com_sprintf("GL_EXTENSIONS: %s\n", gl_config.extensions_string));
}

/*
** GL_SetDefaultState
*/
export function GL_SetDefaultState(): void {
  qgl.qglClearColor(1, 0, 0.5, 0.5);
  qgl.qglCullFace(GL_FRONT);
  qgl.qglEnable(GL_TEXTURE_2D);

  qgl.qglEnable(GL_ALPHA_TEST);
  qgl.qglAlphaFunc(GL_GREATER, 0.666);

  qgl.qglDisable(GL_DEPTH_TEST);
  qgl.qglDisable(GL_CULL_FACE);
  qgl.qglDisable(GL_BLEND);

  qgl.qglColor4f(1, 1, 1, 1);

  qgl.qglPolygonMode(GL_FRONT_AND_BACK, GL_FILL);
  qgl.qglShadeModel(GL_FLAT);

  GL_TextureMode(glCvars.gl_texturemode ? glCvars.gl_texturemode.string : "GL_LINEAR_MIPMAP_NEAREST");
  GL_TextureAlphaMode(glCvars.gl_texturealphamode ? glCvars.gl_texturealphamode.string : "default");
  GL_TextureSolidMode(glCvars.gl_texturesolidmode ? glCvars.gl_texturesolidmode.string : "default");

  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_min);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);

  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
  qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);

  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);

  GL_TexEnv(GL_REPLACE);

  const pointParameterf = qgl.qglPointParameterfEXT;
  const pointParameterfv = qgl.qglPointParameterfvEXT;
  if (pointParameterf && pointParameterfv) {
    const attenuations = new Float32Array(3);

    attenuations[0] = glCvars.gl_particle_att_a ? glCvars.gl_particle_att_a.value : 0;
    attenuations[1] = glCvars.gl_particle_att_b ? glCvars.gl_particle_att_b.value : 0;
    attenuations[2] = glCvars.gl_particle_att_c ? glCvars.gl_particle_att_c.value : 0;

    qgl.qglEnable(GL_POINT_SMOOTH);
    pointParameterf(GL_POINT_SIZE_MIN_EXT, glCvars.gl_particle_min_size ? glCvars.gl_particle_min_size.value : 0);
    pointParameterf(GL_POINT_SIZE_MAX_EXT, glCvars.gl_particle_max_size ? glCvars.gl_particle_max_size.value : 0);
    pointParameterfv(GL_DISTANCE_ATTENUATION_EXT, attenuations);
  }

  if (Boolean(qgl.qglColorTableEXT) && glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value) {
    qgl.qglEnable(GL_SHARED_TEXTURE_PALETTE_EXT);

    GL_SetTexturePalette(d_8to24table);
  }

  GL_UpdateSwapInterval();
}

export function GL_UpdateSwapInterval(): void {
  if (glCvars.gl_swapinterval && glCvars.gl_swapinterval.modified) {
    glCvars.gl_swapinterval.modified = false;

    // #ifdef _WIN32 wglSwapIntervalEXT branch dropped -- portable path,
    // see file header comment.
  }
}
