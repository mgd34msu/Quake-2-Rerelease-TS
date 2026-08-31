// cl_parse.c -- parse a message received from the server

import { CDAudio_Play } from "../platform/cd_ogg";
import { Sys_SendKeyEvents } from "../platform/sys";
import { fixedLength } from "../shared/fixed";
import {
  MSG_ReadByte,
  MSG_ReadShort,
  MSG_ReadLong,
  MSG_ReadString,
  MSG_ReadPos,
  MSG_WriteByte,
  MSG_WriteString,
} from "../qcommon/sizebuf";
import { net_message } from "../qcommon/net_chan";
import {
  SvcOpsT,
  ClcOpsT,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_RERELEASE,
  PROTOCOL_VERSION_R1Q2,
  PROTOCOL_VERSION_R1Q2_CURRENT,
  PROTOCOL_VERSION_Q2PRO,
  PROTOCOL_VERSION_Q2PRO_CURRENT,
  SVC_ZPACKET,
  ERR_DROP,
  BASEDIRNAME,
} from "../qcommon/qcommon";
import { cl, cls, ConnstateT, svc_strings, clCvars, cl_entities, type ClientinfoT, num_cl_weaponmodels, cl_weaponmodels, re } from "./client";
import type { ProtocolCodec } from "../qcommon/protocol/codec";
import { VANILLA_CODEC } from "../qcommon/protocol/vanilla";
import { Q2REPRO_CODEC } from "../qcommon/protocol/q2repro";
import { createR1Q2Codec, setR1Q2FrameExtrabits } from "../qcommon/protocol/r1q2";
import { createQ2ProCodec, noteQ2ProFrameOpcodeExtrabits } from "../qcommon/protocol/q2pro";
import { readZPacketPayload } from "../qcommon/protocol/zpacket";
import {
  KEX_DEMO_CODEC,
  PROTOCOL_KEX_DEMOS,
  PROTOCOL_KEX,
  setKexProtocol,
  isKexDemoProtocol,
  readSoundKex,
  readSplitclientKex,
  readConfigblastKex,
  readSpawnbaselineblastKex,
  readDamageKex,
  readLocprintKex,
  readFog,
  readPoiKex,
  readHelpPathKex,
  readMuzzleflash3Kex,
  readAchievementKex,
} from "../qcommon/protocol/kexdemo";
import { ServerCommandT, PrintTypeT } from "../kexapi/game";
import { type CsRemapT, CS_REMAP_OLD, CS_REMAP_RERELEASE } from "../shared/cs_remap";
import {
  EntityStateT,
  type CmodelT,
  CS_CDTRACK,
  MAX_CLIENTS,
  MAX_LIGHTSTYLES,
  MAX_EDICTS,
  PRINT_CHAT,
  ERR_DISCONNECT,
  Com_sprintf,
} from "../shared/q_shared";
import { Com_Error, Com_Printf, Com_DPrintf, Com_ServerState } from "../qcommon/common";
import { Cvar_Set } from "../qcommon/cvar";
import { Cbuf_AddText, Cbuf_Execute, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { FS_LoadFile, FS_Gamedir, FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile, FS_ReadRawFile, FS_WriteFile, FS_RemoveFile, FS_AddPak, fs_gamedirvar } from "../qcommon/files";
import { COM_StripExtension } from "../shared/math";
import { CM_InlineModel } from "../qcommon/cmodel";
import { CL_ClearState, CL_RequestNextDownload, CL_WriteDemoMessage } from "./cl_main";
import { HTTP_QueueDownload, HTTP_RescanQueue, type HttpDlType } from "./cl_http";
import { CG_SetActiveCgameKind } from "./cgame/host";
import { SCR_PlayCinematic } from "./cl_cin";
import { SCR_CenterPrint } from "./cl_scrn";
import { con } from "./console";
import { S_StartSound, S_StartLocalSound, S_BeginRegistration, S_RegisterSound, S_EndRegistration } from "./snd_dma";
import { CL_RegisterTEntSounds, CL_ParseTEnt } from "./cl_tent";
import { CL_ParseMuzzleFlash, CL_ParseMuzzleFlash2, CL_SetLightstyle, CL_ParseShadowLightConfigstring } from "./cl_fx";
import { CL_ParseInventory } from "./cl_inv";
import { CL_ParseEntityBits, CL_ParseDelta, CL_ParseFrame } from "./cl_ents";

// qcommon.h's SND_*/DEFAULT_SOUND_PACKET_* constants -- not yet ported to
// src/qcommon/qcommon.ts (see sv_send.ts's identical note, which keeps its
// own private copy for the same reason).
const SND_VOLUME = 1 << 0; // a byte
const SND_ATTENUATION = 1 << 1; // a byte
const SND_POS = 1 << 2; // three coordinates
const SND_ENT = 1 << 3; // a short 0-2: channel, 3-12: entity
const SND_OFFSET = 1 << 4; // a byte, msec offset from frame start

const DEFAULT_SOUND_PACKET_VOLUME = 1.0;
const DEFAULT_SOUND_PACKET_ATTENUATION = 1.0;

// svc_strings[256] -- static array initializer (`char *svc_strings[256] = {...}`).
// Populated here (cl_parse.c's true owning file) into client.ts's holder
// array; entries past svc_frame stay "" (client.h's implicit NULL, which
// `if (!svc_strings[cmd])` treats identically to an empty string).
const SVC_STRING_NAMES: string[] = fixedLength("SVC_STRING_NAMES", 21, [
  "svc_bad",
  "svc_muzzleflash",
  "svc_muzzlflash2",
  "svc_temp_entity",
  "svc_layout",
  "svc_inventory",
  "svc_nop",
  "svc_disconnect",
  "svc_reconnect",
  "svc_sound",
  "svc_print",
  "svc_stufftext",
  "svc_serverdata",
  "svc_configstring",
  "svc_spawnbaseline",
  "svc_centerprint",
  "svc_download",
  "svc_playerinfo",
  "svc_packetentities",
  "svc_deltapacketentities",
  "svc_frame",
]);
for (let i = 0; i < SVC_STRING_NAMES.length; i++) svc_strings[i] = SVC_STRING_NAMES[i];

//=============================================================================

export function CL_DownloadFileName(fn: string): string {
  if (fn.slice(0, 7) === "players") return `${BASEDIRNAME}/${fn}`;
  return `${FS_Gamedir()}/${fn}`;
}

// clc_stringcmd write helper shared by CL_CheckOrDownloadFile/CL_Download_f/
// CL_ParseDownload -- all three do `MSG_WriteByte(clc_stringcmd);
// MSG_WriteString(...)` onto cls.netchan.message (CL_ParseDownload's C
// original uses SZ_Print instead of MSG_WriteString for this text, but
// since the preceding byte write means the buffer never ends in a trailing
// NUL, SZ_Print's "no trailing 0" branch produces an identical wire result
// to MSG_WriteString -- verified against sizebuf.ts's SZ_Print).
function writeStringcmd(text: string): void {
  MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_stringcmd);
  MSG_WriteString(cls.netchan.message, text);
}

