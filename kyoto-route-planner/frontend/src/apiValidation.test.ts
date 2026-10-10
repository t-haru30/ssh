import { describe, expect, it } from "vitest";
import { isRouteIdea } from "./apiValidation";

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
