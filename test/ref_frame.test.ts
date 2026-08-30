/*
Whole-renderer integration test: drives ref_soft end to end and renders one
real frame headlessly, with no id Software game data.

Everything the renderer loads comes from the in-memory file system below:
`maps/frame.bsp` is test/support/bsp_builder.ts's box room built with its
renderable lumps (six inward-facing wall quads, one per BSP node), and
`pics/colormap.pcx` is test/support/colormap_builder.ts's synthetic 256x320
colormap/alphamap. `textures/wall.wal` is deliberately absent, so
Mod_LoadTexinfo falls back to r_main.ts's `r_notexture_mip` -- the 16x16
checkerboard R_InitTextures builds out of palette indices 0 and 255. Combined
with the identity colormap, a wall pixel on screen is exactly a texel of that
checkerboard, which is what the assertions below rest on.
*/

import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CvarT } from "../src/shared/q_shared";
import { type Vec3, vec3 } from "../src/shared/math";
import type { RefImports, RefExports } from "../src/client/ref";
import { LightstyleT, MAX_LIGHTSTYLES, RefdefT } from "../src/client/ref";
import { vid, r_notexture_mip, r_worldmodel, surfaces, surface_p } from "../src/ref_soft/r_local";
import { GetRefAPI } from "../src/ref_soft/r_main";
import { R_ScreenShot_f } from "../src/ref_soft/r_misc";
import { LoadPCX } from "../src/ref_soft/r_image";
import { SWimp_Shutdown } from "../src/platform/swimp";
import { VID_Init } from "../src/platform/vid";
import { buildBoxRoomBsp, WORLDSPAWN_ONLY_ENTITIES, ROOM_HALF } from "./support/bsp_builder";
import { buildColormapPcx } from "./support/colormap_builder";

const MODE_WIDTH = 320;
const MODE_HEIGHT = 240;

const BACKGROUND_COLOR = 2; // sw_clearcolor's default, filled by D_BackgroundSurf
const NOTEXTURE_INDICES = [0, 255]; // the only two indices R_InitTextures writes

let gamedir = "";
const files = new Map<string, Uint8Array>();
const cvars = new Map<string, CvarT>();

function makeCvar(name: string, value: string, flags: number): CvarT {
  const existing = cvars.get(name);
  if (existing) return existing;
  const c = new CvarT();
  c.name = name;
  c.string = value;
  c.value = Number.parseFloat(value) || 0;
  c.flags = flags;
  c.modified = true;
  cvars.set(name, c);
  return c;
}

function fakeRefImports(): RefImports {
  return {
    Sys_Error(_level: number, str: string): never {
      throw new Error(`Sys_Error: ${str}`);
    },
    Cmd_AddCommand(): void {},
    Cmd_RemoveCommand(): void {},
    Cmd_Argc(): number {
      return 0;
    },
    Cmd_Argv(): string {
      return "";
    },
    Cmd_ExecuteText(): void {},
    Con_Printf(): void {},
    FS_LoadFile(name: string): { length: number; data: Uint8Array | null } {
      const data = files.get(name);
      if (!data) return { length: -1, data: null };
      return { length: data.length, data };
    },
    FS_FreeFile(): void {},
    FS_Gamedir(): string {
      return gamedir;
    },
    Cvar_Get(name: string, value: string, flags: number): CvarT | null {
      return makeCvar(name, value, flags);
    },
    Cvar_Set(name: string, value: string): CvarT | null {
      const c = makeCvar(name, value, 0);
      c.string = value;
      c.value = Number.parseFloat(value) || 0;
      c.modified = true;
      return c;
    },
    Cvar_SetValue(name: string, value: number): void {
      const c = makeCvar(name, String(value), 0);
      c.value = value;
      c.string = String(value);
      c.modified = true;
    },
    Vid_GetModeInfo(mode: number): { width: number; height: number } | null {
      if (mode !== 0) return null;
      return { width: MODE_WIDTH, height: MODE_HEIGHT };
    },
    Vid_MenuInit(): void {},
    Vid_NewWindow(): void {},
  };
}

