import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoverCard } from "./DiscoverCard";
import type { DatasetRoute } from "./datasetTypes";

vi.mock("framer-motion", () => ({
  motion: {
    article: ({ children, className }: { children: ReactNode; className?: string }) => (
      <article className={className}>{children}</article>
    ),
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  useMotionValue: () => 0,
  useTransform: () => 0,
}));

afterEach(cleanup);

const route: DatasetRoute = {
  id: "kyoto-route",
  area: "京都",
  pattern: "half_day",
  theme: "temple",
  title: "寺院と庭園を巡る",
  estimated_minutes: 150,
  total_score: 10,
  center: [135.76, 35.0],
  spots: [{
    place_id: "kiyomizu",
    name: "清水寺",
    category: "寺院",
    lat: 35,
    lng: 135.76,
    stay_minutes: 60,
    score: 5,
    role: "stop",
  }],
  coordinates: [],
};

describe("DiscoverCard", () => {
  it("renders Discover data through the shared card layout", () => {
    const { container } = render(
      <DiscoverCard
        route={route}
        depth={0}
        exitDirection="like"
        onSwipe={vi.fn()}
      />,
    );

    expect(container.querySelector(".swipe-card")).toBeTruthy();
    expect(container.querySelector(".swipe-cover.theme-temple")).toBeTruthy();
    expect(container.querySelector(".swipe-cover-placeholder")).toBeTruthy();
    expect(screen.getByText("半日コース")).toBeTruthy();
    expect(screen.getByText("⏱ 総所要時間 約2時間30分", { selector: ".swipe-distance" })).toBeTruthy();
    expect(screen.getByText("清水寺", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("寺院")).toBeTruthy();
  });
});
