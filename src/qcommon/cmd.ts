// cmd.c -- Quake script command processing module
//
// cmd_alias (a singly linked list in C) and cmd_functions become
// Map<string, ...> keyed by name, same insertion-order-not-C-order caveat as
// cvar.ts's cvar_vars (see that file's header comment).

import { SizeBuf, SZ_Init, SZ_Write, SZ_Clear, stringToBytes } from "./sizebuf";
import { Com_Printf, Com_Error, COM_Argc, COM_Argv, COM_ClearArgv } from "./common";
import { ERR_FATAL, EXEC_NOW, EXEC_INSERT, EXEC_APPEND } from "./qcommon";
import { Cvar_VariableString, Cvar_Command } from "./cvar";
import { COM_Parse, type ComParseState } from "../shared/math";
import { va, Q_strcasecmp, MAX_STRING_CHARS, MAX_STRING_TOKENS } from "../shared/q_shared";
import { FS_LoadFile, FS_FreeFile } from "./files";

function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

//=============================================================================
// Causes execution of the remainder of the command buffer to be delayed until
// next frame. This allows commands like:
// bind g "impulse 5 ; +attack ; wait ; -attack ; impulse 2"

let cmd_wait = false;

export function Cmd_Wait_f(): void {
  cmd_wait = true;
}

//=============================================================================
// COMMAND BUFFER

const MAX_ALIAS_NAME = 32;
const ALIAS_LOOP_COUNT = 16; // for detecting runaway loops

const cmd_text = new SizeBuf();
let deferText = ""; // defer_text_buf

let alias_count = 0; // for detecting runaway loops

export function Cbuf_Init(): void {
  SZ_Init(cmd_text, new Uint8Array(8192), 8192);
}

// Adds command text at the end of the buffer
export function Cbuf_AddText(text: string): void {
  if (cmd_text.cursize + text.length >= cmd_text.maxsize) {
    Com_Printf("Cbuf_AddText: overflow\n");
    return;
  }
  SZ_Write(cmd_text, stringToBytes(text), text.length);
}

// Adds command text immediately after the current command
// FIXME: actually change the command buffer to do less copying
export function Cbuf_InsertText(text: string): void {
  // copy off any commands still remaining in the exec buffer
  const templen = cmd_text.cursize;
  let temp: Uint8Array | null = null;
  if (templen) {
    temp = cmd_text.data.slice(0, templen);
    SZ_Clear(cmd_text);
  }

  // add the entire text of the file
  Cbuf_AddText(text);

  // add the copied off data
  if (templen && temp) {
    SZ_Write(cmd_text, temp, templen);
  }
}

export function Cbuf_CopyToDefer(): void {
  deferText = bytesToString(cmd_text.data.subarray(0, cmd_text.cursize));
  cmd_text.cursize = 0;
}

export function Cbuf_InsertFromDefer(): void {
  Cbuf_InsertText(deferText);
  deferText = "";
}

export function Cbuf_ExecuteText(exec_when: number, text: string): void {
  switch (exec_when) {
    case EXEC_NOW:
      Cmd_ExecuteString(text);
      break;
    case EXEC_INSERT:
      Cbuf_InsertText(text);
      break;
    case EXEC_APPEND:
      Cbuf_AddText(text);
      break;
    default:
      Com_Error(ERR_FATAL, "Cbuf_ExecuteText: bad exec_when");
  }
}

export function Cbuf_Execute(): void {
  alias_count = 0; // don't allow infinite alias loops

  while (cmd_text.cursize) {
    // find a \n or ; line break
    const text = cmd_text.data;

    let quotes = 0;
    let i = 0;
    for (; i < cmd_text.cursize; i++) {
      if (text[i] === 34 /* '"' */) quotes++;
      if (!(quotes & 1) && text[i] === 59 /* ';' */) break; // don't break if inside a quoted string
      if (text[i] === 10 /* '\n' */) break;
    }

    const line = bytesToString(text.subarray(0, i));

    // delete the text from the command buffer and move remaining commands down
    // this is necessary because commands (exec, alias) can insert data at the
    // beginning of the text buffer
    if (i === cmd_text.cursize) {
      cmd_text.cursize = 0;
    } else {
      i++;
      cmd_text.cursize -= i;
      cmd_text.data.copyWithin(0, i, i + cmd_text.cursize);
    }

    // execute the command line
    Cmd_ExecuteString(line);

    if (cmd_wait) {
      // skip out while text still remains in buffer, leaving it for next frame
      cmd_wait = false;
      break;
    }
  }
}

