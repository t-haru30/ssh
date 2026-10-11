import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchMode } from "./SearchMode";

vi.mock("./LazyMapView", () => ({ LazyMapView: () => null }));
vi.mock("./RouteTimeline", () => ({
  buildDayTimeline: () => [],
  buildRouteTimeline: () => [],
  RouteTimeline: () => null,
  withRouteLegs: (items: unknown) => items,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchMode nearby departures", () => {
  it("loads nearby station and stop options and submits the selected coordinates", async () => {
    const origins = [
      { name: "京都駅", latitude: 35.0, longitude: 135.0 },
      { name: "大阪駅", latitude: 34.7, longitude: 135.5 },
    ];
    const nearbyStations = [
      { name: "最寄りバス停", latitude: 35.001, longitude: 135.001 },
      { name: "周辺地下鉄駅", latitude: 35.002, longitude: 135.002 },
    ];
    let submittedRequest: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = url.includes("/api/origins")
        ? origins
        : url.includes("/api/nearby-stations")
          ? nearbyStations
          : url.includes("/api/places/status")
            ? { warning: null, state: "success" }
            : [];
      if (url.includes("/api/routes")) {
        submittedRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { ok: false, json: async () => ({ detail: "test complete" }) } as Response;
      }
      return { ok: true, json: async () => json } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const getCurrentPosition = vi.fn((success: PositionCallback) => {
      success({
        coords: { latitude: 35.123, longitude: 135.456 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    render(<SearchMode active />);
    expect(screen.queryByText("スワイプで寄り道を見つける")).toBeNull();

    const departureSelect = (await screen.findAllByRole("combobox"))[0];
    const locationButton = await screen.findByRole("button", { name: "現在地から探す" });
    await waitFor(() => expect((locationButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(locationButton);

    const nearbyGroup = await screen.findByRole("group", { name: "現在地周辺" });
    await waitFor(() => expect((departureSelect as HTMLSelectElement).value).toBe("最寄りバス停"));
    expect(nearbyGroup.textContent).toContain("最寄りバス停");
    expect(screen.getByRole("group", { name: "主要駅" }).textContent).toContain("京都駅");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nearby-stations?latitude=35.123&longitude=135.456",
      expect.anything(),
    );

    fireEvent.change(departureSelect, { target: { value: "周辺地下鉄駅" } });
    fireEvent.click(screen.getByRole("button", { name: /旅のしおりを作る/ }));
    await waitFor(() => expect(submittedRequest).not.toBeNull());
    expect(submittedRequest).toMatchObject({
      origin: "周辺地下鉄駅",
      origin_latitude: 35.002,
      origin_longitude: 135.002,
    });
  });
});
