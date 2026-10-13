"""Conservative extraction of explicitly dated whole-facility closures."""

from datetime import date
import re
import unicodedata

from app.official_html import Document


_RANGE = re.compile(
    r"(?P<sy>\d{4})年\s*(?P<sm>\d{1,2})月\s*(?P<sd>\d{1,2})日"
    r"(?:\s*[（(][^）)]{1,8}[）)])?\s*(?:～|〜|~|から|－|−|—|–|-)\s*"
    r"(?:(?P<ey>\d{4})年\s*)?(?P<em>\d{1,2})月\s*(?P<ed>\d{1,2})日"
)
_CLOSURE = re.compile(r"(?:臨時)?休館(?:いた|致|させ|し|します|です|とな|とさ|を|予定|期間|中|[。．.:：]|$)")
_PARTIAL = re.compile(r"別館|ギャラリー|展示室|一部|分館|カフェ|ショップ|売店")


def _normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())


def closure_notice(document: Document, place_name: str, today: date) -> dict | None:
    """Return dates only when a local named-facility closure states both ends.

    URL ownership and authenticity remain the caller's responsibility. A future
    notice is retained; this function does not decide whether a visit is possible.
    """
    name = _normalized(place_name).replace(" ", "")
    if len(name) < 2:
        return None
    lines = [_normalized(line) for line in document.lines]
    for index, line in enumerate(lines):
        for match in _RANGE.finditer(line):
            # Dates and closure wording must share the same immediate sentence.
            after = line[match.end():]
            tail = re.split(r"[。．!?！？]", after, maxsplit=1)[0]
            next_line = lines[index + 1] if index + 1 < len(lines) else ""
            closure_text = tail or next_line
            if not _CLOSURE.search(closure_text):
                continue
            context = " ".join(lines[max(0, index - 2):index + 1])
            if name not in context.replace(" ", ""):
                continue
            # An institution's shared heading does not make a gallery/shop
            # closure a closure of the institution itself.
            if _PARTIAL.search(context + " " + closure_text):
                continue
            if re.search(r"休館(?:しません|いたしません|ではありません)|休館日を除", closure_text):
                continue
            try:
                start = date(int(match["sy"]), int(match["sm"]), int(match["sd"]))
                end_year = int(match["ey"]) if match["ey"] else start.year
                end_month, end_day = int(match["em"]), int(match["ed"])
                if not match["ey"] and (end_month, end_day) < (start.month, start.day):
                    end_year += 1
                end = date(end_year, end_month, end_day)
            except ValueError:
                continue
            if end < start or end < today:
                continue
            return {
                "starts_on": start.isoformat(), "ends_on": end.isoformat(),
                "text": f"{start.year}年{start.month}月{start.day}日〜{end.year}年{end.month}月{end.day}日：臨時休館。最新の案内は公式告知でご確認ください。",
            }
    return None
