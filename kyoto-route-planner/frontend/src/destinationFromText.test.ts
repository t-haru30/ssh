import { describe, expect, it } from "vitest";
import { destinationsFromText } from "./destinationFromText";

const origins = {
  kyoto: { name: "京都駅", latitude: 34.985849, longitude: 135.758766 },
  tokyo: { name: "東京駅", latitude: 35.681236, longitude: 139.767125 },
  ishikawa: { name: "金沢駅", latitude: 36.578081, longitude: 136.647718 },
  aichi: { name: "名古屋駅", latitude: 35.1709, longitude: 136.8815 },
  gifu: { name: "岐阜駅", latitude: 35.409619, longitude: 136.756736 },
  iwate: { name: "盛岡駅", latitude: 39.701433, longitude: 141.136919 },
  mie: { name: "津駅", latitude: 34.734624, longitude: 136.510118 },
};
const names = (text: string) => destinationsFromText(text, origins).map(item => item.origin.name);

describe("destination from written wishes", () => {
  it.each([["金沢で庭園を歩きたい", "金沢駅"], ["石川県でおいしいものを食べたい", "金沢駅"],
    ["盛岡冷麺を食べたい", "盛岡駅"], ["岐阜でのんびりしたい", "岐阜駅"],
    ["渋谷でカフェに寄りたい", "渋谷駅"], ["宇治駅で寺社を巡りたい", "宇治駅"]])("maps %s to a known station", (text, name) => {
    expect(names(text)).toEqual([name]);
    expect(destinationsFromText(text, origins)[0].origin).toEqual(expect.objectContaining({latitude:expect.any(Number),longitude:expect.any(Number)}));
  });
  it("distinguishes Tokyo from Kyoto and deduplicates station and prefecture mentions", () => {
    expect(names("東京都で博物館へ行きたい")).toEqual(["東京駅"]);
    expect(names("石川県の金沢駅周辺を歩きたい")).toEqual(["金沢駅"]);
  });
  it("ignores departures and offers distinct destination choices", () => {
    expect(names("名古屋から金沢へ行きたい")).toEqual(["金沢駅"]);
    expect(names("出発地点は京都駅。金沢でご飯を食べたい")).toEqual(["金沢駅"]);
    expect(names("名古屋から出発したい")).toEqual([]);
    expect(names("名古屋から伊豆に行きたい")).toEqual([]);
    expect(names("金沢と京都を巡りたい")).toEqual(["金沢駅", "京都駅"]);
  });
  it("returns the matching prefecture and area with the station", () => {
    expect(destinationsFromText("金沢へ行きたい", origins)[0]).toEqual({placeName:"金沢",area:"ishikawa",prefecture:"石川県",origin:origins.ishikawa});
    expect(destinationsFromText("渋谷へ行きたい", origins)[0]).toEqual(expect.objectContaining({area:"tokyo",prefecture:"東京都"}));
  });
  it("ignores negated locations, generic wishes and partial one-character names", () => {
    expect(names("京都ではなく金沢でカフェに寄りたい")).toEqual(["金沢駅"]);
    expect(names("庭園を歩き、温泉でゆっくりしたい")).toEqual([]);
    expect(names("大津で歩きたい")).toEqual([]);
    expect(names("津市で散策したい")).toEqual(["津駅"]);
  });
});
