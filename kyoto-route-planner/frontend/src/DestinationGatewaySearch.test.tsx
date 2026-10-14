import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DestinationGatewaySearch } from "./DestinationGatewaySearch";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("adds independently returned nearby stations and keeps the default available during lookup", async () => {
  const origin = { name: "京都駅", latitude: 34.98585, longitude: 135.75877 };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ places: [{ name: "二条", latitude: 35.01, longitude: 135.74 }] }) });
  vi.stubGlobal("fetch", fetch);
  const change = vi.fn();
  render(<DestinationGatewaySearch area="kyoto" prefecture={{ name: "京都府", code: "26" }} fallback={origin} value={origin} onChange={change} />);
  expect(screen.getByRole("button", { name: "京都駅" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button",{name:"ほかの候補を見る"}));
  fireEvent.click(await screen.findByRole("button", { name: "二条駅" }));
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({ name: "二条駅" });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ area: "kyoto", origin });
});

it("searches additional prefecture stations without changing the selected gateway", async () => {
  const origin = {name:"大阪駅",latitude:34.702,longitude:135.495};
  const places = ["新大阪", "天王寺", "京橋", "難波"].map((name,i)=>({name,latitude:34.71+i*.01,longitude:135.50}));
  const fetch = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({places})})
    .mockResolvedValue({ok:true,json:async()=>({places:[...places,{name:"岸和田",latitude:34.46,longitude:135.37}]})}); vi.stubGlobal("fetch",fetch);
  const change = vi.fn();
  render(<DestinationGatewaySearch area="osaka" prefecture={{name:"大阪府",code:"27"}} fallback={origin} value={origin} onChange={change} />);
  await screen.findByRole("button",{name:"天王寺駅"});
  expect(screen.queryByRole("button",{name:"京橋駅"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"ほかの候補を見る"}));
  expect(change).not.toHaveBeenCalled();
  await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({area:"osaka",origin,expanded:true});
  await screen.findByRole("button",{name:"岸和田駅"});
  fireEvent.click(screen.getByRole("button",{name:"京橋駅"}));
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({name:"京橋駅",latitude:places[2].latitude});
});

it("keeps multiple bundled stations and name search usable after a failed nearby lookup", async () => {
  const origin = { name: "岐阜駅", latitude: 35.4097, longitude: 136.7564 };
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }); vi.stubGlobal("fetch", fetch);
  render(<DestinationGatewaySearch area="gifu" prefecture={{ name: "岐阜県", code: "21" }} fallback={origin} value={origin} onChange={vi.fn()} />);
  expect(screen.getByRole("button",{name:"高山駅"})).toBeTruthy();
  await screen.findByText("ほかの駅は駅名で検索できます。");
  expect(screen.queryByRole("button",{name:"周辺の駅を再検索"})).toBeNull();
  expect(screen.getByRole("button", { name: "駅名で探す" })).toBeTruthy();
});

it("shows Tokyo gateways immediately while the provider is pending",()=>{
  vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>{})));
  const origin={name:"東京駅",latitude:35.681,longitude:139.767};
  render(<DestinationGatewaySearch area="tokyo" prefecture={{name:"東京都",code:"13"}} fallback={origin} value={origin} onChange={vi.fn()} />);
  expect(screen.getByRole("button",{name:"新宿駅"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"上野駅"})).toBeTruthy();
});
