import { describe, expect, it } from "vitest";
import { googleMapsUrl } from "./mapLinks";

describe("Google Maps links", () => {
  it.each(["京都国立博物館", "カフェ & レストラン", "庭園（京都）"])("preserves the Japanese facility name %s", name => {
    const url = new URL(googleMapsUrl({ name, address: "京都市", latitude: 35.01, longitude: 135.76 }));
    expect(url.searchParams.get("query")).toBe(`${name} 京都市`);
  });
  it("uses the name alone when no address is available and coordinates only for unnamed points", () => {
    expect(new URL(googleMapsUrl({name: " 京都駅 ", latitude: 35, longitude: 135})).searchParams.get("query")).toBe("京都駅");
    expect(new URL(googleMapsUrl({latitude: 35, longitude: 135})).searchParams.get("query")).toBe("35,135");
  });
  it.each([NaN, Infinity, 91])("rejects invalid coordinates %s", latitude => {
    expect(() => googleMapsUrl({ latitude, longitude: 135 })).toThrow();
  });
});
