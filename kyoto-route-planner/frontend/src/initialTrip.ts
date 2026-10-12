import { clockMinutes, distanceKm, newTripStop, scheduleTrip } from "./dayTrip";
import type { TripInput, TripPlan } from "./dayTrip";
import { preferenceMatches, preferenceReason } from "./tripPreferences";
import type { Origin, Place, RouteSuggestion } from "./types";

export type InitialTripOptions = {
  input: TripInput;
  origin: Origin;
  returnTo: Origin;
  date: string;
  candidates: Place[];
  maxStops: number;
  radiusKm?: number;
  foodEstimate: number | null;
  coffeeEstimate: number | null;
  transportEstimate: number | null;
};

function visitDuration(place: Place) {
  const matches = preferenceMatches({ ...place, themes: [] });
  if (matches.includes("coffee")) return { preferred: 40, minimum: 25 };
  if (matches.includes("food")) return { preferred: 60, minimum: 40 };
  if (matches.includes("culture")) return { preferred: 60, minimum: 30 };
  if (matches.includes("nature")) return { preferred: 50, minimum: 25 };
  return { preferred: 45, minimum: 25 };
}

/** A local draft: no provider calls, admission fees or timetable claims. */
export function createInitialTrip(options: InitialTripOptions): TripPlan {
  const { input, origin, returnTo, date, foodEstimate, coffeeEstimate, transportEstimate } = options;
  const preferences = input.preferences ?? [];
  const maxStops = Number.isFinite(options.maxStops) ? Math.max(1, Math.min(3, Math.floor(options.maxStops))) : 1;
  const departure = clockMinutes(input.departureTime);
  const spending = (place: Place) => {
    // A route's food theme can also tag a museum on that route. Only an
    // actual dining/cafe category or name receives a personal meal allocation.
    const matches = preferenceMatches({ ...place, themes: [] });
    return matches.includes("coffee") ? coffeeEstimate : matches.includes("food") ? foodEstimate : null;
  };
  const relevance = (place: Place) => preferenceMatches(place).filter(preference => preferences.includes(preference)).length;
  const proximity = (place: Place) => distanceKm(origin, place) + distanceKm(place, returnTo);
  const byId = (a: Place, b: Place) => a.id.localeCompare(b.id, "en");
  const candidates = [...new Map(options.candidates.filter(place => Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
    && distanceKm(origin, place) <= (options.radiusKm ?? 50)).map(place => [place.id, place])).values()];
  const ranked = [...candidates].sort((a, b) => relevance(b) - relevance(a) || proximity(a) - proximity(b) || byId(a, b));
  // Preserve affordable and nearby alternatives even if many higher-ranked
  // candidates have the same theme. At most 14 places enter the exhaustive search.
  const shortlist: Place[] = [];
  const add = (place: Place | undefined) => { if (place && !shortlist.some(item => item.id === place.id) && shortlist.length < 14) shortlist.push(place); };
  for (const preference of preferences) {
    const matching = ranked.filter(place => preferenceMatches(place).includes(preference));
    add(matching[0]);
    add([...matching].sort((a, b) => (spending(a) ?? 0) - (spending(b) ?? 0) || proximity(a) - proximity(b) || byId(a, b))[0]);
  }
  for (const place of [...candidates].sort((a, b) => proximity(a) - proximity(b) || byId(a, b)).slice(0, 3)) add(place);
  for (const place of ranked) add(place);
  const makePlan = (places: Place[]) => {
    const source: RouteSuggestion = { origin, return_to: returnTo, places, legs: [], fare_yen: null,
      total_minutes: null, departure_time: input.departureTime, arrival_time: null,
      title: places.length ? `${places.map(place => place.name).join("と")}を巡る旅` : "条件に合う候補を選びましょう",
      story: null, reasons: Object.fromEntries(places.map(place => [place.id, preferenceReason(place, preferences)])),
      note: "端末内の候補から作成した初期案です。移動は徒歩換算の概算で、営業時間・入場料・運行時刻は未確認です。",
      coordinates: [[origin.latitude, origin.longitude], ...places.map(place => [place.latitude, place.longitude] as [number, number]), [returnTo.latitude, returnTo.longitude]],
    };
    const stops = places.map(place => ({ ...newTripStop(place, visitDuration(place).preferred), spending: spending(place) }));
    const compute = () => ({ ...scheduleTrip(input, origin, date, stops, { route: source, date, time: input.departureTime }, transportEstimate, returnTo),
      planningEstimates: { food: foodEstimate, coffee: coffeeEstimate } });
    let plan = compute();
    // Shorten in small rounds rather than exhausting the last visit first.
    while (plan.returnMinute > departure + input.availableMinutes) {
      let shortened = false;
      for (const stop of stops) {
        const reduction = Math.min(5, stop.dwellMinutes - visitDuration(stop.place).minimum, plan.returnMinute - departure - input.availableMinutes);
        if (reduction <= 0) continue;
        stop.dwellMinutes -= reduction;
        plan = compute();
        shortened = true;
      }
      if (!shortened) break;
    }
    return plan;
  };
  let best: TripPlan | null = null;
  let bestScore = -Infinity;
  const visit = (selected: Place[]) => {
    if (selected.length) {
      const plan = makePlan(selected);
      if (plan.returnMinute > departure + input.availableMinutes || plan.knownCost > input.budget) return;
      const covered = new Set(selected.flatMap(place => preferenceMatches(place).filter(preference => preferences.includes(preference))));
      const matchCount = selected.reduce((sum, place) => sum + relevance(place), 0);
      const reduction = selected.reduce((sum, place, index) => sum + visitDuration(place).preferred - plan.stops[index].dwellMinutes, 0);
      const score = covered.size * 1000 + matchCount * 150 + selected.length * 100 - reduction - plan.travelMinutes / 10 - plan.knownCost / 100_000;
      if (score > bestScore) { best = plan; bestScore = score; }
    }
    if (selected.length === maxStops) return;
    for (const place of shortlist) if (!selected.some(item => item.id === place.id)) visit([...selected, place]);
  };
  visit([]);
  if (best) return best;
  const empty = makePlan([]);
  return { ...empty, violations: [...empty.violations,
    candidates.length ? "使える時間・判明分の予算で立ち寄れる初期案がありません。条件または帰着先を見直してください。" : "出発地から50km以内の候補がありません。出発地や候補を見直してください。"] };
}
