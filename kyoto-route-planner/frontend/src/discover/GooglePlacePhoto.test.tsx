import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GooglePlacePhoto } from "./GooglePlacePhoto";
import type { Place } from "../types";
const place: Place = {id:"museum",name:"資料館",latitude:35,longitude:135,category:"博物館",description:"",access_point:"",themes:[]};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("only fetches when enabled and shows all credits, falling back on image failure", async () => {
  const fetcher = vi.fn().mockResolvedValue({ok:true,json:async () => ({status:"ready",place_id:"museum",image_url:"https://lh3.googleusercontent.com/photo",source_url:"https://maps.google.com/?cid=1",authors:[{name:"撮影者",url:"https://www.google.com/maps/contrib/1"}]})});
  vi.stubGlobal("fetch",fetcher);
  const {rerender} = render(<GooglePlacePhoto place={place} enabled={false} showName>代替画像</GooglePlacePhoto>);
  expect(fetcher).not.toHaveBeenCalled();
  rerender(<GooglePlacePhoto place={place} enabled showName>代替画像</GooglePlacePhoto>);
  await screen.findByRole("img",{name:"資料館"});
  expect(screen.getByRole("link",{name:"Google Maps"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"撮影者"})).toBeTruthy();
  expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  fireEvent.error(screen.getByRole("img",{name:"資料館"}));
  expect(screen.getByText("代替画像")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects photos from unexpected hosts", async () => {
  const fetcher = vi.fn().mockResolvedValue({ok:true,json:async () => ({status:"ready",place_id:"museum",image_url:"https://evil.example/photo",source_url:"https://maps.google.com/",authors:[]})});
  vi.stubGlobal("fetch",fetcher);
  render(<GooglePlacePhoto place={place} enabled showName>代替画像</GooglePlacePhoto>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("img")).toBeNull();
});
it("shares an in-flight lookup in StrictMode, ignores unrelated edits and discards content on unmount", async () => {
  let resolve!: (value: unknown) => void;
  const fetcher = vi.fn().mockImplementation(() => new Promise(r => { resolve = r; }));
  vi.stubGlobal("fetch", fetcher);
  const cards = (description: string) => <StrictMode>{[1,2].map(i => <GooglePlacePhoto key={i} place={{...place, description}} enabled showName>代替画像</GooglePlacePhoto>)}</StrictMode>;
  const view = render(cards("元の説明"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  view.rerender(cards("説明を編集"));
  await act(async () => resolve({ok:true,json:async () => ({status:"ready",place_id:"museum",image_url:"https://lh3.googleusercontent.com/photo",source_url:"https://maps.google.com/",authors:[]})}));
  expect(screen.getAllByRole("img")).toHaveLength(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
  view.unmount();
  render(cards("再表示"));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
it("never displays the previous facility photo after identity changes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true,json:async () => ({status:"ready",place_id:"museum",image_url:"https://lh3.googleusercontent.com/photo",source_url:"https://maps.google.com/",authors:[]})}));
  const view = render(<GooglePlacePhoto place={place} enabled showName>代替画像</GooglePlacePhoto>);
  await screen.findByRole("img");
  view.rerender(<GooglePlacePhoto place={{...place,id:"another",name:"別の施設"}} enabled showName>代替画像</GooglePlacePhoto>);
  expect(screen.queryByRole("img")).toBeNull();
});

it("keeps an already displayed photo through a temporary dialog or tab switch without another paid lookup", async () => {
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async () => ({status:"ready",place_id:place.id,image_url:"https://lh3.googleusercontent.com/photo",source_url:"https://maps.google.com/",authors:[]})});
  vi.stubGlobal("fetch",fetcher);
  const view=render(<GooglePlacePhoto place={place} enabled showName>代替画像</GooglePlacePhoto>);
  await screen.findByRole("img");
  view.rerender(<GooglePlacePhoto place={place} enabled={false} showName>代替画像</GooglePlacePhoto>);
  expect(screen.queryByRole("img")).toBeNull();
  view.rerender(<GooglePlacePhoto place={place} enabled showName>代替画像</GooglePlacePhoto>);
  await act(async () => {});
  expect(screen.getByRole("img").getAttribute("src")).toBe("https://lh3.googleusercontent.com/photo");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
