// cl_cin.c -- .cin cinematic playback (order-1 Huffman-coded frame
// decoding, PCX palette loading for static images).
//
// screen.h's "scr_cin.c" comment section is stale: there is no separate
// scr_cin.c file in the v3.19 tree. All five functions it lists
// (SCR_PlayCinematic/SCR_DrawCinematic/SCR_RunCinematic/SCR_StopCinematic/
// SCR_FinishCinematic) are defined in cl_cin.c (confirmed by grep) and are
// ported here.

import { ClcOpsT } from "../qcommon/qcommon";
import { Com_Error, Com_Printf } from "../qcommon/common";
import { ERR_DROP } from "../qcommon/qcommon";
import { FS_FOpenFile, FS_FreeFile, FS_LoadFile, FS_Read, FS_FCloseFile } from "../qcommon/files";
import { MSG_WriteByte, SZ_Print } from "../qcommon/sizebuf";
import { va } from "../shared/q_shared";
import { cl, cls, ConnstateT, KeydestT, re } from "./client";
import { SCR_BeginLoadingPlaque, SCR_EndLoadingPlaque } from "./cl_scrn";
import { viddef } from "./vid";
import { S_RawSamples } from "./snd_dma";
import { CL_Snd_Restart_f } from "./cl_main";
import { Cvar_SetValue, Cvar_VariableValue } from "../qcommon/cvar";
import { Sys_Milliseconds } from "../platform/sys";

// CDAudio_Play/CDAudio_Stop -- dropped throughout this file: no CD audio
// backend is ported. cdaudio.ts documents this as a future
// src/platform/cdaudio.ts unit (none of CDAudio_Init/Play/Stop/Update/
// Activate/Shutdown are defined anywhere in the C tree either -- they're
// per-platform: linux/cd_linux.c, win32/cd_win.c, null/cd_null.c).

export interface CblockT {
  data: Uint8Array;
  count: number;
}

class CinematicsT {
  restart_sound = false;
  s_rate = 0;
  s_width = 0;
  s_channels = 0;

  width = 0;
  height = 0;
  pic: Uint8Array | null = null;
  pic_pending: Uint8Array | null = null;

  // order 1 huffman stuff
  hnodes1: Int32Array | null = null; // flattened [256][256][2]
  numhnodes1: Int32Array = new Int32Array(256);

  h_used: Int32Array = new Int32Array(512);
  h_count: Int32Array = new Int32Array(512);
}

export const cin = new CinematicsT();

/*
=================================================================

PCX LOADING

=================================================================
*/

export interface PcxLoadResult {
  pic: Uint8Array | null;
  palette: Uint8Array | null;
  width: number;
  height: number;
}

// pcx_t's header is 128 bytes before the (unbounded) `data` run-length
// stream; qfiles.ts does not carry a pcx_t layout (PORTING.md notes PCX is
// "not trivial" to share -- see that file's header comment), so the struct
// offsets are read directly from the DataView here, matching the C layout
// byte-for-byte.
const PCX_HEADER_SIZE = 128;
const PCX_PALETTE_SIZE = 768;

