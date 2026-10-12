import { describe, expect, it } from "vitest";
import { buildRouteTimeline } from "./RouteTimeline";
import type { Place } from "./types";

const place = (id: string): Place => ({
  id,
  name: id,
  category: "観光名所",
  description: "",
  access_point: "",
  latitude: 35,
  longitude: 135,
  themes: ["all"],
});

describe("buildRouteTimeline with a plan", () => {
  it("adds the first leg and uses per-leg modes and stay minutes", () => {
    const items = buildRouteTimeline(
      { name: "駅", latitude: 35, longitude: 135 },
      [place("a"), place("b")],
      "09:00",
      null,
      {
        legs: [
          { mode: "car", minutes: 30 },
          { mode: "walk", minutes: 10 },
          { mode: "car", minutes: 20 },
        ],
        stayMinutes: [45, 60],
        lunchIndexes: [1],
      },
    );
    const transits = items.filter((item) => item.type === "transit");
    expect(transits.map((item) => item.mode)).toEqual(["car", "walk", "car"]);
    expect(transits[0]).toMatchObject({ start_time: "09:00", end_time: "09:30", summary: "車で約30分" });
    const spots = items.filter((item) => item.type === "spot");
    expect(spots[1]).toMatchObject({ name: "a", time: "09:30", stay_minutes: 45 });
    expect(spots[2]).toMatchObject({ name: "b", time: "10:25", label: "昼食" });
    expect(spots[3]).toMatchObject({ role: "finish", time: "11:45" });
  });

  it("keeps the distance-based fallback without a plan", () => {
    const items = buildRouteTimeline({ name: "駅", latitude: 35, longitude: 135 }, [place("a")], "09:00", 100);
    expect(items.filter((item) => item.type === "transit")).toHaveLength(2);
  });

  it("shows lunch reasons, arrival and departure times, and late-day warnings", () => {
    const items = buildRouteTimeline(
      { name: "駅", latitude: 35, longitude: 135 },
      [place("lunch")],
      "09:00",
      null,
      {
        legs: [
          { mode: "car", minutes: 300 },
          { mode: "car", minutes: 300 },
        ],
        stayMinutes: [60],
        lunchIndexes: [0],
        spotDetails: ["次の予定地から徒歩目安約5分です。"],
        returnByMinutes: 19 * 60,
      },
    );
    const spots = items.filter((item) => item.type === "spot");
    expect(spots[1]).toMatchObject({
      label: "昼食",
      time: "14:00",
      departure_time: "15:00",
      detail: "次の予定地から徒歩目安約5分です。 昼食開始が13:30を過ぎる予定です。",
    });
    expect(spots[2]).toMatchObject({
      role: "finish",
      time: "20:00",
      detail: "帰着が20:00頃となり、19:00を過ぎる見込みです。",
    });
  });
});