/*
===============
CL_StartUdpDownload

Extracted from CL_CheckOrDownloadFile's tail so cl_http.ts's HTTP path
(HTTP_QueueDownload) can fall back to it two ways: synchronously, when no
dlserver is advertised at all, and asynchronously, as the per-file UDP
fallback callback (HTTP_SetCallbacks' udpFallback) invoked after an HTTP
transfer fails. Body unchanged from the original CL_CheckOrDownloadFile.
===============
*/
export function CL_StartUdpDownload(filename: string): void {
  cls.downloadname = filename;

  // download to a temp name, and only rename
  // to the real name when done, so if interrupted
  // a runt file wont be left
  cls.downloadtempname = `${COM_StripExtension(cls.downloadname)}.tmp`;

  //ZOID
  // check to see if we already have a tmp for this file, if so, try to resume
  // open the file if not opened yet
  const name = CL_DownloadFileName(cls.downloadtempname);

  const existing = FS_ReadRawFile(name);
  if (existing !== null) {
    // it exists -- resume: give the server an offset to start the download.
    // This port has no persistent open-file-handle resume path (cls.download
    // is only populated once CL_ParseDownload's first packet arrives); the
    // existing bytes are re-written verbatim once that happens, matching the
    // "append from len" semantics via a full rewrite instead of a seek+append.
    Com_Printf("Resuming %s\n", cls.downloadname);
    writeStringcmd(`download ${cls.downloadname} ${existing.length}`);
  } else {
    Com_Printf("Downloading %s\n", cls.downloadname);
    writeStringcmd(`download ${cls.downloadname}`);
  }

  cls.downloadnumber++;
}

/*
===============
CL_CheckOrDownloadFile

Returns true if the file exists, otherwise it attempts to start a download
from the server.

task #24 wiring: tries the HTTP queue first (cl_http.ts's HTTP_QueueDownload,
Q2PRO's check_file_len ordering: "ret = HTTP_QueueDownload(...); if (ret !=
Q_ERR(ENOSYS)) return ret;"). HTTP_QueueDownload itself no-ops immediately
(outcome "no-server"/"http-disabled") when no dlserver was advertised for
this connection or cl_http_downloads is 0, in which case this falls straight
through to the original UDP request unchanged.
===============
*/
export function CL_CheckOrDownloadFile(filename: string, type: HttpDlType = "single"): boolean {
  if (filename.includes("..")) {
    Com_Printf("Refusing to download a path with ..\n");
    return true;
  }

  if (FS_LoadFile(filename) !== null) {
    // it exists, no need to download
    return true;
  }

  const httpResult = HTTP_QueueDownload(filename, type);
  if (httpResult.outcome === "queued" || httpResult.outcome === "duplicate") {
    return false;
  }

  CL_StartUdpDownload(filename);
  return false;
}

/*
===============
CL_Download_f

Request a download from the server
===============
*/
export function CL_Download_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("Usage: download <filename>\n");
    return;
  }

  const filename = Com_sprintf("%s", Cmd_Argv(1));

  if (filename.includes("..")) {
    Com_Printf("Refusing to download a path with ..\n");
    return;
  }

  if (FS_LoadFile(filename) !== null) {
    // it exists, no need to download
    Com_Printf("File already exists.\n");
    return;
  }

  cls.downloadname = filename;
  Com_Printf("Downloading %s\n", cls.downloadname);

  // download to a temp name, and only rename
  // to the real name when done, so if interrupted
  // a runt file wont be left
  cls.downloadtempname = `${COM_StripExtension(cls.downloadname)}.tmp`;

  writeStringcmd(`download ${cls.downloadname}`);

  cls.downloadnumber++;
}

/*
======================
CL_RegisterSounds
======================
*/
export function CL_RegisterSounds(): void {
  S_BeginRegistration();
  CL_RegisterTEntSounds();
  for (let i = 1; i < cl.sound_precache.length; i++) {
    if (!cl.configstrings[cls.csr.sounds + i]) break;
    cl.sound_precache[i] = S_RegisterSound(cl.configstrings[cls.csr.sounds + i]);
    Sys_SendKeyEvents(); // pump message loop
  }
  S_EndRegistration();
}

