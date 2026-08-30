import { describe, expect, test } from "bun:test";
import { CRC_Init, CRC_ProcessByte, CRC_Value, CRC_Block } from "../src/qcommon/crc";
import { MD4Ctx, MD4Init, MD4Update, MD4Final, Com_BlockChecksum } from "../src/qcommon/md4";

function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    out[i] = text.charCodeAt(i);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function md4Digest(input: Uint8Array): Uint8Array {
  const ctx = new MD4Ctx();
  const digest = new Uint8Array(16);
  MD4Init(ctx);
  MD4Update(ctx, input, input.length);
  MD4Final(digest, ctx);
  return digest;
}

// Independent bit-by-bit CRC-CCITT (poly 0x1021, init 0xFFFF, no reflection,
// xor-out 0x0000) reference, kept deliberately separate from crc.ts's
// byte-table implementation so the table can be checked against it.
function referenceCrcCcitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 8)) & 0xffff;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

describe("CRC-CCITT (crc.c)", () => {
  test("CRC_Block matches the independent bit-by-bit reference over '123456789'", () => {
    const data = bytesOf("123456789");
    expect(CRC_Block(data, data.length)).toBe(referenceCrcCcitt(data));
  });

  test("CRC_Block matches the independent bit-by-bit reference over a 256-byte ramp", () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = i;
    }
    expect(CRC_Block(data, data.length)).toBe(referenceCrcCcitt(data));
  });

  test("CRC_Init / CRC_ProcessByte / CRC_Value reproduce CRC_Block byte-by-byte", () => {
    const data = bytesOf("123456789");
    const crc = new Uint16Array(1);
    CRC_Init(crc);
    for (const byte of data) {
      CRC_ProcessByte(crc, byte);
    }
    expect(CRC_Value(crc[0])).toBe(CRC_Block(data, data.length));
    expect(CRC_Value(crc[0])).toBe(referenceCrcCcitt(data));
  });
});

describe("MD4 (md4.c) against RFC 1320 test vectors", () => {
  test("MD4('') == 31d6cfe0d16ae931b73c59d7e0c089c0", () => {
    expect(toHex(md4Digest(bytesOf("")))).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
  });

  test("MD4('a') == bde52cb31de33e46245e05fbdbd6fb24", () => {
    expect(toHex(md4Digest(bytesOf("a")))).toBe("bde52cb31de33e46245e05fbdbd6fb24");
  });

  test("MD4('abc') == a448017aaf21d8525fc10ae87aa6729d", () => {
    expect(toHex(md4Digest(bytesOf("abc")))).toBe("a448017aaf21d8525fc10ae87aa6729d");
  });

  test("MD4('message digest') == d9130a8164549fe818874806e1c7014b", () => {
    expect(toHex(md4Digest(bytesOf("message digest")))).toBe("d9130a8164549fe818874806e1c7014b");
  });

  test("Com_BlockChecksum XOR-folds the same verified digest words", () => {
    const input = bytesOf("abc");
    const digest = md4Digest(input);
    expect(toHex(digest)).toBe("a448017aaf21d8525fc10ae87aa6729d");

    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
    const expected =
      (view.getInt32(0, true) ^ view.getInt32(4, true) ^ view.getInt32(8, true) ^ view.getInt32(12, true)) >>> 0;

    expect(Com_BlockChecksum(input, input.length)).toBe(expected);
  });
});