function buildRefdef(vieworg: Vec3): RefdefT {
  const fd = new RefdefT();
  fd.x = 0;
  fd.y = 0;
  fd.width = MODE_WIDTH;
  fd.height = MODE_HEIGHT;
  fd.fov_x = 90;
  fd.fov_y = 90;
  fd.vieworg = vieworg;
  fd.viewangles = vec3(0, 0, 0); // yaw 0: forward is +x
  fd.time = 0;
  fd.rdflags = 0;
  fd.areabits = null;

  fd.lightstyles = Array.from({ length: MAX_LIGHTSTYLES }, () => {
    const ls = new LightstyleT();
    ls.rgb = vec3(1, 1, 1);
    ls.white = 1;
    return ls;
  });

  fd.num_entities = 0;
  fd.entities = [];
  fd.num_dlights = 0;
  fd.dlights = [];
  fd.num_particles = 0;
  fd.particles = [];
  return fd;
}

let ref: RefExports;
let renderError: unknown = null;
let offsetFrame: Uint8Array = new Uint8Array(0);
let offsetSurfacesWithSpans = 0;

function countSurfacesWithSpans(): number {
  const sfs = surfaces;
  if (sfs === null) return 0;
  let n = 0;
  for (let i = 2; i < surface_p; i++) if (sfs[i].spans !== null) n++;
  return n;
}

beforeAll(() => {
  gamedir = mkdtempSync(join(tmpdir(), "q2refframe-"));
  files.set("maps/frame.bsp", buildBoxRoomBsp(WORLDSPAWN_ONLY_ENTITIES, { renderable: true }));
  files.set("pics/colormap.pcx", buildColormapPcx());

  VID_Init();

  ref = GetRefAPI(fakeRefImports());
  ref.Init(null, null);
  ref.BeginRegistration("frame");
  ref.EndRegistration();

  // second viewpoint, rendered first so the primary frame is the one left in
  // vid.buffer: off the room's centre and above it, so five walls are on
  // screen at an angle instead of one wall square-on.
  try {
    ref.RenderFrame(buildRefdef(vec3(-32, 16, 24)));
    offsetFrame = vid.buffer.slice();
    offsetSurfacesWithSpans = countSurfacesWithSpans();

    // the brief's viewpoint: the exact centre of the room, looking down +x
    ref.RenderFrame(buildRefdef(vec3(0, 0, 0)));
  } catch (e) {
    renderError = e;
  }
});

