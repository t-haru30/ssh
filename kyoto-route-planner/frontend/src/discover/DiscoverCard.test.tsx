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
  it("opens the tapped facility and does not mistake a horizontal drag for a tap", async () => {
    vi.stubGlobal("PointerEvent",MouseEvent);
    const onSwipe=vi.fn();
    render(<DiscoverCard route={route} depth={0} exitDirection="like" onSwipe={onSwipe} />);
    const image=screen.getByRole("button",{name:"清水寺の詳細を見る"});
    fireEvent.pointerDown(image,{clientX:100,clientY:100});
    fireEvent.pointerMove(image,{clientX:240,clientY:103});
    fireEvent.pointerUp(image,{clientX:240,clientY:103});
    fireEvent.click(image,{detail:1});
    expect(screen.queryByRole("dialog")).toBeNull();
    act(()=>gesture.end?.({},{offset:{x:150}}));
    expect(onSwipe).toHaveBeenCalledWith("like");
    fireEvent.pointerDown(image,{clientX:100,clientY:100});
    fireEvent.pointerUp(image,{clientX:102,clientY:100});
    image.focus();
    fireEvent.click(image,{detail:1});
    expect(await screen.findByRole("dialog",{name:"清水寺"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"ダイアログを閉じる"}));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(image);
  });
  it("leads with the plan title and photos while hiding recommendation and facility details", async () => {
    const fetchMock = vi.mocked(fetch);
    const { container } = render(<DiscoverCard route={{ ...route, recommendation_source: "gemini", recommendation_reason: "舞台から街を見渡せます。", spots: [{...route.spots[0],reason:"四季の景色を楽しめます。"}] }} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    expect(screen.getByRole("heading", {name:route.title})).toBeTruthy();
    expect(container.querySelector(".swipe-card-visual .route-photo-grid")).toBeTruthy();
    expect(container.querySelector(".swipe-spot-list")).toBeNull();
    expect(screen.queryByRole("region", {name:"この旅の楽しみ"})).toBeNull();
    expect(screen.queryByText("おすすめ理由の全文・出典")).toBeNull();
    expect(screen.queryByText("四季の景色を楽しめます。")).toBeNull();
    expect(screen.queryByRole("button", {name:/の説明を見る/})).toBeNull();
    await act(async () => {});
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/places/google-info" || url === "/api/places/description")).toBe(false);
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
      expect(screen.getByText("総所要時間 約2時間30分", { selector: ".swipe-distance" })).toBeTruthy();
    expect(screen.queryByText("寺院",{selector:".swipe-spot-copy small"})).toBeNull();
    expect(screen.getByText("いいね")).toBeTruthy();
    expect(screen.getByText("今回は見送る")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "この旅の楽しみ" })).toBeNull();
  });



  it("keeps all destination photos while cards behind the top card remain inert", () => {
    const longerRoute = { ...route, spots: Array.from({ length: 5 }, (_, i) => ({ ...route.spots[0], place_id: `spot-${i}`, name: `行き先${i}` })) };
    const view = render(<DiscoverCard route={longerRoute} depth={0} exitDirection="like" onSwipe={vi.fn()} />);
    expect(view.container.querySelectorAll(".route-photo-tile")).toHaveLength(4);
    expect(screen.getByRole("button",{name:"行き先1の詳細を見る"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"次の写真ページ"}));
    expect(screen.getByRole("button",{name:"行き先4の詳細を見る"})).toBeTruthy();
    expect(screen.queryByRole("button", {name:/の説明を見る/})).toBeNull();
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
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/routes/photo")).toHaveLength(1));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/google-info")).toHaveLength(0);
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
    expect(screen.getAllByRole("link", { name: "Photographer" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "CC BY-SA 4.0" }).length).toBeGreaterThan(0);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.queryByRole("img", {name:"庭園"})).toBeNull();
    expect(screen.queryByText(/AI.*イラスト/)).toBeNull();
  });
});
