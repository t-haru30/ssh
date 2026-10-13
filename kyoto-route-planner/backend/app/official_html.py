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
    r"開館時間|営業時間|開園時間|拝観時間|参拝時間|開館時刻|開館日時",
    r"休館日|休業日|定休日|休園日|休館について",
    r"観覧料金|観覧料|入館料|入場料|拝観料|利用料金|入園料|料金",
)
LABEL = re.compile("(" + "|".join(LABELS) + ")")
STOP = re.compile(r"^(?:アクセス|所在地|交通案内|地図|お問い合わせ|共通券|ボランティア|ガイド[・／/]|添乗員|駐車|関連リンク|イベント|催し|講座|ワークショップ)")
NEWS_DATE = re.compile(r"^\[?\s*\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*\]?(?:\s|$)")


def _clean(text: str) -> str:
    return " ".join(text.split())


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
                    self.parts.append("\ue000")
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
        pattern = r"\s*".join(map(re.escape, label))
        lines = [re.sub(pattern, label, line) for line in lines]
    candidates = []
    event_section = False
    news_section = False
    for index, line in enumerate(lines):
        heading = line.startswith("\ue000")
        line = line.lstrip("\ue000")
        if heading and not re.fullmatch("(?:" + "|".join(LABELS) + ")", line):
            event_section = bool(re.search(r"イベント|講座|催し|ワークショップ", line))
            news_section = bool(re.search(r"ニュース|お知らせ|新着|トピックス|NEWS", line, re.I))
        if NEWS_DATE.match(unicodedata.normalize("NFKC", line)):
            news_section = True
        if STOP.search(line):
            continue
        matches = list(LABEL.finditer(line))
        for number, match in enumerate(matches):
            if line[:match.start()].strip(" ：:・/（）()\ue000") and number == 0:
                continue
            if match.group() == "料金" and match.start() and line[match.start() - 1] not in " ：:・/":
                continue
            if not re.fullmatch(LABELS[kind], match.group()):
                continue
            # A grammatical mention (e.g. "入館料）を改定します") is not a
            # label. Do not borrow a price or free-event notice farther down.
            suffix = line[match.end():].lstrip()
            if re.match(r"[）)をがはのにでと]|について|変更|改定|改正|のお知らせ", suffix):
                continue
            if news_section:
                continue
            # Bare navigation labels and event schedules are not visitor hours.
            if kind == 0 and event_section:
                continue
            end = matches[number + 1].start() if number + 1 < len(matches) else len(line)
            pieces = [line[match.start():end]]
            if number + 1 == len(matches):
                for following in lines[index + 1:]:
                    text = following.lstrip("\ue000")
                    next_label = LABEL.search(text)
                    field_boundary = next_label and (next_label.start() == 0 or not re.fullmatch(LABELS[kind], next_label.group()))
                    if following.startswith("\ue000") or field_boundary or STOP.search(text) or NEWS_DATE.match(unicodedata.normalize("NFKC", text)):
                        break
                    pieces.append(text)
                    if sum(map(len, pieces)) > 1600:
                        break
            value = _clean(" ".join(pieces)).strip(" :：")
            normal = unicodedata.normalize("NFKC", value)
            if kind == 0:
                valid = re.search(r"\d{1,2}\s*(?::\s*\d{2}|時)(?:\s*\d{1,2}分)?\s*(?:から|～|〜|~|－|−|—|-|–)\s*(?:午[前後]\s*)?\d{1,2}\s*(?::\s*\d{2}|時)", normal)
            elif kind == 1:
                valid = re.search(r"[月火水木金土日]曜|年末|年始|祝日|無休|不定休|臨時休館|展示替|展示換|\d+月\d+日|ありません|なし", normal)
            else:
                valid = re.search(r"\d[\d,]*\s*円|無料", normal)
            if valid:
                candidates.append(value)
    return " / ".join(dict.fromkeys(candidates)) or None


def parse_document(body: bytes, headers: dict) -> Document:
    """Parse HTML only; callers validate URL, content type and facility identity."""
    parser = _Parser()
    parser.feed(_decode(body, headers))
    lines = [_clean(line) for line in "".join(parser.parts).splitlines() if _clean(line)]
    return Document(
        title=_clean("".join(parser.title)), meta=_clean(parser.meta),
        identity_text=_clean(" ".join(parser.identity)),
        lines=[line.lstrip("\ue000") for line in lines], links=parser.links,
        opening_hours=_extract(lines, 0), closed_days=_extract(lines, 1), admission=_extract(lines, 2),
        redirect_url=parser.redirect_url,
    )

