"""Search hints, never evidence that an arbitrary restaurant serves a dish."""
from math import hypot

REGIONS = (
    # Kyoto City Tourism Association: https://global.kyoto.travel/ja/faq/detail.php?faq_id=4016
    (35.0116, 135.7681, ("京料理", "湯豆腐", "おばんざい", "湯葉", "にしんそば")),
    # https://www.odette.or.jp/?page_id=5192
    (39.702, 141.136, ("盛岡冷麺", "冷麺", "わんこそば", "じゃじゃ麺")),
    # https://www.kanazawa-kankoukyoukai.or.jp/article/detail_36.html
    (36.578, 136.648, ("金沢おでん", "加賀料理", "治部煮", "金沢カレー", "ハントンライス", "海鮮丼")),
    # https://www.gifucvb.or.jp/sightseeing/food_02.php
    (35.410, 136.757, ("鮎料理", "飛騨牛", "鮎")),
)

def specialties(origin):
    for lat, lon, words in REGIONS:
        if hypot((origin.latitude - lat) * 111, (origin.longitude - lon) * 88) <= 25:
            return words
    return ()

def regional_score(origin, place):
    text = " ".join((place.name, place.category, place.description, *place.tags.values()))
    return int(any(word in text for word in (*specialties(origin), "郷土料理", "ご当地料理", "地元食材")))


def specialty_queries(origin, variation=0):
    """Two distinct dishes, rotating on explicit regeneration without more calls."""
    words = []
    for word in specialties(origin):
        if not any(word in previous or previous in word for previous in words):
            words.append(word)
    if not words:
        return ["郷土料理 ご当地グルメ"]
    start = variation % len(words)
    return (words[start:] + words[:start])[:2]
