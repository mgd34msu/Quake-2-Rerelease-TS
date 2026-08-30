/*
Unit tests for CL_ParseMuzzleFlash2's family-aware monster_flash_offset
table dispatch (cl_fx.ts's activeMonsterFlashOffset()). Self-sufficient per
.orch/preferences.md rule 13: every test resets cl/cls/net_message/dlights
itself rather than relying on execution order.

Family is keyed off cls.csr (CS_REMAP_OLD = classic, CS_REMAP_RERELEASE =
kex), the same signal cl_parse.ts's CL_ParseServerData already uses right
next to it to call CG_SetActiveCgameKind. Ground truth for "what offset
should this resolve to" is read directly from the real tables
(src/game/m_flash.ts, src/kexgame/m_flash.ts) rather than hand-transcribed
magic numbers, so these tests can't silently drift from the data they're
checking against.
*/

import { describe, test, expect, beforeEach } from "bun:test";
import { vec3, AngleVectors, VectorCopy } from "../src/shared/math";
import { MAX_EDICTS } from "../src/shared/q_shared";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../src/shared/cs_remap";
import { SZ_Clear, MSG_BeginReading, MSG_WriteShort, MSG_WriteByte } from "../src/qcommon/sizebuf";
import { net_message } from "../src/qcommon/net_chan";
import { cl, cls, cl_entities, cl_dlights } from "../src/client/client";
import { CL_ParseMuzzleFlash2, CL_ClearDlights } from "../src/client/cl_fx";
import { monsterFlashOffset as classicMonsterFlashOffset } from "../src/game/m_flash";
import { monsterFlashOffset as kexMonsterFlashOffset } from "../src/kexgame/m_flash";
import { MonsterMuzzleflashIdT } from "../src/kexapi/game";

const ENT = 1;

// MZ2_TANK_BLASTER_1: present in BOTH tables, at the same ordinal (1), but
// with a numerically different offset per family (kexgame/m_flash.ts's own
// header comment calls this out explicitly).
const SHARED_INDEX = 1;

// MZ2_GUARDIAN_BLASTER (ordinal 227): a genuine KEX-only entry -- past the
// classic table's last real slot (210) and its "end of table" zero
// sentinel at 211, so classicMonsterFlashOffset()[227] is `undefined`
// (array length 212) while kexMonsterFlashOffset()[227] is real, non-zero
// data (array length 290).
const KEX_ONLY_INDEX = MonsterMuzzleflashIdT.MZ2_GUARDIAN_BLASTER;

function resetNetMessage(): void {
  SZ_Clear(net_message);
  MSG_BeginReading(net_message);
}

function writeMuzzleFlash2(ent: number, flashNumber: number): void {
  MSG_WriteShort(net_message, ent);
  MSG_WriteByte(net_message, flashNumber);
  MSG_BeginReading(net_message);
}

/** Same math CL_ParseMuzzleFlash2 itself runs, driven off a caller-supplied
 *  offset -- used to compute the expected dlight origin from real table
 *  data instead of a hand-transcribed constant. */
function expectedOrigin(offset: readonly [number, number, number] | Float32Array): [number, number, number] {
  const forward = vec3();
  const right = vec3();
  AngleVectors(cl_entities[ENT].current.angles, forward, right, null);
  const origin = vec3();
  origin[0] = cl_entities[ENT].current.origin[0] + forward[0] * offset[0] + right[0] * offset[1];
  origin[1] = cl_entities[ENT].current.origin[1] + forward[1] * offset[0] + right[1] * offset[1];
  origin[2] = cl_entities[ENT].current.origin[2] + forward[2] * offset[0] + right[2] * offset[1] + offset[2];
  return [origin[0], origin[1], origin[2]];
}

function dlightOriginForEnt(ent: number): [number, number, number] {
  const dl = cl_dlights.find((d) => d.key === ent);
  if (!dl) throw new Error(`no dlight allocated for entity ${ent}`);
  return [dl.origin[0], dl.origin[1], dl.origin[2]];
}

beforeEach(() => {
  cl.clear();
  cls.clear(); // resets cls.csr to CS_REMAP_OLD (classic), matching a fresh connection
  CL_ClearDlights();
  resetNetMessage();

  VectorCopy(vec3(100, 200, 300), cl_entities[ENT].current.origin);
  VectorCopy(vec3(0, 0, 0), cl_entities[ENT].current.angles);
});

