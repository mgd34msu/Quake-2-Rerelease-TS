// sv_ccmds.c -- operator console commands
//
// These commands can only be entered from stdin or by a remote operator
// datagram (OPERATOR CONSOLE ONLY COMMANDS, per the C header comment).
//
// File-I/O: files.ts now exports write primitives (FS_WriteFile,
// FS_RemoveFile, FS_ReadRawFile, FS_FOpenFileWrite, FS_Write) alongside its
// original read primitives, so every C fwrite()/remove()/fopen(...,"wb")
// call below (SV_WipeSavegame's remove(), CopyFile's fwrite loop,
// SV_WriteLevelFile's and SV_WriteServerFile's fopen(...,"wb"),
// SV_ServerRecord_f's demo file) now does the real thing instead of a
// logged no-op. SV_WriteLevelFile/SV_WriteServerFile/SV_ServerRecord_f still
// call through to `ge.WriteLevel`/`WriteGame`/(SV_ReadServerFile's
// `ge.ReadGame`), implemented by g_save.ts (a sibling
// unit's concurrent work, not touched here) -- that remains the actually-
// blocking reason `save`/`load` cannot complete end-to-end yet, not a
// file-I/O gap.

import { Com_sprintf, MAX_OSPATH, MAX_TOKEN_CHARS, MAX_QPATH, CS_NAME, STAT_HEALTH, STAT_FRAGS, PRINT_HIGH, PRINT_CHAT, CVAR_LATCH, CVAR_SERVERINFO, PlayerStateT, BigShort, MAX_CONFIGSTRINGS } from "../shared/q_shared";
import { SysError, NetadrT, NetsrcT, PORT_MASTER, SvcOpsT, PROTOCOL_VERSION, ERR_DROP } from "../qcommon/qcommon";
import { Com_Printf, Com_DPrintf, Com_Error, Info_Print, dedicated } from "../qcommon/common";
import { Cvar_Set, Cvar_VariableValue, Cvar_VariableString, Cvar_ForceSet, Cvar_Serverinfo, cvar_vars } from "../qcommon/cvar";
import { Cmd_Argc, Cmd_Argv, Cmd_Args, Cmd_AddCommand } from "../qcommon/cmd";
import { FS_Gamedir, FS_CreatePath, FS_FOpenFile, FS_FCloseFile, FS_Read, FS_ReadRaw, FS_ListFiles, FS_LoadFile, FS_WriteFile, FS_RemoveFile, FS_ReadRawFile, FS_FOpenFileWrite, FS_Write } from "../qcommon/files";
import {
  SizeBuf,
  SZ_Init,
  SZ_Write,
  MSG_WriteByte,
  MSG_WriteShort,
  MSG_WriteLong,
  MSG_WriteLong64,
  MSG_WriteString,
  MSG_BeginReading,
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadLong64,
  MSG_ReadString,
  MSG_ReadData,
} from "../qcommon/sizebuf";
import { CM_WritePortalState, CM_ReadPortalState, CM_WritePortalBits, CM_SetPortalStates } from "../qcommon/cmodel";
import { MAX_MAP_AREAPORTALS } from "../qcommon/qfiles";
import { Com_ConfigstringSize } from "../shared/cs_remap";
import { Netchan_OutOfBandPrint } from "../qcommon/net_chan";
import { NET_StringToAdr, NET_AdrToString, NET_Config } from "../platform/net_udp";
import type { GameExports } from "../game/game";
import { sv, svs, master_adr, MAX_MASTERS, ServerStateT, ClientStateT, ClientT, maxclients, svClientHolder, svPlayerHolder } from "./server";
import { geHolder, currentGameFamily } from "./sv_game";
import { SV_DropClient, SV_Shutdown } from "./sv_main";
import { SV_BroadcastPrintf, SV_ClientPrintf } from "./sv_send";
import { SV_Map, SV_InitGame } from "./sv_init";

function atoi(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function requireGe(): GameExports {
  const ge = geHolder.ge;
  if (!ge) throw new SysError("sv_ccmds: ge used before SV_InitGameProgs");
  return ge;
}

function requireSvClient(): ClientT {
  const cl = svClientHolder.sv_client;
  if (!cl) throw new SysError("sv_ccmds: sv_client used before being set");
  return cl;
}

// game.h's gclient_s server-visible prefix (`{ player_state_t ps; int
// ping; }`); duplicated from sv_main.ts's identical module-private helper
// (not exported there) -- see that file's report for the suggested real fix
// (a `GClientPublic` interface alongside `Edict` in game.ts).
interface GClientPublic {
  ps: PlayerStateT;
  ping: number;
}
function isGClientPublic(client: unknown): client is GClientPublic {
  if (typeof client !== "object" || client === null) return false;
  if (!("ps" in client) || !("ping" in client)) return false;
  return client.ps instanceof PlayerStateT && typeof client.ping === "number";
}

// Wraps an async command handler for Cmd_AddCommand, whose handler type is
// synchronous (`(() => void) | null`); rejections are reported via
// Com_Printf instead of becoming an unhandled promise rejection.
function fireAndForget(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      Com_Printf("%s: %s\n", name, msg);
    });
  };
}

/*
===============================================================================

OPERATOR CONSOLE ONLY COMMANDS

These commands can only be entered from stdin or by a remote operator datagram
===============================================================================
*/

/*
====================
SV_SetMaster_f

Specify a list of master servers
====================
*/
function SV_SetMaster_f(): void {
  // only dedicated servers send heartbeats
  if (!dedicated || !dedicated.value) {
    Com_Printf("Only dedicated servers use masters.\n");
    return;
  }

  // make sure the server is listed public
  Cvar_Set("public", "1");

  for (let i = 1; i < MAX_MASTERS; i++) master_adr[i] = new NetadrT();

  let slot = 1; // slot 0 will always contain the id master
  const argc = Cmd_Argc();
  for (let i = 1; i < argc; i++) {
    if (slot === MAX_MASTERS) break;

    // C writes into master_adr[i] but reads back master_adr[slot] below --
    // preserved bug-for-bug (see PORTING.md's faithful-port rule).
    if (!NET_StringToAdr(Cmd_Argv(i), master_adr[i])) {
      Com_Printf("Bad address: %s\n", Cmd_Argv(i));
      continue;
    }
    if (master_adr[slot].port === 0) master_adr[slot].port = BigShort(PORT_MASTER);

    Com_Printf("Master server at %s\n", NET_AdrToString(master_adr[slot]));
    Com_Printf("Sending a ping.\n");

    Netchan_OutOfBandPrint(NetsrcT.NS_SERVER, master_adr[slot], "ping");

    slot++;
  }

  svs.last_heartbeat = -9999999;
}

