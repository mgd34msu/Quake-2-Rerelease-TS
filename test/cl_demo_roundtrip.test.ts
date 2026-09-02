/*
Round-trip tests for demo RECORDING -> demo PLAYBACK, per protocol family.

Every byte here goes through the engine's own code, not a re-implementation
of it: cl_main.ts's CL_Record_f writes the startup block(s) and CL_Stop_f
closes the container, and cl_demo.ts's CL_PlayDemoFromBuffer reads them back
through the real CL_ParseServerMessage. What is asserted is what the
"demo recorded by this engine will not play back" defect actually broke:

  1. The recorded svc_serverdata's protocol number re-selects the SAME codec
     and the SAME configstring layout on the read side (cl_parse.ts's
     selectServerCodec). A demo written with one CS layout and read with
     another lands every "*N" inline-model string at the wrong index.
  2. Every configstring survives at its recorded index -- including the ones
     that only exist at the top of the WIDE layout, which is where a narrow
     reader blows up with "configstring > MAX_CONFIGSTRINGS".
  3. Entity baselines survive.
  4. The inline-model configstrings the demo carried resolve through
     CM_InlineModel once the map named by `cl.configstrings[CS_MODELS+1]` is
     loaded -- i.e. CL_PrepRefresh's model loop (cl_view.ts) can do its
     `cl.model_clip[i] = CM_InlineModel(fullName)` without Com_Erroring
     "CM_InlineModel: bad number".

A separate group at the bottom drives the real CL_PrepRefresh from the exact
state a `demomap` server leaves behind -- collision model holding the
attract-loop EMPTY map (sv_init.ts's `CM_LoadMap("", false)`, "no real map")
while cl.configstrings names the real one -- which is the state that produced
the reported "ERROR: CM_InlineModel: bad number".

No copyrighted content: the map is test/support/bsp_builder.ts's synthetic
box room, and every configstring is a made-up path.
*/

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cvar_ForceSet, Cvar_VariableString } from "../src/qcommon/cvar";
import { FS_InitFilesystem, FS_SetGamedir } from "../src/qcommon/files";
import { Cbuf_Init, Cmd_TokenizeString } from "../src/qcommon/cmd";
import { CM_LoadMap, CM_InlineModel, CM_NumInlineModels } from "../src/qcommon/cmodel";
import { SZ_Init } from "../src/qcommon/sizebuf";
import { net_message, net_message_buffer } from "../src/qcommon/net_chan";
import { PROTOCOL_VERSION, PROTOCOL_VERSION_RERELEASE, PROTOCOL_VERSION_RERELEASE_CLASSIC } from "../src/qcommon/qcommon";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { Q2REPRO_CODEC, Q2REPRO_CLASSIC_CODEC } from "../src/qcommon/protocol/q2repro";
import type { ProtocolCodec } from "../src/qcommon/protocol/codec";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, type CsRemapT } from "../src/shared/cs_remap";
import { CS_NAME } from "../src/shared/q_shared";
import { cl, cls, cl_entities, clCvars, ConnstateT, setRe } from "../src/client/client";
import { CL_Record_f, CL_Stop_f } from "../src/client/cl_main";
import { CL_PlayDemoFromBuffer } from "../src/client/cl_demo";
import { CL_PrepRefresh } from "../src/client/cl_view";
import { CG_GetActiveCgameKind, CG_SetActiveCgameKind, type CgameKind } from "../src/client/cgame/host";
import { buildBoxRoomBsp } from "./support/bsp_builder";

const BASEDIRNAME = "baseq2";
const MAP_CS = "maps/rtdemo.bsp";
const INLINE_MODELS = 3; // "*1".."*3" -- CM_NumInlineModels() ends up at 4

let tmpRoot: string;
let savedCgameKind: CgameKind;
let savedBasedir: string;
let savedGamedir: string;

