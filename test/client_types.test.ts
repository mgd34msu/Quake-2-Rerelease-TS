import { describe, test, expect } from "bun:test";
import {
  cl,
  cls,
  ClStateT,
  ClStaticT,
  ConnstateT,
  DltypeT,
  KeydestT,
  FrameT,
  CentityT,
  ClientinfoT,
  CdlightT,
  ClSustainT,
  CparticleT,
  KbuttonT,
  clCvars,
  cl_entities,
  cl_dlights,
  cl_parse_entities,
} from "../src/client/client";
import { RefdefT, EntityT, DlightT, ParticleT, LightstyleT, type RefExports, type RefImports } from "../src/client/ref";
import { ViddefT, viddef } from "../src/client/vid";
import { VrectT } from "../src/client/screen";
import { K_TAB, K_ENTER, K_ESCAPE, K_SPACE, K_BACKSPACE, K_F1, keybindings, key_repeats } from "../src/client/keys";
import { ConsoleT, con } from "../src/client/console";
import {
  SfxT,
  SfxcacheT,
  PlaysoundT,
  DmaT,
  ChannelT,
  WavinfoT,
  PortableSamplepairT,
  channels,
  dma,
  listener_origin,
  sndCvars,
} from "../src/client/snd_loc";
import { MenuframeworkS, MenuCommonS, MenufieldS, MenusliderS, MenulistS, MenuactionS, MenuseparatorS } from "../src/client/qmenu";


// ---- struct construction ------------------------------------------------

describe("client.ts default structs", () => {
  test("ClStateT / ClStaticT singletons construct with faithful defaults", () => {
    expect(cl).toBeInstanceOf(ClStateT);
    expect(cls).toBeInstanceOf(ClStaticT);

    // structural assertions only: earlier suites (cl_main's loopback
    // connect) legitimately mutate the cl/cls singletons in-process.
    expect(cl.cmds.length).toBe(64); // CMD_BACKUP
    expect(cl.clientinfo.length).toBe(256); // MAX_CLIENTS
    expect(cl.inventory.length).toBe(256); // MAX_ITEMS
    expect(cl.configstrings.length).toBeGreaterThan(0);

    expect(Object.values(ConnstateT)).toContain(cls.state);
    expect(Object.values(KeydestT)).toContain(cls.key_dest);
    expect(Object.values(DltypeT)).toContain(cls.downloadtype);
  });

  test("ClStateT.clear() resets fields the way CL_ClearState memsets cl", () => {
    const state = new ClStateT();
    state.timeoutcount = 7;
    state.servercount = 42;
    state.viewangles[0] = 90;
    state.clear();
    expect(state.timeoutcount).toBe(0);
    expect(state.servercount).toBe(0);
    expect(state.viewangles[0]).toBe(0);
  });

  test("FrameT/CentityT/ClientinfoT/CdlightT construct with C-faithful shapes", () => {
    const frame = new FrameT();
    expect(frame.valid).toBe(false);
    expect(frame.areabits.length).toBe(256 / 8); // MAX_MAP_AREAS/8

    const ent = new CentityT();
    expect(ent.lerp_origin.length).toBe(3);

    const ci = new ClientinfoT();
    expect(ci.weaponmodel.length).toBe(20); // MAX_CLIENTWEAPONMODELS

    const light = new CdlightT();
    expect(light.color.length).toBe(3);
  });

  test("ClSustainT/CparticleT/KbuttonT construct with faithful defaults", () => {
    const sustain = new ClSustainT();
    expect(sustain.think).toBeNull();

    const particle = new CparticleT();
    expect(particle.next).toBeNull();
    expect(particle.org.length).toBe(3);

    const kb = new KbuttonT();
    expect(kb.down.length).toBe(2);
  });

  test("module-level arrays are sized per their C #define bounds", () => {
    expect(cl_entities.length).toBe(1024); // MAX_EDICTS
    expect(cl_dlights.length).toBe(32); // MAX_DLIGHTS (ref.h)
    expect(cl_parse_entities.length).toBe(1024); // MAX_PARSE_ENTITIES
  });

  test("clCvars holder keys exist for every C-registered client cvar", () => {
    expect("cl_predict" in clCvars).toBe(true);
    expect("sensitivity" in clCvars).toBe(true);
    expect("cl_stereo_separation" in clCvars).toBe(true);
  });
});

