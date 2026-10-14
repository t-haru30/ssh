import { expect, it } from "vitest";
import { mealError, planMeals } from "./mealPlanning";
import { composeLocalRoutes } from "./discover/dynamicRoutes";
import { routeSelection } from "./routeSelection";
import type { Place } from "./types";

const origin = {name:"駅",latitude:35,longitude:135};
const pool: Place[] = Array.from({length:7},(_,i) => ({...origin,id:String(i),name:`施設${i}`,latitude:35+i*.001,
  category:i<3?"飲食店":"公園",themes:i<3?["food"]:["nature"],description:"",access_point:"",tags:{area:"kyoto"}}));
const conditions = {entry:{id:"kyoto",name:"京都府",prefecture_code:"26",center:[35,135] as [number,number],file:"",route_count:1},origin,theme:"all" as const,course:"full_day" as const,radius:30,crossPrefecture:false,variation:0};
it("keeps three meal roles and a requested time through the offline route and editor handoff", () => {
  const routes=composeLocalRoutes({...conditions,meals:[{kind:"breakfast"},{kind:"lunch",time:"13:00"},{kind:"dinner",time:"18:30"}]},pool);
  expect(routes.length).toBeGreaterThan(0);
  const route=routes[0], preset=routeSelection(route);
  expect(route.spots.filter(s=>s.role!=="stop").map(s=>s.role)).toEqual(["breakfast","lunch","dinner"]);
  const lunch=route.spots.find(s=>s.role==="lunch")!;
  expect(preset.anchorTimes?.[lunch.place_id]).toBe("13:00");
  expect(preset.departureTime).toBe("08:00");
  expect(route.estimated_minutes).toBeLessThanOrEqual(720);
});
it("does not force dinner when no meals are selected", () => {
  const routes=composeLocalRoutes({...conditions,meals:[]},pool);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes.every(r=>r.spots.every(s=>s.role==="stop" && s.category!=="飲食店"))).toBe(true);
});
it("rejects impossible times instead of silently changing the request", () => {
  expect(mealError([{kind:"lunch",time:"15:00"},{kind:"dinner",time:"14:00"}])).not.toBe("");
  const result=planMeals([pool[0],pool[1]],[{kind:"lunch",time:"15:00"},{kind:"dinner",time:"14:00"}],origin,"full_day",()=>75,()=>true);
  expect(result).toBeNull();
});
it("keeps lunch at 12:30 and dinner at 20:30 by starting the full day later", () => {
  const routes=composeLocalRoutes({...conditions,meals:[{kind:"lunch",time:"12:30"},{kind:"dinner",time:"20:30"}]},pool);
  expect(routes.length).toBeGreaterThan(0);
  for(const route of routes){
    const preset=routeSelection(route);
    const lunch=route.spots.find(s=>s.role==="lunch")!,dinner=route.spots.find(s=>s.role==="dinner")!;
    expect(preset.anchorTimes?.[lunch.place_id]).toBe("12:30");
    expect(preset.anchorTimes?.[dinner.place_id]).toBe("20:30");
    expect(preset.departureTime! > "09:00").toBe(true);
    expect(route.estimated_minutes).toBeLessThanOrEqual(720);
  }
});
it("can recommend an unspecified duration around a late dinner", () => {
  const routes=composeLocalRoutes({...conditions,course:"all",meals:[{kind:"dinner",time:"20:30"}]},pool);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes[0].spots.some(s=>s.role==="dinner")).toBe(true);
  expect(routes[0].estimated_minutes).toBeLessThanOrEqual(720);
});
