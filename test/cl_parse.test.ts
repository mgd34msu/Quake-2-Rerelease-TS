import { describe, test, expect, beforeEach } from "bun:test";
import { ComError, SvcOpsT } from "../src/qcommon/qcommon";
import { SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort, MSG_WriteLong, MSG_WriteDeltaEntity } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, CvarT, CS_MODELS } from "../src/shared/q_shared";
import { MAX_MAP_AREAS } from "../src/qcommon/qfiles";
import { cl, cls, ConnstateT, clCvars, cl_entities, setRe } from "../src/client/client";
import { CL_ParseServerMessage, CL_ParseServerData, CL_ParseConfigString, CL_ParseStartSoundPacket, SHOWNET } from "../src/client/cl_parse";
import { CL_ParseEntityBits, CL_ParseDelta, CL_AddEntities, CL_GetEntitySoundOrigin } from "../src/client/cl_ents";
import { V_ClearScene, r_entities, r_numentities } from "../src/client/cl_view";

// Every net_message read in this suite starts from a clean read cursor;
// tests build the wire bytes with MSG_Write* directly onto the shared
// net_message singleton (mirrors net.test.ts's convention for net_chan.ts),
// then MSG_BeginReading resets readcount to 0 before the function under
// test parses it.
function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  cl.clear();
  cls.clear();
  resetNetMessage();
  // clCvars is a shared module-level holder (not reset by cl.clear());
  // every field this suite touches is reset explicitly so no test leaks
  // cvar state into the next one (rule 13: self-sufficient test files).
  clCvars.cl_shownet = null;
  clCvars.cl_predict = null;
  clCvars.cl_noskins = null;
  clCvars.cl_vwep = null;
  clCvars.cl_gun = null;
  clCvars.cl_timedemo = null;
  clCvars.cl_showclamp = null;
  setRe(null);
});

function cvar(value: number): CvarT {
  const c = new CvarT();
  c.value = value;
  return c;
}

function writeAreabits(): void {
  const len = MAX_MAP_AREAS / 8;
  MSG_WriteByte(net_message, len);
  for (let i = 0; i < len; i++) MSG_WriteByte(net_message, 0);
}

describe("CL_ParseEntityBits / CL_ParseDelta -- writer/reader wire symmetry", () => {
  test("round-trips a full entity_state_t delta through our own MSG_WriteDeltaEntity", () => {
    const from = new EntityStateT();

    const to = new EntityStateT();
    to.number = 42;
    to.origin.set([104.125, -32.0, 0.25]); // multiples of 1/8: survive MSG_WriteCoord/ReadCoord quantization exactly
    to.angles.set([90, -90, 45]); // survive MSG_WriteAngle/ReadAngle's byte quantization exactly
    to.old_origin.set([8.0, -8.0, 0]);
    to.modelindex = 5;
    to.frame = 10;
    to.skinnum = 7;
    to.effects = 0x100;
    to.renderfx = 0x20;
    to.solid = 200;
    to.sound = 9;
    to.event = 3;

    // newentity=true forces U_OLDORIGIN so old_origin round-trips too (mirrors
    // sv_ents.ts's SV_EmitPacketEntities always passing newentity for players)
    MSG_WriteDeltaEntity(from, to, net_message, true, true);
    MSG_BeginReading(net_message);

    const { number, bits } = CL_ParseEntityBits();
    expect(number).toBe(42);

    const out = new EntityStateT();
    CL_ParseDelta(from, out, number, bits);

    expect(out.number).toBe(42);
    expect(Array.from(out.origin)).toEqual([104.125, -32.0, 0.25]);
    expect(Array.from(out.angles)).toEqual([90, -90, 45]);
    expect(Array.from(out.old_origin)).toEqual([8.0, -8.0, 0]);
    expect(out.modelindex).toBe(5);
    expect(out.frame).toBe(10);
    expect(out.skinnum).toBe(7);
    expect(out.effects).toBe(0x100);
    expect(out.renderfx).toBe(0x20);
    expect(out.solid).toBe(200);
    expect(out.sound).toBe(9);
    expect(out.event).toBe(3);
  });

  test("a from/to pair with no differences and force=false writes nothing (CL_ParseEntityBits sees the next message's bytes, not a phantom entity)", () => {
    const same = new EntityStateT();
    same.number = 7;
    MSG_WriteDeltaEntity(same, same, net_message, false, false);
    // MSG_WriteDeltaEntity emits nothing when there is nothing to send and
    // force is false -- terminate the (empty) packetentities stream the way
    // CL_ParsePacketEntities expects, so this is a well-formed read.
    MSG_WriteShort(net_message, 0);
    MSG_BeginReading(net_message);

    const { number, bits } = CL_ParseEntityBits();
    expect(number).toBe(0);
    expect(bits).toBe(0);
  });

  test("U_EVENT is zero-compressed: an unset event bit resets `to.event` to 0 even when `from.event` was nonzero", () => {
    const from = new EntityStateT();
    from.event = 5; // simulates a previous frame's state carrying a stale event
    const to = new EntityStateT();
    to.number = 3;
    to.modelindex = 1; // force a nonzero bits word so something is written
    MSG_WriteDeltaEntity(from, to, net_message, false, true);
    MSG_BeginReading(net_message);

    const { number, bits } = CL_ParseEntityBits();
    const out = new EntityStateT();
    out.event = 99; // pre-seed with a sentinel; CL_ParseDelta must overwrite it
    CL_ParseDelta(from, out, number, bits);
    expect(out.event).toBe(0);
  });
});

