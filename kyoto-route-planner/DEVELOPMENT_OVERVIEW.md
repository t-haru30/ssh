# 京都よりみちルート — 開発者向け現状共有

更新日: 2026-10-09

## 1. プロジェクト概要

京都の観光スポットをもとに、日帰り・1泊2日の旅行プランを提案するローカル中心のWebアプリです。ユーザーは直感で候補を選ぶ **Discover** と、出発地やテーマ等を指定する **Search** を切り替えて利用します。

| 領域 | 技術 |
|---|---|
| フロントエンド | React 19、TypeScript、Vite、独自CSS（Tailwind CSSは未導入） |
| アニメーション | framer-motion |
| 地図 | MapLibre GL JS、OpenFreeMap |
| バックエンド | Python、FastAPI、Pydantic |
| データベース | SQLite（FTS5、R*Treeを含む） |

## 2. ブランチと実装状態

この資料の確認対象は `feature/swipe-mode-ui` です。`main` には直接変更を加えていません。

| 機能 | 状態 |
|---|---|
| Searchの既存ルート検索、地図、タイムライン | 実装済み。既存APIを呼び出す |
| Discover/Searchの上部タブ | `feature/swipe-mode-ui` に実装済み |
| DiscoverのカードUIと右スワイプ詳細モーダル | `feature/swipe-mode-ui` に実装済み |
| Discoverに表示する6件のサンプルルート | `frontend/src/data/mock_dataset.json` に同梱 |
| 事前ルートデータを生成・SQLite/JSON保存するバッチ | `feature/pre-generate-dataset` に実装。別ブランチで未統合 |
| Discoverとバッチ出力データの接続 | 未実装。現在のDiscoverはモックJSONを直接importする |

事前生成バッチは `feature/pre-generate-dataset` のコミット `4876839` にあります。スワイプUIブランチへ取り込む際は、バッチの `dataset.json` をDiscover用の入力に接続する変更が別途必要です。両ブランチの統合・pushはまだ行っていません。

## 3. 画面・機能

### Discover（発見）

- 同梱の静的JSONからルート候補を読み込みます。画面表示時にDiscover専用の外部APIを呼び出しません。
- Search画面はMapLibreの状態保持のため最初からマウントされるので、Discoverを開いた場合も初期化時にSearch側から候補POI・出発駅の取得リクエストが発生します。
- 半日・1日コースのカードに、タイトル、所要時間、スポット名、カテゴリ別アイコンを表示します。
- 左スワイプまたは「×」で次の候補へ進みます。右スワイプまたは「♡」で詳細モーダルを開きます。
- 詳細モーダルでは既存の `MapView` と `RouteTimeline` を利用します。表示する移動時刻は京都駅9:00発の概算で、実際の公共交通経路ではありません。実経路はSearchから検索します。
- 候補をすべて見終わると最初から見直せます。

### Search（検索）

- 出発駅、出発日・時刻、テーマ、立ち寄り件数を指定して日帰りルートを検索します。
- 「今の気分でどこかへ行く」ではランダムな条件でルートを検索します。
- 1泊2日では気分の自然文、日ごとの立ち寄り件数を指定し、宿泊先を含む旅程を検索します。
- 検索結果は時系列タイムラインと地図で表示します。駅すぱあと由来の経路情報を表示します。
- Search内には従来の「スワイプで寄り道を見つける」IdeaDeckも残っています。これはDiscoverの静的カードとは別機能で、Yahoo!等のAPIを呼び出します。

タブ切り替えでは両画面をマウントしたまま `hidden` で表示を切り替えます。MapLibreインスタンスを破棄・再生成せず、Search再表示時には地図へresizeイベントを送ります。

## 4. バックエンドAPI

| メソッド・パス | 用途 | 主な外部通信 |
|---|---|---|
| `GET /api/health` | ヘルスチェック | なし |
| `GET /api/places` | 初期候補POI取得 | Yahoo! Local Search |
| `GET /api/origins` | 登録済み出発駅一覧 | なし |
| `GET /api/places/status` | Yahoo!検索状態 | なし |
| `POST /api/search/places` | POIカタログ検索 | Yahoo! Local Search |
| `POST /api/itineraries` | 日帰りルート提案 | Yahoo!、駅すぱあと |
| `POST /api/itineraries/overnight` | 1泊2日の旅程提案 | Yahoo!、駅すぱあと |
| `POST /api/routes` | 条件指定ルート検索 | Yahoo!、駅すぱあと |
| `GET /api/routes/random` | ランダム条件のルート検索 | Yahoo!、駅すぱあと |
| `GET /api/ideas/random` | 軽量なスワイプ用アイデア | Yahoo!、任意でGemini・Wikimedia Commons・Flickr |

外部APIを呼ぶ検索系エンドポイントにはIP単位のレート制限があります。Cloud Runではインスタンス間で制限を共有するRedis接続が必要です。

## 5. 外部サービス・APIの用途

