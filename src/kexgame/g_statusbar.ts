// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// g_statusbar.h (62 lines, 2023 Quake II re-release / "KEX" engine),
// ~/Projects/quake2-rerelease-dll/rerelease/g_statusbar.h: `statusbar_t`, a
// tiny fluent string builder over a `std::stringstream` used by p_hud's
// `G_InitStatusbar()` (g_spawn.cpp:1281-1406, not yet ported) to build the
// `CS_STATUSBAR` layout-language configstring. Method names are kept
// EXACTLY as declared; every method's emitted text (including the trailing
// space after every token, and the quoting rule for `string`/`string2`/
// `loc_rstring`) is preserved verbatim -- HUD layout parsing on the client
// consumes these strings token-by-token, so spacing is load-bearing.
//
// ============================================================================
// DEVIATIONS
// ============================================================================
// - `std::stringstream sb` (the class's own internal accumulator, itself
//   also named `sb` -- a real, if confusing, name collision with the
//   OUTER `statusbar_t sb;` variable every call site declares, per
//   g_spawn.cpp:1284/1406's own `sb.sb.str()`) collapses to a private plain
//   string field; nothing in TS needs a stream object to build one string.
//   The extraction method keeps the same NAME as C++'s `std::stringstream`
//   (`.str()`), so a future call site reads as `sb.str()` -- one `.sb` less
//   than the C++ `sb.sb.str()`, since there is no separate nested stream
//   object left to name.
// - Every method takes `auto &*this` by reference and returns `*this` in
//   C++ (`inline auto &xv(...) { ...; return *this; }`); TS has no
//   reference-returning "return *this", so each method mutates the private
//   buffer and returns `this` -- the same fluent-chaining result, just
//   named `this` instead of a dereferenced pointer.
// - `player_stat_t` (the `stat` parameter's real type) is declared in
//   bg_local.h:196, not g_statusbar.h itself, and has not been ported
//   anywhere in this port line yet (grepped src/kexapi/ and src/kexgame/
//   for `player_stat_t`/`PlayerStatT`: zero matches). Per PORTING.md's "the
//   brief's placement wins; report the mismatch, don't move it" precedent,
//   this file does not invent that enum -- every `stat`/`icon` parameter
//   below is typed `number`, exactly what the builder needs (it only ever
//   interpolates the numeric stat index into the output string; nothing
//   here branches on which stat it is).

/**
 * g_statusbar.h: `struct statusbar_t`. Every method appends one
 * space-terminated token to the layout string and returns `this` for
 * chaining, e.g. `new StatusbarT().yb(-24).xv(0).hnum().str()`.
 */
export class StatusbarT {
  private buf = "";

  /** statusbar_t::yb(offset) -- `"yb " << offset << ' '` */
  yb(offset: number): this {
    this.buf += `yb ${offset} `;
    return this;
  }

  /** statusbar_t::yt(offset) -- `"yt " << offset << ' '` */
  yt(offset: number): this {
    this.buf += `yt ${offset} `;
    return this;
  }

  /** statusbar_t::yv(offset) -- `"yv " << offset << ' '` */
  yv(offset: number): this {
    this.buf += `yv ${offset} `;
    return this;
  }

  /** statusbar_t::xl(offset) -- `"xl " << offset << ' '` */
  xl(offset: number): this {
    this.buf += `xl ${offset} `;
    return this;
  }

  /** statusbar_t::xr(offset) -- `"xr " << offset << ' '` */
  xr(offset: number): this {
    this.buf += `xr ${offset} `;
    return this;
  }

  /** statusbar_t::xv(offset) -- `"xv " << offset << ' '` */
  xv(offset: number): this {
    this.buf += `xv ${offset} `;
    return this;
  }

  /** statusbar_t::ifstat(stat) -- `"if " << stat << ' '` */
  ifstat(stat: number): this {
    this.buf += `if ${stat} `;
    return this;
  }

  /** statusbar_t::endifstat() -- `"endif "` */
  endifstat(): this {
    this.buf += "endif ";
    return this;
  }

  /** statusbar_t::pic(stat) -- `"pic " << stat << ' '` */
  pic(stat: number): this {
    this.buf += `pic ${stat} `;
    return this;
  }