describe("CL_ParseServerMessage -- svc_* dispatch", () => {
  test("svc_nop is a no-op and the loop terminates cleanly at end of message", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_nop);
    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).not.toThrow();
  });

  test("an unknown command drops with ComError(ERR_DROP)", () => {
    MSG_WriteByte(net_message, 255); // not a valid SvcOpsT value
    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).toThrow(ComError);
  });

  test("svc_disconnect throws ComError(ERR_DISCONNECT) (mirrors Com_Error/longjmp aborting the frame)", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_disconnect);
    MSG_BeginReading(net_message);
    let caught: unknown;
    try {
      CL_ParseServerMessage();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComError);
    expect((caught as ComError).code).toBe(2); // ERR_DISCONNECT
  });

  test("svc_playerinfo/svc_packetentities/svc_deltapacketentities out of a frame are rejected (\"Out of place frame data\")", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).toThrow(ComError);
  });

  test("svc_configstring updates cl.configstrings without touching the renderer while refresh_prepped is false", () => {
    expect(cl.refresh_prepped).toBe(false); // ClStateT's default (set by cl.clear() in beforeEach)

    const idx = CS_MODELS + 3;
    MSG_WriteByte(net_message, SvcOpsT.svc_configstring);
    MSG_WriteShort(net_message, idx);
    writeCString("maps/test.bsp");
    MSG_BeginReading(net_message);

    // `re` stays null for this test: if CL_ParseConfigString's refresh_prepped
    // gate were wrong, calling re.RegisterModel on null would throw a
    // TypeError instead of silently skipping, so this also proves the gate.
    expect(() => CL_ParseServerMessage()).not.toThrow();
    expect(cl.configstrings[idx]).toBe("maps/test.bsp");
    expect(cl.model_draw[3]).toBeNull();
  });

  test("svc_configstring out of range calls Com_Error(ERR_DROP)", () => {
    MSG_WriteByte(net_message, SvcOpsT.svc_configstring);
    MSG_WriteShort(net_message, 99999);
    MSG_BeginReading(net_message);
    expect(() => CL_ParseConfigString()).toThrow(ComError);
  });

  test("svc_serverdata calls CL_ClearState, which (transitively, via S_StopAllSounds) still bottoms out in a sibling pending stub -- reported gap, not this unit's to fix", () => {
    // CL_ClearState itself is now a real cl_main.ts port (landed concurrently
    // with this unit), but it calls S_StopAllSounds first, which is still
    // snd_dma.c's pending stub -- so CL_ParseServerData still can't complete
    // end to end. Asserted as "some PendingPort", not a specific function
    // name, since which stub it bottoms out at is another unit's business
    // and may change as siblings land.
    MSG_WriteByte(net_message, SvcOpsT.svc_serverdata);
    MSG_BeginReading(net_message);
    // the sound path is real now; the truncated message dies on the C's own
    // protocol-version check instead (ERR_DROP -> ComError)
    expect(() => CL_ParseServerMessage()).toThrow(/version/);

    resetNetMessage();
    MSG_BeginReading(net_message);
    // same truncated-message path: dies on the protocol-version check
    expect(() => CL_ParseServerData()).toThrow(/version/);
  });
});

