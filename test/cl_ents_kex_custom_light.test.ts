/*
Cover for the kex-extended branch of CL_AddPacketEntities (src/client/
cl_ents.ts), ported from q2repro src/client/entities.c:710-748.

Two rerelease entities spawn with `s.modelindex = 1` on purpose --
SP_target_light (rerelease g_target.cpp:1532, renderfx RF_CUSTOM_LIGHT) and
SP_misc_flare (g_misc.cpp:2136, renderfx RF_FLARE). Index 1 is the map
itself, so `cl.model_draw[1]` is the WORLD model. q2repro consumes both
before the model lookup; without that, each one is handed to the renderer as
an inline brush model and draws the entire map (maps/mguhub.bsp: 8
target_lights x 66621 surfaces per frame), which also re-queues world
surfaces that are already on the translucent chain and hangs
R_DrawAlphaSurfaces on the resulting cycle.

Self-sufficient per PORTING.md rule 13: cl.clear()/cls.clear() plus the
csr/state/frame fields each test reads are set in beforeEach.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { EntityStateT, RF_CUSTOM_LIGHT, RF_FLARE, RF_IR_VISIBLE } from "../src/shared/q_shared";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { cl, cls, ConnstateT, clCvars, cl_entities, cl_parse_entities, setRe } from "../src/client/client";
import { CL_AddEntities } from "../src/client/cl_ents";
import { CL_ClearEffects } from "../src/client/cl_fx";
import { CL_ClearTEnts } from "../src/client/cl_tent";
import { V_ClearScene, r_entities, r_numentities, r_dlights, r_numdlights } from "../src/client/cl_view";

// SP_target_light writes `(b << 8) | (g << 16) | (r << 24)`; the client reads
// it back big-endian, so r/g/b come out of the top three bytes.
const LIGHT_R = 255;
const LIGHT_G = 255;
const LIGHT_B = 63;
const PACKED_COLOR = (LIGHT_B << 8) | (LIGHT_G << 16) | (LIGHT_R << 24);
const LIGHT_RADIUS = 48;
const DLIGHT_CUTOFF = 48 + 64; // q2repro refresh.h:37 DLIGHT_CUTOFF is 64

const WORLD_MODEL = { world: true };

function seatOneEntity(renderfx: number, skinnum: number): void {
  const s = cl_parse_entities[0];
  s.number = 185;
  s.modelindex = 1;
  s.renderfx = renderfx;
  s.skinnum = skinnum;
  s.frame = LIGHT_RADIUS;
  s.effects = 0;
  s.origin[0] = -1648;
  s.origin[1] = -120;
  s.origin[2] = 64;

  const cent = cl_entities[185];
  cent.current = s;
  cent.prev = s;
  cent.serverframe = 1;

  cl.frame.valid = true;
  cl.frame.serverframe = 1;
  cl.frame.servertime = 100;
  cl.frame.num_entities = 1;
  cl.frame.parse_entities = 0;
  cl.time = 100;
}

beforeEach(() => {
  cl.clear();
  cls.clear();
  setRe(null);
  clCvars.cl_showclamp = null;
  clCvars.cl_timedemo = null;
  clCvars.cl_predict = null;
  clCvars.cl_gun = null;
  clCvars.cl_vwep = null;
  cls.state = ConnstateT.ca_active;
  cl.model_draw[1] = WORLD_MODEL;
  // cl_fx.ts's cl_dlights[]/particle pool and cl_tent.ts's explosion pool are
  // module-level singletons separate from the render scene, and
  // cl.clear()/V_ClearScene() do not touch any of them -- V_ClearScene only
  // resets r_numdlights, the OUTPUT counter. CL_AddEntities then runs
  // CL_AddTEnts and CL_AddDLights, which re-emit every still-live pooled
  // explosion/dlight into the scene, so leftovers from an earlier suite
  // (test/cl_fx.test.ts, which runs immediately before this file) landed in
  // r_dlights ahead of this suite's own and made the r_numdlights
  // assertions count 2 instead of 1. CL_ClearEffects + CL_ClearTEnts are the
  // product's own resets for exactly this -- the pair CL_ClearState runs on
  // disconnect (rule 13: a suite initializes what it touches and does not
  // depend on an ordering).
  CL_ClearEffects();
  CL_ClearTEnts();
  V_ClearScene();
});

describe("CL_AddPacketEntities -- RF_CUSTOM_LIGHT (kex/extended families)", () => {
  test("adds a dlight at the entity origin and never hands the world model to the renderer", () => {
    cls.csr = CS_REMAP_RERELEASE;
    seatOneEntity(RF_CUSTOM_LIGHT | RF_IR_VISIBLE, PACKED_COLOR);

    CL_AddEntities();

    expect(r_numdlights).toBe(1);
    const dl = r_dlights[0];
    expect(dl.intensity).toBe(DLIGHT_CUTOFF);
    expect(dl.color[0]).toBeCloseTo(LIGHT_R / 255, 5);
    expect(dl.color[1]).toBeCloseTo(LIGHT_G / 255, 5);
    expect(dl.color[2]).toBeCloseTo(LIGHT_B / 255, 5);
    expect(dl.origin[0]).toBeCloseTo(-1648, 3);
    expect(dl.origin[2]).toBeCloseTo(64, 3);

    expect(r_entities.slice(0, r_numentities).some((e) => e.model === WORLD_MODEL)).toBe(false);
  });

  test("a zero skinnum is COLOR_WHITE, matching q2repro's `if (!s1->skinnum) color = COLOR_WHITE`", () => {
    cls.csr = CS_REMAP_RERELEASE;
    seatOneEntity(RF_CUSTOM_LIGHT, 0);

    CL_AddEntities();

    expect(r_numdlights).toBe(1);
    expect(r_dlights[0].color[0]).toBe(1);
    expect(r_dlights[0].color[1]).toBe(1);
    expect(r_dlights[0].color[2]).toBe(1);
  });

  test("RF_FLARE is consumed too -- neither the world model nor a dlight reaches the scene", () => {
    cls.csr = CS_REMAP_RERELEASE;
    seatOneEntity(RF_FLARE, PACKED_COLOR);

    CL_AddEntities();

    expect(r_numdlights).toBe(0);
    expect(r_entities.slice(0, r_numentities).some((e) => e.model === WORLD_MODEL)).toBe(false);
  });

  test("legacy (non-extended) families take neither branch -- the bits are rerelease-only", () => {
    cls.csr = CS_REMAP_OLD;
    seatOneEntity(RF_CUSTOM_LIGHT, PACKED_COLOR);

    CL_AddEntities();

    expect(r_numdlights).toBe(0);
    // under a legacy protocol those renderfx bits carry no meaning, so the
    // entity keeps vanilla's plain model lookup
    expect(r_entities.slice(0, r_numentities).some((e) => e.model === WORLD_MODEL)).toBe(true);
  });
});
