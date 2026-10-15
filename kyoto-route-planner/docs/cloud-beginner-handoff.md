# 初めてのCloud Run・Firestore・自動更新の導入

対象：この機能を取り込んだ提出版をGitから取得し、自分のGoogle Cloudプロジェクトで動かす人。コマンド例はWindowsのPowerShell用です。作成日：2026-10-15。

この手順はFirestore・管理画面対応を含むブランチを取得した後に使います。一般利用者向けWebと、Google Cloud IAMで認証する管理用Webを別々にデプロイします。

## 完成するとどう動くか

```text
Cloud Scheduler（10分ごと）
  → Cloud Run Job（最大3施設を選び、公式情報を取得、Geminiで判断）
  → Firestore（採用情報・出典・確認日時・要確認の理由を保存）
  → Cloud RunのWeb画面（管理画面で結果を表示）
```

PCを起動し続ける必要はありません。FirestoreはGoogleが管理するDBなので、DB専用サーバーを自分で用意する必要もありません。Gitで取得するのはプログラムと施設マスターです。Firestoreのデータ、APIキー、クラウドの$gcloud = 'C:\Users\harut\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
& $gcloud components install cloud-run-proxy設定はpullでは作成されません。

この仕組みで永続保存するのは施設情報の更新対象・確認結果・履歴です。検索メモリーや、いいね等の別SQLiteをすべてFirestoreへ移す機能ではありません。

## 0. 引き渡す側が済ませること

提出版に、施設更新のバックエンド、Firestore対応、管理画面、`scripts/cloud_catalog.py`、依存関係、Dockerfile、この手順書をレビューして取り込みます。共有リポジトリにコミット・マージし、受け取る人にリポジトリURLと対象ブランチを伝えます。

`.env`、APIキー、サービスアカウントの鍵、SQLite、`.runtime`、ローカル仮想環境はGitへ入れません。実験版のフォルダー全体を強制追加しないでください。

## 1. 自分のGoogle Cloudプロジェクトを用意する

