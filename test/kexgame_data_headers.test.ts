/*
Unit tests for the pure-data kex header ports: m_flash.h, m_player.h,
m_rider.h (src/kexgame/m_flash.ts, src/kexgame/m_player.ts,
src/kexgame/m_rider.ts).

Self-sufficient per PORTING.md/.orch/preferences.md rule 13: no dependency
on any other test file having run first.

Scope:
  - monster_flash_offset (m_flash.ts): table length matches
    MonsterMuzzleflashIdT.MZ2_LAST + 1 (290 -- MZ2_UNUSED_0..MZ2_LAST
    inclusive, per ~/Projects/quake2-rerelease-dll/rerelease/game.h's
    monster_muzzleflash_id_t enum), plus 6 spot-checked offsets quoted
    directly from ~/Projects/quake2-rerelease-dll/rerelease/m_flash.h:
      - index 1  (MZ2_TANK_BLASTER_1, first real entry after the unused 0)
      - index 288 (MZ2_MEDIC_HYPERBLASTER2_12, last entry before the
        MZ2_LAST sentinel)
      - index 26  (MZ2_INFANTRY_MACHINEGUN_1, base id Software content)
      - index 101 (MZ2_MAKRON_BFG, "Xian Stuff"/mission-pack block --
        m_flash.h's own "--- Start Xian Stuff ---" .. "--- End Xian Shit
        ---" comments span indices 73-137)
      - index 148 (MZ2_WIDOW_DISRUPTOR, ROGUE block -- m_flash.h's own
        "// ROGUE ... note that the above really ends at 137" comment
        marks index 138 as the first Rogue-mission-pack entry)
      - index 260 (MZ2_INFANTRY_MACHINEGUN_22, a KEX-only entry added past
        the original Rogue table's end)
  - m_player.ts / m_rider.ts: 2 FRAME_* constants each (first and last
    enumerator), confirming declaration-order-as-value and the exact
    starting index (m_rider.h's FRAME_stand201 is index 0 despite the
    "201" in its name -- the frame *number*, not the array index, starts
    at 201).
*/

import { describe, test, expect } from "bun:test";
import { monsterFlashOffset } from "../src/kexgame/m_flash";
import { MonsterMuzzleflashIdT } from "../src/kexapi/game";
import * as MPlayer from "../src/kexgame/m_player";
import * as MRider from "../src/kexgame/m_rider";

describe("m_flash.ts -- monster_flash_offset", () => {
  const table = monsterFlashOffset();

  test("table length matches MZ2_LAST + 1", () => {
    expect(table.length).toBe(MonsterMuzzleflashIdT.MZ2_LAST + 1);
    expect(table.length).toBe(290);
  });

  test("index 1: MZ2_TANK_BLASTER_1 = { 28.7, -18.5, 28.7 }", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_TANK_BLASTER_1];
    expect(v[0]).toBeCloseTo(28.7, 5);
    expect(v[1]).toBeCloseTo(-18.5, 5);
    expect(v[2]).toBeCloseTo(28.7, 5);
  });

  test("index 288: MZ2_MEDIC_HYPERBLASTER2_12 = { 34.5f + 1.f, 11.0, 15.0 }", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_MEDIC_HYPERBLASTER2_12];
    expect(v[0]).toBeCloseTo(35.5, 4);
    expect(v[1]).toBeCloseTo(11.0, 5);
    expect(v[2]).toBeCloseTo(15.0, 5);
  });

  test("index 26: MZ2_INFANTRY_MACHINEGUN_1 = { 26.6, 7.1, 13.1 } (base content)", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_INFANTRY_MACHINEGUN_1];
    expect(v[0]).toBeCloseTo(26.6, 4);
    expect(v[1]).toBeCloseTo(7.1, 4);
    expect(v[2]).toBeCloseTo(13.1, 4);
  });

  test("index 101: MZ2_MAKRON_BFG = { 17.0, -19.5, 62.9 } (Xian/mission-pack block)", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_MAKRON_BFG];
    expect(v[0]).toBeCloseTo(17.0, 4);
    expect(v[1]).toBeCloseTo(-19.5, 4);
    expect(v[2]).toBeCloseTo(62.9, 4);
  });

  test("index 148: MZ2_WIDOW_DISRUPTOR = { 64.72, 14.50, 88.81 } (Rogue block)", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_WIDOW_DISRUPTOR];
    expect(v[0]).toBeCloseTo(64.72, 4);
    expect(v[1]).toBeCloseTo(14.5, 4);
    expect(v[2]).toBeCloseTo(88.81, 4);
  });

  test("index 260: MZ2_INFANTRY_MACHINEGUN_22 = { 14.8, 10.5, 8.82 } (KEX-only, post-Rogue)", () => {
    const v = table[MonsterMuzzleflashIdT.MZ2_INFANTRY_MACHINEGUN_22];
    expect(v[0]).toBeCloseTo(14.8, 4);
    expect(v[1]).toBeCloseTo(10.5, 4);
    expect(v[2]).toBeCloseTo(8.82, 4);
  });

  test("MZ2_UNUSED_0 and MZ2_LAST sentinels are both zero vectors", () => {
    const first = table[MonsterMuzzleflashIdT.MZ2_UNUSED_0];
    const last = table[MonsterMuzzleflashIdT.MZ2_LAST];
    expect([first[0], first[1], first[2]]).toEqual([0, 0, 0]);
    expect([last[0], last[1], last[2]]).toEqual([0, 0, 0]);
  });
});

describe("m_player.ts -- FRAME_* constants", () => {
  test("FRAME_stand01 is the first enumerator (0)", () => {
    expect(MPlayer.FRAME_stand01).toBe(0);
  });

  test("FRAME_death308 is the last enumerator (197)", () => {
    expect(MPlayer.FRAME_death308).toBe(197);
  });

  test("FRAME_run1 falls right after the 40 stand frames (index 40)", () => {
    expect(MPlayer.FRAME_run1).toBe(40);
  });

  test("MODEL_SCALE is 1.0", () => {
    expect(MPlayer.MODEL_SCALE).toBe(1.0);
  });
});

describe("m_rider.ts -- FRAME_* constants", () => {
  test("FRAME_stand201 is the first enumerator (array index 0, not 201)", () => {
    expect(MRider.FRAME_stand201).toBe(0);
  });

  test("FRAME_stand260 is the last enumerator (index 59)", () => {
    expect(MRider.FRAME_stand260).toBe(59);
  });

  test("MODEL_SCALE is 1.0", () => {
    expect(MRider.MODEL_SCALE).toBe(1.0);
  });
});
