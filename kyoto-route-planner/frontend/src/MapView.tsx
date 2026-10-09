import { useEffect, useRef } from "react";
import {
  LngLatBounds,
  Map as MapLibre,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Origin, Place, RouteLeg } from "./types";
import type { GeoJSONSource } from "maplibre-gl";

const mapStyle = "https://tiles.openfreemap.org/styles/positron";
const kyotoCenter: [number, number] = [135.7681, 35.004];

type MapViewProps = {
  places: Place[];
  origin: Origin | null;
  coordinates?: [number, number][];
  legs?: RouteLeg[];
};

type MarkerLocation = {
  name: string;
  longitude: number;
  latitude: number;
  category: string;
  address?: string;
  themes: Place["themes"];
  order: number | null;
  isOrigin: boolean;
};

const categoryIcons = {
  temple: {
    color: "#a64f43",
    background: "#fff0e8",
    svg: '<path d="M12 3 3 8h18L12 3Z"/><path d="M5 10h14M6 11v7m4-7v7m4-7v7m4-7v7M4 20h16"/>',
    label: "寺社仏閣",
  },
  nature: {
    color: "#397653",
    background: "#e8f6e9",
    svg: '<path d="M20.5 3.5C12 3 5 6 4 12c-.6 3.5 2 6 5.3 5.5C15 16.5 19 10 20.5 3.5Z"/><path d="M3 21c3-6 7-9 13-12"/>',
    label: "自然",
  },
  food: {
    color: "#b66a21",
    background: "#fff2d9",
    svg: '<path d="M7 3v7m-3-7v4a3 3 0 0 0 6 0V3M7 10v11m10-18v18m0-18c-3 2-4 5-4 8h4"/>',
    label: "グルメ",
  },
  lodging: {
    color: "#6253bd",
    background: "#efedff",
    svg: '<path d="M3 19V6m0 9h18v4M3 15h18v-4a2 2 0 0 0-2-2h-5v6M7 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/>',
    label: "宿泊施設",
  },
  culture: {
    color: "#416fc0",
    background: "#e9f1ff",
    svg: '<path d="m3 9 9-6 9 6v2H3V9Zm2 3v7m5-7v7m4-7v7m5-7v7M3 21h18"/>',
    label: "文化・観光",
  },
  shopping: {
    color: "#ad4e78",
    background: "#ffedf4",
    svg: '<path d="M5 8h14l1 13H4L5 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/>',
    label: "買い物",
  },
  default: {
    color: "#bd654c",
    background: "#fff0e8",
    svg: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/>',
    label: "観光スポット",
  },
  origin: {
    color: "#fff",
    background: "#456c56",
    svg: '<path d="M4 17h16M6 17V7h12v10M8 7V4h8v3M8 11h.01M16 11h.01M9 17l-2 3m8-3 2 3"/>',
    label: "出発地",
  },
} as const;

const modeIcons = {
  walk: {
    icon: "walk",
    label: "徒歩",
    color: "#52785a",
    svg: '<circle cx="15" cy="4" r="2"/><path d="m12 22 2-6-3-3-2 4-4 2m9-8 3 3 2 4m-8-7 2-4 4 2"/>',
  },
  train: {
    icon: "train",
    label: "電車",
    color: "#4c6fbe",
    svg: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 21 10 18m6 3-2-3M8 7h8m-8 5h.01M16 12h.01M8 15h8"/>',
  },
  bus: {
    icon: "bus",
    label: "バス",
    color: "#bf765e",
    svg: '<rect x="4" y="4" width="16" height="15" rx="3"/><path d="M7 4V2m10 2V2M4 9h16M8 19v2m8-2v2M8 14h.01M16 14h.01"/>',
  },
} as const;

