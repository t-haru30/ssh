import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouteDetailModal } from "./RouteDetailModal";
import type { RouteSuggestion } from "../types";
import type { DatasetRoute } from "./datasetTypes";

vi.mock("../MapView", () => ({ MapView: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RouteDetailModal", () => {
  it("loads the Ekispert preview and renders its line and corrected times", async () => {
    const route: DatasetRoute = {
      id: "kyoto-sample",
      area: "kyoto",
      pattern: "half_day",
      course: "half_day",
      theme: "temple",
      title: "京都の寺社を巡る",
      estimated_minutes: 120,
      legs: [
        { from: "京都駅", to: "伏見稲荷大社", distance_km: 3, mode: "public_transport", minutes: 10 },
        { from: "伏見稲荷大社", to: "京都駅", distance_km: 3, mode: "public_transport", minutes: 10 },
      ],
      start: { name: "京都駅", lat: 34.985849, lng: 135.758766, to_first_km: 3, from_last_km: 3 },
      total_score: 1,
      center: [34.985849, 135.758766],
      spots: [{
        place_id: "fushimi",
        name: "伏見稲荷大社",
        category: "神社",
        lat: 34.9671,
        lng: 135.7727,
        stay_minutes: 90,
        score: 1,
        role: "stop",
      }],
      coordinates: [[34.9671, 135.7727]],
    };
    const preview: RouteSuggestion = {
      places: [{
        id: "fushimi",
        name: "伏見稲荷大社",
        category: "神社",
        description: "",
        access_point: "",
        latitude: 34.9671,
        longitude: 135.7727,
        themes: ["temple"],
      }],
      origin: {
        name: "京都駅",
        latitude: 34.985849,
        longitude: 135.758766,
      },
      legs: [{
        from_name: "京都",
        to_name: "稲荷",
        line_name: "JR奈良線",
        mode: "train",
        duration_minutes: 5,
      }],
      title: null,
      story: null,
      total_minutes: 35,
      departure_time: "09:00",
      arrival_time: "09:35",
      timeline: [
        {
          type: "spot",
          role: "start",
          place_id: null,
          name: "京都駅",
          category: "出発地",
          time: "09:00",
          stay_minutes: 0,
        },
        {
          type: "transit",
          from_name: "京都駅",
          to_name: "伏見稲荷大社",
          mode: "public_transport",
          transit_line: "JR奈良線",
          start_time: "09:02",
          end_time: "09:08",
          duration_minutes: 6,
          is_estimate: false,
        },
      ],
      note: "駅すぱあとAPIで検索しました。",
      coordinates: [
        [34.985849, 135.758766],
        [34.9671, 135.7727],
        [34.985849, 135.758766],
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(preview), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<RouteDetailModal route={route} onClose={() => undefined} />);
    expect(await screen.findByText("🚆 JR奈良線")).toBeTruthy();
    expect(await screen.findByText("🚆 JR奈良線")).toBeTruthy();
    expect(screen.getByText("運行時刻 09:02〜09:08")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/routes/preview",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses GPS coordinates to select a nearby station and re-searches the route", async () => {
    const route: DatasetRoute = {
      id: "kyoto-sample",
      area: "kyoto",
      pattern: "half_day",
      course: "half_day",
      theme: "temple",
      title: "京都の寺社を巡る",
      estimated_minutes: 120,
      legs: [
        { from: "京都駅", to: "伏見稲荷大社", distance_km: 3, mode: "public_transport", minutes: 10 },
        { from: "伏見稲荷大社", to: "京都駅", distance_km: 3, mode: "public_transport", minutes: 10 },
      ],
      start: { name: "京都駅", lat: 34.985849, lng: 135.758766, to_first_km: 3, from_last_km: 3 },
      total_score: 1,
      center: [34.985849, 135.758766],
      spots: [{
        place_id: "fushimi",
        name: "伏見稲荷大社",
        category: "神社",
        lat: 34.9671,
        lng: 135.7727,
        stay_minutes: 90,
        score: 1,
        role: "stop",
      }],
      coordinates: [[34.9671, 135.7727]],
    };
    const previewResponse = new Response(JSON.stringify({
        places: [{
          id: "fushimi",
          name: "伏見稲荷大社",
          category: "神社",
          description: "",
          access_point: "",
          latitude: 34.9671,
          longitude: 135.7727,
          themes: ["temple"],
        }],
        origin: { name: "最寄り駅", latitude: 35.001, longitude: 135.002 },
        legs: [],
        title: null,
        story: null,
        total_minutes: 20,
        departure_time: "09:00",
        arrival_time: "09:20",
        timeline: [],
        note: "",
        coordinates: [],
      }), { status: 200 });
    const fetchMock = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => (
      String(input).includes("/api/nearby-stations")
        ? new Response(JSON.stringify([{
              name: "最寄り駅",
              latitude: 35.001,
              longitude: 135.002,
            }]), { status: 200 })
        : previewResponse.clone()
    ));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) => success({
          coords: { latitude: 35.123, longitude: 135.456 },
          timestamp: Date.now(),
        } as GeolocationPosition),
      },
    });

    render(<RouteDetailModal route={route} onClose={() => undefined} />);
    const locationButton = await screen.findByRole("button", { name: "現在地から出発" });
    fireEvent.click(locationButton);

    await waitFor(() => {
      const previewCalls = fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/routes/preview",
      );
      expect(previewCalls).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/nearby-stations?latitude=35.123&longitude=135.456",
      expect.anything(),
    );
    const previewCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/routes/preview",
    );
    expect(JSON.parse(String(previewCalls[1][1]?.body))).toMatchObject({
      origin: {
        name: "最寄り駅",
        latitude: 35.001,
        longitude: 135.002,
      },
    });
  });
});
