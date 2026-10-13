import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place } from "./types";
import { JourneyReview } from "./JourneyReview";
const place: Place = { id: "museum", name: "試験美術館", latitude: 35, longitude: 135, category: "美術館", description: "", access_point: "", themes: [] };
const second = { ...place, id: "garden", name: "試験庭園" };
const official = { url: "https://museum.example.jp/", status: "verified", opening_hours: "9時〜17時", closed_days: "月曜", admission: "500円" };
const evidence = { place_id: place.id, status: "ready", message: "", text: "公式ページの営業時間をご確認ください。", sources: [{ number: 1, title: "公式案内", url: official.url }], citations: [{ end: 20, sources: [1] }], search_suggestions_html: '<div><a href="https://www.google.com/search?q=museum">Google検索</a></div>', checked_at: "2026-10-12T00:00:00Z" };
evidence.citations[0].end = evidence.text.length;
const result = { place_id: place.id, place_name: place.name, official, evidence: null, steps: [{ label: "公式ページを確認", status: "ready" }], missing_fields: [] };
const payload = (results: unknown[] = [result], remaining = 0) => ({ checked_at: "2026-10-12T00:00:00Z", departure_date: "2026-10-15", results, remaining_count: remaining, ai_searches: 0, elapsed_ms: 1, note: "" });
const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
const click = () => fireEvent.click(screen.getByRole("button", { name: "出発前の情報をまとめて調べる" }));
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("JourneyReview", () => {
  const notice = { text: "展示替えのため全館臨時休館", url: "https://museum.example.jp/news/closure", starts_on: "2026-10-20", ends_on: "2026-10-22" };
  it.each(["verified", "link_only"])("shows sourced closure separately from normal information for %s", async status => {
    const notices = [notice, { ...notice, text: "表示しない二件目" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload([{ ...result, official: { ...official, closed_days: "年中無休", status, notices } }]))));
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    await screen.findByRole("link", { name: /公式案内を開く/ });
    expect(screen.getByText("臨時休館のお知らせ")).toBeTruthy();
    expect(screen.getByText("2026-10-20〜2026-10-22")).toBeTruthy();
    expect(screen.getByText(notice.text)).toBeTruthy();
    const link = screen.getByRole("link", { name: "臨時休館の公式出典" });
    expect(link.getAttribute("href")).toBe(notice.url);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByText("表示しない二件目")).toBeNull();
    expect(screen.queryByText("年中無休") !== null).toBe(status === "verified");
  });
  it.each([
    { url: "javascript:alert(1)" }, { url: "https://127.0.0.1/" }, { url: "https://office.internal/" },
    { url: "https://user:secret@museum.example.jp/" }, { starts_on: "2026-2-01" },
    { starts_on: "2026-02-30" }, { ends_on: "2026-10-19" }, { text: "  " },
  ])("omits malformed closure notice %j", async invalid => {
    const status = "verified", notices = [{ ...notice, ...invalid }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload([{ ...result, official: { ...official, closed_days: "年中無休", status, notices } }]))));
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    await screen.findByRole("link", { name: /公式案内を開く/ });
    expect(screen.queryByText("臨時休館のお知らせ")).toBeNull();
    expect(screen.queryByRole("link", { name: "臨時休館の公式出典" })).toBeNull();
    expect(screen.getByText("年中無休")).toBeTruthy();
  });
  it("keeps older responses without notices unchanged", async () => {
    const status = "verified", notices = undefined;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload([{ ...result, official: { ...official, closed_days: "年中無休", status, notices } }]))));
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    await screen.findByRole("link", { name: /公式案内を開く/ });
    expect(screen.queryByText("臨時休館のお知らせ")).toBeNull();
    expect(screen.getByText("年中無休")).toBeTruthy();
  });

  it("links each known field to its own official source and rejects unsafe or unknown-field sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload([{ ...result, official: { ...official, admission: null,
      field_sources: { opening_hours: "https://museum.example.jp/guide", closed_days: "javascript:alert(1)", admission: "https://museum.example.jp/fees" } } }]))));
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    expect((await screen.findByRole("link", { name: "試験美術館の開館・営業時間の出典" })).getAttribute("href")).toBe("https://museum.example.jp/guide");
    expect(screen.queryByRole("link", { name: "試験美術館の休館・定休日の出典" })).toBeNull();
    expect(screen.queryByRole("link", { name: "試験美術館の入館・利用料金の出典" })).toBeNull();
  });
  it("only requests on click, posts the current itinerary and never persists evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(payload())); vi.stubGlobal("fetch", fetchMock);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />);
    expect(fetchMock).not.toHaveBeenCalled(); click();
    expect(await screen.findByText("9時〜17時")).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/journey/review");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ places: [place], departure_date: "2026-10-15" });
    expect(screen.getByRole("link", { name: /試験美術館の公式案内を開く/ }).getAttribute("href")).toBe(official.url);
    expect(screen.getByText(/当日の営業は自動確認していません/)).toBeTruthy();
    expect(screen.getByText("確認できました")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "出発前の情報をまとめて調べる" })).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    expect(screen.getByText(/2026\/10\/12 09:00 JST取得/)).toBeTruthy();
  });
  it("keeps partial results and cited AI evidence without turning unknown fields into facts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(payload([{ ...result, official: { ...official, admission: null }, evidence, missing_fields: ["admission"] }, { ...result, place_id: second.id, place_name: second.name, official: null, missing_fields: ["opening_hours", "closed_days", "admission"], steps: [{ label: "公式情報を検索", status: "unavailable" }] }], 2))));
    const { container } = render(<JourneyReview places={[place, second, { ...place, id: "third" }, { ...place, id: "fourth" }]} departureDate="2026-10-15" />); click();
    expect(await screen.findByText(/残り2か所/)).toBeTruthy();
    const first = container.querySelector(".journey-review-results > li")!;
    expect(within(first as HTMLElement).getByText("未確認")).toBeTruthy();
    expect(screen.getByRole("link", { name: "出典1：公式案内" })).toBeTruthy();
    await waitFor(() => expect(container.querySelector(".venue-search-suggestions")?.shadowRoot?.textContent).toBe("Google検索"));
    expect(screen.getByText("取得できませんでした")).toBeTruthy();
  });
  it.each(["date", "order", "place"])("cancels obsolete work and discards its late result after changing %s", async kind => {
    const pending = deferred(); const fetchMock = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", fetchMock);
    const view = render(<JourneyReview places={[place, second]} departureDate="2026-10-15" />); click();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<JourneyReview places={kind === "order" ? [second, place] : kind === "place" ? [{ ...place, name: "別の施設" }, second] : [place, second]} departureDate={kind === "date" ? "2026-10-16" : "2026-10-15"} />);
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response(payload([result], 1))); });
    expect(screen.queryByText("9時〜17時")).toBeNull();
    expect(screen.getByRole("button", { name: "出発前の情報をまとめて調べる" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("cancels immediately even when the transport never rejects on abort", async () => {
    const pending = deferred(); const fetchMock = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal("fetch", fetchMock);
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    expect(screen.getByRole("button", { name: "行き先の情報を確認しています…" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "確認を中止" }));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(screen.getByText(/確認を中止しました/)).toBeTruthy();
    await act(async () => { pending.resolve(response(payload())); });
    expect(screen.queryByText("9時〜17時")).toBeNull();
  });
  it("times out at 50 seconds and permits a later explicit retry", async () => {
    vi.useFakeTimers(); const fetchMock = vi.fn().mockReturnValue(new Promise(() => {})); vi.stubGlobal("fetch", fetchMock);
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(screen.getByText(/確認に時間がかかっています/)).toBeTruthy(); click();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("shows Japanese busy and invalid-JSON messages without parsing an error response", async () => {
    const busyJson = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 429, json: busyJson })
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    vi.stubGlobal("fetch", fetchMock);
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    expect(await screen.findByText(/ただいま確認が混み合っています/)).toBeTruthy();
    expect(busyJson).not.toHaveBeenCalled(); click();
    expect(await screen.findByText("確認結果を読み取れませんでした。もう一度お試しください。")).toBeTruthy();
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });
  it("keeps the detailed scope inside a collapsed disclosure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...payload(), note: "先頭3施設まで確認します。" })));
    const { container } = render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    const summary = await screen.findByText("確認の範囲");
    const disclosure = summary.closest("details")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.textContent).toContain("先頭3施設まで確認します。");
    expect(container.querySelectorAll(".journey-review-summary")).toHaveLength(1);
  });
  it("rejects another date's result and hides invalid evidence while preserving official facts", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ ...payload(), departure_date: "2026-10-16" })).mockResolvedValueOnce(response(payload([{ ...result, evidence: { ...evidence, place_id: "wrong-place" } }]))); vi.stubGlobal("fetch", fetchMock);
    render(<JourneyReview places={[place]} departureDate="2026-10-15" />); click();
    expect(await screen.findByText(/確認結果の形式を読み取れませんでした/)).toBeTruthy(); click();
    expect(await screen.findByText("9時〜17時")).toBeTruthy();
    expect(screen.getByText(/追加情報の出典を確認できませんでした/)).toBeTruthy();
    expect(screen.queryByText("公式情報のAI要約")).toBeNull();
  });
});
