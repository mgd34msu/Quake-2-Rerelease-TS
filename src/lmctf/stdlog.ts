// Ports lmctf60/stdlog.c + stdlog.h -- the low-level StdLog file writer:
// opens a single append-mode log file (gated by the `stdlogfile` cvar,
// named by `stdlogname`, default "StdLog.log") and formats one
// tab-separated line per event through a "log style" dispatch table.
//
// STATUS: complete. Every public sl_Log*/sl_OpenLogFile/sl_CloseLogFile
// function is ported, plus the private `_sl_Log*`/`_sl_MaybeOpenFile`/
// `_sl_MaybeCloseFile`/`_sl_SetStyle` helpers and the `_sl_LogStyles[]`
// dispatch table (length 1 in the C source -- `uiLogstyle` is clamped back
// to 0 whenever the `stdlogstyle` cvar names an out-of-range style, and
// since there is only ever one style, that clamp always resolves to the
// same function; the table is still ported as a real array-of-styles
// structure, not collapsed to a direct call, so a future second style
// slots in the same way the C source's would).
//
// File I/O goes through src/qcommon/files.ts's FS_FOpenFileWrite/FS_Write/
// FS_FCloseFile (the sanctioned FS seam, same as g_save.ts and g_skins.ts
// -- checked before writing this file), NOT gi.TagMalloc+fopen the way the
// C source does it. One deliberate, documented behavior difference: the C
// source opens the log file in "a+t" (append) mode, so log lines from a
// PREVIOUS server process survive a restart; FS_FOpenFileWrite only opens
// in truncate ("w") mode -- there is no append-open primitive in this
// port's FS seam. Within a single continuous server process this makes no
// observable difference (the handle is opened once and kept open for the
// whole session, exactly like the C source), but a log file from an
// earlier run will be overwritten on the next `stdlogfile 1` server start
// instead of accumulating. Flagged here since it's the one place this
// port's sanctioned FS channel can't reproduce the original's file mode.

import { CVAR_SERVERINFO, type CvarT } from "../shared/q_shared";
import { Match_CanScore } from "./g_tourney";
import { gi } from "./g_local";
import { FS_FCloseFile, FS_FOpenFileWrite, FS_Write } from "../qcommon/files";

interface LogFuncs {
  pLogVers: () => void;
  pLogPatch: (pPatchName: string | null) => void;
  pLogDate: () => void;
  pLogTime: () => void;
  pLogDeathFlags: (dmFlags: number) => void;
  pLogMapName: (pMapName: string) => void;
  pLogPlayerName: (pPlayerName: string, pTeamName: string | null, timeInSeconds: number) => void;
  pLogScore: (
    pKillerName: string | null,
    pTargetName: string | null,
    pScoreType: string | null,
    pWeaponName: string | null,
    iScore: number,
    timeInSeconds: number,
  ) => void;
  pLogPlayerLeft: (pPlayerName: string, timeInSeconds: number) => void;
  pLogGameStart: (timeInSeconds: number) => void;
  pLogGameEnd: (timeInSeconds: number) => void;
  pLogPlayerConnect: (pPlayerName: string, pTeamName: string | null, timeInSeconds: number) => void;
  pLogPlayerTeamChange: (pPlayerName: string, pTeamName: string | null, timeInSeconds: number) => void;
  pLogPlayerRename: (pOldPlayerName: string, pNewPlayerName: string, timeInSeconds: number) => void;
}

// stdlog.c:23-24: `MAX_DATE_STRLEN`/`MAX_TIME_STRLEN` sized the C source's
// fixed `char date[...]`/`char time[...]` stack buffers; not needed here
// since JS strings aren't length-capped, so not ported as constants.

let logfile: CvarT | null = null;
let logstyle: CvarT | null = null;
let StdLogHandle: number | null = null;
let uiLogstyle = 0;

