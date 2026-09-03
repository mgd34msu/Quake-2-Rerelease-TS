// Image extension resolution order -- NOT a port of any file in the
// original id Quake II source (vanilla GL_FindImage/R_FindImage only ever
// try the exact extension the caller asked for and give up). Added per
// Mike's ruling 2026-08-31 (.orch/followups.md:365-367, "support as many
// image formats for as many things as possible") to bring q2repro's
// universal extension-fallback behavior to both renderers, for every image
// class (skins, pics, sprite frames, walls).
//
// q2repro's real algorithm (src/refresh/images.c) is spread across a few
// functions:
//   - load_image_data (images.c:1819-1855): given the requested name's own
//     recognized extension `fmt`, first calls try_image_format(fmt, ...)
//     (images.c:1836); on ENOENT only, falls through to try_other_formats.
//   - try_other_formats (images.c:1669-1691): loops img_search (the 32-bit
//     "truecolor override" formats, in the order the r_texture_formats
//     cvar lists them -- default "png jpg tga", images.c:2258, itself built
//     from meson.build's dependency-detection order png/jpg/tga), skipping
//     the format already tried; ENOENT on a candidate moves to the next
//     one, any other result (success OR a real decode error) stops the
//     search (images.c:1680-1682). If nothing in that loop panned out, it
//     falls back once more to the appropriate native 8-bit format --
//     IM_WAL for IT_WALL images, IM_PCX for everything else
//     (images.c:1686) -- unless that's the same format already tried.
//   - try_replace_ext (images.c:1661-1666): REPLACES the extension in
//     place (memcpy over image->name's existing extension bytes) rather
//     than appending a second one -- the double-extension bug this port
//     already fixed at ad6fb29 ("pics/sprites/flare_01.tga.pcx").
//
// One deliberate, already-documented divergence carried forward from this
// port's existing gl_image.ts/r_image.ts fallback comments: q2repro's
// DEFAULT build (r_override_textures=1, images.c:2257) actually prefers
// the truecolor override formats BEFORE the literally-requested native
// pcx/wal file whenever the requested name's own extension is pcx/wal
// (need_override_image, images.c:1777-1784, gates load_image_data's
// override branch at images.c:1831-1833) -- i.e. real q2repro's default
// texture-override feature can load a "textures/x.png" instead of an
// existing "textures/x.pcx" even when both are present.
//
// NO LONGER A DIVERGENCE (2026-09-02). This port used to skip
// r_override_textures entirely -- the requested extension was always tried
// first and another was substituted only on an outright miss. That was
// observably identical on both retail data trees (classic data only ever
// ships the native extension for an asset, rerelease data only ever ships the
// override extension), which is why it stood for so long. MEASURED, and that
// belief turns out to be only MOSTLY true: censusing both installs finds 60
// basenames in the 1997 tree that ship in both forms -- every env/*.pcx
// skybox face also ships as env/*.tga, which is exactly why id shipped the
// .tga versions -- and 43 in the re-release tree (model skins such as
// models/monsters/shambler/skin). For those, override-first genuinely changes
// which file wins, to the truecolor one, which is the same choice q2repro's
// default build makes and the one every modern Quake II client makes.
//
// And it is not identical at all for the case neither tree contains: a
// replacement the PLAYER supplies alongside the original, where the pak's
// .pcx won and the drop-in was dead weight. imageExtCandidates' `overrideFirst` parameter below implements the
// override branch; see its own comment, and gl_image.ts's GL_FindImage for
// where r_override_textures/r_texture_overrides decide to pass it.
//
// This module intentionally only computes the ORDERED CANDIDATE LIST of
// extensions to probe -- a pure function, easy to table-test against
// q2repro's algorithm above without any filesystem/renderer state. Each
// renderer's own GL_FindImage/R_FindImage (gl_image.ts/r_image.ts) walks
// the list, trying its own per-extension loader for each candidate in
// order, and stops at the first one that actually decodes.

