// cdaudio.h -- CD audio playback.
//
// cdaudio.h declares only functions, no types: CDAudio_Init,
// CDAudio_Shutdown, CDAudio_Play, CDAudio_Stop, CDAudio_Update,
// CDAudio_Activate. Confirmed by grepping the full quake-2-c tree: none of
// them are defined in any client/*.c file (there is no cdaudio.c in this
// unit's SCOPE) -- they're implemented per-platform (null/cd_null.c,
// linux/cd_linux.c, win32/cd_win.c). Per PORTING.md's platform mapping,
// these six prototypes belong to a future src/platform/cdaudio.ts (or
// snd.ts), not to any src/client/*.c stub. This module intentionally has no
// exports; it documents the boundary decision for a header with no ported
// type surface.
export {};
