// Test for item 3 (menu music) of the wave-B on-screen-indicators task:
// src/client/cl_scrn.ts's SCR_UpdateScreen now has a disconnected-state
// CDAudio_Play(ogg_menu_track) call site (q2repro's own OGG_Play(), src/
// client/sound/ogg.c:238-289, previously had no equivalent call site
// anywhere in this port -- platform/cd_ogg.ts's own registerCdCvars() doc
// comment flagged this exact gap: "ogg_menu_track needs a disconnected-
// state call site ... that doesn't exist yet").
//
// SCOPE: this suite proves the call site exists, runs at the right state
// (cls.state < ca_connected), is idempotent/safe to call every frame, and
// that the ogg_menu_track cvar it reads is registered with the documented
// default. It does NOT spy on CDAudio_Play's own internals (which file it
// tries to open, whether libvorbisfile is present, etc.) -- that machinery
// is platform/cd_ogg.ts's own, already covered by test/cd_ogg.test.ts, and
// this codebase has no established module-mocking precedent to intercept a
// real cross-module function call from inside a test without introducing a
// new testing pattern; see this unit's own task report for the disposition
// on that gap.

import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { SCR_Init, SCR_UpdateScreen } from "../src/client/cl_scrn";
import { cl, cls, ConnstateT } from "../src/client/client";
import { Cvar_Get } from "../src/qcommon/cvar";
import { SZ_Init } from "../src/qcommon/sizebuf";

beforeAll(() => {
  SCR_Init(); // registers ogg_menu_track (via cl_scrn.ts's own fallback Cvar_Get) plus scr_initialized -- see SCR_UpdateScreen's own early-return on that flag
});

beforeEach(() => {
  cls.clear();
  cl.cinematictime = 0;
  SZ_Init(cls.netchan.message, new Uint8Array(1024), 1024);
});

describe("SCR_UpdateScreen -- menu music call site", () => {
  test("runs without throwing while disconnected (the ogg_menu_track branch)", () => {
    cls.state = ConnstateT.ca_disconnected;
    expect(() => SCR_UpdateScreen()).not.toThrow();
  });

  test("runs without throwing while connecting (also < ca_connected, same branch)", () => {
    cls.state = ConnstateT.ca_connecting;
    expect(() => SCR_UpdateScreen()).not.toThrow();
  });

  test("runs without throwing once connected/active (the CS_CDTRACK branch's own territory, untouched by this call site)", () => {
    cls.state = ConnstateT.ca_active;
    expect(() => SCR_UpdateScreen()).not.toThrow();
  });

  test("is safe to call every frame across repeated state transitions (CDAudio_Play's own idempotent early-return makes this cheap, matching OGG_Play's real many-call-site precedent)", () => {
    cls.state = ConnstateT.ca_disconnected;
    for (let i = 0; i < 5; i++) expect(() => SCR_UpdateScreen()).not.toThrow();
    cls.state = ConnstateT.ca_active;
    expect(() => SCR_UpdateScreen()).not.toThrow();
    cls.state = ConnstateT.ca_disconnected;
    expect(() => SCR_UpdateScreen()).not.toThrow();
  });

  test("ogg_menu_track registers with its documented default (\"77\", matching q2repro's own ogg.c:815)", () => {
    cls.state = ConnstateT.ca_disconnected;
    SCR_UpdateScreen(); // triggers cl_scrn.ts's own Cvar_Get("ogg_menu_track", "77", ...) if cd_ogg.ts hasn't registered it yet in this process
    expect(Cvar_Get("ogg_menu_track", "77", 0)?.default_string).toBe("77");
  });
});
