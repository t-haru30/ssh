import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PreviewTransit } from "./PreviewTransit";

it("keeps the duration while omitting the movement label", () => {
  render(
    <ol>
      <PreviewTransit
        from="京都駅"
        to="稲荷駅"
        minutes={19}
        loading={false}
        places={[]}
      />
    </ol>,
  );

  expect(screen.getByText("約19分")).toBeTruthy();
  expect(screen.queryByText(/移動 約/)).toBeNull();
});
