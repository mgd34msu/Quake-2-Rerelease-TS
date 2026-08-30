/*
Copyright (C) 1997-2001 Id Software, Inc.
Ported from ref_soft/r_image.c (GNU GPL v2 or later).

`LoadPCX`'s `byte **pic, byte **palette, int *width, int *height` out
params become a returned object per PORTING.md's out-param convention.
`GL_LoadPic`/`R_LoadWal`/`R_FindFreeImage` are static internal helpers (not
declared in r_local.h) and are module-private, not exported. LoadTGA is
ref_soft's dead-code path for the software renderer (R_FindImage's ".tga"
branch always returns NULL -- "can't load %s in software renderer") and is
not ported, matching that branch's C behavior.

pcx_t (qcommon/qfiles.h) and miptex_t (qcommon/qfiles.h, the .WAL format)
are not ported into qfiles.ts -- that module's own header comment defers
both formats to "the future model/image-loading units", which is this one.
Their layouts are read directly here via DataView at the C struct's byte
offsets, per PORTING.md's "Binary file formats ... parsed from ArrayBuffer
with DataView, struct-by-struct, offsets matching the C layout."

r_image.c's own module-static `image_t r_images[MAX_RIMAGES]` / `numr_images`
are declared at this module's top level, matching "the module that owns
them in C" (PORTING.md).

registration_sequence is owned by r_model.ts (as in C); imported as a
live binding, written via its SetRegistrationSequence setter.

`R_ImageList_f` (the `imagelist` console command) is not declared in
r_local.h, is not referenced by any other ported module, and is not named
in this unit's brief -- not ported.
*/

import { Com_PageInMemory, Com_sprintf, ERR_DROP, MAX_QPATH, PRINT_ALL, PRINT_DEVELOPER } from "../shared/q_shared";
import { ri, r_notexture_mip } from "./r_local";
import { ImageT, ImagetypeT, registration_sequence, SetRegistrationSequence } from "./r_model";

// r_image.c owns this counter; r_model.c's copy of the same name cannot be
// written through r_model.ts's export (see file header deviation note).


const MAX_RIMAGES = 1024;
const r_images: ImageT[] = [];
let numr_images = 0;

//=================================================================
// PCX LOADING
//=================================================================

// pcx_t layout (qcommon/qfiles.h): manufacturer/version/encoding/
// bits_per_pixel (1 byte each, offsets 0-3), xmin/ymin/xmax/ymax/hres/vres
// (unsigned short, offsets 4-15), palette[48] (16-63), reserved/color_planes
// (64-65), bytes_per_line/palette_type (unsigned short, 66-69), filler[58]
// (70-127), data (unbounded, starts at 128).
const PCX_HEADER_SIZE = 128;
const PCX_PALETTE_SIZE = 768;

