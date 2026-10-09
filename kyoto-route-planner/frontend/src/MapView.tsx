import { useEffect, useRef } from "react";
import { LngLatBounds, Map as MapLibre, Marker, NavigationControl, Popup, setWorkerUrl } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Origin, Place, RouteLeg } from "./types";

const mapStyle = "https://tiles.openfreemap.org/styles/liberty";
const kyotoCenter: [number, number] = [135.7681, 35.004];

type MapViewProps = {
  places: Place[];
  origin: Origin | null;
  coordinates?: [number, number][];
  legs?: RouteLeg[];
};

function placeIcon(category: string, themes: Place["themes"]) {
  const text = `${category} ${themes.join(" ")}`.toLowerCase();
  if (/神社|寺| temple|history|文化|城/.test(text)) return "⛩️";
  if (/自然|公園|山|川|海|nature|景色/.test(text)) return "🌳";
  if (/食|グルメ|料理|カフェ|food|市場/.test(text)) return "🍴";
  if (/宿|ホテル|旅館|hotel/.test(text)) return "🏨";
  return "📍";
}

function transitIcon(mode: string) {
  if (/歩|walk/i.test(mode)) return "🚶";
  if (/バス|bus/i.test(mode)) return "🚌";
  return "🚃";
}

export function MapView({ places, origin, coordinates, legs = [] }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const coordinatesRef = useRef(coordinates);

  useEffect(() => {
    coordinatesRef.current = coordinates;
  }, [coordinates]);

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
    map.on("load", () => {
      map.addSource("route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [] },
        },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#bf765e", "line-width": 4, "line-opacity": 0.7 },
      });
      const source = map.getSource("route") as GeoJSONSource | undefined;
      if (source) {
        source.setData({
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: coordinatesRef.current?.length
              ? coordinatesRef.current.map(([latitude, longitude]) => [longitude, latitude])
              : [],
          },
        });
      }
    });
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
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
      ...(origin ? [{
        name: `出発 ${origin.name}`,
        longitude: origin.longitude,
        latitude: origin.latitude,
        icon: "🚉",
        className: "map-marker-origin",
      }] : []),
      ...places.map((place) => ({
        name: place.name,
        longitude: place.longitude,
        latitude: place.latitude,
        icon: placeIcon(place.category, place.themes),
        className: "map-marker-spot",
      })),
    ];

    locations.forEach((location) => {
      const element = document.createElement("div");
      element.className = `map-marker ${location.className}`;
      element.textContent = location.icon;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", location.name);
      markersRef.current.push(
        new Marker({ element, anchor: "bottom" })
          .setLngLat([location.longitude, location.latitude])
          .setPopup(new Popup({ closeButton: false, offset: 18 }).setText(location.name))
          .addTo(map),
      );
    });

    const routeLocations = [
      ...(origin ? [origin] : []),
      ...places,
    ];
    legs.forEach((leg, index) => {
      if (routeLocations.length < 2) return;
      const element = document.createElement("div");
      element.className = "map-transit-marker";
      element.textContent = transitIcon(leg.mode);
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `${leg.line_name} ${leg.mode}`);
      const routePoint = coordinates && coordinates.length > 1
        ? coordinates[Math.min(
          coordinates.length - 1,
          Math.floor(((index + 0.5) / legs.length) * coordinates.length),
        )]
        : null;
      const segmentIndex = Math.min(
        routeLocations.length - 2,
        Math.floor(((index + 0.5) / legs.length) * (routeLocations.length - 1)),
      );
      const from = routeLocations[segmentIndex];
      const to = routeLocations[segmentIndex + 1];
      if (!from || !to) return;
      markersRef.current.push(
        new Marker({ element, anchor: "center" })
          .setLngLat(routePoint
            ? [routePoint[1], routePoint[0]]
            : [(from.longitude + to.longitude) / 2, (from.latitude + to.latitude) / 2])
          .setPopup(new Popup({ closeButton: false, offset: 14 }).setText(leg.line_name))
          .addTo(map),
      );
    });

    if (locations.length > 1) {
      const bounds = new LngLatBounds();
      locations.forEach((point) => bounds.extend([point.longitude, point.latitude]));
      map.fitBounds(bounds, { padding: 64, maxZoom: 13, duration: 350 });
    } else if (locations.length === 1) {
      map.flyTo({ center: [locations[0].longitude, locations[0].latitude], zoom: 13, duration: 350 });
    } else {
      map.flyTo({ center: kyotoCenter, zoom: 11, duration: 350 });
    }
  }, [origin, places, legs, coordinates]);

  useEffect(() => {
    const source = mapRef.current?.getSource("route") as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: coordinates && coordinates.length > 1
          ? coordinates.map(([latitude, longitude]) => [longitude, latitude])
          : [],
      },
    });
  }, [coordinates]);

  return (
    <div className="map-frame">
      <div className="map-canvas" ref={containerRef} aria-label="京都の候補地地図" />
      <div className="map-disclaimer">ピンは候補地の位置です。線は実際の交通経路を示しません。</div>
    </div>
  );
}
