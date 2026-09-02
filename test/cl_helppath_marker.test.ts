/*
The objective compass's breadcrumb trail on the CLIENT side: cl_tent.ts's
CL_AddHelpPath and the ex_marker explosion type that draws it
(q2repro src/client/tent.c:477-502 and its CL_AddExplosions case at
tent.c:599-624).

WHY THIS FILE EXISTS. test/nav_compass_hook.test.ts covers the SERVER half --
that both game bindings reach src/server/nav.ts and agree on the points.
This covers what the client does with those points once svc_help_path puts
them on the wire. The trail used to be submitted as one V_AddParticle per
waypoint, which the GL point-size attenuation blew up into screen-filling
blobs at close range; it is now the reference's marker MODEL, and the two
things worth pinning are the entity CL_AddHelpPath builds and the animation
CL_AddExplosions runs on it (the one-second drop-in, the lifetime fade, and
the free at the end).

No renderer and no server are needed: CL_AddHelpPath writes into cl_tent.ts's
own explosion pool, and CL_AddTEnts submits into cl_view.ts's scene entity
list, both of which are module state this file can read directly. `re` stays
null throughout, so `ex.ent.model` stays null (CL_RegisterTEntModels
early-outs without a renderer) -- the model HANDLE is not what these cases
are about, and asserting on it would only be asserting on the fake.

Self-sufficient per PORTING.md rule 13: cl.time / cl.frame.servertime and the
cl_compass_time cvar are set explicitly in every case, and CL_ClearTEnts
empties the pool in beforeEach so nothing leaks in from another file.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { CL_AddHelpPath, CL_ClearTEnts, CL_AddTEnts, cl_explosions, ExptypeT } from "../src/client/cl_tent";
import { V_ClearScene, r_entities, r_numentities } from "../src/client/cl_view";
import { cl, clCvars } from "../src/client/client";
import { Cvar_Get, Cvar_ForceSet } from "../src/qcommon/cvar";
import { vec3 } from "../src/shared/math";
import { RF_MINLIGHT, RF_NOSHADOW, RF_TRANSLUCENT } from "../src/shared/q_shared";

/** tent.c:1750's own default. */
const COMPASS_TIME_SECONDS = 10;

function markers() {
  return cl_explosions.filter((ex) => ex.type === ExptypeT.ex_marker);
}

/** The scene entities CL_AddTEnts submitted this frame, as a plain copy --
 *  `r_entities` is a preallocated pool, so only the first `r_numentities`
 *  slots are live. */
function submitted() {
  return r_entities.slice(0, r_numentities);
}

beforeEach(() => {
  CL_ClearTEnts();
  V_ClearScene();
  cl.time = 0;
  cl.frame.servertime = 0;
  cl.lerpfrac = 0;
  clCvars.cl_compass_time = Cvar_Get("cl_compass_time", String(COMPASS_TIME_SECONDS), 0);
  Cvar_ForceSet("cl_compass_time", String(COMPASS_TIME_SECONDS));
});

describe("CL_AddHelpPath (tent.c:477-502)", () => {
  test("one ex_marker per waypoint, and first=true frees the previous trail", () => {
    CL_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    CL_AddHelpPath(vec3(64, 0, 0), vec3(1, 0, 0), false);
    CL_AddHelpPath(vec3(128, 0, 0), vec3(1, 0, 0), false);
    expect(markers().length).toBe(3);

    // A new path starts: every marker still standing from the old one goes.
    CL_AddHelpPath(vec3(0, 512, 0), vec3(0, 1, 0), true);
    expect(markers().length).toBe(1);
    expect(markers()[0]!.ent.origin[1]).toBe(512);
  });

  test("the marker sits 16 units above the waypoint, and remembers that Z", () => {
    CL_AddHelpPath(vec3(1, 2, 3), vec3(1, 0, 0), true);
    const ex = markers()[0]!;
    expect(ex.ent.origin[0]).toBe(1);
    expect(ex.ent.origin[1]).toBe(2);
    // tent.c:492 `ex->ent.origin[2] += 16.0f`
    expect(ex.ent.origin[2]).toBe(19);
    // tent.c:493 parks the resting Z in lightcolor[0] for the drop-in.
    expect(ex.lightcolor[0]).toBe(19);
  });

  test("the marker points along the segment the server sent (vectoangles2)", () => {
    // Straight down the +Y axis: yaw 90, no pitch.
    CL_AddHelpPath(vec3(0, 0, 0), vec3(0, 1, 0), true);
    expect(markers()[0]!.ent.angles[1]).toBeCloseTo(90, 4);
    expect(markers()[0]!.ent.angles[0]).toBeCloseTo(0, 4);
    expect(markers()[0]!.ent.angles[2]).toBe(0);

    // Straight down -X with a 45-degree climb: yaw 180, pitch -45 (the
    // function negates pitch, math.c:57).
    CL_AddHelpPath(vec3(0, 0, 0), vec3(-1, 0, 1), true);
    expect(markers()[0]!.ent.angles[1]).toBeCloseTo(180, 4);
    expect(markers()[0]!.ent.angles[0]).toBeCloseTo(-45, 4);
  });

  test("render flags and scale match tent.c:497-501", () => {
    CL_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    const ex = markers()[0]!;
    expect(ex.ent.flags).toBe(RF_NOSHADOW | RF_MINLIGHT | RF_TRANSLUCENT);
    expect(ex.ent.scale[0]).toBe(2.5);
    expect(ex.ent.scale[1]).toBe(2.5);
    expect(ex.ent.scale[2]).toBe(2.5);
  });

  test("a full base1-length trail (35 waypoints) is alive at once", () => {
    // The whole reason q2repro raised MAX_EXPLOSIONS to 256: at vanilla's 32
    // the trail would evict its own head while still being laid down.
    // 35 is what nav_compass_hook.test.ts measures on the real base1 graph.
    for (let i = 0; i < 35; i++) CL_AddHelpPath(vec3(i * 64, 0, 0), vec3(1, 0, 0), i === 0);
    expect(markers().length).toBe(35);
  });
});