/*
==============
SCR_LoadPCX

C signature returns through `byte **pic, byte **palette, int *width,
int *height` out-parameters; ported here as a single result object per
PORTING.md's "mutate a char* in place" idiom generalized to multiple
binary out-params (no `char*`-mutation idiom in PORTING.md covers this
multi-out-param binary case directly -- reported deviation, closest
faithful thing per rule 3).
==============
*/
export function SCR_LoadPCX(filename: string): PcxLoadResult {
  const result: PcxLoadResult = { pic: null, palette: null, width: 0, height: 0 };

  const raw = FS_LoadFile(filename);
  if (!raw) return result; // Com_Printf ("Bad pcx file %s\n", filename) -- commented out in the C

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const manufacturer = view.getUint8(0);
  const version = view.getUint8(1);
  const encoding = view.getUint8(2);
  const bits_per_pixel = view.getUint8(3);
  const xmax = view.getUint16(8, true);
  const ymax = view.getUint16(10, true);

  if (manufacturer !== 0x0a || version !== 5 || encoding !== 1 || bits_per_pixel !== 8 || xmax >= 640 || ymax >= 480) {
    Com_Printf(`Bad pcx file ${filename}\n`);
    FS_FreeFile(raw);
    return result;
  }

  const width = xmax + 1;
  const height = ymax + 1;
  const out = new Uint8Array(width * height);

  result.pic = out;
  result.width = width;
  result.height = height;

  const palette = new Uint8Array(PCX_PALETTE_SIZE);
  palette.set(raw.subarray(raw.length - PCX_PALETTE_SIZE, raw.length));
  result.palette = palette;

  let srcPos = PCX_HEADER_SIZE;
  let pix = 0;
  for (let y = 0; y <= ymax; y++, pix += width) {
    for (let x = 0; x <= xmax; ) {
      let dataByte = raw[srcPos++];
      let runLength: number;

      if ((dataByte & 0xc0) === 0xc0) {
        runLength = dataByte & 0x3f;
        dataByte = raw[srcPos++];
      } else {
        runLength = 1;
      }

      while (runLength-- > 0) out[pix + x++] = dataByte;
    }
  }

  if (srcPos > raw.length) {
    Com_Printf(`PCX file ${filename} was malformed`);
    result.pic = null;
  }

  FS_FreeFile(raw);
  return result;
}

//=============================================================

/*
==================
SCR_StopCinematic
==================
*/
export function SCR_StopCinematic(): void {
  cl.cinematictime = 0; // done
  if (cin.pic) {
    cin.pic = null;
  }
  if (cin.pic_pending) {
    cin.pic_pending = null;
  }
  if (cl.cinematicpalette_active) {
    re?.CinematicSetPalette(null);
    cl.cinematicpalette_active = false;
  }
  if (cl.cinematic_file !== null) {
    FS_FCloseFile(cl.cinematic_file);
    cl.cinematic_file = null;
  }
  if (cin.hnodes1) {
    cin.hnodes1 = null;
  }

  // switch back down to 11 khz sound if necessary
  if (cin.restart_sound) {
    cin.restart_sound = false;
    CL_Snd_Restart_f();
  }
}

/*
====================
SCR_FinishCinematic

Called when either the cinematic completes, or it is aborted
====================
*/
export function SCR_FinishCinematic(): void {
  // tell the server to advance to the next map / cinematic
  MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
  SZ_Print(cls.netchan.message, va("nextserver %i\n", cl.servercount));
}

//==========================================================================

/*
==================
SmallestNode1
==================
*/
export function SmallestNode1(numhnodes: number): number {
  let best = 99999999;
  let bestnode = -1;

  for (let i = 0; i < numhnodes; i++) {
    if (cin.h_used[i]) continue;
    if (!cin.h_count[i]) continue;
    if (cin.h_count[i] < best) {
      best = cin.h_count[i];
      bestnode = i;
    }
  }

  if (bestnode === -1) return -1;

  cin.h_used[bestnode] = 1;
  return bestnode;
}

/*
==================
Huff1TableInit

Reads the 64k counts table and initializes the node trees
==================
*/
export function Huff1TableInit(): void {
  const handle = cl.cinematic_file;
  if (handle === null) return; // caller always opens cl.cinematic_file first; guard is for type safety only

  cin.hnodes1 = new Int32Array(256 * 256 * 2);

  const counts = new Uint8Array(256);
  for (let prev = 0; prev < 256; prev++) {
    cin.h_count.fill(0);
    cin.h_used.fill(0);

    // read a row of counts
    FS_Read(counts, counts.length, handle);
    for (let j = 0; j < 256; j++) cin.h_count[j] = counts[j];

    // build the nodes
    let numhnodes = 256;
    const nodebase = prev * 256 * 2;

    while (numhnodes !== 511) {
      const node = nodebase + (numhnodes - 256) * 2;

      // pick two lowest counts
      const n0 = SmallestNode1(numhnodes);
      if (n0 === -1) break; // no more

      const n1 = SmallestNode1(numhnodes);
      if (n1 === -1) break;

      cin.hnodes1[node] = n0;
      cin.hnodes1[node + 1] = n1;

      cin.h_count[numhnodes] = cin.h_count[n0] + cin.h_count[n1];
      numhnodes++;
    }

    cin.numhnodes1[prev] = numhnodes - 1;
  }
}