function iconSvg(content: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${content}</svg>`;
}

function getCategoryIcon(category: string, name: string, themes: Place["themes"] = []) {
  const normalized = `${category} ${name}`.toLowerCase();
  if (/hotel|hostel|ryokan|lodging|宿|ホテル|旅館|民宿/.test(normalized)) return categoryIcons.lodging;
  if (
    themes.includes("temple")
    || /temple|shrine|place_of_worship|寺|神社|大社|宮|観音|仏閣/.test(normalized)
  ) return categoryIcons.temple;
  if (themes.includes("nature")) return categoryIcons.nature;
  if (themes.includes("food")) return categoryIcons.food;
  if (/park|garden|nature|mountain|forest|waterfall|公園|自然|山|森|滝|川|海|景勝/.test(normalized)) return categoryIcons.nature;
  if (/restaurant|food|cafe|market|グルメ|飲食|食堂|料理|市場|カフェ|蕎麦|寿司/.test(normalized)) return categoryIcons.food;
  if (/shopping|shop|store|商店|買い物|土産|ショッピング/.test(normalized)) return categoryIcons.shopping;
  if (themes.includes("history")) return categoryIcons.culture;
  if (/museum|art|culture|観光|美術|博物|文化|史跡|城|展望/.test(normalized)) return categoryIcons.culture;
  return categoryIcons.default;
}

function getModeIcon(mode: string) {
  const normalized = mode.toLowerCase();
  if (normalized.includes("walk") || normalized.includes("foot") || mode.includes("徒歩")) return modeIcons.walk;
  if (normalized.includes("bus") || mode.includes("バス")) return modeIcons.bus;
  if (
    normalized.includes("train")
    || normalized.includes("rail")
    || normalized.includes("subway")
    || mode.includes("電車")
    || mode.includes("地下鉄")
  ) return modeIcons.train;
  return null;
}

function createSpotMarker(location: MarkerLocation) {
  const icon = location.isOrigin
    ? categoryIcons.origin
    : getCategoryIcon(location.category, location.name, location.themes);
  const element = document.createElement("div");
  element.className = location.isOrigin ? "map-illustration-marker map-illustration-origin" : "map-illustration-marker";
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", `${icon.label}: ${location.name}`);
  element.innerHTML = `<span class="map-marker-art" style="--marker-color:${icon.color};--marker-background:${icon.background}">${iconSvg(icon.svg)}</span>${location.order === null ? "" : `<span class="map-marker-order">${location.order}</span>`}`;
  return element;
}

function findPathMidpoint(coordinates: [number, number][]) {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return coordinates[0];
  const lengths = coordinates.slice(1).map((point, index) => (
    Math.hypot(point[0] - coordinates[index][0], point[1] - coordinates[index][1])
  ));
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (totalLength === 0) return coordinates[0];
  let remaining = totalLength / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const segmentLength = lengths[index];
    if (remaining <= segmentLength) {
      const ratio = segmentLength === 0 ? 0 : remaining / segmentLength;
      return [
        coordinates[index][0] + (coordinates[index + 1][0] - coordinates[index][0]) * ratio,
        coordinates[index][1] + (coordinates[index + 1][1] - coordinates[index][1]) * ratio,
      ] as [number, number];
    }
    remaining -= segmentLength;
  }
  return coordinates[coordinates.length - 1];
}

function routeFeature(coordinates: [number, number][]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "LineString" as const,
      coordinates: coordinates.length > 1
        ? coordinates.map(([latitude, longitude]) => [longitude, latitude])
        : [],
    },
  };
}

export function MapView({ places, origin, coordinates = [], legs = [] }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const coordinatesRef = useRef(coordinates);
  coordinatesRef.current = coordinates;

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
        id: "route-line-casing",
        type: "line",
        source: "route",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#fffaf0",
          "line-width": 8,
          "line-opacity": 0.92,
        },
      });
      const routeSource = map.getSource("route");
      if (routeSource?.type === "geojson") {
        (routeSource as GeoJSONSource).setData(routeFeature(coordinatesRef.current));
      }
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: {
          "line-join": "round",
          "line-cap": "round",
        },
        paint: {
          "line-color": "#d4765b",
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [1.2, 1.6],
        },
      });
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
    const locations: MarkerLocation[] = [
      ...(origin
        ? [{
          name: origin.name,
          longitude: origin.longitude,
          latitude: origin.latitude,
          category: "station",
          themes: [],
          order: null,
          isOrigin: true,
        }]
        : []),
      ...places.map((place, index) => ({
        name: place.name,
        longitude: place.longitude,
        latitude: place.latitude,
        category: place.category,
        address: place.address,
        themes: place.themes,
        order: index + 1,
        isOrigin: false,
      })),
    ];

    for (const location of locations) {
      const element = createSpotMarker(location);
      const popupText = location.isOrigin
        ? `出発地 · ${location.name}`
        : [
          `${getCategoryIcon(location.category, location.name, location.themes).label} · ${location.name}`,
          location.address,
        ].filter(Boolean).join("\n");
      const marker = new Marker({ element, anchor: "bottom" })
        .setLngLat([location.longitude, location.latitude])
        .setPopup(new Popup({ closeButton: false, offset: 8 }).setText(popupText))
        .addTo(map);
      markersRef.current.push(marker);
    }

    const midpoint = findPathMidpoint(coordinates);
    const uniqueModes = [...new Set(legs.map((leg) => getModeIcon(leg.mode)?.icon).filter(
      (mode): mode is keyof typeof modeIcons => mode !== undefined && mode !== null,
    ))];
    if (midpoint && uniqueModes.length > 0) {
      uniqueModes.forEach((mode, index) => {
        const modeIcon = modeIcons[mode];
        const element = document.createElement("div");
        element.className = `map-transit-marker map-transit-${mode}`;
        element.setAttribute("role", "img");
        element.setAttribute("aria-label", `ルート上の移動手段: ${modeIcon.label}`);
        element.innerHTML = iconSvg(modeIcon.svg);
        const offset = (index - (uniqueModes.length - 1) / 2) * 28;
        const marker = new Marker({
          element,
          anchor: "center",
          offset: [offset, 0],
        })
          .setLngLat([midpoint[1], midpoint[0]])
          .setPopup(new Popup({ closeButton: false, offset: 14 }).setText(
            `このルートに含まれる移動手段: ${modeIcon.label}`,
          ))
          .addTo(map);
        markersRef.current.push(marker);
      });
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

    const source = map.getSource("route");
    if (source?.type === "geojson") {
      (source as GeoJSONSource).setData({
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: routeFeature(coordinates).geometry.coordinates,
        },
      });
    }

  }, [origin, places, coordinates, legs]);

  return (
    <div className="map-frame">
      <div className="map-canvas" ref={containerRef} aria-label="京都の候補地地図" />
      <div className="map-disclaimer">ピンは検索結果のスポット座標です。選択すると住所を確認できます。線はスポット間の目安で、実際の交通経路とは異なります。</div>
    </div>
  );
}