/*
==================
SV_SetPlayer

Sets sv_client and sv_player to the player with idnum Cmd_Argv(1)
==================
*/
function SV_SetPlayer(): boolean {
  if (Cmd_Argc() < 2) return false;

  const s = Cmd_Argv(1);

  // numeric values are just slot numbers
  const c0 = s.charCodeAt(0);
  if (c0 >= 48 /* '0' */ && c0 <= 57 /* '9' */) {
    const idnum = atoi(s);
    const maxc = maxclients ? maxclients.value : 0;
    if (idnum < 0 || idnum >= maxc) {
      Com_Printf("Bad client slot: %i\n", idnum);
      return false;
    }

    const cl = svs.clients[idnum];
    svClientHolder.sv_client = cl;
    svPlayerHolder.sv_player = cl.edict;
    if (!cl.state) {
      Com_Printf("Client %i is not active\n", idnum);
      return false;
    }
    return true;
  }

  // check for a name match
  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl.state) continue;
    if (cl.name === s) {
      svClientHolder.sv_client = cl;
      svPlayerHolder.sv_player = cl.edict;
      return true;
    }
  }

  Com_Printf("Userid %s is not on the server\n", s);
  return false;
}

/*
===============================================================================

SAVEGAME FILES

===============================================================================
*/

/*
=====================
SV_WipeSavegame

Delete save/<XXX>/
=====================
*/
function SV_WipeSavegame(savename: string): void {
  Com_DPrintf("SV_WipeSaveGame(%s)\n", savename);

  const dir = `${FS_Gamedir()}/save/${savename}`;
  FS_RemoveFile(`${dir}/server.ssv`);
  FS_RemoveFile(`${dir}/game.ssv`);

  // Sys_FindFirst/Sys_FindNext glob-delete loops become FS_ListFiles +
  // FS_RemoveFile per match.
  for (const path of FS_ListFiles(`${dir}/*.sav`) ?? []) FS_RemoveFile(path);
  for (const path of FS_ListFiles(`${dir}/*.sv2`) ?? []) FS_RemoveFile(path);
}

/*
================
CopyFile
================
*/
function CopyFile(src: string, dst: string): void {
  Com_DPrintf("CopyFile (%s, %s)\n", src, dst);

  // fopen(src,"rb") + fopen(dst,"wb") + fread/fwrite loop. src/dst are
  // already fully-qualified filesystem paths (built off FS_Gamedir()), not
  // filenames to resolve through the virtual quake search path, so the raw
  // (non-virtual) FS_ReadRawFile/FS_WriteFile pair is used rather than
  // FS_LoadFile/FS_FOpenFile.
  const data = FS_ReadRawFile(src);
  if (data === null) return; // f1 = fopen(src,"rb"); if (!f1) return;
  FS_WriteFile(dst, data);
}

/*
================
SV_CopySaveGame
================
*/
function SV_CopySaveGame(src: string, dst: string): void {
  Com_DPrintf("SV_CopySaveGame(%s, %s)\n", src, dst);

  SV_WipeSavegame(dst);

  // copy the savegame over
  const name = `${FS_Gamedir()}/save/${src}/server.ssv`;
  const name2 = `${FS_Gamedir()}/save/${dst}/server.ssv`;
  FS_CreatePath(name2);
  CopyFile(name, name2);

  CopyFile(`${FS_Gamedir()}/save/${src}/game.ssv`, `${FS_Gamedir()}/save/${dst}/game.ssv`);

  const srcDir = `${FS_Gamedir()}/save/${src}`;
  const found = FS_ListFiles(`${srcDir}/*.sav`) ?? [];
  for (const path of found) {
    const base = path.slice(srcDir.length + 1);

    CopyFile(path, `${FS_Gamedir()}/save/${dst}/${base}`);

    // change sav to sv2
    const sv2Base = `${base.slice(0, -3)}sv2`;
    CopyFile(`${srcDir}/${sv2Base}`, `${FS_Gamedir()}/save/${dst}/${sv2Base}`);
  }
}

// char configstrings[MAX_CONFIGSTRINGS][MAX_QPATH] -- the fixed-width C
// on-disk layout SV_WriteLevelFile/SV_ReadLevelFile fwrite/FS_Read as one
// giant blob. sv.configstrings here is a `string[]`, so round-tripping the
// same byte layout needs an explicit encode/decode pair.
function decodeConfigstringsBlock(buf: Uint8Array): void {
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    const base = i * MAX_QPATH;
    let s = "";
    for (let j = 0; j < MAX_QPATH; j++) {
      const b = buf[base + j];
      if (!b) break;
      s += String.fromCharCode(b);
    }
    sv.configstrings[i] = s;
  }
}

// Reverse of decodeConfigstringsBlock: packs sv.configstrings back into the
// same fixed-width (MAX_CONFIGSTRINGS * MAX_QPATH), null-padded byte layout
// fwrite(sv.configstrings, sizeof(sv.configstrings), 1, f) produces in C.
function encodeConfigstringsBlock(): Uint8Array {
  const buf = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH);
  for (let i = 0; i < MAX_CONFIGSTRINGS; i++) {
    const base = i * MAX_QPATH;
    const s = sv.configstrings[i];
    for (let j = 0; j < s.length && j < MAX_QPATH; j++) {
      buf[base + j] = s.charCodeAt(j) & 0xff;
    }
  }
  return buf;
}