describe("ref_soft renders a real frame headless", () => {
  test("R_Init brings up a 320x240 framebuffer, the colormap and the notexture checkerboard", () => {
    expect(vid.width).toBe(MODE_WIDTH);
    expect(vid.height).toBe(MODE_HEIGHT);
    expect(vid.rowbytes).toBe(MODE_WIDTH);
    expect(vid.buffer.length).toBe(MODE_WIDTH * MODE_HEIGHT);

    // Draw_GetPalette loaded pics/colormap.pcx into vid.colormap, and the
    // alphamap is the 256x256 tail past the 64 shading rows
    expect(vid.colormap).not.toBeNull();
    expect(vid.colormap?.length).toBe(256 * 320);
    expect(vid.alphamap?.length).toBe(256 * 256);
    // identity shading table: colormap[light*256 + i] === i
    expect(vid.colormap?.[0]).toBe(0);
    expect(vid.colormap?.[137]).toBe(137);
    expect(vid.colormap?.[63 * 256 + 200]).toBe(200);

    // R_InitTextures' checkerboard is a real image_t reachable through r_local
    expect(r_notexture_mip).not.toBeNull();
    expect(r_notexture_mip?.width).toBe(16);
    expect(r_notexture_mip?.pixels[0]?.length).toBe(16 * 16);
    const distinctTexels = new Set(r_notexture_mip?.pixels[0] ?? []);
    expect([...distinctTexels].sort((a, b) => a - b)).toEqual(NOTEXTURE_INDICES);
  });

  test("R_BeginRegistration loads the map into the shared r_worldmodel", () => {
    expect(r_worldmodel).not.toBeNull();
    expect(r_worldmodel?.name).toBe("maps/frame.bsp");
    // six wall faces from the builder, plus the six R_InitSkyBox appends
    expect(r_worldmodel?.numsurfaces).toBe(12);
    expect(r_worldmodel?.numnodes).toBe(6);
  });

  test("R_RenderFrame completes and posts the room's surfaces to the shared edge list", () => {
    expect(renderError).toBeNull();

    // surfaces[] is allocated by R_NewMap/R_EdgeDrawing and filled by
    // r_rast.ts; r_edge.ts consumes the same array. Before consolidation
    // these were three separate copies and this was 0.
    expect(surfaces).not.toBeNull();
    // surface 0 dummy + surface 1 background + at least one wall
    expect(surface_p).toBeGreaterThan(2);
  });

  test("the framebuffer holds a drawn room, not a flat clear", () => {
    const buffer = vid.buffer;
    const distinct = new Set(buffer);
    expect(distinct.size).toBeGreaterThan(1);

    // every pixel is either the background fill or a notexture checkerboard
    // texel carried through the identity colormap -- no third value can
    // appear, and a NaN/garbage index would have to
    for (const value of distinct) {
      expect([BACKGROUND_COLOR, ...NOTEXTURE_INDICES]).toContain(value);
    }

    // both checkerboard indices are present, so the wall is textured rather
    // than flat-filled
    expect(distinct.has(0)).toBe(true);
    expect(distinct.has(255)).toBe(true);
  });

  test("the view down +x lands on the wall, and the room's corners do not show background", () => {
    const buffer = vid.buffer;
    const at = (x: number, y: number): number => buffer[y * vid.rowbytes + x];

    // the camera sits at the centre of the ROOM_HALF cube looking down +x
    // with a 90 degree fov, so the +X wall -- 2*ROOM_HALF across, ROOM_HALF
    // away -- exactly fills the view. The centre pixel is therefore a texel
    // of that wall, never the void behind it.
    expect(ROOM_HALF).toBe(64);
    expect(NOTEXTURE_INDICES).toContain(at(MODE_WIDTH / 2, MODE_HEIGHT / 2));

    // the room is closed, so no scanline anywhere can see the void
    let backgroundPixels = 0;
    for (const value of buffer) if (value === BACKGROUND_COLOR) backgroundPixels++;
    expect(backgroundPixels).toBe(0);

    // the checkerboard is 16x16 over a 128-unit wall, so the centre row must
    // change value many times across the screen rather than being one run
    let transitions = 0;
    for (let x = 1; x < MODE_WIDTH; x++) {
      if (at(x, MODE_HEIGHT / 2) !== at(x - 1, MODE_HEIGHT / 2)) transitions++;
    }
    expect(transitions).toBeGreaterThan(4);
  });

  test("an off-centre viewpoint rasterizes several walls at once", () => {
    // square-on, one wall covers the screen and the other four are edge-on.
    // From off-centre and above, five of the six walls post spans -- which
    // only happens if r_rast.ts's producer and r_edge.ts's consumer share one
    // `surfaces`/`surface_p`/`r_edges`/`edge_p` set.
    expect(offsetSurfacesWithSpans).toBeGreaterThanOrEqual(4);

    expect(offsetFrame.length).toBe(MODE_WIDTH * MODE_HEIGHT);
    const distinct = new Set(offsetFrame);
    expect(distinct.has(0)).toBe(true);
    expect(distinct.has(255)).toBe(true);
    expect(distinct.has(BACKGROUND_COLOR)).toBe(false);

    // a different viewpoint must produce a different image
    expect(offsetFrame).not.toEqual(vid.buffer);
  });

  test("R_ScreenShot_f writes a PCX through the platform writer and LoadPCX round-trips it", () => {
    R_ScreenShot_f();

    const shotPath = join(gamedir, "scrnshot", "quake00.pcx");
    expect(existsSync(shotPath)).toBe(true);

    const written = readFileSync(shotPath);
    files.set("scrnshot/quake00.pcx", new Uint8Array(written));

    const { pic, palette, width, height } = LoadPCX("scrnshot/quake00.pcx");
    expect(width).toBe(MODE_WIDTH);
    expect(height).toBe(MODE_HEIGHT);
    expect(pic).not.toBeNull();
    expect(pic?.length).toBe(MODE_WIDTH * MODE_HEIGHT);

    // the decoded screenshot is the framebuffer, byte for byte
    expect(pic).toEqual(vid.buffer);

    // and it carries the greyscale palette R_GammaCorrectAndSetPalette pushed
    expect(palette?.[0]).toBe(0);
    expect(palette?.[128 * 3]).toBe(128);
    expect(palette?.[255 * 3 + 2]).toBe(255);

    SWimp_Shutdown();
  });
});