beforeAll(() => {
  // rule 13: everything this file reaches for is a process-wide singleton.
  // The two that outlive a `cl.clear()` / `cls.clear()` are the ACTIVE CGAME
  // (CL_ParseServerData calls CG_SetActiveCgameKind off the demo's own
  // protocol, so replaying a 1038 demo leaves the kex cgame selected for
  // every later suite) and the filesystem's basedir/gamedir, both restored
  // in afterAll below.
  savedCgameKind = CG_GetActiveCgameKind();
  savedBasedir = Cvar_VariableString("basedir");
  savedGamedir = Cvar_VariableString("game");

  tmpRoot = mkdtempSync(join(tmpdir(), "q2demort-"));
  const baseq2Dir = join(tmpRoot, BASEDIRNAME);
  mkdirSync(join(baseq2Dir, "maps"), { recursive: true });
  writeFileSync(join(baseq2Dir, MAP_CS), buildBoxRoomBsp(undefined, { inlineModels: INLINE_MODELS }));

  // bypass CVAR_NOSET the way an early "+set basedir ..." would (the same
  // setup test/cmodel_map.test.ts and test/files_write.test.ts use)
  Cvar_ForceSet("basedir", tmpRoot);
  FS_InitFilesystem();
  FS_SetGamedir(BASEDIRNAME);

  // the recorded stream ends with svc_stufftext "precache\n" (CL_Record_f),
  // which CL_ParseServerMessage hands to Cbuf_AddText -- without a command
  // buffer that prints "Cbuf_AddText: overflow" on every playback below.
  Cbuf_Init();
});

afterAll(() => {
  CG_SetActiveCgameKind(savedCgameKind);
  Cvar_ForceSet("basedir", savedBasedir);
  FS_InitFilesystem();
  if (savedGamedir.length) FS_SetGamedir(savedGamedir);
  cl.clear();
  cls.clear();
  setRe(null);
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  // rule 13: net_message is a process-wide SizeBuf singleton and
  // CL_ReadDemoMessage repoints it at each demo block's own small buffer --
  // restore the real one so later suites still have MAX_MSGLEN of room (same
  // reason test/cl_demo.test.ts restores it).
  SZ_Init(net_message, net_message_buffer, net_message_buffer.length);
  cls.demorecording = false;
  cls.demofile = null;
});

interface FamilyT {
  name: string;
  protocol: number;
  codec: ProtocolCodec;
  csr: CsRemapT;
}

const FAMILIES: FamilyT[] = [
  { name: "vanilla (34)", protocol: PROTOCOL_VERSION, codec: VANILLA_CODEC, csr: CS_REMAP_OLD },
  { name: "kex (1038)", protocol: PROTOCOL_VERSION_RERELEASE, codec: Q2REPRO_CODEC, csr: CS_REMAP_RERELEASE },
  { name: "widened classic (4038)", protocol: PROTOCOL_VERSION_RERELEASE_CLASSIC, codec: Q2REPRO_CLASSIC_CODEC, csr: CS_REMAP_RERELEASE },
];

/*
Puts the client in the state CL_Record_f requires (ca_active on a live
session of `family`) and fills in the configstrings + baselines a real
session would be holding at that moment. Returns the configstring indices
the assertions below check, so the wide cases genuinely exercise indices
that do not exist in the narrow layout at all.
*/
function seedLiveSession(family: FamilyT): { inlineIdx: number[]; soundIdx: number; imageIdx: number; skinIdx: number } {
  cl.clear();
  cls.clear();
  setRe(null);

  cls.state = ConnstateT.ca_active;
  cls.codec = family.codec;
  cls.csr = family.csr;
  cls.serverProtocol = family.protocol;

  cl.servercount = 7;
  cl.playernum = 0;
  cl.gamedir = Cvar_VariableString("game");

  const csr = family.csr;
  cl.configstrings[CS_NAME] = "Round Trip";
  cl.configstrings[csr.mapchecksum] = "0";
  cl.configstrings[csr.models + 1] = MAP_CS;

  const inlineIdx: number[] = [];
  for (let n = 1; n <= INLINE_MODELS; n++) {
    const idx = csr.models + 1 + n;
    cl.configstrings[idx] = `*${n}`;
    inlineIdx.push(idx);
  }
  // a non-inline model after them, so the read side has to keep the whole
  // run in order rather than just the first few entries
  cl.configstrings[csr.models + 1 + INLINE_MODELS + 1] = "models/objects/barrels/tris.md2";

  // one entry in each of the blocks that MOVE between the two layouts --
  // these are the indices a mismatched reader rejects outright
  const soundIdx = csr.sounds + 5;
  const imageIdx = csr.images + 2;
  const skinIdx = csr.playerskins;
  cl.configstrings[soundIdx] = "world/rt_ping.wav";
  cl.configstrings[imageIdx] = "rt_icon";
  cl.configstrings[skinIdx] = "roundtrip\\male/grunt";

  // two entity baselines (CL_Record_f skips entity 0 and any entity whose
  // baseline modelindex is 0)
  cl_entities[1].baseline.number = 1;
  cl_entities[1].baseline.modelindex = 2;
  cl_entities[1].baseline.frame = 3;
  cl_entities[9].baseline.number = 9;
  cl_entities[9].baseline.modelindex = 4;
  cl_entities[9].baseline.frame = 11;

  return { inlineIdx, soundIdx, imageIdx, skinIdx };
}

