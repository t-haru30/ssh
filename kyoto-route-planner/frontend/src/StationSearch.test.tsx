import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StationSearch } from "./StationSearch";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const original = { name: "京都駅", latitude: 35, longitude: 135 };
it("fetches only on explicit search and selects same-name candidates by coordinates", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [
    { name: "中野駅", latitude: 35, longitude: 139, code: "1", prefecture: "東京都", lines: ["中央線"] },
    { name: "中野駅", latitude: 36, longitude: 138, code: "2", prefecture: "長野県", lines: ["別路線"] },
  ] });
  vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  render(<StationSearch label="出発駅" value={original} options={[original]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "駅名で探す" }));
  fireEvent.change(screen.getByLabelText("駅名を入力"), { target: { value: "中野" } });
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "駅を検索" }));
  await screen.findByText(/長野県/);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /中野駅.*長野県/ }));
  expect(onChange).toHaveBeenCalledWith({ name: "中野駅（長野県）", latitude: 36, longitude: 138 }, "長野県");
});
it("cancels without replacing the selected origin and reports provider errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: "認証に失敗しました" }) }));
  const onChange = vi.fn();
  render(<StationSearch label="出発駅" value={original} options={[]} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "駅名で探す" }));
  fireEvent.change(screen.getByLabelText("駅名を入力"), { target: { value: "東京" } });
  fireEvent.click(screen.getByRole("button", { name: "駅を検索" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("認証に失敗"));
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(onChange).not.toHaveBeenCalled();
  expect((screen.getByRole("combobox", { name: "出発駅" }) as HTMLSelectElement).value).toBe("京都駅|35|135");
});
it("keeps the registered select compact and selects by coordinates", () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const onChange = vi.fn();
  render(<StationSearch label="帰着駅" value={original} options={[original, { name: "京都駅", latitude: 36, longitude: 136 }]} onChange={onChange} />);
  expect(screen.queryByLabelText("駅名を入力")).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "帰着駅" }), { target: { value: "京都駅|36|136" } });
  expect(onChange).toHaveBeenCalledWith({ name: "京都駅", latitude: 36, longitude: 136 }, undefined);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("scopes requests and discards results from another prefecture", async () => {
 const fetchMock = vi.fn().mockResolvedValue({ok:true,json:async()=>[
  {name:"中野駅",code:"1",prefecture:"東京都",latitude:35,longitude:139,lines:[]},
  {name:"中野駅",code:"2",prefecture:"長野県",latitude:36,longitude:138,lines:[]}
 ]});
 vi.stubGlobal("fetch",fetchMock);
 const {rerender} = render(<StationSearch label="行き先" value={null} options={[]} onChange={vi.fn()} prefecture={{name:"長野県",code:"20"}} />);
 fireEvent.click(screen.getByRole("button",{name:"駅名で探す"}));
 fireEvent.change(screen.getByLabelText("駅名を入力"),{target:{value:"中野"}});
 fireEvent.click(screen.getByRole("button",{name:"駅を検索"}));
 await screen.findByRole("button",{name:/中野駅.*長野県/});
 expect(screen.queryByRole("button",{name:/中野駅.*東京都/})).toBeNull();
 expect(fetchMock.mock.calls[0][0]).toContain("prefecture_code=20");
 rerender(<StationSearch label="行き先" value={null} options={[]} onChange={vi.fn()} prefecture={{name:"岐阜県",code:"21"}} />);
 expect(screen.queryByRole("button",{name:/中野駅.*長野県/})).toBeNull();
});
