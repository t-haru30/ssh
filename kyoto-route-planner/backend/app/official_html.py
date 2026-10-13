"""Small, dependency-free parser for labelled official visitor information."""

from dataclasses import dataclass, field
from html.parser import HTMLParser
import re
import unicodedata


@dataclass
class Document:
    title: str = ""
    meta: str = ""
    identity_text: str = ""
    lines: list[str] = field(default_factory=list)
    links: list[tuple[str, str]] = field(default_factory=list)
    opening_hours: str | None = None
    closed_days: str | None = None
    admission: str | None = None
    redirect_url: str | None = None


LABELS = (
    r"開館時間|営業時間|開園・開場時間|開園時間|開場時間|拝観時間|参拝時間|ギャラリー観覧時間|観覧時間|開館時刻|開館日時|開館(?![^:：】\]\s])",
    r"休館日|休業日|定休日|休園日|休館について",
    r"観覧料金|観覧料|入館料|入場料|拝観料|利用料金|入園料|料金",
)
LABEL = re.compile("(" + "|".join(LABELS) + ")")
STOP = re.compile(r"^(?:アクセス|所在地|交通案内|地図|お問い合わせ|共通券|ボランティア|ガイド[・／/]|添乗員|駐車|関連リンク|イベント|催し|講座|ワークショップ|利用時間|開館日|開館期間|電話|TEL|FAX|住所|ミュージアムショップ|カフェ)", re.I)
NEWS_DATE = re.compile(r"^\[?\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*\]?(?:\s|$)")
TIME_RANGE = re.compile(r"\d{1,2}\s*(?::\s*\d{2}|時)(?:\s*\d{1,2}分)?\s*(?:から|～|〜|~|－|−|—|-|–)\s*(?:午[前後]\s*)?\d{1,2}\s*(?::\s*\d{2}|時)")
CLOSED_VALUE = re.compile(r"[月火水木金土日]曜|年末|年始|祝日|無休|不定休|不定期|臨時休館|展示替|展示換|\d+月\d+日|ありません|なし")
CALENDAR_VALUE = re.compile(r"^(?:休館日[：:】\s]*)?(?:開館|年間|スケジュール)?カレンダー.*(?:確認|参照)")
AUXILIARY = re.compile(r"ショップ|カフェ|レストラン|売店|駐車場|図書室|図書閲覧室")


def _valid_value(value: str, kind: int) -> bool:
    normal = unicodedata.normalize("NFKC", value)
    if kind == 0:
        return bool(TIME_RANGE.search(normal))
    if kind == 1:
        return bool(CLOSED_VALUE.search(normal) or CALENDAR_VALUE.search(normal))
    return bool(re.search(r"\d[\d,]*\s*円|無料", normal))


def _clean(text: str) -> str:
    return " ".join(text.split())


def _heading(line: str) -> tuple[int | None, str]:
    match = re.match(r"\ue000([1-6])\ue001", line)
    return (int(match[1]), line[match.end():]) if match else (None, line)