| サービス | 用途 | 必要な環境変数 |
|---|---|---|
| Yahoo! JAPAN Local Search | POI候補、施設詳細の検索 | `YAHOO_APP_ID` |
| Yahoo! Geocoder | 登録駅以外の検索地点の座標解決 | `YAHOO_APP_ID` |
| 駅すぱあとAPI | 公共交通経路・時刻の検索 | `EKISPERT_API_KEY`、`EKISPERT_APPLICATION_URL` |
| Google Gemini | ルートのタイトル・ストーリー生成。未設定・失敗時はテンプレート | `GEMINI_API_KEY`、任意で`GEMINI_MODEL` |
| Wikimedia Commons | IdeaDeckのカバー画像を検索し、ライセンスと著作者を確認 | 追加キーなし |
| Flickr | Wikimedia Commonsで見つからない場合の商用利用可能画像検索 | `FLICKR_API_KEY` |
| Wikidata / Wikipedia | スポット人気度（サイトリンク数・ページビュー）同期・スコア算出 | 追加キーなし |
| OpenFreeMap / OpenStreetMap | 地図タイル・地理データの帰属 | 追加キーなし |

キーは `backend/.env` に保存し、Gitへコミットしません。設定名だけを示しています。実際のキー値を共有資料やチャットに貼らないでください。

Yahoo!が未設定・失敗・0件の場合、POIは空結果と状態情報として扱い、別事業者やサンプルPOIへ暗黙に切り替えません。GeminiとFlickrは任意機能です。カバー画像はWikimedia Commonsを先に検索し、商用利用可能なライセンスと著作者を確認できた画像だけを採用します。確認できない場合はFlickrのライセンスID 4〜10に限定して検索し、それも使えない場合は画像なしで表示します。

## 6. SQLiteとデータ

既定のDBは `backend/data/travel.sqlite3` です。`TRAVEL_DATABASE_PATH` でパスを変更できます。スキーマは `backend/app/database.py` が初期化します。

| テーブル／インデックス | 用途 |
|---|---|
| `datasets` | 取り込んだオープンデータの出典・ライセンス・取得情報 |
| `places` | 施設名、カテゴリ、住所、座標、説明、出典属性 |
| `places_fts` | 施設名・カテゴリ・住所・説明の全文検索（FTS5） |
| `places_geo` | 座標範囲の候補検索（R*Tree） |
| `place_labels` | 雰囲気・対象者・活動タイプ等のラベルと根拠 |
| `place_embeddings` | 埋め込みモデル、ベクトル、元データのハッシュ |
| `place_popularity` | Wikidata/Wikipedia情報、文化財等の人気度根拠 |
| `place_scores` | 人気度等を組み合わせたスコア |

SQLiteスキーマにはオープンデータの取り込みや検索・スコアリング用の仕組みがありますが、現在の画面のPOI候補表示・ルート生成は主としてYahoo! APIを呼びます。Discoverも現状ではSQLiteを直接読みません。

別ブランチ `feature/pre-generate-dataset` のバッチは、ルート出力先として `pre_generated_routes`、`pre_generated_route_spots`、実行履歴 `dataset_runs`、スコアキャッシュ `dataset_spot_scores` を追加し、静的JSONも出力する設計です。これらは現行UIブランチのDB/UIにまだ統合されていません。

## 7. リポジトリ構成（主要ファイル）

```text
kyoto-route-planner/
├─ frontend/
│  └─ src/
│     ├─ App.tsx                 # ヘッダー、タブ、各モード
│     ├─ SearchMode.tsx          # 既存の検索フォーム、地図、結果
│     ├─ MapView.tsx             # MapLibre地図
│     ├─ RouteTimeline.tsx       # タイムラインと組み立て処理
│     ├─ IdeaDeck.tsx            # Search内のAPIベースの旧アイデアUI
│     ├─ discover/               # Discoverカード、モーダル、データ型
│     └─ data/mock_dataset.json  # Discover用サンプルデータ
├─ backend/
│  ├─ app/main.py                # FastAPIエンドポイント
│  ├─ app/database.py            # SQLiteスキーマとDBパス
│  ├─ app/poi_search.py          # Yahoo! Local Search / Geocoder
│  ├─ app/ekispert.py            # 駅すぱあと連携
│  ├─ app/itinerary.py           # 旅程生成
│  ├─ app/popularity.py          # Wikidata/Wikipedia人気度
│  ├─ app/copywriting.py         # Geminiコピー生成
│  └─ app/image_search.py        # Wikimedia Commons / Flickr画像検索とライセンス検証
└─ DEVELOPMENT_OVERVIEW.md       # この共有資料
```

## 8. ローカル開発と確認

前提はPython 3.12以降、Node.js 24以降です。初回セットアップ、APIキー、駅すぱあと利用ドメインの注意事項は `README.md` を参照してください。

```powershell
# backend
cd kyoto-route-planner\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v

# frontend
cd ..\frontend
npm ci
npm run build

# アプリ起動（プロジェクトルート）
cd ..
.\start.bat
```

## 9. 制約・注意事項

- POI検索・経路検索は外部APIの利用条件、利用量、レート制限、ネットワーク状態に依存します。駅すぱあとAPIの利用登録ドメインと契約条件を確認してください。
- Gemini・Flickr・Yahoo!の認証情報はサーバー側だけで扱います。ログやブラウザーへキーを出さないでください。
- DiscoverのサンプルJSONは画面確認用であり、生成バッチの最新データではありません。
- バッチとDiscoverの統合後は、バッチJSONのスキーマ変更時にフロントエンド型・表示処理も合わせて更新してください。
- ルート候補の選定順、徒歩部分、スポット滞在時間には推定が含まれます。営業時間や実地での安全・通行可否を保証しません。
- データセットを外部公開・再配布する場合は、各データ提供元のライセンス・帰属表示・利用条件を確認してください。P12データについては、現行READMEの記載どおり公開条件を確認するまで公開環境へデプロイしません。
