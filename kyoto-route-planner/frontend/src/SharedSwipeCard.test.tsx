import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AnimatePresence } from "framer-motion";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("keeps both swipe feedback labels from intercepting photo taps", () => {
    const select=vi.fn();
    const view=render(<SharedSwipeCard title="写真の旅" theme="nature" spots={[]} coverBadge=""
      coverContent={<button type="button" onClick={select}>施設の写真</button>}
      depth={0} isTop exitDirection="accept" onSwipe={()=>true} />);
    const labels=view.container.querySelectorAll<HTMLElement>(".swipe-stamp");
    expect(labels).toHaveLength(2);
    for(const label of labels){
      expect(label.style.pointerEvents).toBe("none");
      expect(label.getAttribute("aria-hidden")).toBe("true");
    }
    fireEvent.click(screen.getByRole("button",{name:"施設の写真"}));
    expect(select).toHaveBeenCalledOnce();
  });
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
