import { describe, it, expect } from "vitest";
import { composeLocalRoutes, isDiscoverResponse } from "./dynamicRoutes";
import { facilityThemes, isUnsuitablePlace } from "../placeThemes";
import type { Place } from "../types";
const entry = { id: "kyoto", prefecture_code: "26", name: "京都府", center: [35, 135] as [number, number], route_count: 5, file: "kyoto.json" };
const origin = { name: "駅", latitude: 35, longitude: 135 };
const conditions = { entry, origin, theme: "all" as const, course: "all" as const, radius: 3, crossPrefecture: false, variation: 0 };
function place(id: string, lat: number, area = "kyoto", category = "公園"): Place { return { id, name: id, latitude: lat, longitude: 135, category, themes: ["nature"], description: "", access_point: "", tags: { area } }; }
describe("local facility composition", () => {
  it("keeps relaxed full-day sightseeing and both meals when adding one cafe break", () => {
    const pool=[place("博物館",35.001,"kyoto","博物館"),place("日本庭園",35.002,"kyoto","庭園"),place("昼の食堂",35.003,"kyoto","飲食店"),place("夜の食堂",35.004,"kyoto","飲食店"),place("喫茶ひと休み",35.005,"kyoto","カフェ")];
    const routes=composeLocalRoutes({...conditions,course:"full_day",meals:[{kind:"lunch"},{kind:"dinner"}],traveler:{pace:"relaxed",companion:"unspecified",age_group:"unspecified",gender:"unspecified"},priorityText:"庭園とカフェに寄りたい"},pool);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].spots).toHaveLength(5);
    expect(new Set(routes[0].spots.map(s=>s.role))).toEqual(new Set(["stop","lunch","dinner","break"]));
    expect(routes[0].estimated_minutes).toBeLessThanOrEqual(720);
  });
  it("uses at most one 30-minute cafe break and covers separate written wishes", () => {
    const pool=[...Array.from({length:5},(_,i)=>({...place(`店${i}`,35+i*.0001),tags:{area:"kyoto",amenity:"cafe"}})),place("日本庭園",35.002,"kyoto","庭園"),place("美術館",35.003,"kyoto","美術館"),place("食堂",35.004,"kyoto","飲食店")];
    const routes=composeLocalRoutes({...conditions,theme:"history",course:"half_day",meals:[{kind:"lunch",time:"12:30"}],priorityText:"庭園を歩いてカフェに寄りたい",traveler:{pace:"packed",companion:"solo",age_group:"unspecified",gender:"unspecified"}},pool);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].spots.some(s=>s.name==="日本庭園")).toBe(true);
    expect(routes[0].spots.some(s=>s.role==="break")).toBe(true);
    for(const route of routes){
      expect(route.spots.filter(s=>s.role==="break").length).toBeLessThanOrEqual(1);
      expect(route.spots.filter(s=>s.role==="break").every(s=>s.stay_minutes===30)).toBe(true);
      expect(route.spots.filter(s=>s.role==="lunch")).toHaveLength(1);
    }
  });
  it("prioritizes explicitly written wishes in offline generation without bypassing geography", () => {
    const cafe = place("庭の喫茶店", 35.002, "kyoto", "カフェ");
    const pool = [place("博物館",35.001,"kyoto","博物館"), cafe, place("遠くのカフェ",36,"kyoto","カフェ")];
    const routes = composeLocalRoutes({ ...conditions, theme:"history", course:"half_day", meals:[], priorityText:"カフェでコーヒーを飲みたい" }, pool);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].spots.some(s => s.place_id === cafe.id)).toBe(true);
    expect(routes.every(r => !r.spots.some(s => s.place_id === "遠くのカフェ"))).toBe(true);
  });
  it("keeps both wish categories when a permitted nearby cafe is across a prefecture boundary", () => {
    const pool=[...Array.from({length:6},(_,i)=>place(`公園${i}`,35+i*.0001)),place("日本庭園",35.002,"kyoto","庭園"),place("喫茶ひと休み",35.003,"shiga","カフェ")];
    const routes=composeLocalRoutes({...conditions,crossPrefecture:true,priorityText:"庭園とカフェ",meals:[]},pool);
    expect(routes[0].spots.some(s=>s.name==="日本庭園")).toBe(true);
    expect(routes[0].spots.some(s=>s.name==="喫茶ひと休み")).toBe(true);
  });
  it("varies the lunch venue across candidates without adding a second restaurant", () => {
    const pool = [...Array.from({length:5}, (_,i) => place(`博物館${i}`,35 + i * .001,"kyoto","博物館")),
      ...Array.from({length:3}, (_,i) => place(`食堂${i}`,35.002 + i * .001,"kyoto","飲食店"))];
    const routes = composeLocalRoutes({...conditions,theme:"food",course:"half_day",meals:[{kind:"lunch"}]},pool);
    expect(new Set(routes.flatMap(r => r.spots.filter(s => s.role === "lunch").map(s => s.place_id))).size).toBe(3);
    for (const route of routes) expect(route.spots.filter(s => s.role === "lunch")).toHaveLength(1);
  });
  it("retains a restaurant beyond the initial 5km window when lunch and dinner are requested", () => {
    const pool = [...Array.from({length: 8}, (_, i) => place(`公園${i}`, 35 + i * .002)), place("昼食の店", 35.004, "kyoto", "飲食店"), place("夕食の店", 35.055, "kyoto", "飲食店")];
    const routes = composeLocalRoutes({...conditions, radius: 30, theme: "food", course: "full_day", meals: [{kind:"lunch"}, {kind:"dinner"}]}, pool);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route.spots.filter(s => s.role !== "stop").map(s => s.role)).toEqual(["lunch", "dinner"]);
  });
  it("accepts grounded AI reasons and rejects malformed source or agent metadata", () => {
    const route = { ...composeLocalRoutes(conditions, [place("博物館", 35.001)])[0], recommendation_source: "gemini", recommendation_reason: "歴史を巡る候補です。" };
    const response = { routes: [route], note: "推定時間", agent: { status: "ready", message: "AIが行き先を選びました。" } };
    expect(isDiscoverResponse(response)).toBe(true);
    const sources = [{ title: "公式の紹介", url: "https://museum.example.jp/about" }];
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, reason_sources: sources, spots: [{ ...route.spots[0], reason_sources: sources }] }] })).toBe(true);
    const unsafe = [{ title: "公式", url: "javascript:alert(1)" }];
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, reason_sources: unsafe }] })).toBe(false);
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, spots: [{ ...route.spots[0], reason_sources: unsafe }] }] })).toBe(false);
    expect(isDiscoverResponse({ ...response, agent: { status: "invented", message: "" } })).toBe(false);
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, recommendation_source: "unknown" }] })).toBe(false);
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, recommendation_reason: {} }] })).toBe(false);
    expect(isDiscoverResponse({ ...response, routes: [{ ...route, spots: [{ ...route.spots[0], reason: {} }] }] })).toBe(false);
  });
  it("keeps the radius a hard bound and returns a single stop for sparse areas", () => {
    const routes = composeLocalRoutes(conditions, [place("near", 35.01), place("outside", 35.1)]);
    expect(routes).toHaveLength(1); expect(routes[0].spots.map(p => p.place_id)).toEqual(["near"]); expect(routes[0].legs).toHaveLength(2);
  });
  it("includes nearby facilities across prefecture boundaries only when enabled", () => {
    const pool = [place("local", 35.001), place("neighbor", 35.002, "shiga")];
    expect(composeLocalRoutes(conditions, pool)[0].spots.map(p => p.place_id)).toEqual(["local"]);
    expect(composeLocalRoutes({ ...conditions, crossPrefecture: true }, pool)[0].spots.map(p => p.place_id)).toEqual(["local", "neighbor"]);
  });
  it("derives themes from each facility instead of inheriting the old route theme", () => {
    const cafe = place("川辺カフェ", 35.001, "kyoto", "カフェ");
    expect(facilityThemes(cafe)).toEqual(["food"]);
    expect(composeLocalRoutes({ ...conditions, theme: "nature" }, [cafe])).toEqual([]);
    expect(composeLocalRoutes({ ...conditions, theme: "food" }, [cafe])).toHaveLength(1);
  });
  it("excludes unsuitable names and categories from arbitrary automatic pools while preserving parks", () => {
    const names = "墓園|墓地|霊園|霊苑|斎場|斎苑|火葬場|葬祭|葬儀|納骨|工場|工業団地|病院|医院|クリニック|診療所|発電所|処理場|清掃センター".split("|");
    for (const name of names) {
      const unsuitable = place(`地域${name}`, 35.001);
      const categorized = place("地域施設", 35.001, "kyoto", name);
      const pool = [place("中央公園", 35.002), unsuitable, categorized];
      expect(composeLocalRoutes(conditions, pool)[0].spots.map(p => p.name)).toEqual(["中央公園"]);
    }
  });
  it("preserves famous exceptions including the exact sitelinks boundary", () => {
    const exceptions = [place("高野山奥の院", 35.001, "kyoto", "墓地"), place("奥之院霊園", 35.002),
      { ...place("歴史ある工場", 35.003), tags: { area: "kyoto", sitelinks: "10" } }];
    for (const candidate of exceptions) expect(isUnsuitablePlace(candidate)).toBe(false);
    expect(new Set(composeLocalRoutes(conditions, exceptions).flatMap(route => route.spots.map(p => p.name)))).toEqual(new Set(exceptions.map(p => p.name)));
    for (const sitelinks of ["9", "invalid", "1e1", "10x"]) {
      expect(isUnsuitablePlace({ ...exceptions[2], tags: { sitelinks } })).toBe(true);
    }
  });
  it("excludes lodging and respects the half-day time limit", () => {
    const routes = composeLocalRoutes({ ...conditions, course: "half_day" }, [place("park", 35.001), place("hotel", 35.002, "kyoto", "ホテル")]);
    expect(routes[0].estimated_minutes).toBeLessThanOrEqual(300); expect(routes[0].spots.map(p => p.place_id)).toEqual(["park"]);
  });
});