1. [Google Cloud Console](https://console.cloud.google.com/)に、自分のGoogleアカウントでログインします。
2. 上部のプロジェクト選択から、新しいプロジェクトを作成します。
3. 「お支払い」で請求先アカウントを関連付けます。
4. プロジェクトの**ID**を控えます。画面上の表示名や数字のプロジェクト番号とは別です。
5. 「お支払い → 予算とアラート」で予算通知を設定します。通知は支出を自動停止する仕組みではありません。

新しい専用プロジェクトを推奨します。組織のプロジェクトを使う場合は、管理者にAPI有効化、DB・サービスアカウント・IAM・Secret Manager・Cloud Build・Cloud Run・Schedulerの設定権限を相談してください。権限不足のまま次へ進めないでください。

## 2. PCに必要なものを用意する

- Git
- Python 3.12
- [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk)

インストール後、PowerShellを開き直して確認します。DockerのビルドはCloud Buildが担当するため、この手順でローカルDockerやNode.jsは使いません。

```powershell
git --version
py -3.12 --version
gcloud --version
```

3つともバージョンが表示されれば次へ進みます。

## 3. コードを取得し、作業フォルダーへ移動する

初めて取得する場合は、開発者から受け取ったURLを使います。

```powershell
git clone REPOSITORY_URL
cd REPOSITORY_FOLDER
```

すでに取得済みなら、そのフォルダーで次を実行します。未保存の変更がある場合は、上書きせず開発者に確認してください。

```powershell
git status
git pull --ff-only
```

以降の作業は **Dockerfile・backend・frontend・scriptsがあるフォルダー** で行います。リポジトリの構造によっては、さらにアプリのフォルダーへ移動します。

```powershell
Test-Path Dockerfile
Test-Path scripts/cloud_catalog.py
Test-Path backend/app/catalog_firestore.py
Test-Path backend/app/catalog_migrate.py
Test-Path frontend/public/facility-catalog.html
```

すべて `True` になることを確認します。`False` がある場合は、作業フォルダーまたは取得ブランチを確認します。

## 4. 今回の名前とPython環境を設定する

以下の `YOUR_PROJECT_ID` だけを、自分のプロジェクトIDに置き換えます。元の開発者のプロジェクトIDは使いません。

```powershell
$Project = 'YOUR_PROJECT_ID'
$Region = 'asia-northeast1'
$Database = 'conciergo-catalog'
$Service = 'conciergo-data'
$Admin = "$Service-admin"
$Job = "$Service-update"
$Schedule = "$Service-schedule"
py -3.12 -m venv .venv-cloud
$Python = (Resolve-Path '.venv-cloud/Scripts/python.exe').Path
& $Python -m pip install -r backend/requirements.txt
```

同じDB名を別のGoogle Cloudプロジェクトで使っても、データは共有されません。この例では自分のプロジェクトに新しい `conciergo-catalog` を作ります。サービス名は既存の公開サービスと異なる名前にしてください。

この手順中は同じPowerShellを使います。閉じた場合は、この節の変数設定を再実行してください。仮想環境の作成・インストールは毎回やり直す必要はありません。

## 5. Google Cloudへログインする

```powershell
gcloud auth login
gcloud config set project $Project
gcloud auth application-default login
gcloud auth application-default set-quota-project $Project
gcloud auth list
gcloud config get-value project
```

ブラウザーが開いたら、作業対象プロジェクトへ権限を持つアカウントでログインします。最初のログインはgcloud用、2つ目はPythonからFirestoreへデータを投入するための認証です。両方必要です。[公式の認証手順](https://docs.cloud.google.com/sdk/docs/authenticate)

最後に、自分のアカウントと意図したプロジェクトIDが表示されることを確認します。

## 6. Firestoreなどを作成する（初回のみ）

まず実行予定を表示し、プロジェクト名を確認します。`--apply` がないコマンドは変更を実行しません。

```powershell
& $Python scripts/cloud_catalog.py bootstrap --project $Project --region $Region --database $Database --name $Service
& $Python scripts/cloud_catalog.py bootstrap --project $Project --region $Region --database $Database --name $Service --apply
```

API有効化、Firestore、コンテナー保存先、実行用とScheduler用のサービスアカウント、Geminiキーの保存場所と権限を作ります。サービスアカウントはプログラムが使う専用の実行者です。鍵ファイルをダウンロードする必要はありません。

```powershell
gcloud firestore databases describe --database $Database --project $Project
```

`name` の末尾が `conciergo-catalog`、`locationId` が `asia-northeast1`、`type` が `FIRESTORE_NATIVE` ならDB作成は成功です。Consoleの「Firestore」でもDB名を選択して確認できます。この段階でデータが空なのは正常です。

作成直後のサービスアカウントが見つからない場合は、1分ほど待って同じbootstrapを再実行します。既存リソースは保持されます。別のエラーなら末尾の内容を確認し、次へ進まず原因を解消します。

## 7. 自分のGemini APIキーを登録する

自分のプロジェクトで利用する有効なGemini APIキーを用意します。開発者のキーをGitから受け取ることはありません。

メモ帳で**キーだけ**を含むテキストファイルを、リポジトリ外の非共有フォルダーに保存します。例：`C:/private/gemini-key.txt`。引用符や説明文は入れません。

```powershell
& $Python scripts/cloud_catalog.py secret --project $Project --region $Region --database $Database --name $Service --secret-file C:/private/gemini-key.txt --apply
```

Secret Managerで `$Service-gemini` に有効なバージョンが作成されたことを確認します。登録後、手元の平文ファイルは不要なら削除します。キーをチャット、スクリーンショット、Gitへ載せないでください。

## 8. Firestoreへ初期施設を登録する（初回のみ）

新しく使い始める人は、同梱の施設マスターから確認対象を作成します。まだSchedulerを開始しません。

```powershell
$env:PYTHONPATH = (Resolve-Path backend).Path
$env:CATALOG_STORE = 'firestore'
$env:GOOGLE_CLOUD_PROJECT = $Project
$env:CATALOG_FIRESTORE_DATABASE = $Database
& $Python -m app.catalog_migrate
& $Python -m app.catalog_migrate --apply
```

最初のコマンドは件数確認、2つ目が書き込みです。Console → Firestore → `conciergo-catalog` → データで、`catalog_jobs` に施設の文書が作られたことを確認します。対象外施設や重複IDの扱いにより、更新対象件数はマスターの全レコード数と一致しない場合があります。

確認履歴を持ち込む場合だけ、上の初回書き込みの代わりに、安全に受け取ったSQLiteバックアップを指定します。

```powershell
& $Python -m app.catalog_migrate --sqlite C:/private/catalog_agent.sqlite3 --apply
```

先に空の確認対象を登録すると、後からSQLiteを指定しても同じIDの状態は上書きされません。履歴を引き継ぐかは初回登録前に決めます。通常の新規導入ではSQLiteは不要です。

## 9. Webと更新Jobをデプロイする

```powershell
$Tag = (git rev-parse --short HEAD).Trim()
& $Python scripts/cloud_catalog.py deploy --project $Project --region $Region --database $Database --name $Service --tag $Tag --daily-limit 100 --public-web --apply
```

数分かかる場合があります。Cloud Buildが成功し、Cloud Runに一般向けWeb・管理用Web・更新Jobが作られればデプロイ成功です。

```powershell
gcloud run services describe $Service --project $Project --region $Region --format='value(status.url)'
gcloud run jobs describe $Job --project $Project --region $Region
```

`--public-web` は一般利用者向けWebだけを公開します。管理用Web（サービス名の末尾が `-admin`）はIAM認証必須です。公開Webの施設管理画面・管理APIは403で拒否します。既存サービスを更新する場合は、名前・実行アカウント・既存のAPI設定を開発者と照合してから実施してください。

施設の自動更新に必要なGeminiキーは設定されますが、Google Maps・Places・駅すぱあとなどのキーやサービス設定は自動コピーされません。旅程・地図機能も使う場合は、提出版の各機能の設定手順に従い、自分のAPIキーと必要なAPIを設定してください。Secret Managerの参照権限も新しい実行用サービスアカウントへ付与します。ブラウザー用Mapsキーの許可元には、新しいサイトURLを登録します。

## 10. 管理画面を開く

次のコマンドは接続中ずっと実行されたままになります。

```powershell
gcloud run services proxy $Admin --project $Project --region $Region --port 8081
```

ブラウザーで http://127.0.0.1:8081/facility-catalog.html を開きます。これは認証付きでクラウドへ接続するための入口で、ローカル版アプリではありません。

「施設データ管理」と「Cloud Schedulerから実行」が表示されれば接続できています。この表示だけではSchedulerが作成済みかどうかは判定できません。次の節で実行を確認します。

プロキシを止めるときは `Ctrl+C` を押します。後のコマンドを同じPowerShellで実行し、確認時に再びプロキシを起動できます。別PowerShellを使う場合は4節の変数も設定してください。

403の場合は、閲覧者のGoogleアカウントに、管理用WebサービスのCloud Run Invoker権限があるか管理者に確認します。通常のCloud Run URLを直接開いて403になる場合も、まずこのプロキシを使ってください。

## 11. 手動で1回更新して、結果まで確認する

```powershell
gcloud run jobs execute $Job --project $Project --region $Region --wait
```

次の3つを確認します。

|確認先|成功の目安|
|---|---|
|Console → Cloud Run → ジョブ → 対象Job → 実行|今回の実行が正常終了。失敗ならその実行のログを見る|
|Firestore → 対象DB → データ → `catalog_events`|今回の時刻の確認履歴が増える|
|管理画面 → 結果を再読み込み → 新しい施設の行を開く|今回の確認日時、Geminiの判断、出典、採用情報または要確認理由が見える|

**Jobの正常終了は、すべての施設情報が採用されたという意味ではありません。** 根拠不足は `needs_review`、前回情報との不一致は `conflict` として残す設計です。実際の保存成功を確認するには、履歴に `updated` の施設があり、公式出典と新しい確認日時が表示されるところまで見ます。最初の3件がすべて要確認なら、理由を読み、必要に応じてもう1回実行して別の施設を確認します。

## 12. 自動更新を開始する（初回のみ）

手動確認が済んでから実行します。

```powershell
& $Python scripts/cloud_catalog.py schedule --project $Project --region $Region --database $Database --name $Service --apply
gcloud scheduler jobs describe $Schedule --project $Project --location $Region
```

`state: ENABLED`、`schedule: */10 * * * *`、`timeZone: Asia/Tokyo` を確認します。毎時00・10・20・30・40・50分が起動予定です。実際の起動・完了まで多少時間がかかることがあります。

次の予定時刻を過ぎてから、ConsoleのCloud Schedulerで最終実行を確認し、Cloud Run Jobの新しい実行と管理画面の新しい履歴も確認します。[Cloud Run Jobの定期実行の公式説明](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)

```powershell
gcloud run jobs executions list --job $Job --project $Project --region $Region --limit 5
```

予定時刻を待たずSchedulerからの接続だけ試す場合は、次を1回実行できます。通常の定期実行も別途確認してください。

```powershell
gcloud scheduler jobs run $Schedule --project $Project --location $Region
```

Schedulerの成功は「Jobの起動依頼を送れた」という意味です。Jobの完了、施設情報の採用は、それぞれの画面で確認します。

## 13. データと料金の確認

|Firestoreのコレクション|中身|
|---|---|
|catalog_jobs|施設ごとの状態、採用済み情報、次回確認時刻|
|catalog_events|確認した日時、出典、Gemini判断、結果の履歴|
|catalog_days|日本時間の日付ごとの処理予約数 `reserved`|

1日100件は処理予約の上限で、成功件数ではありません。失敗も消費します。上限到達後もSchedulerは起動しますが、新しい施設の確認は翌日まで予約されません。FirestoreやCloud Run等の料金を含む金額上限ではありません。

100件/日で6,000件を初回確認する場合は、単純計算でも約60日です。再確認も同じ枠を使うため、全施設を30日以内に確認できる設定ではありません。必要な鮮度と予算に応じて日次上限を見直します。

「お支払い → レポート」でサービス別の実費を確認します。Firestoreは無料対象かどうかがDB構成によって異なり、無料運用を前提にしません。バックアップ・失敗通知・履歴の保存期間は別途設定する運用項目です。

## 14. 次回以降のpullと更新

同じ環境を更新する場合、Firestoreの新規作成・キー登録・Scheduler作成は繰り返しません。4節の変数を設定し、次を実行します。

```powershell
git pull --ff-only
& $Python -m pip install -r backend/requirements.txt
$Tag = (git rev-parse --short HEAD).Trim()
& $Python scripts/cloud_catalog.py deploy --project $Project --region $Region --database $Database --name $Service --tag $Tag --daily-limit 100 --public-web --apply
```

施設マスターが追加された場合は、8節の環境変数を設定して `& $Python -m app.catalog_migrate --apply` も実行します。既存IDは上書きせず、不足分を追加します。既存施設の内容変更や削除をFirestoreへ反映する仕組みとは異なるため、その場合は開発者の移行指示に従います。

## 15. 止めたいとき・再開したいとき

```powershell
# 定期起動を停止
gcloud scheduler jobs pause $Schedule --project $Project --location $Region
# 停止状態を確認（PAUSED）
gcloud scheduler jobs describe $Schedule --project $Project --location $Region
# 再開するときだけ実行
gcloud scheduler jobs resume $Schedule --project $Project --location $Region
```

停止前に起動済みのJobは終了まで動きます。必要ならCloud Runの該当実行をキャンセルします。停止してもFirestoreのデータは残り、保存料金などがゼロになるとは限りません。

## 困ったときの確認先

|症状|確認すること|
|---|---|
|コマンドが見つからない|インストール後にPowerShellを開き直す。2節のバージョン確認を行う|
|PERMISSION_DENIED|ログイン中のアカウント・プロジェクト・エラーに記載された権限を確認。管理者へエラー末尾を渡す|
|Firestore NOT_FOUND|DB名・プロジェクトIDを確認。`(default)` ではなく作成した名前付きDBを選ぶ|
|Pythonで認証エラー|5節のapplication-default loginとquota-project設定を確認|
|Cloud Buildが失敗|Console → Cloud Build → 該当ビルドのログ。ビルド用アカウントの保存先書き込み権限等を管理者が確認|
|Scheduler成功だが更新されない|Cloud Run Jobの完了状態、`catalog_days` の上限、次回確認期限、管理画面の再読み込みを確認|
|Geminiが401/403/429|キーの有効性・利用権限・モデル・利用上限・課金状態を確認。キー自体をログへ出さない|
|要確認ばかりになる|施設ごとの出典・取得失敗・判定理由を読む。Job障害と情報不足を区別する|
|サイトは表示されるが地図が出ない|Maps等のAPI有効化、キー設定、参照元URL制限を確認。Firestoreの設定とは別|

## 管理者を追加する・公開状態を確認する

プロジェクト管理者が、閲覧を許可する人のGoogleアカウントを管理サービスだけに登録します。

```powershell
gcloud run services add-iam-policy-binding $Admin --project $Project --region $Region --member='user:ADMIN_EMAIL' --role=roles/run.invoker
gcloud run services get-iam-policy $Admin --project $Project --region $Region
```

`ADMIN_EMAIL` は相手のメールアドレスへ置き換えます。管理サービスに `allUsers` や `allAuthenticatedUsers` が含まれていないことを確認します。管理サービスの認証を「未認証の呼び出しを許可」に変更しないでください。

管理者は自分のアカウントで `gcloud auth login` し、10節のプロキシを使います。秘密の共通パスワードは配布しません。プロキシのアドレスは自分のPCだけで利用します。

公開Webの `/facility-catalog.html` と `/api/catalog-agent` が403、認証付き管理サービスで同じURLが200になることを確認します。Cloud RunのURLは各サービスの詳細画面からコピーしてください。公開Webと管理Web、更新Jobの `GOOGLE_CLOUD_PROJECT` と `CATALOG_FIRESTORE_DATABASE` が同じであれば、更新結果を共有します。Job・Schedulerを重複作成する必要はありません。

既存の公開サービスを接続するときは `CATALOG_ADMIN_ENABLED=0`、管理専用サービスは `CATALOG_ADMIN_ENABLED=1` を設定します。Web上で更新ワーカーを起動せず、Jobだけが自動更新を実行します。既存のMaps・Gemini等の設定は保持します。

関連資料：[詳細な設定・移行仕様](cloud-catalog-deployment.md)
