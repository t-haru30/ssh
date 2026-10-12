import type { DatasetRoute } from "./discover/datasetTypes";
import type { RouteIdea } from "./SwipeCard";
import type { Origin, Place, Theme } from "./types";
import prefectureIndex from "./data/routes/index.json";

export type SearchPreset = { theme: Theme; stopCount: number; nonce: number; places: Place[]; origin: Origin; title: string; dwellMinutes: Record<string, number> };
export function routeSelection(route: DatasetRoute | RouteIdea): SearchPreset {
  const places: Place[] = "spots" in route ? route.spots.map(spot => ({
    id: spot.place_id, name: spot.name, category: spot.category, description: "", access_point: "",
    latitude: spot.lat, longitude: spot.lng, themes: [route.theme],
  })) : route.places;
  const entry = "area" in route
    ? prefectureIndex.prefectures.find(item => item.id === route.area)
    : prefectureIndex.prefectures.find(item => item.prefecture_code === route.prefecture_code);
  const center = "center" in route ? route.center : entry?.center ?? [places[0].latitude, places[0].longitude];
  const origin: Origin = "places" in route && route.origin ? route.origin : entry?.id === "kyoto"
    ? { name: "京都駅", latitude: 34.98585, longitude: 135.75877 }
    : { name: `${entry?.name ?? ("prefecture_name" in route ? route.prefecture_name : undefined) ?? "選んだ地域"}・エリア中心`, latitude: center[0], longitude: center[1] };
  return { theme: route.theme, stopCount: places.length, nonce: Date.now(), places, origin, title: route.title,
    dwellMinutes: "spots" in route ? Object.fromEntries(route.spots.map(spot => [spot.place_id, spot.stay_minutes])) : route.dwell_minutes ?? {} };
}
