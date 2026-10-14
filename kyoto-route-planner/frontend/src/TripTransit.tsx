import { useEffect, useRef, useState } from "react";
import type { Origin, RouteTimelineTransit } from "./types";
import { isRouteTimelineItem } from "./apiValidation";

export function transitRouteLabel(lineName: string | null | undefined, fallback = "路線未確認") {
  const routeName = lineName
    ?.split("/")
    .map((name) => name.trim())
    .filter((name) => name && name !== "移動")
    .join(" ↓ ") || fallback;
  return routeName;
}

export function TripTransit({ from, to, date, departureMinute, initial, onResult, externalBusy = false,routePriority="time",preferNearbyAirport=true }: {
  from: Origin; to: Origin; date: string; departureMinute: number;
  initial?: RouteTimelineTransit; externalBusy?: boolean; onResult: (result: RouteTimelineTransit) => void;
  routePriority?:"time"|"price";preferNearbyAirport?:boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const onResultRef = useRef(onResult);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  const contextKey = JSON.stringify([from, to, date, departureMinute]);
  useEffect(() => {
    setBusy(false); setError("");
    return () => { request.current?.abort(); request.current = null; };
  }, [contextKey]);
  async function search() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError("");
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const day = new Date(`${date}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() + Math.floor(departureMinute / 1440));
      const minute = departureMinute % 1440;
      const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
      const response = await fetch("/api/transit/segment", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          origin: { ...from, name: from.name.slice(0, 80) }, destination: { ...to, name: to.name.slice(0, 80) },
          departure_date: day.toISOString().slice(0, 10), departure_time: time,
          route_priority:routePriority,prefer_nearby_airport:preferNearbyAirport,
        }) });
      if (!response.ok) throw new Error(response.status === 503 ? "交通検索を利用できません。交通費は未確認です。" : "この区間の公共交通経路を取得できませんでした。条件を確認して再検索してください。");
      const result = await response.json() as RouteTimelineTransit;
      if (!isRouteTimelineItem(result) || result.type !== "transit" || result.mode !== "public_transport"
        || (result.fare_yen != null && (!Number.isFinite(result.fare_yen) || result.fare_yen < 0))
        || (result.duration_minutes != null && (!Number.isFinite(result.duration_minutes) || result.duration_minutes < 0))) throw new Error("交通情報を確認できませんでした。");
      if (!controller.signal.aborted && request.current === controller) onResultRef.current(result);
    } catch (reason) {
      if (controller.signal.aborted && request.current !== controller) return;
      setError(controller.signal.aborted ? "検索が時間切れになりました。もう一度お試しください。" : reason instanceof Error ? reason.message : "経路を取得できませんでした。");
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  const fare = initial?.fare_yen;
  const routeLegs = initial?.legs?.filter((leg) => leg.line_name !== "移動") ?? [];
  const routeLabel = initial
    ? transitRouteLabel(initial.legs?.length ? null : initial.transit_line)
    : "経路未確認";
  return <section className="trip-transit" aria-label={`${from.name}から${to.name}への移動`}>
    <strong>{from.name} → {to.name}</strong>
    {routeLegs.length > 1
      ? <>
        <ol className="trip-transit-route" aria-label="利用する交通手段">{routeLegs.map((leg, index) => <li key={`${leg.from_name}-${leg.to_name}-${index}`}>
          {index > 0 && <span className="trip-transit-route-arrow" aria-hidden="true">↓</span>}
          <span>{transitRouteLabel(leg.line_name)}</span>
        </li>)}</ol>
        {initial?.duration_minutes != null && <p>約{initial.duration_minutes}分</p>}
      </>
      : <p>{routeLegs.length === 1 ? transitRouteLabel(routeLegs[0].line_name) : routeLabel}
      {initial?.duration_minutes != null && ` · 約${initial.duration_minutes}分`}</p>
    }
    <p>{fare != null ? `概算運賃 ${fare.toLocaleString("ja-JP")}円` : busy || externalBusy ? "交通費を確認中…" : "交通費 未確認"}</p>
    {!!initial?.legs?.length && <details><summary>路線・乗換を見る</summary><ol>{initial.legs.map((leg, i) =>
      <li key={i}>{leg.from_name} → {leg.to_name}<br />{transitRouteLabel(leg.line_name)}{leg.duration_minutes != null && ` · 約${leg.duration_minutes}分`}</li>)}</ol>
      <small>駅すぱあと検索結果。施設と駅の間の徒歩・実際の発着時刻は出発前に確認してください。</small></details>}
    <button type="button" disabled={busy || externalBusy} onClick={() => void search()}>{busy || externalBusy ? "経路と運賃を検索中…" : "公共交通の経路・運賃を検索"}</button>
    {error && <p role="status">{error}</p>}
  </section>;
}
