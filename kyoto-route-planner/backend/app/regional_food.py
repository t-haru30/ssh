"""Search hints, never evidence that an arbitrary restaurant serves a dish."""
from math import hypot

REGIONS = (
    # Kyoto City Tourism Association: https://global.kyoto.travel/ja/faq/detail.php?faq_id=4016
    (35.0116, 135.7681, ("京料理", "湯豆腐", "おばんざい", "湯葉", "にしんそば")),
    (39.702, 141.136, ("盛岡冷麺", "冷麺", "わんこそば", "じゃじゃ麺")),
    (36.578, 136.648, ("加賀料理", "治部煮", "金沢おでん")),
    (35.410, 136.757, ("鮎料理", "鮎")),
)

def specialties(origin):
    for lat, lon, words in REGIONS:
        if hypot((origin.latitude - lat) * 111, (origin.longitude - lon) * 88) <= 25:
            return words
    return ()

def regional_score(origin, place):
    text = " ".join((place.name, place.category, place.description, *place.tags.values()))
    return int(any(word in text for word in (*specialties(origin), "郷土料理", "ご当地料理", "地元食材")))
