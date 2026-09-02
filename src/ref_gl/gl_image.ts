/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_gl/gl_image.c (GNU GPL v2 or later).

QGL binding: qgl.ts's QGL interface always resolves every entry point (a
dlsym() miss on a *_EXT/*_SGIS symbol isn't representable in that interface
today -- see qgl.ts's own header note on this). The C source gates several
code paths on "is this function pointer non-null" (driver/extension support
detection): `qglSelectTextureSGIS` in GL_EnableMultitexture/GL_SelectTexture,
and `qglColorTableEXT` in GL_SetTexturePalette/GL_Upload8/GL_Upload32/
GL_InitImages's 16to8.dat load. Since QGL can't express "this driver doesn't
have it", every one of those existence checks collapses to just the
`gl_ext_palettedtexture` cvar check where one already runs alongside it (the
paletted-texture family), and is dropped outright where it was the only
gate (GL_EnableMultitexture/GL_SelectTexture's qglSelectTextureSGIS check --
multitexture is unconditionally assumed available). Reported deviation;
follow-up: add a capability-negotiation flag to QGL if real driver probing
lands later.

`qgl`/`SetQGL` is a new global holder (mirrors gl_local.ts's `ri`/
SetRefImports pattern) -- gl_local.h has no existing home for qgl_linux.c's
QGL_Init() global, and this unit's SCOPE doesn't include gl_local.ts. Lives
here since gl_draw.ts already depends on this file for Scrap_Upload/GL_Bind/
etc. Follow-up: the eventual gl_rmain.ts R_Init/GLimp_Init unit should call
SetQGL(loadQGLFromSystem()); tests call SetQGL(new QGLRecording()).

`gl_solid_format`/`gl_alpha_format`/`gl_tex_solid_format`/
`gl_tex_alpha_format` are C globals gl_image.c defines with non-zero
initializers (3/4/3/4), but gl_local.ts (a sibling unit, out of this SCOPE)
already owns the storage for them via SetTextureFormats, defaulted to 0 --
this module applies gl_image.c's static-initializer values at load time via
that setter (PORTING.md "brief's placement wins; report the mismatch").
Likewise `gl_filter_min`/`gl_filter_max` (GL_LINEAR_MIPMAP_NEAREST/
GL_LINEAR) via SetGlFilterMinMax.

`draw_chars` (defined in gl_draw.c, `extern`-declared in gl_image.c for
GL_Bind's `gl_nobind` debug path) is imported from gl_draw.ts, forming an
intentional two-way static import cycle between this file and gl_draw.ts
(gl_draw.ts imports GL_Bind/GL_FindImage/etc from here). Both sides only
touch the cyclic binding from inside function bodies (never at module
top-level eval time), so this doesn't hit the TDZ hazard PORTING.md's
import-cycle rule warns about; verified by `bun run check`/`bun test`.

Standard OpenGL 1.x/EXT/SGIS enum values used by this file and gl_draw.ts
have no owning C file in this tree (they come from the system GL headers,
never ported) -- defined here (exported for gl_draw.ts's reuse) since this
module loads first in the file's own dependency order. Follow-up: hoist to
a shared gl_constants module if a third gl_*.ts unit needs them.

`base_textureid` (`int base_textureid; // gltextures[i] = base_textureid+i`)
is declared in gl_image.c but never read or written anywhere in the C
tree outside that comment -- dead global, dropped (not ported).

LoadPCX/LoadTGA's `byte **pic, byte **palette, int *width, int *height` out
params become returned objects per PORTING.md's out-param convention.
Scrap_AllocBlock's `int *x, int *y` likewise. LoadPCX and LoadTGA are gl's
own copies (per-tree ownership, matching gl_image.c's own definitions --
not imported from ref_soft/r_image.ts) and are exported here (gl_local.h
doesn't declare them) purely for this unit's test seam, mirroring the
existing stub's precedent of exporting LoadPCX for the same reason.
GL_Upload8, Scrap_AllocBlock and Scrap_Upload are exported for the same
test-seam reason; GL_Upload32, GL_ResampleTexture's helpers (GL_MipMap,
GL_LightScaleTexture, GL_BuildPalettedTexture), R_FloodFillSkin and
GL_LoadWal stay module-private, matching gl_local.h's declared surface.

R_TranslatePlayerSkin is declared in gl_local.h but (confirmed by grepping
the full ref_gl tree) is not defined in any gl_*.c file in this v3.19
source -- a dead declaration, like cl_pred.ts's CL_InitPrediction/
CL_PredictMove. Not stubbed; reported as a dropped dead declaration rather
than a gap.

gl_solid_modes' `#ifdef GL_RGB2_EXT { "GL_RGB2", GL_RGB2_EXT }` entry is
dropped per PORTING.md's "#ifdef ... take the portable path" rule (that
symbol is never defined by the portable, no-headers GL binding this port
uses).

R_FloodFillSkin's opaque-black search (`d_8to24table[i] == (255 << 0)`,
commented "// alpha 1.0" in the original) is ported literally byte-for-byte
even though the comment and the bitmask disagree (the mask actually tests
byte 0 -- the red channel on this port's little-endian layout -- for 255,
not the alpha byte): PORTING.md requires a bug-for-bug port, not a fix.

GL_Upload8's is_sky-and-paletted branch has no `return` statement in the
original C (the function is declared to return qboolean but falls off the
end of that branch -- real undefined behavior in id's source). Ported to
deterministically `return false`; reported deviation since a literal
"undefined value" isn't expressible under TS's strict typing.
*/

import { ERR_DROP, ERR_FATAL, PRINT_ALL, PRINT_DEVELOPER, MAX_QPATH, LittleShort, LittleLong, Q_stricmp, Com_sprintf, CVAR_FILES, type CvarT } from "../shared/q_shared";
import { decodePNG } from "../qcommon/png";
import { decodeJPG } from "../qcommon/jpg";
import { decodeBMP } from "../qcommon/bmp";
import { decodeGIF } from "../qcommon/gif";
import { imageExtCandidates, type ImgExtT } from "../qcommon/img_resolve";
import type { QGL } from "./qgl";
import {
  ImageT,
  ImagetypeT,
  gltextures,
  numgltextures,
  SetNumGltextures,
  MAX_GLTEXTURES,
  TEXNUM_SCRAPS,
  TEXNUM_IMAGES,
  r_notexture,
  r_particletexture,
  gl_filter_min,
  gl_filter_max,
  SetGlFilterMinMax,
  glCvars,
  gl_lightmap_format,
  gl_solid_format,
  gl_alpha_format,
  gl_tex_solid_format,
  gl_tex_alpha_format,
  SetTextureFormats,
  d_8to24table,
  registration_sequence,
  SetRegistrationSequence,
  gl_config,
  gl_state,
  GL_RENDERER_VOODOO,
  GL_RENDERER_VOODOO2,
  ri,
} from "./gl_local";
import { draw_chars } from "./gl_draw";

// ---------------------------------------------------------------------
// OpenGL enum values this file (and gl_draw.ts) call qgl* with. See header
// comment: no owning C file for these in this tree; exported for reuse.
// ---------------------------------------------------------------------
export const GL_TEXTURE_2D = 0x0de1;
export const GL_QUADS = 0x0007;
export const GL_NEAREST = 0x2600;
export const GL_LINEAR = 0x2601;
export const GL_NEAREST_MIPMAP_NEAREST = 0x2700;
export const GL_LINEAR_MIPMAP_NEAREST = 0x2701;
export const GL_NEAREST_MIPMAP_LINEAR = 0x2702;
export const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
export const GL_TEXTURE_MAG_FILTER = 0x2800;
export const GL_TEXTURE_MIN_FILTER = 0x2801;
export const GL_RGB = 0x1907;
export const GL_RGBA = 0x1908;
export const GL_RGB4 = 0x804f;
export const GL_RGB5 = 0x8050;
export const GL_RGB8 = 0x8051;
export const GL_RGBA2 = 0x8055;
export const GL_RGBA4 = 0x8056;
export const GL_RGB5_A1 = 0x8057;
export const GL_RGBA8 = 0x8058;
export const GL_R3_G3_B2 = 0x2a10;
export const GL_UNSIGNED_BYTE = 0x1401;
export const GL_COLOR_INDEX = 0x1900;
// #ifndef GL_COLOR_INDEX8_EXT #define GL_COLOR_INDEX8_EXT GL_COLOR_INDEX
// (gl_local.h's own portable fallback -- this binding never has the real
// EXT header value either, so the fallback is the faithful choice here).
export const GL_COLOR_INDEX8_EXT = GL_COLOR_INDEX;
export const GL_TEXTURE_ENV = 0x2300;
export const GL_TEXTURE_ENV_MODE = 0x2200;
export const GL_REPLACE = 0x1e01;
export const GL_TEXTURE0_SGIS = 0x835e;
export const GL_TEXTURE1_SGIS = 0x835f;
export const GL_SHARED_TEXTURE_PALETTE_EXT = 0x81fb;
export const GL_ALPHA_TEST = 0x0bc0;
export const GL_BLEND = 0x0be2;

// ---------------------------------------------------------------------
// qgl binding (see header comment)
// ---------------------------------------------------------------------
export let qgl: QGL;
export function SetQGL(q: QGL): void {
  qgl = q;
}

// static initializers gl_image.c applies to gl_local.ts-owned storage (see
// header comment on the placement mismatch).
SetTextureFormats(gl_lightmap_format, 3, 4, 3, 4);
SetGlFilterMinMax(GL_LINEAR_MIPMAP_NEAREST, GL_LINEAR);

function uint32AsBytes(arr: Uint32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bytesToUint32Copy(pixels: Uint8Array, count: number): Uint32Array {
  const out = new Uint32Array(count);
  uint32AsBytes(out).set(pixels.subarray(0, count * 4));
  return out;
}

/*
===============
GL_SetTexturePalette
===============
*/
export function GL_SetTexturePalette(palette: Uint32Array): void {
  const temptable = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    temptable[i * 3 + 0] = (palette[i] >>> 0) & 0xff;
    temptable[i * 3 + 1] = (palette[i] >>> 8) & 0xff;
    temptable[i * 3 + 2] = (palette[i] >>> 16) & 0xff;
  }

  const colorTable = qgl.qglColorTableEXT;
  if (colorTable && glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value) {
    colorTable(GL_SHARED_TEXTURE_PALETTE_EXT, GL_RGB, 256, GL_RGB, GL_UNSIGNED_BYTE, temptable);
  }
}

/*
===============
GL_EnableMultitexture / GL_SelectTexture / GL_TexEnv
===============
*/
export function GL_EnableMultitexture(enable: boolean): void {
  if (!qgl.qglSelectTextureSGIS) return; // C: if ( !qglSelectTextureSGIS ) return;
  if (enable) {
    GL_SelectTexture(GL_TEXTURE1_SGIS);
    qgl.qglEnable(GL_TEXTURE_2D);
    GL_TexEnv(GL_REPLACE);
  } else {
    GL_SelectTexture(GL_TEXTURE1_SGIS);
    qgl.qglDisable(GL_TEXTURE_2D);
    GL_TexEnv(GL_REPLACE);
  }
  GL_SelectTexture(GL_TEXTURE0_SGIS);
  GL_TexEnv(GL_REPLACE);
}

export function GL_SelectTexture(texture: number): void {
  const selectTexture = qgl.qglSelectTextureSGIS;
  if (!selectTexture) return; // C: if ( !qglSelectTextureSGIS ) return;
  const tmu = texture === GL_TEXTURE0_SGIS ? 0 : 1;
  if (tmu === gl_state.currenttmu) return;
  gl_state.currenttmu = tmu;
  selectTexture(tmu === 0 ? GL_TEXTURE0_SGIS : GL_TEXTURE1_SGIS);
}

const lastmodes: [number, number] = [-1, -1];
export function GL_TexEnv(mode: number): void {
  if (mode !== lastmodes[gl_state.currenttmu]) {
    qgl.qglTexEnvf(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, mode);
    lastmodes[gl_state.currenttmu] = mode;
  }
}

