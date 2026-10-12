# 実施設写真

`app.place_photos.fetch_route_photo(PhotoRequest)` は先頭から最大3施設を調べ、確認できた最初の実写真と、その写真に対応する施設ID・名称を返します。`ready` または `unavailable` のみで、利用可能な写真がなければURL等はnullです。写真を優先するフロントエンドから呼ぶためのproviderであり、画像生成APIは呼びません。

## 確認処理

1. 日本語Wikipediaの記事名がNFKC・空白・大文字小文字の正規化後に施設名と完全一致し、記事座標が施設から500m以内であることを必須とします。
2. 記事のfree pageimageとimageinfoのFile名・出典File名が一致することを確認。JPEG/PNG/WebPのみ許可し、地図・ロゴ・肖像・イラスト・生成画像等をメタデータで除外します。
3. 画像URLはHTTPSの`upload.wikimedia.org`と`thumb.wikimedia.org`の2ホスト、出典は`commons.wikimedia.org/wiki/File:`または`ja.wikipedia.org/wiki/File:`に限定。著者とCC BY・CC BY-SA・CC0・Public Domainの許可ライセンスを必須とします。ライセンスURL末尾のスラッシュは有無を許容し、返却されたURLを保持します。既知のcreativecommons.orgのHTTPライセンスURLのみHTTPSへ正規化します。サムネイルの新ホストは[Wikimediaの移行告知](https://diff.wikimedia.org/2026/09/16/wikimedia-foundation-bulletin-2026-issue-17/)に対応しています。
4. サーバーのshared `GEMINI_API_KEY` があれば、施設名・座標・ファイル名・説明をGeminiへ渡し、施設の写真であるかをJSON booleanで一度だけ補助判定します。Google Search、画像取得、視覚判定、URL・ライセンスの生成は行いません。明示的falseは必ず除外。キーなし・混雑・上限・通信失敗の場合は、施設名と写真内容が説明で明確な候補のみ採用します。不明なら非表示です。

AIは画像ピクセルを見ていません。`image_verified`は名称・位置・出典とメタデータの照合を示し、実際の外観や現在の状態を保証しません。`ai_checked`は補助判定でtrueとなった時だけtrueです。表示時には写真の著者・ライセンス・出典リンクを併記してください。

## API契約

`POST /api/routes/photo`（IP単位30回/分）。フロントエンドは表示中の先頭カードだけで呼び出し、30秒で待機を終了します。非表示・画面切り替え時は待機を中断し、遅れて届いた別ルートの結果は表示しません。写真がなければテーマ色の背景を表示し、画像生成APIにはフォールバックしません。

`PhotoRequest`: `{places: Place[]}`（1〜3件）。`PhotoResponse`: `status`, `place_id`, `place_name`, `image_url`, `author_name`, `source_url`, `license_name`, `license_url`, `image_verified`, `ai_checked`, `note`。URL・施設・著者・ライセンスはnullable文字列です。写真が2番目の施設に対応する場合、その施設を返します。route先頭施設の写真であると決めつけないでください。

Geminiモデルはshared `GEMINI_MODEL`、既定`gemini-3.8-flash`。キーは環境変数→プロジェクト`.local/personal-api.env`→`backend/.env`の順でshared `ai_settings`から読み、旧キー名にも対応します。`PYTHON_DOTENV_DISABLED=1`でローカルファイル読込を停止します。キーはクライアントへ返しません。

## 費用・通信制御

route応答の総deadlineは25秒、施設ごとの無料lookupは6秒、AIは最大8秒です。Wikipediaは最大2HTTP calls/施設、retryなし。AIは1候補1call、1プロセスにつき同時1件・起動後20attemptまで（失敗も消費、再起動でリセット）。AIなしでも確かな写真を使用できます。同一施設・位置の進行中taskは共有し、閲覧者の中断が他の閲覧者の取得を中断しないようにします。開始済み共有taskも開始元routeのdeadline以内で終了します。

写真メタデータと判定結果は6時間、取得不可は60秒cacheします。これはGoogle Search groundingの結果ではありません。HTTPクライアントはネイティブ証明書ストアのTLS検証、`trust_env=False`、redirect無効を使用します。写真ファイル自体はバックエンドでダウンロードしません。

mock testsでURL・名称・位置・filename・MIME・ライセンス・AI拒否・AI障害・cache・同時実行・上限・deadlineを確認します。テストから本物のAPIへ通信しません。

2026-10-12の別途ライブ確認では、さいたま市立漫画会館の写真が約4.3秒で `ready` / `image_verified:true` / `ai_checked:true` になりました。ブラウザーでも写真、対象施設名、著者「京浜にけ」、CC BY-SA 3.0と出典リンクの表示を確認しました。写真がルートの2番目の施設でも、先頭施設の写真として表示しません。
