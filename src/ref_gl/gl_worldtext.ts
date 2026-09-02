/*
gl_worldtext.ts -- world-space text (info_world_text), drawn as billboarded
or angle-oriented conchars quads.

No .c analog in the 1997 id Software renderer. Ported from q2repro's
src/refresh/debug.c, specifically its TEXTURED debug-text path:

  * debug.c:604-652  GL_DrawDebugTexts()  -- the per-entry basis: the
    distance cull, the billboard basis (-viewaxis[1] / -viewaxis[2]) and
    the angled basis (AngleVectors' right / -up).
  * debug.c:585-601  GL_DrawDebugTextLine() -- the frustum cull and the
    `-0.5 * len` horizontal centring that puts the string's MIDDLE on the
    entity's origin.
  * debug.c:519-583  GL_DrawDebugChar()   -- one quad per glyph, the
    16x16 conchars grid, and skipping spaces.
  * debug.c:518-531  GL_FlushDebugChars() -- the GL state: the engine's
    `r_charset` (conchars, not a kfont atlas), alpha blend, no depth
    writes, optional depth test, cull off for the angled case.

── Which of q2repro's two styles this is ────────────────────────────────
q2repro has TWO renderers for the same data, chosen by `gl_debug_text_style`
(debug.c:706, default "lines"): a Hershey vector-stroke font that emits
R_AddDebugLine segments (src/refresh/debug_text.c), and the textured
conchars quads above. The textured one is ported here because this
renderer already owns exactly that: gl_draw.ts's Draw_Char draws from the
same 16x16 conchars grid with the same `(n>>4)/16, (n&15)/16` texcoords, so
the glyph half is a straight reuse rather than 18 new built-in fonts and a
stroke rasterizer. The two styles differ in more than looks -- the stroke
path also scales by `size * 32` instead of `size * 8` and billboards
YAW-ONLY (debug_text.c:110-118 zeroes the direction's Z) -- so this is a
deliberate choice of one of the re-release's two behaviors, not an
approximation of both. gl_debug_text_style stays registered-only.

── Fog ──────────────────────────────────────────────────────────────────
Not fogged, and that matches q2repro: GL_FlushDebugChars sets
`GL_StateBits(tess.flags)` where tess.flags is only
GLS_DEPTHMASK_FALSE | GLS_BLEND_BLEND (+ depth-test/cull bits) -- none of
the GLS_FOG_* bits -- so debug text there is exempt from the fog its world
surfaces get. That is why R_RenderView calls this AFTER GL_DrawFogPass.
*/

import { qgl, GL_Bind, GL_TexEnv } from "./gl_image";
import { draw_chars } from "./gl_draw";
import { glCvars, r_newrefdef, r_origin, vpn, vright, vup, frustum } from "./gl_local";
import { type Vec3, vec3, AngleVectors, DotProduct, VectorSubtract, VectorMA, VectorCopy, VectorAdd, VectorScale } from "../shared/math";
import type { WorldTextT } from "../client/ref";

const GL_QUADS = 0x0007;
const GL_BLEND = 0x0be2;
const GL_SRC_ALPHA = 0x0302;
const GL_ONE_MINUS_SRC_ALPHA = 0x0303;
const GL_DEPTH_TEST = 0x0b71;
const GL_CULL_FACE = 0x0b44;
const GL_ALPHA_TEST = 0x0bc0;
const GL_MODULATE = 0x2100;

// debug.c:704's `gl_debug_distfrac` default. A text is skipped once its
// character cell is small compared to how far away it is -- the same test,
// not a re-derived one: `size < dist_along_view_forward * distfrac`.
const DEFAULT_DEBUG_DISTFRAC = 0.004;

/*
====================
worldTextBasis

debug.c:611-621. Returns the per-character `right` and `down` steps,
already scaled by the cell size.

The billboard branch uses the NEGATED view right/up. q2repro writes it as
`-viewaxis[1]` / `-viewaxis[2]`, where its viewaxis[1] is LEFT (its
AnglesToAxis produces forward/left/up); this renderer's `vright` is
already the right vector, so the same result is `+vright` and `-vup`. The
angled branch is AngleVectors' own right and up, with up negated to point
down the page.
====================
*/
export function worldTextBasis(text: { oriented: boolean; angles: Vec3; size: number }, viewRight: Vec3, viewUp: Vec3): { right: Vec3; down: Vec3 } {
  const right = vec3();
  const down = vec3();
  if (text.oriented) {
    const forward = vec3();
    const up = vec3();
    AngleVectors(text.angles, forward, right, up);
    VectorScale(right, text.size, right);
    VectorScale(up, -text.size, down);
  } else {
    VectorScale(viewRight, text.size, right);
    VectorScale(viewUp, -text.size, down);
  }
  return { right, down };
}

/*
====================
worldTextCulled

debug.c:610: `if (text->size < DotProduct(pos, glr.viewaxis[0]) * distfrac)
continue;` -- `pos` being origin-minus-vieworg, so the dot product is the
signed distance ALONG the view axis. Text behind the eye gives a negative
distance and is therefore never culled by this test (q2repro relies on the
frustum test in GL_DrawDebugTextLine for that); reproduced as-is.
====================
*/
export function worldTextCulled(origin: Vec3, size: number, vieworg: Vec3, viewForward: Vec3, distfrac: number): boolean {
  const rel = vec3();
  VectorSubtract(origin, vieworg, rel);
  return size < DotProduct(rel, viewForward) * distfrac;
}