/*
===============
GL_Bind / GL_MBind
===============
*/
export function GL_Bind(texnum: number): void {
  let bindTexnum = texnum;
  if (glCvars.gl_nobind && glCvars.gl_nobind.value && draw_chars) {
    bindTexnum = draw_chars.texnum;
  }
  if (gl_state.currenttextures[gl_state.currenttmu] === bindTexnum) return;
  gl_state.currenttextures[gl_state.currenttmu] = bindTexnum;
  qgl.qglBindTexture(GL_TEXTURE_2D, bindTexnum);
}

export function GL_MBind(target: number, texnum: number): void {
  GL_SelectTexture(target);
  if (target === GL_TEXTURE0_SGIS) {
    if (gl_state.currenttextures[0] === texnum) return;
  } else {
    if (gl_state.currenttextures[1] === texnum) return;
  }
  GL_Bind(texnum);
}

/*
===============
GL_TextureMode / GL_TextureAlphaMode / GL_TextureSolidMode
===============
*/
const modes: { name: string; minimize: number; maximize: number }[] = [
  { name: "GL_NEAREST", minimize: GL_NEAREST, maximize: GL_NEAREST },
  { name: "GL_LINEAR", minimize: GL_LINEAR, maximize: GL_LINEAR },
  { name: "GL_NEAREST_MIPMAP_NEAREST", minimize: GL_NEAREST_MIPMAP_NEAREST, maximize: GL_NEAREST },
  { name: "GL_LINEAR_MIPMAP_NEAREST", minimize: GL_LINEAR_MIPMAP_NEAREST, maximize: GL_LINEAR },
  { name: "GL_NEAREST_MIPMAP_LINEAR", minimize: GL_NEAREST_MIPMAP_LINEAR, maximize: GL_NEAREST },
  { name: "GL_LINEAR_MIPMAP_LINEAR", minimize: GL_LINEAR_MIPMAP_LINEAR, maximize: GL_LINEAR },
];

export function GL_TextureMode(str: string): void {
  let i = 0;
  for (; i < modes.length; i++) {
    if (Q_stricmp(modes[i].name, str) === 0) break;
  }
  if (i === modes.length) {
    ri.Con_Printf(PRINT_ALL, "bad filter name\n");
    return;
  }
  SetGlFilterMinMax(modes[i].minimize, modes[i].maximize);

  for (let j = 0; j < numgltextures; j++) {
    const glt = gltextures[j];
    if (glt.type !== ImagetypeT.it_pic && glt.type !== ImagetypeT.it_sky) {
      GL_Bind(glt.texnum);
      qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_min);
      qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
    }
  }
}

const gl_alpha_modes: { name: string; mode: number }[] = [
  { name: "default", mode: 4 },
  { name: "GL_RGBA", mode: GL_RGBA },
  { name: "GL_RGBA8", mode: GL_RGBA8 },
  { name: "GL_RGB5_A1", mode: GL_RGB5_A1 },
  { name: "GL_RGBA4", mode: GL_RGBA4 },
  { name: "GL_RGBA2", mode: GL_RGBA2 },
];

export function GL_TextureAlphaMode(str: string): void {
  let i = 0;
  for (; i < gl_alpha_modes.length; i++) {
    if (Q_stricmp(gl_alpha_modes[i].name, str) === 0) break;
  }
  if (i === gl_alpha_modes.length) {
    ri.Con_Printf(PRINT_ALL, "bad alpha texture mode name\n");
    return;
  }
  SetTextureFormats(gl_lightmap_format, gl_solid_format, gl_alpha_format, gl_tex_solid_format, gl_alpha_modes[i].mode);
}

// #ifdef GL_RGB2_EXT's extra entry dropped (see header comment).
const gl_solid_modes: { name: string; mode: number }[] = [
  { name: "default", mode: 3 },
  { name: "GL_RGB", mode: GL_RGB },
  { name: "GL_RGB8", mode: GL_RGB8 },
  { name: "GL_RGB5", mode: GL_RGB5 },
  { name: "GL_RGB4", mode: GL_RGB4 },
  { name: "GL_R3_G3_B2", mode: GL_R3_G3_B2 },
];

export function GL_TextureSolidMode(str: string): void {
  let i = 0;
  for (; i < gl_solid_modes.length; i++) {
    if (Q_stricmp(gl_solid_modes[i].name, str) === 0) break;
  }
  if (i === gl_solid_modes.length) {
    ri.Con_Printf(PRINT_ALL, "bad solid texture mode name\n");
    return;
  }
  SetTextureFormats(gl_lightmap_format, gl_solid_format, gl_alpha_format, gl_solid_modes[i].mode, gl_tex_alpha_format);
}

/*
===============
GL_ImageList_f
===============
*/
export function GL_ImageList_f(): void {
  ri.Con_Printf(PRINT_ALL, "------------------\n");
  let texels = 0;
  const palstrings = ["RGB", "PAL"];

  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (image.texnum <= 0) continue;
    texels += image.upload_width * image.upload_height;

    let marker: string;
    switch (image.type) {
      case ImagetypeT.it_skin:
        marker = "M";
        break;
      case ImagetypeT.it_sprite:
        marker = "S";
        break;
      case ImagetypeT.it_wall:
        marker = "W";
        break;
      case ImagetypeT.it_pic:
        marker = "P";
        break;
      default:
        marker = " ";
        break;
    }
    ri.Con_Printf(PRINT_ALL, marker);
    ri.Con_Printf(PRINT_ALL, Com_sprintf(" %3i %3i %s: %s\n", image.upload_width, image.upload_height, palstrings[image.paletted ? 1 : 0], image.name));
  }
  ri.Con_Printf(PRINT_ALL, Com_sprintf("Total texel count (not counting mipmaps): %i\n", texels));
}

/*
=============================================================================
  scrap allocation
=============================================================================
*/
const MAX_SCRAPS = 1;
const BLOCK_WIDTH = 256;
const BLOCK_HEIGHT = 256;

const scrap_allocated: Int32Array[] = Array.from({ length: MAX_SCRAPS }, () => new Int32Array(BLOCK_WIDTH));
const scrap_texels: Uint8Array[] = Array.from({ length: MAX_SCRAPS }, () => new Uint8Array(BLOCK_WIDTH * BLOCK_HEIGHT));
export let scrap_dirty = false;
let scrap_uploads = 0;

// returns a texture number and the position inside it
export function Scrap_AllocBlock(w: number, h: number): { texnum: number; x: number; y: number } {
  for (let texnum = 0; texnum < MAX_SCRAPS; texnum++) {
    let best = BLOCK_HEIGHT;
    let x = 0;

    for (let i = 0; i < BLOCK_WIDTH - w; i++) {
      let best2 = 0;
      let j = 0;
      for (; j < w; j++) {
        if (scrap_allocated[texnum][i + j] >= best) break;
        if (scrap_allocated[texnum][i + j] > best2) best2 = scrap_allocated[texnum][i + j];
      }
      if (j === w) {
        // this is a valid spot
        x = i;
        best = best2;
      }
    }

    if (best + h > BLOCK_HEIGHT) continue;

    for (let i = 0; i < w; i++) scrap_allocated[texnum][x + i] = best + h;

    return { texnum, x, y: best };
  }

  return { texnum: -1, x: 0, y: 0 };
}

export function Scrap_Upload(): void {
  scrap_uploads++;
  GL_Bind(TEXNUM_SCRAPS);
  GL_Upload8(scrap_texels[0], BLOCK_WIDTH, BLOCK_HEIGHT, false, false);
  scrap_dirty = false;
}

// Test seam (not a port of anything in gl_image.c -- vanilla's own
// scrap_allocated/scrap_texels are process-lifetime statics with no
// shutdown-time clear either, and GL_ShutdownImages doesn't touch them).
// Any test that loads a real image through GL_LoadPic's it_pic-and-
// under-64px scrap-allocation branch below mutates this module-private
// state permanently -- with no reset, that allocator offset leaks into
// whatever OTHER test file's own Scrap_AllocBlock assertions run later in
// the same bun:test process (gltextures/numgltextures already get an
// equivalent per-test reset via SetNumGltextures; this is the same idea
// for the scrap allocator specifically). Test suites that exercise
// GL_FindImage/GL_LoadPic with small it_pic fixtures must call this in
// their own beforeEach.
export function ResetScrapState(): void {
  for (let texnum = 0; texnum < MAX_SCRAPS; texnum++) {
    scrap_allocated[texnum].fill(0);
    scrap_texels[texnum].fill(0);
  }
  scrap_dirty = false;
  scrap_uploads = 0;
}

/*
=================================================================
PCX LOADING
=================================================================
*/
const PCX_HEADER_SIZE = 128;
const PCX_PALETTE_SIZE = 768;

