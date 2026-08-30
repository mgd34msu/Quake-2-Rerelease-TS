import { describe, expect, test, beforeEach } from "bun:test";
import {
  SizeBuf,
  SZ_Init,
  SZ_Write,
  SZ_Print,
  MSG_WriteChar,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteFloat,
  MSG_WriteString,
  MSG_WriteCoord,
  MSG_WritePos,
  MSG_WriteAngle,
  MSG_WriteAngle16,
  MSG_WriteDir,
  MSG_BeginReading,
  MSG_ReadChar,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadFloat,
  MSG_ReadString,
  MSG_ReadStringLine,
  MSG_ReadCoord,
  MSG_ReadPos,
  MSG_ReadAngle,
  MSG_ReadAngle16,
  MSG_ReadDir,
} from "../src/qcommon/sizebuf";
import { vec3 } from "../src/shared/math";
import { ComError } from "../src/qcommon/qcommon";
import { CVAR_LATCH, CVAR_ARCHIVE } from "../src/shared/q_shared";
import { Cvar_Get, Cvar_Set, Cvar_VariableValue, Cvar_VariableString, Cvar_GetLatchedVars, Cvar_ForceSet } from "../src/qcommon/cvar";
import { Com_SetServerState } from "../src/qcommon/common";
import { Cbuf_Init, Cbuf_AddText, Cbuf_Execute, Cmd_AddCommand, Cmd_Init, Cmd_TokenizeString, Cmd_Argc, Cmd_Argv, Cmd_ExecuteString } from "../src/qcommon/cmd";

function newBuf(size = 256): SizeBuf {
  const sb = new SizeBuf();
  SZ_Init(sb, new Uint8Array(size), size);
  return sb;
}

