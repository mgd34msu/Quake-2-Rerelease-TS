// p_menu.c / p_menu.h -- ctf's player menu framework (svc_layout driven)

import type { EdictT } from "./g_local";
import { gi, level, svc_layout } from "./g_local";

export const PMENU_ALIGN_LEFT = 0;
export const PMENU_ALIGN_CENTER = 1;
export const PMENU_ALIGN_RIGHT = 2;

export type SelectFuncT = (ent: EdictT, hnd: PmenuHndT) => void;

export class PmenuT {
  text: string | null = null;
  align = PMENU_ALIGN_LEFT;
  SelectFunc: SelectFuncT | null = null;

  constructor(text: string | null = null, align = PMENU_ALIGN_LEFT, SelectFunc: SelectFuncT | null = null) {
    this.text = text;
    this.align = align;
    this.SelectFunc = SelectFunc;
  }
}

export class PmenuHndT {
  entries: PmenuT[] = [];
  cur = -1;
  num = 0;
  // `void *arg` in C: freed on PMenu_Close. There is no manual allocator on
  // this side of the port (see PORTING.md's Z_Malloc/Z_TagMalloc ruling),
  // so `arg` is just dropped by the garbage collector when the handle is;
  // typed `unknown` the same way game.h's forward-declared pointers are.
  arg: unknown = null;
}

// Note that the pmenu entries are duplicated -- this is so that a static
// set of pmenu entries can be used for multiple clients and changed
// without interference. `arg` is freed when the menu is closed in C; here
// it is simply dropped for garbage collection.
export function PMenu_Open(
  ent: EdictT,
  entries: PmenuT[],
  cur: number,
  num: number,
  arg: unknown,
): PmenuHndT | null {
  const client = ent.client;
  if (client === null) return null;

  if (client.menu !== null) {
    gi.dprintf("warning, ent already has a menu\n");
    PMenu_Close(ent);
  }

  const hnd = new PmenuHndT();
  hnd.arg = arg;
  hnd.entries = [];
  for (let i = 0; i < num; i++) {
    const src = entries[i];
    const dst = new PmenuT();
    if (src !== undefined) {
      dst.text = src.text;
      dst.align = src.align;
      dst.SelectFunc = src.SelectFunc;
    }
    hnd.entries.push(dst);
  }
  hnd.num = num;

  let i: number;
  if (cur < 0 || entries[cur] === undefined || entries[cur].SelectFunc === null) {
    i = 0;
    for (; i < num; i++) {
      const p = entries[i];
      if (p !== undefined && p.SelectFunc !== null) break;
    }
  } else {
    i = cur;
  }

  hnd.cur = i >= num ? -1 : i;

  client.showscores = true;
  client.inmenu = true;
  client.menu = hnd;

  PMenu_Do_Update(ent);
  gi.unicast(ent, true);

  return hnd;
}

export function PMenu_Close(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;
  if (client.menu === null) return;

  client.menu = null;
  client.showscores = false;
}

// only use on pmenu's that have been called with PMenu_Open
export function PMenu_UpdateEntry(entry: PmenuT, text: string, align: number, SelectFunc: SelectFuncT | null): void {
  entry.text = text;
  entry.align = align;
  entry.SelectFunc = SelectFunc;
}

export function PMenu_Do_Update(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu === null) {
    gi.dprintf("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  let alt = false;
  let string = "xv 32 yv 8 picn inventory ";

  for (let i = 0; i < hnd.num; i++) {
    const p = hnd.entries[i];
    if (p === undefined) continue;
    if (p.text === null || p.text.length === 0) continue; // blank line
    let t = p.text;
    if (t.charAt(0) === "*") {
      alt = true;
      t = t.slice(1);
    }
    string += `yv ${32 + i * 8} `;

    let x: number;
    if (p.align === PMENU_ALIGN_CENTER) x = 196 / 2 - t.length * 4 + 64;
    else if (p.align === PMENU_ALIGN_RIGHT) x = 64 + (196 - t.length * 8);
    else x = 64;

    string += `xv ${x - (hnd.cur === i ? 8 : 0)} `;

    if (hnd.cur === i) string += `string2 "\x0d${t}" `;
    else if (alt) string += `string2 "${t}" `;
    else string += `string "${t}" `;
    alt = false;
  }

  gi.WriteByte(svc_layout);
  gi.WriteString(string);
}

export function PMenu_Update(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu === null) {
    gi.dprintf("warning:  ent has no menu\n");
    return;
  }

  if (level.time - client.menutime >= 1.0) {
    // been a second or more since last update, update now
    PMenu_Do_Update(ent);
    gi.unicast(ent, true);
    client.menutime = level.time;
    client.menudirty = false;
  }
  client.menutime = level.time + 0.2;
  client.menudirty = true;
}

export function PMenu_Next(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu === null) {
    gi.dprintf("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  if (hnd.cur < 0) return; // no selectable entries

  let i = hnd.cur;
  do {
    i++;
    if (i === hnd.num) i = 0;
    const p = hnd.entries[i];
    if (p !== undefined && p.SelectFunc !== null) break;
  } while (i !== hnd.cur);

  hnd.cur = i;

  PMenu_Update(ent);
}

export function PMenu_Prev(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu === null) {
    gi.dprintf("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  if (hnd.cur < 0) return; // no selectable entries

  let i = hnd.cur;
  do {
    if (i === 0) {
      i = hnd.num - 1;
    } else {
      i--;
    }
    const p = hnd.entries[i];
    if (p !== undefined && p.SelectFunc !== null) break;
  } while (i !== hnd.cur);

  hnd.cur = i;

  PMenu_Update(ent);
}

export function PMenu_Select(ent: EdictT): void {
  const client = ent.client;
  if (client === null) return;

  if (client.menu === null) {
    gi.dprintf("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  if (hnd.cur < 0) return; // no selectable entries

  const p = hnd.entries[hnd.cur];
  if (p !== undefined && p.SelectFunc !== null) p.SelectFunc(ent, hnd);
}
