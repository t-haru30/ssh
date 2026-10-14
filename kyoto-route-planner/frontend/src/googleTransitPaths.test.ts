import { afterEach, expect, it, vi } from "vitest";
import { computeGooglePaths } from "./googleTransitPaths";
const mock=vi.hoisted(() => ({compute:vi.fn()}));
vi.mock("./googleMapsLoader",() => ({loadGoogleRoutes:async () => ({Route:{computeRoutes:mock.compute}})}));
afterEach(() => {vi.unstubAllGlobals();mock.compute.mockReset();});
it("queries each facility pair at the planned time and keeps transit modes and the actual step curves",async () => {
  vi.stubGlobal("fetch",vi.fn(async () => ({ok:true,json:async () => ({granted:2})})));
  mock.compute.mockResolvedValue({routes:[{legs:[{steps:[{travelMode:"TRANSIT",transitDetails:{transitLine:{name:"路線バス",vehicle:{type:"BUS"}}},path:[{lat:35,lng:135},{lat:35.01,lng:135.03},{lat:35.02,lng:135.02}]}]}],warnings:["歩行経路にご注意ください。"]}]});
  const result=await computeGooglePaths([{lat:35,lng:135},{lat:35.02,lng:135.02},{lat:35,lng:135}],"2026-10-14",["09:00","13:15"],new AbortController().signal);
  expect(mock.compute).toHaveBeenCalledTimes(2);
  expect(mock.compute.mock.calls[0][0].departureTime.toISOString()).toBe("2026-10-14T00:00:00.000Z");
  expect(mock.compute.mock.calls[1][0].departureTime.toISOString()).toBe("2026-10-14T04:15:00.000Z");
  expect(result.segments[0]).toMatchObject({mode:"bus",approximate:false,coordinates:[[35,135],[35.01,135.03],[35.02,135.02]]});
  expect(result.warnings).toHaveLength(1);
  expect(result.missing).toBe(false);
});
it("does not call Google after the application budget is exhausted",async () => {
  vi.stubGlobal("fetch",vi.fn(async () => ({ok:true,json:async () => ({granted:0})})));
  await expect(computeGooglePaths([{lat:35,lng:135},{lat:36,lng:135}],"2026-10-14",["09:00"],new AbortController().signal)).rejects.toThrow("route_budget");
  expect(mock.compute).not.toHaveBeenCalled();
});
it("does not invent a path when one segment cannot be obtained",async () => {
  vi.stubGlobal("fetch",vi.fn(async () => ({ok:true,json:async () => ({granted:2})})));
  mock.compute.mockRejectedValue(new Error("no transit"));
  const result=await computeGooglePaths([{lat:35,lng:135},{lat:36,lng:135}],"2026-10-14",["09:00"],new AbortController().signal);
  expect(result).toMatchObject({segments:[],missing:true});
});
it("limits the explicit walking preview to nearby facilities and never sends a transit departure time",async () => {
  vi.stubGlobal("fetch",vi.fn(async () => ({ok:true,json:async () => ({granted:2})})));
  mock.compute.mockResolvedValue({routes:[{path:[{lat:35,lng:135},{lat:35.01,lng:135.01}]}]});
  await computeGooglePaths([{lat:34,lng:136},{lat:35,lng:135},{lat:35.01,lng:135.01}],"2026-10-14",["09:00","11:00"],new AbortController().signal,"WALKING");
  expect(mock.compute).toHaveBeenCalledTimes(1);
  expect(mock.compute.mock.calls[0][0]).toMatchObject({origin:{lat:35,lng:135},travelMode:"WALKING"});
  expect(mock.compute.mock.calls[0][0]).not.toHaveProperty("departureTime");
});