describe("SizeBuf / MSG_* primitives", () => {
  test("char round-trips including negative values", () => {
    const sb = newBuf();
    MSG_WriteChar(sb, -1);
    MSG_WriteChar(sb, -128);
    MSG_WriteChar(sb, 127);
    MSG_WriteChar(sb, 0);
    MSG_BeginReading(sb);
    expect(MSG_ReadChar(sb)).toBe(-1);
    expect(MSG_ReadChar(sb)).toBe(-128);
    expect(MSG_ReadChar(sb)).toBe(127);
    expect(MSG_ReadChar(sb)).toBe(0);
  });

  test("byte round-trips as unsigned 0-255", () => {
    const sb = newBuf();
    MSG_WriteByte(sb, 0);
    MSG_WriteByte(sb, 255);
    MSG_WriteByte(sb, 128);
    MSG_BeginReading(sb);
    expect(MSG_ReadByte(sb)).toBe(0);
    expect(MSG_ReadByte(sb)).toBe(255);
    expect(MSG_ReadByte(sb)).toBe(128);
  });

  test("short round-trips including negative values", () => {
    const sb = newBuf();
    MSG_WriteShort(sb, -1);
    MSG_WriteShort(sb, -32768);
    MSG_WriteShort(sb, 32767);
    MSG_WriteShort(sb, 0);
    MSG_BeginReading(sb);
    expect(MSG_ReadShort(sb)).toBe(-1);
    expect(MSG_ReadShort(sb)).toBe(-32768);
    expect(MSG_ReadShort(sb)).toBe(32767);
    expect(MSG_ReadShort(sb)).toBe(0);
  });

  test("long round-trips including negative values", () => {
    const sb = newBuf();
    MSG_WriteLong(sb, -1);
    MSG_WriteLong(sb, -2147483648);
    MSG_WriteLong(sb, 2147483647);
    MSG_WriteLong(sb, 12345678);
    MSG_BeginReading(sb);
    expect(MSG_ReadLong(sb)).toBe(-1);
    expect(MSG_ReadLong(sb)).toBe(-2147483648);
    expect(MSG_ReadLong(sb)).toBe(2147483647);
    expect(MSG_ReadLong(sb)).toBe(12345678);
  });

  test("float round-trips", () => {
    const sb = newBuf();
    MSG_WriteFloat(sb, 3.5);
    MSG_WriteFloat(sb, -123.25);
    MSG_WriteFloat(sb, 0);
    MSG_BeginReading(sb);
    expect(MSG_ReadFloat(sb)).toBeCloseTo(3.5, 5);
    expect(MSG_ReadFloat(sb)).toBeCloseTo(-123.25, 5);
    expect(MSG_ReadFloat(sb)).toBe(0);
  });

  test("string read/write includes trailing NUL and stops at it", () => {
    const sb = newBuf();
    MSG_WriteString(sb, "hello");
    // NUL terminator means cursize is length+1
    expect(sb.cursize).toBe(6);
    MSG_BeginReading(sb);
    expect(MSG_ReadString(sb)).toBe("hello");
    // reading again after the NUL: readcount is past cursize, returns "" via -1 sentinel
    expect(MSG_ReadString(sb)).toBe("");
  });

  test("null string writes a single empty-string NUL byte", () => {
    const sb = newBuf();
    MSG_WriteString(sb, null);
    expect(sb.cursize).toBe(1);
    MSG_BeginReading(sb);
    expect(MSG_ReadString(sb)).toBe("");
  });

  test("string line stops at newline, not at the following NUL", () => {
    const sb = newBuf();
    MSG_WriteString(sb, "first\nsecond");
    MSG_BeginReading(sb);
    expect(MSG_ReadStringLine(sb)).toBe("first");
  });

  test("coord quantizes to short*8 with C truncation toward zero", () => {
    const sb = newBuf();
    MSG_WriteCoord(sb, 100.9);
    MSG_WriteCoord(sb, -100.9);
    MSG_BeginReading(sb);
    // (int)(100.9*8) = (int)807.2 = 807 -> 807/8 = 100.875
    expect(MSG_ReadCoord(sb)).toBeCloseTo(807 / 8, 6);
    // (int)(-100.9*8) = (int)(-807.2) = -807 (truncation toward zero, not floor)
    expect(MSG_ReadCoord(sb)).toBeCloseTo(-807 / 8, 6);
  });

  test("pos round-trips three coords", () => {
    const sb = newBuf();
    MSG_WritePos(sb, vec3(1, -2, 3.5));
    MSG_BeginReading(sb);
    const out = vec3();
    MSG_ReadPos(sb, out);
    expect(out[0]).toBeCloseTo(1, 3);
    expect(out[1]).toBeCloseTo(-2, 3);
    expect(out[2]).toBeCloseTo(3.5, 3);
  });

  test("angle quantizes to a byte, 256 units per 360 degrees, masked to 0-255", () => {
    const sb = newBuf();
    MSG_WriteAngle(sb, 90);
    MSG_WriteAngle(sb, -90);
    MSG_BeginReading(sb);
    // (int)(90*256/360) & 255 = 64
    const a1 = MSG_ReadAngle(sb);
    const a2 = MSG_ReadAngle(sb);
    expect(a1).toBeCloseTo(90, 5);
    // (int)(-90*256/360) & 255 = (-64) & 255 = 192, but MSG_ReadAngle reads the
    // byte back through MSG_ReadChar (signed), so 192 reads back as -64 and
    // round-trips to exactly -90 -- no quantization loss for this angle.
    expect(a2).toBeCloseTo(-90, 5);
  });

  test("angle16 uses full short precision via ANGLE2SHORT/SHORT2ANGLE", () => {
    const sb = newBuf();
    MSG_WriteAngle16(sb, 45);
    MSG_BeginReading(sb);
    expect(MSG_ReadAngle16(sb)).toBeCloseTo(45, 2);
  });

  test("dir writes the closest bytedirs index and reads it back", () => {
    const sb = newBuf();
    MSG_WriteDir(sb, vec3(0, 0, 1));
    MSG_BeginReading(sb);
    const out = vec3();
    MSG_ReadDir(sb, out);
    expect(out[0]).toBeCloseTo(0, 3);
    expect(out[1]).toBeCloseTo(0, 3);
    expect(out[2]).toBeCloseTo(1, 3);
  });

  test("reads past cursize return -1 and stop", () => {
    const sb = newBuf();
    MSG_WriteByte(sb, 1);
    MSG_BeginReading(sb);
    expect(MSG_ReadByte(sb)).toBe(1);
    expect(MSG_ReadByte(sb)).toBe(-1);
    expect(MSG_ReadShort(sb)).toBe(-1);
    expect(MSG_ReadLong(sb)).toBe(-1);
  });

  test("SZ_GetSpace throws ComError on overflow when allowoverflow is false", () => {
    const sb = newBuf(4);
    expect(() => {
      MSG_WriteLong(sb, 1);
      MSG_WriteByte(sb, 1); // 5th byte overflows a 4-byte buffer
    }).toThrow(ComError);
  });

  test("SZ_GetSpace clears and sets overflowed when allowoverflow is true", () => {
    const sb = newBuf(4);
    sb.allowoverflow = true;
    MSG_WriteLong(sb, 1);
    MSG_WriteByte(sb, 1); // overflows; should clear instead of throwing
    expect(sb.overflowed).toBe(true);
    expect(sb.cursize).toBe(1); // cleared then the 1 byte from this call was written
  });

  test("SZ_Print concatenates strings, writing over the previous trailing NUL", () => {
    const sb = newBuf();
    SZ_Print(sb, "abc");
    SZ_Print(sb, "def");
    MSG_BeginReading(sb);
    expect(MSG_ReadString(sb)).toBe("abcdef");
  });
});

