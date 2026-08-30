// Shared decode machinery for the Q2PRO/q2repro "batched move" client
// commands (clc_q2pro_move_batched / clc_q2pro_move_nodelta), ported from
// ~/Projects/q2proto's reference implementation (GPLv2-or-later; see
// q2repro.ts's file header for this port line's standing LICENSE FINDING --
// identical wording applies here, same upstream file family).
//
// ---------------------------------------------------------------------------
// SOURCES CONSULTED
// ---------------------------------------------------------------------------
//   src/q2proto_proto_q2repro.c:2679-2709 (q2repro_server_read_batch_move),
//     :2601-2677 (the per-command bit-level delta reader, protocol 1038)
//   src/q2proto_proto_q2pro.c:2477-2515 (q2pro_server_read_batch_move),
//     :2396-2475 (the per-command bit-level delta reader, protocol 36 --
//     identical frame/dup-loop shape to q2repro's, differing only in how
//     num_dups is obtained and in the CM_UP/CM_BUTTONS field encodings; see
//     q2pro.ts's/q2repro.ts's own per-protocol decodeCmd implementations)
//   src/q2proto_internal_bit_read_write.h:83-130 (bitreader_t / bitreader_read
//     -- an LSB-first, byte-lazy bit packer: bytes are pulled from the
//     underlying stream only as needed, buffered in a 32-bit accumulator,
//     and bits are consumed low-end-first; `bits<0` requests sign-extend the
//     result, matching this module's readSigned)
//   inc/q2proto/q2proto_struct_clc.h:104-122 (Q2PROTO_MAX_CLC_BATCH_MOVE_FRAMES
//     = 4, Q2PROTO_MAX_CLC_BATCH_MOVE_CMDS = 32 -- MAX_PACKET_FRAMES/
//     MAX_PACKET_USERCMDS in qsrc/q2repro/inc/common/protocol.h:120-121,
//     same values)
//   ~/Projects/qsrc/q2repro/src/server/user.c:1029-1059 (apply_usercmd_delta
//     -- the real server's "resolve one delta into a full usercmd_t" step;
//     q2proto's own decode only produces a *delta* struct plus a
//     `delta_bits` bitmask of which fields were present. This port fuses
//     decode+apply into one call per command -- see decodeCmd's own doc
//     comment below for exactly how apply_usercmd_delta's semantics map onto
//     that fusion -- since nothing else in this engine ever needs the
//     intermediate delta-only struct.)
//
// ---------------------------------------------------------------------------
// KEY FINDING: upmove is decoded (on protocol 36) or rejected (on protocol
// 1038) but NEVER applied to the resulting command, on EITHER protocol
// ---------------------------------------------------------------------------
// apply_usercmd_delta (user.c:1029-1059) copies angles[0..2], forwardmove,
// sidemove, and buttons from the decoded delta into the resolved usercmd_t,
// but has NO `to->upmove = ...` line at all -- verified by reading the full
// function body. This holds regardless of which protocol produced the delta:
// q2pro's plain-tier batch format CAN carry a CM_UP bit + a -10-bit value
// (q2pro.c:2457-2461), but the real server discards it after decoding;
// q2repro's format hard-rejects CM_UP instead (Q2P_ERR_BAD_DATA,
// q2proto_proto_q2repro.c:2662-2663) since it never reaches apply either way.
// This port matches both behaviors exactly (see q2pro.ts's/q2repro.ts's
// decodeCmd functions) -- vertical movement/jumping under these protocols is
// carried entirely through BUTTON flags in the rerelease's movement model,
// not usercmd_t.upmove, which is why real q2repro clients never need the bit
// q2repro's own decoder rejects.
//
// ---------------------------------------------------------------------------
// KEY FINDING: the per-command "lightlevel" byte is decoded but never used
// ---------------------------------------------------------------------------
// q2repro_server_read_batch_move/q2pro_server_read_batch_move both read one
// lightlevel byte per MESSAGE (not per command) and stamp it onto every
// decoded q2proto_clc_move_delta_t in the message (q2repro.c:2704). But
// apply_usercmd_delta never reads move_delta->lightlevel, so it never reaches
// usercmd_t.lightlevel on the real server -- this port reads and discards the
// byte for wire-alignment only (see q2repro.ts's/q2pro.ts's readBatchMove).