it("uses explicit pace independently of age, gender and companion", () => {
 const pool = [place("one", 35.001), place("two", 35.002), place("three", 35.003), place("four", 35.004), place("five", 35.005), place("six", 35.006)];
 const empty = { age_group: "unspecified" as const, gender: "unspecified" as const, companion: "unspecified" as const };
 expect(composeLocalRoutes({ ...conditions, traveler: empty }, pool)).toEqual(composeLocalRoutes(conditions, pool));
 for (const [pace, count, stay, fullStay] of [["relaxed", 2, 75, 120], ["standard", 3, 60, 105], ["packed", 4, 45, 75]] as const) {
   for (const age_group of ["under_18", "30_49", "65_plus"] as const) {
     const traveler = { ...empty, age_group, companion: "family" as const, pace };
     const route = composeLocalRoutes({ ...conditions, course: "half_day", traveler }, pool)[0];
     expect(route.spots).toHaveLength(count);
     expect(route.spots.every(spot => spot.stay_minutes === stay)).toBe(true);
     expect(route.estimated_minutes).toBeLessThanOrEqual(300);
     const full = composeLocalRoutes({ ...conditions, course: "full_day", traveler }, [...pool.slice(0, 5), place("夕食の店",35.003,"kyoto","レストラン")])[0];
     expect(full.spots).toHaveLength(Math.min(pool.length, count + 2));
     expect(full.spots[0].stay_minutes).toBe(fullStay);
     expect(full.estimated_minutes).toBeLessThanOrEqual(720);
     expect(full.estimated_minutes).toBeGreaterThanOrEqual(615);
     expect(full.spots.at(-1)?.role).toBe("dinner");
     expect(route.recommendation_reason).toContain(`${count}か所`);
   }
 }
});
it("keeps geographic and time constraints for every pace", () => {
 for (const pace of ["relaxed", "standard", "packed"] as const) {
   const traveler = { age_group: "65_plus" as const, gender: "unspecified" as const, companion: "family" as const, pace };
   const routes = composeLocalRoutes({ ...conditions, radius: 100, course: "half_day", traveler }, [place("near", 35.001), place("far", 35.8), place("outside", 36.2), place("neighbor", 35.002, "shiga")]);
   for (const route of routes) {
     expect(route.estimated_minutes).toBeLessThanOrEqual(300);
     expect(route.spots.map(spot => spot.place_id)).not.toContain("outside");
     expect(route.spots.map(spot => spot.place_id)).not.toContain("neighbor");
   }
 }
});

