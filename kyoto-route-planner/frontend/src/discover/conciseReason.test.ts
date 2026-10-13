import { describe, expect, it } from "vitest";
import { conciseReason } from "./conciseReason";

describe("conciseReason", () => {
  it("uses a complete later sentence for the same facility with its name", () => {
    const first = `滋賀県立美術館：小倉遊亀の日本画、志村ふくみの染織、${"地域にゆかりのある作家の作品と".repeat(4)}美術を紹介します。`;
    const second = "滋賀ゆかりの表現と国内外の美術をつなぐコレクションが特色です。";
    expect(conciseReason(`${first}${second} 庭園：池を眺められます。`)).toBe(`滋賀県立美術館：${second}`);
  });
  it("never borrows a short sentence from the next facility", () => {
    const first = `美術館：${"地域にゆかりのある作家の作品と".repeat(6)}美術を紹介します。`;
    expect(conciseReason(`${first} 庭園：池を眺められます。`)).not.toContain("庭園");
  });
  it("stops at pace details before generic category and companion reasons", () => {
    const first = `美術館：${"地域にゆかりのある作家の作品と".repeat(6)}美術を紹介します。`;
    const result = conciseReason(`${first}ゆっくりペースで2か所、各60分滞在。博物館を巡ります。友人で巡る候補として、博物館を選びました。`);
    expect(result).toMatch(/^美術館：/);
    expect(result).not.toContain("博物館");
    expect(result).not.toContain("友人");
  });
  it("uses an existing complete final clause when all sentences are long", () => {
    expect(conciseReason(`美術館：${"さまざまな時代の作家を紹介し".repeat(6)}、近代の日本画を楽しめます。`))
      .toBe("美術館：近代の日本画を楽しめます。");
  });
  it("keeps the actual first attraction and omits subsequent facilities and pace", () => {
    expect(conciseReason("清水寺：舞台から京都の街並みを見渡せます。 庭園：池を眺められます。ゆっくりペースで2か所、各60分滞在。"))
      .toBe("清水寺：舞台から京都の街並みを見渡せます。");
  });
  it("selects the appeal when logistics precede it", () => {
    expect(conciseReason("ゆっくりペースで2か所、各60分滞在。寺院と庭園を巡ります。"))
      .toBe("寺院と庭園を巡ります。");
  });
  it("bounds unusually long sentences without inventing an attraction", () => {
    const full = `清水寺：${"歴史ある建築と庭園".repeat(15)}を楽しめます。`;
    const result = conciseReason(full);
    expect(Array.from(result).length).toBeLessThanOrEqual(60);
    expect(full.startsWith(result.slice(0, -1))).toBe(true);
  });
});
