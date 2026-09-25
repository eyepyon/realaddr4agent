# 公開ページ・Agent向け発見情報の実装契約

状態: 実装予定。`https://address.chain.tokyo` はユーザー指定の公開ドメインだが、DNS設定、HTTPS到達性、公開、検索エンジンによる取得はいずれも未検証。ドメインのDNS設定はユーザーが行う。この文書は検索順位やAIサービスへの採用を保証しない。

## 目的と範囲

公開ページを人間とAgentが読める入口にする。正確なサービス範囲、認証方法、支払いと承認の順序、API契約へのリンクを初回HTMLに載せる。公開情報は実装済み・実接続済みの範囲を超えて主張しない。現在は仕様のみであり、ページや発見用ファイルが既に配信されているとは扱わない。

実装はT-01のReact/ViteとFastifyの単一Cloud Run公開サービスに同梱する。`/`、`/developers`、`/faq` はビルド時に静的HTMLを生成するか、Fastifyから同内容のHTMLを返す。常時起動するSSRサービスや追加の公開インフラは設けない。CSSは白・グレー・青を基調にした標準的なSaaS画面とし、色だけに依存せず見出し・本文・リンクをHTMLで読めるようにする。JavaScript無効・未実行の初回GETでも主要本文と内部リンクが存在することを要件にする。Viteの空のapp shellとブラウザ内fetchだけで公開説明を完成させない。[GoogleのJavaScript SEOガイド](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)は静的生成や事前レンダリングを推奨し、JavaScriptを実行できないbotがあることも説明している。

`/approve/{approvalId}` など既知の人間用画面にはSPA fallbackを適用できる。匿名の承認画面shellやログイン画面は200で配信してよいが、認証前に対象契約や個人情報をHTMLへ埋め込まない。保護APIは未認証・無権限を401/403で拒否する。未知のURLは公開トップの200へfallbackさせず404を返す。

## 正として扱う情報

公開本文、`<title>`、description、Open Graph、JSON-LD、`/llms.txt`、APIカタログを実装時に一つの公開コンテンツ設定から生成し、実行環境・料金・機能の表現を揃える。APIのpath、request、response、認可は[OpenAPI](openapi.json)と[API契約](api.md)を正とし、公開ページに別の契約を作らない。`PUBLIC_ORIGIN` はデプロイ時に `https://address.chain.tokyo` と固定し、canonical、sitemap、OpenAPI `servers`、絶対リンクに使う。リクエストの `Host` / `X-Forwarded-Host` から公開originを組み立てない。別のCloud Run標準URLから到達できる場合もcanonicalはこの公開originに統一する。DNSとTLSが整う前は公開到達を合格扱いしない。

本文では次を明示する。

- 1拠点あたり1〜65,535の**仮想区画**を提供し、実在する階数として表示しない。
- 基本住所契約はAgent認証、Intercepta判定、Base Sepoliaのx402決済確定後に有効となり、World承認は購入条件ではない。
- ENSv2の契約名とLeaseRegistryはEthereum Sepoliaで扱う。testnetの検証状態と契約状態を区別する。
- 郵便機能はowner walletの証明、World認証と人間の明示承認後の「郵便転送可」表示、および人間が入力する転送先設定まで。実際の郵便受領・発送・転送や送料決済は行わない。World認証を法的KYC完了と表現しない。
- Agentは転送先住所全文にアクセスできない。公開のENS照合は契約参照と検証結果だけを返す。住所・個人情報・World識別子・内部lease UUID・mail状態を発見用ファイル、構造化データ、公開ガイドに載せない。
- sponsor接続やtestnet発行は、実装・実測が終わるまで「予定」または「検証中」と表示する。未確定の料金、利用可能拠点、ENS親名、成果、稼働率を断定しない。

`/` はサービスの範囲と利用手順、`/developers` は認証・x402・ENS照合の概説と `/openapi.json` へのリンク、`/faq` は仮想区画、World承認、郵便機能、testnetの明確な回答を載せる。ページ間は通常の `<a href>` で結ぶ。`/v1/locations` はAgent Bearerが必要なAPIとして説明し、匿名で拠点一覧を取得できると記さない。

## メタ情報と発見用ファイル

各公開HTMLの初回レスポンスに固有の日本語 `<title>`、内容に一致する `meta description`、`<link rel="canonical" href="https://address.chain.tokyo/…">`、Open Graphの `og:title` / `og:description` / `og:url` / `og:type` を置く。Open Graph画像は実際の公開画像がある場合のみ指定する。トップに `WebSite` と `Service` のJSON-LDを置けるが、説明やOfferは画面に見える事実と一致させる。FAQPageを使う場合も表示本文と同じ回答だけにし、rich resultは保証しない。[Googleの構造化データ指針](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)は表示内容との一致と正確性を求める。