/*
=====================
CL_ParseDownload

A download message has been received from the server
=====================
*/
export function CL_ParseDownload(): void {
  const size = MSG_ReadShort(net_message);
  const percent = MSG_ReadByte(net_message);
  if (size === -1) {
    Com_Printf("Server does not have this file.\n");
    if (cls.download !== null) {
      // if here, we tried to resume a file but the server said no
      FS_FCloseFile(cls.download);
      cls.download = null;
    }
    CL_RequestNextDownload();
    return;
  }

  // open the file if not opened yet
  if (cls.download === null) {
    const name = CL_DownloadFileName(cls.downloadtempname);

    FS_CreatePath(name);

    cls.download = FS_FOpenFileWrite(name);
    if (cls.download === null) {
      net_message.readcount += size;
      Com_Printf("Failed to open %s\n", cls.downloadtempname);
      CL_RequestNextDownload();
      return;
    }
  }

  FS_Write(net_message.data.subarray(net_message.readcount, net_message.readcount + size), size, cls.download);
  net_message.readcount += size;

  if (percent !== 100) {
    // request next block
    cls.downloadpercent = percent;

    writeStringcmd("nextdl");
  } else {
    FS_FCloseFile(cls.download);

    // rename the temp file to it's final name
    const oldn = CL_DownloadFileName(cls.downloadtempname);
    const newn = CL_DownloadFileName(cls.downloadname);
    const data = FS_ReadRawFile(oldn);
    if (data === null) {
      Com_Printf("failed to rename.\n");
    } else {
      FS_WriteFile(newn, data);
      FS_RemoveFile(oldn);

      // A .pak/.pkz can reach this path too: cl_http.ts's udpFallback
      // callback routes a failed HTTP "pak"-type transfer through
      // CL_StartUdpDownload just like every other download, and this function
      // has no per-download "type" to switch on (unlike cl_http.ts's own
      // completion handler) -- so detect it by extension instead. See
      // files.ts's FS_AddPak doc comment for why this mounts just the one
      // pack rather than a full Q2PRO-style CL_RestartFilesystem.
      const lowerName = cls.downloadname.toLowerCase();
      if (lowerName.endsWith(".pak") || lowerName.endsWith(".pkz")) {
        if (FS_AddPak(newn)) HTTP_RescanQueue();
      }
    }

    cls.download = null;
    cls.downloadpercent = 0;

    // get another file if needed
    CL_RequestNextDownload();
  }
}

/*
=====================================================================

  SERVER CONNECTING MESSAGES

=====================================================================
*/

// Selects the wire codec + configstring-index layout for a freshly-read
// protocol number (ARCHITECTURE.md "Protocol layer" / .orch/phase5-design.md
// phase 5's client-parity follow-up; mirrors sv_game.ts's SV_InitGameProgs
// picking svs.codec/svs.csr off the game family). 1038
// (PROTOCOL_VERSION_RERELEASE) is q2repro's rerelease wire format; every
// other value preserves this engine's ORIGINAL protocol-34 handling
// verbatim, including the pre-existing "BIG HACK to let demos from release
// work with the 3.0x patch!!!" bypass (a listen server's own demo/loopback
// traffic skips the version check entirely) -- that hack must stay scoped to
// "accept anything as vanilla", not "accept anything and skip codec
// selection", which is what let a kex listen server's serverdata silently
// desync the rest of CL_ParseServerMessage before this unit (see task
// report). Returning a function-scoped `never` from Com_Error satisfies
// TypeScript's definite-assignment analysis for the fallthrough return below
// without needing an explicit unreachable branch.
export function selectServerCodec(protocol: number): { codec: ProtocolCodec; csr: CsRemapT } {
  // KEX demo playback unit (.orch/RESUME.md "v1.0.0 REQUIRES ... KEX demo
  // playback"): protocol numbers 2022 (PROTOCOL_KEX_DEMOS, real recorded
  // demos) and 2023 (PROTOCOL_KEX, live native-engine traffic -- never
  // emitted by this engine's own server, but decodable) both select
  // kexdemo.ts's KEX_DEMO_CODEC, exactly mirroring
  // q2proto_proto_kex.c:341-342's own protocol-number range check (this is
  // the ENTIRE detection mechanism -- verified against q2repro's own demo.c:
  // there is no separate file-header magic; a real client detects a KEX
  // stream purely from its first svc_serverdata message's protocol number,
  // same as every other connect). `setKexProtocol` records which of the two
  // was seen -- kexdemo.ts's readDeltaEntity/readSoundKex need it to decide
  // origin/old_origin/SND_POS precision (see that file's own header).
  if (protocol === PROTOCOL_KEX_DEMOS || protocol === PROTOCOL_KEX) {
    setKexProtocol(protocol);
    return { codec: KEX_DEMO_CODEC, csr: CS_REMAP_RERELEASE };
  }
  if (protocol === PROTOCOL_VERSION_RERELEASE) {
    return { codec: Q2REPRO_CODEC, csr: CS_REMAP_RERELEASE };
  }
  // v1.0.0 wire cluster (task board #23): R1Q2 (35) and Q2PRO (36) use the
  // same legacy configstring layout as vanilla (CS_REMAP_OLD) -- only the
  // kex family remaps configstrings. The codec returned here is PROVISIONAL:
  // both wire formats vary by a negotiated minor version this function
  // cannot see yet (it only has the raw protocol number, read before
  // svc_serverdata's body). CL_ParseServerData refines `cls.codec` to the
  // real per-connection instance immediately after reading that body's
  // r1q2Version/q2proVersion field -- this default (at each codec's CURRENT
  // ceiling) is only used to parse that one handshake message, whose shape
  // does not itself vary by minor version.
  if (protocol === PROTOCOL_VERSION_R1Q2) {
    return { codec: createR1Q2Codec(PROTOCOL_VERSION_R1Q2_CURRENT), csr: CS_REMAP_OLD };
  }
  if (protocol === PROTOCOL_VERSION_Q2PRO) {
    return { codec: createQ2ProCodec(PROTOCOL_VERSION_Q2PRO_CURRENT), csr: CS_REMAP_OLD };
  }
  if (Com_ServerState() && PROTOCOL_VERSION === 34) {
    // no-op; see C source
    return { codec: VANILLA_CODEC, csr: CS_REMAP_OLD };
  }
  if (protocol !== PROTOCOL_VERSION) {
    Com_Error(ERR_DROP, "Server returned version %i, not %i", protocol, PROTOCOL_VERSION);
  }
  return { codec: VANILLA_CODEC, csr: CS_REMAP_OLD };
}

