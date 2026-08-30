// cl.input.c -- builds an intended movement command to send to the server
//
// client.h misattributes CL_ClearState and CL_ReadPackets to this file's
// section; both are actually defined in cl_main.c (confirmed by grep) and
// are ported in cl_main.ts instead. CL_SendMove/CL_ReadFromServer/
// CL_WriteToServer/CL_ParseLayout are declared in client.h but never
// defined anywhere in the v3.19 client tree -- dead declarations, dropped
// and reported. Key_KeynumToString is declared here too but is actually
// defined in keys.c; ported in keys_impl.ts instead.
//
// `extern unsigned sys_frame_time;` (cl_input.c) is defined in
// linux/sys_linux.c beside Sys_SendKeyEvents, which assigns it once per
// frame before pumping the OS event queue; both live in
// src/platform/sys.ts and are re-exported here for the C callers that
// reach them through this file's header section (client.h declares
// Sys_SendKeyEvents alongside the cl_input.c prototypes).
//
// IN_Move/IN_Commands/IN_Frame are the mouse/joystick side of the input
// backend (win32/in_win.c, linux/rw_x11.c's RW_IN_*); per PORTING.md's
// platform mapping they live in src/platform/sdl.ts and are re-exported
// here under the names client.h declares.

import { Cmd_Argv, Cmd_AddCommand } from "../qcommon/cmd";
import { Cvar_Get, Cvar_Userinfo, userinfo_modified, SetUserinfoModified } from "../qcommon/cvar";
import { Com_Printf, COM_BlockSequenceCRCByte } from "../qcommon/common";
import { Netchan_Transmit } from "../qcommon/net_chan";
import { SizeBuf, SZ_Init, MSG_WriteByte, MSG_WriteLong, MSG_WriteString } from "../qcommon/sizebuf";
import { ClcOpsT } from "../qcommon/qcommon";
import { Sys_SendKeyEvents, sys_frame_time } from "../platform/sys";
import { IN_Commands, IN_Frame, IN_Init, IN_Move, IN_Shutdown } from "../platform/sdl";
import { PITCH, YAW, UsercmdT, SHORT2ANGLE, ANGLE2SHORT, type CvarT } from "../shared/q_shared";
import { VectorCopy } from "../shared/math";
import { cl, cls, ConnstateT, KeydestT, KbuttonT, clCvars, in_klook, in_strafe, in_speed } from "./client";
import { anykeydown } from "./keys";
import { CL_FixUpGender } from "./cl_main";
import { SCR_FinishCinematic } from "./cl_cin";

/*
===============================================================================

KEY BUTTONS

Continuous button event tracking is complicated by the fact that two different
input sources (say, mouse button 1 and the control key) can both press the
same button, but the button should only be released when both of the
pressing key have been released.

When a key event issues a button command (+forward, +attack, etc), it appends
its key number as a parameter to the command so it can be matched up with
the release.

state bit 0 is the current state of the key
state bit 1 is edge triggered on the up to down transition
state bit 2 is edge triggered on the down to up transition

===============================================================================
*/

// old_sys_frame_time/frame_msec are real cl_input.c file-scope globals;
// sys_frame_time and Sys_SendKeyEvents belong to the platform layer -- see
// file banner.
export { Sys_SendKeyEvents, sys_frame_time };
export { IN_Commands, IN_Frame, IN_Init, IN_Move, IN_Shutdown };
let old_sys_frame_time = 0;
let frame_msec = 0;

// in_klook/in_strafe/in_speed come from client.ts (extern'd in client.h, see
// that file's ownership note). The rest of cl_input.c's kbutton_t globals are
// private to this file in C (never extern'd elsewhere) and live here.
export const in_left = new KbuttonT();
export const in_right = new KbuttonT();
export const in_forward = new KbuttonT();
export const in_back = new KbuttonT();
export const in_lookup = new KbuttonT();
export const in_lookdown = new KbuttonT();
export const in_moveleft = new KbuttonT();
export const in_moveright = new KbuttonT();
export const in_use = new KbuttonT();
export const in_attack = new KbuttonT();
export const in_up = new KbuttonT();
export const in_down = new KbuttonT();

let in_impulse = 0;

function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

