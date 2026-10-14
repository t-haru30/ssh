import type { Origin, Place, Preference, RouteSuggestion } from "./types";

export type TripInput = { departureTime: string; availableMinutes: number; budget: number; preferences?: Preference[] };
export type TripStop = {
  place: Place;
  dwellMinutes: number;
  locked: boolean;
  anchorTime: string | null;
  spending: number | null;
  completed?: boolean;
  completedStart?: number | null;
  completedEnd?: number | null;
  completedTravel?: number | null;
};
export type TripTransport = { route: RouteSuggestion; date: string; time: string };
export type ScheduledStop = TripStop & { start: number; end: number; travel: number; wait: number; late: number };
export type TripPlan = {
  input: TripInput;
  origin: Origin;
  returnTo: Origin;
  date: string;
  stops: ScheduledStop[];
  transport: TripTransport;
  transportEstimate: number | null;
  planningEstimates?: { food: number | null; coffee: number | null };
  travelMinutes: number;
  returnMinute: number;
  returnTravel: number;
  knownCost: number;
  travelCost: number | null;
  totalCost: number | null;
  unknownCosts: number;
  provisionalCosts?: boolean;
  estimatedTravel: boolean;
  unknownTravelSegments?: number[];
  violations: string[];
};

export const MAX_TRIP_STOPS = 8;
export function clockMinutes(value: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error("出発時刻を入力してください。");
  return Number(match[1]) * 60 + Number(match[2]);
}
export function tripClock(value: number) {
  const days = Math.floor(value / 1440);
  const minute = value % 1440;
  return `${days ? `${days}日後 ` : ""}${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function readTripNumber(value: string, label: string, min: number, max: number): number {
  if (!value.trim() || !/^\d+$/.test(value)) throw new Error(`${label}を整数で入力してください。`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label}は${min}〜${max.toLocaleString("ja-JP")}で入力してください。`);
  return number;
}
export function distanceKm(a: Origin | Place, b: Origin | Place) {
  const rad = Math.PI / 180;
  const x = Math.sin((b.latitude - a.latitude) * rad / 2) ** 2
    + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin((b.longitude - a.longitude) * rad / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, x)));
}
/** Planning allowances, not verified admission prices or fares. User values take precedence. */
export function facilityAllowance(place: Place): number {
  if (["trip-arrival", "trip-return"].includes(place.id)) return 0;
  const category = `${place.category} ${place.name}`;
  if (/カフェ|喫茶|coffee|cafe/i.test(category)) return 800;
  if (/飲食|グルメ|レストラン|食堂|料理|restaurant/i.test(category)) return 1500;
  if (/博物館|美術館|資料館|記念館|museum/i.test(category)) return 1000;
  if (/寺|庭園|城/.test(category)) return 600;
  if (/公園|神社|神宮|海|山|川/.test(category)) return 0;
  return 500;
}
export function transportMatches(plan: TripPlan): boolean {
  const route = plan.transport.route;
  return plan.date === plan.transport.date && plan.input.departureTime === plan.transport.time
    && sameLocation(plan.origin, route.origin) && sameLocation(plan.returnTo, route.return_to ?? route.origin)
    && plan.stops.length === route.places.length
    && plan.stops.every((stop, i) => stop.place.id === route.places[i].id && sameLocation(stop.place, route.places[i]));
}
export const minimumDwell = (place: Place) => ["trip-arrival", "trip-return"].includes(place.id) ? 15 : 30;
export function newTripStop(place: Place, dwellMinutes = 90): TripStop {
  return { place, dwellMinutes: Math.max(minimumDwell(place), Math.min(360, dwellMinutes)), locked: false, anchorTime: null, spending: null, completed: false, completedStart: null, completedEnd: null, completedTravel: null };
}
/** Completed visits must remain a contiguous prefix in their recorded order. */
export function completedStopCount(stops: TripStop[]) {
  let count = 0;
  for (const stop of stops) {
    if (!stop.completed) continue;
    if (stops[count] !== stop) throw new Error("訪問済みの立ち寄り先は先頭から順に指定してください。");
    count++;
  }
  return count;
}
export function completeNextStop(plan: TripPlan): TripPlan {
  const index = completedStopCount(plan.stops);
  if (index === plan.stops.length) return plan;
  const stops = plan.stops.map((stop, i) => i === index ? { ...stop, completed: true, locked: true,
    completedStart: stop.start, completedEnd: stop.end, completedTravel: stop.travel } : stop);
  return { ...scheduleTrip(plan.input, plan.origin, plan.date, stops, plan.transport, plan.transportEstimate, plan.returnTo),
    ...(plan.planningEstimates ? { planningEstimates: plan.planningEstimates } : {}) };
}
/** Undo only the last visit; keep its fixed-place protection until explicitly unlocked. */
export function undoLastCompletedStop(plan: TripPlan): TripPlan {
  const index = completedStopCount(plan.stops) - 1;
  if (index < 0) return plan;
  const stops = plan.stops.map((stop, i) => i === index ? { ...stop, completed: false,
    completedStart: null, completedEnd: null, completedTravel: null } : stop);
  return { ...scheduleTrip(plan.input, plan.origin, plan.date, stops, plan.transport, plan.transportEstimate, plan.returnTo),
    ...(plan.planningEstimates ? { planningEstimates: plan.planningEstimates } : {}) };
}
function sameLocation(a: Origin | Place, b: Origin | Place) {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}
export function scheduleTrip(
  input: TripInput, origin: Origin, date: string, stops: TripStop[], transport: TripTransport,
  transportEstimate: number | null = null,
  returnTo: Origin = origin,
  options: { checkPlanningLimits?: boolean } = {},
): TripPlan {
  const departure = clockMinutes(input.departureTime);
  completedStopCount(stops);
  const historyViolations: string[] = [];
  const points = [origin, ...stops.map(stop => stop.place), returnTo];
  const distances = points.slice(1).map((point, index) => distanceKm(points[index], point));
  const route = transport.route;
  const baselineValid = date === transport.date && input.departureTime === transport.time
    && sameLocation(origin, route.origin) && sameLocation(returnTo, route.return_to ?? route.origin) && stops.length === route.places.length
    && stops.every((stop, index) => stop.place.id === route.places[index].id && sameLocation(stop.place, route.places[index]));
  if (stops.some(stop => stop.completed) && !baselineValid) historyViolations.push("経路条件が変更されています。訪問済みの時刻は記録を保持し、未訪問の移動時間は概算します。");
  const hasDuration = baselineValid && route.total_minutes !== null && Number.isFinite(route.total_minutes) && route.total_minutes >= 0;
  const sumDistance = distances.reduce((sum, distance) => sum + distance, 0);
  const transits = baselineValid ? route.timeline?.filter(item => item.type === "transit") ?? [] : [];
  const hasSegments = transits.length === distances.length && transits.every(item => !item.is_estimate && item.duration_minutes !== null && Number.isFinite(item.duration_minutes) && item.duration_minutes >= 0);
  const durations = hasSegments ? transits.map(item => item.duration_minutes!) : hasDuration
    ? distances.map(distance => Math.floor((route.total_minutes ?? 0) * (sumDistance ? distance / sumDistance : 1 / distances.length)))
    : distances.map((distance, i) => transits[i] && !transits[i].is_estimate && transits[i].duration_minutes != null ? transits[i].duration_minutes! : Math.ceil(distance * 1000 * 1.3 / 80));
  if (hasDuration && !hasSegments) durations[durations.length - 1] += (route.total_minutes ?? 0) - durations.reduce((sum, duration) => sum + duration, 0);
  const unknownTravelSegments = !hasDuration && !hasSegments ? distances.flatMap((distance, i) => distance > 5 && (!transits[i] || transits[i].is_estimate || transits[i].duration_minutes == null) ? [i] : []) : [];
  let current = departure;
  const scheduled = stops.map((stop, index): ScheduledStop => {
    if (stop.completed) {
      const start = stop.completedStart;
      const end = stop.completedEnd;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || end < start) throw new Error("訪問済みの開始・終了時刻が不正です。");
      const travel = stop.completedTravel ?? durations[index];
      if (!Number.isSafeInteger(travel) || travel < 0) throw new Error("訪問済みの移動時間が不正です。");
      if (current + travel > start) historyViolations.push(`${stop.place.name}の訪問済み時刻と現在の出発・移動条件が一致しません。`);
      if (index > 0 && start < current) throw new Error("訪問済みの時刻が前の立ち寄り先と重なっています。");
      const wait = Math.max(0, start - current - travel);
      current = end;
      return { ...stop, locked: true, dwellMinutes: end - start, start, end, travel, wait, late: 0 };
    }
    const arrive = current + durations[index];
    const anchor = stop.anchorTime ? clockMinutes(stop.anchorTime) : null;
    const start = Math.max(arrive, anchor ?? arrive);
    current = start + stop.dwellMinutes;
    return { ...stop, start, end: current, travel: durations[index], wait: start - arrive, late: anchor === null ? 0 : Math.max(0, arrive - anchor) };
  });
  const returnTravel = durations[durations.length - 1];
  const returnMinute = current + returnTravel;
  const segmentFares = distances.map((_, index) => transits[index]?.fare_yen ?? null);
  const completeFare = transits.length === distances.length && segmentFares.every(fare => fare !== null)
    ? segmentFares.reduce<number>((sum, fare) => sum + (fare ?? 0), 0) : null;
  const fare = stops.length === 0 && sameLocation(origin, returnTo) ? 0 : transportEstimate ?? (baselineValid ? route.fare_yen ?? completeFare : null);
  const provisionalCosts = fare === null || stops.some(stop => stop.spending === null);
  // Unknown transport fares stay unknown; partial provider fares may be subtotalled.
  const knownFare = fare ?? segmentFares.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const costs = [fare, ...stops.map(stop => stop.spending ?? facilityAllowance(stop.place))];
  const unknownCosts = costs.filter(cost => cost === null).length;
  const knownCost = knownFare + costs.slice(1).reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const violations: string[] = [...historyViolations];
  if (unknownTravelSegments.length) violations.push(options.checkPlanningLimits === false
    ? "長距離区間の交通情報が未確認です。交通経路を検索してください。"
    : "長距離区間の交通情報が未確認です。交通経路を検索してから時間枠に合わせて調整してください。");
  const overMinutes = returnMinute - departure - input.availableMinutes;
  if (options.checkPlanningLimits !== false && overMinutes > 0 && !unknownTravelSegments.length) violations.push(`帰着目標を${overMinutes}分超過します。`);
  if (options.checkPlanningLimits !== false && knownCost > input.budget) violations.push(`概算費用が予算を${(knownCost - input.budget).toLocaleString("ja-JP")}円超過します。`);
  for (const stop of scheduled) if (stop.late > 0) violations.push(`${stop.place.name}の固定開始に${stop.late}分間に合いません。`);
  if (unknownCosts && options.checkPlanningLimits !== false) violations.push(`費用が${unknownCosts}項目未入力・未確認のため、予算内かは未判定です。`);
  if (!stops.length) violations.push("立ち寄り先がありません。候補を追加してください。");
  return { input, origin, returnTo, date, stops: scheduled, transport, transportEstimate, travelMinutes: scheduled.reduce((sum, stop) => sum + stop.travel, returnTravel), returnMinute, returnTravel, knownCost, travelCost: fare, provisionalCosts, totalCost: unknownCosts ? null : knownCost, unknownCosts, estimatedTravel: !hasDuration && !hasSegments, unknownTravelSegments, violations };
}

