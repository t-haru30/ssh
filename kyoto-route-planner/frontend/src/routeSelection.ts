import type { DatasetRoute } from "./discover/datasetTypes";
import type { RouteIdea } from "./SwipeCard";
import type { Origin, Place, Theme } from "./types";
import prefectureIndex from "./data/routes/index.json";
import { parseJourneyFile } from "./journeyFile";
import { parseOvernightSnapshot, type OvernightSnapshot } from "./overnightFavorite";

export type SearchPreset = { sourceFavoriteId?: string; theme: Theme; stopCount: number; nonce: number; places: Place[]; origin: Origin; title: string; dwellMinutes: Record<string, number>; anchorTimes?: Record<string, string>; departureTime?: string; availableMinutes?: number; autoSearch?: boolean; returnTo?: Origin; tripPlan?: import("./dayTrip").TripPlan; overnightSnapshot?: OvernightSnapshot };
export function routeSelection(route: DatasetRoute | RouteIdea, includeTransfers = false): SearchPreset {
  if ("overnight_snapshot" in route && route.overnight_snapshot) {
    const snapshot = parseOvernightSnapshot(route.overnight_snapshot);
    return { theme: route.theme, stopCount: snapshot.stopsPerDay, nonce: Date.now(), places: snapshot.itinerary.days.flatMap(day => day.places),
      origin: snapshot.itinerary.origin, title: route.title, dwellMinutes: {}, overnightSnapshot: snapshot, autoSearch: false };
  }
  if ("journey_file" in route && route.journey_file) {
    const { plan, title } = parseJourneyFile(route.journey_file);
    return { theme: route.theme, stopCount: plan.stops.length, nonce: Date.now(), places: plan.stops.map(s => s.place),
      origin: plan.origin, returnTo: plan.returnTo, title, tripPlan: plan,
      dwellMinutes: Object.fromEntries(plan.stops.map(s => [s.place.id, s.dwellMinutes])) };
  }
  const places: Place[] = "spots" in route ? route.spots.map(spot => ({
    id: spot.place_id, name: spot.name, category: spot.category, description: spot.reason ?? "", access_point: "",
    latitude: spot.lat, longitude: spot.lng, themes: [spot.role !== "stop" ? "food" : route.theme],
    address: spot.address, tags: spot.tags,
  })) : route.places;
  const entry = "area" in route
    ? prefectureIndex.prefectures.find(item => item.id === route.area)
    : prefectureIndex.prefectures.find(item => item.prefecture_code === route.prefecture_code);
  const center = "center" in route ? route.center : entry?.center ?? [places[0].latitude, places[0].longitude];
  const origin: Origin = "spots" in route ? { name: route.start.name, latitude: route.start.lat, longitude: route.start.lng }
    : route.origin ? route.origin : entry?.id === "kyoto"
    ? { name: "京都駅", latitude: 34.98585, longitude: 135.75877 }
    : { name: `${entry?.name ?? ("prefecture_name" in route ? route.prefecture_name : undefined) ?? "選んだ地域"}・エリア中心`, latitude: center[0], longitude: center[1] };
  const dwellMinutes = "spots" in route ? Object.fromEntries(route.spots.map(spot => [spot.place_id, spot.stay_minutes])) : { ...route.dwell_minutes };
  for (const place of places) {
    if (dwellMinutes[place.id] === undefined && /カフェ|喫茶|cafe|coffee/i.test(`${place.category} ${place.tags?.amenity ?? ""}`)) dwellMinutes[place.id] = 30;
  }
  const timing = "spots" in route ? {
    departureTime: route.departure_time,
    anchorTimes: Object.fromEntries(route.spots.filter(s => s.meal_time || s.role === "dinner").map(s => [s.place_id, s.meal_time ?? "18:00"])),
    availableMinutes: route.course === "full_day" ? 720 : Math.max(360, route.estimated_minutes),
  } : {};
  if (includeTransfers && route.travel_origin && (route.travel_origin.latitude !== origin.latitude || route.travel_origin.longitude !== origin.longitude)) {
    const gateway = (id: string, label: string): Place => ({ id, name: origin.name, latitude: origin.latitude, longitude: origin.longitude, category: label, description: label, access_point: "", themes: [route.theme] });
    const arrival = gateway("trip-arrival", "到着・観光の起点");
    const returnStation = gateway("trip-return", "帰路の出発地点");
    const itineraryPlaces = [arrival, ...places, returnStation];
    return { ...timing, theme: route.theme, stopCount: itineraryPlaces.length, nonce: Date.now(), places: itineraryPlaces,
      origin: route.travel_origin, returnTo: route.travel_origin, title: route.title,
      dwellMinutes: { ...dwellMinutes, [arrival.id]: 15, [returnStation.id]: 15 } };
  }
  return { ...timing, theme: route.theme, stopCount: places.length, nonce: Date.now(), places, origin, title: route.title, dwellMinutes };
}
