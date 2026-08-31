// Full-census PNG decode sweep over the REAL retail data. Added after the
// 2026-08-31 map-load blocker: the MD5 skin precache path hit
// "unsupported PNG color type 3" on models/weapons/v_machn/md5/skin.png --
// the retail set ships 409 palette PNGs, 1 sixteen-bit truecolor, and 2
// Adam7-interlaced files that the decoder's original qconfont-only scope
// rejected, and no test ever decoded them because per-file byte-vector
// tests only covered hand-picked assets. This sweep decodes EVERY .png in
// baseq2/pak0.pak AND Q2Game.kpf, so any future decoder scope gap fails
// here before it can ship as a live map-load crash.
//
// Self-sufficient (rule 13): reads the paks directly with its own id-PACK
// and ZIP walkers -- no engine globals touched, nothing to restore. Skips
// loudly if the retail install is absent.

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { decodePNG } from "../src/qcommon/png";

const PAK_PATH = "/home/buzzkill/q2rets/rerelease/baseq2/pak0.pak";
const KPF_PATH = "/home/buzzkill/q2rets/rerelease/Q2Game.kpf";
const havePak = existsSync(PAK_PATH) && existsSync(KPF_PATH);

function pakPngs(pakPath: string): Array<{ name: string; bytes: Uint8Array }> {
  const data = readFileSync(pakPath);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dirOfs = view.getInt32(4, true);
  const dirLen = view.getInt32(8, true);
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let i = 0; i < dirLen / 64; i++) {
    const e = dirOfs + i * 64;
    let end = e;
    while (data[end] !== 0 && end < e + 56) end++;
    const name = data.subarray(e, end).toString();
    if (!name.endsWith(".png")) continue;
    const fofs = view.getInt32(e + 56, true);
    const flen = view.getInt32(e + 60, true);
    out.push({ name, bytes: new Uint8Array(data.subarray(fofs, fofs + flen)) });
  }
  return out;
}

// Minimal ZIP central-directory walk (Q2Game.kpf is a plain zip; stored or
// deflate entries only, same subset qcommon/zipfile.ts supports).
function kpfPngs(kpfPath: string): Array<{ name: string; bytes: Uint8Array }> {
  const data = readFileSync(kpfPath);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // find EOCD
  let eocd = -1;
  for (let i = data.length - 22; i >= 0 && i >= data.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThan(-1);
  const count = view.getUint16(eocd + 10, true);
  let ofs = view.getUint32(eocd + 16, true);
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(ofs, true)).toBe(0x02014b50);
    const method = view.getUint16(ofs + 10, true);
    const csize = view.getUint32(ofs + 20, true);
    const nameLen = view.getUint16(ofs + 28, true);
    const extraLen = view.getUint16(ofs + 30, true);
    const commentLen = view.getUint16(ofs + 32, true);
    const localOfs = view.getUint32(ofs + 42, true);
    const name = data.subarray(ofs + 46, ofs + 46 + nameLen).toString();
    if (name.endsWith(".png")) {
      const lNameLen = view.getUint16(localOfs + 26, true);
      const lExtraLen = view.getUint16(localOfs + 28, true);
      const dataStart = localOfs + 30 + lNameLen + lExtraLen;
      const rawBytes = data.subarray(dataStart, dataStart + csize);
      const bytes = method === 8 ? new Uint8Array(inflateRawSync(rawBytes)) : new Uint8Array(rawBytes);
      out.push({ name, bytes });
    }
    ofs += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe.skipIf(!havePak)("decodePNG -- FULL retail census (every .png in pak0.pak + Q2Game.kpf)", () => {
  test(
    "every retail PNG decodes: correct size, plausible pixel data",
    () => {
      const all = [...pakPngs(PAK_PATH), ...kpfPngs(KPF_PATH)];
      expect(all.length).toBeGreaterThan(2000);
      const failures: string[] = [];
      let paletteSeen = 0;
      let sixteenSeen = 0;
      let interlacedSeen = 0;
      for (const f of all) {
        const ct = f.bytes[25];
        const bd = f.bytes[24];
        const il = f.bytes[28];
        if (ct === 3) paletteSeen++;
        if (bd === 16) sixteenSeen++;
        if (il === 1) interlacedSeen++;
        const r = decodePNG(f.bytes);
        if (!r.ok) {
          failures.push(`${f.name}: ${r.reason}`);
          continue;
        }
        if (r.image.pixels.length !== r.image.width * r.image.height * 4) {
          failures.push(`${f.name}: pixel buffer size mismatch`);
        }
      }
      expect(failures).toEqual([]);
      // The census that motivated this sweep: all three formerly-rejected
      // variants must actually be present in the data, or this test has
      // silently stopped covering them.
      expect(paletteSeen).toBeGreaterThan(400);
      expect(sixteenSeen).toBeGreaterThanOrEqual(1);
      expect(interlacedSeen).toBeGreaterThanOrEqual(2);
    },
    120000,
  );

  test("the exact blocker file: v_machn md5 skin decodes with real color variation", () => {
    const skins = pakPngs(PAK_PATH).filter((f) => f.name === "models/weapons/v_machn/md5/skin.png");
    expect(skins.length).toBe(1);
    const r = decodePNG(skins[0].bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Palette decode must produce a real image, not a flat fill: count
    // distinct RGB values across the skin.
    const seen = new Set<number>();
    const px = r.image.pixels;
    for (let i = 0; i < px.length; i += 4) seen.add((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    expect(seen.size).toBeGreaterThan(16);
    // No tRNS in this file: fully opaque.
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) {
        expect(px[i]).toBe(255);
        break;
      }
    }
  });
});
