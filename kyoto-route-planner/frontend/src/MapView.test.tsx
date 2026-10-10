import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapView } from "./MapView";
import type { Origin, Place } from "./types";

const mapTestState = vi.hoisted(() => ({
  loadHandler: null as (() => void) | null,
  markerPositions: [] as number[][],
  routeData: null as unknown,
  fitBoundsCalls: 0,
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
    addLayer() {}
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
    constructor() {}
    setLngLat(position: number[]) {
      mapTestState.markerPositions.push(position);
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
  mapTestState.loadHandler = null;
  mapTestState.markerPositions = [];
  mapTestState.routeData = null;
  mapTestState.fitBoundsCalls = 0;
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
  });
});
