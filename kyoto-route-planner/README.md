# 京都よりみちルート

既存アプリとは独立して動く、京都の1日ルート提案アプリです。利用者が出発駅、出発日・時刻、テーマ、立ち寄り件数を指定すると、候補スポットを選び、駅すぱあとAPIで出発駅に戻る公共交通ルートを検索します。`GET /api/routes/random` では、バックエンドがテーマ（歴史・自然・食）と立ち寄り件数（1〜3件）をランダムに選び、京都駅発・現在時刻の成立するルートを1件返します。`GEMINI_API_KEY` を設定すると、ルートのスポット名とテーマをGemini APIへ送り、魅力的なタイトルと短いストーリーをレスポンスに追加します。未設定時もルート検索自体は利用できます。P12データの利用条件を踏まえ、現状はローカル・非公開で運用します。

## 構成

- `frontend/`: React、TypeScript、Vite、MapLibre GL JS
- `backend/`: FastAPI。Yahoo! JAPAN APIを優先するPOI検索、Overpass APIによる補完、駅すぱあとAPIによる経路検索
- `Dockerfile`: フロントエンドとAPIを1つのコンテナにまとめる構成。公開環境へのデプロイは利用許諾を確認するまで行いません。

Yahoo! JAPAN APIと駅すぱあとAPIの認証情報はバックエンドだけで使い、ブラウザーには渡しません。POI検索とルート候補の検索はYahoo!ローカルサーチAPIを優先し、結果なし・位置情報やカテゴリの不足・APIエラー時、またはルート候補数が不足するときにOverpass APIで補完します。Yahoo!ジオコーダAPIは登録駅以外の検索地点の座標解決に使います。Overpassの結果は24時間ローカルSQLiteにキャッシュし、HTTP 429時は一定時間検索を停止します。公開Overpassサーバーは稼働保証がなく、混雑時に遅延・制限・停止する場合があります。

## 国土数値情報・旅行データ基盤（フェーズ1）

京都府から始めるローカル試作データベースを `backend/data/travel.sqlite3` に作成します。配布元の使用許諾をデータ版ごとに確認し、公式の京都府P12データを `backend/data/raw/P12-14_26_GML.zip` に置いて取り込みます。ZIPとSQLite DBはGitに含めません。

- `datasets`: データセット名、発行元、取得元URL、版、取得時点、ライセンスと出典表記。
- `places`: 必須の `id`、`name`、`category`、`address`、`latitude`、`longitude`、`description`、原典のレコードID・属性JSON。
- `place_labels`: `atmosphere`、`target_audience`、`activity_type` と信頼度、根拠、生成方法、モデル、プロンプト版。
- `place_embeddings`: 埋め込みモデル、次元、ベクトル、対象テキストのハッシュ。
- `places_fts` と `places_geo`: SQLite FTS5の日本語部分文字列検索とR*Treeによる空間候補検索。意味ベクトル検索の具体的な方式はフェーズ3で決めます。

初期候補データ:

- [国土数値情報 観光資源データ (P12)](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P12-2014.html): 最新公開仕様は第2.2版、データ基準年は2014年です。点・線・面のデータがあり、今回の検索・ルート提案には京都府の点データ597件のみを使用します。検索用の `category` は `tourism` に正規化し、原典の種別・名称・住所・座標などは `source_attributes_json` に保持します。原典にない説明文は空欄のままです。データは古いため、現存状況や最新情報は保証されません。
- [国土数値情報 宿泊容量メッシュデータ (P09)](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P09.html): 宿泊施設個別の名前・住所ではなく、宿泊容量のメッシュ情報として扱います。宿泊施設POIの代替にはしません。
- [国土数値情報 バス停留所データ (P11)](https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P11.html): 交通アクセス候補を補う場合に使います。

