import type { Place, Preference } from "./types";

export const PREFERENCE_OPTIONS: { value: Preference; label: string }[] = [
  { value: "nature", label: "自然" }, { value: "culture", label: "文化・歴史" },
  { value: "food", label: "食事" }, { value: "coffee", label: "カフェ" },
  { value: "shopping", label: "買い物" },
];

export function isPreference(value: unknown): value is Preference {
  return PREFERENCE_OPTIONS.some(option => option.value === value);
}

// Only catalog themes, category and name are evidence. Descriptions may contain
// unrelated recommendations and must not create a match for the place itself.
export function preferenceMatches(place: Place): Preference[] {
  const text = `${place.category} ${place.name}`.toLowerCase();
  const matches: Preference[] = [];
  if (place.themes.includes("nature") || /公園|庭園|自然|森林|海岸|湖|滝|渓谷|植物園|park|garden/.test(text)) matches.push("nature");
  if (place.themes.some(theme => theme === "history" || theme === "temple") || /文化|史跡|博物館|美術館|寺|神社|大社|城|資料館|museum|temple|shrine/.test(text)) matches.push("culture");
  if (place.themes.includes("food") || /飲食店|レストラン|食堂|料理|ラーメン|寿司|restaurant/.test(text)) matches.push("food");
  if (/カフェ|喫茶|珈琲|コーヒー|café|cafe|coffee/.test(text)) matches.push("coffee");
  if (/買い物|商店|市場|ショッピング|百貨店|土産|shopping|market|mall/.test(text)) matches.push("shopping");
  return matches;
}

export function preferenceReason(place: Place, preferences: Preference[] = []): string {
  const matches = preferenceMatches(place).filter(preference => preferences.includes(preference));
  if (!matches.length) return preferences.length
    ? `登録カテゴリ「${place.category}」の候補です。選んだ好みに直接当てはまる登録情報はありません。`
    : `登録カテゴリ「${place.category}」の候補です。発着地や使える時間に合わせて検討できます。`;
  const categoryMatches = preferenceMatches({ ...place, name: "", themes: [] });
  const nameMatches = preferenceMatches({ ...place, category: "", themes: [] });
  const evidence = [...new Set(matches.map(preference => categoryMatches.includes(preference)
    ? `登録カテゴリ「${place.category}」` : nameMatches.includes(preference) ? `名称「${place.name}」` : "登録テーマ"))];
  return `${evidence.join("・")}をもとに、希望の${PREFERENCE_OPTIONS.filter(option => matches.includes(option.value)).map(option => option.label).join("・")}に合う候補として選びました。`;
}
