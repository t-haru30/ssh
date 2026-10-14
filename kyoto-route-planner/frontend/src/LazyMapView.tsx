import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { MapViewProps } from "./MapView";
import { loadJourneyMap } from "./mapLoader";
import { googleMapsUrl } from "./mapLinks";

class MapLoadBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** A missing chunk must only replace the map, never the trip or chat. */
export function JourneyMap(props: MapViewProps) {
  const [attempt, setAttempt] = useState(0);
  const MapView = useMemo(() => lazy(loadJourneyMap), [attempt]);
  const place = props.places[0] ?? props.origin;
  return <MapLoadBoundary key={attempt} fallback={
    <div className="map-frame map-load-failure" role="alert">
      <p>地図を読み込めませんでした。旅程の編集は続けられます。</p>
      <div><button type="button" onClick={() => setAttempt(value => value + 1)}>地図を再読み込み</button>
        <button type="button" onClick={() => window.location.reload()}>ページを更新</button></div>
      {place && <a href={googleMapsUrl(place)} target="_blank" rel="noopener noreferrer">Google Mapsで場所を確認</a>}
    </div>
  }>
    <Suspense fallback={<MapPlaceholder message="地図を読み込んでいます…" />}><MapView {...props} /></Suspense>
  </MapLoadBoundary>;
}

export function LazyMapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || props.visible===false) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setShouldLoad(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.visible]);

  return (
    <div ref={containerRef}>
      {shouldLoad ? (
        <JourneyMap {...props} />
      ) : (
        <MapPlaceholder message="地図は表示範囲に近づくと読み込まれます。" />
      )}
    </div>
  );
}

function MapPlaceholder({ message }: { message: string }) {
  return (
    <div className="map-frame" role="status" aria-label={message}>
      <div className="map-canvas map-canvas-placeholder">{message}</div>
    </div>
  );
}
