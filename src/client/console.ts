// console.h -- the scrollback console buffer. Con_DrawCharacter/
// Con_CheckResize/Con_Init/Con_DrawConsole/Con_Print/Con_CenteredPrint/
// Con_Clear_f/Con_DrawNotify/Con_ClearNotify/Con_ToggleConsole_f are ported
// as functions in console_impl.ts (console.c's pending stub; renamed from
// the header's own basename to avoid colliding with this type module -- see
// PORTING.md deviation in the report). DrawString/DrawAltString are also
// defined in console.c and live in the same stub.

export const NUM_CON_TIMES = 4;

export const CON_TEXTSIZE = 32768;

export class ConsoleT {
  initialized = false;

  text = ""; // CON_TEXTSIZE char buffer -> plain string per PORTING.md
  current = 0; // line where next message will be printed
  x = 0; // offset in current line for next print
  display = 0; // bottom of console displays this line

  ormask = 0; // high bit mask for colored characters

  linewidth = 0; // characters across screen
  totallines = 0; // total lines in console scrollback

  cursorspeed = 0;

  vislines = 0;

  times: Float32Array = new Float32Array(NUM_CON_TIMES); // cls.realtime the line was generated, for transparent notify lines

  // mirrors memset(&con, 0, sizeof(con))
  clear(): void {
    this.initialized = false;
    this.text = "";
    this.current = 0;
    this.x = 0;
    this.display = 0;
    this.ormask = 0;
    this.linewidth = 0;
    this.totallines = 0;
    this.cursorspeed = 0;
    this.vislines = 0;
    this.times = new Float32Array(NUM_CON_TIMES);
  }
}

export const con: ConsoleT = new ConsoleT();
