/*
Tests for src/client/menu.ts's PlayerConfig_MenuDraw (the "Player Setup" 3D
model preview) and PlayerConfig_MenuInit's widget layout -- 2026-08-30 audit
task brief item 1/2: the preview box used to draw its frame with no model
inside (RegisterModel/RegisterSkin were called, but no refdef was ever built
and re.RenderFrame was never invoked at all). Covers:

  1. M_Menu_PlayerConfig_f + M_Draw actually renders the preview: with a
     real player model discoverable (via a fabricated pak, exercising the
     SAME FS_ListPakFiles path real rerelease data uses -- see
     PlayerConfig_ScanDirectories's phase 2), RegisterModel/RegisterSkin/
     RenderFrame/DrawPic(icon) fire in that order, and the refdef/entity
     RenderFrame receives match menu.c:PlayerConfig_MenuDraw's field values
     exactly (x/y/width/height/fov_x/fov_y/rdflags/num_entities/areabits,
     entity flags/origin/oldorigin/frame/oldframe/backlerp).
  2. The "static int yaw" port: entity.angles[1] advances by exactly 2 per
     draw (yaw++ feeding the assignment, then ++yaw in the wrap check --
     both fire every frame in the C), reproduced bug-for-bug rather than
     "fixed" to 1/frame.
  3. PlayerConfig_MenuInit's widget x/y layout matches menu.c's literals
     exactly (this file's own audit found no deviation here, but pins it).

Self-sufficient per PORTING.md rule 13: files.ts's fs_searchpaths/fs_gamedir
are process-wide singletons other test files also touch, so this file uses
its own uniquely-named temp basedir/pak and asserts only on the specific
"male" player directory it mounts, not on the whole scan result. viddef
(vid.ts) is likewise a process-wide singleton -- set explicitly here rather
than assumed left at any particular value by another file. `re` is reset to
null in a `finally` after every test that sets it, matching cl_menu.test.ts's
own precedent for its fake-RefExports tests.
*/

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cvar_ForceSet } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_SetGamedir, FS_WriteFile, FS_AddPak } from "../src/qcommon/files";
import { BASEDIRNAME } from "../src/qcommon/qcommon";
import { cls, setRe, KeydestT } from "../src/client/client";
import { viddef } from "../src/client/vid";
import { CalcFov } from "../src/client/cl_view";
import { RF_FULLBRIGHT, RDF_NOWORLDMODEL } from "../src/shared/q_shared";
import { API_VERSION, type RefExports, type ModelS, type ImageS } from "../src/client/ref";
import {
  M_Menu_PlayerConfig_f,
  M_Draw,
  M_ForceMenuOff,
  s_player_config_menu,
  s_player_name_field,
  s_player_model_title,
  s_player_model_box,
  s_player_skin_title,
  s_player_skin_box,
  s_player_hand_title,
  s_player_handedness_box,
  s_player_rate_title,
  s_player_rate_box,
  s_player_download_action,
} from "../src/client/menu";

function buildPak(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const PACKFILE_NAME_LEN = 56;
  const DPACKFILE_SIZE = PACKFILE_NAME_LEN + 8;
  const headerSize = 12;
  let dataSize = 0;
  for (const e of entries) dataSize += e.data.length;
  const dirLen = entries.length * DPACKFILE_SIZE;
  const total = headerSize + dataSize + dirLen;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint8(0, "P".charCodeAt(0));
  view.setUint8(1, "A".charCodeAt(0));
  view.setUint8(2, "C".charCodeAt(0));
  view.setUint8(3, "K".charCodeAt(0));
  const dirOfs = headerSize + dataSize;
  view.setInt32(4, dirOfs, true);
  view.setInt32(8, dirLen, true);

  let dataCursor = headerSize;
  let dirCursor = dirOfs;
  for (const e of entries) {
    buf.set(e.data, dataCursor);
    for (let j = 0; j < e.name.length; j++) buf[dirCursor + j] = e.name.charCodeAt(j);
    view.setInt32(dirCursor + PACKFILE_NAME_LEN, dataCursor, true);
    view.setInt32(dirCursor + PACKFILE_NAME_LEN + 4, e.data.length, true);
    dataCursor += e.data.length;
    dirCursor += DPACKFILE_SIZE;
  }
  return buf;
}

