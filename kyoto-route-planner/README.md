# 京都よりみちルート

既存アプリとは独立して動く、京都の1日ルート提案アプリです。利用者が出発駅、出発日・時刻、テーマ、立ち寄り件数を指定すると、候補スポットを選び、駅すぱあとAPIで出発駅に戻る公共交通ルートを検索します。P12データの利用条件を踏まえ、現状はローカル・非公開で運用します。

## 構成

- `frontend/`: React、TypeScript、Vite、MapLibre GL JS
- `backend/`: FastAPI。Overpass APIによる候補スポット検索と駅すぱあとAPIによる経路検索
- `Dockerfile`: フロントエンドとAPIを1つのコンテナにまとめる構成。公開環境へのデプロイは利用許諾を確認するまで行いません。

駅すぱあとAPIキーはバックエンドだけで使います。ブラウザーには渡しません。スポット候補はAPIキー不要のOverpass APIから取得し、MapLibreの地図タイルはOpenFreeMapを使います。Overpassの検索結果は24時間ローカルSQLiteにキャッシュし、HTTP 429を受けた場合は連続アクセスを避けるため一定時間検索を停止します。公開Overpassサーバーは稼働保証がなく、混雑時に遅延・制限・停止する場合があります。ローカルのスポット一覧と駅すぱあとAPIによる交通経路検索は別のサービスです。

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

P12データはローカル検索基盤の試作用として保持しています。ルート提案画面のPOI候補にはOverpass API経由のOpenStreetMapデータを使用します。P12の利用条件により、アプリ・検索結果は引き続きローカル・非公開に限定します。

### Overpass APIによるスポット取得

POI検索にHeiGIT/OpenRouteServiceのAPIキーは必要ありません。アプリは[Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)へ検索し、OpenStreetMapのデータを利用します。

京都駅を中心とした半径2km圏内で、観光・歴史・自然・飲食等の名前付き地点を1回の検索で取得し、ローカルSQLiteに24時間キャッシュします。候補範囲と出発地点を一致させるため、現時点で選べる出発駅は京都駅のみです。四条・三条・嵯峨嵐山周辺のルートは対象外です。HTTP 429を受けた場合はサーバーの `Retry-After` に従い、ヘッダーがない場合も1時間検索を止めます。HTTP 502/503/504などの一時的な障害はエラーとして表示し、自動再試行はしません。公開サーバーは無料ですが、安定稼働や全POIの網羅性は保証されません。

データはOpenStreetMap由来です。POIの最新性・網羅性は保証されません。画面上のOpenStreetMap出典表示を維持してください。公開サーバーの利用前に[利用ポリシー](https://operations.osmfoundation.org/policies/overpass/)を確認してください。

```powershell
cd backend
.\.venv\Scripts\python.exe -m app.labeling
```

## 自然文検索（フェーズ3）

`POST /api/search/places` に `{"query":"京都駅周辺で自然を感じられる場所"}` を渡すと、ルールベースで地域、登録済み出発駅、カテゴリー、希望、距離条件を抽出し、Overpassから取得したキャッシュ済みPOIとOpenStreetMapタグを検索します。登録駅の「周辺」は1km、徒歩N分は毎分80mの検索半径として扱います。登録駅で解決できない距離指定は警告と空結果にし、別の中心地点へフォールバックしません。原典タグに客層等の明示根拠がない場合、その希望は推測で満たしたことにしません。

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

初回のみ、`backend/.env.example` を `backend/.env` にコピーして `EKISPERT_API_KEY` を設定し、依存関係を準備します。

```powershell
cd kyoto-route-planner\backend
Copy-Item .env.example .env
# .envを開き、取得済みのキーを EKISPERT_API_KEY= に設定します。
# 例として、ローカル開発では EKISPERT_APPLICATION_URL=http://127.0.0.1:8000 を使います。
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

```powershell
cd ..\frontend
npm ci
npm run build
```

2回目以降は `start.bat` をダブルクリックすれば、APIを起動してブラウザーを開きます。起動したAPIウィンドウを閉じるとアプリが停止します。

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
