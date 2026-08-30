// [Paril-KEX] kfont format -- q2repro's src/refresh/draw.c
// (SCR_LoadKFont/SCR_KFontLookup/draw_kfont_char) and inc/refresh/refresh.h
// (kfont_t/kfont_char_t/KFONT_ASCII_MIN/KFONT_ASCII_MAX). This is NOT a port
// of anything in the original id Quake II source -- kfont is a Paril-KEX/
// q2repro rerelease-only asset format with no vanilla counterpart. Added for
// the FIDELITY RAZOR sweep (.orch/preferences.md rule 17): host.ts's own
// kfont doc comment already found that q2repro's SCR_Init loads
// "fonts/qconfont.kfont" and every font draw/measure function branches on
// whether that load succeeded; with the retail rerelease KPF now mounted
// (Q2Game.kpf, fonts/qconfont.kfont + fonts/qconfont.png present), that
// branch is reachable for real and needs a real implementation instead of
// the documented-gap conchars-only fallback.
//
// FORMAT (confirmed against the real fonts/qconfont.kfont extracted from
// Q2Game.kpf -- a small text/token format, not binary, despite this
// project's own follow-up note guessing "binary" before extraction):
//
//   texture "fonts/qconfont.png"
//   unicode
//   mapchar
//   {
//       <codepoint> <x> <y> <w> <h> <unused>
//       ...
//   }
//
// Tokenized with COM_Parse (shared/math.ts) exactly like SCR_LoadKFont's own
// COM_Parse walk: `texture` is followed by a quoted texture path; `unicode`
// takes no argument (a bare flag token in every sample seen); `mapchar`
// consumes one token (the `{`) then reads 6-token lines
// (codepoint x y w h <trailing token, always "0" in the real file and
// otherwise unused by SCR_LoadKFont too, which discards it via a bare
// `COM_Parse(&data)`) until a lone `}`.
//
// KNOWN q2repro BUG, NOT REPRODUCED (FIDELITY RAZOR, rule 17): SCR_LoadKFont
// computes the array index as `codepoint - KFONT_ASCII_MIN` and bounds-checks
// it against `KFONT_ASCII_MAX` (126) -- but `chars[]` is sized
// `KFONT_ASCII_MAX - KFONT_ASCII_MIN + 1` (95) entries. Any source codepoint
// in [KFONT_ASCII_MIN + 95, KFONT_ASCII_MAX] == [127, 157] passes that check
// and writes past the end of `chars[]`, into `kfont_t.line_height`/`sw`/`sh`
// -- a real out-of-bounds WRITE in q2repro's own C, not something with an
// equivalent memory layout on this platform to reproduce identically (there
// is no adjacent-field aliasing to imitate in a garbage-collected array).
// This port therefore bounds-checks against the array's REAL size (95
// entries, source codepoints 32-126 only). Verified moot for the actual
// shipped asset: none of fonts/qconfont.kfont's 257 mapchar entries have a
// codepoint in the dangerous [127, 157] range (spot-checked against the
// extracted file by this unit), so this deviation has no observable effect
// on today's data.
export const KFONT_ASCII_MIN = 32;
export const KFONT_ASCII_MAX = 126;
const KFONT_NUM_CHARS = KFONT_ASCII_MAX - KFONT_ASCII_MIN + 1;