describe("CL_ParseMuzzleFlash2 -- family-aware monster_flash_offset dispatch", () => {
  test("classic family (default cls.csr) resolves a shared index through the classic table", () => {
    expect(cls.csr).toBe(CS_REMAP_OLD);
    writeMuzzleFlash2(ENT, SHARED_INDEX);
    CL_ParseMuzzleFlash2();

    const expected = expectedOrigin(classicMonsterFlashOffset()[SHARED_INDEX]!);
    expect(dlightOriginForEnt(ENT)).toEqual(expected);
  });

  test("kex family resolves the SAME shared index through the kex table, at a different offset", () => {
    cls.csr = CS_REMAP_RERELEASE;
    writeMuzzleFlash2(ENT, SHARED_INDEX);
    CL_ParseMuzzleFlash2();

    const expectedKex = expectedOrigin(kexMonsterFlashOffset()[SHARED_INDEX]!);
    const expectedClassic = expectedOrigin(classicMonsterFlashOffset()[SHARED_INDEX]!);
    expect(dlightOriginForEnt(ENT)).toEqual(expectedKex);
    // Proves dispatch actually happened, not just two tables that agree.
    expect(dlightOriginForEnt(ENT)).not.toEqual(expectedClassic);
  });

  test("a re-release-only index resolves to real data under the kex family", () => {
    expect(classicMonsterFlashOffset()[KEX_ONLY_INDEX]).toBeUndefined();
    expect(kexMonsterFlashOffset()[KEX_ONLY_INDEX]).toBeDefined();

    cls.csr = CS_REMAP_RERELEASE;
    writeMuzzleFlash2(ENT, KEX_ONLY_INDEX);
    CL_ParseMuzzleFlash2();

    const expected = expectedOrigin(kexMonsterFlashOffset()[KEX_ONLY_INDEX]!);
    expect(dlightOriginForEnt(ENT)).toEqual(expected);
    // Sanity: the real kex offset is non-zero, so this wouldn't accidentally
    // pass via the zero-offset crash guard too.
    expect(expected).not.toEqual([cl_entities[ENT].current.origin[0], cl_entities[ENT].current.origin[1], cl_entities[ENT].current.origin[2]]);
  });

  test("the same re-release-only index falls back to the zero-offset guard under classic, without throwing", () => {
    writeMuzzleFlash2(ENT, KEX_ONLY_INDEX);
    expect(() => CL_ParseMuzzleFlash2()).not.toThrow();

    // offset falls back to (0,0,0) -> dlight lands exactly on the entity origin
    const org = cl_entities[ENT].current.origin;
    expect(dlightOriginForEnt(ENT)).toEqual([org[0], org[1], org[2]]);
  });

  test("classic indices across the table are byte-identical to the pre-dispatch behavior", () => {
    for (const index of [1, 50, 100, 150, 210]) {
      CL_ClearDlights();
      resetNetMessage();
      writeMuzzleFlash2(ENT, index);
      CL_ParseMuzzleFlash2();

      const expected = expectedOrigin(classicMonsterFlashOffset()[index]!);
      expect(dlightOriginForEnt(ENT)).toEqual(expected);
    }
  });

  test("family is read fresh on every call, not cached from the first resolution", () => {
    writeMuzzleFlash2(ENT, SHARED_INDEX);
    CL_ParseMuzzleFlash2();
    expect(dlightOriginForEnt(ENT)).toEqual(expectedOrigin(classicMonsterFlashOffset()[SHARED_INDEX]!));

    cls.csr = CS_REMAP_RERELEASE;
    CL_ClearDlights();
    resetNetMessage();
    writeMuzzleFlash2(ENT, SHARED_INDEX);
    CL_ParseMuzzleFlash2();
    expect(dlightOriginForEnt(ENT)).toEqual(expectedOrigin(kexMonsterFlashOffset()[SHARED_INDEX]!));
  });

  test("a byte value at the extreme high end (255, out of range for both tables' reachable data) still falls back safely under classic", () => {
    // 255 is the max value MSG_ReadByte can return; classicMonsterFlashOffset()
    // has only 212 entries, so this is genuinely out of range there.
    expect(classicMonsterFlashOffset()[255]).toBeUndefined();
    writeMuzzleFlash2(ENT, 255);
    expect(() => CL_ParseMuzzleFlash2()).not.toThrow();
    const org = cl_entities[ENT].current.origin;
    expect(dlightOriginForEnt(ENT)).toEqual([org[0], org[1], org[2]]);
  });
});
