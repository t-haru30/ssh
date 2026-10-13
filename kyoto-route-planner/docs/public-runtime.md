# 公開用ランタイム

Docker版は、リポジトリ内の47都道府県のOSM由来ルートから施設・提案データを生成して同梱します。`backend/data`、`.local`、`.env`、既存のSQLite、P12の原本はビルド・ソースアップロード対象から除外します。実行時のSQLiteは `/tmp/conciergo/travel.sqlite3` に作成され、コンテナの終了で失われます。旅程の下書きはブラウザ保存、端末間の移動はJSONで行います。

## データの生成と帰属表示

`frontend` で `npm run build` または `npm run dev` を実行すると、先に `scripts/build-public-data.mjs` が動きます。47都道府県・OSMの施設ID・座標・生成元を検査し、未検証の施設が混ざればビルドを失敗させます。「昼食: 要検討」は空欄の予定として保持し、実在施設の検索候補には含めません。

生成先はGit管理外の `frontend/public/data/` です。Dockerはそのうち `osm-ideas.json` と `osm-places.json` をバックエンドへコピーします。ローカルの従来の `backend/data/fallback_dataset.json` は変更しません。

画面下部と `/data-sources.html` に [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) の帰属表示と [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) のリンクを掲載します。加工したルート・施設データ全体は同ページからダウンロードでき、生成マニフェストにはSHA-256を記録します。画像やYahoo!検索結果をこの公開用データへ追加する仕組みはありません。

登録候補は全国の施設を網羅していません。名称・位置・営業状況、営業時間・料金は最新とは限らず、移動時間は初回提案の概算です。実際の公共交通経路には駅すぱあとAPIを別途使用します。

## 実行時設定

| 設定 | 用途 |
| --- | --- |
| `PLACE_SEARCH_PROVIDER=public_catalog` | Dockerの既定値。同梱OSM候補だけを施設検索する。Yahoo!キーは不要 |
| `EKISPERT_API_KEY` | 公共交通経路・駅名検索に使用 |
| `EKISPERT_APPLICATION_URL` | 駅すぱあとに登録した公開URL |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | 任意。APIによるルート提案のタイトルと紹介文を生成 |
| `VENUE_EVIDENCE_ENABLED=1` | 任意。施設の「口コミ・公開情報」ボタンを有効にする |
| `RECOMMENDATION_GEMINI_API_KEY` | 旧キー名。`GEMINI_API_KEY` がない場合だけ移行用として使用 |
| `RECOMMENDATION_GEMINI_MODEL` | 口コミ要約だけモデルを変更する任意設定。通常は `GEMINI_MODEL` を使用 |
| `ROUTE_ILLUSTRATIONS_ENABLED` / `GEMINI_IMAGE_MODEL` | `1`でルート画像生成を有効化。共通の `GEMINI_API_KEY` を使用。画像用モデルの既定値は `gemini-nano-banana-2.1` |
| `ROUTE_ILLUSTRATION_DAILY_LIMIT` / `ROUTE_ILLUSTRATION_CACHE_DIR` | 画像生成の日別試行上限（既定10）と永続キャッシュ保存先。複数インスタンスでは共有保存先か別の全体上限が必要 |
| `RATE_LIMIT_STORAGE_URI` | 未設定時はプロセス内のメモリ。複数インスタンスで共有する場合は自分のRedisを使用 |

APIキーはフロントエンドやビルド引数へ渡さず、Cloud Runでは自分のプロジェクトのSecret Managerから設定してください。Dockerは `.env` の自動読込を無効にします。各キーをその公開URL・用途で使えることは契約に合わせて確認してください。

施設候補の表示、初回の日帰り旅程作成、編集・JSON保存はAIキーなしでも動作します。初回の旅程作成は端末内のルールによる処理で、AIを使用しません。ルート紹介文の生成と口コミ要約は別機能です。口コミ要約はボタン操作時にGoogle検索で根拠を調べ、施設の一致や根拠を確認できない回答は表示しません。検索結果の参照リンクとGoogleの検索候補表示を保持します。

口コミ要約の20回上限は1プロセス内の回数で、再起動や複数インスタンスをまたぐ総額上限ではありません。公開時はAPI側の割り当てとCloud側の利用量を管理してください。

## 検証

`frontend` で `npm run test:public-data` を実行すると、全国データの整合性・ライセンス情報・マニフェストと、不明な取得元やディレクトリ外の入力を拒否することを検査します。`npm run build` で公開データとフロントエンドをビルドします。Dockerがある環境ではアプリのフォルダーで `docker build -t conciergo-demo .` を実行してください。

起動後は `/api/health` が `ok`、`/api/places/status` が `OpenStreetMap` / `ready` であることと、`/data-sources.html` のダウンロードを確認します。AIの有効・無効は `/api/recommendations/status` で確認できます。紹介文と口コミ要約の実リクエストには、それぞれ設定したキーの利用量が発生します。