/*
==================
CL_ParseServerData
==================
*/
export function CL_ParseServerData(): void {
  Com_DPrintf("Serverdata packet received.\n");
  //
  // wipe the client_state_t struct
  //
  CL_ClearState();
  cls.state = ConnstateT.ca_connected;

  // parse protocol version number
  const i = MSG_ReadLong(net_message);
  cls.serverProtocol = i;

  const { codec, csr } = selectServerCodec(i);
  cls.codec = codec;
  cls.csr = csr;

  // Activate the cgame that matches the family this connection just
  // selected -- q2repro's cgame.c:425-437 precedent ("rerelease server ->
  // load the game's cgame; classic server -> builtin classic"). Keyed off
  // `csr` (the actual family selectServerCodec chose), not the raw
  // `protocol` number read above: CS_REMAP_RERELEASE is the one value
  // selectServerCodec ever returns for the kex family, so this stays correct
  // even through the "BIG HACK" listen-server demo-compat branch above,
  // which can return CS_REMAP_OLD for reasons unrelated to `i`'s own value.
  CG_SetActiveCgameKind(csr === CS_REMAP_RERELEASE ? "kex" : "classic");

  const sd = codec.readServerData();

  // Refine cls.codec to the negotiated minor version now that the handshake
  // body is read (see selectServerCodec's doc comment above for why the
  // codec picked off the protocol number alone is only provisional for
  // these two families -- R1Q2's U_SOLID width and Q2PRO's serverdata echo
  // both depend on this). Must happen before any further codec use (entity/
  // frame reads), which only occur much later once the client has spawned.
  if (i === PROTOCOL_VERSION_R1Q2) {
    cls.codec = createR1Q2Codec(sd.r1q2Version ?? PROTOCOL_VERSION_R1Q2_CURRENT);
  } else if (i === PROTOCOL_VERSION_Q2PRO) {
    cls.codec = createQ2ProCodec(sd.q2proVersion ?? PROTOCOL_VERSION_Q2PRO_CURRENT);
  }

  cl.servercount = sd.servercount;
  cl.attractloop = sd.attractloop;

  // game directory
  cl.gamedir = sd.gamedir;

  // set gamedir
  const currentGamedir = fs_gamedirvar ? fs_gamedirvar.string : "";
  if (sd.gamedir !== currentGamedir) Cvar_Set("game", sd.gamedir);

  // parse player entity number
  cl.playernum = sd.clientnum;

  // get the full level name
  const str = sd.levelname;

  if (cl.playernum === -1) {
    // playing a cinematic or showing a pic, not a level
    SCR_PlayCinematic(str);
  } else {
    // seperate the printfs so the server message can have a color
    Com_Printf(`\n\n\x1d${"\x1e".repeat(35)}\x1f\n\n`);
    Com_Printf("%c%s\n", 2, str);

    // need to prep refresh at next oportunity
    cl.refresh_prepped = false;
  }
}

/*
==================
CL_ParseBaseline
==================
*/
export function CL_ParseBaseline(): void {
  const nullstate = new EntityStateT();

  const { number: newnum, bits } = CL_ParseEntityBits();
  const es = cl_entities[newnum].baseline;
  CL_ParseDelta(nullstate, es, newnum, bits);
}

