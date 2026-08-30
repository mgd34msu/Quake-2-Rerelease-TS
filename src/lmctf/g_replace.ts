// Ports lmctf60/g_replace.c (570 lines) -- LM_CTF's radio/voice-macro text
// expander: `string_replace` substitutes `%<letter>` directives (location,
// armor, health, weapon, etc.) into a message template, and
// `visibility_test`/`replace_*` are its per-directive implementations.
//
// STATUS: complete. Every function in g_replace.c is ported: string_replace,
// visibility_test, replace_location, replace_armor, replace_health,
// replace_artifact, replace_weapon, replace_team, replace_visibleplayers,
// replace_flaginfo, replace_viewinfo, replace_carrierinfo, LowerCase.
//
// Cross-dependencies into lmctf60/g_ctffunc.c symbols this unit does not
// own (ctf_teamstring/ctf_getteamflag/ctf_flagathome -- not yet in unit A's
// g_ctffunc.ts) stay local throwing stubs, cited below. Everything else
// (G_Find, findradius/findallradius, ArmorIndex/PowerArmorType/FindItem/
// ITEM_INDEX/GetItemByIndex, Info_ValueForKey, ctf_validateplayer,
// redflag/blueflag) has already landed in the foundation and is imported
// for real (checked immediately before writing this file).

import { Vec3, VectorSubtract, VectorLength, vec3 } from "../shared/math";
import { Info_ValueForKey, MASK_SOLID } from "../shared/q_shared";
import {
  blueflag,
  type EdictT,
  type GItemT,
  gi,
  MovetypeT,
  POWER_ARMOR_SCREEN,
  redflag,
} from "./g_local";
import {
  CTF_TEAM_BLUE,
  CTF_TEAM_IGNORETEAM,
  CTF_TEAM_LIMIT,
  CTF_TEAM_MATCHING,
  CTF_TEAM_OPPOSING,
  CTF_TEAM_RED,
  CTF_TEAM_UNDEFINED,
  ctf_validateplayer,
} from "./g_ctffunc";
import { ArmorIndex, FindItem, GetItemByIndex, ITEM_INDEX, PowerArmorType } from "./g_items";
import { findallradius, findradius, G_Find, type EdictStringKey } from "./g_utils";