function KeyDown(b: KbuttonT): void {
  let k: number;
  let c = Cmd_Argv(1);
  if (c.length) k = atoi(c);
  else k = -1; // typed manually at the console for continuous down

  if (k === b.down[0] || k === b.down[1]) return; // repeating key

  if (!b.down[0]) b.down[0] = k;
  else if (!b.down[1]) b.down[1] = k;
  else {
    Com_Printf("Three keys down for a button!\n");
    return;
  }

  if (b.state & 1) return; // still down

  // save timestamp
  c = Cmd_Argv(2);
  b.downtime = atoi(c);
  if (!b.downtime) b.downtime = sys_frame_time - 100;

  b.state |= 1 + 2; // down + impulse down
}

function KeyUp(b: KbuttonT): void {
  let k: number;
  let c = Cmd_Argv(1);
  if (c.length) k = atoi(c);
  else {
    // typed manually at the console, assume for unsticking, so clear all
    b.down[0] = b.down[1] = 0;
    b.state = 4; // impulse up
    return;
  }

  if (b.down[0] === k) b.down[0] = 0;
  else if (b.down[1] === k) b.down[1] = 0;
  else return; // key up without coresponding down (menu pass through)
  if (b.down[0] || b.down[1]) return; // some other key is still holding it down

  if (!(b.state & 1)) return; // still up (this should not happen)

  // save timestamp
  c = Cmd_Argv(2);
  const uptime = atoi(c);
  if (uptime) b.msec += uptime - b.downtime;
  else b.msec += 10;

  b.state &= ~1; // now up
  b.state |= 4; // impulse up
}

function IN_KLookDown(): void {
  KeyDown(in_klook);
}
function IN_KLookUp(): void {
  KeyUp(in_klook);
}
function IN_UpDown(): void {
  KeyDown(in_up);
}
function IN_UpUp(): void {
  KeyUp(in_up);
}
function IN_DownDown(): void {
  KeyDown(in_down);
}
function IN_DownUp(): void {
  KeyUp(in_down);
}
function IN_LeftDown(): void {
  KeyDown(in_left);
}
function IN_LeftUp(): void {
  KeyUp(in_left);
}
function IN_RightDown(): void {
  KeyDown(in_right);
}
function IN_RightUp(): void {
  KeyUp(in_right);
}
function IN_ForwardDown(): void {
  KeyDown(in_forward);
}
function IN_ForwardUp(): void {
  KeyUp(in_forward);
}
function IN_BackDown(): void {
  KeyDown(in_back);
}
function IN_BackUp(): void {
  KeyUp(in_back);
}
function IN_LookupDown(): void {
  KeyDown(in_lookup);
}
function IN_LookupUp(): void {
  KeyUp(in_lookup);
}
function IN_LookdownDown(): void {
  KeyDown(in_lookdown);
}
function IN_LookdownUp(): void {
  KeyUp(in_lookdown);
}
function IN_MoveleftDown(): void {
  KeyDown(in_moveleft);
}
function IN_MoveleftUp(): void {
  KeyUp(in_moveleft);
}
function IN_MoverightDown(): void {
  KeyDown(in_moveright);
}
function IN_MoverightUp(): void {
  KeyUp(in_moveright);
}

function IN_SpeedDown(): void {
  KeyDown(in_speed);
}
function IN_SpeedUp(): void {
  KeyUp(in_speed);
}
function IN_StrafeDown(): void {
  KeyDown(in_strafe);
}
function IN_StrafeUp(): void {
  KeyUp(in_strafe);
}

function IN_AttackDown(): void {
  KeyDown(in_attack);
}
function IN_AttackUp(): void {
  KeyUp(in_attack);
}

function IN_UseDown(): void {
  KeyDown(in_use);
}
function IN_UseUp(): void {
  KeyUp(in_use);
}

function IN_Impulse(): void {
  in_impulse = atoi(Cmd_Argv(1));
}

/*
===============
CL_KeyState

Returns the fraction of the frame that the key was down
===============
*/
export function CL_KeyState(key: KbuttonT): number {
  key.state &= 1; // clear impulses

  let msec = key.msec;
  key.msec = 0;

  if (key.state) {
    // still down
    msec += sys_frame_time - key.downtime;
    key.downtime = sys_frame_time;
  }

  let val = msec / frame_msec;
  if (val < 0) val = 0;
  if (val > 1) val = 1;

  return val;
}

