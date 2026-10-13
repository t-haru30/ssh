import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRoutePhotoCache } from "./useRoutePhoto";
import { DiscoverCard } from "./DiscoverCard";
import type { DatasetRoute } from "./datasetTypes";

const gesture = vi.hoisted(() => ({ end: null as null | ((event: unknown, info: { offset: { x: number } }) => void) }));

vi.mock("framer-motion", () => ({
  motion: {
    article: ({ children, className, inert, onDragEnd }: { children: ReactNode; className?: string; inert?: boolean; onDragEnd: typeof gesture.end }) => {
      if (!inert) gesture.end = onDragEnd;
      return <article className={className} inert={inert}>{children}</article>;
    },
    div: ({ children, className }: { children: ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
  },
  usePresence: () => [true, undefined],
  usePresenceData: () => undefined,
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
  it("shows one concrete sentence and preserves the full explanation and its sources on demand", () => {
    const source = { title: "清水寺の公式紹介", url: "https://www.kiyomizudera.or.jp/about/" };
    const otherSource = { title: "庭園の公式紹介", url: "https://example.com/garden" };
    const first = "清水寺：舞台から京都の街並みを見渡せます。";
    const full = `${first} 庭園：季節の花を楽しめます。ゆっくりペースで2か所、各60分滞在（目安）。`;
    const onSwipe = vi.fn();
    const { container } = render(<DiscoverCard route={{ ...route, recommendation_reason: full, reason_sources: [source, otherSource], spots: [{ ...route.spots[0], reason: first, reason_sources: [source] }] }} depth={0} exitDirection="like" onSwipe={onSwipe} />);
    expect(screen.getByRole("region", { name: "おすすめ理由" }).textContent).toBe(`おすすめ理由${first}`);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(screen.getByText("おすすめ理由の全文・出典"));
    expect(details.textContent).toContain(full);
    expect(details.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector(".recommendation-sources")?.textContent).not.toContain(otherSource.title);
    expect(onSwipe).not.toHaveBeenCalled();
  });
  it.each([[-150, "pass"], [150, "like"]] as const)("supports a %s swipe and locks while waiting for the next card", (offset, direction) => {
    const onSwipe = vi.fn();
    const view = render(<DiscoverCard route={route} depth={0} exitDirection="pass" onSwipe={onSwipe} />);
    act(() => gesture.end?.({}, { offset: { x: offset } }));
    expect(onSwipe).toHaveBeenCalledWith(direction);
    act(() => gesture.end?.({}, { offset: { x: offset } }));
    expect(onSwipe).toHaveBeenCalledTimes(1);
    view.rerender(<DiscoverCard route={route} depth={0} exitDirection="pass" onSwipe={onSwipe} preparingNext />);
    act(() => gesture.end?.({}, { offset: { x: offset } }));
    expect(onSwipe).toHaveBeenCalledTimes(1);
    view.rerender(<DiscoverCard route={route} depth={0} exitDirection="pass" onSwipe={onSwipe} />);
    act(() => gesture.end?.({}, { offset: { x: offset } }));
    expect(onSwipe).toHaveBeenCalledTimes(2);
  });
  it("does not swipe an inactive card", () => {
    const onSwipe = vi.fn();
    render(<DiscoverCard route={route} depth={0} exitDirection="pass" onSwipe={onSwipe} active={false} />);
    act(() => gesture.end?.({}, { offset: { x: 150 } }));
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("connects official sources to the card and to a rule-selected destination without duplicate reasons", () => {
    const source = { title: "清水寺の公式紹介", url: "https://www.kiyomizudera.or.jp/about/" };
    const reason = "舞台から京都の街並みを見渡せます。";
    const onSwipe = vi.fn();
    render(<DiscoverCard route={{ ...route, recommendation_source: "rules", recommendation_reason: reason, reason_sources: [source], spots: [{ ...route.spots[0], reason, reason_sources: [source] }] }} depth={0} exitDirection="like" onSwipe={onSwipe} />);
    fireEvent.pointerDown(screen.getByRole("link", { name: source.title }));
    expect(screen.getByRole("link", { name: source.title }).getAttribute("href")).toBe(source.url);
    fireEvent.click(screen.getByRole("button", { name: "清水寺の説明を見る" }));
    expect(screen.getAllByRole("link", { name: source.title })).toHaveLength(2);
    expect(screen.getAllByText(reason)).toHaveLength(2);
    expect(screen.queryByText("旅のポイント")).toBeNull();
    expect(onSwipe).not.toHaveBeenCalled();
  });
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
    expect(screen.getAllByText("清水寺", { selector: "strong" })[0]).toBeTruthy();
    expect(screen.getByText("寺院")).toBeTruthy();
    expect(screen.getByText("いいね")).toBeTruthy();
    expect(screen.getByText("今回は見送る")).toBeTruthy();
    expect(screen.getByRole("region", { name: "おすすめ理由" })).toBeTruthy();
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
    expect(screen.getByRole("img", { name: "庭園" })).toBeTruthy();
    expect(container.querySelectorAll(".route-photo-tile")).toHaveLength(2);
    expect(screen.getByRole("figure", { name: "庭園の写真" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Photographer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "CC BY-SA 4.0" })).toBeTruthy();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByText(/AI.*イラスト/)).toBeNull();
  });
});
