import { useEffect, useRef } from "react";
import { LngLatBounds, Map as MapLibre, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Origin, Place } from "./types";

const mapStyle = "https://tiles.openfreemap.org/styles/liberty";
const kyotoCenter: [number, number] = [135.7681, 35.004];

type MapViewProps = {
  places: Place[];
  origin: Origin | null;
};

export function MapView({ places, origin }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<Marker[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    setWorkerUrl(workerUrl);
    const map = new MapLibre({
      container: containerRef.current,
      style: mapStyle,
      center: kyotoCenter,
      zoom: 11,
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    const locations = [
      ...(origin ? [{ name: `出発 ${origin.name}`, longitude: origin.longitude, latitude: origin.latitude, isOrigin: true }] : []),
      ...places.map((place, index) => ({
        name: `${index + 1}. ${place.name}`,
        longitude: place.longitude,
        latitude: place.latitude,
        isOrigin: false,
      })),
    ];

    for (const location of locations) {
      const element = document.createElement("div");
      element.className = location.isOrigin ? "map-marker map-marker-origin" : "map-marker";
      element.textContent = location.isOrigin ? "出" : location.name.split(".")[0];
      const marker = new Marker({ element })
        .setLngLat([location.longitude, location.latitude])
        .setPopup(new Popup({ closeButton: false, offset: 18 }).setText(location.name))
        .addTo(map);
      markersRef.current.push(marker);
    }

    if (locations.length > 1) {
      const bounds = new LngLatBounds();
      locations.forEach((point) => bounds.extend([point.longitude, point.latitude]));
      map.fitBounds(bounds, { padding: 64, maxZoom: 13, duration: 350 });
    } else if (locations.length === 1) {
      map.flyTo({ center: [locations[0].longitude, locations[0].latitude], zoom: 13, duration: 350 });
    } else {
      map.flyTo({ center: kyotoCenter, zoom: 11, duration: 350 });
    }
  }, [origin, places]);

  return (
    <div className="map-frame">
      <div className="map-canvas" ref={containerRef} aria-label="京都の候補地地図" />
      <div className="map-disclaimer">ピンは候補地の位置です。線は実際の交通経路を示しません。</div>
    </div>
  );
}
