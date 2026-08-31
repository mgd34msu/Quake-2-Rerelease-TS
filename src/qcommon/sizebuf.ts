// sizebuf_t and the SZ_*/MSG_* functions from common.c.
//
// sizebuf_t -> SizeBuf class over a Uint8Array + DataView. C callers pass a
// `byte *data` pointer around; here SZ_GetSpace returns the byte offset at
// which the caller may write `length` bytes into buf.data/buf.view instead.

import { ComError } from "./qcommon";
import { ERR_FATAL, ERR_DROP, CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP, CM_BUTTONS, CM_IMPULSE } from "./qcommon";
import {
  U_ORIGIN1,
  U_ORIGIN2,
  U_ORIGIN3,
  U_ANGLE1,
  U_ANGLE2,
  U_ANGLE3,
  U_SKIN8,
  U_SKIN16,
  U_FRAME8,
  U_FRAME16,
  U_EFFECTS8,
  U_EFFECTS16,
  U_RENDERFX8,
  U_RENDERFX16,
  U_SOLID,
  U_EVENT,
  U_MODEL,
  U_MODEL2,
  U_MODEL3,
  U_MODEL4,
  U_SOUND,
  U_OLDORIGIN,
  U_NUMBER16,
  U_MOREBITS1,
  U_MOREBITS2,
  U_MOREBITS3,
} from "./qcommon";
import { Com_Printf } from "./common";
import { bytedirs, NUMVERTEXNORMALS } from "./anorms";
import { type Vec3, DotProduct, VectorCopy } from "../shared/math";
import { type EntityStateT, type UsercmdT, MAX_EDICTS, RF_BEAM, ANGLE2SHORT, SHORT2ANGLE } from "../shared/q_shared";

export class SizeBuf {
  allowoverflow = false; // if false, do a Com_Error
  overflowed = false; // set to true if the buffer size failed
  data: Uint8Array = new Uint8Array(0);
  view: DataView = new DataView(new ArrayBuffer(0));
  maxsize = 0;
  cursize = 0;
  readcount = 0;
}

export function SZ_Init(buf: SizeBuf, data: Uint8Array, length: number): void {
  buf.allowoverflow = false;
  buf.overflowed = false;
  buf.cursize = 0;
  buf.readcount = 0;
  buf.data = data;
  buf.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  buf.maxsize = length;
}

export function SZ_Clear(buf: SizeBuf): void {
  buf.cursize = 0;
  buf.overflowed = false;
}

// Returns the byte offset the caller should write `length` bytes at,
// mirroring the C `void *SZ_GetSpace` return value (buf->data + buf->cursize).
export function SZ_GetSpace(buf: SizeBuf, length: number): number {
  if (buf.cursize + length > buf.maxsize) {
    if (!buf.allowoverflow) {
      throw new ComError(ERR_FATAL, "SZ_GetSpace: overflow without allowoverflow set");
    }

    if (length > buf.maxsize) {
      throw new ComError(ERR_FATAL, `SZ_GetSpace: ${length} is > full buffer size`);
    }

    Com_Printf("SZ_GetSpace: overflow\n");
    SZ_Clear(buf);
    buf.overflowed = true;
  }

  const offset = buf.cursize;
  buf.cursize += length;
  return offset;
}

export function SZ_Write(buf: SizeBuf, data: Uint8Array, length: number): void {
  const offset = SZ_GetSpace(buf, length);
  buf.data.set(data.subarray(0, length), offset);
}

// strcats onto the sizebuf
export function SZ_Print(buf: SizeBuf, text: string): void {
  const bytes = stringToBytesNulTerminated(text);
  const len = bytes.length; // includes trailing NUL

  if (buf.cursize) {
    if (buf.data[buf.cursize - 1] !== 0) {
      const offset = SZ_GetSpace(buf, len); // no trailing 0
      buf.data.set(bytes, offset);
    } else {
      const offset = SZ_GetSpace(buf, len - 1) - 1; // write over trailing 0
      buf.data.set(bytes, offset);
    }
  } else {
    const offset = SZ_GetSpace(buf, len);
    buf.data.set(bytes, offset);
  }
}

//============================================================================
// byte <-> string helpers (C treats these as raw bytes, not UTF-8)

function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function stringToBytesNulTerminated(s: string): Uint8Array {
  const out = new Uint8Array(s.length + 1);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  out[s.length] = 0;
  return out;
}

//============================================================================
// writing functions

export function MSG_WriteChar(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 1);
  sb.data[offset] = c & 0xff;
}