function writeLine(text: string): void {
  if (StdLogHandle === null) return;
  const buf = new TextEncoder().encode(text);
  FS_Write(buf, buf.length, StdLogHandle);
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/*
=================
_sl_LogVers .. _sl_LogPlayerRename (stdlog.c:142-303)

Each formats one tab-prefixed line and writes it to the open log file.
`%.1f` is replicated with `toFixed(1)`.
=================
*/
function _sl_LogVers(): void {
  writeLine("\t\tStdLog\t1.2\n");
}

function _sl_LogPatch(pPatchName: string | null): void {
  writeLine(pPatchName !== null ? `\t\tPatchName\t${pPatchName}\n` : "\t\tPatchName\t\n");
}

function _sl_LogDate(): void {
  const now = new Date();
  const date = `${pad2(now.getDate())} ${MONTH_NAMES[now.getMonth()]} ${now.getFullYear()}`;
  writeLine(`\t\tLogDate\t${date}\n`);
}

function _sl_LogTime(): void {
  const now = new Date();
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  writeLine(`\t\tLogTime\t${time}\n`);
}

function _sl_LogDeathFlags(dmFlags: number): void {
  writeLine(`\t\tLogDeathFlags\t${dmFlags}\n`);
}

function _sl_LogMapName(pMapName: string): void {
  writeLine(`\t\tMap\t${pMapName}\n`);
}

function _sl_LogPlayerName(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (pTeamName !== null) {
    writeLine(`\t\tPlayer\t${pPlayerName}\t${pTeamName}\t${timeInSeconds.toFixed(1)}\n`);
  } else {
    writeLine(`\t\tPlayer\t${pPlayerName}\t\t${timeInSeconds.toFixed(1)}\n`);
  }
}

function _sl_LogScore(
  pKillerName: string | null,
  pTargetName: string | null,
  pScoreType: string | null,
  pWeaponName: string | null,
  iScore: number,
  timeInSeconds: number,
): void {
  let line = "";
  // Killer Name
  if (pKillerName !== null) line += pKillerName;
  line += "\t";

  // Target Name
  if (pTargetName !== null) line += pTargetName;
  line += "\t";

  // Score Type
  if (pScoreType !== null) line += pScoreType;
  line += "\t";

  // Weapon Name
  if (pWeaponName !== null) line += pWeaponName;
  line += "\t";

  // Score & Time
  line += `${iScore}\t${timeInSeconds.toFixed(1)}\n`;

  writeLine(line);
}

function _sl_LogPlayerLeft(pPlayerName: string, timeInSeconds: number): void {
  writeLine(`\t\tPlayerLeft\t${pPlayerName}\t\t${timeInSeconds.toFixed(1)}\n`);
}

function _sl_LogGameStart(timeInSeconds: number): void {
  writeLine(`\t\tGameStart\t\t\t${timeInSeconds.toFixed(1)}\n`);
}

function _sl_LogGameEnd(timeInSeconds: number): void {
  writeLine(`\t\tGameEnd\t\t\t${timeInSeconds.toFixed(1)}\n`);
}

function _sl_LogPlayerConnect(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (pTeamName !== null) {
    writeLine(`\t\tPlayerConnect\t${pPlayerName}\t${pTeamName}\t${timeInSeconds.toFixed(1)}\n`);
  } else {
    writeLine(`\t\tPlayerConnect\t${pPlayerName}\t\t${timeInSeconds.toFixed(1)}\n`);
  }
}

function _sl_LogPlayerTeamChange(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (pTeamName !== null) {
    writeLine(`\t\tPlayerTeamChange\t${pPlayerName}\t${pTeamName}\t${timeInSeconds.toFixed(1)}\n`);
  } else {
    writeLine(`\t\tPlayerTeamChange\t${pPlayerName}\t\t${timeInSeconds.toFixed(1)}\n`);
  }
}

function _sl_LogPlayerRename(pOldPlayerName: string, pNewPlayerName: string, timeInSeconds: number): void {
  writeLine(`\t\tPlayerRename\t${pOldPlayerName}\t${pNewPlayerName}\t${timeInSeconds.toFixed(1)}\n`);
}

// stdlog.c:114-132: `static LOG_FUNCS _sl_LogStyles[] = { { ... } };`
const _sl_LogStyles: LogFuncs[] = [
  {
    pLogVers: _sl_LogVers,
    pLogPatch: _sl_LogPatch,
    pLogDate: _sl_LogDate,
    pLogTime: _sl_LogTime,
    pLogDeathFlags: _sl_LogDeathFlags,
    pLogMapName: _sl_LogMapName,
    pLogPlayerName: _sl_LogPlayerName,
    pLogScore: _sl_LogScore,
    pLogPlayerLeft: _sl_LogPlayerLeft,
    pLogGameStart: _sl_LogGameStart,
    pLogGameEnd: _sl_LogGameEnd,
    pLogPlayerConnect: _sl_LogPlayerConnect,
    pLogPlayerTeamChange: _sl_LogPlayerTeamChange,
    pLogPlayerRename: _sl_LogPlayerRename,
  },
];

/*
=================
_sl_MaybeOpenFile (stdlog.c:306)
=================
*/
function _sl_MaybeOpenFile(): boolean {
  if (logfile === null) {
    logfile = gi.cvar("stdlogfile", "0", CVAR_SERVERINFO);
  }

  if (logfile !== null && logfile.value !== 0) {
    if (StdLogHandle === null) {
      const filename = gi.cvar("stdlogname", "StdLog.log", CVAR_SERVERINFO);
      const pName = filename !== null ? filename.string : "StdLog.log";

      StdLogHandle = FS_FOpenFileWrite(pName);

      if (StdLogHandle === null) {
        gi.error(`Couldn't open ${pName}`);
      }
    }
  }

  return StdLogHandle !== null;
}

/*
=================
_sl_MaybeCloseFile (stdlog.c:334)
=================
*/
function _sl_MaybeCloseFile(): void {
  if (logfile !== null && StdLogHandle !== null) {
    // LM_JORM -- was "if ( NULL != logfile)"
    FS_FCloseFile(StdLogHandle);
  }

  StdLogHandle = null;
  logfile = null;
  logstyle = null;
  uiLogstyle = 0;
}

/*
=================
_sl_SetStyle (stdlog.c:347)
=================
*/
function _sl_SetStyle(): void {
  if (logstyle === null) {
    logstyle = gi.cvar("stdlogstyle", "0", CVAR_SERVERINFO);
    if (logstyle !== null) {
      uiLogstyle = logstyle.value | 0;
      if (uiLogstyle >= _sl_LogStyles.length) uiLogstyle = 0;
    }
  }
}

function currentStyle(): LogFuncs {
  const style = _sl_LogStyles[uiLogstyle];
  if (style === undefined) {
    throw new Error("stdlog: uiLogstyle out of range (unreachable given _sl_SetStyle's clamp)");
  }
  return style;
}

/*
=================
sl_OpenLogFile / sl_CloseLogFile (stdlog.c:368-376)
=================
*/
export function sl_OpenLogFile(): boolean {
  return _sl_MaybeOpenFile();
}

export function sl_CloseLogFile(): void {
  _sl_MaybeCloseFile();
}

export function sl_LogVers(): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogVers();
  }
}