/*
==================
Huff1Decompress
==================
*/
export function Huff1Decompress(input: CblockT): CblockT {
  const hnodes1 = cin.hnodes1;
  if (!hnodes1) Com_Error(ERR_DROP, "Huff1Decompress: no huffman table");

  const data = input.data;

  // get decompressed count
  let count = data[0] + (data[1] << 8) + (data[2] << 16) + (data[3] << 24);
  let inPos = 4;
  const out = new Uint8Array(count > 0 ? count : 0);
  let outPos = 0;

  // read bits
  const hnodesbase = -256 * 2; // nodes 0-255 aren't stored
  let hnodes = hnodesbase;
  let nodenum = cin.numhnodes1[0];

  outer: while (count > 0) {
    let inbyte = data[inPos++];

    for (let bit = 0; bit < 8; bit++) {
      if (nodenum < 256) {
        hnodes = hnodesbase + (nodenum << 9);
        out[outPos++] = nodenum;
        if (!--count) break outer;
        nodenum = cin.numhnodes1[nodenum];
      }
      nodenum = hnodes1[hnodes + nodenum * 2 + (inbyte & 1)];
      inbyte >>= 1;
    }
  }

  if (inPos !== input.count && inPos !== input.count + 1) {
    Com_Printf(`Decompression overread by ${inPos - input.count}`);
  }

  return { data: out, count: outPos };
}

/*
==================
SCR_ReadNextFrame
==================
*/
export function SCR_ReadNextFrame(): Uint8Array | null {
  const handle = cl.cinematic_file;
  if (handle === null) return null;

  // read the next frame
  const commandBuf = new Uint8Array(4);
  FS_Read(commandBuf, 4, handle);
  const command = commandBuf[0] | (commandBuf[1] << 8) | (commandBuf[2] << 16) | (commandBuf[3] << 24);
  if (command === 2) return null; // last frame marker

  if (command === 1) {
    // read palette
    FS_Read(cl.cinematicpalette, cl.cinematicpalette.length, handle);
    cl.cinematicpalette_active = false; // dubious.... exposes an edge case
  }

  // decompress the next frame
  const sizeBuf = new Uint8Array(4);
  FS_Read(sizeBuf, 4, handle);
  const size = sizeBuf[0] | (sizeBuf[1] << 8) | (sizeBuf[2] << 16) | (sizeBuf[3] << 24);
  if (size > 0x20000 || size < 1) Com_Error(ERR_DROP, "Bad compressed frame size");

  const compressed = new Uint8Array(size);
  FS_Read(compressed, size, handle);

  // read sound
  const start = (cl.cinematicframe * cin.s_rate) / 14;
  const end = ((cl.cinematicframe + 1) * cin.s_rate) / 14;
  const count = end - start;

  const samples = new Uint8Array(count * cin.s_width * cin.s_channels);
  FS_Read(samples, samples.length, handle);

  S_RawSamples(count, cin.s_rate, cin.s_width, cin.s_channels, samples);

  const huf1 = Huff1Decompress({ data: compressed, count: size });

  cl.cinematicframe++;

  return huf1.data;
}

