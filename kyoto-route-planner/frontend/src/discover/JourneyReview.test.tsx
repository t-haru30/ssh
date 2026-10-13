import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { JourneyReview, isJourneyReview, type JourneyReviewData } from "./JourneyReview";
import { composeLocalRoutes } from "./dynamicRoutes";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const route = composeLocalRoutes({entry:{id:"kyoto",name:"京都府",prefecture_code:"26",center:[35,135],file:"kyoto.json",route_count:1},origin:{name:"京都駅",latitude:35,longitude:135},theme:"all",course:"all",radius:30,crossPrefecture:false,variation:0},
  [{id:"one",name:"博物館",category:"博物館",description:"",access_point:"",themes:["history"],latitude:35.001,longitude:135,tags:{area:"kyoto"}}])[0];
const report: JourneyReviewData = {id:"a".repeat(32), status:"proposal",recorded:true,issues:["飲食店が連続しています。"],actions:["施設を組み直しました。"],unresolved:[],limitations:"営業時間と実際の交通は未確認です。",proposals:[{original_id:"original",original_title:"元の旅",original_stops:["食堂A","食堂B"],original_minutes:200,reasons:["飲食店が連続しています。"],route}]};
it("shows comparison, applies only on adoption, and restores the original", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ok:true}); vi.stubGlobal("fetch",fetchMock);
  const onAdopt = vi.fn(), onRestore = vi.fn();
  render(<JourneyReview report={report} onAdopt={onAdopt} onRestore={onRestore} />);
  expect(screen.getByText("食堂A → 食堂B")).toBeTruthy();
  expect(screen.getByText("博物館")).toBeTruthy();
  expect(onAdopt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"変更案を採用して見る"}));
  expect(onAdopt).toHaveBeenCalledWith(route);
  await screen.findByText("選択を判断履歴に記録しました。");
  fireEvent.click(screen.getByRole("button",{name:"元の旅程を使う"}));
  expect(onRestore).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[1][0]).toContain("decision=keep");
});
it("keeps adoption functional when recording fails", async () => {
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error()));
  const onAdopt = vi.fn();
  render(<JourneyReview report={report} onAdopt={onAdopt} onRestore={vi.fn()} />);
  fireEvent.click(screen.getByRole("button",{name:"変更案を採用して見る"}));
  await screen.findByText("操作は反映しました。判断履歴は保存できませんでした。");
  expect(onAdopt).toHaveBeenCalledOnce();
});
it("rejects malformed proposals and reports unresolved without offering adoption", () => {
  expect(isJourneyReview(report)).toBe(true);
  expect(isJourneyReview({...report,proposals:[{...report.proposals[0],route:{}}]})).toBe(false);
  render(<JourneyReview report={{...report,status:"unresolved",proposals:[],unresolved:["候補が足りません。"]}} onAdopt={vi.fn()} onRestore={vi.fn()} />);
  expect(screen.queryByRole("button",{name:"変更案を採用して見る"})).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("未解決");
});
