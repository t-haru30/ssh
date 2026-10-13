import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRoutePhotoCache } from "./useRoutePhoto";
import { DiscoverCard } from "./DiscoverCard";
import type { DatasetRoute } from "./datasetTypes";

vi.mock("framer-motion", () => ({
  motion: {
    article: ({ children, className, inert }: { children: ReactNode; className?: string; inert?: boolean }) => (
      <article className={className} inert={inert}>{children}</article>
    ),
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  useMotionValue: () => 0,
  useTransform: () => 0,
}));

beforeEach(() => { clearRoutePhotoCache(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }) })); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const route: DatasetRoute = {
  id: "kyoto-route",
  area: "京都",
  pattern: "half_day",
  course: "half_day",
  theme: "temple",
  title: "寺院と庭園を巡る",
  estimated_minutes: 150,
  legs: [],
  start: { name: "京都駅", lat: 34.985849, lng: 135.758766, to_first_km: 1, from_last_km: 1 },
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
  it("displays the actual AI recommendation and keeps rule candidates unlabeled", () => {
    const view = render(<DiscoverCard route={{ ...route, recommendation_source: "gemini", recommendation_reason: "寺社めぐりの気分に合う、近くの寺院を選びました。" }} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    expect(screen.getByText(/AIが選んだおすすめ/)).toBeTruthy();
    expect(screen.getByText("寺社めぐりの気分に合う、近くの寺院を選びました。")).toBeTruthy();
    view.rerender(<DiscoverCard route={route} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    expect(screen.queryByText(/AIが選んだおすすめ/)).toBeNull();
  });
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
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText("AIテーマイラスト")).toBeNull();
    expect(screen.queryByText("清水寺の写真")).toBeNull();
    expect(screen.getByText("半日コース")).toBeTruthy();
    expect(screen.getByText("⏱ 総所要時間 約2時間30分", { selector: ".swipe-distance" })).toBeTruthy();
    expect(screen.getByText("清水寺", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("寺院")).toBeTruthy();
    expect(screen.getByText("しおりを開く", { selector: ".swipe-stamp.accept" })).toBeTruthy();
  });

  it("opens a destination without saving or swiping the route, and restores focus on Escape", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => ({ ok: true, json: async () => url === "/api/routes/photo"
      ? { status: "unavailable", key: "a".repeat(64), image_url: null, note: "fixture" }
      : { description: null } }));
    vi.stubGlobal("fetch", fetchMock);
    const onSwipe = vi.fn();
    render(<DiscoverCard route={route} depth={0} exitDirection="like" onSwipe={onSwipe} />);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/description")).toHaveLength(0);
    const button = screen.getByRole("button", { name: "清水寺の説明を見る" });
    button.focus(); fireEvent.click(button);
    expect(screen.getByRole("dialog", { name: "清水寺" })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/description")).toHaveLength(1));
    const descriptionCall = fetchMock.mock.calls.find(([url]) => url === "/api/places/description")!;
    expect(JSON.parse((descriptionCall[1] as RequestInit).body as string)).toMatchObject({ id: "kiyomizu", name: "清水寺" });
    expect(onSwipe).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("makes every destination available while keeping cards behind the top card inert", () => {
    const longerRoute = { ...route, spots: Array.from({ length: 5 }, (_, i) => ({ ...route.spots[0], place_id: `spot-${i}`, name: `行き先${i}` })) };
    const view = render(<DiscoverCard route={longerRoute} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /の説明を見る/ })).toHaveLength(5);
    view.rerender(<DiscoverCard route={longerRoute} depth={1} exitDirection="like" onSwipe={vi.fn()} />);
    expect(view.container.querySelector("article")?.hasAttribute("inert")).toBe(true);
  });

  it("prepares the next two cards while keeping inactive and further cards idle", async () => {
    const fetchMock = vi.mocked(fetch);
    const view = render(<DiscoverCard route={route} depth={3} active exitDirection="like" onSwipe={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<DiscoverCard route={route} depth={0} active={false} exitDirection="like" onSwipe={vi.fn()} />);
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender(<DiscoverCard route={route} depth={2} active exitDirection="like" onSwipe={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/routes/photo");
  });

  it("labels a verified second destination photo with its actual subject and attribution", async () => {
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null; onerror: (() => void) | null = null;
      complete = false; naturalWidth = 0; decoding = "";
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
      decode() { return Promise.resolve(); } removeAttribute() {}
    });
    const image = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Test.jpg";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "ready", place_id: "second", place_name: "庭園", image_url: image, author_name: "Photographer", source_url: "https://commons.wikimedia.org/wiki/File:Test.jpg", license_name: "CC BY-SA 4.0", license_url: "https://creativecommons.org/licenses/by-sa/4.0/", image_verified: true, ai_checked: true, note: "" }) }));
    const { container } = render(<DiscoverCard route={{ ...route, spots: [...route.spots, { ...route.spots[0], place_id: "second", name: "庭園" }] }} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(image));
    expect(container.querySelector("img")?.classList.contains("loaded")).toBe(true);
    expect(screen.getByTestId("cover-spot-name").textContent).toBe("庭園");
    expect(screen.getByText("庭園の写真")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Photographer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "CC BY-SA 4.0" })).toBeTruthy();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/AI.*イラスト/)).toBeNull();
  });
});