/*
================
CL_LoadClientinfo
================
*/
export function CL_LoadClientinfo(ci: ClientinfoT, s: string): void {
  ci.cinfo = s;

  // isolate the player's name
  let name = s;
  let rest = s;
  const bs = s.indexOf("\\");
  if (bs !== -1) {
    name = s.slice(0, bs);
    rest = s.slice(bs + 1);
  }
  ci.name = name;

  if (clCvars.cl_noskins?.value || rest === "") {
    const model_filename = "players/male/tris.md2";
    const weapon_filename = "players/male/weapon.md2";
    const skin_filename = "players/male/grunt.pcx";
    ci.iconname = "/players/male/grunt_i.pcx";
    ci.model = re?.RegisterModel(model_filename) ?? null;
    ci.weaponmodel = ci.weaponmodel.map(() => null);
    ci.weaponmodel[0] = re?.RegisterModel(weapon_filename) ?? null;
    ci.skin = re?.RegisterSkin(skin_filename) ?? null;
    ci.icon = re?.RegisterPic(ci.iconname) ?? null;
  } else {
    // isolate the model name
    let model_name = rest;
    let slashIdx = model_name.indexOf("/");
    if (slashIdx === -1) slashIdx = model_name.indexOf("\\");
    if (slashIdx !== -1) model_name = model_name.slice(0, slashIdx);

    // isolate the skin name
    const skin_name = rest.slice(model_name.length + 1);

    // model file
    let model_filename = `players/${model_name}/tris.md2`;
    ci.model = re?.RegisterModel(model_filename) ?? null;
    if (!ci.model) {
      model_name = "male";
      model_filename = "players/male/tris.md2";
      ci.model = re?.RegisterModel(model_filename) ?? null;
    }

    // skin file
    let skin_filename = `players/${model_name}/${skin_name}.pcx`;
    ci.skin = re?.RegisterSkin(skin_filename) ?? null;

    // if we don't have the skin and the model wasn't male,
    // see if the male has it (this is for CTF's skins)
    if (!ci.skin && model_name !== "male") {
      // change model to male
      model_name = "male";
      model_filename = "players/male/tris.md2";
      ci.model = re?.RegisterModel(model_filename) ?? null;

      // see if the skin exists for the male model
      skin_filename = `players/${model_name}/${skin_name}.pcx`;
      ci.skin = re?.RegisterSkin(skin_filename) ?? null;
    }

    // if we still don't have a skin, it means that the male model didn't have
    // it, so default to grunt
    if (!ci.skin) {
      // see if the skin exists for the male model
      skin_filename = `players/${model_name}/grunt.pcx`;
      ci.skin = re?.RegisterSkin(skin_filename) ?? null;
    }

    // weapon file
    for (let i = 0; i < num_cl_weaponmodels; i++) {
      let weapon_filename = `players/${model_name}/${cl_weaponmodels[i]}`;
      ci.weaponmodel[i] = re?.RegisterModel(weapon_filename) ?? null;
      if (!ci.weaponmodel[i] && model_name === "cyborg") {
        // try male
        weapon_filename = `players/male/${cl_weaponmodels[i]}`;
        ci.weaponmodel[i] = re?.RegisterModel(weapon_filename) ?? null;
      }
      if (!clCvars.cl_vwep?.value) break; // only one when vwep is off
    }

    // icon file
    ci.iconname = `/players/${model_name}/${skin_name}_i.pcx`;
    ci.icon = re?.RegisterPic(ci.iconname) ?? null;
  }

  // must have loaded all data types to be valid
  if (!ci.skin || !ci.icon || !ci.model || !ci.weaponmodel[0]) {
    ci.skin = null;
    ci.icon = null;
    ci.model = null;
    ci.weaponmodel[0] = null;
  }
}

/*
================
CL_ParseClientinfo

Load the skin, icon, and model for a client
================
*/
export function CL_ParseClientinfo(player: number): void {
  const s = cl.configstrings[player + cls.csr.playerskins];
  const ci = cl.clientinfo[player];
  CL_LoadClientinfo(ci, s);
}

// CM_InlineModel returns a non-nullable CmodelT and Com_Errors (ERR_DROP) if
// no map is loaded; CL_ParseConfigString's original C call site never
// guards against that (a client always has a map loaded by the time a
// "*NNN" model configstring arrives), but this port's tests exercise
// configstring parsing without a loaded map -- guarded here to keep that
// reachable without a Com_Error escaping. Reported deviation.
function CM_InlineModelSafe(name: string): CmodelT | null {
  try {
    return CM_InlineModel(name);
  } catch {
    return null;
  }
}

/*
================
CL_ParseConfigString
================
*/
export function CL_ParseConfigString(): void {
  const i = MSG_ReadShort(net_message);
  if (i < 0 || i >= cls.csr.end) Com_Error(ERR_DROP, "configstring > MAX_CONFIGSTRINGS");
  const s = MSG_ReadString(net_message);
  cl.configstrings[i] = s;

  // do something apropriate

  // Index bases below come from cls.csr (shared/cs_remap.ts), the connection's
  // configstring-index layout selected at CL_ParseServerData time -- CS_LIGHTS/
  // CS_MODELS/CS_SOUNDS/CS_IMAGES/CS_PLAYERSKINS all differ between the classic
  // (protocol 34) and rerelease (1038/kex) families (server.ts's svs.csr is
  // the write-side mirror of this same table). CS_CDTRACK is one of the few
  // low fixed indices q2repro's cs_remap_rerelease keeps identical to
  // classic's layout (shared.h's cs_remap tables both start CS_CDTRACK at 1),
  // so it stays a plain q_shared.ts import, unlike the family-varying blocks.
  //
  // DEVIATION from a byte-for-byte port: upstream's real cl_parse.c (and this
  // port's original protocol-34-only code) reuses MAX_MODELS as the upper
  // bound for the CS_SOUNDS and CS_IMAGES branches below too (a genuine id
  // Software copy-paste bug, verified against qsrc/quake-2/client/cl_parse.c:
  // 550,555) -- harmless under the classic family only because
  // MAX_MODELS===MAX_SOUNDS===256 there. Under the rerelease family
  // MAX_MODELS_WIDE(8192) is nearly 4x MAX_SOUNDS_WIDE(2048) and 16x
  // MAX_IMAGES_WIDE(512), so reproducing the bug literally would make the
  // CS_SOUNDS branch's range swallow the entire real CS_IMAGES/CS_LIGHTS/
  // CS_ITEMS/CS_PLAYERSKINS blocks that follow it in configstring-index space
  // (every image/light/item/skin configstring update would be misrouted into
  // S_RegisterSound), which is not something q2repro's own (bug-free)
  // configstring handling does either. Each branch below uses its OWN
  // family-correct bound (cls.csr.max_sounds / cls.csr.max_images) instead --
  // byte-identical to the buggy original under the classic family (where the
  // two bounds are numerically equal), and correct under the rerelease
  // family where they are not.
  if (i >= cls.csr.lights && i < cls.csr.lights + MAX_LIGHTSTYLES) {
    CL_SetLightstyle(i - cls.csr.lights);
  } else if (i === CS_CDTRACK) {
    if (cl.refresh_prepped) {
      CDAudio_Play(parseInt(cl.configstrings[CS_CDTRACK], 10) || 0, true);
    }
  } else if (i >= cls.csr.models && i < cls.csr.models + cls.csr.max_models) {
    if (cl.refresh_prepped) {
      cl.model_draw[i - cls.csr.models] = re?.RegisterModel(cl.configstrings[i]) ?? null;
      if (cl.configstrings[i][0] === "*") {
        cl.model_clip[i - cls.csr.models] = CM_InlineModelSafe(cl.configstrings[i]);
      } else {
        cl.model_clip[i - cls.csr.models] = null;
      }
    }
  } else if (i >= cls.csr.sounds && i < cls.csr.sounds + cls.csr.max_sounds) {
    if (cl.refresh_prepped) cl.sound_precache[i - cls.csr.sounds] = S_RegisterSound(cl.configstrings[i]);
  } else if (i >= cls.csr.images && i < cls.csr.images + cls.csr.max_images) {
    if (cl.refresh_prepped) cl.image_precache[i - cls.csr.images] = re?.RegisterPic(cl.configstrings[i]) ?? null;
  } else if (i >= cls.csr.playerskins && i < cls.csr.playerskins + MAX_CLIENTS) {
    if (cl.refresh_prepped) CL_ParseClientinfo(i - cls.csr.playerskins);
  } else if (cls.csr.shadowlights !== -1 && i >= cls.csr.shadowlights && i < cls.csr.shadowlights + cls.csr.max_shadowlights) {
    // task #25 (v1.1.0) -- q2repro src/client/precache.c's CS_LoadShadowLight
    // dispatch. cls.csr.shadowlights is -1 under the classic (OLD)
    // configstring family (cs_remap.ts's CS_REMAP_OLD), which has no room
    // for shadow lights at all -- guarded explicitly since -1 would
    // otherwise satisfy `i >= -1` for every index.
    CL_ParseShadowLightConfigstring(i - cls.csr.shadowlights, cl.configstrings[i]);
  }
}

