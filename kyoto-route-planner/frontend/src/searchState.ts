import { isOrigin, isOvernightItinerary, isRecord, isRouteSuggestions } from "./apiValidation";
import { isPreference } from "./tripPreferences";
import { cleanOvernight } from "./overnightSanitize";
export { cleanOvernight } from "./overnightSanitize";
import { parseOvernightResult, type OvernightResult } from "./overnightFavorite";
import type { Origin, OvernightItinerarySuggestion, Place, Preference, RouteSuggestion, Theme } from "./types";

export const SEARCH_FORM_KEY = "kyoto-route-planner:search-form:v1";
export const LEGACY_SAVED_PLAN_KEY = "kyoto-route-planner:saved-plan:v1";
export type SearchForm = {
  originName: string; nearbyStations: Origin[]; theme: Theme; mood: string; stopCount: number;
  departureDate: string; departureTime: string; isOvernight: boolean; regenerationCount: number;
  customOrigin?: Origin | null; customReturn?: Origin | null; returnSame?: boolean; returnName?: string;
  preferences?: Preference[]; initialMinutes?: string; initialBudget?: string;
  foodEstimate?: string; coffeeEstimate?: string; initialTransportEstimate?: string;
  nights?: number; travelRadius?: number;
};
const integer = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const origin = (v: unknown): v is Origin => isOrigin(v) && text(v.name, 200);
const cleanOrigin = (v: Origin): Origin => ({ name: v.name, latitude: v.latitude, longitude: v.longitude });
const date = (v: unknown) => v === "" || typeof v === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
function parseForm(v: unknown): SearchForm | null {
  if (isRecord(v) && (v.nights !== undefined && !integer(v.nights, 1, 6) || v.travelRadius !== undefined && !integer(v.travelRadius, 1, 200))) return null;
  if (!isRecord(v) || !text(v.originName, 200) || !Array.isArray(v.nearbyStations) || v.nearbyStations.length > 20 || !v.nearbyStations.every(origin)
    || !["all", "history", "temple", "nature", "food"].includes(v.theme as string) || !text(v.mood, 2000)
    || !integer(v.stopCount, 1, 8) || !date(v.departureDate)
    || !(v.departureTime === "" || typeof v.departureTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.departureTime))
    || typeof v.isOvernight !== "boolean" || !integer(v.regenerationCount, 0, 10000)
    || ![v.customOrigin, v.customReturn].every(item => item === undefined || item === null || origin(item))
    || !(v.returnSame === undefined || typeof v.returnSame === "boolean") || !(v.returnName === undefined || text(v.returnName, 200))
    || !(v.preferences === undefined || Array.isArray(v.preferences) && v.preferences.length <= 5 && v.preferences.every(isPreference) && new Set(v.preferences).size === v.preferences.length)) return null;
  const numericFields = ["initialMinutes", "initialBudget", "foodEstimate", "coffeeEstimate", "initialTransportEstimate"] as const;
  for (const key of numericFields) if (!(v[key] === undefined || typeof v[key] === "string" && /^\d{0,5}$/.test(v[key]))) return null;
  const result: SearchForm = { originName: v.originName, nearbyStations: v.nearbyStations.map(cleanOrigin), theme: v.theme as Theme,
    mood: v.mood, stopCount: v.stopCount, departureDate: v.departureDate as string, departureTime: v.departureTime as string,
    isOvernight: v.isOvernight, regenerationCount: v.regenerationCount };
  if (v.customOrigin !== undefined) result.customOrigin = v.customOrigin === null ? null : cleanOrigin(v.customOrigin as Origin);
  if (v.customReturn !== undefined) result.customReturn = v.customReturn === null ? null : cleanOrigin(v.customReturn as Origin);
  if (v.returnSame !== undefined) result.returnSame = v.returnSame as boolean;
  if (v.returnName !== undefined) result.returnName = v.returnName as string;
  if (v.preferences !== undefined) result.preferences = [...v.preferences as Preference[]];
  if (v.nights !== undefined) result.nights = v.nights as number;
  if (v.travelRadius !== undefined) result.travelRadius = v.travelRadius as number;
  for (const key of numericFields) if (v[key] !== undefined) result[key] = v[key] as string;
  return result;
}
function read(key: string, limit: number): unknown {
  const raw = window.localStorage.getItem(key);
  if (!raw || new TextEncoder().encode(raw).byteLength > limit) return null;
  return JSON.parse(raw);
}
export function readSearchForm(): SearchForm | null { try { return parseForm(read(SEARCH_FORM_KEY, 20000)); } catch { return null; } }
export function saveSearchForm(form: SearchForm): boolean {
  try { const clean = parseForm(form); if (!clean) return false;
    const raw = JSON.stringify(clean); if (new TextEncoder().encode(raw).byteLength > 20000) return false;
    window.localStorage.setItem(SEARCH_FORM_KEY, raw); return true;
  } catch { return false; }
}
const cleanPlace = (p: Place): Place => ({ id: p.id, name: p.name, category: p.category, latitude: p.latitude, longitude: p.longitude,
  themes: [...p.themes], description: "", access_point: "" });
