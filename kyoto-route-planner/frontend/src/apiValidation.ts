import type {
  DailyItinerary,
  ItineraryScheduleItem,
  LunchPlan,
  Origin,
  OvernightItinerarySuggestion,
  Place,
  RouteLeg,
  RouteSuggestion,
  RouteSuggestions,
  RouteTimelineItem,
  SwipeItinerary,
  Theme,
} from "./types";
import type { RouteIdea } from "./SwipeCard";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTheme(value: unknown): value is Theme {
  return value === "all"
    || value === "history"
    || value === "temple"
    || value === "nature"
    || value === "food";
}

export function isPlace(value: unknown): value is Place {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && value.name.length > 0
    && typeof value.category === "string"
    && typeof value.description === "string"
    && typeof value.access_point === "string"
    && typeof value.latitude === "number"
    && Number.isFinite(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && typeof value.longitude === "number"
    && Number.isFinite(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180
    && Array.isArray(value.themes)
    && value.themes.every(isTheme)
    && (value.address === undefined || typeof value.address === "string")
    && (value.tags === undefined
      || (isRecord(value.tags) && Object.values(value.tags).every((tag) => typeof tag === "string")));
}

export function isOrigin(value: unknown): value is Origin {
  return isRecord(value)
    && typeof value.name === "string"
    && value.name.length > 0
    && typeof value.latitude === "number"
    && Number.isFinite(value.latitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && typeof value.longitude === "number"
    && Number.isFinite(value.longitude)
    && value.longitude >= -180
    && value.longitude <= 180;
}

export function isRouteLeg(value: unknown): value is RouteLeg {
  return isRecord(value)
    && typeof value.from_name === "string"
    && typeof value.to_name === "string"
    && typeof value.line_name === "string"
    && typeof value.mode === "string"
    && (value.duration_minutes === undefined
      || value.duration_minutes === null
      || (typeof value.duration_minutes === "number"
        && Number.isInteger(value.duration_minutes)
        && value.duration_minutes >= 0));
}

function isRouteTimelineItem(value: unknown): value is RouteTimelineItem {
  if (!isRecord(value)) return false;
  if (value.type === "spot") {
    return (value.role === "start" || value.role === "stop" || value.role === "finish")
      && (typeof value.place_id === "string" || value.place_id === null)
      && typeof value.name === "string"
      && typeof value.category === "string"
      && (typeof value.time === "string" || value.time === null)
      && typeof value.stay_minutes === "number"
      && Number.isFinite(value.stay_minutes)
      && value.stay_minutes >= 0;
  }
  return value.type === "transit"
    && value.mode === "public_transport"
    && typeof value.from_name === "string"
    && typeof value.to_name === "string"
    && (typeof value.start_time === "string" || value.start_time === null)
    && (typeof value.end_time === "string" || value.end_time === null)
    && (typeof value.duration_minutes === "number" || value.duration_minutes === null)
    && typeof value.is_estimate === "boolean";
}

export function isSwipeItinerary(value: unknown): value is SwipeItinerary {
  return isRecord(value)
    && isOrigin(value.origin)
    && Array.isArray(value.places)
    && value.places.length > 0
    && value.places.every(isPlace)
    && Array.isArray(value.legs)
    && value.legs.every(isRouteLeg)
    && (typeof value.estimated_total_minutes === "number" || value.estimated_total_minutes === null)
    && (typeof value.estimated_return_at === "string" || value.estimated_return_at === null)
    && typeof value.note === "string";
}

export function isRouteIdea(value: unknown): value is RouteIdea {
  return isRecord(value)
    && isTheme(value.theme)
    && typeof value.title === "string"
    && value.title.length > 0
    && typeof value.story === "string"
    && value.story.length > 0
    && (value.image_url === null
      || value.image_url === undefined
      || (typeof value.image_url === "string" && value.image_url.startsWith("https://")))
    && (value.author_name === null || typeof value.author_name === "string")
    && (value.source_url === null
      || (typeof value.source_url === "string" && value.source_url.startsWith("https://")))
    && (value.license_name === null || typeof value.license_name === "string")
    && (value.license_url === null
      || (typeof value.license_url === "string" && value.license_url.startsWith("https://")))
    && (value.image_url === null
      || (
        typeof value.author_name === "string"
        && value.author_name.length > 0
        && typeof value.source_url === "string"
        && typeof value.license_name === "string"
        && value.license_name.length > 0
        && typeof value.license_url === "string"
      ))
    && Array.isArray(value.places)
    && value.places.length >= 2
    && value.places.length <= 3
    && value.places.every(isPlace)
    && (value.copywriting_source === "gemini" || value.copywriting_source === "fallback")
    && typeof value.note === "string";
}

function isRouteSuggestion(value: unknown): value is RouteSuggestion {
  return isRecord(value)
    && Array.isArray(value.places)
    && value.places.length > 0
    && value.places.every(isPlace)
    && isOrigin(value.origin)
    && Array.isArray(value.legs)
    && value.legs.every(isRouteLeg)
    && (value.title === null || typeof value.title === "string")
    && (value.story === null || typeof value.story === "string")
    && (typeof value.total_minutes === "number" || value.total_minutes === null)
    && (typeof value.departure_time === "string" || value.departure_time === null)
    && (typeof value.arrival_time === "string" || value.arrival_time === null)
    && Array.isArray(value.timeline)
    && value.timeline.every(isRouteTimelineItem)
    && typeof value.note === "string"
    && Array.isArray(value.coordinates)
    && value.coordinates.every((coordinate) => (
      Array.isArray(coordinate)
      && coordinate.length === 2
      && coordinate.every((part) => typeof part === "number" && Number.isFinite(part))
      && coordinate[0] >= -90
      && coordinate[0] <= 90
      && coordinate[1] >= -180
      && coordinate[1] <= 180
    ));
}

export function isRouteSuggestions(value: unknown): value is RouteSuggestions {
  return isRecord(value)
    && Array.isArray(value.routes)
    && value.routes.length > 0
    && value.routes.every(isRouteSuggestion);
}

function isScheduleItem(value: unknown): value is ItineraryScheduleItem {
  return isRecord(value)
    && (typeof value.start_time === "string" || value.start_time === null)
    && (typeof value.end_time === "string" || value.end_time === null)
    && typeof value.title === "string"
    && typeof value.detail === "string"
    && (value.kind === "travel" || value.kind === "visit" || value.kind === "hotel" || value.kind === "lunch");
}

function isLunchPlan(value: unknown): value is LunchPlan {
  return isRecord(value)
    && value.type === "lunch"
    && (value.place === null || isPlace(value.place))
    && typeof value.start_time === "string"
    && typeof value.end_time === "string"
    && typeof value.reason === "string";
}

function isDailyItinerary(value: unknown): value is DailyItinerary {
  return isRecord(value)
    && typeof value.day === "number"
    && typeof value.date === "string"
    && Array.isArray(value.places)
    && value.places.every(isPlace)
    && Array.isArray(value.legs)
    && value.legs.every(isRouteLeg)
    && Array.isArray(value.schedule)
    && value.schedule.every(isScheduleItem)
    && isLunchPlan(value.lunch)
    && (typeof value.transit_minutes === "number" || value.transit_minutes === null)
    && typeof value.stay_minutes === "number"
    && (typeof value.estimated_arrival_at === "string" || value.estimated_arrival_at === null)
    && Array.isArray(value.coordinates)
    && value.coordinates.every((coordinate) => (
      Array.isArray(coordinate)
      && coordinate.length === 2
      && coordinate.every((part) => typeof part === "number" && Number.isFinite(part))
    ));
}

export function isOvernightItinerary(value: unknown): value is OvernightItinerarySuggestion {
  return isRecord(value)
    && "query" in value
    && isOrigin(value.origin)
    && isPlace(value.hotel)
    && Array.isArray(value.days)
    && value.days.every(isDailyItinerary)
    && typeof value.feasible === "boolean"
    && typeof value.route_search_calls === "number"
    && typeof value.note === "string";
}
