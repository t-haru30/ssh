from datetime import date
import unittest

from app.official_html import Document
from app.official_notices import closure_notice


class ClosureNoticeTests(unittest.TestCase):
    today = date(2026, 10, 13)

    def extract(self, *lines):
        return closure_notice(Document(lines=list(lines)), "大樋美術館", self.today)

    def test_explicit_closure_with_name_in_preceding_sentence(self):
        result = self.extract("大樋美術館：改修工事に伴う臨時休館のお知らせ", "空調改修工事のため", "2026年8月17日〜10月20日まで臨時休館させていただくことになりました。")
        self.assertEqual(result["starts_on"], "2026-08-17")
        self.assertEqual(result["ends_on"], "2026-10-20")
        self.assertIn("2026年8月17日〜2026年10月20日：臨時休館。", result["text"])

    def test_future_year_crossing_and_full_width(self):
        result = self.extract("大樋美術館", "２０２６年１２月２９日～１月３日まで休館します。")
        self.assertEqual(result["ends_on"], "2027-01-03")
        self.assertIsNotNone(self.extract("大樋美術館", "2027年1月1日〜2027年2月1日まで休館します。"))

    def test_rejects_expired_ambiguous_invalid_or_reversed_dates(self):
        for text in ("2025年8月17日〜10月20日まで休館します。", "8月17日〜10月20日まで休館します。", "2026年2月30日〜10月20日まで休館します。", "2026年10月20日〜2026年10月1日まで休館します。"):
            with self.subTest(text=text):
                self.assertIsNone(self.extract("大樋美術館", text))

    def test_rejects_other_facility_partial_closure_and_event_dates(self):
        for lines in (("他館", "2026年8月17日〜10月20日まで休館します。"), ("大樋美術館", "別館ギャラリーは2026年8月17日〜10月20日まで休館します。"), ("大樋美術館", "2026年8月17日〜10月20日まで企画展を開催します。", "休館日は月曜日です。"), ("大樋美術館", "2026年8月17日〜10月20日まで休館しません。")):
            with self.subTest(lines=lines):
                self.assertIsNone(self.extract(*lines))

    def test_last_day_is_retained_and_next_day_is_expired(self):
        doc = Document(lines=["大樋美術館", "2026年8月17日〜10月20日まで休館します。"])
        self.assertIsNotNone(closure_notice(doc, "大樋美術館", date(2026, 10, 20)))
        self.assertIsNone(closure_notice(doc, "大樋美術館", date(2026, 10, 21)))


if __name__ == "__main__":
    unittest.main()