国土数値情報は、指標・公開版ごとに利用条件が異なります。取り込み前に[データ一覧](https://nlftp.mlit.go.jp/ksj/gml/gml_datalist.html)でその版のライセンスを確認し、[利用ルール](https://nlftp.mlit.go.jp/ksj/other/agreement.html)に沿った出典と加工表記を保存します。`datasets.license_name`、`license_url`、`attribution_text`が埋まらないデータは登録しない方針です。

P12の使用許諾条件は「非商用」で、複製物の再配布は許可されていません。利用規約は、GIS/Excel等のデータベース利用について権利侵害のおそれがある場合に事務局への問い合わせも案内しています。このため取り込んだデータおよび検索結果は現時点ではローカル試作に限定し、公開・再配布はしません。公開サービスに使う場合は、配布元への確認または別途利用許諾が必要です。

京都府P12ポイントデータの取得・登録:

```powershell
cd backend
New-Item -ItemType Directory -Force data\raw | Out-Null
Invoke-WebRequest `
  -Uri "https://nlftp.mlit.go.jp/ksj/gml/data/P12/P12-14/P12-14_26_GML.zip" `
  -OutFile "data\raw\P12-14_26_GML.zip"
python -m app.ingest_p12
python -m app.labeling
```

取込処理は再実行可能で、同じデータセットの既存スポットを置き換えます。SQLiteにはポイント形状のみを登録し、P12の線・面形状はルート候補に使いません。

## ラベル付け（フェーズ2）

初期版は外部LLMを使わず、`backend/app/labeling.py` のキーワードルールで `atmosphere`、`target_audience`、`activity_type` を抽出します。ラベルには一致した原文語句、信頼度、方式 `rule`、ルール版を保存します。明示根拠がない客層などは推測で付与しません。

P12データはローカル検索基盤の試作用として保持しています。検索クエリおよびルート候補ではYahoo! JAPANのPOI結果を優先し、不足時にOverpass API経由のOpenStreetMapデータで補完します。P12の利用条件により、アプリ・検索結果は引き続きローカル・非公開に限定します。

### Yahoo! JAPAN API優先のPOI検索

`backend/.env` に `YAHOO_APP_ID`（Yahoo!デベロッパーネットワークで発行）を設定すると、検索クエリは[YOLPローカルサーチAPI](https://developer.yahoo.co.jp/webapi/map/openlocalplatform/v1/localsearch.html)で先に検索されます。登録駅以外の地点は[YOLPジオコーダAPI](https://developer.yahoo.co.jp/webapi/map/openlocalplatform/v1/geocoder.html)で座標を解決します。Yahoo結果に有効な位置情報とカテゴリがあり1件以上得られた場合、Overpassは呼び出しません。結果が0件・不完全、またはYahoo APIが利用できない場合は、[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)をバックアップとして使用します。統合時はYahoo結果を先に保ち、重複候補ではYahooの情報を優先します。YahooのClient IDが未設定の場合も、Overpassへ自動的にフォールバックします。

Overpassから取得した京都駅周辺の名前付き地点はローカルSQLiteに24時間キャッシュし、バックアップ検索・ルート候補の補完に使います。HTTP 429を受けた場合はサーバーの `Retry-After` に従い、ヘッダーがない場合も1時間検索を止めます。公開サーバーは無料ですが、安定稼働や全POIの網羅性は保証されません。Yahooの候補だけで指定立ち寄り数に足りない場合はOverpassで候補を追加し、Overpassも停止中なら利用可能なYahoo候補数まで立ち寄り数を減らして経路検索します。

データはOpenStreetMap由来です。POIの最新性・網羅性は保証されません。画面上のOpenStreetMap出典表示を維持してください。公開サーバーの利用前に[利用ポリシー](https://operations.osmfoundation.org/policies/overpass/)を確認してください。

### OSMタグによる候補スコア（第1段階）

ルート候補の選定では、外部の有料口コミAPIを使わず、OSMの公開タグから知名度・情報充実度の代理スコアを計算します。`wikipedia`、`wikidata`、`tourism=attraction`、`historic`、公式サイト、料理ジャンル、宿泊施設の`stars`・`beds`などを加点し、テーマ適合度を加味したうえで、出発地点からの近さと組み合わせて優先順位を決めます。

このスコアは口コミ評価や実際の訪問者数ではありません。OSMのタグ未登録は低評価を意味しないため、タグがないことによる減点は行いません。飲食店の「評価」や宿泊施設の品質を断定せず、公開情報にもとづく候補の優先順位として扱います。

### Wikidata・Wikimediaによる人気度同期（第2段階）

第2段階では、APIキー・アカウント登録不要のWikidata Query ServiceとWikimedia Pageviews APIを、明示的に実行する同期コマンドから利用します。OSMの`wikidata`・`wikipedia`タグを手がかりに、Wikipedia言語版数と日本語版記事の過去30日ページビューを取得し、SQLiteの`place_popularity`と`place_scores`へ保存します。Wikimedia APIには識別可能なUser-Agentを付け、取得結果はルート検索のたびに取得せず、キャッシュを候補選定へ利用します。

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.sync_popularity
```

Wikidataの同期結果は7日間をTTLとし、TTL内なら外部APIを呼び出さず既存キャッシュを利用します。429（レート制限）や5xxは`Retry-After`を尊重して最大3回再試行し、個別のページビュー取得に失敗しても他のスポットの同期を続けます。同期に失敗した場合も既存キャッシュや第1段階のOSMタグスコアは削除されません。`TRAVEL_DATABASE_PATH`を設定している場合は、そのSQLiteへ同期結果と候補選定用スコアを保存します。同期コマンドは外部APIへ接続するため、定期実行する場合は各サービスの利用ポリシーとレート制限を確認してください。Wikidata・Wikimedia由来の値は知名度・公開情報の代理指標であり、口コミ評価ではありません。

### オープンデータ統合（第3段階）

既存の`ingest_p12`で取り込んだ国土数値情報P12観光資源データ（京都府）を、Overpass由来の候補と名称または座標（約100m以内）で照合します。照合できた候補には公開観光資源データの該当スコアを加え、Wikidata・Wikimediaの知名度スコアと合わせて優先順位を計算します。P12データが未取り込みの場合は該当加点なしで、従来のOSM・Wikidata・Pageviewsスコアにフォールバックします。

この段階で新しいAPIキー、アクセストークン、アカウント登録は必要ありません。使用するのは、既存のローカルSQLiteに登録された国土交通省の公開データだけです。P12の利用条件・出典表示は既存の`datasets`レコードで管理します。観光統計の追加取得や有料APIはまだ使用していません。

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.labeling
```

## 自然文検索（フェーズ3）

`POST /api/search/places` に `{"query":"京都駅周辺で自然を感じられる場所"}` を渡すと、ルールベースで地域、登録済み出発駅、カテゴリー、希望、距離条件を抽出し、Yahoo!ローカルサーチAPIを優先してPOIを検索します。不足時はOverpassから取得したキャッシュ済みPOIとOpenStreetMapタグで補完します。登録駅の「周辺」は1km、徒歩N分は毎分80mの検索半径として扱います。登録駅で解決できない距離指定は警告と空結果にし、別の中心地点へフォールバックしません。原典タグに客層等の明示根拠がない場合、その希望は推測で満たしたことにしません。

移動時間は駅すぱあとAPIの経路検索で別途評価します。P12ベースのFTS5/R*Tree検索関数はローカルDBの検証用として残しますが、画面・ルート・自然文検索APIのスポット候補取得には使いません。ベクトル検索・意味検索も未導入です。

## 周遊ルート（フェーズ4）

`POST /api/itineraries` は、自然文検索の候補から立ち寄り先を選び、最大3か所の全順列（最大6通り）を駅すぱあとAPIに問い合わせ、最短の公共交通所要時間の順序を採用します。各地点の滞在は一律90分として加算し、既定の18:00帰着期限を超える場合も結果を返し、`feasible: false` と明示します。APIの呼び出し回数を `route_search_calls` に含めます。API契約に応じて検索ごとの利用料が発生し得るため、順列比較を実行するのは利用者がこのエンドポイントを明示的に呼んだ時だけです。

例:

```json
{
  "query": "京都駅周辺で自然を感じられる観光地",
  "departure_station": "京都",
  "departure_date": "2026-10-05",
  "departure_time": "09:00",
  "stop_count": 3
}
```

営業時間、施設での実際の滞在時間、混雑・遅延、地点間の徒歩道順はデータ未整備のため保証対象外です。座標から最寄り駅までのアクセスは駅すぱあとAPIの概算です。

## ローカル起動

Python 3.12以降とNode.js 24以降が必要です。

初回のみ、`backend/.env.example` を `backend/.env` にコピーして `EKISPERT_API_KEY` と `YAHOO_APP_ID` を設定し、依存関係を準備します。Yahoo!のClient IDを設定しない場合はPOI検索がOverpassへフォールバックします。

```powershell
cd kyoto-route-planner\backend
Copy-Item .env.example .env
# .envを開き、取得済みのキーを EKISPERT_API_KEY= と YAHOO_APP_ID= に設定します。
# 例として、ローカル開発では EKISPERT_APPLICATION_URL=http://127.0.0.1:8000 を使います。
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

```powershell
cd ..\frontend
npm ci
npm run build
```

`start.bat` はフロントエンドのソースがビルド済みファイルより新しい場合、自動で `npm run build` を実行してからAPIとブラウザーを起動します。起動したAPIウィンドウを閉じるとアプリが停止します。

```powershell
cd ..
.\start.bat
```

駅すぱあとAPIの利用登録ドメインに開発用ドメインを登録してください。ローカル開発では `127.0.0.1` のような実際の利用URLを `EKISPERT_APPLICATION_URL` に設定し、`localhost` だけに寄せすぎないことが重要です。登録ドメインとローカル開発の利用条件は必要に応じて駅すぱあとAPIの窓口に確認してください。

## Google Cloud Runへの公開

Cloud Run、Cloud Build、Artifact Registryを有効にしたGoogle Cloudプロジェクトと、`gcloud` CLIが必要です。Google Cloudの利用料は駅すぱあとAPI・地図タイルの利用条件とは別です。無料枠の対象・料金はプロジェクトごとに確認してください。

このアプリのフォルダー (`kyoto-route-planner`) でコマンドを実行してください。駅すぱあとAPIキーはGoogle Cloud ConsoleのSecret Managerに登録し、ソースコードやブラウザー環境変数に記載しないでください。Cloud Runの実行サービスアカウントには、そのシークレットを参照する `Secret Manager Secret Accessor` 権限が必要です。

```powershell
gcloud run deploy kyoto-route-planner `
  --source . `
  --region asia-northeast1 `
  --allow-unauthenticated `
  --set-secrets EKISPERT_API_KEY=ekispert-api-key:latest `
  --set-env-vars "EKISPERT_APPLICATION_URL=https://your-registered-domain.example"
```

`your-registered-domain.example` は、駅すぱあとAPIに登録した実際のアプリドメインに置き換えてください。Cloud RunのURLまたは独自ドメインが駅すぱあとAPIの登録条件に合うか、公開前に提供元へ確認してください。アプリのドメイン登録要件を満たさない場合はAPI認証に失敗します。

## 動作・制約

- 1回の検索につき、駅すぱあとAPIへ経路探索を1回送信します。APIキーの契約に応じてリクエスト料金が発生する可能性があります。
- 電車・バス等の公共交通ルートと時刻は駅すぱあとAPIの応答に基づきます。駅すぱあとAPIが利用できない場合、成功したように見せず画面にエラーを表示します。
- 行き先の選定と訪問順は、京都の候補スポット集および直線距離による近接性に基づく提案です。全観光地を網羅したり、営業状況・滞在時間・最適な観光順を保証したりするものではありません。
- 出発駅と候補地は登録座標から駅すぱあとAPIに渡し、地点ごとの最寄り駅を自動選択させます。地点から駅までの所要時間は直線距離と毎分80mによる概算で、歩道に沿った実際の徒歩道順ではありません。
- 地図は候補地と出発駅の位置表示用です。現時点で経路線は描画しません。OpenFreeMapは無料で使えますが、公開タイルサービスに稼働保証はありません。地図が読み込めなくてもルート検索結果の一覧は利用できます。
- OpenFreeMapおよびOpenStreetMapへの帰属表示を画面に含めています。

## 確認コマンド

バックエンドのテスト:

```powershell
cd backend
python -m unittest discover -s tests -v
```

フロントエンドの型チェック・ビルド:

```powershell
cd frontend
npm ci
npm run build
```

## GitHub Actions

`.github/workflows/ci.yml` により、`main` へのPull Requestと`main`へのプッシュ時に、バックエンドの全テストとフロントエンドのビルドを自動実行します。CIでは実際の駅すぱあとAPIを呼び出さないため、APIキーをGitHub Actionsへ登録する必要はありません。実際のAPIキーはローカルの`backend/.env`だけに保存してください。