/** Runs the real CL_Record_f / CL_Stop_f and returns the .dm2 bytes. */
function recordToBytes(name: string): Uint8Array {
  Cmd_TokenizeString(`record ${name}`, false);
  CL_Record_f();
  expect(cls.demorecording).toBe(true);
  CL_Stop_f();
  expect(cls.demorecording).toBe(false);
  return new Uint8Array(readFileSync(join(tmpRoot, BASEDIRNAME, "demos", `${name}.dm2`)));
}

describe("demo record -> playback round trip, per protocol family", () => {
  for (const family of FAMILIES) {
    test(`${family.name}: protocol, configstring indices, baselines and inline models survive`, () => {
      const seeded = seedLiveSession(family);
      const recordedName = cl.configstrings[family.csr.models + 1];
      const bytes = recordToBytes(`rt${family.protocol}`);
      expect(bytes.length).toBeGreaterThan(16);

      // ---- playback through the real reader ----
      CL_PlayDemoFromBuffer(bytes);

      // 1. the recorded protocol number re-selected the same codec/layout
      expect(cls.serverProtocol).toBe(family.protocol);
      expect(cls.csr).toBe(family.csr);
      expect(cls.codec.name).toBe(family.codec.name);

      // 2. configstrings survived at their recorded indices
      expect(cl.configstrings[CS_NAME]).toBe("Round Trip");
      expect(cl.configstrings[cls.csr.models + 1]).toBe(recordedName);
      for (let n = 1; n <= INLINE_MODELS; n++) {
        expect(cl.configstrings[seeded.inlineIdx[n - 1]]).toBe(`*${n}`);
      }
      expect(cl.configstrings[cls.csr.models + 1 + INLINE_MODELS + 1]).toBe("models/objects/barrels/tris.md2");
      expect(cl.configstrings[seeded.soundIdx]).toBe("world/rt_ping.wav");
      expect(cl.configstrings[seeded.imageIdx]).toBe("rt_icon");
      expect(cl.configstrings[seeded.skinIdx]).toBe("roundtrip\\male/grunt");

      // 3. baselines survived
      expect(cl_entities[1].baseline.modelindex).toBe(2);
      expect(cl_entities[1].baseline.frame).toBe(3);
      expect(cl_entities[9].baseline.modelindex).toBe(4);
      expect(cl_entities[9].baseline.frame).toBe(11);

      // 4. the inline-model configstrings resolve once the map the demo
      //    named is loaded -- exactly the pair of operations CL_Precache_f's
      //    old-demo branch and CL_PrepRefresh's model loop perform.
      CM_LoadMap("", false); // demo server state: sv_init.ts's "no real map"
      expect(CM_NumInlineModels()).toBe(0);
      CM_LoadMap(cl.configstrings[cls.csr.models + 1], true);
      expect(CM_NumInlineModels()).toBe(INLINE_MODELS + 1);
      for (let n = 1; n <= INLINE_MODELS; n++) {
        expect(CM_InlineModel(cl.configstrings[seeded.inlineIdx[n - 1]])).not.toBeNull();
      }
    });
  }

  test("a demo recorded on the wide layout is NOT silently readable as narrow (the layout really is carried by the protocol number)", () => {
    // Guards the actual failure mode: the wide session writes configstrings
    // at indices far past MAX_CONFIGSTRINGS, so a reader that picked the
    // narrow layout would reject them. Asserting the recorded index proves
    // the demo's own bytes carry the wide layout, and the round-trip test
    // above proves the reader picks it back up off the protocol number.
    const family = FAMILIES[1]; // kex (1038)
    const seeded = seedLiveSession(family);
    expect(seeded.skinIdx).toBeGreaterThan(CS_REMAP_OLD.end);

    const bytes = recordToBytes("rtwide");
    CL_PlayDemoFromBuffer(bytes);
    expect(cls.csr.end).toBe(CS_REMAP_RERELEASE.end);
    expect(cl.configstrings[seeded.skinIdx]).toBe("roundtrip\\male/grunt");
  });
});