export function LoadPCX(filename: string): { pic: Uint8Array | null; palette: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; palette: Uint8Array | null; width: number; height: number } = { pic: null, palette: null, width: 0, height: 0 };

  const { data: raw } = ri.FS_LoadFile(filename);
  if (!raw) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad pcx file ${filename}\n`);
    return result;
  }

  // A .pcx shorter than its own 128-byte header cannot be read at all. The C
  // original casts the buffer straight to a dpcx_t and reads through it, which
  // in C quietly reads past a short allocation; here the DataView reads below
  // would throw a RangeError and take the renderer down on a truncated or
  // otherwise junk file. Rejected the same way every other malformed .pcx is.
  if (raw.byteLength < PCX_HEADER_SIZE) {
    ri.Con_Printf(PRINT_ALL, `Bad pcx file ${filename}\n`);
    ri.FS_FreeFile(raw);
    return result;
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const manufacturer = view.getUint8(0);
  const version = view.getUint8(1);
  const encoding = view.getUint8(2);
  const bits_per_pixel = view.getUint8(3);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);

  if (manufacturer !== 0x0a || version !== 5 || encoding !== 1 || bits_per_pixel !== 8 || xmax >= 640 || ymax >= 480) {
    ri.Con_Printf(PRINT_ALL, `Bad pcx file ${filename}\n`);
    return result;
  }

  const width = xmax + 1;
  const height = ymax + 1;
  const out = new Uint8Array(width * height);
  result.pic = out;
  result.width = width;
  result.height = height;

  const len = raw.byteLength;
  const palette = new Uint8Array(PCX_PALETTE_SIZE);
  palette.set(raw.subarray(len - PCX_PALETTE_SIZE, len));
  result.palette = palette;

  let srcPos = PCX_HEADER_SIZE;
  let pix = 0;
  for (let y = 0; y <= ymax; y++, pix += width) {
    for (let x = 0; x <= xmax; ) {
      let dataByte = raw[srcPos++];
      let runLength: number;
      if ((dataByte & 0xc0) === 0xc0) {
        runLength = dataByte & 0x3f;
        dataByte = raw[srcPos++];
      } else {
        runLength = 1;
      }
      while (runLength-- > 0) out[pix + x++] = dataByte;
    }
  }

  if (srcPos > len) {
    ri.Con_Printf(PRINT_DEVELOPER, `PCX file ${filename} was malformed`);
    result.pic = null;
  }

  ri.FS_FreeFile(raw);
  return result;
}

/*
=========================================================
TARGA LOADING
=========================================================
*/
export function LoadTGA(name: string): { pic: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; width: number; height: number } = { pic: null, width: 0, height: 0 };

  const { data: buffer } = ri.FS_LoadFile(name);
  if (!buffer) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad tga file ${name}\n`);
    return result;
  }

  let p = 0;
  const id_length = buffer[p++];
  const colormap_type = buffer[p++];
  const image_type = buffer[p++];
  p += 2; // colormap_index (unused by this loader, same as the original)
  p += 2; // colormap_length (unused)
  p += 1; // colormap_size (unused)
  p += 2; // x_origin (unused)
  p += 2; // y_origin (unused)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const width = LittleShort(view.getUint16(p, true));
  p += 2;
  const height = LittleShort(view.getUint16(p, true));
  p += 2;
  const pixel_size = buffer[p++];
  p += 1; // attributes (unused)

  // Type 3 (uncompressed, black-and-white/grayscale) added for the
  // rerelease's own retail data: vanilla 3.21 never shipped a single type-3
  // .tga (its LoadTGA -- this function's original -- only ever needed type
  // 2/10 RGB), but the 2023 KEX rerelease does, e.g. baseq2/pak0.pak's
  // sprites/flare_01.tga through flare_04.tga (128x128, 8bpp grayscale glow
  // textures for misc_flare -- kexgame/g_misc.ts's SP_misc_flare, RULE-17:
  // vanilla-derived code never re-read against rerelease-era asset formats).
  // Before this, resolving any of those names (once cl_parse.ts's
  // CL_RegisterImage correctly routes them here instead of mangling the
  // name with an extra "pics/"+".pcx") hit this Sys_Error and dropped the
  // client. q2repro's own IMG_LoadTGA (src/refresh/images.c:543-547)
  // explicitly accepts this same TGA_Mono type alongside TGA_RGB/TGA_Colormap.
  if (image_type !== 2 && image_type !== 3 && image_type !== 10) {
    ri.Sys_Error(ERR_DROP, "LoadTGA: Only type 2, 3 and 10 targa RGB images supported\n");
  }
  if (colormap_type !== 0 || (image_type === 3 ? pixel_size !== 8 : pixel_size !== 32 && pixel_size !== 24)) {
    ri.Sys_Error(ERR_DROP, "LoadTGA: Only 32 or 24 bit images supported (8 bit for type 3, no colormaps)\n");
  }

  const columns = width;
  const rows = height;
  const numPixels = columns * rows;

  result.width = columns;
  result.height = rows;

  const targa_rgba = new Uint8Array(numPixels * 4);
  result.pic = targa_rgba;

  if (id_length !== 0) p += id_length; // skip TARGA image comment

  if (image_type === 2) {
    // Uncompressed, RGB images
    for (let row = rows - 1; row >= 0; row--) {
      let pixbuf = row * columns * 4;
      for (let column = 0; column < columns; column++) {
        if (pixel_size === 24) {
          const blue = buffer[p++];
          const green = buffer[p++];
          const red = buffer[p++];
          targa_rgba[pixbuf++] = red;
          targa_rgba[pixbuf++] = green;
          targa_rgba[pixbuf++] = blue;
          targa_rgba[pixbuf++] = 255;
        } else {
          const blue = buffer[p++];
          const green = buffer[p++];
          const red = buffer[p++];
          const alphabyte = buffer[p++];
          targa_rgba[pixbuf++] = red;
          targa_rgba[pixbuf++] = green;
          targa_rgba[pixbuf++] = blue;
          targa_rgba[pixbuf++] = alphabyte;
        }
      }
    }
  } else if (image_type === 3) {
    // Uncompressed, black-and-white (grayscale) images -- new for the
    // rerelease's own retail data (see this branch's gate comment above).
    // No reference C to be byte-faithful to (vanilla never had this case);
    // ported to match q2repro's IMG_LoadTGA's TGA_Mono handling instead
    // (images.c:653-onward's `pal = NULL` / single-byte-per-pixel path),
    // same bottom-to-top row order as this file's existing type 2/10
    // branches (this loader, unlike q2repro's, never reads the
    // TGA_TOPTOBOTTOM attributes bit either -- consistent with the rest of
    // this function).
    for (let row = rows - 1; row >= 0; row--) {
      let pixbuf = row * columns * 4;
      for (let column = 0; column < columns; column++) {
        const gray = buffer[p++];
        targa_rgba[pixbuf++] = gray;
        targa_rgba[pixbuf++] = gray;
        targa_rgba[pixbuf++] = gray;
        targa_rgba[pixbuf++] = 255;
      }
    }
  } else if (image_type === 10) {
    // Runlength encoded RGB images. The original's `goto breakOut` always
    // fires exactly when row is already 0 (the "else" of `if (row>0)
    // row--; else goto breakOut;`), at which point the enclosing
    // `for(row=rows-1;row>=0;row--)`'s own decrement would immediately
    // drive row negative and end the loop anyway -- so a labeled break out
    // of the whole decode is behaviorally identical to the original's goto
    // + outer-loop-exit combination.
    rleDecode: for (let row = rows - 1; row >= 0; ) {
      let pixbuf = row * columns * 4;
      let column = 0;
      while (column < columns) {
        const packetHeader = buffer[p++];
        const packetSize = 1 + (packetHeader & 0x7f);
        let red: number, green: number, blue: number, alphabyte: number;
        if (packetHeader & 0x80) {
          // run-length packet
          if (pixel_size === 24) {
            blue = buffer[p++];
            green = buffer[p++];
            red = buffer[p++];
            alphabyte = 255;
          } else {
            blue = buffer[p++];
            green = buffer[p++];
            red = buffer[p++];
            alphabyte = buffer[p++];
          }
          for (let j = 0; j < packetSize; j++) {
            targa_rgba[pixbuf++] = red;
            targa_rgba[pixbuf++] = green;
            targa_rgba[pixbuf++] = blue;
            targa_rgba[pixbuf++] = alphabyte;
            column++;
            if (column === columns) {
              // run spans across rows
              column = 0;
              if (row > 0) row--;
              else break rleDecode;
              pixbuf = row * columns * 4;
            }
          }
        } else {
          // non run-length packet
          for (let j = 0; j < packetSize; j++) {
            if (pixel_size === 24) {
              blue = buffer[p++];
              green = buffer[p++];
              red = buffer[p++];
              alphabyte = 255;
            } else {
              blue = buffer[p++];
              green = buffer[p++];
              red = buffer[p++];
              alphabyte = buffer[p++];
            }
            targa_rgba[pixbuf++] = red;
            targa_rgba[pixbuf++] = green;
            targa_rgba[pixbuf++] = blue;
            targa_rgba[pixbuf++] = alphabyte;
            column++;
            if (column === columns) {
              // pixel packet run spans across rows
              column = 0;
              if (row > 0) row--;
              else break rleDecode;
              pixbuf = row * columns * 4;
            }
          }
        }
      }
    }
  }

  ri.FS_FreeFile(buffer);
  return result;
}

/*
=========================================================
PNG LOADING

No classic-engine precedent -- see qcommon/png.ts's own header comment for
why this exists (q2repro's real "fonts/qconfont.png" kfont texture asset,
truecolor, no .tga/.pcx sibling). Same {pic, width, height} shape and
top-down RGBA8 orientation as LoadTGA's own result above, so GL_FindImage's
".png" branch below can call `GL_LoadPic(name, pic, width, height, type,
32)` identically to its ".tga" branch. Interlaced (Adam7), 16-bit, and
palette (color type 3 + PLTE/tRNS) PNGs decode successfully as of 1bbc2a4
(qcommon/png.ts's decodePNG covers the entire retail PNG census, not just
truecolor) -- the `decoded.reason.startsWith("unsupported"/"interlaced"/
"unknown")` -> Sys_Error branch below only fires for a genuinely malformed
IHDR now (an unrecognized color type/bit-depth/interlace-method value), the
same "recognized-format, corrupt/malformed data" class as LoadTGA's own
Sys_Error convention (`Only type 2 and 10 targa RGB images supported`), not
"recognized but unsupported variant" as a category anymore; "not a PNG at
all"/corrupt data mirrors LoadPCX/LoadTGA's Con_Printf + null-pic convention
for a genuinely bad/missing file.
=========================================================
*/
export function LoadPNG(name: string): { pic: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; width: number; height: number } = { pic: null, width: 0, height: 0 };

  const { data: buffer } = ri.FS_LoadFile(name);
  if (!buffer) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad png file ${name}\n`);
    return result;
  }

  const decoded = decodePNG(buffer);
  ri.FS_FreeFile(buffer);

  if (!decoded.ok) {
    if (decoded.reason.startsWith("unsupported") || decoded.reason.startsWith("interlaced") || decoded.reason.startsWith("unknown")) {
      ri.Sys_Error(ERR_DROP, `LoadPNG: ${name}: ${decoded.reason}\n`);
    }
    ri.Con_Printf(PRINT_ALL, `Bad png file ${name}: ${decoded.reason}\n`);
    return result;
  }

  result.pic = decoded.image.pixels;
  result.width = decoded.image.width;
  result.height = decoded.image.height;
  return result;
}

/*
=========================================================
JPEG LOADING

No classic-engine precedent -- see qcommon/jpg.ts's own header comment for
why this exists (the rerelease retail pak ships 198 .jpg files, all under
vault/ and vault/preview/, none with a .png or .tga sibling; q2repro's own
texture-format probe chain is "png jpg tga", images.c:2258). Same
{pic, width, height} shape and top-down RGBA8 orientation as LoadPNG's own
result above, so GL_FindImage's ".jpg" branch below can call
`GL_LoadPic(name, pic, width, height, type, 32)` identically to its ".png"
branch. Progressive (SOF2) JPEGs decode successfully as of bb7825a
(qcommon/jpg.ts's own header covers the full baseline/progressive scan
model) -- only arithmetic-coded variants and non-8-bit precision remain
"recognized but unsupported" and take LoadPNG's own Sys_Error convention
for that failure class; "not a JPEG at all"/corrupt data mirrors
LoadPCX/LoadTGA/LoadPNG's Con_Printf + null-pic convention for a genuinely
bad/missing file.
=========================================================
*/
export function LoadJPG(name: string): { pic: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; width: number; height: number } = { pic: null, width: 0, height: 0 };

  const { data: buffer } = ri.FS_LoadFile(name);
  if (!buffer) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad jpg file ${name}\n`);
    return result;
  }

  const decoded = decodeJPG(buffer);
  ri.FS_FreeFile(buffer);

  if (!decoded.ok) {
    if (decoded.reason.startsWith("unsupported")) {
      ri.Sys_Error(ERR_DROP, `LoadJPG: ${name}: ${decoded.reason}\n`);
    }
    ri.Con_Printf(PRINT_ALL, `Bad jpg file ${name}: ${decoded.reason}\n`);
    return result;
  }

  result.pic = decoded.image.pixels;
  result.width = decoded.image.width;
  result.height = decoded.image.height;
  return result;
}

/*
=========================================================
BMP LOADING

No classic-engine precedent -- see qcommon/bmp.ts's own header comment
(Mike's scope-addition ruling 2026-08-31, "support as many image formats
as possible"; zero .bmp files exist in the real retail data, so this is
forward-looking format support, not a content-gap fix). Same
{pic, width, height} shape and top-down RGBA8 orientation as LoadPNG/
LoadJPG's own result above. "Recognized but unsupported variant"
(non-BI_RGB compression, exotic header size, 1/4/16-bit depth) mirrors
LoadPNG/LoadJPG's own Sys_Error convention; "not a BMP at all"/corrupt
data mirrors their Con_Printf + null-pic convention.
=========================================================
*/
export function LoadBMP(name: string): { pic: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; width: number; height: number } = { pic: null, width: 0, height: 0 };

  const { data: buffer } = ri.FS_LoadFile(name);
  if (!buffer) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad bmp file ${name}\n`);
    return result;
  }

  const decoded = decodeBMP(buffer);
  ri.FS_FreeFile(buffer);

  if (!decoded.ok) {
    if (decoded.reason.startsWith("unsupported")) {
      ri.Sys_Error(ERR_DROP, `LoadBMP: ${name}: ${decoded.reason}\n`);
    }
    ri.Con_Printf(PRINT_ALL, `Bad bmp file ${name}: ${decoded.reason}\n`);
    return result;
  }

  result.pic = decoded.image.pixels;
  result.width = decoded.image.width;
  result.height = decoded.image.height;
  return result;
}

/*
=========================================================
GIF LOADING

No classic-engine precedent -- see qcommon/gif.ts's own header comment
(same Mike ruling as LoadBMP above; zero .gif files exist in the real
retail data either). Same {pic, width, height} shape and top-down RGBA8
orientation as the other truecolor loaders above. GIF has no "recognized
but unsupported variant" class the way PNG/JPG/BMP do (every GIF87a/89a
still image this decoder recognizes, it fully decodes) -- every failure
reason is a "not a GIF at all"/corrupt-data case, so these loaders never
call Sys_Error, only the Con_Printf + null-pic/null convention.

LoadGIF (below) is first-frame-only, kept for whatever still calls it
directly by name; GL_LoadByExt's own "gif" case (this file's extension
dispatch table) calls LoadGIFFrames instead, so a multi-frame animated GIF
only decodes once per registration, not once for LoadGIF's own first-frame
read plus a second full decode for the remaining frames.
=========================================================
*/
export function LoadGIFFrames(name: string): { frames: { pic: Uint8Array; width: number; height: number }[] } | null {
  const { data: buffer } = ri.FS_LoadFile(name);
  if (!buffer) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad gif file ${name}\n`);
    return null;
  }

  const decoded = decodeGIF(buffer);
  ri.FS_FreeFile(buffer);

  if (!decoded.ok) {
    ri.Con_Printf(PRINT_ALL, `Bad gif file ${name}: ${decoded.reason}\n`);
    return null;
  }

  return { frames: decoded.frames.map((f) => ({ pic: f.pixels, width: f.width, height: f.height })) };
}

