import { distanceKm } from "./dayTrip";

type Venue = { name: string; latitude: number; longitude: number };

/** Only explicit directional photograph labels and exact names are equivalent. */
export function venueName(name: string): string {
  return name.normalize("NFKC").trim().replace(/^[東西南北]+から見た(.+)の眺め$/, "$1").replace(/\s+/g, "").toLowerCase();
}

export function sameNearbyVenue(a: Venue, b: Venue): boolean {
  return venueName(a.name) === venueName(b.name) && distanceKm(a, b) <= 0.3;
}

/** For automatic suggestions only. Never apply to a person's saved stops. */
export function distinctVenues<T extends Venue>(places: T[]): T[] {
  const result: T[] = [];
  for (const place of places) if (!result.some(item => sameNearbyVenue(item, place))) result.push(place);
  return result;
}
