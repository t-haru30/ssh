import { isOvernightItinerary, isRecord } from "./apiValidation";
import { cleanOvernight } from "./overnightSanitize";
import type { OvernightItinerarySuggestion, Theme } from "./types";
import type { RouteIdea } from "./SwipeCard";

export type OvernightSnapshot = { version: 1; itinerary: OvernightItinerarySuggestion; departureDate: string; departureTime: string; nights: number; stopsPerDay: number; radius: number; mood: string };
export type OvernightResult = { snapshot: OvernightSnapshot; theme: Theme };
export function parseOvernightResult(value: unknown): OvernightResult {
  if (!isRecord(value) || !["all", "history", "temple", "nature", "food"].includes(value.theme as string)) throw new Error("保存した宿泊条件が正しくありません。");
  return { snapshot: parseOvernightSnapshot(value.snapshot), theme: value.theme as Theme };
}
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const date = (v: unknown): v is string => typeof v === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
export function parseOvernightSnapshot(v: unknown): OvernightSnapshot {
  if (!isRecord(v) || v.version !== 1 || !isOvernightItinerary(v.itinerary)
    || !date(v.departureDate) || typeof v.departureTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.departureTime)
    || !integer(v.nights, 1, 6) || !integer(v.stopsPerDay, 1, 8) || !integer(v.radius, 1, 200)
    || typeof v.mood !== "string" || v.mood.length > 2000 || v.itinerary.days.length !== v.nights + 1
    || v.itinerary.days.some((day, index) => day.day !== index + 1 || !date(day.date) || day.places.length > 8 || !Number.isFinite(day.stay_minutes) || day.stay_minutes < 0)
    || new TextEncoder().encode(JSON.stringify(v)).byteLength > 1_000_000) throw new Error("保存する宿泊旅程の形式が正しくありません。");
  return { version: 1, itinerary: cleanOvernight(v.itinerary), departureDate: v.departureDate, departureTime: v.departureTime,
    nights: v.nights, stopsPerDay: v.stopsPerDay, radius: v.radius, mood: v.mood };
}
export function savedOvernight(snapshot: OvernightSnapshot, theme: Theme): RouteIdea {
  const clean = parseOvernightSnapshot(snapshot);
  const { itinerary } = clean;
  const places = [...new Map(itinerary.days.flatMap(day => day.places).map(place => [place.id, place])).values()].slice(0, 8);
  if (!places.length) places.push(itinerary.hotel);
  return { theme, title: `${clean.nights}泊${clean.nights + 1}日・${itinerary.hotel.name}を拠点にする旅`.slice(0, 500),
    story: `自分で作成した宿泊旅程です。宿泊先：${itinerary.hotel.name}`, places, origin: itinerary.origin, overnight_snapshot: clean,
    image_url: null, author_name: null, source_url: null, license_name: null, license_url: null, copywriting_source: "fallback", note: "自作の宿泊ルート。保存時の行き先を保持しています。交通情報は未確認です。" };
}
