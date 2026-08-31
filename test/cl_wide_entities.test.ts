/*
Client-side wide-arrays widening unit (.orch/followups.md "CLIENT-SIDE WIDE
ARRAYS" queue item): cl_entities and MAX_PARSE_ENTITIES (client.ts) were
previously sized off q_shared.ts's vanilla-only MAX_EDICTS=1024, and several
entity-number bound checks (cl_ents.ts's CL_ParsePacketEntities/
CL_GetEntitySoundOrigin, cl_parse.ts's CL_ParseStartSoundPacket/
CL_ParseStartSoundPacketKex/CL_ParseBaseline, cl_fx.ts's CL_ParseMuzzleFlash/
CL_ParseMuzzleFlash2, cl_main.ts's CL_Record_f baseline writer) checked
against that same vanilla-only constant instead of the ACTIVE connection
family's cls.csr.max_edicts (1024 under CS_REMAP_OLD / classic protocols
34-36, 8192 under CS_REMAP_RERELEASE / 1038-kex) -- matching q2repro's own
inc/shared/shared.h (cl_entities[MAX_EDICTS] where MAX_EDICTS is
unconditionally the wide 8192 constant) and its parse.c/entities.c/newfx.c
(every real bound check reads `cl.csr.max_edicts`, not a compile-time
maximum).

This file drives real parses (through CL_ParseServerMessage, the actual
top-level dispatch, not a hand-called internal) of an entity number above
the vanilla 1024 cap under both families:
  - kex (protocol 1038 / Q2REPRO_CODEC / CS_REMAP_RERELEASE): must succeed,
    proving cl_entities is now wide enough to hold the slot without an
    out-of-bounds read crashing the very next property access.
  - classic (protocol 34 / VANILLA_CODEC / CS_REMAP_OLD, cls.clear()'s
    default): must still error exactly as vanilla always did -- both at
    write time (sizebuf.ts's MSG_WriteDeltaEntity's own, untouched,
    `to.number >= MAX_EDICTS` guard) and at CL_ParseBaseline's read-side
    bound check, using a hand-verified low-level encoding built from the
    port's own named wire-format bit constants (U_MOREBITS1/U_NUMBER16,
    qcommon.ts) rather than an arbitrary byte sequence -- MSG_WriteDeltaEntity
    cannot be used to synthesize this particular message because ITS OWN
    guard is exactly what throws first if asked to write entity 2000.

Self-sufficient per .orch/preferences.md rule 13: every test resets cl/cls/
net_message itself.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { SZ_Clear, MSG_BeginReading, MSG_WriteByte, MSG_WriteShort } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { EntityStateT, PlayerStateT } from "../src/shared/q_shared";
import { ComError, U_MOREBITS1, U_NUMBER16, SvcOpsT } from "../src/qcommon/qcommon";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { cl, cls, ConnstateT, cl_entities, MAX_PARSE_ENTITIES } from "../src/client/client";
import { CL_ParseServerMessage, CL_ParseBaseline } from "../src/client/cl_parse";
import { VANILLA_CODEC } from "../src/qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../src/qcommon/protocol/q2repro";
import type { FrameWriteParamsT } from "../src/qcommon/protocol/codec";

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

beforeEach(() => {
  cl.clear();
  cls.clear(); // resets cls.codec to VANILLA_CODEC, cls.csr to CS_REMAP_OLD
  resetNetMessage();
});

describe("cl_entities / MAX_PARSE_ENTITIES sizing", () => {
  test("cl_entities holds the wide family's full 8192-entity range, not the vanilla 1024", () => {
    expect(cl_entities.length).toBe(8192);
    // every slot is a real CentityT, not a sparse hole -- indexing anywhere
    // in the wide range reads real (zeroed) state instead of `undefined`
    expect(cl_entities[8191]).toBeDefined();
    expect(cl_entities[8191].current.number).toBe(0);
  });

  test("MAX_PARSE_ENTITIES matches q2repro's own MAX_PACKET_ENTITIES(512) * UPDATE_BACKUP(16) = 8192", () => {
    expect(MAX_PARSE_ENTITIES).toBe(8192);
  });
});

describe("kex family (protocol 1038 / Q2REPRO_CODEC / CS_REMAP_RERELEASE): an entity number above the vanilla cap parses cleanly", () => {
  beforeEach(() => {
    cls.codec = Q2REPRO_CODEC;
    cls.csr = CS_REMAP_RERELEASE;
  });

  const WIDE_ENTITY = 2000; // above vanilla's 1024 cap, well within wide 8192

  test("CL_ParseServerMessage -> svc_spawnbaseline -> CL_ParseBaseline populates cl_entities[2000].baseline, using the port's own Q2REPRO_CODEC writer", () => {
    const base = new EntityStateT();
    base.number = WIDE_ENTITY;
    base.origin.set([64, -128, 32]);
    base.modelindex = 7;

    Q2REPRO_CODEC.writeSpawnBaseline(net_message, base);
    MSG_BeginReading(net_message);

    expect(() => CL_ParseServerMessage()).not.toThrow();

    expect(cl_entities[WIDE_ENTITY].baseline.modelindex).toBe(7);
    expect(Array.from(cl_entities[WIDE_ENTITY].baseline.origin)).toEqual([64, -128, 32]);
  });

  test("CL_ParseServerMessage -> svc_frame -> CL_ParseFrame -> CL_ParsePacketEntities accepts a packetentities delta for entity 2000", () => {
    const psTo = new PlayerStateT();
    const entFrom = new EntityStateT();
    const entTo = new EntityStateT();
    entTo.number = WIDE_ENTITY;
    entTo.origin.set([16, 32, 48]);
    entTo.modelindex = 9;

    const params: FrameWriteParamsT = {
      framenum: 1,
      lastframe: -1, // uncompressed frame, matches CL_ParseFrame's deltaframe<=0 branch
      surpressCount: 0,
      areabits: new Uint8Array(0),
      areabytes: 0,
      psFrom: null,
      psTo,
    };

    Q2REPRO_CODEC.writeFrame(net_message, params, (m) => {
      Q2REPRO_CODEC.writeDeltaEntity(m, entFrom, entTo, true, true);
      Q2REPRO_CODEC.writePacketEntitiesEnd(m);
    });
    MSG_BeginReading(net_message);

    expect(() => CL_ParseServerMessage()).not.toThrow();

    expect(cl.frame.valid).toBe(true);
    expect(cl.frame.num_entities).toBe(1);
    expect(cl_entities[WIDE_ENTITY].current.modelindex).toBe(9);
    expect(Array.from(cl_entities[WIDE_ENTITY].current.origin)).toEqual([16, 32, 48]);
    expect(cls.state).toBe(ConnstateT.ca_active);
  });
});

describe("classic family (protocol 34 / VANILLA_CODEC / CS_REMAP_OLD): the SAME entity number above the vanilla cap still errors exactly as vanilla does", () => {
  const WIDE_ENTITY = 2000;

  test("baseline (default cls after cls.clear())", () => {
    expect(cls.codec).toBe(VANILLA_CODEC);
    expect(cls.csr).toBe(CS_REMAP_OLD);
    expect(cls.csr.max_edicts).toBe(1024);
  });

  test("the port's own writer refuses to construct the message at all: MSG_WriteDeltaEntity's own MAX_EDICTS guard throws unchanged", () => {
    const base = new EntityStateT();
    base.number = WIDE_ENTITY;
    base.modelindex = 7;
    expect(() => VANILLA_CODEC.writeSpawnBaseline(net_message, base)).toThrow(ComError);
    expect(() => VANILLA_CODEC.writeSpawnBaseline(net_message, base)).toThrow(/MAX_EDICTS/);
  });

  test("CL_ParseBaseline's own read-side bound check rejects entity 2000 (hand-built from named wire-format bits, since the writer above can't produce this message)", () => {
    // Minimal entity-bits header good enough for CL_ParseBaseline to reach
    // its OWN bound check before ever touching the (absent) delta-field
    // bytes: MOREBITS1 set in byte 1 to trigger reading byte 2, byte 2 sets
    // only U_NUMBER16 (bit 8), then a plain short holds the number itself --
    // exactly the layout src/qcommon/protocol/vanilla.ts's own readEntityBits
    // decodes (`if (total & U_MOREBITS1) ... if (total & U_NUMBER16) number
    // = MSG_ReadShort(...)`).
    MSG_WriteByte(net_message, SvcOpsT.svc_spawnbaseline);
    MSG_WriteByte(net_message, U_MOREBITS1 & 0xff);
    MSG_WriteByte(net_message, (U_NUMBER16 >> 8) & 0xff);
    MSG_WriteShort(net_message, WIDE_ENTITY);
    MSG_BeginReading(net_message);

    expect(() => CL_ParseServerMessage()).toThrow(ComError);
    expect(() => {
      resetNetMessage();
      MSG_WriteByte(net_message, U_MOREBITS1 & 0xff);
      MSG_WriteByte(net_message, (U_NUMBER16 >> 8) & 0xff);
      MSG_WriteShort(net_message, WIDE_ENTITY);
      MSG_BeginReading(net_message);
      CL_ParseBaseline();
    }).toThrow(/bad index/);
  });

  test("the boundary itself is exactly 1024, unchanged: entity 1023 still round-trips, entity 1024 is the first rejected value", () => {
    const okBase = new EntityStateT();
    okBase.number = 1023;
    okBase.modelindex = 3;
    VANILLA_CODEC.writeSpawnBaseline(net_message, okBase);
    MSG_BeginReading(net_message);
    expect(() => CL_ParseServerMessage()).not.toThrow();
    expect(cl_entities[1023].baseline.modelindex).toBe(3);

    resetNetMessage();
    const badBase = new EntityStateT();
    badBase.number = 1024;
    badBase.modelindex = 3;
    expect(() => VANILLA_CODEC.writeSpawnBaseline(net_message, badBase)).toThrow(ComError);
  });
});