// Full RefExports fake -- every member implemented (no partial/cast), same
// idiom as test/cl_menu.test.ts's own fakeRe. RegisterModel/RegisterSkin
// return a distinct marker object per call so RenderFrame's entity.model/
// entity.skin can be checked for referential identity back to the exact
// registration call PlayerConfig_MenuDraw made.
function fakeRe(calls: string[], renderedRefdefs: Parameters<RefExports["RenderFrame"]>[0][]): RefExports {
  return {
    api_version: API_VERSION,
    Init: () => true,
    Shutdown: () => {},
    BeginRegistration: () => {},
    RegisterModel: (name: string): ModelS => {
      calls.push(`RegisterModel:${name}`);
      return { markerModel: name };
    },
    RegisterSkin: (name: string): ImageS => {
      calls.push(`RegisterSkin:${name}`);
      return { markerSkin: name };
    },
    RegisterPic: () => null,
    SetSky: () => {},
    EndRegistration: () => {},
    RenderFrame: (fd) => {
      calls.push("RenderFrame");
      renderedRefdefs.push(fd);
    },
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: (_x, _y, name) => {
      calls.push(`DrawPic:${name}`);
    },
    DrawStretchPic: () => {},
    DrawColorPic: () => {},
    DrawStretchPicRegion: () => {},
    DrawChar: () => {},
    DrawTileClear: () => {},
    DrawFill: () => {},
    DrawFadeScreen: () => {},
    DrawStretchRaw: () => {},
    CinematicSetPalette: () => {},
    BeginFrame: () => {},
    EndFrame: () => {},
    AppActivate: () => {},
  };
}

