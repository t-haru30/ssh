import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { MapViewProps } from "./MapView";

const MapView = lazy(() => import("./MapView").then(({ MapView: Component }) => ({
  default: Component,
})));

export function LazyMapView(props: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
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
  }, []);

  return (
    <div ref={containerRef}>
      {shouldLoad ? (
        <Suspense fallback={<MapPlaceholder message="地図を読み込んでいます…" />}>
          <MapView {...props} />
        </Suspense>
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
