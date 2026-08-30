// keys.h -- key numbers passed to Key_Event, plus keys.c's shared globals.
// keydest_t lives in client.h (it's declared there, not here) as KeydestT.
// Key_Event/Key_Init/Key_WriteBindings/Key_SetBinding/Key_ClearStates/
// Key_GetKey/Key_KeynumToString are ported as functions in keys_impl.ts
// (keys.c's pending stub; renamed from the header's own basename to avoid
// colliding with this type module -- see PORTING.md deviation in the report).

//
// these are the key numbers that should be passed to Key_Event
//
export const K_TAB = 9;
export const K_ENTER = 13;
export const K_ESCAPE = 27;
export const K_SPACE = 32;

// normal keys should be passed as lowercased ascii

export const K_BACKSPACE = 127;
export const K_UPARROW = 128;
export const K_DOWNARROW = 129;
export const K_LEFTARROW = 130;
export const K_RIGHTARROW = 131;

export const K_ALT = 132;
export const K_CTRL = 133;
export const K_SHIFT = 134;
export const K_F1 = 135;
export const K_F2 = 136;
export const K_F3 = 137;
export const K_F4 = 138;
export const K_F5 = 139;
export const K_F6 = 140;
export const K_F7 = 141;
export const K_F8 = 142;
export const K_F9 = 143;
export const K_F10 = 144;
export const K_F11 = 145;
export const K_F12 = 146;
export const K_INS = 147;
export const K_DEL = 148;
export const K_PGDN = 149;
export const K_PGUP = 150;
export const K_HOME = 151;
export const K_END = 152;

export const K_KP_HOME = 160;
export const K_KP_UPARROW = 161;
export const K_KP_PGUP = 162;
export const K_KP_LEFTARROW = 163;
export const K_KP_5 = 164;
export const K_KP_RIGHTARROW = 165;
export const K_KP_END = 166;
export const K_KP_DOWNARROW = 167;
export const K_KP_PGDN = 168;
export const K_KP_ENTER = 169;
export const K_KP_INS = 170;
export const K_KP_DEL = 171;
export const K_KP_SLASH = 172;
export const K_KP_MINUS = 173;
export const K_KP_PLUS = 174;

export const K_PAUSE = 255;

//
// mouse buttons generate virtual keys
//
export const K_MOUSE1 = 200;
export const K_MOUSE2 = 201;
export const K_MOUSE3 = 202;

//
// joystick buttons
//
export const K_JOY1 = 203;
export const K_JOY2 = 204;
export const K_JOY3 = 205;
export const K_JOY4 = 206;

//
// aux keys are for multi-buttoned joysticks to generate so they can use
// the normal binding process
//
export const K_AUX1 = 207;
export const K_AUX2 = 208;
export const K_AUX3 = 209;
export const K_AUX4 = 210;
export const K_AUX5 = 211;
export const K_AUX6 = 212;
export const K_AUX7 = 213;
export const K_AUX8 = 214;
export const K_AUX9 = 215;
export const K_AUX10 = 216;
export const K_AUX11 = 217;
export const K_AUX12 = 218;
export const K_AUX13 = 219;
export const K_AUX14 = 220;
export const K_AUX15 = 221;
export const K_AUX16 = 222;
export const K_AUX17 = 223;
export const K_AUX18 = 224;
export const K_AUX19 = 225;
export const K_AUX20 = 226;
export const K_AUX21 = 227;
export const K_AUX22 = 228;
export const K_AUX23 = 229;
export const K_AUX24 = 230;
export const K_AUX25 = 231;
export const K_AUX26 = 232;
export const K_AUX27 = 233;
export const K_AUX28 = 234;
export const K_AUX29 = 235;
export const K_AUX30 = 236;
export const K_AUX31 = 237;
export const K_AUX32 = 238;

export const K_MWHEELDOWN = 239;
export const K_MWHEELUP = 240;

// `char *keybindings[256]` -- each slot is the bound command string, or
// null when unbound (C's NULL pointer).
export const keybindings: (string | null)[] = new Array(256).fill(null);
export const key_repeats: Int32Array = new Int32Array(256);

export let anykeydown = 0;
export function setAnykeydown(v: number): void {
  anykeydown = v;
}

export let chat_buffer = "";
export let chat_bufferlen = 0;
export let chat_team = false;

export function setChatBuffer(v: string): void {
  chat_buffer = v;
  chat_bufferlen = v.length;
}
export function setChatTeam(v: boolean): void {
  chat_team = v;
}
