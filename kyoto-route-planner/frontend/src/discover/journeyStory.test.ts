import { expect, it } from "vitest";
import { completeJourneyStory, journeyOverview, stopRecommendation } from "./journeyStory";
import type { DatasetRoute } from "./datasetTypes";
const route = {spots:[
  {place_id:"m",name:"歴史博物館",category:"博物館",role:"stop",reason:"明治の教室を保存しています。",reason_sources:[{title:"公式",url:"https://example.jp"}]},
  {place_id:"l",name:"天ぷらのお店",category:"飲食店",role:"lunch"},
  {place_id:"g",name:"日本庭園",category:"庭園",role:"stop"},
  {place_id:"d",name:"夜の割烹",category:"飲食店",role:"dinner"},
]} as DatasetRoute;
it("describes the whole day including both meals and every destination",() => {
  const overview=journeyOverview(route),full=completeJourneyStory(route);
  for (const spot of route.spots) { expect(overview).toContain(spot.name); expect(full).toContain(spot.name); }
  expect(overview).toContain("天ぷらを楽しむ昼ごはん");
  expect(overview).toContain("夜ごはん");
  expect(full).toContain("明治の教室");
});
it("explains the restaurant's cuisine and its place in the day without inventing a menu or reputation",() => {
  const reason=stopRecommendation(route,1);
  expect(reason.fit).toContain("天ぷらを楽しみたい方の昼ごはん候補");
  expect(reason.fit).toContain("歴史博物館");
  expect(reason.fit).toContain("日本庭園");
  expect(reason.fit).not.toMatch(/人気|絶品|名店|予約不要/);
  expect(reason.unconfirmed).toBe(true);
});
