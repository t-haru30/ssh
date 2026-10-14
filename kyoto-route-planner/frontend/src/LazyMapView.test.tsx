import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JourneyMap, LazyMapView } from "./LazyMapView";
import * as mapLoader from "./mapLoader";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observerState.callback = null;
  observerState.disconnect.mockClear();
});

describe("LazyMapView", () => {
  it("contains a failed map chunk without removing the trip, then retries the import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi.spyOn(mapLoader, "loadJourneyMap")
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module: /assets/old-map.js"))
      .mockResolvedValueOnce({ default: () => <div>復旧した地図</div> });
    render(<><h1>編集中の旅程</h1><JourneyMap places={[]} origin={{name:"京都駅",latitude:35,longitude:135}} /></>);
    expect((await screen.findByRole("alert")).textContent).toContain("旅程の編集は続けられます");
    expect(screen.getByRole("heading", {name:"編集中の旅程"})).toBeTruthy();
    expect(screen.getByRole("link", {name:"Google Mapsで場所を確認"}).getAttribute("href")).toContain(encodeURIComponent("京都駅"));
    fireEvent.click(screen.getByRole("button", {name:"地図を再読み込み"}));
    await screen.findByText("復旧した地図");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
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
