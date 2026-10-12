import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouteTimeline } from "./RouteTimeline";

describe("RouteTimeline", () => {
  it("shows the specific transit line and corrected timetable", () => {
    render(
      <RouteTimeline
        items={[{
          type: "transit",
          from_name: "京都駅",
          to_name: "稲荷駅",
          mode: "public_transport",
          transit_line: "JR奈良線",
          start_time: "11:02",
          end_time: "11:21",
          duration_minutes: 19,
          is_estimate: false,
        }]}
      />,
    );

    expect(screen.getByText("🚆 JR奈良線")).toBeTruthy();
    expect(screen.getByText("運行時刻 11:02〜11:21")).toBeTruthy();
    expect(screen.queryByText("公共交通・徒歩で移動")).toBeNull();
  });

  it("shows transport modes with the stop count and total transit time", () => {
    render(
      <RouteTimeline
        items={[
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
            to_name: "清水寺",
            mode: "public_transport",
            transit_line: "公共交通",
            start_time: "09:00",
            end_time: "09:20",
            duration_minutes: 20,
            is_estimate: false,
            legs: [
              {
                from_name: "京都駅",
                to_name: "清水寺",
                line_name: "市バス",
                mode: "bus",
                duration_minutes: 15,
              },
              {
                from_name: "清水寺",
                to_name: "入口",
                line_name: "徒歩",
                mode: "walk",
                duration_minutes: 5,
              },
            ],
          },
          {
            type: "spot",
            role: "stop",
            place_id: "kiyomizu",
            name: "清水寺",
            category: "寺院",
            time: "09:20",
            stay_minutes: 60,
          },
        ]}
      />,
    );

    expect(screen.getByText("立ち寄り 1か所")).toBeTruthy();
    expect(screen.getByText("移動 合計20分")).toBeTruthy();
    expect(screen.getByText("移動手段: バス・徒歩")).toBeTruthy();
  });
});