import type { SizeBuf } from "../sizebuf";
import { MSG_ReadByte } from "../sizebuf";
import { CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP, CM_BUTTONS, CM_IMPULSE } from "../qcommon";
import { UsercmdT } from "../../shared/q_shared";

export const MAX_CLC_BATCH_MOVE_FRAMES = 4; // Q2PROTO_MAX_CLC_BATCH_MOVE_FRAMES
export const MAX_CLC_BATCH_MOVE_CMDS = 32; // Q2PROTO_MAX_CLC_BATCH_MOVE_CMDS -- unreachable as a bound check (see readBatchMoveFrames doc comment), kept as a named citation only.

export { CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP, CM_BUTTONS, CM_IMPULSE };

// Thrown for any malformed/truncated batched-move (or userinfo-delta) wire
// body. Deliberately NOT a ComError/ERR_DROP: throwing ERR_DROP here would
// unwind through Qcommon_Frame's top-level `catch (err) { if (err instanceof
// ComError) return; }` (src/main.ts) and abort the ENTIRE server frame for
// every connected client, matching vanilla Quake 2's setjmp/abortframe
// behavior -- but that is NOT what a real q2repro/Q2PRO server does for a
// malformed client message. qsrc/q2repro/src/server/user.c's own
// SV_ExecuteClientMessage instead calls `SV_DropClient(client, "bad client
// message (%s)")` for exactly this class of error (a q2proto_error_t !=
// Q2P_ERR_SUCCESS) -- dropping ONLY the offending client and letting the
// frame continue normally for everyone else. sv_user.ts's dispatch loop
// catches this exception type at each call site and converts it to that same
// SV_DropClient-and-continue behavior, matching the real server's fidelity
// exactly instead of the codec layer reaching into server-layer state itself
// (codec.ts/this module are qcommon-layer and must not import sv_main.ts).
export class ClcBatchMoveError extends Error {}

// LSB-first bit reader over a SizeBuf, byte-lazy (pulls one more byte from
// the underlying message only when the accumulator runs short) -- ports
// q2proto_internal_bit_read_write.h's bitreader_t/bitreader_init/
// bitreader_read exactly. `bits` is always requested unsigned by this
// module's callers; sign-extension (the C's negative-`bits` convention) is a
// separate explicit call (readSigned) here rather than a signed/unsigned
// dual-purpose parameter, since TypeScript has no natural "negative means
// signed" idiom and this port line avoids overloading a numeric parameter's
// meaning by its sign.
export class BitReader {
  private buf = 0;
  private left = 0;

  constructor(private readonly msg: SizeBuf) {}

  private fill(bits: number): void {
    while (this.left < bits) {
      const byte = MSG_ReadByte(this.msg);
      if (byte < 0) {
        throw new ClcBatchMoveError("clc batch move: truncated message (bitreader ran past end of buffer)");
      }
      this.buf |= byte << this.left;
      this.left += 8;
    }
  }

  // Reads `bits` (1-25, matching bitreader_read's own asserted range -- this
  // format never requests more) as an unsigned value.
  readUnsigned(bits: number): number {
    this.fill(bits);
    const value = this.buf & ((1 << bits) - 1);
    this.buf >>>= bits;
    this.left -= bits;
    return value;
  }

  // Mirrors bitreader_read's `bits < 0` branch (sign_extend, q2proto_internal_
  // bit_read_write.h:96,126-127).
  readSigned(bits: number): number {
    const value = this.readUnsigned(bits);
    const signBit = 1 << (bits - 1);
    return (value ^ signBit) - signBit;
  }
}

