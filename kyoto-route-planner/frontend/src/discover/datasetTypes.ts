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
  reason?: string;
};

export type DatasetStart = {
  name: string;
  lat: number;
  lng: number;
  to_first_km: number;
  from_last_km: number;
};

export type DatasetLeg = {
  from: string;
  to: string;
  distance_km: number;
  mode: "walk" | "car" | "public_transport";
  minutes: number;
};

// backend/scripts の dataset.json と同じ形式
export type DatasetRoute = {
  id: string;
  area: string;
  pattern: DatasetPattern;
  course: DatasetPattern;
  theme: "all" | "history" | "temple" | "nature" | "food";
  title: string;
  estimated_minutes: number;
  legs: DatasetLeg[];
  start: DatasetStart;
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

export type RouteDatasetIndexEntry = {
  id: string;
  prefecture_code: string;
  name: string;
  center: [number, number];
  route_count: number;
  file: string;
};

export type RouteDatasetIndex = {
  version: number;
  generated_at: string;
  prefectures: RouteDatasetIndexEntry[];
};
