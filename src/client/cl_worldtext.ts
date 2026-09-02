/*
cl_worldtext.ts -- the client's store of world-space text (info_world_text's
Draw_OrientedWorldText / Draw_StaticWorldText).

── How the re-release actually delivers these (investigated for this unit) ─
There is NO network message. q2repro's src/server/game.c:834-889 wraps the
whole PF_Draw_* family in `#if USE_REF`: on a build with a renderer, each
one calls straight into the CLIENT's own R_AddDebugText (declared in
inc/client/client.h:186, not refresh.h); on a dedicated build every one of
them is an empty `{}`. `grep -n debug` over inc/common/protocol.h returns
nothing, q2proto's Q2P_SVC_* enumeration
(q2proto/inc/q2proto/q2proto_struct_svc.h:643-702) has no debug or text
member, and svc_rr_* stops at achievement. Debug draws -- world text
included -- are an in-process, listen-server-only facility there.

This port is a listen server too, so it is mirrored as an in-process
handoff rather than invented as a new svc_ opcode: sv_main.ts drains
sv_debugdraw.ts's buffer once per server frame (the same place q2repro
calls GL_ExpireDebugObjects, src/server/main.c:1723) and hands the
world-text entries here. Adding a wire message would be a port-original
protocol extension the re-release does not have, and would put an opcode on
the 1038 wire that a real re-release client would reject; the honest
consequence of matching the original is the same one q2repro lives with --
a remote client of this server sees no world text, exactly as a remote
client of q2repro's server does.

Expiry is the SERVER's, not the client's, for the same reason q2repro says
so at main.c:1721-1722 ("debug stuff is pushed via the game, so it needs to
look at server time for expiry, not client time"): sv_debugdraw.ts's own
SV_DebugDraw_Tick already does that, so this module holds only the current
frame's snapshot and is replaced wholesale each server frame.
*/

import { type Vec3, vec3, VectorCopy } from "../shared/math";
import { WorldTextT } from "./ref";

// q2repro debug.c:29's MAX_DEBUG_TEXTS. Entries past the cap are dropped
// rather than growing without bound -- there, the freelist simply runs out.
export const MAX_WORLD_TEXTS = 1024;

let worldTexts: WorldTextT[] = [];

export function CL_ClearWorldText(): void {
  worldTexts = [];
}

/*
====================
CL_SetWorldText

Replaces the whole snapshot. Called once per server frame from
sv_main.ts's drain; info_world_text re-emits every frame it is active
(g_kexmisc.ts's info_world_text_think re-arms nextthink at FRAMETIME), so
a wholesale replace is what keeps a switched-off or removed one from
lingering.
====================
*/
export function CL_SetWorldText(entries: readonly WorldTextT[]): void {
  worldTexts = entries.length > MAX_WORLD_TEXTS ? entries.slice(0, MAX_WORLD_TEXTS).map(cloneWorldText) : entries.map(cloneWorldText);
}

function cloneWorldText(src: WorldTextT): WorldTextT {
  const out = new WorldTextT();
  VectorCopy(src.origin, out.origin);
  VectorCopy(src.angles, out.angles);
  out.oriented = src.oriented;
  out.text = src.text;
  out.size = src.size;
  out.color.set(src.color);
  out.depthTest = src.depthTest;
  return out;
}

export function CL_WorldTexts(): readonly WorldTextT[] {
  return worldTexts;
}

/*
====================
makeWorldText

Shapes one sv_debugdraw.ts entry into the renderer's form. `oriented` is
true when the draw supplied ANGLES -- note that this is the opposite of
what sv_debugdraw.ts's shape names suggest: its "orientedWorldText" is the
kind with NO angles, mirroring q2repro's PF_Draw_OrientedWorldText passing
`NULL` angles to R_AddDebugText (game.c:857-860) so the glyph quads face
the viewer, while PF_Draw_StaticWorldText passes real angles
(game.c:862-864). The C field layout, not the C names, is what is being
matched here.
====================
*/
export function makeWorldText(origin: Vec3, angles: Vec3 | null, text: string, size: number, color: Uint8Array, depthTest: boolean): WorldTextT {
  const out = new WorldTextT();
  VectorCopy(origin, out.origin);
  if (angles) VectorCopy(angles, out.angles);
  else VectorCopy(vec3(), out.angles);
  out.oriented = angles !== null;
  // debug.c:389 truncates to the struct's 127 usable chars.
  out.text = text.length > 127 ? text.slice(0, 127) : text;
  // debug.c:376's `t->size = size * 8.0f` -- the game's `size` is a
  // multiplier, not a pixel height. info_world_text defaults it to 0.2
  // (g_kexmisc.ts's SP_info_world_text), giving a 1.6-unit character cell.
  out.size = size * 8;
  out.color.set(color);
  out.depthTest = depthTest;
  return out;
}
