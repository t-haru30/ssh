import { describe, expect, it } from "vitest";
import { isOvernightItinerary, isRouteIdea, isSwipeItinerary, normalizeOvernightItinerary, normalizeSwipeItinerary } from "./apiValidation";

describe("normalizeOvernightItinerary", () => {
  const catalogPlace = (id: string) => ({
    id, name: id, category: "temple", region: "京都", address: "京都市", latitude: 35, longitude: 135,
    description: "d", tags: {},
  });
  const day = (n: number, lunch: unknown) => ({
    day: n, date: "2026-10-11", places: [catalogPlace(`p${n}`)],
    legs: [{ from_name: "a", to_name: "b", line_name: "徒歩", mode: "walk", duration_minutes: 5 }],
    schedule: [], lunch, transit_minutes: 5, stay_minutes: 90, estimated_arrival_at: null,
    coordinates: [[35, 135]],
  });
  const payload = (lunch: unknown) => ({
    query: { raw: "京都" },
    origin: { name: "京都駅", latitude: 34.98, longitude: 135.75 },
    hotel: catalogPlace("hotel"),
    days: [day(1, lunch), day(2, lunch)],
    fare_yen: null, feasible: true, route_search_calls: 1, note: "n",
  });

  it("accepts CatalogPlace-based payloads without access_point/themes", () => {
    const lunch = { type: "lunch", place: catalogPlace("l"), start_time: "12:00", end_time: "13:00", reason: "r" };
    expect(isOvernightItinerary(payload(lunch))).toBe(false);
    expect(isOvernightItinerary(normalizeOvernightItinerary(payload(lunch)))).toBe(true);
  });

  it("fills in a missing lunch", () => {
    expect(isOvernightItinerary(normalizeOvernightItinerary(payload(null)))).toBe(true);
  });
});

describe("normalizeSwipeItinerary", () => {
  it("accepts an itinerary whose catalog places lack access_point and themes", () => {
    const payload = {
      origin: { name: "京都駅", latitude: 34.98, longitude: 135.75 },
      places: [{
        id: "a",
        name: "清水寺",
        category: "寺院",
        region: "京都府",
        address: "京都市",
        latitude: 34.99,
        longitude: 135.78,
        description: "",
      }],
      legs: [{
        from_name: "京都駅",
        to_name: "清水寺",
        line_name: "車（概算）",
        mode: "car",
        duration_minutes: 10,
        departure_at: "2026-10-09T09:00:00",
        arrival_at: "2026-10-09T09:10:00",
      }],
      fare_yen: null,
      estimated_total_minutes: 100,
      estimated_return_at: "2026-10-09T10:50:00",
      note: "概算",
    };

    expect(isSwipeItinerary(payload)).toBe(false);
    expect(isSwipeItinerary(normalizeSwipeItinerary(payload))).toBe(true);
  });
});

const validIdea = {
  theme: "nature",
  title: "庭園を巡る",
  story: "自然を楽しむルートです。",
  places: [
    {
      id: "place-1",
      name: "庭園",
      category: "庭園",
      description: "",
      access_point: "",
      latitude: 35,
      longitude: 135,
      themes: ["nature"],
    },
    {
      id: "place-2",
      name: "公園",
      category: "公園",
      description: "",
      access_point: "",
      latitude: 35.1,
      longitude: 135.1,
      themes: ["nature"],
    },
  ],
  image_url: null,
  author_name: null,
  source_url: null,
  license_name: null,
  license_url: null,
  copywriting_source: "fallback",
  note: "",
};

describe("API response validation", () => {
  it("accepts a valid route idea", () => {
    expect(isRouteIdea(validIdea)).toBe(true);
  });

  it("rejects malformed places and non-HTTPS image URLs", () => {
    expect(isRouteIdea({
      ...validIdea,
      image_url: "http://images.example.test/idea.jpg",
    })).toBe(false);
    expect(isRouteIdea({
      ...validIdea,
      places: [validIdea.places[0], { ...validIdea.places[1], latitude: 100 }],
    })).toBe(false);
  });

  it("requires complete author, source, and license attribution for an image", () => {
    expect(isRouteIdea({
      ...validIdea,
      image_url: "https://upload.wikimedia.org/example.jpg",
      author_name: "Photographer",
      source_url: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      license_name: "CC BY-SA 4.0",
      license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
    })).toBe(true);
    expect(isRouteIdea({
      ...validIdea,
      image_url: "https://upload.wikimedia.org/example.jpg",
    })).toBe(false);
  });
});
