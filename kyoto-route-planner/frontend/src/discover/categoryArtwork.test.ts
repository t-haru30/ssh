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
  ])("classifies %s as %s", (name, category, label) => expect(categoryArtwork(place(name,category)).label).toBe(label));
  it("uses cuisine metadata, but does not invent a cuisine for an unknown restaurant", () => {
    expect(categoryArtwork(place("そばと和菓子のカフェ", "カフェ", {amenity:"cafe", cuisine:"soba;japanese"})).label).toBe("カフェ");
    expect(categoryArtwork(place("Local Kitchen", "飲食店", {cuisine:"tempura"})).label).toBe("天ぷら");
    expect(categoryArtwork(place("Sanzuian", "飲食店")).label).toBe("飲食店");
    expect(categoryArtwork({...place("資料館", "博物館"),description:"この後は天ぷらを楽しむ旅"}).label).toBe("博物館");
  });
});
