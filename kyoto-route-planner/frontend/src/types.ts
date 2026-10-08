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
  coordinates?: [number, number][];
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
  variation?: number;
};

export type OvernightItineraryRequest = {
  query: string;
  departure_station: string;
  departure_date: string;
  departure_time: string;
  stops_per_day: number;
  hotel_query?: string;
};

export type DailyItinerary = {
  day: number;
  date: string;
  places: Place[];
  legs: RouteLeg[];
  schedule: ItineraryScheduleItem[];
  transit_minutes: number | null;
  stay_minutes: number;
  estimated_arrival_at: string | null;
  coordinates?: [number, number][];
};

export type ItineraryScheduleItem = {
  start_time: string | null;
  end_time: string | null;
  title: string;
  detail: string;
  kind: "travel" | "visit" | "hotel";
};

export type OvernightItinerarySuggestion = {
  query: unknown;
  origin: Origin;
  hotel: Place;
  days: DailyItinerary[];
  feasible: boolean;
  route_search_calls: number;
  note: string;
};
