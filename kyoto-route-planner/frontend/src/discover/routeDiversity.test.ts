import { describe, expect, it } from "vitest";
import type { DatasetRoute } from "./datasetTypes";
import { diverseRoutes, similarTrip } from "./routeDiversity";
const route = (id: string, names: string[]): DatasetRoute => ({ id, spots: names.map((name, i) => ({ place_id: name, name, lat: 40.8, lng: 140.7 + i * .0001 })) } as DatasetRoute);
describe("trip diversity", () => {
  it("retains explicit wish coverage ahead of extra meal novelty", () => {
    const wishes=route("wishes",["日本庭園","喫茶ひと休み"]), meals=route("meals",["食堂A","食堂B"]);
    wishes.spots[0].category="庭園"; wishes.spots[1].category="カフェ"; wishes.spots[1].role="break";
    meals.spots.forEach(s=>{s.category="飲食店";s.role="lunch";s.reason="庭園とカフェを巡る前に食事";});
    expect(diverseRoutes([meals,wishes],[],"庭園とカフェ")[0].id).toBe("wishes");
  });
  it("shows an alternative meal venue before another trip sharing the same restaurant", () => {
    const first = route("first",["博物館A","食堂A"]), repeat = route("repeat",["博物館B","食堂A"]), different = route("different",["博物館A","食堂B"]);
    for (const r of [first,repeat,different]) { r.spots[0].role = "stop"; r.spots[1].role = "lunch"; }
    expect(diverseRoutes([first,repeat,different]).map(r => r.id)).toEqual(["first","different","repeat"]);
  });
  it("allows a shared anchor when the rest of the day offers different places", () => {
    const first = route("first", ["青森市森林博物館", "公園", "港"]);
    expect(diverseRoutes([first, route("second", ["青森市森林博物館", "市場", "庭園"])]).map(r => r.id)).toEqual(["first","second"]);
  });
  it("deduplicates reordered trips but retains a different destination", () => {
    const first = route("first", ["A", "B", "C"]);
    expect(diverseRoutes([first, route("reordered", ["C", "A", "B"]), route("similar", ["B", "C", "D"])]).map(r => r.id)).toEqual(["first","similar"]);
  });
  it("recognizes alternate IDs for the same nearby named facility", () => {
    const a = route("a", ["森林博物館", "公園"]), b = route("b", ["森林博物館", "公園"]);
    b.spots[0].place_id = "alternate-osm-id";
    expect(similarTrip(a, b)).toBe(true);
  });
  it("prefers a new set of facilities before a partially shared alternative", () => {
    const a = route("a", ["A", "B", "C"]), partial = route("partial", ["D", "A", "E"]), fresh = route("fresh", ["F", "G", "H"]);
    expect(diverseRoutes([a, partial, fresh]).map(item => item.id)).toEqual(["a", "fresh", "partial"]);
  });
  it("does not resurface seen routes on regeneration, and permits an empty result", () => {
    const seen = route("seen", ["青森市森林博物館", "公園"]);
    expect(diverseRoutes([route("new-id", ["公園", "青森市森林博物館"])], [seen])).toEqual([]);
    const fresh = route("fresh", ["美術館", "市場"]);
    expect(diverseRoutes([seen, fresh], [seen])).toEqual([fresh]);
  });
});