describe("Cvar_*", () => {
  test("Cvar_Get creates a cvar with the given value and flags do not overwrite value on re-get", () => {
    const v = Cvar_Get("test_cvar_a", "1", 0);
    expect(v).not.toBeNull();
    expect(v?.string).toBe("1");
    expect(v?.value).toBe(1);

    const v2 = Cvar_Get("test_cvar_a", "2", CVAR_ARCHIVE);
    expect(v2?.string).toBe("1"); // unchanged
    expect((v2?.flags ?? 0) & CVAR_ARCHIVE).toBe(CVAR_ARCHIVE); // flags OR'ed in
  });

  test("Cvar_Set changes an existing cvar's value", () => {
    Cvar_Get("test_cvar_b", "1", 0);
    Cvar_Set("test_cvar_b", "42");
    expect(Cvar_VariableValue("test_cvar_b")).toBe(42);
    expect(Cvar_VariableString("test_cvar_b")).toBe("42");
  });

  test("Cvar_VariableValue/String return 0/'' for undefined cvars", () => {
    expect(Cvar_VariableValue("does_not_exist_xyz")).toBe(0);
    expect(Cvar_VariableString("does_not_exist_xyz")).toBe("");
  });

  test("CVAR_LATCH applies immediately while Com_ServerState() is 0 (no game running)", () => {
    Com_SetServerState(0);
    Cvar_Get("test_latch_a", "1", CVAR_LATCH);
    Cvar_Set("test_latch_a", "2");
    expect(Cvar_VariableString("test_latch_a")).toBe("2");
  });

  test("CVAR_LATCH defers the change until Cvar_GetLatchedVars while a game is running", () => {
    Com_SetServerState(1);
    Cvar_Get("test_latch_b", "1", CVAR_LATCH);
    Cvar_Set("test_latch_b", "2");
    // not applied yet
    expect(Cvar_VariableString("test_latch_b")).toBe("1");
    Cvar_GetLatchedVars();
    expect(Cvar_VariableString("test_latch_b")).toBe("2");
    Com_SetServerState(0);
  });

  test("Cvar_ForceSet bypasses CVAR_NOSET", () => {
    Cvar_Get("test_noset", "1", 8 /* CVAR_NOSET */);
    Cvar_Set("test_noset", "2");
    expect(Cvar_VariableString("test_noset")).toBe("1"); // rejected
    Cvar_ForceSet("test_noset", "2");
    expect(Cvar_VariableString("test_noset")).toBe("2");
  });
});

