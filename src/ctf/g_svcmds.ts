// g_svcmds.c
//
// 3.21 restores the packet-filtering subsystem that this ctf fork had
// dropped in 3.19 (matching base game's src/game/g_svcmds.ts, which never
// dropped it). File-I/O: files.ts exports FS_WriteFile alongside its read
// primitives, so SVCmd_WriteIP_f's C fopen(...,"wb")/fprintf/fclose sequence
// writes the real file below. This does cross straight into
// qcommon/files.ts rather than going through the GameImports (`gi`)
// boundary PORTING.md otherwise keeps between game and engine code -- the
// same is true of the C original, which calls fopen()/fprintf() directly
// from the game DLL rather than through any game_import_t entry point, so a
// direct files.ts import here is the faithful equivalent, not a boundary
// violation.

import { Com_sprintf, PRINT_HIGH, Q_stricmp } from "../shared/q_shared";
import { FS_WriteFile } from "../qcommon/files";
import { GAMEVERSION, gameCvars, gi } from "./g_local";

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
=================
*/
export function SVCmd_WriteIP_f(): void {
  const gameCvar = gi.cvar("game", "", 0);

  const name = !gameCvar || gameCvar.string.length === 0 ? `${GAMEVERSION}/listip.cfg` : `${gameCvar.string}/listip.cfg`;

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
ServerCommand

ServerCommand will be called when an "sv" command is issued.
The game can issue gi.argc() / gi.argv() commands to get the rest
of the parameters
=================
*/
export function Svcmd_Test_f(): void {
  gi.cprintf(null, PRINT_HIGH, "Svcmd_Test_f()\n");
}

export function ServerCommand(): void {
  const cmd = gi.argv(1);
  if (Q_stricmp(cmd, "test") === 0) Svcmd_Test_f();
  else if (Q_stricmp(cmd, "addip") === 0) SVCmd_AddIP_f();
  else if (Q_stricmp(cmd, "removeip") === 0) SVCmd_RemoveIP_f();
  else if (Q_stricmp(cmd, "listip") === 0) SVCmd_ListIP_f();
  else if (Q_stricmp(cmd, "writeip") === 0) SVCmd_WriteIP_f();
  else gi.cprintf(null, PRINT_HIGH, `Unknown server command "${cmd}"\n`);
}
