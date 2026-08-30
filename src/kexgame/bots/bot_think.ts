// Copyright (c) ZeniMax Media Inc.
// Licensed under the GNU General Public License 2.0.
//
// bot_think.cpp (23 lines, 2023 Quake II re-release / "KEX" engine), ported
// from ~/Projects/quake2-rerelease-dll/rerelease/bots/bot_think.cpp:
// Bot_BeginFrame/Bot_EndFrame. Both real C++ bodies are empty --
// `void Bot_BeginFrame( edict_t * bot ) { }` / `void Bot_EndFrame( edict_t *
// bot ) { }` -- so these are real, faithful ports of a genuinely empty
// function, not stubs. p_client.ts's own `Bot_BeginFrame` throwing stub and
// p_view.ts's own `Bot_EndFrame` throwing stub are swapped to import these
// (see those two files' own updated headers for the exact diff).

import type { EdictT } from "../g_local";

/** bot_think.cpp:12-14: `void Bot_BeginFrame(edict_t *bot)` -- empty body. */
export function Bot_BeginFrame(_bot: EdictT): void {}

/** bot_think.cpp:21-23: `void Bot_EndFrame(edict_t *bot)` -- empty body. */
export function Bot_EndFrame(_bot: EdictT): void {}
