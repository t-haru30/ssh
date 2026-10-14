"""Grounded soft preferences; user text never changes geographic/time constraints."""
import re
import unicodedata

GROUPS = (
    ("カフェ", "喫茶", "珈琲", "コーヒー", "coffee", "cafe"),
    ("庭園", "日本庭園"), ("美術館", "美術"), ("博物館", "展示"),
    ("神社", "神宮", "大社"), ("寺院", "お寺", "寺めぐり"), ("公園",),
    ("展望", "夜景"), ("温泉",), ("市場", "商店街"), ("城", "城跡"),
    ("冷麺", "盛岡冷麺"), ("わんこそば",), ("じゃじゃ麺",),
    ("天ぷら", "てんぷら", "天麩羅"), ("寿司", "すし", "鮨"),
    ("海鮮", "海鮮丼"), ("おでん",), ("飛騨牛",), ("鮎",), ("工芸", "陶芸"),
    ("動物園", "動物"), ("水族館",), ("植物", "花", "桜"),
)


def normalized(value):
    return unicodedata.normalize("NFKC", value).casefold()


def wish_score(text, place):
    text = normalized(text)
    if not text.strip():
        return 0
    evidence = normalized(f"{place.name} {place.category} {place.description} " + " ".join(place.tags.values()))
    name = normalized(place.name)
    score = 10 if len(name) >= 3 and name in text and not re.search(re.escape(name) + r"(?:に|は|には|を)?(?:行きたくない|行かない|避け|なし|不要)", text) else 0
    for group in GROUPS:
        wanted = [word for word in group if word in text and not re.search(re.escape(word) + r"(?:に|は|には|を)?(?:行きたくない|行かない|避け|なし|不要)", text)]
        if wanted and any(word in evidence for word in group):
            score += 1
    return score
