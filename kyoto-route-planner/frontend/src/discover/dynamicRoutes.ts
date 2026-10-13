import { isReasonSources } from "./reasonSources";
import { distanceKm } from "../dayTrip";
import { localPlaces } from "../localPlaces";
import { distinctVenues } from "../venueIdentity";
import { facilityThemes, isUnsuitablePlace } from "../placeThemes";
import type { Origin, Theme } from "../types";
import type { DatasetRoute, RouteDatasetIndexEntry } from "./datasetTypes";

export type DiscoverConditions = { entry: RouteDatasetIndexEntry; origin: Origin; theme: Theme; course: "all" | "half_day" | "full_day"; radius: number; crossPrefecture: boolean; variation: number };

export { facilityThemes } from "../placeThemes";
const themeTitles: Record<Theme, string> = { all: "街歩き", history: "歴史と文化", temple: "寺社めぐり", nature: "自然と景色", food: "食のひととき" };

/** Offline composition from deduplicated facilities, with a hard geographic cap. */
export function composeLocalRoutes({ entry, origin, theme, course, radius, crossPrefecture, variation }: DiscoverConditions, pool = localPlaces): DatasetRoute[] {
  let candidates = distinctVenues(pool.filter(p => !isUnsuitablePlace(p) && (crossPrefecture || p.tags?.area === entry.id)
    && (theme === "all" || facilityThemes(p).includes(theme)) && !/ホテル|旅館|宿泊/.test(p.category)
    && distanceKm(origin, p) <= radius).sort((a, b) => distanceKm(origin, a) - distanceKm(origin, b) || a.id.localeCompare(b.id)));
  for (const r of [...new Set([Math.min(5, radius), Math.min(20, radius), radius])]) {
    const nearby = candidates.filter(p => distanceKm(origin, p) <= r);
    if (nearby.length >= 6) { candidates = nearby; break; }
  }
  const routes: DatasetRoute[] = [], seen = new Set<string>();
  const stay = course === "full_day" ? 105 : 60;
  for (let i = 0; i < Math.min(candidates.length, 80); i++) {
    const seed = candidates[(i + variation) % candidates.length];
    const ordered = [seed], remaining = candidates.filter(p => p.id !== seed.id);
    while (ordered.length < 3 && remaining.length) {
      remaining.sort((a, b) => distanceKm(ordered[ordered.length - 1], a) - distanceKm(ordered[ordered.length - 1], b) || a.id.localeCompare(b.id));
      ordered.push(remaining.shift()!);
    }
    const buildLegs = () => [origin, ...ordered, origin].slice(1).map((to, index) => {
      const from = [origin, ...ordered][index], distance = distanceKm(from, to);
      return { from: from.name, to: to.name, distance_km: distance, minutes: Math.ceil(distance / 25 * 60) + 10, mode: "public_transport" as const };
    });
    let legs = buildLegs();
    while (ordered.length && legs.reduce((sum, leg) => sum + leg.minutes, 0) + ordered.length * stay > (course === "half_day" ? 300 : 600)) {
      ordered.pop(); legs = buildLegs();
    }
    const signature = ordered.map(p => p.id).sort().join("|");
    if (!ordered.length || seen.has(signature)) continue;
    seen.add(signature);
    const minutes = legs.reduce((sum, leg) => sum + leg.minutes, 0) + ordered.length * stay;
    const pattern = course === "full_day" || minutes > 300 ? "full_day" : "half_day";
    routes.push({ id: `local-${entry.id}-${stay}-${ordered.map(p => p.id).join("-")}`, area: entry.id, theme, course: pattern, pattern,
      title: `${ordered[0].name}から、${themeTitles[theme]}を楽しむ旅`, estimated_minutes: minutes, legs, total_score: ordered.length,
      start: { name: origin.name, lat: origin.latitude, lng: origin.longitude, to_first_km: legs[0].distance_km, from_last_km: legs[legs.length - 1].distance_km },
      center: [origin.latitude, origin.longitude], coordinates: [origin, ...ordered, origin].map(p => [p.latitude, p.longitude]),
      spots: ordered.map(p => ({ place_id: p.id, name: p.name, category: p.category, lat: p.latitude, lng: p.longitude, stay_minutes: stay, role: "stop", score: 1, reason: p.address })) });
    if (routes.length === 12) break;
  }
  return routes;
}

export type DiscoveryAgent = { status: "ready" | "unavailable"; message: string };
export type DiscoverResponse = { routes: DatasetRoute[]; note: string; agent?: DiscoveryAgent };

export function isDiscoverResponse(value: unknown): value is DiscoverResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as { routes?: unknown; note?: unknown; agent?: unknown };
  const text = (v: unknown) => typeof v === "string" && v.length <= 2000;
  if (data.agent !== undefined) {
    if (!data.agent || typeof data.agent !== "object") return false;
    const agent = data.agent as DiscoveryAgent;
    if (!["ready", "unavailable"].includes(agent.status) || !text(agent.message)) return false;
  }
  return text(data.note) && Array.isArray(data.routes) && data.routes.length <= 20 && data.routes.every(route => {
    if (!route || typeof route !== "object") return false;
    const r = route as DatasetRoute;
    const coordinate = (v: unknown, max: number) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;
    return typeof r.id === "string" && typeof r.title === "string" && typeof r.area === "string"
      && (r.recommendation_source === undefined || ["gemini", "rules"].includes(r.recommendation_source))
      && (r.recommendation_reason === undefined || text(r.recommendation_reason))
      && isReasonSources(r.reason_sources)
      && ["all", "history", "temple", "nature", "food"].includes(r.theme)
      && ["half_day", "full_day"].includes(r.course) && Number.isFinite(r.estimated_minutes)
      && r.start && typeof r.start.name === "string" && coordinate(r.start.lat, 90) && coordinate(r.start.lng, 180)
      && Array.isArray(r.center) && r.center.length === 2 && coordinate(r.center[0], 90) && coordinate(r.center[1], 180)
      && Array.isArray(r.legs) && r.legs.every(l => typeof l.from === "string" && typeof l.to === "string" && Number.isFinite(l.minutes) && Number.isFinite(l.distance_km) && ["walk", "car", "public_transport"].includes(l.mode))
      && Array.isArray(r.spots) && r.spots.length > 0 && r.spots.length <= 8 && r.spots.every(p => p && typeof p.place_id === "string" && typeof p.name === "string" && typeof p.category === "string" && coordinate(p.lat, 90) && coordinate(p.lng, 180) && Number.isFinite(p.stay_minutes) && (p.reason === undefined || text(p.reason)) && isReasonSources(p.reason_sources));
  });
}
