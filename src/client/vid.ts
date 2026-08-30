// vid.h -- video driver defs
//
// VID_Init/VID_Shutdown/VID_CheckChanges/VID_MenuInit/VID_MenuDraw/VID_MenuKey
// are implemented per-platform (confirmed: no client/*.c file in the v3.19
// tree defines any of them -- menu.c only *calls* VID_MenuInit/VID_MenuDraw/
// VID_MenuKey; the definitions live in linux/vid_menu.c, win32/vid_menu.c,
// irix/vid_menu.c, and the vid_so.c/vid_dll.c backends). Per PORTING.md's
// platform mapping ("linux/ win32/ ... -> src/platform/ -- ONE bun
// implementation of the sys/net/vid/snd interfaces"), these six prototypes
// belong to a future src/platform/vid.ts, not to any src/client/*.c stub in
// this unit's scope. Only the type/global surface is ported here.

export class ViddefT {
  width = 0;
  height = 0;
}

export const viddef: ViddefT = new ViddefT(); // global video state