/*
=====================================================================

ACTION MESSAGES

=====================================================================
*/

/*
==================
CL_ParseStartSoundPacket
==================
*/
export function CL_ParseStartSoundPacket(): void {
  const flags = MSG_ReadByte(net_message);
  const sound_num = MSG_ReadByte(net_message);

  let volume: number;
  if (flags & SND_VOLUME) volume = MSG_ReadByte(net_message) / 255.0;
  else volume = DEFAULT_SOUND_PACKET_VOLUME;

  let attenuation: number;
  if (flags & SND_ATTENUATION) attenuation = MSG_ReadByte(net_message) / 64.0;
  else attenuation = DEFAULT_SOUND_PACKET_ATTENUATION;

  let ofs: number;
  if (flags & SND_OFFSET) ofs = MSG_ReadByte(net_message) / 1000.0;
  else ofs = 0;

  let ent: number;
  let channel: number;
  if (flags & SND_ENT) {
    // entity reletive
    channel = MSG_ReadShort(net_message);
    ent = channel >> 3;
    if (ent > MAX_EDICTS) Com_Error(ERR_DROP, "CL_ParseStartSoundPacket: ent = %i", ent);

    channel &= 7;
  } else {
    ent = 0;
    channel = 0;
  }

  let pos: Float32Array | null = null;
  if (flags & SND_POS) {
    // positioned in space
    pos = new Float32Array(3);
    MSG_ReadPos(net_message, pos);
  }

  if (!cl.sound_precache[sound_num]) return;

  S_StartSound(pos, ent, channel, cl.sound_precache[sound_num], volume, attenuation, ofs);
}

// KEX demo playback unit: the KEX-format svc_sound counterpart to
// CL_ParseStartSoundPacket above -- see kexdemo.ts's readSoundKex for the
// byte-layout citation (genuinely different from vanilla's: u16 index,
// SND_KEX_LARGE_ENT-widened entchan, demo-precision SND_POS).
function CL_ParseStartSoundPacketKex(): void {
  const sound = readSoundKex();
  if (sound.entity > MAX_EDICTS) Com_Error(ERR_DROP, "CL_ParseStartSoundPacketKex: ent = %i", sound.entity);
  if (!cl.sound_precache[sound.index]) return;
  S_StartSound(sound.pos, sound.entity, sound.channel, cl.sound_precache[sound.index], sound.volume, sound.attenuation, sound.timeofs);
}

export function SHOWNET(s: string): void {
  if (clCvars.cl_shownet && clCvars.cl_shownet.value >= 2) {
    Com_Printf("%3i:%s\n", net_message.readcount - 1, s);
  }
}

/*
=====================
CL_ParseServerMessage
=====================
*/
export function CL_ParseServerMessage(): void {
  //
  // if recording demos, copy the message out
  //
  if (clCvars.cl_shownet?.value === 1) Com_Printf("%i ", net_message.cursize);
  else if (clCvars.cl_shownet && clCvars.cl_shownet.value >= 2) Com_Printf("------------------\n");

  CL_ParseServerMessageLoop();

  // CL_AddNetgraph() -- cl_scrn.ts's pending stub; called unconditionally in
  // the original after every parsed message. Left uncalled here: it is a
  // pure debug-overlay bookkeeping function and would
  // make every successful CL_ParseServerMessage call throw; reported gap for
  // whoever lands cl_scrn.c for real.

  //
  // we don't know if it is ok to save a demo message until
  // after we have parsed the frame
  //
  if (cls.demorecording && !cls.demowaiting) CL_WriteDemoMessage();
}