`/robots.txt` は公開ページを許可し、`Sitemap: https://address.chain.tokyo/sitemap.xml` を示す。`/sitemap.xml` には実際に200を返す公開canonical HTML (`/`、`/developers`、`/faq`) だけを載せる。`lastmod` は更新日時を正確に出せる場合のみ入れる。`/llms.txt` はこのプロジェクトの実装対象とし、短いサービス概要、現在の環境と制約、公開ガイド、`/openapi.json` の絶対リンクを載せる。llms.txtは検索エンジンの正式な優遇条件ではなく、crawlerによる読み取りや採用を前提にしない。`/openapi.json` は公開のOpenAPI 3.1契約を既存API仕様と同じ `application/json` で返す。公開HTMLにはOpenAPIへの可視リンクを置き、HTTP `Link: </openapi.json>; rel="service-desc"; type="application/json"` を付ける。RFC 9727の `/.well-known/api-catalog` は必要なら後で追加できるが、ハッカソンの必須範囲にはしない。[RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html)を採用するときはlinksetの形式とmedia typeを満たす。

`/llms.txt` の実装時の内容例（事実確認後に更新する）:

```text
# RealAddr for Agents

AIエージェントによる日本の住所利用契約のためのサービス。現在の実装・接続状況は公開ガイドで確認してください。

- 住所契約: Agent認証、リスク判定、Base Sepolia x402決済確定後。
- ENSv2: Ethereum Sepoliaの契約別名。検証結果は契約状態・期限とともに確認。
- 郵便: 人間承認後の設定表示と転送先入力まで。実際の郵便転送は行いません。
- API契約: https://address.chain.tokyo/openapi.json
- 開発者ガイド: https://address.chain.tokyo/developers
- FAQ: https://address.chain.tokyo/faq
```

## 配信・非公開境界

| Route | 状態・Content-Type | Cache-Control | インデックス方針 |
| --- | --- | --- | --- |
| `/`, `/developers`, `/faq` | 200 `text/html; charset=utf-8`。初回HTMLに本文とリンク | `public, max-age=300` を開始値とし更新時に再確認 | canonicalを持つ公開ページ |
| `/assets/*` | 存在するassetは200で正しいCSS/JS/画像型。未知assetは404 | hash付き名は `public, max-age=31536000, immutable` | HTMLに必要なassetをbotから遮断しない |
| `/robots.txt`, `/llms.txt` | 200 `text/plain; charset=utf-8` | `public, max-age=300` | 公開説明のみ |
| `/sitemap.xml` | 200 `application/xml; charset=utf-8` | `public, max-age=300` | 公開canonical HTMLだけを列挙 |
| `/openapi.json` | 200 `application/json; charset=utf-8` | `public, max-age=300` | 契約を公開。認可が必要な操作の権限は維持 |
| `/health` | 200 `application/json; charset=utf-8` | `no-store` | process起動確認のみ。外部接続成功を意味しない |
| `/approve/{approvalId}`、`/app/*`、`/admin/*`、`/auth/world/callback`、`/auth/admin/callback` | 匿名shell・ログイン画面は200 HTML可。保護データは認可後だけ取得。失効・未知IDは適切な4xx/redirect。callbackはAPI契約に沿うstatus | `no-store` | `X-Robots-Tag: noindex, nofollow`。HTMLには`meta name="robots" content="noindex,nofollow"`も付与 |
| `/v1/*`、非公開JSON、内部worker | API契約に沿うstatusとJSON。保護APIは未認証・無権限を401/403で拒否し、workerは未認証アクセス不可 | 保護データ・認証応答は`no-store` | 公開APIを除く応答に`X-Robots-Tag: noindex`。認可・非公開を優先 |
| その他 | 404。HTMLなら通常の404本文 | `no-store` | sitemapに含めない |

非公開データは必ずserver側認可で守る。`noindex`、robots、UI制御を認可手段にしない。robotsで非公開URLをdisallowするとcrawlerが`noindex`を読めない場合があるため、noindexを確認させたいURLはrobotsで遮断しない。[Googleのnoindex仕様](https://developers.google.com/search/docs/crawling-indexing/block-indexing)はこの点を明記している。認証済みの情報が匿名HTMLや静的asset、OG、JSON-LD、公開API仕様の例へ混入しないことも確認する。

## 最小確認と作業位置

T-19でこの文書の公開ページ・発見用ファイル・最小確認を実装する。T-01の同一origin配信基盤、T-08の画面、T-09の非公開境界、T-16の公開origin設定と接続する。タスクは実装と最小確認の証跡が揃うまでチェックしない。

提出前の代表的な手動smokeは、DNS/TLS設定後に公開originへ `GET /`、`/developers`、`/faq`、`/robots.txt`、`/sitemap.xml`、`/llms.txt`、`/openapi.json` を実行し、status、Content-Type、本文・リンク、canonical、環境表記を読むこと。JavaScriptを実行せずにHTML本文が取れること、sitemap内のURLが200の公開canonicalへ解決すること、既知のapproval/app/admin画面の`no-store`・`noindex`と保護APIの認可を確認する。実行結果、未実行項目、外部到達の障害は実装開始時に作る`docs/implementation-status.md`に記録する。網羅crawlerテストや性能試験はこの機能の必須ゲートにしない。
