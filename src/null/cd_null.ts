/*
Ported from null/cd_null.c (GNU GPL v2 or later): the no-CD-audio backend.
This is the one CDAudio implementation this port ships -- the per-OS
ioctl/MCI backends (linux/cd_linux.c, win32/cd_win.c) are alternative
implementations of the same interface and are not transliterated, per
PORTING.md's platform-track rule.
*/

export function CDAudio_Play(track: number, looping: boolean): void {}

export function CDAudio_Stop(): void {}

export function CDAudio_Resume(): void {}

export function CDAudio_Update(): void {}

export function CDAudio_Init(): number {
  return 0;
}

export function CDAudio_Shutdown(): void {}