//==========================================================================

// cl_nodelta -- registered by CL_InitInput (cl_input.c) but not one of the
// cvars client.ts's clCvars holder anticipated (that holder only mirrors
// cl_main.c's CL_InitLocal registrations plus the four kbutton_t globals
// client.h externs); adding a field there is out of this brief's SCOPE, so
// this cl_input.c-private cvar is hosted here instead. Reported deviation.
export let cl_nodelta: CvarT | null = null;

/*
================
CL_AdjustAngles

Moves the local angle positions
================
*/
export function CL_AdjustAngles(): void {
  let speed: number;

  if (in_speed.state & 1) speed = cls.frametime * (clCvars.cl_anglespeedkey ? clCvars.cl_anglespeedkey.value : 0);
  else speed = cls.frametime;

  const yawspeed = clCvars.cl_yawspeed ? clCvars.cl_yawspeed.value : 0;
  const pitchspeed = clCvars.cl_pitchspeed ? clCvars.cl_pitchspeed.value : 0;

  if (!(in_strafe.state & 1)) {
    cl.viewangles[YAW] -= speed * yawspeed * CL_KeyState(in_right);
    cl.viewangles[YAW] += speed * yawspeed * CL_KeyState(in_left);
  }
  if (in_klook.state & 1) {
    cl.viewangles[PITCH] -= speed * pitchspeed * CL_KeyState(in_forward);
    cl.viewangles[PITCH] += speed * pitchspeed * CL_KeyState(in_back);
  }

  const up = CL_KeyState(in_lookup);
  const down = CL_KeyState(in_lookdown);

  cl.viewangles[PITCH] -= speed * pitchspeed * up;
  cl.viewangles[PITCH] += speed * pitchspeed * down;
}

/*
================
CL_BaseMove

Send the intended movement message to the server
================
*/
export function CL_BaseMove(cmd: UsercmdT): void {
  CL_AdjustAngles();

  cmd.msec = 0;
  cmd.buttons = 0;
  cmd.angles[0] = 0;
  cmd.angles[1] = 0;
  cmd.angles[2] = 0;
  cmd.forwardmove = 0;
  cmd.sidemove = 0;
  cmd.upmove = 0;
  cmd.impulse = 0;
  cmd.lightlevel = 0;

  // C's VectorCopy macro here is a plain per-component assignment that
  // truncates float degrees into cmd->angles' `short[3]` -- a throwaway
  // value CL_FinishMove immediately overwrites with the real ANGLE2SHORT
  // encoding, kept only for byte-for-byte parity with the original control
  // flow. cmd.angles is Int16Array (not Vec3/Float32Array), so this can't
  // go through the shared VectorCopy helper; assigned per-component instead.
  cmd.angles[0] = cl.viewangles[0];
  cmd.angles[1] = cl.viewangles[1];
  cmd.angles[2] = cl.viewangles[2];

  const sidespeed = clCvars.cl_sidespeed ? clCvars.cl_sidespeed.value : 0;
  const upspeed = clCvars.cl_upspeed ? clCvars.cl_upspeed.value : 0;
  const forwardspeed = clCvars.cl_forwardspeed ? clCvars.cl_forwardspeed.value : 0;

  if (in_strafe.state & 1) {
    cmd.sidemove += sidespeed * CL_KeyState(in_right);
    cmd.sidemove -= sidespeed * CL_KeyState(in_left);
  }

  cmd.sidemove += sidespeed * CL_KeyState(in_moveright);
  cmd.sidemove -= sidespeed * CL_KeyState(in_moveleft);

  cmd.upmove += upspeed * CL_KeyState(in_up);
  cmd.upmove -= upspeed * CL_KeyState(in_down);

  if (!(in_klook.state & 1)) {
    cmd.forwardmove += forwardspeed * CL_KeyState(in_forward);
    cmd.forwardmove -= forwardspeed * CL_KeyState(in_back);
  }

  //
  // adjust for speed key / running
  //
  const cl_run = clCvars.cl_run ? clCvars.cl_run.value : 0;
  if ((in_speed.state & 1) ^ (Math.trunc(cl_run) ? 1 : 0)) {
    cmd.forwardmove *= 2;
    cmd.sidemove *= 2;
    cmd.upmove *= 2;
  }
}