// v1.0.0 wire cluster (task board #23): factored out of CL_ParseServerMessage
// so svc_r1q2_zpacket (opcode SVC_ZPACKET, shared numeric slot with KEX's
// svc_splitclient below) can recursively re-enter the SAME per-command
// dispatch against a decompressed sub-stream -- see CL_ParseZPacket. Mirrors
// r1q2_client_read_zpacket's own C comment: "zpacket might contain multiple
// packets, so try to read from inflated message repeatedly". The shownet
// header print and demo-write trailer stay in CL_ParseServerMessage (they
// must run exactly once per real received packet, not once per nested
// zpacket payload).
function CL_ParseServerMessageLoop(): void {
  //
  // parse the message
  //
  for (;;) {
    if (net_message.readcount > net_message.cursize) {
      Com_Error(ERR_DROP, "CL_ParseServerMessage: Bad server message");
      break;
    }

    let cmd = MSG_ReadByte(net_message);

    if (cmd === -1) {
      SHOWNET("END OF MESSAGE");
      break;
    }

    // R1Q2/Q2PRO steal the top 3 bits of every opcode byte to smuggle part
    // of the player_state_t "extraflags" value (EPS_*) alongside svc_frame's
    // own opcode -- see r1q2.ts/q2pro.ts's file-header "INTEGRATION GAP"
    // notes, which specify exactly this fix. A real peer only ever sets
    // these bits when writing svc_frame's opcode byte (every other opcode's
    // writer ORs in nothing), so this is a harmless no-op for every other
    // command, and masking is a no-op for every OTHER codec (vanilla/
    // q2repro/kexdemo never set these bits at all).
    if (cls.codec.name === "r1q2") {
      setR1Q2FrameExtrabits(cmd & 0xe0);
      cmd &= 0x1f;
    } else if (cls.codec.name === "q2pro") {
      noteQ2ProFrameOpcodeExtrabits(cmd & 0xe0);
      cmd &= 0x1f;
    }

    if (clCvars.cl_shownet && clCvars.cl_shownet.value >= 2) {
      if (!svc_strings[cmd]) Com_Printf("%3i:BAD CMD %i\n", net_message.readcount - 1, cmd);
      else SHOWNET(svc_strings[cmd]);
    }

    // other commands
    switch (cmd) {
      case SvcOpsT.svc_nop:
        break;

      case SvcOpsT.svc_disconnect:
        Com_Error(ERR_DISCONNECT, "Server disconnected\n");
        break;

      case SvcOpsT.svc_reconnect:
        Com_Printf("Server disconnected, reconnecting\n");
        if (cls.download !== null) {
          // ZOID, close download
          FS_FCloseFile(cls.download);
          cls.download = null;
        }
        cls.state = ConnstateT.ca_connecting;
        cls.connect_time = -99999; // CL_CheckForResend() will fire immediately
        break;

      case SvcOpsT.svc_print: {
        const printLevel = MSG_ReadByte(net_message);
        const printString = MSG_ReadString(net_message);

        if (printLevel === PRINT_CHAT) {
          S_StartLocalSound("misc/talk.wav");
          con.ormask = 128;
        }

        // q2repro's CL_HandlePrint (src/client/parse.c:970-1001):
        // `if (level == PRINT_TYPEWRITER || level == PRINT_CENTER)
        // cgame->ParseCenterPrint(s, 0, level == PRINT_CENTER); else
        // Com_Printf(...)`. This port has no kex cgame host with a
        // ParseCenterPrint member (typewriter char-by-char reveal included)
        // -- src/client/cgame/host.ts's own header notes those members as
        // not-yet-ported -- so both re-release print levels fall back to
        // this codebase's own (vanilla-protocol) centerprint banner,
        // `SCR_CenterPrint` (already reachable via the legacy svc_centerprint
        // opcode below). Without this, every server-side re-release
        // centerprint sent through `gi.Loc_Print`'s PRINT_CENTER/
        // PRINT_TYPEWRITER levels (svc_print + a level byte, not
        // svc_centerprint -- see src/server/sv_send.ts's SV_ClientPrintf)
        // would silently degrade to a plain console line instead of an
        // on-screen banner, even once the text itself is correctly
        // localized.
        if (printLevel === PrintTypeT.PRINT_CENTER || printLevel === PrintTypeT.PRINT_TYPEWRITER) {
          SCR_CenterPrint(printString);
        } else {
          Com_Printf("%s", printString);
        }
        con.ormask = 0;
        break;
      }

      case SvcOpsT.svc_centerprint:
        SCR_CenterPrint(MSG_ReadString(net_message));
        break;

      case SvcOpsT.svc_stufftext: {
        const s = MSG_ReadString(net_message);
        Com_DPrintf("stufftext: %s\n", s);
        Cbuf_AddText(s);
        break;
      }

      case SvcOpsT.svc_serverdata:
        Cbuf_Execute(); // make sure any stuffed commands are done
        CL_ParseServerData();
        break;

      case SvcOpsT.svc_configstring:
        CL_ParseConfigString();
        break;

      case SvcOpsT.svc_sound:
        // KEX demo playback unit: KEX's svc_sound is a genuinely different
        // byte layout (u16 index, SND_KEX_LARGE_ENT-widened entchan,
        // demo-precision SND_POS) from vanilla's -- see kexdemo.ts's own
        // readSoundKex header comment. Never reached for a genuine vanilla
        // stream (cls.codec stays VANILLA_CODEC/Q2REPRO_CODEC there).
        if (cls.codec === KEX_DEMO_CODEC) CL_ParseStartSoundPacketKex();
        else CL_ParseStartSoundPacket();
        break;

      case SvcOpsT.svc_spawnbaseline:
        CL_ParseBaseline();
        break;

      case SvcOpsT.svc_temp_entity:
        // KEX demos (2022) use the SAME "short" temp-entity layout as
        // vanilla (kex.c:213-220's own protocol branch) -- CL_ParseTEnt is
        // reused unchanged. Live-2023 traffic uses a different float layout
        // this port does not implement (kexdemo.ts SCOPE CUTS; this
        // engine's own server never speaks 2023, so no real code path here
        // can produce it) -- throws rather than silently misdecoding.
        if (cls.codec === KEX_DEMO_CODEC && !isKexDemoProtocol()) {
          Com_Error(ERR_DROP, "CL_ParseServerMessage: KEX protocol 2023's float svc_temp_entity format is not implemented");
        }
        CL_ParseTEnt();
        break;

      case SvcOpsT.svc_muzzleflash:
        CL_ParseMuzzleFlash();
        break;

      case SvcOpsT.svc_muzzleflash2:
        CL_ParseMuzzleFlash2();
        break;

      case SvcOpsT.svc_download:
        CL_ParseDownload();
        break;

      case SvcOpsT.svc_frame:
        CL_ParseFrame();
        break;

      case SvcOpsT.svc_inventory:
        CL_ParseInventory();
        break;

      case SvcOpsT.svc_layout: {
        const s = MSG_ReadString(net_message);
        cl.layout = s;
        break;
      }

      // KEX demo playback unit: the KEX-only auxiliary opcodes (kex.c's
      // dispatch table, opcodes 21-33 minus the unused 24/28/29 gaps --
      // kexdemo.ts's file header). Numerically these are ServerCommandT's
      // values (kexapi/game.ts), which share SvcOpsT's own numbering for
      // every opcode both enums define (verified: svc_bad..svc_frame are
      // identical in both) -- mixing case labels from the two enums against
      // this same `cmd: number` switch is safe. Every case here is
      // UNREACHABLE for a genuine vanilla (protocol 34) stream: vanilla's
      // own game/server code never emits a byte value this high. Each
      // reader below consumes exactly its message's bytes (keeping the
      // stream byte-aligned, this unit's "parse all messages without
      // error" bar) but does not yet apply its content to client state --
      // narrower than full 1038/KEX live-network client support (a real,
      // separate, larger gap this unit does not close -- see this file's
      // own report).
      case ServerCommandT.svc_splitclient:
        // Numerically the same opcode slot as SVC_ZPACKET (both families
        // start their own private opcode range at svc_frame+1 == 21) --
        // only one family's codec is ever active per connection, so this
        // branch is unambiguous. See qcommon.ts's SVC_ZPACKET doc comment.
        if (cls.codec.name === "r1q2" || cls.codec.name === "q2pro") CL_ParseZPacket();
        else readSplitclientKex();
        break;

      case ServerCommandT.svc_configblast:
        readConfigblastKex(); // decoded for real; NOT applied to cl.configstrings (see report)
        break;

      case ServerCommandT.svc_spawnbaselineblast:
        readSpawnbaselineblastKex(); // decoded for real; NOT applied to cl_entities baselines (see report)
        break;

      case ServerCommandT.svc_damage:
        readDamageKex();
        break;

      case ServerCommandT.svc_locprint:
        readLocprintKex();
        break;

      case ServerCommandT.svc_fog:
        readFog();
        break;

      case ServerCommandT.svc_poi:
        readPoiKex();
        break;

      case ServerCommandT.svc_help_path:
        readHelpPathKex();
        break;

      case ServerCommandT.svc_muzzleflash3:
        readMuzzleflash3Kex();
        break;

      case ServerCommandT.svc_achievement:
        readAchievementKex();
        break;

      case SvcOpsT.svc_playerinfo:
      case SvcOpsT.svc_packetentities:
      case SvcOpsT.svc_deltapacketentities:
        Com_Error(ERR_DROP, "Out of place frame data");
        break;

      default:
        Com_Error(ERR_DROP, "CL_ParseServerMessage: Illegible server message\n");
        break;
    }
  }
}