// q2repro_server_read_batch_move_delta_angle / q2pro_server_read_batch_move_
// delta_angle (byte-for-byte identical between the two protocols): angle
// components 0/1 (pitch/yaw) may be sent as an 8-bit delta from the previous
// resolved command's angle, or as a full 16-bit absolute value. Component 2
// (roll) has no delta form at all -- callers read it directly with
// `br.readSigned(16)` instead of calling this helper (see q2repro.c:2646-2650
// /q2pro.c:2441-2445: the CM_ANGLE3 branch never calls the _angle helper).
export function readBatchMoveAngleComponent(br: BitReader, prevAngle: number): number {
  const deltaFlag = br.readUnsigned(1);
  if (deltaFlag) {
    const delta = br.readSigned(8);
    return prevAngle + delta; // Int16Array assignment at the call site wraps this exactly like the C's implicit int16_t truncation
  }
  return br.readSigned(16);
}

export interface ClcBatchMoveFrameT {
  cmds: UsercmdT[];
}

// q2repro_server_read_batch_move's/q2pro_server_read_batch_move's shared
// frame/dup loop (q2repro.c:2693-2707, q2pro.c:2492-2503 -- identical shape):
// `numDups+1` frames, each prefixed by a 5-bit command count, with the
// previous-command chain threaded CONTINUOUSLY across frame boundaries (not
// reset per frame -- `prev_move_delta` in the C is a single loop-scoped
// pointer covering the whole nested loop). `decodeCmd` supplies the one
// piece that genuinely differs per protocol (CM_UP/CM_BUTTONS field
// encodings -- see q2pro.ts's/q2repro.ts's own decodeCmd doc comments).
//
// No `numCmds >= MAX_CLC_BATCH_MOVE_CMDS` bound check: numCmds is read as an
// unsigned 5-bit field (0-31), which can never reach 32, so
// qsrc/q2repro/src/server/user.c:1149's matching runtime check
// ("too many usercmds in frame") is unreachable dead code on the real server
// too -- not a check this port is missing, a check upstream itself can never
// trigger.
export function readBatchMoveFrames(br: BitReader, numDups: number, decodeCmd: (br: BitReader, prev: UsercmdT | null) => UsercmdT): ClcBatchMoveFrameT[] {
  const frames: ClcBatchMoveFrameT[] = [];
  let prev: UsercmdT | null = null;
  for (let i = 0; i <= numDups; i++) {
    const numCmds = br.readUnsigned(5);
    const cmds: UsercmdT[] = [];
    for (let j = 0; j < numCmds; j++) {
      const cmd = decodeCmd(br, prev);
      cmds.push(cmd);
      prev = cmd;
    }
    frames.push({ cmds });
  }
  return frames;
}

// Shared "start of decodeCmd" step for both protocols: apply_usercmd_delta's
// `memcpy(to, from, sizeof(*to))` (or zero-init when `from` is NULL) --
// user.c:1033-1037. Every field not explicitly overwritten by a delta bit
// below therefore inherits the previous resolved command's value, including
// forwardmove/sidemove/buttons/upmove/lightlevel (NOT just angles/msec, which
// is the easy mistake to make reading q2proto_clc_move_delta_t's OWN internal
// carry-forward of angles/msec in isolation -- apply_usercmd_delta's blanket
// memcpy is what actually makes every other field sticky too).
export function seedFromPrev(prev: UsercmdT | null): UsercmdT {
  const cmd = new UsercmdT();
  if (prev) {
    cmd.angles.set(prev.angles);
    cmd.forwardmove = prev.forwardmove;
    cmd.sidemove = prev.sidemove;
    cmd.upmove = prev.upmove;
    cmd.buttons = prev.buttons;
    cmd.impulse = prev.impulse;
    cmd.msec = prev.msec;
    cmd.lightlevel = prev.lightlevel;
  }
  return cmd;
}
