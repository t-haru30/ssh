import type { Place } from "./types";

const groups = [
  ["カフェ", "喫茶", "珈琲", "コーヒー", "coffee", "cafe", "café"], ["庭園", "日本庭園"],
  ["美術館", "美術"], ["博物館", "展示"], ["神社", "神宮", "大社"], ["寺院", "お寺", "寺めぐり"],
  ["公園"], ["展望", "夜景"], ["温泉"], ["市場", "商店街"], ["城", "城跡"],
  ["冷麺", "盛岡冷麺"], ["わんこそば"], ["じゃじゃ麺"], ["天ぷら", "てんぷら", "天麩羅"],
  ["寿司", "すし", "鮨"], ["海鮮", "海鮮丼"], ["おでん"], ["飛騨牛"], ["鮎"],
  ["工芸", "陶芸"], ["動物園", "動物"], ["水族館"], ["植物", "花", "桜"],
  ["体験", "ワークショップ", "工房"], ["買い物", "ショッピング", "土産"], ["甘味", "スイーツ", "和菓子", "ケーキ"],
];
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ja-JP");
const avoided = (text: string, word: string) => new RegExp(`${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:に|は|には|を)?(?:行きたくない|行かない|寄らない|避け|なし|不要)`).test(text);
export function requestedWishes(text: string): string[] {
  text = normalize(text);
  return groups.filter(words => words.some(word => text.includes(word) && !avoided(text, word))).map(words => words[0]);
}
export function wishMatches(text: string, place: Place): string[] {
  text = normalize(text);
  if (!text.trim()) return [];
  const evidence = normalize(`${place.name} ${place.category} ${place.description} ${Object.values(place.tags ?? {}).join(" ")}`);
  const name = normalize(place.name);
  return [...(name.length >= 3 && text.includes(name) && !avoided(text, name) ? [`place:${name}`] : []),
    ...groups.filter(words => words.some(word => text.includes(word) && !avoided(text, word)) && words.some(word => evidence.includes(word))).map(words => words[0])];
}
export const wishScore = (text: string, place: Place): number => wishMatches(text, place).reduce((sum, match) => sum + (match.startsWith("place:") ? 10 : 1), 0);
export const wishCoverage = (text: string, places: Place[]): number => [...new Set(places.flatMap(place => wishMatches(text, place)))].reduce((sum, match) => sum + (match.startsWith("place:") ? 10 : 1), 0);