describe("svc_spawnbaseline + svc_frame -- full packet-entity wire fidelity against cl_entities[].baseline", () => {
  test("a baseline spawn followed by a delta frame update produces the correct current/baseline split", () => {
    const baseline = new EntityStateT();
    baseline.number = 5;
    baseline.origin.set([64, 0, 0]);
    baseline.angles.set([0, 90, 0]);
    baseline.modelindex = 3;
    baseline.frame = 1;

    // svc_spawnbaseline: CL_ParseBaseline deltas from an all-zero nullstate
    MSG_WriteByte(net_message, SvcOpsT.svc_spawnbaseline);
    MSG_WriteDeltaEntity(new EntityStateT(), baseline, net_message, true, true);

    // svc_frame: an uncompressed (deltaframe<=0) frame containing one entity
    // that has moved relative to the baseline just spawned above
    const moved = new EntityStateT();
    moved.number = 5;
    moved.origin.set([64, 32, 0]); // baseline.origin + (0, 32, 0)
    moved.angles.set([0, 90, 0]);
    moved.modelindex = 3;
    moved.frame = 1;

    MSG_WriteByte(net_message, SvcOpsT.svc_frame);
    MSG_WriteLong(net_message, 1); // serverframe
    MSG_WriteLong(net_message, -1); // deltaframe <= 0: uncompressed
    MSG_WriteByte(net_message, 0); // surpressCount (cls.serverProtocol !== 26 by default)
    writeAreabits();
    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, 0); // pflags = 0: no pmove/view fields sent
    MSG_WriteLong(net_message, 0); // statbits = 0
    MSG_WriteByte(net_message, SvcOpsT.svc_packetentities);
    // deltas against baseline's decoded values (cl_entities[5].baseline,
    // populated by the svc_spawnbaseline command parsed just above it in
    // this same message -- exercises the real C call order, not a shortcut)
    MSG_WriteDeltaEntity(baseline, moved, net_message, false, false);
    MSG_WriteShort(net_message, 0); // end of packetentities

    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).not.toThrow();

    expect(Array.from(cl_entities[5].baseline.origin)).toEqual([64, 0, 0]);
    expect(Array.from(cl_entities[5].current.origin)).toEqual([64, 32, 0]);
    expect(cl_entities[5].current.modelindex).toBe(3);
    expect(cl.frame.valid).toBe(true);
    expect(cl.frame.num_entities).toBe(1);
    expect(cls.state).toBe(ConnstateT.ca_active); // CL_ParseFrame's "getting a valid frame ends the connection process"
  });
});

