// Test for the kex on-screen indicator systems' store+draw side (wave B
// task): src/client/cl_scrn.ts's SCR_AddToDamageDisplay/SCR_DrawDamageDisplays
// (q2repro screen.c:1675-1745) and SCR_AddPOI/SCR_RemovePOI/SCR_DrawPOIs
// (screen.c:1747-1958), plus the help-path store (SCR_AddHelpPath/
// SCR_GetHelpPathMarkers, an ADAPTED port of tent.c's CL_AddHelpPath -- see
// cl_scrn.ts's own "Help path" section header for why). All three were
// previously decode-only in cl_parse.ts (readDamageKex/readPoiKex/
// readHelpPathKex results were thrown away) -- this exercises the real
// store+draw consumers now wired to those decode paths.
//
// Self-sufficient per PORTING.md rule 13: `re` is a fresh spying fake per
// test (precedent: test/cl_scrn_centerprint.test.ts's makeFakeRe), cl/cls
// state is reset in beforeEach, and the cvars this suite depends on
// (scr_damage_indicators/scr_damage_indicator_time/scr_pois/
// scr_poi_edge_frac/scr_poi_max_scale) are pinned via Cvar_ForceSet so
// another test file's mutation can't leak in.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import {
  SCR_Init,
  SCR_TouchPics,
  SCR_AddToDamageDisplay,
  SCR_DrawDamageDisplays,
  SCR_AddPOI,
  SCR_RemovePOI,
  SCR_DrawPOIs,
  SCR_AddHelpPath,
  SCR_GetHelpPathMarkers,
  SCR_ClearDamageAndPOIs,
} from "../src/client/cl_scrn";
import { cl, cls, setRe, ConnstateT } from "../src/client/client";
import { viddef } from "../src/client/vid";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { vec3 } from "../src/shared/math";
import type { RefExports, ImageS, DrawColorT } from "../src/client/ref";

interface DrawColorPicCall {
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  color: DrawColorT;
}

