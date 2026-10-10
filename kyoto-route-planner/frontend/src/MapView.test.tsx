import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";
import type { Origin, Place } from "./types";

const mapTestState = vi.hoisted(() => ({
  loadHandler: null as (() => void) | null,
  markerPositions: [] as number[][],
  routeData: null as unknown,
  fitBoundsCalls: 0,
  layers: [] as Array<Record<string, unknown>>,
  transitMarkers: [] as Array<{ label: string | null; position: number[] }>,
  markerAnchors: [] as Array<{ label: string | null; anchor: string | undefined; position: string | undefined }>,
}));

vi.mock("maplibre-gl", () => {
  class MockMap {
    private source: { type: string; setData: (data: unknown) => void } | null = null;

    constructor() {}
    addControl() {}
    on(_event: string, handler: () => void) {
      mapTestState.loadHandler = handler;
    }
    addSource(_id: string, source: { type: string }) {
      this.source = {
        type: source.type,
        setData: (data) => {
          mapTestState.routeData = data;
        },
      };
    }
    addLayer(layer: Record<string, unknown>) {
      mapTestState.layers.push(layer);
    }
    addImage() {}
    getSource() {
      return this.source;
    }
    fitBounds() {
      mapTestState.fitBoundsCalls += 1;
    }
    flyTo() {}
    remove() {}
  }

  class MockMarker {
    private label: string | null;

    constructor(options?: { element?: HTMLElement; anchor?: string }) {
      this.label = options?.element?.getAttribute("aria-label") ?? null;
      mapTestState.markerAnchors.push({
        label: this.label,
        anchor: options?.anchor,
        position: options?.element?.style.position,
      });
    }
    setLngLat(position: number[]) {
      mapTestState.markerPositions.push(position);
      if (this.label?.includes("への移動手段")) {
        mapTestState.transitMarkers.push({ label: this.label, position });
      }
      return this;
    }
    setPopup() {
      return this;
    }
    addTo() {
      return this;
    }
    remove() {}
  }

  class MockPopup {
    constructor() {}
    setText() {
      return this;
    }
  }

  class MockBounds {
    extend() {
      return this;
    }
  }

  return {
    LngLatBounds: MockBounds,
    Map: MockMap,
    Marker: MockMarker,
    NavigationControl: class {},
    Popup: MockPopup,
    setWorkerUrl: vi.fn(),
  };
});

vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
  default: "mock-worker.js",
}));

function makePlace(id: string, latitude: number, longitude: number): Place {
  return {
    id,
    name: id,
    category: "公園",
    description: "",
    access_point: "",
    latitude,
    longitude,
    themes: ["nature"],
  };
}

function makeOrigin(name: string, latitude: number, longitude: number): Origin {
  return { name, latitude, longitude };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mapTestState.loadHandler = null;
  mapTestState.markerPositions = [];
  mapTestState.routeData = null;
  mapTestState.fitBoundsCalls = 0;
  mapTestState.layers = [];
  mapTestState.transitMarkers = [];
  mapTestState.markerAnchors = [];
});

beforeEach(() => {
  vi.stubGlobal("ImageData", class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  });
});

describe("MapView", () => {
  it("applies the latest props when the map finishes loading", () => {
    const firstPlace = makePlace("初期候補", 35, 135);
    const latestPlace = makePlace("最新候補", 35.5, 135.5);
    const view = render(
      <MapView places={[firstPlace]} origin={null} coordinates={[]} />,
    );

    view.rerender(
      <MapView
        places={[latestPlace]}
        origin={makeOrigin("京都駅", 34.9858, 135.7588)}
        coordinates={[[35.5, 135.5], [34.9858, 135.7588]]}
      />,
    );
    act(() => {
      mapTestState.loadHandler?.();
    });

    expect(mapTestState.markerPositions).toEqual([
      [135.7588, 34.9858],
      [135.5, 35.5],
    ]);
    expect(mapTestState.fitBoundsCalls).toBe(1);
    expect(mapTestState.routeData).toMatchObject({
      geometry: {
        coordinates: [[135.5, 35.5], [135.7588, 34.9858]],
      },
    });
    const routeCoordinates = (
      mapTestState.routeData as { geometry: { coordinates: number[][] } }
    ).geometry.coordinates;
    mapTestState.markerPositions.forEach((position) => {
      expect(routeCoordinates).toContainEqual(position);
    });
    expect(mapTestState.markerAnchors).toContainEqual({
      label: "自然: 最新候補",
      anchor: "bottom",
      position: "absolute",
    });
  });

  it("adds regularly spaced arrows following the route direction", () => {
    render(<MapView places={[]} origin={null} coordinates={[]} />);
    act(() => {
      mapTestState.loadHandler?.();
    });

    expect(mapTestState.layers).toContainEqual(expect.objectContaining({
      id: "route-direction-arrows",
      type: "symbol",
      source: "route",
      layout: expect.objectContaining({
        "symbol-placement": "line",
        "symbol-spacing": 80,
        "icon-anchor": "center",
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      }),
    }));
  });

  it("places each transit icon at the midpoint of its stop segment", () => {
    const firstStop = makePlace("清水寺", 35, 135.02);
    const secondStop = makePlace("高台寺", 35, 135.04);
    render(
      <MapView
        places={[firstStop, secondStop]}
        origin={makeOrigin("京都駅", 35, 135)}
        legs={[
          { from_name: "京都駅", to_name: "清水寺", line_name: "電車", mode: "train", duration_minutes: 10 },
          { from_name: "清水寺", to_name: "高台寺", line_name: "バス", mode: "bus", duration_minutes: 5 },
        ]}
      />,
    );
    act(() => {
      mapTestState.loadHandler?.();
    });

    expect(mapTestState.transitMarkers).toEqual([
      { label: "京都駅から清水寺への移動手段: 電車", position: [135.01, 35] },
      { label: "清水寺から高台寺への移動手段: バス", position: [135.03, 35] },
    ]);
  });

  it("keeps multiple transit icons on the exact same segment midpoint", () => {
    const stop = makePlace("清水寺", 35, 135.02);
    render(
      <MapView
        places={[stop]}
        origin={makeOrigin("京都駅", 35, 135)}
        legs={[
          { from_name: "京都駅", to_name: "清水寺", line_name: "電車", mode: "train", duration_minutes: 10 },
          { from_name: "京都駅", to_name: "清水寺", line_name: "バス", mode: "bus", duration_minutes: 15 },
        ]}
      />,
    );
    act(() => {
      mapTestState.loadHandler?.();
    });

    expect(mapTestState.transitMarkers.map((marker) => marker.position)).toEqual([
      [135.01, 35],
      [135.01, 35],
    ]);
  });
});