export function MSG_WriteByte(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 1);
  sb.data[offset] = c & 0xff;
}

export function MSG_WriteShort(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 2);
  sb.data[offset] = c & 0xff;
  sb.data[offset + 1] = (c >> 8) & 0xff;
}

export function MSG_WriteLong(sb: SizeBuf, c: number): void {
  const offset = SZ_GetSpace(sb, 4);
  sb.data[offset] = c & 0xff;
  sb.data[offset + 1] = (c >> 8) & 0xff;
  sb.data[offset + 2] = (c >> 16) & 0xff;
  sb.data[offset + 3] = (c >> 24) & 0xff;
}

export function MSG_WriteFloat(sb: SizeBuf, f: number): void {
  const offset = SZ_GetSpace(sb, 4);
  sb.view.setFloat32(offset, f, true);
}

// common/msg.c's MSG_WriteLong64/MSG_ReadLong64 (WL64/RL64: 8 bytes,
// little-endian, signed) -- used by the SSV2 savegame container's
// `MSG_WriteLong64(time(NULL))` comment-field timestamp. `bigint` (not
// `number`) so a full 64-bit round trip never loses precision the way
// `Number` would past 2^53.
export function MSG_WriteLong64(sb: SizeBuf, c: bigint): void {
  const offset = SZ_GetSpace(sb, 8);
  sb.view.setBigInt64(offset, c, true);
}

export function MSG_WriteString(sb: SizeBuf, s: string | null): void {
  if (s === null) {
    SZ_Write(sb, new Uint8Array([0]), 1);
  } else {
    const bytes = stringToBytesNulTerminated(s);
    SZ_Write(sb, bytes, bytes.length);
  }
}

export function MSG_WriteCoord(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, Math.trunc(f * 8));
}

export function MSG_WritePos(sb: SizeBuf, pos: Vec3): void {
  MSG_WriteShort(sb, Math.trunc(pos[0] * 8));
  MSG_WriteShort(sb, Math.trunc(pos[1] * 8));
  MSG_WriteShort(sb, Math.trunc(pos[2] * 8));
}

export function MSG_WriteAngle(sb: SizeBuf, f: number): void {
  MSG_WriteByte(sb, Math.trunc((f * 256) / 360) & 255);
}

export function MSG_WriteAngle16(sb: SizeBuf, f: number): void {
  MSG_WriteShort(sb, ANGLE2SHORT(f));
}

export function MSG_WriteDeltaUsercmd(buf: SizeBuf, from: UsercmdT, cmd: UsercmdT): void {
  let bits = 0;

  if (cmd.angles[0] !== from.angles[0]) bits |= CM_ANGLE1;
  if (cmd.angles[1] !== from.angles[1]) bits |= CM_ANGLE2;
  if (cmd.angles[2] !== from.angles[2]) bits |= CM_ANGLE3;
  if (cmd.forwardmove !== from.forwardmove) bits |= CM_FORWARD;
  if (cmd.sidemove !== from.sidemove) bits |= CM_SIDE;
  if (cmd.upmove !== from.upmove) bits |= CM_UP;
  if (cmd.buttons !== from.buttons) bits |= CM_BUTTONS;
  if (cmd.impulse !== from.impulse) bits |= CM_IMPULSE;

  MSG_WriteByte(buf, bits);

  if (bits & CM_ANGLE1) MSG_WriteShort(buf, cmd.angles[0]);
  if (bits & CM_ANGLE2) MSG_WriteShort(buf, cmd.angles[1]);
  if (bits & CM_ANGLE3) MSG_WriteShort(buf, cmd.angles[2]);

  if (bits & CM_FORWARD) MSG_WriteShort(buf, cmd.forwardmove);
  if (bits & CM_SIDE) MSG_WriteShort(buf, cmd.sidemove);
  if (bits & CM_UP) MSG_WriteShort(buf, cmd.upmove);

  if (bits & CM_BUTTONS) MSG_WriteByte(buf, cmd.buttons);
  if (bits & CM_IMPULSE) MSG_WriteByte(buf, cmd.impulse);

  MSG_WriteByte(buf, cmd.msec);
  MSG_WriteByte(buf, cmd.lightlevel);
}

export function MSG_WriteDir(sb: SizeBuf, dir: Vec3 | null): void {
  if (!dir) {
    MSG_WriteByte(sb, 0);
    return;
  }

  let bestd = 0;
  let best = 0;
  for (let i = 0; i < NUMVERTEXNORMALS; i++) {
    const d = DotProduct(dir, bytedirs[i]);
    if (d > bestd) {
      bestd = d;
      best = i;
    }
  }
  MSG_WriteByte(sb, best);
}