export function LoadPCX(filename: string): { pic: Uint8Array | null; palette: Uint8Array | null; width: number; height: number } {
  const result: { pic: Uint8Array | null; palette: Uint8Array | null; width: number; height: number } = { pic: null, palette: null, width: 0, height: 0 };

  const { length: len, data: raw } = ri.FS_LoadFile(filename);
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

  const palette = new Uint8Array(PCX_PALETTE_SIZE);
  palette.set(raw.subarray(len - PCX_PALETTE_SIZE, len));
  result.palette = palette;

  result.width = width;
  result.height = height;

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

//=======================================================

function R_FindFreeImage(): ImageT {
  let i = 0;
  for (; i < numr_images; i++) {
    if (!r_images[i].registration_sequence) break;
  }
  if (i === numr_images) {
    if (numr_images === MAX_RIMAGES) {
      ri.Sys_Error(ERR_DROP, "MAX_RIMAGES");
    }
    r_images.push(new ImageT());
    numr_images++;
  }
  return r_images[i];
}

function GL_LoadPic(name: string, pic: Uint8Array, width: number, height: number, type: ImagetypeT): ImageT {
  const image = R_FindFreeImage();
  if (name.length >= MAX_QPATH) {
    ri.Sys_Error(ERR_DROP, `Draw_LoadPic: "${name}" is too long`);
  }
  image.name = name;
  image.registration_sequence = registration_sequence;

  image.width = width;
  image.height = height;
  image.type = type;

  const c = width * height;
  const pixels = new Uint8Array(c);
  image.pixels[0] = pixels;
  image.transparent = false;
  for (let i = 0; i < c; i++) {
    const b = pic[i];
    if (b === 255) image.transparent = true;
    pixels[i] = b;
  }

  return image;
}

// miptex_t layout (qcommon/qfiles.h): name[32] (0-31), width/height
// (unsigned, 32-35/36-39), offsets[4] (unsigned, 40-55), animname[32]
// (56-87), flags/contents/value (int, 88-91/92-95/96-99).
const WAL_WIDTH_OFFSET = 32;
const WAL_HEIGHT_OFFSET = 36;
const WAL_OFFSET0_OFFSET = 40;

function R_LoadWal(name: string): ImageT | null {
  const { data: mt } = ri.FS_LoadFile(name);
  if (!mt) {
    ri.Con_Printf(PRINT_ALL, `R_LoadWal: can't load ${name}\n`);
    return r_notexture_mip;
  }

  const view = new DataView(mt.buffer, mt.byteOffset, mt.byteLength);

  const image = R_FindFreeImage();
  image.name = name;
  image.width = view.getUint32(WAL_WIDTH_OFFSET, true);
  image.height = view.getUint32(WAL_HEIGHT_OFFSET, true);
  image.type = ImagetypeT.it_wall;
  image.registration_sequence = registration_sequence;

  const size = ((image.width * image.height * (256 + 64 + 16 + 4)) / 256) | 0;
  const combined = new Uint8Array(size);
  const mip0Size = image.width * image.height;
  const mip1Size = (mip0Size / 4) | 0;
  const mip2Size = (mip0Size / 16) | 0;
  image.pixels[0] = combined.subarray(0, mip0Size);
  image.pixels[1] = combined.subarray(mip0Size, mip0Size + mip1Size);
  image.pixels[2] = combined.subarray(mip0Size + mip1Size, mip0Size + mip1Size + mip2Size);
  image.pixels[3] = combined.subarray(mip0Size + mip1Size + mip2Size, size);

  const ofs = view.getUint32(WAL_OFFSET0_OFFSET, true);
  combined.set(mt.subarray(ofs, ofs + size));

  ri.FS_FreeFile(mt);

  return image;
}

/*
===============
R_FindImage

Finds or loads the given image
===============
*/
export function R_FindImage(name: string, type: ImagetypeT): ImageT | null {
  const len = name.length;
  if (len < 5) return null; // ri.Sys_Error (ERR_DROP, "R_FindImage: bad name: %s", name);

  // look for it
  for (let i = 0; i < numr_images; i++) {
    const image = r_images[i];
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
    if (!pic) return null; // ri.Sys_Error (ERR_DROP, "R_FindImage: can't load %s", name);
    image = GL_LoadPic(name, pic, width, height, type);
  } else if (ext === ".wal") {
    image = R_LoadWal(name);
  } else if (ext === ".tga") {
    return null; // ri.Sys_Error (ERR_DROP, "R_FindImage: can't load %s in software renderer", name);
  } else {
    return null; // ri.Sys_Error (ERR_DROP, "R_FindImage: bad extension on: %s", name);
  }

  return image;
}

/*
===============
R_RegisterSkin
===============
*/
export function R_RegisterSkin(name: string): ImageT | null {
  return R_FindImage(name, ImagetypeT.it_skin);
}

// memset(image, 0, sizeof(*image)) equivalent: r_model.ts's ImageT has no
// clear() method (out of this unit's SCOPE to add one), so this resets an
// existing ImageT's fields in place rather than replacing the r_images[]
// slot with a fresh object -- preserving object identity for any other
// module holding a live reference to this image (mirrors C's memset
// zeroing the struct at the same address, rather than freeing and
// reallocating it).
function clearImage(image: ImageT): void {
  image.name = "";
  image.type = ImagetypeT.it_skin;
  image.width = 0;
  image.height = 0;
  image.transparent = false;
  image.registration_sequence = 0;
  image.pixels = [null, null, null, null];
}


export function R_FreeUnusedImages(): void {
  for (let i = 0; i < numr_images; i++) {
    const image = r_images[i];
    if (image.registration_sequence === registration_sequence) {
      if (image.pixels[0]) Com_PageInMemory(image.pixels[0], image.width * image.height);
      continue; // used this sequence
    }
    if (!image.registration_sequence) continue; // free texture
    if (image.type === ImagetypeT.it_pic) continue; // don't free pics
    // free it -- the other mip levels just follow (a single combined
    // Uint8Array backs pixels[0..3], freed together by the GC)
    clearImage(image);
  }
}

/*
===============
R_InitImages
===============
*/
export function R_InitImages(): void {
  SetRegistrationSequence(1);
}

/*
===============
R_ShutdownImages
===============
*/
export function R_ShutdownImages(): void {
  for (let i = 0; i < numr_images; i++) {
    const image = r_images[i];
    if (!image.registration_sequence) continue; // free texture
    // free it
    clearImage(image);
  }
}

/*
===============
R_ImageList_f
===============
*/
export function R_ImageList_f(): void {
  ri.Con_Printf(PRINT_ALL, "------------------\n");
  let texels = 0;

  for (let i = 0; i < numr_images; i++) {
    const image = r_images[i];
    if (image.registration_sequence <= 0) continue;
    texels += image.width * image.height;
    switch (image.type) {
      case ImagetypeT.it_skin:
        ri.Con_Printf(PRINT_ALL, "M");
        break;
      case ImagetypeT.it_sprite:
        ri.Con_Printf(PRINT_ALL, "S");
        break;
      case ImagetypeT.it_wall:
        ri.Con_Printf(PRINT_ALL, "W");
        break;
      case ImagetypeT.it_pic:
        ri.Con_Printf(PRINT_ALL, "P");
        break;
      default:
        ri.Con_Printf(PRINT_ALL, " ");
        break;
    }

    ri.Con_Printf(PRINT_ALL, Com_sprintf(" %3i %3i : %s\n", image.width, image.height, image.name));
  }
  ri.Con_Printf(PRINT_ALL, Com_sprintf("Total texel count: %i\n", texels));
}