it("uses companion context to rank categories within the chosen theme and radius", () => {
 const pool = [place("近い公園", 35.001), place("美術館", 35.002, "kyoto", "美術館")];
 const traveler = { age_group: "unspecified" as const, gender: "unspecified" as const, companion: "solo" as const };
 expect(composeLocalRoutes(conditions, pool)[0].spots[0].name).toBe("近い公園");
 expect(composeLocalRoutes({ ...conditions, traveler }, pool)[0].spots[0].name).toBe("美術館");
 expect(composeLocalRoutes({ ...conditions, theme: "nature", traveler }, pool)[0].spots.map(p => p.name)).toEqual(["近い公園"]);
});

it("mixes regional food with sightseeing for a full day", () => {
 const base = { ...conditions, entry: {...entry,id:"iwate",name:"岩手県"}, origin:{name:"盛岡駅",latitude:39.702,longitude:141.136}, theme:"food" as const, course:"full_day" as const };
 const pool = Array.from({length:8}, (_,i) => ({...place(String(i),39.703+i*.001,"iwate",i === 0 ? "飲食店" : "博物館"), name:i === 0 ? "盛岡冷麺の店" : `博物館${i}`,longitude:141.137}));
 const routes = composeLocalRoutes(base,pool);
 expect(routes.length).toBeGreaterThan(0);
 for (const route of routes) {
   expect(route.spots.some(p => p.name === "盛岡冷麺の店")).toBe(true);
   expect(route.spots.length).toBeGreaterThanOrEqual(4);
   expect(route.estimated_minutes).toBeGreaterThanOrEqual(360);
 }
});
