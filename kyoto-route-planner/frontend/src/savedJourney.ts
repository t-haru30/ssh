import type { TripPlan } from "./dayTrip";
import { serializeJourneyFile } from "./journeyFile";
import type { RouteIdea } from "./SwipeCard";
import type { Theme } from "./types";

/** Preserve editing intent without carrying provider responses into favorites. */
export function savedJourney(plan: TripPlan, theme: Theme, planTitle?: string): RouteIdea {
  const title = planTitle?.trim().slice(0, 500) || (plan.stops.map(stop => stop.place.name).join("と") + "の旅").slice(0, 500);
  return { theme, title, story: "自分で作成・編集した旅程です。", places: plan.stops.map(stop => stop.place), origin: plan.origin,
    dwell_minutes: Object.fromEntries(plan.stops.map(stop => [stop.place.id, stop.dwellMinutes])), journey_file: serializeJourneyFile(plan, title),
    image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
    copywriting_source: "fallback", note: "自作ルート" };
}
