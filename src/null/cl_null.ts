// cl_null.c -- this file can stub out the entire client system
// for pure dedicated servers

import { Com_Printf } from "../qcommon/common";
import { Cmd_AddCommand, Cmd_Argv } from "../qcommon/cmd";

export function Key_Bind_Null_f(): void {}

export function CL_Init(): void {}

export function CL_Drop(): void {}

export function CL_Shutdown(): void {}

export function CL_Frame(_msec: number): void {}

export function Con_Print(_text: string): void {}

export function Cmd_ForwardToServer(): void {
  const cmd = Cmd_Argv(0);
  Com_Printf('Unknown command "%s"\n', cmd);
}

export function SCR_DebugGraph(_value: number, _color: number): void {}

export function SCR_BeginLoadingPlaque(): void {}

export function SCR_EndLoadingPlaque(): void {}

export function Key_Init(): void {
  Cmd_AddCommand("bind", Key_Bind_Null_f);
}
