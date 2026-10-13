import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreferenceTags } from "./PreferenceTags";
import { EMPTY_TRAVELER_PROFILE } from "./travelerProfile";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("loads real AI suggestions from selected preferences and allows selecting them", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: "ai", tags: ["庭園でひと休み", "レトロな喫茶店"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={onChange} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "＋ 庭園でひと休み" })).toBeTruthy(), { timeout: 2500 });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ theme: "nature", traveler: { companion: "unspecified", pace: "standard" } });
  fireEvent.click(screen.getByRole("button", { name: "＋ 庭園でひと休み" }));
  expect(onChange).toHaveBeenCalledWith(["庭園でひと休み"]);
});
it("does not label unavailable responses as AI suggestions and keeps selected tags removable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: "unavailable", tags: [] }) }));
  const onChange = vi.fn();
  render(<PreferenceTags theme="all" traveler={EMPTY_TRAVELER_PROFILE} selected={["庭園でひと休み"]} onChange={onChange} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "もう一度提案する" })).toBeTruthy(), { timeout: 2500 });
  fireEvent.click(screen.getByRole("button", { name: "✓ 庭園でひと休み" }));
  expect(onChange).toHaveBeenCalledWith([]);
});
it("aborts old preferences and does not show a late response", async () => {
  let resolve!: (result: unknown) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ok: true, json: async () => ({ source: "ai", tags: ["地元の市場巡り"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 2500 });
  view.rerender(<PreferenceTags theme="food" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  resolve({ ok: true, json: async () => ({ source: "ai", tags: ["古いタグ"] }) });
  await waitFor(() => expect(screen.getByRole("button", { name: "＋ 地元の市場巡り" })).toBeTruthy(), { timeout: 2500 });
  expect(screen.queryByText("＋ 古いタグ")).toBeNull();
});

it("appends additional tags without losing the earlier choices and excludes duplicates", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["庭園でひと休み", "レトロな喫茶店"] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["庭園でひと休み", "湖畔を散歩"] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={["庭園でひと休み"]} onChange={onChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ もっと提案を見る" }, { timeout: 2500 }));
  expect(screen.getByRole("button", { name: "✓ 庭園でひと休み" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "＋ もっと提案を見る" })).toBeNull();
  await screen.findByRole("button", { name: "＋ 湖畔を散歩" }, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ レトロな喫茶店" })).toBeTruthy();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).exclude_tags).toEqual(["庭園でひと休み", "レトロな喫茶店"]);
  expect(screen.getAllByRole("button", { name: "✓ 庭園でひと休み" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "＋ もっと提案を見る" }));
  await screen.findByText(/新しい提案タグは見つかりませんでした/, {}, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ 湖畔を散歩" })).toBeTruthy();
});
it("retains previous tags after an additional request fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["庭園でひと休み"] }) }).mockRejectedValueOnce(new Error("offline")));
  render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ もっと提案を見る" }, { timeout: 2500 }));
  await screen.findByRole("button", { name: "もう一度提案する" }, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ 庭園でひと休み" })).toBeTruthy();
});