function makeFakeRe(): RefExports & { drawColorPicCalls: DrawColorPicCall[]; picSizes: Map<string, { w: number; h: number }> } {
  const fake = {
    drawColorPicCalls: [] as DrawColorPicCall[],
    picSizes: new Map<string, { w: number; h: number }>(),
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: (_name: string): ImageS | null => ({}) as ImageS,
    RegisterRawPic: (): ImageS | null => ({}) as ImageS,
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize(name: string) {
      return fake.picSizes.get(name) ?? { w: 0, h: 0 };
    },
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic(x: number, y: number, w: number, h: number, name: string, color: DrawColorT) {
      fake.drawColorPicCalls.push({ x, y, w, h, name, color });
    },
    DrawStretchPicRegion: (_x: number, _y: number, _w: number, _h: number, _name: string, _srcX: number, _srcY: number, _srcW: number, _srcH: number, _color: DrawColorT) => undefined,
    DrawChar: () => undefined,
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return fake;
}

let fake: ReturnType<typeof makeFakeRe>;

beforeAll(() => {
  SCR_Init(); // registers scr_damage_indicators/scr_damage_indicator_time/scr_pois/scr_poi_edge_frac/scr_poi_max_scale
});

beforeEach(() => {
  cls.clear();
  // Sized to CS_REMAP_RERELEASE.end (the LARGER table, matching `cl`'s own
  // natural default -- client.ts's ClT.configstrings field default and
  // cl.clear() both use this size), even though cls.csr below is the
  // smaller CS_REMAP_OLD -- NOT the other way around. A same-process test
  // file that later activates the kex cgame (real InitCGame reads
  // CS_REMAP_RERELEASE-range indices) would hit "get_configstring: bad
  // index" against a smaller array left behind here; sizing to the larger
  // table up front avoids ever leaking an undersized array to another test
  // file, regardless of run order (PORTING.md rule 13 self-sufficiency).
  cl.configstrings = new Array(CS_REMAP_RERELEASE.end).fill("");
  cls.csr = CS_REMAP_OLD;
  cls.state = ConnstateT.ca_active;
  cl.time = 0;
  cls.realtime = 0;
  cl.predicted_angles = vec3(0, 0, 0); // forward=(1,0,0), right=(0,-1,0), up=(0,0,1) -- see AngleVectors(0,0,0)
  cl.refdef.vieworg = vec3(0, 0, 0);
  cl.refdef.fov_x = 90;
  cl.refdef.fov_y = 73.9;
  viddef.width = 320;
  viddef.height = 240;
  SCR_ClearDamageAndPOIs();

  Cvar_ForceSet("scr_damage_indicators", "1");
  Cvar_ForceSet("scr_damage_indicator_time", "1000");
  Cvar_ForceSet("scr_pois", "1");
  Cvar_ForceSet("scr_poi_edge_frac", "0.15");
  Cvar_ForceSet("scr_poi_max_scale", "1.0");

  fake = makeFakeRe();
  fake.picSizes.set("damage_indicator", { w: 32, h: 16 });
  setRe(fake);
  SCR_TouchPics(); // populates cl_scrn.ts's damage_display_width/height from the fake pic size above
});

describe("SCR_AddToDamageDisplay / SCR_DrawDamageDisplays", () => {
  test("a freshly added entry draws exactly once, full alpha at t=0", () => {
    SCR_AddToDamageDisplay(10, vec3(1, 0, 0), vec3(1, 0, 0));
    SCR_DrawDamageDisplays();
    expect(fake.drawColorPicCalls.length).toBe(1);
    const call = fake.drawColorPicCalls[0]!;
    expect(call.name).toBe("damage_indicator");
    expect(call.color.r).toBe(255);
    expect(call.color.g).toBe(0);
    expect(call.color.b).toBe(0);
    expect(call.color.a).toBe(255); // frac === 1.0 at the instant it's added
  });

  test("fades out over scr_damage_indicator_time, then stops drawing once expired", () => {
    SCR_AddToDamageDisplay(5, vec3(0, 1, 0), vec3(0, 1, 0));

    cls.realtime = 500; // halfway through the default 1000ms window
    fake.drawColorPicCalls = [];
    SCR_DrawDamageDisplays();
    expect(fake.drawColorPicCalls.length).toBe(1);
    expect(fake.drawColorPicCalls[0]!.color.a).toBe(128); // round(0.5 * 255)

    cls.realtime = 1001; // past expiry
    fake.drawColorPicCalls = [];
    SCR_DrawDamageDisplays();
    expect(fake.drawColorPicCalls.length).toBe(0);
  });

  test("two hits from the same direction (dot >= 0.95) accumulate into ONE entry, not two", () => {
    SCR_AddToDamageDisplay(3, vec3(1, 0, 0), vec3(1, 0, 0));
    SCR_AddToDamageDisplay(4, vec3(1, 0, 0), vec3(1, 0, 0));
    SCR_DrawDamageDisplays();
    expect(fake.drawColorPicCalls.length).toBe(1);
    // damage accumulated (3+4=7), so the draw size differs from a single
    // damage=3 hit -- observable via the drawn width (min(display_width,
    // DAMAGE_ENTRY_BASE_SIZE*damage) = min(32, 3*7) = 21).
    expect(fake.drawColorPicCalls[0]!.w).toBe(21);
  });

  test("scr_damage_indicators 0 disables both store and draw", () => {
    Cvar_ForceSet("scr_damage_indicators", "0");
    SCR_AddToDamageDisplay(10, vec3(1, 0, 0), vec3(1, 0, 0));
    SCR_DrawDamageDisplays();
    expect(fake.drawColorPicCalls.length).toBe(0);
  });
});

describe("SCR_AddPOI / SCR_RemovePOI / SCR_DrawPOIs", () => {
  beforeEach(() => {
    cl.configstrings[cls.csr.images + 5] = "poi_marker";
    fake.picSizes.set("poi_marker", { w: 32, h: 32 });
  });

  test("a POI directly ahead of the camera projects to screen center and draws", () => {
    SCR_AddPOI(0, 5000, vec3(100, 0, 0), 5, 3, 0);
    SCR_DrawPOIs();
    expect(fake.drawColorPicCalls.length).toBe(1);
    const call = fake.drawColorPicCalls[0]!;
    expect(call.name).toBe("poi_marker");
    // hw/hh are HALF the (unscaled) pic size -- q2repro screen.c:1935-1956's
    // own preserved half-size draw quirk (see SCR_DrawPOIs' doc comment).
    expect(call.w).toBe(16);
    expect(call.h).toBe(16);
    // centered: drawX/drawY = spX/spY - hw/hh, and spX/spY are screen
    // center (160,120) for a point straight down +X with predicted_angles
    // (0,0,0) and fov_x=90/fov_y=73.9.
    expect(call.x).toBeCloseTo(160 - 16, 0);
    expect(call.y).toBeCloseTo(120 - 16, 0);
  });

  test("an expired POI (time <= cl.time) is not drawn", () => {
    SCR_AddPOI(0, 1000, vec3(100, 0, 0), 5, 3, 0);
    cl.time = 1001;
    SCR_DrawPOIs();
    expect(fake.drawColorPicCalls.length).toBe(0);
  });

  test("SCR_RemovePOI deletes a keyed POI immediately, regardless of its remaining time", () => {
    SCR_AddPOI(42, 60000, vec3(100, 0, 0), 5, 3, 0);
    SCR_RemovePOI(42);
    SCR_DrawPOIs();
    expect(fake.drawColorPicCalls.length).toBe(0);
  });

  test("re-adding the same keyed id replaces the old entry instead of allocating a new one", () => {
    SCR_AddPOI(7, 5000, vec3(100, 0, 0), 5, 3, 0);
    SCR_AddPOI(7, 5000, vec3(-100, 0, 0), 5, 3, 0); // behind the camera now
    SCR_DrawPOIs();
    // Still exactly one draw call (the id=7 slot was reused, not
    // duplicated), and its position reflects the SECOND (behind-camera)
    // add, not the first.
    expect(fake.drawColorPicCalls.length).toBe(1);
  });

  test("scr_pois 0 disables both store and draw", () => {
    Cvar_ForceSet("scr_pois", "0");
    SCR_AddPOI(0, 5000, vec3(100, 0, 0), 5, 3, 0);
    SCR_DrawPOIs();
    expect(fake.drawColorPicCalls.length).toBe(0);
  });

  test("real retail wire example: unkeyed POI (id=0) with a short lifetime still stores and draws", () => {
    // kexdemo.ts's readPoiKex decodes {key, time, pos, image, color, flags}
    // straight off the wire (q2proto_q2repro_client_read_poi) -- this is
    // the shape cl_parse.ts's svc_poi routing hands to SCR_AddPOI verbatim.
    SCR_AddPOI(0, 3000, vec3(50, 0, 0), 5, 3, 0);
    SCR_DrawPOIs();
    expect(fake.drawColorPicCalls.length).toBe(1);
  });
});

describe("SCR_AddHelpPath / SCR_GetHelpPathMarkers (adapted store)", () => {
  test("first=true resets the trail; subsequent waypoints accumulate", () => {
    SCR_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    SCR_AddHelpPath(vec3(10, 0, 0), vec3(1, 0, 0), false);
    SCR_AddHelpPath(vec3(20, 0, 0), vec3(1, 0, 0), false);
    expect(SCR_GetHelpPathMarkers().length).toBe(3);

    SCR_AddHelpPath(vec3(0, 0, 0), vec3(0, 1, 0), true); // a new path replaces the old one
    expect(SCR_GetHelpPathMarkers().length).toBe(1);
  });

  test("stored position is lifted 16 units in Z, matching tent.c's own `ex->ent.origin[2] += 16.0f`", () => {
    SCR_AddHelpPath(vec3(1, 2, 3), vec3(1, 0, 0), true);
    const markers = SCR_GetHelpPathMarkers();
    expect(markers[0]!.position[0]).toBe(1);
    expect(markers[0]!.position[1]).toBe(2);
    expect(markers[0]!.position[2]).toBe(19);
  });
});
