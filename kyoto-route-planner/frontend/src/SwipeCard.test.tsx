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
    expect(screen.getByText("イメージ画像")).toBeTruthy();
  });

  it("keeps the themed placeholder when image_url is null", () => {
    render(
      <SwipeCard
        idea={makeIdea(null)}
        depth={0}
        isProcessing={false}
        onSwipe={vi.fn()}
      />,
    );

    expect(screen.getAllByText("庭園")).toHaveLength(2);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
