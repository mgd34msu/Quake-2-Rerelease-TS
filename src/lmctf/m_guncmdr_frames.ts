// m_gunner.h (second half) -- GUN COMMANDER frame index constants
//
// RERELEASE CONTENT PORT. m_guncmdr.cpp has no header of its own; its
// `#include "m_gunner.h"` pulls the FRAME_c_* block out of the SECOND half of
// that 809-line header. m_gunner.h's first (gunner-owned) FRAME_ block runs
// 0..248 -- confirmed by src/game/m_gunner_frames.ts's own FRAME_attak324 =
// 248 -- so FRAME_c_stand101 = 249 and the block continues sequentially
// through FRAME_c_duckdeath29 = 798.
//
// Only the boundary/comparison constants m_guncmdr.cpp itself names by
// identifier are declared (every mmove_t's firstframe/lastframe and every
// `self->s.frame == FRAME_c_...` comparison); frames referenced only by
// POSITION inside an mframe_t[] array need no name. Transcribed from
// src/kexgame/m_guncmdr.ts's own copy of this list.

export const FRAME_c_stand101 = 249;
export const FRAME_c_stand140 = 288;
export const FRAME_c_stand201 = 289;
export const FRAME_c_stand254 = 342;
export const FRAME_c_attack101 = 343;
export const FRAME_c_attack106 = 348;
export const FRAME_c_attack107 = 349;
export const FRAME_c_attack112 = 354;
export const FRAME_c_attack118 = 360;
export const FRAME_c_attack124 = 366;
export const FRAME_c_jump01 = 367;
export const FRAME_c_jump10 = 376;
export const FRAME_c_attack201 = 377;
export const FRAME_c_attack205 = 381;
export const FRAME_c_attack208 = 384;
export const FRAME_c_attack211 = 387;
export const FRAME_c_attack221 = 397;
export const FRAME_c_attack302 = 399;
export const FRAME_c_attack304 = 401;
export const FRAME_c_attack307 = 404;
export const FRAME_c_attack310 = 407;
export const FRAME_c_attack321 = 418;
export const FRAME_c_attack401 = 419;
export const FRAME_c_attack405 = 423;
export const FRAME_c_attack501 = 424;
export const FRAME_c_attack505 = 428;
export const FRAME_c_attack601 = 429;
export const FRAME_c_attack605 = 433;
export const FRAME_c_attack701 = 434;
export const FRAME_c_attack705 = 438;
export const FRAME_c_pain101 = 439;
export const FRAME_c_pain104 = 442;
export const FRAME_c_pain201 = 443;
export const FRAME_c_pain204 = 446;
export const FRAME_c_pain301 = 447;
export const FRAME_c_pain304 = 450;
export const FRAME_c_pain401 = 451;
export const FRAME_c_pain415 = 465;
export const FRAME_c_pain501 = 466;
export const FRAME_c_pain508 = 473;
export const FRAME_c_pain524 = 489;
export const FRAME_c_death101 = 490;
export const FRAME_c_death118 = 507;
export const FRAME_c_death201 = 508;
export const FRAME_c_death204 = 511;
export const FRAME_c_death301 = 512;
export const FRAME_c_death321 = 532;
export const FRAME_c_death401 = 533;
export const FRAME_c_death436 = 568;
export const FRAME_c_death501 = 569;
export const FRAME_c_death528 = 596;
export const FRAME_c_run101 = 597;
export const FRAME_c_run106 = 602;
export const FRAME_c_run201 = 603;
export const FRAME_c_run206 = 608;
export const FRAME_c_walk101 = 615;
export const FRAME_c_walk124 = 638;
export const FRAME_c_pain601 = 639;
export const FRAME_c_pain607 = 645;
export const FRAME_c_pain632 = 670;
export const FRAME_c_death601 = 671;
export const FRAME_c_death614 = 684;
export const FRAME_c_death701 = 685;
export const FRAME_c_death730 = 714;
export const FRAME_c_pain701 = 715;
export const FRAME_c_pain714 = 728;
export const FRAME_c_attack801 = 729;
export const FRAME_c_attack808 = 736;
export const FRAME_c_attack901 = 738;
export const FRAME_c_attack911 = 748;
export const FRAME_c_attack912 = 749;
export const FRAME_c_attack913 = 750;
export const FRAME_c_attack919 = 756;
export const FRAME_c_duckstep01 = 759;
export const FRAME_c_duckstep06 = 764;

export const MODEL_SCALE = 1.15;
