import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Origin } from "../types";
import type { RouteIdea } from "../SwipeCard";
import { RouteDetailModal } from "./RouteDetailModal";

vi.mock("../MapView", () => ({ MapView: ({ origin }: { origin: Origin }) => <div data-testid="map-origin">{origin.name}</div> }));
afterEach(cleanup);

const savedRoute: RouteIdea = {
  theme: "history", prefecture_code: "13", prefecture_name: "東京都", title: "東京の街を歩く", story: "休日のよりみち。",
  places: [{ id: "tokyo-spot", name: "東京の史跡", category: "史跡", latitude: 35.68, longitude: 139.76, description: "", access_point: "", themes: ["history"] }],
  dwell_minutes: { "tokyo-spot": 45 }, image_url: null, author_name: null, source_url: null, license_name: null, license_url: null,
  copywriting_source: "fallback", note: "",
};

describe("RouteDetailModal", () => {
  it("keeps a saved route's prefecture and stay times when previewing and planning", async () => {
    const onPlan = vi.fn();
    const onClose = vi.fn();
    render(<RouteDetailModal route={savedRoute} onClose={onClose} onPlanInSearch={onPlan} />);
    expect(screen.getByText(/出発の目安：東京都・エリア中心/)).toBeTruthy();
    expect(screen.getByText(/滞在の目安 45分/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("map-origin").textContent).toBe("東京都・エリア中心"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "閉じる" }));
    fireEvent.click(screen.getByRole("button", { name: "このルートで旅を計画する" }));
    expect(onPlan).toHaveBeenCalledWith(savedRoute);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
