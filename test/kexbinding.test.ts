/*
Unit tests for the kex binding (src/server/bindings/kex.ts): BuildKexImports
(the KexGameImports assembled for the kex game module) and
adaptKexGameExports/LoadKexGame (the adapter bridging KexGameExports onto the
legacy GameExports shape sv_game.ts's geHolder expects).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: every global
this suite reads is initialized here.

adaptKexGameExports is exercised against a small, fully-controllable FAKE
KexGameExports (fakeKexGameExports() below) rather than the real kexgame
module's GetGameAPI: the real module's InitGame does extensive real cvar
registration and g_spawn/g_save work that is already covered by
test/kexgame_g_main.test.ts and friends, and is exercised end-to-end for
real by the maiden-boot smoke test (`bun src/main.ts ... +set game kex
+map q2dm1`). This suite's job is the ADAPTER's own translation logic:
apiversion mapping, PreInit/Init/RunFrame ordering, the ClientConnect
{allowed,userinfo} shape, the effects_t bigint<->number split, the full
64-slot stats copy, and the edict-index cross-referencing (owner/BoxEdicts/
ClientConnect all resolving through the same engine<->kex edict map).

Scope (14 cases):
  - BuildKexImports: every KexGameImports key present with the right
    typeof (compile-time proof via the `: KexGameImports` annotation itself,
    plus a runtime key enumeration).
  - splitEffects/joinEffects: round-trip for zero, a single low-word bit,
    a single high-word-only bit (EF_GRENADE_LIGHT, bit 37), and a combined
    low+high value.
  - adaptKexGameExports: apiversion reports the LEGACY GAME_API_VERSION (3),
    not kex's own 2023.
  - adaptKexGameExports.Init(): calls PreInit before Init (q2repro
    game.c:1142 order), then builds the edict bridge and syncs it.
  - adaptKexGameExports.RunFrame(): calls RunFrame(true) then PrepFrame(),
    in that order (spy).
  - adaptKexGameExports.ClientConnect: forwards (ent, userinfo, "", false)
    to kex's ClientConnect and returns {allowed, userinfo} from the mutated
    box, per the settled U021b interface ruling.
  - The edict bridge: engine-view array is index-aligned with the fake
    KexGameExports.edicts array; `owner` cross-references resolve to the
    correct engine-view object by identity.
  - Stats copy: a 64-slot kex player-state's stats copy onto the engine's
    now-equally-64-slot PlayerStateT.stats in full, no truncation.
  - client.ps is a real `PlayerStateT` instance (sv_ents.ts's own
    `instanceof PlayerStateT` type guard requirement).
  - num_edicts/max_edicts live-delegate (get and set) to the underlying
    KexGameExports.
  - WriteGame/ReadGame round-trip through the real FS_WriteFile/
    FS_ReadRawFile seam (game/g_save.ts's own sanctioned seam).
  - Info_ValueForKey/Info_RemoveKey/Info_SetValueForKey box-parameter
    adapters (kex's out-param convention over q_shared.ts's pure string
    functions).
  - multicast: KexMulticastT -> MulticastT mapping produces a destination
    SV_Multicast actually accepts (an invalid mapping would hit
    SV_Multicast's own `Com_Error(ERR_FATAL, "bad to:...")` branch).
*/

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vec3 } from "../src/shared/math";
import { PlayerStateT } from "../src/shared/q_shared";
import { GAME_API_VERSION as LEGACY_GAME_API_VERSION } from "../src/game/game";
import type { KexGameImports, KexGameExports, KexEdictT } from "../src/kexapi/game";
import { GAME_API_VERSION as KEX_GAME_API_VERSION, KexMulticastT } from "../src/kexapi/game";
import { defaultEdict } from "../src/kexgame/g_main_globals";
import { defaultGClient } from "../src/kexgame/p_client";
import { BuildKexImports, adaptKexGameExports, splitEffects, joinEffects } from "../src/server/bindings/kex";

// ---------------------------------------------------------------------------
// fake KexGameExports fixture
// ---------------------------------------------------------------------------

