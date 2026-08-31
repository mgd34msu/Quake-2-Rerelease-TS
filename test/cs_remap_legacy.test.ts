/*
Unit tests for shared/cs_remap.ts's remapLegacyConfigstringIndex -- the pure
index-translation function src/server/bindings/legacy_kex.ts's
kexRemappedConfigstring/fixupPickupStringStat both depend on for the
"kex-family LMCTF adaptation" (.orch/followups.md task #26). No server boot,
no retail data: purely arithmetic against the two exported CsRemapT tables,
so this runs unconditionally as a fast, deterministic check of the exact
math the LMCTF-under-kex-family boot test (test/lmctf_kex_boot.test.ts)
depends on but can't itself easily isolate.

Self-sufficient per .orch/preferences.md rule 13: reads only the two
exported, immutable CsRemapT constants, no shared mutable state.
*/

import { describe, expect, test } from "bun:test";
import { CS_REMAP_OLD, CS_REMAP_RERELEASE, remapLegacyConfigstringIndex } from "../src/shared/cs_remap";

describe("remapLegacyConfigstringIndex", () => {
  test("low, fixed indices (CS_NAME..CS_STATUSBAR range) pass through unchanged", () => {
    // Both families keep these identical -- see cs_remap.ts's own header
    // comment on CS_REMAP_RERELEASE's low CS_* bases.
    for (const index of [0, 1, 2, 3, 4, 5, 10, 28]) {
      expect(remapLegacyConfigstringIndex(index, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(index);
    }
  });

  test("scalar fields (airaccel/maxclients/mapchecksum) translate 1:1 by field identity", () => {
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.airaccel, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.airaccel);
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.maxclients, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.maxclients);
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.mapchecksum, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.mapchecksum);
  });

  test("block fields preserve their offset within the block, only the block start shifts", () => {
    // CS_MODELS block: index 5 models into the block -> same relative
    // offset (5) into CS_REMAP_RERELEASE's (much wider) models block.
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.models + 5, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.models + 5);
    // CS_SOUNDS block, offset 0 (the block's own base index).
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.sounds, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.sounds);
    // CS_IMAGES block, offset 3.
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.images + 3, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.images + 3);
    // CS_LIGHTS block, offset 63 (a real lightstyle index g_spawn.ts writes
    // -- see src/lmctf/g_spawn.ts's SP_worldspawn CS_LIGHTS+63 default).
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.lights + 63, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.lights + 63);
    // CS_ITEMS block, offset 12 -- the exact shape src/lmctf/g_items.ts's
    // `gi.configstring(CS_ITEMS + i, it.pickup_name)` produces.
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.items + 12, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.items + 12);
    // CS_PLAYERSKINS block, offset 1 -- src/lmctf/p_client.ts's
    // `gi.configstring(CS_PLAYERSKINS + playernum, ...)` shape.
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.playerskins + 1, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.playerskins + 1);
    // CS_GENERAL block, offset 1 -- src/lmctf/p_client.ts's
    // `gi.configstring(CS_GENERAL + playernum, ...)` shape.
    expect(remapLegacyConfigstringIndex(CS_REMAP_OLD.general + 1, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toBe(CS_REMAP_RERELEASE.general + 1);
  });

  test("the LMCTF item-pickup regression this unit exists to prevent: unmapped CS_ITEMS collides with CS_REMAP_RERELEASE's models block", () => {
    // Sanity-check the actual bug a naive passthrough would cause: CS_ITEMS
    // (1056) under CS_REMAP_OLD falls squarely inside CS_REMAP_RERELEASE's
    // MODELS block (62..8253) if never remapped -- a real item pickup
    // message write would silently clobber a model-name precache slot a
    // real 1038 client is relying on. Values verified against the tables'
    // own live JSON dump (CS_REMAP_OLD.items=1056, CS_REMAP_RERELEASE:
    // models=62, sounds=8254), not hand-derived.
    const legacyItemsBase = CS_REMAP_OLD.items;
    expect(legacyItemsBase).toBeGreaterThanOrEqual(CS_REMAP_RERELEASE.models);
    expect(legacyItemsBase).toBeLessThan(CS_REMAP_RERELEASE.sounds);
    // ... and the actual remap lands it correctly inside the WIDE items block.
    const remapped = remapLegacyConfigstringIndex(legacyItemsBase, CS_REMAP_OLD, CS_REMAP_RERELEASE);
    expect(remapped).toBe(CS_REMAP_RERELEASE.items);
    expect(remapped).toBeGreaterThanOrEqual(CS_REMAP_RERELEASE.items);
    expect(remapped).toBeLessThan(CS_REMAP_RERELEASE.playerskins);
  });

  test("identity remap (old -> old) is a no-op for every field", () => {
    for (const field of ["airaccel", "maxclients", "mapchecksum", "models", "sounds", "images", "lights", "items", "playerskins", "general"] as const) {
      const start = CS_REMAP_OLD[field];
      expect(remapLegacyConfigstringIndex(start, CS_REMAP_OLD, CS_REMAP_OLD)).toBe(start);
    }
  });

  test("throws for an index past the source family's own end", () => {
    expect(() => remapLegacyConfigstringIndex(CS_REMAP_OLD.end, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toThrow();
    expect(() => remapLegacyConfigstringIndex(CS_REMAP_OLD.end + 100, CS_REMAP_OLD, CS_REMAP_RERELEASE)).toThrow();
  });
});
