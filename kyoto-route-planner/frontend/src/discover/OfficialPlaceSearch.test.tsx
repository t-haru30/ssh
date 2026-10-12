import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../types";
import { OfficialPlaceSearch } from "./OfficialPlaceSearch";
import { PlaceDescriptionToggle, PlaceDetailsDialog, PlaceIntroduction } from "./PlaceDetails";

const place: Place = { id: "museum", name: "試験美術館", category: "美術館", description: "旅の説明", access_point: "",
  themes: ["history"], latitude: 35, longitude: 135, address: "京都市" };
const identity = "施設確認：試験美術館（京都市）。\n\n";
const text = `${identity}開館時間は9時から17時。\n休館日は月曜日。料金は500円です。`;
const ready = { place_id: place.id, status: "ready", message: "", text,
  sources: [{ number: 1, title: "試験美術館の公式案内", url: "https://museum.example.jp/guide" }],
  citations: [{ end: identity.length, sources: [1] }, { end: text.length, sources: [1] }],
  search_suggestions_html: '<div><a href="https://www.google.com/search?q=museum">Google検索</a></div>', checked_at: "2026-10-12T00:00:00Z" };
const official = { url: "https://museum.example.jp/", status: "verified", description: null, opening_hours: "9時〜17時", closed_days: "月曜日", admission: "500円", checked_at: null };
function response(data: unknown, ok = true) { return { ok, json: async () => data } as Response; }
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OfficialPlaceSearch", () => {
  it("automatically searches once in StrictMode, preserves all cited text and reuses Google's suggestions without persisting the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(ready)); vi.stubGlobal("fetch", fetchMock);
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<StrictMode><OfficialPlaceSearch place={place} /></StrictMode>);
    expect(screen.getByText("Google検索で公式サイト・開館時間を確認しています…")).toBeTruthy();
    await screen.findByText("公式情報のAI要約");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/places/official-evidence"); expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" }); expect(JSON.parse(init.body)).toEqual(place);
    expect([...view.container.querySelectorAll(".venue-evidence-text")].map(node => node.textContent).join("").replaceAll("[1]", "")).toBe(text);
    const match = view.container.querySelector("details")!;
    expect(match.textContent).toContain("施設確認：試験美術館");
    expect(match.textContent).not.toContain("開館時間は");
    expect(screen.getByRole("link", { name: /\[1\] 試験美術館の公式案内/ }).getAttribute("href")).toBe(ready.sources[0].url);
    expect(view.container.querySelector(".venue-search-suggestions")?.shadowRoot?.textContent).toBe("Google検索");
    expect(screen.getByText(/訪問前に出典の公式案内をご確認/)).toBeTruthy();
    expect(persist).not.toHaveBeenCalled();
    view.rerender(<StrictMode><OfficialPlaceSearch place={{ ...place }} /></StrictMode>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows unconfigured and unverified messages with a manual search link and retries only after a click", async () => {
    for (const status of ["unconfigured", "unverified"]) {
      const fetchMock = vi.fn().mockResolvedValue(response({ ...ready, status, message: "確認できる公式情報がありません。", text: "", sources: [], citations: [], search_suggestions_html: "", checked_at: null }));
      vi.stubGlobal("fetch", fetchMock); render(<OfficialPlaceSearch place={place} />);
      await screen.findByText("確認できる公式情報がありません。");
      expect(screen.getByRole("link", { name: /施設名で公式案内を探す/ }).getAttribute("href")).toContain("www.google.com/search");
      expect(screen.queryByText("公式情報のAI要約")).toBeNull(); expect(fetchMock).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: /公式案内をもう一度検索する/ }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)); cleanup();
    }
  });

  it("shows HTTP and identity-validation failures without fabricating official information or retrying automatically", async () => {
    for (const result of [response({ detail: "検索の上限に達しました。" }, false), response({ ...ready, place_id: "another-museum" })]) {
      const fetchMock = vi.fn().mockResolvedValue(result); vi.stubGlobal("fetch", fetchMock);
      render(<OfficialPlaceSearch place={place} />);
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.queryByText("公式情報のAI要約")).toBeNull();
      expect(screen.getByRole("link", { name: /施設名で公式案内を探す/ })).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledOnce(); cleanup();
    }
  });

  it("aborts after 55 seconds and ignores a late response without another automatic search", async () => {
    vi.useFakeTimers(); const request = deferred(); const fetchMock = vi.fn().mockReturnValue(request.promise); vi.stubGlobal("fetch", fetchMock);
    render(<OfficialPlaceSearch place={place} />); await act(async () => {});
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await act(async () => { await vi.advanceTimersByTimeAsync(55_000); });
    expect(signal.aborted).toBe(true); expect(screen.getByRole("alert").textContent).toContain("タイムアウト");
    await act(async () => { request.resolve(response(ready)); await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.queryByText("公式情報のAI要約")).toBeNull(); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts on a changed facility or close and ignores the old facility's response", async () => {
    const old = deferred(), current = deferred();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); vi.stubGlobal("fetch", fetchMock);
    const view = render(<OfficialPlaceSearch place={place} />); await act(async () => {});
    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<OfficialPlaceSearch place={{ ...place, id: "new-museum", name: "別の美術館" }} />); await act(async () => {});
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { old.resolve(response(ready)); }); expect(screen.queryByText("公式情報のAI要約")).toBeNull();
    const currentSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    view.unmount(); expect(currentSignal.aborted).toBe(true);
    await act(async () => { current.resolve(response({ ...ready, place_id: "new-museum" })); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("opened destination integration", () => {
  it("waits for the free description to finish and searches only missing official details", async () => {
    const free = deferred();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/places/description" ? free.promise : Promise.resolve(response(ready)));
    vi.stubGlobal("fetch", fetchMock); render(<PlaceDetailsDialog place={place} onClose={vi.fn()} />);
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0][0]).toBe("/api/places/description");
    await act(async () => { free.resolve(response({ description: null, official: null })); });
    await screen.findByText("公式情報のAI要約");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/places/description", "/api/places/official-evidence"]);
    expect(screen.queryByText("未確認")).toBeNull(); expect(screen.queryByText(/公式サイトを確認できませんでした/)).toBeNull();
  });

  it("keeps complete official fields without a paid search, and supplements missing fields without replacing the existing link", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(response(url === "/api/places/description" ? { official } : ready)));
    vi.stubGlobal("fetch", fetchMock); const view = render(<PlaceIntroduction place={place} />);
    await screen.findByText(official.opening_hours); expect(fetchMock).toHaveBeenCalledOnce();
    view.unmount();
    fetchMock.mockImplementation(url => Promise.resolve(response(url === "/api/places/description" ? { official: { ...official, admission: null } } : ready)));
    render(<PlaceIntroduction place={place} />); await screen.findByText("公式情報のAI要約");
    expect(screen.getByText(official.opening_hours)).toBeTruthy(); expect(screen.getByText(official.closed_days)).toBeTruthy();
    expect(screen.getByRole("link", { name: /公式サイトで最新の案内を見る/ }).getAttribute("href")).toBe(official.url);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/official-evidence")).toHaveLength(1);
  });

  it("makes no requests for collapsed details and aborts the paid search when the person closes them", async () => {
    const paid = deferred();
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => url === "/api/places/description" ? Promise.resolve(response({ official: null })) : paid.promise);
    vi.stubGlobal("fetch", fetchMock); render(<PlaceDescriptionToggle place={place} />);
    expect(fetchMock).not.toHaveBeenCalled();
    const details = screen.getByText(`${place.name}の説明を見る`).closest("details")!;
    act(() => { details.open = true; fireEvent(details, new Event("toggle")); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1][1]?.signal as AbortSignal;
    act(() => { details.open = false; fireEvent(details, new Event("toggle")); });
    expect(signal.aborted).toBe(true);
    await act(async () => { paid.resolve(response(ready)); });
    expect(screen.queryByText("公式情報のAI要約")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start a new facility's search before its own free response completes", async () => {
    const nextFree = deferred();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const selected = JSON.parse(String(init?.body));
      if (url === "/api/places/description") return selected.id === place.id ? Promise.resolve(response({ official: null })) : nextFree.promise;
      return Promise.resolve(response(ready));
    });
    vi.stubGlobal("fetch", fetchMock); const view = render(<PlaceIntroduction place={place} />);
    await screen.findByText("公式情報のAI要約");
    view.rerender(<PlaceIntroduction place={{ ...place, id: "new-museum", name: "別の美術館" }} />);
    expect(screen.queryByText("公式情報のAI要約")).toBeNull();
    await act(async () => {});
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/official-evidence")).toHaveLength(1);
    await act(async () => { nextFree.resolve(response({ official })); });
    const guide = screen.getByRole("region", { name: "訪問前の確認" });
    expect(within(guide).getByText(official.opening_hours)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/places/official-evidence")).toHaveLength(1);
  });
});
