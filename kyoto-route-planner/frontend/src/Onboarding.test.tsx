import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Onboarding, ONBOARDING_STORAGE_KEY, setOnboardingSuppressed, shouldSuppressOnboarding } from "./Onboarding";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Onboarding", () => {
  it("is suppressed only when explicitly opted out", () => {
    expect(shouldSuppressOnboarding()).toBe(false);
    window.localStorage.setItem("kyoto-route-planner:onboarding:v1", "done");
    expect(shouldSuppressOnboarding()).toBe(false);
    setOnboardingSuppressed(true);
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("done");
    expect(shouldSuppressOnboarding()).toBe(true);
    setOnboardingSuppressed(false);
    expect(shouldSuppressOnboarding()).toBe(false);
  });

  it("reflects an existing opt-out choice in the checkbox", () => {
    setOnboardingSuppressed(true);
    render(<Onboarding onClose={setOnboardingSuppressed} />);
    expect((screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(shouldSuppressOnboarding()).toBe(false);
  });

  it("requires reaching step three before starting or dismissing the guide", () => {
    let closed = 0;
    render(<Onboarding onClose={() => { closed += 1; }} />);
    const dialog = screen.getByRole("dialog", { name: "はじめての使い方" });
    expect(screen.getByRole("heading", { name: "3つのステップで、旅のプランが完成" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "STEP 1検索条件を選ぶ",
      "STEP 2スワイプで旅を選ぶ",
      "STEP 3プランを編集する",
    ]);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("onboarding-tab-1");
    expect(screen.getByRole("img", { name: "条件を選んで旅を探す画面" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "はじめる" })).toBeNull();
    expect((tabs[2] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("onboarding-tab-2");
    expect(screen.getByRole("img", { name: "旅程カードを右へスワイプして保存する様子" })).toBeTruthy();
    expect(screen.getByText(/右へスワイプして保存/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "はじめる" })).toBeNull();
    expect((tabs[2] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("onboarding-tab-3");
    expect(screen.getByRole("img", { name: "訪問先と時間と予算を編集する画面" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "はじめる" })).toBeTruthy();
    expect((tabs[2] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(tabs[2], { key: "ArrowLeft" });
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("onboarding-tab-2");
    fireEvent.click(screen.getByRole("tab", { name: /STEP 1/ }));
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("onboarding-tab-1");
    fireEvent.click(screen.getByRole("tab", { name: /STEP 3/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(closed).toBe(1);
    expect((screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }) as HTMLInputElement).checked).toBe(false);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(2);
    expect(dialog).toBeTruthy();
  });

  it("passes the opt-out choice when closing the welcome guide", () => {
    let suppressFuture = false;
    render(<Onboarding onClose={(suppress) => { suppressFuture = suppress; }} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "今後、使い方の説明を表示しない" }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: /次のステップを見る/ }));
    fireEvent.click(screen.getByRole("button", { name: "はじめる" }));
    expect(suppressFuture).toBe(true);
  });
});
