import type { Place } from "../types";

const labels = ["和食・日本料理", "天ぷら", "寿司", "ラーメン", "そば", "焼肉", "カフェ", "和菓子・甘味", "博物館", "美術館", "寺院", "神社", "日本庭園", "自然・公園", "城・史跡", "街歩き"] as const;
type Artwork = { label: string; image: string; columns: number; rows: number; column: number; row: number };

function singleArtwork(label: string, key: string): Artwork {
  return {label, image: `/images/genres/${key}.webp`, columns: 1, rows: 1, column: 0, row: 0};
}

/** Use only the venue's own classification/name/cuisine, never an itinerary's free-text story. */
export function categoryArtwork(place: Place): Artwork {
  const category = `${place.category} ${place.tags?.amenity ?? ""} ${place.tags?.tourism ?? ""} ${place.tags?.shop ?? ""} ${place.tags?.leisure ?? ""} ${place.tags?.natural ?? ""}`.normalize("NFKC");
  const identity = `${place.name} ${category}`.normalize("NFKC");
  const food = `${identity} ${place.tags?.cuisine ?? ""} ${place.tags?.["cuisine:ja"] ?? ""}`;
  const foodVenue = /飲食|レストラン|グルメ|食堂|料理|カフェ|喫茶|甘味|菓子|ベーカリー|パン屋|居酒屋|restaurant|cafe|fast_food|food_court|bakery|izakaya|\b(?:bar|pub)\b/i.test(category)
    || !/博物館|美術館|資料館|寺院|神社|museum|gallery/i.test(category) && /天ぷら|天麩羅|寿司|鮨|ラーメン|蕎麦|そば|うどん|焼肉|喫茶|カフェ|割烹|ベーカリー|パン屋|居酒屋/.test(place.name);
  let index: number;
  if (foodVenue) {
    if (/カフェ|喫茶|cafe|coffee/i.test(category)) index = 6;
    else if (/ベーカリー|パン屋|パン店|bakery/i.test(food)) return singleArtwork("ベーカリー", "bakery-v1");
    else if (/居酒屋|酒場|izakaya/i.test(food)) return singleArtwork("居酒屋", "izakaya-v1");
    else if (/天ぷら|天麩羅|天婦羅|tempura/i.test(food)) index = 1;
    else if (/寿司|鮨|すし|sushi/i.test(food)) index = 2;
    else if (/ラーメン|らーめん|ramen/i.test(food)) index = 3;
    else if (/うどん|饂飩|udon/i.test(food)) return singleArtwork("うどん", "udon-v1");
    else if (/蕎麦|そば|soba/i.test(food)) index = 4;
    else if (/焼肉|焼き肉|yakiniku|barbecue|bbq/i.test(food)) index = 5;
    else if (/和菓子|甘味|団子|大福|wagashi/i.test(food)) index = 7;
    else if (/カフェ|喫茶|コーヒー|coffee|cafe/i.test(food)) index = 6;
    else if (/和食|日本料理|京料理|郷土料理|懐石|会席|割烹|japanese/i.test(food)) index = 0;
    else return {label: "飲食店", image: "/images/category-atlas.png", columns: 3, rows: 2, column: 1, row: 0};
  } else if (/水族館|aquarium/i.test(category)) return singleArtwork("水族館", "aquarium-v1");
  else if (/展望台|展望施設|viewpoint|observation_deck/i.test(category)) return singleArtwork("展望台", "observation-v1");
  else if (/温泉|入浴施設|hot_spring|public_bath/i.test(category)) return singleArtwork("温泉・入浴施設", "onsen-v1");
  else if (/海辺|海岸|海浜|ビーチ|beach|coastline/i.test(category)) return singleArtwork("海辺・海岸", "coast-v1");
  else if (/美術館|アート|gallery|art_museum/i.test(identity)) index = 9;
  else if (/博物館|資料館|記念館|科学館|museum/i.test(identity)) index = 8;
  else if (/水族館|aquarium/i.test(identity)) return singleArtwork("水族館", "aquarium-v1");
  else if (/庭園|神苑|garden/i.test(identity)) index = 12;
  else if (/神社|神宮|大社|稲荷|shrine|shinto/i.test(identity)) index = 11;
  else if (/寺院|寺|観音|temple|buddhist/i.test(identity)) index = 10;
  else if (/城跡|城址|御殿|城(?:$|二|本|天守|公園)|castle/i.test(identity) || /城$/.test(place.name)) index = 14;
  else if (/温泉|hot_spring/i.test(identity)) return singleArtwork("温泉・入浴施設", "onsen-v1");
  else if (/展望台|展望デッキ|viewpoint|observation_deck/i.test(identity)) return singleArtwork("展望台", "observation-v1");
  else if (/海辺|海岸|海浜|ビーチ|beach|coastline/i.test(identity)) return singleArtwork("海辺・海岸", "coast-v1");
  else if (/公園|自然|山|海|川|渓谷|滝|park|nature/i.test(identity)) index = 13;
  else index = 15;
  if (index === 6) {
    // Stable across rerenders and itinerary roles, with some variety by cafe.
    const variant = Array.from(place.name.normalize("NFKC")).reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) >>> 0, 0) % 2;
    if (variant) return singleArtwork(labels[index], "cafe-garden-v1");
  }
  return {label: labels[index], image: "/images/category-detail-atlas-v1.png", columns: 4, rows: 4, column: index % 4, row: Math.floor(index / 4)};
}