/*
CL_PrepRefresh from a demo server's collision-model state. cl_main.ts's
CL_Frame reaches CL_PrepRefresh directly ("if (!cl.refresh_prepped &&
cls.state === ca_active) CL_PrepRefresh()", straight out of cl_main.c) with
no CM_LoadMap in between -- on a `demomap` server that call can land while
the stuffed "precache" command is still sitting in the command buffer, so
the only map cmodel.ts holds is the empty attract-loop one.
*/
describe("cl_view.ts -- CL_PrepRefresh on a demo server's empty collision model", () => {
  beforeEach(() => {
    cl.clear();
    cls.clear();
    cls.csr = CS_REMAP_OLD;
    cls.state = ConnstateT.ca_active;
    clCvars.cl_noskins = null;
    clCvars.cl_vwep = null;
    setRe(makeFakeRe());
  });

  afterEach(() => {
    setRe(null);
  });

  test("loads the map named by CS_MODELS+1 itself, so every '*N' configstring resolves", () => {
    // the state SV_SpawnServer leaves behind for ss_demo/ss_cinematic/ss_pic
    CM_LoadMap("", false);
    expect(CM_NumInlineModels()).toBe(0);

    cl.configstrings[cls.csr.models + 1] = MAP_CS;
    for (let n = 1; n <= INLINE_MODELS; n++) cl.configstrings[cls.csr.models + 1 + n] = `*${n}`;

    CL_PrepRefresh();

    expect(CM_NumInlineModels()).toBe(INLINE_MODELS + 1);
    for (let n = 1; n <= INLINE_MODELS; n++) {
      expect(cl.model_clip[1 + n]).not.toBeNull();
    }
    expect(cl.refresh_prepped).toBe(true);
  });

  test("still early-outs with no map configstring at all (unchanged)", () => {
    CM_LoadMap("", false);
    cl.configstrings[cls.csr.models + 1] = "";
    CL_PrepRefresh();
    expect(cl.refresh_prepped).toBe(false);
  });
});

// Minimal RefExports stand-in -- same shape test/cgame_host_kfont_source.test.ts
// uses; nothing here inspects what CL_PrepRefresh registers, only that the
// collision-model side of it comes out right.
function makeFakeRe(): Parameters<typeof setRe>[0] {
  const re = {
    api_version: 3,
    Init: () => true,
    Shutdown: () => undefined,
    BeginRegistration: () => undefined,
    RegisterModel: () => null,
    RegisterSkin: () => null,
    RegisterPic: () => ({}),
    RegisterRawPic: () => ({}),
    SetSky: () => undefined,
    EndRegistration: () => undefined,
    RenderFrame: () => undefined,
    SupportsPerPixelLighting: () => false,
    DrawGetPicSize: () => ({ w: 0, h: 0 }),
    DrawPic: () => undefined,
    DrawStretchPic: () => undefined,
    DrawColorPic: () => undefined,
    DrawStretchPicRegion: () => undefined,
    DrawChar: () => undefined,
    DrawTileClear: () => undefined,
    DrawFill: () => undefined,
    DrawFadeScreen: () => undefined,
    DrawStretchRaw: () => undefined,
    CinematicSetPalette: () => undefined,
    SetGifBeatSeconds: () => undefined,
    BeginFrame: () => undefined,
    EndFrame: () => undefined,
    AppActivate: () => undefined,
  };
  return re as unknown as Parameters<typeof setRe>[0];
}