export function MSG_ReadDir(sb: SizeBuf, dir: Vec3): void {
  const b = MSG_ReadByte(sb);
  if (b >= NUMVERTEXNORMALS) {
    throw new ComError(ERR_DROP, "MSF_ReadDir: out of range");
  }
  VectorCopy(bytedirs[b], dir);
}

// Writes part of a packetentities message.
// Can delta from either a baseline or a previous packet_entity
export function MSG_WriteDeltaEntity(from: EntityStateT, to: EntityStateT, msg: SizeBuf, force: boolean, newentity: boolean): void {
  if (!to.number) {
    throw new ComError(ERR_FATAL, "Unset entity number");
  }
  if (to.number >= MAX_EDICTS) {
    throw new ComError(ERR_FATAL, "Entity number >= MAX_EDICTS");
  }

  let bits = 0;

  if (to.number >= 256) bits |= U_NUMBER16; // number8 is implicit otherwise

  if (to.origin[0] !== from.origin[0]) bits |= U_ORIGIN1;
  if (to.origin[1] !== from.origin[1]) bits |= U_ORIGIN2;
  if (to.origin[2] !== from.origin[2]) bits |= U_ORIGIN3;

  if (to.angles[0] !== from.angles[0]) bits |= U_ANGLE1;
  if (to.angles[1] !== from.angles[1]) bits |= U_ANGLE2;
  if (to.angles[2] !== from.angles[2]) bits |= U_ANGLE3;

  if (to.skinnum !== from.skinnum) {
    if ((to.skinnum >>> 0) < 256) bits |= U_SKIN8;
    else if ((to.skinnum >>> 0) < 0x10000) bits |= U_SKIN16;
    else bits |= U_SKIN8 | U_SKIN16;
  }

  if (to.frame !== from.frame) {
    if (to.frame < 256) bits |= U_FRAME8;
    else bits |= U_FRAME16;
  }

  if (to.effects !== from.effects) {
    if (to.effects < 256) bits |= U_EFFECTS8;
    else if (to.effects < 0x8000) bits |= U_EFFECTS16;
    else bits |= U_EFFECTS8 | U_EFFECTS16;
  }

  if (to.renderfx !== from.renderfx) {
    if (to.renderfx < 256) bits |= U_RENDERFX8;
    else if (to.renderfx < 0x8000) bits |= U_RENDERFX16;
    else bits |= U_RENDERFX8 | U_RENDERFX16;
  }

  if (to.solid !== from.solid) bits |= U_SOLID;

  // event is not delta compressed, just 0 compressed
  if (to.event) bits |= U_EVENT;

  if (to.modelindex !== from.modelindex) bits |= U_MODEL;
  if (to.modelindex2 !== from.modelindex2) bits |= U_MODEL2;
  if (to.modelindex3 !== from.modelindex3) bits |= U_MODEL3;
  if (to.modelindex4 !== from.modelindex4) bits |= U_MODEL4;

  if (to.sound !== from.sound) bits |= U_SOUND;

  if (newentity || to.renderfx & RF_BEAM) bits |= U_OLDORIGIN;

  //
  // write the message
  //
  if (!bits && !force) return; // nothing to send!

  //----------

  if (bits & 0xff000000) bits |= U_MOREBITS3 | U_MOREBITS2 | U_MOREBITS1;
  else if (bits & 0x00ff0000) bits |= U_MOREBITS2 | U_MOREBITS1;
  else if (bits & 0x0000ff00) bits |= U_MOREBITS1;

  MSG_WriteByte(msg, bits & 255);

  if (bits & 0xff000000) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
    MSG_WriteByte(msg, (bits >> 16) & 255);
    MSG_WriteByte(msg, (bits >> 24) & 255);
  } else if (bits & 0x00ff0000) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
    MSG_WriteByte(msg, (bits >> 16) & 255);
  } else if (bits & 0x0000ff00) {
    MSG_WriteByte(msg, (bits >> 8) & 255);
  }

  //----------

  if (bits & U_NUMBER16) MSG_WriteShort(msg, to.number);
  else MSG_WriteByte(msg, to.number);

  if (bits & U_MODEL) MSG_WriteByte(msg, to.modelindex);
  if (bits & U_MODEL2) MSG_WriteByte(msg, to.modelindex2);
  if (bits & U_MODEL3) MSG_WriteByte(msg, to.modelindex3);
  if (bits & U_MODEL4) MSG_WriteByte(msg, to.modelindex4);

  if (bits & U_FRAME8) MSG_WriteByte(msg, to.frame);
  if (bits & U_FRAME16) MSG_WriteShort(msg, to.frame);

  if (bits & U_SKIN8 && bits & U_SKIN16)
    // used for laser colors
    MSG_WriteLong(msg, to.skinnum);
  else if (bits & U_SKIN8) MSG_WriteByte(msg, to.skinnum);
  else if (bits & U_SKIN16) MSG_WriteShort(msg, to.skinnum);

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) MSG_WriteLong(msg, to.effects);
  else if (bits & U_EFFECTS8) MSG_WriteByte(msg, to.effects);
  else if (bits & U_EFFECTS16) MSG_WriteShort(msg, to.effects);

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) MSG_WriteLong(msg, to.renderfx);
  else if (bits & U_RENDERFX8) MSG_WriteByte(msg, to.renderfx);
  else if (bits & U_RENDERFX16) MSG_WriteShort(msg, to.renderfx);

  if (bits & U_ORIGIN1) MSG_WriteCoord(msg, to.origin[0]);
  if (bits & U_ORIGIN2) MSG_WriteCoord(msg, to.origin[1]);
  if (bits & U_ORIGIN3) MSG_WriteCoord(msg, to.origin[2]);

  if (bits & U_ANGLE1) MSG_WriteAngle(msg, to.angles[0]);
  if (bits & U_ANGLE2) MSG_WriteAngle(msg, to.angles[1]);
  if (bits & U_ANGLE3) MSG_WriteAngle(msg, to.angles[2]);

  if (bits & U_OLDORIGIN) {
    MSG_WriteCoord(msg, to.old_origin[0]);
    MSG_WriteCoord(msg, to.old_origin[1]);
    MSG_WriteCoord(msg, to.old_origin[2]);
  }

  if (bits & U_SOUND) MSG_WriteByte(msg, to.sound);
  if (bits & U_EVENT) MSG_WriteByte(msg, to.event);
  if (bits & U_SOLID) MSG_WriteShort(msg, to.solid);
}

