// cvar.c -- dynamic variable tracking
//
// cvar_vars is a Map<string, CvarT> keyed by name instead of the C singly
// linked list (`var->next = cvar_vars; cvar_vars = var;`, newest first). This
// changes the iteration order used by Cvar_GetLatchedVars/Cvar_WriteVariables/
// Cvar_List_f/Cvar_BitInfo from "newest cvar first" to "insertion order",
// which does not affect their behavior (every cvar is still visited exactly
// once) -- see PORTING.md's brief for this unit, which calls for a Map.

import { appendFileSync } from "node:fs";
import { CvarT, CVAR_ARCHIVE, CVAR_USERINFO, CVAR_SERVERINFO, CVAR_NOSET, CVAR_LATCH, Com_sprintf, Info_SetValueForKey } from "../shared/q_shared";
import { Com_Printf, Com_ServerState, CopyString } from "./common";
import { FS_SetGamedir, FS_ExecAutoexec } from "./files";
import { Cmd_AddCommand, Cmd_Argc, Cmd_Argv } from "./cmd";

export const cvar_vars = new Map<string, CvarT>();

function atof(s: string): number {
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function Cvar_InfoValidate(s: string): boolean {
  if (s.includes("\\")) return false;
  if (s.includes('"')) return false;
  if (s.includes(";")) return false;
  return true;
}

function Cvar_FindVar(var_name: string): CvarT | null {
  return cvar_vars.get(var_name) ?? null;
}

export function Cvar_VariableValue(var_name: string): number {
  const v = Cvar_FindVar(var_name);
  if (!v) return 0;
  return atof(v.string);
}

export function Cvar_VariableString(var_name: string): string {
  const v = Cvar_FindVar(var_name);
  if (!v) return "";
  return v.string;
}

export function Cvar_CompleteVariable(partial: string): string | null {
  if (!partial.length) return null;

  for (const cvar of cvar_vars.values()) {
    if (partial === cvar.name) return cvar.name;
  }

  for (const cvar of cvar_vars.values()) {
    if (cvar.name.startsWith(partial)) return cvar.name;
  }

  return null;
}

// If the variable already exists, the value will not be set.
// The flags will be or'ed in if the variable exists.
export function Cvar_Get(var_name: string, var_value: string | null, flags: number): CvarT | null {
  if (flags & (CVAR_USERINFO | CVAR_SERVERINFO)) {
    if (!Cvar_InfoValidate(var_name)) {
      Com_Printf("invalid info cvar name\n");
      return null;
    }
  }

  const existing = Cvar_FindVar(var_name);
  if (existing) {
    existing.flags |= flags;
    return existing;
  }

  if (var_value === null) return null;

  if (flags & (CVAR_USERINFO | CVAR_SERVERINFO)) {
    if (!Cvar_InfoValidate(var_value)) {
      Com_Printf("invalid info cvar value\n");
      return null;
    }
  }

  const v = new CvarT();
  v.name = CopyString(var_name);
  v.string = CopyString(var_value);
  v.modified = true;
  v.value = atof(v.string);
  v.flags = flags;

  cvar_vars.set(var_name, v);

  return v;
}

export function Cvar_Set2(var_name: string, value: string, force: boolean): CvarT | null {
  const existing = Cvar_FindVar(var_name);
  if (!existing) {
    // create it
    return Cvar_Get(var_name, value, 0);
  }

  if (existing.flags & (CVAR_USERINFO | CVAR_SERVERINFO)) {
    if (!Cvar_InfoValidate(value)) {
      Com_Printf("invalid info cvar value\n");
      return existing;
    }
  }

  if (!force) {
    if (existing.flags & CVAR_NOSET) {
      Com_Printf(`${var_name} is write protected.\n`);
      return existing;
    }

    if (existing.flags & CVAR_LATCH) {
      if (existing.latched_string !== null) {
        if (value === existing.latched_string) return existing;
        existing.latched_string = null;
      } else {
        if (value === existing.string) return existing;
      }

      if (Com_ServerState()) {
        Com_Printf(`${var_name} will be changed for next game.\n`);
        existing.latched_string = CopyString(value);
      } else {
        existing.string = CopyString(value);
        existing.value = atof(existing.string);
        if (existing.name === "game") {
          FS_SetGamedir(existing.string);
          FS_ExecAutoexec();
        }
      }
      return existing;
    }
  } else {
    if (existing.latched_string !== null) {
      existing.latched_string = null;
    }
  }

  if (value === existing.string) return existing; // not changed

  existing.modified = true;

  if (existing.flags & CVAR_USERINFO) userinfo_modified = true; // transmit at next oportunity

  existing.string = CopyString(value);
  existing.value = atof(existing.string);

  return existing;
}

export function Cvar_ForceSet(var_name: string, value: string): CvarT | null {
  return Cvar_Set2(var_name, value, true);
}

export function Cvar_Set(var_name: string, value: string): CvarT | null {
  return Cvar_Set2(var_name, value, false);
}

export function Cvar_FullSet(var_name: string, value: string, flags: number): CvarT | null {
  const existing = Cvar_FindVar(var_name);
  if (!existing) {
    // create it
    return Cvar_Get(var_name, value, flags);
  }

  existing.modified = true;

  if (existing.flags & CVAR_USERINFO) userinfo_modified = true; // transmit at next oportunity

  existing.string = CopyString(value);
  existing.value = atof(existing.string);
  existing.flags = flags;

  return existing;
}

export function Cvar_SetValue(var_name: string, value: number): void {
  let val: string;
  if (value === Math.trunc(value)) {
    val = Com_sprintf("%i", Math.trunc(value));
  } else {
    val = Com_sprintf("%f", value);
  }
  Cvar_Set(var_name, val);
}

// Any variables with latched values will now be updated
export function Cvar_GetLatchedVars(): void {
  for (const v of cvar_vars.values()) {
    if (v.latched_string === null) continue;
    v.string = v.latched_string;
    v.latched_string = null;
    v.value = atof(v.string);
    if (v.name === "game") {
      FS_SetGamedir(v.string);
      FS_ExecAutoexec();
    }
  }
}

// Handles variable inspection and changing from the console
export function Cvar_Command(): boolean {
  const v = Cvar_FindVar(Cmd_Argv(0));
  if (!v) return false;

  // perform a variable print or set
  if (Cmd_Argc() === 1) {
    Com_Printf(`"${v.name}" is "${v.string}"\n`);
    return true;
  }

  Cvar_Set(v.name, Cmd_Argv(1));
  return true;
}

// Allows setting and defining of arbitrary cvars from console
export function Cvar_Set_f(): void {
  const c = Cmd_Argc();
  if (c !== 3 && c !== 4) {
    Com_Printf("usage: set <variable> <value> [u / s]\n");
    return;
  }

  if (c === 4) {
    let flags: number;
    if (Cmd_Argv(3) === "u") flags = CVAR_USERINFO;
    else if (Cmd_Argv(3) === "s") flags = CVAR_SERVERINFO;
    else {
      Com_Printf("flags can only be 'u' or 's'\n");
      return;
    }
    Cvar_FullSet(Cmd_Argv(1), Cmd_Argv(2), flags);
  } else {
    Cvar_Set(Cmd_Argv(1), Cmd_Argv(2));
  }
}

// Appends lines containing "set variable value" for all variables
// with the archive flag set to true.
export function Cvar_WriteVariables(path: string): void {
  let out = "";
  for (const v of cvar_vars.values()) {
    if (v.flags & CVAR_ARCHIVE) {
      out += Com_sprintf('set %s "%s"\n', v.name, v.string);
    }
  }
  appendFileSync(path, out);
}

export function Cvar_List_f(): void {
  let i = 0;
  for (const v of cvar_vars.values()) {
    Com_Printf(v.flags & CVAR_ARCHIVE ? "*" : " ");
    Com_Printf(v.flags & CVAR_USERINFO ? "U" : " ");
    Com_Printf(v.flags & CVAR_SERVERINFO ? "S" : " ");
    if (v.flags & CVAR_NOSET) Com_Printf("-");
    else if (v.flags & CVAR_LATCH) Com_Printf("L");
    else Com_Printf(" ");
    Com_Printf(` %s "%s"\n`, v.name, v.string);
    i++;
  }
  Com_Printf("%i cvars\n", i);
}

// this is set each time a CVAR_USERINFO variable is changed
// so that the client knows to send it to the server
export let userinfo_modified = false;

// C clears this with a raw `userinfo_modified = false;` extern assignment
// at its two call sites (cl_main.c's CL_SendConnectPacket, cl_input.c's
// CL_SendCmd); `export let` bindings are read-only to importers, so those
// client-side call sites need a setter to do the same.
export function SetUserinfoModified(v: boolean): void {
  userinfo_modified = v;
}

export function Cvar_BitInfo(bit: number): string {
  let info = "";
  for (const v of cvar_vars.values()) {
    if (v.flags & bit) {
      info = Info_SetValueForKey(info, v.name, v.string);
    }
  }
  return info;
}

// returns an info string containing all the CVAR_USERINFO cvars
export function Cvar_Userinfo(): string {
  return Cvar_BitInfo(CVAR_USERINFO);
}

// returns an info string containing all the CVAR_SERVERINFO cvars
export function Cvar_Serverinfo(): string {
  return Cvar_BitInfo(CVAR_SERVERINFO);
}

// Reads in all archived cvars
export function Cvar_Init(): void {
  Cmd_AddCommand("set", Cvar_Set_f);
  Cmd_AddCommand("cvarlist", Cvar_List_f);
}
