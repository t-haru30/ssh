import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoutePhotoGrid } from "./RoutePhotoGrid";
import type { Place } from "../types";
vi.mock("./useRoutePhoto", () => ({ useRoutePhoto: (places: Place[]) => ({ status:"ready", photo:{status:"ready",image_url:`https://upload.wikimedia.org/${places[0].id}.jpg`,source_url:`https://commons.wikimedia.org/wiki/File:${places[0].id}.jpg`,license_url:"https://creativecommons.org/licenses/by/4.0/",author_name:`撮影者${places[0].id}`,license_name:"CC BY 4.0"} }) }));
afterEach(cleanup);
it("pairs each photo with its own place and attribution, and handles a failed image independently", () => {
  const places: Place[] = ["庭園", "美術館"].map((name,i) => ({id:String(i),name,latitude:35,longitude:135,category:"観光",description:"",access_point:"",themes:[]}));
  render(<RoutePhotoGrid places={places} enabled />);
  expect(screen.getByRole("img", {name:"庭園"}).getAttribute("src")).toContain("0.jpg");
  expect(screen.getByRole("img", {name:"美術館"}).getAttribute("src")).toContain("1.jpg");
  expect(screen.getByRole("link", {name:"撮影者1"}).getAttribute("href")).toContain("1.jpg");
  fireEvent.error(screen.getByRole("img", {name:"庭園"}));
  expect(screen.getByText("写真なし")).toBeTruthy();
  expect(screen.getByRole("img", {name:"美術館"})).toBeTruthy();
});