class _Parser(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg"}
    CHROME = {"nav", "footer", "header"}
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    BREAK = {"p", "div", "section", "article", "li", "dt", "dd", "tr", "td", "th", "br", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.parts: list[str] = []
        self.identity: list[str] = []
        self.title: list[str] = []
        self.meta = ""
        self.redirect_url = None
        self.links: list[tuple[str, str]] = []
        self.anchor = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        skipped = any(t in self.SKIP for t in self.stack)
        chrome = any(t in self.CHROME for t in self.stack) or tag in self.CHROME
        if not skipped:
            if tag == "meta" and (attrs.get("name", "").lower() == "description" or attrs.get("property", "").lower() == "og:description"):
                self.meta = attrs.get("content", "")
            if tag == "meta" and attrs.get("http-equiv", "").strip().lower() == "refresh" and self.redirect_url is None:
                refresh = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*;\s*url\s*=\s*(.+?)\s*", attrs.get("content", ""), re.I)
                if refresh and float(refresh.group(1)) <= 5:
                    target = refresh.group(2)
                    if len(target) >= 2 and target[0] == target[-1] and target[0] in "\"'":
                        target = target[1:-1].strip()
                    if target:
                        self.redirect_url = target
            if tag == "a" and attrs.get("href"):
                self.anchor = (attrs["href"], [])
            if tag == "img" and attrs.get("alt"):
                alt = attrs["alt"]
                self.identity.append(alt)
                if self.anchor:
                    self.anchor[1].append(alt)
                if not chrome:
                    self.parts.append(alt)
            if not chrome and tag in self.BREAK:
                self.parts.append("\n")
                if re.fullmatch(r"h[1-6]", tag):
                    self.parts.append(f"\ue000{tag[1]}\ue001")
        if tag not in self.VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "a" and self.anchor:
            self.links.append((self.anchor[0], _clean(" ".join(self.anchor[1]))))
            self.anchor = None
        if not any(t in self.SKIP | self.CHROME for t in self.stack) and tag in self.BREAK:
            self.parts.append("\n")
        if tag in self.stack:
            index = len(self.stack) - 1 - self.stack[::-1].index(tag)
            del self.stack[index:]

    def handle_data(self, data):
        if any(t in self.SKIP for t in self.stack):
            return
        self.identity.append(data)
        if self.anchor:
            self.anchor[1].append(data)
        if "title" in self.stack:
            self.title.append(data)
        elif not any(t in self.CHROME for t in self.stack) and "head" not in self.stack:
            self.parts.append(data)


def _decode(body: bytes, headers: dict) -> str:
    content_type = next((str(v) for k, v in headers.items() if k.lower() == "content-type"), "")
    match = re.search(r"charset\s*=\s*[\"']?([\w-]+)", content_type, re.I)
    if not match:
        match = re.search(r"charset\s*=\s*[\"']?([\w-]+)", body[:8192].decode("ascii", "ignore"), re.I)
    encodings = [match.group(1)] if match else ["utf-8", "cp932", "euc-jp"]
    for encoding in encodings:
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            pass
    return body.decode("utf-8", "replace")


def _extract(lines: list[str], kind: int) -> str | None:
    # Old table layouts add spaces between label characters for alignment.
    for label in ("|".join(LABELS)).split("|"):
        if "(?" in label:
            continue
        pattern = r"\s*".join(map(re.escape, label))
        lines = [re.sub(pattern, label, line) for line in lines]
    candidates = []
    event_section = False
    news_section = False
    auxiliary_level = None
    for index, line in enumerate(lines):
        level, line = _heading(line)
        heading = level is not None
        if heading and auxiliary_level is not None and level <= auxiliary_level:
            auxiliary_level = None
        if heading and AUXILIARY.search(line) and not _valid_value(line, kind):
            auxiliary_level = level
        elif re.match(r"^(?:ミュージアムショップ|ショップ|カフェ|レストラン|売店|図書室|図書閲覧室)(?:$|[「（(\s])", line):
            # Some guides style subfacility headings using spans instead of h*.
            auxiliary_level = 7
        if heading and not re.fullmatch("(?:" + "|".join(LABELS) + ")", line):
            event_section = bool(re.search(r"イベント|講座|催し|ワークショップ", line))
            news_section = bool(re.search(r"ニュース|お知らせ|新着|トピックス|NEWS", line, re.I))
        if NEWS_DATE.match(unicodedata.normalize("NFKC", line)):
            news_section = True
        if STOP.search(line.lstrip("【［[●◎■ ")):
            continue
        matches = list(LABEL.finditer(line))
        for number, match in enumerate(matches):
            if line[:match.start()].strip(" ：:・/（）()【】［］[]■●◎\ue000") and number == 0:
                continue
            if match.group() == "料金" and match.start() and line[match.start() - 1] not in " ：:・/":
                continue
            if not re.fullmatch(LABELS[kind], match.group()):
                continue
            # A grammatical mention (e.g. "入館料）を改定します") is not a
            # label. Do not borrow a price or free-event notice farther down.
            suffix = line[match.end():].lstrip()
            if match.group() == "開館" and suffix and not re.match(r"[：:】\]]|(?:午[前後]\s*)?\d", suffix):
                continue
            if re.match(r"[）)をがはのにでと]|について|変更|改定|改正|のお知らせ", suffix):
                continue
            if news_section or auxiliary_level is not None:
                continue
            # Bare navigation labels and event schedules are not visitor hours.
            if kind == 0 and event_section:
                continue
            end = matches[number + 1].start() if number + 1 < len(matches) else len(line)
            pieces = [line[match.start():end]]
            if number + 1 == len(matches):
                for following in lines[index + 1:]:
                    following_level, text = _heading(following)
                    next_label = LABEL.search(text)
                    field_boundary = next_label and (next_label.start() == 0 or not re.fullmatch(LABELS[kind], next_label.group()))
                    heading_value = len(pieces) == 1 and _valid_value(text, kind) and not next_label
                    if (following_level is not None and not heading_value) or field_boundary or STOP.search(text.lstrip("【［[●◎■ ")) or NEWS_DATE.match(unicodedata.normalize("NFKC", text)):
                        break
                    if AUXILIARY.search(text):
                        break
                    pieces.append(text)
                    if sum(map(len, pieces)) > 1600:
                        break
            value = _clean(" ".join(pieces)).strip(" :：")
            if _valid_value(value, kind):
                candidates.append(value)
    return " / ".join(dict.fromkeys(candidates)) or None


def parse_document(body: bytes, headers: dict) -> Document:
    """Parse HTML only; callers validate URL, content type and facility identity."""
    parser = _Parser()
    parser.feed(_decode(body, headers))
    lines = [_clean(line) for line in "".join(parser.parts).splitlines() if _clean(line)]
    hours = _extract(lines, 0)
    closures = _extract(lines, 1)
    if not closures and hours and "年中無休" in hours:
        # Some official guides state this explicitly below the hours rather
        # than repeating a closed-days label. Do not infer it from daily hours.
        closures = "年中無休"
    return Document(
        title=_clean("".join(parser.title)), meta=_clean(parser.meta),
        identity_text=_clean(" ".join(parser.identity)),
        lines=[_heading(line)[1] for line in lines], links=parser.links,
        opening_hours=hours, closed_days=closures, admission=_extract(lines, 2),
        redirect_url=parser.redirect_url,
    )

