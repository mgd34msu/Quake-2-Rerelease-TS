// sound.h -- the public sound API. `struct sfx_s` is only forward-declared
// here; its concrete shape (SfxT) is ported in snd_loc.ts, the file that
// actually defines it, and re-exported here for callers of this header's
// functions (mirrors q_shared.ts's trace_t.ent forward-declaration idiom,
// but here the concrete type IS ported elsewhere in this same unit, so it's
// re-exported rather than left `unknown`).
//
// Every function this header declares is ported as a function in
// snd_dma.ts's pending stub (confirmed by grep against snd_dma.c) except:
// - S_Activate: declared here but never defined anywhere in the v3.19
//   client tree (confirmed by grep) -- a dead declaration, dropped and
//   reported, matching this codebase's precedent for stale header
//   prototypes (server.ts's SV_InitEdict, client.h's own SmokeAndFlash).
// - CL_GetEntitySoundOrigin: defined in cl_ents.c, not snd_dma.c; ported in
//   cl_ents.ts's stub instead.
export type { SfxT } from "./snd_loc";