describe("menu.ts -- PlayerConfig_MenuDraw's 3D preview (2026-08-30 audit item 1)", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "q2playerconfig-"));
    Cvar_ForceSet("basedir", tmpRoot);
    FS_InitFilesystem();
    FS_SetGamedir(BASEDIRNAME);

    // A minimal "male" player directory, shipped INSIDE a pak -- exercises
    // PlayerConfig_ScanDirectories's phase 2 (FS_ListPakFiles), the same
    // path real rerelease data uses (players/ lives inside pak0.pak on
    // both basedirs in practice). Model/skin file CONTENTS are never read
    // by this test -- RegisterModel/RegisterSkin are the fake `re`'s
    // responsibility, not the real renderer -- so placeholder bytes are
    // enough to make the files exist for FS_ListPakFiles' directory walk.
    const pak = buildPak([
      { name: "players/male/tris.md2", data: new Uint8Array([0]) },
      { name: "players/male/grunt.pcx", data: new Uint8Array([0]) },
      { name: "players/male/grunt_i.pcx", data: new Uint8Array([0]) },
    ]);
    const diskPath = join(tmpRoot, "players.pak");
    FS_WriteFile(diskPath, pak);
    expect(FS_AddPak(diskPath)).toBe(true);

    Cvar_ForceSet("skin", "male/grunt");
    Cvar_ForceSet("hand", "0");
    Cvar_ForceSet("name", "tester");

    viddef.width = 640;
    viddef.height = 480;
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("opens cleanly and reaches the PlayerConfig screen (not the 'no valid player models' fallback)", () => {
    M_ForceMenuOff();
    expect(() => M_Menu_PlayerConfig_f()).not.toThrow();
    expect(cls.key_dest).toBe(KeydestT.key_menu);
    M_ForceMenuOff();
  });

  test("RegisterModel/RegisterSkin/RenderFrame/DrawPic fire in order, with a refdef/entity matching menu.c exactly", () => {
    const calls: string[] = [];
    const refdefs: Parameters<RefExports["RenderFrame"]>[0][] = [];
    setRe(fakeRe(calls, refdefs));
    try {
      M_ForceMenuOff();
      M_Menu_PlayerConfig_f();
      M_Draw();

      const tagged = calls.filter((c) => c.startsWith("RegisterModel:") || c.startsWith("RegisterSkin:") || c === "RenderFrame" || c.startsWith("DrawPic:"));
      expect(tagged).toEqual(["RegisterModel:players/male/tris.md2", "RegisterSkin:players/male/grunt.pcx", "RenderFrame", "DrawPic:/players/male/grunt_i.pcx"]);

      expect(refdefs.length).toBe(1);
      const fd = refdefs[0];
      if (!fd) throw new Error("RenderFrame never received a refdef");

      // menu.c: refdef.x = viddef.width/2; refdef.y = viddef.height/2-72;
      // refdef.width=144; refdef.height=168 (then +=4 right before
      // RenderFrame -> 172); fov_x=40; fov_y=CalcFov(fov_x,144,168) (the
      // ORIGINAL height, before the +=4); rdflags=RDF_NOWORLDMODEL;
      // num_entities=1; areabits=0/null.
      expect(fd.x).toBe(viddef.width / 2);
      expect(fd.y).toBe(viddef.height / 2 - 72);
      expect(fd.width).toBe(144);
      expect(fd.height).toBe(172);
      expect(fd.fov_x).toBe(40);
      expect(fd.fov_y).toBe(CalcFov(40, 144, 168));
      expect(fd.rdflags).toBe(RDF_NOWORLDMODEL);
      expect(fd.num_entities).toBe(1);
      expect(fd.areabits).toBeNull();

      expect(fd.entities.length).toBe(1);
      const ent = fd.entities[0];
      if (!ent) throw new Error("refdef.entities[0] missing");

      expect(ent.model).toEqual({ markerModel: "players/male/tris.md2" });
      expect(ent.skin).toEqual({ markerSkin: "players/male/grunt.pcx" });
      expect(ent.flags).toBe(RF_FULLBRIGHT);
      expect(Array.from(ent.origin)).toEqual([80, 0, 0]);
      expect(Array.from(ent.oldorigin)).toEqual([80, 0, 0]);
      expect(ent.frame).toBe(0);
      expect(ent.oldframe).toBe(0);
      expect(ent.backlerp).toBe(0);
    } finally {
      setRe(null);
      M_ForceMenuOff();
    }
  });

  test("the preview model keeps rotating: entity.angles[1] advances by exactly 2 per draw (yaw++ ; ++yaw, both fire every frame in the C)", () => {
    const calls: string[] = [];
    const refdefs: Parameters<RefExports["RenderFrame"]>[0][] = [];
    setRe(fakeRe(calls, refdefs));
    try {
      M_ForceMenuOff();
      M_Menu_PlayerConfig_f();
      M_Draw();
      M_Draw();

      expect(refdefs.length).toBe(2);
      const first = refdefs[0]?.entities[0]?.angles[1];
      const second = refdefs[1]?.entities[0]?.angles[1];
      if (first === undefined || second === undefined) throw new Error("angles[1] missing on a rendered entity");

      expect((second - first + 360) % 360).toBe(2);
    } finally {
      setRe(null);
      M_ForceMenuOff();
    }
  });

  test("PlayerConfig_MenuInit's widget layout matches menu.c:PlayerConfig_MenuInit exactly", () => {
    M_ForceMenuOff();
    M_Menu_PlayerConfig_f();
    try {
      expect(s_player_config_menu.x).toBe(viddef.width / 2 - 95);
      expect(s_player_config_menu.y).toBe(viddef.height / 2 - 97);

      expect(s_player_name_field.generic.x).toBe(0);
      expect(s_player_name_field.generic.y).toBe(0);

      expect(s_player_model_title.generic.x).toBe(-8);
      expect(s_player_model_title.generic.y).toBe(60);
      expect(s_player_model_box.generic.x).toBe(-56);
      expect(s_player_model_box.generic.y).toBe(70);

      expect(s_player_skin_title.generic.x).toBe(-16);
      expect(s_player_skin_title.generic.y).toBe(84);
      expect(s_player_skin_box.generic.x).toBe(-56);
      expect(s_player_skin_box.generic.y).toBe(94);

      expect(s_player_hand_title.generic.x).toBe(32);
      expect(s_player_hand_title.generic.y).toBe(108);
      expect(s_player_handedness_box.generic.x).toBe(-56);
      expect(s_player_handedness_box.generic.y).toBe(118);

      expect(s_player_rate_title.generic.x).toBe(56);
      expect(s_player_rate_title.generic.y).toBe(156);
      expect(s_player_rate_box.generic.x).toBe(-56);
      expect(s_player_rate_box.generic.y).toBe(166);

      expect(s_player_download_action.generic.x).toBe(-24);
      expect(s_player_download_action.generic.y).toBe(186);
    } finally {
      M_ForceMenuOff();
    }
  });
});
