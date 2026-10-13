# OpenPOI の追加候補

OSM の同梱候補を維持し、`POST /api/discover` の検索時に OpenPOI API を補助候補として使用する。初回のローカル表示は従来の OSM 候補。`PLACE_SEARCH_PROVIDER=public_catalog` で既定有効、`OPENPOI_ENABLED=0` で停止できる。データ取得に認証情報は送らない。

## 候補の検証

- 固定 API に最大3回、各200件まで問い合わせる。近傍検索、飲食、観光の結果から最大30施設を交互に取り出す。
- カフェ・飲食店・博物館・美術館・公園等の明示的な分類を許可する。分類不明、食と観光の分類矛盾、一般名だけの施設は除外。汎用の tourism 分類は施設名の末尾も照合する。
- 有限の日本国内座標、指定半径、県境条件、住所・出典・ライセンスの存在を確認する。API は範囲外の完全一致名を返す場合があるため、距離を再計算する。
- 国土地理院の逆ジオコーディングと市区町村コード表を使い、座標の市区町村と町域が施設住所と一致した施設だけを採用する。ローマ字住所など照合できない施設は保留。町域の照合であり、入口や建物単位の正確性、営業中であることは保証しない。
- 正規化した同名で、住所が同じ、または300m以内の場合は重複とし、既存 OSM を優先する。同一ブランドでも離れた住所の支店は残す。
- 全体10秒、逆ジオコーディング同時3件・待ち時間5秒、検索同時2件。確認済みの部分結果を利用する。追加候補は30分、失敗は60秒キャッシュする。失敗・検証不能時は既存候補を維持する。
- 既存のテーマ、ペース、件数、概算時間制限を追加候補にも適用する。写真の施設一致検証は従来どおり独立して行う。

API の `catalog` に追加状態と候補件数を返す。施設の `tags` に元の `licenses` / `attributions` 配列を JSON 文字列として保持し、カードから旅程に採用しても引き継ぐ。出典ページに提供元を表示する。OpenPOI データを OSM ダウンロードファイルには混ぜない。

## 出典

- [OpenPOI API の出典・ライセンス](https://openpoiapi.com/attribution.html)
- [OpenPOI API の仕様・制約](https://docs.openpoiapi.com/)
- [国土地理院](https://maps.gsi.go.jp/)（市区町村・町域照合）

施設の選別、分類の日本語化、名称・住所の正規化、重複整理は ConcierGO が行う。保存・再配布時は各レコードの出典・ライセンスと提供元の条件を確認する。

## Foursquare NOTICE

OpenPOI の Overture Maps 内 Foursquare 由来レコードに適用。提供元の [NOTICE](https://opensource.foursquare.com/places-notice-txt/) と [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) を参照。

> © 2026 Foursquare Labs, Inc. All rights reserved. The Foursquare OS Places dataset (the “Data”) is licensed under the Apache License, Version 2.0 (the “License”). You may not use, modify, or distribute the Data except in compliance with the License. As set forth more fully in the License, if you use, modify, or distribute the Data, you must: – provide recipients with a copy of the License. – if applicable, include prominent notices to the extent you’ve changed the Data. – preserve attribution to Foursquare, including preserving the full content of this NOTICE.txt file. To ensure appropriate attribution to Foursquare, we recommend the following: – if using/distributing the Data in flat file form as-is or after making changes/modifications: include this NOTICE.txt file, which may be modified to include an additional notice of your changes/modifications, if any. – if using/distributing the Data in API form as-is or after making changes/modifications: include a copy of the content from this NOTICE.txt file prominently in your developer documentation for such API, which may be modified to include an additional notice of your changes/modifications, if any. You may obtain a copy of the License at: http://www.apache.org/licenses/LICENSE-2.0 . Unless required by applicable law or agreed to in writing, the Data distributed under the License is distributed on an “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License. We also encourage you to join our Placemaker community where you can contribute and provide suggestions to improve the accuracy of the Data for future releases for yourself and others.
