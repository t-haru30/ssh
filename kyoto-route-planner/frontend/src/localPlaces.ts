import type { RouteDataset } from "./discover/datasetTypes";
import type { Origin, Place } from "./types";
import prefectureIndex from "./data/routes/index.json";
import { facilityThemes, isUnsuitablePlace } from "./placeThemes";

const datasets = import.meta.glob(["./data/routes/*.json", "!./data/routes/index.json"], { eager: true, import: "default" }) as Record<string, RouteDataset>;
const catalog = new Map<string, Place>();
const prefectureNames = new Map(prefectureIndex.prefectures.map(entry => [entry.id, entry.name]));
export const localOrigins: Record<string, Origin> = {};
for (const dataset of Object.values(datasets)) {
  const start = dataset.routes[0]?.start;
  if (start) localOrigins[dataset.area] = { name: start.name, latitude: start.lat, longitude: start.lng };
  for (const route of dataset.routes) {
    for (const spot of route.spots) {
      if (!spot.place_id.startsWith("osm-") || catalog.has(spot.place_id)) continue;
      catalog.set(spot.place_id, { id: spot.place_id, name: spot.name, category: spot.category,
        description: "", access_point: "", latitude: spot.lat, longitude: spot.lng, themes: [],
        address: prefectureNames.get(dataset.area),
        tags: { area: dataset.area, source: "OpenStreetMap" } });
    }
  }
}

/** Local suggestions remain available before any optional provider search. */
export const localPlaces = [...catalog.values()].filter(place => !isUnsuitablePlace(place)).map(place => ({ ...place, themes: facilityThemes(place) }));
