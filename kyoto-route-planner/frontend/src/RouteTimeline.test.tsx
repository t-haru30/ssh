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
});
