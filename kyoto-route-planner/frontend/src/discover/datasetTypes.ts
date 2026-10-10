export type DatasetPattern = "half_day" | "full_day";

export type DatasetSpot = {
  place_id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  stay_minutes: number;
  score: number;
  role: "stop" | "lunch";
};

// backend/scripts の dataset.json と同じ形式
export type DatasetRoute = {
  id: string;
  area: string;
  pattern: DatasetPattern;
  theme: "all" | "history" | "temple" | "nature" | "food";
  title: string;
  estimated_minutes: number;
  total_score: number;
  center: [number, number];
  spots: DatasetSpot[];
  coordinates: [number, number][];
};

export type RouteDataset = {
  version: number;
  generated_at: string;
  area: string;
  generator_version: string;
  routes: DatasetRoute[];
};