export function LoadGIF(name: string): { pic: Uint8Array | null; width: number; height: number } {
  const framesResult = LoadGIFFrames(name);
  if (!framesResult || framesResult.frames.length === 0) return { pic: null, width: 0, height: 0 };
  const first = framesResult.frames[0];
  return { pic: first.pic, width: first.width, height: first.height };
}

/*
====================================================================
IMAGE FLOOD FILLING
====================================================================
*/
const FLOODFILL_FIFO_SIZE = 0x1000;
const FLOODFILL_FIFO_MASK = FLOODFILL_FIFO_SIZE - 1;

function R_FloodFillSkin(skin: Uint8Array, skinwidth: number, skinheight: number): void {
  const fillcolor = skin[0]; // assume this is the pixel to fill
  const fifoX = new Int16Array(FLOODFILL_FIFO_SIZE);
  const fifoY = new Int16Array(FLOODFILL_FIFO_SIZE);
  let inpt = 0;
  let outpt = 0;
  let filledcolor = -1;

  if (filledcolor === -1) {
    filledcolor = 0;
    // attempt to find opaque black -- see header comment: this comparison
    // is ported literally, bug and all.
    for (let i = 0; i < 256; i++) {
      if (d_8to24table[i] === (255 << 0)) {
        filledcolor = i;
        break;
      }
    }
  }

  // can't fill to filled color or to transparent color (used as visited marker)
  if (fillcolor === filledcolor || fillcolor === 255) return;

  fifoX[inpt] = 0;
  fifoY[inpt] = 0;
  inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;

  while (outpt !== inpt) {
    const x = fifoX[outpt];
    const y = fifoY[outpt];
    let fdc = filledcolor;
    const posBase = x + skinwidth * y;
    outpt = (outpt + 1) & FLOODFILL_FIFO_MASK;

    const step = (off: number, dx: number, dy: number): void => {
      const v = skin[posBase + off];
      if (v === fillcolor) {
        skin[posBase + off] = 255;
        fifoX[inpt] = x + dx;
        fifoY[inpt] = y + dy;
        inpt = (inpt + 1) & FLOODFILL_FIFO_MASK;
      } else if (v !== 255) {
        fdc = v;
      }
    };

    if (x > 0) step(-1, -1, 0);
    if (x < skinwidth - 1) step(1, 1, 0);
    if (y > 0) step(-skinwidth, 0, -1);
    if (y < skinheight - 1) step(skinwidth, 0, 1);
    skin[posBase] = fdc;
  }
}

/*
================
GL_ResampleTexture
================
*/
export function GL_ResampleTexture(inData: Uint32Array, inwidth: number, inheight: number, outwidth: number, outheight: number): Uint32Array {
  const inBytes = uint32AsBytes(inData);
  const out = new Uint32Array(outwidth * outheight);
  const outBytes = uint32AsBytes(out);

  const fracstep = Math.floor((inwidth * 0x10000) / outwidth) >>> 0;
  const p1 = new Uint32Array(outwidth);
  const p2 = new Uint32Array(outwidth);

  let frac = fracstep >>> 2;
  for (let i = 0; i < outwidth; i++) {
    p1[i] = 4 * (frac >>> 16);
    frac = (frac + fracstep) >>> 0;
  }
  frac = (3 * (fracstep >>> 2)) >>> 0;
  for (let i = 0; i < outwidth; i++) {
    p2[i] = 4 * (frac >>> 16);
    frac = (frac + fracstep) >>> 0;
  }

  for (let i = 0; i < outheight; i++) {
    const inrowBase = inwidth * 4 * Math.trunc(((i + 0.25) * inheight) / outheight);
    const inrow2Base = inwidth * 4 * Math.trunc(((i + 0.75) * inheight) / outheight);
    frac = fracstep >>> 1;
    const outRowBase = i * outwidth * 4;
    for (let j = 0; j < outwidth; j++) {
      const pix1 = inrowBase + p1[j];
      const pix2 = inrowBase + p2[j];
      const pix3 = inrow2Base + p1[j];
      const pix4 = inrow2Base + p2[j];
      const o = outRowBase + j * 4;
      outBytes[o + 0] = (inBytes[pix1 + 0] + inBytes[pix2 + 0] + inBytes[pix3 + 0] + inBytes[pix4 + 0]) >>> 2;
      outBytes[o + 1] = (inBytes[pix1 + 1] + inBytes[pix2 + 1] + inBytes[pix3 + 1] + inBytes[pix4 + 1]) >>> 2;
      outBytes[o + 2] = (inBytes[pix1 + 2] + inBytes[pix2 + 2] + inBytes[pix3 + 2] + inBytes[pix4 + 2]) >>> 2;
      outBytes[o + 3] = (inBytes[pix1 + 3] + inBytes[pix2 + 3] + inBytes[pix3 + 3] + inBytes[pix4 + 3]) >>> 2;
    }
  }
  return out;
}

/*
================
GL_LightScaleTexture

Scale up the pixel values in a texture to increase the lighting range
================
*/
const intensitytable = new Uint8Array(256);
const gammatable = new Uint8Array(256);

function GL_LightScaleTexture(data: Uint32Array, width: number, height: number, only_gamma: boolean): void {
  const bytes = uint32AsBytes(data);
  const c = width * height;
  if (only_gamma) {
    for (let i = 0; i < c; i++) {
      const o = i * 4;
      bytes[o + 0] = gammatable[bytes[o + 0]];
      bytes[o + 1] = gammatable[bytes[o + 1]];
      bytes[o + 2] = gammatable[bytes[o + 2]];
    }
  } else {
    for (let i = 0; i < c; i++) {
      const o = i * 4;
      bytes[o + 0] = gammatable[intensitytable[bytes[o + 0]]];
      bytes[o + 1] = gammatable[intensitytable[bytes[o + 1]]];
      bytes[o + 2] = gammatable[intensitytable[bytes[o + 2]]];
    }
  }
}

/*
================
GL_MipMap

Operates in place, quartering the size of the texture
================
*/
function GL_MipMap(pixels: Uint8Array, width: number, height: number): void {
  const rowBytes = width << 2;
  const outHeight = height >>> 1;
  let inOff = 0;
  let outOff = 0;
  for (let i = 0; i < outHeight; i++, inOff += rowBytes) {
    for (let j = 0; j < rowBytes; j += 8, outOff += 4, inOff += 8) {
      pixels[outOff + 0] = (pixels[inOff + 0] + pixels[inOff + 4] + pixels[inOff + rowBytes + 0] + pixels[inOff + rowBytes + 4]) >>> 2;
      pixels[outOff + 1] = (pixels[inOff + 1] + pixels[inOff + 5] + pixels[inOff + rowBytes + 1] + pixels[inOff + rowBytes + 5]) >>> 2;
      pixels[outOff + 2] = (pixels[inOff + 2] + pixels[inOff + 6] + pixels[inOff + rowBytes + 2] + pixels[inOff + rowBytes + 6]) >>> 2;
      pixels[outOff + 3] = (pixels[inOff + 3] + pixels[inOff + 7] + pixels[inOff + rowBytes + 3] + pixels[inOff + rowBytes + 7]) >>> 2;
    }
  }
}

/*
===============
GL_BuildPalettedTexture
===============
*/
function GL_BuildPalettedTexture(paletted_texture: Uint8Array, scaled: Uint8Array, scaled_width: number, scaled_height: number): void {
  const table = gl_state.d_16to8table;
  if (!table) return; // only reachable once the paletted path has loaded 16to8.dat (see GL_InitImages)
  let si = 0;
  for (let i = 0; i < scaled_width * scaled_height; i++) {
    const r = (scaled[si + 0] >>> 3) & 31;
    const g = (scaled[si + 1] >>> 2) & 63;
    const b = (scaled[si + 2] >>> 3) & 31;
    const c = r | (g << 5) | (b << 11);
    paletted_texture[i] = table[c];
    si += 4;
  }
}

/*
===============
GL_Upload32

Returns has_alpha
===============
*/
// r_override_textures / r_texture_overrides, read by GL_NeedOverrideImage
// below. Held rather than looked up per image: GL_FindImage runs for every
// texture of every model of every map load.
let r_override_textures: CvarT | null = null;
let r_texture_overrides: CvarT | null = null;

let upload_width = 0;
let upload_height = 0;
let uploaded_paletted = false;

function setUploadTexParams(mipmap: boolean): void {
  if (mipmap) {
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_min);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
  } else {
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_max);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
  }
}

/*
GL_MakePowerOfTwo (q2repro src/refresh/texture.c:432-442), as a predicate.

Returns true when this upload must be rounded up to power-of-two dimensions
and resampled into them, false when it can go to the driver at its native
size. Vanilla always rounded; q2repro rounds only when the context lacks
QGL_CAP_TEXTURE_NON_POWER_OF_TWO.

MIPMAPPED IMAGES ARE HELD BACK HERE, and this is the one place this port does
not follow the reference. q2repro skips the resample for EVERY image type,
walls and skins included, because its NPOT capability and glGenerateMipmap are
granted by the same GL 3.0 tier (src/refresh/qgl.c:288-293), so its
GL_Upload32 can hand an odd-sized level 0 to the driver and let
qglGenerateMipmap build the chain (texture.c:538-540). This port has no
GenerateMipmap binding in qgl.ts at all, and its own GL_MipMap (above) halves
a level in place assuming EVEN dimensions -- `outHeight = height >>> 1` drops
the last row of an odd-height level, and the `j += 8` inner loop reads one
texel past the end of the last row pair of an odd-width one. Feeding it a
native-size 136x60 skin would therefore produce a corrupt mip chain, not a
sharper one.

So: native size for everything that needs no mip chain (it_pic -- the 2D pics,
the font atlases and RegisterRawPic's generated atlases, all of which call in
with mipmap=false), POT rounding for everything that does. Extending it to
walls/skins/sprites means adding a GenerateMipmap binding (or an odd-size-safe
GL_MipMap) first; it is a strictly larger change and it would move every one
of the 146 non-power-of-two model skins in the 1997 baseq2 pak0, so it is
deliberately not bundled in here.
*/
function GL_MustMakePowerOfTwo(mipmap: boolean): boolean {
  if (mipmap) return true;
  return !gl_config.npot;
}