export function sl_LogPatch(pPatchName: string | null): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPatch(pPatchName);
  }
}

export function sl_LogDate(): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogDate();
  }
}

export function sl_LogTime(): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogTime();
  }
}

export function sl_LogDeathFlags(dmFlags: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogDeathFlags(dmFlags);
  }
}

export function sl_LogMapName(pMapName: string): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogMapName(pMapName);
  }
}

export function sl_LogPlayerName(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPlayerName(pPlayerName, pTeamName, timeInSeconds);
  }
}

/*
=================
sl_LogScore (stdlog.c:449)

`qboolean Match_CanScore();` -- forward-declared in the C source with NO
parameters even though g_tourney.c's real Match_CanScore takes none
either, so this isn't actually a signature mismatch; imported for real
from g_tourney.ts (already ported by the foundation).
=================
*/
export function sl_LogScore(
  pKillerName: string | null,
  pTargetName: string | null,
  pScoreType: string | null,
  pWeaponName: string | null,
  iScore: number,
  timeInSeconds: number,
): void {
  if (!Match_CanScore()) return;

  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogScore(pKillerName, pTargetName, pScoreType, pWeaponName, iScore, timeInSeconds);
  }
}

export function sl_LogPlayerLeft(pPlayerName: string, timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPlayerLeft(pPlayerName, timeInSeconds);
  }
}

export function sl_LogGameStart(timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogGameStart(timeInSeconds);
  }
}

export function sl_LogGameEnd(timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogGameEnd(timeInSeconds);
  }
}

export function sl_LogPlayerConnect(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPlayerConnect(pPlayerName, pTeamName, timeInSeconds);
  }
}

export function sl_LogPlayerTeamChange(pPlayerName: string, pTeamName: string | null, timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPlayerTeamChange(pPlayerName, pTeamName, timeInSeconds);
  }
}

export function sl_LogPlayerRename(pOldPlayerName: string, pNewPlayerName: string, timeInSeconds: number): void {
  if (_sl_MaybeOpenFile()) {
    _sl_SetStyle();
    currentStyle().pLogPlayerRename(pOldPlayerName, pNewPlayerName, timeInSeconds);
  }
}
