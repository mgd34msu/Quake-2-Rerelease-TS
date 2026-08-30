// Ports lmctf60/p_observer.c (326 lines).
//
// FINDING: the ENTIRE file is wrapped in a single `#ifdef OLDOBSERVERCODE`
// (line 7) / `#endif` (line 326) -- there is no code in this file outside
// that guard. `OLDOBSERVERCODE` is defined nowhere: g_local.h:19 has it as
// `//#define OLDOBSERVERCODE` (commented out), and it is not passed via
// `-D` in either build (checked both `Makefile` and `gravity.vcxproj`,
// every configuration). Per PORTING.md's "#if 0 blocks are dropped
// silently" rule (a permanently-false `#ifdef` is functionally identical),
// nothing in this file is ported: Drop_All, Observer_Start, Observer_Stop,
// Camera_Start, Camera_Stop, and Camera_Think never compile into any real
// build of lmctf60. This is the same class of finding as bat.ts's (a
// second, larger dead file), confirmed the same way: grepped for every
// call site of each of the six functions across the whole lmctf60 tree.
//
// Every call site is ALSO inside `#ifdef OLDOBSERVERCODE`, consistently,
// everywhere -- this is not a dangling reference that would fail to link,
// it is a fully self-contained dead subsystem:
//   - Observer_Start: called from p_client.c:2146, p_client.c:2689,
//     g_cmds.c:1008 -- all three call sites are themselves inside
//     `#ifdef OLDOBSERVERCODE` blocks in their own files.
//   - Observer_Stop/Camera_Start/Camera_Stop/Camera_Think: no call sites
//     anywhere outside this file's own dead code.
//   - Drop_All: DOES have a live caller (p_client.c:1755, outside any
//     ifdef) -- but that call resolves to a SEPARATE, live `Drop_All`
//     defined in g_cmds.c:1065 (unit A's g_cmds.ts completion), not to
//     this file's dead copy. Two same-named `Drop_All` definitions only
//     coexist safely in the C source because exactly one of them (this
//     file's) never compiles.
//
// The dead subsystem this file implements is a chase-camera-based
// spectator mode (`Camera_Start`/`Camera_Think` smoothly fly the
// observer's view toward whichever player they're spectating, with
// BUTTON_ATTACK cycling to the next player by ctfid). It was superseded by
// a different, newer observer implementation ("bat"'s `Cmd_Observe_f`
// family, referenced directly by g_menu.ts's live `Observe`/`Observe_Red`/
// `Observe_Blue`/`Observe_Exec` and owned by unit A's pending p_client.ts)
// before this file's replacement was ever wired back in -- g_menu.c's own
// `#else //bat` comment on its parallel `Obs_Main_Menu`/`Observe`
// definitions confirms the same "bat" replacement happened there too.
//
// Nothing is exported: nothing outside this file (dead or live) needs
// anything from it, since every real call site was confirmed to route
// through the live `#else //bat` implementations instead.
export {};
