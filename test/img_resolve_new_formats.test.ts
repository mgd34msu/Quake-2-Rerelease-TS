/*
Integration tests for the scope-addition formats wired into both
renderers' resolution chains (GL_FindImage in src/ref_gl/gl_image.ts,
R_FindImage in src/ref_soft/r_image.ts): the ".jpeg" alias for the
existing JPEG decoder, and the new BMP/GIF decoders (src/qcommon/bmp.ts,
src/qcommon/gif.ts) joining the candidate list after the native q2repro
formats (src/qcommon/img_resolve.ts's own header comment). See
test/bmp.test.ts and test/gif.test.ts for the decoders' own unit tests
(including the fixture-generation Python scripts); this file only checks
that GL_FindImage/R_FindImage actually route to them and that ".jpeg"
truly behaves as an alias, not a second parse of the extension.

Self-sufficient per rule 13: fake RefImports built the same way
test/gl_image.test.ts and test/r_image_png.test.ts already do, reset in
beforeEach; no reliance on any other test file having run.

FIXTURES: a 1x1 24bpp BMP (color 200,150,100) and a 1x1 GIF (color
5,150,250), generated the same way as test/bmp.test.ts/test/gif.test.ts's
own fixtures:

  python3 - <<'PY'
  import struct
  from PIL import Image

  def bmp_header(width, height, bit_count, compression, data_size):
      off_bits = 14 + 40
      file_size = off_bits + data_size
      fh = struct.pack("<2sIHHI", b"BM", file_size, 0, 0, off_bits)
      ih = struct.pack("<IiiHHIIiiII", 40, width, height, 1, bit_count,
                        compression, data_size, 0, 0, 0, 0)
      return fh + ih

  row = bytes([100, 150, 200]) + bytes(1)  # BGR + pad to 4 bytes
  # ONE_PIXEL_BMP = bmp_header(1, 1, 24, 0, len(row)) + row

  img = Image.new("P", (1, 1))
  img.putpalette([0, 0, 0, 5, 150, 250] + [0, 0, 0] * 254)
  img.putpixel((0, 0), 1)
  img.save("one.gif")
  # ONE_PIXEL_GIF = open("one.gif", "rb").read()
  PY
*/

import { describe, test, expect, beforeEach } from "bun:test";

const ONE_PIXEL_BMP = new Uint8Array([66, 77, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 24, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 150, 200, 0]);
const ONE_PIXEL_GIF = new Uint8Array([71, 73, 70, 56, 55, 97, 1, 0, 1, 0, 129, 0, 0, 5, 150, 250, 0, 0, 0, 0, 0, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 8, 4, 0, 1, 4, 4, 0, 59]);

import { buildBaselineJpeg } from "./support/jpeg_builder";

function buildTestJpeg(): Uint8Array {
  return buildBaselineJpeg({
    width: 8,
    height: 8,
    components: [
      { h: 1, v: 1 },
      { h: 1, v: 1 },
      { h: 1, v: 1 },
    ],
    blocks: [[[10], [20], [30]]],
  });
}

describe("GL_FindImage -- .jpeg alias and BMP/GIF candidates", () => {
  let files: Map<string, Uint8Array>;

  beforeEach(async () => {
    const { SetRefImports, gltextures, ImageT, SetNumGltextures, gl_state } = await import("../src/ref_gl/gl_local");
    const { CvarT } = await import("../src/shared/q_shared");
    const { SetQGL, ResetScrapState } = await import("../src/ref_gl/gl_image");
    const { QGLRecording } = await import("../src/ref_gl/qgl");

    files = new Map();
    SetRefImports({
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
      Cvar_Get: () => new CvarT(),
      Cvar_Set: () => new CvarT(),
      Cvar_SetValue: () => {},
      Vid_GetModeInfo: () => ({ width: 320, height: 240 }),
      Vid_MenuInit: () => {},
      Vid_NewWindow: () => {},
    });
    SetQGL(new QGLRecording());
    for (let i = 0; i < gltextures.length; i++) gltextures[i] = new ImageT();
    SetNumGltextures(0);
    gl_state.currenttextures[0] = 0;
    gl_state.currenttextures[1] = 0;
    gl_state.currenttmu = 0;
    // rule 13: several fixtures below (the 8x8 JPEG, 1x1 BMP, 1x1 PCX) are
    // it_pic-typed and under 64px, so they go through GL_LoadPic's scrap-
    // allocation branch -- gl_image.ts's scrap allocator is a module-level
    // singleton with no reset hook of its own (see ResetScrapState's own
    // header comment), so without this, running this file before another
    // suite with its own fixed-offset Scrap_AllocBlock expectations (e.g.
    // test/gl_image.test.ts) would leave that suite's assertions wrong.
    ResetScrapState();
  });

  test("a direct .jpeg request decodes through the same JPEG decoder as .jpg", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    files.set("vault/direct.jpeg", buildTestJpeg());

    const image = GL_FindImage("vault/direct.jpeg", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("vault/direct.jpeg");
    expect(image?.width).toBe(8);
    expect(image?.height).toBe(8);
  });

  test("a missing .pcx with only a .jpeg sibling falls back to it (jpeg slotted after png/jpg/tga)", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    files.set("vault/onlyjpeg.jpeg", buildTestJpeg());

    const image = GL_FindImage("vault/onlyjpeg.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("vault/onlyjpeg.jpeg");
  });

  test("a missing .pcx with only a .bmp sibling falls back to it", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    files.set("textures/onlybmp.bmp", ONE_PIXEL_BMP);

    const image = GL_FindImage("textures/onlybmp.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("textures/onlybmp.bmp");
    expect(image?.width).toBe(1);
    expect(image?.height).toBe(1);
  });

  test("a missing .wal wall texture with only a .gif sibling falls back to it (walls get the new formats too)", async () => {
    const { GL_FindImage } = await import("../src/ref_gl/gl_image");
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    files.set("textures/onlygif.gif", ONE_PIXEL_GIF);

    const image = GL_FindImage("textures/onlygif.wal", ImagetypeT.it_wall);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("textures/onlygif.gif");
    expect(image?.width).toBe(1);
    expect(image?.height).toBe(1);
  });

  test("an existing .pcx wins over a .bmp/.gif/.jpeg sibling (exact-name hit never scans alternates)", async () => {
    const { GL_FindImage, LoadPCX } = await import("../src/ref_gl/gl_image");
    void LoadPCX;
    const { ImagetypeT } = await import("../src/ref_gl/gl_local");
    // Minimal valid 1x1 PCX (manufacturer/version/encoding/bpp header,
    // trivial run, 768-byte palette) -- same shape test/gl_image.test.ts's
    // own buildPcxBytes helper produces, inlined here to avoid importing
    // that file's test-local helper.
    const header = new Uint8Array(128);
    header[0] = 0x0a;
    header[1] = 5;
    header[2] = 1;
    header[3] = 8;
    const hv = new DataView(header.buffer);
    hv.setUint16(8, 0, true); // xmax = 0 -> width 1
    hv.setUint16(10, 0, true); // ymax = 0 -> height 1
    const pixelData = new Uint8Array([7]); // single run-length-1 byte, value 7
    const palette = new Uint8Array(768);
    const pcxBytes = new Uint8Array(header.length + pixelData.length + palette.length);
    pcxBytes.set(header, 0);
    pcxBytes.set(pixelData, header.length);
    pcxBytes.set(palette, header.length + pixelData.length);

    files.set("pics/both.pcx", pcxBytes);
    files.set("pics/both.bmp", ONE_PIXEL_BMP);
    files.set("pics/both.gif", ONE_PIXEL_GIF);
    files.set("pics/both.jpeg", buildTestJpeg());

    const image = GL_FindImage("pics/both.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/both.pcx");
  });
});