//============================================================
// reading functions

export function MSG_BeginReading(msg: SizeBuf): void {
  msg.readcount = 0;
}

// returns -1 if no more characters are available
export function MSG_ReadChar(msgRead: SizeBuf): number {
  let c: number;

  if (msgRead.readcount + 1 > msgRead.cursize) {
    c = -1;
  } else {
    const b = msgRead.data[msgRead.readcount];
    c = (b << 24) >> 24; // signed char
  }
  msgRead.readcount++;

  return c;
}

export function MSG_ReadByte(msgRead: SizeBuf): number {
  let c: number;

  if (msgRead.readcount + 1 > msgRead.cursize) {
    c = -1;
  } else {
    c = msgRead.data[msgRead.readcount];
  }
  msgRead.readcount++;

  return c;
}

export function MSG_ReadShort(msgRead: SizeBuf): number {
  let c: number;

  if (msgRead.readcount + 2 > msgRead.cursize) {
    c = -1;
  } else {
    const b0 = msgRead.data[msgRead.readcount];
    const b1 = msgRead.data[msgRead.readcount + 1];
    c = (((b0 | (b1 << 8)) << 16) >> 16); // (short) cast
  }

  msgRead.readcount += 2;

  return c;
}

/*
q2repro src/common/msg.c:1750-1762 `int MSG_ReadWord(void)` -- the UNSIGNED
16-bit counterpart of MSG_ReadShort above (`c = (uint16_t)RL16(buf)`, same
-1 short-read sentinel). Vanilla msg.c has no such reader because vanilla's
own 16-bit wire fields are all written from values it first proved to be
< 0x8000; the rerelease entity-delta encoders deliberately push the whole
0x0000..0xffff range through their 16-bit field width (q2repro msg.c:633,
`mask = 0xffff0000`, vs :635's `0xffff8000 // don't confuse old clients`),
so every rerelease-family 16-bit entity field has to be read back unsigned
or bit 15 sign-extends into bits 16..31.
*/
export function MSG_ReadWord(msgRead: SizeBuf): number {
  let c: number;

  if (msgRead.readcount + 2 > msgRead.cursize) {
    c = -1;
  } else {
    const b0 = msgRead.data[msgRead.readcount];
    const b1 = msgRead.data[msgRead.readcount + 1];
    c = (b0 | (b1 << 8)) >>> 0; // (uint16_t) cast
  }

  msgRead.readcount += 2;

  return c;
}

