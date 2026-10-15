import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FacilityPhoto } from "./FacilityPhoto";
import { clearRoutePhotoCache } from "./discover/useRoutePhoto";
import type { Place } from "./types";

const station: Place = { id:"trip-arrival", name:"京都駅", latitude:34.98585, longitude:135.75877, category:"到着・観光の起点", description:"", access_point:"", themes:[] };
const photo = { status:"ready", place_id:station.id, place_name:station.name, image_url:"https://upload.wikimedia.org/wikipedia/commons/a/ab/Station.jpg", author_name:"撮影者", source_url:"https://commons.wikimedia.org/wiki/File:Station.jpg", license_name:"CC BY-SA 4.0", license_url:"https://creativecommons.org/licenses/by-sa/4.0/", image_verified:true, ai_checked:false };
const response = (value: unknown) => ({ok:true,json:async () => value});

beforeEach(() => {
  clearRoutePhotoCache();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    complete = false; naturalWidth = 0; decoding = "";
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    decode = () => Promise.resolve();
    removeAttribute() {}
  });
});
afterEach(() => { cleanup(); clearRoutePhotoCache(); vi.unstubAllGlobals(); });

it.each(["trip-arrival", "trip-return"])("shows the real photo and credits for the fixed endpoint %s", async id => {
  const fetcher=vi.fn().mockResolvedValue(response({...photo,place_id:id}));
  vi.stubGlobal("fetch",fetcher);
  render(<FacilityPhoto place={{...station,id}} compact />);
  expect((await screen.findByRole("img",{name:"京都駅"})).getAttribute("src")).toBe(photo.image_url);
  expect(screen.getByRole("link",{name:"撮影者"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"CC BY-SA 4.0"})).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/routes/photo");
  expect(JSON.parse(fetcher.mock.calls[0][1].body).places[0].id).toBe(id);
});

it("uses Google when no licensed station photo is available, preserving station metadata", async () => {
  const fetcher=vi.fn(async (url: string, _init?: RequestInit) => response(url === "/api/routes/photo" ? {status:"unavailable"} : {
    status:"ready",place_id:station.id,image_url:"https://lh3.googleusercontent.com/station",source_url:"https://maps.google.com/?cid=1",authors:[{name:"Google撮影者",url:"https://www.google.com/maps/contrib/1"}],
  }));
  vi.stubGlobal("fetch",fetcher);
  render(<FacilityPhoto place={{...station,tags:{railway:"station"}}} />);
  expect((await screen.findByRole("img",{name:"京都駅"})).getAttribute("src")).toContain("googleusercontent.com");
  expect(screen.getByRole("link",{name:"Google Maps"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"Google撮影者"})).toBeTruthy();
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).tags.railway).toBe("station");
});

it("keeps an honest station placeholder when both photo sources are unavailable", async () => {
  const fetcher=vi.fn().mockResolvedValue(response({status:"unavailable"}));
  vi.stubGlobal("fetch",fetcher);
  render(<FacilityPhoto place={station} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByText("駅の写真は取得できていません")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("AI生成・ジャンルイメージ")).toBeNull();
});

it("does not request a station photo until its card approaches the viewport", async () => {
  let observe!: IntersectionObserverCallback;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observe=callback; }
    observe() {}
    disconnect() {}
  });
  const fetcher=vi.fn().mockResolvedValue(response(photo));
  vi.stubGlobal("fetch",fetcher);
  render(<FacilityPhoto place={station} />);
  await act(async () => {});
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => observe([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver));
  await screen.findByRole("img",{name:"京都駅"});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
