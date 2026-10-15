# 提出版のFirestore・管理認証構成

- プロジェクト：conciergo-510405、リージョン：asia-northeast1
- 一般公開Web：conciergo。CATALOG_ADMIN_ENABLED=0。管理画面と管理APIは403。
- 管理用Web：conciergo-admin。CATALOG_ADMIN_ENABLED=1。Cloud Run IAM認証必須。
- Firestore：conciergo-catalog。既存の確認結果を保持して共有。
- 更新Job：catalog-experiment-update。既存Jobを再利用し、提出版のイメージに更新。
- Scheduler：catalog-experiment-schedule。10分ごと、1日100件。既存スケジュールを再利用し重複実行を増やさない。

## 管理画面を見る

Cloud Run Invoker権限を持つアカウントで実行します。

```powershell
gcloud auth login
gcloud run services proxy conciergo-admin --project conciergo-510405 --region asia-northeast1 --port 8082
```

http://127.0.0.1:8082/facility-catalog.html を開きます。公開サイトと同じGoogle CloudプロジェクトのFirestoreを参照します。管理用URLを通常のブラウザで直接開くと未認証のため拒否されます。

## 公開前の検証

認証境界・Firestore保存・Gemini判定・公式情報取得等の関連テスト48件（追加18サブテスト）、管理集計のNodeテスト4件を通過。管理サービスの未認証アクセス403・認証済みアクセス200を実測。Scheduler経由の提出版Jobで大阪城天守閣（11:43:34）と横浜赤レンガ倉庫（11:43:47）を実Geminiで確認・保存し、出典・確認日時の管理画面反映を確認しました（2026-10-15 JST）。検証のため3施設の次回確認時刻だけを前倒しし、情報や判定結果は手動変更していません。

別の人が自分の環境で導入する場合は [初心者向け手順](cloud-beginner-handoff.md) を参照し、自分のプロジェクトにFirestoreを新規作成します。

## 公開反映結果

2026-10-15に公開サービスのトラフィックを `conciergo-00038-5sn` へ100%切り替えました。イメージは `sha256:94de7e051b41a5d95a6074d5bc30d41e464f34dbae328abb3b3ca7b4a11bd286`。公開URLのトップページ200、管理HTML・管理API403を確認し、ブラウザーで通常の旅程UIが表示されました。

更新Job `catalog-experiment-update-ddfht` は11:43:51 JSTに正常終了。提出版の施設マスターから不足キューを追加する処理も完了し、追加対象は0件でした（既存データで充足）。

障害時にWebを直前のリビジョンへ戻す場合は以下を実行します。この操作はFirestoreの履歴を戻さず、Schedulerも停止しません。

```powershell
gcloud run services update-traffic conciergo --project conciergo-510405 --region asia-northeast1 --to-revisions conciergo-00065-lef=100
```
