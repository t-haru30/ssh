import type { Origin, Place, Theme } from "../types";
import { distanceKm } from "../dayTrip";
import { facilityThemes } from "../placeThemes";

type Context = { places: Place[]; origin: Origin; theme: Theme; stayMinutes?: number };
const themeReasons: Partial<Record<Theme, string>> = {
  history: "歴史や文化に触れたい気分に合わせた立ち寄り先です。",
  temple: "寺社を訪ねる旅の立ち寄り先として選びました。",
  nature: "自然や景色を楽しむ旅の立ち寄り先として選びました。",
  food: "食事やひと休みを楽しむ旅の立ち寄り先として選びました。",
};

/** Explain the actual selection and geography without inventing facility-specific facts. */
export function placeRecommendation(place: Place, { places, origin, theme, stayMinutes }: Context): string[] {
  const reasons: string[] = [];
  const ownThemes = facilityThemes(place);
  const reason = themeReasons[theme];
  if (reason && ownThemes.includes(theme)) reasons.push(reason);
  else if (ownThemes.includes("food")) reasons.push("移動の合間に食事や休憩を入れられるよう、ルートに組み込みました。");
  else if (/博物館|美術館|記念館|資料館/.test(place.category)) reasons.push("展示を通して地域の文化に触れる時間を、街歩きに加えられます。");
  else reasons.push(`今回の旅で、${place.name}を訪ねる立ち寄り候補です。`);
  const index = places.findIndex(candidate => candidate.id === place.id);
  const previous = index > 0 ? places[index - 1] : index === 0 ? origin : null;
  if (previous) {
    const distance = distanceKm(previous, place);
    if (Number.isFinite(distance)) {
      const formatted = distance < 1 ? `${Math.max(10, Math.round(distance * 1000 / 10) * 10)}m` : `${distance.toFixed(1)}km`;
      reasons.push(`${previous.name}から直線で約${formatted}。${distance <= 1.5 ? "近いエリアの立ち寄り先をつないでいます。" : "移動時間は経路を確認して調整しましょう。"}`);
    }
  }
  if (stayMinutes !== undefined && stayMinutes > 0) reasons.push(`${stayMinutes}分の滞在を見込んだプランです。見学や休憩の長さは、旅の編集画面で調整できます。`);
  return reasons;
}
