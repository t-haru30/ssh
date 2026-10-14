import { expect, it } from "vitest";
import { requestedWishes, wishCoverage } from "./travelWishes";
import { isCafe, isMealPlace, facilityThemes } from "./placeThemes";
import type { Place } from "./types";

const cafe: Place = {id:"cafe",name:"L'orma attiva",category:"施設",latitude:35,longitude:135,themes:["history"],description:"",access_point:"",tags:{amenity:"cafe"}};
it("recognizes OSM cafe evidence as a break, and distinguishes real restaurants", () => {
  expect(isCafe(cafe)).toBe(true);
  expect(isMealPlace(cafe)).toBe(false);
  expect(facilityThemes(cafe)).toEqual(["food"]);
  expect(isCafe({...cafe,name:"Blue Coffee",tags:{}})).toBe(true);
  expect(isMealPlace({...cafe,name:"Cafe Restaurant",category:"レストラン",tags:{amenity:"restaurant"}})).toBe(true);
});
it("scores each different explicit wish once and keeps avoided wishes out", () => {
  const garden={...cafe,id:"garden",name:"日本庭園",category:"庭園",tags:{}};
  expect(wishCoverage("庭園とカフェ",[garden,cafe])).toBe(2);
  expect(wishCoverage("庭園とカフェ",[cafe,cafe,cafe])).toBe(1);
  expect(requestedWishes("カフェには寄らない。庭園へ行きたい")).toEqual(["庭園"]);
});