// Adds command line parameters as script statements
// Commands lead with a +, and continue until another +
//
// Set commands are added early, so they are guaranteed to be set before
// the client and server initialize for the first time.
//
// Other commands are added late, after all initialization is complete.
export function Cbuf_AddEarlyCommands(clear: boolean): void {
  for (let i = 0; i < COM_Argc(); i++) {
    const s = COM_Argv(i);
    if (s !== "+set") continue;
    Cbuf_AddText(va("set %s %s\n", COM_Argv(i + 1), COM_Argv(i + 2)));
    if (clear) {
      COM_ClearArgv(i);
      COM_ClearArgv(i + 1);
      COM_ClearArgv(i + 2);
    }
    i += 2;
  }
}

// Adds command line parameters as script statements
// Commands lead with a + and continue until another + or -
// quake +vid_ref gl +map amlev1
//
// Returns true if any late commands were added, which
// will keep the demoloop from immediately starting
export function Cbuf_AddLateCommands(): boolean {
  const argc = COM_Argc();
  if (argc <= 1) return false;

  let text = "";
  for (let i = 1; i < argc; i++) {
    text += COM_Argv(i);
    if (i !== argc - 1) text += " ";
  }

  // pull out the commands
  let build = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "+") {
      i++;
      let j = i;
      while (j < text.length && text[j] !== "+" && text[j] !== "-") j++;

      build += text.slice(i, j);
      build += "\n";
      i = j - 1;
    }
  }

  const ret = build.length !== 0;
  if (ret) Cbuf_AddText(build);

  return ret;
}

//==============================================================================
// SCRIPT COMMANDS

export function Cmd_Exec_f(): void {
  if (Cmd_Argc() !== 2) {
    Com_Printf("exec <filename> : execute a script file\n");
    return;
  }

  const f = FS_LoadFile(Cmd_Argv(1));
  if (!f) {
    Com_Printf(`couldn't exec ${Cmd_Argv(1)}\n`);
    return;
  }
  Com_Printf(`execing ${Cmd_Argv(1)}\n`);

  // the file doesn't have a trailing 0 in C; JS strings need no such thing
  const text = bytesToString(f);
  Cbuf_InsertText(text);

  FS_FreeFile(f);
}

// Just prints the rest of the line to the console
export function Cmd_Echo_f(): void {
  for (let i = 1; i < Cmd_Argc(); i++) {
    Com_Printf(`${Cmd_Argv(i)} `);
  }
  Com_Printf("\n");
}

// Creates a new command that executes a command string (possibly ; seperated)
const cmd_alias = new Map<string, string>();

export function Cmd_Alias_f(): void {
  if (Cmd_Argc() === 1) {
    Com_Printf("Current alias commands:\n");
    for (const [name, value] of cmd_alias) {
      Com_Printf(`${name} : ${value}\n`);
    }
    return;
  }

  const s = Cmd_Argv(1);
  if (s.length >= MAX_ALIAS_NAME) {
    Com_Printf("Alias name is too long\n");
    return;
  }

  // copy the rest of the command line
  let cmd = "";
  const c = Cmd_Argc();
  for (let i = 2; i < c; i++) {
    cmd += Cmd_Argv(i);
    if (i !== c - 1) cmd += " ";
  }
  cmd += "\n";

  cmd_alias.set(s, cmd);
}

//=============================================================================
// COMMAND EXECUTION

let cmd_argc = 0;
let cmd_argv: string[] = [];
let cmd_args = "";

const cmd_functions = new Map<string, (() => void) | null>();

export function Cmd_Argc(): number {
  return cmd_argc;
}