/*
====================
worldTextLineStart

debug.c:592: `VectorMA(origin, -0.5f * len, right, pos)` -- the string is
CENTRED on the origin horizontally, so a 5-character line starts 2.5 cells
to the left of the entity, not at it.
====================
*/
export function worldTextLineStart(origin: Vec3, right: Vec3, length: number, out: Vec3): Vec3 {
  VectorMA(origin, -0.5 * length, right, out);
  return out;
}

// debug.c:589-590's per-line frustum reject, using this renderer's own
// four frustum planes (gl_local.ts's `frustum`, set by R_SetFrustum) in
// place of q2repro's glr.frustumPlanes.
function lineOutsideFrustum(origin: Vec3, radius: number): boolean {
  for (let i = 0; i < 4; i++) {
    const p = frustum[i];
    if (DotProduct(origin, p.normal) - p.dist < -radius) return true;
  }
  return false;
}

// debug.c:519-583. One quad, the 16x16 conchars grid, spaces skipped --
// the identical texcoord derivation gl_draw.ts's Draw_Char uses for the 2D
// case, only with a world-space basis instead of screen pixels.
function drawWorldChar(pos: Vec3, right: Vec3, down: Vec3, code: number): void {
  const n = code & 255;
  if ((n & 127) === 32) return; // space

  const frow = (n >>> 4) * 0.0625;
  const fcol = (n & 15) * 0.0625;
  const size = 0.0625;

  const p1 = vec3();
  const p2 = vec3();
  const p3 = vec3();
  VectorAdd(pos, right, p1);
  VectorAdd(p1, down, p2);
  VectorAdd(pos, down, p3);

  qgl.qglTexCoord2f(fcol, frow);
  qgl.qglVertex3fv(pos);
  qgl.qglTexCoord2f(fcol + size, frow);
  qgl.qglVertex3fv(p1);
  qgl.qglTexCoord2f(fcol + size, frow + size);
  qgl.qglVertex3fv(p2);
  qgl.qglTexCoord2f(fcol, frow + size);
  qgl.qglVertex3fv(p3);
}

/*
====================
GL_DrawWorldTexts

Called from R_RenderView after the fog pass. q2repro's equivalent
(GL_DrawDebugObjects, src/refresh/main.c:867) likewise runs after the
alpha-front entity pass and before the 2D setup, i.e. as the last thing
drawn in world space.
====================
*/
export function GL_DrawWorldTexts(): void {
  const texts = r_newrefdef.worldtexts;
  const count = Math.min(r_newrefdef.num_worldtexts, texts.length);
  if (count <= 0) return;
  if (!draw_chars) return;

  const distfrac = glCvars.gl_debug_distfrac ? glCvars.gl_debug_distfrac.value : DEFAULT_DEBUG_DISTFRAC;

  GL_Bind(draw_chars.texnum);
  // gl_image.ts's GL_TexEnv keeps its own record of the current mode, so
  // going through it rather than qglTexEnvf keeps that cache honest for
  // whatever draws next. MODULATE so the per-entry color tints the glyphs.
  GL_TexEnv(GL_MODULATE);

  qgl.qglEnable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglDisable(GL_ALPHA_TEST);
  // debug.c:381's GLS_CULL_DISABLE is set for the ANGLED case only, but a
  // billboard quad built from the view basis is always front-facing, so
  // turning culling off for the whole batch is behaviour-identical and
  // saves toggling it per entry.
  qgl.qglDisable(GL_CULL_FACE);
  // GLS_DEPTHMASK_FALSE -- text never occludes anything.
  qgl.qglDepthMask(false);

  let depthTestEnabled = true;

  for (let i = 0; i < count; i++) {
    const text = texts[i];
    if (!text || text.size <= 0 || text.text.length === 0) continue;
    if (worldTextCulled(text.origin, text.size, r_origin, vpn, distfrac)) continue;

    if (text.depthTest !== depthTestEnabled) {
      depthTestEnabled = text.depthTest;
      if (depthTestEnabled) qgl.qglEnable(GL_DEPTH_TEST);
      else qgl.qglDisable(GL_DEPTH_TEST);
    }

    const { right, down } = worldTextBasis(text, vright, vup);

    qgl.qglColor4f(text.color[0] / 255, text.color[1] / 255, text.color[2] / 255, text.color[3] / 255);

    // debug.c:396-426's R_AddDebugTextTexture splits a multi-line string
    // into one entry per line before it ever reaches the draw, stepping the
    // position by `down` between them. The split happens here instead,
    // which keeps the same geometry without a second buffer.
    const lines = text.text.split("\n");
    const linePos = vec3();
    VectorCopy(text.origin, linePos);

    for (const line of lines) {
      if (line.length > 0) {
        const radius = text.size * 0.5 * line.length;
        if (!lineOutsideFrustum(linePos, radius)) {
          const pos = vec3();
          worldTextLineStart(linePos, right, line.length, pos);
          qgl.qglBegin(GL_QUADS);
          for (let c = 0; c < line.length; c++) {
            drawWorldChar(pos, right, down, line.charCodeAt(c));
            VectorAdd(pos, right, pos);
          }
          qgl.qglEnd();
        }
      }
      VectorAdd(linePos, down, linePos);
    }
  }

  if (!depthTestEnabled) qgl.qglEnable(GL_DEPTH_TEST);
  qgl.qglDepthMask(true);
  qgl.qglDisable(GL_BLEND);
  qgl.qglBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  qgl.qglColor4f(1, 1, 1, 1);
  // Left DISABLED, not enabled: R_SetupGL's own end-of-setup state for the
  // 3D scene is `qglDisable(GL_ALPHA_TEST)`, so that is what this pass found
  // and that is what it puts back. R_SetGL2D re-enables it for the HUD.
  if (glCvars.gl_cull && glCvars.gl_cull.value) qgl.qglEnable(GL_CULL_FACE);
}
