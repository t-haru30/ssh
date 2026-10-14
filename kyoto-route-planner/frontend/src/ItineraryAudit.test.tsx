import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { auditProposal, ItineraryAudit } from "./ItineraryAudit";
import { newTripStop, scheduleTrip } from "./dayTrip";
import type { RouteSuggestion, RouteTimelineTransit } from "./types";

const origin={name:"駅",latitude:35,longitude:135};
const place={...origin,id:"museum",name:"資料館",category:"博物館",description:"",access_point:"",themes:[]};
const route:RouteSuggestion={origin,places:[place],legs:[],title:null,story:null,total_minutes:20,departure_time:"09:00",arrival_time:null,note:""};
const plan=scheduleTrip({departureTime:"09:00",availableMinutes:360,budget:10000},origin,"2026-10-13",[newTripStop(place,60)],{route,date:"2026-10-13",time:"09:00"});
const leg:RouteTimelineTransit={type:"transit",mode:"public_transport",from_name:"駅",to_name:"資料館",duration_minutes:10,is_estimate:false,fare_yen:200,start_time:null,end_time:null,transit_line:null};
const proposal={stops:[{id:"museum",start:600,end:660}],transits:[leg,{...leg,from_name:"資料館",to_name:"駅"}],return_minute:670,problems:[],unknown:[],reasons:["開館まで待つ"]};
const report={checked_at:"2026-10-13T09:00:00+09:00",checks:[],original:{...proposal,problems:["営業時間外です。"]},proposal,actions:["閉業・営業・移動時間を確認"],note:"取得時点の情報です。"};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it("does not call APIs or mutate the plan until explicitly requested and adopted",async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>report});vi.stubGlobal("fetch",fetcher);
 const adopt=vi.fn();render(<ItineraryAudit plan={plan} onAdopt={adopt}/>);
 expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"営業・移動を確認して修正案を見る"}));
 await screen.findByText("開館まで待つ");expect(adopt).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"この修正案を採用する"}));
 expect(adopt.mock.calls[0][0].stops[0].start).toBe(600);
 expect(adopt.mock.calls[0][0].returnMinute).toBe(670);
 expect(plan.stops[0].start).not.toBe(600);
});
it("rejects deletion or movement of fixed stops, unknown transits and shortened stays",()=>{
 const locked={...plan,stops:plan.stops.map(s=>({...s,locked:true}))};
 expect(()=>auditProposal(locked,proposal)).toThrow();
 expect(auditProposal(plan,{...proposal,transits:[{...leg,is_estimate:true},leg]})).toBeNull();
 expect(()=>auditProposal(plan,{...proposal,stops:[{id:"museum",start:600,end:615}]})).toThrow();
 expect(auditProposal(locked,{...proposal,stops:[]})).toBeNull();
});
it("drops an outdated response when the itinerary changes",async()=>{
 let resolve!:(value:unknown)=>void;
 vi.stubGlobal("fetch",vi.fn(()=>new Promise(r=>{resolve=r;})));
 const view=render(<ItineraryAudit plan={plan} onAdopt={vi.fn()}/>);
 fireEvent.click(screen.getByRole("button",{name:"営業・移動を確認して修正案を見る"}));
 view.rerender(<ItineraryAudit plan={{...plan,date:"2026-10-14"}} onAdopt={vi.fn()}/>);
 await act(async()=>resolve({ok:true,json:async()=>report}));
 expect(screen.queryByRole("button",{name:"この修正案を採用する"})).toBeNull();
});
it("keeps the original when dismissed or when transport is unknown",async()=>{
 const adopt=vi.fn();vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({...report,proposal:null,original:{...report.original,unknown:["移動時間未確認"]}})}));
 render(<ItineraryAudit plan={plan} onAdopt={adopt}/>);
 fireEvent.click(screen.getByRole("button",{name:"営業・移動を確認して修正案を見る"}));
 await screen.findByText("移動時間未確認");
 expect(screen.queryByRole("button",{name:"この修正案を採用する"})).toBeNull();expect(adopt).not.toHaveBeenCalled();
});
it("reports timeout and supports cancellation without adoption",async()=>{
 vi.stubGlobal("fetch",vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("abort"))))));
 const adopt=vi.fn();render(<ItineraryAudit plan={plan} onAdopt={adopt}/>);
 fireEvent.click(screen.getByRole("button",{name:"営業・移動を確認して修正案を見る"}));
 fireEvent.click(screen.getByRole("button",{name:"確認を中止"}));
 await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("元の旅程は変更していません"));expect(adopt).not.toHaveBeenCalled();
});
