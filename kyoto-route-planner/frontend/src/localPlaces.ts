import type { RouteDataset } from "./discover/datasetTypes";
import type { Place } from "./types";

const datasets = import.meta.glob(["./data/routes/*.json", "!./data/routes/index.json"], { eager: true, import: "default" }) as Record<string, RouteDataset>;
const catalog = new Map<string, Place>();
for (const dataset of Object.values(datasets)) {
  for (const route of dataset.routes) {
    for (const spot of route.spots) {
      const existing = catalog.get(spot.place_id);
      if (existing) {
        if (!existing.themes.includes(route.theme)) existing.themes.push(route.theme);
      } else catalog.set(spot.place_id, { id: spot.place_id, name: spot.name, category: spot.category,
        description: "", access_point: "", latitude: spot.lat, longitude: spot.lng, themes: [route.theme] });
    }
  }
}

/** Local suggestions remain available before any optional provider search. */
export const localPlaces = [...catalog.values()];
