import type { Origin, Place, OvernightItinerarySuggestion } from "./types";
const cleanOrigin = (v: Origin): Origin => ({ name: v.name, latitude: v.latitude, longitude: v.longitude });
const cleanPlace = (p: Place): Place => ({ id: p.id, name: p.name, category: p.category, latitude: p.latitude, longitude: p.longitude, themes: [...p.themes], description: "", access_point: "" });
export function cleanOvernight(v: OvernightItinerarySuggestion): OvernightItinerarySuggestion {
  return { query: null, origin: cleanOrigin(v.origin), hotel: cleanPlace(v.hotel), feasible: v.feasible, route_search_calls: 0,
    fare_yen: null, note: "保存済みの旅程です。移動情報は未確認です。", days: v.days.map(day => ({
      day: day.day, date: day.date, places: day.places.map(cleanPlace), legs: [], fare_yen: null,
      schedule: day.schedule.map(item => ({ kind: item.kind, title: item.title, detail: "", start_time: null, end_time: null })),
      lunch: { type: "lunch", place: day.lunch.place ? cleanPlace(day.lunch.place) : null, start_time: "", end_time: "", reason: "" },
      transit_minutes: null, stay_minutes: day.stay_minutes, estimated_arrival_at: null, coordinates: [] })) };
}