describe("ex_marker animation (tent.c:599-624)", () => {
  test("drops in from 512 units up over the first second, then holds", () => {
    CL_AddHelpPath(vec3(0, 0, 100), vec3(1, 0, 0), true);
    const ex = markers()[0]!;
    const restZ = 116; // 100 + the 16-unit lift

    // At spawn the eased curve is at 0, so the marker is a full 512 up.
    cl.time = ex.start;
    CL_AddTEnts();
    expect(ex.ent.origin[2]).toBeCloseTo(restZ + 512, 3);

    // Half a second in it has fallen most of the way (the curve is
    // 1-(1-t)^8, which is 0.9961 at t=0.5) but is not down yet.
    V_ClearScene();
    cl.time = ex.start + 500;
    CL_AddTEnts();
    expect(ex.ent.origin[2]).toBeGreaterThan(restZ);
    expect(ex.ent.origin[2]).toBeLessThan(restZ + 512);

    // Past one second it is pinned to its resting Z and stays there.
    V_ClearScene();
    cl.time = ex.start + 1000;
    CL_AddTEnts();
    expect(ex.ent.origin[2]).toBeCloseTo(restZ, 5);

    V_ClearScene();
    cl.time = ex.start + 5000;
    CL_AddTEnts();
    expect(ex.ent.origin[2]).toBeCloseTo(restZ, 5);
  });

  test("fades from half-opaque to nothing across cl_compass_time, then frees its slot", () => {
    CL_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    const ex = markers()[0]!;
    const life = COMPASS_TIME_SECONDS * 1000;

    cl.time = ex.start;
    CL_AddTEnts();
    // tent.c:620 `ent->alpha = (1.0f - frac) * 0.5f` -- a marker is never
    // more than half-opaque, which is what keeps a 35-step trail from
    // walling off the view.
    expect(ex.ent.alpha).toBeCloseTo(0.5, 5);

    V_ClearScene();
    cl.time = ex.start + life / 2;
    CL_AddTEnts();
    expect(ex.ent.alpha).toBeCloseTo(0.25, 5);

    // Still alive right at the end of its life.
    V_ClearScene();
    cl.time = ex.start + life;
    CL_AddTEnts();
    expect(ex.type).toBe(ExptypeT.ex_marker);

    // One tick past it and the pool slot is back.
    V_ClearScene();
    cl.time = ex.start + life + 1;
    CL_AddTEnts();
    expect(ex.type).toBe(ExptypeT.ex_free);
    expect(markers().length).toBe(0);
  });

  test("cl_compass_time is read live, so lowering it shortens a standing trail", () => {
    CL_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    const ex = markers()[0]!;

    cl.time = ex.start + 3000;
    CL_AddTEnts();
    expect(ex.type).toBe(ExptypeT.ex_marker); // 3s of a 10s life

    Cvar_ForceSet("cl_compass_time", "2");
    V_ClearScene();
    cl.time = ex.start + 3000;
    CL_AddTEnts();
    expect(ex.type).toBe(ExptypeT.ex_free); // 3s of a 2s life
  });

  test("submits one scene entity per live marker, on frame 0 with no interpolation", () => {
    for (let i = 0; i < 4; i++) CL_AddHelpPath(vec3(i * 64, 0, 0), vec3(1, 0, 0), i === 0);
    cl.time = 1500;
    CL_AddTEnts();

    const ents = submitted();
    expect(ents.length).toBe(4);
    for (const e of ents) {
      // The retail marker md2 has exactly one frame. The C leans on its
      // renderer clamping `baseframe + f + 1` back to 0; this port submits
      // the clamped pair directly (see cl_tent.ts's ex_marker case), which
      // is the same picture without gl_mesh.ts's per-frame "no such frame"
      // console line.
      expect(e.frame).toBe(0);
      expect(e.oldframe).toBe(0);
      expect(e.backlerp).toBe(0);
      // oldorigin tracks origin so nothing lerps the marker through its own
      // drop-in.
      expect(e.oldorigin[2]).toBe(e.origin[2]);
      expect(e.scale[0]).toBe(2.5);
      expect(e.flags & RF_TRANSLUCENT).toBeTruthy();
    }
  });

  test("a freed marker submits nothing", () => {
    CL_AddHelpPath(vec3(0, 0, 0), vec3(1, 0, 0), true);
    cl.time = COMPASS_TIME_SECONDS * 1000 + 5000;
    CL_AddTEnts();
    expect(submitted().length).toBe(0);
  });
});