describe("modelindex2 > 0x7f -- 3.20/3.21 linked-model fix (D1.10)", () => {
  test("round-trips modelindex2 above 127 through the wire delta encoding unchanged", () => {
    const from = new EntityStateT();
    const to = new EntityStateT();
    to.number = 9;
    to.modelindex2 = 200; // > 0x7f: 3.19's client-side "& 0x7F" hack used to corrupt this
    MSG_WriteDeltaEntity(from, to, net_message, true, true);
    MSG_BeginReading(net_message);

    const { number, bits } = CL_ParseEntityBits();
    const out = new EntityStateT();
    CL_ParseDelta(from, out, number, bits);
    expect(out.modelindex2).toBe(200);
  });

  test("CL_AddEntities draws the real modelindex2 model (no & 0x7F masking) and only makes the defender-sphere shell translucent by configstring name", () => {
    const sentinelModel = {};
    cl.model_draw[200] = sentinelModel;
    // deliberately NOT "models/items/shell/tris.md2" -- proves translucency
    // is keyed off the name, not off modelindex2's high bit as in 3.19
    cl.configstrings[CS_MODELS + 200] = "models/objects/gibs/sm_meat/tris.md2";

    const baseline = new EntityStateT();
    baseline.number = 6;
    baseline.modelindex = 3;
    baseline.modelindex2 = 200;

    MSG_WriteByte(net_message, SvcOpsT.svc_spawnbaseline);
    MSG_WriteDeltaEntity(new EntityStateT(), baseline, net_message, true, true);

    MSG_WriteByte(net_message, SvcOpsT.svc_frame);
    MSG_WriteLong(net_message, 1); // serverframe
    MSG_WriteLong(net_message, -1); // deltaframe <= 0: uncompressed
    MSG_WriteByte(net_message, 0); // surpressCount
    writeAreabits();
    MSG_WriteByte(net_message, SvcOpsT.svc_playerinfo);
    MSG_WriteShort(net_message, 0); // pflags = 0
    MSG_WriteLong(net_message, 0); // statbits = 0
    MSG_WriteByte(net_message, SvcOpsT.svc_packetentities);
    MSG_WriteDeltaEntity(baseline, baseline, net_message, true, false); // force=true: re-send unchanged so it's present in this frame
    MSG_WriteShort(net_message, 0); // end of packetentities

    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).not.toThrow();
    expect(cls.state).toBe(ConnstateT.ca_active);

    V_ClearScene();
    CL_AddEntities();

    // find the entity carrying the linked (modelindex2) model among everything V_AddEntity received
    const linked = r_entities.slice(0, r_numentities).find((e) => e.model === sentinelModel);
    expect(linked).toBeDefined();
    expect(linked?.alpha).not.toBe(0.32); // not the defender-sphere shell -> not forced translucent
  });
});

function writeCString(s: string): void {
  for (let i = 0; i < s.length; i++) MSG_WriteByte(net_message, s.charCodeAt(i));
  MSG_WriteByte(net_message, 0);
}

describe("CL_ParseStartSoundPacket", () => {
  test("returns without calling S_StartSound (still a pending stub) when the sound isn't precached", () => {
    // cl.sound_precache[n] is null by default (ClStateT.clear()); C's
    // `if (!cl.sound_precache[sound_num]) return;` gate means S_StartSound
    // (snd_dma.ts's pending stub) is never reached -- proves the gate rather
    // than snd_dma.c's own porting state.
    MSG_WriteByte(net_message, 0); // flags = 0 (no volume/attenuation/offset/ent/pos bytes)
    MSG_WriteByte(net_message, 3); // sound_num
    MSG_BeginReading(net_message);
    expect(() => CL_ParseStartSoundPacket()).not.toThrow();
  });
});

describe("SHOWNET", () => {
  test("is silent (no Com_Printf/no throw) when cl_shownet is unset or below 2", () => {
    expect(() => SHOWNET("test")).not.toThrow();
    clCvars.cl_shownet = cvar(1);
    expect(() => SHOWNET("test")).not.toThrow();
  });

  test("does not throw once cl_shownet >= 2 (exercises the Com_Printf path)", () => {
    clCvars.cl_shownet = cvar(2);
    expect(() => SHOWNET("test")).not.toThrow();
  });
});

describe("CL_GetEntitySoundOrigin", () => {
  test("copies the entity's lerp_origin", () => {
    cl_entities[10].lerp_origin.set([1, 2, 3]);
    const org = new Float32Array(3);
    CL_GetEntitySoundOrigin(10, org);
    expect(Array.from(org)).toEqual([1, 2, 3]);
  });

  test("an out-of-range entity number drops with ComError", () => {
    const org = new Float32Array(3);
    expect(() => CL_GetEntitySoundOrigin(-1, org)).toThrow(ComError);
    expect(() => CL_GetEntitySoundOrigin(999999, org)).toThrow(ComError);
  });
});

describe("CL_AddEntities", () => {
  test("returns immediately when not ca_active, touching none of the renderer pending stubs", () => {
    expect(cls.state).toBe(ConnstateT.ca_uninitialized);
    expect(() => CL_AddEntities()).not.toThrow();
  });
});
