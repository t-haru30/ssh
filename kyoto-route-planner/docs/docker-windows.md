# Windows向けDocker導入・起動手順

WindowsでDocker Desktopを使い、ConcierGOを起動する手順です。GitHubから取得済みの `ssh` フォルダーを使います。

**再起動を挟むため、①から順番に、ブロックごとにコピペしてください。** コマンドはすべてPowerShellで実行します。

## ① 管理者としてPowerShellを開き、WSLを入れる

スタートメニューで「PowerShell」を検索し、右クリック →「管理者として実行」を選びます。

```powershell
wsl --install --no-distribution
```

完了したら、作業中のファイルを保存して**Windowsを再起動**してください。[Microsoft公式手順](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

## ② 再起動後、管理者PowerShellでDockerを入れる

①と同じ方法で管理者PowerShellを開き、実行します。

```powershell
wsl --update
wsl --set-default-version 2
winget install --id Docker.DockerDesktop --exact --source winget
```

確認画面が出たら内容を確認して進めます。再起動を求められた場合は、作業中のファイルを保存して再起動してください。[winget公式手順](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)

## ③ Docker Desktopを起動する

スタートメニューから「Docker Desktop」を開き、初回の利用規約を確認して進めます。バックエンドを選ぶ場合は **WSL 2** を選んでください。このアプリはLinuxコンテナで動かします。[Docker公式手順](https://docs.docker.com/desktop/setup/install/windows-install/)

起動が完了したら、**新しく通常のPowerShellを開いて**確認します。

```powershell
docker version
```

`Client` と `Server` の両方が表示されれば準備完了です。

## ④ ConcierGOの設定ファイルを作る

GitHubから取得済みの **`ssh` フォルダーでPowerShellを開いて**実行します。

```powershell
cd kyoto-route-planner

New-Item -ItemType Directory -Force -Path .local | Out-Null

if (-not (Test-Path -LiteralPath .local/docker.env)) {
@'
PLACE_SEARCH_PROVIDER=public_catalog
GEMINI_API_KEY=
EKISPERT_API_KEY=
EKISPERT_APPLICATION_URL=http://127.0.0.1:8080
VENUE_EVIDENCE_ENABLED=1
ROUTE_ILLUSTRATIONS_ENABLED=0
'@ | Set-Content -LiteralPath .local/docker.env -Encoding ascii
}

notepad .local/docker.env
```

開いたメモ帳で、以下の空欄へ**チームで利用するキー**を入力し、保存してください。

```ini
GEMINI_API_KEY=ここにGeminiのキー
EKISPERT_API_KEY=ここに駅すぱあとのキー
```

`EKISPERT_APPLICATION_URL` は駅すぱあとの登録条件に合わせて設定してください。

`.local/docker.env` はGit管理とDockerビルドの対象から除外されています。キーはこのファイルに保存し、GitHubのファイルやIssueには貼り付けないでください。④を再実行しても既存の設定ファイルは上書きしません。

## ⑤ 同じPowerShellでビルド・起動する

④で移動した `kyoto-route-planner` フォルダーのまま実行します。

```powershell
docker build -t conciergo:local .

if ($LASTEXITCODE -ne 0) {
    throw "ビルドに失敗しました。表示されたエラーを確認してください。"
}

docker run --rm -d --name conciergo-dev -p 127.0.0.1:8080:8080 --env-file .local/docker.env conciergo:local
```

初回ビルドでは依存パッケージをダウンロードするため、完了まで時間がかかります。

起動後、[http://127.0.0.1:8080](http://127.0.0.1:8080) を開きます。起動直後につながらない場合は、少し待ってから再読み込みしてください。

## 停止するときだけ実行

```powershell
docker stop conciergo-dev
```

`--rm` を指定しているため、停止したコンテナは自動で削除されます。次回の起動は⑤を実行してください。

コード更新後は、停止してから⑤を再実行してください。設定ファイルを変更した場合も、停止してから⑤を再実行すると反映されます。

## 起動できない場合

- `docker` が見つからない場合は、Docker Desktopのインストール完了後にPowerShellを開き直してください。
- `docker version` で `Server` が表示されない場合は、Docker Desktopを起動し、起動が完了してから再確認してください。
- コンテナ名 `conciergo-dev` が使用中と表示された場合は、上の停止コマンドを実行してから⑤を再実行してください。
- アプリが開かない場合は、次のコマンドで起動状況とログを確認してください。

```powershell
docker ps -a --filter name=conciergo-dev
docker logs conciergo-dev
```

終了済みのコンテナは自動削除されるため、ログを取得できない場合があります。その場合は⑤の `docker run` から `-d` だけを外して実行し、PowerShellに表示される起動ログを確認してください。

Docker版のデータと詳しい設定は、[公開用ランタイム](public-runtime.md)を参照してください。