export function MSG_ReadLong(msgRead: SizeBuf): number {
  let c: number;

  if (msgRead.readcount + 4 > msgRead.cursize) {
    c = -1;
  } else {
    const b0 = msgRead.data[msgRead.readcount];
    const b1 = msgRead.data[msgRead.readcount + 1];
    const b2 = msgRead.data[msgRead.readcount + 2];
    const b3 = msgRead.data[msgRead.readcount + 3];
    c = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
  }

  msgRead.readcount += 4;

  return c;
}

export function MSG_ReadFloat(msgRead: SizeBuf): number {
  let f: number;

  if (msgRead.readcount + 4 > msgRead.cursize) {
    f = -1;
  } else {
    f = msgRead.view.getFloat32(msgRead.readcount, true);
  }
  msgRead.readcount += 4;

  return f;
}

// See MSG_WriteLong64's header comment for why this is `bigint`, not `number`.
export function MSG_ReadLong64(msgRead: SizeBuf): bigint {
  let c: bigint;

  if (msgRead.readcount + 8 > msgRead.cursize) {
    c = -1n;
  } else {
    c = msgRead.view.getBigInt64(msgRead.readcount, true);
  }
  msgRead.readcount += 8;

  return c;
}

export function MSG_ReadString(msgRead: SizeBuf): string {
  let s = "";
  let l = 0;

  do {
    const c = MSG_ReadChar(msgRead);
    if (c === -1 || c === 0) break;
    s += String.fromCharCode(c & 0xff);
    l++;
  } while (l < 2048 - 1);

  return s;
}

export function MSG_ReadStringLine(msgRead: SizeBuf): string {
  let s = "";
  let l = 0;

  do {
    const c = MSG_ReadChar(msgRead);
    if (c === -1 || c === 0 || c === 10 /* '\n' */) break;
    s += String.fromCharCode(c & 0xff);
    l++;
  } while (l < 2048 - 1);

  return s;
}

export function MSG_ReadCoord(msgRead: SizeBuf): number {
  return MSG_ReadShort(msgRead) * (1.0 / 8);
}

export function MSG_ReadPos(msgRead: SizeBuf, pos: Vec3): void {
  pos[0] = MSG_ReadShort(msgRead) * (1.0 / 8);
  pos[1] = MSG_ReadShort(msgRead) * (1.0 / 8);
  pos[2] = MSG_ReadShort(msgRead) * (1.0 / 8);
}

export function MSG_ReadAngle(msgRead: SizeBuf): number {
  return MSG_ReadChar(msgRead) * (360.0 / 256);
}

export function MSG_ReadAngle16(msgRead: SizeBuf): number {
  return SHORT2ANGLE(MSG_ReadShort(msgRead));
}

export function MSG_ReadDeltaUsercmd(msgRead: SizeBuf, from: UsercmdT, move: UsercmdT): void {
  move.msec = from.msec;
  move.buttons = from.buttons;
  move.angles[0] = from.angles[0];
  move.angles[1] = from.angles[1];
  move.angles[2] = from.angles[2];
  move.forwardmove = from.forwardmove;
  move.sidemove = from.sidemove;
  move.upmove = from.upmove;
  move.impulse = from.impulse;
  move.lightlevel = from.lightlevel;

  const bits = MSG_ReadByte(msgRead);

  // read current angles
  if (bits & CM_ANGLE1) move.angles[0] = MSG_ReadShort(msgRead);
  if (bits & CM_ANGLE2) move.angles[1] = MSG_ReadShort(msgRead);
  if (bits & CM_ANGLE3) move.angles[2] = MSG_ReadShort(msgRead);

  // read movement
  if (bits & CM_FORWARD) move.forwardmove = MSG_ReadShort(msgRead);
  if (bits & CM_SIDE) move.sidemove = MSG_ReadShort(msgRead);
  if (bits & CM_UP) move.upmove = MSG_ReadShort(msgRead);

  // read buttons
  if (bits & CM_BUTTONS) move.buttons = MSG_ReadByte(msgRead);

  if (bits & CM_IMPULSE) move.impulse = MSG_ReadByte(msgRead);

  // read time to run command
  move.msec = MSG_ReadByte(msgRead);

  // read the light level
  move.lightlevel = MSG_ReadByte(msgRead);
}

export function MSG_ReadData(msgRead: SizeBuf, data: Uint8Array, len: number): void {
  for (let i = 0; i < len; i++) {
    data[i] = MSG_ReadByte(msgRead) & 0xff;
  }
}

export { stringToBytes };
