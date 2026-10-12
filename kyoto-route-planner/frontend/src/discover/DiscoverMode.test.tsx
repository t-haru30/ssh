import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";
import hokkaidoDataset from "../data/routes/hokkaido.json";

vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderDiscoverMode() {
  return render(
    <PrefectureProvider>
      <FavoritesProvider>
        <DiscoverMode active />
      </FavoritesProvider>
    </PrefectureProvider>,
  );
}

describe("DiscoverMode", () => {
  it("renders the generated Kyoto dataset without requesting the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDiscoverMode();

    expect((screen.getByRole("combobox", { name: "都道府県" }) as HTMLSelectElement).value).toBe("kyoto");
    expect(screen.getByText("京都府のよりみち")).toBeTruthy();
    expect(screen.getByText("5件の候補")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the selected prefecture and saves a local route as a favorite", () => {
    renderDiscoverMode();
    const select = screen.getByRole("combobox", { name: "都道府県" }) as HTMLSelectElement;
    const nextOption = select.options[0];
    expect(nextOption.value).toBe("hokkaido");
    fireEvent.change(select, { target: { value: nextOption.value } });

    expect(screen.getByText(`${nextOption.textContent}のよりみち`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "しおりを開く" }));

    const favorites = JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]");
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toMatchObject({
      prefecture_code: "01",
      prefecture_name: nextOption.textContent,
      copywriting_source: "fallback",
      origin: { name: hokkaidoDataset.routes[0].start.name, latitude: hokkaidoDataset.routes[0].start.lat, longitude: hokkaidoDataset.routes[0].start.lng },
      dwell_minutes: expect.any(Object),
    });
  });

  it("shows a save notice and undoes a like, removing the saved favorite", () => {
    renderDiscoverMode();
    const undoButton = screen.getByRole("button", { name: "1つ前に戻す" }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "しおりを開く" }));
    expect(screen.getByText(/保存しました/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]")).toHaveLength(1);
    expect(screen.getByText("2 / 5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]")).toHaveLength(0);
    expect(screen.getByText("1 / 5")).toBeTruthy();
    expect(undoButton.disabled).toBe(true);
  });

  it("undoes a skip without touching favorites", () => {
    renderDiscoverMode();
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    expect(screen.getByText("スキップしました")).toBeTruthy();
    expect(screen.getByText("2 / 5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "1つ前に戻す" }));
    expect(screen.getByText("1 / 5")).toBeTruthy();
  });

  it("does not render an API error state for local datasets", () => {
    renderDiscoverMode();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the browsing position for each theme and when returning to the tab", () => {
    const view = renderDiscoverMode();
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "スキップ" }));
    fireEvent.click(screen.getByRole("button", { name: "おまかせ" }));
    expect(screen.getByText("2 / 5")).toBeTruthy();
    view.rerender(<PrefectureProvider><FavoritesProvider><DiscoverMode active={false} /></FavoritesProvider></PrefectureProvider>);
    view.rerender(<PrefectureProvider><FavoritesProvider><DiscoverMode active /></FavoritesProvider></PrefectureProvider>);
    expect(screen.getByText("2 / 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "歴史・街歩き" }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("shows an actionable empty state when the chosen theme has no routes", () => {
    renderDiscoverMode();
    fireEvent.click(screen.getByRole("button", { name: "グルメ" }));
    expect(screen.getByText("この条件の候補は、まだありません")).toBeTruthy();
    expect((screen.getByRole("button", { name: "しおりを開く" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "すべての候補を見る" }));
    expect(screen.getByText("5件の候補")).toBeTruthy();
  });

  it("filters by actual course length when an original half-day route returns after 14:00", () => {
    renderDiscoverMode();
    fireEvent.change(screen.getByRole("combobox", { name: "都道府県" }), { target: { value: "aichi" } });
    fireEvent.click(screen.getByRole("button", { name: "半日" }));
    expect(screen.getByText("1件の候補")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "1日" }));
    expect(screen.getByText("4件の候補")).toBeTruthy();
    expect(screen.getAllByText("1日コース").length).toBeGreaterThan(0);
  });
});