describe("ref.ts / vid.ts / screen.ts default structs", () => {
  test("RefdefT and its nested renderer types construct empty", () => {
    const rd = new RefdefT();
    expect(rd.entities).toEqual([]);
    expect(rd.blend.length).toBe(4);
    expect(rd.areabits).toBeNull();

    expect(new EntityT().flags).toBe(0);
    expect(new DlightT().origin.length).toBe(3);
    expect(new ParticleT().color).toBe(0);
    expect(new LightstyleT().white).toBe(0);
  });

  test("RefExports/RefImports are structurally satisfiable interfaces", () => {
    const imports: RefImports = {
      Sys_Error(): never {
        throw new Error("stub");
      },
      Cmd_AddCommand: () => undefined,
      Cmd_RemoveCommand: () => undefined,
      Cmd_Argc: () => 0,
      Cmd_Argv: () => "",
      Cmd_ExecuteText: () => undefined,
      Con_Printf: () => undefined,
      FS_LoadFile: () => ({ length: -1, data: null }),
      FS_FreeFile: () => undefined,
      FS_Gamedir: () => "",
      Cvar_Get: () => null,
      Cvar_Set: () => null,
      Cvar_SetValue: () => undefined,
      Vid_GetModeInfo: () => null,
      Vid_MenuInit: () => undefined,
      Vid_NewWindow: () => undefined,
    };
    expect(typeof imports.Cmd_Argc).toBe("function");

    const exports: RefExports = {
      api_version: 3,
      Init: () => true,
      Shutdown: () => undefined,
      BeginRegistration: () => undefined,
      RegisterModel: () => null,
      RegisterSkin: () => null,
      RegisterPic: () => null,
      RegisterRawPic: () => null,
      SetSky: () => undefined,
      EndRegistration: () => undefined,
      RenderFrame: () => undefined,
      SupportsPerPixelLighting: () => false,
      DrawGetPicSize: () => ({ w: 0, h: 0 }),
      DrawPic: () => undefined,
      DrawStretchPic: () => undefined,
      DrawColorPic: () => undefined,
      DrawStretchPicRegion: () => undefined,
      DrawChar: () => undefined,
      DrawTileClear: () => undefined,
      DrawFill: () => undefined,
      DrawFadeScreen: () => undefined,
      DrawStretchRaw: () => undefined,
      CinematicSetPalette: () => undefined,
      BeginFrame: () => undefined,
      EndFrame: () => undefined,
      AppActivate: () => undefined,
    };
    expect(exports.api_version).toBe(3);
  });

  test("viddef is the shared singleton; fresh VrectT zeroes", () => {
    // structural only: SWimp_SetMode's Vid_NewWindow legitimately writes
    // viddef when an earlier suite sets a video mode in this process.
    expect(viddef).toBeInstanceOf(ViddefT);
    expect(typeof viddef.width).toBe("number");
    const vr = new VrectT();
    expect(vr.width).toBe(0);
  });
});

describe("console.ts / snd_loc.ts / qmenu.ts default structs", () => {
  test("con singleton and ConsoleT.clear() mirror memset(&con, 0, ...)", () => {
    expect(con).toBeInstanceOf(ConsoleT);
    const c = new ConsoleT();
    c.current = 5;
    c.clear();
    expect(c.current).toBe(0);
  });

  test("sound mixer types construct with C-faithful shapes", () => {
    expect(new SfxT().name).toBe("");
    expect(new SfxcacheT().data.length).toBe(0);
    expect(new PlaysoundT().prev).toBeNull();
    expect(new DmaT().buffer.length).toBe(0);
    expect(new ChannelT().sfx).toBeNull();
    expect(new WavinfoT().rate).toBe(0);
    expect(new PortableSamplepairT().left).toBe(0);

    expect(channels.length).toBe(32); // MAX_CHANNELS
    expect(dma).toBeInstanceOf(DmaT);
    expect(listener_origin.length).toBe(3);
    // structural: snd.test.ts legitimately registers s_volume in-process
    expect("s_volume" in sndCvars).toBe(true);
  });

  test("qmenu widget types construct with C-faithful shapes", () => {
    const menu = new MenuframeworkS();
    expect(menu.items.length).toBe(64); // MAXMENUITEMS

    const common = new MenuCommonS();
    expect(common.localdata.length).toBe(4);

    expect(new MenufieldS().generic).toBeInstanceOf(MenuCommonS);
    expect(new MenusliderS().generic).toBeInstanceOf(MenuCommonS);
    expect(new MenulistS().itemnames).toEqual([]);
    expect(new MenuactionS().generic).toBeInstanceOf(MenuCommonS);
    expect(new MenuseparatorS().generic).toBeInstanceOf(MenuCommonS);
  });
});

// ---- K_* constants spot-check against client/keys.h ----------------------

describe("keys.ts K_* constants match client/keys.h", () => {
  test("K_TAB == 9", () => expect(K_TAB).toBe(9));
  test("K_ENTER == 13", () => expect(K_ENTER).toBe(13));
  test("K_ESCAPE == 27", () => expect(K_ESCAPE).toBe(27));
  test("K_SPACE == 32", () => expect(K_SPACE).toBe(32));
  test("K_BACKSPACE == 127", () => expect(K_BACKSPACE).toBe(127));
  test("K_F1 == 135", () => expect(K_F1).toBe(135));

  test("keybindings/key_repeats are sized for 256 key numbers", () => {
    expect(keybindings.length).toBe(256);
    expect(keybindings[0]).toBeNull();
    expect(key_repeats.length).toBe(256);
  });
});

// ---- pending-stub coverage -------------------------------------------------

// The pending-stub mechanism is covered by test/ref_types.test.ts's
// Mod_ClearAll test (a permanently bodyless C declaration, so it never
// goes stale as real ports land).