describe("Cbuf_*/Cmd_* command execution", () => {
  beforeEach(() => {
    Cbuf_Init();
    Cmd_Init(); // registers "alias" and "wait" among others; safe to call repeatedly
  });

  test("Cbuf_AddText + Cbuf_Execute runs newline-separated commands in order", () => {
    const calls: string[] = [];
    Cmd_AddCommand("cmdorder_a", () => calls.push("a"));
    Cmd_AddCommand("cmdorder_b", () => calls.push("b"));

    Cbuf_AddText("cmdorder_a\ncmdorder_b\n");
    Cbuf_Execute();

    expect(calls).toEqual(["a", "b"]);
  });

  test("semicolons separate commands on one line, but not inside quotes", () => {
    const calls: string[] = [];
    Cmd_AddCommand("semi_a", () => calls.push("a"));
    Cmd_AddCommand("semi_b", () => calls.push("b"));

    Cbuf_AddText("semi_a; semi_b\n");
    Cbuf_Execute();
    expect(calls).toEqual(["a", "b"]);
  });

  test("a semicolon inside a quoted argument does not split the command", () => {
    const seen: string[] = [];
    Cmd_AddCommand("semi_quoted", () => seen.push(Cmd_Argv(1)));

    Cbuf_AddText('semi_quoted "a;b"\n');
    Cbuf_Execute();

    expect(seen).toEqual(["a;b"]);
  });

  test("comment-only and CRLF lines tokenize to zero args (retail default.cfg regression)", () => {
    Cmd_TokenizeString("// KEY BINDINGS\r", true);
    expect(Cmd_Argc()).toBe(0);
    Cmd_TokenizeString("\r", true);
    expect(Cmd_Argc()).toBe(0);
    // a genuinely quoted empty token is still a token (C behavior)
    Cmd_TokenizeString('say ""', true);
    expect(Cmd_Argc()).toBe(2);
    expect(Cmd_Argv(1)).toBe("");
  });

  test("Cmd_TokenizeString fidelity: argc/argv, quoted tokens, and Cmd_Args", () => {
    Cmd_TokenizeString('say  hello   "quoted arg"  last', false);
    expect(Cmd_Argc()).toBe(4);
    expect(Cmd_Argv(0)).toBe("say");
    expect(Cmd_Argv(1)).toBe("hello");
    expect(Cmd_Argv(2)).toBe("quoted arg");
    expect(Cmd_Argv(3)).toBe("last");
    expect(Cmd_Argv(4)).toBe(""); // out of range is always safe, empty string
  });

  test("$macro expansion substitutes a cvar's value into the command line", () => {
    Cvar_Get("macro_test_cvar", "expanded_value", 0);
    const seen: string[] = [];
    Cmd_AddCommand("macro_echo", () => seen.push(Cmd_Argv(1)));

    Cmd_ExecuteString("macro_echo $macro_test_cvar");
    expect(seen).toEqual(["expanded_value"]);
  });

  test("alias expansion runs the aliased command", () => {
    // Cmd_ExecuteString queues an alias's expansion via Cbuf_InsertText rather
    // than running it inline (matching C: alias handling ends in
    // Cbuf_InsertText, not a direct call) -- a following Cbuf_Execute() is
    // needed to actually run it.
    const calls: string[] = [];
    Cmd_AddCommand("alias_target", () => calls.push("ran"));

    Cmd_ExecuteString("alias my_alias alias_target");
    Cmd_ExecuteString("my_alias");
    Cbuf_Execute();

    expect(calls).toEqual(["ran"]);
  });

  test("alias loop guard stops runaway self-referential aliases", () => {
    // A self-referential alias re-inserts itself at the front of cmd_text on
    // every Cbuf_Execute() pass, so the loop guard (alias_count, reset once
    // per Cbuf_Execute call) must be exercised through Cbuf_Execute, not a
    // single Cmd_ExecuteString call.
    Cbuf_AddText("alias loopy loopy\nloopy\n");
    expect(() => Cbuf_Execute()).not.toThrow();
  });
});