// ============================================================================
// SSV2/SAV2 -- the kex-family savegame container (q2repro's save.c).
// ============================================================================
// The legacy family above (SV_WriteLevelFile/SV_ReadLevelFile/
// SV_WriteServerFile/SV_ReadServerFile) keeps vanilla q2's fixed-width
// server.ssv/.sv2 layout byte-for-byte -- untouched by this section, gated
// behind currentGameFamily() at each of those four functions' own top (see
// each one's family-check guard below). This section is the kex-family
// alternative: q2repro's own variable-length, MSG_Write*-framed container
// (src/server/save.c, read closely for this port -- write_server_file:47-105,
// write_level_file:107-171, read_server_file:400-482, read_level_file:
// 484-548), engine-owned metadata (comment/mapcmd/configstrings/portal
// state) wrapping the game module's WriteGameJson/WriteLevelJson string,
// matching q2repro's actual "engine owns the container, the game returns
// strings" split (as opposed to the legacy fixed-width format, where the
// game module also gets a raw filename via WriteGame/WriteLevel and does its
// own file I/O).
//
// Architectural difference from save.c preserved deliberately: q2repro's
// read_server_file itself builds a mapcmd_t, calls SV_ParseMapCmd +
// Com_AbortFunc + SV_Shutdown + SV_SpawnServer inline, i.e. the C engine's
// read_server_file IS the map-transition trigger. This port's load flow
// already factors that differently for the legacy family (SV_ReadServerFile
// only parses the header/cvars/mapcmd and calls SV_InitGame; SV_Loadgame_f
// is the one that follows up with SV_Map(false, svs.mapcmd, true), which
// internally reaches SV_SpawnServer -> SV_CheckForSavegame ->
// SV_ReadLevelFile) -- the kex read functions below reuse that exact same
// split rather than reimplementing save.c's inline SV_ParseMapCmd/
// SV_SpawnServer sequence a second time. Equally, save.c's
// have_enhanced_savegames() gate (aborts the load if the loaded game module
// can't do enhanced saves) has no work to do here: these functions only run
// when currentGameFamily() === "kex", and the kex game module
// unconditionally implements WriteGameJson/ReadGameJson/WriteLevelJson/
// ReadLevelJson (src/kexgame/g_save.ts) -- there is no "loaded a legacy game
// under the kex family" state this engine can reach.

// MakeLittleLong('S','S','V','2')/('S','A','V','2') (save.c:22-23) -- see
// qfiles.ts's IDBSPHEADER for the same little-endian four-char-code pattern.
const SAVE_MAGIC1 = ("2".charCodeAt(0) << 24) | ("V".charCodeAt(0) << 16) | ("S".charCodeAt(0) << 8) | "S".charCodeAt(0);
const SAVE_MAGIC2 = ("2".charCodeAt(0) << 24) | ("V".charCodeAt(0) << 16) | ("A".charCodeAt(0) << 8) | "S".charCodeAt(0);
const SAVE_VERSION = 1;

// save.c's savetype_t (save.c:33-37).
const SAVE_MANUAL = 0;
const SAVE_LEVEL_START = 1;
// SAVE_AUTOSAVE = 2 -- save.c's remaster "autosave" ccmd has no equivalent
// registered command in this port (SV_InitOperatorCommands only wires up
// "save"/"load", matching this file's pre-existing "gamemap"/"map"/
// "savegame"/"loadgame" vanilla ccmd set, not save.c's newer save/autosave/
// load trio) -- dead branch here, not reachable from any call site.

// Wraps a Uint8Array whole-file read in a SizeBuf positioned for MSG_Read*
// (mirrors save.c's read_binary_file: `SZ_InitRead(&msg_read,
// msg_read_buffer, len)`). This port has no separate "read-mode" SizeBuf
// constructor (SZ_Init always resets cursize to 0 for writing); setting
// `cursize` directly afterward is the same idiom test/protocol_frame_
// envelope.test.ts's loadIntoNetMessage helper uses for the net_message
// singleton, applied here to a fresh, per-call SizeBuf instead.
function loadForReading(raw: Uint8Array): SizeBuf {
  const buf = new SizeBuf();
  SZ_Init(buf, raw, raw.length);
  buf.cursize = raw.length;
  MSG_BeginReading(buf);
  return buf;
}

/*
==============
SV_WriteServerFileKex

save.c's write_server_file (save.c:47-105), minus the ge->WriteGameJson/
FS_WriteFile split already owned by SV_WriteServerFile's caller chain here
(see this section's header comment) -- the game.ssv write below still goes
through GameExports.WriteGame exactly like the legacy path, since kex.ts's
binding already shrinks that call to a pure "write this JSON string to this
filename" seam (see that file's own header comment).
==============
*/
function SV_WriteServerFileKex(autosave: boolean): void {
  Com_DPrintf("SV_WriteServerFileKex(%s)\n", autosave ? "true" : "false");

  const buf = new SizeBuf();
  const scratch = new Uint8Array(0x40000);
  SZ_Init(buf, scratch, scratch.length);
  buf.allowoverflow = true;

  MSG_WriteLong(buf, SAVE_MAGIC1);
  MSG_WriteLong(buf, SAVE_VERSION);

  // write the comment field
  MSG_WriteLong64(buf, BigInt(Math.floor(Date.now() / 1000)));
  MSG_WriteByte(buf, autosave ? SAVE_LEVEL_START : SAVE_MANUAL);
  MSG_WriteString(buf, sv.configstrings[CS_NAME]);

  // write the mapcmd
  MSG_WriteString(buf, svs.mapcmd);

  // write all CVAR_LATCH cvars -- these will be things like coop, skill,
  // deathmatch, etc -- also write all CVAR_SERVERINFO vars -- they mainly
  // serve to provide some troubleshooting info. save.c also excludes
  // CVAR_PRIVATE cvars here; this port's cvar flag set (q_shared.ts) has no
  // CVAR_PRIVATE bit at all (never ported -- see report), so no cvar stored
  // in cvar_vars can ever carry it and that exclusion would be unreachable
  // dead code if written out.
  let latchedCount = 0;
  for (const v of cvar_vars.values()) {
    if (!(v.flags & (CVAR_LATCH | CVAR_SERVERINFO))) continue;
    MSG_WriteString(buf, v.name);
    MSG_WriteString(buf, v.string);
    latchedCount++;
  }
  MSG_WriteString(buf, null);

  // check for overflow
  if (buf.overflowed) {
    Com_Printf("SV_WriteServerFileKex: overflow\n");
    return;
  }

  const name = `${FS_Gamedir()}/save/current/server.ssv`;
  FS_WriteFile(name, buf.data.subarray(0, buf.cursize));
  Com_DPrintf("SV_WriteServerFileKex: wrote mapcmd=\"%s\" %i cvar(s)\n", svs.mapcmd, latchedCount);

  // write game state -- engine owns the file (save.c:92-102's
  // `ge->WriteGameJson(...)` + `FS_WriteFile("save/.../game.ssv", ...)`
  // split), via GameExports's optional WriteGameJson (see that interface's
  // doc comment) rather than the filename-based WriteGame the legacy family
  // still uses below.
  const ge = requireGe();
  const json = ge.WriteGameJson ? ge.WriteGameJson(autosave) : null;
  if (json === null) {
    Com_Printf("Couldn't write game state.\n");
    return;
  }
  FS_WriteFile(`${FS_Gamedir()}/save/current/game.ssv`, json);
}