  /** statusbar_t::picn(icon) -- `"picn " << icon << ' '` */
  picn(icon: string): this {
    this.buf += `picn ${icon} `;
    return this;
  }

  /** statusbar_t::anum() -- `"anum "` */
  anum(): this {
    this.buf += "anum ";
    return this;
  }

  /** statusbar_t::rnum() -- `"rnum "` */
  rnum(): this {
    this.buf += "rnum ";
    return this;
  }

  /** statusbar_t::hnum() -- `"hnum "` */
  hnum(): this {
    this.buf += "hnum ";
    return this;
  }

  /** statusbar_t::num(width, stat) -- `"num " << width << ' ' << stat << ' '` */
  num(width: number, stat: number): this {
    this.buf += `num ${width} ${stat} `;
    return this;
  }

  /** statusbar_t::loc_stat_string(stat) -- `"loc_stat_string " << stat << ' '` */
  loc_stat_string(stat: number): this {
    this.buf += `loc_stat_string ${stat} `;
    return this;
  }

  /** statusbar_t::loc_stat_rstring(stat) -- `"loc_stat_rstring " << stat << ' '` */
  loc_stat_rstring(stat: number): this {
    this.buf += `loc_stat_rstring ${stat} `;
    return this;
  }

  /** statusbar_t::stat_string(stat) -- `"stat_string " << stat << ' '` */
  stat_string(stat: number): this {
    this.buf += `stat_string ${stat} `;
    return this;
  }

  /** statusbar_t::loc_stat_cstring2(stat) -- `"loc_stat_cstring2 " << stat << ' '` */
  loc_stat_cstring2(stat: number): this {
    this.buf += `loc_stat_cstring2 ${stat} `;
    return this;
  }

  /**
   * statusbar_t::string2(str) -- quotes `str` iff it doesn't already start
   * with `"` AND contains a space or newline:
   *   `if (str[0] != '"' && (strchr(str, ' ') || strchr(str, '\n')))
   *      sb << "string2 \"" << str << "\" ";
   *    else
   *      sb << "string2 " << str << ' ';`
   */
  string2(str: string): this {
    this.buf += needsQuoting(str) ? `string2 "${str}" ` : `string2 ${str} `;
    return this;
  }

  /** statusbar_t::string(str) -- same quoting rule as string2(), "string" token. */
  string(str: string): this {
    this.buf += needsQuoting(str) ? `string "${str}" ` : `string ${str} `;
    return this;
  }

  /**
   * statusbar_t::loc_rstring(str) -- same quoting rule as string2()/string(),
   * with a fixed `0` (arg count) inserted after the token name:
   *   `if (...) sb << "loc_rstring 0 \"" << str << "\" ";
   *    else sb << "loc_rstring 0 " << str << ' ';`
   */
  loc_rstring(str: string): this {
    this.buf += needsQuoting(str) ? `loc_rstring 0 "${str}" ` : `loc_rstring 0 ${str} `;
    return this;
  }

  /** statusbar_t::lives_num(stat) -- `"lives_num " << stat << ' '` */
  lives_num(stat: number): this {
    this.buf += `lives_num ${stat} `;
    return this;
  }

  /** statusbar_t::stat_pname(stat) -- `"stat_pname " << stat << ' '` */
  stat_pname(stat: number): this {
    this.buf += `stat_pname ${stat} `;
    return this;
  }

  /** statusbar_t::health_bars() -- `"health_bars "` */
  health_bars(): this {
    this.buf += "health_bars ";
    return this;
  }

  /** statusbar_t::story() -- `"story "` */
  story(): this {
    this.buf += "story ";
    return this;
  }

  /**
   * `std::stringstream::str()` -- returns the accumulated layout string.
   * See file header: this replaces the C++ call sites' `sb.sb.str()`.
   */
  str(): string {
    return this.buf;
  }
}

/** `str[0] != '"' && (strchr(str, ' ') || strchr(str, '\n'))` -- see the
 *  string()/string2()/loc_rstring() doc comments above. */
function needsQuoting(str: string): boolean {
  return str[0] !== '"' && (str.includes(" ") || str.includes("\n"));
}
