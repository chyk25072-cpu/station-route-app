# 駅すぱあと API の調査と接続

2026-10-23に経路探索の停車駅数を含む公式仕様を確認しました。実APIキーの登録・公開環境での実行は今回行っていません。

## 接続構成

ブラウザ → 同一オリジンの `/.netlify/functions/ekispert` → 駅すぱあとAPI、という構成です。
`netlify/functions/ekispert.mjs` が実行時に `process.env.EKISPERT_API_KEY` を読みます。
ブラウザの設定、リクエスト、応答にキーは含めません。`api-config.js` はFunctionのパスと行先略称表だけを持ちます。
既存の予測処理に必要な `/rail` と `/search/course/extreme` の両方をFunction経由で呼び出します。
到着予測、路線/種別の照合、途中種別変更、推奨ルール、キャッシュは維持しています。

Functionは対応する駅・日付・API・パラメータだけを受け付けます。クライアントからキーや上流URLを指定することはできません。
上流の応答全体を転送せず、予測に使うフィールドだけを返します。上流のエラー本文・URL・キーは返さず、応答は `Cache-Control: no-store` とします。

## 確認できたAPI

- [平均路線情報 `/rail`](https://docs.ekispert.com/v1/api/rail.html)：`from`・`to`・`date`・`type=train` で2駅間の平均路線名を取得できます。乗車時間のレスポンス項目はありません。
- [経路探索 `/search/course/extreme`](https://docs.ekispert.com/v1/api/search/course/extreme.html)：`searchType=plain` と `fixedRailList` による平均路線の固定が可能です。`ResultSet.Course.Route.Line.timeOnBoard` は分単位の乗車時間です。
- [平均待ち時間探索 `/search/course/plain`](https://docs.ekispert.com/v1/api/search/course/plain.html) も存在しますが、列車種別に対応する路線を固定するため、今回はextremeを使用します。

独立した「区間ごとの統計的な平均走行時間」エンドポイントを確認できたわけではありません。実装が使うのは、平均待ち時間探索に含まれる平均路線の乗車時間です。
待ち時間を含む `Route.timeOther` や合計時間を、既知の発車時刻へ加算する実装にはしていません。

## リクエスト

上流のベースURLは `https://api.ekispert.jp/v1/json/`、認証は `key` クエリパラメータです。以下のリクエストはFunction内で組み立てます。

1. `GET rail?key=...&from=桜上水&to=笹塚&type=train&date=20261023&offset=1&limit=100`
2. 取得できた路線名の中から、対象の列車種別に合う京王の平均路線を選びます。
3. `GET search/course/extreme?key=...&viaList=桜上水:笹塚&searchType=plain&fixedRailList=取得した路線名&date=20261023&answerCount=20&searchCount=20`

路線名を作ってリクエストすることはありません。各停・各駅停車・普通、快速、区間急行、急行、特急の名称を区別します。
無印の「京王線」「京王高尾線」「京王相模原線」「京王新線」も、取得済みの名前に限って問い合わせます。
無印路線を各停の予測へ使うには、`Line.stopStationCount` が当該区間の途中駅数（両端を除く）と一致することが必要です。
路線名に別種別が明示された場合や、停車駅数が不一致・未取得の場合は使用しません。名前だけで無条件に各停とするフォールバックはありません。
実際に返る京王の平均路線名と停車駅数の値は、実キーでの照合が必要です。

## レスポンス検証

- JSONの要素が単体・配列・省略になる仕様に対応します。[公式のJSON注意事項](https://docs.ekispert.com/v1/get-started/attention/)
- `Course.dataType=plain`、乗換0・徒歩0・1乗車区間、出発/到着駅名の一致、路線名の一致、正の `Line.timeOnBoard` を確認します。
- 公式仕様の `Line.stopStationCount` もFunctionから返し、無印路線の各停照合に使います。経路探索の公式例でも高円寺→新宿の途中停車駅数は1（中野）です。
- 得られた乗車時間を、提供JSONの発車日時へ加算します。元の発車・種別・行先は変更しません。
- 対応する平均路線・乗車時間を確認できない便は予測候補から除外し、取得できない旨を表示します。「列車が停車しない」と断定しません。APIキー未設定・通信エラー時は到着予測を補いません。
- 成功結果は5分、失敗は30秒だけメモリー内に保持し、毎秒APIを呼びません。APIの応答・キーをlocalStorageへ保存しません。
- タイムアウト・HTTPエラー・APIエラーを処理し、リクエストURLやキーを画面へ出しません。

## 終点・停車パターン・種別変更

利用者提供の略称表を `api-config.js` に登録しました。表示には元の略称を使います。
実際の終点までの駅接続を確認し、目的地が別支線や終点の先にある列車を除外します。
`高八` は高幡不動以降、`セ橋` は京王多摩センター以降を各駅停車として区間を分けます。
支線境界でも区間を分け、各区間の種別に対応するAPIの乗車時間を合算します。乗換待ち時間は加算しません。
明示された通過駅では降車させません。APIから平均路線を取得できた場合、その路線が接続する2駅間の乗車時間だけを使用します。
下り方面では、検索対象列車と乗車駅を桜上水に限定してから終点・停車・APIの判定を行い、下高井戸は問い合わせません。
当日の個別列車の停車変更、待避・臨時運行、実際の列車IDとの照合には対応していません。

## Netlifyの設定

1. Netlifyの環境変数へ `EKISPERT_API_KEY` を登録します。利用するデプロイコンテキストで **Functions** スコープ、または全スコープから参照可能にしてください。
2. 変数の登録・変更後に新しいデプロイを作成します。環境変数を `netlify.toml` のbuild設定に直接書きません。
3. 同梱の `netlify.toml` はビルドコマンドを `npm run build`、公開先を `dist`、Functionsディレクトリを `netlify/functions` に設定します。

Functionの実行時環境変数は `process.env` から参照でき、変更の反映には再デプロイが必要です。[Netlify公式仕様](https://docs.netlify.com/build/functions/environment-variables/)
Functionsソースは公開ディレクトリの外側に置いています。静的ファイルの `dist` だけをアップロードする方法ではなく、Git連携またはFunctionsを含むCLIデプロイを使用してください。今回push・公開・Netlify上の設定変更はしていません。
ローカルでは `npm run build` 後、Netlify CLIが利用できる環境で `netlify dev` を起動します。`index.html` を直接開く方法ではFunctionsを呼べません。

## 公開環境での認証確認

登録ドメインは利用者指定の `station-route-app.netlify.app` です。
ブラウザとFunctionは同一オリジンですが、駅すぱあとAPIから見る通信元はNetlify Functionsです。ブラウザ向けの登録ドメイン制限がこの通信に対応するかは、実APIでの確認が必要です。
`Origin` や `Referer` の偽装はしていません。

1. 公開したアプリの「メニュー → 保存・バックアップ → API接続確認」を開きます。
2. 「API接続を確認する」を押します。Functionから `/rail` と `/search/course/extreme` の両方へ実際に接続します。
3. 各APIの成功/失敗を確認します。成功時は予測用キャッシュも更新し、検索を再実行します。

診断URLは `https://station-route-app.netlify.app/.netlify/functions/ekispert?endpoint=diagnostics` です。キーはURLに指定しません。
診断では当日の日本時間の日付で桜上水→笹塚を問い合わせ、エンドポイントごとのHTTP結果を返します。診断での成功は、その時点の接続・認証成功を意味し、全列車の時刻の正確性を保証するものではありません。

| 結果 | 表示・確認内容 |
|---|---|
| `MISSING_API_KEY` / HTTP 503 | 環境変数、Functionsスコープ、デプロイコンテキスト、再デプロイを確認 |
| `UPSTREAM_AUTH_FAILED` / 上流HTTP 401・403 | キー・契約・Functionsからの通信に対する登録ドメイン制限を確認。原因は断定しない |
| `UPSTREAM_TIMEOUT` / HTTP 504 | 上流への通信タイムアウト |
| `UPSTREAM_UNAVAILABLE` / HTTP 502 | 上流との通信失敗 |
| Function自体がHTTP 404 | Functionsを含むデプロイになっているか確認 |

実API認証・契約上の利用可否・レスポンスの実値・登録ドメイン制限は、今回のローカルテストでは未検証です。

評価版は一部の駅情報・平均路線情報等に地域制限があり、東京都・神奈川県は対象に含まれます。[評価版の制限事項](https://docs.ekispert.com/v1/get-started/restriction/)
テストは公式フィールド構造の応答を注入した契約テスト、FunctionのRequest/Responseテスト、ブラウザ側からFunctionを通す結合テストです。実API接続に成功したという報告ではありません。