/*
==============
SV_ReadServerFileKex

save.c's read_server_file (save.c:400-482), scoped down to the
header/cvar/mapcmd parse + SV_InitGame() this port's load flow expects from
SV_ReadServerFile (see this section's header comment for why the
SV_ParseMapCmd/SV_SpawnServer half of the C function isn't reimplemented
here -- SV_Loadgame_f's existing `await SV_Map(false, svs.mapcmd, true)`
call already does that job for both families).
==============
*/
async function SV_ReadServerFileKex(): Promise<void> {
  Com_DPrintf("SV_ReadServerFileKex()\n");

  const name = "save/current/server.ssv";
  const raw = FS_LoadFile(name);
  if (raw === null) {
    Com_Printf("Couldn't read %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }

  const buf = loadForReading(raw);

  if (MSG_ReadLong(buf) !== SAVE_MAGIC1) {
    Com_Printf("SV_ReadServerFileKex: not a savegame\n");
    return;
  }
  if (MSG_ReadLong(buf) !== SAVE_VERSION) {
    Com_Printf("SV_ReadServerFileKex: bad save version\n");
    return;
  }

  // read the comment field
  MSG_ReadLong64(buf); // timestamp -- SV_GetSaveInfo's concern, not this path
  MSG_ReadByte(buf); // savetype -- LOAD_LEVEL_START vs LOAD_NORMAL frame-count
  // tuning (save.c's SV_CheckForSavegame); this port's SV_CheckForSavegame
  // (sv_init.ts) does not yet make that distinction for either family -- see
  // report.
  MSG_ReadString(buf); // comment field's CS_NAME string, discarded (matches
  // C's `MSG_ReadString(NULL, 0)`)

  // read the mapcmd
  const mapcmd = MSG_ReadString(buf);

  // read all CVAR_LATCH cvars -- only restore ones that either don't exist
  // yet or are themselves flagged CVAR_LATCH (save.c:455-459's comment: "we
  // store cvars with either CVAR_LATCH or CVAR_SERVERINFO, but only restore
  // those with CVAR_LATCH"). This port has no Cvar_UserSet; Cvar_ForceSet is
  // the same substitute the legacy SV_ReadServerFile above already uses.
  for (;;) {
    const cvarName = MSG_ReadString(buf);
    if (!cvarName.length) break;
    const cvarValue = MSG_ReadString(buf);

    const existing = cvar_vars.get(cvarName);
    if (!existing || existing.flags & CVAR_LATCH) {
      Com_DPrintf("Set %s = %s\n", cvarName, cvarValue);
      Cvar_ForceSet(cvarName, cvarValue);
    }
  }

  // start a new game fresh with new cvars
  await SV_InitGame();
  svs.mapcmd = mapcmd;

  // read game state -- engine owns the file (save.c:470-474's
  // `FS_LoadFile(...); ge->ReadGameJson(buf);` split), via GameExports's
  // optional ReadGameJson rather than the filename-based ReadGame the
  // legacy family still uses below.
  const gameName = `${FS_Gamedir()}/save/current/game.ssv`;
  const gameRaw = FS_LoadFile(`save/current/game.ssv`);
  if (gameRaw === null) {
    Com_Error(ERR_DROP, "Couldn't read %s", gameName);
  }
  const ge = requireGe();
  if (ge.ReadGameJson) ge.ReadGameJson(new TextDecoder().decode(gameRaw));
}

/*
==============
SV_WriteLevelFileKex

save.c's write_level_file (save.c:107-171), minus its `transition` parameter
(no caller on this dispatch path signals level-transition-vs-full-save any
more than the legacy WriteLevel/kex.ts binding already documents -- see
kex.ts's WriteLevel adapter comment) and minus its streamed-write buffering
(`if (msg_write.cursize > msg_write.maxsize / 2) { FS_Write(...); SZ_Clear
(...); }`, a memory-footprint optimization for very large configstring
dumps with no on-disk-byte-layout consequence -- this port builds the whole
message in one scratch buffer and writes it in a single FS_WriteFile call).
==============
*/
function SV_WriteLevelFileKex(): void {
  Com_DPrintf("SV_WriteLevelFileKex()\n");

  const buf = new SizeBuf();
  const scratch = new Uint8Array(0x100000);
  SZ_Init(buf, scratch, scratch.length);
  buf.allowoverflow = true;

  MSG_WriteLong(buf, SAVE_MAGIC2);
  MSG_WriteLong(buf, SAVE_VERSION);

  // write configstrings
  let i = 0;
  for (; i < svs.csr.end; i++) {
    const s = sv.configstrings[i];
    if (!s.length) continue;

    MSG_WriteShort(buf, i);
    MSG_WriteString(buf, s);
  }
  MSG_WriteShort(buf, i); // i === svs.csr.end here -- the loop's terminator

  const portalBits = CM_WritePortalBits();
  MSG_WriteByte(buf, portalBits.length);
  SZ_Write(buf, portalBits, portalBits.length);

  if (buf.overflowed) {
    Com_Printf("SV_WriteLevelFileKex: overflow\n");
    return;
  }

  const name = `${FS_Gamedir()}/save/current/${sv.name}.sv2`;
  FS_WriteFile(name, buf.data.subarray(0, buf.cursize));

  // write game level -- engine owns the file (save.c:156-166), via
  // GameExports's optional WriteLevelJson. No "transition" signal is
  // available at this shared call site (SV_WriteLevelFile has none either
  // -- matches kex.ts's own pre-existing WriteLevel adapter default); full
  // save (`transition: false`) is the safe default, same as that adapter.
  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  const ge = requireGe();
  const json = ge.WriteLevelJson ? ge.WriteLevelJson(false) : null;
  if (json === null) {
    Com_Printf("Couldn't write level file.\n");
    return;
  }
  FS_WriteFile(savename, json);
}

/*
==============
SV_ReadLevelFileKex

save.c's read_level_file (save.c:484-548). SV_ClearWorld() (save.c:530) is
not repeated here: sv_init.ts's SV_CheckForSavegame already calls it once,
immediately before invoking SV_ReadLevelFile, for both families alike.
==============
*/
function SV_ReadLevelFileKex(): void {
  Com_DPrintf("SV_ReadLevelFileKex()\n");

  const name = `save/current/${sv.name}.sv2`;
  const raw = FS_LoadFile(name);
  if (raw === null) {
    Com_Printf("Failed to open %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }

  const buf = loadForReading(raw);

  if (MSG_ReadLong(buf) !== SAVE_MAGIC2) {
    Com_Printf("SV_ReadLevelFileKex: not a savegame\n");
    return;
  }
  if (MSG_ReadLong(buf) !== SAVE_VERSION) {
    Com_Printf("SV_ReadLevelFileKex: bad save version\n");
    return;
  }

  // read all configstrings
  for (;;) {
    const index = MSG_ReadShort(buf);
    if (index === svs.csr.end) break;

    if (index < 0 || index >= svs.csr.end) Com_Error(ERR_DROP, "Bad savegame configstring index");

    const maxlen = Com_ConfigstringSize(svs.csr, index);
    const s = MSG_ReadString(buf);
    if (s.length >= maxlen) Com_Error(ERR_DROP, "Savegame configstring too long");
    sv.configstrings[index] = s;
  }

  const len = MSG_ReadByte(buf);
  const portalData = new Uint8Array(len);
  MSG_ReadData(buf, portalData, len);
  CM_SetPortalStates(portalData);

  // read game level -- engine owns the file (save.c:538-546), via
  // GameExports's optional ReadLevelJson.
  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  const levelRaw = FS_LoadFile(`save/current/${sv.name}.sav`);
  if (levelRaw === null) {
    Com_Error(ERR_DROP, "Couldn't read %s", savename);
  }
  const ge = requireGe();
  if (ge.ReadLevelJson) ge.ReadLevelJson(new TextDecoder().decode(levelRaw));
}

/*
==============
SV_WriteLevelFile

==============
*/
function SV_WriteLevelFile(): void {
  if (currentGameFamily() === "kex") {
    SV_WriteLevelFileKex();
    return;
  }

  Com_DPrintf("SV_WriteLevelFile()\n");

  const name = `${FS_Gamedir()}/save/current/${sv.name}.sv2`;
  // fopen(name,"wb") + fwrite(sv.configstrings) + CM_WritePortalState(f)
  const portalState = CM_WritePortalState();
  const combined = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH + portalState.length);
  combined.set(encodeConfigstringsBlock(), 0);
  combined.set(portalState, MAX_CONFIGSTRINGS * MAX_QPATH);
  FS_WriteFile(name, combined);

  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  requireGe().WriteLevel(savename);
}

/*
==============
SV_ReadLevelFile

==============
*/
function SV_ReadLevelFile(): void {
  if (currentGameFamily() === "kex") {
    SV_ReadLevelFileKex();
    return;
  }

  Com_DPrintf("SV_ReadLevelFile()\n");

  const name = `save/current/${sv.name}.sv2`;
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("Failed to open %s\n", `${FS_Gamedir()}/${name}`);
  } else {
    const buf = new Uint8Array(MAX_CONFIGSTRINGS * MAX_QPATH);
    FS_Read(buf, buf.length, open.handle);
    decodeConfigstringsBlock(buf);
    const portalBuf = new Uint8Array(MAX_MAP_AREAPORTALS);
    FS_Read(portalBuf, portalBuf.length, open.handle);
    CM_ReadPortalState(portalBuf);
    FS_FCloseFile(open.handle);
  }

  const savename = `${FS_Gamedir()}/save/current/${sv.name}.sav`;
  requireGe().ReadLevel(savename);
}

function bytesToNulString(buf: Uint8Array): string {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    if (!buf[i]) break;
    s += String.fromCharCode(buf[i]);
  }
  return s;
}

// Reverse of bytesToNulString: packs a string into a fixed-width,
// null-padded byte buffer, matching a C `memset(buf, 0, sizeof(buf));
// strcpy(buf, s);` pair ahead of an fwrite(buf, 1, sizeof(buf), f).
function stringToFixedBuf(s: string, len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < s.length && i < len; i++) buf[i] = s.charCodeAt(i) & 0xff;
  return buf;
}

