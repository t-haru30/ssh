import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeCard } from "./SwipeCard";
import type { RouteIdea } from "./SwipeCard";
import type { ReactNode } from "react";

vi.mock("framer-motion", () => ({
  motion: {
    article: ({ children }: { children: ReactNode }) => <article>{children}</article>,
    div: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
  usePresence: () => [true, undefined],
  usePresenceData: () => undefined,
  useMotionValue: () => 0,
  useTransform: () => 0,
}));

function makeIdea(imageUrl: string | null): RouteIdea {
  return {
    theme: "nature",
    title: "庭園めぐり",
    story: "自然を楽しむアイデアです。",
    places: [{
      id: "garden",
      name: "庭園",
      category: "庭園",
      description: "",
      access_point: "",
      latitude: 35,
      longitude: 135,
      themes: ["nature"],
    }],
    image_url: imageUrl,
    image_verified: true,
    image_place_id: "garden",
    author_name: imageUrl ? "Photo author" : null,
    source_url: imageUrl ? "https://commons.wikimedia.org/wiki/File:Garden.jpg" : null,
    license_name: imageUrl ? "CC BY-SA 4.0" : null,
    license_url: imageUrl ? "https://creativecommons.org/licenses/by-sa/4.0/" : null,
    copywriting_source: "fallback",
    note: "",
  };
}

afterEach(cleanup);

describe("SwipeCard image attribution", () => {
  it("links author and license credits when an image is available", () => {
    render(
      <SwipeCard
        idea={makeIdea("https://upload.wikimedia.org/garden.jpg")}
        depth={0}
        isProcessing={false}
        onSwipe={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "Photo author" }).getAttribute("href"))
      .toBe("https://commons.wikimedia.org/wiki/File:Garden.jpg");
    expect(screen.getByRole("link", { name: "CC BY-SA 4.0" }).getAttribute("href"))
      .toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(screen.queryByText("イメージ画像")).toBeNull();
    expect(screen.getByTestId("cover-spot-name").textContent).toBe("庭園");
  });

  it("rejects unverified photos and photos belonging to another facility", () => {
    const idea = makeIdea("https://upload.wikimedia.org/garden.jpg");
    const view = render(<SwipeCard idea={{ ...idea, image_verified: false }} depth={0} isProcessing={false} onSwipe={vi.fn()} />);
    expect(view.container.querySelector(".swipe-cover-placeholder")).toBeTruthy();
    view.rerender(<SwipeCard idea={{ ...idea, image_place_id: "different" }} depth={0} isProcessing={false} onSwipe={vi.fn()} />);
    expect(view.container.querySelector(".swipe-cover-placeholder")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    view.rerender(<SwipeCard idea={{ ...idea, image_verified: "true" as unknown as boolean }} depth={0} isProcessing={false} onSwipe={vi.fn()} />);
    expect(view.container.querySelector(".swipe-cover-placeholder")).toBeTruthy();
  });

  it("keeps the themed placeholder when image_url is null", () => {
    const { container } = render(
      <SwipeCard
        idea={makeIdea(null)}
        depth={0}
        isProcessing={false}
        onSwipe={vi.fn()}
      />,
    );

    expect(container.querySelector(".swipe-cover-placeholder")).toBeTruthy();
    expect(screen.getByText("庭園", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("庭園", { selector: ".swipe-spot-category" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
