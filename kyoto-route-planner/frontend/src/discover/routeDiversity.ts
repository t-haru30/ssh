import type { DatasetRoute } from "./datasetTypes";
import { sameNearbyVenue } from "../venueIdentity";
import { wishCoverage } from "../travelWishes";

type Spot = DatasetRoute["spots"][number];
const sameSpot = (a: Spot, b: Spot) => a.place_id === b.place_id || sameNearbyVenue(
  { name: a.name, latitude: a.lat, longitude: a.lng },
  { name: b.name, latitude: b.lat, longitude: b.lng },
);

/** Different IDs or visit orders must not disguise the same trip. */
export function similarTrip(a: DatasetRoute, b: DatasetRoute): boolean {
  if (!a.spots.length || !b.spots.length) return false;
  const shared = a.spots.filter(spot => b.spots.some(other => sameSpot(spot, other))).length;
  return a.spots.length === b.spots.length && shared === a.spots.length;
}

/** Keep distinct trips in recommendation order, preferring unseen facilities next. */
export function diverseRoutes(candidates: DatasetRoute[], seen: DatasetRoute[] = [], priorityText = ""): DatasetRoute[] {
  const remaining = candidates.filter(route => route.spots.length && !seen.some(previous => similarTrip(route, previous)));
  const result: DatasetRoute[] = [];
  while (remaining.length) {
    const used = result.flatMap(route => route.spots);
    let best = 0;
    const novelty = (route: DatasetRoute) => route.spots.filter(spot => !used.some(other => sameSpot(spot, other))).length / route.spots.length
      + .5 * route.spots.filter(spot => spot.role && spot.role !== "stop" && !used.some(other => sameSpot(spot, other))).length;
    const priority = (route: DatasetRoute) => wishCoverage(priorityText, route.spots.map(spot => ({id:spot.place_id,name:spot.name,category:spot.category ?? "",description:"",tags:spot.tags,latitude:spot.lat,longitude:spot.lng,access_point:"",themes:[]})));
    for (let i = 1; i < remaining.length; i++) if (priority(remaining[i]) > priority(remaining[best]) || priority(remaining[i]) === priority(remaining[best]) && novelty(remaining[i]) > novelty(remaining[best])) best = i;
    const [next] = remaining.splice(best, 1);
    if (!result.some(previous => similarTrip(next, previous))) result.push(next);
  }
  return result;
}
