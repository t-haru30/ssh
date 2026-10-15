# Cloud Run・Firestore・Schedulerへの引き継ぎ

初めて導入する人は [初心者向けの導入・確認手順](cloud-beginner-handoff.md) から読んでください。

対象は実験版の施設マスター更新機能です。実験環境では2026-10-15に定期更新を確認済みです。導入先ごとに以下の確認を行ってください。
コードを取り込んだリポジトリのルート（Dockerfileがある場所）で、以下を実行します。

## 構成と範囲

- Cloud Run service：Web画面・確認履歴を表示。初期設定では認証必須。
- Cloud Run Job：最大100施設を確認して終了。Webの常駐ループは動かさない。
- Cloud Scheduler：毎週月曜9時（日本時間）にOAuth認証でJobの実行APIを呼ぶ。
- Firestore：更新対象、採用済み公式情報、全確認履歴、日次処理数を保存。
- 元の施設マスターJSONはイメージに同梱。確認結果をFirestoreから重ねて表示する。
- GeminiキーはSecret Manager。サービスアカウントの鍵ファイルは作らない。

SQLiteの `catalog_agent.sqlite3` が移行対象です。検索で蓄積する `facility_memory.sqlite3`、
いいね・旅程レビュー等の別SQLiteは対象外です。クラウドでは検索メモリーの更新ワーカーを停止し、
その検索キャッシュは一時ファイルです。この手順はアプリ内の全SQLiteを永続化するものではありません。
Google Maps等の既存サービス設定も新規環境では別途必要です。

## 1. 前提と権限

Python 3.12、Google Cloud CLI、課金が有効な**専用の検証プロジェクト**を用意します。
初期設定者はAPI有効化、Firestore DB作成、Artifact Registry作成、サービスアカウント/IAM管理、
Secret Manager管理、Cloud Build実行、Cloud Run管理、Scheduler管理の権限が必要です。
デプロイ担当者には実行サービスアカウントを使用する `iam.serviceAccounts.actAs` 権限も必要です。
組織の管理者に必要な権限を依頼してください。スクリプトは自分自身への権限付与は行いません。

Cloud Buildのビルド用サービスアカウントに、イメージ保存先へのArtifact Registry書き込み、
ビルド元読み取り・ログ書き込み権限が必要です。組織設定によって既定アカウントが異なります。
ビルドが権限エラーになった場合はCloud Buildのログで実際のアカウントを確認してください。

```powershell
gcloud auth login
gcloud auth application-default login
python -m venv .venv-cloud
.venv-cloud/Scripts/python -m pip install -r backend/requirements.txt
```

以降の `python` は依存関係を入れたPythonを指します。Linux/macOSでは `.venv-cloud/bin/python` を使えます。
プロジェクトIDの `YOUR_PROJECT` は実際の値に置き換えます。既存公開版と混在させないでください。

## 2. 初期設定（初回のみ）

まず `--apply` なしで実行予定のgcloudコマンドを確認します。

```powershell
python scripts/cloud_catalog.py bootstrap --project YOUR_PROJECT
python scripts/cloud_catalog.py bootstrap --project YOUR_PROJECT --apply
```

既定値：東京リージョン `asia-northeast1`、Firestore DB `catalog-agent`、サービス名 `catalog-experiment`。
`--region` / `--database` / `--name` で変更する場合、以降の全コマンドでも同じ値を使います。
Firestoreのロケーションは後から簡単に変更できません。既存リソースがある場合は削除せず保持します。
同名で異なる設定のリソースが存在する場合は設定を確認してから続行してください。

Geminiキーだけを含むファイルを**リポジトリ外**に用意し、登録します。
キーをコマンド引数・ソース・手順書へ直接書かないでください。

```powershell
python scripts/cloud_catalog.py secret --project YOUR_PROJECT --secret-file C:/private/gemini-key.txt --apply
```

この操作を再実行すると新しいSecretバージョンを作ります。不要になった手元の鍵ファイルは適切に管理してください。

## 3. 初期施設・確認結果の移行

Schedulerをまだ作成・開始しないでください。移行担当者のADCには対象Firestoreへの読み書き権限が必要です。

```powershell
$env:PYTHONPATH = (Resolve-Path backend).Path
$env:CATALOG_STORE = 'firestore'
$env:GOOGLE_CLOUD_PROJECT = 'YOUR_PROJECT'
$env:CATALOG_FIRESTORE_DATABASE = 'catalog-agent'
python -m app.catalog_migrate
python -m app.catalog_migrate --apply
```

上記は同梱施設から更新キューを新規作成します。既存の確認結果も引き継ぐ場合は、
上記の初回 `--apply` の代わりに、元のPCから安全に受け取ったSQLiteを指定します。

```powershell
python -m app.catalog_migrate --sqlite C:/private/catalog_agent.sqlite3
python -m app.catalog_migrate --sqlite C:/private/catalog_agent.sqlite3 --apply
```

SQLiteはGitに入れません。稼働中のDBファイルを単純コピーせず、SQLiteのbackup API等で整合したバックアップを作って渡します。
ローカルの元ファイルを直接指定する場合はread-onlyトランザクションで読み取ります。
移行は既存IDを上書きしないため途中で止まっても再実行できます。履歴も重複登録しません。
**先に空のキューを投入すると、後からSQLiteを指定しても同じIDの状態は上書きしません。**
その場合は別DBで移行をやり直すか、状態を照合した個別移行が必要です。既存DBを削除してやり直さないでください。

