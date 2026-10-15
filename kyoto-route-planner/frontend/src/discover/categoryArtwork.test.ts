import { describe, expect, it } from "vitest";
import type { Place } from "../types";
import { categoryArtwork } from "./categoryArtwork";

const place = (name: string, category: string, tags?: Record<string, string>): Place => ({id:name,name,category,tags,latitude:35,longitude:135,description:"",access_point:"",themes:[]});
describe("venue category artwork", () => {
  it.each([
    ["天ぷら圓堂 岡ざき邸", "飲食店", "天ぷら"], ["地元の割烹", "飲食店", "和食・日本料理"],
    ["寿司店", "飲食店", "寿司"], ["銀閣寺ラーメン", "飲食店", "ラーメン"], ["手打ち蕎麦", "飲食店", "そば"],
    ["炭火焼肉", "飲食店", "焼肉"], ["和菓子の店", "飲食店", "和菓子・甘味"], ["森のカフェ", "カフェ", "カフェ"],
    ["資料館", "博物館", "博物館"], ["ラーメン博物館", "博物館", "博物館"], ["美術館", "美術館", "美術館"],
    ["清水寺", "寺院", "寺院"], ["神社", "神社", "神社"], ["平安神宮神苑", "史跡", "日本庭園"],
    ["二条城二ノ丸御殿", "史跡", "城・史跡"], ["山の公園", "公園", "自然・公園"],
    ["海辺のベーカリー", "ベーカリー", "ベーカリー"], ["駅前の居酒屋", "飲食店", "居酒屋"],
    ["手打ちうどん", "飲食店", "うどん"], ["日帰り温泉", "温泉", "温泉・入浴施設"],
    ["水族館", "観光施設", "水族館"], ["山の展望台", "展望台", "展望台"], ["砂浜海岸", "自然", "海辺・海岸"],
    ["うどん博物館", "博物館", "博物館"], ["温泉資料館", "博物館", "博物館"],
    ["海辺の美術館", "美術館", "美術館"], ["アートスペース", "art_space gallery", "美術館"],
  ])("classifies %s as %s", (name, category, label) => expect(categoryArtwork(place(name,category)).label).toBe(label));
  it("uses cuisine metadata, but does not invent a cuisine for an unknown restaurant", () => {
    expect(categoryArtwork(place("そばと和菓子のカフェ", "カフェ", {amenity:"cafe", cuisine:"soba;japanese"})).label).toBe("カフェ");
    expect(categoryArtwork(place("Local Kitchen", "飲食店", {cuisine:"tempura"})).label).toBe("天ぷら");
    expect(categoryArtwork(place("Sanzuian", "飲食店")).label).toBe("飲食店");
    expect(categoryArtwork({...place("資料館", "博物館"),description:"この後は天ぷらを楽しむ旅"}).label).toBe("博物館");
  });
  it("uses specific venue tags even with a generic category", () => {
    for (const [tags, label] of [
      [{shop:"bakery"}, "ベーカリー"], [{amenity:"pub"}, "飲食店"], [{tourism:"aquarium"}, "水族館"],
      [{tourism:"viewpoint"}, "展望台"], [{amenity:"public_bath"}, "温泉・入浴施設"], [{natural:"beach"}, "海辺・海岸"],
    ] as const) expect(categoryArtwork(place("地元の施設", "施設", tags)).label).toBe(label);
    expect(categoryArtwork(place("地元の食堂", "飲食店", {cuisine:"udon"})).label).toBe("うどん");
    expect(categoryArtwork(place("ベーカリーカフェ", "カフェ", {shop:"bakery",amenity:"cafe"})).label).toBe("カフェ");
  });
  it("varies cafe artwork by venue while remaining stable when the itinerary role changes", () => {
    const cafes=[place("Garden Cafe A","カフェ"),place("Garden Cafe B","カフェ")];
    const images=cafes.map(cafe=>categoryArtwork(cafe).image);
    expect(new Set(images).size).toBe(2);
    for (const cafe of cafes) expect(categoryArtwork({...cafe,id:"a-different-itinerary-role"}).image).toBe(categoryArtwork(cafe).image);
    expect(categoryArtwork({...place("不明な飲食店","飲食店"),description:"温泉とうどんを楽しむ"}).label).toBe("飲食店");
  });
});
