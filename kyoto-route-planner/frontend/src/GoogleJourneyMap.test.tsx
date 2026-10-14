import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GoogleJourneyMap } from "./GoogleJourneyMap";
const mocks=vi.hoisted(() => ({lines:[] as Record<string,unknown>[],fit:vi.fn(),load:vi.fn(),compute:vi.fn()}));
vi.mock("./googleMapsLoader",() => ({loadGoogleMaps:mocks.load,loadGoogleRoutes:async () => ({Route:{computeRoutes:mocks.compute}})}));
class MapMock {fitBounds=mocks.fit;panTo=vi.fn();setZoom=vi.fn();}
class LineMock { constructor(options:Record<string,unknown>){mocks.lines.push(options);}setMap=vi.fn(); }
class MarkerMock { map=null;addListener=vi.fn(); }
class BoundsMock {extend=vi.fn();}
class PopupMock {open=vi.fn();close=vi.fn();}
const props={places:[{id:"museum",name:"博物館",category:"博物館",latitude:35.02,longitude:135.02,themes:[] as [],description:"",access_point:""}],origin:{name:"京都駅",latitude:35,longitude:135}};
afterEach(() => {cleanup();vi.unstubAllGlobals();mocks.lines=[];mocks.load.mockReset();mocks.compute.mockReset();});
it("loads geometry only on request and draws the provider's curve separately from straight overview lines",async () => {
  mocks.load.mockResolvedValue({Map:MapMock,Polyline:LineMock,AdvancedMarkerElement:MarkerMock,LatLngBounds:BoundsMock,InfoWindow:PopupMock});
  const fetchMock=vi.fn(async () => ({ok:true,json:async () => ({routes:[{status:"ready",segments:[{line_name:"地下鉄",mode:"train",approximate:false,coordinates:[[35,135],[35.01,135.03],[35.02,135.02]]}]}]})}));
  vi.stubGlobal("fetch",fetchMock);
  render(<GoogleJourneyMap {...props} mapTokens={["a".repeat(32)]} />);
  await waitFor(() => expect(mocks.lines.length).toBeGreaterThan(0));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.lines.at(-1)?.path).toEqual([{lat:35,lng:135},{lat:35.02,lng:135.02},{lat:35,lng:135}]);
  fireEvent.click(screen.getByRole("button",{name:"電車・バス"}));
  await waitFor(() => expect(mocks.lines.at(-1)?.path).toEqual([{lat:35,lng:135},{lat:35.01,lng:135.03},{lat:35.02,lng:135.02}]));
  expect(screen.getByText(/青：鉄道/)).toBeTruthy();
  expect(mocks.lines.at(-1)?.strokeOpacity).toBe(.9);
  fireEvent.click(screen.getByRole("button",{name:"つながり（直線）"}));
  fireEvent.click(screen.getByRole("button",{name:"電車・バス"}));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("opens name-based transit directions without calling unsupported Japanese transit, and separately requests walking geometry",async () => {
  mocks.load.mockResolvedValue({routeProvider:"google",Map:MapMock,Polyline:LineMock,AdvancedMarkerElement:MarkerMock,LatLngBounds:BoundsMock,InfoWindow:PopupMock});
  const fetchMock=vi.fn(async () => ({ok:true,json:async () => ({granted:2})}));
  vi.stubGlobal("fetch",fetchMock);
  mocks.compute.mockResolvedValue({routes:[{path:[{lat:35,lng:135},{lat:35.01,lng:135.02},{lat:35.02,lng:135.02}]}]});
  render(<GoogleJourneyMap {...props} />);
  await waitFor(() => expect(mocks.lines.length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button",{name:"電車・バス"}));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.compute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("区間ごとの乗換経路"));
  expect(screen.getByRole("link",{name:/京都駅 → 博物館/}).getAttribute("href")).toContain("origin=%E4%BA%AC%E9%83%BD%E9%A7%85");
  fireEvent.click(screen.getByRole("button",{name:"徒歩経路"}));
  await waitFor(() => expect(mocks.compute).toHaveBeenCalledTimes(2));
  expect(mocks.compute.mock.calls[0][0]).toMatchObject({travelMode:"WALKING"});
  expect(screen.getByText(/徒歩の参考経路/)).toBeTruthy();
});
it("keeps a Google Maps link when the display key is unavailable, without showing Places content on an OSM map",async () => {
  mocks.load.mockRejectedValue(new Error("missing"));
  render(<GoogleJourneyMap {...props} />);
  expect(await screen.findByRole("link",{name:"Google Mapsで確認する"})).toBeTruthy();
  expect(screen.queryByText(/OpenStreetMap/)).toBeNull();
});

it("preserves the chosen map area when switching the layer or highlighting a timeline spot",async () => {
  mocks.fit.mockClear();
  mocks.load.mockResolvedValue({routeProvider:"google",Map:MapMock,Polyline:LineMock,AdvancedMarkerElement:MarkerMock,LatLngBounds:BoundsMock,InfoWindow:PopupMock});
  const journey={...props,places:[...props.places,{...props.places[0],id:"garden",name:"庭園",latitude:35.03}]};
  const view=render(<GoogleJourneyMap {...journey} />);
  await waitFor(() => expect(mocks.fit).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button",{name:"全体"}));
  expect(mocks.fit).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button",{name:"電車・バス"}));
  await act(async () => {});
  expect(mocks.fit).toHaveBeenCalledTimes(2);
  view.rerender(<GoogleJourneyMap {...journey} activeSpotId="museum" />);
  expect(mocks.fit).toHaveBeenCalledTimes(2);
});
it("redraws the same map after returning from a hidden screen without another map load",async()=>{
  const created=vi.fn(),resize=vi.fn();
  class ReopenedMap extends MapMock {constructor(){super();created();}}
  mocks.load.mockResolvedValue({Map:ReopenedMap,Polyline:LineMock,AdvancedMarkerElement:MarkerMock,LatLngBounds:BoundsMock,InfoWindow:PopupMock,event:{trigger:resize}});
  vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({width:390,height:320} as DOMRect);
  const view=render(<GoogleJourneyMap {...props} visible={false} />);
  await waitFor(()=>expect(created).toHaveBeenCalledTimes(1));
  expect(resize).not.toHaveBeenCalled();
  view.rerender(<GoogleJourneyMap {...props} visible />);
  await waitFor(()=>expect(resize).toHaveBeenCalledWith(expect.any(ReopenedMap),"resize"));
  view.rerender(<GoogleJourneyMap {...props} visible={false} />);
  const before=resize.mock.calls.length;
  view.rerender(<GoogleJourneyMap {...props} visible />);
  await waitFor(()=>expect(resize.mock.calls.length).toBeGreaterThan(before));
  expect(created).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});
