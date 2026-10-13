import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { PlaceDescriptionToggle, PlaceDetailsDialog, PlaceIntroduction } from "./PlaceDetails";
import type { Place } from "../types";
// Photo requests are covered separately; these tests isolate description requests.
vi.mock("../FacilityPhoto", () => ({ FacilityPhoto: () => <div data-testid="facility-photo" /> }));

it("shows a photo in the facility dialog without duplicating it in inline descriptions", () => {
  const sample: Place = { id: "photo-layout", name: "資料館", category: "博物館", latitude:35, longitude:135, themes:[], description:"", access_point:"" };
  const view = render(<PlaceDetailsDialog place={sample} onClose={() => {}} enableOfficialSearch={false} />);
  expect(screen.getAllByTestId("facility-photo")).toHaveLength(1);
  view.rerender(<PlaceIntroduction place={sample} enableOfficialSearch={false} />);
  expect(screen.queryByTestId("facility-photo")).toBeNull();
});

const place: Place = { id: "garden", name: "散策庭園", category: "庭園", latitude: 35, longitude: 135,
  themes: ["nature"], description: "静かな庭園を歩くルートです。", access_point: "", address: "京都市" };
const article = { description: "公開記事に基づく庭園の説明です。", source_url: "https://ja.wikipedia.org/wiki/庭園",
  source_title: "庭園", license_url: "https://creativecommons.org/licenses/by-sa/4.0/", license_name: "CC BY-SA 4.0", note: null };
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
const official = { url: "https://garden.example.jp/", description: "公式紹介に基づく庭園の特色です。", description_source_url: "https://garden.example.jp/about",
  highlights: ["公式に紹介された季節の花"], opening_hours: "9:00〜17:00", closed_days: "毎週月曜日", admission: "大人500円", checked_at: "2026-10-12T10:00:00Z", status: "verified", note: null };
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function toggle(details: HTMLDetailsElement, open: boolean) {
  act(() => { details.open = open; fireEvent(details, new Event("toggle")); });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("destination introductions", () => {
  it("shows a route recommendation once with its official source while keeping distinct legacy notes", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const reason = "池を中心に巡る庭園で、水面に映る景色を楽しめます。";
    const source = { title: "庭園の公式紹介", url: "https://garden.example.jp/about" };
    const view = render(<PlaceIntroduction enableOfficialSearch={false} place={{ ...place, description: reason }} recommendations={[reason]} reasonSources={[source]} />);
    expect(screen.getAllByText(reason)).toHaveLength(1);
    expect(screen.queryByText("旅のポイント")).toBeNull();
    expect(screen.getByRole("link", { name: source.title }).getAttribute("href")).toBe(source.url);
    view.rerender(<PlaceIntroduction enableOfficialSearch={false} place={place} recommendations={[reason]} />);
    expect(screen.getByText(place.description)).toBeTruthy();
    expect(screen.getByText("旅のポイント")).toBeTruthy();
  });
  const notice = { text: "展示替えのため全館臨時休館", url: "https://museum.example.jp/news/closure", starts_on: "2026-10-20", ends_on: "2026-10-22" };
  it.each(["verified", "link_only"])("shows sourced closure separately from normal information for %s", async status => {
    const notices = [notice, { ...notice, text: "表示しない二件目" }];
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, closed_days: "年中無休", status, notices } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
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
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, closed_days: "年中無休", status, notices } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
    expect(screen.queryByText("臨時休館のお知らせ")).toBeNull();
    expect(screen.queryByRole("link", { name: "臨時休館の公式出典" })).toBeNull();
    expect(screen.getByText("年中無休")).toBeTruthy();
  });
  it("keeps older responses without notices unchanged", async () => {
    const status = "verified", notices = undefined;
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, closed_days: "年中無休", status, notices } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
    expect(screen.queryByText("臨時休館のお知らせ")).toBeNull();
    expect(screen.getByText("年中無休")).toBeTruthy();
  });

  it("links each confirmed field to its directly read official source", async () => {
    const field_sources = { opening_hours: "https://garden.example.jp/hours", closed_days: "https://garden.example.jp/calendar", admission: "https://garden.example.jp/fees" };
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, field_sources } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
    for (const [key, label] of [["opening_hours", "開館・営業時間"], ["closed_days", "休館・定休日"], ["admission", "入館・利用料金"]] as const) {
      const link = screen.getByRole("link", { name: `${label}の出典` });
      expect(link.getAttribute("href")).toBe(field_sources[key]);
      expect(link.closest("dd")?.textContent).toContain(official[key]);
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
  it.each(["javascript:alert(1)", "https://127.0.0.1/", "https://office.internal/", "https://user:secret@garden.example.jp/"])("omits unsafe field source %s while retaining confirmed values", async source => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, field_sources: { opening_hours: source } } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.opening_hours);
    expect(screen.queryByRole("link", { name: "開館・営業時間の出典" })).toBeNull();
  });
  it.each(["verified", "link_only"])("omits source links for unknown fields in %s responses", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, status, opening_hours: null, closed_days: null, admission: null,
      field_sources: { opening_hours: official.url, closed_days: official.url, admission: official.url } } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
    expect(screen.getAllByText("未確認")).toHaveLength(3);
    expect(screen.queryByRole("link", { name: /の出典$/ })).toBeNull();
  });
  it("prefers the official introduction and attributes highlights alongside route recommendations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} recommendations={["前の立ち寄り先から近い場所です。"]} />);
    expect(await screen.findByText(official.description)).toBeTruthy();
    expect(screen.queryByText(article.description)).toBeNull();
    expect(screen.getByText(official.highlights[0])).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "施設の見どころ" })).getByText(official.highlights[0])).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "この旅でのおすすめポイント" })).queryByText(official.highlights[0])).toBeNull();
    expect(screen.getByText("前の立ち寄り先から近い場所です。")).toBeTruthy();
    for (const link of screen.getAllByRole("link", { name: "施設の公式紹介" })) expect(link.getAttribute("href")).toBe(official.description_source_url);
    const guide = screen.getByRole("region", { name: "訪問前の確認" });
    expect(within(guide).getByText(official.opening_hours)).toBeTruthy();
    expect(within(guide).getByText(official.closed_days)).toBeTruthy();
    expect(within(guide).getByText(official.admission)).toBeTruthy();
    expect(within(guide).queryByRole("link", { name: /の出典$/ })).toBeNull();
    expect(within(guide).getByText(/公式ページを確認/).textContent).toContain("2026/10/12");
    expect(within(guide).getByRole("link", { name: /公式サイトで最新の案内を見る/ }).getAttribute("href")).toBe(official.url);
  });
  it("shows a link-only official site with unknown hours, closures and admission even if response contains them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, status: "link_only", description: null, highlights: [] } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(article.description);
    const guide = screen.getByRole("region", { name: "訪問前の確認" });
    expect(within(guide).getAllByText("未確認")).toHaveLength(3);
    for (const value of [official.opening_hours, official.closed_days, official.admission]) expect(screen.queryByText(value)).toBeNull();
    expect(within(guide).getByRole("link", { name: /公式サイトで最新の案内を見る/ })).toBeTruthy();
    expect(within(guide).getByText(/公式ページの内容は取得できませんでした/)).toBeTruthy();
  });
  it.each(["javascript:alert(1)", "https://127.0.0.1/", "https://office.internal/", "https://user:secret@garden.example.jp/"])("rejects unsafe official URL %s", async url => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, url } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(article.description);
    expect(screen.queryByText(official.description)).toBeNull();
    expect(screen.queryByRole("link", { name: /公式サイトで最新の案内を見る/ })).toBeNull();
    expect(screen.getByRole("link", { name: /施設名で公式案内を探す/ })).toBeTruthy();
  });
  it("falls back to the verified official site for an unsafe description source URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, description_source_url: "javascript:alert(1)" } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(official.description);
    expect(screen.getAllByRole("link", { name: "施設の公式紹介" }).every(link => link.getAttribute("href") === official.url)).toBe(true);
  });
  it("keeps unavailable official information explicitly unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...article, official: { ...official, status: "unavailable" } })));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    await screen.findByText(article.description);
    expect(screen.getByRole("region", { name: "訪問前の確認" }).textContent).toContain("公式サイトを確認できませんでした");
    expect(screen.queryByText(official.opening_hours)).toBeNull();
  });
  it("shows loading, posts the selected place directly, then renders credited description and useful visit context", async () => {
    const request = deferred();
    const fetchMock = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} stayMinutes={45} />);
    expect(screen.getByRole("status").textContent).toContain("説明を確認しています");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/places/description");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(place);
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await act(async () => { request.resolve(response(article)); });
    expect(await screen.findByText(article.description)).toBeTruthy();
    const source = screen.getByRole("link", { name: /庭園 — Wikipediaの寄稿者/ });
    expect(source.getAttribute("href")).toBe(article.source_url);
    expect(source.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: article.license_name }).getAttribute("href")).toBe(article.license_url);
    expect(screen.getByText("滞在の目安 45分")).toBeTruthy();
    expect(screen.getByText(place.description)).toBeTruthy();
    expect(screen.getByText("京都市")).toBeTruthy();
    expect(screen.getByRole("link", { name: /地図で場所を確認する/ }).getAttribute("href")).toContain("mlat=35&mlon=135");
    const google = screen.getByRole("link", { name: "Google Mapsで開く" });
    expect(google.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=35%2C135");
    expect(google.getAttribute("target")).toBe("_blank");
    expect(google.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["nullable article", { description: null, source_url: null, source_title: null, license_url: null, license_name: null, note: null }],
    ["missing article", null],
    ["unsafe source scheme", { ...article, source_url: "javascript:alert(1)" }],
    ["deceptive source host", { ...article, source_url: "https://ja.wikipedia.org.attacker.example/wiki/test" }],
    ["unsafe license", { ...article, license_url: "http://creativecommons.org/licenses/by-sa/4.0/" }],
  ])("falls back safely for %s while keeping the visit hint and map", async (_label, data) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(data)));
    render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    expect((await screen.findByText(/詳しい説明は、現在確認できません/)).textContent).toContain("地図");
    expect(screen.getByText(/天候や歩く距離に合わせて/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /地図で場所を確認する/ })).toBeTruthy();
    expect(screen.queryByText(article.description)).toBeNull();
    expect(screen.queryByRole("link", { name: /Wikipediaの寄稿者/ })).toBeNull();
  });

  it.each(["network", "http"])("retains fallback context after a %s failure", async kind => {
    vi.stubGlobal("fetch", vi.fn(async () => { if (kind === "network") throw Error("offline"); return response(article, false); }));
    render(<PlaceIntroduction enableOfficialSearch={false} place={{ ...place, category: "美術館" }} />);
    await screen.findByText(/詳しい説明は、現在確認できません/);
    expect(screen.getByText(/企画展・休館日・入館時間/)).toBeTruthy();
    expect(screen.queryByText(article.description)).toBeNull();
  });

  it("does not fetch a collapsed inline description, aborts on close and ignores the old response after reopening", async () => {
    const old = deferred(), current = deferred();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal);
      return signals.length === 1 ? old.promise : current.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PlaceDescriptionToggle enableOfficialSearch={false} place={place} />);
    expect(fetchMock).not.toHaveBeenCalled();
    const details = screen.getByText(`${place.name}の説明を見る`).closest("details")!;
    toggle(details, true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    toggle(details, false);
    expect(signals[0].aborted).toBe(true);
    toggle(details, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { current.resolve(response({ ...article, description: "再表示した最新の説明" })); });
    expect(await screen.findByText("再表示した最新の説明")).toBeTruthy();
    await act(async () => { old.resolve(response({ ...article, description: "閉じる前の古い説明" })); });
    expect(screen.queryByText("閉じる前の古い説明")).toBeNull();
    expect(screen.getByText("再表示した最新の説明")).toBeTruthy();
  });

  it("aborts an active request on unmount", () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise<Response>(() => {}); }));
    const view = render(<PlaceIntroduction enableOfficialSearch={false} place={place} />);
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("opens an accessible dialog, confines keyboard focus, closes with Escape and restores focus", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(null)));
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>場所の詳細を開く</button>{open && <PlaceDetailsDialog enableOfficialSearch={false} place={place} onClose={() => setOpen(false)} />}</>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "場所の詳細を開く" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: place.name });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Google Mapsで開く" }));
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "ダイアログを閉じる" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
  });
});
