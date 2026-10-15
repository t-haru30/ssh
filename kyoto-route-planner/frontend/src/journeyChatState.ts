import { isPlace, isRecord } from "./apiValidation";
import { minimumDwell, newTripStop, scheduleTrip, MAX_TRIP_STOPS } from "./dayTrip";
import type { TripPlan } from "./dayTrip";
import type { Place } from "./types";

export type ChatMessage = { role: "user" | "assistant"; text: string; context?: string };
const candidate = (p: Place) => ({ id: p.id, name: p.name, category: p.category, latitude: p.latitude, longitude: p.longitude });
const chatStop = (s: TripPlan["stops"][number]) => ({ place: candidate(s.place), dwell: s.dwellMinutes, locked: s.locked,
  completed: Boolean(s.completed), anchor: s.anchorTime, spending: s.spending, start: s.start, end: s.end, travel: s.travel });
export function chatPayload(plan: TripPlan, candidates: Place[], message: string, history: ChatMessage[], appliedPlan?: TripPlan) {
  return {
    message, history: history.slice(-12).map(m => ({ role: m.role, text: (m.context ?? m.text).slice(0, 3000) })),
    origin: plan.origin, return_to: plan.returnTo, departure: plan.input.departureTime,
    return_travel: plan.returnTravel, travel_cost: plan.travelCost,
    stops: plan.stops.map(chatStop),
    ...(appliedPlan ? { applied_stops: appliedPlan.stops.map(chatStop) } : {}),
    // Keep both versions available for follow-ups such as restoring a removed visit.
    candidates: [...new Map([...plan.stops.map(s => s.place), ...(appliedPlan?.stops.map(s => s.place) ?? []), ...candidates].map(p => [p.id, p])).values()].slice(0, 80).map(candidate),
  };
}

/** New records come from the backend OSM search, never Gemini-generated coordinates. */
export function readChatProposal(value: unknown, plan: TripPlan, candidates: Place[], discovered: unknown = [], appliedPlan?: TripPlan): TripPlan {
  if (!isRecord(value) || !Array.isArray(value.stops) || !value.stops.length || value.stops.length > MAX_TRIP_STOPS) throw new Error("変更案の形式を確認できませんでした。");
  if (!Array.isArray(discovered) || discovered.length > MAX_TRIP_STOPS) throw new Error("追加候補の形式を確認できませんでした。");
  const places = new Map([...candidates, ...(appliedPlan?.stops.map(s => s.place) ?? []), ...plan.stops.map(s => s.place)].map(p => [p.id, p]));
  for (const p of discovered) {
    if (!isPlace(p) || p.name.length > 200
      || !((/^osm-cafe-(node|way|relation)-[1-9]\d*$/.test(p.id) && p.tags?.amenity === "cafe" && p.tags?.source === "OpenStreetMap"
          && p.tags?.source_url === `https://www.openstreetmap.org/${p.id.slice(9).replace("-", "/")}`)
        || (/^osm-(node|way|relation)-[1-9]\d*$/.test(p.id) && p.tags?.source==="OpenStreetMap" && p.tags?.license==="ODbL-1.0"
          && p.tags?.source_url===`https://www.openstreetmap.org/${p.id.slice(4).replace("-","/")}`)
        || (/^openpoi-[a-f0-9]{24}$/.test(p.id) && p.tags?.source === "OpenPOI API" && p.tags?.venue_type === "cafe"
          && p.tags?.position_check === "gsi_neighbourhood" && p.tags?.source_url === "https://openpoiapi.com/attribution.html"
          && typeof p.tags?.licenses === "string" && typeof p.tags?.attributions === "string"))
      || p.latitude < 20 || p.latitude > 46 || p.longitude < 122 || p.longitude > 154
      || places.has(p.id)) throw new Error("追加候補の出典を確認できませんでした。");
    places.set(p.id, p);
  }
  const seen = new Set<string>();
  const stops = value.stops.map(item => {
    if (!isRecord(item) || typeof item.id !== "string" || seen.has(item.id) || !places.has(item.id)
      || typeof item.dwell !== "number" || !Number.isSafeInteger(item.dwell) || item.dwell < 15 || item.dwell > 360) throw new Error("変更案に未確認の施設・重複・不正な滞在時間があります。");
    seen.add(item.id);
    const old = plan.stops.find(s => s.place.id === item.id) ?? appliedPlan?.stops.find(s => s.place.id === item.id);
    if (item.dwell < minimumDwell(places.get(item.id)!)) throw new Error("施設の滞在は30分以上で指定してください。");
    if (old && (old.locked || old.completed) && item.dwell !== old.dwellMinutes) throw new Error("固定・訪問済みの予定を変更する案は反映できません。");
    return old ? { ...old, dwellMinutes: item.dwell } : newTripStop(places.get(item.id)!, item.dwell);
  });
  for (const snapshot of [plan, ...(appliedPlan ? [appliedPlan] : [])]) {
    for (const old of snapshot.stops) if ((old.locked || old.completed) && (!seen.has(old.place.id) || stops.find(s => s.place.id === old.place.id)?.dwellMinutes !== old.dwellMinutes)) throw new Error("固定・訪問済みの予定を削除・変更する案は反映できません。");
    const completed = snapshot.stops.filter(s => s.completed);
    if (completed.some((s, i) => stops[i]?.place.id !== s.place.id)) throw new Error("訪問済みの順番は変更できません。");
  }
  const sameRoute = stops.length === plan.stops.length && stops.every((s, i) => s.place.id === plan.stops[i].place.id);
  const next = { ...scheduleTrip(plan.input, plan.origin, plan.date, stops, plan.transport, sameRoute ? plan.transportEstimate : null, plan.returnTo, { checkPlanningLimits: false }), planningEstimates: plan.planningEstimates };
  const needsTransit=!sameRoute && Boolean(next.unknownTravelSegments?.length);
  if (!needsTransit && next.stops.some(s => s.late > 0)) throw new Error("固定した開始時刻に間に合わない変更案です。訪問順や滞在時間を見直してください。");
  return next;
}