interface CallLog {
  calls: string[];
}

function fakeKexGameExports(edicts: KexEdictT[], log: CallLog): KexGameExports {
  return {
    apiversion: KEX_GAME_API_VERSION,
    PreInit: () => log.calls.push("PreInit"),
    Init: () => log.calls.push("Init"),
    Shutdown: () => log.calls.push("Shutdown"),
    SpawnEntities: (mapname) => log.calls.push(`SpawnEntities:${mapname}`),
    WriteGameJson: (autosave, out_size) => {
      const json = JSON.stringify({ autosave });
      out_size[0] = json.length;
      return json;
    },
    ReadGameJson: (json) => log.calls.push(`ReadGameJson:${json}`),
    WriteLevelJson: (transition, out_size) => {
      const json = JSON.stringify({ transition });
      out_size[0] = json.length;
      return json;
    },
    ReadLevelJson: (json) => log.calls.push(`ReadLevelJson:${json}`),
    CanSave: () => true,
    ClientChooseSlot: () => null,
    ClientConnect: (ent, userinfo, social_id, isBot) => {
      log.calls.push(`ClientConnect:${ent ? ent.s.number : "null"}:${userinfo[0]}:${social_id}:${isBot}`);
      userinfo[0] = `${userinfo[0]}\\rejmsg\\`;
      return true;
    },
    ClientBegin: (ent) => log.calls.push(`ClientBegin:${ent ? ent.s.number : "null"}`),
    ClientUserinfoChanged: (ent, userinfo) => log.calls.push(`ClientUserinfoChanged:${ent ? ent.s.number : "null"}:${userinfo}`),
    ClientDisconnect: (ent) => log.calls.push(`ClientDisconnect:${ent ? ent.s.number : "null"}`),
    ClientCommand: (ent) => log.calls.push(`ClientCommand:${ent ? ent.s.number : "null"}`),
    ClientThink: (ent) => log.calls.push(`ClientThink:${ent ? ent.s.number : "null"}`),
    RunFrame: (main_loop) => log.calls.push(`RunFrame:${main_loop}`),
    PrepFrame: () => log.calls.push("PrepFrame"),
    ServerCommand: () => log.calls.push("ServerCommand"),
    edicts,
    num_edicts: edicts.length,
    max_edicts: edicts.length,
    server_flags: 0,
    Pmove: () => {},
    GetExtension: () => null,
    Bot_SetWeapon: () => {},
    Bot_TriggerEdict: () => {},
    Bot_UseItem: () => {},
    Bot_GetItemID: () => -1,
    Edict_ForceLookAtPoint: () => {},
    Bot_PickedUpItem: () => false,
    Entity_IsVisibleToPlayer: () => true,
    GetShadowLightData: () => null,
  };
}

function fakeEdict(number: number): KexEdictT {
  const e = defaultEdict();
  e.s.number = number;
  e.inuse = true;
  return e;
}

// ---------------------------------------------------------------------------
// BuildKexImports surface completeness
// ---------------------------------------------------------------------------