function GL_Upload32(data: Uint32Array, width: number, height: number, mipmap: boolean): boolean {
  uploaded_paletted = false;

  const makePot = GL_MustMakePowerOfTwo(mipmap);

  // Already power-of-two on both axes is the same arithmetic either way (the
  // rounding loops below are no-ops on such a size), so nothing that was
  // power-of-two before -- conchars.pcx, every .wal, the lightmaps -- changes
  // behavior at all; only genuinely non-power-of-two images take a new path.
  let scaled_width = makePot ? 1 : width;
  if (makePot) {
    while (scaled_width < width) scaled_width <<= 1;
    if (glCvars.gl_round_down && glCvars.gl_round_down.value && scaled_width > width && mipmap) scaled_width >>>= 1;
  }

  let scaled_height = makePot ? 1 : height;
  if (makePot) {
    while (scaled_height < height) scaled_height <<= 1;
    if (glCvars.gl_round_down && glCvars.gl_round_down.value && scaled_height > height && mipmap) scaled_height >>>= 1;
  }

  // let people sample down the world textures for speed
  if (mipmap) {
    const picmip = glCvars.gl_picmip ? glCvars.gl_picmip.value : 0;
    scaled_width >>>= picmip;
    scaled_height >>>= picmip;
  }

  // Vanilla: "don't ever bother with >256 textures". The cap is now the
  // driver's GL_MAX_TEXTURE_SIZE (gl_config.max_texture_size, 256 until
  // queried), as the reference clamps, so the re-release's 512x256 md5
  // skins and any high-resolution replacement upload at full size.
  const maxSize = gl_config.max_texture_size > 0 ? gl_config.max_texture_size : 256;
  if (scaled_width > maxSize) scaled_width = maxSize;
  if (scaled_height > maxSize) scaled_height = maxSize;
  if (scaled_width < 1) scaled_width = 1;
  if (scaled_height < 1) scaled_height = 1;

  upload_width = scaled_width;
  upload_height = scaled_height;


  // scan the texture for any non-255 alpha
  const dataBytes = uint32AsBytes(data);
  const c = width * height;
  let samples = gl_solid_format;
  for (let i = 0; i < c; i++) {
    if (dataBytes[i * 4 + 3] !== 255) {
      samples = gl_alpha_format;
      break;
    }
  }

  let comp: number;
  if (samples === gl_solid_format) comp = gl_tex_solid_format;
  else if (samples === gl_alpha_format) comp = gl_tex_alpha_format;
  else {
    ri.Con_Printf(PRINT_ALL, `Unknown number of texture components ${samples}\n`);
    comp = samples;
  }

  const wantPaletted = (): boolean => Boolean(qgl.qglColorTableEXT && glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value && samples === gl_solid_format);

  if (scaled_width === width && scaled_height === height && !mipmap) {
    if (wantPaletted()) {
      uploaded_paletted = true;
      const palettedTexture = new Uint8Array(scaled_width * scaled_height);
      GL_BuildPalettedTexture(palettedTexture, dataBytes, scaled_width, scaled_height);
      qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, scaled_width, scaled_height, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, palettedTexture);
    } else {
      qgl.qglTexImage2D(GL_TEXTURE_2D, 0, comp, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, data);
    }
    setUploadTexParams(mipmap);
    return samples === gl_alpha_format;
  }

  let scaled: Uint32Array;
  if (scaled_width === width && scaled_height === height) {
    scaled = data.slice(0, width * height);
  } else {
    scaled = GL_ResampleTexture(data, width, height, scaled_width, scaled_height);
  }

  GL_LightScaleTexture(scaled, scaled_width, scaled_height, !mipmap);
  const scaledBytes = uint32AsBytes(scaled);

  if (wantPaletted()) {
    uploaded_paletted = true;
    const palettedTexture = new Uint8Array(scaled_width * scaled_height);
    GL_BuildPalettedTexture(palettedTexture, scaledBytes, scaled_width, scaled_height);
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, scaled_width, scaled_height, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, palettedTexture);
  } else {
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, comp, scaled_width, scaled_height, 0, GL_RGBA, GL_UNSIGNED_BYTE, scaled);
  }

  if (mipmap) {
    let miplevel = 0;
    let sw = scaled_width;
    let sh = scaled_height;
    while (sw > 1 || sh > 1) {
      GL_MipMap(scaledBytes, sw, sh);
      sw >>>= 1;
      sh >>>= 1;
      if (sw < 1) sw = 1;
      if (sh < 1) sh = 1;
      miplevel++;
      if (wantPaletted()) {
        uploaded_paletted = true;
        const palettedTexture = new Uint8Array(sw * sh);
        GL_BuildPalettedTexture(palettedTexture, scaledBytes, sw, sh);
        qgl.qglTexImage2D(GL_TEXTURE_2D, miplevel, GL_COLOR_INDEX8_EXT, sw, sh, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, palettedTexture);
      } else {
        qgl.qglTexImage2D(GL_TEXTURE_2D, miplevel, comp, sw, sh, 0, GL_RGBA, GL_UNSIGNED_BYTE, scaled);
      }
    }
  }

  setUploadTexParams(mipmap);
  return samples === gl_alpha_format;
}

/*
===============
GL_Upload8

Returns has_alpha
===============
*/
export function GL_Upload8(data: Uint8Array, width: number, height: number, mipmap: boolean, is_sky: boolean): boolean {
  const s = width * height;
  // Vanilla's check here (`s > 512*256`) guarded a fixed-size C stack array
  // (`unsigned trans[512*256]`, ref_gl/gl_image.c:1167) -- a stack-frame
  // budget accident, not a real GL limit: vanilla's own game content never
  // shipped an 8-bit texture/sky face anywhere near that size, so the cap
  // was never exercised. This port's `trans` (below) is a `new Uint32Array(s)`
  // allocated to the real input size, not a fixed buffer, so that vanilla
  // constraint doesn't apply here at all. Real "Call of the Machine" rerelease
  // content (mgu6m2.bsp/mgu6m3.bsp) legitimately ships an 8-bit texture
  // bigger than 512*256=131072 texels and tripped this vestigial cap.
  // q2repro has no equivalent GL_Upload8 at all -- it unpacks 8-bit source
  // images through IMG_Unpack8 (src/refresh/images.c) with no size check of
  // its own, then lets the normal upload path clamp/resample to the actual
  // GPU limit (GL_ClampTextureSize against gl_config.max_texture_size,
  // src/refresh/texture.c:446). This port's GL_Upload32 below already does
  // the equivalent unconditional clamp-and-resample down to <=256x256
  // (`scaled_width`/`scaled_height`, further down in this file) regardless
  // of input size, so removing this check doesn't skip any real bound --
  // it just stops rejecting valid input before GL_Upload32 gets to run its
  // own (already-correct) downscale. What's kept is a sanity ceiling against
  // corrupted/malicious dimensions, sized to q2repro's own general image
  // sanity bound (images.h: `#define MAX_TEXTURE_SIZE 8192`, used the same
  // way by every one of its image loaders).
  const MAX_TEXTURE_SIZE = 8192;
  if (width > MAX_TEXTURE_SIZE || height > MAX_TEXTURE_SIZE) {
    ri.Sys_Error(ERR_DROP, "GL_Upload8: too large");
  }

  if (qgl.qglColorTableEXT && glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value && is_sky) {
    qgl.qglTexImage2D(GL_TEXTURE_2D, 0, GL_COLOR_INDEX8_EXT, width, height, 0, GL_COLOR_INDEX, GL_UNSIGNED_BYTE, data);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, gl_filter_max);
    qgl.qglTexParameterf(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, gl_filter_max);
    return false; // see header comment: the original has no return here (UB)
  }

  const trans = new Uint32Array(s);
  const transBytes = uint32AsBytes(trans);
  const paletteBytes = uint32AsBytes(d_8to24table);

  for (let i = 0; i < s; i++) {
    let p = data[i];
    trans[i] = d_8to24table[p];

    if (p === 255) {
      // transparent, so scan around for another color to avoid alpha
      // fringes. FIXME (original): do a full flood fill so mips work...
      if (i > width && data[i - width] !== 255) p = data[i - width];
      else if (i < s - width && data[i + width] !== 255) p = data[i + width];
      else if (i > 0 && data[i - 1] !== 255) p = data[i - 1];
      else if (i < s - 1 && data[i + 1] !== 255) p = data[i + 1];
      else p = 0;
      // copy rgb components
      transBytes[i * 4 + 0] = paletteBytes[p * 4 + 0];
      transBytes[i * 4 + 1] = paletteBytes[p * 4 + 1];
      transBytes[i * 4 + 2] = paletteBytes[p * 4 + 2];
    }
  }

  return GL_Upload32(trans, width, height, mipmap);
}

/*
================
GL_LoadPic

This is also used as an entry point for the generated r_notexture
================
*/
export function GL_LoadPic(name: string, pic: Uint8Array, width: number, height: number, type: ImagetypeT, bits: number): ImageT {
  // find a free image_t
  let i = 0;
  for (; i < numgltextures; i++) {
    if (!gltextures[i].texnum) break;
  }
  if (i === numgltextures) {
    if (numgltextures === MAX_GLTEXTURES) {
      ri.Sys_Error(ERR_DROP, "MAX_GLTEXTURES");
    }
    SetNumGltextures(numgltextures + 1);
  }
  const image = gltextures[i];

  if (name.length >= MAX_QPATH) {
    ri.Sys_Error(ERR_DROP, `Draw_LoadPic: "${name}" is too long`);
  }
  image.name = name;
  image.registration_sequence = registration_sequence;

  image.width = width;
  image.height = height;
  image.type = type;

  if (type === ImagetypeT.it_skin && bits === 8) {
    R_FloodFillSkin(pic, width, height);
  }

  // load little pics into the scrap
  let scrapHandled = false;
  if (image.type === ImagetypeT.it_pic && bits === 8 && image.width < 64 && image.height < 64) {
    const alloc = Scrap_AllocBlock(image.width, image.height);
    if (alloc.texnum !== -1) {
      scrap_dirty = true;

      // copy the texels into the scrap block
      let k = 0;
      for (let yy = 0; yy < image.height; yy++) {
        for (let xx = 0; xx < image.width; xx++, k++) {
          scrap_texels[alloc.texnum][(alloc.y + yy) * BLOCK_WIDTH + alloc.x + xx] = pic[k];
        }
      }
      image.texnum = TEXNUM_SCRAPS + alloc.texnum;
      image.scrap = true;
      image.has_alpha = true;
      image.sl = (alloc.x + 0.01) / BLOCK_WIDTH;
      image.sh = (alloc.x + image.width - 0.01) / BLOCK_WIDTH;
      image.tl = (alloc.y + 0.01) / BLOCK_WIDTH;
      image.th = (alloc.y + image.height - 0.01) / BLOCK_WIDTH;
      scrapHandled = true;
    }
  }

  if (!scrapHandled) {
    image.scrap = false;
    image.texnum = TEXNUM_IMAGES + i;
    GL_Bind(image.texnum);
    if (bits === 8) {
      image.has_alpha = GL_Upload8(pic, width, height, image.type !== ImagetypeT.it_pic && image.type !== ImagetypeT.it_sky, image.type === ImagetypeT.it_sky);
    } else {
      image.has_alpha = GL_Upload32(bytesToUint32Copy(pic, width * height), width, height, image.type !== ImagetypeT.it_pic && image.type !== ImagetypeT.it_sky);
    }
    image.upload_width = upload_width; // after power of 2 and scales
    image.upload_height = upload_height;
    image.paletted = uploaded_paletted;
    image.sl = 0;
    image.sh = 1;
    image.tl = 0;
    image.th = 1;
  }

  return image;
}

/*
================
GL_LoadWal
================
*/
const WAL_WIDTH_OFFSET = 32;
const WAL_HEIGHT_OFFSET = 36;
const WAL_OFFSET0_OFFSET = 40;