// ---------------------------------------------------------------------
// Cross-dependencies into lmctf60/g_ctffunc.c, not yet ported (owned by
// unit A's g_ctffunc.ts completion).
// ---------------------------------------------------------------------
function ctf_teamstring(_teamnum: number, _teamCompare: number): string {
  throw new Error("ctf_teamstring not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

function ctf_getteamflag(_teamnum: number, _teamCompare: number): EdictT | null {
  throw new Error("ctf_getteamflag not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

function ctf_flagathome(_flag: EdictT): boolean {
  throw new Error("ctf_flagathome not yet ported (lmctf60/g_ctffunc.c; owned by unit A's g_ctffunc.ts completion)");
}

// ---------------------------------------------------------------------

/*
=================
LowerCase (lmctf60/g_replace.c:559)
=================
*/
export function LowerCase(src: string): string {
  return src.toLowerCase();
}

/*
=================
visibility_test (lmctf60/g_replace.c:114)

MOVETYPE_PUSH entities (doors, plats, trains) have origins that don't
correspond to their visible position, so a trace to/from them is
meaningless -- treated as "can't see it" for either endpoint.
=================
*/
export function visibility_test(one: EdictT, two: EdictT): boolean {
  // movetype push obs have bogus origins
  if (one.movetype === MovetypeT.MOVETYPE_PUSH) return false; // pretend we can't see it
  if (two.movetype === MovetypeT.MOVETYPE_PUSH) return false; // pretend we can't see it

  const traceresult = gi.trace(one.s.origin, null, null, two.s.origin, one, MASK_SOLID);
  return traceresult.fraction === 1.0;
}

const CLASSNAME: EdictStringKey = "classname" as EdictStringKey;

/*
=================
replace_location (lmctf60/g_replace.c:131)

Finds the "most interesting" nearby object (weighted by type, then by
inverse distance, then filtered by visibility) within 1024 units and
describes its relative position ("north of the red base", "at Flag", ...).
`positionvalid` gates whether map-placed `info_position`/team-base
entities count; `lineofsight` gates whether out-of-sight objects are
skipped entirely.
=================
*/
export function replace_location(person: EdictT, positionvalid: boolean, lineofsight: boolean): string {
  let cur: EdictT | null = null;
  let fav: EdictT | null = null;
  let favrating = 0;
  let favname: string | null = null;
  let noprefix = false;

  while ((cur = findallradius(cur, person.s.origin, 1024)) !== null) {
    const name = cur.item !== null && cur.item.classname !== null ? cur.item.classname : (cur.classname ?? "");

    let currating = 1;
    let showname: string | null = null;

    if (name === "flag") {
      if ((redflag !== null && cur === redflag && person === redflag.owner) || (blueflag !== null && cur === blueflag && person === blueflag.owner)) {
        continue;
      }
      showname = "Flag";
      currating *= 10;
    } else if ((name === "info_flag_red" || name === "info_flag_blue") && positionvalid) {
      showname = "Base";
      currating *= 12;
    } else if (name === "info_position" && positionvalid) {
      // Skip this if spawnflags is 1, and it is not visible.
      if (!visibility_test(person, cur) && (cur.spawnflags & 1) !== 0) continue;
      showname = cur.message;
      currating *= 1000;
      if ((cur.spawnflags & 2) !== 0) noprefix = true;
    } else if (name === "item_quad" || name === "item_invulnerability") {
      currating *= 8;
    } else if (name === "item_health_mega") {
      showname = "Mega Health";
      currating *= 7;
    } else if (name === "weapon_bfg" || name === "weapon_railgun" || name === "weapon_rocketlauncher" || name === "weapon_hyperblaster") {
      currating *= 6;
    } else if (name === "weapon_chaingun" || name === "weapon_grenadelauncher") {
      currating *= 5;
    } else if (name === "weapon_machinegun" || name === "weapon_supershotgun" || name === "weapon_shotgun") {
      currating *= 4;
    } else if (name === "item_power_screen" || name === "item_power_shield") {
      currating *= 5;
    } else if (name === "item_armor_body" || name === "item_armor_combat" || name === "item_armor_jacket") {
      currating *= 4;
    } else if (
      name === "item_silencer" ||
      name === "item_breather" ||
      name === "item_enviro" ||
      name === "item_adrenaline" ||
      name === "item_bandolier" ||
      name === "item_pack"
    ) {
      currating *= 3;
    } else if (cur.item === null) {
      continue;
    } else {
      currating *= 1;
    }
    // ok, we now have a preliminary rating based on the type of object.
    // now lets decide a bit based on the distance to the ob

    const distvector: Vec3 = vec3();
    VectorSubtract(person.s.origin, cur.s.origin, distvector);
    let curdist = VectorLength(distvector);

    // don't count distances less than a playerwidth away
    // as being significantly different
    if (curdist < 64) curdist = 64;

    currating *= 12000 / curdist; // score increases for small distances

    // and lets adjust the rating further by whether or not we
    // have line of sight to the object in question.

    // Don't tell us about powerup if they are not in sight
    if (!visibility_test(person, cur) && lineofsight) continue;

    if (currating > favrating) {
      // new winner
      fav = cur;
      favrating = currating;
      favname = showname;
    }
  }

  // test distances to the flags
  if (fav === null) {
    return "";
  }

  let temp = "";

  if (noprefix) {
    if (favname !== null) {
      temp += favname;
    } else if (fav.item !== null) {
      if (fav.item.pickup_name !== null) temp += fav.item.pickup_name;
      else if (fav.item.classname !== null) temp += fav.item.classname;
    } else {
      temp += fav.classname ?? "";
    }
    return temp;
  }

  const distvector: Vec3 = vec3();
  VectorSubtract(fav.s.origin, person.s.origin, distvector);
  if (VectorLength(distvector) < 128) {
    temp = "at ";
  } else if (Math.abs(distvector[0]) > Math.abs(distvector[1]) && Math.abs(distvector[0]) > Math.abs(distvector[2])) {
    // 0 Biggest
    temp = distvector[0] > 0 ? "north of " : "south of ";
  } else if (Math.abs(distvector[1]) > Math.abs(distvector[2])) {
    // 1 biggest
    temp = distvector[1] > 0 ? "west of " : "east of ";
  } else {
    // 2 biggest
    temp = distvector[2] > 0 ? "below " : "above ";
  }

  if (!positionvalid) temp += "the ";

  const redFlagSpot = G_Find(null, CLASSNAME, "info_flag_red");
  const blueFlagSpot = G_Find(null, CLASSNAME, "info_flag_blue");
  if (redFlagSpot === null || blueFlagSpot === null) {
    throw new Error("replace_location: info_flag_red/info_flag_blue not found (lmctf60/g_replace.c:317-322 dereferences both unconditionally)");
  }
  const redDelta: Vec3 = vec3();
  VectorSubtract(fav.s.origin, redFlagSpot.s.origin, redDelta);
  const reddist = VectorLength(redDelta);
  const blueDelta: Vec3 = vec3();
  VectorSubtract(fav.s.origin, blueFlagSpot.s.origin, blueDelta);
  const bluedist = VectorLength(blueDelta);

  if (!positionvalid) {
    if (reddist > 2 * bluedist) {
      // closer to blue
      temp += "blue ";
    } else if (bluedist > 2 * reddist) {
      // closer to red
      temp += "red ";
    }
  }

  if (favname !== null) {
    temp += favname;
  } else if (fav.item !== null) {
    if (fav.item.pickup_name !== null) temp += fav.item.pickup_name;
    else if (fav.item.classname !== null) temp += fav.item.classname;
  } else {
    temp += fav.classname ?? "";
  }

  return temp;
}

/*
=================
replace_armor (lmctf60/g_replace.c:350)
=================
*/
export function replace_armor(person: EdictT): string {
  let temp = "";
  let hasArmor = false;

  const power_armor_type = PowerArmorType(person);

  if (power_armor_type !== 0 && person.client !== null) {
    const cellsItem = FindItem("cells");
    const test = cellsItem !== null ? person.client.pers.inventory[ITEM_INDEX(cellsItem)] : 0;
    if (test) {
      hasArmor = true;
      temp = `${test} cells of `;
      temp += power_armor_type === POWER_ARMOR_SCREEN ? "power screen " : "power shield ";
    }
  }

  const armorTest = ArmorIndex(person);
  if (armorTest !== 0 && person.client !== null) {
    const item = GetItemByIndex(armorTest);
    if (item !== null) {
      hasArmor = true;
      if (temp.length > 1) temp += "and ";
      temp += `${person.client.pers.inventory[armorTest]} of ${item.pickup_name ?? ""}`;
    }
  }

  if (!hasArmor) temp += "no armor";

  return temp;
}

/*
=================
replace_health (lmctf60/g_replace.c:395)
=================
*/
export function replace_health(person: EdictT): string {
  if (person.health <= 0) return "dead";

  let temp = `${person.health} health`;
  let sum = 0;

  let cur: EdictT | null = null;
  while ((cur = findradius(cur, person.s.origin, 256)) !== null) {
    if (
      cur.classname === "item_health_small" ||
      cur.classname === "item_health_large" ||
      cur.classname === "item_health" ||
      cur.classname === "item_health_mega"
    ) {
      sum += cur.count;
    }
  }

  if (person.health < person.max_health) {
    temp += " with ";
    temp += sum ? `${sum} ` : "none ";
    temp += "nearby";
  }

  return temp;
}

/*
=================
replace_artifact (lmctf60/g_replace.c:432)
=================
*/
export function replace_artifact(person: EdictT): string {
  if (person.client !== null && person.client.rune !== null) {
    if (person.client.rune.item !== null) {
      return person.client.rune.item.pickup_name ?? "";
    }
    return "an unnamed artifact of power";
  }
  return "no artifact";
}

/*
=================
replace_weapon (lmctf60/g_replace.c:451)
=================
*/
export function replace_weapon(person: EdictT): string {
  if (person.client !== null && person.client.pers.weapon !== null) {
    return person.client.pers.weapon.pickup_name ?? "";
  }
  return "no weapon";
}

/*
=================
replace_team (lmctf60/g_replace.c:459)
=================
*/
export function replace_team(person: EdictT): string {
  if (person.client === null) return "unassigned team";
  if (person.client.ctf.teamnum === CTF_TEAM_RED) return "red team";
  if (person.client.ctf.teamnum === CTF_TEAM_BLUE) return "blue team";
  return "unassigned team";
}

/*
=================
replace_visibleplayers (lmctf60/g_replace.c:470)

Not called anywhere in g_replace.c itself (not one of string_replace's
`%`-directive cases either) -- ported anyway since it is a real,
non-static, non-#ifdef'd function in the C source, exactly like every
other function here.
=================
*/
export function replace_visibleplayers(person: EdictT): string {
  let temp = "";
  let more_than_one = false;

  let cur: EdictT | null = null;
  while ((cur = findradius(cur, person.s.origin, 2048)) !== null) {
    if (cur.client !== null) {
      if (cur.inuse && cur !== person && visibility_test(person, cur)) {
        if (more_than_one) temp += " and";
        temp += cur.client.pers.netname;
        more_than_one = true;
      }
    }
  }

  return temp;
}

/*
=================
replace_flaginfo (lmctf60/g_replace.c:491)
=================
*/
export function replace_flaginfo(person: EdictT): string {
  if (!ctf_validateplayer(person, CTF_TEAM_IGNORETEAM)) return ""; // only works for valid players
  if (person.client === null) {
    throw new Error("replace_flaginfo: person.client is null after ctf_validateplayer passed (lmctf60/g_replace.c:502 dereferences it unconditionally)");
  }

  let temp = "";
  let flagcount = CTF_TEAM_UNDEFINED + 1;
  while (flagcount < CTF_TEAM_LIMIT) {
    temp += flagcount === person.client.ctf.teamnum ? "Your " : "The enemy ";
    temp += ctf_teamstring(flagcount, CTF_TEAM_MATCHING);
    temp += " flag ";
    const whichflag = ctf_getteamflag(flagcount, CTF_TEAM_MATCHING);
    if (whichflag === null) {
      temp += "is missing.  ";
    } else if (whichflag.owner !== null) {
      temp += "is held by ";
      temp += whichflag.owner.client !== null ? whichflag.owner.client.pers.netname : "";
      temp += ".  ";
    } else if (!ctf_flagathome(whichflag)) {
      temp += "is sitting around.  ";
    } else {
      temp += "is at home.  ";
    }

    flagcount++;
  }
  temp += "\n";

  return temp;
}

/*
=================
replace_viewinfo (lmctf60/g_replace.c:527)
=================
*/
export function replace_viewinfo(person: EdictT): string {
  if (person.client !== null && person.client.ctf.popup_ent !== null && person.client.ctf.popup_ent.client !== null) {
    // C: `temp[15] = 0;` truncates to 15 characters.
    return person.client.ctf.popup_ent.client.pers.netname.slice(0, 15);
  }
  return "";
}

/*
=================
replace_carrierinfo (lmctf60/g_replace.c:537)

The C source has no final `else` -- if `teamflag` is NULL, `temp` is left
as whatever the caller passed in (`strcpy(outmsg,inmsg)` in string_replace
already seeded it), i.e. this function can leave `tmpstr` from the
*previous* directive's expansion untouched. Preserved: returns null here
(string_replace's caller keeps the prior `tmpstr` value in that case,
exactly matching the C source never writing to `temp`).
=================
*/
export function replace_carrierinfo(person: EdictT): string | null {
  if (person.client === null) return null;
  const teamflag = ctf_getteamflag(person.client.ctf.teamnum, CTF_TEAM_OPPOSING);

  if (teamflag === null) return null;

  if (teamflag.owner !== null && ctf_validateplayer(teamflag.owner, person.client.ctf.teamnum)) {
    const ownerName = teamflag.owner.client !== null ? teamflag.owner.client.pers.netname : "";
    return `${ownerName} is at ${replace_location(teamflag.owner, true, true)}`;
  }
  return " no carrier";
}

/*
=================
string_replace (lmctf60/g_replace.c:4)

Expands `%<directive>` tokens in `inmsg` into `outmsg`. A directive is the
run of characters after '%' up to (not including) the next '%', ' ', or
end of string -- always at least one character, even if that character is
itself a delimiter (matching the C source's do-while, which copies
unconditionally before checking the stop condition). A single-character
directive dispatches to one of the replace_* functions by
(lowercased) letter, falling back to echoing that literal character for
an unrecognized letter; any other length looks the token up as a userinfo
key via Info_ValueForKey.
=================
*/
export function string_replace(person: EdictT, inmsg: string): string {
  let result = "";
  let tmpstr = "";
  let i = 0;

  while (i < inmsg.length) {
    const ch = inmsg[i];
    if (ch === "%") {
      i++; // advance to start with character after %
      // Collect the directive token: at least one character, then continue
      // until '%', ' ', or end of string. A trailing lone '%' (i >=
      // inmsg.length here) safely yields an empty token instead of the C
      // source's out-of-bounds read past the NUL terminator.
      let token = "";
      if (i < inmsg.length) {
        token += inmsg[i];
        i++;
        while (i < inmsg.length && inmsg[i] !== "%" && inmsg[i] !== " ") {
          token += inmsg[i];
          i++;
        }
      }
      i--; // back off because we went past the end

      if (token.length === 1) {
        switch (token.toLowerCase()) {
          case "l":
            tmpstr = replace_location(person, false, true);
            break;
          case "a":
            tmpstr = replace_armor(person);
            break;
          case "h":
            tmpstr = replace_health(person);
            break;
          case "t":
            tmpstr = replace_artifact(person);
            break;
          case "w":
            tmpstr = replace_weapon(person);
            break;
          case "n":
            tmpstr = replace_team(person);
            break;
          case "p":
            tmpstr = replace_location(person, true, false);
            break;
          case "f":
            tmpstr = replace_flaginfo(person);
            break;
          case "v":
            tmpstr = replace_viewinfo(person);
            break;
          case "c": {
            const carrierInfo = replace_carrierinfo(person);
            if (carrierInfo !== null) tmpstr = carrierInfo;
            break;
          }
          default:
            tmpstr = token;
            break;
        }
      } else {
        // use infovalueforkey feature
        if (person.client === null) {
          throw new Error("string_replace: person.client is null (lmctf60/g_replace.c:89 dereferences person->client unconditionally)");
        }
        tmpstr = Info_ValueForKey(person.client.pers.userinfo, token);
      }
    } else {
      tmpstr = ch ?? "";
    }
    result += tmpstr;
    i++;
  }

  return result;
}
