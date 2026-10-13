import { afterEach, expect, it, vi } from "vitest";
import { currentLocation } from "./currentLocation";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("reports denied permission without requiring GeolocationPositionError globals", async () => {
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (_ok: unknown, fail: (error: { code: number }) => void) => fail({ code: 1 }) } });
  await expect(currentLocation()).rejects.toThrow("許可されていません");
});
it("settles when a browser never calls either callback and allows a later retry", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: vi.fn() } });
  const expected = expect(currentLocation()).rejects.toThrow("タイムアウト");
  await vi.advanceTimersByTimeAsync(16000); await expected;
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: 35, longitude: 135 } }) } });
  await expect(currentLocation()).resolves.toEqual({ latitude: 35, longitude: 135 });
});