/*
==================
SCR_RunCinematic

==================
*/
export function SCR_RunCinematic(): void {
  if (cl.cinematictime <= 0) {
    SCR_StopCinematic();
    return;
  }

  if (cl.cinematicframe === -1) return; // static image

  if (cls.key_dest !== KeydestT.key_game) {
    // pause if menu or console is up
    cl.cinematictime = cls.realtime - (cl.cinematicframe * 1000) / 14;
    return;
  }

  const frame = ((cls.realtime - cl.cinematictime) * 14.0) / 1000;
  if (frame <= cl.cinematicframe) return;
  if (frame > cl.cinematicframe + 1) {
    Com_Printf(`Dropped frame: ${frame} > ${cl.cinematicframe + 1}\n`);
    cl.cinematictime = cls.realtime - (cl.cinematicframe * 1000) / 14;
  }
  cin.pic = cin.pic_pending;
  cin.pic_pending = null;
  cin.pic_pending = SCR_ReadNextFrame();
  if (!cin.pic_pending) {
    SCR_StopCinematic();
    SCR_FinishCinematic();
    cl.cinematictime = 1; // hack to get the black screen behind loading
    SCR_BeginLoadingPlaque();
    cl.cinematictime = 0;
    return;
  }
}

/*
==================
SCR_DrawCinematic

Returns true if a cinematic is active, meaning the view rendering
should be skipped
==================
*/
export function SCR_DrawCinematic(): boolean {
  if (cl.cinematictime <= 0) {
    return false;
  }

  if (cls.key_dest === KeydestT.key_menu) {
    // blank screen and pause if menu is up
    re?.CinematicSetPalette(null);
    cl.cinematicpalette_active = false;
    return true;
  }

  if (!cl.cinematicpalette_active) {
    re?.CinematicSetPalette(cl.cinematicpalette);
    cl.cinematicpalette_active = true;
  }

  if (!cin.pic) return true;

  re?.DrawStretchRaw(0, 0, viddef.width, viddef.height, cin.width, cin.height, cin.pic);

  return true;
}

/*
==================
SCR_PlayCinematic

==================
*/
export function SCR_PlayCinematic(arg: string): void {
  // make sure CD isn't playing music -- CDAudio_Stop() dropped, see file header

  cl.cinematicframe = 0;
  const dot = arg.indexOf("."); // matches C's strstr (first occurrence), not the last
  if (dot !== -1 && arg.slice(dot) === ".pcx") {
    // static pcx image
    const name = `pics/${arg}`;
    const { pic, palette, width, height } = SCR_LoadPCX(name);
    cin.pic = pic;
    cin.width = width;
    cin.height = height;
    cl.cinematicframe = -1;
    cl.cinematictime = 1;
    SCR_EndLoadingPlaque();
    cls.state = ConnstateT.ca_active;
    if (!cin.pic) {
      Com_Printf(`${name} not found.\n`);
      cl.cinematictime = 0;
    } else if (palette) {
      cl.cinematicpalette.set(palette);
    }
    return;
  }

  const name = `video/${arg}`;
  const open = FS_FOpenFile(name);
  if (!open) {
    // Com_Error (ERR_DROP, "Cinematic %s not found.\n", name); -- commented out in the C
    SCR_FinishCinematic();
    cl.cinematictime = 0; // done
    return;
  }
  cl.cinematic_file = open.handle;

  SCR_EndLoadingPlaque();

  cls.state = ConnstateT.ca_active;

  const dims = new Uint8Array(16);
  FS_Read(dims, 16, cl.cinematic_file);
  const dv = new DataView(dims.buffer);
  cin.width = dv.getInt32(0, true);
  cin.height = dv.getInt32(4, true);
  cin.s_rate = dv.getInt32(8, true);
  cin.s_width = dv.getInt32(12, true);
  // s_channels is a 5th leading int the C reads separately; matched below
  const chanBuf = new Uint8Array(4);
  FS_Read(chanBuf, 4, cl.cinematic_file);
  cin.s_channels = new DataView(chanBuf.buffer).getInt32(0, true);

  Huff1TableInit();

  // switch up to 22 khz sound if necessary
  const old_khz = Cvar_VariableValue("s_khz");
  if (old_khz !== cin.s_rate / 1000) {
    cin.restart_sound = true;
    Cvar_SetValue("s_khz", cin.s_rate / 1000);
    CL_Snd_Restart_f();
    Cvar_SetValue("s_khz", old_khz);
  }

  cl.cinematicframe = 0;
  cin.pic = SCR_ReadNextFrame();
  cl.cinematictime = Sys_Milliseconds();
}