/*
==============
SV_WriteServerFile

==============
*/
function SV_WriteServerFile(autosave: boolean): void {
  if (currentGameFamily() === "kex") {
    SV_WriteServerFileKex(autosave);
    return;
  }

  Com_DPrintf("SV_WriteServerFile(%s)\n", autosave ? "true" : "false");

  const name = `${FS_Gamedir()}/save/current/server.ssv`;

  // write the comment field
  let comment: string;
  if (!autosave) {
    const d = new Date();
    comment = Com_sprintf("%2i:%i%i %2i/%2i  ", d.getHours(), Math.floor(d.getMinutes() / 10), d.getMinutes() % 10, d.getMonth() + 1, d.getDate());
    comment += sv.configstrings[CS_NAME].slice(0, Math.max(0, 31 - comment.length));
  } else {
    // autosaved
    comment = Com_sprintf("ENTERING %s", sv.configstrings[CS_NAME]);
  }

  // fopen(name,"wb") + fwrite(comment)/fwrite(svs.mapcmd)/fwrite(each
  // CVAR_LATCH cvar's name+value)
  const parts: Uint8Array[] = [stringToFixedBuf(comment, 32), stringToFixedBuf(svs.mapcmd, MAX_TOKEN_CHARS)];

  let latchedCount = 0;
  for (const v of cvar_vars.values()) {
    if (!(v.flags & CVAR_LATCH)) continue;
    if (v.name.length >= MAX_OSPATH - 1 || v.string.length >= 128 - 1) {
      Com_Printf("Cvar too long: %s = %s\n", v.name, v.string);
      continue;
    }
    parts.push(stringToFixedBuf(v.name, MAX_OSPATH));
    parts.push(stringToFixedBuf(v.string, 128));
    latchedCount++;
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p, offset);
    offset += p.length;
  }
  FS_WriteFile(name, combined);
  Com_DPrintf("SV_WriteServerFile: wrote comment=\"%s\" mapcmd=\"%s\" %i latched cvar(s)\n", comment, svs.mapcmd, latchedCount);

  // write game state
  const gameName = `${FS_Gamedir()}/save/current/game.ssv`;
  requireGe().WriteGame(gameName, autosave);
}

