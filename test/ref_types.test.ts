/*
Self-sufficient test for the ref_soft type core: constructs the r_local.ts/
r_model.ts data structures ported from r_local.h/r_model.h, checks that
SWimp_SetMode (src/platform/swimp.ts) allocates a correctly-sized headless
framebuffer, and checks that a representative bodyless-C-declaration guard
throws with its C function name (Mod_ClearAll -- PORTING.md's convention for
a declared-but-never-defined C function; a different, permanent stub class
from the historical "PendingPort" placeholder PORTING.md also documents,
which had zero references left once its close phase ran).
*/

import { describe, test, expect } from "bun:test";
import { CplaneT } from "../src/shared/q_shared";
import { vec3 } from "../src/shared/math";
import {
  AffinetridescT,
  AliastriangleparmsT,
  BedgeT,
  ClipplaneT,
  DrawsurfT,
  EdgeT,
  EmitpointT,
  EspanT,
  FinalvertT,
  OldrefdefT,
  RserrT,
  SurfcacheT,
  SurfT,
  SwstateT,
  ViddefT,
  VrectT,
  r_refdef,
  SetRefImports,
  sw_state,
  vid,
} from "../src/ref_soft/r_local";
import { ImageT, ImagetypeT, MedgeT, MleafT, ModelT, ModtypeT, MnodeT, MsurfaceT, MtexinfoT, MvertexT, isMleaf, CONTENTS_NODE, Mod_ClearAll } from "../src/ref_soft/r_model";
import { SWimp_SetMode, SWimp_Shutdown } from "../src/platform/swimp";
import type { RefImports } from "../src/client/ref";
import type { CvarT } from "../src/shared/q_shared";

function fakeRefImports(): RefImports {
  return {
    Sys_Error(_err_level: number, str: string): never {
      throw new Error(str);
    },
    Cmd_AddCommand() {},
    Cmd_RemoveCommand() {},
    Cmd_Argc() {
      return 0;
    },
    Cmd_Argv() {
      return "";
    },
    Cmd_ExecuteText() {},
    Con_Printf() {},
    FS_LoadFile() {
      return { length: -1, data: null };
    },
    FS_FreeFile() {},
    FS_Gamedir() {
      return "";
    },
    Cvar_Get(): CvarT | null {
      return null;
    },
    Cvar_Set(): CvarT | null {
      return null;
    },
    Cvar_SetValue() {},
    Vid_GetModeInfo(mode: number) {
      if (mode === 3) return { width: 640, height: 480 };
      return null;
    },
    Vid_MenuInit() {},
    Vid_NewWindow() {},
  };
}

describe("ref_soft type core (r_local.ts / r_model.ts)", () => {
  test("core r_local.ts structs construct with faithful defaults", () => {
    const vrect = new VrectT();
    expect(vrect.x).toBe(0);
    expect(vrect.pnext).toBeNull();

    const viddef = new ViddefT();
    expect(viddef.buffer.length).toBe(0);
    expect(viddef.rowbytes).toBe(0);

    const oldrefdef = new OldrefdefT();
    expect(oldrefdef.vrect).toBeInstanceOf(VrectT);
    expect(oldrefdef.vieworg.length).toBe(3);

    const emit = new EmitpointT();
    expect(emit.u).toBe(0);

    const fv = new FinalvertT();
    expect(fv.xyz.length).toBe(3);

    const atd = new AffinetridescT();
    expect(atd.pfinalverts).toBeNull();

    const ds = new DrawsurfT();
    expect(ds.lightadj.length).toBe(4); // MAXLIGHTMAPS

    const bedge = new BedgeT();
    expect(bedge.v).toEqual([null, null]);

    const clip = new ClipplaneT();
    expect(clip.leftedge).toBe(0);

    const sc = new SurfcacheT();
    expect(sc.lightadj.length).toBe(4);
    expect(sc.data.length).toBe(0);

    const span = new EspanT();
    expect(span.count).toBe(0);

    const surf = new SurfT();
    expect(surf.spanstate).toBe(0);
    expect(surf.entity).toBeNull();

    const edge = new EdgeT();
    expect(edge.surfs).toEqual([0, 0]);

    const parms = new AliastriangleparmsT();
    expect(parms.a).toBeNull();

    const sw = new SwstateT();
    expect(sw.gammatable.length).toBe(256);
    expect(sw.currentpalette.length).toBe(1024);

    // singletons
    expect(r_refdef).toBeInstanceOf(OldrefdefT);
    expect(vid).toBeInstanceOf(ViddefT);
    expect(sw_state).toBeInstanceOf(SwstateT);
    expect(RserrT.rserr_ok).toBe(0);
  });

  test("r_model.ts structs construct with faithful defaults and share mplane_t with q_shared's CplaneT", () => {
    const mv = new MvertexT();
    expect(mv.position).toEqual(vec3());

    const img = new ImageT();
    expect(img.type).toBe(ImagetypeT.it_skin);
    expect(img.pixels).toHaveLength(4);

    const medge = new MedgeT();
    expect(medge.v).toEqual([0, 0]);

    const texinfo = new MtexinfoT();
    expect(texinfo.vecs).toHaveLength(2);
    expect(texinfo.vecs[0].length).toBe(4);

    const surf = new MsurfaceT();
    expect(surf.cachespots).toHaveLength(4); // MIPLEVELS
    expect(surf.styles).toHaveLength(4); // MAXLIGHTMAPS

    const node = new MnodeT();
    expect(node.contents).toBe(CONTENTS_NODE);
    expect(node.children).toEqual([null, null]);

    const leaf = new MleafT();
    expect(leaf.contents).toBe(0);

    // mplane_t reuses q_shared.ts's CplaneT (same layout as cplane_t)
    const plane: CplaneT = new CplaneT();
    surf.plane = plane;
    expect(surf.plane).toBeInstanceOf(CplaneT);

    expect(isMleaf(node)).toBe(false);
    expect(isMleaf(leaf)).toBe(true);

    const model = new ModelT();
    expect(model.type).toBe(ModtypeT.mod_bad);
    expect(model.skins).toHaveLength(32); // MAX_MD2SKINS
    expect(model.vis).toBeNull();
  });
});

describe("platform/swimp.ts (headless video)", () => {
  test("SWimp_SetMode allocates a correctly-sized headless framebuffer", () => {
    SetRefImports(fakeRefImports());

    const result = SWimp_SetMode(0, 0, 3, false);

    expect(result.rserr).toBe(RserrT.rserr_ok);
    expect(result.pwidth).toBe(640);
    expect(result.pheight).toBe(480);
    expect(vid.width).toBe(640);
    expect(vid.height).toBe(480);
    expect(vid.rowbytes).toBe(640);
    expect(vid.buffer).toBeInstanceOf(Uint8Array);
    expect(vid.buffer.length).toBe(640 * 480);

    SWimp_Shutdown();
    expect(vid.buffer.length).toBe(0);
  });

  test("SWimp_SetMode reports rserr_invalid_mode for an unknown mode", () => {
    SetRefImports(fakeRefImports());

    const result = SWimp_SetMode(0, 0, 999, false);

    expect(result.rserr).toBe(RserrT.rserr_invalid_mode);
  });
});

describe("bodyless C declarations", () => {
  test("Mod_ClearAll (bodyless in the C source) fails hard with its name", () => {
    expect(() => Mod_ClearAll()).toThrow(/Mod_ClearAll/);
  });
});
