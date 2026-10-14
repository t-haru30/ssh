import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreferenceTags } from "./PreferenceTags";
import { EMPTY_TRAVELER_PROFILE } from "./travelerProfile";
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("offers retry while AI is delayed and aborts the old request", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  render(<PreferenceTags theme="all" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(screen.getByText(/タグを選ばずに次へ進めます/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "もう一度提案する" }));
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(25000); });
  expect(screen.getByText(/AIの応答が時間内に届きませんでした/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "もう一度提案する" })).toBeTruthy();
});
it("loads real AI suggestions from selected preferences and allows selecting them", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: "ai", tags: ["静かな時間", "地元の暮らし"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  const view = render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={onChange} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "＋ 静かな時間" })).toBeTruthy(), { timeout: 2500 });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ theme: "nature", traveler: { companion: "unspecified", pace: "standard" } });
  fireEvent.click(screen.getByRole("button", { name: "＋ 静かな時間" }));
  expect(onChange).toHaveBeenCalledWith(["静かな時間"]);
  view.rerender(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={["地元の暮らし"]} onChange={onChange} />);
  expect(screen.getAllByRole("button").slice(0, 2).map(button => button.textContent)).toEqual(["＋ 静かな時間", "✓ 地元の暮らし"]);
});
it("does not label unavailable responses as AI suggestions and keeps selected tags removable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: "unavailable", tags: [] }) }));
  const onChange = vi.fn();
  render(<PreferenceTags theme="all" traveler={EMPTY_TRAVELER_PROFILE} selected={["静かな時間"]} onChange={onChange} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "もう一度提案する" })).toBeTruthy(), { timeout: 2500 });
  fireEvent.click(screen.getByRole("button", { name: "✓ 静かな時間" }));
  expect(onChange).toHaveBeenCalledWith([]);
});
it("aborts old preferences and does not show a late response", async () => {
  let resolve!: (result: unknown) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ok: true, json: async () => ({ source: "ai", tags: ["新しい発見"] }) });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce(), { timeout: 2500 });
  view.rerender(<PreferenceTags theme="food" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  resolve({ ok: true, json: async () => ({ source: "ai", tags: ["古いタグ"] }) });
  await waitFor(() => expect(screen.getByRole("button", { name: "＋ 新しい発見" })).toBeTruthy(), { timeout: 2500 });
  expect(screen.queryByText("＋ 古いタグ")).toBeNull();
});

it("appends additional tags without losing the earlier choices and excludes duplicates", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["静かな時間", "地元の暮らし"] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["静かな時間", "心を整える"] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={["静かな時間"]} onChange={onChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ もっと提案を見る" }, { timeout: 2500 }));
  expect(screen.getByRole("button", { name: "✓ 静かな時間" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "＋ もっと提案を見る" })).toBeNull();
  await screen.findByRole("button", { name: "＋ 心を整える" }, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ 地元の暮らし" })).toBeTruthy();
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).exclude_tags).toEqual(["静かな時間", "地元の暮らし"]);
  expect(screen.getAllByRole("button", { name: "✓ 静かな時間" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "＋ もっと提案を見る" }));
  await screen.findByText(/新しい提案タグは見つかりませんでした/, {}, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ 心を整える" })).toBeTruthy();
});
it("retains previous tags after an additional request fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ source: "ai", tags: ["静かな時間"] }) }).mockRejectedValueOnce(new Error("offline")));
  render(<PreferenceTags theme="nature" traveler={EMPTY_TRAVELER_PROFILE} selected={[]} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "＋ もっと提案を見る" }, { timeout: 2500 }));
  await screen.findByRole("button", { name: "もう一度提案する" }, { timeout: 2500 });
  expect(screen.getByRole("button", { name: "＋ 静かな時間" })).toBeTruthy();
});
