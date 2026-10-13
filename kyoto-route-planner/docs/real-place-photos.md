# 実施設写真

`app.place_photos.fetch_route_photo(PhotoRequest)` は先頭から最大3施設を調べ、確認できた最初の実写真と、その写真に対応する施設ID・名称を返します。`ready` または `unavailable` のみで、利用可能な写真がなければURL等はnullです。写真を優先するフロントエンドから呼ぶためのproviderであり、画像生成APIは呼びません。

## 確認処理

1. 日本語Wikipedia、Commons直接検索・地理検索、Wikidataを並行して調べます。Wikipediaでは記事名がNFKC・空白・大文字小文字の正規化後に施設名と完全一致し、記事座標が施設から500m以内であることを必須とします。Commons直接検索では写真説明の施設名とファイルの地球上の座標（250m以内）を照合します。近くの建物や、その施設から見た別施設という説明は除外します。Wikidataでは検索IDと取得ID、ラベル/別名の完全一致、地球上のP625座標（500m以内、精度0.001度以内）を確認し、その項目のP18に記録されたFile名のみ取得します。矛盾する座標・deprecatedの記述・同名別都市は除外します。ファイルにも座標があれば250m以内の一致を要求します。
2. 記事のfree pageimageまたはP18とimageinfoのFile名・出典File名が一致することを確認。JPEG/PNG/WebPのみ許可し、地図・ロゴ・肖像・イラスト・生成画像等をメタデータで除外します。追加providerでは写真内容が明確な説明、またはカメラのMake・Model・DateTimeOriginalの3項目を要求します。Wikidataの項目とP18の関係が確認できれば、説明が英語でも利用できます。検索順位や名称だけでは採用しません。
3. 画像URLはHTTPSの`upload.wikimedia.org`と`thumb.wikimedia.org`の2ホスト、出典は`commons.wikimedia.org/wiki/File:`または`ja.wikipedia.org/wiki/File:`に限定。著者とCC BY・CC BY-SA・CC0・Public Domainの許可ライセンスを必須とします。ライセンスURL末尾のスラッシュは有無を許容し、返却されたURLを保持します。既知のcreativecommons.orgのHTTPライセンスURLのみHTTPSへ正規化します。サムネイルの新ホストは[Wikimediaの移行告知](https://diff.wikimedia.org/2026/09/16/wikimedia-foundation-bulletin-2026-issue-17/)に対応しています。
4. サーバーのshared `GEMINI_API_KEY` があれば、施設名・座標・ファイル名・説明をGeminiへ渡し、施設の写真であるかをJSON booleanで一度だけ補助判定します。Google Search、画像取得、視覚判定、URL・ライセンスの生成は行いません。明示的falseは必ず除外。キーなし・混雑・上限・通信失敗の場合は、施設名と写真内容が説明で明確な候補、または施設との対応とカメラ情報を照合した追加providerの候補を採用します。不明なら非表示です。

CommonsにLicenseUrlがない場合、LicenseShortName=Public domain、License=pd、Copyrighted=False、Categories内の完全なPD-selfの4項目が揃うファイルに限り、実際の権利表記である[PD-selfテンプレート](https://commons.wikimedia.org/wiki/Template:PD-self)を返します。ライセンスURLの追加許可はこのテンプレートの完全なHTTPS URLだけです。URLのない一般的なPD表記や、権利不明の公式サイト画像は採用しません。

AIは画像ピクセルを見ていません。`image_verified`は名称・位置・出典とメタデータの照合を示し、実際の外観や現在の状態を保証しません。`ai_checked`は補助判定でtrueとなった時だけtrueです。表示時には写真の著者・ライセンス・出典リンクを併記してください。

## API契約

`POST /api/routes/photo`（IP単位30回/分）。フロントエンドは表示中のカードと次の2カードまで先読みします。施設・出典・ライセンスを照合した応答だけでなく、画像ファイルの読み込み・デコードまで完了してから準備完了とします。次の写真が準備中なら現在のカードを残し、準備完了後に切り替えます。待機のキャンセルも可能です。

メタデータと画像を合わせて40秒で待機を終了します。同じ施設の並びでは進行中の取得を共有し、カードが前に移動しても再取得しません。非表示・画面切り替え時はその画面の待機を中断し、遅れて届いた別ルートの結果ではカードを進めません。写真がなければテーマ色の背景を表示し、画像生成APIにはフォールバックしません。ブラウザーの取得済み結果は最大32件、準備できた写真は6時間、取得不可は60秒まで再利用します。

`PhotoRequest`: `{places: Place[]}`（1〜3件）。`PhotoResponse`: `status`, `place_id`, `place_name`, `image_url`, `author_name`, `source_url`, `license_name`, `license_url`, `image_verified`, `ai_checked`, `note`。URL・施設・著者・ライセンスはnullable文字列です。写真が2番目の施設に対応する場合、その施設を返します。route先頭施設の写真であると決めつけないでください。

追加フィールド`provider`はready時に`wikipedia`、`commons`、`wikidata`です。Wikidata経由でも画像とライセンスの出典はCommonsです。`failure_reason`はready時null、条件を満たす写真がなければ`no_matching_licensed_photo`、通信・provider応答・混雑・deadlineにより確認できなければ`lookup_failed`です。一部施設で取得が失敗し、ほかにも写真がなければ`lookup_failed`を返します。

Geminiモデルはshared `GEMINI_MODEL`、既定`gemini-3.8-flash`。キーは環境変数→プロジェクト`.local/personal-api.env`→`backend/.env`の順でshared `ai_settings`から読み、旧キー名にも対応します。`PYTHON_DOTENV_DISABLED=1`でローカルファイル読込を停止します。キーはクライアントへ返しません。

## 費用・通信制御

route応答の総deadlineは35秒、施設ごとの無料lookupは10秒、AIは最大8秒です。無料APIは最大7HTTP calls/施設、retryなし。直接検索10件・地理検索20件・Wikidata検索10項目/P18最大5ファイルに制限します。施設lookupは1プロセス同時8件まで、各clientは最大4接続。候補が見つかれば残りのprovider taskを中断して回収します。AIは1候補1call、1プロセスにつき同時1件・起動後20attemptまで（失敗も消費、再起動でリセット）。AIなしでも確かな写真を使用できます。同一施設・位置の進行中taskは共有し、閲覧者の中断が他の閲覧者の取得を中断しないようにします。開始済み共有taskも開始元routeのdeadline以内で終了します。

無料APIの接続先は固定の`ja.wikipedia.org/w/api.php`、`commons.wikimedia.org/w/api.php`、`www.wikidata.org/w/api.php`です。返却されたURLをサーバーでfetchすることはありません。旧`image_search.search_commercial_image`を利用する別機能の検索範囲・6秒budgetは変更していません。[Commons公式API例](https://commons.wikimedia.org/wiki/Commons:API/MediaWiki)、[Wikibase API仕様](https://www.mediawiki.org/wiki/Wikibase/API)に基づいています。

写真メタデータと判定結果は6時間、取得不可は60秒cacheします。これはGoogle Search groundingの結果ではありません。HTTPクライアントはネイティブ証明書ストアのTLS検証、`trust_env=False`、redirect無効を使用します。写真ファイル自体はバックエンドでダウンロードしません。

mock testsでURL・名称・位置・filename・MIME・ライセンス・AI拒否・AI障害・cache・同時実行・上限・deadlineを確認します。テストから本物のAPIへ通信しません。

backendディレクトリで`python -m unittest discover -s tests -p "test*photos.py"`を実行すると、実写真providerとAPI契約のテストをまとめて実行できます。
