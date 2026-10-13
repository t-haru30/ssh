import { describe, it, expect } from "vitest";
import { composeLocalRoutes, isDiscoverResponse } from "./dynamicRoutes";
import { facilityThemes, isUnsuitablePlace } from "../placeThemes";
import type { Place } from "../types";
const entry = { id: "kyoto", prefecture_code: "26", name: "京都府", center: [35, 135] as [number, number], route_count: 5, file: "kyoto.json" };
const origin = { name: "駅", latitude: 35, longitude: 135 };
const conditions = { entry, origin, theme: "all" as const, course: "all" as const, radius: 3, crossPrefecture: false, variation: 0 };
function place(id: string, lat: number, area = "kyoto", category = "公園"): Place { return { id, name: id, latitude: lat, longitude: 135, category, themes: ["nature"], description: "", access_point: "", tags: { area } }; }
describe("local facility composition", () => {
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