// The extensions any Quake II asset (classic or rerelease) can ship under.
// Deliberately NOT importing either renderer's ImagetypeT (gl_local.ts and
// r_model.ts each declare their own copy per PORTING.md's per-file port
// convention) -- callers pass a plain `isWall` boolean instead, so this
// helper has zero renderer coupling.
//
// "jpeg"/"bmp"/"gif" (Mike's ruling, scope addition 2026-08-31: "support as
// many image formats as possible") have no q2repro precedent at all --
// q2repro's own img_loaders table (images.c:1460-1472) only ever has the
// five above. ".jpeg" is a pure filename-spelling alias for the same JPEG
// decoder ".jpg" already uses (qcommon/jpg.ts); ".bmp"/".gif" are genuinely
// new decoders (qcommon/bmp.ts, qcommon/gif.ts). None of the three exist
// anywhere in the real retail data (own census of baseq2/pak0.pak and
// Q2Game.kpf: zero .bmp/.gif/.jpeg hits) -- this is forward-looking format
// support, not filling an observed content gap, so there is no retail-gated
// test for these three the way pcx/wal/png/jpg's fallback work has.
export type ImgExtT = "pcx" | "wal" | "tga" | "png" | "jpg" | "jpeg" | "bmp" | "gif";

// Default r_texture_formats search order (images.c:2258's Cvar_Get default,
// itself built from meson.build's png/jpg/tga dependency-detection order,
// meson.build:397-467) -- the order try_other_formats' img_search loop
// walks the 32-bit "truecolor override" formats in. "jpeg"/"bmp"/"gif" have
// no q2repro cvar entry to derive an order from (see ImgExtT's own comment)
// -- placed after the three native q2repro formats per Mike's explicit
// scope-addition ruling ("New formats join both renderers' candidate lists
// after the native formats"), in the order they were added to this port.
const SEARCH_ORDER: readonly ImgExtT[] = ["png", "jpg", "tga", "jpeg", "bmp", "gif"];

// Computes the ordered list of extensions to try for `requestedExt` (the
// extension the caller's own name string already ends in, or null if it
// isn't one of the five recognized ones -- q2repro's IM_MAX case,
// images.c:1824-1830, which skips straight to the full search with no
// leading try-as-is attempt).
//
// `isWall` selects the final native-format fallback rung: IT_WALL images
// fall back to .wal (never .pcx -- walls were never a PCX format in Quake
// II, classic or rerelease), everything else falls back to .pcx
// (images.c:1686).
//
// `supported` is the set of extensions the calling renderer can actually
// decode (GL: all five, including .tga via LoadTGA; the software renderer
// has no .tga decoder at all -- see r_image.ts's own header comment -- so
// it passes a four-entry set). A candidate outside `supported` is never
// produced.
export function imageExtCandidates(requestedExt: ImgExtT | null, isWall: boolean, supported: readonly ImgExtT[], overrideFirst = false): readonly ImgExtT[] {
  const has = (ext: ImgExtT): boolean => supported.includes(ext);
  const candidates: ImgExtT[] = [];

  // r_override_textures (need_override_image, images.c:1777-1784, gating
  // load_image_data's override branch at images.c:1831-1833). When the caller
  // says this request is override-eligible, the truecolor formats are probed
  // BEFORE the literally-requested one, so a replacement a player dropped into
  // their homedir wins over the original still sitting in a .pak.
  //
  // This is the divergence the note at the top of this file used to record as
  // "this port does not implement r_override_textures at all". It had to stop
  // being a divergence: without it, dropping a higher-resolution
  // pics/num_0.png beside the pak's pics/num_0.pcx did nothing whatsoever,
  // because the requested .pcx was found first and won -- and every asset the
  // 1997 data ships is a .pcx or a .wal, so NO hi-res replacement of classic
  // content could ever load. (Owner requirement: "the texture should be aware
  // of the file resolution and this should all work independently of that. so
  // if i drop in some hires textures it doesn't just freak the fuck out".)
  //
  // The ordering below is the only thing that changes; the CALLER decides
  // eligibility (see gl_image.ts's GL_FindImage for the r_override_textures /
  // r_texture_overrides reading of it), and `overrideFirst` defaults false so
  // every existing caller and table test keeps the pre-existing order.
  if (overrideFirst) {
    for (const ext of SEARCH_ORDER) {
      if (has(ext)) candidates.push(ext);
    }
  }

  // try_image_format(fmt, ...) -- the requested extension, tried as-is,
  // before any substitution (images.c:1836).
  if (requestedExt !== null && has(requestedExt) && !candidates.includes(requestedExt)) {
    candidates.push(requestedExt);
  }

  // try_other_formats' img_search loop (images.c:1674-1683): the 32-bit
  // formats in r_texture_formats order, skipping the one already tried.
  for (const ext of SEARCH_ORDER) {
    if (ext === requestedExt) continue;
    if (has(ext) && !candidates.includes(ext)) candidates.push(ext);
  }

  // try_other_formats' final native-format fallback (images.c:1686-1690).
  const fallback: ImgExtT = isWall ? "wal" : "pcx";
  if (fallback !== requestedExt && has(fallback) && !candidates.includes(fallback)) {
    candidates.push(fallback);
  }

  return candidates;
}

