import { isOrigin, isPlace, isRecord } from "./apiValidation";
import { parseJourneyDraftData } from "./journeyDraft";
import type { JourneyDraft } from "./journeyDraft";
import type { TripPlan } from "./dayTrip";
import type { Origin, Place } from "./types";

export const MAX_JOURNEY_FILE_BYTES = 200_000;
const invalid = () => new Error("保存ファイルの形式や旅程データが不正です。ConcierGOのJSONファイルを確認してください。");
const textWithin = (v: unknown, max: number, required = false): v is string =>
  typeof v === "string" && v.length <= max && (!required || v.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
function endpoint(value: unknown): Origin {
  if (!isOrigin(value) || !textWithin(value.name, 80, true)) throw invalid();
  return { name: value.name, latitude: value.latitude, longitude: value.longitude };
}
function place(value: unknown): Place {
  if (!isPlace(value) || !textWithin(value.id, 200, true) || !textWithin(value.name, 200, true)
    || !textWithin(value.category, 100)) throw invalid();
  // Only location identity and catalog classification are portable. Descriptions,
  // provider tags/reviews, AI explanations and extra properties never cross this boundary.
  return { id: value.id, name: value.name, category: value.category,
    latitude: value.latitude, longitude: value.longitude, themes: [...new Set(value.themes)], description: "", access_point: "" };
}

/** Pure parser: never changes local storage or the active journey. v1 drafts remain importable. */
export function parseJourneyFile(text: string): JourneyDraft {
  if (new TextEncoder().encode(text).byteLength > MAX_JOURNEY_FILE_BYTES)
    throw new Error("保存ファイルは200KB以内にしてください。");
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("JSONファイルを読み取れませんでした。"); }
  if (!isRecord(data) || (data.version !== 1 && data.version !== 2))
    throw new Error("対応していない保存ファイルのバージョンです。");
  if (!textWithin(data.title, 500) || !Array.isArray(data.stops)) throw invalid();
  const origin = endpoint(data.origin);
  const returnTo = data.returnTo === undefined ? origin : endpoint(data.returnTo);
  const stops = data.stops.map(stop => {
    if (!isRecord(stop)) throw invalid();
    return { place: place(stop.place), dwellMinutes: stop.dwellMinutes, locked: stop.locked,
      anchorTime: stop.anchorTime, spending: stop.spending,
      ...(stop.completed !== undefined ? { completed: stop.completed } : {}),
      ...(stop.completedStart !== undefined ? { completedStart: stop.completedStart } : {}),
      ...(stop.completedEnd !== undefined ? { completedEnd: stop.completedEnd } : {}),
      ...(stop.completedTravel !== undefined ? { completedTravel: stop.completedTravel } : {}) };
  });
  const route = { origin, return_to: returnTo, places: stops.map(stop => stop.place), legs: [],
    title: null, story: null, total_minutes: null, fare_yen: null, departure_time: null, arrival_time: null,
    timeline: [], coordinates: [], note: "読み込んだ旅程の移動は未確認です。移動情報を更新してください。" };
  const parsed = parseJourneyDraftData({ version: 1, title: data.title, savedAt: data.savedAt,
    input: data.input, origin, returnTo, date: data.date, stops,
    ...(data.planningEstimates !== undefined ? { planningEstimates: data.planningEstimates } : {}),
    transportEstimate: data.transportEstimate, transport: { route, date: "", time: "" } });
  if (!parsed) throw invalid();
  return parsed;
}

/** Export intent only; transport/provider payloads and derived totals are deliberately omitted. */
export function serializeJourneyFile(plan: TripPlan, title: string): string {
  const data = { version: 2, title, savedAt: new Date().toISOString(),
    input: { departureTime: plan.input.departureTime, availableMinutes: plan.input.availableMinutes,
      budget: plan.input.budget, ...(plan.input.preferences !== undefined ? { preferences: [...plan.input.preferences] } : {}) },
    origin: endpoint(plan.origin), returnTo: endpoint(plan.returnTo), date: plan.date,
    ...(plan.planningEstimates ? { planningEstimates: { food: plan.planningEstimates.food, coffee: plan.planningEstimates.coffee } } : {}),
    transportEstimate: plan.transportEstimate,
    stops: plan.stops.map(stop => ({ place: place(stop.place), dwellMinutes: stop.dwellMinutes,
      locked: stop.locked, anchorTime: stop.anchorTime, spending: stop.spending,
      completed: stop.completed ?? false, completedStart: stop.completedStart ?? null,
      completedEnd: stop.completedEnd ?? null, completedTravel: stop.completedTravel ?? null })) };
  const text = JSON.stringify(data, null, 2);
  parseJourneyFile(text);
  return text;
}