// svc_r1q2_zpacket / svc_q2pro's shared zpacket opcode (SVC_ZPACKET,
// qcommon.ts) -- inflates the wrapped payload (qcommon/protocol/zpacket.ts)
// and recursively re-runs CL_ParseServerMessageLoop against it, exactly
// mirroring r1q2_client_read_zpacket's own "zpacket might contain multiple
// packets, so try to read from inflated message repeatedly" comment: the
// decompressed bytes become the dispatch loop's entire input until
// exhausted (the loop's existing `cmd === -1` end-of-message sentinel fires
// naturally once `net_message.readcount` reaches the inflated buffer's own
// length), then the OUTER (still-compressed-container) message resumes
// reading exactly where it left off. Mirrors kexdemo.ts's
// readSpawnbaselineblastKex save/restore-net_message pattern for the
// identical "temporarily repoint the singleton" need -- the `finally` here
// additionally guarantees the singleton is restored even if a nested parse
// error throws (Com_Error(ERR_DROP, ...) does not return), which
// readSpawnbaselineblastKex's own (try-less) precedent does not need to
// worry about since it never recurses into arbitrary opcode dispatch.
function CL_ParseZPacket(): void {
  const inflated = readZPacketPayload(net_message);

  const saved = {
    data: net_message.data,
    view: net_message.view,
    cursize: net_message.cursize,
    readcount: net_message.readcount,
    maxsize: net_message.maxsize,
  };

  net_message.data = inflated;
  net_message.view = new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  net_message.cursize = inflated.length;
  net_message.readcount = 0;
  net_message.maxsize = inflated.length;

  try {
    CL_ParseServerMessageLoop();
  } finally {
    net_message.data = saved.data;
    net_message.view = saved.view;
    net_message.cursize = saved.cursize;
    net_message.readcount = saved.readcount;
    net_message.maxsize = saved.maxsize;
  }
}