export interface KfontCharT {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The parsed-but-not-yet-renderer-registered shape: everything ParseKfont
// can determine from the text alone. `textureToken` is the raw path from
// the "texture" line (e.g. "fonts/qconfont.png") -- registering it as a
// renderer pic (via RefExports.RegisterPic("/" + textureToken), matching
// Draw_FindPic's own "leading '/' means exact path" convention this port's
// gl_draw.ts/r_draw.ts Draw_FindPic already implement) is the caller's job
// (host.ts's LoadKfontAsset), not this pure module's -- keeps this file
// renderer-independent and directly unit-testable against real file bytes.
export interface ParsedKfontT {
  textureToken: string;
  chars: (KfontCharT | null)[]; // length KFONT_NUM_CHARS, index = codepoint - KFONT_ASCII_MIN
  line_height: number;
}

// Reuses shared/math.ts's own COM_Parse tokenizer (already the established
// port of q2's COM_Parse -- see e.g. kexgame/g_spawn.ts's entity-string
// parsing) rather than duplicating its quoted-string/word-token/`//`-comment
// behavior here; that tokenizer is exactly what SCR_LoadKFont's own
// COM_Parse calls need.
import { COM_Parse, type ComParseState } from "../../shared/math";

function parseError(reason: string): null {
  // No engine Con_Printf reachable from this pure module (see file header --
  // deliberately renderer/engine independent for testability); callers that
  // want a console message log `reason` themselves. Returning null already
  // matches SCR_LoadKFont's own "just return" reaction to anything it can't
  // parse (`if (FS_LoadFile(...) < 0) return;` -- the whole function is a
  // silent bail on failure, no error message).
  void reason;
  return null;
}

export function ParseKfont(text: string): ParsedKfontT | null {
  const state: ComParseState = { data: text, index: 0 };
  let textureToken: string | null = null;
  const chars: (KfontCharT | null)[] = new Array(KFONT_NUM_CHARS).fill(null);
  let line_height = 0;

  for (;;) {
    const token = COM_Parse(state);
    if (token === "") break;

    if (token === "texture") {
      textureToken = COM_Parse(state);
    } else if (token === "unicode") {
      // no-op token, matches SCR_LoadKFont's own `else if (!strcmp(token, "unicode")) {}`
    } else if (token === "mapchar") {
      COM_Parse(state); // the opening "{" (SCR_LoadKFont discards this token the same way)
      for (;;) {
        const entryToken = COM_Parse(state);
        if (entryToken === "}" || entryToken === "") break;

        const codepoint = parseInt(entryToken, 10);
        const x = parseInt(COM_Parse(state), 10);
        const y = parseInt(COM_Parse(state), 10);
        const w = parseInt(COM_Parse(state), 10);
        const h = parseInt(COM_Parse(state), 10);
        COM_Parse(state); // trailing per-glyph token, unused (matches SCR_LoadKFont's bare COM_Parse)

        if (!Number.isFinite(codepoint) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
          return parseError("malformed mapchar entry");
        }

        const index = codepoint - KFONT_ASCII_MIN;
        // See this file's header comment: bounds-checked against the real
        // array size (KFONT_NUM_CHARS), not q2repro's own off-by-31 check
        // against KFONT_ASCII_MAX.
        if (index >= 0 && index < KFONT_NUM_CHARS) {
          chars[index] = { x, y, w, h };
          if (h > line_height) line_height = h;
        }
      }
    }
  }

  if (textureToken === null) return parseError("missing texture line");

  return { textureToken, chars, line_height };
}

export interface KfontT {
  pic: string; // renderer-registered pic name (the "/"-prefixed exact path); presence of a KfontT at all means this loaded
  chars: (KfontCharT | null)[];
  line_height: number;
}

// SCR_KFontLookup (src/refresh/draw.c): range-checks the codepoint and
// treats a zero-width entry the same as a missing one (`if (!ch->w) return
// NULL`) -- e.g. the real fonts/qconfont.kfont has no entry at all for `
// (backtick, 96) or ~ (tilde, 126), and this is how q2repro's own callers
// (CG_MeasureKFontWidth, draw_kfont_char) skip codepoints the atlas has no
// glyph for.
export function SCR_KFontLookup(font: KfontT, codepoint: number): KfontCharT | null {
  const index = codepoint - KFONT_ASCII_MIN;
  if (index < 0 || index >= KFONT_NUM_CHARS) return null;
  const ch = font.chars[index];
  if (!ch || !ch.w) return null;
  return ch;
}
