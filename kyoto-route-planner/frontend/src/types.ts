export type Theme = "all" | "history" | "temple" | "nature" | "food";

export type Place = {
  id: string;
  name: string;
  category: string;
  description: string;
  access_point: string;
  latitude: number;
  longitude: number;
  themes: Theme[];
};

export type Origin = {
  name: string;
  latitude: number;
  longitude: number;
};

export type RouteLeg = {
  from_name: string;
  to_name: string;
  line_name: string;
  mode: string;
  duration_minutes: number | null;
};

export type RouteSuggestion = {
  places: Place[];
  origin: Origin;
  legs: RouteLeg[];
  title: string | null;
  story: string | null;
  total_minutes: number | null;
  departure_time: string | null;
  arrival_time: string | null;
  note: string;
};

export type RouteSuggestions = {
  routes: RouteSuggestion[];
};

export type RouteSuggestionRequest = {
  origin: string;
  theme: Theme;
  stop_count: number;
  departure_date: string;
  departure_time: string;
};
