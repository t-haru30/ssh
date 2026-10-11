import { describe, expect, it } from "vitest";
import { isEstimatedLeg, NETWORK_FAILURE_MESSAGE, ROUTE_FAILURE_MESSAGE, toFriendlyMessage } from "./friendlyError";

describe("toFriendlyMessage", () => {
  it("replaces technical API messages with actionable guidance", () => {
    expect(toFriendlyMessage(new Error("宿泊ルートAPIから有効な旅程が返されませんでした。"))).toBe(ROUTE_FAILURE_MESSAGE);
    expect(toFriendlyMessage(new Error("ルートを取得できませんでした。APIサーバーの状態を確認してください。"))).toBe(ROUTE_FAILURE_MESSAGE);
  });

  it("keeps user-facing messages from the backend", () => {
    expect(toFriendlyMessage(new Error("出発駅を選び直してください。"))).toBe("出発駅を選び直してください。");
  });

  it("maps network failures and unknown values", () => {
    expect(toFriendlyMessage(new TypeError("Failed to fetch"))).toBe(NETWORK_FAILURE_MESSAGE);
    expect(toFriendlyMessage("oops", "代替")).toBe("代替");
  });
});

describe("isEstimatedLeg", () => {
  it("detects fallback legs", () => {
    expect(isEstimatedLeg({ line_name: "徒歩（概算）" })).toBe(true);
    expect(isEstimatedLeg({ line_name: "JR嵯峨野線" })).toBe(false);
  });
});
