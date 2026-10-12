# 施設の公開説明

`POST /api/places/description` は既存の `Place` オブジェクトを直接受け取り、日本語Wikipediaの施設紹介と公式サイトの案内を返す。APIキーは不要。口コミの検索やAI要約は呼び出さない。

返却値は `description`, `source_url`, `source_title`, `license_name`, `license_url`（各 `string | null`）と `note`（`string`）、`official`（下記オブジェクトまたは `null`）。Wikipediaの説明が取得できなければ前5項目を `null` にしてHTTP 200を返す。公式案内はWikipediaの取得可否と独立して表示できる。入力の形式違反は422、毎分30回の上限を超えると429。

`official` の文字列項目は `url`, `title`, `description`, `description_source_url`, `opening_hours`, `closed_days`, `admission`, `checked_at`（各 `string | null`）、`highlights` は `string[]`（既定値は空配列）、`status` は `verified` / `link_only` / `unavailable`、`note` は `string`。施設紹介の出典は `description_source_url` として案内の取得日時から分離する。公式サイトを確認できた範囲だけを返し、不明な営業時間・休館日・料金を補完しない。`link_only` は公式リンクを提示できるが本文の情報を確認できない状態。提供元が返す `unavailable` もそのまま返し、提供元の予期しない例外や全体の時間超過では `official: null` にする。

施設名を `titles` に指定し、Wikipediaが返す完全一致の記事または明示されたリダイレクト先だけを確認する。記事の主座標が施設座標から500m以内であることも必要。曖昧さ回避記事、記事の一部分へのリダイレクト、座標のない記事は採用しない。全文検索や近隣検索による名前の推測は行わない。

`prop=extracts|coordinates|pageprops` で記事の冒頭・座標・曖昧さ回避フラグを1回のGETで取得する。`exintro=1`, `explaintext=1`, `exchars=500` を指定し、返却文は500文字以内のプレーンテキストに制限する。300文字以降に句点があればその位置で区切る。原文が短ければ説明を足さない。`source_title` は記事名、`source_url` は日本語Wikipediaの記事リンク、`note` はWikipediaの寄稿者からの抜粋である旨を示す。画面では本文とともに記事リンク、CC BY-SA 4.0とライセンスリンク、抜粋である旨を表示する。

Wikipediaへの外部通信は操作1回につき最大1リクエスト。自動再試行やHTTPリダイレクト追跡は行わず、Wikipediaの取得を6秒で打ち切る。施設名と座標をキーに成功と確認済みの未一致を24時間、最大2048件のプロセス内キャッシュに保持する。HTTP非200、タイムアウト、通信エラー、不正なJSON・応答形式、HTTP 200で返るAPIエラー（`maxlag`等）はキャッシュせず、次の操作で再取得できる。Wikipediaの説明は営業時間や料金の最新確認には使わない。

Wikipediaと公式案内は並列に取得し、API全体を15秒以内で打ち切る。一方が失敗した場合も他方の完了済み情報を保持する。Wikipediaのキャッシュは公式案内を含めず、公式案内の取得・キャッシュ管理は専用モジュール `official_place_info` が行う（内部の全体予算12秒、成功時6時間キャッシュ）。公式サイトへの通信はWikipediaの1リクエスト制限とは別に行う。

## 確認した一次資料

2026-10-12確認。

- [MediaWiki Action API: Query](https://www.mediawiki.org/wiki/API:Query#Resolving_redirects): `titles`、`redirects` と応答内の `from` / `to` / `tofragment`。
- [MediaWiki TextExtracts API](https://www.mediawiki.org/wiki/Extension:TextExtracts#API): `exintro`、`explaintext`、`exchars`。`exchars` は指定より長い応答になり得るためサーバーでも文字数を制限する。このAPIは保守が限定されているため、取得不能時は説明を返さない。
- [MediaWiki GeoData API](https://www.mediawiki.org/wiki/API:Geosearch#Example_1:_Obtain_coordinates): 記事名に対する `prop=coordinates` の形式。近隣検索機能は使用しない。
- [Wikimedia利用規約・第7節](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content): テキストのCC BY-SA 4.0、記事リンクによる寄稿者の帰属表示、変更・抜粋の明示。