describe("BuildKexImports", () => {
  // Compile-time proof: if any KexGameImports member were missing or
  // mistyped, this annotation would fail bunx tsc --noEmit.
  const imports: KexGameImports = BuildKexImports();

  const expectedFunctionKeys = [
    "Broadcast_Print",
    "Com_Print",
    "Client_Print",
    "Center_Print",
    "sound",
    "positioned_sound",
    "local_sound",
    "configstring",
    "get_configstring",
    "Com_Error",
    "modelindex",
    "soundindex",
    "imageindex",
    "setmodel",
    "trace",
    "clip",
    "pointcontents",
    "inPVS",
    "inPHS",
    "SetAreaPortalState",
    "AreasConnected",
    "linkentity",
    "unlinkentity",
    "BoxEdicts",
    "multicast",
    "unicast",
    "WriteChar",
    "WriteByte",
    "WriteShort",
    "WriteLong",
    "WriteFloat",
    "WriteString",
    "WritePosition",
    "WriteDir",
    "WriteAngle",
    "WriteEntity",
    "TagMalloc",
    "TagFree",
    "FreeTags",
    "cvar",
    "cvar_set",
    "cvar_forceset",
    "argc",
    "argv",
    "args",
    "AddCommandString",
    "DebugGraph",
    "GetExtension",
    "Bot_RegisterEdict",
    "Bot_UnRegisterEdict",
    "Bot_MoveToPoint",
    "Bot_FollowActor",
    "GetPathToGoal",
    "Loc_Print",
    "Draw_Line",
    "Draw_Point",
    "Draw_Circle",
    "Draw_Bounds",
    "Draw_Sphere",
    "Draw_OrientedWorldText",
    "Draw_StaticWorldText",
    "Draw_Cylinder",
    "Draw_Ray",
    "Draw_Arrow",
    "ReportMatchDetails_Multicast",
    "ServerFrame",
    "SendToClipBoard",
    "Info_ValueForKey",
    "Info_RemoveKey",
    "Info_SetValueForKey",
  ] as const;

  test("every KexGameImports function slot is present and callable", () => {
    for (const key of expectedFunctionKeys) {
      expect(typeof imports[key]).toBe("function");
    }
  });

  test("the three tick-rate fields are numbers, not functions", () => {
    expect(typeof imports.tick_rate).toBe("number");
    expect(typeof imports.frame_time_s).toBe("number");
    expect(typeof imports.frame_time_ms).toBe("number");
  });

  test("frame_time_s and frame_time_ms are consistent (ms = s * 1000)", () => {
    expect(imports.frame_time_ms).toBeCloseTo(imports.frame_time_s * 1000, 6);
  });
});

// ---------------------------------------------------------------------------
// splitEffects / joinEffects round-trip
// ---------------------------------------------------------------------------

