import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEvidence, VenueEvidence } from "./VenueEvidence";

const place = { id: "test-place", name: "試験美術館", category: "美術館", latitude: 35, longitude: 135, description: "送信しない", access_point: "", themes: [] };
const text = "施設確認：試験美術館。\n\n口コミ：静かな展示を楽しめたという感想があります。";
const ready = { place_id: place.id, status: "ready", message: "", text, sources: [{ number: 1, title: "試験用出典", url: "https://example.com/review" }],
  citations: [{ end: 11, sources: [1] }, { end: text.length, sources: [1] }], checked_at: "2026-10-12T00:00:00Z", search_suggestions_html: '<div><a href="https://www.google.com/search?q=museum">Google検索</a></div>' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("VenueEvidence", () => {
  it("does not search on mount; one click sends venue identity only and displays cited text", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ready });
    vi.stubGlobal("fetch", fetch);
    const view = render(<VenueEvidence place={place} />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /試験美術館の口コミ/ }));
    await screen.findByText("口コミなどのAI要約");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/recommendations/evidence");
    expect(JSON.parse(fetch.mock.calls[0][1].body).place.description).toBe("");
    expect(screen.getAllByRole("link", { name: "出典1：試験用出典" })[0].getAttribute("href")).toBe("https://example.com/review");
    expect([...view.container.querySelectorAll(".venue-evidence-text")].map(element => element.textContent).join("").replaceAll("[1]", "")).toBe(ready.text);
    expect(screen.queryByText("出典付き")).toBeNull();
    await waitFor(() => expect(view.container.querySelector(".venue-search-suggestions")?.shadowRoot?.textContent).toBe("Google検索"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows honest unconfigured and unverified states without fabricating an explanation", async () => {
    for (const status of ["unconfigured", "unverified"]) {
      const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...ready, status, text: "", message: "確認できる根拠がありません。", citations: [], sources: [], search_suggestions_html: "", checked_at: null }) });
      vi.stubGlobal("fetch", fetch);
      render(<VenueEvidence place={place} />);
      fireEvent.click(screen.getByRole("button"));
      await screen.findByText("確認できる根拠がありません。");
      expect(screen.queryByText("口コミなどのAI要約")).toBeNull();
      expect(fetch).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("does not retry or change the itinerary when the provider fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: "APIの上限に達しました。" }) });
    vi.stubGlobal("fetch", fetch);
    render(<VenueEvidence place={place} />);
    fireEvent.click(screen.getByRole("button"));
    expect((await screen.findByRole("alert")).textContent).toBe("APIの上限に達しました。");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts and ignores a previous venue response when the venue changes", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise(r => { resolve = r; }));
    vi.stubGlobal("fetch", fetch);
    const view = render(<VenueEvidence place={place} />);
    fireEvent.click(screen.getByRole("button"));
    const signal = fetch.mock.calls[0][1].signal;
    view.rerender(<VenueEvidence place={{ ...place, id: "new-place", name: "別の施設" }} />);
    expect(signal.aborted).toBe(true);
    resolve({ ok: true, json: async () => ready });
    await waitFor(() => expect(screen.getByRole("button", { name: /別の施設の口コミ/ })).toBeTruthy());
    expect(screen.queryByText("口コミなどのAI要約")).toBeNull();
  });

  it("rejects wrong venues, unsupported citations and unsafe suggestion HTML", () => {
    for (const data of [{ ...ready, place_id: "wrong" }, { ...ready, sources: [] }, { ...ready, citations: [{ end: 9999, sources: [1] }] },
      { ...ready, search_suggestions_html: '<img src=x onerror="alert(1)">' }, { ...ready, search_suggestions_html: '<a href="javascript:alert(1)">bad</a>' }]) {
      expect(() => readEvidence(data, place.id)).toThrow();
    }
  });
});
