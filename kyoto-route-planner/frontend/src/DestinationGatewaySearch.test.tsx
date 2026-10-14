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
  expect(screen.getByRole("option", { name: "京都駅" })).toBeTruthy();
  await screen.findByRole("option", { name: "二条駅" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "二条駅|35.01|135.74" } });
  expect(change.mock.calls.at(-1)?.[0]).toMatchObject({ name: "二条駅", latitude: 35.01 });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ area: "kyoto", origin });
});

it("leaves station-name search usable and allows retry after a failed nearby lookup", async () => {
  const origin = { name: "岐阜駅", latitude: 35.4097, longitude: 136.7564 };
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }); vi.stubGlobal("fetch", fetch);
  render(<DestinationGatewaySearch area="gifu" prefecture={{ name: "岐阜県", code: "21" }} fallback={origin} value={origin} onChange={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "周辺の駅を再検索" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "駅名で探す" })).toBeTruthy();
});
