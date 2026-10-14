import type { DatasetRoute, DatasetSpot } from "./datasetTypes";
import { categoryArtwork } from "./categoryArtwork";
import type { GoogleVenueInfo } from "./useGoogleVenueInfo";

const mealLabels = { breakfast: "朝ごはん", lunch: "昼ごはん", dinner: "夜ごはん" };
const experiences: Record<string, string> = {
  "和食・日本料理": "和食", "天ぷら": "天ぷら", "寿司": "寿司", "ラーメン": "ラーメン", "そば": "そば", "焼肉": "焼肉",
  "カフェ": "カフェでの休憩", "和菓子・甘味": "甘いもの", "博物館": "展示を通した歴史や文化との出会い", "美術館": "作品の鑑賞",
  "寺院": "寺院の建築と境内の散策", "神社": "参拝と境内の散策", "日本庭園": "庭園の景色", "自然・公園": "自然の中の散策",
  "城・史跡": "歴史ある建物や史跡の見学", "街歩き": "街歩き", "飲食店": "食事",
};
function genre(spot: DatasetSpot, info?: GoogleVenueInfo) {
  return categoryArtwork({id:spot.place_id,name:spot.name,category:`${spot.category} ${info?.category ?? ""} ${info?.primary_type ?? ""}`,tags:spot.tags,latitude:spot.lat,longitude:spot.lng,description:"",access_point:"",themes:[]}).label;
}
export function journeyOverview(route: DatasetRoute, infos: GoogleVenueInfo[] = []): string {
  return route.spots.map((spot, index) => {
    const kind = genre(spot, infos.find(info => info.place_id === spot.place_id)), experience = experiences[kind];
    const meal = spot.role !== "stop" && spot.role !== "break" ? mealLabels[spot.role] : null;
    const lead = spot.role === "breakfast" ? "朝は" : spot.role === "lunch" ? "お昼は" : spot.role === "dinner" ? "一日の締めくくりは" : index === 0 ? "まずは" : "続いて";
    return spot.role === "break" ? `${lead}${spot.name}で30分ほどひと休みします。` : meal ? `${lead}${spot.name}で${kind === "飲食店" ? meal : `${experience}を楽しむ${meal}`}。`
      : `${lead}${spot.name}で${experience}を楽しみます。`;
  }).join("");
}
export function stopRecommendation(route: DatasetRoute, index: number, info?: GoogleVenueInfo): { fit: string; facts: string; unconfirmed: boolean } {
  const spot = route.spots[index], kind = genre(spot, info);
  const previous = route.spots[index - 1], next = route.spots[index + 1];
  const meal = spot.role !== "stop" && spot.role !== "break" ? mealLabels[spot.role] : null;
  const fit = meal
    ? `${kind === "飲食店" ? "観光と食事をどちらも楽しむための" : `${experiences[kind]}を楽しみたい方の`}${meal}候補です。${previous ? `${previous.name}のあとに食事の時間をとり、` : ""}${next ? `${next.name}へつなぐ組み合わせです。` : "食事で一日を締めくくる組み合わせです。"}`
    : `${experiences[kind]}を楽しむ立ち寄り先として選びました。${next ? `このあとは${next.name}へ。違う楽しみをつなぎ、一日を組み立てています。` : "最後の立ち寄りまで、その土地らしい時間を楽しむプランです。"}`;
  const facts = spot.reason && !/直線約|公式情報を確認できていません/.test(spot.reason) ? spot.reason : "";
  return { fit, facts, unconfirmed: !spot.reason_sources?.length };
}
export function completeJourneyStory(route: DatasetRoute): string {
  return [journeyOverview(route), ...route.spots.map((spot, index) => {
    const {fit, facts} = stopRecommendation(route, index);
    return `${spot.name}：${facts}${fit}`;
  })].join("\n\n");
}
