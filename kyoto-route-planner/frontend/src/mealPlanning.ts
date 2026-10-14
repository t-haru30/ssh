import { distanceKm } from "./dayTrip";
import type { Origin, Place } from "./types";

export const MEALS = [
  { kind: "breakfast", label: "朝ごはん", time: "08:30" },
  { kind: "lunch", label: "昼ごはん", time: "12:00" },
  { kind: "dinner", label: "夜ごはん", time: "18:00" },
] as const;
export type MealChoice = { kind: (typeof MEALS)[number]["kind"]; time?: string | null };
export const mealTime = (meal: MealChoice) => meal.time || MEALS.find(m => m.kind === meal.kind)!.time;
export const minuteOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clockOf = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export function mealError(meals: MealChoice[]) {
  const ordered = MEALS.flatMap(m => meals.filter(c => c.kind === m.kind));
  return ordered.some((m, i) => i > 0 && minuteOf(mealTime(m)) < minuteOf(mealTime(ordered[i - 1])) + 90)
    ? "食事の時間は朝・昼・夜の順に、90分以上あけてください。" : "";
}

/** Insert sightseeing only when it fits before the next requested meal. */
export function planMeals(places: Place[], meals: MealChoice[], origin: Origin, course: string, dwell: (p: Place) => number, isMeal: (p: Place) => boolean) {
  const choices = MEALS.flatMap(m => meals.filter(c => c.kind === m.kind));
  const venues = places.filter(isMeal), pending = places.filter(p => !isMeal(p));
  if (venues.length !== choices.length || mealError(choices)) return null;
  const first = choices[0];
  const departure = first ? Math.max(0, Math.min(540, minuteOf(mealTime(first)) - 30)) : 540;
  const start = course === "half_day" && first ? Math.max(0, minuteOf(mealTime(first)) - (first.kind === "breakfast" ? 30 : 120)) : departure;
  let cursor: Origin = origin, now = start;
  const ordered: Place[] = [], roles: Record<string, MealChoice["kind"]> = {}, anchors: Record<string, string> = {};
  const travel = (a: Origin, b: Origin) => Math.ceil(distanceKm(a, b) / 25 * 60) + 10;
  function add(p: Place) { now += travel(cursor, p) + dwell(p); cursor = p; ordered.push(p); }
  for (let i = 0; i < choices.length; i++) {
    const meal = choices[i], venue = venues[i], target = minuteOf(mealTime(meal));
    while (pending.length && now + travel(cursor, pending[0]) + dwell(pending[0]) + travel(pending[0], venue) <= target) add(pending.shift()!);
    const arrival = now + travel(cursor, venue);
    if (arrival > target + (meal.time ? 0 : 90)) return null;
    const at = Math.max(arrival, target);
    anchors[venue.id] = clockOf(at); roles[venue.id] = meal.kind;
    ordered.push(venue); now = at + dwell(venue); cursor = venue;
  }
  pending.forEach(add);
  return { ordered, roles, anchors, departure: clockOf(start), minutes: now + travel(cursor, origin) - start };
}
