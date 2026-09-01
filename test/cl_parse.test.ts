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

  test("svc_serverdata calls CL_ClearState, which (transitively, via S_StopAllSounds) is real end to end; a truncated message dies on the protocol-version check instead", () => {
    // CL_ClearState and S_StopAllSounds are both real implementations now
    // (snd_dma.ts's sound path landed), so CL_ParseServerData no longer
    // bottoms out in a sibling stub here -- the truncated message below
    // instead dies on the C's own protocol-version check (ERR_DROP -> ComError).
    MSG_WriteByte(net_message, SvcOpsT.svc_serverdata);
    MSG_BeginReading(net_message);
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

// =============================================================================
// [Paril-KEX] eye height in the view. Vanilla folds eye height into
// ps.viewoffset; the re-release deliberately does not (q2repro
// server/entities.c:610-612: "Rerelease game doesn't include viewheight in
// viewoffset, vanilla does") and ships it as ps.pmove.viewheight, which the
// client adds to refdef.vieworg itself, eased over 100ms (q2repro
// client/entities.c:1528-1536 records the change, :1605-1609 applies it).
// Dropping this is what put the camera at the player's feet and made every
// re-release player look permanently crouched.
// =============================================================================

describe("CL_CalcViewValues -- ps.pmove.viewheight raises the eye above the origin, eased over 100ms", () => {
  // Runs the deterministic (non-predicted) branch: clCvars.cl_predict stays
  // null, so CL_CalcViewValues interpolates ops->ps instead of using
  // cl.predicted_origin. oldframe resolves back to cl.frame (no frame at
  // serverframe-1), so ops === ps and the positional lerp is a no-op --
  // leaving the viewheight term as the only thing that moves vieworg[2].
  const ORIGIN_Z = -104;

  function seedActiveFrame(viewheight: number): void {
    cls.state = ConnstateT.ca_active;
    cl.frame.valid = true;
    cl.frame.serverframe = 1;
    cl.frame.num_entities = 0;
    cl.frame.playerstate.pmove.origin[2] = ORIGIN_Z * 8; // 12.3 fixed point
    cl.frame.playerstate.pmove.viewheight = viewheight;
  }

  function eyeAboveOriginAt(servertime: number): number {
    cl.frame.servertime = servertime;
    cl.time = servertime;
    CL_AddEntities();
    return cl.refdef.vieworg[2] - ORIGIN_Z;
  }

  test("the frame a new eye height first arrives still renders the OLD one (ease starts, not jumps)", () => {
    seedActiveFrame(22);
    // cl.current_viewheight starts at 0 (cl.clear() in beforeEach), so this
    // frame records the 0 -> 22 change and viewheight_lerp is a full 100.
    expect(eyeAboveOriginAt(1000)).toBeCloseTo(0, 5);
  });

  test("halfway through the 100ms window the eye is halfway up", () => {
    seedActiveFrame(22);
    eyeAboveOriginAt(1000); // records the change at cl.time = 1000
    // 1050 - 1000 = 50 -> viewheight_lerp = 50 -> 22 + (0 - 22) * 50 * 0.01 = 11
    expect(eyeAboveOriginAt(1050)).toBeCloseTo(11, 5);
  });

  test("after the 100ms window the eye sits the full standing 22 units above the origin", () => {
    seedActiveFrame(22);
    eyeAboveOriginAt(1000);
    expect(eyeAboveOriginAt(1100)).toBeCloseTo(22, 5);
    // and stays there -- min(elapsed, 100) clamps, it does not keep drifting
    expect(eyeAboveOriginAt(1500)).toBeCloseTo(22, 5);
  });

  test("crouching (22 -> 4) eases the eye DOWN over the same window", () => {
    seedActiveFrame(22);
    eyeAboveOriginAt(1000);
    eyeAboveOriginAt(1100);
    expect(eyeAboveOriginAt(1200)).toBeCloseTo(22, 5);

    cl.frame.playerstate.pmove.viewheight = 4;
    // the change frame renders the old 22 ...
    expect(eyeAboveOriginAt(1300)).toBeCloseTo(22, 5);
    // ... halfway: 4 + (22 - 4) * 50 * 0.01 = 13
    expect(eyeAboveOriginAt(1350)).toBeCloseTo(13, 5);
    // ... settled at the ducked height
    expect(eyeAboveOriginAt(1400)).toBeCloseTo(4, 5);
  });

  test("a vanilla-family playerstate (viewheight left at 0) puts the eye exactly at the origin -- no classic behavior changed", () => {
    seedActiveFrame(0);
    expect(eyeAboveOriginAt(1000)).toBeCloseTo(0, 5);
    expect(eyeAboveOriginAt(1100)).toBeCloseTo(0, 5);
  });
});