## 4. ビルドとデプロイ

```powershell
python scripts/cloud_catalog.py deploy --project YOUR_PROJECT --tag COMMIT_HASH --daily-limit 100
python scripts/cloud_catalog.py deploy --project YOUR_PROJECT --tag COMMIT_HASH --daily-limit 100 --apply
```

`COMMIT_HASH` は小文字のコミットハッシュに置き換えます。
Cloud BuildがDockerfileをビルドし、一般用Web・管理用Web（サービス名-admin）とJobへ同じイメージを反映します。
`--daily-limit` は日本時間0時で切り替わる施設処理予約数の上限です。
再取得は1施設最大1回なので、100施設ならGemini判断は最大200回です。金額による上限ではありません。
失敗・途中停止も件数を消費します。0なら新規処理を予約しません。

Webは非公開です。ブラウザーで確認する担当者に対象サービスのCloud Run Invoker権限を付与し、
そのユーザーで次のプロキシを起動します。

```powershell
gcloud run services proxy catalog-experiment-admin --project YOUR_PROJECT --region asia-northeast1 --port 8081
```

`http://127.0.0.1:8081/facility-catalog.html` を開きます。クラウドでは画面上の手動実行ボタンを隠し、
HTTPの手動実行APIも拒否します。更新JobはIAM認証された操作だけで実行できます。
一般向けWebを公開するときはdeployに `--public-web` を追加します。一般向けWebの管理URLは403となり、管理用WebはIAM認証必須のままです。管理用サービスにallUsersやallAuthenticatedUsersを付与しないでください。

## 5. 手動確認してからSchedulerを開始

```powershell
gcloud run jobs execute catalog-experiment-update --project YOUR_PROJECT --region asia-northeast1 --wait
```

Cloud Run実行ログ、Firestoreの `catalog_events`、管理画面で出典と確認日時を確認します。
取得やGeminiの失敗も履歴に残るため、Jobの終了成功だけで施設確認成功と判断しないでください。

```powershell
python scripts/cloud_catalog.py schedule --project YOUR_PROJECT --apply
```

このコマンドで定期実行が始まります。SchedulerはJob開始APIを呼ぶだけなので、
Schedulerの成功とJobの完了・施設更新の成功はそれぞれ別に確認してください。
重複した実行はFirestoreのトランザクションと15分の施設リースで調整します。
Job自体の自動再試行は0回。施設の失敗は保存された次回期限で再試行します。

停止・再開：

```powershell
gcloud scheduler jobs pause catalog-experiment-schedule --project YOUR_PROJECT --location asia-northeast1
gcloud scheduler jobs resume catalog-experiment-schedule --project YOUR_PROJECT --location asia-northeast1
```

停止しても既に実行中のJobは終了まで続きます。必要ならCloud Runでその実行をキャンセルします。

## 更新・復旧・監視

通常のpull後は `deploy` だけ実行します。施設マスター追加時は `catalog_migrate --apply` で不足キューを追加します。
初期化をWeb起動に組み込んでいないため、デプロイのたびにDB全件を再作成しません。
Jobは期限と状態をFirestoreから読むため、PCやコンテナを替えても確認履歴を引き継げます。
リース切れの処理は再予約されます。古い実行が遅れて戻っても新しいリースを上書きできません。

運用開始前にGoogle Cloudで予算通知、Job失敗通知、Firestoreバックアップ/PITRを設定してください。
これらの通知・バックアップはこの初期設定スクリプトでは作りません。予算通知は支出の強制停止ではありません。
履歴は自動削除しません。長期運用時は保存期間・エクスポート方針を決めてください。
データ退避はFirestoreのエクスポートまたはマネージドバックアップを使用します。サービス削除でDBは削除されません。

## 検証とGitへの取り込み

```powershell
$env:PYTHONPATH = (Resolve-Path backend).Path
python -m pip install pytest
python -m pytest backend/tests/test_catalog_admin.py backend/tests/test_catalog_firestore.py backend/tests/test_catalog_gemini.py backend/tests/test_catalog_updater.py
```

Firestoreアダプターのテストは実SDKと模擬ストアを使い、再投入・件数上限・リース・履歴保存を検証します。
実プロジェクトでのIAM・Scheduler実行は上記の手動確認が必要です。開発者環境では作成・実行を確認済みです。他のプロジェクトでは改めて確認してください。

この作業環境の親リポジトリは `experimental/` 全体をGit除外しています。
他の人がpullできるようにするには、レビュー後に実験版の変更を共有リポジトリへ取り込んでコミットする必要があります。
`git add -f experimental/` のような一括追加は行わず、コード・施設JSON・フロント資材・Dockerfile・依存関係・
この手順書とscriptsを取り込んでください。`.env`、`.local`、SQLite、`.runtime`、テスト用依存フォルダは含めません。
初期設定は1回、デプロイは更新ごと、秘密情報は各プロジェクト側に登録する、という分担です。

公式資料：
- https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule
- https://docs.cloud.google.com/scheduler/docs/http-target-auth
- https://docs.cloud.google.com/firestore/native/docs/manage-data/export-import