function GL_LoadWal(name: string): ImageT | null {
  const { data: mt } = ri.FS_LoadFile(name);
  if (!mt) {
    // PRINT_DEVELOPER, matching every other per-extension loader's own
    // "file doesn't exist" print (LoadPCX/LoadTGA/LoadPNG/LoadJPG above) --
    // GL_FindImage now retries with the other supported extensions on a
    // miss (see its own header comment), so a visible PRINT_ALL warning
    // here would fire on every intermediate candidate a fallback later
    // resolves, not just a genuine total failure. GL_FindImage itself
    // prints the user-visible warning once, only if every candidate misses.
    ri.Con_Printf(PRINT_DEVELOPER, `Bad wal file ${name}\n`);
    return null;
  }

  // Same truncation guard as LoadPCX above: a .wal shorter than the header
  // fields read here would make the DataView reads throw instead of being
  // reported as a bad file.
  if (mt.byteLength < WAL_OFFSET0_OFFSET + 4) {
    ri.Con_Printf(PRINT_DEVELOPER, `Bad wal file ${name}\n`);
    ri.FS_FreeFile(mt);
    return null;
  }

  const view = new DataView(mt.buffer, mt.byteOffset, mt.byteLength);
  const width = LittleLong(view.getUint32(WAL_WIDTH_OFFSET, true));
  const height = LittleLong(view.getUint32(WAL_HEIGHT_OFFSET, true));
  const ofs = LittleLong(view.getUint32(WAL_OFFSET0_OFFSET, true));

  const image = GL_LoadPic(name, mt.subarray(ofs), width, height, ImagetypeT.it_wall, 8);

  ri.FS_FreeFile(mt);

  return image;
}

// The eight extensions GL_FindImage can decode -- GL is the only renderer
// with a real TGA decoder (LoadTGA above); ref_soft's R_FindImage has no
// TGA support at all (see r_image.ts's own header comment) and passes a
// seven-entry set to imageExtCandidates instead.
const GL_SUPPORTED_EXTS: readonly ImgExtT[] = ["pcx", "wal", "tga", "png", "jpg", "jpeg", "bmp", "gif"];

// Extension string (no leading dot, e.g. "jpeg" not ".jpeg") -> ImgExtT.
// A plain lookup rather than a fixed-length suffix slice: ".jpeg" is 5
// characters, unlike every other recognized extension's 3, so the caller
// must find the extension by the name's last "." rather than assuming a
// fixed suffix length (see GL_FindImage below).
function glExtOf(ext: string): ImgExtT | null {
  switch (ext) {
    case "pcx":
      return "pcx";
    case "wal":
      return "wal";
    case "tga":
      return "tga";
    case "png":
      return "png";
    case "jpg":
      return "jpg";
    case "jpeg":
      return "jpeg";
    case "bmp":
      return "bmp";
    case "gif":
      return "gif";
    default:
      return null;
  }
}

// Loads `name` (already known to end in `.${ext}`) through the loader for
// that one extension. Always returns null (never a placeholder image) on
// failure -- GL_FindImage's caller decides what a total miss across every
// candidate in the fallback chain becomes.
function GL_LoadByExt(name: string, ext: ImgExtT, type: ImagetypeT): ImageT | null {
  switch (ext) {
    case "pcx": {
      const { pic, width, height } = LoadPCX(name);
      if (!pic) return null;
      return GL_LoadPic(name, pic, width, height, type, 8);
    }
    case "wal":
      return GL_LoadWal(name);
    case "tga": {
      const { pic, width, height } = LoadTGA(name);
      if (!pic) return null;
      return GL_LoadPic(name, pic, width, height, type, 32);
    }
    case "png": {
      const { pic, width, height } = LoadPNG(name);
      if (!pic) return null;
      return GL_LoadPic(name, pic, width, height, type, 32);
    }
    case "jpg":
    case "jpeg": {
      // ".jpeg" is a pure filename-spelling alias -- same decoder, same
      // bit depth, as ".jpg" (see img_resolve.ts's own header comment).
      const { pic, width, height } = LoadJPG(name);
      if (!pic) return null;
      return GL_LoadPic(name, pic, width, height, type, 32);
    }
    case "bmp": {
      const { pic, width, height } = LoadBMP(name);
      if (!pic) return null;
      return GL_LoadPic(name, pic, width, height, type, 32);
    }
    case "gif": {
      // Multi-frame registration -- see gl_local.ts's ImageT.gifFrames doc
      // comment and qcommon/gif.ts's own header comment for the design.
      // Every composited frame becomes its OWN GL texture (frame 0 under
      // `name` itself, exactly as a single-frame GIF always has been;
      // frames 1+ under a derived name), so GL_LoadPic's existing
      // scrap/upload logic needs no changes at all -- this just calls it
      // once per frame. Restricted to `ImagetypeT.it_pic`: 3D uses (wall
      // textures, skins) stay first-frame-only by ruling, so this whole
      // extra-frames branch is simply skipped for them.
      const framesResult = LoadGIFFrames(name);
      if (!framesResult || framesResult.frames.length === 0) return null;
      const first = framesResult.frames[0];
      const image = GL_LoadPic(name, first.pic, first.width, first.height, type, 32);
      if (type === ImagetypeT.it_pic && framesResult.frames.length > 1) {
        // Guard against MAX_QPATH overflow on the derived per-frame name
        // (GL_LoadPic Sys_Error's on a too-long name) -- if even the
        // largest frame index wouldn't fit, skip multi-frame registration
        // entirely rather than wiring a partial/inconsistent frame set;
        // the caller still gets frame 0, exactly like every other GIF.
        const suffixBudget = `#gifframe${framesResult.frames.length}`.length;
        if (name.length + suffixBudget < MAX_QPATH) {
          const gifFrames: ImageT[] = [image];
          for (let i = 1; i < framesResult.frames.length; i++) {
            const f = framesResult.frames[i];
            gifFrames.push(GL_LoadPic(`${name}#gifframe${i}`, f.pic, f.width, f.height, type, 32));
          }
          image.gifFrames = gifFrames;
        }
      }
      return image;
    }
  }
}

/*
================
Glow maps (q2repro src/refresh/images.c:1857-1911, check_for_glow_map)

The rerelease data ships an emissive "glow map" next to many skins and wall
textures: strip the extension, append "_glow", and load whatever image format
is actually present -- 1580 of them in rerelease baseq2/pak0.pak (1248 under
textures/, 328 under models/, 4 under players/; 1568 .png and 12 .tga). The
1997 data ships none at all, so nothing below ever fires on that tree.

The reference resolves the glow exactly the way it resolves any other image
(load_image_data with the override-format search), which is what this port's
own imageExtCandidates chain already does, so the same helper is reused here
rather than hardcoding ".png".

Two DIFFERENT post-processing rules, straight from images.c:1893-1902 and its
comment ("model glowmaps should be premultiplied / wal glowmaps just use the
alpha, so the RGB channels are ignored"). Both are load-bearing, and the data
confirms both:

  - IT_SKIN: RGB carries a real emissive colour and alpha is the mask, but the
    RGB OUTSIDE the mask is not zero -- models/monsters/soldier/md5/skin_glow.png
    has 57706 pixels with alpha 0 and non-zero RGB (mean max-channel 34). Added
    unpremultiplied, that garbage would wash additive light across the entire
    model. Premultiplying by alpha zeroes it, and makes the texture directly
    usable as the source of a plain GL_ONE/GL_ONE additive pass -- which is
    precisely the reference's `diffuse.rgb += glowmap.rgb * u_intensity2`
    (shader.c:698-704, the non-lightmapped branch).

  - IT_WALL: the RGB is meaningless -- every wall glow map sampled is pure
    (255,255,255) wherever alpha is significant (checked textures/e1u1/
    baselt_1_glow.png, alarm0_glow.png, bluekeypad_glow.png). Only the alpha
    matters, and the reference uses it to drive the LIT texel toward
    fullbright: `lightmap.rgb = mix(lightmap.rgb, vec3(1.0), glowmap.a)`
    before `diffuse.rgb *= lightmap.rgb` (shader.c:660-676). The emissive
    result is therefore the wall texture's OWN colour at full brightness, not
    white. A single-texture fixed-function pass cannot multiply two textures
    together at draw time, so the product is baked here instead: the glow
    texture uploaded for a wall is `diffuse.rgb * glow.a`, sampled
    nearest-neighbour when the two images differ in size. gl_rsurf.ts then
    adds it with GL_ONE_MINUS_DST_COLOR/GL_ONE -- see R_DrawGlowmaps' own
    comment for why that factor and how close it lands to the reference lerp.

Deliberate deviation: q2repro refuses to load glow maps at all unless
gl_shaders is on ("not supported in legacy mode due to various corner cases
that are not worth taking care of", images.c:1865-1868). That gate exists
because its legacy path has no glow support; THIS renderer's glow support is
the fixed-function multi-pass one, so gating it on gl_shaders would disable
the only implementation there is. r_glowmaps alone gates it here.
================
*/

// Decodes one candidate glow file to straight (non-premultiplied) RGBA8.
// Returns null for any format that cannot carry a glow map's alpha channel
// (.wal has no alpha at all) or that this port only supports as a pic (.gif
// -- multi-frame registration, see GL_LoadByExt), and for a plain miss.
function GL_LoadGlowRgba(name: string, ext: ImgExtT): { pic: Uint8Array; width: number; height: number } | null {
  switch (ext) {
    case "wal":
    case "gif":
      return null;
    case "pcx": {
      // No retail glow map is a .pcx (the census above is png/tga only), but
      // the reference's own final fallback is IM_PCX, so the path exists.
      //
      // Expanded through d_8to24table, NOT the .pcx file's own palette --
      // that is what GL_Upload8 does for every 8-bit image this renderer
      // uploads, so a .pcx read back here matches the colours it would
      // actually be drawn with. Entry 255 already carries alpha 0 in that
      // table (Draw_GetPalette clears it), which is Quake's transparent
      // index, so the alpha comes straight out of the table too.
      const { pic, width, height } = LoadPCX(name);
      if (!pic) return null;
      const out = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = d_8to24table[pic[i]];
        out[i * 4 + 0] = v & 0xff;
        out[i * 4 + 1] = (v >>> 8) & 0xff;
        out[i * 4 + 2] = (v >>> 16) & 0xff;
        out[i * 4 + 3] = (v >>> 24) & 0xff;
      }
      return { pic: out, width, height };
    }
    case "tga": {
      const { pic, width, height } = LoadTGA(name);
      return pic ? { pic, width, height } : null;
    }
    case "png": {
      const { pic, width, height } = LoadPNG(name);
      return pic ? { pic, width, height } : null;
    }
    case "jpg":
    case "jpeg": {
      const { pic, width, height } = LoadJPG(name);
      return pic ? { pic, width, height } : null;
    }
    case "bmp": {
      const { pic, width, height } = LoadBMP(name);
      return pic ? { pic, width, height } : null;
    }
  }
}

// Re-decodes an already-loaded image's own file back to RGBA8, for the wall
// bake above. Cheaper alternatives (threading the pixels out of GL_LoadByExt)
// would push a decode-time buffer through every caller for the sake of the
// minority of images that have a glow map at all; re-reading the handful that
// do keeps the change to one function. Returns null when the source is 8-bit
// .wal (no glow map in any retail tree is paired with a .wal diffuse).
function GL_DiffuseRgba(image: ImageT): { pic: Uint8Array; width: number; height: number } | null {
  const dot = image.name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = glExtOf(image.name.slice(dot + 1));
  if (ext === null) return null;
  return GL_LoadGlowRgba(image.name, ext);
}

