import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiscoverMode } from "./DiscoverMode";

describe("DiscoverMode", () => {
  it("renders the generated Kyoto dataset without requesting the API", () => {
    render(<DiscoverMode active />);

    expect((screen.getByRole("combobox", { name: "都道府県" }) as HTMLSelectElement).value).toBe("kyoto");
    expect(screen.getByText("京都府の実データに基づくサンプル（5件）")).toBeTruthy();
  });

  it("does not render an API error state for local datasets", () => {
    render(<DiscoverMode active />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
