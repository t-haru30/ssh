export type TravelPace = "relaxed" | "standard" | "packed";
export const PACE_OPTIONS = [{ value: "relaxed", label: "ゆったり" }, { value: "standard", label: "標準" }, { value: "packed", label: "たくさん巡る" }] as const;
export const PACE_SETTINGS = { relaxed: { maxStops: 2, stay: 75, fullDayStay: 120 }, standard: { maxStops: 3, stay: 60, fullDayStay: 105 }, packed: { maxStops: 4, stay: 45, fullDayStay: 75 } } as const;
export function normalizeTravelPace(pace: unknown): TravelPace { return PACE_OPTIONS.some(option => option.value === pace) ? pace as TravelPace : "standard"; }
export type TravelerProfile = {
  pace?: TravelPace;
  age_group: "unspecified" | "under_18" | "18_29" | "30_49" | "50_64" | "65_plus";
  gender: "unspecified" | "female" | "male" | "other";
  companion: "unspecified" | "family" | "friends" | "couple" | "solo";
};
export const EMPTY_TRAVELER_PROFILE: TravelerProfile = { age_group: "unspecified", gender: "unspecified", companion: "unspecified", pace: "standard" };
export const TRAVELER_PROFILE_KEY = "traveler-profile-v1";
export const AGE_OPTIONS = [{ value: "unspecified", label: "指定しない" }, { value: "under_18", label: "18歳未満" }, { value: "18_29", label: "18〜29歳" }, { value: "30_49", label: "30〜49歳" }, { value: "50_64", label: "50〜64歳" }, { value: "65_plus", label: "65歳以上" }] as const;
export const GENDER_OPTIONS = [{ value: "unspecified", label: "指定しない" }, { value: "female", label: "女性" }, { value: "male", label: "男性" }, { value: "other", label: "その他" }] as const;
export const COMPANION_OPTIONS = [{ value: "unspecified", label: "指定しない" }, { value: "family", label: "家族と" }, { value: "friends", label: "友人と" }, { value: "couple", label: "パートナーと" }, { value: "solo", label: "ひとりで" }] as const;
function validate(value: unknown): TravelerProfile | null {
  if (!value || typeof value !== "object") return null;
  const p = value as TravelerProfile;
  if (!AGE_OPTIONS.some(o => o.value === p.age_group) || !GENDER_OPTIONS.some(o => o.value === p.gender) || !COMPANION_OPTIONS.some(o => o.value === p.companion)) return null;
  return { age_group: p.age_group, gender: p.gender, companion: p.companion, pace: normalizeTravelPace(p.pace) };
}
export function readTravelerProfile(): TravelerProfile {
  try { return validate(JSON.parse(localStorage.getItem(TRAVELER_PROFILE_KEY) ?? "null")) ?? { ...EMPTY_TRAVELER_PROFILE }; }
  catch { return { ...EMPTY_TRAVELER_PROFILE }; }
}
export function saveTravelerProfile(profile: TravelerProfile): void {
  const validated = validate(profile);
  if (!validated) return;
  try { localStorage.setItem(TRAVELER_PROFILE_KEY, JSON.stringify(validated)); } catch { /* Private browsing or full storage: selection remains usable in memory. */ }
}
export function travelerProfileSummary(profile: TravelerProfile): string {
  const labels = [COMPANION_OPTIONS.find(o => o.value === profile.companion)?.label, AGE_OPTIONS.find(o => o.value === profile.age_group)?.label, GENDER_OPTIONS.find(o => o.value === profile.gender)?.label].filter(label => label && label !== "指定しない");
  return labels.length ? labels.join("・") : "指定なし";
}
