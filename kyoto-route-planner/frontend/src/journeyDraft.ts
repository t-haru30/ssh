import { isOrigin, isPlace, isRecord, isRouteSuggestions } from "./apiValidation";
import { MAX_TRIP_STOPS, scheduleTrip } from "./dayTrip";
import type { TripPlan, TripStop } from "./dayTrip";
import { isPreference } from "./tripPreferences";
import type { Preference, RouteSuggestion } from "./types";

export const JOURNEY_DRAFT_KEY = "yorimichi:journey-draft:v1";
export type JourneyDraft = { plan: TripPlan; title: string; savedAt: string; sourceFavoriteId?: string };
const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const isTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

/** Rebuild derived schedules rather than trusting stale or malformed browser data. */
export function readJourneyDraft(): JourneyDraft | null {
  try {
    const raw = window.localStorage.getItem(JOURNEY_DRAFT_KEY);
    if (!raw || new TextEncoder().encode(raw).byteLength > 200_000) return null;
    return parseJourneyDraftData(JSON.parse(raw));
  } catch { return null; }
}

export function parseJourneyDraftData(data: unknown): JourneyDraft | null {
  try {
    if (!isRecord(data) || data.version !== 1 || !isRecord(data.input) || !isOrigin(data.origin)
      || typeof data.title !== "string" || data.title.length > 500
      || typeof data.date !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(data.date)
      || new Date(`${data.date}T12:00:00Z`).toISOString().slice(0, 10) !== data.date
      || !isTime(data.input.departureTime) || !isInteger(data.input.availableMinutes, 30, 720)
      || !isInteger(data.input.budget, 0, 50_000)
      || !(data.input.preferences === undefined || (Array.isArray(data.input.preferences)
        && data.input.preferences.every(isPreference) && new Set(data.input.preferences).size === data.input.preferences.length))
      || !(data.returnTo === undefined || isOrigin(data.returnTo))
      || !(data.planningEstimates === undefined || (isRecord(data.planningEstimates)
        && (data.planningEstimates.food === null || isInteger(data.planningEstimates.food, 0, 50_000))
        && (data.planningEstimates.coffee === null || isInteger(data.planningEstimates.coffee, 0, 50_000))))
      || !Array.isArray(data.stops) || data.stops.length > MAX_TRIP_STOPS
      || !isRecord(data.transport) || !isRecord(data.transport.route)
      || typeof data.transport.date !== "string" || typeof data.transport.time !== "string"
      || !(data.transportEstimate === null || isInteger(data.transportEstimate, 0, 50_000))
      || typeof data.savedAt !== "string" || !Number.isFinite(Date.parse(data.savedAt))) return null;
    const stops: TripStop[] = [];
    let pending = false;
    let lastCompletedEnd = 0;
    for (const stop of data.stops) {
      if (!isRecord(stop) || !isPlace(stop.place) || !isInteger(stop.dwellMinutes, 15, 360)
        || typeof stop.locked !== "boolean" || !(stop.anchorTime === null || isTime(stop.anchorTime))
        || !(stop.spending === null || isInteger(stop.spending, 0, 50_000))) return null;
      if (stop.completed !== undefined && typeof stop.completed !== "boolean") return null;
      if (stop.completed) {
        if (pending || !stop.locked || !isInteger(stop.completedStart, lastCompletedEnd, 100_000)
          || !isInteger(stop.completedEnd, stop.completedStart, 100_000)
          || stop.completedEnd - stop.completedStart !== stop.dwellMinutes
          || !(stop.completedTravel == null || isInteger(stop.completedTravel, 0, 50_000))) return null;
        lastCompletedEnd = stop.completedEnd;
      } else {
        pending = true;
        if (stop.completedStart != null || stop.completedEnd != null || stop.completedTravel != null) return null;
      }
      stops.push({ ...(stop.completed !== undefined ? { completed: stop.completed,
        completedStart: stop.completedStart as number | null ?? null, completedEnd: stop.completedEnd as number | null ?? null,
        completedTravel: stop.completedTravel as number | null ?? null } : {}), place: stop.place, dwellMinutes: stop.dwellMinutes, locked: stop.locked,
        anchorTime: stop.anchorTime, spending: stop.spending });
    }
    if (new Set(stops.map(stop => stop.place.id)).size !== stops.length) return null;
    const route: Record<string, unknown> = { ...data.transport.route, timeline: data.transport.route.timeline ?? [], coordinates: data.transport.route.coordinates ?? [] };
    const payload = { routes: [route] };
    // An empty local journey is valid even though a suggestion API always has a place.
    const validationPayload = { routes: [{ ...route, places: Array.isArray(route.places) && route.places.length === 0
      ? [{ ...data.origin, id: "empty-local-journey", category: "", description: "", access_point: "", themes: [] }]
      : route.places }] };
    if (!isRouteSuggestions(validationPayload) || validationPayload.routes[0].places.length > MAX_TRIP_STOPS
      || !(validationPayload.routes[0].total_minutes === null || isInteger(validationPayload.routes[0].total_minutes, 0, 50_000))) return null;
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const plan = scheduleTrip(
      { departureTime: data.input.departureTime, availableMinutes: data.input.availableMinutes, budget: data.input.budget,
        ...(data.input.preferences !== undefined ? { preferences: data.input.preferences as Preference[] } : {}) },
      data.origin, data.date, stops,
      { route: payload.routes[0] as unknown as RouteSuggestion, date: data.date < today ? "" : data.transport.date, time: data.transport.time }, data.transportEstimate,
      data.returnTo ?? data.origin,
    );
    if (isRecord(data.planningEstimates)) plan.planningEstimates = {
      food: data.planningEstimates.food as number | null, coffee: data.planningEstimates.coffee as number | null,
    };
    return { title: data.title, savedAt: data.savedAt, plan, ...(typeof data.sourceFavoriteId === "string" && data.sourceFavoriteId.length <= 2000 ? { sourceFavoriteId: data.sourceFavoriteId } : {}) };
  } catch { return null; }
}

export function saveJourneyDraft(plan: TripPlan, title: string, sourceFavoriteId?: string): boolean {
  try {
    const serialized = JSON.stringify({ version: 1, title: title.slice(0, 500), sourceFavoriteId,
      savedAt: new Date().toISOString(), input: plan.input, origin: plan.origin, returnTo: plan.returnTo, date: plan.date,
      ...(plan.planningEstimates ? { planningEstimates: plan.planningEstimates } : {}),
      stops: plan.stops.map(({ place, dwellMinutes, locked, anchorTime, spending, completed, completedStart, completedEnd, completedTravel }) => ({ place, dwellMinutes, locked, anchorTime, spending, completed, completedStart, completedEnd, completedTravel })),
      transport: { ...plan.transport, route: { ...plan.transport.route, coordinates: [] } }, transportEstimate: plan.transportEstimate,
    });
    if (new TextEncoder().encode(serialized).byteLength > 200_000) return false;
    window.localStorage.setItem(JOURNEY_DRAFT_KEY, serialized);
    return true;
  } catch { return false; }
}

export function clearJourneyDraft() {
  try { window.localStorage.removeItem(JOURNEY_DRAFT_KEY); return true; } catch { return false; }
}