export function Cmd_Argv(arg: number): string {
  if (arg < 0 || arg >= cmd_argc) return "";
  return cmd_argv[arg] ?? "";
}

// Returns a single string containing argv(1) to argv(argc()-1)
export function Cmd_Args(): string {
  return cmd_args;
}

function charCodeAtState(state: ComParseState): number {
  return state.index < state.data.length ? state.data.charCodeAt(state.index) : 0;
}

export function Cmd_MacroExpandString(text: string): string | null {
  let inquote = false;
  let scan = text;

  let len = scan.length;
  if (len >= MAX_STRING_CHARS) {
    Com_Printf(`Line exceeded ${MAX_STRING_CHARS} chars, discarded.\n`);
    return null;
  }

  let count = 0;

  for (let i = 0; i < len; i++) {
    if (scan[i] === '"') inquote = !inquote;
    if (inquote) continue; // don't expand inside quotes
    if (scan[i] !== "$") continue;

    // scan out the complete macro
    const state: ComParseState = { data: scan, index: i + 1 };
    const startIndex = state.index;
    const token = COM_Parse(state);

    // COM_Parse's C original sets *data_p = NULL (nothing left to parse) when
    // the scan hits end-of-string before finding anything; our COM_Parse
    // signals the same case by returning "" without having just closed a
    // quote (an empty *quoted* token, e.g. macro text "$\"\"", is the only
    // other way to get "" back, told apart by the preceding '"').
    const closedEmptyQuote = state.index > startIndex && scan.charAt(state.index - 1) === '"';
    if (token === "" && !closedEmptyQuote) continue;

    const value = Cvar_VariableString(token);

    const j = value.length;
    len += j;
    if (len >= MAX_STRING_CHARS) {
      Com_Printf(`Expanded line exceeded ${MAX_STRING_CHARS} chars, discarded.\n`);
      return null;
    }

    scan = scan.slice(0, i) + value + scan.slice(state.index);
    i--;

    count++;
    if (count === 100) {
      Com_Printf("Macro expansion loop, discarded.\n");
      return null;
    }
  }

  if (inquote) {
    Com_Printf("Line has unmatched quote, discarded.\n");
    return null;
  }

  return scan;
}

// Parses the given string into command line tokens.
// $Cvars will be expanded unless they are in a quoted token
export function Cmd_TokenizeString(rawText: string, macroExpand: boolean): void {
  // clear the args from the last string
  cmd_argc = 0;
  cmd_argv = [];
  cmd_args = "";

  // macro expand the text
  const text = macroExpand ? Cmd_MacroExpandString(rawText) : rawText;
  if (text === null) return;

  const state: ComParseState = { data: text, index: 0 };

  for (;;) {
    // skip whitespace up to a \n
    for (;;) {
      const c = charCodeAtState(state);
      if (c !== 0 && c <= 32 && c !== 10) state.index++;
      else break;
    }

    if (charCodeAtState(state) === 10 /* '\n' */) {
      // a newline seperates commands in the buffer
      state.index++;
      break;
    }

    if (charCodeAtState(state) === 0) return;

    // set cmd_args to everything after the first arg
    if (cmd_argc === 1) {
      let args = state.data.slice(state.index);
      // strip off any trailing whitespace
      let l = args.length - 1;
      for (; l >= 0; l--) {
        if (args.charCodeAt(l) <= 32) continue;
        break;
      }
      cmd_args = args.slice(0, l + 1);
    }

    const startIdx = state.index;
    const comToken = COM_Parse(state);
    // C's COM_Parse NULLs the data pointer when it finds no token (comment
    // to end-of-data, e.g. a `// ...` line in default.cfg), and C's
    // Cmd_TokenizeString returns on that instead of pushing an empty argv.
    // A legitimately quoted empty token ("") also returns "", but consumed a
    // quote character; discriminate on that.
    if (comToken === "" && state.index >= state.data.length && !state.data.slice(startIdx).includes('"')) {
      return;
    }

    if (cmd_argc < MAX_STRING_TOKENS) {
      cmd_argv[cmd_argc] = comToken;
      cmd_argc++;
    }
  }
}

