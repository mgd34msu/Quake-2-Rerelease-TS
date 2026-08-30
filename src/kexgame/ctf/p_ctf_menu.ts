// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// ctf/p_ctf_menu.c -- the generic in-game "PMenu" text-menu widget (2023
// Quake II re-release / "KEX" engine). Ported from
// ~/Projects/quake2-rerelease-dll/rerelease/ctf/p_ctf_menu.cpp (283 lines,
// C++17) + ctf/p_ctf_menu.h (41 lines): PMenu_Open/PMenu_Close/
// PMenu_UpdateEntry/PMenu_Do_Update/PMenu_Update/PMenu_Next/PMenu_Prev/
// PMenu_Select. This is a tiny, self-contained state machine over
// `GClientT.menu` (a `PmenuhndT | null`, already typed in g_local_types.ts)
// -- every menu ARRAY (join menu, admin menu, ...) is owned by ./g_ctf.ts,
// the module that actually builds and opens them.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `PMenu_Open`'s C++ signature takes `void *arg` (freed via `gi.TagFree`
//   when the menu closes) and `pmenuhnd_t::arg: void *`. This port line
//   already types `PmenuhndT.arg: unknown` (g_local_types.ts) with no
//   `gi.TagMalloc`/`gi.TagFree` equivalent needed (JS garbage collection
//   handles it) -- `PMenu_Close` below simply drops the reference instead of
//   calling `gi.TagFree`.
// - `pmenu_t.text`/`text_arg1` are fixed `char[64]` buffers in C++
//   (`Q_strlcpy`'d, silently truncating anything longer); TS strings have no
//   such limit. `PMenu_Open`/`PMenu_UpdateEntry` copy the string verbatim
//   with no truncation -- an intentional widening, not a bug, since nothing
//   in this port line enforces the 64-byte HUD layout budget elsewhere
//   either (see g_ctf.ts's own `MAX_CTF_STAT_LENGTH` precedent for the one
//   place that budget IS enforced).
// - `PMenu_Do_Update`'s `#include "../g_statusbar.h"` + `statusbar_t sb;
//   sb.xv(32).yv(8).picn("inventory");` prefix is built here with the
//   already-ported `StatusbarT` class (g_statusbar.ts) for that fixed
//   prefix; the per-entry `sb.sb << ...` raw stream concatenation that
//   follows (loc_string/loc_cstring/loc_rstring token selection, the `'2'`
//   highlight suffix, the cursor `">"` marker) has no `StatusbarT` method to
//   call (that class only exposes named tokens, not raw `<<`), so it is
//   built with plain string concatenation instead, replicating the exact
//   same token stream and spacing.
//
// ============================================================================
// SAVE REGISTRY -- N/A
// ============================================================================
// Nothing in this file is a think/touch/die/use callback; `PmenuhndT`/
// `PmenuT` are plain client-side UI state, not scheduled game entities, so
// there is nothing to register with g_save_registry.ts here.

import type { PmenuhndT, PmenuT, SelectFuncT, UpdateFuncT } from "../g_local";
import type { EdictT } from "../g_local";
import { gi, level } from "../g_main_globals";
import { Gtime_add, Gtime_from_sec, Gtime_subtract } from "../gtime";
import { ServerCommandT } from "../../kexapi/game";
import { StatusbarT } from "../g_statusbar";
import { GetUnicastKey } from "../g_weapon";

/** ctf/p_ctf_menu.h:4-9 anonymous `enum { PMENU_ALIGN_LEFT, PMENU_ALIGN_CENTER, PMENU_ALIGN_RIGHT };`. */
export const PMENU_ALIGN_LEFT = 0;
export const PMENU_ALIGN_CENTER = 1;
export const PMENU_ALIGN_RIGHT = 2;

/**
 * ctf/p_ctf_menu.cpp:9-61: `pmenuhnd_t *PMenu_Open(edict_t *ent, const
 * pmenu_t *entries, int cur, int num, void *arg, UpdateFunc_t UpdateFunc)`.
 * Note that the pmenu entries are duplicated -- this is so that a static set
 * of pmenu entries can be used for multiple clients and changed without
 * interference.
 */