export function GL_CheckForGlowMap(image: ImageT): void {
  if (image.glow) return;
  if (image.type !== ImagetypeT.it_skin && image.type !== ImagetypeT.it_wall) return;
  if (!glCvars.r_glowmaps || !glCvars.r_glowmaps.value) return;

  const dot = image.name.lastIndexOf(".");
  if (dot <= 0) return;
  const requestedExt = glExtOf(image.name.slice(dot + 1));
  if (requestedExt === null) return;

  const glowBase = `${image.name.slice(0, dot)}_glow`;
  if (glowBase.length + 5 >= MAX_QPATH) return; // longest extension is ".jpeg"

  const isWall = image.type === ImagetypeT.it_wall;
  for (const ext of imageExtCandidates(requestedExt, isWall, GL_SUPPORTED_EXTS)) {
    const candidateName = `${glowBase}.${ext}`;

    // Same exact-name cache probe GL_FindImage uses, for the same reason:
    // without it an animated wall texture's shared glow map would burn a
    // fresh gltextures slot on every registration.
    let cached: ImageT | null = null;
    for (let i = 0; i < numgltextures; i++) {
      if (gltextures[i].name === candidateName) {
        cached = gltextures[i];
        break;
      }
    }
    if (cached) {
      cached.registration_sequence = registration_sequence;
      image.glow = cached;
      return;
    }

    const loaded = GL_LoadGlowRgba(candidateName, ext);
    if (!loaded) continue;

    const { pic, width, height } = loaded;
    const count = width * height;

    if (isWall) {
      // Bake diffuse.rgb * glow.a (see the header comment above).
      const diffuse = GL_DiffuseRgba(image);
      for (let i = 0; i < count; i++) {
        const a = pic[i * 4 + 3] / 255;
        let dr = 255;
        let dg = 255;
        let db = 255;
        if (diffuse) {
          // Nearest-neighbour: retail pairs are the same size, but nothing
          // guarantees a replacement texture is.
          const x = Math.min(diffuse.width - 1, ((i % width) * diffuse.width / width) | 0);
          const y = Math.min(diffuse.height - 1, (((i / width) | 0) * diffuse.height / height) | 0);
          const d = (y * diffuse.width + x) * 4;
          dr = diffuse.pic[d + 0];
          dg = diffuse.pic[d + 1];
          db = diffuse.pic[d + 2];
        }
        pic[i * 4 + 0] = (dr * a) | 0;
        pic[i * 4 + 1] = (dg * a) | 0;
        pic[i * 4 + 2] = (db * a) | 0;
      }
    } else {
      // IT_SKIN: premultiply (images.c:1893-1902).
      for (let i = 0; i < count; i++) {
        const a = pic[i * 4 + 3] / 255;
        pic[i * 4 + 0] = (pic[i * 4 + 0] * a) | 0;
        pic[i * 4 + 1] = (pic[i * 4 + 1] * a) | 0;
        pic[i * 4 + 2] = (pic[i * 4 + 2] * a) | 0;
      }
    }

    image.glow = GL_LoadPic(candidateName, pic, width, height, image.type, 32);
    return;
  }
}

/*
================
GL_RecoverLogicalDimensions
(q2repro src/refresh/images.c:1693-1727, get_image_dimensions, called from
load_image_data at images.c:1843-1846 under its own comment: "if we are
replacing 8-bit texture with a higher resolution 32-bit texture, we need to
recover original image dimensions".)

ImageT.width/height are the image's LOGICAL size -- the size the rest of the
renderer reasons in -- while upload_width/height are what actually reached the
driver after power-of-two rounding and picmip. For almost everything the two
can diverge harmlessly, because texture coordinates are normalized 0..1 by the
time they are used:

  - MD2 skins: the .md2's glcmds store s,t ALREADY divided by the header's
    skinwidth/skinheight at model-compile time; GL_DrawAliasFrameLerp passes
    them to qglTexCoord2f untouched. gl_model.ts reads skinwidth/skinheight
    only to range-check against MAX_LBM_HEIGHT -- they reach no draw call.
  - MD5 skins: the .md5mesh stores normalized s,t directly (verified across
    all 138 md5 meshes in rerelease baseq2/pak0.pak).
  - Sprites: gl_rmain.ts's R_DrawSpriteModel emits hardcoded 0/1 texture
    coordinates and sizes the quad from the .sp2 frame's own width/height
    (gl_model.ts's Mod_LoadSpriteModel), never from the loaded image.
  - Pics: gl_draw.ts draws from the normalized sl/sh/tl/th span (the scrap
    atlas fractions, or 0..1), and uses width/height only for on-screen size,
    which SHOULD track the logical size so a replacement pic occupies the
    same space rather than doubling.
  - Sky and warp surfaces: gl_warp.ts derives no scale from image dimensions.

The one exception is the world. gl_rsurf.ts's GL_BuildPolygonFromSurface
divides the BSP texinfo projection by image.width/height (`s /= image.width`),
because a BSP's texinfo vectors are in the ORIGINAL texture's texel units. So
for a wall, image.width must stay the size the map was compiled against, no
matter what file actually got uploaded.

That only matters when the extension-fallback chain resolves a request for an
8-bit .pcx/.wal to a 32-bit .png/.jpg/.tga/.bmp of a DIFFERENT size, which is
what a drop-in high-resolution texture pack is. This restores the logical size
from the original 8-bit file's header when that file is still present, exactly
as the reference does; upload_width/height keep the real uploaded size, so the
extra resolution is still used, just not misinterpreted as a different
mapping.
================
*/
const WAL_HEADER_BYTES = 40; // name[32] + width + height, the fields read below
const PCX_HEADER_BYTES = 12; // manufacturer..ymax, the fields read below
// Sanity bound on a recovered logical size. Stands in for the reference's
// check_image_size (images.c:1722); generous on purpose, since this only has
// to reject a header that did not parse, not enforce a texture budget.
const MAX_LOGICAL_DIMENSION = 8192;

function GL_RecoverLogicalDimensions(image: ImageT, originalName: string, originalExt: ImgExtT): void {
  if (originalExt !== "pcx" && originalExt !== "wal") return;

  const { data } = ri.FS_LoadFile(originalName);
  if (!data) return;

  let w = 0;
  let h = 0;
  if (originalExt === "wal") {
    if (data.length >= WAL_HEADER_BYTES) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      w = LittleLong(view.getUint32(WAL_WIDTH_OFFSET, true));
      h = LittleLong(view.getUint32(WAL_HEIGHT_OFFSET, true));
    }
  } else if (data.length >= PCX_HEADER_BYTES) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const xmin = view.getUint16(4, true);
    const ymin = view.getUint16(6, true);
    const xmax = view.getUint16(8, true);
    const ymax = view.getUint16(10, true);
    w = xmax - xmin + 1;
    h = ymax - ymin + 1;
  }

  ri.FS_FreeFile(data);

  // check_image_size (images.c:1722) -- reject a header that did not parse
  // into something sane rather than poisoning the projection with a zero.
  if (w <= 0 || h <= 0 || w > MAX_LOGICAL_DIMENSION || h > MAX_LOGICAL_DIMENSION) return;

  image.width = w;
  image.height = h;
}

/*
===============
GL_FindImage

Finds or loads the given image
===============
*/
/*
===============
GL_NeedOverrideImage

need_override_image (q2repro src/refresh/images.c:1777-1784):

    if (r_override_textures->integer < 1)         return false;
    if (r_override_textures->integer == 1 && fmt > IM_WAL) return false;
    return r_texture_overrides->integer & (1 << type);

r_override_textures (default "1", images.c:2257) is what makes a player's
higher-resolution drop-in actually win over the original asset still sitting
in a .pak: at 1 the truecolor formats are probed first whenever the request
itself named an 8-bit format (.pcx/.wal), at 2 they are probed first even when
the request already named a truecolor one, and at 0 the feature is off and the
literally-requested extension is tried first exactly as this port did before.

r_texture_overrides (default "-1", images.c:2261) is a per-image-type bitmask
over imagetype_t, so a player can restrict overrides to, say, walls only. Both
cvars are CVAR_FILES in the C; both are already registered in this file's
R_Register-equivalent, this is the reader that finally makes them mean
something.

The one shape difference: q2repro's imagetype_t and this port's ImagetypeT are
separate enums (PORTING.md's per-file port convention), so the bit tested is
this port's own ImagetypeT ordinal. The default -1 sets every bit either way,
so the default behavior is identical and only a hand-set bitmask could differ
in which types it names.
===============
*/
function GL_NeedOverrideImage(type: ImagetypeT, requestedExt: ImgExtT): boolean {
  const level = r_override_textures ? r_override_textures.value : 0;
  if (level < 1) return false;
  const requestedIs8Bit = requestedExt === "pcx" || requestedExt === "wal";
  if (level === 1 && !requestedIs8Bit) return false;
  const mask = r_texture_overrides ? r_texture_overrides.value : -1;
  return (mask & (1 << type)) !== 0;
}

export function GL_FindImage(name: string, type: ImagetypeT): ImageT | null {
  if (!name) return null;
  const len = name.length;
  if (len < 5) return null;

  // look for it
  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (name === image.name) {
      image.registration_sequence = registration_sequence;
      // MOD_Reference's own rule (q2repro src/refresh/models.c:1459-1464):
      // a still-referenced image keeps its glow map alive with it, or
      // GL_FreeUnusedImages would delete the glow texture out from under a
      // skin that is still being drawn.
      if (image.glow) image.glow.registration_sequence = registration_sequence;
      return image;
    }
  }

  //
  // load the pic from disk, retrying with q2repro's other supported
  // extensions on a miss (q2repro src/refresh/images.c: load_image_data
  // 1819-1855, try_other_formats 1669-1691 -- see qcommon/img_resolve.ts's
  // own header comment for the full citation and the one documented
  // ordering deviation). try_replace_ext REPLACES the extension in place
  // (images.c:1661-1666), never appends -- the double-extension bug this
  // port already fixed at ad6fb29 ("pics/sprites/flare_01.tga.pcx").
  //
  // Every image class routes through this one function (skins/pics/sprite
  // frames call GL_FindImage or R_RegisterSkin -> GL_FindImage directly;
  // wall textures via gl_model.ts's Mod_LoadTexinfo), so the fallback
  // chain below covers all of them without any caller-side change.
  //
  // Extension found by the LAST "." rather than a fixed suffix length --
  // ".jpeg" is 5 characters, unlike every other recognized extension's 3
  // (q2repro itself has no baselen-and-a-fixed-suffix constant either;
  // find_or_load_image derives baselen from COM_FileExtension the same
  // way, images.c:1931).
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a bare "." with no base name
  const requestedExt = glExtOf(name.slice(dot + 1));
  if (requestedExt === null) return null;

  const base = name.slice(0, dot);
  const isWall = type === ImagetypeT.it_wall;
  const candidates = imageExtCandidates(requestedExt, isWall, GL_SUPPORTED_EXTS, GL_NeedOverrideImage(type, requestedExt));

  for (const ext of candidates) {
    const candidateName = ext === requestedExt ? name : `${base}.${ext}`;
    // The cache probe above only saw the name as the CALLER spelled it, and
    // GL_LoadPic records whichever extension actually resolved -- so an image
    // that came in through this fallback chain is never found again on the
    // next lookup, and each lookup burns a fresh gltextures slot.
    // SCR_DrawCrosshair asks for pics/ch1.pcx every single frame and the
    // retail file is pics/ch1.png: ~570 frames in, "ERROR: MAX_GLTEXTURES".
    // q2repro has no such hole because its lookup_image keys the cache on the
    // BASE name (src/refresh/images.c: baselen/memcmp, hashed on the base),
    // matching regardless of extension; probing each candidate against the
    // same exact-name cache this function already uses gets the same result
    // without changing what "already loaded" means anywhere else.
    if (ext !== requestedExt) {
      for (let i = 0; i < numgltextures; i++) {
        const cached = gltextures[i];
        if (candidateName === cached.name) {
          cached.registration_sequence = registration_sequence;
          if (cached.glow) cached.glow.registration_sequence = registration_sequence;
          return cached;
        }
      }
    }
    const image = GL_LoadByExt(candidateName, ext, type);
    if (image) {
      // A request for an 8-bit .pcx/.wal that the fallback chain satisfied
      // with a 32-bit file of another size keeps the ORIGINAL file's logical
      // dimensions, when that file is still on disk (images.c:1843-1846).
      if (ext !== requestedExt) GL_RecoverLogicalDimensions(image, name, requestedExt);
      // images.c:2004-2006 -- checked right after a successful load, for
      // skins and walls only.
      GL_CheckForGlowMap(image);
      return image;
    }
  }

  // Every candidate missed. Vanilla GL_FindImage's own ".wal" branch always
  // fell back to r_notexture directly on a miss (there was no fallback
  // chain to exhaust yet); preserved here as the terminal case once the
  // WHOLE chain -- not just the literal ".wal" name -- comes up empty,
  // matching gl_model.ts's own Mod_LoadTexinfo caller-side r_notexture
  // convention for every other kind of miss.
  if (isWall) {
    ri.Con_Printf(PRINT_ALL, `GL_FindImage: can't load ${name}\n`);
    return r_notexture;
  }
  return null;
}

