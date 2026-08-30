// input.h -- external (non-keyboard) input devices.
//
// input.h declares only functions, no types: IN_Init, IN_Shutdown,
// IN_Commands, IN_Frame, IN_Move, IN_Activate. Confirmed by grepping the
// full quake-2-c tree: none of them are defined in any client/*.c file --
// they're implemented per-platform (null/in_null.c, linux/in_linux.c,
// win32/in_win.c, irix/vid_so.c, linux/vid_so.c). Per PORTING.md's platform
// mapping ("linux/ win32/ ... -> src/platform/ -- ONE bun implementation of
// the sys/net/vid/snd interfaces"), these six prototypes belong to a future
// src/platform/input.ts, not to any src/client/*.c stub in this unit's
// scope. This module intentionally has no exports; it documents the
// boundary decision for a header with no ported type surface.
export {};
