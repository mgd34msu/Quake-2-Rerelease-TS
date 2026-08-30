// cl_demo.c -- demo PLAYBACK. There is no cl_demo.c in the original v3.19
// client tree (cl_main.ts's own header already establishes this precedent
// for demo RECORDING: "There is no cl_demo.c file in the v3.19 tree...
// CL_WriteDemoMessage/CL_Stop_f/CL_Record_f are defined in cl_main.c").
// Demo PLAYBACK specifically never existed as a CLIENT feature in the
// original engine at all -- verified directly against
// ~/Projects/quake-2-c (the unforked, GPL-released v3.19 source): there is
// no CL_PlayDemo_f, no `demoplayback` flag, no "demo"/"playdemo" console
// command anywhere in client/cl_main.c or client.h. Original Quake II demo
// playback was a SERVER-side feature instead -- `demomap <name>` (server/
// sv_ccmds.c:465 SV_DemoMap_f) spins up a fake local server in the
// `ss_demo` state (server/sv_init.c:447), which server/sv_send.c:501-527
// then feeds by re-reading the SAME length-prefixed `.dm2` blocks straight
// off disk and re-transmitting them byte-for-byte down the (loopback)
// netchan to an ordinary connected client, which is never aware it isn't
// watching a live game.
//
// This file instead follows q2repro's OWN client-side redesign
// (~/Projects/qsrc/q2repro/src/client/demo.c), the more directly reusable
// reference given this port already has a real CL_ParseServerMessage:
// q2repro moved playback entirely into the client (`cls.demo.playback`,
// `CL_ParseServerMessage()` invoked directly on file data, no fake local
// server subsystem at all) -- see this unit's own task report for the
// full comparison. Ported here: the `.dm2` container format (read_next_message,
// demo.c:767-796) and CL_PlayDemo_f's message-pump shape (demo.c:868-953).
// NOT ported: demo.c's real-time-paced CL_DemoFrame per-frame throttling
// (demo.c:1524-1557, `com_timedemo`/`cl_demowait` interactive pacing) or its
// seek-forward/MVD-redirect machinery -- this unit's own scope is the demo
// LOADER (open a file/buffer, detect its protocol, parse every message
// without error), not full interactive playback UI; a dedicated follow-up
// unit can wire a "demo"/"playdemo" console command and per-frame pacing
// on top of the real, tested primitives here.
//
// ---------------------------------------------------------------------------
// CONTAINER FORMAT (demo.c:767-796, CL_WriteDemoMessage/CL_Stop_f's own
// write side in cl_main.ts -- this is the read-side mirror of that exact
// format, confirmed identical to the classic `.dm2` layout used since
// v3.19): a repeating sequence of `u32 length (little-endian) + that many
// raw bytes of one complete server-to-client message`, terminated by a
// length value of 0xFFFFFFFF (uint32 -1).
// ---------------------------------------------------------------------------

import { SZ_Init, MSG_BeginReading } from "../qcommon/sizebuf";
import { net_message } from "../qcommon/net_chan";
import { ComError, ERR_DROP } from "../qcommon/qcommon";
import { FS_LoadFile } from "../qcommon/files";
import { cls, ConnstateT } from "./client";
import { CL_ParseServerMessage } from "./cl_parse";

const DEMO_EOF_SENTINEL = 0xffffffff;

export interface DemoReaderT {
  readonly data: Uint8Array;
  offset: number; // byte offset of the NEXT length-prefixed block
}

/** Wraps an in-memory demo byte buffer (an already-loaded `.dm2` file, or a
 *  synthesized test fixture) for block-by-block reading. */
export function CL_OpenDemoBuffer(data: Uint8Array): DemoReaderT {
  return { data, offset: 0 };
}

/**
 * read_next_message, demo.c:767-796. Reads exactly one length-prefixed
 * block and repoints the shared `net_message` singleton at it (the same
 * "swap the global singleton's backing array" idiom
 * src/server/mvd/parse.ts's MVD_ParseMessage already uses for its own
 * externally-supplied byte buffers), ready for CL_ParseServerMessage.
 * Returns false at EOF (either the 0xFFFFFFFF sentinel or a clean end of
 * the buffer with no trailing sentinel -- both are treated as "no more
 * messages", matching demo.c:779-781's own boolean shape).
 */
export function CL_ReadDemoMessage(reader: DemoReaderT): boolean {
  if (reader.offset + 4 > reader.data.length) return false;

  const view = new DataView(reader.data.buffer, reader.data.byteOffset + reader.offset, 4);
  const msglen = view.getUint32(0, true); // LittleLong
  reader.offset += 4;

  if (msglen === DEMO_EOF_SENTINEL) return false;

  if (reader.offset + msglen > reader.data.length) {
    throw new ComError(ERR_DROP, `CL_ReadDemoMessage: truncated demo (wanted ${msglen} bytes at offset ${reader.offset}, only ${reader.data.length - reader.offset} available)`);
  }

  const block = reader.data.subarray(reader.offset, reader.offset + msglen);
  reader.offset += msglen;

  SZ_Init(net_message, block, block.length);
  net_message.cursize = block.length;
  MSG_BeginReading(net_message);
  return true;
}

/**
 * CL_PlayDemo_f's message-pump shape (demo.c:868-953, 830-861's
 * parse_next_message), collapsed into one function: read and parse every
 * block in the buffer in sequence via the real CL_ParseServerMessage (the
 * SAME dispatcher live network traffic uses -- q2repro's own design,
 * chosen over inventing a parallel demo-specific dispatcher, see file
 * header). Protocol detection (vanilla/34, q2repro/1038, KEX/2022-2023)
 * happens exactly the way it does for any live connect: the first block's
 * svc_serverdata message contains the protocol number, and
 * CL_ParseServerData -> selectServerCodec (cl_parse.ts) picks the codec
 * off it -- no separate demo-format sniffing step exists or is needed.
 *
 * Sets `cls.demoplayback` for the duration; restores it to `false`
 * afterward (whether the pump finished cleanly or threw) so a caller
 * re-using the same process for another demo, or for live play, starts
 * from a clean flag.
 */
export function CL_PlayDemoFromBuffer(data: Uint8Array): void {
  const reader = CL_OpenDemoBuffer(data);

  cls.demoplayback = true;
  cls.state = ConnstateT.ca_connected;
  try {
    while (CL_ReadDemoMessage(reader)) {
      CL_ParseServerMessage();
    }
  } finally {
    cls.demoplayback = false;
  }
}

/**
 * CL_PlayDemo_f, demo.c:868-953 -- the real file-opening entry point
 * (`FS_EasyOpenFile(..., "demos/", arg, ".dm2")`, demo.c:879-880). This
 * port's FS_LoadFile already searches the configured game directories the
 * same way FS_FOpenFile does (files.ts), so the "demos/" prefix is applied
 * here rather than duplicating FS_EasyOpenFile's own extension-guessing
 * logic (that helper is not ported; a bare filename with a literal
 * "demos/" + ".dm2" fallback covers the actual retail/attract-loop naming
 * convention -- see this unit's own task report on the exact filenames
 * found in baseq2/pak0.pak).
 */
export function CL_PlayDemo_f(demoName: string): void {
  const withExt = demoName.includes(".") ? demoName : `${demoName}.dm2`;
  const path = withExt.startsWith("demos/") ? withExt : `demos/${withExt}`;

  const data = FS_LoadFile(path);
  if (data === null) {
    throw new ComError(ERR_DROP, `CL_PlayDemo_f: couldn't open ${path}`);
  }

  CL_PlayDemoFromBuffer(data);
}
