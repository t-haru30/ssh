import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import type { RouteIdea } from "../SwipeCard";
import { routeSelection } from "../routeSelection";
import type { DatasetRoute } from "./datasetTypes";
import { categoryIcon, formatMinutes } from "./DiscoverCard";
import { VenueEvidence } from "../VenueEvidence";
import "./discover.css";

const MapView = lazy(() => import("../MapView").then(({ MapView: Component }) => ({ default: Component })));
type RouteDetailModalProps = { route: DatasetRoute | RouteIdea; onClose: () => void; onPlanInSearch?: (route: DatasetRoute | RouteIdea) => void };

export function RouteDetailModal({ route, onClose, onPlanInSearch }: RouteDetailModalProps) {
  const selection = useMemo(() => routeSelection(route), [route]);
  const { places, origin: start, dwellMinutes } = selection;
  const isStaticRoute = "spots" in route;
  const coordinates: [number, number][] = places.map(place => [place.latitude, place.longitude]);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const targets = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]');
      if (!targets?.length) return;
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);

  return <div className="route-modal-backdrop" onClick={onClose}>
    <section ref={dialogRef} className="route-modal discover-route-modal" role="dialog" aria-modal="true" aria-label={route.title} onClick={event => event.stopPropagation()}>
      <header className="route-modal-header"><div><p className="eyebrow">YOUR LITTLE JOURNEY</p><h2>{route.title}</h2></div><button ref={closeRef} type="button" className="route-modal-close" onClick={onClose} aria-label="閉じる">✕</button></header>
      <div className="discover-modal-facts"><span><strong>{places.length}</strong> か所のよりみち</span>{isStaticRoute && <span>所要時間の目安 <strong>{formatMinutes(route.estimated_minutes)}</strong></span>}</div>
      {!isStaticRoute && route.story && <p className="discover-modal-story">{route.story}</p>}
      <div className="route-modal-map"><Suspense fallback={<div className="map-canvas map-canvas-placeholder" role="status">地図を読み込んでいます…</div>}><MapView places={places} origin={start} coordinates={[[start.latitude, start.longitude], ...coordinates]} legs={[]} /></Suspense></div>
      <div className="discover-modal-section-heading"><h3>この旅で訪れる場所</h3><span>{places.length} SPOTS</span></div>
      <p className="discover-modal-origin">出発の目安：{start.name}<small>出発地は計画画面で変更できます</small></p>
      <ol className="discover-modal-spots">{places.map((place, index) => <li key={place.id}><span className="discover-modal-spot-number">{String(index + 1).padStart(2, "0")}</span><div><strong>{place.name}</strong><span>{categoryIcon(place.category)} {place.category}{dwellMinutes[place.id] !== undefined && ` · 滞在の目安 ${formatMinutes(dwellMinutes[place.id])}`}</span></div><VenueEvidence place={place} /></li>)}</ol>
      <div className="discover-modal-footer"><p className="result-note">訪問順と所要時間は目安です。営業時間や移動手段を確認して、旅の計画を仕上げましょう。</p>{onPlanInSearch && <button type="button" className="idea-primary-button" onClick={() => onPlanInSearch(route)}>このルートで旅を計画する <span aria-hidden="true">→</span></button>}</div>
    </section>
  </div>;
}
