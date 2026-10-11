import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Onboarding, ONBOARDING_STORAGE_KEY, hasSeenOnboarding, markOnboardingSeen } from "./Onboarding";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Onboarding", () => {
  it("is shown until dismissed once", () => {
    expect(hasSeenOnboarding()).toBe(false);
    markOnboardingSeen();
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
    expect(hasSeenOnboarding()).toBe(true);
  });

  it("explains the three steps and closes via the start button and Escape", () => {
    let closed = 0;
    render(<Onboarding onClose={() => { closed += 1; }} />);
    expect(screen.getByRole("dialog", { name: "はじめての使い方" })).toBeTruthy();
    expect(screen.getByText("経路を作る")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);
  });
});
