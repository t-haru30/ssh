"""Station-specific subjects, after the source's name/location checks."""
import re
import unicodedata


def is_station_place(place):
    return bool(
        re.search(r'(?:駅|station)(?:\s*[（(].*[）)])?$', place.name.strip(), re.I)
        or place.category in {'駅', '鉄道駅', 'station', 'train_station', 'subway_station'}
        or place.tags.get('railway') in {'station', 'halt'}
        or place.tags.get('public_transport') == 'station'
    )


def station_photo_score(image, name):
    """Reject food/rolling stock; prefer buildings over small station signs.

    This is a subject preference, never proof of identity or a license. Those
    checks remain in each Wikimedia provider before this function is used.
    """
    text = unicodedata.normalize('NFKC', image.description + ' ' + image.filename).casefold().replace('_', ' ')
    if re.search(
        r'きしめん|うどん|蕎麦|駅弁|天ぷら|天麩羅|ラーメン|定食|料理|メニュー|丼|食事|'
        r'きし麺|寿司|喫茶|ソフトクリーム|銅像|彫刻|切符|乗車券|入場券|'
        r'\b(?:kishimen|tempura|udon|bento|ramen|sushi|noodles?|meal|dish|menu|restaurant|cafe|coffee|statue|sculpture)\b|'
        r'\btickets?\b', text,
    ):
        return 0
    target = unicodedata.normalize('NFKC', name).casefold()
    if target not in text and re.search(r'[一-龥ぁ-んァ-ヶー]{2,}駅', text):
        return 0
    if re.search(r'signage|nameplate|駅名標|発車標|案内板|駅名板', text):
        return 1
    exterior = re.search(r'駅舎|外観|正面|東口|西口|南口|北口|兼六園口|鼓門|もてなしドーム|'
                         r'entrance|exterior|façade|facade|building|view[ _-]+of.*station', text)
    rolling_stock = r'機関車|車両|系電車|列車|train[ -]*(?:set|at|in)\b|rolling[ -]*stock|locomotive|railcar|(?:e\d+|\d+)[ -]*series'
    filename = unicodedata.normalize('NFKC', image.filename).casefold().replace('_', ' ')
    if re.search(rolling_stock, filename) or not exterior and re.search(rolling_stock + r'|新幹線|shinkansen', text):
        return 0
    if exterior:
        return 3
    return 2 if re.search(r'駅|\bstation\b', text) else 0
