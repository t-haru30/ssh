# 既存環境を100施設更新へ切り替える

Firestoreの初期設定が済み、認証付き管理画面を開ける人向けの手順です。**Gitのpullだけでは反映されません。** 取得したコードでイメージを作り、公開サイト・管理画面・更新Jobを更新します。Firestoreの作り直し、データの再移行、APIキーの再登録、管理者の再追加は不要です。

## 1. コードと既存の名前を確認する

リポジトリで `git pull --ff-only` を実行し、Dockerfileがある `kyoto-route-planner` に移動します。未コミットの変更がある場合は先に保存してください。

Google Cloud Consoleで自分のプロジェクトを選び、Cloud Runの「サービス」「ジョブ」、Firestoreのデータベース名、Cloud Schedulerの既存ジョブを確認します。公開サービス、管理サービス、更新Jobは別のリソースです。別の開発者のプロジェクト名をコピーしないでください。

## 2. 同じ名前の構成をスクリプトで更新する

導入時の `--name` が `conciergo-data` なら、管理画面は `conciergo-data-admin`、更新Jobは `conciergo-data-update` です。この命名で作成済みの場合は、以前の変数を設定して次を実行できます。`$Python` は導入手順で作ったPython環境です。

```powershell
$Project = 'YOUR_PROJECT_ID'
$Region = 'asia-northeast1'
$Database = 'YOUR_EXISTING_DATABASE'
$Service = 'YOUR_EXISTING_SERVICE'
$Tag = (git rev-parse --short HEAD).Trim()
& $Python scripts/cloud_catalog.py deploy --project $Project --region $Region --database $Database --name $Service --tag $Tag --batch-size 100 --daily-limit 100 --task-timeout 14400 --public-web --apply
```

このコマンドはイメージ作成と3リソースの更新を行います。Firestoreの既存データとサービスの既存環境変数を保持し、管理画面は認証必須のままにします。Schedulerの曜日・時刻は変更しません。`bootstrap`、`secret`、`schedule` の再実行は不要です。

## 3. 既存の名前が異なる場合

公開サイトと更新Jobを別々に作った環境では、2節のコマンドで別名のサービスを増やさず、既存の各リソースを更新します。

1. Cloud Runの既存サービスで使用中のイメージ名を確認します。新しいタグを付けて `gcloud.cmd builds submit . --project YOUR_PROJECT_ID --tag YOUR_NEW_IMAGE` でビルドします。
2. Cloud Runの公開サービスで「新しいリビジョンの編集とデプロイ」を開き、新しいイメージに変更してデプロイします。`CATALOG_ADMIN_ENABLED=0` を保持します。
3. 管理サービスも同じイメージへ更新します。`CATALOG_ADMIN_ENABLED=1` とIAM認証必須を保持します。
4. 更新Jobの「編集」で同じイメージに変更し、次の設定を保存します。コマンドは `python`、引数は `-m,app.catalog_job`、タスク数・並列数は1、再試行数は0です。

|設定|値|
|---|---|
|CATALOG_BATCH_SIZE|100|
|CATALOG_DAILY_LIMIT|100|
|CATALOG_URL_SEARCH_ENABLED|1|
|CATALOG_AGENT_ENABLED|0|
|FACILITY_REFRESH_ENABLED|0|
|タスクのタイムアウト|14400秒（4時間）|
|メモリ|1 GiB|

`CATALOG_STORE=firestore`、プロジェクトID、Firestore名、実行サービスアカウント、GeminiのSecret Manager参照は既存値を保持します。実験で指定した `CATALOG_TRIAL_IDS_PATH` があれば削除します。通常運用は期限が来た施設を自動選択します。

## 4. 自動更新を確認する

Cloud Schedulerの既存ジョブで「今すぐ実行」を1回押します。毎週月曜9時の設定は `0 9 * * 1`、タイムゾーンは `Asia/Tokyo` です。Jobを改名していなければ呼び出し先URLやOAuth設定を変える必要はありません。

Cloud RunのJobに新しい実行が現れ、完了するまで待ちます。実験では100件で約18分かかりましたが、取得先やモデルの応答によって変わります。Schedulerの成功だけでは完了確認になりません。

Firestoreで使用中のデータベースを開き、`catalog_runs` の実行IDを確認します。

|確認項目|意味|
|---|---|
|requested = 100|100施設を処理する設定|
|processed|実際に処理した施設数|
|complete = true|指定件数を処理した。全施設の情報を採用できた意味ではない|
|metrics.statuses.updated|根拠を検証して保存できた施設数|
|needs_review / conflict / failed|根拠不足・既存値との相違・処理エラー。それぞれ履歴で理由を確認|
|seconds / metrics|所要時間・モデル呼び出し回数・トークン数・検索クエリ数|

管理画面は今までの認証プロキシから開き、再読み込みします。更新日時、新しい施設履歴、出典URL、原文引用が表示されることを確認します。履歴は最新50件のため、100件全体の集計は `catalog_runs` で確認します。公開サイトでは管理画面へのアクセスは引き続き制限され、採用済みの施設情報が旅程に反映されます。

処理件数が0や100未満の場合は、`catalog_days` の本日分の `reserved` と、確認期限が来ている施設数を調べます。日次100件を既に処理した日は翌日まで新しい予約ができません。日次上限は成功件数ではなく試行件数です。同日の再試行のために使用履歴を消さないでください。

公式URL検索はGeminiのGoogle Search連携を利用します。利用中のAPIキーとモデルで検索が使えることが必要です。検索クエリ等の課金は通常の推論と別に発生し得ます。根拠不足の施設は推測で埋めず、以前の値を保持します。
