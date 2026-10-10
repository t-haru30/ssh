import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrefectureProvider } from "../PrefectureContext";
import { FavoritesProvider } from "../useFavorites";
import { DiscoverMode } from "./DiscoverMode";

vi.mock("./RouteDetailModal", () => ({ RouteDetailModal: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderDiscoverMode() {
  render(
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
    expect(screen.getByText("京都府の実データに基づくサンプル（5件）")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates the selected prefecture and saves a local route as a favorite", () => {
    renderDiscoverMode();
    const select = screen.getByRole("combobox", { name: "都道府県" }) as HTMLSelectElement;
    const nextOption = select.options[0];
    expect(nextOption.value).toBe("hokkaido");
    fireEvent.change(select, { target: { value: nextOption.value } });

    expect(screen.getByText(`${nextOption.textContent}の実データに基づくサンプル（5件）`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "行きたい" }));

    const favorites = JSON.parse(window.localStorage.getItem("kyoto-route-planner:favorites:v1") ?? "[]");
    expect(favorites).toHaveLength(1);
    expect(favorites[0]).toMatchObject({
      prefecture_code: "01",
      prefecture_name: nextOption.textContent,
      copywriting_source: "fallback",
    });
  });

  it("does not render an API error state for local datasets", () => {
    renderDiscoverMode();

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