function cleanRoute(r: RouteSuggestion): RouteSuggestion {
  return { origin: cleanOrigin(r.origin), ...(r.return_to ? { return_to: cleanOrigin(r.return_to) } : {}), places: r.places.map(cleanPlace),
    title: r.title, story: null, legs: [], total_minutes: null, fare_yen: null, departure_time: null, arrival_time: null,
    timeline: [], coordinates: [], note: "保存済みの旅程です。移動情報は未確認です。" };
}
export function readLegacySavedPlan(): { suggestions: RouteSuggestion[]; overnightSuggestion: OvernightItinerarySuggestion | null; overnightResult?: OvernightResult } | null {
  try {
    const data = read(LEGACY_SAVED_PLAN_KEY, 1000000);
    if (!isRecord(data) || !Array.isArray(data.suggestions) || data.suggestions.length > 8
      || !(data.suggestions.length === 0 || isRouteSuggestions({ routes: data.suggestions.map(r => isRecord(r) ? { ...r, timeline: r.timeline ?? [], coordinates: r.coordinates ?? [] } : r) }))
      || !(data.overnightSuggestion === null || isOvernightItinerary(data.overnightSuggestion))) return null;
    const suggestions = data.suggestions as RouteSuggestion[];
    if (suggestions.some(r => r.places.length > 8) || data.overnightSuggestion && (data.overnightSuggestion.days.length > 8
      || data.overnightSuggestion.days.some(day => day.places.length > 8 || day.schedule.length > 100 || !date(day.date)))) return null;
    const overnightResult = data.overnightResult === undefined ? undefined : parseOvernightResult(data.overnightResult);
    return { suggestions: suggestions.map(cleanRoute), overnightSuggestion: overnightResult?.snapshot.itinerary ?? (data.overnightSuggestion ? cleanOvernight(data.overnightSuggestion) : null), ...(overnightResult ? { overnightResult } : {}) };
  } catch { return null; }
}
/** Day trips belong exclusively to the journey draft; this legacy slot only keeps overnight plans. */
export function saveLegacyPlan(_suggestions: RouteSuggestion[], overnightSuggestion: OvernightItinerarySuggestion | null, result?: OvernightResult | null): boolean {
  try {
    if (!overnightSuggestion) { window.localStorage.removeItem(LEGACY_SAVED_PLAN_KEY); return true; }
    if (!isOvernightItinerary(overnightSuggestion)) return false;
    const overnightResult = result ? parseOvernightResult(result) : undefined;
    const raw = JSON.stringify({ suggestions: [], overnightSuggestion: cleanOvernight(overnightSuggestion), ...(overnightResult ? { overnightResult } : {}) });
    if (new TextEncoder().encode(raw).byteLength > 1000000) return false;
    window.localStorage.setItem(LEGACY_SAVED_PLAN_KEY, raw); return true;
  } catch { return false; }
}
