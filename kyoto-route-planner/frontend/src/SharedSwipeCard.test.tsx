import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AnimatePresence } from "framer-motion";
import { afterEach, describe, expect, it } from "vitest";
import { SharedSwipeCard, type SharedSwipeDirection } from "./SharedSwipeCard";

afterEach(cleanup);

function Deck({ index, direction }: { index: number; direction: SharedSwipeDirection }) {
  return <AnimatePresence custom={direction}>
    {["first", "second", "third"].slice(index).map((title, depth) =>
      <SharedSwipeCard key={title} title={title} theme="nature" spots={[]} coverBadge=""
        depth={depth} isTop={depth === 0} exitDirection={direction} onSwipe={() => true} />)}
  </AnimatePresence>;
}

describe("swipe card departure with real motion lifecycle", () => {
  for (const direction of ["accept", "skip"] as const) {
    it(`removes departed cards and enables the next card after ${direction}`, async () => {
      const view = render(<Deck index={0} direction="skip" />);
      view.rerender(<Deck index={1} direction={direction} />);
      const departing = screen.getByRole("article", { name: "first" });
      expect(departing.hasAttribute("inert")).toBe(true);
      expect(departing.style.pointerEvents).toBe("none");
      await waitFor(() => expect(screen.queryByRole("article", { name: "first" })).toBeNull());
      expect(screen.getByRole("article", { name: "second" }).hasAttribute("inert")).toBe(false);
      view.rerender(<Deck index={2} direction={direction} />);
      await waitFor(() => expect(screen.queryByRole("article", { name: "second" })).toBeNull());
      expect(screen.getAllByRole("article")).toHaveLength(1);
      view.rerender(<Deck index={0} direction={direction} />);
      expect(screen.getByRole("article", { name: "first" }).hasAttribute("inert")).toBe(false);
    });
  }
});