export function CL_ClampPitch(): void {
  let pitch = SHORT2ANGLE(cl.frame.playerstate.pmove.delta_angles[PITCH]);
  if (pitch > 180) pitch -= 360;

  if (cl.viewangles[PITCH] + pitch < -360) cl.viewangles[PITCH] += 360; // wrapped
  if (cl.viewangles[PITCH] + pitch > 360) cl.viewangles[PITCH] -= 360; // wrapped

  if (cl.viewangles[PITCH] + pitch > 89) cl.viewangles[PITCH] = 89 - pitch;
  if (cl.viewangles[PITCH] + pitch < -89) cl.viewangles[PITCH] = -89 - pitch;
}

const BUTTON_ATTACK = 1;
const BUTTON_USE = 2;
const BUTTON_ANY = 128;

/*
==============
CL_FinishMove
==============
*/
function CL_FinishMove(cmd: UsercmdT): void {
  //
  // figure button bits
  //
  if (in_attack.state & 3) cmd.buttons |= BUTTON_ATTACK;
  in_attack.state &= ~2;

  if (in_use.state & 3) cmd.buttons |= BUTTON_USE;
  in_use.state &= ~2;

  if (anykeydown && cls.key_dest === KeydestT.key_game) cmd.buttons |= BUTTON_ANY;

  // send milliseconds of time to apply the move
  let ms = Math.trunc(cls.frametime * 1000);
  if (ms > 250) ms = 100; // time was unreasonable
  cmd.msec = ms;

  CL_ClampPitch();
  for (let i = 0; i < 3; i++) cmd.angles[i] = ANGLE2SHORT(cl.viewangles[i]);

  cmd.impulse = in_impulse;
  in_impulse = 0;

  // send the ambient light level at the player's current position
  cmd.lightlevel = clCvars.cl_lightlevel ? clCvars.cl_lightlevel.value & 0xff : 0;
}

/*
=================
CL_CreateCmd
=================
*/
export function CL_CreateCmd(): UsercmdT {
  const cmd = new UsercmdT();

  frame_msec = sys_frame_time - old_sys_frame_time;
  if (frame_msec < 1) frame_msec = 1;
  if (frame_msec > 200) frame_msec = 200;

  // get basic movement from keyboard
  CL_BaseMove(cmd);

  // allow mice or other external controllers to add to the move
  IN_Move(cmd);

  CL_FinishMove(cmd);

  old_sys_frame_time = sys_frame_time;

  return cmd;
}

export function IN_CenterView(): void {
  cl.viewangles[PITCH] = -SHORT2ANGLE(cl.frame.playerstate.pmove.delta_angles[PITCH]);
}

/*
============
CL_InitInput
============
*/
export function CL_InitInput(): void {
  Cmd_AddCommand("centerview", IN_CenterView);

  Cmd_AddCommand("+moveup", IN_UpDown);
  Cmd_AddCommand("-moveup", IN_UpUp);
  Cmd_AddCommand("+movedown", IN_DownDown);
  Cmd_AddCommand("-movedown", IN_DownUp);
  Cmd_AddCommand("+left", IN_LeftDown);
  Cmd_AddCommand("-left", IN_LeftUp);
  Cmd_AddCommand("+right", IN_RightDown);
  Cmd_AddCommand("-right", IN_RightUp);
  Cmd_AddCommand("+forward", IN_ForwardDown);
  Cmd_AddCommand("-forward", IN_ForwardUp);
  Cmd_AddCommand("+back", IN_BackDown);
  Cmd_AddCommand("-back", IN_BackUp);
  Cmd_AddCommand("+lookup", IN_LookupDown);
  Cmd_AddCommand("-lookup", IN_LookupUp);
  Cmd_AddCommand("+lookdown", IN_LookdownDown);
  Cmd_AddCommand("-lookdown", IN_LookdownUp);
  Cmd_AddCommand("+strafe", IN_StrafeDown);
  Cmd_AddCommand("-strafe", IN_StrafeUp);
  Cmd_AddCommand("+moveleft", IN_MoveleftDown);
  Cmd_AddCommand("-moveleft", IN_MoveleftUp);
  Cmd_AddCommand("+moveright", IN_MoverightDown);
  Cmd_AddCommand("-moveright", IN_MoverightUp);
  Cmd_AddCommand("+speed", IN_SpeedDown);
  Cmd_AddCommand("-speed", IN_SpeedUp);
  Cmd_AddCommand("+attack", IN_AttackDown);
  Cmd_AddCommand("-attack", IN_AttackUp);
  Cmd_AddCommand("+use", IN_UseDown);
  Cmd_AddCommand("-use", IN_UseUp);
  Cmd_AddCommand("impulse", IN_Impulse);
  Cmd_AddCommand("+klook", IN_KLookDown);
  Cmd_AddCommand("-klook", IN_KLookUp);

  cl_nodelta = Cvar_Get("cl_nodelta", "0", 0);
}