/*
===============
imageHeaderDims

Reads an image file's pixel dimensions from its header alone, for every
extension imageExtCandidates can produce. `data` only has to hold the head
of the file (IMG_HEADER_PROBE_BYTES is enough for every format below,
including a JPEG whose SOF marker sits behind a large APP segment); a
truncated or unparseable header yields null rather than a guess.

This is what a renderer reads to recover an image's LOGICAL size -- the
dimensions the original shipped asset had, which every consumer that
reasons in source-pixel units (BSP texinfo projection, kfont atlas cells,
Draw_GetPicSize callers) expects -- when the file it actually loaded is a
player's replacement of another size or format. Rule 25 (Mike, 2026-09-02):
"the texture should be aware of the file resolution and this should all
work independently of that" -- for ANY format, not only the two 8-bit ones.
===============
*/
export const IMG_HEADER_PROBE_BYTES = 65536;

export interface ImageDimsT {
  readonly width: number;
  readonly height: number;
}

// Sanity bound on a parsed size, standing in for q2repro's check_image_size
// (images.c:1722): rejects a header that did not really parse.
const MAX_HEADER_DIMENSION = 8192;

function saneDims(width: number, height: number): ImageDimsT | null {
  if (!(width > 0 && height > 0 && width <= MAX_HEADER_DIMENSION && height <= MAX_HEADER_DIMENSION)) return null;
  return { width, height };
}

export function imageHeaderDims(ext: ImgExtT, data: Uint8Array): ImageDimsT | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (ext) {
    case "pcx": // pcx_t: manufacturer, version, encoding, bpp, xmin, ymin, xmax, ymax
      if (data.length < 12) return null; // header fields only, as get_image_dimensions reads them (no manufacturer check)
      return saneDims(view.getUint16(8, true) - view.getUint16(4, true) + 1, view.getUint16(10, true) - view.getUint16(6, true) + 1);
    case "wal": // miptex_t: name[32], width, height
      if (data.length < 40) return null;
      return saneDims(view.getUint32(32, true), view.getUint32(36, true));
    case "png": // signature[8], IHDR length[4], "IHDR", width, height (big-endian)
      if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4e || data[3] !== 0x47) return null;
      if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return null;
      return saneDims(view.getUint32(16, false), view.getUint32(20, false));
    case "tga": // TargaHeader: ..., x_origin, y_origin (8-11), width (12-13), height (14-15)
      if (data.length < 18) return null;
      return saneDims(view.getUint16(12, true), view.getUint16(14, true));
    case "jpg":
    case "jpeg": {
      // SOI, then marker segments until a SOFn (C0-CF except C4/C8/CC), whose
      // payload is precision[1], height[2], width[2] (big-endian).
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
      let pos = 2;
      while (pos + 9 <= data.length) {
        if (data[pos] !== 0xff) return null;
        const marker = data[pos + 1];
        if (marker === 0xff) {
          pos++; // fill byte
          continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
          pos += 2; // standalone markers carry no length
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
        const segLen = view.getUint16(pos + 2, false);
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) return saneDims(view.getUint16(pos + 7, false), view.getUint16(pos + 5, false));
        pos += 2 + segLen;
      }
      return null;
    }
    case "bmp": // BITMAPFILEHEADER "BM" ..., BITMAPINFOHEADER width (18), height (22, may be negative for top-down)
      if (data.length < 26 || data[0] !== 0x42 || data[1] !== 0x4d) return null;
      return saneDims(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
    case "gif": // "GIF8?a", logical screen width (6), height (8)
      if (data.length < 10 || data[0] !== 0x47 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x38) return null;
      return saneDims(view.getUint16(6, true), view.getUint16(8, true));
  }
}
