import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyMapView } from "./LazyMapView";
import type { MapViewProps } from "./MapView";

const observerState = vi.hoisted(() => ({
  callback: null as ((entries: Array<{ isIntersecting: boolean }>) => void) | null,
  disconnect: vi.fn(),
}));

vi.mock("./GoogleJourneyMap", () => ({
  GoogleJourneyMap: (props: MapViewProps) => (
    <div data-testid="loaded-map" data-return-name={props.returnTo?.name}>{props.places[0]?.name ?? "empty-map"}</div>
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
        returnTo={{ name: "大阪駅", latitude: 34.7, longitude: 135.5 }}
      />,
    );

    expect(screen.getByText("地図は表示範囲に近づくと読み込まれます。")).toBeTruthy();
    expect(screen.queryByTestId("loaded-map")).toBeNull();
    act(() => {
      observerState.callback?.([{ isIntersecting: true }]);
    });

    await waitFor(() => expect(screen.getByTestId("loaded-map").textContent).toBe("清水寺"));
    expect(screen.getByTestId("loaded-map").getAttribute("data-return-name")).toBe("大阪駅");
    expect(observerState.disconnect).toHaveBeenCalledOnce();
  });
});
