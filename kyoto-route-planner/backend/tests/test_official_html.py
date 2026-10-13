import unittest

from app.official_html import parse_document


def parse(html):
    return parse_document(html.encode(), {"content-type": "text/html; charset=utf-8"})


class OfficialHTMLTests(unittest.TestCase):
    def test_bracketed_bulleted_and_short_visitor_labels(self):
        doc = parse('<p>【開館時間】9:30～16:30（最終入館16:15）</p>'
                    '<p>【休館日】月曜日（月曜が祝日の場合は翌平日）</p><p>【TEL】011-000-0000</p>')
        self.assertIn('9:30～16:30', doc.opening_hours)
        self.assertIn('翌平日', doc.closed_days)
        self.assertNotIn('TEL', doc.closed_days)
        doc = parse('<h2>開館</h2><p>午前10時〜午後5時（入館は4時30分まで）</p>'
                    '<p>●休館日</p><p>毎週月曜日</p>')
        self.assertIn('午前10時', doc.opening_hours)
        self.assertIn('月曜日', doc.closed_days)
        self.assertIsNone(parse('<p>開館した博物館</p><p>9:00～17:00</p>').opening_hours)

    def test_immediate_value_heading_preserves_seasonal_exceptions(self):
        doc = parse('<h2>開館時間</h2><h3>【通年】9時00分から17時00分まで</h3>'
                    '<p>※12月31日は15時閉館</p><h2>休館日</h2><h3>【通年】毎週火曜日</h3>'
                    '<p>ただしＧＷ期間は開館します。</p><h2>イベント</h2><p>10:00～12:00</p>')
        self.assertIn('9時00分', doc.opening_hours)
        self.assertIn('12月31日', doc.opening_hours)
        self.assertNotIn('イベント', doc.opening_hours)
        self.assertIn('ＧＷ期間', doc.closed_days)
        self.assertIsNone(parse('<h2>開館時間</h2><h3>イベント</h3><p>10:00～12:00</p>').opening_hours)

    def test_explicit_irregular_calendar_and_year_round_closures(self):
        for value in ('不定期（館内保守及び大学の定める休日）', 'スケジュールカレンダーでご確認ください。'):
            self.assertIn(value, parse(f'<h2>休館日</h2><p>{value}</p>').closed_days)
        doc = parse('<h2>営業時間</h2><p>10:00～17:00</p><p>年中無休</p>')
        self.assertEqual(doc.closed_days, '年中無休')
        self.assertIsNone(parse('<h2>営業時間</h2><p>毎日10:00～17:00</p>').closed_days)
        self.assertIsNone(parse('<h2>営業時間</h2><p>10:00～17:00</p><h2>ショップ</h2><p>年中無休</p>').closed_days)

    def test_auxiliary_business_hours_never_merge_with_venue_hours(self):
        doc = parse('<h2>開館時間</h2><p>9:30～17:00</p><h2>休館日</h2><p>月曜日</p>'
                    '<h2>ミュージアムショップ</h2><h3>営業時間</h3><p>10:00～16:00</p>'
                    '<h3>定休日</h3><p>火曜日</p><h2>カフェ</h2><p>営業時間：11:00～15:00</p>')
        self.assertEqual(doc.opening_hours, '開館時間 9:30～17:00')
        self.assertEqual(doc.closed_days, '休館日 月曜日')
        self.assertIsNone(parse('<h2>レストラン</h2><h3>営業時間</h3><p>10:00～16:00</p>').opening_hours)
        doc = parse('<dl><dt>ギャラリー観覧時間</dt><dd>9:30～18:00（金曜は20:00まで）</dd>'
                    '<dt>利用時間</dt><dd>ミュージアムカフェ 11:00～18:00</dd></dl>')
        self.assertIn('金曜は20:00', doc.opening_hours)
        self.assertNotIn('カフェ', doc.opening_hours)
        doc = parse('<h2>施設のご案内</h2><p>ミュージアムショップ</p><p>営業時間 10:00～16:00</p>'
                    '<p>カフェ「庭」</p><p>営業時間 11:00～15:00</p><h2>開館時間</h2><p>9:00～17:00</p>')
        self.assertEqual(doc.opening_hours, '開館時間 9:00～17:00')
        self.assertIsNone(parse('<h2>ショップ</h2><h3>サービス</h3><h4>営業時間</h4><p>10:00～16:00</p>').opening_hours)
        doc = parse('<h2>駐車場</h2><h3>開場時間</h3><p>7:00～21:00</p>'
                    '<h2>休館日</h2><p>スケジュールカレンダーでご確認ください。</p>')
        self.assertIn('カレンダー', doc.closed_days)
        self.assertIsNone(doc.opening_hours)
        self.assertIsNone(parse('<p>休館日</p><p>※日付をタップすると詳細が確認できます。</p>'
                                '<p>開館カレンダーはPDFでも公開しています。</p><p>詳しくはご確認ください。</p>').closed_days)

    def test_park_hours_exclude_parking_hours(self):
        doc = parse('<h2>開園・開場時間</h2><table><tr><th>区域</th><th>4月〜11月</th>'
                    '<th>12月〜3月</th></tr><tr><th>無料区域</th><td>8:00～19:30</td><td>8:00～18:30</td></tr>'
                    '<tr><th>有料区域</th><td>8:30～19:00</td><td>8:30～18:00</td></tr></table>'
                    '<h2>駐車場の開場時間</h2><p>7:00～21:00</p>')
        self.assertIn('無料区域', doc.opening_hours)
        self.assertIn('8:30～18:00', doc.opening_hours)
        self.assertNotIn('7:00', doc.opening_hours)

    def test_news_mentions_do_not_borrow_old_free_event_or_hours(self):
        doc = parse('<p>入館料）を改定いたします。</p><p>ご理解をお願いします。</p><p>[ 2022.01.22]</p><p>関西文化の日のお知らせ</p><p>当日は観覧料が無料となります。</p><p>営業時間 10:00～12:00</p>')
        self.assertIsNone(doc.admission)
        self.assertIsNone(doc.opening_hours)
        doc = parse('<h2>ニュース</h2><p>入館料：無料</p><p>営業時間：10:00～12:00</p><h2>ご利用案内</h2><dl><dt>入館料</dt><dd>一般300円</dd></dl>')
        self.assertEqual(doc.admission, '入館料 一般300円')
        self.assertIsNone(doc.opening_hours)

    def test_date_boundary_prevents_cross_article_value(self):
        self.assertIsNone(parse('<p>入館料</p><p>[2022.01.22]</p><p>文化の日は無料</p>').admission)

    def test_short_meta_refresh_target_is_returned_without_execution(self):
        for content, target in [('0;URL=Default.htm', 'Default.htm'), ('5; url=\'../guide.html\'', '../guide.html'), ('0.5; URL=https://example.jp/guide?a=1&amp;b=2', 'https://example.jp/guide?a=1&b=2')]:
            with self.subTest(content=content):
                self.assertEqual(parse(f'<meta HTTP-EQUIV="Refresh" content="{content}">').redirect_url, target)
        for content in ('6;URL=later.htm', '-1;URL=bad.htm', '0;URL=', '0', 'soon;URL=bad.htm'):
            with self.subTest(content=content):
                self.assertIsNone(parse(f'<meta http-equiv="refresh" content="{content}">').redirect_url)
        self.assertIsNone(parse('<script>location="script.htm"</script><meta name="refresh" content="0;URL=other.htm">').redirect_url)

    def test_spaced_table_labels_and_inline_admission_note(self):
        doc = parse('<table><tr><th>入 館 料</th><td>大人300円<br>※企画展中は入館料が変更になる場合があります<br>小人150円</td></tr><tr><th>開館時間</th><td>9:00～17:00</td></tr><tr><th>休 館 日</th><td>水曜日（休日の場合は翌平日）<br>12月28日～1月4日</td></tr></table>')
        self.assertIn("大人300円", doc.admission)
        self.assertIn("小人150円", doc.admission)
        self.assertIn("入館料が変更", doc.admission)
        self.assertNotIn("休館日", doc.opening_hours)
        self.assertIn("水曜日", doc.closed_days)

    def test_identity_separate_from_navigation_and_footer(self):
        doc = parse('<header><img alt="京都博物館"></header><nav>営業時間 1:00～2:00</nav><main><h2>開館時間</h2><p>９：００～１７：００（最終入館１６：３０）</p></main><footer>休館日 月曜日</footer>')
        self.assertIn("京都博物館", doc.identity_text)
        self.assertNotIn("京都博物館", " ".join(doc.lines))
        self.assertIn("９：００", doc.opening_hours)
        self.assertIsNone(doc.closed_days)

    def test_table_and_dl_preserve_full_exceptions(self):
        doc = parse('<table><tr><th>開館時間</th><td>9:00～17:00</td><th>休館日</th><td>月曜日（祝日の場合は翌平日）<br>年末年始、展示替え期間</td></tr></table><dl><dt>入館料</dt><dd>一般500円、小学生無料</dd></dl><h3>アクセス</h3><p>バス料金200円</p>')
        self.assertEqual(doc.opening_hours, "開館時間 9:00～17:00")
        self.assertIn("展示替え期間", doc.closed_days)
        self.assertNotIn("入館料", doc.closed_days)
        self.assertEqual(doc.admission, "入館料 一般500円、小学生無料")

    def test_same_line_labels_do_not_mix_fields(self):
        doc = parse('<p>開館時間：10:00～18:00 休館日：火曜日 入館料：500円</p>')
        self.assertEqual(doc.opening_hours, "開館時間：10:00～18:00")
        self.assertEqual(doc.closed_days, "休館日：火曜日")
        self.assertEqual(doc.admission, "入館料：500円")

    def test_event_and_last_admission_not_regular_hours(self):
        doc = parse('<h2>イベント</h2><h3>営業時間</h3><p>最終入館 16:30</p>')
        self.assertIsNone(doc.opening_hours)
        self.assertIsNone(parse('<p>最終入館 16:30</p><p>受付時間 9:00～17:00</p>').opening_hours)
        self.assertIsNone(parse('<h2>イベントの営業時間</h2><p>10:00～12:00</p>').opening_hours)

    def test_heading_boundary_and_unrelated_fees(self):
        doc = parse('<h2>観覧料</h2><p>一般300円</p><h3>共通券</h3><p>1000円</p><h2>ボランティア料金</h2><p>200円</p>')
        self.assertEqual(doc.admission, "観覧料 一般300円")

    def test_seasonal_hours_and_all_closed_day_details(self):
        doc = parse('<h2>開館時間</h2><p>4月～9月 9:00～17:00</p><p>10月～3月 9:00～16:00</p><h2>休館日</h2><ul><li>毎週月曜日、祝日の翌日</li><li>12月29日～1月3日</li><li>展示替え期間</li></ul>')
        self.assertIn("10月～3月", doc.opening_hours)
        self.assertIn("展示替え期間", doc.closed_days)

    def test_shift_jis_image_labels_and_link_alt(self):
        html = '<meta charset="Shift_JIS"><title>施設案内</title><a href="guide.html"><img alt="利用案内"></a><h2><img alt="開館時間"></h2><p>9時～17時</p>'
        doc = parse_document(html.encode("cp932"), {"Content-Type": "text/html"})
        self.assertEqual(doc.title, "施設案内")
        self.assertIn(("guide.html", "利用案内"), doc.links)
        self.assertEqual(doc.opening_hours, "開館時間 9時〜17時")


if __name__ == "__main__":
    unittest.main()