function fits(plan: TripPlan) {
  return !plan.unknownTravelSegments?.length && plan.stops.length > 0 && plan.returnMinute <= clockMinutes(plan.input.departureTime) + plan.input.availableMinutes
    && plan.knownCost <= plan.input.budget && plan.stops.every(stop => stop.late === 0);
}
function fitDurations(base: TripPlan, stops: TripStop[]) {
  const next = stops.map(stop => ({ ...stop, dwellMinutes: stop.locked || stop.completed ? stop.dwellMinutes : Math.max(minimumDwell(stop.place), stop.dwellMinutes) }));
  const compute = () => ({ ...scheduleTrip(base.input, base.origin, base.date, next, base.transport, base.transportEstimate, base.returnTo),
    ...(base.planningEstimates ? { planningEstimates: base.planningEstimates } : {}) });
  let plan = compute();
  for (let anchor = 0; anchor < next.length; anchor++) {
    for (let i = anchor - 1; i >= 0 && plan.stops[anchor].late > 0; i--) {
      if (next[i].locked || next[i].completed) continue;
      next[i].dwellMinutes -= Math.min(plan.stops[anchor].late, Math.max(0, next[i].dwellMinutes - minimumDwell(next[i].place)));
      plan = compute();
    }
  }
  for (let i = next.length - 1; i >= 0; i--) {
    const over = plan.returnMinute - clockMinutes(base.input.departureTime) - base.input.availableMinutes;
    if (over <= 0) break;
    if (next[i].locked || next[i].completed) continue;
    next[i].dwellMinutes -= Math.min(over, Math.max(0, next[i].dwellMinutes - minimumDwell(next[i].place)));
    plan = compute();
  }
  return plan;
}
/** Keep order, fixed places, dwell times and appointments. Never fetch during editing. */
export function fitTrip(base: TripPlan): TripPlan {
  if (base.stops.length > MAX_TRIP_STOPS) throw new Error("立ち寄り先は8か所までです。");
  const first = fitDurations(base, base.stops);
  if (fits(first)) return first;
  const flexible = base.stops.filter(stop => !stop.locked && !stop.completed);
  for (let count = 1; count <= flexible.length; count++) {
    let best: TripPlan | null = null;
    let bestDelta = Infinity;
    for (let mask = 1; mask < 2 ** flexible.length; mask++) {
      if (mask.toString(2).replace(/0/g, "").length !== count) continue;
      const removed = new Set(flexible.filter((_, index) => mask & (1 << index)).map(stop => stop.place.id));
      const candidate = fitDurations(base, base.stops.filter(stop => !removed.has(stop.place.id)));
      if (!fits(candidate)) continue;
      const delta = candidate.stops.reduce((sum, stop) => sum + Math.abs(stop.dwellMinutes - (base.stops.find(old => old.place.id === stop.place.id)?.dwellMinutes ?? stop.dwellMinutes)), 0);
      if (delta < bestDelta) { best = candidate; bestDelta = delta; }
    }
    if (best) return best;
  }
  return first;
}
export function tripChanges(before: TripPlan, after: TripPlan) {
  const changes: string[] = [];
  for (const stop of before.stops) {
    const next = after.stops.find(item => item.place.id === stop.place.id);
    if (!next) { changes.push(`${stop.place.name}を外します。`); continue; }
    if (next.dwellMinutes !== stop.dwellMinutes) changes.push(`${stop.place.name}の滞在：${stop.dwellMinutes}分 → ${next.dwellMinutes}分`);
    if (next.anchorTime !== stop.anchorTime) changes.push(`${stop.place.name}の固定開始：${stop.anchorTime ?? "指定なし"} → ${next.anchorTime ?? "指定なし"}`);
    if (next.spending !== stop.spending) changes.push(`${stop.place.name}の見積費用：${stop.spending ?? "未入力"} → ${next.spending === null ? "未入力" : `${next.spending}円`}`);
  }
  for (const stop of after.stops) if (!before.stops.some(old => old.place.id === stop.place.id)) changes.push(`${stop.place.name}を追加します。`);
  if (before.input.availableMinutes !== after.input.availableMinutes) changes.push(`使える時間：${before.input.availableMinutes}分 → ${after.input.availableMinutes}分`);
  if (before.input.budget !== after.input.budget) changes.push(`予算：${before.input.budget.toLocaleString("ja-JP")}円 → ${after.input.budget.toLocaleString("ja-JP")}円`);
  if (before.transportEstimate !== after.transportEstimate) changes.push("交通費の利用者見積もりを変更します。");
  if (!sameLocation(before.returnTo, after.returnTo) || before.returnTo.name !== after.returnTo.name) changes.push(`帰着先：${before.returnTo.name} → ${after.returnTo.name}`);
  return changes;
}