/*
=================
CL_SendCmd
=================
*/
export function CL_SendCmd(): void {
  // build a command even if not connected

  // save this command off for prediction
  const backup = cl.cmds.length;
  let i = cls.netchan.outgoing_sequence & (backup - 1);
  cl.cmd_time[i] = cls.realtime; // for netgraph ping calculation

  const created = CL_CreateCmd();
  cl.cmds[i] = created;
  let cmd = created;

  cl.cmd = cmd;

  if (cls.state === ConnstateT.ca_disconnected || cls.state === ConnstateT.ca_connecting) return;

  if (cls.state === ConnstateT.ca_connected) {
    if (cls.netchan.message.cursize || cls.realtime - cls.netchan.last_sent > 1000) {
      Netchan_Transmit(cls.netchan, 0, new Uint8Array(0));
    }
    return;
  }

  // send a userinfo update if needed.
  if (userinfo_modified) {
    CL_FixUpGender();
    SetUserinfoModified(false);
    MSG_WriteByte(cls.netchan.message, ClcOpsT.clc_userinfo);
    MSG_WriteString(cls.netchan.message, Cvar_Userinfo());
  }

  const data = new Uint8Array(128);
  const buf = new SizeBuf();
  SZ_Init(buf, data, data.length);

  if (cmd.buttons && cl.cinematictime > 0 && !cl.attractloop && cls.realtime - cl.cinematictime > 1000) {
    // skip the rest of the cinematic
    SCR_FinishCinematic();
  }

  // begin a client move command
  MSG_WriteByte(buf, ClcOpsT.clc_move);

  // save the position for a checksum byte
  const checksumIndex = buf.cursize;
  MSG_WriteByte(buf, 0);

  // let the server know what the last frame we
  // got was, so the next message can be delta compressed
  if ((cl_nodelta && cl_nodelta.value) || !cl.frame.valid || cls.demowaiting) {
    MSG_WriteLong(buf, -1); // no compression
  } else {
    MSG_WriteLong(buf, cl.frame.serverframe);
  }

  // send this and the previous cmds in the message, so
  // if the last packet was dropped, it can be recovered
  i = (cls.netchan.outgoing_sequence - 2) & (backup - 1);
  let oldcmd = cl.cmds[i];
  const nullcmd = new UsercmdT();
  cls.codec.writeDeltaUsercmd(buf, nullcmd, oldcmd);

  i = (cls.netchan.outgoing_sequence - 1) & (backup - 1);
  cmd = cl.cmds[i];
  cls.codec.writeDeltaUsercmd(buf, oldcmd, cmd);
  oldcmd = cmd;

  i = cls.netchan.outgoing_sequence & (backup - 1);
  cmd = cl.cmds[i];
  cls.codec.writeDeltaUsercmd(buf, oldcmd, cmd);

  // calculate a checksum over the move commands
  buf.data[checksumIndex] = COM_BlockSequenceCRCByte(buf.data.subarray(checksumIndex + 1, buf.cursize), buf.cursize - checksumIndex - 1, cls.netchan.outgoing_sequence);

  //
  // deliver the message
  //
  Netchan_Transmit(cls.netchan, buf.cursize, buf.data);
}