describe("R_FindImage -- .jpeg alias and BMP/GIF candidates, quantized", () => {
  let files: Map<string, Uint8Array>;
  let isolationCounter = 0;

  beforeEach(async () => {
    isolationCounter++;
    const { SetRefImports, d_8to24table } = await import("../src/ref_soft/r_local");
    files = new Map();
    SetRefImports({
      Sys_Error(_level: number, str: string): never {
        throw new Error(str);
      },
      Cmd_AddCommand: () => undefined,
      Cmd_RemoveCommand: () => undefined,
      Cmd_Argc: () => 0,
      Cmd_Argv: () => "",
      Cmd_ExecuteText: () => undefined,
      Con_Printf: () => undefined,
      FS_LoadFile: (name: string) => {
        const data = files.get(name);
        if (!data) return { length: -1, data: null };
        return { length: data.length, data };
      },
      FS_FreeFile: () => undefined,
      FS_Gamedir: () => "",
      Cvar_Get: () => null,
      Cvar_Set: () => null,
      Cvar_SetValue: () => undefined,
      Vid_GetModeInfo: () => null,
      Vid_MenuInit: () => undefined,
      Vid_NewWindow: () => undefined,
    });
    d_8to24table.fill(0);
    // give the quantizer something non-black to snap to, so results are
    // distinguishable from "everything defaulted to index 0"
    d_8to24table[9] = ((100 << 16) | (150 << 8) | 200) >>> 0; // matches ONE_PIXEL_BMP's RGB
    d_8to24table[11] = ((250 << 16) | (150 << 8) | 5) >>> 0; // matches ONE_PIXEL_GIF's RGB
  });

  // r_image.ts's r_images/numr_images module cache has no reset hook
  // between tests -- same rationale as test/r_image_png.test.ts's own
  // describe block: import through a private query-string instance.
  async function freshRImage(): Promise<typeof import("../src/ref_soft/r_image")> {
    return import("../src/ref_soft/r_image" + "?img_resolve_new_formats_isolation_" + isolationCounter);
  }

  test("a direct .jpeg request decodes through the same JPEG decoder as .jpg, quantized", async () => {
    const rImage = await freshRImage();
    const { ImagetypeT } = await import("../src/ref_soft/r_model");
    files.set("vault/direct.jpeg", buildTestJpeg());

    const image = rImage.R_FindImage("vault/direct.jpeg", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("vault/direct.jpeg");
    expect(image?.width).toBe(8);
    expect(image?.height).toBe(8);
  });

  test("a missing .pcx with only a .bmp sibling falls back to it, quantized to the nearest palette entry", async () => {
    const rImage = await freshRImage();
    const { ImagetypeT } = await import("../src/ref_soft/r_model");
    files.set("pics/onlybmp.bmp", ONE_PIXEL_BMP);

    const image = rImage.R_FindImage("pics/onlybmp.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/onlybmp.bmp");
    expect(image?.pixels[0]?.[0]).toBe(9); // the (100,150,200)-matching palette slot seeded above
  });

  test("a missing .pcx with only a .gif sibling falls back to it, quantized to the nearest palette entry", async () => {
    const rImage = await freshRImage();
    const { ImagetypeT } = await import("../src/ref_soft/r_model");
    files.set("pics/onlygif.gif", ONE_PIXEL_GIF);

    const image = rImage.R_FindImage("pics/onlygif.pcx", ImagetypeT.it_pic);

    expect(image).not.toBeNull();
    expect(image?.name).toBe("pics/onlygif.gif");
    expect(image?.pixels[0]?.[0]).toBe(11); // the (5,150,250)-matching palette slot seeded above
  });
});
