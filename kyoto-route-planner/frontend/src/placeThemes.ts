import type { Place, Theme } from "./types";

export function isCafe(place: Place): boolean {
  const tags = place.tags ?? {};
  if (tags.amenity === "cafe" || tags.venue_type === "cafe") return true;
  if (["restaurant", "fast_food", "food_court"].includes(tags.amenity)) return false;
  const text = `${place.name} ${place.category}`;
  return /カフェ|喫茶|珈琲|コーヒー|\bcaf[eé]\b|\bcoffee\b/i.test(text) && !/レストラン|食堂|定食/.test(text);
}

export function isMealPlace(place: Place): boolean {
  if (isCafe(place)) return false;
  const text = `${place.name} ${place.category}`;
  return !/アイスクリーム|ソフトクリーム|和菓子|洋菓子|口福堂|ドーナツ|コンビニ|セブン[イー]レブン|ファミリーマート|ローソン|キヨスク|KIOSK/i.test(text)
    && !/市場|商店街/.test(place.category)
    && (["restaurant", "fast_food", "food_court"].includes(place.tags?.amenity ?? "") || place.genre_code?.startsWith("01") === true || /飲食|レストラン|食堂|料理|冷麺|そば|麺|寿司|焼肉|グルメ/.test(text));
}

// Infer each facility's own theme; a lunch stop must not inherit its route's nature theme.
export function facilityThemes(place: Place): Theme[] {
  if (isCafe(place) || isMealPlace(place)) return ["food"];
  const text = `${place.name} ${place.category}`;
  const themes: Theme[] = [];
  if (/寺|神社|神宮|大社|観音|教会/.test(text)) themes.push("temple", "history");
  if (/歴史|史跡|城|博物館|美術館|文化|記念|遺跡/.test(text)) themes.push("history");
  if (/自然|公園|庭園|山|海|湖|滝|展望|植物|動物|水族/.test(text)) themes.push("nature");
  if (/グルメ|飲食|レストラン|カフェ|食堂|料理|喫茶|市場|商店街/.test(text)) themes.push("food");
  return themes;
}


// Keep automatic offline suggestions aligned with backend/app/places.py.
// Explicit selections and saved journeys do not pass through this filter.
const unsuitablePlacePattern = /墓園|墓地|霊園|霊苑|斎場|斎苑|火葬場|葬祭|葬儀|納骨|工場|工業団地|病院|医院|クリニック|診療所|発電所|処理場|清掃センター/;
export function isUnsuitablePlace(place: Place): boolean {
  if (/^(?:北|南|東|西).{0,12}から見た/.test(place.name)) return true;
  if (!unsuitablePlacePattern.test(`${place.name} ${place.category}`)) return false;
  if (/奥の院|奥之院/.test(place.name)) return false;
  const rawSitelinks = place.tags?.sitelinks?.trim() ?? "";
  const sitelinks = /^[+-]?\d+$/.test(rawSitelinks) ? Number(rawSitelinks) : 0;
  return sitelinks < 10;
}

export function scenicPriority(place:Place):number {
  if(!facilityThemes(place).includes("nature"))return 0;
  const tags=place.tags??{};
  return Number(Boolean(tags.wikidata||tags.wikipedia||tags.website))+2*Number(/庭園|国立|県立|植物園|渓谷|滝|湖|海岸|展望台|自然公園|名勝/.test(place.name+place.category));
}
