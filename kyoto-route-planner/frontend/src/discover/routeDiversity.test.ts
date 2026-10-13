import { describe, expect, it } from "vitest";
import type { DatasetRoute } from "./datasetTypes";
import { diverseRoutes, similarTrip } from "./routeDiversity";
const route = (id: string, names: string[]): DatasetRoute => ({ id, spots: names.map((name, i) => ({ place_id: name, name, lat: 40.8, lng: 140.7 + i * .0001 })) } as DatasetRoute);
describe("trip diversity", () => {
  it("does not repeat Aomori Forest Museum as the anchor with different side trips", () => {
    const first = route("first", ["青森市森林博物館", "公園", "港"]);
    expect(diverseRoutes([first, route("second", ["青森市森林博物館", "市場", "庭園"])])).toEqual([first]);
  });
  it("deduplicates reordered trips and mostly overlapping itineraries", () => {
    const first = route("first", ["A", "B", "C"]);
    expect(diverseRoutes([first, route("reordered", ["C", "A", "B"]), route("similar", ["B", "C", "D"])] )).toEqual([first]);
  });
  it("recognizes alternate IDs for the same nearby named facility", () => {
    const a = route("a", ["森林博物館", "公園"]), b = route("b", ["森林博物館", "庭園"]);
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
