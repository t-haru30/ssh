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
  expect(screen.getByText("AI生成・ジャンルイメージ")).toBeTruthy();
  expect(screen.getByRole("img", {name:"美術館"})).toBeTruthy();
});

it("shows up to four photos per page, resets for another trip, and keeps taps separate from page changes", () => {
  const places: Place[] = Array.from({length:7}, (_,i) => ({id:String(i),name:`施設${i+1}`,latitude:35,longitude:135,category:"観光",description:"",access_point:"",themes:[]}));
  const select=vi.fn();
  const view=render(<RoutePhotoGrid places={places} enabled onPlaceSelect={select} />);
  expect(screen.getAllByRole("img")).toHaveLength(4);
  expect(screen.queryByRole("img",{name:"施設5"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"施設4の詳細を見る"}));
  expect(select).toHaveBeenCalledWith("3", expect.objectContaining({provider:"licensed",imageUrl:expect.stringContaining("3.jpg")}));
  fireEvent.click(screen.getByRole("button",{name:"次の写真ページ"}));
  expect(screen.getAllByRole("img")).toHaveLength(3);
  expect(screen.getByText("写真 2 / 2")).toBeTruthy();
  expect(screen.getByRole("button",{name:"次の写真ページ"}).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"施設7の詳細を見る"}));
  expect(select).toHaveBeenLastCalledWith("6", expect.objectContaining({provider:"licensed",imageUrl:expect.stringContaining("6.jpg")}));
  view.rerender(<RoutePhotoGrid places={places.slice(0,4)} enabled onPlaceSelect={select} />);
  expect(screen.getAllByRole("img")).toHaveLength(4);
  expect(screen.queryByRole("button",{name:"次の写真ページ"})).toBeNull();
});