/*
==============
SV_ReadServerFile

==============
*/
async function SV_ReadServerFile(): Promise<void> {
  if (currentGameFamily() === "kex") {
    await SV_ReadServerFileKex();
    return;
  }

  Com_DPrintf("SV_ReadServerFile()\n");

  const name = "save/current/server.ssv";
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("Couldn't read %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }

  // read the comment field
  const commentBuf = new Uint8Array(32);
  FS_Read(commentBuf, 32, open.handle);

  // read the mapcmd
  const mapcmdBuf = new Uint8Array(MAX_TOKEN_CHARS);
  FS_Read(mapcmdBuf, MAX_TOKEN_CHARS, open.handle);
  const mapcmd = bytesToNulString(mapcmdBuf);

  // read all CVAR_LATCH cvars -- these will be things like coop, skill,
  // deathmatch, etc. C: `if (!fread (name, 1, sizeof(name), f)) break;` --
  // a clean EOF is the loop's exit, via FS_ReadRaw's fread semantics.
  for (;;) {
    const nameBuf = new Uint8Array(MAX_OSPATH);
    if (FS_ReadRaw(nameBuf, MAX_OSPATH, open.handle) !== MAX_OSPATH) break;

    const stringBuf = new Uint8Array(128);
    FS_ReadRaw(stringBuf, 128, open.handle);

    const cvarName = bytesToNulString(nameBuf);
    const cvarValue = bytesToNulString(stringBuf);
    Com_DPrintf("Set %s = %s\n", cvarName, cvarValue);
    Cvar_ForceSet(cvarName, cvarValue);
  }

  FS_FCloseFile(open.handle);

  // start a new game fresh with new cvars
  await SV_InitGame();
  svs.mapcmd = mapcmd;

  svs.mapcmd = mapcmd;

  // read game state
  const gameName = `${FS_Gamedir()}/save/current/game.ssv`;
  requireGe().ReadGame(gameName);
}

//=========================================================

/*
==================
SV_DemoMap_f

Puts the server in demo mode on a specific map/cinematic
==================
*/
async function SV_DemoMap_f(): Promise<void> {
  const map = Cmd_Argv(1); // capture before await (global tokenizer)
  await SV_Map(true, map, false);
}

/*
==================
SV_GameMap_f

Saves the state of the map just being exited and goes to a new map.

If the initial character of the map string is '*', the next map is
in a new unit, so the current savegame directory is cleared of
map files.
==================
*/
async function SV_GameMap_f(): Promise<void> {
  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: gamemap <map>\n");
    return;
  }

  Com_DPrintf("SV_GameMap(%s)\n", Cmd_Argv(1));

  FS_CreatePath(`${FS_Gamedir()}/save/current/`);

  // check for clearing the current savegame
  const map = Cmd_Argv(1);
  if (map.charAt(0) === "*") {
    // wipe all the *.sav files
    SV_WipeSavegame("current");
  } else {
    // save the map just exited
    if (sv.state === ServerStateT.ss_game) {
      // clear all the client inuse flags before saving so that
      // when the level is re-entered, the clients will spawn
      // at spawn points instead of occupying body shells
      const maxc = maxclients ? maxclients.value : 0;
      const savedInuse: boolean[] = new Array(maxc).fill(false);
      for (let i = 0; i < maxc; i++) {
        const cl = svs.clients[i];
        if (!cl.edict) continue;
        savedInuse[i] = cl.edict.inuse;
        cl.edict.inuse = false;
      }

      SV_WriteLevelFile();

      // we must restore these for clients to transfer over correctly
      for (let i = 0; i < maxc; i++) {
        const cl = svs.clients[i];
        if (!cl.edict) continue;
        cl.edict.inuse = savedInuse[i];
      }
    }
  }

  // start up the next map -- `map` was captured before any await; the
  // command tokenizer is global and later commands retokenize it while an
  // async handler is suspended (the corrupted-mapcmd autosave bug)
  await SV_Map(false, map, false);

  // archive server state
  svs.mapcmd = map;

  // copy off the level to the autosave slot
  if (!dedicated || !dedicated.value) {
    SV_WriteServerFile(true);
    SV_CopySaveGame("current", "save0");
  }
}

/*
==================
SV_Map_f

Goes directly to a given map without any savegame archiving.
For development work
==================
*/
async function SV_Map_f(): Promise<void> {
  // if not a pcx, demo, or cinematic, check to make sure the level exists
  const map = Cmd_Argv(1);
  if (!map.includes(".")) {
    const expanded = `maps/${map}.bsp`;
    if (FS_LoadFile(expanded) === null) {
      Com_Printf("Can't find %s\n", expanded);
      return;
    }
  }

  sv.state = ServerStateT.ss_dead; // don't save current level when changing
  SV_WipeSavegame("current");
  await SV_GameMap_f();
}

/*
=====================================================================

  SAVEGAMES

=====================================================================
*/

/*
==============
SV_Loadgame_f

==============
*/
async function SV_Loadgame_f(): Promise<void> {
  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: loadgame <directory>\n");
    return;
  }

  Com_Printf("Loading game...\n");

  const dir = Cmd_Argv(1);
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    Com_Printf("Bad savedir.\n");
  }

  // make sure the server.ssv file exists
  const name = `save/${dir}/server.ssv`;
  const open = FS_FOpenFile(name);
  if (!open) {
    Com_Printf("No such savegame: %s\n", `${FS_Gamedir()}/${name}`);
    return;
  }
  FS_FCloseFile(open.handle);

  SV_CopySaveGame(dir, "current");

  await SV_ReadServerFile();

  // go to the map
  sv.state = ServerStateT.ss_dead; // don't save current level when changing
  await SV_Map(false, svs.mapcmd, true);
}