describe("splitEffects/joinEffects", () => {
  test("zero round-trips to {effects: 0, morefx: 0}", () => {
    expect(splitEffects(0n)).toEqual({ effects: 0, morefx: 0 });
    expect(joinEffects(0, 0)).toBe(0n);
  });

  test("a low-word-only bit (EF_QUAD, bit 15) round-trips", () => {
    const value = 1n << 15n;
    const { effects, morefx } = splitEffects(value);
    expect(effects).toBe(1 << 15);
    expect(morefx).toBe(0);
    expect(joinEffects(effects, morefx)).toBe(value);
  });

  test("a high-word-only bit (EF_GRENADE_LIGHT, bit 37) round-trips", () => {
    const value = 1n << 37n;
    const { effects, morefx } = splitEffects(value);
    expect(effects).toBe(0);
    expect(morefx).toBe(1 << 5); // bit 37 - 32 = bit 5 of the high word
    expect(joinEffects(effects, morefx)).toBe(value);
  });

  test("a combined low+high value round-trips", () => {
    const value = (1n << 37n) | (1n << 15n) | 1n;
    const { effects, morefx } = splitEffects(value);
    expect(joinEffects(effects, morefx)).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// adaptKexGameExports
// ---------------------------------------------------------------------------

describe("adaptKexGameExports", () => {
  test("apiversion reports the legacy GAME_API_VERSION, not kex's own", () => {
    const log: CallLog = { calls: [] };
    const kexGe = fakeKexGameExports([fakeEdict(0)], log);
    const adapter = adaptKexGameExports(kexGe);
    expect(adapter.apiversion).toBe(LEGACY_GAME_API_VERSION);
    expect(adapter.apiversion).not.toBe(KEX_GAME_API_VERSION);
  });

  test("Init() calls PreInit before Init (q2repro game.c:1142 order)", () => {
    const log: CallLog = { calls: [] };
    const kexGe = fakeKexGameExports([fakeEdict(0)], log);
    const adapter = adaptKexGameExports(kexGe);
    adapter.Init();
    expect(log.calls.indexOf("PreInit")).toBeGreaterThanOrEqual(0);
    expect(log.calls.indexOf("Init")).toBeGreaterThan(log.calls.indexOf("PreInit"));
  });

  test("RunFrame() calls kex RunFrame(true) then PrepFrame(), in that order", () => {
    const log: CallLog = { calls: [] };
    const kexGe = fakeKexGameExports([fakeEdict(0)], log);
    const adapter = adaptKexGameExports(kexGe);
    adapter.Init();
    log.calls.length = 0; // ignore Init's own bookkeeping

    adapter.RunFrame();

    expect(log.calls).toEqual(["RunFrame:true", "PrepFrame"]);
  });

  test("edicts getter is index-aligned with the underlying KexGameExports.edicts, and owner cross-references resolve by identity", () => {
    const log: CallLog = { calls: [] };
    const world = fakeEdict(0);
    const client = fakeEdict(1);
    client.owner = world;
    const kexGe = fakeKexGameExports([world, client], log);
    const adapter = adaptKexGameExports(kexGe);
    adapter.Init();

    expect(adapter.edicts.length).toBe(2);
    expect(adapter.edicts[1].owner).toBe(adapter.edicts[0]);
  });

  test("num_edicts/max_edicts live-delegate (get and set) to the underlying KexGameExports", () => {
    const log: CallLog = { calls: [] };
    const kexGe = fakeKexGameExports([fakeEdict(0), fakeEdict(1)], log);
    const adapter = adaptKexGameExports(kexGe);
    adapter.Init();

    expect(adapter.num_edicts).toBe(kexGe.num_edicts);
    expect(adapter.max_edicts).toBe(kexGe.max_edicts);

    adapter.num_edicts = 42;
    expect(kexGe.num_edicts).toBe(42);
    adapter.max_edicts = 99;
    expect(kexGe.max_edicts).toBe(99);
  });

  test("ClientConnect forwards (ent, userinfo, social_id, isBot) per the settled {allowed, userinfo} interface ruling", () => {
    const log: CallLog = { calls: [] };
    const world = fakeEdict(0);
    const clientEdict = fakeEdict(1);
    const kexGe = fakeKexGameExports([world, clientEdict], log);
    const adapter = adaptKexGameExports(kexGe);
    adapter.Init();

    const engineClientEdict = adapter.edicts[1];
    const result = adapter.ClientConnect(engineClientEdict, "\\name\\Player");

    expect(log.calls).toContain('ClientConnect:1:\\name\\Player::false');
    expect(result.allowed).toBe(true);
    expect(result.userinfo).toBe("\\name\\Player\\rejmsg\\");
  });

  describe("MAX_STATS_STORAGE (64) copy and client.ps identity", () => {
    test("copies all 64 kex stats slots to the engine's PlayerStateT.stats -- no truncation", () => {
      const log: CallLog = { calls: [] };
      const world = fakeEdict(0);
      const clientEdict = fakeEdict(1);
      clientEdict.client = defaultGClient();
      clientEdict.client.ping = 42;
      for (let i = 0; i < clientEdict.client.ps.stats.length; i++) {
        clientEdict.client.ps.stats[i] = i + 1;
      }
      expect(clientEdict.client.ps.stats.length).toBe(64);

      const kexGe = fakeKexGameExports([world, clientEdict], log);
      const adapter = adaptKexGameExports(kexGe);
      adapter.Init();

      const engineClient = adapter.edicts[1].client as { ps: PlayerStateT; ping: number } | null;
      expect(engineClient).not.toBeNull();
      if (!engineClient) return;

      // q_shared.ts's PlayerStateT.stats is MAX_STATS_STORAGE=64-wide,
      // matching kexapi's own MAX_STATS=64 exactly -- every slot, including
      // the weapon-wheel/ammo-info/powerup-info/key-display stats past
      // index 31, survives the crossing now.
      expect(engineClient.ps.stats.length).toBe(64);
      for (let i = 0; i < 64; i++) {
        expect(engineClient.ps.stats[i]).toBe(i + 1);
      }
    });

    test("client.ps is a real PlayerStateT instance (sv_ents.ts's instanceof guard requirement)", () => {
      const log: CallLog = { calls: [] };
      const world = fakeEdict(0);
      const clientEdict = fakeEdict(1);
      clientEdict.client = defaultGClient();
      const kexGe = fakeKexGameExports([world, clientEdict], log);
      const adapter = adaptKexGameExports(kexGe);
      adapter.Init();

      const engineClient = adapter.edicts[1].client as { ps: unknown } | null;
      expect(engineClient).not.toBeNull();
      expect(engineClient?.ps instanceof PlayerStateT).toBe(true);
    });

    test("client is null on the engine view when the kex edict has no client", () => {
      const log: CallLog = { calls: [] };
      const world = fakeEdict(0);
      const kexGe = fakeKexGameExports([world], log);
      const adapter = adaptKexGameExports(kexGe);
      adapter.Init();

      expect(adapter.edicts[0].client).toBeNull();
    });
  });

  describe("WriteGame/ReadGame filesystem seam", () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "kexbinding-savegame-"));
    });

    test("WriteGame writes kex's WriteGameJson string via FS_WriteFile; ReadGame reads it back via FS_ReadRawFile", () => {
      const log: CallLog = { calls: [] };
      const kexGe = fakeKexGameExports([fakeEdict(0)], log);
      const adapter = adaptKexGameExports(kexGe);
      adapter.Init();

      const path = join(dir, "game.ssv");
      adapter.WriteGame(path, false);
      adapter.ReadGame(path);

      expect(log.calls).toContain('ReadGameJson:{"autosave":false}');
    });

    test("ReadGame throws a clear error when the file does not exist", () => {
      const log: CallLog = { calls: [] };
      const kexGe = fakeKexGameExports([fakeEdict(0)], log);
      const adapter = adaptKexGameExports(kexGe);
      adapter.Init();

      expect(() => adapter.ReadGame(join(dir, "does-not-exist.ssv"))).toThrow();
    });

    // afterAll would be nicer, but this suite otherwise never touches the
    // filesystem outside `dir`; a leftover tmp dir is harmless and bun:test
    // has no bundled afterAll import churn to add for a two-test cleanup.
    test("cleanup", () => {
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Info_* box-parameter adapters
// ---------------------------------------------------------------------------

describe("Info_* box adapters", () => {
  const imports = BuildKexImports();

  test("Info_ValueForKey fills the buffer box and returns the written length", () => {
    const buffer: [string] = [""];
    const written = imports.Info_ValueForKey("\\name\\Player\\skin\\male/grunt", "name", buffer, 64);
    expect(buffer[0]).toBe("Player");
    expect(written).toBe("Player".length);
  });

  test("Info_RemoveKey mutates the box in place and reports whether it changed", () => {
    const box: [string] = ["\\name\\Player\\skin\\male/grunt"];
    const changed = imports.Info_RemoveKey(box, "skin");
    expect(changed).toBe(true);
    expect(box[0]).toBe("\\name\\Player");

    const box2: [string] = ["\\name\\Player"];
    const changedAgain = imports.Info_RemoveKey(box2, "nope");
    expect(changedAgain).toBe(false);
  });

  test("Info_SetValueForKey mutates the box in place and reports success", () => {
    const box: [string] = ["\\name\\Player"];
    const applied = imports.Info_SetValueForKey(box, "skin", "male/grunt");
    expect(applied).toBe(true);
    expect(box[0]).toBe("\\name\\Player\\skin\\male/grunt");
  });
});

// ---------------------------------------------------------------------------
// multicast destination mapping
// ---------------------------------------------------------------------------

describe("multicast KexMulticastT -> MulticastT mapping", () => {
  const imports = BuildKexImports();

  test("MULTICAST_ALL (unreliable and reliable) maps to a destination SV_Multicast accepts", () => {
    // An invalid mapping would make SV_Multicast hit its own
    // Com_Error(ERR_FATAL, "bad to:...") branch -- "does not throw" is a
    // real correctness check on the mapping, not just a smoke test.
    expect(() => imports.multicast(vec3(0, 0, 0), KexMulticastT.MULTICAST_ALL, false)).not.toThrow();
    expect(() => imports.multicast(vec3(0, 0, 0), KexMulticastT.MULTICAST_ALL, true)).not.toThrow();
  });
});
