import type { DatasetRoute } from "./datasetTypes";
import { sameNearbyVenue } from "../venueIdentity";

type Spot = DatasetRoute["spots"][number];
const sameSpot = (a: Spot, b: Spot) => a.place_id === b.place_id || sameNearbyVenue(
  { name: a.name, latitude: a.lat, longitude: a.lng },
  { name: b.name, latitude: b.lat, longitude: b.lng },
);

/** Different IDs or visit orders must not disguise the same trip. */
export function similarTrip(a: DatasetRoute, b: DatasetRoute): boolean {
  if (!a.spots.length || !b.spots.length) return false;
  if (sameSpot(a.spots[0], b.spots[0])) return true;
  const shared = a.spots.filter(spot => b.spots.some(other => sameSpot(spot, other))).length;
  return shared / Math.min(a.spots.length, b.spots.length) >= 2 / 3;
}

/** Keep distinct trips in recommendation order, preferring unseen facilities next. */
export function diverseRoutes(candidates: DatasetRoute[], seen: DatasetRoute[] = []): DatasetRoute[] {
  const remaining = candidates.filter(route => route.spots.length && !seen.some(previous => similarTrip(route, previous)));
  const result: DatasetRoute[] = [];
  while (remaining.length) {
    const used = result.flatMap(route => route.spots);
    let best = 0;
    const novelty = (route: DatasetRoute) => route.spots.filter(spot => !used.some(other => sameSpot(spot, other))).length / route.spots.length;
    for (let i = 1; i < remaining.length; i++) if (novelty(remaining[i]) > novelty(remaining[best])) best = i;
    const [next] = remaining.splice(best, 1);
    if (!result.some(previous => similarTrip(next, previous))) result.push(next);
  }
  return result;
}
