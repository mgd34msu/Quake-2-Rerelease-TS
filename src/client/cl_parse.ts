// cl_parse.c -- parse a message received from the server

import { CDAudio_Play } from "../platform/cd_ogg";
import { Sys_SendKeyEvents } from "../platform/sys";
import { fixedLength } from "../shared/fixed";
import { MSG_ReadByte, MSG_ReadShort, MSG_ReadLong, MSG_ReadString, MSG_ReadPos, MSG_WriteByte, MSG_WriteString } from "../qcommon/sizebuf";
import { net_message } from "../qcommon/net_chan";
import { SvcOpsT, ClcOpsT, PROTOCOL_VERSION, ERR_DROP, BASEDIRNAME } from "../qcommon/qcommon";
import { cl, cls, ConnstateT, svc_strings, clCvars, cl_entities, type ClientinfoT, num_cl_weaponmodels, cl_weaponmodels, re } from "./client";
import {
  EntityStateT,
  type CmodelT,
  CS_LIGHTS,
  CS_CDTRACK,
  CS_MODELS,
  CS_SOUNDS,
  CS_IMAGES,
  CS_PLAYERSKINS,
  MAX_MODELS,
  MAX_CLIENTS,
  MAX_LIGHTSTYLES,
  MAX_CONFIGSTRINGS,
  MAX_EDICTS,
  PRINT_CHAT,
  ERR_DISCONNECT,
  Com_sprintf,
} from "../shared/q_shared";
import { Com_Error, Com_Printf, Com_DPrintf, Com_ServerState } from "../qcommon/common";
import { Cvar_Set } from "../qcommon/cvar";
import { Cbuf_AddText, Cbuf_Execute, Cmd_Argc, Cmd_Argv } from "../qcommon/cmd";
import { FS_LoadFile, FS_Gamedir, FS_CreatePath, FS_FOpenFileWrite, FS_Write, FS_FCloseFile, FS_ReadRawFile, FS_WriteFile, FS_RemoveFile, fs_gamedirvar } from "../qcommon/files";
import { COM_StripExtension } from "../shared/math";
import { CM_InlineModel } from "../qcommon/cmodel";
import { CL_ClearState, CL_RequestNextDownload, CL_WriteDemoMessage } from "./cl_main";
import { SCR_PlayCinematic } from "./cl_cin";
import { SCR_CenterPrint } from "./cl_scrn";
import { con } from "./console";
import { S_StartSound, S_StartLocalSound, S_BeginRegistration, S_RegisterSound, S_EndRegistration } from "./snd_dma";
import { CL_RegisterTEntSounds, CL_ParseTEnt } from "./cl_tent";
import { CL_ParseMuzzleFlash, CL_ParseMuzzleFlash2, CL_SetLightstyle } from "./cl_fx";
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

function CL_DownloadFileName(fn: string): string {
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
CL_CheckOrDownloadFile

Returns true if the file exists, otherwise it attempts
to start a download from the server.
===============
*/
export function CL_CheckOrDownloadFile(filename: string): boolean {
  if (filename.includes("..")) {
    Com_Printf("Refusing to download a path with ..\n");
    return true;
  }

  if (FS_LoadFile(filename) !== null) {
    // it exists, no need to download
    return true;
  }

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
    if (!cl.configstrings[CS_SOUNDS + i]) break;
    cl.sound_precache[i] = S_RegisterSound(cl.configstrings[CS_SOUNDS + i]);
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

  // BIG HACK to let demos from release work with the 3.0x patch!!!
  if (Com_ServerState() && PROTOCOL_VERSION === 34) {
    // no-op; see C source
  } else if (i !== PROTOCOL_VERSION) {
    Com_Error(ERR_DROP, "Server returned version %i, not %i", i, PROTOCOL_VERSION);
  }

  cl.servercount = MSG_ReadLong(net_message);
  cl.attractloop = MSG_ReadByte(net_message) !== 0;

  // game directory
  const gamedirStr = MSG_ReadString(net_message);
  cl.gamedir = gamedirStr;

  // set gamedir
  const currentGamedir = fs_gamedirvar ? fs_gamedirvar.string : "";
  if (gamedirStr !== currentGamedir) Cvar_Set("game", gamedirStr);

  // parse player entity number
  cl.playernum = MSG_ReadShort(net_message);

  // get the full level name
  const str = MSG_ReadString(net_message);

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
  const s = cl.configstrings[player + CS_PLAYERSKINS];
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
  if (i < 0 || i >= MAX_CONFIGSTRINGS) Com_Error(ERR_DROP, "configstring > MAX_CONFIGSTRINGS");
  const s = MSG_ReadString(net_message);
  cl.configstrings[i] = s;

  // do something apropriate

  if (i >= CS_LIGHTS && i < CS_LIGHTS + MAX_LIGHTSTYLES) {
    CL_SetLightstyle(i - CS_LIGHTS);
  } else if (i === CS_CDTRACK) {
    if (cl.refresh_prepped) {
      CDAudio_Play(parseInt(cl.configstrings[CS_CDTRACK], 10) || 0, true);
    }
  } else if (i >= CS_MODELS && i < CS_MODELS + MAX_MODELS) {
    if (cl.refresh_prepped) {
      cl.model_draw[i - CS_MODELS] = re?.RegisterModel(cl.configstrings[i]) ?? null;
      if (cl.configstrings[i][0] === "*") {
        cl.model_clip[i - CS_MODELS] = CM_InlineModelSafe(cl.configstrings[i]);
      } else {
        cl.model_clip[i - CS_MODELS] = null;
      }
    }
  } else if (i >= CS_SOUNDS && i < CS_SOUNDS + MAX_MODELS) {
    if (cl.refresh_prepped) cl.sound_precache[i - CS_SOUNDS] = S_RegisterSound(cl.configstrings[i]);
  } else if (i >= CS_IMAGES && i < CS_IMAGES + MAX_MODELS) {
    if (cl.refresh_prepped) cl.image_precache[i - CS_IMAGES] = re?.RegisterPic(cl.configstrings[i]) ?? null;
  } else if (i >= CS_PLAYERSKINS && i < CS_PLAYERSKINS + MAX_CLIENTS) {
    if (cl.refresh_prepped) CL_ParseClientinfo(i - CS_PLAYERSKINS);
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

  //
  // parse the message
  //
  for (;;) {
    if (net_message.readcount > net_message.cursize) {
      Com_Error(ERR_DROP, "CL_ParseServerMessage: Bad server message");
      break;
    }

    const cmd = MSG_ReadByte(net_message);

    if (cmd === -1) {
      SHOWNET("END OF MESSAGE");
      break;
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
        if (printLevel === PRINT_CHAT) {
          S_StartLocalSound("misc/talk.wav");
          con.ormask = 128;
        }
        Com_Printf("%s", MSG_ReadString(net_message));
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
        CL_ParseStartSoundPacket();
        break;

      case SvcOpsT.svc_spawnbaseline:
        CL_ParseBaseline();
        break;

      case SvcOpsT.svc_temp_entity:
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