/*
==============
SV_Savegame_f

==============
*/
function SV_Savegame_f(): void {
  if (sv.state !== ServerStateT.ss_game) {
    Com_Printf("You must be in a game to save.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Com_Printf("USAGE: savegame <directory>\n");
    return;
  }

  if (Cvar_VariableValue("deathmatch")) {
    Com_Printf("Can't savegame in a deathmatch\n");
    return;
  }

  if (Cmd_Argv(1) === "current") {
    Com_Printf("Can't save to 'current'\n");
    return;
  }

  if (maxclients && maxclients.value === 1) {
    const cl = svs.clients[0];
    const client = cl?.edict?.client;
    if (isGClientPublic(client) && client.ps.stats[STAT_HEALTH] <= 0) {
      Com_Printf("\nCan't savegame while dead!\n");
      return;
    }
  }

  const dir = Cmd_Argv(1);
  if (dir.includes("..") || dir.includes("/") || dir.includes("\\")) {
    Com_Printf("Bad savedir.\n");
  }

  Com_Printf("Saving game...\n");

  // archive current level, including all client edicts.
  // when the level is reloaded, they will be shells awaiting
  // a connecting client
  SV_WriteLevelFile();

  // save server state
  SV_WriteServerFile(false);

  // copy it off
  SV_CopySaveGame("current", dir);

  Com_Printf("Done.\n");
}

//===============================================================

/*
==================
SV_Kick_f

Kick a user off of the server
==================
*/
function SV_Kick_f(): void {
  if (!svs.initialized) {
    Com_Printf("No server running.\n");
    return;
  }

  if (Cmd_Argc() !== 2) {
    Com_Printf("Usage: kick <userid>\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  const cl = requireSvClient();
  SV_BroadcastPrintf(PRINT_HIGH, "%s was kicked\n", cl.name);
  // print directly, because the dropped client won't get the
  // SV_BroadcastPrintf message
  SV_ClientPrintf(cl, PRINT_HIGH, "You were kicked from the game\n");
  SV_DropClient(cl);
  cl.lastmessage = svs.realtime; // min case there is a funny zombie
}

/*
================
SV_Status_f
================
*/
function SV_Status_f(): void {
  // `!svs.clients` in C is a null-pointer ("never allocated") check;
  // svs.clients here always starts as `[]` (ServerStaticT's default), so
  // the length is the faithful equivalent of "no server running".
  if (!svs.clients.length) {
    Com_Printf("No server running.\n");
    return;
  }

  Com_Printf("map              : %s\n", sv.name);

  Com_Printf("num score ping name            lastmsg address               qport \n");
  Com_Printf("--- ----- ---- --------------- ------- --------------------- ------\n");

  const maxc = maxclients ? maxclients.value : 0;
  for (let i = 0; i < maxc; i++) {
    const cl = svs.clients[i];
    if (!cl || !cl.state) continue;

    Com_Printf("%3i ", i);

    let frags = 0;
    if (cl.edict) {
      const client = cl.edict.client;
      if (isGClientPublic(client)) frags = client.ps.stats[STAT_FRAGS];
    }
    Com_Printf("%5i ", frags);

    if (cl.state === ClientStateT.cs_connected) Com_Printf("CNCT ");
    else if (cl.state === ClientStateT.cs_zombie) Com_Printf("ZMBI ");
    else {
      const ping = cl.ping < 9999 ? cl.ping : 9999;
      Com_Printf("%4i ", ping);
    }

    Com_Printf("%s", cl.name);
    let l = 16 - cl.name.length;
    for (let j = 0; j < l; j++) Com_Printf(" ");

    Com_Printf("%7i ", svs.realtime - cl.lastmessage);

    const s = NET_AdrToString(cl.netchan.remote_address);
    Com_Printf("%s", s);
    l = 22 - s.length;
    for (let j = 0; j < l; j++) Com_Printf(" ");

    Com_Printf("%5i", cl.netchan.qport);

    Com_Printf("\n");
  }
  Com_Printf("\n");
}

/*
==================
SV_ConSay_f
==================
*/
function SV_ConSay_f(): void {
  if (Cmd_Argc() < 2) return;

  let p = Cmd_Args();
  if (p.charAt(0) === '"') {
    // C: `p++; p[strlen(p)-1] = 0;` -- always strips the last character once
    // an opening quote is stripped, even if that last character isn't
    // itself a closing quote. Preserved bug-for-bug.
    p = p.slice(1);
    p = p.slice(0, -1);
  }

  const text = `console: ${p}`;

  const maxc = maxclients ? maxclients.value : 0;
  for (let j = 0; j < maxc; j++) {
    const client = svs.clients[j];
    if (!client || client.state !== ClientStateT.cs_spawned) continue;
    SV_ClientPrintf(client, PRINT_CHAT, "%s\n", text);
  }
}

/*
==================
SV_Heartbeat_f
==================
*/
function SV_Heartbeat_f(): void {
  svs.last_heartbeat = -9999999;
}

/*
===========
SV_Serverinfo_f

  Examine or change the serverinfo string
===========
*/
function SV_Serverinfo_f(): void {
  Com_Printf("Server info settings:\n");
  Info_Print(Cvar_Serverinfo());
}

/*
===========
SV_DumpUser_f

Examine all a users info strings
===========
*/
function SV_DumpUser_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("Usage: info <userid>\n");
    return;
  }

  if (!SV_SetPlayer()) return;

  Com_Printf("userinfo\n");
  Com_Printf("--------\n");
  Info_Print(requireSvClient().userinfo);
}

/*
==============
SV_ServerRecord_f

Begins server demo recording.  Every entity and every message will be
recorded, but no playerinfo will be stored.  Primarily for demo merging.
==============
*/
function SV_ServerRecord_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("serverrecord <demoname>\n");
    return;
  }

  if (svs.demofile !== null) {
    Com_Printf("Already recording.\n");
    return;
  }

  if (sv.state !== ServerStateT.ss_game) {
    Com_Printf("You must be in a level to record.\n");
    return;
  }

  //
  // open the demo file
  //
  const name = `${FS_Gamedir()}/demos/${Cmd_Argv(1)}.dm2`;

  Com_Printf("recording to %s.\n", name);
  FS_CreatePath(name);
  const handle = FS_FOpenFileWrite(name);
  if (handle === null) {
    Com_Printf("ERROR: couldn't open.\n");
    return;
  }
  svs.demofile = handle;

  // setup a buffer to catch all multicasts
  SZ_Init(svs.demo_multicast, svs.demo_multicast_buf, svs.demo_multicast_buf.length);

  //
  // write a single giant fake message with all the startup info
  //
  const buf = new SizeBuf();
  const buf_data = new Uint8Array(32768);
  SZ_Init(buf, buf_data, buf_data.length);

  // serverdata needs to go over for all types of servers
  // to make sure the protocol is right, and to set the gamedir
  //
  // send the serverdata
  if (currentGameFamily() === "kex") {
    // Route through svs.codec so the demo's signon carries the SAME
    // protocol number (1038) and handshake shape as the per-frame
    // svc_packetentities fix below (SV_RecordDemoMessage) -- a demo signon
    // literally hardcoded to PROTOCOL_VERSION (34) followed by 1038-shaped
    // entity deltas would be unparseable by either codec. `attractloop:
    // true` writes byte `1` here instead of the legacy branch's literal
    // `2`; this port's own client-side read (vanilla.ts/q2repro.ts's
    // readServerData: `MSG_ReadByte(...) !== 0`) already collapses any
    // nonzero byte to `true`, so this is not an observable-behavior change
    // for anything that reads demos through this codebase's own codecs --
    // only a real byte-value difference from the original engine's literal
    // `2`, which is why it is gated to the kex family and not applied to
    // the legacy branch below.
    svs.codec.writeServerData(buf, {
      servercount: svs.spawncount,
      attractloop: true, // demos are always attract loops
      gamedir: Cvar_VariableString("gamedir"),
      clientnum: -1,
      levelname: sv.configstrings[CS_NAME],
      serverState: sv.state,
    });
  } else {
    // legacy family: byte-identical to the original vanilla dm2 signon,
    // including the literal `2` (not a boolean-derived 0/1) -- see the kex
    // branch's comment for why that literal can't be reproduced through
    // svs.codec.writeServerData's `attractloop: boolean` parameter.
    MSG_WriteByte(buf, SvcOpsT.svc_serverdata);
    MSG_WriteLong(buf, PROTOCOL_VERSION);
    MSG_WriteLong(buf, svs.spawncount);
    MSG_WriteByte(buf, 2); // demos are always attract loops
    MSG_WriteString(buf, Cvar_VariableString("gamedir"));
    MSG_WriteShort(buf, -1);
    // send full levelname
    MSG_WriteString(buf, sv.configstrings[CS_NAME]);
  }

  // Loop bound is "how many configstring slots the current game family has"
  // (svs.csr.end), not a protocol-34 wire-encoding limit -- MSG_WriteShort
  // can hold any family's index range. Distinct from decodeConfigstringsBlock/
  // encodeConfigstringsBlock below, which keep MAX_CONFIGSTRINGS because
  // those two encode the fixed-width on-disk savegame blob layout.
  for (let i = 0; i < svs.csr.end; i++) {
    if (sv.configstrings[i].length) {
      MSG_WriteByte(buf, SvcOpsT.svc_configstring);
      MSG_WriteShort(buf, i);
      MSG_WriteString(buf, sv.configstrings[i]);
    }
  }

  // write it to the demo file
  Com_DPrintf("signon message length: %i\n", buf.cursize);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setInt32(0, buf.cursize, true);
  FS_Write(lenBuf, 4, svs.demofile);
  FS_Write(buf.data.subarray(0, buf.cursize), buf.cursize, svs.demofile);

  // the rest of the demo file will be individual frames
}