/*
===============
R_RegisterSkin
===============
*/
export function R_RegisterSkin(name: string): ImageT | null {
  return GL_FindImage(name, ImagetypeT.it_skin);
}

// memset(image, 0, sizeof(*image)) equivalent -- see r_image.ts's identical
// clearImage precedent for why this resets fields in place rather than
// replacing the gltextures[] slot with a fresh object.
function clearImage(image: ImageT): void {
  image.name = "";
  image.type = ImagetypeT.it_skin;
  image.width = 0;
  image.height = 0;
  image.upload_width = 0;
  image.upload_height = 0;
  image.registration_sequence = 0;
  image.texturechain = null;
  image.glow = null;
  image.texnum = 0;
  image.sl = 0;
  image.tl = 0;
  image.sh = 0;
  image.th = 0;
  image.scrap = false;
  image.has_alpha = false;
  image.paletted = false;
}

/*
================
GL_FreeUnusedImages

Any image that was not touched on this registration sequence will be freed.
================
*/
export function GL_FreeUnusedImages(): void {
  // never free r_notexture or particle texture. Both are ImageT | null in
  // this port (set by a sibling gl_rmisc.ts unit, out of SCOPE); the C
  // assumes they're always already set by this point in the real init
  // order -- guarded here only to satisfy strict null checking.
  if (r_notexture) r_notexture.registration_sequence = registration_sequence;
  if (r_particletexture) r_particletexture.registration_sequence = registration_sequence;

  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (image.registration_sequence === registration_sequence) continue; // used this sequence
    if (!image.registration_sequence) continue; // free image_t slot
    if (image.type === ImagetypeT.it_pic) continue; // don't free pics
    // free it
    qgl.qglDeleteTextures(1, new Int32Array([image.texnum]));
    clearImage(image);
  }
}

/*
===============
Draw_GetPalette
===============
*/
export function Draw_GetPalette(): number {
  const { palette } = LoadPCX("pics/colormap.pcx");
  if (!palette) {
    ri.Sys_Error(ERR_FATAL, "Couldn't load pics/colormap.pcx");
  }

  for (let i = 0; i < 256; i++) {
    const r = palette[i * 3 + 0];
    const g = palette[i * 3 + 1];
    const b = palette[i * 3 + 2];
    const v = ((255 << 24) + (r << 0) + (g << 8) + (b << 16)) >>> 0;
    d_8to24table[i] = LittleLong(v) >>> 0;
  }

  d_8to24table[255] = (d_8to24table[255] & 0xffffff) >>> 0; // 255 is transparent

  return 0;
}

/*
===============
GL_InitImages
===============
*/
export function GL_InitImages(): void {
  SetRegistrationSequence(1);

  // vanilla gl_image.c:1503: `intensity = ri.Cvar_Get ("intensity", "2", 0);`
  //
  // This was briefly changed to q2repro's "1" (src/refresh/texture.c:1266) on
  // a cvar-default parity sweep. That default does not transfer: q2repro
  // moved intensity OUT of the texture prescale and into its GLSL pipeline.
  // Its GL_BuildIntensityTable (texture.c:955) builds an IDENTITY table
  // whenever `gl_static.use_shaders`, and shader.c:687 applies the value at
  // draw time instead (`diffuse.rgb *= u_intensity;`), so "1" there means
  // "no prescale, brightness comes from the shader".
  //
  // This renderer has vanilla's mechanism and only vanilla's: intensitytable
  // below is the *only* place intensity is ever applied, prescaling world
  // textures at upload so that R_BlendLightmaps' second modulate pass
  // (GL_ZERO, GL_SRC_COLOR) lands back at the intended brightness. Setting it
  // to 1 removed the prescale with nothing to replace it and left the whole
  // world about half as bright, and left gl_state.inverse_intensity at 1.0 so
  // the un-lightmapped alpha/warp surfaces that scale by it no longer matched
  // the lit ones.
  // init intensity conversions
  glCvars.intensity = ri.Cvar_Get("intensity", "2", 0);

  if (glCvars.intensity && glCvars.intensity.value <= 1) {
    ri.Cvar_Set("intensity", "1");
  }

  gl_state.inverse_intensity = glCvars.intensity ? 1 / glCvars.intensity.value : 1;

  Draw_GetPalette();

  // C: `if ( qglColorTableEXT )` -- pointer, not cvar. Collapsed to also
  // require gl_ext_palettedtexture per this file's own header comment (the
  // QGL binding always resolves *_EXT symbols, so the bare pointer check
  // can never observe "driver doesn't have this extension" the way real
  // dlsym() could -- NVIDIA/Mesa both export qglColorTableEXT
  // unconditionally). Without this, any basedir missing pics/16to8.dat
  // (the rerelease's own pak0.pak -- verified: 16to8.dat ships in the
  // CLASSIC pak0 only) hit the Sys_Error below on every GL init, dropping
  // the renderer to ref_soft silently. Downgraded from Sys_Error(ERR_FATAL)
  // to a console print + leaving d_16to8table null: GL_BuildPalettedTexture
  // already early-returns on a null table (see its own comment above), so
  // gl_ext_palettedtexture=1 on rerelease data now degrades gracefully
  // (falls back to the non-paletted RGBA upload path) instead of killing
  // the renderer.
  if (qgl.qglColorTableEXT && glCvars.gl_ext_palettedtexture && glCvars.gl_ext_palettedtexture.value) {
    const { data } = ri.FS_LoadFile("pics/16to8.dat");
    if (!data) {
      ri.Con_Printf(PRINT_ALL, "Couldn't load pics/16to8.pcx\n");
    } else {
      gl_state.d_16to8table = data;
    }
  }

  // vid_gamma isn't registered by any function in this unit's SCOPE (gl_rmain.c
  // owns that Cvar_Get, out of scope); fall back to vanilla Quake2's own
  // default cvar value ("1") rather than treating an unset cvar as gamma 0.
  let g = glCvars.vid_gamma ? glCvars.vid_gamma.value : 1;

  if (gl_config.renderer & (GL_RENDERER_VOODOO | GL_RENDERER_VOODOO2)) {
    g = 1.0;
  }

  for (let i = 0; i < 256; i++) {
    if (g === 1) {
      gammatable[i] = i;
    } else {
      let inf = 255 * Math.pow((i + 0.5) / 255.5, g) + 0.5;
      if (inf < 0) inf = 0;
      if (inf > 255) inf = 255;
      gammatable[i] = inf | 0;
    }
  }

  for (let i = 0; i < 256; i++) {
    let j = i * (glCvars.intensity ? glCvars.intensity.value : 1);
    if (j > 255) j = 255;
    intensitytable[i] = j | 0;
  }

  // ==========================================================================
  // Engine-cvar parity audit, ref_gl cluster: q2repro's src/refresh/texture.c
  // GL_InitImages and src/refresh/images.c IMG_Init both register a texture-
  // pipeline feature set (per-image-type bilinear filtering toggles, runtime
  // texture-format/override search, texture-bit-depth override, anisotropic
  // filtering, scrap-atlas disable, skin downsampling, gamma-scaled pics,
  // upscaled PCX loading, saturation/invert post-processing, particle-shape
  // selection, cubemap loading, glowmaps, and screenshot format/async/
  // quality/compression/template) that this port's own GL_InitImages (ported
  // from vanilla's gl_rmisc.c-equivalent intensity/gamma-table init above,
  // not from q2repro's) never implemented. GL_FindImage above only ever
  // loads .pcx/.wal/.tga/.png by hardcoded extension dispatch -- no format-
  // priority search, no bilerp/anisotropy/saturation/invert pass, no
  // scrap-disable, no cubemap loading exists anywhere in this file (grepped).
  // GL_ScreenShot_f (gl_rmisc.ts) only ever writes an uncompressed vanilla
  // .tga buffer -- it does not branch on a format cvar, and there is no PNG
  // or JPEG *encoder* anywhere in this repo (src/qcommon/png.ts is a
  // decoder only, `decodePNG`, used for loading .png texture/pic assets, not
  // for writing screenshots) -- correcting the assumption that this port
  // already has a working PNG screenshot encoder to wire the format cvar
  // into: it doesn't, so gl_screenshot_format/async/quality/compression/
  // template are all registered-only below, same as the texture-pipeline
  // cvars above them.
  //
  // src/refresh/images.c:2258's `R_TEXTURE_FORMATS` macro expands (per
  // q2repro's build/config.h:38, generated from meson.build:710's
  // `texture_formats` option) to "png jpg tga" in this reference build.
  r_override_textures = ri.Cvar_Get("r_override_textures", "1", CVAR_FILES); // images.c:2257
  ri.Cvar_Get("r_texture_formats", "png jpg tga", 0); // images.c:2258
  r_texture_overrides = ri.Cvar_Get("r_texture_overrides", "-1", CVAR_FILES); // images.c:2261
  ri.Cvar_Get("gl_screenshot_format", "png", 0); // images.c:2264-2267 (USE_PNG branch; see note above -- registered only, GL_ScreenShot_f doesn't branch on this)
  ri.Cvar_Get("gl_screenshot_async", "1", 0); // images.c:2269
  ri.Cvar_Get("gl_screenshot_quality", "90", 0); // images.c:2272 (JPEG-only; no JPEG encoder exists in this repo)
  ri.Cvar_Get("gl_screenshot_compression", "6", 0); // images.c:2275 (PNG-only; no PNG encoder exists in this repo)
  ri.Cvar_Get("gl_screenshot_template", "quakeXXX", 0); // images.c:2277
  glCvars.r_glowmaps = ri.Cvar_Get("r_glowmaps", "1", CVAR_FILES); // images.c:2280 -- consumer: GL_CheckForGlowMap above

  ri.Cvar_Get("gl_bilerp_chars", "0", 0); // texture.c:1247
  ri.Cvar_Get("gl_bilerp_pics", "0", 0); // texture.c:1249
  ri.Cvar_Get("gl_bilerp_skies", "1", 0); // texture.c:1251
  ri.Cvar_Get("gl_texturebits", "0", CVAR_FILES); // texture.c:1256
  // texture.c:1257's C default is dynamic: `va("%g", gl_config.max_anisotropy)`
  // (the GL implementation's queried max anisotropy). This port's GlconfigT
  // (gl_local.ts) tracks no such limit -- nothing here queries
  // GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT -- so "1" (anisotropy off/1x, the safe
  // no-op value) is used instead of fabricating a queried limit.
  ri.Cvar_Get("gl_anisotropy", "1", 0); // texture.c:1257
  ri.Cvar_Get("gl_noscrap", "0", CVAR_FILES); // texture.c:1259
  ri.Cvar_Get("gl_downsample_skins", "1", CVAR_FILES); // texture.c:1262
  ri.Cvar_Get("gl_gamma_scale_pics", "0", CVAR_FILES); // texture.c:1263
  ri.Cvar_Get("gl_upscale_pcx", "0", CVAR_FILES); // texture.c:1264
  ri.Cvar_Get("gl_saturation", "1", CVAR_FILES); // texture.c:1265
  ri.Cvar_Get("gl_invert", "0", CVAR_FILES); // texture.c:1267
  ri.Cvar_Get("gl_partshape", "0", 0); // texture.c:1269
  ri.Cvar_Get("gl_cubemaps", "1", CVAR_FILES); // texture.c:1271
  // ==========================================================================
}

/*
===============
GL_ShutdownImages
===============
*/
export function GL_ShutdownImages(): void {
  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (!image.registration_sequence) continue; // free image_t slot
    // free it
    qgl.qglDeleteTextures(1, new Int32Array([image.texnum]));
    clearImage(image);
  }
}
