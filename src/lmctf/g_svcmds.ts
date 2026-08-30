// g_svcmds.c
//
// LM_CTF's g_svcmds.c is almost a total rewrite versus the ctf ancestor
// (322 lines vs ctf's 48): ctf's own file only carries Svcmd_Test_f and a
// trivial ServerCommand dispatch. lmctf60 adds Svcmd_NextLevel_f (the
// "next"/"skip" sv commands), a full packet-filter/IP-ban admin subsystem
// (ipfilters/StringToFilter/SV_FilterPacket/SVCmd_AddIP_f/RemoveIP_f/
// ListIP_f/WriteIP_f), and SVCmd_QuadTime_f. src/ctf/g_svcmds.ts (ported
// from a later 3.21 baseq2 g_svcmds.c that independently re-added the same
// packet-filter subsystem ctf's own 3.19-based ancestor had dropped) is
// used below only as a style skeleton for that subsystem, not diffed
// against -- its filter/parsing logic is line-for-line identical to
// lmctf60's, so it is reused verbatim except where lmctf60 genuinely
// differs (see SVCmd_WriteIP_f below: lmctf60 reads the `gamedir` cvar,
// src/ctf/g_svcmds.ts's ancestor read `game` instead).
//
// File-I/O: files.ts exports FS_WriteFile alongside its read primitives,
// so SVCmd_WriteIP_f's C fopen(...,"wb")/fprintf/fclose sequence writes
// the real file below. This does cross straight into qcommon/files.ts
// rather than going through the GameImports (`gi`) boundary PORTING.md
// otherwise keeps between game and engine code -- the same is true of the
// C original, which calls fopen()/fprintf() directly from the game DLL
// rather than through any game_import_t entry point, so a direct files.ts
// import here is the faithful equivalent, not a boundary violation.

import { Com_sprintf, PRINT_HIGH, Q_stricmp } from "../shared/q_shared";
import { FS_WriteFile } from "../qcommon/files";
import { gameCvars, gi } from "./g_local";
import { ctf_BSafePrint } from "./g_ctffunc";
import { FindItem } from "./g_items";

// g_tourney.ts is a partial port (matchstate/pause query functions only,
// per its own file header) being completed by another unit in this
// concurrent effort; EndDMLevel is not yet exported there. Resolved
// lazily per PORTING.md's import-cycle rule / src/lmctf/g_target.ts's
// precedent (gSpawnMod/pHudMod), so this file's own load order doesn't
// have to wait on g_tourney.ts's completion.
//
// g_target.ts's precedent casts require()'s result straight to
// `typeof <Module>`, but that only type-checks when every referenced
// export genuinely exists on the target module. EndDMLevel does not exist
// on g_tourney.ts's current export surface (confirmed via grep before
// writing this file), so `typeof GTourneyModule` would make `.EndDMLevel`
// a compile error, not the runtime gap the brief calls for. This narrower,
// explicitly-optional shape lets the property genuinely be missing right
// now (checked below, throwing a documented error) while still resolving
// correctly with zero changes here once another unit adds the export.
interface GTourneyModuleShape {
  EndDMLevel?: () => void;
}
function gTourneyMod(): GTourneyModuleShape {
  return require("./g_tourney") as GTourneyModuleShape;
}

export function Svcmd_Test_f(): void {
  gi.cprintf(null, PRINT_HIGH, "Svcmd_Test_f()\n");
}

export function Svcmd_NextLevel_f(): void {
  const endDMLevel = gTourneyMod().EndDMLevel;
  if (endDMLevel === undefined) {
    throw new Error(
      "Svcmd_NextLevel_f: EndDMLevel (lmctf60/g_tourney.c) is not yet exported by g_tourney.ts -- that module currently ports only matchstate/pause query functions per its own file header",
    );
  }
  endDMLevel();
  gi.dprintf("Skipping to next level\n");
}

/*
==============================================================================

PACKET FILTERING


You can add or remove addresses from the filter list with:

addip <ip>
removeip <ip>

The ip address is specified in dot format, and any unspecified digits will match any value, so you can specify an entire class C network with "addip 192.246.40".

Removeip will only remove an address specified exactly the same way.  You cannot addip a subnet, then removeip a single host.

listip
Prints the current list of filters.

writeip
Dumps "addip <ip>" commands to listip.cfg so it can be execed at a later date.  The filter lists are not saved and restored by default, because I beleive it would cause too much confusion.

filterban <0 or 1>

If 1 (the default), then ip addresses matching the current list will be prohibited from entering the game.  This is the default setting.

If 0, then only addresses matching the list will be allowed.  This lets you easily set up a private game, or a game that only allows players from your local network.


==============================================================================
*/