// called by the init functions of other parts of the program to
// register commands and functions to call for them.
// if function is null, the command will be forwarded to the server
// as a clc_stringcmd instead of executed locally
export function Cmd_AddCommand(cmd_name: string, fn: (() => void) | null): void {
  // fail if the command is a variable name
  if (Cvar_VariableString(cmd_name).length > 0) {
    Com_Printf(`Cmd_AddCommand: ${cmd_name} already defined as a var\n`);
    return;
  }

  // fail if the command already exists
  if (cmd_functions.has(cmd_name)) {
    Com_Printf(`Cmd_AddCommand: ${cmd_name} already defined\n`);
    return;
  }

  cmd_functions.set(cmd_name, fn);
}

export function Cmd_RemoveCommand(cmd_name: string): void {
  if (!cmd_functions.has(cmd_name)) {
    Com_Printf(`Cmd_RemoveCommand: ${cmd_name} not added\n`);
    return;
  }
  cmd_functions.delete(cmd_name);
}

// used by the cvar code to check for cvar / command name overlap
export function Cmd_Exists(cmd_name: string): boolean {
  return cmd_functions.has(cmd_name);
}

// attempts to match a partial command for automatic command line completion
export function Cmd_CompleteCommand(partial: string): string | null {
  if (!partial.length) return null;

  // check for exact match
  for (const name of cmd_functions.keys()) {
    if (name === partial) return name;
  }
  for (const name of cmd_alias.keys()) {
    if (name === partial) return name;
  }

  // check for partial match
  for (const name of cmd_functions.keys()) {
    if (name.startsWith(partial)) return name;
  }
  for (const name of cmd_alias.keys()) {
    if (name.startsWith(partial)) return name;
  }

  return null;
}

// Cmd_ForwardToServer has no body in cmd.c -- it is forward-declared there
// and implemented in cl_main.c, which has not been ported yet. Modeled as a
// registrable hook (defaulting to a no-op) rather than a PendingPort stub,
// since FORBIDDEN restricts pending-throw stubs to files.ts/pending.ts.
// Owning module: src/client/cl_main.ts.
export let cmdForwardToServerHandler: (() => void) | null = null;

export function setCmdForwardToServerHandler(fn: (() => void) | null): void {
  cmdForwardToServerHandler = fn;
}

function Cmd_ForwardToServer(): void {
  if (cmdForwardToServerHandler) cmdForwardToServerHandler();
}

// A complete command line has been parsed, so try to execute it
// FIXME: lookupnoadd the token to speed search?
export function Cmd_ExecuteString(text: string): void {
  Cmd_TokenizeString(text, true);

  // execute the command line
  if (!Cmd_Argc()) return; // no tokens

  const name0 = Cmd_Argv(0);

  // check functions
  for (const [name, fn] of cmd_functions) {
    if (Q_strcasecmp(name0, name) === 0) {
      if (!fn) {
        // forward to server command
        Cmd_ExecuteString(va("cmd %s", text));
      } else {
        fn();
      }
      return;
    }
  }

  // check alias
  for (const [name, value] of cmd_alias) {
    if (Q_strcasecmp(name0, name) === 0) {
      alias_count++;
      if (alias_count === ALIAS_LOOP_COUNT) {
        Com_Printf("ALIAS_LOOP_COUNT\n");
        return;
      }
      Cbuf_InsertText(value);
      return;
    }
  }

  // check cvars
  if (Cvar_Command()) return;

  // send it as a server command if we are connected
  Cmd_ForwardToServer();
}

export function Cmd_List_f(): void {
  let i = 0;
  for (const name of cmd_functions.keys()) {
    Com_Printf(`${name}\n`);
    i++;
  }
  Com_Printf(`${i} commands\n`);
}

export function Cmd_Init(): void {
  // register our commands
  Cmd_AddCommand("cmdlist", Cmd_List_f);
  Cmd_AddCommand("exec", Cmd_Exec_f);
  Cmd_AddCommand("echo", Cmd_Echo_f);
  Cmd_AddCommand("alias", Cmd_Alias_f);
  Cmd_AddCommand("wait", Cmd_Wait_f);
}
