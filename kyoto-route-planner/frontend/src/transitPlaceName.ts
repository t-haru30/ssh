import type { Origin } from "./types";
import { distanceKm } from "./dayTrip";

/** Resolve provider coordinate labels only when they match a known itinerary point. */
export function transitPlaceName(value: string, points: Origin[]): string {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*wgs84(?:\s*,\s*\d+(?:\.\d+)?)?)?\s*$/i.exec(value);
  if (!match) return value;
  const location = {name:"", latitude:Number(match[1]), longitude:Number(match[2])};
  if (Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) return "経由地点";
  const nearest = points.map(point => ({point, distance:distanceKm(point,location)})).sort((a,b) => a.distance-b.distance)[0];
  return nearest && nearest.distance <= 0.1 ? nearest.point.name : "経由地点";
}
