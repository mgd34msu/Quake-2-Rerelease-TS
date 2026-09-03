// m_arachnid.h -- frame index constants
//
// RERELEASE CONTENT PORT. Translated from src/kexgame/m_arachnid.ts's own
// "m_arachnid.h frame constants" block (which is itself generated from the
// 131-entry frame enum in the 2023 re-release's m_arachnid.h). Following the
// leaner convention kexgame established for this monster, only the
// boundary/comparison constants m_arachnid.cpp itself names by identifier are
// declared -- frames referenced only by POSITION inside an mframe_t[] array
// need no name. (Vanilla 3.21 *_frames.ts files list every frame because the
// vanilla headers do; there is no vanilla m_arachnid.h to transcribe.)

export const FRAME_rails1 = 0;
export const FRAME_rails4 = 3;
export const FRAME_rails8 = 7;
export const FRAME_rails11 = 10;
export const FRAME_death1 = 11;
export const FRAME_death20 = 30;
export const FRAME_melee_atk1 = 31;
export const FRAME_melee_atk12 = 42;
export const FRAME_pain11 = 43;
export const FRAME_pain15 = 47;
export const FRAME_idle1 = 48;
export const FRAME_idle13 = 60;
export const FRAME_walk1 = 61;
export const FRAME_walk10 = 70;
export const FRAME_pain21 = 77;
export const FRAME_pain26 = 82;
export const FRAME_rails_up1 = 115;
export const FRAME_rails_up7 = 121;
export const FRAME_rails_up11 = 125;
export const FRAME_rails_up16 = 130;

export const MODEL_SCALE = 1.0;