interface IpFilterT {
  mask: number;
  compare: number;
}

const MAX_IPFILTERS = 1024;

// file-scope statics in g_svcmds.c (`ipfilter_t ipfilters[MAX_IPFILTERS]`,
// `int numipfilters`). Wrapped in a singleton with clear() per PORTING.md's
// "shared mutable globals... C code that memsets them calls their clear()"
// idiom -- the C code itself never resets this array at runtime, but tests
// need isolation between cases, so clear() is provided for that purpose.
class IpFilterListT {
  filters: IpFilterT[] = [];

  clear(): void {
    this.filters = [];
  }
}

export const ipFilterList = new IpFilterListT();

/*
=================
StringToFilter
=================
*/
// static in C; exported here so the packing math can be unit tested directly.
export function StringToFilter(s: string): { ok: boolean; mask: number; compare: number } {
  const b = [0, 0, 0, 0];
  const m = [0, 0, 0, 0];
  let pos = 0;

  for (let i = 0; i < 4; i++) {
    if (pos >= s.length || s[pos] < "0" || s[pos] > "9") {
      gi.cprintf(null, PRINT_HIGH, `Bad filter address: ${s}\n`);
      return { ok: false, mask: 0, compare: 0 };
    }

    let num = "";
    while (pos < s.length && s[pos] >= "0" && s[pos] <= "9") {
      num += s[pos];
      pos++;
    }
    b[i] = Number.parseInt(num, 10) & 0xff;
    if (b[i] !== 0) m[i] = 255;

    if (pos >= s.length) break;
    pos++;
  }

  const mask = (m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0;
  const compare = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;

  return { ok: true, mask, compare };
}

/*
=================
SV_FilterPacket
=================
*/
export function SV_FilterPacket(from: string): boolean {
  const m = [0, 0, 0, 0];
  let i = 0;
  let p = 0;

  while (p < from.length && i < 4) {
    m[i] = 0;
    while (p < from.length && from[p] >= "0" && from[p] <= "9") {
      m[i] = (m[i] * 10 + (from.charCodeAt(p) - 48)) & 0xff;
      p++;
    }
    if (p >= from.length || from[p] === ":") break;
    i++;
    p++;
  }

  const inAddr = (m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0;

  const filterban = gameCvars.filterban === null ? 0 : gameCvars.filterban.value;

  for (let j = 0; j < ipFilterList.filters.length; j++) {
    const f = ipFilterList.filters[j];
    if ((inAddr & f.mask) >>> 0 === f.compare) return Math.trunc(filterban) !== 0;
  }

  return filterban === 0;
}

/*
=================
SVCmd_AddIP_f
=================
*/
export function SVCmd_AddIP_f(): void {
  if (gi.argc() < 3) {
    gi.cprintf(null, PRINT_HIGH, "Usage:  addip <ip-mask>\n");
    return;
  }

  let i = ipFilterList.filters.findIndex((f) => f.compare === 0xffffffff);
  if (i === -1) {
    if (ipFilterList.filters.length === MAX_IPFILTERS) {
      gi.cprintf(null, PRINT_HIGH, "IP filter list is full\n");
      return;
    }
    i = ipFilterList.filters.length;
    ipFilterList.filters.push({ mask: 0, compare: 0 });
  }

  const parsed = StringToFilter(gi.argv(2));
  if (!parsed.ok) {
    ipFilterList.filters[i].compare = 0xffffffff;
  } else {
    ipFilterList.filters[i].mask = parsed.mask;
    ipFilterList.filters[i].compare = parsed.compare;
  }
}

/*
=================
SVCmd_RemoveIP_f
=================
*/
export function SVCmd_RemoveIP_f(): void {
  if (gi.argc() < 3) {
    gi.cprintf(null, PRINT_HIGH, "Usage:  sv removeip <ip-mask>\n");
    return;
  }

  const f = StringToFilter(gi.argv(2));
  if (!f.ok) return;

  const i = ipFilterList.filters.findIndex((e) => e.mask === f.mask && e.compare === f.compare);
  if (i !== -1) {
    ipFilterList.filters.splice(i, 1);
    gi.cprintf(null, PRINT_HIGH, "Removed.\n");
    return;
  }
  gi.cprintf(null, PRINT_HIGH, `Didn't find ${gi.argv(2)}.\n`);
}

/*
=================
SVCmd_ListIP_f
=================
*/
export function SVCmd_ListIP_f(): void {
  gi.cprintf(null, PRINT_HIGH, "Filter list:\n");
  for (const f of ipFilterList.filters) {
    const b0 = f.compare & 0xff;
    const b1 = (f.compare >>> 8) & 0xff;
    const b2 = (f.compare >>> 16) & 0xff;
    const b3 = (f.compare >>> 24) & 0xff;
    gi.cprintf(null, PRINT_HIGH, `${Com_sprintf("%3i.%3i.%3i.%3i", b0, b1, b2, b3)}\n`);
  }
}

/*
=================
SVCmd_WriteIP_f

lmctf60 builds the target path from the `gamedir` cvar (`if (gamedir->string
&& gamedir->string[0]) sprintf(name, "./%s/listip.cfg", gamedir->string);
else sprintf(name, "./listip.cfg");`). g_local.ts's gameCvars holder does not
carry `gamedir` (it is one of the LM_CTF-only cvars g_local.ts's own header
comment says are added by whichever unit ports the cvar that gates them),
so it is read directly here the same one-off way other ungated cvars are
read elsewhere in this family -- see g_target.ts's `cvarNum` helper for the
general idiom of reading a `CvarT | null` inline; `gamedir` is a string
cvar so its `.string` field is read directly instead.
=================
*/
export function SVCmd_WriteIP_f(): void {
  const gamedirCvar = gi.cvar("gamedir", "", 0);

  const name = gamedirCvar !== null && gamedirCvar.string.length > 0 ? `./${gamedirCvar.string}/listip.cfg` : "./listip.cfg";

  gi.cprintf(null, PRINT_HIGH, `Writing ${name}.\n`);

  const filterbanValue = gameCvars.filterban === null ? 0 : Math.trunc(gameCvars.filterban.value);

  let text = `set filterban ${filterbanValue}\n`;
  for (const f of ipFilterList.filters) {
    const b0 = f.compare & 0xff;
    const b1 = (f.compare >>> 8) & 0xff;
    const b2 = (f.compare >>> 16) & 0xff;
    const b3 = (f.compare >>> 24) & 0xff;
    text += `sv addip ${b0}.${b1}.${b2}.${b3}\n`;
  }

  FS_WriteFile(name, text);
}

/*
=================
SVCmd_QuadTime_f

C: `unsigned long i=0; ... if (!sscanf(gi.argv(2), "%lu", &i)) { usage; return; }`
sscanf's "%lu" skips leading whitespace, accepts an optional sign, then
digits, and returns 0 items assigned (falsy) when nothing numeric is
found. ParseUnsignedLongArg below mirrors that success/failure split; the
`>>> 0` on the parsed value mirrors storing the parsed number into an
unsigned long.
=================
*/
function ParseUnsignedLongArg(s: string): { ok: boolean; value: number } {
  const m = /^\s*([+-]?\d+)/.exec(s);
  if (m === null) return { ok: false, value: 0 };
  return { ok: true, value: Number.parseInt(m[1], 10) >>> 0 };
}

export function SVCmd_QuadTime_f(): void {
  if (gi.argc() < 3) {
    gi.cprintf(null, PRINT_HIGH, "Usage:  sv quadtime <seconds>\n");
    return;
  }

  const parsed = ParseUnsignedLongArg(gi.argv(2));
  if (!parsed.ok) {
    gi.cprintf(null, PRINT_HIGH, "Usage: sv quadtime <seconds>\n");
    return;
  }
  const i = parsed.value;

  const target = FindItem("Quad Damage");
  if (target !== null && i > 0 && i < 1200) {
    target.quantity = i;
    ctf_BSafePrint(PRINT_HIGH, `Quad respawn updated to ${i}\n`);
  }
}

/*
=================
ServerCommand

ServerCommand will be called when an "sv" command is issued.
The game can issue gi.argc() / gi.argv() commands to get the rest
of the parameters
=================
*/
export function ServerCommand(): void {
  const cmd = gi.argv(1);
  if (Q_stricmp(cmd, "test") === 0) Svcmd_Test_f();
  else if (Q_stricmp(cmd, "addip") === 0) SVCmd_AddIP_f();
  else if (Q_stricmp(cmd, "removeip") === 0) SVCmd_RemoveIP_f();
  else if (Q_stricmp(cmd, "listip") === 0) SVCmd_ListIP_f();
  else if (Q_stricmp(cmd, "writeip") === 0) SVCmd_WriteIP_f();
  else if (Q_stricmp(cmd, "quadtime") === 0) SVCmd_QuadTime_f();
  else if (Q_stricmp(cmd, "next") === 0 || Q_stricmp(cmd, "skip") === 0) Svcmd_NextLevel_f();
  else gi.cprintf(null, PRINT_HIGH, `Unknown server command "${cmd}"\n`);
}
