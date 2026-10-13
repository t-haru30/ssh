import { describe, expect, it } from "vitest";
import { placeRecommendation } from "./placeRecommendation";
import type { Place } from "../types";
const origin = { name: "出発駅", latitude: 35, longitude: 135 };
const garden: Place = { ...origin, latitude: 35.005, id: "garden", name: "庭園", category: "公園", description: "", access_point: "", themes: ["nature"] };
describe("place recommendations grounded in the route", () => {
  it("uses the departure for the first stop and describes straight-line distance rather than travel time", () => {
    const reasons = placeRecommendation(garden, { origin, places: [garden], theme: "nature", stayMinutes: 45 });
    expect(reasons).toContain("自然や景色を楽しむ旅の立ち寄り先として選びました。");
    expect(reasons.join(" ")).toMatch(/出発駅から直線で約5\d0m/);
    expect(reasons.join(" ")).toContain("近いエリア");
    expect(reasons.join(" ")).toContain("45分の滞在");
    expect(reasons.join(" ")).not.toMatch(/徒歩\d|電車で/);
  });
  it("uses the actual preceding stop for a distant destination and asks to check transportation", () => {
    const next = { ...garden, id: "next", name: "遠い庭園", latitude: 35.105 };
    const reasons = placeRecommendation(next, { origin, places: [garden, next], theme: "all" });
    expect(reasons.join(" ")).toMatch(/庭園から直線で約11\.1km/);
    expect(reasons.join(" ")).toContain("移動時間は経路を確認");
    expect(reasons.join(" ")).not.toContain("出発駅から");
  });
  it("does not present a cafe as nature simply because the route or inherited themes say nature", () => {
    const cafe = { ...garden, id: "cafe", name: "街の喫茶店", category: "カフェ", themes: ["nature" as const] };
    const reasons = placeRecommendation(cafe, { origin, places: [cafe], theme: "nature" });
    expect(reasons[0]).toContain("食事や休憩");
    expect(reasons.join(" ")).not.toContain("自然や景色を楽しむ");
  });
  it("offers a cultural reason for a museum on a differently themed trip without claiming a theme match", () => {
    const museum = { ...garden, name: "地域資料館", category: "資料館", themes: [] };
    expect(placeRecommendation(museum, { origin, places: [museum], theme: "nature" })[0]).toContain("展示を通して地域の文化");
  });
  it("keeps unknown destinations neutral and omits geography when they are absent from the route", () => {
    const unknown = { ...garden, id: "unknown", name: "街の立ち寄り先", category: "その他", themes: [] };
    expect(placeRecommendation(unknown, { origin, places: [garden], theme: "temple", stayMinutes: 0 })).toEqual(["今回の旅で、街の立ち寄り先を訪ねる立ち寄り候補です。"]);
  });
  it("does not invent a distance when coordinates are unavailable", () => {
    const unknown = { ...garden, latitude: NaN };
    expect(placeRecommendation(unknown, { origin, places: [unknown], theme: "all" }).join(" ")).not.toMatch(/直線|NaN/);
  });
});
