// m_flash.c

// this file is included in both the game dll and quake2,
// the game needs it to source shot locations, the client
// needs it to position muzzle flashes

import { vec3, type Vec3 } from "../shared/math";
import { fixedLength } from "../shared/fixed";

const monster_flash_offset: readonly Vec3[] = fixedLength("monster_flash_offset", 212, [
  // flash 0 is not used
  vec3(0.0, 0.0, 0.0),

  // MZ2_TANK_BLASTER_1				1
  vec3(20.7, -18.5, 28.7),
  // MZ2_TANK_BLASTER_2				2
  vec3(16.6, -21.5, 30.1),
  // MZ2_TANK_BLASTER_3				3
  vec3(11.8, -23.9, 32.1),
  // MZ2_TANK_MACHINEGUN_1			4
  vec3(22.9, -0.7, 25.3),
  // MZ2_TANK_MACHINEGUN_2			5
  vec3(22.2, 6.2, 22.3),
  // MZ2_TANK_MACHINEGUN_3			6
  vec3(19.4, 13.1, 18.6),
  // MZ2_TANK_MACHINEGUN_4			7
  vec3(19.4, 18.8, 18.6),
  // MZ2_TANK_MACHINEGUN_5			8
  vec3(17.9, 25.0, 18.6),
  // MZ2_TANK_MACHINEGUN_6			9
  vec3(14.1, 30.5, 20.6),
  // MZ2_TANK_MACHINEGUN_7			10
  vec3(9.3, 35.3, 22.1),
  // MZ2_TANK_MACHINEGUN_8			11
  vec3(4.7, 38.4, 22.1),
  // MZ2_TANK_MACHINEGUN_9			12
  vec3(-1.1, 40.4, 24.1),
  // MZ2_TANK_MACHINEGUN_10			13
  vec3(-6.5, 41.2, 24.1),
  // MZ2_TANK_MACHINEGUN_11			14
  vec3(3.2, 40.1, 24.7),
  // MZ2_TANK_MACHINEGUN_12			15
  vec3(11.7, 36.7, 26.0),
  // MZ2_TANK_MACHINEGUN_13			16
  vec3(18.9, 31.3, 26.0),
  // MZ2_TANK_MACHINEGUN_14			17
  vec3(24.4, 24.4, 26.4),
  // MZ2_TANK_MACHINEGUN_15			18
  vec3(27.1, 17.1, 27.2),
  // MZ2_TANK_MACHINEGUN_16			19
  vec3(28.5, 9.1, 28.0),
  // MZ2_TANK_MACHINEGUN_17			20
  vec3(27.1, 2.2, 28.0),
  // MZ2_TANK_MACHINEGUN_18			21
  vec3(24.9, -2.8, 28.0),
  // MZ2_TANK_MACHINEGUN_19			22
  vec3(21.6, -7.0, 26.4),
  // MZ2_TANK_ROCKET_1				23
  vec3(6.2, 29.1, 49.1),
  // MZ2_TANK_ROCKET_2				24
  vec3(6.9, 23.8, 49.1),
  // MZ2_TANK_ROCKET_3				25
  vec3(8.3, 17.8, 49.5),

  // MZ2_INFANTRY_MACHINEGUN_1		26
  vec3(26.6, 7.1, 13.1),
  // MZ2_INFANTRY_MACHINEGUN_2		27
  vec3(18.2, 7.5, 15.4),
  // MZ2_INFANTRY_MACHINEGUN_3		28
  vec3(17.2, 10.3, 17.9),
  // MZ2_INFANTRY_MACHINEGUN_4		29
  vec3(17.0, 12.8, 20.1),
  // MZ2_INFANTRY_MACHINEGUN_5		30
  vec3(15.1, 14.1, 21.8),
  // MZ2_INFANTRY_MACHINEGUN_6		31
  vec3(11.8, 17.2, 23.1),
  // MZ2_INFANTRY_MACHINEGUN_7		32
  vec3(11.4, 20.2, 21.0),
  // MZ2_INFANTRY_MACHINEGUN_8		33
  vec3(9.0, 23.0, 18.9),
  // MZ2_INFANTRY_MACHINEGUN_9		34
  vec3(13.9, 18.6, 17.7),
  // MZ2_INFANTRY_MACHINEGUN_10		35
  vec3(15.4, 15.6, 15.8),
  // MZ2_INFANTRY_MACHINEGUN_11		36
  vec3(10.2, 15.2, 25.1),
  // MZ2_INFANTRY_MACHINEGUN_12		37
  vec3(-1.9, 15.1, 28.2),
  // MZ2_INFANTRY_MACHINEGUN_13		38
  vec3(-12.4, 13.0, 20.2),

  // MZ2_SOLDIER_BLASTER_1			39
  vec3(10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2),
  // MZ2_SOLDIER_BLASTER_2			40
  vec3(21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_1			41
  vec3(10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_2			42
  vec3(21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_1			43
  vec3(10.6 * 1.2, 7.7 * 1.2, 7.8 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_2			44
  vec3(21.1 * 1.2, 3.6 * 1.2, 19.0 * 1.2),

  // MZ2_GUNNER_MACHINEGUN_1			45
  vec3(30.1 * 1.15, 3.9 * 1.15, 19.6 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_2			46
  vec3(29.1 * 1.15, 2.5 * 1.15, 20.7 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_3			47
  vec3(28.2 * 1.15, 2.5 * 1.15, 22.2 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_4			48
  vec3(28.2 * 1.15, 3.6 * 1.15, 22.0 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_5			49
  vec3(26.9 * 1.15, 2.0 * 1.15, 23.4 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_6			50
  vec3(26.5 * 1.15, 0.6 * 1.15, 20.8 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_7			51
  vec3(26.9 * 1.15, 0.5 * 1.15, 21.5 * 1.15),
  // MZ2_GUNNER_MACHINEGUN_8			52
  vec3(29.0 * 1.15, 2.4 * 1.15, 19.5 * 1.15),
  // MZ2_GUNNER_GRENADE_1				53
  vec3(4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15),
  // MZ2_GUNNER_GRENADE_2				54
  vec3(4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15),
  // MZ2_GUNNER_GRENADE_3				55
  vec3(4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15),
  // MZ2_GUNNER_GRENADE_4				56
  vec3(4.6 * 1.15, -16.8 * 1.15, 7.3 * 1.15),

  // MZ2_CHICK_ROCKET_1				57
  //	-24.8, -9.0, 39.0,
  vec3(24.8, -9.0, 39.0), // PGM - this was incorrect in Q2

  // MZ2_FLYER_BLASTER_1				58
  vec3(12.1, 13.4, -14.5),
  // MZ2_FLYER_BLASTER_2				59
  vec3(12.1, -7.4, -14.5),

  // MZ2_MEDIC_BLASTER_1				60
  vec3(12.1, 5.4, 16.5),

  // MZ2_GLADIATOR_RAILGUN_1			61
  vec3(30.0, 18.0, 28.0),

  // MZ2_HOVER_BLASTER_1				62
  vec3(32.5, -0.8, 10.0),

  // MZ2_ACTOR_MACHINEGUN_1			63
  vec3(18.4, 7.4, 9.6),

  // MZ2_SUPERTANK_MACHINEGUN_1		64
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_MACHINEGUN_2		65
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_MACHINEGUN_3		66
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_MACHINEGUN_4		67
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_MACHINEGUN_5		68
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_MACHINEGUN_6		69
  vec3(30.0, 30.0, 88.5),
  // MZ2_SUPERTANK_ROCKET_1			70
  vec3(16.0, -22.5, 91.2),
  // MZ2_SUPERTANK_ROCKET_2			71
  vec3(16.0, -33.4, 86.7),
  // MZ2_SUPERTANK_ROCKET_3			72
  vec3(16.0, -42.8, 83.3),

  // --- Start Xian Stuff ---
  // MZ2_BOSS2_MACHINEGUN_L1			73
  vec3(32, -40, 70),
  // MZ2_BOSS2_MACHINEGUN_L2			74
  vec3(32, -40, 70),
  // MZ2_BOSS2_MACHINEGUN_L3			75
  vec3(32, -40, 70),
  // MZ2_BOSS2_MACHINEGUN_L4			76
  vec3(32, -40, 70),
  // MZ2_BOSS2_MACHINEGUN_L5			77
  vec3(32, -40, 70),
  // --- End Xian Stuff

  // MZ2_BOSS2_ROCKET_1				78
  vec3(22.0, 16.0, 10.0),
  // MZ2_BOSS2_ROCKET_2				79
  vec3(22.0, 8.0, 10.0),
  // MZ2_BOSS2_ROCKET_3				80
  vec3(22.0, -8.0, 10.0),
  // MZ2_BOSS2_ROCKET_4				81
  vec3(22.0, -16.0, 10.0),

  // MZ2_FLOAT_BLASTER_1				82
  vec3(32.5, -0.8, 10),

  // MZ2_SOLDIER_BLASTER_3			83
  vec3(20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_3			84
  vec3(20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_3			85
  vec3(20.8 * 1.2, 10.1 * 1.2, -2.7 * 1.2),
  // MZ2_SOLDIER_BLASTER_4			86
  vec3(7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_4			87
  vec3(7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_4			88
  vec3(7.6 * 1.2, 9.3 * 1.2, 0.8 * 1.2),
  // MZ2_SOLDIER_BLASTER_5			89
  vec3(30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_5			90
  vec3(30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_5			91
  vec3(30.5 * 1.2, 9.9 * 1.2, -18.7 * 1.2),
  // MZ2_SOLDIER_BLASTER_6			92
  vec3(27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_6			93
  vec3(27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_6			94
  vec3(27.6 * 1.2, 3.4 * 1.2, -10.4 * 1.2),
  // MZ2_SOLDIER_BLASTER_7			95
  vec3(28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_7			96
  vec3(28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_7			97
  vec3(28.9 * 1.2, 4.6 * 1.2, -8.1 * 1.2),
  // MZ2_SOLDIER_BLASTER_8			98
  //	34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2,
  vec3(31.5 * 1.2, 9.6 * 1.2, 10.1 * 1.2),
  // MZ2_SOLDIER_SHOTGUN_8			99
  vec3(34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2),
  // MZ2_SOLDIER_MACHINEGUN_8			100
  vec3(34.5 * 1.2, 9.6 * 1.2, 6.1 * 1.2),

  // --- Xian shit below ---
  // MZ2_MAKRON_BFG					101
  vec3(17, -19.5, 62.9),
  // MZ2_MAKRON_BLASTER_1				102
  vec3(-3.6, -24.1, 59.5),
  // MZ2_MAKRON_BLASTER_2				103
  vec3(-1.6, -19.3, 59.5),
  // MZ2_MAKRON_BLASTER_3				104
  vec3(-0.1, -14.4, 59.5),
  // MZ2_MAKRON_BLASTER_4				105
  vec3(2.0, -7.6, 59.5),
  // MZ2_MAKRON_BLASTER_5				106
  vec3(3.4, 1.3, 59.5),
  // MZ2_MAKRON_BLASTER_6				107
  vec3(3.7, 11.1, 59.5),
  // MZ2_MAKRON_BLASTER_7				108
  vec3(-0.3, 22.3, 59.5),
  // MZ2_MAKRON_BLASTER_8				109
  vec3(-6, 33, 59.5),
  // MZ2_MAKRON_BLASTER_9				110
  vec3(-9.3, 36.4, 59.5),
  // MZ2_MAKRON_BLASTER_10			111
  vec3(-7, 35, 59.5),
  // MZ2_MAKRON_BLASTER_11			112
  vec3(-2.1, 29, 59.5),
  // MZ2_MAKRON_BLASTER_12			113
  vec3(3.9, 17.3, 59.5),
  // MZ2_MAKRON_BLASTER_13			114
  vec3(6.1, 5.8, 59.5),
  // MZ2_MAKRON_BLASTER_14			115
  vec3(5.9, -4.4, 59.5),
  // MZ2_MAKRON_BLASTER_15			116
  vec3(4.2, -14.1, 59.5),
  // MZ2_MAKRON_BLASTER_16			117
  vec3(2.4, -18.8, 59.5),
  // MZ2_MAKRON_BLASTER_17			118
  vec3(-1.8, -25.5, 59.5),
  // MZ2_MAKRON_RAILGUN_1				119
  vec3(-17.3, 7.8, 72.4),

  // MZ2_JORG_MACHINEGUN_L1			120
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_L2			121
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_L3			122
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_L4			123
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_L5			124
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_L6			125
  vec3(78.5, -47.1, 96),
  // MZ2_JORG_MACHINEGUN_R1			126
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_MACHINEGUN_R2			127
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_MACHINEGUN_R3			128
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_MACHINEGUN_R4			129
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_MACHINEGUN_R5			130
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_MACHINEGUN_R6			131
  vec3(78.5, 46.7, 96),
  // MZ2_JORG_BFG_1					132
  vec3(6.3, -9, 111.2),

  // MZ2_BOSS2_MACHINEGUN_R1			133
  vec3(32, 40, 70),
  // MZ2_BOSS2_MACHINEGUN_R2			134
  vec3(32, 40, 70),
  // MZ2_BOSS2_MACHINEGUN_R3			135
  vec3(32, 40, 70),
  // MZ2_BOSS2_MACHINEGUN_R4			136
  vec3(32, 40, 70),
  // MZ2_BOSS2_MACHINEGUN_R5			137
  vec3(32, 40, 70),

  // --- End Xian Shit ---

  // ROGUE
  // note that the above really ends at 137
  // carrier machineguns
  // MZ2_CARRIER_MACHINEGUN_L1		138
  vec3(56, -32, 32),
  // MZ2_CARRIER_MACHINEGUN_R1		139
  vec3(56, 32, 32),
  // MZ2_CARRIER_GRENADE				140
  vec3(42, 24, 50),
  // MZ2_TURRET_MACHINEGUN			141
  vec3(16, 0, 0),
  // MZ2_TURRET_ROCKET				142
  vec3(16, 0, 0),
  // MZ2_TURRET_BLASTER				143
  vec3(16, 0, 0),
  // MZ2_STALKER_BLASTER				144
  vec3(24, 0, 6),
  // MZ2_DAEDALUS_BLASTER				145
  vec3(32.5, -0.8, 10.0),
  // MZ2_MEDIC_BLASTER_2				146
  vec3(12.1, 5.4, 16.5),
  // MZ2_CARRIER_RAILGUN				147
  vec3(32, 0, 6),
  // MZ2_WIDOW_DISRUPTOR				148
  vec3(57.72, 14.5, 88.81),
  // MZ2_WIDOW_BLASTER				149
  vec3(56, 32, 32),
  // MZ2_WIDOW_RAIL					150
  vec3(62, -20, 84),
  // MZ2_WIDOW_PLASMABEAM				151		// PMM - not used!
  vec3(32, 0, 6),
  // MZ2_CARRIER_MACHINEGUN_L2		152
  vec3(61, -32, 12),
  // MZ2_CARRIER_MACHINEGUN_R2		153
  vec3(61, 32, 12),
  // MZ2_WIDOW_RAIL_LEFT				154
  vec3(17, -62, 91),
  // MZ2_WIDOW_RAIL_RIGHT				155
  vec3(68, 12, 86),
  // MZ2_WIDOW_BLASTER_SWEEP1			156			pmm - the sweeps need to be in sequential order
  vec3(47.5, 56, 89),
  // MZ2_WIDOW_BLASTER_SWEEP2			157
  vec3(54, 52, 91),
  // MZ2_WIDOW_BLASTER_SWEEP3			158
  vec3(58, 40, 91),
  // MZ2_WIDOW_BLASTER_SWEEP4			159
  vec3(68, 30, 88),
  // MZ2_WIDOW_BLASTER_SWEEP5			160
  vec3(74, 20, 88),
  // MZ2_WIDOW_BLASTER_SWEEP6			161
  vec3(73, 11, 87),
  // MZ2_WIDOW_BLASTER_SWEEP7			162
  vec3(73, 3, 87),
  // MZ2_WIDOW_BLASTER_SWEEP8			163
  vec3(70, -12, 87),
  // MZ2_WIDOW_BLASTER_SWEEP9			164
  vec3(67, -20, 90),
  // MZ2_WIDOW_BLASTER_100			165
  vec3(-20, 76, 90),
  // MZ2_WIDOW_BLASTER_90				166
  vec3(-8, 74, 90),
  // MZ2_WIDOW_BLASTER_80				167
  vec3(0, 72, 90),
  // MZ2_WIDOW_BLASTER_70				168		d06
  vec3(10, 71, 89),
  // MZ2_WIDOW_BLASTER_60				169		d07
  vec3(23, 70, 87),
  // MZ2_WIDOW_BLASTER_50				170		d08
  vec3(32, 64, 85),
  // MZ2_WIDOW_BLASTER_40				171
  vec3(40, 58, 84),
  // MZ2_WIDOW_BLASTER_30				172		d10
  vec3(48, 50, 83),
  // MZ2_WIDOW_BLASTER_20				173
  vec3(54, 42, 82),
  // MZ2_WIDOW_BLASTER_10				174		d12
  vec3(56, 34, 82),
  // MZ2_WIDOW_BLASTER_0				175
  vec3(58, 26, 82),
  // MZ2_WIDOW_BLASTER_10L			176		d14
  vec3(60, 16, 82),
  // MZ2_WIDOW_BLASTER_20L			177
  vec3(59, 6, 81),
  // MZ2_WIDOW_BLASTER_30L			178		d16
  vec3(58, -2, 80),
  // MZ2_WIDOW_BLASTER_40L			179
  vec3(57, -10, 79),
  // MZ2_WIDOW_BLASTER_50L			180		d18
  vec3(54, -18, 78),
  // MZ2_WIDOW_BLASTER_60L			181
  vec3(42, -32, 80),
  // MZ2_WIDOW_BLASTER_70L			182		d20
  vec3(36, -40, 78),
  // MZ2_WIDOW_RUN_1					183
  vec3(68.4, 10.88, 82.08),
  // MZ2_WIDOW_RUN_2					184
  vec3(68.51, 8.64, 85.14),
  // MZ2_WIDOW_RUN_3					185
  vec3(68.66, 6.38, 88.78),
  // MZ2_WIDOW_RUN_4					186
  vec3(68.73, 5.1, 84.47),
  // MZ2_WIDOW_RUN_5					187
  vec3(68.82, 4.79, 80.52),
  // MZ2_WIDOW_RUN_6					188
  vec3(68.77, 6.11, 85.37),
  // MZ2_WIDOW_RUN_7					189
  vec3(68.67, 7.99, 90.24),
  // MZ2_WIDOW_RUN_8					190
  vec3(68.55, 9.54, 87.36),
  // MZ2_CARRIER_ROCKET_1				191
  vec3(0, 0, -5),
  // MZ2_CARRIER_ROCKET_2				192
  vec3(0, 0, -5),
  // MZ2_CARRIER_ROCKET_3				193
  vec3(0, 0, -5),
  // MZ2_CARRIER_ROCKET_4				194
  vec3(0, 0, -5),
  // MZ2_WIDOW2_BEAMER_1				195
  //	72.13, -17.63, 93.77,
  vec3(69.0, -17.63, 93.77),
  // MZ2_WIDOW2_BEAMER_2				196
  //	71.46, -17.08, 89.82,
  vec3(69.0, -17.08, 89.82),
  // MZ2_WIDOW2_BEAMER_3				197
  //	71.47, -18.40, 90.70,
  vec3(69.0, -18.4, 90.7),
  // MZ2_WIDOW2_BEAMER_4				198
  //	71.96, -18.34, 94.32,
  vec3(69.0, -18.34, 94.32),
  // MZ2_WIDOW2_BEAMER_5				199
  //	72.25, -18.30, 97.98,
  vec3(69.0, -18.3, 97.98),
  // MZ2_WIDOW2_BEAM_SWEEP_1			200
  vec3(45.04, -59.02, 92.24),
  // MZ2_WIDOW2_BEAM_SWEEP_2			201
  vec3(50.68, -54.7, 91.96),
  // MZ2_WIDOW2_BEAM_SWEEP_3			202
  vec3(56.57, -47.72, 91.65),
  // MZ2_WIDOW2_BEAM_SWEEP_4			203
  vec3(61.75, -38.75, 91.38),
  // MZ2_WIDOW2_BEAM_SWEEP_5			204
  vec3(65.55, -28.76, 91.24),
  // MZ2_WIDOW2_BEAM_SWEEP_6			205
  vec3(67.79, -18.9, 91.22),
  // MZ2_WIDOW2_BEAM_SWEEP_7			206
  vec3(68.6, -9.52, 91.23),
  // MZ2_WIDOW2_BEAM_SWEEP_8			207
  vec3(68.08, 0.18, 91.32),
  // MZ2_WIDOW2_BEAM_SWEEP_9			208
  vec3(66.14, 9.79, 91.44),
  // MZ2_WIDOW2_BEAM_SWEEP_10			209
  vec3(62.77, 18.91, 91.65),
  // MZ2_WIDOW2_BEAM_SWEEP_11			210
  vec3(58.29, 27.11, 92.0),

  // end of table
  vec3(0.0, 0.0, 0.0),
]);

export function monsterFlashOffset(): readonly Vec3[] {
  return monster_flash_offset;
}
