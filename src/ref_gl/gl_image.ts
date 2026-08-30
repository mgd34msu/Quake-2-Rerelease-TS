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

import { ERR_DROP, ERR_FATAL, PRINT_ALL, PRINT_DEVELOPER, MAX_QPATH, LittleShort, LittleLong, Q_stricmp, Com_sprintf } from "../shared/q_shared";
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

  if (image_type !== 2 && image_type !== 10) {
    ri.Sys_Error(ERR_DROP, "LoadTGA: Only type 2 and 10 targa RGB images supported\n");
  }
  if (colormap_type !== 0 || (pixel_size !== 32 && pixel_size !== 24)) {
    ri.Sys_Error(ERR_DROP, "LoadTGA: Only 32 or 24 bit images supported (no colormaps)\n");
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

function GL_Upload32(data: Uint32Array, width: number, height: number, mipmap: boolean): boolean {
  uploaded_paletted = false;

  let scaled_width = 1;
  while (scaled_width < width) scaled_width <<= 1;
  if (glCvars.gl_round_down && glCvars.gl_round_down.value && scaled_width > width && mipmap) scaled_width >>>= 1;

  let scaled_height = 1;
  while (scaled_height < height) scaled_height <<= 1;
  if (glCvars.gl_round_down && glCvars.gl_round_down.value && scaled_height > height && mipmap) scaled_height >>>= 1;

  // let people sample down the world textures for speed
  if (mipmap) {
    const picmip = glCvars.gl_picmip ? glCvars.gl_picmip.value : 0;
    scaled_width >>>= picmip;
    scaled_height >>>= picmip;
  }

  // don't ever bother with >256 textures
  if (scaled_width > 256) scaled_width = 256;
  if (scaled_height > 256) scaled_height = 256;
  if (scaled_width < 1) scaled_width = 1;
  if (scaled_height < 1) scaled_height = 1;

  upload_width = scaled_width;
  upload_height = scaled_height;

  if (scaled_width * scaled_height > 256 * 256) {
    ri.Sys_Error(ERR_DROP, "GL_Upload32: too big");
  }

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
  if (s > 512 * 256) {
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
    ri.Con_Printf(PRINT_ALL, `GL_FindImage: can't load ${name}\n`);
    return r_notexture;
  }

  const view = new DataView(mt.buffer, mt.byteOffset, mt.byteLength);
  const width = LittleLong(view.getUint32(WAL_WIDTH_OFFSET, true));
  const height = LittleLong(view.getUint32(WAL_HEIGHT_OFFSET, true));
  const ofs = LittleLong(view.getUint32(WAL_OFFSET0_OFFSET, true));

  const image = GL_LoadPic(name, mt.subarray(ofs), width, height, ImagetypeT.it_wall, 8);

  ri.FS_FreeFile(mt);

  return image;
}

/*
===============
GL_FindImage

Finds or loads the given image
===============
*/
export function GL_FindImage(name: string, type: ImagetypeT): ImageT | null {
  if (!name) return null;
  const len = name.length;
  if (len < 5) return null;

  // look for it
  for (let i = 0; i < numgltextures; i++) {
    const image = gltextures[i];
    if (name === image.name) {
      image.registration_sequence = registration_sequence;
      return image;
    }
  }

  //
  // load the pic from disk
  //
  const ext = name.slice(len - 4);
  let image: ImageT | null;
  if (ext === ".pcx") {
    const { pic, width, height } = LoadPCX(name);
    if (!pic) return null;
    image = GL_LoadPic(name, pic, width, height, type, 8);
  } else if (ext === ".wal") {
    image = GL_LoadWal(name);
  } else if (ext === ".tga") {
    const { pic, width, height } = LoadTGA(name);
    if (!pic) return null;
    image = GL_LoadPic(name, pic, width, height, type, 32);
  } else {
    return null;
  }

  return image;
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

  // init intensity conversions
  glCvars.intensity = ri.Cvar_Get("intensity", "2", 0);

  if (glCvars.intensity && glCvars.intensity.value <= 1) {
    ri.Cvar_Set("intensity", "1");
  }

  gl_state.inverse_intensity = glCvars.intensity ? 1 / glCvars.intensity.value : 1;

  Draw_GetPalette();

  if (qgl.qglColorTableEXT) { // C: if ( qglColorTableEXT ) -- pointer, not cvar
    const { data } = ri.FS_LoadFile("pics/16to8.dat");
    if (!data) {
      ri.Sys_Error(ERR_FATAL, "Couldn't load pics/16to8.pcx");
    }
    gl_state.d_16to8table = data;
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
