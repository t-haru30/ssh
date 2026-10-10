import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyMapView } from "./LazyMapView";
import type { MapViewProps } from "./MapView";

const observerState = vi.hoisted(() => ({
  callback: null as ((entries: Array<{ isIntersecting: boolean }>) => void) | null,
  disconnect: vi.fn(),
}));

vi.mock("./MapView", () => ({
  MapView: (props: MapViewProps) => (
    <div data-testid="loaded-map">{props.places[0]?.name ?? "empty-map"}</div>
  ),
}));

class TestIntersectionObserver {
  constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
    observerState.callback = callback;
  }

  observe() {}
  disconnect() {
    observerState.disconnect();
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  observerState.callback = null;
  observerState.disconnect.mockClear();
});

describe("LazyMapView", () => {
  it("loads the map only after its container approaches the viewport", async () => {
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    render(
      <LazyMapView
        places={[{
          id: "place-1",
          name: "清水寺",
          category: "寺院",
          description: "",
          access_point: "",
          latitude: 35,
          longitude: 135,
          themes: ["temple"],
        }]}
        origin={null}
      />,
    );

    expect(screen.getByText("地図は表示範囲に近づくと読み込まれます。")).toBeTruthy();
    expect(screen.queryByTestId("loaded-map")).toBeNull();
    act(() => {
      observerState.callback?.([{ isIntersecting: true }]);
    });

    await waitFor(() => expect(screen.getByTestId("loaded-map").textContent).toBe("清水寺"));
    expect(observerState.disconnect).toHaveBeenCalledOnce();
  });
});