export function PMenu_Open(ent: EdictT, entries: readonly PmenuT[], cur: number, num: number, arg: unknown, UpdateFunc: UpdateFuncT | null): PmenuhndT | null {
  const client = ent.client;
  if (client === null) return null;

  if (client.menu !== null) {
    gi.Com_Print("warning, ent already has a menu\n");
    PMenu_Close(ent);
  }

  // duplicate the entries (and their strings, though TS strings are already
  // immutable value copies -- see file header) so a static source array can
  // be reused across clients without interference.
  const dupedEntries: PmenuT[] = [];
  for (let i = 0; i < num; i++) {
    const src = entries[i];
    if (src === undefined) break;
    dupedEntries.push({ text: src.text, align: src.align, SelectFunc: src.SelectFunc, text_arg1: src.text_arg1 });
  }

  let curIndex: number;
  if (cur < 0 || dupedEntries[cur] === undefined || dupedEntries[cur]!.SelectFunc === null) {
    curIndex = num; // sentinel: "not found yet"
    for (let i = 0; i < num; i++) {
      const p = dupedEntries[i];
      if (p !== undefined && p.SelectFunc !== null) {
        curIndex = i;
        break;
      }
    }
  } else {
    curIndex = cur;
  }

  const hnd: PmenuhndT = {
    entries: dupedEntries,
    cur: curIndex >= num ? -1 : curIndex,
    num,
    arg,
    UpdateFunc,
  };

  client.showscores = true;
  client.inmenu = true;
  client.menu = hnd;

  if (UpdateFunc !== null) UpdateFunc(ent);

  PMenu_Do_Update(ent);
  gi.unicast(ent, true, GetUnicastKey());

  return hnd;
}

/** ctf/p_ctf_menu.cpp:63-77: `void PMenu_Close(edict_t *ent)`. */
export function PMenu_Close(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) return;

  client.menu = null;
  client.showscores = false;
}

/**
 * ctf/p_ctf_menu.cpp:80-85: `void PMenu_UpdateEntry(pmenu_t *entry, const
 * char *text, int align, SelectFunc_t SelectFunc)`. Only use on pmenu's that
 * have been called with PMenu_Open.
 */
export function PMenu_UpdateEntry(entry: PmenuT, text: string, align: number, SelectFunc: SelectFuncT | null): void {
  entry.text = text;
  entry.align = align;
  entry.SelectFunc = SelectFunc;
}

/** ctf/p_ctf_menu.cpp:89-163: `void PMenu_Do_Update(edict_t *ent)`. */
export function PMenu_Do_Update(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) {
    gi.Com_Print("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;

  if (hnd.UpdateFunc !== null) hnd.UpdateFunc(ent);

  const sb = new StatusbarT();
  sb.xv(32).yv(8).picn("inventory");

  let out = sb.str();
  let alt = false;

  for (let i = 0; i < hnd.num; i++) {
    const p = hnd.entries[i];
    if (p === undefined) continue;
    if (!p.text) continue; // blank line

    let t = p.text;

    if (t.startsWith("*")) {
      alt = true;
      t = t.slice(1);
    }

    out += `yv ${32 + i * 8} `;

    let loc_func = "loc_string";
    let x: number;

    if (p.align === PMENU_ALIGN_CENTER) {
      x = 0;
      loc_func = "loc_cstring";
    } else if (p.align === PMENU_ALIGN_RIGHT) {
      x = 260;
      loc_func = "loc_rstring";
    } else {
      x = 64;
    }

    out += `xv ${x} `;

    out += loc_func;

    if (hnd.cur === i || alt) out += "2";

    out += ` 1 "${t}" "${p.text_arg1}" `;

    if (hnd.cur === i) {
      out += `xv 56 `;
      out += `string2 ">" `;
    }

    alt = false;
  }

  gi.WriteByte(ServerCommandT.svc_layout);
  gi.WriteString(out);
}

/** ctf/p_ctf_menu.cpp:165-183: `void PMenu_Update(edict_t *ent)`. */
export function PMenu_Update(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) {
    gi.Com_Print("warning:  ent has no menu\n");
    return;
  }

  if (Gtime_subtract(level.time, client.menutime) >= Gtime_from_sec(1)) {
    // been a second or more since last update, update now
    PMenu_Do_Update(ent);
    gi.unicast(ent, true, GetUnicastKey());
    client.menutime = Gtime_add(level.time, Gtime_from_sec(1));
    client.menudirty = false;
  }
  client.menutime = level.time;
  client.menudirty = true;
}

/** ctf/p_ctf_menu.cpp:185-220: `void PMenu_Next(edict_t *ent)`. */
export function PMenu_Next(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) {
    gi.Com_Print("warning:  ent has no menu\n");
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

/** ctf/p_ctf_menu.cpp:222-260: `void PMenu_Prev(edict_t *ent)`. */
export function PMenu_Prev(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) {
    gi.Com_Print("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  if (hnd.cur < 0) return; // no selectable entries

  let i = hnd.cur;
  do {
    if (i === 0) i = hnd.num - 1;
    else i--;
    const p = hnd.entries[i];
    if (p !== undefined && p.SelectFunc !== null) break;
  } while (i !== hnd.cur);

  hnd.cur = i;

  PMenu_Update(ent);
}

/** ctf/p_ctf_menu.cpp:262-282: `void PMenu_Select(edict_t *ent)`. */
export function PMenu_Select(ent: EdictT): void {
  const client = ent.client;
  if (client === null || client.menu === null) {
    gi.Com_Print("warning:  ent has no menu\n");
    return;
  }

  const hnd = client.menu;
  if (hnd.cur < 0) return; // no selectable entries

  const p = hnd.entries[hnd.cur];
  if (p !== undefined && p.SelectFunc !== null) p.SelectFunc(ent, hnd);
}
