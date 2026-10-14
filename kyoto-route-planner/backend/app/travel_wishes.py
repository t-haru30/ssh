"""Grounded soft preferences; user text never changes geographic/time constraints."""
import re
import unicodedata

GROUPS = (
    ("カフェ", "喫茶", "珈琲", "コーヒー", "coffee", "cafe", "café"),
    ("庭園", "日本庭園"), ("美術館", "美術"), ("博物館", "展示"),
    ("神社", "神宮", "大社"), ("寺院", "お寺", "寺めぐり"), ("公園",),
    ("展望", "夜景"), ("温泉",), ("市場", "商店街"), ("城", "城跡"),
    ("冷麺", "盛岡冷麺"), ("わんこそば",), ("じゃじゃ麺",),
    ("天ぷら", "てんぷら", "天麩羅"), ("寿司", "すし", "鮨"),
    ("海鮮", "海鮮丼"), ("おでん",), ("飛騨牛",), ("鮎",), ("工芸", "陶芸"),
    ("動物園", "動物"), ("水族館",), ("植物", "花", "桜"),
    ("体験", "ワークショップ", "工房"), ("買い物", "ショッピング", "土産"), ("甘味", "スイーツ", "和菓子", "ケーキ"),
)


def normalized(value):
    return unicodedata.normalize("NFKC", value).casefold()


def avoided(text, word):
    return re.search(re.escape(word) + r"(?:に|は|には|を)?(?:行きたくない|行かない|寄らない|避け|なし|不要)", text)


def requested_wishes(text):
    text = normalized(text)
    return [group[0] for group in GROUPS if any(word in text and not avoided(text, word) for word in group)]


def wish_queries(text):
    """At most two parallel keyword searches within the existing lookup budget."""
    topics = requested_wishes(text)
    if topics:
        return topics[:2]
    if any(word in normalized(text) and avoided(normalized(text), word) for group in GROUPS for word in group):
        return []
    phrase = re.split(r"[\n。！!?？]", text.strip(), maxsplit=1)[0]
    phrase = re.sub(r"(?:に行きたい|に寄りたい|を見たい|を訪れたい|へ行きたい|に行く|をお願いします)[ですます]*$", "", phrase)
    return [phrase[:60]] if len(phrase) >= 2 else []


def wish_matches(text, place):
    text = normalized(text)
    if not text.strip():
        return set()
    evidence = normalized(f"{place.name} {place.category} {place.description} " + " ".join(place.tags.values()))
    name = normalized(place.name)
    matches = {"place:" + name} if len(name) >= 3 and name in text and not avoided(text, name) else set()
    for group in GROUPS:
        wanted = [word for word in group if word in text and not avoided(text, word)]
        if wanted and any(word in evidence for word in group):
            matches.add(group[0])
    return matches


def wish_score(text, place):
    return sum(10 if word.startswith("place:") else 1 for word in wish_matches(text, place))


def wish_coverage(text, places):
    return sum(10 if word.startswith("place:") else 1 for word in set().union(*(wish_matches(text, p) for p in places)))
