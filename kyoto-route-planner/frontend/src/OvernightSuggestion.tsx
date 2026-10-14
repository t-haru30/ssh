import { useEffect, useState } from "react";
import { clockMinutes, distanceKm, type TripPlan } from "./dayTrip";
import { isOrigin, isRecord } from "./apiValidation";
import { googleMapsUrl } from "./mapLinks";
import type { Origin } from "./types";

export function overnightReason(plan: TripPlan): string {
  if (plan.unknownTravelSegments?.length) {
    const gateway = plan.stops.find(stop => stop.place.id === "trip-arrival")?.place ?? plan.stops[0]?.place;
    return gateway && distanceKm(plan.origin, gateway) > 500 ? "移動距離が長いため、宿泊を含む旅も検討できます。" : "";
  }
  return plan.returnMinute >= 1440 || plan.returnMinute - clockMinutes(plan.input.departureTime) > 14 * 60
    ? "帰着が翌日になる、または移動・観光が14時間を超えるため、宿泊をおすすめします。" : "";
}

type Hotel = Origin & { id: string; address?: string; tags?: Record<string, string> };
export function OvernightSuggestion({ plan, pending }: { plan: TripPlan; pending: boolean }) {
  const reason = overnightReason(plan);
  const gateway = plan.stops.find(stop => stop.place.id === "trip-arrival")?.place ?? plan.stops[0]?.place ?? plan.origin;
  const key = JSON.stringify([gateway.latitude, gateway.longitude, Boolean(reason), pending]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setHotels([]); setMessage("");
    if (pending || !reason) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = window.setTimeout(() => controller.abort(), 20_000);
    setMessage("行き先周辺の宿泊候補を探しています…");
    void (async () => {
      try {
        const response = await fetch("/api/lodging/suggestions", { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            origin: { name: gateway.name.slice(0, 80), latitude: gateway.latitude, longitude: gateway.longitude },
          }) });
        const data: unknown = await response.json();
        if (!response.ok || !isRecord(data) || !Array.isArray(data.places) || !data.places.every(place => isRecord(place) && typeof place.id === "string" && isOrigin(place))) throw new Error();
        if (disposed) return;
        setHotels(data.places as Hotel[]);
        setMessage(data.places.length ? "空室・料金は予約先でご確認ください。" : "宿泊候補が見つかりませんでした。行き先周辺のホテルを地図で探せます。");
      } catch { if (!disposed) setMessage("宿泊候補を取得できませんでした。再検索するか、地図で探せます。"); }
      finally { window.clearTimeout(timer); }
    })();
    return () => { disposed = true; window.clearTimeout(timer); controller.abort(); };
  }, [key, retry]);
  if (pending || !reason) return null;
  return <aside className="trip-overnight-suggestion" aria-label="宿泊の提案">
    <h4>ゆっくり楽しむなら、行き先で一泊</h4>
    <p>{reason}</p>
    <ul>{hotels.map(hotel => <li key={hotel.id}><a href={googleMapsUrl(hotel)} target="_blank" rel="noopener noreferrer">{hotel.name} ↗</a><small>{hotel.address || "観光の起点の周辺"}</small></li>)}</ul>
    <p role="status">{message}</p>
    {!!hotels.length && <small>候補：OpenStreetMap。空室・宿泊料金は未確認です。</small>}
    {!hotels.length && <button type="button" onClick={() => setRetry(v => v + 1)}>宿泊候補を再検索</button>}
    <a href={googleMapsUrl({ ...gateway, name: `${gateway.name} 周辺 ホテル` })} target="_blank" rel="noopener noreferrer">周辺のホテルを地図で見る ↗</a>
  </aside>;
}
