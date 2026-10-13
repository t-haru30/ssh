import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TravelerPreferences } from "./TravelerPreferences";
import { EMPTY_TRAVELER_PROFILE } from "./travelerProfile";
afterEach(cleanup);
it("offers accessible companion choices and optional demographics", () => {
 const onChange = vi.fn(); render(<TravelerPreferences value={EMPTY_TRAVELER_PROFILE} onChange={onChange} />);
 expect(screen.getByRole("button", { name: "指定しない" }).getAttribute("aria-pressed")).toBe("true");
 fireEvent.click(screen.getByRole("button", { name: "家族と" })); expect(onChange).toHaveBeenCalledWith({ ...EMPTY_TRAVELER_PROFILE, companion: "family" });
 fireEvent.change(screen.getByLabelText("年代"), { target: { value: "65_plus" } }); expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_TRAVELER_PROFILE, age_group: "65_plus" });
});

it("offers a separate accessible pace fieldset with standard selected by default", () => {
 const onChange = vi.fn(); render(<TravelerPreferences value={EMPTY_TRAVELER_PROFILE} onChange={onChange} />);
 expect(screen.getByRole("group", { name: "旅のペース" })).toBeTruthy();
 expect(screen.getByRole("button", { name: "標準" }).getAttribute("aria-pressed")).toBe("true");
 for (const [label, pace] of [["ゆったり", "relaxed"], ["たくさん巡る", "packed"]]) {
   fireEvent.click(screen.getByRole("button", { name: label }));
   expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_TRAVELER_PROFILE, pace });
 }
});