/*
==============
SV_ServerStop_f

Ends server demo recording
==============
*/
function SV_ServerStop_f(): void {
  if (svs.demofile === null) {
    Com_Printf("Not doing a serverrecord.\n");
    return;
  }
  FS_FCloseFile(svs.demofile);
  svs.demofile = null;
  Com_Printf("Recording completed.\n");
}

/*
===============
SV_KillServer_f

Kick everyone off, possibly in preparation for a new game

===============
*/
async function SV_KillServer_f(): Promise<void> {
  if (!svs.initialized) return;
  SV_Shutdown("Server was killed.\n", false);
  await NET_Config(false); // close network sockets
}

/*
===============
SV_ServerCommand_f

Let the game dll handle a command
===============
*/
function SV_ServerCommand_f(): void {
  if (!geHolder.ge) {
    Com_Printf("No game loaded.\n");
    return;
  }
  geHolder.ge.ServerCommand();
}

//===========================================================

/*
==================
SV_InitOperatorCommands
==================
*/
export function SV_InitOperatorCommands(): void {
  Cmd_AddCommand("heartbeat", SV_Heartbeat_f);
  Cmd_AddCommand("kick", SV_Kick_f);
  Cmd_AddCommand("status", SV_Status_f);
  Cmd_AddCommand("serverinfo", SV_Serverinfo_f);
  Cmd_AddCommand("dumpuser", SV_DumpUser_f);

  Cmd_AddCommand("map", fireAndForget("map", SV_Map_f));
  Cmd_AddCommand("demomap", fireAndForget("demomap", SV_DemoMap_f));
  Cmd_AddCommand("gamemap", fireAndForget("gamemap", SV_GameMap_f));
  Cmd_AddCommand("setmaster", SV_SetMaster_f);

  if (dedicated && dedicated.value) Cmd_AddCommand("say", SV_ConSay_f);

  Cmd_AddCommand("serverrecord", SV_ServerRecord_f);
  Cmd_AddCommand("serverstop", SV_ServerStop_f);

  Cmd_AddCommand("save", SV_Savegame_f);
  Cmd_AddCommand("load", fireAndForget("load", SV_Loadgame_f));

  Cmd_AddCommand("killserver", fireAndForget("killserver", SV_KillServer_f));

  Cmd_AddCommand("sv", SV_ServerCommand_f);
}

// SV_ReadLevelFile is the one function server.h exposes outside sv_ccmds.c
// (sv_init.ts's SV_CheckForSavegame calls it).
export { SV_ReadLevelFile };

// SV_Status_f is likewise re-exported: server.h's own comment block
// (mirrored in this file's original pending-stub header) singles it out
// alongside SV_ReadLevelFile as the two symbols other modules reach for.
export { SV_Status_f };

// Test-only exports (no server.h equivalent -- these are engine-internal
// functions/constants server.h never declared for outside callers). Exposed
// purely so test/savegame_container.test.ts can exercise the SSV2/SAV2
// container's family dispatch (SV_WriteServerFile/SV_ReadServerFile/
// SV_WriteLevelFile) and hand-verify its on-disk header layout (SAVE_MAGIC1/
// SAVE_MAGIC2/SAVE_VERSION) without reaching through Cmd_AddCommand's
// registered "save"/"load" ccmd handlers.
export { SV_WriteServerFile, SV_ReadServerFile, SV_WriteLevelFile, SAVE_MAGIC1, SAVE_MAGIC2, SAVE_VERSION, SAVE_MANUAL, SAVE_LEVEL_START };
